/**
 * The frozen view a context strategy reads (pi-context-aware#467, REQ-STRAT-001 and REQ-STRAT-009).
 * Expected values come from the session each test builds or from the recorded fixture, never from the builder.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { createFoldHints, MAX_VERBATIM_CHARS } from "../src/folds/fold-hints.js";
import { planHides } from "../src/folds/hide-entries.js";
import { defaultCountTokens, type Config } from "../src/folds/kernel/index.js";
import { buildContextView, requestPressure, type ContextViewInput } from "../src/strategy-runtime/index.js";
import { assistantToolCall } from "./provider-payloads.js";

const IMAGE_TOKENS = 1_600;
const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };

function inputOf(manager: SessionManager, over: Partial<ContextViewInput> = {}): ContextViewInput {
	return {
		branch: manager.getBranch(),
		contextEntries: manager.buildContextEntries(),
		projection: manager.buildSessionProjection(),
		model: { id: "test-model", contextWindow: 200_000 },
		tokens: 50_000,
		reachableTools: ["context_recall", "context_fold"],
		registeredTools: ["bash", "context_fold", "context_recall"],
		config: CONFIG,
		now: 10_000,
		compactionOwner: "none",
		...over,
	};
}

function recorded(name: string): SessionManager {
	const file = path.resolve("tests/fixtures/real-sessions", name);
	const entries = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as FileEntry);
	return SessionManager.inMemory("/tmp", undefined, entries);
}

test("a view of a recorded session lists each model-visible entry with its id, role and token count, and the prompt-cache age", () => {
	// The last assistant message of context-aware-0.8.0.jsonl was written at 1794448383931.
	const view = buildContextView(inputOf(recorded("context-aware-0.8.0.jsonl"), { tokens: 250_000, model: { id: "claude", contextWindow: 1_000_000 }, now: 1794448383931 + 60_000 }));
	assert.deepEqual(view.entries.map((entry) => [entry.id, entry.role]), [
		["864d8f63", "user"],
		["08f7c925", "custom"],
		["2d215f28", "assistant"],
		["e4f4ef1d", "toolResult"],
		["d775b885", "assistant"],
		["1c224ffb", "toolResult"],
		["b7d26691", "assistant"],
		["182f1121", "toolResult"],
		["861fe8ea", "assistant"],
		["d5e37f11", "toolResult"],
		["41e131a5", "assistant"],
		["90dd3531", "custom"],
		["76c46fc6", "custom"],
		["5cbf29ba", "assistant"],
	], "state-only entries (model change, custom records, session info) are not in the request");
	const byId = new Map(view.entries.map((entry) => [entry.id, entry]));
	// The text of entry 182f1121 and of entry 41e131a5 in the fixture.
	assert.equal(byId.get("182f1121")?.tokens, defaultCountTokens("1/3 done\n☑ t1  Merge the parser\n▸ t2  Test the rollback script\n☐ t3  Pick the release date"));
	assert.equal(byId.get("41e131a5")?.tokens, defaultCountTokens("done"));
	assert.equal(byId.get("5cbf29ba")?.tokens, 0, "an assistant message with no content has no tokens");
	assert.equal(byId.get("182f1121")?.toolName, "session_tasks");
	assert.equal(byId.get("182f1121")?.toolCallId, "toolu_01DduYPYe1ucmiE7qcxDkoG8");
	assert.deepEqual(byId.get("b7d26691")?.toolCallIds, ["toolu_01DduYPYe1ucmiE7qcxDkoG8"]);
	assert.equal(view.cacheAgeMs, 60_000);
	assert.equal(view.pressure, 0.25);
	assert.deepEqual(view.model, { id: "claude", contextWindow: 1_000_000 });
});

test("the view carries one pressure value, the token count over the window, from requestPressure", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Hello.", timestamp: 1 });
	const view = buildContextView(inputOf(manager, { tokens: 123_456, model: { id: "m", contextWindow: 200_000 } }));
	assert.equal(view.pressure, 0.61728);
	assert.equal(requestPressure(123_456, 200_000), 0.61728);
	assert.deepEqual(Object.keys(view).sort(), ["cacheAgeMs", "compactionOwner", "entries", "folds", "hides", "model", "pressure", "protectedEntryIds", "registeredTools", "tools", "unownedTokens"], "no second measure of fullness");
	assert.equal(buildContextView(inputOf(manager, { tokens: 0 })).pressure, 0);
	for (const [tokens, window] of [[1, 0], [1, -5], [1, Number.NaN], [-1, 100], [Number.POSITIVE_INFINITY, 100]] as const) {
		assert.throws(() => buildContextView(inputOf(manager, { tokens, model: { id: "m", contextWindow: window } })), RangeError, `${tokens} over ${window}`);
	}
});

test("the view lists reachable tools and every registered tool once each, sorted, and has no cache age before the first assistant message", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Hello.", timestamp: 1 });
	const view = buildContextView(inputOf(manager, { reachableTools: ["context_status", "context_fold", "context_status", ""], registeredTools: ["read", "context_fold", "bash", "read", "", "mcp__github__create_issue"] }));
	assert.deepEqual(view.tools, ["context_fold", "context_status"]);
	assert.deepEqual(view.registeredTools, ["bash", "context_fold", "context_status", "mcp__github__create_issue", "read"], "registered tools the session cannot call stay listed, and a reachable tool counts as registered");
	assert.equal(view.cacheAgeMs, null);
});

/** Ten entries: an opening, a call pair folded later, a long tool result hidden later, and a verbatim-hinted pair. */
function foldedSession() {
	const manager = SessionManager.inMemory("/tmp");
	const opening = manager.appendMessage({ role: "user", content: "Open the log and summarise it.", timestamp: 1 });
	const call1 = manager.appendMessage(assistantToolCall(1));
	const result1 = manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "browser_screenshot", content: [{ type: "text", text: "first screenshot" }], isError: false, timestamp: 2 });
	const note1 = manager.appendMessage(fauxAssistantMessage("The first screenshot shows the login page."));
	const ask = manager.appendMessage({ role: "user", content: "Now read the log.", timestamp: 3 });
	const call2 = manager.appendMessage(assistantToolCall(2));
	const long = "HEAD\n" + "x".repeat(10_000) + "\nTAIL";
	const result2 = manager.appendMessage({ role: "toolResult", toolCallId: "call_2", toolName: "browser_screenshot", content: [{ type: "text", text: long }], isError: false, timestamp: 4 });
	const notesCall = manager.appendMessage(fauxAssistantMessage(fauxToolCall("notes_tool", { topic: "log" }, { id: "call_n" }), { stopReason: "toolUse" }));
	const notesResult = manager.appendMessage({ role: "toolResult", toolCallId: "call_n", toolName: "notes_tool", content: [{ type: "text", text: "noted" }], isError: false, timestamp: 5 });
	const last = manager.appendMessage(fauxAssistantMessage("The log ends cleanly."));
	return { manager, long, ids: { opening, call1, result1, note1, ask, call2, result2, notesCall, notesResult, last } };
}

