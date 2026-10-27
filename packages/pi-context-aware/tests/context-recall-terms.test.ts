import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	recallQuery,
	WIDER_SEARCH_BYTE_LIMIT,
	WIDER_SEARCH_SESSION_LIMIT,
	type ContextRecallHost,
	type ContextRecallResult,
	type TranscriptSession,
} from "../src/context-tools/context-recall.js";
import { matchText, planQuery } from "../src/context-tools/transcript-match.js";
import { MAX_SIDE_FILE_BYTES, SESSION_SEARCH_CHARACTERS, TOOL_RESULT_CHARACTERS } from "../src/context-tools/transcript-text.js";

// Seam: recallQuery with a host whose listing points at real session JSONL files.
// The listing's allMessagesText is the chat text Pi's SessionManager would index:
// user and assistant text only. Everything else is read from the file.

interface FixtureSession {
	id: string;
	/** Chat text, as Pi's listing indexes it. */
	chat: string;
	/** Raw session entries written to the file after the header. */
	entries?: unknown[];
	/** Legacy billion-context-pi side file contents. */
	sideFile?: unknown;
	modified: string;
}

interface Fixture {
	root: string;
	ctx: ExtensionContext;
	host: ContextRecallHost;
	query(query: string, extra?: Record<string, unknown>): Promise<ContextRecallResult>;
	cleanup(): void;
}

function userEntry(id: string, text: string): unknown {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text, timestamp: 0 } };
}

function chatEntries(chat: string): unknown[] {
	return chat ? [userEntry("u1", chat)] : [];
}

