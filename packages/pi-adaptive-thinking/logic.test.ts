/**
 * Unit tests for adaptive-thinking pure logic.
 *
 * Run: npx tsx logic.test.ts
 *
 * No test framework needed — uses Node assert + a tiny runner.
 */

import * as assert from "node:assert/strict";
import {
	type ConfigurableThinkingLevel,
	type RuntimeThinkingLevel,
	type AgentThinkingLevel,
	type ThinkingState,
	type Config,
	type ResolvedConfig,
	type ThinkingBoundSpec,
	CONFIGURABLE_LEVELS,
	RUNTIME_LEVELS,
	AGENT_LEVELS,
	DEFAULT_CONFIG,
	isConfigurableLevel,
	isRuntimeLevel,
	isAgentLevel,
	parseConfig,
	allowedLevels,
	clampLevel,
	boundsLabel,
	defaultState,
	effectiveLevel,
	levelArrows,
	scopeLabel,
	buildStatusLine,
	buildSystemPromptBlock,
	resolveThinkingEffortRequest,
	availableAgentLevels,
	modelWithheldLevels,
	resolveConfigForModel,
	resolveBound,
	snapToAvailableLevel,
	highestAvailableBelow,
	boundSpecLabel,
	isBoundSpec,
	isBoundSentinel,
	BOUND_SENTINELS,
	simulateAgentEndDecay,
	modelRejectsDisabledThinking,
	guardLevelForModel,
	modelSafeThinkingLevels,
	adjacentThinkingLevel,
	fallbackThinkingLevel,
	MODEL_EFFORT_PROFILES,
	detectModelFamily,
	parseModelVersion,
	resolveModelEffortProfile,
	buildModelProfileBlock,
	type ModelEffortProfile,
} from "./logic.js";

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failed++;
		const msg = err instanceof Error ? err.message : String(err);
		failures.push(`  ✗ ${name}: ${msg}`);
		console.log(`  ✗ ${name}: ${msg}`);
	}
}

