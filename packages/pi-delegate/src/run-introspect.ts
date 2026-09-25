/**
 * Shape-agnostic READ resolver for delegate runs (spec 0008, node
 * `run-status-result-resolver`).
 *
 * ## Why
 *
 * `delegate_status` and `delegate_result` historically read ONLY the in-memory
 * `runs` map (`getRun` / `listRuns` in `src/runtime.ts`). That map records the
 * in-process delegate shapes (supervised `agents`, direct `tasks`, `chain`) but
 * has NO entry for a DETACHED `orchestrate` child — that child is a separate OS
 * process whose only record is on the filesystem (the orchestrate cfg /
 * results / pending dirs from `src/detached-spawn.ts` + the liveness event bus
 * from `src/event-bus.ts`). So a RUNNING detached orchestrate run was
 * un-introspectable until it auto-woke the foreground on completion, and
 * `delegate_result` could not read a completed orchestrate result through the
 * tool at all.
 *
 * This module closes that read-surface seam with ONE resolver that maps ANY
 * runId — in-process or detached — to a UNIFORM status / result shape. The
 * source is transport-appropriate (the in-memory map for in-process; the
 * orchestrate fs records + bus for detached) but the CALLER reads one shape and
 * cannot tell which backend answered. Uniformity comes from the resolver
 * ABSTRACTION, not from a single physical transport.
 * [decision: option-2-one-resolver-transport-appropriate]
 * [decision: resolver-in-new-module]
 *
 * ## Scope
 *
 * This is the READ half only and is read-only w.r.t. control (REQ-INTRO-7) —
 * `delegate_steer` / `delegate_cancel` are untouched. It also performs
 * reader-side staleness / dead-pid reconciliation (REQ-INTRO-4,
 * `staleness-reconciliation`): a detached run with no terminal record whose
 * latest-bus-event pid probes dead is reported `terminal-failed` rather than
 * `running` forever (see `resolveDetachedStatus`, which probes the pid via the
 * injectable `PidAliveFn`). A terminal RECORD always stays primary — the pid
 * is only probed when no record exists.
 *
 * ## No-perturb discipline (REQ-INTRO-6)
 *
 * Every fs read is fully try/catch guarded. A read failure (missing dir,
 * slow/full disk, unreadable record) degrades to whatever could be read — it
 * NEVER throws into the foreground or perturbs an active run. The list path
 * (`listAllRunStatuses`) bounds its scan and skips unreadable / foreign entries
 * best-effort (REQ-INTRO-5). The caller (the tool) decides whether a partial
 * read warrants a soft `isError`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	type OrchestrateResult,
	deleteOrchestrateActiveMarker,
	readResultFile,
	readOrchestrateActiveMarkerPid,
	resolveOrchestrateActiveOwnerDir,
	resolveOrchestrateCfgDir,
	resolveOrchestrateLogsDir,
	resolvePendingFile,
	resolveResultFile,
} from "./detached-spawn.js";
import {
	type BusEvent,
	type BusTerminalSummary,
	pidAlive,
	readBusTerminalSummary,
	resolveEventSinkDir,
} from "./event-bus.js";
import { readTaskProgressFields, TASK_ATTEMPT_FIELD, type TaskProgressFields } from "./task-seam.js";
import {
	isValidProcessBootId,
	isValidProcessNonce,
	isValidProcessStartTicks,
} from "./process-identity.js";
import type { RunResult } from "./fork-runner.js";
import {
	getRunSnapshot,
	isLiveStatus,
	isOwnedByThisProcess,
	listRunSnapshots,
	summarizeRecoveryProvenance,
	type RecoveryProvenanceSummary,
} from "./runtime.js";
import {
	aggregateRunResults,
	aggregateRunStateUsage,
	delegateUsageFromAggregate,
	type DelegateUsageTotals,
} from "./usage-rollup.js";
import { readRouteRecord } from "./control-route.js";
import { actorActivitySilenceMs } from "./actor-activity.js";
import { isSafeRunId } from "./run-id.js";
import { buildRetryProjection, type RetryProjectionFork } from "./retry-projection.js";

// ── Uniform shapes ───────────────────────────────────────────────────────────

/**
 * Which delegate transport produced a run. `supervised` / `direct` / `chain`
 * are the three in-process shapes (the in-memory runs map); `driver` is the
 * detached child (fs records + bus). `orchestrate` remains a read-only legacy
 * spelling for older status/result records; `unknown` is a defensive fallback.
 */
export type RunShape = "supervised" | "direct" | "chain" | "driver" | "orchestrate" | "unknown";

/** Canonical public spelling for a status/result shape, including old records. */
export function canonicalRunShape(shape: RunShape): RunShape {
	return shape === "orchestrate" ? "driver" : shape;
}

/**
 * The lowest-common-denominator run state across every shape (REQ-INTRO-1):
 *   - `constructing` — registered but the entry isn't fully built yet.
 *   - `running`      — in-flight.
 *   - `terminal-done` / `terminal-failed` — finished.
 *   - `terminal-steered` — a steered terminal-done variant the orchestrate path
 *     can produce; retained in the enum so the caller reads it uniformly.
 *   - `terminal-paused` — a supervised entry whose supervisor was forced to
 *     finish at `max_rounds` (spec 0019 / REQ-PAUSE-4). Terminal but NOT a
 *     success: the child is parked mid-work. Surfaced to a detached parent via
 *     a `kind:"paused"` terminal bus event, mirroring `terminal-steered`.
 */
export type UniformRunState =
	| "constructing"
	| "running"
	| "terminal-done"
	| "terminal-failed"
	| "terminal-steered"
	| "terminal-paused";

/** Which backend answered a resolve. Diagnostic only; the caller reads the common fields. */
export type RunSource = "in-memory" | "detached";

/**
 * Uniform run STATUS (REQ-INTRO-1). The common fields are read identically
 * regardless of source; `details` carries the shape-specific extras a caller
 * MAY surface (an in-process entry's rounds/heartbeat; a detached run's pid /
 * phase events) but is never required to interpret.
 */
export interface UniformRunStatus {
	runId: string;
	shape: RunShape;
	state: UniformRunState;
	source: RunSource;
	/** ms epoch the run was first created/observed, when known. */
	startedAt?: number;
	/** ms epoch of the most recent observed activity (in-memory end / bus event). */
	lastActivityAt?: number;
	/** Shape-specific extras (in-process entry summary; detached pid / phase). */
	details?: Record<string, unknown>;
}

/** Categorical startup phase used by detached RPC diagnostics. */
export type DetachedStartupPhase = "pre-connect" | "post-handshake" | "session" | "model";

/** Categorical process provenance; stderr contents are never surfaced. */
export type DetachedExitProvenance = "none" | "stalled" | "process-exit" | "runner-exit" | "unknown";

/** Hard server-side limits for a surfaced childlog tail. */
export const MAX_CHILDLOG_TAIL_BYTES = 64 * 1024;
export const MAX_CHILDLOG_TAIL_LINES = 256;
/** Small default for specific-run status/result calls. */
export const DEFAULT_CHILDLOG_TAIL_BYTES = 8 * 1024;
export const DEFAULT_CHILDLOG_TAIL_LINES = 40;

export interface ChildLogSurfaceOptions {
	/** Include a tail in the diagnostic projection. */
	includeTail?: boolean;
	/** Requested line count; clamped to [0, MAX_CHILDLOG_TAIL_LINES]. */
	tailLines?: unknown;
	/** Internal/tool opt-in for the hard byte ceiling. */
	fullTail?: boolean;
}

/** Clamp caller-controlled tail size without trusting tool-schema validation. */
export function clampChildLogTailLines(
	requested: unknown,
	full = false,
): number {
	if (full && requested === undefined) return MAX_CHILDLOG_TAIL_LINES;
	if (requested === undefined) return DEFAULT_CHILDLOG_TAIL_LINES;
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return DEFAULT_CHILDLOG_TAIL_LINES;
	}
	return Math.max(0, Math.min(MAX_CHILDLOG_TAIL_LINES, Math.trunc(requested)));
}

/** Timing projection shared by delegate_status and the transcript overlay. */
export interface UniformRunTiming {
	/** Wall-clock run duration. Undefined only for legacy records with no usable start. */
	elapsedMs?: number;
	/** Age of the last bounded event-bus/activity signal, when one is known. */
	lastActivityAgeMs?: number;
}

/** True for every non-terminal uniform state. */
export function isUniformRunLive(status: UniformRunStatus): boolean {
	return status.state === "constructing" || status.state === "running";
}

/**
 * Compute elapsed and silence independently (issue #53).
 *
	* Live elapsed is wall-clock `now - startedAt`, so a healthy-but-quiet child
	* keeps accruing runtime. Terminal elapsed is frozen at `lastActivityAt`
	* (the durable result's `finishedAt`). Event silence remains separately
	* visible through `lastActivityAgeMs`; it is never treated as terminality.
	*/
