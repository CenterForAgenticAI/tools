import test from "node:test";
import assert from "node:assert/strict";

import { GUIDANCE_VARIANTS, STEERS, modelFamily, steerFor } from "../src/strategy/guidance.js";

// pi-context-aware#459: by-model-v1 steers each model against its lean. Expected families and steers come from
// the agreed design (459-guidance-design.md, section 2, operator decision Q1), not from the code.

test("#459: the registry holds default and by-model-v1, in that order", () => {
	assert.deepEqual([...GUIDANCE_VARIANTS], ["default", "by-model-v1"]);
	assert.deepEqual([...STEERS], ["default", "compact-boundary", "fold-first"]);
});

test("#459: a model id is matched on its last path segment: claude-opus-* is opus, gpt-* is gpt, anything else other", () => {
	const cases: Array<[string | null | undefined, string]> = [
		["claude-opus-5-5", "opus"],
		["anthropic/claude-opus-5-5", "opus"],
		["openrouter/anthropic/claude-opus-4.5", "opus"],
		["CLAUDE-OPUS-5-5", "opus"],
		["gpt-6.1-sol", "gpt"],
		["openai/gpt-6.1-sol", "gpt"],
		["claude-sonnet-5-5", "other"],
		["claude-opus", "other"],
		["my-claude-opus-5", "other"],
		["gpt", "other"],
		["chatgpt-4o", "other"],
		["claude-opus-5-5/variant", "other"],
		["gemini-3-pro", "other"],
		["", "other"],
		[null, "other"],
		[undefined, "other"],
		["gpt-" + "x".repeat(200), "other"],
	];
	for (const [id, family] of cases) assert.equal(modelFamily(id), family, String(id));
});

test("#459: default guidance steers no model; by-model-v1 steers opus to compact at boundaries and gpt to fold first", () => {
	for (const id of ["claude-opus-5-5", "gpt-6.1-sol", "claude-sonnet-5-5", undefined]) assert.equal(steerFor("default", id), "default", String(id));
	assert.equal(steerFor("by-model-v1", "anthropic/claude-opus-5-5"), "compact-boundary");
	assert.equal(steerFor("by-model-v1", "gpt-6.1-sol"), "fold-first");
	assert.equal(steerFor("by-model-v1", "claude-sonnet-5-5"), "default", "an A/A model keeps today's text");
	assert.equal(steerFor("by-model-v1", undefined), "default", "no model, today's text");
});
