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
import { createContextStatusSurface, contextStatusSchema, type ContextStatusHost } from "../src/context-tools/context-status.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { SKILL_REGISTRY_ENTRY_TYPE, sha256 } from "../src/skills/skill-registry.js";
import { createHostPi, createSession, type FakeHostPi } from "./compaction-owner-harness.js";

// pi-context-aware#194 (cut-over checklist row 2 on pi-context-aware#137): context_status is registered with its
// four views (skills added by pi-context-aware#181), and none of its old names (session_compaction_history, acp_status) registers. Expected values come from the session built here, not from the tool.

/** The fields the tests read from a result's details; each view fills its own. */
interface StatusDetails {
	measured?: boolean; tokens?: number; fraction?: number; stage?: string; thresholds?: unknown;
	available?: boolean; count?: number; compactions: { id: string; writer?: unknown }[] & { available?: boolean; writer?: unknown };
	writer?: unknown;
	mode?: string; engine?: string; pending?: number; activeCount?: number;
	dropped: { startRef: string; endRef: string; errors: string[] }[];
	active: { blockId: string; topic: string }[];
	pressure: { stage: string }; folds: { mode: string };
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

interface Setup {
	readonly host: FakeHostPi;
	readonly ctx: ExtensionContext;
	readonly manager: SessionManager;
	tool(name: string): StatusTool;
}

function setUp(options: { tokens: number | null; mode?: "live" | "shadow"; pending?: number; bcp?: boolean; contradicts?: boolean }): Setup {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-context-status-")));
	const host = createHostPi();
	const manager = foldedSession();
	const session = createSession(root, "context-status-session");
	const ctx = Object.assign(session.ctx, {
		getContextUsage: () => ({ tokens: options.tokens, contextWindow: 200_000 }),
		sessionManager: Object.assign(Object.create(manager), { getBranch: () => manager.getBranch() }),
	}) as ExtensionContext;
	const engine: ContextStatusHost["engine"] = {
		mode: () => options.mode ?? "live",
		engine: () => ({ engine: (options.mode ?? "live") === "live" ? "folds" : "compaction-only", contradictsPresence: options.contradicts ?? false }),
		pending: () => options.pending ?? 0,
		dropped: () => [{ startRef: "m00090", endRef: "m00091", errors: ["Range is too small to fold."], code: undefined as never }],
	};
	const surface = createContextStatusSurface(host.api, { engine, usage: (c) => { const u = c.getContextUsage(); return u?.tokens == null ? { tokens: 0, window: 200_000, fraction: 0, headroom: 200_000, unmeasured: true } : { tokens: u.tokens, window: 200_000, fraction: u.tokens / 200_000, headroom: 200_000 - u.tokens }; }, ladder: () => LADDER });
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

test("#181: with no skill loaded the skills section says so", async () => {
	const s = setUp({ tokens: 100_000 });
	const view = await call(s, "context_status", { view: "skills" });
	assert.equal(view.content[0]!.text, "Loaded skills: none");
	assert.match((await call(s, "context_status")).content[0]!.text, /== skills ==\nLoaded skills: none/u);
});
