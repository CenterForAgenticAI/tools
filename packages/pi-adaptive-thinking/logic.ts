/**
 * Pure logic extracted from adaptive-thinking for testability.
 * The main index.ts imports these; tests import them directly.
 */

// ---------------------------------------------------------------------------
// Thinking-level taxonomy
// ---------------------------------------------------------------------------

/** Levels Pi can expose at runtime, in canonical ascending order. */
export const RUNTIME_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RuntimeThinkingLevel = (typeof RUNTIME_LEVELS)[number];
/** Levels accepted by adaptive-thinking configuration and persisted policy. */
export type ConfigurableThinkingLevel = RuntimeThinkingLevel;
export type AgentThinkingLevel = Exclude<ConfigurableThinkingLevel, "off" | "minimal">;
/** Configuration shares Pi's order; authority is narrowed by configured bounds. */
export const CONFIGURABLE_LEVELS = RUNTIME_LEVELS;
export const AGENT_LEVELS = CONFIGURABLE_LEVELS.filter(
	(level): level is AgentThinkingLevel => level !== "off" && level !== "minimal",
);

/**
 * Bound values that name a position on the active model's own ladder instead
 * of a fixed level. Pi's canonical order is not uniform across models: 67
 * catalog models expose `max` without exposing `xhigh`, so a literal ceiling
 * silently removes all escalation headroom on them. A sentinel keeps `max`
 * opt-in — you have to select it — while still adapting per model.
 */
export const BOUND_SENTINELS = ["model-min", "model-max"] as const;
export type ThinkingBoundSentinel = (typeof BOUND_SENTINELS)[number];
/** A configured bound: an explicit level, or a sentinel resolved per model. */
export type ThinkingBoundSpec = ConfigurableThinkingLevel | ThinkingBoundSentinel;

// ---------------------------------------------------------------------------
// State and configuration types
// ---------------------------------------------------------------------------

export type OverrideScope = "this_response" | "next_N" | "until_changed";

export interface ThinkingState {
	baseline: ConfigurableThinkingLevel;
	override: AgentThinkingLevel | null;
	scope: OverrideScope | null;
	turnsRemaining: number | null;
	reason: string | null;
	inAgentRun: boolean;
}

/**
 * Configuration exactly as the user wrote it. Bounds may be sentinels, so
 * nothing may clamp against this shape: resolve it first.
 */
export interface Config {
	baseline: ConfigurableThinkingLevel;
	enabled: boolean;
	minLevel: ThinkingBoundSpec;
	maxLevel: ThinkingBoundSpec;
}

/**
 * Configuration with both bounds pinned to concrete levels for one model.
 * Every clamp, window, and prompt decision uses this shape.
 */
