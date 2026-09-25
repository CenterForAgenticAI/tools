/**
 * Per-subagent orchestrator. For one subagent, this:
 *   1. Creates a persistent WORKER AgentSession (file-backed, real tools).
 *   2. Creates an in-memory CLONE AgentSession (fork-clone), seeded from the
 *      main session's messages, with only two tools: message_subagent and
 *      finish_delegation.
 *   3. Starts the clone. The clone drives the conversation:
 *        - message_subagent(text)    → forwards to worker.prompt(text), returns
 *                                      worker's final assistant text as the
 *                                      tool result.
 *        - finish_delegation(payload) → stashes payload, aborts the clone.
 *   4. Enforces max_rounds by forcibly aborting the clone if exceeded.
 *   5. Collapses the transcript into a single string (final_output direct, or
 *      a supervisor summary optionally refined by an explicitly selected model).
 */

import {
	type AgentSession,
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	type ExtensionUIContext,
	type EventBusController,
	type ModelRegistry,
	SessionManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
type DefaultResourceLoaderOptions = NonNullable<
	ConstructorParameters<typeof DefaultResourceLoader>[0]
>;

import { Type } from "@sinclair/typebox";
import type { AgentConfig, AgentSource, CollapseMode } from "./agents.js";
import {
	createActorActivityPublisher,
	createAgentActivityProjector,
	type ActorActivityPublisher,
} from "./actor-activity.js";
import type { ResolvedRunTimeoutPolicy } from "./fork-timeout.js";
import type { WorktreeDiff } from "./worktree.js";
import {
	PARENT_TRANSCRIPT_SEARCH_TOOL_NAME,
	registerParentTranscriptSnapshot,
} from "./parent-transcript-search.js";
import { appendFocusToPrompt } from "./focus-seam.js";
import { TASK_PROGRESS_FIELD, appendTasksToPrompt, buildTaskLedger, readSeededTasks, taskProgressFieldsFromEntries, type TaskLedger, type TaskProgressFields, type TasksSeed } from "./task-seam.js";
import {
	applyWorkerSeeds,
	formatWorkerSeedAudit,
	formatStrippedClaimantWarning,
	isWorkerSeedPromptFallback,
	claimedSessionToolNames,
	usableToolNamesFromScope,
} from "./worker-session-seeds.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { withDelegateOwnedExtensionBind } from "./delegate-session-scope.js";
import { disposeWorkerSession } from "./worker-session-lifecycle.js";
import { createIsolatedWorkerSettingsManager } from "./worker-settings.js";
import { nestedDelegatePolicyForAgent, type NestedDelegateCallerPolicy } from "./nested-delegate-policy.js";
import {
	resolveDelegateOnlyDepth,
	resolveDelegateOnlySteeringSurface,
} from "./delegate-only/fork-policy.js";
import { shouldRequestShorterResult } from "./delegate-only/result-caps.js";
import { getActiveDelegateOnlyMode } from "./delegate-only/runtime-state.js";
import { pickCheapestAvailable } from "./cost.js";
import {
	describeModelScope,
	findModel,
	hasSameModelRouteAlternative,
	hasWorkerModelAlternatives,
	planWorkerModelRequests,
	shouldAdvanceLadderForRouteFailure,
	WorkerModelCursor,
	workerModelFailureMessage,
	type ModelScope,
	type WorkerModelChoice,
	type WorkerModelPlan,
} from "./model-selection.js";
import {
	AUTO_TEXT_COMPLETION_MODEL_REF,
	resolveTextCompletionModel,
} from "./model-completion.js";
import { type CancelReason, type RunLiveState, updateRunState } from "./runtime.js";
import { buildSeedMessages, type CloneMode, type DirectFirstTurnExchange } from "./seed.js";
import { DEFAULT_TASK_DELIVERY_MODE, type TaskDeliveryMode } from "./delegate-runs.js";
import {
	DepthGuardError,
	currentLineageEnv,
	currentLineageEnvKeyNames,
	runWithDepth,
} from "./depth-guard.js";
import type { DepthFrame } from "./depth-guard.js";
import { LINEAGE_ENV, lineageAncestorPath, lineagePath } from "./lineage.js";
import {
	appendBusEvent,
	readDescendantActivity,
	resolveBusFrame,
	type BusEventKind,
} from "./event-bus.js";
import {
	assertValidExtensionToolSelectors,
	isOptionalGlobalExtensionSelector,
	type ArtifactWriterRequirement,
	type ResolvedToolSurface,
	resolveRunToolSurface,
	resolveWorkerToolSurface,
	amendClaimedSessionTools,
} from "./tool-surface.js";
import {
	invalidateFailedWorkerRuntime,
	loadWorkerResourceLoader,
} from "./extension-policy.js";
import type { ResolvedBridge } from "./intercom-bridge.js";
import {
	assertWorkerToolSurfaceUsable,
	prepareWorkerToolScope,
	type PreparedWorkerToolScope,
} from "./worker-tool-scope.js";
import {
	createWorkerThinkingPolicyContext,
	THINKING_LEVELS,
	type ThinkingLevel,
	type WorkerThinkingPolicyContext,
} from "./thinking-policy.js";
import {
	assertReadOnlyValue,
	createWriteConfinementExtension,
	resolveWorkerWriteAuthority,
	workerWriteScopeInstruction,
	type WriteConfinementPolicy,
} from "./write-confinement.js";
import { boundHistoryErrorMessage, recordPreflightFailure, recordRun, type RunHistoryEntry } from "./run-history.js";
import { continueCapacityRequest, inspectCapacityContinuation } from "./capacity-continuation.js";
import { StateLockTimeoutError } from "./state-io.js";
import { boundRunTimeoutTranscript, buildRunTimeoutCollapse } from "./fork-activity.js";
import { projectRunResult } from "./run-result-boundary.js";
import {
	PROMPT_REPAIR_ACTIVITY_CHANNEL,
	buildPromptRepairDelegateSeed,
	mergePromptRepairRecords,
	parsePromptRepairActivity,
	promptRepairFallbackPromptFromEntries,
	promptRepairTranscriptEntries,
	readPromptRepairRecords,
	shouldPreservePromptRepairActivity,
	type PromptRepairRecord,
} from "./prompt-repair-seam.js";
import {
	diagnosticsWithGenerated,
	normalizeUsageCounters,
	saturatingAdd,
	type UsageNormalizationDiagnostic,
} from "./usage-rollup.js";
import {
	CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE,
	createCredentialRetryBudget,
	credentialRetryRemainingMs,
	classifyWorkerFailureCause,
	formatNoModelAlternative,
	isCapacityFailureMessage,
	isCredentialStoreLockErrorMessage,
	isRefreshableRouteAuthFailureMessage,
	isRouteAuthFailureMessage,
	isTransientWorkerErrorMessage,
	sanitizedProviderId,
	sanitizedRouteAuthFailureMessage,
	waitForCredentialStoreLockRetry,
	type CredentialRetryBudget,
	type WorkerErrorKind,
	type WorkerFailureCause,
	type WorkerRetryKind,
} from "./refusal.js";
import {
	acquireWorkerScratchCleanupLease,
	prepareWorkerScratchDir,
} from "./output-file.js";
import { captureMutationSnapshot, mutationReportFor } from "./mutation-tracking.js";
import {
	isNonSummaryRefusal,
	messagesToTranscript,
	summarizeTranscript,
	type TranscriptEntry,
} from "./summarize.js";
import {
	formatRecoveredWorkerOutput,
	withSupervisorReport,
	getLastAssistantText,
	promptWhenIdle,
	WorkerChannel,
	type WorkerChannelClock,
	type HeartbeatTailEntry,
	type WorkerCallResult,
	type WorkerInspectSnapshot,
} from "./worker-channel.js";
import { childModelSessionOptions, providerAuthReader, type ModelRuntimeLike } from "./sdk-model-runtime.js";
import {
	classifyHarvestOutcome,
	getLastAssistantMessageText,
	type HarvestOutcome,
} from "./harvest-outcome.js";
import type { EffectiveEscalationPolicy } from "./escalation-policy.js";
import type { EnvOverrides } from "./env-overrides.js";
import { mergeEnvOverrides, withEnvOverrides } from "./env-overrides.js";
import type { ResolvedEscalationConfig } from "./config.js";
import {
	appendEscalationSupervisorGuidance,
	buildSupervisedEscalationParticipants,
	buildSupervisorEscalationHolderId,
	escalationWorkerInstructions,
	makeEscalationRaiseTools,
	makeSupervisorEscalationTools,
} from "./escalation-tools.js";
import { listMailbox } from "./escalation-store.js";
import {
	ASK_TOOL_NAME,
	makeWorkerAskRoutingTool,
	reconcileWorkerAskSurface,
	replaceLoadedAskTools,
} from "./worker-ask-routing.js";

// `AgentMessage` isn't re-exported from the top level of pi-coding-agent.
type AgentMessage = any;

function sanitizeForkCredentialMessage(message: AgentMessage, providerId?: string): AgentMessage {
	if (message?.role !== "assistant" || typeof message.errorMessage !== "string") return message;
	const error = message.errorMessage;
	if (!isCredentialStoreLockErrorMessage(error) && !isRouteAuthFailureMessage(error)) return message;
	return {
		...message,
		content: [],
		errorMessage: isCredentialStoreLockErrorMessage(error)
			? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
			: sanitizedRouteAuthFailureMessage(providerId),
	};
}

export interface ForkRequest {
	name: string; // addressing key for this fork instance (unique within a parallel batch)
	/** Effective retry attempt, stamped by runtime admission. */
	attempt?: number;
	/** Exact predecessor reference retained in trusted runtime state. */
	retryOf?: { runId: string; forkName: string };
	/**
	 * Derived, NON-ADDRESSING label shown to humans (issues #151/#152). Absent
	 * on hand-built requests, where surfaces fall back to `name`.
	 */
	displayLabel?: string;
	agent: AgentConfig;
	/** Immutable model plan resolved at the dispatch boundary. */
	modelPlan?: WorkerModelPlan;
	task: string;
	cloneMode: CloneMode;
	/** Supervised first-turn delivery mode; omission uses the direct-first-turn default. */
	taskDelivery?: TaskDeliveryMode;
	snippetLastN?: number;
	/**
	 * Checklist this dispatch carried (issue #226), already parsed at the
	 * tool-arg boundary. Seeded into the worker's session before its first
	 * turn, or appended to its prompt as markdown when nothing claims the
	 * seed channel.
	 */
	tasks?: TasksSeed;
	/** Session focus carried by the handoff namespace. */
	focus?: unknown;
	/** Grant this worker access to capped excerpts from the trusted parent snapshot. */
	parentTranscriptSearch?: boolean;
	maxRounds: number;
	/** Frozen supervised timeout policy, resolved before dispatch. */
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
	collapseMode: CollapseMode;
	summaryModelRef?: string; // explicit "provider/id", or literal "auto" for built-in Haiku 4.5
	supervisorInstructions?: string;
	/**
	 * Raw, user-supplied working directory for this fork (absolute or relative
	 * to the main-thread cwd). Kept on the request for telemetry; the
	 * resolved/effective cwd the worker actually runs in is `ForkContext.cwd`.
	 */
	cwd?: string;
	/**
	 * Phase 3c — route worker UI prompts (command-guard confirmations, etc.)
	 * to the overlay, blocking the fork until the user answers. When
	 * `false` or undefined, the worker is bound with *no* uiContext (identity
	 * `noOpUIContext`) so `ctx.hasUI === false` in worker tools and
	 * command-guard auto-denies, matching non-interactive CLI behaviour.
	 */
	interactive?: boolean;
	/**
	 * Commit B.2 — pre-resolved heartbeat knobs (from per-fork override
	 * merged with config defaults; absent => WorkerChannel picks its own
	 * defaults). `heartbeatIntervalMs === 0` disables heartbeat entirely.
	 * See docs/heartbeat.md.
	 */
	heartbeatIntervalMs?: number;
	maxConsecutiveHeartbeats?: number;
	/**
	 * Extra heartbeat intervals of silence tolerated after the wind-down
	 * steer, before the channel hard-aborts. Absent => WorkerChannel uses
	 * `DEFAULT_HEARTBEAT_GRACE_INTERVALS`.
	 */
	heartbeatGraceIntervals?: number;
	heartbeatTailLines?: number;
	/** Frozen slot policy prepared before dispatch; consumed by Phase 3b. */
	escalationPolicy?: EffectiveEscalationPolicy;
	/** Effective environment patch for this supervised fork. */
	env?: EnvOverrides;
	/** Additional absolute writable roots, resolved defensively against worker cwd. */
	writableRoots?: string[];
	/** Defaults to true; false explicitly disables the worker write guard. */
	confineWrites?: boolean;
	/** Optional enforced per-slot read-only boundary. */
	readOnly?: boolean;
	/** Private run scratch allocated once and reused on restart/fallback. */
	scratchRoot?: string;
}

/**
 * Mutable handle to the per-fork AgentSessions. Populated by `runFork`
 * after `createAgentSession` returns, so `DelegateDispatchState.cancel` /
 * `DelegateDispatchState.steer` can reach the live sessions without having to
 * hook into the fork promise.
 */
export interface ForkSessionRefs {
	clone?: AgentSession;
	worker?: AgentSession;
}

/** Lifecycle boundaries exposed only as a deterministic test/diagnostic seam. */
export type WorkerAttemptBoundary =
	| "preparation"
	| "session"
	| "extension-binding"
	| "channel"
	| "subscription"
	| "prompt"
	| "cancellation"
	| "final-teardown";

export interface WorkerAttemptLifecycleEvent {
	phase: "acquired" | "released";
	boundary: WorkerAttemptBoundary;
	generation?: number;
}

/** Concrete SDK/resource calls observed by the lifecycle test seam. */
export type WorkerAttemptLifecycleOperation =
	| "runtime-invalidate"
	| "preparation"
	| "session-create"
	| "extension-bind"
	| "channel-create"
	| "subscribe"
	| "unsubscribe"
	| "channel-abort"
	| "channel-settlement"
	| "session-dispose"
	| "prompt"
	| "final-teardown";

export interface WorkerAttemptLifecycleOperationEvent {
	operation: WorkerAttemptLifecycleOperation;
	phase: "acquired" | "released";
	generation?: number;
}

export interface WorkerAttemptLifecycleHooks {
	onEvent?: (event: WorkerAttemptLifecycleEvent) => void;
	/** Observe concrete method calls, rather than only lifecycle labels. */
	onOperation?: (event: WorkerAttemptLifecycleOperationEvent) => void;
	/** Inject a post-call cleanup failure while retaining the real call count. */
	throwOnOperation?: WorkerAttemptLifecycleOperation;
	/** Awaited only at replacement seams; used to prove forks do not serialize globally. */
	onReplacementBoundary?: (boundary: "preparation" | "publication", generation: number) => Promise<void> | void;
	/** Inject one failure immediately after the named acquisition boundary. */
	failAfter?: WorkerAttemptBoundary;
}

export interface ForkContext {
	cwd: string;
	mainBranchEntries: any[]; // SessionEntry[] from ctx.sessionManager.getBranch()
	fromToolCallId: string;
	mainModel: { provider: string; id: string } | undefined;
	mainSystemPrompt: string;
	/** Compatibility child-session auth input. */
	authStorage?: object;
	/** Canonical Pi 0.80+ child-session model/auth runtime. */
	modelRuntime?: ModelRuntimeLike;
	/** Allow the Pi extension-context compatibility facade to reveal its runtime. */
	allowRegistryRuntimeFallback?: boolean;
	modelRegistry: ModelRegistry;
	/** Non-empty parent-session model scope. Omitted means unrestricted. */
	scopedModelRefs?: ModelScope;
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly import("@earendil-works/pi-coding-agent").ToolDefinition[];
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	/** Originator's global policy, distinct from this worker slot's policy. */
	originatorEscalationConfig?: ResolvedEscalationConfig;
	signal?: AbortSignal;
	/**
	 * Identity tuple for this fork, used by worker-UI routing and by hooks
	 * that need to look up state in the runtime registry. When running via
	 * sync mode these can be left undefined — the runtime isn't in play.
	 */
	runId?: string;
	forkName?: string;
	/** Sibling ordinal for lineage/event-bus addressing inside a parallel supervised batch. */
	childIndex?: number;
	/**
	 * Mutable ref populated by `runFork` as sessions come up. Supplied by
	 * dispatch mode so `cancel` / `steer` on `DelegateDispatchState` can reach the
	 * live sessions; leave undefined in sync mode.
	 */
	sessionRefs?: ForkSessionRefs;
	/**
	 * Phase 3c — uiContext bound to the worker session when
	 * `req.interactive === true`. When undefined we deliberately call
	 * `bindExtensions({})` with no uiContext so the ExtensionRunner keeps
	 * its default `noOpUIContext` identity (`ctx.hasUI === false`).
	 */
	workerUIContext?: ExtensionUIContext;
	/**
	 * Phase 3a.2 — called by the `message_subagent` clone tool at the top
	 * of each round to drain any user-supplied guidance from the runtime.
	 * When non-empty the drained messages are prepended to the supervisor's
	 * text as a `<user-guidance>` block, and `onGuidanceDelivered` fires.
	 */
	getPendingGuidance?: () => string[];
	onGuidanceDelivered?: (messages: string[]) => void;
	/**
	 * Look up the cancel reason the runtime stamped on the live state when
	 * `DelegateDispatchState.cancel` fired. Called from the fork-runner's abort path so
	 * the final `RunResult.cancelReason` carries `"user" | "timeout" |
	 * "supervisor" | "shutdown"` rather than an opaque string. Left undefined
	 * in sync-only / runtime-less call sites.
	 */
	getCancelReason?: () => CancelReason | undefined;
	onUpdate?: (update: RunUpdate) => void;
	/**
	 * Optional hook for dispatch mode. Called alongside `onUpdate` with the
	 * fields that changed on this tick. Independent from `onUpdate` so the
	 * existing sync-mode streaming path is untouched; both fire on the same
	 * transitions.
	 */
	onRuntimeUpdate?: (patch: Partial<RunLiveState>) => void;
	/** Deterministic fault/counter seam for supervised attempt lifecycle tests. */
	workerAttemptLifecycle?: WorkerAttemptLifecycleHooks;
	/** Optional deterministic clock seam for the worker channel heartbeat path. */
	workerChannelClock?: WorkerChannelClock;
	/** Deterministic full-jitter source for the one credential lock retry. */
	credentialRetryRandom?: () => number;
	/**
	 * Optional per-entry transcript hook. Called whenever a new
	 * `TranscriptEntry` becomes available — driven by real `subscribe` hooks
	 * on the supervisor (clone) and worker sessions, running their
	 * `message_end` events through `messagesToTranscript` to guarantee the
	 * same semantics as the post-hoc transcript in `RunResult.transcript`.
	 */
	onTranscriptEntry?: (entry: TranscriptEntry) => void;
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "paused";

/** @deprecated Use {@link RunStatus}; retained for compatibility. */
export type ForkStatus = RunStatus;

export interface RunUpdate {
	name: string;
	status: RunStatus;
	currentRound: number;
	maxRounds: number;
	lastWorkerText?: string;
	lastSupervisorText?: string;
	workerSessionFile?: string;
	recoveredOutput?: boolean;
	error?: string;
	errorKind?: WorkerErrorKind;
	/** Actionable failure cause when the runner classified one (#469/#197). */
	failureCause?: WorkerFailureCause;
	refusalModels?: string[];
	/** Issue #226 — latest checklist counts, absent when none was dispatched. */
	taskProgress?: TaskProgressFields;
}

/** @deprecated Use {@link RunUpdate}; retained for compatibility. */
export type ForkUpdate = RunUpdate;

/**
 * Snapshot of a retired worker session, captured at the moment the
 * supervisor called `restart_worker`. Accumulated on `RunResult` so
 * downstream consumers (the main agent reading the collapsed transcript,
 * forensic reviewers diffing session files, etc.) can reconstruct what
 * the earlier attempts did before the final session got its turn.
 *
 * The runtime cancel-path does NOT capture one of these — cancel is
 * terminal, there's no "next" session, and the current session's
 * messages are still reachable via `result.transcript` as usual.
 *
 * Only `restart_worker` pushes entries here.
 */
export interface PriorWorkerSession {
	/** Path to the retired session's jsonl file. */
	sessionFile?: string;
	/**
	 * Snapshot of `AgentSession.messages` taken immediately before the old
	 * session was aborted. The jsonl file on disk may be more authoritative
	 * (if anything landed between snapshot and abort), but this snapshot is
	 * what feeds the collapsed `result.transcript` so it stays self-contained.
	 */
	messagesSnapshot: AgentMessage[];
	/** Unix ms when the session was retired. */
	endedAt: number;
	/** Why this session was retired. Defaults to a supervisor `restart_worker` call. */
	retirementReason?: "restart_worker" | "refusal-fallback" | "transient-fallback";
	/**
	 * The `newMessage` argument the supervisor passed to `restart_worker`.
	 * Useful forensics: tells a reader what the supervisor thought the new
	 * attempt should try differently.
	 */
	restartMessage: string;
}

/** Tool calls whose refusal means a file the worker may claim to have produced does not exist. */
const DELIVERABLE_TOOL_NAMES = new Set(["write", "edit"]);

/**
 * Derive a warning from refused `write`/`edit` calls (issue #536).
 *
 * The refusal is already recorded on the result, but nothing downstream
 * contradicted the worker's own account of what it did. Measured on
 * 2026-09-16, two workers hit the identical refusal and reported it
 * differently: one said "the verdict file has been written successfully" for a
 * file that never existed, the other reported the redirect accurately. Honest
 * narration is therefore a model property, not a runtime guarantee, so the
 * runner has to state the contradiction itself.
 *
 * A refused `bash` call does not raise this: it is a real policy event, but it
 * does not by itself mean a declared deliverable is missing.
 */
export function refusedWriteWarning(refusals: RunResult["policyRefusals"]): ForkWarning | undefined {
	if (!refusals?.length) return undefined;
	const tools = [...new Set(refusals
		.map((refusal) => refusal.toolName)
		.filter((toolName) => DELIVERABLE_TOOL_NAMES.has(toolName)))];
	if (tools.length === 0) return undefined;
	return {
		kind: "policy",
		message: `Boundary refused ${tools.join(" and ")}: any file this worker reports having produced was not written. `
			+ "Treat its completion claim as unproven and re-read the deliverable before trusting it.",
	};
}

/** Non-fatal diagnostic retained on a terminal run result. */
export interface ForkWarning {
	// `policy` marks a boundary refusal that may invalidate the worker's own
	// completion claim, such as a refused write for a declared deliverable (#536).
	kind: "reads" | "output" | "progress" | "policy";
	message: string;
}

export interface RunResult {
	name: string;
	/** Effective attempt number; legacy results without it mean attempt 1. */
	attempt?: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	status: RunStatus;
	roundsUsed: number;
	maxRounds: number;
	collapseMode: CollapseMode;
	collapsedContent: string;
	workerSessionFile?: string;
	/** SHA-256 of each exact user message delivered to the worker, in order. */
	inputDigests?: Array<{ sequence: number; algorithm: "sha256"; digest: string }>;
	/**
	 * Final state of the dispatched checklist (issue #226), absent when the
	 * dispatch carried none. Lets a caller classify this run entry mechanically —
	 * `outcome: "gap"` means tasks were left unfinished — instead of inferring
	 * completion from the worker's prose, which is the failure this addresses.
	 */
	taskLedger?: TaskLedger;
	/** True when an unsuccessful terminal run still yielded recoverable worker output. */
	recoveredOutput?: boolean;
	/** Non-fatal diagnostics retained with their source category. */
	warnings?: ForkWarning[];
	/**
	 * Absolute working directory the worker session ran in. Useful for
	 * consumers that want to know which worktree (or per-entry cwd) a
	 * specific worker operated against.
	 */
	workerCwd?: string;
	/** Validated records emitted by the optional prompt-repair worker extension. */
	promptRepairs?: PromptRepairRecord[];
	transcript: TranscriptEntry[];
	supervisorFinishPayload?: { final_output?: string; summary?: string };
	/**
	 * When the summary collapse path was taken, the `provider/id` of the
	 * model used to summarise. Populated even if the summariser returned
	 * empty/whitespace and we had to fall back — so empty summaries stay
	 * diagnosable from the tool result alone.
	 */
	summaryModelUsed?: string;
	/**
	 * Explains why summary collapse returned the supervisor/worker hint instead
	 * of model-produced text: an explicit model was unavailable, automatic Haiku
	 * routing was unavailable, or the selected summariser returned empty content
	 * or failed.
	 * Distinct from `error` — the run entry itself still completes successfully.
	 */
	summaryFallbackReason?: string;
	error?: string;
	/** Provider/runtime error class when a failure is more specific than generic. */
	errorKind?: WorkerErrorKind;
	/**
	 * Retry-cause discriminant, set only when the underlying terminal failure
	 * was transient or a capacity limit (issue #332). Distinct from `errorKind`,
	 * which `markNoModelAlternative` also stamps on the worker-harness failure
	 * path that is neither transient nor capacity, so consumers deciding whether a
	 * transient recovery may be retried read this, not `errorKind` or the prose.
	 */
	retryKind?: WorkerRetryKind;
	/**
	 * Actionable cause of a terminal failure, when the runner classified one
	 * (issues #469, #197). Set from the provider's own diagnostic at the moment
	 * the runner still has it, because by the time a caller sees the result the
	 * prose has been suffixed and the bounded wake carries no prose at all.
	 * Distinct from `errorKind` and `retryKind`, which record what the runner
	 * did next rather than why the worker died.
	 */
	failureCause?: WorkerFailureCause;
	/** Worker model refs that refused before this run entry failed or fell back. */
	refusalModels?: string[];
	/** Structured policy refusals observed during the worker session. */
	policyRefusals?: Array<{ boundary: "readOnly" | "writableRoot"; toolName: "write" | "edit" | "bash"; reason: string }>;
	/** Git-only attribution of changes observed during this run entry's time window. */
	mutationReport?: import("./mutation-tracking.js").MutationReport;
	/** Bounded isolated-worktree diff retained before the worktree is cleaned up. */
	worktreeDiff?: WorktreeDiff;
	/** Actual worker provider/model used for the final attempt, when resolved. */
	workerModel?: string;
	/** Ordered model refs considered while resolving/falling back. */
	attemptedModels?: string[];
	/**
	 * Reason this run entry was cancelled, copied from `RunLiveState.cancelReason`
	 * at the moment the runner observed the abort. Only meaningful when
	 * `status === "aborted"`. Absent on natural completion / failure.
	 */
	cancelReason?: CancelReason;
	/**
	 * True when this run entry concluded AFTER a graceful wind-down steer fired
	 * (the worker went silent past `maxConsecutiveHeartbeats` and was sent a
	 * wrap-up instruction, OR the per-entry wall-clock grace steer fired).
	 * Set whether the worker then finished cleanly within the grace window
	 * or was hard-aborted past it — the parent reads it as "this answer was
	 * produced under wrap-up pressure and may be less complete". Absent /
	 * falsy on the happy path (run entry finished well within budget).
	 */
	steered?: boolean;
	/** Immutable timeout metadata captured by the supervised runtime. */
	timeout?: ResolvedRunTimeoutPolicy & { readonly deadlineAtMs?: number };
	/**
	 * Ordered list of worker sessions that were retired via `restart_worker`
	 * before the current (final) one. Absent / empty when no restarts
	 * happened — the overwhelmingly common case. When present, entries are
	 * in chronological order (oldest first) and the messages from each are
	 * interleaved into `result.transcript` with `worker:system` boundary
	 * entries so the main agent can see the full attempt history.
	 */
	priorWorkerSessions?: PriorWorkerSession[];
	usage: {
		supervisorInput: number;
		supervisorOutput: number;
		/** Cache read/write tokens are optional for back-compat with older persisted runs/tests. */
		supervisorCacheRead?: number;
		supervisorCacheWrite?: number;
		workerInput: number;
		workerOutput: number;
		workerCacheRead?: number;
		workerCacheWrite?: number;
		/** Rejected provider counters retained for diagnostics. */
		diagnostics?: UsageNormalizationDiagnostic[];
		/** Activity-ticker model usage is distinct from worker/supervisor usage. */
		tickerInput?: number;
		tickerOutput?: number;
		tickerCacheRead?: number;
		tickerCacheWrite?: number;
		/** Ticker-model USD cost. `cost` remains the aggregate including this value. */
		tickerCost?: number;
		cost: number;
	};
}

/** @deprecated Use {@link RunResult}; retained for compatibility. */
export type ForkResult = RunResult;

const FINISH_SENTINEL = "__delegate_finished__";

/**
 * Framing block appended to the worker's system prompt. Describes the
 * sub-conversation contract (each user msg is a supervisor instruction;
 * reply concisely; the supervisor will collapse).
 */
export const WORKER_DELEGATION_FRAMING =
	'You are the subagent identified by the agent\'s system prompt above. You are in a dialogue with a supervisor agent that delegated work to you. ' +
	"Each user message is the next instruction from the supervisor. Complete the instruction, then reply concisely \u2014 the supervisor will review and may send follow-ups or finalise the delegation.";

/**
 * Wrap-up steer text injected into a worker that has gone silent past its
 * heartbeat budget. Distinguishable from a user/parent steer so the model
 * knows this is a forced wind-down (REQ-WIND-1): it has a bounded grace
 * window to land a final answer before the channel hard-aborts.
 */
export const WORKER_WIND_DOWN_STEER =
	"[wind-down] You've gone silent past the allowed limit. Stop any in-progress work and " +
	"produce your final answer NOW \u2014 this is a forced wrap-up. You have a brief grace window; " +
	"if you do not conclude, you will be hard-cancelled and your partial output salvaged.";

/**
 * Normalise the agent's `thinking` frontmatter into a pi-coding-agent
 * ThinkingLevel. Invalid values trigger a one-line warning and return
 * undefined so the caller omits the option.
 */
export function resolveThinkingLevel(
	raw: string | undefined,
	agentName: string,
): ThinkingLevel | undefined {
	if (!raw) return undefined;
	const v = raw.trim().toLowerCase();
	if (!v) return undefined;
	if (THINKING_LEVELS.includes(v as ThinkingLevel)) return v as ThinkingLevel;
	logDelegateDiagnostic(
		`agent "${agentName}": ignoring unknown thinking level "${raw}" ` +
			`(valid: ${THINKING_LEVELS.join(", ")})`,
	);
	return undefined;
}

/**
 * Translate an AgentConfig into DefaultResourceLoader options for the worker
 * session. Pure function so it can be unit-tested independently.
 *
 * Rules:
 *   - systemPromptMode="replace" → systemPrompt = agent body, append framing.
 *   - systemPromptMode="append"  → no systemPrompt (loader discovers base);
 *                                  appendSystemPrompt = [agent body, framing].
 *   - inheritProjectContext      → controls noContextFiles.
 *   - skills empty && !inheritSkills → noSkills: true.
 *   - skills non-empty           → skillsOverride filters to the listed names
 *                                  in requested order (base discovery order is ignored;
 *                                  noSkills remains default so the base set loads).
 *                                  A requested skill discovery did not find is
 *                                  reported as a diagnostic, never dropped in
 *                                  silence: the worker's prompt still names it.
 *   - extensions undefined       → noExtensions left UNSET (workers inherit
 *                                  the parent's base extension set; see the
 *                                  rationale comment in the function body).
 *   - extensions set             → additionalExtensionPaths (path-only; we do
 *                                  not support pi-subagents' name-vs-path
 *                                  disambiguation because it's subprocess-specific).
 */
export function buildWorkerLoaderOptions(
	agent: AgentConfig,
	base: {
		cwd: string;
		agentDir: string;
		/**
		 * Phase D: optional extra instructions appended to the worker's
		 * appendSystemPrompt array. Used to inject the intercom bridge
		 * instruction in direct/chain modes (see `intercom-bridge.ts`).
		 * Empty / nullish entries are stripped.
		 */
		extraInstructions?: string[];
	},
): DefaultResourceLoaderOptions {
	const opts: DefaultResourceLoaderOptions = {
		cwd: base.cwd,
		agentDir: base.agentDir,
		noContextFiles: !agent.inheritProjectContext,
	};

	const bodyPrompt = agent.systemPrompt.trim();
	const extras = (base.extraInstructions ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
	if (agent.systemPromptMode === "append") {
		opts.appendSystemPrompt = [bodyPrompt, WORKER_DELEGATION_FRAMING, ...extras].filter(
			(s) => s.length > 0,
		);
	} else {
		opts.systemPrompt = bodyPrompt;
		opts.appendSystemPrompt = [WORKER_DELEGATION_FRAMING, ...extras];
	}

	const hasExplicitSkills = Boolean(agent.skills && agent.skills.length > 0);
	if (!hasExplicitSkills && !agent.inheritSkills) {
		opts.noSkills = true;
	} else if (hasExplicitSkills) {
		const requestedSkills = [...new Set(agent.skills!)];
		opts.skillsOverride = (baseResult) => {
			const discoveredByName = new Map(
				baseResult.skills.map((skill) => [skill.name, skill] as const),
			);
			// A requested skill that discovery did not find used to vanish here.
			// The worker's prompt still named it as its contract, so the worker
			// guessed a path, failed with E_NOT_FOUND, and carried on without the
			// contract it was told to follow — a silently weaker run rather than a
			// loud failure. Report the miss instead of dropping it.
			const missing: string[] = [];
			const skills = requestedSkills.flatMap((name) => {
				const skill = discoveredByName.get(name);
				// `disable-model-invocation: true` withholds a skill from the
				// *default* listing while leaving it slash-invocable. The SDK
				// enforces that by filtering on the flag when it formats a prompt,
				// and it formats this worker's prompt with the same function — so
				// a flagged skill would be missing from the prompt of the very
				// agent that asked for it by name, which is the failure the
				// diagnostic above exists to prevent. Naming a skill in an agent's
				// `skills:` list is that explicit request, so clear the flag on a
				// copy. The discovered entry is left untouched: a skill this
				// worker did not request keeps its flag everywhere else.
				if (skill) return [skill.disableModelInvocation ? { ...skill, disableModelInvocation: false } : skill];

				missing.push(name);
				return [];
			});
			return {
				skills,
				diagnostics: missing.length > 0
					? [
						...baseResult.diagnostics,
						{
							type: "warning" as const,
							message: `agent ${agent.name}: requested skill(s) not found, so not loaded: ${missing.join(", ")}. `
								+ "The worker's instructions may still name them as its contract, and it cannot read them.",
						},
					]
					: baseResult.diagnostics,

			};
		};

	}

	if (agent.extensions && agent.extensions.length > 0) {
		opts.additionalExtensionPaths = agent.extensions;
		// noExtensions left false — we still want base extensions plus these.
	}
	// Never set noExtensions: worker sessions must inherit the parent's
	// base extension set (discovered from settings.json) so that
	// environment-specific extensions (e.g. luthen-proxy for header
	// injection inside workspace sandboxes) remain active. Previously
	// this set noExtensions=true when the agent had neither explicit
	// tools nor extensions, which stripped all extensions including
	// ones the parent relied on for provider auth and request routing.

	return opts;
}

/** Build the supervisor clone's deliberately isolated Pi-native resource set. */
export async function createSupervisorResourceLoader(options: {
	cwd: string;
	agentDir: string;
	systemPrompt: string;
}): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: options.systemPrompt,
	});
	await loader.reload();
	return loader;
}

