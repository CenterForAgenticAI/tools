/**
 * Detached `orchestrate`-shape child-process substrate (spec 0005, node A).
 *
 * This module is the PARENT-SIDE half of the detached-child mechanism plus the
 * shared on-disk contract the child (`orchestrate-runner.ts`) writes back to.
 * It deliberately pulls NO `@earendil-works/pi-coding-agent` SDK imports so the
 * foreground extension can spawn / reap / hydrate without paying the cost of
 * the session machinery — only the standalone child entrypoint boots a real
 * session.
 *
 * Responsibilities:
 *   1. `spawnDetachedOrchestrate(cfg)` — write the cfg to a tmp file, resolve
 *      the COMPILED runner path relative to THIS module's own dist location,
 *      and `spawn(process.execPath, [runnerJs, cfgPath], { detached:true,
 *      stdio:'ignore' }).unref()` so the child outlives the foreground
 *      (REQ-ORCH-1 / REQ-ORCH-2).
 *   2. The result-file STATE MACHINE: a child normally writes one of two
 *      terminal shapes (`done` / `failed`); the FILE'S ABSENCE is itself a
 *      third state ("never wrote" — crash / OOM). `readResultFile` parses the
 *      first two; `reapResult` can project an absent file + a dead pid as a
 *      synthesized `failed`, while `orchestrate-recovery.ts` durably persists
 *      that failure and queues its pending wake (REQ-ORCH-6 / issue #54).
 *   3. Hydrate-and-deliver: a child that finished while the foreground was
 *      gone leaves its result in a PENDING dir; `scanPendingResults` /
 *      `consumePendingResult` let `session_start` pick them up on next start
 *      with NO captured in-process `pi` ctx (REQ-ORCH-6).
 *
 * The detached-spawn PATTERN (write-cfg → spawn(execPath, [runner, cfg],
 * {detached:true}).unref()) is adopted from pi-subagents-nicobailon
 * (github.com/nicobailon/pi-subagents, MIT), specifically
 * `runs/background/async-execution.ts`. We resolve the COMPILED `.js` runner
 * (no jiti / no TS-runtime dep) — the runner ships in `dist/` like the rest of
 * this package. [decision: runner-entrypoint-compiled-js-no-jiti]
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Cursor } from "@caair/pi-daemon/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { pidAlive } from "./event-bus.js";
import {
	isValidProcessBootId,
	isValidProcessNonce,
	isValidProcessStartTicks,
} from "./process-identity.js";
import { isSafeRunId } from "./run-id.js";
import { assertValidTasksSeed, parseTaskLedger, type TaskLedger, type TasksSeed } from "./task-seam.js";
import type { ThinkingLevel } from "./thinking-policy.js";
import type { ExtSelector } from "./tool-surface.js";
import { materializeEnv, type EnvOverrides } from "./env-overrides.js";
import { openChildLogFd, sweepOrchestrateChildLogs } from "./orchestrate-childlog.js";

// ── On-disk runtime layout ──────────────────────────────────────────────────
// Mirror the event-bus convention (agentDir/extensions/pi-delegate/...) so the
// orchestrate substrate sits alongside the rest of the delegate runtime state
// and is swept / inspected the same way.

/** Root dir for all orchestrate detached-child runtime state under `agentDir`. */
export function resolveOrchestrateDir(agentDir: string): string {
	return path.join(agentDir, "extensions", "pi-delegate", "orchestrate");
}

/** Dir holding serialized cfg files handed to spawned children. */
export function resolveOrchestrateCfgDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "cfg");
}

/** Dir holding terminal result files, keyed by runId. */
export function resolveOrchestrateResultsDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "results");
}

/**
 * Dir holding per-run control ROUTE RECORDS, keyed by runId (spec 0009, node
 * A). Sits alongside cfg / results / pending. Each record is the `0600`
 * secret-bearing artifact the foreground holds to authenticate a later-turn
 * `delegate_steer` / `delegate_cancel` to a detached child; the dir itself is
 * created `0700`. The route-record read/write/delete + secret-mint logic lives
 * in `src/control-route.ts` — this resolver sits here next to its siblings so
 * the on-disk orchestrate layout stays defined in one place.
 */
export function resolveOrchestrateRoutesDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "routes");
}

/** Root for non-secret, owner-partitioned live-run index markers (issue #53). */
export function resolveOrchestrateActiveDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "active");
}

/** Root for bounded non-secret ownership evidence retained through delivery. */
export function resolveOrchestrateOwnerEvidenceDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "owner-evidence");
}

export const ORCHESTRATE_OWNER_EVIDENCE_VERSION = 1 as const;
const MAX_OWNER_EVIDENCE_BYTES = 2048;
const MAX_OWNER_SESSION_ID_BYTES = 512;
const MAX_OWNER_NONCE_BYTES = 256;

export interface OrchestrateOwnerEvidence {
	version: typeof ORCHESTRATE_OWNER_EVIDENCE_VERSION;
	runId: string;
	ownerSessionId: string;
	/** Optional only for pre-upgrade records; both fields must be present together. */
	ownerPid?: number;
	ownerNonce?: string;
}

export type OrchestrateOwnerEvidenceRead =
	| { kind: "absent" }
	| { kind: "present"; evidence: OrchestrateOwnerEvidence }
	| { kind: "unknown" };

export function resolveOrchestrateOwnerEvidenceFile(agentDir: string, runId: string): string {
	if (!isSafeRunId(runId)) throw new Error(`unsafe runId rejected: ${JSON.stringify(runId)}`);
	return path.join(resolveOrchestrateOwnerEvidenceDir(agentDir), `${runId}.json`);
}

function validOwnerSessionId(value: unknown): value is string {
	return typeof value === "string" &&
		Buffer.byteLength(value, "utf8") > 0 &&
		Buffer.byteLength(value, "utf8") <= MAX_OWNER_SESSION_ID_BYTES &&
		!/\p{Cc}/u.test(value);
}

function validOwnerNonce(value: unknown): value is string {
	return typeof value === "string" &&
		Buffer.byteLength(value, "utf8") > 0 &&
		Buffer.byteLength(value, "utf8") <= MAX_OWNER_NONCE_BYTES &&
		!/\p{Cc}/u.test(value);
}

/** Publish ownership evidence before a detached child can start or recovery can publish. */
export function writeOrchestrateOwnerEvidence(cfg: Pick<OrchestrateCfg, "agentDir" | "runId" | "ownerSessionId" | "ownerPid" | "ownerNonce">): void {
	if (!cfg.ownerSessionId) return;
	const hasPid = cfg.ownerPid !== undefined;
	const hasNonce = cfg.ownerNonce !== undefined;
	if (
		!isSafeRunId(cfg.runId) ||
		!validOwnerSessionId(cfg.ownerSessionId) ||
		(hasPid !== hasNonce) ||
		(hasPid && (!Number.isInteger(cfg.ownerPid) || cfg.ownerPid! <= 0 || !validOwnerNonce(cfg.ownerNonce)))
	) {
		throw new Error("invalid driver owner evidence");
	}
	const file = resolveOrchestrateOwnerEvidenceFile(cfg.agentDir, cfg.runId);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	let fd: number | undefined;
	try {
		const evidence: OrchestrateOwnerEvidence = {
			version: ORCHESTRATE_OWNER_EVIDENCE_VERSION,
			runId: cfg.runId,
			ownerSessionId: cfg.ownerSessionId,
			...(hasPid ? { ownerPid: cfg.ownerPid, ownerNonce: cfg.ownerNonce } : {}),
		};
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(evidence), "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* preserve the original error */ }
		}
		try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
	}
}

