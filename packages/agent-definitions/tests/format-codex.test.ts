import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { codexFormat } from "../src/formats/codex.ts";

interface ManifestEntry {
	file: string;
	expect: "valid" | "invalid" | "converter";
	options?: ParseOptions;
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];

function definition(source: string, options: ParseOptions = {}): AgentDefinition {
	const parsed = parseDefinition(source, options);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
	return parsed.definition;
}

function removePath(value: unknown, path: string): void {
	const parts = path.replaceAll(/\[(\d+)\]/g, ".$1").split(".");
	let current = value as Record<string, unknown>;
	for (const part of parts.slice(0, -1)) {
		const next = current[part];
		if (next === null || typeof next !== "object") return;
		current = next as Record<string, unknown>;
	}
	delete current[parts.at(-1)!];
}

function assertRoundTrip(original: AgentDefinition): void {
	const exported = codexFormat.export!(original);
	assert.equal(exported.files.length, 1);
	const imported = codexFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const expected = structuredClone(original) as unknown;
	const actual = structuredClone(imported.definition) as unknown;
	for (const { path } of exported.report.entries) {
		removePath(expected, path);
		removePath(actual, path);
	}
	removePath(expected, "runtimes.codex");
	removePath(actual, "runtimes.codex");
	assert.deepEqual(actual, expected);
}

function fullDefinition(): AgentDefinition {
	return definition(`---
name: ../Reviewer Name
description: Reviews quoted "text" and backslashes.
version: "2"
instructions:
  mode: append
  include: [shared.md]
model: [gpt-main, gpt-fallback]
effort: { default: high, min: low, max: xhigh }
context: { project: false, user: false, skills: false, files: [README.md] }
tools: [read, bash]
disallowedTools: [write]
agents: [worker]
skills: [review]
services: [database]
requires: [git]
workspace: { isolation: worktree }
invocation: { model: false, user: false }
limits: { maxTurns: 4, timeoutMinutes: 5 }
result: { schema: { type: string }, artifacts: [report.md] }
runtimes:
  codex:
    required: true
    sandbox_mode: read-only
    custom_flag: true
  other:
    required: true
license: MIT
metadata: { owner: example }
---
Line one with "quotes" and a backslash: \\.
Line two.
`);
}