// ---------------------------------------------------------------------------
// Fork-reload offline guard (spec 0015 / refcount-offline-guard-around-fork-reload)
// ---------------------------------------------------------------------------
//
// WHY: every in-process delegate fork constructs a `DefaultResourceLoader`
// and calls `workerLoader.reload()` (see the reload site below). pi-core's
// `reload()` -> `packageManager.resolve()` -> `updateConfiguredSources` runs a
// per-source npm version-check + `npm install`, and that npm child is spawned
// with INHERITED stdout in the parent process — so its `audited N packages /
// N looking for funding / N low severity vulnerabilities` summary prints
// straight into the parent TUI on EVERY fork. Forcing `PI_OFFLINE` makes
// `updateConfiguredSources` early-return (pi-core reads `process.env.PI_OFFLINE`
// LIVE per call, so the flag takes effect for the duration of the reload),
// suppressing the version-check + install + spill, while `resolve()` still
// returns the already-installed extension paths. The parent already reconciled
// these extensions at startup; a fork only needs to LOAD them, not reinstall.
//
// CONDITIONAL CAVEAT (reviewer-found — document, do not "fix"): the
// "no change to which extensions a worker loads" guarantee holds ONLY because
// base extensions are parent-installed-and-present (`existsSync` true) at fork
// time — the steady state, and exactly the installed-but-behind churn case
// (resolves normally). For a MISSING or pinned-version-mismatched extension,
// forced-offline `resolve()` hits `installMissing() -> false` and SILENTLY
// DROPS it from the worker's resolved set (pi-core package-manager.ts
// ~1238-1251) — whereas a non-offline reload would install-then-load it. In
// steady state this does not regress; documented so a future "worker lost
// extension X" mystery is anticipated, not rediscovered.
//
/**
 * Run `fn` (the fork's `workerLoader.reload()`) with `PI_OFFLINE` forced on.
 * This is deliberately an async-local overlay rather than a process-global
 * write: a caller's worker env may itself override PI_OFFLINE, and concurrent
 * workers must not leak that value into one another or into the foreground.
 */
export async function withForkOffline<T>(fn: () => Promise<T>): Promise<T> {
	return await withEnvOverrides({ PI_OFFLINE: "1" }, fn);
}

/** Only publish a worker session path once its lazy JSONL has been created. */
function existingWorkerSessionFile(sessionFile?: string): string | undefined {
	return sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
}

/**
 * Shared direct/supervised-inner/hosted-worker resource preparation. Extension
 * identity is resolved before the first prompt, while extension tool membership
 * remains live for lifecycle registrations that happen during session_start or
 * before_agent_start.
 */
export async function prepareWorkerSessionResources(
	agent: AgentConfig,
	base: {
		cwd: string;
		agentDir: string;
		settingsManager?: SettingsManager;
		extraInstructions?: string[];
		confinement?: WriteConfinementPolicy;
		intercomBridge?: ResolvedBridge;
		workerGrantedToolNames?: readonly string[];
		/** Mode-aware artifact writer capability that must survive final live binding. */
		artifactWriterRequirement?: ArtifactWriterRequirement;
	},
	surface: ResolvedToolSurface,
	onRuntimeInvalidation?: () => void,
): Promise<{
	loader: DefaultResourceLoader;
	/** Live selector scope used to construct and enforce the worker session. */
	toolScope: PreparedWorkerToolScope;
	/**
	 * The surface actually used, which may have gained session-declaration tools
	 * once the worker's own extensions were known (#338). Callers that report or
	 * register the worker's tools must use this, not the surface they passed in.
	 */
	surface: ResolvedToolSurface;
	eventBus: EventBusController;
	thinkingPolicyContext: WorkerThinkingPolicyContext | undefined;
}> {
	assertValidExtensionToolSelectors(surface);
	const eventBus = createEventBus();
	const thinkingPolicyContext = createWorkerThinkingPolicyContext(agent, eventBus);
	const loaderOptions = buildWorkerLoaderOptions(agent, base);
	if (base.settingsManager) loaderOptions.settingsManager = base.settingsManager;
	loaderOptions.eventBus = eventBus;
	if (thinkingPolicyContext) {
		loaderOptions.extensionFactories = [
			...(loaderOptions.extensionFactories ?? []),
			thinkingPolicyContext.extensionFactory,
		];
	}
	if (base.confinement) {
		loaderOptions.extensionFactories = [
			...(loaderOptions.extensionFactories ?? []),
			createWriteConfinementExtension(base.confinement),
		];
	}
	let loader: DefaultResourceLoader | undefined;
	try {
		loader = await withForkOffline(() =>
			loadWorkerResourceLoader(agent, loaderOptions, onRuntimeInvalidation, {
				intercomBridge: base.intercomBridge,
				requestedExtensionSelectors: surface.extSelectors
					.filter((selector) => !isOptionalGlobalExtensionSelector(surface, selector))
					.map(({ extension }) => extension),
			}),
		);
		thinkingPolicyContext?.assertCompatible(loader.getExtensions());
		// First authoritative view of what the WORKER loads, which is not always
		// what the dispatching session loads. Re-apply the session-declaration rule
		// here so a least-privilege agent still gets the tools its dispatch needs.
		const loadedExtensions = loader.getExtensions().extensions;
		const effectiveSurface = amendClaimedSessionTools(surface, claimedSessionToolNames(loadedExtensions));
		const toolScope = prepareWorkerToolScope(effectiveSurface, loadedExtensions, {
			workerGrantedToolNames: base.workerGrantedToolNames,
			artifactWriterRequirement: base.artifactWriterRequirement,
			writeConfined: base.confinement !== undefined,
		});
		assertWorkerToolSurfaceUsable(effectiveSurface, toolScope);
		if (toolScope.diagnostics.length > 0) {
			logDelegateDiagnostic(toolScope.diagnostics.join(" "), {
				agentDir: base.agentDir,
				throttleKey: "tool-surface-missing-extension",
			});
		}
		return { loader, toolScope, surface: effectiveSurface, eventBus, thinkingPolicyContext };
	} catch (error) {
		// A loader can have already executed extension factories before policy or
		// thinking validation fails. There is no AgentSession to own that runtime
		// yet, so invalidate it here and make the failed attempt stale exactly once.
		// Cleanup must never replace the construction failure (including an SDK
		// invalidate that throws before or after making the runtime stale).
		if (loader) {
			try { invalidateFailedWorkerRuntime(loader, onRuntimeInvalidation); } catch { /* preserve construction failure */ }
		}
		throw error;
	}
}

/**
 * Count real tool-call content blocks across every assistant message in the
 * supplied list. pi-ai's internal block type is `"toolCall"` (the Anthropic
 * wire-shape `"tool_use"` is normalised away by the provider adapter); we
 * match that canonical name so mixed-provider workers (Anthropic, OpenAI,
 * Google, …) all count correctly. Used together with
 * `looksLikeWorkerToolCallNarration` to detect the worker-side tool-harness
 * regression: the model produced prose that looks like tool calls but never
 * actually invoked a tool. Exported for testing.
 */
export function countAssistantToolUses(messages: AgentMessage[]): number {
	let n = 0;
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const p of m.content as any[]) if (p.type === "toolCall") n++;
	}
	return n;
}

/** Tool names registered on the clone session. Exported for testing. */
export const CLONE_MESSAGE_TOOL = "message_subagent";
export const CLONE_WAIT_TOOL = "wait_for_worker";
export const CLONE_INSPECT_TOOL = "inspect_worker";
export const CLONE_CANCEL_TOOL = "cancel_worker";
export const CLONE_RESTART_TOOL = "restart_worker";
export const CLONE_FINISH_TOOL = "finish_delegation";

/**
 * Render a `WorkerInspectSnapshot` as the tool-result for `inspect_worker`.
 * Format mirrors heartbeat so the supervisor sees a familiar shape — one
 * status line + active tool call + recent tail — without any
 * "decide / wait / finish" prompt (inspect is passive and does not bump
 * the round counter; the supervisor decides what to do next).
 */
export function buildInspectToolResult(
	snap: WorkerInspectSnapshot,
	pendingEscalationRequestIds?: readonly string[],
) {
	const lines: string[] = [];
	lines.push(
		`Subagent state: ${snap.workerState.toUpperCase()}. Silent for ${formatSilence(snap.silenceMs)}.`,
	);
	if (snap.awaitingEscalation) {
		const ids = pendingEscalationRequestIds ?? snap.awaitingEscalation.requestIds;
		lines.push(
			ids.length > 0
				? `Pending in this supervisor's mailbox: ${ids.join(", ")}. Inspect and either \`resolve_escalation\` or \`escalate\`.`
				: "The worker is awaiting an escalation resolved at a higher hop; this supervisor's mailbox is empty.",
		);
	}
	if (snap.consecutiveHeartbeats > 0) {
		lines.push(`Consecutive heartbeats so far: ${snap.consecutiveHeartbeats}.`);
	}
	if (snap.activeToolCall) {
		lines.push(
			`Active tool: ${snap.activeToolCall.name}(${snap.activeToolCall.preview.slice(0, 160)})`,
		);
	} else {
		lines.push(`No active tool call.`);
	}
	if (snap.recentTail.length > 0) {
		lines.push(`Recent transcript (last ${snap.recentTail.length}):`);
		for (const e of snap.recentTail) lines.push(formatTailEntry(e));
	} else {
		lines.push(`No worker activity observed yet.`);
	}
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			kind: "inspect" as const,
			workerState: snap.workerState,
			silenceMs: snap.silenceMs,
			consecutiveHeartbeats: snap.consecutiveHeartbeats,
			awaitingEscalation: snap.awaitingEscalation,
			activeToolCall: snap.activeToolCall,
			workerSessionFile: snap.workerSessionFile,
		},
	};
}

/**
 * Format a `HeartbeatTailEntry` into one line for the heartbeat tool result.
 * Bounded to ~160 chars so the supervisor gets a scannable trace.
 */
function formatTailEntry(e: HeartbeatTailEntry): string {
	const prefix =
		e.kind === "toolCall"
			? `toolCall[${e.toolName ?? "?"}]`
			: e.kind === "toolResult"
				? `toolResult[${e.toolName ?? "?"}]`
				: e.role === "assistant"
					? "assistant"
					: e.role ?? "text";
	return `  - ${prefix}: ${e.preview.slice(0, 160)}`;
}

function formatSilence(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.floor(s % 60);
	return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * Render a `WorkerCallResult` as the tool-result returned to the supervisor
 * for `message_subagent` and `wait_for_worker`. Extracted so both tools
 * share the same formatting and the same details shape.
 *
 * `reply` path returns the last assistant text verbatim (matches B.1).
 * `heartbeat` / `aborted` paths return a structured, scannable status so
 * the supervisor can make an informed decision (see docs/heartbeat.md).
 */
export function buildToolResultFromWorkerCall(
	result: WorkerCallResult,
	ctx: {
		round: number;
		workerSessionFile?: string;
		pendingEscalationRequestIds?: readonly string[];
	},
) {
	if (result.kind === "reply") {
		return {
			content: [{ type: "text" as const, text: result.text }],
			details: {
				kind: "reply" as const,
				round: ctx.round,
				workerSessionFile: ctx.workerSessionFile,
			},
		};
	}
	if (result.kind === "failed") {
		const failureKind = result.errorKind === "refusal" ? "refusal" : "failed";
		return {
			content: [{ type: "text" as const, text: result.errorKind === "refusal" ? `Worker refused: ${result.error}` : `Worker failed: ${result.error}` }],
			details: {
				kind: failureKind,
				round: ctx.round,
				workerSessionFile: ctx.workerSessionFile,
				error: result.error,
				errorKind: result.errorKind,
				stopReason: result.stopReason,
				recoveredOutput: result.recoveredOutput,
			},
		};
	}
	if (result.kind === "heartbeat") {
		const lines: string[] = [];
		if (result.awaitingEscalation) {
			const ids = ctx.pendingEscalationRequestIds ?? result.escalation?.requestIds ?? [];
			lines.push("Worker is suspended awaiting an escalation outcome.");
			lines.push(
				ids.length > 0
					? `Pending in this supervisor's mailbox: ${ids.join(", ")}. Inspect and either \`resolve_escalation\` or \`escalate\`.`
					: "This supervisor's mailbox is empty; the escalation is awaiting a higher holder.",
			);
		} else {
			lines.push(
				`Worker still running — no reply yet (heartbeat ${result.consecutiveHeartbeats}/${result.maxConsecutiveHeartbeats}).`,
			);
		}
		lines.push(`Silent for ${formatSilence(result.silentMs)} since last transcript activity.`);
		if (result.activeToolCall) {
			lines.push(
				`Active tool call: ${result.activeToolCall.name} — ${result.activeToolCall.preview.slice(0, 160)}`,
			);
		}
		if (result.recentTail.length > 0) {
			lines.push(`Recent worker activity (last ${result.recentTail.length}):`);
			for (const e of result.recentTail) lines.push(formatTailEntry(e));
		} else {
			lines.push(`No worker activity observed yet on this prompt.`);
		}
		if (result.awaitingEscalation) {
			lines.push(
				`After resolving or forwarding, call \`wait_for_worker\` to resume waiting for the worker reply.`,
			);
		} else {
			lines.push(
				`Decide: call \`wait_for_worker\` to keep waiting, or \`finish_delegation\` if you have enough to answer.`,
			);
		}
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: {
				kind: "heartbeat" as const,
				round: ctx.round,
				workerSessionFile: ctx.workerSessionFile,
				consecutiveHeartbeats: result.consecutiveHeartbeats,
				maxConsecutiveHeartbeats: result.maxConsecutiveHeartbeats,
				silentMs: result.silentMs,
				activeToolCall: result.activeToolCall,
				awaitingEscalation: result.awaitingEscalation,
				escalation: result.escalation,
			},
		};
	}
	// aborted
	const lines: string[] = [];
	if (result.recoveredOutput && result.harvest?.kind === "substantive") {
		lines.push(
			"⚠️ The worker finalized substantive output before its prompt transport aborted. " +
			"The recovered deliverable follows and the fork remains aborted.",
			"",
			result.harvest.text,
			"",
		);
	}
	if (result.reason === "heartbeat") {
		lines.push(
			`Worker auto-cancelled after ${result.consecutiveHeartbeats ?? "?"} consecutive heartbeats of silence` +
				(result.silentMs !== undefined ? ` (${formatSilence(result.silentMs)} quiet).` : "."),
		);
		lines.push(`The worker session is now aborted — call \`finish_delegation\` to collapse the fork.`);
	} else {
		lines.push(`Worker aborted: ${result.reason}.`);
		lines.push(`Call \`finish_delegation\` to collapse the fork.`);
	}
	if (result.activeToolCall) {
		lines.push(
			`Last active tool call: ${result.activeToolCall.name} — ${result.activeToolCall.preview.slice(0, 160)}`,
		);
	}
	if (result.recentTail && result.recentTail.length > 0) {
		lines.push(`Recent worker activity (last ${result.recentTail.length}):`);
		for (const e of result.recentTail) lines.push(formatTailEntry(e));
	}
	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: {
			kind: "aborted" as const,
			reason: result.reason,
			round: ctx.round,
			workerSessionFile: ctx.workerSessionFile,
			consecutiveHeartbeats: result.consecutiveHeartbeats,
			silentMs: result.silentMs,
			activeToolCall: result.activeToolCall,
			recoveredOutput: result.recoveredOutput,
			text: result.text,
			harvest: result.harvest,
		},
	};
}

/**
 * Build a `HeartbeatTailEntry` from a worker `message_end` message.
 * Returns `null` when there's no interesting content (e.g. an assistant
 * message with only reasoning blocks — the agent loop will emit another
 * message shortly).
 */
function heartbeatEntryFromMessage(m: any): HeartbeatTailEntry | null {
	const ts = typeof m?.timestamp === "number" ? m.timestamp : Date.now();
	if (!m || !Array.isArray(m.content)) return null;
	if (m.role === "assistant") {
		// Prefer toolCall (more specific) over text for a single-line preview.
		const toolCall = m.content.find((p: any) => p?.type === "toolCall");
		if (toolCall) {
			const args = toolCall.arguments ?? {};
			const argPreview =
				typeof args.command === "string" ? args.command
					: typeof args.file_path === "string" ? args.file_path
					: typeof args.path === "string" ? args.path
					: typeof args.query === "string" ? args.query
					: JSON.stringify(args).slice(0, 120);
			return {
				kind: "toolCall",
				role: "assistant",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				preview: `${toolCall.name}: ${String(argPreview).slice(0, 160)}`,
				ts,
			};
		}
		const textBlock = m.content.find((p: any) => p?.type === "text" && p.text);
		if (textBlock) {
			const firstLine = String(textBlock.text).split("\n")[0].trim();
			return {
				kind: "text",
				role: "assistant",
				preview: firstLine.slice(0, 160),
				ts,
			};
		}
		return null;
	}
	if (m.role === "toolResult") {
		const outText = m.content
			.map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
			.join("");
		const firstLine = String(outText).split("\n")[0].trim();
		return {
			kind: "toolResult",
			role: "toolResult",
			toolName: m.toolName,
			toolCallId: m.toolCallId,
			preview: firstLine.slice(0, 160),
			ts,
		};
	}
	return null;
}

/**
 * Detect text that looks like a stringified tool call for one of our clone
 * tools. Models (notably Claude) fall back to emitting a JSON-shaped tool
 * call as plain text when no tools are registered in the request, and we
 * must NOT salvage that as a successful `final_output` — it's a fork-runner
 * configuration bug, not a legitimate answer.
 *
 * Matches shapes like:
 *   {"name":"message_subagent","input":{...}}
 *   { "name": "finish_delegation" , "arguments": { ... } }
 *   {"type":"tool_use","name":"message_subagent",...}
 *
 * Exported so unit tests can pin the exact detector behavior.
 */
