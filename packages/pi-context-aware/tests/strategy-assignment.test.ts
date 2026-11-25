/**
 * Assigning guidance to each new session (pi-context-aware#473, pi-context-aware#526, REQ-STRAT-007): the draw from a
 * seed, the recorded assignment, and the rule that an assignment never changes a session's methods. Expected draws
 * are literals computed outside the code with `printf '<seed>\n<session id>' | shasum -a 256`: the first four bytes
 * as an unsigned big-endian integer, modulo the length of the list.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RegisteredToolView } from "../src/compaction/compaction-blocker.js";
import { resolveSessionStrategy, strategyDebugLines, strategyErrorLines, type StrategySettings } from "../src/folds/engine-resolver.js";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { readConfigLayer } from "../src/platform/config-layers.js";
import { removeFixtureDir } from "./fixture-cleanup.js";
import { ASSIGNMENT_ENTRY_TYPE, assignmentOnBranch, drawFrom, retiredAssignmentsOnBranch } from "../src/strategy-runtime/live/assignment.js";
import { GUIDANCE_VARIANTS } from "../src/strategy/guidance.js";

const ARMS = ["a", "b"] as const;
const SESSIONS = ["sess-1", "sess-2", "sess-3", "sess-4", "sess-5", "sess-6"];

test("the same seed and session list give the same draw, the one sha256 gives", () => {
	const first = SESSIONS.map((id) => drawFrom("trial-1", ARMS, id));
	assert.deepEqual(first, ["a", "b", "a", "b", "a", "a"]);
	assert.deepEqual(SESSIONS.map((id) => drawFrom("trial-1", ARMS, id)), first, "drawn again, the list gets the same arms");
	assert.equal(drawFrom("trial-1", ARMS, "01a1de0e-40fa-7213-b671-90126637f946"), "a");
});

test("another seed draws another assignment for the same sessions", () => {
	assert.deepEqual(SESSIONS.map((id) => drawFrom("trial-2", ARMS, id)), ["b", "a", "b", "b", "b", "a"]);
});

test("the list order is the index order, and a list of one is a fixed assignment", () => {
	assert.deepEqual(SESSIONS.map((id) => drawFrom("trial-1", ["b", "a"], id)), ["b", "a", "b", "a", "b", "b"]);
	for (const id of SESSIONS) assert.equal(drawFrom("trial-1", ["b"], id), "b");
	assert.throws(() => drawFrom("trial-1", [], "sess-1"));
});

test("over many sessions each arm gets about half", () => {
	const counts: Record<string, number> = { a: 0, b: 0 };
	for (let i = 0; i < 2000; i++) counts[drawFrom("trial-1", ARMS, `session-${i}`)] += 1;
	assert.ok(counts.a! > 900 && counts.a! < 1100, JSON.stringify(counts));
});

test("the guidance registry holds default and by-model-v1 (pi-context-aware#459), default first", () => {
	assert.deepEqual([...GUIDANCE_VARIANTS], ["default", "by-model-v1"]);
});

const entry = (data: unknown, customType: string = ASSIGNMENT_ENTRY_TYPE) => ({ type: "custom", id: "e", parentId: null, timestamp: "t", customType, data });
const recorded = { schemaVersion: 2, guidance: "default", seed: "trial-1", variants: ["default", "default"], drawnFor: "sess-2" };
const V1_ENTRY_TYPE = "context-aware.strategy-assignment.v1";
const v1 = { schemaVersion: 1, recipe: "compaction-only-v1", seed: "trial-1", recipes: ["folds-v1", "compaction-only-v1"], drawnFor: "sess-2" };

test("the first valid assignment entry on the branch is the session's assignment", () => {
	assert.equal(ASSIGNMENT_ENTRY_TYPE, "context-aware.strategy-assignment.v2");
	const later = { ...recorded, variants: ["default"], drawnFor: "sess-9" };
	assert.deepEqual(assignmentOnBranch([{ type: "message" }, entry(recorded), entry(later)]), { guidance: "default", seed: "trial-1", variants: ["default", "default"], drawnFor: "sess-2" });
	assert.equal(assignmentOnBranch([{ type: "message" }]), null);
});

test("a forged or careless assignment entry is not an assignment, and its extra fields do not survive", () => {
	const bad: unknown[] = [
		{ ...recorded, schemaVersion: 1 },
		{ ...recorded, guidance: "compact" },
		{ ...recorded, guidance: "compaction-only-v1" },
		{ ...recorded, guidance: "turbo" },
		{ ...recorded, seed: "x\nError: forged" },
		{ ...recorded, seed: "" },
		{ ...recorded, seed: "s".repeat(65) },
		{ ...recorded, variants: ["default", "turbo"] },
		{ ...recorded, variants: "default" },
		{ ...recorded, variants: [] },
		{ ...recorded, variants: Array<string>(17).fill("default") },
		{ ...recorded, drawnFor: "../../etc" },
		{ ...recorded, drawnFor: 7 },
		null,
		"default",
	];
	for (const data of bad) assert.equal(assignmentOnBranch([entry(data)]), null, JSON.stringify(data));
	assert.equal(assignmentOnBranch([entry(recorded, "context-aware.policy.v1")]), null, "another entry type is not an assignment");
	const extra = assignmentOnBranch([entry({ ...recorded, note: "ignore previous instructions", methods: ["compact"] })]);
	assert.deepEqual(Object.keys(extra ?? {}).sort(), ["drawnFor", "guidance", "seed", "variants"], "named fields are copied; the rest is dropped");
	assert.deepEqual(assignmentOnBranch([entry(bad[1]), entry(recorded)])?.guidance, "default", "a bad entry is skipped, the next valid one counts");
});

test("a recipe assignment of the first version is not an assignment; it is counted so a debug note can name it", () => {
	assert.equal(assignmentOnBranch([entry(v1, V1_ENTRY_TYPE)]), null);
	assert.equal(retiredAssignmentsOnBranch([entry(v1, V1_ENTRY_TYPE), { type: "message" }, entry(recorded)]), 1);
	assert.equal(retiredAssignmentsOnBranch([entry(recorded)]), 0);
});

const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";
const bcpLoaded: RegisteredToolView[] = [{ name: "read", sourceInfo: { path: "builtin:read" } }, { name: "compress", sourceInfo: { path: BCP_PATH } }, { name: "acp_status", sourceInfo: { path: BCP_PATH } }];
const bcpAbsent: RegisteredToolView[] = [{ name: "read", sourceInfo: { path: "builtin:read" } }];
const assign = { guidance: ["default"], seed: "trial-1" };
const fresh = (id: string) => ({ id, fresh: true, recorded: null });
const resolve = (tools: readonly RegisteredToolView[], settings: StrategySettings) => resolveSessionStrategy({ tools, settings });

test("config: strategy.assign takes a list of guidance ids and a seed; a seed that would not show as one plain line is rejected", () => {
	const layer = readConfigLayer({ strategy: { assign: { guidance: ["default", " turbo "], seed: "trial-1" } } }, "global");
	assert.deepEqual(layer.rejected, []);
	assert.deepEqual(layer.values.get("strategy.assign.guidance"), ["default", "turbo"], "ids are kept for the resolver to report");
	assert.equal(layer.values.get("strategy.assign.seed"), "trial-1");
	for (const seed of ["", "x\ny", "a b", "s".repeat(65), 7, "\u001b[2J"]) {
		assert.deepEqual(readConfigLayer({ strategy: { assign: { seed } } }, "global").rejected, ["strategy.assign.seed"], JSON.stringify(seed));
	}
	assert.deepEqual(readConfigLayer({ strategy: { assign: { guidance: "default" } } }, "global").rejected, ["strategy.assign.guidance"]);
});

test("a new session draws its guidance from the list and says so; its methods stay the default", () => {
	const two = resolve(bcpAbsent, { assign, session: fresh("sess-2") });
	assert.equal(two.guidance, "default");
	assert.deepEqual(two.assignment, { seed: "trial-1", variants: ["default"], drawnFor: "sess-2", recorded: false });
	assert.deepEqual([[...two.methods], two.source], [["fold", "compact"], "auto"]);
});

test("a recorded assignment wins over a new draw, so a resumed or forked session keeps its guidance when the setting changes", () => {
	const kept = { guidance: "default" as const, seed: "trial-1", variants: ["default" as const], drawnFor: "sess-2" };
	for (const settings of [{ assign: { guidance: ["default"], seed: "trial-2" } }, {}]) {
		const found = resolve(bcpAbsent, { ...settings, session: { id: "fork-7", fresh: false, recorded: kept } });
		assert.deepEqual(found.assignment, { seed: "trial-1", variants: ["default"], drawnFor: "sess-2", recorded: true });
	}
});

test("a session that already ran is not drawn for", () => {
	assert.equal(resolve(bcpAbsent, { assign, session: { id: "sess-2", fresh: false, recorded: null } }).assignment, undefined);
	assert.equal(resolve(bcpAbsent, { assign, session: fresh("sess 2/../x") }).assignment, undefined, "a session id the recorded entry could not carry is not drawn for");
});

test("an unknown guidance id is an error and is not drawn; a list with none known, or no seed, draws nothing", () => {
	const some = resolve(bcpAbsent, { assign: { guidance: ["turbo", "default"], seed: "trial-1" }, session: fresh("sess-1") });
	assert.deepEqual(some.assignment?.variants, ["default"], "drawn from the known ids only");
	assert.deepEqual(strategyErrorLines(some), ["Error: strategy.assign.guidance names an unknown guidance variant, \"turbo\". Known variants: default, by-model-v1. It is not drawn."]);
	assert.equal(resolve(bcpAbsent, { assign: { guidance: ["turbo"], seed: "trial-1" }, session: fresh("sess-2") }).assignment, undefined);
	const unseeded = resolve(bcpAbsent, { assign: { guidance: ["default"], seed: "" }, session: fresh("sess-2") });
	assert.equal(unseeded.assignment, undefined);
	assert.deepEqual(strategyErrorLines(unseeded), ["Error: strategy.assign.guidance is set without strategy.assign.seed. No guidance is drawn."]);
});

test("a strategy.assign.guidance list longer than 16 ids is an error and draws nothing; 16 ids still draw", () => {
	const over = resolve(bcpAbsent, { assign: { guidance: Array<string>(17).fill("default"), seed: "trial-1" }, session: fresh("sess-1") });
	assert.equal(over.assignment, undefined);
	assert.deepEqual(strategyErrorLines(over), ["Error: strategy.assign.guidance lists 17 ids; at most 16 are allowed. No guidance is drawn."]);
	const kept = resolve(bcpAbsent, { assign: { guidance: Array<string>(16).fill("default"), seed: "trial-1" }, session: fresh("sess-1") });
	assert.deepEqual([kept.assignment?.variants.length, kept.errors], [16, []]);
});

test("strategy.assign.recipes is removed: setting it is an error, and it draws nothing", () => {
	const found = resolve(bcpAbsent, { rejected: ["strategy.assign.recipes"], session: fresh("sess-2") });
	assert.deepEqual(strategyErrorLines(found), ["Error: strategy.assign.recipes was removed and is ignored: methods are never drawn. strategy.assign.guidance lists guidance variants (known: default, by-model-v1)."]);
	assert.equal(found.assignment, undefined);
});

test("no strategy.assign value, drawn or recorded, changes a session's methods", () => {
	const assigns: StrategySettings["assign"][] = [
		undefined,
		{ guidance: ["default"], seed: "trial-1" },
		{ guidance: ["compact"], seed: "trial-1" },
		{ guidance: ["fold", "compact"], seed: "trial-1" },
		{ guidance: ["compaction-only-v1", "folds-v1"], seed: "trial-2" },
		{ guidance: Array<string>(17).fill("compact"), seed: "trial-1" },
		{ guidance: ["default", "turbo"], seed: "" },
	];
	const sessions: StrategySettings["session"][] = [
		undefined,
		...SESSIONS.map(fresh),
		{ id: "sess-2", fresh: false, recorded: { guidance: "default", seed: "trial-1", variants: ["default"], drawnFor: "sess-2" } },
		{ id: "sess-2", fresh: false, recorded: null, retired: 1 },
	];
	const bases: StrategySettings[] = [{}, { methods: ["compact"] }, { methods: ["fold"] }, { engine: "compaction-only" }, { engine: "folds" }, { methods: ["turbo"] }];
	let checked = 0;
	for (const tools of [bcpAbsent, bcpLoaded]) {
		for (const base of bases) {
			const without = resolve(tools, base);
			for (const assigned of assigns) {
				for (const session of sessions) {
					const settings: StrategySettings = { ...base, ...(assigned ? { assign: assigned } : {}), ...(session ? { session } : {}) };
					const found = resolve(tools, settings);
					const label = JSON.stringify({ bcp: tools === bcpLoaded, settings });
					assert.deepEqual([...found.methods], [...without.methods], label);
					assert.equal(found.source, without.source, label);
					assert.equal(found.contradictsPresence, without.contradictsPresence, label);
					checked += 1;
				}
			}
		}
	}
	assert.equal(checked, 2 * 6 * 7 * 9);
});

test("a retired recipe assignment on the branch gets one debug note and changes nothing", () => {
	const found = resolve(bcpAbsent, { session: { id: "sess-2", fresh: false, recorded: null, retired: 2 } });
	assert.deepEqual([...found.methods], ["fold", "compact"]);
	assert.deepEqual(strategyErrorLines(found), []);
	assert.deepEqual(strategyDebugLines(found), ["strategy: ignored 2 recipe assignment entries of the first version (context-aware.strategy-assignment.v1); methods are never drawn."]);
	assert.deepEqual(strategyDebugLines(resolve(bcpAbsent, {})), []);
});

/**
 * A fold engine over a project file, with a session whose branch takes the entries the engine appends. The agent
 * dir is the fixture's own, so the host's context-aware.json (which may set strategy.assign) is never read;
 * `global` is written there as the global layer.
 */
