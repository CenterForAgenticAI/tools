/**
 * Old and new session files keep their focus in this package after the session
 * record moved to pi-workstream. Both fixtures are real recorded output; see
 * tests/fixtures/real-sessions/README.md.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { replayWorkstreamEntries } from "../src/snapshot-contracts/transcript.js";

function sessionEntries(name: string): unknown[] {
	const file = path.resolve("tests/fixtures/real-sessions", name);
	return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown);
}

test("a session recorded by pi-context-aware 0.8.0 keeps its focus", () => {
	const entries = sessionEntries("context-aware-0.8.0.jsonl");
	const replay = replayWorkstreamEntries(entries);
	assert.equal(replay.authority, "transcript");
	assert.equal(replay.chainValid, true);
	assert.equal(replay.snapshot?.workstreamId, "ws-01a1cd75-1cdb-72ae-9627-d5586ce3b98d");
	assert.equal(replay.snapshot?.objective, "Release the CSV importer without losing the rollback plan");
	assert.equal(replay.snapshot?.status, "active");
	assert.equal(replay.candidates.length, 1, "only the one focus entry is focus");
});

test("the old session's task, brief and ask entries are not read as focus", () => {
	const entries = sessionEntries("context-aware-0.8.0.jsonl");
	const others = entries.filter((entry) => {
		const type = (entry as { customType?: unknown }).customType;
		return typeof type === "string" && type !== "context-aware.workstream.v1";
	});
	assert.ok(others.some((entry) => (entry as { customType: string }).customType === "context-aware.tasks.v1"), "the fixture holds task entries");
	assert.equal(replayWorkstreamEntries(others).authority, null);
});

test("focus entries written by pi-workstream replay with its purpose, goal reason and reference kinds", () => {
	const replay = replayWorkstreamEntries(sessionEntries("pi-workstream-focus.jsonl"));
	assert.equal(replay.authority, "transcript");
	assert.equal(replay.chainValid, true);
	assert.equal(replay.rejected, 0);
	assert.equal(replay.snapshot?.revision, 2);
	assert.equal(replay.snapshot?.purpose, "So pi-context-aware stops owning tasks");
	assert.equal(replay.snapshot?.goalReason, "The operator asked for one owner");
	assert.deepEqual(replay.snapshot?.refs, [
		{ kind: "issue", value: "caair/pi/pi-context-aware#303" },
		{ kind: "change", value: "caair/pi/pi-context-aware!387" },
	]);
	assert.equal(replay.mutation?.kind, "purpose");
});

type Entry = Record<string, unknown> & { data: Record<string, unknown> & { snapshot?: Record<string, unknown>; mutation?: Record<string, unknown> } };

/** The snapshot an entry carries: pi-workstream writes a first revision bare, later ones wrapped. */
function snapshotOf(entry: Entry): Record<string, unknown> {
	return entry.data.snapshot ?? entry.data;
}

function focusEntries(name: string): Entry[] {
	return sessionEntries(name).filter((entry) => {
		const type = (entry as { customType?: unknown }).customType;
		return type === "context-aware.workstream.v1" || type === "pi-workstream.workstream.v1";
	}) as Entry[];
}

/** A copy of a recorded entry, wrapped, with its snapshot fields and transcript timestamp replaced. */
function restamped(entry: Entry, snapshot: Record<string, unknown>, timestamp: string, outer: Record<string, unknown> = {}): Entry {
	const outerFields = entry.data.snapshot === undefined ? {} : entry.data;
	const data: Entry["data"] = { ...outerFields, ...outer, snapshot: { ...snapshotOf(entry), ...snapshot } };
	if (entry.data.mutation !== undefined) data.mutation = { ...entry.data.mutation, workstreamId: data.snapshot?.workstreamId };
	return { ...entry, data, timestamp };
}

test("an old focus continued under pi-workstream chains across the two entry types", () => {
	const [old] = focusEntries("context-aware-0.8.0.jsonl");
	const [, revisionTwo] = focusEntries("pi-workstream-focus.jsonl");
	assert.ok(old && revisionTwo);
	// pi-workstream's revision 2 continues the 0.8.0 session's revision 1 of the same workstream.
	const continued = restamped(revisionTwo, {
		workstreamId: snapshotOf(old).workstreamId,
		piSessionId: snapshotOf(old).piSessionId,
		createdAt: "2026-11-16T00:00:00.000Z",
		updatedAt: "2026-11-16T00:00:00.000Z",
	}, "2026-11-16T00:00:00.000Z", { previousEventId: snapshotOf(old).eventId });
	const replay = replayWorkstreamEntries([old, continued]);
	assert.equal(replay.chainValid, true);
	assert.equal(replay.snapshot?.workstreamId, "ws-01a1cd75-1cdb-72ae-9627-d5586ce3b98d");
	assert.equal(replay.snapshot?.revision, 2, "the new-type revision follows the old-type root");
	assert.equal(replay.snapshot?.objective, "Move the session record into pi-workstream");
});

test("old and new focus entries with the same snapshot time are picked by transcript order", () => {
	const [old] = focusEntries("context-aware-0.8.0.jsonl");
	const [newer] = focusEntries("pi-workstream-focus.jsonl");
	assert.ok(old && newer);
	const time = { createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z" };
	const pick = (oldAt: string, newAt: string) => replayWorkstreamEntries([
		restamped(old, time, oldAt),
		restamped(newer, time, newAt),
	]).snapshot?.workstreamId;
	assert.equal(pick("2026-11-16T00:00:01.000Z", "2026-11-16T00:00:02.000Z"), "ws-pws-capture", "the new-type entry is later");
	assert.equal(pick("2026-11-16T00:00:02.000Z", "2026-11-16T00:00:01.000Z"), "ws-01a1cd75-1cdb-72ae-9627-d5586ce3b98d", "the old-type entry is later");
});
