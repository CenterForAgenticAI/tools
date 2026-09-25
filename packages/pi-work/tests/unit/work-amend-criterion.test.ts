import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseYaml } from "../../src/schema/index.ts";
import { workAmendCriterionTool, type WorkAmendCriterionDetails } from "../../src/tools/work-amend-criterion.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const BEFORE = "The promoted text";
const AFTER = "The authority-approved text";
const SOURCE = withDraftLineage(`title: tool amendment
description: d
intent: i
work:
  - id: node
    task: amend
    acceptance:
      - id: A1
        statement: ${JSON.stringify(BEFORE)}
        evidence:
          kind: user
          prompt: confirm
`);

function execute(cwd: string, overrides: Record<string, unknown> = {}) {
	return workAmendCriterionTool.execute("test", {
		path: "spec.yaml",
		criterionId: "A1",
		before: BEFORE,
		after: AFTER,
		reason: "The design record changed.",
		authority: "https://gitlab.example.test/group/project/-/issues/14",
		...overrides,
	}, undefined, undefined, { cwd } as never) as Promise<{ content: [{ type: "text"; text: string }]; details: WorkAmendCriterionDetails }>;
}

test("work_amend_criterion is strict and records when at execution time", async () => {
	assert.equal(workAmendCriterionTool.name, "work_amend_criterion");
	assert.equal(workAmendCriterionTool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(workAmendCriterionTool.parameters.properties), ["path", "criterionId", "before", "after", "reason", "authority"]);
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-amend-tool-"));
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(SOURCE, { cwd }));
	const result = await execute(cwd);
	assert.equal(result.details.written, true);
	assert.equal(result.details.failure, undefined);
	assert.match(result.details.amendment?.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.match(result.content[0].text, /^amended A1: recorded /);
	const value = parseYaml(await readFile(path.join(cwd, "spec.yaml"), "utf8")).value as {
		work: { acceptance: { statement: string; amendments: { criterion_id: string; before: string; after: string; reason: string; authority: string; at: string }[] }[] }[];
	};
	const criterion = value.work[0].acceptance[0];
	assert.equal(criterion.statement, AFTER);
	assert.deepEqual(criterion.amendments[0], result.details.amendment);
});

test("work_amend_criterion leaves bytes unchanged on stale before text and types read failures", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-amend-tool-fail-"));
	const source = withDraftLineage(SOURCE, { cwd });
	await writeFile(path.join(cwd, "spec.yaml"), source);
	const stale = await execute(cwd, { before: "stale" });
	assert.equal(stale.details.written, false);
	assert.equal(stale.details.failure?.code, "criterion-before-mismatch");
	assert.equal(await readFile(path.join(cwd, "spec.yaml"), "utf8"), source);
	const missing = await execute(cwd, { path: "missing.yaml" });
	assert.equal(missing.details.written, false);
	assert.equal(missing.details.failure?.code, "read-error");
	assert.match(missing.content[0].text, /^not amended: read-error:/);
});
