import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { recallQuery, type ContextRecallHost, type ContextRecallResult } from "../src/context-tools/context-recall.js";
import { PI_MEMORY_SEARCH_EVENT, type PiMemoryCard } from "../src/context-tools/pi-memory-search.js";

// Seam: recallQuery with a host whose event bus is a fake pi-memory responder. The request
// it records is what the store receives; its fields follow pi-memory's `SearchRequest` in
// its src/contract.ts (caair/pi/pi-memory!57), which accepts `scope: "prior" | "all-projects"`.
// The responder acks during emit and replies on a later turn, as pi-memory does.

interface StoreRequest {
	readonly [field: string]: unknown;
	ack(): void;
	reply(result: unknown): void;
}

interface Fixture {
	readonly projectDir: string;
	readonly requests: StoreRequest[];
	query(params: Record<string, unknown>): Promise<ContextRecallResult>;
	cleanup(): void;
}

function makeFixture(cards: readonly PiMemoryCard[]): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-recall-scope-")));
	const projectDir = path.join(root, "work", "proj");
	fs.mkdirSync(projectDir, { recursive: true });
	const requests: StoreRequest[] = [];
	const host: ContextRecallHost = {
		listSessions: async () => ({ sessions: [], scannedCwds: [projectDir], scopeLabel: "project" }),
		erasedSessionIds: () => new Set<string>(),
		cachePools: () => [],
		home: () => root,
		searchEvents: {
			emit(channel: string, data: unknown) {
				if (channel !== PI_MEMORY_SEARCH_EVENT) return;
				const request = data as StoreRequest;
				requests.push(request);
				// A store that ignores `scope`: it answers with the same cards whatever the request asks.
				request.ack();
				setTimeout(() => request.reply({ ok: true, cards, tookMs: 7 }), 5);
			},
		},
	};
	const ctx = {
		cwd: projectDir,
		sessionManager: {
			getSessionFile: () => path.join(root, "current.jsonl"),
			getSessionId: () => "current-session",
			getEntries: () => [],
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	return {
		projectDir,
		requests,
		query: (params) => recallQuery({ query: "MARKER-SCOPE", ...params }, ctx, host),
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

function card(sessionId: string, repo: string): PiMemoryCard {
	return { sessionId, repo, startedAt: "2026-01-01T10:00:00.000Z", score: 2, entryId: "e-1", snippet: "MARKER-SCOPE from the store" };
}

const body = (result: ContextRecallResult): string => result.content.map((part) => part.text).join("\n");

test("S1: a default prior search sends scope prior to the store together with the asking cwd", async () => {
	const f = makeFixture([card("mine", "proj")]);
	try {
		await f.query({});
		assert.equal(f.requests.length, 1);
		const request = f.requests[0];
		assert.equal(request?.scope, "prior");
		assert.equal(request?.cwd, f.projectDir, "the store derives the asking repo from cwd, so cwd must still be sent");
		assert.equal(request?.query, "MARKER-SCOPE");

		const explicit = makeFixture([card("mine", "proj")]);
		try {
			await explicit.query({ scope: "prior" });
			assert.equal(explicit.requests[0]?.scope, "prior");
			assert.equal(explicit.requests[0]?.cwd, explicit.projectDir);
		} finally { explicit.cleanup(); }
	} finally { f.cleanup(); }
});

test("S2: an all-projects search sends scope all-projects to the store", async () => {
	const f = makeFixture([card("theirs", "other-repo")]);
	try {
		await f.query({ scope: "all-projects" });
		assert.equal(f.requests.length, 1);
		assert.equal(f.requests[0]?.scope, "all-projects");
		assert.equal(f.requests[0]?.cwd, f.projectDir);
	} finally { f.cleanup(); }
});

test("against a store that ignores scope, prior still leaves out other projects' cards and reports how many", async () => {
	const f = makeFixture([card("mine", "proj"), card("theirs", "other-repo"), card("theirs-2", "third-repo")]);
	try {
		const prior = await f.query({});
		assert.ok(prior.details.pi_memory?.status === "answered", body(prior));
		assert.equal(prior.details.pi_memory.returned, 3);
		assert.equal(prior.details.pi_memory.other_projects_left_out, 2);
		assert.deepEqual(prior.details.pi_memory.cards.map((kept) => kept.session_id), ["mine"]);
		assert.match(body(prior), /### Session mine\n/u);
		assert.doesNotMatch(body(prior), /theirs/u);
		assert.match(body(prior), /2 from other projects left out/u);

		const all = await f.query({ scope: "all-projects" });
		assert.ok(all.details.pi_memory?.status === "answered", body(all));
		assert.equal(all.details.pi_memory.other_projects_left_out, 0);
		assert.deepEqual(all.details.pi_memory.cards.map((kept) => kept.session_id), ["mine", "theirs", "theirs-2"]);
	} finally { f.cleanup(); }
});