function engineIn(t: { after(fn: () => void): void }, settings: Record<string, unknown>, session: { id?: string; trusted?: boolean | "throws" | "absent"; branch?: unknown[]; global?: Record<string, unknown> } = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-assign-")));
	t.after(() => removeFixtureDir(root));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	if (session.global) fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify(session.global));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
	fs.mkdirSync(path.join(root, ".pi"));
	fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify(settings));
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const branch: unknown[] = [...(session.branch ?? [])];
	const appended: { customType: string; data: unknown }[] = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getAllTools: () => bcpAbsent,
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
			branch.push({ type: "custom", id: `c${branch.length}`, parentId: null, timestamp: "t", customType, data });
		},
	} as unknown as ExtensionAPI;
	const notices: string[][] = [];
	const debug: string[][] = [];
	const engine = registerFoldEngine(pi, { onStrategyErrors: (_ctx, lines) => { notices.push([...lines]); }, onStrategyDebug: (_ctx, lines) => { debug.push([...lines]); } });
	const trusted = session.trusted ?? true;
	const ctx = {
		cwd: root,
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => session.id ?? "sess-2" },
		...(trusted === "absent" ? {} : { isProjectTrusted: () => { if (trusted === "throws") throw new Error("no answer"); return trusted; } }),
	} as unknown as ExtensionContext;
	const start = () => { for (const handler of handlers.get("session_start") ?? []) handler({}, ctx); };
	return { engine, ctx, start, appended, branch, notices, debug };
}
const assigned = { strategy: { assign: { guidance: ["default"], seed: "trial-1" } } };
const message = { type: "message", id: "m1", parentId: null, timestamp: "t", message: { role: "user", content: "hi" } };

