import { STUB_SUMMARY_CODE } from "../folds/stub-summary.js";
import { compareNextRequest, contentKeys, expectedSummariesMatch } from "./compare.js";
import { isRequestHashes, refusalEvidence, type RefusalEvidence } from "./evidence.js";
import type { CompressRecord, DiffKind, NextRequestRecord, ParityDiff, RefusalOutcome, RequestHashes } from "./records.js";

export interface ParityRegisterEntry {
	readonly id: `FP-${number}`;
	readonly title: string;
	readonly reason: string;
	readonly issue?: string;
	/** `request` is the next-request record of the batch that holds `record`; it is set for the request's differences and, when exactly one request follows the call, for the call's own. */
	readonly matches: (diff: ParityDiff, record: CompressRecord, request?: NextRequestRecord) => boolean;
}
const calls = (request: RequestHashes, compact: boolean) => request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => JSON.stringify([call.id, call.name, compact && call.name === "compress" ? call.compactedArgsHash ?? call.argsHash : call.argsHash]))).sort();
const complete = (request: RequestHashes) => request.total === request.messages.length && !request.messages.some((message) => message.toolEvidence);


/** Call differences that follow when the native preview folds a call billion-context-pi refused. */
const CALL_CONSEQUENCES: ReadonlySet<DiffKind> = new Set(["block-count", "coverage", "tier", "absorbed"]);
/** Next-request differences that the same extra native fold can cause. */
const REQUEST_CONSEQUENCES: ReadonlySet<DiffKind> = new Set(["summaries", "content", "tool-calls", "tool-results"]);

/**
 * True when the difference lists nothing on the billion-context-pi side. A difference without
 * either field (block-count, tier) qualifies; a count and an id list that disagree do not.
 */
function nothingOnBcpSide(diff: ParityDiff): boolean {
	const { bcpOnlyCount: count, bcpOnly: ids } = diff;
	if (ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) return false;
	return count === undefined || count === 0;
}

/**
 * True when the request record shows that the batch's refusals alone cause its differences: a call
 * in the batch was refused with `type`, a native preview of the batch without the refused calls
 * matched billion-context-pi's request, and the full native request differs from that preview only
 * by the refused calls' own folds. The decision uses only the request record, so it does not depend
 * on which calls of the batch are inside the report window. The refusal, counterfactual and delta
 * evidence must pass the shared validator (`refusalEvidenceFault`) first: a partial or malformed
 * record proves nothing.
 */
function causedByRefusals(request: NextRequestRecord, record: CompressRecord, type: RefusalOutcome): boolean {
	const evidence = refusalEvidence(request);
	if (!evidence || evidence.delta.verdict !== "refused-folds-only" || !counterfactualExplained(request, evidence, record)) return false;
	return evidence.refused.some((call) => call.type === type);
}

/**
 * True when every difference between the counterfactual native request and billion-context-pi's is
 * one that `KNOWN_REQUEST_DIFFERENCES` explains on the counterfactual's own evidence. Differences
 * are recomputed from that evidence and joined with the stored ones, so a stored empty list cannot
 * hide one. A known difference from earlier in the session (a summary billion-context-pi drops, a
 * shortened compress summary, a folded opening message) is in both native requests, so it would
 * otherwise keep every later refusal unexplained. Missing or malformed evidence explains nothing.
 */
function counterfactualExplained(request: NextRequestRecord, evidence: RefusalEvidence, record: CompressRecord): boolean {
	const { counterfactualOurs: ours } = evidence;
	const { bcp } = request;
	if (!isRequestHashes(bcp)) return false;
	// The known-difference entries see the counterfactual request in place of the full one.
	const view: NextRequestRecord = { ...request, ours };
	const diffs: readonly unknown[] = [...evidence.diffs, ...compareNextRequest(ours, bcp).diffs];
	return diffs.every((diff) => typeof diff === "object" && diff !== null
		&& KNOWN_REQUEST_DIFFERENCES.some((entry) => entry.matches(diff as ParityDiff, record, view)));
}

/**
 * Explains a call that billion-context-pi refused with `type` and nothing else about it: the
 * outcome difference itself, call differences that come only from the native preview folding
 * more than billion-context-pi, which created nothing, and next-request differences that only the
 * refused calls' folds cause (`causedByRefusals`). A difference in the other direction, one that
 * remains when the native preview also created nothing, one the counterfactual preview keeps, or one
 * the structural check does not attribute to the refused folds, stays unexplained.
 */
function refusedBy(type: RefusalOutcome) {
	return (diff: ParityDiff, record: CompressRecord, request?: NextRequestRecord): boolean => {
		// The report passes the batch's request with the call's own differences too, so the kind decides.
		if (REQUEST_CONSEQUENCES.has(diff.kind)) return !!request && causedByRefusals(request, record, type);
		if (record.bcpOutcome?.type !== type || record.bcpOutcome.reasons.length) return false;
		if (diff.kind === "outcome") return record.oursOutcome !== undefined && diff.reason === `ours=${record.oursOutcome.type}; bcp=${type}`;
		if (record.bcp?.count !== 0 || !record.ours?.count) return false;
		return CALL_CONSEQUENCES.has(diff.kind) && nothingOnBcpSide(diff);
	};
}

/** Call differences that follow when the native adapter refuses a fold billion-context-pi made. */
const STUB_CONSEQUENCES: ReadonlySet<DiffKind> = new Set(["block-count", "coverage", "tier", "absorbed"]);

