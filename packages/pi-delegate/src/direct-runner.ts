/**
 * Phase A direct-worker runner.
 *
 * `runDirectWorker` is the fire-and-forget counterpart to `runFork` /
 * `runSupervisedFork`: it brings up a worker `AgentSession`, sends one
 * user message, and returns the worker's last assistant text in a
 * `RunResult`-shaped payload. No supervisor clone is involved.
 *
 * Designed to be the destination for the new shapes:
 *   - `delegate({ agent, task })`         → 1 direct worker
 *   - `delegate({ tasks: [...] })`        → N direct workers (same pump)
 *   - `delegate({ chain: [...] })`        → Phase B; sequential direct workers
 *
 * Most of the worker bring-up is shared with `fork-runner.ts` via the
 * exported helpers (`buildWorkerLoaderOptions`,
 * `resolveThinkingLevel`,
 * `buildWorkerSessionDir`). Direct mode skips:
 *   - the `WorkerChannel` heartbeat machinery (no supervisor to receive
 *     heartbeats),
 *   - supervisor-clone seeding,
 *   - any of the multi-round `message_subagent` / `wait_for_worker` /
 *     `inspect_worker` / `cancel_worker` / `restart_worker` clone tools.
 *
 * The result is shaped to be drop-in compatible with `RunResult` so the
 * runtime registry, status widget, and transcript overlay don't need to
 * branch on mode.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import {
	type AgentSession,
	createAgentSession,
	type ExtensionUIContext,
	type ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "./agents.js";
import { artifactCheckFailure, artifactCheckRetryTask, runArtifactCheck } from "./artifact-check.js";
import { continueCapacityRequest, inspectCapacityContinuation } from "./capacity-continuation.js";
import {
	PARENT_TRANSCRIPT_SEARCH_TOOL_NAME,
	registerParentTranscriptSnapshot,
} from "./parent-transcript-search.js";
import { appendFocusToPrompt } from "./focus-seam.js";
import { TASK_PROGRESS_FIELD, appendTasksToPrompt, buildTaskLedger, readSeededTasks, taskProgressFieldsFromEntries, type TasksSeed } from "./task-seam.js";
import {
	applyWorkerSeeds,
	formatWorkerSeedAudit,
	formatStrippedClaimantWarning,
	usableToolNamesFromScope,
	isWorkerSeedPromptFallback,
} from "./worker-session-seeds.js";
import {
	actorActivitySilenceMs,
	createActorActivityPublisher,
	createAgentActivityProjector,
	onActorActivityObserved,
	type ActorActivityPublisher,
} from "./actor-activity.js";
import type { EnvOverrides } from "./env-overrides.js";
import { mergeEnvOverrides, withEnvOverrides } from "./env-overrides.js";
import { composeReadsBlock, formatReadsWarnings } from "./context-files.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import { assertReadOnlyValue, resolveWorkerWriteAuthority, workerWriteScopeInstruction } from "./write-confinement.js";
import { withDelegateOwnedExtensionBind } from "./delegate-session-scope.js";
import { disposeWorkerSession } from "./worker-session-lifecycle.js";
import { createIsolatedWorkerSettingsManager } from "./worker-settings.js";
import { currentLineageEnv, currentLineageEnvKeyNames, runWithDepth } from "./depth-guard.js";
import { LINEAGE_ENV, lineageAncestorPath, lineagePath } from "./lineage.js";
import type { DepthFrame } from "./depth-guard.js";
import {
	appendBusEvent,
	readBusEvents,
	readDescendantActivity,
	resolveBusFrame,
	type BusEventKind,
} from "./event-bus.js";
import { assertArtifactWriterCapability, resolveWorkerToolSurface } from "./tool-surface.js";
import { resolveDelegateOnlyDepth } from "./delegate-only/fork-policy.js";
import { shouldRequestShorterResult } from "./delegate-only/result-caps.js";
import { getActiveDelegateOnlyMode } from "./delegate-only/runtime-state.js";
import {
	nestedDelegatePolicyForAgent,
	type NestedDelegateCallerPolicy,
} from "./nested-delegate-policy.js";
import {
	buildWorkerSessionDir,
	prepareWorkerSessionResources,
	resolveThinkingLevel,
	WORKER_DELEGATION_FRAMING,
	type RunResult,
	type ForkWarning,
	refusedWriteWarning,
} from "./fork-runner.js";
import type { ResolvedBridge } from "./intercom-bridge.js";
import { DEFAULT_DIRECT_WORKER_SILENCE_TIMEOUT_MS } from "./config.js";
import {
	DEFAULT_WIND_DOWN_GRACE_MS,
	isHardCancelEnabled,
	type ResolvedRunTimeoutPolicy,
} from "./fork-timeout.js";
import {
	OutputFileError,
	acquireWorkerScratchCleanupLease,
	prepareWorkerScratchDir,
	readOutputFromFile,
	type ReadOutputFromFile,
} from "./output-file.js";
import {
	finishWorkerArtifactAttempt,
	openWorkerArtifact,
	openWorkerArtifactByPath,
	prepareWorkerArtifactAttempt,
	prepareWorkerArtifactWorkspace,
	publishWorkerArtifact,
	readWorkerArtifactCandidate,
	resolveWorkerArtifactWorkspace,
	WorkerArtifactStorageBusyError,
	WorkerArtifactUnavailableError,
	type OpenWorkerArtifact,
	type WorkerArtifactAttempt,
	type WorkerArtifactReference,
	type WorkerArtifactWorkspace,
} from "./artifact-workspace.js";
import { captureMutationSnapshot, mutationReportFor } from "./mutation-tracking.js";
import { boundHistoryErrorMessage, recordPreflightFailure, recordRun, type RunHistoryEntry } from "./run-history.js";
import { StateLockTimeoutError } from "./state-io.js";
import { diagnosticsWithGenerated, normalizeUsageCounters, saturatingAdd } from "./usage-rollup.js";
import { boundRunTimeoutTranscript, buildRunTimeoutCollapse } from "./fork-activity.js";
import { projectRunResult } from "./run-result-boundary.js";
import {
	PROMPT_REPAIR_ACTIVITY_CHANNEL,
	buildPromptRepairDelegateSeed,
	mergePromptRepairRecords,
	parsePromptRepairActivity,
	parsePromptRepairRecord,
	promptRepairFallbackPromptFromEntries,
	promptRepairTranscriptEntries,
	readPromptRepairRecords,
	shouldPreservePromptRepairActivity,
} from "./prompt-repair-seam.js";
import { messagesToTranscript, type TranscriptEntry } from "./summarize.js";
import {
	DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS,
	formatRecoveredWorkerOutput,
	promptWhenIdle,
	waitForCompactionBoundary,
	type WorkerChannelClock,
} from "./worker-channel.js";
import { abortWorkerCompaction, WorkerCompactionConsumer } from "./worker-compaction-seam.js";
import {
	classifyHarvestOutcome,
	createPromptLifecycleHarvest,
	formatRunEndingContinuationFailure,
	getLastAssistantMessageText,
	getLastAssistantText,
	RUN_ENDING_CONTINUATION_PROMPT,
	shouldAttemptHarvestContinuation,
	type HarvestOutcome,
	type PromptLifecycleHarvest,
	type PromptLifecycleHarvestResult,
} from "./harvest-outcome.js";
import type { RunFailureRecovery } from "./pending-wakes.js";
import type { CancelReason, RunLiveState } from "./runtime.js";
import type { EffectiveEscalationPolicy } from "./escalation-policy.js";
import type { ResolvedEscalationConfig } from "./config.js";
import {
	planWorkerModelRequests,
	shouldAdvanceLadderForRouteFailure,
	WorkerModelCursor,
	workerModelFailureMessage,
	type ModelScope,
	type WorkerModelChoice,
	type WorkerModelPlan,
} from "./model-selection.js";
import {
	CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE,
	classifyWorkerFailureCause,
	createCredentialRetryBudget,
	credentialRetryRemainingMs,
	formatNoModelAlternative,
	isCapacityFailureMessage,
	isCredentialStoreLockErrorMessage,
	isRefreshableRouteAuthFailureMessage,
	isRouteAuthFailureMessage,
	isTransientWorkerErrorMessage,
	sanitizedProviderId,
	sanitizedRouteAuthFailureMessage,
	sanitizedUnrefreshableRouteAuthFailureMessage,
	waitForCredentialStoreLockRetry,
	type CredentialRetryBudget,
} from "./refusal.js";
import {
	buildDirectEscalationParticipants,
	escalationWorkerInstructions,
	makeEscalationRaiseTools,
} from "./escalation-tools.js";
import {
	ASK_TOOL_NAME,
	makeWorkerAskRoutingTool,
	reconcileWorkerAskSurface,
	replaceLoadedAskTools,
} from "./worker-ask-routing.js";
import {
	installDirectExtensionToolDeadline,
	type DirectExtensionToolDeadlineController,
	type DirectExtensionToolDeadlineScheduler,
} from "./direct-extension-tool-deadline.js";
import {
	childModelSessionOptions,
	providerAuthReader,
	type ModelRuntimeLike,
} from "./sdk-model-runtime.js";

// `AgentMessage` isn't re-exported from the top-level pi-coding-agent.
type AgentMessage = any;

class DirectCapacityContinuationError extends Error {}

let standaloneWorkspaceHolderSequence = 0;

/**
 * Wrap-up steer delivered directly to a solo worker when its wall-clock budget
 * elapses (#287). A solo run has no supervisor clone to relay through, so this
 * addresses the worker itself and names no supervisor-only verb.
 */
export const DIRECT_WIND_DOWN_STEER =
	"[wind-down] You have reached this run's wall-clock budget. Stop starting new work and " +
	"produce your final answer NOW — this is a forced wrap-up. Report what you actually " +
	"completed and what you did not. You have a brief grace window before this run is hard-cancelled.";

/** One-shot wrap-up instruction for a direct worker that exceeded the default silence bound. */
export const DIRECT_SILENCE_WIND_DOWN_STEER =
	"[wind-down] This run has produced no observed activity for too long. Stop waiting or starting new work and " +
	"produce your final answer NOW — this is a forced wrap-up. Report what you actually " +
	"completed and what you did not. You have a brief grace window before this run is hard-cancelled.";

/** What the caller passes per-task. Mirrors the `{agent, task}` schema. */
export interface DirectRequest {
	/** Effective retry attempt, stamped at admission. */
	attempt?: number;
	/** Exact predecessor reference, trusted local runtime data only. */
	retryOf?: { runId: string; forkName: string };
	/** Unique addressing key for this run within a parallel batch. Defaults to agent.name. */
	name: string;
	/**
	 * Derived, NON-ADDRESSING label shown to humans (issues #151/#152). Absent
	 * on hand-built requests, where surfaces fall back to `name`.
	 */
	displayLabel?: string;
	/** Resolved AgentConfig. */
	agent: AgentConfig;
	/** Immutable model plan resolved at the dispatch boundary. */
	modelPlan?: WorkerModelPlan;
	/** Initial user task. */
	task: string;
	/**
	 * Checklist this dispatch carried (issue #226), parsed at the tool-arg
	 * boundary. Seeded into the worker's session before its first turn, or
	 * appended to its first message as markdown when nothing claims the
	 * seed channel.
	 */
	tasks?: TasksSeed;
	/** Session focus carried by the handoff namespace. */
	focus?: unknown;
	/** Grant this worker access to capped excerpts from the trusted parent snapshot. */
	parentTranscriptSearch?: boolean;
	/**
	 * Files to read into the worker's first message ahead of the task as
	 * `<context-file>` blocks. Resolved relative to the worker `cwd`.
	 * Empty array / undefined = no reads block.
	 */
	reads?: Array<string | WorkerArtifactReference>;
	/**
	 * Artifact filename relative to the per-worktree workspace's `artifacts/`
	 * directory. The final assistant text remains the worker handoff.
	 */
	artifact?: string;
	/** Shell command that validates the declared artifact before delivery. */
	check?: string;
	/**
	 * Per-run chain dir for progress.md writes. Optional; created on demand.
	 */
	chainDir?: string;
	/**
	 * Whether to update a `progress.md` file in the chain dir as the worker
	 * runs. Phase A: a single `[done] <name>` line is appended on success.
	 * Phase B will surface chain-step progression here.
	 */
	progress?: boolean;
	/**
	 * Phase 3c interactive routing flag. When true, the worker's extension
	 * runtime is bound to the supplied `workerUIContext` so command-guard
	 * confirmations are routed to the overlay; when false, the runtime
	 * stays on its default `noOpUIContext` identity (`hasUI === false`).
	 */
	interactive?: boolean;
	/** Maximum file size for reads blocks (bytes). Forwarded to context-files. */
	maxReadBytes?: number;
	/** Frozen slot policy prepared before dispatch; consumed by Phase 3b. */
	escalationPolicy?: EffectiveEscalationPolicy;
	/** Effective environment patch for this worker; never persisted in results. */
	env?: EnvOverrides;
	/** Additional absolute writable roots, resolved defensively against worker cwd. */
	writableRoots?: string[];
	/** Defaults to true; false explicitly disables the worker write guard. */
	confineWrites?: boolean;
	/** Optional enforced per-slot read-only boundary. */
	readOnly?: boolean;
	/**
	 * Resolved wall-clock budget for this solo worker (#287). `runDirectWorker`
	 * arms one deadline when the first worker session becomes steerable and keeps
	 * it across refusal fallbacks and later activity, matching the supervised
	 * contract. Carried here so the request fully describes the run and its policy.
	 */
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
	/** Private run scratch allocated once and reused across model fallbacks. */
	scratchRoot?: string;
}

/**
 * Caller-supplied environment for a direct run. Mirrors the relevant bits
 * of `ForkContext`; we keep the type narrow because direct mode doesn't
 * need (or want) the supervisor-related fields.
 */
