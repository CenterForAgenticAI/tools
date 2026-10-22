import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { stampRequestId } from "../src/folds/fold-entries.js";
import * as foldTurnModule from "../src/folds/fold-turn.js";
import { createFoldTurnMemory, prepareFoldTurn, type FoldTurnInput, type FoldTurnMemory, type FoldTurnResult } from "../src/folds/fold-turn.js";
import type { Config } from "../src/folds/kernel/index.js";
import { compareBatchRequestWithMemory, hashRequestMessages } from "../src/parity/compare.js";
import { PARITY_RECORD_VERSION, type CompressRecord, type NextRequestRecord, type RequestHashes } from "../src/parity/records.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";
import { PARITY_REGISTER } from "../src/parity/register.js";
import { parityEvidenceFault } from "../src/parity/evidence.js";

// pi-context-aware#201: the native engine's per-turn pass in live mode.
const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const SUMMARY = (n: number) => "Summary " + n + ": the archived exchange is settled; keep its numbered decision.";

type Message = Parameters<typeof prepareFoldTurn>[0]["messages"][number];

function turnInput(manager: SessionManager, memory: FoldTurnMemory, options: { hostTokens?: number; contextWindow?: number; compatibility?: boolean } = {}): FoldTurnInput {
	return {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: options.contextWindow ?? 200_000 }, systemPromptTokens: 0,
		...(options.hostTokens !== undefined ? { hostTokens: options.hostTokens } : {}), memory, config: CONFIG,
		...(options.compatibility ? { compatibility: true } : {}),
	};
}

function turn(manager: SessionManager, memory: FoldTurnMemory, options: { hostTokens?: number; contextWindow?: number; compatibility?: boolean } = {}): FoldTurnResult {
	const result = prepareFoldTurn(turnInput(manager, memory, options));
	assert.ok(result, "the request lines up with the projection");
	return result;
}

/** Fold refs startRef..endRef as the production tool would for call callId, item 0. */
function fold(manager: SessionManager, startRef: string, endRef: string, summary: string, callId: string): void {
	const plan = planFold({ branch: manager.getBranch(), startRef, endRef, summary, modelContextLimit: 200_000, config: CONFIG });
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, stampRequestId(plan.drafts, callId + "#0"));
}

function foldCall(manager: SessionManager, callId: string, startId: string, endId: string, summary: string): void {
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("context_fold", { content: [{ startId, endId, summary }] }, { id: callId }), { stopReason: "toolUse" }));
	manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "context_fold", content: [{ type: "text", text: "folded" }], isError: false, timestamp: 1 });
}

const textOf = (message: Message): string => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && part.text ? [part.text] : [])).join("|") : "";
};
const callIds = (messages: readonly Message[]) => messages.flatMap((message) => message.role === "assistant" ? (message.content as { type: string; id?: string }[]).filter((part) => part.type === "toolCall").map((part) => part.id) : []);
const resultIds = (messages: readonly Message[]) => messages.flatMap((message) => message.role === "toolResult" ? [(message as { toolCallId: string }).toolCallId] : []);

test("#201 criterion 1: user, custom and tool-result messages carry billion-context-pi's ref tag; assistant text does not", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "First question.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }, { id: "read-1" }), { stopReason: "toolUse" }));
	manager.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "File body." }], isError: false, timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Answer."));
	manager.appendCustomMessageEntry("note", "A custom note.", true);
	const sent = turn(manager, createFoldTurnMemory()).messages;
	// bcp 0.1.83 puts the tag after a blank line at the end of the last text block; the ref
	// counts every projected message, and the token count is that of the message's own text.
	assert.deepEqual(sent.map(textOf), [
		"First question.\n\n<acp tokens=\"4\" type=\"text\">m00001</acp>\n",
		"",
		"File body.\n\n<acp tokens=\"3\" type=\"read\">m00003</acp>\n",
		"Answer.",
		"A custom note.\n\n<acp tokens=\"4\" type=\"text\">m00005</acp>\n",
	]);
});

function absorbedSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive question " + i + ".", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Archive answer " + i + "."));
	}
	foldCall(manager, "call-1", "m00003", "m00004", SUMMARY(1));
	fold(manager, "m00003", "m00004", SUMMARY(1), "call-1");
	foldCall(manager, "call-2", "m00005", "m00006", SUMMARY(2));
	fold(manager, "m00005", "m00006", SUMMARY(2), "call-2");
	foldCall(manager, "call-3", "b1", "b2", SUMMARY(3));
	fold(manager, "b1", "b2", SUMMARY(3), "call-3");
	for (let i = 1; i <= 3; i++) manager.appendMessage({ role: "user", content: "Recent question " + i + ".", timestamp: 1 });
	return manager;
}

