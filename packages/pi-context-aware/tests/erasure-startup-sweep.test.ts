import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionDatabase } from "../src/erasure/database.js";
import { registerSessionErasure } from "../src/erasure/extension.js";
import { restoredErasedSessions } from "../src/erasure/restored.js";
import { missingSourceNotice, sweepMissingSessions } from "../src/erasure/session-erasure.js";
import { paritySessionFile } from "../src/parity/records.js";
import { writeCacheFile, writeManifest } from "../src/cache/context-cache.js";

// Pi writes a transcript only with the first user or assistant message, so a
// session left before its first prompt has a ledger row and no file.

function profile() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-sweep-"));
	const project = path.join(root, "sessions", "project");
	fs.mkdirSync(project, { recursive: true });
	return { root, project, transcript: (id: string) => path.join(project, `2026-01-01T00-00-00-000Z_${id}.jsonl`) };
}

/** A source recorded at session start, before Pi wrote its transcript. */
function recordUnwritten(root: string, id: string, file: string): void {
	const db = new SessionDatabase(root);
	try { db.remember(id, file); } finally { db.close(); }
}

function sources(root: string): string[] {
	const db = new SessionDatabase(root);
	try { return db.sources().map((source) => source.id).sort(); } finally { db.close(); }
}

function sweep(root: string, delivered = true) {
	const calls: string[][] = [];
	const result = sweepMissingSessions(root, "current", (missing) => { calls.push(missing.map((source) => source.id)); return delivered; });
	return { ...result, calls, notices: calls.flat() };
}