test("the view reports active folds and hides, fold hints, and the entries no plan may change", () => {
	const { manager, long, ids } = foldedSession();
	// Refs follow message order: m00002 is the first call, m00004 the note after its result.
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00002", endRef: "m00004", summary: "Summary: the first screenshot showed the login page.", modelContextLimit: 200_000, config: CONFIG });
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
	const hides = planHides(manager.getBranch(), [ids.result2]);
	assert.equal(hides.length, 1, "control: the long result can be hidden");
	applyFoldDrafts(manager, hides[0]!.drafts);
	const hints = createFoldHints();
	assert.deepEqual(hints.register({ ownerKey: "test", match: { toolName: "notes_tool" }, policy: "verbatim" }), { ok: true, replaced: false });

	const view = buildContextView(inputOf(manager, { hints }));
	assert.equal(view.folds.length, 1);
	const [fold] = view.folds;
	assert.equal(fold!.blockId, "b1");
	assert.equal(fold!.startId, ids.call1);
	assert.equal(fold!.endId, ids.note1);
	assert.ok([ids.call1, ids.result1, ids.note1].includes(fold!.carrierId));
	const visible = view.entries.map((entry) => entry.id);
	for (const hidden of fold!.hiddenIds) assert.ok(!visible.includes(hidden), `${hidden} is folded away`);

	assert.deepEqual(view.hides, [{ hideId: "h1", targetId: ids.result2, originalTokens: defaultCountTokens(long) }]);
	const hidden = view.entries.find((entry) => entry.id === ids.result2);
	assert.ok(hidden && hidden.tokens < defaultCountTokens(long) / 2, "the hidden entry is counted at the size the model sees");

	const hintOf = (id: string) => view.entries.find((entry) => entry.id === id)?.hint;
	assert.equal(hintOf(ids.notesResult), "verbatim");
	assert.equal(hintOf(ids.notesCall), "verbatim");
	assert.equal(hintOf(ids.ask), null);
	// The opening user message is kept by the default fold policy; the protected zone holds the last two
	// messages (preserveRecentMessages: 2) and the last user message; the notes pair is kept by its verbatim hint.
	assert.deepEqual(view.protectedEntryIds, [ids.opening, ids.ask, ids.notesCall, ids.notesResult, ids.last]);
});

