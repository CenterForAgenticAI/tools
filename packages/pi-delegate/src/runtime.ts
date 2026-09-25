/**
 * Process-wide runtime state for delegate dispatch mode.
 *
 * When `delegate` is invoked with `sync: false` (dispatch), the tool
 * returns immediately with a `runId` while the run entries keep running in
 * the background. Consumers (status widget, `delegate_status`,
 * `delegate_result`) read state through this module, and the
 * background promise pushes updates through the same module.
 *
 * Module-level singletons are intentional: the runtime must survive across
 * multiple tool calls and be addressable from three places (the tool
 * execute body, the status widget, the completion notifier).
 *
 * This module has NO dependency on `ExtensionAPI` — pi's event bus is
 * plumbed in via `setEventEmitter()` at session_start so tests can swap it
 * out.
 */

import { lstatSync } from "node:fs";
import * as path from "node:path";
import type { AgentSource } from "./agents.js";
import {
	MAX_SEED_NOTE_CHARS,
	MAX_SEED_TASK_ID_CHARS,
	MAX_SEED_TITLE_CHARS,
	type TaskProgressFields,
} from "./task-seam.js";
import {
	appendActivityStatus,
	MAX_ACTIVITY_HISTORY_ENTRIES,
	normalizeActivityHistory,
	normalizeActivityStatusEntry,
	projectLifecycleActivity,
	type ActivityStatusEntry,
} from "./activity-status.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { readBusEvents, type BusEvent } from "./event-bus.js";
import {
	preserveCorruptFile,
	readJsonFile,
	replaceJsonFile,
	resolveDelegateStateDir,
	StateLockTimeoutError,
	withStateFileLock,
} from "./state-io.js";
import { MAX_TIMEOUT_MS, normalizeTimeoutMs, type ResolvedRunTimeoutPolicy } from "./fork-timeout.js";
import { isSafeRunId } from "./run-id.js";
import {
	effectiveAttempt,
	isValidForkIdentity,
	validateRetryClaims,
	sameForkIdentity,
	validateRetryComponent,
	MAX_LINEAGE_DEPTH,
	MAX_PERSISTED_KEY_NAME_BYTES,
	MAX_PERSISTED_RUNS,
	type RetryForkRecord,
	type RetryAdmissionPlan,
	type RetryClaim,
	type RetryOf,
	type RetriedBy,
} from "./fork-predecessor.js";
import type { RunResult } from "./fork-runner.js";
import { isWorkerFailureCause, type WorkerFailureCause } from "./refusal.js";
import {
	readRunResultSidecar,
	sweepRunResultSidecars,
	writeRunResultSidecar,
	type RunResultSidecarEnvelope,
} from "./run-result-sidecar.js";
import {
	isMutationNotTrackedReason,
	isWorkerErrorKind,
	projectRunResult,
	projectRunUsage,
	projectTaskProgressFields,
	projectTranscriptEntry,
} from "./run-result-boundary.js";
import { getUncappedResultContent } from "./delegate-only/result-caps.js";
import {
	getLiveWakeSink,
	getLiveWakeSinkOwnerSessionId,
	type NotifyCompletionSink,
} from "./pending-wakes.js";
import {
	captureProcessIdentity,
	getProcessNonce,
	isValidProcessBootId,
	isValidProcessId,
	isValidProcessNonce,
	isValidProcessStartTicks,
	verifyProcessIdentity,
	type ProcessIdentityDependencies,
	type ProcessIdentityVerdict,
} from "./process-identity.js";
import type { TranscriptEntry } from "./summarize.js";
import {
	buildDelegateUsageMetadata,
	diagnosticsWithGenerated,
	isTickerUsageCounterKey,
	isUsageCounterKey,
	normalizeUsageCounters,
	saturatingAdd,
} from "./usage-rollup.js";
import type { RunRecoveryDescriptor } from "./fork-recovery.js";
import { unavailableMutationReport } from "./mutation-tracking.js";

export type RunLiveStatus =
	| "pending"
	/**
	 * A dispatched run is registered as `"constructing"` BEFORE its entry is fully
	 * built (the `clone_mode:'full'` history clone / worker boot can be slow).
	 * It is live/non-terminal like `"pending"`, so explicit cancel and shutdown
	 * cleanup must include it. Promoted to `"running"` once the entry establishes.
	 */
	| "constructing"
	| "running"
	/** Waiting on an escalation while retaining the in-flight worker tool call. */
	| "awaiting-escalation"
	| "completed"
	| "failed"
	| "aborted"
	/**
	 * Spec 0019 / REQ-PAUSE-1 — a supervised fork whose supervisor ran out of
	 * `max_rounds` and was FORCED to finish lands here instead of `"completed"`.
	 * Terminal (NOT live) but distinct from a clean finish: the child is parked
	 * mid-work, not done. Every done-ness / success gate must exclude it.
	 */
	| "paused";

export const RUN_LIVE_STATUSES = [
	"pending", "constructing", "running", "awaiting-escalation",
	"completed", "failed", "aborted", "paused",
] as const satisfies readonly RunLiveStatus[];

/** @deprecated Use {@link RUN_LIVE_STATUSES}; retained for compatibility. */
export const FORK_LIVE_STATUSES = RUN_LIVE_STATUSES;

/** @deprecated Use {@link RunLiveStatus}; retained for compatibility. */
export type ForkLiveStatus = RunLiveStatus;

type AssertNever<T extends never> = T;
export type _AllStatusesEnumerated = AssertNever<
	Exclude<RunLiveStatus, (typeof RUN_LIVE_STATUSES)[number]>
>;

/**
 * Is a run-entry status LIVE (non-terminal, still in-flight)? The live statuses are
 * `"pending"`, `"constructing"`, `"running"`, and `"awaiting-escalation"`;
 * terminal statuses are `"completed"`, `"failed"`, `"aborted"`, and
 * `"paused"`.
 *
 * Every site that enumerates live entries for cancellation / broadcast MUST route
 * through this helper rather than hand-rolling a `running || pending` filter —
 * otherwise a freshly-dispatched run sitting in `"constructing"` is silently
 * skipped by a whole-run `delegate_cancel` / shutdown cleanup, and any future
 * non-terminal status would be missed the same way.
 */
export function isLiveStatus(status: RunLiveStatus): boolean {
	return (
		status !== "completed" &&
		status !== "failed" &&
		status !== "aborted" &&
		// Spec 0019 / REQ-PAUSE-1 — `"paused"` is TERMINAL (the supervisor was
		// forced to finish, the child is parked, not in-flight). It must read as
		// not-live so a whole-run cancel / broadcast skips it like any other
		// terminal entry.
		status !== "paused"
	);
}

/**
 * Project runtime-only live statuses into the legacy/result `RunStatus`
 * vocabulary. Result-style surfaces can keep saying "pending" / "running"
 * without forgetting that `"constructing"` and `"awaiting-escalation"` are live.
 */
export function projectToRunStatus(status: RunLiveStatus): RunResult["status"] {
	switch (status) {
		case "constructing":
			return "pending";
		case "awaiting-escalation":
			return "running";
		default:
			return status;
	}
}

/**
 * Is a status active after projecting live-only states into the result-style
 * vocabulary? Keep this narrow `pending` / `running` check centralized so UI
 * result summaries can be explicit about projection without hand-rolling it.
 */
export function isProjectedActiveStatus(status: RunLiveStatus): boolean {
	const projected = projectToRunStatus(status);
	return projected === "pending" || projected === "running";
}

/** Count live run entries using the canonical runtime liveness predicate. */
export function countLiveRuns<T extends { status: RunLiveStatus }>(entries: readonly T[]): number {
	return entries.filter((entry) => isLiveStatus(entry.status)).length;
}

/** Count active run entries after applying the named result-status projection. */
export function countProjectedActiveRuns<T extends { status: RunLiveStatus }>(entries: readonly T[]): number {
	return entries.filter((entry) => isProjectedActiveStatus(entry.status)).length;
}

/** @deprecated Use {@link projectToRunStatus}; retained for compatibility. */
export const projectToForkStatus = projectToRunStatus;

/** @deprecated Use {@link countLiveRuns}; retained for compatibility. */
export const countLiveForks = countLiveRuns;

/** @deprecated Use {@link countProjectedActiveRuns}; retained for compatibility. */
export const countProjectedActiveForks = countProjectedActiveRuns;

/**
 * Mirrors the pi SDK `SessionShutdownEvent['reason']` enum. Declared locally
 * (rather than imported) so the runtime module stays free of a direct SDK type
 * dependency; `src/index.ts` passes the SDK `event.reason` straight through and
 * the structural compatibility is checked at that call site.
 */
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/**
 * Is this shutdown reason terminal for pi-delegate's IN-PROCESS runtime?
 *
 * Yes, always. `"reload"`, `"new"`, `"resume"`, and `"fork"` are benign for
 * the foreground session's conversation history, but they still tear down the
 * extension runtime and invalidate the live supervisor/worker closures that
 * power normal `delegate({ agents/tasks/chain, sync:false })` dispatches. A
 * `DelegateDispatchState` entry is therefore reload-vulnerable even when its legacy
 * `detached` flag is true. Leaving it active after shutdown creates an
 * un-cancellable zombie whose hydrated `cancel`/`steer` stubs are not wired.
 *
 * Truly OS-detached `orchestrate` runs are not represented by this in-memory
 * registry; they live in the detached fs/control substrate and are handled by
 * the orchestrate-specific delivery/control paths.
 */
export function isTerminalShutdownReason(
	_reason: SessionShutdownReason | undefined,
): boolean {
	return true;
}

/**
 * Reason an entry was cancelled. Threaded through `DelegateDispatchState.cancel` so the
 * overlay, tool-side cancel, per-entry timeout, session shutdown, and (later)
 * heartbeat checker can all express *why* an entry was aborted. Propagated onto
 * `RunLiveState.cancelReason` and `RunResult.cancelReason`.
 *
 * `"heartbeat"` is reserved for a future commit that wires worker-side liveness
 * checks; nothing in-tree emits it yet.
 *
 * `"never-constructed"` (Tier 2, #459) marks a run terminalized by the
 * never-constructed reaper: a dispatch that registered a `constructing`/`pending`
 * entry but never established a worker before the construction deadline. It is
 * distinct from `"shutdown"` so status/observability can tell a stuck-dispatch
 * ghost apart from a clean reload orphan.
 */
export type CancelReason = "user" | "timeout" | "heartbeat" | "supervisor" | "shutdown" | "never-constructed";

/**
 * Which in-process dispatch shape produced a run, recorded by the dispatch path
 * at `registerRun` time (issue #76).
 *
 * Read-only diagnostic: `run-introspect` surfaces it as
 * `UniformRunStatus.shape`, and no state machine branches on it. It exists
 * because the shape is NOT recoverable from the run's contents afterwards — the
 * previous entry-name inference reported a chain as `direct`/`supervised` and a
 * multi-task parallel-direct batch as `supervised`. Optional so records built by
 * tests, older persisted files, or a future shape stay valid; consumers fall
 * back to name/count inference when it is absent.
 *
 * Detached `orchestrate` runs are deliberately absent: they are not represented
 * by this in-memory registry at all and are tagged `"orchestrate"` by the
 * detached resolver.
 */
export type InProcessRunShape = "supervised" | "direct" | "chain";

/**
 * Shape of a pending worker-UI prompt routed to the overlay. Phase 3c.
 * `kind` mirrors the three blocking `ExtensionUIContext` methods we route;
 * everything else is rendered verbatim by the overlay banner.
 */
export type PendingPromptKind = "confirm" | "select" | "input";
export interface PendingPrompt {
	id: string;
	kind: PendingPromptKind;
	title: string;
	description?: string;
	/** For kind="select", the available option labels. */
	options?: string[];
	/** Time the prompt was queued (ms). Used for the countdown display. */
	createdAt: number;
	/** Auto-deny deadline (ms epoch). Set when the UI context armed a timeout. */
	expiresAt?: number;
	/**
	 * Resolver handle. The UI context that queued the prompt hooks up a
	 * promise + timeout; `resolvePendingPrompt()` fires this.
	 *
	 * Value type matches the `kind`:
	 *   - confirm → boolean
	 *   - select  → string | undefined (selected option; undefined = cancel)
	 *   - input   → string | undefined
	 */
	resolve: (value: unknown) => void;
}

/**
 * Short-lived proof that a routed worker UI belongs to the run registration
 * that was current when the UI context was built.
 */
export type PendingPromptAdmission = () => boolean;

export interface TickerUsageDelta {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost: number;
}

/**
 * Opaque proof that one ticker request was issued while its run/entry was live
 * and owned by this process. A reservation is single-use: settling it twice
 * cannot duplicate provider usage.
 */
export interface TickerUsageReservation {
	readonly requestId: number;
	readonly runId: string;
	readonly forkName: string;
}

export interface TickerUsageDisposition {
	/** True when a non-zero provider usage delta was recorded exactly once. */
	usageRecorded: boolean;
	/** True only while semantic headline state may still be accepted. */
	headlineAccepted: boolean;
}

export interface RunLiveState {
	name: string;
	/** Exact predecessor identity for a fresh retry attempt. Write-once. */
	retryOf?: RetryOf;
	/** Exact successor identity committed for this predecessor. Write-once. */
	retriedBy?: RetriedBy;
	/** Stable derived attempt number; absent legacy records mean attempt 1. */
	attempt?: number;
	/** Private marker: relationship metadata was unsafe and has been quarantined. */
	retryQuarantined?: boolean;
	/**
	 * Derived, NON-ADDRESSING display label (issues #151/#152). Shown by the
	 * status widget and transcript overlay in place of the bare `name`, and
	 * accepted as an alias by the control tools — but `name` remains the key of
	 * this record, of every control call, and of the pending-wake filename.
	 *
	 * Fixed for the entry's lifetime: it is stamped at dispatch and never
	 * patched. Absent on legacy/hydrated records, where surfaces fall back to
	 * `name`.
	 */
	displayLabel?: string;
	agent: string;
	/** Optional metadata persisted at register time so orphaned runs can still render useful results after an extension reload. */
	agentSource?: AgentSource;
	task?: string;
	collapseMode?: "final_output" | "summary";
	workerCwd?: string;
	/** Effective worktree branch when dispatch isolation created/provided one. */
	workerBranch?: string;
	/** Fully resolved slot configuration captured before dispatch side effects. */
	requestedModel?: string;
	/** Canonical provider/model selected by dispatch preflight. */
	resolvedModel?: string;
	skills?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	cloneMode?: string;
	status: RunLiveStatus;
	currentRound: number;
	maxRounds: number;
	lastWorkerText?: string;
	lastSupervisorText?: string;
	workerSessionFile?: string;
	error?: string;
	/** Distinct provider/runtime error class when known. */
	errorKind?: "refusal" | "no-model-alternative";
	/**
	 * Actionable cause of a terminal failure when the runner classified one.
	 * Carried on the live tick so the early failure wake can name the category
	 * at the moment of failure rather than waiting for the aggregate (#469/#197).
	 */
	failureCause?: WorkerFailureCause;
	/** Worker model refs that refused before this entry failed or fell back. */
	refusalModels?: string[];
	startedAt?: number;
	endedAt?: number;
	/** Effective interval used for this supervised fork; 0 disables heartbeat. */
	heartbeatIntervalMs?: number;
	/** Effective soft wind-down heartbeat count. */
	maxConsecutiveHeartbeats?: number;
	/** Durable fact that the wind-down path triggered and attempted a best-effort wrap-up steer. */
	windDown?: {
		atMs: number;
		reason: "heartbeat" | "wall-clock" | "unknown";
	};
	/**
	 * Spec 0024 / REQ-LIVE-1 — wall-clock timestamp (ms epoch) of the most
	 * recent observed worker-channel activity (reply / heartbeat / tool event),
	 * propagated from `WorkerChannel`'s internal liveness clock via
	 * `updateRunState`. OPTIONAL and ADDITIVE: an entry record without it (legacy
	 * persisted state, or an entry whose channel never wired the activity seam)
	 * degrades to the prior `endedAt ?? startedAt` behavior in run-introspect's
	 * reducer. While the entry is live (non-terminal), the reducer prefers this
	 * over `startedAt` so the status elapsed advances with real activity instead
	 * of freezing at the dispatch gap (REQ-LIVE-2); a terminal entry's elapsed
	 * stays its real `endedAt`-based duration (REQ-LIVE-3).
	 */
	lastActivityAt?: number;
	/**
	 * Issue #226 — latest counts for a dispatched checklist, absent when this
	 * entry carried none. Bounded by construction: the aggregate and top-level
	 * reconciliation rows are retained, while optional titled/nested display detail
	 * yields to the event payload cap.
	 */
	taskProgress?: TaskProgressFields;
	/**
	 * Incremental transcript projection, appended to by fork-runner's
	 * `subscribe` hooks. Same entry shape as `summarize.messagesToTranscript`.
	 * Seeded to `[]` at `registerRun` time.
	 */
	transcript: TranscriptEntry[];
	/**
	 * Separate UI activity projection. Entries are redacted, timestamped, and
	 * bounded independently from the agent transcript and final collapse.
	 */
	activityHistory?: ActivityStatusEntry[];
	/**
	 * Phase 3a.2 — guidance messages queued by the user (via the overlay
	 * compose box or `delegate_steer`) that couldn't be delivered via
	 * `cloneSession.steer()` / `sendUserMessage`. Drained by the
	 * `message_subagent` tool at the top of each round: prepended as a
	 * `<user-guidance>…</user-guidance>` block to the supervisor's next
	 * worker prompt, then cleared. Seeded to `[]` at `registerRun` time.
	 */
	pendingGuidance: string[];
	/** Last cancel reason threaded through `DelegateDispatchState.cancel`. Populated even when the cancel races with natural entry completion (the status may still end up "completed"). */
	cancelReason?: CancelReason;
	/**
	 * Wall-clock timestamp (ms epoch) at which the entry first transitioned to
	 * `"running"`. Used by the ps-tree sweep on cancel to filter descendant
	 * pids to those that were started by or after this entry.
	 */
	startedAtMs?: number;
	/** Immutable absolute deadline captured at the first running transition. */
	timeoutDeadlineAtMs?: number;
	/** Effective supervised timeout policy captured before dispatch. */
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
	/**
	 * Accumulated cost in USD so far, surfaced for the cancel-confirm dialog so
	 * it can threshold on expensive entries. Patched by the fork-runner alongside
	 * roundsUsed/status on every state update.
	 */
	cost?: number;
	/**
	 * Best-effort rolling token/cost counters for this entry. Completed runs carry
	 * authoritative usage in `finalResult`; this live copy lets footer/status
	 * surfaces include still-running delegate work before the tool/custom-message
	 * result has been appended to the foreground session.
	 */
	usage?: RunResult["usage"];
	/**
	 * Durable per-entry terminal result snapshot, written as soon as an individual
	 * entry resolves. This is intentionally stored on the live entry record (not
	 * only on the run-level `finalResult`, which is written by `completeRun`) so a
	 * foreground `sync:true` parent that dies after an entry collapsed but before
	 * the blocking tool call returns can be hydrated later with recoverable output
	 * instead of only an aborted orphan placeholder.
	 */
	completedResult?: RunResult;
	/**
	 * Phase 3c — whether worker UI prompts are routed to the overlay.
	 * Mirrors the `interactive` flag from the entry request. The `s` key in
	 * the overlay banner can flip this to `false` mid-entry (deny-all + stop
	 * routing new prompts); the fork-runner reads it once at bind time, so
	 * the in-memory flip only affects *future* prompts the worker raises.
	 */
	interactive: boolean;
}

/** @deprecated Use {@link RunLiveState}; retained for compatibility. */
export type ForkLiveState = RunLiveState;

/**
 * Delivery result for `DelegateDispatchState.steer`. Exposed so the overlay compose
 * box can display which rung of the fallback ladder the message took.
 */
export type SteerDelivery = "steer" | "followUp" | "queued";

export interface DelegateDispatchState {
	runId: string;
	/**
	 * The root-run-id anchoring this run's whole delegation tree (spec 0004).
	 * For a foreground dispatch this equals `runId` (the foreground is the
	 * depth-0 root, and the lineage frame seeds `rootRunId === runId` at the
	 * outermost frame — see `runWithDepth`). Carried here so the event bus can
	 * key its filesystem sink by root-run-id. Optional because raw run state
	 * constructed in tests / hydrated from older persisted files may omit it;
	 * `rootRunIdForRun()` falls back to `runId`.
	 */
	rootRunId?: string;
	/**
	 * Foreground/originator pi session id that launched this in-process delegate
	 * run. The complete process owner identity is the authority for live control
	 * surfaces, while this stable session id lets
	 * read-only historical surfaces (notably the usage footer) attribute
	 * completed runs after reload without treating live sibling processes as
	 * controllable by the current session.
	 */
	ownerSessionId?: string;
	/**
	 * In-process dispatch shape, stamped by the dispatch path that registered
	 * this run (issue #76). Diagnostic only — see {@link InProcessRunShape}.
	 */
	shape?: InProcessRunShape;
	/** Whether early per-entry failure wakes are enabled for this run. */
	notifyOnFailure?: boolean;
	createdAt: number;
	completedAt?: number;
	/**
	 * Legacy async-dispatch marker. Historically this meant a `sync:false`
	 * in-process dispatch (`agents` / `tasks` / `chain`) was decoupled from the
	 * parent turn's AbortSignal and could continue after the tool returned.
	 *
	 * IMPORTANT: this does NOT mean OS-detached or reload-survivable. Normal
	 * in-process delegate runs still depend on live supervisor/worker closures in
	 * this module instance; `session_shutdown` must terminalize them truthfully
	 * rather than preserve a zombie `running` record. The field remains persisted
	 * for backward compatibility and diagnostics only.
	 */
	detached?: boolean;
	/**
	 * Timestamp set when an active in-process run is terminalized because its
	 * owning delegate runtime disappeared (shutdown/reload/hydrate dead-owner).
	 * Distinguishes a truthful orphan recovery from a normal `completeRun()` so
	 * startup handoff logic can surface sync-mode recovered output exactly once.
	 */
	orphanedAt?: number;
	/**
	 * Timestamp set after a foreground startup successfully surfaces a recovered
	 * sync-mode orphan to the user/agent. Persisted to prevent duplicate recovery
	 * messages on later session starts.
	 */
	syncOrphanRecoverySurfacedAt?: number;
	/**
	 * Durable de-dupe stamp: when the terminal `delegate:complete` wake for a
	 * hydrate-orphaned background run reached its owning session.
	 */
	orphanWakeSurfacedAt?: number;
	/** OS pid of the process that owns this in-process run. */
	owningPid?: number;
	/** Linux `/proc/<pid>/stat` field 22 for the owning process generation. */
	owningStartTicks?: string;
	/** Linux boot id for the owning process generation. */
	owningBootId?: string;
	/** Reload-stable nonce that distinguishes this runtime inside the process generation. */
	owningNonce?: string;
	forks: Record<string, RunLiveState>;
	finalResult?: RunResult[];
	/**
	 * #470 — in-memory only, never persisted. `true` once this completed run's
	 * result is durable in its per-run sidecar (`run-results/<runId>.json`), which
	 * lets the shared `run-state.json` row omit the heavy `finalResult` transcripts
	 * (the dominant source of shared-file bloat and therefore of lock-hold time).
	 * Set by `completeRun` on a successful sidecar write and by the hydrate
	 * sidecar-restore path. When it is not set, the shared row keeps `finalResult`
	 * inline so a run is never left with its result durable in neither place.
	 */
	resultSidecarDurable?: boolean;
	abort: () => void;
	/**
	 * Phase 3a.1 — deliver a guidance message to the supervisor
	 * (fork-clone) that, in turn, decides how to propagate it to the
	 * worker. If `forkName` is omitted, the message is delivered to every
	 * running entry in the run. `opts.deliverAs === "queue"` skips the push
	 * attempts entirely and jumps straight to the pending-guidance queue.
	 *
	 * Wired in `src/index.ts` at `registerRun` time; raw run state
	 * constructed in tests can leave this as the default rejecting stub.
	 */
	steer?: (
		forkName: string | undefined,
		text: string,
		opts?: { deliverAs?: "steer" | "followUp" | "queue" },
	) => Promise<{ delivered: SteerDelivery; error?: string }>;
	/**
	 * Phase 3b.1 — cancel a single entry (when `forkName` is provided) or
	 * every still-running entry in the batch. Aborts both the clone and the
	 * worker sessions, stamps `status: "aborted"`, and records `reason` in
	 * `RunLiveState.error`. `completeRun()` still fires once the pump
	 * drains so the custom_message wake-up reaches the main agent.
	 *
	 * Optional on the type because tests construct raw `DelegateDispatchState`
	 * literals; `registerRun()` backfills a stub when missing, and
	 * production runs installed via `src/index.ts` always wire the real
	 * implementation before consumers see the state.
	 */
	cancel?: (forkName?: string, reason?: CancelReason) => Promise<void>;
	/**
	 * Per-entry in-memory recovery descriptors, keyed by the compatibility `forkName`. Populated at
	 * accepted dispatch time independently of `notifyOnFailure`. Not persisted;
	 * hydrated/reloaded runs lack descriptors and must fail closed for recovery.
	 * Recovery is an independent child run — the original aggregate is unaffected.
	 */
	recoveryDescriptors?: Map<string, RunRecoveryDescriptor>;
}

/**
 * Non-authoritative projection returned by runtime read accessors.
 * Live control and recovery callbacks stay private to the registered object.
 */
export type DelegateDispatchSnapshot = Omit<
	DelegateDispatchState,
	"abort" | "cancel" | "steer" | "recoveryDescriptors"
>;

/** @deprecated Use {@link DelegateDispatchState}; retained for compatibility. */
export type ForkRunState = DelegateDispatchState;

type EventEmitter = (channel: string, data: unknown) => void;

// Module-level state. `runs` is the active+completed registry.
const runs = new Map<string, DelegateDispatchState>();
const hydratedRunIds = new Set<string>();
/**
 * Run ids admitted through this module instance's registration boundary and not
 * yet durably terminalized. Hydration never populates this set: it is the live
 * producer's authoritative inventory, not a second view over historical state.
 */
const locallyRegisteredActiveRunIds = new Set<string>();
/** Same-id replacement can leave an overwritten generation's closures alive. */
const overlappingLocalGenerationRunIds = new Set<string>();
/** A replaced root cannot safely reattribute an already-active ownerless child. */
const replacedLocalRootGenerationRunIds = new Set<string>();
let emitter: EventEmitter | undefined;
/**
 * Exact pre-send recovery observations admitted by this module instance.
 * A caller-supplied object or a snapshot from a replaced module cannot gain the
 * narrow durable acknowledgement capability.
 */
let recoveryDeliveryObservations = new WeakSet<object>();

function markLocalRegistrationCommitted(
	run: DelegateDispatchState,
	replacedDifferentGeneration = false,
	replacedActiveLocalGeneration = false,
): void {
	if (replacedDifferentGeneration) {
		if (replacedActiveLocalGeneration || locallyRegisteredActiveRunIds.has(run.runId)) {
			overlappingLocalGenerationRunIds.add(run.runId);
		}
		for (const activeRunId of locallyRegisteredActiveRunIds) {
			const activeRun = runs.get(activeRunId);
			if (
				activeRun?.ownerSessionId === undefined &&
				activeRun.rootRunId === run.runId &&
				activeRun.runId !== run.runId
			) {
				replacedLocalRootGenerationRunIds.add(run.runId);
				break;
			}
		}
	}
	if (run.completedAt === undefined || overlappingLocalGenerationRunIds.has(run.runId)) {
		locallyRegisteredActiveRunIds.add(run.runId);
	} else {
		locallyRegisteredActiveRunIds.delete(run.runId);
	}
}

function reconcileDurablyTerminalLocalRegistrations(): void {
	for (const runId of locallyRegisteredActiveRunIds) {
		// The overwritten generation is no longer addressable by runId, so only a
		// session reset can prove its closures gone. Retain a bounded doubt instead
		// of publishing idle after the current generation finishes.
		if (overlappingLocalGenerationRunIds.has(runId)) continue;
		const run = runs.get(runId);
		if (!run || run.completedAt !== undefined) locallyRegisteredActiveRunIds.delete(runId);
	}
}

interface PendingTickerUsageReservation {
	reservation: TickerUsageReservation;
	run: DelegateDispatchState;
}

const pendingTickerUsageReservations = new Map<number, PendingTickerUsageReservation>();
let tickerUsageRequestIdSeq = 0;

/** In-flight worker-UI prompts keyed by `${runId}:${forkName}`. */
const pendingPromptsByEntry = new Map<string, PendingPrompt[]>();
let pendingPromptIdSeq = 0;

const promptKey = (runId: string, forkName: string): string => `${runId}:${forkName}`;

/** Default fallback for raw DelegateDispatchState constructed in tests without `steer`. */
const defaultSteerStub = async () => {
	throw new Error("DelegateDispatchState.steer not wired (registerRun was bypassed)");
};
const defaultCancelStub = async () => {
	throw new Error("DelegateDispatchState.cancel not wired (registerRun was bypassed)");
};

/**
 * Tier 3 (#459) — the durable state-file schema version, now a real gate rather
 * than a dead field. Bumped to 2 with this change (the record shape gained the
 * `cancelReason: "never-constructed"` vocabulary and the reaper semantics).
 *
 * Written by every persist site through {@link CURRENT_STATE_SCHEMA_VERSION} and
 * read by {@link persistedRunsFromValue}, which migrates an older/absent version
 * forward before validation and preserves (never quarantine-drops) a NEWER file
 * written by a future build. Adding an optional field stays additive and needs
 * no bump; only a rename/removal/enum change needs a migration hop.
 */
const CURRENT_STATE_SCHEMA_VERSION = 2;

interface PersistedRunStateFile {
	version: number;
	writtenAt: number;
	runs: PersistedRunState[];
}

interface PersistedRunState {
	runId: string;
	rootRunId?: string;
	ownerSessionId?: string;
	/** Issue #76 — see `DelegateDispatchState.shape`. Persisted so hydrated records keep their true shape. */
	shape?: InProcessRunShape;
	notifyOnFailure?: boolean;
	createdAt: number;
	completedAt?: number;
	/** Legacy async-dispatch marker; see `DelegateDispatchState.detached`. */
	detached?: boolean;
	orphanedAt?: number;
	syncOrphanRecoverySurfacedAt?: number;
	orphanWakeSurfacedAt?: number;
	/** See `DelegateDispatchState.owningPid`. */
	owningPid?: number;
	owningStartTicks?: string;
	owningBootId?: string;
	owningNonce?: string;
	/** v1 compatibility key: persisted run records retain `forks` for on-disk compatibility. */
	forks: Record<string, RunLiveState>;
	finalResult?: RunResult[];
}

// ── Persistence caps ──────────────────────────────────────────────────────
//
// Empirically run-state.json grew to 30 MB over ~27 runs because:
//   1. `forks[name].transcript` and `finalResult[*].transcript` held the
//      same data (≈13 MB each = 26 MB of duplication).
//   2. Each transcript entry's `text` was unbounded — large bash outputs
//      hit 50 KB+ in a single entry, with p99 ≈ 22 KB.
//   3. Active-run cap of 500 entries × no per-entry size cap = unbounded
//      growth on long-running entries.
//
// The constants below are tuned against that profile (Apr 2026 incident).
// Targets:
//   - completed runs: keep finalResult[*].transcript only; drop the
//     duplicated forks[*].transcript (hydrate restores the link).
//   - active runs: cap entries + per-entry text bytes so a long-running
//     entry's transcript can't balloon the file.
//   - per-entry: truncate `text` past MAX_PERSISTED_ENTRY_TEXT_BYTES with
//     a clear marker.
//   - lastWorkerText / lastSupervisorText / collapsedContent: independently
//     capped (these are also unbounded sources of bloat).
//   - retain the last 25 completed runs (was 100).
//
// Tests pin every cap so the next person who tweaks them sees the
// historical context.

/** Max transcript entries kept per ACTIVE-run entry (overlay needs a live tail). */
const MAX_PERSISTED_TRANSCRIPT_ENTRIES_ACTIVE = 200;
/** Max transcript entries kept per COMPLETED-run entry (post-mortem only). */
const MAX_PERSISTED_TRANSCRIPT_ENTRIES_COMPLETED = 50;
/** Per-entry `text` byte cap. Bash dumps + tool results are the dominant bloat. */
const MAX_PERSISTED_ENTRY_TEXT_BYTES = 4096;
/** Cap on `lastWorkerText` / `lastSupervisorText` snapshots in entry live state. */
const MAX_PERSISTED_LAST_TEXT_BYTES = 4096;
/** Cap on `collapsedContent` (final user-facing output) — generous, but bounded. */
const MAX_PERSISTED_COLLAPSED_CONTENT_BYTES = 64 * 1024;
/** Cap on supervisor finish payload text (`final_output` / `summary`). */
const MAX_PERSISTED_SUPERVISOR_FINISH_PAYLOAD_BYTES = MAX_PERSISTED_COLLAPSED_CONTENT_BYTES;
/** Default cap for arbitrary persisted string leaves not covered by a field-specific cap. */
const MAX_PERSISTED_STRING_LEAF_BYTES = MAX_PERSISTED_ENTRY_TEXT_BYTES;
/** Max retired worker sessions kept inside a persisted RunResult. */
const MAX_PERSISTED_PRIOR_WORKER_SESSIONS = 5;
/** Max AgentSession messages kept per retired worker session snapshot. */
const MAX_PERSISTED_PRIOR_WORKER_MESSAGES = 50;
/** Defensive cap on arbitrary arrays nested inside persisted snapshots. */
const MAX_PERSISTED_ARRAY_ITEMS = 50;
/** Defensive cap on arbitrary object breadth inside persisted snapshots. */
const MAX_PERSISTED_OBJECT_KEYS = 50;
/** Defensive cap on arbitrary object depth inside persisted snapshots. */
const MAX_PERSISTED_OBJECT_DEPTH = 8;
/** Hard serialized-size backstop for each persisted live entry snapshot. */
const MAX_PERSISTED_ENTRY_SNAPSHOT_BYTES = 1024 * 1024;
/** Hard serialized-size backstop for each persisted RunResult snapshot. */
const MAX_PERSISTED_ENTRY_RESULT_BYTES = 1024 * 1024;
/** Hard serialized-size backstop for each persisted run record. */
const MAX_PERSISTED_RUN_BYTES = 4 * 1024 * 1024;