test("#201 criterion 2: fold calls absorbed into a higher-tier fold, and their results, are not sent", () => {
	const manager = absorbedSession();
	const before = manager.buildSessionContext().messages;
	assert.deepEqual(callIds(before), ["call-1", "call-2", "call-3"], "Pi's own request still holds every call");
	const sent = turn(manager, createFoldTurnMemory()).messages;
	assert.deepEqual(callIds(sent), ["call-3"], "only the call whose fold is active stays");
	assert.deepEqual(resultIds(sent), ["call-3"]);
	assert.ok(sent.some((message) => textOf(message).includes(SUMMARY(3))), "the tier-2 summary is sent");
	assert.ok(!sent.some((message) => textOf(message).includes(SUMMARY(1))), "the absorbed summary is not");
});

/** A session over the nudge threshold: four large archived exchanges and a short recent tail. */
function nudgeSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}
const isNudge = (message: Message | undefined) => message?.role === "user" && textOf(message).startsWith("This is an efficiency nudge");

test("#201 criterion 3: the nudge is appended once per turn with billion-context-pi's text", () => {
	const manager = nudgeSession();
	const memory = createFoldTurnMemory();
	const first = turn(manager, memory, { contextWindow: 120_000 });
	const nudge = first.messages.at(-1);
	assert.ok(isNudge(nudge), textOf(nudge!).slice(0, 120));
	assert.equal(first.nudge, textOf(nudge!));
	assert.match(first.nudge!, /\nCompressible ranges \(1, oldest first\):\n {2}m00001\u2013m00007 {2}7 msgs {2}/u);
	assert.ok(!first.nudge!.includes("Compressed blocks:"), "no blocks yet, so no block line");
	assert.ok(first.messages.slice(0, -1).every((message) => !isNudge(message)), "the nudge comes last");
	// The same turn (no new user message) gets it once.
	const again = turn(manager, memory, { contextWindow: 120_000 });
	assert.equal(again.nudge, undefined);
	assert.ok(!again.messages.some(isNudge));
});

test("#201 criterion 3: with active folds the nudge ends with billion-context-pi's block line", () => {
	const manager = nudgeSession();
	fold(manager, "m00002", "m00003", SUMMARY(1), "call-1");
	// Over 75% of the window: the over-limit nudge.
	const sent = turn(manager, createFoldTurnMemory(), { hostTokens: 100_000, contextWindow: 120_000 });
	assert.match(sent.nudge ?? "", /\n\nCompressed blocks: 1 active \(T1:1\) \u2014 18 summary, \d+\.\dK original compressed\. Blocks: b1\.$/u);
});

/** Ten tier-1 folds over small exchanges: summaries far below the kernel's 75K mass threshold. */
function tenFolds(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
	for (let i = 1; i <= 10; i++) {
		manager.appendMessage({ role: "user", content: "Question " + i + ".", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Answer " + i + "."));
	}
	for (let i = 1; i <= 3; i++) manager.appendMessage({ role: "user", content: "Recent " + i + ".", timestamp: 1 });
	for (let i = 1; i <= 10; i++) fold(manager, "m" + String(i * 2).padStart(5, "0"), "m" + String(i * 2 + 1).padStart(5, "0"), SUMMARY(i), "call-" + i);
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}

test("FP-201 (ranxianglei/billion-context-pi#628): ten tier-1 folds fire the tier-2 nudge; billion-context-pi's triggers would not", () => {
	const manager = tenFolds();
	const memory = createFoldTurnMemory();
	assert.equal(turn(manager, memory, { hostTokens: 60_000, compatibility: true }).nudge, undefined, "the first turn sets the growth baseline");
	// 30K tokens of growth since the baseline, below every pressure band.
	const grown = turn(manager, memory, { hostTokens: 90_000, compatibility: true });
	assert.match(grown.nudge ?? "", /\[TIER 2 DISTILLATION TRIGGER\]/u);
	assert.match(grown.nudge ?? "", /Target tier-1 blocks to distill \(10\):/u);
	assert.deepEqual(grown.nudgeFix, { cause: "tier-trigger", sent: grown.nudge });
});

test("parity preview after a live FP-201 baseline emits the same next-turn tier-2 nudge", () => {
	const previewFoldTurnState = (foldTurnModule as typeof foldTurnModule & { previewFoldTurnState?: (input: FoldTurnInput) => { result?: FoldTurnResult } }).previewFoldTurnState;
	assert.equal(typeof previewFoldTurnState, "function", "the parity preview must snapshot retained turn memory");
	const manager = tenFolds();
	const memory = createFoldTurnMemory();
	assert.equal(turn(manager, memory, { hostTokens: 60_000, compatibility: true }).nudge, undefined);
	const preview = previewFoldTurnState!(turnInput(manager, memory, { hostTokens: 90_000, compatibility: true })).result;
	assert.ok(preview);
	const live = turn(manager, memory, { hostTokens: 90_000, compatibility: true });
	assert.match(preview.nudge ?? "", /\[TIER 2 DISTILLATION TRIGGER\]/u);
	assert.equal(preview.nudge, live.nudge);
});

test("the next-request parity comparator consumes retained FP-201 memory without mutating it", () => {
	const manager = tenFolds();
	const memory = createFoldTurnMemory();
	assert.equal(turn(manager, memory, { hostTokens: 60_000, compatibility: true }).nudge, undefined);
	const before = structuredClone(memory);
	const side = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: {} } }));
	const previewed = compareBatchRequestWithMemory({
		sessionId: manager.getSessionId(), cwd: manager.getCwd(), header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 200_000,
		turn: { hostTokens: 90_000, systemPromptTokens: 0 }, turnMemory: memory,
	}, [{ toolCallId: "no-op", input: { content: [] }, before: side }], hashRequestMessages([]));
	assert.equal(previewed.comparison.ours.nudgeFix?.cause, "tier-trigger");
	assert.ok(previewed.comparison.ours.nudgeFix?.sent);
	assert.deepEqual(memory, before);
	assert.notDeepEqual(previewed.turnMemory, before, "the detached replay state advances for the following preview");
});