/** A source row written by a version that kept no write history. */
function recordLegacy(root: string, id: string, file: string): void {
	const db = new SessionDatabase(root);
	try {
		(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
			.prepare("INSERT INTO session_sources VALUES (?, ?)").run(id, file);
	} finally { db.close(); }
}

function harness(root: string, id: string, file: string | null) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notices: string[] = [];
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { hasUI: true, abort: () => {}, sessionManager: { getSessionId: () => id, getSessionFile: () => file }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
	const protection = registerSessionErasure(pi, () => root, async () => {}, { maintenanceDelayMs: 60_000 });
	return { protection, notices, emit: async (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx) };
}

test("a session abandoned before its first reply is forgotten silently", () => {
	const p = profile();
	try {
		recordUnwritten(p.root, "abandoned", p.transcript("abandoned"));
		const result = sweep(p.root);
		assert.deepEqual(result.forgotten, ["abandoned"]);
		assert.deepEqual(result.notices, []);
		assert.deepEqual(sources(p.root), []);
		assert.deepEqual(sweep(p.root).notices, [], "nothing is left to report on a later startup");
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("a transcript seen on disk and then gone is reported once and kept", () => {
	const p = profile();
	try {
		const file = p.transcript("written");
		recordUnwritten(p.root, "written", file);
		fs.writeFileSync(file, '{"type":"session","id":"written"}\n');
		// A sweep while the transcript exists is what records that it was written.
		assert.deepEqual(sweep(p.root).notices, []);
		fs.unlinkSync(file);
		const first = sweep(p.root);
		assert.deepEqual(first.forgotten, []);
		assert.deepEqual(first.notices, ["written"]);
		assert.deepEqual(sweep(p.root).notices, [], "the notice is shown once, not every startup");
		assert.deepEqual(sources(p.root), ["written"]);
		// The disk returns, then the transcript goes missing again: that is a new event.
		fs.writeFileSync(file, '{"type":"session","id":"written"}\n');
		sweep(p.root);
		fs.unlinkSync(file);
		assert.deepEqual(sweep(p.root).notices, ["written"]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

for (const role of ["user", "assistant"]) {
	test(`a transcript written with ${role === "user" ? "a user" : "an assistant"} message in a run that crashed before any sweep saw it is reported, never forgotten`, async () => {
		const p = profile();
		try {
			const id = `crashed-${role}`;
			const file = p.transcript(id);
			const session = harness(p.root, id, file);
			await session.emit("session_start");
			// The startup sweep runs before the first prompt, while no transcript exists.
			session.protection.flushMaintenance();
			await session.emit("agent_start");
			// Pi awaits message_end, then persists the message, which writes the transcript.
			await session.emit("message_end", { message: { role, content: "hello" } });
			fs.writeFileSync(file, `${JSON.stringify({ type: "session", id })}\n`);
			// The process dies without session_shutdown, so its lease is stale and nothing saw
			// the file. Then the directory is moved or unmounted.
			const db = new SessionDatabase(p.root);
			(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db.prepare("DELETE FROM open_sessions").run();
			db.close();
			fs.unlinkSync(file);
			const result = sweep(p.root);
			assert.deepEqual(result.forgotten, []);
			assert.deepEqual(result.notices, [id]);
			assert.deepEqual(sources(p.root), [id]);
		} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
	});
}

test("a run that persisted no conversation message is forgotten as abandoned", async () => {
	const p = profile();
	try {
		const session = harness(p.root, "aborted", p.transcript("aborted"));
		await session.emit("session_start");
		// The run starts and stops before Pi persists the prompt. An extension message is
		// not conversation, so Pi writes no transcript for it.
		await session.emit("agent_start");
		await session.emit("message_end", { message: { role: "custom", customType: "note", content: "x", display: true } });
		await session.emit("session_shutdown");
		const result = sweep(p.root);
		assert.deepEqual(result.forgotten, ["aborted"]);
		assert.deepEqual(result.notices, []);
		assert.deepEqual(sources(p.root), []);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("a source recorded before write history existed is reported, never forgotten", () => {
	const p = profile();
	try {
		recordLegacy(p.root, "legacy", p.transcript("legacy"));
		recordLegacy(p.root, "reopened", p.transcript("reopened"));
		// Recording it again with its transcript still missing must not invent a history.
		recordUnwritten(p.root, "reopened", p.transcript("reopened"));
		const first = sweep(p.root);
		assert.deepEqual(first.forgotten, []);
		assert.deepEqual(first.notices, ["legacy", "reopened"]);
		assert.deepEqual(sweep(p.root).notices, [], "the notice is shown once, not every startup");
		assert.deepEqual(sources(p.root), ["legacy", "reopened"]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("missing transcripts found by one sweep share one notice, and an unseen notice is returned for all of them", () => {
	const p = profile();
	try {
		for (const id of ["first", "second"]) recordLegacy(p.root, id, p.transcript(id));
		assert.deepEqual(sweep(p.root, false).reported, []);
		assert.deepEqual(sweep(p.root).calls, [["first", "second"]]);
		const text = missingSourceNotice([{ id: "first", path: p.transcript("first") }, { id: "second", path: p.transcript("second") }]);
		for (const id of ["first", "second"]) {
			assert.match(text, new RegExp(`${id}  ${p.transcript(id).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
		}
		assert.match(text, /Session transcripts missing: 2/u);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("a notice that no user saw stays pending for a later session", () => {
	const p = profile();
	try {
		const file = p.transcript("unseen");
		fs.writeFileSync(file, '{"type":"session","id":"unseen"}\n');
		recordUnwritten(p.root, "unseen", file);
		fs.unlinkSync(file);
		assert.deepEqual(sweep(p.root, false).reported, []);
		assert.deepEqual(sweep(p.root).notices, ["unseen"]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("an unwritten source is kept and not reported when its derived data cannot be checked", () => {
	const p = profile();
	try {
		recordUnwritten(p.root, "unknown", p.transcript("unknown"));
		const pool = path.join(p.root, "context-cache", "pool");
		fs.mkdirSync(pool, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(pool, "_manifest.json"), JSON.stringify({ version: 99 }), { mode: 0o600 });
		const result = sweep(p.root);
		assert.deepEqual(result.forgotten, []);
		assert.deepEqual(result.notices, []);
		assert.match(result.failed.join("\n"), /Derived-data check/u);
		assert.deepEqual(sources(p.root), ["unknown"]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("forgetting an unwritten source refuses a live lease, a written or present transcript, and a changed path", async () => {
	const p = profile();
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		await new Promise((resolve) => holder.once("spawn", resolve));
		const file = (id: string) => p.transcript(id);
		for (const id of ["open", "written", "present", "moved", "plain"]) recordUnwritten(p.root, id, file(id));
		const db = new SessionDatabase(p.root);
		try {
			(db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
				.prepare("INSERT INTO open_sessions VALUES (?, ?, ?)").run("open", holder.pid, "other");
			db.observeWritten(["written"]);
			fs.writeFileSync(file("present"), "{}\n");
			db.remember("moved", path.join(p.project, "elsewhere.jsonl"));
			assert.equal(db.forgetUnwritten("open", file("open")), false, "a live process holds it");
			assert.equal(db.forgetUnwritten("written", file("written")), false, "its transcript was seen");
			assert.equal(db.forgetUnwritten("present", file("present")), false, "its transcript exists now");
			assert.equal(db.forgetUnwritten("moved", file("moved")), false, "its recorded path changed");
			assert.equal(db.forgetUnwritten("plain", file("plain")), true);
		} finally { db.close(); }
		assert.deepEqual(sources(p.root), ["moved", "open", "present", "written"]);
	} finally {
		holder.kill();
		fs.rmSync(p.root, { recursive: true, force: true });
	}
});

const derived: Record<string, (root: string, id: string, file: string) => void> = {
	"ACP side file": (_root, _id, file) => fs.writeFileSync(`${file}.acp.json`, "{}"),
	"parity record": (root, id) => {
		const parity = paritySessionFile(root, id);
		fs.mkdirSync(path.dirname(parity), { recursive: true });
		fs.writeFileSync(parity, "{}\n");
	},
	"registry projection": (root, id) => {
		const projection = path.join(root, "session-registry", "v1", "project", `${id}.json`);
		fs.mkdirSync(path.dirname(projection), { recursive: true });
		fs.writeFileSync(projection, '{"state":"closed"}');
	},
	"registry lock": (root, id) => {
		const lock = path.join(root, "session-registry", "v1", "project", `.${id}.json.lock`);
		fs.mkdirSync(lock, { recursive: true });
		fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 7 }));
	},
	"cache document": (root, id) => {
		const pool = path.join(root, "context-cache", "pool");
		writeManifest(pool, writeCacheFile(pool, { version: 1, files: {} }, id, "note.md", "evidence", "a note"));
	},
};

for (const [kind, write] of Object.entries(derived)) {
	test(`an unwritten source with a ${kind} is reported, never forgotten`, () => {
		const p = profile();
		try {
			const file = p.transcript("used");
			recordUnwritten(p.root, "used", file);
			write(p.root, "used", file);
			const result = sweep(p.root);
			assert.deepEqual(result.forgotten, []);
			assert.deepEqual(result.notices, ["used"]);
			assert.deepEqual(sources(p.root), ["used"]);
		} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
	});
}

test("an unwritten source held by another live process is left alone", async () => {
	const p = profile();
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		await new Promise((resolve) => holder.once("spawn", resolve));
		// Another Pi process holds "moving", which was written and is briefly missing.
		const moving = p.transcript("moving");
		fs.writeFileSync(moving, '{"type":"session","id":"moving"}\n');
		recordUnwritten(p.root, "moving", moving);
		sweep(p.root);
		fs.unlinkSync(moving);
		// It also opened "elsewhere" and has not written its transcript yet.
		recordUnwritten(p.root, "elsewhere", p.transcript("elsewhere"));
		const db = new SessionDatabase(p.root);
		const insert = (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db.prepare("INSERT INTO open_sessions VALUES (?, ?, ?)");
		for (const id of ["elsewhere", "moving"]) insert.run(id, holder.pid, "other");
		db.close();
		const result = sweep(p.root);
		assert.deepEqual(result.forgotten, []);
		assert.deepEqual(result.notices, [], "the owning process reports its own session");
		assert.deepEqual(sources(p.root), ["elsewhere", "moving"]);
	} finally {
		holder.kill();
		fs.rmSync(p.root, { recursive: true, force: true });
	}
});

test("session_start returns before the sweep, which then runs on its own", async () => {
	const p = profile();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const notices: string[] = [];
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => "current", getSessionFile: () => p.transcript("current") }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
	try {
		recordUnwritten(p.root, "abandoned", p.transcript("abandoned"));
		registerSessionErasure(pi, () => p.root, async () => {}, { maintenanceDelayMs: 20 });
		await handlers.get("session_start")!({}, ctx);
		assert.deepEqual(sources(p.root), ["abandoned", "current"], "session_start did not run the sweep");
		for (let waited = 0; sources(p.root).includes("abandoned") && waited < 2000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(sources(p.root), ["current"], "the scheduled sweep ran after startup");
		assert.deepEqual(notices, []);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("session shutdown cancels a sweep that has not run", async () => {
	const p = profile();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => "current", getSessionFile: () => null }, ui: { notify: () => {} } } as unknown as ExtensionContext;
	try {
		recordUnwritten(p.root, "abandoned", p.transcript("abandoned"));
		const protection = registerSessionErasure(pi, () => p.root, async () => {}, { maintenanceDelayMs: 60_000 });
		await handlers.get("session_start")!({}, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		protection.flushMaintenance();
		assert.deepEqual(sources(p.root), ["abandoned"]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("restore detection does not walk session stores when nothing was ever erased", () => {
	const p = profile();
	try {
		// A redirected store makes any walk throw, so an empty result proves no walk happened.
		fs.symlinkSync(os.tmpdir(), path.join(p.root, "sessions", "redirect"));
		recordUnwritten(p.root, "kept", p.transcript("kept"));
		assert.deepEqual(restoredErasedSessions(p.root), []);
		const db = new SessionDatabase(p.root); db.erase(["gone"]); db.close();
		assert.throws(() => restoredErasedSessions(p.root), /Redirected store/u);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});

test("restore detection reads the session header from a large transcript", () => {
	const p = profile();
	try {
		const db = new SessionDatabase(p.root); db.erase(["gone"]); db.close();
		// A renamed transcript has only its header to identify it.
		const file = path.join(p.project, "renamed.jsonl");
		fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: "gone" })}\n${"x".repeat(512 * 1024)}\n`);
		assert.deepEqual(restoredErasedSessions(p.root).map((session) => [session.id, session.path]), [["gone", file]]);
	} finally { fs.rmSync(p.root, { recursive: true, force: true }); }
});
