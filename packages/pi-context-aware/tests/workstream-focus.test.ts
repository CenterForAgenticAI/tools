import test from "node:test";
import assert from "node:assert/strict";
import {
	parseFocusCommand,
	sessionFocus,
	type FocusCommand,
	type FocusMutationOptions,
} from "../workstream-focus.js";
import { asPiSessionId, asWorkstreamId } from "../workstream-schema.js";
import { createWorkstreamSnapshot } from "../workstream-state.js";

const identity = {
	workstreamId: asWorkstreamId("ws-focus"),
	piSessionId: asPiSessionId("pi-focus"),
};
const now = "2026-07-20T00:00:00.000Z";

function options(actor: FocusMutationOptions["actor"], reason: string, timestamp = now): FocusMutationOptions {
	return { actor, reason, now: timestamp, idFactory: (() => `${actor}-event`) };
}

function command(_command: FocusCommand, actor: FocusMutationOptions["actor"], reason: string, timestamp = now, extra: Partial<FocusMutationOptions> = {}): FocusMutationOptions {
	return { ...options(actor, reason, timestamp), ...extra };
}

test("an agent can explicitly start an unpinned focus", () => {
	const result = sessionFocus(
		null,
		{ action: "start", objective: "Ship durable focus mutations" },
		{ ...options("agent", "substantial multi-compaction work"), ...identity, eventId: "event-1" },
	);
	assert.equal(result.accepted, true);
	assert.equal(result.snapshot?.objective, "Ship durable focus mutations");
	assert.equal(result.snapshot?.objectivePinned, false);
	assert.equal(result.snapshot?.revision, 1);
	assert.equal(result.mutation?.actor, "agent");
	assert.equal(result.mutation?.priorRevision, 0);
	assert.equal(result.mutation?.newRevision, 1);
	const refined = sessionFocus(
		result.snapshot,
		{ action: "edit", objective: "Ship optional durable focus cleanly" },
		options("agent", "refine the concise purpose", "2026-07-20T00:01:00.000Z"),
	);
	assert.equal(refined.accepted, true);
	assert.equal(refined.snapshot?.objective, "Ship optional durable focus cleanly");
	assert.equal(refined.snapshot?.objectivePinned, false);
});

test("focus start is explicit, validates its objective, and cannot replace existing state", () => {
	const blank = sessionFocus(
		null,
		{ action: "start", objective: " \n\t" },
		{ ...options("agent", "blank proposal"), ...identity },
	);
	assert.equal(blank.accepted, false);
	assert.equal(blank.snapshot, null);

	const initial = sessionFocus(
		null,
		{ action: "start", objective: "First purpose" },
		{ ...options("agent", "substantial work"), ...identity, eventId: "event-1" },
	);
	const later = sessionFocus(
		initial.snapshot,
		{ action: "start", objective: "Second purpose" },
		{ ...options("agent", "another proposal"), ...identity, eventId: "event-2" },
	);
	assert.equal(later.accepted, false);
	assert.equal(later.changed, false);
	assert.equal(later.snapshot, initial.snapshot);
	assert.equal(later.snapshot?.objective, "First purpose");
	assert.equal(later.snapshot?.revision, 1);
});

test("mutations without focus are rejected without inventing routine durable state", () => {
	const result = sessionFocus(
		null,
		{ action: "goal", goal: { id: "goal-1", text: "Record an ordinary implementation step", status: "active" } },
		options("agent", "routine progress tracking"),
	);
	assert.equal(result.accepted, false);
	assert.equal(result.changed, false);
	assert.equal(result.snapshot, null);
	assert.match(result.message ?? "", /only when the purpose must survive an expected compaction, handoff, or restart, or the user explicitly requests focus/u);

	const userStart = sessionFocus(
		null,
		{ action: "start", objective: "User-supplied purpose" },
		options("user", "implicit start attempt"),
	);
	assert.equal(userStart.accepted, false);
	assert.match(userStart.message ?? "", /agent-selected purpose/u);
});

