/**
 * `mask-then-fold` (pi-context-aware#471): observation masking, the control from the masking literature
 * (The Complexity Trap, arXiv 2508.21433), then the `folds-v1` stages.
 *
 * On every request, each tool result older than the last `keep` tool results is stubbed with a one-line
 * marker. The runtime appends the `context_recall` pointer to every stub. The stage acts only where the
 * session can call `context_recall`, so it never writes a hide the model could not recover.
 */

import { STRATEGY_CONTRACT_VERSION, type ContextPlan, type ContextView, type Stage, type ViewEntry } from "../../../strategy/contract.js";
import { standInFoldsRecipe, type BenchRecipe, type SessionFacts, type StandInParams } from "../recipes.js";
import { nameValue, olderThanRecent, RECALL_TOOL, stubbable } from "./tool-output.js";

export interface MaskParams {
	/** Tool results kept as they are: the last `keep`. */
	readonly keep: number;
}

/** The masking stage: a stub for every tool result older than the last `keep`. */
export function maskStage(params: MaskParams): Stage {
	const targets = (view: ContextView, zone: boolean): ViewEntry[] => {
		if (!view.tools.includes(RECALL_TOOL)) return [];
		const older = olderThanRecent(view, params.keep);
		return stubbable(view, { zone }).filter((entry) => older.has(entry.id));
	};
	return {
		id: "observation-mask",
		wants: (view) => (targets(view, false).length > 0 && targets(view, true).length > 0 ? "now" : null),
		plan: (view): ContextPlan => targets(view, true).map((entry) => ({ kind: "stub", entryId: entry.id, text: `[${nameValue(entry.toolName)} output masked: ${entry.tokens} tokens.]` })),
		offers: [RECALL_TOOL],
	};
}

/** `mask-then-fold`: the masking stage, then the `folds-v1` stand-in stages. */
export function maskThenFoldRecipe(params: MaskParams, folds: StandInParams, facts: SessionFacts): BenchRecipe {
	const inner = standInFoldsRecipe(folds, facts);
	return {
		recipe: { id: "mask-then-fold", contractVersion: STRATEGY_CONTRACT_VERSION, stages: [maskStage(params), ...inner.recipe.stages] },
		compactionStages: inner.compactionStages,
	};
}