export function looksLikeSupervisorToolCallText(text: string): boolean {
	if (!text) return false;
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed[0] !== "{") return false;
	// Scan only the opening fragment so we don't waste effort on long payloads.
	const head = trimmed.slice(0, 512);
	const knownNames = `(?:${CLONE_MESSAGE_TOOL}|${CLONE_FINISH_TOOL})`;
	const re = new RegExp(`"name"\\s*:\\s*"${knownNames}"`);
	return re.test(head);
}

/**
 * Detect text that looks like a worker narrating a tool call as prose instead
 * of emitting a real `tool_use` content block. Symmetric to
 * `looksLikeSupervisorToolCallText` but for the worker side: some model
 * regressions cause the subagent to print fenced ```bash blocks or JSON
 * skeletons like `{"name":"bash",...}` in lieu of actually invoking the tool.
 * The runner must fail fast on this pattern rather than burn rounds.
 *
 * This detector is intentionally conservative — it only fires on STRUCTURAL
 * markers (fenced code tagged with a tool name, JSON objects keyed to a
 * builtin, tool_use-shaped JSON, or a `name:` prefix line) and never on prose
 * that merely mentions tools ("I'll use bash to ..."). Legitimate prose-only
 * replies from reviewer agents are not affected.
 *
 * Exported so unit tests can pin the exact detector behavior.
 */
