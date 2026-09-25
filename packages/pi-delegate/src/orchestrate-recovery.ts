/**
 * Durable reconciliation for detached orchestrate runners that disappear
 * before their own `finally` can write a terminal result (issue #54).
 *
 * The detached runner cannot report a SIGKILL/OOM after it is dead, so a live
 * foreground maintenance pass owns the outbox repair:
 *
 *   route + dead pid + no terminal result
 *     → exclusive per-run claim
 *     → atomically publish one canonical `runner-exited` result
 *     → prepare and publish one normal pending-result outbox entry
 *     → delete the secret-bearing route + status-only active marker
 *
 * The claim and prepared-payload state survive a reconciling process crash.
 * A stale claimant can resume without confusing "pending was consumed" with
 * "pending was never published": the state moves to `prepared` before the
 * prepared payload is atomically moved into the pending dir after checking for
 * a competing winner. Thus
 * `prepared + payload absent` is durable evidence that publication already
 * happened (and may already have been consumed) and must not be repeated.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	CONTROL_SECRET_ENV,
	deleteRouteRecord,
	hasOrphanControlRequestForRun,
	readRouteRecord,
	reapOrphanControlRequestsForRoot,
	resolveRouteRecordFile,
	type RouteRecord,
	verifyRouteRecordIdentity,
	writeRouteRecord,
} from "./control-route.js";
import {
	getProcessNonce,
	readProcessStartTicks,
	type ProcessIdentityDependencies,
	type ProcessIdentityEvidence,
	type ProcessIdentityVerdict,
	verifyProcessIdentity,
} from "./process-identity.js";
import {
	deleteOrchestrateActiveMarker,
	deleteOrchestrateReplacementHandoff,
	type OrchestrateCfg,
	type OrchestrateRecoveryDiagnostic,
	type OrchestrateRecoveryStage,
	type OrchestrateResult,
	type OrchestrateResultFailed,
	pidAlive,
	readOrchestrateCfg,
	readOrchestrateCfgIdentity,
	readOrchestrateOwnerEvidence,
	readOrchestrateReplacementHandoff,
	readResultFile,
	resolveOrchestrateCfgDir,
	resolveOrchestrateDir,
	resolveOrchestrateLogsDir,
	resolveOrchestratePendingDir,
	resolveOrchestrateActiveOwnerDir,
	resolveOrchestrateRoutesDir,
	resolvePendingFile,
	resolveResultFile,
	spawnDetachedOrchestrate,
	type OrchestrateReplacementHandoff,
	writeOrchestrateOwnerEvidence,
	writeOrchestrateReplacementHandoff,
} from "./detached-spawn.js";
import { resolveEventSinkDir } from "./event-bus.js";
import { LINEAGE_ENV, LINEAGE_PUBKEY_ENV } from "./lineage.js";
import {
	acquireOrchestrateRecoveryLock,
	ORCHESTRATE_RECOVERY_LOCK_STALE_MS,
	releaseOrchestrateRecoveryLock,
	type OrchestrateRecoveryLock,
	__testHooks,
} from "./orchestrate-recovery-lock.js";
import { isSafeRunId } from "./run-id.js";

export { ORCHESTRATE_RECOVERY_LOCK_STALE_MS, __testHooks } from "./orchestrate-recovery-lock.js";
export const MAX_ORCHESTRATE_RECOVERY_RUNS = 64;
const MAX_RECOVERY_EVENT_TAIL_BYTES = 128 * 1024;
const MAX_RECOVERY_AGENT_NAME_CHARS = 200;

type RecoveryPhase =
	| "claimed"
	| "prepared"
	| "requests-reaped"
	| "route-deleted"
	| "marker-deleted";

interface RecoveryState {
	version: 1 | 2 | 3;
	runId: string;
	phase: RecoveryPhase;
	createdAt: number;
	updatedAt: number;
	/** Versions 2+ persist only non-secret cleanup identity. */
	rootRunId?: string;
	ownerSessionId?: string;
	runnerPid?: number;
}

interface RecoveryCfg {
	runId: string;
	rootRunId: string;
	ownerSessionId: string;
	ownerPid?: number;
	ownerNonce?: string;
	agentName: string;
}


export interface ReconcileDeadOrchestrateRunsOptions {
	agentDir: string;
	pidAliveFn?: (pid: number) => boolean;
	/** Test seam for PID-reuse-safe Linux process identity. */
	processStartTicksFn?: (pid: number) => string | undefined;
	/** Test seam for the boot id paired with runner start ticks. */
	processBootIdFn?: () => string | undefined;
	/** Test seam for the host platform; defaults to the real OS. Non-Linux fails closed to `unproven`. */
	platformFn?: () => string;
	/** Override the shared process identity verdict function in tests. */
	verifyProcessIdentityFn?: (
		evidence: Partial<ProcessIdentityEvidence> | undefined,
		overrides?: Partial<ProcessIdentityDependencies>,
	) => ProcessIdentityVerdict;
	/** Override the local process nonce accessor used for same-pid checks. */
	processNonceFn?: () => string;
	/** @deprecated Prefer lockProcessIdentityDependencies.probePid for deterministic tests. */
	lockPidAliveFn?: (pid: number) => boolean;
	/** Test seam for deterministic lock-generation identity capture and verification. */
	lockProcessIdentityDependencies?: Partial<ProcessIdentityDependencies>;
	now?: number;
	lockStaleMs?: number;
	/** Bound work per pass; later 45-second ticks drain any remainder. */
	maxRuns?: number;
	/** Test seam for the synchronous pre-event replacement launch. */
	restartRunnerFn?: (cfg: OrchestrateCfg, route: RouteRecord) => { pid: number };
	/** Test seam for replacement handoff persistence before the launch. */
	writeReplacementHandoffFn?: (agentDir: string, handoff: OrchestrateReplacementHandoff) => void;
	/** Deterministic bound for an unresolved replacement launch gate. */
	replacementGatePasses?: number;
}

type VerifyProcessIdentityFn = NonNullable<ReconcileDeadOrchestrateRunsOptions["verifyProcessIdentityFn"]>;

