import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Source lives in src/, tests in tests/, documentation in docs/, design record in
// .spec/. A new top-level entry needs a reason: add it here, in the same change.
// Modelled on pi-caair-dev-tools/tools/tests/root-clean.test.ts.
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const IGNORED_ROOT_ENTRIES = new Set([".git", ".public-release-check", ".public-release-check.tar", ".npm", ".pi", ".worktrees", ".test-dist", ".coverage-tmp", "coverage", "dist", "node_modules", "package-dist"]);
export const ALLOWED_ROOT_ENTRIES = new Set([
	".gitattributes",
	".githooks",
	".gitignore",
	".gitlab",
	".gitlab-ci.yml",
	".graft", // Repository workflow records.
	".public-release.json",
	".spec", // Design record: briefs, plans, measurements.
	"LICENSE",
	"README.md",
	"docs", // Published documentation and the service contract.
	"eslint.config.js",
	"package-lock.json",
	"package.json",
	"scripts",
	"src",
	"tests",
	"tsconfig.build.json",
	"tsconfig.json",
	"tsconfig.test.json",
]);

/** Root entries not on the allowlist. Pure, so the test can prove it rejects a stray file. */
export function unexpectedRootEntries(entries) {
	return entries.filter((entry) => !IGNORED_ROOT_ENTRIES.has(entry) && !ALLOWED_ROOT_ENTRIES.has(entry)).sort();
}

function trackedRootEntries() {
	const result = spawnSync("git", ["ls-files", "-z"], { cwd: PACKAGE_ROOT, encoding: "utf8" });
	if (result.status === 0 && typeof result.stdout === "string" && result.stdout.length > 0) {
		return [...new Set(result.stdout.split("\0").filter(Boolean).map((path) => path.split("/")[0]))];
	}
	// No repository (for example the public export): fall back to the directory listing.
	return readdirSync(PACKAGE_ROOT);
}

test("the root allowlist rejects a stray source file", () => {
	assert.deepEqual(unexpectedRootEntries(["package.json", "src", "index.ts", "notes.md"]), ["index.ts", "notes.md"]);
	assert.deepEqual(unexpectedRootEntries(["package.json", "src", "node_modules"]), []);
	// The public-release check template leaves its export and archive in CI project copies.
	assert.deepEqual(unexpectedRootEntries(["package.json", ".public-release-check", ".public-release-check.tar"]), []);
});

test("no source, spec, or scratch file sits at the repository root", () => {
	assert.deepEqual(
		unexpectedRootEntries(trackedRootEntries()),
		[],
		"a new top-level entry needs a place: src/ for code, docs/ for published documentation, .spec/ for design record (see root-clean.test.mjs)",
	);
});
