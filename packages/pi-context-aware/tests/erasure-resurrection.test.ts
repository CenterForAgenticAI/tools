import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionDatabase } from "../src/erasure/database.js";
import { registerSessionErasure } from "../src/erasure/extension.js";
import { paritySessionFile } from "../src/parity/records.js";
import { eraseSession } from "../src/erasure/session-erasure.js";
import { restoredErasedSessions } from "../src/erasure/restored.js";

// These tests refuse sessions on purpose. Without UI, a refusal sets process.exitCode = 1, which node:test reads as a failed file.
let exitCodeBefore: typeof process.exitCode;
beforeEach(() => { exitCodeBefore = process.exitCode; });
afterEach(() => { process.exitCode = exitCodeBefore; });

for (const kind of ["transcript", "orphan", "side", "parity"] as const) {
	test(`startup and refused shutdown report restored ${kind} without deleting it; re-erasure needs consent`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-restored-"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
		const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
		const notices: string[] = [];
		let consent = false;
		let confirmations = 0;
		let shutdowns = 0;
		const file = path.join(root, "sessions", "project", "2026-01-01T00-00-00-000Z_gone.jsonl");
		const restored = kind === "transcript" || kind === "orphan" ? file : kind === "side" ? `${file}.acp.json` : paritySessionFile(root, "gone");
		const contents = kind === "transcript" ? '{"type":"session","version":3,"id":"gone","timestamp":"2026-01-01","cwd":"/test"}\n' : kind === "orphan" ? '{"type":"thinking_level_change","thinkingLevel":"off"}\n' : "Restored backup";
		const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI;
		const ctx = { hasUI: true, sessionManager: { getSessionId: () => "gone", getSessionFile: () => file }, shutdown: () => { shutdowns++; }, ui: { notify: (message: string) => notices.push(message), confirm: async () => { confirmations++; return consent; } } } as unknown as ExtensionContext;
		try {
			const db = new SessionDatabase(root); db.erase(["gone"]); db.close();
			fs.mkdirSync(path.dirname(restored), { recursive: true }); fs.writeFileSync(restored, contents);
			registerSessionErasure(pi, () => root, async () => {});
			await handlers.get("session_start")!({}, ctx);
			assert.equal(shutdowns, 1);
			assert.ok(notices.some((notice) => notice.includes(restored) && notice.includes("/session-erase gone")), notices.join("\n"));
			assert.equal(fs.readFileSync(restored, "utf8"), contents);
			notices.length = 0;
			await handlers.get("session_shutdown")!({}, ctx);
			assert.ok(notices.some((notice) => notice.includes(restored) && notice.includes("/session-erase gone")), notices.join("\n"));
			assert.equal(fs.readFileSync(restored, "utf8"), contents);
			// Re-erase from a different session, never the refused current one.
			const other = { ...ctx, sessionManager: { getSessionId: () => "other", getSessionFile: () => null } } as unknown as ExtensionContext;
			await commands.get("session-erase")!.handler("gone", other);
			assert.equal(confirmations, 1);
			assert.match(notices.at(-1)!, /cancelled/u);
			assert.equal(fs.readFileSync(restored, "utf8"), contents);
			consent = true;
			await commands.get("session-erase")!.handler("gone", other);
			assert.equal(confirmations, 2);
			assert.match(notices.at(-1)!, /Session erasure: complete/u);
			assert.equal(fs.existsSync(restored), false);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("ledgered id can be re-erased without a discovery row or transcript", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-ledgered-"));
	try {
		const db = new SessionDatabase(root); db.erase(["gone"]); db.close();
		const file = paritySessionFile(root, "gone");
		fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "Restored parity");
		let confirmations = 0;
		const receipt = await eraseSession({ agentDir: root, sessionId: "gone", currentSessionId: "other", sessions: [], confirm: async () => { confirmations++; return true; } });
		assert.equal(receipt.status, "complete", JSON.stringify(receipt));
		assert.equal(confirmations, 1); assert.equal(fs.existsSync(file), false);
		const unknown = await eraseSession({ agentDir: root, sessionId: "unknown", currentSessionId: "other", sessions: [], confirm: async () => { throw new Error("must not ask"); } });
		assert.equal(unknown.status, "refused");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("re-erasure removes all restored transcripts for the id but refuses another valid header", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-restored-copies-"));
	try {
		const db = new SessionDatabase(root); db.erase(["gone"]); db.close();
		const sessions = ["first", "second"].map((name) => ({ id: "gone", path: path.join(root, `${name}.jsonl`) }));
		for (const source of sessions) fs.writeFileSync(source.path, '{"type":"session","id":"gone"}\n');
		const receipt = await eraseSession({ agentDir: root, sessionId: "gone", currentSessionId: "other", sessions, confirm: async () => true });
		assert.equal(receipt.status, "complete");
		for (const source of sessions) assert.equal(fs.existsSync(source.path), false);
		const file = path.join(root, "gone.jsonl"); fs.writeFileSync(file, '{"type":"session","id":"not-gone"}\n');
		const refused = await eraseSession({ agentDir: root, sessionId: "gone", currentSessionId: "other", sessions: [{ id: "gone", path: file }], confirm: async () => { throw new Error("must refuse before consent"); } });
		assert.equal(refused.status, "refused"); assert.equal(fs.readFileSync(file, "utf8"), '{"type":"session","id":"not-gone"}\n');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("side-only restore detection does not attribute another id's filename suffix", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-side-id-"));
	try {
		const db = new SessionDatabase(root); db.erase(["gone"]); db.close();
		const directory = path.join(root, "sessions", "project"); fs.mkdirSync(directory, { recursive: true });
		for (const name of ["other_gone.jsonl.acp.json", "2026-01-01T00-00-00-000Z_other_gone.jsonl.acp.json"]) fs.writeFileSync(path.join(directory, name), "Other session backup");
		assert.deepEqual(restoredErasedSessions(root), []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("refused tool_call blocks and terminates tools belonging to other extensions", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-tools-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "gone", getSessionFile: () => null }, shutdown: () => {}, ui: { notify: () => {} } } as unknown as ExtensionContext;
	try {
		const db = new SessionDatabase(root); db.erase(["gone"]); db.close();
		registerSessionErasure(pi, () => root, async () => {});
		assert.equal(await handlers.get("tool_call")!({ toolName: "write" }, ctx), undefined);
		await handlers.get("session_start")!({}, ctx);
		for (const toolName of ["write", "session_tasks", "external-tool"]) {
			assert.deepEqual(await handlers.get("tool_call")!({ toolName }, ctx), { block: true, terminate: true, reason: "Session activation refused; all tools are blocked." });
		}
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
