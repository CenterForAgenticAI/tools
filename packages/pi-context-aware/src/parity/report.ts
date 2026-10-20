import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INCONCLUSIVE_KINDS, isRefusalOutcome, PARITY_RECORD_VERSION, readParityRecords, type ParityRecord, type CompressRecord, type NextRequestRecord, type ParityDiff, type RequestHashes } from "./records.js";
import { PARITY_REGISTER, type ParityRegisterEntry } from "./register.js";
import { canonicalJson, compareBlockEvidence, compareNextRequest, MAX_MESSAGE_HASHES, summaryEvidenceDiff } from "./compare.js";
import { compareOutcomes } from "./outcome.js";
import { isBlockEvidence, isComparableBlockEvidence, isOutcomeEvidence, isRequestHashes, parityEvidenceFault } from "./evidence.js";
import { sessionHasNoFile } from "./side-file.js";

/** All-record, difference-level diagnostics, including historical schemas.
 * Missing evidence stays unexplained. This does not establish cut-over readiness.
 */
export function aggregateParityDifferences(records: readonly ParityRecord[], register: readonly ParityRegisterEntry[]) {
	const calls = new Map(records.filter((record): record is CompressRecord => record.kind === "compress")
		.map((record) => [JSON.stringify([record.fingerprint, record.sessionId, record.toolCallId]), record]));
	const explainedKinds: Record<string, number> = {};
	const unexplainedKinds: Record<string, number> = {};
	const registerHits: Record<string, number> = {};
	for (const record of records) {
		const call = record.kind === "compress" ? record : record.toolCallIds
			.map((id) => calls.get(JSON.stringify([record.fingerprint, record.sessionId, id]))).find((call) => call !== undefined);
		for (const diff of record.diffs) {
			const entry = call && register.find((entry) => entry.matches(diff, call, record.kind === "next-request" ? record : undefined));
			const counts = entry ? explainedKinds : unexplainedKinds;
			counts[diff.kind] = (counts[diff.kind] ?? 0) + 1;
			if (entry) registerHits[entry.id] = (registerHits[entry.id] ?? 0) + 1;
		}
	}
	return { explainedKinds, unexplainedKinds, registerHits };
}

/** A conclusive record without the evidence the shared validator requires is a recorder fault. */
function recordEvidenceFault(record: ParityRecord): ParityDiff | undefined {
	const reason = parityEvidenceFault(record);
	return reason === undefined ? undefined : { kind: "recorder-error", reason };
}

/** A union preserves stored diagnostics that bounded evidence cannot reproduce. */
function unionDiffs(...lists: readonly (readonly ParityDiff[])[]): ParityDiff[] {
	return [...new Map(lists.flat().map((diff) => [canonicalJson(diff), diff])).values()];
}
function reportDiffs(record: ParityRecord): ParityDiff[] {
	const fault = recordEvidenceFault(record);
	const recomputed: ParityDiff[] = [];
	if (record.kind === "compress") {
		if (record.parseKind !== undefined && (record.parseKind !== "ok" || (record.parseInvalidItems ?? 0) > 0)) {
			recomputed.push({ kind: "input-parse", reason: `${record.parseKind}; invalidItems=${record.parseInvalidItems ?? 0}` });
		}
		if (record.refs?.some((ref) => !ref.ours || ref.ours === "BLOCKED")) recomputed.push({ kind: "ref-unmapped" });
		// Inconsistent evidence is already a recorder fault; comparing it as well keeps the specific diagnostic.
		if (isComparableBlockEvidence(record.ours) && isComparableBlockEvidence(record.bcp)) recomputed.push(...compareBlockEvidence(record.ours, record.bcp));
		if (isOutcomeEvidence(record.oursOutcome) && isOutcomeEvidence(record.bcpOutcome)) recomputed.push(...compareOutcomes(record.oursOutcome, record.bcpOutcome));
	} else if (isRequestHashes(record.ours) && isRequestHashes(record.bcp)) recomputed.push(...compareNextRequest(record.ours, record.bcp).diffs);
	else if (!fault) {
		const invalid = summaryEvidenceDiff(record.ours);
		if (invalid) recomputed.push(invalid);
	}
	return unionDiffs(record.diffs, recomputed, fault ? [fault] : []);
}

