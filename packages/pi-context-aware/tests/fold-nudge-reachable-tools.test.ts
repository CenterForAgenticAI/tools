import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager, type ContextEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { createFoldTurnMemory, growthNudgeOnly, kernelNudgeText, nudgeText, prepareFoldTurn } from "../src/folds/fold-turn.js";
import { renderNudgeText, type NudgeDecision } from "../src/folds/kernel/index.js";
import type { NudgeTools } from "../src/folds/nudge-tools.js";
import { ASSIGNMENT_ENTRY_TYPE } from "../src/strategy-runtime/live/assignment.js";
import { createHostPi, createSession } from "./compaction-owner-harness.js";
import { removeFixtureDir } from "./fixture-cleanup.js";
import { runBeforeAgentStartLikePi } from "./pi-prompt-render.js";

// pi-context-aware#458 (part A) and the text half of pi-context-aware#456: the fold nudge names only the context tools the
// session can call now, offers context_compact beside context_fold with one rule for choosing, drops the kernel's
// "stronger alert" sentence, and no longer resends the HOW TO COMPRESS rules.

const STRONGER_ALERT = "A separate, stronger alert will appear";
const CHOOSING_RULE = /Fold with `context_fold` a finished range you no longer need word for word while the task continues\. Compact with `context_compact` and a seed prompt at a phase boundary, or when most of the context is already fold summaries or the next fold would only nest earlier folds\./u;

const RANGE = { startRef: "m00001", endRef: "m00008", count: 8, tokens: 72_000, toolPct: 0, textPct: 100, userMsgs: 4 };
const BASE = {
	shouldInject: true, tier: null, contextUsage: 0.5, compressibleRanges: [RANGE], protectedRanges: [],
	contextBreakdown: { system: 1_000, user: 1, assistant: 1, tool: 0, text: 72_000, total: 73_000 }, breakdown: {},
} as unknown as NudgeDecision;
const BLOCKS = [{ blockId: "b1", tier: 1, effectiveMessageIds: [], compressedTokens: 1, summary: "" }, { blockId: "b2", tier: 1, effectiveMessageIds: [], compressedTokens: 1, summary: "" }];
const TIER_2 = { ...BASE, tier: 2, tierTargetBlocks: BLOCKS } as unknown as NudgeDecision;
const TIER_3 = { ...BASE, tier: 3, tierTargetBlocks: BLOCKS.map((block) => ({ ...block, tier: 2 })) } as unknown as NudgeDecision;
const OVER_LIMIT = { ...BASE, breakdown: { overLimit: 1 } } as unknown as NudgeDecision;
const EMERGENCY = { ...BASE, breakdown: { emergencyOverride: 1 } } as unknown as NudgeDecision;
const TIERS = { gentle: BASE, tier2: TIER_2, tier3: TIER_3, overLimit: OVER_LIMIT, emergency: EMERGENCY } as const;
const FOLD: NudgeTools = { fold: true, compact: false };
const COMPACT: NudgeTools = { fold: false, compact: true };
const BOTH: NudgeTools = { fold: true, compact: true };
const NONE: NudgeTools = { fold: false, compact: false };

// --- REQ-6 (d), (e) and REQ-2 on the text itself ---

test("#456: no nudge tier carries the kernel's 'separate, stronger alert' sentence, whatever tools are reachable", () => {
	assert.ok(renderNudgeText(BASE).text.includes(STRONGER_ALERT), "the kernel's own gentle nudge has the sentence this package drops");
	assert.ok(renderNudgeText(TIER_2).text.includes(STRONGER_ALERT), "so does its tier-2 nudge");
	for (const [tier, decision] of Object.entries(TIERS)) {
		for (const tools of [FOLD, COMPACT, BOTH]) {
			const text = nudgeText(decision, BLOCKS as never, tools);
			assert.ok(text, `${tier} ${JSON.stringify(tools)} sends a nudge`);
			assert.ok(!text.includes(STRONGER_ALERT), `${tier} ${JSON.stringify(tools)}`);
		}
	}
});

