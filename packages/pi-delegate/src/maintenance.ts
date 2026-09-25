/**
 * Issue #14 — periodic redelivery + hygiene sweep + health surface.
 *
 * ## Why a timer at all
 *
 * Until now, EVERY recovery leg ran only at `session_start`:
 *   - an orchestrate child finishing while the parent stayed alive was
 *     delivered by the reaper wake — but if THAT wake was lost (stale ctx +
 *     missed live-sink retry), redelivery waited for the next session start
 *     (possibly days for a long-lived foreground);
 *   - a dispatch pending-wake written AFTER the successor session already
 *     started (issue #2's accepted residual window) waited for the NEXT
 *     replacement;
 *   - stale state (old completed runs, abandoned claims) reconciled only at
 *     startup, if ever.
 *
 * A low-cadence unref'd interval closes all three: both delivery functions
 * are already idempotent + claim-disciplined (two-phase rename claims with
 * stale-claim recovery), so re-invoking them is safe by construction — the
 * timer adds LIVENESS, not new semantics.
 *
 * ## Process-lifetime discipline
 *
 * pi reloads extensions with `moduleCache: false`, so module state dies on
 * session replacement while the PROCESS (and any armed timers) survives. The
 * active timer handle therefore lives on a `globalThis` slot (same pattern
 * as the issue-#2 live wake sink): a successor module instance REPLACES the
 * predecessor's timer instead of stacking a leaked one per reload. The timer
 * is `unref()`d — it never keeps the event loop alive — and never armed in
 * child processes (`PI_DELEGATE_CHILD` guard, plus the caller's own guard).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { logDelegateDiagnostic } from "./diagnostics.js";
import {
	resolveOrchestrateDir,
	resolveOrchestratePendingDir,
	STALE_CLAIM_MS,
} from "./detached-spawn.js";
import {
	discoverAgentsAll,
	resolveByScopePrecedence,
	type AgentSource,
} from "./agents.js";
import { applyAgentOverrides } from "./agent-overrides.js";
import { configuredPackageRoots } from "./configured-package-roots.js";
import { loadConfigReadOnly, type DelegateConfig } from "./config.js";
import { isUniformRunLive, listAllRunStatuses } from "./run-introspect.js";
import { isOwnedByThisProcess, listRuns, resolveRuntimeStatePath } from "./runtime.js";
import { getLiveWakeSink, resolvePendingWakesDir } from "./pending-wakes.js";
import {
	ASK_TOOL_NAME,
	BUILTIN_TOOL_NAMES,
	normalizeExtensionIdentity,
	resolveToolSurfaceAgainstInventory,
	type ToolSurfaceInventoryEntry,
} from "./tool-surface.js";

/** Default tick cadence. Low enough to bound delivery latency, high enough to be free. */
export const MAINTENANCE_INTERVAL_MS = 45_000;

/** Run the (heavier) hygiene sweep every Nth tick (~15 min at the default cadence). */
export const SWEEP_EVERY_TICKS = 20;

/** globalThis slot for the ACTIVE timer (survives moduleCache:false reloads). */
const TIMER_SLOT = Symbol.for("pi-delegate.maintenanceTimer");
/** globalThis slot for observable status (read by the health surface). */
const STATUS_SLOT = Symbol.for("pi-delegate.maintenanceStatus");

export interface MaintenanceStatus {
	running: boolean;
	startedAt?: number;
	ticks: number;
	lastTickAt?: number;
	lastSweepAt?: number;
	lastError?: string;
}

type GlobalSlots = {
	[TIMER_SLOT]?: NodeJS.Timeout;
	[STATUS_SLOT]?: MaintenanceStatus;
};

function slots(): GlobalSlots {
	return globalThis as unknown as GlobalSlots;
}

export function getMaintenanceStatus(): MaintenanceStatus {
	return slots()[STATUS_SLOT] ?? { running: false, ticks: 0 };
}

export interface MaintenanceHandle {
	dispose(): void;
	/** Test seam: run one tick synchronously (counts toward the sweep cadence). */
	tickNowForTests(): void;
}

