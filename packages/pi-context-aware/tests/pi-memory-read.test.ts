import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import {
	askPiMemoryRead,
	readPiMemoryReadReply,
	READ_DEFAULT_MAX_CHARS,
	READ_DEFAULT_TIMEOUT_MS,
	READ_DEFAULT_AFTER,
	READ_DEFAULT_BEFORE,
	READ_DEFAULT_ITEM_MAX_CHARS,
	READ_EVENT,
	READ_MAX_ID_CHARS,
	READ_MAX_ITEM_MAX_CHARS,
	READ_MAX_KINDS,
	READ_MAX_MAX_CHARS,
	READ_MAX_PAGE,
	readSessionFile,
	READ_MIN_ITEM_MAX_CHARS,
	ERASED_CACHE_PATH,
	type PiMemoryReadFields,
	type PiMemoryReadOutcome,
} from "../src/context-tools/pi-memory-read.js";

// Seam: askPiMemoryRead over a fake bus whose listener plays pi-memory's read responder
// (caair/pi/pi-memory#34): ack during emit, then one reply.

interface SeenRequest {
	v: unknown;
	op: unknown;
	sessionId: unknown;
	entryId?: unknown;
	before?: unknown;
	after?: unknown;
	cursor?: unknown;
	mode?: unknown;
	maxChars?: unknown;
	askingSessionId?: unknown;
	timeoutMs?: unknown;
	ack(): void;
	reply(result: unknown): void;
}

function bus(listener?: (request: SeenRequest) => void) {
	const seen: SeenRequest[] = [];
	const channels: string[] = [];
	return {
		seen,
		channels,
		emit(channel: string, data: unknown) {
			channels.push(channel);
			seen.push(data as SeenRequest);
			listener?.(data as SeenRequest);
		},
	};
}

const FIELDS: PiMemoryReadFields = { op: "expand", sessionId: "s-1", entryId: "e-1", before: 2, after: 3, mode: "turns", maxChars: 5000, askingSessionId: "me" };

const session = { sessionId: "s-1", repo: "proj", startedAt: "2026-01-01T00:00:00.000Z", entries: 3 };
const item = (entryId: string, text = `text of ${entryId}`) => ({ entryId, ts: "2026-01-01T00:00:01.000Z", seq: 1, kind: "user", text, fullChars: text.length, cut: false });
const OK = { ok: true, session, items: [item("e-1")], truncated: false, tookMs: 4 };

async function outcome(value: PiMemoryReadOutcome | Promise<PiMemoryReadOutcome>): Promise<PiMemoryReadOutcome> {
	return value instanceof Promise ? value : value;
}

const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout" || kind === "Immediate").length;

test("REQ-1: the contract constants are the shared S10 values", () => {
	assert.equal(READ_EVENT, "pi-memory:read");
	assert.equal(READ_DEFAULT_BEFORE, 3);
	assert.equal(READ_DEFAULT_AFTER, 5);
	assert.equal(READ_MAX_PAGE, 50);
	assert.equal(READ_DEFAULT_MAX_CHARS, 12000);
	assert.equal(READ_MAX_MAX_CHARS, 40000);
	assert.equal(READ_DEFAULT_ITEM_MAX_CHARS, 1500);
	assert.equal(READ_MIN_ITEM_MAX_CHARS, 200);
	assert.equal(READ_MAX_ITEM_MAX_CHARS, 12000);
	assert.equal(READ_MAX_KINDS, 16);
	assert.equal(READ_DEFAULT_TIMEOUT_MS, 2500);
	assert.equal(READ_MAX_ID_CHARS, 256);
	assert.equal(ERASED_CACHE_PATH, ".config/pi-memory/erased-sessions.sha256");
});

test("REQ-1: the S10 contract block is byte-identical to pi-memory's copy (SHA-256 of the block)", () => {
	// The block runs from its marker comment to the ERASED_CACHE_PATH line, both included. pi-memory's
	// src/contract.ts carries the same text; a change to either copy must change both and this hash.
	const source = fs.readFileSync(new URL("../../src/context-tools/pi-memory-read.ts", import.meta.url), "utf8");
	const start = source.indexOf("// S10 shared contract (");
	const endLine = "export const ERASED_CACHE_PATH = \".config/pi-memory/erased-sessions.sha256\";\n";
	const end = source.indexOf(endLine);
	assert.ok(start >= 0 && end > start, "the block markers are present");
	const block = source.slice(start, end + endLine.length);
	assert.equal(createHash("sha256").update(block, "utf8").digest("hex"), "f4d8ec314e7b466edb814534bdafc747b8372642c4bde12c3a2568f1d12b4166");
});

