import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseYaml, validateWorkspec } from "../../src/schema/index.ts";
import { workAmendCriterionTool, type WorkAmendCriterionDetails } from "../../src/tools/work-amend-criterion.ts";
import { workValidateTool, type WorkValidateDetails } from "../../src/tools/work-validate.ts";
import type { AcceptanceCriterion, WorkNode } from "../../src/schema/workspec.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const BOOTSTRAP_DRAFT = ".work/drafts/pi-work-v1.md";
const BOOTSTRAP_SPEC = ".work/specs/pi-work-v1.yaml";
const missingBootstrapFixture = [BOOTSTRAP_DRAFT, BOOTSTRAP_SPEC]
	.find((relative) => !existsSync(path.join(REPO_ROOT, relative)));
const bootstrapFixturesSkip = missingBootstrapFixture
	? `missing repository fixture: ${missingBootstrapFixture}`
	: false;

const BEFORE = "The original promoted statement";
const AFTER = "The amended statement";
const SECOND = "The amended statement after a second decision";
const INVENTED = "Text nobody ever promoted, invented wholesale";

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(options: {
	id?: string;
	statement?: string;
	amendments?: readonly { before: string; after: string; criterionId?: string }[];
} = {}): string {
	const id = options.id ?? "A1";
	const statement = options.statement ?? BEFORE;
	const amendments = options.amendments?.length
		? `        amendments:\n${options.amendments.map((amendment, index) => [
			`          - criterion_id: ${amendment.criterionId ?? id}`,
			`            before: ${JSON.stringify(amendment.before)}`,
			`            after: ${JSON.stringify(amendment.after)}`,
			`            reason: ${JSON.stringify(`decision ${index + 1}`)}`,
			"            authority: https://gitlab.example.test/group/project/-/issues/14",
			`            at: 2026-08-14T0${index}:00:00.000Z`,
		].join("\n")).join("\n")}\n`
		: "";
	return `title: lineage\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: prove lineage\n    acceptance:\n      - id: ${id}\n        statement: ${JSON.stringify(statement)}\n${amendments}        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`;
}

function draft(id = "A1", statement = BEFORE): string {
	return `## Acceptance criteria <!-- work:criteria -->\n- ${id}: ${statement}\n`;
}

async function fixture(spec: string, draftSource = draft()): Promise<{ cwd: string; specPath: string; draftPath: string }> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-lineage-"));
	const specPath = path.join(cwd, "spec.yaml");
	const draftPath = path.join(cwd, "draft.md");
	await writeFile(draftPath, draftSource);
	await writeFile(specPath, withDraftLineage(spec, { draftPath: "draft.md", draftSource }));
	return { cwd, specPath, draftPath };
}

async function validate(cwd: string): Promise<{ content: { type: string; text?: string }[]; details: WorkValidateDetails }> {
	return workValidateTool.execute("lineage", { path: "spec.yaml" }, undefined, undefined, { cwd } as never) as never;
}

async function amend(cwd: string, before: string, after: string): Promise<{ content: [{ type: "text"; text: string }]; details: WorkAmendCriterionDetails }> {
	return workAmendCriterionTool.execute("lineage", {
		path: "spec.yaml",
		criterionId: "A1",
		before,
		after,
		reason: "The accepted design changed.",
		authority: "https://gitlab.example.test/group/project/-/issues/14",
	}, undefined, undefined, { cwd } as never) as never;
}

test("work_validate reports a silent statement edit with no amendment", async () => {
	const { cwd } = await fixture(source({ statement: AFTER }));
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-text-unrecorded" && finding.path.join(".") === "work.0.acceptance.0.statement"));
	assert.equal(result.content[0].text, [
		"invalid: 1 error(s), 0 warning(s)",
		"error criterion-text-unrecorded at $.work[0].acceptance[0].statement: A1 does not match its statement in the referenced draft and has no recorded amendment chain",
	].join("\n"));
});

test("work_validate and the amendment tool reject a chain whose before never appeared in the draft", async () => {
	const candidate = source({ statement: AFTER, amendments: [{ before: INVENTED, after: AFTER }] });
	const { cwd, specPath } = await fixture(candidate);
	const validated = await validate(cwd);
	assert.equal(validated.details.valid, false);
	assert.ok(validated.details.findings.some((finding) => finding.code === "criterion-amendment-root-mismatch"));
	const before = await readFile(specPath, "utf8");
	const amended = await amend(cwd, AFTER, SECOND);
	assert.equal(amended.details.written, false);
	assert.equal(amended.details.failure?.code, "invalid-spec");
	assert.ok(amended.details.findings.some((finding) => finding.code === "criterion-amendment-root-mismatch"));
	assert.equal(await readFile(specPath, "utf8"), before);
});

