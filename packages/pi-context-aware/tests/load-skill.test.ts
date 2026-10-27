import assert from "node:assert/strict";
import test from "node:test";

import { availableNames, resolveSkill, type DiscoveredSkill } from "../src/skills/load-skill.js";

const SKILLS: DiscoveredSkill[] = [
	{ name: "glab", description: "GitLab CLI", filePath: "/pkg/modules/glab/skills/glab/SKILL.md" },
	{ name: "test-execution", description: "Test worker contract", filePath: "/pkg/skills/test-execution/SKILL.md" },
	{ name: "herdr", description: "Terminal multiplexer", filePath: "/agent/skills/herdr/SKILL.md" },
];

test("a discovered name resolves to the path Pi recorded", () => {
	const result = resolveSkill("glab", SKILLS);
	assert.equal(result.ok, true);
	assert.ok(result.ok);
	assert.equal(result.skill.filePath, "/pkg/modules/glab/skills/glab/SKILL.md");
	assert.deepEqual(result.shadowed, []);
});

test("surrounding whitespace does not stop a name resolving", () => {
	const result = resolveSkill("  test-execution\n", SKILLS);
	assert.ok(result.ok);
	assert.equal(result.skill.name, "test-execution");
});

test("a differently cased name resolves rather than sending the agent back to guessing", () => {
	const result = resolveSkill("Glab", SKILLS);
	assert.ok(result.ok);
	assert.equal(result.skill.name, "glab");
});

test("an unknown name is refused and the answer names what is available", () => {
	const result = resolveSkill("gitlab", SKILLS);
	assert.equal(result.ok, false);
	assert.ok(!result.ok);
	assert.equal(result.reason, "unknown");
	assert.match(result.message, /glab, herdr, test-execution/);
	assert.match(result.message, /Do not construct a skill path/);
});

/**
 * The rule is not "this module does not build a path". It is that no string a
 * caller supplies can cause a read outside the discovered set. Each of these
 * would be a file read if the name were ever concatenated into a path, and each
 * must come back refused — including the one whose basename is a real skill.
 */
for (const hostile of [
	"../../etc/passwd",
	"/etc/passwd",
	"../glab",
	"glab/../../../../etc/shadow",
	"glab\u0000",
	"skills/glab/SKILL.md",
	"~/.pi/agent/skills/glab/SKILL.md",
]) {
	test(`a path-shaped name is refused: ${JSON.stringify(hostile)}`, () => {
		const result = resolveSkill(hostile, SKILLS);
		assert.equal(result.ok, false, `${hostile} must not resolve`);
		assert.ok(!result.ok);
		assert.equal(result.reason, "unknown");
	});
}

test("a resolved skill carries only a path from the discovered set", () => {
	// Whatever a caller sends, the returned path is one Pi recorded. Proving the
	// property directly is stronger than listing hostile inputs one at a time.
	const paths = new Set(SKILLS.map((skill) => skill.filePath));
	for (const requested of ["glab", "GLAB", " herdr ", "test-execution"]) {
		const result = resolveSkill(requested, SKILLS);
		assert.ok(result.ok, `${requested} should resolve`);
		assert.ok(paths.has(result.skill.filePath), `${requested} returned an unrecorded path`);
	}
});

test("an empty name is refused without claiming the skill is unknown", () => {
	const result = resolveSkill("   ", SKILLS);
	assert.ok(!result.ok);
	assert.equal(result.reason, "empty-name");
});

test("a session with no discovered skills says so instead of failing as unknown", () => {
	const result = resolveSkill("glab", []);
	assert.ok(!result.ok);
	assert.equal(result.reason, "no-skills");
	assert.match(result.message, /Do not construct a skill path/);
});

test("a shadowed name resolves to the last discovered copy and reports the rest", () => {
	const shadowedSkills: DiscoveredSkill[] = [
		{ name: "implement", description: "package copy", filePath: "/pkg/skills/implement/SKILL.md" },
		{ name: "implement", description: "project copy", filePath: "/repo/.pi/skills/implement/SKILL.md" },
	];
	const result = resolveSkill("implement", shadowedSkills);
	assert.ok(result.ok);
	assert.equal(result.skill.filePath, "/repo/.pi/skills/implement/SKILL.md");
	assert.deepEqual(result.shadowed, ["/pkg/skills/implement/SKILL.md"]);
});

test("available names are unique and sorted", () => {
	assert.deepEqual(availableNames([...SKILLS, ...SKILLS]), ["glab", "herdr", "test-execution"]);
});