export function getUniformRunTiming(
	status: UniformRunStatus,
	now: number = Date.now(),
): UniformRunTiming {
	const details = status.details ?? {};
	const lastEventAt =
		typeof details.lastEventAt === "number" && Number.isFinite(details.lastEventAt)
			? details.lastEventAt
			: status.lastActivityAt;
	const live = isUniformRunLive(status);
	const endAt = live
		? status.source === "detached"
			? now
			: (status.lastActivityAt ?? now)
		: status.lastActivityAt;
	const elapsedMs =
		typeof status.startedAt === "number" &&
		Number.isFinite(status.startedAt) &&
		typeof endAt === "number" &&
		Number.isFinite(endAt)
			? Math.max(0, endAt - status.startedAt)
			: undefined;
	const lastActivityAgeMs =
		typeof lastEventAt === "number" && Number.isFinite(lastEventAt)
			? Math.max(0, actorActivitySilenceMs(lastEventAt, now))
			: undefined;
	return { elapsedMs, lastActivityAgeMs };
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

const SAFE_STATUS_REASONS = new Set([
	"completed",
	"steered",
	"paused",
	"child-stalled",
	"spawn-failed",
	"child-exit",
	"cancelled",
	"failed",
	"runner-exited",
]);
const SAFE_STATUS_PHASES = new Set([
	"boot",
	"running",
	"cancel-wind-down",
	"terminal",
	"started",
	"updated",
	"completed",
]);
const SAFE_STARTUP_PHASES = new Set(["pre-connect", "post-handshake", "session", "model"]);
/**
 * The daemon's OBSERVED phase vocabulary (issue #540). Deliberately a separate
 * allowlist from `SAFE_STATUS_PHASES`: the daemon reports session liveness
 * (`asleep`, `blocked`) while the bus reports run lifecycle (`boot`,
 * `cancel-wind-down`). The two overlap on `running`/`idle`-ish words without
 * meaning the same thing, so folding them together would render one vocabulary
 * under the other's label.
 */
const SAFE_OBSERVED_PHASES = new Set(["asleep", "idle", "working", "blocked", "failed", "gone"]);
/**
 * Attention signals worth an operator's eye. `none` is intentionally absent —
 * it is the daemon's "nothing to see", and rendering it would add a part that
 * carries no information to every healthy driver row.
 */
const SAFE_ATTENTION_SIGNALS = new Set(["question", "failed", "interrupted"]);
/** Ceiling on the rendered pending-question count, so a narrow row stays narrow. */
const MAX_RENDERED_PENDING_QUESTIONS = 99;

function safeCategorical(value: unknown, allowed: ReadonlySet<string>): string | undefined {
	return typeof value === "string" && allowed.has(value) ? value : undefined;
}

/**
 * Bounded COUNT of awaiting operator questions (issue #540).
 *
 * Only the length is read. `pendingQuestions[].title` is free text copied from
 * a tool-call argument — the observed one carried a shell command — so no part
 * of an element may reach an operator surface through this path.
 */
function safePendingQuestionCount(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	return value.length > MAX_RENDERED_PENDING_QUESTIONS
		? `${MAX_RENDERED_PENDING_QUESTIONS}+`
		: String(value.length);
}

function positivePid(value: unknown): number | undefined {
	return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTaskProgressForAttempt(busFields: unknown, taskAttempt: number): TaskProgressFields | undefined {
	if (typeof busFields !== "object" || busFields === null || Array.isArray(busFields)) return undefined;
	const eventAttempt = (busFields as Record<string, unknown>)[TASK_ATTEMPT_FIELD];
	// Task events written before attempt scoping belong to the initial run only.
	if (eventAttempt === undefined && taskAttempt === 0) return readTaskProgressFields(busFields);
	if (eventAttempt !== taskAttempt) return undefined;
	return readTaskProgressFields(busFields);
}

/**
 * Canonical bounded text projection used by every detached status surface.
 * Only allowlisted metadata is rendered; prompts, arbitrary event fields,
 * route secrets, and control capabilities can never leak through this path.
 * A pending operator question is rendered as a COUNT only: its title is free
 * text from a tool-call argument and stays on the far side of this boundary.
 */
export function formatUniformRunStatus(
	status: UniformRunStatus,
	now: number = Date.now(),
): string {
	const timing = getUniformRunTiming(status, now);
	const details = status.details ?? {};
	const parts: string[] = [];
	parts.push(timing.elapsedMs === undefined ? "elapsed unknown" : `${seconds(timing.elapsedMs)} elapsed`);
	// Terminal reason is the highest-value bounded diagnostic; keep it before
	// activity/pid/phase so narrow overlay rows do not truncate the diagnosis.
	const reason = safeCategorical(details.terminalReason, SAFE_STATUS_REASONS);
	if (reason) parts.push(`reason=${reason}`);
	if (timing.lastActivityAgeMs !== undefined) {
		parts.push(`last activity ${seconds(timing.lastActivityAgeMs)} ago`);
	}
	const visiblePid = positivePid(details.runnerPid) ?? positivePid(details.activityPid);
	if (visiblePid !== undefined) parts.push(`pid=${visiblePid}`);
	const phase = safeCategorical(details.phase, SAFE_STATUS_PHASES);
	if (phase) parts.push(`phase=${phase}`);
	const startupPhase = safeCategorical(details.startupPhase, SAFE_STARTUP_PHASES);
	if (startupPhase) parts.push(`startup=${startupPhase}`);
	// Daemon-driver liveness (issue #540). The daemon path populates a key set
	// disjoint from everything above, so without these a driver blocked on an
	// operator question rendered as the bare `elapsed unknown`. No shape branch:
	// a key nothing populates simply renders nothing, exactly as `phase` does.
	// Placed after the bus diagnostics and before the long model/childlog tail
	// so a narrow overlay row keeps the operator-actionable part.
	const observedPhase = safeCategorical(details.observedPhase, SAFE_OBSERVED_PHASES);
	if (observedPhase) parts.push(`observed=${observedPhase}`);
	const attention = safeCategorical(details.attention, SAFE_ATTENTION_SIGNALS);
	if (attention) parts.push(`attention=${attention}`);
	const pendingQuestions = safePendingQuestionCount(details.pendingQuestions);
	if (pendingQuestions) parts.push(`questions=${pendingQuestions}`);
	if (typeof details.provider === "string" && typeof details.model === "string") {
		parts.push(`model=${details.provider}/${details.model}`);
	}
	if (typeof details.childlogPath === "string") parts.push(`childlog=${details.childlogPath}`);
	return `${status.runId} [${canonicalRunShape(status.shape)}] ${status.state} (${parts.join("; ")})`;
}

/**
 * One event as an operator surface may see it.
 *
 * A `BusEvent`'s `fields` is free-form and written by another process, and it
 * really does carry an agent name and a `controlSecret`. Returning the raw
 * event would move this module's privacy boundary downstream onto whoever
 * happens to render it (review finding OV3-EVENT-RAW), so the projection
 * happens here, where every other detached surface is already redacted.
 */
export interface RunEventRecord {
	readonly ts: number;
	readonly kind: BusEvent["kind"];
	/** Allow-listed phase, absent when the emitter reported an unknown one. */
	readonly phase?: string;
	/** Allow-listed terminal outcome, only on a `completed` event. */
	readonly outcome?: string;
	readonly tools?: number;
	readonly pid?: number;
	/** Bounded child task progress projected from the event-bus fields. */
	readonly taskProgress?: TaskProgressFields;
}

/** Phases a detached child may report. Mirrors `SAFE_DETACHED_PHASES`. */
const SAFE_EVENT_PHASES = new Set(["boot", "running", "cancel-wind-down", "terminal"]);

/**
 * Terminal outcomes a `completed` event may carry.
 *
 * Taken from what `orchestrate-runner.ts` actually emits, not from what a
 * reasonable set would look like: an earlier version allow-listed `cancelled`,
 * which is never emitted, and omitted `steered`, which is (OV3-EVENT-OUTCOME).
 */
const SAFE_EVENT_OUTCOMES = new Set(["done", "failed", "steered"]);

/**
 * Bounded, on-demand read of one detached run's status-bus events, for the
 * overlay's event log.
 *
 * Separate from `listAllRunStatuses` on purpose: that call reduces a whole
 * tail to a handful of summary fields for every run on every refresh, and the
 * overlay wants the individual events for exactly one run, only while the
 * operator is looking at it. Reusing the same bounded reader keeps the I/O
 * ceiling (`MAX_STATUS_EVENT_BYTES`) and the NDJSON guard identical.
 *
 * Takes a RUN id and resolves its event-bus ROOT itself. A nested orchestrate
 * child inherits its parent's root, so `runId !== rootRunId` is normal; passing
 * the run id straight through read a sink that does not exist and reported "no
 * events recorded yet" for perfectly healthy nested work (OV3-EVENT-SCOPE).
 *
 * The returned events are scoped to the ones this RUN emitted (issue #331).
 * Several detached runs can share one root, and returning the whole root made
 * every one of them show its siblings' activity as its own; the log used to
 * carry a `shared event root · may include sibling runs` caveat admitting it.
 * `eventEmittedBy` resolves that against `BusEvent.ancestorPath`, so the caveat
 * is gone rather than merely made conditional.
 */
export function readRunEventTail(
	agentDir: string,
	runId: string,
): { events: RunEventRecord[]; truncated: boolean } {
	const cfg = loadDetachedCfg(agentDir, runId);
	const taskAttempt = cfg?.restartAttempts ?? 0;
	const rootRunId = cfg?.rootRunId ?? runId;
	const tail = readBusEventTail(agentDir, rootRunId);
	const events: RunEventRecord[] = [];
	for (const event of tail.events) {
		if (!eventEmittedBy(event, runId)) continue;
		if (!Number.isFinite(event.ts)) continue;
		const fields = event.fields ?? {};
		const phase = safeCategorical(fields.phase, SAFE_EVENT_PHASES);
		// `fields.kind` is the run's outcome, a different axis from the event's
		// own kind: a `completed` event carries `kind: "failed"` when it failed.
		const outcome = event.kind === "completed"
			? safeCategorical(fields.kind, SAFE_EVENT_OUTCOMES)
			: undefined;
		const tools = Number.isInteger(fields.tools) && (fields.tools as number) >= 0
			? (fields.tools as number)
			: undefined;
		const pid = positivePid(event.pid);
		const taskProgress = readTaskProgressForAttempt(fields, taskAttempt);
		events.push({
			ts: event.ts,
			kind: event.kind,
			...(phase ? { phase } : {}),
			...(outcome ? { outcome } : {}),
			...(tools === undefined ? {} : { tools }),
			...(pid === undefined ? {} : { pid }),
			...(taskProgress === undefined ? {} : { taskProgress }),
		});
	}
	return { events, truncated: tail.truncated };
}

/**
 * Uniform run RESULT (REQ-INTRO-3). A completed run's collapsed output from the
 * unified source — the in-memory final result OR the orchestrate results /
 * pending record.
 */
export interface UniformRunResult {
	runId: string;
	shape: RunShape;
	state: UniformRunState;
	source: RunSource;
	/** Collapsed terminal text (orchestrate `output`, or in-process combined). */
	output?: string;
	/** In-process per-entry results, when the run is in-memory. */
	forks?: RunResult[];
	/** Aggregate token/cost usage for in-process runs, when available. */
	usage?: DelegateUsageTotals;
	/** The raw detached driver result, canonicalized from the legacy wire record. */
	driver?: OrchestrateResult;
	/** @deprecated Internal compatibility alias; public tool results do not expose it. */
	orchestrate?: OrchestrateResult;
	/** Failure detail when `state` is `terminal-failed`. */
	error?: string;
	/** Shape-specific safe diagnostics (detached orchestrate only). */
	details?: Record<string, unknown>;
	/** Recovery/orphan provenance for a terminal in-process run recovered after owner runtime loss. */
	recovery?: RecoveryProvenanceSummary;
	/** True when the run is not yet terminal (no result to return). */
	pending?: boolean;
}

/**
 * Bound on detached statuses returned and on each incremental active/history
 * scan leg (REQ-INTRO-5). This prevents a runaway runtime dir from making
 * `delegate_status` perform unbounded work; omission sets `truncated`.
 */
export const MAX_DETACHED_SCAN = 64;
/** Stale marker inspection ceiling; terminal/stale entries do not consume row budget. */
export const MAX_ACTIVE_MARKER_INSPECTIONS = MAX_DETACHED_SCAN * 16;

/** Maximum event-bus tail bytes read per root during status introspection. */
export const MAX_STATUS_EVENT_BYTES = 256 * 1024;

/**
 * pid-liveness probe (node B, `staleness-reconciliation`). The reader uses this
 * to decide whether a detached run with NO terminal record is still alive or
 * crashed. The default is the spec-0005 / spec-0004 `pidAlive` (a `kill(pid,0)`
 * existence probe re-exported from both `detached-spawn` and `event-bus`); node
 * B REUSES that primitive rather than adding a fresh `kill(pid,0)`
 * [decision: staleness-reuse-pidalive-document-reuse-hazard]. The signature is
 * threaded as an OPTIONAL override through the public resolvers so a unit test
 * can inject `() => false` / `() => true` deterministically without spawning a
 * real process; production callers (`delegate_status` / `delegate_result`) pass
 * nothing and get the real probe.
 *
 * ## pid-reuse residual (documented, NOT closed here)
 *
 * A bare pid number is ambiguous: once the detached child exits, the OS may
 * recycle its pid for an unrelated process, so a dead run's pid can read
 * `alive` again → a false `running`. This window is real but bounded, and node
 * B deliberately does NOT attempt to close it. Two mitigations keep the
 * exposure small: (1) the terminal RECORD is always the PRIMARY signal —
 * pid-liveness is consulted ONLY as the no-record fallback, so a run that wrote
 * a result is never subject to pid-reuse; (2) the candidate hardening (a
 * deferred follow-up) is to pair the pid with the child's start-time / a
 * session-nonce (an `owningPid` + start-time tuple) so a recycled pid is
 * detectable. That hardening is out of scope for this spec.
 */
export type PidAliveFn = (pid: number) => boolean;

/**
 * Spec 0014 / REQ-OWN-2 — injectable route-record reader for the detached-leg
 * owner-scope of `listAllRunStatuses`. The detached cfg files live in a SHARED
 * dir (every session's orchestrate children write there), so the scan can see
 * a FOREIGN session's detached run. The owner signal is the per-run `0600`
 * route record's `ownerSessionId` (the same signal `resolveRunControl` uses for
 * the REQ-CTRL-5 same-user-sibling guard). Defaults to the real reader; tests
 * inject a fake. Returns `null` when the record is absent/unreadable.
 */
export type RouteRecordReader = (
	agentDir: string,
	runId: string,
) => { ownerSessionId: string } | null;

// ── In-memory (in-process) mapping ─────────────────────────────────────────


function retryFacts(run: NonNullable<ReturnType<typeof getRunSnapshot>>): {
	retryForkCount: number;
	maxAttempt: number;
	incomplete: boolean;
	truncated: boolean;
	projections: Array<Record<string, unknown>>;
} {
	const allRuns = listRunSnapshots();
	const lookup = (runId: string, forkName: string): RetryProjectionFork | undefined => {
		const source = (runId === run.runId ? run : allRuns.find((candidate) => candidate.runId === runId))?.forks[forkName];
		return source ? ({ ...source, runId, usage: source.completedResult?.usage ?? source.usage } as unknown as RetryProjectionFork) : undefined;
	};
	const orderedForks = run.finalResult && run.finalResult.length > 0
		? run.finalResult.flatMap((result) => run.forks[result.name] ? [run.forks[result.name]!] : [])
		: Object.values(run.forks);
	const projection = buildRetryProjection(
		orderedForks.map((fork) => ({ ...fork, runId: run.runId, usage: fork.completedResult?.usage ?? fork.usage }) as unknown as RetryProjectionFork),
		lookup,
	);
	return {
		retryForkCount: projection.retryForkCount,
		maxAttempt: projection.maxAttempt,
		incomplete: projection.retryMetadataIncomplete,
		truncated: projection.retryMetadataTruncated,
		projections: projection.entries.map((entry) => ({ ...entry })),
	};
}


/**
 * Canonical terminal-state classifier shared by `inMemoryStatus` and the #465
 * result-sidecar fallback, so the two can never diverge (CR-SIDECAR-STATE-FIDELITY).
 *
 * From the terminal entry statuses (the recorded verdict, or live entries when no
 * verdict exists):
 *  - `terminal-done` only when there is at least one status and every one is
 *    `completed` — an EMPTY status set is a catastrophic completion, NOT success;
 *  - `terminal-paused` when the run did not finish cleanly but every non-done
 *    entry is merely `paused` (Spec 0019 / REQ-PAUSE-4 — a pause is terminal but
 *    not an error, and must not be folded into `terminal-failed`);
 *  - `terminal-failed` otherwise (any `failed`/`aborted`, or an empty set).
 */
function classifyTerminalRunState(statuses: readonly string[]): UniformRunState {
	const allDone = statuses.length > 0 && statuses.every((s) => s === "completed");
	if (allDone) return "terminal-done";
	const anyFailedOrAborted = statuses.some((s) => s === "failed" || s === "aborted");
	const anyPaused = statuses.some((s) => s === "paused");
	if (anyPaused && !anyFailedOrAborted) return "terminal-paused";
	return "terminal-failed";
}

/**
 * Map an in-memory run snapshot to the uniform status. The run's `completedAt`
 * is the authoritative terminality signal; absent it, an entry still
 * `constructing` makes the run `constructing`, otherwise `running`. A completed
 * run is `terminal-done` unless any entry is non-`completed` (failed / aborted),
 * in which case `terminal-failed`.
 */
function inMemoryStatus(run: NonNullable<ReturnType<typeof getRunSnapshot>>): UniformRunStatus {
	const entries = Object.values(run.forks);
	// Shape metadata is authoritative. Missing or future values remain unknown;
	// entry names and counts cannot prove how the run was dispatched.
	const shape: RunShape = run.shape === "supervised" || run.shape === "direct" || run.shape === "chain"
		? run.shape
		: "unknown";

	let state: UniformRunState;
	if (run.completedAt !== undefined) {
		// Terminality verdict comes from the recorded `finalResult` (the authoritative
		// outcome) when present; the live `forks` map can lag / diverge from it. Fall
		// back to the live entry statuses only when no finalResult was recorded.
		const verdict = run.finalResult ?? [];
		const statuses = verdict.length > 0
			? verdict.map((r) => r.status)
			: entries.map((entry) => entry.status);
		state = classifyTerminalRunState(statuses);
	} else if (entries.some((entry) => entry.status === "constructing" || entry.status === "pending")) {
		state = "constructing";
	} else {
		state = "running";
	}

	const lastActivityAt = entries.reduce<number | undefined>((acc, entry) => {
		// Spec 0024 / REQ-LIVE-2..5 — while an entry is LIVE (non-terminal), prefer
		// its propagated `lastActivityAt` (real worker-channel activity) so the
		// status elapsed advances instead of freezing at the dispatch gap, and a
		// genuinely silent live entry's elapsed stops advancing at its last bump.
		// A TERMINAL entry ignores `lastActivityAt` and reports its real
		// `endedAt`-based duration (REQ-LIVE-3). An entry with NO `lastActivityAt`
		// (legacy / never-wired) falls back to `endedAt ?? startedAt` (REQ-LIVE-4).
		const raw =
			isLiveStatus(entry.status) && entry.lastActivityAt !== undefined
				? entry.lastActivityAt
				: (entry.endedAt ?? entry.startedAt);
		const t = finiteTimestamp(raw);
		if (t === undefined) return acc;
		return acc === undefined ? t : Math.max(acc, t);
	}, finiteTimestamp(run.completedAt));
	const recovery = summarizeRecoveryProvenance(run);
	const retry = run.shape === "chain"
		? { retryForkCount: 0, maxAttempt: 1, incomplete: false, truncated: false, projections: [] as Array<Record<string, unknown>> }
		: retryFacts(run);
	const safeRecovery = recovery
		? {
				recovered: true,
				partial: recovery.partial === true,
				...(typeof recovery.orphanedAt === "number" && Number.isFinite(recovery.orphanedAt)
					? { orphanedAt: recovery.orphanedAt }
					: {}),
				...(typeof recovery.syncOrphanRecoverySurfacedAt === "number" &&
				Number.isFinite(recovery.syncOrphanRecoverySurfacedAt)
					? { syncOrphanRecoverySurfacedAt: recovery.syncOrphanRecoverySurfacedAt }
					: {}),
				totalForks: Math.max(0, Math.trunc(Number(recovery.totalForks) || 0)),
				recoveredForks: Math.max(0, Math.trunc(Number(recovery.recoveredForks) || 0)),
				completedForks: Math.max(0, Math.trunc(Number(recovery.completedForks) || 0)),
				pausedForks: Math.max(0, Math.trunc(Number(recovery.pausedForks) || 0)),
				failedForks: Math.max(0, Math.trunc(Number(recovery.failedForks) || 0)),
				abortedForks: Math.max(0, Math.trunc(Number(recovery.abortedForks) || 0)),
			}
		: undefined;

	return {
		runId: run.runId,
		shape,
		state,
		source: "in-memory",
		startedAt: finiteTimestamp(run.createdAt),
		lastActivityAt,
		details: {
			// Runtime persistence is a trust boundary. Expose only aggregate,
			// numeric/categorical facts — never hydrated entry/agent names or raw
			// status strings through delegate_status.details.
			forkCount: entries.length,
			...(run.shape === "chain" ? {} : {
				retryForkCount: retry.retryForkCount,
				maxAttempt: retry.maxAttempt,
				...(retry.incomplete ? { retryMetadataIncomplete: true } : {}),
				...(retry.truncated ? { retryMetadataTruncated: true } : {}),
			}),
			usage: aggregateRunStateUsage(run),
			...(safeRecovery ? { recovery: safeRecovery } : {}),
			...(typeof run.detached === "boolean" ? { detached: run.detached } : {}),
		},
	};
}

/** Map an in-memory run snapshot to the uniform result. */
function inMemoryResult(run: NonNullable<ReturnType<typeof getRunSnapshot>>): UniformRunResult {
	const status = inMemoryStatus(run);
	if (run.completedAt === undefined || !run.finalResult) {
		const retry = run.shape === "chain"
			? { retryForkCount: 0, maxAttempt: 1, incomplete: false, truncated: false, projections: [] as Array<Record<string, unknown>> }
			: retryFacts(run);
		return {
			runId: run.runId,
			shape: status.shape,
			state: status.state,
			source: "in-memory",
			pending: true,
			...(run.shape === "chain" ? {} : { details: { retry: retry.projections, retryMetadataIncomplete: retry.incomplete, retryMetadataTruncated: retry.truncated } }),
		};
	}
	// Populate `output` from the per-entry collapsed content so a caller reading
	// the uniform `.output` field gets a useful value for BOTH transports (the
	// detached path sets `output` from the orchestrate result). The tool may
	// still re-derive richer combined content from `forks`.
	const output = run.finalResult
		.map((r) => r.collapsedContent)
		.filter((c) => typeof c === "string" && c.length > 0)
		.join("\n\n");
	const retry = run.shape === "chain"
		? { retryForkCount: 0, maxAttempt: 1, incomplete: false, truncated: false, projections: [] as Array<Record<string, unknown>> }
		: retryFacts(run);
	return {
		runId: run.runId,
		shape: status.shape,
		state: status.state,
		source: "in-memory",
		output: output || undefined,
		forks: run.finalResult,
		usage: aggregateRunResults(run.finalResult),
		error: status.state === "terminal-failed" ? "one or more entries did not complete" : undefined,
		...(run.shape === "chain" ? {} : { details: { retry: retry.projections, retryMetadataIncomplete: retry.incomplete, retryMetadataTruncated: retry.truncated } }),
		recovery: summarizeRecoveryProvenance(run),
	};
}

// ── Detached (orchestrate) mapping ─────────────────────────────────────────

/**
 * A detached orchestrate cfg record, parsed best-effort from the cfg dir. The
 * cfg file is written for EVERY detached dispatch (at spawn time) regardless of
 * completion, so the cfg dir is the enumeration source for detached runs.
 */
interface DetachedCfgLite {
	runId: string;
	rootRunId: string;
	/** Durable dispatch time; legacy records fall back to the cfg mtime. */
	startedAt?: number;
	ownerSessionId?: string;
	/** Public provider/model reference; prompt-bearing cfg fields stay unread by callers. */
	model?: string;
	/** Trusted runner-attempt counter; legacy records default to attempt zero. */
	restartAttempts: number;
}

/** Read one detached cfg file best-effort. Returns undefined on any read/parse failure. */
function readDetachedCfg(file: string): DetachedCfgLite | undefined {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<DetachedCfgLite>;
		if (!parsed || typeof parsed.runId !== "string" || !isSafeRunId(parsed.runId)) {
			return undefined;
		}
		let cfgMtime: number | undefined;
		try {
			const mtime = fs.statSync(file).mtimeMs;
			if (Number.isFinite(mtime) && mtime > 0) cfgMtime = mtime;
		} catch {
			/* parsed cfg remains useful without a stat */
		}
		return {
			runId: parsed.runId,
			rootRunId:
				typeof parsed.rootRunId === "string" && isSafeRunId(parsed.rootRunId)
					? parsed.rootRunId
					: parsed.runId,
			ownerSessionId:
				typeof parsed.ownerSessionId === "string" ? parsed.ownerSessionId : undefined,
			model: typeof parsed.model === "string" ? parsed.model : undefined,
			restartAttempts:
				Number.isSafeInteger(parsed.restartAttempts) && (parsed.restartAttempts as number) >= 0
					? (parsed.restartAttempts as number)
					: 0,
			startedAt:
				typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
					? parsed.startedAt
					: cfgMtime,
		};
	} catch {
		return undefined;
	}
}

/** Locate the detached cfg for a runId by reading its conventional cfg file. */
function loadDetachedCfg(agentDir: string, runId: string): DetachedCfgLite | undefined {
	// Path-traversal guard (MR !2 review finding #1): runId may be tool-supplied.
	if (!isSafeRunId(runId)) return undefined;
	const cfgFile = path.join(resolveOrchestrateCfgDir(agentDir), `${runId}.cfg.json`);
	const cfg = readDetachedCfg(cfgFile);
	return cfg?.runId === runId ? cfg : undefined;
}

const SAFE_CHILDLOG_FIELD = /^(?:id|runId|rootRunId|phase|status|state|kind|reason|name|method|command|success|terminal|willRetry|toolName|event|code|exitCode|signal|signalCode|pid|runnerPid|parentPid|count|index|attempt|durationMs|timestamp|startedAt|finishedAt|version|remainingPasses|active|streaming)$/;
const SAFE_CHILDLOG_TERMINALS = new Set(["done", "failed"]);
const SAFE_CHILDLOG_REASONS = new Set(["agent_end", "process_exit", "stalled"]);

interface ChildLogProjection {
	tail?: string;
	lastActivityAt?: number;
	startupPhase: DetachedStartupPhase;
	stderrPresent: boolean;
	stderrTruncated: boolean;
	exitProvenance: DetachedExitProvenance;
}

function safeChildLogString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.slice(0, 256).replace(/[\r\n]/g, "\\n");
}

