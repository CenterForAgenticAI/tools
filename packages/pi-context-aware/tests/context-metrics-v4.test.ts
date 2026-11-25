import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { applyFoldDrafts, registerFoldEngine, type FoldEngine } from "../src/folds/fold-engine.js";
import { foldAccounting, foldsFreedTokens } from "../src/folds/fold-savings.js";
import { createContextFoldSurface } from "../src/context-tools/context-fold.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS, overrideMetricsWriter, settleMetricsWrites } from "../src/metrics/recorder.js";
import { buildMetricsRecord, compactionTriggerOf, METRICS_RECORD_VERSION, type MetricsInput } from "../src/metrics/records.js";
import { ASSIGNMENT_ENTRY_TYPE } from "../src/strategy-runtime/live/assignment.js";
import { FakeFabric, createHostPi, createSession } from "./compaction-owner-harness.js";

// pi-context-aware#459: metrics record version 4 adds the wording a request got (`steer`), what triggered a
// compaction (`compaction.trigger`) and the tokens the request's written folds freed (`folds.freedTokens`).

const base: MetricsInput = { seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} } };

test("#459: the record version is 4", () => {
	assert.equal(METRICS_RECORD_VERSION, 4);
	assert.equal(buildMetricsRecord(base).v, 4);
});

test("#459: steer is one of a closed list; anything else is other, and a request with none reported is null", () => {
	for (const steer of ["default", "compact-boundary", "fold-first"]) assert.equal(buildMetricsRecord({ ...base, steer }).steer, steer);
	for (const forged of ["turbo", "fold-first\n", "\u001b[2J", "other ", "x".repeat(5000)]) assert.equal(buildMetricsRecord({ ...base, steer: forged }).steer, "other", JSON.stringify(forged.slice(0, 20)));
	assert.equal(buildMetricsRecord({ ...base, steer: 7 as unknown as string }).steer, "other");
	assert.equal(buildMetricsRecord(base).steer, null);
	assert.equal(buildMetricsRecord({ ...base, steer: null }).steer, null);
});

test("#459: compaction.trigger is one of a closed list; anything else, or none, is other", () => {
	const compaction = (trigger?: unknown) => buildMetricsRecord({ ...base, compaction: { writer: "context-aware", tokensBefore: 10, tokensAfter: 2, ...(trigger === undefined ? {} : { trigger: trigger as string }) } }).compaction;
	for (const trigger of ["tool", "proactive", "overflow", "operator", "other"]) assert.equal(compaction(trigger)?.trigger, trigger);
	for (const forged of ["manual", "tool\r\n", "threshold", 3]) assert.equal(compaction(forged)?.trigger, "other", String(forged));
	assert.equal(compaction()?.trigger, "other");
	assert.deepEqual(Object.keys(compaction("tool") ?? {}), ["writer", "trigger", "tokensBefore", "tokensAfter"], "named fields only");
});

test("#459: folds.freedTokens is a non-negative count, 0 when absent or not a number", () => {
	const freed = (value: unknown) => buildMetricsRecord({ ...base, folds: { ...base.folds, freedTokens: value as number } }).folds.freedTokens;
	assert.equal(freed(1234), 1234);
	for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, "9", undefined]) assert.equal(freed(bad), 0, String(bad));
});

test("#459: a compaction's trigger: Pi's overflow wins, then the compaction this extension queued, then Pi's reason", () => {
	const cases: Array<[string | undefined, "tool" | "proactive" | "other" | undefined, string]> = [
		["overflow", "tool", "overflow"],
		["overflow", undefined, "overflow"],
		["manual", "tool", "tool"],
		["manual", "proactive", "proactive"],
		["manual", "other", "other"],
		["threshold", undefined, "proactive"],
		["manual", undefined, "operator"],
		[undefined, undefined, "other"],
		["bogus", undefined, "other"],
	];
	for (const [reason, queued, trigger] of cases) assert.equal(compactionTriggerOf(reason, queued), trigger, `${reason} ${queued}`);
});

