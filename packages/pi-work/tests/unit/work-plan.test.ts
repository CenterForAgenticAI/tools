import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workPlanTool, type WorkPlanDetails } from "../../src/tools/work-plan.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const BOOTSTRAP_SPEC = ".work/specs/pi-work-v1.yaml";
const bootstrapSpecSkip = existsSync(path.join(REPO_ROOT, BOOTSTRAP_SPEC))
	? false
	: `missing repository fixture: ${BOOTSTRAP_SPEC}`;

async function execute(file: string, nodeAddresses: string[][], cwd = REPO_ROOT, responseOffset?: number, responseSnapshot?: string) {
	return workPlanTool.execute("test", { path: file, nodeAddresses, ...(responseOffset === undefined ? {} : { responseOffset }), ...(responseSnapshot === undefined ? {} : { responseSnapshot }) }, undefined, undefined, { cwd } as never) as Promise<{ content: { type: string; text?: string }[]; details: WorkPlanDetails }>;
}

async function copyFixture(cwd: string, fixture: string): Promise<string> {
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(await readFile(path.join(REPO_ROOT, "tests/fixtures/plan", fixture), "utf8"), { cwd }));
	return "spec.yaml";
}

async function copyInvalidFixture(cwd: string, fixture: string): Promise<string> {
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(await readFile(path.join(REPO_ROOT, "tests/fixtures/workspec/invalid", fixture), "utf8"), { cwd }));
	return "spec.yaml";
}

const BOOTSTRAP_NODE_ADDRESSES = [
	["scaffold"],
	["schema"],
	["promote"],
	["plan"],
	["verify"],
	["status"],
	["skills"],
	["extension"],
	["dispatch"],
	["dogfood"],
] as string[][];

test("work_plan is exported, creates .work/.cache lazily, and returns a receipt", async () => {
	assert.equal(workPlanTool.name, "work_plan");
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-"));
	await assert.rejects(access(path.join(cwd, ".work", ".cache")));
	const result = await execute(await copyFixture(cwd, "design-section-2-no-profile-with-acceptance.yaml"), [["schema"]], cwd);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.plans.length, 1);
	assert.equal(result.details.worktree, false);
	assert.equal(result.details.plans[0].delegate.worktree, false);
	assert.equal(result.details.plans[0].delegate.cwd, await realpath(cwd));
	assert.match(result.content[0].text!, /1 plan/);
	assert.ok(result.details.plans[0].briefPath.startsWith(await realpath(cwd)));
	await access(result.details.plans[0].briefPath);
	await access(path.join(cwd, ".work", ".cache"));
});

test("work_plan carries worktree isolation on every parallel invocation", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-parallel-"));
	const result = await execute(await copyFixture(cwd, "design-section-2-no-profile-with-acceptance.yaml"), [["schema"], ["docs"]], cwd);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.worktree, true);
	assert.equal(result.details.plans.length, 2);
	assert.deepEqual(result.details.plans.map((plan) => plan.delegate.worktree), [true, true]);
	assert.deepEqual(result.details.plans.map((plan) => plan.delegate.cwd), [undefined, undefined]);
});

test("work_plan returns typed profile finding and no plans", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-profile-"));
	const result = await execute(await copyFixture(cwd, "design-section-2-with-acceptance.yaml"), [["schema"]], cwd);
	assert.equal(result.details.valid, false);
	assert.equal(result.details.plans.length, 0);
	const finding = result.details.findings.find((item) => item.code === "worker-profile-unsupported");
	assert.ok(finding);
	assert.match(result.content[0].text!, /premium/);
});

test("work_plan rejects invalid workspecs before planning", async () => {
	const result = await execute("tests/fixtures/workspec/invalid/status-field.yaml", [["a"]]);
	assert.equal(result.details.valid, false);
	assert.equal(result.details.plans.length, 0);
	assert.ok(result.details.errorCount > 0);
});

for (const fixture of ["cyclic-dependency.yaml", "cross-scope-dependency.yaml"]) {
	test(`work_plan fails closed for semantic validation errors in ${fixture}`, async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-semantic-"));
		const result = await execute(await copyInvalidFixture(cwd, fixture), [["a"]], cwd);
		assert.equal(result.details.valid, false);
		assert.equal(result.details.plans.length, 0);
		assert.equal(result.details.advisories.length, 0);
		assert.equal(result.details.worktree, false);
		assert.ok(result.details.findings.some((finding) => finding.code === (fixture.startsWith("cyclic") ? "dependency-cycle" : "dependency-unresolved")));
		await assert.rejects(access(path.join(cwd, ".work", ".cache", "briefs")));
	});
}

