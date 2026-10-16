import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, buildSessionProjection, estimateTokens } from "@earendil-works/pi-coding-agent";
import { describeFoldedMedia, planMediaElision } from "../src/media/media-fold.js";
import {
	CLOSING_REPLY,
	FOLLOW_UP_REQUEST,
	OPENING_REQUEST,
	assistantToolCall,
	closingReply,
	screenshotMarker,
	screenshotResult,
	screenshotText,
} from "./provider-payloads.js";

// issue #163, defect 1: billion-context-pi never folds a
// message that carries media, so an image-heavy tail only grows. The native
// fold path elides old media into text placeholders instead; the originals
// stay in the session file.

const SCREENSHOTS = 120;
const IMAGE_CHARS = 4_000;
/**
 * Stated budget: a 128k-token window, measured with Pi's own estimateTokens,
 * which Pi uses for its context usage and counts each image as 1,200 tokens.
 */
const BUDGET_TOKENS = 128_000;
const KEEP_RECENT = 5;

function screenshotSession(sessionManager: SessionManager, count: number): string[] {
	sessionManager.appendMessage({ role: "user", content: OPENING_REQUEST, timestamp: 1 });
	const resultIds: string[] = [];
	for (let index = 1; index <= count; index++) {
		sessionManager.appendMessage(assistantToolCall(index));
		resultIds.push(sessionManager.appendMessage(screenshotResult(index, IMAGE_CHARS)));
	}
	sessionManager.appendMessage(closingReply(count));
	sessionManager.appendMessage({ role: "user", content: FOLLOW_UP_REQUEST, timestamp: count * 2 + 3 });
	return resultIds;
}

function project(sessionManager: SessionManager) {
	return buildSessionProjection(sessionManager.getEntries(), sessionManager.getLeafId());
}

function projectedTokens(sessionManager: SessionManager): number {
	return project(sessionManager).messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function applyPlan(sessionManager: SessionManager, keepRecent: number) {
	const plan = planMediaElision(project(sessionManager).entries, { keepRecent });
	for (const draft of plan.drafts) sessionManager.appendContextEdit(draft.targetId, draft.replacement);
	return plan;
}

test(`${SCREENSHOTS} screenshot results fold under a 128k-token budget without losing text`, () => {
	const sessionManager = SessionManager.inMemory("/tmp/media-fold");
	const resultIds = screenshotSession(sessionManager, SCREENSHOTS);
	const before = projectedTokens(sessionManager);
	assert.ok(before > BUDGET_TOKENS, `fixture must start over budget, was ${before}`);

	const plan = applyPlan(sessionManager, KEEP_RECENT);
	assert.equal(plan.drafts.length, SCREENSHOTS - KEEP_RECENT);
	assert.equal(plan.removed.length, SCREENSHOTS - KEEP_RECENT);

	const after = projectedTokens(sessionManager);
	assert.ok(after < BUDGET_TOKENS, `folded context is ${after} tokens`);
	const visible = JSON.stringify(project(sessionManager).messages);
	for (let index = 1; index <= SCREENSHOTS; index++) {
		assert.ok(visible.includes(screenshotText(index)), `text of screenshot ${index} must survive`);
		const keptImage = index > SCREENSHOTS - KEEP_RECENT;
		assert.equal(visible.includes(screenshotMarker(index)), keptImage, `image ${index} kept=${keptImage}`);
	}
	for (const text of [OPENING_REQUEST, CLOSING_REPLY, FOLLOW_UP_REQUEST]) assert.ok(visible.includes(text), text);

	// The placeholder names what was removed and where the original lives.
	const firstId = resultIds[0]!;
	assert.ok(visible.includes(`[image/png, ~3 KB image omitted from context; the original is in session entry ${firstId}]`), visible.slice(0, 2_000));
	// The original bytes are still in the session record.
	const original = JSON.stringify(sessionManager.getEntry(firstId));
	assert.ok(original.includes(screenshotMarker(1)), "the elided image must stay recoverable from its entry");
});

test("a second plan over an elided session changes nothing", () => {
	const sessionManager = SessionManager.inMemory("/tmp/media-fold");
	screenshotSession(sessionManager, 12);
	assert.equal(applyPlan(sessionManager, 2).drafts.length, 10);
	const again = planMediaElision(project(sessionManager).entries, { keepRecent: 2 });
	assert.deepEqual(again.drafts, []);
	assert.deepEqual(again.removed, []);
});

test("elided media stays recoverable after the session file is reopened", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-media-fold-"));
	try {
		const sessionManager = SessionManager.create(dir, dir);
		const resultIds = screenshotSession(sessionManager, 4);
		applyPlan(sessionManager, 1);
		const file = sessionManager.getSessionFile();
		assert.ok(file, "a file-backed session must have a file");
		const reopened = SessionManager.open(file, dir);
		const visible = JSON.stringify(project(reopened).messages);
		assert.ok(!visible.includes(screenshotMarker(1)), "the edit must survive a reopen");
		assert.ok(visible.includes(screenshotMarker(4)), "the newest image stays in context");
		assert.ok(JSON.stringify(reopened.getEntry(resultIds[0]!)).includes(screenshotMarker(1)), "the original stays in the file");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("an entry with a part that is not text or an image keeps its images (#166)", () => {
	const image = { type: "image", mimeType: "image/png", data: "AAAA" };
	const entry = (id: string, content: unknown[]) => ({
		sourceEntry: { id, type: "message" },
		messages: [{ role: "toolResult", content }],
	});
	const plan = planMediaElision([
		entry("malformed-text", [{ type: "text", text: 5 }, image]),
		entry("tool-call", [{ type: "toolCall", id: "call", name: "read", arguments: {} }, image]),
		entry("well-formed", [{ type: "text", text: "ok" }, image]),
		entry("newest", [image]),
	], { keepRecent: 1 });
	assert.deepEqual(plan.drafts.map((draft) => draft.targetId), ["well-formed"]);
	assert.deepEqual(plan.removed.map((ref) => ref.entryId), ["well-formed"]);
});

test("a fold summary names the media its range removed, bounded", () => {
	const sessionManager = SessionManager.inMemory("/tmp/media-fold");
	const resultIds = screenshotSession(sessionManager, 11);
	const range = project(sessionManager).entries;
	const notice = describeFoldedMedia(range);
	assert.ok(notice, "a range with images must produce a notice");
	assert.match(notice, /^Media in this folded range: 11 images\. The originals stay in the session file\./u);
	assert.ok(notice.includes(`image/png ~3 KB (entry ${resultIds[0]})`));
	assert.ok(notice.includes(`image/png ~3 KB (entry ${resultIds[7]})`));
	assert.ok(!notice.includes(`entry ${resultIds[8]}`), "the listing is bounded");
	assert.match(notice, /and 3 more\.$/u);

	const textOnly = range.filter((entry) => !JSON.stringify(entry.messages).includes("\"image\""));
	assert.equal(describeFoldedMedia(textOnly), null);
});
