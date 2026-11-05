import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import {
	ASK_ME_CUSTOM_TYPE,
	FOLD_NOTICE_TYPE,
	MAX_HINT_CONDENSED_CHARS,
	MAX_VERBATIM_CHARS,
	MAX_HINT_DETAILS_CHARS,
	MAX_HINT_LINE_CHARS,
	MAX_HINT_OWNER_CHARS,
	applyHintsToCompaction,
	createFoldHints,
} from "../src/folds/fold-hints.js";
import type { Config } from "../src/folds/kernel/index.js";

// Pi does not export prepareCompaction(); the oracle is the private module itself.
const piCompaction = await import(pathToFileURL(path.join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js")).href) as {
	prepareCompaction(
		entries: SessionEntry[],
		settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
	): { messagesToSummarize: unknown[]; turnPrefixMessages: unknown[] } | undefined;
};

// Seams: the fold-hint registry (pi-context-aware#281), planFold with hints (folds, second-tier
// distillation, the protected zone of pi-context-aware#284), and the compaction transform. The
// /ask-me marker and the ask tool are context-aware's own hints (pi-context-aware#278).

const CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};
const SUMMARY = "The opening work was settled: the plan, the question and its answer.";
const BODY = "ASK-ME-BODY-SECRET: interview the user about every assumption in the plan before acting.";
const QUESTION = "ASK-QUESTION-7d1: Should the cache be per worktree?";
const ANSWER = "ASK-ANSWER-7d1: Yes, per worktree, keyed by its root.";

function user(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function assistant(manager: SessionManager, text: string): string {
	return manager.appendMessage(fauxAssistantMessage(text));
}

function askPair(manager: SessionManager, id = "ask-1"): [string, string] {
	const call = manager.appendMessage(fauxAssistantMessage(fauxToolCall("ask", { questions: [{ id: "q", question: QUESTION }] }, { id }), { stopReason: "toolUse" }));
	const result = manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "ask", content: [{ type: "text", text: ANSWER }], isError: false, timestamp: Date.now() });
	return [call, result];
}

function askMe(manager: SessionManager): string {
	return manager.appendCustomMessageEntry(ASK_ME_CUSTOM_TYPE, BODY, true, { flags: ["--deep"], focus: "auth flow" });
}

function contextText(manager: SessionManager): string {
	return JSON.stringify(manager.buildSessionContext().messages);
}

function carrierText(drafts: readonly unknown[]): string {
	const carrier = drafts.find((draft) => (draft as { type?: string; replacement?: unknown }).type === "context_edit" && (draft as { replacement?: unknown }).replacement !== null);
	const content = (carrier as { replacement?: { content?: unknown } } | undefined)?.replacement?.content;
	return typeof content === "string" ? content : JSON.stringify(content);
}

// ---- registry --------------------------------------------------------------------------------

test("a customType another extension owns is refused, and the owner may replace its own hint", () => {
	const hints = createFoldHints();
	assert.deepEqual(hints.register({ ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "one-line", line: "status" }), { ok: true, replaced: false });
	assert.deepEqual(hints.register({ ownerKey: "ext-b", match: { customType: "demo-status" }, policy: "drop-after-read" }),
		{ ok: false, error: "demo-status is owned by another extension in this session" });
	assert.equal(hints.forMessage({ role: "custom", customType: "demo-status", content: "x" })?.policy, "one-line", "the refused hint changed nothing");
	assert.deepEqual(hints.register({ ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "drop-after-read" }), { ok: true, replaced: true });
	assert.equal(hints.forMessage({ role: "custom", customType: "demo-status", content: "x" })?.policy, "drop-after-read");
	// context-aware owns its built-in hints; no other extension can take them over.
	assert.equal(hints.register({ ownerKey: "ext-a", match: { customType: ASK_ME_CUSTOM_TYPE }, policy: "verbatim" }).ok, false);
	assert.deepEqual(hints.register({ ownerKey: "ext-a", match: { toolName: "ask" }, policy: "default" }),
		{ ok: false, error: "ask is owned by another extension in this session" });
	assert.deepEqual(hints.register({ ownerKey: "context-aware", match: { customType: "mine" }, policy: "drop-after-read" }),
		{ ok: false, error: 'ownerKey "context-aware" is reserved' });
	assert.deepEqual(hints.register({ ownerKey: "ext-a", match: { customType: "context-aware.anything" }, policy: "drop-after-read" }),
		{ ok: false, error: 'customType prefix "context-aware." is reserved' });
});

