/**
 * The live stage loop and the live recipes (pi-context-aware#472): only a stage's checked `say` reaches the
 * request (REQ-STRAT-008), shadow recipes are checked and recorded and never applied (REQ-STRAT-007), and
 * the fold method's nudge names only the context tools the view says the session can call (pi-context-aware#458).
 * Views are written out by hand; expected texts and records are literals.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runRequestStages } from "../src/strategy-runtime/live/stage-loop.js";
import type { SummarizeEngine } from "../src/strategy-runtime/index.js";
import { STRATEGY_CONTRACT_VERSION, type ContextView, type Recipe, type Stage } from "../src/strategy/index.js";
import { composeRecipe, offeredTools, type ContextToolsInView, type RequestSignals } from "../src/strategy/live.js";
import { DEFAULT_METHODS, toMethodSet } from "../src/strategy/methods.js";

const COMPACT = toMethodSet(["compact"])!;

function view(over: Partial<ContextView> = {}): ContextView {
	return {
		entries: [
			{ id: "u1", role: "user", tokens: 40, hint: null },
			{ id: "r1", role: "toolResult", tokens: 400, hint: null, toolName: "read", toolCallId: "c1" },
		],
		pressure: 0.5,
		unownedTokens: 0,
		cacheAgeMs: null,
		model: { id: "synthetic", contextWindow: 10_000 },
		tools: ["context_compact", "context_fold", "read"],
		registeredTools: ["context_compact", "context_fold", "context_recall", "read"],
		folds: [],
		hides: [],
		protectedEntryIds: [],
		compactionOwner: "self",
		...over,
	};
}

const noEngine: SummarizeEngine = () => ({ ok: false, refusals: [] });

const sayStage = (id: string, text: string): Stage => ({ id, wants: () => "now", plan: () => [], nudge: () => ({ kind: "say", text }), offers: [] });
const recipe = (id: string, stages: Stage[]): Recipe => ({ id, contractVersion: STRATEGY_CONTRACT_VERSION, stages });

/** A signal that renders like the kernel's nudge: it names each tool the stage passes. */
const naming = (seen: ContextToolsInView[] = []) => ({
	render(tools: ContextToolsInView) {
		seen.push(tools);
		const names = [tools.fold ? "`context_fold`" : "", tools.compact ? "`context_compact`" : ""].filter(Boolean);
		return names.length > 0 ? `Reduce context with ${names.join(" or ")}.` : undefined;
	},
});

test("REQ-STRAT-008: the active recipe's checked says come back in stage order, and nothing else reaches the request", () => {
	const run = runRequestStages({ active: recipe("r", [sayStage("one", "First note."), sayStage("two", "Second note.")]), view: view(), engine: noEngine });
	assert.deepEqual(run.says, ["First note.", "Second note."]);
	assert.deepEqual(run.records.map((record) => [record.stage, record.outcome]), [["one", "applied"], ["two", "applied"]]);
});

test("REQ-STRAT-008: a say naming a registered tool the session cannot call is refused and never injected", () => {
	const run = runRequestStages({
		active: recipe("r", [sayStage("bad", "Call `context_recall` now."), sayStage("good", "Keep going.")]),
		view: view(),
		engine: noEngine,
	});
	assert.deepEqual(run.says, ["Keep going."]);
	assert.deepEqual(run.records[0], { recipe: "r", role: "active", stage: "bad", timing: "now", ops: ["say"], outcome: "refused", codes: ["unreachable-tool"] });
});

test("REQ-STRAT-007: a shadow recipe runs on the same view; its plans are checked and recorded and never returned", () => {
	const run = runRequestStages({
		active: recipe("live", [sayStage("note", "Live note.")]),
		shadow: [recipe("other", [sayStage("loud", "Shadow note."), sayStage("bad", "Call `context_recall` now.")])],
		view: view(),
		engine: noEngine,
	});
	assert.deepEqual(run.says, ["Live note."], "a shadow say is never injected");
	assert.deepEqual(run.records.map((record) => [record.recipe, record.role, record.stage, record.outcome, record.codes]), [
		["live", "active", "note", "applied", []],
		["other", "shadow", "loud", "shadowed", []],
		["other", "shadow", "bad", "refused", ["unreachable-tool"]],
	]);
});

