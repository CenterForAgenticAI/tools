import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ARCHIVE_MARK, archivedNotice, buildStub, normalizeForgeKey, PROMPT_LIMIT, readStub, readStubFile, readStubHead, sessionFacts, STUB_HEAD, type StubDetails } from "../src/core/sessionfile.ts";
import { sandbox } from "./helpers.ts";
import { piSession } from "./sessionfixture.ts";

const details: StubDetails = { schemaVersion: 1, sessionId: "abc", host: "laptop", archive: "--home-u-proj--/s.jsonl.zst", sha256: "ab".repeat(32), size: 123, mtimeMs: 1_700_000_000_000 };

describe("sessionFacts", () => {
	it("reads the id, folder, name, first and last prompt and dates the way Pi's /resume does", () => {
		const text = piSession({ id: "abc", cwd: "/work/u/proj", name: "Fix it", prompts: ["first ask", "second ask", "last ask"], t0: Date.UTC(2026, 0, 1) });
		const f = sessionFacts(text);
		assert.ok(f !== undefined);
		assert.equal(f.id, "abc");
		assert.equal(f.cwd, "/work/u/proj");
		assert.equal(f.name, "Fix it");
		assert.equal(f.firstPrompt, "first ask");
		assert.equal(f.lastPrompt, "last ask");
		assert.equal(f.created, "2026-01-01T00:00:00.000Z");
		// The last activity is the last message's own timestamp: the reply to "last ask".
		assert.equal(f.modified, new Date(Date.UTC(2026, 0, 1) + 3 * 60_000 + 30_000).toISOString());
	});

	it("takes the latest session name, and a cleared name as none", () => {
		const text = piSession({ id: "a", cwd: "/p", name: "old", prompts: ["x"], t0: 0 }) + JSON.stringify({ type: "session_info", id: "zz", parentId: null, timestamp: "1970-01-02T00:00:00.000Z" }) + "\n";
		assert.equal(sessionFacts(text)?.name, undefined);
	});

	it("is undefined for a file that does not start with a session header", () => {
		assert.equal(sessionFacts('{"type":"message"}\n'), undefined);
		assert.equal(sessionFacts("not json\n"), undefined);
		assert.equal(sessionFacts(""), undefined);
	});
});

