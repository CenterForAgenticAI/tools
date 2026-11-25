import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { entryToCoreMessages, foldStateFromBranch, planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts, registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { FOLD_ENTRY_TYPE, foldRecordsOnBranch, readFoldRecord } from "../src/folds/fold-entries.js";
import { createFoldTurnMemory, prepareFoldTurn, wholeEntryIds, type FoldTurnInput } from "../src/folds/fold-turn.js";
import { HIDE_ENTRY_TYPE, activeHides, hidePointerLine, hideRecordsOnBranch, planHides, readHideRecord } from "../src/folds/hide-entries.js";
import type { Config } from "../src/folds/kernel/index.js";
import { compareBatchRequestWithMemory, hashRequestMessages } from "../src/parity/compare.js";
import { parseSideSnapshot } from "../src/parity/side-file.js";
import { DEFAULT_PRESSURE_LADDER, type PressureLadderConfig } from "../src/policy/context-policy.js";
import { assistantToolCall } from "./provider-payloads.js";

// pi-context-aware#268: the last ladder step stores what it shortens. The first request above the step is
// shortened as before (request only); the next boundary writes a hide record and a context edit; from then
// on Pi applies the hide and the kernel leaves the shortened message alone.

const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const MARKER = "[truncated for context space]";
const ladder = (over: Partial<PressureLadderConfig>): PressureLadderConfig => ({ ...DEFAULT_PRESSURE_LADDER, ...over });

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Messages = { messages: Array<{ role: string; content: unknown }> };

interface Harness {
	readonly engine: FoldEngine;
	/** The request the per-turn pass sends for the session's current context, at `tokens` of host usage. */
	request(manager: SessionManager, tokens: number): Messages | undefined;
	/** The boundary: returns the entries the engine adds, as Pi would append them. */
	boundary(manager: SessionManager, name?: "turn_end" | "agent_before_settle"): SessionBoundaryDraft[];
	fire(name: string, manager: SessionManager, event?: Record<string, unknown>): unknown;
}

function boot(ladderOf?: PressureLadderConfig): Harness {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, { config: CONFIG, ...(ladderOf ? { ladder: () => ladderOf } : {}) });
	const ctxOf = (manager: SessionManager, tokens = 0) => ({
		cwd: manager.getCwd(), sessionManager: manager, model: { contextWindow: 200_000, input: ["text"] },
		getContextUsage: () => ({ tokens }), getSystemPrompt: () => "",
	}) as unknown as ExtensionContext;
	const fire = (name: string, manager: SessionManager, event: Record<string, unknown> = {}, tokens = 0): unknown => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = handler({ type: name, ...event }, ctxOf(manager, tokens)) ?? result;
		return result;
	};
	return {
		engine,
		fire: (name, manager, event) => fire(name, manager, event),
		request: (manager, tokens) => fire("context", manager, { messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system") }, tokens) as Messages | undefined,
		boundary: (manager, name = "turn_end") => ((fire(name, manager, { entries: [] }) as { entries: SessionBoundaryDraft[] } | undefined)?.entries ?? []),
	};
}

/** Old tool output in the middle and a short tail: the last step has something to shorten. */
function hideSession(): { manager: SessionManager; resultId: string } {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Inspect the log.", timestamp: 1 });
	manager.appendMessage(assistantToolCall(1));
	const resultId = manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "browser_screenshot", content: [{ type: "text", text: "HEAD\n" + "x".repeat(100_000) + "\nTAIL" }], isError: false, timestamp: 2 });
	for (let i = 1; i <= 6; i++) manager.appendMessage(i % 2 ? fauxAssistantMessage("Short note " + i + ".") : { role: "user", content: "Short question " + i + ".", timestamp: 1 });
	return { manager, resultId };
}

const kinds = (drafts: readonly SessionBoundaryDraft[]): string[] => drafts.map((draft) => draft.type === "custom" ? draft.customType : draft.type);
/** The text of every message part, joined: JSON escaping would hide the quotes of the pointer line. */
const textOf = (messages: ReadonlyArray<unknown>): string => messages.flatMap((message) => {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return [content];
	return Array.isArray(content) ? content.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])) : [];
}).join("\n");
const sent = (result: Messages | undefined): string => textOf(result?.messages ?? []);
const entryCount = (manager: SessionManager): number => manager.getEntries().length;

