import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { splitFrontmatter } from "../src/frontmatter.ts";
import { geminiCliFormat } from "../src/formats/gemini-cli.ts";

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
	const exported = geminiCliFormat.export!(original);
	assert.equal(exported.files.length, 1);
	const imported = geminiCliFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const expected = structuredClone(original) as unknown;
	const actual = structuredClone(imported.definition) as unknown;
	for (const { path } of exported.report.entries) {
		removePath(expected, path);
		removePath(actual, path);
	}
	removePath(expected, "runtimes.gemini-cli");
	removePath(actual, "runtimes.gemini-cli");
	assert.deepEqual(actual, expected);
}

function richDefinition(): AgentDefinition {
	return definition(`---
name: ../Gemini Helper
description: Handles a bounded task.
version: "2"
instructions: { mode: append, include: [shared.md] }
model: [gemini-primary, gemini-fallback]
effort: { default: high, min: low, max: xhigh }
context: { project: false, user: false, skills: false, files: [README.md] }
tools: [bash, read, write, grep, web, todo]
disallowedTools: [execute]
agents: [worker]
skills: [review]
services: [database]
requires: [git]
workspace: { isolation: ephemeral }
invocation: { model: false, user: false }
limits: { maxTurns: 9, timeoutMinutes: 7 }
result: { schema: { type: string }, artifacts: [report.md] }
runtimes:
  gemini-cli: { required: true, temperature: 0.2, display_name: Helper }
  other: { required: true }
license: MIT
metadata: { owner: example }
---
Run the task.
`);
}

describe("gemini-cli format", () => {
	it("imports documented fields, maps limits and tools, and preserves unmapped keys", () => {
		const imported = geminiCliFormat.import!(
			`---
name: security-auditor
description: Finds vulnerabilities.
kind: local
tools: [run_shell_command, read_file, write_file, grep_search, google_web_search, custom_tool]
model: gemini-3-flash-preview
max_turns: 10
timeout_mins: 4
temperature: 0.2
---
Audit the code.
`,
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.deepEqual(imported.definition.limits, { maxTurns: 10, timeoutMinutes: 4 });
		assert.deepEqual(
			imported.definition.tools === "inherit"
				? imported.definition.tools
				: imported.definition.tools.map(({ name, portable, namespace }) => ({ name, portable, namespace })),
			[
				{ name: "execute", portable: "execute", namespace: null },
				{ name: "read", portable: "read", namespace: null },
				{ name: "edit", portable: "edit", namespace: null },
				{ name: "search", portable: "search", namespace: null },
				{ name: "web", portable: "web", namespace: null },
				{ name: "gemini-cli:custom_tool", portable: null, namespace: "gemini-cli" },
			],
		);
		assert.deepEqual(imported.definition.runtimes["gemini-cli"], {
			required: false,
			kind: "local",
			temperature: 0.2,
		});
		assert.deepEqual(
			imported.report.entries.map(({ path, action }) => ({ path, action })),
			[
				{ path: "kind", action: "unmapped" },
				{ path: "temperature", action: "unmapped" },
			],
		);
	});

	it("keeps empty native tools in the runtime block instead of granting an invalid canonical list", () => {
		const imported = geminiCliFormat.import!("---\nname: none\ndescription: No tools.\ntools: []\n---\nWait.\n", {});
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.equal(imported.definition.tools, "inherit");
		assert.deepEqual(imported.definition.runtimes["gemini-cli"], { required: false, tools: [] });
		assert.deepEqual(
			imported.report.entries.map(({ path }) => path),
			["tools"],
		);
	});

	it("rejects comma tools, malformed YAML, non-maps, and non-string tools", () => {
		const comma = geminiCliFormat.import!(
			"---\nname: comma\ndescription: Comma tools.\ntools: read_file, grep_search\n---\nWork.\n",
			{},
		);
		assert.equal(comma.ok, false);
		const cases = [
			"---\nname: [\n---\nBody.\n",
			"---\n[]\n---\nBody.\n",
			"---\nname: bad-tools\ndescription: Bad tools.\ntools: [read_file, 2]\n---\nBody.\n",
		];
		for (const source of cases) assert.equal(geminiCliFormat.import!(source, { file: "agent.md" }).ok, false);
	});

	it("returns parser diagnostics for malformed frontmatter and mapped canonical failures", () => {
		const malformed = geminiCliFormat.import!("name: missing-fences", {});
		assert.equal(malformed.ok, false);
		assert.deepEqual(
			malformed.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "missing-opening-fence", path: "" }],
		);
		const missing = geminiCliFormat.import!("---\nname: missing-description\n---\nBody.\n", {});
		assert.equal(missing.ok, false);
		assert.deepEqual(
			missing.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-field", path: "description" }],
		);
	});

	it("exports the native schema, restores runtime keys, uses a safe path, and reports losses", () => {
		const exported = geminiCliFormat.export!(richDefinition());
		assert.equal(exported.files[0]!.path, ".gemini/agents/gemini-helper.md");
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		const fields = parse(split.frontmatter) as Record<string, unknown>;
		assert.deepEqual(fields, {
			name: "../Gemini Helper",
			description: "Handles a bounded task.",
			tools: ["run_shell_command", "read_file", "write_file", "grep_search", "google_web_search"],
			model: "gemini-primary",
			max_turns: 9,
			timeout_mins: 7,
			temperature: 0.2,
			display_name: "Helper",
		});
		const paths = new Set(exported.report.entries.map(({ path }) => path));
		for (const path of [
			"version",
			"instructions.mode",
			"instructions.include",
			"model",
			"effort.default",
			"effort.min",
			"effort.max",
			"context.project",
			"tools",
			"disallowedTools",
			"agents",
			"skills",
			"services",
			"workspace.isolation",
			"invocation.model",
			"result.schema",
			"result.artifacts",
			"runtimes.other",
			"runtimes.gemini-cli.required",
			"license",
			"metadata",
		]) {
			assert(paths.has(path), `missing lowering report entry for ${path}`);
		}
		assertRoundTrip(richDefinition());
	});

	it("reports a canonical field shadowed by an explicit Gemini runtime key", () => {
		const original = {
			...definition("---\nname: collision\ndescription: Collision.\nmodel: canonical\n---\nWork.\n"),
			runtimes: { "gemini-cli": { required: false, model: "native" } },
		};
		const exported = geminiCliFormat.export!(original);
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		assert.equal((parse(split.frontmatter) as Record<string, unknown>).model, "native");
		assert(exported.report.entries.some(({ path, action }) => path === "model" && action === "weakened"));
		assertRoundTrip(original);
	});

	it("round-trips target-namespaced tools and uses the safe-name fallback", () => {
		const imported = geminiCliFormat.import!(
			"---\nname: custom\ndescription: Custom tool.\ntools: [custom_tool]\n---\nWork.\n",
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		const exported = geminiCliFormat.export!(imported.definition);
		const reparsed = geminiCliFormat.import!(exported.files[0]!.text, {});
		assert.equal(reparsed.ok, true, JSON.stringify(reparsed.diagnostics));
		assert.deepEqual(reparsed.definition.tools, imported.definition.tools);
		const unsafe = definition("---\nname: ///\ndescription: Unsafe path characters.\n---\nWork.\n");
		assert.equal(geminiCliFormat.export!(unsafe).files[0]!.path, ".gemini/agents/agent.md");
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
