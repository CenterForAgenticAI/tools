import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi-context-aware#244, rows 3 and 4 of the cut-over checklist on #137: proactive compaction follows the
// pressure ladder unless a layer sets proactiveCompaction.thresholdFraction. The config here is the file
// a user edits; the trigger is the extension's real turn_end handler.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(): { api: ExtensionAPI; handlers: Map<string, Handler[]>; commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }> } {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const events = { emit() {}, on: () => () => {} };
	const api = {
		events,
		registerFlag() {},
		getFlag: () => undefined,
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool() {},
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, definition); },
		getCommands: () => [],
		sendMessage() {},
		sendUserMessage() {},
		getActiveTools: () => ["read", "bash", "edit"],
		getAllTools: () => [],
		setActiveTools() {},
		async setModel() { return true; },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, handlers, commands };
}

async function dispatch(handlers: Map<string, Handler[]>, name: string, event: unknown, ctx: ExtensionContext): Promise<void> {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

interface Session { readonly ctx: ExtensionContext; readonly aborts: () => number; readonly notes: string[]; readonly handlers: Map<string, Handler[]>; readonly commands: ReturnType<typeof fakePi>["commands"]; readonly file: string; readonly end: () => Promise<void> }

async function withAgentDir<T>(config: unknown, run: (session: Session) => Promise<T>, usageFraction = 0.5): Promise<T> {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-ladder-wiring-")));
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const file = path.join(agentDir, "context-aware.json");
	if (config !== undefined) fs.writeFileSync(file, JSON.stringify(config));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, lineage: process.env.PI_FABRIC_LINEAGE, depth: process.env.PI_FABRIC_DEPTH };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// A Fabric child refuses proactive compaction; these tests are about a foreground session.
	delete process.env.PI_FABRIC_LINEAGE;
	delete process.env.PI_FABRIC_DEPTH;
	try {
		const extension = await import("../src/index.js");
		const harness = fakePi();
		extension.default(harness.api);
		let aborts = 0;
		const notes: string[] = [];
		const ctx = {
			hasUI: true,
			cwd: home,
			model: { contextWindow: 200_000, maxTokens: 8_000 },
			getContextUsage: () => ({ tokens: Math.round(usageFraction * 200_000), contextWindow: 200_000 }),
			isProjectTrusted: () => true,
			isIdle: () => false,
			abort: () => { aborts++; },
			compact() {},
			ui: { notify: (message: string) => notes.push(message), setStatus() {}, setWidget() {} },
			sessionManager: {
				getEntries: () => [], getBranch: () => [], getSessionDir: () => home, getSessionFile: () => path.join(home, "ladder.jsonl"),
				getSessionId: () => "ladder-wiring", getHeader: () => ({}), getLeafId: () => "leaf", appendCustomEntry: () => "id",
			},
		} as unknown as ExtensionContext;
		return await run({ ctx, aborts: () => aborts, notes, handlers: harness.handlers, commands: harness.commands, file, end: () => dispatch(harness.handlers, "session_shutdown", {}, ctx) });
	} finally {
		if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (previous.lineage === undefined) delete process.env.PI_FABRIC_LINEAGE; else process.env.PI_FABRIC_LINEAGE = previous.lineage;
		if (previous.depth === undefined) delete process.env.PI_FABRIC_DEPTH; else process.env.PI_FABRIC_DEPTH = previous.depth;
		await removeFixtureDir(home);
	}
}

/** Does the extension's turn_end start proactive compaction at this share of the window? */
async function firesAt(config: unknown, fraction: number): Promise<boolean> {
	return withAgentDir(config, async (session) => {
		await dispatch(session.handlers, "session_start", {}, session.ctx);
		await dispatch(session.handlers, "turn_end", { message: { stopReason: "toolUse" } }, session.ctx);
		const fired = session.aborts() > 0;
		await session.end();
		return fired;
	}, fraction);
}

test("proactive compaction defaults to the ladder's seeded-compaction step, not the old 0.78", async () => {
	assert.equal(await firesAt(undefined, 0.85), false, "85% is under the default ladder's 90%");
	assert.equal(await firesAt(undefined, 0.91), true, "91% is over it");
});

test("moving pressureLadder.seededCompactionFraction in config moves proactive compaction with it", async () => {
	const ladder = { pressureLadder: { foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.95 } };
	assert.equal(await firesAt(ladder, 0.55), false);
	assert.equal(await firesAt(ladder, 0.65), true, "a ladder seeded at 60% compacts at 65%");
	const later = { pressureLadder: { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.93, recoverableHideFraction: 0.95 } };
	assert.equal(await firesAt(later, 0.91), false, "a ladder seeded at 93% leaves 91% alone");
	assert.equal(await firesAt(later, 0.94), true);
});

