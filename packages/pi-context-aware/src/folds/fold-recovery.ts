/**
 * Restart recovery for accepted fold requests, and the check every queued fold
 * passes before it is written.
 *
 * A durable worker can save a fold tool's result and die before the fold
 * engine's in-memory queue is drained. The resumed run has the result but no
 * fold. To recover, `FoldEngine.request` returns a `recovery` record with every
 * accepted request that has an id. The fold tool puts that record in its tool
 * result `details`, which Pi saves on the toolResult message. At
 * `session_start` and after a tree navigation this module reads those records
 * back from the current branch.
 *
 * Nothing is read from tool-call arguments. The record is made by the engine
 * from the plan it accepted, so it holds the immutable session entry ids of the
 * range, the exact entries the fold would hide, a digest of the source the
 * summary was written over, and the branch leaf the request was made on. Message refs (`mNNNNN`) are not stored, because other
 * tools number them differently and they shift when the branch changes. A
 * request the engine refused has no record, so it is never folded later.
 *
 * The invariant: a fold is written only (a) to the branch it was accepted on
 * and (b) over exactly the source it was accepted over, meaning the same
 * covered entry ids and the same content for any fold those entries already
 * belong to. `replanAcceptedFold` is the one place that checks this, for live
 * and for recovered requests alike.
 *
 * Session files are not trusted: every field is copied by name and anything
 * malformed is skipped. A bad entry never stops the scan of the others, and
 * the scan has explicit limits (see the MAX_RECOVERY_* constants).

 *
 * Contract for the fold tool:
 *
 * - Pass `requestId: "<tool call id>#<item index>"` for every item and call
 *   `FoldEngine.request` from the tool's `execute`. Save the `recovery` record of
 *   every accepted item in the tool result `details` with
 *   `foldRequestDetails`, and return the result with `isError` false. A result
 *   with `isError: true` is never read back.
 * - Running the same tool call again (a durable worker replays it) sends the
 *   same requestIds. That is a replay, not a new request. With the same refs,
 *   summary and topic the engine returns `ok: true, replayed: true`: the
 *   existing `recovery` record while the fold is queued, or the written block ids
 *   once it is written; nothing new is queued or written. If the replay would
 *   cover other entries or content than the first run accepted (a later fold
 *   took part of the range, or a block summary changed), it returns
 *   `ok: false` with `code: "coverage-changed"` or `"source-changed"`. The tool
 *   must report that error to the model, not retry with another id.
 * - A fold is written only to the branch it was accepted on. After a tree
 *   navigation (`session_tree`) the queue is rebuilt from the records on the
 *   new branch; a request accepted on another branch is not carried over. At
 *   the drain the branch must still hold the leaf the request was made on, and
 *   for a recovered request its tool result too; entries appended after the
 *   leaf on the same branch do not matter (pi-context-aware#176).
 *   Requests that were not written are listed by `FoldEngine.dropped` with a
 *   `code`: `entry-missing`, `coverage-changed`, `source-changed`,
 *   `branch-changed`, `refused`, `plan-failed` or `too-large`.
 * - A request with an id may cover at most MAX_RECOVERY_COVERED_IDS_PER_RECORD
 *   entries; a larger one is refused with `code: "too-large"`.
 */

import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { foldStateFromBranch, planFold, summaryLimitOf, type BranchFoldState, type FoldCondenser, type FoldPlan, type FoldRequest } from "./fold-adapter.js";
import type { FoldsConfig } from "../platform/config-layers.js";
import {
	FOLD_ENTRY_TYPE,
	MAX_FOLD_ITEMS_PER_CALL,
	checkFoldRequestId,
	coveredEntryIds,
	foldRecordsOnBranch,
	readFoldRecord,
} from "./fold-entries.js";
import { baseIdOf, parseBoundary, type Config } from "./kernel/index.js";

/**
 * Most entry ids one recovery record may name. A summary of a range this wide
 * is no longer a faithful summary, and a record this size is already a large
 * `details` value in a session file. The engine refuses to accept a request
 * with an id over this size, so a larger record was not made by the engine.
 */
export const MAX_RECOVERY_COVERED_IDS_PER_RECORD = 5_000;

/**
 * Most records one scan queues. Records for folds that are already written are
 * not counted. A fold tool call carries at most MAX_FOLD_ITEMS_PER_CALL (1000)
 * items, and a branch rarely holds more than a few unwritten calls, so 256
 * leaves room for real use and stops a hostile file from queueing thousands.
 */
