import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { createFoldTurnMemory, prepareFoldTurn, type FoldTurnResult } from "../src/folds/fold-turn.js";
import { pressureActionLine, requestPressure, type RequestPressure } from "../src/folds/request-pressure.js";
import { cacheBreakpointBeforeInjection } from "../src/folds/cache-breakpoint.js";

// pi-context-aware#461: one pressure value per request, computed by the fold pass from the view it sends.

const LADDER = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };
const BOTH = { fold: true, compact: true };

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : "")).join("") : "";
}

test("the band follows the ladder; only a host count Pi has not measured is UNKNOWN", () => {
	const at = (tokens: number, measured = true, source: RequestPressure["source"] = "fold-pass") => requestPressure({ tokens, window: 1_000, measured, source }, LADDER);
	assert.equal(at(449).band, "OK");
	assert.equal(at(450).band, "WARN");
	assert.equal(at(899).band, "WARN");
	assert.equal(at(900).band, "URGENT");
	assert.equal(at(0, false, "host").band, "UNKNOWN");
	const estimated = at(600, false, "fold-pass");
	assert.equal(estimated.band, "WARN", "the fold pass counts the view it sends even before Pi measures it");
	assert.equal(estimated.unmeasured, true, "so compaction still waits for a measured size (#168)");
	assert.equal(at(600).unmeasured, undefined);
});

