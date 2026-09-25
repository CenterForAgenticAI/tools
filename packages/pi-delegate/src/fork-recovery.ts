/**
 * Run recovery types, helpers, and descriptor factories.
 *
 * Recovery is an INDEPENDENT CHILD RUN. The original batch and healthy siblings
 * finish normally and emit their normal aggregate. The recovery run gets its own
 * runId and its own completion wake. The original aggregate is NEVER delayed,
 * mutated, or suppressed.
 *
 * IMPORTANT: RecoveryDescriptors are in-memory only. They are never persisted
 * to disk, never included in failure-wake payloads, and are valid only for the
 * lifetime of the current process. Hydrated/reloaded runs without a descriptor
 * must fail closed — issue #77 covers cross-session recovery.
 *
 * SECURITY: descriptors expose no captured task, environment, path, prompt, or
 * dispatch-plan inspection API. Exact configuration remains closure-private and
 * is observable only when the descriptor launches its child.
 */

import type { TaskDeliveryMode } from "./delegate-runs.js";
import type { TranscriptEntry } from "./summarize.js";
import { validateWorkerArtifactReference, type WorkerArtifactReference } from "./artifact-workspace.js";

// ── Module-level counter for unique per-attempt call IDs ─────────────────────
let _recoveryCallIdSeq = 0;
function nextRecoveryCallId(runId: string): string {
	// Run names are user-controlled and may contain sensitive text. The parent
	// run id plus a process-local sequence is already unique for every attempt.
	// Keep the sequence BEFORE the parent id: deriveRunId() retains only the
	// first 32 characters, so a suffix would disappear for ordinary long ids.
	return `recovery-${++_recoveryCallIdSeq}-${runId}`;
}

// ── Snapshot constants ────────────────────────────────────────────────────────

/** Max transcript entries included in the bounded prior-attempt snapshot. */
const SNAPSHOT_TRANSCRIPT_MAX_ENTRIES = 20;
const RECOVERY_GUIDANCE_MAX_BYTES = 500;

// ── Public types ──────────────────────────────────────────────────────────────

export type RecoveryFailureCategory = "failure" | "refusal";

/** Provenance-safe fact extracted from transcript structure, never transcript text. */
export type RecoveryTranscriptFact =
	| { kind: "tool-call" }
	| { kind: "tool-result"; outcome: "ok" | "error" };

/**
 * Provenance-safe prior-attempt context for a new recovery child.
 *
 * This deliberately cannot represent free-form error, output, assistant, user,
 * argument, result, path, URL, or environment text. Regex redaction is useful
 * defense in depth for user-authored guidance, but is not a secrecy boundary.
 */
export interface BoundedContextSnapshot {
	failureCategory?: RecoveryFailureCategory;
	partialOutputObserved?: true;
	transcriptFacts?: RecoveryTranscriptFact[];
}

/** Result of a completed, successful recovery launch. */
export interface RecoveryLaunchResult {
	strategy: "resume" | "fresh";
	/** RunId of the new independent child run. */
	recoveryRunId: string;
}

/** Resolved outcomes keyed by their exact process-local published promise. */
const publishedRecoveryOutcomes = new WeakMap<Promise<RecoveryLaunchResult>, RecoveryLaunchResult>();

/**
 * Top-level dispatch settings that apply to the whole run (not individual runs).
 * Captured at dispatch time for faithful recovery redispatch.
 * Excludes immutable agent-definition fields and settings whose semantics
 * cannot be preserved (e.g., the original worktree's filesystem contents).
 */
export interface RecoveryTopLevelSettings {
	/**
	 * When true, the recovery child gets a NEW clean worktree — the original
	 * auto-worktree filesystem state is NOT preserved (see contract notes).
	 * When false/absent, no worktree is created.
	 */
	worktree?: boolean;
	/** Agent scope override carried from the original dispatch. */
	agent_scope?: string;
	/** Preserve the original run's effective early-failure notification policy. */
	notifyOnFailure?: boolean;
}

/**
 * Callback that dispatches a single-run independent child delegate run.
 * Returns the new child run's runId. Must throw on dispatch failure.
 *
 * The callback resolves the currently-owned foreground context at launch time.
 * Secret-bearing slot values are passed only in the in-memory `params` value.
 */
export type RecoveryDispatchFunction = (
	params: Record<string, unknown>,
	callId: string,
) => Promise<string>;

