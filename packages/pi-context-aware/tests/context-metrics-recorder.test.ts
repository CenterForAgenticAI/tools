import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS, MAX_COMPACTION_WAIT_RECORDS, type MetricsSettings } from "../src/metrics/recorder.js";
import { buildMetricsRecord, COMPACTION_WRITERS, lastMetricsSeq, metricsSessionFile } from "../src/metrics/records.js";
import type { CompactionWriterKind } from "../src/compaction/compaction-writer.js";
import type { FoldTurnResult } from "../src/folds/fold-turn.js";
import type { FoldRequestResult } from "../src/folds/fold-engine.js";

const CANARY = "CANARY-PLAN-xyz-9981";
const ladder = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
function context(sessionId = "sess-1") {
	const manager = {
		getSessionId: () => sessionId,
		getLeafId: () => "leaf-7",
		getBranch: () => [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: CANARY }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { cmd: CANARY } }], usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } },
		],
	};
	return { sessionManager: manager, model: { id: "claude-test", contextWindow: 1000 } } as unknown as ExtensionContext;
}
const turn = (before: number, extra: Partial<FoldTurnResult> = {}): FoldTurnResult => ({ messages: [], sources: [], dropped: [], tokens: { before, after: before - 100 }, ...extra }) as FoldTurnResult;
function setup(settings: MetricsSettings = DEFAULT_METRICS_SETTINGS) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-rec-"));
	const recorder = registerMetricsRecorder({ agentDir: () => root, settings: () => settings, ladder: () => ladder, now: () => new Date("2026-01-01T00:00:00Z") });
	const read = () => fs.readFileSync(metricsSessionFile(root, "sess-1"), "utf8");
	return { root, recorder, read, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("one record per request, with every listed field, and no message text", async () => {
	const t = setup();
	try {
		const ctx = context();
		const refused = { ok: false, errors: [`Ref ${CANARY} does not exist in this session`], validRefs: [] } as unknown as FoldRequestResult;
		t.recorder.observers.onTurn?.(ctx, turn(500, { nudge: CANARY, nudgeKind: "tier2", emergency: { usage: 1, threshold: 0.95, tokenCount: 1, limit: 1, truncated: 3, hideCandidates: ["e1", "e2"], announce: [] } }));
		t.recorder.observers.onRequest?.(ctx, { ok: true, mode: "live", queued: true, blockIds: ["b1"], warnings: [CANARY] });
		t.recorder.observers.onRequest?.(ctx, refused);
		t.recorder.observers.onDrain?.(ctx, [{ startRef: "m1", endRef: "m2", errors: [CANARY], code: "branch-changed" }]);
		t.recorder.noteCompaction(ctx, { writer: "context-aware", tokensBefore: 900, tokensAfter: 300 });
		t.recorder.observers.onTurn?.(ctx, undefined);
		await t.recorder.flush();
		const raw = t.read();
		assert.ok(!raw.includes(CANARY), "no message, summary, tool argument or error text in the file");
		const records = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(records.length, 2, "one record per request");
		const first = records[0];
		assert.deepEqual(first, {
			v: 1, seq: 1, at: "2026-01-01T00:00:00.000Z", sessionId: "sess-1", leafId: "leaf-7", modelId: "claude-test", window: 1000,
			tokensBefore: 500, tokensAfter: 400, pressure: 0.5, band: "warn", nudge: "tier2",
			emergency: { truncated: 3, hides: 2, skipped: false, terminal: false }, passFailed: false,
			folds: { requested: 2, accepted: 1, refused: { "unknown-ref": 1 }, dropped: { "branch-changed": 1 }, tiers: null },
			compaction: { writer: "context-aware", tokensBefore: 900, tokensAfter: 300 },
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
		});
		assert.equal(records[1].seq, 2);
		assert.equal(records[1].passFailed, true);
		assert.deepEqual(records[1].folds, { requested: 0, accepted: 0, refused: {}, dropped: {}, tiers: null }, "counts reset after each record");
		assert.equal(records[1].compaction, null);
	} finally { t.done(); }
});

const lines = (raw: string) => raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const okResult = { ok: true, mode: "live", queued: true, blockIds: ["b1"], warnings: [] } as unknown as FoldRequestResult;

test("a fold requested after request N is counted in record N, not N+1", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(100));
		t.recorder.observers.onRequest?.(ctx, okResult);
		t.recorder.observers.onTurn?.(ctx, turn(900));
		await t.recorder.flush();
		const records = lines(t.read());
		assert.equal(records.length, 2);
		assert.equal(records[0].folds.requested, 1);
		assert.equal(records[0].pressure, 0.1, "the fold carries the pressure of the request that made it");
		assert.equal(records[1].folds.requested, 0);
	} finally { t.done(); }
});

