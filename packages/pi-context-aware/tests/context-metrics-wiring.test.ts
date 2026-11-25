import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS } from "../src/metrics/recorder.js";

// pi-context-aware#339: the metrics wiring in src/index.ts. The engine is built with the
// recorder's observers, exactly as index.ts does, and driven through its own events and
// request method. A source assertion keeps index.ts passing the same option.

const LADDER = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
const CONFIG = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const SUMMARY = "Summary: the opening exchange is settled; keep its numbered decision.";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** `shadow`: billion-context-pi's tools hide the fold engine, so no pass runs. `usage`: Pi's count, or none. */
async function wired(withMetrics = true, { shadow = false, usage = 500, window = 1000 }: { shadow?: boolean; usage?: number | null; window?: number } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metrics-wiring-")));
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		// Pi refuses tool lookups while extensions load; the engine stays in shadow mode until they can be read.
		getAllTools: () => { if (shadow) throw new Error("tools are not readable yet"); return []; },
	} as unknown as ExtensionAPI;
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage(fauxAssistantMessage(`Answer ${i}.`));
		manager.appendMessage({ role: "user", content: `Question ${i}.`, timestamp: 1 });
	}
	const ctx = { sessionManager: manager, cwd: root, model: { id: "wiring-model", contextWindow: window }, getContextUsage: () => (usage === null ? undefined : { tokens: usage }) } as unknown as ExtensionContext;
	// An in-memory writer: these tests are about what reaches the recorder, whatever the platform's store allows.
	const written: unknown[] = [];
	const recorder = registerMetricsRecorder({ agentDir: () => root, settings: () => DEFAULT_METRICS_SETTINGS, write: async (_dir, record) => { written.push(JSON.parse(JSON.stringify(record))); } });
	const engine: FoldEngine = registerFoldEngine(api, { config: CONFIG, ladder: () => LADDER, ...(withMetrics ? { metrics: recorder.observers } : {}) });
	const emit = (name: string, event: unknown): unknown => { let result: unknown; for (const handler of handlers.get(name) ?? []) result = handler(event, ctx); return result; };
	const records = async (): Promise<Array<Record<string, unknown> & { folds: { requested: number; accepted: number; dropped: Record<string, number> }; sessionId: string; passFailed: boolean; tokensBefore: number | null }>> => {
		await recorder.flush();
		return written as Awaited<ReturnType<typeof records>>;
	};
	const messages = () => manager.buildSessionContext().messages;
	return { root, ctx, engine, emit, records, messages, done: async () => { await recorder.flush(); await removeFixtureDir(root); } };
}

const request = (endId = "m00004") => ({ startRef: "m00001", endRef: endId, summary: SUMMARY });

test("a live request, drain and turn write one record carrying each hook's fields", async () => {
	const w = await wired();
	try {
		// onRequest: two accepted requests for the same range.
		assert.ok(w.engine.request(w.ctx, request()).ok);
		assert.ok(w.engine.request(w.ctx, request()).ok);
		// onDrain: the boundary writes the first and drops the duplicate.
		w.emit("turn_end", { type: "turn_end", entries: [] });
		// onTurn with a pass result.
		w.emit("context", { type: "context", messages: w.messages() });
		const [record, ...rest] = await w.records();
		assert.equal(rest.length, 0, "one record per live request");
		assert.equal(record?.sessionId, w.ctx.sessionManager.getSessionId());
		assert.equal(record?.passFailed, false, "onTurn with a result");
		assert.equal(typeof record?.tokensBefore, "number", "onTurn reports the token count");
		assert.equal(record?.folds.requested, 2, "onRequest counted both requests");
		assert.equal(record?.folds.accepted, 2);
		assert.equal(Object.values(record?.folds.dropped ?? {}).reduce((a, b) => a + b, 0), 1, "onDrain counted the dropped duplicate");
	} finally { await w.done(); }
});

test("a context pass that fails still writes a record, marked passFailed", async () => {
	const w = await wired();
	try {
		// Pi's 500 of 1000 is WARN, so an action line is due when the pass fails; the fallback must not throw.
		let result: unknown = "not called";
		assert.doesNotThrow(() => { result = w.emit("context", { type: "context", messages: undefined }); });
		assert.equal(result, undefined, "a request the fallback cannot render goes as Pi built it");
		assert.equal(w.engine.injection(w.ctx), undefined, "nothing was injected");
		const [record] = await w.records();
		assert.equal(record?.passFailed, true, "onTurn(undefined) reached the recorder");
		assert.equal(record?.tokensBefore, null);
		assert.equal(record?.band, "warn", "Pi's usage counted the request");
	} finally { await w.done(); }
});