export function looksLikeWorkerToolCallNarration(text: string): boolean {
	if (!text) return false;
	if (/```(?:bash|sh|shell|read|edit|write)\b/i.test(text)) return true;
	if (/\{[^}]{0,120}"name"\s*:\s*"(?:bash|read|edit|write|grep|find|ls)"/.test(text)) return true;
	if (/"type"\s*:\s*"tool_use"[^}]{0,200}"name"\s*:\s*"(?:bash|read|edit|write|grep|find|ls)"/.test(text)) return true;
	if (/^(?:bash|read|edit|write)\s*:\s*[a-z0-9._/-]/im.test(text)) return true;
	return false;
}

function retainTranscriptPolicyRefusals(result: RunResult, readOnly: boolean | undefined): void {
	if (readOnly !== true) return;
	const refusals = result.policyRefusals ?? (result.policyRefusals = []);
	for (const entry of result.transcript) {
		if (entry.role !== "toolCall" || (entry.toolName !== "write" && entry.toolName !== "edit")) continue;
		if (refusals.some((refusal) => refusal.toolName === entry.toolName)) continue;
		if (refusals.length >= 32) break;
		refusals.push({ boundary: "readOnly", toolName: entry.toolName, reason: `readOnly slot boundary refused attempted ${entry.toolName} call` });
	}
}

export function buildWorkerSessionDir(baseAgentDir: string): string {
	// Store under ~/.pi/agent/sessions/forks/ — a subdir *inside* the main
	// sessions/ dir rather than a sibling. This keeps fork worker sessions
	// discoverable by host/session readers that scan the main sessions dir (+
	// its subdirs), so a `workerSessionFile` id can be resolved through the
	// standard session-read path (issue #35). It stays out of the `/resume`
	// picker because that lists sessions per-cwd under
	// `sessions/--<cwd>--/`, and `forks/` is not a cwd slug — so forks remain
	// uncluttered by default but can still be opened explicitly.
	return `${baseAgentDir}/sessions/forks`;
}

async function runForkInner(
	req: ForkRequest,
	fctx: ForkContext,
	actorActivity: ActorActivityPublisher | undefined,
	credentialRetryBudget: CredentialRetryBudget,
): Promise<RunResult> {
	const startMs = Date.now();
	const startedAt = new Date(startMs).toISOString();
	// Issue #226 — checklist plumbing, declared at fork scope because the pieces
	// are read in three places: the builder resolves seedability, the message-end
	// hook reports progress, and finalization settles the ledger.
	// `tasksSeedable === undefined` means "not yet decided", and an undecided
	// checklist DEGRADES into the prompt rather than being dropped: a worker that
	// sees its plan without durability is a smaller loss than one that never sees
	// the plan at all.
	let tasksSeedable: boolean | undefined;
	let focusSeedable: boolean | undefined;
	let workerSessionMgr: { getEntries?: () => unknown[] } | undefined;
	const startUsage = { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 };
	const policyRefusals: NonNullable<RunResult["policyRefusals"]> = [];
	const taskDelivery: TaskDeliveryMode = req.taskDelivery ?? DEFAULT_TASK_DELIVERY_MODE;
	const result: RunResult = {
		name: req.name,
		attempt: req.attempt ?? 1,
		agent: req.agent.name,
		agentSource: req.agent.source,
		task: req.task,
		status: "running",
		roundsUsed: 0,
		maxRounds: req.maxRounds,
		collapseMode: req.collapseMode,
		collapsedContent: "",
		workerCwd: fctx.cwd,
		transcript: [],
		policyRefusals,
		usage: startUsage,
	};
	const capturePromptRepairs = (entries: readonly unknown[]): void => {
		const incoming = readPromptRepairRecords(entries);
		if (incoming.length === 0) return;
		result.promptRepairs = mergePromptRepairRecords(result.promptRepairs ?? [], incoming);
	};
	const supervisorActivityProjector = actorActivity
		? createAgentActivityProjector({ mode: "supervisor", publisher: actorActivity })
		: undefined;
	// The environment patch belongs to the worker session only. In particular,
	// the fork clone and the optional summary model must continue to observe the
	// caller's environment, not worker-specific credentials/proxies/unsets.
	const workerEnv = mergeEnvOverrides(req.agent.env, req.env);
	const withWorkerEnv = <T>(fn: () => T): T => withEnvOverrides(workerEnv, fn);

	// ── Event-bus liveness seam (spec 0004 / REQ-BUS-1/2) ──────────────────
	// Read the LIVE lineage frame straight from ALS (we are inside
	// `runWithDepth`). This MUST be the in-process frame, not a round-trip via
	// the serialized env: `serializeLineage` deliberately drops `idPath` (it
	// must stay out of the cap-token MAC), so a deserialized frame would carry
	// no id-path and `lineageAncestorPath` would silently fall back to the
	// leaf-only `lineagePath` — defeating the REQ-BUS-2 true-ancestry match in
	// production. This frame is THIS fork's address in the tree: its
	// `ancestorPath` (the full root→self id-path) is what a parent's heartbeat
	// probe checks a descendant prefix against, and its `rootRunId` keys the
	// sink. `undefined` when there is no frame (defensive, e.g. truly
	// top-level) → bus emits become no-ops (best-effort, REQ-BUS-4).
	// Issue #9: `resolveBusFrame` keeps the ALS-first semantics described
	// above (idPath intact for the REQ-BUS-2 prefix probe) and only adds the
	// inherited-env IDENTITY fallback for cross-process descendants, so a
	// detached emitter's events still key the correct root-run sink.
	const busFrame: DepthFrame | undefined = resolveBusFrame();
	const busAgentDir = fctx.agentDir;
	const emitBusEvent = (kind: BusEventKind, fields?: Record<string, unknown>): void => {
		if (!busFrame) return;
		appendBusEvent({ agentDir: busAgentDir, frame: busFrame }, { kind, fields });
	};
	// Liveness window for the descendant probe: one heartbeat interval. A
	// descendant event within the last interval means the subtree is alive.
	// Computed from the per-fork override (falling back to the 3-min
	// production default) ahead of channel construction so the probe closure
	// doesn't self-reference the channel.
	const busLivenessWindowMs =
		req.heartbeatIntervalMs !== undefined &&
		Number.isFinite(req.heartbeatIntervalMs) &&
		req.heartbeatIntervalMs > 0
			? req.heartbeatIntervalMs
			: 180_000;
	const rootRunId = busFrame?.rootRunId ?? fctx.runId ?? req.name;
	const escalationEnabled = req.escalationPolicy?.enabled === true;
	if (escalationEnabled && !busFrame) {
		throw new Error("escalation-enabled supervised worker requires a live lineage frame");
	}
	const escalationLineagePath = busFrame ? lineagePath(busFrame) : `${rootRunId}/${fctx.runId ?? req.name}#${fctx.childIndex ?? 0}`;
	const supervisorEscalationHolderId = buildSupervisorEscalationHolderId(escalationLineagePath);
	const escalationParticipants = escalationEnabled
		? buildSupervisedEscalationParticipants({
			rootRunId,
			lineagePath: escalationLineagePath,
			supervisorConfig: req.escalationPolicy!.config,
			originatorConfig: fctx.originatorEscalationConfig ?? req.escalationPolicy!.config,
			supervisorLabel: `supervisor for ${req.name}`,
		})
		: [];
	const escalationCredential = (): { capToken: string } => {
		const capToken = currentLineageEnv()?.[LINEAGE_ENV.CAP_TOKEN];
		if (!capToken) throw new Error("escalation-enabled worker lacks a lineage capability token");
		return { capToken };
	};
	const pendingSupervisorEscalationIds = (): string[] => escalationEnabled
		? listMailbox({
			agentDir: fctx.agentDir,
			rootRunId,
			holderId: supervisorEscalationHolderId,
		}).map((entry) => entry.requestId)
		: [];

	type WorkerAttempt = {
		generation: number;
		loader: DefaultResourceLoader;
		nestedDelegatePolicy?: NestedDelegateCallerPolicy;
		session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		channel: WorkerChannel;
		channelRef: { current?: WorkerChannel };
		renewChannel: () => WorkerChannel;
		unsubscribe: () => void;
		unsubscribed: boolean;
		cancelled: boolean;
		retiring: boolean;
		disposed: boolean;
		/** Prompt sent for the current worker turn, for transient retry diagnostics. */
		promptText?: string;
		/** The awaitReply promise for the currently active prompt. */
		promptResult?: Promise<WorkerCallResult>;
		/** Exactly-once post-processing for duplicate waiters on that prompt. */
		promptConsumption?: {
			source: Promise<WorkerCallResult>;
			result: Promise<unknown>;
		};
	};
	let workerAttempt: WorkerAttempt | undefined;
	let nextAttemptGeneration = 0;
	let transitionTail: Promise<void> = Promise.resolve();
	let teardownStarted = false;
	let finishRequested = false;
	const injectedBoundaries = new Set<WorkerAttemptBoundary>();
	const attemptBoundary = (
		phase: WorkerAttemptLifecycleEvent["phase"],
		boundary: WorkerAttemptBoundary,
		generation?: number,
	): void => {
		fctx.workerAttemptLifecycle?.onEvent?.({ phase, boundary, generation });
		if (
			phase === "acquired" &&
			fctx.workerAttemptLifecycle?.failAfter === boundary &&
			!injectedBoundaries.has(boundary)
		) {
			injectedBoundaries.add(boundary);
			throw new Error(`injected worker-attempt fault after ${boundary}`);
		}
	};
	const attemptOperation = (
		operation: WorkerAttemptLifecycleOperation,
		phase: "acquired" | "released",
		generation?: number,
	): void => {
		fctx.workerAttemptLifecycle?.onOperation?.({ operation, phase, generation });
		if (fctx.workerAttemptLifecycle?.throwOnOperation === operation) {
			throw new Error(`injected lifecycle operation failure after ${operation}`);
		}
	};
	// A per-fork gate serializes ownership publication and retirement. Prompt
	// waits deliberately happen outside the gate; their completion re-enters
	// with the captured generation so a replacement cannot process stale data.
	const withWorkerTransition = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		const predecessor = transitionTail;
		let release!: () => void;
		transitionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
		}
	};
	const activeAttempt = (): WorkerAttempt => {
		if (!workerAttempt) throw new Error("Worker attempt not initialised");
		return workerAttempt;
	};
	const unsubscribeAttempt = (attempt: WorkerAttempt): void => {
		if (attempt.unsubscribed) return;
		attempt.unsubscribed = true;
		try {
			attempt.unsubscribe();
			attemptOperation("unsubscribe", "released", attempt.generation);
		} catch {
			/* exact-once cleanup is best effort at the SDK boundary */
		}
		try { attemptBoundary("released", "subscription", attempt.generation); } catch { /* diagnostics only */ }
	};
	const disposeAttempt = (attempt: WorkerAttempt): Promise<void> => withWorkerEnv(async () => {
		if (attempt.disposed) return;
		attempt.disposed = true;
		try {
			unsubscribeAttempt(attempt);
			try {
				await disposeWorkerSession(attempt.session, attempt.nestedDelegatePolicy);
			} catch {
				// Session disposal owns runtime invalidation. If the SDK throws before
				// doing so, invalidate the loader runtime as the partial-attempt fallback.
				try {
					invalidateFailedWorkerRuntime(attempt.loader, () => attemptOperation("runtime-invalidate", "released", attempt.generation));
				} catch {
					/* final teardown must continue even when invalidation itself throws */
				}
			}
			// A real dispose throw still acquired the session resource; record its
			// release exactly once, without allowing an injected observer failure to
			// replace the original teardown/construction error.
			try { attemptOperation("session-dispose", "released", attempt.generation); } catch { /* diagnostics only */ }
		} finally {
			try { attemptBoundary("released", "extension-binding", attempt.generation); } catch { /* diagnostics only */ }
			try { attemptBoundary("released", "preparation", attempt.generation); } catch { /* diagnostics only */ }
			try { attemptBoundary("released", "channel", attempt.generation); } catch { /* diagnostics only */ }
			try { attemptBoundary("released", "session", attempt.generation); } catch { /* diagnostics only */ }
			try { attemptOperation("final-teardown", "released", attempt.generation); } catch { /* diagnostics only */ }
			try { attemptBoundary("released", "final-teardown", attempt.generation); } catch { /* diagnostics only */ }
		}
	});
	const abortAttemptAndWait = async (attempt: WorkerAttempt, reason: CancelReason): Promise<void> =>
		withWorkerEnv(async () => {
			if (attempt.cancelled) {
				await attempt.channel.waitForSettlement();
				return;
			}
			attempt.cancelled = true;
			let failure: unknown;
			try {
				await attempt.channel.abort(reason);
				attemptOperation("channel-abort", "released", attempt.generation);
				await attempt.channel.waitForSettlement();
				attemptOperation("channel-settlement", "released", attempt.generation);
				attemptBoundary("acquired", "cancellation", attempt.generation);
			} catch (error) {
				failure = error;
				try {
					await attempt.channel.waitForSettlement();
					attemptOperation("channel-settlement", "released", attempt.generation);
				} catch { /* preserve first failure */ }
			}
			try { attemptBoundary("released", "cancellation", attempt.generation); } catch { /* diagnostics only */ }
			if (failure) throw failure;
		});
	const isCurrentAttempt = async (attempt: WorkerAttempt): Promise<boolean> =>
		withWorkerTransition(() => workerAttempt === attempt && workerAttempt?.generation === attempt.generation && !attempt.retiring && !teardownStarted);
	let cloneSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let unsubscribeCloneActivity: (() => void) | undefined;
	let finishPayload: { final_output?: string; summary?: string } | undefined;
	let lastWorkerText = "";
	// #452: captured completed first exchange for direct-first-turn seeding.
	let directFirstTurnExchange: DirectFirstTurnExchange | undefined;
	let workerSessionPath: string | undefined;
	let workerModelRef: string | undefined;
	let attemptedModels: string[] | undefined;
	let currentWorkerModel: WorkerModelChoice["model"] | undefined;
	const plannedModels = planWorkerModelRequests(fctx.modelRegistry, [req], {
		mainModel: fctx.mainModel,
		scope: fctx.scopedModelRefs,
	});
	const modelCursor = plannedModels.kind === "planned"
		? new WorkerModelCursor(plannedModels.requests[0]!.modelPlan)
		: undefined;
	/**
	 * Whether `error` justifies replacing the worker attempt on another route.
	 *
	 * Ordinary transient failures may replace across the whole ladder. Capacity
	 * failures advance that same ladder only through the in-session continuation
	 * path below, so they are deliberately excluded here. An auth-class failure
	 * may replace only within the current rung, to another account serving the
	 * same model; it never reaches fallbackModels, and it stops once that rung's
	 * accounts run out so a genuinely broken credential is still reported.
	 */
	const shouldReplaceAttemptForRoute = (error: string): boolean =>
		!isCredentialStoreLockErrorMessage(error) &&
		!isCapacityFailureMessage(error) &&
		(shouldAdvanceLadderForRouteFailure(error, modelCursor, req.agent) ||
			(isRouteAuthFailureMessage(error) && hasSameModelRouteAlternative(modelCursor)));
	const credentialAbortError = (): Error => {
		const error = new Error("Credential retry cancelled");
		error.name = "AbortError";
		return error;
	};
	const waitForLockRetry = (): Promise<boolean> => waitForCredentialStoreLockRetry(
		credentialRetryBudget,
		fctx.signal,
		(delayMs) => logDelegateDiagnostic(
			`credential-store lock retry scheduled delayMs=${delayMs}`,
			{ agentDir: fctx.agentDir, level: "warn" },
		),
	);
	const raceAgainstCredentialCancellation = async <T>(operation: Promise<T>): Promise<T> => {
		let abortListener: (() => void) | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<T>((_, reject) => {
					abortListener = () => reject(credentialAbortError());
					if (fctx.signal?.aborted) abortListener();
					else fctx.signal?.addEventListener("abort", abortListener, { once: true });
				}),
			]);
		} finally {
			if (abortListener) fctx.signal?.removeEventListener("abort", abortListener);
		}
	};
	const runWithinCredentialDeadline = async <T>(
		operation: () => Promise<T>,
		onDeadline?: () => void,
	): Promise<T> => {
		const remainingMs = credentialRetryRemainingMs(credentialRetryBudget);
		if (remainingMs <= 0) throw new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE);
		let deadlineTimer: unknown;
		let deadlineScheduled = false;
		try {
			return await Promise.race([
				raceAgainstCredentialCancellation(operation()),
				new Promise<T>((_, reject) => {
					deadlineTimer = credentialRetryBudget.clock.setTimeout(() => {
						onDeadline?.();
						reject(new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE));
					}, remainingMs);
					deadlineScheduled = true;
				}),
			]);
		} finally {
			if (deadlineScheduled) credentialRetryBudget.clock.clearTimeout(deadlineTimer);
		}
	};
	const refreshCurrentProviderFor401 = async (): Promise<boolean> => {
		if (credentialRetryBudget.authRetryConsumed) return false;
		credentialRetryBudget.authRetryConsumed = true;
		const providerId = currentWorkerModel?.provider;
		const readProviderAuth = providerAuthReader(fctx.modelRegistry);
		if (!readProviderAuth) return false;
		try {
			let refreshed: Awaited<ReturnType<typeof readProviderAuth>>;
			try {
				refreshed = await raceAgainstCredentialCancellation(readProviderAuth(providerId ?? ""));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!isCredentialStoreLockErrorMessage(message)) throw error;
				if (!(await waitForLockRetry())) return false;
				refreshed = await runWithinCredentialDeadline(() => readProviderAuth(providerId ?? ""));
			}
			if (refreshed === undefined) {
				logDelegateDiagnostic(
					`credential refresh unavailable provider=${sanitizedProviderId(providerId)}`,
					{ agentDir: fctx.agentDir, level: "warn" },
				);
				return false;
			}
			logDelegateDiagnostic(
				`credential refresh completed provider=${sanitizedProviderId(providerId)}`,
				{ agentDir: fctx.agentDir, level: "log" },
			);
			return true;
		} catch (error) {
			if (fctx.signal?.aborted) throw error;
			logDelegateDiagnostic(
				`credential refresh failed provider=${sanitizedProviderId(providerId)}`,
				{ agentDir: fctx.agentDir, level: "warn" },
			);
			return false;
		}
	};
	const refusalModels: string[] = [];
	let workerThinkingLevel: string | undefined;
	// Worker tool-harness guard flag: set inside `message_subagent.execute`
	// when the worker emits narrated tool calls with zero real `toolCall`
	// blocks. We can't throw from inside the tool body (pi-agent-core catches
	// tool errors and turns them into toolResult/isError), so instead we
	// abort the clone and route to the harness-failure early return below.
	let workerHarnessFailure = false;
	// Count real worker tool calls across the whole fork, not just the most
	// recently consumed round. A later prose report may quote commands in
	// fenced blocks after the worker has already demonstrated that its tool
	// harness works.
	let cumulativeWorkerToolUses = 0;
	// Set when WorkerChannel observes a terminal assistant/provider error in
	// the worker transcript (for example stopReason="error" + errorMessage).
	// The supervisor gets a readable tool result, but final collapse must still
	// report the fork as failed rather than letting finish_delegation hide it.
	let workerTerminalFailure = false;
	// A cancellation-only harvest is a non-terminal signal for the supervisor:
	// the channel stays usable so it can steer or retry. If the supervisor ends
	// the fork without a substantive worker turn afterwards, preserve #115's
	// terminal failure semantics at final collapse.
	let workerCancellationOnly = false;
	let workerReplacementFailure = false;
	// B.2 — set by `handleWorkerCallResult` when the worker channel auto-
	// escalates to `{ kind: 'aborted', reason: 'heartbeat' }`. The supervisor
	// still gets the aborted tool result and typically replies with
	// `finish_delegation` — but regardless of what they put in the payload,
	// the fork as a whole must be reported as `status: 'aborted'` with
	// `cancelReason: 'heartbeat'` so operators can tell apart
	// "supervisor chose to finish" from "worker ran away and we killed it".
	let workerHeartbeatAborted = false;
	// Set when a prompt aborts after request-scoped assistant output finalized.
	// The supervisor may inspect that output and call finish_delegation, but the
	// recovered deliverable and terminal aborted status must survive collapse.
	let workerRecoveredAbort = false;
	// A wall-clock timeout is terminal even if the clone reaches
	// finish_delegation in the same turn as the abort callback. This latch is
	// checked after transcript capture so timeout provenance wins without
	// discarding live observations.
	let timeoutAbortObserved = false;
	// B.3 — set by `cancel_worker` when the supervisor explicitly terminates
	// the worker mid-fork. Parallel to `workerHeartbeatAborted`: the final
	// collapse path uses this to preserve `status:"aborted"` +
	// `cancelReason:"supervisor"` even if the supervisor then calls
	// `finish_delegation({final_output})` — otherwise the `effectiveCollapse`
	// branch would overwrite status back to `"completed"`.
	let workerCancelled = false;
	// Spec 0019 follow-up (paused false-positive fix) — set TRUE the moment a
	// round-refusal is actually issued to the supervisor (`message_subagent` or
	// `restart_worker` returning the "max rounds reached, call finish_delegation"
	// result). This is the precise FORCED-finish signal: a supervisor that uses
	// exactly `max_rounds` rounds and then finishes VOLUNTARILY (never asking
	// for another round) genuinely completed and must stay "completed"; only a
	// supervisor that tried to continue and was refused is "paused". The old
	// detection (`roundsUsed >= maxRounds` alone) branded the former case
	// paused — a boundary false positive.
	let roundRefusalIssued = false;

	const nextWorkerModel = (): WorkerModelChoice | undefined => {
		const choice = plannedModels.kind === "planned" ? modelCursor!.next() : undefined;
		attemptedModels = plannedModels.kind === "planned"
			? [...modelCursor!.attemptedRefs]
			: [...plannedModels.failure.attemptedRefs];
		return choice;
	};

	const recordRefusal = (modelRef: string | undefined): void => {
		if (!modelRef) return;
		if (!refusalModels.includes(modelRef)) {
			refusalModels.push(modelRef);
		}
		result.refusalModels = [...refusalModels];
	};

	const markNoModelAlternative = (error: string): string => {
		result.errorKind = "no-model-alternative";
		return formatNoModelAlternative(error, attemptedModels?.length ?? 0);
	};

	const resolveInitialWorkerModel = (): void => {
		const choice = nextWorkerModel();
		if (!choice) {
			throw new Error(
				plannedModels.kind === "planned"
					? workerModelFailureMessage(req.agent.name, attemptedModels ?? [], fctx.scopedModelRefs)
					: plannedModels.failure.message,
			);
		}
		currentWorkerModel = choice.model;
		workerModelRef = choice.canonicalRef;
	};

	const buildWorkerTranscript = (): TranscriptEntry[] => {
		capturePromptRepairs(workerSessionMgr?.getEntries?.() ?? []);
		const workerEntries: TranscriptEntry[] = [];
		for (const prior of result.priorWorkerSessions ?? []) {
			workerEntries.push(...messagesToTranscript(
				"worker",
				prior.messagesSnapshot.map((message) => sanitizeForkCredentialMessage(message, currentWorkerModel?.provider)),
			));
			const boundaryText = prior.retirementReason === "refusal-fallback"
				? `--- worker session retired after model refusal; fallback retried with: ${prior.restartMessage} ---`
				: prior.retirementReason === "transient-fallback"
					? `--- worker session retired after transient failure; fallback retried with: ${prior.restartMessage} ---`
					: `--- worker session retired; restart_worker called with: ${prior.restartMessage} ---`;
			workerEntries.push({
				source: "worker",
				role: "system",
				text: boundaryText,
				timestamp: prior.endedAt,
			});
		}
		if (workerAttempt && !workerAttempt.disposed) {
			workerEntries.push(...messagesToTranscript(
				"worker",
				(workerAttempt.session.messages as AgentMessage[]).map((message) =>
					sanitizeForkCredentialMessage(message, currentWorkerModel?.provider)),
			));
		}
		return [
			...(cloneSession ? messagesToTranscript("supervisor", cloneSession.messages as AgentMessage[]) : []),
			...workerEntries,
			...promptRepairTranscriptEntries(result.promptRepairs ?? []),
		];
	};

	const emit = (patch: Partial<RunUpdate>) => {
		if (fctx.onRuntimeUpdate) {
			// Feed the runtime patcher. `name` and `maxRounds` are stable so the
			// runtime gets only the fields that actually changed this tick plus
			// the live rolling status/round counters.
			const runtimePatch: Partial<RunLiveState> = {
				status: result.status,
				currentRound: result.roundsUsed,
				lastWorkerText,
				workerSessionFile: result.workerSessionFile,
				cost: result.usage.cost,
				usage: { ...result.usage },
			};
			if (patch.lastSupervisorText !== undefined) runtimePatch.lastSupervisorText = patch.lastSupervisorText;
			if (patch.lastWorkerText !== undefined) runtimePatch.lastWorkerText = patch.lastWorkerText;
			if (patch.workerSessionFile !== undefined) runtimePatch.workerSessionFile = patch.workerSessionFile;
			if (patch.status !== undefined) runtimePatch.status = patch.status;
			if (patch.error !== undefined) runtimePatch.error = patch.error;
			if (patch.errorKind !== undefined) runtimePatch.errorKind = patch.errorKind;
			if (patch.failureCause !== undefined) runtimePatch.failureCause = patch.failureCause;
			if (patch.refusalModels !== undefined) runtimePatch.refusalModels = patch.refusalModels;
			if (patch.taskProgress !== undefined) runtimePatch.taskProgress = patch.taskProgress;
			if (result.errorKind !== undefined) runtimePatch.errorKind = result.errorKind;
			if (result.failureCause !== undefined) runtimePatch.failureCause = result.failureCause;
			if (result.refusalModels !== undefined) runtimePatch.refusalModels = result.refusalModels;
			fctx.onRuntimeUpdate(runtimePatch);
		}
		if (fctx.onUpdate) {
			fctx.onUpdate({
				name: req.name,
				status: result.status,
				currentRound: result.roundsUsed,
				maxRounds: req.maxRounds,
				lastWorkerText,
				workerSessionFile: result.workerSessionFile,
				...patch,
				errorKind: patch.errorKind ?? result.errorKind,
				failureCause: patch.failureCause ?? result.failureCause,
			});
		}
	};

	// Append one entry to the run-history jsonl for every fork exit path
	// (clean completion, thrown error, abort). Runs in the outer `finally`
	// below so thrown errors still get recorded before propagating.
	const reportRecordingFailure = (error: unknown): void => {
		if (!(error instanceof StateLockTimeoutError)) throw error;
		const diagnostic = `recording failed: ${error.message}`;
		result.error = result.error ? `${result.error}; ${diagnostic}` : diagnostic;
	};
	const finalizeAndRecord = (): void => {
		retainTranscriptPolicyRefusals(result, req.readOnly);
		// Same contract as the direct runner (#536): a refused write means the
		// worker's own success claim may be false, so the result says so rather than
		// leaving a caller to trust the narration. A supervised run recorded the
		// refusal but derived no warning at all before this.
		const refusedWrite = refusedWriteWarning(result.policyRefusals);
		if (refusedWrite) result.warnings = [...(result.warnings ?? []), refusedWrite];
		// SessionManager creates the worker JSONL lazily on the first prompt, so
		// re-check the path at terminal publication time as well as at startup.
		result.workerSessionFile = existingWorkerSessionFile(workerSessionPath);
		result.inputDigests = result.transcript
			.filter((entry) => entry.source === "worker" && entry.role === "user")
			.map((entry, sequence) => ({
				sequence,
				algorithm: "sha256" as const,
				digest: createHash("sha256").update(entry.text, "utf8").digest("hex"),
			}));
		// Event-bus `completed` (spec 0004 / REQ-BUS-1): terminal liveness
		// event for THIS fork, emitted once on the outermost finally so every
		// exit path (clean, failed, aborted) records the fork finishing.
		// A lock timeout stays visible on the result without changing the worker's
		// status or deliverable; other finalization errors remain loud.
		// Spec 0019 / REQ-PAUSE-4 — detached/cross-process visibility (the
		// hypha/ant case): a paused fork carries `status:"paused"` AND a
		// `kind:"paused"` marker on this terminal bus event, mirroring how a
		// steered terminal is surfaced via `fields.kind`. run-introspect's
		// `busHasPausedTerminal` reads this marker to produce the
		// `terminal-paused` uniform state for a detached parent.
		// Issue #226 — settle the checklist before the terminal event, so the
		// collapsed result carries a mechanical verdict rather than leaving a
		// caller to infer completion from the worker's prose.
		try {
			const ledger = buildTaskLedger(readSeededTasks(workerSessionMgr?.getEntries?.() ?? []));
			if (ledger) result.taskLedger = ledger;
		} catch (error) {
			reportRecordingFailure(error);
		}
		try {
			emitBusEvent("completed", {
				status: result.status,
				...(result.status === "paused" ? { kind: "paused" } : {}),
			});
		} catch (error) {
			reportRecordingFailure(error);
		}
		const finishedAt = new Date().toISOString();
		const durationMs = Date.now() - startMs;
		const kind: "final_output" | "summary" | null =
			result.supervisorFinishPayload?.final_output ? "final_output"
			: result.supervisorFinishPayload?.summary ? "summary"
			: null;
		const status: RunHistoryEntry["status"] =
			(result.status === "completed" || result.status === "failed" || result.status === "aborted" || result.status === "paused")
				? result.status
				: "failed"; // defensive: pending/running shouldn't leak, treat as failed
		try {
			recordRun(fctx.agentDir, {
				ts: finishedAt,
				tsSec: Math.floor(Date.now() / 1000),
				runId: fctx.runId,
				rootRunId,
				ownerSessionId: fctx.ownerSessionId,
				forkName: req.name,
				attempt: result.attempt ?? req.attempt ?? 1,
				...(req.retryOf !== undefined ? { retryOf: req.retryOf } : {}),
			...(req.displayLabel !== undefined ? { displayLabel: req.displayLabel } : {}),
				agent: req.agent.name,
				agentSource: req.agent.source,
				workerModel: workerModelRef,
				attemptedModels,
				workerThinking: workerThinkingLevel,
				summaryModel: result.summaryModelUsed,
				cwd: fctx.cwd,
				workerSessionFile: result.workerSessionFile,
				status,
				cancelReason: status === "aborted" ? result.cancelReason : undefined,
				errorMessage: result.error,
				errorKind: result.errorKind,
				refusalModels: result.refusalModels,
				roundsUsed: result.roundsUsed,
				maxRounds: result.maxRounds,
				collapseMode: result.collapseMode,
				supervisorFinishKind: kind,
				summaryFallbackReason: result.summaryFallbackReason,
				startedAt,
				finishedAt,
				durationMs,
				usage: { ...result.usage },
				taskPreview: req.task.slice(0, 200),
			});
		} catch (error) {
			reportRecordingFailure(error);
		}
	};
	const applyTimeoutSalvage = (): void => {
		timeoutAbortObserved = true;
		result.status = "aborted";
		result.cancelReason = "timeout";
		result.error = result.error ?? "Fork aborted (timeout)";
		// Select the checkpoint from the complete live transcript before tailing it
		// to the bounded result. A long tool tail must not hide earlier assistant work.
		const completeTranscript = result.transcript.length === 0
			? buildWorkerTranscript()
			: result.transcript;
		const timeoutCollapse = buildRunTimeoutCollapse(completeTranscript);
		result.transcript = boundRunTimeoutTranscript(completeTranscript);
		result.collapsedContent = timeoutCollapse.content;
		// Do not let an earlier branch claim recovered output without an assistant
		// checkpoint in the timeout snapshot.
		result.recoveredOutput = timeoutCollapse.recoveredOutput;
		// Bound supervisor payloads, prior worker messages, and any direct harvest
		// extension before the result reaches runtime projection or persistence.
		Object.assign(result, projectRunResult(result));
	};
	const timeoutResultIfObserved = (): RunResult | undefined => {
		if (!timeoutAbortObserved && !(fctx.signal?.aborted && fctx.getCancelReason?.() === "timeout")) return undefined;
		applyTimeoutSalvage();
		return result;
	};
	const markAborted = (error: string, collapsedContent?: string): void => {
		const reason = fctx.getCancelReason?.() ?? "user";
		result.status = "aborted";
		result.cancelReason = reason;
		result.error = error;
		if (reason === "timeout") applyTimeoutSalvage();
		else if (collapsedContent !== undefined) result.collapsedContent = collapsedContent;
		emit({ status: "aborted", error: result.error });
	};

	if (fctx.signal?.aborted) {
		markAborted("aborted before fork construction");
		finalizeAndRecord();
		return result;
	}

	try {
		try {
		// ── 1. Worker session (file-backed, real tools) ────────────────────────
		withWorkerEnv(resolveInitialWorkerModel);

		// MCP direct tools from the agent's `tools: mcp:*` entries are not
		// currently plumbable through createAgentSession — pi-subagents uses an
		// env var to a child `pi` CLI process, a mechanism that doesn't apply to
		// in-process sessions. Warn once per fork so the ignore is visible.
		// TODO: plumb mcpDirectTools when pi-coding-agent exposes MCP tool hand-off.
		if (req.agent.mcpDirectTools && req.agent.mcpDirectTools.length > 0) {
			logDelegateDiagnostic(
				`agent "${req.agent.name}": mcpDirectTools ` +
					`[${req.agent.mcpDirectTools.join(", ")}] are not supported by the ` +
					"in-process createAgentSession API and will be ignored.",
				{ agentDir: fctx.agentDir },
			);
		}

		// Plain-worker tool surface: although this worker sits beneath a
		// supervisor clone, it has the same capability contract as a top-level
		// direct worker. Delegate-only mode replaces nested delegation with
		// steering-only control actions for supervised workers.
		const workerSurface = resolveDelegateOnlySteeringSurface(resolveWorkerToolSurface(req.agent, {
			escalationPolicy: req.escalationPolicy,
			readOnly: req.readOnly,
			...(req.parentTranscriptSearch ? { customToolNames: [PARENT_TRANSCRIPT_SEARCH_TOOL_NAME] } : {}),
		}));
		const releaseWorkerToolRegistration = fctx.ensureWorkerToolRegistration?.(workerSurface.tools ?? []);
		for (const d of workerSurface.diagnostics)
			logDelegateDiagnostic(d, { agentDir: fctx.agentDir, throttleKey: "tool-surface" });
		if (fctx.signal?.aborted) throw new Error("aborted before fork construction");

		const workerSessionDir = buildWorkerSessionDir(fctx.agentDir);
		const thinkingLevel = resolveThinkingLevel(req.agent.thinking, req.agent.name);
		workerThinkingLevel = thinkingLevel;

		// Commit B.3 — Factory for a complete worker attempt. Every invocation
		// prepares a fresh loader/runtime, executes the extension factories again,
		// and creates a fresh session manager, session file, AgentSession, channel,
		// and transcript subscription. Nothing loader-dependent is copied from a
		// predecessor: the Pi loader binds one runtime to one AgentSession and
		// disposing that session invalidates its captured extension APIs. That
		// binding was verified against the SDK version pinned when this isolation
		// was written. package.json now pins 0.80.6 with peer support for 0.80.6
		// and 0.83.0; the per-attempt preparation below is retained as a defensive
		// invariant, not as a claim re-verified against those versions.
		//
		// The transcript subscription is attached here (not inline below) so
		// each build owns its own unsubscribe fn; restart_worker calls the
		// previous unsubscribe before replacing. The subscribe callback
		// captures the locally-resolved `channel` — NOT the outer
		// `let workerChannel` — so a concurrent mid-swap cannot mis-route
		// notifyActivity events onto the new channel.
		//
		// `tools` is a `string[]` tool-name allowlist (sdk.d.ts):
		//   tools?: string[]  — "Optional allowlist of tool names."
		// When omitted (undefined), pi enables the default built-ins
		// [read, bash, edit, write]. DO NOT pass Tool[] here — the older
		// fork-runner did, which caused every worker to resolve zero tools
		// (Set<Tool>.has("read") is always false) and fail with
		// "Tool X not found" on the first real tool call.
		const buildWorkerSessionAndChannel = async (): Promise<{
			loader: DefaultResourceLoader;
			nestedDelegatePolicy?: NestedDelegateCallerPolicy;
			session: AgentSession;
			channel: WorkerChannel;
			channelRef: { current?: WorkerChannel };
			renewChannel: () => WorkerChannel;
			unsubscribe: () => void;
		}> => {
			if (!currentWorkerModel) {
				throw new Error("Worker model not initialised");
			}
			const workerModel = currentWorkerModel;
			const activityGeneration = nextAttemptGeneration + 1;
			// Raise tools are built before WorkerChannel. The indirection is the
			// §2.4 hold-open seam: execute resolves the live channel after session
			// construction, and every restart receives a fresh ref + tool set.
			const channelRef: { current?: WorkerChannel } = {};
			const escalationActivityChannel = {
				enterAwaitingEscalation: (awaiting: Parameters<WorkerChannel["enterAwaitingEscalation"]>[0]) => {
					if (!channelRef.current) throw new Error("Worker channel not initialised");
					channelRef.current.enterAwaitingEscalation(awaiting);
					if (workerAttempt?.generation !== activityGeneration) return;
					actorActivity?.publish("worker", { phase: "awaiting-escalation" });
					fctx.onRuntimeUpdate?.({ status: "awaiting-escalation" });
				},
				resolveAwaitingEscalation: () => {
					if (!channelRef.current) throw new Error("Worker channel not initialised");
					channelRef.current.resolveAwaitingEscalation();
					if (
						workerAttempt?.generation !== activityGeneration ||
						teardownStarted ||
						fctx.signal?.aborted ||
						result.status !== "running"
					) return;
					actorActivity?.publish("worker", { phase: "waiting-model" });
					fctx.onRuntimeUpdate?.({ status: "running" });
				},
			};
			const workerCustomTools = escalationEnabled
				? makeEscalationRaiseTools({
					sessionFile: () => workerSessionPath,
					sessionId: () => workerAttempt?.session.sessionId,
					agentDir: fctx.agentDir,
					rootRunId,
					runId: busFrame!.runId,
					lineagePath: escalationLineagePath,
					raiserLabel: req.name,
					participants: escalationParticipants,
					config: req.escalationPolicy!.config,
					credential: escalationCredential,
					ownerSessionId: fctx.ownerSessionId ?? rootRunId,
					workerChannel: escalationActivityChannel,
				})
				: undefined;
			// SessionManager is stateful (one manager owns one session file), so
			// every build gets its OWN manager pointed at the same sessions-forks
			// directory. Reusing a single manager across builds collapses both
			// sessions onto the same jsonl path and defeats the whole point of
			// `restart_worker`.
			const writeConfinement = resolveWorkerWriteAuthority({
				name: req.name,
				cwd: fctx.cwd,
				agentDir: fctx.agentDir,
				confineWrites: req.confineWrites,
				writableRoots: req.writableRoots,
				scratchRoot: req.scratchRoot,
				readOnly: req.readOnly,
				onRefusal: (refusal) => {
					if (policyRefusals.length < 32) policyRefusals.push({ ...refusal, reason: refusal.reason.slice(0, 1000) });
				},
			});
			const workerSettingsManager = createIsolatedWorkerSettingsManager(fctx.cwd, fctx.agentDir);
			const preparedResources = await prepareWorkerSessionResources(
				req.agent,
				{
					cwd: fctx.cwd,
					agentDir: fctx.agentDir,
					settingsManager: workerSettingsManager,
					extraInstructions: [
						...escalationWorkerInstructions(escalationEnabled),
						...(req.scratchRoot
							? [workerWriteScopeInstruction({ scratchRoot: req.scratchRoot, policy: writeConfinement })]
							: []),
					],
					confinement: writeConfinement,
					...(req.parentTranscriptSearch ? { workerGrantedToolNames: [PARENT_TRANSCRIPT_SEARCH_TOOL_NAME] } : {}),
				},
				workerSurface,
				() => attemptOperation("runtime-invalidate", "released"),
			);
			const workerLoader = preparedResources.loader;
			// The worker's own extension set decides the final surface, so everything
			// below reports and registers from the amended one (#338).
			const effectiveSurface = preparedResources.surface;
			// Worker `ask` safety (issue #75). Every statement between a successful
			// `prepareWorkerSessionResources` and session construction owns the live
			// worker runtime, so a throw here must invalidate it rather than strand it.
			let workerAskTool: ReturnType<typeof makeWorkerAskRoutingTool>;
			try {
				workerAskTool = makeWorkerAskRoutingTool(escalationEnabled
					? {
						enabled: true,
						raiseDeps: {
							agentDir: fctx.agentDir,
							rootRunId,
							runId: busFrame!.runId,
							lineagePath: escalationLineagePath,
							raiserLabel: req.name,
							participants: escalationParticipants,
							config: req.escalationPolicy!.config,
							credential: escalationCredential,
							ownerSessionId: fctx.ownerSessionId ?? rootRunId,
							sessionFile: () => workerSessionPath,
							sessionId: () => workerAttempt?.session.sessionId,
							workerChannel: escalationActivityChannel,
						},
					}
					: { enabled: false });
				reconcileWorkerAskSurface({
					tools: effectiveSurface.tools,
					replaced: replaceLoadedAskTools(workerLoader, workerAskTool),
					onDiagnostic: (message) => logDelegateDiagnostic(message, { agentDir: fctx.agentDir, throttleKey: "tool-surface" }),
				});
			} catch (error) {
				try { invalidateFailedWorkerRuntime(workerLoader, () => attemptOperation("runtime-invalidate", "released")); } catch { /* preserve ask-surface failure */ }
				throw error;
			}
			try {
				attemptOperation("preparation", "acquired");
			} catch (error) {
				try { invalidateFailedWorkerRuntime(workerLoader, () => attemptOperation("runtime-invalidate", "released")); } catch { /* preserve acquisition failure */ }
				throw error;
			}
			const workerToolScope = preparedResources.toolScope;
			const seedUsableToolNames = usableToolNamesFromScope(workerToolScope);
			const selectedExtensionMayProvideAsk = workerSurface.extSelectors.some(
				(selector) => selector.tool === undefined || selector.tool === ASK_TOOL_NAME,
			);
			const workerSessionCustomTools = [
				...(fctx.getWorkerToolDefinitions?.(effectiveSurface.tools ?? []) ?? []),
				...(workerCustomTools ?? []),
				...(selectedExtensionMayProvideAsk ? [workerAskTool] : []),
			];
			const thinkingPolicyContext = preparedResources.thinkingPolicyContext;
			const workerEventBus = preparedResources.eventBus;
			let session!: AgentSession;
			let nestedDelegatePolicy: NestedDelegateCallerPolicy | undefined;
			let sessionAcquired = false;
			let channel: WorkerChannel | undefined;
			let unsubscribe: (() => void) | undefined;
			let unsubscribeToolScope: (() => void) | undefined;
			let unsubscribePromptRepairActivity: (() => void) | undefined;
			try {
				attemptBoundary("acquired", "preparation");
				const sessionMgr = SessionManager.create(fctx.cwd, workerSessionDir);
				workerSessionMgr = sessionMgr as unknown as { getEntries?: () => unknown[] };
				if (req.parentTranscriptSearch) registerParentTranscriptSnapshot(sessionMgr, fctx.mainBranchEntries);
				const workerSeedAudit = applyWorkerSeeds(sessionMgr, {
					origin: { ownerSessionId: fctx.ownerSessionId, runId: fctx.runId, forkName: req.name, agent: req.agent.name },
					thinkingPolicy: thinkingPolicyContext?.policy,
					promptRepair: buildPromptRepairDelegateSeed(nextAttemptGeneration === 0),
					extensions: workerLoader.getExtensions().extensions,
					// From the live scope, not the requested surface: an ext: selector
					// grants tools that never appear in surface.tools (#338 review).
					...(seedUsableToolNames ? { usableToolNames: seedUsableToolNames } : {}),
					...(req.tasks ? { tasks: { seed: req.tasks, options: { piSessionId: fctx.runId } } } : {}),
					...(req.focus ? {
						focus: {
							value: req.focus,
							options: {
								cwd: fctx.cwd,
								writableRoots: req.writableRoots,
								confineWrites: req.confineWrites,
								parentPiSessionId: fctx.ownerSessionId,
							},
						},
					} : {}),
				});
				logDelegateDiagnostic(formatWorkerSeedAudit(workerSeedAudit), { agentDir: fctx.agentDir });
				const strippedClaimant = formatStrippedClaimantWarning(workerSeedAudit, {
					extensions: workerLoader.getExtensions().extensions,
					// From the live scope, not the requested surface: an ext: selector
					// grants tools that never appear in surface.tools (#338 review).
					...(seedUsableToolNames ? { usableToolNames: seedUsableToolNames } : {}),
				});
				if (strippedClaimant) logDelegateDiagnostic(strippedClaimant, { agentDir: fctx.agentDir });
				tasksSeedable = !isWorkerSeedPromptFallback(workerSeedAudit, "tasks");
				focusSeedable = !isWorkerSeedPromptFallback(workerSeedAudit, "focus");
				const createWorkerSession = () => createAgentSession({
					cwd: fctx.cwd,
					agentDir: fctx.agentDir,
					model: workerModel,
					...(thinkingLevel ? { thinkingLevel } : {}),
					...(workerToolScope.sessionOptions.tools ? { tools: workerToolScope.sessionOptions.tools } : {}),
					...(workerToolScope.sessionOptions.excludeTools
						? { excludeTools: workerToolScope.sessionOptions.excludeTools }
						: {}),
					...(workerSessionCustomTools.length > 0
						? { customTools: workerSessionCustomTools }
						: {}),
					sessionManager: sessionMgr,
					settingsManager: workerSettingsManager,
					...childModelSessionOptions(fctx),
					resourceLoader: workerLoader,
				});
				let created: Awaited<ReturnType<typeof createAgentSession>>;
				try {
					created = await createWorkerSession();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!isCredentialStoreLockErrorMessage(message)) throw error;
					result.retryKind = "transient";
					if (!(await waitForLockRetry())) {
						throw new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE, { cause: error });
					}
					try {
						created = await runWithinCredentialDeadline(createWorkerSession);
					} catch (retryError) {
						const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
						throw new Error(
							isCredentialStoreLockErrorMessage(retryMessage)
								? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
								: isRouteAuthFailureMessage(retryMessage)
									? sanitizedRouteAuthFailureMessage(currentWorkerModel?.provider)
									: retryMessage,
							{ cause: retryError },
						);
					}
				}
				session = created.session;
				sessionAcquired = true;
				attemptOperation("session-create", "acquired");
				attemptBoundary("acquired", "session");
			// ── Lineage serialize seam (spec 0003 / REQ-LIN-1) ──────────────
			// Inside `runWithDepth`, so the unified frame is live: this is the
			// addressable point where a later detached-spawn shape (orchestrate,
			// spec 0005) injects the serialized lineage into the child process
			// env via `{ ...process.env, ...currentLineageEnv() }`. No child
			// process is spawned here (the supervised worker is an in-process
			// createAgentSession); we only make the serialized frame reachable +
			// surface it under the worker-debug gate so the wiring is observable.
			if (process.env.GRAFT_DEBUG_WORKER) {
				// eslint-disable-next-line no-console -- gated on GRAFT_DEBUG_WORKER, so it is off in a normal TUI session
				console.error(
					`[runForkInner] lineageEnvKeys=${JSON.stringify(currentLineageEnvKeyNames())}`,
				);
			}
			// Phase 3c — bind the worker's extension runtime so session_start
			// fires and the worker's extensions see the right uiContext.
			// NOTE: we intentionally DO NOT bind a stub uiContext when
			// `interactive` is false — `ExtensionRunner.hasUI()` is identity-
			// based (`uiContext !== noOpUIContext`), so any non-default object
			// would flip `ctx.hasUI` to true and defeat command-guard's auto-
			// deny. Omitting the `uiContext` key leaves the runner at its
			// default `noOpUIContext` identity, which is exactly what we want
			// for "non-interactive worker, same behaviour as a CLI".
			// Pass the installed confinement so a nested dispatch by this worker cannot
			// hand its child wider filesystem authority than the worker itself holds.
			nestedDelegatePolicy = nestedDelegatePolicyForAgent(req.agent, writeConfinement);
			if (fctx.workerUIContext) {
				await withDelegateOwnedExtensionBind(() =>
					session.bindExtensions({ uiContext: fctx.workerUIContext }),
					nestedDelegatePolicy,
				);
			} else {
				await withDelegateOwnedExtensionBind(() => session.bindExtensions({}), nestedDelegatePolicy);
			}
			attemptOperation("extension-bind", "acquired");
			attemptBoundary("acquired", "extension-binding");
			// Apply the live scope only after session_start handlers have had a
			// chance to register tools. The hook and turn subscription remain
			// installed until this attempt's AgentSession is disposed.
			unsubscribeToolScope = workerToolScope.install(session);
			if (typeof releaseWorkerToolRegistration === "function") releaseWorkerToolRegistration();
			// Wrap the worker session in a WorkerChannel so the clone-side
			// `message_subagent` tool goes through a single lifecycle object
			// with heartbeat-aware awaits. Each per-fork value may be absent;
			// WorkerChannel then uses the module-level DEFAULTs.
			const renewChannel = () => new WorkerChannel(session, {
				heartbeatIntervalMs: req.heartbeatIntervalMs,
				clock: fctx.workerChannelClock,
				maxConsecutiveHeartbeats: req.maxConsecutiveHeartbeats,
				heartbeatGraceIntervals: req.heartbeatGraceIntervals,
				heartbeatTailLines: req.heartbeatTailLines,
				workerSessionFile: () => existingWorkerSessionFile(session.sessionFile),
				workerCompactionEntries: () => sessionMgr.getEntries(),
				workerCompactionAgentDir: fctx.agentDir,
				// Spec 0024 / REQ-LIVE-1 — propagate the channel's internal liveness
				// clock OUT to this fork's run-state record on the activity that
				// already happens (reply/heartbeat/tool events feed `notifyActivity`).
				// `fctx.runId` + `req.name` are the same (runId, forkName) tuple every
				// other per-fork run-state write uses. Best-effort + guarded: a
				// missing runId degrades to today's behavior (the fork record simply
				// carries no `lastActivityAt`, so run-introspect's reducer falls back
				// to `endedAt ?? startedAt` — REQ-LIVE-4 legacy parity). NO new timer;
				// `updateRunState` no-ops on a missing run/fork and leaves
				// startedAt/endedAt stamping untouched.
				onActivity: fctx.runId
					? (lastActivityAt: number): void => {
							updateRunState(fctx.runId as string, req.name, { lastActivityAt });
						}
					: undefined,
				// Nested-liveness probe (spec 0004 / REQ-BUS-2): the heartbeat asks
				// the event bus whether any DESCENDANT of THIS fork is still
				// producing events before counting silence. This kills the
				// foreground→orchestrator→worker false-cancel: the orchestrator's
				// transcript sits idle while its worker (a descendant) does the
				// real work. The window is one heartbeat interval — a descendant
				// event within the last interval means the subtree is alive.
				descendantActivityProbe: busFrame
					? (): boolean =>
							readDescendantActivity({
								agentDir: busAgentDir,
								rootRunId: busFrame.rootRunId,
								// TRUE ancestry: the full root→self id-path, so the probe
								// matches descendants by strict path-prefix (not depth) and
								// does not get masked by a busy same-root cousin.
								ancestorPath: lineageAncestorPath(busFrame),
								windowMs: busLivenessWindowMs,
							})
					: undefined,
				// Graceful wind-down: when the worker first goes silent past
				// `maxConsecutiveHeartbeats`, steer it with a wrap-up instruction
				// rather than aborting outright. Best-effort — a mid-prompt worker
				// may not accept a live steer, in which case the channel still
				// grants the grace window and hard-aborts on continued silence.
				onWindDownSteer: () => withWorkerEnv(() => {
					if (
						fctx.runId &&
						workerAttempt?.generation === activityGeneration &&
						!teardownStarted
					) {
						updateRunState(fctx.runId, req.name, {
							windDown: { atMs: fctx.workerChannelClock?.now() ?? Date.now(), reason: "heartbeat" },
						});
					}
					logDelegateDiagnostic(
						`fork '${req.name}' silent past heartbeat budget; ` +
							`steering wind-down (wrap up now) before hard-cancel.`,
						{ agentDir: fctx.agentDir },
					);
					const streaming = (session as unknown as { isStreaming?: boolean }).isStreaming;
					const steerFn = (session as unknown as { steer?: (t: string) => Promise<void> }).steer;
					if (streaming && typeof steerFn === "function") {
						return steerFn.call(session, WORKER_WIND_DOWN_STEER);
					}
				}),
			});
			channel = renewChannel();
			if (!channel) throw new Error("Worker channel not initialised");
			if (fctx.runId) {
				updateRunState(fctx.runId, req.name, {
					heartbeatIntervalMs: channel.getHeartbeatIntervalMs(),
					maxConsecutiveHeartbeats: channel.getMaxConsecutiveHeartbeats(),
				});
			}
			channelRef.current = channel;
			attemptOperation("channel-create", "acquired");
			attemptBoundary("acquired", "channel");
			// Worker transcript and short-lived actor activity stream.
			// `workerSession.prompt()` is called from the clone's `message_subagent`
			// tool. The captured generation prevents a retired attempt from
			// overwriting its replacement's widget phase if a queued SDK event lands
			// during restart teardown.
			let promptRepairPhaseActive = false;
			const workerActivityProjector = actorActivity
				? createAgentActivityProjector({ mode: "supervised-worker", publisher: actorActivity })
				: undefined;
			unsubscribePromptRepairActivity = workerEventBus.on(
				PROMPT_REPAIR_ACTIVITY_CHANNEL,
				(value) => {
					if (workerAttempt?.generation !== activityGeneration) return;
					const activity = parsePromptRepairActivity(value);
					if (activity) {
						promptRepairPhaseActive = true;
						actorActivity?.publish("worker", activity);
					}
				},
			);
			unsubscribe = session.subscribe((ev) => {
				if (workerAttempt?.generation !== activityGeneration) return;
				try {
					if (ev.type === "agent_start") {
						actorActivity?.publish("supervisor", { phase: "waiting-worker" });
					}
					if (!promptRepairPhaseActive || !shouldPreservePromptRepairActivity(ev.type)) {
						promptRepairPhaseActive = false;
						workerActivityProjector?.handle(ev);
					}
				} catch {
					// UI-only activity must never interrupt worker/channel processing.
				}
				channelRef.current?.observePromptEvent(ev);
				if ((ev as unknown as { type?: string }).type === "entry_appended") {
					const record = readPromptRepairRecords([(ev as unknown as { entry?: unknown }).entry])[0];
					if (record) {
						result.promptRepairs = mergePromptRepairRecords(result.promptRepairs ?? [], [record]);
						for (const entry of promptRepairTranscriptEntries([record])) fctx.onTranscriptEntry?.(entry);
					}
					return;
				}
				if (ev.type !== "message_end" || !ev.message) return;
				// Heartbeat: feed the channel before the overlay so heartbeat state
				// is in sync with what the supervisor will see reflected.
				try {
					const entry = heartbeatEntryFromMessage(ev.message as AgentMessage);
					if (entry) channelRef.current?.notifyActivity(entry);
				} catch {
					/* never let activity-tracking crash the session subscribe hook */
				}
				// Event-bus `updated` (spec 0004 / REQ-BUS-1): the in-process
				// callback above stays the fast local path; the bus is the
				// authoritative boundary-crossing record that a PARENT's heartbeat
				// reads. One substrate, no parallel system. Best-effort.
				// Issue #226 — task counts ride on THIS event rather than one of
				// their own. Keeping them on every message-end means the ordinary rolling
				// update and the retained task snapshot are the same event under `MAX_STEPS`,
				// so a later message cannot leave task progress stale.
				const taskFields = taskProgressFieldsFromEntries(sessionMgr.getEntries?.());
				emitBusEvent("updated", { event: "message_end", ...(taskFields ?? {}) });
				// Mirror the same counts into live state so the widget row can show
				// them without re-reading the worker's session file.
				if (taskFields) emit({ taskProgress: taskFields[TASK_PROGRESS_FIELD] });
				if (fctx.onTranscriptEntry) {
					try {
						for (const e of messagesToTranscript(
							"worker",
							[sanitizeForkCredentialMessage(ev.message as AgentMessage, currentWorkerModel?.provider)],
						)) {
							fctx.onTranscriptEntry(e);
						}
					} catch {
						/* swallow — transcript stream is best-effort. */
					}
				}
			});
			attemptOperation("subscribe", "acquired");
			attemptBoundary("acquired", "subscription");
			// Publish the initial full snapshot as an ordinary `updated` event.
			// If this worker is terminated before its first response, the owner
			// still has the last row set the worker reported.
			const seededTaskFields = taskProgressFieldsFromEntries(sessionMgr.getEntries?.());
			if (seededTaskFields) {
				emitBusEvent("updated", { event: "task_seed", ...seededTaskFields });
				emit({ taskProgress: seededTaskFields[TASK_PROGRESS_FIELD] });
			}
			return {
				loader: workerLoader,
				nestedDelegatePolicy,
				session,
				channel,
				channelRef,
				renewChannel,
				unsubscribe: () => {
					try { unsubscribe?.(); } finally {
						try { unsubscribePromptRepairActivity?.(); } finally { unsubscribeToolScope?.(); }
					}
				},
			};
			} catch (error) {
				if (channel) {
					try { await channel.abort("supervisor"); attemptOperation("channel-abort", "released"); } catch { /* best effort */ }
					try { await channel.waitForSettlement(); attemptOperation("channel-settlement", "released"); } catch { /* best effort */ }
					try { attemptBoundary("released", "channel"); } catch { /* diagnostics only */ }
				}
				// If session construction reached AgentSession, dispose owns runtime
				// invalidation. Otherwise the loader is still an observed partial
				// attempt and must be invalidated directly, exactly once.
				if (sessionAcquired) {
					try {
						unsubscribe?.();
						unsubscribePromptRepairActivity?.();
						unsubscribeToolScope?.();
						if (unsubscribe || unsubscribeToolScope) attemptOperation("unsubscribe", "released");
					} catch {
						/* unsubscribe is best-effort during partial construction */
					}
					if (unsubscribe) {
						try { attemptBoundary("released", "subscription"); } catch { /* diagnostics only */ }
					}
					try {
						await disposeWorkerSession(session, nestedDelegatePolicy);
					} catch {
						try {
							invalidateFailedWorkerRuntime(workerLoader, () => attemptOperation("runtime-invalidate", "released"));
						} catch { /* preserve the construction failure */ }
					}
					try { attemptOperation("session-dispose", "released"); } catch { /* preserve the construction failure */ }
					try { attemptBoundary("released", "extension-binding"); } catch { /* diagnostics only */ }
					try { attemptBoundary("released", "preparation"); } catch { /* diagnostics only */ }
					try { attemptBoundary("released", "session"); } catch { /* diagnostics only */ }
					try { attemptBoundary("released", "final-teardown"); } catch { /* diagnostics only */ }
				} else {
					try {
						invalidateFailedWorkerRuntime(workerLoader, () => attemptOperation("runtime-invalidate", "released"));
					} catch { /* preserve the construction failure */ }
					try { attemptBoundary("released", "preparation"); } catch { /* diagnostics only */ }
				}
				throw error;
			}
		};

		{
			const built = await withWorkerEnv(() => buildWorkerSessionAndChannel());
			workerAttempt = {
				generation: ++nextAttemptGeneration,
				loader: built.loader,
				nestedDelegatePolicy: built.nestedDelegatePolicy,
				session: built.session,
				channel: built.channel,
				channelRef: built.channelRef,
				renewChannel: built.renewChannel,
				unsubscribe: built.unsubscribe,
				unsubscribed: false,
				cancelled: false,
				retiring: false,
				disposed: false,
			};
			workerSessionPath = workerAttempt.session.sessionFile;
			emitBusEvent("started", {
				agent: req.agent.name,
				attemptGeneration: workerAttempt.generation,
				workerSessionFile: existingWorkerSessionFile(workerSessionPath),
			});
		}
		if (fctx.signal?.aborted) throw new Error("aborted before fork construction");
		result.workerSessionFile = existingWorkerSessionFile(workerSessionPath);
		if (fctx.sessionRefs) fctx.sessionRefs.worker = activeAttempt().session;
		emit({ workerSessionFile: existingWorkerSessionFile(workerSessionPath) });

		const capacityContinuationSignal = fctx.signal ?? new AbortController().signal;
		const capacityFailureCall = (
			error: string,
			promptText: string,
			attempt: WorkerAttempt,
		): Extract<WorkerCallResult, { kind: "failed" }> => {
			const last = (attempt.session.messages as AgentMessage[]).at(-1);
			const newMessages = last?.role === "assistant" && last.errorMessage === error ? [last] : [];
			const harvest = newMessages.length > 0
				? classifyHarvestOutcome(newMessages)
				: { kind: "failure" as const, error };
			return {
				kind: "failed",
				text: error,
				error,
				harvest,
				...(harvest.kind === "failure" && harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
				promptText,
				...(harvest.kind === "failure" && harvest.stopReason ? { stopReason: harvest.stopReason } : {}),
				newMessages,
			};
		};

		const replaceWorkerAttempt = async (input: {
			message: string;
			retirementReason: "restart_worker" | "refusal-fallback" | "transient-fallback";
			/** Attempt whose result caused this replacement. Late results must not
			 * retire a successor that won the race with them. */
			originAttempt?: WorkerAttempt;
			refusalModelRef?: string;
			/** Select and consume the next distinct model after a transient failure. */
			transientFailure?: boolean;
			modelChoice?: WorkerModelChoice;
			countRound: boolean;
		}): Promise<{
			kind: "reply" | "max-rounds" | "stale" | "no-fallback";
			attempt?: WorkerAttempt;
			call?: WorkerCallResult;
			source?: Promise<WorkerCallResult>;
		}> => {
			const replacement = await withWorkerEnv(() => withWorkerTransition(async () => {
				if (teardownStarted || finishRequested) return { kind: "reply" as const };
				// Validate the originating generation inside the transition gate.
				// Checking before queuing is insufficient: another replacement may
				// publish a successor while this operation waits for the gate.
				if (
					input.originAttempt &&
					(workerAttempt !== input.originAttempt || workerAttempt.generation !== input.originAttempt.generation)
				) {
					return { kind: "stale" as const };
				}
				const predecessor = activeAttempt();
				if (input.countRound && result.roundsUsed >= req.maxRounds) {
					roundRefusalIssued = true;
					return { kind: "max-rounds" as const };
				}
				let modelChoice = input.modelChoice;
				// Refusal bookkeeping and fallback resolution share the validated
				// transition with retirement, so a late refusal cannot poison a winner.
				if (input.refusalModelRef) {
					recordRefusal(input.refusalModelRef);
					modelChoice = nextWorkerModel();
					if (!modelChoice) return { kind: "no-fallback" as const };
				} else if (input.transientFailure) {
					modelChoice = nextWorkerModel();
					if (!modelChoice) return { kind: "no-fallback" as const };
				}
				predecessor.retiring = true;
				await abortAttemptAndWait(predecessor, "supervisor");
				unsubscribeAttempt(predecessor);
				const snapshot = (predecessor.session.messages as AgentMessage[]).slice();
				if (!result.priorWorkerSessions) result.priorWorkerSessions = [];
				result.priorWorkerSessions.push({
					sessionFile: existingWorkerSessionFile(predecessor.session.sessionFile),
					messagesSnapshot: snapshot,
					endedAt: Date.now(),
					restartMessage: input.message,
					retirementReason: input.retirementReason,
				});
				// Remove the retiring attempt from publication before construction.
				// A failed successor therefore cannot leave refs pointing at a
				// disposed predecessor or duplicate it in the collapsed transcript.
				workerAttempt = undefined;
				if (fctx.sessionRefs?.worker === predecessor.session) delete fctx.sessionRefs.worker;
				workerSessionPath = undefined;
				result.workerSessionFile = undefined;
				if (modelChoice) currentWorkerModel = modelChoice.model;
				let built: Awaited<ReturnType<typeof buildWorkerSessionAndChannel>>;
				try {
					await fctx.workerAttemptLifecycle?.onReplacementBoundary?.("preparation", predecessor.generation);
					built = await buildWorkerSessionAndChannel();
				} catch (error) {
					await disposeAttempt(predecessor);
					workerReplacementFailure = true;
					result.status = "failed";
					result.error = String((error as Error)?.message ?? error);
					emit({ status: "failed", error: result.error, workerSessionFile: undefined });
					queueMicrotask(() => { cloneSession?.abort().catch(() => {}); });
					throw error;
				}
				const successor: WorkerAttempt = {
					generation: ++nextAttemptGeneration,
					loader: built.loader,
					nestedDelegatePolicy: built.nestedDelegatePolicy,
					session: built.session,
					channel: built.channel,
					channelRef: built.channelRef,
					renewChannel: built.renewChannel,
					unsubscribe: built.unsubscribe,
					unsubscribed: false,
					cancelled: false,
					retiring: false,
					disposed: false,
				};
				try {
					await fctx.workerAttemptLifecycle?.onReplacementBoundary?.("publication", successor.generation);
				} catch (error) {
					// The successor is fully built but not yet published.  It has no
					// owner other than this transition, so dispose it before surfacing
					// the publication-boundary failure.
					await disposeAttempt(successor);
					await disposeAttempt(predecessor);
					workerReplacementFailure = true;
					result.status = "failed";
					result.error = String((error as Error)?.message ?? error);
					emit({ status: "failed", error: result.error, workerSessionFile: undefined });
					queueMicrotask(() => { cloneSession?.abort().catch(() => {}); });
					throw error;
				}
				workerAttempt = successor;
				workerSessionPath = successor.session.sessionFile;
				emitBusEvent("started", {
					agent: req.agent.name,
					attemptGeneration: successor.generation,
					workerSessionFile: existingWorkerSessionFile(workerSessionPath),
				});
				result.workerSessionFile = existingWorkerSessionFile(workerSessionPath);
				if (fctx.sessionRefs) fctx.sessionRefs.worker = successor.session;
				if (modelChoice) {
					workerModelRef = modelChoice.canonicalRef;
				}
				// Publication precedes predecessor disposal; prompt only after the
				// old runtime is stale and its resources are fully owned/disposed.
				await disposeAttempt(predecessor);
				if (input.countRound) result.roundsUsed += 1;
				result.status = "running";
				result.cancelReason = undefined;
				result.error = undefined;
				emit({
					lastSupervisorText: input.message,
					workerSessionFile: existingWorkerSessionFile(workerSessionPath),
					status: "running",
				});
				// Do not await the successor prompt while holding the ownership gate.
				// A provider may hang until an external ForkContext.signal aborts it;
				// keeping that await inside the gate would block cancellation, a
				// concurrent replacement, and final teardown behind the hung prompt.
				return { kind: "reply" as const, attempt: successor };
			}));
			if (!replacement.attempt) return replacement;
			// Register the successor prompt at the send gate, just like the initial
			// message prompt. Waiters and a concurrent restart must observe this
			// exact source promise rather than racing channel.awaitReply().
			const sent = await withWorkerEnv(() => withWorkerTransition(() => {
				const attempt = replacement.attempt!;
				if (
					workerAttempt !== attempt ||
					attempt.retiring ||
					finishRequested ||
					teardownStarted
				) return { kind: "stale" as const };
				attemptBoundary("acquired", "prompt", attempt.generation);
				attempt.promptText = input.message;
				const source = attempt.channel.send(input.message);
				attempt.promptResult = source;
				attempt.promptConsumption = undefined;
				return { kind: "sent" as const, source };
			}));
			if (sent.kind === "stale") return { kind: "stale" as const };
			let call: WorkerCallResult;
			try {
				call = await withWorkerEnv(() => sent.source);
				attemptOperation("prompt", "released", replacement.attempt.generation);
				try { attemptBoundary("released", "prompt", replacement.attempt.generation); } catch { /* diagnostics only */ }
			} catch (error) {
				try { attemptBoundary("released", "prompt", replacement.attempt.generation); } catch { /* diagnostics only */ }
				// A replacement can be retired immediately after publication by a
				// concurrent restart/refusal. Treat the prompt failure as stale when
				// ownership has moved; the active successor remains authoritative.
				if (!(await isCurrentAttempt(replacement.attempt))) {
					return { kind: "reply", attempt: replacement.attempt, source: sent.source };
				}
				const credentialRetry = await retryThrownCredentialLock(
					error,
					replacement.attempt,
					input.message,
				);
				if (credentialRetry) {
					return { ...replacement, call: credentialRetry.call, source: credentialRetry.source };
				}
				const transportError = String((error as Error)?.message ?? error);
				if (isCapacityFailureMessage(transportError)) {
					const capacityCall = capacityFailureCall(transportError, input.message, replacement.attempt);
					const source = Promise.resolve(capacityCall);
					return { ...replacement, call: capacityCall, source };
				}
				const transientFailure = isTransientWorkerErrorMessage(transportError);
				if (shouldReplaceAttemptForRoute(transportError)) {
					const retry = await replaceWorkerAttempt({
						message: input.message,
						retirementReason: "transient-fallback",
						originAttempt: replacement.attempt,
						transientFailure: true,
						countRound: false,
					});
					if (retry.kind !== "no-fallback") return retry;
				}
				workerReplacementFailure = true;
				result.status = "failed";
				const workerSessionFile = existingWorkerSessionFile(replacement.attempt.session.sessionFile);
				const recoveredText = getLastAssistantText(replacement.attempt.session.messages as AgentMessage[]).trim();
				const terminalError = workerSessionFile
					? `${transportError} (worker session: ${workerSessionFile})`
					: transportError;
				result.failureCause = classifyWorkerFailureCause(transportError);
				result.error = transientFailure ? markNoModelAlternative(terminalError) : terminalError;
				if (transientFailure) result.retryKind = "transient";
				if (recoveredText) {
					result.recoveredOutput = true;
					result.collapsedContent = formatRecoveredWorkerOutput(
						recoveredText,
						result.error ?? terminalError,
						workerSessionFile,
					);
				}
				emit({ status: "failed", error: result.error, workerSessionFile, recoveredOutput: result.recoveredOutput });
				throw error;
			}
			return { ...replacement, call, source: sent.source };
		};

		const retryCredentialWorkerCall = async (
			call: Extract<WorkerCallResult, { kind: "failed" }>,
			attempt: WorkerAttempt,
		): Promise<WorkerCallResult | undefined> => {
			const lockFailure = isCredentialStoreLockErrorMessage(call.error);
			const refreshableAuthFailure = isRefreshableRouteAuthFailureMessage(call.error);
			if (!lockFailure && !refreshableAuthFailure) return undefined;
			if (lockFailure) result.retryKind = "transient";

			const retryAllowed = lockFailure
				? await waitForLockRetry()
				: await refreshCurrentProviderFor401();
			const sanitizedError = lockFailure
				? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
				: sanitizedRouteAuthFailureMessage(currentWorkerModel?.provider);
			const sanitizedFailure = (): Extract<WorkerCallResult, { kind: "failed" }> => ({
				...call,
				text: sanitizedError,
				error: sanitizedError,
				harvest: { kind: "failure", error: sanitizedError },
				newMessages: call.newMessages.map((message) =>
					sanitizeForkCredentialMessage(message, currentWorkerModel?.provider)),
			});
			if (!retryAllowed) return sanitizedFailure();

			const messages = attempt.session.agent.state.messages as AgentMessage[];
			const last = messages[messages.length - 1];
			if (last?.role !== "assistant") return sanitizedFailure();
			// Keep the error in the file-backed session history, but remove it from
			// live agent context exactly as Pi's own retry seam does. continue() then
			// resumes after the existing user/toolResult and cannot replay tools.
			attempt.session.agent.state.messages = messages.slice(0, -1);
			const cursor = attempt.session.messages.length;
			try {
				const continueRequest = () => attempt.session.agent.continue();
				if (lockFailure) {
					await runWithinCredentialDeadline(continueRequest, () => {
						attempt.session.abort().catch(() => {});
					});
				} else {
					await raceAgainstCredentialCancellation(continueRequest());
				}
			} catch (error) {
				if (fctx.signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (!isCredentialStoreLockErrorMessage(message) && !isRouteAuthFailureMessage(message)) throw error;
				const errorText = isCredentialStoreLockErrorMessage(message)
					? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
					: sanitizedRouteAuthFailureMessage(currentWorkerModel?.provider);
				return { ...sanitizedFailure(), text: errorText, error: errorText, harvest: { kind: "failure", error: errorText } };
			}
			if (fctx.signal?.aborted) throw credentialAbortError();
			const newMessages = (attempt.session.messages as AgentMessage[]).slice(cursor);
			const harvest: HarvestOutcome = classifyHarvestOutcome(newMessages);

			// WorkerChannel marks a failed prompt terminal. Renew only the channel
			// wrapper around the same AgentSession so later supervisor rounds remain
			// usable without recreating or replaying the worker.
			const renewedChannel = attempt.renewChannel();
			attempt.channel = renewedChannel;
			attempt.channelRef.current = renewedChannel;
			if (harvest.kind === "failure") {
				return {
					kind: "failed",
					text: harvest.error,
					error: harvest.error,
					harvest,
					...(harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
					promptText: call.promptText,
					...(harvest.stopReason ? { stopReason: harvest.stopReason } : {}),
					newMessages,
				};
			}
			if (harvest.kind === "missing" && harvest.reason !== "cancellation-only") {
				return {
					kind: "failed",
					text: "",
					error: "No substantive assistant output recovered",
					harvest,
					promptText: call.promptText,
					newMessages,
				};
			}
			const text = harvest.kind === "substantive"
				? harvest.text
				: getLastAssistantMessageText(newMessages);
			return { kind: "reply", text, harvest, newMessages };
		};

		const retryThrownCredentialLock = async (
			error: unknown,
			attempt: WorkerAttempt,
			promptText: string,
			signal?: AbortSignal,
		): Promise<{ call: WorkerCallResult; source: Promise<WorkerCallResult> } | undefined> => {
			const message = error instanceof Error ? error.message : String(error);
			if (!isCredentialStoreLockErrorMessage(message)) return undefined;
			result.retryKind = "transient";
			if (!(await waitForLockRetry())) {
				throw new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE, { cause: error });
			}
			const stateMessages = attempt.session.agent.state.messages as AgentMessage[];
			const lastRole = stateMessages[stateMessages.length - 1]?.role;
			if (lastRole === "user" || lastRole === "toolResult") {
				const cursor = attempt.session.messages.length;
				try {
					await runWithinCredentialDeadline(
						() => attempt.session.agent.continue(),
						() => { attempt.session.abort().catch(() => {}); },
					);
				} catch (retryError) {
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					if (isCredentialStoreLockErrorMessage(retryMessage)) {
						throw new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE, { cause: retryError });
					}
					if (isRouteAuthFailureMessage(retryMessage)) {
						throw new Error(sanitizedRouteAuthFailureMessage(currentWorkerModel?.provider), { cause: retryError });
					}
					throw retryError;
				}
				const newMessages = (attempt.session.messages as AgentMessage[]).slice(cursor);
				const harvest = classifyHarvestOutcome(newMessages);
				const renewedChannel = attempt.renewChannel();
				attempt.channel = renewedChannel;
				attempt.channelRef.current = renewedChannel;
				const call: WorkerCallResult = harvest.kind === "substantive" ||
					(harvest.kind === "missing" && harvest.reason === "cancellation-only")
					? {
							kind: "reply",
							text: harvest.kind === "substantive" ? harvest.text : getLastAssistantMessageText(newMessages),
							harvest,
							newMessages,
						}
					: {
							kind: "failed",
							text: harvest.kind === "failure" ? harvest.error : "",
							error: harvest.kind === "failure" ? harvest.error : "No substantive assistant output recovered",
							harvest,
							...(harvest.kind === "failure" && harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
							promptText,
							...(harvest.kind === "failure" && harvest.stopReason ? { stopReason: harvest.stopReason } : {}),
							newMessages,
						};
				const source = Promise.resolve(call);
				return { call, source };
			}

			const renewedChannel = attempt.renewChannel();
			attempt.channel = renewedChannel;
			attempt.channelRef.current = renewedChannel;
			const source = renewedChannel.send(promptText, signal);
			try {
				const call = await runWithinCredentialDeadline(
					() => source,
					() => { attempt.session.abort().catch(() => {}); },
				);
				return { call, source };
			} catch (retryError) {
				const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
				if (isCredentialStoreLockErrorMessage(retryMessage)) {
					throw new Error(CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE, { cause: retryError });
				}
				if (isRouteAuthFailureMessage(retryMessage)) {
					throw new Error(sanitizedRouteAuthFailureMessage(currentWorkerModel?.provider), { cause: retryError });
				}
				throw retryError;
			}
		};

		const continueCapacityWorkerCall = async (
			call: Extract<WorkerCallResult, { kind: "failed" }>,
			attempt: WorkerAttempt,
			snapshot: Parameters<typeof continueCapacityRequest>[0],
			modelChoice?: WorkerModelChoice,
		): Promise<WorkerCallResult> => {
			const adoptModelChoice = (): void => {
				if (!modelChoice) return;
				if (
					attempt.session.model?.provider !== modelChoice.model.provider ||
					attempt.session.model.id !== modelChoice.model.id
				) return;
				currentWorkerModel = modelChoice.model;
				workerModelRef = modelChoice.canonicalRef;
			};
			let newMessages: readonly AgentMessage[];
			try {
				newMessages = await continueCapacityRequest(snapshot, {
					...(modelChoice ? { modelChoice: modelChoice.model } : {}),
					thinkingLevel,
					signal: capacityContinuationSignal,
				}) as readonly AgentMessage[];
			} catch (error) {
				adoptModelChoice();
				throw error;
			}
			adoptModelChoice();
			const harvest = classifyHarvestOutcome(newMessages);

			// A failed prompt makes WorkerChannel terminal. Capacity continuation keeps
			// the WorkerAttempt and AgentSession, and renews only this wrapper so later
			// supervisor rounds can still address the same live attempt.
			const renewedChannel = attempt.renewChannel();
			attempt.channel = renewedChannel;
			attempt.channelRef.current = renewedChannel;
			if (harvest.kind === "failure") {
				return {
					kind: "failed",
					text: harvest.error,
					error: harvest.error,
					harvest,
					...(harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
					promptText: call.promptText,
					...(harvest.stopReason ? { stopReason: harvest.stopReason } : {}),
					newMessages: [...newMessages],
				};
			}
			if (harvest.kind === "missing" && harvest.reason !== "cancellation-only") {
				return {
					kind: "failed",
					text: "",
					error: "No substantive assistant output recovered",
					harvest,
					promptText: call.promptText,
					newMessages: [...newMessages],
				};
			}
			const text = harvest.kind === "substantive"
				? harvest.text
				: getLastAssistantMessageText(newMessages);
			return { kind: "reply", text, harvest, newMessages: [...newMessages] };
		};

		// ── 2. Clone session (in-memory, only message_subagent + finish_delegation) ─
		const cloneModel = fctx.mainModel
			? findModel(
					fctx.modelRegistry,
					fctx.mainModel.provider,
					fctx.mainModel.id,
					fctx.scopedModelRefs,
				)
			: pickCheapestAvailable(fctx.modelRegistry, fctx.scopedModelRefs);
		if (!cloneModel) {
			if (!fctx.mainModel) {
				throw new Error(
					"Could not resolve fork-clone model: automatic selection found no eligible priced model; " +
					"available models may be unpriced. Pin a model explicitly or supply pricing.",
				);
			}
			throw new Error("Could not resolve fork-clone model (main agent model unavailable).");
		}

		// The degradation path. A supervised worker is driven through the
		// supervisor, so an unseedable checklist rides in the supervisor's
		// brief; that is lossier than a seeded entry, which is exactly why the
		// seeded path is preferred when anything claims the channel. For
		// direct-first-turn the runtime still delivers the caller's exact
		// `req.task` to the worker (below); this is only the supervisor's brief.
		const supervisorSeedTask = req.focus && focusSeedable !== true
			? appendFocusToPrompt(
				req.tasks && tasksSeedable !== true ? appendTasksToPrompt(req.task, req.tasks) : req.task,
				req.focus,
				{ cwd: fctx.cwd, writableRoots: req.writableRoots, confineWrites: req.confineWrites },
			)
			: req.tasks && tasksSeedable !== true ? appendTasksToPrompt(req.task, req.tasks) : req.task;

		// Two plain AgentTool-shaped objects (no `defineTool` — that's for
		// extension-registered tools which receive a 5th `ctx` argument. The SDK
		// `createAgentSession({ tools })` expects the 4-arg AgentTool shape.)
		const messageSubagentTool: any = {
			name: CLONE_MESSAGE_TOOL,
			label: "Message subagent",
			description: taskDelivery === "direct-first-turn"
				? "Send a follow-up to the subagent you are delegating to. The initial task was already delivered to them and its reply is in your history — do not resend or restate it. They will run their own tools and return a reply. If the worker is slow, you will receive a heartbeat status instead of a reply — call `wait_for_worker` to keep waiting."
				: "Send a message to the subagent you are delegating to. They will run their own tools and return a reply. Use this for the initial task and for every follow-up question or correction. If the worker is slow, you will receive a heartbeat status instead of a reply — call `wait_for_worker` to keep waiting.",
			parameters: Type.Object({
				text: Type.String({ description: "The message to send to the subagent." }),
			}),
			execute: async (
				_toolCallId: string,
				params: { text: string },
				_signal?: AbortSignal,
				// #452 CR-DIRECT-FIRST-GUIDANCE-EXACTNESS: the runtime's direct
				// first-turn delivery calls this with skipGuidanceDrain so the
				// caller's exact task is the worker's first user turn. Queued
				// guidance is left in the pending queue and delivered on the
				// supervisor's next message_subagent, never silently merged into
				// the exact delivery or dropped.
				directOptions?: { skipGuidanceDrain?: boolean },
			) => {
				const claim = await withWorkerTransition(() => {
					const attempt = workerAttempt;
					if (!attempt || teardownStarted) throw new Error("Worker attempt not initialised");
					if (attempt.retiring || finishRequested) {
						return { kind: "retiring" as const, attempt };
					}
					if (attempt.channel.getState() === "aborted") return { kind: "aborted" as const, attempt };
					if (attempt.channel.isBusy()) return { kind: "busy" as const, attempt };
					// The max-round and busy checks are repeated at the send gate below.
					// This first claim only reserves the opportunity to send; another
					// transition may retire this attempt before the prompt is published.
					return { kind: "send" as const, attempt };
				});
				if (claim.kind !== "send") {
					const text = claim.kind === "aborted"
						? "The subagent has been cancelled; call restart_worker or finish_delegation."
						: claim.kind === "busy"
							? "The worker is already busy; call wait_for_worker or finish_delegation."
							: "The worker is being replaced; wait for the replacement to become active.";
					return {
						content: [{ type: "text" as const, text }],
						details: { kind: claim.kind, workerSessionFile: existingWorkerSessionFile(claim.attempt.session.sessionFile) },
					};
				}

				// Drain guidance only after the round is atomically claimed.
				// #452: the direct first-turn delivery skips this entirely
				// (skipGuidanceDrain) so the worker's first user turn is the
				// caller's exact task; the queue survives for the supervisor's
				// next message_subagent.
				let workerText = params.text;
				const drained = (!directOptions?.skipGuidanceDrain && fctx.getPendingGuidance) ? fctx.getPendingGuidance() : [];
				if (drained.length > 0) {
					workerText = `<user-guidance source="user">\n${drained.join("\n\n")}\n</user-guidance>\n\n${params.text}`;
					try { fctx.onGuidanceDelivered?.(drained); } catch { /* best effort */ }
				}
				emit({ lastSupervisorText: workerText, status: "running" });
				let workerCall: WorkerCallResult;
				let promptResult!: Promise<WorkerCallResult>;
				try {
					// Revalidate at the actual send gate. A replacement or finish may
					// have won the transition while guidance was being prepared.
					const sent = await withWorkerEnv(() => withWorkerTransition(() => {
						if (
							workerAttempt !== claim.attempt ||
							claim.attempt.retiring ||
							finishRequested ||
							teardownStarted
						) return { kind: "stale" as const };
						if (claim.attempt.channel.getState() === "aborted") return { kind: "aborted" as const };
						if (claim.attempt.channel.isBusy()) return { kind: "busy" as const };
						if (result.roundsUsed >= req.maxRounds) {
							roundRefusalIssued = true;
							return { kind: "max-rounds" as const };
						}
						attemptBoundary("acquired", "prompt", claim.attempt.generation);
						// One accepted message_subagent call owns one supervisor round.
						// WorkerChannel's bounded run-ending continuation stays inside
						// this send and must never consume another supervisor round.
						result.roundsUsed += 1;
						claim.attempt.promptText = workerText;
						promptResult = claim.attempt.channel.send(workerText, _signal);
						claim.attempt.promptResult = promptResult;
						claim.attempt.promptConsumption = undefined;
						return { kind: "sent" as const };
					}));
					if (sent.kind !== "sent") {
						const text = sent.kind === "max-rounds"
							? `Maximum rounds (${req.maxRounds}) reached. You must call finish_delegation now.`
							: sent.kind === "busy"
								? "The worker is already busy; call wait_for_worker or finish_delegation."
								: sent.kind === "aborted"
									? "The subagent has been cancelled; call restart_worker or finish_delegation."
									: "The worker attempt was replaced; use the active successor.";
						return {
							content: [{ type: "text" as const, text }],
							details: { kind: sent.kind, workerSessionFile: existingWorkerSessionFile(claim.attempt.session.sessionFile) },
						};
					}
					workerCall = await withWorkerEnv(() => promptResult);
					attemptOperation("prompt", "released", claim.attempt.generation);
				} catch (error) {
					try { attemptBoundary("released", "prompt", claim.attempt.generation); } catch { /* diagnostics only */ }
					const credentialRetry = await retryThrownCredentialLock(error, claim.attempt, workerText, _signal);
					if (credentialRetry) {
						return await consumeWorkerCallResult(
							credentialRetry.call,
							claim.attempt,
							credentialRetry.source,
						);
					}
					const transportError = String((error as Error)?.message ?? error);
					if (isCapacityFailureMessage(transportError)) {
						const capacityCall = capacityFailureCall(transportError, workerText, claim.attempt);
						const source = Promise.resolve(capacityCall);
						return await consumeWorkerCallResult(capacityCall, claim.attempt, source);
					}
					const transientFailure = isTransientWorkerErrorMessage(transportError);
					if (shouldReplaceAttemptForRoute(transportError) && await isCurrentAttempt(claim.attempt)) {
						const replacement = await replaceWorkerAttempt({
							message: workerText,
							retirementReason: "transient-fallback",
							originAttempt: claim.attempt,
							transientFailure: true,
							countRound: false,
						});
						if (replacement.kind === "stale") {
							return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
						}
						if (replacement.kind !== "no-fallback") {
							if (!replacement.call || !replacement.attempt) {
								return { content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }], details: { kind: "finished" as const } };
							}
							return await consumeWorkerCallResult(
								replacement.call,
								replacement.attempt,
								replacement.source!,
							);
						}
					}
					workerTerminalFailure = true;
					result.status = "failed";
					const workerSessionFile = existingWorkerSessionFile(claim.attempt.session.sessionFile);
					const recoveredText = getLastAssistantText(claim.attempt.session.messages as AgentMessage[]).trim();
					const terminalError = workerSessionFile
						? `${transportError} (worker session: ${workerSessionFile})`
						: transportError;
					result.failureCause = classifyWorkerFailureCause(transportError);
					result.error = transientFailure ? markNoModelAlternative(terminalError) : terminalError;
					if (transientFailure) result.retryKind = "transient";
					if (recoveredText) {
						result.recoveredOutput = true;
						result.collapsedContent = formatRecoveredWorkerOutput(
							recoveredText,
							result.error ?? terminalError,
							workerSessionFile,
						);
					}
					emit({ status: "failed", error: result.error, workerSessionFile, recoveredOutput: result.recoveredOutput });
					queueMicrotask(() => { cloneSession?.abort().catch(() => {}); });
					throw error;
				}
				try { attemptBoundary("released", "prompt", claim.attempt.generation); } catch { /* diagnostics only */ }
				if (!(await isCurrentAttempt(claim.attempt))) {
					return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
				}
				return await consumeWorkerCallResult(workerCall, claim.attempt, promptResult);
			},
		};

		const waitForWorkerTool: any = {
			name: CLONE_WAIT_TOOL,
			label: "Wait for subagent",
			description:
				"Keep waiting for the in-flight subagent prompt to produce a reply. Use this after a `message_subagent` or `wait_for_worker` call returned a heartbeat status instead of a reply. Does not count against max_rounds. If the worker has no pending prompt, this returns 'idle' immediately.",
			parameters: Type.Object({}),
			execute: async (
				_toolCallId: string,
				_params: Record<string, never>,
				_signal?: AbortSignal,
			) => {
				// awaitReply() schedules the next heartbeat timer. Enter the worker
				// overlay before re-arming so timer callbacks and their asynchronous
				// wind-down steering inherit the effective worker environment.
				const claim = await withWorkerEnv(() => withWorkerTransition(() => {
					const attempt = workerAttempt;
					if (!attempt) throw new Error("Worker channel not initialised");
					if (attempt.retiring || teardownStarted) return { kind: "retiring" as const, attempt };
					if (attempt.channel.getState() === "aborted") return { kind: "aborted" as const, attempt };
					if (!attempt.channel.isBusy()) return { kind: "idle" as const, attempt };
					const promptResult = attempt.promptResult ?? attempt.channel.awaitReply();
					attempt.promptResult = promptResult;
					return { kind: "wait" as const, attempt, promptResult };
				}));
				if (claim.kind !== "wait") {
					const text = claim.kind === "aborted"
						? "The subagent is aborted — call restart_worker or finish_delegation."
						: claim.kind === "idle"
							? "Worker is idle. Use message_subagent to send a new task."
							: "The worker is being replaced; wait for the replacement to become active.";
					return {
						content: [{ type: "text" as const, text }],
						details: { kind: claim.kind, workerSessionFile: existingWorkerSessionFile(claim.attempt.session.sessionFile) },
					};
				}
				const workerCall = await withWorkerEnv(() => claim.promptResult);
				if (!(await isCurrentAttempt(claim.attempt))) {
					return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
				}
				return await consumeWorkerCallResult(workerCall, claim.attempt, claim.promptResult);
			},
		};

		// ── B.3 inspect_worker ─────────────────────────────────────────────────
		// Read-only snapshot of worker state. Safe to call any time (including
		// from the aborted state — the supervisor can still see the last known
		// active tool + recent tail). Does NOT bump roundsUsed.
		const inspectWorkerTool: any = {
			name: CLONE_INSPECT_TOOL,
			label: "Inspect subagent",
			description:
				"Read-only snapshot of the subagent's current state — state, silence duration, consecutive heartbeats, active tool call, and a short tail of recent transcript activity. Safe to call at any time (including after a heartbeat or an abort). Does not count against max_rounds. Use it to decide whether to `wait_for_worker`, `cancel_worker`, or `restart_worker`.",
			parameters: Type.Object({}),
			execute: async (
				_toolCallId: string,
				_params: Record<string, never>,
				_signal?: AbortSignal,
			) => {
				return await withWorkerTransition(() => {
					const attempt = workerAttempt;
					if (!attempt) throw new Error("Worker channel not initialised");
					return buildInspectToolResult(
						attempt.channel.inspect(),
						escalationEnabled ? pendingSupervisorEscalationIds() : undefined,
					);
				});
			},
		};

		// ── B.3 cancel_worker ──────────────────────────────────────────────────
		// Terminal: supervisor explicitly aborts the worker. Does NOT bump
		// roundsUsed (the cancel itself is a state change, not a delegation
		// turn). The supervisor must still call `finish_delegation` to collapse
		// the fork; the collapse path honours `workerCancelled` to preserve
		// `status:"aborted"` + `cancelReason:"supervisor"` regardless of
		// whatever payload `finish_delegation` carries.
		const cancelWorkerTool: any = {
			name: CLONE_CANCEL_TOOL,
			label: "Cancel subagent",
			description:
				"Terminal. Abort the subagent session immediately. Use when the tail from `inspect_worker` or a heartbeat shows the worker is unrecoverably stuck and you don't want to start over. After this you MUST call `finish_delegation` to collapse the fork; the fork will be reported as aborted regardless of the finish payload.",
			parameters: Type.Object({
				reason: Type.Optional(
					Type.String({
						description:
							"Short reason for the cancel (e.g. 'stuck in pytest loop'). Threaded into the fork's error field for post-hoc diagnostics.",
					}),
				),
			}),
			execute: async (
				_toolCallId: string,
				params: { reason?: string },
				_signal?: AbortSignal,
			) => {
				return await withWorkerTransition(async () => {
					const attempt = workerAttempt;
					if (!attempt) throw new Error("Worker channel not initialised");
					// Check before latching retiring. An already-aborted attempt must
					// remain restartable; cancel/cancel must not poison its successor.
					if (attempt.channel.getState() === "aborted") {
						return {
							content: [{ type: "text" as const, text: "Subagent already aborted. Call `finish_delegation` or `restart_worker`." }],
							details: { kind: "already-aborted" as const, workerSessionFile: existingWorkerSessionFile(attempt.session.sessionFile) },
						};
					}
					attempt.retiring = true;
					await abortAttemptAndWait(attempt, "supervisor");
					attempt.retiring = false;
					workerCancelled = true;
					result.status = "aborted";
					result.cancelReason = "supervisor";
					result.error = params.reason ? `Cancelled by supervisor: ${params.reason}` : "Cancelled by supervisor";
					emit({ status: "aborted", error: result.error });
					const msg = params.reason
						? `Subagent cancelled (${params.reason}). Call \`finish_delegation\` now.`
						: "Subagent cancelled. Call `finish_delegation` now.";
					return {
						content: [{ type: "text" as const, text: msg }],
						details: { kind: "cancelled" as const, reason: params.reason, workerSessionFile: existingWorkerSessionFile(attempt.session.sessionFile) },
					};
				});
			},
		};

		// ── B.3 restart_worker ───────────────────────────────────────────────
		// Aborts the current worker (idempotent) and spins up a fresh session
		// with the SAME agent/model/thinking, then sends `newMessage`. Counts
		// as a round. Valid from any state (including `aborted` — that's the
		// whole point of recovery).
		const restartWorkerTool: any = {
			name: CLONE_RESTART_TOOL,
			label: "Restart subagent",
			description:
				"Abort the current subagent session and start a fresh one with the same agent/model, then send `newMessage` to the new worker. Use when the worker is stuck but the task is still worth attempting from a clean slate. Counts as one round. The new worker has no memory of prior rounds — re-state anything it needs to know.",
			parameters: Type.Object({
				newMessage: Type.String({
					description:
						"Initial message for the fresh subagent session. Include any context that the previous session had learned and that the new one needs to re-do the task (or do it differently).",
				}),
			}),
			execute: async (
				_toolCallId: string,
				params: { newMessage: string },
				_signal?: AbortSignal,
			) => {
				const originAttempt = await withWorkerTransition(() => workerAttempt);
				const replacement = await replaceWorkerAttempt({
					message: params.newMessage,
					retirementReason: "restart_worker",
					originAttempt,
					countRound: true,
				});
				if (replacement.kind === "max-rounds") {
					// Forced-finish signal — same contract as the message_subagent
					// refusal above: the supervisor wanted to continue, we said no.
					roundRefusalIssued = true;
					return {
						content: [
							{
								type: "text" as const,
								text: `Max rounds (${req.maxRounds}) reached. Call \`finish_delegation\` now — you cannot restart_worker further.`,
							},
						],
						details: { kind: "max-rounds" as const },
					};
				}
				if (replacement.kind === "stale") {
					return {
						content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }],
						details: { kind: "stale-attempt" as const },
					};
				}
				if (!replacement.call || !replacement.attempt) {
					return { content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }], details: { kind: "finished" as const } };
				}
				workerHeartbeatAborted = false;
				workerCancelled = false;
				return await consumeWorkerCallResult(
					replacement.call,
					replacement.attempt,
					replacement.source!,
				);

			},
		};

		/**
		 * Post-process a `WorkerCallResult` from `send()` or `awaitReply()` into
		 * the AgentTool-shaped result returned to the supervisor. Runs the
		 * harness guard only on `reply`; usage is recorded for every variant that
		 * carries finalized request-scoped messages. A heartbeat carries none,
		 * while a failed or aborted prompt may retain messages harvested before
		 * its transport settled. Closure over `workerSession`, `result`, `emit`,
		 * etc. mirrors the original inline body.
		 */
		const handleWorkerCallResult = async (
			call: WorkerCallResult,
			attempt: WorkerAttempt,
		) => {
			if (
				workerAttempt !== attempt ||
				workerAttempt?.generation !== attempt.generation ||
				attempt.retiring ||
				teardownStarted
			) {
				return {
					content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }],
					details: { kind: "stale-attempt" as const, workerSessionFile: existingWorkerSessionFile(attempt.session.sessionFile) },
				};
			}
			const toolCtx = {
				round: result.roundsUsed,
				workerSessionFile: existingWorkerSessionFile(attempt.session.sessionFile),
				...(escalationEnabled
					? { pendingEscalationRequestIds: pendingSupervisorEscalationIds() }
					: {}),
			};
			const recordWorkerCallUsage = (messages: readonly AgentMessage[]): void => {
				for (const message of messages) {
					if (message.role !== "assistant" || !message.usage) continue;
					const normalized = normalizeUsageCounters({
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
						cost: message.usage.cost?.total,
					});
					result.usage.workerInput = saturatingAdd(result.usage.workerInput, normalized.usage.input ?? 0);
					result.usage.workerOutput = saturatingAdd(result.usage.workerOutput, normalized.usage.output ?? 0);
					const cacheRead = normalized.usage.cacheRead ?? 0;
					const cacheWrite = normalized.usage.cacheWrite ?? 0;
					if (cacheRead) result.usage.workerCacheRead = saturatingAdd(result.usage.workerCacheRead ?? 0, cacheRead);
					if (cacheWrite) result.usage.workerCacheWrite = saturatingAdd(result.usage.workerCacheWrite ?? 0, cacheWrite);
					result.usage.cost = saturatingAdd(result.usage.cost, normalized.usage.cost ?? 0);
					if (normalized.diagnostics.length > 0) {
						result.usage.diagnostics = diagnosticsWithGenerated(
							result.usage.diagnostics,
							normalized.diagnostics,
						);
					}
				}
			};
			if (call.kind === "reply") {
				capturePromptRepairs(workerSessionMgr?.getEntries?.() ?? []);
				lastWorkerText = call.text;
				workerCancellationOnly = call.harvest.kind === "missing";
				const after = call.newMessages;

				// Worker tool-harness guard: if the subagent has produced ZERO real
				// `toolCall` content blocks across the fork and its final text matches
				// the narrated-tool-call pattern (fenced ```bash / JSON skeleton /
				// `bash: ...` inline), fail fast instead of burning rounds on a
				// model that is going to keep hallucinating calls. Legitimate
				// prose-only replies from reviewer agents are not affected
				// because `looksLikeWorkerToolCallNarration` requires a
				// structural marker. We signal the failure by flipping a flag
				// and aborting the clone — pi-agent-core catches throws from
				// tool.execute and converts them into toolResult/isError, which
				// wouldn't exit the agent loop.
				const workerToolUsesThisRound = countAssistantToolUses(after);
				cumulativeWorkerToolUses += workerToolUsesThisRound;
				if (cumulativeWorkerToolUses === 0 && looksLikeWorkerToolCallNarration(lastWorkerText)) {
					const harnessError =
						"Worker tool-harness failure: subagent emitted tool calls as narrated text " +
						"(fenced code blocks or JSON skeletons) instead of invoking tools. " +
						"This is typically a transient model regression — retry with a fresh fork, " +
						"a different model, or a lower thinking level.";
					if (hasWorkerModelAlternatives(modelCursor, req.agent) && isTransientWorkerErrorMessage(harnessError) && attempt.promptText !== undefined) {
						const replacement = await replaceWorkerAttempt({
							message: attempt.promptText,
							retirementReason: "transient-fallback",
							originAttempt: attempt,
							transientFailure: true,
							countRound: false,
						});
						if (replacement.kind === "stale") {
							return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
						}
						if (replacement.kind !== "no-fallback") {
							if (!replacement.call || !replacement.attempt) {
								return { content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }], details: { kind: "finished" as const } };
							}
							return await consumeWorkerCallResult(
								replacement.call,
								replacement.attempt,
								replacement.source!,
							);
						}
					}
					workerHarnessFailure = true;
					result.status = "failed";
					result.error = markNoModelAlternative(harnessError);
					emit({ lastWorkerText, status: "failed", error: result.error });
					queueMicrotask(() => {
						cloneSession?.abort().catch(() => {});
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Worker tool-harness failure: subagent narrated a tool call instead of invoking it. Aborting.`,
							},
						],
						details: {
							round: result.roundsUsed,
							workerSessionFile: existingWorkerSessionFile(attempt.session.sessionFile),
							harnessFailure: true,
						},
					};
				}

				recordWorkerCallUsage(after);
				const delegateOnlyMode = getActiveDelegateOnlyMode();
				const workerKey = existingWorkerSessionFile(attempt.session.sessionFile) ?? req.name;
				if (
					delegateOnlyMode &&
					call.harvest.kind === "substantive" &&
					shouldRequestShorterResult(call.text, workerKey)
				) {
					const shorterResultPrompt =
						`Your result exceeded the delegate-only advisory budget of ${delegateOnlyMode.config.resultAdvisoryBytes} bytes. ` +
						"Return a shorter result now, keeping it within that byte budget.";
					attempt.promptText = shorterResultPrompt;
					const shorterResultSource = attempt.channel.send(shorterResultPrompt, fctx.signal);
					attempt.promptResult = shorterResultSource;
					const shorterResultCall = await shorterResultSource;
					return await handleWorkerCallResult(shorterResultCall, attempt);
				}
				emit({ lastWorkerText, status: "running" });
				return buildToolResultFromWorkerCall(call, toolCtx);
			}
			if (call.kind === "failed") {
				lastWorkerText = call.text;
				// Preserve usage from every finalized request before any same-request retry.
				recordWorkerCallUsage(call.newMessages);
				const credentialRetry = await retryCredentialWorkerCall(call, attempt);
				if (credentialRetry) {
					return await handleWorkerCallResult(credentialRetry, attempt);
				}
				if (call.errorKind === "refusal") {
					const currentPromptRepairEntries = workerSessionMgr?.getEntries?.() ?? [];
					capturePromptRepairs(currentPromptRepairEntries);
					const fallbackPrompt = promptRepairFallbackPromptFromEntries(currentPromptRepairEntries) ?? call.promptText;
					const replacement = await replaceWorkerAttempt({
						message: fallbackPrompt,
						retirementReason: "refusal-fallback",
						originAttempt: attempt,
						refusalModelRef: workerModelRef,
						countRound: false,
					});
					if (replacement.kind === "stale") {
						return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
					}
					if (replacement.kind !== "no-fallback") {
						if (!replacement.call || !replacement.attempt) {
							return { content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }], details: { kind: "finished" as const } };
						}
						result.errorKind = undefined;
						return await consumeWorkerCallResult(
							replacement.call,
							replacement.attempt,
							replacement.source!,
						);
					}
					workerTerminalFailure = true;
					result.status = "failed";
					result.error = call.error;
					result.errorKind = "refusal";
					emit({
						lastWorkerText,
						status: "failed",
						error: result.error,
						errorKind: result.errorKind,
						refusalModels: result.refusalModels,
					});
					queueMicrotask(() => {
						cloneSession?.abort().catch(() => {});
					});
					return buildToolResultFromWorkerCall(call, toolCtx);
				}
				// Capacity fallback is not worker replacement. It first proves that the
				// live provider context can continue without replay, then changes only the
				// session model (when a distinct route remains) and renews the terminal
				// WorkerChannel wrapper. Auth, refusal, and ordinary transient behavior
				// remain on their existing paths.
				const capacityFailure = isCapacityFailureMessage(call.error);
				const transientFailure = isTransientWorkerErrorMessage(call.error) || capacityFailure;
				let terminalCall = call;
				const failClosedCapacity = (detail: string) => {
					const error = detail.startsWith("capacity fallback could not continue safely:")
						? detail
						: `capacity fallback could not continue safely: ${detail}`;
					const failedCall: Extract<WorkerCallResult, { kind: "failed" }> = {
						...terminalCall,
						text: error,
						error,
						harvest: { kind: "failure", error },
						errorKind: undefined,
					};
					lastWorkerText = error;
					workerTerminalFailure = true;
					result.status = "failed";
					result.failureCause = "provider-capacity";
					result.retryKind = undefined;
					result.errorKind = undefined;
					result.error = error;
					emit({ lastWorkerText, status: "failed", error, failureCause: result.failureCause });
					queueMicrotask(() => { cloneSession?.abort().catch(() => {}); });
					return buildToolResultFromWorkerCall(failedCall, toolCtx);
				};
				if (!capacityFailure && shouldReplaceAttemptForRoute(call.error)) {
					const replacement = await replaceWorkerAttempt({
						message: call.promptText,
						retirementReason: "transient-fallback",
						originAttempt: attempt,
						transientFailure: true,
						countRound: false,
					});
					if (replacement.kind === "stale") {
						return { content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }], details: { kind: "stale-attempt" as const } };
					}
					if (replacement.kind !== "no-fallback") {
						if (!replacement.call || !replacement.attempt) {
							return { content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }], details: { kind: "finished" as const } };
						}
						result.errorKind = undefined;
						return await consumeWorkerCallResult(
							replacement.call,
							replacement.attempt,
							replacement.source!,
						);
					}
				}
				if (capacityFailure) {
					let inspection = inspectCapacityContinuation(attempt.session, call.error, capacityContinuationSignal);
					if (inspection.ok === false) return failClosedCapacity(inspection.detail);

					// Consume a distinct route only after the continuation boundary passes
					// every safety check. A refusal here must not spend the model cursor.
					const nextChoice = shouldAdvanceLadderForRouteFailure(call.error, modelCursor, req.agent)
						? nextWorkerModel()
						: undefined;
					if (nextChoice) {
						try {
							const continued = await continueCapacityWorkerCall(
								call,
								attempt,
								inspection.snapshot,
								nextChoice,
							);
							result.errorKind = undefined;
							return await handleWorkerCallResult(continued, attempt);
						} catch (error) {
							if (capacityContinuationSignal.aborted) throw error;
							return failClosedCapacity(error instanceof Error ? error.message : String(error));
						}
					}

					const capacityRetryDelaysMs = [1_000, 2_000, 4_000] as const;
					const maxCapacityRetries = 3;
					const maxCapacityRetryWaitMs = 7_000;
					const retryClock: WorkerChannelClock = fctx.workerChannelClock ?? {
						now: () => Date.now(),
						setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
						clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
					};
					const retryBudgetStartedAt = retryClock.now();
					let retryCount = 0;
					let cumulativeWaitMs = 0;
					let currentCall = call;
					const currentAttempt = attempt;
					const staleRetryResult = () => ({
						content: [{ type: "text" as const, text: "The worker attempt was replaced; use the active successor." }],
						details: { kind: "stale-attempt" as const },
					});
					const finishingRetryResult = () => ({
						content: [{ type: "text" as const, text: "The fork is finishing; call finish_delegation." }],
						details: { kind: "finished" as const },
					});
					const retryGuardResult = async (): Promise<ReturnType<typeof staleRetryResult> | ReturnType<typeof finishingRetryResult> | undefined> => {
						if (fctx.signal?.aborted || finishRequested || teardownStarted) return finishingRetryResult();
						if (!(await isCurrentAttempt(currentAttempt))) return staleRetryResult();
						return undefined;
					};
					while (retryCount < maxCapacityRetries && retryCount < capacityRetryDelaysMs.length) {
						const retryDelayMs = capacityRetryDelaysMs[retryCount]!;
						if (cumulativeWaitMs + retryDelayMs > maxCapacityRetryWaitMs) break;
						if (retryClock.now() - retryBudgetStartedAt + retryDelayMs > maxCapacityRetryWaitMs) break;
						const beforeWaitGuard = await retryGuardResult();
						if (beforeWaitGuard) return beforeWaitGuard;
						let timerHandle: unknown;
						let timerScheduled = false;
						let abortListener: (() => void) | undefined;
						const waitCompleted = await (async (): Promise<boolean> => {
							try {
								return await new Promise<boolean>((resolve) => {
									let settled = false;
									const settle = (completed: boolean): void => {
										if (settled) return;
										settled = true;
										resolve(completed);
									};
									abortListener = () => settle(false);
									if (fctx.signal?.aborted) {
										settle(false);
										return;
									}
									fctx.signal?.addEventListener("abort", abortListener, { once: true });
									if (fctx.signal?.aborted) {
										settle(false);
										return;
									}
									timerHandle = retryClock.setTimeout(() => settle(true), retryDelayMs);
									timerScheduled = true;
								});
							} finally {
								if (timerScheduled) retryClock.clearTimeout(timerHandle);
								if (abortListener) fctx.signal?.removeEventListener("abort", abortListener);
							}
						})();
						if (!waitCompleted) return finishingRetryResult();
						cumulativeWaitMs += retryDelayMs;
						if (retryClock.now() - retryBudgetStartedAt > maxCapacityRetryWaitMs) break;
						const afterWaitGuard = await retryGuardResult();
						if (afterWaitGuard) return afterWaitGuard;
						let continued: WorkerCallResult;
						try {
							continued = await continueCapacityWorkerCall(
								currentCall,
								currentAttempt,
								inspection.snapshot,
							);
						} catch (error) {
							if (capacityContinuationSignal.aborted) throw error;
							return failClosedCapacity(error instanceof Error ? error.message : String(error));
						}
						retryCount += 1;
						if (continued.kind === "failed" && isCapacityFailureMessage(continued.error)) {
							currentCall = continued;
							terminalCall = continued;
							lastWorkerText = continued.text ?? lastWorkerText;
							recordWorkerCallUsage(continued.newMessages);
							inspection = inspectCapacityContinuation(
								currentAttempt.session,
								continued.error,
								capacityContinuationSignal,
							);
							if (inspection.ok === false) return failClosedCapacity(inspection.detail);
							continue;
						}
						result.errorKind = undefined;
						return await handleWorkerCallResult(continued, currentAttempt);
					}
				}
				workerTerminalFailure = true;
				result.status = "failed";
				// Classify BEFORE markNoModelAlternative rewrites the message: the
				// capacity patterns match a complete provider diagnostic to its end.
				result.failureCause = classifyWorkerFailureCause(terminalCall.error);
				result.error = transientFailure ? markNoModelAlternative(terminalCall.error) : terminalCall.error;
				if (transientFailure) result.retryKind = "transient";
				result.errorKind = transientFailure ? "no-model-alternative" : terminalCall.errorKind;
				if (terminalCall.recoveredOutput && terminalCall.harvest.kind === "substantive") {
					result.recoveredOutput = true;
					result.collapsedContent = formatRecoveredWorkerOutput(
						terminalCall.harvest.text,
						result.error ?? terminalCall.error,
						toolCtx.workerSessionFile,
					);
				}
				emit({
					lastWorkerText,
					status: "failed",
					error: result.error,
					recoveredOutput: result.recoveredOutput,
				});
				queueMicrotask(() => {
					cloneSession?.abort().catch(() => {});
				});
				return buildToolResultFromWorkerCall(terminalCall, toolCtx);
			}
			// heartbeat / aborted: worker is still mid-flight (heartbeat) or just
			// terminated (aborted). Surface the status to the supervisor so it
			// can decide wait_for_worker vs finish_delegation.
			if (call.kind === "aborted") {
				if (call.newMessages) recordWorkerCallUsage(call.newMessages);
				if (call.harvest?.kind === "substantive") {
					lastWorkerText = call.harvest.text;
					workerRecoveredAbort = true;
					workerCancellationOnly = false;
					result.status = "aborted";
					result.cancelReason = call.reason;
					result.error = `Worker prompt aborted: ${call.reason}`;
					result.recoveredOutput = true;
					result.collapsedContent = formatRecoveredWorkerOutput(
						call.harvest.text,
						result.error,
						toolCtx.workerSessionFile,
					);
				}
			}
			if (call.kind === "aborted" && call.reason === "heartbeat") {
				// Stamp now so the final collapse path preserves the terminal
				// status even after the supervisor's finish_delegation runs.
				workerHeartbeatAborted = true;
				result.status = "aborted";
				result.cancelReason = "heartbeat";
				result.error = "cancelled: heartbeat timeout";
			}
			emit({ status: result.status });
			return buildToolResultFromWorkerCall(call, toolCtx);
		};

		/**
		 * Claim post-processing for one attempt/prompt while holding the
		 * transition gate. The deferred lets the gate release before the handler
		 * awaits a replacement, while duplicate waiters still receive the exact
		 * same tool result and cannot repeat usage/refusal/replacement effects.
		 */
		const consumeWorkerCallResult = async (
			call: WorkerCallResult,
			attempt: WorkerAttempt,
			source: Promise<WorkerCallResult>,
		): Promise<unknown> => {
			let owned = false;
			let consumed!: Promise<unknown>;
			await withWorkerTransition(() => {
				const prior = attempt.promptConsumption;
				if (prior?.source === source) {
					consumed = prior.result;
					return;
				}
				let resolve!: (value: unknown) => void;
				let reject!: (reason?: unknown) => void;
				consumed = new Promise<unknown>((res, rej) => {
					resolve = res;
					reject = rej;
				});
				attempt.promptConsumption = { source, result: consumed };
				owned = true;
				queueMicrotask(async () => {
					try {
						const value = await handleWorkerCallResult(call, attempt);
						if (call.kind === "heartbeat") {
							await withWorkerTransition(() => {
								if (attempt.promptResult === source) attempt.promptResult = undefined;
							});
						}
						resolve(value);
					} catch (error) {
						reject(error);
					}
				});
			});
			if (!owned) return consumed;
			return consumed;
		};

		const finishDelegationTool: any = {
			name: "finish_delegation",
			label: "Finish delegation",
			description:
				"End this delegation fork. Provide either `final_output` (the concrete answer to return to your main thread) or a concise `summary`. An explicitly configured summary_model may refine the summary from the full transcript; otherwise it is returned verbatim with no provider call. Exactly one field must be provided.",
			parameters: Type.Object({
				final_output: Type.Optional(
					Type.String({
						description:
							"The concrete, self-contained answer to return as the tool result in your main thread. Use when the main thread needs a specific output (code, list, answer).",
					}),
				),
				summary: Type.Optional(
					Type.String({
						description:
							"Concise, self-contained note describing what happened. It may be refined by an explicitly configured summary_model; without one, it becomes the final result verbatim.",
					}),
				),
			}),
			execute: async (
				_toolCallId: string,
				params: { final_output?: string; summary?: string },
			) => {
				if (!params.final_output && !params.summary) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Provide exactly one of `final_output` or `summary`. Call finish_delegation again.",
							},
						],
						details: {},
					};
				}
				return await withWorkerTransition(async () => {
					if (finishPayload) return { content: [{ type: "text" as const, text: FINISH_SENTINEL }], details: { finished: true } };
					finishRequested = true;
					finishPayload = { final_output: params.final_output, summary: params.summary };
					// The worker remains published until teardown; teardown owns its
					// final abort/disposal transition and session references stay live
					// for the normal completion path.
					// Abort the clone after publishing the sentinel so prompt() resolves.
				queueMicrotask(() => { cloneSession?.abort().catch(() => {}); });
				return {
					content: [{ type: "text" as const, text: FINISH_SENTINEL }],
					details: { finished: true },
					};
				});
			},
		};

		const supervisorEscalationTools = escalationEnabled
			? makeSupervisorEscalationTools({
				agentDir: fctx.agentDir,
				rootRunId,
				holderId: supervisorEscalationHolderId,
				holderAuthority: req.escalationPolicy!.config.authority,
				config: req.escalationPolicy!.config,
				credential: escalationCredential(),
			})
			: [];

		// ── Direct-first-turn delivery (#452) ───────────────────────────────────
		// When requested, the runtime delivers the caller's exact task to the
		// worker as its first turn — before the supervisor clone exists — by
		// driving the ordinary `message_subagent` send lifecycle (round
		// accounting, guidance drain, transient/refusal fallback, heartbeat, and
		// cancellation via `fctx.signal`), then waiting out heartbeats exactly as
		// `wait_for_worker` does. The captured reply seeds the supervisor with a
		// completed message_subagent exchange (below), so the supervisor's first
		// generated turn is a follow-up, never a re-issue of the task.
		if (taskDelivery === "direct-first-turn") {
			const directFirstTurnToolCallId = `dft-${req.name}`;
			const terminalDirectFirstTurn = (status: "failed" | "aborted", error: string): RunResult => {
				result.status = status;
				result.error = result.error ?? error;
				if (status === "aborted") {
					const reason = fctx.getCancelReason?.();
					if (reason) result.cancelReason = reason;
				}
				result.transcript = buildWorkerTranscript();
				if (!result.recoveredOutput) {
					result.collapsedContent = withSupervisorReport(result.error ?? error, undefined);
				}
				emit({
					status,
					error: result.error,
					lastWorkerText,
					workerSessionFile: result.workerSessionFile,
					recoveredOutput: result.recoveredOutput,
				});
				return result;
			};
			let firstTurn: { content?: unknown; details?: { kind?: string } } | undefined;
			try {
				firstTurn = await messageSubagentTool.execute(
					directFirstTurnToolCallId,
					{ text: req.task },
					fctx.signal,
					{ skipGuidanceDrain: true },
				);
				while (firstTurn?.details?.kind === "heartbeat" && !fctx.signal?.aborted) {
					firstTurn = await waitForWorkerTool.execute(directFirstTurnToolCallId, {}, fctx.signal);
				}
			} catch (error) {
				const message = String((error as Error)?.message ?? error);
				const aborted = fctx.signal?.aborted === true || /abort/i.test(message);
				return terminalDirectFirstTurn(
					aborted ? "aborted" : "failed",
					aborted ? "Fork aborted during direct first-turn delivery" : message,
				);
			}
			if (fctx.signal?.aborted) {
				return terminalDirectFirstTurn("aborted", "Fork aborted during direct first-turn delivery");
			}
			if (result.status === "aborted") {
				return terminalDirectFirstTurn("aborted", result.error ?? "Worker aborted during direct first-turn delivery");
			}
			if (result.status === "failed") {
				return terminalDirectFirstTurn("failed", result.error ?? "Worker failed during direct first-turn delivery");
			}
			const firstTurnKind = firstTurn?.details?.kind;
			if (firstTurnKind === "aborted") {
				return terminalDirectFirstTurn("aborted", result.error ?? "Worker aborted during direct first-turn delivery");
			}
			if (firstTurnKind !== "reply") {
				return terminalDirectFirstTurn(
					"failed",
					result.error ?? `Worker produced no reply during direct first-turn delivery (kind=${firstTurnKind ?? "unknown"})`,
				);
			}
			const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
				typeof part === "object" && part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string";
			const rawReplyContent = firstTurn?.content;
			const replyContent = Array.isArray(rawReplyContent)
				? rawReplyContent.filter(isTextPart).map((part) => ({ type: "text" as const, text: part.text }))
				: [];
			directFirstTurnExchange = {
				toolCallId: directFirstTurnToolCallId,
				toolName: CLONE_MESSAGE_TOOL,
				task: req.task,
				replyContent: replyContent.length > 0 ? replyContent : [{ type: "text" as const, text: lastWorkerText }],
			};
		}

		const seed = buildSeedMessages({
			mode: req.cloneMode,
			branchEntries: fctx.mainBranchEntries,
			fromToolCallId: fctx.fromToolCallId,
			agent: req.agent,
			forkName: req.name,
			task: supervisorSeedTask,
			taskDelivery,
			...(directFirstTurnExchange ? { directFirstTurn: directFirstTurnExchange } : {}),
			maxRounds: req.maxRounds,
			collapseMode: req.collapseMode,
			supervisorInstructions: req.supervisorInstructions,
			snippetLastN: req.snippetLastN,
			agentCwd: fctx.cwd,
		});

		// Minimal resource loader: NO extensions, NO skills, NO prompts, NO
		// themes. This prevents the delegate extension (or anything else)
		// from loading into the clone — which would otherwise:
		//   1. Register `delegate` inside the clone, enabling recursive
		//      delegation and token bloat.
		//   2. Run other extensions' event handlers (command-guard, etc.)
		//      per-fork, which is both unnecessary and potentially
		//      interfering.
		// We bake the main agent's system prompt + delegation framing in as
		// the override.
		const cloneSystemPromptBase =
			`${fctx.mainSystemPrompt}\n\n` +
			`## Delegation mode\n\nYou are currently in a forked sub-conversation whose only purpose is to delegate a subtask to a specialist subagent and iterate with them. ` +
			`You have exactly ${escalationEnabled ? "eight" : "six"} tools here:\n` +
			`- \`message_subagent(text)\` — send a prompt to the subagent. Consumes one round.\n` +
			`- \`wait_for_worker\` — re-await the in-flight prompt after a heartbeat. Does **not** consume a round.\n` +
			`- \`inspect_worker\` — read-only snapshot of worker state (safe any time, including from the aborted state). Does **not** consume a round.\n` +
			`- \`cancel_worker({reason?})\` — terminal. Abort the worker. You MUST call \`finish_delegation\` after.\n` +
			`- \`restart_worker({newMessage})\` — abort the current worker and spin up a fresh session with the same agent/model, then send \`newMessage\`. Consumes one round. Valid from any state, including aborted — this is your recovery path.\n` +
			(escalationEnabled ? `- \`resolve_escalation({requestId?, selected, note?})\` — resolve a pending request only within your declared authority.\n` : "") +
			(escalationEnabled ? `- \`escalate({requestIds?, context?, recommendation?})\` — “not mine; pass up” to the next holder.\n` : "") +
			`- \`finish_delegation\` — collapse the fork and stop.\n\n` +
			`Do not attempt to use any other tools — they do not exist in this fork. ` +
			`When the delegation is complete, call \`finish_delegation\` and stop.\n\n` +
			`### Handling a slow worker\n\n` +
			`\`message_subagent\`, \`wait_for_worker\`, and \`restart_worker\` can return three kinds of tool result:\n` +
			`- **reply** — the worker produced a new answer. Read it, decide next step as normal.\n` +
			`- **heartbeat** — the worker has been silent (no new transcript activity) for a while but is still running. ` +
			`The payload tells you how many heartbeats in a row (e.g. "2/5"), how long it has been silent, any active tool call, ` +
			`and a short tail of recent worker activity. Default action: call \`wait_for_worker\` to keep waiting. ` +
			`If the tail is ambiguous, call \`inspect_worker\` for a fresh snapshot before deciding. ` +
			`If the tail shows the worker is genuinely stuck and you don't want a clean retry, call \`cancel_worker\` then \`finish_delegation\`. ` +
			`If the task is worth another attempt from a fresh slate, call \`restart_worker({newMessage})\`.\n` +
			`- **aborted** — the worker session has been cancelled (by heartbeat auto-escalation, an explicit \`cancel_worker\`, or an external cancel). ` +
			`You have two valid moves: \`restart_worker({newMessage})\` for a fresh attempt, or \`finish_delegation\` to collapse with whatever partial answer you have.\n\n` +
			`### Heartbeat flow\n\n` +
			`1. If the recent tail clearly shows progress that just hasn't landed as a reply yet — \`wait_for_worker\`.\n` +
			`2. If the tail is ambiguous — \`inspect_worker\` for a fresh snapshot, then decide.\n` +
			`3. If the worker is clearly stuck and you want to start over — \`restart_worker({newMessage})\`.\n` +
			`4. If the worker is stuck and you have enough partial info to answer — \`cancel_worker\` + \`finish_delegation\`.\n` +
			`5. If you already have enough to answer without touching the worker — \`finish_delegation\`.\n\n` +
			`The system auto-cancels the worker after 5 consecutive heartbeats of silence (~15 min). Don't habitually cancel; but don't wait forever either. ` +
			`Do not call \`message_subagent\` again while a previous prompt is still in flight — use \`wait_for_worker\` for that.`;
		const cloneSystemPrompt = appendEscalationSupervisorGuidance(
			cloneSystemPromptBase,
			escalationEnabled,
		);
		const cloneLoader = await createSupervisorResourceLoader({
			cwd: fctx.cwd,
			agentDir: fctx.agentDir,
			systemPrompt: cloneSystemPrompt,
		});

		// The supervisor clone's tool surface is resolved separately through
		// `resolveRunToolSurface` (shape="supervised"). This role is the clone,
		// not the inner worker above, so allowNestedDelegate never leaks into the
		// clone harness. With no agent tools/
		// override, the default IS the 6-tool CLONE_* harness. The resolver
		// force-includes the custom tool NAMES in the allow-list (otherwise pi's
		// `new Set(options.tools)` filter would strip our customTools) and never
		// returns `[]` (the strip-everything foot-gun). See src/tool-surface.ts.
		const cloneCustomTools = [
			messageSubagentTool,
			waitForWorkerTool,
			inspectWorkerTool,
			cancelWorkerTool,
			restartWorkerTool,
			...supervisorEscalationTools,
			finishDelegationTool,
		];
		const cloneSurface = resolveRunToolSurface(req.agent, "supervised", {
			escalationPolicy: req.escalationPolicy,
			customToolNames: [
				CLONE_MESSAGE_TOOL,
				CLONE_WAIT_TOOL,
				CLONE_INSPECT_TOOL,
				CLONE_CANCEL_TOOL,
				CLONE_RESTART_TOOL,
				...supervisorEscalationTools.map((tool) => tool.name),
				CLONE_FINISH_TOOL,
			],
		});
		for (const d of cloneSurface.diagnostics)
			logDelegateDiagnostic(d, { agentDir: fctx.agentDir, throttleKey: "tool-surface" });
		const cloneCreate = await createAgentSession({
			cwd: fctx.cwd,
			agentDir: fctx.agentDir,
			model: cloneModel,
			...(cloneSurface.tools ? { tools: cloneSurface.tools } : {}),
			customTools: cloneCustomTools,
			sessionManager: SessionManager.inMemory(fctx.cwd),
			...childModelSessionOptions(fctx),
			resourceLoader: cloneLoader,
		});
		cloneSession = cloneCreate.session;
		if (fctx.signal?.aborted) throw new Error("aborted before fork prompt");
		if (fctx.sessionRefs) fctx.sessionRefs.clone = cloneSession;

		// Seed the clone's prior history (empty for task_only/snippet modes).
		if (seed.priorMessages.length > 0) {
			cloneSession.agent.state.messages = seed.priorMessages as any;
			// Replay the seeded history as transcript entries so the overlay
			// shows the supervisor's starting context immediately (before the
			// first `message_end` fires).
			if (fctx.onTranscriptEntry) {
				try {
					for (const e of messagesToTranscript(
						"supervisor",
						seed.priorMessages as AgentMessage[],
					)) {
						fctx.onTranscriptEntry(e);
					}
				} catch {
					/* transcript streaming is best-effort; never crash the fork. */
				}
			}
		}

		// Wire up supervisor actor activity, usage accumulation, and transcript.
		unsubscribeCloneActivity = cloneSession.subscribe((ev) => {
			try {
				supervisorActivityProjector?.handle(ev);
			} catch {
				// UI-only activity must never interrupt supervisor processing.
			}
			if (ev.type === "message_end") {
				if (ev.message?.role === "assistant") {
					const m = ev.message as any;
					if (m.usage) {
						const normalized = normalizeUsageCounters({
							input: m.usage.input,
							output: m.usage.output,
							cacheRead: m.usage.cacheRead,
							cacheWrite: m.usage.cacheWrite,
							cost: m.usage.cost?.total,
						});
						result.usage.supervisorInput = saturatingAdd(result.usage.supervisorInput, normalized.usage.input ?? 0);
						result.usage.supervisorOutput = saturatingAdd(result.usage.supervisorOutput, normalized.usage.output ?? 0);
						const cacheRead = normalized.usage.cacheRead ?? 0;
						const cacheWrite = normalized.usage.cacheWrite ?? 0;
						if (cacheRead) result.usage.supervisorCacheRead = saturatingAdd(result.usage.supervisorCacheRead ?? 0, cacheRead);
						if (cacheWrite) result.usage.supervisorCacheWrite = saturatingAdd(result.usage.supervisorCacheWrite ?? 0, cacheWrite);
						result.usage.cost = saturatingAdd(result.usage.cost, normalized.usage.cost ?? 0);
						if (normalized.diagnostics.length > 0) {
							result.usage.diagnostics = diagnosticsWithGenerated(
								result.usage.diagnostics,
								normalized.diagnostics,
							);
						}
					}
				}
				if (fctx.onTranscriptEntry && ev.message) {
					try {
						for (const e of messagesToTranscript(
							"supervisor",
							[ev.message as AgentMessage],
						)) {
							fctx.onTranscriptEntry(e);
						}
					} catch {
						/* swallow — transcript stream is best-effort. */
					}
				}
			}
		});

		// Worker transcript subscription is now installed inside
		// `buildWorkerSessionAndChannel` so each (session, channel) pair gets
		// its own unsubscribe handle; `restart_worker` calls the previous
		// unsubscribe before replacing.

		// Honour the external abort signal. `workerChannel.abort()` flips the
		// channel state to "aborted" and calls `workerSession.abort()`
		// internally; calling `workerSession.abort()` a second time from
		// elsewhere would be a no-op, so routing through the channel is safe.
		const abortHandler = () => {
			void withWorkerTransition(async () => {
				if (teardownStarted) return;
				const attempt = workerAttempt;
				if (attempt && !attempt.retiring) {
					attempt.retiring = true;
					await abortAttemptAndWait(attempt, fctx.getCancelReason?.() ?? "user");
					attempt.retiring = false;
				}
				cloneSession?.abort().catch(() => {});
			});
		};
		if (fctx.signal) {
			if (fctx.signal.aborted) abortHandler();
			else fctx.signal.addEventListener("abort", abortHandler, { once: true });
		}

		// Watchdog: if clone blows past max_rounds without calling finish_delegation,
		// force-abort after a few extra turns. Tracked via result.roundsUsed.
		// (message_subagent already refuses past the limit, so eventually the
		// clone either calls finish_delegation or hangs in a bad loop — if that
		// happens, the outer signal / Ctrl+C will kill it.)

		// Kick off the delegation. The framing text becomes the triggering user
		// message; the agent loop will then iterate tool calls until the clone
		// calls finish_delegation (which aborts the session).
		try {
			await promptWhenIdle(
				cloneSession,
				seed.triggerText,
				{ preflightResult: () => {} },
				{ signal: fctx.signal },
			);
		} catch (err: any) {
			// Worker tool-harness guard MUST be checked before finishPayload —
			// if the clone happened to race to finish_delegation after the guard
			// tripped (its abort is scheduled via microtask, same as
			// finish_delegation's), we still want to fail the fork rather than
			// collapse the bogus payload. Status + error are already set inside
			// message_subagent.execute; fall through to the harness-failure
			// early return below.
			if (workerHarnessFailure) {
				// fallthrough to harness-failure short-circuit
			} else if (finishPayload) {
				// Clean finish via finish_delegation.
			} else if (err?.name === "AbortError" || /abort/i.test(String(err?.message ?? err))) {
				result.status = "aborted";
				const reason = fctx.getCancelReason?.();
				if (reason) result.cancelReason = reason;
				if (reason === "timeout") timeoutAbortObserved = true;
				result.error = reason ? `Fork aborted (${reason})` : "Fork aborted";
			} else {
				throw err;
			}
		}

		// ── 3. Build transcript (supervisor + worker) ──────────────────────────
		// When the supervisor called `restart_worker` one or more times,
		// `result.priorWorkerSessions` holds each retired session's messages.
		// Interleave them into the collapsed transcript with synthetic
		// `worker:system` boundary entries so the main agent (and anyone
		// reviewing `result.transcript` post-hoc) sees the full attempt
		// history rather than just whatever the final session produced.
		// `role: "system"` is already a valid `TranscriptEntry.role` so
		// downstream consumers that filter on role keep working.
		result.transcript = buildWorkerTranscript();
		result.supervisorFinishPayload = finishPayload;
		// The timer may have won after promptWhenIdle resolved but before the
		// clone's finish payload was observed. Preserve timeout as first-writer-
		// wins and salvage only the live in-memory transcript.
		const timeoutResult = timeoutResultIfObserved();
		if (timeoutResult) {
			emit({ status: timeoutResult.status, error: timeoutResult.error, recoveredOutput: timeoutResult.recoveredOutput });
			return timeoutResult;
		}

		// ── 4. Collapse ────────────────────────────────────────────────────────
		// Worker tool-harness failure short-circuit: status + error are already
		// set inside `message_subagent.execute`. This check runs BEFORE the
		// `!finishPayload` branch because the clone may have raced to call
		// finish_delegation before our abort landed; we still want to fail the
		// fork rather than collapse the (bogus) payload.
		if (workerHarnessFailure) {
			result.collapsedContent = withSupervisorReport(
				result.error ?? "Worker tool-harness failure",
				finishPayload,
			);
			emit({ status: result.status, error: result.error });
			return result;
		}
		if (workerTerminalFailure || workerReplacementFailure) {
			const failureAlreadyEmitted = result.status === "failed";
			result.status = "failed";
			result.error = (result.error ?? lastWorkerText) || "Worker failed";
			// A recovered deliverable is the worker's own output and already carries
			// its own attribution banner, so it is left exactly as harvested.
			if (!result.recoveredOutput) {
				result.collapsedContent = withSupervisorReport(result.error, finishPayload);
			}
			if (!failureAlreadyEmitted) {
				emit({ status: result.status, error: result.error, lastWorkerText, workerSessionFile: result.workerSessionFile, recoveredOutput: result.recoveredOutput });
			}
			return result;
		}
		// A prompt transport can abort after assistant output has finalized. The
		// supervisor receives that output for inspection, but its subsequent
		// finish_delegation payload must not convert the terminal abort into a
		// clean completion or overwrite the recovered deliverable.
		if (workerRecoveredAbort) {
			result.status = "aborted";
			result.cancelReason = result.cancelReason ?? "supervisor";
			result.error = result.error ?? `Worker prompt aborted: ${result.cancelReason}`;
			if (result.cancelReason === "heartbeat") result.steered = true;
			result.supervisorFinishPayload = finishPayload;
			emit({
				status: "aborted",
				error: result.error,
				lastWorkerText,
				workerSessionFile: result.workerSessionFile,
				recoveredOutput: true,
			});
			return result;
		}
		// Heartbeat auto-abort short-circuit: `workerHeartbeatAborted` was
		// stamped inside `handleWorkerCallResult` when the channel escalated.
		// The supervisor may still have called finish_delegation (and that
		// payload is preserved in `supervisorFinishPayload`), but the fork
		// itself reports as `aborted` so this path doesn't get conflated with
		// a normal completion.
		if (workerHeartbeatAborted) {
			result.status = "aborted";
			result.cancelReason = "heartbeat";
			// A heartbeat abort always followed a wind-down steer (the channel
			// steers at max, then hard-aborts only past max+grace), so the parent
			// should know this answer was produced under wrap-up pressure.
			result.steered = true;
			result.error = result.error ?? "cancelled: heartbeat timeout";
			result.supervisorFinishPayload = finishPayload;
			const content =
				finishPayload?.final_output ||
				finishPayload?.summary ||
				lastWorkerText ||
				result.error;
			result.collapsedContent = content;
			emit({ status: "aborted", error: result.error });
			return result;
		}
		// Supervisor-cancel short-circuit: `workerCancelled` was stamped
		// inside `cancel_worker.execute`. Same shape as the heartbeat path
		// — preserves finishPayload for the transcript, but reports the fork
		// as aborted so a subsequent `finish_delegation({final_output})`
		// doesn't silently flip the status back to "completed".
		if (workerCancelled) {
			result.status = "aborted";
			result.cancelReason = result.cancelReason ?? "supervisor";
			result.error = result.error ?? "Cancelled by supervisor";
			result.supervisorFinishPayload = finishPayload;
			const content =
				finishPayload?.final_output ||
				finishPayload?.summary ||
				lastWorkerText ||
				result.error;
			result.collapsedContent = content;
			emit({ status: "aborted", error: result.error });
			return result;
		}
		// A cancellation-only worker turn remains non-terminal while the
		// supervisor is deciding what to do. If it chooses to finish without a
		// later substantive turn, classify the fork as failed rather than hiding
		// the missing deliverable behind the supervisor's final payload.
		if (workerCancellationOnly) {
			result.status = "failed";
			result.error = result.error ?? "No substantive assistant output recovered";
			result.collapsedContent = withSupervisorReport(result.error, finishPayload);
			emit({ status: result.status, error: result.error, lastWorkerText });
			return result;
		}
		// Wind-down provenance for clean finishes: if the worker channel issued
		// a wind-down steer at any point (worker went silent past the heartbeat
		// budget) but the worker then landed a final answer within the grace
		// window, the fork completes normally — but the parent still wants to
		// know it concluded under wrap-up pressure (REQ-WIND-5). The abort
		// short-circuits above set `steered` explicitly and already returned; the
		// remaining completion paths below all flow through here first.
		if (workerAttempt?.channel.getWindDownSteered()) {
			result.steered = true;
		}
		if (!finishPayload) {
			// Salvage path: well-behaved but non-compliant models often finish
			// the fork by producing a text-only assistant message instead of
			// calling finish_delegation. If the clone stopped cleanly with a
			// final text, treat that text as an implicit final_output.
			//
			// Exceptions that must NOT be salvaged (they indicate a broken fork,
			// not a legitimate answer):
			//   1. `roundsUsed === 0` — the supervisor never invoked the worker;
			//      any "final text" is just a restating of the task. A real answer
			//      requires at least one round of subagent work.
			//   2. The text is a stringified tool call for our own clone tools —
			//      the classic "no tools registered" fallback a model emits when
			//      the tool schema never reached the provider. Salvaging it
			//      silently returns the supervisor's would-be prompt back to the
			//      main thread as a "result", which is maximally confusing.
			//   3. stopReason === "aborted" — the clone was cancelled before it
			//      could finish. pi-agent-core swallows the AbortError into a clean
			//      promise resolution (see `handleRunFailure`), so the outer
			//      try/catch above never sees it. Detect the aborted stopReason
			//      here and stamp status="aborted" + cancelReason from fctx.
			const cloneMsgs = (cloneSession?.messages ?? []) as AgentMessage[];
			const lastAssistantText = getLastAssistantText(cloneMsgs);
			const lastMsg = cloneMsgs[cloneMsgs.length - 1] as any;
			const stopReason: string | undefined =
				lastMsg?.role === "assistant" ? lastMsg.stopReason : undefined;
			const assistantErrorMessage: string | undefined =
				lastMsg?.role === "assistant" ? lastMsg.errorMessage : undefined;
			const cleanStop = stopReason === "stop" || stopReason === "length";
			const zeroRounds = result.roundsUsed === 0;
			const textIsFakeToolCall = looksLikeSupervisorToolCallText(lastAssistantText);
			const wasAborted =
				stopReason === "aborted" || fctx.signal?.aborted === true || fctx.getCancelReason?.() !== undefined;
			if (wasAborted) {
				const reason = fctx.getCancelReason?.();
				const error = reason ? `Fork aborted (${reason})` : "Fork aborted";
				markAborted(error, lastAssistantText || lastWorkerText || `(No collapsed output: ${error})`);
				return result;
			}
			const salvageable =
				cleanStop &&
				lastAssistantText.trim().length > 0 &&
				!zeroRounds &&
				!textIsFakeToolCall;

			if (salvageable) {
				finishPayload = { final_output: lastAssistantText };
				result.supervisorFinishPayload = finishPayload;
				// Fall through to the normal collapse path below.
			} else {
				result.status = "failed";
				if (assistantErrorMessage) {
					result.error = assistantErrorMessage;
				} else if (textIsFakeToolCall) {
					result.error =
						"Fork supervisor emitted a tool call as plain text — the clone session likely has no tools registered. " +
						"This is a delegate configuration bug; please report it.";
				} else if (zeroRounds && cleanStop) {
					result.error =
						"Fork ended without calling message_subagent or finish_delegation (roundsUsed=0). " +
						"The supervisor produced no usable work to return.";
				} else {
					result.error = `Fork ended without finish_delegation (stopReason=${stopReason ?? "unknown"})`;
				}
				result.collapsedContent =
					(textIsFakeToolCall ? "" : lastAssistantText) ||
					lastWorkerText ||
					`(No collapsed output: ${result.error})`;
				emit({ status: result.status, error: result.error });
				return result;
			}
		}

		const effectiveCollapse: CollapseMode = finishPayload.summary
			? "summary"
			: finishPayload.final_output
				? "final_output"
				: req.collapseMode;

		// Spec 0019 / REQ-PAUSE-1,2 — honest-collapse detection. The supervisor
		// reached this clean-finish convergence (finishPayload is set), but if it
		// did so only because `message_subagent` / `restart_worker` REFUSED further
		// rounds at `max_rounds` and the supervisor was FORCED to call
		// finish_delegation, the fork is PAUSED mid-work, not done. We detect that
		// via the actual refusal signal (`roundRefusalIssued`), NOT a bare
		// `roundsUsed >= maxRounds` — a supervisor that spends exactly its round
		// budget and then finishes VOLUNTARILY genuinely completed (review
		// follow-up: the old count-based check branded that boundary case paused).
		// Finishing with rounds to spare stays "completed" (REQ-PAUSE-3), and we
		// do NOT touch the abort branches above (a hang → abort is already
		// honestly "aborted"). Gating only here, on the voluntary clean-finish path.
		const roundsExhausted = roundRefusalIssued;
		// REQ-PAUSE-2 — a literal, non-model-visible banner prepended to whatever
		// collapsedContent the collapse produced (final_output verbatim, the raw
		// supervisor hint, OR a summary model's rewrite). A summary model NEVER sees
		// this string, so it cannot paraphrase the honesty away; ptm-bridge pushes
		// collapsedContent verbatim to the parent's assistant block, so this is
		// parent reads. Qualitative phrasing only (NO descendant count — follow-up).
		const pausedBanner =
			`⚠️ PAUSED — supervisor reached max_rounds (${req.maxRounds}) and was ` +
			`forced to finish; it is NOT continuing autonomously. Re-dispatch or ` +
			`resume to make progress (paused mid sub-dispatch).\n\n`;
		/**
		 * Apply the honest-collapse override at a success exit. Call this in place
		 * of `result.status = "completed"` for EVERY clean-finish collapse exit
		 * (final_output + every summary-path exit) so the paused override + banner
		 * are applied uniformly as the LAST step before emit/return. When the fork
		 * is paused, the terminal status becomes "paused" and the banner is
		 * prepended to the already-set collapsedContent (preserving the collapse
		 * text beneath); otherwise it is a no-op clean "completed".
		 */
		const finalizeCleanCollapse = (): void => {
			if (roundsExhausted) {
				result.status = "paused";
				result.collapsedContent = pausedBanner + (result.collapsedContent ?? "");
			} else {
				result.status = "completed";
			}
		};

		if (effectiveCollapse === "final_output" && finishPayload.final_output) {
			result.collapsedContent = finishPayload.final_output;
			const lateTimeoutResult = timeoutResultIfObserved();
			if (lateTimeoutResult) {
				emit({ status: lateTimeoutResult.status, error: lateTimeoutResult.error, recoveredOutput: lateTimeoutResult.recoveredOutput });
				return lateTimeoutResult;
			}
			finalizeCleanCollapse();
			emit({ status: result.status });
			return result;
		}

		// Summary path — provider calls are explicit. A per-invocation ref wins
		// over the agent default; omission means return the supervisor's hint
		// without calling a model. Literal `auto` selects the stable built-in
		// Claude Haiku 4.5 destination and fails closed when it is unavailable.
		const configuredSummaryModelRef = req.summaryModelRef ?? req.agent.summaryModel;
		const summaryModel = resolveTextCompletionModel(
			fctx.modelRegistry,
			configuredSummaryModelRef,
			fctx.scopedModelRefs,
		);

		const supervisorHint =
			finishPayload.summary ||
			finishPayload.final_output ||
			lastWorkerText ||
			"(no output)";

		if (!summaryModel) {
			// Omission is the normal zero-provider-call mode, not a fallback failure.
			// Explicit but unavailable selections remain diagnostic so a typo or an
			// unavailable automatic Haiku destination cannot masquerade as model output.
			result.collapsedContent = supervisorHint;
			if (configuredSummaryModelRef !== undefined) {
				const scopeQualifier = fctx.scopedModelRefs
					? ` in active session scope (${describeModelScope(fctx.scopedModelRefs)})`
					: "";
				result.summaryFallbackReason =
					configuredSummaryModelRef === "auto"
						? `automatic summary model ${AUTO_TEXT_COMPLETION_MODEL_REF} unavailable${scopeQualifier}; using supervisor hint`
						: `configured summary model ${configuredSummaryModelRef} unavailable${scopeQualifier}; using supervisor hint`;
			}
			// Spec 0019 / REQ-PAUSE-2 — banner survives this summary-path exit too.
			const lateTimeoutResult = timeoutResultIfObserved();
			if (lateTimeoutResult) {
				emit({ status: lateTimeoutResult.status, error: lateTimeoutResult.error, recoveredOutput: lateTimeoutResult.recoveredOutput });
				return lateTimeoutResult;
			}
			finalizeCleanCollapse();
			emit({ status: result.status });
			return result;
		}

		result.summaryModelUsed = `${summaryModel.provider}/${summaryModel.id}`;

		try {
			const summarised = await summarizeTranscript({
				model: summaryModel,
				registry: fctx.modelRegistry,
				modelRuntime: fctx.modelRuntime,
				transcript: result.transcript,
				finalNote: finishPayload.summary ?? finishPayload.final_output,
				signal: fctx.signal,
			});
			const refusedToCollapse = isNonSummaryRefusal(summarised);
			if (summarised.trim().length === 0 || refusedToCollapse) {
				// Model succeeded (no throw) but did not produce a collapse. Either it
				// returned empty/whitespace output — a reasoning-only response, or a
				// provider that returned only tool calls — or it read the worker's
				// brief as its own assignment and declined it, in which case the
				// refusal would silently replace the fork's deliverable. Fall back
				// through the same chain used in the throw branch, but keep
				// status=completed since the fork itself is fine.
				//
				// The rejected text is logged rather than discarded silently: this
				// guard trades a small chance of rejecting a caveat-first summary for
				// never shipping a refusal as a result, and a wrong threshold has to
				// be visible to be corrected.
				const reason = refusedToCollapse
					? `summary model ${result.summaryModelUsed} declined the task instead of collapsing the transcript; ` +
						`falling back to supervisor hint (rejected opening: ${JSON.stringify(summarised.trim().slice(0, 120))})`
					: `summary model ${result.summaryModelUsed} returned empty text; falling back to supervisor hint`;
				logDelegateDiagnostic(`${reason} (fork=${req.name})`, { agentDir: fctx.agentDir, level: "log" });
				result.summaryFallbackReason = reason;
				result.collapsedContent = supervisorHint;
			} else {
				result.collapsedContent = summarised;
			}
			// Spec 0019 / REQ-PAUSE-2 — applied AFTER the summary model produced its
			// text, so the banner is prepended to the model's rewrite and the model
			// never had it in its input.
			const lateTimeoutResult = timeoutResultIfObserved();
			if (lateTimeoutResult) {
				emit({ status: lateTimeoutResult.status, error: lateTimeoutResult.error, recoveredOutput: lateTimeoutResult.recoveredOutput });
				return lateTimeoutResult;
			}
			finalizeCleanCollapse();
		} catch (err: any) {
			const reason =
				`summary model ${result.summaryModelUsed} failed: ${err?.message ?? err}; ` +
				"falling back to supervisor hint";
			result.summaryFallbackReason = reason;
			logDelegateDiagnostic(`${reason} (fork=${req.name})`, {
				agentDir: fctx.agentDir,
				level: "log",
			});
			result.collapsedContent = supervisorHint;
			const lateTimeoutResult = timeoutResultIfObserved();
			if (lateTimeoutResult) {
				emit({ status: lateTimeoutResult.status, error: lateTimeoutResult.error, recoveredOutput: lateTimeoutResult.recoveredOutput });
				return lateTimeoutResult;
			}
			finalizeCleanCollapse();
		}
		emit({ status: result.status });
		return result;
		} catch (err: any) {
			// A failed replacement still returns the retired attempt's ordered
			// transcript boundary before final teardown disposes the predecessor.
			result.transcript = buildWorkerTranscript();
			if (fctx.signal?.aborted) {
				markAborted(err?.message ?? "aborted before fork construction");
			} else {
				result.status = "failed";
				result.error = result.error ?? String(err?.message ?? err);
				if (!result.recoveredOutput) {
					result.collapsedContent = `Fork "${req.name}" failed: ${result.error}`;
				}
				emit({ status: result.status, error: result.error, workerSessionFile: result.workerSessionFile });
			}
			return result;
		} finally {
			await withWorkerTransition(async () => {
				if (teardownStarted) return;
				teardownStarted = true;
				const attempt = workerAttempt;
				workerAttempt = undefined;
				if (attempt) {
					attempt.retiring = true;
					try {
						await abortAttemptAndWait(attempt, fctx.getCancelReason?.() ?? "supervisor");
					} catch (error) {
						result.error ??= String((error as Error)?.message ?? error);
					}
					await disposeAttempt(attempt);
				}
				try { unsubscribeCloneActivity?.(); } catch { /* best effort */ }
				unsubscribeCloneActivity = undefined;
				try {
					if (cloneSession) await disposeWorkerSession(cloneSession);
				} catch { /* best effort */ }
			});
		}
	} finally {
		finalizeAndRecord();
	}
}

