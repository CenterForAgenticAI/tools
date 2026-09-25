import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml, validateWorkspec } from "../../src/schema/index.ts";
import { parseDraft, promoteDraft, recoverCriteriaFromPromotedSource } from "../../src/promote/index.ts";

function nextRandom(seed: number): number {
	return (seed * 1664525 + 1013904223) >>> 0;
}

function physicalLines(source: string): string[] {
	return source.split(/\r\n|\r|\n/);
}

function hasBalancedFence(source: string): boolean {
	let opening: { character: "`" | "~"; length: number } | undefined;
	let sawFence = false;
	for (const line of physicalLines(source)) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!match) continue;
		const character = match[1][0] as "`" | "~";
		const length = match[1].length;
		if (!opening) {
			opening = { character, length };
			sawFence = true;
			continue;
		}
		if (character === opening.character && length >= opening.length && /^[ \t]*$/.test(match[2])) opening = undefined;
	}
	return sawFence && opening === undefined;
}

function hasInternalEmptyLine(source: string): boolean {
	const lines = physicalLines(source);
	while (lines.at(-1) === "") lines.pop();
	return lines.some((line) => line === "");
}

function generatedCategories(source: string, eol: string, terminalBreaks: number): string[] {
	const lines = physicalLines(source);
	const categories = new Set<string>([
		`eol:${eol === "\n" ? "lf" : eol === "\r\n" ? "crlf" : "cr"}`,
		`terminal-breaks:${terminalBreaks}`,
	]);
	if (source.includes("{yaml: [metacharacters, #hash]}")) categories.add("yaml-metacharacters");
	if (source.includes("unicode ✓ λ 漢字")) categories.add("unicode");
	if (source.includes("tabs\tinside\tstatement")) categories.add("tabs");
	if (/[ \t]$/.test(lines[0])) categories.add(lines[0].endsWith("\t") ? "trailing-tab" : "trailing-spaces");
	if (hasBalancedFence(source)) categories.add("embedded-fences");
	if (lines.some((line) => /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line))) categories.add("heading-like");
	if (hasInternalEmptyLine(source)) categories.add("internal-empty-line");
	if (Math.max(...lines.map((line) => line.length)) >= 12_000) categories.add("very-long-line");
	return [...categories];
}

function generatedCriteria(seed: number): { source: string; seed: number; categories: string[] } {
	let state = seed;
	state = nextRandom(state);
	const eol = ["\n", "\r\n", "\r"][state % 3];
	state = nextRandom(state);
	const terminalBreaks = state % 3;
	const token = [
		"plain",
		"{yaml: [metacharacters, #hash]}",
		"backtick ` and tilde ~ and !tag | folded",
		"unicode ✓ λ 漢字",
		"tabs\tinside\tstatement",
	][state % 5];
	state = nextRandom(state);
	const trailing = state % 2 === 0 ? "  " : "\t";
	const longLineLength = seed % 10 === 0 ? 12_000 + seed : 100 + (seed % 37);
	const lines = [
		`- A${seed.toString(36)}: ${token}${trailing}`,
		"  continuation with trailing spaces  ",
		"  ```yaml",
		"  ---",
		"  - embedded: [fence, value]",
		"  ```",
		"  ### heading-like Markdown payload",
		"",
		`- B${(seed + 1).toString(36)}: long ${"x".repeat(longLineLength)}`,
	];
	const source = lines.join(eol) + eol.repeat(terminalBreaks);
	return { source, seed: state, categories: generatedCategories(source, eol, terminalBreaks) };
}

test("property: 1,000 generated criteria payloads survive promotion source framing", () => {
	const covered = new Set<string>();
	let maximumPhysicalLine = 0;
	for (let seed = 1; seed <= 1000; seed++) {
		const generated = generatedCriteria(seed);
		for (const category of generated.categories) covered.add(category);
		maximumPhysicalLine = Math.max(maximumPhysicalLine, ...generated.source.split(/\r\n|\r|\n/).map((line) => line.length));
		const draft = `## Acceptance criteria <!-- work:criteria -->\n${generated.source}`;
		const parsed = parseDraft(draft, `generated-${seed}.md`);
		assert.equal(parsed.ok, true, `seed=${seed} findings=${JSON.stringify(parsed.findings)}`);
		if (!parsed.ok) continue;
		const promoted = promoteDraft(parsed);
		assert.equal(promoted.ok, true, `seed=${seed}`);
		if (!promoted.ok) continue;
		const validation = validateWorkspec(promoted.specSource);
		assert.equal(validation.structuralValid, false, `seed=${seed}`);
		assert.equal(validation.valid, false, `seed=${seed}`);
		assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"), `seed=${seed}`);
		const parsedYaml = parseYaml(promoted.specSource);
		assert.equal(parsedYaml.findings.length, 0, `seed=${seed} yaml=${JSON.stringify(parsedYaml.findings)}`);
		assert.equal(recoverCriteriaFromPromotedSource(parsedYaml.source), generated.source, `seed=${seed}`);
	}
	for (const category of [
		"eol:lf",
		"eol:crlf",
		"eol:cr",
		"terminal-breaks:0",
		"terminal-breaks:1",
		"terminal-breaks:2",
		"yaml-metacharacters",
		"embedded-fences",
		"unicode",
		"tabs",
		"trailing-spaces",
		"trailing-tab",
		"internal-empty-line",
		"heading-like",
		"very-long-line",
	]) assert.ok(covered.has(category), `generator category missing: ${category}`);
	assert.ok(maximumPhysicalLine >= 12_000);
});

test("line-ending metadata in a source path cannot create a YAML line", () => {
	for (const sourcePath of ["draft.md\ninjected: true", "draft.md\rinjected: true"]) {
		const parsed = parseDraft("## Acceptance criteria <!-- work:criteria -->\n- A1: works\n", sourcePath);
		assert.equal(parsed.ok, true);
		if (!parsed.ok) continue;
		const promoted = promoteDraft(parsed);
		assert.equal(promoted.ok, true);
		if (!promoted.ok) continue;
		const validation = validateWorkspec(promoted.specSource);
		assert.equal(validation.structuralValid, false, sourcePath);
		assert.equal(validation.valid, false, sourcePath);
		assert.ok(validation.findings.some((finding) => finding.code === "schema-required" && finding.path.join(".") === "work.0.acceptance"), sourcePath);
		const parsedYaml = parseYaml(promoted.specSource);
		assert.equal(parsedYaml.findings.length, 0, sourcePath);
		const value = parsedYaml.value as { work?: { refs?: { path?: string }[] }[] } | undefined;
		assert.equal(value?.work?.[0]?.refs?.[0]?.path, sourcePath);
		assert.equal(promoted.specSource.split("\n").filter((line) => line.startsWith("# Generated")).length, 1);
	}
});

test("lossless recovery uses retained ParsedYaml.source, not Document#toString()", () => {
	const criteria = "- A1: CRLF and trailing  \r\n  tabs\t✓\r\n";
	const parsed = parseDraft(`## Acceptance criteria <!-- work:criteria -->\r\n${criteria}`, "source.md");
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const promoted = promoteDraft(parsed);
	assert.equal(promoted.ok, true);
	if (!promoted.ok) return;
	const parsedYaml = parseYaml(promoted.specSource);
	assert.equal(recoverCriteriaFromPromotedSource(parsedYaml.source), criteria);
	assert.notEqual(parsedYaml.document?.toString(), parsedYaml.source);
});
