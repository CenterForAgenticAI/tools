import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";
import { piPromptHandler } from "./pi-prompt-render.js";
import {
	classifyRestartNotice,
	formatRestartNotice,
	resolveRestartNotice,
	type RestartNoticeEntry,
} from "../src/session/restart-notice.js";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

const OFF_CONTEXT_AWARENESS = `<context-awareness>
Use context_recall early when the user refers to earlier/recent/prior sessions, compacted-away context, a Prior transcript path, being away/coming back, where work was left off, or asks you to recover previous work.
</context-awareness>`;

function contextAwarenessSection(systemPrompt: string | undefined): string | undefined {
	return systemPrompt?.match(/<context-awareness>[\s\S]*?<\/context-awareness>/u)?.[0];
}


function entry(minutesAgo: number): RestartNoticeEntry {
	return { timestamp: new Date(NOW - minutesAgo * 60_000).toISOString() };
}

test("startup with existing entries reports a cold restart at the threshold", () => {
	const pending = classifyRestartNotice("startup", [entry(1)]);
	assert.deepEqual(pending, { kind: "restart", lastEntryTimestampMs: NOW - 60_000 });
	const notice = resolveRestartNotice(pending, NOW, 60_000);
	assert.ok(notice);

	assert.deepEqual(notice, { kind: "restart", awayMs: 60_000 });
	assert.match(formatRestartNotice(notice), /pi process was restarted/);
	assert.match(formatRestartNotice(notice), /Re-check volatile state/);
	assert.match(formatRestartNotice(notice), /^\[context-aware extension, not user input\] /u, "the notice labels itself as extension-written");
	assert.equal(formatRestartNotice(notice).split("\n").length, 1, "one line");
});

test("startup without entries is treated as a fresh session", () => {
	assert.equal(classifyRestartNotice("startup", []), undefined);
});

test("reload, new, and fork never produce a notice", () => {
	for (const reason of ["reload", "new", "fork"] as const) {
		assert.equal(classifyRestartNotice(reason, [entry(10)]), undefined, reason);
	}
});

test("resume reports an in-process session switch", () => {
	const notice = resolveRestartNotice(classifyRestartNotice("resume", [entry(10)]), NOW, 60_000);
	assert.ok(notice);

	assert.equal(notice.kind, "resume");
	assert.equal(notice.awayMs, 10 * 60_000);
	assert.match(formatRestartNotice(notice), /switched in-process/);
	assert.doesNotMatch(formatRestartNotice(notice), /pi process was restarted/);
});

test("gaps below the configured threshold stay quiet", () => {
	const pending = classifyRestartNotice("startup", [entry(0.999)]);
	assert.ok(pending);
	assert.equal(resolveRestartNotice(pending, NOW, 60_000), undefined);
});

test("formatting describes long gaps without reading a clock", () => {
	const notice = resolveRestartNotice(classifyRestartNotice("startup", [entry(125)]), NOW, 60_000);
	assert.ok(notice);
	assert.match(formatRestartNotice(notice), /2 hours 5 minutes/);
});

test("resolution rejects invalid clocks, thresholds, and negative gaps", () => {
	const pending = classifyRestartNotice("startup", [entry(1)]);
	assert.ok(pending);
	assert.equal(resolveRestartNotice(pending, Number.NaN), undefined);
	assert.equal(resolveRestartNotice(pending, NOW - 60_001, 0), undefined);
	assert.equal(resolveRestartNotice(pending, NOW, Number.NaN), undefined);
	assert.equal(classifyRestartNotice("startup", [{ timestamp: "invalid" }]), undefined);
});

test("formats day and singular duration bands", () => {
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 25 * 60 * 60_000 }),
		/approximately 1 day 1 hour away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 24 * 60 * 60_000 }),
		/approximately 1 day away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 2 * 60 * 60_000 }),
		/approximately 2 hours away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 60 * 60_000 }),
		/approximately 1 hour away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 61 * 60_000 }),
		/approximately 1 hour 1 minute away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 2 * 86400_000 + 2 * 60 * 60_000 }),
		/approximately 2 days 2 hours away/,
	);
	assert.match(
		formatRestartNotice({ kind: "restart", awayMs: 3 * 86400_000 }),
		/approximately 3 days away/,
	);
});

interface Harness {
	handlers: Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>>;
	api: ExtensionAPI;
}