/** Read bounded, versioned ownership evidence; malformed evidence fails closed. */
export function readOrchestrateOwnerEvidence(agentDir: string, runId: string): OrchestrateOwnerEvidenceRead {
	if (!isSafeRunId(runId)) return { kind: "unknown" };
	const file = resolveOrchestrateOwnerEvidenceFile(agentDir, runId);
	let raw: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_EVIDENCE_BYTES) return { kind: "unknown" };
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" };
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const keys = Object.keys(parsed).sort();
		const hasPid = parsed.ownerPid !== undefined;
		const hasNonce = parsed.ownerNonce !== undefined;
		if (
			!((keys.join(",") === "ownerNonce,ownerPid,ownerSessionId,runId,version") ||
				(keys.join(",") === "ownerSessionId,runId,version")) ||
			parsed.version !== ORCHESTRATE_OWNER_EVIDENCE_VERSION ||
			parsed.runId !== runId ||
			!validOwnerSessionId(parsed.ownerSessionId) ||
			hasPid !== hasNonce ||
			(hasPid && (!Number.isInteger(parsed.ownerPid) || (parsed.ownerPid as number) <= 0 || !validOwnerNonce(parsed.ownerNonce)))
		) return { kind: "unknown" };
		return { kind: "present", evidence: parsed as unknown as OrchestrateOwnerEvidence };
	} catch {
		return { kind: "unknown" };
	}
}

/** Remove ownership evidence only after the pending result is consumed. */
export function deleteOrchestrateOwnerEvidence(agentDir: string, runId: string): void {
	if (!isSafeRunId(runId)) return;
	try { fs.rmSync(resolveOrchestrateOwnerEvidenceFile(agentDir, runId), { force: true }); } catch { /* best-effort */ }
}

/**
 * Age-sweep owner evidence that has no remaining result or live marker. A
 * pending/canonical result keeps its evidence authoritative; an active marker
 * keeps a running child attributable. This bounds abandoned sidecars without
 * deleting evidence needed by a live or undelivered run.
 */
export const ORCHESTRATE_OWNER_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function sweepOrchestrateOwnerEvidence(args: {
	agentDir: string;
	maxAgeMs?: number;
	now?: number;
}): number {
	const dir = resolveOrchestrateOwnerEvidenceDir(args.agentDir);
	const maxAgeMs = Math.max(1, args.maxAgeMs ?? ORCHESTRATE_OWNER_EVIDENCE_MAX_AGE_MS);
	const now = args.now ?? Date.now();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const runId = entry.name.slice(0, -".json".length);
		if (!isSafeRunId(runId)) continue;
		const file = path.join(dir, entry.name);
		try {
			if (now - fs.statSync(file).mtimeMs <= maxAgeMs) continue;
			if (fs.existsSync(resolvePendingFile(args.agentDir, runId)) || fs.existsSync(resolveResultFile(args.agentDir, runId))) continue;
			const owner = readOrchestrateOwnerEvidence(args.agentDir, runId);
			if (owner.kind === "unknown") continue;
			if (owner.kind === "present" && readOrchestrateActiveMarkerParentState(
				args.agentDir,
				owner.evidence.ownerSessionId,
				runId,
			).kind !== "absent") continue;
			fs.rmSync(file, { force: true });
			removed++;
		} catch {
			/* best-effort; a later maintenance pass retries this sidecar */
		}
	}
	return removed;
}

/** Stable path-safe owner partition; the raw session id never becomes a path. */
export function orchestrateOwnerKey(ownerSessionId: string): string {
	return createHash("sha256").update(ownerSessionId).digest("hex").slice(0, 32);
}

/** Direct owner partition used to enumerate live candidates without scanning history. */
export function resolveOrchestrateActiveOwnerDir(
	agentDir: string,
	ownerSessionId: string,
): string {
	return path.join(resolveOrchestrateActiveDir(agentDir), orchestrateOwnerKey(ownerSessionId));
}

/** Durable replacement-launch handoff, separate from the fixed-width marker. */
export interface OrchestrateReplacementHandoff {
	version: 1;
	runId: string;
	/** Remaining reconciliation passes while the replacement identity is absent. */
	remainingPasses: number;
	runnerPid?: number;
	runnerStartTicks?: string;
	runnerBootId?: string;
	runnerNonce?: string;
}

/** Exact owner-only path for a replacement handoff record. */
export function resolveOrchestrateReplacementHandoffFile(
	agentDir: string,
	runId: string,
): string {
	if (!isSafeRunId(runId)) throw new Error(`unsafe runId rejected: ${JSON.stringify(runId)}`);
	return path.join(resolveOrchestrateDir(agentDir), "recovery", `${runId}.replacement.json`);
}

/** Atomically publish a complete replacement handoff record. */
export function writeOrchestrateReplacementHandoff(
	agentDir: string,
	handoff: OrchestrateReplacementHandoff,
): void {
	const file = resolveOrchestrateReplacementHandoffFile(agentDir, handoff.runId);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(handoff), "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, file);
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best-effort */
		}
	}
}

/** Read a bounded replacement handoff; malformed records are ignored. */
export function readOrchestrateReplacementHandoff(
	agentDir: string,
	runId: string,
): OrchestrateReplacementHandoff | undefined {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(resolveOrchestrateReplacementHandoffFile(agentDir, runId), "utf8"),
		) as Partial<OrchestrateReplacementHandoff>;
		if (
			parsed.version !== 1 ||
			parsed.runId !== runId ||
			!Number.isInteger(parsed.remainingPasses) ||
			(parsed.remainingPasses as number) < 0 ||
			(parsed.runnerPid !== undefined &&
				(!Number.isInteger(parsed.runnerPid) || (parsed.runnerPid as number) <= 0)) ||
			(parsed.runnerStartTicks !== undefined && !isValidProcessStartTicks(parsed.runnerStartTicks)) ||
			(parsed.runnerBootId !== undefined && !isValidProcessBootId(parsed.runnerBootId)) ||
			(parsed.runnerNonce !== undefined && !isValidProcessNonce(parsed.runnerNonce))
		) {
			return undefined;
		}
		return parsed as OrchestrateReplacementHandoff;
	} catch {
		return undefined;
	}
}

/** Best-effort, idempotent removal of a replacement handoff. */
export function deleteOrchestrateReplacementHandoff(agentDir: string, runId: string): void {
	try {
		fs.rmSync(resolveOrchestrateReplacementHandoffFile(agentDir, runId), { force: true });
	} catch {
		/* best-effort */
	}
}

export interface OrchestrateActiveMarker {
	runId: string;
	rootRunId: string;
	ownerSessionId: string;
	startedAt: number;
	/** Fixed-width detached-runner PID slot. */
	runnerPid: string;
	/** Validation copy for the detached-runner PID slot. */
	runnerPidCopy: string;
	/** Fixed-width foreground owner PID slot stamped by the spawning parent. */
	parentPid: string;
	/** Validation copy for the foreground owner PID slot. */
	parentPidCopy: string;
}

const ACTIVE_MARKER_PID_PLACEHOLDER = "0000000000";
const MAX_ACTIVE_MARKER_BYTES = 4096;
type OpenActiveMarker = (file: string, flags: string) => number;

/** Write the non-secret active index marker before spawning the detached child. */
export function writeOrchestrateActiveMarker(cfg: OrchestrateCfg): string | undefined {
	if (!cfg.ownerSessionId || !isSafeRunId(cfg.runId)) return undefined;
	const dir = resolveOrchestrateActiveOwnerDir(cfg.agentDir, cfg.ownerSessionId);
	const file = path.join(dir, `${cfg.runId}.json`);
	const marker: OrchestrateActiveMarker = {
		runId: cfg.runId,
		rootRunId: cfg.rootRunId,
		ownerSessionId: cfg.ownerSessionId,
		startedAt:
			typeof cfg.startedAt === "number" && Number.isFinite(cfg.startedAt)
				? cfg.startedAt
				: Date.now(),
		runnerPid: ACTIVE_MARKER_PID_PLACEHOLDER,
		runnerPidCopy: ACTIVE_MARKER_PID_PLACEHOLDER,
		parentPid: ACTIVE_MARKER_PID_PLACEHOLDER,
		parentPidCopy: ACTIVE_MARKER_PID_PLACEHOLDER,
	};
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(resolveOrchestrateActiveDir(cfg.agentDir), 0o700);
		fs.chmodSync(dir, 0o700);
		fs.writeFileSync(file, JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
		fs.chmodSync(file, 0o600);
		return file;
	} catch (err) {
		// A failure after writeFileSync (for example the final chmod) must not
		// leave a false live candidate for a child that will never be spawned.
		try {
			fs.rmSync(file, { force: true });
		} catch {
			/* best-effort rollback; preserve the original creation error */
		}
		throw err;
	}
}

