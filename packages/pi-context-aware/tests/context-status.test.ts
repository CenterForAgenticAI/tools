import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";

import { planFold } from "../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../src/folds/fold-engine.js";
import { FOLD_ENTRY_TYPE, foldRecordsOnBranch } from "../src/folds/fold-entries.js";
import { createContextStatusSurface, contextStatusSchema, type ContextStatusHost } from "../src/context-tools/context-status.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import type { SessionStrategy } from "../src/folds/engine-resolver.js";
import { DEFAULT_METHODS, toMethodSet } from "../src/strategy/methods.js";
import { SKILL_REGISTRY_ENTRY_TYPE, sha256 } from "../src/skills/skill-registry.js";
import { createHostPi, createSession, type FakeHostPi } from "./compaction-owner-harness.js";

// pi-context-aware#194 (cut-over checklist row 2 on pi-context-aware#137): context_status is registered with its
// four views (skills added by pi-context-aware#181), and none of its old names (session_compaction_history, acp_status) registers. Expected values come from the session built here, not from the tool.

/** The fields the tests read from a result's details; each view fills its own. */
interface StatusDetails {
	measured?: boolean; tokens?: number; fraction?: number; stage?: string; thresholds?: unknown;
	entriesSinceCompaction?: number; entryLimit?: number; entryLimitReached?: boolean;
	available?: boolean; count?: number; compactions: { id: string; writer?: unknown }[] & { available?: boolean; writer?: unknown };
	writer?: unknown;
	mode?: string; engine?: string; pending?: number; activeCount?: number;
	strategy: { methods: string[]; source: string; shadow: string[][]; guidance: string; errors: string[]; stages: Record<string, number>; assignment?: { seed: string; variants: string[]; drawnFor: string; recorded: boolean } };
	dropped: { startRef: string; endRef: string; errors: string[] }[];
	active: { blockId: string; topic: string }[];
	pressure: { stage: string }; folds: { mode: string };
	savings?: { tokens: number; originalTokens: number; summaryTokens: number; activeFolds: number };
	preprocessing?: { outputTokens: number; calls: number; callsWithoutUsage: number };
	recovery?: { recalls: number; tokens: number };
}

interface StatusTool {
	name: string;
	exposure?: string;
	parameters: unknown;
	annotations?: { readOnlyHint?: boolean };
	execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext): Promise<{ content: { text: string }[]; details: StatusDetails; isError?: boolean }>;
}

const LADDER = { foldNudgeStartFraction: 0.4, foldNudgeEndFraction: 0.7, seededCompactionFraction: 0.85, recoverableHideFraction: 0.97 };
const big = (label: string) => label + " " + "Archived synthetic discussion that is long enough to fold. ".repeat(40);
const CONFIG = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 0, preserveRecentTokens: 0 };
const SUMMARY = "Summary: the archived exchange is settled; keep the numbered decision and continue with the review.";

function foldedSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
	for (const name of ["A", "B", "C"]) {
		manager.appendMessage({ role: "user", content: big(name + "-question"), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(big(name + "-answer")));
	}
	const plan = planFold({ branch: manager.getBranch(), startRef: "m00002", endRef: "m00003", summary: SUMMARY, topic: "Archive plan", modelContextLimit: 200_000, config: CONFIG });
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
	return manager;
}

const COMPACT = toMethodSet(["compact"])!;
/** A session strategy with the defaults filled in. */
const strategyOf = (over: Partial<SessionStrategy>): SessionStrategy => ({ methods: DEFAULT_METHODS, source: "auto", shadow: [], guidance: "default", contradictsPresence: false, errors: [], ...over });

interface Setup {
	readonly host: FakeHostPi;
	readonly ctx: ExtensionContext;
	readonly manager: SessionManager;
	tool(name: string): StatusTool;
}