test("a failed pass with no Pi usage still writes a record, marked passFailed", async () => {
	const w = await wired(true, { usage: null });
	try {
		assert.equal(w.emit("context", { type: "context", messages: undefined }), undefined);
		const records = await w.records();
		assert.equal(records.length, 1, "nothing counted the request, and it is still recorded");
		assert.equal(records[0]?.passFailed, true);
		assert.equal(records[0]?.pressure, null);
		assert.equal(records[0]?.band, null);
	} finally { await w.done(); }
});

test("a shadow-mode request writes a record that is not a failed pass", async () => {
	const w = await wired(true, { shadow: true });
	try {
		assert.equal(w.engine.mode(w.ctx), "shadow");
		w.emit("context", { type: "context", messages: w.messages() });
		w.emit("context", { type: "context", messages: w.messages() });
		const records = await w.records();
		assert.equal(records.length, 2, "one record per request");
		assert.deepEqual(records.map((record) => record.passFailed), [false, false], "no pass ran, so none failed");
		assert.deepEqual(records.map((record) => record.pressure), [0.5, 0.5], "Pi's usage counted each request");
	} finally { await w.done(); }
});

type StrategyFields = { strategy: unknown; stages: Array<{ trigger: string; recipe: string; role: string; stage: string; outcome: string; codes: string[] }> };

test("#473: a shadow-mode request's record names the methods and the stage outcomes of that request, not the next one's", async () => {
	const w = await wired(true, { shadow: true });
	try {
		// Pi's 500 of 1000 is WARN: the recipe's pressure-note stage says the action line on each request.
		w.emit("context", { type: "context", messages: w.messages() });
		const records = (await w.records()) as unknown as StrategyFields[];
		assert.equal(records.length, 1);
		assert.deepEqual(records[0]!.strategy, { methods: ["compact"], source: "auto", shadow: [], guidance: "default" });
		assert.deepEqual(records[0]!.stages, [{ trigger: "request", recipe: "compact", role: "active", stage: "pressure-note", outcome: "applied", codes: [] }]);
	} finally { await w.done(); }
});

test("#473: a live request's record carries its own stage outcomes, and a compaction asked for after it lands in the same record", async () => {
	const w = await wired(true, { window: 120 });
	try {
		w.emit("context", { type: "context", messages: w.messages() });
		const answer = w.engine.compaction(w.ctx, { writer: "main" });
		w.emit("context", { type: "context", messages: w.messages() });
		const records = (await w.records()) as unknown as StrategyFields[];
		assert.equal(records.length, 2);
		assert.deepEqual(records[0]!.strategy, { methods: ["fold", "compact"], source: "auto", shadow: [], guidance: "default" });
		const first = records[0]!.stages.filter((stage) => stage.trigger === "request");
		assert.ok(first.some((stage) => stage.stage === "pressure-note" && stage.outcome === "applied"), JSON.stringify(records[0]!.stages));
		assert.equal(answer, "accepted");
		assert.deepEqual(records[0]!.stages.filter((stage) => stage.trigger === "compaction"), [{ trigger: "compaction", recipe: "fold+compact", role: "active", stage: "seeded-compaction", outcome: "applied", codes: [] }]);
		assert.deepEqual(records[1]!.stages.filter((stage) => stage.trigger === "compaction"), [], "the compaction is counted once");
	} finally { await w.done(); }
});

test("without the metrics option no record is written (control)", async () => {
	const w = await wired(false);
	try {
		w.engine.request(w.ctx, request());
		w.emit("turn_end", { type: "turn_end", entries: [] });
		w.emit("context", { type: "context", messages: w.messages() });
		assert.deepEqual(await w.records(), []);
	} finally { await w.done(); }
});

test("src/index.ts hands the recorder's observers to the fold engine", () => {
	const source = fs.readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /const metricsRecorder = registerMetricsRecorder\(/u);
	assert.match(source, /registerFoldEngine\(pi, \{[^]*?metrics: metricsRecorder\.observers,[^]*?\}\);/u);
	assert.match(source, /createContextRecallSurface\(pi, \{[^]*?onRefRecall: \(ctx, kind\) => metricsRecorder\.noteRecall\(ctx, kind\),[^]*?\}\);/u, "a recall by reference reaches the recorder (pi-context-aware#473)");
});
