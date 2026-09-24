/**
 * Regression tests for the seed-preview width crash.
 *
 * pi-tui's `TuiMainScreen.doRender` throws when any rendered line is wider
 * than the terminal. The preview used to clamp its body and then append its
 * hint raw, and `... N more lines (ctrl+o to expand)` is 36 columns whatever
 * the terminal is — so a pane under about 38 columns killed the session as
 * soon as a preview skipped a line. It did so three times in ninety minutes,
 * at widths 29, 29 and 35, before it was diagnosed.
 *
 * These assert the property that was violated — no emitted line exceeds the
 * render width — rather than the shape of the current implementation, so a
 * future rewrite that reintroduces the crash still fails here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildPreviewLines, wrapPreviewHint } from "../preview-lines.js";

/**
 * Local width measurement. `@earendil-works/pi-tui` is not a dependency of
 * this package — only `pi-coding-agent` is, as a peer — so the width the TUI
 * would see is measured here rather than imported. Rendered lines can carry
 * colour and hyperlink escapes, and neither occupies a column.
 *
 * Scanned rather than matched with a regular expression: a pattern for escape
 * sequences necessarily contains control characters, which `no-control-regex`
 * rejects, and silencing that rule to measure widths in a width test would be
 * the wrong trade.
 */
const ESC = 0x1b;
const BEL = 0x07;
function visibleWidth(text: string): number {
	let width = 0;
	const characters = [...text];
	for (let index = 0; index < characters.length; index++) {
		if ((characters[index]?.codePointAt(0) ?? 0) !== ESC) {
			width += 1;
			continue;
		}
		// Skip to the end of the escape sequence. A CSI colour run ends at its
		// first letter; an OSC 8 hyperlink ends at BEL or a string terminator.
		index += 1;
		const introducer = characters[index];
		if (introducer === "]") {
			while (index < characters.length) {
				const code = characters[index]?.codePointAt(0) ?? 0;
				if (code === BEL) break;
				if (code === ESC && characters[index + 1] === "\\") {
					index += 1;
					break;
				}
				index += 1;
			}
			continue;
		}
		while (index < characters.length && !/[A-Za-z]/.test(characters[index] ?? "")) index += 1;
	}
	return width;
}

/** The exact hint text from the crash log, minus theme colour. */
const EXPAND_HINT = (skipped: number) => ` ... ${skipped} more lines (ctrl+o to expand)`;

/** The widths this actually crashed at, plus the boundary and comfortable ones. */
const WIDTHS = [20, 29, 35, 37, 38, 40, 80, 120];

function body(lines: number): string {
	return Array.from({ length: lines }, (_, index) => `body line ${index + 1}`).join("\n");
}

test("the hint alone is wider than the panes that crashed", () => {
	// If this ever stops being true the regression below is no longer
	// exercising an overflow, and the tests would silently go vacuous.
	assert.ok(
		visibleWidth(EXPAND_HINT(4)) > 29,
		`the expand hint must exceed a 29-column pane to reproduce the crash; got ${visibleWidth(EXPAND_HINT(4))}`,
	);
	assert.ok(visibleWidth(EXPAND_HINT(4)) > 35, "and a 35-column pane, the third crash width");
});

test("no emitted line exceeds the render width, at any width", () => {
	for (const width of WIDTHS) {
		const lines = buildPreviewLines({
			body: body(20),
			maxBodyLines: 3,
			width,
			hint: (skipped) => (skipped > 0 ? EXPAND_HINT(skipped) : ""),
		});
		assert.ok(lines.length > 0, `width ${width}: expected some output`);
		for (const [index, line] of lines.entries()) {
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: line ${index} is ${visibleWidth(line)} wide — this is the crash`,
			);
		}
	}
});

test("a wrapped hint keeps its head, not just its tail", () => {
	// truncateToVisualLines keeps the LAST n lines, so a finite cap here would
	// render "to expand)" with no indication of what expands.
	const wrapped = wrapPreviewHint(EXPAND_HINT(4), 29);
	assert.ok(wrapped.length > 1, "a 36-column hint must wrap at 29 columns");
	assert.match(wrapped[0] ?? "", /more lines|\.\.\./, `first line lost the head: ${JSON.stringify(wrapped)}`);
});

test("the hint is omitted entirely when nothing was skipped", () => {
	const lines = buildPreviewLines({
		body: body(2),
		maxBodyLines: 10,
		width: 80,
		hint: (skipped) => (skipped > 0 ? EXPAND_HINT(skipped) : ""),
	});
	assert.ok(
		!lines.some((line) => line.includes("more lines")),
		`nothing was skipped, so no hint belongs: ${JSON.stringify(lines)}`,
	);
});

test("an unconditional hint is still width-safe", () => {
	// The expanded view's "to collapse" hint ignores the skipped count.
	for (const width of WIDTHS) {
		const lines = buildPreviewLines({
			body: body(4),
			maxBodyLines: Number.MAX_SAFE_INTEGER,
			width,
			hint: () => " ctrl+o to collapse",
		});
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} wide`);
		}
	}
});

test("the body is still truncated to its line budget", () => {
	// Guard against 'fixing' the width crash by dropping the body clamp.
	const lines = buildPreviewLines({ body: body(50), maxBodyLines: 3, width: 80 });
	assert.equal(lines.length, 3, `expected the body clamped to 3 lines, got ${lines.length}`);
});