function setUp(options: { tokens: number | null; mode?: "live" | "shadow"; pending?: number; bcp?: boolean; contradicts?: boolean; manager?: SessionManager; entries?: ContextStatusHost["entries"]; strategy?: SessionStrategy; stages?: Record<string, number> }): Setup {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-context-status-")));
	const host = createHostPi();
	const manager = options.manager ?? foldedSession();
	const session = createSession(root, "context-status-session");
	const ctx = Object.assign(session.ctx, {
		getContextUsage: () => ({ tokens: options.tokens, contextWindow: 200_000 }),
		sessionManager: Object.assign(Object.create(manager), { getBranch: () => manager.getBranch() }),
	}) as ExtensionContext;
	const engine: ContextStatusHost["engine"] = {
		mode: () => options.mode ?? "live",
		engine: () => ({
			engine: (options.mode ?? "live") === "live" ? "folds" : "compaction-only",
			contradictsPresence: options.contradicts ?? false,
			strategy: options.strategy ?? strategyOf({ methods: (options.mode ?? "live") === "live" ? DEFAULT_METHODS : COMPACT, source: options.contradicts ? "folds.engine" : "auto", contradictsPresence: options.contradicts ?? false }),
		}),
		pending: () => options.pending ?? 0,
		strategy: () => ({ last: [], counts: options.stages ?? {} }),
		dropped: () => [{ startRef: "m00090", endRef: "m00091", errors: ["Range is too small to fold."], code: undefined as never }],
	};
	const surface = createContextStatusSurface(host.api, { engine, usage: (c) => { const u = c.getContextUsage(); return u?.tokens == null ? { tokens: 0, window: 200_000, fraction: 0, headroom: 200_000, unmeasured: true } : { tokens: u.tokens, window: 200_000, fraction: u.tokens / 200_000, headroom: 200_000 - u.tokens }; }, ladder: () => LADDER, ...(options.entries ? { entries: options.entries } : {}) });
	const tools = options.bcp
		? [{ name: "compress", sourceInfo: { path: "/opt/billion-context-pi/index.ts" } }, { name: "acp_status", sourceInfo: { path: "/opt/billion-context-pi/index.ts" } }]
		: [{ name: "read", sourceInfo: { path: "builtin:read" } }];
	surface.apply(decideContextToolSurface(tools, undefined));
	return { host, ctx, manager, tool: (name) => host.tools.get(name) as StatusTool };
}

const call = (s: Setup, name: string, params: Record<string, unknown> = {}) => s.tool(name).execute("call", params, new AbortController().signal, undefined, s.ctx);

test("#194: context_status is registered, direct and read-only, with a view argument", () => {
	const s = setUp({ tokens: 100_000 });
	const tool = s.tool("context_status");
	assert.equal(tool?.name, "context_status", "a registerTool call exists for context_status");
	assert.equal(tool.exposure, "direct");
	assert.equal(tool.annotations?.readOnlyHint, true, "the tool declares that it does not modify its environment");
	const validator = compile(contextStatusSchema);
	assert.equal(validator.check({ view: "pressure" }), true);
	assert.equal(validator.check({}), true, "view is optional");
	assert.equal(validator.check({ view: "cache" }), false, "cache numbers are not a model view");
});

test("#194: the pressure view reports the measured size and the ladder stage from the configured ladder", async () => {
	// 150,000 of 200,000 is 75%: above the configured foldNudgeEnd (70%) and below seededCompaction (85%).
	const result = await call(setUp({ tokens: 150_000 }), "context_status", { view: "pressure" });
	assert.equal(result.details.measured, true);
	assert.equal(result.details.tokens, 150_000);
	assert.equal(result.details.fraction, 0.75);
	assert.equal(result.details.stage, "approaching-compaction");
	assert.deepEqual(result.details.thresholds, LADDER);
	assert.match(result.content[0]!.text, /150000 of 200000 tokens \(75%\)/u);
	assert.match(result.content[0]!.text, /Ladder stage: approaching-compaction\./u);
	// Another size, another stage: the stage follows the size.
	assert.equal((await call(setUp({ tokens: 20_000 }), "context_status", { view: "pressure" })).details.stage, "below-ladder");
	assert.equal((await call(setUp({ tokens: 195_000 }), "context_status", { view: "pressure" })).details.stage, "recoverable-hide");
});

test("#194: an unmeasured size is reported as unknown, never as an empty context", async () => {
	const result = await call(setUp({ tokens: null }), "context_status", { view: "pressure" });
	assert.equal(result.details.measured, false);
	assert.equal(result.details.stage, "unknown");
	assert.equal("tokens" in result.details, false);
	assert.match(result.content[0]!.text, /Context size: unknown/u);
});

test("#441: the pressure view reports entries since the last compaction and when their limit is reached", async () => {
	const under = await call(setUp({ tokens: 10_000, entries: () => ({ entriesSinceCompaction: 1_200, limit: 30_000, exceeded: false }) }), "context_status", { view: "pressure" });
	assert.equal(under.details.entriesSinceCompaction, 1_200);
	assert.equal(under.details.entryLimit, 30_000);
	assert.equal(under.details.entryLimitReached, false);
	assert.match(under.content[0]!.text, /Entries since the last compaction: 1200 of a limit of 30000./u);
	assert.doesNotMatch(under.content[0]!.text, /limit is reached/u);
	const over = await call(setUp({ tokens: 10_000, entries: () => ({ entriesSinceCompaction: 31_000, limit: 30_000, exceeded: true }) }), "context_status", { view: "pressure" });
	assert.equal(over.details.entryLimitReached, true);
	assert.match(over.content[0]!.text, /31000 of a limit of 30000. The limit is reached: compact now, whatever the token usage./u);
	const off = await call(setUp({ tokens: 10_000, entries: () => null }), "context_status", { view: "pressure" });
	assert.equal("entriesSinceCompaction" in off.details, false, "a disabled check reports no count");
});

