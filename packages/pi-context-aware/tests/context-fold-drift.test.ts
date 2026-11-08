import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { compile } from "@earendil-works/pi-schema";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { renderEarlierFoldCalls } from "../src/folds/fold-call-render.js";
import { contextFoldSchema, foldItems, runFold, type ContextFoldInput } from "../src/context-tools/context-fold.js";
import type { Config } from "../src/folds/kernel/index.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";

// pi-context-aware#287: context_fold reads a call whose arguments drifted from
// content: [{ startId, endId, summary }] through the kernel parser, and refuses an unreadable one
// with the expected shape.

const SUMMARY = "Summary of the opening exchanges: alpha and beta were settled between user and assistant.";
const NO_SIZE_GATE: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};
const SHAPE = "content: [{ startId, endId, summary }]";
const textOf = (result: { content: { type: "text"; text: string }[] }) => result.content.map((part) => part.text).join("\n");

function withEngine<T>(run: (engine: FoldEngine, ctx: ExtensionContext) => T): T {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-drift-")));
	try {
		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: "QUESTION-" + i + " " + "q".repeat(2_000), timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("ANSWER-" + i + " " + "a".repeat(2_000)));
		}
		const pi = { on: () => undefined, getAllTools: () => [] } as unknown as ExtensionAPI;
		const engine = registerFoldEngine(pi, { config: NO_SIZE_GATE });
		const ctx = { cwd: manager.getCwd(), sessionManager: manager, model: undefined } as unknown as ExtensionContext;
		return run(engine, ctx);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const run = (call: Record<string, unknown>) => withEngine((engine, ctx) => {
	const result = runFold(engine, ctx, "call_287", call as ContextFoldInput);
	return { result, text: textOf(result), pending: engine.pending(ctx) };
});

test("#287: the schema accepts the observed call, ranges as a JSON string with from/to bounds", () => {
	const observed = { ranges: JSON.stringify([{ from: "m00043", to: "m00043", topic: "T", summary: "S" }]) };
	const validator = compile(contextFoldSchema);
	assert.equal(validator.check(observed), true);
	assert.equal(validator.check({ ranges: [{ from: "m00001", to: "m00002", summary: "S" }] }), true);
	assert.equal(validator.check({ content: [{ startId: "m00001", endId: "m00002", summary: "S" }] }), true);
	assert.equal(validator.check({}), true, "a call with no ranges reaches the tool, which names the shape");
});

test("#287: the observed call is read as one range", () => {
	const items = foldItems({ ranges: JSON.stringify([{ from: "m00043", to: "m00043", topic: "T", summary: "S" }]) });
	assert.deepEqual(items, [{ startRef: "m00043", endRef: "m00043", summary: "S", topic: "T" }]);
});

test("#287: the observed call folds", () => {
	const { text, pending, result } = run({ ranges: JSON.stringify([{ from: "m00002", to: "m00003", topic: "Opening", summary: SUMMARY }]) });
	assert.equal(result.isError, false, text);
	assert.match(text, /range 1 \(m00002\.\.m00003\) accepted/u);
	assert.equal(pending, 1);
});

test("#287: ranges as an array folds", () => {
	const { text, pending, result } = run({ ranges: [{ startId: "m00002", endId: "m00003", summary: SUMMARY }, { from: "m00004", to: "m00005", summary: SUMMARY }] });
	assert.equal(result.isError, false, text);
	assert.match(text, /range 1 \(m00002\.\.m00003\) accepted/u);
	assert.match(text, /range 2 \(m00004\.\.m00005\) accepted/u);
	assert.equal(pending, 2);
});

test("#287: from/to inside content folds, as do startRef/endRef and a nested ranges array", () => {
	for (const call of [
		{ content: [{ from: "m00002", to: "m00003", summary: SUMMARY }] },
		{ content: JSON.stringify([{ from: "m00002", to: "m00003", summary: SUMMARY }]) },
		{ content: [{ startRef: "m00002", endRef: "m00003", summary: SUMMARY }] },
		{ content: { ranges: [{ from: "m00002", to: "m00003", summary: SUMMARY }] } },
	]) {
		const { text, pending, result } = run(call);
		assert.equal(result.isError, false, JSON.stringify(call) + ": " + text);
		assert.equal(pending, 1, JSON.stringify(call));
	}
});

