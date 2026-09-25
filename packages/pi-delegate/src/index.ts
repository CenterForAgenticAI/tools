/**
 * delegate extension
 *
 * Registers a single tool `delegate` that runs one or more delegate entries
 * in parallel. Each entry lets the main agent have a multi-turn conversation
 * with a specialist subagent in a private scratchpad, then collapses the whole
 * sub-conversation into a single tool response before the main agent's turn
 * resumes. This gives parallel-subagent benefits with mid-flight guidance but
 * without polluting the main thread's history.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type, type TProperties, type TSchema, type TObject } from "@sinclair/typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	discoverAgentsAll,
	discoverChains,
	resolveByScopePrecedence,
	type PackageAgentDiscoveryOptions,
} from "./agents.js";
import { configuredPackageRoots } from "./configured-package-roots.js";
import {
	forwardedParams,
	isDelegatedWorkerEnv,
	LEGACY_CONTROL_TOOL_NAMES,
	resolveControlCall,
	resolveEscalationCall,
	workerControlGrants,
} from "./control-surface.js";
import { type ControlVisibilityState, visibleControlTools } from "./control-visibility.js";
import { resolveChildCwd } from "./cwd-resolution.js";
import { DelegateParams as CanonicalDelegateParams, prepareArguments } from "./delegate-params.js";
import { compileDelegateRuns, hasSupervisedProgress, SUPERVISED_PROGRESS_WARNING } from "./delegate-runs.js";
import { assertNoRemovedArtifactFieldsAtIngress } from "./delegate-normalize.js";
export { normalizeDelegateParams } from "./delegate-normalize.js";
export { DelegateParamsInternal, prepareArguments } from "./delegate-params.js";
export { compileDelegateRuns, validateRuns, rejection } from "./delegate-runs.js";
import {
	installGraftAgentCapabilityRegistry,
	type GraftCapabilityRegistryHandle,
} from "./graft-capability-registry.js";
import {
	installSessionActiveWorkQueryRegistry,
	type SessionActiveWorkQueryRegistryHandle,
} from "./session-active-work-query.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import {
	appendCompletionUsageMetadata,
	buildCompletionMessage,
	buildEscalationPendingMessage,
	bindWakeSinkToCurrentContext,
	clearLiveWakeSink,
	deliverWakeMessage,
	setWakeDeliveryObserver,
	setWakeDeliveryBarrier,
	deliverPendingDispatchWakes,
	getLiveWakeSink,
	getLiveWakeSinkOwnerSessionId,
	notifyCompletion as notifyCompletionViaPendingWakes,
	notifyForkFailed,
	setLiveWakeSink,
	runFailureReasonFor,
	getProcessNonce,
	type EscalationPendingMessage,
	type RunFailureReason,
	type RunFailureRecovery,
	type NotifyCompletionInput,
	type NotifyCompletionSink,
} from "./pending-wakes.js";
import { registerChildCompletionGate } from "./worker-session-lifecycle.js";
import { handleManagementAction, ManagementConfigSchema } from "./agent-management.js";
import {
	deliverEscalationToHolder,
	drainUserEscalations,
	formatHeldEscalations,
	listEscalationRootRunIds,
	listHeldEscalations,
	passHeldEscalation,
	readHeldEscalationRequest,
	redeliverEscalationWakes,
	resolveHeldEscalation,
	type EscalationSurfaceUI,
} from "./escalation-surface.js";
import {
	advanceEscalations,
	cleanupEscalationsForRun,
	purgeLegacyDecisionState,
} from "./escalation-runtime.js";
import type { EscalationRequest } from "./escalation-store.js";
import { applyAgentOverrides } from "./agent-overrides.js";
import { mergeEnvOverrides, type EnvOverrides } from "./env-overrides.js";
import {
	modelScopeFromExtensionContext,
	planWorkerModelRequests,
	type ModelScope,
	type WorkerModelPlan,
} from "./model-selection.js";
import { sanitizedProviderId } from "./refusal.js";
import { providerAuthReader } from "./sdk-model-runtime.js";
import { workerArtifactReceipt } from "./artifact-workspace.js";
import { preflightSummaryModels } from "./summary-model-preflight.js";
import { applyInvocationOverrides, type InvocationAgentOverrides } from "./invocation-overrides.js";
import {
	captureRunTimeoutDeadline,
	isHardCancelEnabled,
	MAX_TIMEOUT_MS,
	resolveRunTimeoutPolicy,
} from "./fork-timeout.js";
import { wireSignalToDispatch } from "./dispatch-signal.js";
import { hasUnsupportedOrchestrateOptions, resolveAwaitMode } from "./launch-mode.js";
import { resolveIntercomBridgeWithPolicy } from "./intercom-bridge.js";
import {
	installIntercomDetachResponder,
	type IntercomDetachHandle,
} from "./intercom-detach.js";
import { installPtmBridge, type PtmBridgeHandle } from "./ptm-bridge.js";
import {
	setupSlashCommands,
	type DelegateCancelParams,
	type DelegateCancelTarget,
} from "./slash-commands.js";
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_MAX_CONSECUTIVE_HEARTBEATS,
	type DelegateConfig,
	type EscalationConfig,
	type ResolvedEscalationConfig,
	loadConfig,
	loadConfigReadOnly,
	stripRemovedPlaneConfigKeys,
} from "./config.js";
import { setupDelegateOnly } from "./delegate-only/index.js";
import { resolveDelegateOnlyDepth } from "./delegate-only/fork-policy.js";
import { capDelegateOnlyResult } from "./delegate-only/result-caps.js";
import {
	getParentTranscriptSnapshot,
	PARENT_TRANSCRIPT_SEARCH_TOOL_NAME,
	searchParentTranscript,
} from "./parent-transcript-search.js";
import { projectAgentTrustError } from "./project-trust.js";
import {
	assertAwaitEscalationCompatibility,
	parseEscalationInvocationValue,
	resolveEscalationPolicy,
	type EffectiveEscalationPolicy,
} from "./escalation-policy.js";
import {
	isDelegateOwnedExtensionApi,
	nestedDelegatePolicyForApi,
	shouldSkipForegroundLifecycleForDelegateOwnedApi,
} from "./delegate-session-scope.js";
import {
	buildDirectRunState,
	coerceStringifiedArrayParams,
	detectShape,
	expandParallelTasks,
	pumpDirectWorkers,
	resolveParentTranscriptSearch,
	resolveWritableRoots,
	type DirectTaskInput,
} from "./direct-shape.js";
import { appendFocusToPrompt } from "./focus-seam.js";
import { getDelegatePresentationTerminology } from "./footer-presentation.js";
import { parseSlotTasks, type TaskLedger, type TasksSeed } from "./task-seam.js";
import {
	computeRunEntryDisplayLabels,
	forkAliasErrorText,
	renderRunEntryIdentity,
	resolveRunEntryAlias,
} from "./fork-label.js";
import { validateNestedDelegateAgentPolicy, validateNestedDelegateConfinement } from "./nested-delegate-policy.js";
import {
	executeChain,
	isParallelStep,
	isRunStep,
	type ChainStep,
} from "./chain-execution.js";
import { resolveSavedChainPlan } from "./saved-chain-resolution.js";
import { savedChainContextForStep } from "./saved-chain-context.js";
import { prepareSavedChainRunStep } from "./saved-chain-run.js";
import type { CloneMode } from "./seed.js";
import {
	runFork,
	type ForkRequest,
	type RunResult,
	type ForkSessionRefs,
} from "./fork-runner.js";
import type { WorkerChannelClock } from "./worker-channel.js";
import { formatForkWarningLines } from "./fork-warnings.js";
import { renderPromptRepairReport } from "./prompt-repair-seam.js";
import { prepareChainDir, sweepOldChainDirs } from "./output-file.js";
import { assertReadOnlyValue } from "./write-confinement.js";
import { unavailableMutationReport } from "./mutation-tracking.js";
import { readRunHistory, recordPreflightFailure } from "./run-history.js";
import { StateLockTimeoutError } from "./state-io.js";
import { resolveSkillResource } from "./skill-resource.js";
import { pidAlive, sweepOldEventSinks } from "./event-bus.js";
import {
	claimPendingResult,
	consumePendingResult,
	deleteOrchestrateActiveMarkerForRun,
	deleteOrchestrateOwnerEvidence,
	type OrchestrateCfg,
	readOrchestrateActiveMarkerOwner,
	readOrchestrateActiveMarkerProcessState,
	readOrchestrateCfgOwnerEvidence,
	resolvePendingFile,
	sweepOrchestrateOwnerEvidence,
	resolveResultFile,
	scanPendingResults,
	unclaimPendingResult,
	spawnDetachedOrchestrate,
	ORCHESTRATE_OWNER_SESSION_ENV,
} from "./detached-spawn.js";
import {
	answerDaemonDriverUi,
	cancelDaemonDriver,
	followUpDaemonDriver,
	hasOwnedDaemonDriverRun,
	isDaemonRequestError,
	launchDaemonDriver,
	promptStatusDaemonDriver,
	readDaemonDriverCfg,
	recoverDaemonDriver,
	replayDaemonDriver,
	statusDaemonDriver,
	steerDaemonDriver,
	type DaemonUiAnswer,
} from "./daemon-driver.js";
import {
	awaitControlResult,
	postControlRequest,
	rootRunIdFromLineagePath,
} from "./control-inbox.js";
import {
	currentChain,
	currentDepth,
	currentLineageFrame,
	DepthGuardError,
	type DepthFrame,
	HARD_MAX_DEPTH,
	validateMaxSubagentDepth,
} from "./depth-guard.js";
import {
	deserializeLineage,
	deserializeLineageDetached,
	lineagePath,
	serializeLineageDetached,
} from "./lineage.js";
import {
	CONTROL_SECRET_ENV,
	finalizeTerminalOrchestrateRoute,
	type InProcessRunRef,
	mintControlSecret,
	resolveOwnerSessionId,
	resolveRunControl,
	routeDetachedControl,
	type RouteRecord,
	sweepOldOrchestrateRoutes,
	writeRouteRecord,
} from "./control-route.js";
import { captureProcessIdentity } from "./process-identity.js";
import {
	formatUniformRunStatus,
	isUniformRunLive,
	listAllRunStatuses,
	readRunEventTail,
	MAX_DETACHED_SCAN,
	resolveRunResult,
	resolveRunStatus,
	type UniformRunStatus,
} from "./run-introspect.js";
import {
	orchestrateRecoveryInProgress,
	reconcileDeadOrchestrateRuns,
} from "./orchestrate-recovery.js";
import {
	assertValidExtensionToolSelectors,
	getOptionalGlobalExtensionSelectorKeys,
	resolveRunToolSurface,
} from "./tool-surface.js";
export {
	parseToolGrant,
	toolSelectorDiagnostic,
	ToolSelectorDiagnosticCode,
	type ToolGrant,
	type BuiltinToolGrant,
	type ExtensionToolGrant,
	type ToolGrantError,
} from "./tool-selector.js";
import {
	renderDelegateCall,
	renderDelegateCompletionMessage,
	renderDelegateRecoveryMessage,
	renderDelegateResult,
} from "./render.js";
import { boundHistoryErrorMessage, recordRun } from "./run-history.js";
import { deriveRunId, isSafeRunId } from "./run-id.js";
import { isValidRetryOf } from "./fork-predecessor.js";
import {
	buildDirectRecoveryDescriptor,
	buildSupervisedRecoveryDescriptor,
	captureRecoveryTopLevelSettings,
	dispatchRecoveryChildSafely,
	executeRecoveryOnce,
	releaseRecoveryLaunchAfterTransientFailure,
	sanitizeRecoveryText,
	truncateRecoveryText,
	type ExecuteRecoveryOnceResult,
	type RecoveryLaunchResult,
	type RunRecoveryDescriptor,
} from "./fork-recovery.js";
import {
	abortAllRuns,
	appendTranscriptEntry,
	captureOrphanedDispatchWakeDelivery,
	captureSyncOrphanRecoveryDelivery,
	configureRuntimePersistence,
	type CancelReason,
	completeRun,
	drainPendingGuidance,
	drainPendingPrompts,
	countLiveRuns,
	type RunLiveState,
	type RunLiveStatus,
	type DelegateDispatchState,
	getRun,
	isLiveStatus,
	hasLocalRunAuthority,
	listPendingOrphanedDispatchWakes,
	listPendingSyncOrphanRecoveries,
	isHydratedRun,
	listRuns,
	markOrphanedDispatchWakeSurfaced,
	markSyncOrphanRecoverySurfaced,
	pushPendingGuidance,
	recordRunCompletedResult,
	revokeRunRegistration,
	summarizeRecoveryProvenance,
	type RecoveryProvenanceSummary,
	reapNeverConstructedRuns,
	cancelNeverConstructedRun,
	registerRun,
	registerRunWithRetryClaims,
	setEventEmitter,
	type SteerDelivery,
	sweepOldCompletedRuns,
	updateRunState,
	projectRunLivePatch,
} from "./runtime.js";
export {
	createDelegateRuntimeClient,
	readDelegateRuntimeReceipt,
	readDelegateRuntimeResult,
	resolveDelegateRuntimeReceiptPath,
	resolveDelegateRuntimeResultPath,
	DELEGATE_RUNTIME_ENVELOPE_VERSION,
	DELEGATE_RUNTIME_API_HANDLE_KEY,
} from "./runtime-api.js";
export type {
	DelegateRuntimeApiHandle,
	DelegateRuntimeCancelRequest,
	DelegateRuntimeClient,
	DelegateRuntimeDispatchRequest,
	DelegateRuntimeErrorCode,
	DelegateRuntimeForkProvenance,
	DelegateRuntimeForkReceipt,
	DelegateRuntimeInputDigest,
	DelegateRuntimeReceipt,
	DelegateRuntimeResult,
	DelegateRuntimeSteerRequest,
	DelegateRuntimeToolResult,
} from "./runtime-api.js";
export { DelegateRuntimeError } from "./runtime-api.js";
import {
	createDelegateRuntimeClient,
	installDelegateRuntimeCore,
	readDelegateRuntimeReceipt,
	uninstallDelegateRuntimeCore,
} from "./runtime-api.js";
import type { DelegateRuntimeToolResult } from "./runtime-api.js";
import {
	collectDelegateHealth,
	formatDelegateHealth,
	startPeriodicMaintenance,
	type MaintenanceHandle,
} from "./maintenance.js";
import { enumerateRunDescendants, sweepKill } from "./process-sweep.js";
import { setupActivityTicker, type ActivityTickerHandle } from "./activity-ticker.js";
import { clearAllActorActivity } from "./actor-activity.js";
import { setupStatusWidget, type StatusWidgetHandle } from "./status-widget.js";
import { setupTranscriptOverlay, type TranscriptOverlayHandle } from "./transcript-overlay.js";
import { setupUsageFooterStatus, type UsageStatusHandle } from "./usage-status.js";
import { installReloadGuard } from "./reload-guard.js";
import {
	aggregateRunResults,
	buildDelegateUsageMetadata,
	delegateUsageFromAggregate,
	summarizeRunUsages,
	type DelegateUsageMetadata,
} from "./usage-rollup.js";
import type { TranscriptEntry } from "./summarize.js";
import { projectRunResults, type ProjectedRunResult } from "./run-result-boundary.js";
import { buildRoutedUIContext } from "./worker-ui.js";
import {
	cleanupWorktrees,
	createWorktreeDiffsDir,
	createWorktrees,
	diffWorktrees,
	formatWorktreeDiffSummary,
	registerWorktreeProvider,
	type WorktreeDiff,
	type WorktreeInfo,
	type WorktreeProvider,
	type WorktreeRequest,
	type WorktreeSetup,
} from "./worktree.js";

// Re-export worktree provider hook (spec 0109) so extensions
// (e.g. graft) can register a custom worktree provider on load.
export {
	registerWorktreeProvider,
	type WorktreeProvider,
	type WorktreeRequest,
	type WorktreeInfo,
};

// Explicit coordinator surface for one-way workspace-to-cache promotion.
export {
	promoteWorkerArtifact,
	type PromoteWorkerArtifactArgs,
	type PromoteWorkerArtifactDependencies,
	type WorkerArtifactPromotionResult,
} from "./artifact-promotion.js";

export {
	validateWorkerArtifactReference,
	type WorkerArtifactReference,
	type WorkerArtifactManifest,
} from "./artifact-workspace.js";

export type {
	RunResult,
	ForkResult,
	RunStatus,
	ForkStatus,
	RunUpdate,
	ForkUpdate,
	PriorWorkerSession,
} from "./fork-runner.js";
export {
	RUN_LIVE_STATUSES,
	FORK_LIVE_STATUSES,
} from "./runtime.js";
export type {
	RunLiveStatus,
	ForkLiveStatus,
	RunLiveState,
	ForkLiveState,
	DelegateDispatchState,
	ForkRunState,
} from "./runtime.js";

// CLI-callable surface — see src/cli-delegate.ts. Re-exported here so
// downstream consumers and scripted callers can import `delegateFromCli`
// from the package root without reaching into internal modules.
export { hasActiveDelegateWork } from "./active-delegate-work.js";

export {
	delegateFromCli,
	extractGraftCommit,
	type CliDelegateOptions,
	type CliDelegateResult,
	type CliDelegateSnapshot,
	type CliDelegateRunResult,
	type CliDelegateForkResult,
	type CliDelegateForkSnapshot,
	type CliDelegateRunSnapshot,
	type CliDelegateTaskInput,
} from "./cli-delegate.js";

const MAX_PARALLEL_ENTRIES = 6;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ROUNDS = 5;

export const WHOLE_PREFLIGHT_WARMUP_DEADLINE_MS = 20_000;

type PlannedProviderAuthRequest = {
	modelPlan: WorkerModelPlan;
};

export interface WarmPlannedProviderAuthArgs {
	requests: readonly PlannedProviderAuthRequest[];
	modelRegistry: object;
	signal?: AbortSignal;
	/** Deterministic test seam; production callers use WHOLE_PREFLIGHT_WARMUP_DEADLINE_MS. */
	deadlineMs?: number;
	onDiagnostic?: (message: string) => void;
}

function credentialWarmupAbortError(): Error {
	const error = new Error("Credential warm-up cancelled");
	error.name = "AbortError";
	return error;
}

/**
 * Warm every distinct canonical provider in the finalized model plans before dispatch starts.
 *
 * ModelRegistry cannot forward an AbortSignal on the oldest supported host, so
 * calls receive only providerId and are raced against caller cancellation and
 * one whole-preflight deadline. A timed-out host call may remain in flight; its
 * result is observed and discarded. Worst case is approximately 20 s warming
 * plus host lock waits and 5–15 s jitter: approximately 95 s end to end, while
 * the Part 1 credential retry remains inside its own 75 s elapsed cap.
 */
export async function warmPlannedProviderAuth(args: WarmPlannedProviderAuthArgs): Promise<void> {
	if (args.signal?.aborted) throw credentialWarmupAbortError();
	const providerIds = [...new Set(
		args.requests.flatMap((request) => [
			request.modelPlan.primary,
			...request.modelPlan.rungs.flatMap((rung) => rung.choices),
		]).map((choice) => choice.model.provider),
	)];
	if (providerIds.length === 0) return;

	const readProviderAuth = providerAuthReader(args.modelRegistry);
	if (!readProviderAuth) {
		args.onDiagnostic?.("credential warm-up skipped: host does not expose getProviderAuth");
		return;
	}

	const pendingProviders = new Set(providerIds);
	const warmCalls = providerIds.map(async (providerId) => {
		try {
			await readProviderAuth(providerId);
			return undefined;
		} catch {
			return providerId;
		} finally {
			pendingProviders.delete(providerId);
		}
	});
	const completed = Promise.all(warmCalls).then((failedProviders) => ({
		kind: "completed" as const,
		failedProviders: failedProviders.filter((providerId): providerId is string => providerId !== undefined),
	}));

	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const deadlineMs = Math.max(0, args.deadlineMs ?? WHOLE_PREFLIGHT_WARMUP_DEADLINE_MS);
	const deadline = new Promise<{ kind: "timed-out" }>((resolve) => {
		deadlineTimer = setTimeout(() => resolve({ kind: "timed-out" }), deadlineMs);
	});
	const cancelled = new Promise<never>((_, reject) => {
		if (!args.signal) return;
		abortListener = () => reject(credentialWarmupAbortError());
		args.signal.addEventListener("abort", abortListener, { once: true });
		if (args.signal.aborted) abortListener();
	});

	let outcome: Awaited<typeof completed> | { kind: "timed-out" };
	try {
		outcome = await Promise.race([completed, deadline, cancelled]);
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		if (abortListener) args.signal?.removeEventListener("abort", abortListener);
	}
	if (args.signal?.aborted) throw credentialWarmupAbortError();

	if (outcome.kind === "timed-out") {
		const pending = [...pendingProviders].map(sanitizedProviderId).sort();
		pendingProviders.clear();
		args.onDiagnostic?.(
			pending.length === 1
				? `credential warm-up timed out provider=${pending[0]}`
				: `credential warm-up timed out providers=${pending.join(",")}`,
		);
		return;
	}
	for (const providerId of outcome.failedProviders) {
		args.onDiagnostic?.(`credential warm-up failed provider=${sanitizedProviderId(providerId)}`);
	}
}

function failureSiblingStates(
	runState: DelegateDispatchState,
	failedEntryName: string,
): Array<{ forkName: string; status: RunLiveStatus }> {
	return Object.values(runState.forks).slice(0, 16).map((entry) => ({
		forkName: entry.name,
		status: entry.name === failedEntryName ? "failed" : entry.status,
	}));
}

type RunEntryNoun = "fork" | "worker" | "step" | "run";
type ForkAliasEntryNoun = Parameters<typeof forkAliasErrorText>[0]["entryNoun"];

function runEntryTerminology(shape: string | undefined): { singular: RunEntryNoun; plural: string } {
	const terminology = getDelegatePresentationTerminology(shape);
	return terminology.kind === "unknown"
		? { singular: "run", plural: "runs" }
		: { singular: terminology.singular as RunEntryNoun, plural: terminology.plural };
}

function runEntryNoun(shape: string | undefined): ForkAliasEntryNoun {
	return runEntryTerminology(shape).singular as ForkAliasEntryNoun;
}

interface RecoveryDispatchAuthority {
	epoch: number;
	ownerSessionId: string;
	context: ExtensionContext;
}

class RecoveryAuthorityLostError extends Error {
	constructor() {
		super("live recovery authority was invalidated before child registration");
		this.name = "RecoveryAuthorityLostError";
	}
}

function rootRunIdForNewRun(runId: string): string {
	return currentLineageFrame()?.rootRunId ?? deserializeLineage(process.env)?.rootRunId ?? runId;
}

// SCHEMA BUDGET (issue: tool-schema context cost): these shared field schemas
// are inlined by TypeBox into every slot that spreads them — 6 slots for the
// escalation/confinement/removed-plane groups, 9-11 for skill/thinking/model.
// A character trimmed here is a character saved 6-11 times in the serialized
// tool schema the model carries in every request, so descriptions are kept to
// the minimum a caller needs to pick the field. Full prose lives in
// `docs/delegate-tool-api.md`.
const InvocationSkillOverrideSchema = Type.Union(
	[Type.String(), Type.Array(Type.String()), Type.Literal(false)],
	{ description: "Skill name(s); false disables skills." },
);
function withDescription<T extends TSchema>(schema: T, description: string): T {
	return { ...schema, description } as T;
}

const SlotSkillOverrideSchema = withDescription(
	InvocationSkillOverrideSchema,
	"false disables.",
);
const InvocationFallbackModelsSchema = Type.Union(
	[Type.String(), Type.Array(Type.String())],
	{ description: "Fallback model refs; comma-separated string or array." },
);
const SlotFallbackModelsSchema = withDescription(
	InvocationFallbackModelsSchema,
	"Fallback refs.",
);
const InvocationThinkingOverrideSchema = Type.Union([Type.String(), Type.Literal(false)], {
	description: "Thinking level; false clears it.",
});
const SlotThinkingOverrideSchema = withDescription(
	InvocationThinkingOverrideSchema,
	"false clears.",
);
const RemovedPlaneConfigFields = {
	decisionPlane: Type.Optional(Type.Unknown({ description: "Removed; ignored." })),
	decisionRouting: Type.Optional(Type.Unknown({ description: "Removed; ignored." })),
};

function ClosedItemSchema<T extends TProperties>(properties: T): TObject<T> & { propertyNames: TSchema } {
	const schema = Type.Object(properties, { additionalProperties: false }) as TObject<T> & { propertyNames: TSchema };
	schema.propertyNames = Type.Union(
		Object.keys(properties).map((key) => Type.Literal(key)) as unknown as [TSchema, TSchema, ...TSchema[]],
	);
	return schema;
}

/** Exact predecessor reference. Kept compact because this schema is reused in
 * all three ordinary delegate slot positions. */
const RetryOfSchema = Type.Object({
	runId: Type.String(),
	forkName: Type.String(),
}, { additionalProperties: false });

export function resolveHeartbeatConfig(
	item: { heartbeat_interval_ms?: number; max_consecutive_heartbeats?: number },
	defaults: { intervalMs?: number; maxConsecutive?: number } = {},
): { intervalMs: number; maxConsecutive: number } {
	return {
		intervalMs: item.heartbeat_interval_ms ?? defaults.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
		maxConsecutive: item.max_consecutive_heartbeats ?? defaults.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE_HEARTBEATS,
	};
}

const EscalationTimeoutBehaviorSchema = Type.Union([
	Type.Literal("useDefault"),
	Type.Literal("noDefaultError"),
	Type.Literal("cancel"),
]);
const EscalationPerKindTimeoutMsSchema = Type.Object({
	decision: Type.Optional(Type.Integer({ minimum: 1 })),
	blocker: Type.Optional(Type.Integer({ minimum: 1 })),
	amendment: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const EscalationPerKindTimeoutBehaviorSchema = Type.Object({
	decision: Type.Optional(EscalationTimeoutBehaviorSchema),
	blocker: Type.Optional(EscalationTimeoutBehaviorSchema),
	amendment: Type.Optional(EscalationTimeoutBehaviorSchema),
}, { additionalProperties: false });
const EscalationInvocationSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("local"),
	Type.Object({
		mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("local")])),
		authority: Type.Optional(Type.Object({
			decision: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("implementation"), Type.Literal("all")])),
			blocker: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("all")])),
			amendment: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("all")])),
			tags: Type.Optional(Type.Array(Type.String())),
		}, { additionalProperties: false })),
		intermediate: Type.Optional(Type.Boolean()),
		hopTimeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
		timeoutMs: Type.Optional(Type.Union([
			Type.Integer({ minimum: 1 }),
			EscalationPerKindTimeoutMsSchema,
		])),
		timeoutBehavior: Type.Optional(Type.Union([
			EscalationTimeoutBehaviorSchema,
			EscalationPerKindTimeoutBehaviorSchema,
		])),
		holdStrategy: Type.Optional(Type.Union([
			Type.Literal("hold-open"),
			Type.Literal("park"),
		], {
			description: '"park" is reserved and rejected.',
		})),
	}, { additionalProperties: false }),
], {
	description:
		'Escalation policy: "off" disables; "local" enables. Object form is a partial override. Requires background; reject await:true or sync:true.'
});
const SlotEscalationInvocationSchema = withDescription(
	EscalationInvocationSchema,
	"Per-slot escalation; requires background; reject await:true or sync:true."
);
const EscalationSlotField = {
	escalation: Type.Optional(SlotEscalationInvocationSchema),
};
const EscalationRootField = {
	escalation: Type.Optional(EscalationInvocationSchema),
};

/**
 * Per-slot writable-root authority (issue #51). Every shape carries the same
 * pair so a mixed invocation can widen or waive confinement independently per
 * worker. See `docs/write-confinement.md` for what is enforced and what is not.
 */
const WriteConfinementSlotFields = {
	writableRoots: Type.Optional(
		Type.Array(Type.String()),
	),
	confineWrites: Type.Optional(
		Type.Boolean(),
	),
	readOnly: Type.Optional(Type.Boolean()),
};
const WriteConfinementRootFields = {
	writableRoots: Type.Optional(
		Type.Array(Type.String(), {
			description: "Extra writable roots beyond cwd, per-run scratch, and artifact roots; absolute or main-cwd-relative.",
		}),
	),
	confineWrites: Type.Optional(
		Type.Boolean({
			description: "Confine writes to cwd, scratch, and `writableRoots`.",
		}),
	),
	readOnly: Type.Optional(Type.Boolean({
		description: "Enforce read-only policy.",
	})),
};

/**
 * Wrap-up steer delivered to a fork's supervisor clone when the wall-clock
 * budget elapses. Distinguishable from a user/parent steer so the supervisor
 * knows to drive the worker to a final answer immediately (REQ-WIND-1).
 */
const FORK_WIND_DOWN_STEER =
	"[wind-down] This fork has reached its wall-clock budget. Stop starting new work and " +
	"wrap up NOW: get the worker's final answer (or salvage its best current output) and call " +
	"finish_delegation immediately. You have a brief grace window before hard cancellation, if enabled.";

const WALL_CLOCK_BUDGET_ACK =
	"Budget acknowledgement: max_duration_ms can trigger wind-down, but hard cancellation is off while enforceWallClockBudget is false and perForkMaxDurationMs is 0.";


// NAMING CONVENTION (issue #13 nit): the TOOL-FACING schema uses snake_case
// field names (`snippet_last_n`, `clone_mode`, `max_rounds`, ...) because
// that's the convention models are trained on for tool args; everything
// INTERNAL uses camelCase (`snippetLastN`, `cloneMode`, `maxRounds`). The
// mapping happens exactly once, at the tool-arg ingestion boundary (the
// `execute` handlers below) — never deeper in the stack.
// ── The dispatched checklist ───────────────────────────────────────────────
// Named `checklist`, NOT `tasks`, on purpose: `tasks` is already this tool's
// parallel-direct worker array, so a slot field of the same name would read
// `tasks: [{agent, task, tasks: [...]}]` — two unrelated meanings one nesting
// level apart. Given the Apr 2026 "1488 forks" incident, an ambiguity a model
// can resolve the wrong way is not worth matching the issue's wording.
//
// Deliberately loose: a bare array of strings is what a caller actually
// writes, and `parseSlotTasks` tolerates both that and the object form. A
// schema strict enough to reject a half-right checklist would fail the whole
// dispatch over a cosmetic detail.
//
// The description is carried ONCE, on the supervised slot, and the other three
// shapes take the bare array. This schema is sent to the provider on every
// call, and repeating ~190 bytes of prose four times buys nothing — a model
// that has read it on `agents` knows the shape everywhere. See the size
// ceiling in tests/unit/schema-validation.test.ts.
const SlotChecklistSchema = Type.Array(Type.Unknown());

/**
 * Convert the task contract's snake_case owner reference once, at the tool
 * boundary. The session-entry and bus payloads use the internal camelCase
 * spelling; runners never perform a second conversion.
 */
function normalizeTaskSeedWire(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeTaskSeedWire);
	if (value === null || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = { ...input };
	if (output.ownerTaskId === undefined && typeof input.owner_task_id === "string") {
		output.ownerTaskId = input.owner_task_id;
	}
	delete output.owner_task_id;
	if (Array.isArray(output.tasks)) output.tasks = output.tasks.map(normalizeTaskSeedWire);
	if (Array.isArray(output.subtasks)) output.subtasks = output.subtasks.map(normalizeTaskSeedWire);
	return output;
}

const DescribedChecklistSchema = Type.Array(Type.Unknown(), {
	description:
		"Checklist seeded into the worker before its first turn; strings or {title,status?,note?,subtasks?}.",
});

const SlotDepthField = {
	maxSubagentDepth: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: HARD_MAX_DEPTH,
		}),
	),
};

const AgentItemSchema = ClosedItemSchema({
	retryOf: Type.Optional(RetryOfSchema),
	name: Type.Optional(
		Type.String({
			description:
				"Handle for steering/cancel/recovery. Name it after the work; defaults to the agent name with #2, #3 suffixes for duplicates.",
		}),
	),
	agent: Type.String({
		description: "Agent definition name.",
	}),
	task: Type.String({
		description: "Initial task. Exact first worker turn by default; supervisor-mediated delivery may refine it.",
	}),
	model: Type.Optional(
		Type.String({ description: "Worker model override: provider/id or bare id." }),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
		description: "Per-slot env; null unsets; lineage vars ignored.",
	})),
	thinking: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMin: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMax: Type.Optional(SlotThinkingOverrideSchema),
	fallbackModels: Type.Optional(SlotFallbackModelsSchema),
	skill: Type.Optional(SlotSkillOverrideSchema),
	skills: Type.Optional(SlotSkillOverrideSchema),
	clone_mode: Type.Optional(
		StringEnum(["full", "snippet", "task_only"] as const, {
			description:
				'How to seed the supervisor: "full" (whole history), "snippet" (last N messages), or "task_only" (task only).',
		}) as any,
	),
	task_delivery: Type.Optional(
		StringEnum(["supervisor-mediated", "direct-first-turn"] as const, {
			description:
				'How to deliver the supervised slot task: "direct-first-turn" (default) delivers the caller\'s exact task to the worker first, then seeds the supervisor with that completed exchange; "supervisor-mediated" lets the supervisor compose the first turn.',
		}) as any,
	),
	snippet_last_n: Type.Optional(
		Type.Number({ description: 'Messages included by clone_mode="snippet".' }),
	),
	max_duration_ms: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: MAX_TIMEOUT_MS,
			description: "Fork wall-clock budget in ms; 0 disables it unless a global ceiling applies.",
		}),
	),
	wind_down_grace_ms: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: MAX_TIMEOUT_MS,
			description: "Grace after wind-down in ms; 0 hard-cancels immediately.",
		}),
	),
	max_rounds: Type.Optional(
		Type.Number({
			description: `Maximum accepted worker-message rounds, including the direct first turn; default ${DEFAULT_MAX_ROUNDS}.`,
		}),
	),
	collapse_mode: Type.Optional(
		StringEnum(["final_output", "summary"] as const, {
			description:
				'Fork result: "final_output" returns finish_delegation verbatim; "summary" refines it with summary_model when configured.',
		}) as any,
	),
	summary_model: Type.Optional(
		Type.String({
			description: 'Summary provider/model; "auto" uses the built-in default and fails closed if unavailable.',
		}),
	),
	supervisor_instructions: Type.Optional(
		Type.String({
			description:
				"Guidance for the supervisor clone.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Fork working directory; absolute or main-cwd-relative. Cannot be combined with top-level `worktree`.",
		}),
	),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Route worker UI prompts to the overlay; otherwise prompts auto-deny. Enable only when the user is watching.",
		}),
	),
	parentTranscriptSearch: Type.Optional(Type.Boolean({ description: "Grant capped search excerpts from the parent transcript." })),
	...WriteConfinementSlotFields,
	...SlotDepthField,
	heartbeat_interval_ms: Type.Optional(
		Type.Number({
			description: "Heartbeat silence interval override (ms).",
		}),
	),
	max_consecutive_heartbeats: Type.Optional(
		Type.Number({
			description: "Heartbeat limit before auto-escalation.",
		}),
	),
	checklist: Type.Optional(DescribedChecklistSchema),
	...EscalationSlotField,
	...RemovedPlaneConfigFields,
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Agent discovery scope; builtins are always available.',
	default: "both",
}) as any;

// ── Phase A: direct-mode common per-task fields ──────────────────────────────
// Shared between the single-agent shape and entries inside the parallel
// `tasks: […]` shape. NOT applied to supervised `agents: […]` entries —
// the supervisor controls the message stream, so artifact/reads/progress are
// only meaningful in direct mode.
const DirectTaskFields = {
	retryOf: Type.Optional(RetryOfSchema),
	agent: Type.String({ description: "Agent definition name." }),
	task: Type.String({ description: "Initial task for the worker." }),
	checklist: Type.Optional(SlotChecklistSchema),
	cwd: Type.Optional(
		Type.String({
			description: "Worker cwd.",
		}),
	),
	artifact: Type.Optional(
		Type.Union([Type.String(), Type.Literal(false)], {
			description:
				"Name one file the worker must write as its deliverable; the runtime resolves it to the worker's artifact workspace and tells the worker the exact absolute path to write. false suppresses an agent default.",
		}),
	),
	reads: Type.Optional(
		Type.Union([Type.Array(Type.String()), Type.Literal(false)], {
			description: "Optional context files."
		}),
	),
	parentTranscriptSearch: Type.Optional(Type.Boolean({ description: "Grant capped search excerpts from the parent transcript." })),
	progress: Type.Optional(
		Type.Boolean({
			description: "Write progress."
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Worker model override: provider/id or bare id." }),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
	thinking: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMin: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMax: Type.Optional(SlotThinkingOverrideSchema),
	fallbackModels: Type.Optional(SlotFallbackModelsSchema),
	skill: Type.Optional(SlotSkillOverrideSchema),
	skills: Type.Optional(SlotSkillOverrideSchema),
	interactive: Type.Optional(
		Type.Boolean({
			description: "Route per-task UI prompts.",
		}),
	),
	...WriteConfinementSlotFields,
	...SlotDepthField,
	...EscalationSlotField,
	...RemovedPlaneConfigFields,
};

// ── Direct-mode parallel task item (used inside `tasks: [...]`) ─────────
const ParallelDirectTaskItem = ClosedItemSchema({
	...DirectTaskFields,
	count: Type.Optional(
		Type.Number({
			minimum: 1,
			description: "Repeat this task N times in parallel.",
		}),
	),
});

// ── Phase B: chain shape ────────────────────────────────────────────────────
// Sequential pipeline of direct-worker steps with optional parallel
// fan-out. Template variables `{task}`, `{previous}`, `{chain_dir}` are
// substituted in each step's task body. See `src/chain-execution.ts` for
// semantics and `docs/subagent-parity-plan.md` §4 for the full design.

const ChainSequentialStepSchema = Type.Object({
	agent: Type.String({ description: "Agent definition name." }),
	task: Type.Optional(
		Type.String({
			description:
				"Task body; supports {task}, {previous}, {chain_dir}. Later omitted tasks use {previous}.",
		}),
	),
	cwd: Type.Optional(Type.String()),
	artifact: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	reads: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal(false)])),
	parentTranscriptSearch: Type.Optional(Type.Boolean({ description: "Grant capped search excerpts from the parent transcript." })),
	progress: Type.Optional(Type.Boolean()),
	skill: Type.Optional(SlotSkillOverrideSchema),
	skills: Type.Optional(SlotSkillOverrideSchema),
	model: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
	thinking: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMin: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMax: Type.Optional(SlotThinkingOverrideSchema),
	fallbackModels: Type.Optional(SlotFallbackModelsSchema),
	interactive: Type.Optional(Type.Boolean()),
	...WriteConfinementSlotFields,
	...SlotDepthField,
	...EscalationSlotField,
	...RemovedPlaneConfigFields,
});

const ChainParallelSlotSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	artifact: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	reads: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal(false)])),
	parentTranscriptSearch: Type.Optional(Type.Boolean({ description: "Grant capped search excerpts from the parent transcript." })),
	progress: Type.Optional(Type.Boolean()),
	skill: Type.Optional(SlotSkillOverrideSchema),
	skills: Type.Optional(SlotSkillOverrideSchema),
	model: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
	thinking: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMin: Type.Optional(SlotThinkingOverrideSchema),
	thinkingMax: Type.Optional(SlotThinkingOverrideSchema),
	fallbackModels: Type.Optional(SlotFallbackModelsSchema),
	interactive: Type.Optional(Type.Boolean()),
	...WriteConfinementSlotFields,
	...SlotDepthField,
	...EscalationSlotField,
	...RemovedPlaneConfigFields,
	name: Type.Optional(Type.String()),
	count: Type.Optional(Type.Number({ minimum: 1 })),
});

const ChainParallelStepSchema = Type.Object({
	parallel: Type.Array(ChainParallelSlotSchema, { minItems: 1 }),
	concurrency: Type.Optional(Type.Number()),
	failFast: Type.Optional(Type.Boolean()),
	worktree: Type.Optional(Type.Boolean()),
});

const ChainStepSchema = Type.Union([ChainSequentialStepSchema, ChainParallelStepSchema]);

// ── Unified DelegateParams (flat object, no top-level anyOf) ───────────────
//
// Replaces the prior `Type.Union([SupervisedShape, SingleDirectShape,
// ParallelDirectShape, ChainShape])`. The Union worked fine for TypeBox
// validation but emitted JSON Schema with `anyOf: [...]` at the top level,
// which Claude Opus 4.x is observed to mishandle: when the chosen branch's
// array value crosses a size threshold (~1KB) the model emits the array as
// a JSON-encoded *string* instead of as proper JSON. See the Apr 2026
// "1488 forks" incident in the README / commit log.
//
// Flattening eliminates the `anyOf`. We still detect which mode the caller
// intended via `detectShape()` at the top of `execute()` and reject calls
// that supply more than one of `agents` / `tasks` / `chain` / `{agent,task}`.
// Retired from the advertised surface: legacy call shapes are absorbed
// permanently by normalizeDelegateParams() and validated by
// DelegateParamsInternal. It is retained here (not deleted) as the executable
// record of the pre-redesign grammar that the normalizer must keep accepting;
// deleting it cascades through ~600 lines of shared slot fragments, which is
// the cutover issue's scope, not this one's.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LegacyDelegateParams = Type.Object({
	runs: Type.Optional(Type.Array(Type.Unknown())),
	// ── Mode selectors (mutually exclusive — runtime-enforced) ────────
	agents: Type.Optional(
		Type.Array(AgentItemSchema, {
			description: `Supervised multi-turn forks (1–${MAX_PARALLEL_ENTRIES}); results collapse to one entry for each supervised fork.`,
			minItems: 1,
			maxItems: MAX_PARALLEL_ENTRIES,
		}),
	),
	tasks: Type.Optional(
		Type.Array(ParallelDirectTaskItem, {
			description: `Parallel one-turn workers without a supervisor (1–${MAX_PARALLEL_ENTRIES}); \`count\` repeats an entry.`,
			minItems: 1,
			maxItems: MAX_PARALLEL_ENTRIES,
		}),
	),
	chain: Type.Optional(
		Type.Union(
			[
				Type.Array(ChainStepSchema, { minItems: 1 }),
				Type.String(),
			],
			{
				description:
					"Inline sequential steps (including `{parallel: [...]}`) or a saved `.chain.md` name; a string is equivalent to `chainName`.",
			},
		),
	),
	chainName: Type.Optional(
		Type.String({
			description:
				"Saved `.chain.md` template; mutually exclusive with an inline `chain` array.",
		}),
	),
	orchestrate: Type.Optional(
		Type.Object(
			{
				agent: Type.String({
					description:
						"Driver agent with the full inherited tool set, including `delegate`.",
				}),
				task: Type.String({
					description: "Driver's initial task for the pipeline.",
				}),
				checklist: Type.Optional(SlotChecklistSchema),
				model: Type.Optional(
					Type.String({ description: "Driver model override: provider/id or bare id." }),
				),
				env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
				maxSubagentDepth: Type.Optional(
					Type.Integer({
						minimum: 0,
						maximum: HARD_MAX_DEPTH,
						description:
							`Driver sub-dispatch depth; minimum 3 supports foreground→driver→worker→reviewer, maximum ${HARD_MAX_DEPTH}.`,
					}),
				),
			},
			{
				description: "Legacy top-level transport for a detached driver run.",
			},
		),
	),

	// ── Phase C: management actions ───────────────────────────────────
	// Distinct dispatch path: `delegate({action: ...})` reads/writes the
	// agent + chain definition files on disk. No worker session is
	// created. Management actions are mutually exclusive with the
	// run shapes above; supplying both is rejected at runtime.
	action: Type.Optional(
		StringEnum(["list", "get", "create", "update", "delete", "canonicalize", "health"] as const, {
			description:
				"Manage agent/chain files; `health` reports runtime state. When set, run shapes are ignored.",
		}) as any,
	),
	config: Type.Optional(
		Type.Composite([ManagementConfigSchema], {
			// The accepted fields are already declared structurally by
			// ManagementConfigSchema below; re-listing them in prose duplicated
			// ~900 chars of schema for no added information.
			description:
				"Closed `create`/`update` payload; lists are JSON/YAML arrays, env values are strings or null, `false` clears supported optionals, and unknown fields are rejected.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Single one-turn worker with `task`; mutually exclusive with `agents`, `tasks`, and `chain`.",
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Worker task; in chain mode, the original task supplied to every step.",
		}),
	),
	retryOf: Type.Optional(RetryOfSchema),
	checklist: Type.Optional(SlotChecklistSchema),

	// ── Direct-mode per-call fields (single-direct only) ──────────────
	cwd: Type.Optional(
		Type.String({
			description:
				"Worker cwd; in chain mode, the base for steps without `cwd`. Absolute or main-cwd-relative.",
		}),
	),
	artifact: Type.Optional(
		Type.Union([Type.String(), Type.Literal(false)], {
			description:
				"Name one file the worker must write as its deliverable; the runtime resolves it to the worker's artifact workspace and tells the worker the exact absolute path to write. `false` suppresses an agent default.",
		}),
	),
	reads: Type.Optional(
		Type.Union([Type.Array(Type.String()), Type.Literal(false)], {
			description: "Context files.",
		}),
	),
	progress: Type.Optional(
		Type.Boolean({
			description:
				"Append a 'done' line to `{chainDir}/progress.md` when complete.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Worker model override: provider/id or bare id.",
		}),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
	thinking: Type.Optional(InvocationThinkingOverrideSchema),
	thinkingMin: Type.Optional(InvocationThinkingOverrideSchema),
	thinkingMax: Type.Optional(InvocationThinkingOverrideSchema),
	fallbackModels: Type.Optional(InvocationFallbackModelsSchema),
	...SlotDepthField,
	skill: Type.Optional(InvocationSkillOverrideSchema),
	skills: Type.Optional(InvocationSkillOverrideSchema),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Route worker UI prompts to the overlay; otherwise prompts auto-deny.",
		}),
	),
	...WriteConfinementRootFields,
	// Single-direct invocation capability. Other shapes must carry this field
	// on each slot so mixed invocations can resolve policies independently.
	...EscalationRootField,
	...RemovedPlaneConfigFields,

	// ── Chain-mode dir override ───────────────────────────────────────
	chainDir: Type.Optional(
		Type.String({
			description:
				"Chain directory override; useful for resuming progress records.",
		}),
	),

	// ── Common (apply across modes where meaningful) ──────────────────
	concurrency: Type.Optional(
		Type.Number({
			description: `Maximum concurrent runs; default ${DEFAULT_CONCURRENCY}.`,
		}),
	),
	agent_scope: Type.Optional(AgentScopeSchema),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Fresh git worktree per delegate entry in the OS tmpdir; requires a clean tree and conflicts with per-entry `cwd`.",
		}),
	),
	await: Type.Optional(
		Type.Boolean({
			description:
				"Defaults to background dispatch (`runId` then a wake); use true only when the result gates the next action.",
		}),
	),
	notifyOnFailure: Type.Optional(
		Type.Boolean({
			description:
				"Early `delegate:fork-failed` wake for terminal background failures; aggregate completion fires regardless.",
		}),
	),
	sync: Type.Optional(
		Type.Boolean({
			description:
				"Deprecated alias for `await`.",
		}),
	),
}, {
	additionalProperties: true,
	// The flat-object rationale (provider array-stringifying) is documented in
	// the block comment above; callers do not need it, so it stays out of the
	// serialized description.
	description: "Choose one delegate run shape.",
});

type LegacyDelegateParams = typeof LegacyDelegateParams extends infer T ? T : never;
/** Provider schema retains permanent legacy selectors alongside canonical runs. */
export const DelegateParams = CanonicalDelegateParams;

/** Static model-facing surface registered for the delegate tool. */
const DELEGATE_TOOL_PROMPT = {
	name: "delegate",
	label: "Delegate",
	description: [
		"Delegate specialist work through canonical `runs[]`: one `delegate` call is one dispatch, and each entry is one run with its delegated worker.",
		"`solo` is direct; only `supervised` forks a copied main-agent thread to supervise a worker; `driver` is a durable pi-daemon session whose detached lifecycle survives caller exit. A `chain` is saved direct steps. Unknown or mixed shapes stay neutral.",
		"Solo and supervised runs parallelize unless `after` orders them; their worker conversation stays out of the main thread and each run collapses to one result. Their background dispatch auto-wakes; a driver returns after acceptance and is resumed with delegate_control.",
	].join(" "),
	promptSnippet: "Delegate work to specialist subagents; results collapse to one entry per run",
	promptGuidelines: [
		"Prefer `delegate` to `subagent` for open-ended or iterative work.",
		"Use `rounds`, `clone_mode` and `collapse_mode` only with `mode: 'supervised'`; solo rejects `rounds` and ignores the other two. Steering targets the supervisor `fork` in `mode: 'supervised'`, or an authenticated detached driver; direct workers, chain steps, and unknown in-process shapes reject steering. `clone_mode: 'task_only'` or `'snippet'` limits copied main context.",
		"BACKGROUND AUTO-WAKE: solo and supervised background dispatches return immediately and wake you with full output when every run finishes. A driver returns after durable acceptance; use delegate_control prompt_status and result to resume it. Do NOT poll, sleep, or busy-wait; use `await:true` only for a required dependency.",
		"TASK SEED: `handoff: {tasks}` reaches the worker before its first turn as a durable list when claimed, otherwise once as a prompt checklist; a driver seeds only its detached child, never the current main session.",
		"STRUCTURED ESCALATION: strictly opt-in, independently per slot. Only effective `mode: 'local'` (set by `escalation: 'local'`) enables a slot and its decision, blocker, or amendment raise tools. Use it for bounded decisions beyond worker authority, blockage, or task/plan/spec amendments. Escalation-enabled slots must run in the background: `await:true` and `sync:true` are rejected.",
	],
	parameters: DelegateParams,
} as const;
export const DELEGATE_PROMPT_GUIDELINES = DELEGATE_TOOL_PROMPT.promptGuidelines;

/** Re-exported for compatibility with existing callers and tests. */
export { resolveChildCwd };

/**
 * Phase 3a.1 fallback ladder: steer → sendUserMessage(followUp) → queue.
 *
 * Exported for direct unit testing. The real flow in `execute()` wires
 * this per-entry with the live clone session; this function captures the
 * algorithm in isolation.
 *
 * Rungs:
 *   1. When the clone session is streaming, try `cloneSession.steer(text)`.
 *      On a synchronous throw (e.g. `/`-prefixed extension command), fall
 *      through to rung 2.
 *   2. Try `cloneSession.sendUserMessage(text, { deliverAs: "followUp" })`.
 *      This works whether or not the session is streaming: when not
 *      streaming it just starts a new turn. Throws land on rung 3.
 *   3. Push onto `RunLiveState.pendingGuidance[]` for the worker to pick
 *      up on its next `message_subagent` call, and return `"queued"`.
 *
 * `deliverAs === "queue"` skips straight to rung 3. When the clone session
 * isn't available at all we also jump to rung 3 — that happens if the
 * entry hasn't booted yet or has already torn down.
 */
export interface SteerFallbackArgs {
	runId: string;
	forkName: string;
	text: string;
	deliverAs?: "steer" | "followUp" | "queue";
	cloneSession?: {
		isStreaming: boolean;
		steer(text: string): Promise<void>;
		sendUserMessage(
			text: string,
			opts?: { deliverAs?: "steer" | "followUp" },
		): Promise<void>;
	};
	/** Override the runtime's `pushPendingGuidance` (tests supply a spy). */
	pushGuidance?: (runId: string, forkName: string, text: string) => void;
}

export async function steerForkFallbackLadder(
	args: SteerFallbackArgs,
): Promise<{ delivered: SteerDelivery; error?: string }> {
	const pushGuidance = args.pushGuidance ?? pushPendingGuidance;
	if (args.deliverAs === "queue") {
		pushGuidance(args.runId, args.forkName, args.text);
		return { delivered: "queued" };
	}
	const clone = args.cloneSession;
	const errors: string[] = [];
	if (clone) {
		if (clone.isStreaming) {
			try {
				await clone.steer(args.text);
				return { delivered: "steer" };
			} catch (err) {
				errors.push(`steer: ${(err as Error)?.message ?? err}`);
			}
		}
		try {
			await clone.sendUserMessage(args.text, { deliverAs: "followUp" });
			return { delivered: "followUp" };
		} catch (err: any) {
			errors.push(`followUp: ${err?.message ?? err}`);
		}
	} else {
		errors.push("no live clone session");
	}
	pushGuidance(args.runId, args.forkName, args.text);
	return { delivered: "queued", error: errors.join("; ") || undefined };
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const n = Math.max(1, Math.min(limit, items.length));
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = new Array(n).fill(null).map(async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

function resolveAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((a) => a.name === name);
}

/**
 * Map a `CancelReason` to the short human-readable string stamped on
 * `RunLiveState.error` (and surfaced on `RunResult.error`). Exported so
 * tests can pin the wording.
 */
export function reasonToErrorText(reason: CancelReason): string {
	switch (reason) {
		case "user":
			return "cancelled by user";
		case "timeout":
			return "cancelled: per-entry timeout";
		case "heartbeat":
			return "cancelled: heartbeat timeout";
		case "supervisor":
			return "cancelled by supervisor";
		case "shutdown":
			return "cancelled: session shutdown";
		case "never-constructed":
			return "aborted: worker was never constructed";
	}
}

function abortControllersWhenParentAborts(
	parent: AbortSignal,
	controllers: Record<string, AbortController>,
): void {
	const abortAll = () => {
		for (const controller of Object.values(controllers)) controller.abort();
	};
	if (parent.aborted) abortAll();
	else parent.addEventListener("abort", abortAll, { once: true });
}

/**
 * Render the combined text a batch of delegate entries collapses to. Used by both sync
 * mode (returned as the tool result) and dispatch mode (carried in the wake-
 * up custom_message when the batch completes).
 *
 * Single-entry: the entry's collapsed content, preceded by a compact
 *              `<fork-session>` block (worker session path + round/status
 *              info) so the main agent can reference or inspect the entry
 *              without hunting for the details payload.
 * Multi-entry: each entry as a level-2 markdown section with the same
 *              session block under the heading.
 * Worktree suffix (already formatted by the worktree helper) appended if set.
 */
function runResultBody(result: RunResult): string {
	const output = workerArtifactReceipt(result) ?? (result.collapsedContent
		? result.error && result.recoveredOutput
			? `error: ${result.error}\n\n${result.collapsedContent}`
			: result.collapsedContent
		: result.error
			? `error: ${result.error}`
			: "(no output)");
	const repairReport = renderPromptRepairReport(result.promptRepairs ?? []);
	return repairReport ? `${repairReport}\n\n${output}` : output;
}

export function buildCombinedContent(
	results: RunResult[],
	worktreeSuffix: string,
): string {
	let body: string;
	if (results.length === 1) {
		const r = results[0];
		const sessionBlock = renderForkSessionBlock(r);
		const text = runResultBody(r);
		body = sessionBlock ? `${sessionBlock}\n\n${text}` : text;
	} else {
		body = results
			.map((r) => {
				const header = `## ${renderRunEntryIdentity(r)} — ${r.status}`;
				const sessionBlock = renderForkSessionBlock(r);
				const text = runResultBody(r);
				return sessionBlock ? `${header}\n${sessionBlock}\n\n${text}` : `${header}\n\n${text}`;
			})
			.join("\n\n---\n\n");
	}
	return worktreeSuffix ? `${body}\n\n${worktreeSuffix}` : body;
}

/** Add the frozen timeout policy/deadline to completed supervised results. */
export function applyResolvedTimeoutMetadata(
	results: RunResult[],
	requests: readonly Pick<ForkRequest, "name" | "timeoutPolicy">[],
	deadlines: ReadonlyMap<string, number>,
): RunResult[] {
	for (const result of results) {
		const request = requests.find((item) => item.name === result.name);
		if (!request?.timeoutPolicy || request.timeoutPolicy.maxDurationMs <= 0) continue;
		result.timeout = {
			...request.timeoutPolicy,
			...(deadlines.has(result.name) ? { deadlineAtMs: deadlines.get(result.name) } : {}),
		};
	}
	return results;
}

/** Stamp wall-clock wind-down provenance onto the compatibility run-result payloads. */
export function applyWindDownSteered(
	results: RunResult[],
	steeredRunNames: ReadonlySet<string>,
): RunResult[] {
	if (steeredRunNames.size === 0) return results;
	for (const r of results) {
		if (steeredRunNames.has(r.name)) r.steered = true;
	}
	return results;
}

/**
 * Compact, agent-readable block describing a run entry's session identity.
 * Emitted as an HTML-ish `<fork-session>` wrapper so the content doesn't
 * collide with the collapsed Markdown but is still trivially grep-able by
 * the main agent (and by tests).
 *
 * Lines we surface:
 *   - `worker session:` absolute path to the worker session JSONL (file-backed)
 *   - `rounds:` rounds used / maxRounds (useful for "did the run entry hit the cap?")
 *   - `cwd:` working directory the worker ran in (worktree-aware)
 *   - `summary model:` only when the summary collapse path was used, including
 *     a hint if we had to fall back to the supervisor's raw `summary` field
 *   - `warning [kind]:` for every structured non-fatal fork warning
 *   - `error:` only on failure
 *
 * Supervisor sessions run with `SessionManager.inMemory()` so they have no
 * on-disk path — if you need supervisor messages, inspect
 * `details.forks[].transcript`.
 */
export function renderForkSessionBlock(r: RunResult): string {
	const lines: string[] = [];
	if (r.workerSessionFile) lines.push(`worker session: ${r.workerSessionFile}`);
	lines.push(`rounds: ${r.roundsUsed}/${r.maxRounds}`);
	if (r.workerCwd) lines.push(`cwd: ${r.workerCwd}`);
	if (r.summaryModelUsed) {
		const note = r.summaryFallbackReason ? ` (fell back: ${r.summaryFallbackReason})` : "";
		lines.push(`summary model: ${r.summaryModelUsed}${note}`);
	} else if (r.summaryFallbackReason) {
		lines.push(`summary: ${r.summaryFallbackReason}`);
	}
	if (r.recoveredOutput) {
		lines.push(r.status === "failed"
			? "recovered worker output: yes (run remains failed)"
			: `recovered worker output: yes (run status: ${r.status})`);
	}
	if (r.refusalModels?.length) lines.push(`refusal models: ${r.refusalModels.join(", ")}`);
	if (r.policyRefusals?.length) {
		for (const refusal of r.policyRefusals) lines.push(`policy refusal: ${refusal.boundary}/${refusal.toolName}: ${refusal.reason}`);
	}
	lines.push(...formatForkWarningLines(r.warnings));
	if (r.mutationReport?.status === "tracked") {
		lines.push(`mutation tracking: tracked (${r.mutationReport.changedPaths.map((p) => JSON.stringify(p)).join(", ") || "no changed paths"})`);
	} else if (r.mutationReport?.status === "not-tracked") {
		lines.push(`mutation tracking: not tracked (${r.mutationReport.reason})`);
	}
	if (r.errorKind) lines.push(`error kind: ${r.errorKind}`);
	if (r.error) lines.push(`error: ${r.error}`);
	if (lines.length === 0) return "";
	return ["<fork-session>", ...lines, "</fork-session>"].join("\n");
}

function diagnosticIdentityText(value: string): string {
	return truncateRecoveryText(
		sanitizeRecoveryText(value).replace(/\p{Cc}+/gu, " ").trim(),
		120,
	);
}

function boundedErrorMessage(err: unknown): string {
	const maybe = err as { name?: unknown; message?: unknown } | undefined;
	return truncateRecoveryText(
		sanitizeRecoveryText(typeof maybe?.message === "string" ? maybe.message : String(err))
			.replace(/\p{Cc}+/gu, " ")
			.trim(),
		500,
	);
}

function diagnosticErrorText(err: unknown): string {
	const maybe = err as { name?: unknown; message?: unknown } | undefined;
	const message = boundedErrorMessage(err);
	const name = typeof maybe?.name === "string" && maybe.name
		? diagnosticIdentityText(maybe.name)
		: undefined;
	return name ? `${name}: ${message}` : message;
}

function runResultStatusDiagnostic(results: RunResult[]): string {
	const counts = new Map<string, number>();
	for (const result of results) {
		counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${status}:${count}`)
		.join(",") || "none";
}


/** Terminalize slots admitted before infrastructure setup and retain one
 * independent result/history record per slot. The retry reservation is never
 * rolled back: setup failure belongs to the new attempt. */
function finalizePrelaunchFailures(
	run: DelegateDispatchState,
	error: string,
	fallbackCwd: string,
): RunResult[] {
	error = boundHistoryErrorMessage(error);
	const finishedAt = new Date().toISOString();
	const finishedMs = Date.now();
	const results = Object.values(run.forks).map((fork): RunResult => {
		const result: RunResult = {
			name: fork.name,
			attempt: fork.attempt ?? 1,
			agent: fork.agent,
			agentSource: fork.agentSource ?? "builtin",
			task: fork.task ?? "",
			status: "failed",
			roundsUsed: fork.currentRound,
			maxRounds: fork.maxRounds,
			collapseMode: fork.collapseMode ?? "final_output",
			collapsedContent: "",
			workerCwd: fork.workerCwd ?? fallbackCwd,
			transcript: [],
			usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
			error,
		};
		fork.status = "failed";
		fork.error = error;
		fork.endedAt = finishedMs;
		fork.completedResult = result;
		try {
			recordRun(getAgentDir(), {
				ts: finishedAt,
				tsSec: Math.floor(finishedMs / 1000),
				runId: run.runId,
				rootRunId: run.rootRunId,
				ownerSessionId: run.ownerSessionId,
				forkName: fork.name,
				attempt: result.attempt,
				...(fork.retryOf ? { retryOf: fork.retryOf } : {}),
				errorMessage: result.error,
				agent: result.agent,
				agentSource: result.agentSource,
				cwd: result.workerCwd ?? fallbackCwd,
				status: "failed",
				roundsUsed: result.roundsUsed,
				maxRounds: result.maxRounds,
				collapseMode: result.collapseMode,
				supervisorFinishKind: null,
				startedAt: fork.startedAt ? new Date(fork.startedAt).toISOString() : finishedAt,
				finishedAt,
				durationMs: fork.startedAt ? Math.max(0, finishedMs - fork.startedAt) : 0,
				usage: { ...result.usage },
				taskPreview: result.task.slice(0, 200),
			});
		} catch {
			// History is best-effort, matching normal runner finalization.
		}
		return result;
	});
	return results;
}


function uniqueDiagnosticList(values: Array<string | undefined>): string {
	return [...new Set(values.filter((v): v is string => Boolean(v)))].sort().join(",") || "none";
}

export interface PumpRunsArgs {
	resolvedReqs: ForkRequest[];
	runId: string;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	worktreeSetup: WorktreeSetup | undefined;
	ctxCwd: string;
	mainBranchEntries: any[];
	mainModel: { provider: string; id: string } | undefined;
	mainSystemPrompt: string;
	authStorage: any;
	allowRegistryRuntimeFallback?: boolean;
	modelRegistry: any;
	scopedModelRefs?: ModelScope;
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly ToolDefinition[];
	/** Originator's resolved global escalation config for root-chain authority. */
	originatorEscalationConfig?: ResolvedEscalationConfig;
	signal?: AbortSignal;
	forkSignals?: Record<string, AbortSignal>;
	concurrency: number;
	fromToolCallId: string;
	/**
	 * Per-entry session refs (dispatch mode). Populated during the entry's
	 * lifetime so `DelegateDispatchState.cancel` / `.steer` can reach the live
	 * sessions. Keyed by entry name; created up front so the pump can
	 * install them on the ForkContext before `runFork` starts.
	 */
	sessionRefsByFork?: Record<string, ForkSessionRefs>;
	/** Optional hook to build the worker uiContext for each interactive fork. */
	buildWorkerUIContextForFork?: (forkName: string) => import("@earendil-works/pi-coding-agent").ExtensionUIContext | undefined;
	/**
	 * Phase 3a.2 — called when a round's `message_subagent` prepended
	 * pending guidance. The runtime layer uses it to push a synthetic
	 * transcript entry + emit `luthen.delegate.guidance_delivered`.
	 */
	onGuidanceDelivered?: (forkName: string, messages: string[]) => void;
	/**
	 * Per-entry streaming hook for sync mode. Called with the current snapshot
	 * of partial results whenever any entry's state changes. Left undefined in
	 * dispatch mode since the tool has already returned.
	 */
	onStreamUpdate?: (partialResults: RunResult[]) => void;
	/**
	 * Per-entry runtime-state patch hook for dispatch mode. Called with the
	 * subset of fields that changed this tick. Left undefined in sync mode
	 * (no runtime state registered).
	 */
	onForkRuntimeUpdate?: (forkName: string, patch: Partial<RunLiveState>) => void;
	/** Deterministic credential-retry seams used by integration tests. */
	credentialRetryClock?: WorkerChannelClock;
	credentialRetryRandom?: () => number;
	/** Called once when a fork first transitions to failed. Dispatch callers use this for an early wake. */
	onForkFailure?: (
		forkName: string,
		patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason },
	) => boolean | void;
	/**
	 * Per-entry incremental transcript hook for dispatch mode. Called once per
	 * `TranscriptEntry` produced by the supervisor or worker session. Fed by
	 * `fork-runner`'s real `subscribe` hooks through `messagesToTranscript`
	 * so semantics match the post-hoc `RunResult.transcript`.
	 */
	onForkTranscriptEntry?: (forkName: string, entry: TranscriptEntry) => void;
}

export interface PumpRunsResult {
	finalResults: RunResult[];
	worktreeDiffs: WorktreeDiff[];
	worktreeSuffix: string;
	combinedContent: string;
	anyFailed: boolean;
}

/**
 * Fan-out all runs in parallel, wait for completion, diff+clean worktrees,
 * and return the assembled combined content. Shared by sync and dispatch
 * code paths so there is exactly one place that knows how to pump runs.
 */
export async function pumpRuns(args: PumpRunsArgs): Promise<PumpRunsResult> {
	const partialResults: RunResult[] = args.resolvedReqs.map((r) => ({
		name: r.name,
		attempt: r.attempt ?? 1,
		agent: r.agent.name,
		agentSource: r.agent.source,
		task: r.task,
		status: "pending",
		roundsUsed: 0,
		maxRounds: r.maxRounds,
		collapseMode: r.collapseMode,
		collapsedContent: "",
		transcript: [],
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
	}));
	const notifyStream = () => args.onStreamUpdate?.([...partialResults]);

	let finalResults: RunResult[];
	let worktreeDiffs: WorktreeDiff[] = [];
	let worktreeSuffix = "";
	try {
		finalResults = await mapConcurrent(args.resolvedReqs, args.concurrency, async (req, idx) => {
			let failureReported = false;
			let infrastructureCallbackFailed = false;
			let infrastructureCallbackFailure: unknown;
			const reportFailure = (reason: RunFailureReason = "fork-failed") => {
				if (failureReported) return;
				if (!args.onForkFailure) {
					failureReported = true;
					return;
				}
				try {
					failureReported = args.onForkFailure(
						req.name,
						{ status: "failed", reason },
					) !== false;
				} catch {
					/* failure notification must never stop healthy siblings */
				}
			};
			const effectiveCwd = args.worktreeSetup
				? args.worktreeSetup.worktrees[idx]!.agentCwd
				: resolveChildCwd(args.ctxCwd, req.cwd);
			const sessionRefs = args.sessionRefsByFork?.[req.name];
			const workerUIContext = args.buildWorkerUIContextForFork?.(req.name);
			let result: RunResult;
			try {
				result = await runFork({
					...req,
					env: mergeEnvOverrides(req.env, args.worktreeSetup?.worktrees[idx]?.gitEnv),
				}, {
				cwd: effectiveCwd,
				mainBranchEntries: args.mainBranchEntries,
				fromToolCallId: args.fromToolCallId,
				mainModel: args.mainModel,
				mainSystemPrompt: args.mainSystemPrompt,
				authStorage: args.authStorage,
				allowRegistryRuntimeFallback: args.allowRegistryRuntimeFallback,
				modelRegistry: args.modelRegistry,
				scopedModelRefs: args.scopedModelRefs,
				agentDir: args.agentDir,
				ensureWorkerToolRegistration: args.ensureWorkerToolRegistration,
				getWorkerToolDefinitions: args.getWorkerToolDefinitions,
				ownerSessionId: args.ownerSessionId,
				originatorEscalationConfig: args.originatorEscalationConfig,
				signal: args.forkSignals?.[req.name] ?? args.signal,
				runId: args.runId,
				forkName: req.name,
				childIndex: idx,
				sessionRefs,
				workerUIContext,
				workerChannelClock: args.credentialRetryClock,
				credentialRetryRandom: args.credentialRetryRandom,
				getPendingGuidance: () => drainPendingGuidance(args.runId, req.name),
				getCancelReason: () => {
					const run = getRun(args.runId);
					return run?.forks[req.name]?.cancelReason;
				},
				onGuidanceDelivered: (messages) => {
					try {
						args.onGuidanceDelivered?.(req.name, messages);
					} catch {
						/* best effort */
					}
				},
				onUpdate: (u) => {
					const wasFailed = partialResults[idx]?.status === "failed";
					partialResults[idx] = {
						...partialResults[idx],
						status: u.status,
						roundsUsed: u.currentRound,
						workerSessionFile: u.workerSessionFile,
						workerCwd: effectiveCwd,
						error: u.error,
						errorKind: u.errorKind,
					};
					if (u.status === "failed" && !wasFailed && !infrastructureCallbackFailed) {
						reportFailure(runFailureReasonFor(u));
					}
					notifyStream();
				},
				onRuntimeUpdate: args.onForkRuntimeUpdate
					? (patch) => {
						try {
							args.onForkRuntimeUpdate!(req.name, projectRunLivePatch(patch, effectiveCwd));
						} catch (error) {
							infrastructureCallbackFailed = true;
							infrastructureCallbackFailure = error;
							throw error;
						}
					}
					: undefined,
				onTranscriptEntry: args.onForkTranscriptEntry
					? (entry) => {
						try {
							args.onForkTranscriptEntry!(req.name, entry);
						} catch (error) {
							infrastructureCallbackFailed = true;
							infrastructureCallbackFailure = error;
							throw error;
						}
					}
					: undefined,
			});
			} catch (error) {
				if (infrastructureCallbackFailed) throw infrastructureCallbackFailure;
				const errorText = error instanceof Error ? error.message : String(error);
				result = {
					...partialResults[idx]!,
					status: "failed",
					error: errorText,
					mutationReport: unavailableMutationReport("observation unavailable after entry setup failure"),
				};
				// Persist the terminal state before publishing the early wake. If this
				// infrastructure callback fails, propagate it without misreporting it as
				// another worker failure.
				args.onForkRuntimeUpdate?.(req.name, { status: "failed", error: errorText });
				reportFailure("fork-crashed");
			}
			if (infrastructureCallbackFailed) throw infrastructureCallbackFailure;
			if (result.status === "failed" && !failureReported) {
				reportFailure(runFailureReasonFor(result));
			}
			recordRunCompletedResult(args.runId, req.name, result);
			partialResults[idx] = result;
			notifyStream();
			return result;
		});
	} finally {
		if (args.worktreeSetup) {
			try {
				const diffsDir = createWorktreeDiffsDir(args.runId);
				worktreeDiffs = diffWorktrees(
					args.worktreeSetup,
					args.resolvedReqs.map((r) => r.agent.name),
					diffsDir,
				);
				worktreeSuffix = formatWorktreeDiffSummary(worktreeDiffs);
			} catch {
				/* swallow so cleanup can still run */
			}
			try {
				cleanupWorktrees(args.worktreeSetup);
			} catch {
				/* don't shadow the original error */
			}
		}
	}

	const anyFailed = finalResults.some((r) => r.status !== "completed");
	const combinedContent = buildCombinedContent(finalResults, worktreeSuffix);
	return { finalResults, worktreeDiffs, worktreeSuffix, combinedContent, anyFailed };
}

/** @deprecated Use {@link PumpRunsArgs}; retained for compatibility. */
export type PumpForksArgs = PumpRunsArgs;
/** @deprecated Use {@link PumpRunsResult}; retained for compatibility. */
export type PumpForksResult = PumpRunsResult;
/** @deprecated Use {@link pumpRuns}; retained for compatibility. */
export const pumpForks = pumpRuns;

/**
 * Plan C — inject a `custom_message` entry and trigger a new turn. Called
 * when a dispatched run completes (or errors out). The main agent will see
 * this as a user-role message and resume.
 *
 * Plan A (synthetic assistant toolCall + toolResult pair) is structurally
 * impossible for extensions — `ctx.sessionManager` is readonly, there is no
 * `appendMessage` on ExtensionAPI. If a future pi release exposes it, swap
 * this out for a synthetic tool-pair; until then custom-message is the only
 * game in town regardless of `completionNotifyStrategy`.
 *
 * The sink/input types + message builder live in `./pending-wakes.ts` (shared
 * with the issue-#2 redelivery legs); re-exported here for existing consumers.
 */
export type { NotifyCompletionInput, NotifyCompletionSink } from "./pending-wakes.js";

export function notifyCompletion(
	sink: NotifyCompletionSink,
	input: NotifyCompletionInput,
	opts?: { agentDir?: string; ownerSessionId?: string },
): void {
	// The guard/redelivery implementation lives in pending-wakes.ts so unit tests
	// can exercise the delivery discipline without importing the full extension
	// entrypoint. Keep this re-export wrapper for existing tests/consumers.
	notifyCompletionViaPendingWakes(sink, input, opts);
}

/**
 * Belt-and-suspenders containment for the detached dispatch completion tails
 * (!5 review follow-up). `notifyCompletion`'s guard deliberately rethrows
 * every NON-stale error so a real send failure is never silently masked — but
 * the six call sites all live in detached `.then`/`.catch` promise
 * continuations, where a rethrow becomes an unhandled rejection and KILLS the
 * parent process. This wrapper is the outermost containment: the error is
 * still surfaced (file-routed diagnostics, warn level — not masked), the
 * process survives, and the run's result is already persisted by
 * `completeRun` (which runs before the wake at every site), so the degraded
 * behavior is "wake dropped, result retrievable via delegate_result(runId)"
 * (and for the stale-ctx class specifically, issue #2's live-sink retry /
 * pending-wake redelivery inside notifyCompletion fires before containment
 * is ever reached).
 */
export function containDispatchTail(runId: string, label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logDelegateDiagnostic(
			`${diagnosticIdentityText(label)} completion tail failed (contained, parent survives; ` +
				`runId=${diagnosticIdentityText(runId)}, result persisted): ${diagnosticErrorText(err)}`,
			{ level: "warn" },
		);
	}
}

export interface SyncOrphanRecoveryMessage {
	customType: "delegate:sync-orphan-recovery";
	content: string;
	display: true;
	details: {
		runId: string;
		mode: "sync-orphan-recovery";
		recovered: true;
		partial: boolean;
		recovery: RecoveryProvenanceSummary;
		forks: RunResultDetails[];
		usage: ReturnType<typeof aggregateRunResults>;
		usageByFork: ReturnType<typeof summarizeRunUsages>;
		orphanedAt?: number;
	};
}

function formatRecoveryStatusCounts(recovery: RecoveryProvenanceSummary): string {
	return Object.entries(recovery.statusCounts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${count} ${status}`)
		.join(", ");
}

function formatRecoveryBanner(
	runId: string,
	recovery: RecoveryProvenanceSummary,
	opts: { sync?: boolean } = {},
): string {
	const kind = opts.sync ? "sync orphan" : "orphan";
	const mode = recovery.partial ? `PARTIAL recovered ${kind}` : `RECOVERED ${kind}`;
	const counts = formatRecoveryStatusCounts(recovery);
	const recoveredCount = `${recovery.recoveredForks} recovered`;
	const totalCount = `${recovery.totalForks} total`;
	return `[delegate ${mode} runId=${runId} — ${recoveredCount}, ${totalCount}${counts ? ` (${counts})` : ""}]`;
}

function buildSyncOrphanRecoveryMessage(run: DelegateDispatchState): SyncOrphanRecoveryMessage | undefined {
	if (!run.finalResult || run.finalResult.length === 0) return undefined;
	const recovery = summarizeRecoveryProvenance(run);
	if (!recovery) return undefined;
	const combinedContent = capDelegateOnlyResult(buildCombinedContent(run.finalResult, ""), run.runId, { claimAdvisory: false, runId: run.runId }).text;
	return {
		customType: "delegate:sync-orphan-recovery",
		content:
			`${formatRecoveryBanner(run.runId, recovery, { sync: true })}\n\n` +
			`[delegate sync runId=${run.runId} recovered after parent session restart]\n\n` +
			`The original foreground delegate(sync:true) tool call did not return before its parent runtime disappeared. ` +
			`Recovered durable run-entry output is below; the run remains available via delegate_control(action="result", runId).\n\n` +
			(combinedContent || "(no output)"),
		display: true,
		details: {
			runId: run.runId,
			mode: "sync-orphan-recovery",
			recovered: true,
			partial: recovery.partial,
			recovery,
			forks: projectRunResultsForDetails(run.finalResult),
			usage: aggregateRunResults(run.finalResult),
			usageByFork: summarizeRunUsages(run.finalResult),
			orphanedAt: run.orphanedAt,
		},
	};
}

function trustedRecoveryDeliverySessionId(
	sink: NotifyCompletionSink,
	claimedSessionId: string | undefined,
	agentDir: string | undefined,
): string | undefined {
	const trustedSink = getLiveWakeSink();
	const trustedSessionId = getLiveWakeSinkOwnerSessionId();
	if (trustedSink === sink && trustedSessionId !== undefined && trustedSessionId === claimedSessionId) {
		return trustedSessionId;
	}
	logDelegateDiagnostic(
		"recovery handoff skipped: caller does not match the registered live foreground session",
		{ agentDir, level: "warn" },
	);
	return undefined;
}

/**
 * GitLab #34 — foreground sync orphan handoff. Unlike normal dispatch
 * completion, this is NOT an async auto-wake; it is a recovery notice for a
 * blocking `delegate(sync:true)` call whose tool result was lost because the
 * parent session/runtime died after per-entry output had already been persisted.
 *
 * De-dupe is durable (`syncOrphanRecoverySurfacedAt`) and intentionally written
 * only AFTER `sendMessage`: this is at-least-once delivery. A crash in the tiny
 * send-before-mark window can duplicate a recovery notice on the next startup,
 * but marking first could permanently drop the only recovered foreground sync
 * result. Prefer duplicate recovery provenance over lost output.
 */
export function deliverSyncOrphanRecoveries(
	sink: NotifyCompletionSink,
	currentSessionId?: string,
	agentDir?: string,
): number {
	const trustedSessionId = trustedRecoveryDeliverySessionId(sink, currentSessionId, agentDir);
	if (!trustedSessionId) return 0;
	let delivered = 0;
	for (const run of listPendingSyncOrphanRecoveries(trustedSessionId)) {
		const observation = captureSyncOrphanRecoveryDelivery(run);
		if (!observation) {
			logDelegateDiagnostic(
				`sync orphan recovery observation rejected (runId=${run.runId})`,
				{ agentDir, level: "warn" },
			);
			continue;
		}
		const deliveredRun = observation.deliveredRun;
		const message = buildSyncOrphanRecoveryMessage(deliveredRun);
		if (!message) continue;
		try {
			deliverWakeMessage(sink, message);
			if (typeof sink.appendEntry === "function") {
				appendDelegateUsageMetadata(
					sink as ExtensionAPI,
					deliveredRun.runId,
					"sync-orphan-recovery",
					deliveredRun.finalResult ?? [],
				);
			}
			if (!markSyncOrphanRecoverySurfaced(observation, sink)) {
				throw new Error("durable recovery acknowledgement rejected");
			}
			delivered++;
		} catch (err) {
			logDelegateDiagnostic(
				`sync orphan recovery handoff failed (runId=${run.runId}): ${(err as Error)?.message ?? err}`,
				{ agentDir, level: "warn" },
			);
		}
	}
	if (delivered > 0) {
		logDelegateDiagnostic(`sync orphan recovery: surfaced ${delivered} recovered sync run(s)`, {
			agentDir,
			level: "log",
		});
	}
	return delivered;
}

const ORPHANED_DISPATCH_ERROR = "aborted: delegate runtime was reloaded or ended before completion";

/**
 * Hydrate-orphaned background dispatch handoff (#523). `markActiveRunAsOrphaned`
 * terminalizes a `sync:false` in-process run whose runtime died, but the
 * completion wake that dispatch promised was never produced, so the owning
 * session kept waiting for a result that could not arrive. Deliver the
 * standard `delegate:complete` wake once, with the sync handoff's
 * at-least-once discipline: the durable stamp is written after the send.
 */
export function deliverOrphanedDispatchWakes(
	sink: NotifyCompletionSink,
	currentSessionId?: string,
	agentDir?: string,
): number {
	const trustedSessionId = trustedRecoveryDeliverySessionId(sink, currentSessionId, agentDir);
	if (!trustedSessionId) return 0;
	let delivered = 0;
	for (const run of listPendingOrphanedDispatchWakes(trustedSessionId)) {
		const observation = captureOrphanedDispatchWakeDelivery(run);
		if (!observation) {
			logDelegateDiagnostic(
				`orphaned dispatch wake observation rejected (runId=${run.runId})`,
				{ agentDir, level: "warn" },
			);
			continue;
		}
		const deliveredRun = observation.deliveredRun;
		const finalResults = deliveredRun.finalResult ?? [];
		const input: NotifyCompletionInput = {
			runId: deliveredRun.runId,
			mode: deliveredRun.shape,
			finalResults,
			combinedContent: buildCombinedContent(finalResults, ""),
			error: ORPHANED_DISPATCH_ERROR,
		};
		try {
			deliverWakeMessage(sink, buildCompletionMessage(input));
			appendCompletionUsageMetadata(sink, input, agentDir);
			if (!markOrphanedDispatchWakeSurfaced(observation, sink)) {
				throw new Error("durable recovery acknowledgement rejected");
			}
			delivered++;
		} catch (err) {
			logDelegateDiagnostic(
				`orphaned dispatch wake failed (runId=${run.runId}): ${(err as Error)?.message ?? err}`,
				{ agentDir, level: "warn" },
			);
		}
	}
	if (delivered > 0) {
		logDelegateDiagnostic(`orphaned dispatch handoff: surfaced ${delivered} terminal wake(s)`, {
			agentDir,
			level: "log",
		});
	}
	return delivered;
}

function reconcileDeadDetachedOrchestrators(agentDir: string): void {
	const outcome = reconcileDeadOrchestrateRuns({ agentDir });
	if (outcome.terminalized > 0 || outcome.enqueued > 0) {
		logDelegateDiagnostic(
			`detached orphan reconciliation: terminalized=${outcome.terminalized} ` +
				`enqueued=${outcome.enqueued} cleaned=${outcome.cleaned}`,
			{ agentDir, level: "log" },
		);
	}
	if (outcome.degraded > 0) {
		logDelegateDiagnostic(
			`detached orphan reconciliation degraded for ${outcome.degraded} candidate(s); retrying on a later maintenance pass`,
			{ agentDir, level: "warn", throttleKey: "orchestrate-orphan-recovery" },
		);
	}
}

/**
 * Hydrate-and-deliver (spec 0005, node A / REQ-ORCH-6): on `session_start`,
 * scan the orchestrate pending-results dir for detached children that finished
 * while the foreground was GONE (reloaded / rotated / quit entirely), and
 * deliver each one's terminal result.
 *
 * Delivery reads the result FILE — there is NO captured in-process `pi` ctx, so
 * there is no stale-ctx crash surface (REQ-ORCH-6). Each delivered result is
 * consumed (its pending file removed) so a given result is delivered exactly
 * once across session starts. Best-effort: a send/format failure for one
 * result does not block the others; an unconsumed file is simply retried next
 * start.
 *
 * OWNER SCOPING (#120): a result whose cfg records an `ownerSessionId` is
 * delivered only to that session while its owning foreground is still present.
 * The cfg also retains the dispatching process PID and nonce because terminal
 * finalization removes the status-only active marker before pending delivery.
 * A missing owner is legacy/unscoped and is still delivered; incomplete owner
 * evidence fails closed. A same-process replacement or demonstrably dead owner
 * may rescue the result so reload / rotate / quit does not strand it.
 *
 * The nonce pairs with the PID so a replacement process cannot mistake a reused
 * PID for the original owner. A genuinely foreign live PID is always skipped;
 * this delays adoption on PID reuse but cannot disclose another session's result.
 *
 * Returns the count delivered (for tests / diagnostics).
 */
export function deliverPendingOrchestrateResults(
	sink: NotifyCompletionSink,
	agentDir: string,
	opts?: { currentSessionId?: string },
): number {
	const pending = scanPendingResults(agentDir);
	let delivered = 0;
	for (const { file, runId, result } of pending) {
		if (!runId) continue;
		let owner = readOrchestrateCfgOwnerEvidence(agentDir, runId);
		if (owner.kind === "unowned") {
			// A legacy upgrade can remove the prompt-bearing cfg before the
			// non-secret active marker is reaped. Recover that owner identity rather
			// than treating a known-owned result as broadcast-safe.
			owner = readOrchestrateActiveMarkerOwner(agentDir, runId);
		}
		if (owner.kind === "unknown") {
			logDelegateDiagnostic(
				`pending driver result skipped: owner liveness evidence is unknown (runId=${runId})`,
				{ agentDir, level: "warn", throttleKey: `pending-orchestrate-owner-unknown:${runId}` },
			);
			continue;
		}
		if (owner.kind === "owned") {
			const exactOwner = owner.ownerSessionId === opts?.currentSessionId;
			if (!exactOwner && (owner.ownerPid === undefined || owner.ownerNonce === undefined)) {
				// Partial legacy identity is enough for the exact owner, but never
				// authorizes a sibling or an unknown foreground to adopt the result.
				logDelegateDiagnostic(
					`pending driver result skipped: legacy owner evidence lacks rescue proof ` +
						`session=${owner.ownerSessionId} current=${opts?.currentSessionId ?? "(none)"} (runId=${runId})`,
					{ agentDir, level: "warn", throttleKey: `pending-orchestrate-legacy-owner:${runId}` },
				);
				continue;
			}
			if (!exactOwner) {
				const ours = owner.ownerPid === process.pid && owner.ownerNonce === getProcessNonce();
				const ownerAlive = pidAlive(owner.ownerPid);
				if (!ours && ownerAlive) {
					logDelegateDiagnostic(
						`pending driver result skipped: foreign live owner session=${owner.ownerSessionId} ` +
							`pid=${owner.ownerPid} current=${opts?.currentSessionId ?? "(none)"} (runId=${runId})`,
						{ agentDir, level: "log", throttleKey: `pending-orchestrate-foreign-live:${runId}` },
					);
					continue;
				}
				if (ours) {
					const marker = readOrchestrateActiveMarkerProcessState(agentDir, owner.ownerSessionId, runId);
					if (marker.kind === "unknown" ||
						(marker.kind === "present" && marker.ownerPid !== owner.ownerPid)) {
						logDelegateDiagnostic(
							`pending driver result skipped: owner/runner marker identity is unknown or conflicting (runId=${runId})`,
							{ agentDir, level: "warn", throttleKey: `pending-orchestrate-marker-unknown:${runId}` },
						);
						continue;
					}
					if (marker.kind === "present" && pidAlive(marker.runnerPid)) {
						logDelegateDiagnostic(
							`pending driver result skipped: detached runner finalization is still active ` +
								`pid=${marker.runnerPid} current=${opts?.currentSessionId ?? "(none)"} (runId=${runId})`,
							{ agentDir, level: "log", throttleKey: `pending-orchestrate-foreign-live:${runId}` },
						);
						continue;
					}
				}
				logDelegateDiagnostic(
					`pending driver result adopted by ${ours ? "same-process replacement" : "stale owner rescue"} ` +
						`session=${owner.ownerSessionId} current=${opts?.currentSessionId ?? "(none)"} (runId=${runId})`,
					{ agentDir, level: "warn", throttleKey: `pending-orchestrate-rescue:${runId}` },
				);
			}
		}
		// HARDENING (MR !2 review finding #6): atomically CLAIM the pending file
		// BEFORE sending, so two sessions scanning the same agentDir can't both
		// deliver the same result. Losing the claim race = another session owns
		// delivery; skip silently. A send failure releases the claim (retry next
		// start); a crashed claimant is recovered by the stale-claim sweep in
		// scanPendingResults. Net semantics: at-least-once, duplicates bounded to
		// a crash inside the claim window — never silent loss.
		const claimed = claimPendingResult(file);
		if (!claimed) continue;
		try {
			const header = result.status === "done"
				? `[delegate driver runId=${runId} completed]`
				: `[delegate driver runId=${runId} failed]`;
			const body = result.status === "done"
				? result.output || "(no output)"
				: `Failure details are available through delegate_control(action="result", runId="${runId}").`;
			const usage = result.usage ? delegateUsageFromAggregate(result.usage) : undefined;
			deliverWakeMessage(
				sink,
				{
					customType: "delegate:complete",
					content: `${header}\n\n${body}`,
					display: true,
					details: {
						runId,
						mode: "driver",
						status: result.status,
						...(usage ? { usage } : {}),
						...(result.taskLedger ? { taskLedger: result.taskLedger } : {}),
					},
				},
			);
			if (consumePendingResult(claimed)) {
				deleteOrchestrateOwnerEvidence(agentDir, runId);
			} else {
				logDelegateDiagnostic(
					`pending driver result sent but claim removal is unconfirmed; retaining owner evidence (runId=${runId})`,
					{ agentDir, level: "warn", throttleKey: `pending-orchestrate-consume-unconfirmed:${runId}` },
				);
			}
			// Detached orchestrate has no in-process completeRun hook. Its consumed
			// terminal result is the root-run terminal boundary for invariant 6.
			cleanupEscalationsForRun({
				agentDir,
				rootRunId: runId,
				reason: "Escalation cancelled because the detached root run terminated.",
			});
			// Spec 0009, REQ-CTRL-8: DELETE the run's route record on the terminal
			// transition (here, on result delivery / reaping) so the control SECRET
			// does not outlive the run. Primary lifecycle; the startup sweep is only
			// the crashed-peer backstop. Best-effort (idempotent on an absent file).
			// [decision: route-record-delete-on-terminal-plus-sweep]
			finalizeTerminalOrchestrateRoute({ agentDir, runId, terminalKnown: true });
			// The pending envelope does not carry authoritative owner identity; cfg
			// remains the bounded owner source when an earlier cleanup already removed
			// the route before delivery gets here.
			deleteOrchestrateActiveMarkerForRun(agentDir, runId);
			delivered++;
		} catch (err) {
			// Release the claim so the result is retried next session start rather
			// than stranded in a .delivered file (finding #6: never trade the
			// duplicate-delivery race for result LOSS).
			unclaimPendingResult(claimed);
			// Spec 0018: route this swallow through the shared diagnostics logger
			// instead of a raw console.warn (no TUI spill). This file-read path runs
			// on session_start with a FRESH/active ctx — it has no stale-ctx surface
			// (REQ-ORCH-6 comment above) — so unlike notifyCompletion it intentionally
			// stays swallow-ALL: a single result's delivery failure must NOT block the
			// others, and an unconsumed file is simply retried next start.
			logDelegateDiagnostic(
				`failed to deliver pending driver result ${file}: ` +
					`${(err as Error)?.message ?? err}`,
				{ agentDir, level: "warn" },
			);
		}
	}
	if (delivered > 0) {
		logDelegateDiagnostic(
			`hydrate-and-deliver: delivered ${delivered} pending driver result(s)`,
			{ agentDir, level: "log" },
		);
	}
	return delivered;
}

/**
 * Poster-side terminality FAST PATH (spec 0009, REQ-CTRL-7 — optimization
 * ONLY, NOT the authority). Before `routeDetachedControl` posts a steer/cancel
 * to a detached run + awaits its result for 5s, consult the 0008 read resolver
 * (`resolveRunStatus`, which also applies dead-pid staleness reconciliation): a
 * run that is already terminal / dead-pid is reported as such, so the tool can
 * return 'already terminal' within one poll interval WITHOUT a pointless post +
 * 5s await.
 *
 * This is DELIBERATELY not the correctness gate — the CHILD-SIDE final drain
 * (`drainControlRequestsAtTerminal` in orchestrate-runner) is the authority
 * (there is no shared lock; a poster-side check is racy by construction). This
 * only avoids a wasted round trip on the common already-finished case.
 * Best-effort: any resolve failure returns `false` (fall through to the real
 * post, which the child-side drain then handles correctly).
 * [decision: terminality-authority-child-side-drain]
 */
export function detachedRunIsTerminal(agentDir: string, runId: string): boolean {
	return classifyDetachedRunForControl(agentDir, runId) === "terminal";
}

function appendDelegateUsageMetadata(
	pi: ExtensionAPI,
	runId: string,
	mode: string,
	results: RunResult[],
	agentDir?: string,
): DelegateUsageMetadata | undefined {
	const metadata = buildDelegateUsageMetadata(runId, results, mode);
	if (metadata.usage.totalTokens <= 0 && metadata.usage.cost <= 0 && metadata.usage.forks <= 0) {
		return undefined;
	}
	try {
		pi.appendEntry(metadata.customType, metadata);
	} catch (err) {
		logDelegateDiagnostic(
			`failed to append delegate usage metadata (runId=${runId}): ${(err as Error)?.message ?? err}`,
			{ agentDir, level: "warn" },
		);
	}
	return metadata;
}

type RunResultDetails = ProjectedRunResult;

function projectRunResultsForDetails(results: readonly RunResult[]): RunResultDetails[] {
	return projectRunResults(results, { includeDetailExtensions: true });
}

function usageDetails(results: RunResult[]) {
	return {
		usage: aggregateRunResults(results),
		usageByFork: summarizeRunUsages(results),
	};
}

/**
 * Tri-state poster-side classification behind `detachedRunIsTerminal`
 * (issue #11). `resolveRunStatus` returning `undefined` means NO in-memory
 * run, NO terminal record, NO bus events, and NO cfg file — and the cfg is
 * written BEFORE spawn, so a genuinely-live freshly-spawned child can never
 * read as `"not-found"`. A `"not-found"` run therefore has nothing listening
 * on its control inbox; steer/cancel can fail fast instead of posting + eating
 * the full 5s await. A resolver THROW (transient fs error) is deliberately
 * mapped to `"live"` — fall through to the real post, where the child-side
 * drain remains the authority. [decision: terminality-authority-child-side-drain]
 */
export function classifyDetachedRunForControl(
	agentDir: string,
	runId: string,
): "terminal" | "live" | "not-found" {
	try {
		const status = resolveRunStatus(agentDir, runId);
		if (!status) return "not-found";
		return status.state === "terminal-done" ||
			status.state === "terminal-failed" ||
			status.state === "terminal-steered" ||
			// Spec 0019 / REQ-PAUSE-4 — a forced-finish (max_rounds) run is
			// terminal-but-not-done. A detached/cross-process parent resolving
			// a paused run MUST take the 'already terminal' fast path for
			// steer/cancel; omitting it would re-post + 5s-await a parked run.
			status.state === "terminal-paused"
			? "terminal"
			: "live";
	} catch {
		return "live";
	}
}

/** Per-call orchestrate selector (the `orchestrate: {...}` shape entry). */
export interface OrchestrateInput {
	agent: string;
	/** Canonical name of the single driver entry. */
	name?: string;
	task: string;
	tasks?: TasksSeed;
	focus?: unknown;
	model?: string;
	env?: EnvOverrides;
	maxSubagentDepth?: number;
}

export interface ExecuteOrchestrateShapeArgs {
	pi: ExtensionAPI;
	input: OrchestrateInput;
	agent: AgentConfig;
	ctx: any;
	toolCallId: string;
	agentDir: string;
	/** Caller cancellation is authoritative while bounded credential warming runs. */
	signal?: AbortSignal;
	/** Test seam: override the compiled-runner path the child is spawned with. */
	runnerOverride?: string;
	/** Internal production selector: host this driver in pi-daemon instead of a terminal runner. */
	daemon?: true;
	/** Deterministic test seam for the otherwise fixed 20 s whole-preflight deadline. */
	warmupDeadlineMs?: number;
	/** Verified foreground owner supplied by a delegate-owned child session. */
	ownerSessionId?: string;
}

/**
 * The default depth cap for an orchestrate driver. Orchestrate needs headroom
 * for foreground(0)→orchestrate(1)→worker(2)→reviewer(3), so a fresh
 * orchestrate root seeds a cap of at least this. The frame's `effectiveMax`
 * carries it across the process boundary. Explicit requests may raise the
 * conservative minimum up to the shared global hard ceiling.
 */
export const ORCHESTRATE_MIN_DEPTH = 3;

/**
 * Build the child's lineage frame for a detached orchestrate dispatch.
 *
 * - In-process parent frame present (a nested orchestrate, depth ≥ 1) → the
 *   child sits one level deeper, inheriting the parent's `rootRunId`; the
 *   parent/requested cap is narrowed, then re-rooted to at least
 *   `ORCHESTRATE_MIN_DEPTH` so the detached pipeline can function.
 * - No parent frame (foreground at depth 0) → the child is a fresh orchestrate
 *   root: depth 1, `rootRunId === runId`, cap = max(requested, ORCHESTRATE_MIN_DEPTH).
 *
 * Exported pure for unit testing the frame math without spawning.
 */
export function buildOrchestrateChildFrame(args: {
	runId: string;
	agentName: string;
	maxSubagentDepth?: number;
	parent?: DepthFrame;
}): DepthFrame {
	const { runId, agentName, maxSubagentDepth, parent } = args;
	const delegateOnlyDefault = resolveDelegateOnlyDepth(undefined);
	if (
		delegateOnlyDefault !== undefined &&
		maxSubagentDepth === undefined &&
		delegateOnlyDefault < ORCHESTRATE_MIN_DEPTH
	) {
		throw new RangeError(
			`delegate-only driver requires nestingDepth >= ${ORCHESTRATE_MIN_DEPTH}; configured nestingDepth=${delegateOnlyDefault} conflicts with the driver pipeline minimum`,
		);
	}
	if (parent) {
		const depth = parent.depth + 1;
		// An orchestrate root is a deliberate re-root boundary: it must retain
		// enough headroom to drive its detached worker/reviewer pipeline even
		// when a scheduled/nested caller inherited a low cap. Above that floor,
		// the parent's cap still narrows a higher request as usual.
		const parentMax = validateMaxSubagentDepth(parent.effectiveMax);
		const requested = validateMaxSubagentDepth(maxSubagentDepth ?? parentMax);
		const effectiveMax = Math.min(
			Math.max(
				Math.min(parentMax, requested),
				ORCHESTRATE_MIN_DEPTH,
			),
			HARD_MAX_DEPTH,
		);
		return {
			depth,
			chain: [...parent.chain, agentName],
			effectiveMax,
			runId,
			rootRunId: parent.rootRunId,
			childIndex: 0,
			capToken: parent.capToken,
		};
	}
	// Fresh orchestrate root: a foreground hand-off. Seed depth 1 with at least
	// the configured delegate-only cap, or the ordinary orchestrate minimum, so
	// the driver can reach worker→reviewer.
	const driverMinimum =
		maxSubagentDepth === undefined
			? Math.max(delegateOnlyDefault ?? ORCHESTRATE_MIN_DEPTH, ORCHESTRATE_MIN_DEPTH)
			: ORCHESTRATE_MIN_DEPTH;
	const requested = validateMaxSubagentDepth(maxSubagentDepth ?? delegateOnlyDefault ?? ORCHESTRATE_MIN_DEPTH);
	const effectiveMax = Math.min(
		Math.max(requested, driverMinimum),
		HARD_MAX_DEPTH,
	);
	return {
		depth: 1,
		chain: [agentName],
		effectiveMax,
		runId,
		rootRunId: runId,
		childIndex: 0,
		capToken: "",
	};
}

/**
 * Execute the `orchestrate` shape (spec 0005, node B): seed a clone-of-self,
 * resolve the FULL inherited tool surface INCLUDING `delegate`, inject the
 * cross-process derived-key lineage env, and spawn a DETACHED child process
 * that drives the hosted agent's pipeline to terminal. After bounded parent
 * credential warming, returns a `dispatched` envelope immediately (REQ-ORCH-1)
 * — the foreground ends its turn and is auto-woken once when the child writes
 * its result (notifyCompletion /
 * hydrate-and-deliver), never by polling.
 *
 * GENERALITY (REQ-ORCH-7): this shape hosts ANY agent + its inherited
 * extensions/skills. It does NOT import or hardcode graft — graft-fit is
 * achieved entirely by the agent def (graft-orchestrator: inheritProjectContext
 * / inheritSkills / full tools) + the inherited ext/skills loaded in the child.
 *
 * Clone-of-self note: the detached child's cfg (node A's `OrchestrateCfg`)
 * carries identity + context via `inheritProjectContext` + `inheritSkills` +
 * the parent system prompt — the `full`-mode equivalent for a fresh-process
 * boot. It does NOT replay the parent's in-memory message history (the cfg has
 * no message-history field and the child boots a fresh session); the orchestrate
 * default is `full`-as-identity-context, asymmetric from leaf workers which run
 * `task_only`. [Graft-Deviation: full-mode clone realized as cfg context
 * inheritance, not message replay, given the detached fresh-process boot.]
 */
export async function executeOrchestrateShape(args: ExecuteOrchestrateShapeArgs): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}> {
	const { pi, input, agent, ctx, toolCallId, agentDir } = args;
	const runId = deriveRunId(toolCallId);

	// Build the child's lineage frame (cross-process cap inheritance, REQ-ORCH-5).
	const parentFrame = currentLineageFrame() ?? deserializeLineage(process.env);
	let childFrame: DepthFrame;
	try {
		childFrame = buildOrchestrateChildFrame({
			runId,
			agentName: agent.name,
			maxSubagentDepth: input.maxSubagentDepth ?? agent.maxSubagentDepth,
			parent: parentFrame,
		});
	} catch (err) {
		return {
			content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
			details: { forks: [], runId, mode: "driver" },
			isError: true,
		};
	}
	if (childFrame.depth > childFrame.effectiveMax) {
		const err = new DepthGuardError(childFrame.depth, childFrame.effectiveMax, childFrame.chain);
		try {
			recordPreflightFailure(agentDir, {
				runId,
				rootRunId: childFrame.rootRunId,
				forkName: agent.name,
				agent: agent.name,
				agentSource: agent.source,
				cwd: ctx.cwd,
				maxRounds: 1,
				collapseMode: "final_output",
				task: input.task,
				errorMessage: err.message,
			});
		} catch (recordingError) {
			if (!(recordingError instanceof StateLockTimeoutError)) throw recordingError;
		}
		return {
			content: [{ type: "text", text: err.message }],
			details: { forks: [], runId, mode: "driver" },
			isError: true,
		};
	}

	// Resolve the FULL orchestrate tool surface (built-ins + delegate), spec 0001.
	const surface = resolveRunToolSurface(agent, "orchestrate");
	// Issue #10 — surface resolution diagnostics (typo'd tool names, malformed
	// ext: selectors) were collected but dropped at this call site; a `bahs`
	// in an agent's tools: line silently vanished from the surface.
	for (const d of surface.diagnostics) logDelegateDiagnostic(d, { agentDir, throttleKey: "tool-surface" });
	try {
		assertValidExtensionToolSelectors(surface);
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			details: { forks: [], runId, mode: "driver" },
			isError: true,
		};
	}

	// Identity + context for the clone-of-self (full mode): the parent system
	// prompt + the agent's own body, with project context + skills inherited so
	// the hosted agent's extension surface (e.g. graft's tools) loads in the
	// child. The child boots a fresh session seeded with this identity.
	const mainSystemPrompt =
		typeof ctx?.getSystemPrompt === "function" ? (ctx.getSystemPrompt() ?? "") : "";
	const composedSystemPrompt = agent.systemPrompt
		? agent.systemPrompt
		: mainSystemPrompt;
	// Persist the non-secret owner id in the cfg as well as the secret-bearing
	// route record. The runner deletes the route at terminal, but issue #53's
	// owner-scoped status/overlay must still retain the terminal row.
	const ownerSessionId = args.ownerSessionId ?? resolveOwnerSessionId(
		ctx?.sessionManager?.getSessionId?.bind(ctx.sessionManager),
	);
	const lineageEnv = serializeLineageDetached(childFrame);
	const transportEnv = mergeEnvOverrides(agent.env, input.env);
	const scopedModelRefs = modelScopeFromExtensionContext(ctx, getAgentDir());
	let childModel = input.model ?? agent.model;
	if (ctx.modelRegistry && (childModel || ctx.model || scopedModelRefs)) {
		const mainModel = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id }
			: undefined;
		const routedRequest = {
			agent: { ...agent, model: childModel },
		};
		const plannedModels = planWorkerModelRequests(
			ctx.modelRegistry,
			[routedRequest],
			{ mainModel, scope: scopedModelRefs },
		);
		if (plannedModels.kind === "failure") {
			return {
				content: [{
					type: "text",
					text: plannedModels.failure.message,
				}],
				details: { forks: [], runId, mode: "driver" },
				isError: true,
			};
		}
		childModel = plannedModels.requests[0]!.modelPlan.primary.canonicalRef;
		await warmPlannedProviderAuth({
			requests: plannedModels.requests,
			modelRegistry: ctx.modelRegistry,
			signal: args.signal,
			...(args.warmupDeadlineMs !== undefined ? { deadlineMs: args.warmupDeadlineMs } : {}),
			onDiagnostic: (message) => logDelegateDiagnostic(message, {
				agentDir,
				level: "warn",
			}),
		});
	}

	const optionalGlobalExtensionSelectorKeys = getOptionalGlobalExtensionSelectorKeys(surface);
	const cfg: OrchestrateCfg = {
		mode: "driver",
		runId,
		rootRunId: childFrame.rootRunId,
		cwd: ctx.cwd,
		agentDir,
		restartLineageEnv: lineageEnv,
		restartBlockedByTransportEnv: Boolean(
			transportEnv && Object.keys(transportEnv).length > 0,
		),
		ownerSessionId,
		...(ownerSessionId
			? {
					ownerPid: process.pid,
					ownerNonce: getProcessNonce(),
				}
			: {}),
		task: input.task,
		...(input.tasks ? { tasks: input.tasks } : {}),
		agentName: agent.name,
		entryName: input.name ?? agent.name,
		...(childModel ? { model: childModel } : {}),
		env: transportEnv,
		...(agent.thinking ? { thinking: agent.thinking } : {}),
		...(agent.thinkingMin ? { thinkingMin: agent.thinkingMin } : {}),
		...(agent.thinkingMax ? { thinkingMax: agent.thinkingMax } : {}),
		systemPrompt: composedSystemPrompt,
		systemPromptMode: agent.systemPromptMode ?? "append",
		inheritProjectContext: agent.inheritProjectContext ?? true,
		inheritSkills: agent.inheritSkills ?? true,
		...(agent.skills ? { skills: agent.skills } : {}),
		...(agent.extensions ? { extensions: agent.extensions } : {}),
		...(agent.extensionInclude ? { extensionInclude: agent.extensionInclude } : {}),
		...(agent.extensionExclude ? { extensionExclude: agent.extensionExclude } : {}),
		...(surface.tools ? { tools: surface.tools } : {}),
		hasExplicitAllowlist: surface.hasExplicitAllowlist,
		...(surface.extSelectors.length ? { extensionToolSelectors: surface.extSelectors } : {}),
		...(optionalGlobalExtensionSelectorKeys.length
			? { optionalGlobalExtensionSelectorKeys: [...optionalGlobalExtensionSelectorKeys] }
			: {}),
		resultFile: resolveResultFile(agentDir, runId),
		pendingFile: resolvePendingFile(agentDir, runId),
	};

	// Mint the per-run CONTROL SECRET (spec 0009, node A). This is a SHARED
	// symmetric capability — distinct from the spec-0005 Ed25519 / rootSecret
	// forge-resistance model, which stays UNTOUCHED. It travels to the child
	// via the spawn ENV only (never the prompt-bearing 0600 cfg / any log) and
	// persists foreground-side ONLY in a 0600 route record (written after the
	// spawn, once the pid is known). [decision: control-secret-not-captoken]
	if (args.daemon === true) {
		return launchDaemonDriver(cfg).then(
			(launched) => ({
				content: [{
					type: "text" as const,
					text:
						`Dispatched driver runId=${runId} (agent=${agent.name}) through pi-daemon. ` +
						"The prompt is durably accepted and continues without this client; use delegate_control for status, result, and control.",
				}],
				details: {
					dispatched: true,
					accepted: launched.accepted,
					disposition: launched.disposition,
					runId,
					mode: "driver",
					agent: agent.name,
					depth: childFrame.depth,
					effectiveMax: childFrame.effectiveMax,
					daemonSessionId: launched.locator.daemonSessionId,
					promptId: launched.locator.promptId,
					controlAvailable: true,
				},
			}),
			(error: unknown) => ({
				content: [{
					type: "text" as const,
					text: `delegate driver: pi-daemon launch failed: ${isDaemonRequestError(error)
						? `${error.code}: ${error.message}${error.details === undefined ? "" : ` (${JSON.stringify(error.details)})`}`
						: error instanceof Error ? error.message : String(error)}`,
				}],
				details: { forks: [], runId, mode: "driver" },
				isError: true,
			}),
		);
	}

	const controlSecret = mintControlSecret();

	// Inject the cross-process signed lineage env (Ed25519 signature +
	// public key) so the detached child recovers its TRUE inherited cap
	// (REQ-ORCH-5), AND the control secret (spec 0009) so the child can
	// authenticate later-turn control requests. `spawnDetachedOrchestrate`
	// captures `process.env` at spawn time, so we set the serialized vars on
	// process.env immediately before the (synchronous) spawn and restore them
	// right after — the child inherits them; the parent env is left pristine.
	// /proc/<pid>/environ is 0400 owner-only, so the env is the safe transport
	// for the secret (REQ-CTRL-6). The CONTROL SECRET is deliberately NOT added
	// to `cfg` (written 0600, but still not a credential store) and NOT logged below.
	// [Graft-Deviation: the spawn helper hardcodes `env: process.env` and is OUT
	// of node B's touches; the set-spawn-restore seam keeps the env injection
	// inside `src/index.ts` scope without widening it.]
	const childEnv: Record<string, string> = { ...lineageEnv, [CONTROL_SECRET_ENV]: controlSecret };
	const savedEnv: Record<string, string | undefined> = {};
	for (const k of Object.keys(childEnv)) savedEnv[k] = process.env[k];
	let pid: number;
	try {
		for (const [k, v] of Object.entries(childEnv)) process.env[k] = v;
		const spawned = spawnDetachedOrchestrate(cfg, { runnerOverride: args.runnerOverride });
		pid = spawned.pid;
	} catch (err) {
		return {
			content: [
				{ type: "text", text: `delegate driver: failed to spawn detached child: ${(err as Error)?.message ?? err}` },
			],
			details: { forks: [], runId, mode: "driver" },
			isError: true,
		};
	} finally {
		for (const k of Object.keys(childEnv)) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	}

	// Persist the 0600 route record (foreground-side control credential) now
	// that the pid is known. Stamp it with the spawning session's id so node
	// B's resolver can refuse a sibling session's record (REQ-CTRL-5). If the
	// session id is unavailable, fall back to a stable per-foreground id derived
	// from the process pid (documented: this still scopes the record to THIS
	// foreground process, which is the security property node B needs).
	// Shared owner-id derivation (control-route.ts) — the READ side
	// (resolveRunControl caller, session_start) MUST use the SAME helper so a
	// pid-fallback record stays controllable by its minting process (REQ-CTRL-5).
	const runnerIdentity = captureProcessIdentity(pid);
	const routeRecord: RouteRecord = {
		runId,
		rootRunId: childFrame.rootRunId,
		lineagePath: lineagePath(childFrame),
		controlSecret,
		pid,
		...(runnerIdentity?.startTicks ? { runnerStartTicks: runnerIdentity.startTicks } : {}),
		...(runnerIdentity?.bootId ? { runnerBootId: runnerIdentity.bootId } : {}),
		ownerSessionId,
	};
	const routeWrite = writeRouteRecord(agentDir, routeRecord);

	// The dispatch diagnostic carries runId / pid / depth / cap ONLY — NEVER
	// the control secret (REQ-CTRL-6). A degraded-control state is logged as a
	// presence flag, not the credential. It goes to the diagnostics log rather
	// than straight to the console, so it cannot overwrite the pi TUI (#306).
	logDelegateDiagnostic(
		`driver dispatched runId=${runId} agent=${agent.name} pid=${pid} ` +
			`depth=${childFrame.depth} cap=${childFrame.effectiveMax}` +
			(routeWrite.ok ? "" : " control=degraded"),
		{ agentDir, level: "log" },
	);
	void pi; // pi is threaded for parity / future control wiring (node C).
	// Surface a DEGRADED-CONTROL warning when the route record could not be
	// persisted: the run still executes, but it is uncontrollable (a later-turn
	// steer/cancel has no credential to authenticate with). REQ-CTRL-3 — this is
	// a control credential, so the failure is surfaced, NOT silently swallowed.
	const degradedNote = routeWrite.ok
		? ""
		: ` WARNING: control credential could not be persisted (${routeWrite.error}); this run is RUNNING but UNCONTROLLABLE — delegate_control(action="steer"/"cancel") will be unavailable for it.`;
	const text =
		`Dispatched driver runId=${runId} (agent=${agent.name}, pid=${pid}) as a DETACHED child process. ` +
		"It drives the pipeline to completion and a new turn will be triggered automatically with the " +
		"collapsed summary when it finishes — do not poll or sleep. The child is immune to this session's " +
		"reload / rotate / compact / shutdown. Live state is visible in the delegate overlay and via " +
		"delegate_control(action=\"status\", runId); delegate health reports detached counts separately." +
		degradedNote;
	return {
		content: [{ type: "text", text }],
		details: {
			dispatched: true,
			runId,
			mode: "driver",
			agent: agent.name,
			pid,
			depth: childFrame.depth,
			effectiveMax: childFrame.effectiveMax,
			// Presence flag ONLY — never the secret itself (REQ-CTRL-6).
			controlAvailable: routeWrite.ok,
		},
	};
}

/**
 * Phase B: execute a chain shape end-to-end.
 *
 * Wires the chain executor (`src/chain-execution.ts`) into the runtime
 * registry / status widget / transcript overlay, the same way
 * `executeDirectShape` does for single/parallel direct.
 */
export interface ExecuteChainShapeArgs {
	pi: ExtensionAPI;
	steps: ChainStep[];
	/** Discovery snapshot from the delegate invocation; do not re-walk without its configured roots. */
	agents: AgentConfig[];
	discoveryWarnings?: string[];
	chainTask: string;
	scope: AgentScope;
	/** Absolute chain base cwd, resolved once against the invocation context. */
	chainCwd: string;
	chainDirOverride: string | undefined;
	sync: boolean;
	signal: AbortSignal | undefined;
	ctx: any;
	toolCallId: string;
	onUpdate: ((u: any) => void) | undefined;
	config: ReturnType<typeof loadConfig>;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	/** Trusted parent branch snapshot, passed only when a chain step has the grant. */
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly ToolDefinition[];
	/** Default-on per-entry failure wake; false preserves aggregate-only behavior. */
	notifyOnFailure?: boolean;
}

export async function executeChainShape(args: ExecuteChainShapeArgs): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: any;
	isError?: boolean;
}> {
	const { pi, ctx, signal } = args;
	const wakeSink = bindWakeSinkToCurrentContext(pi);
	const runId = deriveRunId(args.toolCallId);

	// Sweep stale chain dirs opportunistically (24h+).
	try {
		sweepOldChainDirs({});
	} catch {
		/* best-effort */
	}
	const chainDir = args.chainDirOverride ?? prepareChainDir({ runId });

	// Runtime state: chain runs register as a single runId. The compatibility
	// `forks` dictionary is populated incrementally as each step starts (via
	// chain-execution's onForkRuntimeUpdate hook). We pre-populate it
	// empty so `delegate_status` shows the run from the moment it
	// dispatches; entries get added as steps run.
	const dispatchAbort = new AbortController();
	// Only mirror the parent-turn signal into dispatchAbort in SYNC
	// mode. In dispatch the run must outlive the parent turn, so a
	// later parent abort (intercom incoming-message handler, retry,
	// recompaction interrupt, …) must not cascade into detached chain entries.
	// See `dispatch-signal.ts` for the rationale.
	wireSignalToDispatch(signal, dispatchAbort, { sync: args.sync });
	let chainCancelReason: CancelReason | undefined;
	const chainEntryAbortControllers = Object.create(null) as Record<string, AbortController>;
	const chainEntryCancelReasons = new Map<string, CancelReason>();
	const chainEntryAbortController = (forkName: string): AbortController => {
		const existing = chainEntryAbortControllers[forkName];
		if (existing) return existing;
		const controller = new AbortController();
		chainEntryAbortControllers[forkName] = controller;
		if (dispatchAbort.signal.aborted) controller.abort();
		return controller;
	};
	abortControllersWhenParentAborts(dispatchAbort.signal, chainEntryAbortControllers);
	const abortChain = (reason: CancelReason): void => {
		chainCancelReason ??= reason;
		dispatchAbort.abort();
	};
	const runState: DelegateDispatchState = {
		runId,
		rootRunId: rootRunIdForNewRun(runId),
		ownerSessionId: args.ownerSessionId,
		// Issue #76 — chain step names are `step<N>-…`/`step<N>.…`, which the old
		// name inference never matched; tag the shape at registration instead.
		shape: "chain",
		notifyOnFailure: args.notifyOnFailure !== false,
		createdAt: Date.now(),
		// Legacy async-dispatch marker: sync:false chain runs outlive the parent
		// turn, but they remain in-process and are terminalized on session reload.
		detached: !args.sync,
		forks: {}, // populated by chain steps
		abort: () => abortChain("user"),
		cancel: async (taskName, reason) => {
			const why = reason ?? "user";
			if (taskName !== undefined) {
				const target = runState.forks[taskName];
				if (!target || !isLiveStatus(target.status)) return;
				if (!chainEntryCancelReasons.has(taskName)) chainEntryCancelReasons.set(taskName, why);
				chainEntryAbortController(taskName).abort();
				return;
			}
			abortChain(why);
		},
	};
	registerRun(runState);

	const onForkRuntimeUpdate = (forkName: string, patch: Partial<RunLiveState>) => {
		chainEntryAbortController(forkName);
		// chain-execution sends the full RunLiveState shape on first touch
		// (so the entry can be created in-place); subsequent updates are
		// partial patches. We treat the runtime layer's `updateRunState`
		// as merge-with-create — backfill missing entries.
		const existing = runState.forks[forkName];
		if (!existing) {
			runState.forks[forkName] = {
				name: forkName,
				agent: "(unknown)",
				agentSource: "user",
				task: "",
				status: "pending" as const,
				currentRound: 0,
				maxRounds: 1,
				transcript: [],
				pendingGuidance: [],
				interactive: false,
				...patch,
			} as RunLiveState;
		}
		updateRunState(runId, forkName, patch);
	};
	const onForkTranscriptEntry = (forkName: string, entry: any) =>
		appendTranscriptEntry(runId, forkName, entry);

	const sharedArgs = {
		steps: args.steps,
		chainTask: args.chainTask,
		scope: args.scope,
		cwd: args.chainCwd,
		mainModel: ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id }
			: undefined,
		authStorage: ctx.modelRegistry.authStorage,
		allowRegistryRuntimeFallback: true,
		modelRegistry: ctx.modelRegistry,
		scopedModelRefs: modelScopeFromExtensionContext(ctx, getAgentDir()),
		agentDir: getAgentDir(),
		parentTranscriptEntries: args.parentTranscriptEntries,
		runId,
		ownerSessionId: args.ownerSessionId,
		signal: dispatchAbort.signal,
		getForkSignal: (forkName: string) => chainEntryAbortController(forkName).signal,
		getCancelReason: (forkName?: string) =>
			(forkName === undefined ? undefined : chainEntryCancelReasons.get(forkName)) ?? chainCancelReason,
		chainDir,
		agents: args.agents,
		discoveryWarnings: args.discoveryWarnings,
		// Phase D: pass DelegateConfig through so chain steps can resolve
		// the intercom bridge per agent (extensions allowlist + mode +
		// pi-intercom availability).
		config: args.config,
		ensureWorkerToolRegistration: args.ensureWorkerToolRegistration,
		getWorkerToolDefinitions: args.getWorkerToolDefinitions,
		onForkRuntimeUpdate,
		onForkFailure: args.sync || args.notifyOnFailure === false
			? undefined
			: (forkName: string, patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason }) => {
				try {
					const disposition = notifyForkFailed(
						wakeSink,
						{
							runId,
							mode: "chain",
							forkName,
							status: "failed",
							// Chain steps have no recovery descriptor carrying the exact
							// task/env redaction set, so expose only the categorical reason.
							reason: patch.reason ?? "fork-failed",
							siblingStates: failureSiblingStates(runState, forkName),
							recoveryAvailable: false,
							recovery: { available: false, strategy: "fresh" },
						},
						{ agentDir: args.agentDir, ownerSessionId: args.ownerSessionId },
					);
					return disposition !== "dropped";
				} catch (err) {
					logDelegateDiagnostic(`chain step failure wake failed runId=${diagnosticIdentityText(runId)} step=${diagnosticIdentityText(forkName)}: ${diagnosticErrorText(err)}`, { agentDir: args.agentDir, level: "warn" });
					return false;
				}
			},
		onForkTranscriptEntry,
	};

	if (args.sync) {
		try {
			const out = await executeChain(sharedArgs);
			// Synthesise a finalResult array for the registry by flattening
			// every step's results in chronological order.
			const flat = out.steps.flatMap((s) => s.results);
			completeRunWithEscalationCleanup(runId, flat);
			appendDelegateUsageMetadata(pi, runId, "chain", flat, args.agentDir);
			return {
				content: [{ type: "text", text: capDelegateOnlyResult(out.combinedContent, runId, { claimAdvisory: false, runId }).text }],
				details: {
					runId,
					shape: "chain",
					forks: projectRunResultsForDetails(flat),
					chainDir: out.chainDir,
					chainCwd: args.chainCwd,
					steps: out.steps.length,
					...usageDetails(flat),
				},
				isError: out.anyFailed,
			};
		} catch (err: any) {
			completeRunWithEscalationCleanup(runId, []);
			throw err;
		}
	}

	// Dispatch mode: kick off and wake up later.
	const dispatchPromise = executeChain(sharedArgs);
	dispatchPromise
		.then((out) =>
			containDispatchTail(runId, "chain", () => {
				const flat = out.steps.flatMap((s) => s.results);
				if (!completeRunWithEscalationCleanup(runId, flat)) return;
				notifyCompletion(
					wakeSink,
					{
						runId,
						mode: "chain",
						completionNotifyStrategy: args.config?.completionNotifyStrategy,
						finalResults: flat,
						combinedContent: out.combinedContent,
					},
					{ agentDir: args.agentDir, ownerSessionId: args.ownerSessionId },
				);
			}),
		)
		.catch((err: any) =>
			containDispatchTail(runId, "chain", () => {
				const message = boundedErrorMessage(err);
				logDelegateDiagnostic(`chain dispatch runId=${diagnosticIdentityText(runId)} failed: ${diagnosticErrorText(err)}`, { agentDir: args.agentDir });
				if (!completeRunWithEscalationCleanup(runId, [])) return;
				notifyCompletion(
					wakeSink,
					{
						runId,
						mode: "chain",
						completionNotifyStrategy: args.config?.completionNotifyStrategy,
						finalResults: [],
						combinedContent: "",
						error: message,
					},
					{ agentDir: args.agentDir, ownerSessionId: args.ownerSessionId },
				);
			}),
		);
	const text =
		`Dispatched chain runId=${runId} with ${args.steps.length} step(s). ` +
		"A new turn will be triggered automatically with the full output when the chain completes — do not poll or sleep.";
	return {
		content: [{ type: "text", text }],
		details: {
			dispatched: true,
			runId,
			shape: "chain",
			mode: "chain",
			chainDir,
			chainCwd: args.chainCwd,
			steps: args.steps.length,
		},
	};
}

/**
 * Phase A: execute a direct-mode shape end-to-end.
 *
 * Mirrors the structure of the supervised `execute()` body but uses the
 * direct-mode pump (no clone supervisor, no heartbeat). Returns the
 * MCP-tool-shaped response (`content` / `details` / `isError`).
 *
 * Launch-mode default: every direct shape dispatches in the background.
 * The public `await: true` option (or deprecated `sync: true` alias) passes
 * `sync = true` to this internal execution boundary.
 */
export interface ExecuteDirectShapeArgs {
	pi: ExtensionAPI;
	mode: "single-direct" | "parallel-direct";
	tasks: DirectTaskInput[];
	concurrency: number;
	worktree: boolean;
	sync: boolean;
	signal: AbortSignal | undefined;
	ctx: any;
	/** Optional execution cwd override for event-bridge callers that must keep the live ExtensionContext but run against a request-scoped cwd. */
	ctxCwd?: string;
	/** Optional main-model override. `null` disables the implicit session-model fallback. */
	mainModel?: { provider: string; id: string } | null;
	toolCallId: string;
	onUpdate: ((u: any) => void) | undefined;
	config: ReturnType<typeof loadConfig>;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	/** Trusted parent branch snapshot, passed only when a task has the grant. */
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly ToolDefinition[];
	/** Default-on per-entry failure wake; false explicitly opts out. */
	notifyOnFailure?: boolean;
	/**
	 * Per-entry recovery descriptors created at dispatch time. Stored on the
	 * run state so `delegate_recover` can find them without an explicit seam.
	 */
	recoveryDescriptors?: Map<string, RunRecoveryDescriptor>;
}

function retryAdmissionRejection(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: { forks: [] };
	isError: true;
} | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /^retry registration rejected: (.+)$/.exec(message);
	if (!match) return undefined;
	return {
		content: [{ type: "text", text: `retry admission rejected: ${match[1]}` }],
		details: { forks: [] },
		isError: true,
	};
}

export async function executeDirectShape(args: ExecuteDirectShapeArgs): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: any;
	isError?: boolean;
}> {
	const { pi, ctx, signal } = args;
	let { config } = args;
	const wakeSink = bindWakeSinkToCurrentContext(pi);
	const tasks = args.tasks;
	const runId = deriveRunId(args.toolCallId);
	const executionCwd = args.ctxCwd ?? ctx.cwd;
	const mainModel =
		args.mainModel === null
			? undefined
			: (args.mainModel ?? (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined));

	// ── worktree + per-task cwd incompatibility ──────────────────────────
	if (args.worktree) {
		const conflict = tasks.find((t) => t.cwd !== undefined);
		if (conflict) {
			return {
				content: [
					{
						type: "text",
						text:
							`worktree: true is incompatible with per-task cwd. ` +
							`Task "${conflict.name}" (${conflict.agent.name}) sets cwd=${JSON.stringify(conflict.cwd)}. ` +
							`Remove cwd from all tasks or disable worktree.`,
					},
				],
				details: { shape: "direct", forks: [] },
				isError: true,
			};
		}
	}
	const retryClaims = tasks
		.filter((task) => task.retryOf !== undefined)
		.map((task) => ({ successorForkName: task.name, successor: { runId, forkName: task.name }, retryOf: task.retryOf! }));
	// Retry admission is the side-effect boundary. The locked transaction in
	// registerRunWithRetryClaims is authoritative because its lookup includes the
	// fresh disk snapshot as well as this process' memory.
	// Reserve the complete run
	// before worktree or chain-directory creation; later setup failures remain
	// failures of this already-admitted attempt.
	let preRegisteredRunState: DelegateDispatchState | undefined;
	let preRegisteredDispatchAbort: AbortController | undefined;
	if (retryClaims.length > 0) {
		preRegisteredDispatchAbort = new AbortController();
		const provisional = buildDirectRunState({
			runId,
			rootRunId: rootRunIdForNewRun(runId),
			ownerSessionId: args.ownerSessionId,
			notifyOnFailure: args.notifyOnFailure,
			tasks,
			dispatchAbort: preRegisteredDispatchAbort,
		});
		for (const fork of Object.values(provisional.runState.forks)) {
			delete fork.retryOf;
			delete fork.attempt;
		}
		try {
			registerRunWithRetryClaims(provisional.runState, retryClaims);
		} catch (error) {
			const rejection = retryAdmissionRejection(error);
			if (rejection) return rejection;
			throw error;
		}
		preRegisteredRunState = provisional.runState;
		for (const task of tasks) task.attempt = preRegisteredRunState.forks[task.name]?.attempt ?? 1;
	}

	// Only an admitted invocation may migrate legacy config or emit parser
	// diagnostics. Rejected retry claims return before this disk-writing call.
	config = loadConfig(args.agentDir);

	// Resolve the invocation-owned agent directory before worktree setup.
	const directAgentDir = getAgentDir();
	// ── Worktree setup ───────────────────────────────────────────────────
	let worktreeSetup: WorktreeSetup | undefined;
	if (args.worktree) {
		try {
			worktreeSetup = createWorktrees(executionCwd, runId, tasks.length, {
				agentDir: directAgentDir,
				agents: tasks.map((t) => t.agent.name),
				setupHook: config.worktreeSetupHook
					? {
							hookPath: config.worktreeSetupHook,
							timeoutMs: config.worktreeSetupHookTimeoutMs,
						}
					: undefined,
			});
		} catch (err: any) {
			if (preRegisteredRunState) {
				completeRun(runId, finalizePrelaunchFailures(preRegisteredRunState, `Failed to create worktrees: ${diagnosticErrorText(err)}`, executionCwd));
			}
			return {
				content: [{ type: "text", text: `Failed to create worktrees: ${err?.message ?? err}` }],
				details: { shape: "direct", forks: [] },
				isError: true,
			};
		}
	}

	// ── Chain dir for `artifact:` / `progress:` writes ─────────────────
	// Sweep stale dirs (24h+) opportunistically — we'd otherwise leak under tmpdir.
	try {
		sweepOldChainDirs({});
	} catch {
		/* best-effort */
	}
	let chainDir: string;
	try {
		chainDir = prepareChainDir({ runId });
	} catch (error) {
		if (preRegisteredRunState) {
			completeRun(runId, finalizePrelaunchFailures(preRegisteredRunState, `Failed to prepare chain directory: ${diagnosticErrorText(error)}`, executionCwd));
		}
		return {
			content: [{ type: "text", text: `Failed to prepare chain directory: ${(error as Error).message}` }],
			details: { forks: [] },
			isError: true,
		};
	}

	// ── Runtime state setup ──────────────────────────────────────────────
	const dispatchAbort = preRegisteredDispatchAbort ?? new AbortController();
	const taskAbortControllers: Record<string, AbortController> = {};
	for (const task of tasks) taskAbortControllers[task.name] = new AbortController();
	// Sync mode only — see dispatch-signal.ts. In dispatch we leave
	// the parent-turn AbortSignal disconnected from dispatchAbort so
	// that a later parent-turn abort (e.g. pi-intercom calling
	// ctx.abort() to deliver an inbound message) doesn't cascade into
	// the detached run.
	wireSignalToDispatch(signal, dispatchAbort, { sync: args.sync });
	abortControllersWhenParentAborts(dispatchAbort.signal, taskAbortControllers);
	const builtDirectState = preRegisteredRunState
		? { runState: preRegisteredRunState, sessionRefsByTask: Object.fromEntries(tasks.map((task) => [task.name, {} as { worker?: any }])) }
		: buildDirectRunState({
		runId,
		rootRunId: rootRunIdForNewRun(runId),
		ownerSessionId: args.ownerSessionId,
		notifyOnFailure: args.notifyOnFailure,
		tasks,
		dispatchAbort,
		});
	const { runState, sessionRefsByTask } = builtDirectState;
	for (let index = 0; index < tasks.length; index++) {
		const task = tasks[index]!;
		const entry = runState.forks[task.name]!;
		const isolated = worktreeSetup?.worktrees[index];
		entry.workerCwd = isolated?.agentCwd ?? resolveChildCwd(executionCwd, task.cwd);
		if (isolated) entry.workerBranch = isolated.branch;
	}
	// Legacy async-dispatch marker: sync:false direct runs outlive the parent
	// turn, but remain in-process and are terminalized on session reload. Move
	// their entries to "constructing" while worker sessions boot so explicit cancel
	// / shutdown cleanup treats them as live before the first runtime update.
	// Promotion to "running" happens via onForkRuntimeUpdate once each worker
	// establishes.
	if (!args.sync) {
		runState.detached = true;
		for (const entry of Object.values(runState.forks)) {
			if (entry.status === "pending") entry.status = "constructing";
		}
	} else {
		runState.detached = false;
	}

	// Wire the `cancel` callback. Direct mode has no clone session, so
	// cancel is much simpler than supervised: stamp the live state, drain
	// any pending prompts, and call workerSession.abort().
	const cancelOneTask = async (taskName: string, reason: CancelReason) => {
		const refs = sessionRefsByTask[taskName];
		const current = runState.forks[taskName]?.status;
		if (current === "completed" || current === "failed" || current === "aborted") return;
		const errorText = reasonToErrorText(reason);
		taskAbortControllers[taskName]?.abort();
		updateRunState(runId, taskName, {
			status: "aborted",
			error: errorText,
			cancelReason: reason,
		});
		drainPendingPrompts(runId, taskName);
		try {
			await refs?.worker?.abort();
		} catch {
			/* swallow */
		}
	};
	runState.cancel = async (taskName, reason) => {
		const why: CancelReason = reason ?? "user";
		if (taskName !== undefined) {
			const target = runState.forks[taskName];
			if (!target || !isLiveStatus(target.status)) return;
			await cancelOneTask(taskName, why);
			return;
		}
		const liveNames = Object.values(runState.forks)
			.filter((f) => isLiveStatus(f.status))
			.map((f) => f.name);
		await Promise.all(liveNames.map((n) => cancelOneTask(n, why)));
		dispatchAbort.abort();
	};
	if (args.recoveryDescriptors && args.recoveryDescriptors.size > 0) {
		runState.recoveryDescriptors = args.recoveryDescriptors;
	}
	if (retryClaims.length === 0) {
		registerRun(runState);
	}

	// #287 — the solo wall-clock budget is armed inside `runDirectWorker`, not
	// here. Review of the first revision found that an after-gated dispatch
	// compiles to `chain`, which builds its own DirectRequest and never reached
	// timers owned by this path, so the budget validated and then governed
	// nothing. The runner is the one choke point every solo path shares.
	const windDownSteeredTasks = new Set<string>();

	const onForkRuntimeUpdate = (forkName: string, patch: Partial<RunLiveState>) => {
		const current = runState.forks[forkName]?.status;
		const safePatch = { ...patch };
		if (current === "aborted" && safePatch.status !== undefined && safePatch.status !== "aborted") {
			delete safePatch.status;
		}
		updateRunState(runId, forkName, safePatch);
		// #287: the runner owns the budget timers, and latches wind-down
		// provenance on the live state. Mirror it into the batch-level set so the
		// terminal results carry `steered` on both the awaited and background
		// completion paths.
		if (safePatch.windDown?.reason === "wall-clock") windDownSteeredTasks.add(forkName);
	};
	const onForkTranscriptEntry = (forkName: string, entry: any) =>
		appendTranscriptEntry(runId, forkName, entry);

	// Resolve the bridge inside the pump after each task's worktree/per-task cwd
	// is known, so policy discovery and worker loading use identical context.
	const getDirectFailureRecovery = (forkName: string) => {
		const descriptor = runState.recoveryDescriptors?.get(forkName);
		const contextAvailable = descriptor?.buildPriorContext() !== undefined;
		return {
			available: descriptor !== undefined,
			contextAvailable,
			strategy: contextAvailable ? "resume" : "fresh",
		} as const;
	};

	const sharedPumpArgs = {
		tasks,
		concurrency: args.concurrency,
		signal: dispatchAbort.signal,
		ctxCwd: executionCwd,
		mainModel,
		authStorage: ctx.modelRegistry.authStorage,
		allowRegistryRuntimeFallback: true,
		modelRegistry: ctx.modelRegistry,
		scopedModelRefs: modelScopeFromExtensionContext(ctx, getAgentDir()),
		agentDir: directAgentDir,
		runId,
		ownerSessionId: args.ownerSessionId,
		originatorEscalationConfig: config.escalation,
		ensureWorkerToolRegistration: args.ensureWorkerToolRegistration,
		getWorkerToolDefinitions: args.getWorkerToolDefinitions,
		taskSignals: Object.fromEntries(
			Object.entries(taskAbortControllers).map(([name, controller]) => [name, controller.signal]),
		),
		worktreeSetup,
		chainDir,
		onForkRuntimeUpdate,
		onForkFailure: args.sync || args.notifyOnFailure === false
			? undefined
			: (forkName: string, patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason; recovery?: RunFailureRecovery; worktreeDiff?: import("./worktree.js").WorktreeDiff }) => {
				try {
					// The direct runner computes this at the failure emit boundary so the
					// wake and the await result observe the same verdict. Keep the local
					// lookup as a fallback for infrastructure/setup failures.
					const verdict = patch.recovery ?? getDirectFailureRecovery(forkName);
					const disposition = notifyForkFailed(
						wakeSink,
						{
							runId,
							mode: "direct",
							forkName,
							status: "failed",
							reason: patch.reason ?? "fork-failed",
							siblingStates: failureSiblingStates(runState, forkName),
							recoveryAvailable: verdict.available,
							recovery: verdict,
							...(patch.worktreeDiff !== undefined ? { worktreeDiff: patch.worktreeDiff } : {}),
						},
						{ agentDir: directAgentDir, ownerSessionId: args.ownerSessionId },
					);
					if (disposition === "cross-boundary" || disposition === "dropped") {
						runState.recoveryDescriptors?.delete(forkName);
					}
					return disposition !== "dropped";
				} catch (err) {
					logDelegateDiagnostic(`direct worker failure wake failed runId=${diagnosticIdentityText(runId)} worker=${diagnosticIdentityText(forkName)}: ${diagnosticErrorText(err)}`, { agentDir: directAgentDir, level: "warn" });
					return false;
				}
			},
		onForkTranscriptEntry,
		sessionRefsByTask,
		getCancelReasonByTask: Object.fromEntries(
			tasks.map((task) => [task.name, () => runState.forks[task.name]?.cancelReason]),
		),
		getFailureRecovery: getDirectFailureRecovery,
		resolveIntercomBridgeForTask: (task: DirectTaskInput, effectiveCwd: string) =>
			resolveIntercomBridgeWithPolicy({
				config,
				agent: task.agent,
				directMode: true,
				cwd: effectiveCwd,
				agentDir: directAgentDir,
			}),
	};

	// ── SYNC MODE ────────────────────────────────────────────────────────
	if (args.sync) {
		const emit = (results: RunResult[]) => {
			if (!args.onUpdate) return;
			const running = countLiveRuns(results);
			const done = results.filter((r) => r.status === "completed").length;
			args.onUpdate({
				content: [{ type: "text", text: `delegate (direct): ${done}/${tasks.length} done, ${running} running` }],
				details: { shape: "direct", forks: projectRunResultsForDetails(results) },
			});
		};
		try {
			const pumped = await pumpDirectWorkers({ ...sharedPumpArgs, onStreamUpdate: emit });
			// #287: a run that received the wall-clock wrap-up reports steered=true
			// whether it then finished inside grace or was hard-cancelled after it.
			applyWindDownSteered(pumped.finalResults, windDownSteeredTasks);
			completeRunWithEscalationCleanup(runId, pumped.finalResults);
			appendDelegateUsageMetadata(pi, runId, "direct", pumped.finalResults, directAgentDir);
			const detailsBase: { runId: string; shape: "direct"; forks: RunResultDetails[]; worktreeDiffs?: WorktreeDiff[]; usage: ReturnType<typeof aggregateRunResults>; usageByFork: ReturnType<typeof summarizeRunUsages> } = {
				runId,
				shape: "direct",
				forks: projectRunResultsForDetails(pumped.finalResults),
				...usageDetails(pumped.finalResults),
			};
			const retryDetails = resolveRunResult(directAgentDir, runId)?.details;
			if (retryDetails?.retry) {
				(detailsBase as Record<string, unknown>).retry = retryDetails.retry;
				if (retryDetails.retryMetadataIncomplete) (detailsBase as Record<string, unknown>).retryMetadataIncomplete = true;
				if (retryDetails.retryMetadataTruncated) (detailsBase as Record<string, unknown>).retryMetadataTruncated = true;
			}
			if (worktreeSetup) detailsBase.worktreeDiffs = pumped.worktreeDiffs;
			return {
				content: [{ type: "text", text: capDelegateOnlyResult(pumped.combinedContent, runId, { claimAdvisory: false, runId }).text }],
				details: detailsBase,
				isError: pumped.anyFailed,
			};
		} catch (err: any) {
			completeRunWithEscalationCleanup(runId, []);
			throw err;
		}
	}

	// ── DISPATCH MODE ────────────────────────────────────────────────────
	const dispatchPump = pumpDirectWorkers(sharedPumpArgs);
	dispatchPump
		.then((result) =>
			containDispatchTail(runId, "direct", () => {
				applyWindDownSteered(result.finalResults, windDownSteeredTasks);
				if (!completeRunWithEscalationCleanup(runId, result.finalResults)) return;
				notifyCompletion(
					wakeSink,
					{
						runId,
						mode: "direct",
						completionNotifyStrategy: config.completionNotifyStrategy,
						finalResults: result.finalResults,
						combinedContent: result.combinedContent,
					},
					{ agentDir: args.agentDir, ownerSessionId: args.ownerSessionId },
				);
			}),
		)
		.catch((err: any) =>
			containDispatchTail(runId, "direct", () => {
				const message = boundedErrorMessage(err);
				logDelegateDiagnostic(`direct dispatch runId=${diagnosticIdentityText(runId)} failed: ${diagnosticErrorText(err)}`, { agentDir: directAgentDir });
				if (!completeRunWithEscalationCleanup(runId, [])) return;
				notifyCompletion(
					wakeSink,
					{
						runId,
						mode: "direct",
						completionNotifyStrategy: config.completionNotifyStrategy,
						finalResults: [],
						combinedContent: "",
						error: message,
					},
					{ agentDir: args.agentDir, ownerSessionId: args.ownerSessionId },
				);
			}),
		);

	const taskNames = args.tasks.map((t) => t.name);
	const directTerminology = runEntryTerminology("direct");
	const budgetAck = tasks.some(
		(task) => task.max_duration_ms > 0 && task.timeoutPolicy !== undefined && !isHardCancelEnabled(task.timeoutPolicy),
	)
		? `\n${WALL_CLOCK_BUDGET_ACK}`
		: "";
	const text =
		`Dispatched runId=${runId} with ${taskNames.length} ${directTerminology.plural}: ${taskNames.join(", ")}. ` +
		`A new turn will be triggered automatically with the full output when all ${directTerminology.plural} complete — do not poll or sleep.` +
		budgetAck;
	return {
		content: [{ type: "text", text }],
		details: { dispatched: true, runId, shape: "direct", forkNames: taskNames, mode: "direct" },
	};
}

function invocationOverridesFromSlot(slot: any): InvocationAgentOverrides | undefined {
	const hasOverride =
		slot?.model !== undefined ||
		slot?.thinking !== undefined ||
		slot?.thinkingMin !== undefined ||
		slot?.thinkingMax !== undefined ||
		slot?.fallbackModels !== undefined ||
		slot?.maxSubagentDepth !== undefined ||
		slot?.skill !== undefined ||
		slot?.skills !== undefined ||
		slot?.env !== undefined ||
		slot?.max_duration_ms !== undefined ||
		slot?.wind_down_grace_ms !== undefined;
	if (!hasOverride) return undefined;
	return {
		model: slot.model,
		thinking: slot.thinking,
		thinkingMin: slot.thinkingMin,
		thinkingMax: slot.thinkingMax,
		fallbackModels: slot.fallbackModels,
		maxSubagentDepth: slot.maxSubagentDepth,
		skill: slot.skill,
		skills: slot.skills,
		...(slot.env !== undefined ? { env: slot.env } : {}),
		maxDurationMs: slot.max_duration_ms,
		windDownGraceMs: slot.wind_down_grace_ms,
	};
}

/** Resolve and freeze one slot's §5 policy before any dispatch side effect. */
function resolveSlotEscalationPolicy(args: {
	shape: "supervised" | "direct" | "parallel-direct" | "chain";
	config: DelegateConfig;
	agent: AgentConfig | undefined;
	invocationValue: unknown;
	fieldPath: string;
}): EffectiveEscalationPolicy {
	let invocationLayer: EscalationConfig | undefined;
	if (args.invocationValue !== undefined) {
		invocationLayer = parseEscalationInvocationValue(args.invocationValue, args.fieldPath);
	}
	return resolveEscalationPolicy({
		shape: args.shape,
		globalLayer: args.config.escalationGlobalLayer,
		agentLayer: args.agent?.escalation,
		invocationLayer,
	});
}

function escalationPreflightError(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: { forks: RunResultDetails[] };
	isError: true;
} {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: { forks: [] },
		isError: true,
	};
}

function projectTrustPreflight(
	agents: readonly AgentConfig[],
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
): ReturnType<typeof escalationPreflightError> | undefined {
	const message = projectAgentTrustError(agents, ctx.isProjectTrusted?.() === true);
	return message ? escalationPreflightError(new Error(message)) : undefined;
}

function validateReadOnlySlots(params: Record<string, unknown>, shape: string): string | undefined {
	const check = (value: unknown, fieldPath: string): string | undefined => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		try {
			assertReadOnlyValue((value as Record<string, unknown>).readOnly, `${fieldPath}.readOnly`);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		const parallel = (value as Record<string, unknown>).parallel;
		if (Array.isArray(parallel)) {
			for (let index = 0; index < parallel.length; index++) {
				const failure = check(parallel[index], `${fieldPath}.parallel[${index}]`);
				if (failure) return failure;
			}
		}
		return undefined;
	};
	if (shape === "single-direct") {
		const failure = check(params, "");
		return failure?.replace(/^\.readOnly/u, "readOnly");
	}
	if (shape === "orchestrate") return check(params.orchestrate, "orchestrate");
	for (const key of ["agents", "tasks", "chain"] as const) {
		const entries = params[key];
		if (!Array.isArray(entries)) continue;
		for (let index = 0; index < entries.length; index++) {
			const failure = check(entries[index], `${key}[${index}]`);
			if (failure) return failure;
		}
	}
	return undefined;
}

function stripRemovedInvocationConfig(params: Record<string, unknown>): Record<string, unknown> {
	const cleaned = stripRemovedPlaneConfigKeys(params, "invocation.");
	const stripSlot = (value: unknown, prefix: string): unknown => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const slot = stripRemovedPlaneConfigKeys(value as Record<string, unknown>, prefix);
		if (Array.isArray(slot.parallel)) {
			slot.parallel = slot.parallel.map((child, index) => stripSlot(child, `${prefix}parallel[${index}].`));
		}
		return slot;
	};
	for (const key of ["agents", "tasks", "chain"] as const) {
		const value = cleaned[key];
		if (!Array.isArray(value)) continue;
		cleaned[key] = value.map((slot, index) => stripSlot(slot, `${key}[${index}].`));
	}
	if (cleaned.orchestrate && typeof cleaned.orchestrate === "object" && !Array.isArray(cleaned.orchestrate)) {
		cleaned.orchestrate = stripSlot(cleaned.orchestrate, "orchestrate.");
	}
	return cleaned;
}

function configuredAgentDiscoveryOptions(
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	cwd: string,
	warnings?: string[],
): PackageAgentDiscoveryOptions {
	return {
		additionalResolvedPackageRoots: configuredPackageRoots({
			cwd,
			agentDir: getAgentDir(),
			projectTrusted: ctx.isProjectTrusted?.() === true,
			...(warnings ? { warn: (message: string) => warnings.push(message) } : {}),
		}),
	};
}

/** Apply the effective delegate config to an already-discovered agent list. */
function applyConfiguredAgentOverrides(
	discovery: ReturnType<typeof discoverAgents>,
	config: DelegateConfig = loadConfigReadOnly(getAgentDir()),
): ReturnType<typeof discoverAgents> {
	const overridden = applyAgentOverrides(discovery.agents, config);
	if (overridden.unmatched.length > 0) {
		logDelegateDiagnostic(
			`agentOverrides keys had no matching agent: ${overridden.unmatched.join(", ")}`,
			{ agentDir: getAgentDir() },
		);
	}
	return { ...discovery, agents: overridden.agents };
}

/**
 * Canonical originator terminal hook (spec invariant 6). Nested runs have a
 * different rootRunId and must not purge their root's sibling escalations.
 */
function completeRunWithEscalationCleanup(runId: string, finalResult: RunResult[]): boolean {
	const run = getRun(runId);
	const rootRunId = run?.rootRunId ?? runId;
	const completed = completeRun(runId, finalResult);
	if (!completed) return false;
	if (rootRunId !== runId) return true;
	cleanupEscalationsForRun({
		agentDir: getAgentDir(),
		rootRunId,
		reason: "Escalation cancelled because the root delegate run terminated.",
	});
	return true;
}

export default function (pi: ExtensionAPI) {
	// Pi resolves package skills before this public discovery lifecycle. The
	// bundled pi-delegate skill is therefore supplied only here, once, so a
	// filtered path cannot lose to an earlier same-name package resource.
	pi.on("resources_discover", async (event, ctx) => {
		const skillPath = await resolveSkillResource({
			reason: event.reason,
			cwd: event.cwd,
			agentDir: getAgentDir(),
			projectTrusted: ctx.isProjectTrusted(),
		});
		return skillPath ? { skillPaths: [skillPath] } : {};
	});

	type RuntimeToolExecute = (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (update: unknown) => void,
		ctx?: ExtensionContext,
	) => Promise<DelegateRuntimeToolResult>;
	const runtimeToolExecutors = new Map<string, RuntimeToolExecute>();
	const toolHost = pi as unknown as {
		registerTool: (definition: unknown) => void;
	};
	const registerRuntimeTool = (definition: { name: string; execute: RuntimeToolExecute } & Record<string, unknown>) => {
		runtimeToolExecutors.set(definition.name, definition.execute);
		// The consolidated surface (#265) keeps every legacy executor as an
		// internal invoke key — the runtime API calls these by name, and they
		// remain accepted `tools:` allowlist aliases — but stops advertising them
		// to the model, which is where the context saving actually comes from.
		// Registration and advertisement are therefore separate concerns.
		// Unadvertised: the legacy executors remain internal invoke keys and
		// `tools:` aliases, reachable through delegate_control / delegate_escalation
		// and the runtime API, but never serialized into a provider request.
		if (LEGACY_CONTROL_TOOL_NAMES.has(definition.name)) return;
		toolHost.registerTool(definition);
	};

	/**
	 * State-gated tools (#265). Registering a tool with pi ACTIVATES it
	 * immediately — `registerTool` refreshes the registry and the new name is
	 * added to the active set — so a tool registered at extension init is
	 * advertised in every provider request no matter what the active-tool union
	 * later says. Deferring registration until the predicate first fires is
	 * therefore the only way to keep an idle session from paying for them.
	 *
	 * Pi supports late registration: after the session binds, `registerTool`
	 * points at the live registry, so revealing mid-session is well-defined.
	 */
	const deferredToolDefinitions = new Map<string, { name: string; execute: RuntimeToolExecute } & Record<string, unknown>>();
	const revealedDeferredTools = new Set<string>();
	const registeredDeferredTools = new Set<string>();
	const toolRegistry = pi as Partial<{
		getActiveTools: () => string[];
		setActiveTools: (names: string[]) => void;
	}>;
	const registerDeferredTool = (
		definition: { name: string; execute: RuntimeToolExecute } & Record<string, unknown>,
	) => {
		// The executor is available to the runtime API from the start; only the
		// model-visible registration waits.
		runtimeToolExecutors.set(definition.name, definition.execute);
		deferredToolDefinitions.set(definition.name, definition);
		// The budget harness measures what each tool costs when live, which it
		// cannot see while the tool is still deferred. A real pi host does not
		// implement this, so the tool stays unadvertised in production.
		(
			pi as Partial<{ registerDeferredForMeasurement: (definition: unknown) => void }>
		).registerDeferredForMeasurement?.(definition);
	};
	const registerDeferredTools = (names: readonly string[], advertise: boolean): void => {
		for (const name of names) {
			const definition = deferredToolDefinitions.get(name);
			if (!definition) continue;
			if (!registeredDeferredTools.has(name)) {
				toolHost.registerTool(definition);
				registeredDeferredTools.add(name);
			}
			if (advertise) revealedDeferredTools.add(name);
		}
	};
	const revealDeferredTools = (names: readonly string[]): void => {
		registerDeferredTools(names, true);
	};
	/**
	 * Register a worker-granted deferred tool without advertising it to the
	 * foreground model. Pi's registerTool refresh adds new tools to the active
	 * set, so restore the exact pre-registration set immediately afterwards.
	 * This keeps issue #265's idle gate while making the name available to a
	 * worker scope that validates its static allowlist against getAllTools().
	 */
	const ensureWorkerToolRegistration = (names: readonly string[]): (() => void) => {
		const deferredNames = names.filter((name) => deferredToolDefinitions.has(name));
		const active = toolRegistry.getActiveTools?.();
		// Mark the definition as revealed to the worker-owned runtime, but restore
		// the foreground active list before its next model turn.
		registerDeferredTools(deferredNames, true);
		if (!Array.isArray(active)) return () => {};
		// Registration refreshes the foreground active set, so restore it before
		// the delegate call returns or starts any background worker. The worker gets
		// the same definition through getWorkerToolDefinitions below.
		toolRegistry.setActiveTools?.(active);
		return () => {};
	};
	const getWorkerToolDefinitions = (names: readonly string[]): readonly ToolDefinition[] =>
		names.flatMap((name) => {
			const definition = deferredToolDefinitions.get(name);
			return definition ? [definition as unknown as ToolDefinition] : [];
		});
	/**
	 * Reveal state-gated control tools (#265). Assigned once the visibility
	 * machinery is constructed further down; forward-declared because the wake
	 * and dispatch seams that must call it appear earlier in this factory.
	 */
	let assertControlVisibilityHook: () => void = () => {};
	let currentForegroundSessionId: string | undefined;
	let currentForegroundContext: ExtensionContext | undefined;
	let recoveryAuthorityEpoch = 0;
	const deliveredEscalationHops = new Set<string>();
	let escalationDeliveryTail: Promise<void> = Promise.resolve();

	interface RecoveryTerminalObservation {
		descriptor: RunRecoveryDescriptor;
		publishedLaunch: Promise<RecoveryLaunchResult>;
	}
	const recoveryTerminalObservations = new Map<string, RecoveryTerminalObservation>();
	const classifyRecoveryTerminalResult = (recoveryRunId: string, finalResult: readonly RunResult[]): void => {
		const observation = recoveryTerminalObservations.get(recoveryRunId);
		if (!observation) return;
		recoveryTerminalObservations.delete(recoveryRunId);
		const failed = finalResult.find((result) => result.status === "failed");
		// #332: release the single-shot recovery only when the runner recorded the
		// terminal cause as transient/capacity via `retryKind`. Do NOT re-classify
		// `error` (markNoModelAlternative suffixes it, which the narrow classifiers
		// reject) nor `errorKind` alone (the worker-harness failure path also stamps
		// "no-model-alternative" but is not a transient cause and must not release).
		if (failed?.retryKind === "transient") {
			releaseRecoveryLaunchAfterTransientFailure({
				descriptor: observation.descriptor,
				publishedLaunch: observation.publishedLaunch,
				recoveryRunId,
			});
		}
	};
	const observeRecoveryTerminalResult = (
		descriptor: RunRecoveryDescriptor,
		recovered: ExecuteRecoveryOnceResult,
	): void => {
		const recoveryRunId = recovered.outcome.recoveryRunId;
		recoveryTerminalObservations.set(recoveryRunId, {
			descriptor,
			publishedLaunch: recovered.publishedLaunch,
		});
		const alreadyTerminal = getRun(recoveryRunId)?.finalResult;
		if (alreadyTerminal) classifyRecoveryTerminalResult(recoveryRunId, alreadyTerminal);
	};

	const exactSessionId = (ctx: ExtensionContext): string | undefined => {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			return undefined;
		}
	};

	const assertDaemonDriverControlAuthority = (
		cfg: OrchestrateCfg,
		callerSessionId: string | undefined,
	): void => {
		if (
			cfg.ownerSessionId === undefined ||
			callerSessionId !== cfg.ownerSessionId ||
			currentForegroundSessionId !== cfg.ownerSessionId
		) {
			throw new Error(`daemon driver runId=${cfg.runId} is owned by a different foreground session`);
		}
	};

	const resolveRecoveryDispatchAuthority = (
		ctx: ExtensionContext,
		epoch: number,
		ownerSessionId: string | undefined,
	): RecoveryDispatchAuthority | undefined => {
		const foregroundContext = currentForegroundContext;
		if (
			ownerSessionId === undefined ||
			epoch !== recoveryAuthorityEpoch ||
			currentForegroundSessionId !== ownerSessionId ||
			exactSessionId(ctx) !== ownerSessionId ||
			foregroundContext === undefined ||
			exactSessionId(foregroundContext) !== ownerSessionId
		) return undefined;
		return { epoch, ownerSessionId, context: foregroundContext };
	};

	const assertRecoveryAuthority = (authority: RecoveryDispatchAuthority): void => {
		if (!resolveRecoveryDispatchAuthority(authority.context, authority.epoch, authority.ownerSessionId)) {
			throw new RecoveryAuthorityLostError();
		}
	};

	const invalidateOwnedRecoveryDescriptors = (): void => {
		for (const run of listRuns()) {
			if (!hasLocalRunAuthority(run) || !run.recoveryDescriptors) continue;
			run.recoveryDescriptors.clear();
			run.recoveryDescriptors = undefined;
		}
	};

	const escalationUI = (): EscalationSurfaceUI | undefined => {
		const ctx = currentForegroundContext;
		if (!ctx?.hasUI) return undefined;
		return {
			select: (title, options) => ctx.ui.select(title, options),
			input: (title, placeholder) => ctx.ui.input(title, placeholder),
		};
	};

	const midLevelEscalationTarget = (request: EscalationRequest): {
		run: DelegateDispatchState;
		forkName: string;
	} | undefined => {
		const holder = request.chain[request.holderIndex];
		if (!holder || (holder.kind !== "supervisor" && holder.kind !== "agent")) return undefined;
		let runId = holder.runId;
		let childIndex: number | undefined;
		if (holder.lineagePath) {
			const match = /\/([^/#]+)#(\d+)$/.exec(holder.lineagePath);
			if (match) {
				runId ??= match[1];
				childIndex = Number.parseInt(match[2]!, 10);
			}
		}
		if (!runId) return undefined;
		const run = getRun(runId);
		if (!run || run.shape !== "supervised" || run.completedAt !== undefined || !hasLocalRunAuthority(run) || !run.steer) return undefined;
		const names = Object.keys(run.forks);
		const forkName = childIndex === undefined ? names[0] : names[childIndex];
		if (!forkName || !isLiveStatus(run.forks[forkName]?.status ?? "completed")) return undefined;
		return { run, forkName };
	};

	const deliverCanonicalEscalation = (
		request: EscalationRequest,
		message: EscalationPendingMessage,
	): Promise<boolean> => deliverEscalationToHolder(request, message, {
		delivered: deliveredEscalationHops,
		agentDir: getAgentDir(),
		ui: escalationUI,
		// The prompt is rendered in pi's editor container, which sits
		// *underneath* the transcript inspector when that overlay is
		// mounted. Left alone, the operator gets a question they cannot see
		// and an inspector that has stopped answering keys. So the inspector
		// is hidden for the duration and restored afterwards, which is why
		// this goes through `withOverlayHidden` rather than calling
		// `drainUserEscalations` directly. Hidden, not closed: the operator
		// keeps their scroll position and selection across a question they
		// did not ask for.
		promptUser: (ui) => {
			const promptUser = () => drainUserEscalations({
				agentDir: getAgentDir(),
				ui,
				claimedBy: `native-ui:${currentForegroundSessionId ?? `pid-${process.pid}`}`,
				rootRunId: request.rootRunId,
				requestIds: [request.requestId],
			});
			return overlayHandle ? overlayHandle.withOverlayHidden(promptUser) : promptUser();
		},
		steerMidLevel: async (pending) => {
			const target = midLevelEscalationTarget(request);
			if (!target) return false;
			await target.run.steer!(target.forkName, pending.content, { deliverAs: "followUp" });
			return true;
		},
		wakeRoot: (pending) => deliverWakeMessage(pi, pending),
	});

	const deliverDurableEscalations = async (rootRunIds?: readonly string[]): Promise<void> => {
		const candidateRoots = rootRunIds ?? listEscalationRootRunIds(getAgentDir());
		// Unlike an owner-stamped wake, a bare durable request has no foreground
		// owner field. Fail closed unless the live runtime proves this process and
		// foreground session own the root (invariant 5).
		const roots = candidateRoots.filter((rootRunId) => {
			const run = getRun(rootRunId);
			return Boolean(
				run &&
				run.completedAt === undefined &&
				hasLocalRunAuthority(run) &&
				currentForegroundSessionId !== undefined &&
				run.ownerSessionId === currentForegroundSessionId,
			);
		});
		for (const item of listHeldEscalations({ agentDir: getAgentDir() })) {
			if (!roots.includes(item.rootRunId)) continue;
			// This scan is the no-wake recovery seam for manual/auto forwards.
			const durable = readHeldEscalationRequest({
				agentDir: getAgentDir(),
				rootRunId: item.rootRunId,
				requestId: item.requestId,
			});
			if (durable) {
				const holder = durable.chain[durable.holderIndex];
				await deliverCanonicalEscalation(durable, buildEscalationPendingMessage({
					rootRunId: durable.rootRunId,
					requestId: durable.requestId,
					holderId: holder.id,
					kind: durable.kind,
				}));
			}
		}
	};

	const queueEscalationDelivery = (rootRunIds?: readonly string[]): void => {
		escalationDeliveryTail = escalationDeliveryTail
			.then(() => deliverDurableEscalations(rootRunIds))
			.catch((error) => {
				logDelegateDiagnostic(`escalation delivery failed: ${diagnosticErrorText(error)}`, { agentDir: getAgentDir(), level: "warn" });
			});
	};

	const queueEscalationService = (
		sink: NotifyCompletionSink,
		opts: { advance?: boolean; label: string },
	): void => {
		escalationDeliveryTail = escalationDeliveryTail.then(async () => {
			// Durable state may already justify the tools before any wake lands.
			assertControlVisibilityHook();
			await redeliverEscalationWakes({
				agentDir: getAgentDir(),
				currentSessionId: currentForegroundSessionId,
				deliver: deliverCanonicalEscalation,
			});
			deliverPendingDispatchWakes(sink, getAgentDir(), {
				currentSessionId: currentForegroundSessionId,
			});
			const roots = listEscalationRootRunIds(getAgentDir());
			if (opts.advance) {
				for (const rootRunId of roots) advanceEscalations({ agentDir: getAgentDir(), rootRunId });
			}
			await deliverDurableEscalations(roots);
		}).catch((error) => {
			logDelegateDiagnostic(`${opts.label} escalation service failed: ${diagnosticErrorText(error)}`, { agentDir: getAgentDir(), level: "warn" });
		});
	};

	const executeDelegateTool = async (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
		recoveryAuthorityGuard?: () => void,
	) => {
		recoveryAuthorityGuard?.();
		// Pi supplies a fresh ExtensionContext for each callback. Capture stable
		// session identity plus the lifecycle epoch before any asynchronous work.
		const recoveryInvocationOwner = exactSessionId(ctx);
		const ownerSessionId = isDelegateOwnedExtensionApi(pi)
			? recoveryInvocationOwner
			: currentForegroundSessionId;
		const recoveryInvocationEpoch = recoveryAuthorityEpoch;
		// Capture before any run entry enters runWithDepth. Later failure/completion
		// callbacks must trigger the originator in this recipient context.
		const wakeSink = bindWakeSinkToCurrentContext(pi);
		// Execution ingress (spec §4, consumer 2). The model ingress already ran
		// `prepareArguments`, and the normalizer is idempotent, so this pass exists
		// for direct/internal callers (tests, runtime API, future callers) that
		// bypass pi-ai's validator.
		//
		// It must be NON-DESTRUCTIVE. Only a canonical `runs[]` request is compiled
		// here; every other shape is handed to the legacy router untouched. Running
		// the closed internal validator over every internal call turned previously
		// valid dispatches into hard errors, because internal callers legitimately
		// pass runner-level shapes the advertised contract does not describe.
		// Recover provider-stringified array params BEFORE the runs check, so a
		// JSON-encoded `runs` (the same Opus-style quirk handled below for the
		// legacy keys) still reaches the compiler instead of falling through to
		// the legacy router and dying as "unknown shape".
		{
			const coerceNotes = coerceStringifiedArrayParams(params);
			if (coerceNotes.length > 0) {
				logDelegateDiagnostic(
					`recovered stringified params: ${coerceNotes.join("; ")}. ` +
						"Provider emitted an array param as a JSON-encoded string — " +
						"likely a Claude Opus 4.x quirk on anyOf-style tool schemas.",
					{ agentDir: getAgentDir() },
				);
			}
		}
		try {
			assertNoRemovedArtifactFieldsAtIngress(params);
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `delegate: invalid request — ${(error as Error).message}` }],
				details: { forks: [] },
				isError: true,
			};
		}
		let supervisedProgressWarning = false;
		if (Array.isArray((params as Record<string, unknown>).runs)) {
			try {
				const prepared = prepareArguments(params);
				supervisedProgressWarning = hasSupervisedProgress(prepared);
				params = compileDelegateRuns(prepared);
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `delegate: invalid request — ${(error as Error).message}` }],
					details: { forks: [] },
					isError: true,
				};
			}
		}
		// Legacy/internal shapes fall through to detectShape() untouched; their
		// stringified-array recovery already ran above.

		params = stripRemovedInvocationConfig(params as Record<string, unknown>);

		// Detect the read-only health action before any agent discovery. Health has
		// its own bounded discovery seam; routing through ordinary dispatch
		// discovery first would defeat that bound.
		let shape = detectShape(params);
		if (shape === "action" && params.action === "health") {
			const report = collectDelegateHealth(
				getAgentDir(),
				currentForegroundSessionId ?? resolveOwnerSessionId(undefined),
				ctx.cwd,
				{ projectTrusted: ctx.isProjectTrusted?.() === true },
			);
			return {
				content: [{ type: "text" as const, text: formatDelegateHealth(report) }],
				details: { forks: [] as RunResult[], action: "health", health: report },
			};
		}

		const scope: AgentScope = (params.agent_scope as AgentScope) ?? "both";
		const discoveryOptions = configuredAgentDiscoveryOptions(ctx, ctx.cwd);
		const discovery = discoverAgents(ctx.cwd, scope, discoveryOptions);
		let config = loadConfigReadOnly(getAgentDir());
		// Phase D: filter builtins + apply per-agent overrides from
		// `<agentDir>/config/pi-delegate/config.json` + config.local.json.
		const overridden = applyConfiguredAgentOverrides(discovery, config);
		const agents = overridden.agents;

		// ── Phase A: shape detection ──────────────────────────────────────
		// Three accepted top-level shapes: {agents}, {tasks}, {agent,task}.
		// Direct shapes route through executeDirectShape; supervised falls
		// through to the existing pump.
		if (shape === "unknown") {
			return {
				content: [
					{
						type: "text",
						text:
							"delegate: missing one of `agents` (supervised), `tasks` (parallel direct), " +
							"`chain` / `chainName` (sequential pipeline), `agent`+`task` (single direct), " +
							"or `action` (management).",
					},
				],
				details: { forks: [] },
				isError: true,
			};
		}
		if (shape === "ambiguous") {
			return {
				content: [
					{
						type: "text",
						text:
							"delegate: run shapes are mutually exclusive — supply exactly one of " +
							"`agents`, `tasks`, `chain`, `chainName`, `orchestrate` (legacy transport), or `{agent,task}`.",
					}
				],
				details: { forks: [] },
				isError: true,
			};
		}
		if (params.retryOf !== undefined && shape !== "single-direct") {
			return {
				content: [{ type: "text", text: "retryOf is supported only on a single-direct call or its task/agent slot." }],
				details: { forks: [] },
				isError: true,
			};
		}
		if (params.retryOf !== undefined && !isValidRetryOf(params.retryOf)) {
			return {
				content: [{ type: "text", text: "retryOf must contain exactly a safe runId and non-blank forkName." }],
				details: { forks: [] },
				isError: true,
			};
		}
		const readOnlyPreflightError = validateReadOnlySlots(params as Record<string, unknown>, shape);
		if (readOnlyPreflightError) return escalationPreflightError(new Error(readOnlyPreflightError));
		if (params.escalation !== undefined && shape !== "single-direct") {
			return {
				content: [{
					type: "text",
					text: "escalation is only valid on a single-direct invocation or on each applicable slot.",
				}],
				details: { forks: [] },
				isError: true,
			};
		}

		const nestedCallerPolicy = nestedDelegatePolicyForApi(pi);
		const nestedDelegateInitialError = shape === "chain-by-name"
			? undefined
			: validateNestedDelegateAgentPolicy(
				nestedCallerPolicy,
				shape,
				params,
			) ?? validateNestedDelegateConfinement(
				nestedCallerPolicy,
				shape,
				params,
				ctx.cwd,
			);
		if (nestedDelegateInitialError) {
			return {
				content: [{ type: "text" as const, text: nestedDelegateInitialError }],
				details: { forks: [] },
				isError: true,
			};
		}

		// Nested workers receive `delegate` only through an explicit opt-in policy.
		// Keep agent/chain file mutation as a foreground/orchestrator surface: a
		// worker must not be able to persist a same-name shadow agent or mint a new
		// nested-delegation policy that outlives the parent grant. Read-only action
		// modes (`list`, `get`, `health`) remain available for diagnostics.
		if (
			shape === "action" &&
			isDelegateOwnedExtensionApi(pi) &&
			(params.action === "create" ||
				params.action === "update" ||
				params.action === "delete" ||
				params.action === "canonicalize")
		) {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`delegate: nested delegate workers cannot run management mutation action '${params.action}'. ` +
							"Agent/chain definition changes must be made from the foreground or driver session.",
					},
				],
				details: { forks: [] as RunResult[], action: params.action },
				isError: true,
			};
		}

		// ── Phase C: management actions ────────────────────────────────────
		// `delegate({action: ...})` reads/writes agent + chain definition
		// files. No worker session, no run pump. Returns the formatted
		// tool result directly. Routes to `agent-management.ts`.
		if (shape === "action") {
			const result = handleManagementAction(
				params.action as string,
				{
					action: params.action as string,
					agent: typeof params.agent === "string" ? params.agent : undefined,
					chainName: typeof params.chainName === "string" ? params.chainName : undefined,
					agentScope: typeof params.agent_scope === "string" ? params.agent_scope : undefined,
					config: params.config,
				},
				{ cwd: ctx.cwd, discoveryOptions },
			);
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: {
					forks: [] as RunResult[],
					action: result.details?.action,
					managementResult: result.details,
				},
				isError: result.isError === true,
			};
		}

		// ── Phase C: chain-by-name resolution ──────────────────────────────
		// `delegate({chainName: "my-chain"})` resolves a saved `.chain.md`
		// template to a steps array and falls through to the chain-mode
		// path below. Lifted here so the chain-resolution is visible
		// before the supervised/direct shape checks consume params.
		if (shape === "chain-by-name") {
			const chainName = (typeof params.chainName === "string" ? params.chainName : params.chain as string).trim();
			const candidates = discoverChains(ctx.cwd, discoveryOptions);
			const resolution = resolveSavedChainPlan(chainName, candidates);
			if (resolution.ok === false) {
				const available = resolveByScopePrecedence(candidates)
					.map((candidate) => `${candidate.name} (${candidate.source})`)
					.join(", ") || "none";
				return {
					content: [
						{
							type: "text" as const,
							text:
								resolution.code === "not-found" && resolution.referencePath === undefined
									? `${resolution.message} Available: ${available}.`
									: resolution.message,
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}
			// Recursive resolution returns ordinary runtime worker steps with
			// internal task-scope annotations. The chain executor therefore uses
			// one run and one chainDir rather than consuming delegation depth.
			const steps = resolution.steps;
			// Replace the chainName-only params with a resolved chain
			// array so the rest of execute() sees a normal "chain" shape.
			// We mutate `params` (and `shape`) instead of `return`-ing
			// here so the rest of execute() handles the chain just like
			// any inline `chain: [...]` invocation.
			params = { ...params, chain: steps, chainName: undefined } as any;
			shape = "chain";
			const chainReadOnlyPreflightError = validateReadOnlySlots(params as Record<string, unknown>, shape);
			if (chainReadOnlyPreflightError) return escalationPreflightError(new Error(chainReadOnlyPreflightError));
		}

		// A saved chain is executable input. Validate every native command stage
		// before nested policy can reject a later concern, and before any run or
		// worker state is registered.
		if (shape === "chain") {
			try {
				const chainCwd = resolveChildCwd(ctx.cwd, params.cwd as string | undefined);
				for (const step of params.chain as ChainStep[]) {
					if (isRunStep(step)) prepareSavedChainRunStep(step, chainCwd);
				}
			} catch (error) {
				return escalationPreflightError(error);
			}
		}

		const nestedDelegateError = validateNestedDelegateAgentPolicy(
			nestedCallerPolicy,
			shape,
			params,
		) ?? validateNestedDelegateConfinement(
			nestedCallerPolicy,
			shape,
			params,
			ctx.cwd,
		);
		if (nestedDelegateError) {
			return {
				content: [{ type: "text" as const, text: nestedDelegateError }],
				details: { forks: [] },
				isError: true,
			};
		}

		// ── Orchestrate shape (spec 0005) ──────────────────────────────────
		// `delegate({ orchestrate: { agent, task, ... } })` forks a clone-of-self
		// as a DETACHED child process that drives a long-running pipeline. It
		// returns a `dispatched` envelope immediately and is immune to this
		// session's lifecycle. The shape hosts ANY agent (graft-orchestrator is
		// the first consumer) — it does NOT hardcode graft (REQ-ORCH-7).
		if (shape === "orchestrate") {
			// HARDENING (MR !2 review finding #7): orchestrate is ALWAYS detached +
			// async (returns a dispatched envelope immediately) and never runs in a
			// worktree — silently ignoring these top-level params would let a caller
			// believe `await: true` blocks or `worktree: true` isolates. Hard error,
			// matching the other shapes' incompatible-param validation.
			if (hasUnsupportedOrchestrateOptions(params)) {
				return {
					content: [
						{
							type: "text",
							text:
								"delegate driver: `await`, deprecated `sync`, and `worktree` are not supported — " +
								"a driver run is always detached (async) and never uses a worktree.",
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}
			const orch = params.orchestrate as {
				agent?: unknown;
				name?: unknown;
				task?: unknown;
				checklist?: unknown;
				focus?: unknown;
				model?: unknown;
				env?: EnvOverrides;
				maxSubagentDepth?: unknown;
			};
			if (typeof orch?.agent !== "string" || orch.agent.trim() === "") {
				return {
					content: [{ type: "text", text: "delegate driver: `agent` (string) is required." }],
					details: { forks: [] },
					isError: true,
				};
			}
			if (typeof orch.task !== "string" || orch.task.trim() === "") {
				return {
					content: [{ type: "text", text: "delegate driver: `task` (string) is required." }],
					details: { forks: [] },
					isError: true,
				};
			}
			let requestedMaxSubagentDepth: number | undefined;
			if (Object.prototype.hasOwnProperty.call(orch, "maxSubagentDepth")) {
				try {
					if (typeof orch.maxSubagentDepth !== "number") {
						throw new TypeError(
							`maxSubagentDepth must be a number; received ${String(orch.maxSubagentDepth)}`,
						);
					}
					requestedMaxSubagentDepth = validateMaxSubagentDepth(orch.maxSubagentDepth);
					if (requestedMaxSubagentDepth > HARD_MAX_DEPTH) {
						throw new RangeError(
							`maxSubagentDepth cannot exceed the hard ceiling ${HARD_MAX_DEPTH}; received ${requestedMaxSubagentDepth}`,
						);
					}
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `delegate driver: invalid \`maxSubagentDepth\` — ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						details: { forks: [] },
						isError: true,
					};
				}
			}
			const orchAgent = resolveAgent(agents, orch.agent);
			if (!orchAgent) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text:
								`Unknown agent: ${orch.agent}. Available: ${available}` +
								(discovery.warnings.length
									? `\nDiscovery warnings:\n${discovery.warnings.map((warning) => `- ${warning}`).join("\n")}`
									: ""),
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}
			const projectTrustFailure = projectTrustPreflight([orchAgent], ctx);
			if (projectTrustFailure) return projectTrustFailure;
			const orchTasks = parseSlotTasks(normalizeTaskSeedWire(orch.checklist));
			const orchestrated = await executeOrchestrateShape({
				pi,
				input: {
					agent: orch.agent,
					...(typeof orch.name === "string" && orch.name.length > 0 ? { name: orch.name } : {}),
					...(orchTasks ? { tasks: orchTasks } : {}),
					...(orch.focus !== undefined ? { focus: orch.focus } : {}),
					// pi-daemon owns the durable session; task seeding beyond the prompt
					// remains represented in the cfg for the session-configuration migration.
					task: orch.focus
						? appendFocusToPrompt(orch.task, orch.focus, { cwd: ctx.cwd })
						: orch.task,
					...(typeof orch.model === "string" ? { model: orch.model } : {}),
					...(orch.env !== undefined ? { env: orch.env } : {}),
					...(requestedMaxSubagentDepth !== undefined
						? { maxSubagentDepth: requestedMaxSubagentDepth }
						: {}),
				},
				agent: orchAgent,
				ctx,
				toolCallId,
				agentDir: getAgentDir(),
				signal,
				ownerSessionId,
				daemon: true,
			});
			if (!orchestrated.isError) revealDeferredTools(["delegate_control"]);
			return orchestrated;
		}

		let shouldAwait: boolean;
		try {
			shouldAwait = resolveAwaitMode(params);
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: (error as Error).message }],
				details: { forks: [] as RunResult[] },
				isError: true,
			};
		}
		if (shape === "single-direct" || shape === "parallel-direct") {
			const rawTasks =
				shape === "single-direct"
					? [
							{
								// A canonical single solo run may request a name, and the
								// forkName is the key for receipts, steering and cancel.
								// Hardcoding undefined here dropped it and the run entry fell
								// back to the agent name.
								name: params.name,
								agent: params.agent,
								task: params.task,
								checklist: params.checklist,
								...(params.focus !== undefined ? { focus: params.focus } : {}),
								cwd: params.cwd,
								artifact: params.artifact,
								check: params.check,
								reads: params.reads,
								parentTranscriptSearch: params.parentTranscriptSearch,
								progress: params.progress,
								model: params.model,
								thinking: params.thinking,
								thinkingMin: params.thinkingMin,
								thinkingMax: params.thinkingMax,
								fallbackModels: params.fallbackModels,
								maxSubagentDepth: params.maxSubagentDepth,
								skill: params.skill,
								skills: params.skills,
								interactive: params.interactive,
								writableRoots: params.writableRoots,
								confineWrites: params.confineWrites,
								readOnly: params.readOnly,
								env: params.env,
								retryOf: params.retryOf,
								escalation: params.escalation,
								// #287: the wall-clock budget travels with the slot. This
								// list is an explicit allowlist, so a field omitted here is
								// silently dropped before it can ever be armed.
								max_duration_ms: params.max_duration_ms,
								wind_down_grace_ms: params.wind_down_grace_ms,
								// A canonical single run may request solo fan-out. Hardcoding
								// 1 silently gave the caller one worker instead of the copies
								// they asked for. Legacy single-direct callers supply no
								// count and still get exactly one.
								count: typeof params.count === "number" && params.count > 0 ? params.count : 1,
							},
						]
					: params.tasks;
			const repeatedRetry = rawTasks.find((task: (typeof rawTasks)[number]) => task.retryOf !== undefined && typeof task.count === "number" && task.count > 1);
			if (repeatedRetry) {
				return {
					content: [{ type: "text", text: "retryOf cannot be combined with count > 1." }],
					details: { forks: [] },
					isError: true,
				};
			}

			// Resolve agent names → AgentConfigs up-front so unknowns fail
			// fast with a useful "available: …" message.
			const unknownNames = rawTasks
				.map((t: any) => t.agent)
				.filter((name: any) => typeof name === "string" && !resolveAgent(agents, name));
			if (unknownNames.length > 0) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text:
								`Unknown agent(s): ${unknownNames.join(", ")}. Available: ${available}` +
								(discovery.warnings.length
									? `\nDiscovery warnings:\n${discovery.warnings.map((warning) => `- ${warning}`).join("\n")}`
									: ""),
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}

			const resolvedRawTasks = rawTasks.map((t: (typeof rawTasks)[number]) => ({
				...t,
				agent: resolveAgent(agents, t.agent)!,
				writableRoots: resolveWritableRoots(ctx.cwd, t.writableRoots),
				// The one place the wire's loose `checklist` becomes the internal
				// `tasks`, per the snake_case boundary above.
				tasks: parseSlotTasks(normalizeTaskSeedWire(t.checklist)),
				focus: t.focus,
				// #287: resolve the solo wall-clock budget at the dispatch boundary,
				// through the same precedence supervised forks use (invocation wins
				// over the agent file, which wins over config; a positive operator
				// ceiling clamps them all). `runDirectWorker` arms enforcement when the
				// first worker session becomes steerable, before extension binding and
				// prompt delivery.
				timeoutPolicy: resolveRunTimeoutPolicy({
					global: {
						maxDurationMs: config.perForkMaxDurationMs,
						windDownGraceMs: config.windDownGraceMs,
						minDurationMs: config.perForkMinDurationMs,
						enforceWallClockBudget: config.enforceWallClockBudget,
					},
					agent: resolveAgent(agents, t.agent)!,
					invocation: {
						maxDurationMs: t.max_duration_ms,
						windDownGraceMs: t.wind_down_grace_ms,
					},
				}),
			}));
			const expandedUnresolved = expandParallelTasks({
				rawTasks: resolvedRawTasks,
			});
			let expanded: Array<DirectTaskInput & { escalationPolicy: EffectiveEscalationPolicy }>;
			try {
				const policies = resolvedRawTasks.flatMap((task) => {
					const policy = resolveSlotEscalationPolicy({
						shape: shape === "single-direct" ? "direct" : "parallel-direct",
						config,
						agent: task.agent,
						invocationValue: task.escalation,
						fieldPath: shape === "single-direct" ? "escalation" : `tasks[${task.name ?? task.agent.name}].escalation`,
					});
					return Array.from({ length: Math.max(1, Math.floor(task.count ?? 1)) }, () => policy);
				});
				expanded = expandedUnresolved.map((task, index) => ({
					...task,
					escalationPolicy: policies[index]!,
				}));
				assertAwaitEscalationCompatibility({
					awaitRequested: shouldAwait,
					slots: expanded.map((task) => ({ name: task.name, policy: task.escalationPolicy })),
				});
			} catch (error) {
				return escalationPreflightError(error);
			}
			const sync = shouldAwait;

			const projectTrustFailure = projectTrustPreflight(
				expanded.map((task) => task.agent),
				ctx,
			);
			if (projectTrustFailure) return projectTrustFailure;
			const mainModel = ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined;
			const scopedModelRefs = modelScopeFromExtensionContext(ctx, getAgentDir());
			const plannedModels = planWorkerModelRequests(
				ctx.modelRegistry,
				expanded,
				{ mainModel, scope: scopedModelRefs },
			);
			if (plannedModels.kind === "failure") {
				return {
					content: [{ type: "text" as const, text: plannedModels.failure.message }],
					details: { forks: [] as RunResult[] },
					isError: true,
				};
			}
			expanded = plannedModels.requests;
			await warmPlannedProviderAuth({
				requests: plannedModels.requests,
				modelRegistry: ctx.modelRegistry,
				signal,
				onDiagnostic: (message) => logDelegateDiagnostic(message, {
					agentDir: getAgentDir(),
					level: "warn",
				}),
			});
			const concurrency = Math.max(
				1,
				Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, expanded.length),
			);
		{
				recoveryAuthorityGuard?.();
				const directNotifyOnFailure = params.notifyOnFailure ?? config.notifyOnFailure ?? true;
				const directRecoveryAuthority = resolveRecoveryDispatchAuthority(
					ctx,
					recoveryInvocationEpoch,
					recoveryInvocationOwner,
				);
				// Compute the recovery runId early (same formula executeDirectShape will use).
				const directRecoveryRunId = deriveRunId(toolCallId);
				// Build raw invocation captures for recovery descriptors: one per expanded task.
				// Each expanded task maps back to its source rawTask for model/thinking/etc. overrides.
				const expandedRawCaptures: typeof resolvedRawTasks = [];
				for (const raw of resolvedRawTasks) {
					const repeats = Math.max(1, Math.floor((raw as any).count ?? 1));
					for (let i = 0; i < repeats; i++) expandedRawCaptures.push(raw);
				}
				// Capture top-level settings for faithful recovery redispatch.
				const directTopLevelSettings = captureRecoveryTopLevelSettings({
					worktree: params.worktree ?? false,
					agent_scope: scope,
					notifyOnFailure: directNotifyOnFailure,
				});

				// Create per-entry recovery descriptors — ALWAYS, regardless of notifyOnFailure.
				// notifyOnFailure only controls whether early-wake notifications fire; it does
				// not destroy recovery capability. A caller can still recover after reading the
				// aggregate, even when early wakes are disabled.
				const directRecoveryDescriptors = new Map<string, RunRecoveryDescriptor>();
				for (let i = 0; directRecoveryAuthority !== undefined && i < expanded.length; i++) {
					const capturedName = expanded[i]!.name;
					const capturedRaw = expandedRawCaptures[i]!;
					const capturedRunId = directRecoveryRunId;
					directRecoveryDescriptors.set(capturedName, buildDirectRecoveryDescriptor({
						forkName: capturedName,
						runId: capturedRunId,
						slotParams: {
							agent: capturedRaw.agent.name,
							task: capturedRaw.task,
							name: capturedName,
							...(capturedRaw.cwd !== undefined ? { cwd: capturedRaw.cwd } : {}),
							...(capturedRaw.artifact !== undefined ? { artifact: capturedRaw.artifact } : {}),
							...(capturedRaw.check !== undefined ? { check: capturedRaw.check } : {}),
							...(capturedRaw.reads !== undefined ? { reads: capturedRaw.reads } : {}),
							...(capturedRaw.parentTranscriptSearch !== undefined ? { parentTranscriptSearch: capturedRaw.parentTranscriptSearch } : {}),
							...(capturedRaw.progress !== undefined ? { progress: capturedRaw.progress } : {}),
							...(capturedRaw.focus !== undefined ? { focus: capturedRaw.focus } : {}),
							...(capturedRaw.interactive !== undefined ? { interactive: capturedRaw.interactive } : {}),
							...(capturedRaw.writableRoots !== undefined ? { writableRoots: capturedRaw.writableRoots } : {}),
							...(capturedRaw.confineWrites !== undefined ? { confineWrites: capturedRaw.confineWrites } : {}),
							...(capturedRaw.readOnly !== undefined ? { readOnly: capturedRaw.readOnly } : {}),
							...(capturedRaw.env !== undefined ? { env: capturedRaw.env } : {}),
							...(capturedRaw.model !== undefined ? { model: capturedRaw.model } : {}),
							...(capturedRaw.thinking !== undefined ? { thinking: capturedRaw.thinking } : {}),
							...(capturedRaw.thinkingMin !== undefined ? { thinkingMin: capturedRaw.thinkingMin } : {}),
							...(capturedRaw.thinkingMax !== undefined ? { thinkingMax: capturedRaw.thinkingMax } : {}),
							...(capturedRaw.fallbackModels !== undefined ? { fallbackModels: capturedRaw.fallbackModels } : {}),
							...(capturedRaw.skill !== undefined ? { skill: capturedRaw.skill } : {}),
							...(capturedRaw.skills !== undefined ? { skills: capturedRaw.skills } : {}),
							...(capturedRaw.escalation !== undefined ? { escalation: capturedRaw.escalation } : {}),
							// #287: the retry inherits the original wall-clock budget. This
							// is another explicit allowlist, so an omission here loses the
							// limit silently on exactly the run most likely to need it.
							...(capturedRaw.max_duration_ms !== undefined ? { max_duration_ms: capturedRaw.max_duration_ms } : {}),
							...(capturedRaw.wind_down_grace_ms !== undefined ? { wind_down_grace_ms: capturedRaw.wind_down_grace_ms } : {}),
						},
						topLevelSettings: directTopLevelSettings,
						getLiveFork: (forkName) => getRun(capturedRunId)?.forks[forkName],
						dispatchFn: (recoveryParams, recoveryCallId) =>
							dispatchRecoveryChild(recoveryParams, recoveryCallId, directRecoveryAuthority),
					}));
				}
				return executeDirectShape({
					pi,
					mode: shape,
					tasks: expanded,
					concurrency,
					worktree: params.worktree ?? false,
					sync,
					signal,
					ctx,
					toolCallId,
					onUpdate,
					config,
					agentDir: getAgentDir(),
					ensureWorkerToolRegistration,
					parentTranscriptEntries: expanded.some((task) => task.parentTranscriptSearch)
						? ctx.sessionManager.getBranch()
						: undefined,
					getWorkerToolDefinitions,
					ownerSessionId,
					notifyOnFailure: directNotifyOnFailure,
					recoveryDescriptors: directRecoveryDescriptors.size > 0 ? directRecoveryDescriptors : undefined,
				});
			}
		}

		if (shape === "chain") {
			const chainTask = (params.task as string | undefined) ?? "";
			const chainCwd = resolveChildCwd(ctx.cwd, params.cwd as string | undefined);
			const chainDirOverride = (params.chainDir as string | undefined) ?? undefined;
			let preparedSteps: ChainStep[];
			const chainPolicySlots: Array<{ name: string; policy: EffectiveEscalationPolicy }> = [];
			try {
				preparedSteps = (params.chain as ChainStep[]).map((step, stepIndex) => {
					if (isRunStep(step)) return step;
					if ("parallel" in step) {
						return {
							...step,
							parallel: step.parallel.map((slot, slotIndex) => {
								const name = `chain step ${stepIndex + 1}.${slotIndex + 1} (${slot.name ?? slot.agent})`;
								const policy = resolveSlotEscalationPolicy({
									shape: "chain",
									config,
									agent: resolveAgent(agents, slot.agent),
									invocationValue: "escalation" in slot ? slot.escalation : undefined,
									fieldPath: `chain[${stepIndex}].parallel[${slotIndex}].escalation`,
								});
								chainPolicySlots.push({ name, policy });
								return {
									...slot,
									writableRoots: resolveWritableRoots(ctx.cwd, slot.writableRoots),
									confineWrites: slot.confineWrites,
									escalationPolicy: policy,
								};
							}),
						};
					}
					const name = `chain step ${stepIndex + 1} (${step.agent})`;
					const policy = resolveSlotEscalationPolicy({
						shape: "chain",
						config,
						agent: resolveAgent(agents, step.agent),
						invocationValue: "escalation" in step ? step.escalation : undefined,
						fieldPath: `chain[${stepIndex}].escalation`,
					});
					chainPolicySlots.push({ name, policy });
					return {
						...step,
						writableRoots: resolveWritableRoots(ctx.cwd, step.writableRoots),
						confineWrites: step.confineWrites,
						escalationPolicy: policy,
					};
				});
				assertAwaitEscalationCompatibility({
					awaitRequested: shouldAwait,
					slots: chainPolicySlots,
				});
			} catch (error) {
				return escalationPreflightError(error);
			}
			const sync = shouldAwait;
			// Only accepted invocations may migrate legacy config or emit parser diagnostics.
			config = loadConfig(getAgentDir());
			const stepAgentNames: string[] = [];
			for (const step of preparedSteps) {
				if (isRunStep(step)) continue;
				if (isParallelStep(step)) {
					for (const slot of step.parallel) stepAgentNames.push(slot.agent);
				} else {
					stepAgentNames.push(step.agent);
				}
			}
			const hasProjectRunStage = preparedSteps.some((step) =>
				isRunStep(step) && savedChainContextForStep(step)?.scopePath.some((scope) => scope.source === "project"),
			);
			if (hasProjectRunStage && ctx.isProjectTrusted?.() !== true) {
				return escalationPreflightError(
					new Error("Project-local saved-chain run stages require a trusted project."),
				);
			}
			const projectTrustFailure = projectTrustPreflight(
				stepAgentNames
					.map((name) => resolveAgent(agents, name))
					.filter((agent): agent is AgentConfig => Boolean(agent)),
				ctx,
			);
			if (projectTrustFailure) return projectTrustFailure;
			return executeChainShape({
				pi,
				steps: preparedSteps,
				agents,
				discoveryWarnings: discovery.warnings,
				chainTask,
				scope,
				chainCwd,
				chainDirOverride,
				sync,
				signal,
				ctx,
				toolCallId,
				onUpdate,
				config,
				agentDir: getAgentDir(),
				parentTranscriptEntries: preparedSteps.some((step) =>
					isParallelStep(step)
						? step.parallel.some((slot) =>
							resolveParentTranscriptSearch(slot.parentTranscriptSearch, resolveAgent(agents, slot.agent)),
						)
						: !isRunStep(step) &&
							resolveParentTranscriptSearch(step.parentTranscriptSearch, resolveAgent(agents, step.agent)),
				)
					? ctx.sessionManager.getBranch()
					: undefined,
				ensureWorkerToolRegistration,
				getWorkerToolDefinitions,
				ownerSessionId,
				notifyOnFailure: params.notifyOnFailure ?? config.notifyOnFailure ?? true,
			});
		}

		// ── shape === "supervised" — existing pumpRuns path ───────────────
		// ── Validation ─────────────────────────────────────────────────────
		const unknown = params.agents
			.map((a: any) => a.agent)
			.filter((name: string) => !resolveAgent(agents, name));
		if (unknown.length > 0) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text:
							`Unknown agent(s): ${unknown.join(", ")}. Available: ${available}` +
							(discovery.warnings.length
								? `\nDiscovery warnings:\n${discovery.warnings.map((warning) => `- ${warning}`).join("\n")}`
								: ""),
					},
				],
				details: { forks: [] },
				isError: true,
			};
		}

		// `config` was loaded at the top of execute() — heartbeat knobs
		// below resolve against it.

		// Uniqueness of entry NAMES. This is the addressing key: predictable,
		// caller-guessable, and unchanged by the display label computed below.
		const labels = new Map<string, number>();
		/** Parallel to `resolvedReqs`: whether the caller supplied `name:`. */
		const namedSlots: boolean[] = [];
		let resolvedReqs: ForkRequest[];
		// Parallel array: raw agent-slot params captured for recovery descriptors.
		const rawAgentSlots: any[] = [];
		try {
			resolvedReqs = params.agents.map((a) => {
				rawAgentSlots.push(a);
				const baseAgent = resolveAgent(agents, a.agent)!;
				// Invocation overrides are worker-only and ephemeral: patch a cloned
				// effective AgentConfig for this ForkRequest without mutating discovery,
				// durable delegate.agentOverrides, or sibling forks. The clone preserves
				// base identity/source so the project-trust gate below still checks the
				// discovered agent, not any invocation-level runtime fields.
				const agent = applyInvocationOverrides(baseAgent, invocationOverridesFromSlot(a));
				let label = a.name ?? baseAgent.name;
				const count = (labels.get(label) ?? 0) + 1;
				labels.set(label, count);
				if (count > 1) label = `${label}#${count}`;
				namedSlots.push(a.name !== undefined);
				const cloneMode: CloneMode = (a.clone_mode as CloneMode) ?? "full";
				const taskDelivery = a.task_delivery;
				const maxRounds = a.max_rounds ?? baseAgent.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS;
				const collapseMode = (a.collapse_mode as "final_output" | "summary") ?? baseAgent.collapseMode ?? "final_output";
				const heartbeatConfig = resolveHeartbeatConfig(a, {
					intervalMs: config.heartbeatIntervalMs,
					maxConsecutive: config.maxConsecutiveHeartbeats,
				});
				const timeoutPolicy = resolveRunTimeoutPolicy({
					global: {
						maxDurationMs: config.perForkMaxDurationMs,
						windDownGraceMs: config.windDownGraceMs,
						minDurationMs: config.perForkMinDurationMs,
						enforceWallClockBudget: config.enforceWallClockBudget,
					},
					agent: baseAgent,
					invocation: {
						maxDurationMs: a.max_duration_ms,
						windDownGraceMs: a.wind_down_grace_ms,
					},
				});
				return {
					name: label,
					...(a.retryOf !== undefined ? { retryOf: a.retryOf } : {}),
					agent,
					task: a.task,
					cloneMode,
					taskDelivery,
					snippetLastN: a.snippet_last_n,
					// The one place the wire's loose `checklist` becomes the
					// internal `tasks`, per the snake_case boundary above.
					tasks: parseSlotTasks(normalizeTaskSeedWire(a.checklist)),
					focus: a.focus,
					parentTranscriptSearch: a.parentTranscriptSearch ?? baseAgent.parentTranscriptSearch ?? false,
					maxRounds,
					timeoutPolicy,
					collapseMode,
					summaryModelRef: a.summary_model,
					supervisorInstructions: a.supervisor_instructions,
					cwd: a.cwd,
					interactive: a.interactive ?? false,
					writableRoots: resolveWritableRoots(ctx.cwd, a.writableRoots),
					confineWrites: a.confineWrites,
					readOnly: a.readOnly,
					heartbeatIntervalMs: heartbeatConfig.intervalMs,
					maxConsecutiveHeartbeats: heartbeatConfig.maxConsecutive,
					heartbeatTailLines: config.heartbeatTailLines,
					escalationPolicy: resolveSlotEscalationPolicy({
						shape: "supervised",
						config,
						agent: baseAgent,
						invocationValue: a.escalation,
						fieldPath: `agents[${label}].escalation`,
					}),
				};
			});
			assertAwaitEscalationCompatibility({
				awaitRequested: shouldAwait,
				slots: resolvedReqs.map((request) => ({
					name: request.name,
					policy: request.escalationPolicy!,
				})),
			});
		} catch (error) {
			return escalationPreflightError(error);
		}
		// Issue #152 — stamp each entry's human-facing label once, after names are
		// final. Derivation is pure and total; it can neither fail a dispatch nor
		// change `name`.
		{
			const displayLabels = computeRunEntryDisplayLabels(
				resolvedReqs.map((request, index) => ({
					name: request.name,
					named: namedSlots[index] === true,
					task: request.task,
					agentName: request.agent.name,
				})),
			);
			for (let index = 0; index < resolvedReqs.length; index++) {
				resolvedReqs[index]!.displayLabel = displayLabels[index] ?? resolvedReqs[index]!.name;
			}
		}
		const effectiveSync = shouldAwait;
		// Default-on: failure wakes fire unless the caller explicitly opts out with notifyOnFailure: false.
		const notifyOnFailure = params.notifyOnFailure ?? config.notifyOnFailure ?? true;

		// Accepted invocations may now migrate legacy config and emit parser diagnostics.
		config = loadConfig(getAgentDir());

		// ── worktree + per-entry cwd incompatibility ─────────────────
		// Strict rule: if `worktree: true` is set, NO per-entry `cwd` may be
		// supplied — even one equal to ctx.cwd. Worktree isolation owns the
		// cwd assignment for every entry.
		if (params.worktree) {
			const conflict = resolvedReqs.find((r) => r.cwd !== undefined);
			if (conflict) {
				return {
					content: [
						{
							type: "text",
							text:
								`worktree: true is incompatible with per-entry cwd. ` +
								`Entry "${conflict.name}" (${conflict.agent.name}) sets cwd=${JSON.stringify(conflict.cwd)}. ` +
								`Remove cwd from all entries or disable worktree.`,
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}
		}

		const projectTrustFailure = projectTrustPreflight(
			resolvedReqs.map((request) => request.agent),
			ctx,
		);
		if (projectTrustFailure) return projectTrustFailure;

		// ── Gather main-thread context for seeding ────────────────────────
		const mainBranchEntries = ctx.sessionManager.getBranch();
		const mainSystemPrompt = ctx.getSystemPrompt();
		const mainModel = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id }
			: undefined;
		const scopedModelRefs = modelScopeFromExtensionContext(ctx, getAgentDir());
		const plannedModels = planWorkerModelRequests(
			ctx.modelRegistry,
			resolvedReqs,
			{ mainModel, scope: scopedModelRefs },
		);
		if (plannedModels.kind === "failure") {
			return {
				content: [{ type: "text" as const, text: plannedModels.failure.message }],
				details: { forks: [] as RunResult[] },
				isError: true,
			};
		}
		resolvedReqs = plannedModels.requests;
		await warmPlannedProviderAuth({
			requests: plannedModels.requests,
			modelRegistry: ctx.modelRegistry,
			signal,
			onDiagnostic: (message) => logDelegateDiagnostic(message, {
				agentDir: getAgentDir(),
				level: "warn",
			}),
		});

		// ── Worktree setup (if requested) ─────────────────────────
		const runId = deriveRunId(toolCallId);
		const retryClaims = resolvedReqs
			.filter((request) => request.retryOf !== undefined)
			.map((request) => ({ successorForkName: request.name, successor: { runId, forkName: request.name }, retryOf: request.retryOf! }));
		let preRegisteredRunState: DelegateDispatchState | undefined;
		let preRegisteredDispatchAbort: AbortController | undefined;
		if (retryClaims.length > 0) {
			preRegisteredDispatchAbort = new AbortController();
			preRegisteredRunState = {
				runId,
				rootRunId: rootRunIdForNewRun(runId),
				ownerSessionId,
				shape: "supervised",
				notifyOnFailure,
				createdAt: Date.now(),
				detached: !effectiveSync,
				forks: Object.fromEntries(resolvedReqs.map((request) => [request.name, {
					name: request.name,
					...(request.displayLabel !== undefined ? { displayLabel: request.displayLabel } : {}),

					agent: request.agent.name,
					agentSource: request.agent.source,
					task: request.task,
					workerCwd: resolveChildCwd(ctx.cwd, request.cwd),
					...(request.agent.model ? { requestedModel: request.agent.model } : {}),
					...(request.agent.skills ? { skills: [...request.agent.skills] } : {}),
					confineWrites: request.confineWrites !== false,
					...(request.modelPlan ? { resolvedModel: request.modelPlan.primary.canonicalRef } : {}),
					status: (!effectiveSync ? "constructing" : "pending") as RunLiveStatus,
					currentRound: 0,
					maxRounds: request.maxRounds,
					cloneMode: request.cloneMode,
					collapseMode: request.collapseMode,
					...(request.timeoutPolicy ? { timeoutPolicy: request.timeoutPolicy } : {}),
					...(request.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: request.heartbeatIntervalMs } : {}),
					...(request.maxConsecutiveHeartbeats !== undefined ? { maxConsecutiveHeartbeats: request.maxConsecutiveHeartbeats } : {}),
					transcript: [],
					pendingGuidance: [],
					interactive: request.interactive ?? false,
				} satisfies RunLiveState])),
				abort: () => preRegisteredDispatchAbort!.abort(),
				steer: () => Promise.reject(new Error("steer wired below")),
				cancel: () => Promise.reject(new Error("cancel wired below")),
			};
			try {
				registerRunWithRetryClaims(preRegisteredRunState, retryClaims);
			} catch (error) {
				const rejection = retryAdmissionRejection(error);
				if (rejection) return rejection;
				throw error;
			}
			for (const request of resolvedReqs) request.attempt = preRegisteredRunState.forks[request.name]?.attempt ?? 1;
		}
		// A retry rejection returns above, before this accepted-call migration.
		config = loadConfig(getAgentDir());
		preflightSummaryModels(
			resolvedReqs,
			ctx.modelRegistry,
			scopedModelRefs,
			(message) => logDelegateDiagnostic(message, { agentDir: getAgentDir(), level: "warn" }),
		);
		let worktreeSetup: WorktreeSetup | undefined;
		if (params.worktree) {
			try {
				worktreeSetup = createWorktrees(ctx.cwd, runId, resolvedReqs.length, {
					agentDir: getAgentDir(),
					agents: resolvedReqs.map((r) => r.agent.name),
					setupHook: config.worktreeSetupHook
						? {
								hookPath: config.worktreeSetupHook,
								timeoutMs: config.worktreeSetupHookTimeoutMs,
							}
						: undefined,
				});
			} catch (err: any) {
				if (preRegisteredRunState) {
					completeRun(runId, finalizePrelaunchFailures(preRegisteredRunState, `Failed to create worktrees: ${diagnosticErrorText(err)}`, ctx.cwd));
				}
				return {
					content: [
						{
							type: "text",
							text: `Failed to create worktrees: ${err?.message ?? err}`,
						},
					],
					details: { forks: [] },
					isError: true,
				};
			}
		}
		if (preRegisteredRunState) {
			for (let index = 0; index < resolvedReqs.length; index++) {
				const request = resolvedReqs[index]!;
				const fork = preRegisteredRunState.forks[request.name];
				if (!fork) continue;
				fork.workerCwd = worktreeSetup?.worktrees[index]?.agentCwd ?? resolveChildCwd(ctx.cwd, request.cwd);
				if (worktreeSetup?.worktrees[index]) fork.workerBranch = worktreeSetup.worktrees[index]!.branch;
				if (request.modelPlan) fork.resolvedModel = request.modelPlan.primary.canonicalRef;
			}
		}

		const concurrency = Math.max(1, Math.min(params.concurrency ?? DEFAULT_CONCURRENCY, resolvedReqs.length));
		const runPumpArgs: PumpRunsArgs = {
			resolvedReqs,
			runId,
			ownerSessionId,
			worktreeSetup,
			ctxCwd: ctx.cwd,
			mainBranchEntries,
			mainModel,
			mainSystemPrompt,
			authStorage: ctx.modelRegistry.authStorage,
			allowRegistryRuntimeFallback: true,
			modelRegistry: ctx.modelRegistry,
			scopedModelRefs,
			agentDir: getAgentDir(),
			originatorEscalationConfig: config.escalation,
			signal,
			concurrency,
			fromToolCallId: toolCallId,
		};

		// ────────────────────────────────────────────────────────────────
		// Shared runtime setup (both SYNC and DISPATCH modes need the same
		// run registration, transcript plumbing, steer/cancel wiring, and
		// per-entry timeouts so the overlay + status widget + _status tool
		// see live runs either way). Previously the SYNC path skipped
		// registerRun entirely, which is why `delegate_status` and
		// the transcript overlay showed "No runs" during sync runs.
		// ────────────────────────────────────────────────────────────────
		const dispatchAbort = preRegisteredDispatchAbort ?? new AbortController();
		const forkAbortControllers: Record<string, AbortController> = {};
		for (const req of resolvedReqs) forkAbortControllers[req.name] = new AbortController();
		// Forward outer tool signal into the abort controller in SYNC
		// mode only. Dispatch needs the run to outlive the parent turn —
		// otherwise any later parent-turn abort (intercom inbound
		// message, retry, recompaction interrupt, …) would cascade into
		// detached supervised forks. See dispatch-signal.ts.
		wireSignalToDispatch(signal, dispatchAbort, { sync: effectiveSync });
		abortControllersWhenParentAborts(dispatchAbort.signal, forkAbortControllers);

		// Per-entry session refs: populated by fork-runner as sessions come
		// up; read by `steer` / `cancel` on the runtime entry.
		const sessionRefsByFork: Record<string, ForkSessionRefs> = {};
		for (const r of resolvedReqs) sessionRefsByFork[r.name] = {};

		// Per-entry absolute timers from each request's frozen timeout policy.
		const timeoutTimers: Record<string, ReturnType<typeof setTimeout>> = {};
		// Per-entry wall-clock wind-down GRACE timers. Armed after the wall-clock
		// budget elapses and the wrap-up steer fires; if the entry doesn't finish
		// within the grace window, this timer hard-cancels it when enforcement is
		// enabled. Cleared (alongside `timeoutTimers`) on any terminal transition.
		const windDownGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
		// Immutable absolute deadlines captured at first running transition.
		const timeoutDeadlines = new Map<string, number>();
		// Forks that received the wall-clock wind-down steer (REQ-WIND-5). The
		// per-run RunResult is assembled inside `pumpRuns` (fork-runner.ts),
		// which only knows about the heartbeat wind-down (via WorkerChannel) — the
		// wall-clock steer lives here in index.ts's run loop, so we track the
		// provenance in this parallel set and stamp `steered=true` onto the matching
		// results after the pump returns (both clean-finish-in-grace and
		// timeout-cancel-after-grace land in the same set, since the steer fired
		// either way).
		const windDownSteeredRuns = new Set<string>();
		const clearTimeoutFor = (forkName: string) => {
			const t = timeoutTimers[forkName];
			if (t) {
				clearTimeout(t);
				delete timeoutTimers[forkName];
			}
			const g = windDownGraceTimers[forkName];
			if (g) {
				clearTimeout(g);
				delete windDownGraceTimers[forkName];
			}
		};

		// sync:false supervised dispatches outlive the parent turn, but remain
		// in-process and are terminalized on session reload. Their entries start as
		// "constructing" while supervised clone history + worker boot run (slow under
		// clone_mode:'full') so explicit cancel / shutdown cleanup includes them
		// before the first onForkRuntimeUpdate promotes them to "running". Sync
		// dispatches keep the original "pending".
		const detached = !effectiveSync;
		const initialRunStatus: RunLiveStatus = detached ? "constructing" : "pending";
		recoveryAuthorityGuard?.();
		const runState: DelegateDispatchState = preRegisteredRunState ?? {
			runId,
			rootRunId: rootRunIdForNewRun(runId),
			ownerSessionId,
			// Issue #76 — a single-entry supervised batch is indistinguishable from a
			// direct run by entry count alone; record the real shape.
			shape: "supervised",
			notifyOnFailure,
			createdAt: Date.now(),
			detached,
			forks: Object.fromEntries(
				resolvedReqs.map((r, index) => [
					r.name,
					{
						name: r.name,
						...(r.displayLabel !== undefined ? { displayLabel: r.displayLabel } : {}),
						agent: r.agent.name,
						agentSource: r.agent.source,
						task: r.task,
						workerCwd: worktreeSetup?.worktrees[index]?.agentCwd ?? resolveChildCwd(ctx.cwd, r.cwd),
						...(worktreeSetup?.worktrees[index]
							? { workerBranch: worktreeSetup.worktrees[index]!.branch }
							: {}),
						...(r.agent.model ? { requestedModel: r.agent.model } : {}),
						...(r.agent.skills ? { skills: [...r.agent.skills] } : {}),
						confineWrites: r.confineWrites !== false,
						...(r.readOnly !== undefined ? { readOnly: r.readOnly } : {}),
						...(r.modelPlan ? { resolvedModel: r.modelPlan.primary.canonicalRef } : {}),
						cloneMode: r.cloneMode,
						collapseMode: r.collapseMode,
						status: initialRunStatus,
						currentRound: 0,
						maxRounds: r.maxRounds,
						transcript: [],
						pendingGuidance: [],
						interactive: r.interactive ?? false,
						...(r.heartbeatIntervalMs !== undefined
							? { heartbeatIntervalMs: r.heartbeatIntervalMs }
							: {}),
						...(r.maxConsecutiveHeartbeats !== undefined
							? { maxConsecutiveHeartbeats: r.maxConsecutiveHeartbeats }
							: {}),
					} satisfies RunLiveState,
				]),
			),
			abort: () => dispatchAbort.abort(),
			steer: () => Promise.reject(new Error("steer wired below")),
			cancel: () => Promise.reject(new Error("cancel wired below")),
		};
		// Timestamp each fork first transitions to "running" (captured below in
		// onForkRuntimeUpdate). Used by the ps-tree sweep to filter descendants
		// to processes started on or after this fork booted.
		const forkStartTimes: Record<string, number> = {};

		// ── 3a.1 steer fallback ladder ──────────────────────────────────
		const steerOneFork = async (
			forkName: string,
			text: string,
			deliverAs: "steer" | "followUp" | "queue" | undefined,
		) => steerForkFallbackLadder({
			runId,
			forkName,
			text,
			deliverAs,
			cloneSession: sessionRefsByFork[forkName]?.clone,
		});

		runState.steer = async (forkName, text, opts) => {
			const mode = opts?.deliverAs;
			if (forkName) return steerOneFork(forkName, text, mode);
			// Broadcast: apply to every still-running fork. Return the
			// "weakest" delivery so callers see the truth even when one
			// clone queue-fell-back while another accepted a live steer.
			const liveNames = Object.values(runState.forks)
				.filter((f) => isLiveStatus(f.status))
				.map((f) => f.name);
			if (liveNames.length === 0) {
				return { delivered: "queued" as SteerDelivery, error: "no running forks" };
			}
			const results = await Promise.all(liveNames.map((n) => steerOneFork(n, text, mode)));
			const rank: Record<SteerDelivery, number> = { steer: 0, followUp: 1, queued: 2 };
			results.sort((a, b) => rank[b.delivered] - rank[a.delivered]);
			return results[0];
		};

		// ── 3b.1 cancel ────────────────────────────────────────────────
		// Commit A — the UI (overlay keybinding + delegate_cancel tool)
		// awaits this promise. We stamp the fork's live state synchronously
		// AND fire clone/worker aborts CONCURRENTLY via Promise.allSettled.
		//
		// The previous sequential `await refs.clone.abort(); await
		// refs.worker.abort();` deadlocked: clone.abort() calls waitForIdle()
		// which can only resolve once `message_subagent.execute` returns, and
		// that in turn is awaiting `workerSession.prompt(…)` which is awaiting
		// the worker's bash child. worker.abort() (which kills that bash via
		// `killProcessTree`) was serialised AFTER clone.abort() and therefore
		// never ran — the observed 80-min hung-pid symptom.
		//
		// After aborts are dispatched we give pi ~1s to propagate naturally,
		// then run a ps-tree sweep as a backstop for edge cases: grandchild
		// that escaped the pgid, worker session that hadn't booted yet, etc.
		const cancelOneFork = async (forkName: string, reason: CancelReason) => {
			const refs = sessionRefsByFork[forkName];
			const current = runState.forks[forkName]?.status;
			// Spec 0019 / REQ-PAUSE-1 — "paused" is a terminal status (forced finish),
			// so a cancel that races a just-paused fork is a no-op like the other
			// terminal statuses: there is nothing left to abort.
			if (
				current === "completed" ||
				current === "failed" ||
				current === "aborted" ||
				current === "paused"
			)
				return;
			const errorText = reasonToErrorText(reason);
			forkAbortControllers[forkName]?.abort();
			// Mark aborted up-front so the overlay / run-history reflect the
			// cancel immediately; drain any worker prompts that were blocking
			// the entry so awaiters settle, and stop the per-entry timeout.
			updateRunState(runId, forkName, {
				status: "aborted",
				error: errorText,
				cancelReason: reason,
			});
			drainPendingPrompts(runId, forkName);
				clearTimeoutFor(forkName);
			// Fire BOTH aborts concurrently. allSettled so neither starves the
			// other; errors swallowed — fork is already marked aborted, and pi
			// tears sessions down when the dispatch completes regardless.
			await Promise.allSettled([
				refs?.clone?.abort(),
				refs?.worker?.abort(),
			]);
			// Backstop: after a short grace for natural propagation, enumerate
			// descendants started on or after this fork and SIGTERM/SIGKILL any
			// survivors. Best-effort, Unix-only; Windows is a no-op.
			await new Promise<void>((r) => setTimeout(r, 1000));
			const forkStartedAtMs = forkStartTimes[forkName];
			if (forkStartedAtMs !== undefined && process.platform !== "win32") {
				try {
					const candidates = enumerateRunDescendants(process.pid, forkStartedAtMs);
					if (candidates.length > 0) {
						await sweepKill(candidates);
						logDelegateDiagnostic(
							`swept ${candidates.length} stray descendants for fork '${forkName}' on cancel reason=${reason}`,
							{ agentDir: getAgentDir() },
						);
					}
				} catch (err) {
					logDelegateDiagnostic(
						`ps-tree sweep failed for fork '${forkName}': ${(err as Error).message}`,
						{ agentDir: getAgentDir() },
					);
				}
			}
		};

		runState.cancel = async (forkName, reason) => {
			const why: CancelReason = reason ?? "user";
			if (forkName !== undefined) {
				const target = runState.forks[forkName];
				if (!target || !isLiveStatus(target.status)) return;
				await cancelOneFork(forkName, why);
				return;
			}
			const liveNames = Object.values(runState.forks)
				.filter((f) => isLiveStatus(f.status))
				.map((f) => f.name);
			await Promise.all(liveNames.map((n) => cancelOneFork(n, why)));
				dispatchAbort.abort();
		};

		// Create per-entry recovery descriptors for the supervised batch — ALWAYS,
		// regardless of notifyOnFailure. notifyOnFailure only controls whether early-wake
		// notifications fire; it does not destroy recovery capability. A caller can still
		// recover after reading the aggregate, even when early wakes are disabled.
		{
			const supervisedRecoveryAuthority = resolveRecoveryDispatchAuthority(
				ctx,
				recoveryInvocationEpoch,
				ownerSessionId,
			);
			// Capture top-level settings for faithful recovery redispatch.
			const supervisedTopLevelSettings = captureRecoveryTopLevelSettings({
				worktree: params.worktree ?? false,
				agent_scope: scope,
				notifyOnFailure,
			});

			const descriptors = new Map<string, RunRecoveryDescriptor>();
			for (let i = 0; supervisedRecoveryAuthority !== undefined && i < resolvedReqs.length; i++) {
				const req = resolvedReqs[i]!;
				const capturedSlot = rawAgentSlots[i] as typeof params.agents[number];
				const capturedName = req.name;
				const capturedRunId = runId;
				descriptors.set(capturedName, buildSupervisedRecoveryDescriptor({
					forkName: capturedName,
					runId: capturedRunId,
					slotParams: {
						agent: capturedSlot.agent,
						task: capturedSlot.task,
						// Preserve the effective fork identity. This matters when duplicate
						// unnamed agents were disambiguated as worker#2, worker#3, etc.
						name: capturedName,
						...(capturedSlot.cwd !== undefined ? { cwd: capturedSlot.cwd } : {}),
						...(capturedSlot.clone_mode !== undefined ? { clone_mode: capturedSlot.clone_mode } : {}),
						...(capturedSlot.task_delivery !== undefined ? { task_delivery: capturedSlot.task_delivery } : {}),
						...(capturedSlot.max_rounds !== undefined ? { max_rounds: capturedSlot.max_rounds } : {}),
						...(capturedSlot.collapse_mode !== undefined ? { collapse_mode: capturedSlot.collapse_mode } : {}),
						...(capturedSlot.summary_model !== undefined ? { summary_model: capturedSlot.summary_model } : {}),
						...(capturedSlot.supervisor_instructions !== undefined ? { supervisor_instructions: capturedSlot.supervisor_instructions } : {}),
						...(capturedSlot.snippet_last_n !== undefined ? { snippet_last_n: capturedSlot.snippet_last_n } : {}),
						...(capturedSlot.interactive !== undefined ? { interactive: capturedSlot.interactive } : {}),
						...(capturedSlot.parentTranscriptSearch !== undefined ? { parentTranscriptSearch: capturedSlot.parentTranscriptSearch } : {}),
						...(capturedSlot.focus !== undefined ? { focus: capturedSlot.focus } : {}),
						// Capture the already main-cwd-resolved roots from the request, so a
						// recovery child dispatched from a different cwd still confines the
						// worker to the same absolute roots.
						...(req.writableRoots !== undefined ? { writableRoots: req.writableRoots } : {}),
						...(capturedSlot.confineWrites !== undefined ? { confineWrites: capturedSlot.confineWrites } : {}),
						...(capturedSlot.readOnly !== undefined ? { readOnly: capturedSlot.readOnly } : {}),
						...(capturedSlot.model !== undefined ? { model: capturedSlot.model } : {}),
						...(capturedSlot.thinking !== undefined ? { thinking: capturedSlot.thinking } : {}),
						...(capturedSlot.thinkingMin !== undefined ? { thinkingMin: capturedSlot.thinkingMin } : {}),
						...(capturedSlot.thinkingMax !== undefined ? { thinkingMax: capturedSlot.thinkingMax } : {}),
						...(capturedSlot.fallbackModels !== undefined ? { fallbackModels: capturedSlot.fallbackModels } : {}),
						...(capturedSlot.skill !== undefined ? { skill: capturedSlot.skill } : {}),
						...(capturedSlot.skills !== undefined ? { skills: capturedSlot.skills } : {}),
						...(capturedSlot.escalation !== undefined ? { escalation: capturedSlot.escalation } : {}),
						...(capturedSlot.max_duration_ms !== undefined ? { max_duration_ms: capturedSlot.max_duration_ms } : {}),
						...(capturedSlot.wind_down_grace_ms !== undefined ? { wind_down_grace_ms: capturedSlot.wind_down_grace_ms } : {}),
						// env captured in-memory only; never persisted or exposed in wakes
						...(capturedSlot.env !== undefined ? { env: capturedSlot.env } : {}),
					},
					topLevelSettings: supervisedTopLevelSettings,
					getLiveFork: (forkName) => runState.forks[forkName],
					dispatchFn: (recoveryParams, recoveryCallId) =>
						dispatchRecoveryChild(recoveryParams, recoveryCallId, supervisedRecoveryAuthority),
				}));
			}
			runState.recoveryDescriptors = descriptors;
		}

		if (retryClaims.length === 0) {
			registerRun(runState);
		}

		// Build per-entry worker UI contexts for interactive entries.
		const buildWorkerUIContextForFork = (forkName: string) => {
			const req = resolvedReqs.find((r) => r.name === forkName);
			if (!req?.interactive) return undefined;
			return buildRoutedUIContext({
				runId,
				forkName,
				pi,
				isInteractive: () => runState.forks[forkName]?.interactive ?? false,
			});
		};

		const sharedRunPumpArgs = {
			...runPumpArgs,
			ensureWorkerToolRegistration,
			getWorkerToolDefinitions,
			signal: dispatchAbort.signal,
			forkSignals: Object.fromEntries(
				Object.entries(forkAbortControllers).map(([name, controller]) => [name, controller.signal]),
			),
			sessionRefsByFork,
			buildWorkerUIContextForFork,
			onForkFailure: effectiveSync || notifyOnFailure === false
				? undefined
				: (forkName: string, patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason }) => {
					try {
						// Recovery is available if an in-memory descriptor exists for this fork.
						// Recovery after original aggregate completion is explicitly supported as
						// long as the descriptor lives in this process.
						const descriptor = runState.recoveryDescriptors?.get(forkName);
						const recoveryAvailable = descriptor !== undefined;
						const contextAvailable = descriptor?.buildPriorContext() !== undefined;
						const disposition = notifyForkFailed(
							wakeSink,
							{
								runId,
								mode: "supervised",
								forkName,
								status: "failed",
								reason: patch.reason ?? "fork-failed",
								siblingStates: failureSiblingStates(runState, forkName),
								recoveryAvailable,
								recovery: {
									available: recoveryAvailable,
									contextAvailable,
									strategy: contextAvailable ? "resume" : "fresh",
								},
							},
							{ agentDir: getAgentDir(), ownerSessionId },
						);
						if (disposition === "cross-boundary" || disposition === "dropped") {
							runState.recoveryDescriptors?.delete(forkName);
						}
						return disposition !== "dropped";
					} catch (err) {
						logDelegateDiagnostic(`supervised fork failure wake failed runId=${diagnosticIdentityText(runId)} fork=${diagnosticIdentityText(forkName)}: ${diagnosticErrorText(err)}`, { agentDir: getAgentDir(), level: "warn" });
						return false;
					}
				},
			onForkRuntimeUpdate: (forkName: string, patch: Partial<RunLiveState>) => {
				const existingFork = runState.forks[forkName];
				if (existingFork?.status === "aborted" && existingFork.cancelReason === "timeout" && patch.status !== undefined && patch.status !== "aborted") {
					patch = { ...patch, status: "aborted", cancelReason: "timeout" };
				}
				updateRunState(runId, forkName, patch);
				// Stamp forkStartedAtMs on first transition to running so the
				// ps-tree sweep can filter descendant pids.
				if (patch.status === "running" && forkStartTimes[forkName] === undefined) {
					const now = Date.now();
					forkStartTimes[forkName] = now;
					updateRunState(runId, forkName, { startedAtMs: now });
				}
				// Arm the already-resolved per-entry timeout on first transition to running.
				// Activity updates never recompute or extend this deadline.
				const request = resolvedReqs.find((r) => r.name === forkName);
				const timeoutPolicy = request?.timeoutPolicy;
				const maxMs = timeoutPolicy?.maxDurationMs ?? 0;
				if (
					patch.status === "running" &&
					maxMs > 0 &&
					!timeoutTimers[forkName] &&
					!timeoutDeadlines.has(forkName)
				) {
					const startedAtMs = forkStartTimes[forkName] ?? Date.now();
					if (!timeoutPolicy) return;
					const deadlineAtMs = captureRunTimeoutDeadline(
						timeoutDeadlines,
						forkName,
						timeoutPolicy,
						startedAtMs,
					);
					if (deadlineAtMs === undefined) return;
					updateRunState(runId, forkName, {
						timeoutDeadlineAtMs: deadlineAtMs,
						timeoutPolicy,
					});
					// Graceful wall-clock wind-down (REQ-WIND-1/2/3): when the
					// per-entry wall-clock budget elapses, DON'T hard-cancel
					// immediately. Issue ONE wrap-up steer, then arm a bounded grace
					// timer; an enforced policy calls `cancelOneFork(forkName, "timeout")`
					// only if the fork is still running past budget+grace. If the fork finishes
					// within grace, the terminal-status branch below clears both
					// timers and no cancel fires.
					timeoutTimers[forkName] = setTimeout(() => {
						delete timeoutTimers[forkName];
						const status = runState.forks[forkName]?.status;
						const stillRunning = status !== undefined && isLiveStatus(status);
						if (!stillRunning) return;
						// Latch provenance: this fork received the wall-clock wind-down
						// steer, so its eventual RunResult must carry steered=true
						// whether it finishes in grace or is hard-cancelled after
						// (REQ-WIND-5). Applied to the results after the pump returns.
						windDownSteeredRuns.add(forkName);
						updateRunState(runId, forkName, {
							windDown: { atMs: Date.now(), reason: "wall-clock" },
						});
						// Best-effort wrap-up steer; queue-fallback is fine if the
						// clone isn't live. Swallow errors — the grace timer below is
						// the hard backstop regardless of steer delivery.
						void Promise.resolve(
							runState.steer?.(forkName, FORK_WIND_DOWN_STEER),
						).catch(() => {});
						// Issue #11 — the budget is configurable, so the grace window
						// is too. Absent/invalid config falls back to the 90s default.
						const windDownGraceMs = timeoutPolicy.windDownGraceMs;
						logDelegateDiagnostic(
							`fork '${forkName}' hit wall-clock budget; ` +
								`steering wind-down (wrap up now), granting ${windDownGraceMs}ms grace` +
								(isHardCancelEnabled(timeoutPolicy) ? " before hard-cancel." : ". Hard cancellation is disabled."),
							{ agentDir: getAgentDir() },
						);
						windDownGraceTimers[forkName] = setTimeout(() => {
							delete windDownGraceTimers[forkName];
							const currentStatus = runState.forks[forkName]?.status;
							if (currentStatus === undefined || !isLiveStatus(currentStatus) || !isHardCancelEnabled(timeoutPolicy)) return;
							cancelOneFork(forkName, "timeout").catch(() => {});
						}, windDownGraceMs);
						(windDownGraceTimers[forkName] as unknown as { unref?: () => void }).unref?.();
					}, Math.max(0, deadlineAtMs - Date.now()));
					(timeoutTimers[forkName] as unknown as { unref?: () => void }).unref?.();
				}
				// Clear on terminal transition. Spec 0019 / REQ-PAUSE-1 — "paused" is
				// terminal (the supervisor was forced to finish), so its per-entry
				// timeout / wind-down timer must be cleared like any other terminal
				// status; otherwise a stale timer could fire a cancel against a
				// fork that already concluded.
				if (
					patch.status === "completed" ||
					patch.status === "failed" ||
					patch.status === "aborted" ||
					patch.status === "paused"
				) {
					clearTimeoutFor(forkName);
				}
			},
			onForkTranscriptEntry: (forkName: string, entry: any) =>
				appendTranscriptEntry(runId, forkName, entry),
			onGuidanceDelivered: (forkName: string, messages: string[]) => {
				for (const text of messages) {
					appendTranscriptEntry(runId, forkName, {
						source: "supervisor",
						role: "user",
						text: `<user-guidance>\n${text}\n</user-guidance>`,
					});
				}
				try {
					pi.events.emit("luthen.delegate.guidance_delivered", {
						runId,
						forkName,
						count: messages.length,
					});
				} catch {
					/* best effort */
				}
			},
		};

		// ────────────────────────────────────────────────────────────────
		// SYNC MODE: block until entries complete, return combined content.
		// Uses the SAME runtime wiring as dispatch so the overlay, status
		// widget, and delegate_status all see live progress.
		// ────────────────────────────────────────────────────────────────
		if (effectiveSync) {
			const syncDiagnosticBase = [
				`sync lifecycle runId=${runId}`,
				`ownerSessionId=${ownerSessionId ?? "unknown"}`,
				`forks=${resolvedReqs.length}`,
				`concurrency=${concurrency}`,
				`cloneModes=${uniqueDiagnosticList(resolvedReqs.map((r) => r.cloneMode))}`,
				`collapseModes=${uniqueDiagnosticList(resolvedReqs.map((r) => r.collapseMode))}`,
			].join(" ");
			const emit = (partialResults: RunResult[]) => {
				if (!onUpdate) return;
				const running = countLiveRuns(partialResults);
				// Spec 0019 / REQ-PAUSE-3 — a "paused" fork is NEITHER done nor running:
				// `=== "completed"` excludes it from the done-count (it is parked
				// mid-work, not finished), so the X/N progress never shows a paused
				// fork as a silent success.
				const done = partialResults.filter((r) => r.status === "completed").length;
				onUpdate({
					content: [
						{
							type: "text",
							text: `delegate: ${done}/${resolvedReqs.length} done, ${running} running`,
						},
					],
					details: { shape: "supervised", forks: projectRunResultsForDetails(partialResults) },
				});
			};
			try {
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=start`, { agentDir: getAgentDir(), level: "log" });
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=pump-start`, { agentDir: getAgentDir(), level: "log" });
				const pumped = await pumpRuns({ ...sharedRunPumpArgs, onStreamUpdate: emit });
				logDelegateDiagnostic(
					`${syncDiagnosticBase} stage=pump-resolved statuses=${runResultStatusDiagnostic(pumped.finalResults)} anyFailed=${pumped.anyFailed}`,
					{ agentDir: getAgentDir(), level: "log" },
				);
				applyResolvedTimeoutMetadata(pumped.finalResults, resolvedReqs, timeoutDeadlines);
				applyWindDownSteered(pumped.finalResults, windDownSteeredRuns);
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=completeRun-start`, { agentDir: getAgentDir(), level: "log" });
				completeRunWithEscalationCleanup(runId, pumped.finalResults);
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=completeRun-finished`, { agentDir: getAgentDir(), level: "log" });
				appendDelegateUsageMetadata(pi, runId, "supervised", pumped.finalResults, getAgentDir());
				const detailsBase: { runId: string; shape: "supervised"; forks: RunResultDetails[]; worktreeDiffs?: WorktreeDiff[]; usage: ReturnType<typeof aggregateRunResults>; usageByFork: ReturnType<typeof summarizeRunUsages> } = {
					runId,
					shape: "supervised",
					forks: projectRunResultsForDetails(pumped.finalResults),
					...usageDetails(pumped.finalResults),
				};
				const retryDetails = resolveRunResult(getAgentDir(), runId)?.details;
				if (retryDetails?.retry) {
					(detailsBase as Record<string, unknown>).retry = retryDetails.retry;
					if (retryDetails.retryMetadataIncomplete) (detailsBase as Record<string, unknown>).retryMetadataIncomplete = true;
					if (retryDetails.retryMetadataTruncated) (detailsBase as Record<string, unknown>).retryMetadataTruncated = true;
				}
				if (worktreeSetup) detailsBase.worktreeDiffs = pumped.worktreeDiffs;
				logDelegateDiagnostic(
					`${syncDiagnosticBase} stage=return combinedChars=${pumped.combinedContent.length} isError=${pumped.anyFailed}`,
					{ agentDir: getAgentDir(), level: "log" },
				);
				return {
					content: [{
						type: "text",
						text: capDelegateOnlyResult(
							supervisedProgressWarning ? `${SUPERVISED_PROGRESS_WARNING}\n\n${pumped.combinedContent}` : pumped.combinedContent,
							runId,
							{ claimAdvisory: false, runId },
						).text,
					}],
					details: detailsBase,
					isError: pumped.anyFailed,
				};
			} catch (err: any) {
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=catch error=${diagnosticErrorText(err)}`, { agentDir: getAgentDir() });
				completeRunWithEscalationCleanup(runId, []);
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=catch-completeRun-empty`, { agentDir: getAgentDir(), level: "log" });
				throw err;
			} finally {
				logDelegateDiagnostic(`${syncDiagnosticBase} stage=finally aborted=${dispatchAbort.signal.aborted}`, {
					agentDir: getAgentDir(),
					level: "log",
				});
			}
		}

		// ────────────────────────────────────────────────────────────────
		// DISPATCH MODE: start the pump detached, return immediately with
		// {dispatched: true, runId, forkNames}.
		// ────────────────────────────────────────────────────────────────
		const dispatchPump = pumpRuns(sharedRunPumpArgs);
		dispatchPump
			.then((result) =>
				containDispatchTail(runId, "supervised", () => {
					applyResolvedTimeoutMetadata(result.finalResults, resolvedReqs, timeoutDeadlines);
					applyWindDownSteered(result.finalResults, windDownSteeredRuns);
					if (!completeRunWithEscalationCleanup(runId, result.finalResults)) return;
					notifyCompletion(
						wakeSink,
						{
							runId,
							mode: "supervised",
							completionNotifyStrategy: config.completionNotifyStrategy,
							finalResults: result.finalResults,
							combinedContent: result.combinedContent,
						},
						{ agentDir: getAgentDir(), ownerSessionId },
					);
				}),
			)
			.catch((err: any) =>
				containDispatchTail(runId, "supervised", () => {
					const message = boundedErrorMessage(err);
					logDelegateDiagnostic(`dispatch runId=${diagnosticIdentityText(runId)} failed: ${diagnosticErrorText(err)}`, { agentDir: getAgentDir() });
					if (!completeRunWithEscalationCleanup(runId, [])) return;
					notifyCompletion(
						wakeSink,
						{
							runId,
							mode: "supervised",
							completionNotifyStrategy: config.completionNotifyStrategy,
							finalResults: [],
							combinedContent: "",
							error: message,
						},
						{ agentDir: getAgentDir(), ownerSessionId },
					);
				}),
			);

		const entryNames = resolvedReqs.map((r) => r.name);
		const supervisedTerminology = runEntryTerminology("supervised");
		const budgetAck = params.agents.some(
			(agent, index) => agent.max_duration_ms > 0 && resolvedReqs[index]?.timeoutPolicy !== undefined && !isHardCancelEnabled(resolvedReqs[index]!.timeoutPolicy!),
		)
			? `\n${WALL_CLOCK_BUDGET_ACK}`
			: "";
		const dispatchText =
			`Dispatched runId=${runId} with ${entryNames.length} ${supervisedTerminology.plural}: ${entryNames.join(", ")}. ` +
			`A new turn will be triggered automatically with the full output when all ${supervisedTerminology.plural} complete — do not poll or sleep.` +
			budgetAck;
		return {
			content: [{ type: "text", text: supervisedProgressWarning ? `${SUPERVISED_PROGRESS_WARNING}\n\n${dispatchText}` : dispatchText }],
			details: { dispatched: true, runId, shape: "supervised", forkNames: entryNames },
		};
	};

	const dispatchRecoveryChild = async (
		callParams: Record<string, unknown>,
		callId: string,
		authority: RecoveryDispatchAuthority,
	): Promise<string> => {
		assertRecoveryAuthority(authority);
		const currentCtx = authority.context;
		const expectedRunId = deriveRunId(callId);
		const registrationBefore = getRun(expectedRunId);
		let dispatchedRegistration: DelegateDispatchState | undefined;
		const revokeNewRegistration = async (): Promise<void> => {
			const child = dispatchedRegistration;
			if (!child || child === registrationBefore || !hasLocalRunAuthority(child)) return;
			try { await child.cancel?.(undefined, "shutdown"); } catch { /* best effort */ }
			try { child.abort(); } catch { /* best effort */ }
			revokeRunRegistration(expectedRunId, child);
		};
		return dispatchRecoveryChildSafely({
			expectedRunId,
			dispatch: async () => {
				let launched: unknown;
				try {
					launched = await executeDelegateTool(
						callId,
						callParams,
						currentCtx.signal,
						() => {},
						currentCtx,
						() => assertRecoveryAuthority(authority),
					);
				} catch (error) {
					dispatchedRegistration = getRun(expectedRunId);
					if (error instanceof RecoveryAuthorityLostError) {
						await revokeNewRegistration();
					}
					throw error;
				}
				dispatchedRegistration = getRun(expectedRunId);
				try {
					assertRecoveryAuthority(authority);
				} catch (error) {
					// The child may have registered immediately before replacement. Revoke
					// exactly that new object instead of returning an authority-bearing id.
					await revokeNewRegistration();
					throw error;
				}
				const recoveryRunId = (launched as { details?: { runId?: unknown } })?.details?.runId;
				return typeof recoveryRunId === "string" ? recoveryRunId : undefined;
			},
			getRegistration: (runId) => getRun(runId),
			getDispatchedRegistration: () => dispatchedRegistration,
			isRegistrationAccepted: (registration) =>
				hasLocalRunAuthority(registration as DelegateDispatchState),
			shouldReconcileError: (error) => !(error instanceof RecoveryAuthorityLostError),
			onRegistrationRejected: revokeNewRegistration,
		});
	};

	registerRuntimeTool({
		...DELEGATE_TOOL_PROMPT,
		promptGuidelines: [...DELEGATE_PROMPT_GUIDELINES],

		// Model ingress (spec §4, consumer 1). Legacy call shapes are absorbed here
		// before schema validation, so they stay accepted forever without being
		// advertised. `execute` re-runs the same normalizer for direct/internal
		// callers, which is safe because it is idempotent.
		prepareArguments,

		execute: executeDelegateTool,

		renderCall(args, theme, context) {
			return renderDelegateCall(args, theme, context);
		},

		renderResult(result, options, theme) {
			return renderDelegateResult(result, options, theme);
		},
	});

	// Issue #451 — a background dispatch delivers its finished run(s) as a
	// custom message, not as the `delegate` tool result. Without a renderer
	// pi-core paints the message's full content expanded and uncollapsible.
	// These renderers make a completed/recovered result collapsed on first paint
	// and toggleable with Ctrl+O, matching every other large-context message
	// type. `delegate:complete` reuses renderDelegateResult when it carries
	// per-run forks (the common case) and collapses free-form driver content
	// otherwise; the recovery notice collapses its banner-led content.
	// Feature-detected: registerMessageRenderer is declared on ExtensionAPI, but
	// the extension supports a peer range down to older pi releases. A missing
	// method would otherwise crash the whole extension at load; degrading to
	// pi-core's default rendering (the pre-#451 expanded view) is the safe fallback.
	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer("delegate:complete", (message, options, theme) =>
			renderDelegateCompletionMessage(message, options, theme),
		);
		pi.registerMessageRenderer("delegate:sync-orphan-recovery", (message, options, theme) =>
			renderDelegateRecoveryMessage(message, options, theme),
		);
	}

	// ───────────────────────────────────────────────────────────────────────────────────
	// Originator recovery pair + root escalate verb (§2.3 / §2.5).
	// Durable requests are authoritative; `delegate:escalation-pending` wakes
	// are owner-scoped hints that tell the root agent when to use these tools.
	// ───────────────────────────────────────────────────────────────────────────────────
	registerRuntimeTool({
		name: "delegate_escalations",
		label: "Delegate Escalations",
		description:
			"List pending durable escalations currently held across delegate roots. Use after a delegate:escalation-pending wake; wake holder data is only a hint and this tool re-reads canonical state. Omit rootRunId to scan every root, or filter by requestIds.",
		promptGuidelines: [
			"A delegate:escalation-pending wake is only a hint; call delegate_escalations to re-read canonical state before acting.",
			"Only the raiser's tool call is held without model-token burn. Do not poll or keep a turn open: resolve within root authority, pass upward with delegate_escalate, or ask the operator and end the turn.",
			"Resolve only within the root agent's declared authority. Use delegate_escalate for anything beyond it; user-held requests may be resolved only after the operator has chosen.",
		],
		parameters: Type.Object({
			rootRunId: Type.Optional(Type.String({ description: "Root delegation run to inspect; omit to scan all roots." })),
			requestIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "Optional request-id filter.",
			})),
		}),
		async execute(_toolCallId: string, params: { rootRunId?: string; requestIds?: string[] }) {
			const escalations = listHeldEscalations({
				agentDir: getAgentDir(),
				...(params.rootRunId ? { rootRunId: params.rootRunId } : {}),
				...(params.requestIds ? { requestIds: params.requestIds } : {}),
			});
			return {
				content: [{ type: "text" as const, text: formatHeldEscalations(escalations) }],
				details: { escalations },
			};
		},
	});

	registerRuntimeTool({
		name: "delegate_resolve_escalation",
		label: "Resolve Delegate Escalation",
		description:
			"Resolve one durable escalation through the current holder's mailbox lease. Use only when root authority covers the request, or after the operator explicitly chose an answer at the user surface (set onBehalfOfUser). Omit rootRunId only when requestId is unique across roots.",
		promptGuidelines: [
			"Selections are zero-based option indices. Never infer an operator answer: onBehalfOfUser means the user actually chose it.",
		],
		parameters: Type.Object({
			rootRunId: Type.Optional(Type.String({ description: "Root delegation run; required if requestId collides across roots." })),
			requestId: Type.String({ minLength: 1, description: "Durable escalation request id." }),
			selected: Type.Union([
				Type.Integer({ minimum: 0, description: "Zero-based option index." }),
				Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
			]),
			customInstruction: Type.Optional(Type.String({ description: "Free-text instruction; valid only with the custom instruction option selected exclusively." })),
			note: Type.Optional(Type.String({ description: "Optional audit note." })),
			onBehalfOfUser: Type.Optional(Type.Boolean({
				description: "True only when recording an option the operator explicitly chose; outcome attribution becomes user.",
			})),
		}),
		async execute(_toolCallId: string, params: {
			rootRunId?: string;
			requestId: string;
			selected: number | number[];
			customInstruction?: string;
			note?: string;
			onBehalfOfUser?: boolean;
		}) {
			const result = resolveHeldEscalation({
				agentDir: getAgentDir(),
				...(params.rootRunId ? { rootRunId: params.rootRunId } : {}),
				requestId: params.requestId,
				selected: params.selected,
				...(params.customInstruction !== undefined ? { customInstruction: params.customInstruction } : {}),
				...(params.note !== undefined ? { note: params.note } : {}),
				...(params.onBehalfOfUser !== undefined ? { onBehalfOfUser: params.onBehalfOfUser } : {}),
				claimedBy: `originator-agent:${currentForegroundSessionId ?? `pid-${process.pid}`}`,
			});
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
				...(!result.ok ? { isError: true } : {}),
			};
		},
	});

	registerRuntimeTool({
		name: "delegate_escalate",
		label: "Escalate Delegate Request",
		description:
			"Root agent's 'not mine; pass up' verb. Forward root-held durable escalations to the next chain stop (normally the operator), preserving the request and reply endpoint while adding optional context/recommendation. Omit rootRunId only when requestIds are unique; omit requestIds to pass all root-held requests.",
		promptGuidelines: [
			"Use for scope/product, security/permission, irreversible, external-side-effect, meaningful-cost, or any other request beyond root authority.",
		],
		parameters: Type.Object({
			rootRunId: Type.Optional(Type.String({ description: "Root delegation run; omit to scan all roots." })),
			requestIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
			context: Type.Optional(Type.String({ description: "Context appended to the forwarding trace." })),
			recommendation: Type.Optional(Type.String({ description: "Recommendation appended to the forwarding trace." })),
		}),
		async execute(_toolCallId: string, params: {
			rootRunId?: string;
			requestIds?: string[];
			context?: string;
			recommendation?: string;
		}) {
			const result = passHeldEscalation({
				agentDir: getAgentDir(),
				...(params.rootRunId ? { rootRunId: params.rootRunId } : {}),
				...(params.requestIds ? { requestIds: params.requestIds } : {}),
				...(params.context !== undefined ? { context: params.context } : {}),
				...(params.recommendation !== undefined ? { recommendation: params.recommendation } : {}),
			});
			queueEscalationDelivery();
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
				...(!result.ok ? { isError: true } : {}),
			};
		},
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	// delegate_steer — Phase 3a.3: inject guidance into a running entry.
	// ───────────────────────────────────────────────────────────────────────────────────
	registerRuntimeTool({
		name: "delegate_steer",
		label: "Delegate Steer",
		description:
			"Inject a guidance message into a running supervised fork. Direct workers, chain steps, and runs with unknown shape metadata reject steering. The supervisor (forked main agent) decides how to propagate the message to the worker.",
		promptGuidelines: [
			"Use sparingly — frequent steering defeats the purpose of delegation. Prefer waiting for completion unless the entry is clearly off-track or the user explicitly asks you to intervene.",
		],
		parameters: Type.Object({
			runId: Type.String({
				description: "The runId returned by the originating delegate call.",
			}),
			forkName: Type.Optional(
				Type.String({
					description:
						"Name of a specific run entry within the run. The display label shown in the widget also resolves, when exactly one live entry owns it. Omit to broadcast the message to every still-running entry in the batch \u2014 a name that cannot be resolved is an error, never a broadcast.",
				}),
			),
			message: Type.String({ description: "Guidance text to deliver to the supervisor." }),
			deliverAs: Type.Optional(
				StringEnum(["steer", "followUp", "queue"] as const, {
					description:
						"Delivery mode: steer interrupts the current turn, followUp waits for it, queue defers to the next round. Default: steer → followUp → queue.",
				}) as any,
			),
			targetLineagePath: Type.Optional(
				Type.String({
					description:
						"Lineage path `<rootRunId>/<runId>#<childIndex>` of a nested child; requires `capToken`. Omit to steer the immediate run entry.",
				}),
			),
			capToken: Type.Optional(
				Type.String({
					description: "Capability token authorizing a nested steer; required with `targetLineagePath`.",
				}),
			),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			// Nested control-inbox routing (REQ-BUS-3): when a lineage path is
			// supplied, the target is a DEEPLY-NESTED child rather than the
			// immediate run entry, so we post an authenticated control-request to the
			// filesystem control plane instead of using the in-process steer
			// channel. The immediate-entry path below is unchanged (additive).
			if (params.targetLineagePath) {
				if (!params.capToken) {
					return {
						content: [
							{
								type: "text" as const,
								text: "A nested steer (targetLineagePath set) requires a capToken authorizing it.",
							},
						],
						details: { targetLineagePath: params.targetLineagePath },
						isError: true,
					};
				}
				const id = postControlRequest({
					agentDir: getAgentDir(),
					targetLineagePath: params.targetLineagePath,
					capToken: params.capToken,
					kind: "steer",
					payload: { message: params.message },
				});
				if (!id) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Could not post a nested steer to ${params.targetLineagePath} (malformed path or unwritable control inbox).`,
							},
						],
						details: { targetLineagePath: params.targetLineagePath },
						isError: true,
					};
				}
				const rootRunId = rootRunIdFromLineagePath(params.targetLineagePath);
				const result = rootRunId
					? await awaitControlResult({ agentDir: getAgentDir(), rootRunId, id, timeoutMs: 5_000 })
					: undefined;
				return {
					content: [
						{
							type: "text" as const,
							text: result
								? `Nested steer to ${params.targetLineagePath} ${result.ok ? "delivered" : "rejected"}${result.detail ? ` (${result.detail})` : ""}.`
								: `Nested steer to ${params.targetLineagePath} posted (id=${id}); no control-result within the wait window (the child may pick it up on its next poll).`,
						},
					],
					details: {
						targetLineagePath: params.targetLineagePath,
						requestId: id,
						ok: result?.ok,
					},
					isError: result ? !result.ok : false,
				};
			}
			const daemonCfg = readDaemonDriverCfg(getAgentDir(), params.runId);
			if (daemonCfg) {
				try {
					assertDaemonDriverControlAuthority(daemonCfg, exactSessionId(ctx as ExtensionContext));
					const outcome = params.deliverAs === "followUp" || params.deliverAs === "queue"
						? await followUpDaemonDriver(getAgentDir(), params.runId, params.message)
						: await steerDaemonDriver(getAgentDir(), params.runId, params.message);
					return {
						content: [{ type: "text" as const, text: `${params.deliverAs === "followUp" || params.deliverAs === "queue" ? "Follow-up" : "Steer"} queued for daemon driver runId=${params.runId}.` }],
						details: { runId: params.runId, mode: "driver", queued: outcome.queued, inputId: outcome.inputId },
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Cannot steer daemon driver runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}.` }],
						details: { runId: params.runId, mode: "driver" },
						isError: true,
					};
				}
			}
			// Bare runId (spec 0009, REQ-CTRL-1/2): resolve ONE handle that addresses
			// an in-process run entry OR a detached child uniformly. The runs-map is
			// consulted FIRST inside `resolveRunControl` (no fs hop on a hit — the
			// unchanged fast path); only a miss reads the 0600 route record.
			const handle = resolveRunControl({
				runId: params.runId,
				lookupRun: (id) => {
					const run = getRun(id);
					// Active foreign-live runs can be hydrated into this process' registry,
					// but their live control closures are owned by another session. Treat
					// them as not in-process here so we never call the default hydrated
					// stubs. Terminal records still resolve for the friendly no-op surface.
					return run && (run.completedAt || hasLocalRunAuthority(run))
						? (run as InProcessRunRef)
						: undefined;
				},
				hasInMemoryRun: (id) => getRun(id) !== undefined,
				currentSessionId: currentForegroundSessionId ?? resolveOwnerSessionId(undefined),
				agentDir: getAgentDir(),
			});
			if (handle.kind === "unavailable") {
				// REQ-CTRL-9: an explicit credential-unavailable result, NOT a
				// misleading 'Unknown runId'.
				return {
					content: [
						{ type: "text" as const, text: `Cannot steer runId=${params.runId}: ${handle.reason}.` },
					],
					details: { runId: params.runId, reason: handle.reason },
					isError: true,
				};
			}
			if (handle.kind === "detached") {
				// Poster-side terminality FAST PATH (spec 0009, REQ-CTRL-7) — an
				// optimization, NOT the authority (the child-side drain is). If the run
				// is already terminal / dead-pid, return 'already terminal' WITHOUT a
				// pointless post + 5s await.
				const steerClass = classifyDetachedRunForControl(getAgentDir(), params.runId);
				if (steerClass === "terminal") {
					// Terminal observed via the fast path — delete the secret-bearing
					// route record so it does not outlive the run (REQ-CTRL-8). Issue
					// #54's recovery transaction temporarily needs that route as its
					// resume authority until pending publication commits.
					if (!orchestrateRecoveryInProgress(getAgentDir(), params.runId)) {
						finalizeTerminalOrchestrateRoute({ agentDir: getAgentDir(), runId: params.runId });
					}
					return {
						content: [
							{ type: "text" as const, text: `runId=${params.runId} is already terminal. Steer has no effect.` },
						],
						details: { runId: params.runId, alreadyTerminal: true, posted: false },
					};
				}
				if (steerClass === "not-found") {
					// Issue #11 — a route record exists but NO run state does (cfg,
					// terminal record, and bus all absent: the run was deleted).
					// Nothing is currently observable on that inbox; fail fast instead of
					// posting + eating the full 5s await. Retain the route for recovery:
					// cfg absence is not proof that a dead runner was terminalized.
					return {
						content: [
							{ type: "text" as const, text: `runId=${params.runId} not found: a control route existed but no run state remains (run deleted/stale). Nothing to steer.` },
						],
						details: { runId: params.runId, notFound: true, posted: false },
						isError: true,
					};
				}
				// Route via the authenticated control inbox (control secret, not a cap
				// token — the foreground cannot mint one the detached child accepts).
				const outcome = await routeDetachedControl({
					agentDir: getAgentDir(),
					handle,
					kind: "steer",
					payload: { message: params.message },
				});
				if (!outcome.posted) {
					return {
						content: [
							{ type: "text" as const, text: `Could not steer detached runId=${params.runId}: ${outcome.detail ?? "post failed"}.` },
						],
						details: { runId: params.runId, posted: false },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text:
								outcome.ok !== undefined
									? `Steer to detached runId=${params.runId} ${outcome.ok ? "delivered" : "rejected"}${outcome.detail ? ` (${outcome.detail})` : ""}.`
									: `Steer to detached runId=${params.runId} posted (id=${outcome.requestId}); no control-result within the wait window (the child may pick it up on its next poll).`,
						},
					],
					details: { runId: params.runId, requestId: outcome.requestId, ok: outcome.ok },
					isError: outcome.ok === false,
				};
			}
			// In-process fast path — live closure when this process owns the active run;
			// hydrated terminal/orphan records are read-only and must not reach the
			// default "registerRun was bypassed" stubs.
			const run = handle.run;
			const presentationShape = (run as InProcessRunRef & { shape?: string }).shape;
			if (run.completedAt) {
				return {
					content: [
						{
							type: "text" as const,
							text: `runId=${params.runId} is already terminal. Steer has no effect.`,
						},
					],
					details: { runId: params.runId, alreadyTerminal: true },
				};
			}
			if (presentationShape !== "supervised") {
				const terminology = runEntryTerminology(presentationShape);
				const reason = terminology.singular === "run"
					? "shape is unknown; only explicit supervised forks support steering"
					: "only explicit supervised forks support steering";
				return {
					content: [{ type: "text" as const, text: `Cannot steer ${terminology.singular} in runId=${params.runId}: ${reason}.` }],
					details: { runId: params.runId, unsupported: true },
					isError: true,
				};
			}
			// Issue #151 — a caller may pass either the addressing `name` or the
			// display label it read off the widget. An exact name wins
			// unconditionally; a label resolves only when exactly one LIVE entry
			// owns it. Anything else changes nothing: an unresolvable forkName
			// must never fall through to the omitted-forkName broadcast.
			let steerForkName: string | undefined = params.forkName;
			let steerAliasNote = "";
			if (params.forkName) {
				const resolution = resolveRunEntryAlias({
					requested: params.forkName,
					forks: run.forks,
					actionable: (entry) => isLiveStatus(entry.status as RunLiveState["status"]),
				});
				if (resolution.kind === "exact" || resolution.kind === "resolved") {
					steerForkName = resolution.name;
					if (resolution.kind === "resolved") {
						steerAliasNote = ` (resolved display label "${resolution.label}" → ${runEntryNoun(presentationShape)} "${resolution.name}")`;
					}
				} else {
					return {
						content: [
							{
								type: "text" as const,
								text: forkAliasErrorText({
									verb: "steer",
									runId: params.runId,
									requested: params.forkName,
									resolution,
									entryNoun: runEntryNoun(getRun(params.runId)?.shape),
								}),
							},
						],
						details: {
							runId: params.runId,
							forkName: params.forkName,
							...(resolution.kind === "ambiguous" ? { candidates: resolution.candidates } : {}),
						},
						isError: true,
					};
				}
			}
			if (!run.steer) {
				return {
					content: [{ type: "text" as const, text: "Steer is not wired for this run." }],
					details: { runId: params.runId },
					isError: true,
				};
			}
			const terminology = runEntryTerminology(presentationShape);
			if (terminology.singular === "run") {
				return {
					content: [{ type: "text" as const, text: `Cannot steer ${terminology.singular} in runId=${params.runId}: shape is unknown.` }],
					details: { runId: params.runId, unsupported: true },
					isError: true,
				};
			}
			const res = await run.steer(steerForkName, params.message, {
				deliverAs: params.deliverAs,
			});
			const target = steerForkName
				? `${terminology.singular}=${steerForkName}`
				: `all running ${terminology.plural}`;
			const errNote = res.error ? ` (${res.error})` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Steered ${target} via ${res.delivered}${errNote}.${steerAliasNote}`,
					},
				],
				details: {
					runId: params.runId,
					forkName: steerForkName,
					delivered: res.delivered,
				},
			};
		},
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	// delegate_cancel — Phase 3b.2: abort a single entry or whole run.
	// ───────────────────────────────────────────────────────────────────────────────────
	type DelegateCancelExecutionParams = {
		runId: string;
		forkName?: string;
		reason?: string;
		targetLineagePath?: string;
		capToken?: string;
	};
	const delegateCancelTool = {
		name: "delegate_cancel",
		label: "Delegate Cancel",
		description:
			"Cancel a running delegate entry (or the entire batch when forkName is omitted). Aborts the supervisor + worker sessions and marks the entry (or entries) as aborted. Use when the user asks to stop a delegation or when an entry is clearly stuck and cannot be recovered by steering.",
		promptGuidelines: [
			"Cancelling is destructive — the worker loses its in-flight state. Prefer `delegate_steer` for course-corrections. Only cancel when the user asks for it or when steering can't resolve the situation.",
		],
		parameters: Type.Object({
			runId: Type.String({
				description: "The runId returned by the originating delegate call.",
			}),
			forkName: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Name of a specific run entry to cancel. The display label shown in the widget also resolves, when exactly one live entry owns it. Omit to cancel every still-running entry in the batch \u2014 a name that cannot be resolved is an error, never a cancel-all.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description:
						'Free-text note included in the log line. The cancelReason stamped on the run entry is always "supervisor" when this tool fires (distinct from "user" / "timeout" / "shutdown").',
				}),
			),
			targetLineagePath: Type.Optional(
				Type.String({
					description:
						"Lineage path `<rootRunId>/<runId>#<childIndex>` of a nested child; requires `capToken`. Omit to cancel the immediate run entry.",
				}),
			),
			capToken: Type.Optional(
				Type.String({
					description: "Capability token authorizing a nested cancel; required with `targetLineagePath`.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			return delegateCancelTool.executeForInitiator(
				params as DelegateCancelExecutionParams,
				"supervisor",
				exactSessionId(ctx),
			);
		},
		async executeForInitiator(
			params: DelegateCancelExecutionParams,
			initiator: Extract<CancelReason, "supervisor" | "user">,
			callerSessionId?: string,
		): Promise<any> {
			if (
				params.forkName !== undefined &&
				(typeof params.forkName !== "string" || params.forkName.length === 0)
			) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot cancel runId=${params.runId}: cancel request had an invalid entry name.`,
						},
					],
					details: { runId: params.runId, forkName: params.forkName },
					isError: true,
				};
			}
			const controlPayload =
				params.reason !== undefined || params.forkName !== undefined
					? {
							...(params.reason !== undefined ? { reason: params.reason } : {}),
							...(params.forkName !== undefined ? { forkName: params.forkName } : {}),
						}
					: undefined;
			// Nested control-inbox routing (REQ-BUS-3): a lineage-path target is a
			// deeply-nested child; post an authenticated `cancel` control-request
			// to the control plane instead of the in-process abort. The
			// immediate-entry path below is unchanged (additive).
			if (params.targetLineagePath) {
				if (!params.capToken) {
					return {
						content: [
							{
								type: "text" as const,
								text: "A nested cancel (targetLineagePath set) requires a capToken authorizing it.",
							},
						],
						details: { targetLineagePath: params.targetLineagePath },
						isError: true,
					};
				}
				const id = postControlRequest({
					agentDir: getAgentDir(),
					targetLineagePath: params.targetLineagePath,
					capToken: params.capToken,
					kind: "cancel",
					...(controlPayload !== undefined ? { payload: controlPayload } : {}),
				});
				if (!id) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Could not post a nested cancel to ${params.targetLineagePath} (malformed path or unwritable control inbox).`,
							},
						],
						details: { targetLineagePath: params.targetLineagePath },
						isError: true,
					};
				}
				const rootRunId = rootRunIdFromLineagePath(params.targetLineagePath);
				const result = rootRunId
					? await awaitControlResult({ agentDir: getAgentDir(), rootRunId, id, timeoutMs: 5_000 })
					: undefined;
				return {
					content: [
						{
							type: "text" as const,
							text: result
								? `Nested cancel to ${params.targetLineagePath} ${result.ok ? "acknowledged" : "rejected"}${result.detail ? ` (${result.detail})` : ""}.`
								: `Nested cancel to ${params.targetLineagePath} posted (id=${id}); no control-result within the wait window (the child may pick it up on its next poll).`,
						},
					],
					details: {
						targetLineagePath: params.targetLineagePath,
						requestId: id,
						ok: result?.ok,
					},
					isError: result ? !result.ok : false,
				};
			}
			const daemonCfg = readDaemonDriverCfg(getAgentDir(), params.runId);
			if (daemonCfg) {
				try {
					assertDaemonDriverControlAuthority(daemonCfg, callerSessionId);
					const outcome = await cancelDaemonDriver(getAgentDir(), params.runId, params.reason);
					return {
						content: [{ type: "text" as const, text: `Daemon driver runId=${params.runId} abort ${outcome.aborted ? "committed" : "was already settled"}.` }],
						details: { runId: params.runId, mode: "driver", aborted: outcome.aborted, cursor: outcome.cursor },
					};
				} catch (error) {
					const detail = isDaemonRequestError(error)
						? `${error.code}: ${error.message}`
						: error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text" as const, text: `Cannot cancel daemon driver runId=${params.runId}: ${detail}.` }],
						details: { runId: params.runId, mode: "driver" },
						isError: true,
					};
				}
			}
			// Bare runId (spec 0009, REQ-CTRL-1/2): one resolver call selects the
			// in-process fast path (runs-map hit, no fs hop) or the detached inbox
			// route (0600 route record), mirroring delegate_steer.
			const handle = resolveRunControl({
				runId: params.runId,
				lookupRun: (id) => {
					const run = getRun(id);
					// Active foreign-live runs can be hydrated into this process' registry,
					// but their live control closures are owned by another session. Treat
					// them as not in-process here so we never call the default hydrated
					// stubs. Terminal records still resolve for the friendly no-op surface.
					return run && (run.completedAt || hasLocalRunAuthority(run))
						? (run as InProcessRunRef)
						: undefined;
				},
				hasInMemoryRun: (id) => getRun(id) !== undefined,
				currentSessionId: currentForegroundSessionId ?? resolveOwnerSessionId(undefined),
				agentDir: getAgentDir(),
			});
			if (handle.kind === "unavailable") {
				// REQ-CTRL-9: explicit credential-unavailable, NOT 'Unknown runId'.
				return {
					content: [
						{ type: "text" as const, text: `Cannot cancel runId=${params.runId}: ${handle.reason}.` },
					],
					details: { runId: params.runId, reason: handle.reason },
					isError: true,
				};
			}
			if (handle.kind === "detached") {
				// Poster-side terminality FAST PATH (spec 0009, REQ-CTRL-7) — an
				// optimization, NOT the authority (the child-side drain is). A run that
				// is already terminal / dead-pid needs no cancel: return 'already
				// terminal' WITHOUT a pointless post + 5s await.
				const cancelClass = classifyDetachedRunForControl(getAgentDir(), params.runId);
				if (cancelClass === "terminal") {
					// Terminal observed via the fast path — delete the secret-bearing
					// route record unless issue #54's pending-outbox transaction still
					// needs it as its crash-resume authority.
					if (!orchestrateRecoveryInProgress(getAgentDir(), params.runId)) {
						finalizeTerminalOrchestrateRoute({ agentDir: getAgentDir(), runId: params.runId });
					}
					return {
						content: [
							{ type: "text" as const, text: `runId=${params.runId} is already terminal. Nothing to cancel.` },
						],
						details: { runId: params.runId, alreadyTerminal: true, posted: false },
					};
				}
				if (cancelClass === "not-found") {
					// Issue #11 — route record without currently readable run state. Fail
					// fast (no dead-inbox post + 5s await), but leave the route available
					// to reconcile a dead runner that lost cfg before publishing terminal.
					return {
						content: [
							{ type: "text" as const, text: `runId=${params.runId} not found: a control route existed but no run state remains (run deleted/stale). Nothing to cancel.` },
						],
						details: { runId: params.runId, notFound: true, posted: false },
						isError: true,
					};
				}
				const outcome = await routeDetachedControl({
					agentDir: getAgentDir(),
					handle,
					kind: "cancel",
					...(controlPayload !== undefined ? { payload: controlPayload } : {}),
				});
				if (!outcome.posted) {
					return {
						content: [
							{ type: "text" as const, text: `Could not cancel detached runId=${params.runId}: ${outcome.detail ?? "post failed"}.` },
						],
						details: { runId: params.runId, posted: false },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text:
								outcome.ok !== undefined
									? `Cancel of detached runId=${params.runId} ${outcome.ok ? "acknowledged" : "rejected"}${outcome.detail ? ` (${outcome.detail})` : ""}.`
									: `Cancel of detached runId=${params.runId} posted (id=${outcome.requestId}); no control-result within the wait window (the child may pick it up on its next poll).`,
						},
					],
					details: { runId: params.runId, requestId: outcome.requestId, ok: outcome.ok },
					isError: outcome.ok === false,
				};
			}
			// In-process fast path — live closure when this process owns the active run;
			// hydrated terminal/orphan records are read-only and must not reach the
			// default "registerRun was bypassed" stubs.
			const run = handle.run;
			const presentationShape = (run as InProcessRunRef & { shape?: string }).shape;
			if (run.completedAt) {
				return {
					content: [
						{
							type: "text" as const,
							text: `runId=${params.runId} is already terminal. Nothing to cancel.`,
						},
					],
					details: { runId: params.runId, alreadyTerminal: true },
				};
			}
			// Issue #151 — same resolution as steer, and the fail-closed branch
			// matters more here: an unresolvable forkName that degraded to the
			// omitted-forkName broadcast would cancel every run entry in the run.
			let cancelForkName: string | undefined = params.forkName;
			let cancelAliasNote = "";
			if (params.forkName !== undefined) {
				const resolution = resolveRunEntryAlias({
					requested: params.forkName,
					forks: run.forks,
					actionable: (entry) => isLiveStatus(entry.status as RunLiveState["status"]),
				});
				if (resolution.kind === "exact" || resolution.kind === "resolved") {
					cancelForkName = resolution.name;
					if (resolution.kind === "resolved") {
						cancelAliasNote = ` (resolved display label "${resolution.label}" → ${runEntryNoun(presentationShape)} "${resolution.name}")`;
					}
				} else {
					return {
						content: [
							{
								type: "text" as const,
								text: forkAliasErrorText({
									verb: "cancel",
									runId: params.runId,
									requested: params.forkName,
									resolution,
									entryNoun: runEntryNoun(getRun(params.runId)?.shape),
								}),
							},
						],
						details: {
							runId: params.runId,
							forkName: params.forkName,
							...(resolution.kind === "ambiguous" ? { candidates: resolution.candidates } : {}),
						},
						isError: true,
					};
				}
			}
			if (!run.cancel) {
				return {
					content: [{ type: "text" as const, text: "Cancel is not wired for this run." }],
					details: { runId: params.runId },
					isError: true,
				};
			}
			// Tier 2 (#459) — a workerless never-constructed run has no live worker
			// closure to receive the cancel; run.cancel would only refresh activity
			// and leave the run resolving as "running" (the #459 follow-up defect).
			// Tier 2 (#459) — a workerless never-constructed run/entry has no live
			// worker closure to receive the cancel; run.cancel would only refresh
			// activity and leave it resolving as "running" (the #459 follow-up defect).
			// Drive the targeted entries terminal directly instead. The resolved fork
			// selector is honored: a targeted cancel terminalizes ONLY that entry (never
			// broadcasting to siblings), and the run completes only when every entry is
			// terminal. Returns false (falls through to the normal cancel) when a
			// targeted/whole-run set is not a workerless ghost.
			if (cancelNeverConstructedRun(params.runId as string, cancelForkName)) {
				const note = params.reason ?? reasonToErrorText(initiator);
				const scope = cancelForkName !== undefined
					? `${runEntryTerminology(presentationShape).singular}=${cancelForkName}`
					: `runId=${params.runId}`;
				logDelegateDiagnostic(
					`${initiator} cancel terminalized never-constructed ${scope} note=${JSON.stringify(note)}`,
					{ agentDir: getAgentDir(), level: "log" },
				);
				return {
					content: [{
						type: "text" as const,
						text: `Cancelled ${scope}: ${note} (the dispatch never constructed a worker).${cancelAliasNote}`,
					}],
					details: { runId: params.runId, ...(cancelForkName !== undefined ? { forkName: cancelForkName } : {}), neverConstructed: true },
				};
			}
			// The agent tool supplies "supervisor"; the explicit slash command supplies
			// "user". Both surfaces share every resolver and transport branch above.
			const note = params.reason ?? reasonToErrorText(initiator);
			await run.cancel(cancelForkName, initiator);
			const terminology = runEntryTerminology(presentationShape);
			const target = cancelForkName !== undefined
				? `${terminology.singular}=${cancelForkName}`
				: `every running ${terminology.singular}`;
			logDelegateDiagnostic(
				`${initiator} cancel runId=${params.runId}${cancelForkName !== undefined ? ` ${terminology.singular}=${cancelForkName}` : ""} note=${JSON.stringify(note)}`,
				{ agentDir: getAgentDir(), level: "log" },
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Cancelled ${target} in runId=${params.runId}: ${note}.${cancelAliasNote}`,
					},
				],
				details: { runId: params.runId, forkName: cancelForkName },
			};
		},
	};
	registerRuntimeTool(delegateCancelTool);

	// ───────────────────────────────────────────────────────────────────────────────────
	// delegate_recover — independent child recovery for a failed entry.
	//
	// Recovery is an INDEPENDENT CHILD RUN with its own runId and completion wake.
	// The original batch and healthy siblings are never delayed, cancelled, or mutated.
	//
	// strategy "fresh":  launch a child with the exact original invocation configuration.
	// strategy "resume": launch a child seeded with bounded prior-attempt context.
	//                    If no safe useful context exists, fails closed — does NOT
	//                    silently fall back to fresh.
	// strategy "auto":   try resume if context is available, otherwise fall back to fresh.
	//
	// Idempotent per original run/entry: concurrent callers await the same promise.
	// Recovery is allowed after the original aggregate has completed as long as an
	// in-memory descriptor still exists (hydrated/reloaded runs without a descriptor
	// fail closed — see issue #77).
	// ───────────────────────────────────────────────────────────────────────────────────
	registerRuntimeTool({
		name: "delegate_recover",
		label: "Delegate Recover",
		description:
			"Launch an independent recovery child run for a single failed entry without cancelling healthy siblings. The original run keeps its exactly-once aggregate completion wake. Recovery preserves the applicable original invocation configuration, including its early-failure notification policy. `resume` seeds the child with bounded prior-attempt context; `fresh` is an exact redispatch; `auto` tries resume and falls back to fresh.",
		promptGuidelines: [
			"Use after a delegate:fork-failed wake with recoveryAvailable=true. Target only the failed entry. Never re-run healthy siblings.",
		],
		parameters: Type.Object({
			runId: Type.String({ description: "The runId from the failure wake." }),
			forkName: Type.String({ description: "The failed entry name, or the display label of exactly one recoverable entry; healthy siblings are untouched." }),
			strategy: Type.Optional(Type.Union([
				Type.Literal("auto"),
				Type.Literal("fresh"),
				Type.Literal("resume"),
			], { description: "Recovery strategy: auto (default), fresh, or resume. `resume` fails closed if no prior context is available." })),
			message: Type.Optional(Type.String({ description: "Optional bounded guidance prepended to the recovery task as context. Incorporated on the first concurrent call; later concurrent calls see the already-launched outcome." })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const daemonCfg = typeof params.runId === "string"
				? readDaemonDriverCfg(getAgentDir(), params.runId)
				: undefined;
			if (daemonCfg) {
				try {
					assertDaemonDriverControlAuthority(daemonCfg, exactSessionId(ctx as ExtensionContext));
					const recovered = await recoverDaemonDriver(getAgentDir(), params.runId);
					return {
						content: [{ type: "text" as const, text: `Recovered interrupted daemon driver runId=${params.runId}.` }],
						details: { runId: params.runId, mode: "driver", status: "recovered", closedPromptIds: recovered.closedPromptIds },
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Cannot recover daemon driver runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
						details: { runId: params.runId, mode: "driver", status: "unavailable" },
						isError: true,
					};
				}
			}
			const runId = typeof params.runId === "string" ? params.runId : "";
			const forkName = typeof params.forkName === "string" ? params.forkName : "";
			// Both values are echoed in success/error payloads. Reject identities that
			// would require redaction or byte truncation rather than reflecting an
			// attacker-controlled credential/control string into a wake or diagnostic.
			const safeRunId = diagnosticIdentityText(runId);
			const safeForkName = diagnosticIdentityText(forkName);
			if (
				!isSafeRunId(runId) ||
				safeRunId !== runId ||
				forkName.length === 0 ||
				safeForkName !== forkName
			) {
				return {
					content: [{ type: "text" as const, text: "Cannot recover: invalid runId or forkName." }],
					details: { status: "unavailable" },
					isError: true,
				};
			}
			// Entry labels may legitimately contain `#` after count fan-out and may
			// contain user-chosen punctuation. Reject only control-line injection;
			// the value is used solely as an exact in-memory Map key.
			if (/[\0\r\n]/.test(forkName)) {
				return {
					content: [{ type: "text" as const, text: "Cannot recover: forkName contains unsafe characters." }],
					details: { runId, forkName, status: "unavailable" },
					isError: true,
				};
			}
			if (
				process.env.PI_DELEGATE_CHILD === "1" ||
				currentLineageFrame() !== undefined ||
				deserializeLineage(process.env) !== undefined ||
				deserializeLineageDetached(process.env) !== undefined
			) {
				return {
					content: [{ type: "text" as const, text: "Cannot recover: recovery is a foreground-only control surface." }],
					details: { runId, forkName, status: "unavailable" },
					isError: true,
				};
			}

			// ── Look up the run state and its in-memory descriptor ───────────────
			const run = getRun(runId);
			if (!run || !hasLocalRunAuthority(run)) {
				return {
					content: [{ type: "text" as const, text: `Cannot recover runId=${runId}: run not found or owned by a different process. Hydrated/reloaded runs must use a live session (see issue #77).` }],
					details: { runId, forkName, status: "unavailable" },
					isError: true,
				};
			}
			// Recovery descriptors are live authority. Require the current lifecycle
			// owner and any contextual caller to match the dispatching session exactly;
			// missing ownership is not proof and therefore fails closed.
			if (
				run.ownerSessionId === undefined ||
				currentForegroundSessionId === undefined ||
				run.ownerSessionId !== currentForegroundSessionId ||
				(ctx !== undefined && exactSessionId(ctx) !== run.ownerSessionId)
			) {
				return {
					content: [{ type: "text" as const, text: `Cannot recover runId=${runId}: the dispatching foreground session no longer owns this live recovery descriptor.` }],
					details: { runId, forkName, status: "unavailable" },
					isError: true,
				};
			}
			// Issue #151 — accept the display label a human read off the widget as
			// well as the addressing name. An exact name wins unconditionally; a
			// label resolves only when exactly one FAILED (recoverable) entry owns
			// it. Anything else changes nothing.
			const entryTerminology = runEntryTerminology(run.shape);
			const entryNoun = entryTerminology.singular;
			const entryLabel = entryNoun[0].toUpperCase() + entryNoun.slice(1);
			let targetEntryName = forkName;
			let recoverAliasNote = "";
			{
				const resolution = resolveRunEntryAlias({
					requested: forkName,
					forks: run.forks,
					actionable: (entry) => entry.status === "failed",
				});
				if (resolution.kind === "exact" || resolution.kind === "resolved") {
					targetEntryName = resolution.name;
					if (resolution.kind === "resolved") {
						recoverAliasNote = ` (resolved display label "${resolution.label}" → ${entryNoun} "${resolution.name}")`;
					}
				} else if (resolution.kind === "ambiguous") {
					return {
						content: [{ type: "text" as const, text: forkAliasErrorText({ verb: "recover", runId, requested: forkName, resolution, entryNoun: runEntryNoun(run.shape) }) }],
						details: { runId, forkName, status: "unavailable", candidates: resolution.candidates },
						isError: true,
					};
				}
				// An unresolved name falls through unchanged, so the existing
				// "no descriptor" / "not in a terminal failed state" diagnostics
				// keep reporting exactly what they report today.
			}
			const descriptor = run.recoveryDescriptors?.get(targetEntryName);
			if (!descriptor) {
				// Descriptor absent: run was hydrated/reloaded after process restart,
				// or this is a chain entry.
				const entry = run.forks?.[targetEntryName];
				if (run.shape === "chain") {
					return {
						content: [{ type: "text" as const, text: `Cannot recover ${entryNoun}=${targetEntryName}: chain step recovery is not safe when downstream steps depend on this output.` }],
						details: { runId, forkName: targetEntryName, status: "unavailable" },
						isError: true,
					};
				}
				if (!entry || entry.status !== "failed") {
					return {
						content: [{ type: "text" as const, text: `Cannot recover ${entryNoun}=${targetEntryName}: ${entryNoun} is not in a terminal failed state.` }],
						details: { runId, forkName: targetEntryName, status: "unavailable" },
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text: `Cannot recover ${entryNoun}=${targetEntryName}: no in-memory recovery descriptor found. This run was either hydrated after a process restart (see issue #77) or the run is no longer owned by this process.` }],
					details: { runId, forkName: targetEntryName, status: "unavailable" },
					isError: true,
				};
			}

			// ── Entry must be in failed state ───────────────────────────────────
			const entry = run.forks?.[targetEntryName];
			if (!entry || entry.status !== "failed") {
				return {
					content: [{ type: "text" as const, text: `Cannot recover ${entryNoun}=${targetEntryName}: ${entryNoun} is not in a terminal failed state (current: ${entry?.status ?? "unknown"}).` }],
					details: { runId, forkName: targetEntryName, status: "unavailable", forkStatus: entry?.status },
					isError: true,
				};
			}

			const requested = params.strategy === "fresh" || params.strategy === "resume" ? params.strategy : "auto";
			const rawMessage = typeof params.message === "string" ? params.message : undefined;
			let recovered: Awaited<ReturnType<typeof executeRecoveryOnce>>;
			try {
				recovered = await executeRecoveryOnce({
					descriptor,
					strategy: requested,
					message: rawMessage,
				});
			} catch (error) {
				const rawError = error instanceof Error ? error.message : String(error);
				const safeError = rawError ===
					"strategy:resume requires prior context but none is safely available for this run"
					? rawError
					: "recovery child launch failed before a runId could be confirmed; retry is allowed";
				return {
					content: [{ type: "text" as const, text: `Recovery for ${entryNoun}=${targetEntryName} failed: ${safeError}.` }],
					details: { runId, forkName: targetEntryName, status: "unavailable", strategy: requested },
					isError: true,
				};
			}
			const { outcome, reused } = recovered;
			if (reused) {
				return {
					content: [{ type: "text" as const, text: `${entryLabel} ${targetEntryName} was already recovered (strategy=${outcome.strategy}, recoveryRunId=${outcome.recoveryRunId}). Recovery is idempotent.` }],
					details: { runId, forkName: targetEntryName, status: "already-recovered", ...outcome },
				};
			}
			observeRecoveryTerminalResult(descriptor, recovered);
			const originalAggregate = run.completedAt === undefined
				? "Healthy siblings continue; the original aggregate wake will arrive exactly once."
				: "The original aggregate is already terminal and remains unchanged.";
			return {
				content: [{ type: "text" as const, text: outcome.strategy === "resume"
					? `Context-preserving recovery child launched for ${entryNoun}=${targetEntryName} as independent runId=${outcome.recoveryRunId}. ${originalAggregate}${recoverAliasNote}`
					: `Fresh recovery child launched for ${entryNoun}=${targetEntryName} as independent runId=${outcome.recoveryRunId}. ${originalAggregate}${recoverAliasNote}` }],
				details: { runId, forkName: targetEntryName, status: "recovered", ...outcome },
			};
		},
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	registerRuntimeTool({
		name: "delegate_prompt_status",
		label: "Delegate Prompt Status",
		description: "Read the durable pi-daemon prompt outcome for a detached driver without acquiring a lease.",
		parameters: Type.Object({ runId: Type.String() }),
		async execute(_toolCallId, params: any) {
			if (!readDaemonDriverCfg(getAgentDir(), params.runId)) {
				return { content: [{ type: "text" as const, text: `runId=${params.runId} is not a daemon driver.` }], details: { runId: params.runId }, isError: true };
			}
			try {
				const promptStatus = await promptStatusDaemonDriver(getAgentDir(), params.runId);
				return {
					content: [{ type: "text" as const, text: `Daemon prompt for runId=${params.runId} is ${promptStatus.state}.` }],
					details: { runId: params.runId, mode: "driver", promptStatus },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Could not query daemon prompt status for runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
					details: { runId: params.runId, mode: "driver" },
					isError: true,
				};
			}
		},
	});

	registerRuntimeTool({
		name: "delegate_follow_up",
		label: "Delegate Follow Up",
		description: "Queue a post-turn instruction for a detached pi-daemon driver.",
		parameters: Type.Object({ runId: Type.String(), message: Type.String() }),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			try {
				const daemonCfg = readDaemonDriverCfg(getAgentDir(), params.runId);
				if (!daemonCfg) throw new Error(`runId=${params.runId} is not a daemon driver`);
				assertDaemonDriverControlAuthority(daemonCfg, exactSessionId(ctx as ExtensionContext));
				const result = await followUpDaemonDriver(getAgentDir(), params.runId, params.message);
				return {
					content: [{ type: "text" as const, text: `Follow-up queued for daemon driver runId=${params.runId}.` }],
					details: { runId: params.runId, mode: "driver", queued: result.queued, inputId: result.inputId },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Could not queue daemon follow-up for runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
					details: { runId: params.runId, mode: "driver" },
					isError: true,
				};
			}
		},
	});

	registerRuntimeTool({
		name: "delegate_ui_answer",
		label: "Delegate UI Answer",
		description: "Answer one correlated UI question for a detached pi-daemon driver while holding its driver lease.",
		parameters: Type.Object({
			runId: Type.String(),
			questionId: Type.String(),
			answer: Type.Union([
				Type.Object({ value: Type.String() }, { additionalProperties: false }),
				Type.Object({ confirmed: Type.Boolean() }, { additionalProperties: false }),
				Type.Object({ cancelled: Type.Literal(true) }, { additionalProperties: false }),
			]),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			try {
				const daemonCfg = readDaemonDriverCfg(getAgentDir(), params.runId);
				if (!daemonCfg) throw new Error(`runId=${params.runId} is not a daemon driver`);
				assertDaemonDriverControlAuthority(daemonCfg, exactSessionId(ctx as ExtensionContext));
				const rawAnswer: unknown = params.answer;
				if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) {
					throw new TypeError("daemon UI answer must be an object");
				}
				const answerRecord = rawAnswer as Record<string, unknown>;
				let answer: DaemonUiAnswer;
				if (typeof answerRecord.value === "string") answer = { value: answerRecord.value };
				else if (typeof answerRecord.confirmed === "boolean") answer = { confirmed: answerRecord.confirmed };
				else if (answerRecord.cancelled === true) answer = { cancelled: true };
				else throw new TypeError("daemon UI answer has no supported value");
				const result = await answerDaemonDriverUi(
					getAgentDir(),
					params.runId,
					params.questionId,
					answer,
				);
				return {
					content: [{ type: "text" as const, text: `Answered daemon UI question ${result.questionId} for runId=${params.runId}.` }],
					details: { runId: params.runId, mode: "driver", answered: result.answered, questionId: result.questionId },
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Could not answer daemon UI question for runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
					details: { runId: params.runId, mode: "driver", questionId: params.questionId },
					isError: true,
				};
			}
		},
	});

	// delegate_result — re-fetch the collapsed output of a dispatched run.
	// ───────────────────────────────────────────────────────────────────────────────────
	type InProcessResultShape = "direct" | "supervised" | "chain" | "unknown";
	const inProcessResultShape = (result: ReturnType<typeof resolveRunResult>): InProcessResultShape | undefined => {
		if (!result || result.source !== "in-memory") return undefined;
		return result.shape === "direct" || result.shape === "supervised" || result.shape === "chain" || result.shape === "unknown"
			? result.shape
			: "unknown";
	};

	interface DelegateResultDetails {
		runId?: string;
		shape?: InProcessResultShape;
		status?: string;
		recovered?: true;
		partial?: boolean;
		recovery?: RecoveryProvenanceSummary;
		forks?: RunResult[];
		taskLedger?: TaskLedger;
		usage?: ReturnType<typeof aggregateRunResults>;
		usageByFork?: ReturnType<typeof summarizeRunUsages>;
		retry?: Array<Record<string, unknown>>;
		retryMetadataIncomplete?: boolean;
		retryMetadataTruncated?: boolean;
		diagnostics?: Record<string, unknown>;
	}
	registerRuntimeTool({
		name: "delegate_result",
		label: "Delegate Result",
		description:
			"Retrieve the result of a previously dispatched delegate batch. Normally invoked automatically by delegate when the batch completes; you usually don't need to call it yourself.",
		promptGuidelines: [
			"Dispatched delegate runs auto-deliver results to you as a new turn when they complete — you do NOT need to fetch them. Only call this to re-read results from a previously completed runId you need to reference again.",
		],
		parameters: Type.Object({
			runId: Type.String({
				description: "The runId returned by the originating delegate call.",
			}),
			tail: Type.Optional(Type.Boolean({ description: "Request the full bounded childlog tail." })),
			tailLines: Type.Optional(
				Type.Integer({
					description: "Requested childlog tail lines; server-clamped to 256.",
					minimum: 0,
				}),
			),
		}),
		async execute(_toolCallId, params: any) {
			if (readDaemonDriverCfg(getAgentDir(), params.runId)) {
				try {
					const replayed = await replayDaemonDriver(getAgentDir(), params.runId);
					if (replayed.status.state === "pending" || replayed.status.state === "unknown") {
						return {
							content: [{ type: "text" as const, text: `runId=${params.runId} is still in progress.` }],
							details: { runId: params.runId, mode: "driver", status: "in-progress", promptStatus: replayed.status },
						};
					}
					const failed = replayed.status.state === "failed" || replayed.status.state === "aborted";
					return {
						content: [{ type: "text" as const, text: replayed.output ?? (failed ? `daemon prompt ${replayed.status.state}` : "(no output)") }],
						details: {
							runId: params.runId,
							mode: "driver",
							status: failed ? "terminal-failed" : "terminal-done",
							promptStatus: replayed.status,
							cursor: replayed.locator.cursor,
						},
						isError: failed,
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Could not replay daemon driver runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
						details: { runId: params.runId, mode: "driver" },
						isError: true,
					};
				}
			}
			// Spec 0008 / REQ-INTRO-3: resolve through the shape-agnostic
			// resolver — NO branch on shape/transport. The resolver returns a
			// uniform result whether the run is in-process (in-memory final
			// result) or detached (orchestrate results / hydrate-and-deliver
			// pending). Fully guarded (REQ-INTRO-6): a soft tool error on an fs
			// failure, never a throw into the foreground.
			let resolved: ReturnType<typeof resolveRunResult>;
			try {
				resolved = resolveRunResult(getAgentDir(), params.runId, undefined, {
					includeTail: params.tail !== false,
					tailLines: params.tail === true ? undefined : params.tailLines,
					fullTail: params.tail === true || params.tailLines !== undefined,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `delegate_control(action="result"): failed to read run state for runId=${params.runId}: ${(err as Error)?.message ?? err}`,
						},
					],
					details: { runId: params.runId } as DelegateResultDetails,
					isError: true,
				};
			}
			if (!resolved) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Unknown runId=${params.runId}. Dispatched in-process runs are kept only for the lifetime of this session; detached driver runs are read from their on-disk records.`,
						},
					],
					details: {} as DelegateResultDetails,
					isError: true,
				};
			}
			const resolvedShape = inProcessResultShape(resolved);
			if (resolved.pending) {
				const childlogPath = resolved.details?.childlogPath;
				return {
					content: [
						{
							type: "text" as const,
							text: `runId=${params.runId} is still in progress. Try again once delegate notifies you of completion.` +
								(typeof childlogPath === "string" ? ` childlog=${childlogPath}` : ""),
						},
					],
					details: {
						runId: params.runId,
						...(resolvedShape !== undefined ? { shape: resolvedShape } : {}),
						...(resolved.shape === "driver" ? { mode: "driver" } : {}),
						status: "in-progress",
						...(resolved.details?.retry ? { retry: resolved.details.retry } : {}),
						...(resolved.details?.retryMetadataIncomplete ? { retryMetadataIncomplete: true } : {}),
						...(resolved.details?.retryMetadataTruncated ? { retryMetadataTruncated: true } : {}),
						diagnostics: resolved.details,
					} as DelegateResultDetails,
				};
			}
			// Uniform terminal result: in-process entries build the combined
			// content as before; a detached run carries its collapsed `output`.
			const body = resolved.forks
				? buildCombinedContent(resolved.forks, "")
				: resolved.output ?? resolved.error ?? "(no output)";
			const text = resolved.recovery
				? `${formatRecoveryBanner(params.runId, resolved.recovery)}\n\n${body}`
				: body;
			return {
				content: [{ type: "text" as const, text: text || "(no output)" }],
				details: {
					runId: params.runId,
					...(resolvedShape !== undefined ? { shape: resolvedShape } : {}),
					...(resolved.shape === "driver" ? { mode: "driver" } : {}),
					status: resolved.state,
					...(resolved.recovery
						? {
							recovered: true as const,
							partial: resolved.recovery.partial,
							recovery: resolved.recovery,
						}
						: {}),
					...(resolved.forks ? { forks: projectRunResultsForDetails(resolved.forks) } : {}),
					...(resolved.orchestrate?.taskLedger ? { taskLedger: resolved.orchestrate.taskLedger } : {}),
					usage: resolved.usage ?? (resolved.forks ? aggregateRunResults(resolved.forks) : undefined),
					usageByFork: resolved.forks ? summarizeRunUsages(resolved.forks) : undefined,
					...(resolved.details?.retry ? { retry: resolved.details.retry } : {}),
					...(resolved.details?.retryMetadataIncomplete ? { retryMetadataIncomplete: true } : {}),
					...(resolved.details?.retryMetadataTruncated ? { retryMetadataTruncated: true } : {}),
					diagnostics: resolved.details,
				} as DelegateResultDetails,
				isError: resolved.state === "terminal-failed",
			};
		},
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	// delegate_status — list active/completed runs with brief live state.
	// ───────────────────────────────────────────────────────────────────────────────────
	interface DelegateStatusDetails {
		/**
		 * Uniform statuses (REQ-INTRO-1) for in-process AND detached runs.
		 *
		 * Named `dispatches` since #265: under the consolidated surface a "run"
		 * is ambiguous — `runs[]` is also the name of delegate's own INPUT array
		 * of work items (#264), so a reader of a status result could not tell
		 * which of the two it was looking at. `dispatches` names what these
		 * actually are: previously dispatched batches.
		 */
		dispatches: UniformRunStatus[];
		/**
		 * Deprecated alias for `dispatches`, still emitted so an out-of-tree
		 * consumer reading `.runs` keeps working. Remove in the #267 cutover.
		 */
		runs: UniformRunStatus[];
		/** True when an fs read degraded the detached enumeration (REQ-INTRO-6). */
		degraded?: boolean;
		/** True when the bounded detached history/live scan omitted records. */
		truncated?: boolean;
	}
	registerRuntimeTool({
		name: "delegate_status",
		label: "Delegate Status",
		description:
			"List the status of dispatched delegate runs in this session. Pass a runId to scope to one run; omit to list all.",
		promptGuidelines: [
			"Do NOT use this to poll for completion. Dispatched runs automatically wake you with a new turn containing full results when they finish. Only use delegate_status when the user asks about run progress, or to inspect metadata of a specific run. Never loop or repeatedly call this waiting for a run to complete.",
		],
		parameters: Type.Object({
			runId: Type.Optional(
				Type.String({ description: "Only show this run's status. Optional — default lists all." }),
			),
			tail: Type.Optional(Type.Boolean({ description: "Request the full bounded childlog tail." })),
			tailLines: Type.Optional(
				Type.Integer({
					description: "Requested childlog tail lines; server-clamped to 256.",
					minimum: 0,
				}),
			),
		}),
		async execute(_toolCallId, params: any) {
			// Spec 0008 / REQ-INTRO-1/2/5: resolve through the shape-agnostic
			// resolver — NO branch on shape/transport. With a runId → that run's
			// uniform status (in-process OR detached). With NO runId → enumerate
			// BOTH in-memory runs AND detached orchestrate records (bounded scan,
			// skipping unreadable/foreign entries → `degraded`). Fully guarded
			// (REQ-INTRO-6): an fs failure degrades to a soft error + whatever
			// could be read, never a throw.
			const agentDir = getAgentDir();
			let statuses: UniformRunStatus[];
			const readDaemonUniformStatus = async (runId: string): Promise<UniformRunStatus> => {
				const [daemonStatus, promptStatus] = await Promise.all([
					statusDaemonDriver(agentDir, runId),
					promptStatusDaemonDriver(agentDir, runId),
				]);
				const state = promptStatus.state === "pending" || promptStatus.state === "unknown"
					? "running"
					: promptStatus.state === "settled" ? "terminal-done" : "terminal-failed";
				return {
					runId,
					shape: "driver",
					state,
					source: "detached",
					details: {
						promptStatus,
						pendingQuestions: daemonStatus.session.pendingQuestions,
						observedPhase: daemonStatus.session.observedPhase,
						attention: daemonStatus.session.attention,
						generation: daemonStatus.session.generation,
						cursor: daemonStatus.session.cursor,
					},
				};
			};
			if (params.runId && readDaemonDriverCfg(agentDir, params.runId)) {
				try {
					const status = await readDaemonUniformStatus(params.runId);
					return {
						content: [{ type: "text" as const, text: formatUniformRunStatus(status, Date.now()) }],
						details: { dispatches: [status], runs: [status], degraded: false, truncated: false } as DelegateStatusDetails,
					};
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Could not read daemon driver status for runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}` }],
						details: { dispatches: [], runs: [], degraded: true } as DelegateStatusDetails,
						isError: true,
					};
				}
			}
			let degraded = false;
			let truncated = false;
			// Tier 2 (#459) — reap never-constructed ghosts before reading status so
			// the user querying status never sees a stuck-dispatch entry rendered as a
			// live worker (directly answers #370's "progressing vs stalled"). This runs
			// on every status read regardless of the persist-path throttle.
			try {
				reapNeverConstructedRuns();
			} catch {
				/* reaping is best-effort; a failure must never block a status read. */
			}
			if (params.runId) {
				let resolved: ReturnType<typeof resolveRunStatus>;
				try {
					resolved = resolveRunStatus(agentDir, params.runId, undefined, {
						includeTail: params.tail !== false,
						tailLines: params.tail === true ? undefined : params.tailLines,
						fullTail: params.tail === true || params.tailLines !== undefined,
					});
				} catch {
					return {
						content: [
							{
								type: "text" as const,
								text: `delegate_control(action="status"): failed to read run state for runId=${params.runId}.`,
							},
						],
						details: { dispatches: [], runs: [], degraded: true } as DelegateStatusDetails,
						isError: true,
					};
				}
				statuses = resolved ? [resolved] : [];
			} else {
				// Spec 0014 / REQ-OWN-2: owner-scope the all-runs enumeration to THIS
				// session. The shared registry + shared detached cfg dir would
				// otherwise surface a foreign live session's runs. The runId-specific
				// path above (resolveRunStatus) is unscoped so an owner can still
				// query its own run by id (REQ-OWN-3). Pass the real pid probe so the
				// staleness reconciliation (REQ-INTRO-4) is unchanged.
				const listed = listAllRunStatuses(
					agentDir,
					undefined,
					currentForegroundSessionId ?? resolveOwnerSessionId(undefined),
				);
				statuses = listed.statuses;
				degraded = listed.degraded;
				truncated = listed.truncated;
			}
			if (!params.runId) {
				statuses = await Promise.all(statuses.map(async (status) => {
					const daemonCfg = readDaemonDriverCfg(agentDir, status.runId);
					if (!daemonCfg) return status;
					try {
						return await readDaemonUniformStatus(status.runId);
					} catch {
						degraded = true;
						return status;
					}
				}));
			}
			if (statuses.length === 0) {
				const msg = params.runId
					? `No run found with runId=${params.runId}.`
					: "No delegate runs in this session.";
				return {
					content: [{ type: "text" as const, text: msg }],
					details: { dispatches: [], runs: [], degraded, truncated } as DelegateStatusDetails,
					// A degraded empty list on the all-runs path is a soft error so
					// the caller knows the detached scan couldn't be read.
					...(degraded ? { isError: true } : {}),
				};
			}
			const now = Date.now();
			const lines = statuses.map((s) => formatUniformRunStatus(s, now));
			if (degraded) {
				lines.push(
					"(note: one or more detached records were unreadable and skipped)",
				);
			}
			if (truncated) {
				lines.push(
					`(note: detached status is truncated at ${MAX_DETACHED_SCAN} records; active owner markers were prioritized)`,
				);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { dispatches: statuses, runs: statuses, degraded, truncated } as DelegateStatusDetails,
				...(degraded ? { isError: true } : {}),
			};
		},
	});

	registerDeferredTool({
		name: PARENT_TRANSCRIPT_SEARCH_TOOL_NAME,
		label: "Search Parent Transcript",
		description: "Search the trusted parent session transcript and return a few capped matching excerpts. Access is granted per run; the query cannot select a file or session.",
		promptGuidelines: [
			"Search only for a focused query. Results are capped per excerpt and overall; this is not a bulk transcript export.",
			"The parent transcript may contain user-provided secrets or other sensitive text. Use this capability only when the dispatch granted it.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 1, description: "Case-insensitive text to find in the parent transcript." }),
		}),
		async execute(_toolCallId, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			const snapshot = ctx ? getParentTranscriptSnapshot(ctx.sessionManager) : undefined;
			if (!snapshot) {
				return {
					content: [{ type: "text" as const, text: "Parent transcript search is not granted for this worker." }],
					details: { granted: false },
					isError: true,
				};
			}
			const query = typeof params.query === "string" ? params.query : "";
			const result = searchParentTranscript(snapshot, query);
			return {
				content: [{ type: "text" as const, text: result.text || "No matching parent transcript lines." }],
				details: {
					granted: true,
					query: result.query,
					matchCount: result.matchCount,
					bytes: result.bytes,
					truncated: result.truncated,
				},
			};
		},
	});

	// ── Consolidated control surface (#265, spec §2/§6) ──────────────────────
	//
	// Eleven advertised tools become two action tools. Each action forwards to the
	// legacy executor registered above, so behaviour and authority checks move
	// verbatim rather than being re-derived; the legacy names remain the internal
	// invoke keys for the runtime API at zero model-visible cost.
	const routeControlAction = async (
		resolve: () => { route: string },
		params: Record<string, unknown> | undefined,
		toolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: ExtensionContext | undefined,
	) => {
		let route: string;
		try {
			({ route } = resolve());
		} catch (error) {
			// A usage error is a soft tool result, not a throw: the model should
			// read the help text and correct itself on the next turn.
			return {
				content: [{ type: "text" as const, text: (error as Error).message }],
				isError: true,
			};
		}
		const execute = runtimeToolExecutors.get(route);
		if (!execute) {
			return {
				content: [{ type: "text" as const, text: `delegate control routing failed: ${route} is unavailable` }],
				isError: true,
			};
		}
		return execute(toolCallId, forwardedParams(params), signal, onUpdate, ctx);
	};

	registerDeferredTool({
		name: "delegate_control",
		label: "Delegate Control",
		description:
			"Inspect and control dispatched delegate runs. action: status (list runs) | result (re-read a completed run) | prompt_status (read a daemon prompt outcome) | steer (guide a supervised fork or authenticated detached driver) | follow_up (queue daemon guidance) | ui_answer (answer a correlated daemon question) | cancel (stop direct worker, supervised fork, chain step, or authenticated detached driver under existing authorization rules) | recover (recover a failed worker entry or interrupted daemon driver).",
		promptGuidelines: [
			"Solo and supervised background runs wake you automatically with their results. A daemon driver is resumed explicitly with prompt_status and result. Do NOT poll with action:\"status\" — use it when the user asks about progress, or to inspect a specific run.",
			"Status is a one-off diagnostic: its surfaced last-activity silence (`last activity <N>s ago`) is runtime/channel activity. Silence is evidence, not proof, of a stall.",
			"Prefer action:\"steer\" or checking context over action:\"cancel\": cancellation is destructive and loses the entry's in-flight state, while steering course-corrects it.",
		],
		parameters: Type.Object({
			// StringEnum, not Type.Union: a union emits anyOf/const, which is
			// semantically identical but 304 characters larger across these two
			// tools — paid on EVERY provider request. The `as any` is the price of
			// two TypeBox copies resolving in this tree, and every StringEnum call
			// site in this file already carries it. Context is the scarcer budget.
			action: StringEnum(["status", "result", "prompt_status", "steer", "follow_up", "ui_answer", "cancel", "recover"] as const, {
				description: "Which control verb to apply.",
			}) as any,
			runId: Type.Optional(Type.String({ description: "Run to address. Required for every action except status." })),
			forkName: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Worker entry name for recover; omit for a daemon driver or on whole-run cancel.",
				}),
			),

			message: Type.Optional(Type.String({ description: "Guidance text; required for steer and follow_up." })),
			questionId: Type.Optional(Type.String({ description: "Correlated daemon UI question; required for ui_answer." })),
			answer: Type.Optional(Type.Union([
				Type.Object({ value: Type.String() }, { additionalProperties: false }),
				Type.Object({ confirmed: Type.Boolean() }, { additionalProperties: false }),
				Type.Object({ cancelled: Type.Literal(true) }, { additionalProperties: false }),
			], { description: "Daemon UI answer; required for ui_answer." })),
			reason: Type.Optional(Type.String({ description: "Free-text note recorded with a cancel." })),
			// These keep the LEGACY constraints. Routing bypasses each executor's
			// own schema validation, so loosening a field here would silently
			// accept a value the legacy tool rejected — an invalid recovery
			// strategy would fall through to `auto` instead of erroring.
			deliverAs: Type.Optional(
				StringEnum(["steer", "followUp", "queue"] as const, {
					description:
						"steer delivery: steer interrupts the current turn, followUp waits for it, queue defers to the next round.",
				}) as any,
			),
			strategy: Type.Optional(
				StringEnum(["auto", "fresh", "resume"] as const, {
					description: "recover strategy.",
				}) as any,
			),
			tail: Type.Optional(Type.Boolean({ description: "Request the full bounded childlog tail." })),
			tailLines: Type.Optional(Type.Integer({ minimum: 0, description: "Childlog tail lines; server-clamped to 256." })),
			targetLineagePath: Type.Optional(Type.String({ description: "Lineage path of a nested child; requires capToken." })),
			capToken: Type.Optional(Type.String({ description: "Capability token authorizing a nested steer or cancel." })),
		}),
		async execute(toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
			return routeControlAction(
				() =>
					resolveControlCall(params, {
						workerDenied: isDelegatedWorkerEnv(process.env, { lineageDepth: currentLineageFrame()?.depth }),
						grantedActions: workerControlGrants("delegate_control", process.env, exactSessionId(ctx as ExtensionContext)),
					}),
				params,
				toolCallId,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	registerDeferredTool({
		name: "delegate_escalation",
		label: "Delegate Escalation",
		description:
			"Handle durable escalations raised by delegated workers. action: list (re-read pending requests) | resolve (answer one within your authority) | pass_up (forward beyond it).",
		promptGuidelines: [
			"An escalation-pending wake is only a hint; use action:\"list\" to re-read canonical state before acting.",
			"Only the raiser's tool call is held without model-token burn. Do not poll or keep a turn open: resolve within your authority, pass upward with action:\"pass_up\", or ask the operator and end the turn.",
			"Resolve only within your declared authority; a user-held request may be resolved only after the operator has chosen. Selections are zero-based option indices, and you must never infer an operator answer: onBehalfOfUser means the user actually chose it.",
			"Use action:\"pass_up\" for scope/product, security/permission, irreversible, external-side-effect, meaningful-cost, or any other request beyond root authority.",
		],
		parameters: Type.Object({
			// Same trade as delegate_control's action.
			action: StringEnum(["list", "resolve", "pass_up"] as const, {
				description: "Which escalation verb to apply.",
			}) as any,
			rootRunId: Type.Optional(Type.String({ description: "Root delegation run; omit to scan every root." })),
			requestId: Type.Optional(Type.String({ minLength: 1, description: "Escalation request; required for resolve." })),
			// Legacy constraints preserved for the same reason as delegate_control.
			requestIds: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					minItems: 1,
					description: "Filter for list, or the set to pass up.",
				}),
			),
			selected: Type.Optional(
				Type.Union([
					Type.Integer({ minimum: 0, description: "Zero-based option index." }),
					Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 }),
				], { description: "Zero-based option index, or an array of them; required for resolve." }),
			),
			customInstruction: Type.Optional(Type.String({ description: "Free-text instruction, valid only with the custom option." })),
			note: Type.Optional(Type.String({ description: "Optional audit note." })),
			onBehalfOfUser: Type.Optional(Type.Boolean({ description: "True only when recording an answer the operator actually chose." })),
			context: Type.Optional(Type.String({ description: "Context appended when passing up." })),
			recommendation: Type.Optional(Type.String({ description: "Recommendation appended when passing up." })),
		}),
		async execute(toolCallId, params: Record<string, unknown>, signal, onUpdate, ctx) {
			return routeControlAction(
				() =>
					resolveEscalationCall(params, {
						grantedActions: workerControlGrants(
							"delegate_escalation",
							process.env,
							exactSessionId(ctx as ExtensionContext),
						),
					}),
				params,
				toolCallId,
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	// ── State-gated visibility (#265, spec §6) ───────────────────────────────
	//
	// The two action tools are revealed only once there is something to control.
	// Re-asserted every turn because durable state can appear while the session
	// is idle, and because another extension may have replaced the active list
	// in the meantime. Strictly additive: a foreign tool is never removed.
	const readControlVisibilityState = (): ControlVisibilityState => {
		// Each source is read defensively: a visibility check must never be the
		// reason a turn fails, so an unreadable state directory degrades to "no
		// signal from this source" rather than throwing into the agent loop.
		let inProcessRunCount = 0;
		let durableRunCount = 0;
		let pendingRecoveryCount = 0;
		let heldEscalationCount = 0;
		try {
			// Scoped to THIS session, for the same reason the history count below
			// is. `listRuns()` is NOT just this session's work: startup hydration
			// loads the shared run-state file, so a fresh session on a busy machine
			// starts with other sessions' runs in its registry — 25 of them when
			// this was found by soaking. Counting them unscoped revealed the tool
			// in every session and defeated the gating entirely.
			//
			// A HYDRATED run is excluded outright: it came off disk, so it belongs
			// to whichever session dispatched it. Older records carry no owner at
			// all, so owner-matching alone still let nine of them through.
			inProcessRunCount = listRuns().filter(
				(run) =>
					!isHydratedRun(run.runId)
					&& (run.ownerSessionId === undefined || run.ownerSessionId === currentForegroundSessionId),
			).length;
		} catch {
			/* in-memory registry unavailable */
		}
		try {
			// Scoped to THIS session's runs on purpose. The history file is a
			// machine-wide append-only archive — thousands of entries from every
			// past session — so counting it wholesale would reveal the tool in
			// every session forever and defeat the gating. Restart support still
			// works: a session that reattaches keeps its own id, so its unfinished
			// runs are found. With no known session id we contribute no signal
			// rather than guessing.
			durableRunCount = currentForegroundSessionId
				? readRunHistory(getAgentDir()).filter(
						(entry) => entry.ownerSessionId === currentForegroundSessionId,
					).length
				: 0;
		} catch {
			/* unreadable or absent history */
		}
		try {
			if (hasOwnedDaemonDriverRun(getAgentDir(), currentForegroundSessionId)) {
				durableRunCount += 1;
			}
		} catch {
			/* unreadable or absent daemon locator state */
		}
		try {
			pendingRecoveryCount = listPendingSyncOrphanRecoveries(currentForegroundSessionId).length;
		} catch {
			/* unreadable recovery state */
		}
		try {
			heldEscalationCount = listHeldEscalations({ agentDir: getAgentDir() }).length;
		} catch {
			/* unreadable escalation state */
		}
		return { inProcessRunCount, durableRunCount, pendingRecoveryCount, heldEscalationCount };
	};

	const assertControlVisibility = (): void => {
		try {
			// pi's active-tool accessors are optional capability probes rather than
			// guaranteed API, so they are read through a narrow structural type
			// instead of `any`.
			const wanted = visibleControlTools(readControlVisibilityState());
			if (wanted.length === 0) return;
			// Registration is what actually advertises a tool; the union then keeps
			// it active alongside whatever else is registered.
			revealDeferredTools(wanted);
			const active = toolRegistry.getActiveTools?.();
			if (!Array.isArray(active)) return;
			const next = [...new Set([...active, ...wanted])];
			if (next.length !== active.length) toolRegistry.setActiveTools?.(next);
		} catch {
			/* visibility is best-effort; never break a turn over it */
		}
	};

	assertControlVisibilityHook = assertControlVisibility;
	// Every wake delivery reveals first. Registered centrally because a wake
	// bypasses before_agent_start entirely: startup orphan-recovery, detached
	// orchestrate results, and periodic maintenance all deliver this way, and
	// each one can trigger a foreground turn that needs the control tool.
	setWakeDeliveryBarrier(assertControlVisibility);
	setWakeDeliveryObserver(pi, registerChildCompletionGate(pi));

	// `before_agent_start` alone is not enough (#265). It fires once per agent
	// loop, but a run REGISTERS during execution of the `delegate` call — after
	// that hook has already run — and the next provider request is a
	// continuation of the same loop. Wake-triggered turns enter the prompt path
	// directly and bypass the hook as well. Reveal at the three moments that
	// actually precede a request needing the tool:
	//
	//   1. a run registering (covers the immediate continuation after dispatch)
	//   2. an escalation wake, just before the message is delivered
	//   3. pending-wake redelivery on a restart
	//
	// before_agent_start stays as the catch-all re-assertion.
	pi.events.on("delegate:register", () => {
		assertControlVisibility();
	});

	// The reveal is also driven by an explicit event, so a caller that knows a
	// control tool is about to be needed can bring it forward without
	// fabricating run state. Used by the test harness in place of a
	// registration back door, and harmless in production: it reveals exactly
	// what the state-based path would.
	pi.events.on("delegate:reveal-control-tools", () => {
		revealDeferredTools(["delegate_control", "delegate_escalation"]);
	});

	pi.on("before_agent_start", () => {
		assertControlVisibility();
	});

	// Programmatic callers invoke these exact registered handlers. There is no
	// tool-to-tool bridge and no parallel semantics path: validation, nested
	// authority, detached routing, status projection, and cancellation remain
	// owned by the same production closures as the LLM-facing tools.
	const runtimeCore: Parameters<typeof installDelegateRuntimeCore>[0] & object = {
		invoke: async (name, params, ctx) => {
			const execute = runtimeToolExecutors.get(name);
			if (!execute) throw new Error(`pi-delegate runtime handler is unavailable: ${name}`);
			const toolCallId = `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			return execute(
				toolCallId,
				params,
				new AbortController().signal,
				() => {},
				ctx,
			);
		},
	};
	// The core is installed from the foreground `session_start` below, never at
	// load. Pi loads a separate module instance for every in-process worker
	// session, and those instances skip foreground lifecycle. Installing at load
	// would let each worker copy take over the process-global runtime API handle
	// and leave it bound to a disposed instance.
	pi.events.on("luthen.delegate.complete", (payload: unknown) => {
		const runId = payload && typeof payload === "object" && "runId" in payload
			? (payload as { runId?: unknown }).runId
			: undefined;
		if (typeof runId !== "string") return;
		const recoveryFinalResult = getRun(runId)?.finalResult;
		if (recoveryFinalResult) classifyRecoveryTerminalResult(runId, recoveryFinalResult);
		const ctx = currentForegroundContext;
		if (!ctx) return;
		if (!readDelegateRuntimeReceipt(getAgentDir(), runId)) return;
		void createDelegateRuntimeClient({ context: ctx, agentDir: getAgentDir() })
			.harvest(runId)
			.catch((error) => {
				logDelegateDiagnostic(
					`runtime API terminal publication failed runId=${diagnosticIdentityText(runId)}: ${diagnosticErrorText(error)}`,
					{ agentDir: getAgentDir(), level: "warn" },
				);
			});
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	// Session lifecycle: wire the runtime emitter into pi.events, attach the
	// status widget on session_start, and abort any live runs + dispose the
	// widget on session_shutdown.
	// ───────────────────────────────────────────────────────────────────────────────────
	setEventEmitter((channel, data) => pi.events.emit(channel, data));

	// B.4 follow-up: sweep stale chain dirs on extension load. Cheap (≤
	// `readdirSync` over a single tmp folder), runs once per pi session.
	// Without this, users who invoke chain mode rarely accumulate dirs
	// indefinitely until they happen to dispatch a chain. Best-effort —
	// errors swallowed inside the helper.
	try {
		sweepOldChainDirs({});
	} catch (err) {
		logDelegateDiagnostic(
			`sweepOldChainDirs failed at startup: ${(err as Error)?.message ?? err}`,
			{ agentDir: getAgentDir() },
		);
	}

	// Spec 0004 / REQ-BUS-6 (sink lifecycle): sweep stale event-bus sinks on
	// extension load, mirroring the chain-dir sweep above. Best-effort — errors
	// swallowed inside the helper; the opportunistic 24h age cutoff keeps the
	// per-root event sinks from accumulating indefinitely.
	try {
		sweepOldEventSinks({ agentDir: getAgentDir() });
	} catch (err) {
		logDelegateDiagnostic(
			`sweepOldEventSinks failed at startup: ${(err as Error)?.message ?? err}`,
			{ agentDir: getAgentDir() },
		);
	}
	// Phase 2 deliberately left this foreground wiring to Phase 3. Retire all
	// v1 decision namespaces once on extension startup; escalation state is in
	// its distinct namespace and is unaffected.
	try {
		purgeLegacyDecisionState(getAgentDir());
	} catch (err) {
		logDelegateDiagnostic(
			`purgeLegacyDecisionState failed at startup: ${(err as Error)?.message ?? err}`,
			{ agentDir: getAgentDir() },
		);
	}

	// Issue #54: terminalize a route-backed detached runner that disappeared
	// before its own result/finally path. This MUST run before the generic route
	// sweep: a prior reconciler may have persisted the canonical failure and died
	// before publishing the pending wake, and the recovery state + route are what
	// let this process resume that outbox transaction. Child Pi processes never
	// run foreground orphan reconciliation.
	if (process.env.PI_DELEGATE_CHILD !== "1") {
		try {
			reconcileDeadDetachedOrchestrators(getAgentDir());
		} catch {
			logDelegateDiagnostic(
				"detached orphan reconciliation failed at startup; retrying on a later maintenance pass",
				{ agentDir: getAgentDir(), level: "warn", throttleKey: "orchestrate-orphan-recovery" },
			);
		}
	}

	// Spec 0009 / REQ-CTRL-8 (route-record lifecycle backstop): sweep the
	// orchestrate control substrate on extension load, alongside the chain-dir +
	// event-sink sweeps above. The route record is DELETED primarily on the
	// terminal transition (foreground-side result delivery / reaping); this sweep
	// is the CRASHED-PEER backstop — it removes secret-bearing route records for
	// runs with a dead pid + no cfg (a crashed foreground left them behind) and
	// reaps orphan control-request files whose target run is terminal. No
	// orchestrate-tree sweep existed before this. Best-effort — errors swallowed
	// inside the helper. [decision: route-record-delete-on-terminal-plus-sweep]
	try {
		sweepOldOrchestrateRoutes({
			agentDir: getAgentDir(),
			isRecoveryInProgress: orchestrateRecoveryInProgress,
		});
	} catch (err) {
		logDelegateDiagnostic(
			`sweepOldOrchestrateRoutes failed at startup: ${(err as Error)?.message ?? err}`,
			{ agentDir: getAgentDir() },
		);
	}
	try {
		sweepOrchestrateOwnerEvidence({ agentDir: getAgentDir() });
	} catch (err) {
		logDelegateDiagnostic(
			`sweepOrchestrateOwnerEvidence failed at startup: ${(err as Error)?.message ?? err}`,
			{ agentDir: getAgentDir() },
		);
	}

	// Extension registration is part of preflight's side-effect boundary: inspect
	// config here, but defer migration and diagnostics until an invocation passes
	// its local/sync compatibility gate.
	const startupConfig = loadConfigReadOnly(getAgentDir());

	let widgetHandle: StatusWidgetHandle | null = null;
	let usageStatusHandle: UsageStatusHandle | null = null;
	let activityTickerHandle: ActivityTickerHandle | null = null;
	const requestUsageStatusUpdate = () => {
		try {
			usageStatusHandle?.requestUpdate();
		} catch {
			/* stale ctx / disposed handle: best effort */
		}
	};
	let overlayHandle: TranscriptOverlayHandle | null = null;
	let ptmBridgeHandle: PtmBridgeHandle | null = null;
	let graftCapabilityRegistryHandle: GraftCapabilityRegistryHandle | null = null;
	let sessionActiveWorkQueryRegistryHandle: SessionActiveWorkQueryRegistryHandle | null = null;
	// `currentForegroundSessionId` / `currentForegroundContext` were declared at
	// extension entry so tool handlers and escalation delivery share one
	// fail-closed owner/UI source before the first session_start.
	// pi-intercom graceful-detach responder. ACKs the detach request
	// whenever any delegate run is active in the runtime registry, so
	// pi-intercom queues the inbound message instead of calling
	// ctx.abort() and tearing down the parent turn (which would have
	// cascaded into in-flight runs even after the
	// wireSignalToDispatch decoupling). See intercom-detach.ts.
	let intercomDetachHandle: IntercomDetachHandle | null = null;
	// Issue #14 — periodic redelivery + hygiene sweep. Re-armed per
	// session_start with the fresh ctx (the underlying interval lives on a
	// globalThis slot so a moduleCache:false reload replaces, never stacks).
	let maintenanceHandle: MaintenanceHandle | null = null;
	// pi-delegate's install root (the directory above src/) — retained as a
	// `PI_SUBAGENT_RUNTIME_ROOT` compatibility hook for older
	// pi-prompt-template-model installations. PTM 0.11 resolves agent and
	// skill names before emitting the bridge request. See
	// docs/prompt-template-bridge.md §3.2.
	const ptmRuntimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	pi.on("session_start", (_event, ctx) => {
		if (shouldSkipForegroundLifecycleForDelegateOwnedApi(pi)) return;
		const delegateChild = process.env.PI_DELEGATE_CHILD === "1";
		recoveryAuthorityEpoch++;
		// A second start in this module is a replacement boundary even when Pi
		// reuses the same durable session id. Live recovery closures never cross it.
		if (currentForegroundContext !== undefined) invalidateOwnedRecoveryDescriptors();
		currentForegroundContext = ctx;
		// Publish the runtime API for this foreground instance. Workers returned
		// above, so only a real foreground session ever owns the handle.
		installDelegateRuntimeCore(runtimeCore);
		// Capture the real foreground session id for live recovery, pending-failure
		// ownership, and in-process escalation routing. Missing identity fails
		// closed for those capabilities. Bare detached steer/cancel resolution
		// applies its separate pid fallback at the call site so this variable never
		// mistakes process identity for recovery-session authority.
		// Recovery authority requires a real exact session id. The pid fallback
		// remains available at detached-control call sites, but is never accepted
		// as evidence that an in-memory recovery descriptor survived replacement.
		// A delegate-owned child receives the trusted owner from the internal
		// child-spawn field. Never substitute the child session id for it.
		currentForegroundSessionId = delegateChild
			? process.env[ORCHESTRATE_OWNER_SESSION_ENV]
			: exactSessionId(ctx);
		// Worker-child guard: a spawned `pi` worker child (orchestrate hosted
		// agent, or any delegate-spawned child) is NOT a foreground session and
		// must NOT run foreground-only startup logic. Running hydrate-and-deliver
		// (which calls pi.sendMessage) inside a child that is already processing
		// its `-p` task crashes it with "Agent is already processing". The child
		// already runs with `--no-extensions` (so normally this extension is not
		// even loaded); this env guard is the defense-in-depth backstop for the
		// case where a consumer explicitly loads delegate in a child.
		if (delegateChild) {
			// Child runs still use the shared durable registry, but must not hydrate
			// or run foreground wake/UI lifecycle.
			configureRuntimePersistence(getAgentDir(), {
				hydrate: false,
				markActiveAsOrphaned: false,
			});
			return;
		}
		// Session replacement is a hard ownership boundary for UI-only actor
		// projections. Invalidate predecessor publishers before attaching the new
		// widget so late worker events cannot repopulate stale phases.
		clearAllActorActivity();
		// Graft queries capabilities synchronously through the live Pi event bus.
		// Bind it to this session's ctx and dispose it on replacement/shutdown so a
		// predecessor cannot leak stale cwd/trust state into a successor session.
		graftCapabilityRegistryHandle?.dispose();
		graftCapabilityRegistryHandle = installGraftAgentCapabilityRegistry(pi.events, (cwd) => {
			const configuredWarnings: string[] = [];
			const discovery = discoverAgents(
				cwd,
				"both",
				configuredAgentDiscoveryOptions(ctx, cwd, configuredWarnings),
			);
			return { ...discovery, warnings: [...configuredWarnings, ...discovery.warnings] };
		});
		// Issue #2 — register THIS session's fresh ctx as the process-wide live
		// wake sink (globalThis slot; survives pi's moduleCache:false extension
		// reload). A detached dispatch run started by a PREDECESSOR session in
		// this process whose wake bounces off its stale captured ctx retries
		// through this sink and delivers immediately.
		setLiveWakeSink(pi, currentForegroundSessionId);
		// The live active-work producer must never answer from a predecessor
		// session while this replacement is hydrating. Install its successor only
		// after runtime configuration/hydration has completed.
		sessionActiveWorkQueryRegistryHandle?.dispose();
		sessionActiveWorkQueryRegistryHandle = null;
		configureRuntimePersistence(getAgentDir(), { hydrate: true, markActiveAsOrphaned: true });
		sessionActiveWorkQueryRegistryHandle = installSessionActiveWorkQueryRegistry(
			pi.events,
			currentForegroundSessionId,
		);
		// Hydrate can terminalize a dead-owner root without passing through this
		// module's completeRun wrapper. Treat that orphan transition as the same
		// invariant-6 terminal hook; nested runs are excluded by root identity.
		for (const run of listRuns()) {
			if (
				run.orphanedAt !== undefined &&
				run.completedAt !== undefined &&
				(run.rootRunId ?? run.runId) === run.runId
			) {
				cleanupEscalationsForRun({
					agentDir: getAgentDir(),
					rootRunId: run.runId,
					reason: "Escalation cancelled because its hydrated root run is terminal.",
				});
			}
		}
		// Lineage hydrate (spec 0003 / REQ-LIN-2): a process spawned across a
		// boundary (a detached `orchestrate` child, or a `pi -c` session launched
		// by a parent delegate) inherits its lineage frame through the
		// environment, not through AsyncLocalStorage. Recover it here so
		// currentDepth()/currentChain() report the TRUE inherited depth from
		// session start onward. `deserializeLineage` is fail-closed (REQ-LIN-4):
		// a tampered/partial env can only ever report a DEEPER (stricter) frame,
		// never a shallower one. A genuine top-level session has no lineage env
		// and recovers nothing (depth stays 0).
		const inheritedLineage = deserializeLineage(process.env);
		if (inheritedLineage) {
			logDelegateDiagnostic(
				`hydrated inherited lineage: depth=${currentDepth()} ` +
					`chain=[${currentChain().join(" → ")}] path=${lineagePath(inheritedLineage)}`,
				{ agentDir: getAgentDir() },
			);
		}
		// GitLab #34 — sync orphan handoff: after runtime hydrate terminalizes a
		// dead-owner `sync:true` run, surface any per-entry outputs that were durably
		// recorded before the parent tool call disappeared. This is intentionally
		// distinct from normal dispatch completion wakes.
		try {
			deliverSyncOrphanRecoveries(pi, currentForegroundSessionId, getAgentDir());
		} catch (err) {
			logDelegateDiagnostic(
				`sync orphan recovery failed at startup: ${(err as Error)?.message ?? err}`,
				{ agentDir: getAgentDir(), level: "warn" },
			);
		}
		// #523 — a hydrate-orphaned `sync:false` run has no pump left to send its
		// completion wake; tell the owning session once that the run died.
		try {
			deliverOrphanedDispatchWakes(pi, currentForegroundSessionId, getAgentDir());
		} catch (err) {
			logDelegateDiagnostic(
				`orphaned dispatch handoff failed at startup: ${(err as Error)?.message ?? err}`,
				{ agentDir: getAgentDir(), level: "warn" },
			);
		}
		// Hydrate-and-deliver (spec 0005, node A / REQ-ORCH-6): deliver any
		// detached orchestrate child that finished while the foreground was gone.
		// Reads result FILES (no captured in-process `pi` ctx) and wakes the
		// foreground once per pending result.
		try {
			reconcileDeadDetachedOrchestrators(getAgentDir());
			deliverPendingOrchestrateResults(pi, getAgentDir(), {
				currentSessionId: currentForegroundSessionId,
			});
		} catch (err) {
			logDelegateDiagnostic(
				`hydrate-and-deliver failed at startup: ${(err as Error)?.message ?? err}`,
				{ agentDir: getAgentDir(), level: "warn" },
			);
		}
		// Issue #2 — redeliver dropped dispatch wakes (supervised/chain/direct
		// runs whose completion bounced off a stale ctx AND missed the live-sink
		// retry). Same file-based at-least-once discipline as the orchestrate
		// leg above; owner-scoped (this pid+nonce, or a dead owner).
		// Escalation wakes use the same claim/consume discipline as completion
		// wakes, but re-read canonical holder state before choosing UI, root
		// agent, or a live in-process mid-level channel (invariant 5). Keep the
		// lifecycle callback synchronous: UI/status setup below must not wait on a
		// prompt, while the promise chain preserves escalation-before-generic wake
		// consumption.
		queueEscalationService(pi, { advance: true, label: "startup" });
		// Issue #14 — age-based retention for completed runs (7d default), at
		// startup after hydrate…
		try {
			const swept = sweepOldCompletedRuns();
			if (swept > 0) {
				logDelegateDiagnostic(`startup sweep removed ${swept} completed run(s) past retention`, {
					agentDir: getAgentDir(), level: "log",
				});
			}
		} catch (err) {
			logDelegateDiagnostic(
				`startup completed-run sweep failed: ${(err as Error)?.message ?? err}`,
				{ agentDir: getAgentDir(), level: "warn" },
			);
		}
		// …and the periodic maintenance interval: redeliver pending orchestrate
		// results + dropped dispatch wakes every tick (~45s — closes the
		// orchestrate live-delivery gap and issue #2's residual window without
		// waiting for the next session start), sweep at a lower cadence. Both
		// delivery legs are idempotent + claim-disciplined, so the timer adds
		// liveness only. Unref'd; never armed in PI_DELEGATE_CHILD processes
		// (we returned above).
		installReloadGuard(ctx);
		maintenanceHandle?.dispose();
		maintenanceHandle = startPeriodicMaintenance({
			deliver: () => {
				// REVIEWER FINDING (MR !20): resolve the CURRENT live sink at
				// TICK time — never the captured session_start `pi` ctx. The
				// delivery legs' claim-then-consume discipline assumes a fresh
				// ctx (a stale ctx whose sendMessage silently no-ops would
				// consume the pending file and permanently lose the result).
				// `getLiveWakeSink()` is registered on every session_start and
				// cleared-if-ours on session_shutdown, so:
				//   - normal life: it IS this session's fresh ctx;
				//   - post-replacement (a leaked predecessor tick): it is the
				//     SUCCESSOR's fresh ctx — still correct;
				//   - shutdown gap (cleared, successor not started): reconcile to
				//     durable pending state, but skip delivery. The successor's
				//     session_start direct calls (above) pick it up.
				// Deliberately NOT `?? pi` — that fallback would reintroduce
				// the stale-ctx surface in exactly the gap that matters.
				// Issue #54 reconciliation does not need a UI sink and therefore runs
				// before the sink gate; only the user-visible delivery waits for a
				// fresh foreground context.
				reconcileDeadDetachedOrchestrators(getAgentDir());
				const sink = getLiveWakeSink();
				if (!sink) return;
				deliverPendingOrchestrateResults(sink, getAgentDir(), {
					// Pair the owner id with the sink actually being delivered through:
					// this tick took `sink` from the live registration, so the matching
					// identity is that registration's, not whatever the closure captured.
					currentSessionId: getLiveWakeSinkOwnerSessionId() ?? currentForegroundSessionId,
				});
				// Serialize wake arbitration, timeout/hop advancement, and UI drain.
				// Same-claimant renewal must not turn into two concurrent prompts.
				queueEscalationService(sink, { advance: true, label: "periodic" });
			},
			sweep: () => {
				sweepOldCompletedRuns();
				sweepOldOrchestrateRoutes({
					agentDir: getAgentDir(),
					isRecoveryInProgress: orchestrateRecoveryInProgress,
				});
				sweepOrchestrateOwnerEvidence({ agentDir: getAgentDir() });
			},
		});
		const sessionConfig = loadConfig(getAgentDir());
		widgetHandle?.dispose();
		widgetHandle = setupStatusWidget(pi, ctx, {
			currentSessionId: currentForegroundSessionId,
			footerIcons: sessionConfig.footerIcons,
		});
		usageStatusHandle?.dispose();
		usageStatusHandle = setupUsageFooterStatus(pi, ctx);
		activityTickerHandle?.dispose();
		activityTickerHandle = setupActivityTicker(pi, ctx, {
			config: sessionConfig.activityTicker!,
			footerIcons: sessionConfig.footerIcons,
			registry: ctx.modelRegistry,
			scopedModelRefs: modelScopeFromExtensionContext(ctx, getAgentDir()),
		});
		overlayHandle?.dispose();
		overlayHandle = setupTranscriptOverlay(pi, ctx, {
			detachedStatuses: () =>
				listAllRunStatuses(
					getAgentDir(),
					undefined,
					currentForegroundSessionId ?? resolveOwnerSessionId(undefined),
				),
			// Read on demand: only the run being looked at, only while it is.
			detachedEvents: (runId: string) => readRunEventTail(getAgentDir(), runId),
		});
		intercomDetachHandle?.dispose();
		intercomDetachHandle = installIntercomDetachResponder(pi);
		ptmBridgeHandle?.dispose();
		const bridgeMode = startupConfig.ptmBridge?.handleRequests ?? "auto";
		ptmBridgeHandle = installPtmBridge(
			pi,
			ctx,
			{
				runDelegate: executeDirectShape,
				discoverAgents: (cwd, scope) =>
					discoverAgents(cwd, scope, configuredAgentDiscoveryOptions(ctx, cwd)),
				loadConfig: () => loadConfig(getAgentDir()),
			},
			{ mode: bridgeMode, runtimeRoot: ptmRuntimeRoot },
		);
	});
	pi.on("session_shutdown", async (event) => {
		if (shouldSkipForegroundLifecycleForDelegateOwnedApi(pi)) return;
		// Runs this shutdown will abort. abortAllRuns terminalizes them without
		// the completion event that normally publishes result.json, so collect
		// the receipted ones now and publish their envelopes below.
		const shutdownContext = currentForegroundContext;
		const receiptedActiveRunIds = shutdownContext === undefined
			? []
			: listRuns()
				.filter((run) => run.completedAt === undefined && hasLocalRunAuthority(run))
				.map((run) => run.runId)
				.filter((runId) => readDelegateRuntimeReceipt(getAgentDir(), runId) !== undefined);
		recoveryAuthorityEpoch++;
		recoveryTerminalObservations.clear();
		// Issue #2 — drop the live-wake-sink registration if it is still OURS
		// (a successor session's fresh registration is never clobbered). This
		// ctx is about to go stale; a wake dropped between now and the next
		// session_start goes to the durable pending-wake file instead of a
		// pointless retry through a dying ctx.
		clearLiveWakeSink(pi);
		// Issue #14 — stop the maintenance interval for THIS ctx; the dispose
		// is slot-guarded so a successor session's fresh timer is never
		// clobbered. A wake landing between now and the next session_start
		// goes to the durable pending file (and the successor's timer picks
		// it up within one tick).
		maintenanceHandle?.dispose();
		maintenanceHandle = null;
		widgetHandle?.dispose();
		widgetHandle = null;
		usageStatusHandle?.dispose();
		usageStatusHandle = null;
		activityTickerHandle?.dispose();
		activityTickerHandle = null;
		overlayHandle?.dispose();
		overlayHandle = null;
		ptmBridgeHandle?.dispose();
		ptmBridgeHandle = null;
		graftCapabilityRegistryHandle?.dispose();
		graftCapabilityRegistryHandle = null;
		intercomDetachHandle?.dispose();
		intercomDetachHandle = null;
		// Completed runs are skipped by abortAllRuns, so clear their live recovery
		// authority explicitly as well as descriptors on active runs.
		invalidateOwnedRecoveryDescriptors();
		// Issue #16: thread the SDK shutdown reason for diagnostics, but the
		// in-process runtime treats EVERY session replacement (`reload` / `new` /
		// `resume` / `fork` / `quit`) as terminal: the extension module is replaced
		// and live supervisor/worker closures cannot be re-wired. Active runs owned
		// by this process are persisted as aborted orphans instead of zombie
		// `running` entries.
		const terminatingRoots = listRuns()
			.filter((run) => run.completedAt === undefined && hasLocalRunAuthority(run))
			.filter((run) => (run.rootRunId ?? run.runId) === run.runId)
			.map((run) => run.runId);
		abortAllRuns(event.reason);
		// Keep the query authoritative throughout shutdown terminalization. Only
		// after abortAllRuns has durably removed local active registrations may the
		// foreground listener disappear.
		sessionActiveWorkQueryRegistryHandle?.dispose();
		sessionActiveWorkQueryRegistryHandle = null;
		clearAllActorActivity();
		for (const rootRunId of terminatingRoots) {
			cleanupEscalationsForRun({
				agentDir: getAgentDir(),
				rootRunId,
				reason: "Escalation cancelled because the root session shut down.",
			});
		}
		// Publish result.json for receipted runs this shutdown aborted, while the
		// core is still installed. Pi awaits session_shutdown handlers before it
		// invalidates the session. A failure is logged, never thrown: shutdown
		// must complete.
		if (shutdownContext !== undefined) {
			const client = createDelegateRuntimeClient({ context: shutdownContext, agentDir: getAgentDir() });
			for (const runId of receiptedActiveRunIds) {
				try {
					await client.harvest(runId);
				} catch (error) {
					logDelegateDiagnostic(
						`runtime API shutdown publication failed runId=${diagnosticIdentityText(runId)}: ${diagnosticErrorText(error)}`,
						{ agentDir: getAgentDir(), level: "warn" },
					);
				}
			}
		}
		currentForegroundContext = undefined;
		currentForegroundSessionId = undefined;
		// Withdraw the runtime API last: the registered handlers it invokes are
		// about to be invalidated, and a retained client must fail closed with
		// core-unavailable rather than reach them. Only this instance's core is
		// removed, so a successor module's fresh install is never clobbered.
		uninstallDelegateRuntimeCore(runtimeCore);
	});

	pi.on("turn_start", (_event, _ctx) => {
		if (shouldSkipForegroundLifecycleForDelegateOwnedApi(pi)) return;
		if (process.env.PI_DELEGATE_CHILD === "1") return;
		// A dispatch completion is delivered as a fresh foreground turn. Refresh
		// from the now-current session entries as well as runtime events so the
		// footer survives missed/stale delegate:* notifications and Pi UI resets.
		requestUsageStatusUpdate();
		// Opportunistically replay owner-matching escalation and completion wakes
		// through the same serialized arbitration tail used by maintenance.
		queueEscalationService(pi, { label: "turn-start" });
	});
	pi.on("turn_end", () => {
		if (shouldSkipForegroundLifecycleForDelegateOwnedApi(pi)) return;
		if (process.env.PI_DELEGATE_CHILD === "1") return;
		// Sync delegate calls append usage during the turn; async completion wakes
		// can also race footer rendering. Coalesce a post-turn recompute so the
		// visible footer is eventually driven from durable session/runtime data.
		requestUsageStatusUpdate();
	});

	// ───────────────────────────────────────────────────────────────────────────────────
	// Register the complete slash surface in one place: /delegate,
	// /delegate-cancel, /delegate-inspector, and /delegate-help.
	// ───────────────────────────────────────────────────────────────────────────────────
	const slashResultFromRuntimeTool = (
		result: DelegateRuntimeToolResult,
	): { text: string; isError?: boolean } => {
		const text =
			Array.isArray(result.content) && result.content[0]?.type === "text"
				? (result.content[0].text as string)
				: "(no output)";
		return { text, isError: result.isError === true };
	};

	const invokeDelegate = async (
		params: any,
		ctx: any,
	): Promise<{ text: string; isError?: boolean }> => {
		// Synthesize a fake toolCallId / signal for the in-process call.
		// Slash commands are user-initiated, so we honour ctx.signal when
		// available (Esc-to-cancel works) but fall back to a fresh
		// AbortController so executeDelegateTool always has a valid signal.
		const signal: AbortSignal = (ctx?.signal as AbortSignal) ?? new AbortController().signal;
		const toolCallId = `slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const result = await executeDelegateTool(toolCallId, params, signal, () => {}, ctx);
		return slashResultFromRuntimeTool(result);
	};

	const invokeCancel = async (
		params: DelegateCancelParams,
	): Promise<{ text: string; isError?: boolean }> => {
		const result = await delegateCancelTool.executeForInitiator(
			{
				runId: params.runId,
				...(params.forkName !== undefined ? { forkName: params.forkName } : {}),
				reason: "cancelled by user",
			},
			"user",
			currentForegroundSessionId,
		);
		return slashResultFromRuntimeTool(result);
	};

	const listCancelTargets = (): DelegateCancelTarget[] => {
		const targets: DelegateCancelTarget[] = [];
		for (const run of listRuns()) {
			if (run.completedAt !== undefined || !hasLocalRunAuthority(run)) continue;
			if (
				currentForegroundSessionId !== undefined &&
				run.ownerSessionId !== undefined &&
				run.ownerSessionId !== currentForegroundSessionId
			) continue;
			const mode = getDelegatePresentationTerminology(run.shape).label;
			for (const entry of Object.values(run.forks)) {
				if (!isLiveStatus(entry.status)) continue;
				const rendered = renderRunEntryIdentity(entry).replace(/\s+/g, " ").trim();
				const identity = rendered === entry.name ? entry.name : `${rendered} [${entry.name}]`;
				targets.push({
					runId: run.runId,
					entryName: entry.name,
					label: `${identity} · ${mode} · ${run.runId}`,
				});
			}
		}

		try {
			const statuses = listAllRunStatuses(
				getAgentDir(),
				undefined,
				currentForegroundSessionId,
			).statuses;
			for (const status of statuses) {
				if (status.source !== "detached" || !isUniformRunLive(status)) continue;
				if (targets.some((target) => target.runId === status.runId)) continue;
				targets.push({ runId: status.runId, label: `driver · ${status.runId}` });
			}
		} catch {
			// The in-memory targets remain useful if detached status storage is unavailable.
		}
		return targets;
	};

	setupDelegateOnly(pi, { config: startupConfig, agentDir: getAgentDir() });
	setupSlashCommands(pi, {
		footerIcons: startupConfig.footerIcons,
		invokeDelegate,
		invokeCancel,
		listCancelTargets,
		discoverAgents: (ctx) =>
			applyConfiguredAgentOverrides(
				discoverAgents(ctx.cwd, "both", configuredAgentDiscoveryOptions(ctx, ctx.cwd)),
			).agents,
		discoverAgentsWithWarnings: (ctx) =>
			applyConfiguredAgentOverrides(
				discoverAgents(ctx.cwd, "both", configuredAgentDiscoveryOptions(ctx, ctx.cwd)),
			),
		discoverChainsWithWarnings: (ctx) => {
			const configuredWarnings: string[] = [];
			const discovery = discoverAgentsAll(
				ctx.cwd,
				configuredAgentDiscoveryOptions(ctx, ctx.cwd, configuredWarnings),
			);
			return { chains: discovery.chains, warnings: [...configuredWarnings, ...discovery.warnings] };
		},
		getCompletionContext: () => currentForegroundContext,

		openInspector: async (ctx) => {
			if (overlayHandle) {
				await overlayHandle.open();
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Delegate inspector is unavailable in this session. Use `delegate_control` with action \"status\" to list active runs.",
					"info",
				);
			}
		},
	});

}