export interface ReconcileDeadOrchestrateRunsResult {
	candidates: number;
	terminalized: number;
	restarted: number;
	enqueued: number;
	cleaned: number;
	live: number;
	contended: number;
	degraded: number;
	truncated: boolean;
}

function emptyResult(): ReconcileDeadOrchestrateRunsResult {
	return {
		candidates: 0,
		terminalized: 0,
		restarted: 0,
		enqueued: 0,
		cleaned: 0,
		live: 0,
		contended: 0,
		degraded: 0,
		truncated: false,
	};
}

const PROCESS_BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const PROCESS_STAT_FILE_RE = /^\/proc\/(\d+)\/stat$/;

function syntheticProcStat(startTicks: string): string {
	const fields = ["S", ...new Array(18).fill("0"), startTicks];
	return `1 (pi-delegate) ${fields.join(" ")}`;
}

function buildRecoveryProcessIdentityDependencies(args: {
	pidAliveFn: (pid: number) => boolean;
	processStartTicksFn: (pid: number) => string | undefined;
	processBootIdFn: () => string | undefined;
	platformFn: () => string;
}): Partial<ProcessIdentityDependencies> {
	const { pidAliveFn, processStartTicksFn, processBootIdFn, platformFn } = args;
	return {
		// Pass the real host platform through: the shared verifier fails closed to
		// `unproven` on non-Linux, which must reach recovery so a live non-Linux
		// runner is never treated as proven-dead and reclaimed.
		platform: platformFn,
		probePid: (pid) => {
			try {
				return pidAliveFn(pid) ? "present" : "absent";
			} catch {
				return "unproven";
			}
		},
		readFile: (file) => {
			const stat = PROCESS_STAT_FILE_RE.exec(file);
			if (stat) {
				const pid = Number.parseInt(stat[1]!, 10);
				const startTicks = processStartTicksFn(pid);
				if (startTicks === undefined) throw new Error("process stat unavailable");
				return syntheticProcStat(startTicks);
			}
			if (file === PROCESS_BOOT_ID_FILE) {
				const bootId = processBootIdFn();
				if (bootId === undefined) throw new Error("boot id unavailable");
				return `${bootId}\n`;
			}
			throw new Error(`unsupported process identity path: ${file}`);
		},
	};
}

function resolveCurrentBootId(): string | undefined {
	try {
		return fs.readFileSync(PROCESS_BOOT_ID_FILE, "utf8").trim();
	} catch {
		return undefined;
	}
}

function resolveRecoveryDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "recovery");
}

function resolveRecoveryStateFile(agentDir: string, runId: string): string {
	return path.join(resolveRecoveryDir(agentDir), `${runId}.state.json`);
}


function resolvePreparedPendingFile(agentDir: string, runId: string): string {
	return path.join(resolveRecoveryDir(agentDir), `${runId}.pending-prepared`);
}

function resolveRecoveryCursorFile(agentDir: string): string {
	return path.join(resolveRecoveryDir(agentDir), "rotation.cursor.json");
}

function ensureOwnerOnlyDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function uniqueTmp(file: string): string {
	return `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
}

/** Write a complete owner-only JSON file before atomically replacing its path. */
function writeOwnerOnlyJson(file: string, value: unknown): void {
	ensureOwnerOnlyDir(path.dirname(file));
	const tmp = uniqueTmp(file);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
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
				/* preserve the original error */
			}
		}
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
}

/**
 * Publish a complete JSON file without replacing an existing winner. A hard
 * link is the no-clobber commit point: readers can never observe the temporary
 * file while it is being written, and competing sweepers get `EEXIST`.
 */
function writeOwnerOnlyJsonOnce(file: string, value: unknown): "created" | "exists" {
	ensureOwnerOnlyDir(path.dirname(file));
	const tmp = uniqueTmp(file);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "wx", 0o600);
		fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.chmodSync(tmp, 0o600);
		try {
			fs.linkSync(tmp, file);
			return "created";
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "exists";
			throw error;
		}
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* preserve the original error */
			}
		}
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
}

function readRecoveryState(agentDir: string, runId: string): RecoveryState | undefined {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(resolveRecoveryStateFile(agentDir, runId), "utf8"),
		) as Partial<RecoveryState>;
		if (
			(parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
			parsed.runId !== runId ||
			(parsed.phase !== "claimed" &&
				parsed.phase !== "prepared" &&
				parsed.phase !== "requests-reaped" &&
				parsed.phase !== "route-deleted" &&
				parsed.phase !== "marker-deleted") ||
			typeof parsed.createdAt !== "number" ||
			typeof parsed.updatedAt !== "number"
		) {
			return undefined;
		}
		if (
			(parsed.version === 2 || parsed.version === 3) &&
			(
				typeof parsed.rootRunId !== "string" ||
				!isSafeRunId(parsed.rootRunId) ||
				typeof parsed.ownerSessionId !== "string" ||
				parsed.ownerSessionId.length === 0 ||
				!Number.isInteger(parsed.runnerPid) ||
				parsed.runnerPid <= 0
			)
		) {
			return undefined;
		}
		return parsed as RecoveryState;
	} catch {
		return undefined;
	}
}

/**
 * Route hygiene must not delete the transaction's only resume authority while
 * a reconciler is between canonical-result and pending-outbox publication.
 */
export function orchestrateRecoveryInProgress(agentDir: string, runId: string): boolean {
	return readRecoveryState(agentDir, runId) !== undefined;
}

function writeRecoveryState(
	agentDir: string,
	runId: string,
	phase: RecoveryPhase,
	now: number,
	identity: Pick<RecoveryCfg, "rootRunId" | "ownerSessionId"> & { runnerPid: number },
	previous?: RecoveryState,
): RecoveryState {
	const state: RecoveryState = {
		version: 3,
		runId,
		phase,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		rootRunId: identity.rootRunId,
		ownerSessionId: identity.ownerSessionId,
		runnerPid: identity.runnerPid,
	};
	writeOwnerOnlyJson(resolveRecoveryStateFile(agentDir, runId), state);
	return state;
}


function readRecoveryCfg(
	agentDir: string,
	runId: string,
	fallbackOwnerSessionId?: string,
): RecoveryCfg | undefined {
	const identity = readOrchestrateCfgIdentity(agentDir, runId);
	const ownerSessionId = identity?.ownerSessionId ?? fallbackOwnerSessionId;
	if (!identity || !ownerSessionId) return undefined;
	return {
		runId,
		rootRunId: identity.rootRunId,
		ownerSessionId,
		...(identity.ownerPid !== undefined && identity.ownerNonce !== undefined
			? { ownerPid: identity.ownerPid, ownerNonce: identity.ownerNonce }
			: {}),
		agentName: (identity.agentName ?? "detached-driver").slice(
			0,
			MAX_RECOVERY_AGENT_NAME_CHARS,
		),
	};
}

function readEventTail(agentDir: string, rootRunId: string): string {
	let fd: number | undefined;
	try {
		const file = path.join(resolveEventSinkDir(agentDir, rootRunId), "events.ndjson");
		const size = fs.statSync(file).size;
		const bytes = Math.min(size, MAX_RECOVERY_EVENT_TAIL_BYTES);
		const start = Math.max(0, size - bytes);
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(bytes);
		const read = bytes > 0 ? fs.readSync(fd, buffer, 0, bytes, start) : 0;
		let raw = buffer.toString("utf8", 0, read);
		if (start > 0) {
			const newline = raw.indexOf("\n");
			raw = newline >= 0 ? raw.slice(newline + 1) : "";
		}
		return raw;
	} catch {
		return "";
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

const RECOVERY_STAGES = new Set<OrchestrateRecoveryStage>([
	"boot",
	"running",
	"cancel-wind-down",
	"terminal",
]);

function recoveryActivity(
	agentDir: string,
	rootRunId: string,
): Pick<OrchestrateRecoveryDiagnostic, "stage" | "lastActivityAt"> {
	let latestTs: number | undefined;
	let latestStage: OrchestrateRecoveryStage = "pre-event";
	for (const line of readEventTail(agentDir, rootRunId).split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				ts?: unknown;
				kind?: unknown;
				fields?: { phase?: unknown };
			};
			if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) continue;
			if (latestTs !== undefined && event.ts < latestTs) continue;
			latestTs = event.ts;
			const phase = event.fields?.phase;
			if (typeof phase === "string" && RECOVERY_STAGES.has(phase as OrchestrateRecoveryStage)) {
				latestStage = phase as OrchestrateRecoveryStage;
			} else if (event.kind === "started") {
				latestStage = "boot";
			} else if (event.kind === "updated") {
				latestStage = "running";
			} else if (event.kind === "completed") {
				latestStage = "terminal";
			} else {
				latestStage = "unknown";
			}
		} catch {
			/* raw event fields are never copied into recovery diagnostics */
		}
	}
	return {
		stage: latestStage,
		...(latestTs !== undefined ? { lastActivityAt: latestTs } : {}),
	};
}

const RESTART_LINEAGE_KEYS = new Set<string>([
	...Object.values(LINEAGE_ENV),
	LINEAGE_PUBKEY_ENV,
]);
const TRUSTED_RESTART_ENV_KEYS = [
	...RESTART_LINEAGE_KEYS,
	CONTROL_SECRET_ENV,
];

const REPLAYABLE_RESTART_STAGES = new Set<OrchestrateRecoveryStage>([
	"pre-event",
	"boot",
	"running",
]);
const DEFAULT_REPLACEMENT_GATE_PASSES = 2;

function restartLineageEnv(cfg: OrchestrateCfg): Record<string, string> | undefined {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(cfg.restartLineageEnv ?? {})) {
		if (RESTART_LINEAGE_KEYS.has(key) && typeof value === "string") env[key] = value;
	}
	return Object.keys(env).length === RESTART_LINEAGE_KEYS.size ? env : undefined;
}

function persistRestartAttempt(cfg: OrchestrateCfg): void {
	const { env: _env, ...cfgWithoutEnv } = cfg;
	const persisted: OrchestrateCfg = { ...cfgWithoutEnv, mode: "driver" };
	writeOwnerOnlyJson(
		path.join(resolveOrchestrateCfgDir(cfg.agentDir), `${cfg.runId}.cfg.json`),
		persisted,
	);
}

function withTrustedRestartEnv<T>(
	cfg: OrchestrateCfg,
	route: RouteRecord,
	lineageEnv: Record<string, string>,
	spawnFn: (cfg: OrchestrateCfg, route: RouteRecord) => T,
): T {
	const childEnv = { ...lineageEnv, [CONTROL_SECRET_ENV]: route.controlSecret };
	const savedEnv: Record<string, string | undefined> = {};
	for (const key of TRUSTED_RESTART_ENV_KEYS) savedEnv[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(childEnv)) process.env[key] = value;
		return spawnFn(cfg, route);
	} finally {
		for (const key of TRUSTED_RESTART_ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	}
}

function restartOrchestrateRunner(
	cfg: OrchestrateCfg,
	route: RouteRecord,
	lineageEnv: Record<string, string>,
): { pid: number } {
	return withTrustedRestartEnv(cfg, route, lineageEnv, (spawnCfg) =>
		spawnDetachedOrchestrate(spawnCfg, { captureStdio: true }),
	);
}

interface ReplacementIdentity {
	runnerPid: number;
	runnerStartTicks?: string;
	runnerBootId?: string;
	runnerNonce?: string;
}

function replacementIdentity(
	handoff: OrchestrateReplacementHandoff,
): ReplacementIdentity | undefined {
	// Delayed promotion must use the identity captured by the replacement at
	// spawn time. A PID read from the marker (or a PID-only handoff) is only
	// present-time evidence and is unsafe under PID reuse.
	if (handoff.runnerPid === undefined) return undefined;
	return {
		runnerPid: handoff.runnerPid,
		...(handoff.runnerStartTicks ? { runnerStartTicks: handoff.runnerStartTicks } : {}),
		...(handoff.runnerBootId ? { runnerBootId: handoff.runnerBootId } : {}),
		...(handoff.runnerNonce ? { runnerNonce: handoff.runnerNonce } : {}),
	};
}

function replacementIdentityVerdict(args: {
	identity: ReplacementIdentity;
	verifyProcessIdentityFn: VerifyProcessIdentityFn;
	processIdentityDependencies: Partial<ProcessIdentityDependencies>;
	processNonceFn: () => string;
}): ProcessIdentityVerdict {
	return verifyRouteRecordIdentity(
		{
			pid: args.identity.runnerPid,
			runnerStartTicks: args.identity.runnerStartTicks,
			runnerBootId: args.identity.runnerBootId,
			runnerNonce: args.identity.runnerNonce,
		},
		{
			verifyIdentityFn: args.verifyProcessIdentityFn,
			processIdentityDependencies: args.processIdentityDependencies,
			processNonceFn: args.processNonceFn,
		},
	);
}

function sameRouteRecord(left: RouteRecord, right: RouteRecord): boolean {
	return left.runId === right.runId &&
		left.rootRunId === right.rootRunId &&
		left.lineagePath === right.lineagePath &&
		left.controlSecret === right.controlSecret &&
		left.pid === right.pid &&
		left.runnerStartTicks === right.runnerStartTicks &&
		left.runnerBootId === right.runnerBootId &&
		left.runnerNonce === right.runnerNonce &&
		left.ownerSessionId === right.ownerSessionId;
}

function makeRecoveryFailure(
	agentDir: string,
	cfg: RecoveryCfg,
	runnerPid: number,
	now: number,
): OrchestrateResultFailed {
	const activity = recoveryActivity(agentDir, cfg.rootRunId);
	const stderrCapture = fs.existsSync(
		path.join(resolveOrchestrateLogsDir(agentDir), `${cfg.runId}.childlog`),
	)
		? "present"
		: "absent";
	const recovery: OrchestrateRecoveryDiagnostic = {
		reason: "runner-exited",
		source: "maintenance-reconciliation",
		runnerPid,
		stage: activity.stage,
		...(activity.lastActivityAt !== undefined ? { lastActivityAt: activity.lastActivityAt } : {}),
		stderrCapture,
		exitCode: "unknown",
		signal: "unknown",
	};
	return {
		mode: "driver",
		status: "failed",
		runId: cfg.runId,
		agentName: cfg.agentName,
		error:
			`detached driver runner exited before writing a terminal result ` +
			`(runner-exited; stage=${recovery.stage}; stderr-capture=${stderrCapture}; ` +
			`exit=unknown; signal=unknown; pid=${runnerPid})`,
		recovery,
		finishedAt: new Date(now).toISOString(),
	};
}

function isRecoveryFailure(result: OrchestrateResult | undefined): result is OrchestrateResultFailed {
	return result?.status === "failed" &&
		result.recovery?.reason === "runner-exited" &&
		result.recovery?.source === "maintenance-reconciliation";
}

function readTerminalResult(agentDir: string, runId: string): OrchestrateResult | undefined {
	const state = readResultFile(resolveResultFile(agentDir, runId));
	return state.state === "absent" ? undefined : state.result;
}

function publishPreparedPending(
	agentDir: string,
	runId: string,
): "published" | "already-published" {
	const prepared = resolvePreparedPendingFile(agentDir, runId);
	const pending = resolvePendingFile(agentDir, runId);
	const claimed = `${pending}.delivered`;

	if (!fs.existsSync(prepared)) {
		// `prepared` state is persisted before publication and the payload is
		// removed only after publication. Absence therefore means a prior owner
		// already exposed (and possibly delivered/consumed) the pending entry.
		return "already-published";
	}
	if (fs.existsSync(pending) || fs.existsSync(claimed)) {
		fs.rmSync(prepared, { force: true });
		return "already-published";
	}
	ensureOwnerOnlyDir(resolveOrchestratePendingDir(agentDir));
	__testHooks.beforePendingPublish?.();
	// Re-check after the fault/interleaving seam so a normal terminal writer that
	// won immediately before publication is never replaced. Recovery publishers
	// themselves are serialized by the per-run lock.
	if (fs.existsSync(pending) || fs.existsSync(claimed)) {
		fs.rmSync(prepared, { force: true });
		return "already-published";
	}
	// Atomic rename is also the logical-publication commit: the private prepared
	// path disappears at the same instant the queue path appears. A hard-link +
	// unlink sequence would leave a crash window where delivery could consume the
	// queue link while the prepared link survived, causing a later pass to enqueue
	// the same wake again.
	fs.renameSync(prepared, pending);
	return "published";
}

function pathConfirmedAbsent(file: string): boolean {
	try {
		fs.lstatSync(file);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT";
	}
}

function removeRecoveryState(agentDir: string, runId: string): boolean {
	try {
		fs.rmSync(resolveRecoveryStateFile(agentDir, runId), { force: true });
	} catch {
		/* a later state-index pass retries cleanup */
	}
	try {
		fs.rmSync(resolvePreparedPendingFile(agentDir, runId), { force: true });
	} catch {
		/* a later state-index pass retries cleanup */
	}
	return pathConfirmedAbsent(resolveRecoveryStateFile(agentDir, runId)) &&
		pathConfirmedAbsent(resolvePreparedPendingFile(agentDir, runId));
}

interface RecoveryCursor {
	version: 1;
	offset: number;
}

function readRecoveryCursor(agentDir: string): number {
	try {
		const parsed = JSON.parse(fs.readFileSync(resolveRecoveryCursorFile(agentDir), "utf8")) as Partial<RecoveryCursor>;
		return parsed.version === 1 && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0
			? parsed.offset
			: 0;
	} catch {
		return 0;
	}
}

function writeRecoveryCursor(agentDir: string, offset: number): void {
	// The cursor deliberately stores an ordinal, never a run id, prompt-derived
	// value, route secret, or event payload. The short cursor reservation lock
	// makes the ordinal advance durable across concurrent foregrounds.
	writeOwnerOnlyJson(resolveRecoveryCursorFile(agentDir), { version: 1, offset });
}

function readRecoveryCandidateRunIds(agentDir: string): { runIds: string[]; truncated: boolean } {
	const runIds = new Set<string>();
	let truncated = false;
	const readDir = (dirPath: string, suffix: string): void => {
		let dir: fs.Dir | undefined;
		try {
			dir = fs.opendirSync(dirPath);
			for (;;) {
				const entry = dir.readSync();
				if (!entry) break;
				if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
				const runId = entry.name.slice(0, -suffix.length);
				if (isSafeRunId(runId)) runIds.add(runId);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") truncated = true;
		} finally {
			try {
				dir?.closeSync();
			} catch {
				/* best-effort directory handle cleanup */
			}
		}
	};
	readDir(resolveOrchestrateRoutesDir(agentDir), ".json");
	// Recovery state is a second durable index. Once the route secret is
	// deleted, it is the only way a later foreground can resume marker/request
	// cleanup after a crash between those independently-idempotent steps.
	readDir(resolveRecoveryDir(agentDir), ".state.json");
	return { runIds: [...runIds].sort(), truncated };
}

function rotateRecoveryCandidates(args: {
	agentDir: string,
	runIds: string[],
	maxRuns: number,
	staleMs: number,
	lockPidAliveFn: (pid: number) => boolean,
	lockProcessIdentityDependencies?: Partial<ProcessIdentityDependencies>,
}): string[] {
	const { agentDir, runIds, maxRuns, staleMs, lockPidAliveFn, lockProcessIdentityDependencies } = args;
	if (runIds.length === 0) return [];
	// The cursor reservation is intentionally separate from each run's work
	// lock. It serializes only read/advance/write (not reconciliation), so
	// simultaneous foregrounds cannot repeatedly commit the same offset and
	// starve later candidates. Its opaque filename is not a run id.
	let cursorLock: OrchestrateRecoveryLock | undefined;
	const wait = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 8 && !cursorLock; attempt++) {
		cursorLock = acquireOrchestrateRecoveryLock({
			agentDir,
			runId: ".rotation",
			staleMs,
			lockPidAliveFn,
			processIdentityDependencies: lockProcessIdentityDependencies,
			invokeCreationHook: false,
		});
		if (!cursorLock) Atomics.wait(wait, 0, 0, 1);
	}
	if (!cursorLock) return [];
	try {
		const offset = readRecoveryCursor(agentDir) % runIds.length;
		const count = Math.min(maxRuns, runIds.length);
		const selected = Array.from(
			{ length: count },
			(_, index) => runIds[(offset + index) % runIds.length]!,
		);
		writeRecoveryCursor(agentDir, (offset + count) % runIds.length);
		return selected;
	} catch {
		// Do not process a non-durably-reserved selection. Recovery correctness is
		// unaffected and the next maintenance pass retries the short reservation.
		return [];
	} finally {
		releaseOrchestrateRecoveryLock(cursorLock);
	}
}

interface RecoveryIdentity {
	rootRunId: string;
	ownerSessionId: string;
	runnerPid: number;
}

function resolveRecoveryIdentity(args: {
	route: ReturnType<typeof readRouteRecord>;
	state: RecoveryState | undefined;
	cfg: RecoveryCfg | undefined;
	result: OrchestrateResult | undefined;
}): RecoveryIdentity | undefined {
	const { route, state, cfg, result } = args;
	if (route) {
		const durableStateMismatch =
			(state?.version === 2 || state?.version === 3) &&
			(state.rootRunId !== route.rootRunId ||
				state.ownerSessionId !== route.ownerSessionId ||
				state.runnerPid !== route.pid);
		if (
			durableStateMismatch ||
			(cfg && (route.rootRunId !== cfg.rootRunId || route.ownerSessionId !== cfg.ownerSessionId)) ||
			!Number.isInteger(route.pid) ||
			route.pid <= 0
		) {
			return undefined;
		}
		return {
			rootRunId: route.rootRunId,
			ownerSessionId: route.ownerSessionId,
			runnerPid: route.pid,
		};
	}
	// Version 1 did not retain cleanup identity. A pre-upgrade process could
	// nevertheless have deleted the route before crashing. Its still-private cfg
	// plus the canonical recovery diagnostic reconstruct exactly the bounded
	// identity required to finish cleanup; no prompt, secret, stderr, or output
	// is read or copied.
	if (
		state?.version === 1 &&
		cfg &&
		isRecoveryFailure(result) &&
		Number.isInteger(result.recovery.runnerPid) &&
		result.recovery.runnerPid > 0
	) {
		return {
			rootRunId: cfg.rootRunId,
			ownerSessionId: cfg.ownerSessionId,
			runnerPid: result.recovery.runnerPid,
		};
	}
	if (
		(state?.version !== 2 && state?.version !== 3) ||
		!state.rootRunId ||
		!state.ownerSessionId ||
		!Number.isInteger(state.runnerPid) ||
		state.runnerPid <= 0 ||
		(cfg && (cfg.rootRunId !== state.rootRunId || cfg.ownerSessionId !== state.ownerSessionId))
	) {
		return undefined;
	}
	return {
		rootRunId: state.rootRunId,
		ownerSessionId: state.ownerSessionId,
		runnerPid: state.runnerPid,
	};
}

function ensureRecoveryOwnerEvidence(args: {
	agentDir: string;
	runId: string;
	identity: RecoveryIdentity;
	cfg: RecoveryCfg | undefined;
}): void {
	const existing = readOrchestrateOwnerEvidence(args.agentDir, args.runId);
	const cfg = args.cfg;
	if (existing.kind === "present") {
		if (existing.evidence.ownerSessionId !== args.identity.ownerSessionId) {
			throw new Error("driver owner evidence conflicts with recovery identity");
		}
		const cfgHasProcessIdentity = cfg?.ownerPid !== undefined && cfg.ownerNonce !== undefined;
		const evidenceHasProcessIdentity = existing.evidence.ownerPid !== undefined && existing.evidence.ownerNonce !== undefined;
		if (cfgHasProcessIdentity && evidenceHasProcessIdentity && (
			existing.evidence.ownerPid !== cfg.ownerPid ||
			existing.evidence.ownerNonce !== cfg.ownerNonce
		)) {
			throw new Error("driver owner process evidence conflicts with recovery cfg");
		}
		if (cfgHasProcessIdentity && !evidenceHasProcessIdentity) {
			writeOrchestrateOwnerEvidence({
				agentDir: args.agentDir,
				runId: args.runId,
				ownerSessionId: args.identity.ownerSessionId,
				ownerPid: cfg.ownerPid,
				ownerNonce: cfg.ownerNonce,
			});
		}
		return;
	}
	if (existing.kind === "unknown") throw new Error("driver owner evidence is unreadable");
	if (cfg?.ownerPid !== undefined && cfg.ownerNonce !== undefined) {
		writeOrchestrateOwnerEvidence({
			agentDir: args.agentDir,
			runId: args.runId,
			ownerSessionId: args.identity.ownerSessionId,
			ownerPid: cfg.ownerPid,
			ownerNonce: cfg.ownerNonce,
		});
		return;
	}
	writeOrchestrateOwnerEvidence({
		agentDir: args.agentDir,
		runId: args.runId,
		ownerSessionId: args.identity.ownerSessionId,
	});
}

function finishRecoveryCleanup(args: {
	agentDir: string;
	runId: string;
	identity: RecoveryIdentity;
	now: number;
	state: RecoveryState;
}): RecoveryState | undefined {
	const { agentDir, runId, identity, now } = args;
	let state = args.state;
	// The target lock is held by the caller. The reaper acquires sibling target
	// locks where needed, while this target stays excluded from concurrent posts.
	reapOrphanControlRequestsForRoot(agentDir, identity.rootRunId, undefined, { heldRunId: runId });
	if (hasOrphanControlRequestForRun(agentDir, identity.rootRunId, runId)) return undefined;
	state = writeRecoveryState(agentDir, runId, "requests-reaped", now, identity, state);

	deleteRouteRecord(agentDir, runId);
	if (!pathConfirmedAbsent(resolveRouteRecordFile(agentDir, runId))) return undefined;
	state = writeRecoveryState(agentDir, runId, "route-deleted", now, identity, state);
	__testHooks.afterRouteDelete?.();

	deleteOrchestrateActiveMarker({ agentDir, ownerSessionId: identity.ownerSessionId, runId });
	const marker = path.join(
		resolveOrchestrateActiveOwnerDir(agentDir, identity.ownerSessionId),
		`${runId}.json`,
	);
	if (!pathConfirmedAbsent(marker)) return undefined;
	return writeRecoveryState(agentDir, runId, "marker-deleted", now, identity, state);
}

/**
 * Detect and durably terminalize every route-backed detached runner whose PID
 * is dead and whose child never wrote a normal result. The function is
 * synchronous and safe to invoke from startup and periodic maintenance in
 * multiple Pi processes sharing the same `agentDir`.
 */
export function reconcileDeadOrchestrateRuns(
	options: ReconcileDeadOrchestrateRunsOptions,
): ReconcileDeadOrchestrateRunsResult {
	const result = emptyResult();
	const now = typeof options.now === "number" && Number.isFinite(options.now)
		? options.now
		: Date.now();
	const requestedStaleMs = typeof options.lockStaleMs === "number" && Number.isFinite(options.lockStaleMs)
		? options.lockStaleMs
		: ORCHESTRATE_RECOVERY_LOCK_STALE_MS;
	const staleMs = Math.max(1, requestedStaleMs);
	const pidAliveFn = options.pidAliveFn ?? pidAlive;
	const processStartTicksFn = options.processStartTicksFn ?? readProcessStartTicks;
	const processBootIdFn = options.processBootIdFn ?? resolveCurrentBootId;
	const verifyProcessIdentityFn = options.verifyProcessIdentityFn ?? verifyProcessIdentity;
	const processNonceFn = options.processNonceFn ?? getProcessNonce;
	const platformFn = options.platformFn ?? (() => process.platform);
	const processIdentityDependencies = buildRecoveryProcessIdentityDependencies({
		pidAliveFn,
		processStartTicksFn,
		processBootIdFn,
		platformFn,
	});
	const lockPidAliveFn = options.lockPidAliveFn ?? pidAlive;
	const lockProcessIdentityDependencies = options.lockProcessIdentityDependencies;
	const writeReplacementHandoffFn = options.writeReplacementHandoffFn ?? writeOrchestrateReplacementHandoff;
	const requestedMax = typeof options.maxRuns === "number" && Number.isFinite(options.maxRuns)
		? options.maxRuns
		: MAX_ORCHESTRATE_RECOVERY_RUNS;
	const maxRuns = Math.max(1, Math.min(1024, Math.floor(requestedMax)));
	const requestedGatePasses = typeof options.replacementGatePasses === "number" &&
		Number.isFinite(options.replacementGatePasses)
		? options.replacementGatePasses
		: DEFAULT_REPLACEMENT_GATE_PASSES;
	const replacementGatePasses = Math.max(1, Math.floor(requestedGatePasses));
	let candidateRunIds: string[];
	try {
		const listing = readRecoveryCandidateRunIds(options.agentDir);
		candidateRunIds = listing.runIds;
		result.truncated = listing.truncated;
	} catch {
		return result;
	}
	if (candidateRunIds.length > maxRuns) result.truncated = true;
	const selectedRunIds = rotateRecoveryCandidates({
		agentDir: options.agentDir,
		runIds: candidateRunIds,
		maxRuns,
		staleMs,
		lockPidAliveFn,
		lockProcessIdentityDependencies,
	});

	for (const runId of selectedRunIds) {
		let route = readRouteRecord(options.agentDir, runId);
		const recoveryState = readRecoveryState(options.agentDir, runId);
		const cfg = readRecoveryCfg(
			options.agentDir,
			runId,
			route?.ownerSessionId ?? recoveryState?.ownerSessionId,
		);
		const existing = readTerminalResult(options.agentDir, runId);
		const identity = resolveRecoveryIdentity({ route, state: recoveryState, cfg, result: existing });
		if (!identity) {
			result.degraded++;
			continue;
		}
		const handoff = readOrchestrateReplacementHandoff(options.agentDir, runId);
		const routeRunnerVerdict = (): ProcessIdentityVerdict => {
			if (!route) {
				try {
					return pidAliveFn(identity.runnerPid) ? "unproven" : "absent";
				} catch {
					return "unproven";
				}
			}
			return verifyRouteRecordIdentity(
				{
					pid: identity.runnerPid,
					runnerStartTicks: route.runnerStartTicks,
					runnerBootId: route.runnerBootId,
					runnerNonce: route.runnerNonce,
				},
				{
					verifyIdentityFn: verifyProcessIdentityFn,
					processIdentityDependencies,
					processNonceFn,
				},
			);
		};
		const routeRunnerAlive = (): boolean => {
			const verdict = routeRunnerVerdict();
			return verdict === "match" || verdict === "unproven";
		};

		if (existing && !(recoveryState && isRecoveryFailure(existing))) {
			// Normal caught-throw/success terminal paths are owned by the existing
			// child + route sweeps and remain byte-for-byte unchanged. A normal
			// winner that raced our claimed phase must also release the recovery
			// guard, otherwise generic route hygiene would preserve its secret.
			if (recoveryState) removeRecoveryState(options.agentDir, runId);
			if (handoff) deleteOrchestrateReplacementHandoff(options.agentDir, runId);
			continue;
		}
		// A persisted claim proves a prior pass already observed this exact route/
		// cfg identity dead; a recovery terminal is stronger still. Do not let PID
		// reuse strand publication or cleanup after that durable boundary. Liveness
		// is required only before the first claim is written.
		if (!recoveryState && !isRecoveryFailure(existing)) {
			try {
				if (routeRunnerAlive()) {
					result.live++;
					continue;
				}
			} catch {
				// A failed liveness probe must never kill a potentially-live run.
				result.degraded++;
				continue;
			}
		}
		result.candidates++;

		let lock: OrchestrateRecoveryLock | undefined;
		try {
			lock = acquireOrchestrateRecoveryLock({
				agentDir: options.agentDir,
				runId,
				now,
				staleMs,
				lockPidAliveFn,
				processIdentityDependencies: lockProcessIdentityDependencies,
			});
		} catch {
			result.degraded++;
			continue;
		}
		if (!lock) {
			result.contended++;
			continue;
		}

		try {
			// Re-check every authority after the claim. A terminal file or live PID
			// may have appeared between directory enumeration and lock acquisition.
			const current = readTerminalResult(options.agentDir, runId);
			let state = readRecoveryState(options.agentDir, runId);
			let replacementHandoff = readOrchestrateReplacementHandoff(options.agentDir, runId);
			// The initial route read is only a candidate hint. A prior pass may have
			// promoted a replacement while this pass waited for the lock; never use
			// that stale predecessor snapshot to terminalize (or delete) the live
			// replacement's route.
			const routeAfterLock = readRouteRecord(options.agentDir, runId);
			if (route && (!routeAfterLock || !sameRouteRecord(route, routeAfterLock))) continue;
			route = routeAfterLock;
			if (route) {
				const lockedIdentity = resolveRecoveryIdentity({ route, state, cfg, result: current });
				if (
					!lockedIdentity ||
					lockedIdentity.rootRunId !== identity.rootRunId ||
					lockedIdentity.ownerSessionId !== identity.ownerSessionId ||
					lockedIdentity.runnerPid !== identity.runnerPid
				) continue;
			}
			if (current && !(state && isRecoveryFailure(current))) continue;
			if (!state && !current && route && replacementHandoff) {
				const replacement = replacementIdentity(
					replacementHandoff,
				);
				if (replacement) {
					const replacementVerdict = replacementIdentityVerdict({
						identity: replacement,
						verifyProcessIdentityFn,
						processIdentityDependencies,
						processNonceFn,
					});
					if (replacementVerdict === "match") {
						const {
							runnerStartTicks: _oldRunnerStartTicks,
							runnerBootId: _oldRunnerBootId,
							runnerNonce: _oldRunnerNonce,
							...routeIdentity
						} = route;
						const routeWrite = writeRouteRecord(options.agentDir, {
							...routeIdentity,
							pid: replacement.runnerPid,
							...(replacement.runnerStartTicks
								? { runnerStartTicks: replacement.runnerStartTicks }
								: {}),
							...(replacement.runnerBootId
								? { runnerBootId: replacement.runnerBootId }
								: {}),
							...(replacement.runnerNonce
								? { runnerNonce: replacement.runnerNonce }
								: {}),
						});
						if (!routeWrite.ok) throw new Error("replacement route update failed");
						deleteOrchestrateReplacementHandoff(options.agentDir, runId);
						result.restarted++;
						continue;
					}
					if (replacementVerdict === "unproven" && replacementHandoff.remainingPasses > 0) {
						writeOrchestrateReplacementHandoff(options.agentDir, {
							...replacementHandoff,
							remainingPasses: replacementHandoff.remainingPasses - 1,
						});
						result.live++;
						continue;
					}
					deleteOrchestrateReplacementHandoff(options.agentDir, runId);
					replacementHandoff = undefined;
				} else if (replacementHandoff.remainingPasses > 0) {
					writeOrchestrateReplacementHandoff(options.agentDir, {
						...replacementHandoff,
						remainingPasses: replacementHandoff.remainingPasses - 1,
					});
					result.live++;
					continue;
				} else {
					deleteOrchestrateReplacementHandoff(options.agentDir, runId);
					replacementHandoff = undefined;
				}
			}
			if (!state && !isRecoveryFailure(current)) {
				if (routeRunnerAlive()) {
					result.live++;
					continue;
				}
			}

			// Reuse the durable cfg and route capability once after a runtime exit.
			// A running-stage replacement is intentionally at-least-once: the old
			// process identity is gone, so it cannot race the replacement, but work
			// completed before the crash may be repeated. Terminal/cancel wind-down
			// stages remain non-replayable.
			if (!state && !current && route) {
				const persistedCfg = readOrchestrateCfg(options.agentDir, runId);
				const activity = recoveryActivity(options.agentDir, identity.rootRunId);
				const lineageEnv = persistedCfg ? restartLineageEnv(persistedCfg) : undefined;
				if (
					persistedCfg &&
					REPLAYABLE_RESTART_STAGES.has(activity.stage) &&
					persistedCfg.restartBlockedByTransportEnv !== true &&
					lineageEnv !== undefined &&
					(persistedCfg.restartAttempts ?? 0) < 1
				) {
					const restartCfg: OrchestrateCfg = {
						...persistedCfg,
						mode: "driver",
						restartAttempts: (persistedCfg.restartAttempts ?? 0) + 1,
					};
					persistRestartAttempt(restartCfg);
					try {
						// This durable pre-spawn barrier is intentional and is the
						// load-bearing exception to the never-delay-spawn preference: if the
						// reconciling foreground is killed immediately after spawn,
						// the replacement must have a handoff record before it can
						// become orphaned. Moving this write after spawn would satisfy
						// a scheduling preference but reopen #86's lost-handoff window;
						// all later persistence remains best-effort and never blocks
						// runner boot.
						writeReplacementHandoffFn(options.agentDir, {
							version: 1,
							runId,
							remainingPasses: replacementGatePasses,
						});
					} catch {
						// Best-effort: a missing handoff must never block the restart spawn;
						// this one restart degrades to the pre-fix recovery behavior.
					}
					const restarted = options.restartRunnerFn
						? withTrustedRestartEnv(restartCfg, route, lineageEnv, options.restartRunnerFn)
						: restartOrchestrateRunner(restartCfg, route, lineageEnv);
					if (!Number.isInteger(restarted.pid) || restarted.pid <= 0) {
						throw new Error("replacement runner returned no pid");
					}
					const restartedStartTicks = processStartTicksFn(restarted.pid);
					const restartedBootId = processBootIdFn();
					const stamped = readOrchestrateReplacementHandoff(options.agentDir, runId);
					const replacementPid = stamped?.runnerPid ?? restarted.pid;
					const replacementStartTicks = stamped?.runnerStartTicks ?? restartedStartTicks;
					const replacementBootId = stamped?.runnerBootId ?? restartedBootId;
					const replacementNonce = stamped?.runnerNonce;
					writeOrchestrateReplacementHandoff(options.agentDir, {
						version: 1,
						runId,
						remainingPasses: replacementGatePasses,
						runnerPid: replacementPid,
						...(replacementStartTicks ? { runnerStartTicks: replacementStartTicks } : {}),
						...(replacementBootId ? { runnerBootId: replacementBootId } : {}),
						...(replacementNonce ? { runnerNonce: replacementNonce } : {}),
					});
					const {
						runnerStartTicks: _oldRunnerStartTicks,
						runnerBootId: _oldRunnerBootId,
						runnerNonce: _oldRunnerNonce,
						...routeIdentity
					} = route;
					const routeWrite = writeRouteRecord(options.agentDir, {
						...routeIdentity,
						pid: replacementPid,
						...(replacementStartTicks ? { runnerStartTicks: replacementStartTicks } : {}),
						...(replacementBootId ? { runnerBootId: replacementBootId } : {}),
						...(replacementNonce ? { runnerNonce: replacementNonce } : {}),
					});
					if (!routeWrite.ok) {
						try { process.kill(replacementPid, "SIGTERM"); } catch { /* already gone */ }
						throw new Error("replacement route update failed");
					}
					deleteOrchestrateReplacementHandoff(options.agentDir, runId);
					result.restarted++;
					continue;
				}
			}

			if (!state) {
				state = writeRecoveryState(options.agentDir, runId, "claimed", now, identity);
			}
			let canonical = current;
			if (!canonical) {
				// A cfg is preferred for its non-secret agent label, but the 0600 route
				// is sufficient durable identity when a crash has already removed cfg.
				// Do not discard that route before publishing this bounded failure.
				const synthesized = makeRecoveryFailure(
					options.agentDir,
					cfg ?? {
						runId,
						rootRunId: identity.rootRunId,
						ownerSessionId: identity.ownerSessionId,
						agentName: "detached-driver",
					},
					identity.runnerPid,
					now,
				);
				const write = writeOwnerOnlyJsonOnce(resolveResultFile(options.agentDir, runId), synthesized);
				if (write === "created") result.terminalized++;
				canonical = readTerminalResult(options.agentDir, runId);
			}
			if (!isRecoveryFailure(canonical)) {
				// A competing normal terminal writer wins. Leave its result/pending
				// contract untouched and discard only our private recovery state.
				removeRecoveryState(options.agentDir, runId);
				continue;
			}

			// Recovery may be the first writer to finish a run after a crash has
			// already removed cfg. Preserve the route/marker owner identity before
			// publishing pending, because cleanup below removes both artifacts.
			ensureRecoveryOwnerEvidence({
				agentDir: options.agentDir,
				runId,
				identity,
				cfg,
			});

			const preparedPending = resolvePreparedPendingFile(options.agentDir, runId);
			if (state.phase === "claimed" || fs.existsSync(preparedPending)) {
				writeOwnerOnlyJson(preparedPending, {
					...canonical,
					mode: "driver",
				});
				if (state.phase === "claimed") {
					state = writeRecoveryState(options.agentDir, runId, "prepared", now, identity, state);
				}
			}
			const published = publishPreparedPending(options.agentDir, runId);
			if (published === "published") result.enqueued++;

			// Pending publication is now durable. Reject/reap any control request
			// that raced the abrupt terminal edge while cfg still supplies the
			// non-secret root identity, then remove the control secret. If unlink
			// fails, keeping `prepared` prevents a later sweep from manufacturing a
			// duplicate wake.
			const cleanupState = finishRecoveryCleanup({
				agentDir: options.agentDir,
				runId,
				identity,
				now,
				state,
			});
			if (!cleanupState) {
				result.degraded++;
			} else if (removeRecoveryState(options.agentDir, runId)) {
				result.cleaned++;
			} else {
				result.degraded++;
			}
		} catch {
			// State + route remain for a later maintenance pass. Never expose raw
			// fs/error text here: it can include user-controlled paths or payloads.
			if (readOrchestrateReplacementHandoff(options.agentDir, runId)) result.live++;
			else result.degraded++;
		} finally {
			releaseOrchestrateRecoveryLock(lock);
		}
	}

	return result;
}
