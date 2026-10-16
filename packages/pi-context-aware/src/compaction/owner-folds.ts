/**
 * The fold index handed to the summary model while the compaction-owner claim
 * is held.
 *
 * Pi builds the summary input from the folded view of the branch: a fold's
 * summary stands in for the entries it replaced. The model that writes the
 * summary cannot see the replaced entries, so this index names each active fold
 * with its topic, its range and its ref. The summary can then point the next
 * phase at a fold it needs again instead of losing it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldRecordsOnBranch, type FoldRecord } from "../folds/fold-entries.js";

/** The tool the next phase calls to read a folded range back. */
export const FOLD_RECALL_TOOL = "context_recall";

const MAX_INDEXED_FOLDS = 40;
const MAX_TOPIC_CHARS = 120;

function oneLine(value: string, max: number): string {
	const text = value.replace(/\s+/gu, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function activeFolds(branch: readonly SessionEntry[]): FoldRecord[] {
	const records = foldRecordsOnBranch(branch).map(({ record }) => record);
	const absorbed = new Set(records.flatMap((record) => record.directBlockIds));
	return records.filter((record) => !absorbed.has(record.blockId));
}

function foldLine(record: FoldRecord): string {
	const topic = record.topic ? oneLine(record.topic, MAX_TOPIC_CHARS) : "(no topic)";
	const refs = record.refs.start || record.refs.end ? ` messages ${record.refs.start || "?"} to ${record.refs.end || "?"},` : "";
	return `- ${record.blockId}: ${topic} —${refs} entries ${record.range.startId} to ${record.range.endId}`;
}

/**
 * Instruction text that lists the active folds, or undefined when the branch has
 * none. At most {@link MAX_INDEXED_FOLDS} folds are named, newest last, and the
 * rest are counted.
 */
export function renderFoldIndex(branch: readonly SessionEntry[] | undefined): string | undefined {
	if (!branch || branch.length === 0) return undefined;
	const folds = activeFolds(branch);
	if (folds.length === 0) return undefined;
	const shown = folds.slice(-MAX_INDEXED_FOLDS);
	const omitted = folds.length - shown.length;
	return [
		"Folded ranges: the conversation above shows these ranges as short fold summaries. The original text is still recoverable.",
		...shown.map(foldLine),
		...(omitted > 0 ? [`- ${omitted} older fold${omitted === 1 ? "" : "s"} not listed`] : []),
		`Where the next phase will need the detail of a fold, keep its fold id (for example ${shown[shown.length - 1]!.blockId}) in the summary and say it can be read back with ${FOLD_RECALL_TOOL}.`,
	].join("\n");
}
