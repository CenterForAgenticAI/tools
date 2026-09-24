import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckinPrompt } from "../checkin.js";
import { asPiSessionId, asWorkstreamId } from "../workstream-schema.js";

test("check-in prompt carries focus, task ids and context pressure", () => {
	const prompt = buildCheckinPrompt({
		focus: {
			schemaVersion: 1,
			eventId: "focus-event",
			revision: 2,
			piSessionId: asPiSessionId("session"),
			workstreamId: asWorkstreamId("workstream"),
			objective: "Ship the reconciliation command",
			objectivePinned: false,
			status: "active",
			goals: [{ id: "goal-1", text: "Queue safely", status: "done" }],
			refs: [],
			boundaries: [],
			createdAt: "2026-08-22T00:00:00.000Z",
			updatedAt: "2026-08-22T00:00:00.000Z",
		},
		tasks: {
			schemaVersion: 1,
			eventId: "tasks-event",
			revision: 3,
			piSessionId: "session",
			tasks: [
				{ id: "task-1", title: "Add the command", status: "done", origin: "spec" },
				{ id: "task-2", title: "Verify worker behavior", status: "blocked", note: "Waiting for the supervisor", origin: "spec" },
			],
			createdAt: "2026-08-22T00:00:00.000Z",
			updatedAt: "2026-08-22T00:00:00.000Z",
		},
		pressure: { tokens: 128_000, window: 200_000, fraction: 0.64, headroom: 72_000 },
	});

	assert.match(prompt, /Ship the reconciliation command/u);
	assert.match(prompt, /task-1 \[done\]/u);
	assert.match(prompt, /task-2 \[blocked\].*Waiting for the supervisor/u);
	assert.match(prompt, /Context pressure: 64% used \(128000\/200000 tokens\)/u);
	assert.match(prompt, /Done/iu);
	assert.match(prompt, /Left/iu);
	assert.match(prompt, /Record corrections.*session_focus \/ session_tasks/isu);
	assert.match(prompt, /Continue or compact.*compact_session/isu);
});

test("empty check-in prompt names the absent durable records and still asks for progress", () => {
	const prompt = buildCheckinPrompt({ focus: null, tasks: null, pressure: null });
	assert.match(prompt, /Durable focus: none recorded/u);
	assert.match(prompt, /Durable task list: none recorded/u);
	assert.match(prompt, /No durable focus or task list exists.*still report progress/isu);
	assert.match(prompt, /Done/iu);
});