test("a stage that throws is recorded as failed and the stages after it still run; a stage that waits for a boundary is deferred", () => {
	const throwing: Stage = { id: "boom", wants: () => { throw new Error("stage bug"); }, plan: () => [], offers: [] };
	const later: Stage = { id: "later", wants: () => "at-boundary", plan: () => [{ kind: "say", text: "Not now." }], offers: [] };
	const run = runRequestStages({ active: recipe("r", [throwing, later, sayStage("after", "Still here.")]), view: view(), engine: noEngine });
	assert.deepEqual(run.says, ["Still here."]);
	assert.deepEqual(run.records.map((record) => [record.stage, record.timing, record.outcome]), [["boom", null, "failed"], ["later", "at-boundary", "deferred"], ["after", "now", "applied"]]);
});

test("the live loop applies only says on a request: a stage's stub passes the check and is recorded as unapplied", () => {
	const stub: Stage = { id: "mask", wants: () => "now", plan: () => [{ kind: "stub", entryId: "r1", text: "[read output masked]" }], offers: [] };
	const run = runRequestStages({ active: recipe("r", [stub]), view: view(), engine: noEngine });
	assert.deepEqual(run.says, []);
	assert.equal(run.records[0]!.outcome, "unapplied");
});

test("fold and compact: the growth nudge and the pressure note are its says, in that order, rendered for the tools the view can call", () => {
	const seen: ContextToolsInView[] = [];
	const signals: RequestSignals = { growthNudge: naming(seen), pressureLine: { render: () => "[context-aware extension, not user input] WARN." } };
	const run = runRequestStages({ active: composeRecipe(DEFAULT_METHODS, () => signals), view: view(), engine: noEngine });
	assert.deepEqual(run.says, ["Reduce context with `context_fold` or `context_compact`.", "[context-aware extension, not user input] WARN."]);
	assert.deepEqual(seen, [{ fold: true, compact: true }]);
	assert.deepEqual(run.records.map((record) => record.stage), ["growth-nudge", "pressure-note"]);
});

test("pi-context-aware#458: a Fabric child without context_fold gets no nudge naming it", () => {
	const child = view({ tools: ["read"] });
	const seen: ContextToolsInView[] = [];
	const run = runRequestStages({ active: composeRecipe(DEFAULT_METHODS, () => ({ growthNudge: naming(seen) })), view: child, engine: noEngine });
	assert.deepEqual(seen, [{ fold: false, compact: false }], "the stage asks for a nudge naming neither tool");
	assert.deepEqual(run.says, [], "with neither tool there is nothing to say");
	// A signal that names context_fold whatever it is asked is still refused by the reachable-tools rule.
	const stubborn = runRequestStages({ active: composeRecipe(DEFAULT_METHODS, () => ({ growthNudge: { render: () => "Fold with `context_fold` now." } })), view: child, engine: noEngine });
	assert.deepEqual(stubborn.says, []);
	assert.deepEqual(stubborn.records[0]!.codes, ["unreachable-tool"]);
});

test("both methods without a signal say nothing; compact alone has no growth nudge stage", () => {
	assert.deepEqual(runRequestStages({ active: composeRecipe(DEFAULT_METHODS, () => ({})), view: view(), engine: noEngine }), { says: [], records: [] });
	const only = runRequestStages({ active: composeRecipe(COMPACT, () => ({ growthNudge: naming(), pressureLine: { render: () => "URGENT." } })), view: view(), engine: noEngine });
	assert.deepEqual(only.says, ["URGENT."]);
	assert.deepEqual(offeredTools(composeRecipe(DEFAULT_METHODS, () => ({}))), ["context_fold", "context_compact"]);
	assert.deepEqual(offeredTools(composeRecipe(COMPACT, () => ({}))), ["context_compact"]);
});