function makeFixture(sessions: readonly FixtureSession[]): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-terms-")));
	const listed: TranscriptSession[] = sessions.map((session) => {
		const file = path.join(root, `${session.id}.jsonl`);
		const lines = [{ type: "session", version: 3, id: session.id, timestamp: session.modified, cwd: root }, ...chatEntries(session.chat), ...(session.entries ?? [])];
		fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		if (session.sideFile !== undefined) fs.writeFileSync(`${file}.acp.json`, JSON.stringify(session.sideFile));
		return { id: session.id, path: file, cwd: root, modified: new Date(session.modified), messageCount: 1, allMessagesText: session.chat };
	});
	const host: ContextRecallHost = {
		listSessions: async () => ({ sessions: listed, scannedCwds: [root], scopeLabel: "project" }),
		erasedSessionIds: () => new Set(),
		cachePools: () => [],
		home: () => root,
	};
	const ctx = {
		cwd: root,
		sessionManager: { getSessionFile: () => path.join(root, "current.jsonl"), getEntries: () => [] },
	} as unknown as ExtensionContext;
	return {
		root,
		ctx,
		host,
		query: (query, extra = {}) => recallQuery({ query, scope: "prior", ...extra }, ctx, host),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

const hitIds = (result: ContextRecallResult): string[] => result.details.transcripts.results.map((hit) => path.basename(hit.sessionPath, ".jsonl"));
const body = (result: ContextRecallResult): string => result.content.map((part) => part.text).join("\n");

const SPREAD_CHAT = "We moved the fold planner last week. Much later, after lunch, the nudge threshold changed to forty percent.";

test("REQ-199-1: a multi-word query finds a session holding every word apart and out of order", async () => {
	const f = makeFixture([{ id: "spread", chat: SPREAD_CHAT, modified: "2026-01-02T00:00:00.000Z" }]);
	try {
		// Words in a different order and separated: the old one-phrase matcher found nothing.
		const result = await f.query("nudge threshold fold planner");
		assert.deepEqual(hitIds(result), ["spread"], body(result));
		assert.equal(result.details.transcripts.matching, "terms");
		assert.deepEqual(result.details.transcripts.terms, ["nudge", "threshold", "fold", "planner"]);
		assert.equal(result.details.transcripts.results[0]?.match, "terms");
		const snippets = result.details.transcripts.results[0]?.snippets.join(" ") ?? "";
		assert.match(snippets, /nudge threshold/u);
		assert.match(snippets, /fold planner/u);
	} finally { f.cleanup(); }
});

test("REQ-199-1: a session missing one of the words is not returned", async () => {
	const f = makeFixture([{ id: "spread", chat: SPREAD_CHAT, modified: "2026-01-02T00:00:00.000Z" }]);
	try {
		const result = await f.query("nudge threshold compaction");
		assert.deepEqual(hitIds(result), []);
		assert.match(body(result), /No matches for all of the words "nudge", "threshold", "compaction"/u);
	} finally { f.cleanup(); }
});

test("REQ-199-1: stop words are not required, and the exact phrase ranks before scattered words", async () => {
	const f = makeFixture([
		// Newer, words scattered far apart.
		{ id: "scattered", chat: `planner ${"filler ".repeat(200)} fold`, modified: "2026-01-03T00:00:00.000Z" },
		// Older, words next to each other but not the exact query phrase.
		{ id: "near", chat: "the planner for each fold is simple", modified: "2026-01-02T00:00:00.000Z" },
		// Oldest, the exact phrase.
		{ id: "phrase", chat: "see the fold planner notes", modified: "2026-01-01T00:00:00.000Z" },
	]);
	try {
		const result = await f.query("the fold planner");
		assert.deepEqual(hitIds(result), ["phrase", "near", "scattered"]);
		assert.deepEqual(result.details.transcripts.results.map((hit) => hit.match), ["phrase", "terms", "terms"]);
		assert.deepEqual(result.details.transcripts.terms, ["fold", "planner"]);
	} finally { f.cleanup(); }
});

test("REQ-199-1: max_sessions keeps the best-ranked sessions, not the first listed", async () => {
	const f = makeFixture([
		{ id: "scattered", chat: `planner ${"filler ".repeat(200)} fold`, modified: "2026-01-03T00:00:00.000Z" },
		{ id: "phrase", chat: "see the fold planner notes", modified: "2026-01-01T00:00:00.000Z" },
	]);
	try {
		const result = await f.query("fold planner", { max_sessions: 1 });
		assert.deepEqual(hitIds(result), ["phrase"]);
	} finally { f.cleanup(); }
});

test("REQ-199-1: an exact phrase in tool output outranks newer all-terms chat", async () => {
	const f = makeFixture([
		{ id: "newer-chat", chat: "the planner for each fold was updated", modified: "2026-01-03T00:00:00.000Z" },
		{
			id: "older-tool",
			chat: "the planner for each fold was reviewed",
			entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "the fold planner migration completed" }], isError: false, timestamp: 1 } }],
			modified: "2026-01-01T00:00:00.000Z",
		},
	]);
	try {
		const result = await f.query("fold planner", { max_sessions: 1 });
		assert.deepEqual(hitIds(result), ["older-tool"]);
		assert.equal(result.details.transcripts.results[0]?.match, "phrase");
		assert.match(result.details.transcripts.results[0]?.snippets.join(" ") ?? "", /the fold planner migration completed/u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: wider transcript reads stop at the per-call session budget", async () => {
	const f = makeFixture(Array.from({ length: 20 }, (_, index) => ({
		id: `wider-${index}`,
		chat: "Reviewed.",
		entries: [{ type: "message", id: `t${index}`, parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: `c${index}`, toolName: "bash", content: [{ type: "text", text: "the fold planner migration completed" }], isError: false, timestamp: 1 } }],
		modified: new Date(Date.UTC(2026, 0, 20 - index)).toISOString(),
	})));
	try {
		const result = await f.query("fold planner", { max_sessions: 100 });
		const wider = result.details.transcripts.wider_search;
		assert.equal(wider?.sessions_read, WIDER_SEARCH_SESSION_LIMIT);
		assert.equal(wider?.files_read, WIDER_SEARCH_SESSION_LIMIT);
		assert.ok((wider?.bytes_read ?? Infinity) <= WIDER_SEARCH_BYTE_LIMIT);
		assert.equal(wider?.exhausted, true);
		assert.equal(result.details.transcripts.hits, WIDER_SEARCH_SESSION_LIMIT, "each hit requires one session-file read");
	} finally { f.cleanup(); }
});

