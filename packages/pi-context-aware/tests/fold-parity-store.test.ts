import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFoldParityRecorder } from "../src/parity/recorder.js";
import { appendParityRecord, PARITY_RECORD_VERSION, paritySessionFile, readParityRecords, type CompressRecord } from "../src/parity/records.js";

const record = (sessionId: string): CompressRecord => ({ v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "test", sessionId, at: "2026-01-01", toolCallId: "call", nested: false, verdict: "match", diffs: [] });
function scratch() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "parity-store-")));
	const agentDir = path.join(root, "agent");
	const outside = path.join(root, "outside");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(outside);
	return { root, agentDir, outside };
}

test("a symlinked diagnostics file is rejected and the link target is untouched", async () => {
	const { root, agentDir, outside } = scratch();
	try {
		await appendParityRecord(agentDir, record("real"));
		const target = path.join(outside, "target.jsonl");
		fs.writeFileSync(target, "ORIGINAL\n");
		fs.symlinkSync(target, paritySessionFile(agentDir, "redirect"));
		await assert.rejects(appendParityRecord(agentDir, record("redirect")), /parity store/u);
		assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL\n");
		await assert.rejects(readParityRecords(agentDir), /parity store/u);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a hard-linked diagnostics file is rejected", async () => {
	const { root, agentDir, outside } = scratch();
	try {
		await appendParityRecord(agentDir, record("real"));
		const target = path.join(outside, "target.jsonl");
		fs.writeFileSync(target, "ORIGINAL\n");
		fs.linkSync(target, paritySessionFile(agentDir, "linked"));
		await assert.rejects(appendParityRecord(agentDir, record("linked")), /parity store/u);
		assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL\n");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a symlinked store directory is rejected for writes and reads", async () => {
	const { root, agentDir, outside } = scratch();
	try {
		fs.symlinkSync(outside, path.join(agentDir, "fold-parity"));
		await assert.rejects(appendParityRecord(agentDir, record("redirect")), /parity store/u);
		assert.deepEqual(fs.readdirSync(outside), []);
		await assert.rejects(readParityRecords(agentDir), /parity store/u);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
	const second = scratch();
	try {
		await appendParityRecord(second.agentDir, record("real"));
		const sessions = path.dirname(paritySessionFile(second.agentDir, "real"));
		fs.rmSync(sessions, { recursive: true });
		fs.symlinkSync(second.outside, sessions);
		await assert.rejects(appendParityRecord(second.agentDir, record("redirect")), /parity store/u);
		assert.deepEqual(fs.readdirSync(second.outside), []);
	} finally { fs.rmSync(second.root, { recursive: true, force: true }); }
});

test("a redirected store never fails the live call", async () => {
	const { root, agentDir, outside } = scratch();
	try {
		fs.symlinkSync(outside, path.join(agentDir, "fold-parity"));
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir, fingerprint: "test" });
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const ctx = { sessionManager: manager, cwd: root, model: { contextWindow: 200_000 } } as unknown as ExtensionContext;
		assert.equal(handlers.get("tool_call")!({ toolName: "compress", toolCallId: "call", input: { content: [] } }, ctx), undefined);
		assert.equal(handlers.get("tool_result")!({ toolName: "compress", toolCallId: "call", content: [{ type: "text", text: "No ranges provided." }], isError: false }, ctx), undefined);
		assert.equal(handlers.get("context")!({ messages: [{ role: "user", content: "next" }] }, ctx), undefined);
		await recorder.flush();
		assert.deepEqual(fs.readdirSync(outside), []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/**
 * Swap a store directory for a symlink to `outside` right after the store has checked the
 * directory named `after` (by lstat or by opening it), before anything below it is opened. This is the
 * check-then-open window a same-user process would race.
 */
function swapAfterCheck(after: string, victim: string, outside: string) {
	const checks = ["open", "lstat"] as const;
	const originals = Object.fromEntries(checks.map((name) => [name, fs.promises[name]])) as Record<(typeof checks)[number], (...args: unknown[]) => Promise<unknown>>;
	let armed = true;
	for (const name of checks) {
		Reflect.set(fs.promises, name, async (...args: unknown[]) => {
			const result = await originals[name](...args);
			if (armed && String(args[0]).endsWith(`/${after}`)) {
				armed = false;
				fs.renameSync(victim, `${victim}-original`);
				fs.symlinkSync(outside, victim);
			}
			return result;
		});
	}
	syncBuiltinESMExports();
	return {
		get fired() { return !armed; },
		restore() { for (const name of checks) Reflect.set(fs.promises, name, originals[name]); syncBuiltinESMExports(); },
	};
}

test("swapping the sessions directory after it is checked cannot redirect a write or a read", async () => {
	const { root, agentDir, outside } = scratch();
	const sessions = path.dirname(paritySessionFile(agentDir, "race"));
	await appendParityRecord(agentDir, record("real"));
	const race = swapAfterCheck("sessions", sessions, outside);
	try {
		await appendParityRecord(agentDir, record("race"));
		assert.ok(race.fired, "the swap ran between the check and the open");
		assert.deepEqual(fs.readdirSync(outside), [], "nothing is written through the swapped-in link");
		assert.deepEqual(fs.readdirSync(`${sessions}-original`).sort(), ["race.jsonl", "real.jsonl"], "the write lands in the directory that was checked");
	} finally { race.restore(); }
	// Read: the swapped-in directory holds a planted record, and the checked one holds the real records.
	fs.rmSync(sessions);
	fs.renameSync(`${sessions}-original`, sessions);
	fs.writeFileSync(path.join(outside, "planted.jsonl"), `${JSON.stringify(record("planted"))}\n`);
	const readRace = swapAfterCheck("sessions", sessions, outside);
	try {
		const records = await readParityRecords(agentDir);
		assert.ok(readRace.fired);
		assert.deepEqual(records.map((item) => item.sessionId).sort(), ["race", "real"], "planted records outside the store are never read");
	} finally { readRace.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("swapping an intermediate store directory after its parent is checked is rejected for writes and reads", async () => {
	const { root, agentDir, outside } = scratch();
	await appendParityRecord(agentDir, record("real"));
	const v1 = path.join(agentDir, "fold-parity", "v1");
	fs.mkdirSync(path.join(outside, "sessions"));
	const race = swapAfterCheck("fold-parity", v1, outside);
	try {
		await assert.rejects(appendParityRecord(agentDir, record("race")), /parity store/u);
		assert.ok(race.fired);
		assert.deepEqual(fs.readdirSync(path.join(outside, "sessions")), []);
		await assert.rejects(readParityRecords(agentDir), /parity store/u);
	} finally { race.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an ancestor swapped during a live call is rejected without failing the call", async () => {
	const { root, agentDir, outside } = scratch();
	await appendParityRecord(agentDir, record("real"));
	const v1 = path.join(agentDir, "fold-parity", "v1");
	fs.mkdirSync(path.join(outside, "sessions"));
	const race = swapAfterCheck("fold-parity", v1, outside);
	try {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const api = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
		const recorder = registerFoldParityRecorder(api, { engine: { mode: () => "shadow" }, agentDir, fingerprint: "test" });
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const ctx = { sessionManager: manager, cwd: root, model: { contextWindow: 200_000 } } as unknown as ExtensionContext;
		assert.equal(handlers.get("tool_call")!({ toolName: "compress", toolCallId: "call", input: { content: [] } }, ctx), undefined);
		assert.equal(handlers.get("tool_result")!({ toolName: "compress", toolCallId: "call", content: [{ type: "text", text: "No ranges provided." }], isError: false }, ctx), undefined);
		await recorder.flush();
		assert.ok(race.fired);
		assert.deepEqual(fs.readdirSync(path.join(outside, "sessions")), []);
	} finally { race.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