test("#459: the tokens folds freed are each written fold's hidden tokens less its new summary's", () => {
	const record = (blockId: string, carrierId: string, compressedTokens: number) => ({
		version: 1, blockId, runId: "r1", tier: 1, carrierId, hiddenIds: ["h1"], range: { startId: carrierId, endId: "h1" }, refs: { start: "", end: "" }, directBlockIds: [], compressedTokens, createdAt: 1, origin: "fold",
	});
	// 40 characters is 10 tokens; 8 characters is 2 (ceil(chars / 4), no CJK).
	const drafts = [
		{ type: "context_edit" as const, targetId: "c1", replacement: { content: "x".repeat(40) } },
		{ type: "context_edit" as const, targetId: "h1", replacement: null },
		{ type: "custom" as const, customType: FOLD_ENTRY_TYPE, data: record("b1", "c1", 500) },
		{ type: "context_edit" as const, targetId: "c2", replacement: { content: [{ type: "text", text: "y".repeat(8) }] } },
		{ type: "custom" as const, customType: FOLD_ENTRY_TYPE, data: record("b2", "c2", 100) },
		// A fold whose summary is longer than what it hid frees nothing, never less.
		{ type: "context_edit" as const, targetId: "c3", replacement: { content: "z".repeat(400) } },
		{ type: "custom" as const, customType: FOLD_ENTRY_TYPE, data: record("b3", "c3", 20) },
		// Not a fold record: ignored.
		{ type: "custom" as const, customType: "other", data: record("b4", "c1", 9999) },
		{ type: "custom" as const, customType: FOLD_ENTRY_TYPE, data: { version: 1, blockId: "forged" } },
	];
	assert.equal(foldsFreedTokens(drafts as never), (500 - 10) + (100 - 2));
	assert.equal(foldsFreedTokens([]), 0);
});

// -- Through the fold engine and the recorder, as src/index.ts wires them --------------------

const LADDER = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
const CONFIG = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const SUMMARY = "Summary: the opening exchange is settled; keep its numbered decision.";
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Written = Record<string, unknown> & { steer: string | null; folds: { accepted: number; freedTokens: number } };

async function wired(options: { readonly modelId?: string; readonly byModel?: boolean; readonly methods?: readonly string[] } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metrics-v4-")));
	const handlers = new Map<string, Handler[]>();
	const api = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, getAllTools: () => [] } as unknown as ExtensionAPI;
	const manager = SessionManager.inMemory(root);
	if (options.byModel) manager.appendCustomEntry(ASSIGNMENT_ENTRY_TYPE, { schemaVersion: 2, guidance: "by-model-v1", seed: "459-test", variants: ["by-model-v1"], drawnFor: "x" });
	manager.appendMessage({ role: "user", content: "Opening. " + "Invented opening detail. ".repeat(40), timestamp: 1 });
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage(fauxAssistantMessage(`Answer ${i}. ` + "Invented answer detail. ".repeat(40)));
		manager.appendMessage({ role: "user", content: `Question ${i}.`, timestamp: 1 });
	}
	const ctx = { sessionManager: manager, cwd: root, model: { id: options.modelId ?? "wiring-model", contextWindow: 100_000 }, getContextUsage: () => ({ tokens: 500 }) } as unknown as ExtensionContext;
	const written: Written[] = [];
	const recorder = registerMetricsRecorder({ agentDir: () => root, settings: () => DEFAULT_METRICS_SETTINGS, write: async (_dir, record) => { written.push(JSON.parse(JSON.stringify(record)) as Written); } });
	const engine: FoldEngine = registerFoldEngine(api, { config: CONFIG, ladder: () => LADDER, metrics: recorder.observers });
	const emit = (name: string, event: unknown): unknown => { let result: unknown; for (const handler of handlers.get(name) ?? []) result = handler(event, ctx); return result; };
	const records = async (): Promise<Written[]> => { await recorder.flush(); return written; };
	return { root, ctx, manager, engine, emit, records, messages: () => manager.buildSessionContext().messages, done: async () => { await recorder.flush(); await removeFixtureDir(root); } };
}

