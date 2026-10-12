import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type ParseOptions } from "../src/definition.ts";
import { splitFrontmatter } from "../src/frontmatter.ts";
import { piAgentsFormat } from "../src/formats/pi-agents.ts";

interface ManifestEntry {
	file: string;
	expect: "valid" | "invalid" | "converter";
	options?: ParseOptions;
}

const manifest = JSON.parse(
	readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
) as ManifestEntry[];
const allowedKeys = new Set(["name", "description", "model", "thinking", "skills", "tools", "delegate"]);

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
	const exported = piAgentsFormat.export!(original);
	assert.equal(exported.files.length, 1);
	const imported = piAgentsFormat.import!(exported.files[0]!.text, { file: exported.files[0]!.path });
	assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
	const expected = structuredClone(original) as unknown;
	const actual = structuredClone(imported.definition) as unknown;
	for (const { path } of exported.report.entries) {
		removePath(expected, path);
		removePath(actual, path);
	}
	removePath(expected, "runtimes.pi-agents");
	removePath(actual, "runtimes.pi-agents");
	assert.deepEqual(actual, expected);
}

function requiredLossPaths(definition: AgentDefinition): string[] {
	const paths: string[] = [];
	if (definition.version !== null) paths.push("version");
	if (definition.instructions.include.length > 0) paths.push("instructions.include");
	if (definition.effort.min !== null) paths.push("effort.min");
	if (definition.effort.max !== null) paths.push("effort.max");
	if (!definition.context.project) paths.push("context.project");
	if (!definition.context.user) paths.push("context.user");
	if (definition.context.files.length > 0) paths.push("context.files");
	if (definition.disallowedTools.length > 0) paths.push("disallowedTools");
	if (definition.services.length > 0) paths.push("services");
	if (definition.requires.length > 0) paths.push("requires");
	if (definition.workspace.isolation !== "shared") paths.push("workspace.isolation");
	if (!definition.invocation.model) paths.push("invocation.model");
	if (!definition.invocation.user) paths.push("invocation.user");
	if (definition.limits.maxTurns !== null) paths.push("limits.maxTurns");
	if (definition.limits.timeoutMinutes !== null) paths.push("limits.timeoutMinutes");
	if (definition.result.schema !== null) paths.push("result.schema");
	if (definition.result.artifacts.length > 0) paths.push("result.artifacts");
	for (const runtime of Object.keys(definition.runtimes)) {
		if (runtime !== "pi-agents") paths.push(`runtimes.${runtime}`);
	}
	if (definition.license !== null) paths.push("license");
	if (Object.keys(definition.metadata).length > 0) paths.push("metadata");
	return paths;
}

function richDefinition(): AgentDefinition {
	return definition(`---
name: ../Pi Helper
description: Handles a bounded task.
version: "2"
instructions: { mode: replace, include: [shared.md] }
model: [provider/main, provider/fallback]
effort: { default: high, min: low, max: xhigh }
context: { project: false, user: false, skills: true, files: [README.md] }
tools: [read, bash, delegate]
disallowedTools: [write]
agents: [worker]
skills: [review, { name: optional, source: npm, version: "1", required: false }]
services: [database]
requires: [git]
workspace: { isolation: worktree }
invocation: { model: false, user: false }
limits: { maxTurns: 4, timeoutMinutes: 5 }
result: { schema: { type: string }, artifacts: [report.md] }
runtimes:
  pi-agents: { required: true, delegate: true }
  other: { required: true }
license: MIT
metadata: { owner: example }
---
Do the task.
`);
}

