import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { FOLD_NOTICE_TYPE, registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { runFold } from "../src/context-tools/context-fold.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";
import type { Config } from "../src/folds/kernel/index.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";

// pi-context-aware#282: a fold the engine accepts must not be dropped at the end of the turn for a
// reason it already knew at call time, a drop it could not foresee is reported in the next turn,
// and a call that folds nothing is an error result.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	readonly engine: FoldEngine;
	fire(name: string, manager: SessionManager, event?: Record<string, unknown>): { entries: SessionBoundaryDraft[] } | undefined;
	ctx(manager: SessionManager): ExtensionContext;
}

function boot(config: Partial<Config>): Harness {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, { config });
	const ctx = (manager: SessionManager) => ({ cwd: manager.getCwd(), sessionManager: manager, model: undefined }) as unknown as ExtensionContext;
	return {
		engine,
		ctx,
		fire(name, manager, event = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = handler({ type: name, ...event }, ctx(manager)) ?? result;
			return result as { entries: SessionBoundaryDraft[] } | undefined;
		},
	};
}

function withSession<T>(run: (manager: SessionManager) => T): T {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-drop-")));
	try {
		const manager = SessionManager.inMemory(cwd);
		// The opening user message folds like any other, so only the protected zone trims a range.
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));
		return run(manager);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const user = (manager: SessionManager, text: string) => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
const assistant = (manager: SessionManager, text: string) => manager.appendMessage(fauxAssistantMessage(text));
const notices = (drafts: readonly SessionBoundaryDraft[] | undefined) => (drafts ?? []).filter((draft) => draft.type === "custom_message" && draft.customType === FOLD_NOTICE_TYPE);
const noticeText = (draft: SessionBoundaryDraft | undefined) => draft?.type === "custom_message" ? (typeof draft.content === "string" ? draft.content : draft.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")) : "";
const textOf = (result: { content: { type: "text"; text: string }[] }) => result.content.map((part) => part.text).join("\n");

const SUMMARY = "Summary of the opening exchanges: alpha and beta were settled between user and assistant.";

/**
 * Step 3 of the issue: the engine's size gate counts the whole named range, then the protected
 * recent messages are taken out of it. Here m00003 and m00004 are protected (the last two messages
 * and the last user message), so m00001..m00004 counts 13,500 characters but only m00001..m00002
 * (1,500) would be folded: below the 5,000-character minimum the end-of-turn plan enforces.
 */
function protectedTail(manager: SessionManager): void {
	user(manager, "OPENING-QUESTION " + "q".repeat(983));
	assistant(manager, "OPENING-ANSWER " + "a".repeat(485));
	user(manager, "RECENT-QUESTION " + "r".repeat(5_984));
	assistant(manager, "RECENT-ANSWER " + "s".repeat(5_986));
}
const SIZE_GATED: Partial<Config> = {
	compress: { minCompressRange: 5_000, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};

test("#282: a range whose remainder after the protected zone is below minCompressRange is refused at call time", () => {
	withSession((manager) => {
		protectedTail(manager);
		const harness = boot(SIZE_GATED);
		const ctx = harness.ctx(manager);
		const result = harness.engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_small#0" });
		assert.equal(result.ok, false, "accepted: " + JSON.stringify(result));
		assert.match(result.ok ? "" : result.errors.join(" "), /^Total compressible content too small \(\d+ chars across 1 range\(s\), min 5000\)/u);
		assert.ok(!result.ok && result.validRefs.includes("m00001"), "the refusal lists the valid refs");
		assert.equal(harness.engine.pending(ctx), 0, "nothing is queued");
		assert.equal(harness.fire("turn_end", manager, { entries: [] }), undefined, "the boundary has nothing to write");
		assert.deepEqual(harness.engine.dropped(ctx), []);
	});
});

test("#282: a range whose remainder still meets minCompressRange is accepted and written", () => {
	withSession((manager) => {
		user(manager, "OPENING-QUESTION " + "q".repeat(3_983));
		assistant(manager, "OPENING-ANSWER " + "a".repeat(3_985));
		user(manager, "RECENT-QUESTION " + "r".repeat(5_984));
		assistant(manager, "RECENT-ANSWER " + "s".repeat(5_986));
		const harness = boot(SIZE_GATED);
		const ctx = harness.ctx(manager);
		const result = harness.engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_big#0" });
		assert.ok(result.ok && result.queued, JSON.stringify(result));
		const drafts = harness.fire("turn_end", manager, { entries: [] })?.entries ?? [];
		assert.equal(drafts.filter((draft) => draft.type === "custom" && draft.customType === FOLD_ENTRY_TYPE).length, 1, "the fold is written");
		assert.deepEqual(notices(drafts), [], "a written fold sends no notice");
	});
});

const NO_SIZE_GATE: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};

function exchanges(manager: SessionManager, count: number): void {
	for (let index = 1; index <= count; index++) {
		user(manager, "QUESTION-" + index + " about topic " + index);
		assistant(manager, "ANSWER-" + index + " with details " + index);
	}
}

test("#282: a queued fold dropped at the boundary produces exactly one next-turn notice naming the range and the reason", () => {
	withSession((manager) => {
		exchanges(manager, 4);
		const harness = boot(NO_SIZE_GATE);
		const ctx = harness.ctx(manager);
		// Both are accepted against the branch as it is; the first one written takes the second's range.
		const first = harness.engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY, requestId: "call_a#0" });
		const second = harness.engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: "A second fold of the same opening exchanges.", requestId: "call_b#0" });
		assert.ok(first.ok && first.queued && second.ok && second.queued);
		const drafts = harness.fire("turn_end", manager, { entries: [] })?.entries ?? [];
		const dropped = harness.engine.dropped(ctx);
		assert.equal(dropped.length, 1);
		const sent = notices(drafts);
		assert.equal(sent.length, 1, "one notice for the batch");
		const text = noticeText(sent[0]);
		assert.match(text, /^Fold m00001\.\.m00004 was not written: /u);
		assert.ok(text.includes(dropped[0]!.errors[0]!.replace(/^refused: /u, "").slice(0, 60)), "the notice gives the drop's reason: " + text);
		assert.ok(sent[0]!.type === "custom_message" && sent[0]!.display === true);
		// The notice comes after the fold drafts it reports on.
		assert.equal(drafts.at(-1), sent[0]);
		// The next boundary of the same run has no batch, so no second notice.
		assert.equal(notices(harness.fire("agent_before_settle", manager, { entries: [] })?.entries).length, 0);
	});
});

