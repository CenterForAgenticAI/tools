import test from "node:test";
import assert from "node:assert/strict";
import {
	activityTimeline,
	buildAuthoritativeWorkstreamCompactionProjection,
	buildWorkstreamCompactionProjection,
	buildWorkstreamContextEnvelope,
	constrainWorkstreamSeed,
	injectAuthoritativeWorkstreamContext,
	injectWorkstreamContext,
	resolveAuthoritativeWorkstream,
	selectActiveWorkstream,
	selectRecentRelevantActivity,
} from "../workstream-context.js";
import { createWorkstreamSnapshot, workstreamEntry } from "../workstream-state.js";
import { asPiSessionId, asWorkstreamId, type ActivityEvent, type WorkstreamSnapshot } from "../workstream-schema.js";

const now = "2026-07-20T00:00:00.000Z";

function snapshot(overrides: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
	return createWorkstreamSnapshot({
		workstreamId: "ws-context",
		piSessionId: "pi-context",
		objective: "Ship the durable context handoff",
		objectivePinned: true,
		goals: [
			{ id: "goal-active", text: "Preserve transcript authority", status: "active" },
			{ id: "goal-done", text: "Old completed goal", status: "done" },
		],
		refs: [
			{ kind: "graft-spec", value: "0001" },
			{ kind: "path", value: "workstream-context.ts" },
		],
		boundaries: ["Do not replace the pinned objective", "Keep activity out of normal prompts"],
		now,
		...overrides,
	});
}

function activity(
	eventId: string,
	occurredAt: string,
	relevant: boolean,
	summary = `activity ${eventId}`,
): ActivityEvent {
	return {
		schemaVersion: 1,
		eventId,
		workstreamId: asWorkstreamId("ws-context"),
		piSessionId: asPiSessionId("pi-context"),
		occurredAt,
		kind: relevant ? "decision" : "progress",
		summary,
		relevant,
		sourceEntryIds: [`source-${eventId}`],
	};
}

test("active context is a bounded extension envelope, while inactive state is omitted", () => {
	const current = snapshot({
		objective: "Objective " + "x".repeat(900),
		goals: Array.from({ length: 50 }, (_, index) => ({ id: `goal-${index}`, text: `Goal ${index} ${"x".repeat(500)}`, status: "active" as const })),
		refs: Array.from({ length: 100 }, (_, index) => ({ kind: "path" as const, value: `ref-${index}-${"x".repeat(500)}` })),
		boundaries: Array.from({ length: 50 }, (_, index) => `Boundary ${index} ${"x".repeat(500)}`),
	});
	const envelope = buildWorkstreamContextEnvelope(current, { maxChars: 3_000 });
	assert.ok(envelope);
	assert.ok(envelope.length <= 3_000);
	assert.match(envelope, /^<session-workstream\b/);
	assert.match(envelope, /source="pi-extension:context-aware"/);
	assert.match(envelope, /workstream-id="ws-context"/);
	assert.match(envelope, /revision="1"/);
	assert.match(envelope, /Ship the durable context handoff|Objective/);
	assert.match(envelope, /goal-active|Goal 0/);
	assert.match(envelope, /<refs>/);
	assert.match(envelope, /<boundaries>/);
	assert.doesNotMatch(envelope, /activity|eventId|createdAt|updatedAt|Old completed goal/);
	const ordinaryEnvelope = buildWorkstreamContextEnvelope(snapshot());
	assert.ok(ordinaryEnvelope);
	assert.match(ordinaryEnvelope, /graft-spec/);
	assert.match(ordinaryEnvelope, /Do not replace the pinned objective/);
	assert.equal(buildWorkstreamContextEnvelope(snapshot({ status: "paused" })), null);
	assert.equal(injectWorkstreamContext("<base />", snapshot({ status: "paused" })), "<base />");
	assert.match(injectWorkstreamContext("<base />", current), /^<base \/>\n\n<session-workstream/);
});

