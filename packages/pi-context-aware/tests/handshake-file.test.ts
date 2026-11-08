import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ATOMIC_WRITE_SOURCE, writeFileAtomic } from "./handshake-file.js";

const PAYLOAD_BYTES = 2_000_000;
const WRITES = 40;

/** A child that rewrites one file in a tight loop, either plainly or atomically. */
function writerSource(file: string, atomic: boolean): string {
	return `
const fs = require("node:fs");
${ATOMIC_WRITE_SOURCE}
const text = JSON.stringify({ filler: "x".repeat(${PAYLOAD_BYTES}) });
for (let index = 0; index < ${WRITES}; index += 1) {
  try { fs.unlinkSync(${JSON.stringify(file)}); } catch {}
  ${atomic ? `writeFileAtomic(${JSON.stringify(file)}, text)` : `fs.writeFileSync(${JSON.stringify(file)}, text)`};
}
`;
}

/** Poll existsSync then read, as the waiting tests do; count reads that do not parse. */
async function probe(atomic: boolean): Promise<{ reads: number; torn: number }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "handshake-file-"));
	const file = path.join(root, "ready.json");
	try {
		const child = spawn(process.execPath, ["-e", writerSource(file, atomic)], { stdio: "ignore" });
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		let done = false;
		void exited.then(() => { done = true; });
		let reads = 0;
		let torn = 0;
		while (!done) {
			if (fs.existsSync(file)) {
				let text: string;
				try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
				reads += 1;
				try { JSON.parse(text); } catch { torn += 1; }
			}
			await delay(0);
		}
		return { reads, torn };
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("writeFileAtomic never exposes an empty or partial file to a concurrent reader", async () => {
	const result = await probe(true);
	assert.ok(result.reads > 0, "the probe read the file at least once");
	assert.equal(result.torn, 0, `${result.torn} of ${result.reads} reads were empty or partial`);
});

test("the probe detects the race with a plain writeFileSync (control)", async (t) => {
	let torn = 0;
	for (let attempt = 0; attempt < 5 && torn === 0; attempt += 1) torn += (await probe(false)).torn;
	if (torn === 0) {
		t.skip("this platform did not show the create-then-fill race within 5 attempts; the guard test below does not depend on timing");
		return;
	}
	assert.ok(torn > 0);
});

test("writeFileAtomic writes the text and leaves no temporary file", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "handshake-file-"));
	try {
		const file = path.join(root, "out.json");
		writeFileAtomic(file, '{"a":1}');
		assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
		assert.deepEqual(fs.readdirSync(root), ["out.json"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Structural guard. A test file that checks a handshake file for existence and then reads its
// content must not write that file with a plain writeFileSync.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\.test-dist[\\/]tests$/u, "tests");
// Existence-only markers: nobody reads their content.
const EXISTENCE_ONLY = new Set(["child-ready"]);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Return the names of handshake files that one test file's source writes with a plain writeFileSync. */
export function plainHandshakeWrites(source: string): string[] {
	const violations: string[] = [];
	const declaration = /(?:const|let)\s+(\w+)\s*=\s*path\.join\([^,()]+,\s*"([^"]+)"\)/gu;
	for (const match of source.matchAll(declaration)) {
		const [, variable, name] = match;
		if (EXISTENCE_ONLY.has(name)) continue;
		const checked = new RegExp("(?:existsSync|waitForFile)\\(" + variable + "\\b", "u").test(source);
		// A parse is what a half-written file breaks: JSON.parse, Number or parseInt around the read.
		const read = new RegExp("(?:JSON\\.parse|Number|parseInt|Number\\.parseInt)\\(fs\\.readFileSync\\(" + variable + "\\b", "u").test(source);
		if (!checked || !read) continue;
		const byVariable = new RegExp("writeFileSync\\((?:\\$\\{JSON\\.stringify\\(" + variable + "\\)\\}|" + variable + ")\\s*,", "u");
		const byLiteral = new RegExp("writeFileSync\\(path\\.join\\([^,()]+,\\s*\"" + escapeRegExp(name) + "\"\\)\\s*,", "u");
		if (byVariable.test(source) || byLiteral.test(source)) violations.push(name);
	}
	return violations;
}

test("the guard flags a plain writer of a waited-on, read handshake file", () => {
	const bad = [
		'const f = path.join(root, "ready.json");',
		"await waitForFile(f);",
		'JSON.parse(fs.readFileSync(f, "utf8"));',
		'fs.writeFileSync(path.join(root, "ready.json"), "{}");',
	].join("\n");
	assert.deepEqual(plainHandshakeWrites(bad), ["ready.json"]);
	const badVariable = [
		'const f = path.join(root, "x.pid");',
		"if (fs.existsSync(f)) Number(fs.readFileSync(f, \"utf8\"));",
		'`fs.writeFileSync(${JSON.stringify(f)}, "1")`;',
	].join("\n");
	assert.deepEqual(plainHandshakeWrites(badVariable), ["x.pid"]);
	assert.deepEqual(plainHandshakeWrites(bad.replace('fs.writeFileSync(path.join(root, "ready.json"), "{}")', 'writeFileAtomic(path.join(root, "ready.json"), "{}")')), []);
	assert.deepEqual(plainHandshakeWrites(bad.replace("await waitForFile(f);", "")), []);
});

test("no test file writes a waited-on, read handshake file with a plain writeFileSync", () => {
	const found: string[] = [];
	for (const entry of fs.readdirSync(TESTS_DIR)) {
		if (!/\.test\.(?:ts|mjs)$/u.test(entry) || entry === "handshake-file.test.ts") continue;
		for (const name of plainHandshakeWrites(fs.readFileSync(path.join(TESTS_DIR, entry), "utf8"))) found.push(entry + ": " + name);
	}
	assert.deepEqual(found, []);
});
