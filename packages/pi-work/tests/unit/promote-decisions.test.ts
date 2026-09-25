import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseDraft, promoteDraft } from "../../src/promote/index.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
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
		"  tripwire: Before calling v1 done.",
		"  decides: user",
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