export interface DirectContext {
	cwd: string;
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
	signal?: AbortSignal;
	/**
	 * Identity tuple used by transcript / runtime hooks. May be omitted in
	 * sync-only paths (the runtime registry isn't engaged).
	 */
	runId?: string;
	forkName?: string;
	/**
	 * Main agent's model (used as a final fallback when the agent doesn't
	 * declare one). Same semantics as `ForkContext.mainModel`.
	 */
	mainModel?: { provider: string; id: string };
	/**
	 * Optional uiContext to bind on the worker's extension runtime when
	 * `interactive: true`. Same identity rule as fork-runner: omit to keep
	 * `noOpUIContext`.
	 */
	workerUIContext?: ExtensionUIContext;
	/**
	 * Phase D: pre-resolved intercom bridge state. When the bridge is
	 * active, its `instruction` is appended to the worker's
	 * appendSystemPrompt. Pass `undefined` (or a bridge with
	 * `active: false`) to skip the injection.
	 */
	intercomBridge?: ResolvedBridge;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	/** Trusted parent branch snapshot, supplied only to a granted worker. */
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	/** Originator's global policy, distinct from this worker slot's policy. */
	originatorEscalationConfig?: ResolvedEscalationConfig;
	/** Sibling ordinal for lineage addressing inside a parallel direct batch. */
	childIndex?: number;
	/**
	 * Look up the cancel reason the runtime stamped on the live state when
	 * `DelegateDispatchState.cancel` fired. Threads through to `result.cancelReason`.
	 */
	getCancelReason?: () => CancelReason | undefined;
	/** Injectable timer seam for non-interactive direct extension-tool deadlines. */
	directExtensionToolDeadlineScheduler?: DirectExtensionToolDeadlineScheduler;
	/** Optional shared clock for the direct run's wall-clock and silence deadlines. */
	directDeadlineClock?: WorkerChannelClock;
	/** Deterministic full-jitter source for the one credential lock retry. */
	credentialRetryRandom?: () => number;
	/** Live-state hooks (same shapes as ForkContext). */
	/** Recovery is attached only to terminal failure updates; it is not live state. */
	onUpdate?: (patch: Partial<RunLiveState> & { name: string; recovery?: RunFailureRecovery }) => void;
	/** Resolve the live recovery verdict when a terminal failure is emitted. */
	getFailureRecovery?: () => RunFailureRecovery | undefined;
	onRuntimeUpdate?: (patch: Partial<RunLiveState>) => void;
	onTranscriptEntry?: (entry: TranscriptEntry) => void;
	/**
	 * Optional handle the runtime can populate so cancel can reach the live
	 * worker session. Mirrors `ForkSessionRefs.worker` in supervised mode.
	 */
	sessionRefs?: { worker?: AgentSession };

}

/** Compatibility alias for the shared non-fatal fork warning shape. */
export type DirectWarning = ForkWarning;

/**
 * Run one direct-worker task. Resolves to a `RunResult` (status =
 * "completed" | "failed" | "aborted") plus direct-only `harvest`, optional
 * `outputFile`, and non-fatal `warnings` fields.
 *
 * The function wraps its work in `runWithDepth(req.agent.name,
 * req.agent.maxSubagentDepth, …)` so a worker that recursively invokes
 * `delegate` re-enters the depth guard automatically.
 */
type DirectExecutionRequest = Omit<DirectRequest, "reads"> & { reads?: string[] };

type DirectRunResult = RunResult & {
	harvest: HarvestOutcome;
	outputFile?: Pick<ReadOutputFromFile, "absolutePath" | "bytes">;
	artifactRef?: WorkerArtifactReference;
	artifactError?: { kind: "storage-busy" | "artifact-unavailable"; message: string; retryable: boolean };
	activeToolNames?: string[];
};

function formatOutputFileError(error: unknown): string {
	return error instanceof OutputFileError
		? `${error.name} (${error.kind}): ${error.message}`
		: `OutputFileError (read-failed): ${error instanceof Error ? error.message : String(error)}`;
}

function retainArtifactFailureAssistantText(result: DirectRunResult): void {
	if (result.harvest.kind !== "substantive") {
		result.collapsedContent = "";
		return;
	}
	result.recoveredOutput = true;
	result.collapsedContent = [
		"⚠️ RECOVERED NON-ARTIFACT ASSISTANT TEXT — the worker returned this text, but the required artifact could not be validated or published.",
		"The run remains failed. This assistant text is not the required artifact and must not be treated as one.",
		"",
		result.harvest.text,
	].join("\n");
}

interface DirectArtifactLocation {
	baseDir: string;
	workspace: WorkerArtifactWorkspace;
	attempt: WorkerArtifactAttempt;
}

function directArtifactLocation(attempt: WorkerArtifactAttempt | undefined): DirectArtifactLocation | undefined {
	return attempt === undefined
		? undefined
		: { baseDir: attempt.outputPath, workspace: attempt.workspace, attempt };
}

/** Resolve the caller-declared artifact from its owned attempt output leaf. */
function readDirectArtifact(
	req: DirectRequest,
	location: DirectArtifactLocation | undefined,
): ReadOutputFromFile | undefined {
	if (req.artifact === undefined) return undefined;
	if (!location) throw new OutputFileError("read-failed", `artifact ${req.artifact} cannot be resolved: this worker has no artifact attempt`);
	return readOutputFromFile({ name: req.artifact, baseDir: location.baseDir });
}

/** Resolve the absolute path named in the worker's artifact instruction. */
function resolveDirectArtifactPath(
	req: DirectRequest,
	location: DirectArtifactLocation | undefined,
): string | undefined {
	if (req.artifact === undefined) return undefined;
	if (!location) throw new OutputFileError("read-failed", `artifact ${req.artifact} cannot be resolved: this worker has no artifact attempt`);
	if (location.attempt.artifactName !== req.artifact) throw new OutputFileError("read-failed", "artifact attempt declaration changed");
	return location.attempt.candidatePath;
}

function retainTranscriptPolicyRefusals(result: RunResult, readOnly: boolean | undefined): void {
	if (readOnly !== true) return;
	const refusals = result.policyRefusals ?? (result.policyRefusals = []);
	for (const entry of result.transcript) {
		if (entry.role !== "toolCall" || (entry.toolName !== "write" && entry.toolName !== "edit")) continue;
		if (refusals.some((refusal) => refusal.toolName === entry.toolName)) continue;
		if (refusals.length >= 32) break;
		refusals.push({
			boundary: "readOnly",
			toolName: entry.toolName,
			reason: `readOnly slot boundary refused attempted ${entry.toolName} call`,
		});
	}
}

interface DirectWorkerLifecycle {
	/** Teardown ownership must not depend on reading the caller-facing publication ref back. */
	workerSession?: AgentSession;
	nestedDelegatePolicy?: NestedDelegateCallerPolicy;
	/** The current model attempt's confinement lease, distinct from the logical-run lease. */
	releaseAttemptScratchLease?: () => void;
	/** Installed only while the logical run owns its activity-based deadline. */
	onActivity?: (lastActivityAt: number) => void;
}

function adoptDirectAttemptScratchLease(
	lifecycle: DirectWorkerLifecycle,
	release: () => void,
): void {
	if (lifecycle.releaseAttemptScratchLease) {
		throw new Error("direct worker acquired overlapping attempt scratch cleanup leases");
	}
	lifecycle.releaseAttemptScratchLease = release;
}

function releaseDirectAttemptScratchLease(lifecycle: DirectWorkerLifecycle): void {
	const release = lifecycle.releaseAttemptScratchLease;
	lifecycle.releaseAttemptScratchLease = undefined;
	release?.();
}

function sanitizeDirectCredentialMessage(message: AgentMessage, providerId?: string): AgentMessage {
	if (message?.role !== "assistant" || typeof message.errorMessage !== "string") return message;
	const error = message.errorMessage;
	if (!isCredentialStoreLockErrorMessage(error) && !isRouteAuthFailureMessage(error)) return message;
	return {
		...message,
		content: [],
		errorMessage: isCredentialStoreLockErrorMessage(error)
			? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
			: isRefreshableRouteAuthFailureMessage(error)
				? sanitizedRouteAuthFailureMessage(providerId)
				: sanitizedUnrefreshableRouteAuthFailureMessage(providerId),
	};
}

function isRetainedArtifactPayloadPath(value: string): boolean {
	if (!path.isAbsolute(value)) return false;
	const parts = path.resolve(value).split(path.sep);
	const marker = parts.lastIndexOf("pi-workspace-v2");
	return marker >= 0 && parts[marker + 1] === "data" && parts[marker + 3] === "artifacts" && parts[marker + 5] === "payload" && parts.length === marker + 6;
}

async function admitDirectReads(
	reads: DirectRequest["reads"],
	signal: AbortSignal | undefined,
): Promise<{ reads: string[] | undefined; admitted: OpenWorkerArtifact[] }> {
	if (!reads || reads.length === 0) return { reads: reads as [] | undefined, admitted: [] };
	const admitted: OpenWorkerArtifact[] = [];
	const resolved: string[] = [];
	try {
		for (const read of reads) {
			if (typeof read === "string") {
				if (!isRetainedArtifactPayloadPath(read)) { resolved.push(read); continue; }
				const opened = await openWorkerArtifactByPath(read, { signal });
				admitted.push(opened);
				resolved.push(opened.outputFile.absolutePath);
				continue;
			}
			const opened = await openWorkerArtifact(read, { signal });
			admitted.push(opened);
			resolved.push(opened.outputFile.absolutePath);
		}
		return { reads: resolved, admitted };
	} catch (error) {
		await Promise.allSettled(admitted.map((entry) => entry.release()));
		throw error;
	}
}

