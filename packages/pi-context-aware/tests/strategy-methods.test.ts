/**
 * Context methods (pi-context-aware#526): a session runs a list of methods, composed into one recipe. Expected stage
 * orders are literals: the default list must give the stages folds-v1 ran on main (growth nudge, pressure note,
 * model fold, seeded compaction), and ["compact"] those of compaction-only-v1 (pressure note, seeded compaction).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runRequestStages } from "../src/strategy-runtime/live/stage-loop.js";
import type { SummarizeEngine } from "../src/strategy-runtime/index.js";
import type { ContextView } from "../src/strategy/index.js";
import { composeRecipe, offeredTools } from "../src/strategy/live.js";
import { CONTEXT_METHODS, DEFAULT_METHODS, isContextMethod, methodSetId, parseMethodSetId, toMethodSet } from "../src/strategy/methods.js";

const set = (...methods: string[]) => {
	const parsed = toMethodSet(methods.filter(isContextMethod));
	assert.ok(parsed, methods.join(","));
	return parsed;
};
const stageIds = (methods: string[]) => composeRecipe(set(...methods), () => ({})).stages.map((stage) => stage.id);

test("the known methods are fold and compact, and the default runs both", () => {
	assert.deepEqual([...CONTEXT_METHODS], ["fold", "compact"]);
	assert.deepEqual([...DEFAULT_METHODS], ["fold", "compact"]);
	for (const name of ["fold", "compact"]) assert.equal(isContextMethod(name), true, name);
	for (const name of ["folds-v1", "compaction-only-v1", "Fold", " fold", "mask", "external/fold", "__proto__", "toString", ""]) assert.equal(isContextMethod(name), false, JSON.stringify(name));
});

test("the default list composes the stages folds-v1 ran, and [compact] those of compaction-only-v1", () => {
	assert.deepEqual(stageIds(["fold", "compact"]), ["growth-nudge", "pressure-note", "model-fold", "seeded-compaction"]);
	assert.deepEqual(stageIds(["compact"]), ["pressure-note", "seeded-compaction"]);
	assert.deepEqual(offeredTools(composeRecipe(set("fold", "compact"), () => ({}))), ["context_fold", "context_compact"]);
	assert.deepEqual(offeredTools(composeRecipe(set("compact"), () => ({}))), ["context_compact"]);
});

test("fold alone keeps the shared pressure note and offers no compaction; list order orders each method's stages within a phase", () => {
	assert.deepEqual(stageIds(["fold"]), ["growth-nudge", "pressure-note", "model-fold"]);
	assert.deepEqual(offeredTools(composeRecipe(set("fold"), () => ({}))), ["context_fold"]);
	assert.deepEqual(stageIds(["compact", "fold"]), ["growth-nudge", "pressure-note", "seeded-compaction", "model-fold"]);
});

test("a composed recipe's id names its methods, and the id reads back as the same list", () => {
	assert.equal(composeRecipe(set("fold", "compact"), () => ({})).id, "fold+compact");
	assert.equal(composeRecipe(set("compact"), () => ({})).id, "compact");
	assert.equal(methodSetId(set("compact", "fold")), "compact+fold");
	assert.deepEqual(parseMethodSetId("fold+compact"), ["fold", "compact"]);
	assert.deepEqual(parseMethodSetId("compact"), ["compact"]);
	for (const id of ["", "+", "fold+", "fold+fold", "folds-v1", "fold+mask", "fold compact", "FOLD"]) assert.equal(parseMethodSetId(id), null, JSON.stringify(id));
});

test("a method list must be non-empty with no method twice", () => {
	assert.equal(toMethodSet([]), null);
	assert.equal(toMethodSet(["fold", "fold"]), null);
	assert.deepEqual(toMethodSet(["compact", "fold"]), ["compact", "fold"]);
});

test("the composed default says the growth nudge, then the pressure note, as folds-v1 did", () => {
	const view: ContextView = {
		entries: [{ id: "u1", role: "user", tokens: 40, hint: null }],
		pressure: 0.5, unownedTokens: 0, cacheAgeMs: null, model: { id: "synthetic", contextWindow: 10_000 },
		tools: ["context_compact", "context_fold"], registeredTools: ["context_compact", "context_fold"], folds: [], hides: [], protectedEntryIds: [], compactionOwner: "self",
	};
	const noEngine: SummarizeEngine = () => ({ ok: false, refusals: [] });
	const signals = { growthNudge: { render: () => "Fold a range." }, pressureLine: { render: () => "WARN." } };
	assert.deepEqual(runRequestStages({ active: composeRecipe(DEFAULT_METHODS, () => signals), view, engine: noEngine }).says, ["Fold a range.", "WARN."]);
	assert.deepEqual(runRequestStages({ active: composeRecipe(set("compact"), () => signals), view, engine: noEngine }).says, ["WARN."]);
});
