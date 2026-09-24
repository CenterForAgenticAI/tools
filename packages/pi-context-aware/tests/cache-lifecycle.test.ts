import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	convertToLlm,
	estimateTokens,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contextCacheDirectory, legacySessionDirectoryName, migrationLedgerHas, promoteCacheFile, readManifest, readMigrationLedger, writeManifest } from "../context-cache.js";
import { DEFAULT_CONFIG, DEFAULT_CONTEXT_CACHE_CONFIG, type Config, type ContextCacheConfig } from "../config-layers.js";
import {
	buildCacheListingForPrompt,
	buildCacheSeedPreamble,
	buildCacheSystemPromptBlock,
	sendCacheNotification,
} from "../cache-render.js";
import { buildContextTelemetry } from "../context-telemetry.js";
import contextAware from "../index.js";

const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-agent-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
test.after(() => {
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	fs.rmSync(testAgentDir, { recursive: true, force: true });
});

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type BeforeAgentStartHandler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | void> | BeforeAgentStartEventResult | void;
type ContextHandler = (
	event: { type: "context"; messages: AgentMessage[] },
	ctx: ExtensionContext,
) => Promise<{ messages?: AgentMessage[] } | void> | { messages?: AgentMessage[] } | void;

interface RegisteredHandlers {
	beforeAgentStart: BeforeAgentStartHandler[];
	context: ContextHandler[];
}

function registerExtension(): RegisteredHandlers {
	const registered: RegisteredHandlers = { beforeAgentStart: [], context: [] };
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "before_agent_start") {
				registered.beforeAgentStart.push(handler as BeforeAgentStartHandler);
			} else if (event === "context") {
				registered.context.push(handler as ContextHandler);
			}
		},
		registerFlag() {},
		getFlag() {
			return undefined;
		},
		registerCommand() {},
		registerTool() {},
		sendMessage() {},
		sendUserMessage() {},
	};
	contextAware(pi as unknown as ExtensionAPI);
	return registered;
}

function createContext(
	getTokens: () => number,
	contextWindow = 200_000,
	sessionDir = "/tmp/context-aware-cache-lifecycle/session",
	cwd = "/tmp/context-aware-cache-lifecycle",
	branch: readonly unknown[] = [],
): ExtensionContext {
	return {
		cwd,
		model: { contextWindow },
		getContextUsage: () => ({
			tokens: getTokens(),
			contextWindow,
			percent: (getTokens() / contextWindow) * 100,
		}),
		sessionManager: {
			getSessionDir: () => sessionDir,
			getSessionFile: () => path.join(sessionDir, "session.jsonl"),
			getSessionId: () => `cache-lifecycle:${sessionDir}`,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

function initTemporaryGitWorktree(root: string): void {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) delete env[key];
	}
	execFileSync("git", ["init", "-q", root], { env, stdio: "ignore" });
}

function pinDateNow(isoDate: string): () => void {
	const realNow = Date.now;
	const fixedNow = Date.parse(isoDate);
	Date.now = () => fixedNow;
	return () => { Date.now = realNow; };
}

function foregroundCacheConfig(overrides: Partial<ContextCacheConfig> = {}): Config {
	return {
		...DEFAULT_CONFIG,
		contextCache: { ...DEFAULT_CONTEXT_CACHE_CONFIG, ...overrides },
	};
}

/** Resolve the cache system-prompt block in a fresh Node process. */
function renderCacheBlockInChildProcess(cacheDir: string): string {
	const cacheRenderUrl = new URL("../cache-render.js", import.meta.url).href;
	const script = `
const { buildCacheSystemPromptBlock } = await import(${JSON.stringify(cacheRenderUrl)});
const config = {
	seedMode: "auto-gen",
	sessionRole: "foreground",
	compactionModel: null,
	overflowFallbackModel: null,
	seedRewrite: true,
	ambiguityMode: "inherit",
	contextCache: { enabled: true, maxTotalSizeMB: 5, staleHours: 168, scope: "worktree", maxListedFiles: 12 },
};
process.stdout.write(String(buildCacheSystemPromptBlock(process.env.PROBE_CACHE_DIR, config)));
`;
	const env: Record<string, string | undefined> = {
		...process.env,
		PROBE_CACHE_DIR: cacheDir,
	};
	for (const key of Object.keys(env)) {
		if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) delete env[key];
	}
	return execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }).trim();
}

function agentStartEvent(prompt: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt,
		systemPrompt: "base system prompt",
		systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

async function runBeforeAgentStart(
	handlers: RegisteredHandlers,
	ctx: ExtensionContext,
	prompt: string,
): Promise<BeforeAgentStartEventResult> {
	assert.equal(handlers.beforeAgentStart.length, 1);
	const result = await handlers.beforeAgentStart[0](agentStartEvent(prompt), ctx);
	assert.ok(result);
	return result;
}

function persistInjectedMessage(result: BeforeAgentStartEventResult, timestamp: number): AgentMessage {
	assert.ok(result.message, "before_agent_start must use Pi's singular message result property");
	return {
		role: "custom",
		...result.message,
		timestamp,
	} as AgentMessage;
}

async function applyProviderContext(
	handlers: RegisteredHandlers,
	ctx: ExtensionContext,
	messages: AgentMessage[],
): Promise<AgentMessage[]> {
	let current = structuredClone(messages);
	for (const handler of handlers.context) {
		const result = await handler({ type: "context", messages: structuredClone(current) }, ctx);
		if (result?.messages) current = result.messages;
	}
	return current;
}

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolLoopTail(): [AssistantMessage, ToolResultMessage] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large-result.txt" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-test",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "large tool result".repeat(2_000) }],
			isError: false,
			timestamp: 4,
		},
	];
}