test("an explicit user edit can establish and pin the first focus", () => {
	const result = sessionFocus(
		null,
		{ action: "edit", objective: "User-owned purpose" },
		{ ...options("user", "explicit /focus edit"), ...identity, eventId: "event-user" },
	);
	assert.equal(result.accepted, true);
	assert.equal(result.snapshot?.objective, "User-owned purpose");
	assert.equal(result.snapshot?.objectivePinned, true);
	assert.equal(result.mutation?.actor, "user");
	assert.equal(result.mutation?.priorRevision, 0);
});

test("focus get/edit and all mutation surfaces record authorization and revision provenance", () => {
	const initial = createWorkstreamSnapshot({ ...identity, objective: "Provisional focus", now, eventId: "event-1" });
	const read = sessionFocus(initial, { action: "get" }, command({ action: "get" }, "agent", "inspect"));
	assert.equal(read.accepted, true);
	assert.equal(read.mutation, undefined);
	assert.equal(read.snapshot, initial);

	const edited = sessionFocus(initial, { action: "edit", objective: "Pinned user focus" }, command({ action: "edit", objective: "Pinned user focus" }, "user", "explicit /focus edit"));
	assert.equal(edited.snapshot?.objective, "Pinned user focus");
	assert.equal(edited.snapshot?.objectivePinned, true);
	assert.equal(edited.snapshot?.revision, 2);
	assert.deepEqual(
		{ actor: edited.mutation?.actor, reason: edited.mutation?.reason, priorRevision: edited.mutation?.priorRevision, newRevision: edited.mutation?.newRevision },
		{ actor: "user", reason: "explicit /focus edit", priorRevision: 1, newRevision: 2 },
	);

	const goal = sessionFocus(edited.snapshot!, { action: "goal", goal: { id: "goal-1", text: "Keep focus durable", status: "active" } }, command({ action: "goal", goal: { id: "goal-1", text: "Keep focus durable", status: "active" } }, "agent", "track goal", "2026-07-20T00:01:00.000Z"));
	const ref = sessionFocus(goal.snapshot!, { action: "ref", ref: { kind: "graft-spec", value: "0001" } }, command({ action: "ref", ref: { kind: "graft-spec", value: "0001" } }, "tool", "attach spec", "2026-07-20T00:02:00.000Z"));
	const boundary = sessionFocus(ref.snapshot!, { action: "boundary", boundary: "Do not replace the pinned objective" }, command({ action: "boundary", boundary: "Do not replace the pinned objective" }, "peer", "share boundary", "2026-07-20T00:03:00.000Z"));
	const paused = sessionFocus(boundary.snapshot!, { action: "status", status: "paused" }, command({ action: "status", status: "paused" }, "agent", "pause", "2026-07-20T00:04:00.000Z"));
	assert.equal(goal.snapshot?.revision, 3);
	assert.equal(ref.snapshot?.revision, 4);
	assert.equal(boundary.snapshot?.revision, 5);
	assert.equal(paused.snapshot?.revision, 6);
	assert.deepEqual(paused.snapshot?.goals, [{ id: "goal-1", text: "Keep focus durable", status: "active" }]);
	assert.deepEqual(paused.snapshot?.refs, [{ kind: "graft-spec", value: "0001" }]);
	assert.deepEqual(paused.snapshot?.boundaries, ["Do not replace the pinned objective"]);
	for (const mutation of [goal.mutation, ref.mutation, boundary.mutation, paused.mutation]) {
		assert.equal(mutation?.accepted, true);
		assert.equal(mutation?.newRevision, (mutation?.priorRevision ?? 0) + 1);
		assert.ok(mutation?.timestamp);
	}
});

test("goal removal is a recorded mutation and does not require replacement text", () => {
	const initial = createWorkstreamSnapshot({
		...identity,
		objective: "Pinned",
		goals: [{ id: "goal-1", text: "Remove me", status: "active" }],
		now,
		eventId: "event-1",
	});
	const result = sessionFocus(initial, { action: "goal", goal: { id: "goal-1", text: "", status: "active" }, remove: true }, options("user", "remove obsolete goal", "2026-07-20T00:01:00.000Z"));
	assert.equal(result.accepted, true);
	assert.deepEqual(result.snapshot?.goals, []);
	assert.equal(result.mutation?.kind, "goal");
	assert.equal(result.mutation?.priorRevision, 1);
	assert.equal(result.mutation?.newRevision, 2);
});