let runtimeStatePath: string | undefined;
let runtimeAgentDir: string | undefined;
let persistenceHydrated = false;
let runtimeProcessIdentityDependencies: Partial<ProcessIdentityDependencies> | undefined;

type ProcessOwnerFields = Pick<
	DelegateDispatchState,
	"owningPid" | "owningStartTicks" | "owningBootId" | "owningNonce"
>;
type RuntimeOwnerDisposition = "local" | "foreign" | "stale" | "unproven";

// Module-private object provenance. Owner fields and registry IDs are not
// capabilities: reloads retain the process nonce but lose this WeakMap.
let localCallbackOwners = new WeakMap<DelegateDispatchState, ProcessOwnerFields>();

function hasExplicitOwner(state: ProcessOwnerFields): boolean {
	return [state.owningPid, state.owningNonce, state.owningStartTicks, state.owningBootId]
		.some((value) => value !== undefined);
}

function sameOwner(left: ProcessOwnerFields, right: ProcessOwnerFields): boolean {
	return left.owningPid === right.owningPid && left.owningNonce === right.owningNonce &&
		left.owningStartTicks === right.owningStartTicks && left.owningBootId === right.owningBootId;
}

/** Live callback authority, never inferred from persisted process evidence. */
export function hasLocalRunAuthority(run: DelegateDispatchState | DelegateDispatchSnapshot): boolean {
	if (!("abort" in run)) return false;
	const liveRun = run as DelegateDispatchState;
	const owner = localCallbackOwners.get(liveRun);
	if (!owner || runs.get(liveRun.runId) !== liveRun || !sameOwner(owner, liveRun) ||
		liveRun.owningPid !== process.pid || liveRun.owningNonce !== getProcessNonce()) return false;
	const verdict = ownerIdentityVerdict(liveRun);
	return verdict !== "absent" && verdict !== "mismatch";
}

function admitLocalCallbacks(state: DelegateDispatchState, eligible: boolean): void {
	if (eligible) localCallbackOwners.set(state, projectProcessOwnerFields(state));
}

/** Replace Linux process-identity I/O for deterministic runtime tests. */
export function __setRuntimeProcessIdentityDependenciesForTests(
	deps: Partial<ProcessIdentityDependencies> | undefined,
): void {
	runtimeProcessIdentityDependencies = deps;
}

function ownerIdentityVerdict(owner: ProcessOwnerFields): ProcessIdentityVerdict {
	if (!isValidProcessNonce(owner.owningNonce)) return "unproven";
	return verifyProcessIdentity(
		{
			pid: owner.owningPid as number,
			startTicks: owner.owningStartTicks as string,
			bootId: owner.owningBootId as string,
		},
		runtimeProcessIdentityDependencies,
	);
}

function runtimeOwnerDisposition(
	owner: ProcessOwnerFields,
	options: { changedLocalNonceIsStale?: boolean } = {},
): RuntimeOwnerDisposition {
	// The reload-stable nonce proves ownership inside this exact OS process even
	// when Linux birth/boot evidence is unavailable (for example on macOS).
	// A changed nonce is only stale when the caller is classifying a persisted
	// record during hydration; ordinary maintenance must not revoke a live
	// predecessor that may still own its closures.
	if (owner.owningPid === process.pid) {
		if (!isValidProcessNonce(owner.owningNonce)) return "unproven";
		if (owner.owningNonce === getProcessNonce()) return "local";
		return options.changedLocalNonceIsStale === true ? "stale" : "unproven";
	}
	const verdict = ownerIdentityVerdict(owner);
	if (verdict === "absent" || verdict === "mismatch") return "stale";
	if (verdict === "unproven") return "unproven";
	return "foreign";
}

function ownerIdentityDiagnostic(disposition: RuntimeOwnerDisposition): string {
	switch (disposition) {
		case "local": return "matching-local-generation";
		case "foreign": return "matching-foreign-generation";
		case "stale": return "proven-stale-generation";
		case "unproven": return "unproven-generation";
	}
}

function stampCurrentOwnerIdentity(state: DelegateDispatchState): void {
	const shouldStamp = state.owningPid === undefined || (
		state.owningPid === process.pid &&
		state.owningStartTicks === undefined &&
		state.owningBootId === undefined &&
		state.owningNonce === undefined
	);
	if (!shouldStamp) return;
	state.owningPid = process.pid;
	const captured = captureProcessIdentity(process.pid, runtimeProcessIdentityDependencies);
	if (captured) {
		state.owningStartTicks = captured.startTicks;
		state.owningBootId = captured.bootId;
	} else {
		delete state.owningStartTicks;
		delete state.owningBootId;
	}
	state.owningNonce = getProcessNonce();
}

function projectProcessOwnerFields(owner: ProcessOwnerFields): ProcessOwnerFields {
	return {
		...(isValidProcessId(owner.owningPid) ? { owningPid: owner.owningPid } : {}),
		...(isValidProcessStartTicks(owner.owningStartTicks) ? { owningStartTicks: owner.owningStartTicks } : {}),
		...(isValidProcessBootId(owner.owningBootId) ? { owningBootId: owner.owningBootId } : {}),
		...(isValidProcessNonce(owner.owningNonce) ? { owningNonce: owner.owningNonce } : {}),
	};
}

/**
 * Truncate a UTF-8 text field to `maxBytes`, appending a `…[truncated N bytes]`
 * marker so consumers can tell the data was clipped. The byte-count math
 * uses `Buffer.byteLength` so multi-byte chars don't push us past the cap.
 *
 * Idempotent: a value that already contains the truncation marker and is
 * under-cap is returned unchanged.
 *
 * Returns the original string when it's already under the cap (same
 * reference, no allocation).
 */
function truncateText(text: string, maxBytes: number): string {
	if (typeof text !== "string") return text;
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) return text;
	// Slice by character count first (cheap), then trim further if multi-byte
	// chars push us over. We aim for `maxBytes` total INCLUDING the suffix so
	// the result is bounded.
	const suffix = ` …[truncated ${originalBytes - maxBytes} bytes]`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const budget = Math.max(0, maxBytes - suffixBytes);
	let head = text.slice(0, budget);
	while (Buffer.byteLength(head, "utf8") > budget && head.length > 0) {
		head = head.slice(0, head.length - 1);
	}
	return head + suffix;
}

/**
 * Truncate every transcript entry's `text` field. Returns a NEW array (and
 * new entry objects when truncation happens) so the in-memory state isn't
 * mutated by the persist path.
 */
function truncateTranscriptEntries(
	entries: TranscriptEntry[] | undefined,
	maxEntries: number,
	maxTextBytes: number,
): TranscriptEntry[] {
	if (!entries || entries.length === 0) return [];
	const tail = entries.slice(-maxEntries);
	return tail.map((entry) => {
		if (typeof (entry as any).text !== "string") return entry;
		const truncated = truncateText((entry as any).text as string, maxTextBytes);
		if (truncated === (entry as any).text) return entry;
		return { ...entry, text: truncated } as TranscriptEntry;
	});
}

type PersistencePathSegment = string | number;

const PERSISTED_RUN_REQUIRED_KEYS = [
	"runId",
	"rootRunId",
	"ownerSessionId",
	// Issue #76 — a tiny scalar; keep it alongside the other run metadata so a
	// byte-capped run cannot silently lose its shape while retaining `detached`.
	"shape",
	"createdAt",
	"completedAt",
	"detached",
	"orphanedAt",
	"syncOrphanRecoverySurfacedAt",
	"orphanWakeSurfacedAt",
	"owningPid",
	"owningStartTicks",
	"owningBootId",
	"owningNonce",
	"forks",
	"finalResult",
] as const;
const PERSISTED_ENTRY_REQUIRED_KEYS = [
	"name",
	"addressName",
	"retryOf",
	"retriedBy",
	"attempt",
	"retryQuarantined",
	"displayLabel",
	"agent",
	"agentSource",
	"task",
	"workerCwd",
	"workerBranch",
	"requestedModel",
	"resolvedModel",
	"skills",
	"confineWrites",
	"readOnly",
	"cloneMode",
	"collapseMode",
	"status",
	"currentRound",
	"maxRounds",
	"startedAt",
	"endedAt",
	"completedResult",
	"transcript",
	"activityHistory",
] as const;
const PERSISTED_RESULT_REQUIRED_KEYS = [
	"name",
	"attempt",
	"agent",
	"agentSource",
	"task",
	"status",
	"roundsUsed",
	"maxRounds",
	"collapseMode",
	"collapsedContent",
	"inputDigests",
	"transcript",
	"usage",
	"policyRefusals",
	"mutationReport",
] as const;

type PersistenceRequiredKeys = readonly string[];

function comparePersistedKeyNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function requiredPersistenceKeys(pathSegments: readonly PersistencePathSegment[]): PersistenceRequiredKeys {
	if (pathSegments.length === 0) return PERSISTED_RUN_REQUIRED_KEYS;
	if (pathSegments[0] === "forks" && pathSegments.length === 2) return PERSISTED_ENTRY_REQUIRED_KEYS;
	if (pathSegments[0] === "finalResult" && pathSegments.length === 2) return PERSISTED_RESULT_REQUIRED_KEYS;
	return [];
}

function truncateKeyName(key: string): string {
	if (Buffer.byteLength(key, "utf8") <= MAX_PERSISTED_KEY_NAME_BYTES) return key;
	let out = "";
	for (const char of key) {
		if (Buffer.byteLength(out + char, "utf8") > MAX_PERSISTED_KEY_NAME_BYTES) break;
		out += char;
	}
	return out;
}

function allocatePersistedKeyName(key: string, used: Set<string>): string {
	const base = truncateKeyName(key);
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		const suffixText = `~${suffix++}`;
		let head = base;
		while (Buffer.byteLength(head + suffixText, "utf8") > MAX_PERSISTED_KEY_NAME_BYTES) {
			head = head.slice(0, -1);
		}
		candidate = head + suffixText;
	}
	used.add(candidate);
	return candidate;
}

function persistencePathKey(pathSegments: readonly PersistencePathSegment[]): string {
	return pathSegments.map((segment) => String(segment)).join(".");
}

function persistedStringLeafCapBytes(pathSegments: readonly PersistencePathSegment[]): number {
	const leaf = String(pathSegments[pathSegments.length - 1] ?? "");
	const parent = String(pathSegments[pathSegments.length - 2] ?? "");
	if (leaf === "collapsedContent" || (parent === "harvest" && leaf === "text")) return MAX_PERSISTED_COLLAPSED_CONTENT_BYTES;
	if (
		parent === "supervisorFinishPayload" &&
		(leaf === "final_output" || leaf === "summary")
	) {
		return MAX_PERSISTED_SUPERVISOR_FINISH_PAYLOAD_BYTES;
	}
	return MAX_PERSISTED_STRING_LEAF_BYTES;
}

/**
 * Recursively bound arbitrary persisted snapshots. Field-specific shaping
 * (transcript tailing, completed-run transcript de-duplication, and the known
 * 64 KiB user-facing text caps) runs before this helper; this pass is the
 * defensive catch-all so unknown/spread keys cannot bypass persistence caps.
 */
function sanitizePersistedValueForPersistence(
	value: unknown,
	pathSegments: PersistencePathSegment[] = [],
	depth = 0,
	stack: WeakSet<object> = new WeakSet(),
	keysForPath: (path: readonly PersistencePathSegment[]) => PersistenceRequiredKeys = requiredPersistenceKeys,
): unknown {
	if (typeof value === "string") {
		if (isProtectedMetadataPath(pathSegments)) return value;
		return truncateText(value, persistedStringLeafCapBytes(pathSegments));
	}
	if (typeof value !== "object" || value === null) return value;
	if (depth >= MAX_PERSISTED_OBJECT_DEPTH) return "[truncated object depth]";
	if (stack.has(value)) return "[truncated circular reference]";
	stack.add(value);
	if (Array.isArray(value)) {
		const tail = isProtectedMetadataArrayPath(pathSegments)
			? value
			: value.slice(-MAX_PERSISTED_ARRAY_ITEMS);
		const out = tail.map((item, index) =>
			sanitizePersistedValueForPersistence(
				item,
				[...pathSegments, index],
				depth + 1,
				stack,
				keysForPath,
			),
		);
		stack.delete(value);
		return out;
	}
	const required = new Set(keysForPath(pathSegments));
	const entries = Object.entries(value)
		.sort(([a], [b]) => {
			const requiredOrder = Number(required.has(b)) - Number(required.has(a));
			return requiredOrder || comparePersistedKeyNames(a, b);
		})
		.slice(0, MAX_PERSISTED_OBJECT_KEYS);
	// Only keys that are actually present reserve a name. Optional fields in the
	// persistence shape must not consume a deterministic collision suffix.
	const usedKeys = new Set<string>(entries.filter(([key]) => required.has(key)).map(([key]) => key));
	const out: Record<string, unknown> = {};
	for (const [originalKey, nested] of entries) {
		const key = required.has(originalKey) ? originalKey : allocatePersistedKeyName(originalKey, usedKeys);
		Object.defineProperty(out, key, {
			value: sanitizePersistedValueForPersistence(
				nested,
				[...pathSegments, key],
				depth + 1,
				stack,
				keysForPath,
			),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	stack.delete(value);
	return out;
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

interface BackstopCandidate {
	pathSegments: PersistencePathSegment[];
	pathKey: string;
	bytes: number;
}

function collectStringLeafCandidates(
	value: unknown,
	pathSegments: PersistencePathSegment[],
	out: BackstopCandidate[],
): void {
	if (typeof value === "string") {
		// Mutation paths and refusal fields are attribution metadata. Replacing
		// either with a size marker would make persistence claim a path or a
		// refusal that was never produced by the worker.
		if (isProtectedMetadataPath(pathSegments)) return;
		out.push({
			pathSegments,
			pathKey: persistencePathKey(pathSegments),
			bytes: Buffer.byteLength(value, "utf8"),
		});
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			collectStringLeafCandidates(item, [...pathSegments, index], out),
		);
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		collectStringLeafCandidates(nested, [...pathSegments, key], out);
	}
}

function collectArrayCandidates(
	value: unknown,
	pathSegments: PersistencePathSegment[],
	out: BackstopCandidate[],
): void {
	if (typeof value !== "object" || value === null) return;
	if (Array.isArray(value)) {
		const pathKey = persistencePathKey(pathSegments);
		if (isProtectedMetadataArrayPath(pathSegments)) return;
		// `finalResult` is the run-level result list shape; do not replace it with
		// marker strings unless the caller's last-resort root replacement fires.
		if (pathKey !== "" && pathKey !== "finalResult") {
			out.push({ pathSegments, pathKey, bytes: serializedBytes(value) });
		}
		value.forEach((item, index) => collectArrayCandidates(item, [...pathSegments, index], out));
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		collectArrayCandidates(nested, [...pathSegments, key], out);
	}
}

function metadataPathIndex(
	pathSegments: readonly PersistencePathSegment[],
	key: string,
): number {
	for (let index = pathSegments.length - 1; index >= 0; index--) {
		if (pathSegments[index] === key) return index;
	}
	return -1;
}

function isProtectedMetadataPath(pathSegments: readonly PersistencePathSegment[]): boolean {
	const mutationReport = metadataPathIndex(pathSegments, "mutationReport");
	if (
		mutationReport >= 0 &&
		pathSegments[mutationReport + 1] === "changedPaths"
	) return true;
	return metadataPathIndex(pathSegments, "policyRefusals") >= 0;
}

function isProtectedMetadataArrayPath(pathSegments: readonly PersistencePathSegment[]): boolean {
	return (
		pathSegments[pathSegments.length - 1] === "policyRefusals" ||
		(
			pathSegments[pathSegments.length - 1] === "changedPaths" &&
			pathSegments[pathSegments.length - 2] === "mutationReport"
		)
	);
}

interface ProtectedMetadataArrayCandidate extends BackstopCandidate {
	kind: "changedPaths" | "policyRefusals";
}

function collectProtectedMetadataArrayCandidates(
	value: unknown,
	pathSegments: PersistencePathSegment[],
	out: ProtectedMetadataArrayCandidate[],
): void {
	if (typeof value !== "object" || value === null) return;
	if (Array.isArray(value)) {
		const last = pathSegments[pathSegments.length - 1];
		const parent = pathSegments[pathSegments.length - 2];
		if (last === "policyRefusals" || (last === "changedPaths" && parent === "mutationReport")) {
			out.push({
				pathSegments,
				pathKey: persistencePathKey(pathSegments),
				bytes: serializedBytes(value),
				kind: last === "policyRefusals" ? "policyRefusals" : "changedPaths",
			});
			return;
		}
		value.forEach((item, index) =>
			collectProtectedMetadataArrayCandidates(item, [...pathSegments, index], out),
		);
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		collectProtectedMetadataArrayCandidates(nested, [...pathSegments, key], out);
	}
}

function dropProtectedMetadataUntilWithinLimit(
	root: unknown,
	maxBytes: number,
): unknown {
	const candidates: ProtectedMetadataArrayCandidate[] = [];
	collectProtectedMetadataArrayCandidates(root, [], candidates);
	while (serializedBytes(root) > maxBytes) {
		candidates.sort(compareBackstopCandidates);
		const candidate = candidates.find((entry) => {
			const current = getByPath(root, entry.pathSegments);
			return Array.isArray(current) && current.length > 0;
		});
		if (!candidate) break;
		const current = getByPath(root, candidate.pathSegments);
		if (!Array.isArray(current)) continue;
		setByPath(root, candidate.pathSegments, current.slice(0, -1));
		if (candidate.kind === "changedPaths") {
			const reportPath = candidate.pathSegments.slice(0, -1);
			const report = getByPath(root, reportPath);
			if (typeof report === "object" && report !== null && !Array.isArray(report)) {
				const mutableReport = report as Record<string, unknown>;
				mutableReport.truncated = true;
				mutableReport.omittedPathCount =
					(typeof mutableReport.omittedPathCount === "number" ? mutableReport.omittedPathCount : 0) + 1;
			}
		}
		candidate.bytes = serializedBytes(getByPath(root, candidate.pathSegments));
	}
	return root;
}

function getByPath(root: unknown, pathSegments: readonly PersistencePathSegment[]): unknown {
	let current: any = root;
	for (const segment of pathSegments) {
		if (current == null) return undefined;
		current = current[segment as any];
	}
	return current;
}

function setByPath(
	root: unknown,
	pathSegments: readonly PersistencePathSegment[],
	value: unknown,
): unknown {
	if (pathSegments.length === 0) return value;
	let current: any = root;
	for (const segment of pathSegments.slice(0, -1)) {
		if (current == null) return root;
		current = current[segment as any];
	}
	if (current == null) return root;
	current[pathSegments[pathSegments.length - 1] as any] = value;
	return root;
}

function compareBackstopCandidates(a: BackstopCandidate, b: BackstopCandidate): number {
	return b.bytes - a.bytes || a.pathKey.localeCompare(b.pathKey);
}

function pruneOptionalObjectKeys(
	value: unknown,
	pathSegments: PersistencePathSegment[],
	keysForPath: (path: readonly PersistencePathSegment[]) => PersistenceRequiredKeys,
): void {
	if (typeof value !== "object" || value === null) return;
	if (isProtectedMetadataPath(pathSegments) || metadataPathIndex(pathSegments, "mutationReport") >= 0) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => pruneOptionalObjectKeys(item, [...pathSegments, index], keysForPath));
		return;
	}
	if (pathSegments.length === 1 && pathSegments[0] === "forks") {
		const keys = Object.keys(value).sort();
		for (const key of keys.slice(MAX_PERSISTED_OBJECT_KEYS)) delete (value as Record<string, unknown>)[key];
		for (const [key, nested] of Object.entries(value)) {
			pruneOptionalObjectKeys(nested, [...pathSegments, key], keysForPath);
		}
		return;
	}
	const required = new Set(keysForPath(pathSegments));
	for (const key of Object.keys(value)) {
		if (!required.has(key)) delete (value as Record<string, unknown>)[key];
	}
	for (const [key, nested] of Object.entries(value)) {
		pruneOptionalObjectKeys(nested, [...pathSegments, key], keysForPath);
	}
}

function minimalPersistedValue(
	value: unknown,
	pathSegments: PersistencePathSegment[] = [],
	keysForPath: (path: readonly PersistencePathSegment[]) => PersistenceRequiredKeys = requiredPersistenceKeys,
): unknown {
	if (typeof value === "string") return isProtectedMetadataPath(pathSegments) ? value : truncateText(value, 256);
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) {
		if (isProtectedMetadataArrayPath(pathSegments)) return value;
		if (pathSegments.length === 1 && pathSegments[0] === "finalResult") {
			return value.slice(-MAX_PERSISTED_ARRAY_ITEMS).map((item, index) =>
				minimalPersistedValue(item, [...pathSegments, index], keysForPath),
			);
		}
		if (metadataPathIndex(pathSegments, "mutationReport") >= 0 || metadataPathIndex(pathSegments, "policyRefusals") >= 0) {
			return value;
		}
		return [];
	}
	const required = new Set(keysForPath(pathSegments));
	const isEntryMap = pathSegments.length === 1 && pathSegments[0] === "forks";
	const entries = isEntryMap
		? Object.entries(value)
			.sort(([a], [b]) => comparePersistedKeyNames(a, b))
			.slice(0, MAX_PERSISTED_OBJECT_KEYS)
		: Object.entries(value);
	const out: Record<string, unknown> = {};
	if (isEntryMap) {
		for (const [key, nested] of entries) {
			out[key] = minimalPersistedValue(nested, [...pathSegments, key], keysForPath);
		}
		return out;
	}
	for (const key of required) {
		if (Object.prototype.hasOwnProperty.call(value, key)) {
			// Required nested objects are intentionally retained as `{}` when their
			// own fields are not part of a known persistence shape. This fallback is
			// only reached after recursive caps and optional-key pruning; preserving
			// the container type keeps hydration shape-safe without guessing which
			// arbitrary nested fields are required.
			out[key] = minimalPersistedValue(
				(value as Record<string, unknown>)[key],
				[...pathSegments, key],
				keysForPath,
			);
		}
	}
	return out;
}

/**
 * Serialized-size backstop for pathological but already-recursively-bounded
 * snapshots. The first pass is deterministic largest-string-leaf-first; when
 * strings alone cannot satisfy the budget, largest non-structural arrays are
 * replaced with marker arrays. Markers report the original serialized/string
 * byte size dropped by this backstop pass.
 */
function enforceSerializedSizeBackstop<T>(
	snapshot: T,
	maxBytes: number,
	keysForPath: (path: readonly PersistencePathSegment[]) => PersistenceRequiredKeys = requiredPersistenceKeys,
): T {
	let current: unknown = snapshot;
	if (serializedBytes(current) <= maxBytes) return current as T;
	// Metadata is never shortened with marker text. Drop whole attribution
	// entries first, accounting for every changed path removed, at each
	// per-result, active-entry, and run-level backstop invocation.
	current = dropProtectedMetadataUntilWithinLimit(current, maxBytes);
	if (serializedBytes(current) <= maxBytes) return current as T;

	const stringCandidates: BackstopCandidate[] = [];
	collectStringLeafCandidates(current, [], stringCandidates);
	stringCandidates.sort(compareBackstopCandidates);
	for (const candidate of stringCandidates) {
		if (serializedBytes(current) <= maxBytes) return current as T;
		const existing = getByPath(current, candidate.pathSegments);
		if (typeof existing !== "string") continue;
		const bytes = Buffer.byteLength(existing, "utf8");
		const marker = `[truncated: ${bytes} bytes]`;
		if (Buffer.byteLength(marker, "utf8") >= bytes) continue;
		current = setByPath(current, candidate.pathSegments, marker);
	}
	if (serializedBytes(current) <= maxBytes) return current as T;

	const arrayCandidates: BackstopCandidate[] = [];
	collectArrayCandidates(current, [], arrayCandidates);
	arrayCandidates.sort(compareBackstopCandidates);
	for (const candidate of arrayCandidates) {
		if (serializedBytes(current) <= maxBytes) return current as T;
		const existing = getByPath(current, candidate.pathSegments);
		if (!Array.isArray(existing)) continue;
		const bytes = serializedBytes(existing);
		const markerArray = [`[truncated: ${bytes} bytes]`];
		if (serializedBytes(markerArray) >= bytes) continue;
		current = setByPath(current, candidate.pathSegments, markerArray);
	}
	if (serializedBytes(current) <= maxBytes) return current as T;

	// A payload can be oversized without containing a useful string or array
	// leaf (for example, thousands of long object keys). Prune optional fields
	// while retaining the shape's hydration-critical fields, then use a compact
	// shape-preserving fallback rather than returning a type-invalid root marker.
	pruneOptionalObjectKeys(current, [], keysForPath);
	if (serializedBytes(current) <= maxBytes) return current as T;
	const minimal = minimalPersistedValue(current, [], keysForPath);
	if (serializedBytes(minimal) <= maxBytes) return minimal as T;
	throw new Error(`persisted snapshot exceeds hard limit of ${maxBytes} bytes after fallback`);
}

/**
 * Test-only access to the persistence backstop. Production persistence always
 * supplies its fixed shape-aware required-key policy; this seam lets tests
 * exercise the final hard-cap branch without manufacturing an unbounded live
 * runtime record that the normal sanitizer correctly rejects earlier.
 */
export function __enforceSerializedSizeBackstopForTests(
	snapshot: unknown,
	maxBytes: number,
	requiredKeys: readonly string[] = [],
): unknown {
	return enforceSerializedSizeBackstop(snapshot, maxBytes, () => requiredKeys);
}

/** Test-only access to the generic recursive sanitizer's deterministic naming. */
export function __sanitizePersistedValueForTests(
	value: unknown,
	requiredKeys: readonly string[] = [],
): unknown {
	return sanitizePersistedValueForPersistence(value, [], 0, new WeakSet(), () => requiredKeys);
}

function sanitizeMessagesSnapshotForPersistence(messages: unknown): any[] {
	if (!Array.isArray(messages)) return [];
	return messages.slice(-MAX_PERSISTED_PRIOR_WORKER_MESSAGES) as any[];
}

function sanitizePriorWorkerSessionsForPersistence(
	sessions: RunResult["priorWorkerSessions"],
): RunResult["priorWorkerSessions"] {
	if (!sessions || sessions.length === 0) return undefined;
	return sessions.slice(-MAX_PERSISTED_PRIOR_WORKER_SESSIONS).map((session) => ({
		...(session.sessionFile !== undefined ? { sessionFile: session.sessionFile } : {}),
		messagesSnapshot: sanitizeMessagesSnapshotForPersistence(session.messagesSnapshot),
		endedAt: session.endedAt,
		...(session.retirementReason !== undefined ? { retirementReason: session.retirementReason } : {}),
		restartMessage: session.restartMessage,
	}));
}

/** Resolve the durable runtime registry path for delegate dispatch state. */
export function resolveRuntimeStatePath(agentDir: string): string {
	return path.join(resolveDelegateStateDir(agentDir), "run-state.json");
}

/**
 * Enable durable runtime persistence and optionally hydrate previously-saved
 * runs. Production wires this once from `src/index.ts`; tests leave it unset
 * unless they are explicitly exercising persistence.
 */
export function configureRuntimePersistence(
	agentDir: string | undefined,
	opts: { hydrate?: boolean; markActiveAsOrphaned?: boolean } = {},
): void {
	runtimeStatePath = agentDir ? resolveRuntimeStatePath(agentDir) : undefined;
	runtimeAgentDir = agentDir;
	if (opts.hydrate ?? true) {
		hydrateRuntimeState({ markActiveAsOrphaned: opts.markActiveAsOrphaned ?? true });
	}
}

/**
 * A type-guard so the true branch narrows `RunLiveStatus` down to the three
 * terminal statuses — all of which are also valid `RunStatus` values, which
 * lets `synthesizeFinalResult` assign `f.status` directly without a cast.
 * The non-terminal statuses (`"pending"` / `"constructing"` / `"running"` /
 * `"awaiting-escalation"`) are mapped to `"aborted"` in the result.
 */
function terminalStatus(
	status: RunLiveStatus,
): status is "completed" | "failed" | "aborted" | "paused" {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "aborted" ||
		// Spec 0019 / REQ-PAUSE-1 — paused is terminal (a forced finish), so
		// `synthesizeFinalResult` can assign it through directly rather than
		// down-mapping it to "aborted".
		status === "paused"
	);
}

function cloneRunResult(result: RunResult): RunResult {
	const terminal = result.status === "completed" || result.status === "failed" || result.status === "aborted" || result.status === "paused";
	const uncappedContent = getUncappedResultContent(result, { terminal });
	const source = uncappedContent === undefined
		? result
		: { ...result, collapsedContent: uncappedContent };
	return projectRunResult(source, { capDelegateOnlyResult: false });
}

function timeoutResultMetadata(entry: RunLiveState): RunResult["timeout"] {
	if (!entry.timeoutPolicy || entry.timeoutPolicy.maxDurationMs <= 0) return undefined;
	return {
		...entry.timeoutPolicy,
		...(entry.timeoutDeadlineAtMs !== undefined
			? { deadlineAtMs: entry.timeoutDeadlineAtMs }
			: {}),
	};
}

function synthesizeFinalResult(run: DelegateDispatchState): RunResult[] {
	return Object.values(run.forks).map((entry) => {
		// GitLab #34: if a foreground sync parent dies after an individual entry
		// collapsed but before run-level `completeRun()`, the per-entry terminal
		// snapshot is the most authoritative recoverable output. Prefer it over
		// lossy live fields when synthesizing the orphan's finalResult.
		if (entry.completedResult) {
			const completed = cloneRunResult(entry.completedResult);
			completed.attempt ??= effectiveAttempt(entry);
			completed.timeout ??= timeoutResultMetadata(entry);
			completed.mutationReport ??= unavailableMutationReport("observation unavailable in legacy terminal snapshot");
			return completed;
		}
		return {
			name: entry.name,
			attempt: effectiveAttempt(entry),
			agent: entry.agent,
			agentSource: entry.agentSource ?? "builtin",
			task: entry.task ?? "",
			status: terminalStatus(entry.status) ? entry.status : "aborted",
			roundsUsed: entry.currentRound,
			maxRounds: entry.maxRounds,
			collapseMode: entry.collapseMode ?? "final_output",
			collapsedContent:
				// Spec 0019 / REQ-PAUSE-1 — a paused entry is a real (forced) finish with
				// the supervisor's text in flight, so surface its content like a clean
				// finish rather than blanking it. Failed entries should likewise preserve
				// their diagnostic text so shutdown/reload synthesis does not collapse a
				// provider error back into an empty result.
				entry.status === "completed" || entry.status === "paused"
					? (entry.lastSupervisorText || entry.lastWorkerText || "")
					: entry.status === "failed"
						? (entry.error || entry.lastWorkerText || entry.lastSupervisorText || "")
						: "",
			workerSessionFile: entry.workerSessionFile,
			workerCwd: entry.workerCwd,
			transcript: entry.transcript ?? [],
			mutationReport: unavailableMutationReport("observation unavailable while synthesizing an orphaned entry"),
			error: entry.error,
			errorKind: entry.errorKind,
			refusalModels: entry.refusalModels,
			cancelReason: entry.status === "aborted" ? entry.cancelReason : undefined,
			timeout: timeoutResultMetadata(entry),
			usage: entry.usage
				? { ...entry.usage }
				: {
					supervisorInput: 0,
					supervisorOutput: 0,
					workerInput: 0,
					workerOutput: 0,
					cost: entry.cost ?? 0,
				},
		};
	});
}

function markActiveRunAsOrphaned(run: DelegateDispatchState, now = Date.now()): void {
	let touched = false;
	for (const entry of Object.values(run.forks)) {
		if (terminalStatus(entry.status)) continue;
		entry.status = "aborted";
		entry.error = "aborted: delegate runtime was reloaded or ended before completion";
		entry.cancelReason = "shutdown";
		entry.endedAt = entry.endedAt ?? now;
		touched = true;
	}
	// If a live cancel closure ran just before this snapshot, it may already have
	// marked every entry terminal. Still stamp the run terminal so hydrated status
	// cannot report a zombie active run with only terminal entries.
	const allEntriesTerminal = Object.values(run.forks).every((entry) => terminalStatus(entry.status));
	if (!run.completedAt && (touched || allEntriesTerminal)) {
		run.completedAt = now;
		run.orphanedAt = run.orphanedAt ?? now;
		if (!run.finalResult) run.finalResult = synthesizeFinalResult(run);
	}
}

