import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionDatabase, erasedSessionIds } from "../src/erasure/database.js";
import { discoverProfileSessions, registerSessionErasure } from "../src/erasure/extension.js";
import { paritySessionFile } from "../src/parity/records.js";

test("startup does not report an unflushed current transcript as a missing closed source", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-unflushed-"));
	try {
		const manager = SessionManager.create(root, path.join(root, "sessions", "project"), { id: "current" });
		assert.equal(fs.existsSync(manager.getSessionFile()!), false);
		const notices: string[] = [];
		const ctx = { sessionManager: manager, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		const pi = { on: () => {}, registerCommand: () => {} } as unknown as ExtensionAPI;
		const protection = registerSessionErasure(pi, () => root, async () => {}, { registerStartup: false });
		await protection.start(ctx);
		assert.equal(protection.isBlocked(), false);
		assert.deepEqual(notices, []);
		assert.equal(fs.existsSync(manager.getSessionFile()!), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("profile discovery refuses a symlinked transcript without reading outside stores", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-discovery-redirect-"));
	try {
		const profile = path.join(root, "profile");
		const directory = path.join(profile, "sessions", "project");
		fs.mkdirSync(directory, { recursive: true });
		const outside = path.join(root, "outside.jsonl");
		fs.writeFileSync(outside, '{"type":"session","version":3,"id":"outside","timestamp":"2026-01-01","cwd":"/outside"}\n');
		fs.symlinkSync(outside, path.join(directory, "redirect.jsonl"));
		await assert.rejects(discoverProfileSessions(profile), /Redirected store:/u);
		assert.equal(fs.readFileSync(outside, "utf8"), '{"type":"session","version":3,"id":"outside","timestamp":"2026-01-01","cwd":"/outside"}\n');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const event of ["session_before_switch", "session_before_fork"]) {
test(`erased targets cancel ${event} before activation`, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-cancel-"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "gone" }, ui: { notify: () => {} } } as unknown as ExtensionContext;
	registerSessionErasure(pi, () => root, async () => {});
	try {
		const file = path.join(root, "gone.jsonl");
		fs.writeFileSync(file, '{"type":"session","id":"gone"}\n');
		const db = new SessionDatabase(root);
		db.erase(["gone"]);
		db.close();
		assert.deepEqual(await handlers.get(event)!({ reason: "resume", targetSessionFile: file, entryId: "entry" }, ctx), { cancel: true });
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}

// Pi lifecycle is the external boundary. The flush promise models a recorder still writing.
test("shutdown retains the open lease until queued parity writes drain", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-flush-"));
	const events = new Map<string, (_event: unknown, ctx: ExtensionContext) => Promise<void>>();
	let release: () => void = () => {};
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "open", getSessionFile: () => null }, ui: { notify: () => {} } } as unknown as ExtensionContext;
	registerSessionErasure(pi, () => root, () => pending);
	try {
		await events.get("session_start")!({}, ctx);
		const shutdown = events.get("session_shutdown")!({}, ctx);
		const db = new SessionDatabase(root);
		assert.throws(() => db.erase(["open"]), /open/u);
		release();
		await shutdown;
		db.erase(["open"]);
		assert.equal(db.isErased("open"), true);
		db.close();
	} finally { release(); fs.rmSync(root, { recursive: true, force: true }); }
});


test("session_start reports a moved session directory and preserves every derived store", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-moved-"));
	const events = new Map<string, (_event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const notices: string[] = [];
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler), registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI;
	let consent = false;
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => "current", getSessionFile: () => null }, ui: { notify: (text: string) => notices.push(text), confirm: async () => consent } } as unknown as ExtensionContext;
	const protection = registerSessionErasure(pi, () => root, async () => {});
	try {
		const project = path.join(root, "sessions", "project");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, "old.jsonl");
		fs.writeFileSync(file, '{"type":"session","id":"old"}\n');
		const side = `${file}.acp.json`;
		fs.writeFileSync(side, "SIDE");
		const parity = paritySessionFile(root, "old");
		fs.mkdirSync(path.dirname(parity), { recursive: true });
		fs.writeFileSync(parity, "PARITY");
		const projection = path.join(root, "session-registry", "v1", "project", "old.json");
		fs.mkdirSync(path.dirname(projection), { recursive: true });
		fs.writeFileSync(projection, '{"state":"closed"}');
		const db = new SessionDatabase(root);
		db.remember("old", file);
		db.close();
		const moved = path.join(root, "moved-project");
		fs.renameSync(project, moved);
		await events.get("session_start")!({}, ctx);
		assert.deepEqual(notices, [], "the sweep runs after session_start returns");
		protection.flushMaintenance();
		assert.equal(fs.readFileSync(parity, "utf8"), "PARITY");
		assert.equal(fs.readFileSync(projection, "utf8"), '{"state":"closed"}');
		assert.equal(fs.readFileSync(path.join(moved, "old.jsonl.acp.json"), "utf8"), "SIDE");
		assert.match(notices.join("\n"), /old[\s\S]*session-erase old/u);
		const reported = notices.length;
		await events.get("session_start")!({}, ctx);
		protection.flushMaintenance();
		assert.equal(notices.length, reported, "a missing written source is reported once, not every startup");
		const kept = new SessionDatabase(root);
		assert.deepEqual(kept.sources(), [{ id: "old", path: file }]);
		kept.close();
		// A returned side file is not implicit consent either.
		fs.mkdirSync(project);
		fs.writeFileSync(side, "RETURNED SIDE");
		await commands.get("session-erase")!.handler("old", ctx);
		assert.equal(fs.existsSync(parity), true);
		assert.equal(fs.existsSync(side), true);
		consent = true;
		await commands.get("session-erase")!.handler("old", ctx);
		assert.match(notices.at(-1)!, /Session erasure: complete/u);
		assert.equal(fs.existsSync(parity), false);
		assert.equal(fs.existsSync(projection), false);
		assert.equal(fs.existsSync(side), false);
		assert.equal(fs.existsSync(path.join(moved, "old.jsonl")), true);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a refused start without UI reports the reason on stderr and fails the process", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-refused-headless-"));
	const real = path.join(root, "real.sqlite");
	fs.writeFileSync(real, "");
	fs.symlinkSync(real, path.join(root, "context-aware.sqlite"));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	let shutdowns = 0;
	const ctx = { hasUI: false, sessionManager: { getSessionId: () => "current", getSessionFile: () => null }, shutdown: () => { shutdowns++; } } as unknown as ExtensionContext;
	const control = registerSessionErasure(pi, () => root, async () => {}, { registerStartup: false });
	const written: string[] = [];
	const write = process.stderr.write;
	const exitCode = process.exitCode;
	process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
	let observedExit: typeof process.exitCode;
	try {
		await control.start(ctx);
		observedExit = process.exitCode;
	} finally {
		process.stderr.write = write;
		process.exitCode = exitCode;
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(control.isBlocked(), true);
	assert.equal(shutdowns, 1);
	assert.equal(observedExit, 1);
	assert.match(written.join(""), /Session activation refused.*context-aware\.sqlite is a symbolic link/u);
});

