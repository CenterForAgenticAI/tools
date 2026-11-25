import test from "node:test";
import assert from "node:assert/strict";
import {
	ACTIVITY_SCHEMA_VERSION,
	REGISTRY_SCHEMA_VERSION,
	WORKSTREAM_SCHEMA_VERSION,
	MAX_GOAL_REASON_CHARS,
	MAX_PINNED_VERBATIM_BLOCK_CHARS,
	MAX_PURPOSE_CHARS,
	asIntercomConnectionId,
	asPiSessionId,
	asTerminalId,
	asWorkstreamId,
	parseActivityEvent,
	parseCapabilityGate,
	parseRegistryProjection,
	parseWorkstreamMutation,
	parseWorkstreamSnapshot,
	type ActivityEvent,
	type RegistryProjection,
	type WorkstreamSnapshot,
} from "../src/snapshot-contracts/schema.js";

const identity = {
	workstreamId: asWorkstreamId("ws-1"),
	piSessionId: asPiSessionId("pi-1"),
	intercomConnectionId: asIntercomConnectionId("conn-1"),
	terminal: { terminalId: asTerminalId("term-1"), kind: "tmux" as const, location: "window-1" },
};

function snapshot(overrides: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
	return {
		schemaVersion: WORKSTREAM_SCHEMA_VERSION,
		eventId: "event-1",
		...identity,
		revision: 2,
		objective: "Ship the durable workstream contracts",
		objectivePinned: true,
		status: "active",
		goals: [{ id: "goal-1", text: "Define contracts", status: "active" }],
		refs: [{ kind: "graft-spec", value: "0001-durable-session-workstreams" }],
		boundaries: ["Do not own intercom routing"],
		createdAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:01:00.000Z",
		...overrides,
	};
}

test("schema contracts preserve distinct identities and reject malformed or unsupported records", () => {
	const parsed = parseWorkstreamSnapshot(snapshot());
	assert.deepEqual(parsed, snapshot());
	assert.notEqual(parsed?.workstreamId, parsed?.piSessionId);
	assert.notEqual(parsed?.piSessionId, parsed?.intercomConnectionId);
	assert.notEqual(parsed?.intercomConnectionId, parsed?.terminal?.terminalId);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), schemaVersion: 99 }), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), workstreamId: "pi-1" }), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), revision: 0 }), null);
	assert.equal(parseWorkstreamSnapshot({
		...snapshot(),
		createdAt: "2026-07-16T00:02:00.000Z",
		updatedAt: "2026-07-16T00:01:00.000Z",
	}), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), objective: "" }), null);
});

test("the pinned verbatim field is optional and bounded without changing ordinary snapshots", () => {
	const block = "Task:\n  Preserve this exact line.\n  Re-derive live facts before acting.";
	assert.equal(parseWorkstreamSnapshot(snapshot({ pinnedVerbatimBlock: block }))?.pinnedVerbatimBlock, block);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), pinnedVerbatimBlock: "x".repeat(MAX_PINNED_VERBATIM_BLOCK_CHARS + 1) }), null);
	assert.equal(parseWorkstreamSnapshot(snapshot())?.pinnedVerbatimBlock, undefined);
});

test("activity and registry contracts are independently versioned and bounded at parse time", () => {
	const activity: ActivityEvent = {
		...identity,
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		eventId: "activity-1",
		occurredAt: "2026-07-16T00:01:00.000Z",
		kind: "progress",
		summary: "Completed contract tests",
		relevant: true,
		sourceEntryIds: ["entry-1"],
	};
	const registry: RegistryProjection = {
		...identity,
		schemaVersion: REGISTRY_SCHEMA_VERSION,
		projectKey: "git-common-1",
		incarnation: "inc-1",
		pid: 42,
		pidStart: "2026-07-16T00:00:00.000Z",
		sequence: 1,
		state: "active",
		objective: "Ship contracts",
		status: "active",
		refs: [],
		heartbeatAt: "2026-07-16T00:01:00.000Z",
		updatedAt: "2026-07-16T00:01:00.000Z",
	};
	assert.deepEqual(parseActivityEvent(activity), activity);
	assert.deepEqual(parseRegistryProjection(registry), registry);
	assert.equal(parseActivityEvent({ ...activity, schemaVersion: 2 }), null);
	assert.equal(parseRegistryProjection({ ...registry, schemaVersion: 2 }), null);
	assert.equal(parseRegistryProjection({ ...registry, pid: undefined }), null);
	assert.equal(parseRegistryProjection({ ...registry, sequence: -1 }), null);
	assert.equal(parseActivityEvent({ ...activity, summary: "x".repeat(161) }), null);
});

test("optional capability gates are explicit", () => {
	assert.deepEqual(parseCapabilityGate({ capability: "cmux", enabled: true, available: false, reason: "probe unavailable" }), { capability: "cmux", enabled: true, available: false, reason: "probe unavailable" });
	assert.equal(parseCapabilityGate({ capability: "unknown", enabled: true, available: true }), null);
});

// pi-workstream writes the focus record now. These are the fields and kinds it
// adds to the shared schema; a snapshot that carries them must still parse, or
// the registry, cmux and activity lose the session's focus.
test("a snapshot written by pi-workstream with a purpose and a goal reason parses and keeps both", () => {
	const written = snapshot({ purpose: "Why this session exists", goalReason: "The operator set the goal" });
	const parsed = parseWorkstreamSnapshot(written);
	assert.equal(parsed?.purpose, "Why this session exists");
	assert.equal(parsed?.goalReason, "The operator set the goal");
	assert.deepEqual(parsed, written);
	assert.equal(parseWorkstreamSnapshot(snapshot())?.purpose, undefined);
	assert.equal(Object.hasOwn(parseWorkstreamSnapshot(snapshot()) ?? {}, "goalReason"), false);
});

test("a purpose or goal reason that is empty, not text, or over its cap is refused", () => {
	assert.equal(parseWorkstreamSnapshot(snapshot({ purpose: "x".repeat(MAX_PURPOSE_CHARS) }))?.purpose?.length, MAX_PURPOSE_CHARS);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), purpose: "x".repeat(MAX_PURPOSE_CHARS + 1) }), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), purpose: "" }), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), purpose: 7 }), null);
	assert.equal(parseWorkstreamSnapshot(snapshot({ goalReason: "x".repeat(MAX_GOAL_REASON_CHARS) }))?.goalReason?.length, MAX_GOAL_REASON_CHARS);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), goalReason: "x".repeat(MAX_GOAL_REASON_CHARS + 1) }), null);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), goalReason: "" }), null);
});

test("the issue and change ref kinds that pi-workstream writes parse; an unknown kind does not", () => {
	const refs = [{ kind: "issue" as const, value: "group/project#12" }, { kind: "change" as const, value: "group/project!7" }];
	assert.deepEqual(parseWorkstreamSnapshot(snapshot({ refs }))?.refs, refs);
	assert.equal(parseWorkstreamSnapshot({ ...snapshot(), refs: [{ kind: "ticket", value: "x" }] }), null);
});

test("a purpose mutation that pi-workstream records parses", () => {
	const mutation = { kind: "purpose", actor: "user", reason: "purpose set", timestamp: "2026-07-16T00:01:00.000Z", priorRevision: 1, newRevision: 2, accepted: true, workstreamId: "ws-1" };
	assert.equal(parseWorkstreamMutation(mutation)?.kind, "purpose");
	assert.equal(parseWorkstreamMutation({ ...mutation, kind: "mood" }), null);
});
