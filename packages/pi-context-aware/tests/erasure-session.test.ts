import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eraseSession, sweepMissingSessions } from "../src/erasure/session-erasure.js";
import { SessionDatabase } from "../src/erasure/database.js";
import { paritySessionFile } from "../src/parity/records.js";
import { answerRecall } from "../src/cache/recall.js";
import { boundCacheDocuments, migrateCachePool, promoteCacheFile, readManifest, writeCacheFile, writeManifest } from "../src/cache/context-cache.js";
import { sessionDatabaseFile } from "../src/erasure/database.js";
import { createRegistryProjection, createSessionRegistry } from "../src/session/session-registry.js";
import { asPiSessionId, asWorkstreamId } from "../src/workstream/workstream-schema.js";

function registry(root: string, state: "active" | "closed" = "closed") {
	const store = createSessionRegistry({ registryRoot: path.join(root, "session-registry", "v1"), projectKey: "project" });
	const projection = createRegistryProjection({
		piSessionId: asPiSessionId("old"), projectKey: "project", incarnation: "incarnation", pid: process.pid,
		pidStart: "2026-01-01T00:00:00.000Z", workstreamId: asWorkstreamId("workstream"), sequence: 1, state,
		objective: "ORCHID objective", status: "active", refs: [],
		heartbeatAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
	});
	assert.equal(store.write(projection).ok, true);
	return { store, projection };
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-session-"));
	const sessions = path.join(root, "sessions", "project");
	fs.mkdirSync(sessions, { recursive: true });
	const file = path.join(sessions, "old.jsonl");
	fs.writeFileSync(file, '{"type":"session","id":"old"}\n{"text":"ORCHID evidence"}\n');
	fs.writeFileSync(`${file}.acp.json`, "{}");
	const parity = paritySessionFile(root, "old");
	fs.mkdirSync(path.dirname(parity), { recursive: true });
	fs.writeFileSync(parity, "parity evidence\n");
	const cache = path.join(root, "context-cache", "pool");
	writeManifest(cache, writeCacheFile(cache, { version: 1, files: {} }, "old", "note.md", "ORCHID evidence", "a note"));
	return { root, file, parity, cache, sessions: [{ id: "old", path: file }] };
}

