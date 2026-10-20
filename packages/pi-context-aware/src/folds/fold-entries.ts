/**
 * Session storage for native folds.
 *
 * A fold is stored in the session file, on the branch where it was made:
 *
 * - one `context_edit` entry that replaces the first covered entry (the
 *   carrier) with the fold summary;
 * - one `context_edit` entry per other covered entry, with a null replacement,
 *   so Pi omits it from model context;
 * - one custom entry of type {@link FOLD_ENTRY_TYPE} with the fold metadata.
 *
 * The original entries stay in the session file. Pi applies context edits along
 * the selected branch path only, so a fold follows the branch it was made on
 * through restart, `/tree` navigation and fork.
 */

import type {
	ContextEditEntryDraft,
	CustomEntryDraft,
	SessionBoundaryDraft,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { SUMMARY_HEADER } from "./kernel/prune.js";

export const FOLD_ENTRY_TYPE = "context-aware.fold.v1";

export type FoldTier = 1 | 2 | 3;

/** Where a fold came from: made in this session, or imported from a legacy side file. */
export type FoldOrigin = "fold" | "acp-import";

/** Metadata stored in the fold's custom entry. */
export interface FoldRecord {
	readonly version: 1;
	readonly blockId: string;
	readonly runId: string;
	readonly tier: FoldTier;
	readonly topic?: string;
	/** Entry whose model-visible content the summary replaces. */
	readonly carrierId: string;
	/** Covered entries omitted from model context, in branch order. */
	readonly hiddenIds: readonly string[];
	/** First and last covered entry, in branch order. */
	readonly range: { readonly startId: string; readonly endId: string };
	/** Message refs of the range ends when the fold was made. Empty when unknown. */
	readonly refs: { readonly start: string; readonly end: string };
	/** Earlier folds this fold absorbed. Only higher tiers absorb folds. */
	readonly directBlockIds: readonly string[];
	readonly compressedTokens: number;
	readonly createdAt: number;
	readonly origin: FoldOrigin;
	/**
	 * Id of the request that made this fold: the fold tool call id, or a
	 * per-item id derived from it. Absent on folds written before request ids
	 * existed, and on imported folds.
	 */
	readonly requestId?: string;
	/**
	 * Id of the billion-context-pi compress call that made an imported fold. The engine keeps
	 * that call visible, with its summaries cut to stubs, while the fold is active; calls of
	 * absorbed folds are hidden (pi-context-aware#186). Absent on native folds.
	 */
	readonly compressCallId?: string;
}

/** Longest request id the engine stores or compares. */
export const MAX_REQUEST_ID_LENGTH = 256;

/** The id when it can be a request id, otherwise undefined. */
export function cleanRequestId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH ? value : undefined;
}

/** Most items one fold tool call may carry: the item index in a request id has at most three digits. */
export const MAX_FOLD_ITEMS_PER_CALL = 1000;

/** Longest tool call id that still leaves room for `#<index>` (at most four characters) inside MAX_REQUEST_ID_LENGTH. */
export const MAX_CALL_ID_LENGTH = MAX_REQUEST_ID_LENGTH - 4;

const ITEM_INDEX = /^(?:0|[1-9]\d{0,2})$/u;

export type FoldRequestIdCheck =
	| { readonly ok: true; readonly callId: string; readonly index: number }
	| { readonly ok: false; readonly error: string };

/**
 * Check a request id of the form `<tool call id>#<item index>`. The index is
 * what follows the last `#`, so a call id may contain `#` itself. Every item
 * of a call has the suffix, even a call with one item, so two calls cannot
 * make the same id. A call id too long to leave room for the suffix is an
 * error, never a silent drop.
 */
export function checkFoldRequestId(id: unknown): FoldRequestIdCheck {
	if (typeof id !== "string" || id.length === 0) return { ok: false, error: "requestId must be a non-empty string of the form <tool call id>#<item index>." };
	const hash = id.lastIndexOf("#");
	if (hash < 0) return { ok: false, error: "requestId must end with #<item index>, for example call_1#0." };
	const index = id.slice(hash + 1);
	if (!ITEM_INDEX.test(index)) {
		return { ok: false, error: `The item index after the last # in requestId must be a number from 0 to ${MAX_FOLD_ITEMS_PER_CALL - 1} without leading zeros.` };
	}
	const callId = id.slice(0, hash);
	if (callId.length === 0) return { ok: false, error: "requestId has an empty tool call id before the #." };
	if (callId.length > MAX_CALL_ID_LENGTH) {
		return { ok: false, error: `The tool call id is ${callId.length} characters; at most ${MAX_CALL_ID_LENGTH} are supported so that the request id stays within ${MAX_REQUEST_ID_LENGTH}.` };
	}
	return { ok: true, callId, index: Number(index) };
}

/** The request id for item `index` of a fold tool call, or why there cannot be one. */
export function makeFoldRequestId(callId: string, index: number): { readonly ok: true; readonly requestId: string } | { readonly ok: false; readonly error: string } {
	const requestId = `${callId}#${index}`;
	const checked = checkFoldRequestId(requestId);
	return checked.ok ? { ok: true, requestId } : { ok: false, error: checked.error };
}

