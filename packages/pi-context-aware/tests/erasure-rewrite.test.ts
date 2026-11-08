import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionDatabase, sessionDatabaseFile } from "../src/erasure/database.js";
import { rewriteSession, type RewriteOptions } from "../src/erasure/session-rewrite.js";
import { createRegistryProjection, createSessionRegistry } from "../src/session/session-registry.js";
import { asPiSessionId, asWorkstreamId } from "../src/workstream/workstream-schema.js";

const NEEDLE = "hunter2-NEEDLE";
const NOW = () => new Date("2026-11-08T12:00:00Z");
const MARKER = "[erased 2026-11-08]";

interface Fixture { root: string; file: string; dir: string }

function entry(id: string, parentId: string | null, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, parentId, timestamp: "2026-11-01T00:00:00.000Z", message });
}

/** user -> assistant with a tool call whose id contains the secret -> its result -> final reply, plus a custom entry. */
function sessionLines(): string[] {
	return [
		JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/work" }),
		entry("e1", null, { role: "user", content: "please keep the token " + NEEDLE + " safe", timestamp: 1 }),
		entry("e2", "e1", { role: "assistant", content: [{ type: "text", text: "running with " + NEEDLE }, { type: "toolCall", id: "call_" + NEEDLE, name: "bash", arguments: { command: "echo " + NEEDLE } }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 }),
		entry("e3", "e2", { role: "toolResult", toolCallId: "call_" + NEEDLE, toolName: "bash", content: [{ type: "text", text: NEEDLE + "\n" }], details: { stdout: NEEDLE }, isError: false, timestamp: 3 }),
		entry("e4", "e3", { role: "assistant", content: [{ type: "text", text: "all done" }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 4 }),
		JSON.stringify({ type: "custom", id: "e5", parentId: "e4", timestamp: "2026-11-01T00:00:00.000Z", customType: "other-extension", data: { note: NEEDLE } }),
	];
}

function fixture(lines = sessionLines()): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-rewrite-"));
	const dir = path.join(root, "sessions", "project");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "2026-11-01T00-00-00-000Z_s1.jsonl");
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return { root, file, dir };
}

const cleanup = (f: Fixture) => fs.rmSync(f.root, { recursive: true, force: true });
const options = (f: Fixture, over: Partial<RewriteOptions> & Pick<RewriteOptions, "selector">): RewriteOptions => ({ agentDir: f.root, sessionFile: f.file, now: NOW, ...over });
const match = (text: string) => ({ kind: "match", text }) as const;
const range = (value: string) => ({ kind: "range", range: value }) as const;

function structure(file: string) {
	const manager = SessionManager.open(file);
	return manager.getEntries().map((e) => {
		const message = e.type === "message" ? e.message as unknown as { role: string; toolCallId?: string; content?: unknown } : undefined;
		const calls = Array.isArray(message?.content) ? (message.content as { type: string; id?: string }[]).filter((p) => p.type === "toolCall").map((p) => p.id) : [];
		return { id: e.id, parentId: e.parentId, type: e.type, role: message?.role, toolCallId: message?.toolCallId, calls };
	});
}

function registryLease(root: string, id: string) {
	const store = createSessionRegistry({ registryRoot: path.join(root, "session-registry", "v1"), projectKey: "project" });
	const projection = createRegistryProjection({
		piSessionId: asPiSessionId(id), projectKey: "project", incarnation: "incarnation", pid: process.pid,
		pidStart: "2026-01-01T00:00:00.000Z", workstreamId: asWorkstreamId("workstream"), sequence: 1, state: "active",
		objective: "objective", status: "active", refs: [], heartbeatAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
	});
	assert.equal(store.write(projection).ok, true);
	return store;
}

