import assert from "node:assert/strict";
import test from "node:test";

import { unknownPropertyFindings } from "../../src/schema/unknown-properties.ts";
import { WorkspecSchema } from "../../src/schema/workspec.ts";

test("unknown-property walker reports every closed-schema key through arrays, unions, and cyclic nodes", () => {
	const findings = unknownPropertyFindings(WorkspecSchema, {
		title: "T",
		description: "D",
		intent: "I",
		root_extra: true,
		work: [{
			id: "parent",
			task: "Parent",
			node_extra: true,
			worker: { profile: "implementer", worker_extra: true },
			acceptance: [{
				id: "A",
				statement: "reviewed",
				evidence: {
					kind: "agent",
					agent: "reviewer",
					inputs: ["brief.md"],
					rubric: "review",
					evidence_extra: true,
				},
			}],
			work: [{
				id: "child",
				task: "Child",
				child_extra: true,
				acceptance: [{
					id: "B",
					statement: "done",
					evidence: { kind: "user", prompt: "confirm" },
				}],
			}],
		}],
	});

	assert.deepEqual(findings.map((finding) => finding.path), [
		["root_extra"],
		["work", 0, "node_extra"],
		["work", 0, "worker", "worker_extra"],
		["work", 0, "acceptance", 0, "evidence", "evidence_extra"],
		["work", 0, "work", 0, "child_extra"],
	]);
	for (const finding of findings) {
		assert.equal(finding.code, "schema-additional-properties");
		assert.deepEqual(finding.properties, [finding.path.at(-1)]);
		assert.deepEqual(finding.params, { additionalProperties: [finding.path.at(-1)] });
	}
});

test("unknown-property walker resolves JSON pointers and deduplicates overlapping closed schemas", () => {
	const closed = {
		type: "object",
		properties: { known: { type: "string" } },
		additionalProperties: false,
	};
	const schema = {
		$defs: { "closed/object~schema": { allOf: [closed, closed] } },
		$ref: "#/$defs/closed~1object~0schema",
	};

	assert.deepEqual(unknownPropertyFindings(schema, { known: "yes", extra: true }).map((finding) => finding.path), [["extra"]]);
});