test("#458: each tier names only the reachable tools; with neither reachable there is no nudge", () => {
	for (const [tier, decision] of Object.entries(TIERS)) {
		const both = nudgeText(decision, [], BOTH) ?? "";
		assert.match(both, CHOOSING_RULE, tier);
		const fold = nudgeText(decision, [], FOLD) ?? "";
		assert.match(fold, /context_fold/u, tier);
		assert.doesNotMatch(fold, /context_compact/u, tier);
		const compact = nudgeText(decision, [], COMPACT) ?? "";
		assert.match(compact, /`context_compact` and a seed prompt/u, tier);
		assert.doesNotMatch(compact, /context_fold|\bcompress\(/u, tier);
		assert.equal(nudgeText(decision, [], NONE), undefined, tier);
	}
});

// The guidelines reach the model in the system prompt natively, and in the fabric_exec tool description in
// Fabric code mode, so the pointer names no place (CR-NUDGE-POINTER-LOCATION).
const POINTER = "by the `context_fold` guidelines";
const KERNEL_RULES = /KEEP VERBATIM|Compression Philosophy:|HOW TO COMPRESS|PRIORITY — when the summary/u;

test("#456: no nudge carries the fold rules; every nudge that offers context_fold points to its guidelines", () => {
	for (const [tier, decision] of Object.entries(TIERS)) {
		for (const tools of [FOLD, BOTH]) {
			const text = nudgeText(decision, [], tools) ?? "";
			assert.doesNotMatch(text, KERNEL_RULES, `${tier} ${JSON.stringify(tools)}`);
			assert.ok(text.includes(POINTER), `${tier} ${JSON.stringify(tools)} points to the context_fold guidelines`);
			assert.doesNotMatch(text, /system prompt/u, `${tier} ${JSON.stringify(tools)} says nothing of where the guidelines sit`);
		}
		assert.ok(!(nudgeText(decision, [], COMPACT) ?? "").includes(POINTER), `${tier}: a compact-only nudge has no fold rules to point to`);
	}
	// The tier nudges keep the kernel's distillation rules: they apply only there and are not in the guidelines.
	assert.match(nudgeText(TIER_2, [], FOLD) ?? "", /TIER 2 COMPRESSION/u);
	assert.match(nudgeText(TIER_3, [], FOLD) ?? "", /TIER 3 COMPRESSION/u);
});

test("#456 (e): the gentle nudge with both tools is under 1,200 characters; it was 7,042 with the rules", () => {
	const kernel = kernelNudgeText(BASE, []);
	const sent = nudgeText(BASE, [], BOTH) ?? "";
	console.log(`gentle nudge sizes: kernel ${kernel.length} sent ${sent.length} characters`);
	assert.ok(KERNEL_RULES.test(kernel), "the kernel's own nudge, which the parity preview compares, still carries the rules");
	assert.ok(sent.length > 0 && sent.length < 1_200, `the gentle nudge is ${sent.length} characters`);
});

/** The registered context_fold tool's promptGuidelines, from the extension as a session loads it. */
async function foldGuidelines(methods?: readonly string[], options: { readonly byModel?: boolean; readonly modelId?: string; readonly switchTo?: string; readonly active?: readonly string[]; readonly fabricAllowlist?: readonly string[] } = {}): Promise<string> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-guidelines-")));
	const saved: Record<string, string | undefined> = Object.fromEntries(FABRIC_ENV.map((name) => [name, process.env[name]]));
	try {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(methods ? { strategy: { methods } } : {}) }));
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_FABRIC_DEPTH;
		if (options.fabricAllowlist) {
			process.env.PI_FABRIC_LINEAGE = JSON.stringify({ worker: true, depth: 1 });
			process.env.PI_FABRIC_TOOL_ALLOWLIST = JSON.stringify(options.fabricAllowlist);
		} else {
			delete process.env.PI_FABRIC_LINEAGE;
			delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
		}
		const host = createHostPi();
		// Pi activates a tool registered with direct exposure, so a main session reaches context_compact at session_start.
		const active = options.active ?? (options.fabricAllowlist ? ["read", "fabric_exec"] : ["read", "context_status", "context_fold", "context_compact"]);
		host.api.setActiveTools([...active]);
		if (active.includes("fabric_exec")) {
			const registered = host.api.getAllTools.bind(host.api);
			Object.assign(host.api, { getAllTools: () => [...registered(), { name: "fabric_exec", description: "Fabric executor", parameters: {}, sourceInfo: FABRIC_SOURCE }] });
		}
		const extension = await import(`../src/index.js?fold-guidelines=${Date.now()}-${Math.random()}`);
		extension.default(host.api);
		const branch = options.byModel ? [{ type: "custom", id: "a1", parentId: null, timestamp: "2026-11-20T00:00:00.000Z", customType: ASSIGNMENT_ENTRY_TYPE, data: BY_MODEL_ENTRY }] : undefined;
		const session = createSession(root, "fold-guidelines", { ...(branch ? { branch } : {}), ...(options.modelId ? { model: { id: options.modelId, contextWindow: 200_000 } } : {}) });
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, session.ctx);
		if (options.switchTo) {
			// Pi's model_select: the same session, now on another model.
			const switched = Object.assign({}, session.ctx, { model: { id: options.switchTo, contextWindow: 200_000 } }) as unknown as ExtensionContext;
			await host.handler("model_select")({ type: "model_select", model: switched.model, previousModel: session.ctx.model, source: "set" }, switched);
		}
		await host.handler("session_shutdown")({}, session.ctx).catch(() => {});
		const tool = (host.tools as unknown as Map<string, { promptGuidelines?: string[] }>).get("context_fold");
		assert.ok(tool, "context_fold is registered");
		return (tool.promptGuidelines ?? []).join("\n");
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		await removeFixtureDir(root);
	}
}

