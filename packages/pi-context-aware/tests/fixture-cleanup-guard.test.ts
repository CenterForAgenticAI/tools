import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pi-context-aware#360, structural guard: a test file that points
// PI_CODING_AGENT_DIR at a temp directory must remove directories through
// removeFixtureDir (which waits for the metrics recorder), never a bare rmSync.

const here = path.dirname(fileURLToPath(import.meta.url));
// Under `npm test` this file runs from `.test-dist/tests`, which holds compiled .js only; scan the source tests/.
const testsDir = here.split(path.sep).includes(".test-dist") ? path.resolve(here, "..", "..", "tests") : here;

/** Files whose temp directories never see a recorder write, with the reason. */
const ALLOWED: Readonly<Record<string, string>> = {
	"manual/cross-repo-delegate-seam.mjs": "manual script, runs no extension",
	"with-temp-root-env.test.mjs": "tests the temp-root script, runs no extension",
	"pilot-child-process.test.ts": "no bare recursive rmSync",
};

export function violations(source: string): string[] {
	if (!/PI_CODING_AGENT_DIR/u.test(source)) return [];
	if (/\bremoveFixtureDir(?:Now)?\b/u.test(source) === false && !/rmSync\([^)]*recursive/u.test(source)) return [];
	// Only a bare directory variable is the fixture root; `path.join(root, "x")` removes a subpath the recorder never writes.
	return source.split("\n").filter((line) => /\brmSync\(\s*[A-Za-z_$][\w$.]*\s*,/u.test(line) && /recursive/u.test(line));
}

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "fixtures" || entry.name === "acp-kernel" ? [] : walk(full);
		return /\.(ts|mjs)$/u.test(entry.name) ? [full] : [];
	});
}

test("the guard flags a fixture that deletes an agent directory with a bare rmSync", () => {
	const bad = "process.env.PI_CODING_AGENT_DIR = dir;\nfs.rmSync(dir, { recursive: true, force: true });\n";
	assert.equal(violations(bad).length, 1);
	assert.deepEqual(violations("process.env.PI_CODING_AGENT_DIR = dir;\nawait removeFixtureDir(dir);\n"), []);
});

test("no test that sets PI_CODING_AGENT_DIR removes a directory with a bare recursive rmSync", () => {
	const offenders: string[] = [];
	const files = walk(testsDir);
	assert.ok(files.length > 100, `guard scanned only ${files.length} files under ${testsDir}`);
	for (const file of files) {
		const rel = path.relative(testsDir, file).split(path.sep).join("/");
		if (rel === "fixture-cleanup.ts" || rel === "fixture-cleanup-guard.test.ts" || rel in ALLOWED) continue;
		const found = violations(fs.readFileSync(file, "utf8"));
		if (found.length > 0) offenders.push(`${rel}: ${found.length} bare rmSync`);
	}
	assert.deepEqual(offenders, []);
});
