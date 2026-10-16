import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry } from "../src/platform/config-layers.js";
import { readParityRecords } from "../src/parity/records.js";

function harness(dir: string) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, definition); } } as unknown as ExtensionAPI;
	// A real session file with a valid side file: an unusable pre-state never reaches the context capture.
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	const original = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	fs.writeFileSync(`${manager.getSessionFile()}.acp.json`, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: { byRef: { m00001: original } } }));
	const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 200_000 } } as unknown as ExtensionContext;
	const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir: dir, fingerprint: "test" });
	const emit = (name: string, event: unknown, context = ctx) => handlers.get(name)!(event, context);
	return { manager, ctx, recorder, emit, commands };
}
const call = { type: "tool_call", toolName: "compress", toolCallId: "call", input: { content: [] } };
const result = { type: "tool_result", toolName: "compress", toolCallId: "call", content: [{ type: "text", text: "failed" }], isError: true };

test("context capture failures stay attached to the original calls, not fabricated compress calls", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-recorder-"));
	try {
		const { ctx, recorder, emit } = harness(dir);
		assert.equal(emit("tool_call", call), undefined);
		assert.equal(emit("tool_result", result), undefined);
		const broken = { ...ctx, sessionManager: new Proxy(ctx.sessionManager, { get(target, key) {
			if (key === "getBranch") return () => { throw new Error("private text must not leak"); };
			const value = Reflect.get(target, key) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		} }) };
		const context = { type: "context", messages: [{ role: "user", content: "next" }] };
		assert.equal(emit("context", context, broken), undefined);
		await recorder.flush();
		const records = await readParityRecords(dir);
		assert.equal(records.filter((record) => record.kind === "compress").length, 1);
		const next = records.find((record) => record.kind === "next-request");
		assert.deepEqual(next?.toolCallIds, ["call"]);
		assert.deepEqual(next?.diffs.map((diff) => diff.kind), ["recorder-error"]);
		assert.doesNotMatch(JSON.stringify(records), /private text/u);
		assert.deepEqual(context.messages, [{ role: "user", content: "next" }]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("recorder settings reach previews, persist folded-opening evidence and reset the command window", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-settings-"));
	try {
		const { manager, ctx, recorder, emit, commands } = harness(dir);
		for (let i = 0; i < 12; i++) manager.appendMessage({ role: "user", content: `history-${i} ${"long history ".repeat(2500)}`, timestamp: 1 });
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "fold" }));
		const ids = manager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.id);
		const side = `${manager.getSessionFile()}.acp.json`;
		const refs = { byRef: Object.fromEntries(ids.map((id, i) => [`m${String(i + 1).padStart(5, "0")}`, id])) };
		fs.writeFileSync(side, JSON.stringify({ schemaVersion: 1, blocks: [], messageRefs: refs }));
		emit("tool_call", { ...call, input: { content: [{ startId: "m00001", endId: "m00004", summary: "The opening exchange settled; keep the agreed decisions and values for the next phase." }] } });
		fs.writeFileSync(side, JSON.stringify({ schemaVersion: 1, messageRefs: refs, blocks: [{ blockId: "b1", runId: "r1", tier: 1, active: true, summary: "settled", compressCallId: "call", effectiveMessageIds: ids.slice(0, 4), directBlockIds: [] }] }));
		emit("tool_result", { ...result, isError: false, content: [{ type: "text", text: "▣ ACP | 30K → 1K tokens (blocks: b1=m00001–m00004)" }] });
		await recorder.flush();
		emit("context", { messages: [{ role: "user", content: "original <acp>m00001</acp>" }, ...manager.buildSessionContext().messages.slice(4)] });
		await recorder.flush();
		const records = await readParityRecords(dir);
		const next = records.find((record) => record.kind === "next-request");
		assert.equal(next?.ours?.firstUserFolded?.role, "user");
		assert.equal(next?.ours?.firstUserFolded?.hash, "0682c5f2076f", "SHA-256 prefix of the literal opening, original");
		assert.equal(next?.ours?.messages[0]?.summary, true);
		assert.equal(next?.ours?.activeFoldCount, 1);
		assert.deepEqual(next?.ours?.activeFoldIds, ["b1"]);
		assert.equal(next?.ours?.activeFoldIdsCapped, false);
		const compress = records.find((record) => record.kind === "compress");
		assert.deepEqual(compress?.ours?.createdIds, ["b1"]);
		assert.match(compress?.ours?.coverageHash ?? "", /^[a-f0-9]{64}$/u);
		assert.equal(compress?.ours?.coverageHash, compress?.bcp?.coverageHash);
		assert.deepEqual(next?.ours?.expectedSummaryHashes, ["1d83e75de459"]);
		assert.deepEqual(next?.ours?.expectedSummaryTopicHashes, ["67915b1640e0"]);
		assert.equal(next?.ours?.firstUserReplacementHash, "1d83e75de459");
		assert.doesNotMatch(JSON.stringify(records), /long history|opening exchange/u);
		let notice = "";
		const commandCtx = { ...ctx, ui: { notify(message: string) { notice = message; } } } as unknown as ExtensionContext;
		await commands.get("fold-parity")!.handler("", commandCtx);
		assert.match(notice, /count 1\/500/u);
		manager.appendCustomEntry(CONFIG_POLICY_ENTRY_TYPE, configPolicyEntry("session", { "folds.firstUserMessage": "keep" }));
		await commands.get("fold-parity")!.handler("", commandCtx);
		assert.match(notice, /count 0\/500/u);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("session lifecycle resets clear pending calls without affecting inputs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-reset-"));
	try {
		const { recorder, emit } = harness(dir);
		const input = structuredClone(call);
		assert.equal(emit("tool_call", input), undefined);
		emit("session_start", {});
		emit("tool_result", result);
		await recorder.flush();
		assert.deepEqual(await readParityRecords(dir), []);
		assert.deepEqual(input, call);
		emit("tool_call", input);
		emit("session_shutdown", {});
		emit("tool_result", result);
		await recorder.flush();
		assert.deepEqual(await readParityRecords(dir), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