test("the hide moves with recoverableHideFraction: default writes at 96%, a 99% ladder writes nothing, an 80% ladder writes at 85%", () => {
	const at96 = hideSession();
	const atDefault = boot();
	assert.ok(sent(atDefault.request(at96.manager, 191_000)).includes(MARKER), "the request is shortened");
	assert.deepEqual(kinds(atDefault.boundary(at96.manager)), [HIDE_ENTRY_TYPE, "context_edit"]);

	const raised = hideSession();
	const high = boot(ladder({ recoverableHideFraction: 0.99 }));
	assert.equal(sent(high.request(raised.manager, 191_000)).includes(MARKER), false, "96% is under a 99% step");
	assert.deepEqual(high.boundary(raised.manager), []);

	const lowered = hideSession();
	const low = boot(ladder({ foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.8 }));
	low.request(lowered.manager, 170_000);
	assert.deepEqual(kinds(low.boundary(lowered.manager)), [HIDE_ENTRY_TYPE, "context_edit"], "85% is past an 80% step");
	const unchanged = hideSession();
	const dflt = boot();
	dflt.request(unchanged.manager, 170_000);
	assert.deepEqual(dflt.boundary(unchanged.manager), [], "and under the default 95%");
});

test("the first request is shortened alone; the boundary writes the hide; the next request carries the stored text and is not hidden again", () => {
	const { manager, resultId } = hideSession();
	const harness = boot();
	const before = entryCount(manager);
	const first = sent(harness.request(manager, 191_000) );
	assert.ok(first.includes(MARKER), "request-only shortening");
	assert.equal(first.includes("context_recall"), false, "the first request carries no pointer: nothing is stored yet");
	assert.equal(entryCount(manager), before, "nothing is written in the context event");

	const drafts = harness.boundary(manager);
	applyFoldDrafts(manager, drafts);
	const hides = hideRecordsOnBranch(manager.getBranch());
	assert.equal(hides.length, 1);
	assert.equal(hides[0]!.record.hideId, "h1");
	assert.equal(hides[0]!.record.targetId, resultId);

	const stored = textOf(manager.buildSessionContext().messages);
	assert.ok(stored.includes(hidePointerLine("h1")), "Pi now applies the hide: " + stored.slice(0, 200));
	assert.ok(stored.includes(MARKER) && stored.includes("HEAD") && stored.includes("TAIL"));
	assert.equal(stored.includes("x".repeat(3_000)), false, "the middle is gone from the context");

	const written = entryCount(manager);
	const second = sent(harness.request(manager, 191_000));
	assert.equal(second.split(hidePointerLine("h1")).length - 1, 1, "the pointer is in the request once");
	assert.equal(second.split(MARKER).length - 1, 1, "and the message is not shortened a second time");
	assert.deepEqual(harness.boundary(manager), [], "nothing more is queued");
	assert.equal(entryCount(manager), written);
	assert.equal(hideRecordsOnBranch(manager.getBranch()).length, 1);
});

test("the agent_before_settle boundary writes the hide too, once", () => {
	const { manager } = hideSession();
	const harness = boot();
	harness.request(manager, 191_000);
	assert.deepEqual(kinds(harness.boundary(manager, "agent_before_settle")), [HIDE_ENTRY_TYPE, "context_edit"]);
	assert.deepEqual(harness.boundary(manager, "turn_end"), [], "the queue was taken by the first boundary");
});

