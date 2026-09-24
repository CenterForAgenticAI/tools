import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDelegationProgressFields } from "../.test-dist/session-tasks-contract.js";

/**
 * Guards the seam between this package and pi-delegate.
 *
 * The two packages deliberately never import each other: each restates the
 * other's wire shape and parses it loosely. The cost of that independence is
 * that both test suites can be green while the feature does nothing, because
 * each side is only ever checked against its own restatement. No CI job in
 * either repository can catch a disagreement, since neither can see the other.
 *
 * That is not hypothetical. It already happened: pi-delegate sent a blocked
 * task's explanation as `reason`, this package read only `note`, and every
 * blocked explanation was silently discarded. Both suites stayed green.
 *
 * `tests/fixtures/pi-delegate-task-progress.v1.json` is therefore not
 * hand-written. It is current output from pi-delegate's own
 * `taskProgressFieldsFromEntries`, captured from a seeded worker session, so
 * these assertions run against bytes the producer actually emits. The sibling
 * `*.legacy-v1.json` recording remains fixed to prove additive version-1 parsing.
 *
 * When pi-delegate changes the shape, re-record rather than editing by hand:
 *
 *   node -e 'const d=await import("<pi-delegate>/dist/task-seam.js"); ...'
 *
 * A stale fixture fails loudly here, which is the entire point — the failure
 * mode it replaces was silent.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const recorded = JSON.parse(
	fs.readFileSync(path.join(fixtureDir, "pi-delegate-task-progress.v1.json"), "utf8"),
);
const legacyRecorded = JSON.parse(
	fs.readFileSync(path.join(fixtureDir, "pi-delegate-task-progress.legacy-v1.json"), "utf8"),
);
/** A dispatch that threaded this session's own task ids. */
const emitted = recorded.ownerAddressed;
const legacyEmitted = legacyRecorded.ownerAddressed;
/**
 * A dispatch written the way a caller actually writes one --
 * `handoff: { tasks: [{ title }] }`, with no owner ids at all. pi-delegate
 * then addresses its rows by its OWN numbering. Every earlier test supplied an
 * owner id explicitly, so none of them exercised this, and for a while it
 * emitted no rows whatsoever.
 */
const workerAddressed = recorded.workerAddressed;

test("the real legacy version-1 payload remains ref-free and parses at all", () => {
	const parsed = parseDelegationProgressFields(legacyEmitted);
	assert.notEqual(parsed, undefined, "pi-delegate's legacy output was rejected outright");
	assert.deepEqual(parsed?.rows.map((row) => row.ref), [undefined, undefined, undefined]);
	assert.equal(parsed?.rows.every((row) => row.title === undefined && row.subtasks === undefined), true);
});

test("the current producer carries real titles, nested detail, ids, statuses, and reasons", () => {
	const parsed = parseDelegationProgressFields(emitted);
	assert.deepEqual(parsed?.rows, [
		{ ownerTaskId: "t1", idKind: "owner", title: "Write the parser", status: "done" },
		{
			ownerTaskId: "t2",
			idKind: "owner",
			title: "Wire the runner",
			status: "active",
			subtasks: [{
				localTaskId: "t2.1",
				idKind: "local",
				title: "Write a failing test",
				status: "done",
			}],
		},
		{
			ownerTaskId: "t3",
			idKind: "owner",
			title: "Ship the docs",
			status: "blocked",
			note: "waiting on review",
		},
	]);
});

test("a synthetic ref-aware extension preserves refs without changing row identity", () => {
	const refAware = structuredClone(emitted);
	for (const row of refAware.tasks.rows) row.ref = `external-${row.ownerTaskId}`;
	const parsed = parseDelegationProgressFields(refAware);
	assert.deepEqual(parsed?.rows.map((row) => [row.ref, row.ownerTaskId, row.localTaskId, row.idKind]), [
		["external-t1", "t1", undefined, "owner"],
		["external-t2", "t2", undefined, "owner"],
		["external-t3", "t3", undefined, "owner"],
	]);
	assert.deepEqual(parsed?.counts, {
		done: 1,
		total: 3,
		active: "Wire the runner",
		blocked: 1,
		outcome: "stuck",
	});
});

test("every owner task id and status crosses the seam exactly", () => {
	const parsed = parseDelegationProgressFields(emitted);
	assert.deepEqual(
		parsed?.rows.map((row) => [row.ownerTaskId, row.status]),
		[["t1", "done"], ["t2", "active"], ["t3", "blocked"]],
		"the parsed rows are not the rows pi-delegate emitted",
	);
});

test("a blocked row keeps its written explanation", () => {
	// The regression this file exists for. pi-delegate spells it `reason`;
	// this model calls it `note`. Reading only `note` dropped it in silence.
	const parsed = parseDelegationProgressFields(emitted);
	const blocked = parsed?.rows.find((row) => row.status === "blocked");
	assert.equal(
		blocked?.note,
		"waiting on review",
		"a blocked task reached the owner with no reason, which is the one thing blocked must carry",
	);
});

test("the aggregate counts cross the seam", () => {
	const parsed = parseDelegationProgressFields(emitted);
	assert.deepEqual(parsed?.counts, {
		done: 1,
		total: 3,
		active: "Wire the runner",
		blocked: 1,
		outcome: "stuck",
	});
});

test("a worker-addressed dispatch still yields identifiable rows", () => {
	const parsed = parseDelegationProgressFields(workerAddressed);
	assert.notEqual(parsed, undefined, "the natural calling shape produced nothing at all");
	assert.deepEqual(
		parsed?.rows.map((row) => [row.idKind, row.localTaskId, row.title, row.status]),
		[
			["local", "t1", "Write the parser", "done"],
			["local", "t2", "Wire the runner", "active"],
			["local", "t3", "Ship the docs", "blocked"],
		],
		"rows addressed by the worker's own numbering were dropped or lost their ids",
	);
	assert.deepEqual(parsed?.rows[1]?.subtasks, [{
		localTaskId: "t2.1",
		idKind: "local",
		title: "Write a failing test",
		status: "done",
	}]);
});

test("a worker-addressed blocked row still carries its reason", () => {
	const parsed = parseDelegationProgressFields(workerAddressed);
	const blocked = parsed?.rows.find((row) => row.status === "blocked");
	assert.equal(blocked?.note, "waiting on review");
	assert.equal(blocked?.localTaskId, "t3", "a reason with no id cannot be attributed to a task");
});

test("worker-addressed rows are never mistaken for this session's ids", () => {
	// Reconciling `t3` from the worker's list against `t3` in this session's
	// list would silently update an unrelated task.
	const parsed = parseDelegationProgressFields(workerAddressed);
	for (const row of parsed?.rows ?? []) {
		assert.equal(row.ownerTaskId, undefined, "a worker id leaked into the owner-id field");
		assert.equal(row.idKind, "local");
	}
});

test("the fixture still carries the wire spelling it was recorded for", () => {
	// If pi-delegate renames the field, this fails and names the cause, instead
	// of the parse quietly returning a row with no explanation.
	const blockedRow = emitted.tasks.rows.find((row) => row.status === "blocked");
	assert.equal(
		blockedRow.reason,
		"waiting on review",
		"the recording no longer matches what this test asserts; re-record it from pi-delegate",
	);
});