test("rewrite match: tombstones content, the real session loader still loads it, and tree and call/result pairing are unchanged", () => {
	const f = fixture();
	try {
		const before = structure(f.file);
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "erased");
		if (result.status !== "erased") return;
		assert.deepEqual(result.entries.map((e) => e.entryId), ["e1", "e2", "e3"]);
		assert.deepEqual(structure(f.file), before);
		// The unchanged tool call id is still paired with its result, and the loaded context has all four messages.
		const manager = SessionManager.open(f.file);
		const messages = manager.buildSessionContext().messages as unknown as { role: string; toolCallId?: string; content?: unknown }[];
		assert.equal(messages.length, 4);
		assert.equal(messages.find((m) => m.role === "toolResult")?.toolCallId, "call_" + NEEDLE);
		const text = fs.readFileSync(f.file, "utf8");
		const [assistant] = JSON.parse(text.split("\n")[2]!).message.content as { type: string; text?: string; arguments?: unknown }[];
		assert.equal(assistant?.text, MARKER);
		assert.deepEqual(JSON.parse(text.split("\n")[3]!).message.details, undefined);
		// The kept reply is byte-identical.
		assert.equal(text.split("\n")[4], sessionLines()[4]);
		assert.equal(text.endsWith("\n"), true);
	} finally { cleanup(f); }
});

test("rewrite match: a string equal to a tool-call id erases the content that holds it and leaves ids, parents, roles and call ids alone", () => {
	const id = "call_" + NEEDLE;
	const lines = sessionLines();
	lines[2] = entry("e2", "e1", { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id, name: "bash", arguments: { command: "grep " + id + " log" } }], timestamp: 2 });
	lines[3] = entry("e3", "e2", { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "found " + id }], isError: false, timestamp: 3 });
	const f = fixture(lines);
	try {
		const before = structure(f.file);
		const result = rewriteSession(options(f, { selector: match(id) }));
		assert.equal(result.status, "erased");
		if (result.status !== "erased") return;
		assert.deepEqual(result.entries.map((e) => e.entryId), ["e2", "e3"]);
		assert.deepEqual(structure(f.file), before);
		const text = fs.readFileSync(f.file, "utf8").split("\n");
		assert.equal(JSON.parse(text[2]!).message.content[1].id, id);
		assert.equal(JSON.parse(text[3]!).message.toolCallId, id);
		assert.equal(JSON.parse(text[2]!).message.content[1].arguments.erased, MARKER);
		assert.equal(JSON.parse(text[3]!).message.content[0].text, MARKER);
		const messages = SessionManager.open(f.file).buildSessionContext().messages as unknown as { role: string; toolCallId?: string }[];
		assert.equal(messages.find((m) => m.role === "toolResult")?.toolCallId, id);
	} finally { cleanup(f); }
});

test("rewrite match: erases the arguments and errors of nested calls a tool made, and keeps their ids and names", () => {
	const lines = sessionLines();
	lines[3] = entry("e3", "e2", { role: "toolResult", toolCallId: "call_" + NEEDLE, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3,
		nestedCalls: { complete: true, calls: [{ id: "n1", name: "read", arguments: { path: "/secret/" + NEEDLE }, status: "error", error: "failed " + NEEDLE, durationMs: 5 }] } });
	const f = fixture(lines);
	try {
		const result = rewriteSession(options(f, { selector: match("/secret/" + NEEDLE) }));
		assert.equal(result.status, "erased");
		const call = JSON.parse(fs.readFileSync(f.file, "utf8").split("\n")[3]!).message.nestedCalls.calls[0];
		assert.deepEqual(call, { id: "n1", name: "read", status: "error", durationMs: 5 });
	} finally { cleanup(f); }
});