test("an explicit proactiveCompaction.thresholdFraction still beats the ladder", async () => {
	const pinned = { proactiveCompaction: { thresholdFraction: 0.7 }, pressureLadder: { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 } };
	assert.equal(await firesAt(pinned, 0.65), false);
	assert.equal(await firesAt(pinned, 0.75), true, "the pin of 70% fires at 75% although the ladder says 90%");
});

test("a ladder step outside what the threshold setting accepts is held to that range", async () => {
	const low = { pressureLadder: { foldNudgeStartFraction: 0.05, foldNudgeEndFraction: 0.1, seededCompactionFraction: 0.15, recoverableHideFraction: 0.95 } };
	assert.equal(await firesAt(low, 0.2), false, "the threshold floor is 25%");
	assert.equal(await firesAt(low, 0.3), true);
});

test("the proactive status names the ladder as the source of an unset threshold", async () => {
	await withAgentDir({ pressureLadder: { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.8, recoverableHideFraction: 0.95 } }, async (session) => {
		await session.commands.get("context-aware-proactive")!.handler("status", session.ctx);
		assert.match(session.notes.at(-1) ?? "", /on @ 80%/u);
	});
});

test("commands that rewrite the config file do not pin the derived threshold", async () => {
	await withAgentDir({ seedRewrite: true }, async (session) => {
		await session.commands.get("context-aware-seed-rewrite")!.handler("off", session.ctx);
		const written = JSON.parse(fs.readFileSync(session.file, "utf8")) as { seedRewrite?: boolean; proactiveCompaction?: { thresholdFraction?: number } };
		assert.equal(written.seedRewrite, false, "the command did its own write");
		assert.equal(written.proactiveCompaction?.thresholdFraction, undefined, "the default threshold was not written out as a pin");
	});
	await withAgentDir({ seedRewrite: true, proactiveCompaction: { thresholdFraction: 0.7 } }, async (session) => {
		await session.commands.get("context-aware-seed-rewrite")!.handler("off", session.ctx);
		const written = JSON.parse(fs.readFileSync(session.file, "utf8")) as { proactiveCompaction?: { thresholdFraction?: number } };
		assert.equal(written.proactiveCompaction?.thresholdFraction, 0.7, "a pin the user wrote stays");
	});
	await withAgentDir({}, async (session) => {
		await session.commands.get("context-aware-proactive")!.handler("85%", session.ctx);
		const written = JSON.parse(fs.readFileSync(session.file, "utf8")) as { proactiveCompaction?: { thresholdFraction?: number } };
		assert.equal(written.proactiveCompaction?.thresholdFraction, 0.85, "setting the threshold writes it");
	});
	await withAgentDir({}, async (session) => {
		await session.commands.get("context-aware-proactive")!.handler("reserve 32k", session.ctx);
		const written = JSON.parse(fs.readFileSync(session.file, "utf8")) as { proactiveCompaction?: { thresholdFraction?: number; outputReserveTokens?: number } };
		assert.equal(written.proactiveCompaction?.outputReserveTokens, 32_000, "the reserve was written");
		assert.equal(written.proactiveCompaction?.thresholdFraction, undefined, "setting the reserve does not pin the threshold");
	});
});

test("an unrelated config command writes only what the user set: no default is pinned into the file", async () => {
	await withAgentDir({ seedRewrite: true }, async (session) => {
		await session.commands.get("context-aware-seed-rewrite")!.handler("off", session.ctx);
		const written = JSON.parse(fs.readFileSync(session.file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(written, { seedRewrite: false }, "only the leaf the command changed is in the file; pressureLadder and the other defaults are not");
	});
	await withAgentDir({}, async (session) => {
		await session.commands.get("context-aware-ambiguity")!.handler("ask", session.ctx);
		assert.deepEqual(JSON.parse(fs.readFileSync(session.file, "utf8")), { ambiguityMode: "ask" });
	});
});

test("an unrelated config command keeps every value the user set, including a ladder and keys this build does not know", async () => {
	const user = {
		seedRewrite: true,
		pressureLadder: { foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.8 },
		proactiveCompaction: { enabled: false, outputReserveTokens: 32_000 },
		futureSetting: { kept: true },
	};
	await withAgentDir(user, async (session) => {
		await session.commands.get("context-aware-seed-rewrite")!.handler("off", session.ctx);
		assert.deepEqual(JSON.parse(fs.readFileSync(session.file, "utf8")), { ...user, seedRewrite: false });
	});
});
