import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, default as test } from "node:test";

import { renderFinding, validateWorkspec } from "../../src/schema/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const BOOTSTRAP_SPEC = ".work/specs/pi-work-v1.yaml";
const bootstrapSpecSkip = existsSync(path.join(REPO_ROOT, BOOTSTRAP_SPEC))
	? false
	: `missing repository fixture: ${BOOTSTRAP_SPEC}`;
const ADVISORY_FIXTURE_ROOT = mkdtempSync(path.join(os.tmpdir(), "pi-work-advisory-disposition-"));
const ADVISORY_VALIDATION_CONTEXT = {
	specPath: path.join(ADVISORY_FIXTURE_ROOT, "spec.yaml"),
	cwd: ADVISORY_FIXTURE_ROOT,
};

after(() => rmSync(ADVISORY_FIXTURE_ROOT, { recursive: true, force: true }));

/** Three nodes sharing one file, which is the concentration threshold. */
function overlapping(dispositions = ""): string {
	const shared = Array.from({ length: 3 }, (_, index) => `      - shared/file-${index}.ts`);
	return withDraftLineage([
		"title: T",
		"description: D",
		"intent: I",
		...(dispositions === "" ? [] : [dispositions]),
		"work:",
		"  - id: alpha",
		"    task: Alpha",
		"    touches:",
		...shared,
		"    acceptance:",
		"      - id: A1",
		"        statement: Alpha works.",
		"        evidence:",
		"          kind: command",
		"          run: printf x",
		"          expect:",
		"            exit: 0",
		"            output_includes: x",
		"  - id: beta",
		"    task: Beta",
		"    touches:",
		...shared,
		"    acceptance:",
		"      - id: B1",
		"        statement: Beta works.",
		"        evidence:",
		"          kind: command",
		"          run: printf x",
		"          expect:",
		"            exit: 0",
		"            output_includes: x",
		"  - id: gamma",
		"    task: Gamma",
		"    touches:",
		...shared,
		"    acceptance:",
		"      - id: C1",
		"        statement: Gamma works.",
		"        evidence:",
		"          kind: command",
		"          run: printf x",
		"          expect:",
		"            exit: 0",
		"            output_includes: x",
		"",
	].join("\n"), { cwd: ADVISORY_FIXTURE_ROOT });
}

interface DispositionInput {
	code: string;
	target: string;
	reason?: string;
	authority?: string;
	at?: string;
}

function dispositions(...entries: DispositionInput[]): string {
	return [
		"advisory_dispositions:",
		...entries.flatMap((entry) => [
			`  - code: ${entry.code}`,
			`    target: ${entry.target}`,
			`    reason: ${entry.reason ?? "The overlap is serialized by depends_on, so it cannot race."}`,
			`    authority: ${entry.authority ?? "tester"}`,
			`    at: ${entry.at ?? "2026-08-23"}`,
		]),
	].join("\n");
}

function disposition(code: string, target: string): string {
	return dispositions({ code, target });
}