test("REQ-199-2: an exhausted wider transcript budget is reported", async () => {
	const sessions = Array.from({ length: 9 }, (_, index) => ({
		id: `notice-${index}`,
		chat: "Reviewed.",
		modified: new Date(Date.UTC(2026, 0, 9 - index)).toISOString(),
	}));
	const f = makeFixture(sessions);
	try {
		const result = await f.query("fold planner");
		assert.match(body(result), /Wider transcript budget reached; remaining sessions used chat text only\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: oversized legacy side files are not read", async () => {
	const f = makeFixture([{
		id: "large-side-file",
		chat: "Reviewed.",
		sideFile: { schemaVersion: 1, blocks: [{ blockId: "b2", topic: "Large", summary: `side-limit-marker ${"x".repeat(MAX_SIDE_FILE_BYTES)}` }] },
		modified: "2026-01-01T00:00:00.000Z",
	}]);
	try {
		const result = await f.query("side-limit-marker");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 1);
		assert.match(body(result), /1 transcript file could not be searched \(too large, missing, unreadable or malformed\); its text was skipped\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: an unreadable side file is reported as skipped", async () => {
	const f = makeFixture([{ id: "unreadable-side-file", chat: "Reviewed.", modified: "2026-01-01T00:00:00.000Z" }]);
	try {
		// A directory where the side file belongs: stat succeeds, the read fails.
		fs.mkdirSync(path.join(f.root, "unreadable-side-file.jsonl.acp.json"));
		const result = await f.query("side-limit-marker");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 1);
		assert.match(body(result), /1 transcript file could not be searched \(too large, missing, unreadable or malformed\); its text was skipped\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a listed session whose file has gone is reported as skipped", async () => {
	const f = makeFixture([{ id: "gone", chat: "Reviewed.", modified: "2026-01-01T00:00:00.000Z" }]);
	try {
		fs.rmSync(path.join(f.root, "gone.jsonl"));
		const result = await f.query("side-limit-marker");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 1);
		assert.match(body(result), /1 transcript file could not be searched \(too large, missing, unreadable or malformed\); its text was skipped\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a side file that is not valid JSON is reported as skipped", async () => {
	const f = makeFixture([{ id: "bad-side-file", chat: "Reviewed.", modified: "2026-01-01T00:00:00.000Z" }]);
	try {
		fs.writeFileSync(path.join(f.root, "bad-side-file.jsonl.acp.json"), '{"blocks": [{"summary": "side-limit-marker"');
		const result = await f.query("side-limit-marker");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 1);
		assert.match(body(result), /1 transcript file could not be searched \(too large, missing, unreadable or malformed\); its text was skipped\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a session line that is not valid JSON is reported as skipped", async () => {
	const f = makeFixture([{ id: "bad-line", chat: "Reviewed.", modified: "2026-01-01T00:00:00.000Z" }]);
	try {
		fs.appendFileSync(path.join(f.root, "bad-line.jsonl"), '{"type":"compaction","summary":"side-limit-marker"\n');
		const result = await f.query("side-limit-marker");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.lines_skipped, 1);
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 0);
		assert.match(body(result), /1 transcript line could not be parsed; its text was not searched\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a session missing its side file is not reported as skipped", async () => {
	const f = makeFixture([{ id: "no-side-file", chat: "Reviewed.", modified: "2026-01-01T00:00:00.000Z" }]);
	try {
		const result = await f.query("side-limit-marker");
		assert.equal(result.details.transcripts.wider_search?.files_skipped, 0);
		assert.equal(result.details.transcripts.wider_search?.sessions_truncated, 0);
		assert.equal(result.details.transcripts.wider_search?.lines_skipped, 0);
		assert.doesNotMatch(body(result), /could not be|was not searched/u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a session past the per-session search text limit is reported as truncated", async () => {
	const summary = (text: string, id: string): unknown => ({ type: "compaction", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: text, firstKeptEntryId: "u1", tokensBefore: 1 });
	const f = makeFixture([{
		id: "long-session",
		chat: "Reviewed.",
		// alpha fits; omega lies past the search text limit.
		entries: [summary(`alpha ${"x".repeat(SESSION_SEARCH_CHARACTERS)}`, "c1"), summary("omega", "c2")],
		modified: "2026-01-01T00:00:00.000Z",
	}]);
	try {
		const result = await f.query("alpha omega");
		assert.deepEqual(hitIds(result), []);
		assert.equal(result.details.transcripts.wider_search?.sessions_truncated, 1);
		assert.equal(result.details.transcripts.wider_search?.exhausted, false);
		assert.match(body(result), /1 session had more text than one search covers; text past the first 8,000,000 characters was not searched\./u);
	} finally { f.cleanup(); }
});

test("REQ-199-1: bounded non-chat text leaves the chat match as ranking evidence", async () => {
	const f = makeFixture([{
		id: "bounded-tool",
		chat: "the planner for each fold was reviewed",
		entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `${"x".repeat(TOOL_RESULT_CHARACTERS)} fold planner` }], isError: false, timestamp: 1 } }],
		modified: "2026-01-01T00:00:00.000Z",
	}]);
	try {
		const result = await f.query("fold planner", { max_sessions: 1 });
		assert.deepEqual(hitIds(result), ["bounded-tool"]);
		assert.equal(result.details.transcripts.results[0]?.match, "terms");
		assert.match(result.details.transcripts.results[0]?.snippets.join(" ") ?? "", /planner for each fold/u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: words found only in a tool call or a tool result find that session", async () => {
	const f = makeFixture([
		{
			id: "tool-result",
			chat: "Ran the build.",
			entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "error TS2345: argument of type widget is not assignable" }], isError: true, timestamp: 1 } }],
			modified: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "tool-call",
			chat: "Looking.",
			entries: [{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "quasarFlux", path: "src/nebula" } }], timestamp: 1 } }],
			modified: "2026-01-01T00:00:00.000Z",
		},
	]);
	try {
		const result = await f.query("widget assignable TS2345");
		assert.deepEqual(hitIds(result), ["tool-result"], body(result));
		assert.match(result.details.transcripts.results[0]?.snippets.join(" ") ?? "", /TS2345/u);

		const call = await f.query("quasarFlux nebula");
		assert.deepEqual(hitIds(call), ["tool-call"], body(call));
	} finally { f.cleanup(); }
});

