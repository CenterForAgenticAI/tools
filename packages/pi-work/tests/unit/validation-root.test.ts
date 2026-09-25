import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWorkspec, type WorkspecValidationContext } from "../../src/schema/index.ts";
import { validationRootForSpec } from "../../src/schema/validation-root.ts";
import { workPlanTool, type WorkPlanDetails } from "../../src/tools/work-plan.ts";
import { workValidateTool, type WorkValidateDetails } from "../../src/tools/work-validate.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const STATEMENT = "The worktree statement";
const WRONG = "A different statement in the main checkout";
const DRAFT = `## Acceptance criteria <!-- work:criteria -->\n- A1: ${STATEMENT}\n`;
const MAIN_DRAFT = `## Acceptance criteria <!-- work:criteria -->\n- A1: ${WRONG}\n`;
const SPEC = `title: lineage\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: prove lineage\n    acceptance:\n      - id: A1\n        statement: ${JSON.stringify(STATEMENT)}\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`;
const DRAFT_PATH = ".work/drafts/a.md";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

async function linkedFixture(): Promise<{ root: string; linked: string; specPath: string }> {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-work-root-"));
	const root = path.join(parent, "main");
	const linked = path.join(root, ".worktrees", "x");
	await mkdir(root);
	git(root, "init", "-q");
	git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "--allow-empty", "-m", "initial");
	git(root, "worktree", "add", "-q", "-b", "linked", linked);
	const specPath = path.join(linked, ".work", "specs", "a.yaml");
	await mkdir(path.dirname(specPath), { recursive: true });
	await mkdir(path.join(linked, ".work", "drafts"));
	await writeFile(specPath, withDraftLineage(SPEC, { draftPath: DRAFT_PATH, draftSource: DRAFT }));
	return { root, linked, specPath };
}

async function validate(root: string, linked: string): Promise<WorkValidateDetails> {
	const toolPath = path.relative(root, path.join(linked, ".work", "specs", "a.yaml"));
	const response = await workValidateTool.execute("root", { path: toolPath }, undefined, undefined, { cwd: root } as never) as { details: WorkValidateDetails };
	return response.details;
}

async function plan(root: string, linked: string): Promise<WorkPlanDetails> {
	const toolPath = path.relative(root, path.join(linked, ".work", "specs", "a.yaml"));
	const response = await workPlanTool.execute("root", { path: toolPath, nodeAddresses: [["node"]] }, undefined, undefined, { cwd: root } as never) as { details: WorkPlanDetails };
	return response.details;
}

test("work_validate and work_plan use the linked worktree's draft, not the caller's", async () => {
	const { root, linked, specPath } = await linkedFixture();
	assert.equal(await realpath(validationRootForSpec(specPath)), await realpath(linked));
	await writeFile(path.join(linked, DRAFT_PATH), DRAFT);
	assert.equal((await validate(root, linked)).valid, true, "the draft only exists in the linked worktree");
	assert.equal((await plan(root, linked)).valid, true, "work_plan finds the worktree-only draft");
	await mkdir(path.join(root, ".work", "drafts"), { recursive: true });
	await writeFile(path.join(root, DRAFT_PATH), MAIN_DRAFT);
	assert.equal((await validate(root, linked)).valid, true);
	const planned = await plan(root, linked);
	assert.equal(planned.valid, true, JSON.stringify(planned.findings));
	assert.equal(planned.plans.length, 1);
	const receipt = planned.plans[0]!;
	const linkedReal = await realpath(linked);
	assert.ok((await realpath(receipt.briefPath)).startsWith(linkedReal + path.sep), "briefs are written in the spec's worktree");
	assert.equal(await realpath(receipt.delegate.cwd!), linkedReal, "the delegate runs in the spec's worktree");

	// A matching main-checkout draft must not hide a contradiction in the worktree.
	await writeFile(path.join(root, DRAFT_PATH), DRAFT);
	await writeFile(path.join(linked, DRAFT_PATH), MAIN_DRAFT);
	const invalid = await validate(root, linked);
	assert.equal(invalid.valid, false);
	assert.ok(invalid.findings.some((finding) => finding.code === "criterion-text-unrecorded"));
	const noPlans = await plan(root, linked);
	assert.equal(noPlans.valid, false);
	assert.equal(noPlans.plans.length, 0);
	assert.ok(noPlans.findings.some((finding) => finding.code === "criterion-text-unrecorded"));

	// Missing in the worktree cannot be rescued by the main checkout's copy.
	await rm(path.join(linked, DRAFT_PATH));
	const missing = await validate(root, linked);
	assert.equal(missing.valid, false);
	assert.ok(missing.findings.some((finding) => finding.code === "criterion-draft-unavailable"));
	assert.equal((await plan(root, linked)).valid, false);
});

test("a linked spec cannot escape its worktree through a path or a symlink", async () => {
	const { root, linked, specPath } = await linkedFixture();
	await writeFile(path.join(root, "outside.md"), DRAFT);
	for (const draftPath of ["../outside.md", "../../outside.md"]) {
		await writeFile(specPath, withDraftLineage(SPEC, { draftPath, draftSource: DRAFT }));
		const result = await validate(root, linked);
		assert.equal(result.valid, false, draftPath);
		assert.ok(result.findings.some((finding) => finding.code === "criterion-draft-unavailable" && finding.message.includes("escapes the validation root")));
	}
	await symlink(path.join(root, "outside.md"), path.join(linked, DRAFT_PATH));
	await writeFile(specPath, withDraftLineage(SPEC, { draftPath: DRAFT_PATH, draftSource: DRAFT }));
	const result = await validate(root, linked);
	assert.equal(result.valid, false);
	assert.ok(result.findings.some((finding) => finding.code === "criterion-draft-unavailable" && finding.message.includes("resolves outside the validation root")));
});

test("the validation context cannot supply only the caller's cwd", () => {
	// @ts-expect-error A caller must identify the spec before supplying a cwd.
	const context: WorkspecValidationContext = { cwd: "/caller" };
	assert.equal(context.cwd, "/caller");
});

test("without Git, the nearest .work ancestor owns the draft; without either, the caller does", async () => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-work-no-git-"));
	const project = path.join(parent, "project");
	const specs = path.join(project, ".work", "specs");
	await mkdir(specs, { recursive: true });
	const specPath = path.join(specs, "a.yaml");
	assert.equal(validationRootForSpec(specPath, parent), project);
	await mkdir(path.join(project, ".work", "drafts"));
	await writeFile(path.join(project, DRAFT_PATH), DRAFT);
	assert.equal(validateWorkspec(withDraftLineage(SPEC, { draftPath: DRAFT_PATH, draftSource: DRAFT }), { specPath, cwd: parent }).valid, true);
	const bareSpec = path.join(parent, "bare", "a.yaml");
	assert.equal(validationRootForSpec(bareSpec, parent), parent);
});
