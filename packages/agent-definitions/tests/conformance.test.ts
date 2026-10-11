import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDefinition, type ParseOptions } from "../src/index.ts";

// The manifest was written from the format decisions, without running the parser,
// so it is an independent oracle for parseDefinition.

interface Entry {
	file: string;
	expect: "valid" | "invalid" | "converter";
	options?: ParseOptions;
	errors?: { path: string }[];
	warnings?: { path: string }[];
	values?: Record<string, unknown>;
}

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const entries = JSON.parse(readFileSync(resolve(fixturesRoot, "manifest.json"), "utf8")) as Entry[];

function at(value: unknown, path: string): unknown {
	let current = value;
	for (const key of path.split(".")) {
		assert.ok(
			typeof current === "object" && current !== null && Object.hasOwn(current, key),
			`missing ${path} in the parsed definition`,
		);
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function paths(list: { path: string }[] | undefined): string[] {
	return (list ?? []).map(({ path }) => path).sort();
}

describe("conformance fixtures", () => {
	for (const entry of entries.filter(({ expect }) => expect !== "converter")) {
		it(`${entry.file} parses as the manifest expects`, () => {
			const result = parseDefinition(readFileSync(resolve(fixturesRoot, entry.file), "utf8"), entry.options ?? {});
			const bySeverity = (severity: string) =>
				paths(result.diagnostics.filter((diagnostic) => diagnostic.severity === severity));
			assert.deepEqual(bySeverity("error"), paths(entry.errors));
			assert.deepEqual(bySeverity("warning"), paths(entry.warnings));
			assert.equal(result.ok, entry.expect === "valid");
			if (!result.ok) return;
			for (const [path, expected] of Object.entries(entry.values ?? {})) {
				assert.deepEqual(at(result.definition, path), expected, path);
			}
		});
	}
});
