/**
 * Phase A direct-mode dispatch glue.
 *
 * Maps the `{agent, task}` and `{tasks: […]}` user-facing shapes onto
 * `runDirectWorker` calls, with the same runtime-registry / status-widget /
 * transcript-overlay plumbing supervised mode uses. Sits next to
 * `pumpRuns` in `index.ts` and is invoked from the top of `execute()`
 * once shape detection chooses direct mode.
 *
 * Differences from supervised pumpRuns:
 *   - No supervisor clone. No supervisor session refs. No `steer` / pending
 *     guidance / heartbeat plumbing.
 *   - No worktree support in the single-direct shape; only parallel
 *     direct may set `worktree: true`.
 *   - Every shape dispatches in the background by default. Public
 *     `await: true` (or deprecated `sync: true`) selects blocking execution.
 *   - `cancel` is wired through `DelegateDispatchState.cancel`; steering is
 *     deliberately absent because direct workers have no supervisor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { workerArtifactReceipt, type WorkerArtifactReference } from "./artifact-workspace.js";
import { resolveChildCwd } from "./cwd-resolution.js";
import type { EnvOverrides } from "./env-overrides.js";
import { mergeEnvOverrides } from "./env-overrides.js";
import type { TasksSeed } from "./task-seam.js";
import { computeRunEntryDisplayLabels, renderRunEntryIdentity } from "./fork-label.js";
import { runDirectWorker, type DirectContext, type DirectRequest } from "./direct-runner.js";
import {
	applyInvocationOverrides,
	type InvocationAgentOverrides,
	type InvocationSkillOverride,
} from "./invocation-overrides.js";
import type { ResolvedBridge } from "./intercom-bridge.js";
import type { RunResult } from "./fork-runner.js";
import { formatForkWarningLines } from "./fork-warnings.js";
import { renderPromptRepairReport } from "./prompt-repair-seam.js";
import { runFailureReasonFor } from "./pending-wakes.js";
import type { RunFailureReason, RunFailureRecovery } from "./pending-wakes.js";
import type { ModelRuntimeLike } from "./sdk-model-runtime.js";
import type { EffectiveEscalationPolicy } from "./escalation-policy.js";
import type { ResolvedRunTimeoutPolicy } from "./fork-timeout.js";
import type { ResolvedEscalationConfig } from "./config.js";
import type { ModelScope, WorkerModelPlan } from "./model-selection.js";
import { resolveWriteConfinementRoot } from "./write-confinement.js";
import { unavailableMutationReport } from "./mutation-tracking.js";
import {
	type CancelReason,
	type RunLiveState,
	type DelegateDispatchState,
	projectToRunStatus,
	recordRunCompletedResult,
	projectRunLivePatch,
} from "./runtime.js";
import {
	cleanupWorktrees,
	createWorktreeDiffsDir,
	captureWorktreeDiffForEntry,
	diffWorktrees,
	formatWorktreeCaptureFailureGuidance,
	formatWorktreeDiffSummary,
	type WorktreeDiff,
	type WorktreeSetup,
} from "./worktree.js";

/** Resolve a per-task cwd against a base using the shared runtime rule. */
export function resolveDirectCwd(baseCwd: string, childCwd: string | undefined): string {
	return resolveChildCwd(baseCwd, childCwd);
}

/** Resolve slot writable roots against the dispatching main-thread cwd. */
export function resolveWritableRoots(baseCwd: string, roots: readonly string[] | undefined): string[] | undefined {
	if (!roots) return undefined;
	return roots
		.filter((root): root is string => typeof root === "string" && root.length > 0)
		.map((root) => resolveWriteConfinementRoot(baseCwd, root));
}

/** Resolve a per-run grant over an agent-level default. */
export function resolveParentTranscriptSearch(
	parentTranscriptSearch: boolean | undefined,
	agent: Pick<AgentConfig, "parentTranscriptSearch"> | undefined,
): boolean {
	return parentTranscriptSearch ?? agent?.parentTranscriptSearch ?? false;
}

