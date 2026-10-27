import type { CompressParseKind } from "../folds/kernel/parse-compress-input.js";
import { MAX_COVERAGE_IDS, MAX_MESSAGE_HASHES, summaryEvidenceDiff } from "./compare.js";
import { isRefusalOutcome, type BlockEvidence, type DiffKind, type OutcomeEvidence, type OutcomeType, type ParityDiff, type RefusedCall, type RejectReason, type RequestDelta, type RequestDeltaReason, type RequestHashes, type Verdict } from "./records.js";

/**
 * Structural validation for stored parity evidence, shared by the readiness report and the CI
 * differential so the two gates cannot disagree about what a usable record is. A conclusive
 * verdict is only as good as the evidence it compared: a missing field, a value outside the
 * recorder's vocabulary, or a count that disagrees with its list is a recorder fault, not a result.
 * Each vocabulary is a Record over its union, so the compiler rejects a missing or extra value.
 */
const VERDICTS: Record<Verdict, true> = { match: true, diff: true, inconclusive: true };
const DIFF_KINDS: Record<DiffKind, true> = {
	outcome: true, "error-type": true, "outcome-unknown": true, "block-count": true, coverage: true, tier: true, absorbed: true,
	"input-parse": true, "ref-unmapped": true, "import-unsupported": true, "import-skipped": true, "side-file-missing": true,
	"too-large": true, "recorder-error": true, summaries: true, content: true, "tool-calls": true, "tool-results": true,
	"tool-pairing": true, "tool-evidence": true, "tags-absent": true,
};
const OUTCOME_TYPES: Record<OutcomeType, true> = {
	accepted: true, partial: true, rejected: true, "no-op": true, "invalid-input": true, "tier3-rewrite": true,
	"dead-range": true, "capped-retry": true, aborted: true, unknown: true,
};
const REJECT_REASONS: Record<RejectReason, true> = {
	"summary-empty": true, "summary-short": true, "summary-long": true, "unknown-ref": true, "dangling-ref": true, consumed: true,
	"protected-zone": true, split: true, "too-small": true, "no-fold": true, "header-missing": true, "stub-summary": true, other: true,
};
const PARSE_KINDS: Record<CompressParseKind, true> = {
	ok: true, "empty-input": true, "not-object": true, "missing-content": true, "content-not-array": true,
	"malformed-json": true, truncated: true, "no-valid-ranges": true,
};
const TIERS: ReadonlySet<unknown> = new Set([1, 2, 3]);
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

type Fields = Readonly<Record<string, unknown>>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string";
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isFlag = (value: unknown): value is boolean => typeof value === "boolean";
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isMember = (vocabulary: Readonly<Record<string, unknown>>, value: unknown) => typeof value === "string" && Object.hasOwn(vocabulary, value);
/** Distinct non-empty ids, at most `max` of them. */
const isIdList = (value: unknown, max: number): value is readonly string[] => Array.isArray(value) && value.length <= max
	&& value.every(isId) && new Set(value).size === value.length;

const isToolCall = (value: unknown) => isFields(value) && isText(value.id) && isText(value.name) && isText(value.argsHash)
	&& isOptional(value.compactedArgsHash, isText);
const isToolResult = (value: unknown) => isFields(value) && isText(value.toolCallId) && isText(value.toolName) && isFlag(value.isError);
const isMessageHash = (value: unknown) => isFields(value) && isText(value.role) && isText(value.hash) && isFlag(value.summary)
	&& isOptional(value.topicHash, isText) && isOptional(value.toolCalls, (calls) => Array.isArray(calls) && calls.every(isToolCall))
	&& isOptional(value.toolResult, isToolResult) && isOptional(value.toolEvidence, (flag) => flag === "incomplete");

/**
 * The first unusable BlockEvidence field, or undefined when every field is present and consistent.
 * With `consistent` false only types and vocabularies are checked, which is enough to run the block
 * comparison again: a count that disagrees with its list is still worth diagnosing.
 */