test("#528: a session without compact at the entry limit is told it compacts on its own, not to compact now", async () => {
	const reached: ContextStatusHost["entries"] = () => ({ entriesSinceCompaction: 31_000, limit: 30_000, exceeded: true });
	const foldOnly = setUp({ tokens: 10_000, entries: reached, strategy: strategyOf({ methods: toMethodSet(["fold"])!, source: "strategy.methods" }) });
	const pressure = await call(foldOnly, "context_status", { view: "pressure" });
	assert.equal(pressure.details.entryLimitReached, true);
	assert.match(pressure.content[0]!.text, /31000 of a limit of 30000. The limit is reached: this session compacts on its own at the limit, whatever the token usage./u);
	assert.doesNotMatch(pressure.content[0]!.text, /compact now|context_compact/u);
	const all = await call(foldOnly, "context_status");
	assert.doesNotMatch(all.content[0]!.text, /compact now|context_compact/u, "no view of a fold-only session names the refused tool");
	const both = await call(setUp({ tokens: 10_000, entries: reached }), "context_status", { view: "pressure" });
	assert.match(both.content[0]!.text, /The limit is reached: compact now, whatever the token usage./u, "a session with compact is still told to compact");
});

test("#529: the folds view blames billion-context-pi only when the auto rule left fold out for it", async () => {
	for (const source of ["strategy.methods", "folds.engine"] as const) {
		const result = await call(setUp({ tokens: 100_000, mode: "shadow", strategy: strategyOf({ methods: COMPACT, source }) }), "context_status", { view: "folds" });
		assert.match(result.content[0]!.text, new RegExp("^Fold engine: shadow \\(this session's methods leave out fold, from " + source.replace(".", "\\.") + "; nothing is written here\\)\\.$", "mu"), source);
		assert.doesNotMatch(result.content[0]!.text, /billion-context-pi/u, source);
	}
	const loaded = await call(setUp({ tokens: 100_000, mode: "shadow", bcp: true }), "context_status", { view: "folds" });
	assert.match(loaded.content[0]!.text, /^Fold engine: shadow \(billion-context-pi owns folding; nothing is written here\)\.$/mu);
});

