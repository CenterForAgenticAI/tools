/**
 * Unit coverage for the two guards that keep a `tool_result` attached to its
 * `tool_use`: the recovery-replacement guard (#10) and the validate-then-repair
 * guard (#56).
 *
 * The payload coordinates asserted here (`messages.<i>.content.<b>`) are the ones
 * the provider itself reports; `tests/tool-result-orphan.test.mjs` proves they match
 * a real captured request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildRecoveryReplacement,
	findOrphanedToolResults,
	isOrphanedToolResultRejection,
	orphanedToolCallIdsFromError,
	repairOrphanedToolResults,
} from "../history-integrity.js";
import { isTransientFailure } from "../transient-retry.js";

const CALL_A = "toolu_A";
const CALL_B = "toolu_B";
const CALL_C = "toolu_C";

function toolCall(id: string, name = "bash"): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: { command: "npm run check" } };
}

function assistant(content: unknown[], stopReason = "toolUse"): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		stopReason,
		timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function toolResult(id: string, name = "bash"): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "check passed" }],
		isError: false,
		timestamp: 1,
	};
}

function user(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

/** The control history: a parallel batch, then a later single call. */
function controlHistory(): Record<string, unknown>[] {
	return [
		user("do the work"),
		assistant([toolCall(CALL_A), toolCall(CALL_B)]),
		toolResult(CALL_A),
		toolResult(CALL_B),
		assistant([toolCall(CALL_C, "artifact")]),
		toolResult(CALL_C, "artifact"),
	];
}

test("a well-formed history reports no orphans and is returned unrepaired", () => {
	const history = controlHistory();
	assert.deepEqual(findOrphanedToolResults(history), []);
	const repaired = repairOrphanedToolResults(history);
	assert.deepEqual(repaired.repairs, []);
	assert.deepEqual(repaired.messages, history);
});

test("an unresolved tool call is not an orphan: pi core synthesizes its result", () => {
	// assistant(A,B) with only A answered, then a new assistant. transformMessages
	// inserts a synthetic result for B, so nothing here is missing a parent. This is
	// the mirror case the synthetic-result pass already handles.
	const history = [
		user("do the work"),
		assistant([toolCall(CALL_A), toolCall(CALL_B)]),
		toolResult(CALL_A),
		assistant([toolCall(CALL_C)]),
		toolResult(CALL_C),
	];
	assert.deepEqual(findOrphanedToolResults(history), []);
});

test("an orphan hidden at content.2 of a merged batch is reported at the provider's coordinates", () => {
	// The 2026-08-17 shape: the assistant carrying C is gone, its result survives,
	// and the three results merge into one user message.
	const history = controlHistory().filter((_message, index) => index !== 4);
	const orphans = findOrphanedToolResults(history);
	assert.equal(orphans.length, 1);
	assert.equal(orphans[0]?.payloadIndex, 2, "messages.2");
	assert.equal(orphans[0]?.blockIndex, 2, "content.2 — behind two valid blocks");
	assert.equal(orphans[0]?.messageIndex, 4);
	assert.equal(orphans[0]?.toolCallId, CALL_C);
	assert.equal(orphans[0]?.toolName, "artifact");
	assert.equal(orphans[0]?.parentMessageIndex, null, "the wipe destroyed the parent tool call");
});

test("an orphan at content.0 after a replaced assistant is reported", () => {
	const history = [
		user("run the check"),
		assistant([{ type: "text", text: "[context-aware recovery] discarded" }], "stop"),
		toolResult(CALL_A),
	];
	const orphans = findOrphanedToolResults(history);
	assert.equal(orphans.length, 1);
	assert.equal(orphans[0]?.payloadIndex, 2);
	assert.equal(orphans[0]?.blockIndex, 0);
	assert.equal(orphans[0]?.toolCallId, CALL_A);
});

test("an assistant dropped for stopReason error leaves a reattachable orphan", () => {
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_C)], "error"),
		toolResult(CALL_C),
	];
	const orphans = findOrphanedToolResults(history);
	assert.equal(orphans.length, 1);
	assert.equal(orphans[0]?.payloadIndex, 1, "the dropped assistant is not in the payload");
	assert.equal(orphans[0]?.blockIndex, 0);
	assert.equal(orphans[0]?.parentMessageIndex, 1, "the parent tool call is still in the message list");
});

test("an aborted assistant is dropped by pi core exactly like an errored one", () => {
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_C)], "aborted"),
		toolResult(CALL_C),
	];
	assert.equal(findOrphanedToolResults(history).length, 1);
});