export const MAX_RECOVERY_RECORDS_PER_SCAN = 256;

/**
 * Most entry ids all records of one scan may name together. It equals the
 * parity comparer's branch limit (50,000 entries): unwritten folds on one
 * branch cannot legitimately name more entries than the branch holds.
 */
export const MAX_RECOVERY_COVERED_IDS_PER_SCAN = 50_000;

/** A summary limit as an optional field: present only for a finite number (pi-context-aware#183). */
function limitField(value: unknown): { summaryMaxChars?: number } {
	const summaryMaxChars = summaryLimitOf(value);
	return summaryMaxChars === undefined ? {} : { summaryMaxChars };
}

/** Version of the serialisation the source digest is computed over. */
export const SOURCE_DIGEST_VERSION = "context-aware.fold-source.v1";

/** A fold request, optionally with the id that makes writing it idempotent. */
export interface QueuedFoldRequest extends FoldRequest {
	/** `<tool call id>#<item index>`. Recorded on the written fold. */
	readonly requestId?: string;
	/**
	 * What the engine accepted, set only by the engine. A request without it
	 * (a preview built by a caller) is planned from its refs and not checked
	 * against a source.
	 */
	readonly accepted?: LiveAcceptance;
}

/** The part of an accepted request that the drain checks. */
export interface FoldSource {
	/** First session entry of the planned fold range. */
	readonly startEntryId: string;
	/** Last session entry of the planned fold range. */
	readonly endEntryId: string;
	/** Every session entry the accepted plan would hide, in branch order. */
	readonly coveredEntryIds: readonly string[];
	/**
	 * Fold ids (`bN`) the request named as its start or end. Present only for an
	 * endpoint that was a fold id, so a fold-of-folds is planned again at the
	 * same tier. Message endpoints are always found again through the entry ids.
	 */
	readonly startBlockId?: string;
	readonly endBlockId?: string;
	/**
	 * sha256 (hex) of a canonical serialisation of what the summary was written
	 * over: each covered unit in branch order, either an entry id or, for an
	 * existing fold, its block id, fold record entry id and current summary text.
	 */
	readonly sourceDigest: string;
}

/** What a live request remembers from the moment the engine accepted it. */
export interface LiveAcceptance {
	readonly source: FoldSource;
	/** Branch leaf when the request was accepted; it must still be on the branch at the drain. `null` on an empty branch. */
	readonly leafId: string | null;
	/** The record returned to the caller. Present when the request has an id. */
	readonly recovery?: FoldRequestRecovery;
}

/** Kind of the record a fold tool saves in its result `details`. */
export const FOLD_REQUEST_RECOVERY_KIND = "context-aware.fold-request.v2";

/** What the engine accepted: enough to plan the same fold again after a restart. */
/** Longest ref (`mNNNNN` or `bN`) stored in a record. */
export const MAX_REQUEST_REF_LENGTH = 64;

export interface FoldRequestRecovery extends FoldSource {
	readonly kind: typeof FOLD_REQUEST_RECOVERY_KIND;
	/**
	 * The refs the request named, trimmed and lower-cased. Never used to plan: refs
	 * shift as folds are written. Used only to tell a replay of the same tool call
	 * (same refs, summary and topic) from a different request, once its fold is written.
	 */
	readonly startRef: string;
	readonly endRef: string;
	/** `<tool call id>#<item index>`; the tool call id is the id of the call that holds the result. */
	readonly requestId: string;
	readonly summary: string;
	readonly topic?: string;
	/** The request's summary limit, when it raised or lowered the engine's (pi-context-aware#183). */
	readonly summaryMaxChars?: number;
	/**
	 * Branch leaf when the request was accepted (pi-context-aware#176). The drain
	 * writes the fold only while the selected branch still holds this entry, as
	 * for a live request. Absent in a record saved before the leaf was recorded,
	 * and for a request accepted on an empty branch; such a record is checked
	 * against its tool result only.
	 */
	readonly leafEntryId?: string;
}

/** A request read back from a saved record. Its refs are worked out when it is planned. */
export interface RecoveredFoldRequest {
	readonly recovery: FoldRequestRecovery;
	/** The toolResult entry that held the record. It must be on the branch at the drain. */
	readonly toolResultEntryId: string;
}

