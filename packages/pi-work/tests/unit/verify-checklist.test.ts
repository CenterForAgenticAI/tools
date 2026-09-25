import assert from "node:assert/strict";
import test from "node:test";

import { verifyChecklist } from "../../src/verify/checklist.ts";

const tree = { kind: "git" as const, worktreePath: "/tmp/work", resolvedCommit: "0".repeat(40) };

test("checklist accounting is exact and index based", () => {
	const complete = verifyChecklist(["same", "same"], [{ index: 0, done: true }, { index: 1, done: true }], tree);
	assert.equal(complete.outcome, "complete");
	assert.equal(complete.items.length, 2);
	const omitted = verifyChecklist(["one", "two"], [{ index: 0, done: true }], tree);
	assert.equal(omitted.outcome, "incomplete");
	assert.deepEqual(omitted.items.map((item) => item.done), [true, false]);
	assert.ok(omitted.failures.some((failure) => failure.code === "checklist-accounting"));
	const duplicate = verifyChecklist(["one"], [{ index: 0, done: true }, { index: 0, done: true }], tree);
	assert.equal(duplicate.outcome, "incomplete");
	const extra = verifyChecklist(["one"], [{ index: 0, done: true }, { index: 3, done: true }], tree);
	assert.equal(extra.outcome, "incomplete");
	const explicitFalse = verifyChecklist(["one"], [{ index: 0, done: false }], tree);
	assert.equal(explicitFalse.outcome, "incomplete");
	assert.equal(explicitFalse.items[0]?.done, false);
	const nonChecklist = verifyChecklist(undefined, [{ index: 0, done: true }], tree);
	assert.equal(nonChecklist.outcome, "incomplete");
	assert.ok(nonChecklist.failures.length > 0);
	const objectReports = verifyChecklist(["one"], { "0": true, nope: false }, tree);
	assert.equal(objectReports.outcome, "incomplete");
});