test("#456: the context_fold guidelines carry the fold rules the nudge no longer sends", async () => {
	const text = await foldGuidelines();
	const rules: Record<string, RegExp> = {
		"every listed range that is finished, not the active task": /Fold every range a nudge lists that is finished work.*Never fold what the current task still uses/u,
		"folding, not avoiding tools": /keep context small by folding, not by avoiding tools/u,
		"protected recent turns and verbatim hints": /last few messages \(protected\), or entries a verbatim fold hint keeps/u,
		"whole tool call and result pairs": /each tool call stays with its result/u,
		"size bounds": /5,000 characters or more; a summary 50 to 20,000 \(raise summaryMaxChars/u,
		"folding earlier folds by fold id": /fold earlier folds again, name their fold ids \(bN\) as startId and endId/u,
		"self-contained summary as history": /only record of the range.*TASK AS OF THIS FOLD/u,
		"what to keep verbatim": /Keep verbatim: full paths with line numbers.*exact errors.*decisions with their reason.*open questions/u,
		"quotes and open objectives": /only with the message ref.*Open objectives: line/u,
		"a long user message keeps its intent": /too long to quote.*must not change its scope, constraints, priorities or acceptance criteria/u,
		"open objectives exclude done and superseded": /each request neither done nor superseded/u,
		"what to drop": /Drop logs once the error or result is kept.*tried X, failed because Y/u,
		"priority and format": /When space is short keep, in order: goal and constraints, decisions/u,
		"when to compact instead": /context_compact is available, use it instead at a phase boundary/u,
	};
	for (const [rule, pattern] of Object.entries(rules)) assert.match(text, pattern, rule);
});

test("CR-PARITY-NO-TOOLS-CAUSE: a parity preview refuses a nudge suppressed because no tool is reachable", () => {
	// No parity cause covers this suppression; recording it as tier-trigger (FP-201) or denominator (FP-203) would
	// explain it by the wrong mechanism, so the combination throws instead.
	const manager = largeSession();
	const input = (nudgeTools: () => NudgeTools) => ({
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 120_000 }, systemPromptTokens: 0, hostTokens: 100_000, memory: createFoldTurnMemory(), stages: growthNudgeOnly(nudgeTools()),
		compatibility: true, protectedZone: "all-user-role" as const,
	});
	assert.throws(() => prepareFoldTurn(input(() => NONE)), /no fold or compact tool is reachable/u);
	assert.match(prepareFoldTurn(input(() => FOLD))?.nudge ?? "", /context_fold/u, "a preview with the fold tool reachable still runs and nudges");
	assert.equal(prepareFoldTurn({ ...input(() => NONE), compatibility: false })?.nudge, undefined, "outside a preview the turn is silent, as before");
});