function suite(name: string, fn: () => void) {
	console.log(`\n${name}`);
	fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

function state(overrides: Partial<ThinkingState> = {}): ThinkingState {
	return { ...defaultState(DEFAULT_CONFIG), ...overrides };
}

// ============================= TESTS =====================================

suite("isConfigurableLevel", () => {
	test("accepts all valid levels", () => {
		for (const l of CONFIGURABLE_LEVELS) assert.ok(isConfigurableLevel(l));
	});

	test("rejects invalid strings", () => {
		assert.ok(!isConfigurableLevel("extreme"));
		assert.ok(!isConfigurableLevel(""));
		assert.ok(!isConfigurableLevel("HIGH"));
	});

	test("rejects non-strings", () => {
		assert.ok(!isConfigurableLevel(42));
		assert.ok(!isConfigurableLevel(null));
		assert.ok(!isConfigurableLevel(undefined));
		assert.ok(!isConfigurableLevel({}));
	});
});

suite("thinking-level taxonomy alignment", () => {
	test("uses one canonical order for runtime, configurable, and agent levels", () => {
		assert.deepEqual(RUNTIME_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.equal(CONFIGURABLE_LEVELS, RUNTIME_LEVELS, "config validation must share the runtime canonical order");
		assert.deepEqual(AGENT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(new Set(RUNTIME_LEVELS).size, RUNTIME_LEVELS.length);
		assert.equal(new Set(AGENT_LEVELS).size, AGENT_LEVELS.length);
	});

	test("types max as runtime, configurable, and agent-selectable authority", () => {
		const runtimeMax: RuntimeThinkingLevel = "max";
		const configurableMax: ConfigurableThinkingLevel = "max";
		const agentMax: AgentThinkingLevel = "max";
		assert.equal(runtimeMax, configurableMax);
		assert.equal(configurableMax, agentMax);
		assert.equal(isRuntimeLevel("max"), true);
		assert.equal(isConfigurableLevel("max"), true);
		assert.equal(isAgentLevel("max"), true);
	});
});

suite("parseConfig", () => {
	test("returns defaults for empty/null input", () => {
		assert.deepEqual(parseConfig(null), DEFAULT_CONFIG);
		assert.deepEqual(parseConfig(undefined), DEFAULT_CONFIG);
		assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	});

	test("parses valid config", () => {
		const result = parseConfig({
			baseline: "high",
			enabled: false,
			minLevel: "medium",
			maxLevel: "high",
		});
		assert.equal(result.baseline, "high");
		assert.equal(result.enabled, false);
		assert.equal(result.minLevel, "medium");
		assert.equal(result.maxLevel, "high");
	});

	test("falls back on invalid baseline", () => {
		assert.equal(parseConfig({ baseline: "turbo" }).baseline, "medium");
	});

	test("falls back on invalid minLevel/maxLevel", () => {
		const result = parseConfig({ minLevel: "super", maxLevel: "ultra" });
		assert.equal(result.minLevel, "low");
		assert.equal(result.maxLevel, "xhigh");
	});

	test("accepts explicitly configured max while preserving the xhigh default ceiling", () => {
		const result = parseConfig({ baseline: "max", minLevel: "low", maxLevel: "max" });
		assert.deepEqual(result, { baseline: "max", enabled: true, minLevel: "low", maxLevel: "max" });
		assert.equal(DEFAULT_CONFIG.maxLevel, "xhigh");
	});

	test("resets to defaults when min > max", () => {
		const result = parseConfig({ minLevel: "high", maxLevel: "low" });
		assert.equal(result.minLevel, "low");
		assert.equal(result.maxLevel, "xhigh");
	});

	test("allows min == max (single allowed level)", () => {
		const result = parseConfig({ minLevel: "high", maxLevel: "high" });
		assert.equal(result.minLevel, "high");
		assert.equal(result.maxLevel, "high");
	});
});

suite("allowedLevels", () => {
	test("full range (default bounds)", () => {
		assert.deepEqual(allowedLevels(cfg()), ["low", "medium", "high", "xhigh"]);
	});

	test("narrow range medium–high", () => {
		assert.deepEqual(
			allowedLevels(cfg({ minLevel: "medium", maxLevel: "high" })),
			["medium", "high"],
		);
	});

	test("single level", () => {
		assert.deepEqual(
			allowedLevels(cfg({ minLevel: "high", maxLevel: "high" })),
			["high"],
		);
	});

	test("includes non-agent levels if bounds span them", () => {
		assert.deepEqual(
			allowedLevels(cfg({ minLevel: "off", maxLevel: "minimal" })),
			["off", "minimal"],
		);
	});

	test("explicit max ceiling widens the full configurable spectrum", () => {
		assert.deepEqual(
			allowedLevels(cfg({ minLevel: "off", maxLevel: "max" })),
			["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		);
	});
});

suite("clampLevel", () => {
	test("within bounds — no change", () => {
		assert.equal(clampLevel("medium", cfg()), "medium");
		assert.equal(clampLevel("high", cfg()), "high");
	});

	test("below min — clamped up", () => {
		assert.equal(clampLevel("low", cfg({ minLevel: "medium", maxLevel: "xhigh" })), "medium");
		assert.equal(clampLevel("off", cfg({ minLevel: "medium", maxLevel: "xhigh" })), "medium");
	});

	test("above max — clamped down", () => {
		assert.equal(clampLevel("xhigh", cfg({ minLevel: "low", maxLevel: "high" })), "high");
	});

	test("exactly at min boundary", () => {
		assert.equal(clampLevel("medium", cfg({ minLevel: "medium", maxLevel: "high" })), "medium");
	});

	test("exactly at max boundary", () => {
		assert.equal(clampLevel("high", cfg({ minLevel: "medium", maxLevel: "high" })), "high");
	});

	test("single-level bounds", () => {
		const c = cfg({ minLevel: "high", maxLevel: "high" });
		assert.equal(clampLevel("low", c), "high");
		assert.equal(clampLevel("high", c), "high");
		assert.equal(clampLevel("xhigh", c), "high");
	});
});

suite("boundsLabel", () => {
	test("empty for default bounds", () => {
		assert.equal(boundsLabel(cfg()), "");
	});

	test("shows non-default bounds", () => {
		assert.equal(boundsLabel(cfg({ minLevel: "medium", maxLevel: "high" })), "medium–high");
	});

	test("shows when only min differs", () => {
		assert.equal(boundsLabel(cfg({ minLevel: "medium" })), "medium–xhigh");
	});

	test("shows when only max differs", () => {
		assert.equal(boundsLabel(cfg({ maxLevel: "high" })), "low–high");
	});
});

suite("defaultState", () => {
	test("uses config baseline", () => {
		const s = defaultState(cfg({ baseline: "high" }));
		assert.equal(s.baseline, "high");
		assert.equal(s.override, null);
		assert.equal(s.scope, null);
	});
});

suite("effectiveLevel", () => {
	test("returns baseline when no override", () => {
		assert.equal(effectiveLevel(state()), "medium");
		assert.equal(effectiveLevel(state({ baseline: "high" })), "high");
	});

	test("returns override when set", () => {
		assert.equal(effectiveLevel(state({ override: "xhigh" })), "xhigh");
	});

	test("override takes precedence over baseline", () => {
		assert.equal(effectiveLevel(state({ baseline: "low", override: "high" })), "high");
	});
});

suite("levelArrows", () => {
	test("no arrows when same level", () => {
		assert.equal(levelArrows("medium", "medium"), "");
	});

	test("single up arrow for +1", () => {
		assert.equal(levelArrows("medium", "high"), " ↑");
	});

	test("double up arrow for +2 or more", () => {
		assert.equal(levelArrows("medium", "xhigh"), " ↑↑");
		assert.equal(levelArrows("low", "xhigh"), " ↑↑");
	});

	test("single down arrow for -1", () => {
		assert.equal(levelArrows("high", "medium"), " ↓");
	});

	test("double down arrow for -2 or more", () => {
		assert.equal(levelArrows("xhigh", "medium"), " ↓↓");
	});
});

suite("scopeLabel", () => {
	test("empty when no override", () => {
		assert.equal(scopeLabel(state()), "");
	});

	test("this_response", () => {
		assert.equal(
			scopeLabel(state({ override: "high", scope: "this_response" })),
			" (this response)",
		);
	});

	test("next_N singular", () => {
		assert.equal(
			scopeLabel(state({ override: "high", scope: "next_N", turnsRemaining: 1 })),
			" (1 response left)",
		);
	});

	test("next_N plural", () => {
		assert.equal(
			scopeLabel(state({ override: "high", scope: "next_N", turnsRemaining: 3 })),
			" (3 responses left)",
		);
	});

	test("until_changed", () => {
		assert.equal(
			scopeLabel(state({ override: "high", scope: "until_changed" })),
			" (persistent)",
		);
	});
});

suite("buildStatusLine", () => {
	test("baseline only, default bounds", () => {
		assert.equal(buildStatusLine(state(), cfg()), "🧠 medium");
	});

	test("baseline only, custom bounds stays compact", () => {
		assert.equal(buildStatusLine(state(), cfg({ minLevel: "medium", maxLevel: "high" })), "🧠 medium");
	});

	test("with override this_response", () => {
		const s = state({ override: "high", scope: "this_response" });
		assert.equal(buildStatusLine(s, cfg()), "🧠 high ↑ (this response)");
	});

	test("with override next_N keeps level and decay count before omitted bounds", () => {
		const s = state({ override: "high", scope: "next_N", turnsRemaining: 2 });
		assert.equal(
			buildStatusLine(s, cfg({ minLevel: "medium", maxLevel: "high" })),
			"🧠 high ↑ (2 responses left)",
		);
	});

	test("de-escalation arrows", () => {
		const s = state({ baseline: "high", override: "low", scope: "this_response" });
		assert.ok(buildStatusLine(s, cfg()).includes("↓↓"));
	});
});

suite("buildSystemPromptBlock", () => {
	test("disabled shows disabled message", () => {
		const block = buildSystemPromptBlock(state(), cfg({ enabled: false }));
		assert.ok(block.includes("disabled"));
		assert.ok(!block.includes("Available levels"));
	});

	test("default bounds shows all agent levels", () => {
		const block = buildSystemPromptBlock(state(), cfg());
		assert.ok(block.includes("low, medium, high, xhigh"));
		assert.ok(block.includes("low–xhigh"));
	});

	test("narrow bounds shows only allowed levels", () => {
		const block = buildSystemPromptBlock(state(), cfg({ minLevel: "medium", maxLevel: "high" }));
		assert.ok(block.includes("medium, high"));
		assert.ok(block.includes("medium–high"));
		// Should have high guidance block but not xhigh
		assert.ok(block.includes("**high**"));
		assert.ok(!block.includes("**xhigh**"));
		// Should not have low guidance block
		assert.ok(!block.includes("**low**"));
	});

	test("shows override info when active", () => {
		const s = state({ override: "high", scope: "next_N", turnsRemaining: 3 });
		const block = buildSystemPromptBlock(s, cfg());
		assert.ok(block.includes("override"));
		assert.ok(block.includes("3 responses remaining"));
	});

	test("single-level bounds shows that one level", () => {
		const block = buildSystemPromptBlock(state(), cfg({ minLevel: "high", maxLevel: "high" }));
		assert.ok(block.includes("Available levels: high."));
	});
});

suite("simulateAgentEndDecay", () => {
	test("this_response reverts to baseline", () => {
		const s = state({ override: "high", scope: "this_response", reason: "complex", inAgentRun: true });
		const result = simulateAgentEndDecay(s);
		assert.ok(result.reverted);
		assert.equal(s.override, null);
		assert.equal(s.scope, null);
		assert.equal(s.reason, null);
		assert.equal(s.inAgentRun, false);
	});

	test("next_N decrements but doesn't revert when turns > 1", () => {
		const s = state({ override: "high", scope: "next_N", turnsRemaining: 3, reason: "multi-step", inAgentRun: true });
		const result = simulateAgentEndDecay(s);
		assert.ok(!result.reverted);
		assert.equal(s.override, "high");
		assert.equal(s.turnsRemaining, 2);
	});

	test("next_N reverts when turns reaches 0", () => {
		const s = state({ override: "high", scope: "next_N", turnsRemaining: 1, reason: "last turn", inAgentRun: true });
		const result = simulateAgentEndDecay(s);
		assert.ok(result.reverted);
		assert.equal(s.override, null);
		assert.equal(s.turnsRemaining, null);
	});

	test("next_N multi-step countdown", () => {
		const s = state({ override: "xhigh", scope: "next_N", turnsRemaining: 3, reason: "refactor", inAgentRun: true });

		// Turn 1
		simulateAgentEndDecay(s);
		assert.equal(s.turnsRemaining, 2);
		assert.equal(s.override, "xhigh");
		s.inAgentRun = true; // simulate next agent_start

		// Turn 2
		simulateAgentEndDecay(s);
		assert.equal(s.turnsRemaining, 1);
		assert.equal(s.override, "xhigh");
		s.inAgentRun = true;

		// Turn 3 — should revert
		const result = simulateAgentEndDecay(s);
		assert.ok(result.reverted);
		assert.equal(s.override, null);
	});

	test("until_changed never reverts", () => {
		const s = state({ override: "high", scope: "until_changed", reason: "deep work", inAgentRun: true });
		const result = simulateAgentEndDecay(s);
		assert.ok(!result.reverted);
		assert.equal(s.override, "high");
		assert.equal(s.scope, "until_changed");
	});

	test("no override — no-op", () => {
		const s = state({ inAgentRun: true });
		const result = simulateAgentEndDecay(s);
		assert.ok(!result.reverted);
		assert.equal(s.override, null);
	});
});

suite("bounds + clamp interaction scenarios", () => {
	test("agent requests xhigh but max is high → clamped to high", () => {
		const c = cfg({ minLevel: "low", maxLevel: "high" });
		const clamped = clampLevel("xhigh" as ConfigurableThinkingLevel, c);
		assert.equal(clamped, "high");
		assert.ok(AGENT_LEVELS.includes(clamped as AgentThinkingLevel));
	});

	test("agent requests low but min is medium → clamped to medium", () => {
		const c = cfg({ minLevel: "medium", maxLevel: "xhigh" });
		const clamped = clampLevel("low" as ConfigurableThinkingLevel, c);
		assert.equal(clamped, "medium");
	});

	test("bounds set to off–minimal → clamped level not agent-selectable", () => {
		const c = cfg({ minLevel: "off", maxLevel: "minimal" });
		const clamped = clampLevel("low" as ConfigurableThinkingLevel, c);
		assert.equal(clamped, "minimal");
		// minimal is NOT in AGENT_LEVELS
		assert.ok(!AGENT_LEVELS.includes(clamped as AgentThinkingLevel));
	});

	test("system prompt reflects constrained bounds", () => {
		const c = cfg({ minLevel: "high", maxLevel: "xhigh" });
		const block = buildSystemPromptBlock(state({ baseline: "high" }), c);
		assert.ok(block.includes("Available levels: high, xhigh."));
		// Should NOT include guidance for out-of-bounds levels
		assert.ok(!block.includes("De-escalate to low"));
		assert.ok(!block.includes("Stay at high for routine")); // medium guidance shouldn't appear
	});

	test("max is clamped to the default xhigh ceiling", () => {
		const result = resolveThinkingEffortRequest(
			{ level: "max", reason: "exercise configurable authority" },
			cfg(),
			availableAgentLevels(cfg(), undefined),
		);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual({ requested: result.requestedLevel, level: result.level, wasClamped: result.wasClamped }, { requested: "max", level: "xhigh", wasClamped: true });
	});

	test("max is agent-selectable when the user explicitly widens the ceiling", () => {
		const result = resolveThinkingEffortRequest(
			{ level: "max", reason: "user opted into provider maximum" },
			cfg({ maxLevel: "max" }),
			availableAgentLevels(cfg({ maxLevel: "max" }), undefined),
		);
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual({ level: result.level, wasClamped: result.wasClamped }, { level: "max", wasClamped: false });
	});
});

// ---------------------------------------------------------------------------
// Model-compat guards (pi/issues/5569 workaround)
// ---------------------------------------------------------------------------

suite("modelRejectsDisabledThinking", () => {
	test("true for forceAdaptiveThinking models (claude-fable-5)", () => {
		assert.equal(
			modelRejectsDisabledThinking({ id: "claude-fable-5", compat: { forceAdaptiveThinking: true } }),
			true,
		);
	});

	test("false for budget-thinking models", () => {
		assert.equal(modelRejectsDisabledThinking({ id: "claude-sonnet-4-5", compat: {} }), false);
		assert.equal(modelRejectsDisabledThinking({ id: "claude-opus-4-1" }), false);
	});

	test("false for undefined/null model", () => {
		assert.equal(modelRejectsDisabledThinking(undefined), false);
		assert.equal(modelRejectsDisabledThinking(null), false);
	});
});

suite("guardLevelForModel", () => {
	const fable = { id: "claude-fable-5", compat: { forceAdaptiveThinking: true } };
	const sonnet = { id: "claude-sonnet-4-5" };

	test('"off" redirected to "minimal" for adaptive models', () => {
		assert.equal(guardLevelForModel("off", fable), "minimal");
	});

suite("model-safe directional candidates", () => {
	const forceAdaptive = { id: "claude-opus-5", compat: { forceAdaptiveThinking: true } };

	test("filters unknown, unsupported, and force-adaptive off while preserving canonical order", () => {
		assert.deepEqual(
			modelSafeThinkingLevels(["max", "high", "not-a-level", "off", "medium"], forceAdaptive),
			["medium", "high", "max"],
		);
	});

	test("intersects sparse capabilities with active session-local bounds", () => {
		assert.deepEqual(
			modelSafeThinkingLevels(["low", "high", "max"], { id: "sparse" }, { minLevel: "medium", maxLevel: "max" }),
			["high", "max"],
		);
	});

	test("does not apply ordinary global bounds when no session bounds are supplied", () => {
		assert.deepEqual(modelSafeThinkingLevels(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { id: "all" }), RUNTIME_LEVELS);
	});

	test("moves exactly one sparse candidate and does not wrap at either endpoint", () => {
		const candidates = ["low", "medium", "xhigh"] as const;
		assert.equal(adjacentThinkingLevel("low", candidates, "higher"), "medium");
		assert.equal(adjacentThinkingLevel("medium", candidates, "lower"), "low");
		assert.equal(adjacentThinkingLevel("low", candidates, "lower"), undefined);
		assert.equal(adjacentThinkingLevel("xhigh", candidates, "higher"), undefined);
		assert.equal(adjacentThinkingLevel("high", candidates, "higher"), "xhigh");
		assert.equal(adjacentThinkingLevel("high", candidates, "lower"), "medium");
		assert.equal(adjacentThinkingLevel("minimal", candidates, "higher"), "low");
		assert.equal(adjacentThinkingLevel("max", candidates, "lower"), "xhigh");
		assert.equal(adjacentThinkingLevel("low", [], "higher"), undefined);
	});

	test("does not move from either endpoint of a singleton candidate set", () => {
		const candidates = ["high"] as const;
		assert.equal(adjacentThinkingLevel("high", candidates, "higher"), undefined);
		assert.equal(adjacentThinkingLevel("high", candidates, "lower"), undefined);
	});

	test("chooses a safe upward fallback on a model transition", () => {
		const candidates = ["minimal", "high", "max"] as const;
		assert.equal(fallbackThinkingLevel("medium", candidates), "high");
		assert.equal(fallbackThinkingLevel("xhigh", candidates), "max");
		assert.equal(fallbackThinkingLevel("max", candidates), "max");
		assert.equal(fallbackThinkingLevel("off", [],), undefined);
	});
});

	test('"off" preserved for non-adaptive models', () => {
		assert.equal(guardLevelForModel("off", sonnet), "off");
		assert.equal(guardLevelForModel("off", undefined), "off");
	});

	test("non-off levels untouched for all models", () => {
		for (const level of CONFIGURABLE_LEVELS.filter((l) => l !== "off")) {
			assert.equal(guardLevelForModel(level, fable), level);
			assert.equal(guardLevelForModel(level, sonnet), level);
		}
	});
});

suite("bound sentinels", () => {
	test("BOUND_SENTINELS names both edges and is recognised as a bound spec", () => {
		assert.deepEqual([...BOUND_SENTINELS], ["model-min", "model-max"]);
		for (const sentinel of BOUND_SENTINELS) {
			assert.ok(isBoundSentinel(sentinel));
			assert.ok(isBoundSpec(sentinel));
			assert.ok(!isConfigurableLevel(sentinel));
		}
		assert.ok(isBoundSpec("high"));
		assert.ok(!isBoundSpec("model-mid"));
		assert.ok(!isBoundSentinel("high"));
	});

	test("parseConfig keeps sentinels and rejects unknown bound values", () => {
		assert.deepEqual(parseConfig({ minLevel: "model-min", maxLevel: "model-max" }), {
			...DEFAULT_CONFIG,
			minLevel: "model-min",
			maxLevel: "model-max",
		});
		assert.deepEqual(parseConfig({ minLevel: "nonsense", maxLevel: "model-max" }), {
			...DEFAULT_CONFIG,
			maxLevel: "model-max",
		});
	});

	test("parseConfig only order-checks two explicit levels", () => {
		// Inverted explicit bounds still reset to the defaults.
		assert.deepEqual(parseConfig({ minLevel: "xhigh", maxLevel: "low" }), { ...DEFAULT_CONFIG });
		// A sentinel has no position yet, so it survives parsing untouched.
		assert.deepEqual(parseConfig({ minLevel: "xhigh", maxLevel: "model-max" }), {
			...DEFAULT_CONFIG,
			minLevel: "xhigh",
			maxLevel: "model-max",
		});
	});

	test("resolveBound pins a sentinel to the ladder edge and falls back without one", () => {
		const ladder: RuntimeThinkingLevel[] = ["minimal", "low", "high", "max"];
		assert.equal(resolveBound("model-min", ladder), "minimal");
		assert.equal(resolveBound("model-max", ladder), "max");
		assert.equal(resolveBound("high", ladder), "high", "an explicit level ignores the ladder");
		assert.equal(resolveBound("model-min", undefined), DEFAULT_CONFIG.minLevel);
		assert.equal(resolveBound("model-max", undefined), DEFAULT_CONFIG.maxLevel);
		assert.equal(resolveBound("model-max", []), DEFAULT_CONFIG.maxLevel, "an empty ladder is not an edge");
		assert.equal(resolveBound("model-min", []), DEFAULT_CONFIG.minLevel, "an empty ladder is not an edge");
	});

	test("the sentinel decides the edge, not the bound it appears in", () => {
		// Both bounds accept both sentinels. Reading the edge off the field
		// instead of the sentinel would widen a floor the user set on purpose.
		const ladder: RuntimeThinkingLevel[] = ["minimal", "low", "high", "max"];
		const at = (minLevel: ThinkingBoundSpec, maxLevel: ThinkingBoundSpec) => {
			const r = resolveConfigForModel({ ...DEFAULT_CONFIG, minLevel, maxLevel }, ladder);
			return `${r.minLevel}–${r.maxLevel}`;
		};
		assert.equal(at("model-min", "model-max"), "minimal–max", "the whole ladder");
		assert.equal(at("model-max", "model-max"), "max–max", "a model-max floor is the ladder top");
		assert.equal(at("model-min", "model-min"), "minimal–minimal", "a model-min ceiling is the ladder bottom");
		// Inverted: the floor asks for the top, the ceiling for the bottom.
		// The ceiling is the capability limit, so the window collapses onto it.
		assert.equal(at("model-max", "model-min"), "minimal–minimal");
		assert.equal(at("model-min", "high"), "minimal–high", "an explicit ceiling still wins");
		assert.equal(at("low", "model-max"), "low–max", "an explicit floor still wins");
	});

	test("sentinel identity also drives the no-model fallback", () => {
		const at = (minLevel: ThinkingBoundSpec, maxLevel: ThinkingBoundSpec) => {
			const r = resolveConfigForModel({ ...DEFAULT_CONFIG, minLevel, maxLevel }, undefined);
			return `${r.minLevel}–${r.maxLevel}`;
		};
		assert.equal(at("model-min", "model-max"), `${DEFAULT_CONFIG.minLevel}–${DEFAULT_CONFIG.maxLevel}`);
		assert.equal(at("model-max", "model-max"), `${DEFAULT_CONFIG.maxLevel}–${DEFAULT_CONFIG.maxLevel}`);
		assert.equal(at("model-min", "model-min"), `${DEFAULT_CONFIG.minLevel}–${DEFAULT_CONFIG.minLevel}`);
	});

	test("resolveConfigForModel lets the model ceiling win over an unreachable floor", () => {
		const spec: Config = { ...DEFAULT_CONFIG, minLevel: "xhigh", maxLevel: "model-max" };
		const resolved = resolveConfigForModel(spec, ["low", "medium", "high"]);
		assert.deepEqual({ min: resolved.minLevel, max: resolved.maxLevel }, { min: "high", max: "high" });
	});

	test("resolveConfigForModel preserves a satisfiable window", () => {
		const spec: Config = { ...DEFAULT_CONFIG, minLevel: "model-min", maxLevel: "model-max" };
		const resolved = resolveConfigForModel(spec, ["minimal", "low", "high", "max"]);
		assert.deepEqual({ min: resolved.minLevel, max: resolved.maxLevel }, { min: "minimal", max: "max" });
	});

	test("boundSpecLabel shows what a sentinel resolved to", () => {
		assert.equal(boundSpecLabel("model-max", "max"), "model-max (max)");
		assert.equal(boundSpecLabel("xhigh", "xhigh"), "xhigh");
	});
});

suite("availableAgentLevels", () => {
	test("no model observed applies no model filter", () => {
		assert.deepEqual(availableAgentLevels(cfg(), undefined), ["low", "medium", "high", "xhigh"]);
	});

	test("an observed model narrows the configured window", () => {
		// Shape of claude-opus-4-5: no xhigh, no max.
		const levels: RuntimeThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
		assert.deepEqual(availableAgentLevels(cfg(), levels), ["low", "medium", "high"]);
		assert.deepEqual(modelWithheldLevels(cfg(), levels), ["xhigh"]);
	});

	test("a hole in the ladder is respected, not filled", () => {
		// Shape of claude-opus-4-6: max without xhigh.
		const levels: RuntimeThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "max"];
		const c = cfg({ minLevel: "low", maxLevel: "max" });
		assert.deepEqual(availableAgentLevels(c, levels), ["low", "medium", "high", "max"]);
		assert.deepEqual(modelWithheldLevels(c, levels), ["xhigh"]);
	});

	test("an empty ladder yields no selectable level", () => {
		assert.deepEqual(availableAgentLevels(cfg(), []), []);
	});

	test("a disjoint ladder yields no selectable level", () => {
		// Shape of opencode/kimi-k3 against a high–xhigh window.
		assert.deepEqual(availableAgentLevels(cfg({ minLevel: "high", maxLevel: "xhigh" }), ["max"]), []);
	});

	test("disabled adjustment yields no selectable level", () => {
		assert.deepEqual(availableAgentLevels(cfg({ enabled: false }), undefined), []);
	});

	test("withheld levels are empty when no model is observed", () => {
		assert.deepEqual(modelWithheldLevels(cfg(), undefined), []);
	});
});

suite("snapToAvailableLevel", () => {
	test("an exact match is returned unchanged", () => {
		assert.equal(snapToAvailableLevel("high", ["low", "high", "max"]), "high");
	});

	test("prefers the nearest level below, so a request never buys more effort", () => {
		assert.equal(snapToAvailableLevel("xhigh", ["low", "medium", "high", "max"]), "high");
	});

	test("steps up only when nothing lower exists", () => {
		// Shape of opencode/glm-5.2: high and max only.
		assert.equal(snapToAvailableLevel("low", ["high", "max"]), "high");
	});

	test("returns undefined when nothing is available", () => {
		assert.equal(snapToAvailableLevel("high", []), undefined);
	});
});

suite("model-aware set_thinking_effort resolution", () => {
	test("an unsupported request snaps down to a level the model can run", () => {
		const c = cfg({ minLevel: "low", maxLevel: "max" });
		const available = availableAgentLevels(c, ["off", "minimal", "low", "medium", "high", "max"]);
		const result = resolveThinkingEffortRequest({ level: "xhigh", reason: "no xhigh here" }, c, available, "opus-4-6");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(
				{ requested: result.requestedLevel, level: result.level, wasClamped: result.wasClamped },
				{ requested: "xhigh", level: "high", wasClamped: true },
			);
			assert.deepEqual(result.allowed, ["low", "medium", "high", "max"]);
		}
	});

	test("an empty available set refuses the call and names the model", () => {
		const c = cfg({ minLevel: "high", maxLevel: "xhigh" });
		const result = resolveThinkingEffortRequest({ level: "high", reason: "nothing fits" }, c, [], "kimi-k3");
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "unavailable");
			assert.equal(result.isError, true);
			assert.match(result.message, /kimi-k3/);
			assert.match(result.message, /model-max/);
		}
	});

	test("a non-agent level smuggled into the available set is refused", () => {
		// The type forbids this, but the guard must hold for an untyped caller
		// rather than letting "minimal" through as a selectable override.
		const c = cfg({ minLevel: "off", maxLevel: "minimal" });
		const smuggled = ["minimal"] as unknown as AgentThinkingLevel[];
		const result = resolveThinkingEffortRequest({ level: "low", reason: "smuggled" }, c, smuggled);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.error, "out_of_range");
			assert.deepEqual(result.details, {
				error: "out_of_range",
				requested: "low",
				clamped: "minimal",
				allowed: ["minimal"],
			});
		}
	});

	test("disabled adjustment still reports disabled, not unavailable", () => {
		const c = cfg({ enabled: false });
		const result = resolveThinkingEffortRequest({ level: "high", reason: "off" }, c, [], null);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "disabled");
	});

	test("a missing turns count is still rejected before any clamping", () => {
		const c = cfg();
		const result = resolveThinkingEffortRequest(
			{ level: "high", scope: "next_N", reason: "no turns" },
			c,
			availableAgentLevels(c, undefined),
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error, "missing turns");
	});
});

