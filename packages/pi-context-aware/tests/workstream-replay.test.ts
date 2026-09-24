import test from "node:test";
import assert from "node:assert/strict";
import {
	appendWorkstreamSnapshot,
	createWorkstreamSnapshot,
	detachWorkstream,
	inheritWorkstream,
	workstreamEntry,
} from "../workstream-state.js";
import {
	replayWorkstreamEntries,
	resolveWorkstreamInheritance,
} from "../workstream-replay.js";
import { WORKSTREAM_SCHEMA_VERSION, asPiSessionId, asWorkstreamId, type WorkstreamSnapshot } from "../workstream-schema.js";

const now = "2026-07-17T00:00:00.000Z";
function snapshot(revision: number, objective: string, eventId = `event-${revision}`, overrides: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
	return createWorkstreamSnapshot({
		workstreamId: "ws-authority",
		piSessionId: "pi-session",
		revision,
		eventId,
		objective,
		objectivePinned: true,
		goals: [{ id: "goal-1", text: "Preserve authority", status: "active" }],
		refs: [{ kind: "graft-spec", value: "0001" }],
		boundaries: ["bounded"],
		now,
		...overrides,
	});
}

test("append accepts only complete schema snapshots and uses the versioned custom type", () => {
	const calls: Array<[string, unknown]> = [];
	appendWorkstreamSnapshot({ appendEntry: (type, data) => calls.push([type, data]) }, snapshot(1, "append"));
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.[0], "context-aware.workstream.v1");
	assert.equal((calls[0]?.[1] as WorkstreamSnapshot).objective, "append");
	assert.throws(() => appendWorkstreamSnapshot({ appendEntry: () => undefined }, { ...snapshot(1, "bad"), objective: "" }));
});

test("accepted focus provenance is stored in the authoritative entry and recovered by replay", () => {
	const first = snapshot(1, "first", "event-1");
	const second = snapshot(2, "second", "event-2");
	const mutation = {
		kind: "objective" as const,
		actor: "user" as const,
		reason: "explicit /focus edit",
		timestamp: now,
		priorRevision: 1,
		newRevision: 2,
		accepted: true as const,
		workstreamId: second.workstreamId,
		proposedObjective: "second",
	};
	const result = replayWorkstreamEntries([
		workstreamEntry(first, { entryId: "entry-1", timestamp: now }),
		workstreamEntry(second, {
			entryId: "entry-2",
			timestamp: now,
			priorRevision: 1,
			previousEventId: first.eventId,
			mutation,
		}),
	]);
	assert.equal(result.snapshot?.objective, "second");
	assert.deepEqual(result.mutation, mutation);
});

test("replays only valid complete transcript snapshots and latest contiguous revision wins", () => {
	const first = workstreamEntry(snapshot(1, "first"), { entryId: "entry-1", timestamp: now });
	const second = workstreamEntry(snapshot(2, "second"), { entryId: "entry-2", timestamp: now });
	const corrupt = { ...second, data: { ...second.data, objective: "" } };
	const unsupported = { ...second, customType: "other.v1" };
	const result = replayWorkstreamEntries([unsupported, corrupt, second, first]);
	assert.equal(result.snapshot?.objective, "second");
	assert.equal(result.snapshot?.revision, 2);
	assert.equal(result.rejected, 2);
});

test("duplicate IDs and permutations are deterministic, while a revision gap cannot establish authority", () => {
	const first = workstreamEntry(snapshot(1, "first"), { entryId: "entry-1", timestamp: now });
	const second = workstreamEntry(snapshot(2, "second"), { entryId: "entry-2", timestamp: now });
	const third = workstreamEntry(snapshot(3, "third"), { entryId: "entry-3", timestamp: now });
	const duplicate = workstreamEntry(snapshot(2, "duplicate", "event-2"), { entryId: "entry-duplicate", timestamp: now });
	const expected = replayWorkstreamEntries([third, duplicate, second, first]);
	const permuted = replayWorkstreamEntries([first, second, duplicate, third]);
	assert.equal(expected.snapshot?.objective, "third");
	assert.equal(permuted.snapshot?.objective, "third");
	assert.equal(expected.duplicateEventIds, 1);
	assert.equal(permuted.duplicateEventIds, 1);
	assert.equal(replayWorkstreamEntries([third, first]).snapshot?.revision, 1);
});

