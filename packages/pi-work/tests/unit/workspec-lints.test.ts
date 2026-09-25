import assert from "node:assert/strict";
import test from "node:test";

import { findTouchOverlaps, flattenWorkNodes } from "../../src/lint/touches-overlap.ts";
import {
	DESCRIPTION_LENGTH_THRESHOLD,
	INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD,
	TOUCH_CONCENTRATION_THRESHOLD,
	lintWorkspec,
	normalizedTokenContainment,
} from "../../src/lint/workspec-lints.ts";
import type { WorkNode, Workspec } from "../../src/schema/workspec.ts";

const criterion = (id: string) => ({
	id: `${id}-criterion`,
	statement: `${id} is green`,
	evidence: { kind: "command" as const, run: "printf x", expect: { exit: 0, output_includes: "x" } },
});
const leaf = (id: string, touches: string[]): WorkNode => ({ id, task: id, touches, acceptance: [criterion(id)] }) as WorkNode;
const composite = (id: string, touches: string[], work: WorkNode[]): WorkNode => ({ id, task: id, touches, work });

const base = (description: string, intent = "different intent"): Workspec => ({
	title: "T", description, intent,
	work: [
		leaf("one", ["./src/file.ts", "src/file.ts/"]),
		leaf("two", ["src/file.ts"]),
		composite("three", ["src/file.ts"], [leaf("nested", ["src/file.ts"])]),
	],
});

test("reusable touch overlap separates two-node contention from concentration", () => {
	assert.deepEqual(findTouchOverlaps([]), []);
	assert.deepEqual(findTouchOverlaps([leaf("single", ["src/file.ts"])]), []);
	const spec = base("short");
	const overlaps = findTouchOverlaps(spec);
	assert.equal(overlaps.length, 1);
	assert.equal(overlaps[0].count, 4);
	const ready = findTouchOverlaps(flattenWorkNodes(spec).slice(0, 2));
	assert.equal(ready[0].count, 2);
	const findings = lintWorkspec(spec);
	const concentration = findings.find((finding) => finding.code === "touches-concentration");
	assert.ok(concentration);
	assert.equal(concentration.threshold, TOUCH_CONCENTRATION_THRESHOLD);
	assert.equal(concentration.count, 4);
});

test("prose lints use Unicode code points and multiset token containment", () => {
	assert.equal(normalizedTokenContainment("Hello, HELLO world!", "hello world"), 1);
	assert.equal(normalizedTokenContainment("", "anything"), 0);
	assert.equal(normalizedTokenContainment("alpha beta", "alpha gamma"), 0.5);
	assert.equal(lintWorkspec(base("x".repeat(DESCRIPTION_LENGTH_THRESHOLD))).some((f) => f.code === "description-too-long"), false);
	assert.equal(lintWorkspec(base("x".repeat(DESCRIPTION_LENGTH_THRESHOLD + 1))).some((f) => f.code === "description-too-long"), true);
	assert.equal(normalizedTokenContainment("a b c d e f g h i j", "a b c d e f g h x j"), INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD);
	assert.equal(normalizedTokenContainment("a b c d e f g h i j", "a b c d e f g x y j"), 0.8);
	const duplicate = lintWorkspec(base("same words", "SAME, words."));
	const warning = duplicate.find((finding) => finding.code === "intent-description-duplicate");
	assert.ok(warning);
	assert.equal(warning.threshold, INTENT_DESCRIPTION_CONTAINMENT_THRESHOLD);
	assert.equal(warning.severity, "warning");
	const described = { ...leaf("described", ["src/description.ts"]), description: "x".repeat(DESCRIPTION_LENGTH_THRESHOLD + 1) } as WorkNode;
	assert.ok(lintWorkspec({ ...base("short"), work: [described] }).some((finding) => finding.code === "description-too-long" && finding.path.join(".") === "work.0.description"));
});

test("two-node overlaps remain warning-free at the concentration boundary", () => {
	const spec: Workspec = {
		title: "T",
		description: "short",
		intent: "different",
		work: [
			leaf("one", ["src/file.ts"]),
			leaf("two", ["./src/file.ts/"]),
		],
	};
	const findings = lintWorkspec(spec);
	assert.equal(findings.some((finding) => finding.code === "touches-concentration"), false);
	assert.equal(findings.every((finding) => finding.severity === "warning"), true);
});