/** Apply agent defaults + per-task overrides to produce a concrete DirectRequest. */
export function buildDirectRequest(args: {
	name: string;
	attempt?: number;
	retryOf?: { runId: string; forkName: string };
	displayLabel?: string;
	agent: AgentConfig;
	modelPlan?: WorkerModelPlan;
	task: string;
	tasks?: TasksSeed;
	/** Session focus carried by the handoff namespace. */
	focus?: unknown;
	artifact?: string | false;
	check?: string;
	reads?: Array<string | WorkerArtifactReference> | false;
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	interactive?: boolean;
	env?: EnvOverrides;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	chainDir?: string;
	/** Optional scratch root; when absent the worker allocates its own. */
	scratchRoot?: string;
	escalationPolicy?: EffectiveEscalationPolicy;
	/** Frozen wall-clock budget (#287); armed by `runDirectWorker`. */
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
}): DirectRequest {
	// Explicit false clears the corresponding agent-level default.
	const artifact =
		args.artifact === false
			? undefined
			: (args.artifact ?? args.agent.artifact);
	const check = args.check ?? args.agent.check;
	if (check !== undefined && artifact === undefined) {
		throw new TypeError(`direct run '${args.name}' check requires an artifact; remove check or declare artifact`);
	}
	const reads =
		args.reads === false
			? undefined
			: (args.reads ?? args.agent.defaultReads);
	const parentTranscriptSearch = resolveParentTranscriptSearch(args.parentTranscriptSearch, args.agent);
	const progress = args.progress ?? args.agent.defaultProgress ?? false;
	const interactive = args.interactive ?? args.agent.interactive ?? false;
	return {
		name: args.name,
		...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
		...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
		...(args.displayLabel !== undefined ? { displayLabel: args.displayLabel } : {}),
		agent: args.agent,
		...(args.modelPlan ? { modelPlan: args.modelPlan } : {}),
		task: args.task,
		...(args.tasks !== undefined ? { tasks: args.tasks } : {}),
		...(args.focus !== undefined ? { focus: args.focus } : {}),
		artifact,
		check,
		reads,
		parentTranscriptSearch,
		progress,
		interactive,
		env: mergeEnvOverrides(args.agent.env, args.env),
		writableRoots: args.writableRoots,
		confineWrites: args.confineWrites,
		readOnly: args.readOnly,
		chainDir: args.chainDir,
		...(args.scratchRoot === undefined ? {} : { scratchRoot: args.scratchRoot }),
		...(args.escalationPolicy !== undefined
			? { escalationPolicy: args.escalationPolicy }
			: {}),
		...(args.timeoutPolicy !== undefined ? { timeoutPolicy: args.timeoutPolicy } : {}),
	};
}

/** Per-task entry as it lands on `executeDirectShape`. */
export interface DirectTaskInput {
	name: string;
	/** Optional exact predecessor relationship for this direct slot. */
	retryOf?: { runId: string; forkName: string };
	/** Set by runtime admission; legacy/direct callers effectively use 1. */
	attempt?: number;
	/**
	 * Derived, NON-ADDRESSING label shown to humans (issues #151/#152). Absent
	 * on legacy/hand-built inputs, where surfaces fall back to `name`. Never
	 * used to address a worker or run entry.
	 */
	displayLabel?: string;
	/** Effective per-slot AgentConfig, including invocation-scoped overrides. */
	agent: AgentConfig;
	/** Immutable model plan resolved at the dispatch boundary. */
	modelPlan?: WorkerModelPlan;
	task: string;
	/**
	 * Checklist this dispatch carried (issue #226), parsed at the tool-arg
	 * boundary. Seeded into the worker's session before its first turn, or
	 * appended to its prompt as markdown when nothing claims the seed channel.
	 */
	tasks?: TasksSeed;
	/** Session focus carried by the handoff namespace. */
	focus?: unknown;
	cwd?: string;
	artifact?: string | false;
	check?: string;
	reads?: Array<string | WorkerArtifactReference> | false;
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	interactive?: boolean;
	env?: EnvOverrides;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	/** Frozen per-slot escalation policy staged during preflight. */
	escalationPolicy?: EffectiveEscalationPolicy;
	/** Raw slot budget fields retained for chain parallel resolution. */
	max_duration_ms?: number;
	wind_down_grace_ms?: number;
	/**
	 * Resolved wall-clock budget for this solo worker (#287). `runDirectWorker`
	 * arms one deadline for the complete run, including refusal fallbacks, and
	 * never recomputes it from later activity.
	 */
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
}

interface RawDirectTaskInput {
	name?: string;
	agent: AgentConfig;
	count?: number;
	retryOf?: { runId: string; forkName: string };
	task: string;
	tasks?: TasksSeed;
	focus?: unknown;
	cwd?: string;
	artifact?: string | false;
	check?: string;
	reads?: Array<string | WorkerArtifactReference> | false;
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	interactive?: boolean;
	env?: Record<string, string | null>;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	escalationPolicy?: EffectiveEscalationPolicy;
	timeoutPolicy?: ResolvedRunTimeoutPolicy;
	max_duration_ms?: number;
	wind_down_grace_ms?: number;
	model?: string;
	thinking?: string | false;
	thinkingMin?: string | false;
	thinkingMax?: string | false;
	fallbackModels?: string | string[];
	maxSubagentDepth?: number;
	skill?: InvocationSkillOverride;
	skills?: InvocationSkillOverride;
	[k: string]: any;
}

function invocationOverridesFromRawTask(raw: RawDirectTaskInput): InvocationAgentOverrides | undefined {
	const hasOverride =
		raw.model !== undefined ||
		raw.thinking !== undefined ||
		raw.thinkingMin !== undefined ||
		raw.thinkingMax !== undefined ||
		raw.fallbackModels !== undefined ||
		raw.maxSubagentDepth !== undefined ||
		raw.skill !== undefined ||
		raw.skills !== undefined ||
		raw.env !== undefined;
	if (!hasOverride) return undefined;
	return {
		model: raw.model,
		thinking: raw.thinking,
		thinkingMin: raw.thinkingMin,
		thinkingMax: raw.thinkingMax,
		fallbackModels: raw.fallbackModels,
		maxSubagentDepth: raw.maxSubagentDepth,
		skill: raw.skill,
		skills: raw.skills,
		...(raw.env !== undefined ? { env: raw.env } : {}),
	};
}