suite("system prompt reflects model capability", () => {
	test("withheld levels are named so the agent knows why the list is short", () => {
		const c = cfg({ minLevel: "low", maxLevel: "xhigh" });
		const levels: RuntimeThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
		const block = buildSystemPromptBlock(state({ baseline: "medium" }), c, "medium", {
			available: availableAgentLevels(c, levels),
			withheld: modelWithheldLevels(c, levels),
			modelId: "claude-opus-4-5",
		});
		assert.ok(block.includes("Available levels: low, medium, high."));
		assert.ok(block.includes("xhigh is within your configured range but unsupported on claude-opus-4-5"));
		assert.ok(!block.includes("**xhigh**"));
	});

	test("max guidance never names a level this model cannot select", () => {
		// Shape of claude-opus-4-6: max is the rung above high, xhigh absent.
		const c = cfg({ minLevel: "low", maxLevel: "max" });
		const levels: RuntimeThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "max"];
		const available = availableAgentLevels(c, levels);
		assert.deepEqual(available, ["low", "medium", "high", "max"]);
		const block = buildSystemPromptBlock(state(), c, "medium", {
			available,
			withheld: modelWithheldLevels(c, levels),
			modelId: "opus-4-6",
		});
		assert.ok(block.includes("**max**"), "max is selectable and keeps its trigger block");
		assert.ok(block.includes("The task already meets high criteria"));
		assert.ok(block.includes("prefer high when it is sufficient"));
		// The only permitted mention of xhigh is the withheld-level explanation.
		const xhighMentions = block.split("\n").filter((line) => line.includes("xhigh"));
		assert.equal(xhighMentions.length, 1, `expected only the withheld note, got: ${JSON.stringify(xhighMentions)}`);
		assert.ok(xhighMentions[0]?.includes("unsupported on opus-4-6"));
		assert.ok(!block.includes("meets xhigh criteria"));
		assert.ok(!block.includes("prefer xhigh"));
	});

	test("max guidance drops the prerequisite when max is the only level", () => {
		const c = cfg({ minLevel: "low", maxLevel: "max" });
		const block = buildSystemPromptBlock(state(), c, "max", {
			available: ["max"],
			withheld: [],
			modelId: "kimi-k3",
		});
		assert.ok(block.includes("max is the only level this model exposes for self-selection"));
		assert.ok(!block.includes("criteria and the added cost is justified"));
	});

	test("highestAvailableBelow reports the real next rung down", () => {
		assert.equal(highestAvailableBelow("max", ["low", "medium", "high", "max"]), "high");
		assert.equal(highestAvailableBelow("max", ["low", "medium", "high", "xhigh", "max"]), "xhigh");
		assert.equal(highestAvailableBelow("max", ["max"]), undefined);
		assert.equal(highestAvailableBelow("max", []), undefined);
		assert.equal(highestAvailableBelow("low", ["low", "high"]), undefined);
	});

	test("an empty available set says so instead of offering the tool", () => {
		const c = cfg({ minLevel: "high", maxLevel: "xhigh" });
		const block = buildSystemPromptBlock(state({ baseline: "high" }), c, "max", {
			available: [],
			withheld: [],
			modelId: "kimi-k3",
		});
		assert.ok(block.includes("No alternative thinking levels are available on kimi-k3"));
		assert.ok(block.includes("Thinking stays at max."));
		assert.ok(!block.includes("**high**"));
	});

	test("plural and singular withheld phrasing both read correctly", () => {
		const c = cfg({ minLevel: "low", maxLevel: "max" });
		const one = buildSystemPromptBlock(state(), c, "medium", {
			available: ["low", "medium", "high", "xhigh"],
			withheld: ["max"],
			modelId: "m",
		});
		assert.ok(one.includes("max is within your configured range but unsupported on m, so it is not offered."));
		const many = buildSystemPromptBlock(state(), c, "medium", {
			available: ["low", "medium", "high"],
			withheld: ["xhigh", "max"],
			modelId: "m",
		});
		assert.ok(many.includes("xhigh, max are within your configured range but unsupported on m, so they are not offered."));
	});

	test("disabled adjustment still short-circuits before the model context", () => {
		const block = buildSystemPromptBlock(state(), cfg({ enabled: false }), "medium", { available: [] });
		assert.ok(block.includes("Dynamic thinking adjustment is currently disabled."));
	});
});