function createHarness(activeTools: readonly string[] = []): Harness {
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>>();
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
	const api = {
		events: bus,
		on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>) {
			if (name === "session_start") {
				const previous = handlers.get(name);
				handlers.set(name, async (event, ctx) => { await previous?.(event, ctx); return handler(event, ctx); });
			}
			if (name === "before_agent_start") handlers.set(name, piPromptHandler(handler));
		},
		registerFlag() {},
		getFlag() { return undefined; },
		registerCommand() {},
		registerTool() {},
		getActiveTools() { return [...activeTools]; },
		setActiveTools() {},
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { handlers, api };
}

/**
 * Register per-turn text the way pi-workstream supplies its task list: as a
 * contributor on the context-aware service, discovered after session_start.
 */
function contribute(harness: Harness, text: string): void {
	const service = discoverContextAwareServiceV1(harness.api.events, "restart-notice-test");
	const contributors = (service as { contributors?: { register(registration: unknown): unknown } } | undefined)?.contributors;
	assert.ok(contributors, "the service offers contributors");
	assert.deepEqual(contributors.register({ ownerKey: "tasks-stand-in", render: () => [{ id: "tasks", text }] }), { ok: true });
}

function createContext(root: string, entries: RestartNoticeEntry[], usageTelemetry = true, sessionId = "restart-notice-test"): ExtensionContext {
	return {
		hasUI: false,
		mode: "print",
		cwd: root,
		model: usageTelemetry ? { contextWindow: 100_000 } : undefined,
		getContextUsage: usageTelemetry ? () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }) : () => undefined,
		isIdle: () => true,
		abort: () => {},
		ui: {
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionDir: () => root,
			getSessionFile: () => path.join(root, "session.jsonl"),
			getSessionId: () => sessionId,
			getHeader: () => ({}),
			getLeafId: () => null,
		},
	} as unknown as ExtensionContext;
}

