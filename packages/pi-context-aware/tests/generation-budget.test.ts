import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_GENERATION_OUTPUT_RESERVE_TOKENS,
	GENERATION_PROTOCOL_OVERHEAD_TOKENS,
	assessGenerationBudget,
	isProactiveCompactionCheckpoint,
	normalizeGenerationOutputReserve,
	parseGenerationOutputReserve,
} from "../generation-budget.js";

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
		outputReserveTokens: 16_384,
		protocolOverheadTokens: 2_048,
		requiredHeadroomTokens: 18_432,
		shortfallTokens: 14_432,
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