/**
 * Stamp a PID without ever recreating a marker the child already removed.
 * Opening first and writing through that fd means a concurrent unlink leaves an
 * unlinked inode, not a resurrected stale marker. The PID is replaced in the
 * existing fixed-width slots so the marker's layout and permissions do not
 * change. The parent and runner own separate slots, so neither can clobber the
 * other's publication. The third argument is retained for the runner's call
 * site: false selects the parent slot, true selects the runner slot.
 */
export function stampOrchestrateActiveMarkerPid(
	cfg: OrchestrateCfg,
	pid: number,
	overwriteExisting = false,
	openFile: OpenActiveMarker = fs.openSync,
): void {
	if (!cfg.ownerSessionId || !isSafeRunId(cfg.runId) || !Number.isInteger(pid) || pid <= 0) return;
	const digits = String(pid).padStart(ACTIVE_MARKER_PID_PLACEHOLDER.length, "0");
	if (digits.length !== ACTIVE_MARKER_PID_PLACEHOLDER.length) return;
	const file = path.join(
		resolveOrchestrateActiveOwnerDir(cfg.agentDir, cfg.ownerSessionId),
		`${cfg.runId}.json`,
	);
	let fd: number | undefined;
	try {
		fd = openFile(file, "r+");
		const buffer = Buffer.alloc(MAX_ACTIVE_MARKER_BYTES + 1);
		const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytes === 0 || bytes > MAX_ACTIVE_MARKER_BYTES) return;
		const markerText = buffer.subarray(0, bytes).toString("ascii");
		const field = overwriteExisting ? "runnerPid" : "parentPid";
		const copyField = overwriteExisting ? "runnerPidCopy" : "parentPidCopy";
		const prefix = `"${field}":"`;
		const propertyOffset = markerText.indexOf(prefix);
		if (propertyOffset < 0) return;
		const slotStart = propertyOffset + Buffer.byteLength(prefix, "ascii");
		const currentSlot = markerText.slice(slotStart, slotStart + ACTIVE_MARKER_PID_PLACEHOLDER.length);
		if (!/^\d{10}$/.test(currentSlot)) return;
		// The parent only fills its own placeholder. The runner owns a separate
		// field and may replace an existing value from the parent/legacy layout.
		if (!overwriteExisting && currentSlot !== ACTIVE_MARKER_PID_PLACEHOLDER) return;
		const copyPrefix = `"${copyField}":"`;
		const copyPropertyOffset = markerText.indexOf(copyPrefix);
		if (copyPropertyOffset < 0) {
			// A pre-#98 marker has no parent field or validation copy. Keep the
			// legacy runner slot writable, but never make the parent race on it.
			if (!overwriteExisting) return;
			const pidBytes = Buffer.from(digits, "ascii");
			let written = 0;
			while (written < pidBytes.length) {
				const count = fs.writeSync(
					fd,
					pidBytes,
					written,
					pidBytes.length - written,
					slotStart + written,
				);
				if (count <= 0) return;
				written += count;
			}
			return;
		}
		const copyStart = copyPropertyOffset + Buffer.byteLength(copyPrefix, "ascii");
		const currentCopy = markerText.slice(copyStart, copyStart + ACTIVE_MARKER_PID_PLACEHOLDER.length);
		if (!/^\d{10}$/.test(currentCopy)) return;
		const pidBytes = Buffer.from(digits, "ascii");
		// Keep both copies in one contiguous write. The intervening JSON syntax is
		// copied unchanged, and the two fields remain disjoint between parent and
		// runner writers. A short/interrupted write therefore leaves either
		// malformed JSON or mismatched copies, never an accepted hybrid PID.
		const publicationEnd = copyStart + pidBytes.length;
		const publication = Buffer.from(markerText.slice(slotStart, publicationEnd), "ascii");
		pidBytes.copy(publication, 0);
		pidBytes.copy(publication, copyStart - slotStart);
		let written = 0;
		while (written < publication.length) {
			const count = fs.writeSync(
				fd,
				publication,
				written,
				publication.length - written,
				slotStart + written,
			);
			if (count <= 0) return;
			written += count;
		}
	} catch {
		/* best-effort; the route/event pid paths remain available */
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
	}
}

/**
 * Parse an owner's active marker under every bound the PID readers depend on:
 * size-capped, JSON-parsed, and identity-checked against the runId and owner
 * the caller asked about. Shared by the slot readers below so they cannot drift
 * apart on validation.
 */