export interface ResolvedConfig extends Omit<Config, "minLevel" | "maxLevel"> {
	minLevel: ConfigurableThinkingLevel;
	maxLevel: ConfigurableThinkingLevel;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ResolvedConfig = {
	baseline: "medium",
	enabled: true,
	minLevel: "low",
	maxLevel: "xhigh",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isConfigurableLevel(v: unknown): v is ConfigurableThinkingLevel {
	return typeof v === "string" && CONFIGURABLE_LEVELS.includes(v as ConfigurableThinkingLevel);
}

export function isRuntimeLevel(v: unknown): v is RuntimeThinkingLevel {
	return typeof v === "string" && RUNTIME_LEVELS.includes(v as RuntimeThinkingLevel);
}

export function isAgentLevel(v: unknown): v is AgentThinkingLevel {
	return typeof v === "string" && AGENT_LEVELS.includes(v as AgentThinkingLevel);
}

export function isBoundSentinel(v: unknown): v is ThinkingBoundSentinel {
	return typeof v === "string" && BOUND_SENTINELS.includes(v as ThinkingBoundSentinel);
}

export function isBoundSpec(v: unknown): v is ThinkingBoundSpec {
	return isConfigurableLevel(v) || isBoundSentinel(v);
}

// ---------------------------------------------------------------------------
// Config parsing (pure — takes raw JSON, returns Config)
// ---------------------------------------------------------------------------

export function parseConfig(raw: unknown): Config {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const parsed = raw as Partial<Config>;
	const baseline: ConfigurableThinkingLevel = isConfigurableLevel(parsed?.baseline) ? parsed.baseline : DEFAULT_CONFIG.baseline;
	const enabled = typeof parsed?.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled;
	let minLevel: ThinkingBoundSpec = isBoundSpec(parsed?.minLevel) ? parsed.minLevel : DEFAULT_CONFIG.minLevel;
	let maxLevel: ThinkingBoundSpec = isBoundSpec(parsed?.maxLevel) ? parsed.maxLevel : DEFAULT_CONFIG.maxLevel;
	// Ordering can only be checked when both bounds are explicit levels. A
	// sentinel has no position until it is resolved against a model.
	if (
		isConfigurableLevel(minLevel) &&
		isConfigurableLevel(maxLevel) &&
		CONFIGURABLE_LEVELS.indexOf(minLevel) > CONFIGURABLE_LEVELS.indexOf(maxLevel)
	) {
		minLevel = DEFAULT_CONFIG.minLevel;
		maxLevel = DEFAULT_CONFIG.maxLevel;
	}
	return { baseline, enabled, minLevel, maxLevel };
}

// ---------------------------------------------------------------------------
// Bounds helpers
// ---------------------------------------------------------------------------

export function allowedLevels(cfg: ResolvedConfig): ConfigurableThinkingLevel[] {
	const lo = CONFIGURABLE_LEVELS.indexOf(cfg.minLevel);
	const hi = CONFIGURABLE_LEVELS.indexOf(cfg.maxLevel);
	return CONFIGURABLE_LEVELS.slice(lo, hi + 1);
}

export function clampLevel(level: ConfigurableThinkingLevel, cfg: ResolvedConfig): ConfigurableThinkingLevel {
	const idx = CONFIGURABLE_LEVELS.indexOf(level);
	const lo = CONFIGURABLE_LEVELS.indexOf(cfg.minLevel);
	const hi = CONFIGURABLE_LEVELS.indexOf(cfg.maxLevel);
	if (idx < lo) return cfg.minLevel;
	if (idx > hi) return cfg.maxLevel;
	return level;
}

export function boundsLabel(cfg: ResolvedConfig): string {
	if (cfg.minLevel === DEFAULT_CONFIG.minLevel && cfg.maxLevel === DEFAULT_CONFIG.maxLevel) return "";
	return `${cfg.minLevel}–${cfg.maxLevel}`;
}

/** Render a configured bound, showing what a sentinel resolved to. */
export function boundSpecLabel(spec: ThinkingBoundSpec, resolved: ConfigurableThinkingLevel): string {
	return isBoundSentinel(spec) ? `${spec} (${resolved})` : spec;
}

/**
 * Pin one configured bound to a concrete level for the model in hand.
 *
 * `ladder` is the model's own model-safe level sequence in canonical order.
 * When no model has been observed the sentinel falls back to the built-in
 * default bound, so resolution stays deterministic rather than guessing.
 *
 * The sentinel alone decides which end is meant. Both bounds accept both
 * sentinels, so keying off the field being resolved would read `model-max` in
 * `minLevel` as the model's *lowest* level — silently widening a floor the user
 * set deliberately.
 */
export function resolveBound(
	spec: ThinkingBoundSpec,
	ladder: readonly RuntimeThinkingLevel[] | undefined,
): ConfigurableThinkingLevel {
	if (isConfigurableLevel(spec)) return spec;
	const wantsLowest = spec === "model-min";
	const fromLadder = wantsLowest ? ladder?.[0] : ladder?.at(-1);
	if (fromLadder) return fromLadder;
	return wantsLowest ? DEFAULT_CONFIG.minLevel : DEFAULT_CONFIG.maxLevel;
}

/**
 * Pin both configured bounds for the model in hand.
 *
 * A floor above the resolved ceiling cannot be honoured — the model's
 * capability is a hard limit and a preference is not — so the ceiling wins and
 * the window collapses onto it.
 */
export function resolveConfigForModel(
	cfg: Config,
	ladder: readonly RuntimeThinkingLevel[] | undefined,
): ResolvedConfig {
	const maxLevel = resolveBound(cfg.maxLevel, ladder);
	const requestedMin = resolveBound(cfg.minLevel, ladder);
	const minLevel =
		CONFIGURABLE_LEVELS.indexOf(requestedMin) > CONFIGURABLE_LEVELS.indexOf(maxLevel) ? maxLevel : requestedMin;
	return { ...cfg, minLevel, maxLevel };
}

/**
 * The levels `set_thinking_effort` may offer right now: the configured window,
 * narrowed to the agent-selectable set, then intersected with what the model
 * actually exposes.
 *
 * `modelLevels` is `undefined` when no model has been observed, which applies
 * no model filter. An empty array means a model was observed and exposes
 * nothing usable, which yields an empty set.
 */
export function availableAgentLevels(
	cfg: ResolvedConfig,
	modelLevels: readonly RuntimeThinkingLevel[] | undefined,
): AgentThinkingLevel[] {
	if (!cfg.enabled) return [];
	const window = new Set<ConfigurableThinkingLevel>(allowedLevels(cfg));
	return AGENT_LEVELS.filter(
		(level) => window.has(level) && (modelLevels === undefined || modelLevels.includes(level)),
	);
}

/** Agent levels the configured window allows but this model cannot run. */
export function modelWithheldLevels(
	cfg: ResolvedConfig,
	modelLevels: readonly RuntimeThinkingLevel[] | undefined,
): AgentThinkingLevel[] {
	if (modelLevels === undefined) return [];
	const available = new Set<ConfigurableThinkingLevel>(availableAgentLevels(cfg, modelLevels));
	return allowedLevels(cfg).filter((level): level is AgentThinkingLevel => isAgentLevel(level) && !available.has(level));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function defaultState(cfg: Config): ThinkingState {
	return {
		baseline: cfg.baseline,
		override: null,
		scope: null,
		turnsRemaining: null,
		reason: null,
		inAgentRun: false,
	};
}

export function effectiveLevel(state: ThinkingState): ConfigurableThinkingLevel {
	return state.override ?? state.baseline;
}

// ---------------------------------------------------------------------------
// set_thinking_effort request resolution
// ---------------------------------------------------------------------------

export interface ThinkingEffortRequest {
	level: AgentThinkingLevel;
	scope?: OverrideScope;
	turns?: number | null;
	reason: string;
}

export type ThinkingEffortResolution =
	| {
		ok: true;
		requestedLevel: AgentThinkingLevel;
		level: AgentThinkingLevel;
		scope: OverrideScope;
		turns: number | null;
		wasClamped: boolean;
		allowed: ConfigurableThinkingLevel[];
	}
	| {
		ok: false;
		error: "disabled" | "missing turns" | "out_of_range" | "unavailable";
		message: string;
		details: Record<string, unknown>;
		isError?: boolean;
	};

/**
 * Snap a requested level onto the levels this model actually exposes.
 *
 * Prefers the nearest available level at or below the request, and only steps
 * up when nothing lower exists. An explicit request should never silently buy
 * more reasoning than was asked for. This is deliberately the opposite bias to
 * `fallbackThinkingLevel`, which preserves capability across a model switch.
 */
export function snapToAvailableLevel(
	level: ConfigurableThinkingLevel,
	available: readonly AgentThinkingLevel[],
): AgentThinkingLevel | undefined {
	if (available.includes(level as AgentThinkingLevel)) return level as AgentThinkingLevel;
	return highestAvailableBelow(level, available) ?? available[0];
}

/**
 * The highest available level strictly below `level`, if any.
 *
 * Guidance uses this to name a real prerequisite. Saying "max is for tasks that
 * already meet xhigh criteria" is nonsense on the 67 catalog models that expose
 * `max` without `xhigh`: it points the agent at a level it cannot select.
 */
export function highestAvailableBelow(
	level: ConfigurableThinkingLevel,
	available: readonly AgentThinkingLevel[],
): AgentThinkingLevel | undefined {
	const index = CONFIGURABLE_LEVELS.indexOf(level);
	for (let i = available.length - 1; i >= 0; i--) {
		const candidate = available[i];
		if (candidate !== undefined && CONFIGURABLE_LEVELS.indexOf(candidate) < index) return candidate;
	}
	return undefined;
}

export function resolveThinkingEffortRequest(
	request: ThinkingEffortRequest,
	cfg: ResolvedConfig,
	available: readonly AgentThinkingLevel[],
	modelId?: string | null,
): ThinkingEffortResolution {
	if (!cfg.enabled) {
		return {
			ok: false,
			error: "disabled",
			message:
				"Dynamic thinking adjustment is currently disabled. The user can re-enable it via /thinking-baseline or by editing ~/.pi/agent/adaptive-thinking.json.",
			details: { error: "disabled" },
		};
	}

	if (available.length === 0) {
		const where = modelId ? ` on ${modelId}` : "";
		return {
			ok: false,
			error: "unavailable",
			message: `No thinking level in the configured range (${cfg.minLevel}–${cfg.maxLevel}) is supported${where}, so thinking effort cannot be adjusted. Ask the user to widen the bounds via /thinking-bounds, or to set "maxLevel": "model-max".`,
			details: { error: "unavailable", model: modelId ?? null, allowed: allowedLevels(cfg).map(String) },
			isError: true,
		};
	}

	const requestedLevel = request.level;
	const scope: OverrideScope = request.scope ?? "this_response";
	const turns = request.turns ?? null;

	if (scope === "next_N" && (turns === null || turns < 1)) {
		return {
			ok: false,
			error: "missing turns",
			message: 'When scope is "next_N", you must provide a positive `turns` count.',
			details: { error: "missing turns" },
			isError: true,
		};
	}

	const bounded = clampLevel(requestedLevel, cfg);
	const clamped = snapToAvailableLevel(bounded, available);
	const wasClamped = clamped !== requestedLevel;

	if (clamped === undefined || !isAgentLevel(clamped)) {
		return {
			ok: false,
			error: "out_of_range",
			message: `Level "${requestedLevel}" is outside the allowed range (${cfg.minLevel}–${cfg.maxLevel}). The clamped level "${bounded}" is not agent-selectable. Ask the user to adjust the bounds via /thinking-bounds.`,
			details: { error: "out_of_range", requested: requestedLevel, clamped: bounded, allowed: available.map(String) },
			isError: true,
		};
	}

	return { ok: true, requestedLevel, level: clamped, scope, turns, wasClamped, allowed: [...available] };
}

export function thinkingDirectionLabel(previousLevel: ConfigurableThinkingLevel, newLevel: ConfigurableThinkingLevel): string {
	if (newLevel === previousLevel) return "maintained";
	return CONFIGURABLE_LEVELS.indexOf(newLevel) > CONFIGURABLE_LEVELS.indexOf(previousLevel) ? "escalated" : "de-escalated";
}

export function thinkingScopeDescription(scope: OverrideScope, turns: number | null): string {
	switch (scope) {
		case "this_response":
			return "for this response (will revert to baseline after)";
		case "next_N":
			return `for the next ${turns} response(s)`;
		case "until_changed":
			return "until explicitly changed";
	}
}

export function buildThinkingEffortSuccessText(args: {
	previousLevel: ConfigurableThinkingLevel;
	newLevel: ConfigurableThinkingLevel;
	baseline: ConfigurableThinkingLevel;
	requestedLevel: AgentThinkingLevel;
	level: AgentThinkingLevel;
	scope: OverrideScope;
	turns: number | null;
	reason: string;
	wasClamped: boolean;
	cfg: ResolvedConfig;
}): string {
	const directionLabel = thinkingDirectionLabel(args.previousLevel, args.newLevel);
	const scopeDesc = thinkingScopeDescription(args.scope, args.turns);
	const clampNote = args.wasClamped
		? `\n\nNote: requested "${args.requestedLevel}" was clamped to "${args.level}" (allowed range: ${args.cfg.minLevel}–${args.cfg.maxLevel}).`
		: "";

	return `Thinking effort ${directionLabel}: ${args.previousLevel} → ${args.newLevel} (${scopeDesc}). Reason: ${args.reason}${clampNote}\n\nSubsequent LLM calls in this response will use ${args.newLevel} thinking. ${args.scope === "this_response" ? `After this response completes, thinking reverts to baseline (${args.baseline}).` : ""}`;
}

// ---------------------------------------------------------------------------
// Model-compat guards
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a pi-ai Model that we need for compat checks.
 */
export interface ModelLike {
	id?: string;
	provider?: string;
	compat?: unknown;
}

/**
 * Adaptive-thinking Anthropic models (e.g. claude-fable-5) reject
 * `thinking: {type: "disabled"}` with a 400. pi-ai sends exactly that when
 * the thinking level is "off" (broken in pi <= 0.79.1, see
 * https://github.com/earendil-works/pi/issues/5569). For these models "off"
 * must never be applied.
 */
export function modelRejectsDisabledThinking(model: ModelLike | undefined | null): boolean {
	const compat = model?.compat;
	return Boolean(
		compat &&
			typeof compat === "object" &&
			"forceAdaptiveThinking" in compat &&
			(compat as { forceAdaptiveThinking?: unknown }).forceAdaptiveThinking === true,
	);
}

/**
 * Substitute "off" with the lowest level that is safe for the model.
 * No-op for models that support disabled thinking.
 */
export function guardLevelForModel(level: ConfigurableThinkingLevel, model: ModelLike | undefined | null): ConfigurableThinkingLevel {
	if (level === "off" && modelRejectsDisabledThinking(model)) return "minimal";
	return level;
}

/**
 * Return the model-safe runtime levels in Pi's canonical order.
 *
 * `getSupportedThinkingLevels()` is intentionally passed in by callers so
 * this pure helper can be shared by the snapshot seam, user controls, and the
 * provider boundary without caching a model's capabilities.
 */
export function modelSafeThinkingLevels(
	supportedLevels: readonly unknown[],
	model: ModelLike | undefined | null,
	bounds?: Pick<ResolvedConfig, "minLevel" | "maxLevel">,
): RuntimeThinkingLevel[] {
	const supported = new Set(supportedLevels.filter(isRuntimeLevel));
	const minIndex = bounds ? CONFIGURABLE_LEVELS.indexOf(bounds.minLevel) : 0;
	const maxIndex = bounds ? CONFIGURABLE_LEVELS.indexOf(bounds.maxLevel) : CONFIGURABLE_LEVELS.length - 1;
	return RUNTIME_LEVELS.filter((level, index) =>
		supported.has(level) &&
		index >= minIndex &&
		index <= maxIndex &&
		!(level === "off" && modelRejectsDisabledThinking(model)),
	);
}

export type ThinkingDirection = "higher" | "lower";

/** Find exactly one adjacent candidate. Endpoints and unknown levels do not wrap. */
export function adjacentThinkingLevel(
	currentLevel: unknown,
	candidates: readonly RuntimeThinkingLevel[],
	direction: ThinkingDirection,
): RuntimeThinkingLevel | undefined {
	if (candidates.length === 0) return undefined;
	const currentIndex = isRuntimeLevel(currentLevel) ? RUNTIME_LEVELS.indexOf(currentLevel) : -1;
	if (currentIndex < 0) return undefined;
	if (direction === "higher") {
		return candidates.find((candidate) => RUNTIME_LEVELS.indexOf(candidate) > currentIndex);
	}
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidate = candidates[index];
		if (candidate !== undefined && RUNTIME_LEVELS.indexOf(candidate) < currentIndex) return candidate;
	}
	return undefined;
}

/**
 * Choose a safe level when a model transition leaves the current level
 * unsupported. Prefer the least surprising upward capability, then fall back
 * to the highest lower capability. Returns undefined when no level is safe.
 */
export function fallbackThinkingLevel(
	currentLevel: unknown,
	candidates: readonly RuntimeThinkingLevel[],
): RuntimeThinkingLevel | undefined {
	if (candidates.length === 0) return undefined;
	if (isRuntimeLevel(currentLevel)) {
		const currentIndex = RUNTIME_LEVELS.indexOf(currentLevel);
		const upward = candidates.find((candidate) => RUNTIME_LEVELS.indexOf(candidate) >= currentIndex);
		if (upward) return upward;
	}
	return candidates.at(-1);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function levelArrows(baseline: ConfigurableThinkingLevel, current: ConfigurableThinkingLevel): string {
	const baseIdx = CONFIGURABLE_LEVELS.indexOf(baseline);
	const curIdx = CONFIGURABLE_LEVELS.indexOf(current);
	const diff = curIdx - baseIdx;
	if (diff >= 2) return " ↑↑";
	if (diff === 1) return " ↑";
	if (diff <= -2) return " ↓↓";
	if (diff === -1) return " ↓";
	return "";
}

export function scopeLabel(state: ThinkingState): string {
	if (!state.override || !state.scope) return "";
	switch (state.scope) {
		case "this_response":
			return " (this response)";
		case "next_N":
			return ` (${state.turnsRemaining} response${state.turnsRemaining === 1 ? "" : "s"} left)`;
		case "until_changed":
			return " (persistent)";
	}
}

export function buildStatusLine(
	state: ThinkingState,
	cfg: ResolvedConfig,
	currentLevel: ConfigurableThinkingLevel = effectiveLevel(state),
): string {
	void cfg;
	const level = currentLevel;
	if (!state.override && level === state.baseline) return `🧠 ${level}`;
	const arrows = levelArrows(state.baseline, level);
	return `🧠 ${level}${arrows}${scopeLabel(state)}`;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** What the agent is told about its own thinking controls. */
export interface SystemPromptModelContext {
	/** Levels `set_thinking_effort` may actually select right now. */
	readonly available: readonly AgentThinkingLevel[];
	/** Agent levels the configured window allows but this model cannot run. */
	readonly withheld?: readonly AgentThinkingLevel[];
	/** Model identity, used to explain why a level is missing. */
	readonly modelId?: string | null;
	/**
	 * Pi removed the tool from its registry for this session — `--no-tools`,
	 * `--tools`, or `--exclude-tools`. Nothing about the model is to blame, so
	 * the prompt must not offer to explain it that way.
	 */
	readonly toolFilteredOut?: boolean;
}

export function buildSystemPromptBlock(
	state: ThinkingState,
	cfg: ResolvedConfig,
	currentLevel: ConfigurableThinkingLevel = effectiveLevel(state),
	model: SystemPromptModelContext = { available: availableAgentLevels(cfg, undefined) },
): string {
	const level = currentLevel;
	const available = model.available;
	const withheld = model.withheld ?? [];
	const modelLabel = model.modelId ? ` on ${model.modelId}` : "";
	const overrideInfo = state.override
		? `Current: ${level} (override${state.scope === "next_N" ? `, ${state.turnsRemaining} responses remaining` : state.scope === "until_changed" ? ", persistent" : ", this response"})`
		: level === state.baseline
			? `Current: ${level}`
			: `Current: ${level} (model-safe runtime fallback; baseline: ${state.baseline})`;

	if (!cfg.enabled) {
		return `<thinking-effort>\nBaseline: ${state.baseline} | ${overrideInfo}\nDynamic thinking adjustment is currently disabled.\n</thinking-effort>`;
	}

	if (available.length === 0) {
		const reason = model.toolFilteredOut
			? "`set_thinking_effort` is not available in this session"
			: `No alternative thinking levels are available${modelLabel}, so \`set_thinking_effort\` is not offered this session`;
		return `<thinking-effort>\nBaseline: ${state.baseline} | ${overrideInfo} | Allowed range: ${cfg.minLevel}–${cfg.maxLevel}\n${reason}. Thinking stays at ${level}.\n</thinking-effort>`;
	}

	// Trigger checklists only for levels this model can actually run.
	const levelBlocks: string[] = [];

	if (available.includes("low")) {
		levelBlocks.push(`**low** — use when ANY of these apply:
  - Single factual question with a known answer
  - Formatting, pretty-printing, or mechanical text transformation
  - Explaining a single well-known concept (e.g., "what is a for loop")
  - Translating between equivalent representations`);
	}
	if (available.includes("medium")) {
		levelBlocks.push(`**${state.baseline} (baseline)** — the default. Use for:
  - Reading a single file and summarizing it
  - Routine code edits to one file
  - Simple bug fixes where the cause is obvious
  - Standard Q&A that requires some reasoning but not deep analysis`);
	}
	if (available.includes("high")) {
		levelBlocks.push(`**high** — escalate when ANY of these apply:
  - Task involves 3+ files or interacting components
  - You need to trace execution across multiple functions/modules
  - Debugging where the cause is not immediately obvious
  - Security analysis or permission/auth logic review
  - Refactoring with backward compatibility constraints
  - Graft worker/reviewer/orchestrator task, PR/commit/spec review, or acceptance-criteria validation likely spanning multiple files
  - The user asks to be "thorough", "exhaustive", or to "find all" issues
  - You need to reason about concurrent/async behavior
  - The task involves correctness proofs or formal reasoning`);
	}
	if (available.includes("xhigh")) {
		levelBlocks.push(`**xhigh** — reserve for the hardest work, and only when high has proven insufficient (sharply diminishing returns, prone to over-thinking). Any of:
  - System design or architecture from scratch
  - Distributed systems reasoning (consensus, consistency, partitions)
  - Type-level metaprogramming or advanced generics
  - Graft orchestrator/runtime changes, schema+journal+tests changes, UI+API/server integration, or stalled-system investigations
  - Analyzing subtle race conditions with multiple interleaving timelines
  - Novel algorithmic problems without well-known solutions
  - Coordinating large-scale changes across many files (5+)
  - Formal verification or correctness proofs`);
	}
	if (available.includes("max")) {
		// Name the prerequisite from the available set, never a fixed "xhigh":
		// on a max-without-xhigh model that would demand a level the agent
		// cannot select.
		const below = highestAvailableBelow("max", available);
		levelBlocks.push(`**max** — use only when the task warrants the strongest model-supported effort and the user has explicitly allowed it:
  - ${below ? `The task already meets ${below} criteria and the added cost is justified` : "The task warrants the strongest effort this model exposes"}
  - Exhaustive review or proof work where missing a subtle issue is materially worse than extra latency
  - ${below ? `Do not select max merely because it is available; prefer ${below} when it is sufficient` : "max is the only level this model exposes for self-selection"}`);
	}

	const availableLabels = available.join(", ");
	// Name the missing levels explicitly. Without this the agent reads a short
	// list as a tight user policy and second-guesses it.
	const withheldNote =
		withheld.length > 0
			? ` ${withheld.join(", ")} ${withheld.length === 1 ? "is" : "are"} within your configured range but unsupported${modelLabel}, so ${withheld.length === 1 ? "it is" : "they are"} not offered.`
			: "";

	return `<thinking-effort>
Baseline: ${state.baseline} | ${overrideInfo} | Allowed range: ${cfg.minLevel}–${cfg.maxLevel}
You can adjust thinking effort with \`set_thinking_effort\`. Available levels: ${availableLabels}.${withheldNote}

**When to call set_thinking_effort**: Match effort to the task's difficulty and shape, not its importance. A task that only needs recall, formatting, or one clear edit does not need deep reasoning however much it matters. Escalate for genuinely hard, multi-step work using the triggers below. Over-thinking a simple task wastes tokens and can lower accuracy — long reasoning chains can second-guess answers the model already had right. If a level's triggers clearly match, call this as your FIRST tool call, before other work.

**How far to step**: When the task obviously sits in a level's trigger set — design from scratch, a race condition, a correctness proof, a 5+ file change — jump straight to that level. When difficulty is uncertain, which is the common case, start at baseline and step up one level only when you see the reasoning going shallow or wrong: escalate on evidence, not nerves. Reserve the highest levels on the list above: they show sharply diminishing returns and are prone to over-thinking, so use them only when the level below has proven insufficient and missing a subtle issue is worse than the added latency and cost. Prefer dropping mechanical sub-tasks (rename, reformat, extract, classify) to the lowest available level over spending up on them.

${levelBlocks.join("\n\n")}

Scope: prefer "this_response" (default) so each new prompt re-evaluates and effort decays back to baseline. Use "next_N" only for a workflow you already know stays hard every turn; a long-lived elevated override carries deep reasoning into easy follow-up turns, which is where over-thinking cost accrues. Prefer the shortest horizon that fits.
</thinking-effort>`;
}

// ---------------------------------------------------------------------------
// Per-model effort profiles (issue #9)
// ---------------------------------------------------------------------------
//
// Vendors publish their own per-model effort/thinking guidance, and it differs
// from a single universal baseline: Anthropic's API default is `high` and its
// Opus guide says to start coding/agentic work at `xhigh`, while our generic
// block treats `medium` as the baseline. Anthropic also states that effort
// level names are not comparable across models. A small, curated, dated table
// lets the injected guidance lead with each family's own recommended starting
// level instead of a one-size rule.
//
// This table is curated-and-dated, not scraped: vendor pages churn and current
// docs already quote version strings ahead of shipped models. Refresh it
// deliberately and keep `asOf`/`source` honest. An unmatched model degrades to
// the generic block — absence beats a wrong per-model claim.

/** How a model spends an effort level, which changes how to read a direct jump. */
export type EffortAdaptivity =
	/** The level is a willingness ceiling; the model still right-sizes per prompt. */
	| "adaptive"
	/** The level maps more directly to tokens spent; over-setting burns them. */
	| "fixed";

export interface ModelEffortProfile {
	/** Stable family key, e.g. "claude", "gpt", "gemini", "grok". */
	readonly family: string;
	/** The vendor's own recommended starting level for coding/agentic work. */
	readonly recommendedStart: AgentThinkingLevel;
	/** One line on why that start level, in the model's own terms. */
	readonly rationale: string;
	/** Whether the level is a willingness ceiling or a spent-token budget. */
	readonly adaptivity: EffortAdaptivity;
	/** Provenance: where the recommendation came from. */
	readonly source: string;
	/** ISO date the row was last checked against `source`. */
	readonly asOf: string;
}

/**
 * Curated per-family effort profiles. Keyed by the family string that
 * `detectModelFamily` returns. Recommended start levels are snapped to what the
 * active model can actually select before they are named, so a row can quote a
 * level the running model does not expose without breaking the never-name-an-
 * unavailable-level invariant.
 */
export const MODEL_EFFORT_PROFILES: Readonly<Record<string, ModelEffortProfile>> = {
	claude: {
		family: "claude",
		recommendedStart: "xhigh",
		rationale:
			"Anthropic sets an aggressive default and its prompting guides start coding and agentic work near the top of the range, stepping down only where quality holds.",
		adaptivity: "adaptive",
		source:
			"platform.claude.com effort docs + Prompting Claude Opus 4.8 / Fable 5.1",
		asOf: "2026-09-03",
	},
	gpt: {
		family: "gpt",
		recommendedStart: "medium",
		rationale:
			"GPT-5.x reasons adaptively within a level from a moderate default; use the least effort that gives acceptable quality and raise it on a measured gain.",
		adaptivity: "adaptive",
		source: "developers.openai.com reasoning docs + GPT-5.1 prompting guide",
		asOf: "2026-09-03",
	},
	gemini: {
		family: "gemini",
		recommendedStart: "low",
		rationale:
			"Google retuned its cheapest thinking setting specifically for agentic coding and tool calling, so a light start is often right there rather than a compromise; step up when a task clearly needs it.",
		adaptivity: "adaptive",
		source: "ai.google.dev Gemini 3.x thinking docs",
		asOf: "2026-09-03",
	},
	grok: {
		family: "grok",
		recommendedStart: "high",
		rationale:
			"Grok's reasoning effort is on by default and cannot be disabled; step down for latency-sensitive agentic and simple tool-calling work.",
		adaptivity: "adaptive",
		source: "docs.x.ai reasoning docs",
		asOf: "2026-09-03",
	},
};

/**
 * A model generation parsed from an id, e.g. `claude-opus-4-8` → 4.8. Both `-`
 * and `.` are accepted as the major/minor separator, and only the first number
 * run is used so a trailing date suffix is ignored.
 *
 * A minor is only taken when it is one or two digits and is not itself the start
 * of a longer run, so a date-stamped major-only id such as
 * `claude-opus-4-20250514` reads as 4.0, not 4.20250514.
 */
export function parseModelVersion(id: string): { major: number; minor: number } | null {
	const m = id.match(/(\d+)(?:[._-](\d{1,2})(?!\d))?/);
	if (!m || m[1] === undefined) return null;
	return { major: Number(m[1]), minor: m[2] !== undefined ? Number(m[2]) : 0 };
}

/** A version whose major equals `major` and whose minor is at least `minMinor`. */
function versionInMajor(v: { major: number; minor: number } | null, major: number, minMinor = 0): boolean {
	return v !== null && v.major === major && v.minor >= minMinor;
}

/**
 * Map a provider/id pair to a profile family key, or null when none is known.
 *
 * A profile is a per-*generation* recommendation, so this matches only the
 * generations each profile's source actually covers and returns null otherwise.
 * The matched ranges are bounded on both ends: below excludes older fixed-budget
 * generations (Claude ≤4.5, the o-series, Gemini ≤2.5, Grok ≤4.4), and above
 * excludes an unreleased later major (gpt-6, gemini-4, claude-6) that the table
 * has not been refreshed for. Anything outside a sourced range — including an
 * unrecognized model — falls back to the generic block rather than borrowing
 * another generation's framing.
 */
export function detectModelFamily(
	provider: string | null | undefined,
	id: string | null | undefined,
): string | null {
	const p = (provider ?? "").toLowerCase();
	const i = (id ?? "").toLowerCase();
	const v = parseModelVersion(i);
	if (p === "anthropic" || i.includes("claude")) {
		// Adaptive effort spans Claude 4.6 through the 5.x line; 4.5 and earlier are
		// fixed budget, and a later major is unprofiled until the table is refreshed.
		return versionInMajor(v, 4, 6) || versionInMajor(v, 5) ? "claude" : null;
	}
	if (i.startsWith("gpt-") || i.includes("/gpt-") || (p === "openai" && i.startsWith("gpt"))) {
		// The GPT-5.x adaptive family only; gpt-4.x, the o-series, and a future gpt-6 are out.
		return versionInMajor(v, 5) ? "gpt" : null;
	}
	if (p === "google" || i.includes("gemini")) {
		// Gemini 3.x only (thinking_level enum + coding-tuned low); 2.5 and 4.x differ.
		return versionInMajor(v, 3) ? "gemini" : null;
	}
	if (p === "xai" || i.includes("grok")) {
		// reasoning_effort documented for Grok 4.5/4.6; a later major is unprofiled.
		return versionInMajor(v, 4, 5) ? "grok" : null;
	}
	return null;
}

/** Resolve a model to its curated effort profile, or null when unprofiled. */
export function resolveModelEffortProfile(
	provider: string | null | undefined,
	id: string | null | undefined,
): ModelEffortProfile | null {
	const family = detectModelFamily(provider, id);
	return family ? (MODEL_EFFORT_PROFILES[family] ?? null) : null;
}

/** Context a profile block needs beyond the profile itself. */
export interface ModelProfileBlockContext {
	/** Escaped model ref for the block's `model=` attribute. */
	readonly modelRef: string;
	/** The level currently in effect. */
	readonly current: ConfigurableThinkingLevel;
	/** Levels `set_thinking_effort` may actually select right now. */
	readonly available: readonly AgentThinkingLevel[];
}

/**
 * Build the per-model guidance block from a resolved profile. Returns null when
 * no level is selectable, so the caller emits nothing rather than an empty tag.
 *
 * Every level this names is snapped to the available set first, so the block
 * never points the agent at a level the running model cannot select — the same
 * invariant `buildSystemPromptBlock` holds for its `max` guidance.
 */
export function buildModelProfileBlock(
	profile: ModelEffortProfile,
	ctx: ModelProfileBlockContext,
): string | null {
	const { available } = ctx;
	if (available.length === 0) return null;

	const start = snapToAvailableLevel(profile.recommendedStart, available);
	if (!start) return null;
	// When the published start is out of the model's selectable range, present the
	// nearest available level instead of naming the unavailable one — the generic
	// block already explains why a level is missing.
	const startNote = start === profile.recommendedStart ? "" : " (nearest selectable to this family's published start)";

	const top = available[available.length - 1];
	const belowTop = top ? highestAvailableBelow(top, available) : undefined;
	const reserveNote = belowTop
		? `Reserve the highest level (${top}): sharply diminishing returns and prone to over-thinking, so use it only once ${belowTop} is insufficient.`
		: `This model exposes a single self-selectable level (${top ?? "none"}), so there is no higher tier to reserve.`;

	const frame =
		profile.adaptivity === "adaptive"
			? "On this model the level is a willingness ceiling: the model still right-sizes per prompt, so a direct jump to a justified level is safe and it will not spend the whole budget on an easy sub-step."
			: "On this model the level maps more directly to tokens spent, so over-setting burns them on the easy stretches of a task; step up one level at a time and re-check.";

	return `<thinking-effort-model-guidance model="${ctx.modelRef}" family="${profile.family}">
This model's published start for coding and agentic work: ${start}${startNote}. ${profile.rationale}
${frame}
${reserveNote}
Match effort to task difficulty, not importance. Jump straight to a level when the task obviously fits its triggers; when difficulty is uncertain, start at the recommended level and step up one only on evidence of shallow or wrong reasoning. Drop mechanical sub-tasks (rename, reformat, extract, classify) to a lower level instead of raising effort.
Guidance source: ${profile.source} (as of ${profile.asOf}).
</thinking-effort-model-guidance>`;
}

// ---------------------------------------------------------------------------
// Decay simulation (for testing the agent_end logic)
// ---------------------------------------------------------------------------

export interface DecayResult {
	reverted: boolean;
	message: string | null;
}

/**
 * Simulate the agent_end decay logic. Returns the mutated state and
 * whether a revert happened. Pure — doesn't touch pi APIs.
 */
export function simulateAgentEndDecay(state: ThinkingState): DecayResult {
	state.inAgentRun = false;

	if (!state.override || !state.scope) return { reverted: false, message: null };

	switch (state.scope) {
		case "this_response": {
			const prev = effectiveLevel(state);
			state.override = null;
			state.scope = null;
			state.turnsRemaining = null;
			state.reason = null;
			return { reverted: true, message: `${prev} → ${state.baseline}` };
		}

		case "next_N": {
			if (state.turnsRemaining !== null && state.turnsRemaining > 0) {
				state.turnsRemaining--;
				if (state.turnsRemaining <= 0) {
					const prev = effectiveLevel(state);
					state.override = null;
					state.scope = null;
					state.turnsRemaining = null;
					state.reason = null;
					return { reverted: true, message: `${prev} → ${state.baseline}` };
				}
			}
			return { reverted: false, message: null };
		}

		case "until_changed":
			return { reverted: false, message: null };
	}
}