/**
 * Tier 2 (#459) — does this fork show any evidence that a worker ever
 * established for it? A never-constructed ghost has NONE of these: it is stuck
 * in a pre-establishment status with only `starting`-phase activity.
 *
 * `activityHistory` sources are `local | model | lifecycle`; a `starting` event
 * is `lifecycle`. A `model`-sourced entry, or a `tool`/`error` classification,
 * comes only from a running worker. `startedAt`/`startedAtMs`/`currentRound`/
 * worker text / a worker session file / `lastActivityAt` are all set on or after
 * the first `running` transition, so any of them proves establishment.
 */
function forkShowsWorkerEvidence(fork: RunLiveState): boolean {
	if (fork.startedAt !== undefined || fork.startedAtMs !== undefined) return true;
	if (fork.currentRound > 0) return true;
	if (fork.workerSessionFile !== undefined) return true;
	if (fork.lastWorkerText !== undefined || fork.lastSupervisorText !== undefined) return true;
	if (fork.lastActivityAt !== undefined) return true;
	for (const entry of fork.activityHistory ?? []) {
		if (entry.source === "model") return true;
		if (entry.classification === "tool" || entry.classification === "error") return true;
	}
	return false;
}

/** A pre-establishment (never-promoted-to-running) live status. */
function isPreEstablishmentStatus(status: RunLiveStatus): boolean {
	return status === "constructing" || status === "pending";
}

/**
 * Tier 2 (#459) — is this run a never-constructed ghost: it registered forks
 * but never established a worker, and the construction deadline has elapsed?
 *
 * True only when ALL hold:
 *  - the run is not already terminal, and
 *  - it has at least one fork and EVERY fork is in a pre-establishment status
 *    (`constructing`/`pending`) with no worker evidence, and
 *  - no event-bus event references this run's own runId (a direct dispatch has
 *    `runId === rootRunId`, so an absent sink is a clean signal; a run under a
 *    shared rootRunId is disambiguated by matching this runId as a lineage
 *    segment, so a sibling's sink is not mistaken for this run's worker), and
 *  - the construction deadline has elapsed since the run's `createdAt`.
 *
 * Owner identity is decided by the caller. Matching foreign and unproven
 * generations are never admitted to this workerless classification.
 */
function runNeverConstructed(
	run: DelegateDispatchState,
	now: number,
	deadlineMs: number,
	agentDir: string | undefined,
): boolean {
	if (run.completedAt !== undefined) return false;
	const forks = Object.values(run.forks);
	if (forks.length === 0) return false;
	for (const fork of forks) {
		if (!isPreEstablishmentStatus(fork.status)) return false;
		if (forkShowsWorkerEvidence(fork)) return false;
	}
	if (now - run.createdAt < deadlineMs) return false;
	// Event-bus worker evidence: any event whose address references this runId as
	// a lineage segment means a worker (this process' or a detached child's) did
	// establish and emit for this run. Absent/other-run events are not evidence.
	if (agentDir !== undefined && busReferencesRun(agentDir, run)) return false;
	return true;
}

/** Does the event-bus sink for this run's root contain any event emitted for this runId? */
function busReferencesRun(agentDir: string, run: DelegateDispatchState): boolean {
	const rootRunId = run.rootRunId ?? run.runId;
	if (!rootRunId) return false;
	let events: readonly BusEvent[];
	try {
		events = readBusEvents(agentDir, rootRunId);
	} catch {
		// A read failure is not worker evidence; fall back to the per-run signals
		// already checked above rather than pinning the ghost open forever.
		return false;
	}
	const needle = `${run.runId}#`;
	for (const event of events) {
		if (event.lineagePath?.includes(needle)) return true;
		if (event.ancestorPath?.includes(needle)) return true;
	}
	return false;
}

/**
 * Tier 2 (#459) — stamp a never-constructed run terminal. Mirrors
 * `markActiveRunAsOrphaned`'s run-terminal stamping but with a distinct
 * `cancelReason: "never-constructed"` so status/observability can tell a
 * stuck-dispatch ghost apart from a clean reload orphan.
 */
function terminalizeNeverConstructedRun(run: DelegateDispatchState, now = Date.now()): void {
	for (const fork of Object.values(run.forks)) {
		if (terminalStatus(fork.status)) continue;
		fork.status = "aborted";
		fork.cancelReason = "never-constructed";
		fork.error = "aborted: worker was never constructed (dispatch did not establish a worker)";
		fork.endedAt = fork.endedAt ?? now;
	}
	if (!run.completedAt) {
		run.completedAt = now;
		run.orphanedAt = run.orphanedAt ?? now;
		if (!run.finalResult) run.finalResult = synthesizeFinalResult(run);
	}
}

/**
 * In-memory orphan reaper. Workerless pre-establishment forks retain the
 * `never-constructed` reason after their deadline. Established active forks are
 * terminalized only for a proven-stale owner generation. Matching foreign and
 * unproven generations remain untouched. Callers decide when to persist.
 */
function runHasEstablishedLiveWorker(run: DelegateDispatchState): boolean {
	return Object.values(run.forks).some((fork) =>
		isLiveStatus(fork.status) &&
		(!isPreEstablishmentStatus(fork.status) || forkShowsWorkerEvidence(fork)),
	);
}

function reapNeverConstructedRunsInMemory(
	opts: { now?: number; deadlineMs?: number } = {},
): number {
	const now = opts.now ?? Date.now();
	const deadlineMs = opts.deadlineMs ?? constructionDeadlineMs();
	let reaped = 0;
	for (const run of runs.values()) {
		const owner = runtimeOwnerDisposition(run);
		if (owner === "foreign" || owner === "unproven") continue;
		if (runNeverConstructed(run, now, deadlineMs, runtimeAgentDir)) {
			terminalizeNeverConstructedRun(run, now);
			logDelegateDiagnostic(
				`reaped never-constructed run runId=${run.runId} ` +
					`age=${Math.max(0, now - run.createdAt)}ms owner=${ownerIdentityDiagnostic(owner)} ` +
					`entries=${runStatusDiagnosticSummary(run)}`,
				{ agentDir: runtimeAgentDir },
			);
			reaped += 1;
			continue;
		}
		if (owner !== "stale" || run.completedAt !== undefined || !runHasEstablishedLiveWorker(run)) continue;
		markActiveRunAsOrphaned(run, now);
		logDelegateDiagnostic(
			`reaped stale-owner active run runId=${run.runId} ` +
				`owner=${ownerIdentityDiagnostic(owner)} entries=${runStatusDiagnosticSummary(run)}`,
			{ agentDir: runtimeAgentDir },
		);
		reaped += 1;
	}
	return reaped;
}

/**
 * Reap deadline-expired workerless ghosts and established runs whose complete
 * owner generation is proven stale. Matching foreign and unproven generations
 * are preserved. Piggybacks hydrate, status reads, and opportunistic persistence
 * so it needs no background timer.
 *
 * Returns the number of runs terminalized. Persists only when something changed.
 */
export function reapNeverConstructedRuns(
	opts: {
		now?: number;
		deadlineMs?: number;
		persist?: boolean;
		/** @deprecated Owner decisions use the runtime process-identity dependency seam. */
		pidAliveFn?: (pid: number) => boolean;
	} = {},
): number {
	const reaped = reapNeverConstructedRunsInMemory(opts);
	if (reaped > 0 && (opts.persist ?? true)) persistRuntimeStateNow();
	return reaped;
}

/**
 * Tier 2 (#459) — is one fork a workerless, never-constructed entry: a
 * pre-establishment status with no worker evidence and (for a shared root) no
 * event-bus event referencing this run? The construction deadline is NOT applied
 * here — this is the on-demand user-cancel check, and the user explicitly asked
 * to stop it.
 */
function forkIsWorkerlessGhost(run: DelegateDispatchState, fork: RunLiveState): boolean {
	if (!isPreEstablishmentStatus(fork.status)) return false;
	if (forkShowsWorkerEvidence(fork)) return false;
	if (runtimeAgentDir !== undefined && busReferencesRun(runtimeAgentDir, run)) return false;
	return true;
}

/**
 * Tier 2 (#459) — force a workerless, never-constructed run or entry terminal
 * when a user cancels it. `delegate_control cancel` on such a target used to flip
 * it from `constructing` to `running` (an activity refresh) because no worker
 * existed to receive the cancel; this drives the targeted entries terminal
 * directly instead, ignoring the construction deadline (the user asked to stop).
 *
 * `forkName` is the resolved entry selector:
 *  - undefined → a WHOLE-run cancel: terminalize only when EVERY entry is a
 *    workerless ghost, so a run with any established/live entry falls through to
 *    the normal cancel closure.
 *  - a name → a TARGETED cancel: terminalize ONLY that entry (never broadcasting
 *    to siblings), and complete the run only once every entry is terminal.
 *
 * Returns true iff it terminalized the targeted entry/entries. Returns false
 * (the caller falls through to the normal cancel) when the target is not a
 * workerless ghost, so established or live entries are never force-aborted here.
 */
export function cancelNeverConstructedRun(runId: string, forkName?: string, now = Date.now()): boolean {
	const run = runs.get(runId);
	if (!run || run.completedAt !== undefined) return false;
	const forks = Object.values(run.forks);
	if (forks.length === 0) return false;

	if (forkName !== undefined) {
		// Targeted: the named entry must exist and be a workerless ghost; terminalize
		// only it. A missing or established/live entry is not ours to force-abort.
		const target = run.forks[forkName];
		if (!target || !forkIsWorkerlessGhost(run, target)) return false;
		if (!terminalStatus(target.status)) {
			target.status = "aborted";
			target.cancelReason = "never-constructed";
			target.error = "aborted: worker was never constructed (dispatch did not establish a worker)";
			target.endedAt = target.endedAt ?? now;
		}
		// The run only completes once EVERY entry is terminal; a live/established
		// sibling keeps the run active.
		if (Object.values(run.forks).every((fork) => terminalStatus(fork.status)) && !run.completedAt) {
			run.completedAt = now;
			run.orphanedAt = run.orphanedAt ?? now;
			if (!run.finalResult) run.finalResult = synthesizeFinalResult(run);
		}
		persistRuntimeStateNow();
		emit("delegate:register", { runId });
		return true;
	}

	// Whole-run cancel: only when every entry is a workerless ghost.
	for (const fork of forks) {
		if (!forkIsWorkerlessGhost(run, fork)) return false;
	}
	terminalizeNeverConstructedRun(run, now);
	persistRuntimeStateNow();
	emit("delegate:register", { runId });
	return true;
}


function runStatusDiagnosticSummary(run: { forks?: Record<string, RunLiveState> }): string {
	const entries = Object.values(run.forks ?? {});
	const shown = entries.slice(0, 8).map((entry) => {
		const rawName = typeof entry.name === "string" && entry.name ? entry.name : "(unnamed)";
		const name = rawName.length > 64 ? `${rawName.slice(0, 61)}...` : rawName;
		return `${name}:${entry.status}`;
	});
	const suffix = entries.length > shown.length ? `,+${entries.length - shown.length} more` : "";
	return `[${shown.join(",")}${suffix}]`;
}

function normalizeHydratedWindDown(value: unknown): RunLiveState["windDown"] {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as { atMs?: unknown; reason?: unknown };
	if (
		typeof candidate.atMs !== "number" ||
		!Number.isFinite(candidate.atMs) ||
		(candidate.reason !== "heartbeat" &&
			candidate.reason !== "wall-clock" &&
			candidate.reason !== "unknown")
	) {
		return undefined;
	}
	return { atMs: candidate.atMs, reason: candidate.reason };
}

function normalizeHydratedHeartbeatInterval(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeHydratedHeartbeatCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeHydratedRunEntries(run: DelegateDispatchState): void {
	for (const entry of Object.values(run.forks)) {
		if (!entry.transcript) entry.transcript = [];
		if (!entry.pendingGuidance) entry.pendingGuidance = [];
		entry.activityHistory = normalizeActivityHistory(entry.activityHistory);
		if (typeof entry.interactive !== "boolean") entry.interactive = false;
		if ("heartbeatIntervalMs" in entry) {
			const heartbeatIntervalMs = normalizeHydratedHeartbeatInterval(entry.heartbeatIntervalMs);
			if (heartbeatIntervalMs === undefined) delete entry.heartbeatIntervalMs;
			else entry.heartbeatIntervalMs = heartbeatIntervalMs;
		}
		if ("maxConsecutiveHeartbeats" in entry) {
			const maxConsecutiveHeartbeats = normalizeHydratedHeartbeatCount(entry.maxConsecutiveHeartbeats);
			if (maxConsecutiveHeartbeats === undefined) delete entry.maxConsecutiveHeartbeats;
			else entry.maxConsecutiveHeartbeats = maxConsecutiveHeartbeats;
		}
		if ("windDown" in entry) {
			const windDown = normalizeHydratedWindDown(entry.windDown);
			if (windDown === undefined) delete entry.windDown;
			else entry.windDown = windDown;
		}
	}
}

function normalizeHydratedForkDefaults(run: Pick<DelegateDispatchState, "forks" | "finalResult">): void {
	for (const result of run.finalResult ?? []) {
		if (result.attempt !== undefined && (!Number.isSafeInteger(result.attempt) || result.attempt < 1 || result.attempt > MAX_LINEAGE_DEPTH)) {
			delete result.attempt;
		}
	}
	for (const fork of Object.values(run.forks)) {
		if (!fork.transcript) fork.transcript = [];
		if (!fork.pendingGuidance) fork.pendingGuidance = [];
		fork.activityHistory = normalizeActivityHistory(fork.activityHistory);
		if (typeof fork.interactive !== "boolean") fork.interactive = false;
		// Persisted retry metadata is untrusted. Preserve the underlying entry but
		// quarantine malformed relationship fields rather than hiding its row.
		if (fork.retryOf !== undefined && !isValidForkIdentity(fork.retryOf)) { delete fork.retryOf; fork.retryQuarantined = true; }
		if (fork.retriedBy !== undefined && !isValidForkIdentity(fork.retriedBy)) { delete fork.retriedBy; fork.retryQuarantined = true; }
		if (fork.retryQuarantined !== true) delete fork.retryQuarantined;
		if (fork.attempt !== undefined && (!Number.isSafeInteger(fork.attempt) || fork.attempt < 1 || fork.attempt > MAX_LINEAGE_DEPTH)) { delete fork.attempt; fork.retryQuarantined = true; }
		if (fork.completedResult?.attempt !== undefined && (!Number.isSafeInteger(fork.completedResult.attempt) || fork.completedResult.attempt < 1 || fork.completedResult.attempt > MAX_LINEAGE_DEPTH)) delete fork.completedResult.attempt;
		if ("heartbeatIntervalMs" in fork) {
			const heartbeatIntervalMs = normalizeHydratedHeartbeatInterval(fork.heartbeatIntervalMs);
			if (heartbeatIntervalMs === undefined) delete fork.heartbeatIntervalMs;
			else fork.heartbeatIntervalMs = heartbeatIntervalMs;
		}
		if ("maxConsecutiveHeartbeats" in fork) {
			const maxConsecutiveHeartbeats = normalizeHydratedHeartbeatCount(fork.maxConsecutiveHeartbeats);
			if (maxConsecutiveHeartbeats === undefined) delete fork.maxConsecutiveHeartbeats;
			else fork.maxConsecutiveHeartbeats = maxConsecutiveHeartbeats;
		}
		if ("windDown" in fork) {
			const windDown = normalizeHydratedWindDown(fork.windDown);
			if (windDown === undefined) delete fork.windDown;
			else fork.windDown = windDown;
		}
	}
}

function restoreCompletedRunTranscripts(run: DelegateDispatchState): void {
	restoreCompletedForkTranscripts(run);
}

function reconcileRetryGraph(graphRuns: Iterable<Pick<DelegateDispatchState, "runId" | "forks">>): void {
	const runsById = new Map([...graphRuns].map((run) => [run.runId, run]));
	const lookup = (runId: string, forkName: string): RunLiveState | undefined => runsById.get(runId)?.forks[forkName];
	// Relationship fields are untrusted persisted input. Validate complete
	// components first, then remove both sides of every unsafe edge. Repeating
	// the pass matters: removing one edge can expose a second malformed edge.
	for (let pass = 0; pass <= MAX_LINEAGE_DEPTH; pass++) {
		let changed = false;
		for (const run of runsById.values()) for (const fork of Object.values(run.forks)) {
			if (!fork.retryOf && !fork.retriedBy) {
				// An attempt greater than one is itself retry authority. Without a
				// relation it cannot be reconciled into a valid component, so remove
				// the claim and retain the row as quarantined data.
				if (fork.attempt !== undefined && fork.attempt > 1) {
					delete fork.attempt;
					fork.retryQuarantined = true;
					changed = true;
				}
				continue;
			}
			const identity = { runId: run.runId, forkName: fork.name };
			const component = validateRetryComponent(lookup, identity);
			if (component.ok) continue;
			fork.retryQuarantined = true;
			for (const relation of [fork.retryOf, fork.retriedBy]) {
				if (!relation) continue;
				const other = lookup(relation.runId, relation.forkName);
				if (other) {
					other.retryQuarantined = true;
					if (other.retryOf && sameForkIdentity(other.retryOf, identity)) delete other.retryOf;
					if (other.retriedBy && sameForkIdentity(other.retriedBy, identity)) delete other.retriedBy;
				}
				if (fork.retryOf && sameForkIdentity(fork.retryOf, relation)) delete fork.retryOf;
				if (fork.retriedBy && sameForkIdentity(fork.retriedBy, relation)) delete fork.retriedBy;
				changed = true;
			}
			if (fork.attempt !== undefined && fork.retryOf === undefined && fork.retriedBy === undefined && fork.attempt > 1) { delete fork.attempt; fork.retryQuarantined = true; }
		}
		if (!changed) break;
	}
}

function reconcileHydratedRetryGraph(): void {
	reconcileRetryGraph(runs.values());
}

type RetentionRun = { runId: string; forks: Record<string, RunLiveState> };
type RetentionRunSource = readonly RetentionRun[] | ReadonlyMap<string, RetentionRun>;

function retentionLookup(source: RetentionRunSource, runId: string, forkName: string): RunLiveState | undefined {
	const run = source instanceof Map
		? source.get(runId)
		: Array.isArray(source)
			? source.find((candidate) => candidate.runId === runId)
			: undefined;
	return run?.forks[forkName];
}

function hasUnresolvedRetryFrontier(run: RetentionRun, allRuns?: RetentionRunSource): boolean {
	// A standalone failed run is an ordinary completed record. Only a fork that
	// carries retry lineage can pin a complete component during retention.
	const hasRetryMetadata = Object.values(run.forks).some((fork) =>
		fork.retryOf !== undefined || fork.retriedBy !== undefined || (fork.attempt !== undefined && fork.attempt > 1),
	);
	if (!hasRetryMetadata) return false;
	if (Object.values(run.forks).some((fork) =>
		(fork.status === "failed" || fork.status === "aborted") && fork.retriedBy === undefined,
	)) return true;
	if (!allRuns) return false;
	const lookup = (runId: string, forkName: string): RunLiveState | undefined => retentionLookup(allRuns, runId, forkName);
	for (const fork of Object.values(run.forks)) {
		const component = validateRetryComponent(lookup, { runId: run.runId, forkName: fork.name });
		if (!component.ok) continue;
		const frontier = lookup(component.component.frontier.runId, component.component.frontier.forkName);
		if (frontier && (isLiveStatus(frontier.status) || frontier.status === "failed" || frontier.status === "aborted")) return true;
	}
	return false;
}

/** Return unresolved retry components keyed by their complete identity set. */
function unresolvedRetryComponents(run: RetentionRun, allRuns: ReadonlyMap<string, RetentionRun>): Map<string, Set<string>> {
	const components = new Map<string, Set<string>>();
	if (!Object.values(run.forks).some((fork) =>
		fork.retryOf !== undefined || fork.retriedBy !== undefined || (fork.attempt !== undefined && fork.attempt > 1),
	)) return components;
	const lookup = (runId: string, forkName: string): RunLiveState | undefined => retentionLookup(allRuns, runId, forkName);
	for (const fork of Object.values(run.forks)) {
		const result = validateRetryComponent(lookup, { runId: run.runId, forkName: fork.name });
		if (!result.ok) continue;
		const frontier = lookup(result.component.frontier.runId, result.component.frontier.forkName);
		if (!frontier || !(isLiveStatus(frontier.status) || frontier.status === "failed" || frontier.status === "aborted")) continue;
		const identities = result.component.records.map(({ identity }) => `${identity.runId}\u0000${identity.forkName}`).sort();
		const key = identities.join("\u0001");
		let runIds = components.get(key);
		if (!runIds) components.set(key, runIds = new Set<string>());
		for (const { identity } of result.component.records) runIds.add(identity.runId);
	}
	return components;
}

interface RetryRetentionGroups {
	groups: Set<string>[];
	byRunId: Map<string, Set<string>>;
}

/** Connect every valid retry component, including separate forks on the same run. */
function buildRetryRetentionGroups(allRuns: ReadonlyMap<string, RetentionRun>): RetryRetentionGroups {
	const neighbors = new Map<string, Set<string>>();
	for (const runId of allRuns.keys()) neighbors.set(runId, new Set([runId]));
	const lookup = (runId: string, forkName: string): RunLiveState | undefined => retentionLookup(allRuns, runId, forkName);
	for (const run of allRuns.values()) {
		for (const fork of Object.values(run.forks)) {
			if (fork.retryOf === undefined && fork.retriedBy === undefined && !(fork.attempt !== undefined && fork.attempt > 1)) continue;
			const component = validateRetryComponent(lookup, { runId: run.runId, forkName: fork.name });
			if (!component.ok) continue;
			const runIds = [...new Set(component.component.records.map(({ identity }) => identity.runId))]
				.filter((runId) => allRuns.has(runId));
			for (const runId of runIds) {
				const adjacent = neighbors.get(runId)!;
				for (const relatedRunId of runIds) adjacent.add(relatedRunId);
			}
		}
	}
	const groups: Set<string>[] = [];
	const byRunId = new Map<string, Set<string>>();
	const visited = new Set<string>();
	for (const runId of allRuns.keys()) {
		if (visited.has(runId)) continue;
		const group = new Set<string>();
		const pending = [runId];
		while (pending.length > 0) {
			const candidate = pending.pop()!;
			if (visited.has(candidate)) continue;
			visited.add(candidate);
			group.add(candidate);
			for (const related of neighbors.get(candidate) ?? []) if (!visited.has(related)) pending.push(related);
		}
		groups.push(group);
		for (const groupedRunId of group) byRunId.set(groupedRunId, group);
	}
	return { groups, byRunId };
}

/** Trim only locally owned or proven-stale completed payload records without splitting retry components. */
function trimRetryPayloadToBound(payloadRuns: PersistedRunState[], protectedRunIds: ReadonlySet<string>): PersistedRunState[] {
	const graph = new Map(payloadRuns.map((run) => [run.runId, run]));
	reconcileRetryGraph(graph.values());
	const ownerProtectedIds = new Set<string>();
	for (const run of payloadRuns) {
		if (run.completedAt === undefined) continue;
		const owner = runtimeOwnerDisposition(run);
		if (owner === "foreign" || owner === "unproven") ownerProtectedIds.add(run.runId);
	}
	const retentionGroups = buildRetryRetentionGroups(graph);
	for (const group of retentionGroups.groups) {
		if (![...group].some((runId) => ownerProtectedIds.has(runId))) continue;
		for (const runId of group) ownerProtectedIds.add(runId);
	}
	const nonEvictableIds = new Set([...protectedRunIds, ...ownerProtectedIds]);
	for (const group of retentionGroups.groups) {
		if (![...group].some((runId) => nonEvictableIds.has(runId))) continue;
		for (const runId of group) nonEvictableIds.add(runId);
	}
	const eligibleCompletedCount = () => payloadRuns.reduce(
		(count, run) => count + (run.completedAt !== undefined && !ownerProtectedIds.has(run.runId) ? 1 : 0),
		0,
	);
	if (eligibleCompletedCount() <= MAX_PERSISTED_RUNS) return payloadRuns;
	const orderedGroups = retentionGroups.groups
		.filter((group) => ![...group].some((runId) => nonEvictableIds.has(runId)) &&
			[...group].some((runId) => graph.get(runId)?.completedAt !== undefined))
		.sort((a, b) => {
			const oldest = (group: Set<string>) => Math.min(...[...group].map((runId) => graph.get(runId)?.createdAt ?? 0));
			return oldest(a) - oldest(b);
		});
	const removed = new Set<string>();
	for (const group of orderedGroups) {
		const removedCompleted = [...removed].filter((runId) => graph.get(runId)?.completedAt !== undefined).length;
		if (eligibleCompletedCount() - removedCompleted <= MAX_PERSISTED_RUNS) break;
		for (const runId of group) removed.add(runId);
	}
	return payloadRuns.filter((run) => !removed.has(run.runId));
}

/** Rebuild the logical fork map from value names, not capped persistence keys. */
function restorePersistedForkAddressing(run: DelegateDispatchState): void {
	const entries = Object.entries(run.forks ?? {});
	const rebuilt: Record<string, RunLiveState> = {};
	for (const [key, fork] of entries) {
		const persisted = fork as RunLiveState & { addressName?: unknown };
		const name = typeof persisted.addressName === "string" && persisted.addressName.length > 0
			? persisted.addressName
			: (typeof fork.name === "string" && fork.name.length > 0 ? fork.name : key);
		fork.name = name;
		if (rebuilt[name] !== undefined) rebuilt[key] = fork;
		else rebuilt[name] = fork;
	}
	run.forks = rebuilt;
}

function restoreCompletedForkTranscripts(run: DelegateDispatchState): void {
	if (!run.completedAt || !run.finalResult) return;
	for (const result of run.finalResult) {
		const entry = run.forks[result.name];
		if (!entry) continue;
		if ((entry.transcript?.length ?? 0) === 0 && (result.transcript?.length ?? 0) > 0) {
			entry.transcript = [...result.transcript];
		}
	}
}

function applyPersistedTerminalRunToMemory(run: DelegateDispatchState, saved: PersistedRunState): void {
	run.rootRunId = saved.rootRunId;
	run.ownerSessionId = saved.ownerSessionId;
	run.shape = saved.shape;
	run.notifyOnFailure = saved.notifyOnFailure;
	run.createdAt = saved.createdAt;
	run.completedAt = saved.completedAt;
	run.detached = saved.detached;
	run.orphanedAt = saved.orphanedAt;
	run.syncOrphanRecoverySurfacedAt = saved.syncOrphanRecoverySurfacedAt;
	run.orphanWakeSurfacedAt = saved.orphanWakeSurfacedAt;
	run.owningPid = saved.owningPid;
	run.owningStartTicks = saved.owningStartTicks;
	run.owningBootId = saved.owningBootId;
	run.owningNonce = saved.owningNonce;
	run.forks = Object.fromEntries(
		Object.entries(saved.forks ?? {}).map(([name, entry]) => [name, clonePersistedRunEntry(entry)]),
	);
	run.finalResult = saved.finalResult?.map((result) => {
		const projected = cloneRunResult(result);
		projected.mutationReport ??= unavailableMutationReport("observation unavailable in legacy persisted result");
		return projected;
	});
	restorePersistedForkAddressing(run);
	normalizeHydratedRunEntries(run);
	normalizeHydratedForkDefaults(run);
	restoreCompletedRunTranscripts(run);
	// #470 — a terminal disk record whose result was shed to the per-run sidecar
	// carries no inline finalResult. Restore it (and the fork transcripts) from the
	// sidecar so a process adopting this foreign terminal state can still serve the
	// result, exactly as the hydrate path does.
	if (!run.finalResult && run.completedAt !== undefined && applyRunResultSidecarToHydratedRun(run)) {
		restoreCompletedRunTranscripts(run);
	}
}

/**
 * #465/#470 — restore a completed run from its per-run result sidecar during
 * hydrate. `registerRun` persisted this run into run-state.json as active, but if
 * the shared flush in `completeRun` degraded under lock contention before this
 * process reloaded, the finished result lives only in the sidecar. When one
 * applies, reconstruct the completion in memory (finalResult, completedAt, and
 * each live fork's terminal status) so the run hydrates as completed rather than
 * being stamped an orphan. Returns true when a completion was restored.
 */
function applyRunResultSidecarToHydratedRun(run: DelegateDispatchState): boolean {
	if (!runtimeAgentDir) return false;
	const sidecar = readRunResultSidecar(runtimeAgentDir, run.runId);
	if (!sidecar) return false;
	// Generation guard (CR-SIDECAR-STALE-GENERATION): only restore from a sidecar
	// written by THIS persisted run's generation. A reused runId whose sidecar
	// belongs to a prior generation must not complete the current active run.
	if (sidecar.createdAt !== run.createdAt) return false;
	const finalResult = sidecar.finalResult.map((result) => {
		const projected = cloneRunResult(result);
		projected.mutationReport ??= unavailableMutationReport("observation unavailable in run-result sidecar");
		return projected;
	});
	run.finalResult = finalResult;
	// #470 — the result is durable in the sidecar, so a later persist may keep
	// shedding the inline finalResult rather than rewriting it back into the file.
	run.resultSidecarDurable = true;
	run.completedAt = sidecar.completedAt;
	if (sidecar.orphanedAt !== undefined) run.orphanedAt = sidecar.orphanedAt;
	// Reconcile each still-live fork with its terminal result so a status read
	// renders the run completed instead of a zombie running entry.
	const resultByName = new Map(finalResult.map((result) => [result.name, result]));
	for (const [name, fork] of Object.entries(run.forks)) {
		if (terminalStatus(fork.status)) continue;
		const result = resultByName.get(name);
		fork.status = result && terminalStatus(result.status) ? result.status : "aborted";
		fork.endedAt = fork.endedAt ?? sidecar.completedAt;
	}
	logDelegateDiagnostic(
		`hydrate restored completed run from result sidecar runId=${run.runId} ` +
			`entries=${runStatusDiagnosticSummary(run)}`,
		{ agentDir: runtimeAgentDir },
	);
	return true;
}

/**
 * #470 — restore a SHED completed run's result from its per-run sidecar on the
 * ordinary hydrate path. Unlike {@link applyRunResultSidecarToHydratedRun} (the
 * #465 degrade path, which also reconciles still-live fork statuses and injects an
 * "observation unavailable" mutationReport fallback), this matches the plain-clone
 * fidelity of {@link runtimeRunFromPersisted}: the run was already durably
 * completed with terminal forks, so the sidecar result is restored verbatim and
 * only the dropped fork transcripts are re-linked. Returns true when restored.
 */
function restoreShedCompletedResultFromSidecar(run: DelegateDispatchState): boolean {
	if (!runtimeAgentDir) return false;
	const sidecar = readRunResultSidecar(runtimeAgentDir, run.runId);
	if (!sidecar) return false;
	// Generation guard (CR-SIDECAR-STALE-GENERATION): only a sidecar written by
	// THIS persisted generation may restore this run's result.
	if (sidecar.createdAt !== run.createdAt) return false;
	run.finalResult = sidecar.finalResult.map((result) => cloneRunResult(result));
	if (sidecar.orphanedAt !== undefined) run.orphanedAt = sidecar.orphanedAt;
	run.resultSidecarDurable = true;
	restoreCompletedRunTranscripts(run);
	return true;
}


function runtimeRunFromPersisted(saved: PersistedRunState): DelegateDispatchState {
	const run: DelegateDispatchState = {
		runId: saved.runId,
		rootRunId: saved.rootRunId,
		ownerSessionId: saved.ownerSessionId,
		shape: saved.shape,
		notifyOnFailure: saved.notifyOnFailure,
		createdAt: saved.createdAt,
		completedAt: saved.completedAt,
		detached: saved.detached,
		orphanedAt: saved.orphanedAt,
		syncOrphanRecoverySurfacedAt: saved.syncOrphanRecoverySurfacedAt,
		orphanWakeSurfacedAt: saved.orphanWakeSurfacedAt,
		owningPid: saved.owningPid,
		owningStartTicks: saved.owningStartTicks,
		owningBootId: saved.owningBootId,
		owningNonce: saved.owningNonce,
		forks: Object.fromEntries(
			Object.entries(saved.forks ?? {}).map(([name, entry]) => [name, clonePersistedRunEntry(entry)]),
		),
		finalResult: saved.finalResult?.map((result) => cloneRunResult(result)),
		abort: () => {},
		steer: defaultSteerStub as NonNullable<DelegateDispatchState["steer"]>,
		cancel: defaultCancelStub as NonNullable<DelegateDispatchState["cancel"]>,
	};
	restorePersistedForkAddressing(run);
	normalizeHydratedRunEntries(run);
	normalizeHydratedForkDefaults(run);
	restoreCompletedRunTranscripts(run);
	return run;
}

/**
 * Cap a RunResult's transcript + collapsedContent + workerSession-shaped
 * fields to the persistence limits. Returns a NEW object so the in-memory
 * `finalResult` reference isn't mutated.
 *
 * Used for completed runs only; active runs don't have a `finalResult` yet.
 */
function sanitizeRunResultForPersistence(r: RunResult): RunResult {
	const projected = cloneRunResult(r);
	const shaped: RunResult = {
		...projected,
		transcript: truncateTranscriptEntries(
			projected.transcript,
			MAX_PERSISTED_TRANSCRIPT_ENTRIES_COMPLETED,
			MAX_PERSISTED_ENTRY_TEXT_BYTES,
		),
		collapsedContent:
			typeof projected.collapsedContent === "string"
				? truncateText(projected.collapsedContent, MAX_PERSISTED_COLLAPSED_CONTENT_BYTES)
				: projected.collapsedContent,
		priorWorkerSessions: sanitizePriorWorkerSessionsForPersistence(projected.priorWorkerSessions),
	};
	const recursivelyBounded = sanitizePersistedValueForPersistence(
		shaped,
		[],
		0,
		new WeakSet(),
		requiredRunResultKeys,
	) as RunResult;
	// Mutation and refusal metadata have producer-level bounds that are stricter
	// than the generic 50-item defensive array cap. Restore those fields from the
	// source after generic shaping so a valid 256-path report is not silently
	// shortened without its truncation metadata.
	const boundedMutationReport = projected.mutationReport;
	if (boundedMutationReport) {
		recursivelyBounded.mutationReport = boundedMutationReport.status === "tracked"
			? (() => {
				const changedPaths = [...boundedMutationReport.changedPaths];
				const kept = changedPaths.slice(0, 256);
				const additionallyOmitted = changedPaths.length - kept.length;
				return {
					...boundedMutationReport,
					changedPaths: kept,
					...(additionallyOmitted > 0
						? { truncated: true as const, omittedPathCount: (boundedMutationReport.omittedPathCount ?? 0) + additionallyOmitted }
						: {}),
				};
			})()
			: { ...boundedMutationReport };
	}
	const boundedPolicyRefusals = projected.policyRefusals;
	if (boundedPolicyRefusals) {
		recursivelyBounded.policyRefusals = boundedPolicyRefusals.slice(0, 32).map((refusal) => ({
			boundary: refusal.boundary,
			toolName: refusal.toolName,
			reason: refusal.reason,
		}));
	}
	return enforceSerializedSizeBackstop(
		recursivelyBounded,
		MAX_PERSISTED_ENTRY_RESULT_BYTES,
		requiredRunResultKeys,
	);
}

function cloneValidForkIdentity(value: unknown): RetryOf | undefined {
	if (!isValidForkIdentity(value)) return undefined;
	return { runId: value.runId, forkName: value.forkName };
}

/** Copy retry metadata without allowing a valid identity to retain caller ownership. */
function cloneRetryMetadata(value: unknown): unknown {
	const identity = cloneValidForkIdentity(value);
	if (identity) return identity;
	if (Array.isArray(value)) return value.map(cloneRetryMetadata);
	if (isRecordValue(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneRetryMetadata(nested)]));
	}
	return value;
}