test("one or more parity previews cannot shift the live FP-201 baseline or nudge gate", () => {
	const previewFoldTurnState = (foldTurnModule as typeof foldTurnModule & { previewFoldTurnState?: (input: FoldTurnInput) => { result?: FoldTurnResult } }).previewFoldTurnState;
	assert.equal(typeof previewFoldTurnState, "function", "the parity preview must isolate retained turn memory");
	const manager = tenFolds();
	const memory = createFoldTurnMemory();
	assert.equal(turn(manager, memory, { hostTokens: 60_000, compatibility: true }).nudge, undefined);
	const before = structuredClone(memory);
	for (let i = 0; i < 2; i++) {
		const preview = previewFoldTurnState!(turnInput(manager, memory, { hostTokens: 90_000, compatibility: true })).result;
		assert.match(preview?.nudge ?? "", /\[TIER 2 DISTILLATION TRIGGER\]/u);
	}
	assert.deepEqual(memory, before, "preview mutated memory read by the live pass");
	const expected = turn(manager, structuredClone(before), { hostTokens: 90_000, compatibility: true });
	const live = turn(manager, memory, { hostTokens: 90_000, compatibility: true });
	assert.equal(live.nudge, expected.nudge);
	assert.deepEqual(live.nudgeFix, expected.nudgeFix);
});

/** A session in the emergency band whose latest model turn failed. */
function failedTurn(): SessionManager {
	const manager = nudgeSession();
	manager.appendMessage(fauxAssistantMessage("", { stopReason: "error" }));
	return manager;
}

test("FP-202 (ranxianglei/billion-context-pi#666): the emergency nudge waits for a completed turn", () => {
	const manager = failedTurn();
	const memory = createFoldTurnMemory();
	const deferred = turn(manager, memory, { hostTokens: 116_000, contextWindow: 120_000, compatibility: true });
	assert.equal(deferred.nudge, undefined, "no nudge while the latest turn failed");
	assert.equal(deferred.nudgeFix?.cause, "emergency-defer");
	assert.match(deferred.nudgeFix?.compatible ?? "", /^\u26A0\uFE0F Context limit reached/u, "billion-context-pi would send the emergency nudge");
	// The next turn completes: the emergency nudge is sent at once.
	manager.appendMessage(fauxAssistantMessage("Recovered."));
	const sent = turn(manager, memory, { hostTokens: 116_000, contextWindow: 120_000, compatibility: true });
	assert.match(sent.nudge ?? "", /^\u26A0\uFE0F Context limit reached/u);
	assert.equal(sent.nudgeFix, undefined);
});

// ---- Register entries FP-201 and FP-202 ----

const call: CompressRecord = { v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "current", sessionId: "s", toolCallId: "call", nested: false, at: new Date(1).toISOString(), verdict: "match", diffs: [] };
const hashes = (messages: { role: string; hash: string; summary?: boolean }[], extra: Partial<RequestHashes> = {}): RequestHashes => ({
	messages: messages.map((message) => ({ summary: false, ...message })), tagsSeen: true, total: messages.length, ...extra,
});
const request = (ours: RequestHashes, bcp: RequestHashes): NextRequestRecord => ({
	v: PARITY_RECORD_VERSION, kind: "next-request", fingerprint: "current", sessionId: "s", toolCallIds: ["call"], at: new Date(2).toISOString(), verdict: "diff", diffs: [{ kind: "content" }], ours, bcp,
});
const entry = (id: string) => { const found = PARITY_REGISTER.find((item) => item.id === id); assert.ok(found, id); return found; };
const BASE = [{ role: "user", hash: "q" }, { role: "assistant", hash: "a" }];

