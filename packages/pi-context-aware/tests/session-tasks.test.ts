import test from "node:test";
import assert from "node:assert/strict";
import {
	MAX_SUBTASKS,
	MAX_TASKS,
	HARD_MAX_TASK_DEPTH,
	TASK_STATUSES,
	TASKS_ENTRY_TYPE,
	addTask,
	appendTasksSnapshot,
	applyUpdates,
	countTasks,
	createTasksSnapshot,
	deriveStatus,
	findTask,
	isListFinished,
	isListStuck,
	nextSnapshot,
	parseTasks,
	parseTasksSnapshot,
	planTasks,
	removeTasks,
	reorderTasks,
	replayTasksEntries,
	resolveAuthoritativeTasks,
	activeTasks,
	type Task,
	type TaskStatus,
} from "../session-tasks.js";

// Issue #26. The list is a checklist, not a work graph: exactly one level of
// sub-tasks, derived parent status, and a written reason whenever an actor
// says something is not happening.

function leaf(id: string, status: TaskStatus = "pending", origin: Task["origin"] = "agent", note?: string): Task {
	return { id, title: `task ${id}`, status, origin, ...(note === undefined ? {} : { note }) };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
	assert.equal(result.ok, true, result.ok ? "" : `unexpected failure: ${result.reason}`);
	return (result as { ok: true; value: T }).value;
}

function reason(result: { ok: true; value: unknown } | { ok: false; reason: string }): string {
	assert.equal(result.ok, false, "expected the mutation to be refused");
	return (result as { ok: false; reason: string }).reason;
}

// --- derived parent status --------------------------------------------------

test("a parent's status is derived from its children, worst news first", () => {
	assert.equal(deriveStatus([leaf("a", "blocked", "agent", "why"), leaf("b", "active")], "pending"), "blocked");
	assert.equal(deriveStatus([leaf("a", "active"), leaf("b", "pending")], "done"), "active");
	assert.equal(deriveStatus([leaf("a", "done"), leaf("b", "deferred", "agent", "why")], "pending"), "done");
	assert.equal(deriveStatus([leaf("a", "done"), leaf("b", "pending")], "done"), "pending");
	// A leaf keeps whatever it was set to.
	assert.equal(deriveStatus([], "active"), "active");
});

test("a stored parent status is overwritten by derivation, so a parent cannot lie", () => {
	// This is the failure the feature exists to prevent: parent claims done,
	// children say otherwise.
	const parsed = parseTasks([
		{ id: "t1", title: "parent", status: "done", origin: "agent", subtasks: [
			{ id: "t1.1", title: "child", status: "pending", origin: "agent" },
		] },
	]);
	assert.equal(parsed?.[0]?.status, "pending");
});

test("REQ-TASKDEL-004 a parent's status cannot be set directly", () => {
	const tasks = ok(parseTasksResult([
		{ id: "t1", title: "parent", status: "pending", origin: "agent", subtasks: [{ id: "t1.1", title: "child", status: "pending", origin: "agent" }] },
	]));
	const refused = reason(applyUpdates(tasks, [{ id: "t1", status: "done" }], "agent"));
	assert.match(refused, /derived from them; only leaves can be set directly/);
});

function parseTasksResult(value: unknown): { ok: true; value: Task[] } | { ok: false; reason: string } {
	const parsed = parseTasks(value);
	return parsed ? { ok: true, value: parsed } : { ok: false, reason: "invalid" };
}

// --- delegation contract and depth budget -----------------------------------

test("REQ-TASKDEL-001 a task records delegation without adding a status", () => {
	const tasks = ok(planTasks([{ title: "delegated", delegation: { sessionId: "worker-session" } }], "agent"));
	assert.deepEqual(tasks[0]?.delegation, { sessionId: "worker-session" });
	assert.equal(tasks[0]?.status, "pending");
	assert.deepEqual(TASK_STATUSES, ["pending", "active", "done", "blocked", "deferred"]);
});

test("REQ-TASKDEL-010 clearing delegation retains the worker's last attempt", () => {
	const tasks = ok(planTasks([{ title: "delegated", delegation: { sessionId: "worker-session" } }], "agent"));
	const cleared = ok(applyUpdates(tasks, [{ id: "t1", delegation: null, lastAttempt: { runId: "run-7", endState: "cancelled" } }], "agent"));
	assert.equal(cleared[0]?.delegation, undefined);
	assert.deepEqual(cleared[0]?.lastAttempt, { runId: "run-7", endState: "cancelled" });
	assert.equal(cleared[0]?.note, undefined);
});

