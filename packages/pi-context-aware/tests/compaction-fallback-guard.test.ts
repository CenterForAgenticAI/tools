import test from "node:test";
import assert from "node:assert/strict";
import {
	BUILTIN_COMPACTION_RESERVE_TOKENS,
	decideBuiltinCompactionFallback,
	extrapolateBoundedInputTokens,
} from "../compaction-fallback-guard.js";

test("allows the built-in fallback when every request fits within the window minus reserve", () => {
	const decision = decideBuiltinCompactionFallback({
		requestTokens: [50_000, 10_000],
		contextWindow: 200_000,
	});
	assert.deepEqual(decision, { fallback: true });
});

test("refuses the built-in fallback when the largest request cannot fit and would overflow", () => {
	const decision = decideBuiltinCompactionFallback({
		requestTokens: [1_040_000, 5_000],
		contextWindow: 1_050_000,
	});
	assert.equal(decision.fallback, false);
	assert.match(decision.fallback === false ? decision.reason : "", /exceeds/u);
});

test("judges each request separately, not their sum", () => {
	// Two requests that each fit but whose sum would not: the built-in sends
	// them separately, so this must be allowed.
	const window = 200_000;
	const each = window - BUILTIN_COMPACTION_RESERVE_TOKENS - 1;
	const decision = decideBuiltinCompactionFallback({
		requestTokens: [each, each],
		contextWindow: window,
	});
	assert.deepEqual(decision, { fallback: true });
});

test("uses Pi's default reserve at the boundary", () => {
	const window = 100_000;
	const available = window - BUILTIN_COMPACTION_RESERVE_TOKENS;
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requestTokens: [available], contextWindow: window }),
		{ fallback: true },
	);
	assert.equal(
		decideBuiltinCompactionFallback({ requestTokens: [available + 1], contextWindow: window }).fallback,
		false,
	);
});

test("honours a configured reserve override", () => {
	const decision = decideBuiltinCompactionFallback({
		requestTokens: [85_000],
		contextWindow: 100_000,
		reserveTokens: 20_000,
	});
	assert.equal(decision.fallback, false);
});

test("does not block the fallback when the window or estimates are unknown", () => {
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requestTokens: [10_000_000], contextWindow: undefined }),
		{ fallback: true },
	);
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requestTokens: [0, 0], contextWindow: 100_000 }),
		{ fallback: true },
	);
});

test("extrapolateBoundedInputTokens returns raw tokens for a complete estimate", () => {
	assert.equal(
		extrapolateBoundedInputTokens({
			tokens: 40_000,
			inputMessageCount: 300,
			accountedInputMessageCount: 300,
			bounded: false,
		}),
		40_000,
	);
});

test("extrapolateBoundedInputTokens scales a bounded estimate up to the full message set", () => {
	// The real failing session: 1613 messages, estimator capped at 512.
	const scaled = extrapolateBoundedInputTokens({
		tokens: 300_000,
		inputMessageCount: 1613,
		accountedInputMessageCount: 512,
		bounded: true,
	});
	assert.equal(scaled, Math.round(300_000 * (1613 / 512)));
	assert.ok(scaled > 900_000, "extrapolated estimate should reflect the full transcript");
});

test("a bounded estimate that would overflow the built-in is caught after extrapolation", () => {
	const estimate = {
		tokens: 300_000,
		inputMessageCount: 1613,
		accountedInputMessageCount: 512,
		bounded: true,
	};
	const scaled = extrapolateBoundedInputTokens(estimate); // ~945k
	// A window where the raw (un-extrapolated) 300k estimate would fit, but the
	// extrapolated full-transcript estimate does not: extrapolation is what
	// flips the verdict from an unsafe allow to a correct refusal.
	const window = 950_000;
	assert.equal(
		decideBuiltinCompactionFallback({ requestTokens: [estimate.tokens], contextWindow: window }).fallback,
		true,
	);
	assert.equal(
		decideBuiltinCompactionFallback({ requestTokens: [scaled], contextWindow: window }).fallback,
		false,
	);
});

test("extrapolateBoundedInputTokens handles zero and unusable inputs", () => {
	assert.equal(extrapolateBoundedInputTokens({ tokens: 0, inputMessageCount: 0, accountedInputMessageCount: 0, bounded: false }), 0);
	assert.equal(
		extrapolateBoundedInputTokens({ tokens: 100, inputMessageCount: 10, accountedInputMessageCount: 0, bounded: true }),
		100,
	);
});