test("a refused start with UI notifies the reason and leaves stderr and the exit code alone; a later start clears a headless failure", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-refused-ui-"));
	const link = path.join(root, "context-aware.sqlite");
	fs.writeFileSync(path.join(root, "real.sqlite"), "");
	fs.symlinkSync(path.join(root, "real.sqlite"), link);
	const pi = { on: () => {}, registerCommand: () => {} } as unknown as ExtensionAPI;
	const notices: string[] = [];
	const session = { getSessionId: () => "current", getSessionFile: () => null };
	const ui = { hasUI: true, sessionManager: session, shutdown: () => {}, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
	const headless = { hasUI: false, sessionManager: session, shutdown: () => {} } as unknown as ExtensionContext;
	const control = registerSessionErasure(pi, () => root, async () => {}, { registerStartup: false });
	const written: string[] = [];
	const write = process.stderr.write;
	const exitCode = process.exitCode;
	process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
	const observed: (typeof process.exitCode)[] = [];
	try {
		process.exitCode = undefined;
		await control.start(ui);
		observed.push(process.exitCode);
		await control.start(headless);
		observed.push(process.exitCode);
		fs.rmSync(link);
		await control.start(headless);
		observed.push(process.exitCode);
	} finally {
		process.stderr.write = write;
		process.exitCode = exitCode;
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.match(notices[0]!, /context-aware\.sqlite is a symbolic link\). Shutdown requested\./u);
	assert.equal(written.length, 1, "only the headless refusal writes to stderr");
	assert.deepEqual(observed, [undefined, 1, undefined]);
	assert.equal(control.isBlocked(), false);
});

test("erased-id reads refuse a dangling symlink instead of reporting nothing erased", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-dangling-"));
	try {
		fs.symlinkSync(path.join(root, "missing.sqlite"), path.join(root, "context-aware.sqlite"));
		assert.throws(() => erasedSessionIds(root), /context-aware\.sqlite: is a symbolic link/u);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