function cloneRunLiveState(state: RunLiveState): RunLiveState {
	// Keep persistence and event snapshots closed over the named live-state
	// contract. In particular, an extra property on a caller-supplied state must
	// not become a durable run-state field through an object spread.
	const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
	const finiteValue = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const optionalStrings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
	const timeoutPolicy = state.timeoutPolicy && typeof state.timeoutPolicy === "object" &&
		finiteValue(state.timeoutPolicy.maxDurationMs) !== undefined &&
		finiteValue(state.timeoutPolicy.windDownGraceMs) !== undefined &&
		finiteValue(state.timeoutPolicy.globalMaxDurationMs) !== undefined
		? {
			maxDurationMs: state.timeoutPolicy.maxDurationMs,
			windDownGraceMs: state.timeoutPolicy.windDownGraceMs,
			globalMaxDurationMs: state.timeoutPolicy.globalMaxDurationMs,
			...(typeof state.timeoutPolicy.enforceWallClockBudget === "boolean"
				? { enforceWallClockBudget: state.timeoutPolicy.enforceWallClockBudget }
				: {}),
		}
		: undefined;
	const transcript = Array.isArray(state.transcript)
		? state.transcript.map(projectTranscriptEntry).filter((entry): entry is TranscriptEntry => entry !== undefined)
		: [];
	const projected: RunLiveState = {
		name: stringValue(state.name) ?? "",
		displayLabel: stringValue(state.displayLabel),
		agent: stringValue(state.agent) ?? "",
		agentSource: isAgentSourceValue(state.agentSource) ? state.agentSource : "builtin",
		task: stringValue(state.task),
		collapseMode: state.collapseMode === "final_output" || state.collapseMode === "summary" ? state.collapseMode : undefined,
		workerCwd: stringValue(state.workerCwd),
		workerBranch: stringValue(state.workerBranch),
		requestedModel: stringValue(state.requestedModel),
		resolvedModel: stringValue(state.resolvedModel),
		skills: optionalStrings(state.skills),
		confineWrites: typeof state.confineWrites === "boolean" ? state.confineWrites : undefined,
		readOnly: typeof state.readOnly === "boolean" ? state.readOnly : undefined,
		cloneMode: stringValue(state.cloneMode),
		status: isRunLiveStatusValue(state.status) ? state.status : "failed",
		currentRound: finiteValue(state.currentRound) ?? 0,
		maxRounds: finiteValue(state.maxRounds) ?? 0,
		lastWorkerText: stringValue(state.lastWorkerText),
		lastSupervisorText: stringValue(state.lastSupervisorText),
		workerSessionFile: stringValue(state.workerSessionFile),
		error: stringValue(state.error),
		errorKind: isWorkerErrorKind(state.errorKind) ? state.errorKind : undefined,
		failureCause: isWorkerFailureCause(state.failureCause) ? state.failureCause : undefined,
		refusalModels: optionalStrings(state.refusalModels),
		startedAt: finiteValue(state.startedAt),
		endedAt: finiteValue(state.endedAt),
		heartbeatIntervalMs: finiteValue(state.heartbeatIntervalMs),
		maxConsecutiveHeartbeats: finiteValue(state.maxConsecutiveHeartbeats),
		windDown: state.windDown && typeof state.windDown === "object" && finiteValue(state.windDown.atMs) !== undefined &&
			(state.windDown.reason === "heartbeat" || state.windDown.reason === "wall-clock" || state.windDown.reason === "unknown")
			? { atMs: state.windDown.atMs, reason: state.windDown.reason }
			: undefined,
		lastActivityAt: finiteValue(state.lastActivityAt),
		taskProgress: projectTaskProgressFields(state.taskProgress),
		transcript,
		activityHistory: normalizeActivityHistory(state.activityHistory),
		pendingGuidance: Array.isArray(state.pendingGuidance) ? state.pendingGuidance.filter((entry): entry is string => typeof entry === "string") : [],
		cancelReason: isCancelReasonValue(state.cancelReason) ? state.cancelReason : undefined,
		startedAtMs: finiteValue(state.startedAtMs),
		timeoutDeadlineAtMs: finiteValue(state.timeoutDeadlineAtMs),
		timeoutPolicy,
		cost: finiteValue(state.cost),
		usage: projectRunUsage(state.usage),
		completedResult: state.completedResult ? cloneRunResult(state.completedResult) : undefined,
		retryOf: cloneValidForkIdentity(state.retryOf),
		retriedBy: cloneValidForkIdentity(state.retriedBy),
		attempt: Number.isSafeInteger(state.attempt) && state.attempt >= 1 && state.attempt <= MAX_LINEAGE_DEPTH ? state.attempt : undefined,
		retryQuarantined: state.retryQuarantined === true ? true : undefined,
		interactive: typeof state.interactive === "boolean" ? state.interactive : false,
	};
	return Object.fromEntries(
		Object.entries(projected).filter(([key, value]) => value !== undefined || Object.prototype.hasOwnProperty.call(state, key)),
	) as RunLiveState;
}

type AddressedRunLiveState = RunLiveState & { addressName?: string };

function clonePersistedRunEntry(entry: RunLiveState): AddressedRunLiveState {
	const cloned = cloneRunLiveState(entry) as AddressedRunLiveState;
	const raw = entry as unknown as Record<string, unknown>;
	const addressName = raw.addressName;
	if (typeof addressName === "string" && addressName.length > 0) cloned.addressName = addressName;
	// Preserve only named retry fields long enough for normalizeHydratedForkDefaults
	// to quarantine malformed persisted metadata; no other unknown field crosses.
	for (const key of ["retryOf", "retriedBy", "attempt", "retryQuarantined"] as const) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) {
			(cloned as unknown as Record<string, unknown>)[key] =
				key === "retryOf" || key === "retriedBy" ? cloneRetryMetadata(raw[key]) : raw[key];
		}
	}
	return cloned;
}

function persistenceRunEntryKeyMap(entries: Record<string, RunLiveState>): Map<string, string> {
	const used = new Set<string>();
	const mapping = new Map<string, string>();
	for (const [name] of Object.entries(entries).sort(([a], [b]) => comparePersistedKeyNames(a, b))) {
		mapping.set(name, allocatePersistedKeyName(name, used));
	}
	return mapping;
}

function requiredRunEntrySnapshotKeys(path: readonly PersistencePathSegment[]): PersistenceRequiredKeys {
	return path.length === 0 ? PERSISTED_ENTRY_REQUIRED_KEYS : [];
}

function requiredRunResultKeys(path: readonly PersistencePathSegment[]): PersistenceRequiredKeys {
	return path.length === 0 ? PERSISTED_RESULT_REQUIRED_KEYS : [];
}

function sanitizeRunForPersistence(run: DelegateDispatchState): PersistedRunState {
	const isCompleted = run.completedAt !== undefined;
	// #470 — a completed run whose result is durable in its per-run sidecar sheds
	// the inline finalResult from the shared file (the transcripts inside it are
	// the dominant bloat, and the sidecar is authoritative).
	const shedInlineFinalResult = isCompleted && run.resultSidecarDurable === true;
	const persistedEntries: Record<string, RunLiveState> = {};
	const entryKeyMap = persistenceRunEntryKeyMap(run.forks);
	for (const [name, entry] of Object.entries(run.forks)) {
		const persistedName = entryKeyMap.get(name) ?? truncateKeyName(name);
		// For completed runs, drop forks[name].transcript entirely — the same
		// data is in finalResult[*].transcript and persisting both was a major
		// source of run-state.json bloat (Apr 2026 incident: 26 MB of
		// duplication across 27 runs). Hydrate restores the link by copying
		// finalResult.transcript back into forks[name].transcript so the
		// transcript overlay still has data to render.
		const transcript = isCompleted
			? []
			: truncateTranscriptEntries(
					entry.transcript,
					MAX_PERSISTED_TRANSCRIPT_ENTRIES_ACTIVE,
					MAX_PERSISTED_ENTRY_TEXT_BYTES,
				);
		// Keep the bounded persistence key in `name` for old readers, while
		// retaining the exact addressing identity for hydration and retry links.
		const shapedRunEntry = {
			...cloneRunLiveState(entry),
			name: persistedName,
			addressName: name,
			transcript,
			pendingGuidance: entry.pendingGuidance ?? [],
			// While a run is still ACTIVE, keep each entry's terminal snapshot on the
			// entry record so a sync parent crash before `completeRun()` remains
			// recoverable. Once the run has a canonical run-level `finalResult`, omit
			// this duplicate from disk to avoid reintroducing completed-run bloat.
			completedResult:
				!isCompleted && entry.completedResult
					? sanitizeRunResultForPersistence(entry.completedResult)
					: undefined,
			lastWorkerText:
				typeof entry.lastWorkerText === "string"
					? truncateText(entry.lastWorkerText, MAX_PERSISTED_LAST_TEXT_BYTES)
					: entry.lastWorkerText,
			lastSupervisorText:
				typeof entry.lastSupervisorText === "string"
					? truncateText(entry.lastSupervisorText, MAX_PERSISTED_LAST_TEXT_BYTES)
					: entry.lastSupervisorText,
		};
		const recursivelyBounded = sanitizePersistedValueForPersistence(
			shapedRunEntry,
			[],
			0,
			new WeakSet(),
			requiredRunEntrySnapshotKeys,
		) as RunLiveState;
		// Preserve the active transcript tail length selected above (200 for
		// active runs, 0 for completed runs). The recursive catch-all defaults
		// arbitrary arrays to 50 items, but transcript retention is intentionally
		// governed by the historical transcript-specific caps.
		recursivelyBounded.transcript = transcript.map(
			(entry, index) =>
				sanitizePersistedValueForPersistence(entry, ["transcript", index]) as TranscriptEntry,
		);
		recursivelyBounded.activityHistory = normalizeActivityHistory(
			entry.activityHistory,
		).slice(-MAX_ACTIVITY_HISTORY_ENTRIES);
		persistedEntries[persistedName] = enforceSerializedSizeBackstop(
			recursivelyBounded,
			MAX_PERSISTED_ENTRY_SNAPSHOT_BYTES,
			requiredRunEntrySnapshotKeys,
		);
	}
	const ownerSessionId = isValidOwnerSessionId(run.ownerSessionId) ? run.ownerSessionId : undefined;
	const shapedRun: PersistedRunState = {
		runId: run.runId,
		rootRunId: run.rootRunId,
		...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
		shape: run.shape,
		notifyOnFailure: run.notifyOnFailure,
		createdAt: run.createdAt,
		completedAt: run.completedAt,
		detached: run.detached,
		orphanedAt: run.orphanedAt,
		syncOrphanRecoverySurfacedAt: run.syncOrphanRecoverySurfacedAt,
		orphanWakeSurfacedAt: run.orphanWakeSurfacedAt,
		...projectProcessOwnerFields(run),
		forks: persistedEntries,
		// #470 — shed the heavy inline finalResult once the per-run sidecar holds
		// it durably; hydrate restores this run's result and its fork transcripts
		// from the sidecar. A completed run WITHOUT a durable sidecar keeps its
		// finalResult inline, so a result is never durable in neither place.
		finalResult: shedInlineFinalResult
			? undefined
			: run.finalResult
				?.slice(-MAX_PERSISTED_ARRAY_ITEMS)
				.map((result) => {
					const projectedResult = cloneRunResult(result);
					projectedResult.name = entryKeyMap.get(result.name) ?? truncateKeyName(result.name);
					return sanitizeRunResultForPersistence(projectedResult);
				}),
	};
	return enforceSerializedSizeBackstop(shapedRun, MAX_PERSISTED_RUN_BYTES);
}

// ── Debounced persistence ─────────────────────────────────────────────────
// Pre-fix every mutation (status update, transcript append, guidance
// push/drain) called persistRuntimeState() synchronously. With 250+
// transcript entries per entry and 27+ runs in flight that meant 6750+
// full-file rewrites per stress run — quadratic write amplification that
// took the unit-test stress path to ~2 minutes.
//
// Now: high-frequency mutations call schedulePersist(), which coalesces
// every persist request inside a 50ms window into a single write.
// Lifecycle events (registerRun / completeRun / abortAllRuns / hydrate)
// and tests still call persistRuntimeStateNow() for synchronous semantics.
const PERSIST_DEBOUNCE_MS = 50;
const PERSIST_RETRY_INITIAL_MS = 50;
const PERSIST_RETRY_MAX_MS = 5_000;

// ── Tier 2 (#459): never-constructed reaper ─────────────────────────────────
//
// A dispatch registers its entry as `"constructing"` (detached) or `"pending"`
// BEFORE the worker session boots — the intended slow-boot window for a
// `clone_mode:'full'` history clone. A transient lock timeout or a crashed boot
// can leave that entry stuck: never promoted to `"running"`, no worker process,
// no event-bus sink — a ghost that displays as a live worker forever. The reaper
// protects matching foreign and unproven generations while reclaiming local or
// proven-stale ghosts after the construction deadline.
//
// The construction deadline distinguishes a healthily-booting entry from one
// that will never establish. 600_000ms (10 min) is above BOTH the measured
// worst-case healthy full-clone boot (312.5s in retained state) and one worker
// heartbeat interval (DEFAULT_HEARTBEAT_INTERVAL_MS = 180_000), so it can never
// false-kill a slow-but-healthy boot. A false reap of a real worker is the
// expensive error, so the deadline errs high; PI_DELEGATE_CONSTRUCTION_DEADLINE_MS
// raises it further for genuinely slower environments.
const DEFAULT_CONSTRUCTION_DEADLINE_MS = 600_000;
function readEnvPositiveIntMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}
function constructionDeadlineMs(): number {
	return readEnvPositiveIntMs("PI_DELEGATE_CONSTRUCTION_DEADLINE_MS", DEFAULT_CONSTRUCTION_DEADLINE_MS);
}
// The opportunistic persist-path pass is throttled to at most once per this
// interval so it adds no measurable per-write cost; hydrate and status reads
// always reap regardless of this throttle.
const REAP_MIN_INTERVAL_MS = 30_000;
let lastPersistPathReapAt = 0;

// ── Tier 4 (#458/#459): lifecycle-critical synchronous persist retry ─────────
//
// A lifecycle-critical synchronous write (the hydrate write-back on the bind
// path) gets a small bounded retry with jittered backoff BEYOND the single
// 5000ms lock attempt before the caller degrades. The observed contention was
// one sibling re-grabbing the lock every ~15s while writing a large file, so a
// few short jittered retries clear the common transient case without extending
// the bind wait unboundedly. On ultimate timeout the caller degrades (keeps
// in-memory state, schedules the async backoff retry) rather than throwing.
const LIFECYCLE_PERSIST_MAX_RETRIES = 3;
const LIFECYCLE_PERSIST_RETRY_BASE_MS = 25;
const LIFECYCLE_PERSIST_RETRY_MAX_MS = 250;
function sleepMs(ms: number): void {
	if (ms <= 0) return;
	// Synchronous sleep: this runs on the bind path where the alternative is
	// aborting the bind. Atomics.wait blocks only this thread, briefly and bounded.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Tier 4 — persist with a bounded, jittered synchronous retry on lock timeout.
 * Returns true if a write landed, false if every attempt timed out (the caller
 * then degrades). Any non-timeout error propagates.
 */
function persistRuntimeStateWithRetry(): boolean {
	for (let attempt = 0; attempt <= LIFECYCLE_PERSIST_MAX_RETRIES; attempt += 1) {
		try {
			persistRuntimeStateNow();
			return true;
		} catch (error) {
			if (!(error instanceof StateLockTimeoutError)) throw error;
			if (attempt === LIFECYCLE_PERSIST_MAX_RETRIES) return false;
			const base = Math.min(LIFECYCLE_PERSIST_RETRY_MAX_MS, LIFECYCLE_PERSIST_RETRY_BASE_MS * (2 ** attempt));
			const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
			sleepMs(Math.min(LIFECYCLE_PERSIST_RETRY_MAX_MS, base + jitter));
		}
	}
	return false;
}

// ── #470: dispatch-registration lock retry ───────────────────────────────────
//
// A dispatch's registration persist (`registerRun`) used to make ONE 5000ms lock
// attempt and, on timeout, roll back and rethrow — so a single transient
// contention spike across sibling sessions rejected an otherwise-healthy
// `delegate` dispatch outright ("timed out acquiring state lock ... after
// 5000ms"). Registration is dispatch-critical, so unlike the best-effort
// debounced writes it cannot silently degrade; but it also should not die on a
// momentary spike. The first attempt keeps the full budget; follow-up attempts
// use a SHORT lock wait so a genuinely stuck lock is not multiplied into a
// many-second dispatch hang. On ultimate timeout the caller still rolls back and
// rethrows (#459), so a failed dispatch leaves no ghost.
const REGISTRATION_PERSIST_MAX_RETRIES = 4;
const REGISTRATION_PERSIST_RETRY_LOCK_TIMEOUT_MS = 1_000;
const REGISTRATION_PERSIST_RETRY_BASE_MS = 25;
const REGISTRATION_PERSIST_RETRY_MAX_MS = 250;

/**
 * #470 — persist a registration with a bounded, jittered retry on lock timeout.
 * The first attempt uses the default 5000ms lock budget; each retry uses a short
 * budget so the total added wait stays a few seconds at most. Rethrows the last
 * `StateLockTimeoutError` when every attempt times out (the caller rolls back).
 * Any non-timeout error propagates immediately.
 */
function persistRegistrationOrThrow(): void {
	let lastTimeout: StateLockTimeoutError | undefined;
	for (let attempt = 0; attempt <= REGISTRATION_PERSIST_MAX_RETRIES; attempt += 1) {
		try {
			persistRuntimeStateNow(
				attempt === 0 ? {} : { lockTimeoutMs: REGISTRATION_PERSIST_RETRY_LOCK_TIMEOUT_MS },
			);
			return;
		} catch (error) {
			if (!(error instanceof StateLockTimeoutError)) throw error;
			lastTimeout = error;
			if (attempt === REGISTRATION_PERSIST_MAX_RETRIES) break;
			const base = Math.min(
				REGISTRATION_PERSIST_RETRY_MAX_MS,
				REGISTRATION_PERSIST_RETRY_BASE_MS * (2 ** attempt),
			);
			const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
			sleepMs(Math.min(REGISTRATION_PERSIST_RETRY_MAX_MS, base + jitter));
		}
	}
	// Unreachable in practice (a break only follows a caught timeout), but keeps
	// the return type total without importing state-io's private default.
	throw lastTimeout ?? new StateLockTimeoutError(runtimeStatePath ?? "run-state", 5_000);
}
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistTimerIsTerminalCoalesce = false;
let persistPending = false;
let nextPersistRetryDelayMs = PERSIST_RETRY_INITIAL_MS;

type PersistTimerKind = "debounce" | "terminal-coalesce" | "retry";

function armPersistTimer(
	kind: PersistTimerKind = "debounce",
	delayMs = PERSIST_DEBOUNCE_MS,
): void {
	if (!runtimeStatePath) return;
	if (persistTimer) return; // already scheduled / inside the coalesce window
	persistTimerIsTerminalCoalesce = kind === "terminal-coalesce";
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		persistTimerIsTerminalCoalesce = false;
		if (!persistPending) return;
		try {
			// Keep the dirty marker until the write succeeds. A lock timeout is
			// expected contention for this best-effort timer path, not a reason to
			// discard the in-memory update.
			persistRuntimeStateNow();
			persistPending = false;
			nextPersistRetryDelayMs = PERSIST_RETRY_INITIAL_MS;
		} catch (err) {
			if (!(err instanceof StateLockTimeoutError)) throw err;
			const retryDelayMs = nextPersistRetryDelayMs;
			logDelegateDiagnostic(
				`debounced runtime persist timed out acquiring state lock target=${err.target} ` +
					`error=${err.message}; retryDelayMs=${retryDelayMs}`,
				{ agentDir: runtimeAgentDir },
			);
			armPersistTimer("retry", retryDelayMs);
			nextPersistRetryDelayMs = Math.min(PERSIST_RETRY_MAX_MS, retryDelayMs * 2);
		}
	}, delayMs);
	// Don't keep the event loop alive just for a debounced write or retry.
	if (typeof persistTimer === "object" && persistTimer && "unref" in persistTimer) {
		(persistTimer as { unref: () => void }).unref();
	}
}

function schedulePersist(): void {
	if (!runtimeStatePath) return;
	persistPending = true;
	armPersistTimer();
}

function persistTerminalSnapshotCoalesced(): void {
	if (!runtimeStatePath) return;
	if (persistTimer && persistTimerIsTerminalCoalesce) {
		persistPending = true;
		return;
	}
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
		persistTimerIsTerminalCoalesce = false;
	}
	// Keep the first terminal entry snapshot crash-resilient, then open a short
	// coalesce window so rapid sibling completions do not each synchronously
	// rewrite the entire run-state file. `completeRun()` and `abortAllRuns()`
	// call `flushRuntimePersistence()` to guarantee any trailing snapshot lands
	// before normal run completion / shutdown teardown returns.
	// Residual abnormal-shutdown window: if the Node process receives SIGKILL
	// (or exits without Pi's `session_shutdown` path) during this short coalesce
	// window, the latest in-memory sibling completion may be missing from disk.
	// We intentionally do not install SIGTERM/beforeExit handlers here: SIGTERM
	// listeners change Node's default signal-exit behavior unless they re-signal
	// or force-exit, and beforeExit does not cover SIGKILL. Graceful Pi shutdown
	// is already covered by the synchronous flushes above.
	persistPending = false;
	try {
		persistRuntimeStateNow();
	} catch (err) {
		// #519 — a transient shared-lock timeout during the terminal per-fork
		// snapshot must not throw into the direct-dispatch pump, whose `.catch`
		// converts a completed run into `completeRun(runId, [])` — an empty
		// "(no output)" failure that discards recoverable worker output. Degrade
		// exactly like the debounced writer above: keep the dirty marker and re-arm
		// a jittered retry so the snapshot lands later. The in-memory terminal state
		// (and `completeRun`'s per-run sidecar) still protect the result, so this
		// never swallows a timeout as a lossy success. Any non-timeout error still
		// propagates.
		if (!(err instanceof StateLockTimeoutError)) throw err;
		persistPending = true;
		const retryDelayMs = nextPersistRetryDelayMs;
		logDelegateDiagnostic(
			`terminal snapshot persist timed out acquiring state lock target=${err.target} ` +
				`error=${err.message}; retryDelayMs=${retryDelayMs}`,
			{ agentDir: runtimeAgentDir },
		);
		armPersistTimer("retry", retryDelayMs);
		nextPersistRetryDelayMs = Math.min(PERSIST_RETRY_MAX_MS, retryDelayMs * 2);
		return;
	}
	armPersistTimer("terminal-coalesce");
}

/**
 * Synchronous flush. Cancels any pending debounced write and immediately
 * persists current state. Used by lifecycle events that must guarantee an
 * on-disk snapshot before they return (e.g. abortAllRuns must persist
 * before pi-core finishes session teardown), and exported for tests that
 * read run-state.json after a mutation.
 * Returns true only when no store is configured or a canonical replacement
 * succeeds. Ordinary I/O failures remain best-effort for legacy callers but are
 * exposed as false to liveness code that needs positive durability evidence.
 */
export function flushRuntimePersistence(): boolean {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
		persistTimerIsTerminalCoalesce = false;
	}
	persistPending = false;
	nextPersistRetryDelayMs = PERSIST_RETRY_INITIAL_MS;
	return persistRuntimeStateNow();
}

/**
 * Read the current on-disk run list for the cross-process merge in
 * `persistRuntimeStateNow`. A corrupt source is preserved beside the original
 * before this caller recovers with an empty merge base.
 */
function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRunLiveStatusValue(value: unknown): value is RunLiveStatus {
	return RUN_LIVE_STATUSES.includes(value as RunLiveStatus);
}

const MAX_OWNER_SESSION_ID_BYTES = 512;

function isValidOwnerSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Buffer.byteLength(value, "utf8") > 0 &&
		Buffer.byteLength(value, "utf8") <= MAX_OWNER_SESSION_ID_BYTES &&
		!/\p{Cc}/u.test(value)
	);
}

function isAgentSourceValue(value: unknown): boolean {
	return value === "builtin" || value === "user" || value === "project" || value === "package";
}

function isCancelReasonValue(value: unknown): boolean {
	return value === "user" || value === "timeout" || value === "heartbeat" || value === "supervisor" || value === "shutdown" || value === "never-constructed";
}