test("endOwner removes an owner's hints but keeps its claim, so another extension cannot take the key", () => {
	const hints = createFoldHints();
	assert.ok(hints.register({ ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "drop-after-read" }).ok);
	assert.equal(hints.endOwner("ext-a"), 1);
	assert.equal(hints.forMessage({ role: "custom", customType: "demo-status", content: "x" }), undefined);
	assert.equal(hints.register({ ownerKey: "ext-b", match: { customType: "demo-status" }, policy: "drop-after-read" }).ok, false);
	assert.equal(hints.endOwner("context-aware"), 0, "the built-in hints cannot be ended");
	assert.equal(hints.forMessage({ role: "custom", customType: ASK_ME_CUSTOM_TYPE, content: "x" })?.policy, "one-line");
});

test("registration copies named fields only, bounds every size, and refuses malformed input", () => {
	const hints = createFoldHints();
	const registration = { ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "one-line", line: "first\nline\u0007 " + "x".repeat(400), extra: "IGNORED" };
	assert.ok(hints.register(registration).ok);
	registration.line = "CHANGED-AFTER-REGISTER";
	(registration.match as { customType: string }).customType = "other";
	const hint = hints.forMessage({ role: "custom", customType: "demo-status", content: "x" });
	assert.ok(hint?.line);
	assert.ok(hint.line.startsWith("first line "), hint.line);
	assert.ok(hint.line.length <= MAX_HINT_LINE_CHARS);
	assert.ok(!/CHANGED|\n/u.test(hint.line) && !hint.line.includes("\u0007"), hint.line);
	assert.equal(hints.forMessage({ role: "custom", customType: "other", content: "x" }), undefined);

	const refused = (value: unknown) => {
		const result = hints.register(value);
		assert.equal(result.ok, false, String(Object.keys(value ?? {})));
	};
	refused(null);
	refused({ ownerKey: "o".repeat(MAX_HINT_OWNER_CHARS + 1), match: { customType: "a" }, policy: "drop-after-read" });
	refused({ ownerKey: "ext\nnewline", match: { customType: "a" }, policy: "drop-after-read" });
	refused({ ownerKey: "ext-a", match: { customType: "a", toolName: "b" }, policy: "drop-after-read" });
	refused({ ownerKey: "ext-a", match: { customType: "bad type" }, policy: "drop-after-read" });
	refused({ ownerKey: "ext-a", match: { customType: "a" }, policy: "shout" });
	refused({ ownerKey: "ext-a", match: { customType: "a" }, policy: "verbatim" });
	refused({ ownerKey: "ext-a", match: { toolName: "a" }, policy: "condensed", condensed: "c" });
	refused({ ownerKey: "ext-a", match: { customType: "a" }, policy: "condensed", condensed: "c".repeat(MAX_HINT_CONDENSED_CHARS + 1) });
	refused({ ownerKey: "ext-a", match: { customType: "a" }, policy: "one-line" });
	refused({ ownerKey: "ext-a", match: { customType: "a" }, policy: "one-line", summarize: "not a function" });
	const hostile = { ownerKey: "ext-a", match: { customType: "a" }, get policy(): string { throw new Error("boom"); } };
	assert.doesNotThrow(() => hints.register(hostile));
	refused(hostile);
});

test("summarize gets only a copy of details, and its result is one bounded line", () => {
	const hints = createFoldHints();
	const seen: unknown[] = [];
	assert.ok(hints.register({
		ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "one-line", line: "FALLBACK-LINE",
		summarize: (details: unknown) => {
			seen.push(details);
			(details as { count: number }).count = 99;
			return "status\n\u001b[31mred\u001b[0m " + "y".repeat(500);
		},
	}).ok);
	const details = { count: 3, nested: { ok: true } };
	const line = hints.forMessage({ role: "custom", customType: "demo-status", content: "BODY-NEVER-PASSED", details })?.line ?? "";
	assert.deepEqual(seen, [{ count: 99, nested: { ok: true } }]);
	assert.notEqual(seen[0], details, "the callback gets a copy");
	assert.equal(details.count, 3, "the callback cannot change the session's details");
	assert.ok(line.length <= MAX_HINT_LINE_CHARS, String(line.length));
	assert.ok(!line.includes("\n") && !line.includes("\u001b") && !line.includes("BODY-NEVER-PASSED"), line);
	assert.ok(line.startsWith("status "), line);
	// Oversized details are never passed; a throwing callback gets the fallback line.
	const big = { blob: "z".repeat(MAX_HINT_DETAILS_CHARS + 1) };
	seen.length = 0;
	assert.equal(hints.forMessage({ role: "custom", customType: "demo-status", content: "x", details: big })?.line, "FALLBACK-LINE");
	assert.deepEqual(seen, []);
	assert.ok(hints.register({ ownerKey: "ext-a", match: { customType: "demo-throw" }, policy: "one-line", summarize: () => { throw new Error("no"); } }).ok);
	assert.equal(hints.forMessage({ role: "custom", customType: "demo-throw", content: "x" })?.line, "demo-throw message");
});