test("#459: a written fold's freed tokens reach the record of the request that asked for it, and match the fold's savings", async () => {
	const w = await wired();
	try {
		w.emit("context", { type: "context", messages: w.messages() });
		assert.ok(w.engine.request(w.ctx, { startRef: "m00001", endRef: "m00004", summary: SUMMARY }).ok);
		// Pi writes the entries the boundary handler returns; this harness writes them the same way.
		const drained = w.emit("turn_end", { type: "turn_end", entries: [] }) as { entries: Parameters<typeof applyFoldDrafts>[1] } | undefined;
		assert.ok(drained, "the boundary writes the fold");
		applyFoldDrafts(w.manager, drained.entries);
		const savings = foldAccounting(w.manager.getBranch()).savings.tokens;
		w.emit("context", { type: "context", messages: w.messages() });
		const [first, second] = await w.records();
		assert.equal(first?.folds.accepted, 1);
		assert.ok(savings > 100, `the fold saves tokens: ${savings}`);
		assert.equal(first?.folds.freedTokens, savings, "the one fold on the branch freed what /context_status reports it saves");
		assert.equal(second?.folds.freedTokens, 0, "counted once");
	} finally { await w.done(); }
});

test("#459: a record names the steer its request got: by-model-v1 on Opus and on GPT, today's text otherwise", async () => {
	const cases: Array<[{ modelId?: string; byModel?: boolean }, string]> = [
		[{ modelId: "claude-opus-5-5", byModel: true }, "compact-boundary"],
		[{ modelId: "openai/gpt-6.1-sol", byModel: true }, "fold-first"],
		[{ modelId: "claude-sonnet-5-5", byModel: true }, "default"],
		[{ modelId: "claude-opus-5-5" }, "default"],
	];
	for (const [setup, steer] of cases) {
		const w = await wired(setup);
		try {
			w.emit("context", { type: "context", messages: w.messages() });
			const [record] = await w.records();
			assert.equal(record?.steer, steer, JSON.stringify(setup));
		} finally { await w.done(); }
	}
});

test("#459: a fold the model makes through fabric_exec counts in folds.accepted and folds.freedTokens", async () => {
	// Fabric runs a captured extension tool by calling its execute with a nested tool call id (`fabric_...`) and a
	// context the runner creates for that call: a new object over the same session (pi-fabric
	// captured-tools-provider.ts, `wrappedTool.execute(toolCallId, args, signal, onUpdate, executionContext)`).
	const w = await wired();
	try {
		const tools = new Map<string, { execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>();
		const surface = createContextFoldSurface({ registerTool: (tool: { name: string }) => { tools.set(tool.name, tool as never); } } as unknown as ExtensionAPI, w.engine);
		surface.apply([{ name: "context_fold", exposure: "codemode" }]);
		w.emit("context", { type: "context", messages: w.messages() });
		const fabricCtx = { ...w.ctx } as ExtensionContext;
		assert.notEqual(fabricCtx, w.ctx, "a context object of its own, as Fabric's runner makes");
		const result = await tools.get("context_fold")!.execute("fabric_0c3f-nested-1", { content: [{ startId: "m00001", endId: "m00004", summary: SUMMARY }] }, undefined, undefined, fabricCtx);
		assert.equal(result.isError, false, result.content[0]?.text);
		const drained = w.emit("turn_end", { type: "turn_end", entries: [] }) as { entries: Parameters<typeof applyFoldDrafts>[1] } | undefined;
		assert.ok(drained, "the boundary writes the fold");
		applyFoldDrafts(w.manager, drained.entries);
		w.emit("context", { type: "context", messages: w.messages() });
		const [record] = await w.records();
		assert.equal(record?.folds.accepted, 1, "the Fabric fold is counted");
		assert.equal(record?.folds.freedTokens, foldAccounting(w.manager.getBranch()).savings.tokens);
		assert.ok((record?.folds.freedTokens ?? 0) > 0);
	} finally { await w.done(); }
});

// -- Through the extension: a compaction's trigger -----------------------------------------

type Record4 = { compaction: { writer: string; trigger: string } | null };

async function extensionCompaction(run: (host: ReturnType<typeof createHostPi>, ctx: ExtensionContext, session: ReturnType<typeof createSession>, fabric: FakeFabric | undefined) => Promise<void>, options: { readonly claim?: boolean } = {}): Promise<Record4[]> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metrics-v4-trigger-")));
	const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	const written: Record4[] = [];
	const restore = overrideMetricsWriter(async (_dir, record) => { written.push(JSON.parse(JSON.stringify(record)) as Record4); });
	try {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(options.claim ? { compactionClaim: { enabled: true } } : {}) }));
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const host = createHostPi();
		// Fabric's side of the compaction-owner claim, when the session holds it.
		const fabric = options.claim ? new FakeFabric(host.bus) : undefined;
		const extension = await import(`../src/index.js?metrics-v4=${Date.now()}-${Math.random()}`);
		extension.default(host.api);
		const session = createSession(root, "metrics-v4-trigger");
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, session.ctx);
		await fabric?.flush();
		await run(host, session.ctx, session, fabric);
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
		await settleMetricsWrites();
		return written;
	} finally {
		restore();
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		await removeFixtureDir(root);
	}
}