test("the action line: nothing at OK, at UNKNOWN or when off; one line naming only reachable tools at WARN and URGENT", () => {
	const at = (tokens: number, measured = true) => requestPressure({ tokens, window: 1_000_000, measured, source: measured ? "fold-pass" : "host" }, LADDER);
	const line = (pressure: RequestPressure, tools = BOTH, mode: "full" | "band" | "off" = "full", replacementTool?: string) =>
		pressureActionLine(pressure, { mode, tools, foldTool: "context_fold", ...(replacementTool ? { replacementTool } : {}) });
	assert.equal(line(at(100_000)), undefined, "OK");
	assert.equal(line(at(0, false)), undefined, "UNKNOWN");
	assert.equal(line(at(500_000), BOTH, "off"), undefined, "off");
	const warn = line(at(500_000))!;
	assert.equal(warn.split("\n").length, 1, "one line");
	assert.match(warn, /^\[context-aware extension, not user input\] Context pressure WARN \(50% used, about 500k tokens of headroom\)\. /u, "the line labels itself as extension-written, not user input");
	assert.match(warn, /fold finished ranges with `context_fold`, call `context_compact` at a clean boundary, or delegate bounded work\.$/u);
	assert.equal(line(at(500_000), BOTH, "band"), "[context-aware extension, not user input] Context pressure WARN. Before broad reads, long test loops or a phase switch, keep the next action small, fold finished ranges with `context_fold`, call `context_compact` at a clean boundary, or delegate bounded work.");
	assert.match(line(at(950_000))!, /URGENT \(95% used[^\n]*call `context_compact`, unless/u);
	assert.match(line(at(950_000), { fold: true, compact: false })!, /fold finished, older ranges with `context_fold`/u);
	assert.doesNotMatch(line(at(950_000), { fold: true, compact: false })!, /context_compact/u);
	assert.match(line(at(950_000), { fold: false, compact: false }, "full", "extensions.compress(...)")!, /call extensions\.compress\(\.\.\.\) on finished, older ranges/u);
	assert.match(line(at(950_000), { fold: false, compact: false })!, /Finish only the atomic edit or validation in progress/u);
});

// pi-context-aware#441: the entry count since the last compaction is pressure apart from tokens.
test("an entry count at its limit makes the request URGENT at any size and the action line names it", () => {
	const entries = (entriesSinceCompaction: number) => ({ entriesSinceCompaction, limit: 1_000, exceeded: entriesSinceCompaction >= 1_000 });
	const at = (tokens: number, count: number | null, measured = true, source: RequestPressure["source"] = "fold-pass") =>
		requestPressure({ tokens, window: 1_000_000, measured, source, entries: count === null ? null : entries(count) }, LADDER);
	assert.equal(at(50_000, 999).band, "OK", "under the limit the size decides");
	assert.equal(at(50_000, 999).entries, undefined, "and the pressure carries no entry count");
	assert.equal(at(50_000, null).band, "OK", "the check off");
	const over = at(50_000, 1_200);
	assert.equal(over.band, "URGENT");
	assert.deepEqual(over.entries, entries(1_200));
	assert.equal(over.fraction, 0.05, "the size is still the size");
	assert.equal(at(50_000, 1_200, false).band, "URGENT", "the fold pass counted the request, measured or not");
	assert.equal(at(0, 1_200, false, "host").band, "UNKNOWN", "a host count Pi has not measured stays UNKNOWN");
	assert.deepEqual(at(0, 1_200, false, "host").entries, entries(1_200), "and still carries the count, for the footer");
	assert.equal(pressureActionLine(at(0, 1_200, false, "host"), { mode: "full", tools: BOTH, foldTool: "context_fold" }), undefined, "an UNKNOWN request sends no line");
	const line = (pressure: RequestPressure, tools = BOTH, mode: "full" | "band" = "full") => pressureActionLine(pressure, { mode, tools, foldTool: "context_fold", replacementTool: "extensions.compress(...)" });
	assert.equal(line(over), "[context-aware extension, not user input] Context pressure URGENT (1200 entries since the last compaction, at the limit of 1000; 5% used, about 950k tokens of headroom). Before the next nontrivial tool call, call `context_compact`, unless you are finishing one atomic edit or validation that is unsafe to interrupt.");
	assert.equal(line(over, BOTH, "band"), "[context-aware extension, not user input] Context pressure URGENT (entry count at its limit). Before the next nontrivial tool call, call `context_compact`, unless you are finishing one atomic edit or validation that is unsafe to interrupt.");
	// A fold adds entries, so without context_compact the line names no fold and no fold-like replacement.
	const noCompact = line(over, { fold: true, compact: false })!;
	assert.doesNotMatch(noCompact, /context_fold|compress/u);
	assert.match(noCompact, /Only a compaction lowers this count, and none can be called here. Finish only the atomic edit or validation in progress[^\n]*tell the user that the session needs a compaction.$/u);
	assert.match(line(at(950_000, 999), { fold: true, compact: false })!, /fold finished, older ranges with `context_fold`/u, "a size-only URGENT still offers the fold");
});

/** The fold engine in live mode over a real in-memory session, with a metrics observer that records what it is given. */
function liveEngine(root: string, hostTokens: number | null, bigText: string) {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand() {},
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Answer."));
	manager.appendMessage({ role: "user", content: bigText, timestamp: 2 });
	const ctx = { sessionManager: manager, cwd: root, model: { id: "pressure-model", contextWindow: 1_000 }, getContextUsage: () => ({ tokens: hostTokens }) } as unknown as ExtensionContext;
	const observed: Array<{ turn: FoldTurnResult | undefined; pressure: RequestPressure | null }> = [];
	const engine = registerFoldEngine(api, {
		ladder: () => LADDER,
		tools: () => ({ reachable: ["context_fold", "context_compact"], registered: ["context_fold", "context_compact"] }),
		metrics: { onTurn: (_ctx, turn, pressure) => observed.push({ turn, pressure }) },
	});
	const send = () => {
		const messages = manager.buildSessionContext().messages;
		let result: { messages?: unknown[] } | undefined;
		for (const handler of handlers.get("context") ?? []) result = handler({ type: "context", messages }, ctx) as typeof result;
		return result?.messages ?? messages;
	};
	return { ctx, engine, observed, send };
}

test("REQ-ENV-002: when host usage and the sent view disagree, the action line, the metrics record and the next-request value all read the sent view", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "request-pressure-")));
	try {
		// Pi says 1% of the window; the view the fold pass sends is over half of it.
		const live = liveEngine(root, 10, "Large tool output. ".repeat(120));
		const sent = live.send();
		assert.equal(live.observed.length, 1, "one value per request");
		const [{ turn, pressure }] = live.observed as [{ turn: FoldTurnResult | undefined; pressure: RequestPressure }];
		assert.equal(pressure.source, "fold-pass");
		assert.ok(turn, "the pass ran");
		assert.equal(pressure.tokens, turn.tokens?.before, "the pressure is the count of the view the pass sent");
		assert.notEqual(pressure.tokens, 10, "not Pi's count");
		assert.equal(pressure.band, "WARN", "Pi's 1% would be OK");
		const percent = Math.round(pressure.fraction * 100);
		const injected = sent.filter((message) => textOf(message).includes("[context-aware extension, not user input] Context pressure "));
		assert.equal(injected.length, 1, "one injection");
		assert.equal(sent.at(-1), injected[0], "after the last session message");
		assert.match(textOf(injected[0]), new RegExp(`Context pressure WARN \\(${percent}% used`, "u"), "the line reads the same value");
		assert.equal(live.engine.pressure(live.ctx), pressure, "context_status, the check-in and the footer read this same value");
		assert.equal(live.engine.nextPressure(live.ctx)?.tokens, pressure.tokens, "proactive compaction reads the same count for the same view");
		assert.equal(live.observed.length, 1, "the next-request value is not a request: no second metrics record");
	} finally {
		await removeFixtureDir(root);
	}
});

