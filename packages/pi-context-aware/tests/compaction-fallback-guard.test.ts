import test from "node:test";
import assert from "node:assert/strict";
import {
	MIN_USEFUL_COMPACTION_OUTPUT_TOKENS,
	PI_CONTEXT_SAFETY_TOKENS,
	decideBuiltinCompactionFallback,
	estimateBuiltinCompactionRequestTokens,
	type BuiltinCompactionRequest,
} from "../src/compaction/compaction-fallback-guard.js";

const historyRequest = (conversationText: string): BuiltinCompactionRequest => ({
	kind: "history",
	conversationText,
});

test("allows the built-in fallback when every complete request leaves useful output room", () => {
	const decision = decideBuiltinCompactionFallback({
		requests: [historyRequest("x".repeat(50_000)), { kind: "turn-prefix", conversationText: "x".repeat(10_000) }],
		contextWindow: 200_000,
	});
	assert.deepEqual(decision, { fallback: true });
});

test("does not subtract Pi's compaction reserve from a request that fits", () => {
	const request = historyRequest("x".repeat(300_000));
	const requestTokens = estimateBuiltinCompactionRequestTokens(request);
	const contextWindow = 100_000;
	const piDefaultReserveTokens = 16_384;
	assert.ok(requestTokens > contextWindow - piDefaultReserveTokens);
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requests: [request], contextWindow }),
		{ fallback: true },
	);
});

test("refuses the built-in fallback when the largest complete request would overflow", () => {
	const decision = decideBuiltinCompactionFallback({
		requests: [historyRequest("x".repeat(4_000_000)), { kind: "turn-prefix", conversationText: "small" }],
		contextWindow: 1_050_000,
	});
	assert.equal(decision.fallback, false);
	assert.match(decision.fallback === false ? decision.reason : "", /at least 1024 are required/u);
});

test("judges each request separately, not their sum", () => {
	const request = historyRequest("x".repeat(300_000));
	const requestTokens = estimateBuiltinCompactionRequestTokens(request);
	const contextWindow = requestTokens + PI_CONTEXT_SAFETY_TOKENS + MIN_USEFUL_COMPACTION_OUTPUT_TOKENS;
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requests: [request, request], contextWindow }),
		{ fallback: true },
	);
});

test("requires the named useful output budget after Pi's safety margin", () => {
	const request = historyRequest("x".repeat(100_000));
	const requestTokens = estimateBuiltinCompactionRequestTokens(request);
	const exactMinimumWindow = requestTokens + PI_CONTEXT_SAFETY_TOKENS + MIN_USEFUL_COMPACTION_OUTPUT_TOKENS;
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requests: [request], contextWindow: exactMinimumWindow }),
		{ fallback: true },
	);
	assert.equal(
		decideBuiltinCompactionFallback({ requests: [request], contextWindow: exactMinimumWindow - 1 }).fallback,
		false,
	);
});

test("does not block the fallback when the window or requests are unknown", () => {
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requests: [historyRequest("x".repeat(10_000_000))], contextWindow: undefined }),
		{ fallback: true },
	);
	assert.deepEqual(
		decideBuiltinCompactionFallback({ requests: [], contextWindow: 100_000 }),
		{ fallback: true },
	);
});

test("pins the local estimator's history request overhead and refuses the 90,000-in-100,000 regression", () => {
	assert.equal(estimateBuiltinCompactionRequestTokens(historyRequest("")), 350);
	// Pi's raw-message estimator sees 360,000 content characters as 90,000
	// tokens. serializeConversation adds the user label before Pi wraps the
	// conversation and appends its request instructions and system prompt.
	const request = historyRequest(`[User]: ${"x".repeat(360_000)}`);
	assert.equal(estimateBuiltinCompactionRequestTokens(request), 103_209);
	assert.equal(
		decideBuiltinCompactionFallback({ requests: [request], contextWindow: 100_000 }).fallback,
		false,
	);
});

test("pins the local estimator's split-turn prefix request overhead", () => {
	assert.equal(estimateBuiltinCompactionRequestTokens({ kind: "turn-prefix", conversationText: "" }), 288);
});

test("includes previous-summary and focus text in the history estimate", () => {
	const plain = estimateBuiltinCompactionRequestTokens(historyRequest("conversation"));
	const augmented = estimateBuiltinCompactionRequestTokens({
		kind: "history",
		conversationText: "conversation",
		previousSummary: "prior checkpoint",
		customInstructions: "preserve the requested focus",
	});
	assert.ok(augmented > plain);
});