export interface ExecuteDirectShapeArgs {
	pi: ExtensionAPI;
	tasks: DirectTaskInput[];
	concurrency: number;
	worktree: boolean;
	worktreeSetupHook: string | undefined;
	worktreeSetupHookTimeoutMs: number | undefined;
	sync: boolean;
	signal: AbortSignal | undefined;
	taskSignals?: Record<string, AbortSignal>;
	ctxCwd: string;
	mainModel: { provider: string; id: string } | undefined;
	authStorage: any;
	modelRuntime?: ModelRuntimeLike;
	allowRegistryRuntimeFallback?: boolean;
	modelRegistry: any;
	scopedModelRefs?: ModelScope;
	agentDir: string;
	runId: string;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	/** Trusted parent branch snapshot, passed only when a task has the grant. */
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	/** Passed through; defaults to no progress / no output unless caller wires it. */
	scope?: string;
	/** Called every time partial results change (sync mode only). */
	onStreamUpdate?: (results: RunResult[]) => void;
}

export interface ExecuteDirectShapeResult {
	finalResults: RunResult[];
	worktreeDiffs: WorktreeDiff[];
	worktreeSuffix: string;
	combinedContent: string;
	anyFailed: boolean;
}

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
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

/**
 * Reason for a failure wake deferred until after worktree capture. A worker
 * that threw (crashed) keeps its crash reason instead of collapsing into the
 * generic outcome-derived reason.
 *
 * The crash deliberately wins over any `failureCause`/`errorKind` on the
 * result: the crash result is built from the last streamed partial, so those
 * fields describe an earlier state, not why the worker died.
 */
export function deferredFailureReason(
	workerCrashed: boolean,
	result: Pick<RunResult, "failureCause" | "errorKind">,
): RunFailureReason {
	return workerCrashed ? "fork-crashed" : runFailureReasonFor(result);
}

/**
 * Build the combined tool-result content for a batch of direct workers.
 * Single-task: collapsed text + warnings note (if any).
 * Multi-task: each task as a level-2 markdown section.
 *
 * Direct mode has no supervisor-session block — there is no supervisor and
 * `roundsUsed/maxRounds` is always 1/1; the worker session path is
 * surfaced as a single line under the heading instead.
 */
export function buildDirectCombinedContent(
	results: Array<RunResult & { outputFile?: { absolutePath: string }; activeToolNames?: string[] }>,
	worktreeSuffix: string,
	recoveryByWorker?: ReadonlyMap<string, RunFailureRecovery>,
): string {
	let body: string;
	const renderOne = (r: typeof results[number]) => {
		const lines: string[] = [];
		if (r.workerSessionFile) lines.push(`worker session: ${r.workerSessionFile}`);
		if (Array.isArray(r.activeToolNames)) lines.push(`tools: ${r.activeToolNames.join(", ") || "(none)"}`);
		if (r.outputFile) lines.push(`output: ${r.outputFile.absolutePath}`);
		if (r.error) lines.push(`error: ${r.error}`);
		const recovery = r.status === "failed" ? recoveryByWorker?.get(r.name) : undefined;
		if (recovery) {
			lines.push(recovery.available
				? `Recovery is available; call delegate_control action recover (strategy: ${recovery.strategy}).`
				: "Recovery is not available for this failure.");
		}
		if (r.policyRefusals?.length) {
			for (const refusal of r.policyRefusals) lines.push(`policy refusal: ${refusal.boundary}/${refusal.toolName}: ${refusal.reason}`);
		}
		if (r.mutationReport?.status === "tracked") {
			lines.push(`mutation tracking: tracked (${r.mutationReport.changedPaths.map((p) => JSON.stringify(p)).join(", ") || "no changed paths"})`);
		} else if (r.mutationReport?.status === "not-tracked") {
			lines.push(`mutation tracking: not tracked (${r.mutationReport.reason})`);
		}
		if (r.worktreeDiff?.captureFailed === true) {
			const guidance = formatWorktreeCaptureFailureGuidance(r.worktreeDiff);
			// The aggregate worktree summary already carries the full guidance;
			// point to it instead of repeating it in the same tool result.
			lines.push(worktreeSuffix.includes(guidance)
				? "worktree recovery: patch capture failed; the worktree was PRESERVED (see Worktree Changes below)"
				: `worktree recovery: ${guidance}`);
		} else if (r.worktreeDiff && (r.worktreeDiff.filesChanged > 0 || r.worktreeDiff.diffStat.trim().length > 0)) {
			lines.push(
				`worktree recovery: ${r.worktreeDiff.filesChanged} files, +${r.worktreeDiff.insertions} -${r.worktreeDiff.deletions}; ` +
				`branch ${r.worktreeDiff.branch}; patch ${r.worktreeDiff.patchPath}`,
			);
		}
		lines.push(...formatForkWarningLines(r.warnings));
		const meta = lines.length > 0 ? `<direct-session>\n${lines.join("\n")}\n</direct-session>\n\n` : "";
		const output = workerArtifactReceipt(r) ?? (r.collapsedContent || (r.error ? `error: ${r.error}` : "(no output)"));
		const repairReport = renderPromptRepairReport(r.promptRepairs ?? []);
		const text = repairReport ? `${repairReport}\n\n${output}` : output;
		return `${meta}${text}`;
	};
	if (results.length === 1) {
		body = renderOne(results[0]);
	} else {
		body = results
			.map((r) => {
				const header = `## ${renderRunEntryIdentity(r)} — ${r.status}`;
				return `${header}\n\n${renderOne(r)}`;
			})
			.join("\n\n---\n\n");
	}
	return worktreeSuffix ? `${body}\n\n${worktreeSuffix}` : body;
}

