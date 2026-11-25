import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	contextRecallRequest,
	createContextRecallSurface,
	recallQuery,
	type ContextRecallHost,
	type ContextRecallResult,
	type TranscriptSession,
} from "../src/context-tools/context-recall.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { askPiMemory, PI_MEMORY_SEARCH_EVENT, piMemoryRepoOf, type PiMemoryCard } from "../src/context-tools/pi-memory-search.js";
import { createHostPi } from "./compaction-owner-harness.js";

// Seam: recallQuery with a host whose event bus is a fake pi-memory responder,
// and whose session listing points at real session JSONL files, so a fallback is
// seen to search those files. The responder's behaviour follows pi-memory's
// `respond` in its src/search/index.ts: ack during emit, then one reply.

interface Request {
	v: unknown;
	query: unknown;
	askingSessionId?: unknown;
	cwd?: unknown;
	repo?: unknown;
	limit?: unknown;
	timeoutMs?: unknown;
	ack(): void;
	reply(result: unknown): void;
}

type Responder = (request: Request) => void;

interface Fixture {
	root: string;
	projectDir: string;
	requests: Request[];
	channels: string[];
	host: ContextRecallHost;
	ctx: ExtensionContext;
	query(params: Record<string, unknown>): Promise<ContextRecallResult>;
	cleanup(): void;
}

const CURRENT_ID = "current-session";

