import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piPromptHandler } from "./pi-prompt-render.js";

// A Fabric child ends with its run, so nothing would deliver a compaction
// handoff after it. These tests pin the three sites in src/index.ts that check
// compactSessionContinuation() for that reason: the output-limit recovery, the
// /checkin prompt and the per-turn context-awareness guidance. Each test runs the
// same setup as a root session and as a child, so removing a guard makes the
// child case behave like the root case and fails.

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

const CHILD_LINEAGE = JSON.stringify({ version: 1, rootSessionId: "root", runId: "child-run", depth: 1, childIndex: 0, worker: true });
const FABRIC_ENV = ["PI_FABRIC_LINEAGE", "PI_FABRIC_DEPTH"] as const;

/** Run `fn` as a Fabric child or as a root session, then restore the environment. */
async function asSession<T>(role: "root" | "child", fn: () => Promise<T>): Promise<T> {
	const previous = FABRIC_ENV.map((name) => [name, process.env[name]] as const);
	for (const name of FABRIC_ENV) delete process.env[name];
	if (role === "child") process.env.PI_FABRIC_LINEAGE = CHILD_LINEAGE;
	try {
		return await fn();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

interface Harness {
	api: ExtensionAPI;
	dispatch: (name: string, event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
	userMessages: unknown[];
}

function createHarness(activeTools: readonly string[]): Harness {
	const events = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const userMessages: unknown[] = [];
	const channels = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBus = {
		emit(channel, data) {
			for (const handler of channels.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const listeners = channels.get(channel) ?? new Set<(data: unknown) => void>();
			listeners.add(handler);
			channels.set(channel, listeners);
			return () => listeners.delete(handler);
		},
	};
	const flags = new Map<string, unknown>([["context-aware-proactive", "95%"]]);
	const api = {
		events: bus,
		on(name: string, handler: Handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(name === "before_agent_start" ? piPromptHandler(handler) : handler);
			events.set(name, handlers);
		},
		registerFlag() {},
		getFlag(name: string) { return flags.get(name); },
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => unknown }) { commands.set(name, definition); },
		registerTool() {},
		getActiveTools() { return [...activeTools]; },
		setActiveTools() {},
		sendMessage() {},
		sendUserMessage(message: unknown) { userMessages.push(message); },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	// Several handlers can share an event; dispatch them all in Pi order.
	const dispatch = async (name: string, event: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> => {
		let result: unknown;
		let current = event;
		for (const handler of events.get(name) ?? []) {
			const next = await handler(current, ctx);
			if (next !== undefined) {
				result = next;
				if (typeof next === "object" && next !== null) current = { ...current, ...next };
			}
		}
		return result;
	};
	return { api, dispatch, commands, userMessages };
}

function createContext(root: string, sessionId: string, notifications: string[]): ExtensionContext {
	const entries: unknown[] = [];
	return {
		hasUI: true,
		mode: "interactive",
		cwd: root,
		model: { contextWindow: 272_000, maxTokens: 128_000 },
		getContextUsage: () => ({ tokens: 268_016, contextWindow: 272_000 }),
		isProjectTrusted: () => true,
		isIdle: () => true,
		abort: () => {},
		compact: () => {},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			appendCustomEntry: () => `${sessionId}-entry`,
			getSessionDir: () => root,
			getSessionFile: () => path.join(root, `${sessionId}.jsonl`),
			getSessionId: () => sessionId,
			getHeader: () => ({ parentSession: undefined }),
			getLeafId: () => `${sessionId}-leaf`,
		},
	} as unknown as ExtensionContext;
}

interface Loaded {
	harness: Harness;
	ctx: ExtensionContext;
	notifications: string[];
}

/**
 * Load the extension against a private agent directory and run `fn` with it.
 * The extension module is shared across tests, so each run uses its own session id.
 */
async function withExtension<T>(sessionId: string, activeTools: readonly string[], fn: (loaded: Loaded) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-child-guards-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), `${JSON.stringify({
		seedMode: "auto-gen",
		compactionModel: null,
		overflowFallbackModel: null,
		seedRewrite: true,
		ambiguityMode: "inherit",
		contextCache: { enabled: false },
		workstream: { enabled: false },
	})}\n`);
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const extension = await import("../src/index.js");
		const harness = createHarness(activeTools);
		extension.default(harness.api);
		const notifications: string[] = [];
		return await fn({ harness, ctx: createContext(root, sessionId, notifications), notifications });
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** An assistant reply that ran out of output space with almost no context headroom. */
function truncatedReply(): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "truncated-call", name: "delegate", arguments: { agents: "partial" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.6-sol",
		usage: {
			input: 3,
			output: 1_264,
			cacheRead: 265_530,
			cacheWrite: 1_219,
			reasoning: 10,
			totalTokens: 268_016,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "length",
		timestamp: Date.now(),
	};
}

async function outputLimitReply(role: "root" | "child"): Promise<{ result: unknown; notifications: string[] }> {
	return asSession(role, () => withExtension(`child-guard-output-limit-${role}`, ["read", "bash", "edit"], async ({ harness, ctx, notifications }) => {
		const result = await harness.dispatch("message_end", { message: truncatedReply() }, ctx);
		return { result, notifications };
	}));
}

test("output-limit recovery discards and retries a truncated reply in a root session", async () => {
	const { result, notifications } = await outputLimitReply("root");
	const message = (result as { message?: { stopReason?: string; content: Array<{ text?: string }> } } | undefined)?.message;
	assert.ok(message, "a root session replaces the truncated reply");
	assert.equal(message.stopReason, "length");
	assert.match(message.content[0]?.text ?? "", /stopped before any partial tool call could run/u);
	assert.ok(notifications.some((text) => /retrying the interrupted work once/u.test(text)));
});

test("output-limit recovery leaves a Fabric child's truncated reply alone", async () => {
	const { result, notifications } = await outputLimitReply("child");
	assert.equal(result, undefined, "a child keeps the reply: nothing would retry the work after the run ends");
	assert.deepEqual(notifications.filter((text) => /retrying the interrupted work once/u.test(text)), []);
});

async function checkinPrompt(role: "root" | "child"): Promise<string> {
	return asSession(role, () => withExtension(`child-guard-checkin-${role}`, ["context_compact"], async ({ harness, ctx }) => {
		const command = harness.commands.get("checkin");
		assert.ok(command, "expected /checkin registration");
		await command.handler("", ctx);
		await harness.dispatch("agent_settled", {}, ctx);
		assert.equal(harness.userMessages.length, 1, "the check-in is delivered once");
		return String(harness.userMessages[0]);
	}));
}

test("the check-in prompt offers context_compact in a root session", async () => {
	assert.match(await checkinPrompt("root"), /Continue or compact.*context_compact/isu);
});

test("the check-in prompt in a Fabric child does not offer compaction", async () => {
	const prompt = await checkinPrompt("child");
	assert.doesNotMatch(prompt, /context_compact|context_compact|compact from this request/u);
	assert.match(prompt, /Compaction is not available in this session/u);
});

async function contextAwarenessGuidance(role: "root" | "child"): Promise<string> {
	return asSession(role, () => withExtension(`child-guard-guidance-${role}`, ["context_compact", "context_recall"], async ({ harness, ctx }) => {
		const event = { type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} };
		const result = await harness.dispatch("before_agent_start", event, ctx) as { systemPrompt?: string } | undefined;
		const section = result?.systemPrompt?.match(/<context-awareness>[\s\S]*?<\/context-awareness>/u)?.[0];
		assert.ok(section, "expected the context-awareness section");
		return section;
	}));
}

test("per-turn guidance tells a root session to call context_compact", async () => {
	assert.match(await contextAwarenessGuidance("root"), /call context_compact/u);
});

test("per-turn guidance in a Fabric child does not name a compaction tool", async () => {
	assert.doesNotMatch(await contextAwarenessGuidance("child"), /context_compact|context_compact/u);
});