test("REQ-1: an acked request answered later resolves to the copied reply, on the read channel with named fields only", async () => {
	const events = bus((request) => { request.ack(); setTimeout(() => request.reply(OK), 2); });
	const result = await outcome(askPiMemoryRead(events, { ...FIELDS, ...{ extra: "leak" } } as PiMemoryReadFields, 500));
	assert.deepEqual(events.channels, [READ_EVENT]);
	const sent = events.seen[0]!;
	assert.deepEqual(
		Object.keys(sent).filter((key) => key !== "ack" && key !== "reply").sort(),
		["after", "askingSessionId", "before", "entryId", "maxChars", "mode", "op", "sessionId", "timeoutMs", "v"],
	);
	assert.equal(sent.v, 1);
	assert.equal(sent.op, "expand");
	assert.equal(sent.timeoutMs, 500);
	assert.equal(result.status, "answered");
	assert.ok(result.status === "answered");
	assert.equal(result.answer.items[0]?.entryId, "e-1");
	assert.equal(result.answer.session.repo, "proj");
	assert.equal(timers(), 0, "no timer is left behind");
});

test("REQ-1: no ack is absent at once, without waiting for the timeout", () => {
	const result = askPiMemoryRead(bus(), FIELDS, 10_000);
	assert.ok(!(result instanceof Promise), "known during emit");
	assert.deepEqual(result, { status: "absent" });
	assert.equal(timers(), 0);
});

test("REQ-1: an ack with no reply times out after timeoutMs", async () => {
	const started = Date.now();
	const result = await outcome(askPiMemoryRead(bus((request) => request.ack()), FIELDS, 30));
	assert.deepEqual(result, { status: "timeout", timeoutMs: 30 });
	assert.ok(Date.now() - started >= 25);
	assert.equal(timers(), 0);
});

test("REQ-1: two replies are a fault, and a reply after settling is ignored", async () => {
	const twice = await outcome(askPiMemoryRead(bus((request) => { request.ack(); setTimeout(() => { request.reply(OK); request.reply(OK); }, 1); }), FIELDS, 500));
	assert.deepEqual(twice, { status: "replied twice" });
	const during = askPiMemoryRead(bus((request) => { request.ack(); request.reply(OK); request.reply(OK); }), FIELDS, 500);
	assert.deepEqual(await outcome(during), { status: "replied twice" });
	let late: ((value: unknown) => void) | undefined;
	const slow = await outcome(askPiMemoryRead(bus((request) => { request.ack(); late = request.reply; }), FIELDS, 20));
	assert.equal(slow.status, "timeout");
	assert.doesNotThrow(() => late?.(OK));
});

test("REQ-1: a reply during emit without ack still counts, and a throwing bus reads as threw", async () => {
	const noAck = await outcome(askPiMemoryRead(bus((request) => request.reply(OK)), FIELDS, 500));
	assert.equal(noAck.status, "answered");
	const thrown = askPiMemoryRead({ emit() { throw new Error("listener failed"); } }, FIELDS, 500);
	assert.deepEqual(await outcome(thrown), { status: "threw" });
});

test("REQ-1: Pi's own bus carries the request and the reply", async () => {
	const piBus = createEventBus();
	piBus.on(READ_EVENT, (data) => { const request = data as SeenRequest; request.ack(); request.reply(OK); });
	const result = await outcome(askPiMemoryRead(piBus, FIELDS, 500));
	assert.equal(result.status, "answered");
});

test("REQ-1: error replies keep their kind; malformed replies are invalid", () => {
	for (const error of ["unavailable", "timeout", "bad_request", "not_found", "no_raw", "internal"]) {
		assert.deepEqual(readPiMemoryReadReply({ ok: false, error, message: "m", tookMs: 1 }), { status: "error", error, message: "m" });
	}
	assert.equal(readPiMemoryReadReply({ ok: false, error: "boom", message: "m", tookMs: 1 }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply(null).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, session: { ...session, entries: "3" } }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, items: [{ ...item("e-1"), seq: "1" }] }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, items: [{ ...item("e-1"), entryId: "" }] }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, items: [{ ...item("e-1"), entryId: "" }] }, { mode: "turns" }).status, "invalid reply", "turns mode needs an entry id");
	assert.equal(readPiMemoryReadReply({ ...OK, next: 7 }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, truncated: "no" }).status, "invalid reply");
	const throwing = { ok: true, get session(): unknown { throw new Error("getter"); } };
	assert.deepEqual(readPiMemoryReadReply(throwing), { status: "invalid reply", reason: "the reply could not be read" });
});