test("REQ-TASKDEL-002 parser accepts maximum depth without session context", () => {
	let task: Record<string, unknown> = { id: "t1", title: "depth 16", status: "pending", origin: "agent" };
	for (let depth = HARD_MAX_TASK_DEPTH - 1; depth >= 0; depth -= 1) {
		task = { id: `t1.${depth + 1}`, title: `depth ${depth}`, status: "pending", origin: "agent", subtasks: [task] };
	}
	const parsed = parseTasks([task]);
	assert.ok(parsed);
	assert.equal(parsed[0]?.subtasks?.[0]?.subtasks?.[0]?.title, "depth 2");
});

test("REQ-TASKDEL-002 replay preserves a maximum-depth snapshot identically", () => {
	let task: Task = leaf("t1.17", "pending");
	for (let depth = HARD_MAX_TASK_DEPTH - 1; depth >= 0; depth -= 1) {
		task = { id: `t1.${depth + 1}`, title: `depth ${depth}`, status: "pending", origin: "agent", subtasks: [task] };
	}
	const snapshot = createTasksSnapshot({ piSessionId: "session", tasks: [task], eventId: "deep", now: "2026-05-06T00:00:00.000Z" });
	const replay = replayTasksEntries([{ type: "custom", customType: TASKS_ENTRY_TYPE, data: snapshot }]);
	assert.deepEqual(replay.snapshot, snapshot);
});

test("REQ-TASKDEL-003 plan and add enforce the write-time lineage budget", () => {
	const overBudget = planTasks([{ title: "root", subtasks: [{ title: "child", subtasks: [{ title: "too deep" }] }] }], "agent");
	assert.equal(overBudget.ok, false);
	assert.match(reason(overBudget), /delegation depth budget/);
	const existing = ok(planTasks([{ title: "root", subtasks: [{ title: "child" }] }], "agent"));
	const refused = addTask(existing, { title: "too deep", parent: "t1.1", origin: "agent" });
	assert.equal(refused.ok, false);
	assert.match(reason(refused), /delegation depth budget/);
	assert.deepEqual(existing, ok(planTasks([{ title: "root", subtasks: [{ title: "child" }] }], "agent")));
	assert.equal(addTask(existing, { title: "nested", parent: "t1.1", origin: "agent", delegationDepth: 1 }).ok, true);
});

test("REQ-TASKDEL-004 a blocked leaf at any depth blocks every ancestor", () => {
	const nested = leaf("middle", "pending");
	const nestedWithBlockedLeaf: Task = { ...nested, subtasks: [leaf("leaf", "blocked", "agent", "needs review")] };
	assert.equal(deriveStatus([nestedWithBlockedLeaf], "done"), "blocked");
	const parsed = parseTasks([{ id: "t1", title: "root", status: "done", origin: "agent", subtasks: [{ id: "t1.1", title: "middle", status: "pending", origin: "agent", subtasks: [{ id: "t1.1.1", title: "leaf", status: "blocked", note: "needs review", origin: "agent" }] }] }]);
	assert.equal(parsed?.[0]?.status, "blocked");
	assert.equal(parsed?.[0]?.subtasks?.[0]?.status, "blocked");
});

test("a deep snapshot is read-only until the lineage budget permits a write", () => {
	assert.ok(parseTasks([{ id: "t1", title: "a", status: "pending", origin: "agent", subtasks: [{ id: "t1.1", title: "b", status: "pending", origin: "agent", subtasks: [{ id: "t1.1.1", title: "c", status: "pending", origin: "agent" }] }] }]));
});

test("a sub-task can take its own sub-task when the lineage budget allows it", () => {
	const tasks = ok(planTasks([{ title: "parent", subtasks: [{ title: "step" }] }], "agent"));
	assert.match(reason(addTask(tasks, { title: "deeper", parent: "t1.1", origin: "agent" })), /delegation depth budget/);
	assert.equal(addTask(tasks, { title: "deeper", parent: "t1.1", origin: "agent", delegationDepth: 1 }).ok, true);
});

// --- blocked and deferred need a reason -------------------------------------