test("a fold in the last request of a session is written when the session closes", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(100));
		t.recorder.observers.onRequest?.(ctx, okResult);
		t.recorder.close(ctx);
		await t.recorder.flush();
		const records = lines(t.read());
		assert.equal(records.length, 1);
		assert.equal(records[0].folds.accepted, 1);
	} finally { t.done(); }
});

test("flush alone writes the open record of a session that never closed, once", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(100));
		t.recorder.observers.onDrain?.(ctx, [{ startRef: "m1", endRef: "m2", errors: [], code: "branch-changed" }]);
		await t.recorder.flush();
		const records = lines(t.read());
		assert.equal(records.length, 1, "exactly one record");
		assert.deepEqual(records[0].folds.dropped, { "branch-changed": 1 });
		await t.recorder.flush();
		assert.equal(lines(t.read()).length, 1, "a second flush writes nothing more");
	} finally { t.done(); }
});

test("a compaction after a request lands in that request's record", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(100));
		t.recorder.noteCompaction(ctx, { writer: "context-aware", tokensBefore: 5, tokensAfter: 1 });
		t.recorder.observers.onTurn?.(ctx, turn(200));
		await t.recorder.flush();
		const records = lines(t.read());
		assert.deepEqual(records[0].compaction, { writer: "context-aware", tokensBefore: 5, tokensAfter: 1 });
		assert.equal(records[1].compaction, null);
	} finally { t.done(); }
});

test("an open record stays with its own session", async () => {
	const t = setup();
	try {
		const a = context("sess-1");
		const b = context("sess-2");
		t.recorder.observers.onTurn?.(a, turn(100));
		t.recorder.observers.onTurn?.(b, turn(100));
		t.recorder.observers.onRequest?.(a, okResult);
		t.recorder.close(b);
		t.recorder.close(a);
		await t.recorder.flush();
		assert.equal(lines(t.read()).length, 1);
		assert.equal(lines(t.read())[0].folds.requested, 1);
		const other = lines(fs.readFileSync(metricsSessionFile(t.root, "sess-2"), "utf8"));
		assert.equal(other[0].folds.requested, 0);
	} finally { t.done(); }
});

test("a refusal with no code and no error text counts as unknown; several reasons count once each", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(500));
		const refuse = (errors: string[]) => t.recorder.observers.onRequest?.(ctx, { ok: false, errors, validRefs: [] } as unknown as FoldRequestResult);
		refuse([]);
		refuse(["  "]);
		refuse(["Summary is empty", "Session header is unavailable."]);
		await t.recorder.flush();
		const folds = JSON.parse(t.read().split("\n").filter(Boolean)[0]!).folds;
		assert.equal(folds.requested, 3);
		assert.deepEqual(folds.refused, { unknown: 2, "summary-empty": 1, "header-missing": 1 });
	} finally { t.done(); }
});

test("a dropped fold with no code and no error text counts as unknown", async () => {
	const t = setup();
	try {
		const ctx = context();
		t.recorder.observers.onTurn?.(ctx, turn(500));
		t.recorder.observers.onDrain?.(ctx, [
			{ startRef: "m1", endRef: "m2", errors: [] },
			{ startRef: "m3", endRef: "m4", errors: ["  "] },
			{ startRef: "m5", endRef: "m6", errors: ["Summary is empty"] },
		]);
		await t.recorder.flush();
		const folds = JSON.parse(t.read().split("\n").filter(Boolean)[0]!).folds;
		assert.deepEqual(folds.dropped, { unknown: 2, "summary-empty": 1 });
	} finally { t.done(); }
});

test("bands follow the ladder: ok below the nudge start, urgent from the seeded step", async () => {
	const t = setup();
	try {
		const ctx = context();
		for (const before of [100, 460, 900]) t.recorder.observers.onTurn?.(ctx, turn(before));
		await t.recorder.flush();
		const bands = t.read().split("\n").filter(Boolean).map((line) => JSON.parse(line).band);
		assert.deepEqual(bands, ["ok", "warn", "urgent"]);
	} finally { t.done(); }
});

test("with the switch off nothing is written", async () => {
	const t = setup({ ...DEFAULT_METRICS_SETTINGS, enabled: false });
	try {
		t.recorder.observers.onTurn?.(context(), turn(500));
		await t.recorder.flush();
		assert.equal(fs.existsSync(metricsSessionFile(t.root, "sess-1")), false);
	} finally { t.done(); }
});