/** Model-visible text that replaces the carrier entry. */
export function renderFoldSummary(summary: string, topic?: string): string {
	const heading = topic ? `${SUMMARY_HEADER} — ${topic}` : SUMMARY_HEADER;
	const body = summary.trim();
	return body.length === 0 ? heading : `${heading}\n${body}`;
}

/** Every covered entry of a fold, carrier first. */
export function coveredEntryIds(record: FoldRecord): string[] {
	return [record.carrierId, ...record.hiddenIds];
}

/**
 * Boundary drafts that store one fold: the carrier edit, the hide edits, then
 * the metadata entry. Pi accepts them only from `turn_end` or
 * `agent_before_settle`.
 */
export function foldDrafts(record: FoldRecord, summaryText: string): SessionBoundaryDraft[] {
	const carrier: ContextEditEntryDraft = {
		type: "context_edit",
		targetId: record.carrierId,
		replacement: { content: summaryText },
	};
	const hidden = record.hiddenIds.map(
		(targetId): ContextEditEntryDraft => ({ type: "context_edit", targetId, replacement: null }),
	);
	const metadata: CustomEntryDraft = { type: "custom", customType: FOLD_ENTRY_TYPE, data: record };
	return [carrier, ...hidden, metadata];
}

/** True when Pi accepts a context edit for this entry. */
export function isEditableEntry(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") return true;
	if (entry.type !== "message") return false;
	const role = (entry.message as { role?: unknown } | null | undefined)?.role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

const BLOCK_ID = /^b[1-9]\d*$/u;
const RUN_ID = /^r[1-9]\d*$/u;

/**
 * Read fold metadata from a custom entry's data. Session files are not
 * trusted: anything that does not match the schema exactly is rejected, and
 * the returned record holds copies of the named fields only.
 */
export function readFoldRecord(data: unknown): FoldRecord | undefined {
	if (!isObject(data) || data.version !== 1) return undefined;
	const { blockId, runId, tier, topic, carrierId, hiddenIds, range, refs, directBlockIds } = data;
	if (typeof blockId !== "string" || !BLOCK_ID.test(blockId)) return undefined;
	if (typeof runId !== "string" || !RUN_ID.test(runId)) return undefined;
	if (tier !== 1 && tier !== 2 && tier !== 3) return undefined;
	if (topic !== undefined && typeof topic !== "string") return undefined;
	if (!isNonEmptyString(carrierId)) return undefined;
	if (!isStringArray(hiddenIds) || !hiddenIds.every(isNonEmptyString)) return undefined;
	if (!isObject(range) || !isNonEmptyString(range.startId) || !isNonEmptyString(range.endId)) return undefined;
	if (!isObject(refs) || typeof refs.start !== "string" || typeof refs.end !== "string") return undefined;
	if (!isStringArray(directBlockIds) || !directBlockIds.every((id) => BLOCK_ID.test(id))) return undefined;
	const covered = new Set([carrierId, ...hiddenIds]);
	if (covered.size !== hiddenIds.length + 1) return undefined;
	if (!covered.has(range.startId) || !covered.has(range.endId)) return undefined;
	const compressedTokens = nonNegativeNumber(data.compressedTokens);
	const createdAt = nonNegativeNumber(data.createdAt);
	const origin = data.origin === "acp-import" ? "acp-import" : data.origin === "fold" ? "fold" : undefined;
	if (compressedTokens === undefined || createdAt === undefined || origin === undefined) return undefined;
	// A bad id is dropped, not fatal: the fold itself is still valid and must stay in effect.
	const requestId = cleanRequestId(data.requestId);
	const compressCallId = cleanRequestId(data.compressCallId);
	return {
		version: 1,
		blockId,
		runId,
		tier,
		...(topic ? { topic } : {}),
		carrierId,
		hiddenIds: [...hiddenIds],
		range: { startId: range.startId, endId: range.endId },
		refs: { start: refs.start, end: refs.end },
		directBlockIds: [...directBlockIds],
		compressedTokens,
		createdAt,
		origin,
		...(requestId ? { requestId } : {}),
		...(compressCallId ? { compressCallId } : {}),
	};
}

/** Request ids of the folds on a branch. Folds without an id add nothing. */
export function foldRequestIdsOnBranch(branch: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const { record } of foldRecordsOnBranch(branch)) if (record.requestId) ids.add(record.requestId);
	return ids;
}

/** Copy of fold drafts whose metadata entry records the request id. */
export function stampRequestId(drafts: readonly SessionBoundaryDraft[], requestId: string): SessionBoundaryDraft[] {
	return drafts.map((draft): SessionBoundaryDraft => {
		if (draft.type !== "custom" || draft.customType !== FOLD_ENTRY_TYPE) return draft;
		const record = readFoldRecord(draft.data);
		return record ? { ...draft, data: { ...record, requestId } } : draft;
	});
}

/** Fold metadata entries on a branch, in path order, with the entry that holds each. */
export function foldRecordsOnBranch(
	branch: readonly SessionEntry[],
): { entryId: string; index: number; record: FoldRecord }[] {
	const found: { entryId: string; index: number; record: FoldRecord }[] = [];
	branch.forEach((entry, index) => {
		if (entry.type !== "custom" || entry.customType !== FOLD_ENTRY_TYPE) return;
		const record = readFoldRecord(entry.data);
		if (record) found.push({ entryId: entry.id, index, record });
	});
	return found;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