test("the amendment tool creates a valid readable two-link chain", async () => {
	const { cwd, specPath } = await fixture(source());
	const first = await amend(cwd, BEFORE, AFTER);
	assert.equal(first.details.written, true);
	const second = await amend(cwd, AFTER, SECOND);
	assert.equal(second.details.written, true);
	const validated = await validate(cwd);
	assert.equal(validated.details.valid, true, JSON.stringify(validated.details.findings));
	assert.equal(validated.content[0].text, "valid (clean): 0 error(s), 0 warning(s)");
	const value = parseYaml(await readFile(specPath, "utf8")).value as { work: { acceptance: AcceptanceCriterion[] }[] };
	const criterion = value.work[0].acceptance[0];
	assert.equal(criterion.amendments?.length, 2);
	assert.equal(criterion.amendments?.[0].before, BEFORE);
	assert.equal(criterion.amendments?.[0].after, criterion.amendments?.[1].before);
	assert.equal(criterion.amendments?.[1].after, criterion.statement);
});

test("work_validate catches the round-1 forged editable root with a matching invented chain", async () => {
	const obsoleteKey = ["criterion", "roots"].join("_");
	const forged = source({ statement: SECOND, amendments: [{ before: INVENTED, after: SECOND }] });
	const digestKey = ["statement", "sha256"].join("_");
	const rootInventory = `${obsoleteKey}:\n  - id: A1\n    ${digestKey}: ${sha256(INVENTED)}\n`;
	const forgedDocument = forged.replace("work:\n", `${rootInventory}work:\n`);
	const { cwd } = await fixture(forgedDocument);
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "schema-additional-properties" && finding.path.join(".") === obsoleteKey));
});

test("work_validate fails closed when the referenced draft has moved away", async () => {
	const { cwd, draftPath } = await fixture(source());
	await rename(draftPath, `${draftPath}.moved`);
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-unavailable"));
	assert.match(result.content[0].text ?? "", /^invalid: 1 error\(s\), 0 warning\(s\)\nerror criterion-draft-unavailable at \$: referenced draft draft\.md is unreadable:/);
});

test("work_validate fails closed when the workspec does not retain a draft path", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-lineage-no-path-"));
	await writeFile(path.join(cwd, "spec.yaml"), source());
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-unavailable"));
	assert.match(result.content[0].text ?? "", /workspec does not name a draft in its work_promote lineage comment/);
});

test("work_validate fails closed when the referenced draft has no valid criteria block", async () => {
	const { cwd } = await fixture(source(), "# no marked criteria here\n");
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-invalid"));
});

test("work_validate rejects a draft criterion with no owning criterion in the workspec", async () => {
	const draftSource = `${draft()}- A2: another promoted statement\n`;
	const { cwd } = await fixture(source(), draftSource);
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-criterion-unassigned"));
});

test("work_validate rejects deleting every promoted criterion", async () => {
	const empty = "title: lineage\ndescription: d\nintent: i\nwork: []\n";
	const { cwd } = await fixture(empty);
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-criterion-unassigned" && "criterionId" in finding && finding.criterionId === "A1"));
});

test("work_validate refuses draft paths outside its validation root", async () => {
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-work-lineage-boundary-"));
	const outside = path.join(parent, "outside.md");
	await writeFile(outside, draft());
	for (const draftPath of [outside, "../outside.md"]) {
		const cwd = path.join(parent, draftPath === outside ? "absolute" : "relative");
		await (await import("node:fs/promises")).mkdir(cwd);
		await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(source(), { draftPath, draftSource: draft() }));
		const result = await validate(cwd);
		assert.equal(result.details.valid, false, draftPath);
		assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-unavailable" && finding.message.includes("escapes the validation root")), draftPath);
	}
	const symlinkRoot = path.join(parent, "symlink");
	await (await import("node:fs/promises")).mkdir(symlinkRoot);
	await symlink(outside, path.join(symlinkRoot, "draft.md"));
	await writeFile(path.join(symlinkRoot, "spec.yaml"), withDraftLineage(source(), { draftPath: "draft.md", draftSource: draft() }));
	const symlinked = await validate(symlinkRoot);
	assert.equal(symlinked.details.valid, false);
	assert.ok(symlinked.details.findings.some((finding) => finding.code === "criterion-draft-unavailable" && finding.message.includes("resolves outside the validation root")));
});

