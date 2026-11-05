import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendMetricsRecord, buildMetricsRecord, metricsSessionFile, type MetricsInput } from "../src/metrics/records.js";
import { SessionDatabase } from "../src/erasure/database.js";

const input = (seq: number, sessionId = "s1", extra: Partial<MetricsInput> = {}): MetricsInput => ({ seq, at: new Date("2026-01-01T00:00:00Z"), sessionId, folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, ...extra });
const limits = { maxBytes: 4096, maxDirBytes: 1_000_000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "metrics-store-"));
const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { seq: number });

test("a metrics file is private (0600) in a private directory", async () => {
	const root = tmp();
	try {
		await appendMetricsRecord(root, buildMetricsRecord(input(1)), limits);
		const file = metricsSessionFile(root, "s1");
		assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
		assert.equal(fs.lstatSync(path.dirname(file)).mode & 0o777, 0o700);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a symlinked store directory is refused, not followed", async () => {
	const root = tmp();
	const elsewhere = tmp();
	try {
		fs.mkdirSync(path.join(root, "context-aware"), { recursive: true });
		fs.symlinkSync(elsewhere, path.join(root, "context-aware", "metrics"));
		await assert.rejects(appendMetricsRecord(root, buildMetricsRecord(input(1)), limits), /not a real directory/u);
		assert.deepEqual(fs.readdirSync(elsewhere), []);
	} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test("a symlinked session file is refused, not followed", async () => {
	const root = tmp();
	const elsewhere = tmp();
	try {
		await appendMetricsRecord(root, buildMetricsRecord(input(1, "other")), limits);
		const target = path.join(elsewhere, "target.jsonl");
		fs.writeFileSync(target, "");
		fs.symlinkSync(target, metricsSessionFile(root, "s1"));
		await assert.rejects(appendMetricsRecord(root, buildMetricsRecord(input(1)), limits), /not a regular file|not a private regular file/u);
		assert.equal(fs.readFileSync(target, "utf8"), "");
	} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); }
});

test("past the size cap the oldest records go first and the file stays within the cap", async () => {
	const root = tmp();
	try {
		for (let seq = 1; seq <= 80; seq++) await appendMetricsRecord(root, buildMetricsRecord(input(seq)), limits);
		const file = metricsSessionFile(root, "s1");
		assert.ok(fs.statSync(file).size <= limits.maxBytes, "size within cap");
		const kept = lines(file).map((record) => record.seq);
		assert.equal(kept.at(-1), 80, "the newest record is kept");
		assert.ok(!kept.includes(1), "the oldest record is gone");
		assert.deepEqual(kept, kept.slice().sort((a, b) => a - b), "order preserved");
		assert.deepEqual(kept, Array.from({ length: kept.length }, (_, i) => 80 - kept.length + 1 + i), "a contiguous newest run is kept");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("past the directory cap the oldest other session files are removed", async () => {
	const root = tmp();
	try {
		const small = { maxBytes: 4096, maxDirBytes: 1500 };
		for (const [i, id] of ["a", "b", "c", "d"].entries()) {
			await appendMetricsRecord(root, buildMetricsRecord(input(1, id)), small);
			const file = metricsSessionFile(root, id);
			fs.utimesSync(file, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
		}
		await appendMetricsRecord(root, buildMetricsRecord(input(2, "d")), small);
		const left = fs.readdirSync(path.dirname(metricsSessionFile(root, "a"))).sort();
		assert.ok(left.includes("d.jsonl"), "the session being written survives");
		assert.ok(!left.includes("a.jsonl"), "the oldest file is removed");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an erased session id writes nothing", async () => {
	const root = tmp();
	try {
		const db = new SessionDatabase(root);
		db.erase(["gone"]);
		db.close();
		await appendMetricsRecord(root, buildMetricsRecord(input(1, "gone")), limits);
		assert.equal(fs.existsSync(metricsSessionFile(root, "gone")), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an unsafe session id is refused", () => {
	assert.throws(() => metricsSessionFile("/x", "../evil"), /Invalid metrics session id/u);
	assert.throws(() => buildMetricsRecord(input(1, "a/b")), /Invalid metrics session id/u);
});

test("the record copies named, typed fields: free text in any field is dropped", () => {
	const secret = "SECRET-TOKEN-xyz";
	const hostile = { ...input(1), modelId: `has spaces ${secret}`, leafId: secret + " x", band: secret, nudge: secret, folds: { requested: 1, accepted: 1, refused: { [secret]: 3, "unknown-ref": 2 }, dropped: {} }, compaction: { writer: secret, tokensBefore: 1, tokensAfter: 2 }, extra: secret } as unknown as MetricsInput;
	const record = buildMetricsRecord(hostile);
	assert.ok(!JSON.stringify(record).includes(secret));
	assert.deepEqual(record.folds.refused, { "unknown-ref": 2 });
	assert.equal(record.compaction?.writer, "other");
	assert.equal(record.band, null);
});
