import test from "node:test";
import assert from "node:assert/strict";

import { resolveAuthoritativeTasks, TASKS_ENTRY_TYPE } from "../src/session-tasks/session-tasks.js";
import { replayWorkstreamEntries } from "../src/workstream/workstream-replay.js";
import { focusFixture, type FocusFixture } from "./session-focus-harness.js";

// issue #212: the agent sets goals through session_focus and
// links tasks to them. Every assertion reads replayed session entries or the
// rendered per-turn message, never the tool's reply text.

async function withFixture(body: (fixture: FocusFixture) => Promise<void>, entries: unknown[] = []): Promise<void> {
	const fixture = await focusFixture(entries);
	try {
		await body(fixture);
	} finally {
		fixture.cleanup();
	}
}

/** A restart: a fresh extension instance replaying the same branch. */
async function afterRestart(entries: unknown[], body: (fixture: FocusFixture) => Promise<void>): Promise<void> {
	await withFixture(body, entries);
}

function replayedGoals(entries: readonly unknown[]) {
	return replayWorkstreamEntries(entries).snapshot?.goals;
}

function taskEntryCount(entries: readonly unknown[]): number {
	return entries.filter((entry) => (entry as { customType?: string }).customType === TASKS_ENTRY_TYPE).length;
}

test("session_focus goal adds, changes and removes a goal in the replayed snapshot", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_focus", { action: "start", objective: "Ship goals and briefs" });

		await fixture.call("session_focus", { action: "goal", goal: { id: "g1", text: "Expose goals on session_focus" } });
		assert.deepEqual(replayedGoals(fixture.entries), [{ id: "g1", text: "Expose goals on session_focus", status: "active" }],
			"a goal without a status is recorded as active");

		await fixture.call("session_focus", { action: "goal", goal: { id: "g2", text: "Add the brief", status: "pending" } });
		await fixture.call("session_focus", { action: "goal", goal: { id: "g1", text: "Expose goals on session_focus", status: "done" } });
		assert.deepEqual(replayedGoals(fixture.entries), [
			{ id: "g2", text: "Add the brief", status: "pending" },
			{ id: "g1", text: "Expose goals on session_focus", status: "done" },
		]);

		await fixture.call("session_focus", { action: "goal", goal: { id: "g2", text: "" }, remove: true });
		assert.deepEqual(replayedGoals(fixture.entries), [{ id: "g1", text: "Expose goals on session_focus", status: "done" }]);

		const snapshot = replayWorkstreamEntries(fixture.entries);
		assert.equal(snapshot.mutation?.kind, "goal");
		assert.equal(snapshot.mutation?.actor, "agent");
	});
});

test("session_focus goal survives a restart and shows in the focus section", async () => {
	const entries: unknown[] = [];
	await withFixture(async (fixture) => {
		await fixture.call("session_focus", { action: "start", objective: "Ship goals and briefs" });
		await fixture.call("session_focus", { action: "goal", goal: { id: "g1", text: "Expose goals", status: "blocked" } });
	}, entries);
	await afterRestart(entries, async (fixture) => {
		assert.deepEqual(replayedGoals(fixture.entries), [{ id: "g1", text: "Expose goals", status: "blocked" }]);
		const { systemPrompt } = await fixture.turn();
		assert.match(systemPrompt, /Expose goals/u, "the replayed goal reaches the focus envelope");
	});
});

test("a malformed goal id or status is refused and writes nothing", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_focus", { action: "start", objective: "Ship goals and briefs" });
		const before = fixture.entries.length;
		await assert.rejects(fixture.call("session_focus", { action: "goal", goal: { id: "has space", text: "x" } }), /goal id "has space" is not valid/u);
		await assert.rejects(fixture.call("session_focus", { action: "goal", goal: { id: "g".repeat(33), text: "x" } }), /goal id .* is not valid/u);
		await assert.rejects(fixture.call("session_focus", { action: "goal", goal: { id: "g1", text: "x", status: "paused" } }), /goal status "paused" is not valid/u);
		await assert.rejects(fixture.call("session_focus", { action: "goal" }), /session_focus goal requires the field goal/u);
		const unprepared = await fixture.callUnprepared("session_focus", { action: "goal", goal: { id: "-leading", text: "x" } });
		assert.equal(unprepared.isError, true, "execute refuses a malformed id even without the argument hook");
		assert.equal(fixture.entries.length, before, "a refused goal must not append an entry");
		assert.deepEqual(replayedGoals(fixture.entries), []);
	});
});