function safeChildLogScalar(value: unknown): null | boolean | number | string | undefined {
	if (value === null) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return safeChildLogString(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
	let out = value;
	while (Buffer.byteLength(out, "utf8") > maxBytes && out.length > 0) {
		out = out.slice(0, -1);
	}
	return out;
}

function boundChildLogLines(lines: string[], maxBytes: number, maxLines: number): string {
	const kept: string[] = [];
	let bytes = 0;
	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const line = lines[i]!;
		const separatorBytes = kept.length > 0 ? 1 : 0;
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (bytes + separatorBytes + lineBytes <= maxBytes) {
			kept.unshift(line);
			bytes += separatorBytes + lineBytes;
			continue;
		}
		const remaining = maxBytes - bytes - separatorBytes;
		if (remaining > 0) kept.unshift(truncateUtf8(line, remaining));
		break;
	}
	return kept.join("\n");
}

function readChildLogBytes(file: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		const size = fs.statSync(file).size;
		const bytes = Math.min(Math.max(0, maxBytes), size);
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
		return undefined;
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

function projectChildLogFallback(body: string): string | undefined {
	const match = /^rpc\.event type=([^ ]+) payload=(.+)$/.exec(body);
	if (!match) return undefined;
	const type = safeChildLogString(match[1]);
	if (!type) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[2]!);
	} catch {
		return `rpc.event type=${type}`;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return `rpc.event type=${type}`;
	}
	const safe: Record<string, null | boolean | number | string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "[omitted]") continue;
		if (!SAFE_CHILDLOG_FIELD.test(key)) continue;
		const scalar = safeChildLogScalar(value);
		if (scalar !== undefined) safe[key] = scalar;
	}
	const serialized = JSON.stringify(safe);
	return `rpc.event type=${type} payload=${serialized}`;
}