function isRunStatusValue(value: unknown): value is RunResult["status"] {
	return (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "aborted" ||
		value === "paused"
	);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalKnownValue(
	value: Record<string, unknown>,
	key: string,
	isValid: (candidate: unknown) => boolean,
): boolean {
	return !hasOwn(value, key) || value[key] === undefined || isValid(value[key]);
}

function isStrictActivityStatusEntry(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	return (
		typeof value.text === "string" &&
		(value.source === "local" || value.source === "model" || value.source === "lifecycle") &&
		(value.classification === "tool" || value.classification === "phase" || value.classification === "lifecycle" || value.classification === "error") &&
		isFiniteNumber(value.timestamp)
	);
}

function isStrictActivityHistory(value: unknown): value is ActivityStatusEntry[] {
	return Array.isArray(value) && value.every((entry) => isStrictActivityStatusEntry(entry));
}

function boundedTaskString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isStrictTaskProgressRow(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	if (value.status !== "pending" && value.status !== "active" && value.status !== "done" && value.status !== "blocked" && value.status !== "deferred") return false;
	const idKind = value.idKind === undefined ? "owner" : value.idKind;
	if (idKind !== "owner" && idKind !== "local") return false;
	const id = idKind === "owner" ? value.ownerTaskId : value.localTaskId;
	const otherId = idKind === "owner" ? value.localTaskId : value.ownerTaskId;
	if (!boundedTaskString(id, MAX_SEED_TASK_ID_CHARS) || otherId !== undefined) return false;
	if (value.reason !== undefined && (value.status !== "blocked" || !boundedTaskString(value.reason, MAX_SEED_NOTE_CHARS))) return false;
	return true;
}

function isStrictTaskProgress(value: unknown): value is TaskProgressFields {
	if (!isRecordValue(value)) return false;
	if (
		value.kind !== "task" ||
		value.schemaVersion !== 1 ||
		!Number.isSafeInteger(value.done) ||
		!Number.isSafeInteger(value.total) ||
		!Number.isSafeInteger(value.blocked) ||
		(value.done as number) < 0 ||
		(value.total as number) < 0 ||
		(value.blocked as number) < 0 ||
		(value.active !== null && !boundedTaskString(value.active, MAX_SEED_TITLE_CHARS)) ||
		(value.outcome !== "complete" && value.outcome !== "gap" && value.outcome !== "stuck")
	) return false;
	if (hasOwn(value, "rows") && (!Array.isArray(value.rows) || !value.rows.every((row) => isStrictTaskProgressRow(row)))) return false;
	return projectTaskProgressFields(value) !== undefined;
}

const LIVE_USAGE_KEYS = [
	"supervisorInput", "supervisorOutput", "supervisorCacheRead", "supervisorCacheWrite",
	"workerInput", "workerOutput", "workerCacheRead", "workerCacheWrite",
	"tickerInput", "tickerOutput", "tickerCacheRead", "tickerCacheWrite", "tickerCost", "cost",
] as const;
const REQUIRED_RESULT_USAGE_KEYS = ["supervisorInput", "supervisorOutput", "workerInput", "workerOutput", "cost"] as const;

function isStrictUsageDiagnostic(value: unknown): boolean {
	return isRecordValue(value) && isUsageCounterKey(value.field) &&
		(value.reason === "not-a-number" || value.reason === "negative" || value.reason === "non-finite");
}

function isStrictLiveUsage(value: unknown, requireResultCounters = false): value is RunUsage {
	if (!isRecordValue(value)) return false;
	const countersValid = LIVE_USAGE_KEYS.every((key) =>
		value[key] === undefined || (isFiniteNumber(value[key]) && (value[key] as number) >= 0),
	);
	const diagnosticsValid = !hasOwn(value, "diagnostics") || value.diagnostics === undefined ||
		(Array.isArray(value.diagnostics) && value.diagnostics.every((diagnostic) => isStrictUsageDiagnostic(diagnostic)));
	if (!countersValid || !diagnosticsValid) return false;
	if (requireResultCounters && !REQUIRED_RESULT_USAGE_KEYS.every((key) => isFiniteNumber(value[key]) && (value[key] as number) >= 0)) return false;
	return true;
}

function isStrictTimeoutDuration(value: unknown): boolean {
	return normalizeTimeoutMs(value) !== undefined && (value as number) <= MAX_TIMEOUT_MS;
}

function isStrictTimeoutPolicy(value: unknown, allowDeadline = false): boolean {
	if (!isRecordValue(value)) return false;
	if (!["maxDurationMs", "windDownGraceMs", "globalMaxDurationMs"].every((key) => isStrictTimeoutDuration(value[key]))) return false;
	if (hasOwn(value, "enforceWallClockBudget") && value.enforceWallClockBudget !== undefined && typeof value.enforceWallClockBudget !== "boolean") return false;
	if (allowDeadline && hasOwn(value, "deadlineAtMs") && value.deadlineAtMs !== undefined && !isFiniteNumber(value.deadlineAtMs)) return false;
	return true;
}

function isStrictSupervisorFinishPayload(value: unknown): boolean {
	return isRecordValue(value) && optionalKnownValue(value, "final_output", (candidate) => typeof candidate === "string") &&
		optionalKnownValue(value, "summary", (candidate) => typeof candidate === "string");
}

function isStrictInputDigests(value: unknown): boolean {
	return Array.isArray(value) && value.every((digest) =>
		isRecordValue(digest) && isFiniteNumber(digest.sequence) && digest.algorithm === "sha256" && typeof digest.digest === "string",
	);
}

function isStrictHarvest(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	if (value.kind === "substantive") return (value.method === "terminal" || value.method === "salvage") && typeof value.text === "string";
	if (value.kind === "failure") {
		return typeof value.error === "string" &&
			optionalKnownValue(value, "errorKind", (candidate) => isWorkerErrorKind(candidate)) &&
			optionalKnownValue(value, "stopReason", (candidate) => typeof candidate === "string");
	}
	return value.kind === "missing" &&
		(value.reason === "no-assistant" || value.reason === "empty" || value.reason === "cancellation-only") &&
		value.text === "";
}

function isStrictAgentContentBlock(value: unknown, role: "user" | "assistant" | "toolResult"): boolean {
	if (!isRecordValue(value) || typeof value.type !== "string") return false;
	if (value.type === "text") return typeof value.text === "string" && value.text.length > 0 &&
		optionalKnownValue(value, "textSignature", (candidate) => typeof candidate === "string");
	if (value.type === "image") return role !== "assistant" && typeof value.data === "string" && value.data.length > 0 &&
		typeof value.mimeType === "string" && value.mimeType.length > 0;
	if (value.type === "thinking") return role === "assistant" && typeof value.thinking === "string" && value.thinking.length > 0 &&
		optionalKnownValue(value, "thinkingSignature", (candidate) => typeof candidate === "string") &&
		optionalKnownValue(value, "redacted", (candidate) => typeof candidate === "boolean");
	if (value.type === "toolCall") return role === "assistant" && typeof value.id === "string" && value.id.length > 0 &&
		typeof value.name === "string" && value.name.length > 0 && isRecordValue(value.arguments) &&
		optionalKnownValue(value, "thoughtSignature", (candidate) => typeof candidate === "string") &&
		optionalKnownValue(value, "namespace", (candidate) => typeof candidate === "string");
	return false;
}

function isStrictAgentContent(value: unknown, role: "user" | "assistant" | "toolResult", allowEmptyAssistant = false): boolean {
	if (role === "user" && typeof value === "string") return value.length > 0;
	return Array.isArray(value) && (value.length > 0 || (role === "assistant" && allowEmptyAssistant)) &&
		value.every((block) => isStrictAgentContentBlock(block, role));
}

function isStrictAgentSdkUsage(value: unknown): boolean {
	if (!isRecordValue(value) || !isRecordValue(value.cost)) return false;
	const required = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const costRequired = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
	const validNumber = (candidate: unknown) => isFiniteNumber(candidate) && (candidate as number) >= 0;
	if (!required.every((key) => validNumber(value[key])) || !costRequired.every((key) => validNumber(value.cost[key]))) return false;
	return optionalKnownValue(value, "cacheWrite1h", validNumber) && optionalKnownValue(value, "reasoning", validNumber);
}

function isStrictAgentMessage(value: unknown): boolean {
	if (!isRecordValue(value) || !isFiniteNumber(value.timestamp)) return false;
	if (value.role === "user") return isStrictAgentContent(value.content, "user");
	if (value.role === "assistant") {
		if (typeof value.api !== "string" || value.api.length === 0 || typeof value.provider !== "string" || value.provider.length === 0 ||
			typeof value.model !== "string" || value.model.length === 0 ||
			(value.stopReason !== "pending" && value.stopReason !== "stop" && value.stopReason !== "length" && value.stopReason !== "toolUse" &&
				value.stopReason !== "error" && value.stopReason !== "aborted" && value.stopReason !== "deferred") ||
			!isStrictAgentContent(value.content, "assistant", value.stopReason === "error" || value.stopReason === "aborted") ||
			!isStrictAgentSdkUsage(value.usage)) return false;
		return optionalKnownValue(value, "responseModel", (candidate) => typeof candidate === "string") &&
			optionalKnownValue(value, "responseId", (candidate) => typeof candidate === "string") &&
			optionalKnownValue(value, "errorMessage", (candidate) => typeof candidate === "string") &&
			optionalKnownValue(value, "rawStopReason", (candidate) => typeof candidate === "string") &&
			optionalKnownValue(value, "endTurn", (candidate) => typeof candidate === "boolean");
	}
	if (value.role !== "toolResult" || typeof value.toolCallId !== "string" || value.toolCallId.length === 0 ||
		typeof value.toolName !== "string" || value.toolName.length === 0 || typeof value.isError !== "boolean" ||
		!isStrictAgentContent(value.content, "toolResult")) return false;
	return optionalKnownValue(value, "usage", isStrictAgentSdkUsage) &&
		optionalKnownValue(value, "addedToolNames", (candidate) => Array.isArray(candidate) && candidate.every((name) => typeof name === "string"));
}

function isStrictPriorWorkerSessions(value: unknown, projected: RunResult): boolean {
	if (!Array.isArray(value)) return false;
	if (value.length === 0) return true;
	const projectedSessions = projected.priorWorkerSessions;
	if (!projectedSessions || projectedSessions.length !== value.length) return false;
	return value.every((session, index) => {
		if (!isRecordValue(session) || !Array.isArray(session.messagesSnapshot) || !isFiniteNumber(session.endedAt) || typeof session.restartMessage !== "string") return false;
		if (!optionalKnownValue(session, "sessionFile", (candidate) => typeof candidate === "string")) return false;
		if (!optionalKnownValue(session, "retirementReason", (candidate) => candidate === "restart_worker" || candidate === "refusal-fallback" || candidate === "transient-fallback")) return false;
		const projectedMessages = projectedSessions[index]?.messagesSnapshot;
		return projectedMessages !== undefined && projectedMessages.length === session.messagesSnapshot.length &&
			session.messagesSnapshot.every((message) => isStrictAgentMessage(message));
	});
}

function isStrictResultOptionalFields(value: Record<string, unknown>, projected: RunResult): boolean {
	if (!optionalKnownValue(value, "attempt", (candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= MAX_LINEAGE_DEPTH)) return false;
	if (!optionalKnownValue(value, "workerSessionFile", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "inputDigests", isStrictInputDigests)) return false;
	if (hasOwn(value, "taskLedger") && value.taskLedger !== undefined && projected.taskLedger === undefined) return false;
	if (!optionalKnownValue(value, "recoveredOutput", (candidate) => typeof candidate === "boolean")) return false;
	if (!optionalKnownValue(value, "workerCwd", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "supervisorFinishPayload", isStrictSupervisorFinishPayload)) return false;
	if (!optionalKnownValue(value, "summaryModelUsed", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "summaryFallbackReason", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "error", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "errorKind", (candidate) => isWorkerErrorKind(candidate))) return false;
	if (!optionalKnownValue(value, "refusalModels", isStringArray)) return false;
	if (!optionalKnownValue(value, "policyRefusals", isPolicyRefusalArray)) return false;
	if (!optionalKnownValue(value, "mutationReport", isMutationReportRecord)) return false;
	if (!optionalKnownValue(value, "workerModel", (candidate) => typeof candidate === "string")) return false;
	if (!optionalKnownValue(value, "attemptedModels", isStringArray)) return false;
	if (!optionalKnownValue(value, "cancelReason", isCancelReasonValue)) return false;
	if (!optionalKnownValue(value, "steered", (candidate) => typeof candidate === "boolean")) return false;
	if (!optionalKnownValue(value, "timeout", (candidate) => isStrictTimeoutPolicy(candidate, true))) return false;
	if (!optionalKnownValue(value, "priorWorkerSessions", (candidate) => isStrictPriorWorkerSessions(candidate, projected))) return false;
	const projectedExtensions = projected as RunResult & { harvest?: unknown; outputFile?: unknown; artifactRef?: unknown; artifactError?: unknown };
	if (!optionalKnownValue(value, "harvest", isStrictHarvest)) return false;
	if (!optionalKnownValue(value, "outputFile", (candidate) => projectedExtensions.outputFile !== undefined && isRecordValue(candidate))) return false;
	if (!optionalKnownValue(value, "artifactRef", (candidate) => projectedExtensions.artifactRef !== undefined && isRecordValue(candidate))) return false;
	if (!optionalKnownValue(value, "artifactError", (candidate) => projectedExtensions.artifactError !== undefined && isRecordValue(candidate))) return false;
	if (!optionalKnownValue(value, "warnings", (candidate) => Array.isArray(candidate) && candidate.every((warning) =>
		isRecordValue(warning) && (warning.kind === "reads" || warning.kind === "output" || warning.kind === "progress" || warning.kind === "policy") && typeof warning.message === "string",
	))) return false;
	return true;
}

function isStructurallyValidRunResultPatch(value: unknown): value is Record<string, unknown> {
	if (!isRecordValue(value)) return false;
	const usage = value.usage;
	if (
		typeof value.name !== "string" ||
		typeof value.agent !== "string" ||
		!isAgentSourceValue(value.agentSource) ||
		typeof value.task !== "string" ||
		!isRunStatusValue(value.status) ||
		!isFiniteNumber(value.roundsUsed) ||
		!isFiniteNumber(value.maxRounds) ||
		(value.collapseMode !== "final_output" && value.collapseMode !== "summary") ||
		typeof value.collapsedContent !== "string" ||
		!isTranscriptArray(value.transcript) ||
		!isStrictLiveUsage(usage, true)
	) return false;
	const projected = projectRunResult(value);
	return isStrictResultOptionalFields(value, projected);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (!isRecordValue(value)) return false;
	const validSources = new Set(["supervisor", "worker"]);
	const validRoles = new Set(["user", "assistant", "toolCall", "toolResult", "thinking", "system", "text"]);
	return (
		validSources.has(value.source as string) &&
		validRoles.has(value.role as string) &&
		typeof value.text === "string" &&
		(value.timestamp === undefined || isFiniteNumber(value.timestamp)) &&
		(value.toolName === undefined || typeof value.toolName === "string") &&
		(value.toolCallId === undefined || typeof value.toolCallId === "string") &&
		(value.toolMeta === undefined || typeof value.toolMeta === "string") &&
		(value.isError === undefined || typeof value.isError === "boolean")
	);
}

function isTranscriptArray(value: unknown): value is TranscriptEntry[] {
	return Array.isArray(value) && value.every((entry) => isTranscriptEntry(entry));
}

function isPersistedUsage(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	const counterKeys = Object.keys(value).filter((key) => isUsageCounterKey(key));
	const countersValid = counterKeys.every((key) =>
		value[key] === undefined || (isFiniteNumber(value[key]) && value[key] >= 0),
	);
	const diagnosticsValid = value.diagnostics === undefined || (
		Array.isArray(value.diagnostics) &&
		value.diagnostics.every((entry) =>
			isRecordValue(entry) &&
			typeof entry.field === "string" &&
			(entry.reason === "not-a-number" || entry.reason === "negative" || entry.reason === "non-finite"),
		)
	);
	return countersValid && diagnosticsValid;
}

function isTimeoutPolicy(value: unknown, allowDeadline = false): boolean {
	if (!isRecordValue(value)) return false;
	const required = ["maxDurationMs", "windDownGraceMs", "globalMaxDurationMs"];
	const numeric = [...required, ...(allowDeadline ? ["deadlineAtMs"] : [])];
	return required.every((key) => isFiniteNumber(value[key])) &&
		(hasOwn(value, "enforceWallClockBudget") ? value.enforceWallClockBudget === undefined || typeof value.enforceWallClockBudget === "boolean" : true) &&
		numeric.every((key) => value[key] === undefined || isFiniteNumber(value[key]));
}

function isSupervisorFinishPayload(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	return (
		(value.final_output === undefined || typeof value.final_output === "string") &&
		(value.summary === undefined || typeof value.summary === "string")
	);
}

function isPersistedPriorWorkerSessions(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((entry) =>
			isRecordValue(entry) &&
			Array.isArray(entry.messagesSnapshot) &&
			entry.messagesSnapshot.every((message) => isRecordValue(message)) &&
			isFiniteNumber(entry.endedAt) &&
			typeof entry.restartMessage === "string",
		)
	);
}

function isMutationReportRecord(value: unknown): boolean {
	if (!isRecordValue(value) || (value.status !== "tracked" && value.status !== "not-tracked")) return false;
	if (value.status === "tracked") {
		return typeof value.repositoryRoot === "string" && isStringArray(value.changedPaths) &&
			(value.truncated === undefined || value.truncated === true) &&
			(value.omittedPathCount === undefined || isFiniteNumber(value.omittedPathCount));
	}
	return isMutationNotTrackedReason(value.reason) && (value.detail === undefined || typeof value.detail === "string");
}

function isPolicyRefusalArray(value: unknown): boolean {
	return Array.isArray(value) && value.length <= 32 && value.every((entry) =>
		isRecordValue(entry) && (entry.boundary === "readOnly" || entry.boundary === "writableRoot") &&
		(entry.toolName === "write" || entry.toolName === "edit" || entry.toolName === "bash") &&
		typeof entry.reason === "string" && entry.reason.length <= 1000,
	);
}

function isForkWarningArray(value: unknown): value is NonNullable<RunResult["warnings"]> {
	return Array.isArray(value) && value.every((entry) =>
		isRecordValue(entry) &&
		// `policy` included (#536): omitting it made hydration reject and quarantine
		// a whole persisted run whose result carried a refused-write warning.
		(entry.kind === "reads" || entry.kind === "output" || entry.kind === "progress" || entry.kind === "policy") &&
		typeof entry.message === "string",
	);
}

function isPersistedRunResultRecord(value: unknown): boolean {
	if (!isRecordValue(value)) return false;
	// Older snapshots used by cross-process merge only carried the result name,
	// status, and transcript. Keep those records hydratable while validating any
	// richer fields that are present so malformed nested results cannot reach a
	// consumer that assumes their shape.
	return (
		typeof value.name === "string" &&
		(value.addressName === undefined || typeof value.addressName === "string") &&
		(value.agent === undefined || typeof value.agent === "string") &&
		(value.agentSource === undefined || isAgentSourceValue(value.agentSource)) &&
		(value.task === undefined || typeof value.task === "string") &&
		(value.status === undefined || isRunStatusValue(value.status)) &&
		(value.roundsUsed === undefined || isFiniteNumber(value.roundsUsed)) &&
		(value.maxRounds === undefined || isFiniteNumber(value.maxRounds)) &&
		(value.collapseMode === undefined || value.collapseMode === "final_output" || value.collapseMode === "summary") &&
		(value.collapsedContent === undefined || typeof value.collapsedContent === "string") &&
		(value.transcript === undefined || isTranscriptArray(value.transcript)) &&
		(value.usage === undefined || isPersistedUsage(value.usage)) &&
		(value.supervisorFinishPayload === undefined || isSupervisorFinishPayload(value.supervisorFinishPayload)) &&
		(value.priorWorkerSessions === undefined || isPersistedPriorWorkerSessions(value.priorWorkerSessions)) &&
		(value.timeout === undefined || isTimeoutPolicy(value.timeout, true)) &&
		(value.workerSessionFile === undefined || typeof value.workerSessionFile === "string") &&
		(value.inputDigests === undefined || (
			Array.isArray(value.inputDigests) && value.inputDigests.every((entry) =>
				isRecordValue(entry) && isFiniteNumber(entry.sequence) &&
				entry.algorithm === "sha256" && typeof entry.digest === "string",
			)
		)) &&
		(value.recoveredOutput === undefined || typeof value.recoveredOutput === "boolean") &&
		(value.warnings === undefined || isForkWarningArray(value.warnings)) &&
		(value.workerCwd === undefined || typeof value.workerCwd === "string") &&

		(value.summaryModelUsed === undefined || typeof value.summaryModelUsed === "string") &&
		(value.summaryFallbackReason === undefined || typeof value.summaryFallbackReason === "string") &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.errorKind === undefined || isWorkerErrorKind(value.errorKind)) &&
		(value.failureCause === undefined || isWorkerFailureCause(value.failureCause)) &&
		(value.refusalModels === undefined || isStringArray(value.refusalModels)) &&
		(value.policyRefusals === undefined || isPolicyRefusalArray(value.policyRefusals)) &&
		(value.mutationReport === undefined || isMutationReportRecord(value.mutationReport)) &&
		(value.workerModel === undefined || typeof value.workerModel === "string") &&
		(value.attemptedModels === undefined || isStringArray(value.attemptedModels)) &&
		// Retry attempt metadata is validated and repaired after hydration.
		(value.cancelReason === undefined || isCancelReasonValue(value.cancelReason)) &&
		(value.steered === undefined || typeof value.steered === "boolean")
	);
}

function isPersistedRunLiveStateRecord(value: unknown): value is RunLiveState {
	if (!isRecordValue(value)) return false;
	const numericOptionalKeys = [
		"startedAt",
		"endedAt",
		"lastActivityAt",
		"startedAtMs",
		"timeoutDeadlineAtMs",
		"cost",
	];
	return (
		typeof value.name === "string" &&
		(value.addressName === undefined || typeof value.addressName === "string") &&
		(value.retryQuarantined === undefined || typeof value.retryQuarantined === "boolean") &&
		typeof value.agent === "string" &&
		(value.agentSource === undefined || isAgentSourceValue(value.agentSource)) &&
		isRunLiveStatusValue(value.status) &&
		isFiniteNumber(value.currentRound) &&
		isFiniteNumber(value.maxRounds) &&
		(value.transcript === undefined || isTranscriptArray(value.transcript)) &&
		(value.pendingGuidance === undefined || isStringArray(value.pendingGuidance)) &&
		(value.activityHistory === undefined || (
			Array.isArray(value.activityHistory) &&
			value.activityHistory.every((entry) => isRecordValue(entry) && typeof entry.text === "string")
		)) &&
		(value.interactive === undefined || typeof value.interactive === "boolean") &&
		(value.task === undefined || typeof value.task === "string") &&
		(value.collapseMode === undefined || value.collapseMode === "final_output" || value.collapseMode === "summary") &&
		(value.workerCwd === undefined || typeof value.workerCwd === "string") &&
		(value.workerBranch === undefined || typeof value.workerBranch === "string") &&
		(value.requestedModel === undefined || typeof value.requestedModel === "string") &&
		(value.resolvedModel === undefined || typeof value.resolvedModel === "string") &&
		(value.skills === undefined || isStringArray(value.skills)) &&
		(value.confineWrites === undefined || typeof value.confineWrites === "boolean") &&
		(value.readOnly === undefined || typeof value.readOnly === "boolean") &&
		(value.cloneMode === undefined || typeof value.cloneMode === "string") &&
		(value.lastWorkerText === undefined || typeof value.lastWorkerText === "string") &&
		(value.lastSupervisorText === undefined || typeof value.lastSupervisorText === "string") &&
		(value.workerSessionFile === undefined || typeof value.workerSessionFile === "string") &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.errorKind === undefined || isWorkerErrorKind(value.errorKind)) &&
		(value.failureCause === undefined || isWorkerFailureCause(value.failureCause)) &&
		(value.refusalModels === undefined || isStringArray(value.refusalModels)) &&
		(value.cancelReason === undefined || isCancelReasonValue(value.cancelReason)) &&
		(value.completedResult === undefined || isPersistedRunResultRecord(value.completedResult)) &&
		(value.usage === undefined || isPersistedUsage(value.usage)) &&
		(value.timeoutPolicy === undefined || isTimeoutPolicy(value.timeoutPolicy)) &&
		// Retry fields are untrusted persisted metadata. Keep the enclosing run
		// hydratable so normalization can quarantine only the unsafe relationship.
		numericOptionalKeys.every((key) => value[key] === undefined || isFiniteNumber(value[key]))
	);
}

function isPersistedRunStateRecord(value: unknown): value is PersistedRunState {
	if (!isRecordValue(value)) return false;
	return (
		typeof value.runId === "string" &&
		(value.ownerSessionId === undefined || isValidOwnerSessionId(value.ownerSessionId)) &&
		(value.owningPid === undefined || isValidProcessId(value.owningPid)) &&
		(value.owningStartTicks === undefined || isValidProcessStartTicks(value.owningStartTicks)) &&
		(value.owningBootId === undefined || isValidProcessBootId(value.owningBootId)) &&
		(value.owningNonce === undefined || isValidProcessNonce(value.owningNonce)) &&
		isFiniteNumber(value.createdAt) &&
		(value.completedAt === undefined || isFiniteNumber(value.completedAt)) &&
		isRecordValue(value.forks) &&
		Object.values(value.forks).every((entry) => isPersistedRunLiveStateRecord(entry)) &&
		(value.finalResult === undefined || (
			Array.isArray(value.finalResult) &&
			value.finalResult.every((result) => isPersistedRunResultRecord(result))
		))
	);
}

interface PersistedRunsValidation {
	runs: PersistedRunState[];
	invalidRuns: unknown[];
	/**
	 * Tier 3 (#459) — the on-disk file's schema version, defaulting to 1 when
	 * absent. A value greater than CURRENT_STATE_SCHEMA_VERSION means a NEWER build
	 * wrote this shared file; callers on the WRITE path must not overwrite it (a
	 * lossy downgrade), and read best-effort instead. See CR-NEWER-SCHEMA-CLOBBER.
	 */
	fileVersion: number;
}

/**
 * Tier 3 (#459) — migrate one persisted run record from an older schema version
 * to CURRENT, composed one hop at a time. The v1→v2 hop is close to identity (a
 * v1 record validates as v2 because v2 only widened the `cancelReason`
 * vocabulary and added reaper semantics, both additive on read), but the hook
 * exists so the NEXT breaking shape change — a rename or removal — has a home and
 * is not silently dropped as an unknown record. Runs BEFORE
 * `isPersistedRunStateRecord` so a mapped field is validated, not discarded.
 */
function migratePersistedRunRecord(candidate: unknown, fromVersion: number): unknown {
	// v1 → v2: identity. Future hops chain here, each guarded by `fromVersion`
	// and reassigning a mutable `record` before the return.
	void fromVersion;
	return candidate;
}

/**
 * Tier 3 (#459) — read the durable state file's records with a real version gate:
 *  - missing or an OLDER version → migrate each record forward, then validate;
 *  - the CURRENT version → validate as-is;
 *  - a NEWER version (a future build wrote this shared file, an older build reads
 *    it) → read best-effort with the closed-shape validator (which already
 *    ignores unknown keys) and NEVER quarantine-drop the whole file. This
 *    protects the multi-session shared-file reality where builds can differ.
 */
function persistedRunsFromValue(value: unknown): PersistedRunsValidation | undefined {
	if (!isRecordValue(value) || !Array.isArray(value.runs)) return undefined;
	const rawVersion = value.version;
	const fileVersion = typeof rawVersion === "number" && Number.isFinite(rawVersion) ? rawVersion : 1;
	const isNewerFile = fileVersion > CURRENT_STATE_SCHEMA_VERSION;
	const needsMigration = fileVersion < CURRENT_STATE_SCHEMA_VERSION;
	const runs: PersistedRunState[] = [];
	const invalidRuns: unknown[] = [];
	for (const candidate of value.runs) {
		const migrated = needsMigration ? migratePersistedRunRecord(candidate, fileVersion) : candidate;
		if (isPersistedRunStateRecord(migrated)) {
			runs.push(migrated);
		} else if (isNewerFile) {
			// A newer build may have written a record shape this build cannot fully
			// validate. Preserve it best-effort rather than quarantine-dropping a
			// whole newer file; only drop it if it is not even a record.
			if (isRecordValue(migrated) && typeof migrated.runId === "string") {
				runs.push(migrated as unknown as PersistedRunState);
			} else {
				invalidRuns.push(candidate);
			}
		} else {
			invalidRuns.push(candidate);
		}
	}
	return { runs, invalidRuns, fileVersion };
}

let invalidRunQuarantineSequence = 0;

function preserveInvalidPersistedRuns(file: string, invalidRuns: readonly unknown[]): string | undefined {
	if (invalidRuns.length === 0) return undefined;
	const candidate = `${file}.invalid-${Date.now()}-${process.pid}-${invalidRunQuarantineSequence++}.json`;
	try {
		replaceJsonFile(candidate, {
			version: CURRENT_STATE_SCHEMA_VERSION,
			droppedAt: Date.now(),
			droppedRuns: invalidRuns,
		});
		return candidate;
	} catch {
		return undefined;
	}
}

function repairInvalidPersistedRuns(
	file: string,
	parsed: PersistedRunsValidation,
): PersistedRunsValidation & { preserved?: string } {
	return withStateFileLock(file, () => {
		const latest = readJsonFile(file);
		if (latest.kind !== "ok") return parsed;
		const current = persistedRunsFromValue(latest.value);
		if (!current || current.invalidRuns.length === 0) return current ?? parsed;
		// Tier 3 (#459) — CR-NEWER-SCHEMA-CLOBBER. Never rewrite a newer file; a
		// repair would downgrade it. Leave it intact and report what we read.
		if (current.fileVersion > CURRENT_STATE_SCHEMA_VERSION) return current;
		const preserved = preserveInvalidPersistedRuns(file, current.invalidRuns);
		// Never publish a destructive repair when the invalid records could not
		// first be written to a quarantine sidecar. The canonical file remains the
		// last recoverable copy until a later attempt can preserve those records.
		if (!preserved) return current;
		replaceJsonFile(file, {
			version: CURRENT_STATE_SCHEMA_VERSION,
			writtenAt: Date.now(),
			runs: current.runs,
		});
		return { ...current, preserved };
	});
}

interface RuntimeHydrationRead {
	result: ReturnType<typeof readJsonFile>;
	preserved?: string;
}

function readRuntimeStateForHydration(file: string): RuntimeHydrationRead {
	return withStateFileLock(file, () => {
		const result = readJsonFile(file);
		if (result.kind === "corrupt") {
			return { result, preserved: preserveCorruptFile(file) };
		}
		if (result.kind === "ok" && !persistedRunsFromValue(result.value)) {
			return { result, preserved: preserveCorruptFile(file) };
		}
		return { result };
	});
}

function preserveRuntimeCorruptForMerge(file: string): string | undefined {
	const preserved = preserveCorruptFile(file);
	if (preserved) return preserved;
	let isRegularFile = false;
	try {
		isRegularFile = lstatSync(file).isFile();
	} catch {
		/* A concurrent remover may have taken the source away. */
	}
	if (isRegularFile && readJsonFile(file).kind !== "absent") {
		throw new Error("runtime state is corrupt and could not be preserved before replacement");
	}
	return undefined;
}

function readPersistedRunsForRetryAdmission(file: string): PersistedRunState[] {
	const result = readJsonFile(file);
	if (result.kind === "absent") return [];
	// Admission rejection is a no-side-effect boundary. Do not preserve,
	// quarantine, or rewrite unrelated malformed durable records while deciding
	// whether a retry is eligible.
	if (result.kind === "corrupt") throw new Error("retry registration rejected: malformed-durable-state");
	const parsed = persistedRunsFromValue(result.value);
	if (!parsed || parsed.invalidRuns.length > 0) throw new Error("retry registration rejected: malformed-durable-state");
	// Tier 3 (#459) — CR-NEWER-SCHEMA-CLOBBER. A newer build wrote this shared
	// file; this build must not author over it (the admission path ends in a
	// replaceJsonFile). Reject the admission rather than downgrade the file — a
	// retry can be re-attempted by a compatible build.
	if (parsed.fileVersion > CURRENT_STATE_SCHEMA_VERSION) throw new Error("retry registration rejected: newer-durable-schema");
	return parsed.runs;
}

function readPersistedRunsForMerge(file: string): { runs: PersistedRunState[]; fileVersion: number } {
	const result = readJsonFile(file);
	if (result.kind === "absent") return { runs: [], fileVersion: CURRENT_STATE_SCHEMA_VERSION };
	if (result.kind === "corrupt") {
		const preserved = preserveRuntimeCorruptForMerge(file);
		logDelegateDiagnostic(
			`failed to read runtime state for merge: ${result.error.message}` +
				(preserved ? `; preserved corrupt file at ${preserved}` : "; corrupt file was not moved"),
			{ agentDir: runtimeAgentDir },
		);
		return { runs: [], fileVersion: CURRENT_STATE_SCHEMA_VERSION };
	}
	const parsed = persistedRunsFromValue(result.value);
	if (!parsed) {
		const preserved = preserveRuntimeCorruptForMerge(file);
		logDelegateDiagnostic(
			`runtime state has an invalid persisted shape` +
				(preserved ? `; preserved corrupt file at ${preserved}` : "; corrupt file was not moved"),
			{ agentDir: runtimeAgentDir },
		);
		return { runs: [], fileVersion: CURRENT_STATE_SCHEMA_VERSION };
	}
	if (parsed.invalidRuns.length > 0) {
		const preserved = preserveInvalidPersistedRuns(file, parsed.invalidRuns);
		if (!preserved) {
			// The caller holds the state lock. Refuse the merge rather than allowing
			// its later canonical replacement to erase records that could not be
			// quarantined.
			throw new Error("malformed runtime records could not be quarantined before merge");
		}
		logDelegateDiagnostic(
			`runtime state dropped ${parsed.invalidRuns.length} malformed persisted run record(s)` +
				`; preserved at ${preserved}`,
			{ agentDir: runtimeAgentDir },
		);
	}
	return { runs: parsed.runs, fileVersion: parsed.fileVersion };
}

/**
 * Test-only observability for persist amplification (issue #11): counts every
 * ATTEMPTED synchronous persist (even when `runtimeStatePath` is unset, as in
 * most unit tests). Reset by `__resetRuntimeForTests`.
 */
let persistInvocationCount = 0;
export function __getPersistInvocationCountForTests(): number {
	return persistInvocationCount;
}

