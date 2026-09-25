import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assembleWorkspec } from "../../src/plan/assembler.ts";
import { renderProjection, workNodeProjectors } from "../../src/plan/projectors.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function assembly(name: string, address: string[]) {
	const source = await readFile(path.join(REPO_ROOT, "tests/fixtures/plan", name), "utf8");
	const result = validateWorkspec(withDraftLineage(source));
	assert.equal(result.structuralValid, true);
	const found = assembleWorkspec(result.spec).byAddress.get(JSON.stringify(address));
	assert.ok(found);
	return found;
}

test("a controlled no-op in any projection makes the output differ from its baseline", async () => {
	const parent = await assembly("all-fields-composite.yaml", ["parent-sentinel"]);
	const report = [{ criterionId: "parent-criterion-sentinel", verbatim: "report" }] as const;
	const remediation = { failedCriterionIds: ["parent-criterion-sentinel"] as const, concerns: [], priorEvidenceResults: [] } as const;
	const inputs = [
		{ kind: "worker" } as const,
		{ kind: "review", workerReportedEvidence: report } as const,
		{ kind: "remediation", remediation } as const,
	];
	for (const field of Object.keys(workNodeProjectors) as (keyof typeof workNodeProjectors)[]) {
		for (const input of inputs) {
			const baseline = renderProjection(parent, input);
			const changed = renderProjection(parent, input, { [field]: { [input.kind]: () => "CONTROLLED NO-OP" } });
			assert.notEqual(changed, baseline, `${String(field)} / ${input.kind}`);
		}
	}
});

test("checklist variant exposes checklist and does not invent child work", async () => {
	const node = await assembly("all-fields-checklist.yaml", ["checklist-sentinel"]);
	const output = renderProjection(node, { kind: "worker" });
	assert.match(output, /checklist-item-one-sentinel/);
	assert.match(output, /child work roster/);
	assert.match(output, /not declared/);
});