test("no hint applies to a typed user message, whatever it says", () => {
	const hints = createFoldHints();
	assert.equal(hints.forMessage({ role: "user", content: "/ask-me --deep auth flow", customType: ASK_ME_CUSTOM_TYPE }), undefined);
	assert.equal(hints.forMessage({ role: "custom", customType: ASK_ME_CUSTOM_TYPE, content: BODY, details: { flags: ["--deep"], focus: "auth flow" } })?.line,
		"/ask-me ran: --deep auth flow");
});

// ---- folds -----------------------------------------------------------------------------------

test("a one-line hint folds a marked custom message to its line and quotes none of its body", () => {
	for (const withHints of [true, false]) {
		const manager = SessionManager.inMemory("/tmp");
		const hints = createFoldHints();
		assert.ok(hints.register({ ownerKey: "ext-a", match: { customType: "demo-status" }, policy: "one-line", summarize: (details: unknown) => "demo status: " + String((details as { state?: unknown }).state) }).ok);
		user(manager, "OPENING-REQUEST about the cache");
		manager.appendCustomMessageEntry("demo-status", "DEMO-BODY-SECRET ".repeat(20), true, { state: "green" });
		assistant(manager, "FIRST-ANSWER");
		user(manager, "NEXT-REQUEST");
		assistant(manager, "NEXT-ANSWER");
		const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00003", summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, ...(withHints ? { hints } : {}) });
		assert.ok(plan.ok, JSON.stringify(plan));
		const summary = carrierText(plan.drafts);
		assert.doesNotMatch(summary, /DEMO-BODY-SECRET/u);
		if (withHints) {
			assert.match(summary, /Extension messages in this fold \(one line each; not user intent\):\n- demo status: green/u);
		} else {
			assert.doesNotMatch(summary, /demo status/u, "without the hint the fold records no line");
		}
		applyFoldDrafts(manager, plan.drafts);
		assert.doesNotMatch(contextText(manager), /DEMO-BODY-SECRET/u);
	}
});

test("#278: an /ask-me body folds to one command line while the ask question and answer stay word for word", () => {
	for (const withHints of [true, false]) {
		const manager = SessionManager.inMemory("/tmp");
		user(manager, "OPENING-REQUEST");
		const body = askMe(manager);
		const [call, result] = askPair(manager);
		assistant(manager, "DECIDED: per worktree cache");
		user(manager, "NEXT-REQUEST");
		assistant(manager, "NEXT-ANSWER");
		const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00005", summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, ...(withHints ? { hints: createFoldHints() } : {}) });
		assert.ok(plan.ok, JSON.stringify(plan));
		const record = plan.records[0]!;
		const covered = [record.carrierId, ...record.hiddenIds];
		assert.ok(covered.includes(body), "the body is folded");
		const summary = carrierText(plan.drafts);
		assert.doesNotMatch(summary, /ASK-ME-BODY-SECRET/u);
		applyFoldDrafts(manager, plan.drafts);
		const context = contextText(manager);
		assert.doesNotMatch(context, /ASK-ME-BODY-SECRET/u);
		if (withHints) {
			assert.match(summary, /- \/ask-me ran: --deep auth flow/u);
			assert.equal(covered.includes(call) || covered.includes(result), false, "the ask pair is kept out of the fold");
			assert.ok(context.includes("ASK-QUESTION-7d1") && context.includes("ASK-ANSWER-7d1"), "question and answer stay visible");
		} else {
			assert.ok(covered.includes(call) && covered.includes(result), "without hints the ask pair folds");
			assert.doesNotMatch(context, /ASK-ANSWER-7d1/u);
		}
	}
});

