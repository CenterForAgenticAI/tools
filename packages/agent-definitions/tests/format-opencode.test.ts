import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { opencodeFormat } from "../src/formats/opencode.ts";

interface ManifestEntry {
	readonly file: string;
	readonly expect: "valid" | "invalid" | "converter";
	readonly options?: ParseOptions;
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];

function definition(file: string, options: ParseOptions = {}): AgentDefinition {
	const parsed = parseDefinition(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"), options);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
	return parsed.definition;
}

function removePath(value: Record<string, unknown>, path: string): void {
	const parts = path.split(".");
	let parent: Record<string, unknown> | undefined = value;
	for (const part of parts.slice(0, -1)) {
		const next = parent[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) return;
		parent = next as Record<string, unknown>;
	}
	delete parent[parts.at(-1)!];
}

function assertRoundTrip(original: AgentDefinition): void {
	const exported = opencodeFormat.export!(original);
	assert.equal(exported.files.length, 1);
	const imported = opencodeFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const paths = new Set(exported.report.entries.map(({ path }) => path));
	paths.add("runtimes.opencode");
	const expected = structuredClone(original) as unknown as Record<string, unknown>;
	const actual = structuredClone(imported.definition) as unknown as Record<string, unknown>;
	for (const path of paths) {
		removePath(expected, path);
		removePath(actual, path);
	}
	assert.deepEqual(actual, expected);
}

describe("OpenCode format", () => {
	it("imports every pinned OpenCode converter fixture and derives its name from the file", () => {
		const entries = manifest.filter(
			({ expect, file }) => expect === "converter" && file.startsWith("converter/opencode"),
		);
		assert.ok(entries.length > 0);
		for (const entry of entries) {
			const source = readFileSync(new URL(`../fixtures/${entry.file}`, import.meta.url), "utf8");
			const result = opencodeFormat.import!(source, { file: entry.file });
			assert.equal(result.ok, true, entry.file);
			assert.equal(result.definition.name, entry.file.split("/").at(-1)!.replace(/\.md$/u, ""));
			assert.equal(result.definition.description, "use whenever you are styling a ui with css");
			assert.match(result.definition.instructions.text, /you are very good at writing clean maintainable css/);
		}
	});

	it("imports edit-denying permissions as a read-only tool list and preserves unmapped keys", () => {
		const result = opencodeFormat.import!(
			[
				"---",
				"description: Review without changing files.",
				"permission:",
				"  edit: deny",
				"temperature: 0.1",
				"mode: subagent",
				"---",
				"Review the change.",
			].join("\n"),
			{ file: ".opencode/agents/reviewer.md" },
		);
		assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
		assert.deepEqual(
			result.definition.tools === "inherit" ? result.definition.tools : result.definition.tools.map(({ name }) => name),
			["execute", "read", "search", "agent", "web", "todo"],
		);
		assert.deepEqual(result.definition.workspace, { isolation: "shared" });
		assert.deepEqual(result.definition.runtimes.opencode, {
			required: false,
			temperature: 0.1,
			mode: "subagent",
		});
		assert.deepEqual(result.report.entries, [
			{
				path: "temperature",
				action: "unmapped",
				reason: 'OpenCode field "temperature" has no canonical mapping.',
			},
			{
				path: "mode",
				action: "unmapped",
				reason: 'OpenCode field "mode" has no canonical mapping.',
			},
		]);
	});

	it("returns parser diagnostics when imported text cannot be parsed", () => {
		assert.deepEqual(opencodeFormat.import!("not frontmatter", { file: "bad.md" }), {
			ok: false,
			diagnostics: [
				{
					severity: "error",
					code: "missing-opening-fence",
					path: "",
					message: "An agent definition must start with a line that contains only ---.",
					line: 1,
				},
			],
		});
	});

	it("exports the current documented project path, permissions, steps, and runtime keys", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			model: ["provider/primary"],
			tools: [{ name: "read", portable: "read", namespace: null }],
			workspace: { isolation: "ephemeral" },
			limits: { maxTurns: 3, timeoutMinutes: 2 },
			runtimes: { opencode: { required: false, temperature: 0.2 } },
		};
		const result = opencodeFormat.export!(input);
		assert.equal(result.files[0]!.path, ".opencode/agents/minimal.md");
		assert.match(result.files[0]!.text, /model: provider\/primary/);
		assert.match(result.files[0]!.text, /steps: 3/);
		assert.match(result.files[0]!.text, /permission:\n {2}"\*": deny\n {2}read: allow/);
		assert.match(result.files[0]!.text, /temperature: 0\.2/);
		assert.ok(result.report.entries.some(({ path, action }) => path === "workspace.isolation" && action === "dropped"));
		assert.ok(result.report.entries.some(({ path }) => path === "limits.timeoutMinutes"));
	});

	it("handles legacy access forms, wildcard decisions, deprecated maxSteps, and malformed foreign values", () => {
		for (const source of ["---\nname: [\n---\nBody", "---\n- item\n---\nBody"]) {
			assert.equal(opencodeFormat.import!(source, {}).ok, false);
		}
		assert.equal(opencodeFormat.import!("---\ndescription: Missing name.\n---\nBody", {}).ok, false);

		const source = [
			"---",
			"name: native-name",
			"description: Access matrix.",
			"model: provider/model",
			"maxSteps: 2",
			"permission:",
			"  '*': deny",
			"  read: allow",
			"  lsp: {}",
			"  bash: { '*': ask }",
			"  edit: { '*': deny }",
			"  task: maybe",
			"  future: allow",
			"tools:",
			"  write: true",
			"  grep: false",
			"  custom: true",
			"---",
			"Work.",
		].join("\n");
		const result = opencodeFormat.import!(source, {});
		assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
		assert.equal(result.definition.name, "native-name");
		assert.deepEqual(result.definition.model, ["provider/model"]);
		assert.deepEqual(result.definition.limits, { maxTurns: 2, timeoutMinutes: null });
		assert.deepEqual(
			result.definition.tools === "inherit" ? result.definition.tools : result.definition.tools.map(({ name }) => name),
			["read", "execute", "edit"],
		);
		assert.deepEqual(result.definition.runtimes.opencode, {
			required: false,
			permission: { lsp: {}, task: "maybe", future: "allow" },
			tools: { custom: true },
		});

		const allAllowed = opencodeFormat.import!(
			"---\nname: all\ndescription: All tools.\npermission: { '*': allow }\n---\nWork.\n",
			{},
		);
		assert.equal(allAllowed.ok, true);
		assert.equal(allAllowed.definition.tools, "inherit");
		const noneAllowed = opencodeFormat.import!(
			"---\nname: none\ndescription: No tools.\npermission: { '*': deny }\n---\nWork.\n",
			{},
		);
		assert.equal(noneAllowed.ok, true);
		assert.deepEqual(noneAllowed.definition.runtimes.opencode?.permission, { "*": "deny" });
		const legacyNone = opencodeFormat.import!(
			"---\nname: legacy-none\ndescription: No legacy tools.\ntools: { '*': false }\n---\nWork.\n",
			{},
		);
		assert.equal(legacyNone.ok, true);
		assert.deepEqual(legacyNone.definition.runtimes.opencode?.permission, { "*": false });
		const malformed = opencodeFormat.import!(
			"---\nname: malformed\ndescription: Bad access values.\npermission: 4\ntools: read\n---\nWork.\n",
			{},
		);
		assert.equal(malformed.ok, true);
		assert.deepEqual(malformed.definition.runtimes.opencode, { required: false, permission: 4, tools: "read" });
	});

	it("reports every non-default field that OpenCode cannot preserve", () => {
		const base = definition("valid/minimal.md");
		const input: AgentDefinition = {
			...base,
			version: "2",
			instructions: { text: base.instructions.text, mode: "append", include: ["shared.md"] },
			model: ["first", "second"],
			effort: { default: "high", min: "low", max: "xhigh" },
			context: { project: false, user: false, skills: false, files: [{ path: "README.md", required: true }] },
			tools: [{ name: "mcp:custom/tool", portable: null, namespace: "mcp" }],
			disallowedTools: [{ name: "write", portable: "edit", namespace: null }],
			agents: ["worker"],
			skills: [{ name: "review", source: null, version: null, required: true }],
			services: ["database"],
			requires: ["git"],
			workspace: { isolation: "worktree" },
			invocation: { model: false, user: false },
			limits: { maxTurns: 2, timeoutMinutes: 3 },
			result: { schema: { type: "string" }, artifacts: [{ path: "report.md", check: null }] },
			runtimes: { opencode: { required: true, hidden: true }, other: { required: false, colour: "blue" } },
			license: "MIT",
			metadata: { owner: "example" },
		};
		const paths = opencodeFormat.export!(input).report.entries.map(({ path }) => path);
		for (const path of [
			"model",
			"tools",
			"disallowedTools",
			"version",
			"instructions.mode",
			"instructions.include",
			"effort",
			"context",
			"agents",
			"skills",
			"services",
			"requires",
			"workspace.isolation",
			"invocation",
			"limits.timeoutMinutes",
			"result",
			"license",
			"metadata",
			"runtimes.opencode.required",
			"runtimes.other",
		])
			assert.ok(paths.includes(path), path);

		const inherited = opencodeFormat.export!({
			...base,
			disallowedTools: [{ name: "write", portable: "edit", namespace: null }],
		});
		assert.deepEqual(
			inherited.report.entries.map(({ path }) => path),
			["disallowedTools", "tools"],
		);
	});

	it("round-trips every valid canonical fixture except reported paths", () => {
		const entries = manifest.filter(({ expect }) => expect === "valid");
		assert.ok(entries.length > 0);
		for (const entry of entries) assertRoundTrip(definition(entry.file, entry.options));
	});
});
