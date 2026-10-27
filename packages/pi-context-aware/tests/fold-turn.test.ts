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
import { assistantToolCall, closingReply, screenshotData, screenshotMarker, screenshotResult, screenshotText } from "./provider-payloads.js";

// pi-context-aware#201: the native engine's per-turn pass in live mode.
const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const SUMMARY = (n: number) => "Summary " + n + ": the archived exchange is settled; keep its numbered decision.";

type Message = Parameters<typeof prepareFoldTurn>[0]["messages"][number];

function turnInput(manager: SessionManager, memory: FoldTurnMemory, options: { hostTokens?: number; contextWindow?: number; compatibility?: boolean; vision?: boolean } = {}): FoldTurnInput {
	return {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: options.contextWindow ?? 200_000, ...(options.vision ? { vision: true } : {}) }, systemPromptTokens: 0,
		...(options.hostTokens !== undefined ? { hostTokens: options.hostTokens } : {}), memory, config: CONFIG,
		...(options.compatibility ? { compatibility: true } : {}),
	};
}

function turn(manager: SessionManager, memory: FoldTurnMemory, options: { hostTokens?: number; contextWindow?: number; compatibility?: boolean; vision?: boolean } = {}): FoldTurnResult {
	const result = prepareFoldTurn(turnInput(manager, memory, options));
	assert.ok(result, "the request lines up with the projection");
	return result;
}

type ContentPart = { readonly type?: unknown; readonly text?: unknown; readonly data?: unknown };

function parts(message: Message): readonly ContentPart[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? content as ContentPart[] : [];
}

function sentImageCount(messages: readonly Message[]): number {
	return messages.reduce((count, message) => count + parts(message).filter((part) => part.type === "image").length, 0);
}

function mediaSession(count: number, paddingChars = 0, userImage = false, firstResultText?: string): { manager: SessionManager; userImageId?: string; resultIds: string[] } {
	const manager = SessionManager.inMemory("/tmp");
	const opening: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
		{ type: "text", text: "p".repeat(paddingChars) || "Inspect the screenshots." },
	];
	if (userImage) opening.push({ type: "image", mimeType: "image/png", data: screenshotData(999, 4_000) });
	const userImageId = manager.appendMessage({ role: "user", content: opening, timestamp: 1 });
	const resultIds: string[] = [];
	for (let index = 1; index <= count; index++) {
		manager.appendMessage(assistantToolCall(index));
		const result = screenshotResult(index, 4_000);
		resultIds.push(manager.appendMessage(index === 1 && firstResultText !== undefined
			? { ...result, content: [{ type: "text", text: firstResultText }, { type: "image", mimeType: "image/png", data: screenshotData(index, 4_000) }] }
			: result));
	}
	manager.appendMessage(closingReply(count));
	manager.appendMessage({ role: "user", content: "Choose the first fix.", timestamp: count * 2 + 3 });
	return { manager, ...(userImage ? { userImageId } : {}), resultIds };
}

function testImage(index: number) {
	return { type: "image" as const, mimeType: "image/png", data: screenshotData(index, 4_000) };
}

function singleUserMultiImageSession(imageCount: number): { manager: SessionManager; entryId: string } {
	const manager = SessionManager.inMemory("/tmp");
	const images = Array.from({ length: imageCount }, (_, index) => testImage(index + 1));
	const entryId = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "before" },
			...images.slice(0, 10),
			{ type: "text", text: "middle" },
			...images.slice(10),
			{ type: "text", text: "after" },
		],
		timestamp: 1,
	});
	return { manager, entryId };
}

function multiImageToolSession(entryCount: number, imagesPerEntry: number): { manager: SessionManager; resultIds: string[] } {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Inspect the screenshot batches.", timestamp: 1 });
	const resultIds: string[] = [];
	for (let entry = 1; entry <= entryCount; entry++) {
		manager.appendMessage(assistantToolCall(entry));
		const firstImage = (entry - 1) * imagesPerEntry + 1;
		resultIds.push(manager.appendMessage({
			...screenshotResult(entry, 4_000),
			content: [
				{ type: "text", text: screenshotText(entry) },
				...Array.from({ length: imagesPerEntry }, (_, offset) => testImage(firstImage + offset)),
			],
		}));
	}
	manager.appendMessage(closingReply(entryCount));
	manager.appendMessage({ role: "user", content: "Choose the first fix.", timestamp: entryCount * 2 + 3 });
	return { manager, resultIds };
}

function imageCountForSource(result: FoldTurnResult, source: string): number {
	return result.messages.reduce((count, message, index) => result.sources[index] === source
		? count + parts(message).filter((part) => part.type === "image").length
		: count, 0);
}

function messageForSource(result: FoldTurnResult, source: string): Message {
	const index = result.sources.indexOf(source);
	assert.notEqual(index, -1, `request must contain source ${source}`);
	return result.messages[index]!;
}

function contentKeyFor(message: Message): string {
	const hash = hashRequestMessages([message]).messages[0];
	assert.ok(hash);
	return `${hash.role}:${hash.hash}`;
}

