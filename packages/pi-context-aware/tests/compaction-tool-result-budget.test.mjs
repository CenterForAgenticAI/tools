/**
 * Regression for #17: Pi's token-targeted tail can still exceed the target when
 * the last turn ends with a large tool result. The tool call and result remain
 * adjacent; the measurement must not "fix" the shortfall by splitting the pair.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const piCompaction = await import(pathToFileURL(path.join(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js",
)).href);
const piSession = await import(pathToFileURL(path.join(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
)).href);

const { estimateTokens, prepareCompaction } = piCompaction;
const { sessionEntryToContextMessages } = piSession;

const COMPACTION_TARGET_TOKENS = 20_000;
const TOOL_RESULT_CHARS = 72_000;
const TIMESTAMP = new Date(0).toISOString();

function messageEntry(id, parentId, message) {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message };
}

function toolCallEntry(id, parentId) {
	return messageEntry(id, parentId, {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-trailing", name: "bash", arguments: { command: "x" } }],
		timestamp: 0,
	});
}

function toolResultEntry(id, parentId) {
	return messageEntry(id, parentId, {
		role: "toolResult",
		toolCallId: "call-trailing",
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(TOOL_RESULT_CHARS) }],
		isError: false,
		timestamp: 0,
	});
}

function retainedTailTokens(entries, firstKeptEntryId) {
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	assert.notEqual(firstKeptIndex, -1, "Pi's boundary must identify an entry in the branch");
	return entries
		.slice(firstKeptIndex)
		.flatMap(sessionEntryToContextMessages)
		.reduce((total, message) => total + estimateTokens(message), 0);
}

test("#17: trailing oversized tool-result turn exceeds Pi's retained-tail target", () => {
	const entries = [
		messageEntry("user-before", null, { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 0 }),
		{
			type: "compaction",
			id: "compaction-before",
			parentId: "user-before",
			timestamp: TIMESTAMP,
			summary: "Previous summary",
			firstKeptEntryId: "assistant-before",
			tokensBefore: 50_000,
		},
		messageEntry("assistant-before", "compaction-before", {
			role: "assistant",
			content: [{ type: "text", text: "older retained context".repeat(200) }],
			timestamp: 0,
		}),
		messageEntry("user-latest", "assistant-before", {
			role: "user",
			content: [{ type: "text", text: "r".repeat(12_000) }],
			timestamp: 0,
		}),
		toolCallEntry("assistant-call", "user-latest"),
		toolResultEntry("tool-result-trailing", "assistant-call"),
	];
	const settings = {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: COMPACTION_TARGET_TOKENS,
	};

	const preparation = prepareCompaction(entries, settings);
	assert.ok(preparation, "the reproducible history must reach Pi's compaction preparation hook");
	assert.equal(preparation.firstKeptEntryId, "user-latest");
	assert.equal(preparation.messagesToSummarize.length, 1);
	assert.equal(preparation.turnPrefixMessages.length, 0);

	const retainedTail = entries.slice(entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId));
	const retainedMessages = retainedTail.flatMap(sessionEntryToContextMessages);
	const retainedTokens = retainedTailTokens(entries, preparation.firstKeptEntryId);
	const shortfall = retainedTokens - settings.keepRecentTokens;

	assert.deepEqual(retainedMessages.map((message) => message.role), ["user", "assistant", "toolResult"]);
	assert.equal(retainedMessages[1].content[0].type, "toolCall");
	assert.equal(retainedMessages[2].toolCallId, retainedMessages[1].content[0].id);
	assert.equal(retainedTokens, 21_005, "the measured retained tail is explicit and deterministic");
	assert.equal(shortfall, 1_005, "the retained tail is 1,005 tokens above Pi's 20,000-token target");
	assert.ok(shortfall > 0, `retained tail ${retainedTokens} must exceed target ${settings.keepRecentTokens}`);
});