const request = async (host: ReturnType<typeof createHostPi>, ctx: ExtensionContext) => {
	await host.handler("context")({ type: "context", messages: [{ role: "user", content: "Work on the migration.", timestamp: 1 }] }, ctx);
};
const compacted = async (host: ReturnType<typeof createHostPi>, ctx: ExtensionContext, reason: string) => {
	await host.handler("session_compact")({ type: "session_compact", compactionEntry: { type: "compaction", id: "c1", tokensBefore: 1000 }, fromExtension: false, reason, willRetry: false }, ctx);
};
const triggers = (records: readonly Record4[]) => records.flatMap((record) => (record.compaction ? [record.compaction.trigger] : []));

test("#459: Pi's overflow compaction is recorded as overflow, and an operator's /compact as operator", async () => {
	assert.deepEqual(triggers(await extensionCompaction(async (host, ctx) => {
		await request(host, ctx);
		await compacted(host, ctx, "overflow");
		await request(host, ctx);
	})), ["overflow"]);
	assert.deepEqual(triggers(await extensionCompaction(async (host, ctx) => {
		await request(host, ctx);
		await compacted(host, ctx, "manual");
		await request(host, ctx);
	})), ["operator"]);
});

test("#459: a compaction the model asked for with context_compact is recorded as tool, though Pi reports it as manual", async () => {
	assert.deepEqual(triggers(await extensionCompaction(async (host, ctx) => {
		await request(host, ctx);
		const tool = host.tools.get("context_compact") as { execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext): Promise<unknown> };
		await tool.execute("call-compact", { seed_prompt: "Continue the migration: the schema step is done; next run the data backfill and check row counts.", rewrite_seed: false }, new AbortController().signal, undefined, ctx);
		await compacted(host, ctx, "manual");
		await request(host, ctx);
		// The queued run is over: a later /compact is the operator's again.
		await compacted(host, ctx, "manual");
		await request(host, ctx);
	})), ["tool", "operator"]);
});

test("CR-FABRIC-OWNER-COMPACT-TRIGGER-OTHER: a compaction the model asks for with Fabric's compact.request is recorded as tool", async () => {
	assert.deepEqual(triggers(await extensionCompaction(async (host, ctx, session, fabric) => {
		await request(host, ctx);
		assert.ok(fabric, "Fabric holds the other end of the claim");
		// A program the model wrote in code mode calls compact.request; Fabric passes it to the claim holder.
		await fabric.call("request", { instructions: "Wrap up the schema phase." }, ctx);
		assert.equal(session.compactions.length, 1, "the request started a compaction");
		await compacted(host, ctx, "manual");
		await request(host, ctx);
		// A later /compact is the operator's.
		await compacted(host, ctx, "manual");
		await request(host, ctx);
	}, { claim: true })), ["tool", "operator"]);
});

test("CR-TRIGGER-FLIGHT-GUARD-UNTESTED: a context_compact run that failed before it committed does not credit a later /compact as tool", async () => {
	assert.deepEqual(triggers(await extensionCompaction(async (host, ctx, session) => {
		await request(host, ctx);
		const tool = host.tools.get("context_compact") as { execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext): Promise<unknown> };
		await tool.execute("call-compact", { seed_prompt: "Continue the migration: the schema step is done; next run the data backfill and check row counts.", rewrite_seed: false }, new AbortController().signal, undefined, ctx);
		// Pi settles the agent run; the queued run then starts.
		await host.handler("agent_settled")({ type: "agent_settled" }, ctx);
		const started = session.compactions.at(-1);
		assert.ok(started?.onError, "the queued context_compact run reached Pi's compact");
		// Pi fails the run: nothing is committed, and no session_compact takes the queued trigger.
		started.onError(new Error("summarizer unavailable"));
		await new Promise((resolve) => setImmediate(resolve));
		await request(host, ctx);
		// The operator's /compact later is the operator's, not the failed run's.
		await compacted(host, ctx, "manual");
		await request(host, ctx);
	})), ["operator"]);
});
