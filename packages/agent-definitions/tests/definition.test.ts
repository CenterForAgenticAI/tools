import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
	CANONICAL_TOP_LEVEL_FIELDS,
	checkIsolation,
	checkRuntime,
	parseDefinition,
	type AgentDefinition,
	type Diagnostic,
} from "../src/index.ts";

function file(frontmatter: string, body = "Follow the task.\n"): string {
	return `---\n${frontmatter}\n---\n${body}`;
}

function valid(extra = "", body?: string): string {
	return file(`name: reviewer\ndescription: Review one bounded change.${extra ? `\n${extra}` : ""}`, body);
}

function errors(source: string, origin?: "project" | "user" | "package"): Diagnostic[] {
	return parseDefinition(source, origin === undefined ? {} : { origin }).diagnostics.filter(
		({ severity }) => severity === "error",
	);
}

function diagnostic(source: string, path: string): Diagnostic {
	const matching = parseDefinition(source).diagnostics.filter((entry) => entry.path === path);
	const found = matching.find(({ severity }) => severity === "error") ?? matching[0];
	assert.ok(found, `expected a diagnostic at ${path}`);
	return found;
}

function definition(source: string): AgentDefinition {
	const parsed = parseDefinition(source);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
	return parsed.definition;
}

describe("parseDefinition", () => {
	it("parses the minimal file and supplies every default (REQ-AD-005, REQ-AD-013)", () => {
		assert.deepEqual(definition(valid()), {
			schemaVersion: 1,
			name: "reviewer",
			description: "Review one bounded change.",
			version: null,
			instructions: { text: "Follow the task.\n", mode: "replace", include: [] },
			model: ["inherit"],
			effort: { default: null, min: null, max: null },
			context: { project: true, user: true, skills: true, files: [] },
			tools: "inherit",
			disallowedTools: [],
			agents: [],
			skills: [],
			services: [],
			requires: [],
			workspace: { isolation: "shared" },
			invocation: { model: true, user: true },
			limits: { maxTurns: null, timeoutMinutes: null },
			result: { schema: null, artifacts: [] },
			runtimes: {},
			license: null,
			metadata: {},
		});
	});

	it("reports splitter, YAML, mapping and duplicate-key errors", () => {
		assert.deepEqual(errors("no frontmatter"), [
			{
				severity: "error",
				code: "missing-opening-fence",
				path: "",
				message: "An agent definition must start with a line that contains only ---.",
				line: 1,
			},
		]);
		assert.equal(errors("---\nname: [\n---\nBody")[0]?.path, "");
		assert.equal(errors("---\n- name\n---\nBody")[0]?.code, "frontmatter-not-mapping");
		assert.deepEqual(errors(file("name: first\nname: second\ndescription: D"))[0], {
			severity: "error",
			code: "duplicate-key",
			path: "name",
			message: 'The field "name" is written more than once.',
			line: 3,
		});
	});

	it("validates required fields, reserved colons and the recommended name spelling (REQ-AD-006)", () => {
		assert.deepEqual(
			errors(file("name: ''\ndescription: ''", " \n")).map(({ path, line }) => [path, line]),
			[
				["name", 2],
				["description", 3],
				["instructions", 5],
			],
		);
		assert.deepEqual(errors(file("name: pkg:reviewer\ndescription: D"))[0]?.path, "name");
		assert.deepEqual(diagnostic(file("name: Review_Agent\ndescription: D"), "name"), {
			severity: "warning",
			code: "name-spelling",
			path: "name",
			message: "Use lowercase letters, digits and single hyphens for agent names.",
			line: 2,
		});
	});

	it("normalizes canonical fields and partly written objects", () => {
		const parsed = definition(
			valid(
				[
					"schemaVersion: 1",
					'version: "2.1"',
					"instructions:",
					"  mode: append",
					"  include: [shared.md]",
					"model: [role:reviewer, anthropic/claude]",
					"effort: { default: high, min: medium, max: xhigh }",
					"context: { project: false, user: false, skills: false, files: [] }",
					"tools: [grep, Read, mcp:github/create_issue]",
					"disallowedTools: write",
					"agents: [worker, 'example:reviewer']",
					"skills: [review, { name: secure, source: npm, version: '1', required: false }]",
					"services: [postgres]",
					"requires: [git]",
					"workspace: { isolation: worktree }",
					"invocation: { user: false }",
					"limits: { maxTurns: 4, timeoutMinutes: 5 }",
					"result:",
					"  schema: { type: string }",
					"  artifacts: [report.md, { path: log.txt, check: test -s log.txt }]",
					"runtimes:",
					"  pi-delegate: { required: true, progress: true }",
					"license: MIT",
					"metadata: { owner: example }",
				].join("\n"),
			),
		);
		assert.deepEqual(parsed, {
			schemaVersion: 1,
			name: "reviewer",
			description: "Review one bounded change.",
			version: "2.1",
			instructions: { text: "Follow the task.\n", mode: "append", include: ["shared.md"] },
			model: ["role:reviewer", "anthropic/claude"],
			effort: { default: "high", min: "medium", max: "xhigh" },
			context: { project: false, user: false, skills: false, files: [] },
			tools: [
				{ name: "grep", portable: "search", namespace: null },
				{ name: "Read", portable: "read", namespace: null },
				{ name: "mcp:github/create_issue", portable: null, namespace: "mcp" },
			],
			disallowedTools: [{ name: "write", portable: "edit", namespace: null }],
			agents: ["worker", "example:reviewer"],
			skills: [
				{ name: "review", source: null, version: null, required: true },
				{ name: "secure", source: "npm", version: "1", required: false },
			],
			services: ["postgres"],
			requires: ["git"],
			workspace: { isolation: "worktree" },
			invocation: { model: true, user: false },
			limits: { maxTurns: 4, timeoutMinutes: 5 },
			result: {
				schema: { type: "string" },
				artifacts: [
					{ path: "report.md", check: null },
					{ path: "log.txt", check: "test -s log.txt" },
				],
			},
			runtimes: { "pi-delegate": { required: true, progress: true } },
			license: "MIT",
			metadata: { owner: "example" },
		});
	});

	it("normalizes scalar model and effort values", () => {
		const parsed = definition(valid("model: inherit\neffort: minimal"));
		assert.deepEqual(parsed.model, ["inherit"]);
		assert.deepEqual(parsed.effort, { default: "minimal", min: null, max: null });
	});

	it("rejects wrong field shapes, enum values, empty lists and effort ranges", () => {
		const source = valid(
			[
				"schemaVersion: 2",
				"version: 2",
				"instructions: { mode: merge, include: x, extra: true }",
				"model: []",
				"effort: { default: low, min: high, max: medium, extra: off }",
				"context: { project: yes, user: yes, files: README.md, extra: true }",
				"tools: []",
				"disallowedTools: inherit",
				"agents: ['*', worker]",
				"skills: [{ name: x, extra: y }]",
				"services: [{ name: db }]",
				"requires: git",
				"workspace: { isolation: sandbox, extra: true }",
				"invocation: { model: yes, extra: true }",
				"limits: { maxTurns: 0, timeoutMinutes: 1.5, extra: 1 }",
				"result: { schema: x, artifacts: [{ path: x, extra: y }], extra: true }",
				"runtimes: { Bad_Name: true }",
				"license: 2",
				"metadata: { owner: 2 }",
			].join("\n"),
		);
		const paths = new Set(errors(source).map(({ path }) => path));
		for (const path of [
			"schemaVersion",
			"version",
			"instructions.mode",
			"instructions.include",
			"instructions.extra",
			"model",
			"effort",
			"effort.extra",
			"context.project",
			"context.user",
			"context.files",
			"context.extra",
			"tools",
			"disallowedTools[0]",
			"agents",
			"skills[0].extra",
			"services[0]",
			"requires",
			"workspace.isolation",
			"workspace.extra",
			"invocation.model",
			"invocation.extra",
			"limits.maxTurns",
			"limits.timeoutMinutes",
			"limits.extra",
			"result.schema",
			"result.artifacts[0].extra",
			"result.extra",
			"runtimes.Bad_Name",
			"license",
			"metadata.owner",
		]) {
			assert.ok(paths.has(path), `missing error at ${path}`);
		}
	});

	it("rejects malformed values on every strict parser branch", () => {
		for (const [extra, path] of [
			["context: true", "context"],
			["effort: turbo", "effort"],
			["tools: {}", "tools"],
			["skills: [2]", "skills[0]"],
			["skills: [{}]", "skills[0].name"],
			["result: { artifacts: [2] }", "result.artifacts[0]"],
			["result: { artifacts: [{}] }", "result.artifacts[0].path"],
			["version: null", "version"],
			["model: ''", "model"],
			["omitClaudeMd: wrong", "omitClaudeMd"],
			["allowNestedDelegate: wrong", "allowNestedDelegate"],
		] as const) {
			assert.equal(diagnostic(valid(extra), path).severity, "error", path);
		}
		assert.equal(definition(valid("tools: inherit")).tools, "inherit");
		assert.deepEqual(definition(valid("allowNestedDelegate: false")).agents, []);
		assert.equal(
			diagnostic(valid("allowNestedDelegate: false\nnestedDelegateAgents: [worker]"), "allowNestedDelegate").severity,
			"error",
		);
	});

	it("checks every effort ordering relationship", () => {
		for (const effort of ["{ default: low, min: high }", "{ default: high, max: low }", "{ min: high, max: low }"]) {
			assert.equal(diagnostic(valid(`effort: ${effort}`), "effort").severity, "error");
		}
	});

	it("rejects duplicate canonical and legacy transformed spellings", () => {
		assert.equal(
			diagnostic(valid("disallowedTools: [write]\ndisallowed_tools: [edit]"), "disallowed_tools").severity,
			"error",
		);
		assert.equal(
			diagnostic(valid("systemPromptMode: append\nsystem_prompt_mode: replace"), "system_prompt_mode").severity,
			"error",
		);
	});

	it("covers alias source combinations and alias conflicts", () => {
		assert.deepEqual(definition(valid("fallbackModels: [backup]")).model, ["backup"]);
		assert.deepEqual(definition(valid("model: [primary]\nfallbackModels: [backup]")).model, ["primary", "backup"]);
		for (const [extra, path] of [
			["agents: [worker]\nallowNestedDelegate: true", "allowNestedDelegate"],
			["instructions: { mode: replace }\nsystemPromptMode: append", "systemPromptMode"],
			["workspace: { isolation: shared }\nisolation: worktree", "isolation"],
			["runtimes: { pi-delegate: { defaultProgress: false } }\ndefaultProgress: true", "defaultProgress"],
		] as const) {
			assert.equal(diagnostic(valid(extra), path).severity, "error", path);
		}
	});

	it("rejects unknown fields at top level and in runtime names (REQ-AD-002)", () => {
		assert.deepEqual(diagnostic(valid("unknown: true"), "unknown").line, 4);
	});

	it("parses context switches and both context.files entry forms", () => {
		const parsed = definition(
			valid(
				[
					"context:",
					"  project: false",
					"  user: false",
					"  skills: false",
					"  files:",
					"    - ./plan.md",
					"    - path: docs/plan.md",
					"      required: true",
				].join("\n"),
			),
		);
		assert.deepEqual(parsed.context, {
			project: false,
			user: false,
			skills: false,
			files: [
				{ path: "./plan.md", required: false },
				{ path: "docs/plan.md", required: true },
			],
		});
	});

	it("requires context.files to be a list and validates long-form keys", () => {
		const listDiagnostic = diagnostic(valid("context: { files: README.md }"), "context.files");
		assert.deepEqual(
			{ severity: listDiagnostic.severity, code: listDiagnostic.code, path: listDiagnostic.path },
			{ severity: "error", code: "invalid-field", path: "context.files" },
		);
		const parsed = parseDefinition(
			valid("context:\n  files:\n    - path: docs/plan.md\n      required: yes\n      extra: true"),
		);
		assert.deepEqual(
			parsed.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[
				{ severity: "error", code: "unknown-field", path: "context.files[0].extra" },
				{ severity: "error", code: "invalid-field", path: "context.files[0].required" },
			],
		);
		for (const [entry, path] of [
			["{ required: true }", "context.files[0].path"],
			["2", "context.files[0]"],
		] as const) {
			const found = diagnostic(valid(`context:\n  files:\n    - ${entry}`), path);
			assert.deepEqual(
				{ severity: found.severity, code: found.code, path: found.path },
				{ severity: "error", code: "invalid-field", path },
			);
		}
	});

	it("rejects unsafe context file paths at their authored entry paths", () => {
		for (const [label, entry, path] of [
			["blank", "'   '", "context.files[0]"],
			["slash absolute", "'/etc/passwd'", "context.files[0]"],
			["backslash absolute", "'\\\\server\\share'", "context.files[0]"],
			["drive absolute", "'C:plan.md'", "context.files[0]"],
			["home relative", "'~/plan.md'", "context.files[0]"],
			["backslash", "'docs\\plan.md'", "context.files[0]"],
			["NUL", '"docs\\0plan.md"', "context.files[0]"],
			["parent segment", "{ path: 'docs/../plan.md' }", "context.files[0].path"],
			["star glob", "'docs/*.md'", "context.files[0]"],
			["question glob", "'docs/plan?.md'", "context.files[0]"],
			["open bracket glob", "'docs/[ab].md'", "context.files[0]"],
			["close bracket glob", "'docs/a].md'", "context.files[0]"],
			["open brace glob", "'docs/{a,b}.md'", "context.files[0]"],
			["close brace glob", "'docs/a}.md'", "context.files[0]"],
		] as const) {
			const found = diagnostic(valid(`context:\n  files:\n    - ${entry}`), path);
			assert.deepEqual(
				{ severity: found.severity, code: found.code, path: found.path },
				{ severity: "error", code: "invalid-field", path },
				label,
			);
		}
	});

	it("allows written relative paths and rejects the later exact duplicate", () => {
		assert.deepEqual(definition(valid("context:\n  files: [./plan.md, docs/plan.md]")).context.files, [
			{ path: "./plan.md", required: false },
			{ path: "docs/plan.md", required: false },
		]);
		const found = diagnostic(valid("context:\n  files: [plan.md, plan.md]"), "context.files[1]");
		assert.deepEqual(
			{ severity: found.severity, code: found.code, path: found.path },
			{ severity: "error", code: "invalid-field", path: "context.files[1]" },
		);
	});

	it("maps defaultReads into context.files and rejects two spellings", () => {
		const legacy = parseDefinition(valid("defaultReads: AGENTS.md, docs/plan.md"));
		assert.equal(legacy.ok, true);
		assert.deepEqual(legacy.definition.context.files, [
			{ path: "AGENTS.md", required: false },
			{ path: "docs/plan.md", required: false },
		]);
		assert.deepEqual(
			legacy.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "warning", code: "legacy-spelling", path: "defaultReads" }],
		);

		for (const value of ["'/etc/passwd'", "{ path: README.md, required: true }"]) {
			const unsafe = diagnostic(valid(`defaultReads: [${value}]`), "defaultReads[0]");
			assert.deepEqual(
				{ severity: unsafe.severity, code: unsafe.code, path: unsafe.path },
				{ severity: "error", code: "invalid-field", path: "defaultReads[0]" },
			);
		}

		const snake = parseDefinition(valid("default_reads: [AGENTS.md]"));
		assert.equal(snake.ok, true);
		assert.deepEqual(snake.definition.context.files, [{ path: "AGENTS.md", required: false }]);
		assert.deepEqual(
			snake.diagnostics.map(({ severity, code, path }) => ({ severity, code, path })),
			[{ severity: "warning", code: "legacy-spelling", path: "default_reads" }],
		);

		const conflict = diagnostic(valid("context: { files: [README.md] }\ndefaultReads: [AGENTS.md]"), "defaultReads");
		assert.deepEqual(
			{ severity: conflict.severity, code: conflict.code, path: conflict.path },
			{ severity: "error", code: "duplicate-spelling", path: "defaultReads" },
		);
	});

	it("maps portable names, aliases, namespaces and Claude MCP names (REQ-AD-007)", () => {
		const source = valid(
			"tools: [execute, bash, NotebookRead, MultiEdit, Glob, Task, WebFetch, TodoWrite, mcp__gitlab__issue]",
		);
		const parsed = parseDefinition(source);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.definition.tools, [
			{ name: "execute", portable: "execute", namespace: null },
			{ name: "bash", portable: "execute", namespace: null },
			{ name: "NotebookRead", portable: "read", namespace: null },
			{ name: "MultiEdit", portable: "edit", namespace: null },
			{ name: "Glob", portable: "search", namespace: null },
			{ name: "Task", portable: "agent", namespace: null },
			{ name: "WebFetch", portable: "web", namespace: null },
			{ name: "TodoWrite", portable: "todo", namespace: null },
			{ name: "mcp:gitlab/issue", portable: null, namespace: "mcp" },
		]);
		assert.deepEqual(
			parsed.diagnostics.map(({ severity, path }) => [severity, path]),
			[["warning", "tools[8]"]],
		);
		assert.equal(diagnostic(valid("tools: [unknown]"), "tools[0]").severity, "error");
		assert.equal(diagnostic(valid("tools: ['missing:']"), "tools[0]").severity, "error");
	});

	it("reads CSV list fields and rejects empty items", () => {
		const parsed = definition(
			valid("tools: read, grep\ndisallowedTools: write\nskills: review, test\nagents: worker, reviewer"),
		);
		assert.deepEqual(parsed.agents, ["worker", "reviewer"]);
		assert.deepEqual(
			parsed.skills.map(({ name }) => name),
			["review", "test"],
		);
		assert.equal(diagnostic(valid("tools: read,,grep"), "tools[1]").severity, "error");
	});

	it("reads effort aliases with warnings and rejects a second spelling (REQ-AD-008)", () => {
		const parsed = parseDefinition(valid("thinking: high\nthinkingMin: low\nthinkingMax: xhigh"));
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.definition.effort, { default: "high", min: "low", max: "xhigh" });
		assert.deepEqual(
			parsed.diagnostics.map(({ path }) => path),
			["thinking", "thinkingMin", "thinkingMax"],
		);
		assert.equal(diagnostic(valid("effort: high\nthinking: low"), "thinking").severity, "error");
	});

	it("reads context and instruction aliases and rejects two spellings (REQ-AD-012)", () => {
		const parsed = parseDefinition(
			valid("inheritProjectContext: false\ninherit_skills: false\nsystemPromptMode: append"),
		);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.definition.context, { project: false, user: true, skills: false, files: [] });
		assert.equal(parsed.definition.instructions.mode, "append");
		assert.deepEqual(
			parsed.diagnostics.map(({ path }) => path),
			["inheritProjectContext", "inherit_skills", "systemPromptMode"],
		);
		assert.equal(definition(valid("omitClaudeMd: true")).context.project, false);
		assert.equal(diagnostic(valid("context: { project: true }\nomitClaudeMd: true"), "omitClaudeMd").severity, "error");
	});

	it("reads model, agent, artifact and runtime aliases", () => {
		const parsed = parseDefinition(
			valid(
				"model: primary\nfallbackModels: [backup]\nallowNestedDelegate: true\nnestedDelegateAgents: [worker]\nartifact: report.md\ndefaultProgress: true\nmaxTurns: 3\nisolation: ephemeral\ncolor: red",
			),
		);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.definition.model, ["primary", "backup"]);
		assert.deepEqual(parsed.definition.agents, ["worker"]);
		assert.deepEqual(parsed.definition.result.artifacts, [{ path: "report.md", check: null }]);
		assert.deepEqual(parsed.definition.runtimes, {
			"pi-delegate": { required: false, defaultProgress: true },
			"claude-code": { required: false, color: "red" },
		});
		assert.deepEqual(parsed.definition.limits, { maxTurns: 3, timeoutMinutes: null });
		assert.deepEqual(parsed.definition.workspace, { isolation: "ephemeral" });
		assert.deepEqual(
			parsed.diagnostics.map(({ severity, path }) => [severity, path]),
			[
				["warning", "fallbackModels"],
				["warning", "allowNestedDelegate"],
				["warning", "nestedDelegateAgents"],
				["warning", "artifact"],
				["warning", "defaultProgress"],
				["warning", "maxTurns"],
				["warning", "isolation"],
				["warning", "color"],
			],
		);
	});

	it("supports wildcard nested agents, false artifacts, systemPrompt and transformed spellings", () => {
		const wildcard = parseDefinition(
			file(
				"name: reviewer\ndescription: D\nallow_nested_delegate: true\nartifact: false\ndisallowed_tools: [write]\npermission-mode: plan",
			),
		);
		assert.equal(wildcard.ok, true);
		assert.deepEqual(wildcard.definition.agents, ["*"]);
		assert.deepEqual(wildcard.definition.result.artifacts, []);
		assert.deepEqual(wildcard.definition.runtimes["claude-code"], { required: false, permissionMode: "plan" });
		const prompt = definition(file("name: reviewer\ndescription: D\nsystemPrompt: Legacy instructions", ""));
		assert.equal(prompt.instructions.text, "Legacy instructions");
		assert.equal(diagnostic(valid("systemPrompt: Other"), "systemPrompt").severity, "error");
	});

	it("rejects canonical and legacy spellings together", () => {
		for (const [extra, path] of [
			["agents: [x]\nnestedDelegateAgents: [y]", "nestedDelegateAgents"],
			["result: { artifacts: [x] }\nartifact: y", "artifact"],
			["limits: { maxTurns: 1 }\nmax_turns: 2", "max_turns"],
			["runtimes: { claude-code: { color: blue } }\ncolor: red", "color"],
		] as const) {
			assert.equal(diagnostic(valid(extra), path).severity, "error");
		}
	});

	it("reads foreign Claude fields under the runtime and rejects undefined fields (REQ-AD-011)", () => {
		const parsed = parseDefinition(
			valid("hooks: { before: command }\nmemory: project\nbackground: true\ninitialPrompt: Hi\nmcpServers: [gitlab]"),
		);
		assert.equal(parsed.ok, true);
		assert.deepEqual(parsed.definition.runtimes["claude-code"], {
			required: false,
			hooks: { before: "command" },
			memory: "project",
			background: true,
			initialPrompt: "Hi",
			mcpServers: ["gitlab"],
		});
		assert.equal(diagnostic(valid("madeUp: true"), "madeUp").severity, "error");
	});

	it("enforces package-origin restrictions at written paths (REQ-AD-010)", () => {
		for (const path of ["services", "mcpServers", "hooks", "permissionMode"] as const) {
			const value = path === "services" ? "[db]" : path === "permissionMode" ? "plan" : "{}";
			assert.equal(errors(valid(`${path}: ${value}`), "package")[0]?.path, path);
		}
		assert.equal(errors(valid("runtimes: { custom: { hooks: true } }"), "package")[0]?.path, "runtimes.custom.hooks");
		assert.equal(parseDefinition(valid("services: []"), { origin: "package" }).ok, true);
	});

	it("defaults required to false in an authored runtime block and keeps its other keys", () => {
		const result = parseDefinition(valid("runtimes:\n  custom-runner:\n    colour: teal"));
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.definition.runtimes, { "custom-runner": { colour: "teal", required: false } });
	});

	it("reports a package-origin violation once, at the key as written (REQ-AD-010)", () => {
		for (const key of ["mcpServers", "hooks", "permissionMode"] as const) {
			const value = key === "permissionMode" ? "plan" : "{}";
			assert.deepEqual(
				errors(valid(`${key}: ${value}`), "package").map(({ path }) => path),
				[key],
			);
		}
		assert.deepEqual(
			errors(valid("runtimes:\n  claude-code:\n    mcpServers: {}"), "package").map(({ path }) => path),
			["runtimes.claude-code.mcpServers"],
		);
	});
});