export function blockEvidenceFault(value: unknown, consistent = true): string | undefined {
	if (!isFields(value)) return "missing";
	const { count, coverageCount, coverageIds, coverageHash, partialEntries, tiers, absorbed, createdIds, blockIdsCapped } = value;
	if (!isCount(count)) return "count";
	if (!isCount(coverageCount)) return "coverageCount";
	// The recorder keeps the first MAX_COVERAGE_IDS sorted ids and hashes the full list.
	if (!isIdList(coverageIds, MAX_COVERAGE_IDS) || (consistent && coverageIds.length !== Math.min(coverageCount, MAX_COVERAGE_IDS))) return "coverageIds";
	if (!isText(coverageHash) || !HEX_SHA256.test(coverageHash)) return "coverageHash";
	if (!isCount(partialEntries) || (consistent && partialEntries > coverageCount)) return "partialEntries";
	if (!Array.isArray(tiers) || (consistent && tiers.length !== count) || !tiers.every((tier) => TIERS.has(tier))) return "tiers";
	if (!isOptional(blockIdsCapped, isFlag)) return "blockIdsCapped";
	if (!isIdList(absorbed, MAX_MESSAGE_HASHES)) return "absorbed";
	if (createdIds !== undefined && (!isIdList(createdIds, MAX_MESSAGE_HASHES)
		|| (consistent && blockIdsCapped !== true && createdIds.length !== count))) return "createdIds";
	return undefined;
}

/** The first unusable OutcomeEvidence field: types and reasons must come from the closed vocabularies. */
export function outcomeEvidenceFault(value: unknown): string | undefined {
	if (!isFields(value)) return "missing";
	if (!isMember(OUTCOME_TYPES, value.type)) return "type";
	const { reasons } = value;
	if (!Array.isArray(reasons) || !reasons.every((reason) => isMember(REJECT_REASONS, reason)) || new Set(reasons).size !== reasons.length) return "reasons";
	return undefined;
}

/** A nudge-fix note: a known cause, at least one nudge hash, and the two hashes differ. */
function isNudgeFix(value: unknown): boolean {
	if (!isFields(value) || (value.cause !== "tier-trigger" && value.cause !== "emergency-defer")) return false;
	const { sent, compatible } = value;
	if (!isOptional(sent, isText) || !isOptional(compatible, isText) || sent === compatible) return false;
	// Deferring the emergency nudge sends none where billion-context-pi sends one.
	return value.cause === "emergency-defer" ? sent === undefined && compatible !== undefined : true;
}

function isMediaElision(value: unknown): boolean {
	if (!isFields(value) || !Array.isArray(value.originals) || !Array.isArray(value.replacements)) return false;
	if (value.originals.length === 0 || value.originals.length > MAX_MESSAGE_HASHES || value.originals.length !== value.replacements.length) return false;
	return value.originals.every(isText) && value.replacements.every(isText);
}

/** The first unusable RequestHashes field. Message hashes are capped at MAX_MESSAGE_HASHES; `total` is not. */
export function requestHashesFault(value: unknown): string | undefined {
	if (!isFields(value)) return "missing";
	const { total, messages } = value;
	if (!isCount(total)) return "total";
	if (!Array.isArray(messages) || messages.length !== Math.min(total, MAX_MESSAGE_HASHES) || !messages.every(isMessageHash)) return "messages";
	if (!isFlag(value.tagsSeen)) return "tagsSeen";
	if (!isOptional(value.activeFoldCount, isCount)) return "activeFoldCount";
	if (!isOptional(value.activeFoldIds, (ids) => isIdList(ids, MAX_MESSAGE_HASHES))) return "activeFoldIds";
	if (!isOptional(value.activeFoldIdsCapped, isFlag)) return "activeFoldIdsCapped";
	for (const field of ["expectedSummaryHashes", "expectedSummaryTopicHashes"] as const) {
		if (!isOptional(value[field], (hashes) => Array.isArray(hashes) && hashes.every(isText))) return field;
	}
	if (!isOptional(value.firstUserFolded, isMessageHash)) return "firstUserFolded";
	if (!isOptional(value.firstUserReplacementHash, isText)) return "firstUserReplacementHash";
	if (!isOptional(value.nudgeFix, isNudgeFix)) return "nudgeFix";
	if (!isOptional(value.mediaElision, isMediaElision)) return "mediaElision";
	return undefined;
}

/**
 * The optional counts each delta outcome carries, as `refusedFoldDelta` in compare.ts writes them:
 * `refused-folds-only` and every `other` reason. A count the writer sets is required; one it never
 * sets must be absent. The Record over the reason union keeps the set closed at compile time.
 */