describe("stub", () => {
	const text = piSession({ id: "abc", cwd: "/work/u/proj", name: "Fix it", prompts: ["first ask", "middle", "last ask"], t0: Date.UTC(2026, 0, 1) });

	it("round-trips its details and is not grown as written", () => {
		const f = sessionFacts(text);
		assert.ok(f !== undefined);
		const stub = buildStub(f, details, "2026-03-01T00:00:00.000Z");
		const read = readStub(stub);
		assert.deepEqual(read?.details, details);
		assert.equal(read?.grown, false);
		assert.ok(stub.length < 2000, "a stub is small");
		assert.ok(!stub.includes("middle"), "a stub holds only the first and last prompt");
	});

	it("is grown once Pi has appended a line after the archive notice", () => {
		const stub = buildStub(sessionFacts(text)!, details, "2026-03-01T00:00:00.000Z");
		const grown = stub + JSON.stringify({ type: "message", id: "n1", parentId: "x", timestamp: "2026-03-02T00:00:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } }) + "\n";
		assert.equal(readStub(grown)?.grown, true);
		assert.equal(readStub(stub.trimEnd())?.grown, false, "a missing final newline is not growth");
	});

	it("is known by its first lines, however large Pi has made it", () => {
		const stub = buildStub(sessionFacts(text)!, details, "2026-03-01T00:00:00.000Z");
		const line = JSON.stringify({ type: "message", id: "n1", parentId: "x", timestamp: "2026-03-02T00:00:00.000Z", message: { role: "user", content: "z".repeat(4000), timestamp: 1 } }) + "\n";
		const big = Buffer.from(stub + line.repeat(Math.ceil((2 * STUB_HEAD) / line.length)));
		assert.ok(big.length > 2 * STUB_HEAD);
		const head = big.subarray(0, STUB_HEAD);
		assert.ok(head.at(-1) !== 0x0a, "the head ends inside a line");
		assert.deepEqual(readStubHead(head, big.length), { details, grown: true, id: "abc" });
		assert.deepEqual(readStubHead(Buffer.from(stub), Buffer.byteLength(stub)), { details, grown: false, id: "abc" });
		assert.equal(readStubHead(Buffer.from(stub), Buffer.byteLength(stub) + 1)?.grown, true, "bytes past the head are lines after the notice");
		assert.equal(readStubHead(Buffer.from(text), Buffer.byteLength(text)), undefined);
		const s = sandbox();
		try {
			const f = join(s.home, "big.jsonl");
			writeFileSync(f, big);
			assert.deepEqual(readStubFile(f), { details, grown: true, id: "abc" });
			const plain = join(s.home, "plain.jsonl");
			writeFileSync(plain, text + line.repeat(Math.ceil((2 * STUB_HEAD) / line.length)));
			assert.equal(readStubFile(plain), undefined);
		} finally {
			s.cleanup();
		}
	});

	it("fits in the head that is read, whatever the session's name", () => {
		const named = piSession({ id: "abc", cwd: "/w", name: "n".repeat(STUB_HEAD), prompts: ["p".repeat(STUB_HEAD)], t0: 0 });
		const stub = buildStub(sessionFacts(named)!, details, "2026-03-01T00:00:00.000Z");
		assert.ok(Buffer.byteLength(stub) < 16 * 1024, String(Buffer.byteLength(stub)));
	});

	it("is not a stub without the archive notice, or with a notice from someone else", () => {
		assert.equal(readStub(text), undefined);
		const forged = text + JSON.stringify({ type: "custom_message", customType: "other/archived", content: "", display: true, details, id: "q", parentId: null, timestamp: "x" }) + "\n";
		assert.equal(readStub(forged), undefined);
		const bad = text + JSON.stringify({ type: "custom_message", customType: ARCHIVE_MARK, content: "", display: true, details: { ...details, archive: "../../etc/passwd.jsonl.zst" }, id: "q", parentId: null, timestamp: "x" }) + "\n";
		assert.equal(readStub(bad), undefined, "an archive path that climbs out is refused");
	});

	it("is not a stub once forked: the notice names another session", () => {
		const stub = buildStub(sessionFacts(text)!, details, "2026-03-01T00:00:00.000Z");
		const lines = stub.split("\n");
		const header = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		const forked = [JSON.stringify({ ...header, id: "fork-id" }), ...lines.slice(1)].join("\n");
		assert.equal(readStub(forked), undefined);
		assert.deepEqual(archivedNotice(forked), { sessionId: "abc", own: false });
		assert.deepEqual(archivedNotice(stub), { sessionId: "abc", own: true });
		assert.equal(archivedNotice(text), undefined);
	});

	it("cuts a long prompt", () => {
		const long = "y".repeat(PROMPT_LIMIT * 3);
		const f = sessionFacts(piSession({ id: "a", cwd: "/p", prompts: [long], t0: 0 }))!;
		assert.equal(f.firstPrompt?.length, PROMPT_LIMIT);
		assert.ok(buildStub(f, details, "2026-03-01T00:00:00.000Z").length < PROMPT_LIMIT * 2 + 2000);
	});

	it("is listed by Pi with its id, name, folder and first prompt, and opens with the restore notice", async () => {
		const s = sandbox();
		try {
			const dir = join(s.home, "sessions", "--home-u-proj--");
			mkdirSync(dir, { recursive: true });
			const f = sessionFacts(text)!;
			writeFileSync(join(dir, "s.jsonl"), buildStub(f, details, "2026-03-01T00:00:00.000Z"));
			const listed = await SessionManager.list("/work/u/proj", dir);
			assert.equal(listed.length, 1);
			assert.equal(listed[0]?.id, "abc");
			assert.equal(listed[0]?.name, "Fix it");
			assert.equal(listed[0]?.cwd, "/work/u/proj");
			assert.equal(listed[0]?.firstMessage, "first ask");
			assert.equal(listed[0]?.modified.toISOString(), f.modified);
			const opened = SessionManager.open(join(dir, "s.jsonl"), dir);
			const shown = JSON.stringify(opened.buildSessionContext().messages);
			assert.match(shown, /pi-profile sessions restore abc/);
		} finally {
			s.cleanup();
		}
	});
});

describe("normalizeForgeKey", () => {
	for (const [url, key] of [
		["git@gitlab.example.com:group/proj.git", "gitlab.example.com/group/proj"],
		["ssh://git@GitLab.Example.com:2222/group/sub/proj.git/", "gitlab.example.com/group/sub/proj"],
		["https://user:tok@github.com/o/r.git", "github.com/o/r"],
		["https://github.com/o/r", "github.com/o/r"],
	] as const) {
		it(url, () => assert.equal(normalizeForgeKey(url), key));
	}
	it("is undefined for a local path or nonsense", () => {
		assert.equal(normalizeForgeKey("/srv/git/r.git"), undefined);
		assert.equal(normalizeForgeKey("file:///srv/git/r.git"), undefined);
		assert.equal(normalizeForgeKey(""), undefined);
	});
});
