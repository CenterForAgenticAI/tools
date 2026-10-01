import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseDraft, promoteDraft } from "../../src/promote/index.ts";
import { parseYaml, validateWorkspec } from "../../src/schema/index.ts";
import { workPromoteTool, type WorkPromoteDetails } from "../../src/tools/work-promote.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";

const BOOTSTRAP_DRAFT = ".work/drafts/pi-work-v1.md";
const bootstrapDraftSkip = existsSync(path.join(REPO_ROOT, BOOTSTRAP_DRAFT))
	? false
	: `missing repository fixture: ${BOOTSTRAP_DRAFT}`;

function draft(decisions: readonly string[]): string {
	return [
		"## Summary <!-- work:summary -->",
		"",
		"A thing.",
		"",
		"## Rationale <!-- work:rationale -->",
		"",
		"Because.",
		"",
		"## Open decisions <!-- work:decisions -->",
		"",
		...decisions,
		"",
		"## Acceptance criteria <!-- work:criteria -->",
		"",
		"- A1: It works.",
		"",
	].join("\n");
}

test("promotion carries every declared open decision, with its question context", () => {
	const parsed = parseDraft(draft([
		"- OD1: Ship dispatch in v1?",
		"  pi-delegate#82 is open, so the node can deliver only its degraded path.",
		"  tripwire: Before decomposing the dispatch subtree.",
		"  decides: user",
		"- OD2: Which feature is dogfood 2?",
		"  decides: user",
		"  tripwire: Before calling v1 done.",
	]), "d.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.deepEqual(parsed.decisions?.map((decision) => decision.id), ["OD1", "OD2"]);
	// Indented prose extends the question rather than being dropped, so the reason the
	// decision exists survives promotion instead of living only in the draft.
	assert.equal(parsed.decisions?.[0]?.question, "Ship dispatch in v1? pi-delegate#82 is open, so the node can deliver only its degraded path.");
	assert.equal(parsed.decisions?.[0]?.tripwire, "Before decomposing the dispatch subtree.");
	assert.equal(parsed.decisions?.[0]?.decides, "user");
	assert.equal(parsed.decisions?.[1]?.question, "Which feature is dogfood 2?");

	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	assert.match(promoted.specSource, /^open_decisions:$/m);
	assert.match(promoted.specSource, /^ {4}tripwire: "Before decomposing the dispatch subtree\."$/m);
	// open_decisions must precede work, which is where the schema expects it.
	assert.ok(promoted.specSource.indexOf("open_decisions:") < promoted.specSource.indexOf("work:"));
});

test("the actual promoter preserves prose colons and emits known decision fields", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-decision-round-trip-"));
	await writeFile(path.join(cwd, "draft.md"), draft([
		"- OD1: Which compatibility path should ship?",
		"  The relevant constraint is this: old callers must keep working.",
		"  tripwire: Before implementation starts.",
		"  decides: user",
	]));

	const result = await workPromoteTool.execute(
		"test",
		{ draftPath: "draft.md", specPath: "spec.yaml" },
		undefined,
		undefined,
		{ cwd } as never,
	) as unknown as { content: { type: string; text?: string }[]; details: WorkPromoteDetails };
	assert.equal(result.details.valid, true);
	assert.equal(result.details.written, true);

	const output = await readFile(path.join(cwd, "spec.yaml"), "utf8");
	const parsed = parseYaml(output);
	assert.deepEqual(parsed.findings, []);
	const value = parsed.value as { open_decisions?: { question?: string; tripwire?: string; decides?: string }[] } | undefined;
	assert.deepEqual(value?.open_decisions, [{
		id: "OD1",
		question: "Which compatibility path should ship? The relevant constraint is this: old callers must keep working.",
		tripwire: "Before implementation starts.",
		decides: "user",
	}]);
});