test("#194: the compactions view lists the branch's boundaries and nothing else", async () => {
	const s = setUp({ tokens: 100_000 });
	const branch = [
		{ type: "compaction", id: "c1", firstKeptEntryId: "k1", details: { summary: "private-summary" } },
		{ type: "compaction", id: "c2", firstKeptEntryId: "k2" },
	];
	(s.ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => branch;
	const result = await call(s, "context_status", { view: "compactions" });
	assert.equal(result.details.available, true);
	assert.equal(result.details.count, 2);
	assert.deepEqual(result.details.compactions.map((entry: { id: string }) => entry.id), ["c1", "c2"]);
	assert.match(result.content[0]!.text, /2 compactions/u);
	assert.doesNotMatch(JSON.stringify(result), /private-summary/u);
	(s.ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => { throw new Error("branch unavailable: secret"); };
	const failed = await call(s, "context_status", { view: "compactions" });
	assert.equal(failed.isError, true);
	assert.deepEqual(failed.details, { available: false, count: 0, compactions: [] });
	assert.doesNotMatch(JSON.stringify(failed), /secret/u);
});

test("#283: the compactions view names the newest committed writer in its text and details", async () => {
	const s = setUp({ tokens: 100_000 });
	// An older summary from Pi itself, then a newer one from a named extension: the newest is reported.
	const branch = [
		{ type: "compaction", id: "c1", firstKeptEntryId: "k1", fromHook: false },
		{ type: "message", id: "m1" },
		{ type: "compaction", id: "c2", firstKeptEntryId: "k2", fromHook: true, details: { compactor: "@acme/pi-compactor" } },
	];
	(s.ctx.sessionManager as unknown as { getBranch: () => unknown[] }).getBranch = () => branch;
	const named = { kind: "extension", name: "@acme/pi-compactor" };

	const result = await call(s, "context_status", { view: "compactions" });
	assert.match(result.content[0]!.text, /^Last committed compaction writer: @acme\/pi-compactor$/mu);
	assert.deepEqual(result.details.writer, named);
	// Each boundary carries its own writer.
	assert.deepEqual(result.details.compactions.map((entry) => entry.writer), [{ kind: "pi", name: "Pi's own summarizer" }, named]);

	// The all-views call carries the same line and field.
	const all = await call(s, "context_status");
	assert.match(all.content[0]!.text, /^Last committed compaction writer: @acme\/pi-compactor$/mu);
	assert.deepEqual(all.details.compactions.writer, named);
});

test("#283: with no committed compaction the compactions view reports writer none and names no writer", async () => {
	const s = setUp({ tokens: 100_000 });
	assert.equal(s.manager.getBranch().some((entry) => entry.type === "compaction"), false, "the fixture has no compaction");
	const result = await call(s, "context_status", { view: "compactions" });
	assert.match(result.content[0]!.text, /^Last committed compaction writer: none$/mu);
	assert.deepEqual(result.details.writer, { kind: "none", name: "none" });
	assert.doesNotMatch(result.content[0]!.text, /Fabric|another extension|Pi's own summarizer|pi-context-aware/u);
});

test("#194: the folds view reports the engine's mode, pending and dropped requests, and the active folds", async () => {
	const s = setUp({ tokens: 100_000, pending: 2 });
	const folds = foldedSession();
	assert.equal(folds.getBranch().some((entry) => entry.type === "custom"), true, "the fixture folded one range");
	const result = await call(s, "context_status", { view: "folds" });
	assert.equal(result.details.mode, "live");
	assert.equal(result.details.pending, 2);
	assert.equal(result.details.dropped.length, 1);
	assert.deepEqual(result.details.dropped[0], { startRef: "m00090", endRef: "m00091", errors: ["Range is too small to fold."] });
	assert.equal(result.details.activeCount, 1);
	assert.equal(result.details.active[0].blockId, "b1");
	assert.equal(result.details.active[0].topic, "Archive plan");
	assert.match(result.content[0]!.text, /Pending fold requests: 2\./u);
	assert.match(result.content[0]!.text, /b1 \(tier 1\): Archive plan/u);
	const shadow = await call(setUp({ tokens: 100_000, mode: "shadow" }), "context_status", { view: "folds" });
	assert.equal(shadow.details.mode, "shadow");
	assert.match(shadow.content[0]!.text, /shadow \(billion-context-pi owns folding/u);
	assert.equal(shadow.details.engine, "compaction-only");
	assert.match(shadow.content[0]!.text, /^Engine: compaction-only\./mu);
	assert.doesNotMatch(shadow.content[0]!.text, /Warning: folds\.engine/u);
	const live = await call(setUp({ tokens: 100_000 }), "context_status", { view: "folds" });
	assert.equal(live.details.engine, "folds");
	assert.match(live.content[0]!.text, /^Engine: folds\./mu);
});

test("#526: the folds view names the session's methods, where they came from, its guidance and its shadow lists", async () => {
	const result = await call(setUp({ tokens: 100_000, strategy: strategyOf({ methods: COMPACT, source: "folds.engine", shadow: [DEFAULT_METHODS] }) }), "context_status", { view: "folds" });
	assert.match(result.content[0]!.text, /^Methods: compact \(from folds\.engine\)\.$/mu);
	assert.match(result.content[0]!.text, /^Guidance: default\.$/mu);
	assert.match(result.content[0]!.text, /^Shadow: fold, compact\.$/mu);
	assert.doesNotMatch(result.content[0]!.text, /^Recipe:/mu, "no recipe line");
	assert.deepEqual(result.details.strategy, { methods: ["compact"], source: "folds.engine", shadow: [["fold", "compact"]], guidance: "default", errors: [], stages: {} });
	const plain = await call(setUp({ tokens: 100_000 }), "context_status", { view: "folds" });
	assert.match(plain.content[0]!.text, /^Methods: fold, compact \(the default\)\.$/mu);
	assert.match(plain.content[0]!.text, /^Shadow: none\.$/mu);
	const loaded = await call(setUp({ tokens: 100_000, mode: "shadow" }), "context_status", { view: "folds" });
	assert.match(loaded.content[0]!.text, /^Methods: compact \(billion-context-pi is loaded\)\.$/mu);
	const listed = await call(setUp({ tokens: 100_000, strategy: strategyOf({ methods: toMethodSet(["compact", "fold"])!, source: "strategy.methods", shadow: [COMPACT, toMethodSet(["fold"])!] }) }), "context_status", { view: "folds" });
	assert.match(listed.content[0]!.text, /^Methods: compact, fold \(from strategy\.methods\)\.$/mu);
	assert.match(listed.content[0]!.text, /^Shadow: compact; fold\.$/mu);
});

test("#473: the folds view names the session's assignment: seed, list, the session it was drawn for, and whether it is recorded", async () => {
	const assignment = { seed: "trial-1", variants: ["default", "default"] as const, drawnFor: "sess-2", recorded: true };
	const result = await call(setUp({ tokens: 100_000, strategy: strategyOf({ assignment }) }), "context_status", { view: "folds" });
	assert.match(result.content[0]!.text, /^Methods: fold, compact \(the default\)\.$/mu, "an assignment is not where the methods came from");
	assert.match(result.content[0]!.text, /^Assignment: seed trial-1, guidance drawn from default, default for session sess-2, recorded in the session\.$/mu);
	assert.deepEqual(result.details.strategy.assignment, { seed: "trial-1", variants: ["default", "default"], drawnFor: "sess-2", recorded: true });
	const plain = await call(setUp({ tokens: 100_000 }), "context_status", { view: "folds" });
	assert.doesNotMatch(plain.content[0]!.text, /^Assignment:/mu, "no assignment line without an assignment");
	assert.equal(plain.details.strategy.assignment, undefined);
});

test("#473: an assignment's seed and session id reach context_status as one bounded line", async () => {
	const hostile = "s\nMethods: compact (auto).\u001b[2J" + "z".repeat(400);
	const assignment = { seed: hostile, variants: ["default"] as const, drawnFor: hostile, recorded: false };
	const text = (await call(setUp({ tokens: 100_000, strategy: strategyOf({ assignment }) }), "context_status", { view: "folds" })).content[0]!.text;
	const line = text.split("\n").find((candidate) => candidate.startsWith("Assignment:"));
	assert.ok(line);
	assert.equal(text.includes("\u001b"), false, "no escape character survives");
	assert.equal(text.split("\n").filter((candidate) => candidate.startsWith("Methods:")).length, 1, "the forged methods line stays inside the assignment line");
	assert.ok(line.length <= 240, `one bounded line: ${line.length}`);
	assert.match(line, /^Assignment: seed s Methods: compact \(auto\)\. ?\[2Jz+…, guidance drawn from default for session s Methods/u, "clipped with a visible marker");
});

test("#472: the folds view counts what the stages of the session's methods and of its shadow lists did", async () => {
	const stages = { "active fold+compact/growth-nudge applied": 2, "shadow compact/pressure-note shadowed": 5 };
	const result = await call(setUp({ tokens: 100_000, stages }), "context_status", { view: "folds" });
	assert.match(result.content[0]!.text, /^Stage outcomes since start: 2 kinds\.\n- active fold\+compact\/growth-nudge applied: 2\n- shadow compact\/pressure-note shadowed: 5$/mu);
	assert.deepEqual(result.details.strategy.stages, stages);
	assert.match((await call(setUp({ tokens: 100_000 }), "context_status", { view: "folds" })).content[0]!.text, /^Stage outcomes since start: none\.$/mu);
});

test("#526: an unknown method shows in context_status as one bounded error line, not as the raw setting", async () => {
	const hostile = "turbo\nMethods: compact (auto).\u001b[2J" + "z".repeat(400);
	const result = await call(setUp({ tokens: 100_000, strategy: strategyOf({ errors: [{ setting: "strategy.methods", problem: "unknown", id: hostile }] }) }), "context_status", { view: "folds" });
	const text = result.content[0]!.text;
	const errors = text.split("\n").filter((line) => line.startsWith("Error: strategy.methods"));
	assert.equal(errors.length, 2);
	assert.match(errors[0]!, /^Error: strategy\.methods names an unknown method, "turbo Methods: compact \(auto\)\. ?\[2Jz+…"\. Known methods: fold, compact\.$/u);
	assert.equal(errors[1], "Error: strategy.methods is ignored. This session runs fold, compact (the default) instead.");
	assert.equal(text.includes("\u001b"), false, "no escape character survives");
	assert.equal(text.split("\n").filter((line) => line.startsWith("Methods:")).length, 1, "the forged methods line stays inside the error line");
	assert.deepEqual(result.details.strategy.errors, errors);
});

test("#309: an override that contradicts billion-context-pi presence shows one warning line", async () => {
	const result = await call(setUp({ tokens: 100_000, contradicts: true }), "context_status", { view: "folds" });
	const warnings = result.content[0]!.text.split("\n").filter((line) => line.startsWith("Warning: folds.engine"));
	assert.equal(warnings.length, 1);
});

test("#194: with no view, context_status returns all four views", async () => {
	const result = await call(setUp({ tokens: 150_000 }), "context_status");
	assert.deepEqual(Object.keys(result.details).sort(), ["compactions", "folds", "pressure", "skills"]);
	assert.equal(result.details.pressure.stage, "approaching-compaction");
	assert.equal(result.details.folds.mode, "live");
	assert.equal(result.details.compactions.available, true);
});

test("#194: neither old status name registers, with or without billion-context-pi", () => {
	for (const bcp of [false, true]) {
		const s = setUp({ tokens: 100_000, bcp });
		assert.equal(s.host.tools.has("acp_status"), false);
		assert.equal(s.host.tools.has("session_compaction_history"), false);
		assert.equal(s.host.tools.has("context_status"), true);
	}
});

test("#194: through the real extension, session_start registers context_status and it answers", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-status-wiring-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false } }));
	try {
		const host = createHostPi();
		const extension = await import(`../src/index.js?context-status-wiring=${Date.now()}`);
		extension.default(host.api);
		assert.equal(host.tools.has("context_status"), false, "the names wait for the session_start surface decision");
		const session = createSession(root, "context-status-wiring");
		await host.handler("session_start")({ reason: "startup" }, session.ctx);
		const status = host.tools.get("context_status") as StatusTool | undefined;
		assert.ok(status, "context_status is registered by the extension");
		assert.equal(status.exposure, "direct");
		assert.equal(host.tools.has("session_compaction_history"), false);
		const pressure = await status.execute("c", { view: "pressure" }, new AbortController().signal, undefined, session.ctx);
		// The fake session reports 150,000 of 200,000 tokens, 75%, against the default ladder (45/75/90/95).
		assert.equal(pressure.details.fraction, 0.75);
		assert.equal(pressure.details.stage, "approaching-compaction");
		const folds = await status.execute("c", { view: "folds" }, new AbortController().signal, undefined, session.ctx);
		assert.equal(folds.details.pending, 0);
		assert.equal(folds.details.activeCount, 0);
		await host.handler("session_shutdown")({}, session.ctx);
	} finally {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await removeFixtureDir(root);
	}
});

