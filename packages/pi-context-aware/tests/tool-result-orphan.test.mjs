/**
 * Wire-level reproduction of the orphaned `tool_result` death: issues #10 and #56.
 *
 * Derived from the forensic harness recorded at
 * `~/.pi/records/pi-forensics-tool-result-orphan-20260817/repro.mjs`. It drives the
 * real Anthropic request builder — `stream()` from
 * `@earendil-works/pi-ai/api/anthropic-messages` — with an injected `fetch`, so the
 * captured payload is byte-for-byte what pi would send. The injected fetch applies
 * Anthropic's own pairing rule locally, so the reproduction needs no credentials and
 * no network.
 *
 * An "orphan" here is a `tool_result` block whose `tool_use` block is not in the
 * immediately preceding message. Anthropic rejects the whole conversation for one
 * orphan, and every later turn rebuilds the same rejection, so the session is dead.
 *
 * Two routes produce the identical orphan:
 *   route 1 — this extension's `message_end` drain/output-limit recovery replaced an
 *             assistant message that still carried `toolCall` blocks (#10);
 *   route 2 — pi core's `transformMessages` drops any assistant message whose
 *             `stopReason` is `error` or `aborted` while pushing every `toolResult`
 *             through unconditionally (#56, with this extension uninvolved).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";

const MODEL = {
	id: "claude-opus-5",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.invalid",
	maxTokens: 4096,
	contextWindow: 1_000_000,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const CALL_A = "toolu_01ARtfFhF8ckAvY7s5Jb72pA";
const CALL_B = "toolu_01ARtfFhF8ckAvY7s5Jb72pB";
/** The id from the 2026-08-17 death, kept so the fixture names the observed case. */
const CALL_C = "toolu_01ARtfFhF8ckAvY7s5Jb72ps";

const toolCall = (id, name = "bash") => ({
	type: "toolCall",
	id,
	name,
	arguments: { command: "npm run check" },
});

const toolResult = (id, name = "bash") => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text: "check passed" }],
	isError: false,
	timestamp: 1_760_000_000_000,
});

const assistant = (content, stopReason = "toolUse") => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5",
	stopReason,
	timestamp: 1_760_000_000_000,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1_760_000_000_000 });

/**
 * The control history from #56: a parallel batch (A,B) whose results are valid,
 * then a later single call C with its own result. Every `tool_result` sits in the
 * message right after its `tool_use`, so the provider accepts it.
 */
function controlHistory() {
	return [
		user("do the work"),
		assistant([toolCall(CALL_A), toolCall(CALL_B)]),
		toolResult(CALL_A),
		toolResult(CALL_B),
		assistant([toolCall(CALL_C, "artifact")]),
		toolResult(CALL_C, "artifact"),
	];
}

/** pi core's `_replaceMessageInPlace` (agent-session.js:425), verbatim in behaviour. */
function replaceMessageInPlace(target, replacement) {
	if (target === replacement) return;
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, replacement);
}

/** The pre-fix `message_end` replacement: one text block, every tool call destroyed. */
function singleTextBlockReplacement(message) {
	return {
		...message,
		content: [{
			type: "text",
			text: "[context-aware recovery] The transient cancellation response was discarded. Compacting before retrying the interrupted work.",
		}],
		stopReason: "stop",
		errorMessage: undefined,
	};
}

/** Anthropic's pairing rule, restated exactly, with the provider's own wording. */
function anthropicViolation(messages) {
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const previous = messages[i - 1];
		const ids = new Set(
			previous && previous.role === "assistant" && Array.isArray(previous.content)
				? previous.content.filter((block) => block.type === "tool_use").map((block) => block.id)
				: [],
		);
		for (let b = 0; b < message.content.length; b++) {
			const block = message.content[b];
			if (block.type === "tool_result" && !ids.has(block.tool_use_id)) {
				return {
					index: i,
					block: b,
					toolUseId: block.tool_use_id,
					message: `messages.${i}.content.${b}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${block.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`,
				};
			}
		}
	}
	return null;
}

/** A minimal Anthropic SSE success body, so an accepted payload finishes a turn. */
function successStreamBody(text) {
	const events = [
		["message_start", {
			type: "message_start",
			message: {
				id: "msg_repaired",
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 11, output_tokens: 1 },
			},
		}],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 4 },
		}],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/**
 * Send one `AgentMessage[]` through pi's real Anthropic request path.
 * Returns the captured payload plus the provider outcome, so a test can assert
 * both the exact rejection coordinates and whether the turn completed.
 */