test("blocked and deferred require a written reason", () => {
	const tasks = ok(planTasks([{ title: "ship it" }], "agent"));
	assert.match(reason(applyUpdates(tasks, [{ id: "t1", status: "blocked" }], "agent")), /requires a written reason/);
	assert.match(reason(applyUpdates(tasks, [{ id: "t1", status: "deferred" }], "agent")), /requires a written reason/);
	const blocked = ok(applyUpdates(tasks, [{ id: "t1", status: "blocked", note: "waiting on review" }], "agent"));
	assert.equal(blocked[0]?.status, "blocked");
	assert.equal(blocked[0]?.note, "waiting on review");
});

test("an existing note satisfies the requirement on a later transition", () => {
	const tasks = ok(planTasks([{ title: "ship it", note: "upstream is red" }], "agent"));
	assert.equal(ok(applyUpdates(tasks, [{ id: "t1", status: "blocked" }], "agent"))[0]?.status, "blocked");
});

test("done and active need no reason", () => {
	const tasks = ok(planTasks([{ title: "ship it" }], "agent"));
	assert.equal(ok(applyUpdates(tasks, [{ id: "t1", status: "done" }], "agent"))[0]?.status, "done");
});

// --- origin locks -----------------------------------------------------------

test("the agent may transition a user task but not retitle or remove it", () => {
	const tasks = ok(addTask([], { title: "what the user asked for", origin: "user" }));
	assert.equal(ok(applyUpdates(tasks, [{ id: "t1", status: "done" }], "agent"))[0]?.status, "done");
	assert.match(reason(applyUpdates(tasks, [{ id: "t1", title: "something else" }], "agent")), /not retitled/);
	assert.match(reason(removeTasks(tasks, ["t1"], "agent")), /not removed/);
});

test("a spec task carries the same lock as a user task", () => {
	const tasks = ok(addTask([], { title: "seeded by pi-work", origin: "spec" }));
	assert.match(reason(applyUpdates(tasks, [{ id: "t1", title: "rewritten" }], "agent")), /spec-origin/);
	assert.match(reason(removeTasks(tasks, ["t1"], "agent")), /spec-origin/);
});

test("the user is not bound by the origin locks", () => {
	const tasks = ok(addTask([], { title: "what the user asked for", origin: "user" }));
	assert.equal(ok(applyUpdates(tasks, [{ id: "t1", title: "the user changed their mind" }], "user"))[0]?.title, "the user changed their mind");
	assert.deepEqual(ok(removeTasks(tasks, ["t1"], "user")), []);
});

test("agent-origin tasks are fully mutable by the agent", () => {
	const tasks = ok(planTasks([{ title: "mine" }], "agent"));
	assert.equal(ok(applyUpdates(tasks, [{ id: "t1", title: "renamed" }], "agent"))[0]?.title, "renamed");
	assert.deepEqual(ok(removeTasks(tasks, ["t1"], "agent")), []);
});

// --- batching ---------------------------------------------------------------

test("one update call flips several tasks", () => {
	const tasks = ok(planTasks([{ title: "one" }, { title: "two" }, { title: "three" }], "agent"));
	const next = ok(applyUpdates(tasks, [
		{ id: "t1", status: "done" },
		{ id: "t2", status: "active" },
		{ id: "t3", status: "blocked", note: "needs a decision" },
	], "agent"));
	assert.deepEqual(next.map((task) => task.status), ["done", "active", "blocked"]);
});

test("a batch is all-or-nothing, so a bad update cannot half-apply", () => {
	const tasks = ok(planTasks([{ title: "one" }, { title: "two" }], "agent"));
	const refused = applyUpdates(tasks, [{ id: "t1", status: "done" }, { id: "t2", status: "blocked" }], "agent");
	assert.equal(refused.ok, false);
	// The input list is untouched: mutation returns a new list and never edits in place.
	assert.equal(tasks[0]?.status, "pending");
});

// --- ordering ---------------------------------------------------------------

test("add places a task after or before a named sibling", () => {
	const tasks = ok(planTasks([{ title: "one" }, { title: "two" }], "agent"));
	assert.deepEqual(ok(addTask(tasks, { title: "between", after: "t1", origin: "agent" })).map((t) => t.title), ["one", "between", "two"]);
	assert.deepEqual(ok(addTask(tasks, { title: "first", before: "t1", origin: "agent" })).map((t) => t.title), ["first", "one", "two"]);
	assert.deepEqual(ok(addTask(tasks, { title: "last", origin: "agent" })).map((t) => t.title), ["one", "two", "last"]);
});

