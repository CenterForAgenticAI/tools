import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionDatabase } from "../src/erasure/database.js";
import { appendParityRecords, readParityRecords, paritySessionFile, PARITY_RECORD_VERSION, type CompressRecord } from "../src/parity/records.js";

const record = (sessionId: string): CompressRecord => ({ v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "test", sessionId, at: "2026-01-01", toolCallId: "call", nested: false, verdict: "match", diffs: [] });

test("parity append after erasure writes nothing", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-parity-"));
	try {
		await appendParityRecords(root, "kept", [record("kept")]);
		assert.equal((await readParityRecords(root)).length, 1);
		const db = new SessionDatabase(root);
		db.erase(["gone"]);
		await appendParityRecords(root, "gone", [record("gone")]);
		assert.equal(fs.existsSync(paritySessionFile(root, "gone")), false);
		db.close();
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("parity append holds a lease across async persistence so erasure cannot win mid-write", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-parity-race-"));
	const db = new SessionDatabase(root);
	let pending: Promise<void> | undefined;
	try {
		pending = appendParityRecords(root, "racing", [record("racing")]);
		assert.throws(() => db.erase(["racing"]), /open/u);
		await pending;
		assert.equal(fs.existsSync(paritySessionFile(root, "racing")), true);
		db.erase(["racing"]);
	} finally {
		await pending;
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("parity reads ignore restored erased record files and keep unerased records", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-parity-read-"));
	try {
		await appendParityRecords(root, "kept", [record("kept")]);
		const db = new SessionDatabase(root);
		db.erase(["gone"]);
		db.close();
		fs.writeFileSync(paritySessionFile(root, "gone"), "RESTORED CORRUPT ERASED DATA\n");
		// A restored record under a different filename must not bypass the id filter.
		fs.appendFileSync(paritySessionFile(root, "kept"), JSON.stringify(record("gone")) + "\n");
		assert.deepEqual((await readParityRecords(root)).map((item) => item.sessionId), ["kept"]);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