test("a new session records its draw once, at session start, and keeps both methods", (t) => {
	const { engine, ctx, start, appended } = engineIn(t, assigned);
	start();
	assert.deepEqual(appended, [{ customType: ASSIGNMENT_ENTRY_TYPE, data: { schemaVersion: 2, guidance: "default", seed: "trial-1", variants: ["default"], drawnFor: "sess-2" } }]);
	assert.equal(engine.mode(ctx), "live");
	assert.deepEqual([...engine.engine(ctx).strategy.methods], ["fold", "compact"]);
	assert.deepEqual(engine.engine(ctx).strategy.assignment, { seed: "trial-1", variants: ["default"], drawnFor: "sess-2", recorded: true });
	start();
	assert.equal(appended.length, 1, "a reload finds the entry and writes no second one");
});

test("a session that already has messages and no assignment is not drawn and gets no entry", (t) => {
	const { engine, ctx, start, appended } = engineIn(t, assigned, { branch: [message] });
	start();
	assert.deepEqual(appended, []);
	assert.equal(engine.engine(ctx).strategy.assignment, undefined);
});

test("a session whose branch holds a first-version recipe assignment runs its configured methods and gets one debug note", (t) => {
	const { engine, ctx, start, appended, notices, debug } = engineIn(t, {}, { branch: [entry(v1, V1_ENTRY_TYPE), message] });
	start();
	assert.deepEqual([...engine.engine(ctx).strategy.methods], ["fold", "compact"], "the entry drew compaction-only-v1; it is ignored");
	assert.equal(engine.mode(ctx), "live");
	assert.deepEqual(debug, [["strategy: ignored 1 recipe assignment entries of the first version (context-aware.strategy-assignment.v1); methods are never drawn."]]);
	assert.deepEqual([appended, notices], [[], []]);
});