function projectChildLogBody(body: string): {
	line?: string;
	phase?: DetachedStartupPhase;
	activity?: boolean;
	exit?: DetachedExitProvenance;
	stderr?: boolean;
	stderrTruncated?: boolean;
} {
	if (body === "turn.start") return { line: body, phase: "session", activity: true };
	if (body.startsWith("tool.start name=") || body.startsWith("tool.end name=")) {
		const marker = body.startsWith("tool.start") ? "tool.start name=" : "tool.end name=";
		const name = safeChildLogString(body.slice(marker.length)) ?? "unknown";
		return { line: `${marker}${name}`, phase: "model", activity: true };
	}
	if (body.startsWith("message.end") || body.startsWith("turn.end")) {
		return { phase: "model", activity: true };
	}
	if (body.startsWith("rpc.response")) {
		const match = /^rpc\.response command=(.*?) success=(true|false)$/.exec(body);
		if (match) {
			const command = safeChildLogString(match[1]) ?? "unknown";
			return {
				line: `rpc.response command=${command} success=${match[2]}`,
				phase: "post-handshake",
				activity: true,
			};
		}
		return { line: "rpc.response", phase: "post-handshake", activity: true };
	}
	if (body.startsWith("ui.request")) {
		return { line: "ui.request", phase: "post-handshake", activity: true };
	}
	if (body.startsWith("rpc.event type=runner_start")) {
		return { line: "rpc.event type=runner_start", activity: true };
	}
	if (body.startsWith("rpc.event type=runner_terminal")) {
		const match = /^rpc\.event type=runner_terminal terminal=([^ ]+) reason=([^ ]+)$/.exec(body);
		if (!match) return { activity: true, exit: "unknown" };
		const terminal = SAFE_CHILDLOG_TERMINALS.has(match[1]!) ? match[1] : "unknown";
		const reason = SAFE_CHILDLOG_REASONS.has(match[2]!) ? match[2] : "unknown";
		const exit = reason === "stalled" ? "stalled" : reason === "process_exit" ? "process-exit" : "none";
		return {
			line: `rpc.event type=runner_terminal terminal=${terminal} reason=${reason}`,
			activity: true,
			exit,
		};
	}
	if (body.startsWith("pi.stderr ")) {
		return {
			stderr: true,
			stderrTruncated: body.includes("stderr truncated at"),
		};
	}
	const fallback = projectChildLogFallback(body);
	if (fallback) return { line: fallback, phase: "post-handshake", activity: true };
	return {};
}

