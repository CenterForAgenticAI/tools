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

// The other cache writers derive a new manifest from the one they are given, so they lose
// updates unless the caller holds the manifest lock too.
const GUARDED: readonly string[] = ["writeCacheFile", "promoteCacheFile", "deleteCacheFile", "runCleanup"];
const LOCKERS = new Set(["mutateManifest", "withManifestLock"]);

interface Call {
	name: string;
	locked: boolean;
}

// Walks the source once, skipping comments and string literals, and keeps a stack of the
// callee name of every open parenthesis. A guarded call is locked when any open call on the
// stack is a locker. Function definitions are not calls.
function scanGuardedCalls(text: string): { calls: Call[]; balanced: boolean } {
	const calls: Call[] = [];
	const stack: string[] = [];
	let balanced = true;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
			continue;
		}
		if (ch === "/" && /(?:^|[(,=:[!&|?{};])\s*$/.test(text.slice(Math.max(0, i - 40), i))) {
			// A regular expression literal: its quotes and parentheses are not code.
			i++;
			let inClass = false;
			while (i < text.length && (inClass || text[i] !== "/")) {
				if (text[i] === "\\") i++;
				else if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				i++;
			}
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			i++;
			while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
			i++;
			continue;
		}
		if (ch === "(") {
			const head = text.slice(Math.max(0, i - 80), i);
			const before = /([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(head);
			const name = before ? before[1] : "";
			const isDefinition = /\bfunction\s+[\w$]+\s*(?:<[^()]*>)?\s*$/.test(head);
			if (!isDefinition && GUARDED.includes(name)) {
				calls.push({ name, locked: stack.some((open) => LOCKERS.has(open)) });
			}
			stack.push(isDefinition ? "" : name);
		} else if (ch === ")") {
			if (stack.pop() === undefined) balanced = false;
		}
		i++;
	}
	return { calls, balanced: balanced && stack.length === 0 };
}

// Unlocked calls that are allowed: runCleanup deletes files itself, and its own callers
// are checked to hold the lock.
const UNLOCKED_ALLOWED = new Map<string, number>([["cache/context-cache.ts:deleteCacheFile", 2]]);
// Known locked call sites per function, so a scan that matches nothing fails.
const EXPECTED_LOCKED = { writeCacheFile: 2, promoteCacheFile: 1, deleteCacheFile: 1, runCleanup: 2 };

test("no src file calls the other cache writers outside the manifest lock", () => {
	const unlocked = new Map<string, number>();
	const lockedTotals: Record<string, number> = {};
	for (const file of sourceFiles(SRC)) {
		const relative = path.relative(SRC, file).split(path.sep).join("/");
		const text = fs.readFileSync(file, "utf8");
		// Files that never name a guarded function cannot hold a call, so the scan skips them.
		if (!GUARDED.some((name) => text.includes(name))) continue;
		const { calls, balanced } = scanGuardedCalls(text);
		assert.ok(balanced, `${relative}: the scan lost track of parentheses`);
		for (const call of calls) {
			if (call.locked) lockedTotals[call.name] = (lockedTotals[call.name] ?? 0) + 1;
			else {
				const key = `${relative}:${call.name}`;
				unlocked.set(key, (unlocked.get(key) ?? 0) + 1);
			}
		}
	}
	const offenders = [...unlocked].filter(([key, count]) => count !== (UNLOCKED_ALLOWED.get(key) ?? 0)).map(([key, count]) => `${key}: ${count} unlocked call(s)`);
	for (const [key, count] of UNLOCKED_ALLOWED) if (unlocked.get(key) !== count) offenders.push(`${key}: expected ${count} unlocked call(s)`);
	assert.deepEqual(offenders, []);
	assert.deepEqual(lockedTotals, EXPECTED_LOCKED);
});

test("the scan classifies locked, bare, commented and defined calls", () => {
	const sample = [
		"export function writeCacheFile(a) { return a; }",
		"// writeCacheFile(x)",
		"/* deleteCacheFile(x) */",
		'mutateManifest(dir, (m) => { const s = "promoteCacheFile("; return writeCacheFile(dir, m); });',
		"runCleanup(dir, m);",
	].join("\n");
	assert.deepEqual(scanGuardedCalls(sample), {
		calls: [{ name: "writeCacheFile", locked: true }, { name: "runCleanup", locked: false }],
		balanced: true,
	});
});