test("#458: with no tool reachable the turn sends no nudge, and the next reachable turn still can", () => {
	const manager = largeSession();
	const input = (nudgeTools: () => NudgeTools) => ({
		messages: manager.buildSessionContext().messages.filter((message) => message.role !== "system"),
		projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 120_000 }, systemPromptTokens: 0, hostTokens: 100_000, memory: createFoldTurnMemory(), stages: growthNudgeOnly(nudgeTools()),
	});
	const silent = prepareFoldTurn(input(() => NONE));
	assert.ok(silent, "the pass runs");
	assert.equal(silent.nudge, undefined);
	assert.equal(silent.nudgeKind, undefined);
	assert.match(prepareFoldTurn(input(() => FOLD))?.nudge ?? "", /context_fold/u, "the same turn nudges when the fold tool is reachable");
});

// --- REQ-6 (a), (b), (c) through the extension's own context handler ---

function largeSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	return manager;
}

const FABRIC_SOURCE = { path: "/profile/node_modules/pi-fabric/dist/index.js", source: "npm:pi-fabric@0.92.42", scope: "user", origin: "package", baseDir: "/profile/node_modules/pi-fabric" };
const FABRIC_ENV = ["PI_FABRIC_TOOL_ALLOWLIST", "PI_FABRIC_LINEAGE", "PI_FABRIC_DEPTH", "HOME", "PI_CODING_AGENT_DIR"] as const;

interface Setup {
	readonly active: readonly string[];
	/** Set: this process is a Fabric child whose tool allowlist is this list. */
	readonly fabricAllowlist?: readonly string[];
	/** Set: the global config's strategy.methods (pi-context-aware#526). */
	readonly methods?: readonly string[];
	/** Tool names registered beside this extension's, such as a context tool a reload left registered hidden. */
	readonly registered?: readonly string[];
	/** Set: the session's branch records an assignment of by-model-v1 (pi-context-aware#459). */
	readonly byModel?: boolean;
	/** The request's model id. */
	readonly modelId?: string;
}

/** The text of the nudge the extension appends to an over-limit request, or undefined when it appends none. */
async function sentNudge(setup: Setup): Promise<string | undefined> {
	return (await sentUserTexts(setup)).find((text) => /^(This is an efficiency nudge|\u26A0\uFE0F Context limit reached)/u.test(text));
}

/** Every user-role text of the over-limit request the extension sends. */
async function sentUserTexts(setup: Setup): Promise<string[]> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-nudge-tools-")));
	const saved = Object.fromEntries(FABRIC_ENV.map((name) => [name, process.env[name]]));
	try {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(setup.methods ? { strategy: { methods: setup.methods } } : {}) }));
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_FABRIC_DEPTH;
		if (setup.fabricAllowlist) {
			process.env.PI_FABRIC_LINEAGE = JSON.stringify({ worker: true, depth: 1 });
			process.env.PI_FABRIC_TOOL_ALLOWLIST = JSON.stringify(setup.fabricAllowlist);
		} else {
			delete process.env.PI_FABRIC_LINEAGE;
			delete process.env.PI_FABRIC_TOOL_ALLOWLIST;
		}
		const host = createHostPi();
		const extension = await import(`../src/index.js?nudge-tools=${Date.now()}-${Math.random()}`);
		extension.default(host.api);
		const manager = largeSession();
		if (setup.byModel) manager.appendCustomEntry(ASSIGNMENT_ENTRY_TYPE, BY_MODEL_ENTRY);
		const ctx = Object.assign({}, createSession(root, "nudge-tools").ctx, {
			cwd: root, sessionManager: manager, model: { contextWindow: 120_000, ...(setup.modelId ? { id: setup.modelId } : {}) },
			getContextUsage: () => ({ tokens: 100_000, contextWindow: 120_000 }), getSystemPrompt: () => "",
		}) as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		host.api.setActiveTools([...setup.active]);
		const registered = [...host.api.getAllTools(), ...(setup.registered ?? []).map((name) => ({ name, description: "", parameters: {} }))];
		Object.assign(host.api, { getAllTools: () => [...registered, ...(setup.active.includes("fabric_exec") ? [{ name: "fabric_exec", description: "Fabric executor", parameters: {}, sourceInfo: FABRIC_SOURCE }] : [])] });
		const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system") as ContextEvent["messages"];
		const result = await host.handler("context")({ type: "context", messages }, ctx) as { messages?: ContextEvent["messages"] } | undefined;
		await host.handler("session_shutdown")({}, ctx).catch(() => {});
		return (result?.messages ?? messages).filter((message) => message.role === "user").map((message) => {
			const content = (message as { content: unknown }).content;
			return typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");
		});
	} finally {
		for (const name of FABRIC_ENV) {
			if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
		}
		await removeFixtureDir(root);
	}
}