test("the actual promoter rejects unknown decision fields in every position without writing output", async () => {
	for (const { label, key, lines } of [
		{
			label: "before known fields",
			key: "owner",
			lines: ["- OD1: Ship it?", "  owner: finance-ops", "  tripwire: Before implementation.", "  decides: user"],
		},
		{
			label: "between known fields",
			key: "blocks-2",
			lines: ["- OD1: Ship it?", "  tripwire: Before implementation.", "  blocks-2: INV-1", "  decides: user"],
		},
		{
			label: "after known fields",
			key: "scope_hint",
			lines: ["- OD1: Ship it?", "  tripwire: Before implementation.", "  decides: user", "  scope_hint: dispatch"],
		},
	] as const) {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-promote-unknown-decision-field-"));
		await writeFile(path.join(cwd, "draft.md"), draft(lines));
		const result = await workPromoteTool.execute(
			"test",
			{ draftPath: "draft.md", specPath: "spec.yaml" },
			undefined,
			undefined,
			{ cwd } as never,
		) as unknown as { content: { type: string; text?: string }[]; details: WorkPromoteDetails };

		assert.equal(result.details.valid, false, label);
		assert.equal(result.details.written, false, label);
		const decisionFindings = result.details.findings.filter((finding) => finding.code === "decisions-malformed");
		assert.equal(decisionFindings.length, 1, label);
		assert.match(decisionFindings[0]!.message, new RegExp(`unknown decision field '${key}'`), label);
		assert.match(result.content[0]?.text ?? "", new RegExp(`unknown decision field '${key}'`), label);
		await assert.rejects(stat(path.join(cwd, "spec.yaml")), label);
	}
});

test("a draft with no decisions region emits no open_decisions key", () => {
	const source = [
		"## Summary <!-- work:summary -->",
		"",
		"A thing.",
		"",
		"## Rationale <!-- work:rationale -->",
		"",
		"Because.",
		"",
		"## Acceptance criteria <!-- work:criteria -->",
		"",
		"- A1: It works.",
		"",
	].join("\n");
	const parsed = parseDraft(source, "d.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.decisions, undefined);
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	// Absent, not empty: `open_decisions: []` would assert a list the draft never made.
	assert.equal(promoted.specSource.includes("open_decisions"), false);
});

test("a malformed decision fails promotion rather than promoting a partial gate", () => {
	for (const [label, bullets] of [
		["missing both fields", ["- OD1: Ship it?"]],
		["missing decides", ["- OD1: Ship it?", "  tripwire: Before the thing."]],
		["missing tripwire", ["- OD1: Ship it?", "  decides: user"]],
		["duplicate id", ["- OD1: A?", "  tripwire: T", "  decides: user", "- OD1: B?", "  tripwire: T", "  decides: user"]],
		["invalid id", ["- not/an/id: A?", "  tripwire: T", "  decides: user"]],
		["empty field value", ["- OD1: A?", "  tripwire:  ", "  decides: user"]],
		["repeated field", ["- OD1: A?", "  tripwire: T", "  tripwire: T2", "  decides: user"]],
		["question text after the fields", ["- OD1: A?", "  tripwire: T", "  decides: user", "  trailing prose"]],
	] as const) {
		const parsed = parseDraft(draft([...bullets]), "d.md");
		assert.equal(parsed.ok, false, `${label} must not promote`);
		assert.ok(parsed.findings.some((finding) => finding.severity === "error" && finding.code.startsWith("decisions-")), label);
	}
});

test("the project's own draft promotes its three open decisions into a valid shape", { skip: bootstrapDraftSkip }, async () => {
	const source = await readFile(path.join(REPO_ROOT, BOOTSTRAP_DRAFT), "utf8");
	const parsed = parseDraft(source, BOOTSTRAP_DRAFT);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.findings.filter((finding) => finding.severity === "error")));
	if (!parsed.ok) return;
	assert.deepEqual(parsed.decisions?.map((decision) => decision.id), ["OD1", "OD2", "OD3"]);
	for (const decision of parsed.decisions ?? []) {
		assert.ok(decision.tripwire.length > 0, `${decision.id} tripwire`);
		assert.ok(decision.decides.length > 0, `${decision.id} decides`);
	}

	// The emitted open_decisions block must satisfy the schema that consumes it, which
	// is the half a promotion test can prove without a full decomposition.
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	const block = promoted.specSource.slice(promoted.specSource.indexOf("open_decisions:"), promoted.specSource.indexOf("work:"));
	const probe = validateWorkspec([
		"title: T",
		"description: D",
		"intent: I",
		block.trimEnd(),
		"work: []",
		"",
	].join("\n"), { specPath: path.join(REPO_ROOT, ".work", "specs", "pi-work-v1.yaml"), cwd: REPO_ROOT });
	assert.equal(probe.structuralValid, true, JSON.stringify(probe.findings));
	if (!probe.structuralValid) return;
	assert.equal(probe.spec.open_decisions?.length, 3);
});
