import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { writeDefinition } from "../src/write-definition.ts";

interface ManifestEntry {
	readonly file: string;
	readonly expect: "valid" | "invalid" | "converter";
	readonly options?: ParseOptions;
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];

function parsedDefinition(file: string, options: ParseOptions = {}): AgentDefinition {
	const source = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8");
	const result = parseDefinition(source, options);
	assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
	return result.definition;
}

describe("writeDefinition", () => {
	it("writes every valid fixture canonically and reparses without compatibility warnings", () => {
		const valid = manifest.filter(({ expect }) => expect === "valid");
		assert.ok(valid.length > 0);
		for (const entry of valid) {
			const definition = parsedDefinition(entry.file, entry.options);
			const reparsed = parseDefinition(writeDefinition(definition));
			assert.equal(reparsed.ok, true, entry.file);
			// A non-recommended name is part of the parsed value and necessarily triggers
			// the parser's value-level name-spelling warning when written unchanged.
			const expectedWarnings =
				definition.name === "Code_Reviewer"
					? [
							{
								severity: "warning",
								code: "name-spelling",
								path: "name",
								message: "Use lowercase letters, digits and single hyphens for agent names.",
								line: 2,
							},
						]
					: [];
			assert.deepEqual(reparsed.diagnostics, expectedWarnings, entry.file);
			assert.deepEqual(reparsed.definition, definition, entry.file);
		}
	});

	it("omits every default and writes the instructions text as the body", () => {
		const definition = parsedDefinition("valid/minimal.md");
		assert.equal(
			writeDefinition(definition),
			[
				"---",
				"name: minimal",
				"description: Minimal definition used to prove every omitted-field default.",
				"---",
				"Follow the task brief exactly.",
				"",
			].join("\n"),
		);
	});

	it("uses canonical long forms only where normalized values need them", () => {
		const base = parsedDefinition("valid/minimal.md");
		const definition: AgentDefinition = {
			...base,
			version: "2",
			instructions: { text: "Do the work.\n", mode: "append", include: ["shared.md"] },
			model: ["primary", "backup"],
			effort: { default: "high", min: "low", max: "xhigh" },
			context: {
				project: false,
				user: false,
				skills: false,
				files: [
					{ path: "README.md", required: false },
					{ path: "docs/format.md", required: true },
				],
			},
			tools: [
				{ name: "read", portable: "read", namespace: null },
				{ name: "mcp:github/issue", portable: null, namespace: "mcp" },
			],
			disallowedTools: [{ name: "write", portable: "edit", namespace: null }],
			agents: ["worker"],
			skills: [
				{ name: "review", source: null, version: null, required: true },
				{ name: "source-only", source: "npm", version: null, required: true },
				{ name: "version-only", source: null, version: "1", required: true },
				{ name: "optional", source: null, version: null, required: false },
				{ name: "secure", source: "npm", version: "1", required: false },
			],
			services: ["database"],
			requires: ["git"],
			workspace: { isolation: "ephemeral" },
			invocation: { model: false, user: false },
			limits: { maxTurns: 4, timeoutMinutes: 5 },
			result: {
				schema: { type: "string" },
				artifacts: [
					{ path: "report.md", check: null },
					{ path: "log.txt", check: "test -s log.txt" },
				],
			},
			runtimes: { custom: { required: true, colour: "blue" } },
			license: "MIT",
			metadata: { owner: "example" },
		};
		const text = writeDefinition(definition);
		assert.match(text, /^---\nname: minimal\ndescription:/);
		assert.doesNotMatch(text, /schemaVersion/);
		assert.match(text, /context:\n {2}project: false\n {2}user: false\n {2}skills: false/);
		assert.match(text, /skills:\n {2}- review\n {2}- name: source-only/);
		assert.match(text, /artifacts:\n {4}- report\.md\n {4}- path: log\.txt/);
		const reparsed = parseDefinition(text);
		assert.equal(reparsed.ok, true, JSON.stringify(reparsed.diagnostics));
		assert.deepEqual(reparsed.definition, definition);
	});
});
