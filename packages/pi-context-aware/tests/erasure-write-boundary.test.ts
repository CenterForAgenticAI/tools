import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { guardErasureWrites } from "../src/erasure/write-boundary.js";

// SDK API/dispatch is the outgoing boundary; the sink stands for host persistence.
function boundary() {
	let refused = false;
	const writes: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	let execute: ((...args: unknown[]) => unknown) | undefined;
	const manager = { appendCustomEntry: () => writes.push("naming"), getSessionId: () => "gone" };
	const ctx = { sessionManager: manager, compact: () => writes.push("compact") } as unknown as ExtensionContext;
	const host = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, command),
		registerTool: (tool: { execute: (...args: unknown[]) => unknown }) => { execute = tool.execute; },
		appendEntry: () => writes.push("entry"), setSessionName: () => writes.push("name"),
		sendMessage: () => writes.push("custom"), sendUserMessage: () => writes.push("user"),
	} as unknown as ExtensionAPI;
	const pi = guardErasureWrites(host, () => refused);
	return { pi, ctx, writes, handlers, commands, execute: () => execute!("call", {}, undefined, undefined, ctx), refuse: () => { refused = true; } };
}

test("opening protection precedes every startup writer once and permits a later safe session", async () => {
	let refused = false;
	let openings = 0;
	let writes = 0;
	const handlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
	const host = { on: (_name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.push(handler) } as unknown as ExtensionAPI;
	const pi = guardErasureWrites(host, () => refused, async (ctx) => { openings++; refused = ctx.sessionManager.getSessionId() === "gone"; });
	for (let i = 0; i < 2; i++) pi.on("session_start", () => { writes++; });
	const event = {};
	const ctx = { sessionManager: { getSessionId: () => "gone" } } as unknown as ExtensionContext;
	for (const handler of handlers) await handler(event, ctx);
	assert.equal(openings, 1); assert.equal(writes, 0);
	const safe = { sessionManager: { getSessionId: () => "safe" } } as unknown as ExtensionContext;
	const switched = {};
	for (const handler of handlers) await handler(switched, safe);
	assert.equal(openings, 2); assert.equal(writes, 2);
});

test("refused commands cannot dispatch before input (including focus and tasks)", async () => {
	const b = boundary();
	for (const name of ["focus", "tasks"]) b.pi.registerCommand(name, { description: name, handler: async () => { b.writes.push(name); } });
	await b.commands.get("focus")!.handler("edit", b.ctx);
	assert.deepEqual(b.writes, ["focus"]);
	b.writes.length = 0; b.refuse();
	for (const name of ["focus", "tasks"]) await b.commands.get(name)!.handler("add", b.ctx);
	assert.deepEqual(b.writes, []);
});

test("refused tool executions cannot write session_tasks or focus even when invoked directly", async () => {
	const b = boundary();
	b.pi.registerTool({ name: "session_tasks", execute: async () => { b.writes.push("tasks"); return { content: [], details: undefined }; } } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
	await b.execute(); assert.deepEqual(b.writes, ["tasks"]);
	b.writes.length = 0; b.refuse();
	await assert.rejects(async () => b.execute(), /refused/u);
	assert.deepEqual(b.writes, []);
});

test("refused outbound persistence blocks entries, naming, nudges and custom/user continuations", () => {
	const b = boundary(); b.pi.appendEntry("focus", {}); assert.deepEqual(b.writes, ["entry"]);
	b.writes.length = 0; b.refuse();
	b.pi.appendEntry("session_tasks", {}); b.pi.setSessionName("Private name");
	b.pi.sendMessage({ customType: "nudge", content: "private", display: false }, { triggerTurn: true });
	b.pi.sendUserMessage("continue");
	assert.deepEqual(b.writes, []);
});

test("refused lifecycle callbacks cannot persist naming or fold boundary drafts", async () => {
	const b = boundary();
	b.pi.on("turn_end", (_event, ctx) => {
		b.writes.push("filesystem");
		(ctx.sessionManager as unknown as { appendCustomEntry: () => void }).appendCustomEntry();
		return { entries: [{ type: "custom", customType: "fold", data: "private" }] };
	});
	const first = await b.handlers.get("turn_end")!({}, b.ctx);
	assert.ok(first); assert.deepEqual(b.writes, ["filesystem", "naming"]);
	b.writes.length = 0; b.refuse();
	assert.equal(await b.handlers.get("turn_end")!({}, b.ctx), undefined);
	assert.deepEqual(b.writes, []);
});

test("captured context cannot launch compaction after refusal", async () => {
	const b = boundary();
	let captured: ExtensionContext | undefined;
	b.pi.on("agent_end", (_event, ctx) => { captured = ctx; });
	await b.handlers.get("agent_end")!({}, b.ctx);
	assert.ok(captured); captured.compact(); assert.deepEqual(b.writes, ["compact"]);
	b.writes.length = 0; b.refuse(); captured.compact();
	assert.deepEqual(b.writes, []);
});

test("refused real fold engine cannot return queued persistence drafts at either boundary", async () => {
	for (const event of ["turn_end", "agent_before_settle"]) {
		let refused = false;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const host = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), getAllTools: () => [] } as unknown as ExtensionAPI;
		const pi = guardErasureWrites(host, () => refused);
		const engine = registerFoldEngine(pi, { config: { compress: { minCompressRange: 0, minSummaryLength: 10, maxSummaryLength: 20_000 }, preserveRecentMessages: 2, preserveRecentTokens: 0 } });
		const manager = SessionManager.inMemory();
		for (const word of ["alpha", "beta", "recent"]) {
			manager.appendMessage({ role: "user", content: word, timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage(`${word} answered`));
		}
		// Fold settings resolve from the project directory; an empty one gives the shipped defaults.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-boundary-"));
		const ctx = { sessionManager: manager, cwd } as unknown as ExtensionContext;
		let plan: ReturnType<typeof engine.request> | undefined;
		pi.on("agent_start", (_event, guarded) => { plan = engine.request(guarded, { startRef: "m00001", endRef: "m00004", summary: "Settled alpha and beta in the opening." }); });
		await handlers.get("agent_start")!({}, ctx);
		assert.ok(plan?.ok); assert.equal(plan.queued, true);
		// An ordinary boundary is a positive control for actual, valid fold drafts. The default
		// policy keeps the opening user message, so m00002 carries the summary, m00003 and m00004
		// are hidden, and one metadata entry records the fold.
		const positive = await handlers.get(event)!({ entries: [] }, ctx) as { entries: unknown[] };
		assert.equal(positive.entries.length, 4);
		await handlers.get("agent_start")!({}, ctx);
		refused = true;
		assert.equal(await handlers.get(event)!({ entries: [] }, ctx), undefined);
		assert.equal(manager.getEntries().some((entry) => entry.type === "context_edit"), false);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("refusal during an awaited boundary discards drafts and captured naming writes", async () => {
	const b = boundary();
	b.pi.on("turn_end", async (_event, ctx) => {
		await Promise.resolve(); b.refuse();
		(ctx.sessionManager as unknown as { appendCustomEntry: () => void }).appendCustomEntry();
		return { entries: [{ type: "custom", customType: "fold", data: "private" }], continue: true };
	});
	assert.equal(await b.handlers.get("turn_end")!({}, b.ctx), undefined);
	assert.deepEqual(b.writes, []);
});