test("native media elision triggers above 20 image parts, not at 20", () => {
	const atBoundary = mediaSession(20);
	const unchanged = turn(atBoundary.manager, createFoldTurnMemory());
	assert.equal(sentImageCount(unchanged.messages), 20, "exactly 20 images stay in the request");
	assert.doesNotMatch(JSON.stringify(unchanged.messages), /image omitted from context/u);

	const aboveBoundary = mediaSession(21);
	const elided = turn(aboveBoundary.manager, createFoldTurnMemory());
	assert.equal(sentImageCount(elided.messages), 5, "21 images leave only the newest five");
	assert.equal(imageCountForSource(elided, aboveBoundary.resultIds[15]!), 0, "the sixth-newest source is elided");
	for (const id of aboveBoundary.resultIds.slice(-5)) assert.equal(imageCountForSource(elided, id), 1, `newest source ${id} keeps its image`);
});

test("native media elision keeps the newest five parts from one image-heavy user entry", () => {
	const fixture = singleUserMultiImageSession(21);
	const memory = createFoldTurnMemory();
	const result = turn(fixture.manager, memory, { vision: true });
	const content = parts(messageForSource(result, fixture.entryId));
	const placeholder = `[image/png, ~3 KB image omitted from context; the original is in session entry ${fixture.entryId}]`;

	assert.equal(sentImageCount(result.messages), 5, "one entry with 21 images must send only five");
	assert.deepEqual(result.mediaElidedEntryIds, [fixture.entryId], "the partially elided user entry must be reported");
	assert.equal(content.length, 24);
	assert.equal(content[0]?.text, "before");
	assert.deepEqual(content.slice(1, 11).map((part) => part.text), Array(10).fill(placeholder));
	assert.equal(content[11]?.text, "middle");
	assert.deepEqual(content.slice(12, 18).map((part) => part.text), Array(6).fill(placeholder));
	assert.deepEqual(content.slice(18, 23).map((part) => part.data), [17, 18, 19, 20, 21].map((index) => screenshotData(index, 4_000)));
	assert.match(String(content[23]?.text), /^after\n\n<acp tokens="[^"]+"[^>]*>m\d{5}<\/acp>\n$/u);

	const baselineMemory = createFoldTurnMemory();
	turn(singleUserMultiImageSession(0).manager, baselineMemory, { vision: true });
	assert.ok(memory.meter && baselineMemory.meter);
	assert.equal(memory.meter.viewTokens - baselineMemory.meter.viewTokens, 5 * 1_600, "the meter must charge for exactly five sent images");
});

test("native media elision keeps five parts across multi-image entries and partially elides the boundary", () => {
	const fixture = multiImageToolSession(7, 3);
	const memory = createFoldTurnMemory();
	const result = turn(fixture.manager, memory, { vision: true });
	const serialized = JSON.stringify(result.messages);
	const boundaryId = fixture.resultIds[5]!;
	const boundaryMessage = messageForSource(result, boundaryId);
	const boundary = parts(boundaryMessage);

	assert.equal(sentImageCount(result.messages), 5, "seven three-image entries must send only five images");
	for (let index = 1; index <= 21; index++) assert.equal(serialized.includes(screenshotMarker(index)), index >= 17, `image ${index} sent=${index >= 17}`);
	assert.deepEqual(boundary.slice(1).map((part) => part.type), ["text", "image", "image"], "the boundary entry must elide only its oldest image");
	assert.match(String(boundary[1]?.text), new RegExp(`original is in session entry ${boundaryId}`, "u"));
	assert.deepEqual(boundary.slice(2).map((part) => part.data), [screenshotData(17, 4_000), screenshotData(18, 4_000)]);
	assert.equal((serialized.match(/image omitted from context/gu) ?? []).length, 16);
	assert.deepEqual(result.mediaElidedEntryIds, fixture.resultIds.slice(0, 6), "FP-163 must include the partially elided boundary entry");
	const boundaryBefore = result.mediaElisionBefore?.find((entry) => entry.entryId === boundaryId);
	assert.ok(boundaryBefore, "FP-163 must retain the exact pre-elision boundary message");
	assert.equal(parts(boundaryBefore.message).filter((part) => part.type === "image").length, 3);

	const side = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: {} } }));
	const previewed = compareBatchRequestWithMemory({
		sessionId: fixture.manager.getSessionId(), cwd: fixture.manager.getCwd(), header: fixture.manager.getHeader(), branch: fixture.manager.getBranch(), contextWindow: 200_000,
		turn: { hostTokens: 0, systemPromptTokens: 0 }, turnMemory: createFoldTurnMemory(),
	}, [{ toolCallId: "no-op", input: { content: [] }, before: side }], hashRequestMessages([]));
	const media = previewed.comparison.ours.mediaElision;
	assert.ok(media, "FP-163 must emit before/after hashes for partial elision");
	assert.equal(media.originals.length, 6);
	assert.equal(media.replacements.length, 6);
	assert.equal(media.originals[5], contentKeyFor(boundaryBefore.message));
	assert.equal(media.replacements[5], contentKeyFor(boundaryMessage));

	const baselineMemory = createFoldTurnMemory();
	turn(multiImageToolSession(7, 0).manager, baselineMemory, { vision: true });
	assert.ok(memory.meter && baselineMemory.meter);
	assert.equal(memory.meter.viewTokens - baselineMemory.meter.viewTokens, 5 * 1_600, "the meter must charge for the five images spanning the boundary");
});

