import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { piPromptHandler } from "./pi-prompt-render.js";

// A minimal Pi stand-in for the session_focus and session_tasks tools and the
// before_agent_start handler. Entries are the session's branch, so a second
// fixture built over the same entries is a restart that replays them.

type EventHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

interface ToolRecord {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ToolResult>;
}

/** A Pi event bus stand-in; the default ignores every event, as Pi does with no listener. */
export interface FixtureEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface FocusFixtureOptions {
	readonly events?: FixtureEventBus;
	/** What pi.getSessionName returns. */
	readonly sessionName?: string;
}

export interface SentMessage {
	readonly message: { customType?: string; content?: unknown; display?: boolean; details?: unknown };
	readonly options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

export interface FocusFixture {
	readonly entries: unknown[];
	/** Every pi.sendMessage call, in order. */
	readonly sent: SentMessage[];
	readonly ctx: ExtensionContext;
	readonly notifications: string[];
	/** Run the tool through its argument hook, as Pi does before execution. */
	call(tool: "session_focus" | "session_tasks", params: Record<string, unknown>): Promise<ToolResult>;
	/** Run the tool without its argument hook, as a caller that skipped it would. */
	callUnprepared(tool: "session_focus" | "session_tasks", params: Record<string, unknown>): Promise<ToolResult>;
	command(name: string, args: string): Promise<void>;
	/** The hidden per-turn message content the next provider request carries. */
	turnMessage(): Promise<string>;
	/** The next provider request: hidden per-turn message and system prompt. */
	turn(): Promise<{ message: string; systemPrompt: string }>;
	/** Run the session_shutdown handlers. */
	shutdown(): Promise<void>;
	/** Navigate with /tree: make `branch` the session's entries, then run the session_tree handlers. */
	navigate(branch: readonly unknown[]): Promise<void>;
	cleanup(): void;
}

let counter = 0;

export async function focusFixture(entries: unknown[] = [], options: FocusFixtureOptions = {}): Promise<FocusFixture> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-aware-focus-"));
	const agentDir = path.join(home, "agent");
	const sessionDir = path.join(home, "session");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(sessionDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const events = new Map<string, EventHandler[]>();
	const tools = new Map<string, ToolRecord>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sent: SentMessage[] = [];
	const api = {
		events: options.events ?? { emit() {}, on() { return () => {}; } },
		getSessionName() { return options.sessionName; },
		registerFlag() {},
		getFlag() { return undefined; },
		on(name: string, handler: EventHandler) {
			events.set(name, [...(events.get(name) ?? []), name === "before_agent_start" ? piPromptHandler(handler) : handler]);
		},
		registerTool(tool: ToolRecord) { tools.set(tool.name, tool); },
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, definition); },
		sendMessage(message: SentMessage["message"], sendOptions?: SentMessage["options"]) { sent.push({ message, options: sendOptions }); },
		sendUserMessage() {},
		getActiveTools() { return ["read", "session_tasks", "session_focus"]; },
		getAllTools() { return [...tools.values()].map((tool) => ({ name: tool.name, description: "test tool", parameters: {} })); },
		setActiveTools() {},
		appendEntry(customType: string, data: unknown) {
			counter += 1;
			entries.push({ type: "custom", id: `entry-${counter}`, parentId: null, timestamp: new Date().toISOString(), customType, data });
		},
	} as unknown as ExtensionAPI;

	const extension = await import("../src/index.js");
	extension.default(api);
	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens: 1_000 }),
		ui: {
			setStatus() {},
			setWidget() {},
			notify(message: string) { notifications.push(message); },
			getToolsExpanded: () => false,
		},
		sessionManager: {
			getLeafId: () => "leaf",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionDir: () => sessionDir,
			getSessionFile: () => path.join(sessionDir, "session.jsonl"),
			getSessionId: () => "focus-session",
		},
	} as unknown as ExtensionContext;
	await events.get("session_start")?.[0]?.({}, ctx);

	async function turn(): Promise<{ message: string; systemPrompt: string }> {
		const handler = events.get("before_agent_start")?.[0];
		assert.ok(handler, "expected a before_agent_start handler");
		const result = await handler({ prompt: "continue", systemPrompt: "base prompt" }, ctx) as { message?: { content?: string }; systemPrompt: string };
		return { message: result.message?.content ?? "", systemPrompt: result.systemPrompt };
	}

	return {
		entries,
		sent,
		ctx,
		notifications,
		async call(name, params) {
			const tool = tools.get(name);
			assert.ok(tool, `expected ${name} to be registered`);
			const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
			return tool.execute(`${name}-call`, prepared, new AbortController().signal, undefined, ctx);
		},
		async callUnprepared(name, params) {
			const tool = tools.get(name);
			assert.ok(tool, `expected ${name} to be registered`);
			return tool.execute(`${name}-call`, params, new AbortController().signal, undefined, ctx);
		},
		async command(name, args) {
			const command = commands.get(name);
			assert.ok(command, `expected /${name} to be registered`);
			await command.handler(args, ctx);
		},
		turn,
		async shutdown() {
			for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
		},
		async navigate(branch) {
			entries.splice(0, entries.length, ...branch);
			for (const handler of events.get("session_tree") ?? []) await handler({}, ctx);
		},
		async turnMessage() {
			return (await turn()).message;
		},
		cleanup() {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