function readOrchestrateActiveMarkerRecord(
	agentDir: string,
	ownerSessionId: string | undefined,
	runId: string,
): Partial<OrchestrateActiveMarker> | undefined {
	if (!ownerSessionId || !isSafeRunId(runId)) return undefined;
	try {
		const file = path.join(resolveOrchestrateActiveOwnerDir(agentDir, ownerSessionId), `${runId}.json`);
		const stat = fs.statSync(file);
		if (stat.size <= 0 || stat.size > MAX_ACTIVE_MARKER_BYTES) return undefined;
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OrchestrateActiveMarker>;
		if (parsed.runId !== runId || parsed.ownerSessionId !== ownerSessionId) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * A fixed-width decimal slot, or undefined. The unstamped placeholder is ten
 * zeroes, so requiring a positive pid also rejects a slot nobody has written.
 */
function readActiveMarkerPidSlot(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{10}$/.test(value)) return undefined;
	const pid = Number(value);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The foreground owner slot, accepted only when its validation copy agrees. */
function parentPidFromMarker(parsed: Partial<OrchestrateActiveMarker>): number | undefined {
	const parentPid = readActiveMarkerPidSlot(parsed.parentPid);
	return parentPid !== undefined && parentPid === readActiveMarkerPidSlot(parsed.parentPidCopy)
		? parentPid
		: undefined;
}

/** The detached-runner slot, including the pre-copy legacy marker shape. */
function runnerPidFromMarker(parsed: Partial<OrchestrateActiveMarker>): number | undefined {
	const runnerPid = readActiveMarkerPidSlot(parsed.runnerPid);
	if (parsed.runnerPidCopy === undefined) return runnerPid;
	return runnerPid !== undefined && runnerPid === readActiveMarkerPidSlot(parsed.runnerPidCopy)
		? runnerPid
		: undefined;
}

/** Read the bounded, identity-checked runner PID from an owner's active marker. */
export function readOrchestrateActiveMarkerPid(
	agentDir: string,
	ownerSessionId: string | undefined,
	runId: string,
): number | undefined {
	const parsed = readOrchestrateActiveMarkerRecord(agentDir, ownerSessionId, runId);
	return parsed ? runnerPidFromMarker(parsed) : undefined;
}

/** Read the foreground owner PID slot stamped from `cfg.ownerPid`. */
export function readOrchestrateActiveMarkerParentPid(
	agentDir: string,
	ownerSessionId: string | undefined,
	runId: string,
): number | undefined {
	const parsed = readOrchestrateActiveMarkerRecord(agentDir, ownerSessionId, runId);
	return parsed ? parentPidFromMarker(parsed) : undefined;
}

export type OrchestrateActiveMarkerParentState =
	| { kind: "absent" }
	| { kind: "present"; pid: number }
	| { kind: "unknown" };

/** Distinguish terminal marker removal from an unreadable or malformed owner slot. */
export function readOrchestrateActiveMarkerParentState(
	agentDir: string,
	ownerSessionId: string | undefined,
	runId: string,
): OrchestrateActiveMarkerParentState {
	if (!ownerSessionId || !isSafeRunId(runId)) return { kind: "unknown" };
	const file = path.join(resolveOrchestrateActiveOwnerDir(agentDir, ownerSessionId), `${runId}.json`);
	try {
		fs.statSync(file);
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" };
	}
	const pid = readOrchestrateActiveMarkerParentPid(agentDir, ownerSessionId, runId);
	return pid === undefined ? { kind: "unknown" } : { kind: "present", pid };
}

export type OrchestrateActiveMarkerProcessState =
	| { kind: "absent" }
	| { kind: "present"; ownerPid: number; runnerPid: number }
	| { kind: "unknown" };

/** Read distinct owner and runner identities; any partial or torn marker fails closed. */
export function readOrchestrateActiveMarkerProcessState(
	agentDir: string,
	ownerSessionId: string | undefined,
	runId: string,
): OrchestrateActiveMarkerProcessState {
	if (!ownerSessionId || !isSafeRunId(runId)) return { kind: "unknown" };
	const file = path.join(resolveOrchestrateActiveOwnerDir(agentDir, ownerSessionId), `${runId}.json`);
	try {
		fs.statSync(file);
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unknown" };
	}
	const parsed = readOrchestrateActiveMarkerRecord(agentDir, ownerSessionId, runId);
	if (!parsed) return { kind: "unknown" };
	const ownerPid = parentPidFromMarker(parsed);
	const runnerPid = runnerPidFromMarker(parsed);
	return ownerPid === undefined || runnerPid === undefined
		? { kind: "unknown" }
		: { kind: "present", ownerPid, runnerPid };
}

/** Idempotently remove the status-only active marker at terminal/spawn failure. */
export function deleteOrchestrateActiveMarker(cfg: Pick<OrchestrateCfg, "agentDir" | "ownerSessionId" | "runId">): void {
	if (!cfg.ownerSessionId || !isSafeRunId(cfg.runId)) return;
	try {
		fs.unlinkSync(
			path.join(resolveOrchestrateActiveOwnerDir(cfg.agentDir, cfg.ownerSessionId), `${cfg.runId}.json`),
		);
	} catch {
		// Cleanup is best-effort and idempotent; cfg/result records retain truth.
	}
}

/**
 * Reap a marker when only durable terminal proof + the cfg path remain.
 * The cfg is the authoritative non-secret owner record after the runner has
 * already deleted its secret-bearing route. Never trust a result envelope's
 * run/owner fields for marker deletion.
 */
export function deleteOrchestrateActiveMarkerForRun(agentDir: string, runId: string): void {
	if (!isSafeRunId(runId)) return;
	try {
		const cfgFile = path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`);
		const parsed = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as {
			runId?: unknown;
			ownerSessionId?: unknown;
		};
		if (parsed.runId !== runId || typeof parsed.ownerSessionId !== "string") return;
		deleteOrchestrateActiveMarker({ agentDir, runId, ownerSessionId: parsed.ownerSessionId });
	} catch {
		/* best-effort; status refresh remains the stale-marker backstop */
	}
}

/**
 * Dir holding completed-but-undelivered results (hydrate-and-deliver). A child
 * that finishes while the foreground is gone leaves a copy here; the next
 * `session_start` scans + delivers + consumes them. [decision:
 * foreground-exit-hydrate-and-deliver]
 */
export function resolveOrchestratePendingDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "pending");
}

/**
 * Dir holding per-run childlogs. Sits alongside cfg / results / pending /
 * routes so the on-disk orchestrate layout stays defined in one place.
 */
export function resolveOrchestrateLogsDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "logs");
}

/** The per-run terminal result file the child writes to. */
export function resolveResultFile(agentDir: string, runId: string): string {
	// Path-traversal guard (MR !2 review finding #1): runId may be tool-supplied.
	if (!isSafeRunId(runId)) {
		throw new Error(`unsafe runId rejected (path-traversal guard): ${JSON.stringify(runId)}`);
	}
	return path.join(resolveOrchestrateResultsDir(agentDir), `${runId}.json`);
}

/** The per-run pending (undelivered) result file. */
export function resolvePendingFile(agentDir: string, runId: string): string {
	// Path-traversal guard (MR !2 review finding #1): runId may be tool-supplied.
	if (!isSafeRunId(runId)) {
		throw new Error(`unsafe runId rejected (path-traversal guard): ${JSON.stringify(runId)}`);
	}
	return path.join(resolveOrchestratePendingDir(agentDir), `${runId}.json`);
}

// ── Cfg contract (parent → child, via tmp JSON file) ─────────────────────────

/**
 * The public mode carried by the detached driver transport. `orchestrate` is
 * accepted only when reading records written by older releases.
 */
export type DetachedRunMode = "driver" | "orchestrate";

/** Durable locator for a driver hosted by pi-daemon. The daemon's pi file remains authoritative. */
export interface DaemonRunLocator {
	daemonSessionId: string;
	promptId: string;
	idempotencyKey: string;
	cursor: Cursor;
	generation: number;
}

/** Pre-acceptance identity persisted before prompting, closing the accepted-before-locator crash window. */
export interface DaemonPendingLaunchRecord {
	daemonSessionId: string;
	idempotencyKey: string;
	cursor: Cursor;
}

/** Non-secret endpoint fields needed to reconnect after the originating process exits. */
export interface DaemonConnectionRecord {
	socketPath?: string;
	stateDir?: string;
	agentDir?: string;
}

/**
 * Trusted owner transport for the delegate-owned pi child. This is populated
 * from the internal OrchestrateCfg, after public env overrides are applied;
 * it is not part of caller-controlled cfg.env or detached lineage.
 */
export const ORCHESTRATE_OWNER_SESSION_ENV = "PI_DELEGATE_OWNER_SESSION_ID";

/**
 * Everything a detached child needs to boot a session and run the hosted
 * agent's task to terminal. Self-contained: the child process shares NO
 * in-memory parent state, so identity + discovery roots + result/pending
 * destinations all travel through this JSON.
 *
 * NOTE (node A scope): lineage / derived-key cap inheritance is NOT carried
 * here yet — that is node B (`orchestrate-shape-and-lineage`). Node A proves
 * the boot + result round-trip in isolation.
 */
export interface OrchestrateCfg {
	/** Canonical mode on new records; `orchestrate` is a legacy read spelling. */
	mode?: DetachedRunMode;
	/** This run's id (filesystem-safe). Keys the result + pending files. */
	runId: string;
	/** Root-of-tree run id (equals runId for a top-level orchestrate). */
	rootRunId: string;
	/**
	 * Wall-clock dispatch time (ms epoch). Optional only for backward
	 * compatibility with cfg records written before issue #53; the spawn helper
	 * stamps every new record before launching the detached runner.
	 */
	startedAt?: number;
	/**
	 * Non-secret foreground owner id used for owner-scoped status enumeration
	 * after the secret-bearing control route is deleted at terminal.
	 */
	ownerSessionId?: string;
	/** PID of the foreground process that owned this run at dispatch time. */
	ownerPid?: number;
	/** Process nonce paired with ownerPid to protect against PID reuse. */
	ownerNonce?: string;
	/** Working dir for project-local discovery (where the child boots). */
	cwd: string;
	/** Global config dir (`~/.pi/agent`) for auth/models/session discovery. */
	agentDir: string;
	/**
	 * Public, signed lineage fields required to restart a runner after its
	 * replaceable runtime exits. The Ed25519 private key
	 * is discarded at dispatch; these verify-only values are safe to persist.
	 */
	restartLineageEnv?: Record<string, string>;
	/** Number of replacement runners already launched (max one). */
	restartAttempts?: number;
	/** Invocation/agent env cannot be persisted safely; such runs fail closed. */
	restartBlockedByTransportEnv?: boolean;
	/** The hosted agent's initial task / prompt. */
	task: string;
	/** Validated handoff task seed, retained for replacement/recovery. */
	tasks?: TasksSeed;
	/** Hosted agent label (diagnostic + result envelope). */
	agentName: string;
	/** Canonical name of the single driver entry; absent only on legacy cfg records. */
	entryName?: string;
	/** Caller environment patch; values are not included in result envelopes. */
	env?: EnvOverrides;
	/** Optional model ref ("provider/id"); omitted → session default. */
	model?: string;
	/** Present on new detached drivers hosted by pi-daemon rather than a runner process. */
	daemonLocator?: DaemonRunLocator;
	/** Present only until accepted prompt identity has been promoted to daemonLocator. */
	daemonPendingLaunch?: DaemonPendingLaunchRecord;
	/** Reconnection coordinates kept separate so the locator stays the five-field spec shape. */
	daemonConnection?: DaemonConnectionRecord;
	/** Optional initial thinking level passed through to the session. */
	thinking?: ThinkingLevel;
	/** Optional session-local adaptive-thinking lower bound. */
	thinkingMin?: ThinkingLevel;
	/** Optional session-local adaptive-thinking upper bound. */
	thinkingMax?: ThinkingLevel;
	/** Agent body → resource-loader systemPrompt. */
	systemPrompt?: string;
	/** "replace" | "append" — how systemPrompt composes (default "append"). */
	systemPromptMode?: "replace" | "append";
	/** Load project context files in the child (the make-or-break for graft). */
	inheritProjectContext: boolean;
	/** Load skills in the child (the make-or-break for graft). */
	inheritSkills: boolean;
	/** Explicit skill allowlist; empty/undefined → base set per inheritSkills. */
	skills?: string[];
	/** Extra extension paths to load in the child (graft ext, test ext). */
	extensions?: string[];
	/** Portable extension selectors to require, when configured on the agent. */
	extensionInclude?: string[];
	/** Portable extension selectors to remove, when configured on the agent. */
	extensionExclude?: string[];
	/** Builtin/exact custom-tool allowlist for the child session; undefined → defaults. */
	tools?: string[];
	/**
	 * Whether the caller explicitly declared its tool allowlist before the
	 * foreground materialized hosted defaults into `tools`. New writers always
	 * set this; ambiguous old records without selectors retain pre-floor behavior.
	 */
	hasExplicitAllowlist?: boolean;
	/**
	 * Parsed exact extension-tool requests carried across the process boundary.
	 * When present, the child also receives the versioned live-scope envelope
	 * through its spawn environment instead of a static `--tools` snapshot.
	 */
	extensionToolSelectors?: ExtSelector[];
	/** Trusted global-only selector identities derived from the coordinator's resolved surface. */
	optionalGlobalExtensionSelectorKeys?: string[];
	/** Internal: selected paths already contain the delegate extension owner. */
	delegateSelfAlreadySelected?: boolean;
	/** Absolute path the child writes its terminal result to. */
	resultFile: string;
	/** Absolute path the child ALSO copies its result to for hydrate-deliver. */
	pendingFile: string;
	/**
	 * Boot-proof mode (OFFLINE self-test, spec 0007): when true the child boots
	 * a real in-process session + loads extensions but does NOT spawn the pi CLI
	 * subprocess or call a model — it writes a `done` result documenting that the
	 * session booted. Retained as a deterministic offline self-test; it is NO
	 * LONGER the production hosted-agent run path (that is the `pi --mode json`
	 * subprocess). [decision: bootproof-kept-as-offline-selftest]
	 */
	bootProofOnly?: boolean;
	/**
	 * TEST-ONLY seam (spec 0007 / REQ-PICLI-8): override the pi CLI spawn command
	 * the production path resolves via `getPiSpawnCommand`. When set, the runner
	 * spawns `[program, ...prefixArgs, ...piArgs]` instead of the resolved pi
	 * binary, so the live e2e test can substitute a faithful stub that emits a
	 * canned `--mode json` stream + writes a proof artifact — exercising the REAL
	 * spawn + stream-parse + terminal-classify path end-to-end. Undefined in
	 * production. [decision: failed-not-silent-empty-done]
	 */
	piSpawnOverride?: { program: string; prefixArgs?: string[] };
}

/** Narrow, non-secret identity projection of a prompt-bearing cfg record. */
export interface OrchestrateCfgIdentity {
	runId: string;
	rootRunId: string;
	ownerSessionId?: string;
	ownerPid?: number;
	ownerNonce?: string;
	agentName?: string;
}

export type OrchestrateCfgOwnerEvidence =
	| { kind: "unowned" }
	| { kind: "owned"; ownerSessionId: string; ownerPid?: number; ownerNonce?: string }
	| { kind: "unknown" };

/**
 * Read only the cfg identity fields needed by status/recovery code. Callers do
 * not receive the task, system prompt, model configuration, or result paths.
 */
export function readOrchestrateCfgIdentity(
	agentDir: string,
	runId: string,
): OrchestrateCfgIdentity | undefined {
	if (!isSafeRunId(runId)) return undefined;
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`), "utf8"),
		) as Partial<OrchestrateCfg>;
		if (
			parsed.runId !== runId ||
			typeof parsed.rootRunId !== "string" ||
			!isSafeRunId(parsed.rootRunId)
		) {
			return undefined;
		}
		return {
			runId,
			rootRunId: parsed.rootRunId,
			...(typeof parsed.ownerSessionId === "string" && parsed.ownerSessionId.length > 0
				? { ownerSessionId: parsed.ownerSessionId }
				: {}),
			...(Number.isInteger(parsed.ownerPid) && parsed.ownerPid > 0
				? { ownerPid: parsed.ownerPid }
				: {}),
			...(typeof parsed.ownerNonce === "string" && parsed.ownerNonce.length > 0
				? { ownerNonce: parsed.ownerNonce }
				: {}),
			...(typeof parsed.agentName === "string" ? { agentName: parsed.agentName } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Read the durable ownership evidence that remains after terminal cleanup.
 * Missing cfg means an unowned legacy result; malformed cfg or incomplete
 * evidence is unknown and must never authorize adoption by a sibling.
 */
export function readOrchestrateCfgOwnerEvidence(
	agentDir: string,
	runId: string,
): OrchestrateCfgOwnerEvidence {
	const durable = readOrchestrateOwnerEvidence(agentDir, runId);
	if (durable.kind === "unknown") return { kind: "unknown" };
	if (durable.kind === "present") {
		return {
			kind: "owned",
			ownerSessionId: durable.evidence.ownerSessionId,
			ownerPid: durable.evidence.ownerPid,
			ownerNonce: durable.evidence.ownerNonce,
		};
	}
	if (!isSafeRunId(runId)) return { kind: "unknown" };
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`), "utf8"),
		) as Partial<OrchestrateCfg>;
		if (
			parsed.runId !== runId ||
			typeof parsed.rootRunId !== "string" ||
			!isSafeRunId(parsed.rootRunId)
		) return { kind: "unknown" };
		if (parsed.ownerSessionId === undefined) return { kind: "unowned" };
		if (!validOwnerSessionId(parsed.ownerSessionId)) return { kind: "unknown" };
		const hasPid = parsed.ownerPid !== undefined;
		const hasNonce = parsed.ownerNonce !== undefined;
		if (hasPid !== hasNonce) return { kind: "unknown" };
		if (hasPid && (
			!Number.isInteger(parsed.ownerPid) ||
			(parsed.ownerPid as number) <= 0 ||
			!validOwnerNonce(parsed.ownerNonce)
		)) return { kind: "unknown" };
		return {
			kind: "owned",
			ownerSessionId: parsed.ownerSessionId,
			...(hasPid ? { ownerPid: parsed.ownerPid, ownerNonce: parsed.ownerNonce } : {}),
		};
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "unowned" } : { kind: "unknown" };
	}
}

/** Recover a legacy owner id from a still-readable active marker when cfg is gone. */
export function readOrchestrateActiveMarkerOwner(
	agentDir: string,
	runId: string,
): OrchestrateCfgOwnerEvidence {
	if (!isSafeRunId(runId)) return { kind: "unknown" };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(resolveOrchestrateActiveDir(agentDir), { withFileTypes: true });
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "unowned" } : { kind: "unknown" };
	}
	let found: OrchestrateCfgOwnerEvidence | undefined;
	let inspected = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (++inspected > 1024) return { kind: "unknown" };
		const ownerDir = path.join(resolveOrchestrateActiveDir(agentDir), entry.name);
		const marker = path.join(ownerDir, `${runId}.json`);
		try {
			const stat = fs.statSync(marker);
			if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ACTIVE_MARKER_BYTES) return { kind: "unknown" };
			const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as Partial<OrchestrateActiveMarker>;
			if (
				parsed.runId !== runId ||
				!validOwnerSessionId(parsed.ownerSessionId) ||
				entry.name !== orchestrateOwnerKey(parsed.ownerSessionId)
			) return { kind: "unknown" };
			const parentPid = parentPidFromMarker(parsed);
			const candidate: OrchestrateCfgOwnerEvidence = {
				kind: "owned",
				ownerSessionId: parsed.ownerSessionId,
				...(parentPid === undefined ? {} : { ownerPid: parentPid }),
			};
			if (found) return { kind: "unknown" };
			found = candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "unknown" };
		}
	}
	return found ?? { kind: "unowned" };
}

/** Read the full owner-only cfg for bounded runner recovery. */
export function readOrchestrateCfg(
	agentDir: string,
	runId: string,
): OrchestrateCfg | undefined {
	if (!isSafeRunId(runId)) return undefined;
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`), "utf8"),
		) as Partial<OrchestrateCfg>;
		if (
			parsed.runId !== runId ||
			typeof parsed.rootRunId !== "string" ||
			!isSafeRunId(parsed.rootRunId) ||
			typeof parsed.cwd !== "string" ||
			parsed.agentDir !== agentDir ||
			typeof parsed.task !== "string" ||
			typeof parsed.agentName !== "string" ||
			typeof parsed.inheritProjectContext !== "boolean" ||
			typeof parsed.inheritSkills !== "boolean" ||
			parsed.resultFile !== resolveResultFile(agentDir, runId) ||
			parsed.pendingFile !== resolvePendingFile(agentDir, runId) ||
			(parsed.restartLineageEnv !== undefined &&
				(typeof parsed.restartLineageEnv !== "object" ||
					parsed.restartLineageEnv === null ||
					Array.isArray(parsed.restartLineageEnv) ||
					Object.values(parsed.restartLineageEnv).some((value) => typeof value !== "string"))) ||
			(parsed.restartBlockedByTransportEnv !== undefined &&
				typeof parsed.restartBlockedByTransportEnv !== "boolean") ||
			(parsed.restartAttempts !== undefined &&
				(!Number.isInteger(parsed.restartAttempts) || parsed.restartAttempts < 0))
		) {
			return undefined;
		}
		if (parsed.tasks !== undefined) {
			try {
				assertValidTasksSeed(parsed.tasks);
			} catch {
				return undefined;
			}
		}
		return parsed as OrchestrateCfg;
	} catch {
		return undefined;
	}
}

