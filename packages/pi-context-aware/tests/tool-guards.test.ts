import test from "node:test";
import assert from "node:assert/strict";
import {
	REPETITION_WARN_AT,
	TOOL_OUTPUT_CAP_MARKER,
	canonicalInput,
	capToolOutput,
	createRepetitionTracker,
	headBytes,
	shouldCapToolResult,
} from "../src/guards/tool-guards.js";
import { DEFAULT_TOOL_OUTPUT_CAP_CONFIG } from "../src/platform/config-layers.js";
import { isNestedToolCallId } from "../src/skills/skill-registry.js";
import { sanitizeSummary, decodeUnicodeEscapes, UNESCAPE_THRESHOLD } from "../src/folds/summary-sanitize.js";

// pi-context-aware#255: native tool-output cap, warn-only repetition guard, summary decode.

const text = (value: string) => [{ type: "text" as const, text: value }];
const bytesOf = (parts: Array<{ type: string; text?: string }>) =>
	parts.reduce((sum, part) => sum + (part.text === undefined ? 0 : Buffer.byteLength(part.text, "utf8")), 0);

test("cap: 49,999 and 50,000 bytes pass, 50,001 is capped at the default", () => {
	const max = DEFAULT_TOOL_OUTPUT_CAP_CONFIG.maxBytes;
	assert.equal(max, 50_000);
	assert.equal(capToolOutput(text("a".repeat(49_999)), max).capped, false);
	assert.equal(capToolOutput(text("a".repeat(50_000)), max).capped, false);
	const over = capToolOutput(text("a".repeat(50_001)), max);
	assert.equal(over.capped, true);
	assert.equal((over.content[0] as { text: string }).text.length, 50_000);
	assert.match((over.content.at(-1) as { text: string }).text, new RegExp(TOOL_OUTPUT_CAP_MARKER.replace("[", "\\[")));
});

test("cap: maxBytes moves behaviour; 0 leaves everything untouched", () => {
	assert.equal(capToolOutput(text("a".repeat(1_001)), 1_000).capped, true);
	assert.equal(capToolOutput(text("a".repeat(1_000)), 1_000).capped, false);
	assert.equal(capToolOutput(text("a".repeat(500_000)), 0).capped, false);
});

test("cap: a multi-byte character straddling the cut is not split, and bytes are counted", () => {
	const three = "\u4e2d".repeat(10); // 3 bytes each, 30 bytes
	assert.equal(headBytes(three, 31), three);
	assert.equal(headBytes(three, 10), "\u4e2d".repeat(3)); // 9 bytes, never 10
	const out = capToolOutput(text(three), 10);
	assert.equal(out.capped, true);
	const kept = (out.content[0] as { text: string }).text;
	assert.equal(kept, "\u4e2d".repeat(3));
	assert.ok(!kept.includes("\ufffd"));
	// 20 three-byte characters are 60 bytes: over a 50-byte cap although only 20 characters long.
	assert.equal(capToolOutput(text("\u4e2d".repeat(20)), 50).capped, true);
});

test("cap: images pass through, the notice is appended once, a prior notice or Pi truncation is respected", () => {
	const image = { type: "image", data: "xx", mimeType: "image/png" };
	const mixed = capToolOutput([image, ...text("a".repeat(2_000))], 1_000);
	assert.equal(mixed.content[0], image);
	assert.equal(mixed.content.filter((part) => (part as { text?: string }).text?.includes(TOOL_OUTPUT_CAP_MARKER)).length, 1);
	assert.equal(bytesOf(mixed.content.slice(0, 2)), 1_000);
	const again = capToolOutput(mixed.content, 100);
	assert.equal(again.capped, false, "a result that already carries the notice is not capped twice");
	assert.equal(capToolOutput(text("a".repeat(2_000)), 1_000, { alreadyTruncated: true }).capped, false);
});

test("cap: skipTools moves behaviour, load_skill comes back whole by default, nested ids are never touched", () => {
	const base = { toolCallId: "call_1" };
	assert.equal(shouldCapToolResult(DEFAULT_TOOL_OUTPUT_CAP_CONFIG, { ...base, toolName: "load_skill" }), false);
	assert.equal(shouldCapToolResult(DEFAULT_TOOL_OUTPUT_CAP_CONFIG, { ...base, toolName: "fabric_exec" }), false);
	assert.equal(shouldCapToolResult(DEFAULT_TOOL_OUTPUT_CAP_CONFIG, { ...base, toolName: "mcp_big" }), true);
	assert.equal(shouldCapToolResult({ maxBytes: 50_000, skipTools: [] }, { ...base, toolName: "load_skill" }), true);
	assert.equal(shouldCapToolResult({ maxBytes: 0, skipTools: [] }, { ...base, toolName: "mcp_big" }), false);
	for (const id of ["fabric_abc", "jev:1:2", "component:x:1", "call_1/2"]) {
		assert.equal(shouldCapToolResult({ maxBytes: 10, skipTools: [] }, { toolCallId: id, toolName: "mcp_big" }), false, id);
	}
	assert.equal(shouldCapToolResult({ maxBytes: 10, skipTools: [] }, { ...base, toolName: "mcp_big", parentToolCallId: "p" }), false);
});

test("nested ids: component: is nested", () => {
	assert.equal(isNestedToolCallId("component:abc:1"), true);
	assert.equal(isNestedToolCallId("fabric_1"), true);
	assert.equal(isNestedToolCallId("jev:1:1"), true);
	assert.equal(isNestedToolCallId("p/1"), true);
	assert.equal(isNestedToolCallId("toolu_01"), false);
});