/** Read and safely project a bounded childlog tail. Missing/unreadable logs degrade to undefined. */
export function readChildLogProjection(
	file: string,
	opts: { maxBytes?: number; maxLines?: number } = {},
): ChildLogProjection | undefined {
	const maxBytes = Math.min(MAX_CHILDLOG_TAIL_BYTES, Math.max(0, opts.maxBytes ?? DEFAULT_CHILDLOG_TAIL_BYTES));
	const maxLines = Math.min(MAX_CHILDLOG_TAIL_LINES, Math.max(0, Math.trunc(opts.maxLines ?? DEFAULT_CHILDLOG_TAIL_LINES)));
	const raw = readChildLogBytes(file, maxBytes);
	if (raw === undefined) return undefined;
	const lines: string[] = [];
	let lastActivityAt: number | undefined;
	let phase: DetachedStartupPhase = "pre-connect";
	let phaseRank = 0;
	let stderrPresent = false;
	let stderrTruncated = false;
	let exitProvenance: DetachedExitProvenance = "none";
	for (const rawLine of raw.split("\n")) {
		if (!rawLine) continue;
		const match = /^\[([^\]]+)\] (.*)$/.exec(rawLine);
		if (!match) continue;
		const timestamp = Date.parse(match[1]!);
		if (Number.isFinite(timestamp)) {
			lastActivityAt = lastActivityAt === undefined ? timestamp : Math.max(lastActivityAt, timestamp);
		}
		const projected = projectChildLogBody(match[2]!);
		if (projected.stderr) stderrPresent = true;
		if (projected.stderrTruncated) stderrTruncated = true;
		if (projected.exit && projected.exit !== "none") exitProvenance = projected.exit;
		if (projected.phase) {
			const rank = projected.phase === "post-handshake" ? 1 : projected.phase === "session" ? 2 : 3;
			if (rank >= phaseRank) {
				phase = projected.phase;
				phaseRank = rank;
			}
		}
		if (projected.line) lines.push(`[${match[1]}] ${projected.line}`);
	}
	return {
		...(maxLines > 0 ? { tail: boundChildLogLines(lines, maxBytes, maxLines) } : { tail: "" }),
		...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
		startupPhase: phase,
		stderrPresent,
		stderrTruncated,
		exitProvenance,
	};
}

function detachedChildLogPath(agentDir: string, runId: string): string | undefined {
	return isSafeRunId(runId)
		? path.join(resolveOrchestrateLogsDir(agentDir), `${runId}.childlog`)
		: undefined;
}

function providerModel(model: string | undefined): { provider: string; model: string } {
	if (typeof model !== "string" || model.length === 0) {
		return { provider: "unknown", model: "unknown" };
	}
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		return { provider: "unknown", model: model.slice(0, 256) };
	}
	return {
		provider: model.slice(0, slash).slice(0, 256),
		model: model.slice(slash + 1, slash + 257),
	};
}

function detachedDiagnostics(
	agentDir: string,
	runId: string,
	cfg: DetachedCfgLite | undefined,
	activity: { firstEventAt?: number; lastEventAt?: number },
	terminalReason: string | undefined,
	options: ChildLogSurfaceOptions = {},
): Record<string, unknown> {
	const childlogPath = detachedChildLogPath(agentDir, runId);
	if (!childlogPath) return {};
	const includeTail = options.includeTail === true;
	if (!includeTail) return { childlogPath };
	const identity = providerModel(cfg?.model);
	const fullTail = options.fullTail === true || options.tailLines !== undefined;
	const projection = includeTail
		? readChildLogProjection(childlogPath, {
				maxBytes: fullTail ? MAX_CHILDLOG_TAIL_BYTES : DEFAULT_CHILDLOG_TAIL_BYTES,
				maxLines: clampChildLogTailLines(options.tailLines, fullTail),
			})
		: undefined;
	const activityAt = Math.max(
		...(cfg?.startedAt !== undefined ? [cfg.startedAt] : []),
		...(activity.firstEventAt !== undefined ? [activity.firstEventAt] : []),
		...(activity.lastEventAt !== undefined ? [activity.lastEventAt] : []),
		...(projection?.lastActivityAt !== undefined ? [projection.lastActivityAt] : []),
	);
	const startupPhase = projection?.startupPhase ?? "pre-connect";
	const exitProvenance =
		projection?.exitProvenance && projection.exitProvenance !== "none"
			? projection.exitProvenance
			: terminalReason === "child-stalled"
			? "stalled"
			: terminalReason === "runner-exited"
				? "runner-exit"
				: terminalReason === "child-exit"
					? "process-exit"
					: "none";
	return {
		childlogPath,
		provider: identity.provider,
		model: identity.model,
		startupPhase,
		...(Number.isFinite(activityAt) ? { lastActivityAt: activityAt } : {}),
		...(projection
			? {
					stderrPresent: projection.stderrPresent,
					stderrTruncated: projection.stderrTruncated,
					exitProvenance,
					childlogTail: projection.tail ?? "",
				}
			: { exitProvenance }),
	};
}

interface EventTail {
	events: BusEvent[];
	truncated: boolean;
	terminalSummary: BusTerminalSummary;
}

type EventTailCache = Map<string, EventTail>;

const STATUS_BUS_EVENT_KINDS = new Set(["started", "updated", "completed"]);

/** Runtime guard for persisted NDJSON before any field reaches status details. */
function isStatusBusEvent(value: unknown): value is BusEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<BusEvent>;
	return (
		typeof event.ts === "number" &&
		Number.isFinite(event.ts) &&
		typeof event.lineagePath === "string" &&
		typeof event.kind === "string" &&
		STATUS_BUS_EVENT_KINDS.has(event.kind) &&
		typeof event.pid === "number" &&
		Number.isInteger(event.pid) &&
		event.pid > 0 &&
		typeof event.depth === "number" &&
		Number.isFinite(event.depth) &&
		// Absent is valid — pre-field sink lines are read-tolerated — but a
		// PRESENT non-string is not. This guard is why the rest of the module
		// may treat `ancestorPath` as `string | undefined` and call string
		// methods on it; `event-bus.ts` validates the same field the same way.
		(event.ancestorPath === undefined || typeof event.ancestorPath === "string") &&
		(event.pidStartTicks === undefined || isValidProcessStartTicks(event.pidStartTicks)) &&
		(event.pidBootId === undefined || isValidProcessBootId(event.pidBootId)) &&
		(event.pidNonce === undefined || isValidProcessNonce(event.pidNonce))
	);
}

/**
 * Read at most MAX_STATUS_EVENT_BYTES from the END of one root event file.
 * A per-enumeration cache guarantees shared-root cfgs perform this bounded I/O
 * once per refresh, never once per cfg. Missing/garbage files degrade to an
 * empty tail and never perturb the foreground.
 */
function readBusEventTail(
	agentDir: string,
	rootRunId: string,
	cache?: EventTailCache,
): EventTail {
	const cached = cache?.get(rootRunId);
	if (cached) return cached;
	let fd: number | undefined;
	let result: EventTail;
	try {
		const file = path.join(resolveEventSinkDir(agentDir, rootRunId), "events.ndjson");
		const size = fs.statSync(file).size;
		const bytes = Math.min(size, MAX_STATUS_EVENT_BYTES);
		const start = Math.max(0, size - bytes);
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(bytes);
		const read = bytes > 0 ? fs.readSync(fd, buffer, 0, bytes, start) : 0;
		let raw = buffer.toString("utf8", 0, read);
		if (start > 0) {
			// The tail may begin in the middle of an NDJSON line; discard only
			// that partial line. Starting exactly at a boundary may sacrifice one
			// complete event, which is safe for a bounded latest-activity view.
			const newline = raw.indexOf("\n");
			raw = newline >= 0 ? raw.slice(newline + 1) : "";
		}
		const events: BusEvent[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isStatusBusEvent(parsed)) events.push(parsed);
			} catch {
				/* skip garbage line; best-effort */
			}
		}
		result = {
			events,
			truncated: start > 0,
			terminalSummary: readBusTerminalSummary(agentDir, rootRunId),
		};
	} catch {
		result = {
			events: [],
			truncated: false,
			terminalSummary: readBusTerminalSummary(agentDir, rootRunId),
		};
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
	}
	cache?.set(rootRunId, result);
	return result;
}

interface DetachedActivitySummary {
	firstEventAt?: number;
	lastEventAt?: number;
	activityPid?: number;
	phase?: string;
	lastEventKind?: BusEvent["kind"];
	taskProgress?: TaskProgressFields;
	eventCount: number;
	eventTailTruncated?: boolean;
}

const SAFE_DETACHED_PHASES = new Set(["boot", "running", "cancel-wind-down", "terminal"]);

function canonicalDetachedPhase(event: BusEvent): string {
	const candidate = event.fields?.phase;
	return typeof candidate === "string" && SAFE_DETACHED_PHASES.has(candidate)
		? candidate
		: event.kind;
}

/** Fixed privacy-safe status reason; raw terminal errors stay result-only. */
function classifyDetachedFailure(error: unknown): string {
	const value = typeof error === "string" ? error.toLowerCase() : "";
	if (value.includes("runner-exited")) return "runner-exited";
	if (value.includes("stalled") || value.includes("no rpc events")) return "child-stalled";
	if (value.includes("failed to spawn") || value.includes("spawn error")) return "spawn-failed";
	if (value.includes("exit code") || value.includes("process exited") || value.includes("signal")) {
		return "child-exit";
	}
	if (value.includes("cancel") || value.includes("abort")) return "cancelled";
	return "failed";
}

/**
 * The `runId` half of one `ancestorPath` segment (`runId#childIndex`).
 *
 * `SAFE_RUN_ID_RE` (`src/run-id.ts`) admits only `[\w-]`, so a run id can never
 * contain `#` and the last one always separates the sibling ordinal.
 */
function segmentRunId(segment: string): string {
	const hash = segment.lastIndexOf("#");
	return hash === -1 ? segment : segment.slice(0, hash);
}

