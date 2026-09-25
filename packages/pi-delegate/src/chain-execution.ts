/**
 * Phase B: chain executor.
 *
 * Sequential pipeline of direct-mode worker steps with optional parallel
 * fan-out per step. Mirrors pi-subagents' `subagent({ chain: [...] })`
 * surface so chain files written for either extension are interchangeable.
 *
 * Schema (see `index.ts` for the TypeBox source of truth):
 *
 *   chain: [
 *     { agent, task?, ... },                         // sequential step
 *     { parallel: [{ agent, task?, count?, ... }] }, // fan-out step
 *     ...
 *   ]
 *
 * Template variables (see `chain-substitute.ts`):
 *   {task}      — original chain task (constant)
 *   {previous}  — collapsed output of the previous step
 *   {chain_dir} — absolute path to the per-run chain artifact directory
 *
 * Execution model:
 *   - Steps run sequentially and a failed step halts the chain. For a
 *     parallel step, `failFast` controls whether a first failure cooperatively
 *     aborts still-running siblings; it defaults to false.
 *   - A parallel step uses `pumpDirectWorkers` for fan-out. Tasks run
 *     concurrently up to `concurrency`. Aggregated output (formatted
 *     via `formatParallelAggregate`) becomes `{previous}` for the next
 *     sequential step.
 *   - Each step gets its own `name` in the runtime registry: sequential
 *     steps use `step{N}-{agent}`; parallel-step children use
 *     `step{N}.{agent}` (with `#` suffixes for `count`/duplicate names).
 *
 * Phase B does NOT yet implement `supervisor: true` per-step opt-in
 * (deferred to a follow-up — see docs/subagent-parity-plan.md §11.5).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentConfig,
	AgentScope,
	ChainRunStepFileConfig,
	ChainWorkerStepFileConfig,
} from "./agents.js";
import { discoverAgents, isChainRunStepFileConfig } from "./agents.js";
import type { EnvOverrides } from "./env-overrides.js";
import { formatParallelAggregate, substituteChainTemplate } from "./chain-substitute.js";
import {
	buildDirectRequest,
	pumpDirectWorkers,
	resolveParentTranscriptSearch,
	type DirectTaskInput,
	expandParallelTasks,
} from "./direct-shape.js";
import { runDirectWorker, type DirectContext } from "./direct-runner.js";
import {
	applyInvocationOverrides,
	type InvocationAgentOverrides,
	type InvocationSkillOverride,
} from "./invocation-overrides.js";
import type { DelegateConfig } from "./config.js";
import type { ModelScope } from "./model-selection.js";
import type { EffectiveEscalationPolicy } from "./escalation-policy.js";
import { resolveRunTimeoutPolicy } from "./fork-timeout.js";
import {
	resolveIntercomBridgeWithPolicy,
	type ResolvedBridge,
} from "./intercom-bridge.js";
import type { RunResult } from "./fork-runner.js";
import { formatForkWarningLines } from "./fork-warnings.js";
import { runFailureReasonFor } from "./pending-wakes.js";
import type { RunFailureReason } from "./pending-wakes.js";
import { prepareChainDir } from "./output-file.js";
import {
	validateRetainedWorkerArtifact,
	workerArtifactReceipt,
	type WorkerArtifactReference,
} from "./artifact-workspace.js";
import { unavailableMutationReport } from "./mutation-tracking.js";
import { projectRunLivePatch, recordRunCompletedResult, type CancelReason, type RunLiveState } from "./runtime.js";
import { savedChainContextForStep } from "./saved-chain-context.js";
import {
	prepareSavedChainRunStep,
	runSavedChainCommand,
	type PreparedSavedChainRunStep,
} from "./saved-chain-run.js";
import { parseSlotTasks } from "./task-seam.js";

// ── Public types ────────────────────────────────────────────────────────────

export type ChainStep = ChainSequentialStep | ChainRunStep | ChainParallelStep;

export interface ChainRunStep {
	run: string;
	command: string;
	cwd?: string;
	env?: EnvOverrides;
	timeoutMs?: number;
	agent?: never;
	parallel?: never;
}
export interface ChainSequentialStep {
	name?: string;
	agent: string;
	run?: never;
	/**
	 * Task body. Defaults to `"{previous}"` for steps after the first; the
	 * first step's task defaults to the original chain task `{task}`.
	 */
	task?: string;
	cwd?: string;
	artifact?: string | false;
	reads?: Array<string | WorkerArtifactReference> | false;
	/** Grant this chain step capped access to the trusted parent transcript snapshot. */
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	skill?: InvocationSkillOverride;
	skills?: InvocationSkillOverride;
	model?: string;
	env?: EnvOverrides;
	thinking?: string | false;
	thinkingMin?: string | false;
	thinkingMax?: string | false;
	fallbackModels?: string | string[];
	maxSubagentDepth?: number;
	interactive?: boolean;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	/**
	 * Per-step wall-clock budget (#287). Carried on the step because an
	 * after-gated solo dispatch compiles to a chain, and the budget the caller
	 * set on those entries has to survive the compile to be enforceable.
	 */
	max_duration_ms?: number;
	wind_down_grace_ms?: number;
	/** Frozen per-slot escalation policy staged during preflight. */
	escalationPolicy?: EffectiveEscalationPolicy;
	/**
	 * Task checklist for this step (#266, closing the #230 gap).
	 *
	 * A chain step is an ordinary direct worker and must be able to receive a
	 * checklist like any other. `handoff: { tasks }` on a canonical chain entry
	 * compiles to this key, and both spellings are read below, because a chain
	 * assembled by hand may still use either.
	 */
	checklist?: unknown;
	/** Session focus carried by the handoff namespace. */
	focus?: unknown;
	handoff?: Record<string, unknown>;
}