test("#194: acp_cache gets no alias; cache numbers are a user command", () => {
	const s = setUp({ tokens: 100_000 });
	assert.equal(s.host.tools.has("acp_cache"), false);
});

const SKILL_BODY_MARKER = "SKILL-BODY-SECRET-5d2";

/** Record one full, visible load of a skill the way load_skill does: call, result, registry entry. */
function loadSkillInto(manager: SessionManager, id: string, name: string, skillPath: string): { text: string } {
	const text = "Loaded skill " + name + "\n" + SKILL_BODY_MARKER;
	manager.appendMessage(fauxAssistantMessage([fauxToolCall("load_skill", { name }, { id })], { stopReason: "toolUse", timestamp: 1 }));
	manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "load_skill", content: [{ type: "text", text }], isError: false, timestamp: 1 });
	manager.appendCustomEntry(SKILL_REGISTRY_ENTRY_TYPE, {
		version: 1, name, path: skillPath, bodyHash: sha256(SKILL_BODY_MARKER), resultHash: sha256(text), bytes: 1234,
		toolCallId: id, delivery: "full", loadedAt: "2026-10-20T00:00:00.000Z",
	});
	return { text };
}

test("#181: context_status lists a loaded skill with name, state, size and ref, and no skill text", async () => {
	const s = setUp({ tokens: 100_000 });
	loadSkillInto(s.manager, "skill-call-1", "glab", "/skills/glab/SKILL.md");
	for (const name of ["context_status"]) {
		const all = await call(s, name);
		const view = await call(s, name, { view: "skills" });
		const line = /glab: visible at (m\d+), 1,234 bytes/u.exec(view.content[0]!.text);
		assert.ok(line, name + " lists the skill: " + view.content[0]!.text);
		assert.match(all.content[0]!.text, /== skills ==\nLoaded skills \(1\):/u);
		const skill = (view.details as unknown as { skills: { name: string; state: string; bytes: number; ref?: string }[] }).skills[0]!;
		assert.deepEqual({ name: skill.name, state: skill.state, bytes: skill.bytes, ref: skill.ref }, { name: "glab", state: "visible", bytes: 1234, ref: line[1] });
		assert.doesNotMatch(JSON.stringify(all), new RegExp(SKILL_BODY_MARKER, "u"));
		assert.doesNotMatch(JSON.stringify(view), /\/skills\/glab/u, "the path is not part of the output");
	}
});