test("the fold engine ignores hide records: no block, no fold ref, the next fold is b1, and a hide is not read as a fold", () => {
	const { manager, resultId } = hideSession();
	const harness = boot();
	harness.request(manager, 191_000);
	applyFoldDrafts(manager, harness.boundary(manager));
	const hide = hideRecordsOnBranch(manager.getBranch())[0]!;
	assert.equal(readFoldRecord(hide.record), undefined, "hide metadata does not parse as a fold record");
	assert.deepEqual(foldRecordsOnBranch(manager.getBranch()), []);
	const state = foldStateFromBranch(manager.getBranch(), manager.buildContextEntries());
	assert.equal(state.records.length, 0);
	assert.equal(state.kernel.blocks.length, 0, "the kernel has no block for a hide");
	assert.equal(state.kernel.nextBlockId, 1);
	assert.equal(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE).length, 0);
	assert.equal(readHideRecord({ ...hide.record, hideId: "b1" }), undefined, "a hide id is h<N>, never a block id");

	// A fold over the hidden message still gets b1, and ends the hide: its summary replaces the message.
	const plan = planFold({ startRef: "m00001", endRef: "m00003", summary: "Summary: the log was inspected and the output was long; nothing else matters here.", branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), modelContextLimit: 200_000, config: CONFIG });
	assert.ok(plan.ok, JSON.stringify(plan));
	assert.deepEqual(plan.records.map((record) => record.blockId), ["b1"]);
	applyFoldDrafts(manager, plan.drafts);
	assert.deepEqual(activeHides(manager.getBranch()), [], "the fold's edit is the newest: the hide is no longer in effect");
	assert.equal(hideRecordsOnBranch(manager.getBranch())[0]!.record.targetId, resultId, "the record stays for context_recall");
});

test("a hide is never counted by the fold engine's nudge: hides alone leave the block count at zero in the turn pass", () => {
	const { manager } = hideSession();
	const harness = boot();
	harness.request(manager, 191_000);
	applyFoldDrafts(manager, harness.boundary(manager));
	const input: FoldTurnInput = {
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 200_000 }, systemPromptTokens: 0, hostTokens: 50_000, memory: createFoldTurnMemory(), config: CONFIG,
	};
	const result = prepareFoldTurn(input);
	assert.ok(result);
	assert.equal(result.nudge, undefined);
	assert.equal(result.emergency, undefined);
});

test("a refused boundary write: a hide whose target left the branch is dropped, and the session stays as it was", () => {
	const { manager } = hideSession();
	const harness = boot();
	harness.request(manager, 191_000);
	// The user moves to another point of the tree before the boundary: the shortened entry is no longer on the branch.
	const root = manager.getEntries()[0]!;
	manager.branch(root.id);
	harness.fire("session_tree", manager);
	const count = entryCount(manager);
	assert.deepEqual(harness.boundary(manager), []);
	assert.equal(entryCount(manager), count);
	assert.deepEqual(hideRecordsOnBranch(manager.getBranch()), []);
});

test("a refused boundary write: Pi would refuse a hide of a target that is not on the branch, and planning leaves it out whole", () => {
	const { resultId } = hideSession();
	const other = SessionManager.inMemory("/tmp");
	other.appendMessage({ role: "user", content: "Another session.", timestamp: 1 });
	assert.deepEqual(planHides(other.getBranch(), [resultId]), [], "an id the branch does not hold writes neither the record nor the edit");
	assert.throws(() => other.appendContextEdit(resultId, { content: "x" }), "the control: Pi itself refuses it");
});

test("a failed write between the record and the edit leaves a record that is not in effect; the next boundary writes a whole hide", () => {
	const { manager, resultId } = hideSession();
	const plans = planHides(manager.getBranch(), [resultId]);
	assert.equal(plans.length, 1);
	const [record, edit] = plans[0]!.drafts;
	assert.equal(record.type, "custom", "the metadata entry is written first");
	assert.equal(edit.type, "context_edit");
	applyFoldDrafts(manager, [record]);
	assert.deepEqual(activeHides(manager.getBranch()), [], "no edit: not in effect");
	assert.equal(JSON.stringify(manager.buildSessionContext().messages).includes("x".repeat(100_000)), true, "the original is still what the model reads");

	const harness = boot();
	harness.request(manager, 191_000);
	const drafts = harness.boundary(manager);
	assert.deepEqual(kinds(drafts), [HIDE_ENTRY_TYPE, "context_edit"]);
	applyFoldDrafts(manager, drafts);
	assert.deepEqual(hideRecordsOnBranch(manager.getBranch()).map(({ record: made }) => made.hideId), ["h1", "h2"], "the stray record keeps its id; the new hide takes the next one");
	assert.equal(activeHides(manager.getBranch()).length, 1);
});

