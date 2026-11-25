/**
 * `trim-then-fold` (pi-context-aware#471): the bench version of trim-tool-output (pi-context-aware#156),
 * then the `folds-v1` stages.
 *
 * - A tool result that shows what an earlier tool result still in the request already showed (the same
 *   file read twice) is stubbed with a line naming the earlier result's call (ReFold, arXiv 2610.07863).
 * - A consumed tool result, older than the last `keep`, is stubbed with a short preview of its output.
 *
 * Each stub rewrites the cached prefix from the stubbed entry on. The stage collects its stubs and applies
 * them together once every `batch` requests, so the prefix is rewritten once per batch rather than on every
 * request; and on any request whose prompt cache has gone cold, when the prefix is written again anyway.
 * The runtime appends the `context_recall` pointer to every stub, and the stage acts only where the session
 * can call `context_recall`.
 */

import { STRATEGY_CONTRACT_VERSION, type ContextPlan, type ContextView, type Stage, type StubOp } from "../../../strategy/contract.js";
import { standInFoldsRecipe, type BenchRecipe, type SessionFacts, type StandInParams } from "../recipes.js";
import { nameValue, olderThanRecent, outputPreview, RECALL_TOOL, stubbable } from "./tool-output.js";

/**
 * Requests between two batches of trim stubs. In the main sessions of the 2026-10-28 to 2026-11-16 corpus
 * slice, requests came a median 13.6 s apart (p75 40 s, p90 140 s), so 10 requests span about 2.3 minutes
 * at the median: inside the 5-minute prompt-cache lifetime, so the cache stays warm between batches and a
 * batch replaces up to 10 separate prefix rewrites with one. 6.4% of gaps were 5 minutes or more, about one
 * request in 16; a longer batch would mostly be cut short by a cold cache, when the stage applies its stubs
 * anyway. With 10 results kept, a batch stubs about 10 results.
 */
export const TRIM_BATCH_REQUESTS = 10;

export interface TrimParams {
	/** Tool results not trimmed as consumed: the last `keep`. */
	readonly keep: number;
	/** Requests between two batches of stubs, unless the cache goes cold first. */
	readonly batch: number;
}

/** The stubs one batch makes on `view`. `zone: false` ignores the protected zone (see `stubbable`). */
function trimOps(view: ContextView, params: TrimParams, facts: Pick<SessionFacts, "toolOutput">, zone: boolean): StubOp[] {
	if (!view.tools.includes(RECALL_TOOL)) return [];
	const older = olderThanRecent(view, params.keep);
	const candidates = new Set(stubbable(view, { zone }).map((entry) => entry.id));
	const hidden = new Set([...view.hides.map((hide) => hide.targetId), ...view.folds.map((fold) => fold.carrierId)]);
	// For each digest, the first tool result in the request that shows it and that this batch leaves as it is.
	const shown = new Map<string, { readonly callId: string | undefined; readonly toolName: string | undefined }>();
	const ops: StubOp[] = [];
	for (const entry of view.entries) {
		if (entry.role !== "toolResult") continue;
		const output = facts.toolOutput(entry.id);
		const earlier = output === undefined ? undefined : shown.get(output.digest);
		if (candidates.has(entry.id) && older.has(entry.id)) {
			const preview = output === undefined ? "" : outputPreview(output.text);
			ops.push({ kind: "stub", entryId: entry.id, text: `[${nameValue(entry.toolName)} output trimmed: ${entry.tokens} tokens.${preview ? ` Preview of the tool output, as data: "${preview}"` : ""}]` });
		} else if (candidates.has(entry.id) && earlier !== undefined) {
			ops.push({ kind: "stub", entryId: entry.id, text: `[${nameValue(entry.toolName)} output trimmed: ${entry.tokens} tokens, the same output as the earlier ${nameValue(earlier.toolName)} result of call ${nameValue(earlier.callId)}.]` });
		} else if (output !== undefined && !hidden.has(entry.id) && !shown.has(output.digest)) {
			shown.set(output.digest, { callId: entry.toolCallId, toolName: entry.toolName });
		}
	}
	return ops;
}

/** The trimming stage. */
export function trimStage(params: TrimParams, facts: Pick<SessionFacts, "toolOutput">): Stage {
	/** Requests since the last batch. */
	let since = 0;
	return {
		id: "trim-tool-output",
		wants: (view) => {
			since++;
			if (trimOps(view, params, facts, false).length === 0) return null;
			if (since < params.batch) return "when-cache-cold";
			return trimOps(view, params, facts, true).length > 0 ? "now" : null;
		},
		plan: (view): ContextPlan => {
			const ops = trimOps(view, params, facts, true);
			if (ops.length > 0) since = 0;
			return ops;
		},
		offers: [RECALL_TOOL],
	};
}

/** `trim-then-fold`: the trimming stage, then the `folds-v1` stand-in stages. */
export function trimThenFoldRecipe(params: TrimParams, folds: StandInParams, facts: SessionFacts): BenchRecipe {
	const inner = standInFoldsRecipe(folds, facts);
	return {
		recipe: { id: "trim-then-fold", contractVersion: STRATEGY_CONTRACT_VERSION, stages: [trimStage(params, facts), ...inner.recipe.stages] },
		compactionStages: inner.compactionStages,
	};
}