test("#278: without the marker a typed message is still user intent: no command line, and it keeps its protection", () => {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "OPENING-REQUEST");
	assistant(manager, "OPENING-ANSWER");
	const typed = user(manager, "/ask-me --deep auth flow " + BODY);
	assistant(manager, "TYPED-ANSWER");
	assistant(manager, "MORE-WORK");
	assistant(manager, "EVEN-MORE-WORK");
	const config = { ...CONFIG, preserveRecentMessages: 1 };
	const fold = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00004", summary: SUMMARY, modelContextLimit: 64_000, config, hints: createFoldHints() });
	assert.ok(fold.ok, JSON.stringify(fold));
	assert.doesNotMatch(carrierText(fold.drafts), /Extension messages|\/ask-me ran/u, "a typed message gets no one-line record");
	const refused = planFold({ branch: manager.getBranch(), startRef: "m00003", endRef: "m00003", summary: SUMMARY, modelContextLimit: 64_000, config, hints: createFoldHints() });
	assert.equal(refused.ok, false, "the most recent typed user message stays protected");
	assert.match(refused.ok ? "" : refused.errors.join(" "), /most recent user message/u);
	void typed;
});

test("a verbatim tool keeps its call and result word for word through second-tier distillation", () => {
	for (const withHints of [true, false]) {
		const manager = SessionManager.inMemory("/tmp");
		const hints = withHints ? { hints: createFoldHints() } : {};
		user(manager, "U1 opening");
		assistant(manager, "A1 answer");
		const [call, result] = askPair(manager);
		user(manager, "U2 follow-up");
		assistant(manager, "A2 answer");
		user(manager, "U3 more");
		assistant(manager, "A3 answer");
		user(manager, "U4 latest");
		assistant(manager, "A4 answer");
		const first = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00006", summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, ...hints });
		assert.ok(first.ok, JSON.stringify(first));
		applyFoldDrafts(manager, first.drafts);
		const second = planFold({ branch: manager.getBranch(), startRef: "b1", endRef: "m00008", summary: SUMMARY + " Then U3 was answered.", modelContextLimit: 64_000, config: CONFIG, ...hints });
		assert.ok(second.ok, JSON.stringify(second));
		assert.equal(second.records[0]?.tier, 2);
		applyFoldDrafts(manager, second.drafts);
		const covered = [second.records[0]!.carrierId, ...second.records[0]!.hiddenIds];
		const context = contextText(manager);
		if (withHints) {
			assert.equal(covered.includes(call) || covered.includes(result), false);
			assert.ok(context.includes(QUESTION.replace(/"/gu, "")) && context.includes(ANSWER), "the call and result survive both tiers");
			const askParts = manager.buildSessionContext().messages.filter((message) =>
				(message.role === "toolResult" && message.toolName === "ask") ||
				(message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === "ask")));
			assert.equal(askParts.length, 2, "both the call and the result are visible");
		} else {
			assert.doesNotMatch(context, /ASK-ANSWER-7d1/u);
		}
	}
});

test("a range holding only verbatim entries is refused with a reason", () => {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "U1");
	askPair(manager);
	user(manager, "U2");
	assistant(manager, "A2");
	user(manager, "U3");
	assistant(manager, "A3");
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00002", endRef: "m00003", summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, hints: createFoldHints() });
	assert.deepEqual(plan.ok ? [] : plan.errors, ["Every entry in this range is kept word for word by a fold hint; there is nothing to fold."]);
});

// ---- protected zone (#284 item 1) ------------------------------------------------------------

function session284() {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "U1 opening");
	assistant(manager, "A1 answer");
	user(manager, "U2 the latest typed request");
	assistant(manager, "A2 answer");
	manager.appendCustomMessageEntry("other-extension.status", "Status note from an extension without a hint", true);
	manager.appendCustomMessageEntry(FOLD_NOTICE_TYPE, "Fold m00001..m00002 was not written: coverage-changed", true);
	assistant(manager, "A3 read the note");
	assistant(manager, "A4 still working");
	return manager;
}
const fold284 = (manager: SessionManager, ref: string, extra: Partial<Parameters<typeof planFold>[0]> = {}) =>
	planFold({ branch: manager.getBranch(), startRef: ref, endRef: ref, summary: SUMMARY, modelContextLimit: 64_000, config: { ...CONFIG, preserveRecentMessages: 1 }, ...extra });

test("#284: an injected custom message, hinted or not, does not take the typed message's place as the most recent user message", () => {
	for (const withHints of [true, false]) {
		const hints = withHints ? { hints: createFoldHints() } : {};
		const manager = session284();
		const unhinted = fold284(manager, "m00005", hints);
		const hinted = fold284(manager, "m00006", hints);
		assert.ok(unhinted.ok, "the unhinted note can be folded (hints " + withHints + "): " + JSON.stringify(unhinted));
		assert.ok(hinted.ok, "the notice can be folded (hints " + withHints + "): " + JSON.stringify(hinted));
	}
});