suite("per-model effort profiles", () => {
	test("detectModelFamily maps providers and id patterns, and returns null when unknown", () => {
		// Covered adaptive-effort generations resolve to their family.
		assert.equal(detectModelFamily("anthropic", "claude-opus-4-8"), "claude");
		assert.equal(detectModelFamily("openrouter", "anthropic/claude-sonnet-5"), "claude");
		assert.equal(detectModelFamily("openai", "gpt-5.5"), "gpt");
		assert.equal(detectModelFamily("google", "gemini-3.5-flash"), "gemini");
		assert.equal(detectModelFamily("xai", "grok-4.5"), "grok");
		// Older / fixed-budget generations are NOT covered — they fall back to generic.
		assert.equal(detectModelFamily("anthropic", "claude-sonnet-4-5"), null);
		assert.equal(detectModelFamily("anthropic", "claude-3-5-sonnet-20241022"), null);
		assert.equal(detectModelFamily("azure", "o3-mini"), null);
		assert.equal(detectModelFamily("openai", "gpt-4.1"), null);
		assert.equal(detectModelFamily("google", "gemini-2.5-flash"), null);
		assert.equal(detectModelFamily("xai", "grok-4"), null);
		// Date-stamped major-only ids must not read the date as a minor version.
		assert.equal(detectModelFamily("anthropic", "claude-opus-4-20250514"), null);
		assert.equal(detectModelFamily("anthropic", "claude-sonnet-4-20250514"), null);
		// A date after a real minor is still fine (4.6 + date is covered).
		assert.equal(detectModelFamily("anthropic", "claude-opus-4-6-20260101"), "claude");
		// An unreleased later major is outside the sourced range → generic fallback.
		assert.equal(detectModelFamily("openai", "gpt-6"), null);
		assert.equal(detectModelFamily("google", "gemini-4-pro"), null);
		assert.equal(detectModelFamily("xai", "grok-5"), null);
		// Unknown provider/id, and a covered provider with no parseable version.
		assert.equal(detectModelFamily("someco", "mystery-model-1"), null);
		assert.equal(detectModelFamily("anthropic", "capped"), null);
		assert.equal(detectModelFamily(null, null), null);
	});

	test("parseModelVersion reads major.minor with - or . and ignores date suffixes", () => {
		assert.deepEqual(parseModelVersion("claude-opus-4-8"), { major: 4, minor: 8 });
		assert.deepEqual(parseModelVersion("gpt-5.1"), { major: 5, minor: 1 });
		assert.deepEqual(parseModelVersion("claude-fable-5"), { major: 5, minor: 0 });
		assert.deepEqual(parseModelVersion("claude-opus-4-8-20260101"), { major: 4, minor: 8 });
		// A major-only id with a date suffix must read as x.0, not x.<date>.
		assert.deepEqual(parseModelVersion("claude-opus-4-20250514"), { major: 4, minor: 0 });
		assert.equal(parseModelVersion("no-digits-here"), null);
	});

	test("resolveModelEffortProfile returns the family row or null", () => {
		const claude = resolveModelEffortProfile("anthropic", "claude-opus-4-8");
		assert.equal(claude?.family, "claude");
		assert.equal(claude?.recommendedStart, "xhigh");
		assert.equal(resolveModelEffortProfile("someco", "mystery"), null);
	});

	test("every profile has dated provenance and an agent-selectable start level", () => {
		const agentLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
		for (const [key, p] of Object.entries(MODEL_EFFORT_PROFILES)) {
			assert.equal(p.family, key, `family key matches its row: ${key}`);
			assert.ok(agentLevels.has(p.recommendedStart), `${key} start is an agent level`);
			assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/, `${key} has an ISO asOf date`);
			assert.ok(p.source.length > 0, `${key} names a source`);
			assert.ok(["adaptive", "fixed"].includes(p.adaptivity), `${key} adaptivity is valid`);
		}
	});

	test("buildModelProfileBlock leads with the start level and stamps provenance", () => {
		const profile = resolveModelEffortProfile("anthropic", "claude-opus-4-8") as ModelEffortProfile;
		const block = buildModelProfileBlock(profile, {
			modelRef: "anthropic/claude-opus-4-8",
			current: "medium",
			available: ["low", "medium", "high", "xhigh"],
		});
		assert.ok(block);
		assert.ok(block.includes('family="claude"'));
		assert.ok(block.includes("published start for coding and agentic work: xhigh"));
		assert.ok(block.includes("willingness ceiling"), "adaptive framing present");
		assert.ok(block.includes("Reserve the highest level (xhigh)"));
		assert.ok(block.includes("as of " + profile.asOf));
	});

	test("a published start above the ceiling snaps down and never names the unavailable level", () => {
		// claude wants xhigh, but this model only exposes up to high.
		const profile = MODEL_EFFORT_PROFILES.claude as ModelEffortProfile;
		const block = buildModelProfileBlock(profile, {
			modelRef: "anthropic/capped",
			current: "medium",
			available: ["low", "medium", "high"],
		});
		assert.ok(block);
		assert.ok(block.includes("published start for coding and agentic work: high"));
		assert.ok(!block.includes("xhigh"), "must not name a level this model cannot select");
		assert.ok(block.includes("nearest selectable"));
	});

	test("a single-level model states there is no higher tier to reserve", () => {
		const profile = MODEL_EFFORT_PROFILES.claude as ModelEffortProfile;
		const block = buildModelProfileBlock(profile, {
			modelRef: "anthropic/one-level",
			current: "high",
			available: ["high"],
		});
		assert.ok(block);
		assert.ok(block.includes("single self-selectable level (high)"));
		assert.ok(!block.includes("Reserve the highest level"));
	});

	test("an empty available set yields no block", () => {
		const profile = MODEL_EFFORT_PROFILES.gpt as ModelEffortProfile;
		assert.equal(
			buildModelProfileBlock(profile, { modelRef: "openai/x", current: "medium", available: [] }),
			null,
		);
	});

	test("a fixed-adaptivity profile frames the level as tokens spent", () => {
		const fixed: ModelEffortProfile = {
			family: "legacy",
			recommendedStart: "medium",
			rationale: "older reasoning model with a fixed budget.",
			adaptivity: "fixed",
			source: "test",
			asOf: "2026-01-01",
		};
		const block = buildModelProfileBlock(fixed, {
			modelRef: "legacy/x",
			current: "medium",
			available: ["low", "medium", "high"],
		});
		assert.ok(block);
		assert.ok(block.includes("maps more directly to tokens spent"));
		assert.ok(!block.includes("willingness ceiling"));
	});

	test("no profile block ever names a level outside the available set (exhaustive)", () => {
		// The invariant: every thinking level the block names must be selectable now.
		// Word boundaries matter — `xhigh` contains `high`, so a substring scan would
		// wrongly flag it; \b keeps the two distinct.
		const agent = ["low", "medium", "high", "xhigh", "max"] as const;
		const named = (block: string): string[] => agent.filter((l) => new RegExp(`\\b${l}\\b`).test(block));
		// Every non-empty subset of the agent ladder, so singletons and gaps are all covered.
		const subsets: AgentThinkingLevel[][] = [];
		for (let mask = 1; mask < 1 << agent.length; mask++) {
			const set = agent.filter((_, idx) => (mask & (1 << idx)) !== 0) as AgentThinkingLevel[];
			subsets.push(set);
		}
		for (const profile of Object.values(MODEL_EFFORT_PROFILES)) {
			for (const available of subsets) {
				const block = buildModelProfileBlock(profile, {
					modelRef: "x/y",
					current: available[0] as ConfigurableThinkingLevel,
					available,
				});
				assert.ok(block, `${profile.family} produced no block for ${available.join(",")}`);
				const leaked = named(block).filter((l) => !available.includes(l as AgentThinkingLevel));
				assert.deepEqual(
					leaked,
					[],
					`${profile.family} named unavailable level(s) ${leaked.join(",")} for available=[${available.join(",")}]`,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
	console.log("\nFailures:");
	for (const f of failures) console.log(f);
	process.exit(1);
}
console.log("All tests passed ✓");