/**
 * Arm the periodic maintenance interval. The caller passes the work as
 * closures (keeps this module free of an index.ts import cycle):
 *
 *   - `deliver` runs EVERY tick — wire `deliverPendingOrchestrateResults` +
 *     `deliverPendingDispatchWakes` with the live foreground ctx.
 *   - `sweep` runs every `sweepEveryTicks`-th tick — wire
 *     `sweepOldCompletedRuns` (and anything else age-based).
 *
 * Every tick is fully contained: a throw is logged to diagnostics and never
 * escapes into the event loop. Returns a no-op handle in child processes.
 */
export function startPeriodicMaintenance(opts: {
	deliver: () => void;
	sweep: () => void;
	intervalMs?: number;
	sweepEveryTicks?: number;
}): MaintenanceHandle {
	if (process.env.PI_DELEGATE_CHILD === "1") {
		// Children must never run foreground-only redelivery (defense-in-depth;
		// the session_start caller already guards).
		return { dispose: () => {}, tickNowForTests: () => {} };
	}
	const intervalMs = opts.intervalMs ?? MAINTENANCE_INTERVAL_MS;
	const sweepEveryTicks = Math.max(1, opts.sweepEveryTicks ?? SWEEP_EVERY_TICKS);

	// Replace (never stack) a predecessor session's timer in this process.
	const g = slots();
	if (g[TIMER_SLOT]) {
		clearInterval(g[TIMER_SLOT]);
		g[TIMER_SLOT] = undefined;
	}

	const status: MaintenanceStatus = {
		running: true,
		startedAt: Date.now(),
		// `ticks` counts THIS arm (resets per session rotation — `startedAt`
		// is its epoch), while `lastSweepAt` deliberately carries across
		// re-arms so the health surface doesn't report "never swept" after
		// every rotation. Reading "ticks=3, last sweep 10min ago" together is
		// therefore expected, not inconsistent.
		ticks: 0,
		lastSweepAt: g[STATUS_SLOT]?.lastSweepAt,
	};
	g[STATUS_SLOT] = status;

	const tick = (): void => {
		status.ticks += 1;
		status.lastTickAt = Date.now();
		try {
			opts.deliver();
			if (status.ticks % sweepEveryTicks === 0) {
				opts.sweep();
				status.lastSweepAt = Date.now();
			}
			status.lastError = undefined;
		} catch (err) {
			// Contained: the next tick retries; both legs are idempotent.
			status.lastError = (err as Error)?.message ?? String(err);
			logDelegateDiagnostic(
				`periodic maintenance tick failed (contained, retries next tick): ${status.lastError}`,
				{ level: "warn", throttleKey: "maintenance-tick" },
			);
		}
	};

	const timer = setInterval(tick, intervalMs);
	// NEVER keep the event loop alive for maintenance.
	(timer as unknown as { unref?: () => void }).unref?.();
	g[TIMER_SLOT] = timer;

	return {
		dispose: () => {
			const cur = slots()[TIMER_SLOT];
			// Only clear if the slot still holds OUR timer (a successor's fresh
			// registration is never clobbered — same discipline as the live
			// wake sink).
			if (cur === timer) {
				clearInterval(timer);
				slots()[TIMER_SLOT] = undefined;
				status.running = false;
			}
		},
		tickNowForTests: tick,
	};
}

// ─── Health surface ──────────────────────────────────────────────────────────

export interface DelegateAgentSurfaceReport {
	/** Discovered agent name. */
	name: string;
	/** Discovery scope that supplied the winning definition. */
	source: AgentSource;
	/** Path of the winning agent definition. */
	filePath: string;
	/** Whether the inventory proved this surface, found a break, or could not decide. */
	status: "OK" | "BROKEN" | "UNKNOWN";
	/** Exact configured selectors that could not be resolved. */
	unresolvedSelectors: string[];
	/** Exact configured selectors whose ownership or inventory could not be verified. */
	uncertainSelectors: string[];
	/** Package names absent from the foreground extension inventory. */
	missingPackages: string[];
}

