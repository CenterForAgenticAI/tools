import test from "node:test";
import assert from "node:assert/strict";
import {
	buildAmbiguousProceedPrompt,
	buildExpansionFailurePrompt,
	parseSeedExpansionResult,
	seedExpansionPreview,
	textFromResponseContent,
} from "../seed-expansion.js";
import { ambiguousItem3Tagged, clearChecklistItem3Tagged, legacyJsonProceed } from "./fixtures.js";
import type { SeedExpansionClarify, SeedExpansionProceed, SeedExpansionResult } from "../seed-expansion.js";

function requireProceed(result: SeedExpansionResult | null): SeedExpansionProceed {
	assert.ok(result);
	assert.equal(result.action, "proceed");
	if (result.action !== "proceed") throw new Error("expected proceed result");
	return result;
}

function requireClarify(result: SeedExpansionResult | null): SeedExpansionClarify {
	assert.ok(result);
	assert.equal(result.action, "clarify");
	if (result.action !== "clarify") throw new Error("expected clarify result");
	return result;
}

test("parses tagged proceed output with lists", () => {
	const parsed = requireProceed(parseSeedExpansionResult(clearChecklistItem3Tagged));
	assert.equal(parsed.confidence, "high");
	assert.match(parsed.expanded_seed_prompt, /test and benchmark suite/);
	assert.match(parsed.expanded_seed_prompt, /agent\/extensions\/context-aware\/index\.ts/);
	assert.deepEqual(parsed.assumptions, ["Item #3 refers to the latest active checklist item, not earlier completed items."]);
	assert.deepEqual(parsed.unresolved_questions, undefined);
	assert.equal(parsed.summary_focus_hints?.length, 2);
});

test("parses tagged clarify output with options and blocking reason", () => {
	const parsed = requireClarify(parseSeedExpansionResult(ambiguousItem3Tagged));
	assert.equal(parsed.confidence, "low");
	assert.match(parsed.question, /Which item #3/);
	assert.deepEqual(parsed.options, [
		"Earlier UI item #3: color theme.",
		"Later compaction item #3: sequencing tests.",
	]);
	assert.match(parsed.blocking_reason, /two plausible numbered lists/);
});

test("streams partial expanded prompt preview before close tag or done", () => {
	const prefix = `<result action="proceed" confidence="high">\n<expanded_seed_prompt>\n`;
	const partial = `${prefix}Continue with deterministic streaming tests`;
	const preview = seedExpansionPreview(partial);
	assert.equal(preview.kind, "expanded_seed_prompt");
	assert.equal(preview.preview, "Continue with deterministic streaming tests");
});

test("streams partial clarification question preview before close tag or done", () => {
	const partial = `<result action="clarify" confidence="low">\n<question>\nWhich item #3 should continue`;
	const preview = seedExpansionPreview(partial);
	assert.equal(preview.kind, "question");
	assert.equal(preview.preview, "Which item #3 should continue");
});

test("falls back to raw model output before a previewable tag starts", () => {
	const preview = seedExpansionPreview(`<result action="proceed" confidence="high">`);
	assert.equal(preview.kind, "raw_json");
	assert.match(preview.preview, /<result action/);
});

test("parses legacy JSON proceed output", () => {
	const parsed = requireProceed(parseSeedExpansionResult(legacyJsonProceed));
	assert.equal(parsed.confidence, "medium");
	assert.match(parsed.expanded_seed_prompt, /deterministic streaming tests/);
	assert.deepEqual(parsed.summary_focus_hints, ["The parser accepts tagged output and JSON fallback."]);
});

test("previews legacy JSON string once the key value starts", () => {
	const partial = `{"action":"proceed","confidence":"high","expanded_seed_prompt":"Line one\\nLine two`;
	const preview = seedExpansionPreview(partial);
	assert.equal(preview.kind, "expanded_seed_prompt");
	assert.equal(preview.preview, "Line one\nLine two");
});

test("rejects malformed or empty expansion output", () => {
	assert.equal(parseSeedExpansionResult("free-form text"), null);
	assert.equal(
		parseSeedExpansionResult(`<result action="proceed" confidence="high"><expanded_seed_prompt>   </expanded_seed_prompt></result>`),
		null,
	);
	assert.equal(parseSeedExpansionResult(`{"action":"proceed","confidence":"high","expanded_seed_prompt":""}`), null);
});

test("builds cautious and autonomous ambiguity fallback prompts", () => {
	const clarify = requireClarify(parseSeedExpansionResult(ambiguousItem3Tagged));

	const cautious = buildAmbiguousProceedPrompt("continue with item #3", clarify, "cautious-proceed");
	assert.match(cautious, /Proceed cautiously/);
	assert.match(cautious, /Prior transcript:/);
	assert.match(cautious, /Earlier UI item #3/);

	const autonomous = buildAmbiguousProceedPrompt("continue with item #3", clarify, "always-proceed");
	assert.match(autonomous, /fully autonomous handoff/);
	assert.match(autonomous, /without asking the user/);
});

test("builds expansion failure fallback prompt without inventing concrete scope", () => {
	const prompt = buildExpansionFailurePrompt("finish this", "always-proceed");
	assert.match(prompt, /Seed expansion failed/);
	assert.match(prompt, /finish this/);
	assert.match(prompt, /avoid inventing new scope/);
});

test("textFromResponseContent joins only text parts and trims model content", () => {
	const text = textFromResponseContent([
		{ type: "tool-call" },
		{ type: "text", text: "  first line" },
		{ type: "image", text: "ignored alt text" },
		{ type: "text", text: "second line  " },
	]);
	assert.equal(text, "first line\nsecond line");
});

test("parses fenced legacy JSON clarify output and filters malformed option entries", () => {
	const parsed = requireClarify(parseSeedExpansionResult(`Here is the result:\n\n\`\`\`json
{
  "action": "clarify",
  "confidence": "low",
  "question": "Which follow-up should run?",
  "options": [" run tests ", 42, "", "inspect coverage"],
  "blocking_reason": "Two materially different next steps are plausible."
}
\`\`\``));

	assert.equal(parsed.question, "Which follow-up should run?");
	assert.deepEqual(parsed.options, ["run tests", "inspect coverage"]);
	assert.match(parsed.blocking_reason, /Two materially different/);
});

test("previews legacy JSON clarification strings with decoded escapes", () => {
	const preview = seedExpansionPreview(`{"action":"clarify","confidence":"low","question":"Line one\\nTabbed\\t\\u2713 and quote: \\"`);
	assert.equal(preview.kind, "question");
	assert.equal(preview.preview, "Line one\nTabbed\t✓ and quote: \"");
});

test("rejects invalid tagged metadata and malformed JSON objects", () => {
	assert.equal(
		parseSeedExpansionResult(`<result action="proceed" confidence="low"><expanded_seed_prompt>Do work</expanded_seed_prompt></result>`),
		null,
	);
	assert.equal(
		parseSeedExpansionResult(`<result action="clarify" confidence="low"><question>Which?</question></result>`),
		null,
	);
	assert.equal(
		parseSeedExpansionResult(`<result action="defer" confidence="medium"><question>Later?</question></result>`),
		null,
	);
	assert.equal(parseSeedExpansionResult(`{"action":"proceed",`), null);
	assert.equal(parseSeedExpansionResult(`{"action":"noop"}`), null);
});
