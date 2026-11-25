import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHostPi, FakeFabric } from "./compaction-owner-harness.js";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";

// pi-context-aware#461: every consumer reads the request's one pressure value, the count of the view the fold
// pass sent, and not Pi's usage. Each session here disagrees on purpose: Pi says under 1% of the window, the
// view the fold pass sends is about 60% of it. A consumer that reads Pi's usage again turns its test red.

const WINDOW = 200_000;
/** Pi's count: 1,000 of 200,000 tokens. */
const HOST_TOKENS = 1_000;

type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type StatusTool = { execute: (id: string, params: { view: string }, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details: { fraction: number | null; tokens: number | null } }> };

let loads = 0;

/**
 * The real extension over a real in-memory session, live fold engine, with Pi's usage far below the sent view.
 * `config` is written to context-aware.json; `fabric` adds a stand-in Fabric for the compaction-owner claim.
 */
async function withSession(
	options: { config?: Record<string, unknown>; fabric?: boolean },
	body: (s: Awaited<ReturnType<typeof start>>) => Promise<void>,
): Promise<void> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pressure-consumers-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ contextCache: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...options.config }));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, lineage: process.env.PI_FABRIC_LINEAGE, depth: process.env.PI_FABRIC_DEPTH };
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// A Fabric child refuses proactive compaction; these are foreground sessions.
	delete process.env.PI_FABRIC_LINEAGE;
	delete process.env.PI_FABRIC_DEPTH;
	try {
		await body(await start(root, options.fabric === true));
	} finally {
		if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (previous.lineage === undefined) delete process.env.PI_FABRIC_LINEAGE; else process.env.PI_FABRIC_LINEAGE = previous.lineage;
		if (previous.depth === undefined) delete process.env.PI_FABRIC_DEPTH; else process.env.PI_FABRIC_DEPTH = previous.depth;
		await removeFixtureDir(root);
	}
}

async function start(root: string, withFabric: boolean) {
	const host = createHostPi();
	const commands = new Map<string, unknown>();
	Object.assign(host.api, { registerCommand(name: string, definition: unknown) { commands.set(name, definition); } });
	const fabric = withFabric ? new FakeFabric(host.bus, {}) : undefined;
	const extension = await import(`../src/index.js?pressure-consumers=${Date.now()}-${++loads}`);
	extension.default(host.api);
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Opening.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Answer."));
	// About 60% of the window, with headroom for the default output reserve.
	manager.appendMessage({ role: "user", content: "Large tool output. ".repeat(25_000), timestamp: 2 });
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: string[] = [];
	let aborts = 0;
	const ctx = {
		hasUI: true, cwd: root, sessionManager: manager,
		model: { id: "pressure-model", contextWindow: WINDOW, maxTokens: 1_000 },
		getContextUsage: () => ({ tokens: HOST_TOKENS, contextWindow: WINDOW }),
		isProjectTrusted: () => true, isIdle: () => true, abort: () => { aborts++; }, compact() {},
		ui: { notify: (message: string) => { notifications.push(message); }, setStatus: (name: string, value: string | undefined) => { statuses.push([name, value]); }, setWidget() {} },
	} as unknown as ExtensionContext;
	await host.handler("session_start")({ reason: "startup" }, ctx);
	await fabric?.flush();
	/** Send one request through the context hooks and return the percent its action line states. */
	const send = async (): Promise<number> => {
		const sent = await host.handler("context")({ type: "context", messages: manager.buildSessionContext().messages }, ctx) as { messages?: Array<{ content: unknown }> } | undefined;
		const content = sent?.messages?.at(-1)?.content;
		const text = Array.isArray(content) ? (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("") : String(content ?? "");
		const percent = /Context pressure WARN \((\d+)% used/u.exec(text)?.[1];
		assert.ok(percent, "the request carries a WARN action line from the sent view: " + text.slice(0, 200));
		return Number(percent);
	};
	const footer = (): string | undefined => [...statuses].reverse().find(([name]) => name === "caair.context-aware/context-pressure")?.[1];
	const refreshPressure = async (): Promise<void> => {
		await host.handler("context")({ type: "context", messages: manager.buildSessionContext().messages }, ctx);
		await host.handler("model_select")({}, ctx);
	};
	return { host, commands, fabric, manager, ctx, send, footer, refreshPressure, notifications, aborts: () => aborts };
}

test("the footer shows the sent view's pressure, not Pi's usage", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		assert.ok(percent >= 50 && percent < 75, "the fixture is in the WARN band: " + percent);
		await s.host.handler("model_select")({}, s.ctx);
		assert.equal(s.footer(), "🟡 " + percent + "%", "Pi's 1,000 tokens would be 🟢 1%");
	});
});

