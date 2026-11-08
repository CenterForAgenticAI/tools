import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { readParityRecords } from "../src/parity/records.js";

// pi-context-aware#244: the extension hands the ladder in config to the shadow parity recorder, so the
// preview of the next request nudges by the user's ladder. Running the real extension with
// billion-context-pi's tools present (shadow mode) goes red when src/index.ts stops passing it.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const LATE = { foldNudgeStartFraction: 0.9, foldNudgeEndFraction: 0.93, seededCompactionFraction: 0.94, recoverableHideFraction: 0.95 };

function session(dir: string): SessionManager {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	for (let i = 1; i <= 4; i++) {
		manager.appendMessage({ role: "user", content: "Archive " + i + ". " + "Invented archive review text. ".repeat(1_200), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Reviewed " + i + ". " + "Invented archive answer text. ".repeat(1_200)));
	}
	manager.appendMessage({ role: "user", content: "Continue.", timestamp: 1 });
	const ids = manager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id);
	fs.writeFileSync(`${manager.getSessionFile()}.acp.json`, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id])) } }));
	return manager;
}

async function previewedRequestLength(ladder: unknown): Promise<number | undefined> {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-parity-ladder-")));
	const agentDir = path.join(home, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ summarizer: { enabled: false }, proactiveCompaction: { enabled: false }, contextCache: { enabled: false }, restartNotice: { enabled: false }, sessionNaming: { scope: "off" }, workstream: { enabled: false }, ...(ladder ? { pressureLadder: ladder } : {}) }));
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR, lineage: process.env.PI_FABRIC_LINEAGE, depth: process.env.PI_FABRIC_DEPTH };
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_FABRIC_LINEAGE;
	delete process.env.PI_FABRIC_DEPTH;
	try {
		const handlers = new Map<string, Handler[]>();
		const bcpTool = (name: string) => ({ name, sourceInfo: { path: "/profile/node_modules/billion-context-pi/dist/index.js" } });
		const api = {
			events: { emit() {}, on: () => () => {} },
			registerFlag() {}, getFlag: () => undefined,
			on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerTool() {}, registerCommand() {}, getCommands: () => [], sendMessage() {}, sendUserMessage() {},
			getActiveTools: () => ["read"], getAllTools: () => [bcpTool("compress"), bcpTool("acp_status")], setActiveTools() {},
			async setModel() { return true; }, appendEntry() {},
		} as unknown as ExtensionAPI;
		const extension = await import("../src/index.js");
		extension.default(api);
		const manager = session(home);
		// The first request is quiet, so the nudge is not already shown when the request under test arrives.
		let hostTokens = 10_000;
		const ctx = {
			hasUI: false, cwd: home, model: { contextWindow: 120_000 },
			getContextUsage: () => ({ tokens: hostTokens, contextWindow: 120_000 }), getSystemPrompt: () => "",
			isProjectTrusted: () => true, isIdle: () => false, abort() {}, compact() {},
			ui: { notify() {}, setStatus() {}, setWidget() {} }, sessionManager: manager,
		} as unknown as ExtensionContext;
		const emit = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
		const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system");
		await emit("context", { type: "context", messages });
		await emit("tool_call", { type: "tool_call", toolName: "compress", toolCallId: "trigger", input: { content: [] } });
		await emit("tool_result", { type: "tool_result", toolName: "compress", toolCallId: "trigger", content: [{ type: "text", text: "failed" }], isError: true });
		hostTokens = 100_000;
		await emit("context", { type: "context", messages });
		for (let attempt = 0; attempt < 100; attempt++) {
			const next = (await readParityRecords(agentDir)).find((record) => record.kind === "next-request");
			if (next) return next.ours?.messages.length;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return undefined;
	} finally {
		if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (previous.lineage === undefined) delete process.env.PI_FABRIC_LINEAGE; else process.env.PI_FABRIC_LINEAGE = previous.lineage;
		if (previous.depth === undefined) delete process.env.PI_FABRIC_DEPTH; else process.env.PI_FABRIC_DEPTH = previous.depth;
		await removeFixtureDir(home);
	}
}

test("the extension previews the next request with the ladder in config", async () => {
	assert.equal(await previewedRequestLength(undefined), 10, "the default ladder is past its nudge start at 83%: the nudge is in the preview");
	assert.equal(await previewedRequestLength(LATE), 9, "a ladder that starts nudging at 90% leaves 83% without a nudge");
});
