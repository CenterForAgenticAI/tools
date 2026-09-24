import test from "node:test";
import assert from "node:assert/strict";
import {
	TASKS_PROGRESS_CONTRACT_VERSION,
	TASKS_SEED_CONTRACT_VERSION,
	buildTasksProgressEvent,
	buildTasksSeed,
	classifyOutcome,
	parseDelegationProgressFields,
	parseTasksProgressEvent,
	parseTasksSeed,
	renderSeedAsMarkdown,
} from "../session-tasks-contract.js";
import { parseTasksMarkdown } from "../session-tasks-view.js";
import {
	MAX_SUBTASKS,
	planTasks,
	parseTasksSnapshot,
	createTasksSnapshot,
	type NewTask,
	type Task,
} from "../session-tasks.js";

// The contract ships before real use has stress-tested it, so these tests are
// mostly about what happens when the other side is wrong: newer fields, unknown
// statuses, malformed entries, and a host with no context-aware at all.

function tasks(plan: readonly NewTask[]): Task[] {
	const result = planTasks(plan, "agent");
	assert.equal(result.ok, true);
	return (result as { ok: true; value: Task[] }).value;
}

// --- the seed ---------------------------------------------------------------

test("a well-formed seed parses to the minimal shape", () => {
	const seed = parseTasksSeed({
		schemaVersion: 1,
		origin: "spec",
		tasks: [
			{ title: "read the spec" },
			{ title: "implement it", status: "active", subtasks: [{ title: "types first" }] },
		],
	});
	assert.equal(seed?.tasks.length, 2);
	assert.equal(seed?.origin, "spec");
	assert.equal(seed?.tasks[1]?.status, "active");
	assert.equal(seed?.tasks[1]?.subtasks?.[0]?.title, "types first");
});

test("unknown and newer fields are ignored rather than rejected", () => {
	// This is the property that lets an older context-aware talk to a newer
	// pi-delegate without either importing the other.
	const seed = parseTasksSeed({
		schemaVersion: 1,
		unknownTopLevel: { anything: true },
		tasks: [{ title: "still works", owner: "someone", estimate: "2d", priority: 3 }],
	});
	assert.equal(seed?.tasks.length, 1);
	assert.equal(seed?.tasks[0]?.title, "still works");
	assert.deepEqual(Object.keys(seed?.tasks[0] ?? {}), ["title"]);
});

test("REQ-TASKDEL-013 old and new peers parse snapshots in both directions", () => {
	const oldSnapshot = createTasksSnapshot({
		piSessionId: "owner",
		tasks: tasks([{ title: "old task" }]),
		eventId: "old",
		now: "2026-05-06T00:00:00.000Z",
	});
	assert.deepEqual(parseTasksSnapshot(JSON.parse(JSON.stringify(oldSnapshot))), oldSnapshot);
	const newer = {
		...oldSnapshot,
		tasks: [{ ...oldSnapshot.tasks[0], delegation: { sessionId: "worker" }, lastAttempt: { runId: "run-1", endState: "cancelled" } }],
		newerField: "ignored by an older peer",
	};
	const parsed = parseTasksSnapshot(JSON.parse(JSON.stringify(newer)));
	assert.equal(parsed?.tasks[0]?.delegation?.sessionId, "worker");
	const peerView = JSON.parse(JSON.stringify(newer, (key, value) => key === "delegation" || key === "lastAttempt" || key === "newerField" ? undefined : value));
	assert.deepEqual(parseTasksSnapshot(peerView)?.tasks[0], oldSnapshot.tasks[0]);
});

test("a newer major version is ignored rather than guessed at", () => {
	assert.equal(parseTasksSeed({ schemaVersion: 2, tasks: [{ title: "from the future" }] }), undefined);
	assert.equal(parseTasksSeed({ tasks: [{ title: "unversioned" }] }), undefined);
});

test("one malformed task cannot discard the rest of a dispatched plan", () => {
	const seed = parseTasksSeed({
		schemaVersion: 1,
		tasks: [{ title: "good one" }, { notATask: true }, { title: "" }, { title: "another good one" }],
	});
	assert.deepEqual(seed?.tasks.map((t) => t.title), ["good one", "another good one"]);
});