test("#287: startId/endId still win over from/to, and the top-level topic is the fallback", () => {
	assert.deepEqual(foldItems({ topic: "Top", content: [{ startId: "m00001", endId: "m00002", from: "m00009", to: "m00010", summary: "S" }] }), [{ startRef: "m00001", endRef: "m00002", summary: "S", topic: "Top" }]);
});

test("#287: a call with neither content nor ranges is refused with the expected shape", () => {
	for (const call of [{}, { topic: "only a topic" }, { ranges: "not json at all" }, { content: [{ from: "m00002", summary: SUMMARY }] }, { ranges: 7 }]) {
		const { text, pending, result } = run(call);
		assert.equal(result.isError, true, JSON.stringify(call));
		assert.ok(text.includes(SHAPE), JSON.stringify(call) + ": " + text);
		assert.equal(pending, 0);
	}
});

test("#287: an entry that is not a range is skipped, and the others fold", () => {
	const { text, pending, result } = run({ ranges: [{ summary: "no bounds" }, { from: "m00002", to: "m00003", summary: SUMMARY }] });
	assert.equal(result.isError, false, text);
	assert.match(text, /range 1: missing range bounds.*; skipped\./u);
	assert.match(text, /range 2 \(m00002\.\.m00003\) accepted/u);
	assert.equal(pending, 1);
});

// pi-context-aware#289: from/to bounds are read from a ranges string the kernel parser repairs.
const repaired = (a: string, b: string) => [
	{ ranges: `[{"${a}":"m00002","${b}":"m00003","summary":"S",}]` },
	{ ranges: JSON.stringify(JSON.stringify([{ [a]: "m00002", [b]: "m00003", summary: "S" }])) },
	{ ranges: `[{"${a}":"m00002","${b}":"m00003","summary":"S"},{"${a}":"m00004","${b}":"m00005","summ` },
];

test("#289: from/to read the same as startId/endId in a repaired ranges string", () => {
	const named = repaired("startId", "endId");
	repaired("from", "to").forEach((call, index) => {
		const items = foldItems(call);
		assert.ok(Array.isArray(items), index + ": " + String(items));
		assert.equal(items[0]?.startRef, "m00002", String(index));
		assert.deepEqual(items, foldItems(named[index]!), String(index));
	});
});

test("#289: a repaired string with from/to folds", () => {
	const { text, pending, result } = run({ ranges: `[{"from":"m00002","to":"m00003","summary":"${SUMMARY}",}]` });
	assert.equal(result.isError, false, text);
	assert.equal(pending, 1);
});

test("#289: a summary that mentions \"from\" is kept, and extra fields are not passed on", () => {
	const items = foldItems({ ranges: '[{"from":"m00002","to":"m00003","summary":"read from: x","evil":"y",}]' });
	assert.deepEqual(items, [{ startRef: "m00002", endRef: "m00003", summary: "read from: x" }]);
	assert.deepEqual(Object.keys((items as Record<string, unknown>[])[0]!), ["startRef", "endRef", "summary"]);
});

test("#289: in a repaired string a named startId/endId wins over from/to, in either key order", () => {
	const strict = foldItems({ ranges: [{ startId: "m00001", endId: "m00009", from: "m00002", to: "m00003", summary: "S" }] });
	for (const text of [
		'[{"startId":"m00001","endId":"m00009","from":"m00002","to":"m00003","summary":"S",}]',
		'[{"from":"m00002","to":"m00003","startId":"m00001","endId":"m00009","summary":"S",}]',
	]) {
		const items = foldItems({ ranges: text });
		assert.ok(Array.isArray(items), text);
		assert.equal(items[0]?.startRef, "m00001", text);
		assert.equal(items[0]?.endRef, "m00009", text);
	}
	assert.ok(Array.isArray(strict));
	const mixed = foldItems({ ranges: '[{"messageId":"m00004","from":"m00002","to":"m00003","summary":"S",}]' });
	assert.ok(Array.isArray(mixed));
	assert.equal(mixed[0]?.startRef, "m00004");
});