test("a failed write is swallowed and the next request still records", async () => {
	const t = setup();
	try {
		const bad = context("sess-1");
		fs.mkdirSync(path.join(t.root, "context-aware"), { recursive: true });
		fs.writeFileSync(path.join(t.root, "context-aware", "metrics"), "not a directory");
		t.recorder.observers.onTurn?.(bad, turn(500));
		await t.recorder.flush();
		fs.rmSync(path.join(t.root, "context-aware", "metrics"));
		t.recorder.observers.onTurn?.(bad, turn(500));
		await t.recorder.flush();
		assert.equal(t.read().split("\n").filter(Boolean).length, 1);
	} finally { t.done(); }
});

const seqs = (read: () => string) => read().split("\n").filter(Boolean).map((line) => JSON.parse(line).seq as number);
const again = (root: string, extra: Partial<Parameters<typeof registerMetricsRecorder>[0]> = {}, settings: MetricsSettings = DEFAULT_METRICS_SETTINGS) =>
	registerMetricsRecorder({ agentDir: () => root, settings: () => settings, ladder: () => ladder, now: () => new Date("2026-01-01T00:00:00Z"), ...extra });

test("a new recorder over an existing session file continues from its last seq", async () => {
	const t = setup();
	try {
		t.recorder.observers.onTurn?.(context(), turn(500));
		t.recorder.observers.onTurn?.(context(), turn(500));
		await t.recorder.flush();
		const resumed = again(t.root);
		resumed.observers.onTurn?.(context(), turn(500));
		await resumed.flush();
		assert.deepEqual(seqs(t.read), [1, 2, 3]);
	} finally { t.done(); }
});