test("work_validate rejects a criterion id absent from the referenced draft", async () => {
	const { cwd } = await fixture(source({ id: "INVENTED" }));
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "criterion-draft-criterion-missing" && finding.path.join(".") === "work.0.acceptance.0.statement"));
});

test("duplicate criterion ids remain invalid with draft-backed roots", async () => {
	const secondNode = source().slice(source().indexOf("  - id: node\n")).replace("  - id: node", "  - id: second");
	const { cwd } = await fixture(source() + secondNode);
	const result = await validate(cwd);
	assert.equal(result.details.valid, false);
	assert.ok(result.details.findings.some((finding) => finding.code === "duplicate-criterion-id"));
});

test("broken amendment continuity, ids, endpoints, and no-op records fail against a loaded draft", () => {
	const cases = [
		[source({ statement: SECOND, amendments: [{ before: BEFORE, after: AFTER }, { before: "gap", after: SECOND }] }), "criterion-amendment-discontinuous"],
		[source({ statement: AFTER, amendments: [{ before: BEFORE, after: AFTER, criterionId: "OTHER" }] }), "criterion-amendment-id-mismatch"],
		[source({ statement: SECOND, amendments: [{ before: BEFORE, after: AFTER }] }), "criterion-amendment-endpoint-mismatch"],
		[source({ statement: BEFORE, amendments: [{ before: BEFORE, after: BEFORE }] }), "criterion-amendment-noop"],
	] as const;
	for (const [candidate, code] of cases) {
		const result = validateWorkspec(withDraftLineage(candidate, { draftSource: draft() }));
		assert.equal(result.valid, false, code);
		assert.ok(result.findings.some((finding) => finding.code === code), `${code}: ${JSON.stringify(result.findings)}`);
	}
});

function allCriteria(nodes: readonly WorkNode[]): AcceptanceCriterion[] {
	const criteria: AcceptanceCriterion[] = [];
	for (const node of nodes) {
		criteria.push(...(node.acceptance ?? []));
		if ("work" in node && Array.isArray(node.work)) criteria.push(...allCriteria(node.work));
	}
	return criteria;
}

test("the real bootstrap draft stays immutable and its two existing amendments validate unchanged", { skip: bootstrapFixturesSkip }, async () => {
	const draftSource = await readFile(path.join(REPO_ROOT, BOOTSTRAP_DRAFT), "utf8");
	// Pinned so the draft cannot drift unnoticed. Last changed deliberately for #15:
	// the open decisions moved into a marked work:decisions region, and the two
	// compound criteria SCAF-2 and SCAF-4 were split into halves that can each carry
	// their own evidence kind.
	assert.equal(sha256(draftSource), "70394a3fb2a73f08a0f5b2560b1963ec121b22c95074aa7217cc9eefd84ebed3");
	const result = await workValidateTool.execute(
		"bootstrap",
		{ path: BOOTSTRAP_SPEC },
		undefined,
		undefined,
		{ cwd: REPO_ROOT } as never,
	) as unknown as { details: WorkValidateDetails };
	assert.equal(result.details.valid, true, JSON.stringify(result.details.findings));
	const specSource = await readFile(path.join(REPO_ROOT, BOOTSTRAP_SPEC), "utf8");
	const parsed = validateWorkspec(specSource, { specPath: path.join(REPO_ROOT, BOOTSTRAP_SPEC), cwd: REPO_ROOT });
	assert.equal(parsed.structuralValid, true);
	if (!parsed.structuralValid) return;
	const criteria = new Map(allCriteria(parsed.spec.work).map((criterion) => [criterion.id, criterion]));
	assert.equal(criteria.get("STATUS-3")?.amendments?.[0]?.before, "Node completion is derived from evidence green, review approval where configured, and full checklist accounting, and is never settable");
	assert.equal(criteria.get("SCAF-3")?.amendments?.[0]?.before, "The directory conventions `.work/specs/`, `.work/drafts/`, and `.work/.cache/` exist and are gitignored where derived");
	assert.equal(criteria.get("SCAF-2")?.amendments, undefined);
	assert.equal(criteria.get("SCAF-4")?.amendments, undefined);
});