test("revision metadata and identity mismatches stop the chain without allowing a later revision", () => {
	const first = workstreamEntry(snapshot(1, "first"), { entryId: "entry-1", timestamp: now });
	const second = workstreamEntry(snapshot(2, "second"), { entryId: "entry-2", timestamp: now });
	const third = workstreamEntry(snapshot(3, "third"), { entryId: "entry-3", timestamp: now });
	const withInvalidPrior = { ...third, data: { ...third.data, priorRevision: 99 } };
	const otherStream = workstreamEntry(snapshot(3, "other", "event-other", { workstreamId: asWorkstreamId("ws-other") }), { entryId: "entry-other", timestamp: now });
	assert.equal(replayWorkstreamEntries([first, second, withInvalidPrior]).snapshot?.revision, 2);
	assert.equal(replayWorkstreamEntries([first, second, third, otherStream]).snapshot?.revision, 3);
});

test("duplicate event IDs choose one deterministic complete snapshot", () => {
	const first = workstreamEntry(snapshot(1, "first"), { entryId: "entry-1", timestamp: now });
	const duplicateLater = workstreamEntry(snapshot(2, "zulu", "event-2"), { entryId: "entry-zulu", timestamp: now });
	const duplicateEarlier = workstreamEntry(snapshot(2, "alpha", "event-2"), { entryId: "entry-alpha", timestamp: now });
	const firstOrder = replayWorkstreamEntries([first, duplicateLater, duplicateEarlier]);
	const secondOrder = replayWorkstreamEntries([first, duplicateEarlier, duplicateLater]);
	assert.equal(firstOrder.duplicateEventIds, 1);
	assert.equal(secondOrder.duplicateEventIds, 1);
	assert.equal(firstOrder.snapshot?.objective, "alpha");
	assert.equal(secondOrder.snapshot?.objective, "alpha");
});

test("duplicate event IDs resolve conflicting mutation provenance independently of input order", () => {
	const first = workstreamEntry(snapshot(1, "first", "event-1"), { entryId: "entry-1", timestamp: now });
	const second = snapshot(2, "second", "event-2");
	const mutation = (actor: "user" | "agent", reason: string) => ({
		kind: "objective" as const,
		actor,
		reason,
		timestamp: now,
		priorRevision: 1,
		newRevision: 2,
		accepted: true as const,
		workstreamId: second.workstreamId,
		proposedObjective: "second",
	});
	const userEntry = workstreamEntry(second, {
		entryId: "entry-2",
		timestamp: now,
		priorRevision: 1,
		previousEventId: "event-1",
		mutation: mutation("user", "explicit user edit"),
	});
	const agentEntry = workstreamEntry(second, {
		entryId: "entry-2",
		timestamp: now,
		priorRevision: 1,
		previousEventId: "event-1",
		mutation: mutation("agent", "agent proposal"),
	});
	const userFirst = replayWorkstreamEntries([first, userEntry, agentEntry]);
	const agentFirst = replayWorkstreamEntries([first, agentEntry, userEntry]);
	assert.deepEqual(userFirst.mutation, agentFirst.mutation);
	assert.equal(userFirst.mutation?.actor, "agent");
	assert.equal(userFirst.mutation?.reason, "agent proposal");
	assert.equal(userFirst.duplicateEventIds, 1);
	assert.equal(agentFirst.duplicateEventIds, 1);
});