export interface DelegateHealthReport {
	/** Runs owned by this foreground process (session-local user-facing count). */
	activeRuns: number;
	/** Completed runs owned by this foreground process (session-local user-facing count). */
	completedRuns: number;
	/** Active runs in the shared in-memory registry, including foreign live sessions. */
	registryActiveRuns: number;
	/** Completed runs in the shared in-memory registry, including foreign live sessions. */
	registryCompletedRuns: number;
	totalRunsInRegistry: number;
	/** Live OS-detached drivers owned by this foreground session. */
	activeDetachedDrivers: number;
	/** Terminal OS-detached driver records owned by this foreground session. */
	terminalDetachedDrivers: number;
	/** True when the bounded detached status scan skipped unreadable records. */
	detachedStatusDegraded: boolean;
	/** True when additional detached records existed beyond the bounded scan. */
	detachedStatusTruncated: boolean;
	/** Per-agent tool-surface checks from the bounded read-only scan. */
	agentSurfaces: DelegateAgentSurfaceReport[];
	/** True when agent discovery or inventory/resolution degraded. */
	agentSurfaceScanDegraded: boolean;
	/** True when more than the bounded agent scan could be inspected. */
	agentSurfaceScanTruncated: boolean;
	/** Number of agent definition files opened by the bounded health scan. */
	agentSurfaceFilesRead: number;
	runStateBytes: number;
	driverStorageBytes: number;
	eventBusDirBytes: number;
	pendingWakes: number;
	pendingDriverResults: number;
	/** Abandoned two-phase claims (`*.json.delivered` older than STALE_CLAIM_MS). */
	staleClaims: number;
	maintenance: MaintenanceStatus;
}

/** Bounded recursive dir size (entries capped so health can never wedge on a runaway dir). */
function dirSizeBytes(root: string, maxEntries = 20_000): number {
	let total = 0;
	let seen = 0;
	const stack = [root];
	while (stack.length > 0 && seen < maxEntries) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (seen++ >= maxEntries) break;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile()) {
				try {
					total += fs.statSync(p).size;
				} catch {
					/* raced unlink */
				}
			}
		}
	}
	return total;
}

function fileSize(p: string): number {
	try {
		return fs.statSync(p).size;
	} catch {
		return 0;
	}
}

/** Count files in `dir` matching a suffix predicate; 0 when the dir is absent. */
function countFiles(dir: string, match: (name: string) => boolean): number {
	try {
		return fs.readdirSync(dir).filter(match).length;
	} catch {
		return 0;
	}
}

/** Count abandoned `.json.delivered` claims (older than STALE_CLAIM_MS) in `dir`. */
function countStaleClaims(dir: string, now: number): number {
	let stale = 0;
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	for (const name of names) {
		if (!name.endsWith(".json.delivered")) continue;
		try {
			if (now - fs.statSync(path.join(dir, name)).mtimeMs > STALE_CLAIM_MS) stale++;
		} catch {
			/* raced */
		}
	}
	return stale;
}