test("work_plan pages receipts against a stable rendering and places advisories before them", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-plan-pages-"));
	const nodeAddresses = Array.from({ length: 45 }, (_, index) => [`node-${index}`]);
	const nodes = nodeAddresses.map(([id]) => `  - id: ${id}
    task: ${id}
    touches: [src/shared.ts]
    acceptance:
      - id: ${id}-acceptance
        statement: ${id} is green
        evidence:
          kind: command
          run: printf ${id}
          expect:
            exit: 0
            output_includes: ${id}`).join("\n");
	const source = (title: string) => withDraftLineage(`title: ${title}
description: pages
intent: pages
work:
${nodes}`, { cwd });
	await writeFile(path.join(cwd, "spec.yaml"), source("pages"));
	try {
		let responseOffset: number | undefined;
		let responseSnapshot: string | undefined;
		let firstPage: Awaited<ReturnType<typeof execute>> | undefined;
		let lastPage: Awaited<ReturnType<typeof execute>> | undefined;
		const renderedReceiptIds: string[] = [];
		for (let page = 0; page < 45; page += 1) {
			const result = await execute("spec.yaml", nodeAddresses, cwd, responseOffset, responseSnapshot);
			const text = result.content[0]?.text ?? "";
			assert.equal(result.details.plans.length, 45);
			assert.ok(text.length <= 4000);
			renderedReceiptIds.push(...Array.from(text.matchAll(/^node-(\d+) @ /gm), ([, id]) => id!));
			if (page === 0) assert.ok(text.indexOf("advisory touch-overlap:") < text.indexOf("node-0 @ "), "overlap warning must appear before receipts");
			firstPage ??= result;
			lastPage = result;
			if (result.details.nextResponseOffset === undefined) break;
			assert.ok(result.details.responseSnapshot);
			assert.match(text, new RegExp(`responseOffset=${result.details.nextResponseOffset}&responseSnapshot=${result.details.responseSnapshot}`));
			responseOffset = result.details.nextResponseOffset;
			responseSnapshot = result.details.responseSnapshot;
		}
		assert.equal(lastPage?.details.truncated, false);
		assert.deepEqual(renderedReceiptIds, Array.from({ length: 45 }, (_, index) => String(index)));
		assert.ok(firstPage?.details.nextResponseOffset);
		assert.ok(firstPage?.details.responseSnapshot);
		const outOfRange = await execute("spec.yaml", nodeAddresses, cwd, 999999, firstPage.details.responseSnapshot);
		assert.equal(outOfRange.details.continuationError?.code, "response-offset-out-of-range");
		const missingSnapshot = await execute("spec.yaml", nodeAddresses, cwd, firstPage.details.nextResponseOffset);
		assert.equal(missingSnapshot.details.continuationError?.code, "response-snapshot-required");
		const midWord = await execute("spec.yaml", nodeAddresses, cwd, 1, firstPage.details.responseSnapshot);
		assert.equal(midWord.details.continuationError?.code, "response-offset-not-issued");
		await writeFile(path.join(cwd, "spec.yaml"), `${source("pages")}\n# a comment that does not affect the rendering\n`);
		const changedComment = await execute("spec.yaml", nodeAddresses, cwd, firstPage.details.nextResponseOffset, firstPage.details.responseSnapshot);
		assert.equal(changedComment.details.continuationError?.code, "response-snapshot-mismatch");
		await writeFile(path.join(cwd, "spec.yaml"), source("changed pages"));
		const stale = await execute("spec.yaml", nodeAddresses, cwd, firstPage.details.nextResponseOffset, firstPage.details.responseSnapshot);
		assert.equal(stale.details.continuationError?.code, "response-snapshot-mismatch");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("work_plan counts its rendered real-bootstrap advisories and disclaims readiness", { skip: bootstrapSpecSkip }, async () => {
	const result = await execute(BOOTSTRAP_SPEC, BOOTSTRAP_NODE_ADDRESSES);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.plans.length, 10);
	assert.equal(result.details.advisories.length, 1);
	const text = result.content[0].text!;
	assert.match(text, /^valid: 0 error\(s\), 3 warning\(s\), 10 plan\(s\), 1 advisory\(s\)$/m);
	assert.match(text, /^readiness: work_plan is not the readiness authority; use work_status before execution$/m);
	const advisoryLines = text.split("\n").filter((line) => line.startsWith("advisory "));
	assert.equal(advisoryLines.length, result.details.advisories.length);
	assert.match(advisoryLines[0], /^advisory touch-overlap: 10 overlap\(s\): /);
	assert.match(advisoryLines[0], /package\.json \(scaffold, extension\)/);
	assert.match(advisoryLines[0], /tests\/unit\/work-status\.test\.ts \(status, dispatch\)$/);
});
