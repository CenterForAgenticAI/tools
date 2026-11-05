import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import type { FoldEmergency } from "../src/folds/fold-turn.js";
import type { Config } from "../src/folds/kernel/index.js";

// pi-context-aware#244: the kernel's terminal escape needs three stuck requests in a row. The count lives in
// the engine's per-session memory. A new session, a move in the session tree and a request below the last
// ladder step each end the run, so the escape is not raised on a count that spans a break.

const CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function stuckSession(): SessionManager {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendMessage({ role: "user", content: "Start.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Ready."));
	manager.appendMessage({ role: "user", content: "Large paste. " + "y".repeat(200_000), timestamp: 1 });
	return manager;
}

function boot() {
	const handlers = new Map<string, Handler[]>();
	const api = { on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, getAllTools: () => [] } as unknown as ExtensionAPI;
	const emergencies: FoldEmergency[] = [];
	registerFoldEngine(api, { config: CONFIG, onEmergency: (_ctx, emergency) => { emergencies.push(emergency); } });
	const manager = stuckSession();
	let hostTokens = 191_000;
	const ctx = { cwd: "/tmp", sessionManager: manager, model: { contextWindow: 200_000 }, getContextUsage: () => ({ tokens: hostTokens }) } as unknown as ExtensionContext;
	const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system");
	return {
		/** One provider request at this host usage; the terminal escape the pass reported, if any. */
		request(tokens: number): string | undefined {
			hostTokens = tokens;
			const before = emergencies.length;
			for (const handler of handlers.get("context") ?? []) handler({ type: "context", messages }, ctx);
			return emergencies.length > before ? emergencies[emergencies.length - 1]!.terminalEscape : undefined;
		},
		fire(name: string) { for (const handler of handlers.get(name) ?? []) handler({}, ctx); },
	};
}

const STUCK = 191_000;

test("the terminal escape fires on the third stuck request in a row (the control for the reset tests)", () => {
	const engine = boot();
	assert.equal(engine.request(STUCK), undefined);
	assert.equal(engine.request(STUCK), undefined);
	assert.match(engine.request(STUCK) ?? "", /compression cannot reduce this context below the limit/u);
});

test("session_start ends the run of stuck requests", () => {
	const engine = boot();
	engine.request(STUCK);
	engine.request(STUCK);
	engine.fire("session_start");
	assert.equal(engine.request(STUCK), undefined, "the count began again, so this is the first stuck request");
});

test("session_tree ends the run of stuck requests", () => {
	const engine = boot();
	engine.request(STUCK);
	engine.request(STUCK);
	engine.fire("session_tree");
	assert.equal(engine.request(STUCK), undefined, "the count began again, so this is the first stuck request");
});

test("a request below the last ladder step ends the run of stuck requests", () => {
	const engine = boot();
	engine.request(STUCK);
	engine.request(STUCK);
	engine.request(100_000);
	assert.equal(engine.request(STUCK), undefined, "the count began again, so this is the first stuck request");
});