test("the opening user message is not protected when the fold policy folds it", () => {
	const { manager, ids } = foldedSession();
	const view = buildContextView(inputOf(manager, { folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 0, condensedSkills: false } as unknown as NonNullable<ContextViewInput["folds"]> }));
	assert.ok(!view.protectedEntryIds.includes(ids.opening));
	assert.ok(view.protectedEntryIds.includes(ids.last));
});

/** Every object and array reachable from `value`, and every function. */
function walk(value: unknown, objects: Set<object> = new Set(), functions: string[] = [], at = "view"): { objects: Set<object>; functions: string[] } {
	if (typeof value === "function") functions.push(at);
	if ((typeof value !== "object" && typeof value !== "function") || value === null || objects.has(value)) return { objects, functions };
	objects.add(value);
	for (const key of Reflect.ownKeys(value)) walk((value as Record<PropertyKey, unknown>)[key], objects, functions, `${at}.${String(key)}`);
	return { objects, functions };
}

test("the view is deep-frozen: no nested field can be changed", () => {
	const { manager, ids } = foldedSession();
	const hints = createFoldHints();
	hints.register({ ownerKey: "test", match: { toolName: "notes_tool" }, policy: "verbatim" });
	const view = buildContextView(inputOf(manager, { hints }));
	const { objects } = walk(view);
	assert.ok(objects.size > 10, "control: the walk reaches the nested entries");
	for (const object of objects) assert.ok(Object.isFrozen(object), `frozen: ${JSON.stringify(object).slice(0, 80)}`);

	const entry = view.entries.find((candidate) => candidate.id === ids.call2)!;
	const writable = view as unknown as Record<string, unknown> & { entries: unknown[]; tools: unknown[]; model: Record<string, unknown>; protectedEntryIds: unknown[] };
	assert.throws(() => { writable.pressure = 0; }, TypeError);
	assert.throws(() => { writable.entries.push({ id: "forged" }); }, TypeError);
	assert.throws(() => { writable.entries.length = 0; }, TypeError);
	assert.throws(() => { (entry as unknown as Record<string, unknown>).tokens = 0; }, TypeError);
	assert.throws(() => { ((entry.toolCallIds ?? []) as unknown as unknown[])[0] = "forged"; }, TypeError);
	assert.throws(() => { writable.model.contextWindow = 1; }, TypeError);
	assert.throws(() => { writable.tools.push("bash"); }, TypeError);
	assert.throws(() => { (writable.registeredTools as unknown[]).pop(); }, TypeError);
	assert.throws(() => { writable.protectedEntryIds.pop(); }, TypeError);
	assert.throws(() => { delete (writable as Record<string, unknown>).hides; }, TypeError);
	assert.equal(view.pressure, 0.25);
	assert.equal(view.model.contextWindow, 200_000);
});

test("a strategy cannot reach the session through the view: no functions, and no object shared with the input", () => {
	const { manager } = foldedSession();
	const hints = createFoldHints();
	hints.register({ ownerKey: "test", match: { toolName: "notes_tool" }, policy: "verbatim" });
	const input = inputOf(manager, { hints });
	const tools = [...input.reachableTools];
	const registered = [...input.registeredTools];
	const view = buildContextView({ ...input, reachableTools: tools, registeredTools: registered });
	const { objects, functions } = walk(view);
	assert.deepEqual(functions, [], "no function-valued field anywhere in the view");
	const inputObjects = walk({ input: { ...input, reachableTools: tools, registeredTools: registered }, manager }).objects;
	for (const object of objects) assert.ok(!inputObjects.has(object), `the view holds its own copy, not an input object: ${JSON.stringify(object).slice(0, 80)}`);
	assert.ok(inputObjects.size > objects.size, "control: the input walk reaches the session manager and its entries");
	tools.push("bash");
	registered.push("write");
	assert.deepEqual(view.tools, ["context_fold", "context_recall"], "changing the input afterwards does not change the view");
	assert.deepEqual(view.registeredTools, ["bash", "context_fold", "context_recall"]);
});