type DeltaCounts = { readonly removedMessages: boolean; readonly mismatchAt: boolean };
const NO_COUNTS: DeltaCounts = { removedMessages: false, mismatchAt: false };
const REFUSED_FOLDS_ONLY_COUNTS: DeltaCounts = { removedMessages: true, mismatchAt: false };
const DELTA_REASONS: Record<RequestDeltaReason, DeltaCounts> = {
	"attribution-unavailable": NO_COUNTS, "too-large": NO_COUNTS, "unattributed-fold": NO_COUNTS, "sibling-covered": NO_COUNTS,
	"sibling-absorbed": NO_COUNTS, "sibling-changed": NO_COUNTS, "summary-missing": { removedMessages: true, mismatchAt: false },
	"message-changed": { removedMessages: true, mismatchAt: true },
};
const DELTA_FIELDS: Record<keyof RequestDelta, true> = { verdict: true, reason: true, refusedFolds: true, coveredEntries: true, removedMessages: true, mismatchAt: true };

/**
 * The first unusable RequestDelta field. The verdict and reason must be one of the writer's closed
 * combinations: `refused-folds-only` has no reason, `other` has a known one. Every count is a safe
 * non-negative integer, present exactly when the writer sets it for that outcome, and no other field
 * is allowed.
 */
export function requestDeltaFault(value: unknown): string | undefined {
	if (!isFields(value)) return "missing";
	if (!Object.keys(value).every((key) => Object.hasOwn(DELTA_FIELDS, key))) return "unknown field";
	let counts: DeltaCounts;
	if (value.verdict === "refused-folds-only") {
		if (value.reason !== undefined) return "reason";
		counts = REFUSED_FOLDS_ONLY_COUNTS;
	} else if (value.verdict === "other") {
		if (!isMember(DELTA_REASONS, value.reason)) return "reason";
		counts = DELTA_REASONS[value.reason as RequestDeltaReason];
	} else return "verdict";
	if (!isCount(value.refusedFolds)) return "refusedFolds";
	if (!isCount(value.coveredEntries)) return "coveredEntries";
	for (const field of ["removedMessages", "mismatchAt"] as const) {
		if (counts[field] ? !isCount(value[field]) : value[field] !== undefined) return field;
	}
	return undefined;
}

/** A stored ParityDiff: a known kind, and counts, id lists and reason of the right types. */
const isParityDiff = (value: unknown): value is ParityDiff => isFields(value) && isMember(DIFF_KINDS, value.kind)
	&& isOptional(value.oursOnlyCount, isCount) && isOptional(value.bcpOnlyCount, isCount)
	&& isOptional(value.oursOnly, (ids) => Array.isArray(ids) && ids.every(isText))
	&& isOptional(value.bcpOnly, (ids) => Array.isArray(ids) && ids.every(isText))
	&& isOptional(value.reason, isText);

/** The refusal evidence of a next request, once `refusalEvidenceFault` has found every field usable. */
export interface RefusalEvidence {
	readonly refused: readonly RefusedCall[];
	readonly diffs: readonly ParityDiff[];
	readonly delta: RequestDelta;
	readonly counterfactualOurs: RequestHashes;
}

/**
 * The first unusable field of a next request's refusal evidence, or undefined when the record holds
 * all of it as `compareBatchRequest` writes it: `refused` is a non-empty list of distinct calls of
 * this request, each with a closed refusal ending; `counterfactual.diffs` is a list of well-formed
 * diffs; `counterfactual.delta` passes `requestDeltaFault`; and `counterfactualOurs` is valid
 * request evidence. A record without this evidence is a valid record, so a fault here is not a
 * recorder fault: it means the record cannot show that its refusals alone cause its differences.
 */
export function refusalEvidenceFault(record: unknown): string | undefined {
	if (!isFields(record)) return "record";
	const { refused, counterfactual, toolCallIds } = record;
	if (!Array.isArray(refused) || !refused.length) return "refused";
	const ids = refused.map((call) => isFields(call) ? call.toolCallId : undefined);
	if (!ids.every((id) => isId(id) && Array.isArray(toolCallIds) && toolCallIds.includes(id))) return "refused call id";
	if (new Set(ids).size !== ids.length) return "refused call repeated";
	if (!refused.every((call) => isFields(call) && isRefusalOutcome(call.type))) return "refused ending";
	if (!isFields(counterfactual)) return "counterfactual";
	if (!Array.isArray(counterfactual.diffs) || !counterfactual.diffs.every(isParityDiff)) return "counterfactual diffs";
	const deltaFault = requestDeltaFault(counterfactual.delta);
	if (deltaFault) return `counterfactual delta ${deltaFault}`;
	const oursFault = requestHashesFault(record.counterfactualOurs);
	return oursFault ? `counterfactualOurs ${oursFault}` : undefined;
}

