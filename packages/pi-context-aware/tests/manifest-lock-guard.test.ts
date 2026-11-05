import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Compiled to .test-dist/tests; the TypeScript sources live in the repository's src/.
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return /\.(ts|mjs|js)$/.test(entry.name) ? [full] : [];
	});
}

// writeManifest is the raw, unlocked write. Only the cache module may call it, twice: in
// mutateManifest and in migrateCachePoolLocked, which already runs inside withManifestLock.
const ALLOWED = new Map<string, number>([["cache/context-cache.ts", 2]]);

test("no src file calls writeManifest except the locked helper", () => {
	const files = sourceFiles(SRC);
	assert.ok(files.length > 50, "the scan must see the source tree");
	const offenders: string[] = [];
	for (const file of files) {
		const relative = path.relative(SRC, file).split(path.sep).join("/");
		const calls = fs.readFileSync(file, "utf8").split("\n")
			.filter((line) => /\bwriteManifest\s*\(/.test(line) && !/^\s*(export function|\*|\/\/)/.test(line)).length;
		if (calls !== (ALLOWED.get(relative) ?? 0)) offenders.push(`${relative}: ${calls} call(s)`);
	}
	assert.deepEqual(offenders, []);
});