/** Usage as Pi records it on an assistant message; only `output` matters to the folds view. */
const usageWith = (output: number) => ({ input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/**
 * A session with one fold, its call and two recalls, built entry by entry so every number is a known literal:
 * the fold hid 2,000 recorded tokens behind a 400-character summary (100 tokens), its call cost 3,762 output
 * tokens, and one successful recall of b1 returned 800 characters (200 tokens). A failed recall and a hide
 * recall are not recovery of folded content.
 */
function measuredFoldSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
	const carrier = manager.appendMessage({ role: "user", content: big("A-question"), timestamp: 1 });
	const hidden = manager.appendMessage(fauxAssistantMessage(big("A-answer")));
	manager.appendMessage({ role: "user", content: "FOLD", timestamp: 1 });
	manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("context_fold", { content: [] } as never, { id: "fold-call-1" }), { stopReason: "toolUse" }), usage: usageWith(3762) });
	manager.appendMessage({ role: "toolResult", toolCallId: "fold-call-1", toolName: "context_fold", content: [{ type: "text", text: "Fold queued." }], isError: false, timestamp: 1 });
	manager.appendContextEdit(carrier, { content: "S".repeat(400) });
	manager.appendContextEdit(hidden, null);
	manager.appendCustomEntry(FOLD_ENTRY_TYPE, { version: 1, blockId: "b1", runId: "r1", tier: 1, topic: "Archive plan", carrierId: carrier, hiddenIds: [hidden], range: { startId: carrier, endId: hidden }, refs: { start: "m00002", end: "m00003" }, directBlockIds: [], compressedTokens: 2000, createdAt: 1, origin: "fold", requestId: "fold-call-1#0" });
	const recall = (id: string, ref: string, text: string, isError: boolean) => {
		manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("context_recall", { ref } as never, { id }), { stopReason: "toolUse" }), usage: usageWith(20) });
		manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "context_recall", content: [{ type: "text", text }], details: { mode: "ref", ref, ...(isError ? { error: "unknown ref" } : {}) }, isError, timestamp: 1 });
	};
	recall("recall-1", "b1", "R".repeat(800), false);
	recall("recall-2", "b9", "No fold or hide \"b9\" on this branch.", true);
	recall("recall-3", "h1", "H".repeat(4000), false);
	return manager;
}