test("lastMetricsSeq is 0 for a missing store, a missing or empty file, and a truncated last line", async () => {
	const t = setup();
	try {
		assert.equal(await lastMetricsSeq(t.root, "sess-1"), 0, "no store");
		fs.mkdirSync(path.join(t.root, "context-aware", "metrics", "v1"), { recursive: true });
		assert.equal(await lastMetricsSeq(t.root, "sess-1"), 0, "no file");
		const file = metricsSessionFile(t.root, "sess-1");
		fs.writeFileSync(file, "");
		assert.equal(await lastMetricsSeq(t.root, "sess-1"), 0, "empty file");
		fs.writeFileSync(file, '{"seq":4}\n{"seq":5,"at":');
		assert.equal(await lastMetricsSeq(t.root, "sess-1"), 0, "truncated last line");
		fs.writeFileSync(file, '{"seq":4}\n{"seq":7}\n');
		assert.equal(await lastMetricsSeq(t.root, "sess-1"), 7);
		const fresh = again(t.root);
		fs.writeFileSync(file, "garbage\n");
		fresh.observers.onTurn?.(context(), turn(500));
		await fresh.flush();
		assert.equal(seqs(() => fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n")).at(-1), 1);
	} finally { t.done(); }
});

test("seq keeps increasing across a size trim and a restart", async () => {
	const settings = { ...DEFAULT_METRICS_SETTINGS, maxBytes: 2500 };
	const t = setup(settings);
	try {
		let recorder = t.recorder;
		for (let round = 0; round < 4; round++) {
			for (let i = 0; i < 3; i++) recorder.observers.onTurn?.(context(), turn(500));
			await recorder.flush();
			recorder = again(t.root, {}, settings);
		}
		const all = seqs(t.read);
		assert.ok(all.length < 12, "the trim dropped old lines");
		assert.equal(all.at(-1), 12);
		for (let i = 1; i < all.length; i++) assert.equal(all[i], all[i - 1]! + 1);
	} finally { t.done(); }
});

test("two turns before a flush get distinct, increasing seq in write order", async () => {
	const t = setup();
	try {
		for (let i = 0; i < 5; i++) t.recorder.observers.onTurn?.(context(), turn(500));
		await t.recorder.flush();
		assert.deepEqual(seqs(t.read), [1, 2, 3, 4, 5]);
	} finally { t.done(); }
});

test("a failed seed read is logged, the write is still attempted and flush resolves", async () => {
	const t = setup();
	try {
		fs.mkdirSync(path.join(t.root, "context-aware"), { recursive: true });
		fs.writeFileSync(path.join(t.root, "context-aware", "metrics"), "not a directory");
		const logs: string[] = [];
		let writes = 0;
		const recorder = again(t.root, { log: (m) => logs.push(m), write: async () => { writes++; } });
		recorder.observers.onTurn?.(context(), turn(500));
		await recorder.flush();
		assert.ok(logs.some((m) => m.includes("seq seed failed")), logs.join("|"));
		assert.equal(writes, 1);
	} finally { t.done(); }
});


function usageContext(tokens: () => number | null) {
	const base = context() as unknown as Record<string, unknown>;
	return { ...base, getContextUsage: () => ({ tokens: tokens(), contextWindow: 1000, percent: null }) } as unknown as ExtensionContext;
}

test("a compaction record waits for the first measured token count and never estimates one", async () => {
	const t = setup();
	try {
		let measured: number | null = null;
		const ctx = usageContext(() => measured);
		t.recorder.noteCompaction(ctx, { writer: "pi", tokensBefore: 900, tokensAfter: null });
		t.recorder.observers.onTurn?.(ctx, turn(500));
		measured = 321;
		t.recorder.observers.onTurn?.(ctx, turn(500));
		t.recorder.observers.onTurn?.(ctx, turn(500));
		await t.recorder.flush();
		const records = t.read().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(records.length, 3);
		// A record is parked until the next turn, so the measured count that arrives before then is the one it gets.
		assert.deepEqual(records[0].compaction, { writer: "pi", tokensBefore: 900, tokensAfter: 321 });
		assert.equal(records[1].compaction, null, "written once");
		assert.equal(records[2].compaction, null, "written once");
	} finally { t.done(); }
});

test("a compaction that never gets a measured count is written with null after the wait", async () => {
	const t = setup();
	try {
		const ctx = usageContext(() => null);
		t.recorder.noteCompaction(ctx, { writer: "extension", tokensBefore: 900, tokensAfter: null });
		for (let i = 0; i < MAX_COMPACTION_WAIT_RECORDS + 1; i++) t.recorder.observers.onTurn?.(ctx, turn(500));
		await t.recorder.flush();
		const records = t.read().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.deepEqual(records.map((r) => r.compaction), [null, null, null, { writer: "extension", tokensBefore: 900, tokensAfter: null }]);
	} finally { t.done(); }
});

test("a second compaction gets its own full wait, not the first one's remaining count", async () => {
	const t = setup();
	try {
		const ctx = usageContext(() => null);
		t.recorder.noteCompaction(ctx, { writer: "pi", tokensBefore: 900, tokensAfter: null });
		for (let i = 0; i < MAX_COMPACTION_WAIT_RECORDS - 1; i++) t.recorder.observers.onTurn?.(ctx, turn(500));
		t.recorder.noteCompaction(ctx, { writer: "extension", tokensBefore: 800, tokensAfter: null });
		for (let i = 0; i < MAX_COMPACTION_WAIT_RECORDS - 1; i++) t.recorder.observers.onTurn?.(ctx, turn(500));
		await t.recorder.flush();
		const records = t.read().split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(records.length, 2 * (MAX_COMPACTION_WAIT_RECORDS - 1));
		assert.ok(records.slice(0, -1).every((r) => r.compaction === null), "the second compaction is still waiting");
		assert.deepEqual(records.at(-1)?.compaction, { writer: "extension", tokensBefore: 800, tokensAfter: null }, "the flush writes the last parked record with the compaction still unmeasured");
	} finally { t.done(); }
});

test("every compaction writer kind keeps its own value, and the old values still parse", () => {
	const kinds: CompactionWriterKind[] = ["context-aware", "fabric", "extension", "pi", "malformed", "none"];
	for (const kind of kinds) {
		const record = buildMetricsRecord({ seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, compaction: { writer: kind, tokensBefore: 1, tokensAfter: null } });
		assert.equal(record.compaction?.writer, kind);
	}
	for (const old of ["other", "unknown"]) {
		const record = buildMetricsRecord({ seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, compaction: { writer: old, tokensBefore: 1, tokensAfter: null } });
		assert.equal(record.compaction?.writer, old);
	}
	assert.equal(buildMetricsRecord({ seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, compaction: { writer: "secret text", tokensBefore: 1, tokensAfter: null } }).compaction?.writer, "other");
});

test("structural guard: every CompactionWriterKind is a metrics writer value", () => {
	const all: Record<CompactionWriterKind, true> = { "context-aware": true, fabric: true, extension: true, pi: true, malformed: true, none: true };
	for (const kind of Object.keys(all)) assert.ok((COMPACTION_WRITERS as readonly string[]).includes(kind), kind);
});