describe("pi-agents format", () => {
	it("imports the seven profile fields and maps explicit skills to isolated skill context", () => {
		const imported = piAgentsFormat.import!(
			`---
name: planner
description: Plans changes.
model: provider/model
thinking: high
tools: [read, grep, find, ls]
skills: [architecture]
---
Map the code.
`,
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.deepEqual(imported.definition.model, ["provider/model"]);
		assert.deepEqual(imported.definition.effort, { default: "high", min: null, max: null });
		assert.equal(imported.definition.instructions.mode, "append");
		assert.equal(imported.definition.context.skills, false);
		assert.deepEqual(
			imported.definition.skills.map(({ name, source, version, required }) => ({ name, source, version, required })),
			[{ name: "architecture", source: null, version: null, required: true }],
		);
		assert.deepEqual(imported.report.entries, []);
	});

	it("maps delegate and preserves unsupported import keys without writing them outside the seven-key profile", () => {
		const imported = piAgentsFormat.import!(
			"---\nname: helper\ndescription: Helps.\ndelegate: true\nsurprise: value\n---\nHelp.\n",
			{},
		);
		assert.equal(imported.ok, true, JSON.stringify(imported.diagnostics));
		assert.deepEqual(imported.definition.agents, ["*"]);
		assert.deepEqual(imported.definition.runtimes["pi-agents"], { required: false, surprise: "value" });
		assert.deepEqual(
			imported.report.entries.map(({ path, action }) => ({ path, action })),
			[{ path: "surprise", action: "unmapped" }],
		);
		const exported = piAgentsFormat.export!(imported.definition);
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		const fields = parse(split.frontmatter) as Record<string, unknown>;
		assert.equal(fields.delegate, true);
		assert(!Object.hasOwn(fields, "surprise"));
		assert(
			exported.report.entries.some(
				({ path, action }) => path === "runtimes.pi-agents.surprise" && action === "dropped",
			),
		);
	});

	it("maps delegate false, comma tools, and empty tools, and rejects malformed native shapes", () => {
		const mapped = piAgentsFormat.import!(
			"---\nname: mapped\ndescription: Mapped values.\ndelegate: false\ntools: read, grep\n---\nWork.\n",
			{},
		);
		assert.equal(mapped.ok, true, JSON.stringify(mapped.diagnostics));
		assert.deepEqual(mapped.definition.agents, []);
		assert.notEqual(mapped.definition.tools, "inherit");
		const unknown = piAgentsFormat.import!(
			"---\nname: unknown\ndescription: Unknown tool.\ntools: [custom_tool]\n---\nWork.\n",
			{},
		);
		assert.equal(unknown.ok, true, JSON.stringify(unknown.diagnostics));
		assert.notEqual(unknown.definition.tools, "inherit");
		const empty = piAgentsFormat.import!("---\nname: empty\ndescription: Empty tools.\ntools: []\n---\nWork.\n", {});
		assert.equal(empty.ok, true, JSON.stringify(empty.diagnostics));
		assert.deepEqual(empty.definition.runtimes["pi-agents"], { required: false, tools: [] });
		for (const source of [
			"---\nname: [\n---\nBody.\n",
			"---\n[]\n---\nBody.\n",
			"---\nname: bad\ndescription: Bad.\ntools: [read, 2]\n---\nBody.\n",
			"---\nname: bad\ndescription: Bad.\nmodel: [one, two]\n---\nBody.\n",
			"---\nname: bad\ndescription: Bad.\ndelegate: maybe\n---\nBody.\n",
		])
			assert.equal(piAgentsFormat.import!(source, { file: "agent.md" }).ok, false);
	});

	it("returns parser diagnostics for malformed frontmatter and mapped canonical failures", () => {
		const malformed = piAgentsFormat.import!("name: missing-fences", {});
		assert.equal(malformed.ok, false);
		assert.deepEqual(
			malformed.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "missing-opening-fence", path: "" }],
		);
		const missing = piAgentsFormat.import!("---\nname: missing-description\n---\nBody.\n", {});
		assert.equal(missing.ok, false);
		assert.deepEqual(
			missing.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "error", code: "invalid-field", path: "description" }],
		);
	});

	it("exports only seven keys, uses a safe path, maps supported fields, and reports losses", () => {
		const original = richDefinition();
		const exported = piAgentsFormat.export!(original);
		assert.equal(exported.files[0]!.path, ".pi/agents/pi-helper.md");
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		const fields = parse(split.frontmatter) as Record<string, unknown>;
		assert.deepEqual(fields, {
			name: "../Pi Helper",
			description: "Handles a bounded task.",
			model: "provider/main",
			thinking: "high",
			skills: ["review", "optional"],
			tools: ["read", "bash"],
			delegate: true,
		});
		assert(Object.keys(fields).every((key) => allowedKeys.has(key)));
		const paths = new Set(exported.report.entries.map(({ path }) => path));
		for (const path of [
			...requiredLossPaths(original),
			"instructions.mode",
			"model",
			"agents",
			"skills",
			"tools",
			"runtimes.pi-agents.required",
		]) {
			assert(paths.has(path), `missing lowering report entry for ${path}`);
		}
		assertRoundTrip(original);
	});

	it("reports a canonical field shadowed by an explicit pi-agents runtime key", () => {
		const original = {
			...definition("---\nname: collision\ndescription: Collision.\nmodel: canonical\n---\nWork.\n"),
			runtimes: { "pi-agents": { required: false, model: "native" } },
		};
		const exported = piAgentsFormat.export!(original);
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		assert.equal((parse(split.frontmatter) as Record<string, unknown>).model, "native");
		assert(exported.report.entries.some(({ path, action }) => path === "model" && action === "weakened"));
		assertRoundTrip(original);
	});

	it("translates portable tools, covers skill metadata variants, and uses the safe-name fallback", () => {
		const translated = definition(`---
name: translated
description: Exercises target lowering.
tools: [execute, todo]
skills:
  - { name: versioned, version: "1" }
  - { name: optional, required: false }
---
Work.
`);
		const exported = piAgentsFormat.export!(translated);
		const split = splitFrontmatter(exported.files[0]!.text);
		assert.equal(split.ok, true);
		const fields = parse(split.frontmatter) as Record<string, unknown>;
		assert.deepEqual(fields.tools, ["bash"]);
		assert(exported.report.entries.some(({ path }) => path === "skills"));
		const unsafe = definition("---\nname: ///\ndescription: Unsafe path characters.\n---\nWork.\n");
		assert.equal(piAgentsFormat.export!(unsafe).files[0]!.path, ".pi/agents/agent.md");
	});

	it("keeps every valid fixture export inside the seven-key schema and reports every outside loss", () => {
		for (const entry of manifest.filter(({ expect }) => expect === "valid")) {
			const original = definition(
				readFileSync(new URL(`../fixtures/${entry.file}`, import.meta.url), "utf8"),
				entry.options,
			);
			const exported = piAgentsFormat.export!(original);
			const split = splitFrontmatter(exported.files[0]!.text);
			assert.equal(split.ok, true);
			const fields = parse(split.frontmatter) as Record<string, unknown>;
			assert(
				Object.keys(fields).every((key) => allowedKeys.has(key)),
				entry.file,
			);
			const reported = new Set(exported.report.entries.map(({ path }) => path));
			for (const path of requiredLossPaths(original)) assert(reported.has(path), `${entry.file}: ${path}`);
			assertRoundTrip(original);
		}
	});
});