test("agent, seed, tool, peer, and related-session proposals cannot silently replace a pinned objective", () => {
	const pinned = createWorkstreamSnapshot({ ...identity, objective: "User-owned objective", objectivePinned: true, now, eventId: "event-1" });
	for (const actor of ["agent", "seed", "tool", "peer", "related-session"] as const) {
		const result = sessionFocus(pinned, { action: "edit", objective: `${actor} replacement` }, command({ action: "edit", objective: `${actor} replacement` }, actor, `${actor} proposal`));
		assert.equal(result.accepted, false, actor);
		assert.equal(result.snapshot, pinned, actor);
		assert.equal(result.snapshot?.objective, "User-owned objective", actor);
		assert.equal(result.snapshot?.revision, 1, actor);
		assert.equal(result.mutation?.priorRevision, 1, actor);
		assert.equal(result.mutation?.newRevision, 1, actor);
		assert.match(result.message ?? "", /approval|pinned|authorization/i, actor);
	}
	const forged = sessionFocus(
		pinned,
		{ action: "edit", objective: "Forged replacement" },
		{ ...command({ action: "edit", objective: "Forged replacement" }, "agent", "forged approval"), approved: true, authorize: true } as unknown as FocusMutationOptions,
	);
	assert.equal(forged.accepted, false);
	assert.equal(forged.snapshot, pinned);
	assert.equal(forged.snapshot?.objective, "User-owned objective");
});

test("status tombstones can be cleared explicitly and detach mints a new stream at revision one", () => {
	const initial = createWorkstreamSnapshot({ ...identity, objective: "Pinned", objectivePinned: true, now, eventId: "event-1" });
	const tombstone = sessionFocus(initial, { action: "status", status: "detached" }, command({ action: "status", status: "detached" }, "user", "tombstone", "2026-07-20T00:01:00.000Z"));
	const cleared = sessionFocus(tombstone.snapshot!, { action: "status", status: "active" }, command({ action: "status", status: "active" }, "user", "clear tombstone", "2026-07-20T00:02:00.000Z"));
	assert.equal(tombstone.snapshot?.status, "detached");
	assert.equal(cleared.snapshot?.status, "active");
	assert.equal(cleared.snapshot?.revision, 3);

	const detached = sessionFocus(cleared.snapshot!, { action: "detach" }, command({ action: "detach" }, "user", "start independent stream", "2026-07-20T00:03:00.000Z", { workstreamId: "ws-detached", piSessionId: "pi-detached", eventId: "event-detached" }));
	assert.equal(detached.accepted, true);
	assert.equal(detached.snapshot?.workstreamId, "ws-detached");
	assert.equal(detached.snapshot?.piSessionId, "pi-detached");
	assert.equal(detached.snapshot?.revision, 1);
	assert.equal(detached.mutation?.priorRevision, 3);
	assert.equal(detached.mutation?.newRevision, 1);
	assert.equal(detached.mutation?.previousWorkstreamId, "ws-focus");
	assert.equal(detached.snapshot?.provenance?.inheritedWorkstreamId, "ws-focus");
});

test("text focus commands cover get/edit/goal/ref/boundary/status/detach", () => {
	assert.deepEqual(parseFocusCommand("/focus"), { action: "get" });
	assert.deepEqual(parseFocusCommand("/focus edit Ship this"), { action: "edit", objective: "Ship this" });
	assert.deepEqual(parseFocusCommand("/focus goal goal-2 done Finish tests"), { action: "goal", goal: { id: "goal-2", text: "Finish tests", status: "done" } });
	assert.deepEqual(parseFocusCommand("/focus goal remove goal-1"), { action: "goal", goal: { id: "goal-1", text: "", status: "active" }, remove: true });
	assert.deepEqual(parseFocusCommand("/focus ref graft-spec 0001"), { action: "ref", ref: { kind: "graft-spec", value: "0001" } });
	assert.deepEqual(parseFocusCommand("/focus boundary remove Keep authority"), { action: "boundary", boundary: "Keep authority", remove: true });
	assert.deepEqual(parseFocusCommand("/focus status detached"), { action: "status", status: "detached" });
	assert.deepEqual(parseFocusCommand("/focus detach"), { action: "detach" });
	assert.equal(parseFocusCommand("/other edit no"), null);
});