test("rewrite match: a string that appears only in ids and structure changes nothing and names where it survives", () => {
	const lines = sessionLines();
	lines[2] = entry("e2", "e1", { role: "assistant", content: [{ type: "text", text: "no secret here" }, { type: "toolCall", id: "call_ONLYID", name: "bash", arguments: { command: "ls" } }], timestamp: 2 });
	lines[3] = entry("e3", "e2", { role: "toolResult", toolCallId: "call_ONLYID", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 });
	const f = fixture(lines);
	try {
		const original = fs.readFileSync(f.file);
		const result = rewriteSession(options(f, { selector: match("call_ONLYID") }));
		assert.equal(result.status, "nothing-to-erase");
		if (result.status !== "nothing-to-erase") return;
		assert.deepEqual(result.unreached, ["e2", "e3"]);
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite match: a match inside an id and inside content erases the content and keeps the id", () => {
	const f = fixture();
	try {
		const result = rewriteSession(options(f, { selector: match("NEEDLE") }));
		assert.equal(result.status, "erased");
		if (result.status !== "erased") return;
		const after = fs.readFileSync(f.file, "utf8");
		// The id keeps its text, so the file still contains the substring there; the tool-call ids are the proof.
		assert.deepEqual([...result.unreached].sort(), ["e2", "e3", "e5"].sort());
		assert.equal(JSON.parse(after.split("\n")[2]!).message.content[1].id, "call_" + NEEDLE);
		assert.equal(JSON.parse(after.split("\n")[3]!).message.toolCallId, "call_" + NEEDLE);
		assert.equal(JSON.parse(after.split("\n")[2]!).message.content[1].arguments.erased, MARKER);
	} finally { cleanup(f); }
});

test("rewrite range: a range by entry id and by acp ref erases exactly the entries between", () => {
	const f = fixture();
	try {
		const byId = rewriteSession(options(f, { selector: range("e2..e3") }));
		assert.equal(byId.status, "erased");
		if (byId.status !== "erased") return;
		assert.deepEqual(byId.entries.map((e) => e.entryId), ["e2", "e3"]);
		assert.equal(fs.readFileSync(f.file, "utf8").split("\n")[1], sessionLines()[1]);
	} finally { cleanup(f); }
	const g = fixture();
	try {
		// Refs number the model-visible messages in order: m00001 is e1. A bare m00003 is the tool result e3.
		const byRef = rewriteSession(options(g, { selector: range("m00001..m00001") }));
		assert.equal(byRef.status, "erased");
		if (byRef.status !== "erased") return;
		assert.deepEqual(byRef.entries.map((e) => e.entryId), ["e1"]);
	} finally { cleanup(g); }
});

test("rewrite range: reversed, unknown and non-path endpoints are refused without touching the file", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		for (const value of ["e3..e1", "e1..nope", "m09999..e2", "e1", "..e2", "e1..", "e1..e2..e3"]) {
			const result = rewriteSession(options(f, { selector: range(value) }));
			assert.equal(result.status, "refused", value);
			assert.deepEqual(fs.readFileSync(f.file), original, value);
		}
		assert.equal(rewriteSession(options(f, { selector: match("") })).status, "refused");
	} finally { cleanup(f); }
});

test("rewrite refuses a session held by a live ledger lease and leaves the file byte-identical", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		const db = new SessionDatabase(f.root);
		db.openSession("s1", f.file);
		db.close();
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "refused");
		assert.match(result.status === "refused" ? result.reason : "", /open/u);
		assert.deepEqual(fs.readFileSync(f.file), original);
		const release = new SessionDatabase(f.root);
		release.closeSession("s1");
		release.close();
		assert.equal(rewriteSession(options(f, { selector: match(NEEDLE) })).status, "erased");
	} finally { cleanup(f); }
});

test("rewrite refuses a session held by a live registry projection", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		registryLease(f.root, "s1");
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "refused");
		assert.match(result.status === "refused" ? result.reason : "", /open/u);
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite refuses the session this process has open even when no lease is recorded", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		const result = rewriteSession(options(f, { selector: match(NEEDLE), currentSessionId: "s1" }));
		assert.equal(result.status, "refused");
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite refuses when liveness cannot be established", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		const project = path.join(f.root, "session-registry", "v1", "project");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "s1.json"), JSON.stringify({ state: "active" }));
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "refused");
		assert.match(result.status === "refused" ? result.reason : "", /closed/u);
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite confinement: a path outside the sessions directory is refused and no file is touched", () => {
	const f = fixture();
	try {
		const elsewhere = path.join(f.root, "other");
		fs.mkdirSync(elsewhere);
		const insideProfile = path.join(elsewhere, "s1.jsonl");
		fs.writeFileSync(insideProfile, sessionLines().join("\n") + "\n");
		const outsideProfile = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-rewrite-outside-"));
		const outsideFile = path.join(outsideProfile, "s1.jsonl");
		fs.writeFileSync(outsideFile, sessionLines().join("\n") + "\n");
		const seen = new Map([insideProfile, outsideFile, f.file].map((file) => [file, fs.readFileSync(file)]));
		try {
			for (const target of [insideProfile, outsideFile, path.join(f.dir, "..", "..", "other", "s1.jsonl"), path.join(f.root, "sessions", "..", "other", "s1.jsonl"), path.join(f.root, "sessions"), f.dir, "", "s1.jsonl", path.join(f.dir, "s1.txt")]) {
				const result = rewriteSession(options(f, { sessionFile: target, selector: match(NEEDLE) }));
				assert.equal(result.status, "refused", target);
			}
			for (const [file, bytes] of seen) assert.deepEqual(fs.readFileSync(file), bytes, file);
		} finally { fs.rmSync(outsideProfile, { recursive: true, force: true }); }
	} finally { cleanup(f); }
});