test("the footer is hidden below WARN when there is no entry-limit note", async () => {
	await withSession({ config: { pressureLadder: { foldNudgeStartFraction: 0.7 } } }, async (s) => {
		await s.refreshPressure();
		assert.equal(s.footer(), undefined);
	});
});

test("the footer shows the entry-limit note below WARN", async () => {
	await withSession({ config: { entryPressure: { maxEntriesSinceCompaction: 1_000 }, pressureLadder: { foldNudgeStartFraction: 0.7 } } }, async (s) => {
		for (let index = 0; index < 1_000; index++) s.manager.appendCustomEntry("pressure-consumer-entry", {});
		await s.refreshPressure();
		const footer = s.footer() ?? "";
		assert.match(footer, /^🔴 1k entries · \d+%$/u);
		assert.ok(Number(/(\d+)%$/u.exec(footer)?.[1]) < 70, "entry-limit status remains visible below WARN: " + footer);
	});
});

test("the footer remains visible at the configured WARN edge", async () => {
	await withSession({ config: { pressureLadder: { foldNudgeStartFraction: 0.55 } } }, async (s) => {
		// Before the first request, pressure reads Pi's measured count directly.
		Object.assign(s.ctx, { getContextUsage: () => ({ tokens: 109_999, contextWindow: WINDOW }) });
		await s.host.handler("model_select")({}, s.ctx);
		assert.equal(s.footer(), undefined, "rounding to 55% does not move a value into WARN");
		Object.assign(s.ctx, { getContextUsage: () => ({ tokens: 110_000, contextWindow: WINDOW }) });
		await s.host.handler("model_select")({}, s.ctx);
		assert.equal(s.footer(), "🟡 55%", "exactly 110,000 of 200,000 tokens reaches WARN");
	});
});

test("the footer returns when pressure rises from below WARN to WARN", async () => {
	await withSession({ config: { pressureLadder: { foldNudgeStartFraction: 0.7 } } }, async (s) => {
		await s.refreshPressure();
		assert.equal(s.footer(), undefined);
		s.manager.appendMessage({ role: "user", content: "More context. ".repeat(15_000), timestamp: 3 });
		await s.refreshPressure();
		assert.match(s.footer() ?? "", /^🟡 \d+%$/u);
	});
});

test("context_status reports the sent view's pressure, not Pi's usage", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		const status = s.host.tools.get("context_status") as StatusTool | undefined;
		assert.ok(status, "context_status is registered at session_start");
		const result = await status.execute("c", { view: "pressure" }, new AbortController().signal, undefined, s.ctx);
		assert.equal(Math.round((result.details.fraction ?? 0) * 100), percent);
		assert.notEqual(result.details.tokens, HOST_TOKENS);
	});
});

test("/context-status reports the sent view's pressure, not Pi's usage", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		await (s.commands.get("context-status") as Command).handler("", s.ctx);
		const status = s.notifications.at(-1) ?? "";
		const stated = /tokens \((\d+(?:\.\d)?)%\)/u.exec(status)?.[1];
		assert.ok(stated, status.slice(0, 200));
		assert.equal(Math.round(Number(stated)), percent, "Pi's count would say 0.5%");
	});
});

