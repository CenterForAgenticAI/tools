import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	errorFromLlmResponse,
	isContextOverflowError,
	reduceTextForOverflow,
	reduceTextForOverflowRetry,
	runWithContextOverflowRecovery,
	type ContextOverflowRecoveryEvent,
} from "../overflow-recovery.js";

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

test("detects provider context-overflow errors across common error shapes", () => {
	for (const error of [
		new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 130001 tokens."),
		{ code: "context_length_exceeded", message: "Please reduce the length of the messages." },
		{ error: { type: "invalid_request_error", message: "prompt is too long: 213410 tokens > 200000 maximum" } },
		{ errorMessage: "The input token count (140000) exceeds the maximum number of tokens allowed (131072)." },
		{ body: JSON.stringify({ error: { code: "context_window_exceeded" } }) },
	]) {
		assert.equal(isContextOverflowError(error), true, JSON.stringify(error));
	}
});

test("does not mistake unrelated provider and output-limit errors for context overflow", () => {
	for (const error of [
		new Error("Rate limit exceeded: too many tokens; retry after 30 seconds"),
		new Error("Output hit the maximum token limit"),
		new Error("Request was aborted"),
		{ code: "insufficient_quota", message: "You exceeded your current quota" },
	]) {
		assert.equal(isContextOverflowError(error), false, JSON.stringify(error));
	}
});

test("turns failed LLM responses into errors while leaving successful responses alone", () => {
	assert.equal(errorFromLlmResponse(assistantMessage({ stopReason: "stop" })), null);
	assert.equal(errorFromLlmResponse(assistantMessage({ stopReason: "aborted", errorMessage: "cancelled" })), null);

	const overflow = errorFromLlmResponse(assistantMessage({
		stopReason: "error",
		errorMessage: "maximum context length is 128000 tokens",
	}));
	assert.ok(overflow);
	assert.match(overflow.message, /maximum context length/);
	assert.equal(isContextOverflowError(overflow), true);

	const generic = errorFromLlmResponse(assistantMessage({ stopReason: "error" }));
	assert.ok(generic);
	assert.equal(generic.message, "LLM request failed without an error message");
});

test("detects provider silent-overflow and context-filled length responses", () => {
	const silent = errorFromLlmResponse(assistantMessage({
		stopReason: "stop",
		usage: {
			...assistantMessage({}).usage,
			input: 8_100,
			totalTokens: 8_100,
		},
	}), 8_000);
	assert.ok(silent);
	assert.match(silent.message, /context window/i);

	const lengthStop = errorFromLlmResponse(assistantMessage({
		stopReason: "length",
		usage: {
			...assistantMessage({}).usage,
			input: 7_950,
			output: 0,
			totalTokens: 7_950,
		},
	}), 8_000);
	assert.ok(lengthStop);

	const partialLengthStop = errorFromLlmResponse(assistantMessage({
		stopReason: "length",
		usage: {
			...assistantMessage({}).usage,
			input: 7_950,
			output: 1,
			totalTokens: 7_951,
		},
	}), 8_000);
	assert.equal(partialLengthStop, null);
});

test("retries a context overflow with a reduced payload", async () => {
	const events: ContextOverflowRecoveryEvent[] = [];
	let primaryCalls = 0;
	let reducedCalls = 0;
	const result = await runWithContextOverflowRecovery({
		operation: "seed expansion",
		primary: async () => {
			primaryCalls++;
			throw new Error("maximum context length is 128000 tokens");
		},
		reduced: async () => {
			reducedCalls++;
			return "recovered";
		},
		onRecovery: (event) => events.push(event),
	});

	assert.equal(result, "recovered");
	assert.equal(primaryCalls, 1);
	assert.equal(reducedCalls, 1);
	assert.deepEqual(events.map((event) => event.stage), ["reduced-payload"]);
	assert.match(events[0]?.message ?? "", /seed expansion/i);
});

test("uses the configured fallback after the reduced retry also overflows", async () => {
	const events: ContextOverflowRecoveryEvent[] = [];
	const calls: string[] = [];
	const result = await runWithContextOverflowRecovery({
		operation: "compaction",
		primary: async () => {
			calls.push("primary");
			throw { code: "context_length_exceeded" };
		},
		reduced: async () => {
			calls.push("reduced");
			throw new Error("prompt is too long: 90000 tokens > 80000 maximum");
		},
		fallback: {
			model: "anthropic/claude-sonnet-4-6",
			run: async () => {
				calls.push("fallback");
				return "fallback summary";
			},
		},
		onRecovery: (event) => events.push(event),
	});

	assert.equal(result, "fallback summary");
	assert.deepEqual(calls, ["primary", "reduced", "fallback"]);
	assert.deepEqual(events.map((event) => event.stage), ["reduced-payload", "fallback-model"]);
	assert.match(events[1]?.message ?? "", /anthropic\/claude-sonnet-4-6/);
});

test("does not retry non-overflow failures and rethrows the last overflow when recovery is exhausted", async () => {
	let reducedCalled = false;
	await assert.rejects(
		runWithContextOverflowRecovery({
			operation: "artifact generation",
			primary: async () => {
				throw new Error("401 invalid API key");
			},
			reduced: async () => {
				reducedCalled = true;
				return "unexpected";
			},
		}),
		/401 invalid API key/,
	);
	assert.equal(reducedCalled, false);

	await assert.rejects(
		runWithContextOverflowRecovery({
			operation: "seed generation",
			primary: async () => {
				throw new Error("context_length_exceeded");
			},
			reduced: async () => {
				throw new Error("input exceeds the model context window on retry");
			},
		}),
		/input exceeds the model context window on retry/,
	);
});

test("does not start another recovery attempt after cancellation", async () => {
	const controller = new AbortController();
	let reducedCalled = false;
	await assert.rejects(
		runWithContextOverflowRecovery({
			operation: "seed expansion",
			signal: controller.signal,
			primary: async () => {
				controller.abort(new Error("cancelled by test"));
				throw new Error("context_length_exceeded");
			},
			reduced: async () => {
				reducedCalled = true;
				return "unexpected";
			},
		}),
		/cancelled by test/,
	);
	assert.equal(reducedCalled, false);
});

test("reduces oversized text middle-out while preserving the beginning and recent tail", () => {
	const input = `BEGIN:${"a".repeat(200)}:MIDDLE:${"b".repeat(400)}:TAIL:${"z".repeat(200)}:END`;
	const reduced = reduceTextForOverflow(input, 240);
	assert.ok(reduced.length <= 240);
	assert.match(reduced, /^BEGIN:/);
	assert.match(reduced, /:END$/);
	assert.match(reduced, /omitted for context-overflow retry/);
	assert.equal(reduceTextForOverflow("short", 240), "short");
});

test("overflow retry reduction is relative to the rejected payload even below the absolute cap", () => {
	const tokenDensePayload = "🧠".repeat(20_000);
	assert.equal(reduceTextForOverflow(tokenDensePayload, 179_200), tokenDensePayload);

	const reduced = reduceTextForOverflowRetry(tokenDensePayload, 179_200, tokenDensePayload.length);
	assert.ok(reduced.length < tokenDensePayload.length);
	assert.ok(reduced.length <= Math.floor(tokenDensePayload.length / 2));
	assert.ok(reduced.startsWith("🧠"));
	assert.ok(reduced.endsWith("🧠"));
});