// ── Result contract (child → parent, terminal file) ──────────────────────────

export interface OrchestrateUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost: number;
}

/** A successful orchestrate run. `output` is the collapsed terminal text. */
export interface OrchestrateResultDone {
	/** Canonical mode on new wire writes; old records may omit it or say orchestrate. */
	mode?: DetachedRunMode;
	status: "done";
	runId: string;
	agentName: string;
	output: string;
	/** Token/cost usage scraped from the child pi RPC stream, when available. */
	usage?: OrchestrateUsage;
	/** Mechanical task state captured from the authoritative child session. */
	taskLedger?: TaskLedger;
	/** Proof the child actually booted a session (sessionFile path / marker). */
	bootProof?: OrchestrateBootProof;
	finishedAt: string;
}

export type OrchestrateRecoveryStage =
	| "pre-event"
	| "boot"
	| "running"
	| "cancel-wind-down"
	| "terminal"
	| "unknown";

/**
 * Privacy-safe provenance for a detached runner that died before writing its
 * own terminal record. Values are fixed categories / bounded scalars only;
 * prompts, control credentials, child stderr, and model output never enter the
 * persisted result.
 */
export interface OrchestrateRecoveryDiagnostic {
	reason: "runner-exited";
	source: "maintenance-reconciliation";
	runnerPid: number;
	stage: OrchestrateRecoveryStage;
	lastActivityAt?: number;
	stderrCapture: "present" | "absent";
	exitCode: "unknown";
	signal: "unknown";
}