function makeFixture(options: {
	responder?: Responder;
	/** Replaces the fake bus: for a listener that throws through emit, or Pi's real bus. */
	events?: { emit(channel: string, data: unknown): void };
	erased?: readonly string[];
	timeoutMs?: number;
	cwd?: (root: string) => string;
	sessionId?: string;
} = {}): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-store-")));
	const projectDir = options.cwd ? options.cwd(root) : path.join(root, "work", "proj");
	fs.mkdirSync(projectDir, { recursive: true });
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir);
	const writeSession = (id: string, chat: string, modified: string): TranscriptSession => {
		const file = path.join(sessionsDir, `${id}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id, timestamp: modified, cwd: projectDir },
			{ type: "message", id: "u1", parentId: null, timestamp: modified, message: { role: "user", content: chat, timestamp: 0 } },
		];
		fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		return { id, path: file, cwd: projectDir, modified: new Date(modified), messageCount: 1, allMessagesText: chat };
	};
	const listed = [writeSession("file-prior", "MARKER-ALPHA lives in an earlier session file.", "2026-01-02T00:00:00.000Z")];
	const currentFile = path.join(sessionsDir, "current.jsonl");
	const requests: Request[] = [];
	const channels: string[] = [];
	const events = options.events ?? {
		emit(channel: string, data: unknown) {
			channels.push(channel);
			if (channel !== PI_MEMORY_SEARCH_EVENT) return;
			requests.push(data as Request);
			options.responder?.(data as Request);
		},
	};
	const host: ContextRecallHost = {
		listSessions: async () => ({ sessions: listed, scannedCwds: [projectDir], scopeLabel: "project" }),
		erasedSessionIds: () => new Set(options.erased ?? []),
		cachePools: () => [],
		home: () => root,
		searchEvents: events,
		...(options.timeoutMs !== undefined ? { piMemoryTimeoutMs: options.timeoutMs } : {}),
	};
	const entries = [{ type: "message", id: "c1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "MARKER-ALPHA is in this session too." } }];
	const ctx = {
		cwd: projectDir,
		sessionManager: {
			getSessionFile: () => currentFile,
			getSessionId: () => options.sessionId ?? CURRENT_ID,
			getEntries: () => entries,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	return {
		root,
		projectDir,
		requests,
		channels,
		host,
		ctx,
		query: (params) => recallQuery({ query: "MARKER-ALPHA", ...params }, ctx, host),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function card(overrides: Partial<PiMemoryCard> & Record<string, unknown> = {}): PiMemoryCard {
	return {
		sessionId: "store-1",
		repo: "proj",
		startedAt: "2026-01-01T10:00:00.000Z",
		score: 3.5,
		entryId: "e-17",
		snippet: "MARKER-ALPHA found by the store",
		...overrides,
	} as PiMemoryCard;
}

/** A responder that acks during emit and replies on a later turn, as pi-memory does after its query. */
const replyLater = (reply: unknown): Responder => (request) => {
	request.ack();
	setTimeout(() => request.reply(reply), 5);
};
const answer = (cards: unknown[]): Responder => replyLater({ ok: true, cards, tookMs: 12 });

const body = (result: ContextRecallResult): string => result.content.map((part) => part.text).join("\n");
const fileHits = (result: ContextRecallResult): string[] => result.details.transcripts.results.map((hit) => path.basename(hit.sessionPath, ".jsonl"));
// Pi's bus logs a listener's error as `console.error("Event handler error (<channel>):", err)`. A test that captures
// console.error also receives Node's own process warnings (the SQLite and MockTimers ExperimentalWarning), which
// arrive when the test runs alone, so count only the bus's entries.
const busErrors = (calls: readonly unknown[]): unknown[] => calls.filter((args) => Array.isArray(args) && typeof args[0] === "string" && args[0].startsWith(`Event handler error (${PI_MEMORY_SEARCH_EVENT})`));

const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout" || kind === "Immediate").length;

/** A call that must resolve; a rejection fails as an assertion. */
async function settled(call: Promise<ContextRecallResult>): Promise<ContextRecallResult> {
	let result: ContextRecallResult | undefined;
	await assert.doesNotReject(async () => { result = await call; });
	assert.ok(result);
	return result;
}

function assertFellBack(result: ContextRecallResult, notice: RegExp): void {
	assert.match(body(result), notice);
	assert.match(body(result), /searched session files instead\./u);
	assert.deepEqual(fileHits(result), ["file-prior"], body(result));
	assert.doesNotMatch(body(result), /From the pi-memory session store/u);
}

test("REQ-2/REQ-4: an answered prior query renders the store's cards and sends bounded request fields", async () => {
	const f = makeFixture({ responder: answer([card({ alsoIn: ["fork-a", "fork-b"], title: "Deploy work", host: "studio", entryTs: "2026-01-01T10:05:00.000Z" })]) });
	try {
		const result = await settled(f.query({ max_sessions: 3 }));
		assert.equal(f.requests.length, 1);
		const request = f.requests[0];
		assert.equal(request.v, 1);
		assert.equal(request.query, "MARKER-ALPHA");
		assert.equal(request.askingSessionId, CURRENT_ID);
		assert.equal(request.cwd, f.projectDir);
		assert.equal(request.limit, 3);
		assert.equal(request.timeoutMs, 2500);
		assert.equal(request.repo, undefined);

		const text = body(result);
		assert.match(text, /## Transcripts\nFrom the pi-memory session store: 1 session \(project proj, 12 ms, current session excluded\):/u);
		assert.match(text, /### Session store-1: Deploy work\n- repo: proj\n- host: studio\n- started: 2026-01-01T10:00:00\.000Z\n- entry: e-17 at 2026-01-01T10:05:00\.000Z\n- also in: fork-a, fork-b\n {2}> MARKER-ALPHA found by the store/u);
		// The file search did not run, and the result keeps its shape.
		assert.deepEqual(fileHits(result), []);
		assert.doesNotMatch(text, /earlier session file/u);
		assert.equal(result.details.transcripts.scanned, 0);
		assert.equal(result.details.cache_documents.searched, true, "cache documents are still searched locally");
		assert.match(text, /## Cache documents/u);
		const memory = result.details.pi_memory;
		assert.ok(memory?.status === "answered");
		assert.equal(memory.cards.length, 1);
		assert.deepEqual(memory.cards[0]?.also_in, ["fork-a", "fork-b"]);
		assert.equal(memory.cards[0]?.entry_id, "e-17");
	} finally { f.cleanup(); }
});

test("REQ-2: max_sessions above 5 asks for 5 cards, and an over-long session id is left out rather than cut", async () => {
	const f = makeFixture({ responder: answer([]), sessionId: "s".repeat(300) });
	try {
		const result = await settled(f.query({}));
		assert.equal(f.requests[0]?.limit, 5);
		assert.equal(f.requests[0]?.askingSessionId, undefined);
		assert.match(body(result), /No matching sessions in the pi-memory session store \(project proj, current session excluded\)\./u);
	} finally { f.cleanup(); }
});

test("REQ-2: a query over 1000 characters is not sent and the session files are searched", async () => {
	const f = makeFixture({ responder: answer([card()]) });
	try {
		const result = await settled(f.query({ query: `MARKER-ALPHA ${"x".repeat(1000)}` }));
		assert.equal(f.requests.length, 0);
		assert.match(body(result), /pi-memory search unavailable \(query longer than 1000 characters\); searched session files instead\./u);
		assert.equal(result.details.pi_memory?.status, "query too long");
	} finally { f.cleanup(); }
});

test("REQ-3: prior keeps only cards of this project, a worktree counts as its project, and all-projects keeps every card", async () => {
	const cards = [card({ sessionId: "mine" }), card({ sessionId: "theirs", repo: "other-repo" }), card({ sessionId: "mine-2", repo: "proj" })];
	const f = makeFixture({ responder: answer(cards), cwd: (root) => path.join(root, "work", "proj", ".worktrees", "feature-x") });
	try {
		assert.equal(piMemoryRepoOf(f.projectDir, f.root), "proj");
		const prior = await settled(f.query({ scope: "prior" }));
		assert.match(body(prior), /2 sessions \(project proj, 12 ms; 1 from other projects left out, current session excluded\)/u);
		assert.match(body(prior), /### Session mine\n/u);
		assert.match(body(prior), /### Session mine-2\n/u);
		assert.doesNotMatch(body(prior), /theirs/u);
		assert.ok(prior.details.pi_memory?.status === "answered");
		assert.equal(prior.details.pi_memory.other_projects_left_out, 1);
		assert.equal(prior.details.pi_memory.returned, 3);

		const all = await settled(f.query({ scope: "all-projects" }));
		assert.match(body(all), /3 sessions \(all projects, 12 ms, current session excluded\)/u);
		assert.match(body(all), /### Session theirs\n- repo: other-repo/u);
	} finally { f.cleanup(); }
});

test("REQ-3: repo names follow pi-memory's repoOf: home prefix dropped, worktree tail dropped, home itself is ~", () => {
	assert.equal(piMemoryRepoOf("/h/u/code/acme/.worktrees/x/y", "/h/u"), "acme");
	assert.equal(piMemoryRepoOf("/h/u/code/acme", "/h/u/"), "acme");
	assert.equal(piMemoryRepoOf("/h/u", "/h/u"), "~");
	assert.equal(piMemoryRepoOf("/srv/acme", "/h/u"), "acme");
});

test("REQ-4: include_current adds this session's own transcript, searched locally, next to the cards", async () => {
	const f = makeFixture({ responder: answer([card(), card({ sessionId: CURRENT_ID, snippet: "the store's copy of this session" })]) });
	try {
		const result = await settled(f.query({ include_current: true }));
		const text = body(result);
		assert.match(text, /From the pi-memory session store: 1 session \(project proj, 12 ms\):/u);
		assert.match(text, /This session, searched locally:\nFound 1 session with matches/u);
		assert.match(text, /MARKER-ALPHA is in this session too/u);
		// The store's card for this session is dropped: this session is searched locally only.
		assert.doesNotMatch(text, /the store's copy of this session/u);
		assert.deepEqual(fileHits(result), ["current"]);
		assert.equal(result.details.transcripts.include_current, true);
		assert.doesNotMatch(text, /earlier session file/u);
	} finally { f.cleanup(); }
});

test("REQ-4: a card for an erased session, or an erased fork in alsoIn, is not shown", async () => {
	const f = makeFixture({ responder: answer([card({ sessionId: "gone", snippet: "ERASED-TEXT" }), card({ alsoIn: ["gone-fork", "kept-fork"] })]), erased: ["gone", "gone-fork"] });
	try {
		const result = await settled(f.query({}));
		assert.doesNotMatch(body(result), /ERASED-TEXT|gone/u);
		assert.match(body(result), /- also in: kept-fork\n/u);
		assert.ok(result.details.pi_memory?.status === "answered");
		assert.equal(result.details.pi_memory.erased_left_out, 1);
	} finally { f.cleanup(); }
});

test("REQ-4: oversized card fields are bounded in the text and the details", async () => {
	const many = Array.from({ length: 1000 }, (_, index) => `fork-${index}-${"z".repeat(5000)}`);
	const f = makeFixture({ responder: answer([card({ snippet: `MARKER-ALPHA ${"s".repeat(200_000)}`, title: "t".repeat(50_000), alsoIn: many, entryId: "e".repeat(10_000) })]) });
	try {
		const result = await settled(f.query({}));
		const text = body(result);
		assert.ok(text.length < 4000, `rendered ${text.length} characters`);
		assert.ok(result.details.pi_memory?.status === "answered");
		const shown = result.details.pi_memory.cards[0];
		assert.ok(shown);
		assert.ok(shown.snippet.length <= 720, `snippet ${shown.snippet.length}`);
		assert.ok((shown.title ?? "").length <= 80);
		assert.ok(shown.entry_id.length <= 128);
		assert.equal(shown.also_in?.length, 5);
		assert.ok((shown.also_in ?? []).every((id) => id.length <= 128));
		assert.equal(shown.also_in_more, 995);
		assert.match(text, /and 995 more/u);
		assert.ok(JSON.stringify(result.details).length < 8000, `details ${JSON.stringify(result.details).length}`);
	} finally { f.cleanup(); }
});

test("REQ-4: a credential in a card snippet is redacted", async () => {
	// Built at run time so the public-release secret scan does not flag the fixture.
	const credential = ["glpat", "12345678901234567890abcd"].join("-");
	const f = makeFixture({ responder: answer([card({ snippet: `MARKER-ALPHA deploy with token=${credential}` })]) });
	try {
		const result = await settled(f.query({}));
		assert.ok(!body(result).includes(credential), body(result));
		assert.match(body(result), /\[REDACTED\]/u);
	} finally { f.cleanup(); }
});

test("REQ-5: with no responder, the session files are searched and the result says pi-memory is not loaded", async () => {
	const f = makeFixture({ timeoutMs: 5000 });
	try {
		const started = Date.now();
		const result = await settled(f.query({}));
		assert.ok(Date.now() - started < 2000, "an absent store is known at once, without waiting for the timeout");
		assert.equal(f.requests.length, 1);
		assertFellBack(result, /pi-memory search unavailable \(not loaded\); searched session files instead\./u);
		assert.deepEqual(result.details.pi_memory, { status: "absent" });
	} finally { f.cleanup(); }
});

test("REQ-5: with no responder, the file search starts in the same turn, so overlapping searches can share one scan", async () => {
	const f = makeFixture();
	let listed = 0;
	const host: ContextRecallHost = {
		...f.host,
		listSessions: (scope, cwd, includeWorktrees) => {
			listed += 1;
			return f.host.listSessions(scope, cwd, includeWorktrees);
		},
	};
	try {
		const call = recallQuery({ query: "MARKER-ALPHA", scope: "all-projects" }, f.ctx, host);
		assert.equal(listed, 1, "the session listing must start before recallQuery first yields");
		assertFellBack(await settled(call), /pi-memory search unavailable \(not loaded\)/u);
	} finally { f.cleanup(); }
});

test("REQ-5: a responder that never replies times out, the files are searched, no timer is left, and a late reply is ignored", async () => {
	let late: ((result: unknown) => void) | undefined;
	const f = makeFixture({ timeoutMs: 60, responder: (request) => { request.ack(); late = request.reply; } });
	try {
		const before = timers();
		const started = Date.now();
		const result = await settled(f.query({}));
		assert.ok(Date.now() - started < 1000, "the fallback comes soon after the 60 ms timeout");
		assertFellBack(result, /pi-memory search unavailable \(timeout after 60 ms\); searched session files instead\./u);
		assert.deepEqual(result.details.pi_memory, { status: "timeout", timeout_ms: 60 });
		assert.equal(timers(), before, "no timer outlives the call");
		assert.ok(late);
		late({ ok: true, cards: [card()], tookMs: 1 });
		assert.equal(timers(), before, "a late reply schedules nothing");
	} finally { f.cleanup(); }
});

test("REQ-5: an answered call leaves no timer behind", async () => {
	const f = makeFixture({ responder: answer([card()]) });
	try {
		const before = timers();
		const result = await settled(f.query({}));
		assert.equal(result.details.pi_memory?.status, "answered");
		assert.equal(timers(), before);
	} finally { f.cleanup(); }
});

for (const error of ["unavailable", "timeout", "bad_request", "internal"] as const) {
	test(`REQ-5: an ok: false reply with error ${error} falls back to the session files and says why`, async () => {
		const f = makeFixture({ responder: replyLater({ ok: false, error, message: "store said no", tookMs: 4 }) });
		try {
			const result = await settled(f.query({}));
			assertFellBack(result, new RegExp(`pi-memory search unavailable \\(${error}: store said no\\)`, "u"));
			assert.deepEqual(result.details.pi_memory, { status: "error", error });
		} finally { f.cleanup(); }
	});
}

const MALFORMED: ReadonlyArray<readonly [string, unknown, RegExp]> = [
	["a reply that is not an object", "cards", /the reply is not an object/u],
	["an unknown ok value", { ok: "yes", cards: [], tookMs: 1 }, /ok is neither true nor false/u],
	["an unknown error kind", { ok: false, error: "exploded", message: "x", tookMs: 1 }, /unknown error kind/u],
	["cards that are not a list", { ok: true, cards: "none", tookMs: 1 }, /cards is not a list/u],
	["more than five cards", { ok: true, cards: Array.from({ length: 6 }, (_, index) => card({ sessionId: `s${index}` })), tookMs: 1 }, /more than 5 cards/u],
	["a missing tookMs", { ok: true, cards: [] }, /tookMs is not a number/u],
	["a card that is not an object", { ok: true, cards: [null], tookMs: 1 }, /a card is not an object/u],
	["a card with no sessionId", { ok: true, cards: [card({ sessionId: "" })], tookMs: 1 }, /a card has no sessionId/u],
	["a card with no repo", { ok: true, cards: [card({ repo: 7 as unknown as string })], tookMs: 1 }, /a card has no repo/u],
	["a card with no startedAt", { ok: true, cards: [card({ startedAt: undefined })], tookMs: 1 }, /a card has no startedAt/u],
	["a card with a score that is not finite", { ok: true, cards: [card({ score: Number.NaN })], tookMs: 1 }, /a card has no finite score/u],
	["a card with no entryId", { ok: true, cards: [card({ entryId: "" })], tookMs: 1 }, /a card has no entryId/u],
	["a card with no snippet", { ok: true, cards: [card({ snippet: undefined })], tookMs: 1 }, /a card has no snippet/u],
	["a card with a title that is not text", { ok: true, cards: [card({ title: { toString: () => "x" } as unknown as string })], tookMs: 1 }, /a field of the wrong type/u],
	["a card whose alsoIn holds a non-string", { ok: true, cards: [card({ alsoIn: ["a", 5] as unknown as string[] })], tookMs: 1 }, /alsoIn is not a list of session ids/u],
	["a reply whose fields throw when read", { ok: true, get cards(): never { throw new Error("boom"); }, tookMs: 1 }, /the reply could not be read/u],
];

for (const [name, reply, reason] of MALFORMED) {
	test(`REQ-5: ${name} fails validation and falls back to the session files`, async () => {
		const f = makeFixture({ responder: replyLater(reply) });
		try {
			const result = await settled(f.query({}));
			assertFellBack(result, /pi-memory search unavailable \(invalid reply: /u);
			assert.match(body(result), reason);
			assert.equal(result.details.pi_memory?.status, "invalid reply");
		} finally { f.cleanup(); }
	});
}

test("REQ-5: a responder that replies twice is not trusted, whether during emit or later", async () => {
	const good = { ok: true, cards: [card()], tookMs: 1 };
	const duringEmit: Responder = (request) => { request.ack(); request.reply(good); request.reply(good); };
	const later: Responder = (request) => { request.ack(); setTimeout(() => { request.reply(good); request.reply(good); }, 5); };
	for (const responder of [duringEmit, later]) {
		const f = makeFixture({ responder });
		try {
			const result = await settled(f.query({}));
			assertFellBack(result, /pi-memory search unavailable \(replied more than once\)/u);
			assert.deepEqual(result.details.pi_memory, { status: "replied twice" });
		} finally { f.cleanup(); }
	}
});

test("REQ-5: a reply during emit counts, even from a responder that skipped ack", async () => {
	const f = makeFixture({ responder: (request) => request.reply({ ok: true, cards: [card()], tookMs: 2 }) });
	try {
		const result = await settled(f.query({}));
		assert.equal(result.details.pi_memory?.status, "answered");
	} finally { f.cleanup(); }
});

test("REQ-5: on a bus that rethrows a listener's error, a listener that acks then throws falls back at once", async () => {
	const f = makeFixture({ responder: (request) => { request.ack(); throw new Error("listener failed"); } });
	try {
		const before = timers();
		const result = await settled(f.query({}));
		assertFellBack(result, /pi-memory search unavailable \(its listener threw\)/u);
		assert.deepEqual(result.details.pi_memory, { status: "threw" });
		assert.equal(timers(), before);
	} finally { f.cleanup(); }
});

// REQ-5 as amended in caair/pi/pi-context-aware!392: Pi's bus catches a listener's error inside emit, so the
// requester cannot see the throw. Before ack it reads as not loaded, after ack as a timeout no longer than timeoutMs.
test("REQ-5: on Pi's own event bus, a listener that throws before ack reads as not loaded, at once", async () => {
	const bus = createEventBus();
	bus.on(PI_MEMORY_SEARCH_EVENT, () => { throw new Error("listener failed"); });
	const errors: unknown[] = [];
	const consoleError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	const f = makeFixture({ events: bus, timeoutMs: 5000 });
	try {
		const before = timers();
		const started = Date.now();
		const result = await settled(f.query({}));
		assert.ok(Date.now() - started < 2000, "a listener that never acks is known at once, without waiting for the timeout");
		assertFellBack(result, /pi-memory search unavailable \(not loaded\); searched session files instead\./u);
		assert.deepEqual(result.details.pi_memory, { status: "absent" });
		assert.equal(busErrors(errors).length, 1, "Pi's bus reports the listener error itself");
		assert.equal(timers(), before);
	} finally {
		console.error = consoleError;
		f.cleanup();
	}
});

test("REQ-5: on Pi's own event bus, a listener that acks then throws falls back when the timeout ends, never later", async () => {
	const bus = createEventBus();
	bus.on(PI_MEMORY_SEARCH_EVENT, (data) => { (data as Request).ack(); throw new Error("listener failed"); });
	const errors: unknown[] = [];
	const consoleError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	const f = makeFixture({ events: bus, timeoutMs: 60 });
	try {
		const before = timers();
		const started = Date.now();
		const result = await settled(f.query({}));
		assert.ok(Date.now() - started < 1000, "the fallback comes soon after the 60 ms timeout");
		assertFellBack(result, /pi-memory search unavailable \(timeout after 60 ms\)/u);
		assert.deepEqual(result.details.pi_memory, { status: "timeout", timeout_ms: 60 });
		assert.equal(busErrors(errors).length, 1, "Pi's bus reports the listener error itself");
		assert.equal(timers(), before);
	} finally {
		console.error = consoleError;
		f.cleanup();
	}
});

// The wall-clock tests above prove the fallback happens; this one pins when.
// With the clock mocked, a deadline one tick early or any amount late fails.
test("REQ-5: on Pi's own event bus, the deadline is exactly the requested timeout, never earlier or later", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const bus = createEventBus();
	bus.on(PI_MEMORY_SEARCH_EVENT, (data) => { (data as Request).ack(); throw new Error("listener failed"); });
	const errors: unknown[] = [];
	const consoleError = console.error;
	console.error = (...args: unknown[]) => { errors.push(args); };
	const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
	try {
		const asked = askPiMemory(bus, { query: "MARKER-ALPHA", limit: 5 }, 60);
		assert.ok(asked instanceof Promise, "an acked request waits for a reply or its deadline");
		let outcome: unknown;
		void asked.then((value) => { outcome = value; });
		t.mock.timers.tick(59);
		await turn();
		assert.equal(outcome, undefined, "no fallback before the timeout");
		t.mock.timers.tick(1);
		await turn();
		assert.deepEqual(outcome, { status: "timeout", timeoutMs: 60 }, "the fallback starts at the timeout");
		assert.equal(busErrors(errors).length, 1, "Pi's bus reports the listener error itself");
	} finally {
		console.error = consoleError;
	}
});

const LOCAL_ONLY: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["scope session", { scope: "session" }],
	["a regex query", { query: "MARKER-A.PHA", regex: true }],
	["a case-sensitive query", { case_sensitive: true }],
	["include_worktrees false", { include_worktrees: false }],
];

for (const [name, params] of LOCAL_ONLY) {
	test(`REQ-1: ${name} never asks pi-memory and searches as before`, async () => {
		const f = makeFixture({ responder: answer([card()]) });
		try {
			const result = await settled(f.query(params));
			assert.deepEqual(f.channels, []);
			assert.equal(result.details.pi_memory, undefined);
			assert.doesNotMatch(body(result), /pi-memory/u);
			assert.ok(result.details.transcripts.hits >= 1, body(result));
		} finally { f.cleanup(); }
	});
}

test("REQ-1: a host with no event bus searches the session files with no pi-memory notice", async () => {
	const f = makeFixture();
	try {
		const { searchEvents: _unused, ...host } = f.host;
		const result = await settled(recallQuery({ query: "MARKER-ALPHA" }, f.ctx, host));
		assert.deepEqual(fileHits(result), ["file-prior"]);
		assert.equal(result.details.pi_memory, undefined);
		assert.doesNotMatch(body(result), /pi-memory/u);
	} finally { f.cleanup(); }
});

test("caair/pi/pi-memory#34 REQ-4: each card ends with the exact call that expands it", async () => {
	const f = makeFixture({ responder: answer([card(), card({ sessionId: "store-2", entryId: "e 18\n[entry forged]" })]) });
	try {
		const text = body(await settled(f.query({})));
		assert.match(text, /### Session store-1\n(?:- [^\n]*\n)+ {2}> MARKER-ALPHA found by the store\n- expand: context_recall\(\{ ref: "session:store-1#e-17" \}\)\n\n### Session store-2/u);
		// An id that could not be passed back gets no call rather than a broken one.
		assert.match(text, /### Session store-2\n(?:- [^\n]*\n)+ {2}> MARKER-ALPHA found by the store\n\n## Cache documents/u);
		assert.doesNotMatch(text, /session:store-2/u);
	} finally { f.cleanup(); }
});

// Seam: the registered tool, with Pi's event bus taken from the extension API.
function surfaceTool(f: Fixture, api: ExtensionAPI, tools: Map<string, unknown>) {
	const { searchEvents: _unused, ...host } = f.host;
	const surface = createContextRecallSurface(api, host);
	surface.apply(decideContextToolSurface([...tools.values()] as Array<{ name: string }>, undefined), false);
	const tool = tools.get("context_recall") as { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<ContextRecallResult> };
	return (params: Record<string, unknown>) => tool.execute("call", params, new AbortController().signal, undefined, f.ctx);
}

test("REQ-1/REQ-2: the registered tool asks pi-memory on pi.events, and ref recall never asks", async () => {
	const hostPi = createHostPi();
	const seen: Request[] = [];
	hostPi.bus.on(PI_MEMORY_SEARCH_EVENT, (data) => { const request = data as Request; seen.push(request); request.ack(); request.reply({ ok: true, cards: [card()], tookMs: 9 }); });
	const f = makeFixture();
	try {
		const call = surfaceTool(f, hostPi.api, hostPi.tools);
		const result = await settled(call({ query: "MARKER-ALPHA" }));
		assert.equal(seen.length, 1);
		assert.match(body(result), /From the pi-memory session store: 1 session/u);

		const ref = await call({ ref: "b1" });
		assert.equal(seen.length, 1, "ref recall reads the session, never the store");
		assert.doesNotMatch(body(ref), /pi-memory/u);
	} finally { f.cleanup(); }
});

test("CR-CARD-EXPAND-TRUNCATION: ids up to 256 characters keep their exact expand call; longer ids get a note, never a cut call", async () => {
	const session129 = `s${"1".repeat(128)}`;
	const entry129 = `e${"2".repeat(128)}`;
	const session256 = `s${"3".repeat(255)}`;
	const entry256 = `e${"4".repeat(255)}`;
	const session257 = `s${"5".repeat(256)}`;
	const f = makeFixture({ responder: answer([
		card({ sessionId: session129, entryId: entry129 }),
		card({ sessionId: session256, entryId: entry256 }),
		card({ sessionId: session257, entryId: "e-1" }),
		card({ sessionId: "store-4", entryId: `e${"6".repeat(256)}` }),
	]) });
	try {
		const result = await settled(f.query({ scope: "all-projects" }));
		const text = body(result);
		assert.equal(session129.length, 129);
		assert.equal(session256.length, 256);
		assert.ok(text.includes(`- expand: context_recall({ ref: "session:${session129}#${entry129}" })`), "129-character ids are passed back whole");
		assert.ok(text.includes(`- expand: context_recall({ ref: "session:${session256}#${entry256}" })`), "256-character ids are passed back whole");
		assert.equal(text.match(/- expand: context_recall/gu)?.length, 2, "no other card gets a call");
		assert.equal(text.match(/- expand: none \(an id is longer than 256 characters, so no call can name it\)/gu)?.length, 2);
		assert.ok(!text.includes(`session:${session257.slice(0, 256)}`), "a long id is never cut into a call");
		assert.ok(result.details.pi_memory?.status === "answered");
		const [first, second, third] = result.details.pi_memory.cards;
		assert.equal(first?.expand, `context_recall({ ref: "session:${session129}#${entry129}" })`);
		assert.equal(second?.expand, `context_recall({ ref: "session:${session256}#${entry256}" })`);
		assert.equal(third?.expand, undefined);
	} finally { f.cleanup(); }
});

test("limit aliases: limit, max_results and maxResults set the number of sessions; max_sessions wins a conflict; a non-number is refused", async () => {
	const hostPi = createHostPi();
	const seen: Request[] = [];
	hostPi.bus.on(PI_MEMORY_SEARCH_EVENT, (data) => { const request = data as Request; seen.push(request); request.ack(); request.reply({ ok: true, cards: [], tookMs: 1 }); });
	const f = makeFixture();
	try {
		const call = surfaceTool(f, hostPi.api, hostPi.tools);
		await settled(call({ query: "MARKER-ALPHA", limit: 2 }));
		await settled(call({ query: "MARKER-ALPHA", max_results: 3 }));
		await settled(call({ query: "MARKER-ALPHA", maxResults: 4 }));
		await settled(call({ query: "MARKER-ALPHA", max_sessions: 1, limit: 4, maxResults: 3 }));
		await settled(call({ query: "MARKER-ALPHA", limit: 1, max_results: 4 }));
		assert.deepEqual(seen.map((request) => request.limit), [2, 3, 4, 1, 1]);
		const bad = await call({ query: "MARKER-ALPHA", limit: "5" });
		assert.equal(bad.isError, true);
		assert.match(body(bad), /limit is a number of sessions/u);
		assert.equal(seen.length, 5, "a refused call asks nothing");
	} finally { f.cleanup(); }
});

test("limit aliases: the file search honours them as max_sessions", async () => {
	const f = makeFixture();
	try {
		const { searchEvents: _unused, ...host } = f.host;
		const result = await recallQuery(contextRecallRequest({ query: "MARKER-ALPHA", maxResults: 1 } as never), f.ctx, host);
		assert.equal(contextRecallRequest({ query: "q", limit: 7 } as never).max_sessions, 7);
		assert.equal(contextRecallRequest({ query: "q", max_results: 6 } as never).max_sessions, 6);
		assert.equal(contextRecallRequest({ query: "q", maxResults: 5, max_sessions: 2 } as never).max_sessions, 2);
		assert.equal(contextRecallRequest({ query: "q" } as never).max_sessions, undefined);
		assert.deepEqual(fileHits(result), ["file-prior"]);
	} finally { f.cleanup(); }
});