export async function runDirectWorker(
	req: DirectRequest,
	dctx: DirectContext,
): Promise<DirectRunResult> {
	assertReadOnlyValue(req.readOnly, `${req.name}.readOnly`);
	const mutationBaseline = captureMutationSnapshot(dctx.cwd);
	if (req.check !== undefined && req.artifact === undefined) {
		const failed = makeFailedDirectResult(
			req,
			dctx,
			`direct run '${req.name}' check requires an artifact; there is nothing to validate`,
		);
		failed.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
		return failed;
	}
	const credentialRetryClock: WorkerChannelClock = dctx.directDeadlineClock ?? {
		now: Date.now,
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	// The public runner owns both monotonic latches and the 75-second elapsed cap.
	// Model fallbacks and request continuations receive this same object and cannot
	// reset either budget.
	const credentialRetryBudget = createCredentialRetryBudget(
		credentialRetryClock,
		dctx.credentialRetryRandom,
	);
	// Direct actor activity is a best-effort liveness signal in addition to the
	// categorical widget projection. Keep the event payload identity-only so
	// model text, tool arguments, and results never cross this boundary.
	// Activity can arrive at token cadence; retain a bounded bus cadence while
	// still forwarding every observation to the runtime sink.
	const lifecycle: DirectWorkerLifecycle = {};
	let lastBusActivityAt: number | undefined;
	const recordActorActivity = dctx.runId && process.env.PI_DELEGATE_CHILD !== "1"
		? (lastActivityAt: number, frameOverride?: DepthFrame): void => {
			try {
				dctx.onRuntimeUpdate?.({ lastActivityAt });
			} catch {
				// Runtime liveness publication must never interrupt the worker.
			}
			try {
				const frame = frameOverride ?? resolveBusFrame();
				if (frame && (lastBusActivityAt === undefined || lastActivityAt - lastBusActivityAt >= 100)) {
					appendBusEvent(
						{ agentDir: dctx.agentDir, frame },
						{ kind: "updated", ts: lastActivityAt, fields: { event: "actor_activity" } },
					);
					lastBusActivityAt = lastActivityAt;
				}
			} catch {
				// Event-bus liveness is best effort, including lock-timeout failures.
			}
			try {
				lifecycle.onActivity?.(lastActivityAt);
			} catch {
				// Deadline maintenance is best effort at the activity boundary.
			}
		}
		: undefined;
	const actorActivity = recordActorActivity
		? createActorActivityPublisher(dctx.runId!, dctx.forkName ?? req.name, Date.now, recordActorActivity)
		: undefined;
	actorActivity?.publish("worker", { phase: "starting" });
	const sessionRefs = dctx.sessionRefs ?? {};
	const workerContext = dctx.sessionRefs ? dctx : { ...dctx, sessionRefs };
	let releaseLogicalScratchLease: (() => void) | undefined;
	const admittedReaders: OpenWorkerArtifact[] = [];
	try {
		// Artifact producers allocate a private v2 scratch/output attempt inside the
		// inner retry loop. Artifact-free workers retain the lightweight private
		// scratch path and create no v2 control or data records.
		let request: DirectExecutionRequest;
		try {
			const readAdmission = await admitDirectReads(req.reads, dctx.signal);
			admittedReaders.push(...readAdmission.admitted);
			const baseRequest: DirectExecutionRequest = { ...req, reads: readAdmission.reads };
			if (req.artifact !== undefined) {
				request = baseRequest;
			} else {
				request = req.scratchRoot
					? baseRequest
					: { ...baseRequest, scratchRoot: prepareWorkerScratchDir({ scope: "main", recursiveCleanup: true }) };
			}
		} catch (error) {
			const detail = `worker scratch allocation failed or artifact-read admission failed: ${error instanceof Error ? error.message : String(error)}`;
			if (dctx.signal?.aborted) {
				const aborted = makeAbortedDirectResult(req, dctx, detail);
				aborted.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
				return aborted;
			}
			const failed = makeFailedDirectResult(req, dctx, detail);
			if (error instanceof WorkerArtifactStorageBusyError) failed.artifactError = { kind: "storage-busy", message: error.message, retryable: true };
			if (error instanceof WorkerArtifactUnavailableError) failed.artifactError = { kind: "artifact-unavailable", message: error.message, retryable: false };
			failed.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
			return failed;
		}
		// This call allocated the leaf, so it owns removal for the whole logical
		// run: one lease taken here, released in the outer finally after every
		// attempt and all result harvesting. The confinement extension takes no
		// lease of its own for a leaf it was handed, so a refusal fallback tearing
		// down its session cannot drop the count and delete the directory the next
		// attempt still writes to.
		//
		// A caller-supplied scratch root is borrowed, and a borrower must never
		// remove it: a chain hands one root to every step, so releasing it here
		// would delete a directory later steps still read. Failing to obtain the
		// lease is not a run failure — the bounded stale sweep remains the backstop.
		if (!req.scratchRoot && request.scratchRoot) {
			releaseLogicalScratchLease = acquireWorkerScratchCleanupLease(request.scratchRoot);
			if (!releaseLogicalScratchLease) {
				logDelegateDiagnostic(
					`direct worker "${req.name}" could not acquire the cleanup lease for its allocated scratch leaf ` +
						`(${request.scratchRoot}); continuing without immediate cleanup. The leaf identity may have changed ` +
						"or its filesystem may not enforce owner-only mode 0700; the bounded stale sweep remains the backstop.",
					{ agentDir: dctx.agentDir, throttleKey: "scratch-cleanup-lease-unavailable:direct" },
				);
			}
		}
		// Seed the frame's lineage identity from the real run-id so the
		// serialized frame / lineagePath is addressable per-run (REQ-LIN-1),
		// not just keyed on the agent name. `undefined` defaultMax keeps the
		// standard DEFAULT_MAX_DEPTH.
		const result = await withEnvOverrides(mergeEnvOverrides(request.agent.env, request.env), () =>
			runWithDepth(
				request.agent.name,
				resolveDelegateOnlyDepth(request.agent.maxSubagentDepth),
				() => runDirectWorkerInner(
					request, workerContext, actorActivity, lifecycle, recordActorActivity, credentialRetryBudget,
				),
				undefined,
				dctx.runId ? { runId: dctx.runId, childIndex: dctx.childIndex } : undefined,
				{ agentDir: dctx.agentDir },
			),
		);
		result.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
		return result;
	} catch (err: unknown) {
		// Read admission can be cancelled before the inner result exists. Preserve
		// the established caller-cancellation result rather than reporting an
		// intentional abort as a setup failure.
		const rawError = err instanceof Error ? err.message : String(err);
		if (dctx.signal?.aborted) {
			const aborted = makeAbortedDirectResult(req, dctx, rawError);
			aborted.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
			return aborted;
		}
		// `runWithDepth` and supervised setup can fail before the inner result is
		// constructed. Keep direct mode's result contract total as well: every
		// error caught here is a pre-flight failure (no inner result was built).
		const error = isCredentialStoreLockErrorMessage(rawError)
			? CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE
			: rawError;
		// Record the pre-flight rejection in run history so the run stays
		// observable even though no inner result — and so no recordRun — ran.
		const busFrame = resolveBusFrame();
		try {
			recordPreflightFailure(dctx.agentDir, {
				runId: dctx.runId,
				rootRunId: busFrame?.rootRunId ?? dctx.runId ?? req.name,
				ownerSessionId: dctx.ownerSessionId,
				forkName: req.name,
				displayLabel: req.displayLabel,
				agent: req.agent.name,
				agentSource: req.agent.source,
				cwd: dctx.cwd,
				maxRounds: 1,
				collapseMode: "final_output",
				task: req.task,
				attempt: req.attempt ?? 1,
				...(req.retryOf ? { retryOf: req.retryOf } : {}),
				errorMessage: error,
			});
		} catch (recordingError) {
			if (!(recordingError instanceof StateLockTimeoutError)) throw recordingError;
		}
		const failed = makeFailedDirectResult(req, dctx, error);
		failed.mutationReport = mutationReportFor(dctx.cwd, mutationBaseline);
		return failed;
	} finally {
		const terminalSession = lifecycle.workerSession;
		try {
			if (terminalSession) await disposeWorkerSession(terminalSession, lifecycle.nestedDelegatePolicy);
		} catch {
			/* teardown is best effort; preserve the already-materialized run result */
		} finally {
			if (lifecycle.workerSession === terminalSession) lifecycle.workerSession = undefined;
			try { sessionRefs.worker = undefined; } catch { /* publication refs cannot own teardown */ }
			try {
				releaseDirectAttemptScratchLease(lifecycle);
			} finally {
				try {
					releaseLogicalScratchLease?.();
				} finally {
					await Promise.allSettled(admittedReaders.map((entry) => entry.release()));
					actorActivity?.dispose();
				}
			}
		}
	}
}

function makeFailedDirectResult(
	req: DirectRequest,
	dctx: DirectContext,
	error: string,
): DirectRunResult {
	error = boundHistoryErrorMessage(error);
	dctx.onRuntimeUpdate?.({ status: "failed", error });
	dctx.onUpdate?.({ name: req.name, status: "failed", error });
	return {
		name: req.name,
		attempt: req.attempt ?? 1,
		agent: req.agent.name,
		agentSource: req.agent.source,
		task: req.task,
		status: "failed",
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: "",
		harvest: { kind: "failure", error },
		workerCwd: dctx.cwd,
		transcript: [],
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
		error,
	};
}

function makeAbortedDirectResult(
	req: DirectRequest,
	dctx: DirectContext,
	error: string,
): DirectRunResult {
	error = boundHistoryErrorMessage(error);
	dctx.onRuntimeUpdate?.({ status: "aborted", error });
	dctx.onUpdate?.({ name: req.name, status: "aborted", error });
	return {
		name: req.name,
		attempt: req.attempt ?? 1,
		agent: req.agent.name,
		agentSource: req.agent.source,
		task: req.task,
		status: "aborted",
		cancelReason: dctx.getCancelReason?.() ?? "user",
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: "",
		harvest: { kind: "missing", reason: "no-assistant", text: "" },
		workerCwd: dctx.cwd,
		transcript: [],
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
		error,
	};
}

async function runDirectWorkerInner(
	req: DirectExecutionRequest,
	dctx: DirectContext,
	actorActivity: ActorActivityPublisher | undefined,
	lifecycle: DirectWorkerLifecycle,
	recordActorActivity: ((lastActivityAt: number, frameOverride?: DepthFrame) => void) | undefined,
	credentialRetryBudget: CredentialRetryBudget,
): Promise<DirectRunResult> {
	const startMs = Date.now();
	const startedAt = new Date(startMs).toISOString();
	const warnings: DirectWarning[] = [];
	// One primary timer carries both the optional absolute budget and the default
	// direct-worker silence policy. Activity moves only the silence deadline; the
	// absolute deadline remains fixed across model fallbacks.
	let budgetTimer: unknown;
	let budgetTimerScheduled = false;
	let graceTimer: unknown;
	let graceTimerScheduled = false;
	let workerConcluded = false;
	let deadlineLifecycleArmed = false;
	let absoluteDeadlineAtMs: number | undefined;
	let lastActivityAt = 0;
	let activeWindDownReason: "heartbeat" | "wall-clock" | undefined;
	let wallClockWindDownHandled = false;
	let cancellationSource: "caller" | "timeout" | "heartbeat" | undefined;
	let internalCancellationReason: "timeout" | "heartbeat" | undefined;
	// One linked signal carries caller cancellation and this runner's internal
	// liveness cancellations into every wait that can outlive the prompt call.
	const cancellationController = new AbortController();
	const cancellationSignal = cancellationController.signal;
	const deadlineClock: WorkerChannelClock = dctx.directDeadlineClock ?? {
		now: Date.now,
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const abortFromCaller = () => {
		cancellationSource ??= "caller";
		cancellationController.abort();
	};
	let ownerAbortListener: (() => void) | undefined;
	if (dctx.signal) {
		ownerAbortListener = abortFromCaller;
		if (dctx.signal.aborted) abortFromCaller();
		else dctx.signal.addEventListener("abort", ownerAbortListener, { once: true });
	}
	const clearOwnerAbortLink = () => {
		if (ownerAbortListener && dctx.signal) {
			dctx.signal.removeEventListener("abort", ownerAbortListener);
		}
		ownerAbortListener = undefined;
	};
	const clearBudgetTimers = () => {
		workerConcluded = true;
		lifecycle.onActivity = undefined;
		if (budgetTimerScheduled) {
			deadlineClock.clearTimeout(budgetTimer);
			budgetTimer = undefined;
			budgetTimerScheduled = false;
		}
		if (graceTimerScheduled) {
			deadlineClock.clearTimeout(graceTimer);
			graceTimer = undefined;
			graceTimerScheduled = false;
		}
	};

	const policyRefusals: NonNullable<RunResult["policyRefusals"]> = [];
	const result: DirectRunResult = {
		name: req.name,
		attempt: req.attempt ?? 1,
		agent: req.agent.name,
		agentSource: req.agent.source,
		task: req.task,
		status: "running",
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: "",
		harvest: { kind: "missing", reason: "no-assistant", text: "" },
		workerCwd: dctx.cwd,
		transcript: [],
		policyRefusals,
		usage: {
			supervisorInput: 0,
			supervisorOutput: 0,
			workerInput: 0,
			workerOutput: 0,
			cost: 0,
		},
	};
	const sanitizeCredentialStoreLockExhaustion = (): string => {
		result.retryKind = "transient";
		return CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE;
	};

	const emit = (patch: Partial<RunLiveState>) => {
		const recovery = patch.status === "failed" ? dctx.getFailureRecovery?.() : undefined;
		// Attach the classified cause to every terminal tick from `result`, rather
		// than at each of the ten `emit({ status: "failed", ... })` call sites.
		// One of those sites forgetting it is exactly how the early wake ends up
		// saying `fork-failed` about a quota death (#469/#197), and a caller
		// cannot tell an omitted category from an absent one.
		const effectivePatch: Partial<RunLiveState> = patch.status === "failed" && result.failureCause !== undefined
			? { ...patch, failureCause: result.failureCause }
			: patch;
		dctx.onRuntimeUpdate?.(effectivePatch);
		dctx.onUpdate?.({
			name: req.name,
			...effectivePatch,
			...(recovery !== undefined ? { recovery } : {}),
		});
	};

	// ── Event-bus liveness seam (spec 0004 / REQ-BUS-1) ─────────────────────
	// A direct (leaf) worker still EMITS to the bus so it registers as a
	// DESCENDANT of its parent's lineage subtree — this is exactly the signal
	// a GRANDPARENT's heartbeat reads to avoid false-cancelling a busy branch.
	// `resolveBusFrame` (issue #9): the LIVE ALS frame wins (we are inside
	// `runWithDepth`; it carries `idPath`, so the grandparent's REQ-BUS-2
	// true-ancestry prefix probe matches), with the inherited ENV frame as the
	// cross-process safety net — identity fields survive even a non-verifying
	// MAC, so a detached descendant's events still land in the correct
	// root-run sink instead of not being emitted at all. The bus becomes a
	// no-op only for a genuine top-level process (best-effort, REQ-BUS-4).
	const busFrame: DepthFrame | undefined = resolveBusFrame();
	const busAgentDir = dctx.agentDir;
	const rootRunId = busFrame?.rootRunId ?? dctx.runId ?? req.name;
	// Declared here but installed only immediately before the try/finally that
	// owns its release (further down), so no pre-cancel early return or throwable
	// setup can leak an observer that would outlive this run and stamp later,
	// unrelated actor activity onto the settled run.
	let unsubscribeActorActivity: (() => void) | undefined;
	const escalationEnabled = req.escalationPolicy?.enabled === true;
	if (escalationEnabled && !busFrame) {
		throw new Error("escalation-enabled direct worker requires a live lineage frame");
	}
	const escalationLineagePath = busFrame ? lineagePath(busFrame) : `${rootRunId}/${dctx.runId ?? req.name}#${dctx.childIndex ?? 0}`;
	const escalationCredential = (): { capToken: string } => {
		const capToken = currentLineageEnv()?.[LINEAGE_ENV.CAP_TOKEN];
		if (!capToken) throw new Error("escalation-enabled worker lacks a lineage capability token");
		return { capToken };
	};
	const escalationParticipants = escalationEnabled
		? buildDirectEscalationParticipants({
			rootRunId,
			originatorConfig: dctx.originatorEscalationConfig ?? req.escalationPolicy!.config,
		})
		: [];
	const emitBusEvent = (kind: BusEventKind, fields?: Record<string, unknown>): void => {
		if (!busFrame) return;
		appendBusEvent({ agentDir: busAgentDir, frame: busFrame }, { kind, fields });
	};

	let workerSession: AgentSession | undefined;
	const credentialAbortError = (): Error => {
		const error = new Error("Credential retry cancelled");
		error.name = "AbortError";
		return error;
	};
	const runWithinCredentialDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
		const remainingMs = credentialRetryRemainingMs(credentialRetryBudget);
		if (remainingMs <= 0) throw new Error(sanitizeCredentialStoreLockExhaustion());
		let deadlineTimer: unknown;
		let deadlineScheduled = false;
		let abortListener: (() => void) | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<T>((_, reject) => {
					deadlineTimer = credentialRetryBudget.clock.setTimeout(() => {
						workerSession?.abort().catch(() => {});
						reject(new Error(sanitizeCredentialStoreLockExhaustion()));
					}, remainingMs);
					deadlineScheduled = true;
				}),
				new Promise<T>((_, reject) => {
					abortListener = () => reject(credentialAbortError());
					if (cancellationSignal.aborted) abortListener();
					else cancellationSignal.addEventListener("abort", abortListener, { once: true });
				}),
			]);
		} finally {
			if (deadlineScheduled) credentialRetryBudget.clock.clearTimeout(deadlineTimer);
			if (abortListener) cancellationSignal.removeEventListener("abort", abortListener);
		}
	};
	const waitForLockRetry = (): Promise<boolean> => waitForCredentialStoreLockRetry(
		credentialRetryBudget,
		cancellationSignal,
		(delayMs) => logDelegateDiagnostic(
			`credential-store lock retry scheduled delayMs=${delayMs}`,
			{ agentDir: dctx.agentDir, level: "warn" },
		),
	);
	const raceAgainstCredentialCancellation = async <T>(operation: Promise<T>): Promise<T> => {
		let abortListener: (() => void) | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<T>((_, reject) => {
					abortListener = () => reject(credentialAbortError());
					if (cancellationSignal.aborted) abortListener();
					else cancellationSignal.addEventListener("abort", abortListener, { once: true });
				}),
			]);
		} finally {
			if (abortListener) cancellationSignal.removeEventListener("abort", abortListener);
		}
	};
	const silenceGraceMs = req.timeoutPolicy?.windDownGraceMs ?? DEFAULT_WIND_DOWN_GRACE_MS;
	const silenceGuardEnabled = recordActorActivity !== undefined;

	function scheduleNextDeadline(): void {
		if (workerConcluded || !deadlineLifecycleArmed || graceTimerScheduled) return;
		if (budgetTimerScheduled) {
			deadlineClock.clearTimeout(budgetTimer);
			budgetTimer = undefined;
			budgetTimerScheduled = false;
		}
		const deadlines: number[] = [];
		if (absoluteDeadlineAtMs !== undefined && !wallClockWindDownHandled) {
			deadlines.push(absoluteDeadlineAtMs);
		}
		if (silenceGuardEnabled && lastActivityAt > 0) {
			deadlines.push(lastActivityAt + DEFAULT_DIRECT_WORKER_SILENCE_TIMEOUT_MS);
		}
		if (deadlines.length === 0) return;
		const delayMs = Math.max(0, Math.min(...deadlines) - deadlineClock.now());
		budgetTimer = deadlineClock.setTimeout(fireNextDeadline, delayMs);
		budgetTimerScheduled = true;
	}

	function hardCancelFor(reason: "heartbeat" | "wall-clock"): void {
		if (workerConcluded || cancellationSource !== undefined) return;
		const timeoutReason = reason === "heartbeat" ? "heartbeat" : "timeout";
		cancellationSource = timeoutReason;
		internalCancellationReason = timeoutReason;
		cancellationController.abort();
		const sessionAtTimeout = workerSession;
		if (sessionAtTimeout) {
			abortWorkerCompaction(sessionAtTimeout);
			void Promise.resolve(sessionAtTimeout.abort()).catch(() => {});
		}
	}

	function beginWindDown(reason: "heartbeat" | "wall-clock"): void {
		if (workerConcluded || cancellationSource !== undefined || graceTimerScheduled) return;
		activeWindDownReason = reason;
		if (reason === "wall-clock") wallClockWindDownHandled = true;
		const firstWindDown = result.steered !== true;
		if (firstWindDown) {
			result.steered = true;
			emit({ windDown: { atMs: deadlineClock.now(), reason } });
			const activeSession = workerSession;
			if (activeSession) {
				const streaming = (activeSession as unknown as { isStreaming?: boolean }).isStreaming;
				const steerFn = (activeSession as unknown as { steer?: (text: string) => Promise<void> }).steer;
				if (streaming && typeof steerFn === "function") {
					const message = reason === "heartbeat" ? DIRECT_SILENCE_WIND_DOWN_STEER : DIRECT_WIND_DOWN_STEER;
					void Promise.resolve(steerFn.call(activeSession, message)).catch(() => {});
				}
			}
		}
		const hardCancelEnabled = reason === "heartbeat" ||
			(req.timeoutPolicy !== undefined && isHardCancelEnabled(req.timeoutPolicy));
		if (firstWindDown) {
			logDelegateDiagnostic(
				reason === "heartbeat"
					? `worker '${req.name}' exceeded the default ${DEFAULT_DIRECT_WORKER_SILENCE_TIMEOUT_MS}ms silence bound; steering wind-down ` +
						`(wrap up now), granting ${silenceGraceMs}ms grace before hard-cancel.`
					: `worker '${req.name}' hit wall-clock budget; steering wind-down ` +
						`(wrap up now), granting ${silenceGraceMs}ms grace` +
						(hardCancelEnabled ? " before hard-cancel." : ". Hard cancellation is disabled."),
				{ agentDir: dctx.agentDir },
			);
		}
		graceTimer = deadlineClock.setTimeout(() => {
			graceTimer = undefined;
			graceTimerScheduled = false;
			if (workerConcluded || cancellationSource !== undefined) return;
			activeWindDownReason = undefined;
			if (hardCancelEnabled) {
				hardCancelFor(reason);
				return;
			}
			scheduleNextDeadline();
		}, silenceGraceMs);
		graceTimerScheduled = true;
	}

	function fireNextDeadline(): void {
		budgetTimer = undefined;
		budgetTimerScheduled = false;
		if (workerConcluded || cancellationSource !== undefined) return;
		const now = deadlineClock.now();
		if (absoluteDeadlineAtMs !== undefined && !wallClockWindDownHandled && now >= absoluteDeadlineAtMs) {
			beginWindDown("wall-clock");
			return;
		}
		if (
			silenceGuardEnabled &&
			lastActivityAt > 0 &&
			actorActivitySilenceMs(lastActivityAt, now) >= DEFAULT_DIRECT_WORKER_SILENCE_TIMEOUT_MS
		) {
			beginWindDown("heartbeat");
			return;
		}
		scheduleNextDeadline();
	}

	function observeActivity(lastObservedAt: number): void {
		if (workerConcluded || !deadlineLifecycleArmed || !Number.isFinite(lastObservedAt)) return;
		lastActivityAt = Math.max(lastActivityAt, lastObservedAt);
		if (activeWindDownReason === "heartbeat" && graceTimerScheduled) {
			deadlineClock.clearTimeout(graceTimer);
			graceTimer = undefined;
			graceTimerScheduled = false;
			activeWindDownReason = undefined;
		}
		scheduleNextDeadline();
	}
	let promptHarvest: PromptLifecycleHarvest | undefined;
	let promptMessages: AgentMessage[] | undefined;
	let promptContinuationAttempts: number;
	let promptUsageRecorded = false;
	let workerModelRef: string | undefined;
	let workerModelProvider: string | undefined;
	let workerThinkingLevel: string | undefined;
	let extensionToolDeadline: DirectExtensionToolDeadlineController | undefined;
	// Issue #226 — resolved at session creation, read when the first message is
	// composed. False until proven otherwise, so an undecided checklist degrades
	// into the prompt rather than vanishing.
	let tasksSeeded: boolean;
	let focusSeeded: boolean;
	// Issue #226 — the worker's SessionManager, kept so the message-end hook and
	// the final ledger can replay its task entries without reopening the file.
	let workerSessionMgr: { getEntries?: () => unknown[] } | undefined;
	let attemptedModels: string[] | undefined;
	const plannedModels = planWorkerModelRequests(dctx.modelRegistry, [req], {
		mainModel: dctx.mainModel,
		scope: dctx.scopedModelRefs,
	});
	let modelCursor = plannedModels.kind === "planned"
		? new WorkerModelCursor(plannedModels.requests[0]!.modelPlan)
		: undefined;
	let pendingWorkerModel: WorkerModelChoice | undefined;
	const refusalModels: string[] = [];
	const originalTask = req.task;
	let workerAttemptCount = 0;
	let fallbackPromptOverride: string | undefined;
	const capturePromptRepairs = (): void => {
		const incoming = readPromptRepairRecords(workerSessionMgr?.getEntries?.() ?? []);
		if (incoming.length === 0) return;
		result.promptRepairs = mergePromptRepairRecords(result.promptRepairs ?? [], incoming);
	};
	const withPromptRepairTranscript = (transcript: TranscriptEntry[]): TranscriptEntry[] =>
		[...transcript, ...promptRepairTranscriptEntries(result.promptRepairs ?? [])];
	let artifactCheckFailures = 0;
	let lastAssistantText = "";
	const applyTimeoutSalvage = (): void => {
		const reason = internalCancellationReason ?? "timeout";
		internalCancellationReason = reason;
		result.status = "aborted";
		result.cancelReason = reason;
		result.error = result.error ?? (reason === "heartbeat" ? "cancelled: heartbeat timeout" : "wall-clock budget exceeded");
		result.outputFile = undefined;
		result.artifactRef = undefined;
		capturePromptRepairs();
		const messages = promptMessages ?? (workerSession?.messages as AgentMessage[] | undefined) ?? [];
		const completeTranscript = messages.length > 0
			? messagesToTranscript("worker", messages)
			: result.transcript;
		const timeoutCollapse = buildRunTimeoutCollapse(completeTranscript);
		result.transcript = boundRunTimeoutTranscript(withPromptRepairTranscript(completeTranscript));
		result.collapsedContent = timeoutCollapse.content;
		result.recoveredOutput = timeoutCollapse.recoveredOutput;
		// Bound every message-bearing timeout field before this result reaches
		// runtime projection or persistence, not only the transcript collapse.
		Object.assign(result, projectRunResult(result));
	};
	const timeoutResultIfObserved = (): boolean => {
		if (internalCancellationReason === undefined) return false;
		applyTimeoutSalvage();
		return true;
	};
	const internalCancellationMessage = (beforePrompt = false): string => {
		if (internalCancellationReason === "heartbeat") {
			return beforePrompt ? "heartbeat timeout before prompt" : "cancelled: heartbeat timeout";
		}
		return beforePrompt ? "wall-clock budget exceeded before prompt" : "wall-clock budget exceeded";
	};
	const recordPromptUsage = (messages: readonly AgentMessage[]): void => {
		if (promptUsageRecorded) return;
		promptUsageRecorded = true;
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		let cost = 0;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const usage = message.usage;
			if (!usage) continue;
			const normalized = normalizeUsageCounters({
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost?.total,
			});
			inputTokens = saturatingAdd(inputTokens, normalized.usage.input ?? 0);
			outputTokens = saturatingAdd(outputTokens, normalized.usage.output ?? 0);
			cacheReadTokens = saturatingAdd(cacheReadTokens, normalized.usage.cacheRead ?? 0);
			cacheWriteTokens = saturatingAdd(cacheWriteTokens, normalized.usage.cacheWrite ?? 0);
			cost = saturatingAdd(cost, normalized.usage.cost ?? 0);
			if (normalized.diagnostics.length > 0) {
				result.usage.diagnostics = diagnosticsWithGenerated(
					result.usage.diagnostics,
					normalized.diagnostics,
				);
			}
		}
		result.usage.workerInput = saturatingAdd(result.usage.workerInput, inputTokens);
		result.usage.workerOutput = saturatingAdd(result.usage.workerOutput, outputTokens);
		if (cacheReadTokens) result.usage.workerCacheRead = saturatingAdd(result.usage.workerCacheRead ?? 0, cacheReadTokens);
		if (cacheWriteTokens) result.usage.workerCacheWrite = saturatingAdd(result.usage.workerCacheWrite ?? 0, cacheWriteTokens);
		result.usage.cost = saturatingAdd(result.usage.cost, cost);
	};
	const directEscalationActivityChannel = {
		enterAwaitingEscalation: () => {
			actorActivity?.publish("worker", { phase: "awaiting-escalation" });
			emit({ status: "awaiting-escalation" });
		},
		resolveAwaitingEscalation: () => {
			if (cancellationSignal.aborted || result.status !== "running") return;
			actorActivity?.publish("worker", { phase: "waiting-model" });
			emit({ status: "running" });
		},
	};

	const nextWorkerModel = (): WorkerModelChoice | undefined => {
		const choice = plannedModels.kind === "planned" ? modelCursor!.next() : undefined;
		attemptedModels = plannedModels.kind === "planned"
			? [...modelCursor!.attemptedRefs]
			: [...plannedModels.failure.attemptedRefs];
		result.attemptedModels = attemptedModels;
		return choice;
	};

	const recordRefusal = (modelRef: string) => {
		if (!refusalModels.includes(modelRef)) {
			refusalModels.push(modelRef);
		}
		result.refusalModels = [...refusalModels];
	};

	const refreshCurrentProviderFor401 = async (): Promise<boolean> => {
		if (credentialRetryBudget.authRetryConsumed) return false;
		// Consume before refresh so rejection, cancellation, or a late result cannot
		// reset the latch and license another request retry.
		credentialRetryBudget.authRetryConsumed = true;
		const providerId = workerModelProvider;
		const readProviderAuth = providerAuthReader(dctx.modelRegistry);
		if (!readProviderAuth) return false;
		try {
			let refreshed: Awaited<ReturnType<typeof readProviderAuth>>;
			try {
				refreshed = await raceAgainstCredentialCancellation(readProviderAuth(providerId ?? ""));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!isCredentialStoreLockErrorMessage(message)) throw error;
				if (!(await waitForLockRetry())) {
					sanitizeCredentialStoreLockExhaustion();
					return false;
				}
				try {
					refreshed = await runWithinCredentialDeadline(() => readProviderAuth(providerId ?? ""));
				} catch (retryError) {
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					if (isCredentialStoreLockErrorMessage(retryMessage)) {
						throw new Error(sanitizeCredentialStoreLockExhaustion(), { cause: retryError });
					}
					throw retryError;
				}
			}
			if (refreshed === undefined) {
				logDelegateDiagnostic(
					`credential refresh unavailable provider=${sanitizedProviderId(providerId)}`,
					{ agentDir: dctx.agentDir, level: "warn" },
				);
				return false;
			}
			logDelegateDiagnostic(
				`credential refresh completed provider=${sanitizedProviderId(providerId)}`,
				{ agentDir: dctx.agentDir, level: "log" },
			);
			return true;
		} catch (error) {
			if (cancellationSignal.aborted) throw error;
			logDelegateDiagnostic(
				`credential refresh failed provider=${sanitizedProviderId(providerId)}`,
				{ agentDir: dctx.agentDir, level: "warn" },
			);
			return false;
		}
	};
	const removeRetryableAssistantFromAgentState = (): boolean => {
		if (!workerSession) return false;
		const messages = workerSession.agent.state.messages as AgentMessage[];
		const last = messages[messages.length - 1];
		if (last?.role !== "assistant") return false;
		workerSession.agent.state.messages = messages.slice(0, -1);
		return true;
	};
	const sanitizePromptCredentialFailures = (): void => {
		if (!promptMessages) return;
		promptMessages = promptMessages.map((message) =>
			sanitizeDirectCredentialMessage(message, workerModelProvider));
	};

	const reportRecordingFailure = (error: unknown): void => {
		if (!(error instanceof StateLockTimeoutError)) throw error;
		const diagnostic = `recording failed: ${error.message}`;
		result.error = result.error ? `${result.error}; ${diagnostic}` : diagnostic;
	};
	const finalize = () => {
		retainTranscriptPolicyRefusals(result, req.readOnly);
		// A refused write means the worker's own success claim may be false (#536).
		const refusedWrite = refusedWriteWarning(result.policyRefusals);
		if (refusedWrite) warnings.push(refusedWrite);
		// Publish AFTER the push above, so the warning actually reaches the caller.
		// Every terminal path routes through finalize(), including the
		// aborted-before-construction return, so this is the one publication point.
		if (warnings.length > 0) result.warnings = warnings;
		result.inputDigests = result.transcript
			.filter((entry) => entry.source === "worker" && entry.role === "user")
			.map((entry, sequence) => ({
				sequence,
				algorithm: "sha256" as const,
				digest: createHash("sha256").update(entry.text, "utf8").digest("hex"),
			}));
		// Issue #226 — settle the checklist before the terminal event, so the
		// collapsed result carries a mechanical verdict rather than leaving a
		// caller to infer completion from the worker's prose.
		try {
			const ledger = buildTaskLedger(readSeededTasks(workerSessionMgr?.getEntries?.() ?? []));
			if (ledger) result.taskLedger = ledger;
		} catch (error) {
			reportRecordingFailure(error);
		}
		// Event-bus `completed` (spec 0004 / REQ-BUS-1): terminal liveness event
		// for this leaf worker. A lock timeout stays visible on the result without
		// changing the worker's status or deliverable.
		try {
			emitBusEvent("completed", { status: result.status });
		} catch (error) {
			reportRecordingFailure(error);
		}
		const finishedAt = new Date().toISOString();
		const durationMs = Date.now() - startMs;
		const status: RunHistoryEntry["status"] =
			result.status === "completed" || result.status === "failed" || result.status === "aborted"
				? result.status
				: "failed";
		try {
			recordRun(dctx.agentDir, {
				ts: finishedAt,
				tsSec: Math.floor(Date.now() / 1000),
				runId: dctx.runId,
				rootRunId,
				ownerSessionId: dctx.ownerSessionId,
				forkName: req.name,
				attempt: result.attempt ?? req.attempt ?? 1,
				...(req.retryOf !== undefined ? { retryOf: req.retryOf } : {}),
			...(req.displayLabel !== undefined ? { displayLabel: req.displayLabel } : {}),
				agent: req.agent.name,
				agentSource: req.agent.source,
				workerModel: workerModelRef,
				attemptedModels,
				workerThinking: workerThinkingLevel,
				cwd: dctx.cwd,
				workerSessionFile: result.workerSessionFile,
				status,
				cancelReason: status === "aborted" ? result.cancelReason : undefined,
				errorMessage: result.error,
				errorKind: result.errorKind,
				refusalModels: result.refusalModels,
				roundsUsed: result.roundsUsed,
				maxRounds: result.maxRounds,
				collapseMode: result.collapseMode,
				supervisorFinishKind: null,
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
	const markAbortedBeforeConstruction = (error: string): void => {
		const reason = internalCancellationReason ?? dctx.getCancelReason?.() ?? "user";
		result.status = "aborted";
		result.cancelReason = reason;
		result.error = error;
		emit({ status: "aborted", error: result.error });
	};

	if (cancellationSignal.aborted) {
		markAbortedBeforeConstruction("aborted before worker construction");
		clearOwnerAbortLink();
		finalize();
		return result;
	}

	// Install the descendant-liveness observer only on the path that reaches the
	// try/finally below, whose outer finally releases it exactly once. Placed
	// after the pre-cancel early return and after every throwable setup above, so
	// no failed or short-circuited setup can leak a subscription onto a run that
	// has already settled.
	const busLivenessWindowMs = 180_000;
	if (recordActorActivity && busFrame) {
		const descendantPrefix = `${lineageAncestorPath(busFrame)}/`;
		// Global actor observations only wake this filesystem probe. Advance the
		// parent once for each descendant event identity the probe newly discovers.
		const snapshotDescendantEventIds = (): Map<string, Set<string>> => {
			const snapshot = new Map<string, Set<string>>();
			for (const event of readBusEvents(busAgentDir, busFrame.rootRunId)) {
				if (event.kind === "completed" || !event.ancestorPath?.startsWith(descendantPrefix)) continue;
				const eventIds = snapshot.get(event.lineagePath) ?? new Set<string>();
				eventIds.add(event.eventId ?? JSON.stringify(event));
				snapshot.set(event.lineagePath, eventIds);
			}
			return snapshot;
		};
		let observedDescendantEventIds = snapshotDescendantEventIds();
		unsubscribeActorActivity = onActorActivityObserved(() => {
			try {
				const currentDescendantEventIds = snapshotDescendantEventIds();
				const hasNewDescendantEvent = [...currentDescendantEventIds].some(
					([path, eventIds]) => {
						const observedEventIds = observedDescendantEventIds.get(path);
						return !observedEventIds || [...eventIds].some((eventId) => !observedEventIds.has(eventId));
					},
				);
				if (currentDescendantEventIds.size > 0) observedDescendantEventIds = currentDescendantEventIds;
				if (hasNewDescendantEvent && readDescendantActivity({
					agentDir: busAgentDir,
					rootRunId: busFrame.rootRunId,
					ancestorPath: lineageAncestorPath(busFrame),
					windowMs: busLivenessWindowMs,
				})) {
					recordActorActivity(deadlineClock.now(), busFrame);
				}
			} catch {
				// Descendant liveness is best effort and must not interrupt the worker.
			}
		});
	}

	let artifactAttempt: WorkerArtifactAttempt | undefined;
	const artifactProducerRunId = dctx.runId ?? `direct-standalone-${process.pid}-${++standaloneWorkspaceHolderSequence}`;
	try {
		while (true) {
			let replacingWorkerAttempt = false;
		// ── Resolve the worker model (agent.model → fallbackModels → main) ──
		const workerModelChoice = pendingWorkerModel ?? nextWorkerModel();
		pendingWorkerModel = undefined;
		// Phase D: record the resolution walk in run-history regardless of
		// success — diagnoses "primary model is gone, fellback to haiku"
		// scenarios.
		if (!workerModelChoice) {
			throw new Error(
				plannedModels.kind === "planned"
					? workerModelFailureMessage(req.agent.name, attemptedModels ?? [], dctx.scopedModelRefs)
					: plannedModels.failure.message,
			);
		}
		if (req.artifact !== undefined) {
			try {
				const resolvedWorkspace = resolveWorkerArtifactWorkspace({ worktreePath: dctx.cwd });
				const workspace = prepareWorkerArtifactWorkspace({ worktreePath: resolvedWorkspace.worktreePath });
				artifactAttempt = await prepareWorkerArtifactAttempt(workspace, {
					runId: artifactProducerRunId,
					forkName: dctx.forkName ?? req.name,
					attempt: req.attempt ?? 1,
					artifactName: req.artifact,
					signal: cancellationSignal,
				});
			} catch (error) {
				if (error instanceof WorkerArtifactStorageBusyError || error instanceof WorkerArtifactUnavailableError) throw error;
				throw new Error(formatOutputFileError(new OutputFileError(
					"read-failed",
					`artifact ${req.artifact} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
				)), { cause: error });
			}
			req = { ...req, scratchRoot: artifactAttempt.scratchPath };
		}
		const artifactLocation = directArtifactLocation(artifactAttempt);
		const workerModel = workerModelChoice.model;
		workerModelProvider = workerModel.provider;
		workerModelRef = workerModelChoice.canonicalRef;
		result.workerModel = workerModelRef;

		if (req.agent.mcpDirectTools && req.agent.mcpDirectTools.length > 0) {
			logDelegateDiagnostic(
				`agent "${req.agent.name}": mcpDirectTools ` +
					`[${req.agent.mcpDirectTools.join(", ")}] are not supported by the ` +
					"in-process createAgentSession API and will be ignored.",
				{ agentDir: dctx.agentDir },
			);
		}

		const extraInstructions: string[] = escalationWorkerInstructions(escalationEnabled);
		if (dctx.intercomBridge?.active && dctx.intercomBridge.instruction) {
			extraInstructions.push(dctx.intercomBridge.instruction);
		}
		let artifactPath: string | undefined;
		try {
			artifactPath = resolveDirectArtifactPath(req, artifactLocation);
		} catch (error) {
			throw new Error(formatOutputFileError(error), { cause: error });
		}
		// The write-scope instruction depends on whether confinement was actually
		// installed, so it is pushed after writeConfinement is resolved below.
		// Plain-worker tool surface shared with the inner worker beneath a
		// supervised run.
		const workerSurface = resolveWorkerToolSurface(req.agent, {
			escalationPolicy: req.escalationPolicy,
			readOnly: req.readOnly,
			...(req.parentTranscriptSearch ? { customToolNames: [PARENT_TRANSCRIPT_SEARCH_TOOL_NAME] } : {}),
		});
		const artifactWriterRequirement = req.artifact === undefined
			? undefined
			: { artifactName: req.artifact, readOnly: req.readOnly === true };
		if (artifactWriterRequirement) assertArtifactWriterCapability(workerSurface, artifactWriterRequirement);
		const releaseWorkerToolRegistration = dctx.ensureWorkerToolRegistration?.(workerSurface.tools ?? []);
		for (const d of workerSurface.diagnostics)
			logDelegateDiagnostic(d, { agentDir: dctx.agentDir, throttleKey: "tool-surface" });
		const writeConfinement = resolveWorkerWriteAuthority({
			name: req.name,
			cwd: dctx.cwd,
			agentDir: dctx.agentDir,
			confineWrites: req.confineWrites,
			writableRoots: req.writableRoots,
			artifactRoots: artifactLocation ? [artifactLocation.baseDir] : undefined,
			artifact: artifactPath ?? req.artifact,
			scratchRoot: req.scratchRoot,
			readOnly: req.readOnly,
			onRefusal: (refusal) => {
				if (policyRefusals.length < 32) policyRefusals.push({ ...refusal, reason: refusal.reason.slice(0, 1000) });
			},
			onScratchCleanupLeaseAcquired: (release) => {
				adoptDirectAttemptScratchLease(lifecycle, release);
			},
		});
		if (req.scratchRoot) {
			extraInstructions.push(
				workerWriteScopeInstruction({
					scratchRoot: req.scratchRoot,
					policy: writeConfinement,
					...(artifactPath ? { artifact: artifactPath } : {}),
				}),
			);
		}
		const nestedDelegatePolicy = nestedDelegatePolicyForAgent(req.agent, writeConfinement);
		lifecycle.nestedDelegatePolicy = nestedDelegatePolicy;
		const workerSettingsManager = createIsolatedWorkerSettingsManager(dctx.cwd, dctx.agentDir);
		const preparedResources = await prepareWorkerSessionResources(
			req.agent,
			{
				cwd: dctx.cwd,
				agentDir: dctx.agentDir,
				settingsManager: workerSettingsManager,
				extraInstructions,
				confinement: writeConfinement,
				intercomBridge: dctx.intercomBridge,
				...(req.parentTranscriptSearch ? { workerGrantedToolNames: [PARENT_TRANSCRIPT_SEARCH_TOOL_NAME] } : {}),
				...(artifactWriterRequirement ? { artifactWriterRequirement } : {}),
			},
			workerSurface,
		);
		const workerLoader = preparedResources.loader;
		// The worker's own extension set decides the final surface, so everything
		// below reports and registers from the amended one (#338).
		const effectiveSurface = preparedResources.surface;
		if (req.interactive !== true) {
			extensionToolDeadline = installDirectExtensionToolDeadline(
				workerLoader.getExtensions().extensions,
				{
					scheduler: dctx.directExtensionToolDeadlineScheduler,
					parentDeadlineAtMs: () => absoluteDeadlineAtMs,
					abortWorker: () => {
						workerSession?.abort().catch(() => {});
					},
				},
			);
		}
		const workerAskTool = makeWorkerAskRoutingTool(escalationEnabled
			? {
				enabled: true,
				raiseDeps: {
					agentDir: dctx.agentDir,
					rootRunId,
					runId: busFrame!.runId,
					lineagePath: escalationLineagePath,
					raiserLabel: req.name,
					participants: escalationParticipants,
					config: req.escalationPolicy!.config,
					credential: escalationCredential,
					ownerSessionId: dctx.ownerSessionId ?? rootRunId,
					sessionFile: () => sessionMgr.getSessionFile(),
					sessionId: () => sessionMgr.getSessionId(),
					workerChannel: directEscalationActivityChannel,
				},
			}
			: { enabled: false });
		reconcileWorkerAskSurface({
			tools: effectiveSurface.tools,
			replaced: replaceLoadedAskTools(workerLoader, workerAskTool),
			onDiagnostic: (message) => logDelegateDiagnostic(message, { agentDir: dctx.agentDir, throttleKey: "tool-surface" }),
		});
		const workerToolScope = preparedResources.toolScope;
		const seedUsableToolNames = usableToolNamesFromScope(workerToolScope);
		const thinkingPolicyContext = preparedResources.thinkingPolicyContext;
		if (cancellationSignal.aborted) throw new Error("aborted before worker construction");

		const workerSessionDir = buildWorkerSessionDir(dctx.agentDir);
		if (process.env.GRAFT_DEBUG_WORKER) {
			// eslint-disable-next-line no-console -- gated on GRAFT_DEBUG_WORKER, so it is off in a normal TUI session
			console.error(`[runDirectWorkerInner] agent="${req.agent.name}" activeWorkerTools=${JSON.stringify(workerToolScope.currentActiveToolNames())} noExtensions=${workerLoader?.["noExtensions"]}`);
		}
		const thinkingLevel = resolveThinkingLevel(req.agent.thinking, req.agent.name);
		workerThinkingLevel = thinkingLevel;

		const sessionMgr = SessionManager.create(dctx.cwd, workerSessionDir);
		workerSessionMgr = sessionMgr as unknown as { getEntries?: () => unknown[] };
		if (req.parentTranscriptSearch && dctx.parentTranscriptEntries) {
			registerParentTranscriptSnapshot(sessionMgr, dctx.parentTranscriptEntries);
		}
		const workerSeedAudit = applyWorkerSeeds(sessionMgr, {
			origin: { ownerSessionId: dctx.ownerSessionId, runId: dctx.runId, forkName: req.name, agent: req.agent.name },
			thinkingPolicy: thinkingPolicyContext?.policy,
			promptRepair: buildPromptRepairDelegateSeed(workerAttemptCount === 0),
			extensions: workerLoader?.getExtensions().extensions,
			// From the live scope, not the requested surface: an ext: selector grants
			// tools that never appear in surface.tools (#338 review).
			...(seedUsableToolNames ? { usableToolNames: seedUsableToolNames } : {}),
			...(req.tasks ? { tasks: { seed: req.tasks, options: { piSessionId: dctx.runId ?? rootRunId } } } : {}),
			...(req.focus ? {
				focus: {
					value: req.focus,
					options: {
						cwd: dctx.cwd,
						writableRoots: req.writableRoots,
						confineWrites: req.confineWrites,
						parentPiSessionId: dctx.ownerSessionId,
					},
				},
			} : {}),
		});
		workerAttemptCount += 1;
		logDelegateDiagnostic(formatWorkerSeedAudit(workerSeedAudit), { agentDir: dctx.agentDir });
		const strippedClaimant = formatStrippedClaimantWarning(workerSeedAudit, {
			extensions: workerLoader?.getExtensions().extensions,
			// From the live scope, not the requested surface: an ext: selector grants
			// tools that never appear in surface.tools (#338 review).
			...(seedUsableToolNames ? { usableToolNames: seedUsableToolNames } : {}),
		});
		if (strippedClaimant) logDelegateDiagnostic(strippedClaimant, { agentDir: dctx.agentDir });
		tasksSeeded = !isWorkerSeedPromptFallback(workerSeedAudit, "tasks");
		focusSeeded = !isWorkerSeedPromptFallback(workerSeedAudit, "focus");
		// Direct mode has no supervisor WorkerChannel. The small activity adapter
		// below only mirrors held/resumed state into the runtime/widget; it carries
		// no request payload and does not participate in escalation authority.
		const selectedExtensionMayProvideAsk = workerSurface.extSelectors.some(
			(selector) => selector.tool === undefined || selector.tool === ASK_TOOL_NAME,
		);
		const workerCustomTools = [
			...(dctx.getWorkerToolDefinitions?.(effectiveSurface.tools ?? []) ?? []),
			...(escalationEnabled
				? makeEscalationRaiseTools({
					sessionFile: () => sessionMgr.getSessionFile(),
					sessionId: () => sessionMgr.getSessionId(),
					agentDir: dctx.agentDir,
					rootRunId,
					runId: busFrame!.runId,
					lineagePath: escalationLineagePath,
					raiserLabel: req.name,
					participants: escalationParticipants,
					config: req.escalationPolicy!.config,
					credential: escalationCredential,
					ownerSessionId: dctx.ownerSessionId ?? rootRunId,
					workerChannel: directEscalationActivityChannel,
				})
				: []),
			...(selectedExtensionMayProvideAsk ? [workerAskTool] : []),
		];
		const createWorkerSession = () => createAgentSession({
			cwd: dctx.cwd,
			agentDir: dctx.agentDir,
			model: workerModel,
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(workerToolScope.sessionOptions.tools ? { tools: workerToolScope.sessionOptions.tools } : {}),
			...(workerToolScope.sessionOptions.excludeTools
				? { excludeTools: workerToolScope.sessionOptions.excludeTools }
				: {}),
			...(workerCustomTools.length > 0 ? { customTools: workerCustomTools } : {}),
			sessionManager: sessionMgr,
			settingsManager: workerSettingsManager,
			...childModelSessionOptions(dctx),
			resourceLoader: workerLoader,
		});
		let created: Awaited<ReturnType<typeof createAgentSession>>;
		try {
			created = await createWorkerSession();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isCredentialStoreLockErrorMessage(message)) throw error;
			if (!(await waitForLockRetry())) {
				throw new Error(sanitizeCredentialStoreLockExhaustion(), { cause: error });
			}
			try {
				created = await runWithinCredentialDeadline(createWorkerSession);
			} catch (retryError) {
				const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
				throw new Error(
					isCredentialStoreLockErrorMessage(retryMessage)
						? sanitizeCredentialStoreLockExhaustion()
						: isRouteAuthFailureMessage(retryMessage)
							? sanitizedRouteAuthFailureMessage(workerModelProvider)
							: retryMessage,
					{ cause: retryError },
				);
			}
		}
		workerSession = created.session;
		lifecycle.workerSession = workerSession;
		if (dctx.sessionRefs) dctx.sessionRefs.worker = workerSession;
		const workerCompactionConsumer = new WorkerCompactionConsumer(sessionMgr, workerSession);
		if (cancellationSignal.aborted) throw new Error("aborted before prompt");
		// ── Lineage serialize seam (spec 0003 / REQ-LIN-1) ─────────────────────
		// We are inside `runWithDepth`, so the unified frame is live: this is the
		// addressable point where a later detached-spawn shape (orchestrate,
		// spec 0005) injects the serialized lineage into the child process env
		// via `{ ...process.env, ...currentLineageEnv() }`. No child process is
		// spawned here (the direct worker is an in-process createAgentSession);
		// we only make the serialized frame reachable + surface it under the
		// existing worker-debug gate so the wiring is observable.
		if (process.env.GRAFT_DEBUG_WORKER) {
			// eslint-disable-next-line no-console -- gated on GRAFT_DEBUG_WORKER, so it is off in a normal TUI session
			console.error(
				`[runDirectWorkerInner] lineageEnvKeys=${JSON.stringify(currentLineageEnvKeyNames())}`,
			);
		}
		if (process.env.GRAFT_DEBUG_WORKER) {
			const activeTools = workerSession.getActiveToolNames?.() ?? "(no getActiveToolNames)";
			const hasBasic = ['read','bash','edit','write'].map(t => activeTools.includes?.(t) ? '✓' : '✗');
			// eslint-disable-next-line no-console -- gated on GRAFT_DEBUG_WORKER, so it is off in a normal TUI session
			console.error(`[runDirectWorkerInner] session created, tools=[${hasBasic.join(',')}] activeCount=${activeTools.length} active=${JSON.stringify(activeTools)}`);
		}
		result.workerSessionFile = workerSession.sessionFile;

		// Arm one deadline scheduler at the choke point shared by single-direct,
		// parallel-direct, chain, and programmatic callers. A positive timeout policy
		// keeps its immutable wall-clock deadline. Addressable direct runs also get
		// the default activity-based silence bound; later actor or descendant activity
		// moves only that bound.
		const timeoutPolicy = req.timeoutPolicy;
		if (!deadlineLifecycleArmed && (silenceGuardEnabled || (timeoutPolicy?.maxDurationMs ?? 0) > 0)) {
			deadlineLifecycleArmed = true;
			lastActivityAt = deadlineClock.now();
			lifecycle.onActivity = observeActivity;
			if (timeoutPolicy && timeoutPolicy.maxDurationMs > 0) {
				absoluteDeadlineAtMs = lastActivityAt + timeoutPolicy.maxDurationMs;
				if (lifecycle.nestedDelegatePolicy) lifecycle.nestedDelegatePolicy.parentDeadlineAtMs = absoluteDeadlineAtMs;
				emit({ timeoutDeadlineAtMs: absoluteDeadlineAtMs, timeoutPolicy });
			}
			// Keep the timer referenced. A blocked CLI provider may leave no other
			// event-loop handle; terminal cleanup always clears it.
			scheduleNextDeadline();
		}

		// hasUI identity rule: bind a real uiContext only when interactive.
		// Pass the installed confinement so a nested dispatch by this worker cannot
		// hand its child wider filesystem authority than the worker itself holds.
		if (req.interactive && dctx.workerUIContext) {
			await withDelegateOwnedExtensionBind(() =>
				workerSession!.bindExtensions({ uiContext: dctx.workerUIContext }),
				nestedDelegatePolicy,
			);
		} else {
			await withDelegateOwnedExtensionBind(() => workerSession!.bindExtensions({}), nestedDelegatePolicy);
		}
		// Apply the live scope after session_start and retain the call-time veto
		// for the whole AgentSession lifetime.
		workerToolScope.install(workerSession);
		result.activeToolNames = [...workerSession.getActiveToolNames()];
		if (typeof releaseWorkerToolRegistration === "function") releaseWorkerToolRegistration();

		// Subscribe for both the short-lived widget phase and transcript projection.
		// Direct mode produces only worker entries — there is no supervisor actor.
		promptHarvest = undefined;
		promptMessages = undefined;
		promptContinuationAttempts = 0;
		promptUsageRecorded = false;
		const activityProjector = actorActivity
			? createAgentActivityProjector({ mode: "direct-worker", publisher: actorActivity })
			: undefined;
		let promptRepairPhaseActive = false;
		const unsubscribePromptRepairActivity = preparedResources.eventBus.on(
			PROMPT_REPAIR_ACTIVITY_CHANNEL,
			(value) => {
				const activity = parsePromptRepairActivity(value);
				if (activity) {
					promptRepairPhaseActive = true;
					actorActivity?.publish("worker", activity);
				}
			},
		);
		const unsubscribe = workerSession.subscribe((ev) => {
			try {
				if (!promptRepairPhaseActive || !shouldPreservePromptRepairActivity(ev.type)) {
					promptRepairPhaseActive = false;
					activityProjector?.handle(ev);
				}
			} catch {
				// UI-only activity must never interrupt the worker session.
			}
			promptHarvest?.observe(ev);
			if ((ev as unknown as { type?: string }).type === "entry_appended") {
				const record = parsePromptRepairRecord((ev as unknown as { entry?: unknown }).entry);
				if (record) {
					result.promptRepairs = mergePromptRepairRecords(result.promptRepairs ?? [], [record]);
					for (const entry of promptRepairTranscriptEntries([record])) dctx.onTranscriptEntry?.(entry);
				}
				return;
			}
			if (ev.type !== "message_end" || !ev.message) return;
			// Event-bus `updated` (spec 0004 / REQ-BUS-1): emit BEFORE the
			// transcript-callback guard so the bus records activity even when no
			// onTranscriptEntry is wired — the bus is the authoritative nested
			// record a parent's heartbeat reads. Best-effort.
			// Issue #226 — task counts ride on THIS event rather than one of their
			// own. Keeping them on every message-end means the ordinary rolling update
			// and the retained task snapshot are the same event under `MAX_STEPS`, so a
			// later message cannot leave task progress stale.
			const taskFields = taskProgressFieldsFromEntries(workerSessionMgr?.getEntries?.());
			emitBusEvent("updated", { event: "message_end", ...(taskFields ?? {}) });
			// Mirror the same counts into live state so the widget row can show
			// them without re-reading the worker's session file.
			if (taskFields) emit({ taskProgress: taskFields[TASK_PROGRESS_FIELD] });
			if (!dctx.onTranscriptEntry) return;
			try {
				for (const entry of messagesToTranscript("worker", [
					sanitizeDirectCredentialMessage(ev.message as AgentMessage, workerModelProvider),
				])) {
					dctx.onTranscriptEntry(entry);
				}
			} catch {
				/* swallow — transcript stream is best-effort */
			}
		});

		try {
			// Event-bus `started` (spec 0004 / REQ-BUS-1): leaf worker about to
			// run; record its liveness baseline as a descendant of its parent.
			emitBusEvent("started", { agent: req.agent.name });
			// Publish the initial full snapshot as an ordinary `updated` event.
			// This is the last known row set even when the worker is terminated
			// before its first model response.
			const seededTaskFields = taskProgressFieldsFromEntries(workerSessionMgr?.getEntries?.());
			if (seededTaskFields) {
				emitBusEvent("updated", { event: "task_seed", ...seededTaskFields });
				emit({ taskProgress: seededTaskFields[TASK_PROGRESS_FIELD] });
			}
			emit({ status: "running", workerSessionFile: workerSession.sessionFile });
			result.status = "running";

			// ── Compose the worker's first user message ───────────────────
			let userMessage = fallbackPromptOverride ?? req.task;
			if (fallbackPromptOverride === undefined) {
				if (req.reads && req.reads.length > 0) {
					const composed = composeReadsBlock({
						reads: req.reads,
						baseCwd: dctx.cwd,
						maxBytesPerFile: req.maxReadBytes,
					});
					if (composed.warnings.length > 0) {
						warnings.push({
							kind: "reads",
							message: formatReadsWarnings(composed.warnings),
						});
					}
					userMessage = composed.block
						? `${composed.block}\n\n${req.task}`
						: req.task;
				}
				// The degradation path: the worker still gets its plan, just not
				// durably. Appended last so it survives as the message's final lines,
				// where a checklist reads as instructions rather than as context.
				if (req.tasks && !tasksSeeded) {
					userMessage = appendTasksToPrompt(userMessage, req.tasks);
				}
				if (req.focus && !focusSeeded) {
					userMessage = appendFocusToPrompt(userMessage, req.focus, {
						cwd: dctx.cwd,
						writableRoots: req.writableRoots,
						confineWrites: req.confineWrites,
					});
				}
			}
			// ── Send to worker, await final reply ──────────────────────────
			// `prompt()` doesn't accept an AbortSignal directly — pi's API uses
			// `session.abort()` for cancellation. Wire the caller's signal to
			// the worker session so dispatch-mode cancel reaches the worker.
			let abortListener: (() => void) | undefined;
			if (cancellationSignal.aborted) {
				// Route every pre-prompt cancellation through the same terminal
				// classification and timeout-checkpoint recovery as an interrupted prompt.
				throw new Error(internalCancellationReason ? internalCancellationMessage(true) : "aborted before prompt");
			} else {
				if (dctx.signal) {
					abortListener = () => {
						if (workerSession) abortWorkerCompaction(workerSession);
						workerSession?.abort().catch(() => {});
					};
					dctx.signal.addEventListener("abort", abortListener, { once: true });
				}
				result.roundsUsed = 1;
				emit({ currentRound: 1, lastSupervisorText: req.task });
				try {
					let promptText = userMessage;
					let retryCurrentRequest: "lock" | "auth" | undefined;
					let capacityContinuation: {
						snapshot: Parameters<typeof continueCapacityRequest>[0];
						choice: WorkerModelChoice;
					} | undefined;
					while (true) {
						let collected: PromptLifecycleHarvestResult;
						if (capacityContinuation) {
							const continuation = capacityContinuation;
							capacityContinuation = undefined;
							const adoptContinuationModel = (): void => {
								if (
									workerSession.model?.provider !== continuation.choice.model.provider ||
									workerSession.model.id !== continuation.choice.model.id
								) return;
								workerModelProvider = continuation.choice.model.provider;
								workerModelRef = continuation.choice.canonicalRef;
								result.workerModel = workerModelRef;
							};
							let messages: readonly AgentMessage[];
							try {
								messages = await continueCapacityRequest(continuation.snapshot, {
									modelChoice: continuation.choice.model,
									thinkingLevel,
									signal: cancellationSignal,
								}) as readonly AgentMessage[];
							} catch (error) {
								adoptContinuationModel();
								if (cancellationSignal.aborted) throw error;
								throw new DirectCapacityContinuationError(
									error instanceof Error && error.message.startsWith("capacity fallback could not continue safely:")
										? error.message
										: `capacity fallback could not continue safely: ${error instanceof Error ? error.message : String(error)}`,
									{ cause: error },
								);
							}
							adoptContinuationModel();
							logDelegateDiagnostic(
								`worker capacity fallback continued direct task ${req.name} on ${workerModelRef}`,
								{ agentDir: dctx.agentDir, level: "log" },
							);
							collected = {
								messages: [...messages],
								lifecycleObserved: true,
								anchorFound: true,
								runEndingToolObserved: false,
								settled: true,
								lastAssistantStopReason: messages.slice().reverse().find((message) => message.role === "assistant")?.stopReason,
							};
						} else if (retryCurrentRequest) {
							// Agent.continue() resumes from the existing user/toolResult boundary.
							// It adds no new user prompt, so completed tool effects cannot replay.
							const retryKind = retryCurrentRequest;
							retryCurrentRequest = undefined;
							const cursor = workerSession.messages.length;
							const continueRequest = () => workerSession.agent.continue();
							try {
								if (retryKind === "lock") {
									await runWithinCredentialDeadline(continueRequest);
								} else {
									await raceAgainstCredentialCancellation(continueRequest());
								}
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								sanitizePromptCredentialFailures();
								if (isCredentialStoreLockErrorMessage(message)) {
									throw new Error(sanitizeCredentialStoreLockExhaustion(), { cause: error });
								}
								if (isRouteAuthFailureMessage(message)) {
									throw new Error(sanitizedRouteAuthFailureMessage(workerModelProvider), { cause: error });
								}
								throw error;
							}
							const messages = (workerSession.messages as AgentMessage[]).slice(cursor);
							collected = {
								messages,
								lifecycleObserved: true,
								anchorFound: true,
								runEndingToolObserved: false,
								settled: true,
								lastAssistantStopReason: messages.slice().reverse().find((message) => message.role === "assistant")?.stopReason,
							};
						} else {
							promptHarvest = createPromptLifecycleHarvest();
							const deliverPrompt = () => promptWhenIdle(
								workerSession,
								promptText,
								undefined,
								{
									signal: cancellationSignal,
									compactionTimeoutMs: DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS,
									onBeforePrompt: (delivery) => promptHarvest?.begin(
										delivery === "direct" ? workerSession.messages.length : undefined,
									),
									onPromptUserMessage: (message) => promptHarvest?.expectUserMessage(message),
								},
							);
							try {
								await deliverPrompt();
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								if (!isCredentialStoreLockErrorMessage(message)) throw error;
								if (!(await waitForLockRetry())) {
									throw new Error(sanitizeCredentialStoreLockExhaustion(), { cause: error });
								}
								const stateMessages = workerSession.agent.state.messages as AgentMessage[];
								const lastRole = stateMessages[stateMessages.length - 1]?.role;
								const retryRequest = lastRole === "user" || lastRole === "toolResult"
									? () => workerSession.agent.continue()
									: deliverPrompt;
								try {
									await runWithinCredentialDeadline(retryRequest);
								} catch (retryError) {
									const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
									if (isCredentialStoreLockErrorMessage(retryMessage)) {
										throw new Error(sanitizeCredentialStoreLockExhaustion(), { cause: retryError });
									}
									if (isRouteAuthFailureMessage(retryMessage)) {
										throw new Error(sanitizedRouteAuthFailureMessage(workerModelProvider), { cause: retryError });
									}
									throw retryError;
								}
							}
							const completedHarvest = promptHarvest;
							promptHarvest = undefined;
							collected = completedHarvest.finish(workerSession.messages as AgentMessage[]);
						}
						if (extensionToolDeadline?.expiryError) throw extensionToolDeadline.expiryError;
						// Internal wall-clock and silence cancellations must not look like
						// ordinary provider failures after the worker prompt unwinds.
						if (cancellationSignal.aborted) {
							throw new Error(internalCancellationReason ? internalCancellationMessage() : "aborted");
						}
						promptMessages = [
							...(promptMessages ?? []),
							...(collected.messages as AgentMessage[]),
						];
						let boundaryHarvest = classifyHarvestOutcome(promptMessages);
						const compactionTimeoutMs = DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS;
						const compactionDeadline = Date.now() + compactionTimeoutMs;
						await workerCompactionConsumer.consume({
							signal: cancellationSignal,
							deadline: compactionDeadline,
							timeoutMs: compactionTimeoutMs,
							waitForCompactionBoundary: () => waitForCompactionBoundary(
								workerSession,
								cancellationSignal,
								compactionDeadline,
								compactionTimeoutMs,
							),
							onFailure: (message) => logDelegateDiagnostic(message, { agentDir: dctx.agentDir }),
						});
						if (cancellationSignal.aborted) {
							throw new Error(internalCancellationReason ? internalCancellationMessage() : "aborted");
						}
						if (boundaryHarvest.kind === "failure" && isCredentialStoreLockErrorMessage(boundaryHarvest.error)) {
							const retry = await waitForLockRetry();
							sanitizePromptCredentialFailures();
							if (retry && removeRetryableAssistantFromAgentState()) {
								retryCurrentRequest = "lock";
								continue;
							}
							boundaryHarvest = { kind: "failure", error: sanitizeCredentialStoreLockExhaustion() };
						} else if (boundaryHarvest.kind === "failure" && isRefreshableRouteAuthFailureMessage(boundaryHarvest.error)) {
							const retry = await refreshCurrentProviderFor401();
							sanitizePromptCredentialFailures();
							if (retry && removeRetryableAssistantFromAgentState()) {
								retryCurrentRequest = "auth";
								continue;
							}
							boundaryHarvest = {
								kind: "failure",
								error: sanitizedRouteAuthFailureMessage(workerModelProvider),
							};
						} else if (boundaryHarvest.kind === "failure" && isRouteAuthFailureMessage(boundaryHarvest.error)) {
							sanitizePromptCredentialFailures();
							boundaryHarvest = {
								kind: "failure",
								error: sanitizedUnrefreshableRouteAuthFailureMessage(workerModelProvider),
							};
						}
						if (
							boundaryHarvest.kind === "failure" &&
							isCapacityFailureMessage(boundaryHarvest.error) &&
							shouldAdvanceLadderForRouteFailure(boundaryHarvest.error, modelCursor, req.agent)
						) {
							const inspection = inspectCapacityContinuation(
								workerSession,
								boundaryHarvest.error,
								cancellationSignal,
							);
							if (inspection.ok === false) {
								throw new DirectCapacityContinuationError(
									`capacity fallback could not continue safely: ${inspection.detail}`,
								);
							}
							// Consume a route only after the live continuation boundary has passed
							// every safety check. An unsafe boundary must fail closed, not silently
							// discard the route and become eligible for a fresh task replay.
							const nextChoice = nextWorkerModel();
							if (nextChoice) {
								capacityContinuation = { snapshot: inspection.snapshot, choice: nextChoice };
								continue;
							}
						}
						const delegateOnlyMode = getActiveDelegateOnlyMode();
						const workerKey = workerSession.sessionFile || req.name;
						if (
							delegateOnlyMode &&
							boundaryHarvest.kind === "substantive" &&
							shouldRequestShorterResult(boundaryHarvest.text, workerKey)
						) {
							promptText =
								`Your result exceeded the delegate-only advisory budget of ${delegateOnlyMode.config.resultAdvisoryBytes} bytes. ` +
								"Return a shorter result now, keeping it within that byte budget.";
							continue;
						}
						if (shouldAttemptHarvestContinuation(
							boundaryHarvest,
							{
								...collected,
								hasUserMessage: collected.messages.some((message) => message.role === "user"),
							},
							promptContinuationAttempts,
						)) {
							promptContinuationAttempts += 1;
							promptText = RUN_ENDING_CONTINUATION_PROMPT;
							continue;
						}
						break;
					}
				} finally {
					if (abortListener && dctx.signal) {
						dctx.signal.removeEventListener("abort", abortListener);
					}
				}
			}

			// Skip post-prompt processing when the run never started (already-
			// aborted short-circuit above). The status is already stamped.
			if (result.status === "running") {
				capturePromptRepairs();
				const workerMessages = promptMessages ?? (workerSession.messages as AgentMessage[]);
				const harvest = classifyHarvestOutcome(workerMessages);
				result.harvest = harvest;
				lastAssistantText = harvest.kind === "substantive"
					? harvest.text
					: harvest.kind === "failure"
						? harvest.error
						: harvest.reason === "cancellation-only"
							? getLastAssistantMessageText(workerMessages)
							: getLastAssistantText(workerMessages);
				result.collapsedContent = harvest.kind === "failure"
					? harvest.error
					: harvest.kind === "substantive"
						? harvest.text
						: harvest.reason === "cancellation-only"
							? getLastAssistantMessageText(workerMessages)
							: "";

				// Build the full transcript (post-hoc — we also emitted incremental).
				result.transcript = withPromptRepairTranscript(messagesToTranscript(
					"worker",
					workerMessages,
				));

				// Direct mode records the complete request-scoped aggregate once,
				// including a machine continuation when one was required.
				recordPromptUsage(workerMessages);

				if (harvest.kind === "failure") {
					if (harvest.errorKind === "refusal") {
						recordRefusal(workerModelRef);
						fallbackPromptOverride = promptRepairFallbackPromptFromEntries(
							workerSessionMgr?.getEntries?.() ?? [],
						);
						const nextChoice = nextWorkerModel();
						if (nextChoice) {
							result.activeToolNames = undefined;
							pendingWorkerModel = nextChoice;
							replacingWorkerAttempt = true;
							result.status = "running";
							result.error = undefined;
							result.errorKind = undefined;
							logDelegateDiagnostic(
								`worker model ${workerModelRef} refused for direct task ${req.name}; falling back to ${nextChoice.canonicalRef}`,
								{ agentDir: dctx.agentDir, level: "log" },
							);
							emit({ status: "running", lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
						} else {
							result.status = "failed";
							result.error = harvest.error;
							result.errorKind = harvest.errorKind;
							emit({ status: "failed", error: result.error, errorKind: result.errorKind, refusalModels: result.refusalModels, lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
						}
					} else {
						const routeFailureKind = isTransientWorkerErrorMessage(harvest.error)
							? "transient"
							: isCapacityFailureMessage(harvest.error)
								? "capacity"
								: undefined;
						if (routeFailureKind) {
							const nextChoice = shouldAdvanceLadderForRouteFailure(harvest.error, modelCursor, req.agent)
								? nextWorkerModel()
								: undefined;
							if (nextChoice) {
								result.activeToolNames = undefined;
								pendingWorkerModel = nextChoice;
								replacingWorkerAttempt = true;
								result.status = "running";
								result.error = undefined;
								result.errorKind = undefined;
								logDelegateDiagnostic(
									`worker model ${workerModelRef} hit a ${routeFailureKind} route failure for direct task ${req.name}; falling back to ${nextChoice.canonicalRef}`,
									{ agentDir: dctx.agentDir, level: "log" },
								);
								emit({ status: "running", lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
							} else {
								result.status = "failed";
								result.errorKind = "no-model-alternative";
								// #332: this branch is the transient/capacity route-failure exhaustion
								// (routeFailureKind above), so the recovery observer may retry it.
								result.retryKind = "transient";
								// #469/#197: record WHICH of the two it was, while the
								// provider's own message is still intact. formatNoModelAlternative
								// below suffixes it, after which it no longer classifies.
								result.failureCause = classifyWorkerFailureCause(harvest.error);
								result.error = formatNoModelAlternative(harvest.error, attemptedModels?.length ?? 0);
								emit({ status: "failed", error: result.error, errorKind: result.errorKind, lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
							}
						} else {
							result.status = "failed";
							result.error = harvest.error;
							result.errorKind = harvest.errorKind;
							// A failure that reached here is neither transient nor
							// capacity by `routeFailureKind` above, so this stays
							// undefined. Classifying anyway keeps the single source of
							// truth in `classifyWorkerFailureCause` rather than in the
							// shape of this if/else.
							result.failureCause = classifyWorkerFailureCause(harvest.error);
							emit({ status: "failed", error: result.error, errorKind: result.errorKind, lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
						}
					}
				} else if (harvest.kind === "missing") {
					result.status = "failed";
					result.error = promptContinuationAttempts > 0
						? formatRunEndingContinuationFailure(workerSession.sessionFile)
						: "No substantive assistant output recovered";
					emit({ status: "failed", error: result.error, lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
				} else {
					result.status = "completed";
				}
			}

			// A declared artifact must exist and be non-empty after clean completion.
			// A declared check gates publication and gets one producer retry before failure.
			if (result.status === "completed") {
				try {
					const artifact = readDirectArtifact(req, artifactLocation);
					if (artifact && artifactLocation) {
						const checkedCandidate = readWorkerArtifactCandidate(artifactLocation.attempt);
						let check: { status: "pending" | "passed"; command?: string; output?: string } = { status: "pending" };
						if (req.check !== undefined) {
							const checkResult = await runArtifactCheck({
								command: req.check,
								cwd: dctx.cwd,
								chainDir: artifactLocation.baseDir,
								signal: cancellationSignal,
							});
							if (checkResult.status === "aborted") throw new Error(checkResult.diagnostic);
							if (checkResult.status === "failed") {
								if (artifactCheckFailures === 0) {
									artifactCheckFailures = 1;
									const nextAttempt = (req.attempt ?? 1) + 1;
									req = {
										...req,
										attempt: nextAttempt,
										task: artifactCheckRetryTask(originalTask, req.name, checkResult.output),
									};
									result.attempt = nextAttempt;
									result.task = req.task;
									result.status = "running";
									result.roundsUsed = 0;
									result.collapsedContent = "";
									result.harvest = { kind: "missing", reason: "no-assistant", text: "" };
									result.transcript = [];
									result.outputFile = undefined;
									result.artifactRef = undefined;
									result.artifactError = undefined;
									result.error = undefined;
									result.errorKind = undefined;
									result.retryKind = undefined;
									result.failureCause = undefined;
									result.refusalModels = undefined;
									refusalModels.length = 0;
									attemptedModels = undefined;
									result.attemptedModels = undefined;
									pendingWorkerModel = undefined;
									fallbackPromptOverride = undefined;
									modelCursor = plannedModels.kind === "planned"
										? new WorkerModelCursor(plannedModels.requests[0]!.modelPlan)
										: undefined;
									lastAssistantText = "";
									replacingWorkerAttempt = true;
									emit({ status: "running", attempt: nextAttempt, lastWorkerText: "" });
								} else {
									const detail = artifactCheckFailure(req.name, checkResult);
									result.status = "failed";
									result.error = detail;
									retainArtifactFailureAssistantText(result);
									result.outputFile = undefined;
									result.artifactRef = undefined;
									emit({ status: "failed", error: detail, lastWorkerText: lastAssistantText });
								}
							} else {
								check = { status: "passed", command: req.check, output: checkResult.output };
							}
						}
						if (result.status === "completed") {
							const published = await publishWorkerArtifact(artifactLocation.attempt, {
								candidate: checkedCandidate,
								description: `Artifact ${req.artifact} produced by ${req.name}`,
								check,
								signal: cancellationSignal,
							});
							result.outputFile = published.outputFile;
							result.artifactRef = published.artifactRef;
						}
					}
				} catch (error) {
					if (cancellationSignal.aborted || internalCancellationReason !== undefined) throw error;
					const fileDetail = formatOutputFileError(error);
					const detail = req.check === undefined
						? fileDetail
						: `artifact harvest failed for producing step '${req.name}': ${fileDetail}`;
					result.status = "failed";
					result.error = detail;
					retainArtifactFailureAssistantText(result);
					result.outputFile = undefined;
					result.artifactRef = undefined;
					if (error instanceof WorkerArtifactStorageBusyError) {
						result.artifactError = { kind: "storage-busy", message: error.message, retryable: true };
					} else if (error instanceof WorkerArtifactUnavailableError) {
						result.artifactError = { kind: "artifact-unavailable", message: error.message, retryable: false };
					}
					emit({ status: "failed", error: detail, lastWorkerText: lastAssistantText });
				}
			}
			// A timeout that wins after prompt processing but before publication still
			// owns the terminal state. Salvage the live session rather than allowing a
			// late completion path to report success.
			if (result.status === "completed" && timeoutResultIfObserved()) {
				emit({ status: "aborted", error: result.error });
				return result;
			}
			if (result.status === "completed") {
				if (req.progress && req.chainDir) {
					try {
						const fs = await import("node:fs/promises");
						const progressPath = `${req.chainDir}/progress.md`;
						const progressLine = `- [done] ${req.name} (${req.agent.name}) at ${new Date().toISOString()}\n`;
						if (timeoutResultIfObserved()) {
							emit({ status: "aborted", error: result.error });
							return result;
						}
						// Keep the potentially delayed await separate from the terminal write.
						// The final append is synchronous, so the timeout callback cannot win
						// between the provenance check and committing the [done] marker.
						await fs.appendFile(progressPath, "");
						if (timeoutResultIfObserved()) {
							emit({ status: "aborted", error: result.error });
							return result;
						}
						appendFileSync(progressPath, progressLine);
					} catch (err: any) {
						warnings.push({
							kind: "progress",
							message: `failed to update progress.md: ${err?.message ?? err}`,
						});
					}
				}
				// Re-check after the asynchronous progress preparation as well as before
				// the final completion update.
				if (timeoutResultIfObserved()) {
					emit({ status: "aborted", error: result.error });
					return result;
				}
				emit({ status: "completed", lastWorkerText: lastAssistantText, cost: result.usage.cost, usage: { ...result.usage } });
			}
		} catch (err: any) {
			if (workerSession && promptHarvest) {
				const activeHarvest = promptHarvest;
				promptHarvest = undefined;
				const collected = activeHarvest.finish(workerSession.messages as AgentMessage[]);
				promptMessages = [
					...(promptMessages ?? []),
					...(collected.messages as AgentMessage[]),
				];
			}
			capturePromptRepairs();
			const finalizedPromptMessages = promptMessages ?? (workerSession?.messages as AgentMessage[] | undefined) ?? [];
			if (finalizedPromptMessages.length > 0) {
				result.transcript = withPromptRepairTranscript(messagesToTranscript("worker", finalizedPromptMessages));
			}
			recordPromptUsage(finalizedPromptMessages);
			const deadlineError = extensionToolDeadline?.expiryError;
			if (deadlineError) {
				result.status = "failed";
				result.error = deadlineError.message;
				result.harvest = { kind: "failure", error: deadlineError.message };
				result.collapsedContent = "";
				emit({ status: "failed", error: result.error });
			} else if (cancellationSignal.aborted) {
				// Only the owning caller's signal or this runner's internal deadline is
				// cancellation provenance. Provider-origin AbortErrors remain failures.
				const reason = internalCancellationReason ?? dctx.getCancelReason?.() ?? "user";
				result.status = "aborted";
				result.cancelReason = reason;
				result.error = err?.message ?? "aborted";
				const abortedMessages = finalizedPromptMessages;
				const abortedHarvest = workerSession
					? classifyHarvestOutcome(abortedMessages)
					: { kind: "missing", reason: "no-assistant", text: "" } as HarvestOutcome;
				result.harvest = abortedHarvest;
				result.recoveredOutput = abortedHarvest.kind === "substantive";
				lastAssistantText = getLastAssistantText(abortedMessages) || lastAssistantText;
				if (reason === "timeout" || reason === "heartbeat") {
					applyTimeoutSalvage();
				} else {
					if (abortedMessages.length > 0) result.transcript = withPromptRepairTranscript(messagesToTranscript("worker", abortedMessages));
					result.collapsedContent = lastAssistantText;
				}
				emit({ status: "aborted", error: result.error });
			} else {
				result.status = "failed";
				const transportError = err?.message ?? String(err);
				const workerSessionFile = workerSession?.sessionFile ?? result.workerSessionFile;
				const workerMessages = workerSession ? finalizedPromptMessages : [];
				const harvest: HarvestOutcome = workerSession
					? classifyHarvestOutcome(workerMessages)
					: { kind: "missing", reason: "no-assistant", text: "" };
				if (err instanceof DirectCapacityContinuationError) {
					result.harvest = { kind: "failure", error: transportError };
					result.error = transportError;
					result.collapsedContent = transportError;
					result.failureCause = "provider-capacity";
					result.retryKind = undefined;
					emit({ status: "failed", error: result.error, workerSessionFile });
				} else {
					result.harvest = harvest;
					result.error = workerSessionFile
						? `${transportError} (worker session: ${workerSessionFile})`
						: transportError;
					if (harvest.kind === "substantive") {
						result.recoveredOutput = true;
						result.collapsedContent = formatRecoveredWorkerOutput(
							harvest.text,
							String(transportError),
							workerSessionFile,
						);
					}
					emit({ status: "failed", error: result.error, workerSessionFile });
				}
			}
		} finally {
			// A route fallback replaces the model session but remains the same logical
			// worker run, so it keeps the first session's deadline. Every terminal route
			// clears both timers; the caller's outer finally remains the backstop for
			// setup failures between arming this lifecycle and entering the prompt block.
			if (!replacingWorkerAttempt) clearBudgetTimers();
			try {
				unsubscribePromptRepairActivity();
			} catch {
				/* swallow */
			}
			try {
				unsubscribe();
			} catch {
				/* swallow */
			}
		}
		if (replacingWorkerAttempt) {
			try {
				if (workerSession) await disposeWorkerSession(workerSession, nestedDelegatePolicy);
			} catch {
				/* swallow */
			} finally {
				releaseDirectAttemptScratchLease(lifecycle);
				if (artifactAttempt !== undefined) {
					try { await finishWorkerArtifactAttempt(artifactAttempt); }
					catch { /* preserve the retry result; maintenance reclaims only proven-dead attempts */ }
					artifactAttempt = undefined;
				}
			}
			if (lifecycle.workerSession === workerSession) lifecycle.workerSession = undefined;
			workerSession = undefined;
			if (dctx.sessionRefs) dctx.sessionRefs.worker = undefined;
			result.activeToolNames = undefined;
			continue;
		}
		break;
		}
	} catch (err: any) {
		// Outer catch: setup failure (model resolve, loader, session create).
		// Counts as "failed" unless a named cancel aborted construction before
		// session refs / prompt wiring existed.
		const deadlineError = extensionToolDeadline?.expiryError;
		if (deadlineError) {
			result.status = "failed";
			result.error = deadlineError.message;
			emit({ status: "failed", error: result.error });
		} else if (cancellationSignal.aborted) {
			markAbortedBeforeConstruction(err?.message ?? "aborted before worker construction");
		} else {
			result.status = "failed";
			result.error = err?.message ?? String(err);
			if (err instanceof WorkerArtifactStorageBusyError) {
				result.artifactError = { kind: "storage-busy", message: err.message, retryable: true };
			} else if (err instanceof WorkerArtifactUnavailableError) {
				result.artifactError = { kind: "artifact-unavailable", message: err.message, retryable: false };
			}
			emit({ status: "failed", error: result.error });
		}
	} finally {
		if (artifactAttempt !== undefined) {
			try { await finishWorkerArtifactAttempt(artifactAttempt); }
			catch { /* identity loss is fail-closed; bounded maintenance may reclaim only death-proven ownership */ }
		}
		// Unconditional backstop for the complete logical worker run. Every terminal
		// route — including timeout returns during publication — must release its
		// caller link and extension deadline, retain warnings, emit the terminal bus
		// event, and record run history exactly once. Refusal fallbacks stay inside
		// this outer lifecycle and therefore keep the first timeout deadline.
		clearBudgetTimers();
		clearOwnerAbortLink();
		extensionToolDeadline?.dispose();
		// `finalize()` appends the refused-write warning (#536), so publishing the
		// array here would drop it: the assignment happened first and the later push
		// landed on a local array nobody reads. `finalize()` publishes instead.
		try {
			finalize();
		} finally {
			unsubscribeActorActivity?.();
		}
	}
	return result;
}

/**
 * Build the trailing system-prompt note that documents the framing for a
 * direct worker. This is exported solely so future chain code can choose
 * whether to opt into the framing for one-shot steps. Kept identical to
 * the supervised-mode framing constant so subagents see consistent
 * context across modes.
 */
export const DIRECT_WORKER_FRAMING = WORKER_DELEGATION_FRAMING;