test("add refuses both after and before at once", () => {
	const tasks = ok(planTasks([{ title: "one" }], "agent"));
	assert.match(reason(addTask(tasks, { title: "x", after: "t1", before: "t1", origin: "agent" })), /either after or before/);
});

test("reorder needs the full id sequence, so the result is never ambiguous", () => {
	const tasks = ok(planTasks([{ title: "one" }, { title: "two" }, { title: "three" }], "agent"));
	assert.deepEqual(ok(reorderTasks(tasks, ["t3", "t1", "t2"])).map((t) => t.title), ["three", "one", "two"]);
	assert.match(reason(reorderTasks(tasks, ["t3", "t1"])), /needs all 3 task ids/);
	assert.match(reason(reorderTasks(tasks, ["t1", "t1", "t2"])), /appears twice/);
});

// --- counts and completion --------------------------------------------------

test("counts and the two completion questions are answered mechanically", () => {
	const tasks = ok(planTasks([
		{ title: "one", status: "done" },
		{ title: "two", status: "deferred", note: "out of scope" },
		{ title: "three", status: "blocked", note: "waiting" },
		{ title: "four" },
	], "agent"));
	assert.deepEqual(countTasks(tasks), { total: 4, done: 1, active: 0, blocked: 1, deferred: 1, pending: 1 });
	assert.equal(isListStuck(tasks), true);
	assert.equal(isListFinished(tasks), false);
	assert.deepEqual(activeTasks(tasks).map((task) => task.id), []);
});

test("only active leaves own execution, so a pending list authorizes nothing", () => {
	const flat = ok(planTasks([
		{ title: "running", status: "active" },
		{ title: "planned" },
		{ title: "waiting", status: "blocked", note: "needs a decision" },
	], "agent"));
	assert.deepEqual(activeTasks(flat).map((task) => task.id), ["t1"]);

	// A parent is a container for its children's execution, never a leaf of its
	// own: an active child stays visible under a blocked parent, and a parent
	// whose children are all pending contributes nothing.
	const nested = ok(planTasks([
		{ title: "blocked parent", subtasks: [
			{ title: "child still running", status: "active" },
			{ title: "child waiting", status: "blocked", note: "needs a decision" },
		] },
		{ title: "active parent", status: "active", subtasks: [{ title: "child not started" }] },
	], "agent"));
	assert.equal(nested[0].status, "blocked", "the fixture must exercise a blocked parent");
	assert.deepEqual(activeTasks(nested).map((task) => task.title), ["child still running"]);

	assert.deepEqual(activeTasks([]), []);
});

test("everything done or deferred means finished; an empty list is not", () => {
	const finished = ok(planTasks([{ title: "one", status: "done" }, { title: "two", status: "deferred", note: "not needed" }], "agent"));
	assert.equal(isListFinished(finished), true);
	assert.equal(isListStuck(finished), false);
	assert.equal(isListFinished([]), false);
});

test("counting is top-level only, because sub-tasks are steps rather than work items", () => {
	const tasks = ok(planTasks([{ title: "parent", subtasks: [{ title: "a" }, { title: "b" }] }], "agent"));
	assert.equal(countTasks(tasks).total, 1);
	assert.equal(findTask(tasks, "t1.2")?.parent?.id, "t1");
});

// --- validation bounds ------------------------------------------------------

test("the schema rejects malformed tasks rather than repairing them", () => {
	const base = { id: "t1", status: "pending", origin: "agent" };
	assert.equal(parseTasks([{ ...base, title: "" }]), null, "empty title");
	assert.equal(parseTasks([{ ...base, title: "x".repeat(201) }]), null, "over-long title");
	assert.equal(parseTasks([{ ...base, title: "two\nlines" }]), null, "multi-line title");
	assert.equal(parseTasks([{ ...base, title: "ok", note: "x".repeat(241) }]), null, "over-long note");
	assert.equal(parseTasks([{ ...base, title: "ok", status: "wontfix" }]), null, "unknown status");
	assert.equal(parseTasks([{ ...base, title: "ok", origin: "robot" }]), null, "unknown origin");
	assert.equal(parseTasks([{ ...base, id: "has space", title: "ok" }]), null, "unusable id");
	assert.equal(parseTasks([{ ...base, title: "ok" }, { ...base, title: "again" }]), null, "duplicate ids");
	assert.equal(parseTasks(Array.from({ length: MAX_TASKS + 1 }, (_v, i) => ({ ...base, id: `t${i + 1}`, title: "ok" }))), null, "over the list bound");
});