/**
 * Run a direct-mode batch end-to-end. Caller is responsible for wiring the
 * runtime-registry pieces (`registerRun`, dispatch-completion sendMessage
 * etc.); this function only OWNS:
 *   - per-task chain dir prep,
 *   - worktree create / diff / cleanup,
 *   - the parallel pump + runDirectWorker calls.
 *
 * Runtime-state mutation hooks (onUpdate, onRuntimeUpdate, onTranscriptEntry)
 * are wired per-task to the shared `runId/forkName` compatibility keys so the
 * existing status widget / transcript overlay code continues to work without
 * branching.
 */
export async function pumpDirectWorkers(args: {
	tasks: DirectTaskInput[];
	concurrency: number;
	signal: AbortSignal | undefined;
	taskSignals?: Record<string, AbortSignal>;
	ctxCwd: string;
	mainModel: { provider: string; id: string } | undefined;
	authStorage: any;
	modelRuntime?: ModelRuntimeLike;
	allowRegistryRuntimeFallback?: boolean;
	modelRegistry: any;
	scopedModelRefs?: ModelScope;
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly import("@earendil-works/pi-coding-agent").ToolDefinition[];
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	runId: string;
	ownerSessionId?: string;
	originatorEscalationConfig?: ResolvedEscalationConfig;
	worktreeSetup: WorktreeSetup | undefined;
	chainDir: string;
	/** Optional shared worker scratch root for the chain's private per-run scratch. Declared artifacts use the per-worktree artifact workspace, not this root. */
	scratchRoot?: string;
	onStreamUpdate?: (results: RunResult[]) => void;
	onForkRuntimeUpdate?: (forkName: string, patch: Partial<RunLiveState>) => void;
	onForkFailure?: (
		forkName: string,
		patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason; recovery?: RunFailureRecovery; worktreeDiff?: WorktreeDiff },
	) => boolean | void;
	/** Resolve the live recovery verdict for a direct worker failure. */
	getFailureRecovery?: (forkName: string) => RunFailureRecovery | undefined;
	onForkTranscriptEntry?: (forkName: string, entry: any) => void;
	sessionRefsByTask?: Record<string, { worker?: any }>;
	getCancelReasonByTask?: Record<string, () => CancelReason | undefined>;
	/** Legacy/pre-resolved bridge map retained for existing callers/tests. */
	intercomBridgeByTask?: Record<string, ResolvedBridge>;
	/**
	 * Preferred policy-aware resolver. It runs after worktree/per-task cwd
	 * selection so extension discovery sees the exact cwd the worker loader uses.
	 */
	resolveIntercomBridgeForTask?: (
		task: DirectTaskInput,
		effectiveCwd: string,
	) => Promise<ResolvedBridge | undefined>;
	/** Worker runner; defaults to `runDirectWorker`. Tests inject crashes here. */
	runWorker?: typeof runDirectWorker;
}): Promise<ExecuteDirectShapeResult> {
	const partialResults: RunResult[] = args.tasks.map((t) => ({
		name: t.name,
		attempt: t.attempt ?? 1,
		agent: t.agent.name,
		agentSource: t.agent.source,
		task: t.task,
		status: "pending",
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: "",
		transcript: [],
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
	}));
	const notifyStream = () => args.onStreamUpdate?.([...partialResults]);
	const recoveryByWorker = new Map<string, RunFailureRecovery>();

	let finalResults: RunResult[];
	let worktreeDiffs: WorktreeDiff[] = [];
	let worktreeSuffix = "";
	let worktreeDiffsDir: string | undefined;
	// Per-entry captures already published through results and early wakes.
	// The aggregate pass reuses them instead of capturing a second time.
	const capturedWorktreeDiffs = new Map<number, WorktreeDiff>();
	try {
		worktreeDiffsDir = args.worktreeSetup
			? createWorktreeDiffsDir(args.runId, "pi-delegate-direct-diffs")
			: undefined;
		finalResults = await mapConcurrent(args.tasks, args.concurrency, async (task, idx) => {
			let failureReported = false;
			let infrastructureCallbackFailed = false;
			let infrastructureCallbackFailure: unknown;
			const resolveFailureRecovery = () => {
				try {
					return args.getFailureRecovery?.(task.name);
				} catch {
					return undefined;
				}
			};
			const reportFailure = (reason: RunFailureReason = "fork-failed", recovery = resolveFailureRecovery(), worktreeDiff?: WorktreeDiff) => {
				if (failureReported) return;
				if (!args.onForkFailure) {
					failureReported = true;
					return;
				}
				try {
					failureReported = args.onForkFailure(
						task.name,
						{ status: "failed", reason, ...(recovery !== undefined ? { recovery } : {}), ...(worktreeDiff !== undefined ? { worktreeDiff } : {}) },
					) !== false;
				} catch {
					/* failure notification must never stop healthy siblings */
				}
			};
			const effectiveCwd = args.worktreeSetup
				? args.worktreeSetup.worktrees[idx]!.agentCwd
				: resolveDirectCwd(args.ctxCwd, task.cwd);
			let intercomBridge: ResolvedBridge | undefined;
			try {
				intercomBridge = args.resolveIntercomBridgeForTask
					? await args.resolveIntercomBridgeForTask(task, effectiveCwd)
					: args.intercomBridgeByTask?.[task.name];
			} catch (error) {
				const errorText = `intercom bridge policy resolution failed: ${error instanceof Error ? error.message : String(error)}`;
				const failed: RunResult = {
					...partialResults[idx]!,
					status: "failed",
					workerCwd: effectiveCwd,
					mutationReport: unavailableMutationReport("observation unavailable before worker construction"),
					error: errorText,
				};
				args.onForkRuntimeUpdate?.(task.name, {
					status: "failed",
					workerCwd: effectiveCwd,
					error: errorText,
				});
				reportFailure();
				if (!failureReported) reportFailure();
				recordRunCompletedResult(args.runId, task.name, failed);
				partialResults[idx] = failed;
				notifyStream();
				return failed;
			}
			const dctx: DirectContext = {
				cwd: effectiveCwd,
				mainModel: args.mainModel,
				authStorage: args.authStorage,
				modelRuntime: args.modelRuntime,
				allowRegistryRuntimeFallback: args.allowRegistryRuntimeFallback,
				modelRegistry: args.modelRegistry,
				scopedModelRefs: args.scopedModelRefs,
				agentDir: args.agentDir,
				ensureWorkerToolRegistration: args.ensureWorkerToolRegistration,
				getWorkerToolDefinitions: args.getWorkerToolDefinitions,
				ownerSessionId: args.ownerSessionId,
				...(task.parentTranscriptSearch && args.parentTranscriptEntries
					? { parentTranscriptEntries: args.parentTranscriptEntries }
					: {}),
				originatorEscalationConfig: args.originatorEscalationConfig,
				signal: args.taskSignals?.[task.name] ?? args.signal,
				runId: args.runId,
				forkName: task.name,
				getFailureRecovery: resolveFailureRecovery,
				childIndex: idx,
				sessionRefs: args.sessionRefsByTask?.[task.name],
				getCancelReason: args.getCancelReasonByTask?.[task.name],
				onUpdate: (u) => {
					const wasFailed = partialResults[idx]?.status === "failed";
					// Spec 0006: stream result-style updates through the named
					// projection so transient live-only states stay centrally aligned
					// with runtime liveness (`constructing`→`pending`,
					partialResults[idx] = {
						...partialResults[idx],
						status: u.status ? projectToRunStatus(u.status) : partialResults[idx].status,
						roundsUsed: u.currentRound ?? partialResults[idx].roundsUsed,
						workerSessionFile: u.workerSessionFile ?? partialResults[idx].workerSessionFile,
						workerCwd: effectiveCwd,
						error: u.error ?? partialResults[idx].error,
						errorKind: u.errorKind ?? partialResults[idx].errorKind,
					};
					if (u.status === "failed" && u.recovery !== undefined) {
						recoveryByWorker.set(task.name, u.recovery);
					}
					if (u.status === "failed" && !wasFailed && !infrastructureCallbackFailed && !args.worktreeSetup) {
						reportFailure(runFailureReasonFor(u), u.recovery);
					}
					notifyStream();
				},
				onRuntimeUpdate: args.onForkRuntimeUpdate
					? (patch) => {
						try {
							args.onForkRuntimeUpdate!(task.name, projectRunLivePatch(patch, effectiveCwd));
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
							args.onForkTranscriptEntry!(task.name, entry);
						} catch (error) {
							infrastructureCallbackFailed = true;
							infrastructureCallbackFailure = error;
							throw error;
						}
					}
					: undefined,
				intercomBridge,
			};
			const req = buildDirectRequest({
				name: task.name,
				...(task.displayLabel !== undefined ? { displayLabel: task.displayLabel } : {}),
				agent: task.agent,
				...(task.modelPlan ? { modelPlan: task.modelPlan } : {}),
				task: task.task,
				...(task.tasks !== undefined ? { tasks: task.tasks } : {}),
				...(task.focus !== undefined ? { focus: task.focus } : {}),
				artifact: task.artifact,
				check: task.check,
				reads: task.reads,
				parentTranscriptSearch: task.parentTranscriptSearch,
				progress: task.progress,
				attempt: task.attempt,
				retryOf: task.retryOf,
				interactive: task.interactive,
				writableRoots: task.writableRoots,
				confineWrites: task.confineWrites,
				readOnly: task.readOnly,
				env: mergeEnvOverrides(task.env, args.worktreeSetup?.worktrees[idx]?.gitEnv),
				chainDir: args.chainDir,
				scratchRoot: args.scratchRoot,
				escalationPolicy: task.escalationPolicy,
				// #287: hand the resolved budget to the runner, which owns arming it.
				timeoutPolicy: task.timeoutPolicy,
			});
			let result: RunResult;
			// A crash with a worktree defers its early wake until the capture below;
			// remember the cause so that deferred wake still reports a crash.
			let workerCrashed = false;
			try {
				result = await (args.runWorker ?? runDirectWorker)(req, dctx);
			} catch (error) {
				if (infrastructureCallbackFailed) throw infrastructureCallbackFailure;
				const errorText = error instanceof Error ? error.message : String(error);
				result = {
					...partialResults[idx]!,
					status: "failed",
					error: errorText,
					mutationReport: unavailableMutationReport("observation unavailable after worker setup failure"),
				};
				// Persist the terminal state before publishing the early wake. If this
				// infrastructure callback fails, propagate it without misreporting it as
				// another worker failure.
				args.onForkRuntimeUpdate?.(task.name, { status: "failed", error: errorText });
				workerCrashed = true;
				if (!args.worktreeSetup) reportFailure("fork-crashed");
			}
			if (infrastructureCallbackFailed) throw infrastructureCallbackFailure;
			// Capture this entry while its isolated worktree is still present. The
			// result then carries the same bounded recovery reference into runtime
			// persistence and the aggregate, instead of waiting until cleanup.
			if (args.worktreeSetup && worktreeDiffsDir !== undefined) {
				try {
					const captured = captureWorktreeDiffForEntry(
						args.worktreeSetup,
						idx,
						task.agent.name,
						worktreeDiffsDir,
					);
					capturedWorktreeDiffs.set(idx, captured);
					result.worktreeDiff = captured;
				} catch {
					result.mutationReport = unavailableMutationReport("worktree diff capture unavailable; recover the preserved worktree manually");
				}
			}
			if (result.status === "failed" && !failureReported) {
				reportFailure(deferredFailureReason(workerCrashed, result), undefined, result.worktreeDiff);
			}
			// Keep runtime persistence and stream callbacks outside the worker-execution
			// containment boundary. Their failures are infrastructure failures, not
			// evidence that the worker itself crashed.
			recordRunCompletedResult(args.runId, task.name, result);
			partialResults[idx] = result;
			notifyStream();
			return result;
		});
	} finally {
		if (args.worktreeSetup) {
			try {
				const diffsDir = worktreeDiffsDir ?? createWorktreeDiffsDir(args.runId, "pi-delegate-direct-diffs");
				worktreeDiffs = diffWorktrees(
					args.worktreeSetup,
					args.tasks.map((t) => t.agent.name),
					diffsDir,
					capturedWorktreeDiffs,
				);
				worktreeSuffix = formatWorktreeDiffSummary(worktreeDiffs);
			} catch {
				/* swallow so cleanup still runs */
			}
			try {
				cleanupWorktrees(args.worktreeSetup);
			} catch {
				/* don't shadow original error */
			}
		}
	}

	const anyFailed = finalResults.some((r) => r.status !== "completed");
	const combinedContent = buildDirectCombinedContent(finalResults, worktreeSuffix, recoveryByWorker);
	return { finalResults, worktreeDiffs, worktreeSuffix, combinedContent, anyFailed };
}

