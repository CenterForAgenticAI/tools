import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

import { entryToCoreMessages, foldStateFromBranch, planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { coveredEntryIds } from "../src/folds/fold-entries.js";
import type { Config } from "../src/folds/kernel/index.js";

// pi-context-aware#186: billion-context-pi 0.1.83 prepares the turn (processTurn) before it plans
// a fold, so the protected recent tail is computed over its projection, after prune and after
// hideConsumedCompressCalls. pi-context-aware#184: a range that starts inside an active fold is
// refused, because prune has removed the folded messages.

const SUMMARY = "The archived exchange is settled: keep the numbered decisions and continue with the later review.";
const FOLD_OPENING = { firstUserMessage: "fold", firstUserMessageMaxTokens: 8_000 } as const;
const big = (label: string) => label + " " + "Archived synthetic discussion that is long enough to fold. ".repeat(40);

function config(preserveRecentMessages: number, preserveRecentTokens = 0): Partial<Config> {
	return { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages, preserveRecentTokens };
}

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: 1 });
}
function assistant(manager: SessionManager, content: Parameters<typeof fauxAssistantMessage>[0]): string {
	return manager.appendMessage(fauxAssistantMessage(content, { stopReason: Array.isArray(content) && content.some((part) => part.type === "toolCall") ? "toolUse" : "stop" }));
}
function result(manager: SessionManager, toolCallId: string, text: string, toolName = "archive_probe"): string {
	return manager.appendMessage({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1 });
}

/** Four long archive entries the tests fold from. */
function archive(manager: SessionManager): string[] {
	return [user(manager, big("Q1")), assistant(manager, big("A1")), user(manager, big("Q2")), assistant(manager, big("A2"))];
}

/** The model-visible ref of an entry, as the engine numbers it for this branch. */
function refOf(manager: SessionManager, entryId: string, last = false): string {
	const state = foldStateFromBranch(manager.getBranch(), manager.buildContextEntries());
	const ids = state.messages.filter((message) => message.id === entryId || message.id.startsWith(entryId + "#")).map((message) => message.id);
	const ref = state.kernel.messageRefs.byRaw[last ? ids[ids.length - 1]! : ids[0]!];
	assert.ok(ref, "entry " + entryId + " has a ref");
	return ref;
}

function plan(manager: SessionManager, start: string, end: string, settings: Partial<Config>) {
	return planFold({ branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), startRef: refOf(manager, start), endRef: refOf(manager, end, true),
		summary: SUMMARY, modelContextLimit: 200_000, config: settings, folds: FOLD_OPENING });
}

function covered(outcome: ReturnType<typeof planFold>): string[] {
	assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
	return outcome.ok ? outcome.records.flatMap(coveredEntryIds) : [];
}

function entryOf(manager: SessionManager, id: string): SessionEntry {
	const entry = manager.getBranch().find((candidate) => candidate.id === id);
	assert.ok(entry);
	return entry;
}

test("projection: a single-call assistant entry is one core message keyed by the bare entry id, with its thinking tokens", () => {
	const manager = SessionManager.inMemory("/tmp");
	const id = assistant(manager, [fauxThinking("t".repeat(400)), fauxText("Checking item one."), fauxToolCall("archive_probe", { item: 1 }, { id: "call-1" })]);
	assert.deepEqual(entryToCoreMessages(entryOf(manager, id)), [
		{ id, role: "assistant", contentType: "tool-call", toolName: "archive_probe", toolCallId: "call-1", text: "Checking item one.\n{\"item\":1}", thinkingTokens: 100 },
	]);
});

test("projection: an assistant entry with no text and no call is dropped; thinking alone does not keep it", () => {
	const manager = SessionManager.inMemory("/tmp");
	const empty = assistant(manager, []);
	const thinkingOnly = assistant(manager, [fauxThinking("only private reasoning")]);
	assert.deepEqual(entryToCoreMessages(entryOf(manager, empty)), []);
	assert.deepEqual(entryToCoreMessages(entryOf(manager, thinkingOnly)), []);
});

