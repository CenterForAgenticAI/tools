import assert from "node:assert/strict";
import test from "node:test";

import {
	registerLoadSkillTool,
	skillsFromSystemPrompt,
	type DiscoveredSkill,
	type LoadSkillContext,
	type LoadSkillParams,
} from "../src/skills/load-skill.js";

/** A system prompt in the exact shape Pi's `formatSkillsForPrompt` emits. */
function promptWith(entries: Array<{ name: string; description: string; location: string }>): string {
	const skills = entries
		.map(
			(entry) =>
				`  <skill>\n    <name>${entry.name}</name>\n` +
				`    <description>${entry.description}</description>\n` +
				`    <location>${entry.location}</location>\n  </skill>`,
		)
		.join("\n");
	return [
		"You are an expert coding assistant.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"",
		"<available_skills>",
		skills,
		"</available_skills>",
		"",
		"Guidelines:",
	].join("\n");
}

const PROMPT = promptWith([
	{ name: "glab", description: "Operate GitLab from the terminal", location: "/pkg/modules/glab/skills/glab/SKILL.md" },
	{ name: "test-execution", description: "Read-only test worker", location: "/pkg/skills/test-execution/SKILL.md" },
]);

type Tool = {
	name: string;
	description?: string;
	promptGuidelines?: string[];
	parameters?: { properties?: { name?: { description?: string } } };
	execute?(
		toolCallId: string,
		params: LoadSkillParams,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: LoadSkillContext,
	): unknown;
};

/** Registers the tool and records every path the reader was asked for. */
function registered(options: {
	prompt?: string;
	contents?: Record<string, string>;
	discover?: (cwd: string, projectTrusted: boolean) => Promise<readonly DiscoveredSkill[]>;
} = {}) {
	const reads: string[] = [];
	const contents = options.contents ?? { "/pkg/modules/glab/skills/glab/SKILL.md": "# glab skill body" };
	let tool: Tool | undefined;
	let onBeforeAgentStart: ((
		event: { systemPrompt: string; systemPromptOptions?: { skills?: readonly DiscoveredSkill[] } },
		ctx: { cwd: string; isProjectTrusted: () => boolean },
	) => unknown) | undefined;
	registerLoadSkillTool(
		{
			registerTool: (definition) => { tool = definition as unknown as Tool; },
			on: (_event, handler) => { onBeforeAgentStart = handler as typeof onBeforeAgentStart; },
		},
		(filePath) => {
			reads.push(filePath);
			const body = contents[filePath];
			if (body === undefined) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
			return body;
		},
		options.discover ?? (async () => []),
	);
	assert.ok(tool, "registerLoadSkillTool registered no tool");
	const ctx: LoadSkillContext = { getSystemPrompt: () => options.prompt ?? PROMPT };
	return {
		reads,
		tool,
		/** Deliver the event Pi fires before each agent loop. */
		agentStart(event: { systemPrompt: string; systemPromptOptions?: { skills?: readonly DiscoveredSkill[] } }) {
			onBeforeAgentStart?.(event, { cwd: process.cwd(), isProjectTrusted: () => true });
		},
		async call(name: string) {
			const result = await tool!.execute!("call-1", { name }, undefined, undefined, ctx);
			return result as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
		},
	};
}

test("the tool registers under the name the guidance tells agents to call", () => {
	const { tool } = registered();
	assert.equal(tool.name, "load_skill");
});