test("a seed with nothing usable in it yields nothing", () => {
	assert.equal(parseTasksSeed({ schemaVersion: 1, tasks: [] }), undefined);
	assert.equal(parseTasksSeed({ schemaVersion: 1, tasks: [{ title: "" }] }), undefined);
	assert.equal(parseTasksSeed(null), undefined);
	assert.equal(parseTasksSeed("tasks"), undefined);
});

test("an unrecognised status degrades to pending instead of losing the task", () => {
	const seed = parseTasksSeed({ schemaVersion: 1, tasks: [{ title: "keep me", status: "wontfix" }] });
	assert.equal(seed?.tasks[0]?.title, "keep me");
	assert.equal(seed?.tasks[0]?.status, undefined);
});

test("a status needing a reason, sent without one, is downgraded rather than refused", () => {
	// Otherwise the seed would be accepted here and then rejected by the local
	// schema on write, which is the worst of both.
	const seed = parseTasksSeed({ schemaVersion: 1, tasks: [{ title: "blocked but silent", status: "blocked" }] });
	assert.equal(seed?.tasks[0]?.status, undefined);
	const withReason = parseTasksSeed({ schemaVersion: 1, tasks: [{ title: "blocked with reason", status: "blocked", note: "waiting on review" }] });
	assert.equal(withReason?.tasks[0]?.status, "blocked");
});

test("REQ-TASKDEL-002 seeded snapshots can carry depth without parser context", () => {
	const seed = parseTasksSeed({
		schemaVersion: 1,
		tasks: [{ title: "parent", subtasks: [{ title: "child", subtasks: [{ title: "grandchild" }] }] }],
	});
	assert.equal(seed?.tasks[0]?.subtasks?.[0]?.title, "child");
	assert.equal(seed?.tasks[0]?.subtasks?.[0]?.subtasks?.[0]?.title, "grandchild");
});

test("a multi-line title is flattened rather than rejected", () => {
	const seed = parseTasksSeed({ schemaVersion: 1, tasks: [{ title: "first line\nsecond line" }] });
	assert.equal(seed?.tasks[0]?.title, "first line second line");
});

test("version-1 seeds preserve valid opaque refs and omit malformed optional refs", () => {
	const seed = parseTasksSeed({
		schemaVersion: 1,
		tasks: [
			{ title: "valid", ref: "provider-123", subtasks: [{ title: "nested", ref: "nested.ref" }] },
			{ title: "malformed", ref: "bad/ref" },
		],
	});
	assert.equal(seed?.tasks[0]?.ref, "provider-123");
	assert.equal(seed?.tasks[0]?.subtasks?.[0]?.ref, "nested.ref");
	assert.equal(seed?.tasks[1]?.ref, undefined);
	assert.equal(seed?.tasks.length, 2);
	assert.deepEqual(parseTasksSeed(JSON.parse(JSON.stringify(seed))), seed);
});

test("REQ-TASKDEL-006 buildTasksSeed carries the owner task id per seeded task", () => {
	const seed = buildTasksSeed(tasks([{ title: "one", ref: "same-ref" }, { title: "two", ref: "same-ref", subtasks: [{ title: "step", ref: "nested-ref" }] }]), "agent");
	assert.equal(seed.tasks[0]?.ownerTaskId, "t1");
	assert.equal(seed.tasks[0]?.ref, "same-ref");
	assert.equal(seed.tasks[1]?.ownerTaskId, "t2");
	assert.equal(seed.tasks[1]?.ref, "same-ref");
	assert.equal(seed.tasks[1]?.subtasks?.[0]?.ownerTaskId, "t2.1");
	assert.equal(seed.tasks[1]?.subtasks?.[0]?.ref, "nested-ref");
});

test("REQ-TASKDEL-013 a locally built seed parses back to itself", () => {
	const seed = buildTasksSeed(tasks([{ title: "one", status: "done" }, { title: "two", subtasks: [{ title: "step" }] }]), "agent");
	assert.equal(seed.schemaVersion, TASKS_SEED_CONTRACT_VERSION);
	const parsed = parseTasksSeed(JSON.parse(JSON.stringify(seed)));
	assert.deepEqual(parsed?.tasks.map((t) => t.title), ["one", "two"]);
	assert.equal(parsed?.tasks[1]?.subtasks?.[0]?.title, "step");
});

// --- the degradation path ---------------------------------------------------