test("a fold queued for the same boundary wins: the covered message is not also hidden", () => {
	const { manager } = hideSession();
	const harness = boot();
	const asked = harness.engine.request({ cwd: "/tmp", sessionManager: manager, model: undefined } as unknown as ExtensionContext, { startRef: "m00001", endRef: "m00003", summary: "Summary: the log was inspected and the output was long; nothing else matters here." });
	assert.ok(asked.ok && asked.queued, JSON.stringify(asked));
	harness.request(manager, 191_000);
	const drafts = harness.boundary(manager);
	assert.ok(kinds(drafts).includes(FOLD_ENTRY_TYPE), "the fold is written");
	assert.equal(kinds(drafts).includes(HIDE_ENTRY_TYPE), false, "and the hide is dropped, not stacked on the fold's edit");
	applyFoldDrafts(manager, drafts);
	assert.equal(hideRecordsOnBranch(manager.getBranch()).length, 0);
});

test("a hide record read back from a session file keeps only the named fields", () => {
	const read = readHideRecord({ version: 1, hideId: "h4", targetId: "e1", originalTokens: 9, createdAt: 3, extra: "kept?", __proto__: { polluted: true } });
	assert.deepEqual(read, { version: 1, hideId: "h4", targetId: "e1", originalTokens: 9, createdAt: 3 });
	for (const bad of [null, [], { version: 2 }, { version: 1, hideId: "h0", targetId: "e", originalTokens: 1, createdAt: 1 }, { version: 1, hideId: "b1", targetId: "e", originalTokens: 1, createdAt: 1 }, { version: 1, hideId: "h1", targetId: "", originalTokens: 1, createdAt: 1 }, { version: 1, hideId: "h1", targetId: "e", originalTokens: -1, createdAt: 1 }]) {
		assert.equal(readHideRecord(bad), undefined, JSON.stringify(bad));
	}
});

// ---- FP-205: the register entry ----

test("FP-205: the parity preview of the next request shows the pointer line, and the register explains exactly that", async () => {
	const { PARITY_REGISTER } = await import("../src/parity/register.js");
	const { manager, resultId } = hideSession();
	const base = { messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"), projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(), model: { contextWindow: 200_000 }, systemPromptTokens: 0, hostTokens: 191_000, config: CONFIG };
	const plain = prepareFoldTurn({ ...base, memory: createFoldTurnMemory() });
	const preview = prepareFoldTurn({ ...base, memory: createFoldTurnMemory(), compatibility: true });
	assert.ok(plain && preview);
	assert.equal(plain.hidePointerEntryIds, undefined, "only a parity preview adds the line");
	assert.deepEqual(preview.hidePointerEntryIds, [resultId]);
	assert.equal(textOf(plain.messages).includes("context_recall"), false);
	assert.equal(textOf(preview.messages).includes(hidePointerLine("h1")), true);

	const side = parseSideSnapshot(JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: {} } }));
	const previewed = compareBatchRequestWithMemory({
		sessionId: manager.getSessionId(), cwd: manager.getCwd(), header: manager.getHeader(), branch: manager.getBranch(), contextWindow: 200_000,
		turn: { hostTokens: 191_000, systemPromptTokens: 0 }, turnMemory: createFoldTurnMemory(),
	}, [{ toolCallId: "no-op", input: { content: [] }, before: side }], hashRequestMessages([]));
	const evidence = previewed.comparison.ours.hidePointer;
	assert.ok(evidence, "the record carries the substitution hashes");
	assert.equal(evidence.originals.length, 1);
	assert.notEqual(evidence.originals[0], evidence.replacements[0]);
	const entry = PARITY_REGISTER.find((candidate) => candidate.id === "FP-205");
	assert.ok(entry, "FP-205 is registered");
	assert.equal(entry.issue, "pi-context-aware#268");
});

