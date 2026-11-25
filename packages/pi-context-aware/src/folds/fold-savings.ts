/**
 * Measured fold savings and their two costs, read from the session branch (pi-context-aware#414).
 *
 * - Savings: tokens the active folds keep out of every request. Each fold record stores
 *   `compressedTokens`, the tokens it hid when it was made; the summary that replaced them is
 *   counted from the carrier's replacement text as the fold wrote it. A higher-tier fold's
 *   `compressedTokens` includes the summaries of the folds it absorbed, counted on the carrier
 *   text each absorbed fold shows (heading and topic included), so that same count is subtracted
 *   from the folded total rather than counted as originals.
 * - Preprocessing cost: the output tokens Pi recorded (`usage.output`) on each assistant turn
 *   that called `context_fold`. This is the whole turn's output: the summary the model writes as
 *   the call's arguments, plus any reasoning and other tool calls in that turn. It is a measured
 *   number, where a count of the arguments alone would be an estimate that leaves out the
 *   reasoning spent writing the summary, so the status line names the turns, not the summaries.
 * - Recovery cost: the tokens of each successful `context_recall` result that returned a fold's
 *   originals (ref mode with a fold block id).
 *
 * The three are reported apart; savings never subtract either cost.
 */

import type { SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

import { FOLD_ENTRY_TYPE, readFoldRecord, type FoldRecord } from "./fold-entries.js";
import { defaultCountTokens } from "./kernel/tokenize.js";

/** The fold tool whose turns carry the summary-writing cost. */
export const FOLD_CALL_TOOL = "context_fold";
/** The recall tool whose fold results carry the recovery cost. */
export const RECALL_TOOL = "context_recall";

export interface FoldSavings {
	/** Tokens kept out of each request: `originalTokens - summaryTokens`, never below 0. */
	readonly tokens: number;
	/** Tokens the folds on this branch hid, from the records' `compressedTokens`, absorbed summaries excluded. */
	readonly originalTokens: number;
	/** Tokens of the active folds' summaries, counted on the text each fold wrote. */
	readonly summaryTokens: number;
	readonly activeFolds: number;
}

export interface FoldPreprocessingCost {
	/** Sum of `usage.output` on assistant turns that called context_fold. */
	readonly outputTokens: number;
	/** Assistant turns that called context_fold. */
	readonly calls: number;
	/** Of those, turns with no recorded output count; they add nothing to `outputTokens`. */
	readonly callsWithoutUsage: number;
}

export interface FoldRecoveryCost {
	/** Successful context_recall results that returned a fold's originals. */
	readonly recalls: number;
	/** Tokens of those results' text. */
	readonly tokens: number;
}

export interface FoldAccounting {
	readonly savings: FoldSavings;
	readonly preprocessing: FoldPreprocessingCost;
	readonly recovery: FoldRecoveryCost;
}

interface ContentPart { readonly type?: unknown; readonly text?: unknown; readonly name?: unknown }

function partsOf(content: unknown): readonly ContentPart[] {
	return Array.isArray(content) ? content.filter((part): part is ContentPart => typeof part === "object" && part !== null) : [];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return partsOf(content).flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function recordedOutput(usage: unknown): number | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const output = (usage as { output?: unknown }).output;
	return typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : undefined;
}

/** Savings, preprocessing cost and recovery cost of the folds on one branch. */
export function foldAccounting(branch: readonly SessionEntry[]): FoldAccounting {
	// The carrier's latest replacement text; a fold's own summary is the text in place when its record is written.
	const replacement = new Map<string, string>();
	// Newest record per block id: refolding in place keeps the id.
	const folds = new Map<string, { record: FoldRecord; summaryTokens: number }>();
	let foldOutput = 0;
	let foldCalls = 0;
	let foldCallsWithoutUsage = 0;
	const recallResults: { ref: string; tokens: number }[] = [];
	for (const entry of branch) {
		if (entry.type === "context_edit") {
			if (entry.replacement !== null) replacement.set(entry.targetId, textOf(entry.replacement.content));
			continue;
		}
		if (entry.type === "custom") {
			if (entry.customType !== FOLD_ENTRY_TYPE) continue;
			const record = readFoldRecord(entry.data);
			if (record) {
				folds.set(record.blockId, { record, summaryTokens: defaultCountTokens(replacement.get(record.carrierId) ?? "") });
			}
			continue;
		}
		// Session files are not trusted: a message entry without a message object adds nothing.
		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
		const message = entry.message as { role?: unknown; content?: unknown; usage?: unknown; toolName?: unknown; isError?: unknown; details?: unknown };
		if (message.role === "assistant") {
			if (!partsOf(message.content).some((part) => part.type === "toolCall" && part.name === FOLD_CALL_TOOL)) continue;
			foldCalls++;
			const output = recordedOutput(message.usage);
			if (output === undefined) foldCallsWithoutUsage++;
			else foldOutput += output;
		} else if (message.role === "toolResult" && message.toolName === RECALL_TOOL && message.isError !== true) {
			const details = typeof message.details === "object" && message.details !== null ? message.details as { mode?: unknown; ref?: unknown; error?: unknown } : undefined;
			if (details?.mode !== "ref" || typeof details.ref !== "string" || details.error !== undefined) continue;
			recallResults.push({ ref: details.ref, tokens: defaultCountTokens(textOf(message.content)) });
		}
	}
	const absorbed = new Set([...folds.values()].flatMap(({ record }) => record.directBlockIds));
	let originalTokens = 0;
	let summaryTokens = 0;
	let activeFolds = 0;
	for (const { record, summaryTokens: summary } of folds.values()) {
		originalTokens += record.compressedTokens;
		// An absorbed fold's summary is input to the fold above it, not original content, and no longer shown.
		// The fold above counted it on the carrier text as shown, heading included (fold-adapter's summaryById),
		// which is the text this fold's own summary count used, so the same count is subtracted.
		if (absorbed.has(record.blockId)) originalTokens -= summary;
		else { summaryTokens += summary; activeFolds++; }
	}
	originalTokens = Math.max(0, originalTokens);
	const recovered = recallResults.filter((result) => folds.has(result.ref));
	return {
		savings: { tokens: Math.max(0, originalTokens - summaryTokens), originalTokens, summaryTokens, activeFolds },
		preprocessing: { outputTokens: foldOutput, calls: foldCalls, callsWithoutUsage: foldCallsWithoutUsage },
		recovery: { recalls: recovered.length, tokens: recovered.reduce((sum, result) => sum + result.tokens, 0) },
	};
}

/**
 * Tokens the folds among `drafts` free (pi-context-aware#459): for each fold record, the tokens it hid when it was
 * made less the tokens of the summary that replaced them, counted as `foldAccounting` counts them, and never below
 * 0 per fold. A refold's hidden tokens include the summaries it absorbed, which were shown until then, so the
 * difference is what the view lost. Drafts that are not fold records are ignored.
 */
export function foldsFreedTokens(drafts: readonly SessionBoundaryDraft[]): number {
	const replacement = new Map<string, string>();
	let freed = 0;
	for (const draft of drafts) {
		if (draft.type === "context_edit") {
			if (draft.replacement !== null) replacement.set(draft.targetId, textOf(draft.replacement.content));
			continue;
		}
		if (draft.type !== "custom" || draft.customType !== FOLD_ENTRY_TYPE) continue;
		const record = readFoldRecord(draft.data);
		if (record) freed += Math.max(0, record.compressedTokens - defaultCountTokens(replacement.get(record.carrierId) ?? ""));
	}
	return freed;
}

const plural = (count: number, one: string, many: string) => count + " " + (count === 1 ? one : many);

/** The three status lines: savings, then each cost on its own line. */
export function formatFoldAccounting(accounting: FoldAccounting): string[] {
	const { savings, preprocessing, recovery } = accounting;
	return [
		"Fold savings: " + savings.tokens + " tokens per request from " + plural(savings.activeFolds, "active fold", "active folds")
			+ " (" + savings.originalTokens + " tokens folded, " + savings.summaryTokens + " tokens of summary).",
		"Preprocessing cost: " + preprocessing.outputTokens + " output tokens on "
			+ plural(preprocessing.calls, "assistant turn", "assistant turns") + " that called " + FOLD_CALL_TOOL + "."
			+ (preprocessing.callsWithoutUsage > 0 ? " " + preprocessing.callsWithoutUsage + " of them recorded no usage." : ""),
		"Recovery cost: " + recovery.tokens + " tokens returned by " + plural(recovery.recalls, RECALL_TOOL + " of folded content", RECALL_TOOL + " calls of folded content") + ".",
	];
}
