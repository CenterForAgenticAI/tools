/**
 * The completion banner: what the overlay says when the work has finished.
 *
 * This exists because `autoCloseInspectorOnComplete` now defaults **off**.
 * Auto-close was designed for a side dock quietly getting out of the way. A
 * centered modal dismissing itself does the opposite: it takes a just-arrived
 * result off the screen at the exact moment you would read it. So the overlay
 * stays open and says it is done, and the banner carries the signal the
 * dismissal used to.
 *
 * The vocabulary is `succeeded` / `failed` / `aborted`, matching
 * `renderOutcomeSummary` in `status-widget.ts`. The same fact must not read
 * two ways depending on which surface shows it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { iconSet, type IconSet } from "./icons.js";

/** Terminal run-entry statuses, counted into the rollup. */
export interface OutcomeCounts {
	readonly succeeded: number;
	readonly failed: number;
	readonly aborted: number;
	/** Terminal but not done: the supervisor was forced to stop mid-work. */
	readonly paused: number;
}

/** What the banner needs to know. */
export interface CompletionModel {
	readonly counts: OutcomeCounts;
	/** Total terminal run entries; the banner says nothing when this is zero. */
	readonly total: number;
	/**
	 * True when anything ended badly. Drives the banner's tone: a run that
	 * failed should not read the same as one that succeeded.
	 */
	readonly degraded: boolean;
}

/**
 * Count terminal outcomes, or report nothing when the work is not finished.
 *
 * Two ways this used to lie, both found in review (OV3-COMPLETION-TRUTH):
 *
 * - `paused` was silently ignored rather than counted. `runtime.ts` defines it
 *   as terminal but explicitly NOT done — "the child is parked mid-work" — and
 *   requires every success gate to exclude it. A completed run entry beside a
 *   paused one rendered a clean `✓ complete`.
 * - A registered run with no entry yet contributes no statuses at all, so a
 *   session with one finished run and one still constructing read as complete.
 *
 * `constructing` counts runs that have registered but produced no entry. Any of
 * them, like any live run entry, means the work is not over and there is no banner.
 */
export function buildCompletion(
	statuses: readonly string[],
	constructing = 0,
): CompletionModel | undefined {
	let succeeded = 0;
	let failed = 0;
	let aborted = 0;
	let paused = 0;
	let live = 0;
	for (const status of statuses) {
		if (status === "completed") succeeded += 1;
		else if (status === "failed") failed += 1;
		else if (status === "aborted") aborted += 1;
		else if (status === "paused") paused += 1;
		else live += 1;
	}
	// Nothing is complete while a run entry is still running or a run has yet to
	// produce one.
	if (live > 0 || constructing > 0) return undefined;
	const total = succeeded + failed + aborted + paused;
	if (total === 0) return undefined;
	return {
		counts: { succeeded, failed, aborted, paused },
		total,
		degraded: failed + aborted + paused > 0,
	};
}

/**
 * The banner text, widest form that fits.
 *
 * Degrades by dropping detail rather than by truncating mid-word: a clipped
 * `succeeded 3 · fail…` loses the number that mattered.
 */
export function formatCompletionBanner(
	model: CompletionModel,
	width: number,
	marks: IconSet = iconSet("unicode"),
): string | undefined {
	if (width < 1) return undefined;
	const ascii = marks.mode === "ascii";
	const separator = ascii ? " | " : " \u00b7 ";
	const glyph = model.degraded ? marks.warning : marks.ok;
	const { succeeded, failed, aborted, paused } = model.counts;
	// `paused` is only named when it happened: it is a rarer outcome than the
	// other three and naming a zero would cost width every run to say nothing.
	const pausedFull = paused > 0 ? `${separator}paused ${paused}` : "";
	const pausedShort = paused > 0 ? `${separator}P ${paused}` : "";
	// Widest first. Every candidate states the same fact at less detail.
	const candidates = [
		`${glyph} complete${separator}succeeded ${succeeded}`
			+ `${separator}failed ${failed}${separator}aborted ${aborted}${pausedFull}`,
		`${glyph} complete${separator}S ${succeeded}${separator}F ${failed}`
			+ `${separator}A ${aborted}${pausedShort}`,
		`${glyph} complete`,
		glyph,
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= width) return candidate;
	}
	// Even the glyph does not fit; clip rather than overflow, because pi-tui's
	// Render.draw hard-asserts on an over-wide line.
	return truncateToWidth(candidates[candidates.length - 1]!, width, "");
}

/** Theme role for the banner, so a failure does not read as a success. */
export function completionTone(model: CompletionModel): "accent" | "warning" {
	return model.degraded ? "warning" : "accent";
}