/** Read the nearest package name from extension provenance without loading the package. */
function packageNameFromPath(rawPath: string | undefined): string | undefined {
	if (!rawPath || rawPath.startsWith("<") || rawPath.startsWith("file:")) return undefined;
	let current = path.dirname(path.resolve(rawPath));
	for (let depth = 0; depth < 12; depth++) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: unknown };
			if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim();
		} catch {
			// Missing manifests are normal for local, non-package extensions.
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/** Build the bounded inventory exposed by the already-running foreground session. */
function collectForegroundToolInventory(): { inventory: ToolSurfaceInventoryEntry[]; degraded: boolean } {
	const builtinNames = new Set<string>([...BUILTIN_TOOL_NAMES, ASK_TOOL_NAME]);
	const inventory: ToolSurfaceInventoryEntry[] = [...builtinNames].map((name) => ({
		identity: `<builtin:${name}>`,
		source: "builtin",
		path: `<builtin:${name}>`,
		toolNames: [name],
	}));
	const sink = getLiveWakeSink() as unknown as { getAllTools?: () => unknown };
	if (typeof sink?.getAllTools !== "function") return { inventory, degraded: true };

	let tools: unknown;
	try {
		tools = sink.getAllTools.call(sink);
	} catch {
		return { inventory, degraded: true };
	}
	if (!Array.isArray(tools)) return { inventory, degraded: true };

	const byExtension = new Map<string, ToolSurfaceInventoryEntry>();
	for (const value of tools) {
		if (!value || typeof value !== "object") continue;
		const tool = value as { name?: unknown; sourceInfo?: { source?: unknown; path?: unknown; baseDir?: unknown } };
		if (typeof tool.name !== "string" || builtinNames.has(tool.name)) continue;
		const source = typeof tool.sourceInfo?.source === "string" ? tool.sourceInfo.source : undefined;
		const extensionPath = typeof tool.sourceInfo?.path === "string" ? tool.sourceInfo.path : undefined;
		const baseDir = typeof tool.sourceInfo?.baseDir === "string" ? tool.sourceInfo.baseDir : undefined;
		const npmSpec = source?.startsWith("npm:") ? source.slice("npm:".length) : undefined;
		const versionAt = npmSpec === undefined ? -1 : npmSpec.startsWith("@") ? npmSpec.indexOf("@", 1) : npmSpec.indexOf("@");
		const packageName = npmSpec === undefined ? packageNameFromPath(extensionPath ?? baseDir) : versionAt >= 0 ? npmSpec.slice(0, versionAt) : npmSpec;
		const identity = normalizeExtensionIdentity(packageName ?? source ?? extensionPath ?? "");
		if (!identity) continue;
		const key = `${identity}\u0000${source ?? ""}\u0000${extensionPath ?? ""}`;
		const existing = byExtension.get(key);
		if (existing) {
			if (!existing.toolNames.includes(tool.name)) {
				byExtension.set(key, { ...existing, toolNames: [...existing.toolNames, tool.name] });
			}
			continue;
		}
		byExtension.set(key, {
			identity,
			...(source ? { source } : {}),
			...(extensionPath ? { path: extensionPath } : {}),
			...(packageName ? { packageName } : {}),
			...(baseDir ? { packageRoot: baseDir } : {}),
			toolNames: [tool.name],
		});
	}
	return { inventory: [...inventory, ...byExtension.values()], degraded: false };
}

const HEALTH_AGENT_FILE_LIMIT = 100;
const HEALTH_AGENT_FILE_BYTES = 256 * 1024;

export interface DelegateHealthDiscoveryOptions {
	/** The live Pi trust decision used by dispatch package resolution. */
	projectTrusted?: boolean;
	/** Test seam for an already-loaded effective config snapshot. */
	config?: DelegateConfig;
}

function scanAgentSurfaces(
	agentDir: string,
	cwd: string,
	options: DelegateHealthDiscoveryOptions = {},
): {
	agentSurfaces: DelegateAgentSurfaceReport[];
	agentSurfaceScanDegraded: boolean;
	agentSurfaceScanTruncated: boolean;
	agentSurfaceFilesRead: number;
} {
	let discovery: ReturnType<typeof discoverAgentsAll>;
	let configuredDiscoveryDegraded = false;
	try {
		const configuredRoots = configuredPackageRoots({
			cwd,
			agentDir,
			projectTrusted: options.projectTrusted === true,
			warn: () => {
				configuredDiscoveryDegraded = true;
			},
		});
		discovery = discoverAgentsAll(cwd, {
			additionalResolvedPackageRoots: configuredRoots,
			agentDiscoveryLimits: {
				maxFiles: HEALTH_AGENT_FILE_LIMIT,
				maxFileBytes: HEALTH_AGENT_FILE_BYTES,
				maxPackageEntries: HEALTH_AGENT_FILE_LIMIT,
				maxPackageDirectoryEntries: HEALTH_AGENT_FILE_LIMIT * 4,
				maxChainFiles: HEALTH_AGENT_FILE_LIMIT,
			},
		});
	} catch {
		return {
			agentSurfaces: [],
			agentSurfaceScanDegraded: true,
			agentSurfaceScanTruncated: false,
			agentSurfaceFilesRead: 0,
		};
	}
	const discoveredAgents = resolveByScopePrecedence([
		...discovery.builtin,
		...discovery.package,
		...discovery.user,
		...discovery.project,
	]);
	const effective = applyAgentOverrides(
		discoveredAgents,
		options.config ?? loadConfigReadOnly(agentDir),
	).agents;
	const inspected = effective.slice(0, HEALTH_AGENT_FILE_LIMIT);
	const discoveryScan = discovery.agentDiscoveryScan ?? {
		filesRead: 0,
		degraded: true,
		truncated: true,
	};
	const inventoryResult = collectForegroundToolInventory();
	let degraded = inventoryResult.degraded;
	const agentSurfaces = inspected.map((agent): DelegateAgentSurfaceReport => {
		try {
			const resolution = resolveToolSurfaceAgainstInventory(agent, inventoryResult.inventory, {
				inventoryDegraded: inventoryResult.degraded,
			});
			return {
				name: agent.name,
				source: agent.source,
				filePath: agent.filePath,
				status: resolution.unresolvedSelectors.length > 0
					? "BROKEN"
					: resolution.uncertainSelectors.length > 0 ? "UNKNOWN" : "OK",
				unresolvedSelectors: resolution.unresolvedSelectors,
				uncertainSelectors: resolution.uncertainSelectors,
				missingPackages: resolution.missingPackages,
			};
		} catch {
			degraded = true;
			return {
				name: agent.name,
				source: agent.source,
				filePath: agent.filePath,
				status: "BROKEN",
				unresolvedSelectors: [...new Set((agent.tools ?? []).map((entry) => entry.trim()).filter(Boolean))],
				uncertainSelectors: [],
				missingPackages: [],
			};
		}
	});
	return {
		agentSurfaces,
		agentSurfaceScanDegraded: configuredDiscoveryDegraded || degraded || discoveryScan.degraded,
		agentSurfaceScanTruncated: discoveryScan.truncated || effective.length > inspected.length,
		agentSurfaceFilesRead: discoveryScan.filesRead,
	};
}

/**
 * Collect the operator-facing health report (issue #14). STRICTLY READ-ONLY:
 * no claims are recovered, no files touched — safe to call concurrently with
 * live delivery. (The live deployment's run-state.json once hit 30 MB before
 * the persistence caps; this is the early-warning surface for that class.)
 */
export function collectDelegateHealth(
	agentDir: string,
	currentSessionId?: string,
	cwd = process.cwd(),
	discoveryOptions: DelegateHealthDiscoveryOptions = {},
): DelegateHealthReport {
	const now = Date.now();
	const runs = listRuns();
	const ownedRuns = runs.filter(isOwnedByThisProcess);
	const active = ownedRuns.filter((r) => r.completedAt === undefined).length;
	const registryActive = runs.filter((r) => r.completedAt === undefined).length;
	const pendingWakesDir = resolvePendingWakesDir(agentDir);
	const driverPendingDir = resolveOrchestratePendingDir(agentDir);
	// Issue #53: detached drivers intentionally do not live in the in-process
	// runtime registry. Enumerate their durable status projection separately so
	// health never folds two unlike execution models together.
	const detachedListing = listAllRunStatuses(
		agentDir,
		undefined,
		currentSessionId,
		undefined,
		false, // health is a read-only operator surface
	);
	const detached = detachedListing.statuses.filter((status) => status.source === "detached");
	const activeDetached = detached.filter(isUniformRunLive).length;
	const maintenance = getMaintenanceStatus();
	const agentSurfaceScan = scanAgentSurfaces(agentDir, cwd, discoveryOptions);
	return {
		activeRuns: active,
		completedRuns: ownedRuns.length - active,
		registryActiveRuns: registryActive,
		registryCompletedRuns: runs.length - registryActive,
		totalRunsInRegistry: runs.length,
		activeDetachedDrivers: activeDetached,
		terminalDetachedDrivers: detached.length - activeDetached,
		detachedStatusDegraded: detachedListing.degraded,
		detachedStatusTruncated: detachedListing.truncated,
		...agentSurfaceScan,
		runStateBytes: fileSize(resolveRuntimeStatePath(agentDir)),
		driverStorageBytes: dirSizeBytes(resolveOrchestrateDir(agentDir)),
		eventBusDirBytes: dirSizeBytes(
			// Layout owned by event-bus.ts / diagnostics.ts (documented in both).
			path.join(agentDir, "extensions", "pi-delegate", "event-bus"),
		),
		pendingWakes: countFiles(pendingWakesDir, (n) => n.endsWith(".json")),
		pendingDriverResults: countFiles(driverPendingDir, (n) => n.endsWith(".json")),
		staleClaims: countStaleClaims(pendingWakesDir, now) + countStaleClaims(driverPendingDir, now),
		// Keep the raw exception in diagnostics/getMaintenanceStatus for local
		// debugging, but health text/details receive only a fixed category.
		maintenance: {
			...maintenance,
			lastError: maintenance.lastError ? "maintenance-tick-failed" : undefined,
		},
	};
}

/** Render the health report as the human-readable tool/slash output. */
export function formatDelegateHealth(report: DelegateHealthReport): string {
	const kb = (n: number): string =>
		n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
	const ago = (ts?: number): string =>
		ts === undefined ? "never" : `${Math.round((Date.now() - ts) / 1000)}s ago`;
	const m = report.maintenance;
	const orderedAgentSurfaces = [...report.agentSurfaces].sort((a, b) => {
		const rank = (status: DelegateAgentSurfaceReport["status"]): number =>
			status === "BROKEN" ? 0 : status === "UNKNOWN" ? 1 : 2;
		return rank(a.status) === rank(b.status) ? a.name.localeCompare(b.name) : rank(a.status) - rank(b.status);
	});
	const shownAgentSurfaces = orderedAgentSurfaces.slice(0, 20);
	const brokenAgentCount = orderedAgentSurfaces.filter((agent) => agent.status === "BROKEN").length;
	const unknownAgentCount = orderedAgentSurfaces.filter((agent) => agent.status === "UNKNOWN").length;
	const agentScanFlags = [
		report.agentSurfaceScanDegraded ? "scan degraded" : "",
		report.agentSurfaceScanTruncated ? "truncated" : "",
	].filter(Boolean);
	const agentSurfaceLines = shownAgentSurfaces.map((agent) => {
		if (agent.status === "OK") return `- agent ${agent.name} (${agent.source}, ${agent.filePath}): OK`;
		if (agent.status === "UNKNOWN") {
			const selectors = agent.uncertainSelectors.join(", ") || "unknown selector";
			return `- agent ${agent.name} (${agent.source}, ${agent.filePath}): UNKNOWN selector ${selectors}`;
		}
		const selectors = agent.unresolvedSelectors.join(", ") || "unknown selector";
		const packages = agent.missingPackages.join(", ") || "none";
		return `- agent ${agent.name} (${agent.source}, ${agent.filePath}): BROKEN selector ${selectors}; missing package ${packages}`;
	});
	const agentRemainder = orderedAgentSurfaces.length > shownAgentSurfaces.length
		? [`- agent surfaces: ${orderedAgentSurfaces.length - shownAgentSurfaces.length} additional result(s) not shown`]
		: [];
	return [
		"Delegate health:",
		`- agent surfaces: ${orderedAgentSurfaces.length} inspected, ${orderedAgentSurfaces.length - brokenAgentCount - unknownAgentCount} OK, ${brokenAgentCount} BROKEN, ${unknownAgentCount} UNKNOWN${agentScanFlags.length > 0 ? ` (${agentScanFlags.join(", ")})` : ""}`,
		...agentSurfaceLines,
		...agentRemainder,
		`- this session: ${report.activeRuns} active, ${report.completedRuns} completed (in-process)`,
		`- shared registry: ${report.registryActiveRuns} active, ${report.registryCompletedRuns} completed (${report.totalRunsInRegistry} total)`,
		`- detached drivers: ${report.activeDetachedDrivers} active, ${report.terminalDetachedDrivers} terminal` +
			(report.detachedStatusDegraded || report.detachedStatusTruncated
				? ` (${[
						report.detachedStatusDegraded ? "scan degraded" : "",
						report.detachedStatusTruncated ? "truncated" : "",
					].filter(Boolean).join(", ")})`
				: ""),
		`- run-state.json: ${kb(report.runStateBytes)}`,
		`- driver storage (orchestrate/): ${kb(report.driverStorageBytes)}; event-bus/: ${kb(report.eventBusDirBytes)}`,
		`- pending: ${report.pendingWakes} dispatch wake(s), ${report.pendingDriverResults} driver result(s), ${report.staleClaims} stale claim(s)`,
		`- maintenance: ${m.running ? "running" : "NOT running"}; ticks=${m.ticks}, last tick ${ago(m.lastTickAt)}, last sweep ${ago(m.lastSweepAt)}` +
			(m.lastError ? `; last error: ${m.lastError}` : ""),
	].join("\n");
}
