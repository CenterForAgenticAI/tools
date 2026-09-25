/**
 * The summary level: every delegate in the session on one screen.
 *
 * ## What this replaces
 *
 * The summary level used to render exactly one run entry — whichever the list had
 * selected — in a pane wide enough for several. Selecting a different run entry
 * replaced the screen wholesale, so comparing two delegates meant flipping
 * between them and holding the first in your head.
 *
 * The stack shows all of them at once. The list column still owns selection;
 * this decides how much of each summary that selection buys.
 *
 * ## The accordion rule
 *
 * One summary in full is 15–25 lines and the pane is 20–40 rows, so three
 * delegates at full detail cannot fit and something has to give. The selected
 * one expands to everything it said before; the rest collapse to a card of a
 * few lines. Moving the selection expands the new block and collapses the old,
 * which keeps the total roughly constant as the session grows.
 *
 * A card is deliberately not "the first N lines of the full summary". It
 * carries the facts you scan across delegates — is it moving, how far in, what
 * is it doing — and drops the ones you only read once you have picked one to
 * look at, like the heartbeat policy and the latest exchange.
 *
 * ## Structure, not text
 *
 * This module returns blocks with tone-tagged segments; the overlay turns them
 * into themed strings. Keeping colour out means the layout can be tested
 * without a theme, and the wrapping stays measurable in plain characters.
 */

/** Colour role for a rendered segment, resolved by the caller's theme. */
export type StackTone = "text" | "dim" | "accent" | "muted" | "warning" | "success" | "error";

/** One line of a block, before the theme is applied. */
export interface StackLine {
	readonly text: string;
	readonly tone: StackTone;
	readonly bold?: true;
	/**
	 * Indent applied inside the block, in spaces. Carried separately from the
	 * text so the gutter can be prepended without re-parsing leading spaces.
	 */
	readonly indent?: number;
}

/** One delegate's entry in the stack. */
export interface StackBlock {
	/** Index into the overlay's list rows, so selection can be resolved back. */
	readonly listIndex: number;
	/** Rendered in full rather than as a card. */
	readonly selected: boolean;
	readonly lines: readonly StackLine[];
}

/** A run heading, mirroring the one the list column draws. */
export interface StackHeading {
	readonly kind: "heading";
	readonly text: string;
}

export type StackEntry = StackHeading | ({ readonly kind: "block" } & StackBlock);

/**
 * The gutter drawn down the left of the selected block.
 *
 * Colour alone cannot carry selection: the overlay is used over SSH on
 * terminals with unpredictable palettes, and a reader who cannot distinguish
 * accent from text would have no cue at all. The bar is structural, so it
 * survives any palette.
 *
 * A half-block (`▌`) rather than a box-drawing line (`│`), for two reasons.
 * It reads as a highlight bar instead of a pane border, which is what it is —
 * and the box-drawing character is already the overlay's pane divider, so
 * using it here made a single-column render indistinguishable from a two-pane
 * one to anything counting dividers. The README contract test counts exactly
 * that, and caught it.
 */
export const SELECTED_GUTTER = "\u258c";
/** ASCII fallback, for a terminal that cannot draw the half-block. */
export const SELECTED_GUTTER_ASCII = "|";
/** Width of the gutter column, including its trailing space. */
export const GUTTER_WIDTH = 2;

/**
 * Prefix every line of a block with its gutter column.
 *
 * Unselected blocks get blank space of the same width, so text starts at the
 * same column throughout the stack and the bar reads as a mark on one block
 * rather than an indent change.
 */
export function gutterFor(selected: boolean, ascii = false): string {
	if (!selected) return "  ";
	return `${ascii ? SELECTED_GUTTER_ASCII : SELECTED_GUTTER} `;
}
