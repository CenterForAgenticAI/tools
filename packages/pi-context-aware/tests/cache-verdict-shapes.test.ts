import test from "node:test";
import assert from "node:assert/strict";

import type { AssistantMessage, Message, Model, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { CACHE_GUARD_ENTRY, registerCacheGuard } from "../src/cache/cache-guard.js";
import { CACHE_VERDICT_ENTRY, explainCacheOnBranch } from "../src/cache/cache-explain.js";

// cache.explain names the changed block in every request shape Pi encodes, and compares a
// request with the same baseline its usage is measured against (pi-context-aware#541, MR !437).
//
// Each body comes from pi-ai's own encoder through its onPayload hook, before any network I/O,
// so the guard sees exactly what Pi sends.

type ShapeApi = "google-generative-ai" | "openai-responses" | "openai-completions";

const ZERO_USAGE: AssistantMessage["usage"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function captureModel(api: ShapeApi): Model<ShapeApi> {
	return {
		id: "capture-model", name: "Capture model", api, provider: "capture", baseUrl: "http://127.0.0.1:9", reasoning: false,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1_024,
	} as Model<ShapeApi>;
}

function assistantOf(api: ShapeApi, content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return { role: "assistant", content, api, provider: "capture", model: "capture-model", usage: ZERO_USAGE, stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp };
}

interface Transcript {
	readonly question?: string;
	readonly toolResult?: string;
	readonly toolArgs?: Record<string, string>;
	/** Another user message after the answer, so the earlier prefix is what the previous request sent. */
	readonly more?: boolean;
}

/** A question, one `read` tool round trip, an answer, and a follow-up. */
function transcript(api: ShapeApi, options: Transcript = {}): Message[] {
	const messages: Message[] = [
		{ role: "user", content: options.question ?? "question", timestamp: 1 },
		assistantOf(api, [{ type: "toolCall", id: "call_1", name: "read", arguments: options.toolArgs ?? { path: "a.txt" } }], 2),
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: options.toolResult ?? "file A says hello" }], isError: false, timestamp: 3 } as ToolResultMessage,
		assistantOf(api, [{ type: "text", text: "answer" }], 4),
		{ role: "user", content: "next", timestamp: 5 },
	];
	if (options.more) messages.push(assistantOf(api, [{ type: "text", text: "more" }], 6), { role: "user", content: "again", timestamp: 7 });
	return messages;
}

function tool(name: string): Tool {
	return { name, description: `The ${name} tool`, parameters: { type: "object", properties: {} } } as unknown as Tool;
}

/** The request body pi-ai would send on `api`, captured before network I/O. */
async function capture(api: ShapeApi, messages: Message[], tools: Tool[] = [tool("read")]): Promise<Record<string, unknown>> {
	let captured: unknown;
	const done = new Error("provider payload captured");
	const context = normalizeContext({ systemPrompt: "You are careful.", messages, tools });
	const options = { apiKey: "test-only", onPayload(payload: unknown) { captured = structuredClone(payload); throw done; } };
	const model = captureModel(api);
	const events = api === "google-generative-ai"
		? streamGoogle(model as Model<"google-generative-ai">, context, options)
		: api === "openai-responses"
			? streamResponses(model as Model<"openai-responses">, context, options)
			: streamCompletions(model as Model<"openai-completions">, context, options);
	for await (const event of events) {
		if (event.type === "error" && event.error.errorMessage !== done.message) throw new Error(event.error.errorMessage ?? `${api} capture failed`);
	}
	assert.ok(captured && typeof captured === "object", `${api} onPayload must expose the request body`);
	return captured as Record<string, unknown>;
}

interface UsageIn { input: number; read: number; write: number }
interface Appended { readonly type: string; readonly data: Record<string, unknown> }

