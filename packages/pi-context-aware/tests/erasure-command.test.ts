import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionDatabase } from "../src/erasure/database.js";
import { parseEraseArgs } from "../src/erasure/erase-command.js";
import { registerSessionErasure } from "../src/erasure/extension.js";
import { writeManifest } from "../src/cache/context-cache.js";
import { paritySessionFile } from "../src/parity/records.js";
import { removeFixtureDirNow } from "./fixture-cleanup.js";

const NEEDLE = "ERASE-NEEDLE-366";
const TS = "2026-11-01T00:00:00.000Z";
const header = (id: string, parent?: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: TS, cwd: "/w", ...(parent ? { parentSession: parent } : {}) });
const msg = (id: string, parentId: string | null, role: string, text: string) => JSON.stringify({ type: "message", id, parentId, timestamp: TS, message: { role, content: [{ type: "text", text }], timestamp: 1 } });
const base = () => [msg("e1", null, "user", "hello there"), msg("e2", "e1", "assistant", "the key is " + NEEDLE), msg("e3", "e2", "user", "thanks, noted")];

interface World { root: string; main: string; forkA: string; forkB: string; notices: string[]; dialogs: string[]; answers: (title: string, message: string) => boolean; run: (args: string) => Promise<void> }

function world(): World {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-command-"));
	const dir = path.join(root, "sessions", "proj");
	fs.mkdirSync(dir, { recursive: true });
	const main = path.join(dir, "2026_main.jsonl");
	const forkA = path.join(dir, "2026_forka.jsonl");
	const forkB = path.join(dir, "2026_forkb.jsonl");
	const summary = JSON.stringify({ type: "compaction", id: "c1", parentId: "e3", timestamp: TS, summary: "The user shared " + NEEDLE + " earlier.", firstKeptEntryId: "e3", tokensBefore: 10 });
	fs.writeFileSync(main, [header("main"), ...base(), summary].join("\n") + "\n");
	fs.writeFileSync(forkA, [header("forka", main), ...base(), msg("a1", "e3", "user", "own work A")].join("\n") + "\n");
	fs.writeFileSync(forkB, [header("forkb", main), ...base(), msg("b1", "e3", "user", "own work B")].join("\n") + "\n");
	fs.writeFileSync(`${main}.acp.json`, JSON.stringify({ schemaVersion: 1, note: NEEDLE }));
	const parity = paritySessionFile(root, "main");
	fs.mkdirSync(path.dirname(parity), { recursive: true });
	fs.writeFileSync(parity, JSON.stringify({ x: NEEDLE }) + "\n");
	const pool = path.join(root, "context-cache", "pool");
	fs.mkdirSync(pool, { recursive: true });
	fs.writeFileSync(path.join(pool, "doc.md"), "notes: " + NEEDLE);
	writeManifest(pool, { version: 1, files: { "doc.md": { description: "mentions " + NEEDLE, createdBy: "main", updatedBy: "main", created: TS, updated: TS, sizeBytes: 10 } } });
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = { on: () => {}, registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI;
	registerSessionErasure(pi, () => root, async () => {});
	const w: World = { root, main, forkA, forkB, notices: [], dialogs: [], answers: () => true, run: async () => {} };
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => "current", getSessionFile: () => null }, ui: { notify: (text: string) => w.notices.push(text), confirm: async (title: string, message: string) => { w.dialogs.push(title + "\n" + message); return w.answers(title, message); } } } as unknown as ExtensionContext;
	w.run = (args) => commands.get("session-erase")!.handler(args, ctx);
	return w;
}
const cleanup = (w: World) => removeFixtureDirNow(w.root);
const filesHolding = (root: string, text: string): string[] => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).filter((f) => fs.readFileSync(f).toString("latin1").includes(text));
const listing = (root: string): string[] => fs.readdirSync(root, { recursive: true }).map(String).sort();
const bytes = (...files: string[]) => files.map((f) => fs.readFileSync(f).toString("base64"));