/**
 * Defense-in-depth: recover a stringified array param that snuck past schema
 * validation. Some Anthropic models (notably Claude Opus 4.x) occasionally
 * emit a tool-arg array as a JSON-encoded *string* when the tool params are
 * a top-level `anyOf` of object shapes. The Apr 2026 schema flatten in
 * `src/index.ts` removed the `anyOf` trigger, so in practice this coerce is
 * a no-op — pi-ai's `validateToolArguments` rejects stringified arrays
 * before `execute()` is ever called. We keep this helper anyway so:
 *
 *   - Direct callers (tests, internal callers that bypass pi-ai's
 *     validator) get the same recovery behaviour.
 *   - If pi-ai ever loosens its convert step to JSON-parse string args,
 *     `execute()` continues to do the right thing.
 *
 * Behaviour:
 *   - Mutates `params` in place. Each of `agents` / `tasks` / `chain`,
 *     when present as a string, is run through `JSON.parse` once. If the
 *     result is an array we replace the field; otherwise we leave the
 *     string in place so downstream validation surfaces a real error.
 *   - Returns a list of recovery notes for logging. Empty when nothing
 *     needed coercing.
 *
 * Exported for unit testing.
 */
export function coerceStringifiedArrayParams(params: any): string[] {
	if (!params || typeof params !== "object") return [];
	const notes: string[] = [];
	// `runs` is the advertised grammar since the #263 cutover; the same
	// provider quirk applies to it, and missing it here meant a stringified
	// `runs` fell through to the legacy router and died as "unknown shape" —
	// a nested smoke worker hit exactly that.
	for (const key of ["agents", "tasks", "chain", "runs"] as const) {
		const v = params[key];
		if (typeof v !== "string") continue;
		try {
			const parsed = JSON.parse(v);
			if (Array.isArray(parsed)) {
				params[key] = parsed;
				notes.push(`coerced ${key}: string(${v.length}) → array(${parsed.length})`);
			}
		} catch {
			/* leave the string in place — schema validation will report it */
		}
	}
	return notes;
}