test("REQ-199-2: a single word found only in tool output is found too", async () => {
	const f = makeFixture([{
		id: "sha",
		chat: "Committed.",
		entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "[main 9f3c2ab7] feat: thing" }], isError: false, timestamp: 1 } }],
		modified: "2026-01-02T00:00:00.000Z",
	}]);
	try {
		assert.deepEqual(hitIds(await f.query("9f3c2ab")), ["sha"]);
	} finally { f.cleanup(); }
});

test("REQ-199-2: words found only in a fold summary, a side-file summary or a compaction summary find that session", async () => {
	const f = makeFixture([
		{
			id: "native-fold",
			chat: "Start.",
			entries: [{ type: "context_edit", id: "e1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", targetId: "u1", replacement: { content: "[fold b3] decided to shard the zephyr ledger by tenant" } }],
			modified: "2026-01-03T00:00:00.000Z",
		},
		{
			id: "side-file",
			chat: "Start.",
			sideFile: { schemaVersion: 1, blocks: [{ blockId: "b2", topic: "Ledger", summary: "chose to archive the obsidian queue nightly" }] },
			modified: "2026-01-02T00:00:00.000Z",
		},
		{
			id: "compaction",
			chat: "Start.",
			entries: [{ type: "compaction", id: "k1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", summary: "Goal: migrate the cobalt importer to streaming.", firstKeptEntryId: "u1", tokensBefore: 100 }],
			modified: "2026-01-01T00:00:00.000Z",
		},
	]);
	try {
		assert.deepEqual(hitIds(await f.query("zephyr ledger shard")), ["native-fold"]);
		assert.deepEqual(hitIds(await f.query("obsidian queue archive")), ["side-file"]);
		assert.deepEqual(hitIds(await f.query("cobalt importer streaming")), ["compaction"]);
	} finally { f.cleanup(); }
});