/** True when the difference lists nothing on the native side. */
function nothingOnOurSide(diff: ParityDiff): boolean {
	const { oursOnlyCount: count, oursOnly: ids } = diff;
	if (ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) return false;
	return count === undefined || count === 0;
}

/**
 * Explains the call differences of a call the native adapter refused as a cut-off summary
 * (`stub-summary`) while billion-context-pi folded it: the outcome difference, and block-count,
 * tier, coverage and absorbed differences where the native preview created fewer folds and
 * lists nothing billion-context-pi lacks. The next request's differences stay unexplained: no
 * evidence shows that the missing fold alone causes them.
 */
function refusedStubSummary(diff: ParityDiff, record: CompressRecord): boolean {
	if (!record.oursOutcome?.reasons.includes(STUB_SUMMARY_CODE) || record.bcpOutcome?.type !== "accepted") return false;
	if (diff.kind === "outcome") return diff.reason === `ours=${record.oursOutcome.type}; bcp=accepted` && (record.oursOutcome.type === "rejected" || record.oursOutcome.type === "partial");
	if ((record.ours?.count ?? 0) >= (record.bcp?.count ?? 0)) return false;
	return STUB_CONSEQUENCES.has(diff.kind) && nothingOnOurSide(diff);
}

/**
 * Known request differences between the native engine and billion-context-pi, each judged on the
 * request evidence it is given. The refusal entries below apply these same entries to the
 * counterfactual request (`counterfactualExplained`). Only evidence-backed differences are
 * explained; missing historical evidence stays unknown.
 */
const KNOWN_REQUEST_DIFFERENCES: readonly ParityRegisterEntry[] = [
	{
		id: "FP-001", title: "Summary placement", issue: "pi-context-aware#175",
		reason: "Native folds send their summary message; bcp drops every rendered acp_summary message.",
		matches: (diff, _call, request) => diff.kind === "summaries" && !!request?.ours && !!request.bcp
			&& complete(request.ours) && complete(request.bcp)
			&& !!request.ours.expectedSummaryHashes?.length && expectedSummariesMatch(request.ours)
			&& !request.ours.messages.some((message) => message.summary && message.toolResult)
			&& !request.bcp.messages.some((message) => message.summary),
	},
	{
		id: "FP-002", title: "Compress-call arguments", issue: "pi-context-aware#130",
		reason: "bcp shortens summaries over 200 characters inside compress arguments; native requests keep them verbatim.",
		matches: (diff, _call, request) => diff.kind === "tool-calls" && !!request?.ours && !!request.bcp
			&& complete(request.ours) && complete(request.bcp)
			&& request.ours.messages.some((message) => message.toolCalls?.some((call) => call.name === "compress" && call.compactedArgsHash && call.compactedArgsHash !== call.argsHash))
			&& JSON.stringify(calls(request.ours, true)) === JSON.stringify(calls(request.bcp, false)),
	},
	{
		id: "FP-003", title: "First user message folded", issue: "pi-context-aware#130",
		reason: "The effective native policy folded the opening user; bcp pins it even when its block covers it.",
		matches: (diff, _call, request) => {
			if (diff.kind !== "content" || !request?.ours?.firstUserFolded || !request.bcp || !complete(request.ours) || !complete(request.bcp)) return false;
			const first = request.ours.firstUserFolded;
			if (first.role !== "user" || first.summary) return false;
			const replacementHash = request.ours.firstUserReplacementHash;
			const replacementIndex = request.ours.messages.findIndex((message) => message.summary && message.hash === replacementHash);
			if (request.ours.messages[replacementIndex]?.role !== "user") return false;
			const firstAssistant = request.ours.messages.findIndex((message) => message.role === "assistant");
			if (firstAssistant >= 0 && replacementIndex >= firstAssistant) return false;
			const theirs = contentKeys(request.bcp);
			const index = theirs.indexOf(`user:${first.hash}`);
			if (index < 0) return false;
			theirs.splice(index, 1);
			return JSON.stringify(contentKeys(request.ours)) === JSON.stringify(theirs);
		},
	},
];

/** Every entry is documented in docs/fold-parity.md under the same id. */
export const PARITY_REGISTER: readonly ParityRegisterEntry[] = [
	...KNOWN_REQUEST_DIFFERENCES,
	{ id: "FP-004", title: "Retry cap", issue: "pi-context-aware#131", reason: "billion-context-pi refuses every compress call after three failed calls in a turn; the native engine has no retry cap.", matches: refusedBy("capped-retry") },
	{ id: "FP-005", title: "Dead-range breaker", issue: "pi-context-aware#131", reason: "billion-context-pi refuses an exact compress call that already failed; the native engine evaluates every call.", matches: refusedBy("dead-range") },
	{ id: "FP-006", title: "Tier-3 rewrite rejection", issue: "pi-context-aware#131", reason: "billion-context-pi refuses a call that only re-condenses tier-3 blocks; the native engine has no such rejection.", matches: refusedBy("tier3-rewrite") },
	{ id: "FP-007", title: "Abort", issue: "pi-context-aware#131", reason: "billion-context-pi stops a call when its signal aborts; the native preview runs to completion.", matches: refusedBy("aborted") },
	{ id: "FP-008", title: "Cut-off summaries are refused", issue: "pi-context-aware#173", reason: "The native adapter refuses a summary of at most 200 characters that ends in \"\u2026\", or a copied fold pointer; billion-context-pi folds the range into that one line.", matches: refusedStubSummary },
];