/**
 * Was this event emitted by run `runId` ITSELF (issue #331)?
 *
 * `ancestorPath` is the emitter's full root→self chain and its LAST segment is
 * always the emitter's own `runId#childIndex`. That holds for both shapes that
 * reach a sink: the in-process ALS id-path accumulated by `runWithDepth`, and
 * the leaf-only `rootRunId/runId#childIndex` that `lineageAncestorPath` falls
 * back to when a frame was rebuilt across a process boundary without an
 * `idPath` — which is exactly the detached case this issue is about.
 *
 * OWN events only, deliberately, NOT own-plus-descendants:
 *
 *   - The status card shows one `pid` beside the phase. A pid identifies a
 *     single process, so a descendant-inclusive phase would re-create the very
 *     conflation being fixed, just along the parent/child axis instead of the
 *     sibling one.
 *   - Counts stay additive: the rows sum to the root's total instead of
 *     double-counting nested work.
 *   - The "an idle-looking parent reads as hung" objection does not apply here:
 *     a supervising run emits a periodic `updated`/`running` heartbeat for
 *     exactly that reason (REQ-PICLI-5, `orchestrate-runner.ts`), so a busy
 *     parent stays observably alive on its own events.
 *   - Detached descendants each get their own cfg and therefore their own row,
 *     so scoping hides no work — it files it under the run that did it.
 *
 * An ABSENT `ancestorPath` is non-descendant, per the field's documented read
 * tolerance in `event-bus.ts`: sink lines written before the field existed
 * cannot be attributed, and counting them under every run is the bug.
 */
function eventEmittedBy(event: BusEvent, runId: string): boolean {
	const { ancestorPath } = event;
	// `isStatusBusEvent` already drops a persisted line whose `ancestorPath` is
	// present but not a string, so this is belt-and-braces rather than the same
	// check twice: it keeps the helper TOTAL for any caller that builds a
	// `BusEvent` from somewhere other than the sink parser. Trusting the
	// declared type over the parser that produces it is what made a malformed
	// line throw here in the first place (CR-ANCESTORPATH-TYPE-GUARD).
	if (typeof ancestorPath !== "string") return false;
	const lastSlash = ancestorPath.lastIndexOf("/");
	const leaf = lastSlash === -1 ? ancestorPath : ancestorPath.slice(lastSlash + 1);
	return segmentRunId(leaf) === runId;
}

/**
 * Select only bounded, non-sensitive event metadata for operator surfaces,
 * scoped to the events `runId` itself emitted (issue #331).
 *
 * Filtering happens HERE rather than in `readBusEventTail` so that several runs
 * sharing one root still cost exactly one bounded read per refresh: the cached
 * tail is read once and projected N times.
 */
function summarizeDetachedActivity(tail: EventTail, runId: string, taskAttempt: number): DetachedActivitySummary {
	const events = tail.events.filter((event) => eventEmittedBy(event, runId));
	if (events.length === 0) {
		return { eventCount: 0, ...(tail.truncated ? { eventTailTruncated: true } : {}) };
	}
	let first = events[0]!;
	let latest = events[0]!;
	let latestTaskProgress: TaskProgressFields | undefined;
	let latestTaskProgressAt = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		if (event.ts < first.ts) first = event;
		if (event.ts >= latest.ts) latest = event;
		const taskProgress = readTaskProgressForAttempt(event.fields, taskAttempt);
		if (taskProgress && event.ts >= latestTaskProgressAt) {
			latestTaskProgress = taskProgress;
			latestTaskProgressAt = event.ts;
		}
	}
	return {
		firstEventAt: first.ts,
		lastEventAt: latest.ts,
		activityPid:
			typeof latest.pid === "number" && latest.pid > 0 ? latest.pid : undefined,
		phase: canonicalDetachedPhase(latest),
		lastEventKind: latest.kind,
		...(latestTaskProgress ? { taskProgress: latestTaskProgress } : {}),
		eventCount: events.length,
		...(tail.truncated ? { eventTailTruncated: true } : {}),
	};
}

/** Read only the runner pid from the secret-bearing route record. */
function readDetachedRunnerPid(agentDir: string, runId: string): number | undefined {
	try {
		const pid = readRouteRecord(agentDir, runId)?.pid;
		return positivePid(pid);
	} catch {
		return undefined;
	}
}

function detachedActivityDetails(
	activity: DetachedActivitySummary,
	runnerPid: number | undefined,
): Record<string, unknown> {
	return {
		...(runnerPid !== undefined ? { runnerPid } : {}),
		...(activity.activityPid !== undefined ? { activityPid: activity.activityPid } : {}),
		...(activity.phase ? { phase: activity.phase } : {}),
		...(activity.lastEventKind ? { lastEventKind: activity.lastEventKind } : {}),
		...(activity.taskProgress ? { taskProgress: activity.taskProgress } : {}),
		...(activity.lastEventAt !== undefined ? { lastEventAt: activity.lastEventAt } : {}),
		...(activity.eventTailTruncated ? { eventTailTruncated: true } : {}),
		eventCount: activity.eventCount,
	};
}

/**
 * Map a detached orchestrate run to the uniform status. Resolution order:
 *   1. terminal results-dir record (done/failed) → terminal-*.
 *   2. terminal pending-dir record (hydrate-and-deliver, not yet consumed) →
 *      terminal-*.
 *   3. else the event bus: a fresh emitter → `running` (liveness), with
 *      `lastActivityAt` from the freshest event. BUT (node B,
 *      `staleness-reconciliation`, REQ-INTRO-4) if the latest event's emitter
 *      pid is DEAD, the run crashed without writing a terminal record →
 *      `terminal-failed`, NOT `running` forever.
 *   4. else (no record, no bus activity) → `running` — a cfg exists (spawned)
 *      but no pid has been observed yet, so there is nothing to liveness-probe;
 *      the run is genuinely still constructing/booting.
 *
 * Reader-side staleness reconciliation (REQ-INTRO-4): a detached run is
 * terminal if EITHER its results/pending record is terminal (steps 1/2, the
 * PRIMARY signal) OR its pid is dead (step 3). The terminal RECORD always wins
 * over pid-liveness — a dead pid with a terminal record uses the record
 * (steps 1/2 short-circuit before the pid is ever probed), so a graceful exit
 * that wrote a result is never mis-synthesized as a crash.
 *
 * Returns undefined when there is no cfg AND no record AND no bus dir for the
 * runId (i.e. nothing detached to report).
 */
function resolveDetachedStatus(
	agentDir: string,
	runId: string,
	pidAliveFn: PidAliveFn = pidAlive,
	eventCache?: EventTailCache,
	childLogOptions: ChildLogSurfaceOptions = {},
): UniformRunStatus | undefined {
	const cfg = loadDetachedCfg(agentDir, runId);
	const rootRunId = cfg?.rootRunId ?? runId;
	const eventTail = readBusEventTail(agentDir, rootRunId, eventCache);
	const events = eventTail.events;
	const activity = summarizeDetachedActivity(eventTail, runId, cfg?.restartAttempts ?? 0);
	const runnerPid =
		readDetachedRunnerPid(agentDir, runId) ??
		readOrchestrateActiveMarkerPid(agentDir, cfg?.ownerSessionId, runId);
	const startedAt = cfg?.startedAt ?? activity.firstEventAt;
	const baseDetails = {
		...detachedActivityDetails(activity, runnerPid),
		...detachedDiagnostics(agentDir, runId, cfg, activity, undefined, childLogOptions),
	};

	// (1)/(2): terminal record (results dir is primary; pending dir is the
	// hydrate-and-deliver copy a finished-while-gone child left behind).
	const terminal = readTerminalDetachedRecord(agentDir, runId);
	if (terminal) {
		const state = detachedTerminalState(
			agentDir,
			rootRunId,
			runId,
			terminal,
			events,
			eventTail.terminalSummary,
		);
		const finishedAt = Date.parse(terminal.finishedAt) || undefined;
		const terminalReason =
			terminal.status === "failed"
				? classifyDetachedFailure(terminal.error)
				: state === "terminal-steered"
					? "steered"
					: state === "terminal-paused"
						? "paused"
						: "completed";
		return {
			runId,
			shape: "driver",
			state,
			source: "detached",
			startedAt,
			lastActivityAt: finishedAt ?? activity.lastEventAt,
			details: {
				...baseDetails,
				terminalReason,
				...detachedDiagnostics(agentDir, runId, cfg, activity, terminalReason, childLogOptions),
				...(terminal.usage ? { usage: delegateUsageFromAggregate(terminal.usage) } : {}),
				...(terminal.taskLedger ? { taskLedger: terminal.taskLedger } : {}),
			},
		};
	}

	// (3): bus liveness/phase + reader-side staleness reconciliation
	// (REQ-INTRO-4). The latest event carries the detached emitter's pid (the
	// cfg is written before spawn, so it has NO pid — the bus is the ONLY pid
	// source). With no terminal record, a DEAD pid means the child exited
	// without writing a result (crash / OOM / SIGKILL) → terminal-failed, not
	// `running` forever. A LIVE pid stays `running`. The terminal RECORD branch
	// above already short-circuited, so the record stays primary.
	if (activity.eventCount > 0 && activity.lastEventAt !== undefined) {
		// Scoped to THIS run's events (issue #331). Reading the root-wide latest
		// here gave a run a sibling's `lastActivityAt`, and let a sibling's pid
		// decide this run's liveness — so a quiet run looked alive because a
		// neighbour was, and a run with no events of its own could be declared
		// `running` on a neighbour's timestamp.
		//
		// That also retires the "the latest root-bus event may have been emitted
		// by a descendant whose exit does not mean the hosted driver died" hazard
		// the old fallback had to work around: the fallback pid is now this run's
		// own emitter, never a descendant's or a sibling's.
		const livenessPid = runnerPid ?? activity.activityPid;
		// pid-reuse residual: a recycled pid number reads `alive` → a false
		// `running`. Bounded + not closed here (see `PidAliveFn`); preferring the
		// terminal record over pid-liveness minimizes the exposure.
		const stale =
			typeof livenessPid === "number" &&
			livenessPid > 0 &&
			!pidAliveFn(livenessPid);
		const crashReason = stale ? "runner-exited" : undefined;
		return {
			runId,
			shape: "driver",
			state: stale ? "terminal-failed" : "running",
			source: "detached",
			startedAt,
			lastActivityAt: activity.lastEventAt,
			details: {
				...baseDetails,
				...(stale
					? {
							terminalReason: crashReason,
						}
					: {}),
				...detachedDiagnostics(agentDir, runId, cfg, activity, crashReason, childLogOptions),
			},
		};
	}

	// (4): a cfg exists (spawned) but no record + no bus yet. A route record
	// already carries the runner pid, so reconcile it when available; a legacy
	// cfg with no route remains conservatively running while it boots. A readable
	// route also preserves abrupt-death reconciliation if the cfg itself became
	// malformed after dispatch.
	if (cfg || runnerPid !== undefined) {
		const stale = runnerPid !== undefined && !pidAliveFn(runnerPid);
		const crashReason = stale ? "runner-exited" : undefined;
		return {
			runId,
			shape: "driver",
			state: stale ? "terminal-failed" : "running",
			source: "detached",
			startedAt,
			details: {
				...baseDetails,
				...(stale ? { terminalReason: crashReason } : {}),
				...detachedDiagnostics(agentDir, runId, cfg, activity, crashReason, childLogOptions),
			},
		};
	}

	return undefined;
}