test("REQ-199-2: tool-result text is capped per result, so words past the cap are not searched", async () => {
	const f = makeFixture([{
		id: "long",
		chat: "Ran it.",
		entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `early-marker ${"x".repeat(TOOL_RESULT_CHARACTERS)} late-marker` }], isError: false, timestamp: 1 } }],
		modified: "2026-01-02T00:00:00.000Z",
	}]);
	try {
		assert.deepEqual(hitIds(await f.query("early-marker")), ["long"]);
		assert.deepEqual(hitIds(await f.query("late-marker")), []);
	} finally { f.cleanup(); }
});

test("REQ-199-2: a credential in tool output is redacted in the snippet", async () => {
	const credential = ["glpat", "12345678901234567890abcd"].join("-");
	const f = makeFixture([{
		id: "secret",
		chat: "Deployed.",
		entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: `deploy finished token=${credential} region eu` }], isError: false, timestamp: 1 } }],
		modified: "2026-01-02T00:00:00.000Z",
	}]);
	try {
		const result = await f.query("deploy finished region");
		assert.deepEqual(hitIds(result), ["secret"]);
		assert.ok(!body(result).includes(credential), body(result));
		assert.match(body(result), /\[REDACTED\]/u);
	} finally { f.cleanup(); }
});

test("REQ-199-2: output of a !! command the user hid from the model is not searched", async () => {
	const f = makeFixture([{
		id: "hidden",
		chat: "Checked the account.",
		entries: [
			{ type: "message", id: "b1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "bashExecution", command: "cat creds-zircon.txt", output: "zircon vault account owner", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 } },
		],
		modified: "2026-01-02T00:00:00.000Z",
	}, {
		id: "shown",
		chat: "Checked the build.",
		entries: [
			{ type: "message", id: "b2", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "bashExecution", command: "make basalt", output: "basalt build finished", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } },
		],
		modified: "2026-01-01T00:00:00.000Z",
	}]);
	try {
		const hidden = await f.query("zircon vault");
		assert.deepEqual(hitIds(hidden), [], body(hidden));
		assert.ok(!body(hidden).includes("zircon vault"), body(hidden));
		assert.deepEqual(hitIds(await f.query("creds-zircon")), []);
		// A !-command the model did see is still searched.
		assert.deepEqual(hitIds(await f.query("basalt build")), ["shown"]);
	} finally { f.cleanup(); }
});

