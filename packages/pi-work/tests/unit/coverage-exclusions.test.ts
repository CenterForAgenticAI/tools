/**
 * Guard the coverage exclusions in .c8rc.json.
 *
 * `all: true` makes c8 count every file under src/, including ones that emit no
 * runtime code at all. A type-only module compiles to `export {};` -- there is
 * nothing in it that could ever execute, so counting its source lines measures
 * nothing and silently drags the whole tree's statement and line percentages
 * down. src/plan/types.ts is 116 source lines that compile to 44 bytes; leaving
 * it counted cost the composed tree 5.5 points of statement coverage.
 *
 * Excluding such a file is only safe while it stays empty of runtime code. The
 * danger is an exclusion that quietly outlives its justification: someone adds a
 * real function to an excluded module and it stops being measured, with nothing
 * to say so. Excluding by filename convention (src/**\/types.ts) has exactly
 * that failure mode, and it would already be wrong here -- src/promote/types.ts
 * carries a runtime brand symbol and is correctly measured at 100%.
 *
 * So each exclusion is named individually and checked here: the source must
 * still exist, and its compiled output must still contain no executable code.
 * Both halves matter. Without the existence check a renamed file would make this
 * guard pass by vacuum, which is the failure mode the project exists to prevent.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../helpers/source-under-test.ts";

const C8RC = path.join(REPO_ROOT, ".c8rc.json");
const COMPILED_ROOT = path.join(REPO_ROOT, ".test-dist");

/** Exclusions that name one concrete source file, rather than a wildcard. */
function concreteExclusions(): string[] {
	const config: unknown = JSON.parse(readFileSync(C8RC, "utf8"));
	assert.ok(
		typeof config === "object" && config !== null && Array.isArray((config as { exclude?: unknown }).exclude),
		".c8rc.json must carry an exclude array",
	);
	const exclude = (config as { exclude: unknown[] }).exclude;
	return exclude.filter((entry): entry is string => typeof entry === "string" && !entry.includes("*"));
}

/** Compiled text with comments and the sourcemap pragma removed. */
function executableText(compiled: string): string {
	return compiled
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

test("every concrete coverage exclusion names a source file that still exists", () => {
	const exclusions = concreteExclusions();
	assert.ok(exclusions.length > 0, "expected at least one concrete exclusion to guard");
	for (const relative of exclusions) {
		assert.ok(
			existsSync(path.join(REPO_ROOT, relative)),
			`.c8rc.json excludes ${relative}, which no longer exists. An exclusion pointing at a missing ` +
				`file makes this guard vacuous: delete the exclusion, or point it at the file's new path.`,
		);
	}
});

test("every excluded module still compiles to no runtime code", () => {
	for (const relative of concreteExclusions()) {
		const compiledPath = path.join(COMPILED_ROOT, relative.replace(/\.ts$/, ".js"));
		assert.ok(
			existsSync(compiledPath),
			`no compiled output at ${path.relative(REPO_ROOT, compiledPath)} for excluded module ${relative}. ` +
				`Run npm run test:compile first; a missing artifact cannot be checked.`,
		);
		const executable = executableText(readFileSync(compiledPath, "utf8"));
		assert.equal(
			executable,
			"export {};",
			`${relative} is excluded from coverage because it emits no runtime code, but its compiled output ` +
				`now contains executable statements:\n\n${executable}\n\n` +
				`That code is no longer being measured by anything. Either remove the exclusion and let the ` +
				`new code be covered by real tests, or move the runtime code out of this module.`,
		);
	}
});