/**
 * Map a detached terminal record to the uniform terminal state. A `failed`
 * result is `terminal-failed`. A `done` result is `terminal-done` UNLESS the
 * run wound down on a graceful cancel — the runner records that as an
 * `OrchestrateResultDone` but ALSO emits a `completed` bus event whose
 * `fields.kind === "steered"` (src/orchestrate-runner.ts). We consult the bus
 * for that marker and surface `terminal-steered`, so the uniform enum's
 * `terminal-steered` value is actually produced for detached runs (REQ-INTRO-3).
 * Best-effort: a bus read failure simply leaves it as `terminal-done`.
 *
 * The event scan is scoped to `runId`'s OWN `completed` events (issue #331):
 * on a shared root a sibling's graceful cancel used to read as this run's, so
 * an untouched run reported `terminal-steered`.
 *
 * KNOWN REMAINING GAP, deliberately not fixed here: `terminalSummary` comes
 * from the `terminal-paused` / `terminal-steered` sidecar files, which are
 * existence flags in the ROOT sink dir and carry no run identity, so a
 * sibling's pause or steer still reaches every run on the root through
 * `durableSummary`. Scoping those means giving the sidecars a per-run layout in
 * `event-bus.ts` — a writer change with cross-process commutativity
 * implications, separate from this ancestry fix. Tracked as its own issue
 * rather than half-fixed behind a scan that only looks scoped.
 */
function detachedTerminalState(
	agentDir: string,
	rootRunId: string,
	runId: string,
	terminal: OrchestrateResult,
	events?: BusEvent[],
	terminalSummary?: BusTerminalSummary,
): UniformRunStatus["state"] {
	const tail = events && terminalSummary
		? { events, terminalSummary }
		: readBusEventTail(agentDir, rootRunId);
	const terminalEvents = tail.events.filter((event) => eventEmittedBy(event, runId));
	const durableSummary = tail.terminalSummary;
	if (terminal.status === "failed") return "terminal-failed";
	// Spec 0019 / REQ-PAUSE-4 — a paused terminal takes precedence over the
	// steered/done reading: a forced-finish entry is parked, not done.
	if (
		durableSummary.paused ||
		terminalEvents.some(
			(event) =>
				event.kind === "completed" &&
				(event.fields as { kind?: unknown } | undefined)?.kind === "paused",
		)
	) {
		return "terminal-paused";
	}
	return durableSummary.steered || terminalEvents.some(
		(event) =>
			event.kind === "completed" &&
			(event.fields as { phase?: unknown; kind?: unknown } | undefined)?.phase ===
				"terminal" &&
			(event.fields as { kind?: unknown } | undefined)?.kind === "steered",
	)
		? "terminal-steered"
		: "terminal-done";
}

/**
 * Read a detached run's terminal record (results dir, then pending dir) into an
 * `OrchestrateResult`, or undefined when neither exists / both are still
 * `absent`. Both reads are best-effort via `readResultFile`.
 */
function readTerminalDetachedRecord(agentDir: string, runId: string): OrchestrateResult | undefined {
	const resultsState = readResultFile(resolveResultFile(agentDir, runId));
	if (resultsState.state !== "absent") return resultsState.result;
	const pendingState = readResultFile(resolvePendingFile(agentDir, runId));
	if (pendingState.state !== "absent") return pendingState.result;
	return undefined;
}

/** Cheap active-index stale check; avoids parsing full result payloads. */
function hasDetachedTerminalRecordFile(agentDir: string, runId: string): boolean {
	try {
		return (
			fs.existsSync(resolveResultFile(agentDir, runId)) ||
			fs.existsSync(resolvePendingFile(agentDir, runId))
		);
	} catch {
		return false;
	}
}

/** Map a detached orchestrate run to the uniform result. */
function resolveDetachedResult(
	agentDir: string,
	runId: string,
	pidAliveFn: PidAliveFn = pidAlive,
	childLogOptions: ChildLogSurfaceOptions = {},
): UniformRunResult | undefined {
	const cfg = loadDetachedCfg(agentDir, runId);
	const rootRunId = cfg?.rootRunId ?? runId;
	const status = resolveDetachedStatus(agentDir, runId, pidAliveFn, undefined, childLogOptions);
	const terminal = readTerminalDetachedRecord(agentDir, runId);
	if (terminal) {
		const terminalReason = status?.details?.terminalReason;
		const childlogPath = status?.details?.childlogPath;
		const error = terminal.status === "failed" ? terminal.error : undefined;
		const canonicalTerminal: OrchestrateResult = { ...terminal, mode: "driver" };
		return {
			runId,
			shape: "driver",
			state: detachedTerminalState(agentDir, rootRunId, runId, terminal),
			source: "detached",
			output: terminal.status === "done" ? terminal.output : undefined,
			error:
				error &&
				terminalReason === "child-stalled" &&
				typeof childlogPath === "string" &&
				!error.includes(`(childlog: ${childlogPath})`)
					? `${error} (childlog: ${childlogPath})`
					: error,
			details: status?.details,
			usage: terminal.usage ? delegateUsageFromAggregate(terminal.usage) : undefined,
			driver: canonicalTerminal,
			orchestrate: canonicalTerminal,
		};
	}
	// No terminal record: consult the status resolver, which applies node B's
	// dead-pid staleness reconciliation (REQ-INTRO-4). A stale (dead-pid) run
	// reports `terminal-failed` with the synthesized crash error — NOT pending;
	// a live run is still `running` and IS pending (no result to return yet).
	if (status) {
		const crashed = status.state === "terminal-failed";
		const reason =
			(status.details as { terminalReason?: unknown } | undefined)?.terminalReason;
		return {
			runId,
			shape: "driver",
			state: status.state,
			source: "detached",
			details: status.details,
			error: crashed
				? `detached driver ended without a terminal result (${typeof reason === "string" ? reason : "runner-exited"})`
				: undefined,
			pending: crashed ? undefined : true,
		};
	}
	return undefined;
}

// ── Public resolver API ──────────────────────────────────────────────────────

/**
 * Resolve a single runId to the uniform STATUS (REQ-INTRO-1 / REQ-INTRO-2).
 * Resolution order: (a) the in-memory runs map (in-process shapes); (b) else
 * the detached orchestrate record (results / pending / bus). Returns undefined
 * when the runId is unknown to BOTH sources.
 *
 * Fully guarded (REQ-INTRO-6): an fs failure anywhere degrades to whatever
 * could be read — the in-memory branch never touches the disk, so an
 * in-process run remains resolvable even when the detached fs is unreadable.
 *
 * `pidAliveFn` is the OPTIONAL dead-pid staleness probe (REQ-INTRO-4); it
 * defaults to the real `pidAlive` so production callers are unchanged, and is
 * threaded only for deterministic tests. It is consulted ONLY on the detached
 * no-terminal-record fallback (the record stays primary).
 */
export function resolveRunStatus(
	agentDir: string,
	runId: string,
	pidAliveFn: PidAliveFn = pidAlive,
	childLogOptions: ChildLogSurfaceOptions = {},
): UniformRunStatus | undefined {
	// Path-traversal guard (MR !2 review finding #1): a tool-supplied unsafe
	// runId resolves as unknown, never as a path interpolation.
	if (!isSafeRunId(runId)) return undefined;
	try {
		const inMem = getRunSnapshot(runId);
		if (inMem) return inMemoryStatus(inMem);
	} catch {
		/* in-memory read should never throw; guard anyway (no-perturb). */
	}
	try {
		return resolveDetachedStatus(
			agentDir,
			runId,
			pidAliveFn,
			undefined,
			childLogOptions.includeTail === undefined ? { ...childLogOptions, includeTail: true } : childLogOptions,
		);
	} catch {
		return undefined;
	}
}

/**
 * Resolve a single runId to the uniform RESULT (REQ-INTRO-3). Same resolution
 * order as `resolveRunStatus`: in-memory first, then detached. Returns undefined
 * when the runId is unknown to every source. Fully guarded (REQ-INTRO-6).
 * `pidAliveFn` is the OPTIONAL dead-pid staleness probe (REQ-INTRO-4) — same
 * contract as `resolveRunStatus`.
 *
 * A completed run's #465/#470 result sidecar is NOT read here: it is surfaced by
 * `hydrateRuntimeState`, which restores the completed run into memory bound to
 * its generation, so the in-memory branch below already returns it. There is no
 * generation-unbound sidecar read, so a retention-trimmed run resolves to
 * nothing rather than resurrecting a prior generation's result.
 */