test("rewrite confinement: a symlinked session file or directory that leaves the store is refused and its target is untouched", () => {
	const f = fixture();
	const outsideProfile = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-rewrite-link-"));
	try {
		const outsideFile = path.join(outsideProfile, "s1.jsonl");
		fs.writeFileSync(outsideFile, sessionLines().join("\n") + "\n");
		const original = fs.readFileSync(outsideFile);
		const linkedFile = path.join(f.dir, "linked.jsonl");
		fs.symlinkSync(outsideFile, linkedFile);
		const linkedDir = path.join(f.root, "sessions", "linked-dir");
		fs.symlinkSync(outsideProfile, linkedDir);
		for (const target of [linkedFile, path.join(linkedDir, "s1.jsonl")]) {
			const result = rewriteSession(options(f, { sessionFile: target, selector: match(NEEDLE) }));
			assert.equal(result.status, "refused", target);
		}
		assert.deepEqual(fs.readFileSync(outsideFile), original);
		assert.equal(fs.lstatSync(linkedFile).isSymbolicLink(), true);
	} finally { fs.rmSync(outsideProfile, { recursive: true, force: true }); cleanup(f); }
});

test("rewrite refuses a hard-linked session file, which could alias a file outside the store", () => {
	const f = fixture();
	try {
		fs.linkSync(f.file, path.join(f.root, "alias.jsonl"));
		const original = fs.readFileSync(f.file);
		assert.equal(rewriteSession(options(f, { selector: match(NEEDLE) })).status, "failed");
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite ledger: holds the session id, entry ids and hashes, and neither the database nor its WAL holds the text", () => {
	const f = fixture();
	try {
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "erased");
		const db = new SessionDatabase(f.root);
		try {
			const rows = db.erasedEntries("s1");
			assert.deepEqual(rows.map((row) => row.entryId), ["e1", "e2", "e3"]);
			for (const row of rows) { assert.match(row.hash, /^[0-9a-f]{64}$/u); assert.equal(row.erasedOn, "2026-11-08"); }
			assert.equal(new Set(rows.map((row) => row.hash)).size, 3);
		} finally { db.close(); }
		// Read the files while a connection may still hold the WAL: the database, its WAL and shared memory.
		const reader = new SessionDatabase(f.root);
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				const file = sessionDatabaseFile(f.root) + suffix;
				if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(NEEDLE), false, file);
			}
		} finally { reader.close(); }
		assert.equal(fs.readFileSync(sessionDatabaseFile(f.root)).includes("s1"), true);
	} finally { cleanup(f); }
});

test("rewrite is atomic: a crash between the temporary write and the rename leaves the original intact and no debris", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		const result = rewriteSession(options(f, { selector: match(NEEDLE), beforeRename: () => {
			assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith(".tmp")), true);
			throw new Error("simulated crash");
		} }));
		assert.equal(result.status, "failed");
		assert.deepEqual(fs.readFileSync(f.file), original);
		assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
		// The ledger records an erasure only for a rewrite that reached the rename.
		const db = new SessionDatabase(f.root);
		try { assert.deepEqual(db.erasedEntries("s1"), []); } finally { db.close(); }
	} finally { cleanup(f); }
});

test("rewrite refuses when the session file changes while the rewrite runs, and keeps the other writer's bytes", () => {
	const f = fixture();
	try {
		let written: Buffer | undefined;
		const result = rewriteSession(options(f, { selector: match(NEEDLE), beforeRename: () => {
			fs.appendFileSync(f.file, entry("e6", "e5", { role: "user", content: "late write", timestamp: 9 }) + "\n");
			written = fs.readFileSync(f.file);
		} }));
		assert.equal(result.status, "refused");
		assert.deepEqual(fs.readFileSync(f.file), written);
		assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
	} finally { cleanup(f); }
});