test("repair reattaches a dropped assistant's tool_use and keeps the tool result", () => {
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_C)], "error"),
		toolResult(CALL_C),
	];
	const repaired = repairOrphanedToolResults(history);
	assert.deepEqual(repaired.repairs.map((repair) => repair.kind), ["reattach"]);
	assert.equal(repaired.repairs[0]?.toolCallId, CALL_C);
	assert.equal(repaired.repairs[0]?.toolName, "bash");
	assert.deepEqual(findOrphanedToolResults(repaired.messages), [], "the repaired history is valid");

	const inserted = repaired.messages[2] as { role: string; content: Array<Record<string, unknown>>; stopReason: string };
	assert.equal(inserted.role, "assistant");
	assert.equal(inserted.stopReason, "stop", "a reattached parent must not be dropped again by transformMessages");
	assert.deepEqual(inserted.content, [toolCall(CALL_C)], "the original call, arguments included, is restored");
	assert.equal(
		repaired.messages.filter((message) => (message as { role?: string }).role === "toolResult").length,
		1,
		"reattaching preserves expensive tool output",
	);
});

test("repair keeps the healthy results of a merged batch attached to their own parent", () => {
	// Results A, B and C merge into one message because the errored assistant never
	// reaches the provider. Only C is orphaned, so the missing call joins the
	// assistant that already precedes the batch: splitting the batch instead would
	// leave A and B behind a parent that never issued them.
	const history = [
		user("do the work"),
		assistant([toolCall(CALL_A), toolCall(CALL_B)]),
		toolResult(CALL_A),
		toolResult(CALL_B),
		assistant([toolCall(CALL_C, "artifact")], "error"),
		toolResult(CALL_C, "artifact"),
	];
	const repaired = repairOrphanedToolResults(history);
	assert.deepEqual(repaired.repairs.map((repair) => repair.kind), ["reattach"]);
	assert.equal(repaired.repairs[0]?.blockIndex, 2, "the orphan was the third block of the batch");
	assert.deepEqual(findOrphanedToolResults(repaired.messages), []);
	assert.deepEqual(
		repaired.messages.map((message) => (message as { role: string }).role),
		["user", "assistant", "toolResult", "toolResult", "assistant", "toolResult"],
		"no message is added or removed",
	);
	const parent = repaired.messages[1] as { content: Array<{ id?: string }> };
	assert.deepEqual(parent.content.map((block) => block.id), [CALL_A, CALL_B, CALL_C]);
	assert.deepEqual(history[1], assistant([toolCall(CALL_A), toolCall(CALL_B)]), "the caller's message is not edited");
	assert.equal(
		repaired.messages.filter((message) => (message as { role?: string }).role === "toolResult").length,
		3,
		"every tool result survives",
	);
});

test("repair drops an orphan whose tool_use was destroyed, and nothing else", () => {
	const history = controlHistory().filter((_message, index) => index !== 4);
	const repaired = repairOrphanedToolResults(history);
	assert.deepEqual(repaired.repairs.map((repair) => repair.kind), ["drop"]);
	assert.equal(repaired.repairs[0]?.toolCallId, CALL_C);
	assert.equal(repaired.repairs[0]?.payloadIndex, 2);
	assert.equal(repaired.repairs[0]?.blockIndex, 2);
	assert.deepEqual(findOrphanedToolResults(repaired.messages), []);
	assert.equal(repaired.messages.length, 4, "only the orphaned result is removed");
	assert.deepEqual(
		repaired.messages.map((message) => (message as { toolCallId?: string }).toolCallId ?? null),
		[null, null, CALL_A, CALL_B],
	);
});

test("repair leaves the caller's list untouched", () => {
	const history = controlHistory().filter((_message, index) => index !== 4);
	const snapshot = JSON.stringify(history);
	repairOrphanedToolResults(history);
	assert.equal(JSON.stringify(history), snapshot);
});

test("a user message between a tool call and its result orphans the result, and the repair recovers", () => {
	// pi core inserts a synthetic result when a user message interrupts a tool flow,
	// so the real result that follows has no parent left.
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_A)]),
		user("actually, hold on"),
		toolResult(CALL_A),
	];
	const orphans = findOrphanedToolResults(history);
	assert.equal(orphans.length, 1);
	assert.equal(orphans[0]?.toolCallId, CALL_A);
	const repaired = repairOrphanedToolResults(history);
	assert.deepEqual(findOrphanedToolResults(repaired.messages), []);
});

test("a bash execution kept out of context does not look like an interruption", () => {
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_A)]),
		{ role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 },
		toolResult(CALL_A),
	];
	assert.deepEqual(findOrphanedToolResults(history), [], "a message pi never sends cannot break pairing");
});