test("the check-in prompt reports the sent view's pressure, not Pi's usage", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		await (s.commands.get("checkin") as Command).handler("", s.ctx);
		await s.host.handler("agent_settled")({}, s.ctx);
		const prompt = String(s.host.userMessages.at(-1) ?? "");
		assert.match(prompt, new RegExp("Context pressure: " + percent + "% used", "u"));
	});
});

test("the context service snapshot reports the sent view's pressure, not Pi's usage", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		const service = discoverContextAwareServiceV1(s.host.bus, "pressure-consumers-test");
		assert.ok(service);
		const pressure = service.getSnapshot().pressure as { band: string; fraction: number | null; tokens: number | null };
		assert.equal(pressure.band, "WARN", "Pi's count would be OK");
		assert.equal(Math.round((pressure.fraction ?? 0) * 100), percent);
	});
});

test("the compaction owner's pressure reports the sent view's ladder stage, not Pi's usage", async () => {
	await withSession({ config: { compactionClaim: { enabled: true } }, fabric: true }, async (s) => {
		await s.send();
		const pressure = await s.fabric!.call("pressure", undefined, s.ctx) as { stage: string };
		assert.equal(pressure.stage, "fold-nudges", "about 60% is between the fold-nudge start and end; Pi's 0.5% is below the ladder");
	});
});

/**
 * A reply and a tool result of about `tokens` tokens after the request, on the branch and in the turn_end event
 * Pi sends for that turn.
 */
function grow(manager: SessionManager, tokens: number) {
	const message = fauxAssistantMessage("Reading.", { stopReason: "toolUse" });
	const text = "More tool output. ".repeat(Math.ceil(tokens / 4.5));
	manager.appendMessage(message);
	manager.appendMessage({ role: "user", content: text, timestamp: 3 });
	return { type: "turn_end", message, toolResults: [{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 }] };
}

test("turn_end runs no preview pass while pressure is far below the proactive threshold", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		// The default threshold is 90%: about 60%, a 10k-token turn and the margin stay far below it.
		await s.host.handler("turn_end")(grow(s.manager, 10_000), s.ctx);
		assert.equal(s.footer(), "🟡 " + percent + "%", "a preview pass would have recorded the grown branch");
		assert.equal(s.aborts(), 0);
	});
});

test("turn_end runs no preview pass while proactive compaction is off", async () => {
	await withSession({ config: { proactiveCompaction: { enabled: false, thresholdFraction: 0.5 } } }, async (s) => {
		const percent = await s.send();
		await s.host.handler("turn_end")(grow(s.manager, 50_000), s.ctx);
		assert.equal(s.footer(), "🟡 " + percent + "%", "a preview pass would have recorded the grown branch");
		assert.equal(s.aborts(), 0);
	});
});

test("turn_end runs the preview pass when one turn's tool result carries the session past the threshold", async () => {
	await withSession({}, async (s) => {
		const percent = await s.send();
		assert.ok(percent < 75, "the request alone is far below the default 90% threshold: " + percent);
		// One 70k-token tool result: far more than a typical request adds, as in the pilot's scripted edit.
		await s.host.handler("turn_end")(grow(s.manager, 70_000), s.ctx);
		const shown = Number(/(\d+)%/u.exec(s.footer() ?? "")?.[1]);
		assert.ok(shown >= 90, "the preview counted the tool result: " + s.footer());
		assert.ok(s.aborts() > 0, "proactive compaction fired on this turn, not one request later");
	});
});

test("turn_end runs the preview pass near the proactive threshold and compacts on its count", async () => {
	await withSession({ config: { proactiveCompaction: { thresholdFraction: 0.65 } } }, async (s) => {
		const percent = await s.send();
		assert.ok(percent < 65, "the request alone is below the threshold: " + percent);
		await s.host.handler("turn_end")(grow(s.manager, 20_000), s.ctx);
		const shown = Number(/(\d+)%/u.exec(s.footer() ?? "")?.[1]);
		assert.ok(shown >= 65, "the preview counted the reply and tool result: " + s.footer());
		assert.ok(s.aborts() > 0, "proactive compaction fired on the preview's count");
	});
});
