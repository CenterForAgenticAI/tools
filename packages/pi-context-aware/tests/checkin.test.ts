import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckinPrompt } from "../src/platform/checkin.js";
import { asPiSessionId, asWorkstreamId, type WorkstreamSnapshot } from "../src/snapshot-contracts/schema.js";

const focus: WorkstreamSnapshot = {
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
};

test("check-in prompt carries focus and context pressure, and asks for the task list through the task tool", () => {
	const prompt = buildCheckinPrompt(
		{ focus, pressure: { tokens: 128_000, window: 200_000, fraction: 0.64, headroom: 72_000 } },
		{ tasksCall: "workstream_tasks({})" },
	);

	assert.match(prompt, /Ship the reconciliation command/u);
	assert.match(prompt, /goal-1 \[done\] Queue safely/u);
	assert.match(prompt, /Task list: read it with workstream_tasks\(\{\}\) before you answer\. Reading it changes nothing\./u);
	assert.match(prompt, /Context pressure: 64% used \(128000\/200000 tokens\)/u);
	assert.match(prompt, /Done/iu);
	assert.match(prompt, /Left/iu);
	assert.match(prompt, /Record corrections — identify stale focus or task records and show the calls that would fix them/u);
	assert.match(prompt, /Continue or compact.*context_compact/isu);
});

test("check-in prompt names neither removed tool", () => {
	for (const options of [{}, { tasksCall: "workstream_tasks({})" }, { compactionAvailable: false }]) {
		const prompt = buildCheckinPrompt({ focus, pressure: null }, options);
		assert.doesNotMatch(prompt, /session_focus|session_tasks/u);
	}
});

test("check-in prompt uses the exact task call it is given, such as the executor form", () => {
	const prompt = buildCheckinPrompt({ focus, pressure: null }, { tasksCall: "extensions.workstream_tasks({})" });
	assert.match(prompt, /read it with extensions\.workstream_tasks\(\{\}\) before/u);
});

test("check-in prompt leaves the task list out when the task tool cannot be reached", () => {
	const prompt = buildCheckinPrompt({ focus, pressure: null });
	assert.doesNotMatch(prompt, /Task list|workstream_tasks/u);
	assert.doesNotMatch(prompt, /none recorded/u, "a focus is recorded");
});

test("check-in prompt drops compaction wording when compaction is unavailable", () => {
	const prompt = buildCheckinPrompt({ focus: null, pressure: null }, { compactionAvailable: false });
	assert.doesNotMatch(prompt, /context_compact|compact from this request/u);
	assert.match(prompt, /Continue — say whether this is a clean phase boundary/u);
	assert.match(prompt, /Compaction is not available in this session/u);
});

test("empty check-in prompt names the absent focus and still asks for progress", () => {
	const prompt = buildCheckinPrompt({ focus: null, pressure: null });
	assert.match(prompt, /Durable focus: none recorded/u);
	assert.match(prompt, /No durable focus or task list exists.*still report progress/isu);
	assert.match(prompt, /Done/iu);
});

test("empty focus with a reachable task tool asks the agent to check the list before saying there is nothing", () => {
	const prompt = buildCheckinPrompt({ focus: null, pressure: null }, { tasksCall: "workstream_tasks({})" });
	assert.match(prompt, /No durable focus exists\. If the task list is empty too, say that plainly/u);
	assert.doesNotMatch(prompt, /No durable focus or task list exists/u);
});