export function resolveRunResult(
	agentDir: string,
	runId: string,
	pidAliveFn: PidAliveFn = pidAlive,
	childLogOptions: ChildLogSurfaceOptions = {},
): UniformRunResult | undefined {
	// Path-traversal guard (MR !2 review finding #1): see resolveRunStatus.
	if (!isSafeRunId(runId)) return undefined;
	try {
		const inMem = getRunSnapshot(runId);
		// A completed run is already in memory (live, or restored by hydrate bound
		// to its generation), so the in-memory result is authoritative. No
		// generation-unbound sidecar read happens here (see the note above).
		if (inMem) return inMemoryResult(inMem);
	} catch {
		/* guard (no-perturb). */
	}
	try {
		return resolveDetachedResult(
			agentDir,
			runId,
			pidAliveFn,
			childLogOptions.includeTail === undefined ? { ...childLogOptions, includeTail: true } : childLogOptions,
		);
	} catch {
		return undefined;
	}
}

/** Outcome of the no-runId enumeration (REQ-INTRO-5). */
export interface ListAllRunStatusesResult {
	statuses: UniformRunStatus[];
	/** True when at least one fs read failed and was skipped (soft-error hint). */
	degraded: boolean;
	/** True when a bounded active/history scan omitted additional records. */
	truncated: boolean;
	/** Number of distinct event roots read (at most once each) this refresh. */
	eventRootsRead: number;
}

/**
 * Enumerate uniform status for in-memory and detached orchestrate records
 * (REQ-INTRO-5). Owner-scoped calls read the direct owner-partitioned active
 * index first, then fill the remaining `MAX_DETACHED_SCAN` budget from cfg
 * history. This guarantees old/foreign history cannot hide current live work.
 * Both legs are incremental and bounded; `truncated` explicitly reports an
 * omitted tail, while `degraded` reports unreadable records. A per-refresh
 * event cache reads each root's bounded tail at most once. A detached run
 * already present in memory is not duplicated.
 *
 * `pidAliveFn` is the OPTIONAL dead-pid staleness probe (REQ-INTRO-4), threaded
 * to each detached resolve so a stale (dead-pid) run enumerates as
 * `terminal-failed` rather than `running` forever. Defaults to the real probe.
 *
 * Spec 0014 / REQ-OWN-2 — OWNER-SCOPING. The shared on-disk run registry is
 * hydrated by every pi session (runtime.ts `hydrateRuntimeState`), so the
 * in-memory snapshots include a FOREIGN live session's runs (kept un-orphaned
 * by spec-0006 so the owner can retrieve them); and the detached cfg dir is
 * shared, so the scan can see a FOREIGN session's detached orchestrate run.
 * When `currentSessionId` is provided, BOTH legs are owner-scoped:
 *   - in-memory: drop runs not owned by THIS process (`isOwnedByThisProcess`).
 *   - detached: drop runs whose cfg `ownerSessionId` differs from
 *     `currentSessionId`; legacy cfgs fall back to the route owner. The cfg
 *     keeps this non-secret signal after terminal cleanup deletes the route.
 * The scope is applied INSIDE this function so the `delegate_status` tool and
 * any other caller inherit it; the runId-specific path (`resolveRunStatus`) is
 * intentionally UNCHANGED so an owner can still query its own run by id
 * (REQ-OWN-3). When `currentSessionId` is undefined (e.g. a caller/test that
 * does not owner-scope) the legacy unscoped behavior is preserved.
 * `readRouteRecordFn` is the injectable detached-leg owner reader (defaults to
 * the real `readRouteRecord`). `reclaimStaleMarkers` defaults on for status
 * refreshes; read-only callers such as health pass false while still skipping
 * stale entries so they cannot consume the live-row budget.
 */
export function listAllRunStatuses(
	agentDir: string,
	pidAliveFn: PidAliveFn = pidAlive,
	currentSessionId?: string,
	readRouteRecordFn: RouteRecordReader = readRouteRecord,
	reclaimStaleMarkers = true,
): ListAllRunStatusesResult {
	const statuses: UniformRunStatus[] = [];
	const seen = new Set<string>();
	const eventCache: EventTailCache = new Map();
	let degraded = false;
	let truncated = false;
	let detachedAdded = 0;

	// In-memory runs first — never touches the disk, so always available.
	// REQ-OWN-2: when owner-scoping, drop foreign-owned hydrated runs.
	try {
		for (const run of listRunSnapshots()) {
			if (!isSafeRunId(run.runId)) {
				degraded = true;
				continue;
			}
			if (currentSessionId !== undefined && !isOwnedByThisProcess(run)) continue;
			try {
				statuses.push(inMemoryStatus(run));
				seen.add(run.runId);
			} catch {
				degraded = true;
			}
		}
	} catch {
		degraded = true;
	}

	const resolveDetachedCandidate = (runId: string): UniformRunStatus | undefined => {
		try {
			return resolveDetachedStatus(agentDir, runId, pidAliveFn, eventCache);
		} catch {
			degraded = true;
			return undefined;
		}
	};
	const appendDetached = (status: UniformRunStatus): void => {
		statuses.push(status);
		seen.add(status.runId);
		detachedAdded++;
	};
	const addDetached = (runId: string): void => {
		if (seen.has(runId) || detachedAdded >= MAX_DETACHED_SCAN) return;
		const status = resolveDetachedCandidate(runId);
		if (status) appendDetached(status);
		else degraded = true;
	};

	// Issue #53: owner-partitioned ACTIVE INDEX FIRST. Historical/foreign cfgs
	// can never consume the live-run budget because new dispatches write a
	// non-secret marker under active/<owner-hash>/ before spawn and remove it at
	// terminal. The direct owner directory makes this bounded without scanning
	// every user's history. Legacy/unscoped callers fall through to cfg history.
	if (currentSessionId !== undefined) {
		let activeDir: fs.Dir | undefined;
		const activeOwnerDir = resolveOrchestrateActiveOwnerDir(agentDir, currentSessionId);
		try {
			activeDir = fs.opendirSync(activeOwnerDir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") degraded = true;
		}
		if (activeDir) {
			try {
				let activeInspected = 0;
				for (let ent = activeDir.readSync(); ent !== null; ent = activeDir.readSync()) {
					if (activeInspected >= MAX_ACTIVE_MARKER_INSPECTIONS) {
						truncated = true;
						break;
					}
					activeInspected++;
					if (detachedAdded >= MAX_DETACHED_SCAN) {
						truncated = true;
						break;
					}
					if (!ent.name.endsWith(".json")) continue;
					const runId = ent.name.slice(0, -".json".length);
					if (!isSafeRunId(runId)) {
						degraded = true;
						if (reclaimStaleMarkers) {
							try {
								fs.rmSync(path.join(activeOwnerDir, ent.name), { force: true });
							} catch {
								/* best-effort malformed-marker reclamation */
							}
						}
						continue;
					}
					const cfg = loadDetachedCfg(agentDir, runId);
					let owned = cfg?.ownerSessionId === currentSessionId;
					if (!cfg) {
						try {
							owned = readRouteRecordFn(agentDir, runId)?.ownerSessionId === currentSessionId;
						} catch {
							owned = false;
						}
					}
					if (!owned) {
						// Marker-only or wrong-partition debris is not a run. Reclaim it so
						// repeated refreshes cannot starve a later genuine live candidate.
						if (reclaimStaleMarkers) {
							deleteOrchestrateActiveMarker({ agentDir, ownerSessionId: currentSessionId, runId });
						}
						continue;
					}
					if (hasDetachedTerminalRecordFile(agentDir, runId)) {
						// A durable terminal record makes this a stale live-index entry.
						// Reclaim it before event inspection and let bounded cfg history
						// decide whether to show the row; it must not consume live budget.
						if (reclaimStaleMarkers) {
							deleteOrchestrateActiveMarker({ agentDir, ownerSessionId: currentSessionId, runId });
						}
						continue;
					}
					const status = resolveDetachedCandidate(runId);
					if (!status) {
						if (reclaimStaleMarkers) {
							deleteOrchestrateActiveMarker({ agentDir, ownerSessionId: currentSessionId, runId });
						}
						degraded = true;
						continue;
					}
					if (seen.has(runId)) continue;
					// Live runs and abrupt-death reconciliations (no durable result)
					// retain their markers and receive priority over cfg history.
					appendDetached(status);
				}
			} catch {
				degraded = true;
			} finally {
				try {
					activeDir.closeSync();
				} catch {
					/* best-effort */
				}
			}
		}
	}

	// Fill the remaining bounded budget from cfg history. We do NOT readdirSync
	// the whole dir: opendirSync walks incrementally and reports truncation when
	// another eligible cfg exists after either the inspection or result cap.
	let dir: fs.Dir | undefined;
	try {
		dir = fs.opendirSync(resolveOrchestrateCfgDir(agentDir));
	} catch (err) {
		// Missing dir (no detached run ever spawned) is NOT degradation; any
		// other read failure is.
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") degraded = true;
	}
	if (dir) {
		try {
			let inspected = 0;
			for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) {
				if (inspected >= MAX_DETACHED_SCAN || detachedAdded >= MAX_DETACHED_SCAN) {
					truncated = true;
					break;
				}
				inspected++;
				if (!ent.name.endsWith(".cfg.json")) continue;
				const runId = ent.name.replace(/\.cfg\.json$/, "");
				if (seen.has(runId)) continue;
				// REQ-OWN-2: owner-scope the detached leg. New cfgs retain a
				// non-secret owner id after terminal cleanup removes the route;
				// legacy cfgs fall back to the route record's owner. A foreign run,
				// or one with neither readable owner signal, is skipped fail-closed.
				// Unscoped callers keep the legacy enumerate-all behavior.
				if (currentSessionId !== undefined) {
					let owned = false;
					try {
						// New cfgs retain a NON-SECRET owner id after terminal cleanup
						// deletes the credential-bearing route record. Legacy cfgs fall
						// back to the route owner while it still exists.
						const cfgOwner = loadDetachedCfg(agentDir, runId)?.ownerSessionId;
						if (cfgOwner !== undefined) {
							owned = cfgOwner === currentSessionId;
						} else {
							const rec = readRouteRecordFn(agentDir, runId);
							owned = rec?.ownerSessionId === currentSessionId;
						}
					} catch {
						owned = false;
					}
					if (!owned) continue;
				}
				addDetached(runId);
			}
		} catch {
			degraded = true;
		} finally {
			try {
				dir.closeSync();
			} catch {
				/* best-effort */
			}
		}
	}

	return { statuses, degraded, truncated, eventRootsRead: eventCache.size };
}
