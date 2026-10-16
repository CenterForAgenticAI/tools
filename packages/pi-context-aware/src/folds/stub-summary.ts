/**
 * Refuse fold summaries that are a copy of a shortened earlier summary.
 *
 * billion-context-pi shows each earlier compress call to the model with its
 * summary cut to 199 characters plus "…" (`SUMMARY_STUB_CHARS` in
 * `kernel/hide-consumed.ts`). Models copy that shape into new calls: in recorded
 * fabric sessions, 216 of 1,977 tier-1 summaries ended in "…", most of them
 * 193 to 210 characters long. The engine accepts them because its minimum
 * summary length is 50, so the folded range survives as one cut-off line
 * (pi-context-aware#173). The kernel copy stays verbatim, so the adapter
 * refuses the shape before planning. It also refuses a copy of the block
 * pointer that the native engine shows in place of an earlier summary
 * (fold-call-render.ts).
 */

import { isFoldPointer } from "./fold-call-render.js";

/** Prefix of the refusal error, so fold parity can classify the refusal without keeping the text. */
export const STUB_SUMMARY_CODE = "stub-summary";

/**
 * Longest trimmed summary that counts as cut off when it ends in "…": the
 * kernel's copies are 199 characters plus "…", or one less when the cut would
 * split a surrogate pair. A longer summary that ends in "…" may fold.
 */
export const STUB_SUMMARY_MAX_CHARS = 200;

const ELLIPSIS = "\u2026";

const ADVICE = "Write the complete summary for this range: decisions, file paths, errors and open work.";

/** The refusal error for a cut-off summary or a copied pointer, or undefined when the summary may fold. */
export function stubSummaryError(summary: string): string | undefined {
	if (isFoldPointer(summary)) {
		return `[${STUB_SUMMARY_CODE}] This summary is a block pointer copied from an earlier fold call, not a summary. Folding with it would replace the range with this one line. ${ADVICE}`;
	}
	const trimmed = summary.trimEnd();
	if (trimmed.length > STUB_SUMMARY_MAX_CHARS || !trimmed.endsWith(ELLIPSIS)) return undefined;
	return `[${STUB_SUMMARY_CODE}] This summary is ${trimmed.length} characters and ends in "${ELLIPSIS}", so it looks cut off, like a shortened copy of an earlier summary. Folding with it would replace the range with this one line. ${ADVICE}`;
}