test("a known name returns the skill body and the path it came from", async () => {
	const harness = registered();
	const result = await harness.call("glab");
	assert.match(result.content[0]!.text, /# glab skill body/);
	assert.match(result.content[0]!.text, /\/pkg\/modules\/glab\/skills\/glab\/SKILL\.md/);
	assert.equal(result.details.path, "/pkg/modules/glab/skills/glab/SKILL.md");
	assert.equal(result.details.name, "glab");
	assert.deepEqual(harness.reads, ["/pkg/modules/glab/skills/glab/SKILL.md"]);
});

/**
 * The requirement is not "the tool does not build a path". It is that nothing a
 * caller sends can cause a read outside the discovered set. So the assertion is
 * on the reader: it must never be called at all for these inputs.
 */
for (const hostile of [
	"../../etc/passwd",
	"/etc/passwd",
	"~/.pi/agent/skills/glab/SKILL.md",
	"/pkg/modules/glab/skills/glab/SKILL.md",
	"glab/../../../etc/shadow",
]) {
	test(`a path-shaped name reads nothing: ${JSON.stringify(hostile)}`, async () => {
		const harness = registered();
		const result = await harness.call(hostile);
		assert.deepEqual(harness.reads, [], "a caller-supplied path reached the filesystem");
		assert.equal(result.details.error, "unknown");
		assert.match(result.content[0]!.text, /Do not construct a skill path/);
	});
}

test("an unknown name lists what this session can load", async () => {
	const harness = registered();
	const result = await harness.call("gitlab");
	assert.deepEqual(result.details.available, ["glab", "test-execution"]);
	assert.match(result.content[0]!.text, /Available: glab, test-execution/);
});

test("a discovered skill whose file cannot be read reports that, and does not look elsewhere", async () => {
	const harness = registered({ contents: {} });
	const result = await harness.call("glab");
	assert.equal(result.details.error, "unreadable");
	assert.equal(result.details.path, "/pkg/modules/glab/skills/glab/SKILL.md");
	assert.match(result.content[0]!.text, /Report this rather than looking for the file somewhere else/);
	assert.deepEqual(harness.reads, ["/pkg/modules/glab/skills/glab/SKILL.md"]);
});

test("a host without a system prompt refuses instead of crashing", async () => {
	const reads: string[] = [];
	let tool: Tool | undefined;
	registerLoadSkillTool(
		{ registerTool: (definition) => { tool = definition as unknown as Tool; }, on: () => {} },
		(filePath) => { reads.push(filePath); return ""; },
	);
	const result = (await tool!.execute!("call-1", { name: "glab" }, undefined, undefined, {})) as {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	};
	assert.equal(result.details.error, "no-skills");
	assert.deepEqual(reads, []);
});

test("with listen false the caller's capture resolves skills, and a host without isProjectTrusted distrusts project skills", async () => {
	const events: string[] = [];
	const trusted: boolean[] = [];
	let tool: Tool | undefined;
	const capture = registerLoadSkillTool(
		{ registerTool: (definition) => { tool = definition as unknown as Tool; }, on: (event) => { events.push(event); } },
		() => "# fallback body",
		async (_cwd, projectTrusted) => {
			trusted.push(projectTrusted);
			return [{ name: "late", description: "Late skill", filePath: "/pkg/skills/late/SKILL.md" }];
		},
		undefined,
		{ listen: false },
	);
	assert.deepEqual(events, [], "listen false must not add a before_agent_start handler");
	capture({ systemPrompt: "You are a worker.", systemPromptOptions: { skills: [] } }, { cwd: "/repo" } as unknown as Parameters<typeof capture>[1]);
	const result = (await tool!.execute!("call-1", { name: "late" }, undefined, undefined, {})) as {
		content: Array<{ type: "text"; text: string }>;
	};
	assert.match(result.content[0]!.text, /# fallback body/);
	assert.deepEqual(trusted, [false]);
});

test("the tool's guidance tells the agent not to fall back to a guessed path", () => {
	const { tool } = registered();
	const guidance = (tool.promptGuidelines ?? []).join(" ");
	assert.match(guidance, /Do not construct a skill path/);
	assert.match(`${tool.description}`, /~\/\.pi\/agent\/skills\/<name>\/SKILL\.md/);
});

test("the tool, parameter, and guidelines say available_skills is not exhaustive", () => {
	const { tool } = registered();
	const guidance = (tool.promptGuidelines ?? []).join(" ");
	const nameDescription = tool.parameters?.properties?.name?.description ?? "";
	assert.match(`${tool.description}`, /need not appear in <available_skills>/);
	assert.match(nameDescription, /<available_skills> is not exhaustive/);
	assert.match(guidance, /even if it is absent from <available_skills>/);
	assert.match(guidance, /list is not exhaustive/);
});

test("the prompt parser reads the block Pi actually emits, entities and all", () => {
	const skills = skillsFromSystemPrompt(
		promptWith([{ name: "a&b", description: "quotes &quot;here&quot;", location: "/p/a&amp;b/SKILL.md" }]),
	);
	assert.deepEqual(skills, [{ name: "a&b", description: 'quotes "here"', filePath: "/p/a&b/SKILL.md" }]);
});

test("a prompt with no skills block yields no skills", () => {
	assert.deepEqual(skillsFromSystemPrompt("You are an expert coding assistant."), []);
});

/**
 * The delegate-worker case, which is where 412 of the 523 recorded failures
 * happened. A worker's `ctx.getSystemPrompt()` returns a prompt with no
 * `<available_skills>` block, verified on 2026-08-25 by dispatching a real
 * `tester`. Resolution must come from `before_agent_start` instead.
 */
test("a worker resolves from before_agent_start when its context prompt has no skills", async () => {
	const harness = registered({ prompt: "You are a read-only test worker." });
	const beforeEvent = await harness.call("glab");
	assert.equal(beforeEvent.details.error, "no-skills", "precondition: the context prompt resolves nothing");
	assert.deepEqual(harness.reads, []);

	harness.agentStart({
		systemPrompt: "You are a read-only test worker.",
		systemPromptOptions: {
			skills: [
				{ name: "glab", description: "GitLab CLI", filePath: "/pkg/modules/glab/skills/glab/SKILL.md" },
			],
		},
	});

	const afterEvent = await harness.call("glab");
	assert.match(afterEvent.content[0]!.text, /# glab skill body/);
	assert.equal(afterEvent.details.path, "/pkg/modules/glab/skills/glab/SKILL.md");
});

test("a worker can load a skill outside its declared skills from the wider discovered set", async () => {
	const harness = registered({
		prompt: "You are a worker.",
		discover: async () => [
			{ name: "adopting-external-skills", description: "Use external skills", filePath: "/pkg/skills/adopting-external-skills/SKILL.md" },
		],
		contents: { "/pkg/skills/adopting-external-skills/SKILL.md": "# external skill body" },
	});
	harness.agentStart({
		systemPrompt: "You are a worker.",
		systemPromptOptions: {
			skills: [
				{ name: "implement", description: "Implement code", filePath: "/pkg/skills/implement/SKILL.md" },
			],
		},
	});

	const result = await harness.call("adopting-external-skills");
	assert.match(result.content[0]!.text, /# external skill body/);
	assert.match(result.content[0]!.text, /outside this agent's declared skill set/);
	assert.deepEqual(harness.reads, ["/pkg/skills/adopting-external-skills/SKILL.md"]);
});

test("the fallback resolves a skill hidden from model invocation", async () => {
	const hiddenSkill = {
		name: "test-execution",
		description: "Read-only test worker",
		filePath: "/pkg/skills/test-execution/SKILL.md",
		disableModelInvocation: true,
	};
	const harness = registered({
		prompt: "You are a worker.",
		discover: async () => [hiddenSkill],
		contents: { "/pkg/skills/test-execution/SKILL.md": "# hidden worker skill body" },
	});
	harness.agentStart({
		systemPrompt: "You are a worker.",
		systemPromptOptions: {
			skills: [
				{ name: "implement", description: "Implement code", filePath: "/pkg/skills/implement/SKILL.md" },
			],
		},
	});

	const result = await harness.call("test-execution");
	assert.match(result.content[0]!.text, /# hidden worker skill body/);
	assert.match(result.content[0]!.text, /full discovered skill set/);
	assert.equal(result.details.path, "/pkg/skills/test-execution/SKILL.md");
	assert.deepEqual(harness.reads, ["/pkg/skills/test-execution/SKILL.md"]);
});

test("an unknown worker name lists the wider discovered set", async () => {
	const harness = registered({
		discover: async () => [
			{ name: "adopting-external-skills", description: "Use external skills", filePath: "/pkg/skills/adopting-external-skills/SKILL.md" },
		],
	});
	harness.agentStart({
		systemPrompt: "You are a worker.",
		systemPromptOptions: {
			skills: [
				{ name: "implement", description: "Implement code", filePath: "/pkg/skills/implement/SKILL.md" },
			],
		},
	});

	const result = await harness.call("missing");
	assert.equal(result.details.error, "unknown");
	assert.deepEqual(result.details.available, ["adopting-external-skills"]);
	assert.deepEqual(harness.reads, []);
});

test("a path-shaped name never reaches the reader through the wider discovered set", async () => {
	const harness = registered({
		discover: async () => [
			{ name: "adopting-external-skills", description: "Use external skills", filePath: "/pkg/skills/adopting-external-skills/SKILL.md" },
		],
	});
	harness.agentStart({
		systemPrompt: "You are a worker.",
		systemPromptOptions: {
			skills: [
				{ name: "implement", description: "Implement code", filePath: "/pkg/skills/implement/SKILL.md" },
			],
		},
	});

	for (const hostile of [
		"../../etc/passwd",
		"/etc/passwd",
		"adopting-external-skills/../../etc/shadow",
		"adopting-external-skills\u0000",
		"．．/etc/passwd",
	]) {
		const result = await harness.call(hostile);
		assert.equal(result.details.error, "unknown");
	}
	assert.deepEqual(harness.reads, []);
});

test("an event carrying no structured skills falls back to parsing its own prompt", async () => {
	const harness = registered({ prompt: "no skills here" });
	harness.agentStart({ systemPrompt: PROMPT });
	const result = await harness.call("glab");
	assert.equal(result.details.path, "/pkg/modules/glab/skills/glab/SKILL.md");
});

test("the captured list is replaced, not accumulated, when the prompt changes", async () => {
	const harness = registered({ prompt: "no skills here" });
	harness.agentStart({ systemPrompt: PROMPT });
	harness.agentStart({
		systemPrompt: promptWith([
			{ name: "test-execution", description: "Read-only test worker", location: "/pkg/skills/test-execution/SKILL.md" },
		]),
	});
	const result = await harness.call("glab");
	assert.equal(result.details.error, "unknown", "a skill dropped from the prompt must stop resolving");
	assert.deepEqual(result.details.available, ["test-execution"]);
});
