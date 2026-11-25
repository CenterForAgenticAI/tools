import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createContextRecallSurface, type ContextRecallHost, type TranscriptSession } from "../src/context-tools/context-recall.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { askPiMemory, PI_MEMORY_SEARCH_EVENT, type PiMemoryEventBus } from "../src/context-tools/pi-memory-search.js";
import { askPiMemoryRead, READ_EVENT } from "../src/context-tools/pi-memory-read.js";
import {
	RECALL_LOG_EVENT,
	RECALL_LOG_MAX_CWD_CHARS,
	RECALL_LOG_MAX_QUERY_CHARS,
	RECALL_LOG_MAX_REF_CHARS,
	isTraceId,
	newTraceId,
	recallLogEvent,
} from "../src/context-tools/pi-memory-recall-log.js";
import { createHostPi } from "./compaction-owner-harness.js";

// Seam: the registered context_recall tool on Pi's real event bus (createHostPi). Listeners
// play pi-memory: the search and read responders, and the recall-log listener that
// pi-memory appends a `recall` line from (caair/pi/pi-memory#25, spec section 1).

interface Seen {
	traceId?: unknown;
	ack(): void;
	reply(result: unknown): void;
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

type LogEvent = Record<string, unknown> & { args: Record<string, unknown> };

const CURRENT_ID = "current-session";
const storeSession = { sessionId: "store-1", host: "studio", repo: "proj", title: "Deploy work", startedAt: "2026-01-01T10:00:00.000Z", entries: 42 };
const storeItem = (entryId: string) => ({ entryId, ts: "2026-01-01T10:00:01.000Z", seq: 1, kind: "user", text: `text of ${entryId}`, fullChars: 10 + entryId.length, cut: false });

function card(sessionId = "store-1") {
	return { sessionId, repo: "proj", startedAt: "2026-01-01T00:00:00.000Z", score: 1, entryId: "e-1", snippet: "MARKER found by the store" };
}

function fixture(options: {
	search?: (request: Seen) => void;
	read?: (request: Seen) => void;
	log?: (event: LogEvent) => void;
	noLogListener?: boolean;
	cwd?: string;
	sessionId?: string;
	timeoutMs?: number;
	cachePools?: ContextRecallHost["cachePools"];
} = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-trace-")));
	const projectDir = options.cwd ?? path.join(root, "work", "proj");
	fs.mkdirSync(projectDir, { recursive: true });
	const hostPi = createHostPi();
	const searches: Seen[] = [];
	const reads: Seen[] = [];
	const logs: LogEvent[] = [];
	hostPi.bus.on(PI_MEMORY_SEARCH_EVENT, (data) => { searches.push(data as Seen); options.search?.(data as Seen); });
	hostPi.bus.on(READ_EVENT, (data) => { reads.push(data as Seen); options.read?.(data as Seen); });
	if (!options.noLogListener) hostPi.bus.on(RECALL_LOG_EVENT, (data) => { logs.push(data as LogEvent); options.log?.(data as LogEvent); });
	const listed: TranscriptSession[] = [];
	const host: ContextRecallHost = {
		listSessions: async () => ({ sessions: listed, scannedCwds: [projectDir], scopeLabel: "project" }),
		erasedSessionIds: () => new Set(),
		cachePools: options.cachePools ?? (() => []),
		home: () => root,
		...(options.timeoutMs !== undefined ? { piMemoryTimeoutMs: options.timeoutMs } : {}),
	};
	const surface = createContextRecallSurface(hostPi.api, host);
	surface.apply(decideContextToolSurface([...hostPi.tools.values()] as Array<{ name: string }>, undefined), false);
	const ctx = {
		cwd: projectDir,
		sessionManager: {
			getSessionFile: () => path.join(root, "current.jsonl"),
			getSessionId: () => options.sessionId ?? CURRENT_ID,
			getEntries: () => [],
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	const tool = hostPi.tools.get("context_recall") as { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ToolResult> };
	return {
		root, projectDir, searches, reads, logs,
		call: (params: Record<string, unknown>) => tool.execute("call", params, new AbortController().signal, undefined, ctx),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

/** Let a log emitted after the result (setImmediate) arrive. */
const drained = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

const answerSearch = (cards: unknown[]) => (request: Seen) => { request.ack(); request.reply({ ok: true, cards, tookMs: 4 }); };
const failSearch = (error: string) => (request: Seen) => { request.ack(); request.reply({ ok: false, error, message: "no", tookMs: 1 }); };

test("pi-memory#25 trace: a query call sends one hex trace id on its search and logs one store event with it", async () => {
	const f = fixture({ search: answerSearch([card(), card("store-2")]) });
	try {
		const result = await f.call({ query: "MARKER", scope: "all-projects", max_sessions: 4 });
		assert.match(result.content[0]!.text, /From the pi-memory session store: 2 sessions/u);
		assert.equal(f.searches.length, 1);
		const traceId = f.searches[0]!.traceId;
		assert.equal(typeof traceId, "string");
		assert.match(traceId as string, /^[0-9a-f]{32}$/u);
		await drained();
		assert.equal(f.logs.length, 1);
		const event = f.logs[0]!;
		assert.equal(event.v, 1);
		assert.equal(event.traceId, traceId);
		assert.equal(event.tool, "context_recall");
		assert.equal(event.askingSessionId, CURRENT_ID);
		assert.equal(event.cwd, f.projectDir);
		assert.deepEqual(event.args, { query: "MARKER", scope: "all-projects", limit: 4 });
		assert.equal(event.outcome, "store");
		assert.equal(event.fallbackReason, undefined);
		assert.equal(event.resultCount, 2);
		assert.equal(typeof event.tookMs, "number");
		assert.ok(Number.isInteger(event.tookMs) && (event.tookMs as number) >= 0);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: each tool call gets its own trace id", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		await f.call({ query: "MARKER", scope: "all-projects" });
		await f.call({ query: "MARKER", scope: "all-projects" });
		await drained();
		assert.equal(f.searches.length, 2);
		assert.notEqual(f.searches[0]!.traceId, f.searches[1]!.traceId);
		assert.deepEqual(f.logs.map((event) => event.traceId), f.searches.map((request) => request.traceId));
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a search fallback logs its reason", async () => {
	const cases: Array<[string, Parameters<typeof fixture>[0], string]> = [
		["absent", {}, "absent"],
		["timeout", { search: (request) => request.ack(), timeoutMs: 20 }, "timeout"],
		["unavailable", { search: failSearch("unavailable") }, "unavailable"],
		["internal", { search: failSearch("internal") }, "internal"],
		["bad_request", { search: failSearch("bad_request") }, "bad_request"],
		["store timeout error", { search: failSearch("timeout") }, "timeout"],
		["invalid reply", { search: (request) => { request.ack(); request.reply({ ok: "maybe" }); } }, "other"],
	];
	for (const [name, options, reason] of cases) {
		const f = fixture(options);
		try {
			await f.call({ query: "MARKER", scope: "all-projects" });
			await drained();
			assert.equal(f.logs.length, 1, name);
			assert.equal(f.logs[0]!.outcome, "fallback", name);
			assert.equal(f.logs[0]!.fallbackReason, reason, name);
			assert.equal(f.logs[0]!.traceId, f.searches[0]!.traceId, name);
			assert.equal(f.logs[0]!.resultCount, 0, `${name}: the file search found no session`);
		} finally { f.cleanup(); }
	}
});

test("pi-memory#25 trace: a query the store is not asked (regex) logs a fallback with no reason", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		await f.call({ query: "MARK.R", regex: true });
		await drained();
		assert.equal(f.searches.length, 0);
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "fallback");
		assert.equal("fallbackReason" in f.logs[0]!, false);
		assert.match(f.logs[0]!.traceId as string, /^[0-9a-f]{32}$/u);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a refused query logs an error and asks nothing", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		const result = await f.call({ query: "   " });
		assert.equal(result.isError, true);
		await drained();
		assert.equal(f.searches.length, 0);
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "error");
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a call that throws logs an error and still throws", async () => {
	const f = fixture({ cachePools: () => { throw new Error("cache broke"); } });
	try {
		await assert.rejects(f.call({ query: "MARKER", scope: "all-projects" }), /cache broke/u);
		await drained();
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "error");
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a session read sends the trace id and logs store with the item count", async () => {
	const f = fixture({
		read: (request) => { request.ack(); request.reply({ ok: true, session: storeSession, items: [storeItem("e1"), storeItem("e2"), storeItem("e3")], truncated: false, tookMs: 3 }); },
	});
	try {
		const result = await f.call({ ref: "session:store-1#e2", mode: "turns" });
		assert.notEqual(result.isError, true);
		assert.equal(f.reads.length, 1);
		assert.match(f.reads[0]!.traceId as string, /^[0-9a-f]{32}$/u);
		await drained();
		assert.equal(f.logs.length, 1);
		const event = f.logs[0]!;
		assert.equal(event.traceId, f.reads[0]!.traceId);
		assert.deepEqual(event.args, { sessionRef: "session:store-1#e2", mode: "turns" });
		assert.equal(event.outcome, "store");
		assert.equal(event.resultCount, 3);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a session read the store does not find logs fallback not_found", async () => {
	const f = fixture({ read: (request) => { request.ack(); request.reply({ ok: false, error: "not_found", message: "gone", tookMs: 1 }); } });
	try {
		await f.call({ ref: "session:store-1" });
		await drained();
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "fallback");
		assert.equal(f.logs[0]!.fallbackReason, "not_found");
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a fold ref is not logged and asks nothing", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		await f.call({ ref: "b1" });
		await drained();
		assert.equal(f.logs.length, 0);
		assert.equal(f.searches.length + f.reads.length, 0);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a query refused because it also has a fold ref logs one error event and asks nothing", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		const result = await f.call({ query: "MARKER", ref: "b1" });
		assert.equal(result.isError, true);
		await drained();
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "error");
		assert.match(f.logs[0]!.traceId as string, /^[0-9a-f]{32}$/u);
		assert.deepEqual(f.logs[0]!.args, { query: "MARKER" });
		assert.equal(f.searches.length + f.reads.length, 0);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a query refused because it has a session-only argument logs one error event and asks nothing", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		const result = await f.call({ query: "MARKER", mode: "turns", scope: "all-projects" });
		assert.equal(result.isError, true);
		await drained();
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "error");
		assert.deepEqual(f.logs[0]!.args, { query: "MARKER", mode: "turns", scope: "all-projects" });
		assert.equal(f.searches.length + f.reads.length, 0);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a call refused for a session-only argument with neither query nor ref logs one error event", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		const result = await f.call({ cursor: "x" });
		assert.equal(result.isError, true);
		await drained();
		assert.equal(f.logs.length, 1);
		assert.equal(f.logs[0]!.outcome, "error");
		assert.deepEqual(f.logs[0]!.args, {});
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a fold ref refused for a session-only argument is a fold call and is not logged", async () => {
	const f = fixture({ search: answerSearch([card()]) });
	try {
		const result = await f.call({ ref: "b1", mode: "turns" });
		assert.equal(result.isError, true);
		await drained();
		assert.equal(f.logs.length, 0);
	} finally { f.cleanup(); }
});

test("pi-memory#25 trace: a throwing log listener changes neither the result nor its latency", async () => {
	const quiet = fixture({ search: answerSearch([card()]), noLogListener: true });
	const loud = fixture({
		search: answerSearch([card()]),
		log: () => {
			// Busy for 400 ms, then throws: neither may reach the call.
			const until = Date.now() + 400;
			while (Date.now() < until) { /* spin */ }
			throw new Error("log listener broke");
		},
	});
	try {
		const expected = await quiet.call({ query: "MARKER", scope: "all-projects" });
		const started = Date.now();
		const actual = await loud.call({ query: "MARKER", scope: "all-projects" });
		const took = Date.now() - started;
		assert.ok(took < 300, `the call waited ${took} ms for the log listener`);
		assert.equal(loud.logs.length, 0, "the log is emitted after the result, not before");
		assert.deepEqual(actual, expected);
		await drained();
		assert.equal(loud.logs.length, 1);
	} finally { quiet.cleanup(); loud.cleanup(); }
});

test("pi-memory#25 trace: a bus that rethrows a log listener's error does not reach the call", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-trace-bus-")));
	const unhandled: unknown[] = [];
	const onError = (err: unknown) => unhandled.push(err);
	process.on("uncaughtException", onError);
	try {
		const seen: string[] = [];
		const events: PiMemoryEventBus = { emit(channel) { seen.push(channel); if (channel === RECALL_LOG_EVENT) throw new Error("bus rethrew"); } };
		const hostPi = createHostPi();
		const surface = createContextRecallSurface(hostPi.api, { listSessions: async () => ({ sessions: [], scannedCwds: [], scopeLabel: "" }), erasedSessionIds: () => new Set(), cachePools: () => [], home: () => root, searchEvents: events });
		surface.apply(decideContextToolSurface([...hostPi.tools.values()] as Array<{ name: string }>, undefined), false);
		const tool = hostPi.tools.get("context_recall") as { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ToolResult> };
		const ctx = { cwd: root, sessionManager: { getSessionFile: () => undefined, getSessionId: () => CURRENT_ID, getEntries: () => [], getBranch: () => [] } } as unknown as ExtensionContext;
		const result = await tool.execute("call", { query: "MARKER", scope: "all-projects" }, new AbortController().signal, undefined, ctx);
		assert.match(result.content[0]!.text, /pi-memory search unavailable \(not loaded\)/u);
		await drained();
		assert.deepEqual(seen, [PI_MEMORY_SEARCH_EVENT, RECALL_LOG_EVENT]);
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("uncaughtException", onError);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("pi-memory#25 trace: every string field of the event is bounded", async () => {
	const longCwd = `/tmp/${"c".repeat(RECALL_LOG_MAX_CWD_CHARS + 100)}`;
	const f = fixture({ sessionId: "s".repeat(300) });
	try {
		await f.call({ query: `MARKER ${"q".repeat(RECALL_LOG_MAX_QUERY_CHARS + 500)}`, scope: "all-projects" });
		await f.call({ ref: `session:${"r".repeat(RECALL_LOG_MAX_REF_CHARS + 50)}` });
		await drained();
		assert.equal(f.logs.length, 2);
		const [search, read] = f.logs;
		assert.equal((search!.args.query as string).length, RECALL_LOG_MAX_QUERY_CHARS);
		assert.equal(search!.fallbackReason, "other", "a query too long for the store is a fallback");
		assert.equal("askingSessionId" in search!, false, "an over-long id is left out, never cut");
		assert.equal((read!.args.sessionRef as string).length, RECALL_LOG_MAX_REF_CHARS);
	} finally { f.cleanup(); }
	// The cwd bound, and the bound on mode, scope and limit, through the builder the tool uses.
	const event = recallLogEvent({
		traceId: newTraceId(),
		askingSessionId: "a",
		cwd: longCwd,
		args: { query: "q", mode: "m".repeat(500), scope: "s".repeat(500), limit: 1e12 },
		outcome: "store",
		resultCount: 1e9,
		tookMs: -5,
	});
	assert.equal(event.cwd!.length, RECALL_LOG_MAX_CWD_CHARS);
	assert.ok(event.args.mode!.length <= 64);
	assert.ok(event.args.scope!.length <= 64);
	assert.ok(event.args.limit! <= 1000);
	assert.ok(event.resultCount! <= 1000);
	assert.equal(event.tookMs, 0);
});

test("pi-memory#25 trace: an invalid trace id is not sent on search or read", async () => {
	const sent: Array<Record<string, unknown>> = [];
	const events: PiMemoryEventBus = { emit(_channel, data) { sent.push(data as Record<string, unknown>); } };
	for (const traceId of ["x".repeat(65), "has space", "semi;colon", ""]) {
		sent.length = 0;
		await askPiMemory(events, { query: "q", limit: 1, traceId }, 5);
		await askPiMemoryRead(events, { op: "open", sessionId: "s", traceId }, 5);
		assert.equal(sent.length, 2);
		for (const request of sent) assert.equal("traceId" in request, false, JSON.stringify(traceId));
	}
	const good = "a".repeat(64);
	sent.length = 0;
	await askPiMemory(events, { query: "q", limit: 1, traceId: good }, 5);
	await askPiMemoryRead(events, { op: "open", sessionId: "s", traceId: good }, 5);
	assert.deepEqual(sent.map((request) => request.traceId), [good, good]);
	assert.equal(isTraceId("A-b_9"), true);
	assert.equal(isTraceId("a.b"), false);
	assert.notEqual(newTraceId(), newTraceId());
});