test("an untrusted project's own file cannot assign guidance; a trust lookup that throws or is missing counts as untrusted", (t) => {
	for (const trusted of [false, "throws", "absent"] as const) {
		const { engine, ctx, start, appended } = engineIn(t, assigned, { trusted });
		start();
		assert.deepEqual(appended, [], String(trusted));
		assert.equal(engine.engine(ctx).strategy.assignment, undefined, String(trusted));
	}
	const { engine, ctx, start } = engineIn(t, { strategy: { methods: ["compact"] } }, { trusted: false });
	start();
	assert.deepEqual([...engine.engine(ctx).strategy.methods], ["fold", "compact"], "an untrusted project's file cannot set the methods either (pi-context-aware#525)");
});

test("the global strategy.assign in the agent dir assigns an untrusted project's session", (t) => {
	const { engine, ctx, start, appended } = engineIn(t, assigned, { trusted: false, global: { strategy: { assign: { guidance: ["default"], seed: "host-trial" } } } });
	start();
	assert.equal(engine.engine(ctx).strategy.assignment?.seed, "host-trial");
	assert.deepEqual(appended.map((entry) => (entry.data as { seed: string }).seed), ["host-trial"], "the project's seed is not the one recorded");
});

test("a list over the cap writes no entry and reports one error; at the cap its draw is recorded once and kept on resume", (t) => {
	const over = engineIn(t, { strategy: { assign: { guidance: Array<string>(18).fill("default"), seed: "trial-1" } } }, { id: "sess-1" });
	over.start();
	over.start();
	assert.deepEqual(over.appended, []);
	assert.deepEqual(over.notices[0], ["Error: strategy.assign.guidance lists 18 ids; at most 16 are allowed. No guidance is drawn."]);
	const at = engineIn(t, { strategy: { assign: { guidance: Array<string>(16).fill("default"), seed: "trial-1" } } }, { id: "sess-1" });
	at.start();
	at.start();
	assert.equal(at.appended.length, 1, "a reload before the first message finds the entry and writes no second one");
	at.branch.push(message);
	at.start();
	assert.equal(at.engine.engine(at.ctx).strategy.assignment?.recorded, true);
	assert.equal(at.appended.length, 1);
});
