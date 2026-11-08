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
import { metricsSessionFile } from "../src/metrics/records.js";

// pi-context-aware#339: the metrics wiring in src/index.ts. The engine is built with the
// recorder's observers, exactly as index.ts does, and driven through its own events and
// request method. A source assertion keeps index.ts passing the same option.

const LADDER = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
const CONFIG = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const SUMMARY = "Summary: the opening exchange is settled; keep its numbered decision.";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function wired(withMetrics = true) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metrics-wiring-")));
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage(fauxAssistantMessage(`Answer ${i}.`));
		manager.appendMessage({ role: "user", content: `Question ${i}.`, timestamp: 1 });
	}
	const ctx = { sessionManager: manager, cwd: root, model: { id: "wiring-model", contextWindow: 1000 }, getContextUsage: () => ({ tokens: 500 }) } as unknown as ExtensionContext;
	const recorder = registerMetricsRecorder({ agentDir: () => root, settings: () => DEFAULT_METRICS_SETTINGS, ladder: () => LADDER });
	const engine: FoldEngine = registerFoldEngine(api, { config: CONFIG, ...(withMetrics ? { metrics: recorder.observers } : {}) });
	const emit = (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
	const records = async (): Promise<Array<Record<string, unknown> & { folds: { requested: number; accepted: number; dropped: Record<string, number> }; sessionId: string; passFailed: boolean; tokensBefore: number | null }>> => {
		await recorder.flush();
		const file = metricsSessionFile(root, manager.getSessionId());
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
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
		w.emit("context", { type: "context", messages: undefined });
		const [record] = await w.records();
		assert.equal(record?.passFailed, true, "onTurn(undefined) reached the recorder");
		assert.equal(record?.tokensBefore, null);
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
});