test("repetition: counts identical consecutive direct calls and reports the run", () => {
	const tracker = createRepetitionTracker();
	const call = (id: string, input: unknown = { path: "a" }, toolName = "read") => tracker.note({ toolCallId: id, toolName, input });
	assert.deepEqual([call("c1"), call("c2"), call("c3"), call("c4")], [1, 2, REPETITION_WARN_AT, 4]);
	assert.equal(REPETITION_WARN_AT, 3);
});

test("repetition: key order does not hide a repeat; a changed argument or other tool resets", () => {
	assert.equal(canonicalInput({ a: 1, b: { c: 2, d: 3 } }), canonicalInput({ b: { d: 3, c: 2 }, a: 1 }));
	const tracker = createRepetitionTracker();
	const note = (id: string, input: unknown, toolName = "bash") => tracker.note({ toolCallId: id, toolName, input });
	assert.equal(note("1", { cmd: "ls" }), 1);
	assert.equal(note("2", { cmd: "ls" }), 2);
	assert.equal(note("3", { cmd: "pwd" }), 1, "changed argument resets");
	assert.equal(note("4", { cmd: "pwd" }), 2);
	assert.equal(note("5", { cmd: "pwd" }, "read"), 1, "different tool resets");
});

test("repetition: nested calls are never counted and do not break a direct run", () => {
	const tracker = createRepetitionTracker();
	const direct = () => tracker.note({ toolCallId: "toolu_1", toolName: "fabric_exec", input: { code: "x" } });
	assert.equal(direct(), 1);
	for (const id of ["fabric_u1", "jev:1:1", "component:x:1", "toolu_1/1"]) {
		for (let i = 0; i < 20; i++) assert.equal(tracker.note({ toolCallId: id, toolName: "read", input: { path: "a" } }), 0, id);
	}
	assert.equal(tracker.note({ toolCallId: "p1", parentToolCallId: "toolu_1", toolName: "read", input: {} }), 0);
	assert.equal(direct(), 2, "nested calls neither count nor reset the model's own run");
});

test("repetition: user input resets the count", () => {
	const tracker = createRepetitionTracker();
	const note = (id: string) => tracker.note({ toolCallId: id, toolName: "read", input: { p: 1 } });
	note("1"); note("2");
	tracker.reset();
	assert.equal(note("3"), 1);
});

test("summary: more than 20 \\uXXXX escapes are decoded, surrogate pairs included; few are left alone", () => {
	const many = "\\u5408".repeat(UNESCAPE_THRESHOLD + 1);
	const decoded = sanitizeSummary(many);
	assert.equal(decoded.unescaped, true);
	assert.equal(decoded.text, "\u5408".repeat(UNESCAPE_THRESHOLD + 1));
	const few = "example \\u5408 and \\u0041";
	assert.deepEqual(sanitizeSummary(few), { text: few, unescaped: false });
	assert.equal(sanitizeSummary("\\u5408".repeat(UNESCAPE_THRESHOLD)).unescaped, false, "exactly at the threshold is left alone");
	assert.equal(decodeUnicodeEscapes("\\ud83d\\ude00 \\n \\\\ \\uzzzz"), "\u{1F600} \\n \\\\ \\uzzzz");
});

test("planFold decodes a double-escaped summary before it is stored", async () => {
	const { planFold } = await import("../src/folds/fold-adapter.js");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const manager = SessionManager.inMemory("/tmp");
	for (const [i, name] of ["ALPHA", "BETA", "GAMMA"].entries()) {
		manager.appendMessage({ role: "user", content: name + "-QUESTION " + i, timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(name + "-ANSWER " + i));
	}
	const escaped = "\\u5408".repeat(UNESCAPE_THRESHOLD + 1) + " decided and recorded in full for later readers of this summary.";
	const result = planFold({
		branch: manager.getBranch(), startRef: "m00001", endRef: "m00004", summary: escaped, modelContextLimit: 64_000,
		config: { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 50 }, preserveRecentMessages: 2, preserveRecentTokens: 0 },
	});
	assert.ok(result.ok, JSON.stringify(result));
	const stored = JSON.stringify(result);
	assert.ok(stored.includes("\u5408".repeat(UNESCAPE_THRESHOLD + 1)), "decoded text is stored");
	assert.ok(!stored.includes("\\\\u5408"), "no literal escape survives");
});

test("cap: a result never carries an empty text part", () => {
	const outcome = capToolOutput([...text("a".repeat(2_000)), ...text("b".repeat(50))], 1_000);
	assert.equal(outcome.capped, true);
	for (const part of outcome.content) assert.notEqual((part as { text?: string }).text, "", "no empty text part");
	assert.equal(bytesOf(outcome.content.slice(0, -1)), 1_000);
	assert.match((outcome.content.at(-1) as { text: string }).text, /context-aware: tool output capped/u);
});

test("summary: an escaped backslash before u0041 is not decoded, and a lone surrogate stays escaped", () => {
	assert.equal(decodeUnicodeEscapes("\\\\u0041 and \\u0041"), "\\\\u0041 and A");
	assert.equal(decodeUnicodeEscapes("\\ud83d alone"), "\\ud83d alone");
	assert.equal(decodeUnicodeEscapes("\\ude00 alone"), "\\ude00 alone");
	const many = "\\u5408".repeat(UNESCAPE_THRESHOLD + 1) + "\\\\u0041\\ud83d";
	const result = sanitizeSummary(many);
	assert.equal(result.unescaped, true);
	assert.equal(result.text, "\u5408".repeat(UNESCAPE_THRESHOLD + 1) + "\\\\u0041\\ud83d");
	assert.equal([...result.text].some((c) => { const n = c.charCodeAt(0); return c.length === 1 && n >= 0xd800 && n <= 0xdfff; }), false, "no lone surrogate is stored");
});