async function sendThroughPi(messages) {
	let captured = null;
	const capturingFetch = async (_url, init) => {
		captured = JSON.parse(init.body);
		const violation = anthropicViolation(captured.messages);
		if (violation) {
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: violation.message } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(successStreamBody("The repaired history was accepted."), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};

	const response = stream(
		MODEL,
		{ systemPrompt: "system", messages, tools: [] },
		{ apiKey: "sk-ant-test", fetch: capturingFetch, maxTokens: 1024 },
	);
	let assistantMessage;
	try {
		// Drain the stream; the payload was captured by the injected fetch.
		for await (const event of response) void event;
		assistantMessage = await response.result();
	} catch (error) {
		assistantMessage = { stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) };
	}
	const violation = anthropicViolation(captured?.messages ?? []);
	return {
		payload: captured,
		violation,
		assistantMessage,
		accepted: violation === null && assistantMessage?.stopReason !== "error",
		shape: (captured?.messages ?? []).map((message, index) => {
			const blocks = Array.isArray(message.content) ? message.content : [{ type: "string" }];
			const described = blocks
				.map((block) => block.type
					+ (block.type === "tool_use" ? `(${block.id})` : block.type === "tool_result" ? `(${block.tool_use_id})` : ""))
				.join(", ");
			return `  [${index}] ${message.role}: ${described}`;
		}).join("\n"),
	};
}