test("#458 (a): a Fabric child whose allowlist lacks context_fold gets no nudge that names context_fold", async () => {
	const withFold = await sentNudge({ active: ["read", "fabric_exec"], fabricAllowlist: ["read", "context_fold"] });
	assert.match(withFold ?? "", /`context_fold`/u, "the same child is nudged when its allowlist names context_fold");
	assert.doesNotMatch(withFold ?? "", /context_compact/u, "a Fabric child cannot compact: nothing would continue it");
	const without = await sentNudge({ active: ["read", "fabric_exec"], fabricAllowlist: ["read"] });
	assert.equal(without, undefined, "neither tool is reachable, so there is no nudge");
});

test("#458 (b): a session whose active tools leave out context_fold is offered only context_compact", async () => {
	const text = await sentNudge({ active: ["read", "context_status", "context_compact"] });
	assert.ok(text, "the session is nudged");
	assert.match(text, /`context_compact` and a seed prompt/u);
	assert.doesNotMatch(text, /context_fold|\bcompress\(/u);
});

test("#456 (c): a main session's nudge names both tools and the rule for choosing", async () => {
	const text = await sentNudge({ active: ["read", "context_status", "context_fold", "context_compact"] });
	assert.ok(text, "the session is nudged");
	assert.match(text, CHOOSING_RULE);
	assert.ok(!text.includes(STRONGER_ALERT));
});

// CR-FOLD-ONLY-COMPACT-NUDGE (pi-context-aware#526): in a Fabric code-mode main session every registered tool is
// reachable through fabric_exec, a hidden one included. A tool whose method the session does not run must still be
// named nowhere in the request: context_compact is hidden and refused without compact.
const FABRIC_MAIN = { active: ["read", "fabric_exec"] } as const;
const PRESSURE = /Context pressure (WARN|URGENT)/u;

test("CR-FOLD-ONLY-COMPACT-NUDGE: under a Fabric host the default methods name both tools in the nudge and the pressure note", async () => {
	const nudge = await sentNudge(FABRIC_MAIN);
	assert.ok(nudge, "the session is nudged");
	assert.match(nudge, PRESSURE, "the pressure note rides with the nudge");
	assert.match(nudge, /context_fold/u);
	assert.match(nudge, /context_compact/u, "a Fabric host reaches context_compact, so the default names it");
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"fold\"] under a Fabric host no request text names context_compact", async () => {
	const texts = await sentUserTexts({ ...FABRIC_MAIN, methods: ["fold"] });
	const nudge = texts.find((text) => PRESSURE.test(text));
	assert.ok(nudge, "the nudge and the pressure note are sent");
	assert.match(nudge, /context_fold/u, "the fold nudge still names context_fold");
	for (const text of texts) assert.doesNotMatch(text, /context_compact/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"compact\"] under a Fabric host no request text names context_fold", async () => {
	const texts = await sentUserTexts({ ...FABRIC_MAIN, methods: ["compact"] });
	const note = texts.find((text) => PRESSURE.test(text));
	assert.ok(note, "the pressure note is sent");
	assert.match(note, /context_compact/u);
	for (const text of texts) assert.doesNotMatch(text, /context_fold|\bcompress\(/u);
});

/** The system prompt's context-tools section and the /checkin prompt of a Fabric code-mode main session. */
async function fabricMainPrompts(methods?: readonly string[], extraTools: readonly string[] = []): Promise<{ readonly tools: string; readonly checkin: string }> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fabric-prompts-")));
	const saved = Object.fromEntries(FABRIC_ENV.map((name) => [name, process.env[name]]));
	try {
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(methods ? { strategy: { methods } } : {}) }));
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const name of ["PI_FABRIC_DEPTH", "PI_FABRIC_LINEAGE", "PI_FABRIC_TOOL_ALLOWLIST"] as const) delete process.env[name];
		const host = createHostPi();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
		Object.assign(host.api, { registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => unknown }) { commands.set(name, definition); } });
		const extension = await import(`../src/index.js?fabric-prompts=${Date.now()}-${Math.random()}`);
		extension.default(host.api);
		const session = createSession(root, "fabric-prompts");
		const ctx = Object.assign({}, session.ctx, { ui: { notify() {}, setStatus() {}, setWidget() {} } }) as unknown as ExtensionContext;
		await host.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
		host.api.setActiveTools([...FABRIC_MAIN.active]);
		const registered = [...host.api.getAllTools(), ...extraTools.map((name) => ({ name, description: "", parameters: {} }))];
		Object.assign(host.api, { getAllTools: () => [...registered, { name: "fabric_exec", description: "Fabric executor", parameters: {}, sourceInfo: FABRIC_SOURCE }] });
		const run = await runBeforeAgentStartLikePi(host.handler("before_agent_start"), { type: "before_agent_start", prompt: "continue", systemPrompt: "base", systemPromptOptions: {} }, ctx);
		const checkin = commands.get("checkin");
		assert.ok(checkin, "/checkin is registered");
		await checkin.handler("", ctx);
		await host.handler("agent_settled")({}, ctx);
		await host.handler("session_shutdown")({}, ctx).catch(() => {});
		assert.equal(host.userMessages.length, 1, "the check-in is delivered once");
		return { tools: run.sections["context-tools"] ?? "", checkin: String(host.userMessages[0]) };
	} finally {
		for (const name of FABRIC_ENV) {
			if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
		}
		await removeFixtureDir(root);
	}
}