function markerTexts(messages: ReturnType<typeof convertToLlm>): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return [];
		return message.content.flatMap((part) =>
			part.type === "text" && part.text.startsWith("<context-telemetry ") ? [part.text] : [],
		);
	});
}

interface AnthropicPayload {
	system?: unknown;
	messages: unknown[];
	tools?: unknown[];
}

const anthropicModel = {
	id: "claude-opus-test",
	name: "Claude Opus Test",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_024,
} satisfies Model<"anthropic-messages">;

async function captureAnthropicPayload(systemPrompt: string, messages: AgentMessage[]): Promise<AnthropicPayload> {
	let captured: unknown;
	const captureComplete = new Error("provider payload captured");
	const context: Context = {
		systemPrompt,
		messages: convertToLlm(messages),
		tools: [],
	};
	const events = streamAnthropic(anthropicModel, context, {
		apiKey: "test-only",
		cacheRetention: "short",
		client: {} as never,
		onPayload(payload) {
			captured = structuredClone(payload);
			throw captureComplete;
		},
	});
	for await (const event of events) {
		if (event.type === "error" && event.error.errorMessage !== captureComplete.message) {
			throw new Error(event.error.errorMessage ?? "Anthropic payload capture failed");
		}
	}
	assert.ok(captured, "Anthropic onPayload hook must expose the provider-shaped request before network I/O");
	return captured as AnthropicPayload;
}

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "cache_control")
			.map(([key, child]) => [key, withoutCacheControl(child)]),
	);
}

test("before_agent_start returns Pi's singular persistent-message contract", async () => {
	const handlers = registerExtension();
	const prompt = "review the cache lifecycle";
	const promptTokens = estimateTokens({
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: 0,
	} as AgentMessage);
	const result = await runBeforeAgentStart(handlers, createContext(() => 24_000), prompt);

	assert.equal(handlers.context.length, 1, "context rewriting is registered only for the one-shot cancellation barrier");
	assert.match(result.systemPrompt ?? "", /<context-awareness>/);
	assert.equal("messages" in result, false);
	assert.deepEqual(result.message, {
		customType: "context-aware-usage-marker",
		content: buildContextTelemetry({
			fraction: (24_000 + promptTokens) / 200_000,
			headroom: 176_000 - promptTokens,
		}),
		display: false,
		details: {
			band: "OK",
			percent: 12,
			headroom: 176_000 - promptTokens,
		},
	});
});

