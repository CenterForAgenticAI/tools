import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAskRequest } from "../../src/contract/index.ts";

test("accepts the pi-ask-tool shape unchanged", () => {
	const result = normalizeAskRequest({
		questions: [{ id: "auth", question: "Which auth?", options: [{ label: "JWT" }, { label: "Session" }], recommended: 1 }],
	});
	assert.ok(result.ok);
	assert.deepEqual(result.request.questions[0], {
		id: "auth",
		question: "Which auth?",
		options: [{ label: "JWT" }, { label: "Session" }],
		recommended: 1,
	});
});

test("coerces older dialects without inventing a category", () => {
	const result = normalizeAskRequest({ prompt: "Pick", choices: ["a", "b"], recommendedIndex: 0, multiple: true });
	assert.ok(result.ok);
	const [q] = result.request.questions;
	assert.equal(q?.question, "Pick");
	assert.equal(q?.multi, true);
	assert.equal(q?.recommended, 0);
	assert.equal(q?.category, undefined);
});

test("rejects empty and duplicate questions", () => {
	assert.equal(normalizeAskRequest({ questions: [] }).ok, false);
	const dup = { id: "x", question: "q", options: [{ label: "a" }] };
	assert.equal(normalizeAskRequest({ questions: [dup, dup] }).ok, false);
});
