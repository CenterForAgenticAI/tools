import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseDefinition, type AgentDefinition, type Diagnostic, type ParseOptions } from "../src/definition.ts";
import { assertConformance } from "../src/conformance.ts";
import { lowerToPiDurable, piDurableConsumer, type PiDurableOptions } from "../src/pi-durable.ts";

function source(extra = "", body = "Follow the task.\n"): string {
	return `---\nname: durable-test\ndescription: Test pi-durable lowering.${extra ? `\n${extra}` : ""}\n---\n${body}`;
}

function definition(extra = "", body?: string): AgentDefinition {
	const parsed = parseDefinition(source(extra, body));
	assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
	return parsed.definition;
}

function errorShapes(diagnostics: readonly Diagnostic[]): { severity: string; code: string; path: string }[] {
	return diagnostics.map(({ severity, code, path }) => ({ severity, code, path }));
}

const baseOptions: PiDurableOptions = {
	parentModel: "test/parent",
	parentTools: ["read", "bash"],
	enforcedBy: ["agents"],
};

function success(def: AgentDefinition, options: PiDurableOptions = baseOptions) {
	const result = lowerToPiDurable(def, options);
	assert.equal(result.ok, true, JSON.stringify(result));
	return result;
}

describe("lowerToPiDurable", () => {
	it("lowers the minimal fixture to an exact configure input", () => {
		const parsed = parseDefinition(readFileSync(new URL("../fixtures/valid/minimal.md", import.meta.url), "utf8"));
		assert.equal(parsed.ok, true);
		const result = success(parsed.definition);
		assert.deepEqual(result.input, {
			model: { provider: "test", modelId: "parent" },
			tools: [{ name: "read" }, { name: "bash" }],
			instructions: "Follow the task brief exactly.\n",
		});
		assert.equal(result.report.target, "pi-durable");
		assert.equal(result.report.direction, "runtime");
	});

	it("chooses the first available model and maps all portable pi tool aliases in stable order", () => {
		const result = success(
			definition(
				"model: [test/missing, test/chosen]\neffort: high\ntools: [execute, read, edit, search, mcp:custom/tool, read]\nagents: ['*']",
			),
			{ availableModels: ["test/chosen"], parentTools: [] },
		);
		assert.deepEqual(result.input, {
			model: { provider: "test", modelId: "chosen" },
			thinkingLevel: "high",
			tools: [
				{ name: "bash" },
				{ name: "read" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "grep" },
				{ name: "find" },
				{ name: "ls" },
				{ name: "mcp:custom/tool" },
			],
			instructions: "Follow the task.\n",
		});
	});

	it("lowers the publisher fixture to a hand-written exact input", () => {
		const parsed = parseDefinition(
			readFileSync(new URL("../fixtures/legacy/pi-delegate/publisher.md", import.meta.url), "utf8"),
		);
		assert.equal(parsed.ok, true);
		const result = success(parsed.definition);
		assert.deepEqual(result.input, {
			model: { provider: "test", modelId: "parent" },
			tools: [{ name: "bash" }],
			instructions: parsed.definition.instructions.text,
		});
	});

	it("lowers the MCP compatibility fixture without changing its target tool name", () => {
		const parsed = parseDefinition(
			readFileSync(new URL("../fixtures/valid/mcp-double-underscore.md", import.meta.url), "utf8"),
		);
		assert.equal(parsed.ok, true);
		const result = success(parsed.definition);
		assert.deepEqual(result.input, {
			model: { provider: "test", modelId: "parent" },
			tools: [{ name: "mcp:github/create_issue" }],
			instructions: "Create the requested issue.\n",
		});
	});

	it("resolves inherit against the parent model and refuses unavailable or unqualified models", () => {
		assert.deepEqual(
			success(definition("agents: ['*']"), { parentModel: "provider/model", parentTools: [] }).input.model,
			{
				provider: "provider",
				modelId: "model",
			},
		);
		for (const [def, options] of [
			[
				definition("model: [provider/missing]\nagents: ['*']"),
				{ availableModels: ["provider/other"], parentTools: [] },
			],
			[definition("agents: ['*']"), { availableModels: ["provider/other"], parentTools: [] }],
			[definition("model: bare-model\nagents: ['*']"), { parentTools: [] }],
		] as const) {
			const result = lowerToPiDurable(def, options);
			assert.equal(result.ok, false);
			assert.deepEqual(errorShapes(result.diagnostics), [
				{ severity: "error", code: "model-unavailable", path: "model" },
			]);
			assert.deepEqual(result.report, { target: "pi-durable", direction: "runtime", entries: result.report.entries });
		}
	});

	it("uses the first declared model when availableModels is omitted", () => {
		assert.deepEqual(
			success(definition("model: [provider/first, provider/second]\nagents: ['*']"), { parentTools: [] }).input.model,
			{ provider: "provider", modelId: "first" },
		);
	});

	it("passes every current pi thinking level through and reports effort bounds as dropped", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			assert.equal(
				success(definition(`effort: ${level}\nagents: ['*']`), {
					parentModel: "test/parent",
					parentTools: [],
				}).input.thinkingLevel,
				level,
			);
		}
		const result = success(definition("effort: { default: medium, min: low, max: high }"));
		assert.deepEqual(
			result.report.entries.filter(({ path }) => path.startsWith("effort.")),
			[
				{ path: "effort.min", action: "dropped", reason: "pi-durable configure() has no minimum thinking level." },
				{ path: "effort.max", action: "dropped", reason: "pi-durable configure() has no maximum thinking level." },
			],
		);
	});

	it("maps configured portable tools, drops unmapped portable tools, and removes disallowed tools after mapping", () => {
		const result = success(
			definition(
				"tools: [agent, web, todo, execute, mcp:shell/run]\ndisallowedTools: [execute, mcp:shell/run]\nagents: ['*']",
			),
			{
				parentModel: "test/parent",
				parentTools: [],
				toolMap: { agent: ["delegate"], web: "browser" },
			},
		);
		assert.deepEqual(result.input.tools, [{ name: "delegate" }, { name: "browser" }]);
		assert.deepEqual(
			result.report.entries.filter(({ path }) => path === "tools[2]"),
			[
				{
					path: "tools[2]",
					action: "dropped",
					reason: 'pi has no built-in tool for the portable name "todo".',
				},
			],
		);
	});

	it("maps inherit from the fixed parent tool set without duplicates", () => {
		const result = success(definition(), {
			parentModel: "test/parent",
			parentTools: ["read", "read", "custom"],
			enforcedBy: ["agents"],
		});
		assert.deepEqual(result.input.tools, [{ name: "read" }, { name: "custom" }]);
	});

	it("refuses an unexpressible disallowed portable tool unless enforced or approved", () => {
		const def = definition("disallowedTools: [agent]");
		const refused = lowerToPiDurable(def, baseOptions);
		assert.equal(refused.ok, false);
		assert.deepEqual(errorShapes(refused.diagnostics), [
			{ severity: "error", code: "restriction-unenforced", path: "disallowedTools" },
		]);
		const enforced = success(def, { ...baseOptions, enforcedBy: ["agents", "disallowedTools"] });
		assert.deepEqual(
			enforced.report.entries.find(({ path }) => path === "disallowedTools"),
			{
				path: "disallowedTools",
				action: "dropped",
				reason: "enforced by the caller",
			},
		);
		const approved = success(def, {
			...baseOptions,
			downgrade: { approvedBy: "operator", paths: ["disallowedTools"] },
		});
		assert.match(approved.report.entries.find(({ path }) => path === "disallowedTools")?.reason ?? "", /operator/);
	});

	it("inlines included instructions and skills in declared order under named headings", () => {
		const result = success(
			definition(
				"instructions: { mode: append, include: [first.md, second.md] }\nskills: [review, { name: secure, required: false }]",
				"Main body.\n",
			),
			{
				...baseOptions,
				readInstruction: (path) => (path === "first.md" ? "First include." : "Second include."),
				readSkill: (reference) => (reference.name === "review" ? "Review skill." : "Secure skill."),
			},
		);
		assert.equal(
			result.input.instructions,
			"## Included instructions: first.md\n\nFirst include.\n\n## Included instructions: second.md\n\nSecond include.\n\n## Skill: review\n\nReview skill.\n\n## Skill: secure\n\nSecure skill.\n\nMain body.\n",
		);
		assert.deepEqual(
			result.report.entries.filter(({ action }) => action === "inlined"),
			[
				{
					path: "instructions.include[0]",
					action: "inlined",
					result: "instructions",
					reason: "pi-durable configure() has one instructions string.",
				},
				{
					path: "instructions.include[1]",
					action: "inlined",
					result: "instructions",
					reason: "pi-durable configure() has one instructions string.",
				},
				{
					path: "skills[0]",
					action: "inlined",
					result: "instructions",
					reason: "pi-durable configure() has no skill slot.",
				},
				{
					path: "skills[1]",
					action: "inlined",
					result: "instructions",
					reason: "pi-durable configure() has no skill slot.",
				},
			],
		);
	});

	it("skips a missing optional skill and reports it dropped", () => {
		const result = success(definition("skills: [present, { name: absent, required: false }]", "Main body.\n"), {
			...baseOptions,
			readSkill: (reference) => (reference.name === "present" ? "Present skill." : undefined),
		});
		assert.equal(result.input.instructions, "## Skill: present\n\nPresent skill.\n\nMain body.\n");
		assert.deepEqual(
			result.report.entries.filter(({ path }) => path.startsWith("skills[")),
			[
				{
					path: "skills[0]",
					action: "inlined",
					result: "instructions",
					reason: "pi-durable configure() has no skill slot.",
				},
				{ path: "skills[1]", action: "dropped", reason: 'The optional skill "absent" could not be read.' },
			],
		);
	});

	it("reports missing included instructions and skills at their exact list paths", () => {
		const result = lowerToPiDurable(
			definition("instructions: { include: [missing.md] }\nskills: [missing-skill]"),
			baseOptions,
		);
		assert.equal(result.ok, false);
		assert.deepEqual(errorShapes(result.diagnostics), [
			{ severity: "error", code: "instruction-include-missing", path: "instructions.include[0]" },
			{ severity: "error", code: "skill-missing", path: "skills[0]" },
		]);
	});

	it("reports context fields configure cannot hold and never reads context.files", () => {
		let reads = 0;
		const result = success(definition("context: { project: false, user: false, skills: false, files: [notes.md] }"), {
			...baseOptions,
			readInstruction: () => void reads++,
		});
		assert.equal(reads, 0);
		assert.deepEqual(
			result.report.entries.filter(({ path }) => path.startsWith("context.")),
			[
				{ path: "context.project", action: "dropped", reason: "The pi-durable host owns project context loading." },
				{ path: "context.user", action: "dropped", reason: "The pi-durable host owns user context loading." },
				{ path: "context.skills", action: "dropped", reason: "The pi-durable host owns inherited skill loading." },
				{
					path: "context.files",
					action: "dropped",
					reason: "The caller must resolve and add context files before the run.",
				},
			],
		);
	});

	it("refuses maxTurns without enforcement and accepts explicit caller enforcement or a named downgrade", () => {
		const def = definition("limits: { maxTurns: 3 }");
		const refused = lowerToPiDurable(def, baseOptions);
		assert.equal(refused.ok, false);
		assert.deepEqual(errorShapes(refused.diagnostics), [
			{ severity: "error", code: "restriction-unenforced", path: "limits.maxTurns" },
		]);
		const enforced = success(def, { ...baseOptions, enforcedBy: ["agents", "limits.maxTurns"] });
		assert.deepEqual(
			enforced.report.entries.find(({ path }) => path === "limits.maxTurns"),
			{
				path: "limits.maxTurns",
				action: "dropped",
				reason: "enforced by the caller",
			},
		);
		const approved = success(def, {
			...baseOptions,
			downgrade: { approvedBy: "A. Operator", paths: ["limits.maxTurns"] },
		});
		assert.deepEqual(
			approved.report.entries.find(({ path }) => path === "limits.maxTurns"),
			{
				path: "limits.maxTurns",
				action: "weakened",
				reason: 'Downgrade approved by "A. Operator".',
			},
		);
	});

	it("checks isolation with the shared policy and rejects a blank downgrade approver", () => {
		const def = definition("workspace: { isolation: worktree }");
		const refused = lowerToPiDurable(def, {
			...baseOptions,
			downgrade: { approvedBy: " ", paths: ["workspace.isolation"] },
		});
		assert.equal(refused.ok, false);
		assert.deepEqual(errorShapes(refused.diagnostics), [
			{ severity: "error", code: "restriction-unenforced", path: "workspace.isolation" },
		]);
		const approved = success(def, {
			...baseOptions,
			downgrade: { approvedBy: "operator", paths: ["workspace.isolation"] },
		});
		assert.match(approved.report.entries.find(({ path }) => path === "workspace.isolation")?.reason ?? "", /operator/);
		const enforced = success(def, { ...baseOptions, enforcedBy: ["agents", "workspace.isolation"] });
		assert.deepEqual(
			enforced.report.entries.find(({ path }) => path === "workspace.isolation"),
			{
				path: "workspace.isolation",
				action: "dropped",
				reason: "enforced by the caller",
			},
		);
	});

	it("handles every other unsupported restriction through the same enforcement contract", () => {
		const def = definition(
			"agents: [worker]\nlimits: { timeoutMinutes: 2 }\nresult: { schema: { type: string }, artifacts: [report.md] }",
		);
		const paths = ["agents", "limits.timeoutMinutes", "result.schema", "result.artifacts"];
		const refused = lowerToPiDurable(def, { parentModel: "test/parent", parentTools: [] });
		assert.equal(refused.ok, false);
		assert.deepEqual(
			errorShapes(refused.diagnostics),
			paths.map((path) => ({ severity: "error", code: "restriction-unenforced", path })),
		);
		const enforced = success(def, { parentModel: "test/parent", parentTools: [], enforcedBy: paths });
		for (const path of paths)
			assert.equal(enforced.report.entries.find((entry) => entry.path === path)?.action, "dropped");
	});

	it("rejects required foreign runtimes and unknown pi-durable options through checkRuntime", () => {
		for (const [extra, expected] of [
			[
				"runtimes: { fabric: { required: true } }",
				{ severity: "error", code: "runtime-required", path: "runtimes.fabric.required" },
			],
			[
				"runtimes: { pi-durable: { colour: blue } }",
				{ severity: "error", code: "runtime-key-unknown", path: "runtimes.pi-durable.colour" },
			],
		] as const) {
			const result = lowerToPiDurable(definition(extra), baseOptions);
			assert.equal(result.ok, false);
			assert.deepEqual(errorShapes(result.diagnostics), [expected]);
		}
	});

	it("passes cwd and reports unsupported descriptive and invocation fields", () => {
		const result = success(
			definition(
				"version: '2'\nservices: [db]\nrequires: [git]\ninvocation: { model: false, user: false }\nlicense: MIT\nmetadata: { owner: example }",
			),
			{ ...baseOptions, cwd: "/workspace" },
		);
		assert.equal(result.input.cwd, "/workspace");
		assert.deepEqual(
			result.report.entries
				.filter(({ path }) =>
					["version", "services", "requires", "invocation.model", "invocation.user", "license", "metadata"].includes(
						path,
					),
				)
				.map(({ path, action }) => ({ path, action })),
			[
				{ path: "version", action: "dropped" },
				{ path: "services", action: "dropped" },
				{ path: "requires", action: "dropped" },
				{ path: "invocation.model", action: "dropped" },
				{ path: "invocation.user", action: "dropped" },
				{ path: "license", action: "dropped" },
				{ path: "metadata", action: "dropped" },
			],
		);
	});

	it("gives every valid fixture either an input or errors with field paths", () => {
		const manifest = JSON.parse(readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8")) as {
			file: string;
			expect: "valid" | "invalid" | "converter";
			options?: ParseOptions;
		}[];
		const enforcedBy = [
			"agents",
			"limits.maxTurns",
			"limits.timeoutMinutes",
			"workspace.isolation",
			"result.schema",
			"result.artifacts",
			"disallowedTools",
		];
		for (const entry of manifest.filter(({ expect }) => expect === "valid")) {
			const parsed = parseDefinition(
				readFileSync(new URL(`../fixtures/${entry.file}`, import.meta.url), "utf8"),
				entry.options ?? {},
			);
			assert.equal(parsed.ok, true, entry.file);
			const availableModels = parsed.definition.model.filter((model) => model !== "inherit").concat("fixture/parent");
			const result = lowerToPiDurable(parsed.definition, {
				availableModels,
				parentModel: "fixture/parent",
				parentTools: ["read", "bash"],
				readInstruction: () => "Included fixture text.",
				readSkill: () => "Fixture skill text.",
				enforcedBy,
			});
			assert(
				result.ok ||
					(result.diagnostics.length > 0 && result.diagnostics.every((diagnostic) => diagnostic.path !== "")),
				entry.file,
			);
		}
	});
});