/** IDs are unique within a preview; absorbed records remain on its branch.
 * Include within-call absorption as well as later linked calls. Imports may be
 * active without being created in this batch, but may not survive absorption.
 */
function activeFoldBoundDiff(record: NextRequestRecord, calls: ReadonlyMap<string, CompressRecord>): ParityDiff | undefined {
	const fault = (reason: string): ParityDiff => ({ kind: "recorder-error", reason });
	if (!record.ours || !Array.isArray(record.toolCallIds)) return undefined;
	const request = refusalBoundView(record as NextRequestRecord & { readonly ours: RequestHashes }, calls);
	const summaryFault = summaryEvidenceDiff(request.ours);
	if (summaryFault) return summaryFault;
	const ids = request.ours.activeFoldIds;
	const validIds = (list: readonly string[] | undefined): list is readonly string[] => Array.isArray(list)
		&& list.length <= MAX_MESSAGE_HASHES && list.every((id) => typeof id === "string" && /^b\d+$/u.test(id))
		&& new Set(list).size === list.length;
	if (!validIds(ids) || request.ours.activeFoldIdsCapped || ids.length !== request.ours.activeFoldCount
		|| JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
		return fault("active block ids missing, capped or inconsistent with summary evidence");
	}
	const active = new Set(ids);
	const created = new Set<string>();
	const absorbed = new Set<string>();
	for (const id of request.toolCallIds) {
		const call = calls.get(JSON.stringify([request.sessionId, id]));
		if (!call || !isBlockEvidence(call.ours)) return fault("linked batch block evidence unavailable");
		const blocks = call.ours;
		if (!validIds(blocks.createdIds) || !validIds(blocks.absorbed) || blocks.blockIdsCapped
			|| blocks.createdIds.length !== blocks.count) return fault("linked block ids missing, capped or inconsistent with count");
		for (const blockId of blocks.createdIds) {
			if (created.has(blockId) || absorbed.has(blockId)) return fault("linked batch reuses a block id");
			created.add(blockId);
		}
		for (const blockId of blocks.absorbed) absorbed.add(blockId);
	}
	for (const id of created) if (!absorbed.has(id) && !active.has(id)) return fault(`created block ${id} missing from active ids`);
	for (const id of absorbed) if (active.has(id)) return fault(`absorbed block ${id} remains active`);
	return undefined;
}

/**
 * The request evidence the active-fold bound checks. Each call's compress record is previewed alone
 * from billion-context-pi's side file, so after a call billion-context-pi refused but the native
 * preview folded, later calls in the batch allocate the same native block ids as the refused fold
 * and the bound cannot hold on the full request. The counterfactual preview omits exactly those calls,
 * so its native state follows billion-context-pi's: the bound is checked there, with only the calls it
 * kept. `refusedFoldDelta` ties the full request to that counterfactual. Without counterfactual evidence
 * the full request is checked as recorded, and a reused id stays a recorder fault.
 */
function refusalBoundView(request: NextRequestRecord & { readonly ours: RequestHashes }, calls: ReadonlyMap<string, CompressRecord>): NextRequestRecord & { readonly ours: RequestHashes } {
	const { refused, counterfactualOurs } = request;
	if (!Array.isArray(refused) || !refused.length || counterfactualOurs === undefined) return request;
	// A call is omitted only when its own compress record confirms the refusal and that billion-context-pi made no fold.
	const confirmed = (id: string) => refused.some((entry) => entry?.toolCallId === id && isRefusalOutcome(entry.type)
		&& calls.get(JSON.stringify([request.sessionId, id]))?.bcpOutcome?.type === entry.type
		&& calls.get(JSON.stringify([request.sessionId, id]))?.bcp?.count === 0);
	return { ...request, ours: counterfactualOurs, toolCallIds: request.toolCallIds.filter((id) => !confirmed(id)) };
}