function persistRuntimeStateNow(
	opts: { completedRunDeletions?: ReadonlySet<string>; lockTimeoutMs?: number } = {},
): boolean {
	persistInvocationCount += 1;
	if (!runtimeStatePath) {
		reconcileDurablyTerminalLocalRegistrations();
		return true;
	}
	const statePath = runtimeStatePath;
	let persistingRunId: string | undefined;
	let durableReplacement = false;
	try {
		withStateFileLock(statePath, () => {
		// Tier 2 (#459) — opportunistic never-constructed reap, throttled to at
		// most once per REAP_MIN_INTERVAL_MS so it adds no measurable per-write
		// cost. In-memory only: its terminalizations are folded into the snapshot
		// built just below and written by this same persist (no recursive persist).
		// Hydrate and status reads always reap regardless of this throttle.
		{
			const reapNow = Date.now();
			if (reapNow - lastPersistPathReapAt >= REAP_MIN_INTERVAL_MS) {
				lastPersistPathReapAt = reapNow;
				reapNeverConstructedRunsInMemory({ now: reapNow });
			}
		}
		// Trim this process's completed candidates before the merge to retain the
		// existing local-owner behavior; the final merged collection is capped
		// globally below, after foreign disk records have been considered.
		const sorted = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
		const active = sorted.filter((r) => r.completedAt === undefined);
		// Keep every local completed candidate until the ownership-aware merge has
		// built the retry graph. Trimming here can discard an ancestor before the
		// lineage-aware retention pass can pin its complete component.
		const completed = sorted.filter((r) => r.completedAt !== undefined);
		const keep = [...completed, ...active].sort((a, b) => a.createdAt - b.createdAt);

		// ── Cross-process merge (issue #4) ────────────────────────────────
		// Multiple pi sessions share one agentDir and therefore one
		// run-state.json. Writing the whole in-memory Map verbatim is a
		// read-once / write-everything cycle: this process hydrates the file
		// ONCE at session_start and then clobbers every later write a sibling
		// process makes (its runs vanish; our stale hydrated copies of its
		// runs overwrite its fresh ones). The merge rule:
		//   - a complete matching local generation makes memory authoritative;
		//   - a complete matching foreign generation makes disk authoritative;
		//   - a proven-stale generation follows the existing orphan/deletion
		//     reconciliation; and
		//   - unproven or legacy identity preserves durable disk state and never
		//     authorizes a stale-memory overwrite, deletion, or resurrection.
		// The complete read/merge/replace transaction is protected by the
		// per-state-file lock held by the caller.
		const { runs: diskRuns, fileVersion: diskFileVersion } = readPersistedRunsForMerge(statePath);
		// Tier 3 (#459) — CR-NEWER-SCHEMA-CLOBBER. A NEWER build wrote this shared
		// file (its schema version exceeds ours). This build cannot losslessly
		// re-serialize a shape it does not fully model, so overwriting the file would
		// silently downgrade it and strip the newer build's fields. Abort the write
		// and leave the newer file byte-for-byte intact; our in-memory state is kept
		// and a later persist by a compatible build re-merges it. Reading stays
		// best-effort (persistedRunsFromValue preserves newer records), so this
		// process still SEES the sibling's runs; it just never authors over them.
		if (diskFileVersion > CURRENT_STATE_SCHEMA_VERSION) {
			logDelegateDiagnostic(
				`runtime persist skipped: on-disk state schema version ${diskFileVersion} is newer than ` +
					`this build's ${CURRENT_STATE_SCHEMA_VERSION}; preserving the newer file instead of a lossy downgrade`,
				{ agentDir: runtimeAgentDir },
			);
			return;
		}
		const diskById = new Map(diskRuns.map((r) => [r.runId, r]));
		const diskOwnerById = new Map(diskRuns.map((run) => [run.runId, runtimeOwnerDisposition(run)]));
		const diskRetentionGroups = buildRetryRetentionGroups(diskById);
		const merged = new Map<string, PersistedRunState>();
		for (const run of keep) {
			persistingRunId = run.runId;
			const disk = diskById.get(run.runId);
			mergeCommittedRetryFields(run, disk);
			const sanitized = sanitizeRunForPersistence(run);
			const memoryOwner = runtimeOwnerDisposition(sanitized);
			const diskOwner = disk ? diskOwnerById.get(disk.runId) : undefined;
			const wasHydrated = hydratedRunIds.has(sanitized.runId);

			// A durable matching-foreign or unproven generation is protected from
			// non-local memory. This also handles an owner generation updated on disk
			// after this process hydrated an older snapshot.
			if (memoryOwner !== "local" && disk && (diskOwner === "foreign" || diskOwner === "unproven")) {
				if (disk.completedAt !== undefined && sanitized.completedAt === undefined) {
					applyPersistedTerminalRunToMemory(run, disk);
				}
				merged.set(sanitized.runId, disk);
				continue;
			}

			if (wasHydrated && disk?.completedAt !== undefined && sanitized.completedAt === undefined && memoryOwner !== "local") {
				// Terminal disk state is newer evidence than non-local hydrated active
				// memory, even when the recorded owner has since become stale.
				logDelegateDiagnostic(
					`runtime merge kept terminal disk over stale active memory runId=${sanitized.runId} ` +
						`ownerSessionId(memory=${sanitized.ownerSessionId ?? "-"},disk=${disk.ownerSessionId ?? "-"}) ` +
						`owningPid(memory=${sanitized.owningPid ?? "-"},disk=${disk.owningPid ?? "-"}) ` +
						`ownerIdentity=${ownerIdentityDiagnostic(memoryOwner)} ` +
						`diskCompletedAt=${new Date(disk.completedAt).toISOString()} ` +
						`memoryEntries=${runStatusDiagnosticSummary(sanitized)} diskEntries=${runStatusDiagnosticSummary(disk)}`,
					{ agentDir: runtimeAgentDir },
				);
				applyPersistedTerminalRunToMemory(run, disk);
				merged.set(sanitized.runId, disk);
				continue;
			}

			if (wasHydrated && memoryOwner === "stale" && sanitized.completedAt === undefined) {
				if (!disk) {
					// The stale owner removed this record after hydration. Preserve that
					// deletion and clear only the stale hydrated in-memory view.
					logDelegateDiagnostic(
						`runtime merge dropped stale active foreign run missing on disk runId=${sanitized.runId} ` +
							`ownerSessionId=${sanitized.ownerSessionId ?? "-"} ` +
							`owningPid=${sanitized.owningPid ?? "-"} ownerIdentity=${ownerIdentityDiagnostic(memoryOwner)} ` +
							`memoryEntries=${runStatusDiagnosticSummary(sanitized)}`,
						{ agentDir: runtimeAgentDir },
					);
					runs.delete(sanitized.runId);
					hydratedRunIds.delete(sanitized.runId);
					continue;
				}
				logDelegateDiagnostic(
					`runtime merge orphaned stale active foreign run runId=${sanitized.runId} ` +
						`ownerSessionId=${sanitized.ownerSessionId ?? "-"} ` +
						`owningPid=${sanitized.owningPid ?? "-"} ownerIdentity=${ownerIdentityDiagnostic(memoryOwner)} ` +
						`memoryEntries=${runStatusDiagnosticSummary(sanitized)} diskEntries=${runStatusDiagnosticSummary(disk)}`,
					{ agentDir: runtimeAgentDir },
				);
				markActiveRunAsOrphaned(run);
				merged.set(sanitized.runId, sanitizeRunForPersistence(run));
				continue;
			}

			if (memoryOwner === "foreign") {
				if (disk) merged.set(sanitized.runId, disk);
				else if (wasHydrated) {
					runs.delete(sanitized.runId);
					hydratedRunIds.delete(sanitized.runId);
				}
				continue;
			}
			if (memoryOwner === "unproven") {
				if (disk) merged.set(sanitized.runId, disk);
				else if (!wasHydrated) merged.set(sanitized.runId, sanitized);
				continue;
			}
			merged.set(sanitized.runId, sanitized);
		}
		const retentionCutoff = Date.now() - DEFAULT_COMPLETED_RUN_RETENTION_MS;
		for (const disk of diskRuns) {
			if (merged.has(disk.runId)) continue;
			const owner = diskOwnerById.get(disk.runId);
			if (opts.completedRunDeletions?.has(disk.runId) && (owner === "local" || owner === "stale")) continue;
			if (owner === "stale" && disk.completedAt === undefined) {
				const staleRun = runtimeRunFromPersisted(disk);
				if (runNeverConstructed(staleRun, Date.now(), constructionDeadlineMs(), runtimeAgentDir)) {
					terminalizeNeverConstructedRun(staleRun);
				} else if (runHasEstablishedLiveWorker(staleRun)) {
					markActiveRunAsOrphaned(staleRun);
				}
				merged.set(disk.runId, sanitizeRunForPersistence(staleRun));
				continue;
			}
			const group = diskRetentionGroups.byRunId.get(disk.runId) ?? new Set([disk.runId]);
			const ownerProtectedGroup = [...group].some((runId) => {
				if (merged.has(runId)) return true;
				const relatedOwner = diskOwnerById.get(runId);
				return relatedOwner === "foreign" || relatedOwner === "unproven";
			});
			if (owner === "local" && !ownerProtectedGroup) continue; // ours-but-trimmed: stays trimmed.
			// Only a wholly eligible, old retry group can be removed. A protected,
			// active, or recent member preserves the complete group.
			if (disk.completedAt !== undefined && disk.completedAt < retentionCutoff && owner === "stale") {
				const ageProtectedGroup = ownerProtectedGroup || [...group].some((runId) => {
					const related = diskById.get(runId);
					return !related || related.completedAt === undefined || related.completedAt >= retentionCutoff;
				});
				if (!ageProtectedGroup) continue;
			}
			merged.set(disk.runId, disk);
		}
		// Fresh disk snapshots can arrive after hydration and their retry fields are
		// untrusted. Normalize and reconcile the complete merged graph before
		// retention or canonical replacement can write those fields back.
		for (const mergedRun of merged.values()) normalizeHydratedForkDefaults(mergedRun);
		reconcileRetryGraph(merged.values());
		// Bound only completed records this process may safely retain or evict.
		// Matching foreign and unproven records are protected outside the local
		// budget; a retry component containing one protected member stays whole.
		const mergedRunsByAge = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
		const mergedActiveRuns = mergedRunsByAge.filter((run) => run.completedAt === undefined);
		const completedCandidates = mergedRunsByAge.filter((run) => run.completedAt !== undefined);
		const retentionGraph = new Map(merged);
		const completedById = new Map(completedCandidates.map((run) => [run.runId, run]));
		const completedOwnerById = new Map(
			completedCandidates.map((run) => [run.runId, runtimeOwnerDisposition(run)]),
		);
		const ownerProtectedRunIds = new Set(
			completedCandidates
				.filter((run) => {
					const owner = completedOwnerById.get(run.runId);
					return owner === "foreign" || owner === "unproven";
				})
				.map((run) => run.runId),
		);
		const retryRetentionGroups = buildRetryRetentionGroups(retentionGraph);
		for (const group of retryRetentionGroups.groups) {
			if (![...group].some((runId) => ownerProtectedRunIds.has(runId))) continue;
			for (const runId of group) ownerProtectedRunIds.add(runId);
		}
		const nonEvictableRunIds = new Set([
			...mergedActiveRuns.map((run) => run.runId),
			...ownerProtectedRunIds,
		]);
		for (const group of retryRetentionGroups.groups) {
			if (![...group].some((runId) => nonEvictableRunIds.has(runId))) continue;
			for (const runId of group) nonEvictableRunIds.add(runId);
		}
		const unresolvedComponents = new Map<string, Set<string>>();
		for (const run of completedCandidates) {
			for (const runIds of unresolvedRetryComponents(run, retentionGraph).values()) {
				const expanded = new Set<string>();
				for (const runId of runIds) {
					for (const groupedRunId of retryRetentionGroups.byRunId.get(runId) ?? [runId]) expanded.add(groupedRunId);
				}
				unresolvedComponents.set([...expanded].sort().join("\u0001"), expanded);
			}
		}
		const ownerProtectedCompleted = completedCandidates.filter((run) => ownerProtectedRunIds.has(run.runId));
		const pinnedRunIds = new Set(
			completedCandidates
				.filter((run) => nonEvictableRunIds.has(run.runId) && !ownerProtectedRunIds.has(run.runId))
				.map((run) => run.runId),
		);
		const componentsByAge = [...unresolvedComponents.values()]
			.filter((runIds) => ![...runIds].some((runId) => nonEvictableRunIds.has(runId)))
			.sort((a, b) => {
				const newest = (runIds: Set<string>) => Math.max(...[...runIds].map((runId) => completedById.get(runId)?.createdAt ?? 0));
				return newest(b) - newest(a);
			});
		for (const componentRunIds of componentsByAge) {
			const completedIds = [...componentRunIds].filter((runId) => completedById.has(runId));
			if (pinnedRunIds.size + completedIds.length > MAX_PERSISTED_RUNS) continue;
			for (const runId of completedIds) pinnedRunIds.add(runId);
		}
		const pinnedCompleted = completedCandidates.filter((run) => pinnedRunIds.has(run.runId));
		// Retry-bearing eligible components that do not fit are evicted as components,
		// never fed through ordinary row-by-row retention.
		const ordinaryCompleted = completedCandidates.filter((run) =>
			!nonEvictableRunIds.has(run.runId) && !pinnedRunIds.has(run.runId) &&
			!Object.values(run.forks).some((fork) =>
				fork.retryOf !== undefined || fork.retriedBy !== undefined || (fork.attempt !== undefined && fork.attempt > 1),
			),
		);
		const ordinaryBudget = Math.max(0, MAX_PERSISTED_RUNS - pinnedCompleted.length);
		const ordinaryKeep = new Set(ordinaryCompleted.slice(-ordinaryBudget).map((run) => run.runId));
		const mergedCompletedRuns = [
			...ownerProtectedCompleted,
			...pinnedCompleted,
			...ordinaryCompleted.filter((run) => ordinaryKeep.has(run.runId)),
		];
		const mergedRuns = [...mergedActiveRuns, ...mergedCompletedRuns]
			.sort((a, b) => a.createdAt - b.createdAt);

		const payload: PersistedRunStateFile = {
			version: CURRENT_STATE_SCHEMA_VERSION,
			writtenAt: Date.now(),
			runs: mergedRuns,
		};
		replaceJsonFile(statePath, payload);
		durableReplacement = true;
		// Only a successful canonical replacement proves pending terminal or
		// revocation transitions durable enough to leave the live producer.
		reconcileDurablyTerminalLocalRegistrations();
		}, opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : undefined);
		return durableReplacement;
	} catch (err) {
		if (err instanceof StateLockTimeoutError) throw err;
		logDelegateDiagnostic(
			`failed to persist runtime state${persistingRunId ? ` runId=${persistingRunId}` : ""}: ${(err as Error).message}`,
			{ agentDir: runtimeAgentDir },
		);
		return false;
	}
}

/**
 * Hydrate durable runtime state. Any run that was active in a previous module
 * instance cannot be safely re-attached to live supervisor/worker sessions, so
 * by default it is surfaced as an aborted orphan instead of disappearing from
 * `delegate_status` / `delegate_result`.
 */
export function hydrateRuntimeState(
	opts: { markActiveAsOrphaned?: boolean } = {},
): number {
	if (!runtimeStatePath) {
		persistenceHydrated = true;
		return 0;
	}
	// Tier 4 (#458) — the hydrate READ is also on the critical bind path. Under
	// shared-lock contention the read lock itself can time out; degrade to binding
	// with no hydrated state (the shared file is untouched and a later persist
	// re-merges it) rather than aborting the extension bind.
	let hydrationRead: RuntimeHydrationRead;
	try {
		hydrationRead = readRuntimeStateForHydration(runtimeStatePath);
	} catch (error) {
		if (!(error instanceof StateLockTimeoutError)) throw error;
		logDelegateDiagnostic(
			`hydrate read timed out acquiring state lock target=${error.target}; ` +
				`binding without hydrated runtime state (#458 degrade path)`,
			{ agentDir: runtimeAgentDir },
		);
		persistenceHydrated = true;
		return 0;
	}
	const { result, preserved } = hydrationRead;
	if (result.kind === "absent") {
		persistenceHydrated = true;
		return 0;
	}
	if (result.kind === "corrupt") {
		logDelegateDiagnostic(
			`failed to read runtime state: ${result.error.message}` +
			(preserved ? `; preserved corrupt file at ${preserved}` : "; corrupt file was not moved"),
			{ agentDir: runtimeAgentDir },
		);
		persistenceHydrated = true;
		return 0;
	}
	const parsed = persistedRunsFromValue(result.value);
	if (!parsed) {
		logDelegateDiagnostic(
			`runtime state has an invalid persisted shape` +
				(preserved ? `; preserved corrupt file at ${preserved}` : "; corrupt file was not moved"),
			{ agentDir: runtimeAgentDir },
		);
		persistenceHydrated = true;
		return 0;
	}
	let persistedRuns = parsed.runs;
	if (parsed.invalidRuns.length > 0) {
		const repaired = repairInvalidPersistedRuns(runtimeStatePath, parsed);
		persistedRuns = repaired.runs;
		logDelegateDiagnostic(
			`runtime state dropped ${parsed.invalidRuns.length} malformed persisted run record(s)` +
				(repaired.preserved ? `; preserved at ${repaired.preserved}` : "; malformed records were not preserved"),
			{ agentDir: runtimeAgentDir },
		);
	}
	let count = 0;
	for (const saved of persistedRuns) {
		if (!saved?.runId || runs.has(saved.runId)) continue;
		const run = runtimeRunFromPersisted(saved);
		// #470 — a completed run persisted after its result was shed to the per-run
		// sidecar carries no inline finalResult. Restore the result (and, from it,
		// each fork's dropped transcript) from the sidecar so `delegate_control
		// result` and the transcript overlay have data. If the sidecar is missing
		// (swept or lost), the run stays completed with an empty result rather than
		// resurrecting a prior generation.
		if (run.completedAt !== undefined && !run.finalResult) {
			if (restoreShedCompletedResultFromSidecar(run)) {
				// Restored verbatim from the sidecar (result + fork transcripts).
			} else {
				logDelegateDiagnostic(
					`hydrate found a completed run with no inline result and no restorable sidecar ` +
						`runId=${run.runId}; result is unavailable`,
					{ agentDir: runtimeAgentDir },
				);
			}
		}
		// A matching foreign generation may still own live closures. A matching
		// current generation has lost this module instance's closures and follows the
		// reload orphan path. Proven stale generations are also terminalized. Partial,
		// legacy, or unreadable identity is unproven and remains untouched.
		if ((opts.markActiveAsOrphaned ?? true) && !run.completedAt) {
			const owner = runtimeOwnerDisposition(run, { changedLocalNonceIsStale: true });
			if (owner === "local" || owner === "stale") {
				// #465/#470 — a completed result may be durable only in the per-run
				// sidecar when the shared flush degraded under lock contention before
				// this reload. Restore it as a real completion BEFORE the orphan/
				// never-constructed classification so a finished run is never mis-
				// reported as aborted.
				if (applyRunResultSidecarToHydratedRun(run)) {
					// Restored as completed; skip the orphan classification.
				} else if (runNeverConstructed(run, Date.now(), constructionDeadlineMs(), runtimeAgentDir)) {
					// Classify a never-constructed ghost before the generic orphan stamp
					// so it retains the distinct `never-constructed` reason.
					terminalizeNeverConstructedRun(run);
				} else {
					markActiveRunAsOrphaned(run);
				}
			}
		}
		runs.set(run.runId, run);
		hydratedRunIds.add(run.runId);
		count++;
	}
	reconcileHydratedRetryGraph();
	persistenceHydrated = true;
	// Re-run the shared reaper after hydration so deadline-expired workerless
	// ghosts and newly proven stale established owners use the same authority.
	// Defer its own persist to the single write below.
	const reaped = reapNeverConstructedRuns({ persist: false });
	if (count > 0 || reaped > 0) {
		// Tier 4 (#458) — the hydrate write-back is on the critical extension-bind
		// path. A transient lock timeout here (a sibling session held the shared
		// run-state.json lock a moment too long) must NOT abort the bind: the read
		// already succeeded and the merged state lives in memory. Try a bounded
		// jittered synchronous retry first (clears the common transient case), and
		// on ultimate timeout degrade — keep the in-memory state, log a bounded
		// diagnostic, and schedule an async backoff retry — instead of letting
		// StateLockTimeoutError propagate out of configureRuntimePersistence into
		// session_start/rebind.
		if (!persistRuntimeStateWithRetry()) {
			logDelegateDiagnostic(
				`hydrate write-back exhausted its bounded lock retries; continuing bind ` +
					`with in-memory state and scheduling an async retry (#458 degrade path)`,
				{ agentDir: runtimeAgentDir },
			);
			schedulePersist();
		}
	}
	// #465/#470 — evict stale run-result sidecars so the directory stays bounded.
	// A sidecar for a runId still present in the hydrated run set is retained (it
	// backs `delegate_control result` for that run); one for an unknown runId
	// older than the completed-run retention window is removed. Best-effort — a
	// sweep failure never blocks the bind.
	if (runtimeAgentDir) {
		try {
			sweepRunResultSidecars(runtimeAgentDir, {
				retainedRunIds: new Set(runs.keys()),
				maxAgeMs: DEFAULT_COMPLETED_RUN_RETENTION_MS,
			});
		} catch {
			/* best-effort sidecar sweep */
		}
	}
	return count;
}

export function isRuntimePersistenceHydrated(): boolean {
	return persistenceHydrated;
}

/** Wire the pi event bus into the runtime. Called from the extension factory. */
export function setEventEmitter(fn: EventEmitter | undefined): void {
	emitter = fn;
}

function emit(channel: string, data: unknown): void {
	if (!emitter) return;
	try {
		emitter(channel, data);
	} catch (err) {
		// Never let a subscriber crash mutate runtime state.
		logDelegateDiagnostic(`event emitter threw for channel ${channel}: ${(err as Error).message}`, { agentDir: runtimeAgentDir });
	}
}

function projectRegisteredRun(state: DelegateDispatchState): DelegateDispatchState {
	const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const entries = state.forks && typeof state.forks === "object" && !Array.isArray(state.forks)
		? Object.fromEntries(Object.entries(state.forks).flatMap(([name, entry]) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
			return [[name, cloneRunLiveState(entry as RunLiveState)]];
		}))
		: {};
	return {
		runId: state.runId,
		...(typeof state.rootRunId === "string" ? { rootRunId: state.rootRunId } : {}),
		...(typeof state.ownerSessionId === "string" ? { ownerSessionId: state.ownerSessionId } : {}),
		...(state.shape === "direct" || state.shape === "supervised" || state.shape === "chain" ? { shape: state.shape } : {}),
		...(typeof state.notifyOnFailure === "boolean" ? { notifyOnFailure: state.notifyOnFailure } : {}),
		createdAt: finite(state.createdAt) ?? Date.now(),
		...(finite(state.completedAt) !== undefined ? { completedAt: finite(state.completedAt) } : {}),
		...(typeof state.detached === "boolean" ? { detached: state.detached } : {}),
		...(finite(state.orphanedAt) !== undefined ? { orphanedAt: finite(state.orphanedAt) } : {}),
		...(finite(state.syncOrphanRecoverySurfacedAt) !== undefined ? { syncOrphanRecoverySurfacedAt: finite(state.syncOrphanRecoverySurfacedAt) } : {}),
		...(finite(state.orphanWakeSurfacedAt) !== undefined ? { orphanWakeSurfacedAt: finite(state.orphanWakeSurfacedAt) } : {}),
		...projectProcessOwnerFields(state),
		forks: entries,
		...(Array.isArray(state.finalResult) ? { finalResult: state.finalResult.map((result) => cloneRunResult(result)) } : {}),
		abort: typeof state.abort === "function" ? state.abort : () => {},
		...(typeof state.steer === "function" ? { steer: state.steer } : {}),
		...(typeof state.cancel === "function" ? { cancel: state.cancel } : {}),
		...(state.recoveryDescriptors instanceof Map ? { recoveryDescriptors: state.recoveryDescriptors } : {}),
	};
}

/**
 * Register using the named-field projection while retaining the caller's run
 * object identity for object-identity revocation.
 */
function applyRegisteredRunProjection(state: DelegateDispatchState): void {
	const projectedState = projectRegisteredRun(state);
	for (const key of Object.keys(state)) {
		if (!(key in projectedState)) delete (state as unknown as Record<string, unknown>)[key];
	}
	Object.assign(state, projectedState);
}

/** Register a new run. Overwrites any prior entry with the same runId. */
export function registerRun(state: DelegateDispatchState): void {
	// Issue #11 — runIds are interpolated into on-disk paths across the
	// substrate (run-state.json keys, route records, pending wakes, event-bus
	// sinks). Every internally-minted id (`deriveRunId`, orchestrate ids)
	// matches SAFE_RUN_ID_RE by construction; enforce the boundary here so a
	// future/external caller can never register a path-traversal id.
	if (!isSafeRunId(state.runId)) {
		throw new Error(
			`registerRun: unsafe runId ${JSON.stringify(state.runId)} — must match /^[\\w-]{1,128}$/`,
		);
	}
	if (state.ownerSessionId !== undefined && !isValidOwnerSessionId(state.ownerSessionId)) {
		throw new Error("registerRun: invalid ownerSessionId");
	}
	const callbackEligible = !hasExplicitOwner(state) || hasLocalRunAuthority(state);
	applyRegisteredRunProjection(state);
	const predecessor = runs.get(state.runId);
	// A same-id predecessor's pending prompts must be settled so stale bodies and
	// resolvers cannot attach to the replacement — but Tier 1 (#459) rolls the
	// registry back to that predecessor if the persist fails, so draining here
	// would destroy the predecessor's prompts on a failed replacement. Defer the
	// drain until the persist has committed (see below).
	const predecessorNeedsDrain = predecessor !== undefined && predecessor !== state;
	// Defensive: ensure every entry has transcript + pendingGuidance arrays so
	// the overlay / message_subagent never have to guard against `undefined`.
	for (const entry of Object.values(state.forks)) {
		if (!entry.transcript) entry.transcript = [];
		if (!entry.pendingGuidance) entry.pendingGuidance = [];
		entry.activityHistory = normalizeActivityHistory(entry.activityHistory);
		if (typeof (entry as Partial<RunLiveState>).interactive !== "boolean") {
			entry.interactive = false;
		}
	}
	if (!state.steer) state.steer = defaultSteerStub as NonNullable<DelegateDispatchState["steer"]>;
	if (!state.cancel) state.cancel = defaultCancelStub as NonNullable<DelegateDispatchState["cancel"]>;
	// Stamp a complete current-process generation when the caller did not provide
	// owner evidence. Explicit foreign or partial legacy evidence remains unchanged.
	stampCurrentOwnerIdentity(state);
	// Tier 1 (#459) — the in-memory registry and disk state move together or
	// not at all. `persistRuntimeStateNow()` can throw StateLockTimeoutError when
	// a sibling holds the run-state lock past the timeout; without this rollback
	// the `runs.set(...)` above survives and a later successful persist flushes a
	// "constructing" ghost run to disk that never terminates. A failed dispatch
	// has no in-flight work to preserve, so revert to the EXACT prior registry
	// state — the entry, its hydration provenance, and (deferred) its prompts —
	// before the error propagates to the caller (CR-REGISTER-ROLLBACK-SIDE-EFFECTS).
	const previousEntry = runs.get(state.runId);
	const wasHydrated = hydratedRunIds.has(state.runId);
	const replacedActiveLocalGeneration =
		predecessorNeedsDrain && locallyRegisteredActiveRunIds.has(state.runId);
	hydratedRunIds.delete(state.runId);
	runs.set(state.runId, state);
	try {
		persistRegistrationOrThrow();
	} catch (error) {
		if (previousEntry === undefined) runs.delete(state.runId);
		else runs.set(state.runId, previousEntry);
		if (wasHydrated) hydratedRunIds.add(state.runId);
		// The predecessor's prompts were intentionally NOT drained, so a rolled-back
		// predecessor keeps them intact.
		throw error;
	}
	if (predecessorNeedsDrain) localCallbackOwners.delete(predecessor);
	admitLocalCallbacks(state, callbackEligible);
	// Persist committed: the successor is now the durable registry entry, so it is
	// safe to expose it through the session-local live producer and settle the
	// replaced predecessor's pending prompts.
	markLocalRegistrationCommitted(
		state,
		predecessorNeedsDrain,
		replacedActiveLocalGeneration,
	);
	if (predecessorNeedsDrain) drainPendingPrompts(state.runId, undefined);
	// A same-id replacement supersedes the predecessor generation, but the
	// predecessor's result sidecar is deliberately NOT deleted here
	// (CR-SIDECAR-STALE-GENERATION, round 2). `persistRuntimeStateNow` swallows an
	// ordinary (non-lock-timeout) publish failure, so reaching this point does not
	// prove the successor durably committed; deleting the sidecar would then
	// destroy the predecessor's only durable result. Correctness comes from the
	// generation-stamp read/hydrate guards instead: a stale-generation sidecar is
	// never read or hydrated, a completing successor overwrites it (same path), and
	// the retention sweep reclaims any orphan. No delete is needed, so none is done.
	emit("delegate:register", { runId: state.runId });
}

export function getRun(runId: string): DelegateDispatchState | undefined {
	return runs.get(runId);
}


/** A retry claim is admitted together with its successor run, before any
 * artifact or worker setup. The predecessor's reverse link and successor's
 * forward link are written as one in-memory transaction and then persisted by
 * the existing state-file lock in registerRun. */
export interface RetryRegistrationClaim {
	readonly successorForkName: string;
	readonly retryOf: RetryOf;
	readonly successor?: RetryOf;
	/** Compatibility field for internal callers; it must equal state.runId. */
	readonly successorRunId?: string;
}

function prepareRunForRegistration(state: DelegateDispatchState): void {
	for (const fork of Object.values(state.forks)) {
		if (!fork.transcript) fork.transcript = [];
		if (!fork.pendingGuidance) fork.pendingGuidance = [];
		fork.activityHistory = normalizeActivityHistory(fork.activityHistory);
		if (typeof fork.interactive !== "boolean") fork.interactive = false;
	}
	if (!state.steer) state.steer = defaultSteerStub as NonNullable<DelegateDispatchState["steer"]>;
	if (!state.cancel) state.cancel = defaultCancelStub as NonNullable<DelegateDispatchState["cancel"]>;
	stampCurrentOwnerIdentity(state);
}

function persistedForkByIdentity(run: PersistedRunState, identity: RetryOf): RunLiveState | undefined {
	if (run.runId !== identity.runId) return undefined;
	let match: RunLiveState | undefined;
	for (const [key, fork] of Object.entries(run.forks ?? {})) {
		const addressName = (fork as RunLiveState & { addressName?: unknown }).addressName;
		if (fork.name === identity.forkName || key === identity.forkName || addressName === identity.forkName) {
			if (match && match !== fork) return undefined;
			match = fork;
		}
	}
	return match;
}

function mergeRetryMetadata(memory: RunLiveState | undefined, disk: RunLiveState | undefined, memoryAuthoritative = false): RunLiveState | undefined {
	if (!memory) {
		if (!disk) return undefined;
		const cloned = { ...disk } as RunLiveState;
		if (cloned.retryOf !== undefined) cloned.retryOf = cloneRetryMetadata(cloned.retryOf) as RetryOf;
		if (cloned.retriedBy !== undefined) cloned.retriedBy = cloneRetryMetadata(cloned.retriedBy) as RetriedBy;
		return cloned;
	}
	if (!disk || memoryAuthoritative) return memory;
	// A fresh locked disk snapshot may complete a stale hydrated predecessor,
	// while a locally owned live predecessor remains authoritative until it
	// reaches a terminal state. This prevents stale durable failure from
	// admitting a retry beside a still-running local worker.
	const merged = { ...memory, ...disk } as RunLiveState;
	if (merged.retryOf !== undefined) merged.retryOf = cloneRetryMetadata(merged.retryOf) as RetryOf;
	if (merged.retriedBy !== undefined) merged.retriedBy = cloneRetryMetadata(merged.retriedBy) as RetriedBy;
	return merged;
}

function mergeCommittedRetryFields(run: DelegateDispatchState, disk: PersistedRunState | undefined): void {
	if (!disk) return;
	for (const [name, fork] of Object.entries(run.forks)) {
		const saved = persistedForkByIdentity(disk, { runId: run.runId, forkName: name });
		if (!saved) continue;
		if (saved.retryOf !== undefined) {
			if (isValidForkIdentity(saved.retryOf)) fork.retryOf = cloneValidForkIdentity(saved.retryOf);
			else { delete fork.retryOf; fork.retryQuarantined = true; }
		}
		if (saved.retriedBy !== undefined) {
			if (isValidForkIdentity(saved.retriedBy)) fork.retriedBy = cloneValidForkIdentity(saved.retriedBy);
			else { delete fork.retriedBy; fork.retryQuarantined = true; }
		}
		if (saved.attempt !== undefined) {
			if (Number.isSafeInteger(saved.attempt) && saved.attempt >= 1 && saved.attempt <= MAX_LINEAGE_DEPTH) fork.attempt = saved.attempt;
			else { delete fork.attempt; fork.retryQuarantined = true; }
		}
		if (saved.retryQuarantined === true) fork.retryQuarantined = true;
	}
}

export function registerRunWithRetryClaims(
	state: DelegateDispatchState,
	claims: readonly RetryRegistrationClaim[] = [],
): void {
	if (claims.length === 0) {
		registerRun(state);
		return;
	}
	if (!isSafeRunId(state.runId)) {
		throw new Error(`retry registration: unsafe runId ${JSON.stringify(state.runId)}`);
	}
	if (state.ownerSessionId !== undefined && !isValidOwnerSessionId(state.ownerSessionId)) {
		throw new Error("registerRun: invalid ownerSessionId");
	}
	if (runs.has(state.runId)) throw new Error("retry registration: successor run already exists");
	for (const claim of claims) {
		if (!isRecordValue(claim)) throw new Error("retry registration rejected: malformed-reference");
		const claimKeys = Object.keys(claim);
		if (claimKeys.some((key) => !["successorForkName", "successor", "retryOf", "successorRunId"].includes(key))) {
			throw new Error("retry registration rejected: malformed-reference");
		}
		if (claim.successorRunId !== undefined && claim.successorRunId !== state.runId) {
			throw new Error("retry registration rejected: successor-run-mismatch");
		}
		if (claim.successor !== undefined && isValidForkIdentity(claim.successor) && claim.successor.runId !== state.runId) {
			throw new Error("retry registration rejected: successor-run-mismatch");
		}
	}
	const callbackEligible = !hasExplicitOwner(state);
	// Apply the same closed projection as ordinary registration before the
	// successor can enter any lookup, registry, persistence, or event path.
	applyRegisteredRunProjection(state);
	prepareRunForRegistration(state);
	const pureClaims = claims.map((claim) => ({
		successorForkName: claim.successorForkName,
		successor: claim.successor === undefined
			? { runId: claim.successorRunId === undefined ? state.runId : claim.successorRunId, forkName: claim.successorForkName }
			: cloneRetryMetadata(claim.successor),
		retryOf: cloneRetryMetadata(claim.retryOf),
	})) as unknown as readonly RetryClaim[];

	const commit = (lookup: (runId: string, forkName: string) => RetryForkRecord | undefined): RetryAdmissionPlan => {
		const admission = validateRetryClaims(lookup, pureClaims);
		if (admission.ok === false) throw new Error(`retry registration rejected: ${admission.error.code}`);
		for (const mutation of admission.plan.mutations) {
			const successor = state.forks[mutation.successor.forkName];
			if (!successor) throw new Error("retry registration: successor fork is missing");
			if (successor.retryOf !== undefined || successor.retriedBy !== undefined || successor.attempt !== undefined) {
				throw new Error("retry registration rejected: already-linked");
			}
		}
		return admission.plan;
	};

	if (!runtimeStatePath) {
		const lookup = (runId: string, forkName: string): RunLiveState | undefined => runs.get(runId)?.forks[forkName];
		const plan = commit(lookup);
		for (const mutation of plan.mutations) {
			const predecessor = runs.get(mutation.predecessor.runId)?.forks[mutation.predecessor.forkName];
			const successor = state.forks[mutation.successor.forkName];
			if (!predecessor || !successor) throw new Error("retry registration: fork disappeared during admission");
			predecessor.retriedBy = cloneValidForkIdentity(mutation.successor);
			successor.retryOf = cloneValidForkIdentity(mutation.predecessor);
			successor.attempt = mutation.attempt;
		}
		runs.set(state.runId, state);
		admitLocalCallbacks(state, callbackEligible);
		markLocalRegistrationCommitted(state);
		emit("delegate:register", { runId: state.runId });
		return;
	}

	const statePath = runtimeStatePath;
	const plan = withStateFileLock(statePath, () => {
		const diskRuns = readPersistedRunsForRetryAdmission(statePath);
		const diskRunIds = new Set<string>();
		for (const run of diskRuns) {
			if (diskRunIds.has(run.runId)) throw new Error("retry registration rejected: duplicate-run-id");
			diskRunIds.add(run.runId);
		}
		const diskById = new Map(diskRuns.map((run) => [run.runId, run]));
		if (diskById.has(state.runId)) throw new Error("retry registration: successor run already exists");
		const lookup = (runId: string, forkName: string): RetryForkRecord | undefined => {
			const memoryRun = runs.get(runId);
			const memory = memoryRun?.forks[forkName];
			const disk = diskById.get(runId);
			const diskFork = disk ? persistedForkByIdentity(disk, { runId, forkName }) : undefined;
			const locallyOwnedLive = memoryRun !== undefined && !hydratedRunIds.has(runId) &&
				hasLocalRunAuthority(memoryRun) && memoryRun.completedAt === undefined &&
				memory !== undefined && isLiveStatus(memory.status);
			return mergeRetryMetadata(memory, diskFork, locallyOwnedLive);
		};
		const admitted = commit(lookup);
		const payloadRuns: PersistedRunState[] = [...diskRuns];
		const stagedSuccessor: DelegateDispatchState = {
			...state,
			forks: Object.fromEntries(Object.entries(state.forks).map(([name, fork]) => [name, { ...fork }])),
		};
		for (const mutation of admitted.mutations) {
			const successor = stagedSuccessor.forks[mutation.successor.forkName];
			if (!successor) throw new Error("retry registration: successor fork disappeared during commit");
			const savedRun = payloadRuns.find((entry) => entry.runId === mutation.predecessor.runId);
			const savedFork = savedRun ? persistedForkByIdentity(savedRun, mutation.predecessor) : undefined;
			if (!savedFork) throw new Error("retry registration: predecessor fork disappeared during commit");
			savedFork.retriedBy = cloneValidForkIdentity(mutation.successor);
			successor.retryOf = cloneValidForkIdentity(mutation.predecessor);
			successor.attempt = mutation.attempt;
		}
		// Only the claimed predecessor records and the new successor are authored
		// by this transaction. Foreign live runs remain byte-for-byte fresh from
		// disk instead of being replaced by stale hydrated memory snapshots.
		const successorPersisted = sanitizeRunForPersistence(stagedSuccessor);
		payloadRuns.push(successorPersisted);
		const protectedRunIds = new Set<string>([
			...payloadRuns.filter((run) => run.completedAt === undefined).map((run) => run.runId),
			state.runId,
			...admitted.mutations.map((mutation) => mutation.predecessor.runId),
		]);
		const boundedPayloadRuns = trimRetryPayloadToBound(payloadRuns, protectedRunIds);
		replaceJsonFile(statePath, { version: CURRENT_STATE_SCHEMA_VERSION, writtenAt: Date.now(), runs: boundedPayloadRuns });
		// replaceJsonFile is the commit point. Do not perform a second read that
		// can turn a successful durable reservation into a reported rejection.
		return admitted;
	});
	for (const mutation of plan.mutations) {
		const predecessor = runs.get(mutation.predecessor.runId)?.forks[mutation.predecessor.forkName];
		const successor = state.forks[mutation.successor.forkName];
		// The predecessor may be a disk-only record admitted from a fresh
		// state-file read (for example, a retry dispatched by a different
		// foreground process).  The durable replacement above is already the
		// commit point; do not turn that successful reservation into a reported
		// failure merely because this process does not own the predecessor's
		// in-memory closures.
		if (predecessor) predecessor.retriedBy = cloneValidForkIdentity(mutation.successor);
		if (!successor) throw new Error("retry registration: successor fork disappeared after commit");
		successor.retryOf = cloneValidForkIdentity(mutation.predecessor);
		successor.attempt = mutation.attempt;
	}
	runs.set(state.runId, state);
	admitLocalCallbacks(state, callbackEligible);
	hydratedRunIds.delete(state.runId);
	markLocalRegistrationCommitted(state);
	emit("delegate:register", { runId: state.runId });
}