test("a task planned with a goal keeps it across a restart and the envelope shows it", async () => {
	const entries: unknown[] = [];
	await withFixture(async (fixture) => {
		const result = await fixture.call("session_tasks", {
			action: "plan",
			tasks: [{ title: "wire the goal field", goal: "g1" }, { title: "write the docs" }],
		});
		assert.notEqual(result.isError, true);
	}, entries);
	await afterRestart(entries, async (fixture) => {
		const tasks = resolveAuthoritativeTasks(fixture.entries)?.tasks ?? [];
		assert.equal(tasks[0]?.goal, "g1");
		assert.equal(tasks[1]?.goal, undefined);
		const message = await fixture.turnMessage();
		assert.match(message, /<task id="t1" goal="g1" status="pending">wire the goal field<\/task>/u);
		assert.match(message, /<task id="t2" status="pending">write the docs<\/task>/u);
	});
});

test("add and update link a task to a goal, and an empty goal clears it", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "first" }] });
		await fixture.call("session_tasks", { action: "add", title: "second", goal: "g2" });
		await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", goal: "g1" }] });
		let tasks = resolveAuthoritativeTasks(fixture.entries)?.tasks ?? [];
		assert.deepEqual(tasks.map((task) => task.goal), ["g1", "g2"]);
		let message = await fixture.turnMessage();
		assert.match(message, /<task id="t1" goal="g1" status="pending">first<\/task>/u);
		assert.match(message, /<task id="t2" goal="g2" status="pending">second<\/task>/u);

		await fixture.call("session_tasks", { action: "update", updates: [{ id: "t1", goal: "" }] });
		tasks = resolveAuthoritativeTasks(fixture.entries)?.tasks ?? [];
		assert.equal(tasks[0]?.goal, undefined, "an empty goal clears the link");
		assert.equal("goal" in (tasks[0] ?? {}), false, "a cleared link leaves no empty field behind");
		message = await fixture.turnMessage();
		assert.match(message, /<task id="t1" status="pending">first<\/task>/u);
	});
});

test("a goal id that names no goal is accepted", async () => {
	await withFixture(async (fixture) => {
		const result = await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "orphan", goal: "nope" }] });
		assert.notEqual(result.isError, true);
		assert.equal(resolveAuthoritativeTasks(fixture.entries)?.tasks[0]?.goal, "nope");
	});
});

test("a malformed task goal id is refused with a reason and changes nothing", async () => {
	await withFixture(async (fixture) => {
		await fixture.call("session_tasks", { action: "plan", tasks: [{ title: "first", goal: "g1" }] });
		const before = taskEntryCount(fixture.entries);
		for (const params of [
			{ action: "update", updates: [{ id: "t1", goal: "bad id" }] },
			{ action: "update", updates: [{ id: "t1", goal: "x".repeat(33) }] },
			{ action: "add", title: "second", goal: ".dot" },
			{ action: "plan", tasks: [{ title: "replacement", goal: "" }] },
		]) {
			const result = await fixture.call("session_tasks", params);
			assert.equal(result.isError, true, JSON.stringify(params));
			assert.match(result.content[0]?.text ?? "", /goal.*must be a goal id/u);
		}
		assert.equal(taskEntryCount(fixture.entries), before, "a refused goal must not append a task snapshot");
		assert.equal(resolveAuthoritativeTasks(fixture.entries)?.tasks[0]?.goal, "g1");
	});
});
