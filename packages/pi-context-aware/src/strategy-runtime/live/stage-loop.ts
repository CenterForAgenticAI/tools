/**
 * The live stage loop (pi-context-aware#472, ADR 0002 decision 3). One loop serves both hooks; the trigger
 * says which:
 *
 * - `request` (the fold pass, every model request): ask each stage of the session's recipe whether it wants
 *   to act, take its plan and its nudge, check them with `checkPlan`, and return the accepted `say` texts.
 * - `compaction` (`session_before_compact`, and the `context_compact` tool before it queues one): the
 *   compaction a plan source asks for becomes a `summarize` plan for the stage that offers
 *   `context_compact`, checked before its summary is written. The runtime's writer writes the summary.
 *
 * Recipes in shadow run the same loop on the same view; their plans are checked and recorded, never
 * returned for applying (REQ-STRAT-007). The loop holds no writer. A stage that throws is recorded as
 * failed and changes nothing.
 */

import type { ContextView, PlanOp, Recipe, RefusalCode, StageTiming, SummaryWriter } from "../../strategy/contract.js";
import { COMPACT_TOOL } from "../../strategy/live.js";
import { checkPlan, type SummarizeEngine } from "../check-plan.js";

/**
 * What happened to one stage's plan on one request:
 * - `applied`: the active recipe's plan passed the check and its `say` effects are returned;
 * - `shadowed`: a shadow recipe's plan passed the check; nothing is applied;
 * - `refused`: the check refused it, with the codes;
 * - `deferred`: the stage wants a turn boundary or a cold cache, which a request does not run;
 * - `unapplied`: the active recipe's plan passed, but it holds `summarize` or `stub` operations, which the
 *   live loop does not apply on a request in this version;
 * - `failed`: the stage threw.
 */
export type StageOutcome = "applied" | "shadowed" | "refused" | "deferred" | "unapplied" | "failed";

export interface StageRecord {
	readonly recipe: string;
	readonly role: "active" | "shadow";
	readonly stage: string;
	readonly timing: StageTiming | null;
	readonly ops: readonly PlanOp["kind"][];
	readonly outcome: StageOutcome;
	readonly codes: readonly RefusalCode[];
}

export interface RequestStageRun {
	/** The active recipe's accepted `say` texts, in stage order. */
	readonly says: readonly string[];
	readonly records: readonly StageRecord[];
}

/** What starts the loop: a model request, or a compaction a plan source asked for over a range of the view. */
export type StageTrigger =
	| { readonly kind: "request" }
	| { readonly kind: "compaction"; readonly startId: string; readonly endId: string; readonly writer: Exclude<SummaryWriter, "plan"> };

export interface StageRun extends RequestStageRun {
	/**
	 * Compaction trigger only: `accepted` when the active recipe's compaction stage takes the plan and it
	 * passes every rule checked before a summary is written; `refused` when a rule refuses it; `no-stage`
	 * when the recipe offers no compaction.
	 */
	readonly compaction?: "accepted" | "refused" | "no-stage";
}

export interface RequestStageInput {
	readonly active: Recipe;
	readonly shadow?: readonly Recipe[];
	readonly view: ContextView;
	/** Plans a `summarize` on the session the view was built from; asked only when a plan holds one. */
	readonly engine: SummarizeEngine;
}

/** The request trigger of `runStages`. */
export function runRequestStages(input: RequestStageInput): RequestStageRun {
	const { says, records } = runStages({ ...input, trigger: { kind: "request" } });
	return { says, records };
}

export function runStages(input: RequestStageInput & { readonly trigger: StageTrigger }): StageRun {
	return input.trigger.kind === "request" ? requestLoop(input) : compactionLoop(input, input.trigger);
}

/**
 * The compaction trigger: each recipe's stage that offers `context_compact` takes the plan. Its summary is not
 * written yet, so `checkPlan` answers `summary-unwritten` for a plan every other rule lets through; that
 * answer alone accepts it, and any other refusal (one writer: another owner holds the compaction claim)
 * refuses it.
 */
function compactionLoop({ active, shadow = [], view, engine }: RequestStageInput, trigger: Extract<StageTrigger, { kind: "compaction" }>): StageRun {
	const records: StageRecord[] = [];
	let compaction: StageRun["compaction"] = "no-stage";
	const plan: readonly PlanOp[] = [{ kind: "summarize", startId: trigger.startId, endId: trigger.endId, writer: trigger.writer }];
	for (const [recipe, role] of [[active, "active"] as const, ...shadow.map((recipe) => [recipe, "shadow"] as const)]) {
		const stage = recipe.stages.find((candidate) => candidate.offers.includes(COMPACT_TOOL));
		if (!stage) continue;
		const check = checkPlan(view, plan, engine, { compaction: true });
		const codes = check.ok ? [] : [...new Set(check.refusals.map((refusal) => refusal.code))];
		const accepted = codes.every((code) => code === "summary-unwritten");
		const outcome: StageOutcome = !accepted ? "refused" : role === "shadow" ? "shadowed" : "applied";
		records.push({ recipe: recipe.id, role, stage: stage.id, timing: "at-boundary", ops: ["summarize"], outcome, codes: accepted ? [] : codes });
		if (role === "active") compaction = accepted ? "accepted" : "refused";
	}
	return { says: [], records, compaction };
}

function requestLoop({ active, shadow = [], view, engine }: RequestStageInput): StageRun {
	const says: string[] = [];
	const records: StageRecord[] = [];
	for (const [recipe, role] of [[active, "active"] as const, ...shadow.map((recipe) => [recipe, "shadow"] as const)]) {
		for (const stage of recipe.stages) {
			const record = (timing: StageTiming | null, ops: readonly PlanOp["kind"][], outcome: StageOutcome, codes: readonly RefusalCode[] = []) =>
				records.push({ recipe: recipe.id, role, stage: stage.id, timing, ops, outcome, codes });
			let timing: StageTiming | null = null;
			try {
				timing = stage.wants(view);
				if (timing === null) continue;
				if (timing !== "now") {
					record(timing, [], "deferred");
					continue;
				}
				const nudge = stage.nudge?.(view) ?? null;
				const plan: readonly PlanOp[] = nudge ? [...stage.plan(view), nudge] : stage.plan(view);
				if (plan.length === 0) continue;
				const ops = plan.map((op) => op.kind);
				const check = checkPlan(view, plan, engine);
				if (!check.ok) {
					record(timing, ops, "refused", [...new Set(check.refusals.map((refusal) => refusal.code))]);
					continue;
				}
				if (role === "shadow") {
					record(timing, ops, "shadowed");
					continue;
				}
				if (check.effects.some((effect) => effect.kind !== "say")) {
					record(timing, ops, "unapplied");
					continue;
				}
				for (const effect of check.effects) if (effect.kind === "say") says.push(effect.text);
				record(timing, ops, "applied");
			} catch {
				record(timing, [], "failed");
			}
		}
	}
	return { says, records };
}