test("an empty assistant message is invisible to the provider and does not break pairing", () => {
	// The Anthropic converter skips an assistant message whose blocks all vanish.
	const history = [
		user("run the check"),
		assistant([toolCall(CALL_A)]),
		toolResult(CALL_A),
		assistant([{ type: "text", text: "   " }], "stop"),
		user("carry on"),
	];
	assert.deepEqual(findOrphanedToolResults(history), []);
});

test("odd or missing content never throws", () => {
	assert.deepEqual(findOrphanedToolResults([]), []);
	assert.deepEqual(findOrphanedToolResults([null, undefined, 7, "text"]), []);
	assert.deepEqual(findOrphanedToolResults([{ role: "assistant" }, { role: "toolResult" }]), []);
	assert.deepEqual(repairOrphanedToolResults([null]).repairs, []);
});

test("both provider phrasings of the orphan rejection are recognised", () => {
	const anthropic = "Anthropic: messages.56.content.2: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01ARtfFhF8ckAvY7s5Jb72ps. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.";
	const openai = "No tool call found for function call output with call_id call_pbRh4MYgpjlqsN7H1FV5OzDo.";
	assert.equal(isOrphanedToolResultRejection(anthropic), true);
	assert.equal(isOrphanedToolResultRejection(openai), true);
	assert.deepEqual(orphanedToolCallIdsFromError(anthropic), ["toolu_01ARtfFhF8ckAvY7s5Jb72ps"]);
	assert.deepEqual(orphanedToolCallIdsFromError(openai), ["call_pbRh4MYgpjlqsN7H1FV5OzDo"]);
});

test("unrelated provider failures are not mistaken for an orphan rejection", () => {
	assert.equal(isOrphanedToolResultRejection("invalid_request_error: max_tokens must be positive"), false);
	assert.equal(isOrphanedToolResultRejection("Overloaded"), false);
	assert.equal(isOrphanedToolResultRejection(""), false);
	assert.equal(isOrphanedToolResultRejection(undefined), false);
});

test("an orphan rejection is repairable rather than terminal for extension-owned calls", () => {
	const rejection = new Error("messages.56.content.2: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01ARtfFhF8ckAvY7s5Jb72ps. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.");
	assert.equal(isTransientFailure(rejection), true, "one repaired retry beats a dead session");
	assert.equal(isTransientFailure(new Error("invalid_request_error: max_tokens must be positive")), false);
});

test("#10: a recovery replacement keeps tool calls that may already be executing", () => {
	const message = assistant([{ type: "text", text: "Running the gate." }, toolCall(CALL_A)]);
	const replacement = buildRecoveryReplacement(message, "[context-aware recovery] discarded") as {
		content: Array<Record<string, unknown>>;
		stopReason: string;
		errorMessage: unknown;
		role: string;
		model: string;
	};
	assert.deepEqual(replacement.content, [
		{ type: "text", text: "[context-aware recovery] discarded" },
		toolCall(CALL_A),
	], "the recovery text replaces the prose; the tool calls stay so their results keep a parent");
	assert.equal(replacement.stopReason, "stop");
	assert.equal(replacement.errorMessage, undefined);
	assert.equal(replacement.role, "assistant", "the replacement keeps the original message's identity");
	assert.equal(replacement.model, "claude-opus-5");
});

test("#10: a truncated response keeps stopReason length so pi core fails its tool calls safely", () => {
	const message = assistant([toolCall(CALL_A, "delegate")], "length");
	const replacement = buildRecoveryReplacement(message, "[context-aware recovery] discarded") as {
		content: Array<Record<string, unknown>>;
		stopReason: string;
	};
	assert.equal(replacement.stopReason, "length", "pi core must keep refusing to execute truncated arguments");
	assert.equal(replacement.content.filter((block) => block.type === "toolCall").length, 1);
});

test("#10: a replacement never leaves a stopReason pi core would drop", () => {
	for (const stopReason of ["error", "aborted"]) {
		const message = assistant([toolCall(CALL_A)], stopReason);
		const replacement = buildRecoveryReplacement(message, "discarded") as { stopReason: string };
		assert.equal(replacement.stopReason, "stop", `stopReason ${stopReason} would orphan the preserved tool call`);
	}
});

test("#10: a message with nothing in flight is still fully discarded", () => {
	const message = assistant([{ type: "text", text: "half a thought" }, { type: "thinking", thinking: "…" }], "aborted");
	const replacement = buildRecoveryReplacement(message, "discarded") as { content: unknown[]; stopReason: string };
	assert.deepEqual(replacement.content, [{ type: "text", text: "discarded" }]);
	assert.equal(replacement.stopReason, "stop");
});

test("#10: an unreadable message is replaced rather than trusted", () => {
	const replacement = buildRecoveryReplacement({ role: "assistant" }, "discarded") as unknown as { content: unknown[] };
	assert.deepEqual(replacement.content, [{ type: "text", text: "discarded" }]);
});