function assistantEntry(at: number, usage: UsageIn): SessionEntry {
	return {
		type: "message", id: "m" + at, parentId: null, timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant", content: [], api: "anthropic-messages", provider: "capture", model: "capture-model", stopReason: "stop", timestamp: at,
			usage: { input: usage.input, output: 0, cacheRead: usage.read, cacheWrite: usage.write, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	} as unknown as SessionEntry;
}

/** A guard on a stub Pi. Each request appends the guard's entries, then the reply, and reports message_end. */
function session() {
	const appended: Appended[] = [];
	let pending: Appended[] = [];
	const branch: SessionEntry[] = [];
	const pi = {
		on() {},
		appendEntry(type: string, data: Record<string, unknown>) { pending.push({ type, data }); appended.push({ type, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		model: { provider: "capture", id: "capture-model", api: "anthropic-messages" },
		hasUI: false,
		ui: { confirm: () => Promise.resolve(true), setStatus() {} },
		abort() {},
	} as unknown as ExtensionContext;
	const guard = registerCacheGuard(pi, () => ({ enabled: true, askAboveUsd: 1000 }));
	return {
		branch, appended,
		async request(payload: Record<string, unknown>, at: number, usage: UsageIn) {
			await guard.providerRequest(payload, ctx);
			for (const entry of pending) branch.push({ type: "custom", id: "c" + branch.length, parentId: null, timestamp: "", customType: entry.type, data: entry.data } as unknown as SessionEntry);
			pending = [];
			const reply = assistantEntry(at, usage);
			branch.push(reply);
			guard.messageEnd((reply as unknown as { message: unknown }).message);
		},
		verdicts() { return appended.filter((entry) => entry.type === CACHE_VERDICT_ENTRY).map((entry) => entry.data); },
	};
}

const T0 = 1_800_000_000_000;
const SEC = 1000;
const FIRST: UsageIn = { input: 100, read: 0, write: 10_000 };
const MID_MISS: UsageIn = { input: 0, read: 6000, write: 4600 };
const FAILED: UsageIn = { input: 0, read: 0, write: 0 };

/** The verdict the guard writes for a second request, after a first request with the same tools. */
async function verdictFor(api: ShapeApi, first: Transcript, second: Transcript): Promise<Record<string, unknown> | undefined> {
	const s = session();
	await s.request(await capture(api, transcript(api, first)), T0, FIRST);
	await s.request(await capture(api, transcript(api, second)), T0 + 30 * SEC, MID_MISS);
	return s.verdicts().at(-1);
}

test("Google: a rewritten question in contents is named, not reported as unchanged", async () => {
	const verdict = await verdictFor("google-generative-ai", {}, { question: "a different question" });
	assert.deepEqual(verdict, { kind: "message-block", index: 0, count: 5, role: "user", type: "text" });
});

test("Google: a rewritten function response names its tool", async () => {
	const verdict = await verdictFor("google-generative-ai", {}, { toolResult: "file A says hello (folded)" });
	assert.deepEqual(verdict, { kind: "message-block", index: 2, count: 5, role: "user", type: "functionResponse", tool: "read" });
});

test("Google: an identical contents prefix is unchanged", async () => {
	const verdict = await verdictFor("google-generative-ai", {}, { more: true });
	assert.deepEqual(verdict, { kind: "unchanged" });
});

test("Google: a tool declared in config.tools is a tools break, never an unchanged prefix", async () => {
	const s = session();
	const api = "google-generative-ai";
	await s.request(await capture(api, transcript(api), [tool("read")]), T0, FIRST);
	await s.request(await capture(api, transcript(api, { more: true }), [tool("read"), tool("write")]), T0 + 30 * SEC, MID_MISS);
	assert.deepEqual(s.verdicts(), []);
	const guardEntry = s.appended.find((entry) => entry.type === CACHE_GUARD_ENTRY);
	assert.equal(guardEntry?.data.kind, "tools");
	assert.deepEqual(guardEntry?.data.names, ["write"]);
});

test("OpenAI Responses: a rewritten function_call_output names its tool and the tool role", async () => {
	const verdict = await verdictFor("openai-responses", {}, { toolResult: "file A says hello (folded)" });
	assert.equal(verdict?.kind, "message-block");
	assert.equal(verdict?.role, "tool");
	assert.equal(verdict?.type, "function_call_output");
	assert.equal(verdict?.tool, "read");
});

test("OpenAI Responses: a rewritten function_call names its tool and the assistant role", async () => {
	const verdict = await verdictFor("openai-responses", {}, { toolArgs: { path: "b.txt" } });
	assert.equal(verdict?.kind, "message-block");
	assert.equal(verdict?.role, "assistant");
	assert.equal(verdict?.type, "function_call");
	assert.equal(verdict?.tool, "read");
});

test("Chat Completions: a rewritten tool message names its tool from tool_call_id", async () => {
	const verdict = await verdictFor("openai-completions", {}, { toolResult: "file A says hello (folded)" });
	assert.equal(verdict?.kind, "message-block");
	assert.equal(verdict?.role, "tool");
	assert.equal(verdict?.tool, "read");
});

test("Chat Completions: a rewritten assistant tool call names the called tool", async () => {
	const verdict = await verdictFor("openai-completions", {}, { toolArgs: { path: "b.txt" } });
	assert.equal(verdict?.kind, "message-block");
	assert.equal(verdict?.role, "assistant");
	assert.equal(verdict?.type, "tool_calls");
	assert.equal(verdict?.tool, "read");
});

test("a failed request with no usage does not become the baseline, so its retry still names the changed block", async () => {
	const api = "openai-responses";
	const s = session();
	const original = await capture(api, transcript(api));
	const rewritten = await capture(api, transcript(api, { toolResult: "file A says hello (folded)" }));
	await s.request(original, T0, FIRST);
	await s.request(rewritten, T0 + 10 * SEC, FAILED);
	await s.request(rewritten, T0 + 30 * SEC, MID_MISS);
	const reset = explainCacheOnBranch(s.branch).get(T0 + 30 * SEC)?.reset;
	assert.equal(reset?.kind, "prefix-mid");
	assert.equal(reset?.cause?.kind, "message-block");
	assert.equal(reset?.cause !== undefined && "tool" in reset.cause ? reset.cause.tool : undefined, "read");
});

test("a request that reported usage is the baseline, so an identical retry after it is unchanged", async () => {
	const api = "openai-responses";
	const s = session();
	const rewritten = await capture(api, transcript(api, { toolResult: "file A says hello (folded)" }));
	await s.request(await capture(api, transcript(api)), T0, FIRST);
	await s.request(rewritten, T0 + 10 * SEC, { input: 0, read: 6000, write: 4600 });
	await s.request(rewritten, T0 + 30 * SEC, { input: 0, read: 6000, write: 4600 });
	assert.deepEqual(s.verdicts().map((verdict) => verdict.kind), ["message-block", "unchanged"]);
});