test("rewrite is locked: a rewrite already in progress is refused, and a dead owner's lock is cleared", () => {
	const f = fixture();
	try {
		const original = fs.readFileSync(f.file);
		const lock = path.join(f.dir, "." + path.basename(f.file) + ".rewrite-lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "other" }));
		const refused = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(refused.status, "refused");
		assert.match(refused.status === "refused" ? refused.reason : "", /in progress/u);
		assert.deepEqual(fs.readFileSync(f.file), original);
		assert.equal(fs.existsSync(lock), true, "a refused rewrite must not remove another rewrite's lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "dead" }));
		assert.equal(rewriteSession(options(f, { selector: match(NEEDLE) })).status, "erased");
		assert.equal(fs.existsSync(lock), false);
		fs.writeFileSync(lock, "not json");
		assert.equal(rewriteSession(options(f, { selector: match("anything") })).status, "refused");
	} finally { cleanup(f); }
});

test("rewrite concurrency: a second rewrite started inside the first is refused", () => {
	const f = fixture();
	try {
		let inner: ReturnType<typeof rewriteSession> | undefined;
		const outer = rewriteSession(options(f, { selector: match(NEEDLE), beforeRename: () => { inner = rewriteSession(options(f, { selector: match(NEEDLE) })); } }));
		assert.equal(outer.status, "erased");
		assert.equal(inner?.status, "refused");
		assert.match(inner?.status === "refused" ? inner.reason : "", /in progress/u);
	} finally { cleanup(f); }
});

test("rewrite backup: kept only when asked, private, and byte-identical to the original", () => {
	const f = fixture();
	try {
		assert.equal(rewriteSession(options(f, { selector: match("keep") })).status, "erased");
		assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
	} finally { cleanup(f); }
	const g = fixture();
	try {
		const original = fs.readFileSync(g.file);
		const result = rewriteSession(options(g, { selector: match(NEEDLE), backup: true }));
		assert.equal(result.status, "erased");
		if (result.status !== "erased") return;
		assert.ok(result.backup);
		assert.deepEqual(fs.readFileSync(result.backup!), original);
		assert.equal(fs.lstatSync(result.backup!).mode & 0o777, 0o600);
		assert.equal(path.dirname(result.backup!), g.dir);
	} finally { cleanup(g); }
});

test("rewrite refuses a match that appears in a line it cannot read, instead of leaving it behind", () => {
	const lines = sessionLines();
	lines.splice(2, 0, '{"broken": "' + NEEDLE);
	const f = fixture(lines);
	try {
		const original = fs.readFileSync(f.file);
		const result = rewriteSession(options(f, { selector: match(NEEDLE) }));
		assert.equal(result.status, "refused");
		assert.deepEqual(fs.readFileSync(f.file), original);
	} finally { cleanup(f); }
});

test("rewrite refuses a file with no session header, an erased session, and keeps CRLF lines and the file mode", () => {
	const f = fixture(sessionLines().slice(1));
	try { assert.equal(rewriteSession(options(f, { selector: match(NEEDLE) })).status, "refused"); } finally { cleanup(f); }
	const g = fixture();
	try {
		const db = new SessionDatabase(g.root);
		db.erase(["s1"]);
		db.close();
		assert.equal(rewriteSession(options(g, { selector: match(NEEDLE) })).status, "refused");
	} finally { cleanup(g); }
	const h = fixture();
	try {
		fs.writeFileSync(h.file, sessionLines().join("\r\n") + "\r\n");
		fs.chmodSync(h.file, 0o640);
		assert.equal(rewriteSession(options(h, { selector: match(NEEDLE) })).status, "erased");
		assert.equal(fs.lstatSync(h.file).mode & 0o777, 0o640);
		const text = fs.readFileSync(h.file, "utf8");
		assert.equal(text.split("\r\n").length, 7);
		assert.equal(text.includes(MARKER), true);
	} finally { cleanup(h); }
});

test("rewrite is idempotent: erasing the same range twice changes nothing the second time", () => {
	const f = fixture();
	try {
		assert.equal(rewriteSession(options(f, { selector: range("e1..e3") })).status, "erased");
		const once = fs.readFileSync(f.file);
		const again = rewriteSession(options(f, { selector: range("e1..e3"), now: () => new Date("2026-12-25T00:00:00Z") }));
		assert.equal(again.status, "nothing-to-erase");
		assert.deepEqual(fs.readFileSync(f.file), once);
	} finally { cleanup(f); }
});