test("REQ-1: an over-long item is cut to READ_DEFAULT_ITEM_MAX_CHARS and flagged, and unknown fields are not copied", () => {
	const long = "x".repeat(100_000);
	const result = readPiMemoryReadReply({ ...OK, items: [{ ...item("e-1", long), fullChars: 10, cut: false, secret: "leak" }], extra: "leak" });
	assert.ok(result.status === "answered");
	const [only] = result.answer.items;
	assert.equal(only?.text.length, READ_DEFAULT_ITEM_MAX_CHARS);
	assert.equal(only?.cut, true);
	assert.equal(only?.fullChars, 100_000);
	assert.equal((only as unknown as Record<string, unknown>).secret, undefined);
	assert.equal((result.answer as unknown as Record<string, unknown>).extra, undefined);
});

test("CR-RAW-HEADER-REJECTED: a raw reply whose header line has entryId \"\" is answered; turns mode still refuses it", async () => {
	const header = { ...item("e-1"), entryId: "", kind: "session", text: "{\"type\":\"session\"}" };
	const raw = readPiMemoryReadReply({ ...OK, items: [header, item("e-2")] }, { mode: "raw" });
	assert.equal(raw.status, "answered", JSON.stringify(raw));
	assert.ok(raw.status === "answered");
	assert.deepEqual(raw.answer.items.map((one) => one.entryId), ["", "e-2"]);
	assert.equal(readPiMemoryReadReply({ ...OK, items: [header] }, { mode: "turns" }).status, "invalid reply");
	assert.equal(readPiMemoryReadReply({ ...OK, items: [{ ...header, entryId: 7 }] }, { mode: "raw" }).status, "invalid reply", "a non-string id is still refused");
	// Through the requester: the mode sent decides.
	const asked = await outcome(askPiMemoryRead(bus((request) => { request.ack(); request.reply({ ...OK, items: [header] }); }), { ...FIELDS, mode: "raw" }, 500));
	assert.equal(asked.status, "answered");
	const turns = await outcome(askPiMemoryRead(bus((request) => { request.ack(); request.reply({ ...OK, items: [header] }); }), { ...FIELDS, mode: "turns" }, 500));
	assert.equal(turns.status, "invalid reply");
});

test("REQ-1: an item is cut to the requested itemMaxChars, which the request carries", async () => {
	const long = "y".repeat(9000);
	const capped = readPiMemoryReadReply({ ...OK, items: [item("e-1", long)] }, { itemMaxChars: 5000 });
	assert.ok(capped.status === "answered");
	assert.equal(capped.answer.items[0]?.text.length, 5000);
	assert.equal(capped.answer.items[0]?.cut, true);
	const events = bus((request) => { request.ack(); request.reply({ ...OK, items: [item("e-1", long)] }); });
	const asked = await outcome(askPiMemoryRead(events, { ...FIELDS, itemMaxChars: 8000, kinds: ["user", "assistant"], from: "end" }, 500));
	assert.ok(asked.status === "answered");
	assert.equal(asked.answer.items[0]?.text.length, 8000, "the requester keeps what it asked for");
	const sent = events.seen[0] as unknown as Record<string, unknown>;
	assert.equal(sent.itemMaxChars, 8000);
	assert.deepEqual(sent.kinds, ["user", "assistant"]);
	assert.equal(sent.from, "end");
});

test("fields: a file expand keeps at most READ_MAX_PAGE entries, reducing before first, then after", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-page-"));
	try {
		const file = path.join(dir, "s.jsonl");
		const lines = [{ type: "session", id: "s", timestamp: "t", cwd: "/w" }, ...Array.from({ length: 100 }, (_, index) => ({ type: "message", id: `m${index}`, timestamp: "t", message: { role: "user", content: `T${index}` } }))];
		fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
		const read = (before: number, after: number) => {
			const result = readSessionFile(file, { op: "expand", sessionId: "s", entryId: "m30", before, after, mode: "turns", maxChars: 40_000, itemMaxChars: 1500, repoOf: () => "w" });
			assert.ok(result.ok);
			return result.answer.items.map((item) => item.entryId);
		};
		const both = read(50, 50);
		assert.equal(both.length, READ_MAX_PAGE);
		assert.equal(both[0], "m30", "before is reduced to nothing first");
		assert.equal(both.at(-1), "m79");
		const some = read(10, 45);
		assert.equal(some.length, READ_MAX_PAGE);
		assert.equal(some[0], "m26", "before keeps what the page has room for");
		assert.equal(some.at(-1), "m75");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
