/**
 * Width-safe line assembly for the seed-preview component.
 *
 * This exists because of a real crash. pi-tui's `TuiMainScreen.doRender`
 * throws when any rendered line is wider than the terminal, and the preview
 * used to truncate its body to the render width and then append its hint
 * raw. `... N more lines (ctrl+o to expand)` is 36 columns whatever the
 * terminal is, so a pane narrower than about 38 columns killed the session as
 * soon as a preview skipped a line. It happened three times in ninety minutes
 * at widths 29, 29 and 35 before it was diagnosed.
 *
 * The body was never the problem, so the fix is not "truncate harder": it is
 * that EVERY line the component emits must go through the same width-aware
 * wrapper, hints included. Keeping that rule in one exported function is what
 * makes it testable — the component itself lives inline in `index.ts`, where a
 * regression could only be caught by rendering the whole extension.
 */

import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";

/**
 * Wrap one hint to the render width.
 *
 * `Number.MAX_SAFE_INTEGER` is deliberate: `truncateToVisualLines` keeps the
 * LAST `maxVisualLines` lines, so any finite cap would show a wrapped hint's
 * tail and silently drop its head — `to expand)` with no idea what expands.
 * Wrapping to two short lines is the honest rendering at a narrow width.
 */
export function wrapPreviewHint(hint: string, width: number): string[] {
	return truncateToVisualLines(hint, Number.MAX_SAFE_INTEGER, width, 0).visualLines;
}

/**
 * Assemble the preview's lines: body first, then any hint, all width-safe.
 *
 * `bodyPadding` matches what the component passes for its body (1, for a plain
 * container). Hints carry their own leading space and so take padding 0, which
 * keeps their rendering byte-identical to before the fix at ordinary widths.
 */
export function buildPreviewLines(args: {
	readonly body: string;
	readonly maxBodyLines: number;
	readonly width: number;
	readonly hint?: ((skippedCount: number) => string) | undefined;
	readonly bodyPadding?: number;
}): string[] {
	const { body, maxBodyLines, width, hint, bodyPadding = 1 } = args;
	const result = truncateToVisualLines(body, maxBodyLines, width, bodyPadding);
	if (!hint) return [...result.visualLines];
	// A hint that names a skipped count is only meaningful when something was
	// skipped; an unconditional hint (such as "to collapse") passes 0 through
	// and decides for itself.
	return [...result.visualLines, ...wrapPreviewHint(hint(result.skippedCount), width)];
}