test("REQ-199-2: credentials in tool-call arguments and shell output are redacted in the snippet", async () => {
	const password = ["hunter2", "hunter2"].join("");
	const awsSecret = ["wJalrXUtnFEMI", "K7MDENGbPxRfiCYEXAMPLEKEY"].join("/");
	const dbPassword = ["p4ss", "w0rd9"].join("");
	const curlPassword = ["S3cret", "Pw77"].join("");
	const f = makeFixture([{
		id: "secrets",
		chat: "Set up the ledger.",
		entries: [
			{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "login", arguments: { user: "ledger-admin", password } }], timestamp: 1 } },
			{ type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: `ledger env AWS_SECRET_ACCESS_KEY=${awsSecret}\nDATABASE_URL=postgres://ledger:${dbPassword}@db.internal/ledger` }], isError: false, timestamp: 2 } },
			{ type: "message", id: "b1", parentId: "t1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "bashExecution", command: `curl -u ledger-admin:${curlPassword} https://ledger.internal`, output: "ledger ok", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 } },
		],
		modified: "2026-01-02T00:00:00.000Z",
	}]);
	try {
		for (const query of ["ledger-admin", "ledger env", "postgres", "curl"]) {
			const result = await f.query(query);
			assert.deepEqual(hitIds(result), ["secrets"], `${query}: ${body(result)}`);
			const text = body(result);
			for (const secret of [password, awsSecret, dbPassword, curlPassword]) {
				assert.ok(!text.includes(secret), `${query} leaked ${secret}: ${text}`);
			}
		}
	} finally { f.cleanup(); }
});

test("REQ-199-3: a single-token query still matches as a literal substring", async () => {
	const f = makeFixture([
		{ id: "ref", chat: "Closed acme/context-aware#1987 yesterday.", modified: "2026-01-02T00:00:00.000Z" },
		{ id: "path", chat: "Edited src/cache/recall.ts:76 today.", modified: "2026-01-01T00:00:00.000Z" },
	]);
	try {
		const ref = await f.query("context-aware#198");
		assert.equal(ref.details.transcripts.matching, "literal");
		assert.deepEqual(hitIds(ref), ["ref"], "a substring of a longer token matches");
		assert.deepEqual(hitIds(await f.query("recall.ts:76")), ["path"]);
		assert.deepEqual(hitIds(await f.query("recall.ts:77")), []);
	} finally { f.cleanup(); }
});

test("REQ-199-3: regex queries search chat text only, as before", async () => {
	const f = makeFixture([{
		id: "mixed",
		chat: "chat says alpha-42",
		entries: [{ type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "tool says beta-77" }], isError: false, timestamp: 1 } }],
		modified: "2026-01-02T00:00:00.000Z",
	}]);
	try {
		const chat = await f.query("alpha-\\d+", { regex: true });
		assert.deepEqual(hitIds(chat), ["mixed"]);
		assert.equal(chat.details.transcripts.matching, "regex");
		assert.deepEqual(hitIds(await f.query("beta-\\d+", { regex: true })), []);
		assert.deepEqual(hitIds(await f.query("alpha 42 beta 77", { regex: true })), []);
	} finally { f.cleanup(); }
});

test("REQ-199-1: case_sensitive applies to every word", () => {
	const sensitive = planQuery("Fold Planner", false, true);
	assert.equal(matchText(sensitive, "the fold planner", 3, 50), undefined);
	assert.equal(matchText(sensitive, "the Planner of each Fold", 3, 50)?.kind, "terms");
	const insensitive = planQuery("Fold Planner", false, false);
	assert.equal(matchText(insensitive, "the fold planner", 3, 50)?.kind, "phrase");
});

test("REQ-199-1: a query of stop words only falls back to the literal phrase", () => {
	const plan = planQuery("what was it", false, false);
	assert.equal(plan.kind, "literal");
	assert.equal(matchText(plan, "so what was it then", 3, 50)?.kind, "literal");
	assert.equal(matchText(plan, "it was what", 3, 50), undefined);
});

test("REQ-199-1: the snippet covers the tightest window, not the first occurrence", () => {
	const plan = planQuery("fold planner", false, false);
	const text = `fold ${"a ".repeat(500)} the planner moved; later the fold-engine planner was rewritten`;
	const match = matchText(plan, text, 3, 60);
	assert.equal(match?.kind, "terms");
	assert.ok((match?.span ?? Infinity) < 30, `span ${match?.span}`);
	assert.match(match?.snippets[0] ?? "", /fold-engine planner/u);
});
