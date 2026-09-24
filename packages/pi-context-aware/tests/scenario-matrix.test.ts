import test from "node:test";
import assert from "node:assert/strict";
import { buildAmbiguousProceedPrompt, parseSeedExpansionResult } from "../seed-expansion.js";
import type { SeedExpansionClarify, SeedExpansionProceed, SeedExpansionResult } from "../seed-expansion.js";
import { ambiguousItem3Tagged, clearChecklistItem3Tagged } from "./fixtures.js";

function requireProceed(result: SeedExpansionResult | null): SeedExpansionProceed {
	assert.ok(result);
	if (result.action !== "proceed") throw new Error("expected proceed result");
	return result;
}

function requireClarify(result: SeedExpansionResult | null): SeedExpansionClarify {
	assert.ok(result);
	if (result.action !== "clarify") throw new Error("expected clarify result");
	return result;
}

test("clear checklist item #3 fixture expands to a self-contained test-suite task", () => {
	const parsed = requireProceed(parseSeedExpansionResult(clearChecklistItem3Tagged));
	const prompt = parsed.expanded_seed_prompt;
	for (const required of [
		"test and benchmark suite",
		"agent/extensions/context-aware/index.ts",
		"agent/extensions/context-aware/seed-expansion-spec.md",
		"compact_session",
		"/compact-then",
		"tsc -p agent/extensions/context-aware/tsconfig.json --noEmit --pretty false",
	]) {
		assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.doesNotMatch(prompt, /rename \/compact-now/i);
});

test("ambiguous item #3 fixture remains blocking in ask-style handling", () => {
	const parsed = requireClarify(parseSeedExpansionResult(ambiguousItem3Tagged));
	assert.match(parsed.question, /Which item #3/);
	assert.equal(parsed.options?.length, 2);
});

test("ambiguous item #3 fixture can be converted into cautious handoff text for proceed modes", () => {
	const parsed = requireClarify(parseSeedExpansionResult(ambiguousItem3Tagged));
	const handoff = buildAmbiguousProceedPrompt("continue with item #3", parsed, "cautious-proceed");
	assert.match(handoff, /continue with item #3/);
	assert.match(handoff, /Which item #3 should the next phase continue/);
	assert.match(handoff, /Earlier UI item #3: color theme/);
	assert.match(handoff, /Later compaction item #3: sequencing tests/);
	assert.match(handoff, /smallest reversible next step/);
});

test("missing-context style malformed output does not invent a concrete task", () => {
	const parsed = requireClarify(parseSeedExpansionResult(`<result action="clarify" confidence="low">
<question>
What should “finish this” refer to?
</question>
<blocking_reason>
The conversation does not contain enough task context to infer a concrete next step.
</blocking_reason>
</result>`));
	assert.match(parsed.blocking_reason, /does not contain enough task context/);
});