/**
 * Phase A: detect which user-facing shape was supplied.
 *
 * Order of detection matters because TypeBox.Union accepts the first
 * matching alternative — we prefer the most specific shape:
 *   1. `agents: [...]`     → supervised
 *   2. `tasks:  [...]`     → parallel direct
 *   3. `orchestrate: {...}`→ detached orchestrate driver (spec 0005)
 *   4. `agent` + `task`    → single direct
 *
 * `orchestrate` (spec 0005) is the fifth run shape: a clone of the originator
 * spawned as a DETACHED child process that drives a long-running pipeline. Its
 * selector is an OBJECT (`{agent, task, model?, maxSubagentDepth?}`), distinct
 * from the array selectors of `agents`/`tasks`/`chain` and the string selector
 * of `{agent,task}`, so it composes into the SAME exactly-one-of mutual-
 * exclusivity rule the other four shapes obey.
 */
export function detectShape(params: any):
	| "supervised"
	| "parallel-direct"
	| "single-direct"
	| "orchestrate"
	| "chain"
	| "chain-by-name"
	| "action"
	| "unknown"
	| "ambiguous" {
	const hasAction = typeof params?.action === "string" && params.action.length > 0;
	const hasAgents = Array.isArray(params?.agents);
	const hasTasks = Array.isArray(params?.tasks);
	const hasChain = Array.isArray(params?.chain);
	// chain-by-name has two equivalent spellings:
	//   chain: "my-chain"     — pi-subagents-style overload
	//   chainName: "my-chain" — explicit form, clearer for tool callers
	const hasChainAsString = typeof params?.chain === "string" && params.chain.length > 0;
	const hasChainName = typeof params?.chainName === "string" && params.chainName.length > 0;
	const hasNamedChain = hasChainAsString || hasChainName;
	// Single-direct requires both agent AND task strings; we allow {agent}
	// alone to coexist with {chain} (e.g. user supplied an agent-named
	// chain.task = "{previous}" pattern), so check task presence too.
	const hasAgent = typeof params?.agent === "string" && typeof params?.task === "string";
	// Orchestrate is selected by an `orchestrate` OBJECT carrying the hosted
	// driver. A non-object / array `orchestrate` is not a valid selector and is
	// ignored here (downstream validation reports it).
	const hasOrchestrate =
		params?.orchestrate !== null &&
		typeof params?.orchestrate === "object" &&
		!Array.isArray(params?.orchestrate);

	// Action mode is special: when set, ALL run shapes are ignored. The
	// management surface (list/get/create/update/delete) doesn't compose
	// with running an agent, so we accept it standalone even if other
	// fields are set (those become the management payload — `agent` and
	// `chainName` here are TARGETS, not runners).
	if (hasAction) return "action";

	// Inline chain-array and named-chain are mutually exclusive — if both
	// are set, that's caller error.
	const set = [hasAgents, hasTasks, hasChain, hasNamedChain, hasAgent, hasOrchestrate].filter(Boolean).length;
	if (set === 0) return "unknown";
	if (set > 1) return "ambiguous";
	if (hasAgents) return "supervised";
	if (hasTasks) return "parallel-direct";
	if (hasOrchestrate) return "orchestrate";
	if (hasChain) return "chain";
	if (hasNamedChain) return "chain-by-name";
	return "single-direct";
}

