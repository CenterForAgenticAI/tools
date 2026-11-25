/**
 * What a metrics record says about the session's strategy (pi-context-aware#473, pi-context-aware#526, REQ-STRAT-007):
 * the methods, where they came from, the shadow method lists, the guidance, each stage's outcome on the request (applied, shadowed, refused with codes), and
 * the recalls by reference. Expected records are literals.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerMetricsRecorder, DEFAULT_METRICS_SETTINGS } from "../src/metrics/recorder.js";
import { buildMetricsRecord, MAX_RECORDED_STAGES, METRICS_RECORD_VERSION, type MetricsRecord } from "../src/metrics/records.js";
import { requestPressure } from "../src/folds/request-pressure.js";
import type { FoldTurnResult } from "../src/folds/fold-turn.js";

const CANARY = "CANARY-STRAT-4471";
const ctx = (sessionId = "sess-1") => ({ sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf", getBranch: () => [] }, model: { id: "m", contextWindow: 1000 } }) as unknown as ExtensionContext;
const turn = { messages: [], sources: [], dropped: [], tokens: { before: 500, after: 400 } } as unknown as FoldTurnResult;
const pressure = requestPressure({ tokens: 500, window: 1000, measured: true, source: "fold-pass" });

function recorder() {
	const written: MetricsRecord[] = [];
	const rec = registerMetricsRecorder({ agentDir: () => "/unused", settings: () => DEFAULT_METRICS_SETTINGS, write: async (_dir, record) => { written.push(record); } });
	return { rec, written };
}

const assigned = { strategy: { methods: ["fold", "compact"] as const, source: "strategy.methods" as const, shadow: [["compact"] as const], guidance: "default" as const }, steer: "default" as const };

test("the record version is 4 (pi-context-aware#459)", () => {
	assert.equal(METRICS_RECORD_VERSION, 4);
});

test("a record names the methods, their source, the shadow lists and the guidance, and each stage's outcome; shadow outcomes stay apart from applied ones", async () => {
	const { rec, written } = recorder();
	const c = ctx();
	rec.observers.onTurn?.(c, turn, pressure, false, {
		...assigned,
		stages: [
			{ trigger: "request", recipe: "fold+compact", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] },
			{ trigger: "request", recipe: "fold+compact", role: "active", stage: "pressure-note", outcome: "refused", codes: ["unreachable-tool"] },
			{ trigger: "request", recipe: "compact", role: "shadow", stage: "pressure-note", outcome: "shadowed", codes: [] },
		],
	});
	// A compaction a plan source asked for after the request belongs to its record, as a fold does.
	rec.observers.onStages?.(c, [{ trigger: "compaction", recipe: "fold+compact", role: "active", stage: "seeded-compaction", outcome: "refused", codes: ["owner-claimed"] }]);
	rec.noteRecall(c, "fold");
	rec.noteRecall(c, "fold");
	rec.noteRecall(c, "hide");
	rec.observers.onTurn?.(c, turn, pressure, false, { ...assigned, stages: [], steer: "default" });
	await rec.flush();
	assert.equal(written.length, 2);
	const [first, second] = written;
	assert.equal(first!.v, 4);
	assert.deepEqual(first!.strategy, { methods: ["fold", "compact"], source: "strategy.methods", shadow: [["compact"]], guidance: "default" });
	assert.deepEqual(first!.stages, [
		{ trigger: "request", recipe: "fold+compact", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] },
		{ trigger: "request", recipe: "fold+compact", role: "active", stage: "pressure-note", outcome: "refused", codes: ["unreachable-tool"] },
		{ trigger: "request", recipe: "compact", role: "shadow", stage: "pressure-note", outcome: "shadowed", codes: [] },
		{ trigger: "compaction", recipe: "fold+compact", role: "active", stage: "seeded-compaction", outcome: "refused", codes: ["owner-claimed"] },
	]);
	assert.deepEqual(first!.recalls, { folds: 2, hides: 1 });
	assert.deepEqual(second!.stages, [], "stages and recalls reset after each record");
	assert.deepEqual(second!.recalls, { folds: 0, hides: 0 });
	assert.deepEqual(second!.strategy, { methods: ["fold", "compact"], source: "strategy.methods", shadow: [["compact"]], guidance: "default" });
});

test("a request with no strategy report records strategy null and no stages", async () => {
	const { rec, written } = recorder();
	rec.observers.onTurn?.(ctx(), turn, pressure, false);
	await rec.flush();
	assert.equal(written[0]!.strategy, null);
	assert.deepEqual(written[0]!.stages, []);
});

test("ids, roles, outcomes and codes outside the closed lists do not reach the record", () => {
	const hostile = `${CANARY}\nError: forged\u001b[2J`;
	const record = buildMetricsRecord({
		seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} },
		strategy: { methods: [`external/${CANARY}`, "fold", ...Array.from({ length: 20 }, () => "compact")], source: hostile, shadow: [[hostile], ["compact"], ...Array.from({ length: 20 }, () => ["fold"])], guidance: hostile },
		stages: [
			{ trigger: hostile, recipe: hostile, role: hostile, stage: hostile, outcome: hostile, codes: [hostile, "split-pair", ...Array.from({ length: 20 }, (_, i) => `${CANARY}-${i}`)] },
		],
		recalls: { folds: -3, hides: Number.NaN },
	});
	const raw = JSON.stringify(record);
	assert.equal(raw.includes(CANARY), false, "no id read from outside the closed lists is written");
	assert.equal(raw.includes("\\u001b") || raw.includes("\u001b"), false);
	assert.deepEqual(record.strategy, {
		methods: ["other", "fold", "compact", "compact", "compact", "compact", "compact", "compact"],
		source: "other",
		shadow: [["other"], ["compact"], ["fold"], ["fold"], ["fold"], ["fold"], ["fold"], ["fold"]],
		guidance: "other",
	});
	assert.deepEqual(record.stages, [{ trigger: "other", recipe: "other", role: "other", stage: "other", outcome: "other", codes: ["other", "split-pair"] }]);
	assert.deepEqual(record.recalls, { folds: 0, hides: 0 });
});

test("a stage's recipe is written only as a method set id; a recipe id of the earlier versions or a forged set is other", () => {
	const at = (recipe: string) => buildMetricsRecord({ seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, stages: [{ trigger: "request", recipe, role: "active", stage: "growth-nudge", outcome: "applied", codes: [] }] }).stages[0]!.recipe;
	assert.equal(at("fold+compact"), "fold+compact");
	assert.equal(at("compact"), "compact");
	assert.equal(at("compact+fold"), "compact+fold");
	for (const recipe of ["folds-v1", "fold+fold", "fold+", "fold+mask", "external/fold", `fold+${CANARY}`]) assert.equal(at(recipe), "other", recipe);
});

test("a request's stages are capped, and the record counts the ones it left out", () => {
	const stage = { trigger: "request", recipe: "fold+compact", role: "active", stage: "growth-nudge", outcome: "applied", codes: [] };
	const record = buildMetricsRecord({ seq: 1, at: new Date(0), sessionId: "s", folds: { requested: 0, accepted: 0, refused: {}, dropped: {} }, stages: Array.from({ length: MAX_RECORDED_STAGES + 5 }, () => stage) });
	assert.equal(MAX_RECORDED_STAGES, 32);
	assert.equal(record.stages.length, 32);
	assert.equal(record.stagesOmitted, 5);
});
