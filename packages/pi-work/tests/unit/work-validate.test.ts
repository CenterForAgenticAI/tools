import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workValidateTool, type WorkValidateDetails } from "../../src/tools/work-validate.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const BOOTSTRAP_SPEC = ".work/specs/pi-work-v1.yaml";
const bootstrapSpecSkip = existsSync(path.join(REPO_ROOT, BOOTSTRAP_SPEC))
	? false
	: `missing repository fixture: ${BOOTSTRAP_SPEC}`;

async function execute(toolPath: string, cwd = REPO_ROOT) {
	return workValidateTool.execute("test", { path: toolPath }, undefined, undefined, { cwd } as never) as Promise<{ content: { type: string; text?: string }[]; details: WorkValidateDetails }>;
}

test("work_validate is callable without registration and returns typed details", async () => {
	assert.equal(workValidateTool.name, "work_validate");
	assert.equal(workValidateTool.parameters.additionalProperties, false);
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-validate-valid-"));
	const source = await readFile(path.join(REPO_ROOT, "tests/fixtures/workspec/valid/design-section-2.yaml"), "utf8");
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(source, { cwd }));
	const result = await execute("spec.yaml", cwd);
	assert.match(result.content[0].text!, /^valid \(clean\): 0 error\(s\), 0 warning\(s\)$/);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.errorCount, 0);
});

test("work_validate handles warning-only and missing-file inputs without throwing", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-"));
	await writeFile(path.join(directory, "warning.yaml"), `title: T\ndescription: ${"x".repeat(501)}\nintent: I\nwork: []\n`);
	const warning = await execute("@warning.yaml", directory);
	assert.equal(warning.details.valid, true);
	assert.equal(warning.details.warningCount, 1);
	assert.equal(warning.details.errorCount, 0);
	assert.match(warning.content[0].text!, /^valid \(with advisories\): 0 error\(s\), 1 warning\(s\)$/m);
	const missing = await execute("missing.yaml", directory);
	assert.equal(missing.details.valid, false);
	assert.equal(missing.details.findings[0].code, "read-error");
	assert.equal(missing.details.findings[0].path.join("."), "path");
	const invalidPath = await execute("../definitely-missing.yaml", directory);
	assert.equal(invalidPath.details.valid, false);
	assert.equal(invalidPath.details.findings[0].code, "read-error");
});

test("work_validate truncates rendered findings without truncating typed details", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-work-truncate-"));
	const unknownKeys = Array.from({ length: 180 }, (_, index) => `unknown_${index}: value`).join("\n");
	await writeFile(path.join(directory, "many-errors.yaml"), `title: T\ndescription: D\nintent: I\n${unknownKeys}\nwork: []\n`);
	const result = await execute("many-errors.yaml", directory);
	assert.equal(result.details.valid, false);
	assert.equal(result.details.truncated, true);
	assert.equal(result.details.errorCount, 180);
	assert.equal(result.details.findings.length, 180);
	assert.deepEqual(result.details.findings.map((finding) => finding.path), Array.from({ length: 180 }, (_, index) => [`unknown_${index}`]));
	assert.match(result.content[0].text!, /output truncated$/);
});

test("work_validate renders each real bootstrap touches warning with its target, node ids, and accepted reason", { skip: bootstrapSpecSkip }, async () => {
	const result = await execute(BOOTSTRAP_SPEC);
	// All three overlaps are deliberate and carry a recorded reason. They are still
	// counted and still printed: accepting an advisory annotates it, never hides it.
	assert.equal(result.content[0].text!, [
		"valid (with advisories): 0 error(s), 3 warning(s)",
		"warning touches-concentration at $.work[0].touches[11]: scripts/smoke-package.mjs (scaffold, extension, dispatch) [accepted by chrisg at 2026-08-23: scaffold, extension and dispatch genuinely share this file, and depends_on serializes those edits, so the overlap cannot produce a concurrent write. Narrowing touches to silence the advisory would make touches inaccurate, which is worse than the advisory.]",
		"warning touches-concentration at $.work[0].touches[12]: src/index.ts (scaffold, extension, dispatch) [accepted by chrisg at 2026-08-23: Same serialized overlap: src/index.ts is the registration file every tool node would otherwise contend on, which is why extension is sequenced last.]",
		"warning touches-concentration at $.work[0].touches[14]: tests/unit/extension.test.ts (scaffold, extension, dispatch) [accepted by chrisg at 2026-08-23: Same serialized overlap: this test follows the registration surface it covers, so it is edited by whichever node is changing that surface.]",
	].join("\n"));
	assert.equal(result.details.valid, true);
	assert.equal(result.details.warningCount, 3);
});