test("#414: the folds view reports measured savings on its own line, apart from the summary-writing and recall costs", async () => {
	const result = await call(setUp({ tokens: 100_000, manager: measuredFoldSession() }), "context_status", { view: "folds" });
	const text = result.content[0]!.text;
	// 2,000 recorded tokens hidden minus the 100-token summary: neither cost is subtracted.
	assert.deepEqual(result.details.savings, { tokens: 1900, originalTokens: 2000, summaryTokens: 100, activeFolds: 1 });
	assert.deepEqual(result.details.preprocessing, { outputTokens: 3762, calls: 1, callsWithoutUsage: 0 });
	assert.deepEqual(result.details.recovery, { recalls: 1, tokens: 200 });
	const savings = text.split("\n").filter((line) => line.startsWith("Fold savings: "));
	assert.equal(savings.length, 1, "one savings line");
	assert.match(savings[0]!, /^Fold savings: 1900 tokens per request from 1 active fold \(2000 tokens folded, 100 tokens of summary\)\./u);
	assert.doesNotMatch(savings[0]!, /3762|200 tokens|recall|output/u, "the savings line names no cost");
	assert.match(text, /^Preprocessing cost: 3762 output tokens on 1 assistant turn that called context_fold\./mu);
	assert.match(text, /^Recovery cost: 200 tokens returned by 1 context_recall of folded content\./mu);
});