describe("policy checks", () => {
	it("permits equal or stricter isolation and requires a matching downgrade grant (REQ-AD-003)", () => {
		assert.deepEqual(checkIsolation({ definition: "worktree", requested: "ephemeral" }), {
			ok: true,
			isolation: "ephemeral",
		});
		assert.deepEqual(checkIsolation({ definition: "worktree", requested: "shared" }), {
			ok: false,
			reason: "requested-isolation-is-looser",
		});
		const grant = {
			kind: "isolation-downgrade" as const,
			from: "worktree" as const,
			to: "shared" as const,
			approvedBy: "operator",
		};
		assert.deepEqual(checkIsolation({ definition: "worktree", requested: "shared", grant }), {
			ok: true,
			isolation: "shared",
			grant,
		});
		assert.equal(
			checkIsolation({ ...{ definition: "ephemeral" as const, requested: "shared" as const }, grant }).ok,
			false,
		);
	});

	it("refuses required foreign runtimes and unknown keys for the selected runtime (REQ-AD-009)", () => {
		const parsed = definition(valid("runtimes: { fabric: { required: true }, pi: { required: false, color: blue } }"));
		assert.deepEqual(checkRuntime(parsed, { runtime: "pi", knownKeys: ["model"] }), {
			ok: false,
			diagnostics: [
				{
					severity: "error",
					code: "runtime-required",
					path: "runtimes.fabric.required",
					message: 'The definition requires runtime "fabric", not "pi".',
				},
				{
					severity: "error",
					code: "runtime-key-unknown",
					path: "runtimes.pi.color",
					message: 'Runtime "pi" does not recognise the option "color".',
				},
			],
		});
		assert.deepEqual(checkRuntime(parsed, { runtime: "fabric", knownKeys: [] }), { ok: true });
		assert.deepEqual(checkRuntime(parsed, { runtime: "other", knownKeys: [] }).ok, false);
	});
});

describe("published schema", () => {
	it("keeps canonical parser fields and non-deprecated schema fields in lockstep", () => {
		const schema = JSON.parse(
			fs.readFileSync(new URL("../schema/agent-definition.schema.json", import.meta.url), "utf8"),
		) as {
			properties: Record<string, { deprecated?: boolean }>;
		};
		const schemaCanonical = Object.entries(schema.properties)
			.filter(([, value]) => value.deprecated !== true)
			.map(([key]) => key)
			.sort();
		assert.deepEqual(schemaCanonical, [...CANONICAL_TOP_LEVEL_FIELDS].sort());
	});
});