/** A clean (non-crash) failure, or a durably reconciled abrupt runner exit. */
export interface OrchestrateResultFailed {
	/** Canonical mode on new wire writes; old records may omit it or say orchestrate. */
	mode?: DetachedRunMode;
	status: "failed";
	runId: string;
	agentName: string;
	error: string;
	/** Fixed-category provenance for an externally reconciled abrupt exit. */
	recovery?: OrchestrateRecoveryDiagnostic;
	/** Token/cost usage scraped from the child pi RPC stream before failure, when available. */
	usage?: OrchestrateUsage;
	/** Mechanical task state captured before the authoritative child failed. */
	taskLedger?: TaskLedger;
	/** Present when the child booted before failing. */
	bootProof?: OrchestrateBootProof;
	finishedAt: string;
}

export type OrchestrateResult = OrchestrateResultDone | OrchestrateResultFailed;

/** What the child captured at boot — evidence the session machinery ran. */
export interface OrchestrateBootProof {
	booted: true;
	sessionFile: string | null;
	/** Effective level after every extension's session_start handler has run. */
	thinkingLevel?: ThinkingLevel;
	/** Exact active tool names in the offline boot-proof session. */
	activeToolNames?: string[];
	/** Count of extensions the loader discovered/loaded in the child. */
	extensionsLoaded: number;
	/** Loader/extension errors surfaced at boot (best-effort). */
	extensionErrors: string[];
}

/**
 * The three states the parent distinguishes when reading a detached outcome.
 * `absent` is NOT written by anyone — it is the file's non-existence, which a
 * crash / OOM leaves behind until foreground maintenance durably reconciles it
 * to `failed`. [decision: child-crash-vs-clean-failure]
 */
export type ResultFileState =
	| { state: "absent" }
	| { state: "done"; result: OrchestrateResultDone }
	| { state: "failed"; result: OrchestrateResultFailed };

function sanitizeResultTaskLedger(result: OrchestrateResultDone): OrchestrateResultDone;
function sanitizeResultTaskLedger(result: OrchestrateResultFailed): OrchestrateResultFailed;
function sanitizeResultTaskLedger(result: OrchestrateResult): OrchestrateResult {
	if (result.taskLedger === undefined) return result;
	const sanitized = { ...result };
	delete sanitized.taskLedger;
	const taskLedger = parseTaskLedger(result.taskLedger);
	return taskLedger === undefined ? sanitized : { ...sanitized, taskLedger };
}

/**
 * Parse a terminal result file into its state. Missing file → `absent`. A file
 * that exists but is malformed / unparseable is treated as a clean `failed`
 * (the child wrote *something* terminal, just not well-formed) rather than
 * `absent` — absence is reserved strictly for "never wrote".
 */
export function readResultFile(resultFile: string): ResultFileState {
	let raw: string;
	try {
		raw = fs.readFileSync(resultFile, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { state: "absent" };
		}
		// Unreadable for another reason — treat as a clean failure so the
		// parent surfaces it instead of silently mistaking it for a crash.
		return {
			state: "failed",
			result: synthFailed("(unknown)", "(unknown)", `result file unreadable: ${(err as Error)?.message ?? err}`),
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			state: "failed",
			result: synthFailed("(unknown)", "(unknown)", `result file malformed JSON: ${(err as Error)?.message ?? err}`),
		};
	}
	const obj = parsed as Partial<OrchestrateResult> | null;
	if (!obj || typeof obj !== "object") {
		return {
			state: "failed",
			result: synthFailed("(unknown)", "(unknown)", "result file is not an object"),
		};
	}
	if (obj.status === "done") {
		return { state: "done", result: sanitizeResultTaskLedger(obj as OrchestrateResultDone) };
	}
	if (obj.status === "failed") {
		return { state: "failed", result: sanitizeResultTaskLedger(obj as OrchestrateResultFailed) };
	}
	return {
		state: "failed",
		result: synthFailed(
			(obj as any).runId ?? "(unknown)",
			(obj as any).agentName ?? "(unknown)",
			`result file has unknown status ${JSON.stringify((obj as any).status)}`,
		),
	};
}

/** Build a synthesized `failed` result (crash / malformed / unreadable). */
export function synthFailed(runId: string, agentName: string, error: string): OrchestrateResultFailed {
	return {
		mode: "driver",
		status: "failed",
		runId,
		agentName,
		error,
		finishedAt: new Date().toISOString(),
	};
}

// ── pid-liveness probe (shared crash-detection primitive) ────────────────────
//
// The crash reaper needs the SAME signal-0 liveness semantics the event-bus
// uses for detached-descendant detection (spec 0004,
// `[decision: child-crash-detection-pid-plus-timeout]`). The canonical probe
// now lives in `event-bus.ts` (node C fold-in promoted it to an export); we
// re-export it here so existing importers of `detached-spawn`'s `pidAlive`
// keep working without a second copy of the logic.
export { pidAlive };