test("#414: a fold that absorbed another counts the absorbed summary as its input, not as original content", async () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
	const a = manager.appendMessage({ role: "user", content: big("A-question"), timestamp: 1 });
	const b = manager.appendMessage(fauxAssistantMessage(big("A-answer")));
	const c = manager.appendMessage({ role: "user", content: big("B-question"), timestamp: 1 });
	const record = (blockId: string, tier: number, carrierId: string, hiddenIds: string[], directBlockIds: string[], compressedTokens: number) =>
		({ version: 1, blockId, runId: "r" + blockId.slice(1), tier, carrierId, hiddenIds, range: { startId: carrierId, endId: hiddenIds.at(-1) ?? carrierId }, refs: { start: "", end: "" }, directBlockIds, compressedTokens, createdAt: 1, origin: "fold" });
	// b1 hides 2,000 tokens behind 100; b2 then folds b1's 100-token summary and 500 new tokens behind 50.
	manager.appendContextEdit(a, { content: "S".repeat(400) });
	manager.appendContextEdit(b, null);
	manager.appendCustomEntry(FOLD_ENTRY_TYPE, record("b1", 1, a, [b], [], 2000));
	manager.appendContextEdit(a, { content: "T".repeat(200) });
	manager.appendContextEdit(c, null);
	manager.appendCustomEntry(FOLD_ENTRY_TYPE, record("b2", 2, a, [b, c], ["b1"], 600));
	const result = await call(setUp({ tokens: 100_000, manager }), "context_status", { view: "folds" });
	// Originals: 2,000 + 500. Shown now: b2's 50-token summary only.
	assert.deepEqual(result.details.savings, { tokens: 2450, originalTokens: 2500, summaryTokens: 50, activeFolds: 1 });
});

test("#414: a real tier-2 fold folds exactly the originals its absorbed folds recorded", async () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
	for (const name of ["A", "B", "C"]) {
		manager.appendMessage({ role: "user", content: big(name + "-question"), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(big(name + "-answer")));
	}
	const fold = (startRef: string, endRef: string, summary: string, topic: string) => {
		const plan = planFold({ branch: manager.getBranch(), startRef, endRef, summary, topic, modelContextLimit: 200_000, config: CONFIG });
		assert.ok(plan.ok, JSON.stringify(plan));
		applyFoldDrafts(manager, plan.drafts);
	};
	// Each tier-1 summary is 400 characters, 100 tokens; the carrier shows it under a heading and topic.
	fold("m00002", "m00003", "S".repeat(400), "Alpha topic");
	fold("m00004", "m00005", "T".repeat(400), "Beta topic");
	fold("b1", "b2", "U".repeat(200), "Merged");
	const records = foldRecordsOnBranch(manager.getBranch()).map(({ record }) => record);
	assert.deepEqual(records.map((record) => [record.blockId, record.tier, record.directBlockIds]), [["b1", 1, []], ["b2", 1, []], ["b3", 2, ["b1", "b2"]]]);
	const byId = new Map(records.map((record) => [record.blockId, record.compressedTokens]));
	const result = await call(setUp({ tokens: 100_000, manager }), "context_status", { view: "folds" });
	// b3 folds only b1's and b2's summaries, so the originals folded are exactly what b1 and b2 recorded.
	const folded = byId.get("b1")! + byId.get("b2")!;
	assert.equal(result.details.savings!.originalTokens, folded);
	assert.equal(result.details.savings!.activeFolds, 1);
	assert.equal(result.details.savings!.tokens, folded - result.details.savings!.summaryTokens);
});

test("#414: a fold turn with no recorded usage adds no output tokens and is named in the preprocessing line", async () => {
	const manager = measuredFoldSession();
	const { usage: _usage, ...noUsage } = fauxAssistantMessage(fauxToolCall("context_fold", { content: [] } as never, { id: "fold-call-2" }), { stopReason: "toolUse" });
	manager.appendMessage(noUsage as never);
	const result = await call(setUp({ tokens: 100_000, manager }), "context_status", { view: "folds" });
	assert.deepEqual(result.details.preprocessing, { outputTokens: 3762, calls: 2, callsWithoutUsage: 1 });
	assert.match(result.content[0]!.text, /^Preprocessing cost: 3762 output tokens on 2 assistant turns that called context_fold\. 1 of them recorded no usage\.$/mu);
});

test("#414: with no folds the folds view reports zero savings and zero costs, not a missing line", async () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "opening", timestamp: 1 });
	const result = await call(setUp({ tokens: 100_000, manager }), "context_status", { view: "folds" });
	assert.deepEqual(result.details.savings, { tokens: 0, originalTokens: 0, summaryTokens: 0, activeFolds: 0 });
	assert.match(result.content[0]!.text, /^Fold savings: 0 tokens per request from 0 active folds/mu);
	assert.match(result.content[0]!.text, /^Preprocessing cost: 0 output tokens/mu);
	assert.match(result.content[0]!.text, /^Recovery cost: 0 tokens returned by 0 context_recall calls/mu);
});

test("#181: with no skill loaded the skills section says so", async () => {
	const s = setUp({ tokens: 100_000 });
	const view = await call(s, "context_status", { view: "skills" });
	assert.equal(view.content[0]!.text, "Loaded skills: none");
	assert.match((await call(s, "context_status")).content[0]!.text, /== skills ==\nLoaded skills: none/u);
});