/** Legacy-safe effective attempt accessor. */
export function getForkAttempt(fork: Pick<RunLiveState, "attempt"> | undefined): number {
	return effectiveAttempt(fork);
}


/**
 * Remove exactly one still-current registration after an authorization race.
 * Object identity prevents a late revoker from deleting a newer same-id run.
 */
export function revokeRunRegistration(runId: string, expected: DelegateDispatchState): boolean {
	if (runs.get(runId) !== expected) return false;
	runs.delete(runId);
	localCallbackOwners.delete(expected);
	hydratedRunIds.delete(runId);
	drainPendingPrompts(runId, undefined);
	persistRuntimeStateNow();
	emit("delegate:registration-revoked", { runId });
	return true;
}

/**
 * Shallow defensive copy of a `DelegateDispatchState` for the read accessors below.
 * `getRunSnapshot`/`listRunSnapshots` are SNAPSHOTS: a caller (the resolver,
 * or any future consumer) must not be able to mutate runtime internals through
 * them. We copy the top-level record and rebuild the `forks` map with copied
 * entry records, so the runtime stays the single owner of the live `runs`
 * singleton. (Nested objects inside a run entry are read-only in practice;
 * the resolver reads scalar status/timestamp fields only.)
 */
function snapshotRun(run: DelegateDispatchState): DelegateDispatchSnapshot {
	const entries: Record<string, RunLiveState> = {};
	for (const [name, entry] of Object.entries(run.forks)) {
		entries[name] = cloneRunLiveState(entry);
	}
	// Runtime callbacks close over live sessions, task inputs, and provider state.
	// They are authority-bearing internals, not introspection data: never project
	// them into status/result snapshots.
	const {
		abort: _abort,
		cancel: _cancel,
		steer: _steer,
		recoveryDescriptors: _recoveryDescriptors,
		finalResult,
		...snapshot
	} = run;
	return {
		...snapshot,
		forks: entries,
		...(finalResult === undefined ? {} : { finalResult: finalResult.map(cloneRunResult) }),
	};
}

/**
 * Read-only SNAPSHOT accessor for the shape-agnostic run resolver (spec 0008,
 * `src/run-introspect.ts`). Returns a defensive copy of the `DelegateDispatchState` for
 * a runId (NOT the live ref), or undefined when unknown. Distinct from `getRun`
 * so the resolver reads the in-memory map through a NAMED read accessor rather
 * than reaching into module-internal state — the runtime stays the single owner
 * of the `runs` singleton, and the snapshot prevents callers mutating it.
 */
export function getRunSnapshot(runId: string): DelegateDispatchSnapshot | undefined {
	const run = runs.get(runId);
	return run ? snapshotRun(run) : undefined;
}

/**
 * Read-only SNAPSHOT accessor for the resolver's no-runId enumeration (spec
 * 0008 / REQ-INTRO-5): a defensive copy of every in-memory run. Companion to
 * `getRunSnapshot`; see its doc for why these are named separately from
 * `getRun` / `listRuns`.
 */
export function listRunSnapshots(): DelegateDispatchSnapshot[] {
	return [...runs.values()].map(snapshotRun);
}

/**
 * The root-run-id anchoring a run's delegation tree, for event-bus sink
 * keying (spec 0004). Falls back to the `runId` itself when `rootRunId` was
 * not recorded (foreground dispatch, where root === run; or older persisted
 * state). Returns `undefined` only for an unknown run id.
 */
export function rootRunIdForRun(runId: string): string | undefined {
	const run = runs.get(runId);
	if (!run) return undefined;
	return run.rootRunId ?? run.runId;
}

export function listRuns(): DelegateDispatchState[] {
	return [...runs.values()];
}

/**
 * Was this run loaded from the shared state file rather than dispatched by this
 * process? Startup hydration pulls in every session's runs, so "in the registry"
 * does not mean "mine".
 */
export function isHydratedRun(runId: string): boolean {
	return hydratedRunIds.has(runId);
}

/** Runs still in progress (no completedAt timestamp). */
export function listActiveRuns(): DelegateDispatchState[] {
	return [...runs.values()].filter((r) => r.completedAt === undefined);
}

export type SessionLocalActiveWorkStatus = "busy" | "idle" | "unknown";

type LocalRegistrationOwner =
	| { kind: "known"; ownerSessionId: string }
	| { kind: "ambiguous" };

/** Resolve one local registration's owner without scanning durable history. */
function localRegistrationOwner(run: DelegateDispatchState): LocalRegistrationOwner {
	if (run.ownerSessionId !== undefined) {
		return isValidOwnerSessionId(run.ownerSessionId)
			? { kind: "known", ownerSessionId: run.ownerSessionId }
			: { kind: "ambiguous" };
	}
	if (
		!isSafeRunId(run.rootRunId) ||
		overlappingLocalGenerationRunIds.has(run.rootRunId) ||
		replacedLocalRootGenerationRunIds.has(run.rootRunId)
	) {
		return { kind: "ambiguous" };
	}
	// `runs` is keyed by runId, so this is one exact lookup rather than an
	// enumeration of hydrated/history rows. The root must also identify itself;
	// otherwise a malformed child could borrow an unrelated owner's authority.
	const root = runs.get(run.rootRunId);
	if (
		!root ||
		(root.rootRunId !== undefined && root.rootRunId !== root.runId) ||
		!isValidOwnerSessionId(root.ownerSessionId)
	) {
		return { kind: "ambiguous" };
	}
	return { kind: "known", ownerSessionId: root.ownerSessionId };
}

/**
 * Answer from registrations committed by this live runtime only. Hydrated and
 * historical rows are consulted solely as a uniquely addressed root-owner
 * record for an ownerless local child; they are never enumerated as active work.
 */
export function getSessionLocalActiveWorkStatus(
	ownerSessionId: string,
): SessionLocalActiveWorkStatus {
	if (!isValidOwnerSessionId(ownerSessionId)) return "unknown";
	let ambiguous = false;
	for (const runId of locallyRegisteredActiveRunIds) {
		const run = runs.get(runId);
		if (!run) {
			ambiguous = true;
			continue;
		}
		if (overlappingLocalGenerationRunIds.has(runId)) {
			if (run.completedAt === undefined) {
				const currentOwner = localRegistrationOwner(run);
				if (currentOwner.kind === "known" && currentOwner.ownerSessionId === ownerSessionId) {
					return "busy";
				}
			}
			ambiguous = true;
			continue;
		}
		const owner = localRegistrationOwner(run);
		if (owner.kind === "ambiguous") {
			ambiguous = true;
			continue;
		}
		if (owner.ownerSessionId === ownerSessionId) return "busy";
	}
	return ambiguous ? "unknown" : "idle";
}

function hasRecoverableRunOutput(result: RunResult): boolean {
	if (result.status === "completed" || result.status === "paused") return true;
	if (typeof result.collapsedContent === "string" && result.collapsedContent.trim().length > 0) {
		return true;
	}
	// Failed entries often carry the only useful diagnostic in `error`; keep those
	// recoverable. A live entry that is merely shutdown-orphaned is `aborted` with
	// an error but no collapsedContent, and should not produce a noisy "recovered"
	// handoff when no entry output was actually recovered.
	return result.status === "failed" && typeof result.error === "string" && result.error.trim().length > 0;
}

export interface RecoveryProvenanceSummary {
	recovered: true;
	partial: boolean;
	orphanedAt?: number;
	syncOrphanRecoverySurfacedAt?: number;
	totalForks: number;
	recoveredForks: number;
	completedForks: number;
	pausedForks: number;
	failedForks: number;
	abortedForks: number;
	statusCounts: Record<string, number>;
}

export function summarizeRecoveryProvenance(
	run: Pick<
		DelegateDispatchState,
		"orphanedAt" | "syncOrphanRecoverySurfacedAt" | "finalResult" | "forks"
	>,
): RecoveryProvenanceSummary | undefined {
	if (run.orphanedAt === undefined) return undefined;
	const results =
		run.finalResult && run.finalResult.length > 0
			? run.finalResult
			: Object.values(run.forks).map(
					(entry) =>
						({
							name: entry.name,
							agent: entry.agent,
							agentSource: entry.agentSource ?? "builtin",
							task: entry.task ?? "",
							status: terminalStatus(entry.status) ? entry.status : "aborted",
							roundsUsed: entry.currentRound,
							maxRounds: entry.maxRounds,
							collapseMode: entry.collapseMode ?? "final_output",
							collapsedContent: entry.lastSupervisorText ?? entry.lastWorkerText ?? "",
							transcript: entry.transcript ?? [],
							error: entry.error,
							usage: entry.usage ?? {
								supervisorInput: 0,
								supervisorOutput: 0,
								workerInput: 0,
								workerOutput: 0,
								cost: entry.cost ?? 0,
							},
						}) as RunResult,
				);
	const statusCounts: Record<string, number> = {};
	for (const result of results) {
		statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
	}
	const totalForks = results.length;
	const completedForks = statusCounts.completed ?? 0;
	const pausedForks = statusCounts.paused ?? 0;
	const failedForks = statusCounts.failed ?? 0;
	const abortedForks = statusCounts.aborted ?? 0;
	const recoveredForks = results.filter(hasRecoverableRunOutput).length;
	return {
		recovered: true,
		partial: totalForks > 0 && completedForks + pausedForks < totalForks,
		orphanedAt: run.orphanedAt,
		syncOrphanRecoverySurfacedAt: run.syncOrphanRecoverySurfacedAt,
		totalForks,
		recoveredForks,
		completedForks,
		pausedForks,
		failedForks,
		abortedForks,
		statusCounts,
	};
}

/**
 * Immutable identity of one exact recovery record as observed immediately before
 * delivery. The durable marker accepts only objects minted by this module instance;
 * a run id, session string, or freshly re-read replacement is never sufficient.
 */
export type RecoveryDeliveryKind = "sync-orphan-recovery" | "orphaned-dispatch-wake";

export interface RecoveryDeliveryObservation {
	readonly kind: RecoveryDeliveryKind;
	readonly runId: string;
	readonly ownerSessionId: string;
	readonly deliveredRun: DelegateDispatchState;
	readonly deliveryFingerprint: string;
	readonly durableRecordFingerprint: string;
}

type RecoveryAcknowledgementField =
	| "syncOrphanRecoverySurfacedAt"
	| "orphanWakeSurfacedAt";

interface RecoveryDurableRecord {
	readonly state: Record<string, unknown>;
	readonly rawRuns: unknown[];
	readonly rawIndex: number;
	readonly saved: PersistedRunState;
}

function recoveryAcknowledgementField(kind: RecoveryDeliveryKind): RecoveryAcknowledgementField {
	return kind === "sync-orphan-recovery"
		? "syncOrphanRecoverySurfacedAt"
		: "orphanWakeSurfacedAt";
}

function isSupportedRecoveryShape(shape: unknown): shape is InProcessRunShape {
	return shape === "direct" || shape === "supervised" || shape === "chain";
}

function isRecoveryDeliveryCandidate(
	run: DelegateDispatchState,
	kind: RecoveryDeliveryKind,
	ownerSessionId: string,
	allowAcknowledged = false,
): boolean {
	if (!isValidOwnerSessionId(run.ownerSessionId) || run.ownerSessionId !== ownerSessionId) return false;
	if (!Number.isFinite(run.createdAt)) return false;
	if (!Number.isFinite(run.orphanedAt) || !Number.isFinite(run.completedAt)) return false;
	if (kind === "orphaned-dispatch-wake" && !isSupportedRecoveryShape(run.shape)) return false;
	// A top-level completion timestamp cannot authorize delivery while any real
	// fork is still live. The empty map is a valid terminal shape: background
	// delivery must still report that the run ended with an exact empty payload.
	if (!Object.values(run.forks).every((fork) => terminalStatus(fork.status))) return false;
	// `[]` is a real recorded payload. `undefined` means the shared row shed the
	// payload to a sidecar that has not been restored, so delivery must retry.
	if (!Array.isArray(run.finalResult)) return false;
	const acknowledgement = run[recoveryAcknowledgementField(kind)];
	if (!allowAcknowledged && acknowledgement !== undefined) return false;
	if (acknowledgement !== undefined && !Number.isFinite(acknowledgement)) return false;
	if (kind === "sync-orphan-recovery") {
		return run.detached === false &&
			run.finalResult.length > 0 &&
			run.finalResult.some(hasRecoverableRunOutput);
	}
	return run.detached === true;
}

function cloneRecoveryDeliveryRun(run: DelegateDispatchState): DelegateDispatchState {
	const cloned = projectRegisteredRun(run);
	cloned.abort = () => {};
	delete cloned.cancel;
	delete cloned.steer;
	delete cloned.recoveryDescriptors;
	return cloned;
}

function freezeRecoveryObservationValue(value: unknown, seen = new WeakSet<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	for (const nested of Object.values(value as Record<string, unknown>)) {
		freezeRecoveryObservationValue(nested, seen);
	}
	Object.freeze(value);
}

/**
 * Canonical delivery identity. Unlike the shared-state persistence projection,
 * this always retains the terminal payload even when the row normally sheds it
 * to the generation-bound result sidecar.
 */
function recoveryDeliveryFingerprint(run: DelegateDispatchState): string {
	const projected = sanitizeRunForPersistence({ ...run, resultSidecarDurable: false });
	delete projected.syncOrphanRecoverySurfacedAt;
	delete projected.orphanWakeSurfacedAt;
	return JSON.stringify(projected);
}

function durableRecoveryRecordFingerprint(
	record: PersistedRunState,
	acknowledgementField: RecoveryAcknowledgementField,
): string {
	const projected: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== acknowledgementField) projected[key] = value;
	}
	return JSON.stringify(projected);
}

function readRecoveryDurableRecord(
	statePath: string,
	runId: string,
): RecoveryDurableRecord | undefined {
	const result = readJsonFile(statePath);
	if (result.kind !== "ok" || !isRecordValue(result.value) || !Array.isArray(result.value.runs)) {
		return undefined;
	}
	const parsed = persistedRunsFromValue(result.value);
	if (!parsed || parsed.invalidRuns.length > 0 || parsed.fileVersion !== CURRENT_STATE_SCHEMA_VERSION) {
		return undefined;
	}
	const savedMatches = parsed.runs.filter((candidate) => candidate.runId === runId);
	if (savedMatches.length !== 1) return undefined;
	const rawMatches = result.value.runs
		.map((candidate, index) => ({ candidate, index }))
		.filter(({ candidate }) => isRecordValue(candidate) && candidate.runId === runId);
	if (rawMatches.length !== 1) return undefined;
	return {
		state: result.value,
		rawRuns: result.value.runs,
		rawIndex: rawMatches[0]!.index,
		saved: savedMatches[0]!,
	};
}

function restoreRecoveryDeliveryPayload(run: DelegateDispatchState): boolean {
	if (Array.isArray(run.finalResult)) return true;
	return run.completedAt !== undefined && restoreShedCompletedResultFromSidecar(run);
}

function recoveryComparisonRun(saved: PersistedRunState): DelegateDispatchState | undefined {
	const current = runtimeRunFromPersisted(saved);
	return restoreRecoveryDeliveryPayload(current) ? current : undefined;
}

/** Capture the exact sync-recovery record that the caller is about to deliver. */
export function captureSyncOrphanRecoveryDelivery(
	run: DelegateDispatchState,
): RecoveryDeliveryObservation | undefined {
	return captureRecoveryDeliveryObservation(run, "sync-orphan-recovery");
}

/** Capture the exact background orphan-wake record that the caller is about to deliver. */
export function captureOrphanedDispatchWakeDelivery(
	run: DelegateDispatchState,
): RecoveryDeliveryObservation | undefined {
	return captureRecoveryDeliveryObservation(run, "orphaned-dispatch-wake");
}

function captureRecoveryDeliveryObservation(
	run: DelegateDispatchState,
	kind: RecoveryDeliveryKind,
): RecoveryDeliveryObservation | undefined {
	const statePath = runtimeStatePath;
	const ownerSessionId = run.ownerSessionId;
	if (!statePath || runs.get(run.runId) !== run || !ownerSessionId) return undefined;
	if (!restoreRecoveryDeliveryPayload(run) || !isRecoveryDeliveryCandidate(run, kind, ownerSessionId)) {
		return undefined;
	}
	try {
		return withStateFileLock(statePath, () => {
			const durable = readRecoveryDurableRecord(statePath, run.runId);
			if (!durable) return undefined;
			const current = recoveryComparisonRun(durable.saved);
			if (!current || !isRecoveryDeliveryCandidate(current, kind, ownerSessionId)) return undefined;
			const deliveryFingerprint = recoveryDeliveryFingerprint(run);
			if (recoveryDeliveryFingerprint(current) !== deliveryFingerprint) return undefined;
			const deliveredRun = cloneRecoveryDeliveryRun(run);
			freezeRecoveryObservationValue(deliveredRun);
			const observation: RecoveryDeliveryObservation = {
				kind,
				runId: run.runId,
				ownerSessionId,
				deliveredRun,
				deliveryFingerprint,
				durableRecordFingerprint: durableRecoveryRecordFingerprint(
					durable.saved,
					recoveryAcknowledgementField(kind),
				),
			};
			freezeRecoveryObservationValue(observation);
			recoveryDeliveryObservations.add(observation);
			return observation;
		});
	} catch (error) {
		logDelegateDiagnostic(
			`recovery delivery observation failed runId=${run.runId}: ${(error as Error).message}`,
			{ agentDir: runtimeAgentDir, level: "warn" },
		);
		return undefined;
	}
}

/**
 * GitLab #34 — sync orphan handoff candidates. These are foreground sync-mode
 * in-process runs (`detached === false`) that were terminalized as orphans
 * after their owner runtime died, have recoverable entry output in `finalResult`,
 * and have not yet been surfaced to their originating foreground session.
 *
 * `currentSessionId` is a read-scope filter only. Durable acknowledgement uses
 * the independently registered live wake-sink session identity.
 */
export function listPendingSyncOrphanRecoveries(currentSessionId?: string): DelegateDispatchState[] {
	if (!currentSessionId) return [];
	return [...runs.values()].filter((run) =>
		restoreRecoveryDeliveryPayload(run) &&
		isRecoveryDeliveryCandidate(run, "sync-orphan-recovery", currentSessionId),
	);
}

/**
 * Hydrate-orphaned background dispatches (`sync:false`, in-process shape)
 * whose owning session has not yet received their terminal wake. Every real fork
 * must be terminal and the shape must be `direct`, `supervised`, or `chain`. An
 * exact `[]` payload still qualifies: the owner must learn the run died. A shed
 * payload does not qualify until its generation-bound sidecar can be restored.
 */
export function listPendingOrphanedDispatchWakes(currentSessionId?: string): DelegateDispatchState[] {
	if (!currentSessionId) return [];
	return [...runs.values()].filter((run) =>
		restoreRecoveryDeliveryPayload(run) &&
		isRecoveryDeliveryCandidate(run, "orphaned-dispatch-wake", currentSessionId),
	);
}

function markRecoveryDeliverySurfaced(
	observation: RecoveryDeliveryObservation,
	sink: NotifyCompletionSink,
	kind: RecoveryDeliveryKind,
	now: number,
): boolean {
	if (!recoveryDeliveryObservations.has(observation) || observation.kind !== kind) return false;
	const statePath = runtimeStatePath;
	if (!Number.isFinite(now) || !statePath) return false;
	if (getLiveWakeSink() !== sink || getLiveWakeSinkOwnerSessionId() !== observation.ownerSessionId) {
		return false;
	}
	const acknowledgementField = recoveryAcknowledgementField(kind);
	let durableSuccess = false;
	try {
		withStateFileLock(statePath, () => {
			const durable = readRecoveryDurableRecord(statePath, observation.runId);
			if (!durable) return;
			if (
				durableRecoveryRecordFingerprint(durable.saved, acknowledgementField) !==
				observation.durableRecordFingerprint
			) return;
			const current = recoveryComparisonRun(durable.saved);
			if (!current || !isRecoveryDeliveryCandidate(current, kind, observation.ownerSessionId, true)) return;
			if (recoveryDeliveryFingerprint(current) !== observation.deliveryFingerprint) return;
			if (durable.saved[acknowledgementField] !== undefined) return;
			const rawRecord = durable.rawRuns[durable.rawIndex];
			if (!isRecordValue(rawRecord)) return;
			const nextRuns = durable.rawRuns.slice();
			nextRuns[durable.rawIndex] = { ...rawRecord, [acknowledgementField]: now };
			replaceJsonFile(statePath, { ...durable.state, runs: nextRuns });
			durableSuccess = true;
		});
	} catch (error) {
		logDelegateDiagnostic(
			`recovery acknowledgement failed runId=${observation.runId}: ${(error as Error).message}`,
			{ agentDir: runtimeAgentDir, level: "warn" },
		);
		return false;
	}
	if (!durableSuccess) return false;
	const inMemory = runs.get(observation.runId);
	if (
		inMemory &&
		inMemory.ownerSessionId === observation.ownerSessionId &&
		recoveryDeliveryFingerprint(inMemory) === observation.deliveryFingerprint
	) {
		inMemory[acknowledgementField] = now;
	}
	if (kind === "sync-orphan-recovery") {
		emit("delegate:sync-orphan-recovery-surfaced", { runId: observation.runId, surfacedAt: now });
	}
	return true;
}

/**
 * Acknowledge one exact sync recovery after its message was sent. This capability
 * patches only the durable timestamp; it grants no run-control or merge authority.
 */
export function markSyncOrphanRecoverySurfaced(
	observation: RecoveryDeliveryObservation,
	sink: NotifyCompletionSink,
	now = Date.now(),
): boolean {
	return markRecoveryDeliverySurfaced(observation, sink, "sync-orphan-recovery", now);
}

/** Acknowledge one exact background orphan wake after its message was sent. */
export function markOrphanedDispatchWakeSurfaced(
	observation: RecoveryDeliveryObservation,
	sink: NotifyCompletionSink,
	now = Date.now(),
): boolean {
	return markRecoveryDeliverySurfaced(observation, sink, "orphaned-dispatch-wake", now);
}

/**
 * Issue #14 — age-based retention for COMPLETED runs (the known MR !2
 * follow-up: the durable registry previously accumulated completed runs
 * forever, bounded only by the MAX_PERSISTED_RUNS count cap at persist
 * time).
 *
 * Removes completed runs whose `completedAt` is older than `maxAgeMs`
 * (default 7 days) from the in-memory registry, then persists ONCE so the
 * removal reaches run-state.json.
 *
 * OWNER SCOPING: matching foreign and unproven owner generations are preserved.
 * Only matching local and proven-stale generations are eligible for removal, and
 * retry components remain indivisible when any member is protected.
 *
 * Returns the number of runs removed. Safe to call from session_start and
 * from the periodic maintenance sweep (idempotent; persists only when
 * something was removed).
 */
export function sweepOldCompletedRuns(opts: { maxAgeMs?: number; now?: number } = {}): number {
	const maxAgeMs = opts.maxAgeMs ?? DEFAULT_COMPLETED_RUN_RETENTION_MS;
	const now = opts.now ?? Date.now();
	const cutoff = now - maxAgeMs;
	let removed = 0;
	const allRuns = [...runs.values()];
	const ownerByRunId = new Map(allRuns.map((run) => [run.runId, runtimeOwnerDisposition(run)]));
	const graph = new Map(allRuns.map((run) => [run.runId, run]));
	const retentionGroups = buildRetryRetentionGroups(graph);
	const toRemove = new Set<string>();
	for (const group of retentionGroups.groups) {
		const componentRuns = [...group]
			.map((runId) => runs.get(runId))
			.filter((run): run is DelegateDispatchState => run !== undefined);
		if (componentRuns.some((run) => {
			const owner = ownerByRunId.get(run.runId);
			return run.completedAt === undefined || run.completedAt >= cutoff ||
				hasUnresolvedRetryFrontier(run, allRuns) || owner === "foreign" || owner === "unproven";
		})) continue;
		for (const run of componentRuns) toRemove.add(run.runId);
	}
	for (const id of toRemove) if (runs.delete(id)) removed++;
	if (removed > 0) persistRuntimeStateNow({ completedRunDeletions: toRemove });
	return removed;
}

/** Default completed-run retention window for `sweepOldCompletedRuns` (7 days). */
export const DEFAULT_COMPLETED_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Owner-scoping predicate for SESSION-SCOPED display/control surfaces (the
 * status widget, `delegate_status`'s all-runs in-memory leg, and in-process
 * steer/cancel). The shared on-disk registry is hydrated by every pi session on
 * the machine; active runs owned by a DIFFERENT live process may appear in this
 * registry, but this process must not render/control them as its own.
 *
 * Display classification accepts either a current local registration or a record with
 * the current PID and matching reload-stable process nonce. Linux birth/boot evidence
 * classifies foreign or stale process generations. This is NOT callback authority:
 * control, recovery, and provider-call consumers must use hasLocalRunAuthority instead.
 */
export function isOwnedByThisProcess(run: DelegateDispatchState | DelegateDispatchSnapshot): boolean {
	return hasLocalRunAuthority(run) || runtimeOwnerDisposition(run) === "local";
}

/**
 * Patch a single entry's live state. Missing runs/entries are no-ops so callers
 * never have to guard against race conditions with teardown.
 */
type RunUsage = RunResult["usage"];

