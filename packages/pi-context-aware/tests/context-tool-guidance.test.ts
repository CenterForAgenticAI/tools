import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultCountTokens } from "../src/folds/kernel/tokenize.js";
import { buildContextToolsSection } from "../src/platform/prompt-sections.js";
import { createHostPi, createSession } from "./compaction-owner-harness.js";

// pi-context-aware#195 (REQ-TOOLS-001): the guidance for the six context tools measures at or under 1,500 tokens.
// The count covers the prompt section plus each tool's promptSnippet and promptGuidelines; descriptions are not counted.

const LIMIT = 1500;
const SIX = ["context_fold", "context_recall", "context_status", "context_compact", "session_focus", "session_tasks"] as const;
const OLD_NAMES = /\b(compress|decompress|search_context|acp_status|compact_session|search_prior_sessions|session_recall|session_compaction_history)\b/u;

interface RegisteredTool { promptSnippet?: string; promptGuidelines?: string[]; exposure?: string }

async function loadTools(): Promise<Map<string, RegisteredTool>> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-tool-guidance-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false } }));
		const host = createHostPi();
		const extension = await import(`../src/index.js?tool-guidance=${Date.now()}`);
		extension.default(host.api);
		const session = createSession(root, "tool-guidance-session");
		await host.handler("session_start")({ reason: "startup" }, session.ctx);
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
		return host.tools as unknown as Map<string, RegisteredTool>;
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
}

const ALL = { status: true, recall: true, fold: true, compact: true } as const;

function toolText(tool: RegisteredTool): string {
	return [tool.promptSnippet ?? "", ...(tool.promptGuidelines ?? [])].join("\n");
}

function worstCase(tools: Map<string, RegisteredTool>): { total: number; parts: Record<string, number>; text: string } {
	const section = buildContextToolsSection(ALL) ?? "";
	const parts: Record<string, number> = { "context-tools section": defaultCountTokens(section) };
	const texts = [section];
	for (const name of SIX) {
		// context_fold registers only while billion-context-pi is absent; a stub with the same text stands in if it did not.
		const tool = tools.get(name);
		assert.ok(tool, `${name} is registered`);
		const text = toolText(tool);
		parts[name] = defaultCountTokens(text);
		texts.push(text);
	}
	const text = texts.join("\n");
	return { total: defaultCountTokens(section) + SIX.reduce((sum, name) => sum + parts[name]!, 0), parts, text };
}

test("REQ-TOOLS-001: section, snippets and guidelines of the six tools measure at or under 1,500 tokens", async () => {
	const tools = await loadTools();
	const { total, parts } = worstCase(tools);
	console.log(`context tool guidance: ${total} tokens ${JSON.stringify(parts)}`);
	assert.ok(total <= LIMIT, `guidance is ${total} tokens, over ${LIMIT}: ${JSON.stringify(parts)}`);
	assert.ok(total > 300, "the count includes real guidance, not an empty render");
});

test("the budget check goes red when a tool's guidance grows", async () => {
	const tools = await loadTools();
	const fat = new Map(tools);
	fat.set("context_recall", { promptSnippet: "x", promptGuidelines: ["word ".repeat(LIMIT * 2)] });
	assert.ok(worstCase(fat).total > LIMIT);
});

test("the context-tools section names no old tool and lists the four context tools", () => {
	const section = buildContextToolsSection(ALL) ?? "";
	assert.doesNotMatch(section, OLD_NAMES);
	for (const name of ["context_fold", "context_recall", "context_status", "context_compact"]) assert.ok(section.includes(name), name);
});

test("the context_fold lines render only when context_fold is reachable", () => {
	const without = buildContextToolsSection({ ...ALL, fold: false }) ?? "";
	assert.doesNotMatch(without, /context_fold|\bcompress\b|fold what you have/u);
	assert.match(buildContextToolsSection(ALL) ?? "", /context_fold/u);
	assert.equal(buildContextToolsSection({ status: false, recall: false, fold: false, compact: false }), null);
});

test("the guidance of the new tools names no old tool", async () => {
	const tools = await loadTools();
	for (const name of ["context_fold", "context_recall", "context_status", "context_compact"]) {
		assert.doesNotMatch(toolText(tools.get(name)!), OLD_NAMES, name);
	}
});

test("AC-196-3: the context-tools section has no alias line", () => {
	const section = buildContextToolsSection(ALL) ?? "";
	assert.match(section, /context_compact/u);
	assert.doesNotMatch(section, /aliases|Old names|decompress|search_context|acp_status|\bcompress\b/u);
});

async function sectionsFor(active: readonly string[], foreignTools: readonly string[] = []): Promise<Record<string, string>> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-tool-wiring-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false } }));
		const host = createHostPi();
		const extension = await import(`../src/index.js?tool-wiring=${Date.now()}-${Math.random()}`);
		extension.default(host.api);
		for (const name of foreignTools) (host.api as unknown as { registerTool(tool: { name: string }): void }).registerTool({ name });
		const session = createSession(root, "tool-wiring-session");
		await host.handler("session_start")({ reason: "startup" }, session.ctx);
		host.api.setActiveTools([...active]);
		const event = { type: "before_agent_start", prompt: "hello", systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
		await host.handler("before_agent_start")(event as never, session.ctx);
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
		return event.systemPromptOptions.sections;
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
}

test("CR-FOLD-WIRING-UNTESTED: the section's flags follow the registered and reachable tools in a real session", async () => {
	const withFold = (await sectionsFor(["context_status", "context_recall", "context_fold", "context_compact"]))["context-tools"] ?? "";
	assert.match(withFold, /- context_fold:/u);
	assert.match(withFold, /fold what you have finished with/u);
	assert.doesNotMatch(withFold, OLD_NAMES);
	const withoutFold = (await sectionsFor(["context_status", "context_recall", "context_compact"]))["context-tools"] ?? "";
	assert.match(withoutFold, /- context_recall:/u);
	assert.doesNotMatch(withoutFold, /context_fold|\bcompress\b|fold what you have/u);
	assert.equal((await sectionsFor([]))["context-tools"], undefined, "no section when no context tool is reachable");
});

test("CR-ALIAS-BCP-LOADED: no session lists an old tool name, with or without billion-context-pi's acp_cache tool", async () => {
	const loaded = (await sectionsFor(["context_status", "context_recall", "context_compact"], ["acp_cache"]))["context-tools"] ?? "";
	assert.match(loaded, /- context_recall:/u);
	assert.doesNotMatch(loaded, OLD_NAMES);
	const absent = (await sectionsFor(["context_status", "context_recall", "context_compact"]))["context-tools"] ?? "";
	assert.doesNotMatch(absent, OLD_NAMES);
});