test("an unknown size sends no action line", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "request-pressure-unknown-")));
	try {
		const live = liveEngine(root, null, "Small.");
		const sent = live.send();
		assert.equal(sent.some((message) => textOf(message).includes("Context pressure")), false);
		assert.equal(live.observed[0]?.pressure?.unmeasured, true);
		assert.equal(live.observed[0]?.pressure?.band, "OK", "the fold pass still counts the small view it sends");
	} finally {
		await removeFixtureDir(root);
	}
});

test("with a fold nudge due, the nudge and the action line arrive as one message after the last session message", () => {
	// Four large archived exchanges and a short tail at 83% of a 120k window: past the ladder's
	// fold-nudge end, so the over-limit nudge is due, and the band is WARN.
	const manager = SessionManager.inMemory("/tmp");
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system");
	let pressure: RequestPressure | undefined;
	let line: string | undefined;
	const turn = prepareFoldTurn({
		messages, projection: manager.buildSessionProjection(), branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		model: { contextWindow: 120_000 }, systemPromptTokens: 0, hostTokens: 100_000, memory: createFoldTurnMemory(),
		config: { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 },
		// The recipe's two says, as folds-v1 gives them: the growth nudge, then the pressure note (pi-context-aware#472).
		stages: (request) => {
			pressure = requestPressure({ tokens: request.tokenCount, window: 120_000, measured: true, source: "fold-pass" });
			line = pressureActionLine(pressure, { mode: "full", tools: BOTH, foldTool: "context_fold" });
			return [request.growthNudge?.render(BOTH), line].filter((text): text is string => text !== undefined);
		},
	});
	assert.ok(turn?.nudge, "the fixture is past the nudge threshold");
	assert.equal(pressure?.band, "WARN");
	assert.ok(line);
	assert.equal(turn.messages.length, messages.length + 1, "one injection");
	const injected = turn.messages.filter((message) => textOf(message).includes(turn.nudge!));
	assert.equal(injected.length, 1);
	assert.equal(textOf(injected[0]), turn.nudge + "\n\n" + line, "the nudge and the action line share the message");
	assert.equal(turn.messages.at(-1), injected[0], "after the last session message");
});

