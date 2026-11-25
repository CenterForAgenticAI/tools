import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeFixtureDir } from "./fixture-cleanup.js";
import {
	ADD_CHOICE,
	FABRIC_TOOL_PLACEMENT_EVENT,
	LATER_CHOICE,
	NEVER_CHOICE,
	createFabricForegroundCheck,
	planForegroundEdit,
	programOnly,
	queryPlacement,
	readDeclined,
	writeConfigAtomic,
	type CheckContext,
	type ForegroundRegistry,
	type ForegroundWant,
} from "../src/platform/fabric-foreground.js";

const ASK: ForegroundWant = { name: "ask", owner: "pi-question", reason: "human-input" };
const SKILL: ForegroundWant = { name: "load_skill", owner: "pi-context-aware", reason: "skill-loading" };
const COMPACT: ForegroundWant = { name: "context_compact", owner: "pi-context-aware", reason: "context-control" };

type Placement = "model" | "program" | "unavailable";

/** A bus that answers the placement query the way Fabric does, from a mutable table. */
function fabricBus(mode: "full-code" | "enforce" | "orchestration", table: Record<string, Placement>) {
	const queries: string[][] = [];
	return {
		queries,
		table,
		emit(channel: string, data: unknown) {
			if (channel !== FABRIC_TOOL_PLACEMENT_EVENT) return;
			const request = data as { tools: string[]; reply: (result: unknown) => void };
			queries.push(request.tools);
			const tools: Record<string, Placement> = {};
			for (const name of request.tools) tools[name] = table[name] ?? "unavailable";
			request.reply({ version: 1, mode, tools });
		},
	};
}

function fakeContext(answer: string | undefined, options: { cwd?: string; trusted?: boolean; session?: string; hasUI?: boolean } = {}) {
	const selects: { title: string; choices: string[] }[] = [];
	const notices: { message: string; type: string | undefined }[] = [];
	const ctx: CheckContext = {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/nonexistent-project",
		isProjectTrusted: () => options.trusted ?? false,
		sessionManager: { getSessionId: () => options.session ?? "s1" },
		ui: {
			select: async (title, choices) => { selects.push({ title, choices }); return answer; },
			notify: (message, type) => { notices.push({ message, type }); },
		},
	};
	return { ctx, selects, notices };
}

function tempHome(t: { after(fn: () => void): void }) {
	const home = mkdtempSync(join(tmpdir(), "fabric-foreground-"));
	t.after(() => removeFixtureDir(home));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	return { home, fabricJson: join(home, ".pi", "agent", "fabric.json") };
}

const freshRegistry = (): ForegroundRegistry => ({ wants: new Map(), sessions: new Map() });

test("queryPlacement returns undefined when no Fabric answers", () => {
	assert.equal(queryPlacement({ emit() {} }, ["ask"]), undefined);
	assert.equal(queryPlacement({ emit() { throw new Error("bus down"); } }, ["ask"]), undefined);
});

test("queryPlacement drops a reply with the wrong version or an unknown mode", () => {
	const reply = (result: unknown) => ({ emit: (_: string, data: unknown) => (data as { reply(r: unknown): void }).reply(result) });
	assert.equal(queryPlacement(reply({ version: 2, mode: "full-code", tools: {} }), ["ask"]), undefined);
	assert.equal(queryPlacement(reply({ version: 1, mode: "other", tools: {} }), ["ask"]), undefined);
	assert.deepEqual(queryPlacement(reply({ version: 1, mode: "full-code", tools: { ask: "program", x: "bogus" } }), ["ask"]),
		{ mode: "full-code", tools: { ask: "program" } });
});

test("programOnly flags only program-only tools in full code mode", () => {
	const wants = [ASK, SKILL, COMPACT];
	const tools: Record<string, Placement> = { ask: "model", load_skill: "program", context_compact: "unavailable" };
	assert.deepEqual(programOnly({ mode: "full-code", tools }, wants).map((w) => w.name), ["load_skill"]);
	assert.deepEqual(programOnly({ mode: "orchestration", tools }, wants), []);
	assert.deepEqual(programOnly({ mode: "enforce", tools }, wants), []);
	assert.deepEqual(programOnly(undefined, wants), []);
});

test("planForegroundEdit appends to the global file and keeps every other key", () => {
	const source = JSON.stringify({ fullCodeMode: true, foreground: { tools: [{ name: "ask", owner: "pi-question", reason: "human-input" }], maxTools: 4, note: "keep" }, mesh: { root: "x" } });
	const plan = planForegroundEdit({ global: { path: "/g/fabric.json", source } }, [SKILL]);
	assert.equal(plan.kind, "write");
	if (plan.kind !== "write") return;
	assert.equal(plan.path, "/g/fabric.json");
	assert.deepEqual(plan.added, ["load_skill"]);
	assert.equal(plan.maxTools, undefined);
	assert.deepEqual(JSON.parse(plan.text), {
		fullCodeMode: true,
		mesh: { root: "x" },
		foreground: {
			tools: [
				{ name: "ask", owner: "pi-question", reason: "human-input" },
				{ name: "load_skill", owner: "pi-context-aware", reason: "skill-loading" },
			],
			maxTools: 4,
			note: "keep",
		},
	});
});