function usageNumber(value: unknown): number {
	const number = Number(value ?? 0);
	return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function hasTickerUsage(usage: Partial<RunUsage> | undefined): boolean {
	return Boolean(
		usage && Object.keys(usage).some((key) =>
			isTickerUsageCounterKey(key) && (usage as Record<string, unknown>)[key] !== undefined,
		),
	);
}

function suppliedUsageCounter(
	raw: unknown,
	key: string,
	normalized: ReturnType<typeof normalizeUsageCounters>,
): number | undefined {
	if (!isRecordValue(raw) || !Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
	return normalized.usage[key as keyof typeof normalized.usage];
}

/** Merge only valid, own counters while retaining independently recorded ticker usage. */
function mergeLiveUsage(existing: RunUsage | undefined, incoming: RunUsage, raw: unknown): RunUsage {
	const normalized = normalizeUsageCounters(raw);
	const next: RunUsage = existing ? { ...existing } : projectRunUsage({})!;
	const previousWorkerCost = Math.max(
		0,
		usageNumber(existing?.cost) - usageNumber(existing?.tickerCost),
	);

	// `incoming` is already the closed RunResult usage projection. Its keys are
	// the accepted runtime counters; `normalized` tells us which of those keys
	// were actually supplied as valid own properties by the caller.
	for (const key of Object.keys(incoming)) {
		if (key === "diagnostics") continue;
		const value = suppliedUsageCounter(raw, key, normalized);
		if (value !== undefined) (next as Record<string, unknown>)[key] = value;
	}

	const cost = suppliedUsageCounter(raw, "cost", normalized);
	const tickerCost = suppliedUsageCounter(raw, "tickerCost", normalized);
	const tickerCostWasSupplied = tickerCost !== undefined;
	if (cost !== undefined) {
		// Worker snapshots omit tickerCost and report worker-only cost. Only a valid
		// numeric tickerCost marks an aggregate projection; own undefined is omission.
		const includedTickerCost = tickerCost ?? usageNumber(next.tickerCost);
		next.cost = tickerCostWasSupplied
			? saturatingAdd(Math.max(0, cost - includedTickerCost), usageNumber(next.tickerCost))
			: saturatingAdd(cost, usageNumber(next.tickerCost));
	} else if (tickerCost !== undefined) {
		next.cost = saturatingAdd(previousWorkerCost, usageNumber(next.tickerCost));
	}

	const diagnostics = diagnosticsWithGenerated(existing?.diagnostics, incoming.diagnostics);
	if (diagnostics.length > 0) next.diagnostics = diagnostics;
	else delete next.diagnostics;
	return next;
}

/**
 * Record a display-only status without touching the agent transcript or the
 * generic delegate:update channel. Consecutive equal visible text is ignored.
 */
export function recordActivityStatus(
	runId: string,
	forkName: string,
	entry: Partial<ActivityStatusEntry>,
): ActivityStatusEntry | undefined {
	const run = runs.get(runId);
	if (!run) return undefined;
	const liveEntry = run.forks[forkName];
	if (!liveEntry) return undefined;
	const history = liveEntry.activityHistory ?? [];
	const nextHistory = appendActivityStatus(history, entry);
	const normalized = nextHistory.at(-1);
	if (!normalized || normalized === history.at(-1)) return undefined;
	liveEntry.activityHistory = nextHistory;
	schedulePersist();
	// Do not expose the canonical history object to event consumers or callers;
	// a subscriber mutating its payload must not rewrite durable runtime state.
	emit("delegate:activity-status", { runId, forkName, activityStatus: { ...normalized } });
	return { ...normalized };
}

/** Explicit undefined clears used by production live-update callers. */
const LIVE_PATCH_EXPLICIT_CLEAR_KEYS = new Set<keyof RunLiveState>(["completedResult", "workerSessionFile"]);

const RUN_LIVE_STATE_KEYS = [
	"name", "displayLabel", "agent", "agentSource", "task", "collapseMode", "workerCwd", "workerBranch",
	"requestedModel", "resolvedModel", "skills", "confineWrites", "readOnly", "cloneMode", "status",
	"currentRound", "maxRounds", "lastWorkerText", "lastSupervisorText", "workerSessionFile", "error",
	"errorKind", "failureCause", "refusalModels", "startedAt", "endedAt", "heartbeatIntervalMs", "maxConsecutiveHeartbeats",
	"windDown", "lastActivityAt", "taskProgress", "transcript", "activityHistory", "pendingGuidance",
	"cancelReason", "startedAtMs", "timeoutDeadlineAtMs", "timeoutPolicy", "cost", "usage", "completedResult",
	"interactive",
] as const satisfies readonly (keyof RunLiveState)[];

export function projectRunLivePatch(patch: Partial<RunLiveState>, workerCwd?: string): Partial<RunLiveState> {
	const projected: Partial<RunLiveState> = {};
	const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
	for (const key of RUN_LIVE_STATE_KEYS) {
		if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
		const value = patch[key];
		let next: unknown;
		switch (key) {
			case "status":
				next = isRunLiveStatusValue(value) ? value : undefined;
				break;
			case "agentSource":
				next = isAgentSourceValue(value) ? value : undefined;
				break;
			case "collapseMode":
				next = value === "final_output" || value === "summary" ? value : undefined;
				break;
			case "errorKind":
				next = isWorkerErrorKind(value) ? value : undefined;
				break;
			case "failureCause":
				next = isWorkerFailureCause(value) ? value : undefined;
				break;
			case "cancelReason":
				next = isCancelReasonValue(value) ? value : undefined;
				break;
			case "skills":
			case "refusalModels":
			case "pendingGuidance":
				next = strings(value);
				break;
			case "transcript": {
				if (!isTranscriptArray(value)) {
					next = undefined;
					break;
				}
				const entries = value.map(projectTranscriptEntry);
				next = entries.every((entry): entry is TranscriptEntry => entry !== undefined) ? entries : undefined;
				break;
			}
			case "activityHistory": {
				if (!isStrictActivityHistory(value)) {
					next = undefined;
					break;
				}
				const entries = value.map((entry) => normalizeActivityStatusEntry(entry));
				next = entries.every((entry): entry is ActivityStatusEntry => entry !== undefined)
					? normalizeActivityHistory(entries)
					: undefined;
				break;
			}
			case "taskProgress":
				next = isStrictTaskProgress(value) ? projectTaskProgressFields(value) : undefined;
				break;
			case "usage":
				next = isStrictLiveUsage(value) ? projectRunUsage(value) : undefined;
				break;
			case "completedResult":
				next = value === undefined
					? undefined
					: isStructurallyValidRunResultPatch(value) ? projectRunResult(value) : undefined;
				break;
			case "windDown": {
				const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
				next = candidate && finite(candidate.atMs) !== undefined &&
					(candidate.reason === "heartbeat" || candidate.reason === "wall-clock" || candidate.reason === "unknown")
					? { atMs: finite(candidate.atMs)!, reason: candidate.reason }
					: undefined;
				break;
			}
			case "timeoutPolicy": {
				const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
				next = isStrictTimeoutPolicy(candidate)
					? {
						maxDurationMs: candidate.maxDurationMs as number,
						windDownGraceMs: candidate.windDownGraceMs as number,
						globalMaxDurationMs: candidate.globalMaxDurationMs as number,
						...(typeof candidate.enforceWallClockBudget === "boolean"
							? { enforceWallClockBudget: candidate.enforceWallClockBudget }
							: {}),
					}
					: undefined;
				break;
			}
			case "name":
			case "displayLabel":
			case "agent":
			case "task":
			case "workerCwd":
			case "workerBranch":
			case "requestedModel":
			case "resolvedModel":
			case "cloneMode":
			case "lastWorkerText":
			case "lastSupervisorText":
			case "workerSessionFile":
			case "error":
				next = typeof value === "string" ? value : undefined;
				break;
			case "confineWrites":
			case "readOnly":
			case "interactive":
				next = typeof value === "boolean" ? value : undefined;
				break;
			default:
				next = finite(value);
				break;
		}
		// Only these production-defined fields may clear a canonical value with
		// explicit undefined. Every other invalid or undefined patch is ignored so
		// it cannot erase a previously valid field.
		const explicitClear = value === undefined && LIVE_PATCH_EXPLICIT_CLEAR_KEYS.has(key);
		if (next === undefined && !explicitClear) continue;
		(projected as Record<string, unknown>)[key] = next;
	}
	if (typeof workerCwd === "string") projected.workerCwd = workerCwd;
	return projected;
}

function applyRunLivePatch(existing: RunLiveState, patch: Partial<RunLiveState>): RunLiveState {
	// Preserve unchanged nested identities so transcript/activity projection
	// caches do not rescan when a sibling live field changes.
	return {
		...existing,
		...projectRunLivePatch(patch),
	};
}

export function updateRunState(
	runId: string,
	forkName: string,
	patch: Partial<RunLiveState>,
): void {
	const run = runs.get(runId);
	if (!run) return;
	const existing = run.forks[forkName];
	if (!existing) return;
	const projectedPatch = projectRunLivePatch(patch);
	const usagePatchAccepted = Object.prototype.hasOwnProperty.call(patch, "usage") && isStrictLiveUsage(patch.usage);
	const next = applyRunLivePatch(existing, projectedPatch);
	const incomingUsage = usagePatchAccepted
		? projectRunUsage(patch.usage)
		: undefined;
	// Timeout policy/deadline are resolved before dispatch and are immutable for
	// the lifetime of an entry. Activity patches must never move the absolute
	// deadline or replace the policy that produced it.
	if (existing.timeoutDeadlineAtMs !== undefined) {
		next.timeoutDeadlineAtMs = existing.timeoutDeadlineAtMs;
	}
	if (existing.timeoutPolicy !== undefined) {
		next.timeoutPolicy = existing.timeoutPolicy;
	}
	if (existing.windDown !== undefined) {
		next.windDown = existing.windDown;
	}
	// Retry lineage is durable write-once metadata. Generic live updates and
	// stale workers must not remove or replace an admitted relationship.
	if (existing.retryOf !== undefined) next.retryOf = existing.retryOf;
	else delete next.retryOf;
	if (existing.retriedBy !== undefined) next.retriedBy = existing.retriedBy;
	else delete next.retriedBy;
	if (existing.attempt !== undefined) next.attempt = existing.attempt;
	else delete next.attempt;
	if (existing.retryQuarantined === true) next.retryQuarantined = true;
	else delete next.retryQuarantined;
	if (usagePatchAccepted) {
		if (incomingUsage === undefined) {
			// Invalid usage cannot clear or enrich canonical state. In particular,
			// never hand the hostile patch to mergeLiveUsage, whose result is emitted
			// and persisted below.
			next.usage = existing.usage;
			next.cost = existing.cost;
		} else {
			next.usage = mergeLiveUsage(existing.usage, incomingUsage, patch.usage);
			next.cost = next.usage.cost;
		}
	}
	// Stamp started/ended timestamps based on status transitions.
	if (projectedPatch.status === "running" && existing.status !== "running" && next.startedAt === undefined) {
		next.startedAt = Date.now();
	}
	if (
		// Spec 0019 / REQ-PAUSE-1 — `"paused"` is a terminal transition (forced
		// finish), so it stamps `endedAt` like the other terminal statuses;
		// otherwise a paused entry would render with an ever-growing elapsed clock.
		(projectedPatch.status === "completed" ||
			projectedPatch.status === "failed" ||
			projectedPatch.status === "aborted" ||
			projectedPatch.status === "paused") &&
		next.endedAt === undefined
	) {
		next.endedAt = Date.now();
	}
	run.forks[forkName] = next;
	schedulePersist();
	emit("delegate:update", { runId, forkName, forkState: cloneRunLiveState(next) });
	if (projectedPatch.status !== undefined && projectedPatch.status !== existing.status) {
		const lifecycle = projectLifecycleActivity(projectedPatch.status);
		if (lifecycle) recordActivityStatus(runId, forkName, lifecycle);
	}
}

/** @deprecated Use {@link updateRunState}; retained for compatibility. */
export const updateForkState = updateRunState;

/**
 * Reserve one provider call while the run/entry is live and locally owned.
 * Callers must reserve before issuing the request, then settle the returned
 * token through `recordTickerUsage`, even when the request fails or has no
 * usage payload. A missing reservation means no provider call may start.
 */
export function reserveTickerUsage(
	runId: string,
	forkName: string,
): TickerUsageReservation | undefined {
	const run = runs.get(runId);
	if (!run || run.completedAt !== undefined || !hasLocalRunAuthority(run)) return undefined;
	const liveEntry = run.forks[forkName];
	if (!liveEntry || terminalStatus(liveEntry.status)) return undefined;

	const reservation: TickerUsageReservation = Object.freeze({
		requestId: ++tickerUsageRequestIdSeq,
		runId,
		forkName,
	});
	pendingTickerUsageReservations.set(reservation.requestId, { reservation, run });
	return reservation;
}

function hasNonZeroTickerUsage(delta: TickerUsageDelta | undefined): delta is TickerUsageDelta {
	return Boolean(
		delta &&
			(usageNumber(delta.input) > 0 ||
				usageNumber(delta.output) > 0 ||
				usageNumber(delta.cacheRead) > 0 ||
				usageNumber(delta.cacheWrite) > 0 ||
				usageNumber(delta.cost) > 0),
	);
}

function appendCompletedTickerUsageRevision(run: DelegateDispatchState): void {
	if (!run.finalResult) return;
	const sink = getLiveWakeSink();
	if (!sink?.appendEntry) return;
	const sinkOwnerSessionId = getLiveWakeSinkOwnerSessionId();
	if (run.ownerSessionId && sinkOwnerSessionId !== run.ownerSessionId) return;
	const metadata = buildDelegateUsageMetadata(run.runId, run.finalResult);
	try {
		sink.appendEntry(metadata.customType, metadata);
	} catch (err) {
		logDelegateDiagnostic(
			`failed to append late ticker usage metadata (runId=${run.runId}): ` +
				`${(err as Error)?.message ?? err}`,
			{ agentDir: runtimeAgentDir, level: "warn" },
		);
	}
}

/**
 * Settle one ticker request and record any provider-reported usage exactly once.
 *
 * Usage acceptance and headline acceptance are deliberately separate. A valid
 * reservation proves the provider call started while the entry was live, so a
 * late response still contributes its incurred usage after terminalization.
 * `headlineAccepted` nevertheless becomes false once lifecycle truth is
 * terminal, preventing stale prose from replacing it. A completed run receives
 * an updated final result plus a durable metadata revision; rollups select the
 * latest revision for that run.
 */
export function recordTickerUsage(
	reservation: TickerUsageReservation,
	delta?: TickerUsageDelta,
): TickerUsageDisposition {
	const pending = pendingTickerUsageReservations.get(reservation.requestId);
	if (!pending || pending.reservation !== reservation) {
		return { usageRecorded: false, headlineAccepted: false };
	}
	// Consume before mutating so re-entrant or repeated settlement is harmless.
	pendingTickerUsageReservations.delete(reservation.requestId);

	const run = runs.get(reservation.runId);
	if (run !== pending.run || !hasLocalRunAuthority(run)) {
		return { usageRecorded: false, headlineAccepted: false };
	}
	const liveEntry = run.forks[reservation.forkName];
	if (!liveEntry) return { usageRecorded: false, headlineAccepted: false };
	const headlineAccepted = run.completedAt === undefined && !terminalStatus(liveEntry.status);
	if (!hasNonZeroTickerUsage(delta)) return { usageRecorded: false, headlineAccepted };

	const current: RunUsage = liveEntry.usage
		? { ...liveEntry.usage }
		: {
				supervisorInput: 0,
				supervisorOutput: 0,
				workerInput: 0,
				workerOutput: 0,
				cost: liveEntry.cost ?? 0,
			};
	const tickerCost = usageNumber(delta.cost);
	const next: RunUsage = {
		...current,
		tickerInput: saturatingAdd(usageNumber(current.tickerInput), usageNumber(delta.input)),
		tickerOutput: saturatingAdd(usageNumber(current.tickerOutput), usageNumber(delta.output)),
		tickerCacheRead: saturatingAdd(usageNumber(current.tickerCacheRead), usageNumber(delta.cacheRead)),
		tickerCacheWrite: saturatingAdd(usageNumber(current.tickerCacheWrite), usageNumber(delta.cacheWrite)),
		tickerCost: saturatingAdd(usageNumber(current.tickerCost), tickerCost),
		cost: saturatingAdd(usageNumber(current.cost), tickerCost),
	};
	liveEntry.usage = next;
	liveEntry.cost = next.cost;

	let finalResultUpdated = false;
	if (run.finalResult) {
		const result = run.finalResult.find((candidate) => candidate.name === reservation.forkName);
		if (result) {
			mergeTickerUsageIntoFinalResult(liveEntry, result);
			finalResultUpdated = true;
		}
		persistRuntimeStateNow();
	} else {
		schedulePersist();
	}
	emit("delegate:update", {
		runId: reservation.runId,
		forkName: reservation.forkName,
		forkState: cloneRunLiveState(liveEntry),
	});
	if (finalResultUpdated) appendCompletedTickerUsageRevision(run);
	return { usageRecorded: true, headlineAccepted };
}

/**
 * Persist an individual entry's terminal result immediately.
 *
 * `completeRun()` remains the canonical whole-run completion path, but sync
 * mode has a vulnerable window where an entry has already collapsed and returned
 * to `pumpRuns()` while the foreground tool call has not yet written the
 * run-level `finalResult`. Synchronously writing this per-entry snapshot closes
 * that crash window: hydrate can synthesize a recoverable orphan from these
 * snapshots if the parent runtime dies mid join/collapse/result collection.
 */
export function recordRunCompletedResult(
	runId: string,
	forkName: string,
	result: RunResult,
): void {
	const run = runs.get(runId);
	if (!run) return;
	const existing = run.forks[forkName];
	if (!existing) return;
	const now = Date.now();
	const projectedResult = cloneRunResult(result);
	const next: RunLiveState = {
		...existing,
		attempt: existing.attempt ?? projectedResult.attempt ?? 1,
		status: projectedResult.status,
		currentRound: projectedResult.roundsUsed,
		maxRounds: projectedResult.maxRounds,
		collapseMode: projectedResult.collapseMode,
		workerSessionFile: projectedResult.workerSessionFile ?? existing.workerSessionFile,
		workerCwd: projectedResult.workerCwd ?? existing.workerCwd,
		error: projectedResult.error,
		cancelReason: projectedResult.status === "aborted" ? projectedResult.cancelReason : existing.cancelReason,
		usage: projectedResult.usage ? { ...projectedResult.usage } : existing.usage,
		cost: projectedResult.usage?.cost ?? existing.cost,
		endedAt: existing.endedAt ?? now,
		completedResult: projectedResult,
	};
	if (projectedResult.transcript && projectedResult.transcript.length > 0) {
		next.transcript = [...projectedResult.transcript];
	}
	run.forks[forkName] = next;
	const lifecycle = projectLifecycleActivity(projectedResult.status);
	if (lifecycle) recordActivityStatus(runId, forkName, lifecycle);
	persistTerminalSnapshotCoalesced();
	emit("delegate:update", { runId, forkName, forkState: cloneRunLiveState(next) });
}

/** @deprecated Use {@link recordRunCompletedResult}; retained for compatibility. */
export const recordForkCompletedResult = recordRunCompletedResult;

/**
 * Append a single transcript entry to an entry's incremental transcript.
 * No-op if the run/entry is missing (race with teardown) so callers do not
 * have to guard.
 *
 * Emits `delegate:transcript-append` with `{ runId, forkName, entry }`.
 * The overlay and actor-aware status widget listen on this channel.
 */
export function appendTranscriptEntry(
	runId: string,
	forkName: string,
	entry: TranscriptEntry,
): void {
	const run = runs.get(runId);
	if (!run) return;
	const liveEntry = run.forks[forkName];
	if (!liveEntry) return;
	const projectedEntry = projectTranscriptEntry(entry);
	if (!projectedEntry) return;
	if (!liveEntry.transcript) liveEntry.transcript = [];
	// Stamp the stored entry with arrival time if the producer didn't set one.
	// Keep the event payload's historical shape stable: callers that supplied a
	// legacy entry without a timestamp must not observe runtime-owned mutation.
	const eventEntry = { ...projectedEntry };
	if (projectedEntry.timestamp === undefined) projectedEntry.timestamp = Date.now();
	liveEntry.transcript.push(projectedEntry);
	schedulePersist();
	emit("delegate:transcript-append", { runId, forkName, entry: eventEntry });
}

/**
 * Phase 3a.2 — push a user-guidance message onto an entry's queue. The
 * `message_subagent` clone-tool drains and prepends these as a
 * `<user-guidance>` block on its next invocation.
 */
export function pushPendingGuidance(runId: string, forkName: string, text: string): void {
	if (typeof text !== "string") return;
	const run = runs.get(runId);
	if (!run) return;
	const liveEntry = run.forks[forkName];
	if (!liveEntry) return;
	if (!liveEntry.pendingGuidance) liveEntry.pendingGuidance = [];
	liveEntry.pendingGuidance.push(text);
	liveEntry.lastActivityAt = Date.now();
	schedulePersist();
	emit("delegate:guidance-queued", { runId, forkName, count: liveEntry.pendingGuidance.length });
}

/**
 * Drain and return every queued guidance message for an entry. Clears the
 * queue in-place. Safe to call when the entry/run is gone (returns `[]`).
 */
export function drainPendingGuidance(runId: string, forkName: string): string[] {
	const run = runs.get(runId);
	if (!run) return [];
	const liveEntry = run.forks[forkName];
	if (!liveEntry) return [];
	const drained = liveEntry.pendingGuidance ?? [];
	liveEntry.pendingGuidance = [];
	schedulePersist();
	if (drained.length > 0) {
		emit("delegate:guidance-drained", { runId, forkName, count: drained.length });
	}
	return drained;
}

/**
 * Phase 3c — register a blocking worker-UI prompt routed to the overlay.
 * Returns `{ id, promise }`; the overlay resolves the promise via
 * `resolvePendingPrompt`. The promise always resolves — never rejects —
 * so the worker can treat the absent/denied case uniformly.
 */
export function addPendingPrompt(
	runId: string,
	forkName: string,
	spec: {
		kind: PendingPromptKind;
		title: string;
		description?: string;
		options?: string[];
		/** Default answer if the prompt is drained on cancel/completion. */
		defaultValue: unknown;
		/**
		 * Optional auto-deny timeout in ms. The UI context arms this; the
		 * runtime just records `expiresAt` for display. The caller's Promise
		 * resolves via `resolvePendingPrompt()` from whichever side wins.
		 */
		timeoutMs?: number;
	},
	admission?: PendingPromptAdmission,
): { id: string; promise: Promise<unknown> } {
	const id = `p_${++pendingPromptIdSeq}`;
	if (admission && !admission()) {
		// A predecessor UI context can outlive a same-id run replacement. Fail
		// closed without publishing a transient prompt against the successor.
		return { id, promise: Promise.resolve(spec.defaultValue) };
	}
	const key = promptKey(runId, forkName);
	const createdAt = Date.now();
	const expiresAt = spec.timeoutMs && spec.timeoutMs > 0 ? createdAt + spec.timeoutMs : undefined;

	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((res) => {
		resolve = res;
	});

	const entry: PendingPrompt = {
		id,
		kind: spec.kind,
		title: spec.title,
		description: spec.description,
		options: spec.options,
		createdAt,
		expiresAt,
		resolve,
	};

	const list = pendingPromptsByEntry.get(key);
	let count: number;
	if (list) {
		list.push(entry);
		count = list.length;
	} else {
		pendingPromptsByEntry.set(key, [entry]);
		count = 1;
	}

	emit("delegate:prompt-pending", {
		runId,
		forkName,
		id,
		kind: spec.kind,
		count,
	});

	return { id, promise };
}

/** Capture exact live run/entry ownership for a routed worker UI context. */
export function capturePendingPromptAdmission(
	runId: string,
	forkName: string,
): PendingPromptAdmission {
	const owner = runs.get(runId);
	return () =>
		owner !== undefined &&
		runs.get(runId) === owner &&
		owner.completedAt === undefined &&
		isLiveStatus(owner.forks[forkName]?.status);
}

/** Read-only snapshot of pending prompts for an entry. Safe when the run is gone. */
export function getPendingPrompts(runId: string, forkName: string): readonly PendingPrompt[] {
	return pendingPromptsByEntry.get(promptKey(runId, forkName)) ?? [];
}

/** Payload-free prompt facts for status/activity renderers. */
export function getPendingPromptActivity(
	runId: string,
	forkName: string,
): { count: number; first?: { kind: PendingPromptKind; createdAt: number } } {
	const prompts = pendingPromptsByEntry.get(promptKey(runId, forkName)) ?? [];
	const first = prompts[0];
	return {
		count: prompts.length,
		...(first ? { first: { kind: first.kind, createdAt: first.createdAt } } : {}),
	};
}

/**
 * Resolve a pending prompt by id. Returns true on success, false if the id
 * isn't found (e.g. timed out and already drained). Emits
 * `delegate:prompt-resolved` for the overlay.
 */
export function resolvePendingPrompt(
	runId: string,
	forkName: string,
	id: string,
	answer: unknown,
): boolean {
	const key = promptKey(runId, forkName);
	const list = pendingPromptsByEntry.get(key);
	if (!list) return false;
	const idx = list.findIndex((p) => p.id === id);
	if (idx === -1) return false;
	const [entry] = list.splice(idx, 1);
	if (list.length === 0) pendingPromptsByEntry.delete(key);
	try {
		entry.resolve(answer);
	} catch {
		/* resolver contract: must not throw. */
	}
	emit("delegate:prompt-resolved", {
		runId,
		forkName,
		id,
		kind: entry.kind,
		count: list.length,
	});
	return true;
}

/**
 * Drain every pending prompt for a given entry (or all entries in a run when
 * `forkName` is omitted) and resolve each with its default value. Called
 * on entry cancel / completion so the worker's awaiting UI calls settle.
 */
export function drainPendingPrompts(
	runId: string,
	forkName: string | undefined,
	defaultsByKind: Record<PendingPromptKind, unknown> = {
		confirm: false,
		select: undefined,
		input: undefined,
	},
): void {
	const prefix = `${runId}:`;
	const targets: Array<{ key: string; forkName: string }> = forkName
		? [{ key: promptKey(runId, forkName), forkName }]
		: [...pendingPromptsByEntry.keys()]
			.filter((key) => key.startsWith(prefix))
			.map((key) => ({ key, forkName: key.slice(prefix.length) }));
	for (const { key, forkName: targetForkName } of targets) {
		const list = pendingPromptsByEntry.get(key);
		if (!list) continue;
		pendingPromptsByEntry.delete(key);
		for (const entry of list) {
			const answer = defaultsByKind[entry.kind];
			try {
				entry.resolve(answer);
			} catch {
				/* ignore */
			}
			emit("delegate:prompt-resolved", {
				runId,
				forkName: targetForkName,
				id: entry.id,
				kind: entry.kind,
				count: 0,
				drained: true,
			});
		}
	}
}

function mergeTickerUsageIntoFinalResult(live: RunLiveState | undefined, result: RunResult): void {
	const liveUsage = live?.usage;
	if (!hasTickerUsage(liveUsage)) return;

	const priorTickerCost = usageNumber(result.usage.tickerCost);
	const merged: RunUsage = { ...result.usage };
	for (const key of Object.keys(liveUsage ?? {})) {
		if (!isTickerUsageCounterKey(key)) continue;
		const value = (liveUsage as Record<string, unknown>)[key];
		if (value !== undefined) (merged as Record<string, unknown>)[key] = usageNumber(value);
	}
	const tickerCost = usageNumber(merged.tickerCost);
	// completeRun can be invoked more than once in defensive teardown paths.
	// Remove any already-merged ticker cost before applying the authoritative
	// live counter so repeated completion remains exact-once.
	merged.cost = saturatingAdd(Math.max(0, usageNumber(result.usage.cost) - priorTickerCost), tickerCost);
	result.usage = merged;
}


/**
 * #465/#470 — build a self-contained completed-result envelope and write it to
 * the run's own per-run sidecar (its own lock), so the result is durable off the
 * shared run-state.json lock. The envelope carries `createdAt` as a generation
 * stamp so a reused runId cannot alias a prior generation's result
 * (CR-SIDECAR-STALE-GENERATION). Returns true only when a durable write landed;
 * the caller uses that to decide whether the shared-flush timeout may be
 * suppressed (CR-SIDECAR-DURABILITY-GAP).
 */
function writeCompletedRunResultSidecar(run: DelegateDispatchState): boolean {
	if (!runtimeAgentDir || run.completedAt === undefined || !run.finalResult) return false;
	const envelope: RunResultSidecarEnvelope = {
		schema: "pi-delegate.run-result-sidecar",
		version: 1,
		runId: run.runId,
		rootRunId: run.rootRunId,
		shape: run.shape,
		ownerSessionId: isValidOwnerSessionId(run.ownerSessionId) ? run.ownerSessionId : undefined,
		createdAt: run.createdAt,
		completedAt: run.completedAt,
		orphanedAt: run.orphanedAt,
		finalResult: run.finalResult
			.slice(-MAX_PERSISTED_ARRAY_ITEMS)
			.map((result) => sanitizeRunResultForPersistence(result)),
	};
	return writeRunResultSidecar(runtimeAgentDir, envelope);
}

/**
 * Mark a run as finished with the final per-entry results.
 * Returns true only for the call that won the terminal transition so callers
 * can gate one-shot side effects such as the aggregate completion wake.
 */
export function completeRun(runId: string, finalResult: RunResult[]): boolean {
	const run = runs.get(runId);
	if (!run || run.completedAt !== undefined) return false;
	const storedResults = finalResult.map((result) => cloneRunResult(result));
	for (const result of storedResults) {
		mergeTickerUsageIntoFinalResult(run.forks[result.name], result);
	}
	run.finalResult = storedResults;
	run.completedAt = Date.now();
	// #465/#470 — persist the completed result to its own per-run sidecar BEFORE
	// the shared run-state flush. The sidecar has its own lock, so a completed
	// run's result is durable even when the shared run-state.json lock is
	// contended past its 5000ms timeout. Without this, a `StateLockTimeoutError`
	// from the flush below discarded the result and skipped the drain/emit,
	// leaving a finished run reported as `failed: ... (no output)`.
	const sidecarWritten = writeCompletedRunResultSidecar(run);
	// #470 — once the result is durable in its own sidecar, the shared run-state
	// row may omit the heavy inline `finalResult` (transcripts dominate the file
	// and therefore the lock-hold time). Record that here; `sanitizeRunForPersistence`
	// reads it to shed the payload while keeping the metadata row.
	run.resultSidecarDurable = sidecarWritten;
	// The shared flush is best-effort for the RESULT *only when the sidecar is
	// already durable*. If the sidecar write also failed, neither target holds
	// the result, so a shared-flush lock timeout must NOT be suppressed — that
	// would report a completion (drain + emit) whose output is lost on reload
	// (CR-SIDECAR-DURABILITY-GAP). Rethrow in that case; otherwise degrade and arm
	// the async run-state retry. Any non-timeout error always propagates.
	try {
		flushRuntimePersistence();
	} catch (error) {
		if (!(error instanceof StateLockTimeoutError)) throw error;
		if (!sidecarWritten) {
			logDelegateDiagnostic(
				`completeRun could not durably persist runId=${runId}: shared-state flush timed out AND the ` +
					`result sidecar write failed; preserving the timeout rather than reporting a lost completion`,
				{ agentDir: runtimeAgentDir },
			);
			throw error;
		}
		logDelegateDiagnostic(
			`completeRun shared-state flush timed out runId=${runId}; result is durable in its sidecar, ` +
				`arming async run-state retry: ${error.message}`,
			{ agentDir: runtimeAgentDir },
		);
		persistPending = true;
		armPersistTimer("retry", nextPersistRetryDelayMs);
		nextPersistRetryDelayMs = Math.min(PERSIST_RETRY_MAX_MS, nextPersistRetryDelayMs * 2);
	}
	// No sidecar deletion happens here. A completed run's result is surfaced only
	// through the generation-bound hydrate restore (and the live in-memory entry),
	// never through a generation-unbound sidecar read, so a stale predecessor
	// sidecar cannot resurrect a prior generation's result and needs no cleanup on
	// this path (the age-based hydrate sweep reclaims any orphan). Deleting here
	// was itself a cross-process, generation-blind data-loss race
	// (CR-SIDECAR-DELETE-GENERATION-RACE), so it is intentionally absent.
	// A durable sidecar is enough to leave the live inventory even when the shared
	// state write failed. Overlapping generations remain an explicit doubt because
	// the overwritten predecessor is no longer addressable by runId.
	if (sidecarWritten && !overlappingLocalGenerationRunIds.has(runId)) {
		locallyRegisteredActiveRunIds.delete(runId);
	}
	// Drain any prompts still blocking the worker — all entries in the run.
	drainPendingPrompts(runId, undefined);
	emit("luthen.delegate.complete", { runId, finalResult: storedResults.map((result) => projectRunResult(result)) });
	return true;
}

function entryStatusCountDiagnosticSummary(run: DelegateDispatchState): string {
	const counts = new Map<string, number>();
	for (const entry of Object.values(run.forks)) {
		counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${status}:${count}`)
		.join(",");
}

function shutdownRunDiagnostic(run: DelegateDispatchState, reason: SessionShutdownReason | undefined): string {
	const ageMs = Math.max(0, Date.now() - run.createdAt);
	return [
		`shutdown aborting runId=${run.runId}`,
		`reason=${reason ?? "unknown"}`,
		`ownerSessionId=${run.ownerSessionId ?? "unknown"}`,
		`owningPid=${run.owningPid ?? "unknown"}`,
		`currentPid=${process.pid}`,
		`detached=${run.detached ?? "unknown"}`,
		`ageMs=${ageMs}`,
		`entryStatuses=${entryStatusCountDiagnosticSummary(run) || "none"}`,
	].join(" ");
}

/**
 * Fire cancel on every live run with `reason: "shutdown"` (so `RunResult`s
 * carry the right `cancelReason`), then fall through to `run.abort()` as a
 * belt-and-suspenders dispatchAbort kick. Called on session_shutdown.
 *
 * Fire-and-forget: the returned promises are detached so session shutdown
 * doesn't block on pi's teardown ordering. The ps-tree sweep inside
 * `cancelOneFork` still runs in the background and reaps stray descendants.
 *
 * Session shutdown terminalizes this process' active in-process delegate runs.
 * The `reason` is the pi SDK `SessionShutdownEvent['reason']`, but every reason
 * is terminal for this runtime registry: reload/new/resume/fork replace the
 * extension module and invalidate the live supervisor/worker closures just as
 * surely as quit does. Persist an aborted snapshot synchronously so a later
 * `delegate_status` / `delegate_result` reports a truthful terminal orphan
 * instead of a zombie `running` entry.
 *
 * Matching foreign and unproven owner records are skipped. Their live closures
 * may still exist, or the evidence may be too weak to reclaim safely.
 */
export function abortAllRuns(reason?: SessionShutdownReason): void {
	// Flush any pending debounced persist BEFORE iterating runs. Belt-and-
	// suspenders: most active runs hit persistRuntimeStateNow() inside the
	// loop below, but if all runs are already terminal and a debounced
	// transcript append is still pending, this guarantees it lands on disk
	// before the process exits.
	flushRuntimePersistence();
	// Issue #11 — persist ONCE after the loop instead of once per run: each
	// persistRuntimeStateNow() is a synchronous read-merge-rewrite of the whole
	// run-state file, so per-run persistence was quadratic on shutdown with N
	// active runs. The single post-loop persist is still synchronous within
	// this call, so the "terminal snapshot lands before module teardown"
	// guarantee is unchanged.
	let needsPersist = false;
	for (const run of runs.values()) {
		// Skip already-terminal runs. They show up here because hydrateRuntimeState
		// loads completed runs from disk so `delegate_status` can introspect them
		// after a reload — but those entries have only the default `cancel` /
		// `abort` stubs (registerRun was never called this session). Cancelling a
		// finished run is also semantically wrong: status is already
		// completed/failed/aborted. Without this guard every session teardown
		// fires a noisy `cancel(...) ... DelegateDispatchState.cancel not wired` warning
		// for every persisted run.
		if (run.completedAt !== undefined) continue;
		// Only the matching local generation and proven-stale owners can be safely
		// reconciled here. Matching foreign and unproven records remain untouched.
		const owner = runtimeOwnerDisposition(run);
		const callbackAuthority = hasLocalRunAuthority(run);
		if (!callbackAuthority && (owner === "foreign" || owner === "unproven")) continue;
		logDelegateDiagnostic(shutdownRunDiagnostic(run, reason), { agentDir: runtimeAgentDir, level: "log" });
		// Kick the live cancellation closures BEFORE stamping the durable orphan
		// snapshot. The production whole-run cancel path enumerates live entries from
		// the current in-memory statuses; if we marked every entry aborted first, the
		// real clone/worker aborts would be skipped and descendants could leak.
		try {
			// Hydrated/raw test runs may carry only the defensive default stub; do not
			// call it during shutdown. The orphan snapshot below is sufficient for
			// state truthfulness, and production live runs wire a real cancel closure.
			if (callbackAuthority && run.cancel && run.cancel !== defaultCancelStub) {
				void run.cancel(undefined, "shutdown").catch((err) => {
					logDelegateDiagnostic(
						`cancel("shutdown") for runId=${run.runId} threw: ${(err as Error).message}`,
						{ agentDir: runtimeAgentDir },
					);
				});
			}
		} catch (err) {
			logDelegateDiagnostic(
				`cancel("shutdown") for runId=${run.runId} threw: ${(err as Error).message}`,
				{ agentDir: runtimeAgentDir },
			);
		}
		try {
			if (callbackAuthority) run.abort();
		} catch (err) {
			logDelegateDiagnostic(
				`abort() for runId=${run.runId} threw: ${(err as Error).message}`,
				{ agentDir: runtimeAgentDir },
			);
		}
		// Persist a terminal snapshot synchronously before the extension/session
		// lifecycle can tear down this module. The async cancel path above may still
		// produce richer RunResult data, but this prevents dispatched runs from
		// vanishing from delegate_status after a reload.
		markActiveRunAsOrphaned(run);
		needsPersist = true;
	}
	if (needsPersist) persistRuntimeStateNow();
}

/**
 * Test-only helper. Clears the module singleton so tests start from a known
 * blank state. Do NOT call from production code paths.
 */
export function __resetRuntimeForTests(): void {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
	}
	persistTimerIsTerminalCoalesce = false;
	persistPending = false;
	nextPersistRetryDelayMs = PERSIST_RETRY_INITIAL_MS;
	persistInvocationCount = 0;
	lastPersistPathReapAt = 0;
	runs.clear();
	localCallbackOwners = new WeakMap();
	locallyRegisteredActiveRunIds.clear();
	overlappingLocalGenerationRunIds.clear();
	replacedLocalRootGenerationRunIds.clear();
	pendingTickerUsageReservations.clear();
	tickerUsageRequestIdSeq = 0;
	hydratedRunIds.clear();
	pendingPromptsByEntry.clear();
	pendingPromptIdSeq = 0;
	emitter = undefined;
	runtimeStatePath = undefined;
	runtimeAgentDir = undefined;
	persistenceHydrated = false;
	recoveryDeliveryObservations = new WeakSet<object>();
	runtimeProcessIdentityDependencies = undefined;
}