test("#289: a quoted from/to key inside a repaired summary is kept", () => {
	const items = foldItems({ ranges: '[{"from":"m00002","to":"m00003","summary":"see \'from\': x and \\"to\\": y","evil":1,}]' });
	assert.ok(Array.isArray(items));
	assert.equal(items[0]?.summary, 'see \'from\': x and "to": y');
	assert.equal(items[0]?.startRef, "m00002");
});

const RANGE = { startId: "m00001", endId: "m00002", summary: "S" };
const OTHER = { startId: "m00003", endId: "m00004", summary: "O" };
const asItem = (r: { startId: string; endId: string; summary: string }) => ({ startRef: r.startId, endRef: r.endId, summary: r.summary });

test("#290: the first non-empty of content and ranges is folded, whichever key comes first", () => {
	for (const empty of [[], null, "", "  "]) {
		assert.deepEqual(foldItems({ content: empty, ranges: [RANGE] }), [asItem(RANGE)], JSON.stringify(empty));
		assert.deepEqual(foldItems({ ranges: [RANGE], content: empty }), [asItem(RANGE)], JSON.stringify(empty));
	}
	assert.deepEqual(foldItems({ content: [RANGE], ranges: [OTHER] }), [asItem(RANGE)], "content still wins when both have entries");
	assert.deepEqual(foldItems({ ranges: [OTHER], content: [RANGE] }), [asItem(RANGE)]);
});

test("#290: empty calls keep their messages", () => {
	assert.equal(foldItems({ content: [] }), "No ranges provided.");
	assert.equal(foldItems({ content: [], ranges: [] }), "No ranges provided.");
	assert.match(String(foldItems({ ranges: null })), /^No ranges given./u);
	assert.match(String(foldItems({ content: null })), /^No ranges given./u);
	assert.equal(foldItems({ ranges: [] }), "No ranges provided.");
});

test("#290: the tool and the call renderer read the same key", () => {
	const rec = { version: 1, blockId: "b1", runId: "r", tier: 1, carrierId: "x", hiddenIds: [], range: { startId: "x", endId: "x" }, refs: { start: "m00001", end: "m00002" }, directBlockIds: [], compressedTokens: 1, createdAt: 0, origin: "fold", requestId: "c1#0" } as never;
	for (const args of [{ content: [], ranges: [{ ...RANGE }] }, { ranges: [{ ...RANGE }], content: [] }, { content: null, ranges: [{ ...RANGE }] }]) {
		const rendered = renderEarlierFoldCalls([fauxAssistantMessage(fauxToolCall("fold", args, { id: "c1" }), { stopReason: "toolUse" })] as never, [rec]);
		const part = (rendered[0] as { content: { arguments: Record<string, unknown> }[] }).content[0]!;
		assert.deepEqual(foldItems(args), [asItem(RANGE)]);
		assert.match(String((part.arguments.ranges as { summary: string }[])[0]!.summary), /^summary kept in block b1/u, JSON.stringify(args));
		assert.deepEqual(part.arguments.content, args.content, "the empty key is untouched");
	}
});

test("#362: an unreadable call names each failing item and the parser's reason", () => {
	const one = run({ content: [{ startId: "m00005", summary: "x" }] });
	assert.equal(one.result.isError, true);
	assert.match(one.text, /item 1: missing range bounds/u);
	assert.match(one.text, /Expected /u);
	const two = run({ content: [{ startId: "m00005", endId: "m00006" }, "nope"] });
	assert.match(two.text, /item 1: missing summary/u);
	assert.match(two.text, /item 2: /u);
});

test("#362: a skipped item in a partly accepted call gives its reason", () => {
	const { result, text } = run({ content: [{ startId: "m00001", endId: "m00002", summary: SUMMARY }, { startId: "m00003", endId: "m00004" }] });
	assert.notEqual(result.isError, true);
	assert.match(text, /range 2: missing summary; skipped\./u);
});

test("#362: content given as a JSON string of an object that wraps the array under content is read", () => {
	const item = { startId: "m00005", endId: "m00009", summary: "s" };
	assert.deepEqual(foldItems({ content: JSON.stringify({ content: [item] }) }), [{ startRef: "m00005", endRef: "m00009", summary: "s" }]);
});

