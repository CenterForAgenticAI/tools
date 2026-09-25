import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseYaml, validateWorkspec } from "../../src/schema/index.ts";
import { workPromoteTool, type WorkPromoteDetails } from "../../src/tools/work-promote.ts";
import { workValidateTool, type WorkValidateDetails } from "../../src/tools/work-validate.ts";
import { parseDraft, promoteDraft, recoverCriteriaFromPromotedSource } from "../../src/promote/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";

const BOOTSTRAP_DRAFT = ".work/drafts/pi-work-v1.md";
const bootstrapDraftSkip = existsSync(path.join(REPO_ROOT, BOOTSTRAP_DRAFT))
	? false
	: `missing repository fixture: ${BOOTSTRAP_DRAFT}`;

async function execute(draftPath: string, specPath: string, cwd: string, context: unknown = { cwd }) {
	return workPromoteTool.execute("test", { draftPath, specPath }, undefined, undefined, context as never) as Promise<{ content: { type: string; text?: string }[]; details: WorkPromoteDetails }>;
}

test("work_promote is exported, strict, and promotes a draft skeleton without registration", async () => {
	assert.equal(workPromoteTool.name, "work_promote");
	assert.equal(workPromoteTool.parameters.additionalProperties, false);
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-"));
	await (await import("node:fs/promises")).copyFile(path.join(REPO_ROOT, "tests/fixtures/drafts/valid/well-formed.md"), path.join(cwd, "draft.md"));
	const result = await execute("draft.md", "spec.yaml", cwd);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.written, true);
	assert.match(result.content[0].text!, /^promoted:/);
	const output = await readFile(path.join(cwd, "spec.yaml"), "utf8");
	const validation = validateWorkspec(output);
	assert.equal(validation.structuralValid, false);
	assert.equal(validation.valid, false);
	assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	const parsed = parseYaml(output);
	assert.deepEqual(parsed.findings, []);
	const value = parsed.value as { work?: { id?: string; refs?: { path?: string }[] }[] } | undefined;
	assert.equal(value?.work?.[0]?.id, "decompose");
	assert.equal(value?.work?.[0]?.refs?.[0]?.path?.endsWith("draft.md"), true);
});

test("warning-only promotion writes an explicitly empty optional region", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-warning-"));
	const draft = "## Acceptance criteria <!-- work:criteria -->\n\n- A1: It works\n";
	await (await import("node:fs/promises")).writeFile(path.join(cwd, "draft.md"), draft);
	const result = await execute("draft.md", "spec.yaml", cwd);
	assert.equal(result.details.valid, true);
	assert.equal(result.details.written, true);
	assert.equal(result.details.warningCount, 2);
	const output = await readFile(path.join(cwd, "spec.yaml"), "utf8");
	const validation = validateWorkspec(output);
	assert.equal(validation.valid, false);
	assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	assert.match(output, /description: !md \|2-/);
});

test("malformed or absent criteria fails before writing any destination", async () => {
	for (const fixture of ["missing-criteria.md", "malformed-bullet.md", "duplicate-id.md", "orphan-continuation.md"]) {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-invalid-"));
		const source = await readFile(path.join(REPO_ROOT, "tests/fixtures/drafts/invalid", fixture), "utf8");
		await (await import("node:fs/promises")).writeFile(path.join(cwd, "draft.md"), source);
		const result = await execute("draft.md", "spec.yaml", cwd);
		assert.equal(result.details.valid, false, fixture);
		assert.equal(result.details.written, false, fixture);
		assert.ok(result.details.errorCount > 0, fixture);
		await assert.rejects(stat(path.join(cwd, "spec.yaml")), fixture);
	}
});

test("read and write failures are typed and do not access interactive context", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-io-"));
	const missing = await execute("missing.md", "spec.yaml", cwd, new Proxy({ cwd }, { get(target, property) {
		if (property === "cwd") return target.cwd;
		throw new Error(`unexpected context access: ${String(property)}`);
	}}));
	assert.equal(missing.details.findings[0].code, "read-error");
	const draft = "## Acceptance criteria <!-- work:criteria -->\n- A1: works\n";
	await (await import("node:fs/promises")).writeFile(path.join(cwd, "draft.md"), draft);
	const writeFailure = await execute("draft.md", "missing-directory/spec.yaml", cwd);
	assert.equal(writeFailure.details.findings.at(-1)?.code, "write-error");
	assert.equal(writeFailure.details.written, false);
});