/** A diff with the record it came from and the request a register entry sees. */
export interface ParityEvidence {
	readonly diff: ParityDiff;
	readonly source: "compress" | "next-request";
	readonly request?: NextRequestRecord;
}

/** One call's judgment. The readiness report and the CI differential both count calls from it. */
export interface ParityCallJudgment {
	readonly call: CompressRecord;
	readonly requests: readonly NextRequestRecord[];
	/** Recomputed diffs joined with stored diffs, for the call and each linked request. */
	readonly evidence: readonly ParityEvidence[];
	/** Evidence no register entry explains. */
	readonly unexplained: readonly ParityEvidence[];
	/** The register entry that explained each explained diff. */
	readonly hits: readonly string[];
	readonly missingRequest: boolean;
	readonly inconclusive: boolean;
	/**
	 * The call ran in a session without a session file, so billion-context-pi kept no side file to
	 * compare with. The readiness report leaves it out of the count; the call is still inconclusive.
	 */
	readonly notComparable: boolean;
}

/**
 * Judge every current-version call with this fingerprint, oldest first. Diffs are recomputed from
 * each record's evidence and joined with its stored diffs, so a stored match cannot hide evidence
 * that disagrees.
 */
export function judgeParityCalls(allRecords: readonly ParityRecord[], register: readonly ParityRegisterEntry[], fingerprint: string): ParityCallJudgment[] {
	// Older record versions lack evidence this version compares; they never count toward readiness.
	const records = allRecords.filter((record) => record.v === PARITY_RECORD_VERSION);
	const calls = records.filter((record): record is CompressRecord => record.kind === "compress" && record.fingerprint === fingerprint).sort((a, b) => a.at.localeCompare(b.at));
	const requestsByCall = new Map<string, NextRequestRecord[]>();
	const key = (sessionId: string, toolCallId: string) => JSON.stringify([sessionId, toolCallId]);
	// The recorder writes one compress record and one linking request per call. Duplicates would let one call count many times.
	const callsById = new Map<string, CompressRecord>();
	const duplicateCalls = new Set<string>();
	for (const call of calls) {
		const callKey = key(call.sessionId, call.toolCallId);
		if (callsById.has(callKey)) duplicateCalls.add(callKey);
		callsById.set(callKey, call);
	}
	const requestDiffs = new Map<NextRequestRecord, ParityDiff[]>();
	for (const record of records) {
		if (record.kind !== "next-request" || record.fingerprint !== fingerprint) continue;
		const ids = Array.isArray(record.toolCallIds) ? record.toolCallIds : [];
		const linkFault = new Set(ids).size !== ids.length ? "next request lists a call more than once"
			: ids.some((id) => duplicateCalls.has(key(record.sessionId, id))) ? "next request links a call that has more than one compress record" : undefined;
		const bound: ParityDiff | undefined = linkFault ? { kind: "recorder-error", reason: linkFault } : activeFoldBoundDiff(record, callsById);
		requestDiffs.set(record, unionDiffs(reportDiffs(record), bound ? [bound] : []));
		for (const id of new Set(ids)) {
			const callKey = key(record.sessionId, id);
			requestsByCall.set(callKey, [...(requestsByCall.get(callKey) ?? []), record]);
		}
	}
	return calls.map((call) => {
		const callKey = key(call.sessionId, call.toolCallId);
		const requests = requestsByCall.get(callKey) ?? [];
		const identityFaults: ParityDiff[] = [
			...(duplicateCalls.has(callKey) ? [{ kind: "recorder-error" as const, reason: "more than one compress record for this call" }] : []),
			...(requests.length > 1 ? [{ kind: "recorder-error" as const, reason: `call linked by ${requests.length} next requests` }] : []),
		];
		// The call's own diffs see the request that followed it, as that request's diffs do.
		const followed = requests.length === 1 ? requests[0] : undefined;
		const evidence: ParityEvidence[] = [
			...unionDiffs(reportDiffs(call), identityFaults).map((diff) => ({ diff, source: "compress" as const, request: followed })),
			...requests.flatMap((request) => (requestDiffs.get(request) ?? []).map((diff) => ({ diff, source: "next-request" as const, request }))),
		];
		const hits: string[] = [];
		const unexplained = evidence.filter(({ diff, request }) => {
			const entry = register.find((entry) => entry.matches(diff, call, request));
			if (entry) hits.push(entry.id);
			return !entry;
		});
		const missingRequest = requests.length === 0;
		const inconclusive = missingRequest || call.verdict === "inconclusive" || requests.some((request) => request.verdict === "inconclusive")
			|| evidence.some(({ diff }) => INCONCLUSIVE_KINDS.has(diff.kind) || diff.kind === "import-skipped");
		const notComparable = Array.isArray(call.diffs) && call.diffs.some(sessionHasNoFile);
		return { call, requests, evidence, unexplained, hits, missingRequest, inconclusive, notComparable };
	});
}