test("--match: after the command no file under the profile holds the needle, in sessions, forks, folds, cache, parity or the ledger", async () => {
	const w = world();
	try {
		assert.ok(filesHolding(w.root, NEEDLE).length >= 7);
		await w.run("main --match " + NEEDLE);
		assert.match(w.notices.at(-1)!, /Session erasure: complete/u);
		assert.deepEqual(filesHolding(w.root, NEEDLE), []);
		assert.equal(fs.readFileSync(w.forkA, "utf8").includes("own work A"), true);
	} finally { cleanup(w); }
});

test("--range: erases the entries between two entry ids and leaves the rest", async () => {
	const w = world();
	try {
		await w.run("main --range e1..e2");
		assert.match(w.notices.at(-1)!, /Session erasure: complete/u);
		const main = fs.readFileSync(w.main, "utf8");
		assert.equal(main.includes(NEEDLE), false);
		assert.equal(main.includes("hello there"), false);
		assert.equal(main.includes("thanks, noted"), true);
	} finally { cleanup(w); }
});

test("preview lists the entries and every fork; a declined fork stays byte-identical and is named under Untouched", async () => {
	const w = world();
	try {
		const declined = bytes(w.forkB);
		w.answers = (title) => !title.includes("forkb");
		await w.run("main --match " + NEEDLE);
		const preview = w.dialogs[0]!;
		assert.match(preview, /Entries to erase in this session \(2\): e2, c1/u);
		assert.match(preview, /forka: 1 entries/u);
		assert.match(preview, /forkb: 1 entries/u);
		assert.equal(w.dialogs.filter((d) => d.startsWith("Also erase from fork")).length, 2);
		assert.deepEqual(bytes(w.forkB), declined);
		assert.equal(fs.readFileSync(w.forkA, "utf8").includes(NEEDLE), false);
		const receipt = w.notices.at(-1)!;
		assert.match(receipt, /Untouched:[\s\S]*Declined fork forkb: /u);
		assert.match(receipt, /Erased:[\s\S]*Fork forka: 1 entries/u);
		assert.match(receipt, /Fabric memory index: not cleaned/u);
		assert.match(receipt, /Live sessions are refused/u);
	} finally { cleanup(w); }
});

test("declining the preview writes nothing", async () => {
	const w = world();
	try {
		const before = bytes(w.main, w.forkA, w.forkB);
		const profileBefore = listing(w.root);
		w.answers = () => false;
		await w.run("main --match " + NEEDLE);
		assert.match(w.notices.at(-1)!, /cancelled/u);
		assert.deepEqual(bytes(w.main, w.forkA, w.forkB), before);
		assert.deepEqual(listing(w.root), profileBefore);
	} finally { cleanup(w); }
});

test("the ledger, the preview, the receipt and every notice hold ids and hashes only", async () => {
	const w = world();
	try {
		await w.run("main --match " + NEEDLE);
		assert.equal(w.dialogs.join("\n").includes(NEEDLE), false);
		assert.equal(w.notices.join("\n").includes(NEEDLE), false);
		const db = new SessionDatabase(w.root);
		try {
			const rows = db.erasedEntries("main");
			assert.deepEqual(rows.map((r) => r.entryId), ["c1", "e2"]);
			for (const row of rows) assert.match(row.hash, /^[0-9a-f]{64}$/u);
			assert.equal(JSON.stringify(rows).includes(NEEDLE), false);
		} finally { db.close(); }
		assert.deepEqual(filesHolding(w.root, NEEDLE), []);
	} finally { cleanup(w); }
});