test("promote then validate round-trips the criteria and keeps summary/rationale roles", async () => {
	const draft = await readFile(path.join(REPO_ROOT, "tests/fixtures/drafts/valid/well-formed.md"), "utf8");
	const parsed = parseDraft(draft, ".work/drafts/well-formed.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	const validation = validateWorkspec(promoted.specSource);
	assert.equal(validation.structuralValid, false);
	assert.equal(validation.valid, false);
	assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	const parsedYaml = parseYaml(promoted.specSource);
	const value = parsedYaml.value as { description?: string; intent?: string } | undefined;
	assert.equal(value?.description, parsed.summary?.source);
	assert.equal(value?.intent, parsed.rationale?.source);
	const removedRootField = ["criterion", "roots"].join("_");
	assert.equal(Object.hasOwn(value ?? {}, removedRootField), false);
	assert.equal(recoverCriteriaFromPromotedSource(promoted.specSource), parsed.criteria.source);
});

test("draft command timeout text survives promotion unchanged for later decomposition", () => {
	const criteria = "- A1: The release gate passes\n  Evidence: command with timeout_ms: 180000 and output_includes: passed\n";
	const parsed = parseDraft(`## Acceptance criteria <!-- work:criteria -->\n${criteria}`, "draft.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	assert.equal(recoverCriteriaFromPromotedSource(promoted.specSource), criteria);
	assert.equal((parseYaml(promoted.specSource).value as { work: { description: string }[] }).work[0].description, criteria);
});

test("the real bootstrap draft promotes without editing its source", { skip: bootstrapDraftSkip }, async () => {
	const draftPath = path.join(REPO_ROOT, BOOTSTRAP_DRAFT);
	const source = await readFile(draftPath, "utf8");
	const parsed = parseDraft(source, ".work/drafts/pi-work-v1.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	const validation = validateWorkspec(promoted.specSource);
	assert.equal(validation.structuralValid, false);
	assert.equal(validation.valid, false);
	assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"));
	assert.equal(validation.findings.some((finding) => finding.code === "description-too-long"), false);
	assert.equal(recoverCriteriaFromPromotedSource(promoted.specSource), parsed.criteria.source);
});

test("real bootstrap tool promotion names the required next step and validation deduplicates its skeleton", { skip: bootstrapDraftSkip }, async () => {
	const draftPath = path.join(REPO_ROOT, BOOTSTRAP_DRAFT);
	const draftBefore = await readFile(draftPath, "utf8");
	const scratch = await mkdtemp(path.join(os.tmpdir(), "pi-work-bootstrap-promote-"));
	const specPath = path.relative(REPO_ROOT, path.join(scratch, "promoted.yaml"));
	const promoted = await execute(BOOTSTRAP_DRAFT, specPath, REPO_ROOT);
	assert.equal(promoted.details.valid, true);
	assert.equal(promoted.details.written, true);
	assert.equal(promoted.content[0].text!, [
		"promoted: 0 error(s), 0 warning(s)",
		"promoted workspec is intentionally incomplete; decomposition is required next before it can validate",
	].join("\n"));

	const validated = await workValidateTool.execute(
		"test",
		{ path: specPath },
		undefined,
		undefined,
		{ cwd: REPO_ROOT } as never,
	) as unknown as { content: { type: string; text?: string }[]; details: WorkValidateDetails };
	const identities = validated.details.findings.map((finding) => `${finding.code}|${finding.severity}|${JSON.stringify(finding.path)}`);
	assert.equal(new Set(identities).size, identities.length);
	assert.equal(validated.details.findings.filter((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance").length, 1);
	assert.equal(validated.content[0].text!.split("\n").filter((line) => line === "error schema-required at $.work[0].acceptance").length, 1);
	assert.equal(await readFile(draftPath, "utf8"), draftBefore);
});
