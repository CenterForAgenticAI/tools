import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionDatabase, sessionDatabaseFile } from "../src/erasure/database.js";
import { eraseSession, type ErasureSession } from "../src/erasure/session-erasure.js";
import { paritySessionFile } from "../src/parity/records.js";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-consent-"));
	const make = (id: string, parentSessionPath?: string): ErasureSession => {
		const file = path.join(root, "sessions", `${id}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ type: "session", id, parentSession: parentSessionPath }) + "\n");
		return { id, path: file, parentSessionPath };
	};
	const parent = make("parent");
	const child = make("child", parent.path);
	const grandchild = make("grandchild", child.path);
	return { root, sessions: [parent, child, grandchild], parent, child, grandchild };
}

test("erasure lists transitive forks and deletes only confirmed forks", async () => {
	for (const includeForks of [false, true]) {
		const f = fixture();
		try {
			const prompts: string[] = [];
			const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: f.sessions, confirm: async (title, message) => { prompts.push(message); return title !== "Include session forks?" || includeForks; } });
			assert.equal(receipt.status, "complete");
			assert.match(prompts[0]!, /child:.*\ngrandchild:/u);
			assert.equal(fs.existsSync(f.parent.path), false);
			assert.equal(fs.existsSync(f.child.path), !includeForks);
			assert.equal(fs.existsSync(f.grandchild.path), !includeForks);
			const db = new SessionDatabase(f.root);
			assert.equal(db.isErased("parent"), true);
			assert.equal(db.isErased("grandchild"), includeForks);
			db.close();
		} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
	}
});

test("current-session erasure is refused without relying on a lease", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "parent", sessions: [f.parent], confirm: async () => true });
		assert.equal(receipt.status, "refused");
		assert.equal(fs.existsSync(f.parent.path), true);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure cancellation leaves files and ledger unchanged", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => false });
		assert.equal(receipt.status, "cancelled");
		assert.equal(fs.existsSync(f.parent.path), true);
		const db = new SessionDatabase(f.root);
		assert.deepEqual([...db.erasedIds()], []);
		db.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure rechecks liveness after consent and refuses the whole selection atomically", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: f.sessions, confirm: async (title) => {
			if (title === "Permanently erase sessions?") {
				const db = new SessionDatabase(f.root);
				db.openSession("grandchild", f.grandchild.path);
				db.close();
			}
			return true;
		} });
		assert.equal(receipt.status, "refused");
		for (const session of f.sessions) assert.equal(fs.existsSync(session.path), true);
		const db = new SessionDatabase(f.root);
		assert.deepEqual([...db.erasedIds()], []);
		db.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure rechecks registry liveness after final consent", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => {
			const directory = path.join(f.root, "session-registry", "v1", "project");
			fs.mkdirSync(directory, { recursive: true });
			fs.writeFileSync(path.join(directory, "parent.json"), JSON.stringify({ state: "active", pid: process.pid }));
			return true;
		} });
		assert.equal(receipt.status, "refused");
		assert.equal(fs.existsSync(f.parent.path), true);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure refuses a substituted session identity after consent", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => {
			fs.writeFileSync(f.parent.path, '{"type":"session","id":"replacement"}\n');
			return true;
		} });
		assert.equal(receipt.status, "refused");
		assert.equal(fs.existsSync(f.parent.path), true);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed deletion produces an incomplete receipt but keeps the erasure ledger", async () => {
	const f = fixture();
	try {
		const parity = paritySessionFile(f.root, "parent");
		fs.mkdirSync(parity, { recursive: true }); // A directory cannot be erased as a record file.
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => true });
		assert.equal(receipt.status, "incomplete");
		assert.match(receipt.failed.join("\n"), /private regular store file/u);
		assert.equal(fs.existsSync(f.parent.path), false);
		const db = new SessionDatabase(f.root);
		assert.equal(db.isErased("parent"), true);
		assert.throws(() => db.openSession("parent", f.parent.path), /erased/u);
		db.remember("parent", f.parent.path);
		assert.deepEqual(db.sources(), []);
		db.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("redirected parity directory cannot delete outside profile stores", async () => {
	const f = fixture();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-outside-"));
	try {
		fs.mkdirSync(path.join(outside, "v1", "sessions"), { recursive: true });
		const sentinel = path.join(outside, "v1", "sessions", "parent.jsonl");
		fs.writeFileSync(sentinel, "KEEP THIS OUTSIDE COPY");
		fs.symlinkSync(outside, path.join(f.root, "fold-parity"));
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => true });
		assert.equal(receipt.status, "incomplete");
		assert.equal(fs.readFileSync(sentinel, "utf8"), "KEEP THIS OUTSIDE COPY");
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("unattributable cache metadata makes the receipt incomplete before deletion", async () => {
	const f = fixture();
	try {
		const cache = path.join(f.root, "context-cache", "pool");
		fs.mkdirSync(cache, { recursive: true });
		fs.writeFileSync(path.join(cache, "_manifest.json"), '{"version":1,"files":{"note.md":{"createdBy":"parent"}}}');
		fs.writeFileSync(path.join(cache, "note.md"), "PRIVATE CACHE EVIDENCE");
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [f.parent], confirm: async () => true });
		assert.equal(receipt.status, "incomplete");
		assert.equal(fs.existsSync(f.parent.path), true);
		assert.match(receipt.failed.join("\n"), /Unattributable cache entries/u);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("the ledger contains session ids only and database permissions are private", () => {
	const f = fixture();
	try {
		const db = new SessionDatabase(f.root);
		db.erase(["parent"]);
		db.close();
		const raw = new DatabaseSync(sessionDatabaseFile(f.root), { readOnly: true });
		assert.deepEqual(raw.prepare("PRAGMA table_info(erased_sessions)").all().map((row) => row.name), ["session_id"]);
		assert.deepEqual(raw.prepare("SELECT * FROM erased_sessions").all().map((row) => ({ ...row })), [{ session_id: "parent" }]);
		raw.close();
		assert.equal(fs.lstatSync(sessionDatabaseFile(f.root)).mode & 0o777, 0o600);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