test("a live session is refused with a message and nothing is written", async () => {
	const w = world();
	const db = new SessionDatabase(w.root);
	try {
		const before = bytes(w.main, w.forkA, w.forkB);
		db.openSession("main", w.main);
		await w.run("main --match " + NEEDLE);
		assert.match(w.notices.at(-1)!, /refused\. Session is open/u);
		assert.deepEqual(bytes(w.main, w.forkA, w.forkB), before);
		assert.equal(w.dialogs.length, 0);
		assert.equal(filesHolding(w.root, NEEDLE).length >= 7, true);
	} finally { db.close(); cleanup(w); }
});

test("a range ref that does not resolve is refused and nothing is written", async () => {
	const w = world();
	try {
		const before = bytes(w.main, w.forkA, w.forkB);
		for (const range of ["m99999..e2", "e1..zz", "e3..e1", "e2"]) {
			await w.run("main --range " + range);
			assert.match(w.notices.at(-1)!, /refused|Usage/u, range);
		}
		await w.run("main --range m99999..e2");
		assert.match(w.notices.at(-1)!, /Unknown message ref in range\. Nothing was written/u);
		assert.deepEqual(bytes(w.main, w.forkA, w.forkB), before);
		assert.equal(w.dialogs.length, 0);
	} finally { cleanup(w); }
});

test("a session path outside the store is refused and nothing is written", async () => {
	const w = world();
	try {
		const outside = path.join(w.root, "other.jsonl");
		fs.writeFileSync(outside, [header("o"), msg("o1", null, "user", NEEDLE)].join("\n") + "\n");
		const before = bytes(outside, w.main);
		for (const target of [outside, path.join(w.root, "sessions", "..", "other.jsonl"), "/etc/passwd"]) {
			await w.run(`--session ${target} --match ${NEEDLE}`);
			assert.match(w.notices.at(-1)!, /refused\./u, target);
		}
		assert.deepEqual(bytes(outside, w.main), before);
		assert.equal(w.dialogs.length, 0);
	} finally { cleanup(w); }
});

test("bad flag combinations print usage and write nothing", async () => {
	const w = world();
	try {
		const before = bytes(w.main);
		for (const args of ["main --range e1..e2 --match x", "--match " + NEEDLE, "main --match", "main --match a --match b"]) {
			await w.run(args);
			assert.match(w.notices.at(-1)!, /Usage|Name the closed|twice|not both/u, args);
		}
		assert.deepEqual(bytes(w.main), before);
	} finally { cleanup(w); }
});

test("the plain session-id form is not taken by the new parser", () => {
	assert.equal(parseEraseArgs("some-session-id"), undefined);
	assert.equal(parseEraseArgs("  abc  "), undefined);
	assert.deepEqual(parseEraseArgs("abc --match a b"), { kind: "text", session: "abc", selector: { kind: "match", text: "a b" } });
	assert.deepEqual(parseEraseArgs("abc --range m00001..m00003"), { kind: "text", session: "abc", selector: { kind: "range", range: "m00001..m00003" } });
});

test("no line shown to the user holds the needle, even when a store path or a refusal holds it", async () => {
	const w = world();
	try {
		// A derived store whose file name holds the needle reaches the preview and the receipt.
		const pool = path.join(w.root, "context-cache", "pool");
		fs.writeFileSync(path.join(pool, NEEDLE + ".md"), "notes: " + NEEDLE);
		await w.run("main --match " + NEEDLE);
		assert.match(w.notices.at(-1)!, /Session erasure: /u);
		assert.ok(w.dialogs.length > 0);
		assert.equal(w.dialogs.join("\n").includes(NEEDLE), false);
		assert.equal(w.notices.join("\n").includes(NEEDLE), false);
		assert.match(w.dialogs[0]!, /line withheld/u);
		assert.match(w.notices.at(-1)!, /line withheld/u);
		// A refusal that quotes the session value is withheld too.
		await w.run("../" + NEEDLE + "/x.jsonl --match " + NEEDLE);
		await w.run("main --match " + NEEDLE + "-nothing-here");
		assert.equal(w.notices.join("\n").includes(NEEDLE), false);
	} finally { cleanup(w); }
});