test("projection: a multi-call entry keeps one message per call, thinking on the first only", () => {
	const manager = SessionManager.inMemory("/tmp");
	const id = assistant(manager, [fauxThinking("t".repeat(40)), fauxText("Two probes."), fauxToolCall("archive_probe", { item: 1 }, { id: "a" }), fauxToolCall("archive_probe", { item: 2 }, { id: "b" })]);
	assert.deepEqual(entryToCoreMessages(entryOf(manager, id)), [
		{ id: id + "#a", role: "assistant", contentType: "tool-call", toolName: "archive_probe", toolCallId: "a", text: "{\"item\":1}", thinkingTokens: 10 },
		{ id: id + "#b", role: "assistant", contentType: "tool-call", toolName: "archive_probe", toolCallId: "b", text: "{\"item\":2}" },
	]);
});

test("projection: a text-only assistant entry carries its thinking tokens", () => {
	const manager = SessionManager.inMemory("/tmp");
	const id = assistant(manager, [fauxThinking("t".repeat(80)), fauxText("Answer.")]);
	assert.deepEqual(entryToCoreMessages(entryOf(manager, id)), [{ id, role: "assistant", contentType: "text", text: "Answer.", thinkingTokens: 20 }]);
});

test("projection (s12): a protected boundary between an entry's text and its call no longer refuses the fold", () => {
	const manager = SessionManager.inMemory("/tmp");
	const [, a1] = archive(manager);
	assistant(manager, [fauxText("Probe three."), fauxToolCall("archive_probe", { item: 3 }, { id: "c3" })]);
	const r3 = result(manager, "c3", "Result three.");
	assistant(manager, [fauxText("Probe four."), fauxToolCall("archive_probe", { item: 4 }, { id: "c4" })]);
	const r4 = result(manager, "c4", "Result four.");
	user(manager, "Fold the archive now.");
	// billion-context-pi protects the last three messages: probe four, its result and the prompt.
	const folded = covered(plan(manager, a1!, r4, config(3)));
	const branch = manager.getBranch().map((entry) => entry.id);
	assert.deepEqual(folded, branch.slice(branch.indexOf(a1!), branch.indexOf(r3) + 1));
});

test("projection: thinking tokens count toward the protected recent tokens", () => {
	const manager = SessionManager.inMemory("/tmp");
	const [, a1] = archive(manager);
	const q3 = user(manager, "Question three.");
	const a3 = assistant(manager, [fauxThinking("t".repeat(4_000)), fauxText("Answer three.")]);
	const q4 = user(manager, "Question four.");
	const a4 = assistant(manager, [fauxThinking("t".repeat(4_000)), fauxText("Answer four.")]);
	// 1,000 thinking tokens per answer: the 1,500-token window stops at answer three.
	const folded = covered(plan(manager, a1!, a4, config(1, 1_500)));
	assert.ok(folded.includes(q3), "question three is outside the protected tokens");
	for (const id of [a3, q4, a4]) assert.ok(!folded.includes(id), id + " is protected");
});

function prunedTail(inFlightTool: string, withEarlierFold: boolean) {
	const manager = SessionManager.inMemory("/tmp");
	const [q1, a1, q2, a2] = archive(manager);
	if (withEarlierFold) {
		const earlier = plan(manager, q1!, a1!, config(0));
		assert.equal(earlier.ok, true);
		if (earlier.ok) applyFoldDrafts(manager, earlier.drafts);
	}
	const t1 = assistant(manager, "Tail one.");
	const t2 = assistant(manager, "Tail two.");
	const t3 = user(manager, "Tail three.");
	const call = inFlightTool === "compress"
		? fauxToolCall("compress", { content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }] }, { id: "in-flight" })
		: fauxToolCall(inFlightTool, { code: "return 1" }, { id: "in-flight" });
	assistant(manager, [call]);
	return { manager, q2: q2!, a2: a2!, t1, t2, t3 };
}

test("prune: with an earlier fold, an in-flight tool call without a result leaves the protected tail", () => {
	const { manager, q2, t1, t2, t3 } = prunedTail("fabric_exec", true);
	// billion-context-pi strips the unanswered call, so the last three messages are tail one to three.
	const folded = covered(plan(manager, q2, t3, config(3)));
	for (const id of [t1, t2, t3]) assert.ok(!folded.includes(id), id + " is protected");
});

test("prune: without an earlier fold, the in-flight call keeps its slot in the protected tail", () => {
	const { manager, q2, t1, t2, t3 } = prunedTail("fabric_exec", false);
	const folded = covered(plan(manager, q2, t3, config(3)));
	assert.ok(folded.includes(t1), "tail one folds: the in-flight call holds a protected slot");
	for (const id of [t2, t3]) assert.ok(!folded.includes(id), id + " is protected");
});

