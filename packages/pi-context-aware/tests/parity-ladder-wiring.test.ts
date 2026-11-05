import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFoldEngine } from "../src/folds/fold-engine.js";
import type { Config } from "../src/folds/kernel/index.js";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { readParityRecords } from "../src/parity/records.js";
import { DEFAULT_PRESSURE_LADDER, type PressureLadderConfig } from "../src/policy/context-policy.js";

// pi-context-aware#244: the shadow preview reads the same pressure ladder as the live pass. The ladder
// travels from the recorder option through previewTurn and the comparison to the fold pass; each test
// below goes red when one of those hand-offs is removed, because the preview then nudges by the default ladder.

const TURN_CONFIG: Partial<Config> = { compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 }, preserveRecentMessages: 2, preserveRecentTokens: 0 };
const LATE: PressureLadderConfig = { ...DEFAULT_PRESSURE_LADDER, foldNudgeStartFraction: 0.9, foldNudgeEndFraction: 0.93, seededCompactionFraction: 0.94 };
const call = { type: "tool_call", toolName: "compress", toolCallId: "trigger", input: { content: [] } };
const result = { type: "tool_result", toolName: "compress", toolCallId: "trigger", content: [{ type: "text", text: "failed" }], isError: true };

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

/** The next-request record the preview writes at 83% of a 120k window, for the ladder the recorder was given. */
async function nextRequest(ladder: PressureLadderConfig | undefined) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-ladder-"));
	try {
		const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
		const api = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand() {},
			getAllTools() { return [{ name: "compress" }, { name: "acp_status" }]; },
		} as unknown as ExtensionAPI;
		const manager = session(dir);
		let hostTokens = 60_000;
		const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 120_000 }, getContextUsage: () => ({ tokens: hostTokens }) } as unknown as ExtensionContext;
		const engine = registerFoldEngine(api, { config: TURN_CONFIG });
		const recorder = registerFoldParityRecorder(api, { engine, agentDir: dir, fingerprint: "ladder", limits: { maxSnapshots: 8 }, ...(ladder ? { ladder: () => ladder } : {}) });
		const emit = (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
		const messages = manager.buildSessionContext().messages.filter((message) => message.role !== "system");
		emit("context", { type: "context", messages });
		emit("tool_call", call);
		emit("tool_result", result);
		await recorder.flush();
		hostTokens = 100_000;
		emit("context", { type: "context", messages });
		await recorder.flush();
		return (await readParityRecords(dir)).find((record) => record.kind === "next-request");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("the preview nudges by the default ladder when none is given: the fixture sits past its 45% start", async () => {
	const next = await nextRequest(undefined);
	assert.equal(next?.ours?.messages.length, 10, JSON.stringify(next));
});

test("the preview reads the ladder it is given: a ladder that starts nudging at 90% sends no nudge at 83%", async () => {
	const next = await nextRequest(LATE);
	assert.equal(next?.ours?.messages.length, 9, "no nudge message: the preview used the given ladder, not the default");
});