describe("piDurableConsumer", () => {
	it("reports enforceable restrictions for a pi-durable request and refuses unsupported ones", () => {
		const accepted = piDurableConsumer.prepare?.(
			definition(
				"tools: [read]\ndisallowedTools: [execute]\nagents: ['*']\nruntimes: { pi-durable: { required: true } }",
			),
			{ runtime: "pi-durable", requestedIsolation: "shared" },
		);
		assert.deepEqual(accepted, {
			ok: true,
			enforced: [
				{ path: "tools", value: [{ name: "read", portable: "read", namespace: null }] },
				{ path: "disallowedTools", value: [{ name: "execute", portable: "execute", namespace: null }] },
				{ path: "runtimes.pi-durable.required", value: true },
			],
		});
		assert.deepEqual(
			piDurableConsumer.prepare?.(definition(), { runtime: "pi-durable", requestedIsolation: "shared" }),
			{ ok: false, reason: 'pi-durable cannot enforce "agents".' },
		);
		assert.deepEqual(
			piDurableConsumer.prepare?.(definition("agents: ['*']"), {
				runtime: "other",
				requestedIsolation: "shared",
			}),
			{ ok: false, reason: 'This consumer prepares only runtime "pi-durable".' },
		);
	});

	it("checks preparation grants, runtime requirements, tool removals, skills, and optional runtime entries", () => {
		const isolated = definition("agents: ['*']\nworkspace: { isolation: worktree }");
		assert.deepEqual(piDurableConsumer.prepare?.(isolated, { runtime: "pi-durable", requestedIsolation: "shared" }), {
			ok: false,
			reason: "requested-isolation-is-looser",
		});
		assert.deepEqual(
			piDurableConsumer.prepare?.(isolated, {
				runtime: "pi-durable",
				requestedIsolation: "shared",
				isolationGrant: {
					kind: "isolation-downgrade",
					from: "worktree",
					to: "shared",
					approvedBy: "operator",
				},
			}),
			{ ok: false, reason: 'pi-durable cannot enforce "workspace.isolation".' },
		);
		assert.deepEqual(
			piDurableConsumer.prepare?.(definition("agents: ['*']\nruntimes: { other: { required: true } }"), {
				runtime: "pi-durable",
				requestedIsolation: "shared",
			}),
			{ ok: false, reason: "runtime-required" },
		);
		assert.deepEqual(
			piDurableConsumer.prepare?.(definition("agents: ['*']\ndisallowedTools: [agent]"), {
				runtime: "pi-durable",
				requestedIsolation: "shared",
			}),
			{ ok: false, reason: 'pi-durable cannot enforce "disallowedTools".' },
		);
		assert.deepEqual(
			piDurableConsumer.prepare?.(
				definition(
					"agents: ['*']\nskills: [required-skill, { name: optional-skill, required: false }]\nruntimes: { pi-durable: { required: true }, optional: { required: false } }",
				),
				{ runtime: "pi-durable", requestedIsolation: "shared" },
			),
			{
				ok: true,
				enforced: [
					{ path: "skills[0].required", value: true },
					{ path: "runtimes.pi-durable.required", value: true },
				],
			},
		);
	});

	it("passes the enforces conformance level", async () => {
		await assertConformance(piDurableConsumer, { level: "enforces" });
	});
});
