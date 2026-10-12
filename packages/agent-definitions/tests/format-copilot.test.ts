import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { copilotFormat } from "../src/formats/copilot.ts";

interface ManifestEntry {
	readonly file: string;
	readonly expect: "valid" | "invalid" | "converter";
	readonly options?: ParseOptions;
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];

function definition(file: string, options: ParseOptions = {}): AgentDefinition {
	const result = parseDefinition(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"), options);
	assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
	return result.definition;
}

function removePath(value: Record<string, unknown>, path: string): void {
	const parts = path.split(".");
	let parent = value;
	for (const part of parts.slice(0, -1)) {
		const next = parent[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) return;
		parent = next as Record<string, unknown>;
	}
	delete parent[parts.at(-1)!];
}

function assertRoundTrip(original: AgentDefinition): void {
	const exported = copilotFormat.export!(original);
	const imported = copilotFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const paths = new Set(exported.report.entries.map(({ path }) => path));
	paths.add("runtimes.copilot");
	const expected = structuredClone(original) as unknown as Record<string, unknown>;
	const actual = structuredClone(imported.definition) as unknown as Record<string, unknown>;
	for (const path of paths) {
		removePath(expected, path);
		removePath(actual, path);
	}
	assert.deepEqual(actual, expected);
}

describe("GitHub Copilot format", () => {
	it("imports portable tools and invocation controls and preserves target-only fields", () => {
		const result = copilotFormat.import!(
			[
				"---",
				"description: Plans changes.",
				"tools: [read, search, some-server/tool]",
				"model: claude-sonnet-4.5",
				"disable-model-invocation: true",
				"user-invocable: false",
				"target: github-copilot",
				"mcp-servers: { custom: { type: local, command: tool } }",
				"future-field: enabled",
				"---",
				"Plan the requested change.",
			].join("\n"),
			{ file: ".github/agents/planner.agent.md" },
		);
		assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
		assert.equal(result.definition.name, "planner");
		assert.deepEqual(result.definition.invocation, { model: false, user: false });
		assert.deepEqual(result.definition.tools, [
			{ name: "read", portable: "read", namespace: null },
			{ name: "search", portable: "search", namespace: null },
			{ name: "mcp:some-server/tool", portable: null, namespace: "mcp" },
		]);
		assert.deepEqual(result.definition.runtimes.copilot, {
			required: false,
			target: "github-copilot",
			"mcp-servers": { custom: { type: "local", command: "tool" } },
			"future-field": "enabled",
		});
		assert.deepEqual(
			result.report.entries.map(({ path, action }) => [path, action]),
			[
				["target", "unmapped"],
				["mcp-servers", "unmapped"],
				["future-field", "unmapped"],
			],
		);
	});

	it("uses infer when modern invocation flags are absent and lets disable-model-invocation win", () => {
		const inferred = copilotFormat.import!("---\ndescription: Manual only.\ninfer: false\n---\nDo the work.\n", {
			file: "manual.agent.md",
		});
		assert.equal(inferred.ok, true);
		assert.deepEqual(inferred.definition.invocation, { model: false, user: true });
		const precedence = copilotFormat.import!(
			"---\ndescription: Precedence.\ninfer: true\ndisable-model-invocation: true\n---\nDo the work.\n",
			{ file: "precedence.agent.md" },
		);
		assert.equal(precedence.ok, true);
		assert.equal(precedence.definition.invocation.model, false);
	});

	it("returns parser diagnostics when required canonical fields remain missing", () => {
		const result = copilotFormat.import!("---\nname: missing-description\n---\nBody\n", {});
		assert.equal(result.ok, false);
		assert.deepEqual(
			result.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-field", path: "description" }],
		);
	});

	it("exports the documented path, portable tools, invocation flags, metadata, and runtime keys", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			model: ["claude-sonnet-4.5"],
			tools: [
				{ name: "Read", portable: "read", namespace: null },
				{ name: "mcp:custom/query", portable: null, namespace: "mcp" },
			],
			invocation: { model: false, user: false },
			metadata: { owner: "example" },
			runtimes: {
				copilot: {
					required: false,
					target: "github-copilot",
					"mcp-servers": { custom: { type: "local", command: "tool" } },
				},
			},
		};
		const result = copilotFormat.export!(input);
		assert.equal(result.files[0]!.path, ".github/agents/minimal.agent.md");
		assert.match(result.files[0]!.text, /tools:\n {2}- read\n {2}- custom\/query/);
		assert.match(result.files[0]!.text, /disable-model-invocation: true/);
		assert.match(result.files[0]!.text, /user-invocable: false/);
		assert.match(result.files[0]!.text, /target: github-copilot/);
		assert.match(result.files[0]!.text, /metadata:\n {2}owner: example/);
		assert.ok(result.report.entries.some(({ path, action }) => path === "tools" && action === "weakened"));
	});

	it("handles every documented tools form and malformed foreign structures", () => {
		for (const source of [
			"no frontmatter",
			"---\nname: [\n---\nBody",
			"---\n- item\n---\nBody",
			"---\ndescription: Missing filename.\n---\nBody",
			"---\nname: bad-tools\ndescription: Bad tools.\ntools: 4\n---\nBody",
			"---\nname: mixed-tools\ndescription: Mixed tools.\ntools: [read, 4]\n---\nBody",
		])
			assert.equal(copilotFormat.import!(source, {}).ok, false);

		for (const tools of ["'*'", "['*']"] as const) {
			const inherited = copilotFormat.import!(
				`---\nname: inherited\ndescription: All tools.\ntools: ${tools}\n---\nBody\n`,
				{},
			);
			assert.equal(inherited.ok, true);
			assert.equal(inherited.definition.tools, "inherit");
		}
		const single = copilotFormat.import!("---\nname: single\ndescription: One tool.\ntools: read\n---\nBody\n", {});
		assert.equal(single.ok, true);
		assert.deepEqual(single.definition.tools, [{ name: "read", portable: "read", namespace: null }]);
		const csv = copilotFormat.import!(
			"---\nname: csv\ndescription: CSV tools.\ntools: read, server/tool, ext:server/tool\n---\nBody\n",
			{},
		);
		assert.equal(csv.ok, true, JSON.stringify(csv.diagnostics));
		assert.deepEqual(csv.definition.tools, [
			{ name: "read", portable: "read", namespace: null },
			{ name: "mcp:server/tool", portable: null, namespace: "mcp" },
			{ name: "ext:server/tool", portable: null, namespace: "ext" },
		]);
		const empty = copilotFormat.import!("---\nname: empty\ndescription: Empty tools.\ntools: []\n---\nBody\n", {});
		assert.equal(empty.ok, true);
		assert.deepEqual(empty.definition.runtimes.copilot?.tools, []);
	});

	it("reports every non-default field Copilot cannot preserve", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			version: "2",
			instructions: { text: base.instructions.text, mode: "append", include: ["shared.md"] },
			model: ["first", "second"],
			effort: { default: "high", min: "low", max: "max" },
			context: { project: false, user: false, skills: false, files: [{ path: "README.md", required: false }] },
			tools: [{ name: "ext:custom", portable: null, namespace: "ext" }],
			disallowedTools: [{ name: "edit", portable: "edit", namespace: null }],
			agents: ["worker"],
			skills: [{ name: "review", source: null, version: null, required: true }],
			services: ["database"],
			requires: ["git"],
			workspace: { isolation: "worktree" },
			limits: { maxTurns: 2, timeoutMinutes: 3 },
			result: { schema: { type: "string" }, artifacts: [{ path: "report.md", check: null }] },
			runtimes: { copilot: { required: true, target: "vscode" }, other: { required: false, colour: "blue" } },
			license: "MIT",
		};
		const paths = copilotFormat.export!(input).report.entries.map(({ path }) => path);
		for (const path of [
			"model",
			"version",
			"instructions.mode",
			"instructions.include",
			"effort",
			"context",
			"disallowedTools",
			"agents",
			"skills",
			"services",
			"requires",
			"workspace.isolation",
			"limits",
			"result",
			"license",
			"runtimes.copilot.required",
			"runtimes.other",
		])
			assert.ok(paths.includes(path), path);
	});

	it("round-trips every valid canonical fixture except reported paths", () => {
		const entries = manifest.filter(({ expect }) => expect === "valid");
		assert.ok(entries.length > 0);
		for (const entry of entries) assertRoundTrip(definition(entry.file, entry.options));
	});
});