test("prune: an in-flight compress call is never stripped", () => {
	const { manager, q2, t1, t2, t3 } = prunedTail("compress", true);
	const folded = covered(plan(manager, q2, t3, config(3)));
	assert.ok(folded.includes(t1), "tail one folds: the compress call holds a protected slot");
	for (const id of [t2, t3]) assert.ok(!folded.includes(id), id + " is protected");
});

test("compaction: an in-flight compress call counts as its 200-character stub, not its full summary", () => {
	const manager = SessionManager.inMemory("/tmp");
	const [, a1] = archive(manager);
	const tail = [1, 2, 3, 4, 5].map((i) => assistant(manager, "Tail " + i + " " + "x".repeat(1_000)));
	const prompt = user(manager, "Fold the archive.");
	assistant(manager, [fauxToolCall("compress", { content: [{ startId: "m00002", endId: "m00009", summary: "Long summary. ".repeat(600) }] }, { id: "compress-now" })]);
	// Stubbed, the call is about 70 tokens and each tail entry about 252, so 1,000 protected tokens
	// reach back to tail two. Counted in full (2,100 tokens) the call alone fills the window.
	const folded = covered(plan(manager, a1!, tail[4]!, config(2, 1_000)));
	assert.deepEqual(folded.filter((id) => tail.includes(id)), [tail[0]]);
	assert.ok(!folded.includes(prompt));
});

test("withdrawal: a multi-call entry split by the protected boundary is withdrawn with its results, not refused", () => {
	const manager = SessionManager.inMemory("/tmp");
	const [, a1, , a2] = archive(manager);
	const burst = assistant(manager, [fauxToolCall("archive_probe", { item: 1 }, { id: "p1" }), fauxToolCall("archive_probe", { item: 2 }, { id: "p2" })]);
	const r1 = result(manager, "p1", "First probe result.");
	const r2 = result(manager, "p2", "Second probe result.");
	const prompt = user(manager, "Fold the archive.");
	// The last two messages (second result, prompt) are protected; the engine withdraws the second pair.
	const outcome = plan(manager, a1!, r2, config(2));
	const folded = covered(outcome);
	assert.equal(folded.at(-1), a2, "the fold ends before the split entry");
	for (const id of [burst, r1, r2, prompt]) assert.ok(!folded.includes(id), id + " stays visible");
});

function foldedArchive() {
	const manager = SessionManager.inMemory("/tmp");
	const [q1, a1, q2, a2] = archive(manager);
	const q3 = user(manager, big("Q3"));
	const a3 = assistant(manager, big("A3"));
	user(manager, "Fold more of the archive.");
	const first = plan(manager, a1!, q2!, config(1));
	assert.equal(first.ok, true);
	if (first.ok) applyFoldDrafts(manager, first.drafts);
	return { manager, q1: q1!, a1: a1!, q2: q2!, a2: a2!, q3, a3 };
}

test("overlap (pi-context-aware#184): a range that starts inside an active fold is refused as already folded", () => {
	const { manager, q2, a3 } = foldedArchive();
	const outcome = plan(manager, q2, a3, config(1));
	assert.equal(outcome.ok, false, "the range starts inside b1");
	if (!outcome.ok) assert.match(outcome.errors.join("\n"), /already compressed|not found in visible context|already covered by active block/u);
});

test("overlap (pi-context-aware#184): a range that ends inside an active fold is refused as already folded", () => {
	const manager = SessionManager.inMemory("/tmp");
	const [q1, a1, q2, a2] = archive(manager);
	user(manager, "Fold more of the archive.");
	const first = plan(manager, q2!, a2!, config(1));
	assert.equal(first.ok, true);
	if (first.ok) applyFoldDrafts(manager, first.drafts);
	const outcome = plan(manager, q1!, q2!, config(1));
	assert.equal(outcome.ok, false, "the range ends inside b1");
	if (!outcome.ok) assert.match(outcome.errors.join("\n"), /already compressed|not found in visible context|already covered by active block/u);
	assert.ok(a1);
});

test("overlap: a range that starts at the fold's block id absorbs the fold", () => {
	const { manager, a3 } = foldedArchive();
	const outcome = planFold({ branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), startRef: "b1", endRef: refOf(manager, a3, true),
		summary: SUMMARY, modelContextLimit: 200_000, config: config(1), folds: FOLD_OPENING });
	assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.errors.join("\n"));
	if (outcome.ok) assert.deepEqual(outcome.records.flatMap((record) => record.directBlockIds), ["b1"]);
});