/**
 * Expand a `tasks:[…]` array's per-entry `count` shorthand into a flat list
 * of named DirectTaskInputs. Each duplicate gets a `#N` suffix on its name
 * (matching pi-subagents' convention) so the runtime/overlay can tell
 * sibling fan-outs apart.
 *
 * Also performs uniqueness deduplication for non-`count` collisions: two
 * tasks declaring the same `name:` get sequential `#2`, `#3`, … suffixes.
 *
 * Each expanded task also carries a derived `displayLabel` (issue #152). That
 * label is for humans only — `name` remains the addressing key, and its
 * derivation above is untouched.
 *
 * Pure function — exported for tests.
 */
export function expandParallelTasks(args: {
	rawTasks: RawDirectTaskInput[];
}): Array<DirectTaskInput> {
	const labels = new Map<string, number>();
	const out: DirectTaskInput[] = [];
	/** Parallel to `out`: whether the caller supplied `name:` for that slot. */
	const named: boolean[] = [];
	for (const raw of args.rawTasks) {
		const baseAgent = raw.agent;
		const baseLabel = raw.name ?? baseAgent.name;
		const repeats = Math.max(1, Math.floor(raw.count ?? 1));
		if (raw.retryOf !== undefined && typeof raw.count === "number" && raw.count > 1) {
			throw new Error("retryOf cannot be combined with count > 1");
		}
		for (let i = 0; i < repeats; i++) {
			const candidate = i === 0 ? baseLabel : `${baseLabel}#${i + 1}`;
			const collisions = (labels.get(candidate) ?? 0) + 1;
			labels.set(candidate, collisions);
			const finalLabel = collisions > 1 ? `${candidate}#${collisions}` : candidate;
			const agent = applyInvocationOverrides(baseAgent, invocationOverridesFromRawTask(raw));
			named.push(raw.name !== undefined);
			out.push({
				name: finalLabel,
				...(raw.retryOf !== undefined ? { retryOf: raw.retryOf } : {}),
				agent,
				task: raw.task,
				...(raw.tasks !== undefined ? { tasks: raw.tasks } : {}),
				...(raw.focus !== undefined ? { focus: raw.focus } : {}),
				cwd: raw.cwd,
				artifact: raw.artifact,
				check: raw.check,
				reads: raw.reads,
				parentTranscriptSearch: raw.parentTranscriptSearch ?? raw.agent.parentTranscriptSearch ?? false,
				progress: raw.progress,
				interactive: raw.interactive,
				writableRoots: raw.writableRoots,
				confineWrites: raw.confineWrites,
				readOnly: raw.readOnly,
				env: raw.env,
				...(raw.escalationPolicy !== undefined
					? { escalationPolicy: raw.escalationPolicy }
					: {}),
				...(raw.timeoutPolicy !== undefined
					? { timeoutPolicy: raw.timeoutPolicy }
					: {}),
				...(raw.max_duration_ms !== undefined ? { max_duration_ms: raw.max_duration_ms } : {}),
				...(raw.wind_down_grace_ms !== undefined ? { wind_down_grace_ms: raw.wind_down_grace_ms } : {}),
			});
		}
	}
	const displayLabels = computeRunEntryDisplayLabels(
		out.map((task, index) => ({
			name: task.name,
			named: named[index] === true,
			task: task.task,
			agentName: task.agent.name,
		})),
	);
	for (let index = 0; index < out.length; index++) {
		out[index]!.displayLabel = displayLabels[index] ?? out[index]!.name;
	}
	return out;
}

