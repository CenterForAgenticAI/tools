import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionDatabase } from "../src/erasure/database.js";
import { derivedEntryIds } from "../src/erasure/coverage.js";
import { cleanDerivedStores } from "../src/erasure/derived.js";
import { eraseText, findForkCopies } from "../src/erasure/erase-text.js";
import { writeManifest } from "../src/cache/context-cache.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";
import { paritySessionFile } from "../src/parity/records.js";
import { removeFixtureDirNow } from "./fixture-cleanup.js";

const SECRET = "s3cret-passphrase-ZZ9";
const NOW = () => new Date("2026-11-08T12:00:00Z");
const TS = "2026-11-01T00:00:00.000Z";
const header = (id: string, parent?: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: TS, cwd: "/w", ...(parent ? { parentSession: parent } : {}) });
const msg = (id: string, parentId: string | null, role: string, text: string) => JSON.stringify({ type: "message", id, parentId, timestamp: TS, message: { role, content: [{ type: "text", text }], timestamp: 1 } });

interface World { root: string; main: string; forkA: string; forkB: string }

function base(): string[] {
	return [msg("e1", null, "user", "hello there"), msg("e2", "e1", "assistant", "the key is " + SECRET), msg("e3", "e2", "user", "thanks, noted")];
}
function world(): World {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-derived-"));
	const dir = path.join(root, "sessions", "proj");
	fs.mkdirSync(dir, { recursive: true });
	const main = path.join(dir, "2026_main.jsonl");
	const forkA = path.join(dir, "2026_forka.jsonl");
	const forkB = path.join(dir, "2026_forkb.jsonl");
	const summary = JSON.stringify({ type: "compaction", id: "c1", parentId: "e3", timestamp: TS, summary: "The user shared " + SECRET + " earlier.", firstKeptEntryId: "e3", tokensBefore: 10 });
	const fold = { version: 1, blockId: "b1", runId: "r1", tier: 1, topic: "key " + SECRET, carrierId: "e1", hiddenIds: ["e2"], range: { startId: "e1", endId: "e2" }, refs: { start: "m00001", end: "m00002" }, directBlockIds: [], compressedTokens: 1, createdAt: 1, origin: "fold" };
	const edit = JSON.stringify({ type: "context_edit", id: "x1", parentId: "c1", timestamp: TS, targetId: "e1", replacement: { content: "[fold] " + SECRET } });
	const rec = JSON.stringify({ type: "custom", id: "f1", parentId: "x1", timestamp: TS, customType: FOLD_ENTRY_TYPE, data: fold });
	fs.writeFileSync(main, [header("main"), ...base(), summary, edit, rec].join("\n") + "\n");
	fs.writeFileSync(forkA, [header("forka", main), ...base(), msg("a1", "e3", "user", "own work A")].join("\n") + "\n");
	fs.writeFileSync(forkB, [header("forkb", main), ...base(), msg("b1", "e3", "user", "own work B")].join("\n") + "\n");
	return { root, main, forkA, forkB };
}
const sessions = (w: World) => [{ id: "main", path: w.main }, { id: "forka", path: w.forkA, parentSessionPath: w.main }, { id: "forkb", path: w.forkB, parentSessionPath: w.main }];

/** One planted copy in every derived store. */
function plant(w: World): string[] {
	const files: string[] = [];
	const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); files.push(file); };
	put(`${w.main}.acp.json`, JSON.stringify({ schemaVersion: 1, note: SECRET }));
	put(paritySessionFile(w.root, "main"), JSON.stringify({ x: SECRET }) + "\n");
	const pool = path.join(w.root, "context-cache", "pool");
	fs.mkdirSync(pool, { recursive: true });
	put(path.join(pool, "doc.md"), "notes: " + SECRET);
	put(path.join(pool, "clean.md"), "unrelated");
	writeManifest(pool, { version: 1, files: {
		"doc.md": { description: "about", createdBy: "main", updatedBy: "main", created: TS, updated: TS, sizeBytes: 10 },
		"clean.md": { description: "mentions " + SECRET, createdBy: "main", updatedBy: "main", created: TS, updated: TS, sizeBytes: 9 },
	} });
	return files;
}
const allText = (root: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).filter((f) => !f.endsWith("context-aware.sqlite") && fs.readFileSync(f, "utf8").includes(SECRET));
const cleanup = (w: World) => removeFixtureDirNow(w.root);
const run = (w: World, over: Partial<Parameters<typeof eraseText>[0]> = {}) => eraseText({ agentDir: w.root, session: { id: "main", path: w.main }, selector: { kind: "match", text: SECRET }, sessions: sessions(w), confirmFork: async () => true, now: NOW, ...over });

test("erase --match: no file in the profile holds the secret afterwards, in sessions, folds, summaries, side file, parity and cache", async () => {
	const w = world();
	try {
		plant(w);
		assert.ok(allText(w.root).length >= 7);
		const result = await run(w);
		assert.equal(result.rewrite.status, "erased");
		assert.deepEqual(allText(w.root), []);
		assert.deepEqual(result.remaining, []);
		assert.deepEqual(result.derived.failed, []);
	} finally { cleanup(w); }
});