test("REQ-ENV-002: proactive compaction reads the sent view's pressure, not Pi's disagreeing count", async () => {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "request-pressure-proactive-")));
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ proactiveCompaction: { thresholdFraction: 0.5 } }));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, lineage: process.env.PI_FABRIC_LINEAGE, depth: process.env.PI_FABRIC_DEPTH };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// A Fabric child refuses proactive compaction; this is a foreground session.
	delete process.env.PI_FABRIC_LINEAGE;
	delete process.env.PI_FABRIC_DEPTH;
	try {
		const extension = await import("../src/index.js");
		const handlers = new Map<string, Handler[]>();
		const api = {
			events: { emit() {}, on: () => () => {} },
			registerFlag() {}, getFlag: () => undefined,
			on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerTool() {}, registerCommand() {}, getCommands: () => [], sendMessage() {}, sendUserMessage() {},
			getActiveTools: () => ["read"], getAllTools: () => [], setActiveTools() {}, async setModel() { return true; }, appendEntry() {},
		} as unknown as ExtensionAPI;
		extension.default(api);
		const manager = SessionManager.inMemory(home);
		manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Answer."));
		// About 60% of a 200k window, with headroom for the default output reserve, so only the threshold can fire.
		manager.appendMessage({ role: "user", content: "Large tool output. ".repeat(25_000), timestamp: 2 });
		let aborts = 0;
		const ctx = {
			hasUI: false, cwd: home, sessionManager: manager,
			model: { id: "pressure-model", contextWindow: 200_000, maxTokens: 1_000 },
			// Pi says under 1%; the view the fold pass sends is over half the window.
			getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000 }),
			isProjectTrusted: () => true, isIdle: () => false, abort: () => { aborts++; }, compact() {},
			ui: { notify() {}, setStatus() {}, setWidget() {} },
		} as unknown as ExtensionContext;
		const dispatch = async (name: string, event: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
			return result;
		};
		await dispatch("session_start", {});
		const sent = await dispatch("context", { type: "context", messages: manager.buildSessionContext().messages }) as { messages?: unknown[] } | undefined;
		const line = textOf(sent?.messages?.at(-1));
		assert.match(line, /Context pressure WARN/u, "the request's action line reads the sent view");
		// The provider payload keeps its cache breakpoint before the line, which the next request will not repeat.
		const payload = { messages: [
			{ role: "user", content: [{ type: "text", text: "Opening." }] },
			{ role: "assistant", content: [{ type: "text", text: "Answer." }] },
			{ role: "user", content: [{ type: "text", text: "Large tool output." }, { type: "text", text: line, cache_control: { type: "ephemeral" } }] },
		] };
		const provided = await dispatch("before_provider_request", { type: "before_provider_request", payload }) as typeof payload | undefined;
		const lastContent = provided?.messages.at(-1)?.content as Array<{ text: string; cache_control?: unknown }> | undefined;
		assert.deepEqual(lastContent?.map((block) => block.cache_control !== undefined), [true, false], "the breakpoint moved off the injection");
		await dispatch("turn_end", { message: { stopReason: "toolUse" } });
		assert.ok(aborts > 0, "proactive compaction fired on the sent view's pressure, which Pi's 1% would not");
		await dispatch("session_shutdown", {});
	} finally {
		if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (previous.lineage === undefined) delete process.env.PI_FABRIC_LINEAGE; else process.env.PI_FABRIC_LINEAGE = previous.lineage;
		if (previous.depth === undefined) delete process.env.PI_FABRIC_DEPTH; else process.env.PI_FABRIC_DEPTH = previous.depth;
		await removeFixtureDir(home);
	}
});

/** A copy of a session saved before pi-context-aware#461: its last usage marker says URGENT. */
function oldSession(root: string): SessionManager {
	const file = path.join(root, "usage-marker.jsonl");
	fs.copyFileSync(new URL("../../tests/fixtures/old-session/usage-marker.jsonl", import.meta.url), file);
	return SessionManager.open(file, root);
}

const isMarker = (message: unknown): boolean => (message as { customType?: unknown }).customType === "context-aware-usage-marker";