test("FP-205 explains a content difference only when swapping the recorded pointer substitution makes the requests equal", async () => {
	const { PARITY_REGISTER } = await import("../src/parity/register.js");
	const entry = PARITY_REGISTER.find((candidate) => candidate.id === "FP-205")!;
	const result = (text: string) => ({ role: "toolResult", toolCallId: "t1", toolName: "shell", content: [{ type: "text", text }] }) as const;
	const bcpText = "HEAD\n\n..." + MARKER + " — original ~25000 tokens]...\n\nTAIL";
	const ourText = "HEAD\n\n..." + MARKER + " — original ~25000 tokens]...\n" + hidePointerLine("h1") + "\n\nTAIL";
	const complete = (messages: Parameters<typeof hashRequestMessages>[0]) => ({ ...hashRequestMessages(messages), activeFoldCount: 0, activeFoldIds: [], expectedSummaryHashes: [], expectedSummaryTopicHashes: [] });
	const bcp = hashRequestMessages([result(bcpText)]);
	const ours = complete([result(ourText)]);
	const key = (hashes: ReturnType<typeof hashRequestMessages>) => "toolResult:" + hashes.messages[0]!.hash;
	const evidence = { originals: [key(bcp)], replacements: [key(ours)] };
	const record = { kind: "compress" } as never;
	const next = (oursSide: object, bcpSide: object) => ({ ours: oursSide, bcp: { ...bcpSide, tagsSeen: true } }) as never;
	assert.equal(entry.matches({ kind: "tool-results" }, record, next({ ...ours, hidePointer: evidence }, bcp)), true);
	assert.equal(entry.matches({ kind: "tool-results" }, record, next(ours, bcp)), false, "without the evidence nothing is explained");
	const other = hashRequestMessages([result(bcpText + " changed")]);
	assert.equal(entry.matches({ kind: "tool-results" }, record, next({ ...ours, hidePointer: evidence }, other)), false, "a different bcp message is not explained");
	assert.equal(entry.matches({ kind: "summaries" }, record, next({ ...ours, hidePointer: evidence }, bcp)), false, "only content and tool-results differences");
});

test("FP-205 is documented in docs/fold-parity.md and configuration.md says the step is not gated on compaction", () => {
	const parity = fs.readFileSync("docs/fold-parity.md", "utf8");
	assert.match(parity, /\| FP-205 \| Recoverable hide pointer \|/u);
	const config = fs.readFileSync("docs/configuration.md", "utf8");
	assert.match(config, /not gated on\s+whether compaction can run/u);
	assert.match(config, /supersede|replaces the "only when compaction cannot run"/u);
	assert.doesNotMatch(config, /That is\s+not built/u);
});

// CR-HIDE-GUARD-TESTS and CR-HIDE-ID-BOUND (review of !272, note 204514).

const BIG = "HEAD\n" + "x".repeat(10_000) + "\nTAIL";

/** A session with one entry appended by `add`; returns the manager and that entry's id. */
function oneEntry(add: (manager: SessionManager) => string): { manager: SessionManager; id: string } {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Start.", timestamp: 1 });
	return { manager, id: add(manager) };
}
const assistantWith = (content: unknown[]) => ({ role: "assistant", content, api: "anthropic-messages", provider: "capture", model: "capture-model", usage: assistantToolCall(1).usage, stopReason: "toolUse", timestamp: 2 }) as never;
const call = (id: string) => ({ type: "toolCall", id, name: "browser_screenshot", arguments: { step: id } });

test("planHides control: a long tool result and a long plain text are hidden", () => {
	const result = oneEntry((m) => m.appendMessage({ role: "toolResult", toolCallId: "c", toolName: "t", content: [{ type: "text", text: BIG }], isError: false, timestamp: 2 }));
	assert.equal(planHides(result.manager.getBranch(), [result.id]).length, 1);
	const text = oneEntry((m) => m.appendMessage(fauxAssistantMessage(BIG)));
	assert.equal(planHides(text.manager.getBranch(), [text.id]).length, 1);
});

test("planHides leaves out an assistant entry with several tool calls", () => {
	const { manager, id } = oneEntry((m) => m.appendMessage(assistantWith([{ type: "text", text: BIG }, { ...call("a"), arguments: { blob: BIG } }, call("b")])));
	const messages = entryToCoreMessages(manager.getBranch().find((entry) => entry.id === id)!);
	assert.equal(messages.length, 2, "control: the engine reads one message per call");
	assert.ok(messages[0]!.text!.length > 4_000, "control: the first call message is long enough to be shortened");
	assert.deepEqual(planHides(manager.getBranch(), [id]), []);
});

test("planHides leaves out an assistant entry with one tool call, even with a long text", () => {
	const { manager, id } = oneEntry((m) => m.appendMessage(assistantWith([{ type: "text", text: BIG }, call("a")])));
	assert.deepEqual(planHides(manager.getBranch(), [id]), []);
});