/**
 * Fold a child's on-disk outcome + liveness into a single terminal result
 * (REQ-ORCH-6 / [decision: child-crash-vs-clean-failure]):
 *
 *   - file present (`done` / `failed`)  → that result, with `taskLedger` projected onto its bounded shape.
 *   - file absent + no pid                 → `null` (unknown; do not probe).
 *   - file absent + pid ALIVE           → `null` (still running; not terminal).
 *   - file absent + pid DEAD            → synthesized crash `failed`.
 *
 * `pidAliveFn` is injectable so a unit test can drive the dead-pid branch
 * without spawning a real process.
 */
export function reapResult(args: {
	resultFile: string;
	pid?: number;
	runId: string;
	agentName: string;
	pidAliveFn?: (pid: number) => boolean;
}): OrchestrateResult | null {
	const fileState = readResultFile(args.resultFile);
	if (fileState.state !== "absent") return fileState.result;
	if (args.pid === undefined) return null;
	const alive = (args.pidAliveFn ?? pidAlive)(args.pid);
	if (alive) return null;
	return synthFailed(
		args.runId,
		args.agentName,
		`child process pid=${args.pid} exited without writing a result (crash / OOM)`,
	);
}

// ── Hydrate-and-deliver ──────────────────────────────────────────────────────

/** A pending (completed-but-undelivered) result + its source file. */
export interface PendingResult {
	file: string;
	/** Safe run id derived from the pending filename, not the untrusted envelope. */
	runId?: string;
	result: OrchestrateResult;
}

/**
 * Scan the pending-results dir for completed-but-undelivered results. Returns
 * every well-formed result so `session_start` can deliver them (REQ-ORCH-6:
 * delivery reads the FILE — no captured in-process `pi` ctx). Malformed /
 * unreadable entries are skipped (best-effort). Missing dir → `[]`.
 */
export function scanPendingResults(agentDir: string): PendingResult[] {
	const dir = resolveOrchestratePendingDir(agentDir);
	let entries: string[];
	try {
		sweepStaleClaims(dir);
		entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		return [];
	}
	const out: PendingResult[] = [];
	for (const name of entries) {
		const runId = name.slice(0, -".json".length);
		if (!isSafeRunId(runId)) continue;
		const file = path.join(dir, name);
		const st = readResultFile(file);
		if (st.state === "absent") continue;
		out.push({ file, runId, result: st.result });
	}
	return out;
}

/**
 * Remove a delivered pending result claim. Returns true only when this call
 * unlinked the claimed path. An absent claim may have been restored to its
 * pending name by stale-claim recovery, so absence alone is not consumption
 * proof and must not authorize deletion of related owner evidence.
 */
export function consumePendingResult(file: string): boolean {
	try {
		fs.rmSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * A claim older than this is considered abandoned (its claimant crashed
 * between claim and consume) and is recovered by `sweepStaleClaims`.
 */
export const STALE_CLAIM_MS = 60_000;

/**
 * Recover STALE claims in a pending dir (MR !2 review finding #6). A
 * `.json.delivered` file is a claim taken by `claimPendingResult` whose owner
 * crashed between claim and consume. Rename it back after STALE_CLAIM_MS so
 * the entry is redelivered (at-least-once) instead of stranded (lost). A
 * FRESH claim is left alone — its owner is mid-send.
 *
 * Shared by the orchestrate pending-results scan and the dispatch
 * pending-wakes scan (issue #2 — `src/pending-wakes.ts`), which use the same
 * rename-based claim discipline. Claim age is the claimed file's mtime, which
 * `claimPendingResult` refreshes before its atomic rename. Throws ENOENT through
 * to the caller (both scanners treat a missing dir as "nothing pending");
 * per-entry recovery failures are swallowed (retried next scan).
 */
export function sweepStaleClaims(dir: string): void {
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".json.delivered")) continue;
		const claimed = path.join(dir, name);
		try {
			if (Date.now() - fs.statSync(claimed).mtimeMs > STALE_CLAIM_MS) {
				fs.renameSync(claimed, claimed.slice(0, -".delivered".length));
			}
		} catch {
			/* best-effort recovery; retried next scan */
		}
	}
}

/**
 * Atomically CLAIM a pending result before delivering it (MR !2 review
 * finding #6). Two pi sessions sharing an agentDir can both scan the same
 * pending file; without a claim both would deliver (duplicate wake) before
 * the rm. `renameSync` is atomic on POSIX, so exactly one claimant wins:
 * the winner gets the claimed path back, the loser gets `undefined` and must
 * skip. On a successful send the claimant calls `consumePendingResult(claimed)`;
 * on a send failure it calls `unclaimPendingResult(claimed)` so the result is
 * retried next start. A claimant that crashes mid-window is recovered by the
 * stale-claim sweep in `scanPendingResults` (at-least-once, never lost).
 *
 * Refresh the source mtime BEFORE rename so an old pending file cannot appear
 * as an old claim the instant it becomes visible. There is no rename-to-touch
 * window for a second scanner to sweep; if another claimant wins between the
 * touch and rename, its claim inherits the same fresh acquisition timestamp.
 */
export function claimPendingResult(file: string): string | undefined {
	const claimed = `${file}.delivered`;
	try {
		const acquiredAt = new Date();
		fs.utimesSync(file, acquiredAt, acquiredAt);
		fs.renameSync(file, claimed);
		return claimed;
	} catch {
		return undefined;
	}
}

/** Release a claim taken by `claimPendingResult` (delivery failed; retry later). */
export function unclaimPendingResult(claimed: string): void {
	try {
		fs.renameSync(claimed, claimed.replace(/\.delivered$/, ""));
	} catch {
		/* best-effort; the stale-claim sweep is the backstop */
	}
}

// ── Detached spawn ───────────────────────────────────────────────────────────

/**
 * PURE path resolver for the COMPILED runner entrypoint
 * (`dist/orchestrate-runner.js`), given the directory THIS module lives in.
 * Split out from `resolveRunnerPath` so the branch logic is unit-testable with
 * synthetic dir strings (no `import.meta.url` read).
 *
 * The detached child runs under BARE `node` (no tsx loader), so the runner path
 * MUST point at a compiled `.js`, never a `.ts`. pi loads this extension from
 * `src/index.ts` (`package.json` `pi.extensions = ["./src/index.ts"]`), so when
 * the module dir basename is `src` the COMPILED runner lives in the SIBLING
 * `dist/` dir — `src/orchestrate-runner.js` does NOT exist (only the `.ts`),
 * which is what caused the detached child's instant `MODULE_NOT_FOUND`.
 *
 *   - non-empty `override`            → returned unchanged (REQ-RUNPATH-3).
 *   - module dir basename === `src`   → `<parent>/dist/orchestrate-runner.js`
 *                                       (REQ-RUNPATH-1). [decision:
 *                                       map-src-to-dist-sibling]
 *   - otherwise (already `dist/` etc.) → `<hereDir>/orchestrate-runner.js`
 *                                       (REQ-RUNPATH-2, the unchanged
 *                                       compiled-deploy sibling path).
 */
export function resolveRunnerFromModuleDir(hereDir: string, override?: string): string {
	if (override) return override;
	if (path.basename(hereDir) === "src") {
		return path.join(path.dirname(hereDir), "dist", "orchestrate-runner.js");
	}
	return path.join(hereDir, "orchestrate-runner.js");
}

/**
 * Resolve the COMPILED runner entrypoint (`dist/orchestrate-runner.js`)
 * relative to THIS module's own location, so the spawned child runs the built
 * artifact — works from `dist/detached-spawn.js` (production sibling) AND from
 * `src/detached-spawn.ts` (pi's src-load path, mapped to the `dist/` sibling),
 * and is overridable in tests via `runnerOverride`. Delegates the branch logic
 * to the pure `resolveRunnerFromModuleDir` helper. [decision:
 * testable-pure-helper]
 */
