import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recallQuery, type ContextRecallHost, type ContextRecallResult, type TranscriptSession } from "../src/context-tools/context-recall.js";
import { PI_MEMORY_MAX_CWD_CHARS, PI_MEMORY_SEARCH_EVENT } from "../src/context-tools/pi-memory-search.js";

// Seam: recallQuery with a host whose event bus is a fake pi-memory responder that answers
// zero cards, and whose session listing points at a real session JSONL file, so a fallback is
// seen to search that file. `piMemoryRequestFields` leaves cwd out when it is empty or longer
// than PI_MEMORY_MAX_CWD_CHARS; for scope "prior" the store then has no asking repo and replies
// with zero cards (pi-memory's `unsearchable`), which is not an answer about this project.

interface StoreRequest {
	readonly [field: string]: unknown;
	ack(): void;
	reply(result: unknown): void;
}

interface Fixture {
	readonly requests: StoreRequest[];
	query(params: Record<string, unknown>): Promise<ContextRecallResult>;
	cleanup(): void;
}

const NO_MATCH_TEXT = /No matching sessions in the pi-memory session store/u;

/** cwd: the working directory the tool call reports; the session file itself lives in a real project dir. */
function makeFixture(cwd: (projectDir: string) => string): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-no-cwd-")));
	const projectDir = path.join(root, "work", "proj");
	fs.mkdirSync(projectDir, { recursive: true });
	const sessionsDir = path.join(root, "sessions");
	fs.mkdirSync(sessionsDir);
	const modified = "2026-01-02T00:00:00.000Z";
	const chat = "MARKER-NOCWD lives in an earlier session file.";
	const file = path.join(sessionsDir, "file-prior.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "file-prior", timestamp: modified, cwd: projectDir },
		{ type: "message", id: "u1", parentId: null, timestamp: modified, message: { role: "user", content: chat, timestamp: 0 } },
	];
	fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const listed: TranscriptSession[] = [{ id: "file-prior", path: file, cwd: projectDir, modified: new Date(modified), messageCount: 1, allMessagesText: chat }];
	const requests: StoreRequest[] = [];
	const host: ContextRecallHost = {
		listSessions: async () => ({ sessions: listed, scannedCwds: [projectDir], scopeLabel: "project" }),
		erasedSessionIds: () => new Set<string>(),
		cachePools: () => [],
		home: () => root,
		searchEvents: {
			emit(channel: string, data: unknown) {
				if (channel !== PI_MEMORY_SEARCH_EVENT) return;
				const request = data as StoreRequest;
				requests.push(request);
				// pi-memory acks during emit and replies on a later turn; with no asking repo a prior search finds nothing.
				request.ack();
				setTimeout(() => request.reply({ ok: true, cards: [], tookMs: 4 }), 5);
			},
		},
	};
	const ctx = {
		cwd: cwd(projectDir),
		sessionManager: {
			getSessionFile: () => path.join(sessionsDir, "current.jsonl"),
			getSessionId: () => "current-session",
			getEntries: () => [],
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	return {
		requests,
		query: (params) => recallQuery({ query: "MARKER-NOCWD", ...params }, ctx, host),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

const body = (result: ContextRecallResult): string => result.content.map((part) => part.text).join("\n");
const fileHits = (result: ContextRecallResult): string[] => result.details.transcripts.results.map((hit) => path.basename(hit.sessionPath, ".jsonl"));
/** The first line under the transcripts heading: where the result says where its hits came from. */
const firstTranscriptLine = (result: ContextRecallResult): string => body(result).split("\n").find((line) => line.trim() !== "" && !line.startsWith("## ")) ?? "";

/** A cwd longer than pi-memory's bound, so it is left out of the request, never cut. */
const overLongCwd = (projectDir: string): string => `${projectDir}/${"d".repeat(PI_MEMORY_MAX_CWD_CHARS + 10)}`;

function assertFileFallbackForMissingCwd(result: ContextRecallResult): void {
	const text = body(result);
	assert.deepEqual(fileHits(result), ["file-prior"], text);
	assert.doesNotMatch(text, NO_MATCH_TEXT);
	assert.doesNotMatch(text, /From the pi-memory session store/u);
	const first = firstTranscriptLine(result);
	assert.match(first, /searched session files instead\./u, text);
	assert.match(first, /\b(cwd|working directory)\b/iu, `the first line must say the working directory was not sent: ${first}`);
	const memory = result.details.pi_memory;
	assert.ok(memory !== undefined, "details.pi_memory must say why the session files were searched");
	assert.notEqual(memory.status, "answered", "details.pi_memory must not claim the store answered for this project");
}

test("S1: prior scope with a cwd over the request bound falls back to the session files when the store answers zero cards", async () => {
	const f = makeFixture(overLongCwd);
	try {
		const result = await f.query({ scope: "prior" });
		for (const request of f.requests) assert.equal(request.cwd, undefined, "an over-long cwd is left out, never cut");
		assertFileFallbackForMissingCwd(result);
	} finally { f.cleanup(); }
});

test("S2: prior scope with an empty cwd searches the session files instead of reporting an empty store answer", async () => {
	const f = makeFixture(() => "");
	try {
		const result = await f.query({ scope: "prior" });
		assertFileFallbackForMissingCwd(result);
	} finally { f.cleanup(); }
});

test("prior scope with a cwd that was sent keeps a zero-card store answer and searches no session file", async () => {
	const f = makeFixture((projectDir) => projectDir);
	try {
		const result = await f.query({ scope: "prior" });
		assert.equal(f.requests.length, 1);
		assert.equal(typeof f.requests[0]?.cwd, "string");
		const text = body(result);
		assert.match(text, NO_MATCH_TEXT);
		assert.deepEqual(fileHits(result), [], text);
		assert.doesNotMatch(text, /searched session files instead/u);
		assert.equal(result.details.pi_memory?.status, "answered");
	} finally { f.cleanup(); }
});

test("all-projects scope with no cwd sent keeps the store answer, since it needs no asking repo", async () => {
	const f = makeFixture(overLongCwd);
	try {
		const result = await f.query({ scope: "all-projects" });
		assert.equal(f.requests.length, 1);
		assert.equal(f.requests[0]?.cwd, undefined);
		const text = body(result);
		assert.match(text, NO_MATCH_TEXT);
		assert.deepEqual(fileHits(result), [], text);
		assert.doesNotMatch(text, /searched session files instead/u);
		assert.equal(result.details.pi_memory?.status, "answered");
	} finally { f.cleanup(); }
});