/**
 * Per-run in-memory recovery descriptor captured at accepted dispatch time.
 *
 * Stores all information needed to launch an INDEPENDENT FRESH CHILD RUN that
 * faithfully preserves the original run's exact invocation configuration,
 * including: agent, task, cwd, artifact/check/reads/progress, interactive, env,
 * model/thinking/fallbacks/skills, escalation, and all supervised-specific
 * options (clone, maxRounds, collapse, summary, supervisor, timeout, etc.).
 *
 * For auto-created ephemeral worktrees: the descriptor does NOT claim the
 * worktree filesystem state is preserved after original run completion — it
 * dispatches a clean fresh child with a new worktree.
 *
 * Not persisted. Not exposed in failure wake payloads. Valid only in this process.
 * Hydrated/reloaded runs without a descriptor must fail closed.
 */
export interface RunRecoveryDescriptor {
	/** Stable addressing key retained for runtime/control compatibility. */
	readonly forkName: string;
	/** Dispatch shape that owns this run. */
	readonly shape: "direct" | "supervised";
	/**
	 * Launch a fresh independent child run with the EXACT original invocation
	 * configuration. When `priorContext` is supplied the task is prepended with a
	 * bounded prior-attempt block (resume strategy); otherwise it is an exact
	 * fresh redispatch. Returns the child run's runId.
	 *
	 * This function is idempotent at the call site: concurrent callers should
	 * co-ordinate via `pendingLaunch` rather than calling this directly.
	 */
	launchFreshChild(
		priorContext?: BoundedContextSnapshot,
		guidance?: string,
	): Promise<string>;
	/**
	 * Build a bounded prior-context snapshot from the failed run's current
	 * live state. Returns `undefined` when no safe useful context exists — the
	 * caller MUST fail closed for `resume` and fall back to exact fresh
	 * redispatch for `auto` when this returns `undefined`.
	 */
	buildPriorContext(): BoundedContextSnapshot | undefined;