for (const mode of ["live", "shadow"] as const) {
	test("a resumed session's persisted URGENT usage marker is not sent to the model (" + mode + " mode)", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "request-pressure-old-marker-")));
		try {
			const manager = oldSession(root);
			const handlers = new Map<string, Handler[]>();
			const api = {
				on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerCommand() {},
				// Pi refuses tool lookups while extensions load; the engine then stays in shadow mode.
				getAllTools: () => { if (mode === "shadow") throw new Error("tools are not readable yet"); return []; },
			} as unknown as ExtensionAPI;
			const ctx = { sessionManager: manager, cwd: root, model: { id: "pressure-model", contextWindow: 200_000 }, getContextUsage: () => ({ tokens: 2_000 }) } as unknown as ExtensionContext;
			const engine = registerFoldEngine(api, { ladder: () => LADDER, tools: () => ({ reachable: ["context_fold", "context_compact"], registered: ["context_fold", "context_compact"] }) });
			assert.equal(engine.mode(ctx), mode);
			const messages = manager.buildSessionContext().messages;
			assert.equal(messages.filter(isMarker).length, 1, "the fixture's history holds one marker");
			let result: { messages?: unknown[] } | undefined;
			for (const handler of handlers.get("context") ?? []) result = handler({ type: "context", messages }, ctx) as typeof result;
			const sent = result?.messages ?? messages;
			assert.equal(sent.filter(isMarker).length, 0, "the marker is not sent");
			assert.doesNotMatch(JSON.stringify(sent), /context-telemetry|URGENT/u, "no stale band reaches the model");
			assert.equal(sent.length, messages.length - 1, "only the marker is left out");
			assert.equal(engine.pressure(ctx)?.band, "OK", "the request is at OK, which the stale marker would contradict");
			const persisted = manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "context-aware-usage-marker");
			assert.equal(persisted.length, 1, "the session file keeps the marker");
			assert.equal((persisted[0] as { display?: unknown }).display, false, "and its display setting");
		} finally {
			await removeFixtureDir(root);
		}
	});
}

test("the cache breakpoint moves off the injection to the block before it, and nothing else moves", () => {
	const cc = { type: "ephemeral" };
	const text = (value: string, marked = false) => ({ type: "text", text: value, ...(marked ? { cache_control: cc } : {}) });
	const LINE = "[context-aware extension, not user input] Context pressure WARN. Keep the next action small.";
	const sameMessage = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }, text(LINE, true)] }] };
	const moved = cacheBreakpointBeforeInjection(sameMessage, LINE) as typeof sameMessage;
	assert.deepEqual(moved.messages[0]!.content.map((block) => "cache_control" in block), [true, false]);
	assert.equal("cache_control" in sameMessage.messages[0]!.content[0]!, false, "the input is not changed");
	const ownMessage = { messages: [{ role: "assistant", content: [text("Done.")] }, { role: "user", content: [text(LINE, true)] }] };
	const across = cacheBreakpointBeforeInjection(ownMessage, LINE) as typeof ownMessage;
	assert.deepEqual(across.messages.map((message) => message.content.map((block) => "cache_control" in block)), [[true], [false]]);
	assert.equal(cacheBreakpointBeforeInjection({ messages: [{ role: "user", content: [text("A"), text("Some other text", true)] }] }, LINE), undefined, "another last block is left alone");
	assert.equal(cacheBreakpointBeforeInjection({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }, { role: "user", content: [text(LINE, true)] }] }, LINE), undefined, "a thinking block cannot carry the breakpoint");
	assert.equal(cacheBreakpointBeforeInjection({ input: [] }, LINE), undefined, "another payload shape is left alone");
});

test("the breakpoint never moves onto an image part (Anthropic and OpenAI-compatible payloads)", () => {
	const cc = { type: "ephemeral" };
	const LINE = "[context-aware extension, not user input] Context pressure WARN. Keep the next action small.";
	const anthropicImage = { messages: [{ role: "user", content: [{ type: "text", text: "Look." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }, { role: "user", content: [{ type: "text", text: LINE, cache_control: cc }] }] };
	assert.equal(cacheBreakpointBeforeInjection(anthropicImage, LINE), undefined, "an Anthropic image block is not a move target");
	const openAiImage = { messages: [{ role: "user", content: [{ type: "text", text: "Look." }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }, { role: "user", content: [{ type: "text", text: LINE, cache_control: cc }] }] };
	assert.equal(cacheBreakpointBeforeInjection(openAiImage, LINE), undefined, "an OpenAI-compatible image_url part is not a move target");
	const sameMessageImage = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: LINE, cache_control: cc }] }] };
	assert.equal(cacheBreakpointBeforeInjection(sameMessageImage, LINE), undefined, "nor in the same message");
	const openAiText = { messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }, { role: "user", content: [{ type: "text", text: LINE, cache_control: cc }] }] };
	const moved = cacheBreakpointBeforeInjection(openAiText, LINE) as typeof openAiText;
	assert.deepEqual(moved.messages.map((message) => message.content.map((part) => "cache_control" in part)), [[true], [false]], "a text part receives it");
	const toolString = { messages: [{ role: "tool", tool_call_id: "t1", content: "out" }, { role: "user", content: [{ type: "text", text: LINE, cache_control: cc }] }] };
	assert.equal(cacheBreakpointBeforeInjection(toolString, LINE), undefined, "a string message is left alone");
});