function tmpHome() {
	const dir = path.join(os.tmpdir(), `context-aware-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Register the real extension against a minimal Pi surface and return its
 * `context` hook, which is the seam that sees the whole message list before every
 * request (index.ts:5733).
 */
async function contextHook() {
	const events = new Map();
	const api = {
		events: { emit() {}, on() { return () => {}; } },
		registerFlag() {},
		getFlag() { return undefined; },
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
		sendUserMessage() {},
		getActiveTools() { return []; },
		setActiveTools() {},
		appendEntry() {},
	};
	const extension = await import("../.test-dist/index.js");
	extension.default(api);
	const handler = events.get("context")?.[0];
	assert.ok(handler, "the extension must register a context hook");
	return handler;
}

function fakeContext(home, notifications) {
	return {
		hasUI: true,
		cwd: home,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000 }),
		isProjectTrusted: () => true,
		isIdle: () => true,
		abort: () => {},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionDir: () => home,
			getSessionFile: () => path.join(home, "orphan-session.jsonl"),
			getSessionId: () => "orphan-session",
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => "orphan-leaf",
		},
	};
}

/**
 * Run one history through the extension's real `context` hook, which must return a
 * repaired list rather than leave the request to be rejected.
 */
async function throughContextHook(messages) {
	const home = tmpHome();
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
	const notifications = [];
	try {
		const handler = await contextHook();
		const result = await handler({ type: "context", messages }, fakeContext(home, notifications));
		return { messages: result?.messages ?? messages, replaced: Boolean(result?.messages), notifications };
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("control: the untouched batch-then-single history is accepted by the provider", async () => {
	const sent = await sendThroughPi(controlHistory());
	assert.equal(sent.violation, null, `the control payload must be valid:\n${sent.shape}`);
	assert.equal(sent.accepted, true, "the control history must complete a turn");
	assert.equal(sent.payload.messages.length, 5, sent.shape);
	assert.deepEqual(
		sent.payload.messages[2].content.map((block) => block.tool_use_id),
		[CALL_A, CALL_B],
		"the two parallel results merge into one user message",
	);
});

test("reproduction: the pre-fix single-text-block replacement destroys the tool_use and the provider rejects the turn", async () => {
	const messages = controlHistory();
	const carriesC = messages[4];
	replaceMessageInPlace(carriesC, singleTextBlockReplacement(carriesC));
	const sent = await sendThroughPi(messages);
	assert.ok(sent.violation, `the wiped history must be rejected:\n${sent.shape}`);
	assert.equal(sent.violation.toolUseId, CALL_C);
	assert.equal(sent.assistantMessage.stopReason, "error", "the run dies on the provider rejection");
	assert.match(sent.assistantMessage.errorMessage ?? "", /unexpected `tool_use_id`/);
});

test("#10: a recovery replacement keeps the tool_use blocks of a message whose tool call is in flight", async () => {
	const { buildRecoveryReplacement } = await import("../.test-dist/history-integrity.js");
	const messages = controlHistory();
	const carriesC = messages[4];
	const replacement = buildRecoveryReplacement(carriesC, "[context-aware recovery] The transient cancellation response was discarded.");
	replaceMessageInPlace(carriesC, replacement);

	assert.equal(
		messages[4].content.filter((block) => block.type === "toolCall").length,
		1,
		"the tool call whose result is already on its way must survive the replacement",
	);
	assert.match(messages[4].content[0].text ?? "", /transient cancellation response was discarded/);

	const sent = await sendThroughPi(messages);
	assert.equal(sent.violation, null, `the replaced history must stay valid:\n${sent.shape}`);
	assert.equal(sent.accepted, true, "the turn completes because the result still has a parent");
});

test("#10: a replacement for a message with no tool calls still discards the transient response", async () => {
	const { buildRecoveryReplacement } = await import("../.test-dist/history-integrity.js");
	const original = assistant([{ type: "text", text: "half a sentence" }], "aborted");
	const replacement = buildRecoveryReplacement(original, "[context-aware recovery] discarded");
	assert.deepEqual(replacement.content, [{ type: "text", text: "[context-aware recovery] discarded" }]);
	assert.equal(replacement.stopReason, "stop", "a message with nothing in flight is still fully replaced");
	assert.equal(replacement.errorMessage, undefined);
});

test("#56 route 1: the live-state orphan at content.2 of a merged batch is repaired before the request goes out", async () => {
	// The live-state variant of the 2026-08-17 death: the assistant carrying C is
	// gone, its result survives, and the three results merge into one user message,
	// so the orphan hides at content.2 behind two valid blocks.
	const orphaned = controlHistory().filter((message, index) => index !== 4);

	const before = await sendThroughPi(orphaned);
	assert.ok(before.violation, `the reproduction must reject:\n${before.shape}`);
	assert.equal(before.violation.index, 2, `the orphan must be reported at messages.2:\n${before.shape}`);
	assert.equal(before.violation.block, 2, `the orphan must be reported at content.2:\n${before.shape}`);

	const repaired = await throughContextHook(orphaned);
	assert.equal(repaired.replaced, true, "the context hook must return a repaired message list");
	const after = await sendThroughPi(repaired.messages);
	assert.equal(after.violation, null, `the repaired payload must be valid:\n${after.shape}`);
	assert.equal(after.accepted, true, "a session carrying an orphan must complete a turn");
	assert.equal(
		repaired.notifications.filter((entry) => entry.level === "warning").length,
		1,
		"the repair is reported exactly once, at warning level",
	);
	assert.match(repaired.notifications[0].message, /artifact/, "the warning names the tool");
	assert.ok(repaired.notifications[0].message.includes(CALL_C), "the warning names the tool-call id");
});

test("#56 route 2: pi core dropping an errored assistant is repaired by reattaching its tool_use", async () => {
	// transform-messages.js drops any assistant with stopReason error or aborted and
	// pushes every toolResult through unconditionally. No extension involved.
	const orphaned = [
		user("run the check"),
		assistant([toolCall(CALL_C)], "error"),
		toolResult(CALL_C),
	];

	const before = await sendThroughPi(orphaned);
	assert.ok(before.violation, `the reproduction must reject:\n${before.shape}`);
	assert.equal(before.violation.toolUseId, CALL_C);

	const repaired = await throughContextHook(orphaned);
	const after = await sendThroughPi(repaired.messages);
	assert.equal(after.violation, null, `the repaired payload must be valid:\n${after.shape}`);
	assert.equal(after.accepted, true, "the turn completes after the repair");
	const results = after.payload.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.filter((block) => block.type === "tool_result");
	assert.equal(results.length, 1, "reattaching preserves the tool result rather than dropping it");
	assert.equal(results[0].tool_use_id, CALL_C);
});

test("#56 route 2: an errored assistant inside a merged batch is repaired at content.2", async () => {
	const orphaned = [
		user("do the work"),
		assistant([toolCall(CALL_A), toolCall(CALL_B)]),
		toolResult(CALL_A),
		toolResult(CALL_B),
		assistant([toolCall(CALL_C, "artifact")], "aborted"),
		toolResult(CALL_C, "artifact"),
	];

	const before = await sendThroughPi(orphaned);
	assert.equal(before.violation?.index, 2, `the merged orphan must be at messages.2:\n${before.shape}`);
	assert.equal(before.violation?.block, 2, `the merged orphan must be at content.2:\n${before.shape}`);

	const repaired = await throughContextHook(orphaned);
	const after = await sendThroughPi(repaired.messages);
	assert.equal(after.violation, null, `the repaired payload must be valid:\n${after.shape}`);
	assert.equal(after.accepted, true, "the turn completes after the repair");
});

test("#56: a well-formed history passes through the context hook untouched", async () => {
	const healthy = controlHistory();
	const seen = await throughContextHook(healthy);
	assert.deepEqual(seen.messages, healthy, "a valid history must not be rewritten");
	assert.equal(seen.notifications.length, 0, "nothing is reported when there is nothing to repair");
	const sent = await sendThroughPi(seen.messages);
	assert.equal(sent.accepted, true, "the untouched history still completes a turn");
});
