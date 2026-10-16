/**
 * Context-size views for compaction decisions.
 *
 * Pi reports `tokens: null` after a compaction or an overflow recovery, until a
 * reply carries usage. That state is its own variant, so a decision that needs
 * a size must narrow to a measured view first and cannot read an unknown size
 * as an empty context (issues #163, #165, #168).
 */

import type { WorkerCompactionTurnPressure } from "./worker-compaction-contract.js";

/** A size Pi measured. */
export interface MeasuredUsageView {
	tokens: number;
	window: number;
	fraction: number;
	headroom: number;
	unmeasured?: false;
}

/** Pi has not measured the size; `tokens` holds only the pending estimate. */
export interface UnmeasuredUsageView {
	tokens: number;
	window: number;
	fraction: number;
	headroom: number;
	unmeasured: true;
}

export type UsageView = MeasuredUsageView | UnmeasuredUsageView;

/**
 * Build a view from Pi's reported size. `additionalTokens` adds a pending
 * estimate, such as a prompt Pi has not appended yet.
 */
export function usageView(
	reportedTokens: number | null | undefined,
	window: number,
	additionalTokens = 0,
): UsageView {
	const tokens = (reportedTokens ?? 0) + Math.max(0, additionalTokens);
	const sized = { tokens, window, fraction: tokens / window, headroom: Math.max(0, window - tokens) };
	return reportedTokens == null ? { ...sized, unmeasured: true } : sized;
}

/** The view when Pi measured it, otherwise `null`. */
export function measuredUsage(u: UsageView | null | undefined): MeasuredUsageView | null {
	return u && u.unmeasured !== true ? u : null;
}

/** Whether a compaction is needed, or `unknown` when nothing measured the size. */
export type ContextPressureVerdict = "over" | "under" | "unknown";

/**
 * Compare a view with the proactive threshold and the generation reserve.
 * A missing or unmeasured size is `unknown`, never `under`.
 */
export function contextPressureVerdict(
	u: UsageView | null | undefined,
	thresholdFraction: number,
	generationSafe: (measured: MeasuredUsageView) => boolean,
): ContextPressureVerdict {
	const measured = measuredUsage(u);
	if (!measured) return "unknown";
	return measured.fraction >= thresholdFraction || !generationSafe(measured) ? "over" : "under";
}

/**
 * The size fields of a worker turn's pressure record. An unmeasured size
 * carries neither `usage` nor `generationSafe`, so the record never claims an
 * unknown size is safe (#163, #168).
 */
export function workerTurnSizeFields(
	u: UsageView | null | undefined,
	generationSafe: (measured: MeasuredUsageView) => boolean,
): Pick<WorkerCompactionTurnPressure, "generationSafe" | "usage"> {
	const measured = measuredUsage(u);
	if (!measured) return {};
	return {
		generationSafe: generationSafe(measured),
		usage: { tokens: measured.tokens, contextWindow: measured.window, fraction: measured.fraction },
	};
}