test("FP-201 explains a content difference only when swapping the two nudges makes the requests equal", () => {
	const fp201 = entry("FP-201");
	const fix = { cause: "tier-trigger" as const, sent: "native", compatible: "bcp" };
	const ours = hashes([...BASE, { role: "user", hash: "native" }], { nudgeFix: fix });
	assert.equal(fp201.matches({ kind: "content" }, call, request(ours, hashes([...BASE, { role: "user", hash: "bcp" }]))), true);
	// Only native sends a nudge; billion-context-pi sends none.
	const onlyOurs = hashes([...BASE, { role: "user", hash: "native" }], { nudgeFix: { cause: "tier-trigger", sent: "native" } });
	assert.equal(fp201.matches({ kind: "content" }, call, request(onlyOurs, hashes(BASE))), true);
	// Anything broader stays unexplained.
	assert.equal(fp201.matches({ kind: "content" }, call, request(ours, hashes([...BASE, { role: "user", hash: "bcp" }, { role: "user", hash: "other" }]))), false, "another content difference");
	assert.equal(fp201.matches({ kind: "content" }, call, request(hashes([...BASE, { role: "user", hash: "other" }], { nudgeFix: fix }), hashes([...BASE, { role: "user", hash: "bcp" }]))), false, "the sent nudge is not in the request");
	assert.equal(fp201.matches({ kind: "content" }, call, request(hashes([...BASE, { role: "user", hash: "native" }]), hashes([...BASE, { role: "user", hash: "bcp" }]))), false, "no fix recorded");
	assert.equal(fp201.matches({ kind: "content" }, call, request(hashes([...BASE, { role: "user", hash: "native" }], { nudgeFix: { ...fix, cause: "emergency-defer" } }), hashes([...BASE, { role: "user", hash: "bcp" }]))), false, "the other fix");
	for (const kind of ["summaries", "tool-calls", "tool-results", "tool-pairing"] as const) assert.equal(fp201.matches({ kind }, call, request(ours, hashes([...BASE, { role: "user", hash: "bcp" }]))), false, kind);
	assert.equal(fp201.matches({ kind: "content" }, call, undefined), false);
});

test("FP-202 explains only billion-context-pi's emergency nudge that the native engine deferred", () => {
	const fp202 = entry("FP-202");
	const deferred = hashes(BASE, { nudgeFix: { cause: "emergency-defer", compatible: "emergency" } });
	assert.equal(fp202.matches({ kind: "content" }, call, request(deferred, hashes([...BASE, { role: "user", hash: "emergency" }]))), true);
	assert.equal(fp202.matches({ kind: "content" }, call, request(deferred, hashes([...BASE, { role: "user", hash: "emergency" }, { role: "assistant", hash: "x" }]))), false, "another content difference");
	assert.equal(fp202.matches({ kind: "content" }, call, request(deferred, hashes([...BASE, { role: "user", hash: "gentle" }]))), false, "a different nudge text");
	assert.equal(fp202.matches({ kind: "content" }, call, request(hashes(BASE, { nudgeFix: { cause: "tier-trigger", compatible: "emergency" } }), hashes([...BASE, { role: "user", hash: "emergency" }]))), false, "the other fix");
	assert.equal(fp202.matches({ kind: "summaries" }, call, request(deferred, hashes([...BASE, { role: "user", hash: "emergency" }]))), false);
});

test("a nudge-fix note that contradicts itself is a recorder fault", () => {
	const evidence = { activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] };
	const record = (nudgeFix: unknown) => ({ ...request(hashes(BASE, { ...evidence, nudgeFix } as Partial<RequestHashes>), hashes(BASE)), diffs: [{ kind: "content" }] });
	assert.equal(parityEvidenceFault(record({ cause: "tier-trigger", sent: "a", compatible: "b" })), undefined);
	for (const bad of [{ cause: "other", sent: "a" }, { cause: "tier-trigger" }, { cause: "tier-trigger", sent: "a", compatible: "a" }, { cause: "emergency-defer", sent: "a", compatible: "b" }, { cause: "emergency-defer" }]) {
		assert.match(parityEvidenceFault(record(bad)) ?? "", /nudgeFix/u, JSON.stringify(bad));
	}
});