test("#282: the drop notice is bounded however many folds a batch drops", () => {
	withSession((manager) => {
		exchanges(manager, 4);
		const harness = boot(NO_SIZE_GATE);
		const ctx = harness.ctx(manager);
		for (let index = 0; index < 8; index++) {
			const result = harness.engine.request(ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY + " Variant " + index + ".", requestId: "call_many#" + index });
			assert.ok(result.ok && result.queued, JSON.stringify(result));
		}
		const drafts = harness.fire("turn_end", manager, { entries: [] })?.entries ?? [];
		assert.equal(harness.engine.dropped(ctx).length, 7);
		const sent = notices(drafts);
		assert.equal(sent.length, 1);
		const text = noticeText(sent[0]);
		assert.equal(text.split("\n").filter((line) => /was not written/u.test(line)).length, 3, text);
		assert.match(text, /4 more folds were not written/u);
		assert.ok(text.length <= 2_000, "bounded: " + text.length);
	});
});

test("#282: a call whose every range is refused is an error result; a mixed call is not", () => {
	withSession((manager) => {
		exchanges(manager, 4);
		const harness = boot(NO_SIZE_GATE);
		const ctx = harness.ctx(manager);
		const refused = runFold(harness.engine, ctx, "call_none", { content: [
			{ startId: "m99998", endId: "m99999", summary: SUMMARY },
			{ startId: "m99990", endId: "m99991", summary: SUMMARY },
		] });
		assert.equal(refused.isError, true, textOf(refused));
		assert.match(textOf(refused), /range 1 \(m99998\.\.m99999\) refused:/u);
		assert.equal(harness.engine.pending(ctx), 0);

		const malformed = runFold(harness.engine, ctx, "call_bad", { content: "not json" });
		assert.equal(malformed.isError, true, "a call with no readable range folds nothing");

		const mixed = runFold(harness.engine, ctx, "call_mixed", { content: [
			{ startId: "m99998", endId: "m99999", summary: SUMMARY },
			{ startId: "m00001", endId: "m00004", summary: SUMMARY },
		] });
		assert.equal(mixed.isError, false, textOf(mixed));
		assert.match(textOf(mixed), /range 1 \(m99998\.\.m99999\) refused:/u);
		assert.match(textOf(mixed), /range 2 \(m00001\.\.m00004\) accepted/u);
		assert.equal(harness.engine.pending(ctx), 1);
	});
});