test("native media elision keeps a kernel-truncated body and ref tag", () => {
	const original = `KERNEL-HEAD\n${"x".repeat(100_000)}\nKERNEL-TAIL`;
	const fixture = mediaSession(21, 0, false, original);
	const result = turn(fixture.manager, createFoldTurnMemory(), { hostTokens: 195_000, contextWindow: 200_000 });
	const message = messageForSource(result, fixture.resultIds[0]!);
	const text = parts(message).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");

	assert.match(text, /\[truncated for context space\]/u, "elision restored the original body over the kernel rewrite");
	assert.match(text, /KERNEL-HEAD/u);
	assert.match(text, /KERNEL-TAIL/u);
	assert.doesNotMatch(text, /x{5000}/u, "the untruncated original body survived");
	assert.match(text, /<acp tokens="[^"]+"[^>]*>m\d{5}<\/acp>/u);
	assert.match(text, new RegExp(`image omitted from context; the original is in session entry ${fixture.resultIds[0]}`, "u"));
});

test("FP-163 parity hashes the rebuilt kernel body before media elision", () => {
	const original = `KERNEL-HEAD\n${"x".repeat(100_000)}\nKERNEL-TAIL`;
	const baseline = mediaSession(20, 0, false, original);
	const baselineTurn = turn(baseline.manager, createFoldTurnMemory(), { hostTokens: 195_000, contextWindow: 200_000 });
	const rebuiltBeforeKey = contentKeyFor(messageForSource(baselineTurn, baseline.resultIds[0]!));

	const elided = mediaSession(21, 0, false, original);
	const projectedEntry = elided.manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === elided.resultIds[0]);
	assert.ok(projectedEntry);
	assert.equal(projectedEntry.messages.length, 1);
	const projectedOriginalKey = contentKeyFor(projectedEntry.messages[0] as Message);
	assert.notEqual(rebuiltBeforeKey, projectedOriginalKey, "fixture must make the kernel rewrite differ from Pi's projection");

	const side = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: {} } }));
	const previewed = compareBatchRequestWithMemory({
		sessionId: elided.manager.getSessionId(), cwd: elided.manager.getCwd(), header: elided.manager.getHeader(), branch: elided.manager.getBranch(), contextWindow: 200_000,
		turn: { hostTokens: 195_000, systemPromptTokens: 0 }, turnMemory: createFoldTurnMemory(),
	}, [{ toolCallId: "no-op", input: { content: [] }, before: side }], hashRequestMessages([]));
	const media = previewed.comparison.ours.mediaElision;
	assert.ok(media, "the parity preview must record media-elision evidence");
	assert.equal(media.originals[0], rebuiltBeforeKey, "the before hash came from Pi's projection instead of the rebuilt request");
});

test("native media elision uses the all-images estimate at the 75% ceiling", () => {
	const below = mediaSession(12, 20_000);
	assert.equal(sentImageCount(turn(below.manager, createFoldTurnMemory(), { contextWindow: 40_000 }).messages), 12, "the request below 30,000 tokens stays unchanged");

	const atCeiling = mediaSession(12, 44_000);
	assert.equal(sentImageCount(turn(atCeiling.manager, createFoldTurnMemory(), { contextWindow: 40_000 }).messages), 5, "the all-images estimate at the ceiling triggers elision");
});

test("the sent-view meter counts only images that remain after native elision", () => {
	const { manager } = mediaSession(21);
	const memory = createFoldTurnMemory();
	turn(manager, memory, { contextWindow: 40_000, vision: true });
	assert.ok(memory.meter, "the native turn records its sent-view meter");
	assert.ok(memory.meter.viewTokens < 15_000, `elided sent view should be below 15,000 tokens, was ${memory.meter.viewTokens}`);
});

test("an old user image is elided like a tool-result image", () => {
	const { manager, userImageId, resultIds } = mediaSession(20, 0, true);
	assert.ok(userImageId);
	const result = turn(manager, createFoldTurnMemory());
	const serialized = JSON.stringify(result.messages);
	assert.equal(sentImageCount(result.messages), 5);
	assert.equal(imageCountForSource(result, userImageId), 0, "the oldest user image is elided");
	assert.match(serialized, new RegExp(`original is in session entry ${userImageId}`));
	for (const id of resultIds.slice(-5)) assert.equal(imageCountForSource(result, id), 1, `newest tool-result source ${id} keeps its image`);
});

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