/**
 * Construct the initial `DelegateDispatchState` for a direct-mode batch. Mirrors
 * the registration block in supervised execute() but skips the steer/clone
 * plumbing that's irrelevant in direct mode.
 *
 * Returns `{ runState, sessionRefsByTask }` so the caller can later cancel
 * a specific task's worker session (if needed).
 */
export function buildDirectRunState(args: {
	runId: string;
	rootRunId?: string;
	ownerSessionId?: string;
	notifyOnFailure?: boolean;
	tasks: DirectTaskInput[];
	dispatchAbort: AbortController;
}): {
	runState: DelegateDispatchState;
	sessionRefsByTask: Record<string, { worker?: any }>;
} {
	const sessionRefsByTask: Record<string, { worker?: any }> = {};
	for (const t of args.tasks) sessionRefsByTask[t.name] = {};
	const runState: DelegateDispatchState = {
		runId: args.runId,
		rootRunId: args.rootRunId ?? args.runId,
		ownerSessionId: args.ownerSessionId,
		// Issue #76 — single-direct AND parallel-direct are both `direct`; entry
		// count alone used to report a multi-task fan-out as `supervised`.
		shape: "direct",
		notifyOnFailure: args.notifyOnFailure !== false,
		createdAt: Date.now(),
		forks: Object.fromEntries(
			args.tasks.map((t) => [
				t.name,
				{
					name: t.name,
					...(t.retryOf !== undefined ? { retryOf: t.retryOf } : {}),
					...(t.attempt !== undefined ? { attempt: t.attempt } : {}),
					...(t.displayLabel !== undefined ? { displayLabel: t.displayLabel } : {}),
					agent: t.agent.name,
					agentSource: t.agent.source,
					task: t.task,
					...(t.agent.model ? { requestedModel: t.agent.model } : {}),
					...(t.agent.skills ? { skills: [...t.agent.skills] } : {}),
					confineWrites: t.confineWrites !== false,
					...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}),
					...(t.modelPlan ? { resolvedModel: t.modelPlan.primary.canonicalRef } : {}),
					collapseMode: "final_output" as const,
					status: "pending" as const,
					currentRound: 0,
					maxRounds: 1,
					...(t.timeoutPolicy !== undefined ? { timeoutPolicy: t.timeoutPolicy } : {}),
					transcript: [],
					pendingGuidance: [],
					interactive: t.interactive ?? false,
				} satisfies RunLiveState,
			]),
		),
		abort: () => args.dispatchAbort.abort(),
		// Cancel is wired below by the caller (it needs sessionRefsByTask).
		cancel: async () => {
			throw new Error("cancel wired below");
		},
	};
	return { runState, sessionRefsByTask };
}