test("a plan is bounded and a task's sub-task count is bounded", () => {
	assert.match(reason(planTasks([], "agent")), /at least one task/);
	assert.match(reason(planTasks(Array.from({ length: MAX_TASKS + 1 }, () => ({ title: "x" })), "agent")), /at most 100 tasks/);
	const parent = ok(planTasks([{ title: "p", subtasks: Array.from({ length: MAX_SUBTASKS }, () => ({ title: "s" })) }], "agent"));
	assert.match(reason(addTask(parent, { title: "one too many", parent: "t1", origin: "agent" })), /at most 50 sub-tasks/);
});

// --- snapshots and replay ---------------------------------------------------

test("a snapshot round-trips through its own parser", () => {
	const snapshot = createTasksSnapshot({
		piSessionId: "session-a",
		tasks: ok(planTasks([{ title: "one" }], "agent")),
		eventId: "e1",
		now: "2026-05-06T00:00:00.000Z",
	});
	assert.deepEqual(parseTasksSnapshot(snapshot), snapshot);
	assert.equal(snapshot.revision, 1);
});

test("nextSnapshot advances the revision and keeps identity and creation time", () => {
	const first = createTasksSnapshot({ piSessionId: "s", tasks: ok(planTasks([{ title: "one" }], "agent")), eventId: "e1", now: "2026-05-06T00:00:00.000Z" });
	const second = nextSnapshot(first, ok(planTasks([{ title: "one" }, { title: "two" }], "agent")), { eventId: "e2", now: "2026-05-06T01:00:00.000Z" });
	assert.equal(second.revision, 2);
	assert.equal(second.piSessionId, "s");
	assert.equal(second.createdAt, first.createdAt);
	assert.equal(second.updatedAt, "2026-05-06T01:00:00.000Z");
});

test("replay takes the highest revision and ignores foreign entries", () => {
	const first = createTasksSnapshot({ piSessionId: "s", tasks: ok(planTasks([{ title: "one" }], "agent")), eventId: "e1", now: "2026-05-06T00:00:00.000Z" });
	const second = nextSnapshot(first, ok(planTasks([{ title: "one" }, { title: "two" }], "agent")), { eventId: "e2", now: "2026-05-06T01:00:00.000Z" });
	const entries = [
		{ type: "custom", customType: "context-aware.workstream.v1", data: { objective: "unrelated" } },
		{ type: "custom", customType: TASKS_ENTRY_TYPE, data: second },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: TASKS_ENTRY_TYPE, data: first },
	];
	const replay = replayTasksEntries(entries);
	assert.equal(replay.authority, "transcript");
	assert.equal(replay.snapshot?.revision, 2);
	assert.equal(replay.snapshot?.tasks.length, 2);
});

test("replay of the same transcript is order-independent, which matters on a fork", () => {
	const a = createTasksSnapshot({ piSessionId: "s", tasks: ok(planTasks([{ title: "branch a" }], "agent")), eventId: "e-a", revision: 2, now: "2026-05-06T00:00:00.000Z" });
	const b = createTasksSnapshot({ piSessionId: "s", tasks: ok(planTasks([{ title: "branch b" }], "agent")), eventId: "e-b", revision: 2, now: "2026-05-06T00:00:00.000Z" });
	const forward = replayTasksEntries([{ type: "custom", customType: TASKS_ENTRY_TYPE, data: a }, { type: "custom", customType: TASKS_ENTRY_TYPE, data: b }]);
	const reverse = replayTasksEntries([{ type: "custom", customType: TASKS_ENTRY_TYPE, data: b }, { type: "custom", customType: TASKS_ENTRY_TYPE, data: a }]);
	assert.deepEqual(forward.snapshot, reverse.snapshot);
});

test("a transcript with no task entries establishes nothing", () => {
	assert.equal(resolveAuthoritativeTasks([{ type: "message", message: { role: "user" } }]), null);
	assert.equal(replayTasksEntries([]).authority, null);
});

