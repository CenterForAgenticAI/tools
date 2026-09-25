import assert from "node:assert/strict";
import test from "node:test";

import { validateDependencies } from "../../src/schema/dependencies.ts";
import type { WorkNode, Workspec } from "../../src/schema/workspec.ts";

const criterion = (id: string) => ({
	id: `${id}-criterion`,
	statement: `${id} is green`,
	evidence: { kind: "command" as const, run: "printf x", expect: { exit: 0, output_includes: "x" } },
});
const leaf = (id: string, fields: Record<string, unknown> = {}): WorkNode => ({ id, task: id, acceptance: [criterion(id)], ...fields }) as WorkNode;
const composite = (id: string, work: WorkNode[]): WorkNode => ({ id, task: id, work });

function spec(work: Workspec["work"]): Workspec {
	return { title: "T", description: "D", intent: "I", work };
}

test("dependencies resolve only within each sibling scope and nested IDs may repeat", () => {
	const findings = validateDependencies(spec([
		composite("a", [leaf("a"), leaf("b", { depends_on: ["a"] })]),
		leaf("b", { depends_on: ["a"] }),
	]));
	assert.deepEqual(findings, []);
});

test("unresolved, self, duplicate IDs and cycles are typed and path-aware", () => {
	const findings = validateDependencies(spec([
		leaf("a", { depends_on: ["a", "missing", "b"] }),
		leaf("a", { depends_on: ["a"] }),
		leaf("b", { depends_on: ["a"] }),
	]));
	assert.ok(findings.some((finding) => finding.code === "dependency-self" && finding.path.join(".") === "work.0.depends_on.0"));
	assert.ok(findings.some((finding) => finding.code === "dependency-unresolved" && finding.path.join(".") === "work.0.depends_on.1"));
	assert.ok(findings.some((finding) => finding.code === "duplicate-node-id" && finding.path.join(".") === "work.1.id"));
	const cycle = validateDependencies(spec([
		leaf("a", { depends_on: ["b"] }),
		leaf("b", { depends_on: ["a"] }),
	]));
	assert.ok(cycle.some((finding) => finding.code === "dependency-cycle" && finding.members.includes("a") && finding.members.includes("b")));
});

test("one deterministic cycle finding covers one strongly connected component", () => {
	const findings = validateDependencies(spec([
		leaf("a", { depends_on: ["b", "c"] }),
		leaf("b", { depends_on: ["a"] }),
		leaf("c", { depends_on: ["a"] }),
	]));
	const cycles = findings.filter((finding) => finding.code === "dependency-cycle");
	assert.equal(cycles.length, 1);
	assert.deepEqual(cycles[0].members, ["a", "b", "c"]);
	assert.deepEqual(cycles[0].path, ["work", 0, "depends_on"]);
	assert.deepEqual(cycles[0].relatedPaths, [
		["work", 0, "depends_on"],
		["work", 1, "depends_on"],
		["work", 2, "depends_on"],
	]);
});
