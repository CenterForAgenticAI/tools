import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCacheGuard } from "../src/cache/cache-guard.js";

// Pi's idle cache warmer (pi-context-aware#564) resends the last request with `maxTokens: 1`.
// The output limit is outside the cached prefix, so a warm request or changed
// limit does not break the cache.
//
// Pi is the external boundary: these tests drive the guard's registered handlers with a stub
// ExtensionAPI and ExtensionContext, because a session cannot trigger the 260-second idle timer.
// Every payload is built by pi-ai's own Anthropic Messages encoder.

const GUARD_ENTRY = "context-aware.cache-guard.v1";
const VERDICT_ENTRY = "context-aware.cache-verdict.v1";

function anthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Cache guard model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 4_096,
	} as Model<"anthropic-messages">;
}

/** The request body pi-ai's Anthropic encoder builds for this context and these stream options. */
async function encode(context: TranscriptContext, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const done = new Error("payload captured");
	const events = streamAnthropic(anthropicModel(), context, {
		...options,
		apiKey: "test-only",
		onPayload(payload: unknown) { captured = structuredClone(payload) as Record<string, unknown>; throw done; },
	} as Parameters<typeof streamAnthropic>[2]);
	for await (const event of events) if (event.type === "error" && event.error.errorMessage !== done.message && !captured) throw new Error(event.error.errorMessage ?? "capture failed");
	assert.ok(captured, "the encoder produced a payload");
	return captured;
}

function harness() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const entries: Array<{ readonly type: string; readonly data: Record<string, unknown> }> = [];
	const dialogs: string[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		appendEntry(type: string, data: Record<string, unknown>) { entries.push({ type, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" },
		hasUI: true,
		mode: "tui",
		ui: {
			confirm(_title: string, text: string) { dialogs.push(text); return Promise.resolve(true); },
			setStatus() {},
		},
		abort() {},
	} as unknown as ExtensionContext;
	const guard = registerCacheGuard(pi, () => ({ enabled: true, askAboveUsd: 0, interactive: "auto", askTimeoutMs: 60_000 }));
	return {
		dialogs,
		guardEntries: () => entries.filter((entry) => entry.type === GUARD_ENTRY).map((entry) => entry.data),
		verdicts: () => entries.filter((entry) => entry.type === VERDICT_ENTRY).map((entry) => entry.data),
		agentStart: (prompt: string) => guard.agentStart({ prompt }),
		request: async (payload: unknown) => { await guard.providerRequest(payload, ctx); },
		messageEnd: (message: unknown) => guard.messageEnd(message),
	};
}

const lead = { role: "system", content: "", sections: { handbook: "stable ".repeat(2000) }, timestamp: 0 } as unknown as Message;
const question = { role: "user", content: "question", timestamp: 1 } as Message;

/** A reply that reports usage, so its request becomes the baseline. */
function observedReply(text: string, timestamp: number): Message {
	const reply = fauxAssistantMessage(text) as Message & { usage: Record<string, unknown>; timestamp: number };
	return { ...reply, timestamp, usage: { ...reply.usage, input: 10, cacheRead: 4_000, cacheWrite: 200 } } as Message;
}

test("S7: a cache-warm request between two real requests with the same prefix asks nothing and logs no break", async () => {
	const h = harness();
	const first: TranscriptContext = { messages: [lead, question] } as unknown as TranscriptContext;
	const realOptions = {};
	const real = await encode(first, realOptions);
	const warm = await encode(first, { maxTokens: 1 });
	assert.equal(warm.max_tokens, 1, "the fixture's warm request carries Pi's one-token cap");
	assert.notEqual(real.max_tokens, 1, "the fixture's real request does not");
	assert.deepEqual({ ...warm, max_tokens: undefined }, { ...real, max_tokens: undefined }, "the warm request repeats the real one apart from its cap");

	const answer = observedReply("answer", 2);
	h.agentStart("question");
	await h.request(real);
	h.messageEnd(answer);
	// Pi's idle warmer fires about 260 seconds later, outside any turn.
	await h.request(warm);
	h.messageEnd(observedReply("", 3));
	h.agentStart("next");
	await h.request(await encode({ messages: [lead, question, answer, { role: "user", content: "next", timestamp: 4 } as Message] } as unknown as TranscriptContext, realOptions));

	assert.deepEqual(h.guardEntries(), [], "no break is logged");
	assert.deepEqual(h.dialogs, [], "the operator is asked nothing");
	// A request that is compared and shows no break records one cache verdict; the warm request is not compared.
	assert.equal(h.verdicts().length, 1, "only the next real request is compared, with the last real request");
});

test("S8: two real requests that differ only in max_tokens report no break", async () => {
	const h = harness();
	const context: TranscriptContext = { messages: [lead, question] } as unknown as TranscriptContext;
	const first = await encode(context, { maxTokens: 4_096 });
	const second = await encode(context, { maxTokens: 8_192 });
	assert.deepEqual([first.max_tokens, second.max_tokens], [4_096, 8_192], "the fixture differs in max_tokens");
	assert.deepEqual({ ...second, max_tokens: undefined }, { ...first, max_tokens: undefined }, "and in nothing else");
	h.agentStart("question");
	await h.request(first);
	h.agentStart("again");
	await h.request(second);
	assert.deepEqual(h.guardEntries(), [], "an output limit is not part of the cached prefix");
	assert.deepEqual(h.dialogs, []);
});