test("system prompt stays byte-identical as cached-document age advances without a cache mutation", async () => {
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-system-prompt-cache-"));
	const cacheDir = contextCacheDirectory(testAgentDir, "/tmp/context-aware-cache-lifecycle");
	const updated = "2026-07-16T20:00:00.000Z";
	writeManifest(cacheDir, {
		version: 1,
		files: {
			"architecture.md": {
				description: "Stable architecture reference",
				createdBy: "test-session",
				updatedBy: "test-session",
				created: updated,
				updated,
				sizeBytes: 4_096,
			},
		},
	});
	const realNow = Date.now;
	try {
		const handlers = registerExtension();
		const ctx = createContext(() => 24_000, 200_000, sessionDir);
		Date.now = () => new Date("2026-07-16T20:05:00.000Z").getTime();
		const first = await runBeforeAgentStart(handlers, ctx, "first turn");
		Date.now = () => new Date("2026-07-16T21:30:00.000Z").getTime();
		const second = await runBeforeAgentStart(handlers, ctx, "second turn");

		assert.equal(
			second.systemPrompt,
			first.systemPrompt,
			"the passage of wall-clock time alone must not invalidate the cached system-prompt prefix",
		);
		// The always-on block reports a count and a pointer, not the file name or its
		// timestamp (issue #78), which is why wall-clock time no longer perturbs it.
		assert.match(first.systemPrompt ?? "", /<context-cache>\n1 reference document from prior sessions is available\. Run \/context-cache-list to view it/);
		assert.doesNotMatch(first.systemPrompt ?? "", /architecture\.md/);
	} finally {
		Date.now = realNow;
		fs.rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("compaction count stays byte-identical between requests without a new boundary", async () => {
	const branch: Array<Record<string, unknown>> = [{ type: "compaction", id: "stable-compaction-1" }];
	const handlers = registerExtension();
	const ctx = createContext(
		() => 24_000,
		200_000,
		"/tmp/context-aware-compaction-count/session",
		"/tmp/context-aware-compaction-count",
		branch,
	);
	const first = await runBeforeAgentStart(handlers, ctx, "first request after compaction");
	const second = await runBeforeAgentStart(handlers, ctx, "second request after compaction");

	assert.equal(first.systemPrompt, second.systemPrompt, "a stable branch must produce a byte-identical system prompt");
	assert.match(first.systemPrompt ?? "", /Current session branch compaction count: 1\./);
	assert.match(first.systemPrompt ?? "", /base system prompt[\s\S]*Current session branch compaction count/);

	branch.push({ type: "compaction", id: "stable-compaction-2" });
	const afterNextCompaction = await runBeforeAgentStart(handlers, ctx, "request after next compaction");
	assert.match(afterNextCompaction.systemPrompt ?? "", /Current session branch compaction count: 2\./);
});

test("scopes cache pools by worktree when session directories are shared", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-scope-")));
	const agentRoot = path.join(root, "agent");
	const worktreeA = path.join(root, "worktree-a");
	const worktreeB = path.join(root, "worktree-b");
	const sharedSessionDir = path.join(root, "sessions", "forks");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restoreDateNow = pinDateNow("2026-07-22T00:00:00.000Z");
	try {
		fs.mkdirSync(worktreeA, { recursive: true });
		fs.mkdirSync(worktreeB, { recursive: true });
		initTemporaryGitWorktree(worktreeA);
		initTemporaryGitWorktree(worktreeB);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		writeManifest(contextCacheDirectory(agentRoot, worktreeA), {
			version: 1,
			files: { "project-a.md": {
				description: "Project A only",
				createdBy: "a",
				updatedBy: "a",
				created: "2026-07-20T00:00:00.000Z",
				updated: "2026-07-20T00:00:00.000Z",
				sizeBytes: 1,
			} },
		});
		writeManifest(contextCacheDirectory(agentRoot, worktreeB), {
			version: 1,
			files: { "project-b.md": {
				description: "Project B only",
				createdBy: "b",
				updatedBy: "b",
				created: "2026-07-21T00:00:00.000Z",
				updated: "2026-07-21T00:00:00.000Z",
				sizeBytes: 1,
			}, "project-b2.md": {
				description: "Project B, a second document",
				createdBy: "bee",
				updatedBy: "bee",
				created: "2026-07-22T09:00:00.000Z",
				updated: "2026-07-22T09:00:00.000Z",
				sizeBytes: 2,
			} },
		});
		const handlers = registerExtension();
		const first = runBeforeAgentStart(handlers, createContext(() => 1, 200_000, sharedSessionDir, worktreeA), "inspect A");
		const second = runBeforeAgentStart(handlers, createContext(() => 1, 200_000, sharedSessionDir, worktreeB), "inspect B");
		const [a, b] = await Promise.all([first, second]);
		// Each worktree session's always-on block counts only its own pool (issue #78):
		// A holds one document, B holds two. A merged/leaked pool would show three.
		assert.match(a.systemPrompt ?? "", /<context-cache>\n1 reference document from prior sessions is available\./);
		assert.match(b.systemPrompt ?? "", /<context-cache>\n2 reference documents from prior sessions are available\./);
		assert.doesNotMatch(a.systemPrompt ?? "", /3 reference documents/);
		assert.doesNotMatch(b.systemPrompt ?? "", /3 reference documents/);
		assert.notEqual(contextCacheDirectory(agentRoot, worktreeA), contextCacheDirectory(agentRoot, worktreeB));
	} finally {
		restoreDateNow();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a worktree session reads the repository pool but not a sibling worktree pool", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-read-wide-")));
	const agentRoot = path.join(root, "agent");
	const repository = path.join(root, "repository");
	const worktree = path.join(root, "worktree");
	const sibling = path.join(root, "sibling");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) delete env[key];
	}
	try {
		initTemporaryGitWorktree(repository);
		fs.writeFileSync(path.join(repository, "README.md"), "temporary repository\n");
		execFileSync("git", ["-C", repository, "add", "README.md"], { env, stdio: "ignore" });
		execFileSync("git", ["-C", repository, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "initial"], { env, stdio: "ignore" });
		execFileSync("git", ["-C", repository, "worktree", "add", "-q", "-b", "lane", worktree], { env, stdio: "ignore" });
		execFileSync("git", ["-C", repository, "worktree", "add", "-q", "-b", "sibling", sibling], { env, stdio: "ignore" });
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		const commonDir = fs.realpathSync(path.join(repository, ".git"));
		const cacheEntry = (updated: string, description: string) => ({
			description,
			createdBy: "test",
			updatedBy: "test",
			created: updated,
			updated,
			sizeBytes: description.length,
		});
		writeManifest(contextCacheDirectory(agentRoot, commonDir), { version: 1, files: {
			"repo.md": { ...cacheEntry("2026-07-22T00:00:00.000Z", "Repository durable note") },
		} });
		writeManifest(contextCacheDirectory(agentRoot, worktree), { version: 1, files: {
			"lane.md": { ...cacheEntry("2026-07-23T00:00:00.000Z", "Lane scratch") },
		} });
		writeManifest(contextCacheDirectory(agentRoot, sibling), { version: 1, files: {
			"sibling.md": { ...cacheEntry("2026-07-24T00:00:00.000Z", "Sibling scratch") },
		} });

		const handlers = registerExtension();
		const result = await runBeforeAgentStart(handlers, createContext(() => 1, 200_000, path.join(root, "session"), worktree), "inspect lane");
		// The always-on block counts the worktree pool and the repository pool (2),
		// never the sibling worktree's pool (which would make it 3) (issue #78).
		assert.match(result.systemPrompt ?? "", /<context-cache>\n2 reference documents from prior sessions are available\. Run \/context-cache-list/);
		assert.doesNotMatch(result.systemPrompt ?? "", /3 reference documents/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("all cache injection paths keep newest entries and render one bounded remainder", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-listing-")));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "worktree");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restoreDateNow = pinDateNow("2026-07-09T00:00:00.000Z");
	try {
		fs.mkdirSync(cwd, { recursive: true });
		initTemporaryGitWorktree(cwd);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		fs.mkdirSync(agentRoot, { recursive: true });
		fs.writeFileSync(path.join(agentRoot, "context-aware.json"), `${JSON.stringify({
			contextCache: { enabled: true, maxListedFiles: 3, scope: "worktree" },
		})}\n`);
		const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
			const updated = new Date(Date.UTC(2026, 6, 1 + index)).toISOString();
			return [`file-${index}.md`, {
				description: `File ${index}`,
				createdBy: "test",
				updatedBy: "test",
				created: updated,
				updated,
				sizeBytes: index + 1,
			}];
		}));
		writeManifest(contextCacheDirectory(agentRoot, cwd), { version: 1, files });
		const cacheDir = contextCacheDirectory(agentRoot, cwd);
		const config = foregroundCacheConfig({ maxListedFiles: 3 });
		const rendered = [
			// The system-prompt block is a count, not a listing surface (issue #78);
			// its count is asserted separately below and must not be capped.
			buildCacheListingForPrompt(cacheDir, config),
			buildCacheSeedPreamble(cacheDir, config),
		];
		const messages: unknown[] = [];
		const entries: Array<{ type: string; data: unknown }> = [];
		const renderers = new Map<string, (entry: unknown, options: { expanded: boolean }, theme: unknown) => unknown>();
		sendCacheNotification({
			registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer as never),
			appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
			sendMessage: (message: unknown) => messages.push(message),
		} as unknown as ExtensionAPI, cacheDir, config, "compaction");
		assert.equal(messages.length, 0);
		const renderer = renderers.values().next().value as ((entry: unknown, options: { expanded: boolean }, theme: unknown) => { render: (width: number) => string[] }) | undefined;
		assert.ok(renderer);
		assert.equal(entries.length, 1);
		rendered.push(renderer(entries[0], { expanded: true }, {} as never).render(200).join("\n"));
		for (const output of rendered) {
			assert.ok(output);
			assert.match(output, /file-7\.md/);
			assert.match(output, /file-6\.md/);
			assert.match(output, /file-5\.md/);
			assert.doesNotMatch(output, /file-4\.md/);
			assert.match(output, /…and 5 more; use \/context-cache-list to see the rest\./);
		}
		// The always-on block counts the full pool (8), never the capped listing (3).
		const block = buildCacheSystemPromptBlock(cacheDir, config);
		assert.match(block ?? "", /8 reference documents from prior sessions are available\. Run \/context-cache-list/);
		assert.doesNotMatch(block ?? "", /file-\d/);
	} finally {
		restoreDateNow();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("worktree read-through renders repository documents but never sibling scratch", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-read-through-")));
	const worktree = path.join(root, "worktree");
	const repo = path.join(root, "repo");
	const sibling = path.join(root, "sibling");
	try {
		const entry = (description: string, updated: string) => ({
			description,
			createdBy: "test",
			updatedBy: "test",
			created: updated,
			updated,
			sizeBytes: description.length,
		});
		writeManifest(worktree, { version: 1, files: { "lane.md": entry("Lane scratch", "2026-07-03T00:00:00.000Z") } });
		writeManifest(repo, { version: 1, files: { "repo.md": entry("Repository durable note", "2026-07-02T00:00:00.000Z") } });
		writeManifest(sibling, { version: 1, files: { "sibling.md": entry("Sibling scratch", "2026-07-04T00:00:00.000Z") } });
		const config = foregroundCacheConfig({ maxListedFiles: 12 });
		const sources = [
			{ cacheDir: worktree, originScope: "worktree" },
			{ cacheDir: repo, originScope: "repo" },
		] as const;
		// A listing surface still names the read-through documents and their origins.
		const output = buildCacheListingForPrompt(sources, config);
		assert.ok(output);
		assert.match(output, /lane\.md/);
		assert.match(output, /repo\.md/);
		assert.match(output, /origin: worktree/);
		assert.match(output, /origin: repo/);
		assert.doesNotMatch(output, /sibling\.md/);
		// The always-on block counts both pools (2) and never the sibling scratch.
		const block = buildCacheSystemPromptBlock(sources, config);
		assert.match(block ?? "", /2 reference documents from prior sessions are available\. Run \/context-cache-list/);
		assert.doesNotMatch(block ?? "", /sibling|lane\.md|repo\.md/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("empty scopes produce no cache output from any injection path", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-empty-"));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "empty");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(cwd, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		const cacheDir = contextCacheDirectory(agentRoot, cwd);
		const config = foregroundCacheConfig({ enabled: false });
		assert.equal(buildCacheSystemPromptBlock(cacheDir, config), null);
		assert.equal(buildCacheListingForPrompt(cacheDir, config), null);
		assert.equal(buildCacheSeedPreamble(cacheDir, config), null);
		const messages: unknown[] = [];
		sendCacheNotification({ sendMessage: (message: unknown) => messages.push(message) } as unknown as ExtensionAPI, cacheDir, config, "compaction");
		assert.deepEqual(messages, []);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("legacy project pools migrate once, preserve sources, and leave forks untouched", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-migration-")));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "worktree");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restoreDateNow = pinDateNow("2026-07-22T00:00:00.000Z");
	try {
		fs.mkdirSync(cwd, { recursive: true });
		initTemporaryGitWorktree(cwd);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		fs.mkdirSync(agentRoot, { recursive: true });
		// Keep migration candidates hermetic: do not consult the real user's
		// worktree index or let unrelated TMPDIR fixtures affect this test.
		fs.writeFileSync(path.join(agentRoot, "context-aware-worktrees.json"), `${JSON.stringify({
			version: 1,
			projects: {
				[path.join(cwd, ".git")]: {
					lastSeen: "2026-07-20T00:00:00.000Z",
					worktrees: { [cwd]: { lastSeen: "2026-07-20T00:00:00.000Z" } },
					sessionCwds: { [cwd]: { lastSeen: "2026-07-20T00:00:00.000Z" } },
				},
			},
		})}\n`);
		const legacy = path.join(agentRoot, "sessions", legacySessionDirectoryName(cwd), "context");
		const forks = path.join(agentRoot, "sessions", "forks", "context");
		writeManifest(legacy, { version: 1, files: { "legacy.md": {
			description: "Legacy project pool",
			createdBy: "old",
			updatedBy: "old",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(legacy, "legacy.md"), "legacy content");
		// A tracked document in the shared fork pool, so it is worth reporting.
		writeManifest(forks, { version: 1, files: { "shared.md": {
			description: "Shared fork pool",
			createdBy: "fork",
			updatedBy: "fork",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(forks, "shared.md"), "shared pool remains untouched");
		const notices: Array<[string, string]> = [];
		const ctx = { ...createContext(() => 1, 200_000, path.join(root, "shared-session"), cwd), hasUI: true, ui: { setWidget() {}, notify: (message: string, severity: string) => notices.push([message, severity]) } } as unknown as ExtensionContext;
		const handlers = registerExtension();
		// runBeforeAgentStart performs the migration; the always-on block reports a
		// count (issue #78). The migrated document itself is asserted on the manifest below.
		assert.match((await runBeforeAgentStart(handlers, ctx, "inspect cache")).systemPrompt ?? "", /1 reference document from prior sessions is available/);
		assert.equal(readManifest(contextCacheDirectory(agentRoot, cwd)).files["legacy.md"]?.description, "Legacy project pool");
		assert.equal(fs.readFileSync(path.join(legacy, "legacy.md"), "utf8"), "legacy content");
		assert.equal(fs.readFileSync(path.join(forks, "shared.md"), "utf8"), "shared pool remains untouched");
		assert.equal(readManifest(contextCacheDirectory(agentRoot, cwd)).files["shared.md"], undefined, "the shared fork pool is never migrated");
		assert.equal(notices.length, 2);
		assert.ok(notices.some(([message]) => message.includes(legacy)));
		// The shared pool is informational: nothing is wrong and nothing is lost.
		assert.deepEqual(notices.find(([message]) => message.includes(forks))?.[1], "info");
		await runBeforeAgentStart(handlers, ctx, "inspect cache again");
		assert.equal(notices.length, 2, "legacy pool notices are emitted once");
	} finally {
		restoreDateNow();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a symlinked non-Git cwd migrates its legacy pool", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-symlink-")));
	const agentRoot = path.join(root, "agent");
	const actual = path.join(root, "a", "b");
	const cwd = path.join(root, "a-b");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(actual, { recursive: true });
		fs.symlinkSync(actual, cwd, "dir");
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		const legacy = path.join(agentRoot, "sessions", legacySessionDirectoryName(cwd), "context");
		writeManifest(legacy, { version: 1, files: { "symlink.md": {
			description: "Symlinked non-Git project",
			createdBy: "old",
			updatedBy: "old",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(legacy, "symlink.md"), "symlink content");

		const ctx = createContext(() => 1, 200_000, path.join(root, "shared-session"), cwd);
		const handlers = registerExtension();
		const result = await runBeforeAgentStart(handlers, ctx, "inspect symlink cache");
		// The block reports a count (issue #78); the migrated document is asserted on the manifest below.
		assert.match(result.systemPrompt ?? "", /1 reference document from prior sessions is available/, "the symlinked legacy pool must migrate");
		assert.equal(readManifest(contextCacheDirectory(agentRoot, actual)).files["symlink.md"]?.description, "Symlinked non-Git project");
		assert.equal(fs.readFileSync(path.join(legacy, "symlink.md"), "utf8"), "symlink content");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an orphaned legacy pool is reported once without migration or deletion", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-orphan-")));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "active");
	const orphanCwd = path.join(root, "deleted-checkout");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(cwd, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		const legacy = path.join(agentRoot, "sessions", legacySessionDirectoryName(orphanCwd), "context");
		writeManifest(legacy, { version: 1, files: { "orphan.md": {
			description: "Orphaned legacy project",
			createdBy: "old",
			updatedBy: "old",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(legacy, "orphan.md"), "orphan content");
		const notices: Array<[string, string]> = [];
		const ctx = { ...createContext(() => 1, 200_000, path.join(root, "shared-session"), cwd), hasUI: true, ui: { setWidget() {}, notify: (message: string, severity: string) => notices.push([message, severity]) } } as unknown as ExtensionContext;
		const handlers = registerExtension();
		const result = await runBeforeAgentStart(handlers, ctx, "inspect orphan cache");
		// An orphaned pool is not migrated, so the scoped pool stays empty and the
		// always-on block is omitted entirely (issue #78).
		assert.doesNotMatch(result.systemPrompt ?? "", /<context-cache>/, "an orphaned pool must not migrate");
		assert.deepEqual(readManifest(contextCacheDirectory(agentRoot, cwd)).files, {});
		assert.equal(fs.readFileSync(path.join(legacy, "orphan.md"), "utf8"), "orphan content");
		assert.equal(notices.filter(([message]) => message.includes(legacy)).length, 1);
		assert.equal(notices.find(([message]) => message.includes(legacy))?.[1], "warning");
		await runBeforeAgentStart(handlers, ctx, "inspect orphan cache again");
		assert.equal(notices.filter(([message]) => message.includes(legacy)).length, 1, "orphan notices are emitted once");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an empty shared fork pool is not reported at all", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-empty-forks-"));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "worktree");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(cwd, { recursive: true });
		initTemporaryGitWorktree(cwd);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		// The directory exists but tracks nothing, which is not worth a notice.
		fs.mkdirSync(path.join(agentRoot, "sessions", "forks", "context"), { recursive: true });
		const notices: string[] = [];
		const ctx = { ...createContext(() => 1, 200_000, path.join(root, "shared-session"), cwd), hasUI: true, ui: { setWidget() {}, notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		const handlers = registerExtension();
		await runBeforeAgentStart(handlers, ctx, "inspect empty cache");
		assert.deepEqual(notices, []);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a migrated document removed from the scoped pool is not resurrected", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-resurrect-")));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "worktree");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restoreDateNow = pinDateNow("2026-07-22T00:00:00.000Z");
	try {
		fs.mkdirSync(cwd, { recursive: true });
		initTemporaryGitWorktree(cwd);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		const legacy = path.join(agentRoot, "sessions", legacySessionDirectoryName(cwd), "context");
		// A legacy document is old by definition, so stale-file cleanup prunes it
		// almost immediately after migration. Re-importing it would resurrect a
		// document the user or the TTL deliberately removed, and the TTL would
		// never reach a fixed point.
		writeManifest(legacy, { version: 1, files: { "legacy.md": {
			description: "Legacy project pool",
			createdBy: "old",
			updatedBy: "old",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(legacy, "legacy.md"), "legacy content");

		const ctx = createContext(() => 1, 200_000, path.join(root, "shared-session"), cwd);
		const scoped = contextCacheDirectory(agentRoot, cwd);
		const handlers = registerExtension();
		// The block reports a count (issue #78); the migrated document is confirmed on the scoped manifest.
		assert.match((await runBeforeAgentStart(handlers, ctx, "inspect cache")).systemPrompt ?? "", /1 reference document from prior sessions is available/, "first run migrates");
		assert.ok(readManifest(scoped).files["legacy.md"], "first run migrates the legacy document into the scoped pool");
		assert.ok(migrationLedgerHas(readMigrationLedger(path.join(agentRoot, "context-cache", "_migrations.json")), legacy),
			"the migration is recorded durably, so a later process makes the same decision");

		// Simulate stale-file cleanup or an explicit delete.
		writeManifest(scoped, { version: 1, files: {} });
		fs.rmSync(path.join(scoped, "legacy.md"), { force: true });

		// The renderer has no process-local migration state. A fresh process still
		// sees the explicitly resolved scoped pool as empty.
		const rendered = renderCacheBlockInChildProcess(scoped);
		assert.equal(rendered, "null", "the removed document must not come back");
		assert.deepEqual(readManifest(scoped).files, {});
		assert.equal(fs.readFileSync(path.join(legacy, "legacy.md"), "utf8"), "legacy content", "the legacy source is still retained");
	} finally {
		restoreDateNow();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a legacy pool whose slug collides across projects is never migrated", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-collision-")));
	const agentRoot = path.join(root, "agent");
	// The legacy slug collapses separators and existing hyphens alike, so these
	// two unrelated project paths produce one legacy directory name.
	const active = path.join(root, "a-b");
	const other = path.join(root, "a", "b");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(active, { recursive: true });
		fs.mkdirSync(other, { recursive: true });
		initTemporaryGitWorktree(active);
		initTemporaryGitWorktree(other);
		assert.equal(legacySessionDirectoryName(active), legacySessionDirectoryName(other), "test requires colliding slugs");
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		fs.mkdirSync(agentRoot, { recursive: true });
		// Both colliding cwds are known to the extension, so the legacy pool
		// cannot be attributed to either one.
		fs.writeFileSync(path.join(agentRoot, "context-aware-worktrees.json"), `${JSON.stringify({
			version: 1,
			projects: {
				[path.join(other, ".git")]: {
					lastSeen: "2026-07-20T00:00:00.000Z",
					worktrees: { [other]: { lastSeen: "2026-07-20T00:00:00.000Z" } },
					sessionCwds: { [other]: { lastSeen: "2026-07-20T00:00:00.000Z" } },
				},
			},
		})}\n`);
		const legacy = path.join(agentRoot, "sessions", legacySessionDirectoryName(active), "context");
		writeManifest(legacy, { version: 1, files: { "ambiguous.md": {
			description: "Could belong to either colliding project",
			createdBy: "old",
			updatedBy: "old",
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			sizeBytes: 5,
		} } });
		fs.writeFileSync(path.join(legacy, "ambiguous.md"), "ambiguous content");

		const notices: Array<[string, string]> = [];
		const ctx = { ...createContext(() => 1, 200_000, path.join(root, "shared-session"), active), hasUI: true, ui: { setWidget() {}, notify: (message: string, severity: string) => notices.push([message, severity]) } } as unknown as ExtensionContext;
		const handlers = registerExtension();
		const result = await runBeforeAgentStart(handlers, ctx, "inspect ambiguous cache");
		assert.doesNotMatch(result.systemPrompt ?? "", /<context-cache>/, "an ambiguous legacy pool must not be listed");
		assert.deepEqual(readManifest(contextCacheDirectory(agentRoot, active)).files, {});
		assert.equal(fs.readFileSync(path.join(legacy, "ambiguous.md"), "utf8"), "ambiguous content");
		assert.equal(notices.filter(([message]) => message.includes(legacy)).length, 1, "ambiguous pools get one visible warning");
		assert.equal(notices.find(([message]) => message.includes(legacy))?.[1], "warning");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("outer-turn marker includes the newly submitted prompt in its usage snapshot", async () => {
	const handlers = registerExtension();
	const prompt = "x".repeat(80_000);
	const baseTokens = 110_000;
	const promptTokens = estimateTokens({
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: 0,
	} as AgentMessage);
	const expectedTokens = baseTokens + promptTokens;
	const result = await runBeforeAgentStart(handlers, createContext(() => baseTokens), prompt);

	assert.ok(expectedTokens / 200_000 >= 0.6, "fixture must cross the WARN threshold");
	assert.deepEqual(result.message?.details, {
		band: "WARN",
		percent: Math.round((expectedTokens / 200_000) * 100),
		headroom: 200_000 - expectedTokens,
	});
	assert.match(
		String(result.message?.content),
		/<pressure band="WARN" usage-percent="65" approximate-headroom="70k" action="gate-broad-work" \/>/,
	);
});

test("LLM transcript prefix remains append-only across provider calls in a tool loop", async () => {
	const handlers = registerExtension();
	let usageTokens = 24_000;
	const ctx = createContext(() => usageTokens);
	const start = await runBeforeAgentStart(handlers, ctx, "inspect the cache");
	const initialMessages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "inspect the cache" }], timestamp: 1 } as UserMessage,
		persistInjectedMessage(start, 2),
	];
	const firstRequest = convertToLlm(await applyProviderContext(handlers, ctx, initialMessages));

	usageTokens = 90_000;
	const secondRequest = convertToLlm(
		await applyProviderContext(handlers, ctx, [...initialMessages, ...toolLoopTail()]),
	);

	assert.deepEqual(
		secondRequest.slice(0, firstRequest.length),
		firstRequest,
		"later provider calls must append after, not replace or relocate, the marker-bearing cache prefix",
	);
	assert.deepEqual(markerTexts(firstRequest), [String(start.message?.content)]);
	assert.deepEqual(markerTexts(secondRequest), [String(start.message?.content)]);
});

test("Anthropic provider payload preserves the marker-bearing cache prefix across a tool loop", async () => {
	const handlers = registerExtension();
	const ctx = createContext(() => 24_000);
	const start = await runBeforeAgentStart(handlers, ctx, "inspect the provider cache");
	const initialMessages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "inspect the provider cache" }], timestamp: 1 } as UserMessage,
		persistInjectedMessage(start, 2),
	];
	const systemPrompt = start.systemPrompt ?? "";
	const firstPayload = await captureAnthropicPayload(systemPrompt, initialMessages);
	const secondPayload = await captureAnthropicPayload(systemPrompt, [...initialMessages, ...toolLoopTail()]);
	const firstMessages = withoutCacheControl(firstPayload.messages) as unknown[];
	const secondMessages = withoutCacheControl(secondPayload.messages) as unknown[];

	assert.deepEqual(withoutCacheControl(secondPayload.system), withoutCacheControl(firstPayload.system));
	assert.deepEqual(withoutCacheControl(secondPayload.tools), withoutCacheControl(firstPayload.tools));
	assert.deepEqual(
		secondMessages.slice(0, firstMessages.length),
		firstMessages,
		"provider-managed cache breakpoints may move forward, but prior prompt content must remain unchanged",
	);
	assert.match(JSON.stringify(firstPayload.messages), /<context-telemetry source=/);
});

test("the next outer user turn appends a new marker without rewriting the previous prompt prefix", async () => {
	const handlers = registerExtension();
	let usageTokens = 24_000;
	const ctx = createContext(() => usageTokens);
	const firstStart = await runBeforeAgentStart(handlers, ctx, "first outer turn");
	const firstTurnMessages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "first outer turn" }], timestamp: 1 } as UserMessage,
		persistInjectedMessage(firstStart, 2),
		...toolLoopTail(),
	];
	const previousRequest = convertToLlm(await applyProviderContext(handlers, ctx, firstTurnMessages));

	usageTokens = 130_000;
	const secondStart = await runBeforeAgentStart(handlers, ctx, "second outer turn");
	const nextTurnMessages: AgentMessage[] = [
		...firstTurnMessages,
		{ role: "user", content: [{ type: "text", text: "second outer turn" }], timestamp: 5 } as UserMessage,
		persistInjectedMessage(secondStart, 6),
	];
	const nextRequest = convertToLlm(await applyProviderContext(handlers, ctx, nextTurnMessages));

	assert.equal(firstStart.systemPrompt, secondStart.systemPrompt, "stable inputs must produce an identical system prompt");
	assert.deepEqual(nextRequest.slice(0, previousRequest.length), previousRequest);
	assert.deepEqual(markerTexts(nextRequest), [
		String(firstStart.message?.content),
		String(secondStart.message?.content),
	]);
});