/** Anything the queue can hold. */
export type QueuedFold = QueuedFoldRequest | RecoveredFoldRequest;

export function isRecoveredFold(request: QueuedFold): request is RecoveredFoldRequest {
	return "recovery" in request;
}

/** The request id of a queued item, when it has one. */
export function queuedRequestId(request: QueuedFold): string | undefined {
	return isRecoveredFold(request) ? request.recovery.requestId : request.requestId;
}

/** Why an accepted request was not written. */
export type FoldDropCode =
	| "entry-missing"
	| "coverage-changed"
	| "source-changed"
	| "branch-changed"
	| "refused"
	| "plan-failed"
	| "too-large";

const MAX_ENTRY_ID_LENGTH = 256;
const BLOCK_ID = /^b[1-9]\d{0,8}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

// ---- source digest and comparison ---------------------------------------------------------------

/**
 * Digest of the source the entries `ids` stand for, in the fold state `state` of
 * `branch`. A plain entry counts by its id (entries are immutable). An entry
 * that already belongs to a fold counts as that fold, once, at its first
 * entry: block id, the id of the entry that holds its record, and its current
 * summary text, so a rewritten summary changes the digest.
 */
export function sourceDigestOf(state: BranchFoldState, branch: readonly SessionEntry[], ids: readonly string[]): string {
	const order = new Map(branch.map((entry, index) => [entry.id, index]));
	const ordered = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	const recordEntryIds = new Map(foldRecordsOnBranch(branch).map(({ entryId, record }) => [record.blockId, entryId]));
	const summaries = new Map(state.kernel.blocks.map((block) => [block.blockId, block.summary]));
	const blockOfEntry = new Map<string, string>();
	for (const record of state.active) for (const id of coveredEntryIds(record)) blockOfEntry.set(id, record.blockId);
	const seen = new Set<string>();
	const units: (string | null)[][] = [];
	for (const id of ordered) {
		const blockId = blockOfEntry.get(id);
		if (blockId === undefined) {
			units.push(["entry", id]);
			continue;
		}
		if (seen.has(blockId)) continue;
		seen.add(blockId);
		units.push(["fold", blockId, recordEntryIds.get(blockId) ?? null, summaries.get(blockId) ?? ""]);
	}
	return createHash("sha256").update(JSON.stringify([SOURCE_DIGEST_VERSION, units])).digest("hex");
}

export interface AcceptedSourceInput {
	readonly request: FoldRequest;
	/** The plan the engine just accepted for this request. */
	readonly plan: Extract<FoldPlan, { ok: true }>;
	readonly branch: readonly SessionEntry[];
	readonly contextEntries: readonly SessionEntry[];
}

/**
 * The source of an accepted request: the entries its plan resolved now, from
 * the plan itself and not from the request's refs, with their digest.
 * `undefined` when the plan covers no entry.
 */
