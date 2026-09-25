/**
 * Guard the dual source/compiled test layout. The normal suite runs emitted
 * JavaScript from .test-dist/, while tsx runs committed TypeScript directly.
 * The two forbidden constructs below are silent on the tsx path and fail only
 * once the compiled suite reaches them.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../helpers/source-under-test.ts";

const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const HELPER = path.join(TESTS_ROOT, "helpers", "source-under-test.ts");
const TSX_EXEMPTION = /scripts\//;

function testSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return testSourceFiles(entryPath);
		return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
	});
}

function isComment(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function offendingLines(contents: string, pattern: RegExp): { line: number; text: string }[] {
	return contents
		.split("\n")
		.map((text, index) => ({ line: index + 1, text }))
		.filter((entry) => !isComment(entry.text) && pattern.test(entry.text));
}

test("no test builds a src module path as a string with a .ts extension", () => {
	const pattern = /new URL\(\s*["'`](?:\.\.\/)+src\/[^"'`]*\.ts["'`]/;
	const violations: string[] = [];
	for (const file of testSourceFiles(TESTS_ROOT)) {
		if (file === HELPER) continue;
		for (const { line, text } of offendingLines(readFileSync(file, "utf8"), pattern)) {
			violations.push(`${path.relative(REPO_ROOT, file)}:${line}: ${text.trim()}`);
		}
	}
	assert.deepEqual(
		violations,
		[],
		`Build the path with sourceModuleUrl() from tests/helpers/source-under-test.ts, which picks the extension of the layout in use:\n${violations.join("\n")}`,
	);
});

test("no test hard-codes --import tsx for a spawned child", () => {
	const pattern = /["'`]--import["'`]\s*,\s*["'`]tsx["'`]/;
	const violations: string[] = [];
	for (const file of testSourceFiles(TESTS_ROOT)) {
		if (file === HELPER) continue;
		const contents = readFileSync(file, "utf8");
		for (const { line, text } of offendingLines(contents, pattern)) {
			const window = contents.split("\n").slice(Math.max(0, line - 4), line + 4).join("\n");
			if (TSX_EXEMPTION.test(window)) continue;
			violations.push(`${path.relative(REPO_ROOT, file)}:${line}: ${text.trim()}`);
		}
	}
	assert.deepEqual(
		violations,
		[],
		`Use childLoaderArgs() from tests/helpers/source-under-test.ts, which is empty under the compiled layout:\n${violations.join("\n")}`,
	);
});