test("Bedrock: the cache point moves before the injection, and never onto an image", () => {
	const point = { cachePoint: { type: "default" } };
	const LINE = "[context-aware extension, not user input] Context pressure WARN. Keep the next action small.";
	type Payload = { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
	const points = (payload: Payload) => payload.messages.flatMap((message) => message.content).filter((block) => "cachePoint" in block).length;
	const kinds = (payload: Payload) => payload.messages.map((message) => message.content.map((block) => Object.keys(block)[0]));
	// Tool results and the injection in one user message: the point goes between them.
	const sameMessage: Payload = { messages: [
		{ role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "read", input: {} } }] },
		{ role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "out" }] } }, { text: LINE }, point] },
	] };
	const moved = cacheBreakpointBeforeInjection(sameMessage, LINE) as Payload;
	assert.deepEqual(kinds(moved), [["toolUse"], ["toolResult", "cachePoint", "text"]]);
	assert.equal(points(moved), 1, "moved, not added");
	assert.deepEqual(kinds(sameMessage), [["toolUse"], ["toolResult", "text", "cachePoint"]], "the input is not changed");
	// The injection in its own message: the point ends the message before it.
	const ownMessage: Payload = { messages: [{ role: "user", content: [{ text: "Continue." }] }, { role: "user", content: [{ text: LINE }, point] }] };
	const across = cacheBreakpointBeforeInjection(ownMessage, LINE) as Payload;
	assert.deepEqual(kinds(across), [["text", "cachePoint"], ["text"]]);
	assert.equal(points(across), 1);
	const image: Payload = { messages: [{ role: "user", content: [{ text: "Look." }, { image: { format: "png", source: { bytes: "AAAA" } } }] }, { role: "user", content: [{ text: LINE }, point] }] };
	assert.equal(cacheBreakpointBeforeInjection(image, LINE), undefined, "an image block is not a move target");
	const other: Payload = { messages: [{ role: "user", content: [{ text: "Another last block." }, point] }] };
	assert.equal(cacheBreakpointBeforeInjection(other, LINE), undefined, "another last block is left alone");
});

test("managed-effort runs move the breakpoint across all injections without changing markers", () => {
	const cc = { type: "ephemeral", ttl: "1h" };
	const marker = { role: "system", content: [], output_config: { effort: "high" } };
	const injections = ["pressure line", "fold nudge", "operator reminder"];
	const payload = { messages: [
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
		marker, marker,
		{ role: "user", content: [{ type: "text", text: injections[0] }, { type: "text", text: injections[1] }] },
		marker,
		{ role: "user", content: [{ type: "text", text: injections[2], cache_control: cc }] },
		marker, marker,
	] };
	const original = structuredClone(payload);
	assert.deepEqual(cacheBreakpointBeforeInjection(payload, injections), { messages: [
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {}, cache_control: cc }] },
		marker, marker,
		{ role: "user", content: [{ type: "text", text: injections[0] }, { type: "text", text: injections[1] }] },
		marker,
		{ role: "user", content: [{ type: "text", text: injections[2] }] },
		marker, marker,
	] });
	assert.deepEqual(payload, original, "the input stays unchanged");
});