test("planForegroundEdit creates the file content when none exists", () => {
	const plan = planForegroundEdit({ global: { path: "/g/fabric.json", source: null } }, [ASK]);
	assert.equal(plan.kind, "write");
	if (plan.kind !== "write") return;
	assert.deepEqual(JSON.parse(plan.text), { foreground: { tools: [{ name: "ask", owner: "pi-question", reason: "human-input" }] } });
});

test("planForegroundEdit raises maxTools past the default cap, never beyond 8", () => {
	const four = ["a", "b", "c", "d"].map((name) => ({ name, owner: "o", reason: "human-input" }));
	const plan = planForegroundEdit({ global: { path: "/g", source: JSON.stringify({ foreground: { tools: four } }) } }, [SKILL]);
	assert.equal(plan.kind === "write" && plan.maxTools, 5);
	if (plan.kind === "write") assert.equal(JSON.parse(plan.text).foreground.maxTools, 5);
	const eight = [..."abcdefgh"].map((name) => ({ name, owner: "o", reason: "human-input" }));
	const capped = planForegroundEdit({ global: { path: "/g", source: JSON.stringify({ foreground: { tools: eight, maxTools: 8 } }) } }, [SKILL]);
	assert.equal(capped.kind === "write" && capped.maxTools, undefined);
});

test("planForegroundEdit edits the project file when it overrides foreground", () => {
	const global = { path: "/g", source: JSON.stringify({ foreground: { tools: [] } }) };
	const project = { path: "/p", source: JSON.stringify({ foreground: { tools: [{ name: "ask", owner: "pi-question", reason: "human-input" }] }, other: 1 }) };
	const plan = planForegroundEdit({ global, project }, [ASK, SKILL]);
	assert.equal(plan.kind === "write" && plan.path, "/p");
	if (plan.kind === "write") {
		assert.deepEqual(plan.added, ["load_skill"]);
		assert.equal(JSON.parse(plan.text).other, 1);
	}
	const quietProject = { path: "/p", source: JSON.stringify({ mesh: {} }) };
	assert.equal((planForegroundEdit({ global, project: quietProject }, [ASK]) as { path?: string }).path, "/g");
});

test("planForegroundEdit reports tools already listed and refuses malformed files", () => {
	const listed = JSON.stringify({ foreground: { tools: [{ name: "ask", owner: "pi-question", reason: "human-input" }] } });
	assert.deepEqual(planForegroundEdit({ global: { path: "/g", source: listed } }, [ASK]), { kind: "listed", names: ["ask"] });
	assert.equal(planForegroundEdit({ global: { path: "/g", source: "{ nope" } }, [ASK]).kind, "blocked");
	assert.equal(planForegroundEdit({ global: { path: "/g", source: "[]" } }, [ASK]).kind, "blocked");
	assert.equal(planForegroundEdit({ global: { path: "/g", source: JSON.stringify({ foreground: [] }) } }, [ASK]).kind, "blocked");
	assert.equal(planForegroundEdit({ global: { path: "/g", source: JSON.stringify({ foreground: { tools: {} } }) } }, [ASK]).kind, "blocked");
	assert.equal(planForegroundEdit({ global: { path: "/g", source: "{}" }, project: { path: "/p", source: "{" } }, [ASK]).kind, "blocked");
});

test("writeConfigAtomic refuses to overwrite a file edited since it was read", (t) => {
	const { fabricJson } = tempHome(t);
	writeFileSync(fabricJson, "{\"a\":1}\n");
	assert.throws(() => writeConfigAtomic(fabricJson, "{}\n", "{\"a\":0}\n"), /changed while it was being edited/);
	assert.equal(readFileSync(fabricJson, "utf8"), "{\"a\":1}\n");
	writeConfigAtomic(fabricJson, "{\"a\":2}\n", "{\"a\":1}\n");
	assert.equal(readFileSync(fabricJson, "utf8"), "{\"a\":2}\n");
});