/** The record's refusal evidence when every field is usable (`refusalEvidenceFault`), else undefined. */
export function refusalEvidence(record: unknown): RefusalEvidence | undefined {
	if (refusalEvidenceFault(record) !== undefined) return undefined;
	const { refused, counterfactual, counterfactualOurs } = record as { refused: RefusedCall[]; counterfactual: { diffs: ParityDiff[]; delta: RequestDelta }; counterfactualOurs: RequestHashes };
	return { refused, diffs: counterfactual.diffs, delta: counterfactual.delta, counterfactualOurs };
}

export const isBlockEvidence = (value: unknown): value is BlockEvidence => blockEvidenceFault(value) === undefined;
/** Well-typed block evidence that the comparison can read, even when a count disagrees with its list. */
export const isComparableBlockEvidence = (value: unknown): value is BlockEvidence => blockEvidenceFault(value, false) === undefined;
export const isOutcomeEvidence = (value: unknown): value is OutcomeEvidence => outcomeEvidenceFault(value) === undefined;
export const isRequestHashes = (value: unknown): value is RequestHashes => requestHashesFault(value) === undefined;

/**
 * Why a stored record cannot be trusted as a parity result, or undefined when it can. Inconclusive
 * records need only a known verdict and known diff kinds, because they never count as results.
 * Takes `unknown` because the records come from disk and from the differential's JavaScript.
 */
export function parityEvidenceFault(value: unknown): string | undefined {
	if (!isFields(value)) return "record is not an object";
	if (value.kind !== "compress" && value.kind !== "next-request") return "unknown record kind";
	if (!isMember(VERDICTS, value.verdict)) return "record verdict missing or unknown";
	const { diffs } = value;
	if (!Array.isArray(diffs) || !diffs.every((diff) => isFields(diff) && isMember(DIFF_KINDS, diff.kind))) return "stored diffs missing or of an unknown kind";
	if (value.verdict === "inconclusive") return undefined;
	if ((value.verdict === "match") !== (diffs.length === 0)) return "record verdict disagrees with stored diffs";
	return value.kind === "compress" ? compressFault(value) : requestFault(value);
}

function compressFault(record: Fields): string | undefined {
	if (!isId(record.toolCallId)) return "call id missing";
	for (const side of ["ours", "bcp"] as const) {
		const fault = blockEvidenceFault(record[side]);
		if (fault) return `${side} block evidence invalid: ${fault}`;
	}
	for (const side of ["oursOutcome", "bcpOutcome"] as const) {
		const fault = outcomeEvidenceFault(record[side]);
		if (fault) return `${side} invalid: ${fault}`;
	}
	if (!isMember(PARSE_KINDS, record.parseKind) || !isCount(record.parseInvalidItems)) return "parse evidence missing or unknown";
	const { refs, refContinuity } = record;
	if (!Array.isArray(refs) || !refs.every((ref) => isFields(ref) && isText(ref.bcp) && isOptional(ref.ours, isText))) return "ref evidence missing";
	if (!isFields(refContinuity) || !isCount(refContinuity.same) || !isCount(refContinuity.used)
		|| refContinuity.same > refContinuity.used || refContinuity.used !== refs.length) return "ref evidence capped or inconsistent";
	// Capped ids cannot support the report's created/absorbed/active cross-checks.
	if ([record.ours, record.bcp].some((blocks) => isFields(blocks) && blocks.blockIdsCapped === true)) return "block ids capped";
	return undefined;
}

function requestFault(record: Fields): string | undefined {
	const { toolCallIds } = record;
	if (!Array.isArray(toolCallIds) || !toolCallIds.length || !toolCallIds.every(isId)) return "call ids missing";
	for (const side of ["ours", "bcp"] as const) {
		const fault = requestHashesFault(record[side]);
		if (fault) return `${side} request hashes invalid: ${fault}`;
	}
	// Optional: only a batch with refused calls and a counterfactual preview has it.
	if (record.counterfactualOurs !== undefined) {
		const fault = requestHashesFault(record.counterfactualOurs);
		if (fault) return `counterfactualOurs request hashes invalid: ${fault}`;
	}
	// The same reason as the comparison's own check, so the report shows one diagnostic, not two.
	return summaryEvidenceDiff(record.ours as RequestHashes)?.reason;
}