/**
 * Public entrypoint for running a supervised fork. Wraps `runForkInner` in
 * `runWithDepth` so a worker that recursively calls `delegate` (whether
 * via direct mode or another supervised fork) re-enters the depth guard
 * automatically through AsyncLocalStorage propagation.
 *
 * Mirrors `runDirectWorker`: on a `DepthGuardError` we return a synthetic
 * failed `RunResult` so the pumpRuns caller observes a uniform shape
 * across direct and supervised paths.
 */
export async function runFork(req: ForkRequest, fctx: ForkContext): Promise<RunResult> {
	assertReadOnlyValue(req.readOnly, `${req.name}.readOnly`);
	const mutationBaseline = captureMutationSnapshot(fctx.cwd);
	const credentialRetryClock: WorkerChannelClock = fctx.workerChannelClock ?? {
		now: Date.now,
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	// The public fork owns both one-shot latches across worker replacement and
	// every supervisor round. Inner request seams may consume, never reset, it.
	const credentialRetryBudget = createCredentialRetryBudget(
		credentialRetryClock,
		fctx.credentialRetryRandom,
	);
	const actorActivity = fctx.runId && process.env.PI_DELEGATE_CHILD !== "1"
		? createActorActivityPublisher(fctx.runId, fctx.forkName ?? req.name)
		: undefined;
	actorActivity?.publish("supervisor", { phase: "starting" });
	actorActivity?.publish("worker", { phase: "starting" });
	// Cleanup authority belongs to whoever ALLOCATED the leaf, so it does not
	// depend on a write-confinement extension being installed. An explicitly
	// unconfined worker installs none (#362 follow-up).
	let releaseAllocatedScratchLease: (() => void) | undefined;
	try {
		let request: ForkRequest;
		try {
			// Supervised requests do not publish artifacts, so they need no shared
			// per-worktree workspace or stale-read lock. Their private scratch keeps
			// the runner-owned, identity-checked recursive cleanup contract.
			request = req.scratchRoot
				? req
				: { ...req, scratchRoot: prepareWorkerScratchDir({ scope: "main", recursiveCleanup: true }) };
		} catch (error) {
			const message = `worker scratch allocation failed: ${error instanceof Error ? error.message : String(error)}`;
			return {
				name: req.name,
				agent: req.agent.name,
				agentSource: req.agent.source,
				task: req.task,
				status: "failed",
				roundsUsed: 0,
				maxRounds: req.maxRounds,
				collapseMode: req.collapseMode,
				collapsedContent: "",
				workerCwd: fctx.cwd,
				transcript: [],
				mutationReport: mutationReportFor(fctx.cwd, mutationBaseline),
				usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
				error: message,
			};
		}
		// Only a leaf THIS call allocated. A caller-supplied scratch root is
		// borrowed, and a borrower must never remove it: a chain hands one root to
		// every step, so releasing it here would delete a directory later steps
		// still read. Failing to obtain the lease is not a run failure — the
		// bounded stale sweep remains the backstop.
		if (!req.scratchRoot && request.scratchRoot) {
			releaseAllocatedScratchLease = acquireWorkerScratchCleanupLease(request.scratchRoot);
			if (!releaseAllocatedScratchLease) {
				logDelegateDiagnostic(
					`supervised fork "${req.name}" could not acquire the cleanup lease for its allocated scratch leaf ` +
						`(${request.scratchRoot}); continuing without immediate cleanup. The leaf identity may have changed ` +
						"or its filesystem may not enforce owner-only mode 0700; the bounded stale sweep remains the backstop.",
					{ agentDir: fctx.agentDir, throttleKey: "scratch-cleanup-lease-unavailable:supervised" },
				);
			}
		}
		// Seed the frame's lineage identity from the real run-id so the
		// serialized frame / lineagePath is addressable per-run (REQ-LIN-1),
		// not just keyed on the agent name. `undefined` defaultMax keeps the
		// standard DEFAULT_MAX_DEPTH.
		const result = await runWithDepth(
			request.agent.name,
			resolveDelegateOnlyDepth(request.agent.maxSubagentDepth),
			() => runForkInner(request, fctx, actorActivity, credentialRetryBudget),
			undefined,
			fctx.runId ? { runId: fctx.runId, childIndex: fctx.childIndex } : undefined,
			{ agentDir: fctx.agentDir },
		);
		result.mutationReport = mutationReportFor(fctx.cwd, mutationBaseline);
		return result;
	} catch (err: unknown) {
		if (err instanceof DepthGuardError) {
			const msg = boundHistoryErrorMessage(err.message ?? "depth-guard error");
			const busFrame = resolveBusFrame();
			try {
				recordPreflightFailure(fctx.agentDir, {
					runId: fctx.runId,
					rootRunId: busFrame?.rootRunId ?? fctx.runId ?? req.name,
					ownerSessionId: fctx.ownerSessionId,
					forkName: req.name,
					displayLabel: req.displayLabel,
					agent: req.agent.name,
					agentSource: req.agent.source,
					cwd: fctx.cwd,
					maxRounds: req.maxRounds,
					collapseMode: req.collapseMode,
					task: req.task,
					attempt: req.attempt ?? 1,
					...(req.retryOf ? { retryOf: req.retryOf } : {}),
					errorMessage: msg,
				});
			} catch (recordingError) {
				if (!(recordingError instanceof StateLockTimeoutError)) throw recordingError;
			}
			fctx.onRuntimeUpdate?.({ status: "failed", error: msg });
			fctx.onUpdate?.({
				name: req.name,
				status: "failed",
				currentRound: 0,
				maxRounds: req.maxRounds,
				error: msg,
			} as any);

			return {
				name: req.name,
				attempt: req.attempt ?? 1,
				agent: req.agent.name,
				agentSource: req.agent.source,
				task: req.task,
				status: "failed",
				roundsUsed: 0,
				maxRounds: req.maxRounds,
				collapseMode: req.collapseMode,
				collapsedContent: "",
				workerCwd: fctx.cwd,
				transcript: [],
				mutationReport: mutationReportFor(fctx.cwd, mutationBaseline),
				usage: {
					supervisorInput: 0,
					supervisorOutput: 0,
					workerInput: 0,
					workerOutput: 0,
					cost: 0,
				},
				error: msg,
			};
		}
		// Preserve callback and infrastructure exception semantics here. The
		// defensive pump catch synthesizes the terminal result and attaches the
		// observation-unavailable report when this boundary is crossed.
		throw err;
	} finally {
		// Runs after runForkInner's own teardown has disposed the worker attempt,
		// so this release is the one that drops the count to zero.
		try {
			releaseAllocatedScratchLease?.();
		} finally {
			actorActivity?.dispose();
		}
	}
}