export function acceptedSourceOf(input: AcceptedSourceInput): FoldSource | undefined {
	const order = new Map(input.branch.map((entry, index) => [entry.id, index]));
	const covered = [...new Set(input.plan.records.flatMap(coveredEntryIds))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	const startEntryId = covered[0];
	const endEntryId = covered[covered.length - 1];
	if (startEntryId === undefined || endEntryId === undefined) return undefined;
	const blockId = (ref: string): string | undefined => {
		const parsed = parseBoundary(ref);
		return parsed?.kind === "block" ? `b${parsed.numericId}` : undefined;
	};
	const startBlockId = blockId(input.request.startRef);
	const endBlockId = blockId(input.request.endRef);
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	return {
		startEntryId,
		endEntryId,
		coveredEntryIds: covered,
		sourceDigest: sourceDigestOf(state, input.branch, covered),
		...(startBlockId ? { startBlockId } : {}),
		...(endBlockId ? { endBlockId } : {}),
	};
}

export interface SourceDifference {
	readonly code: "coverage-changed" | "source-changed";
	readonly message: string;
}

/**
 * Compare what was accepted with what the request would cover now. The covered
 * entry ids must be the same set, then the digests must be equal. `nowDigest`
 * runs only when the entry ids match.
 */
export function compareFoldSources(
	accepted: Pick<FoldSource, "coveredEntryIds" | "sourceDigest">,
	nowIds: readonly string[],
	nowDigest: () => string,
): SourceDifference | undefined {
	const recorded = new Set(accepted.coveredEntryIds);
	const now = new Set(nowIds);
	if (recorded.size !== now.size || [...recorded].some((id) => !now.has(id))) {
		return {
			code: "coverage-changed",
			message: `coverage-changed: the fold was accepted to hide ${recorded.size} entries but would now hide ${now.size}; it is dropped instead of hiding other entries than the model was told.`,
		};
	}
	if (nowDigest() !== accepted.sourceDigest) {
		return {
			code: "source-changed",
			message: "source-changed: the fold covers the entries it was accepted over, but a fold among them has a different summary now; the summary was written over other content, so it is dropped.",
		};
	}
	return undefined;
}

// ---- records -------------------------------------------------------------------------------------

export interface BuildRecoveryInput {
	readonly requestId: string;
	readonly request: FoldRequest;
	readonly source: FoldSource;
	/** Branch leaf when the request was accepted; `null` on an empty branch. */
	readonly leafId: string | null;
}

/** The record for an accepted request. `undefined` when the id is not a valid request id. */
export function buildFoldRequestRecovery(input: BuildRecoveryInput): FoldRequestRecovery | undefined {
	if (!checkFoldRequestId(input.requestId).ok) return undefined;
	const { source } = input;
	return {
		kind: FOLD_REQUEST_RECOVERY_KIND,
		requestId: input.requestId,
		startRef: input.request.startRef.trim().toLowerCase().slice(0, MAX_REQUEST_REF_LENGTH),
		endRef: input.request.endRef.trim().toLowerCase().slice(0, MAX_REQUEST_REF_LENGTH),
		startEntryId: source.startEntryId,
		endEntryId: source.endEntryId,
		coveredEntryIds: [...source.coveredEntryIds],
		sourceDigest: source.sourceDigest,
		summary: input.request.summary,
		...(input.request.topic ? { topic: input.request.topic } : {}),
		...limitField(input.request.summaryMaxChars),
		...(source.startBlockId ? { startBlockId: source.startBlockId } : {}),
		...(source.endBlockId ? { endBlockId: source.endBlockId } : {}),
		...(input.leafId !== null ? { leafEntryId: input.leafId } : {}),
	};
}

/**
 * Read one record. Strict: wrong kind, a bad id, a missing field, a digest
 * that is not 64 hex characters, an empty or repeated entry id, more entry ids
 * than MAX_RECOVERY_COVERED_IDS_PER_RECORD, or a range end that is not in the
 * covered entries all reject the whole record, as does a leaf entry id that is
 * present and not an entry id. Extra keys are ignored and not copied. A record
 * of the earlier version (no source digest) is not read. A v2 record without a
 * leaf entry id (saved before pi-context-aware#176) is read.
 */
export function parseFoldRequestRecovery(value: unknown): FoldRequestRecovery | undefined {
	try {
		if (!isRecord(value) || value.kind !== FOLD_REQUEST_RECOVERY_KIND) return undefined;
		if (!checkFoldRequestId(value.requestId).ok) return undefined;
		const { requestId, startEntryId, endEntryId, summary, topic, sourceDigest, summaryMaxChars, leafEntryId } = value;
		if (summaryMaxChars !== undefined && summaryLimitOf(summaryMaxChars) === undefined) return undefined;
		if (leafEntryId !== undefined && !isEntryId(leafEntryId)) return undefined;
		if (!isEntryId(startEntryId) || !isEntryId(endEntryId) || !isNonEmptyString(summary)) return undefined;
		if (typeof sourceDigest !== "string" || !SHA256_HEX.test(sourceDigest)) return undefined;
		const { startRef, endRef } = value;
		for (const ref of [startRef, endRef]) {
			if (!(typeof ref === "string" && ref.length > 0 && ref.length <= MAX_REQUEST_REF_LENGTH)) return undefined;
		}
		if (topic !== undefined && !isNonEmptyString(topic)) return undefined;
		const { startBlockId, endBlockId } = value;
		for (const blockId of [startBlockId, endBlockId]) {
			if (blockId !== undefined && !(typeof blockId === "string" && BLOCK_ID.test(blockId))) return undefined;
		}
		const covered = value.coveredEntryIds;
		if (!Array.isArray(covered) || covered.length === 0 || covered.length > MAX_RECOVERY_COVERED_IDS_PER_RECORD) return undefined;
		const ids = new Set<string>();
		for (const id of covered as unknown[]) {
			if (!isEntryId(id) || ids.has(id)) return undefined;
			ids.add(id);
		}
		if (!ids.has(startEntryId) || !ids.has(endEntryId)) return undefined;
		return {
			kind: FOLD_REQUEST_RECOVERY_KIND,
			requestId: requestId as string,
			startRef: startRef as string,
			endRef: endRef as string,
			startEntryId,
			endEntryId,
			coveredEntryIds: [...ids],
			sourceDigest,
			summary,
			...(topic ? { topic } : {}),
			...limitField(summaryMaxChars),
			...(startBlockId ? { startBlockId: startBlockId as string } : {}),
			...(endBlockId ? { endBlockId: endBlockId as string } : {}),
			...(leafEntryId !== undefined ? { leafEntryId } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * The `details` value for a fold tool result. One record is stored as it is;
 * a call with several accepted items stores `{ foldRequests: [...] }`.
 * `undefined` when there is nothing to recover.
 */
export function foldRequestDetails(recoveries: readonly FoldRequestRecovery[]): FoldRequestRecovery | { foldRequests: FoldRequestRecovery[] } | undefined {
	if (recoveries.length === 0) return undefined;
	return recoveries.length === 1 ? recoveries[0]! : { foldRequests: [...recoveries] };
}

/** Raw record values in one `details` value: a bare record, or an object with a `foldRequests` array (at most one call's items). */
function rawRecordsIn(details: unknown): unknown[] {
	if (!isRecord(details)) return [];
	if (details.kind !== undefined) return [details];
	const list = details.foldRequests;
	return Array.isArray(list) ? (list as unknown[]).slice(0, MAX_FOLD_ITEMS_PER_CALL) : [];
}

interface RecordHead {
	readonly requestId: string;
	/** Number of covered entry ids the record names. */
	readonly covered: number;
	readonly startEntryId: string;
	readonly endEntryId: string;
}

/** The cheap part of a record: enough to match it and to size it, without reading its id list. */
function peekRecord(value: unknown): RecordHead | undefined {
	if (!isRecord(value) || value.kind !== FOLD_REQUEST_RECOVERY_KIND) return undefined;
	const { requestId, coveredEntryIds: covered } = value;
	if (typeof requestId !== "string" || !checkFoldRequestId(requestId).ok || !Array.isArray(covered)) return undefined;
	const show = (id: unknown): string => (typeof id === "string" ? id.slice(0, MAX_ENTRY_ID_LENGTH) : "unknown");
	return { requestId, covered: covered.length, startEntryId: show(value.startEntryId), endEntryId: show(value.endEntryId) };
}

/**
 * A successful tool result entry. A result with `isError: true` is
 * ignored: a failed tool run did not hand its records to the caller.
 */
function toolResultOf(entry: unknown): { id: string; toolCallId: string; details: unknown } | undefined {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const message = entry.message;
	if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || message.isError === true) return undefined;
	if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
	return { id: entry.id, toolCallId: message.toolCallId, details: message.details };
}

function callIdOf(requestId: string): string {
	return requestId.slice(0, requestId.lastIndexOf("#"));
}

/** A saved record that was not queued. */
export interface RecoveryDrop {
	readonly startRef: string;
	readonly endRef: string;
	readonly errors: readonly string[];
	readonly requestId?: string;
	readonly code: "too-large";
}

export interface RecoveryScan {
	readonly recovered: RecoveredFoldRequest[];
	readonly dropped: RecoveryDrop[];
}

/**
 * Requests saved on this branch whose id has no fold on it, in branch order.
 *
 * Only tool results after the newest compaction entry count. After a
 * compaction the earlier entries are not in the model context, so a record
 * that names them could not be planned. A tool result with `isError: true` is
 * ignored.
 *
 * The record id must start with the tool call id of the result that holds it
 * (`<toolCallId>#<index>`), so a result cannot carry another call's ids.
 * A drain that died halfway through a batch leaves some ids written and some
 * not, which is why this checks ids and not the position of the last fold.
 *
 * Work is bounded: a record naming more than MAX_RECOVERY_COVERED_IDS_PER_RECORD
 * ids, and any record past MAX_RECOVERY_RECORDS_PER_SCAN records or
 * MAX_RECOVERY_COVERED_IDS_PER_SCAN ids in all, is reported in `dropped` as
 * `too-large` without reading its id list. Never throws: an entry or message
 * that is not well-formed is skipped.
 */
export function scanFoldRequests(branch: readonly SessionEntry[]): RecoveryScan {
	const recovered: RecoveredFoldRequest[] = [];
	const dropped: RecoveryDrop[] = [];
	if (!Array.isArray(branch)) return { recovered, dropped };
	const entries = branch as readonly unknown[];
	let start = 0;
	entries.forEach((entry, index) => {
		try {
			if (isRecord(entry) && entry.type === "compaction") start = index + 1;
		} catch {
			// An entry that cannot be read is not a compaction.
		}
	});
	const written = writtenRequestIds(entries);
	const seen = new Set<string>();
	let records = 0;
	let ids = 0;
	let omitted = 0;
	for (const entry of entries.slice(start)) {
		try {
			const result = toolResultOf(entry);
			if (!result) continue;
			for (const raw of rawRecordsIn(result.details)) {
				const head = peekRecord(raw);
				if (!head || callIdOf(head.requestId) !== result.toolCallId) continue;
				if (written.has(head.requestId) || seen.has(head.requestId)) continue;
				const limit = head.covered > MAX_RECOVERY_COVERED_IDS_PER_RECORD
					? `it names ${head.covered} entries; at most ${MAX_RECOVERY_COVERED_IDS_PER_RECORD} are recovered per request`
					: records >= MAX_RECOVERY_RECORDS_PER_SCAN
						? `this scan already queued ${MAX_RECOVERY_RECORDS_PER_SCAN} requests`
						: ids + head.covered > MAX_RECOVERY_COVERED_IDS_PER_SCAN
							? `this scan already queued requests naming ${ids} entries; at most ${MAX_RECOVERY_COVERED_IDS_PER_SCAN} are recovered per scan`
							: undefined;
				if (limit !== undefined) {
					seen.add(head.requestId);
					if (dropped.length >= MAX_RECOVERY_RECORDS_PER_SCAN) {
						omitted++;
						continue;
					}
					dropped.push({
						startRef: head.startEntryId,
						endRef: head.endEntryId,
						errors: [`too-large: the saved fold request ${head.requestId} was not recovered: ${limit}.`],
						requestId: head.requestId,
						code: "too-large",
					});
					continue;
				}
				const recovery = parseFoldRequestRecovery(raw);
				if (!recovery) continue;
				seen.add(recovery.requestId);
				records++;
				ids += recovery.coveredEntryIds.length;
				recovered.push({ recovery, toolResultEntryId: result.id });
			}
		} catch {
			// This entry is skipped; the others are still read.
		}
	}
	if (omitted > 0) {
		// The report itself is bounded, so a hostile file cannot grow it either.
		dropped.push({
			startRef: "unknown",
			endRef: "unknown",
			errors: [`too-large: ${omitted} more saved fold requests were not recovered and are not listed.`],
			code: "too-large",
		});
	}
	return { recovered, dropped };
}

/** The requests `scanFoldRequests` queues; see there for the rules. */
export function recoverFoldRequests(branch: readonly SessionEntry[]): RecoveredFoldRequest[] {
	return scanFoldRequests(branch).recovered;
}

export type FoundFoldRequestRecord =
	| { readonly kind: "record"; readonly recovery: FoldRequestRecovery; readonly toolResultEntryId: string }
	| { readonly kind: "too-large"; readonly requestId: string; readonly covered: number };

/**
 * The saved record of one request id on this branch, wherever it sits: dropped
 * or not yet drained, before or after a compaction. Used to answer a replayed
 * request. A record too large to read is reported as such, so that its id is
 * still refused.
 */
export function findFoldRequestRecord(branch: readonly SessionEntry[], requestId: string): FoundFoldRequestRecord | undefined {
	if (!Array.isArray(branch) || !checkFoldRequestId(requestId).ok) return undefined;
	const callId = callIdOf(requestId);
	for (const entry of branch as readonly unknown[]) {
		try {
			const result = toolResultOf(entry);
			if (!result || result.toolCallId !== callId) continue;
			for (const raw of rawRecordsIn(result.details)) {
				const head = peekRecord(raw);
				if (!head || head.requestId !== requestId) continue;
				if (head.covered > MAX_RECOVERY_COVERED_IDS_PER_RECORD) return { kind: "too-large", requestId, covered: head.covered };
				const recovery = parseFoldRequestRecovery(raw);
				if (recovery) return { kind: "record", recovery, toolResultEntryId: result.id };
			}
		} catch {
			// This entry is skipped; the others are still read.
		}
	}
	return undefined;
}

/** Request ids of the folds on the branch. Reads each entry on its own, so one bad entry hides nothing. */
function writtenRequestIds(entries: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		try {
			if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FOLD_ENTRY_TYPE) continue;
			const record = readFoldRecord(entry.data);
			if (record?.requestId) ids.add(record.requestId);
		} catch {
			// Not a readable fold entry.
		}
	}
	return ids;
}

// ---- the drain check -------------------------------------------------------------------------------

/** An accepted request, live or recovered, in the form the drain checks. */
export interface AcceptedFold {
	readonly requestId?: string;
	readonly source: FoldSource;
	readonly summary: string;
	readonly topic?: string;
	readonly summaryMaxChars?: number;
	/**
	 * Entries that prove the branch, each of which must be on the branch at the drain:
	 * the leaf the request was accepted on, and for a recovered request the saved
	 * tool result. Empty for a request accepted on an empty branch.
	 */
	readonly anchors: readonly FoldAnchor[];
	/** Refs to name in a drop report when they differ from the entry or fold ids. */
	readonly reportStartRef?: string;
	readonly reportEndRef?: string;
}

/** An entry an accepted request was made on. */
export interface FoldAnchor {
	readonly entryId: string;
	readonly label: "tool result" | "branch leaf";
}

/** The accepted form of a queued item; `undefined` for a request the engine did not accept. */
export function acceptedFoldOf(item: QueuedFold): AcceptedFold | undefined {
	if (isRecoveredFold(item)) {
		const { recovery } = item;
		return {
			requestId: recovery.requestId,
			source: recovery,
			summary: recovery.summary,
			...(recovery.topic ? { topic: recovery.topic } : {}),
			...limitField(recovery.summaryMaxChars),
			// The leaf comes first: a tool can change the selected branch before it returns,
			// and then Pi saves its result, and the record in it, on the other branch.
			anchors: [
				...(recovery.leafEntryId !== undefined ? [{ entryId: recovery.leafEntryId, label: "branch leaf" as const }] : []),
				{ entryId: item.toolResultEntryId, label: "tool result" },
			],
		};
	}
	if (!item.accepted) return undefined;
	return {
		...(item.requestId ? { requestId: item.requestId } : {}),
		source: item.accepted.source,
		summary: item.summary,
		...(item.topic ? { topic: item.topic } : {}),
		...limitField(item.summaryMaxChars),
		anchors: item.accepted.leafId !== null ? [{ entryId: item.accepted.leafId, label: "branch leaf" }] : [],
		reportStartRef: item.startRef,
		reportEndRef: item.endRef,
	};
}

export type ReplannedFold =
	| { readonly ok: true; readonly plan: Extract<FoldPlan, { ok: true }>; readonly startRef: string; readonly endRef: string }
	| { readonly ok: false; readonly code: FoldDropCode; readonly errors: string[]; readonly startRef: string; readonly endRef: string };

export interface ReplanInput {
	readonly accepted: AcceptedFold;
	readonly branch: readonly SessionEntry[];
	readonly contextEntries: readonly SessionEntry[];
	readonly modelContextLimit: number;
	/** Effective fold settings; the same ones a fresh request is planned with. */
	readonly folds?: FoldsConfig;
	readonly condenser?: FoldCondenser;
	readonly config?: Partial<Config>;
}

/**
 * Plan an accepted request again against the branch as it is now, and write
 * nothing unless it is still the fold that was accepted:
 *
 * 1. every anchor entry (the leaf the request was accepted on, and a recovered
 *    request's tool result) is on this branch, else `branch-changed`. Entries
 *    appended after the leaf on the same branch are normal turn growth;
 * 2. every recorded entry is still in the model context, else `entry-missing`;
 * 3. the planner accepts the range, else `refused`;
 * 4. the plan hides exactly the recorded entries, else `coverage-changed`;
 * 5. the source digest is unchanged, else `source-changed`.
 *
 * The recorded entry ids are mapped to the refs this branch gives them
 * (read-only). Live and recovered requests take this one path.
 */
export function replanAcceptedFold(input: ReplanInput): ReplannedFold {
	const { accepted } = input;
	const { source } = accepted;
	const reportStart = accepted.reportStartRef ?? source.startBlockId ?? source.startEntryId;
	const reportEnd = accepted.reportEndRef ?? source.endBlockId ?? source.endEntryId;
	const onBranch = new Set(input.branch.map((entry) => entry.id));
	const offBranch = accepted.anchors.find((anchor) => !onBranch.has(anchor.entryId));
	if (offBranch) {
		return {
			ok: false,
			code: "branch-changed",
			errors: [`branch-changed: the ${offBranch.label} entry ${offBranch.entryId} this fold was accepted on is not on the current branch; it is not written to another branch.`],
			startRef: reportStart,
			endRef: reportEnd,
		};
	}
	const inContext = new Set(input.contextEntries.map((entry) => entry.id));
	const gone = source.coveredEntryIds.filter((id) => !inContext.has(id));
	if (gone.length > 0) {
		return {
			ok: false,
			code: "entry-missing",
			errors: [`entry-missing: ${gone.length} recorded session entr${gone.length === 1 ? "y" : "ies"} (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? ", ..." : ""}) no longer in the model context: compacted away or not on this branch.`],
			startRef: reportStart,
			endRef: reportEnd,
		};
	}
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const refFor = (entryId: string, last: boolean): string | undefined => {
		const ids = state.messages.filter((message) => baseIdOf(message.id) === entryId).map((message) => message.id);
		const raw = last ? ids[ids.length - 1] : ids[0];
		const ref = raw === undefined ? undefined : state.kernel.messageRefs.byRaw[raw];
		return ref && ref !== "BLOCKED" ? ref : undefined;
	};
	const startRef = source.startBlockId ?? refFor(source.startEntryId, false);
	const endRef = source.endBlockId ?? refFor(source.endEntryId, true);
	if (!startRef || !endRef) {
		const missing = [!startRef ? source.startEntryId : undefined, !endRef ? source.endEntryId : undefined].filter((id) => id !== undefined);
		return {
			ok: false,
			code: "entry-missing",
			errors: [`entry-missing: session entr${missing.length === 1 ? "y" : "ies"} ${missing.join(", ")} no longer in the model context (compacted away or not on this branch).`],
			startRef: accepted.reportStartRef ?? startRef ?? source.startEntryId,
			endRef: accepted.reportEndRef ?? endRef ?? source.endEntryId,
		};
	}
	const plan = planFold({
		startRef,
		endRef,
		summary: accepted.summary,
		...(accepted.topic ? { topic: accepted.topic } : {}),
		...limitField(accepted.summaryMaxChars),
		branch: input.branch,
		contextEntries: input.contextEntries,
		modelContextLimit: input.modelContextLimit,
		...(input.folds ? { folds: input.folds } : {}),
		...(input.condenser ? { condenser: input.condenser } : {}),
		...(input.config ? { config: input.config } : {}),
	});
	const shown = { startRef: accepted.reportStartRef ?? startRef, endRef: accepted.reportEndRef ?? endRef };
	if (!plan.ok) {
		// A fold written after this request was accepted took part of its range. The engine refuses
		// a range that ends inside an active fold (pi-context-aware#184); the cause is the changed coverage.
		const recorded = new Set(source.coveredEntryIds);
		const overlapping = state.active.filter((record) => {
			const ids = coveredEntryIds(record);
			return ids.some((id) => recorded.has(id)) && !ids.every((id) => recorded.has(id));
		});
		if (overlapping.length > 0) {
			return { ok: false, code: "coverage-changed", errors: [`coverage-changed: fold ${overlapping.map((record) => record.blockId).join(", ")} now covers part of the ${recorded.size} entries this fold was accepted to hide; it is dropped instead of folding them twice.`], ...shown };
		}
		return { ok: false, code: "refused", errors: plan.errors.map((error) => `refused: ${error}`), ...shown };
	}
	const planned = plan.records.length === 1 ? coveredEntryIds(plan.records[0]!) : [];
	const difference = compareFoldSources(source, planned, () => sourceDigestOf(state, input.branch, planned));
	if (difference) return { ok: false, code: difference.code, errors: [difference.message], ...shown };
	return { ok: true, plan, startRef, endRef };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isEntryId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ENTRY_ID_LENGTH;
}