test("a hint the oversized-pair rule drops is not in the view: every hint kind resolves as planFold resolves it", () => {
	/** One assistant entry calls a verbatim tool and a one-line tool; the verbatim result is `size` characters. */
	const pair = (size: number) => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage({ role: "user", content: "Read both.", timestamp: 1 });
		const call = manager.appendMessage(fauxAssistantMessage([
			fauxToolCall("keep_tool", { what: "trace" }, { id: "call_keep" }),
			fauxToolCall("line_tool", { what: "status" }, { id: "call_line" }),
		], { stopReason: "toolUse" }));
		const kept = manager.appendMessage({ role: "toolResult", toolCallId: "call_keep", toolName: "keep_tool", content: [{ type: "text", text: "k".repeat(size) }], isError: false, timestamp: 2 });
		const lined = manager.appendMessage({ role: "toolResult", toolCallId: "call_line", toolName: "line_tool", content: [{ type: "text", text: "status ok" }], isError: false, timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("Both read."));
		const hints = createFoldHints();
		assert.deepEqual(hints.register({ ownerKey: "test", match: { toolName: "keep_tool" }, policy: "verbatim" }), { ok: true, replaced: false });
		assert.deepEqual(hints.register({ ownerKey: "test", match: { toolName: "line_tool" }, policy: "one-line", line: "status checked" }), { ok: true, replaced: false });
		const view = buildContextView(inputOf(manager, { hints }));
		const hintOf = (id: string) => view.entries.find((entry) => entry.id === id)?.hint;
		return { call: hintOf(call), kept: hintOf(kept), lined: hintOf(lined) };
	};
	assert.deepEqual(pair(100), { call: "verbatim", kept: "verbatim", lined: "one-line" }, "control: a small verbatim pair keeps every hint");
	// The verbatim result is over MAX_VERBATIM_CHARS, so planFold folds the whole pair: the call's
	// hint and the hints of every result it pairs with go, the one-line result's included.
	assert.deepEqual(pair(MAX_VERBATIM_CHARS + 1), { call: null, kept: null, lined: null });
});

test("entry tokens count image parts with the fold pass's estimate, and with unownedTokens they add up to the request's token count", () => {
	const manager = SessionManager.inMemory("/tmp");
	const text = "Here is the screen.";
	const shot = manager.appendMessage({ role: "user", content: [{ type: "text", text }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("I see two screenshots."));
	const view = buildContextView(inputOf(manager, { tokens: 50_000 }));
	const entry = view.entries.find((candidate) => candidate.id === shot)!;
	// 1600 tokens is the fold pass's fixed estimate per image part (IMAGE_TOKEN_COST, src/folds/fold-turn.ts).
	assert.equal(entry.tokens, defaultCountTokens(text) + 2 * IMAGE_TOKENS);
	const owned = view.entries.reduce((sum, candidate) => sum + candidate.tokens, 0);
	assert.equal(owned + view.unownedTokens, 50_000);
	assert.equal(view.unownedTokens, 50_000 - defaultCountTokens(text) - 2 * IMAGE_TOKENS - defaultCountTokens("I see two screenshots."));
	assert.equal(owned + view.unownedTokens, view.pressure * view.model.contextWindow);
});

test("the view names who holds the compaction claim: the value given, and a RangeError when it is left out or is anything else", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Hello.", timestamp: 1 });
	assert.equal(buildContextView(inputOf(manager)).compactionOwner, "none");
	const { compactionOwner: _left, ...withoutOwner } = inputOf(manager);
	assert.throws(() => buildContextView(withoutOwner as ContextViewInput), RangeError, "a caller that leaves the claim out is refused, not read as none");
	assert.equal(buildContextView(inputOf(manager, { compactionOwner: "self" })).compactionOwner, "self");
	assert.equal(buildContextView(inputOf(manager, { compactionOwner: "other" })).compactionOwner, "other");
	for (const owner of ["fabric", "", 1, { toString: () => "self" }]) {
		assert.throws(() => buildContextView(inputOf(manager, { compactionOwner: owner as unknown as ContextViewInput["compactionOwner"] })), RangeError, String(owner));
	}
	assert.throws(() => buildContextView(inputOf(manager, { compactionOwner: "other\u001b[2Jself" as unknown as ContextViewInput["compactionOwner"] })), (error: unknown) =>
		error instanceof RangeError && !error.message.includes("\u001b") && error.message.includes("other?[2Jself"), "control characters do not reach the message");
});
