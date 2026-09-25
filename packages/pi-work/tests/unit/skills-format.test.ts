import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";

import { REGION_MARKERS } from "../../src/promote/regions.ts";
import { workPlanTool, type WorkPlanDetails } from "../../src/tools/work-plan.ts";
import { workValidateTool, type WorkValidateDetails } from "../../src/tools/work-validate.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const skillNames = ["work-authoring", "work-decomposition", "work-execution"] as const;

async function writeDecompositionFixture(cwd: string): Promise<void> {
	const source = await readFile(path.join(REPO_ROOT, "tests/fixtures/skills/decomposition-valid.yaml"), "utf8");
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage(source, { cwd }));
}

function namedDependencies(source: string): Set<string> {
	const dependencies = new Set<string>();
	for (const paragraph of source.split(/\n\s*\n/)) {
		if (!/\b(?:[Ll]oad|reuse)\b/.test(paragraph)) continue;
		for (const match of paragraph.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) dependencies.add(match[1]);
	}
	return dependencies;
}

function declaredDependencyLocations(source: string): Map<string, string> {
	return new Map([...source.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)` from `([^`]+\/SKILL\.md)`/g)]
		.map((match) => [match[1], match[2]]));
}

function dependenciesDeclaredByName(source: string): Set<string> {
	const dependencies = new Set<string>();
	for (const paragraph of source.split(/\n\s*\n/)) {
		if (!/\bby name\b/.test(paragraph)) continue;
		for (const dependency of namedDependencies(paragraph)) dependencies.add(dependency);
	}
	return dependencies;
}

function assertDependenciesResolvable(source: string, skillRoot: string): void {
	const locations = declaredDependencyLocations(source);
	const loadedByName = dependenciesDeclaredByName(source);
	for (const dependency of namedDependencies(source)) {
		const localPath = path.join(skillRoot, dependency, "SKILL.md");
		const declared = locations.get(dependency);
		assert.ok(
			existsSync(localPath) || loadedByName.has(dependency) || declared?.match(/^@[^/]+\/[^/]+\/(?:[^/]+\/)*SKILL\.md$/),
			`${dependency} must resolve locally, be loaded by name, or state its package-qualified SKILL.md location`,
		);
	}
}

function frontmatter(source: string, filePath: string): Record<string, unknown> {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	assert.ok(match, `${filePath} must start with YAML frontmatter`);
	const parsed = parseDocument(match[1]).toJS();
	assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${filePath} frontmatter must be a mapping`);
	return parsed as Record<string, unknown>;
}

test("pi-work skills use discoverable Agent Skills format", async () => {
	const skillRoot = path.join(REPO_ROOT, "skills");
	const discovered = loadSkillsFromDir({ dir: skillRoot, source: "project" });
	assert.deepEqual(discovered.diagnostics, []);
	assert.deepEqual(discovered.skills.map((skill) => skill.name).sort(), [...skillNames].sort());

	for (const name of skillNames) {
		const filePath = path.join(skillRoot, name, "SKILL.md");
		const source = await readFile(filePath, "utf8");
		const metadata = frontmatter(source, filePath);
		assert.equal(metadata.name, name);
		assert.equal(typeof metadata.description, "string");
		assert.ok((metadata.description as string).length > 20);
		const loaded = discovered.skills.find((skill) => skill.name === name);
		assert.ok(loaded, `${name} should be returned by discovery`);
		assert.equal(loaded.filePath, filePath);
		assert.equal(loaded.baseDir, path.dirname(filePath));
		assert.equal(loaded.disableModelInvocation, false);
		assertDependenciesResolvable(source, skillRoot);
	}
});

test("skill dependency check rejects an unresolvable named dependency", () => {
	assert.throws(
		() => assertDependenciesResolvable("Load and reuse\n`missing-skill` before continuing.", path.join(REPO_ROOT, "skills")),
		/missing-skill must resolve locally, be loaded by name, or state its package-qualified SKILL\.md location/,
	);
});

test("decomposition fixture passes the real work_validate tool", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-skills-validate-"));
	await writeDecompositionFixture(cwd);
	const result = await workValidateTool.execute(
		"test",
		{ path: "spec.yaml" },
		undefined,
		undefined,
		{ cwd } as never,
	) as unknown as { details: WorkValidateDetails };
	assert.equal(result.details.valid, true);
	assert.equal(result.details.errorCount, 0);
	assert.equal(result.details.warningCount, 0);
});

test("decomposition fixture compiles as a three-node dry-run plan", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-skills-plan-"));
	await writeDecompositionFixture(cwd);
	const result = await workPlanTool.execute(
		"test",
		{
			path: "spec.yaml",
			nodeAddresses: [["source"], ["copy"], ["publish"]],
		},
		undefined,
		undefined,
		{ cwd } as never,
	) as unknown as { details: WorkPlanDetails };
	assert.equal(result.details.valid, true);
	assert.equal(result.details.plans.length, 3);
	assert.equal(result.details.worktree, true);
	assert.deepEqual(result.details.advisories, []);
});

test("skills preserve draft-backed lineage and route criterion text changes through the amendment act", async () => {
	const decomposition = await readFile(path.join(REPO_ROOT, "skills", "work-decomposition", "SKILL.md"), "utf8");
	assert.match(decomposition, /Validation re-reads the\s+named draft/);
	assert.match(decomposition, /repointing the visible path/);
	const execution = await readFile(path.join(REPO_ROOT, "skills", "work-execution", "SKILL.md"), "utf8");
	assert.match(execution, /work_amend_criterion\(\{/);
	assert.match(execution, /criterion-draft-unavailable/);
	assert.match(execution, /Splitting or merging criteria/);
});

test("every promotion region marker is documented in the authoring skill", async () => {
	// The work:decisions region shipped without reaching this skill, so a draft author
	// following the documentation never learned it existed. Adding a marker to
	// REGION_MARKERS must now fail here until the skill that teaches drafting says so.
	const source = await readFile(path.join(REPO_ROOT, "skills/work-authoring/SKILL.md"), "utf8");
	const undocumented = Object.entries(REGION_MARKERS)
		.filter(([, marker]) => !source.includes(marker))
		.map(([name, marker]) => `${name} (${marker})`);
	assert.deepEqual(
		undocumented,
		[],
		`skills/work-authoring/SKILL.md must show every draft region it asks an author to write:\n${undocumented.join("\n")}`,
	);
});

test("region-count guidance names four markers without making decisions mandatory", async () => {
	const skillSource = await readFile(path.join(REPO_ROOT, "skills/work-authoring/SKILL.md"), "utf8");
	const scannerSource = await readFile(path.join(REPO_ROOT, "src/promote/regions.ts"), "utf8");
	const countGuidance = /(?:with|contain) up to four marked regions:\s+summary,\s+rationale,\s+criteria,\s+and optional decisions\./g;

	assert.equal(Object.keys(REGION_MARKERS).length, 4);
	assert.equal([...skillSource.matchAll(countGuidance)].length, 2);
	assert.doesNotMatch(skillSource, /\bthree marked regions\b/);
	assert.match(scannerSource, /Locate all four recognized regions; the decisions region is optional\./);
	assert.doesNotMatch(scannerSource, /Locate the three marked regions/);
});