	/**
	 * Per-recovery idempotency. Set to a `Promise<RecoveryLaunchResult>` when
	 * recovery is first attempted; concurrent callers await the SAME promise so
	 * exactly one child run is launched. Cleared only on hard launch failure or
	 * an identity-checked transient terminal failure of that launched child, so
	 * the next explicit call can retry without duplicating a newer launch.
	 */
	pendingLaunch?: Promise<RecoveryLaunchResult>;
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/** Bound a string by encoded UTF-8 bytes without splitting a code point. */
export function truncateRecoveryText(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "…";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	if (markerBytes > maxBytes) return "";
	let used = markerBytes;
	let prefix = "";
	for (const char of text) {
		const bytes = Buffer.byteLength(char, "utf8");
		if (used + bytes > maxBytes) break;
		prefix += char;
		used += bytes;
	}
	return `${prefix}${marker}`;
}

/** Redact common credential shapes before recovery text crosses into a child or wake. */
export function sanitizeRecoveryText(text: string): string {
	return text
		.replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[private key redacted]")
		.replace(/\b((?:authorization\s*:\s*)?(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g, "[token redacted]")
		.replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, "[token redacted]")
		.replace(/\bxox[a-z]-[A-Za-z0-9-]{12,}\b/gi, "[token redacted]")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[access key redacted]")
		.replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[api key redacted]")
		.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt redacted]")
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials-redacted]@")
		.replace(
			/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*([:=])\s*(["'])[^"'\r\n]*\3/g,
			"$1$2$3[redacted]$3",
		)
		.replace(
			/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*[:=]\s*([^\s,;]+)/g,
			"$1=[redacted]",
		)
		.replace(
			/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password|passwd|credential|cookie)["']?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi,
			"$1$2[redacted]$2",
		)
		.replace(
			/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password|passwd|credential|cookie)["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
			"$1[redacted]",
		);
}

/**
 * Extract bounded categorical facts from recent run entries.
 *
 * No free-form text or identifier crosses this boundary. Even tool names are
 * omitted because custom names are user-controlled and may themselves contain
 * secrets that no generic credential regex can reliably identify.
 */
export function buildTranscriptContextSnapshot(
	transcript: readonly TranscriptEntry[],
): RecoveryTranscriptFact[] | undefined {
	if (!transcript || transcript.length === 0) return undefined;
	const tail = transcript.slice(-SNAPSHOT_TRANSCRIPT_MAX_ENTRIES);
	const facts: RecoveryTranscriptFact[] = [];
	for (const entry of tail) {
		if (entry.role === "toolCall") {
			facts.push({ kind: "tool-call" });
		} else if (entry.role === "toolResult") {
			facts.push({
				kind: "tool-result",
				outcome: entry.isError ? "error" : "ok",
			});
		}
	}
	return facts.length > 0 ? facts : undefined;
}

/**
 * Build a bounded context snapshot from run state fields. Returns `undefined`
 * when there is no safe useful context to carry forward (no error and no output).
 *
 * Includes only bounded categorical tool-activity facts when transcript entries
 * are provided; transcript text and identifiers are never represented.
 */
export function buildBoundedContextSnapshot(
	error: string | undefined,
	collapsedContent: string | undefined,
	transcript?: readonly TranscriptEntry[],
	errorKind?: "refusal" | "no-model-alternative",
): BoundedContextSnapshot | undefined {
	const failureCategory = error?.trim()
		? (errorKind === "refusal" ? "refusal" : "failure")
		: undefined;
	const partialOutputObserved = collapsedContent?.trim() ? true : undefined;
	const transcriptFacts = transcript && transcript.length > 0
		? buildTranscriptContextSnapshot(transcript)
		: undefined;
	if (!failureCategory && !partialOutputObserved && !transcriptFacts) return undefined;
	return {
		...(failureCategory ? { failureCategory } : {}),
		...(partialOutputObserved ? { partialOutputObserved: true as const } : {}),
		...(transcriptFacts ? { transcriptFacts } : {}),
	};
}

/**
 * Build the task text for a context-preserving resume child. Prepends a bounded
 * prior-attempt block to the original task. The result is a new child task, NOT
 * a continuation of the same provider session.
 */
function boundedGuidance(guidance: string | undefined): string | undefined {
	const trimmed = guidance?.trim();
	return trimmed
		? truncateRecoveryText(sanitizeRecoveryText(trimmed), RECOVERY_GUIDANCE_MAX_BYTES)
		: undefined;
}

function appendRecoveryTask(
	parts: string[],
	originalTask: string,
	guidance?: string,
): string {
	const safeGuidance = boundedGuidance(guidance);
	if (safeGuidance) {
		parts.push("Recovery guidance:");
		parts.push(safeGuidance);
		parts.push("");
	}
	parts.push("Original task:");
	parts.push(originalTask);
	return parts.join("\n");
}

export function buildResumeTask(
	originalTask: string,
	priorContext: BoundedContextSnapshot,
	guidance?: string,
): string {
	const parts: string[] = [
		"A prior attempt at this task failed. Review any available prior-attempt context below and re-attempt the task.",
		"",
	];
	if (priorContext.failureCategory === "failure" || priorContext.failureCategory === "refusal") {
		parts.push(`Prior attempt failure category: ${priorContext.failureCategory}`);
		parts.push("");
	}
	if (priorContext.partialOutputObserved === true) {
		parts.push("Prior attempt produced partial output; content omitted.");
		parts.push("");
	}
	const safeFacts = Array.isArray(priorContext.transcriptFacts)
		? priorContext.transcriptFacts.slice(0, SNAPSHOT_TRANSCRIPT_MAX_ENTRIES).filter(
			(fact): fact is RecoveryTranscriptFact =>
				fact?.kind === "tool-call" ||
				(fact?.kind === "tool-result" && (fact.outcome === "ok" || fact.outcome === "error")),
		)
		: [];
	if (safeFacts.length > 0) {
		parts.push("Prior attempt tool activity:");
		for (const fact of safeFacts) {
			parts.push(fact.kind === "tool-call"
				? "- tool call observed"
				: `- tool result: ${fact.outcome}`);
		}
		parts.push("");
	}
	return appendRecoveryTask(parts, originalTask, guidance);
}

/** Build a fresh redispatch task, optionally with explicit bounded guidance. */
export function buildFreshRecoveryTask(originalTask: string, guidance?: string): string {
	if (!boundedGuidance(guidance)) return originalTask;
	return appendRecoveryTask([], originalTask, guidance);
}

// ── Descriptor factories ──────────────────────────────────────────────────────

/**
 * Callback to look up live run state for prior-context building.
 * Returns undefined when the run is not accessible.
 */
/** The callback argument remains the stable `forkName` addressing key. */
export type GetLiveRunFn = (forkName: string) => {
	error?: string;
	errorKind?: "refusal" | "no-model-alternative";
	lastWorkerText?: string;
	lastSupervisorText?: string;
	transcript?: readonly TranscriptEntry[];
	completedResult?: { collapsedContent?: string; transcript?: readonly TranscriptEntry[] };
} | undefined;

/**
 * Raw per-run params captured for a direct-mode recovery descriptor.
 * Covers ALL user-facing DelegateParams fields applicable to a direct run.
 * Preserves false/zero values. Does NOT include computed/derived fields.
 *
 * Semantics that cannot be preserved:
 * - Original ephemeral worktree filesystem contents (a new clean worktree is created)
 * - Changes to agent definition files after original dispatch
 */
export interface DirectRecoverySlotParams {
	agent: string;
	task: string;
	/** Effective direct slot name, including count fan-out suffixes. */
	name?: string;
	cwd?: string;
	artifact?: string | false;
	check?: string;
	reads?: Array<string | WorkerArtifactReference> | false;
	/**
	 * #539: the worker's capped parent-transcript grant. An explicit `false`
	 * overrides an agent file that opts in, so it must survive as `false`.
	 */
	parentTranscriptSearch?: boolean;
	progress?: boolean;
	/** #539: the seeded durable objective, an opaque caller-owned payload. */
	focus?: unknown;
	interactive?: boolean;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	/** In-memory only — never persisted or exposed in wakes. */
	env?: Record<string, string | null>;
	model?: string;
	thinking?: unknown;
	thinkingMin?: unknown;
	thinkingMax?: unknown;
	fallbackModels?: unknown;
	skill?: unknown;
	skills?: unknown;
	escalation?: unknown;
	// #287: a direct slot carries a real wall-clock budget now. Omitting these
	// meant an invocation-only limit silently vanished on the retry — and the
	// retry is exactly the run most likely to need it.
	max_duration_ms?: number;
	wind_down_grace_ms?: number;
}

/**
 * Raw per-run params captured for a supervised-mode recovery descriptor.
 * Covers ALL user-facing AgentItemSchema fields. Preserves false/zero values.
 *
 * Semantics that cannot be preserved:
 * - Original ephemeral worktree filesystem contents (a new clean worktree is created)
 * - Changes to agent definition files after original dispatch
 */
export interface SupervisedRecoverySlotParams {
	agent: string;
	task: string;
	name?: string;
	cwd?: string;
	clone_mode?: string;
	task_delivery?: TaskDeliveryMode;
	max_rounds?: number;
	collapse_mode?: string;
	summary_model?: string;
	supervisor_instructions?: string;
	snippet_last_n?: number;
	/**
	 * #539: the worker's capped parent-transcript grant. An explicit `false`
	 * overrides an agent file that opts in, so it must survive as `false`.
	 */
	parentTranscriptSearch?: boolean;
	/** #539: the seeded durable objective, an opaque caller-owned payload. */
	focus?: unknown;
	interactive?: boolean;
	writableRoots?: string[];
	confineWrites?: boolean;
	readOnly?: boolean;
	/** In-memory only — never persisted or exposed in wakes. */
	env?: Record<string, string | null>;
	model?: string;
	thinking?: unknown;
	thinkingMin?: unknown;
	thinkingMax?: unknown;
	fallbackModels?: unknown;
	skill?: unknown;
	skills?: unknown;
	escalation?: unknown;
	max_duration_ms?: number;
	wind_down_grace_ms?: number;
}

/** Input for building a direct-mode per-run recovery descriptor. */
export interface BuildDirectRecoveryDescriptorInput {
	/** Stable addressing key retained as `forkName` for compatibility. */
	forkName: string;
	/** The parent run's runId (used as part of the deterministic call-ID base). */
	runId: string;
	slotParams: DirectRecoverySlotParams;
	topLevelSettings: RecoveryTopLevelSettings;
	/** Canonical live-run lookup callback. */
	getLiveRun?: GetLiveRunFn;
	/** @deprecated Compatibility spelling used by existing recovery callers. */
	getLiveFork?: GetLiveRunFn;
	dispatchFn: RecoveryDispatchFunction;
}

/** Input for building a supervised-mode per-run recovery descriptor. */
export interface BuildSupervisedRecoveryDescriptorInput {
	/** Stable addressing key retained as `forkName` for compatibility. */
	forkName: string;
	/** The parent run's runId (used as part of the deterministic call-ID base). */
	runId: string;
	slotParams: SupervisedRecoverySlotParams;
	topLevelSettings: RecoveryTopLevelSettings;
	/** Canonical live-run lookup callback. */
	getLiveRun?: GetLiveRunFn;
	/** @deprecated Compatibility spelling used by existing recovery callers. */
	getLiveFork?: GetLiveRunFn;
	dispatchFn: RecoveryDispatchFunction;
}

/** Capture applicable top-level settings without collapsing explicit false. */
export function captureRecoveryTopLevelSettings(source: {
	worktree?: boolean;
	agent_scope?: string;
	notifyOnFailure?: boolean;
}): RecoveryTopLevelSettings {
	return {
		...(source.worktree !== undefined ? { worktree: source.worktree } : {}),
		...(source.agent_scope !== undefined ? { agent_scope: source.agent_scope } : {}),
		...(source.notifyOnFailure !== undefined
			? { notifyOnFailure: source.notifyOnFailure }
			: {}),
	};
}

/**
 * Every `DirectRecoverySlotParams` field the recovery plan reproduces.
 *
 * #539: this replaced 22 hand-written copy lines. Two fields (`parentTranscriptSearch`,
 * `focus`) were captured at dispatch and never copied, because a missing copy
 * line has nothing to fail — no compile error, no assertion, no wake. The same
 * class of loss was already predicted here by #287 and happened anyway.
 *
 * The list and {@link DIRECT_RECOVERY_PLAN_EXCLUSIONS} must together cover
 * every key of the interface. `_DirectSlotParamsExhaustive` below fails the
 * typecheck when a newly added field is in neither, so the next field cannot be
 * dropped the way these two were.
 */
export const DIRECT_RECOVERY_PLAN_KEYS = [
	"agent",
	"name",
	"cwd",
	"artifact",
	"check",
	"reads",
	"parentTranscriptSearch",
	"progress",
	"focus",
	"interactive",
	"writableRoots",
	"confineWrites",
	"readOnly",
	"model",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"fallbackModels",
	"skill",
	"skills",
	"escalation",
	// #287: copied with `!== undefined` rather than a truthiness test, so an
	// explicit `0` — which deliberately DISABLES the budget — survives too.
	"max_duration_ms",
	"wind_down_grace_ms",
] as const satisfies readonly (keyof DirectRecoverySlotParams)[];

/**
 * Fields deliberately kept out of the direct plan, each with its reason.
 *
 * An entry here is a decision, not an oversight: adding a key to this record
 * satisfies the exhaustiveness check without copying the value, so the reason
 * has to be written down where the next reader will see it.
 */
export const DIRECT_RECOVERY_PLAN_EXCLUSIONS = {
	task: "The recovery descriptor frames its own task through buildResumeTask/buildFreshRecoveryTask; copying the raw task here would override that framing.",
	env: "In-memory only. Environment overrides are attached at launch and must never be persisted or exposed in a wake.",
} as const satisfies Partial<Record<keyof DirectRecoverySlotParams, string>>;

/** Every `SupervisedRecoverySlotParams` field the recovery plan reproduces. */
export const SUPERVISED_RECOVERY_PLAN_KEYS = [
	"agent",
	// The independent child has its own run namespace, so preserve the original
	// effective name (including duplicate-name suffixes) instead of inventing a
	// recovery-only slot identity.
	"name",
	"cwd",
	"clone_mode",
	"task_delivery",
	"max_rounds",
	"collapse_mode",
	"summary_model",
	"supervisor_instructions",
	"snippet_last_n",
	"parentTranscriptSearch",
	"focus",
	"interactive",
	"writableRoots",
	"confineWrites",
	"readOnly",
	"model",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"fallbackModels",
	"skill",
	"skills",
	"escalation",
	"max_duration_ms",
	"wind_down_grace_ms",
] as const satisfies readonly (keyof SupervisedRecoverySlotParams)[];

/** Fields deliberately kept out of the supervised plan, each with its reason. */
export const SUPERVISED_RECOVERY_PLAN_EXCLUSIONS = {
	task: "The recovery descriptor frames its own task through buildResumeTask/buildFreshRecoveryTask; copying the raw task here would override that framing.",
	env: "In-memory only. Environment overrides are attached at launch and must never be persisted or exposed in a wake.",
} as const satisfies Partial<Record<keyof SupervisedRecoverySlotParams, string>>;

/**
 * Compile-time exhaustiveness: a slot-params field that is neither reproduced
 * nor deliberately excluded resolves to a non-`never` key here, and assigning
 * it to `never` fails `npm run typecheck`.
 */
type AssertNoUnhandledSlotParam<Unhandled extends never> = Unhandled;
type _DirectSlotParamsExhaustive = AssertNoUnhandledSlotParam<
	Exclude<
		keyof DirectRecoverySlotParams,
		(typeof DIRECT_RECOVERY_PLAN_KEYS)[number] | keyof typeof DIRECT_RECOVERY_PLAN_EXCLUSIONS
	>
>;
type _SupervisedSlotParamsExhaustive = AssertNoUnhandledSlotParam<
	Exclude<
		keyof SupervisedRecoverySlotParams,
		(typeof SUPERVISED_RECOVERY_PLAN_KEYS)[number] | keyof typeof SUPERVISED_RECOVERY_PLAN_EXCLUSIONS
	>
>;

/**
 * Copy exactly the allowlisted keys, preserving explicit `false` and `0`.
 *
 * `!== undefined` rather than a truthiness test, because several of these
 * fields carry meaning when falsy: `max_duration_ms: 0` disables the budget,
 * and `parentTranscriptSearch: false` revokes a grant an agent file would
 * otherwise apply. Nothing outside `keys` is read, so a caller object carrying
 * extra properties cannot smuggle them into a persisted plan.
 */
function copyAllowlistedPlanKeys<Params extends object>(
	slotParams: Params,
	keys: readonly (keyof Params)[],
): Record<string, unknown> {
	const plan: Record<string, unknown> = {};
	for (const key of keys) {
		const value = slotParams[key];
		if (value !== undefined) plan[key as string] = value;
	}
	return plan;
}

/** Copy the applicable top-level settings onto a plan, preserving false. */
function applyTopLevelPlanSettings(
	plan: Record<string, unknown>,
	topLevelSettings: RecoveryTopLevelSettings,
): Record<string, unknown> {
	if (topLevelSettings.worktree !== undefined) plan.worktree = topLevelSettings.worktree;
	if (topLevelSettings.agent_scope !== undefined) plan.agent_scope = topLevelSettings.agent_scope;
	if (topLevelSettings.notifyOnFailure !== undefined) plan.notifyOnFailure = topLevelSettings.notifyOnFailure;
	return plan;
}

/**
 * Build the closure-private recovery plan object for a direct-mode run.
 * Environment overrides are attached separately at launch.
 */
function buildDirectRecoveryPlan(
	slotParams: DirectRecoverySlotParams,
	topLevelSettings: RecoveryTopLevelSettings,
): Record<string, unknown> {
	const plan = copyAllowlistedPlanKeys(slotParams, DIRECT_RECOVERY_PLAN_KEYS);
	if (slotParams.reads !== undefined) {
		plan.reads = slotParams.reads === false
			? false
			: slotParams.reads.map((read) => typeof read === "string" ? read : validateWorkerArtifactReference(read));
	}
	return applyTopLevelPlanSettings(plan, topLevelSettings);
}

/**
 * Build the closure-private recovery plan object for a supervised-mode run.
 * Environment overrides are attached separately at launch.
 */
function buildSupervisedRecoveryPlan(
	slotParams: SupervisedRecoverySlotParams,
	topLevelSettings: RecoveryTopLevelSettings,
): Record<string, unknown> {
	return applyTopLevelPlanSettings(
		copyAllowlistedPlanKeys(slotParams, SUPERVISED_RECOVERY_PLAN_KEYS),
		topLevelSettings,
	);
}

/**
 * Build a prior-context snapshot from a live run's current state.
 * Derives only categorical failure/output/tool-activity facts. Free-form error,
 * output, transcript, path, URL, argument, and environment text is never copied.
 * Returns undefined when no safe useful context exists.
 */
function buildLiveRunPriorContext(
	getLiveRun: GetLiveRunFn,
	forkName: string,
): BoundedContextSnapshot | undefined {
	const runState = getLiveRun(forkName);
	if (!runState) return undefined;
	// Prefer non-empty completed-result evidence, but do not let an unexpected
	// crash's synthesized empty result mask richer live text/transcript state.
	const completedOutput = runState.completedResult?.collapsedContent?.trim()
		? runState.completedResult.collapsedContent
		: undefined;
	const collapsedOutput = completedOutput
		?? runState.lastWorkerText
		?? runState.lastSupervisorText;
	const completedTranscript = runState.completedResult?.transcript;
	const transcriptEntries = (
		completedTranscript && completedTranscript.length > 0
			? completedTranscript
			: runState.transcript
	) as readonly TranscriptEntry[] | undefined;
	return buildBoundedContextSnapshot(
		runState.error,
		collapsedOutput,
		transcriptEntries,
		runState.errorKind,
	);
}

/**
 * Build a recovery descriptor for one run of a direct-mode dispatch.
 *
 * The descriptor preserves ALL original user-facing invocation settings including
 * top-level worktree/agent_scope/notifyOnFailure. The recovery child gets
 * a NEW clean worktree if worktree was originally true — the original auto-worktree
 * filesystem contents are NOT preserved.
 *
 * Captured configuration is closure-private and never projected through the
 * descriptor, runtime snapshots, status responses, or wakes.
 */
export function buildDirectRecoveryDescriptor(
	input: BuildDirectRecoveryDescriptorInput,
): RunRecoveryDescriptor {
	const { forkName, runId, dispatchFn } = input;
	const getLiveRun = input.getLiveRun ?? input.getLiveFork;
	if (!getLiveRun) throw new Error("recovery descriptor requires getLiveRun");
	// Snapshot mutable arrays/objects at accepted-dispatch time. Recovery must not
	// observe later mutation of the original tool argument object.
	const slotParams = structuredClone(input.slotParams);
	const topLevelSettings = structuredClone(input.topLevelSettings);

	const descriptor: RunRecoveryDescriptor = {
		forkName,
		shape: "direct",
		launchFreshChild: async (
			priorContext?: BoundedContextSnapshot,
			guidance?: string,
		): Promise<string> => {
			const recoveryTask = priorContext
				? buildResumeTask(slotParams.task, priorContext, guidance)
				: buildFreshRecoveryTask(slotParams.task, guidance);
			// Use a unique call ID per launch attempt to avoid retry collisions
			const callId = nextRecoveryCallId(runId);
			const slotPlan = buildDirectRecoveryPlan(slotParams, {});
			const recoverySlot: Record<string, unknown> = {
				...slotPlan,
				task: recoveryTask,
				// env is carried separately (in-memory only, never in plan)
				...(slotParams.env !== undefined ? { env: slotParams.env } : {}),
			};
			const callParams: Record<string, unknown> = {
				tasks: [recoverySlot],
				await: false,
			};
			if (topLevelSettings.worktree !== undefined) callParams.worktree = topLevelSettings.worktree;
			if (topLevelSettings.agent_scope !== undefined) callParams.agent_scope = topLevelSettings.agent_scope;
			if (topLevelSettings.notifyOnFailure !== undefined) callParams.notifyOnFailure = topLevelSettings.notifyOnFailure;
			return await dispatchFn(callParams, callId);
		},
		buildPriorContext: () => buildLiveRunPriorContext(
			getLiveRun,
			forkName,
		),
	};
	return descriptor;
}

/**
 * Build a recovery descriptor for one run of a supervised-mode dispatch.
 *
 * The descriptor preserves ALL original user-facing invocation settings including
 * top-level worktree/agent_scope/notifyOnFailure. The recovery child gets
 * the exact original effective slot name and, if worktree was true, a NEW clean
 * worktree. The original auto-worktree filesystem contents are NOT preserved.
 *
 * Captured configuration is closure-private and never projected through the
 * descriptor, runtime snapshots, status responses, or wakes.
 */
export function buildSupervisedRecoveryDescriptor(
	input: BuildSupervisedRecoveryDescriptorInput,
): RunRecoveryDescriptor {
	const { forkName, runId, dispatchFn } = input;
	const getLiveRun = input.getLiveRun ?? input.getLiveFork;
	if (!getLiveRun) throw new Error("recovery descriptor requires getLiveRun");
	const slotParams = structuredClone(input.slotParams);
	const topLevelSettings = structuredClone(input.topLevelSettings);

	const descriptor: RunRecoveryDescriptor = {
		forkName,
		shape: "supervised",
		launchFreshChild: async (
			priorContext?: BoundedContextSnapshot,
			guidance?: string,
		): Promise<string> => {
			const recoveryTask = priorContext
				? buildResumeTask(slotParams.task, priorContext, guidance)
				: buildFreshRecoveryTask(slotParams.task, guidance);
			// Use a unique call ID per launch attempt to avoid retry collisions
			const callId = nextRecoveryCallId(runId);
			const recoverySlot: Record<string, unknown> = {
				...buildSupervisedRecoveryPlan(slotParams, {}),
				task: recoveryTask,
				// env is carried separately (in-memory only, never in plan)
				...(slotParams.env !== undefined ? { env: slotParams.env } : {}),
			};
			const callParams: Record<string, unknown> = {
				agents: [recoverySlot],
				await: false,
			};
			// Forward top-level settings that apply to the supervised batch
			if (topLevelSettings.worktree !== undefined) callParams.worktree = topLevelSettings.worktree;
			if (topLevelSettings.agent_scope !== undefined) callParams.agent_scope = topLevelSettings.agent_scope;
			if (topLevelSettings.notifyOnFailure !== undefined) callParams.notifyOnFailure = topLevelSettings.notifyOnFailure;
			return await dispatchFn(callParams, callId);
		},
		buildPriorContext: () => buildLiveRunPriorContext(
			getLiveRun,
			forkName,
		),
	};
	return descriptor;
}

// ── Recovery strategy execution ────────────────────────────────────────────────

export interface ExecuteRecoveryStrategyInput {
	descriptor: RunRecoveryDescriptor;
	strategy: "auto" | "fresh" | "resume";
	/** Optional bounded guidance message prepended to the recovery task (first concurrent call wins). */
	message?: string;
}

/**
 * Execute the recovery strategy for a descriptor, returning a RecoveryLaunchResult.
 * Throws on hard failure (resume with no context, dispatch error).
 *
 * Handles the resume/fresh/auto branching and context building.
 * Does NOT manage pendingLaunch — callers must set that themselves.
 */
export async function executeRecoveryStrategy(
	input: ExecuteRecoveryStrategyInput,
): Promise<RecoveryLaunchResult> {
	const { descriptor, strategy, message } = input;
	const guidance = boundedGuidance(message);

	if (strategy === "resume" || strategy === "auto") {
		const priorContext = descriptor.buildPriorContext();
		if (priorContext) {
			const recoveryRunId = await descriptor.launchFreshChild(priorContext, guidance);
			return { strategy: "resume", recoveryRunId };
		}
		if (strategy === "resume") {
			throw new Error("strategy:resume requires prior context but none is safely available for this run");
		}
		// auto: fall through to fresh; guidance does not fabricate prior state.
	}

	// strategy:"fresh" or auto fallback — original config, no fabricated prior state.
	const recoveryRunId = await descriptor.launchFreshChild(undefined, guidance);
	return { strategy: "fresh", recoveryRunId };
}

export interface ExecuteRecoveryOnceResult {
	outcome: RecoveryLaunchResult;
	/** Exact promise published on the descriptor for this launch. */
	publishedLaunch: Promise<RecoveryLaunchResult>;
	/** True when this request joined an existing successful/in-flight launch. */
	reused: boolean;
}

/**
 * Atomically start or join one recovery launch for a descriptor.
 *
 * JavaScript runs synchronously until the first await, so publishing the promise
 * before awaiting it makes concurrent callers join exactly one attempt. Only the
 * creator clears a rejected attempt, and only when it is still the published
 * promise; late waiters can never erase a newer retry.
 */
export async function executeRecoveryOnce(
	input: ExecuteRecoveryStrategyInput,
): Promise<ExecuteRecoveryOnceResult> {
	const existing = input.descriptor.pendingLaunch;
	if (existing) {
		return { outcome: await existing, publishedLaunch: existing, reused: true };
	}

	const attempt = executeRecoveryStrategy(input);
	const published = attempt.then(
		(outcome) => {
			publishedRecoveryOutcomes.set(published, outcome);
			return outcome;
		},
		(error) => {
			if (input.descriptor.pendingLaunch === published) {
				input.descriptor.pendingLaunch = undefined;
			}
			throw error;
		},
	);
	input.descriptor.pendingLaunch = published;
	return { outcome: await published, publishedLaunch: published, reused: false };
}

/**
 * Release a successfully published recovery only after its child terminally
 * fails with a transient error. The exact promise must still be published and
 * its recorded resolved runId must name that child, so stale observers cannot
 * erase a newer launch.
 */
export function releaseRecoveryLaunchAfterTransientFailure(input: {
	descriptor: RunRecoveryDescriptor;
	publishedLaunch: Promise<RecoveryLaunchResult>;
	recoveryRunId: string;
}): boolean {
	if (
		input.descriptor.pendingLaunch !== input.publishedLaunch ||
		publishedRecoveryOutcomes.get(input.publishedLaunch)?.recoveryRunId !== input.recoveryRunId
	) return false;
	input.descriptor.pendingLaunch = undefined;
	return true;
}

/**
 * Resolve an ambiguous dispatch boundary without launching a duplicate child.
 * A delegate call can register its run before its return path throws or loses
 * the result envelope. In that case the deterministic expected run id is the
 * authoritative evidence that the launch succeeded.
 */
export async function dispatchRecoveryChildSafely(input: {
	expectedRunId: string;
	dispatch(): Promise<string | undefined>;
	/** Return the exact live registration object, not merely a boolean. */
	getRegistration(runId: string): unknown;
	/** Exact registration captured by a successful dispatch before it returned. */
	getDispatchedRegistration?: () => unknown;
	/** Fail closed when a new object is not owned by the expected runtime. */
	isRegistrationAccepted?: (registration: unknown) => boolean;
	/** Authorization failures are definitive and must never be reconciled. */
	shouldReconcileError?: (error: unknown) => boolean;
	/** Best-effort cleanup when a new registration accompanies a definitive mismatch. */
	onRegistrationRejected?: () => void | Promise<void>;
}): Promise<string> {
	const registrationBefore = input.getRegistration(input.expectedRunId);
	if (registrationBefore !== undefined) {
		throw new Error("recovery dispatch refused because the expected runId is already registered");
	}
	const getAcceptedNewRegistration = (): unknown => {
		const current = input.getRegistration(input.expectedRunId);
		if (current === undefined || current === registrationBefore) return undefined;
		const dispatched = input.getDispatchedRegistration?.();
		if (dispatched !== undefined && current !== dispatched) return undefined;
		if (input.isRegistrationAccepted && !input.isRegistrationAccepted(current)) return undefined;
		return current;
	};
	let returnedRunId: string | undefined;
	try {
		returnedRunId = await input.dispatch();
	} catch (error) {
		if (input.shouldReconcileError?.(error) === false) throw error;
		if (getAcceptedNewRegistration() !== undefined) return input.expectedRunId;
		throw error;
	}
	if (returnedRunId === input.expectedRunId && getAcceptedNewRegistration() !== undefined) {
		return input.expectedRunId;
	}
	if (returnedRunId !== undefined) {
		await input.onRegistrationRejected?.();
		throw new Error("recovery dispatch returned an unexpected or unregistered runId");
	}
	if (getAcceptedNewRegistration() !== undefined) return input.expectedRunId;
	throw new Error("recovery dispatch did not return or register a runId");
}


/** @deprecated Use {@link RunRecoveryDescriptor}; retained for compatibility. */
export type ForkRecoveryDescriptor = RunRecoveryDescriptor;
/** @deprecated Use {@link GetLiveRunFn}; retained for compatibility. */
export type GetLiveForkFn = GetLiveRunFn;