async function loadExtension(config: Record<string, unknown>, entryMinutesAgo = 2, usageTelemetry = true, activeTools: readonly string[] = []): Promise<{ harness: Harness; ctx: ExtensionContext; root: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-restart-notice-"));
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
		...config,
	})}\n`);

	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const extension = await import(`../src/index.js?restart-notice=${config.restartNotice && JSON.stringify(config.restartNotice)}`);
		const harness = createHarness(activeTools);
		extension.default(harness.api);
		return { harness, ctx: createContext(root, [entry(entryMinutesAgo)], usageTelemetry), root };
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

async function runWiringCase(config: Record<string, unknown>, entryMinutesAgo = 2, injectionNow = NOW, usageTelemetry = true, activeTools: readonly string[] = []): Promise<{ first: Record<string, unknown> | undefined; second: Record<string, unknown> | undefined; firstSystemPrompt: string | undefined; root: string }> {
	const originalNow = Date.now;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	Date.now = () => NOW;
	try {
		const { harness, ctx, root } = await loadExtension(config, entryMinutesAgo, usageTelemetry, activeTools);
		// Runtime handlers resolve config too; retain this fixture's directory
		// through injection rather than falling back to the worker's profile.
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		Date.now = () => injectionNow;
		const event = { type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} };
		const first = await harness.handlers.get("before_agent_start")?.(event, ctx) as { systemPrompt?: string; message?: Record<string, unknown> } | undefined;
		const second = await harness.handlers.get("before_agent_start")?.(event, ctx) as { message?: Record<string, unknown> } | undefined;
		return { first: first?.message, second: second?.message, firstSystemPrompt: first?.systemPrompt, root };
	} finally {
		Date.now = originalNow;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

test("every pressure telemetry mode installs the same context-awareness section, with no envelope rule (pi-context-aware#461)", async () => {
	for (const mode of ["full", "band", "off"] as const) {
		const result = await runWiringCase({ pressureTelemetry: { mode } }, 2, NOW, true, ["context_compact", "context_recall"]);
		try {
			assert.equal(contextAwarenessSection(result.firstSystemPrompt), OFF_CONTEXT_AWARENESS, mode);
			assert.equal(result.second, undefined, `${mode}: no usage marker after the restart notice`);
		} finally {
			await removeFixtureDir(result.root);
		}
	}
});

test("off mode omits pressure telemetry while preserving contributed and restart text", async () => {
	const originalNow = Date.now;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	Date.now = () => NOW;
	const { harness, ctx, root } = await loadExtension({ pressureTelemetry: { mode: "off" }, workstream: { enabled: true } });
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	try {
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		contribute(harness, "keep the task text");
		const event = { type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} };
		const first = await harness.handlers.get("before_agent_start")?.(event, ctx) as { message?: Record<string, unknown> } | undefined;
		const second = await harness.handlers.get("before_agent_start")?.(event, ctx) as { message?: Record<string, unknown> } | undefined;
		const content = String(first?.message?.content);
		assert.equal(first?.message?.customType, "context-aware-restart-notice");
		assert.match(content, /keep the task text/u);
		assert.match(content, /pi process was restarted/u);
		assert.doesNotMatch(content, /<pressure\b/u);
		assert.equal(second?.message?.customType, "context-aware-task-state");
		assert.match(String(second?.message?.content), /keep the task text/u);
		assert.doesNotMatch(String(second?.message?.content), /<pressure\b/u);
	} finally {
		Date.now = originalNow;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
});

test("REQ-ENV-003: one hidden restart notice reaches the first agent start in its own message, and is not repeated", async () => {
	const result = await runWiringCase({});
	try {
		assert.equal(result.first?.customType, "context-aware-restart-notice");
		assert.equal(result.first?.display, false);
		const content = String(result.first?.content);
		assert.match(content, /^\[context-aware extension, not user input\] The pi process was restarted/u, "a labelled line, not an envelope the system prompt no longer explains");
		assert.match(content, /pi process was restarted/);
		assert.doesNotMatch(content, /<pressure\b/u, "no usage envelope rides with it");
		assert.equal(result.second, undefined, "the notice is sent once, and nothing else is sent while nothing changed");
	} finally {
		await removeFixtureDir(result.root);
	}
});

test("restart notice and contributed text share one late message, with no usage telemetry", async () => {
	const originalNow = Date.now;
	Date.now = () => NOW;
	const { harness, ctx, root } = await loadExtension({ workstream: { enabled: true } });
	try {
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		contribute(harness, "resume the cached-prefix fix");
		const result = await harness.handlers.get("before_agent_start")?.({
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "base",
			systemPromptOptions: {},
		}, ctx) as { systemPrompt?: string; message?: Record<string, unknown> } | undefined;
		assert.doesNotMatch(result?.systemPrompt ?? "", /resume the cached-prefix fix/, "contributed text stays out of the system prompt");
		assert.equal(result?.message?.customType, "context-aware-restart-notice");
		const content = String(result?.message?.content);
		assert.match(content, /resume the cached-prefix fix/);
		assert.match(content, /pi process was restarted/);
		assert.doesNotMatch(content, /<pressure\b/u);
		const notice = content.indexOf("[context-aware extension, not user input] The pi process was restarted");
		assert.ok(notice > 0 && content.indexOf("resume the cached-prefix fix") < notice, "contributed text comes before the notice");
	} finally {
		Date.now = originalNow;
		await removeFixtureDir(root);
	}
});

test("keeps interleaved restart notices isolated by session", async () => {
	const originalNow = Date.now;
	Date.now = () => NOW;
	const { harness, ctx: firstCtx, root } = await loadExtension({});
	const secondCtx = createContext(root, [entry(5)], true, "restart-notice-test-second");
	const event = { type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} };
	try {
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, firstCtx);
		await harness.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, secondCtx);

		const first = await harness.handlers.get("before_agent_start")?.(event, firstCtx) as { message?: Record<string, unknown> } | undefined;
		const second = await harness.handlers.get("before_agent_start")?.(event, secondCtx) as { message?: Record<string, unknown> } | undefined;

		assert.match(String(first?.message?.content), /approximately 2 minutes away/);
		assert.match(String(second?.message?.content), /approximately 5 minutes away/);
	} finally {
		Date.now = originalNow;
		await removeFixtureDir(root);
	}
});

test("restartNotice.enabled false suppresses wiring completely", async () => {
	const result = await runWiringCase({ restartNotice: { enabled: false } });
	try {
		assert.doesNotMatch(String(result.first?.content), /pi process was restarted|switched in-process/);
		assert.doesNotMatch(String(result.second?.content), /pi process was restarted|switched in-process/);
	} finally {
		await removeFixtureDir(result.root);
	}
});

test("falls back to a standalone notice without usage telemetry", async () => {
	const result = await runWiringCase({}, 2, NOW, false);
	try {
		assert.equal(result.first?.customType, "context-aware-restart-notice");
		assert.equal(result.first?.display, false);
		assert.match(String(result.first?.content), /pi process was restarted/);
		assert.equal(result.second, undefined);
	} finally {
		await removeFixtureDir(result.root);
	}
});

test("resolves the away gap at injection time rather than session start", async () => {
	const result = await runWiringCase({}, 0.5, NOW + 60_000);
	try {
		assert.match(String(result.first?.content), /approximately 2 minutes away/);
		assert.doesNotMatch(String(result.second?.content), /pi process was restarted|switched in-process/);
	} finally {
		await removeFixtureDir(result.root);
	}
});