test("an accepted advisory is still reported, annotated with who accepted it and why", () => {
	const before = validateWorkspec(overlapping(), ADVISORY_VALIDATION_CONTEXT);
	const raised = before.findings.filter((finding) => finding.code === "touches-concentration");
	assert.ok(raised.length > 0, "fixture must raise the advisory it disposes");
	const target = raised[0] && "target" in raised[0] ? raised[0].target : undefined;
	assert.ok(target);

	const after = validateWorkspec(overlapping(disposition("touches-concentration", target)), ADVISORY_VALIDATION_CONTEXT);
	const accepted = after.findings.find((finding) => finding.code === "touches-concentration" && "target" in finding && finding.target === target);
	assert.ok(accepted, "the advisory must still be reported after being accepted");
	assert.deepEqual(accepted?.disposition, {
		reason: "The overlap is serialized by depends_on, so it cannot race.",
		authority: "tester",
		at: "2026-08-23",
	});
	// Visible, not suppressed: the count is unchanged and the reason is rendered.
	assert.equal(
		after.findings.filter((finding) => finding.code === "touches-concentration").length,
		raised.length,
		"accepting an advisory must not remove it from the findings",
	);
	assert.match(renderFinding(accepted!), /\[accepted by tester at 2026-08-23: The overlap is serialized/);
	// An advisory is a warning either way, so validity is unaffected.
	assert.equal(after.valid, before.valid);
});

test("every disposition after the first duplicate pair is an error and the pair accepts no authority", () => {
	const before = validateWorkspec(overlapping(), { specPath: path.join(REPO_ROOT, ".work", "specs", "pi-work-v1.yaml"), cwd: REPO_ROOT });
	const raised = before.findings.filter((finding) => finding.code === "touches-concentration");
	const target = raised[0] && "target" in raised[0] ? raised[0].target : undefined;
	assert.ok(target);

	const result = validateWorkspec(overlapping(dispositions(
		{ code: "touches-concentration", target },
		{ code: "touches-concentration", target },
		{
			code: "touches-concentration",
			target,
			reason: "This reason conflicts with the first.",
			authority: "someone-else",
			at: "1999-01-01",
		},
	)), { specPath: path.join(REPO_ROOT, ".work", "specs", "pi-work-v1.yaml"), cwd: REPO_ROOT });
	const duplicates = result.findings.filter((finding) => finding.code === "duplicate-advisory-disposition");

	assert.equal(result.valid, false);
	assert.equal(duplicates.length, 2, "both the equal and conflicting repeated entries must be rejected");
	assert.deepEqual(duplicates.map((finding) => ({
		severity: finding.severity,
		path: finding.path,
		relatedPaths: finding.relatedPaths,
	})), [
		{ severity: "error", path: ["advisory_dispositions", 1], relatedPaths: [["advisory_dispositions", 0]] },
		{ severity: "error", path: ["advisory_dispositions", 2], relatedPaths: [["advisory_dispositions", 0]] },
	]);
	for (const duplicate of duplicates) {
		assert.match(renderFinding(duplicate), /duplicates advisory_dispositions\[0\].*remove or combine the repeated acceptance/);
	}

	const after = result.findings.filter((finding) => finding.code === "touches-concentration");
	assert.equal(after.length, raised.length, "the underlying findings must remain visible");
	const duplicatedTarget = after.find((finding) => "target" in finding && finding.target === target);
	assert.ok(duplicatedTarget);
	assert.equal(duplicatedTarget.disposition, undefined, "an ambiguous pair must not accept any authority");
});

test("distinct code-target pairs stay independent and separator characters cannot collide", () => {
	const before = validateWorkspec(overlapping(), { specPath: path.join(REPO_ROOT, ".work", "specs", "pi-work-v1.yaml"), cwd: REPO_ROOT });
	const targets = before.findings
		.filter((finding) => finding.code === "touches-concentration" && "target" in finding)
		.map((finding) => finding.target);
	assert.ok(targets[0]);
	assert.ok(targets[1]);

	const result = validateWorkspec(overlapping(dispositions(
		{ code: "collision|code", target: "target" },
		{ code: "collision", target: "code|target" },
		{ code: "touches-concentration", target: targets[0] },
		{ code: "touches-concentration", target: targets[1] },
		{ code: "different-code", target: targets[0] },
	)), { specPath: path.join(REPO_ROOT, ".work", "specs", "pi-work-v1.yaml"), cwd: REPO_ROOT });

	assert.equal(result.findings.some((finding) => finding.code === "duplicate-advisory-disposition"), false);
	for (const target of targets.slice(0, 2)) {
		const finding = result.findings.find((candidate) => candidate.code === "touches-concentration" && "target" in candidate && candidate.target === target);
		assert.deepEqual(finding?.disposition, {
			reason: "The overlap is serialized by depends_on, so it cannot race.",
			authority: "tester",
			at: "2026-08-23",
		});
	}
});

test("a disposition cannot accept an error, and says so as an error of its own", () => {
	const spec = withDraftLineage([
		"title: T",
		"description: D",
		"intent: I",
		dispositions(
			{ code: "dependency-unresolved", target: "missing" },
			{ code: "dependency-unresolved", target: "missing", reason: "A duplicate still must not accept an error." },
		),
		"work:",
		"  - id: n",
		"    task: t",
		"    depends_on: [missing]",
		"    acceptance:",
		"      - id: A1",
		"        statement: It works.",
		"        evidence:",
		"          kind: command",
		"          run: printf x",
		"          expect:",
		"            exit: 0",
		"            output_includes: x",
		"",
	].join("\n"), { cwd: ADVISORY_FIXTURE_ROOT });
	const result = validateWorkspec(spec, ADVISORY_VALIDATION_CONTEXT);
	assert.equal(result.valid, false);
	// The original error survives; accepting it is refused rather than honoured.
	assert.ok(result.findings.some((finding) => finding.code === "dependency-unresolved" && finding.severity === "error"));
	const refusals = result.findings.filter((finding) => finding.code === "disposition-targets-error");
	assert.equal(refusals.length, 2, "every attempted acceptance of an error must still be refused");
	for (const refusal of refusals) {
		assert.equal(refusal.severity, "error");
		assert.match(renderFinding(refusal), /which this spec raises as an error; only an advisory can be accepted/);
	}
	assert.equal(result.findings.filter((finding) => finding.code === "duplicate-advisory-disposition").length, 1);
	assert.equal(result.findings.some((finding) => finding.code === "dependency-unresolved" && finding.disposition !== undefined), false, "an error must never carry a disposition");
});

test("a disposition matching nothing is reported as stale rather than kept silently", () => {
	const result = validateWorkspec(overlapping(disposition("touches-concentration", "not/a/shared/file.ts")), ADVISORY_VALIDATION_CONTEXT);
	const stale = result.findings.find((finding) => finding.code === "disposition-unmatched");
	assert.ok(stale, "an unmatched disposition must be surfaced");
	assert.equal(stale?.severity, "warning");
	assert.match(renderFinding(stale!), /which this spec does not raise; remove the stale reason/);
	// Stale reasons are advisory, not fatal.
	assert.equal(result.valid, true);
});

test("the project's own spec accepts its three deliberate overlaps and still shows them", { skip: bootstrapSpecSkip }, async () => {
	const source = await readFile(path.join(REPO_ROOT, BOOTSTRAP_SPEC), "utf8");
	const result = validateWorkspec(source, { specPath: path.join(REPO_ROOT, BOOTSTRAP_SPEC), cwd: REPO_ROOT });
	assert.equal(result.valid, true, JSON.stringify(result.findings.filter((finding) => finding.severity === "error")));
	const concentration = result.findings.filter((finding) => finding.code === "touches-concentration");
	assert.equal(concentration.length, 3, "the three deliberate overlaps must still be reported");
	for (const finding of concentration) {
		assert.ok(finding.disposition, `${"target" in finding ? finding.target : "?"} must carry an accepted reason`);
		assert.ok((finding.disposition?.reason.length ?? 0) > 0);
	}
	assert.equal(result.findings.some((finding) => finding.code === "disposition-unmatched"), false, "every recorded reason must still match a live advisory");
});

/** An advisory that names no subject, so no `target` value could ever match it. */
function longDescription(dispositions = ""): string {
	const description = "This description is deliberately past the five hundred codepoint lint threshold so the description-too-long advisory fires. ".repeat(6);
	return withDraftLineage([
		"title: T",
		`description: ${description}`,
		"intent: I",
		...(dispositions === "" ? [] : [dispositions]),
		"work:",
		"  - id: n",
		"    task: t",
		"    acceptance:",
		"      - id: A1",
		"        statement: It works.",
		"        evidence:",
		"          kind: command",
		"          run: printf x",
		"          expect:",
		"            exit: 0",
		"            output_includes: x",
		"",
	].join("\n"), { cwd: ADVISORY_FIXTURE_ROOT });
}

test("a disposition for a targetless advisory is told why it cannot match, not that the spec is silent", () => {
	const raised = validateWorkspec(longDescription(), ADVISORY_VALIDATION_CONTEXT);
	const advisory = raised.findings.find((finding) => finding.code === "description-too-long");
	assert.ok(advisory, "fixture must raise description-too-long");
	assert.equal("target" in advisory!, false, "the premise of this test is that the advisory names no target");

	const result = validateWorkspec(longDescription(disposition("description-too-long", "$.description")), ADVISORY_VALIDATION_CONTEXT);
	const unmatched = result.findings.find((finding) => finding.code === "disposition-unmatched");
	assert.ok(unmatched, "a disposition that matches nothing must still be surfaced");

	const rendered = renderFinding(unmatched!);
	// The spec raises this advisory on the line above, so claiming otherwise is false.
	assert.equal(result.findings.some((finding) => finding.code === "description-too-long"), true);
	assert.doesNotMatch(rendered, /which this spec does not raise/);
	assert.match(rendered, /raises without a target; only an advisory that names a subject can be accepted/);
});

test("a disposition for a code the spec genuinely never raises still reads as stale", () => {
	// Guards the other branch: the original wording is correct here and must survive.
	const result = validateWorkspec(longDescription(disposition("intent-description-duplicate", "$.intent")), ADVISORY_VALIDATION_CONTEXT);
	const unmatched = result.findings.find((finding) => finding.code === "disposition-unmatched");
	assert.ok(unmatched);
	assert.equal(result.findings.some((finding) => finding.code === "intent-description-duplicate"), false, "fixture must not raise the code being disposed");
	assert.match(renderFinding(unmatched!), /which this spec does not raise; remove the stale reason/);
});