test("a corrupt snapshot is rejected rather than partially replayed", () => {
	const replay = replayTasksEntries([
		{ type: "custom", customType: TASKS_ENTRY_TYPE, data: { schemaVersion: 1, eventId: "e1", revision: 1, piSessionId: "s", tasks: [{ id: "t1" }], createdAt: "2026-05-06T00:00:00.000Z", updatedAt: "2026-05-06T00:00:00.000Z" } },
	]);
	assert.equal(replay.snapshot, null);
	assert.equal(replay.rejected, 1);
});

test("a newer schema version is ignored rather than misread", () => {
	const replay = replayTasksEntries([
		{ type: "custom", customType: TASKS_ENTRY_TYPE, data: { schemaVersion: 2, eventId: "e1", revision: 9, piSessionId: "s", tasks: [], createdAt: "2026-05-06T00:00:00.000Z", updatedAt: "2026-05-06T00:00:00.000Z" } },
	]);
	assert.equal(replay.snapshot, null);
});

test("appending validates before it writes", () => {
	const written: Array<[string, unknown]> = [];
	const api = { appendEntry: (customType: string, data?: unknown) => { written.push([customType, data]); } };
	const snapshot = createTasksSnapshot({ piSessionId: "s", tasks: ok(planTasks([{ title: "one" }], "agent")), eventId: "e1" });
	appendTasksSnapshot(api, snapshot);
	assert.equal(written[0]?.[0], TASKS_ENTRY_TYPE);
	assert.throws(() => appendTasksSnapshot(api, { ...snapshot, revision: 0 }), /invalid task snapshot/);
	assert.equal(written.length, 1, "the invalid snapshot was not written");
});

test("opaque refs survive plan, nested add, update, snapshot, and replay", () => {
	const ref = "A.ref-01_";
	const planned = ok(planTasks([{ title: "root", ref, subtasks: [{ title: "child", ref }] }], "agent"));
	assert.equal(planned[0]?.ref, ref);
	assert.equal(planned[0]?.subtasks?.[0]?.ref, ref);
	const added = ok(addTask(planned, { title: "new child", parent: "t1", ref, origin: "agent" }));
	const updated = ok(applyUpdates(added, [{ id: "t1", ref: "replacement" }], "agent"));
	assert.equal(updated[0]?.ref, "replacement");
	const snapshot = createTasksSnapshot({ piSessionId: "s", tasks: updated, eventId: "ref", now: "2026-05-06T00:00:00.000Z" });
	const replay = replayTasksEntries([{ type: "custom", customType: TASKS_ENTRY_TYPE, data: snapshot }]);
	assert.equal(replay.snapshot?.tasks[0]?.ref, "replacement");
	assert.equal(replay.snapshot?.tasks[0]?.subtasks?.[0]?.ref, ref);
	assert.equal(replay.snapshot?.tasks[0]?.subtasks?.[1]?.ref, ref);
});

test("refs use the task-safe boundary and malformed mutations stay atomic", () => {
	const valid = "A" + "x".repeat(31);
	assert.equal(ok(planTasks([{ title: "exact", ref: valid }], "agent"))[0]?.ref, valid);
	for (const ref of ["", " ", "-leading", ".leading", "a/b", "a b", "x".repeat(33), 7, null]) {
		assert.equal(parseTasks([{ id: "t1", title: "task", status: "pending", origin: "agent", ref }]), null, `strict parser accepted ${String(ref)}`);
		assert.equal(planTasks([{ title: "task", ref: ref as string }], "agent").ok, false, `plan accepted ${String(ref)}`);
	}
	const original = ok(planTasks([{ title: "one", ref: "before" }, { title: "two" }], "agent"));
	const refused = applyUpdates(original, [{ id: "t1", ref: "after" }, { id: "t2", ref: "bad/ref" }], "agent");
	assert.equal(refused.ok, false);
	assert.equal(original[0]?.ref, "before");
});

test("an agent cannot change a user- or spec-origin ref, but the user can", () => {
	for (const origin of ["user", "spec"] as const) {
		const tasks = ok(planTasks([{ title: origin, ref: "locked" }], origin));
		const before = structuredClone(tasks);
		assert.equal(applyUpdates(tasks, [{ id: "t1", ref: "changed" }], "agent").ok, false);
		assert.deepEqual(tasks, before);
		assert.equal(applyUpdates(tasks, [{ id: "t1", ref: "changed" }], "user").ok, true);
	}
});