export function resolveRunnerPath(runnerOverride?: string): string {
	const hereDir = path.dirname(fileURLToPath(import.meta.url));
	return resolveRunnerFromModuleDir(hereDir, runnerOverride);
}

export interface SpawnDetachedResult {
	pid: number;
	cfgPath: string;
	runnerPath: string;
}

/**
 * Resolve the child's stdio option and create its always-on per-run childlog.
 * `PI_DELEGATE_DEBUG=1` is intentionally independent of capture: it only
 * raises childlog verbosity (the structured writer records raw RPC frames in
 * that mode) and keeps the event-bus diagnostics echo semantics unchanged.
 * A logfile failure falls back to `ignore`; it can never fail or delay spawn.
 */
export function resolveChildStdio(
	agentDir: string,
	runId: string,
	_forceCapture = false,
	now: () => number = Date.now,
): { stdio: "ignore" | ["ignore", number, number]; fd?: number } {
	try {
		const opened = openChildLogFd(resolveOrchestrateLogsDir(agentDir), runId, now);
		if (!opened) return { stdio: "ignore" };
		return { stdio: ["ignore", opened.fd, opened.fd], fd: opened.fd };
	} catch {
		// Best-effort: a logfile failure must NEVER fail the spawn.
		return { stdio: "ignore" };
	}
}

/**
 * Write the cfg to a tmp file and spawn the compiled runner as a DETACHED
 * child process that outlives the foreground (REQ-ORCH-1 / REQ-ORCH-2):
 * `spawn(process.execPath, [runnerJs, cfgPath], { detached:true,
 * stdio:'ignore' }).unref()`. Returns the child's pid (+ resolved paths for
 * diagnostics / the reaper).
 *
 * The detached child is NOT registered in the foreground's in-memory `runs`
 * map and is NOT touched by `abortAllRuns()` on `session_shutdown` — it is a
 * separate OS process, immune to foreground reload / rotate / compact / quit.
 */
export function spawnDetachedOrchestrate(
	cfg: OrchestrateCfg,
	opts: { runnerOverride?: string; execPath?: string; captureStdio?: boolean } = {},
): SpawnDetachedResult {
	// Validate the structured transport before any cfg, owner, or child artifact
	// is created. Recovery reuses this same barrier, so malformed persisted data
	// cannot turn into a replacement process with a missing or partial seed.
	if (cfg.tasks !== undefined) assertValidTasksSeed(cfg.tasks);
	// Issue #8 — the cfg carries the user's full task prompt (and the result/
	// pending files the child writes carry its output): keep the whole
	// substrate private. Same pattern as `writeRouteRecord`: mode on create,
	// chmod re-assert because mkdir/write modes are umask-masked and only
	// honoured on CREATE (a dir minted earlier under a permissive umask keeps
	// its old mode through mkdirSync).
	const cfgDir = resolveOrchestrateCfgDir(cfg.agentDir);
	fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(cfgDir, 0o700);
	// Pre-create result + pending dirs so the child never races on mkdir and
	// the reaper can stat the result file the instant the child is spawned.
	for (const dir of [
		resolveOrchestrateResultsDir(cfg.agentDir),
		resolveOrchestratePendingDir(cfg.agentDir),
	]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
	}

	const cfgPath = path.join(cfgDir, `${cfg.runId}.cfg.json`);
	// Issue #53: the cfg is the durable creation record for a detached run.
	// Stamp it BEFORE spawn so status survives foreground reloads and can report
	// true wall-clock elapsed time even before the first event-bus heartbeat.
	// Keep the input type optional so older fixtures/callers remain compatible.
	// Environment overrides are transport-only: the child receives them through
	// spawn({env}), but they must never be written into the durable cfg record.
	const { env: _env, ...cfgWithoutEnv } = cfg;
	const persistedCfg: OrchestrateCfg = {
		...cfgWithoutEnv,
		// New cfg writes use the canonical public mode even when an older caller
		// still supplies the legacy transport spelling.
		mode: "driver",
		startedAt:
			typeof cfg.startedAt === "number" && Number.isFinite(cfg.startedAt)
				? cfg.startedAt
				: Date.now(),
	};
	fs.writeFileSync(cfgPath, JSON.stringify(persistedCfg, null, 2), { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(cfgPath, 0o600);
	try {
		// Ownership evidence is the non-secret recovery authority after terminal
		// cleanup removes the route and active marker. Publish it before the marker
		// and before spawn so every started run is either fully attributable or not
		// started at all.
		writeOrchestrateOwnerEvidence(persistedCfg);
		writeOrchestrateActiveMarker(persistedCfg);
	} catch (err) {
		deleteOrchestrateOwnerEvidence(persistedCfg.agentDir, persistedCfg.runId);
		try {
			fs.rmSync(cfgPath, { force: true });
		} catch {
			/* best-effort rollback; preserve the marker-creation error */
		}
		throw err;
	}
	const cleanupRejectedSpawn = (): void => {
		deleteOrchestrateActiveMarker(persistedCfg);
		deleteOrchestrateOwnerEvidence(persistedCfg.agentDir, persistedCfg.runId);
		try {
			fs.rmSync(cfgPath, { force: true });
		} catch {
			/* best-effort: a rejected spawn must not leave a cfg-only ghost */
		}
	};

	const runnerPath = resolveRunnerPath(opts.runnerOverride);
	const execPath = opts.execPath ?? process.execPath;

	// Spec 0011: default stays `stdio:'ignore'`; under PI_DELEGATE_DEBUG=1 the
	// child's stdout+stderr are captured to logs/<runId>.childlog (best-effort).
	const { stdio, fd } = resolveChildStdio(cfg.agentDir, cfg.runId, opts.captureStdio);

	// HARDENING (MR !2 review finding #5): `spawn` can throw SYNCHRONOUSLY
	// (e.g. ENOENT on a bad execPath); without this wrap the debug-logfile fd
	// opened above would leak on that path. Close the fd, then rethrow.
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(execPath, [runnerPath, cfgPath], {
			detached: true,
			stdio,
			// Inherit the parent env. Node B injects the serialized lineage /
			// derived-key env here; node A inherits the bare environment.
			env: materializeEnv(cfg.env),
		});
	} catch (err) {
		cleanupRejectedSpawn();
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort fd cleanup on the failure path */
			}
		}
		throw err;
	}
	if (typeof child.pid !== "number") {
		// Node reports launch failures such as ENOENT through an asynchronous
		// `error` event even though pid is already undefined synchronously. Install
		// a sink before returning the handled tool error so that event cannot crash
		// the foreground process after this function throws.
		child.once("error", () => {
			/* launch failure is already surfaced by the synchronous no-pid error */
		});
		cleanupRejectedSpawn();
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort fd cleanup on the no-pid path */
			}
		}
		throw new Error("spawnDetachedOrchestrate: child failed to start (no pid)");
	}
	// The legacy parent slot is owner identity, not runner identity. Current
	// orchestrate dispatches persist cfg.ownerPid; the fallback keeps older direct
	// callers attributable to the foreground that invoked this helper.
	stampOrchestrateActiveMarkerPid(persistedCfg, persistedCfg.ownerPid ?? process.pid);
	// Publish the detached PID in its own slot immediately, before the runner can
	// self-confirm it, so abrupt pre-boot death remains recoverable.
	stampOrchestrateActiveMarkerPid(persistedCfg, child.pid, true);
	child.unref();
	// Global childlog maintenance is opportunistic and asynchronous: it never
	// delays the spawn, and the active marker protects this run's log.
	queueMicrotask(() => {
		try {
			sweepOrchestrateChildLogs(
				resolveOrchestrateLogsDir(cfg.agentDir),
				resolveOrchestrateActiveDir(cfg.agentDir),
			);
		} catch {
			/* best-effort maintenance */
		}
	});

	// REQ-OCAP-4: the detached child inherited its own copy of the logfile fd;
	// close the PARENT's copy so it does not leak (swallow — close failure must
	// not crash the spawn). The default path holds no fd, so this is a no-op.
	if (fd !== undefined) {
		try {
			fs.closeSync(fd);
		} catch {
			/* best-effort fd cleanup */
		}
	}
	return { pid: child.pid, cfgPath, runnerPath };
}
