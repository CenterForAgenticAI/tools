import test from "node:test";
import assert from "node:assert/strict";
import { FOCUS_SEED_CONTRACT_VERSION, parseFocusSeed, type FocusSeed } from "../peer-contracts.js";
import { consumeFocusSeed } from "../focus-seed.js";
import { parseWorkstreamSnapshot } from "../workstream-schema.js";
import { WORKSTREAM_ENTRY_TYPE } from "../workstream-state.js";

const now = new Date("2026-08-15T00:00:00.000Z");
const seed: FocusSeed = {
	schemaVersion: FOCUS_SEED_CONTRACT_VERSION,
	objective: "Continue the delegated objective",
	boundaries: ["Keep the transcript authoritative"],
	refs: [{ kind: "gitlab-mr", value: "!48" }],
	host: "pi-delegate",
	parentPiSessionId: "pi-parent",
};

function consume(candidate: unknown = seed) {
	const entries: Array<{ customType: string; data: unknown }> = [];
	const consumed = consumeFocusSeed({
		seed: candidate,
		workstreamId: "ws-child",
		piSessionId: "pi-child",
		now,
		appendEntry: (customType, data) => entries.push({ customType, data }),
		idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
	});
	return { consumed, entries };
}

test("consumed focus seeds become valid unpinned host snapshots", () => {
	const { consumed, entries } = consume();
	assert.ok(consumed);
	assert.equal(consumed?.snapshot.objectivePinned, false);
	assert.deepEqual(consumed?.snapshot.provenance, {
		source: "host",
		host: "pi-delegate",
		parentPiSessionId: "pi-parent",
	});
	assert.deepEqual(consumed?.snapshot.boundaries, seed.boundaries);
	assert.deepEqual(consumed?.snapshot.refs, seed.refs);
	assert.deepEqual(parseWorkstreamSnapshot(consumed?.snapshot), consumed?.snapshot);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.customType, WORKSTREAM_ENTRY_TYPE);
});

test("every accepted focus seed can be consumed into a parser-accepted snapshot", () => {
	const accepted: FocusSeed = {
		schemaVersion: FOCUS_SEED_CONTRACT_VERSION,
		objective: "o".repeat(1_000),
		boundaries: Array.from({ length: 50 }, () => "b".repeat(512)),
		host: "h".repeat(256),
		parentPiSessionId: "p".repeat(256),
		refs: Array.from({ length: 50 }, (_, index) => ({ kind: "path" as const, value: `ref-${index}` })),
	};
	const parsed = parseFocusSeed(accepted);
	assert.ok(parsed);
	const { consumed } = consume(parsed);
	assert.ok(consumed);
	assert.ok(parseWorkstreamSnapshot(consumed?.snapshot));
});

test("invalid focus seeds are ignored without appending state", () => {
	for (const candidate of [null, { ...seed, objective: "" }, { ...seed, boundaries: ["x".repeat(513)] }]) {
		const { consumed, entries } = consume(candidate);
		assert.equal(consumed, undefined);
		assert.deepEqual(entries, []);
	}
});

test("host provenance accepts bounded host data and rejects unknown sources", () => {
	const base = {
		schemaVersion: 1,
		eventId: "event-1",
		workstreamId: "ws-1",
		piSessionId: "pi-1",
		revision: 1,
		objective: "Objective",
		objectivePinned: false,
		status: "active",
		goals: [],
		refs: [],
		boundaries: [],
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	assert.deepEqual(parseWorkstreamSnapshot({ ...base, provenance: { source: "host", host: "pi-delegate" } })?.provenance, { source: "host", host: "pi-delegate" });
	assert.equal(parseWorkstreamSnapshot({ ...base, provenance: { source: "unknown", host: "pi-delegate" } }), null);
	assert.equal(parseWorkstreamSnapshot({ ...base, provenance: { source: "host", host: "x".repeat(257) } }), null);
});
