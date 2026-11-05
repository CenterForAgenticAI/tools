import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS, type MetricsSettings } from "../src/metrics/recorder.js";
import { metricsSessionFile } from "../src/metrics/records.js";
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
		t.recorder.observers.onRequest?.(ctx, { ok: true, mode: "live", queued: true, blockIds: ["b1"], warnings: [CANARY] });
		t.recorder.observers.onRequest?.(ctx, refused);
		t.recorder.observers.onDrain?.(ctx, [{ startRef: "m1", endRef: "m2", errors: [CANARY], code: "branch-changed" }]);
		t.recorder.noteCompaction(ctx, { writer: "context-aware", tokensBefore: 900, tokensAfter: 300 });
		t.recorder.observers.onTurn?.(ctx, turn(500, { nudge: CANARY, nudgeKind: "tier2", emergency: { usage: 1, threshold: 0.95, tokenCount: 1, limit: 1, truncated: 3, hideCandidates: ["e1", "e2"], announce: [] } }));
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
			folds: { requested: 2, accepted: 1, refused: { "unknown-ref": 1 }, dropped: { "branch-changed": 1 }, tiers: [] },
			compaction: { writer: "context-aware", tokensBefore: 900, tokensAfter: 300 },
			usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
		});
		assert.equal(records[1].seq, 2);
		assert.equal(records[1].passFailed, true);
		assert.deepEqual(records[1].folds, { requested: 0, accepted: 0, refused: {}, dropped: {}, tiers: [] }, "counts reset after each record");
		assert.equal(records[1].compaction, null);
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