describe("codex format", () => {
	it("imports the documented TOML fields and preserves unmapped native keys", () => {
		const imported = codexFormat.import!(
			[
				'name = "reviewer"',
				'description = "Reviews \\"quoted\\" text."',
				'model = "gpt-main"',
				'model_reasoning_effort = "high"',
				'developer_instructions = "Line one.\\nPath: C:\\\\work"',
				'sandbox_mode = "read-only"',
				"custom_flag = true",
			].join("\n"),
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.equal(imported.definition.name, "reviewer");
		assert.equal(imported.definition.description, 'Reviews "quoted" text.');
		assert.deepEqual(imported.definition.model, ["gpt-main"]);
		assert.equal(imported.definition.effort.default, "high");
		assert.equal(imported.definition.instructions.text, "Line one.\nPath: C:\\work");
		assert.deepEqual(imported.definition.runtimes.codex, {
			required: false,
			sandbox_mode: "read-only",
			custom_flag: true,
		});
		assert.deepEqual(
			imported.report.entries.map(({ path, action }) => ({ path, action })),
			[
				{ path: "sandbox_mode", action: "unmapped" },
				{ path: "custom_flag", action: "unmapped" },
			],
		);
	});

	it("reads and writes the complete emitted TOML value subset", () => {
		const imported = codexFormat.import!(
			[
				"# native options",
				'name = "values"',
				'description = "Exercises values."',
				'developer_instructions = "Use \\"quotes\\" and \\\\ paths."',
				'aliases = ["a,b", "c\\\\d"]',
				'nested = { label = "x", enabled = false, count = 2.5, empty = [], child = {} }',
			].join("\r\n"),
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.deepEqual(imported.definition.runtimes.codex, {
			required: false,
			aliases: ["a,b", "c\\d"],
			nested: { label: "x", enabled: false, count: 2.5, empty: [], child: {} },
		});
		const exported = codexFormat.export!(imported.definition);
		assert(exported.files[0]!.text.includes('aliases = ["a,b", "c\\\\d"]'));
		assert(
			exported.files[0]!.text.includes(
				'nested = { label = "x", enabled = false, count = 2.5, empty = [], child = {  } }',
			),
		);

		const withUnrepresentableValues = {
			...imported.definition,
			runtimes: { codex: { required: false, nullish: null, not_finite: Number.POSITIVE_INFINITY } },
		};
		const fallback = codexFormat.export!(withUnrepresentableValues);
		assert.match(fallback.files[0]!.text, /nullish = "null"/);
		assert.match(fallback.files[0]!.text, /not_finite = "Infinity"/);
	});

	it("rejects every malformed TOML shape in the emitted subset", () => {
		for (const source of [
			'name = "unterminated',
			"not an assignment",
			"bad = bare",
			"bad = { nope }",
			"bad = [1, { x = 2 ]",
		]) {
			const malformed = codexFormat.import!(source, { file: "broken.toml" });
			assert.equal(malformed.ok, false);
			assert.deepEqual(
				malformed.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
				[{ severity: "error", code: "invalid-toml", path: "" }],
			);
		}
	});

	it("returns exact diagnostics for malformed TOML and canonical parse failures", () => {
		const malformed = codexFormat.import!('name = "unterminated', {});
		assert.equal(malformed.ok, false);
		assert.deepEqual(
			malformed.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-toml", path: "" }],
		);
		const missing = codexFormat.import!('name = "reviewer"\ndeveloper_instructions = "Review."', {});
		assert.equal(
			codexFormat.import!('name = "reviewer"\ndescription = "Reviews."\ndeveloper_instructions = 2', {}).ok,
			false,
		);
		assert.equal(missing.ok, false);
		assert.deepEqual(
			missing.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-field", path: "description" }],
		);
	});

	it("exports escaped TOML, restores native keys, uses a safe path, and reports losses", () => {
		const exported = codexFormat.export!(fullDefinition());
		assert.equal(exported.files[0]!.path, ".codex/agents/reviewer-name.toml");
		assert(
			exported.files[0]!.text.includes(
				'developer_instructions = "Line one with \\"quotes\\" and a backslash: \\\\.\\nLine two.\\n"',
			),
		);
		assert.match(exported.files[0]!.text, /sandbox_mode = "read-only"/);
		assert.match(exported.files[0]!.text, /custom_flag = true/);
		const paths = new Set(exported.report.entries.map(({ path }) => path));
		for (const path of [
			"version",
			"instructions.mode",
			"instructions.include",
			"model",
			"effort.min",
			"effort.max",
			"context.project",
			"tools",
			"disallowedTools",
			"agents",
			"skills",
			"services",
			"requires",
			"workspace.isolation",
			"invocation.model",
			"limits.maxTurns",
			"result.schema",
			"runtimes.other",
			"license",
			"metadata",
		]) {
			assert(paths.has(path), `missing lowering report entry for ${path}`);
		}
		assertRoundTrip(fullDefinition());
	});

	it("reports a canonical field shadowed by an explicit Codex runtime key", () => {
		const original = {
			...definition("---\nname: collision\ndescription: Collision.\nmodel: canonical\n---\nWork.\n"),
			runtimes: { codex: { required: false, model: "native" } },
		};
		const exported = codexFormat.export!(original);
		assert.match(exported.files[0]!.text, /model = "native"/);
		assert(exported.report.entries.some(({ path, action }) => path === "model" && action === "weakened"));
		assertRoundTrip(original);
	});

	it("uses a non-empty fallback for names made only of unsafe path characters", () => {
		const unsafe = definition("---\nname: ///\ndescription: Unsafe path characters.\n---\nWork.\n");
		assert.equal(codexFormat.export!(unsafe).files[0]!.path, ".codex/agents/agent.toml");
	});

	it("round-trips every valid manifest definition modulo reported paths", () => {
		for (const entry of manifest.filter(({ expect }) => expect === "valid")) {
			const original = definition(
				readFileSync(new URL(`../fixtures/${entry.file}`, import.meta.url), "utf8"),
				entry.options,
			);
			assertRoundTrip(original);
		}
	});
});