test("#284: a message a person typed still moves the boundary", () => {
	const manager = session284();
	const typed = fold284(manager, "m00003");
	assert.equal(typed.ok, false, "the typed request stays protected");
	assert.match(typed.ok ? "" : typed.errors.join(" "), /protected zone/u);
});

test("#284: a notice that arrives mid-turn does not make the earlier part of that turn unfoldable", () => {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "U1 the request of this turn");
	assistant(manager, "A1 first step");
	assistant(manager, "A2 second step");
	assistant(manager, "A3 third step");
	manager.appendCustomMessageEntry("fabric.peers", "<fabric-peers>2 peers</fabric-peers>", true);
	assistant(manager, "A4 fourth step");
	assistant(manager, "A5 fifth step");
	const config = { ...CONFIG, preserveRecentMessages: 1 };
	const base = { branch: manager.getBranch(), startRef: "m00005", endRef: "m00005", summary: SUMMARY, modelContextLimit: 64_000, config };
	const native = planFold(base);
	assert.ok(native.ok, "under the native rule the note can be folded: " + JSON.stringify(native));
	// The parity preview applies billion-context-pi's rule, under which the note is the latest user message.
	const parity = planFold({ ...base, protectedZone: "all-user-role" });
	assert.equal(parity.ok, false, "under the parity rule the note is the latest user message and stays protected");
});

// ---- compaction ------------------------------------------------------------------------------

test("compaction input: a one-line message becomes its marked line, a read note is dropped, verbatim tools are named", () => {
	const hints = createFoldHints();
	const custom = { role: "custom", customType: ASK_ME_CUSTOM_TYPE, content: BODY, display: true, details: { flags: ["--deep"], focus: "auth flow" }, timestamp: 1 };
	const typed = { role: "user", content: "/ask-me typed by the user " + BODY, timestamp: 2 };
	const note = { role: "custom", customType: FOLD_NOTICE_TYPE, content: "NOTICE-TEXT", display: true, timestamp: 3 };
	const call = fauxAssistantMessage(fauxToolCall("ask", { q: QUESTION }, { id: "ask-c" }), { stopReason: "toolUse" });
	const result = { role: "toolResult", toolCallId: "ask-c", toolName: "ask", content: [{ type: "text", text: ANSWER }], isError: false, timestamp: 4 };
	const lateNote = { ...note, content: "LATE-NOTICE" };
	const hinted = applyHintsToCompaction({ messagesToSummarize: [custom, typed, note, call, result], turnPrefixMessages: [lateNote] }, hints);
	assert.equal(hinted.changed, true);
	const text = JSON.stringify(hinted);
	assert.doesNotMatch(JSON.stringify(hinted.messagesToSummarize[0]), /ASK-ME-BODY-SECRET/u);
	assert.equal((hinted.messagesToSummarize[0] as { content: string }).content, "[ask-me: extension message kept as one line; not user intent] /ask-me ran: --deep auth flow");
	assert.equal(hinted.messagesToSummarize[1], typed, "a typed user message is passed through unchanged");
	assert.equal(text.includes("NOTICE-TEXT"), false, "a note the assistant answered is dropped");
	assert.ok(text.includes("LATE-NOTICE"), "a note after the last assistant message is kept");
	assert.ok(hinted.messagesToSummarize.includes(call) && hinted.messagesToSummarize.includes(result));
	assert.equal(hinted.instruction, "Quote every call and result of these tools word for word in the summary, as decisions: ask.");
	assert.equal((custom as { content: string }).content, BODY, "the session's message is not changed");
	const plain = applyHintsToCompaction({ messagesToSummarize: [typed], turnPrefixMessages: [] }, hints);
	assert.deepEqual(plain, { messagesToSummarize: [typed], turnPrefixMessages: [], changed: false });
});

