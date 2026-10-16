import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionDatabase } from "../src/erasure/database.js";
import { importAcpSideFileFromProfile } from "../src/folds/acp-import.js";

test("erasure ledger survives reopening and refuses import of a copied ACP side file", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-ledger-"));
	try {
		const manager = SessionManager.inMemory(root);
		const entryId = manager.appendMessage({ role: "user", content: "Importable fold evidence", timestamp: 1 });
		const source = path.join(root, "saved.acp.json");
		const copy = path.join(root, "copied.acp.json");
		fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, blocks: [{ blockId: "b1", runId: "r1", tier: 1, summary: "Imported summary", effectiveMessageIds: [entryId], directBlockIds: [], compressedTokens: 10, createdAt: 1, active: true }] }));
		fs.copyFileSync(source, copy);
		const input = { entries: manager.getEntries(), branch: manager.getBranch(), sideFileText: fs.readFileSync(copy, "utf8") };
		const positive = importAcpSideFileFromProfile(root, { ...input, sessionId: "kept" });
		assert.equal(positive.status, "imported");
		if (positive.status !== "imported") throw new Error("Fixture must import");
		assert.equal(positive.records.length, 1);
		assert.equal(positive.records[0]!.carrierId, entryId);
		assert.equal(positive.drafts.length, 2);
		const db = new SessionDatabase(root);
		db.erase(["gone"]);
		db.close();
		assert.deepEqual(importAcpSideFileFromProfile(root, { ...input, sessionId: "gone" }), { status: "skipped", reason: "erased-session" });
		const reopened = new SessionDatabase(root);
		assert.deepEqual([...reopened.erasedIds()], ["gone"]);
		reopened.close();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("opening and erasure on separate ledger connections are mutually exclusive", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-opening-ledger-"));
	try {
		const opening = new SessionDatabase(root);
		const erasing = new SessionDatabase(root);
		opening.openSession("opening-wins", null, "second-runtime");
		assert.throws(() => erasing.erase(["opening-wins"]), /open/u);
		assert.equal(erasing.isErased("opening-wins"), false);
		erasing.erase(["erasure-wins"]);
		assert.throws(() => opening.openSession("erasure-wins", null, "second-runtime"), /erased/u);
		assert.equal(opening.isOpen("erasure-wins"), false);
		opening.close();
		erasing.close();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("replacement runtime leases cannot be released by an outgoing runtime", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-runtime-"));
	try {
		const db = new SessionDatabase(root);
		db.openSession("session", null, "outgoing");
		db.openSession("session", null, "replacement");
		db.closeSession("session", "outgoing");
		assert.throws(() => db.erase(["session"]), /open/u);
		db.closeSession("session", "replacement");
		db.erase(["session"]);
		assert.equal(db.isErased("session"), true);
		db.close();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("database erasure refuses any open member before recording any ids", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-atomic-"));
	try {
		const db = new SessionDatabase(root);
		db.openSession("open", null);
		assert.throws(() => db.erase(["closed", "open"]), /open/u);
		assert.deepEqual([...db.erasedIds()], []);
		db.closeSession("open");
		db.erase(["closed", "open"]);
		assert.deepEqual([...db.erasedIds()], ["closed", "open"]);
		db.close();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
