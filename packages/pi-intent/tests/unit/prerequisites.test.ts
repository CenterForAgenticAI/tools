import assert from "node:assert/strict";
import test from "node:test";

import { PREREQUISITES, loadedPackages, missingPrerequisites, prerequisiteNotice } from "../../src/prerequisites.js";

const ALL_PACKAGES = [
	{ source: "npm:pi-fabric" },
	{ source: "npm:@centerforagenticai/pi-work@0.1.2" },
	{ source: "local", baseDir: "/home/user/.pi/agent/npm/node_modules/@centerforagenticai/pi-delegate/" },
	{ source: "npm:@centerforagenticai/pi-artifacts" },
];
const present = () => true;
const absent = () => false;

test("loadedPackages reads npm sources, strips versions and resolves scoped package directories", () => {
	const names = loadedPackages(ALL_PACKAGES);
	for (const n of ["pi-fabric", "@centerforagenticai/pi-work", "@centerforagenticai/pi-delegate", "@centerforagenticai/pi-artifacts"]) assert.ok(names.has(n), n);
	assert.ok(!names.has("@centerforagenticai/pi-work@0.1.2"));
});

test("nothing is missing when every package is loaded and every command resolves", () => {
	assert.deepEqual(missingPrerequisites(ALL_PACKAGES, present), []);
	assert.equal(prerequisiteNotice([]), undefined);
});

test("an unloaded package and an unresolved command are both reported", () => {
	const sources = ALL_PACKAGES.filter((s) => s.source !== "npm:pi-fabric");
	const missing = missingPrerequisites(sources, (command) => command !== "jev-fabric").map((p) => p.label);
	assert.deepEqual(missing, ["pi-fabric", "jev-fabric"]);
});

test("a package whose name merely contains a prerequisite does not satisfy it", () => {
	const missing = missingPrerequisites([{ source: "npm:not-pi-fabric" }, { source: "npm:pi-fabric-extra" }], present).map((p) => p.label);
	assert.ok(missing.includes("pi-fabric"));
});

test("the notice names each missing prerequisite with its install command", () => {
	const notice = prerequisiteNotice(missingPrerequisites([], absent)) ?? "";
	assert.match(notice, /6 prerequisites are missing, so pi-intent will not work correctly/);
	for (const p of PREREQUISITES) assert.ok(notice.includes(p.install), p.label);
});