test("a compaction summary over an erased range is tombstoned and keeps its id and links", async () => {
	const w = world();
	try {
		const result = await run(w, { selector: { kind: "range", range: "e2..e2" }, confirmFork: async () => false });
		assert.equal(result.rewrite.status, "erased");
		const lines = fs.readFileSync(w.main, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		const compaction = lines.find((l) => l.type === "compaction")!;
		assert.equal(compaction.summary, "[erased 2026-11-08]");
		assert.equal(compaction.id, "c1");
		assert.equal(compaction.parentId, "e3");
		assert.equal(compaction.firstKeptEntryId, "e3");
		const record = lines.find((l) => l.type === "custom")! as { data: Record<string, unknown> };
		assert.equal("topic" in record.data, false);
		assert.equal(record.data.carrierId, "e1");
		assert.equal(JSON.stringify(lines.find((l) => l.id === "x1")).includes("[erased"), true);
		assert.equal(allText(w.root).length, 2); // the two forks still hold it: declined
	} finally { cleanup(w); }
});

test("a summary that does not cover the erased range is left alone", () => {
	const lines = [{ type: "message", id: "a", parentId: null }, { type: "message", id: "b", parentId: "a" }, { type: "message", id: "c", parentId: "b" }, { type: "compaction", id: "k", parentId: "c", firstKeptEntryId: "c" }];
	assert.deepEqual([...derivedEntryIds(lines, new Set(["c"]))].sort(), ["c"]);
	assert.deepEqual([...derivedEntryIds(lines, new Set(["a"]))].sort(), ["a", "k"]);
});

test("forks: one accepted, one declined; the declined fork stays byte-identical", async () => {
	const w = world();
	try {
		const declinedBefore = fs.readFileSync(w.forkB);
		const asked: string[] = [];
		const result = await run(w, { confirmFork: async (fork) => { asked.push(fork.session.id); return fork.session.id === "forka"; } });
		assert.deepEqual(asked.sort(), ["forka", "forkb"]);
		assert.deepEqual(result.forks.map((f) => [f.fork.session.id, f.outcome]).sort(), [["forka", "erased"], ["forkb", "declined"]]);
		assert.deepEqual(fs.readFileSync(w.forkB), declinedBefore);
		assert.equal(fs.readFileSync(w.forkA, "utf8").includes(SECRET), false);
		assert.equal(fs.readFileSync(w.forkA, "utf8").includes("own work A"), true);
	} finally { cleanup(w); }
});

test("forks are found by copied entry ids for a range, and by text for a match", () => {
	const w = world();
	try {
		const byIds = findForkCopies(w.root, { id: "main", path: w.main }, sessions(w), { ids: ["e2"] });
		assert.deepEqual(byIds.map((f) => [f.session.id, f.reason, f.entryIds]), [["forka", "entries", ["e2"]], ["forkb", "entries", ["e2"]]]);
		assert.deepEqual(findForkCopies(w.root, { id: "main", path: w.main }, sessions(w), { text: "own work A" }).map((f) => f.session.id), ["forka"]);
		assert.deepEqual(findForkCopies(w.root, { id: "main", path: w.main }, sessions(w), { ids: ["zz"] }), []);
	} finally { cleanup(w); }
});

test("a live session is refused before any derived store is touched", async () => {
	const w = world();
	try {
		const files = plant(w);
		const db = new SessionDatabase(w.root);
		try {
			db.openSession("main", w.main);
			const result = await run(w);
			assert.equal(result.rewrite.status, "refused");
			assert.deepEqual(result.forks, []);
			assert.equal(files.filter((f) => !f.endsWith("clean.md")).every((f) => fs.readFileSync(f, "utf8").includes(SECRET)), true);
			assert.equal(fs.readFileSync(w.forkA, "utf8").includes(SECRET), true);
		} finally { db.close(); }
	} finally { cleanup(w); }
});

test("a cache manifest entry that points outside its store never reaches a path", () => {
	const w = world();
	try {
		const outside = path.join(w.root, "outside.md");
		fs.writeFileSync(outside, SECRET);
		const pool = path.join(w.root, "context-cache", "pool");
		fs.mkdirSync(pool, { recursive: true });
		fs.writeFileSync(path.join(pool, "_manifest.json"), JSON.stringify({ version: 1, files: { "../../outside.md": { description: "x", createdBy: "main", updatedBy: "main", created: TS, updated: TS, sizeBytes: 1 } } }));
		const result = cleanDerivedStores({ agentDir: w.root, sessionId: "main", sessionFile: w.main, texts: [SECRET] });
		assert.equal(fs.existsSync(outside) && fs.readFileSync(outside, "utf8"), SECRET);
		assert.deepEqual(result.removed, []);
	} finally { cleanup(w); }
});

test("a symlinked cache pool is not followed out of the profile", () => {
	const w = world();
	try {
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-outside-"));
		try {
			fs.writeFileSync(path.join(elsewhere, "doc.md"), SECRET);
			fs.mkdirSync(path.join(w.root, "context-cache"), { recursive: true });
			fs.symlinkSync(elsewhere, path.join(w.root, "context-cache", "pool"));
			const result = cleanDerivedStores({ agentDir: w.root, sessionId: "main", sessionFile: w.main, texts: [SECRET] });
			assert.equal(fs.existsSync(path.join(elsewhere, "doc.md")) && fs.readFileSync(path.join(elsewhere, "doc.md"), "utf8"), SECRET);
			assert.equal(result.failed.length > 0, true);
		} finally { removeFixtureDirNow(elsewhere); }
	} finally { cleanup(w); }
});

test("a session path outside the sessions directory is refused", async () => {
	const w = world();
	try {
		const outside = path.join(w.root, "other.jsonl");
		fs.writeFileSync(outside, [header("o"), msg("o1", null, "user", SECRET)].join("\n") + "\n");
		const result = await run(w, { session: { id: "o", path: outside } });
		assert.equal(result.rewrite.status, "refused");
		assert.equal(fs.readFileSync(outside, "utf8").includes(SECRET), true);
	} finally { cleanup(w); }
});