export interface ChainParallelStep {
	parallel: Array<ChainSequentialStep & { count?: number; name?: string }>;
	run?: never;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

/** Convert a persisted step to the runtime chain shape. */
export function chainFileStepToRuntimeStep(step: ChainWorkerStepFileConfig): ChainSequentialStep;
export function chainFileStepToRuntimeStep(step: ChainRunStepFileConfig): ChainRunStep;
export function chainFileStepToRuntimeStep(
	step: ChainWorkerStepFileConfig | ChainRunStepFileConfig,
): ChainSequentialStep | ChainRunStep;
export function chainFileStepToRuntimeStep(
	step: ChainWorkerStepFileConfig | ChainRunStepFileConfig,
): ChainSequentialStep | ChainRunStep {
	if (isChainRunStepFileConfig(step)) {
		const runtime: ChainRunStep = { run: step.run, command: step.command };
		if (step.cwd !== undefined) runtime.cwd = step.cwd;
		if (step.env !== undefined) runtime.env = step.env;
		if (step.timeoutMs !== undefined) runtime.timeoutMs = step.timeoutMs;
		return runtime;
	}
	const runtime: ChainSequentialStep = { agent: step.agent };
	if (step.task) runtime.task = step.task;
	if (step.env !== undefined) runtime.env = step.env;
	const artifact = (step as ChainWorkerStepFileConfig & { artifact?: string | false }).artifact;
	if (artifact !== undefined) runtime.artifact = artifact;
	if (step.reads !== undefined) runtime.reads = step.reads;
	if (step.model) runtime.model = step.model;
	if (step.thinking !== undefined) runtime.thinking = step.thinking;
	if (step.thinkingMin !== undefined) runtime.thinkingMin = step.thinkingMin;
	if (step.thinkingMax !== undefined) runtime.thinkingMax = step.thinkingMax;
	if (step.skills !== undefined) runtime.skill = step.skills;
	if (step.progress !== undefined) runtime.progress = step.progress;
	return runtime;
}

/**
 * What the executor reports per step. Each entry in this array is one
 * runtime-registry run entry — sequential steps produce one entry; parallel
 * steps produce one entry per fan-out slot.
 */
export interface ChainStepResult {
	stepIndex: number;
	stepKind: "sequential" | "run" | "parallel";
	/** runtime-registry name for this step entry. */
	name: string;
	/** RunResult-shaped per-task result. Multiple per parallel step. */
	results: RunResult[];
	/** What this step contributed to `{previous}` for the next step. */
	collapsedForNext: string;
	/** True when this step ran cleanly. False halts the chain. */
	ok: boolean;
}

export interface ChainExecutionResult {
	steps: ChainStepResult[];
	chainDir: string;
	combinedContent: string;
	anyFailed: boolean;
}

export interface ExecuteChainArgs {
	steps: ChainStep[];
	chainTask: string;
	scope: AgentScope;
	cwd: string;
	mainModel: { provider: string; id: string } | undefined;
	authStorage: any;
	allowRegistryRuntimeFallback?: boolean;
	modelRegistry: any;
	scopedModelRefs?: ModelScope;
	agentDir: string;
	/** Register deferred worker tools without advertising them foreground. */
	ensureWorkerToolRegistration?: (names: readonly string[]) => void | (() => void);
	/** Definitions for deferred tools, supplied as worker-local custom tools. */
	getWorkerToolDefinitions?: (names: readonly string[]) => readonly import("@earendil-works/pi-coding-agent").ToolDefinition[];
	/** Trusted parent branch snapshot, passed only when a chain step has the grant. */
	parentTranscriptEntries?: readonly import("@earendil-works/pi-coding-agent").SessionEntry[];
	runId: string;
	/** Owning foreground session id used to scope durable completion wakes. */
	ownerSessionId?: string;
	signal?: AbortSignal;
	/** Optional per-entry signal. The parent signal remains authoritative and is combined with it. */
	getForkSignal?: (forkName: string) => AbortSignal | undefined;
	/** Resolve the cancellation reason for one entry, falling back to the run-level reason. */
	getCancelReason?: (forkName?: string) => CancelReason | undefined;
	/** Hooked by the dispatch glue in index.ts so the runtime registry stays live. */
	onForkRuntimeUpdate?: (forkName: string, patch: Partial<RunLiveState>) => void;
	/** Optional early terminal-failure notification hook. */
	onForkFailure?: (
		forkName: string,
		patch: Pick<RunLiveState, "status"> & { reason?: RunFailureReason },
	) => boolean | void;
	onForkTranscriptEntry?: (forkName: string, entry: any) => void;
	/** Pre-resolved chainDir override; if absent we derive one. */
	chainDir?: string;
	/**
	 * Scratch root for every step's worker. When absent each worker allocates
	 * its own, which is the normal path; supplying one lets a caller place a
	 * file a step will read through `artifact`.
	 */
	scratchRoot?: string;
	/** Discovered agents — supplied by the caller so we don't re-walk the FS. */
	agents?: AgentConfig[];
	/** Non-fatal discovery diagnostics to include in unknown-agent failures. */
	discoveryWarnings?: string[];
	/**
	 * Phase D: caller's resolved DelegateConfig — used to resolve the
	 * intercom bridge per chain step. Optional; when absent the bridge is
	 * never injected.
	 */
	config?: DelegateConfig;
	/** Test/integration seam; production falls back to the shared policy resolver. */
	resolveIntercomBridgeForTask?: (
		agent: AgentConfig,
		effectiveCwd: string,
	) => Promise<ResolvedBridge | undefined>;
}

function chainEntrySignal(
	ctx: Pick<ExecuteChainArgs, "signal" | "getForkSignal">,
	forkName: string,
	additional?: AbortSignal,
): AbortSignal | undefined {
	const signals = [ctx.signal, ctx.getForkSignal?.(forkName), additional].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

/** Retry once when the early failure wake was not acknowledged as delivered. */
function reportChainWorkerFailure(
	ctx: Pick<ExecuteChainArgs, "onForkFailure">,
	workerName: string,
	patch: Pick<RunLiveState, "status"> & { reason: RunFailureReason },
): void {
	if (!ctx.onForkFailure) return;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			if (ctx.onForkFailure(workerName, patch) !== false) return;
		} catch {
			// Notification delivery must not stop the chain's terminal bookkeeping.
		}
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function resolveChainIntercomBridge(
	ctx: ExecuteChainArgs,
	agent: AgentConfig,
	effectiveCwd: string,
): Promise<ResolvedBridge | undefined> {
	if (ctx.resolveIntercomBridgeForTask) {
		return ctx.resolveIntercomBridgeForTask(agent, effectiveCwd);
	}
	if (!ctx.config) return undefined;
	return resolveIntercomBridgeWithPolicy({
		config: ctx.config,
		agent,
		directMode: true,
		cwd: effectiveCwd,
		agentDir: ctx.agentDir,
	});
}

/**
 * Resolve an agent name to its config from the supplied / freshly-discovered
 * registry. Throws (caller catches and converts to a step failure) so
 * unknown-agent chains don't run partial work.
 */
function resolveAgent(agents: AgentConfig[], name: string, warnings: readonly string[] = []): AgentConfig {
	const found = agents.find((a) => a.name === name);
	if (!found) {
		const available = agents.map((a) => a.name).join(", ") || "(none)";
		const suffix = warnings.length
			? `\nDiscovery warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
			: "";
		throw new Error(`Unknown agent "${name}" — available: ${available}${suffix}`);
	}
	return found;
}

/**
 * Resolve the per-step cwd against the chain-level cwd.
 */
function resolveStepCwd(baseCwd: string, stepCwd: string | undefined): string {
	if (!stepCwd) return baseCwd;
	return path.isAbsolute(stepCwd) ? stepCwd : path.resolve(baseCwd, stepCwd);
}

interface ChainArtifact {
	outputName: string;
	absolutePath: string;
	artifactRef?: WorkerArtifactReference;
	stepKind: ChainStepResult["stepKind"];
	producerName: string;
}

type ChainArtifactRead = string | WorkerArtifactReference;

/** Effective output declarations retained for artifact collection after a step runs. */
const effectiveOutputsByStep = new WeakMap<ChainStepResult, ReadonlyMap<string, string | undefined>>();

/** Resolve only exact relative reads matches to validated earlier outputs. */
function resolveChainReads(
	reads: ChainArtifactRead[] | false | undefined,
	artifacts: readonly ChainArtifact[],
): ChainArtifactRead[] | false | undefined {
	if (!Array.isArray(reads)) return reads;
	return reads.map((read) => {
		if (typeof read !== "string" || path.isAbsolute(read)) return read;
		const matches = artifacts.filter((artifact) => artifact.outputName === read);
		const parallelMatches = matches.filter((artifact) => artifact.stepKind === "parallel");
		if (parallelMatches.length > 1) {
			const producers = [...parallelMatches]
				.sort((left, right) => left.producerName.localeCompare(right.producerName))
				.map((artifact) => artifact.producerName)
				.join(", ");
			throw new Error(
				`Ambiguous chain artifact read "${read}": earlier parallel producers ${producers} declared the same artifact`,
			);
		}
		const match = matches.at(-1);
		return match?.artifactRef ?? read;
	});
}

function collectChainArtifacts(
	result: ChainStepResult,
	effectiveOutputs: ReadonlyMap<string, string | undefined>,
): ChainArtifact[] {
	const artifacts: ChainArtifact[] = [];
	for (const workerResult of result.results) {
		if (workerResult.status !== "completed") continue;
		const projected = workerResult as RunResult & { outputFile?: { absolutePath?: string }; artifactRef?: WorkerArtifactReference };
		const outputFile = projected.outputFile;
		if (!outputFile?.absolutePath || !projected.artifactRef) continue;
		const artifactRef = validateRetainedWorkerArtifact(projected.artifactRef);
		const absolutePath = path.resolve(outputFile.absolutePath);
		if (absolutePath !== path.resolve(artifactRef.absolutePath)) continue;
		const outputName = effectiveOutputs.get(workerResult.name);
		if (!outputName || path.isAbsolute(outputName)) continue;
		try {
			if (!fs.statSync(absolutePath).isFile()) continue;
		} catch {
			continue;
		}
		artifacts.push({
			outputName,
			absolutePath: outputFile.absolutePath,
			artifactRef,
			stepKind: result.stepKind,
			producerName: workerResult.name,
		});
	}
	return artifacts;
}

export function invocationOverridesFromStep(step: ChainSequentialStep): InvocationAgentOverrides | undefined {
	const hasOverride =
		step.model !== undefined ||
		step.thinking !== undefined ||
		step.thinkingMin !== undefined ||
		step.thinkingMax !== undefined ||
		step.fallbackModels !== undefined ||
		step.maxSubagentDepth !== undefined ||
		step.skill !== undefined ||
		step.skills !== undefined ||
		step.env !== undefined;
	if (!hasOverride) return undefined;
	return {
		model: step.model,
		thinking: step.thinking,
		thinkingMin: step.thinkingMin,
		thinkingMax: step.thinkingMax,
		fallbackModels: step.fallbackModels,
		maxSubagentDepth: step.maxSubagentDepth,
		skill: step.skill,
		skills: step.skills,
		...(step.env !== undefined ? { env: step.env } : {}),
	};
}

/**
 * Render the per-step "name" used in the runtime-registry. Stable so
 * `delegate_status` and the transcript overlay can refer to it later.
 *
 *   stepIndex=0, sequential, agent=scout    → "step1-scout"
 *   stepIndex=1, parallel slot 0 of worker  → "step2.worker"
 *   stepIndex=1, parallel slot 1 of worker  → "step2.worker#2"
 *
 * @internal Exported ONLY for chain-execution unit tests (issue #13 nit) —
 * not part of the public surface; external consumers should treat run-entry
 * names as opaque strings.
 */
export function buildSequentialStepName(stepIndex: number, agent: string): string {
	return `step${stepIndex + 1}-${agent}`;
}

/** @internal See {@link buildSequentialStepName} — test-only export. */
export function buildParallelStepName(stepIndex: number, slotName: string): string {
	return `step${stepIndex + 1}.${slotName}`;
}

/** Pure chain-step → DirectRequest builder, including the staged §5 policy. */
export function buildChainDirectRequest(args: {
	name: string;
	agent: AgentConfig;
	task: string;
	step: ChainSequentialStep;
	chainDir: string;
	scratchRoot?: string;
	/** Operator timeout bounds and default grace; the step and agent layer over them. */
	globalTimeouts?: { maxDurationMs?: unknown; windDownGraceMs?: unknown; minDurationMs?: unknown; enforceWallClockBudget?: unknown };
}) {
	const request = buildDirectRequest({
		name: args.name,
		agent: args.agent,
		task: args.task,
		reads: args.step.reads,
		parentTranscriptSearch: args.step.parentTranscriptSearch,
		progress: args.step.progress,
		interactive: args.step.interactive,
		writableRoots: args.step.writableRoots,
		confineWrites: args.step.confineWrites,
		readOnly: args.step.readOnly,
		env: args.step.env,
		chainDir: args.chainDir,
		scratchRoot: args.scratchRoot,
		escalationPolicy: args.step.escalationPolicy,
		// #287: resolve the step's own budget so `runDirectWorker` can arm it.
		// Passing the raw fields would not be enough — the runner reads a frozen
		// ResolvedRunTimeoutPolicy, and resolving here applies the same
		// invocation > agent > global precedence every other solo path uses.
		timeoutPolicy: resolveRunTimeoutPolicy({
			global: args.globalTimeouts,
			agent: args.agent,
			invocation: {
				maxDurationMs: args.step.max_duration_ms,
				windDownGraceMs: args.step.wind_down_grace_ms,
			},
		}),
		// Parsed into the seed the runner consumes, exactly as the direct path
		// does. Omitting this is what made `handoff` silently vanish for every
		// chain step.
		//
		// A PRODUCTION step always arrives with `checklist`: toLegacySlot lifts
		// `handoff.tasks` into it and drops `handoff` itself, and a saved chain
		// file carries neither field. The `handoff.tasks` branch is therefore
		// defensive, for a step built by hand — in a test, or by a future
		// programmatic caller — and is read first only so such a step behaves the
		// way its author wrote it.
		tasks: parseSlotTasks(args.step.handoff?.tasks ?? args.step.checklist),
		focus: args.step.focus ?? args.step.handoff?.focus,
	});
	const stepArtifact = args.step.artifact;
	const agentArtifact = (args.agent as AgentConfig & { artifact?: string }).artifact;
	return {
		...request,
		artifact: effectiveStepArtifactName(stepArtifact, agentArtifact),
	};
}

/**
 * The artifact filename a step effectively produces, resolving an agent-level
 * default. An explicit `false` on the step suppresses the agent default;
 * otherwise the step's own declaration wins, then the agent default. Returns
 * `undefined` when nothing is produced.
 *
 * This is the single source of truth for "does this step produce an artifact,
 * and under what name". The pre-launch parallel-collision guard and the
 * workspace-lease decision both call it so a slot that inherits its artifact
 * from the agent default is not invisible to them (a slot that omits
 * `artifact:` but resolves to the same agent default as a sibling must still be
 * caught before both launch and race the shared workspace file).
 */
export function effectiveStepArtifactName(
	declared: string | false | undefined,
	agentDefault: string | undefined,
): string | undefined {
	if (declared === false) return undefined;
	return declared ?? agentDefault;
}

/** Type guard for a native deterministic saved-chain stage. */
export function isRunStep(step: ChainStep): step is ChainRunStep {
	return typeof (step as ChainRunStep).run === "string";
}

/** Type guard for parallel vs sequential. */
export function isParallelStep(step: ChainStep): step is ChainParallelStep {
	return Array.isArray((step as ChainParallelStep).parallel);
}

/**
 * Resolve the task body for a sequential step. Substitutes {task},
 * {previous}, {chain_dir} via `substituteChainTemplate`. Defaults:
 *   - first step:  task = chainTask              (no `{previous}` to inject)
 *   - subsequent:  task = "{previous}"           (pass-through)
 */
export function resolveStepTaskBody(args: {
	stepIndex: number;
	rawTask: string | undefined;
	chainTask: string;
	previous: string;
	chainDir: string;
}): string {
	const fallback = args.stepIndex === 0 ? args.chainTask : "{previous}";
	const template = args.rawTask ?? fallback;
	return substituteChainTemplate(template, {
		task: args.chainTask,
		previous: args.previous,
		chainDir: args.chainDir,
	});
}

// ── Chain executor ─────────────────────────────────────────────────────────

/**
 * Run a chain end-to-end. Returns a `ChainExecutionResult` whose
 * `steps[]` carries one entry per executed step. Halts after the first
 * failed step (sequential or parallel). Parallel `failFast` only controls
 * cancellation of that step's remaining siblings.
 *
 * The caller is responsible for:
 *   - registering the run in the runtime registry (so `delegate_status`
 *     sees it),
 *   - wiring the compatibility callbacks `onForkRuntimeUpdate` /
 *     `onForkTranscriptEntry` to `updateRunState` / `appendTranscriptEntry`,
 *   - calling `completeRun` when this resolves.
 */
export async function executeChain(args: ExecuteChainArgs): Promise<ChainExecutionResult> {
	const preparedRunSteps = new Map<number, PreparedSavedChainRunStep>();
	for (let index = 0; index < args.steps.length; index += 1) {
		const step = args.steps[index]!;
		if (isRunStep(step)) preparedRunSteps.set(index, prepareSavedChainRunStep(step, args.cwd));
	}
	const chainDir = args.chainDir ?? prepareChainDir({ runId: args.runId });
	const agents = args.agents ?? discoverAgents(args.cwd, args.scope).agents;
	const stepResults: ChainStepResult[] = [];
	let previous = "";
	let anyFailed = false;
	const savedScopes = new Map<string, { task: string; previous: string; parentScopeId?: string }>();
	const artifacts: ChainArtifact[] = [];
	const chainScratchRoot = args.scratchRoot;
	for (let i = 0; i < args.steps.length; i++) {
		const step = args.steps[i];

		if (isParallelStep(step)) {
			const stepResult = await runParallelStep(step, i, {
				...args,
				agents,
				chainDir,
				previous,
				artifacts,
				scratchRoot: chainScratchRoot,
			});
			stepResults.push(stepResult);
			if (!stepResult.ok) {
				anyFailed = true;
				break;
			}
			artifacts.push(...collectChainArtifacts(stepResult, effectiveOutputsByStep.get(stepResult) ?? new Map()));
			previous = stepResult.collapsedForNext;
			continue;
		}

		const savedChainContext = savedChainContextForStep(step);
		let taskStepIndex = i;
		let scopedTask = args.chainTask;
		let scopedPrevious = previous;
		if (savedChainContext) {
			for (const descriptor of savedChainContext.scopePath) {
				if (savedScopes.has(descriptor.id)) continue;
				if (!descriptor.parentScopeId) {
					savedScopes.set(descriptor.id, { task: args.chainTask, previous: "" });
					continue;
				}
				const parent = savedScopes.get(descriptor.parentScopeId);
				if (!parent) throw new Error(`saved-chain scope '${descriptor.parentScopeId}' was not initialized`);
				const task = resolveStepTaskBody({
					stepIndex: descriptor.parentStepIndex!,
					rawTask: descriptor.invocationTaskTemplate,
					chainTask: parent.task,
					previous: parent.previous,
					chainDir,
				});
				savedScopes.set(descriptor.id, {
					task,
					previous: "",
					parentScopeId: descriptor.parentScopeId,
				});
			}
			const scope = savedScopes.get(savedChainContext.scopeId)!;
			taskStepIndex = savedChainContext.localStepIndex;
			scopedTask = scope.task;
			scopedPrevious = scope.previous;
		}

		const stepResult = isRunStep(step)
			? await runRunStep(step, preparedRunSteps.get(i)!, i, {
				...args,
				chainDir,
				previous: scopedPrevious,
			})
			: await runSequentialStep(step, i, {
				...args,
				agents,
				chainDir,
				chainTask: scopedTask,
				previous: scopedPrevious,
				taskStepIndex,
				artifacts,
				scratchRoot: chainScratchRoot,
			});
		stepResults.push(stepResult);
		if (!stepResult.ok) {
			anyFailed = true;
			break;
		}
		if (!savedChainContext) {
			artifacts.push(...collectChainArtifacts(stepResult, effectiveOutputsByStep.get(stepResult) ?? new Map()));
			previous = stepResult.collapsedForNext;
			continue;
		}
		const scope = savedScopes.get(savedChainContext.scopeId)!;
		artifacts.push(...collectChainArtifacts(stepResult, effectiveOutputsByStep.get(stepResult) ?? new Map()));
		scope.previous = stepResult.collapsedForNext;
		for (const scopeId of savedChainContext.exitScopeIds) {
			const completed = savedScopes.get(scopeId)!;
			if (!completed.parentScopeId) continue;
			const parent = savedScopes.get(completed.parentScopeId)!;
			parent.previous = completed.previous;
		}
	}
	return {
		steps: stepResults,
		chainDir,
		combinedContent: buildChainCombinedContent(stepResults),
		anyFailed,
	};
}

// ── Deterministic run step ───────────────────────────────────────────────────

async function runRunStep(
	step: ChainRunStep,
	prepared: PreparedSavedChainRunStep,
	stepIndex: number,
	ctx: ExecuteChainArgs & { chainDir: string; previous: string },
): Promise<ChainStepResult> {
	const agentName = `run:${step.run}`;
	const stepName = buildSequentialStepName(stepIndex, `run-${step.run}`);
	const agentSource = savedChainContextForStep(step)?.scopePath.at(-1)?.source ?? "user";
	ctx.onForkRuntimeUpdate?.(stepName, {
		name: stepName,
		agent: agentName,
		agentSource,
		task: `deterministic command stage ${step.run}`,
		status: "running",
		currentRound: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		workerCwd: prepared.cwd,
		interactive: false,
	});

	let outcome: Awaited<ReturnType<typeof runSavedChainCommand>>;
	try {
		outcome = await runSavedChainCommand(prepared, ctx.chainDir, chainEntrySignal(ctx, stepName));
	} catch (error) {
		const detail = (error instanceof Error ? error.message : String(error))
			.replace(/\p{Cc}+/gu, " ")
			.trim()
			.slice(0, 500);
		outcome = {
			status: "failed",
			diagnostic: `run stage '${step.run}' failed to execute${detail ? `: ${detail}` : "."}`,
			exitCode: null,
			signal: null,
			timedOut: false,
		};
	}

	const result: RunResult = {
		name: stepName,
		agent: agentName,
		agentSource,
		task: "",
		status: outcome.status,
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: outcome.status === "completed" ? outcome.diagnostic : "",
		workerCwd: prepared.cwd,
		transcript: [],
		mutationReport: unavailableMutationReport("native run stages are not mutation-tracked"),
		...(outcome.status === "completed" ? {} : { error: outcome.diagnostic }),
		...(outcome.status === "aborted"
			? { cancelReason: ctx.getCancelReason?.(stepName) ?? "user" }
			: {}),
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
	};
	ctx.onForkRuntimeUpdate?.(stepName, {
		status: outcome.status,
		workerCwd: prepared.cwd,
		...(result.error ? { error: result.error } : {}),
	});
	if (outcome.status === "failed") {
		reportChainWorkerFailure(ctx, stepName, { status: "failed", reason: "fork-failed" });
	}
	recordRunCompletedResult(ctx.runId, stepName, result);
	return {
		stepIndex,
		stepKind: "run",
		name: stepName,
		results: [result],
		collapsedForNext: outcome.status === "completed" ? ctx.previous : "",
		ok: outcome.status === "completed",
	};
}

// ── Sequential step ────────────────────────────────────────────────────────

async function runSequentialStep(
	step: ChainSequentialStep,
	stepIndex: number,
	ctx: ExecuteChainArgs & { agents: AgentConfig[]; chainDir: string; previous: string; taskStepIndex?: number; artifacts: ChainArtifact[] },
): Promise<ChainStepResult> {
	const stepName = step.name ?? buildSequentialStepName(stepIndex, step.agent);
	let agent: AgentConfig;
	try {
		agent = applyInvocationOverrides(
			resolveAgent(ctx.agents, step.agent, ctx.discoveryWarnings),
			invocationOverridesFromStep(step),
		);
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		const failed = makeFailedStubResult(stepName, step.agent, errorMessage);
		ctx.onForkRuntimeUpdate?.(stepName, {
			name: stepName,
			agent: step.agent,
			task: step.task ?? "",
			status: "failed",
			error: failed.error,
			currentRound: 0,
			maxRounds: 1,
			collapseMode: "final_output",
			interactive: step.interactive ?? false,
		} as any);
		reportChainWorkerFailure(ctx, stepName, {
			status: "failed",
			reason: "fork-setup-failed",
		});
		recordRunCompletedResult(ctx.runId, stepName, failed);
		return {
			stepIndex,
			stepKind: "sequential",
			name: stepName,
			results: [failed],
			collapsedForNext: "",
			ok: false,
		};
	}

	const taskBody = resolveStepTaskBody({
		stepIndex: ctx.taskStepIndex ?? stepIndex,
		rawTask: step.task,
		chainTask: ctx.chainTask,
		previous: ctx.previous,
		chainDir: ctx.chainDir,
	});

	const stepCwd = resolveStepCwd(ctx.cwd, step.cwd);
	let infrastructureCallbackFailed = false;
	let infrastructureCallbackFailure: unknown;
	// Mark the step as pending in the runtime registry so the overlay /
	// _status tool can show progression. The caller will have populated the
	// run-state shell via `registerRun`; we top up entries lazily.
	ctx.onForkRuntimeUpdate?.(stepName, {
		name: stepName,
		agent: step.agent,
		agentSource: agent.source,
		task: taskBody,
		status: "running",
		currentRound: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		confineWrites: step.confineWrites !== false,
		...(step.readOnly !== undefined ? { readOnly: step.readOnly } : {}),
		interactive: step.interactive ?? agent.interactive ?? false,
	} as any);

	let intercomBridge: ResolvedBridge | undefined;
	try {
		intercomBridge = await resolveChainIntercomBridge(ctx, agent, stepCwd);
	} catch (error) {
		const errorText = `intercom bridge policy resolution failed: ${error instanceof Error ? error.message : String(error)}`;
		const failed = makeFailedStubResult(stepName, step.agent, errorText);
		ctx.onForkRuntimeUpdate?.(stepName, {
			status: "failed",
			workerCwd: stepCwd,
			error: errorText,
		});
		reportChainWorkerFailure(ctx, stepName, {
			status: "failed",
			reason: "fork-failed",
		});
		recordRunCompletedResult(ctx.runId, stepName, failed);
		return {
			stepIndex,
			stepKind: "sequential",
			name: stepName,
			results: [failed],
			collapsedForNext: "",
			ok: false,
		};
	}

	const dctx: DirectContext = {
		cwd: stepCwd,
		mainModel: ctx.mainModel,
		authStorage: ctx.authStorage,
		allowRegistryRuntimeFallback: ctx.allowRegistryRuntimeFallback,
		modelRegistry: ctx.modelRegistry,
		scopedModelRefs: ctx.scopedModelRefs,
		agentDir: ctx.agentDir,
		ensureWorkerToolRegistration: ctx.ensureWorkerToolRegistration,
		getWorkerToolDefinitions: ctx.getWorkerToolDefinitions,
		ownerSessionId: ctx.ownerSessionId,
		...(resolveParentTranscriptSearch(step.parentTranscriptSearch, agent) && ctx.parentTranscriptEntries
			? { parentTranscriptEntries: ctx.parentTranscriptEntries }
			: {}),
		originatorEscalationConfig: ctx.config?.escalation,
		signal: chainEntrySignal(ctx, stepName),
		runId: ctx.runId,
		forkName: stepName,
		childIndex: stepIndex,
		getCancelReason: () => ctx.getCancelReason?.(stepName),
		onRuntimeUpdate: ctx.onForkRuntimeUpdate
			? (patch) => {
				try {
					ctx.onForkRuntimeUpdate!(stepName, projectRunLivePatch(patch, stepCwd));
				} catch (error) {
					infrastructureCallbackFailed = true;
					infrastructureCallbackFailure = error;
					throw error;
				}
			}
			: undefined,
		onTranscriptEntry: ctx.onForkTranscriptEntry
			? (entry) => {
				try {
					ctx.onForkTranscriptEntry!(stepName, entry);
				} catch (error) {
					infrastructureCallbackFailed = true;
					infrastructureCallbackFailure = error;
					throw error;
				}
			}
			: undefined,
		// Phase D: resolved after the step cwd is final so package provenance
		// matches the worker loader exactly.
		intercomBridge,
	};

	const req = buildChainDirectRequest({
		name: stepName,
		agent,
		task: taskBody,
		step,
		chainDir: ctx.chainDir,
		scratchRoot: ctx.scratchRoot,
		globalTimeouts: {
			maxDurationMs: ctx.config?.perForkMaxDurationMs,
			windDownGraceMs: ctx.config?.windDownGraceMs,
			minDurationMs: ctx.config?.perForkMinDurationMs,
			enforceWallClockBudget: ctx.config?.enforceWallClockBudget,
		},
	});
	let resolvedReads: ChainArtifactRead[] | undefined;
	try {
		resolvedReads = resolveChainReads(req.reads, ctx.artifacts) as ChainArtifactRead[] | undefined;
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		const failed = makeFailedStubResult(stepName, step.agent, errorMessage);
		ctx.onForkRuntimeUpdate?.(stepName, {
			name: stepName, agent: step.agent, status: "failed", error: failed.error, currentRound: 0, maxRounds: 1, collapseMode: "final_output",
		} as any);
		reportChainWorkerFailure(ctx, stepName, { status: "failed", reason: "fork-setup-failed" });
		recordRunCompletedResult(ctx.runId, stepName, failed);
		return { stepIndex, stepKind: "sequential", name: stepName, results: [failed], collapsedForNext: "", ok: false };
	}
	const resolvedReq = resolvedReads === req.reads ? req : { ...req, reads: resolvedReads };

	const result = await runDirectWorker(resolvedReq, dctx);
	if (infrastructureCallbackFailed) throw infrastructureCallbackFailure;
	if (result.status === "failed") {
		reportChainWorkerFailure(ctx, stepName, {
			status: "failed",
			reason: runFailureReasonFor(result),
		});
	}
	recordRunCompletedResult(ctx.runId, stepName, result);
	const stepResult: ChainStepResult = {
		stepIndex,
		stepKind: "sequential",
		name: stepName,
		results: [result],
		collapsedForNext: result.collapsedContent,
		// Spec 0019 / REQ-PAUSE-3 — the chain advances ONLY on a clean
		// "completed". A "paused" supervised run (its supervisor was forced to
		// finish at max_rounds) is terminal-but-not-done, so `=== "completed"` correctly yields
		// ok:false and the chain HALTS rather than feeding a parked child's
		// output into the next step as if work had progressed.
		ok: result.status === "completed",
	};
	effectiveOutputsByStep.set(stepResult, new Map([[result.name, resolvedReq.artifact]]));
	return stepResult;
}

// ── Parallel step ──────────────────────────────────────────────────────────

async function runParallelStep(
	step: ChainParallelStep,
	stepIndex: number,
	ctx: ExecuteChainArgs & { agents: AgentConfig[]; chainDir: string; previous: string; artifacts: ChainArtifact[] },
): Promise<ChainStepResult> {
	// 1. Resolve every slot while retaining invalid entries. Name/count expansion
	//    must run over the complete input list so a failed slot keeps its original
	//    position and participates in duplicate-name suffix allocation.
	const tasksRaw: Parameters<typeof expandParallelTasks>[0]["rawTasks"] = [];
	const expandedArtifacts: Array<string | false | undefined> = [];
	const expandedResolutionErrors: Array<string | undefined> = [];
	for (const slot of step.parallel) {
		let agentObj: AgentConfig;
		let resolutionError: string | undefined;
		try {
			agentObj = resolveAgent(ctx.agents, slot.agent, ctx.discoveryWarnings);
		} catch (err: any) {
			resolutionError = err?.message ?? String(err);
			// The placeholder is used only by pure name/count expansion. Invalid
			// entries are converted to failed results before worker construction.
			agentObj = { name: slot.agent } as AgentConfig;
		}
		const repeats = Math.max(1, Math.floor(slot.count ?? 1));
		for (let i = 0; i < repeats; i++) {
			expandedResolutionErrors.push(resolutionError);
			expandedArtifacts.push((slot as typeof slot & { artifact?: string | false }).artifact);
		}
		tasksRaw.push({
			name: slot.name,
			agent: agentObj,
			task: resolveStepTaskBody({
				stepIndex,
				rawTask: slot.task,
				chainTask: ctx.chainTask,
				previous: ctx.previous,
				chainDir: ctx.chainDir,
			}),
			cwd: slot.cwd,
			// expandParallelTasks currently predates artifact and drops unknown fields;
			// expandedArtifacts above preserves the declaration through that seam.

			reads: slot.reads,
			parentTranscriptSearch: slot.parentTranscriptSearch,
			progress: slot.progress,
			interactive: slot.interactive,
			writableRoots: slot.writableRoots,
			confineWrites: slot.confineWrites,
			readOnly: slot.readOnly,
			env: slot.env,
			escalationPolicy: slot.escalationPolicy,
			model: slot.model,
			thinking: slot.thinking,
			thinkingMin: slot.thinkingMin,
			thinkingMax: slot.thinkingMax,
			fallbackModels: slot.fallbackModels,
			skill: slot.skill,
			skills: slot.skills,
			max_duration_ms: slot.max_duration_ms,
			wind_down_grace_ms: slot.wind_down_grace_ms,
			count: slot.count,
		});
	}

	// 2. Expand `count` and dedupe names. Then prefix each name with
	//    `step{N}.` so the runtime registry can show step provenance.
	const expanded = expandParallelTasks({ rawTasks: tasksRaw });
	const orderedNames = expanded.map((task) => buildParallelStepName(stepIndex, task.name));
	const stepTasks: DirectTaskInput[] = [];
	const effectiveOutputs = new Map<string, string | undefined>();
	const failedSlots: RunResult[] = [];
	for (let index = 0; index < expanded.length; index++) {
		const task = expanded[index]!;
		const name = orderedNames[index]!;
		let resolutionError = expandedResolutionErrors[index];
		// The `step{N}.` prefix is chain provenance and must appear on BOTH the
		// addressing name and the human-facing label.
		const displayLabel = buildParallelStepName(stepIndex, task.displayLabel ?? task.name);
		let effectiveTask: DirectTaskInput = { ...task, name, displayLabel };
		if (resolutionError === undefined) {
			try {
				// Build the effective request before matching reads. Copy its values
				// back so the pump cannot restore an explicitly suppressed default.
				const taskArtifact = expandedArtifacts[index] ?? (task as DirectTaskInput & { artifact?: string | false }).artifact;
				const agentArtifact = (task.agent as AgentConfig & { artifact?: string }).artifact;
				const effectiveArtifact = taskArtifact !== undefined ? taskArtifact : agentArtifact;
				const effectiveRequest = {
					...buildDirectRequest({
						name,
						displayLabel,
						agent: task.agent,
						task: task.task,
						focus: task.focus,
						artifact: effectiveArtifact,
						reads: task.reads,
					parentTranscriptSearch: task.parentTranscriptSearch,
					progress: task.progress,
					interactive: task.interactive,
					env: task.env,
					writableRoots: task.writableRoots,
					confineWrites: task.confineWrites,
					readOnly: task.readOnly,
					chainDir: ctx.chainDir,
					escalationPolicy: task.escalationPolicy,
					timeoutPolicy: resolveRunTimeoutPolicy({
						global: {
							maxDurationMs: ctx.config?.perForkMaxDurationMs,
							windDownGraceMs: ctx.config?.windDownGraceMs,
							minDurationMs: ctx.config?.perForkMinDurationMs,
							enforceWallClockBudget: ctx.config?.enforceWallClockBudget,
						},
						agent: task.agent,
						invocation: {
							maxDurationMs: task.max_duration_ms,
							windDownGraceMs: task.wind_down_grace_ms,
						},
					}),
					}),
					artifact: effectiveArtifact === false ? undefined : effectiveArtifact,
				};
				const resolvedReads = resolveChainReads(effectiveRequest.reads, ctx.artifacts) as ChainArtifactRead[] | undefined;
				const reads = resolvedReads ?? (task.reads === false ? false : undefined);
				const artifact = effectiveArtifact;
				effectiveTask = {
					...effectiveTask,
					artifact,
					reads,
					parentTranscriptSearch: effectiveRequest.parentTranscriptSearch,
					progress: effectiveRequest.progress,
					interactive: effectiveRequest.interactive,
					timeoutPolicy: effectiveRequest.timeoutPolicy,
				} as DirectTaskInput;
				effectiveOutputs.set(name, effectiveRequest.artifact);
			} catch (err: unknown) {
				resolutionError = err instanceof Error ? err.message : String(err);
			}
		}
		if (resolutionError === undefined) {
			stepTasks.push(effectiveTask);
			continue;
		}
		const failed = makeFailedStubResult(name, task.agent.name, resolutionError);
		failedSlots.push(failed);
		ctx.onForkRuntimeUpdate?.(name, {
			name,
			displayLabel,
			agent: task.agent.name,
			task: task.task,
			status: "failed",
			error: failed.error,
			currentRound: 0,
			maxRounds: 1,
			collapseMode: "final_output",
			interactive: task.interactive ?? false,
		} as any);
		reportChainWorkerFailure(ctx, name, {
			status: "failed",
			reason: "fork-setup-failed",
		});
		recordRunCompletedResult(ctx.runId, name, failed);
	}

	if (stepTasks.length === 0) {
		return {
			stepIndex,
			stepKind: "parallel",
			name: buildParallelStepName(stepIndex, "[invalid]"),
			results: failedSlots,
			collapsedForNext: "",
			ok: false,
		};
	}

	// 3. Pre-stamp each fan-out slot in the runtime registry.
	for (const t of stepTasks) {
		ctx.onForkRuntimeUpdate?.(t.name, {
			name: t.name,
			...(t.displayLabel !== undefined ? { displayLabel: t.displayLabel } : {}),
			agent: t.agent.name,
			agentSource: t.agent.source,
			task: t.task,
			status: "pending",
			currentRound: 0,
			maxRounds: 1,
			collapseMode: "final_output",
			confineWrites: t.confineWrites !== false,
			...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}),
			interactive: t.interactive ?? t.agent.interactive ?? false,
		} as any);
	}

	// 4. Run via the existing direct-mode pump. Worktree creation is the
	//    caller's responsibility (Phase B does not yet auto-create worktrees
	//    for parallel-in-chain steps; see follow-up §11.5).
	const concurrency = Math.max(1, Math.floor(step.concurrency ?? stepTasks.length));
	const failFast = step.failFast ?? false;
	const taskAbortControllers: Record<string, AbortController> | undefined = failFast
		? Object.fromEntries(stepTasks.map((task) => [task.name, new AbortController()]))
		: undefined;
	const abortAllStepTasks = (failedWorkerName?: string) => {
		for (const [name, controller] of Object.entries(taskAbortControllers ?? {})) {
			if (name !== failedWorkerName) controller.abort();
		}
	};
	const abortFromParent = () => abortAllStepTasks();
	if (taskAbortControllers && ctx.signal) {
		if (ctx.signal.aborted) abortFromParent();
		else ctx.signal.addEventListener("abort", abortFromParent, { once: true });
	}
	const taskSignals = Object.fromEntries(
		stepTasks.flatMap((task) => {
			const signal = chainEntrySignal(ctx, task.name, taskAbortControllers?.[task.name]?.signal);
			return signal ? [[task.name, signal] as const] : [];
		}),
	);
	// Setup failures are terminal before the healthy slots enter the pump.
	if (failFast && failedSlots.length > 0) abortAllStepTasks();

	let pumped: Awaited<ReturnType<typeof pumpDirectWorkers>>;
	try {
		pumped = await pumpDirectWorkers({
			tasks: stepTasks,
			concurrency,
			signal: ctx.signal,
			taskSignals: Object.keys(taskSignals).length > 0 ? taskSignals : undefined,
			ctxCwd: ctx.cwd,
			mainModel: ctx.mainModel,
			authStorage: ctx.authStorage,
			allowRegistryRuntimeFallback: ctx.allowRegistryRuntimeFallback,
			modelRegistry: ctx.modelRegistry,
			scopedModelRefs: ctx.scopedModelRefs,
			agentDir: ctx.agentDir,
			ensureWorkerToolRegistration: ctx.ensureWorkerToolRegistration,
			getWorkerToolDefinitions: ctx.getWorkerToolDefinitions,
			parentTranscriptEntries: ctx.parentTranscriptEntries,
			runId: ctx.runId,
			ownerSessionId: ctx.ownerSessionId,
			originatorEscalationConfig: ctx.config?.escalation,
			worktreeSetup: undefined,
			chainDir: ctx.chainDir,
			onForkRuntimeUpdate: ctx.onForkRuntimeUpdate,
			scratchRoot: ctx.scratchRoot,
			onForkFailure: failFast
				? (workerName, patch) => {
					try {
						return ctx.onForkFailure?.(workerName, patch);
					} finally {
						abortAllStepTasks(workerName);
					}
				}
				: ctx.onForkFailure,
			onForkTranscriptEntry: ctx.onForkTranscriptEntry,
			getCancelReasonByTask: Object.fromEntries(
				stepTasks.map((task) => [task.name, () => ctx.getCancelReason?.(task.name)]),
			),
			resolveIntercomBridgeForTask: (task, effectiveCwd) =>
				resolveChainIntercomBridge(ctx, task.agent, effectiveCwd),
		});
	} finally {
		ctx.signal?.removeEventListener("abort", abortFromParent);
	}

	// 5. Every failed parallel step halts the sequential chain. With failFast
	//    enabled, the first terminal failure also cooperatively aborts siblings;
	//    with it disabled, all siblings are allowed to finish before the halt.
	const resultsByName = new Map(
		[...failedSlots, ...pumped.finalResults].map((result) => [result.name, result]),
	);
	const allResults = orderedNames.map((name) => resultsByName.get(name)!);
	const anyFailed = allResults.some((r) => r.status !== "completed");

	const collapsedForNext = formatParallelAggregate(
		allResults.map((r) => ({
			name: r.name,
			agent: r.agent,
			collapsedContent: r.collapsedContent,
			error: r.error,
			recoveredOutput: r.recoveredOutput,
		})),
	);

	const stepResult: ChainStepResult = {
		stepIndex,
		stepKind: "parallel",
		name: buildParallelStepName(stepIndex, "fan-out"),
		results: allResults,
		collapsedForNext,
		// Every failed parallel step halts the chain; failFast only controls
		// whether siblings are cancelled while the step is still running.
		ok: !anyFailed,
	};
	effectiveOutputsByStep.set(stepResult, effectiveOutputs);
	return stepResult;
}

// ── Combined content ───────────────────────────────────────────────────────

/**
 * Build the chain's tool-result content from per-step results. Format:
 *
 *   ## Step 1 — scout (sequential, completed)
 *   <step 1 collapsed output>
 *
 *   ---
 *
 *   ## Step 2 — parallel (3 tasks, completed)
 *   <fan-out aggregated output>
 *   ...
 */
export function buildChainCombinedContent(steps: ChainStepResult[]): string {
	if (steps.length === 0) return "(empty chain)";
	const blocks: string[] = [];
	for (const s of steps) {
		const status = s.ok ? "completed" : "failed";
		const warningLines = s.results.flatMap((result) => formatForkWarningLines(result.warnings));
		const warningPrefix = warningLines.length > 0 ? `${warningLines.join("\n")}\n\n` : "";
		if (s.stepKind === "sequential") {
			const r = s.results[0]!;
			const header = `## Step ${s.stepIndex + 1} — ${r.agent} (sequential, ${status})`;
			const text = workerArtifactReceipt(r) ?? (r.collapsedContent
				? r.error && r.recoveredOutput
					? `error: ${r.error}\n\n${r.collapsedContent}`
					: r.collapsedContent
				: r.error
					? `error: ${r.error}`
					: "(no output)");
			blocks.push(`${header}\n\n${warningPrefix}${text}`);
		} else if (s.stepKind === "run") {
			const r = s.results[0]!;
			const header = `## Step ${s.stepIndex + 1} — ${r.agent} (run, ${status})`;
			const text = r.collapsedContent || (r.error ? `error: ${r.error}` : "(no output)");
			blocks.push(`${header}\n\n${warningPrefix}${text}`);
		} else {
			const header = `## Step ${s.stepIndex + 1} — parallel (${s.results.length} tasks, ${status})`;
			const text = formatParallelAggregate(s.results.map((result) => ({
				name: result.name,
				agent: result.agent,
				collapsedContent: workerArtifactReceipt(result) ?? result.collapsedContent,
				error: result.error,
				recoveredOutput: result.recoveredOutput,
			})));
			blocks.push(`${header}\n\n${warningPrefix}${text}`);
		}
	}
	return blocks.join("\n\n---\n\n");
}

/**
 * Build a placeholder `RunResult` for a step that failed before any
 * worker session was spun up (e.g. unknown agent name). Surfaces the
 * error in the runtime registry / chain combined content uniformly.
 */
function makeFailedStubResult(name: string, agentName: string, error: string): RunResult {
	return {
		name,
		agent: agentName,
		agentSource: "user",
		task: "",
		status: "failed",
		roundsUsed: 0,
		maxRounds: 1,
		collapseMode: "final_output",
		collapsedContent: "",
		transcript: [],
		mutationReport: unavailableMutationReport("observation unavailable before worker construction"),
		error,
		usage: { supervisorInput: 0, supervisorOutput: 0, workerInput: 0, workerOutput: 0, cost: 0 },
	};
}
