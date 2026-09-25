/**
 * Overlay geometry — pure, total, and independent of rendering.
 *
 * The explorer redesign (epic #326, `.spec/tui-overlay-pattern.md`) gives the
 * overlay two panes: a persistent run-entry list on the left and the selected
 * run entry's detail on the right. Below a threshold width two panes stop being
 * worth their dividers, and the overlay collapses to the single-column
 * drill-down it had before.
 *
 * Every width decision lives here so the renderer never recomputes one, and so
 * the `visibleWidth(line) <= width` invariant has exactly one source of truth
 * to be tested against.
 */

/** Which pane currently owns keyboard input. */
export type OverlayPane = "list" | "detail";

/** Two panes side by side, or one column that drills. */
export type OverlayLayoutMode = "two-pane" | "single-column";

/**
 * Minimum inner width before two panes are worth it.
 *
 * At exactly this width the list takes its `LIST_MIN_WIDTH` floor of 28 and
 * the detail pane gets 61 columns — comfortably above the status widget's own
 * 56-column compact breakpoint, which is the narrowest width this project
 * already treats as legible for prose. Below it, a two-pane split would starve
 * the detail pane to prove a point.
 */
export const TWO_PANE_MIN_INNER_WIDTH = 90;

/** Share of the inner width the list takes before clamping. */
export const LIST_WIDTH_FRACTION = 0.3;

/** Floor: a narrower list truncates every run-entry identity it holds. */
export const LIST_MIN_WIDTH = 28;

/** Ceiling: past this the list is stealing width the transcript wants. */
export const LIST_MAX_WIDTH = 44;

/** Columns spent on the vertical divider between the panes. */
export const PANE_DIVIDER_WIDTH = 1;

/** Resolved geometry for one render pass. */
export interface OverlayGeometry {
	readonly mode: OverlayLayoutMode;
	/** Width inside the outer border. */
	readonly innerWidth: number;
	/** Left column width; `0` in single-column mode. */
	readonly listWidth: number;
	/** Detail pane width; equals `innerWidth` in single-column mode. */
	readonly detailWidth: number;
}

/**
 * Resolve the list width for an inner width already known to fit two panes.
 * Exported so a test can pin the clamp without constructing a whole geometry.
 */
export function resolveListWidth(innerWidth: number): number {
	const proportional = Math.round(innerWidth * LIST_WIDTH_FRACTION);
	return Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, proportional));
}

/**
 * Resolve geometry from the width available inside the overlay border.
 *
 * Total, including for absurd inputs: a non-finite or negative width resolves
 * to a single column of width 0 rather than throwing inside a render pass.
 */
export function resolveOverlayGeometry(innerWidth: number): OverlayGeometry {
	const width = Number.isFinite(innerWidth) ? Math.max(0, Math.floor(innerWidth)) : 0;
	if (width < TWO_PANE_MIN_INNER_WIDTH) {
		return { mode: "single-column", innerWidth: width, listWidth: 0, detailWidth: width };
	}
	const listWidth = resolveListWidth(width);
	return {
		mode: "two-pane",
		innerWidth: width,
		listWidth,
		detailWidth: width - listWidth - PANE_DIVIDER_WIDTH,
	};
}

/**
 * The level a single-column overlay is currently showing.
 *
 * Two panes render the list and one detail level at once, so `pane` alone says
 * where input goes. One column has to remember how deep it is instead. The
 * `rounds` level from the previous design is deliberately absent: rounds are
 * now separators inside the transcript.
 */
export type OverlayLevel = "list" | "summary" | "transcript";

/** Descend one level. `transcript` is the deepest; descending again is a no-op. */
export function descendLevel(level: OverlayLevel): OverlayLevel {
	if (level === "list") return "summary";
	if (level === "summary") return "transcript";
	return "transcript";
}

/**
 * Ascend one level. Returns `undefined` from `list`, which the caller reads as
 * "nothing left to leave — close the overlay".
 */
export function ascendLevel(level: OverlayLevel): OverlayLevel | undefined {
	if (level === "transcript") return "summary";
	if (level === "summary") return "list";
	return undefined;
}

/**
 * The detail level to render for `level`.
 *
 * The detail pane always shows something, so the `list` level — which means
 * "focus is on the inventory" — still renders the summary beside it. Naming
 * that rule once keeps every render path from re-deciding what an unfocused
 * detail pane should contain.
 */
export function detailLevelFor(level: OverlayLevel): Exclude<OverlayLevel, "list"> {
	return level === "transcript" ? "transcript" : "summary";
}

/**
 * What the overlay's body pane draws for one frame.
 *
 * `inventory` is the run list itself. Two panes never need it — the list is
 * already drawn beside the detail pane — so it exists for the single column,
 * where "the summary is shown beside the list" is not a thing that can be
 * true. Without it the `list` and `summary` levels rendered an identical
 * frame, which made `Enter` on a narrow terminal look like a dead key while it
 * silently changed what the arrows did.
 */
export type OverlayBodyKind = "inventory" | "summary" | "transcript";

/**
 * Resolve what the body pane draws from the layout and the current level.
 *
 * Two panes defer to `detailLevelFor`, which is still the rule for a pane
 * sitting next to a visible list. One column draws the list at the `list`
 * level and the detail below it, which is what "drill-down" means.
 */
export function bodyKindFor(mode: OverlayLayoutMode, level: OverlayLevel): OverlayBodyKind {
	if (mode === "single-column" && level === "list") return "inventory";
	return detailLevelFor(level);
}

/**
 * Descend from `level` in a given layout mode.
 *
 * In two panes, `Enter` on the list opens the transcript — the summary it would
 * otherwise step through is already visible beside it, so stopping there would
 * be a keystroke that changes nothing. One column keeps all three steps,
 * because there the summary is a screen you genuinely have not seen yet.
 */
export function descendLevelIn(mode: OverlayLayoutMode, level: OverlayLevel): OverlayLevel {
	if (mode === "single-column") return descendLevel(level);
	return "transcript";
}

/**
 * Ascend from `level` in a given layout mode, or `undefined` to close.
 *
 * Two panes have one step to give back: transcript returns to the summary,
 * which is the landing state. From there nothing is left to leave, so `Esc`
 * closes rather than moving to a `list` level that looks identical.
 */
export function ascendLevelIn(
	mode: OverlayLayoutMode,
	level: OverlayLevel,
): OverlayLevel | undefined {
	if (mode === "single-column") return ascendLevel(level);
	return level === "transcript" ? "summary" : undefined;
}