test("the pinned block is rendered unchanged and is outside ordinary focus shrinking", () => {
	const block = "## Lane anchor\nTask: preserve this exact path: /tmp/example.ts\nLIVE: re-derive commits before acting.";
	const current = { ...snapshot(), pinnedVerbatimBlock: block };
	const envelope = buildWorkstreamContextEnvelope(current, { maxChars: 3_000 });
	assert.ok(envelope);
	assert.match(envelope, /pinned-verbatim-block pinned="true"/u);
	assert.match(envelope, new RegExp(block.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
	assert.equal(buildWorkstreamContextEnvelope(current)?.includes(block), true);
	assert.equal(buildWorkstreamContextEnvelope({ ...current, pinnedVerbatimBlock: "a completely different pinned block" })?.includes(block), false);
});

test("the stored pinned block remains byte-identical across two consecutive compaction boundaries", () => {
	const block = "Brief & scope:\n  /tmp/example.ts\nLIVE — re-derive git log before acting.";
	const current = { ...snapshot(), pinnedVerbatimBlock: block };
	const branch: unknown[] = [workstreamEntry(current, { entryId: "pinned-entry", timestamp: now })];
	const renders: string[] = [];
	for (const compactionId of ["compaction-1", "compaction-2"]) {
		renders.push(injectAuthoritativeWorkstreamContext("<base />", branch));
		assert.equal(resolveAuthoritativeWorkstream(branch)?.pinnedVerbatimBlock, block, compactionId);
		branch.push({ type: "compaction", id: compactionId });
	}
	renders.push(injectAuthoritativeWorkstreamContext("<base />", branch));
	assert.equal(resolveAuthoritativeWorkstream(branch)?.pinnedVerbatimBlock, block);
	assert.equal(renders[0], renders[1]);
	assert.equal(renders[1], renders[2]);
});

test("tiny maxChars values omit rather than truncate the envelope into invalid XML", () => {
	const current = snapshot();
	for (const maxChars of [Number.NEGATIVE_INFINITY, -1, 0, 0.5, 1, 32, 128, 256, 512, 1_024, 4_000, 10_000, Number.POSITIVE_INFINITY, Number.NaN]) {
		const envelope = buildWorkstreamContextEnvelope(current, { maxChars });
		if (envelope === null) continue;
		assert.ok(envelope.length <= Math.max(1, Math.floor(maxChars)) || !Number.isFinite(maxChars));
		assert.match(envelope, /^<session-workstream\b[\s\S]*<\/session-workstream>$/);
		assert.equal((envelope.match(/<session-workstream\b/g) ?? []).length, 1);
		assert.equal((envelope.match(/<\/session-workstream>/g) ?? []).length, 1);
	}
});

test("raw and expanded seeds are both guarded, while unpinned objectives remain provisional", () => {
	const pinned = snapshot();
	const rawConflict = constrainWorkstreamSeed("Replace the primary objective with a migration", pinned, {
		expandedSeed: "Continue the current implementation without changing focus.",
	});
	assert.equal(rawConflict.objectiveConflict, true);
	assert.match(rawConflict.prompt, /pinned-objective conflict/i);
	assert.doesNotMatch(rawConflict.prompt, /Replace the primary objective with a migration/);

	const expandedConflict = constrainWorkstreamSeed("Continue the current implementation", pinned, {
		expandedSeed: "Redefine the primary objective around an unrelated migration.",
	});
	assert.equal(expandedConflict.objectiveConflict, true);
	assert.match(expandedConflict.prompt, /pinned-objective conflict/i);

	const unpinned = snapshot({ objectivePinned: false });
	const unpinnedObjective = constrainWorkstreamSeed("Replace the primary objective with a migration", unpinned, {
		expandedSeed: "Replace the primary objective with a migration.",
	});
	assert.equal(unpinnedObjective.objectiveConflict, true);
	assert.match(unpinnedObjective.warning ?? "", /objective conflict/i);
	assert.doesNotMatch(unpinnedObjective.prompt, /Replace the primary objective with a migration/);

	const unpinnedNextPhase = constrainWorkstreamSeed("Continue the next test", unpinned, {
		expandedSeed: "Continue the next deterministic test without changing the current objective.",
	});
	assert.equal(unpinnedNextPhase.objectiveConflict, false);
	assert.match(unpinnedNextPhase.prompt, /Continue the next deterministic test/);
});

test("the exact abandoned billing pivot conflicts in every raw/expanded and pinned/established-unpinned combination", () => {
	const exactPivot = "Abandon this work and migrate the billing database instead";
	const cases = [
		{ label: "raw pinned", current: snapshot(), rawSeed: exactPivot, expandedSeed: "Continue this work." },
		{ label: "expanded pinned", current: snapshot(), rawSeed: "Continue this work.", expandedSeed: exactPivot },
		{ label: "raw established-unpinned", current: snapshot({ objectivePinned: false }), rawSeed: exactPivot, expandedSeed: "Continue this work." },
		{ label: "expanded established-unpinned", current: snapshot({ objectivePinned: false }), rawSeed: "Continue this work.", expandedSeed: exactPivot },
	] as const;
	for (const { label, current, rawSeed, expandedSeed } of cases) {
		const result = constrainWorkstreamSeed(rawSeed, current, { rawSeed, expandedSeed });
		assert.equal(result.objectiveConflict, true, label);
		assert.equal(result.prompt.includes(current.objective), true, `${label}: objective preserved`);
		assert.equal(result.prompt.includes("graft-spec:0001"), true, `${label}: reference preserved`);
		assert.equal(result.prompt.includes("Do not replace the pinned objective"), true, `${label}: boundary preserved`);
		assert.doesNotMatch(result.prompt, /billing database/i, `${label}: billing pivot not adopted`);
	}
});

test("the required refinement phrases remain non-conflicting seed requests", () => {
	for (const phrase of ["Change this work to use the stable API", "Rewrite this work helper to avoid mutation"] as const) {
		const result = constrainWorkstreamSeed(phrase, snapshot(), { rawSeed: phrase, expandedSeed: phrase });
		assert.equal(result.objectiveConflict, false, phrase);
		assert.match(result.prompt, new RegExp(phrase.replaceAll(" ", "\\s+")), phrase);
	}
});

test("only replayed transcript custom entries establish the workstream context", () => {
	const authoritative = snapshot({ objective: "Transcript objective" });
	const entries = [
		{
			type: "custom",
			id: "projection",
			parentId: null,
			timestamp: now,
			customType: "context-aware.activity.v1",
			data: { objective: "Projection objective", revision: 99 },
		},
		workstreamEntry(authoritative, { entryId: "entry-authoritative", timestamp: now }),
	];
	assert.deepEqual(resolveAuthoritativeWorkstream(entries), authoritative);
	assert.equal(resolveAuthoritativeWorkstream([entries[0]]), null);
	assert.equal(resolveAuthoritativeWorkstream([]), null);
	const malformed = workstreamEntry(snapshot({ objective: "Malformed candidate" }), { entryId: "malformed-entry", timestamp: now });
	const malformedData = { ...malformed, data: { ...(malformed.data as WorkstreamSnapshot), revision: "not-a-number" } };
	assert.deepEqual(resolveAuthoritativeWorkstream([malformedData, entries[1]]), authoritative);
	assert.equal(resolveAuthoritativeWorkstream([malformedData]), null);
});

test("generic replacement language cannot bypass the objective guard", () => {
	const current = snapshot();
	const result = constrainWorkstreamSeed("Drop the current task and switch to an unrelated migration", current, {
		expandedSeed: "Continue the current implementation.",
		rawSeed: "Drop the current task and switch to an unrelated migration",
	});
	assert.equal(result.objectiveConflict, true);
	assert.match(result.warning ?? "", /objective conflict/i);
	assert.doesNotMatch(result.prompt, /unrelated migration/);
	const ordinary = constrainWorkstreamSeed("Switch to another test within this objective", current, {
		expandedSeed: "Switch to another test within this objective",
	});
	assert.equal(ordinary.objectiveConflict, false);
	const established = snapshot({ objectivePinned: false });
	const establishedConflict = constrainWorkstreamSeed("Abandon the existing direction and pursue a separate migration", established, {
		expandedSeed: "Abandon the existing direction and pursue a separate migration",
	});
	assert.equal(establishedConflict.objectiveConflict, true);
	assert.doesNotMatch(establishedConflict.prompt, /separate migration/);

	const rawThisWork = constrainWorkstreamSeed("Switch from this work to an unrelated migration", current, {
		expandedSeed: "Continue this work.",
		rawSeed: "Switch from this work to an unrelated migration",
	});
	assert.equal(rawThisWork.objectiveConflict, true);
	assert.doesNotMatch(rawThisWork.prompt, /unrelated migration/);
	const expandedThisWork = constrainWorkstreamSeed("Continue this work", current, {
		expandedSeed: "Switch from this work to an unrelated migration",
	});
	assert.equal(expandedThisWork.objectiveConflict, true);
	assert.doesNotMatch(expandedThisWork.prompt, /unrelated migration/);

	const replaceThisWork = constrainWorkstreamSeed("Replace this work with an unrelated migration", current, {
		expandedSeed: "Replace this work with an unrelated migration",
	});
	assert.equal(replaceThisWork.objectiveConflict, true);
	assert.doesNotMatch(replaceThisWork.prompt, /unrelated migration/);
});

test("raw pinned objective pivots preserve the original objective, refs, and boundaries", () => {
	const result = constrainWorkstreamSeed("Replace this work with an unrelated migration", snapshot(), {
		rawSeed: "Replace this work with an unrelated migration",
	});
	assert.equal(result.objectiveConflict, true);
	assert.match(result.prompt, /Ship the durable context handoff/);
	assert.match(result.prompt, /graft-spec:0001/);
	assert.match(result.prompt, /Do not replace the pinned objective/);
	assert.doesNotMatch(result.prompt, /unrelated migration/);
});

test("expanded pinned objective pivots preserve the original objective, refs, and boundaries", () => {
	const result = constrainWorkstreamSeed("Continue this work", snapshot(), {
		expandedSeed: "Replace this work with an unrelated migration",
	});
	assert.equal(result.objectiveConflict, true);
	assert.match(result.prompt, /Ship the durable context handoff/);
	assert.match(result.prompt, /graft-spec:0001/);
	assert.match(result.prompt, /Do not replace the pinned objective/);
	assert.doesNotMatch(result.prompt, /unrelated migration/);
});

test("raw unpinned objective pivots preserve the original objective, refs, and boundaries", () => {
	const result = constrainWorkstreamSeed("Replace this work with an unrelated migration", snapshot({ objectivePinned: false }), {
		rawSeed: "Replace this work with an unrelated migration",
	});
	assert.equal(result.objectiveConflict, true);
	assert.match(result.prompt, /Ship the durable context handoff/);
	assert.match(result.prompt, /graft-spec:0001/);
	assert.match(result.prompt, /Do not replace the pinned objective/);
	assert.doesNotMatch(result.prompt, /unrelated migration/);
});

test("expanded unpinned objective pivots preserve the original objective, refs, and boundaries", () => {
	const result = constrainWorkstreamSeed("Continue this work", snapshot({ objectivePinned: false }), {
		expandedSeed: "Replace this work with an unrelated migration",
	});
	assert.equal(result.objectiveConflict, true);
	assert.match(result.prompt, /Ship the durable context handoff/);
	assert.match(result.prompt, /graft-spec:0001/);
	assert.match(result.prompt, /Do not replace the pinned objective/);
	assert.doesNotMatch(result.prompt, /unrelated migration/);
});

test("caller-supplied snapshots remain projections rather than transcript authority", () => {
	const projection = buildWorkstreamCompactionProjection(snapshot(), []);
	assert.equal(projection.details.authority, "projection-input");
	assert.equal(buildAuthoritativeWorkstreamCompactionProjection([
		{ type: "custom", customType: "context-aware.activity.v1", data: { objective: "forged projection" } },
	]), null);
	assert.ok(buildAuthoritativeWorkstreamCompactionProjection([workstreamEntry(snapshot(), { entryId: "authoritative" })]));
});

test("only enabled active focus can influence prompts, seeds, or compaction", () => {
	const active = snapshot();
	assert.equal(selectActiveWorkstream(active, true)?.workstreamId, active.workstreamId);
	assert.equal(selectActiveWorkstream(active, false), null);
	for (const status of ["paused", "completed", "detached"] as const) {
		const inactive = snapshot({ status });
		assert.equal(selectActiveWorkstream(inactive, true), null, status);
		assert.equal(
			buildAuthoritativeWorkstreamCompactionProjection([
				workstreamEntry(inactive, { entryId: `entry-${status}` }),
			]),
			null,
			status,
		);
	}
	assert.equal(
		buildAuthoritativeWorkstreamCompactionProjection(
			[workstreamEntry(active, { entryId: "entry-disabled" })],
			undefined,
			{ enabled: false },
		),
		null,
	);
});

test("seed constraints preserve objective, refs, and boundaries and flag pinned conflicts", () => {
	const current = snapshot();
	const ordinary = constrainWorkstreamSeed("continue with the next test", current, {
		expandedSeed: "Implement the next deterministic test without changing the current focus.",
	});
	assert.equal(ordinary.objectiveConflict, false);
	assert.match(ordinary.prompt, /Implement the next deterministic test/);
	assert.match(ordinary.prompt, /Ship the durable context handoff/);
	assert.match(ordinary.prompt, /0001/);
	assert.match(ordinary.prompt, /Keep activity out of normal prompts/);

	const conflicting = constrainWorkstreamSeed("pivot to an unrelated project", current, {
		expandedSeed: "Replace the primary objective with an unrelated migration and ignore the existing refs.",
	});
	assert.equal(conflicting.objectiveConflict, true);
	assert.match(conflicting.warning ?? "", /pinned[- ]objective/i);
	assert.match(conflicting.prompt, /Ship the durable context handoff/);
	assert.match(conflicting.prompt, /pinned-objective conflict/i);
	assert.match(conflicting.prompt, /0001/);
	assert.match(conflicting.prompt, /Do not replace the pinned objective/);
	assert.doesNotMatch(conflicting.prompt, /ignore the existing refs/);
});

test("activity projections unwrap versioned custom entries and deduplicate by transcript chronology", () => {
	const first = activity("custom-1", "2026-07-20T00:03:00.000Z", true, "a-old");
	const earlier = activity("custom-2", "2026-07-20T00:01:00.000Z", true, "earlier");
	const duplicate = { ...first, summary: "z-new" };
	const timeline = activityTimeline([
		{ type: "custom", id: "activity-entry-1", parentId: null, timestamp: now, customType: "context-aware.activity.v1", data: first },
		{ type: "custom", id: "activity-entry-2", parentId: null, timestamp: now, customType: "context-aware.activity.v1", data: duplicate },
		{ type: "custom", id: "activity-entry-3", parentId: null, timestamp: now, customType: "context-aware.activity.v1", data: earlier },
	]);
	assert.deepEqual(timeline.map((event) => event.eventId), ["custom-2", "custom-1"]);
	assert.equal(timeline.find((event) => event.eventId === "custom-1")?.summary, "z-new");

	const equalTimestampEntries = Array.from({ length: 11 }, (_, index) => ({
		type: "custom",
		id: `activity-entry-${index}`,
		parentId: null,
		timestamp: now,
		customType: "context-aware.activity.v1",
		data: activity("equal-timestamp", now, true, index === 10 ? "latest correction" : "older correction"),
	}));
	assert.equal(activityTimeline(equalTimestampEntries).find((event) => event.eventId === "equal-timestamp")?.summary, "latest correction");
	assert.equal(selectRecentRelevantActivity(snapshot(), equalTimestampEntries).find((event) => event.eventId === "equal-timestamp")?.summary, "latest correction");
});

test("full activity remains available to UI callers but only three relevant entries enter compaction", () => {
	const current = snapshot();
	const events = [
		activity("routine-1", "2026-07-20T00:01:00.000Z", false),
		activity("relevant-1", "2026-07-20T00:02:00.000Z", true),
		activity("relevant-2", "2026-07-20T00:03:00.000Z", true),
		activity("routine-2", "2026-07-20T00:04:00.000Z", false),
		activity("relevant-3", "2026-07-20T00:05:00.000Z", true),
		activity("relevant-4", "2026-07-20T00:06:00.000Z", true),
		{
			type: "custom",
			id: "projection-only",
			parentId: null,
			timestamp: now,
			customType: "context-aware.activity.v1",
			data: { eventId: "projection-only", relevant: true, summary: "must not enter digest" },
		},
	];
	const timeline = activityTimeline(events);
	assert.equal(timeline.length, 6);
	assert.equal(timeline[0]?.eventId, "routine-1");
	assert.equal(timeline[5]?.eventId, "relevant-4");
	const recent = selectRecentRelevantActivity(current, events);
	assert.deepEqual(recent.map((item) => item.eventId), ["relevant-2", "relevant-3", "relevant-4"]);

	const projection = buildWorkstreamCompactionProjection(current, events);
	assert.equal(projection.details.workstreamId, "ws-context");
	assert.equal(projection.details.revision, 1);
	assert.deepEqual(projection.details.recentRelevantActivity.map((item) => item.eventId), ["relevant-2", "relevant-3", "relevant-4"]);
	assert.match(projection.guidance, /ws-context/);
	assert.match(projection.guidance, /Revision: 1/);
	assert.match(projection.guidance, /Ship the durable context handoff/);
	assert.match(projection.guidance, /Preserve transcript custom-entry authority/);
	assert.match(projection.guidance, /relevant-2|activity relevant-2/);
	assert.doesNotMatch(projection.guidance, /routine-1|routine-2/);
	assert.doesNotMatch(buildWorkstreamContextEnvelope(current) ?? "", /relevant-4|<activity|activity relevant-/);
});