test("compaction input: a fold whose carrier is a hinted message keeps its summary", () => {
	const hints = createFoldHints();
	for (const carrier of ["ask-me", "notice"] as const) {
		for (const folded of [true, false]) {
			const manager = SessionManager.inMemory("/tmp");
			if (carrier === "ask-me") askMe(manager);
			else manager.appendCustomMessageEntry(FOLD_NOTICE_TYPE, "NOTICE-TEXT", true);
			user(manager, "OPENING-REQUEST");
			assistant(manager, "FIRST-ANSWER");
			for (let index = 0; index < 4; index++) {
				user(manager, "LATER-REQUEST " + index + " " + "padding ".repeat(400));
				assistant(manager, "LATER-ANSWER " + index + " " + "padding ".repeat(400));
			}
			if (folded) {
				const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m00003", summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, hints });
				assert.ok(plan.ok, JSON.stringify(plan));
				applyFoldDrafts(manager, plan.drafts);
			}
			const preparation = piCompaction.prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1_000 });
			assert.ok(preparation, "Pi prepares a compaction");
			const before = JSON.stringify(preparation.messagesToSummarize);
			const hinted = applyHintsToCompaction(preparation, hints, manager.getBranch());
			const text = JSON.stringify(hinted.messagesToSummarize);
			if (folded) {
				assert.ok(before.includes(SUMMARY), carrier + ": Pi hands the fold summary to the summarizer");
				assert.ok(text.includes(SUMMARY), carrier + ": the fold summary reaches the summarizer");
				assert.equal(text.includes("extension message kept as one line"), false, carrier + ": the carrier is not rewritten as a one-line message");
			} else if (carrier === "ask-me") {
				assert.equal(text.includes("ASK-ME-BODY-SECRET"), false, "an unfolded /ask-me body is still kept as one line");
			} else {
				assert.equal(text.includes("NOTICE-TEXT"), false, "an unfolded read notice is still dropped");
			}
		}
	}
});
// #293: a small verbatim call must not pin a result over the cap.
function askResult(manager: SessionManager, ids: Array<[string, number]>): { call: string; results: string[] } {
	const call = manager.appendMessage(fauxAssistantMessage(ids.map(([id]) => fauxToolCall("ask", { questions: [{ id: "q", question: QUESTION }] }, { id })), { stopReason: "toolUse" }));
	const results = ids.map(([id, size]) => manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "ask", content: [{ type: "text", text: "R".repeat(size) }], isError: false, timestamp: Date.now() }));
	return { call, results };
}

function foldAskSession(sizes: Array<[string, number]>): { covered: string[]; call: string; results: string[]; context: string } {
	const manager = SessionManager.inMemory("/tmp");
	user(manager, "OPENING-REQUEST");
	const { call, results } = askResult(manager, sizes);
	assistant(manager, "DECIDED");
	user(manager, "NEXT-REQUEST");
	assistant(manager, "NEXT-ANSWER");
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00001", endRef: "m0000" + (3 + sizes.length), summary: SUMMARY, modelContextLimit: 64_000, config: CONFIG, hints: createFoldHints() });
	assert.ok(plan.ok, JSON.stringify(plan));
	const record = plan.records[0]!;
	applyFoldDrafts(manager, plan.drafts);
	return { covered: [record.carrierId, ...record.hiddenIds], call, results, context: contextText(manager) };
}

test("#293: a verbatim call with a 25,000-character result folds with it", () => {
	const session = foldAskSession([["big-1", 25_000]]);
	assert.ok(session.covered.includes(session.call) && session.covered.includes(session.results[0]!), "the call and its result are both folded");
	assert.doesNotMatch(session.context, /RRRRRRRRRR/u, "the large result is hidden");
});

test("#293: a verbatim call with a 1,000-character result stays visible with it", () => {
	const session = foldAskSession([["small-1", 1_000]]);
	assert.equal(session.covered.includes(session.call) || session.covered.includes(session.results[0]!), false);
	assert.match(session.context, /RRRRRRRRRR/u, "the small result stays visible");
});

test("#293: the cap is inclusive: 16,000 characters stay visible, 16,001 fold", () => {
	// Reading the cap from the call side: the result text is the only content counted here.
	const at = foldAskSession([["edge-1", MAX_VERBATIM_CHARS]]);
	assert.equal(at.covered.includes(at.results[0]!), false, "16,000 characters are kept");
	const over = foldAskSession([["edge-2", MAX_VERBATIM_CHARS + 1]]);
	assert.ok(over.covered.includes(over.results[0]!) && over.covered.includes(over.call), "16,001 characters fold");
});

test("#293: an entry with a small and a large result folds whole, leaving no split entry", () => {
	const session = foldAskSession([["mix-1", 1_000], ["mix-2", 25_000]]);
	assert.ok(session.covered.includes(session.call), "the call entry folds");
	assert.ok(session.results.every((id) => session.covered.includes(id)), "both results fold with it");
	assert.doesNotMatch(session.context, /RRRRRRRRRR/u);
});