// The always-on block points the user at /context-cache-list to view the counted
// documents, so that command must actually name every one of them — including a
// promoted artifact beyond maxListedFiles (issue #78, epic/422). Exercises the
// real registered command, not a helper.
test("/context-cache-list names every document, including a promoted artifact beyond the cap", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-cache-list-cmd-")));
	const agentRoot = path.join(root, "agent");
	const cwd = path.join(root, "worktree");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(cwd, { recursive: true });
		initTemporaryGitWorktree(cwd);
		process.env.PI_CODING_AGENT_DIR = agentRoot;
		fs.mkdirSync(agentRoot, { recursive: true });
		fs.writeFileSync(path.join(agentRoot, "context-aware.json"), `${JSON.stringify({ contextCache: { enabled: true, maxListedFiles: 2, scope: "worktree" } })}\n`);
		const cacheDir = contextCacheDirectory(agentRoot, cwd);
		// Two recent ordinary entries fill the maxListedFiles=2 window.
		writeManifest(cacheDir, { version: 1, files: {
			"ordinary-a.md": { description: "Ordinary A", createdBy: "t", updatedBy: "t", created: "2026-07-30T00:00:00.000Z", updated: "2026-07-30T00:00:00.000Z", sizeBytes: 4 },
			"ordinary-b.md": { description: "Ordinary B", createdBy: "t", updatedBy: "t", created: "2026-07-31T00:00:00.000Z", updated: "2026-07-31T00:00:00.000Z", sizeBytes: 4 },
		} });
		// Promote a real file, then backdate its manifest entry so it is the oldest and
		// lands outside the 2-entry cap. promoteCacheFile stamps the wall clock via
		// new Date() (which Date.now cannot override); the entry keeps its promotion
		// provenance and on-disk content.
		const sourcePath = path.join(root, "promoted-source.md");
		fs.writeFileSync(sourcePath, "promoted body");
		const promoted = promoteCacheFile(cacheDir, readManifest(cacheDir), "session-x", sourcePath, "promoted.md", "Promoted artifact");
		promoted.manifest.files["promoted.md"]!.created = "2026-01-01T00:00:00.000Z";
		promoted.manifest.files["promoted.md"]!.updated = "2026-01-01T00:00:00.000Z";
		writeManifest(cacheDir, promoted.manifest);

		// Register the extension and capture the /context-cache-list command handler.
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
		const pi = {
			on() {}, registerFlag() {}, getFlag() { return undefined; },
			registerCommand(name: string, definition: unknown) { commands.set(name, definition as never); },
			registerTool() {}, sendMessage() {}, sendUserMessage() {},
		};
		contextAware(pi as unknown as ExtensionAPI);
		const command = commands.get("context-cache-list");
		assert.ok(command, "the extension registers /context-cache-list");

		const notices: Array<[string, string]> = [];
		const ctx = { ...createContext(() => 1, 200_000, path.join(root, "session"), cwd), hasUI: true, ui: { setWidget() {}, setStatus() {}, notify: (message: string, severity: string) => notices.push([message, severity]) } } as unknown as ExtensionContext;
		await command.handler("", ctx);

		assert.equal(notices.length, 1);
		const output = notices[0]![0];
		assert.match(output, /Context cache \(3 files/);
		assert.match(output, /ordinary-a\.md/);
		assert.match(output, /ordinary-b\.md/);
		// The promoted artifact, oldest and beyond the cap, is still named.
		assert.match(output, /promoted\.md/);
		// No capped remainder: the command no longer hides entries behind “and N more”.
		assert.doesNotMatch(output, /and \d+ more/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