test("empty user and assistant messages are barriers, not effort markers", () => {
	const own = { role: "user", content: [{ type: "text", text: "session text" }] };
	const reminder = { role: "user", content: [{ type: "text", text: "reminder", cache_control: { type: "ephemeral" } }] };
	const marker = { role: "system", content: [], output_config: { effort: "high" } };
	for (const role of ["user", "assistant"]) {
		const barrier = { role, content: [] };
		assert.equal(cacheBreakpointBeforeInjection({ messages: [own, reminder, barrier, marker] }, "reminder"), undefined, `${role} tail is not skipped`);
		assert.equal(cacheBreakpointBeforeInjection({ messages: [own, barrier, marker, reminder, marker] }, "reminder"), undefined, `${role} historical barrier is not skipped`);
	}
});

test("a trailing effort marker does not enable a Bedrock-shaped payload", () => {
	const payload = { messages: [
		{ role: "user", content: [{ text: "session text" }] },
		{ role: "user", content: [{ text: "reminder" }, { cachePoint: { type: "default" } }] },
		{ role: "system", content: [], output_config: { effort: "high" } },
	] };
	const original = structuredClone(payload);
	assert.equal(cacheBreakpointBeforeInjection(payload, "reminder"), undefined);
	assert.deepEqual(payload, original);
});

test("several trailing injections, the pressure line then the operator reminder: the breakpoint moves before all of them", () => {
	const cc = { type: "ephemeral" };
	const LINE = "[context-aware extension, not user input] Context pressure WARN. Keep the next action small.";
	const REMINDER = "Open operator request (3 min ago). The operator wrote: \"status?\" Answer it before continuing other work; a stopped run does not close it.";
	const injected = [LINE, REMINDER];
	type Payload = { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
	const marks = (payload: Payload) => payload.messages.map((message) => message.content.map((block) => "cache_control" in block));
	const ownMessages: Payload = { messages: [
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
		{ role: "user", content: [{ type: "text", text: LINE }] },
		{ role: "user", content: [{ type: "text", text: REMINDER, cache_control: cc }] },
	] };
	assert.deepEqual(marks(cacheBreakpointBeforeInjection(ownMessages, injected) as Payload), [[true], [false], [false]]);
	assert.deepEqual(marks(ownMessages), [[false], [false], [true]], "the input is not changed");
	const oneMessage: Payload = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }, { type: "text", text: LINE }, { type: "text", text: REMINDER, cache_control: cc }] }] };
	assert.deepEqual(marks(cacheBreakpointBeforeInjection(oneMessage, injected) as Payload), [[true, false, false]]);
	const reminderOnly: Payload = { messages: [{ role: "user", content: [{ type: "text", text: "status?" }] }, { role: "user", content: [{ type: "text", text: REMINDER, cache_control: cc }] }] };
	assert.deepEqual(marks(cacheBreakpointBeforeInjection(reminderOnly, injected) as Payload), [[true], [false]], "either injection may be absent");
	const sessionTextBetween: Payload = { messages: [{ role: "user", content: [{ type: "text", text: LINE }, { type: "text", text: "session text" }, { type: "text", text: REMINDER, cache_control: cc }] }] };
	assert.deepEqual(marks(cacheBreakpointBeforeInjection(sessionTextBetween, injected) as Payload), [[false, true, false]], "only the trailing run of injections is skipped");
	assert.equal(cacheBreakpointBeforeInjection({ messages: [{ role: "user", content: [{ type: "text", text: LINE }, { type: "text", text: REMINDER, cache_control: cc }] }] }, injected), undefined, "nothing before the injections: left alone");
	const point = { cachePoint: { type: "default" } };
	const kinds = (payload: Payload) => payload.messages.map((message) => message.content.map((block) => Object.keys(block)[0]));
	const bedrockOwn: Payload = { messages: [
		{ role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "out" }] } }] },
		{ role: "user", content: [{ text: LINE }] },
		{ role: "user", content: [{ text: REMINDER }, point] },
	] };
	assert.deepEqual(kinds(cacheBreakpointBeforeInjection(bedrockOwn, injected) as Payload), [["toolResult", "cachePoint"], ["text"], ["text"]]);
	const bedrockOne: Payload = { messages: [{ role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "out" }] } }, { text: LINE }, { text: REMINDER }, point] }] };
	assert.deepEqual(kinds(cacheBreakpointBeforeInjection(bedrockOne, injected) as Payload), [["toolResult", "cachePoint", "text", "text"]]);
});