test("REQ-TASKDEL-013 a seed degrades to a markdown checklist a worker can still read", () => {
	// This is what pi-delegate appends to the worker's task text when
	// context-aware is not installed. The plan survives; only its durability
	// does not.
	const seed = parseTasksSeed({
		schemaVersion: 1,
		tasks: [
			{ title: "read the spec", status: "done", ref: "read-ref" },
			{ title: "implement it", status: "active", ref: "implement-ref", subtasks: [{ title: "types first", ref: "types-ref" }] },
			{ title: "hold off", status: "deferred", note: "out of scope" },
		],
	});
	assert.ok(seed);
	const markdown = renderSeedAsMarkdown(seed);
	assert.equal(markdown, [
		"- [x] read the spec",
		"- [>] implement it",
		"  - [ ] types first",
		"- [~] hold off — out of scope",
	].join("\n"));
});

test("the degraded markdown reads back into the same plan", () => {
	// The round trip is what makes the degradation safe to rely on: a worker
	// that later gains context-aware loses nothing.
	const seed = parseTasksSeed({
		schemaVersion: 1,
		tasks: [{ title: "one", status: "done" }, { title: "two", subtasks: [{ title: "step" }] }],
	});
	assert.ok(seed);
	const reparsed = parseTasksMarkdown(renderSeedAsMarkdown(seed));
	assert.deepEqual(reparsed.map((t) => t.title), ["one", "two"]);
	assert.deepEqual(reparsed.map((t) => t.status), ["done", "pending"]);
	assert.equal(reparsed[1]?.subtasks?.[0]?.title, "step");
});

// --- upward progress --------------------------------------------------------

test("the progress event carries bounded counts, never task refs", () => {
	const event = buildTasksProgressEvent(
		tasks([{ title: "one", ref: "one-ref", status: "done" }, { title: "two", ref: "two-ref", status: "active" }, { title: "three" }]),
		{ lineagePath: "root-1/run-2#0", now: "2026-05-06T00:00:00.000Z" },
	);
	assert.equal("ref" in event, false);
	assert.equal("ref" in event.fields, false);
	assert.deepEqual(event, {
		kind: "task",
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		lineagePath: "root-1/run-2#0",
		ts: "2026-05-06T00:00:00.000Z",
		fields: { done: 1, total: 3, active: "two", blocked: 0 },
		outcome: "gap",
	});
});

test("the outcome is the done/gap/stuck verdict a supervisor can act on", () => {
	assert.equal(classifyOutcome(tasks([{ title: "a", status: "done" }, { title: "b", status: "deferred", note: "not needed" }])), "complete");
	assert.equal(classifyOutcome(tasks([{ title: "a", status: "done" }, { title: "b" }])), "gap");
	assert.equal(classifyOutcome(tasks([{ title: "a", status: "blocked", note: "waiting" }, { title: "b" }])), "stuck");
	// Stuck beats unfinished: something must escalate either way, and blocked
	// is the one that needs a human.
	assert.equal(classifyOutcome(tasks([{ title: "a", status: "blocked", note: "waiting" }, { title: "b", status: "done" }])), "stuck");
});

test("a progress event round-trips and rejects malformed input", () => {
	const event = buildTasksProgressEvent(tasks([{ title: "one" }]), { lineagePath: "r/1#0" });
	assert.deepEqual(parseTasksProgressEvent(JSON.parse(JSON.stringify(event))), event);
	assert.equal(parseTasksProgressEvent({ ...event, schemaVersion: 2 }), undefined, "newer version ignored");
	assert.equal(parseTasksProgressEvent({ ...event, kind: "other" }), undefined, "foreign event ignored");
	assert.equal(parseTasksProgressEvent({ ...event, fields: { ...event.fields, done: 5, total: 1 } }), undefined, "done cannot exceed total");
	assert.equal(parseTasksProgressEvent({ ...event, fields: { ...event.fields, blocked: -1 } }), undefined, "negative counts rejected");
	assert.equal(parseTasksProgressEvent({ ...event, ts: "not a date" }), undefined, "bad timestamp rejected");
});