test("accepting the offer writes fabric.json, then confirms once Fabric declares the tool", async (t) => {
	const { home, fabricJson } = tempHome(t);
	writeFileSync(fabricJson, JSON.stringify({ fullCodeMode: true }));
	const bus = fabricBus("full-code", { load_skill: "program" });
	const check = createFabricForegroundCheck(bus, [SKILL], { home, env: {}, registry: freshRegistry() });
	const { ctx, selects, notices } = fakeContext(ADD_CHOICE);

	await check.onAgentEnd(ctx);
	assert.equal(selects.length, 1);
	assert.match(selects[0]?.title ?? "", /load_skill/);
	assert.match(selects[0]?.title ?? "", /~\/\.pi\/agent\/fabric\.json/);
	assert.deepEqual(selects[0]?.choices, [ADD_CHOICE, LATER_CHOICE, NEVER_CHOICE]);
	const written = JSON.parse(readFileSync(fabricJson, "utf8"));
	assert.equal(written.fullCodeMode, true);
	assert.deepEqual(written.foreground.tools, [{ name: "load_skill", owner: "pi-context-aware", reason: "skill-loading" }]);
	assert.match(notices.at(-1)?.message ?? "", /Run \/fabric reload/);

	// Before the reload nothing new is said; after it, one confirmation.
	await check.onAgentEnd(ctx);
	assert.equal(notices.length, 1);
	bus.table.load_skill = "model";
	await check.onAgentEnd(ctx);
	assert.match(notices.at(-1)?.message ?? "", /now declares load_skill/);
	await check.onAgentEnd(ctx);
	assert.equal(notices.length, 2);
	assert.equal(selects.length, 1);
});

test("several extensions share one offer per session", async (t) => {
	const { home } = tempHome(t);
	const registry = freshRegistry();
	const bus = fabricBus("full-code", { ask: "program", load_skill: "program" });
	const first = createFabricForegroundCheck(bus, [ASK], { home, env: {}, registry });
	const second = createFabricForegroundCheck(bus, [SKILL], { home, env: {}, registry });
	const { ctx, selects } = fakeContext(LATER_CHOICE);
	await Promise.all([first.onAgentEnd(ctx), second.onAgentEnd(ctx)]);
	assert.equal(selects.length, 1);
	assert.match(selects[0]?.title ?? "", /ask, load_skill/);
	// A new session asks again after "Not now".
	const next = fakeContext(LATER_CHOICE, { session: "s2" });
	await second.onAgentEnd(next.ctx);
	assert.equal(next.selects.length, 1);
});

test("declining for good is remembered across sessions", async (t) => {
	const { home, fabricJson } = tempHome(t);
	const bus = fabricBus("full-code", { ask: "program" });
	const check = createFabricForegroundCheck(bus, [ASK], { home, env: {}, registry: freshRegistry() });
	await check.onAgentEnd(fakeContext(NEVER_CHOICE).ctx);
	assert.deepEqual([...readDeclined({ home, env: {} })], ["ask"]);
	const later = fakeContext(ADD_CHOICE, { session: "s2" });
	await check.onAgentEnd(later.ctx);
	assert.equal(later.selects.length, 0);
	assert.throws(() => readFileSync(fabricJson, "utf8"), /ENOENT/);
});

test("no offer without a UI, outside full code mode, or when the tool is already declared", async (t) => {
	const { home } = tempHome(t);
	const cases = [
		{ bus: fabricBus("full-code", { ask: "program" }), hasUI: false },
		{ bus: fabricBus("orchestration", { ask: "program" }), hasUI: true },
		{ bus: fabricBus("enforce", { ask: "program" }), hasUI: true },
		{ bus: fabricBus("full-code", { ask: "model" }), hasUI: true },
		{ bus: { emit() {} }, hasUI: true },
	];
	for (const { bus, hasUI } of cases) {
		const check = createFabricForegroundCheck(bus, [ASK], { home, env: {}, registry: freshRegistry() });
		const { ctx, selects, notices } = fakeContext(ADD_CHOICE, { hasUI });
		await check.onAgentEnd(ctx);
		assert.equal(selects.length + notices.length, 0);
	}
});

test("a listed but undeclared tool gets a reload hint instead of an offer", async (t) => {
	const { home, fabricJson } = tempHome(t);
	writeFileSync(fabricJson, JSON.stringify({ foreground: { tools: [{ name: "ask", owner: "pi-question", reason: "human-input" }] } }));
	const check = createFabricForegroundCheck(fabricBus("full-code", { ask: "program" }), [ASK], { home, env: {}, registry: freshRegistry() });
	const { ctx, selects, notices } = fakeContext(ADD_CHOICE);
	await check.onAgentEnd(ctx);
	assert.equal(selects.length, 0);
	assert.match(notices[0]?.message ?? "", /\/fabric reload/);
	assert.equal(notices[0]?.type, "warning");
});

test("PI_CODING_AGENT_DIR selects the fabric.json that is edited", async (t) => {
	const { home } = tempHome(t);
	const agent = join(home, "custom-agent");
	const check = createFabricForegroundCheck(fabricBus("full-code", { ask: "program" }), [ASK], { home, env: { PI_CODING_AGENT_DIR: agent }, registry: freshRegistry() });
	await check.onAgentEnd(fakeContext(ADD_CHOICE).ctx);
	assert.equal(JSON.parse(readFileSync(join(agent, "fabric.json"), "utf8")).foreground.tools[0].name, "ask");
});