export function buildFoldParityReport(allRecords: readonly ParityRecord[], register: readonly ParityRegisterEntry[], fingerprint: string) {
	const all = judgeParityCalls(allRecords, register, fingerprint);
	// Calls without a session file can never be compared; they neither count nor block readiness.
	const judgments = all.filter((judgment) => !judgment.notComparable);
	const notComparable = all.length - judgments.length;
	const window = judgments.slice(-500);
	const counts = { match: 0, explained: 0, diff: 0, inconclusive: 0 };
	const hits = new Map<string, number>();
	const unexplained: string[] = [];
	const unexplainedKinds: Record<string, number> = {};
	for (const { call, evidence, unexplained: unknown, hits: entryIds, missingRequest, inconclusive } of window) {
		for (const id of entryIds) hits.set(id, (hits.get(id) ?? 0) + 1);
		for (const { diff } of unknown) unexplainedKinds[diff.kind] = (unexplainedKinds[diff.kind] ?? 0) + 1;
		if (missingRequest) unexplainedKinds["next-request-pending"] = (unexplainedKinds["next-request-pending"] ?? 0) + 1;
		if (inconclusive) counts.inconclusive++;
		else if (unknown.length) counts.diff++;
		else if (evidence.length) counts.explained++;
		else counts.match++;
		if ((inconclusive || unknown.length) && unexplained.length < 20) unexplained.push(`${call.at} ${call.sessionId} ${call.toolCallId} nested=${call.nested} ${[...new Set(evidence.map(({ diff }) => diff.kind)), ...(missingRequest ? ["next-request-pending"] : [])].join(", ")}`);
	}
	const count = judgments.length;
	const ready = count >= 500 && counts.diff === 0 && counts.inconclusive === 0;
	return {
		count, counts, ready, unexplainedKinds, notComparable,
		text: [`Fold parity ${fingerprint.slice(0, 12)}`, `count ${count}/500 (window ${window.length})`, ...(notComparable ? [`not comparable ${notComparable} (session has no file)`] : []), `match ${counts.match} / explained ${counts.explained} / diff ${counts.diff} / inconclusive ${counts.inconclusive}`, ...[...hits].map(([id, count]) => `${id}: ${count}`), `Ready: ${ready ? "yes" : "no"}`, ...unexplained].join("\n"),
	};
}

export function registerFoldParityCommand(pi: ExtensionAPI, options: { agentDir: string; fingerprint: string | ((ctx: ExtensionContext) => string); flush?: () => Promise<void> }): void {
	pi.registerCommand("fold-parity", {
		description: "Report shadow fold comparisons and readiness toward 500 calls.",
		handler: async (_args, ctx) => {
			try {
				await options.flush?.();
				ctx.ui.notify(buildFoldParityReport(await readParityRecords(options.agentDir), PARITY_REGISTER, typeof options.fingerprint === "string" ? options.fingerprint : options.fingerprint(ctx)).text, "info");
			} catch {
				ctx.ui.notify("Fold parity report could not read diagnostics; readiness is unknown.", "error");
			}
		},
	});
}
