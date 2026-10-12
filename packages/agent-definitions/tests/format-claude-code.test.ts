import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { claudeCodeFormat } from "../src/formats/claude-code.ts";

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
	const exported = claudeCodeFormat.export!(original);
	const imported = claudeCodeFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const paths = new Set(exported.report.entries.map(({ path }) => path));
	paths.add("runtimes.claude-code");
	const expected = structuredClone(original) as unknown as Record<string, unknown>;
	const actual = structuredClone(imported.definition) as unknown as Record<string, unknown>;
	for (const path of paths) {
		removePath(expected, path);
		removePath(actual, path);
	}
	assert.deepEqual(actual, expected);
}

describe("Claude Code format", () => {
	it("imports documented fields and keeps target-only and unknown fields under its runtime block", () => {
		const result = claudeCodeFormat.import!(
			[
				"---",
				"name: reviewer",
				"description: Review one change.",
				"tools: Read, Grep",
				"disallowedTools: Write",
				"model: sonnet",
				"effort: high",
				"maxTurns: 4",
				"omitClaudeMd: true",
				"isolation: worktree",
				"color: blue",
				"experimental: { cacheTtl: 1h }",
				"---",
				"Review carefully.",
			].join("\n"),
			{},
		);
		assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
		assert.deepEqual(result.definition.model, ["sonnet"]);
		assert.deepEqual(result.definition.effort, { default: "high", min: null, max: null });
		assert.deepEqual(result.definition.context, { project: false, user: false, skills: true, files: [] });
		assert.deepEqual(result.definition.workspace, { isolation: "worktree" });
		assert.deepEqual(result.definition.limits, { maxTurns: 4, timeoutMinutes: null });
		assert.deepEqual(result.definition.runtimes["claude-code"], {
			required: false,
			color: "blue",
			experimental: { cacheTtl: "1h" },
		});
		assert.deepEqual(
			result.report.entries.map(({ path, action }) => [path, action]),
			[
				["color", "unmapped"],
				["experimental", "unmapped"],
			],
		);
	});

	it("returns parser diagnostics for malformed input", () => {
		const result = claudeCodeFormat.import!("---\nname: [\n---\nBody", {});
		assert.equal(result.ok, false);
		assert.deepEqual(
			result.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-yaml", path: "" }],
		);
	});

	it("lowers ephemeral isolation to Claude Code worktree isolation and reports the weakening", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			workspace: { isolation: "ephemeral" },
			runtimes: { "claude-code": { required: false, color: "purple" } },
		};
		const result = claudeCodeFormat.export!(input);
		assert.equal(result.files[0]!.path, ".claude/agents/minimal.md");
		assert.match(result.files[0]!.text, /isolation: worktree/);
		assert.match(result.files[0]!.text, /color: purple/);
		assert.deepEqual(
			result.report.entries.find(({ path }) => path === "workspace.isolation"),
			{
				path: "workspace.isolation",
				action: "weakened",
				result: "isolation: worktree",
				reason: "Claude Code worktrees keep changes instead of discarding them after the run.",
			},
		);
	});

	it("writes supported model, effort, context, tools, skills, turn limit, and worktree fields", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			model: ["sonnet"],
			effort: { default: "high", min: null, max: null },
			context: { project: false, user: false, skills: true, files: [] },
			tools: [{ name: "Read", portable: "read", namespace: null }],
			disallowedTools: [{ name: "Write", portable: "edit", namespace: null }],
			skills: [{ name: "review", source: null, version: null, required: true }],
			workspace: { isolation: "worktree" },
			limits: { maxTurns: 3, timeoutMinutes: null },
		};
		const result = claudeCodeFormat.export!(input);
		assert.match(result.files[0]!.text, /tools:\n {2}- Read/);
		assert.match(result.files[0]!.text, /disallowedTools:\n {2}- Write/);
		assert.match(result.files[0]!.text, /model: sonnet/);
		assert.match(result.files[0]!.text, /effort: high/);
		assert.match(result.files[0]!.text, /omitClaudeMd: true/);
		assert.match(result.files[0]!.text, /skills:\n {2}- review/);
		assert.match(result.files[0]!.text, /maxTurns: 3/);
		assert.match(result.files[0]!.text, /isolation: worktree/);
		assert.equal(result.report.entries.length, 0);
	});

	it("rejects missing fences, non-mapping YAML, and mapped canonical validation failures", () => {
		for (const source of ["no frontmatter", "---\n- item\n---\nBody", "---\nname: missing-description\n---\nBody"])
			assert.equal(claudeCodeFormat.import!(source, {}).ok, false);
	});

	it("reports every Claude Code loss and both mixed omitClaudeMd tightenings", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			version: "2",
			instructions: { text: base.instructions.text, mode: "append", include: ["shared.md"] },
			model: ["first", "second"],
			effort: { default: "minimal", min: "low", max: "max" },
			context: {
				project: false,
				user: true,
				skills: false,
				files: [{ path: "README.md", required: false }],
			},
			tools: [
				{ name: "read", portable: "read", namespace: null },
				{ name: "mcp:server/tool", portable: null, namespace: "mcp" },
				{ name: "mcp:broken", portable: null, namespace: "mcp" },
				{ name: "ext:custom", portable: null, namespace: "ext" },
			],
			disallowedTools: [{ name: "edit", portable: "edit", namespace: null }],
			agents: ["worker"],
			skills: [{ name: "review", source: "npm", version: "1", required: false }],
			services: ["database"],
			requires: ["git"],
			invocation: { model: false, user: false },
			limits: { maxTurns: 2, timeoutMinutes: 3 },
			result: { schema: { type: "string" }, artifacts: [{ path: "report.md", check: null }] },
			runtimes: {
				"claude-code": { required: true, color: "blue" },
				other: { required: false, colour: "green" },
			},
			license: "MIT",
			metadata: { owner: "example" },
		};
		const result = claudeCodeFormat.export!(input);
		assert.match(
			result.files[0]!.text,
			/tools:\n {2}- Read\n {2}- mcp__server__tool\n {2}- mcp:broken\n {2}- ext:custom/,
		);
		const paths = result.report.entries.map(({ path }) => path);
		for (const path of [
			"tools",
			"disallowedTools",
			"model",
			"effort.default",
			"effort.min",
			"effort.max",
			"context.user",
			"context.skills",
			"context.files",
			"skills",
			"version",
			"instructions.mode",
			"instructions.include",
			"agents",
			"services",
			"requires",
			"invocation",
			"limits.timeoutMinutes",
			"result",
			"license",
			"metadata",
			"runtimes.claude-code.required",
			"runtimes.other",
		])
			assert.ok(paths.includes(path), path);

		const opposite = claudeCodeFormat.export!({
			...base,
			context: { ...base.context, project: true, user: false },
		});
		assert.equal(opposite.report.entries[0]?.path, "context.project");
	});

	it("round-trips every valid canonical fixture except reported paths", () => {
		const entries = manifest.filter(({ expect }) => expect === "valid");
		assert.ok(entries.length > 0);
		for (const entry of entries) assertRoundTrip(definition(entry.file, entry.options));
	});
});