test("whole-session erasure deletes transcript, ACP, parity and confirmed cache; recall finds nothing", async () => {
	const f = fixture();
	try {
		assert.equal(answerRecall({ question: "ORCHID" }, { cachePools: [{ cacheDir: f.cache, originScope: "test" }], sessions: f.sessions }).details.citations.length, 2);
		const db = new SessionDatabase(f.root);
		db.remember("old", f.file);
		db.close();
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(receipt.status, "complete");
		for (const file of [f.file, `${f.file}.acp.json`, f.parity, path.join(f.cache, "note.md")]) assert.equal(fs.existsSync(file), false, file);
		assert.deepEqual(readManifest(f.cache).files, {});
		assert.match(receipt.untouched.join("\n"), /Fabric.*not erased/u);
		assert.equal(answerRecall({ question: "ORCHID" }, { cachePools: [{ cacheDir: f.cache, originScope: "test" }], sessions: f.sessions }).details.citations.length, 0);
		const reopened = new SessionDatabase(f.root);
		assert.deepEqual(reopened.sources(), []);
		reopened.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure refuses an idle open session and the current session without any deletion", async () => {
	const f = fixture();
	try {
		const db = new SessionDatabase(f.root);
		db.openSession("old", f.file);
		db.close();
		for (const current of ["current", "old"]) {
			if (current === "old") {
				const release = new SessionDatabase(f.root);
				release.closeSession("old");
				release.close();
			}
			let confirmations = 0;
			const receipt = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: current, sessions: f.sessions, confirm: async () => { confirmations++; return true; } });
			assert.equal(confirmations, 0);
			assert.equal(receipt.status, "refused");
			assert.match(receipt.failed.join("\n"), /open/u);
			assert.equal(fs.existsSync(f.file), true);
		}
		const check = new SessionDatabase(f.root);
		assert.equal(check.isErased("old"), false);
		check.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure deletes registry projections and registry indexers refuse erased ids", async () => {
	const f = fixture();
	try {
		const { store, projection } = registry(f.root);
		const result = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(result.status, "complete");
		assert.equal(fs.existsSync(store.filePath("old")), false);
		assert.equal(store.write({ ...projection, sequence: 2 }).ok, false);
		// Simulate a restored registry file, not a permitted writer.
		fs.writeFileSync(store.filePath("old"), JSON.stringify(projection));
		assert.equal(store.read("old"), null);
		assert.deepEqual(store.list(), []);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure removes crashed registry temporary projections and dead lock/reclaim metadata", async () => {
	const f = fixture();
	try {
		const { store } = registry(f.root);
		const project = path.dirname(store.filePath("old"));
		const temporary = path.join(project, ".old.json.crashed.tmp");
		fs.writeFileSync(temporary, "ORCHID torn projection text");
		const directories = [".old.json.lock", ".old.json.reclaim.crashed"].map((name) => path.join(project, name));
		for (const directory of directories) {
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead", pidStart: "old", acquiredAt: "old" }));
		}
		const result = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(result.status, "complete");
		assert.equal(fs.existsSync(temporary), false);
		for (const directory of directories) assert.equal(fs.existsSync(directory), false);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const debris of ["temporary file", "reclaim directory"] as const) {
	test(`erasing parent preserves dotted-id ${debris} for parent.json.child`, async () => {
		const f = fixture();
		try {
			fs.writeFileSync(f.file, '{"type":"session","id":"parent"}\n');
			const project = path.join(f.root, "session-registry", "v1", "project");
			fs.mkdirSync(project, { recursive: true });
			const names = debris === "temporary file"
				? [".parent.json.token.tmp", ".parent.json.child.json.token.tmp"]
				: [".parent.json.reclaim.token", ".parent.json.child.json.reclaim.token", ".parent.json.reclaim.child.json.reclaim.token"];
			for (const name of names) {
				const target = path.join(project, name);
				if (debris === "temporary file") fs.writeFileSync(target, "PRIVATE PROJECTION");
				else {
					fs.mkdirSync(target);
					fs.writeFileSync(path.join(target, "owner.json"), '{"pid":2147483647}');
				}
			}
			const result = await eraseSession({ agentDir: f.root, sessionId: "parent", currentSessionId: "current", sessions: [{ id: "parent", path: f.file }], confirm: async () => true });
			assert.equal(result.status, "complete");
			assert.equal(fs.existsSync(path.join(project, names[0]!)), false);
			for (const name of names.slice(1)) {
				assert.equal(fs.existsSync(path.join(project, name)), true, name);
				const preserved = path.join(project, name, ...(debris === "temporary file" ? [] : ["owner.json"]));
				assert.equal(fs.readFileSync(preserved, "utf8"), debris === "temporary file" ? "PRIVATE PROJECTION" : '{"pid":2147483647}');
			}
		} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
	});
}

test("erasure refuses a live registry lock even when the projection is closed", async () => {
	const f = fixture();
	try {
		const { store } = registry(f.root);
		const lock = path.join(path.dirname(store.filePath("old")), ".old.json.lock");
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
		const result = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(result.status, "refused");
		assert.equal(fs.existsSync(f.file), true);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure refuses a live registry session even without a new open lease", async () => {
	const f = fixture();
	try {
		registry(f.root, "active");
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(receipt.status, "refused");
		assert.equal(fs.existsSync(f.file), true);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unconfirmed cache documents stay on disk but recall and cache indexers skip their erased authors", async () => {
	const f = fixture();
	try {
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async (title) => title !== "Erase context-cache documents?" });
		assert.equal(receipt.status, "complete");
		assert.equal(fs.existsSync(path.join(f.cache, "note.md")), true);
		assert.match(receipt.untouched.join("\n"), /Unconfirmed cache document/u);
		assert.equal(answerRecall({ question: "ORCHID" }, { cachePools: [{ cacheDir: f.cache, originScope: "test" }], sessions: [] }).details.citations.length, 0);
		assert.deepEqual(boundCacheDocuments([{ cacheDir: f.cache, originScope: "test" }], 100).entries, []);
		assert.throws(() => writeCacheFile(f.cache, readManifest(f.cache), "old", "new.md", "ORCHID", "new"), /Erased/u);
		assert.throws(() => promoteCacheFile(f.cache, readManifest(f.cache), "old", path.join(f.cache, "note.md"), "promoted.md", "new"), /Erased/u);
		const destination = path.join(f.root, "context-cache", "destination");
		assert.deepEqual(migrateCachePool(f.cache, destination).migratedFiles, []);
		// A copy outside the profile does not carry ledger authority; the destination still must refuse it.
		const copy = path.join(f.root, "exported");
		fs.cpSync(f.cache, copy, { recursive: true });
		assert.deepEqual(migrateCachePool(copy, destination).migratedFiles, []);
		assert.equal(fs.existsSync(path.join(destination, "note.md")), false);
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure reports unattributed cache crash debris without deleting it", async () => {
	const f = fixture();
	try {
		const orphan = path.join(f.cache, ".pending.promotion-crashed");
		fs.writeFileSync(orphan, "UNATTRIBUTED PRIVATE CACHE TEXT");
		const pool = path.join(f.root, "context-cache", "no-manifest-pool");
		fs.mkdirSync(pool);
		const otherOrphan = path.join(pool, ".pending.migration-crashed");
		fs.writeFileSync(otherOrphan, "UNATTRIBUTED MIGRATION TEXT");
		const receipt = await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		assert.equal(receipt.status, "complete");
		assert.ok(receipt.untouched.includes(`Unattributed cache file (not erased): ${orphan}`));
		assert.ok(receipt.untouched.includes(`Unattributed cache file (not erased): ${otherOrphan}`));
		assert.equal(fs.readFileSync(orphan, "utf8"), "UNATTRIBUTED PRIVATE CACHE TEXT");
		assert.equal(fs.readFileSync(otherOrphan, "utf8"), "UNATTRIBUTED MIGRATION TEXT");
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("recall refuses restored transcript content by ledger id", async () => {
	const f = fixture();
	try {
		await eraseSession({ agentDir: f.root, sessionId: "old", currentSessionId: "current", sessions: f.sessions, confirm: async () => true });
		fs.writeFileSync(f.file, "ORCHID evidence");
		const db = new SessionDatabase(f.root);
		assert.equal(answerRecall({ question: "ORCHID" }, { cachePools: [], sessions: f.sessions, erasedSessionIds: db.erasedIds() }).details.citations.length, 0);
		db.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("missing source detection reports ACP, parity and registry without deleting or forgetting", () => {
	const f = fixture();
	try {
		const { store } = registry(f.root);
		const db = new SessionDatabase(f.root);
		db.remember("old", f.file);
		db.close();
		fs.unlinkSync(f.file);
		const reported: string[] = [];
		const sweep = sweepMissingSessions(f.root, undefined, (missing) => { reported.push(...missing.map((source) => source.id)); return true; });
		assert.deepEqual(sweep, { forgotten: [], reported: ["old"], failed: [] });
		assert.deepEqual(reported, ["old"]);
		for (const file of [f.parity, `${f.file}.acp.json`, store.filePath("old")]) assert.equal(fs.existsSync(file), true);
		const reopened = new SessionDatabase(f.root);
		assert.deepEqual(reopened.sources(), [{ id: "old", path: f.file }]);
		assert.equal(reopened.isErased("old"), false);
		reopened.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("erasure checkpoints WAL and securely removes source paths from SQLite pages", () => {
	const f = fixture();
	try {
		const db = new SessionDatabase(f.root);
		db.remember("old", "ERASURE_PRIVATE_SENTINEL".repeat(1000));
		db.erase(["old"]);
		db.checkpoint();
		assert.equal(fs.statSync(`${sessionDatabaseFile(f.root)}-wal`).size, 0);
		assert.equal(fs.readFileSync(sessionDatabaseFile(f.root)).includes(Buffer.from("ERASURE_PRIVATE_SENTINEL")), false);
		db.close();
	} finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
