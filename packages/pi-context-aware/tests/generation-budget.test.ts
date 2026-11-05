import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import assert from "node:assert/strict";
import {
	DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS,
	GENERATION_PROTOCOL_OVERHEAD_TOKENS,
	assessGenerationBudget,
	isProactiveCompactionCheckpoint,
	normalizeGenerationOutputReserve,
	parseGenerationOutputReserve,
} from "../src/compaction/generation-budget.js";

test("marks the issue #5 reproduction unsafe before a 272k model turn", () => {
	const budget = assessGenerationBudget({
		contextWindow: 272_000,
		usedTokens: 268_000,
		configuredOutputReserveTokens: DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS,
		modelMaxOutputTokens: 128_000,
	});

	assert.deepEqual(budget, {
		contextWindow: 272_000,
		usedTokens: 268_000,
		headroomTokens: 4_000,
		outputReserveTokens: 32_768,
		protocolOverheadTokens: 2_048,
		requiredHeadroomTokens: 34_816,
		shortfallTokens: 30_816,
		safe: false,
	});
});

test("caps the requested output allowance at a smaller model output limit", () => {
	const budget = assessGenerationBudget({
		contextWindow: 32_000,
		usedTokens: 25_856,
		configuredOutputReserveTokens: 16_384,
		modelMaxOutputTokens: 4_096,
	});

	assert.equal(budget.outputReserveTokens, 4_096);
	assert.equal(budget.protocolOverheadTokens, GENERATION_PROTOCOL_OVERHEAD_TOKENS);
	assert.equal(budget.requiredHeadroomTokens, 6_144);
	assert.equal(budget.shortfallTokens, 0);
	assert.equal(budget.safe, true, "exactly the required reserve is safe");
});

test("parses configurable output reserve token counts", () => {
	assert.equal(parseGenerationOutputReserve("16384"), 16_384);
	assert.equal(parseGenerationOutputReserve("32k"), 32_000);
	assert.equal(parseGenerationOutputReserve("1.5m"), 1_500_000);
	assert.equal(parseGenerationOutputReserve("24_000.9"), 24_000);
	assert.equal(parseGenerationOutputReserve("0"), null);
	assert.equal(parseGenerationOutputReserve("many"), null);
});

test("bounds malformed usage and reserve metadata conservatively", () => {
	assert.equal(normalizeGenerationOutputReserve(undefined), DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS);
	assert.equal(normalizeGenerationOutputReserve(-1), DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS);
	assert.equal(normalizeGenerationOutputReserve(Number.NaN), DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS);
	assert.equal(normalizeGenerationOutputReserve(24_000.9), 24_000);

	const budget = assessGenerationBudget({
		contextWindow: 8_000,
		usedTokens: 9_000,
		configuredOutputReserveTokens: 16_384,
		modelMaxOutputTokens: Number.NaN,
		protocolOverheadTokens: -10,
	});
	assert.equal(budget.headroomTokens, 0);
	assert.equal(budget.outputReserveTokens, 8_000);
	assert.equal(budget.protocolOverheadTokens, 0);
	assert.equal(budget.requiredHeadroomTokens, 8_000);
	assert.equal(budget.shortfallTokens, 8_000);
	assert.equal(budget.safe, false);
});

test("checks output budget after every provider-completed turn, including tool loops", () => {
	for (const stopReason of ["stop", "toolUse", "length", "error"]) {
		assert.equal(isProactiveCompactionCheckpoint(stopReason), true, stopReason);
	}
	for (const stopReason of ["aborted", undefined, "unknown"]) {
		assert.equal(isProactiveCompactionCheckpoint(stopReason), false, String(stopReason));
	}
});

// pi-context-aware#244 (CR-LARGE-OUTPUT-HEADROOM): the reserve is the model's real maximum output, capped.
// The models are read from the pinned @earendil-works/pi-ai catalog, so a change to a model's limits
// changes these cases instead of leaving an invented figure behind.
const CURRENT_MODELS = [
	["openai", "gpt-5.2"],
	["openai", "gpt-5.5"],
	["anthropic", "claude-opus-4-5"],
	["anthropic", "claude-opus-4-8"],
	["anthropic", "claude-sonnet-4-6"],
	["google", "gemini-2.5-pro"],
] as const;

test("on current large-output models the reply reserve is the capped output limit, not the fixed 16,384", () => {
	for (const [provider, id] of CURRENT_MODELS) {
		const model = getBuiltinModel(provider, id as never) as { contextWindow: number; maxTokens: number };
		assert.ok(model.maxTokens > DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS, id + " has an output limit above the cap, so the cap decides");
		const unsafe = assessGenerationBudget({ contextWindow: model.contextWindow, usedTokens: model.contextWindow - 20_000, configuredOutputReserveTokens: DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS, modelMaxOutputTokens: model.maxTokens });
		assert.equal(unsafe.outputReserveTokens, DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS, id);
		assert.equal(unsafe.requiredHeadroomTokens, DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS + GENERATION_PROTOCOL_OVERHEAD_TOKENS, id);
		assert.equal(unsafe.safe, false, id + ": 20,000 tokens of room is less than a 32,768-token reply plus overhead");
		const roomy = assessGenerationBudget({ contextWindow: model.contextWindow, usedTokens: model.contextWindow - 40_000, configuredOutputReserveTokens: DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS, modelMaxOutputTokens: model.maxTokens });
		assert.equal(roomy.safe, true, id + ": 40,000 tokens of room covers the capped reserve");
		assert.ok(model.contextWindow - roomy.requiredHeadroomTokens >= 0.82 * model.contextWindow, id + " keeps at least 82% of the window usable");
	}
});

test("a model whose output limit is below the cap holds back its own limit", () => {
	const model = getBuiltinModel("openai", "gpt-5.3-codex-spark" as never) as { contextWindow: number; maxTokens: number };
	assert.ok(model.maxTokens < DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS);
	const budget = assessGenerationBudget({ contextWindow: model.contextWindow, usedTokens: 0, configuredOutputReserveTokens: DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS, modelMaxOutputTokens: model.maxTokens });
	assert.equal(budget.outputReserveTokens, model.maxTokens);
});

test("a user-set cap above the default is honoured up to the model's output limit", () => {
	const model = getBuiltinModel("anthropic", "claude-opus-4-8" as never) as { contextWindow: number; maxTokens: number };
	const budget = assessGenerationBudget({ contextWindow: model.contextWindow, usedTokens: 0, configuredOutputReserveTokens: 1_000_000, modelMaxOutputTokens: model.maxTokens });
	assert.equal(budget.outputReserveTokens, model.maxTokens);
});