test("a newer detached stream supersedes an older inherited stream during replay", () => {
	const inheritedFirst = snapshot(1, "inherited-first", "event-inherited-1", { createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z" });
	const inheritedLatest = snapshot(2, "inherited-latest", "event-inherited-2", { createdAt: "2026-07-17T01:00:00.000Z", updatedAt: "2026-07-17T01:00:00.000Z" });
	const detached = detachWorkstream(inheritedLatest, {
		piSessionId: "pi-detached",
		workstreamId: "ws-detached",
		eventId: "event-detached",
		now: "2026-07-18T00:00:00.000Z",
	});
	const result = replayWorkstreamEntries([
		workstreamEntry(inheritedFirst, { entryId: "entry-inherited-1", timestamp: inheritedFirst.createdAt }),
		workstreamEntry(inheritedLatest, { entryId: "entry-inherited-2", timestamp: inheritedLatest.createdAt }),
		workstreamEntry(detached, { entryId: "entry-detached", timestamp: detached.createdAt }),
	]);
	assert.equal(result.snapshot?.workstreamId, "ws-detached");
	assert.equal(result.snapshot?.revision, 1);
});

test("transcript provenance survives a later complete snapshot that omits optional provenance", () => {
	const first = workstreamEntry(snapshot(1, "first", "event-1", {
		provenance: { source: "transcript", parentPiSessionId: asPiSessionId("pi-parent"), inheritedWorkstreamId: asWorkstreamId("ws-authority") },
	}), { entryId: "entry-1", timestamp: now });
	const second = workstreamEntry(snapshot(2, "second"), { entryId: "entry-2", timestamp: now });
	const result = resolveWorkstreamInheritance([second, first]);
	assert.equal(result.snapshot?.objective, "second");
	assert.equal(result.provenance?.parentPiSessionId, "pi-parent");
});

test("transcript provenance is authoritative and projections cannot override it", () => {
	const transcript = workstreamEntry(snapshot(1, "transcript", "event-1", {
		provenance: { source: "transcript", parentPiSessionId: asPiSessionId("pi-parent"), inheritedWorkstreamId: asWorkstreamId("ws-authority") },
	}), { entryId: "entry-1", timestamp: now });
	const launcher = {
		schemaVersion: 1,
		handoffId: "handoff-1",
		workstreamId: "ws-launcher",
		parentPiSessionId: "pi-launcher",
		objective: "launcher projection",
		status: "active",
		expiresAt: "2026-07-18T00:00:00.000Z",
	};
	const result = resolveWorkstreamInheritance([transcript, {
		type: "custom", id: "activity", parentId: null, timestamp: now,
		customType: "context-aware.activity.v1", data: { objective: "activity projection" },
	}], { launcherHandoff: launcher, now: new Date(now) });
	assert.equal(result.authority, "transcript");
	assert.equal(result.snapshot?.objective, "transcript");
	assert.equal(result.provenance?.source, "transcript");
	assert.equal(result.launcherFallback, undefined);
});

test("all non-transcript projections stay neutral even when they carry newer objectives", () => {
	const transcript = workstreamEntry(snapshot(1, "transcript"), { entryId: "entry-1", timestamp: now });
	const projections = [
		{ type: "custom", id: "summary", parentId: null, timestamp: now, customType: "context-aware.summary.v1", data: { objective: "summary" } },
		{ type: "custom", id: "cache", parentId: null, timestamp: now, customType: "context-cache", data: { objective: "cache" } },
		{ type: "custom", id: "registry", parentId: null, timestamp: now, customType: "context-aware.registry.v1", data: { objective: "registry" } },
		{ type: "custom", id: "activity", parentId: null, timestamp: now, customType: "context-aware.activity.v1", data: { objective: "activity" } },
		{ type: "custom", id: "peer", parentId: null, timestamp: now, customType: "pi-intercom.v1", data: { objective: "peer" } },
		{ type: "custom", id: "terminal", parentId: null, timestamp: now, customType: "context-aware.terminal.v1", data: { objective: "terminal" } },
	];
	const result = resolveWorkstreamInheritance([...projections, transcript], {
		launcherHandoff: {
			schemaVersion: 1, handoffId: "handoff", workstreamId: "ws-launcher", parentPiSessionId: "pi-launcher",
			objective: "launcher", status: "active", expiresAt: "2026-07-18T00:00:00.000Z",
		},
		now: new Date(now),
	});
	assert.equal(result.authority, "transcript");
	assert.equal(result.snapshot?.objective, "transcript");
});

test("duplicate event IDs resolve conflicting chain metadata independently of input order", () => {
	const first = workstreamEntry(snapshot(1, "first"), { entryId: "entry-1", timestamp: now });
	const second = workstreamEntry(snapshot(2, "second", "event-2"), { entryId: "entry-good", timestamp: now });
	const good = { ...second, data: { ...second.data, priorRevision: 1, previousEventId: "event-1" } };
	const bad = { ...second, id: "entry-bad", data: { ...second.data, priorRevision: 99, previousEventId: "event-missing" } };
	const firstOrder = replayWorkstreamEntries([first, bad, good]);
	const secondOrder = replayWorkstreamEntries([first, good, bad]);
	assert.equal(firstOrder.snapshot?.revision, 2);
	assert.equal(secondOrder.snapshot?.revision, 2);
	assert.equal(firstOrder.snapshot?.eventId, secondOrder.snapshot?.eventId);
	assert.equal(firstOrder.duplicateEventIds, 1);
	assert.equal(secondOrder.duplicateEventIds, 1);
});

test("replay selects a complete lineage through a non-preferred competing revision branch", () => {
	const first = workstreamEntry(snapshot(1, "first", "event-1"), { entryId: "entry-1", timestamp: now });
	const branchA = workstreamEntry(snapshot(2, "branch-a", "event-2a"), { entryId: "entry-2a", timestamp: now });
	const branchB = workstreamEntry(snapshot(2, "branch-b", "event-2b"), { entryId: "entry-2b", timestamp: now });
	const third = workstreamEntry(snapshot(3, "third", "event-3"), { entryId: "entry-3", timestamp: now });
	const linkedA = { ...branchA, data: { ...branchA.data, priorRevision: 1, previousEventId: "event-1" } };
	const linkedB = { ...branchB, data: { ...branchB.data, priorRevision: 1, previousEventId: "event-1" } };
	const linkedThird = { ...third, data: { ...third.data, priorRevision: 2, previousEventId: "event-2b" } };
	const result = replayWorkstreamEntries([first, linkedA, linkedB, linkedThird]);
	assert.equal(result.snapshot?.revision, 3);
	assert.equal(result.snapshot?.objective, "third");
	assert.equal(result.chainValid, true);
});

test("later inherited child entry rebinds the selected snapshot and provenance", () => {
	const parent = snapshot(1, "parent", "event-a-parent");
	const child = inheritWorkstream(parent, "pi-child", { eventId: "event-z-child", now });
	const result = replayWorkstreamEntries([
		workstreamEntry(parent, { entryId: "entry-parent", timestamp: now }),
		workstreamEntry(child, { entryId: "entry-child", timestamp: now }),
	]);
	assert.equal(result.snapshot?.eventId, "event-z-child");
	assert.equal(result.snapshot?.piSessionId, "pi-child");
	assert.equal(result.provenance?.parentPiSessionId, "pi-session");
});

test("a detached stream wins an equal-updatedAt replay tie by transcript chronology", () => {
	const inheritedFirst = snapshot(1, "inherited-first", "event-inherited-1");
	const inheritedLatest = snapshot(2, "inherited-latest", "event-inherited-2", {
		createdAt: now,
		updatedAt: now,
	});
	const detached = detachWorkstream(inheritedLatest, {
		piSessionId: "pi-detached",
		workstreamId: "ws-detached",
		eventId: "event-detached",
		now,
	});
	const result = replayWorkstreamEntries([
		workstreamEntry(inheritedFirst, { entryId: "entry-inherited-1", timestamp: now }),
		workstreamEntry(inheritedLatest, { entryId: "entry-inherited-2", timestamp: now }),
		workstreamEntry(detached, { entryId: "entry-detached", timestamp: now }),
	]);
	assert.equal(result.snapshot?.workstreamId, "ws-detached");
	assert.equal(result.snapshot?.piSessionId, "pi-detached");
});

test("launcher fallback is validated, expiring, and never creates transcript authority", () => {
	const handoff = {
		schemaVersion: 1,
		handoffId: "handoff-1",
		workstreamId: "ws-launcher",
		parentPiSessionId: "pi-launcher",
		objective: "launcher objective",
		status: "active",
		expiresAt: "2026-07-18T00:00:00.000Z",
	};
	const fallback = resolveWorkstreamInheritance([], { launcherHandoff: handoff, now: new Date(now) });
	assert.equal(fallback.authority, null);
	assert.equal(fallback.snapshot, null);
	assert.equal(fallback.provenance?.source, "launcher");
	assert.equal(resolveWorkstreamInheritance([], { launcherHandoff: handoff, now: new Date("2026-07-19T00:00:00.000Z") }).provenance, undefined);
	assert.equal(resolveWorkstreamInheritance([], { launcherHandoff: { ...handoff, objective: "" }, now: new Date(now) }).provenance, undefined);
});

test("fork/clone keeps workstream identity but isolates Pi session, while detach mints a new stream", () => {
	const source = snapshot(1, "objective");
	const child = inheritWorkstream(source, "pi-child", { eventId: "event-child", now });
	assert.equal(child.workstreamId, source.workstreamId);
	assert.equal(child.piSessionId, "pi-child");
	assert.notEqual(child.piSessionId, source.piSessionId);
	assert.equal(child.provenance?.source, "transcript");
	const detached = detachWorkstream(source, { piSessionId: "pi-detached", eventId: "event-detached", workstreamId: "ws-detached", now });
	assert.equal(detached.revision, 1);
	assert.equal(detached.workstreamId, "ws-detached");
	assert.notEqual(detached.workstreamId, source.workstreamId);
	assert.equal(detached.piSessionId, "pi-detached");
	assert.equal(detached.provenance?.inheritedWorkstreamId, source.workstreamId);
});

test("legacy absence and bounded adversarial input remain neutral", () => {
	assert.equal(replayWorkstreamEntries([]).snapshot, null);
	assert.equal(replayWorkstreamEntries([null, 1, "legacy", { type: "message", data: "summary" }]).snapshot, null);
	const huge = Array.from({ length: 20_000 }, (_, index) => ({ type: "message", id: `legacy-${index}` }));
	const result = replayWorkstreamEntries(huge, { maxEntries: 100 });
	assert.equal(result.snapshot, null);
	assert.equal(result.rejected, 20_000);
});

assert.equal(WORKSTREAM_SCHEMA_VERSION, 1);