test("delegation rows preserve refs independently of owner and local ids", () => {
	const parsed = parseDelegationProgressFields({
		done: 1,
		total: 1,
		blocked: 0,
		rows: [
			{ ref: "owner-ref", ownerTaskId: "t1", idKind: "owner", status: "done" },
			{ ref: "worker-ref", localTaskId: "t1", idKind: "local", status: "active" },
			{ ref: "ref-only" },
			{ ref: "bad/ref", title: "kept without ref" },
		],
	});
	assert.deepEqual(parsed?.rows.map((row) => [row.ref, row.ownerTaskId, row.localTaskId, row.idKind]), [
		["owner-ref", "t1", undefined, "owner"],
		["worker-ref", undefined, "t1", "local"],
		["ref-only", undefined, undefined, undefined],
		[undefined, undefined, undefined, undefined],
	]);
});

test("additive version-1 task detail preserves titles and one nested level", () => {
	const parsed = parseDelegationProgressFields({
		rows: [
			{
				localTaskId: "t1",
				idKind: "local",
				title: "parent\nrow",
				status: "active",
				subtasks: [
					{
						localTaskId: "t1.1",
						idKind: "local",
						title: "child",
						status: "done",
						subtasks: [{ localTaskId: "t1.1.1", idKind: "local", title: "too deep", status: "pending" }],
					},
					{ localTaskId: "t1.2", idKind: "local", title: "missing status" },
				],
			},
			{ ownerTaskId: "legacy", idKind: "owner", status: "pending" },
			{ ownerTaskId: "blank", idKind: "owner", title: "\n", status: "pending" },
		],
	});
	assert.deepEqual(parsed?.rows, [
		{
			localTaskId: "t1",
			idKind: "local",
			title: "parent row",
			status: "active",
			subtasks: [
				{ localTaskId: "t1.1", idKind: "local", title: "child", status: "done" },
				{ localTaskId: "t1.2", idKind: "local", title: "missing status" },
			],
		},
		{ ownerTaskId: "legacy", idKind: "owner", status: "pending" },
		{ ownerTaskId: "blank", idKind: "owner", status: "pending" },
	]);
});

test("bounds nested task detail without rejecting the parent row", () => {
	const parsed = parseDelegationProgressFields({
		rows: [{
			localTaskId: "t1",
			idKind: "local",
			title: "parent",
			status: "active",
			subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_value, index) => ({
				localTaskId: `t1.${index + 1}`,
				idKind: "local",
				title: `child ${index + 1}`,
				status: "pending",
			})),
		}],
	});
	assert.equal(parsed?.rows[0]?.subtasks?.length, MAX_SUBTASKS);
	assert.equal(parsed?.rows[0]?.subtasks?.at(-1)?.title, `child ${MAX_SUBTASKS}`);
});

test("a malformed optional ref is omitted without losing the row the peer supplied", () => {
	// The tolerant peer boundary omits the bad field and keeps the row. A row the
	// peer explicitly sent survives even when the only thing it carried was a ref
	// this version rejects, so a payload degrades instead of silently losing a
	// row and shifting the position of the rows around it.
	const malformedRefOnly = parseDelegationProgressFields({ rows: [{ ref: "bad/ref" }] });
	assert.deepEqual(malformedRefOnly?.rows, [{}]);

	// A row carrying nothing this version recognizes is still dropped: there was
	// no supplied field to degrade in the first place.
	assert.equal(parseDelegationProgressFields({ rows: [{ totallyUnknown: 1 }] }), undefined);
	assert.equal(parseDelegationProgressFields({ rows: [{}] }), undefined);
	// `idKind` qualifies an id rather than being one, so it alone keeps no row.
	assert.equal(parseDelegationProgressFields({ rows: [{ idKind: "owner" }] }), undefined);

	// The tolerant guarantee itself: a malformed ref never costs the row any
	// field that did validate, and a valid ref-only row is still a real row.
	const survivors = parseDelegationProgressFields({
		rows: [
			{ ref: "bad/ref", id: "t1" },
			{ ref: "bad/ref", status: "done" },
			{ ref: "good-ref" },
		],
	});
	assert.deepEqual(survivors?.rows, [
		{ id: "t1" },
		{ status: "done" },
		{ ref: "good-ref" },
	]);
});

test("an unknown outcome is read as a gap rather than as success", () => {
	// Failing safe matters here: a supervisor must never be told a worker
	// finished because it could not understand the verdict.
	const event = buildTasksProgressEvent(tasks([{ title: "one" }]), { lineagePath: "r/1#0" });
	assert.equal(parseTasksProgressEvent({ ...event, outcome: "something-new" })?.outcome, "gap");
});