test("planHides leaves out a text the kernel already shortened, and a text too short to shorten", () => {
	const shortened = oneEntry((m) => m.appendMessage(fauxAssistantMessage(BIG.slice(0, 3_000) + "\n...[truncated for context space] — original ~9000 tokens]...\n\n" + BIG.slice(-3_000))));
	assert.deepEqual(planHides(shortened.manager.getBranch(), [shortened.id]), []);
	const short = oneEntry((m) => m.appendMessage(fauxAssistantMessage("y".repeat(4_000))));
	assert.deepEqual(planHides(short.manager.getBranch(), [short.id]), [], "4000 characters is the most the kernel keeps whole");
	const over = oneEntry((m) => m.appendMessage(fauxAssistantMessage("y".repeat(4_001))));
	assert.equal(planHides(over.manager.getBranch(), [over.id]).length, 1);
});

test("planHides leaves out an entry Pi would not let a context edit change", () => {
	const { manager, id } = oneEntry((m) => m.appendMessage({ role: "custom", customType: "note", content: BIG, display: true, timestamp: 2 } as never));
	assert.equal(entryToCoreMessages(manager.getBranch().find((entry) => entry.id === id)!).length, 1, "control: the engine reads it as one long text");
	assert.deepEqual(planHides(manager.getBranch(), [id]), []);
});

test("wholeEntryIds keeps one id per whole entry and drops the per-call ids of a multi-call entry", () => {
	const message = (id: string) => ({ id, role: "tool", contentType: "tool-result", text: "t" }) as never;
	assert.deepEqual(wholeEntryIds([message("e1"), message("e1#c1"), message("e1#c2"), message("e2"), message("e1")]), ["e1", "e2"]);
});

test("a hide record with a number beyond a safe integer is ignored: the next hide is h1, never hInfinity", () => {
	const { manager, id } = oneEntry((m) => m.appendMessage(fauxAssistantMessage(BIG)));
	manager.appendCustomEntry(HIDE_ENTRY_TYPE, { version: 1, hideId: "h" + "9".repeat(400), targetId: "gone", originalTokens: 1, createdAt: 1 });
	manager.appendCustomEntry(HIDE_ENTRY_TYPE, { version: 1, hideId: "hInfinity", targetId: "gone", originalTokens: 1, createdAt: 1 });
	assert.deepEqual(hideRecordsOnBranch(manager.getBranch()), []);
	assert.deepEqual(planHides(manager.getBranch(), [id]).map((plan) => plan.hideId), ["h1"]);
});

test("at the largest hide number nothing more is hidden, since the next id would not read back", () => {
	const { manager, id } = oneEntry((m) => m.appendMessage(fauxAssistantMessage(BIG)));
	manager.appendCustomEntry(HIDE_ENTRY_TYPE, { version: 1, hideId: "h999999998", targetId: "gone", originalTokens: 1, createdAt: 1 });
	assert.deepEqual(planHides(manager.getBranch(), [id]).map((plan) => plan.hideId), ["h999999999"]);
	manager.appendCustomEntry(HIDE_ENTRY_TYPE, { version: 1, hideId: "h999999999", targetId: "gone", originalTokens: 1, createdAt: 1 });
	assert.deepEqual(planHides(manager.getBranch(), [id]), []);
});

test("a fold record with a block or run number beyond a safe integer is ignored: the next block is b1, never bInfinity", () => {
	const { manager } = hideSession();
	const ids = manager.getBranch().map((entry) => entry.id);
	const base = { version: 1, tier: 1, carrierId: ids[1]!, hiddenIds: [ids[2]!], range: { startId: ids[1]!, endId: ids[2]! }, refs: { start: "m00001", end: "m00002" }, directBlockIds: [], compressedTokens: 1, createdAt: 1, origin: "fold" };
	assert.ok(readFoldRecord({ ...base, blockId: "b7", runId: "r7" }), "control: the record shape is valid");
	manager.appendCustomEntry(FOLD_ENTRY_TYPE, { ...base, blockId: "b" + "9".repeat(400), runId: "r1" });
	manager.appendCustomEntry(FOLD_ENTRY_TYPE, { ...base, blockId: "b1", runId: "r" + "9".repeat(400) });
	const state = foldStateFromBranch(manager.getBranch());
	assert.equal(state.records.length, 0);
	assert.equal(state.kernel.nextBlockId, 1);
	assert.equal(state.kernel.nextRunId, 1);
});

