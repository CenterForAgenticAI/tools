import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseDraft, promoteDraft, REGION_MARKERS, scanRegions, CRITERIA_FORMAT, type CriteriaBlock } from "../../src/promote/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";

const invalidDir = path.join(REPO_ROOT, "tests/fixtures/drafts/invalid");

for (const name of [
	"missing-criteria.md",
	"malformed-bullet.md",
	"invalid-id.md",
	"empty-statement.md",
	"invalid-continuation.md",
	"orphan-continuation.md",
	"duplicate-id.md",
	"marker-wrong-element.md",
	"duplicate-marker.md",
	"overlapping-markers.md",
	"empty-criteria.md",
]) {
	test(`invalid fixture ${name} fails with a typed finding`, async () => {
		const expectations = JSON.parse(await readFile(path.join(invalidDir, "expectations.json"), "utf8")) as Record<string, string>;
		const source = await readFile(path.join(invalidDir, name), "utf8");
		const result = parseDraft(source, `tests/fixtures/drafts/invalid/${name}`);
		assert.equal(result.ok, false);
		if (result.ok) return;
		const expected = expectations[name];
		assert.ok(expected);
		const finding = result.findings.find((item) => item.code === expected);
		assert.ok(finding, `${name} did not produce ${expected}: ${JSON.stringify(result.findings)}`);
		assert.equal(finding.severity, "error");
		assert.equal(finding.path[0], "regions");
		assert.match(finding.expectedFormat, /criteria|column-zero|ATX/i);
	});
}

test("the invalid-fixture manifest covers every committed malformed draft", async () => {
	const expectations = JSON.parse(await readFile(path.join(invalidDir, "expectations.json"), "utf8")) as Record<string, string>;
	const files = (await readdir(invalidDir)).filter((name) => name.endsWith(".md")).sort();
	assert.deepEqual(Object.keys(expectations).sort(), files);
});

test("the valid fixture retains marked regions and accepts code-fenced payload text", async () => {
	const source = await readFile(path.join(REPO_ROOT, "tests/fixtures/drafts/valid/well-formed.md"), "utf8");
	const result = parseDraft(source, "tests/fixtures/drafts/valid/well-formed.md");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.deepEqual(result.criteria.entries.map((entry) => ({ id: entry.id, statement: entry.statement })), [
		{ id: "A1", statement: "Output preserves YAML: {x: [1, 2]} and unicode ✓\ncontinuation with `ticks` and trailing spaces" },
		{ id: "A2", statement: "It handles a fenced example\n```yaml\n---\n- nested: true\n```" },
	]);
	assert.equal(result.criteria.source, source.slice(result.criteria.start, result.criteria.end));
	assert.match(result.criteria.source, /```yaml\n/);
	assert.match(result.summary?.source ?? "", /Ship an example/);
	assert.match(result.rationale?.source ?? "", /source draft/);
});

test("headings in fenced code are payload, while lower headings remain inside a region", () => {
	const source = [
		"## Summary <!-- work:summary -->",
		"summary",
		"```markdown",
		"## fake <!-- work:criteria -->",
		"- not: a region",
		"```",
		"### Nested heading",
		"nested",
		"## Acceptance criteria <!-- work:criteria -->",
		"- A1: statement",
		"# End",
		"after",
	].join("\n");
	const scanned = scanRegions(source, "draft.md");
	assert.deepEqual(Object.keys(scanned.regions).sort(), ["criteria", "summary"]);
	assert.match(scanned.regions.summary?.source ?? "", /### Nested heading/);
	assert.equal(scanned.findings.length, 0);
});

test("marker constants expose the teachable machine format", () => {
	assert.equal(REGION_MARKERS.criteria, "<!-- work:criteria -->");
	assert.match(CRITERIA_FORMAT, /top-level Markdown bullets/);
	assert.match(CRITERIA_FORMAT, /after a successfully parsed criterion/);
});

test("validated criteria are opaque and the serializer rejects forged empty input", () => {
	// @ts-expect-error CriteriaBlock can only be produced by criteria validation.
	const unchecked: CriteriaBlock = {
		name: "criteria",
		level: 2,
		start: 0,
		end: 0,
		line: 1,
		source: "",
		entries: [],
	};
	const promoted = promoteDraft({ ok: true, sourcePath: "draft.md", source: "", criteria: unchecked, findings: [] });
	assert.equal(promoted.ok, false);
	if (promoted.ok) return;
	assert.equal(promoted.findings[0]?.code, "criteria-malformed");
	assert.equal("specSource" in promoted, false);
});