test("CR-FOLD-ONLY-COMPACT-NUDGE: under a Fabric host the default methods list both tools in the system prompt and offer context_compact in the check-in", async () => {
	const { tools, checkin } = await fabricMainPrompts();
	assert.match(tools, /- context_fold:/u);
	assert.match(tools, /- context_compact:/u);
	assert.match(checkin, /context_compact/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"fold\"] under a Fabric host neither the system prompt nor the check-in names context_compact", async () => {
	const { tools, checkin } = await fabricMainPrompts(["fold"]);
	assert.match(tools, /- context_fold:/u);
	assert.doesNotMatch(tools, /context_compact|compact at a phase boundary/u);
	assert.doesNotMatch(checkin, /context_compact/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"compact\"] under a Fabric host the system prompt does not name context_fold, even one left registered", async () => {
	const { tools } = await fabricMainPrompts(["compact"], ["context_fold"]);
	assert.match(tools, /- context_compact:/u);
	assert.doesNotMatch(tools, /context_fold|fold what you have finished/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"fold\"] the context_fold guidelines do not name context_compact", async () => {
	const text = await foldGuidelines(["fold"]);
	assert.match(text, /Fold every range a nudge lists that is finished work/u, "the fold rules are kept");
	assert.doesNotMatch(text, /context_compact/u);
});

test("CR-FOLD-ONLY-COMPACT-NUDGE: with strategy.methods [\"compact\"] under a Fabric host, a registered context_fold is still not named", async () => {
	// A session that started with fold and then lost it in the same process keeps context_fold registered, hidden.
	const texts = await sentUserTexts({ ...FABRIC_MAIN, methods: ["compact"], registered: ["context_fold"] });
	const note = texts.find((text) => PRESSURE.test(text));
	assert.ok(note, "the pressure note is sent");
	assert.match(note, /context_compact/u);
	for (const text of texts) assert.doesNotMatch(text, /context_fold|\bcompress\(/u);
});
// --- pi-context-aware#459: by-model-v1 words the choosing rule and one fold guideline by the request's model ---

/** A recorded draw of by-model-v1: a list of one variant always draws it. */
const BY_MODEL_ENTRY = { schemaVersion: 2, guidance: "by-model-v1", seed: "459-test", variants: ["by-model-v1"], drawnFor: "nudge-tools" };
const OPUS = "claude-opus-5-5";
const GPT = "gpt-6.1-sol";
// The wording the operator agreed (459-guidance-design.md, section 2), typed here, not read from the code.
const COMPACT_BOUNDARY_RULE = "Two tools reduce context. When a phase of the work is finished (a deliverable shipped, a question answered, an experiment concluded), compact with `context_compact` and a seed prompt for the next phase. That frees more than folding the phase range by range and avoids nesting folds. Inside a phase that is still running, fold a finished range with `context_fold`.";
const FOLD_FIRST_RULE = "Two tools reduce context. Fold first: fold with `context_fold` each finished range you no longer need word for word. Folding keeps the task's recent state in place and costs less than starting over. Compact with `context_compact` only when the work moves to a new phase and most of the context is already fold summaries.";
const COMPACT_BOUNDARY_LINE = "If context_compact is available and a phase is finished, compact rather than fold that phase range by range. Fold within a running phase.";
const FOLD_FIRST_LINE = "Prefer folding. If context_compact is available, use it only at a phase boundary, when most of the context is already fold summaries and folding again frees too little.";
const DEFAULT_LINE = "If context_compact is available, use it instead at a phase boundary, or when most of the context is already fold summaries and folding again frees too little.";

test("#459: with both tools each steer sends its own choosing rule in every tier, and the default steer is today's text byte for byte", () => {
	for (const [tier, decision] of Object.entries(TIERS)) {
		assert.equal(nudgeText(decision, BLOCKS as never, BOTH, "context_fold", "default"), nudgeText(decision, BLOCKS as never, BOTH), tier);
		const boundary = nudgeText(decision, [], BOTH, "context_fold", "compact-boundary") ?? "";
		assert.ok(boundary.includes(COMPACT_BOUNDARY_RULE), `${tier}: ${boundary.slice(0, 300)}`);
		assert.doesNotMatch(boundary, CHOOSING_RULE, tier);
		const first = nudgeText(decision, [], BOTH, "context_fold", "fold-first") ?? "";
		assert.ok(first.includes(FOLD_FIRST_RULE), `${tier}: ${first.slice(0, 300)}`);
		assert.doesNotMatch(first, CHOOSING_RULE, tier);
	}
});

test("#459: with one tool every steer sends the default one-tool text, which names only that tool", () => {
	for (const [tier, decision] of Object.entries(TIERS)) {
		for (const steer of ["compact-boundary", "fold-first"] as const) {
			const fold = nudgeText(decision, [], FOLD, "context_fold", steer);
			assert.equal(fold, nudgeText(decision, [], FOLD), `${tier} ${steer}`);
			assert.doesNotMatch(fold ?? "", /context_compact/u, `${tier} ${steer}`);
			const compact = nudgeText(decision, [], COMPACT, "context_fold", steer);
			assert.equal(compact, nudgeText(decision, [], COMPACT), `${tier} ${steer}`);
			assert.doesNotMatch(compact ?? "", /context_fold|\bcompress\(/u, `${tier} ${steer}`);
			assert.equal(nudgeText(decision, [], NONE, "context_fold", steer), undefined, `${tier} ${steer}`);
		}
	}
});

test("#459: the gentle nudge stays under 1,200 characters with either steer", () => {
	for (const steer of ["compact-boundary", "fold-first"] as const) {
		const sent = nudgeText(BASE, [], BOTH, "context_fold", steer) ?? "";
		assert.ok(sent.length > 0 && sent.length < 1_200, `${steer}: ${sent.length} characters`);
	}
});

test("#459: a session assigned by-model-v1 sends Opus the compact-at-boundary rule and GPT the fold-first rule", async () => {
	const active = ["read", "context_status", "context_fold", "context_compact"];
	const opus = await sentNudge({ active, byModel: true, modelId: "anthropic/" + OPUS });
	assert.ok(opus?.includes(COMPACT_BOUNDARY_RULE), String(opus));
	const gpt = await sentNudge({ active, byModel: true, modelId: GPT });
	assert.ok(gpt?.includes(FOLD_FIRST_RULE), String(gpt));
	assert.match(await sentNudge({ active, byModel: true, modelId: "claude-sonnet-5-5" }) ?? "", CHOOSING_RULE, "another model gets today's rule");
	assert.match(await sentNudge({ active, modelId: OPUS }) ?? "", CHOOSING_RULE, "an Opus session on the default guidance gets today's rule");
});

test("#459: under by-model-v1 with strategy.methods [\"fold\"] no request text names context_compact, for Opus and for GPT", async () => {
	for (const modelId of [OPUS, GPT]) {
		const texts = await sentUserTexts({ ...FABRIC_MAIN, methods: ["fold"], byModel: true, modelId });
		assert.ok(texts.some((text) => /context_fold/u.test(text)), `${modelId}: the fold nudge is sent`);
		for (const text of texts) assert.doesNotMatch(text, /context_compact/u, modelId);
	}
});

test("#459: under by-model-v1 with strategy.methods [\"compact\"] no request text names context_fold, for Opus and for GPT", async () => {
	for (const modelId of [OPUS, GPT]) {
		const texts = await sentUserTexts({ ...FABRIC_MAIN, methods: ["compact"], byModel: true, modelId });
		assert.ok(texts.some((text) => /context_compact/u.test(text)), `${modelId}: the pressure note is sent`);
		for (const text of texts) assert.doesNotMatch(text, /context_fold|\bcompress\(/u, modelId);
	}
});

test("#459: the context_fold guideline that names context_compact follows the steer; the default guidance keeps today's line", async () => {
	const opus = await foldGuidelines(undefined, { byModel: true, modelId: OPUS });
	assert.ok(opus.includes(COMPACT_BOUNDARY_LINE), opus);
	assert.ok(!opus.includes(DEFAULT_LINE));
	const gpt = await foldGuidelines(undefined, { byModel: true, modelId: GPT });
	assert.ok(gpt.includes(FOLD_FIRST_LINE), gpt);
	assert.ok(!gpt.includes(DEFAULT_LINE));
	const plain = await foldGuidelines(undefined, { modelId: OPUS });
	assert.ok(plain.includes(DEFAULT_LINE), "default guidance keeps today's line");
	const other = await foldGuidelines(undefined, { byModel: true, modelId: "claude-sonnet-5-5" });
	assert.ok(other.includes(DEFAULT_LINE), "another model keeps today's line");
	for (const modelId of [OPUS, GPT]) {
		const foldOnly = await foldGuidelines(["fold"], { byModel: true, modelId });
		assert.doesNotMatch(foldOnly, /context_compact/u, `${modelId}: without compact no guideline names it`);
		assert.match(foldOnly, /Fold every range a nudge lists/u);
	}
});

test("CR-FOLD-FIRST-GUIDELINE-UNREACHABLE-COMPACT: a Fabric child that cannot reach context_compact gets the default arm's hedged guideline under by-model-v1", async () => {
	for (const modelId of [GPT, OPUS]) {
		const child = await foldGuidelines(undefined, { byModel: true, modelId, fabricAllowlist: ["read", "context_fold"] });
		const plain = await foldGuidelines(undefined, { modelId, fabricAllowlist: ["read", "context_fold"] });
		assert.match(child, /Fold every range a nudge lists/u, `${modelId}: the child gets the fold guidelines`);
		assert.equal(child, plain, `${modelId}: no steered wording for a child that cannot compact`);
		for (const line of child.split("\n").filter((text) => text.includes("context_compact"))) {
			assert.ok(line.startsWith("If context_compact is available"), `${modelId}: unhedged line: ${line}`);
		}
	}
});

test("#459: every steered guideline line that names context_compact is hedged", async () => {
	for (const modelId of [GPT, OPUS]) {
		const text = await foldGuidelines(undefined, { byModel: true, modelId });
		const lines = text.split("\n").filter((line) => line.includes("context_compact"));
		assert.equal(lines.length, 1, modelId);
		assert.match(lines[0]!, /(^|\. )If context_compact is available/u, modelId);
	}
});

test("#459: a mid-session model switch changes the context_fold guideline to the new model's", async () => {
	const switched = await foldGuidelines(undefined, { byModel: true, modelId: OPUS, switchTo: GPT });
	assert.ok(switched.includes(FOLD_FIRST_LINE), switched);
	assert.ok(!switched.includes(COMPACT_BOUNDARY_LINE));
	const back = await foldGuidelines(undefined, { byModel: true, modelId: GPT, switchTo: "claude-sonnet-5-5" });
	assert.ok(back.includes(DEFAULT_LINE), "a switch to a model the variant does not steer restores today's line");
});
