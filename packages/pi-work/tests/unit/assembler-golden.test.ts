import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assembleWorkspec } from "../../src/plan/assembler.ts";
import { renderRemediationBrief, renderReviewContract, renderWorkerBrief } from "../../src/plan/projectors.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import type { RemediationData, ReportedEvidence } from "../../src/plan/types.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const fixtureDir = path.join(REPO_ROOT, "tests", "fixtures", "plan");

async function fixture(name: string) {
	const source = await readFile(path.join(fixtureDir, name), "utf8");
	const result = validateWorkspec(withDraftLineage(source));
	assert.equal(result.structuralValid, true);
	assert.equal(result.valid, true);
	return result.spec;
}

async function golden(name: string): Promise<string> {
	return readFile(path.join(fixtureDir, "golden", name), "utf8");
}

const report: readonly ReportedEvidence[] = [{ criterionId: "parent-criterion-sentinel", verbatim: "worker report line one\nworker report line two" }];
const remediation: RemediationData = {
	failedCriterionIds: ["parent-criterion-sentinel"],
	concerns: [{ criterionId: "parent-criterion-sentinel", concern: "concern-sentinel", citations: [{ path: "src/file.ts", line: 12 }, { path: "src/other.ts", line: 20, endLine: 22 }] }],
	priorEvidenceResults: [{ criterionId: "parent-criterion-sentinel", verbatim: "prior evidence line one\nprior evidence line two" }],
};

test("one assembly carries nested parent and feeds all three projections", async () => {
	const index = assembleWorkspec(await fixture("all-fields-composite.yaml"));
	const child = index.byAddress.get(JSON.stringify(["parent-sentinel", "child-sentinel"]));
	assert.ok(child);
	const childReport = [{ criterionId: "child-criterion-sentinel", verbatim: report[0].verbatim }] as const;
	const childRemediation: RemediationData = {
		failedCriterionIds: ["child-criterion-sentinel"],
		concerns: [{ criterionId: "child-criterion-sentinel", concern: "concern-sentinel", citations: remediation.concerns[0].citations }],
		priorEvidenceResults: [{ criterionId: "child-criterion-sentinel", verbatim: remediation.priorEvidenceResults[0].verbatim }],
	};
	for (const rendered of [renderWorkerBrief(child), renderReviewContract(child, childReport), renderRemediationBrief(child, childRemediation)]) {
		assert.match(rendered, /parent-task-sentinel/);
		assert.match(rendered, /plan-intent-sentinel/);
	}
});

test("composite and checklist projections preserve exact goldens", async () => {
	const composite = assembleWorkspec(await fixture("all-fields-composite.yaml"));
	const parent = composite.byAddress.get(JSON.stringify(["parent-sentinel"]));
	assert.ok(parent);
	assert.equal(renderWorkerBrief(parent), await golden("composite-worker.md"));
	assert.equal(renderReviewContract(parent, report), await golden("composite-review.md"));
	assert.equal(renderRemediationBrief(parent, remediation), await golden("composite-remediation.md"));

	const checklist = assembleWorkspec(await fixture("all-fields-checklist.yaml"));
	const node = checklist.byAddress.get(JSON.stringify(["checklist-sentinel"]));
	assert.ok(node);
	assert.equal(renderWorkerBrief(node), await golden("checklist-worker.md"));
	assert.equal(renderReviewContract(node, []), await golden("checklist-review.md"));
	assert.equal(renderRemediationBrief(node, { failedCriterionIds: ["checklist-criterion-sentinel"], concerns: [], priorEvidenceResults: [] }), await golden("checklist-remediation.md"));
});
