import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FoldsConfig } from "../platform/config-layers.js";
import { INCONCLUSIVE_KINDS, isRefusalOutcome, PARITY_RECORD_VERSION, readParityRecords, type ParityRecord, type CompressRecord, type DiffKind, type NextRequestRecord, type ParityDiff, type RequestHashes } from "./records.js";
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

/** One line per diff kind for a reader of `/fold-parity`. The type forces a row for every kind. */
export const DIFF_KIND_LABELS: Record<DiffKind, string> = {
	"outcome": "the two engines ended the call differently (accepted, rejected, refused)",
	"error-type": "both rejected the call, for different reasons",
	"outcome-unknown": "a result or rejection reason could not be classified",
	"block-count": "the engines created a different number of folds",
	"coverage": "the folds cover different messages",
	"tier": "the folds have different tiers",
	"absorbed": "different earlier folds were absorbed into the new one",
	"input-parse": "the compress input was not fully parsed; items were dropped",
	"ref-unmapped": "a message ref could not be mapped to the native engine",
	"import-unsupported": "earlier folds in the side file could not be read or imported",
	"import-skipped": "not every earlier fold could be imported before the comparison",
	"side-file-missing": "billion-context-pi's side file was missing or unreadable",
	"too-large": "input exceeded a recorder bound",
	"recorder-error": "the recorder failed, or its evidence contradicts itself",
	"summaries": "fold summaries in the next request differ",
	"content": "non-summary message text in the next request differs",
	"tool-calls": "tool calls (ids, names or arguments) in the next request differ",
	"tool-results": "tool results in the next request differ",
	"tool-pairing": "tool calls and results are paired differently in the next request",
	"tool-evidence": "tool evidence in the next request is incomplete or repeats a call id",
	"tags-absent": "billion-context-pi's ref tags were not seen in the provider request",
};
/** Reasons a call could not be compared that are not diff kinds. */
export const PENDING_LABELS = {
	"next-request-pending": "the provider request after the call has not been recorded yet",
	"marked-inconclusive": "the record itself was stored as inconclusive",
} as const;
/** What each call bucket means; `diff` and `inconclusive` block cut-over. */
export const BUCKET_LABELS = {
	match: "same folds and the same next request in both engines",
	explained: "every difference is a documented one (see Known differences)",
	diff: "at least one undocumented difference; blocks cut-over",
	inconclusive: "the comparison could not be made; blocks cut-over",
} as const;
const BUCKET_NAMES = { match: "match", explained: "explained", diff: "different", inconclusive: "inconclusive" } as const;
const WINDOW = 500;
const DEFAULT_BLOCKING_LINES = 10;

/** Parts of the combined fingerprint, when the caller knows them. */
export interface FoldParityBuild {
	/** The engine fingerprint (`foldEngineFingerprint`), before the folds config is hashed in. */
	readonly engine?: string;
	/** The effective folds config hashed into the combined fingerprint. */
	readonly folds?: FoldsConfig;
}
export interface FoldParityReportOptions extends FoldParityBuild {
	/** List every blocking call with per-difference reasons, not only the newest ten. */
	readonly all?: boolean;
}
/** A window call that blocks cut-over. */
export interface BlockingCall {
	readonly at: string;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly nested: boolean;
	readonly bucket: "diff" | "inconclusive";
	readonly kinds: readonly string[];
	readonly reasons: readonly { readonly kind: string; readonly reason: string }[];
}

/** Machine-local time with an explicit UTC offset so the report identifies its zone. */
function shortTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const zone = offsetMinutes === 0
		? "UTC"
		: `${offsetMinutes > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Shorten a long provider id (`toolu_01Ph2KCt…` style) to 14 characters; keep a nested call's `/N` suffix and short ids whole. */
const shortCallId = (id: string) => id.split("/").map((part, i) => i === 0 && part.length > 20 ? part.slice(0, 14) : part).join("/");
const qualifiedIssue = (issue: string | undefined) => issue === undefined ? "" : issue.includes("/") ? issue : `intel/${issue}`;
const countRows = (counts: Record<string, number>) => Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
const BLOCKING_INCONCLUSIVE = (kind: DiffKind) => INCONCLUSIVE_KINDS.has(kind) || kind === "import-skipped";

export function buildFoldParityReport(allRecords: readonly ParityRecord[], register: readonly ParityRegisterEntry[], fingerprint: string, options: FoldParityReportOptions = {}) {
	const all = judgeParityCalls(allRecords, register, fingerprint);
	// Calls without a session file can never be compared; they neither count nor block readiness.
	const judgments = all.filter((judgment) => !judgment.notComparable);
	const notComparable = all.length - judgments.length;
	const window = judgments.slice(-WINDOW);
	const counts = { match: 0, explained: 0, diff: 0, inconclusive: 0 };
	const registerHits: Record<string, { calls: number; differences: number }> = {};
	const unexplainedKinds: Record<string, number> = {};
	const undocumentedKindCalls: Record<string, number> = {};
	const inconclusiveKindCalls: Record<string, number> = {};
	const blocking: BlockingCall[] = [];
	for (const { call, evidence, unexplained: unknown, hits: entryIds, missingRequest, inconclusive } of window) {
		for (const id of entryIds) (registerHits[id] ??= { calls: 0, differences: 0 }).differences++;
		for (const id of new Set(entryIds)) registerHits[id]!.calls++;
		for (const { diff } of unknown) unexplainedKinds[diff.kind] = (unexplainedKinds[diff.kind] ?? 0) + 1;
		if (missingRequest) unexplainedKinds["next-request-pending"] = (unexplainedKinds["next-request-pending"] ?? 0) + 1;
		for (const kind of new Set(unknown.map(({ diff }) => diff.kind).filter((kind) => !BLOCKING_INCONCLUSIVE(kind)))) undocumentedKindCalls[kind] = (undocumentedKindCalls[kind] ?? 0) + 1;
		if (inconclusive) {
			const reasons = new Set<string>(evidence.map(({ diff }) => diff.kind).filter(BLOCKING_INCONCLUSIVE));
			if (missingRequest) reasons.add("next-request-pending");
			if (!reasons.size) reasons.add("marked-inconclusive");
			for (const kind of reasons) inconclusiveKindCalls[kind] = (inconclusiveKindCalls[kind] ?? 0) + 1;
		}
		if (inconclusive) counts.inconclusive++;
		else if (unknown.length) counts.diff++;
		else if (evidence.length) counts.explained++;
		else counts.match++;
		if (inconclusive || unknown.length) {
			blocking.push({
				at: call.at, sessionId: call.sessionId, toolCallId: call.toolCallId, nested: call.nested === true, bucket: inconclusive ? "inconclusive" : "diff",
				kinds: [...new Set(evidence.map(({ diff }) => diff.kind)), ...(missingRequest ? ["next-request-pending"] : [])],
				reasons: [...new Map(evidence.filter(({ diff }) => typeof diff.reason === "string").map(({ diff }) => [`${diff.kind}\u0000${diff.reason}`, { kind: diff.kind, reason: diff.reason! }])).values()],
			});
		}
	}
	blocking.reverse();
	const count = judgments.length;
	const ready = count >= WINDOW && counts.diff === 0 && counts.inconclusive === 0;
	// Records that exist but do not count: other builds' calls and older schema versions.
	const others = allRecords.filter((record): record is CompressRecord => record.kind === "compress" && record.v === PARITY_RECORD_VERSION && record.fingerprint !== fingerprint);
	const earlierBuilds = { calls: others.length, builds: new Set(others.map((record) => record.fingerprint)).size };
	const olderVersionCalls = allRecords.filter((record) => record.kind === "compress" && record.v !== PARITY_RECORD_VERSION).length;
	const windowInfo = window.length ? { calls: window.length, sessions: new Set(window.map(({ call }) => call.sessionId)).size, from: window[0]!.call.at, to: window.at(-1)!.call.at } : undefined;
	return {
		count, counts, ready, unexplainedKinds, notComparable,
		fingerprint, engine: options.engine, folds: options.folds,
		window: windowInfo, earlierBuilds, olderVersionCalls,
		undocumentedKindCalls, inconclusiveKindCalls, registerHits, blocking,
		text: renderReport({ count, counts, ready, notComparable, fingerprint, options, windowInfo, earlierBuilds, olderVersionCalls, undocumentedKindCalls, inconclusiveKindCalls, registerHits, blocking, register }),
	};
}

function renderReport(report: {
	readonly count: number; readonly counts: Record<keyof typeof BUCKET_LABELS, number>; readonly ready: boolean; readonly notComparable: number;
	readonly fingerprint: string; readonly options: FoldParityReportOptions;
	readonly windowInfo: { calls: number; sessions: number; from: string; to: string } | undefined;
	readonly earlierBuilds: { calls: number; builds: number }; readonly olderVersionCalls: number;
	readonly undocumentedKindCalls: Record<string, number>; readonly inconclusiveKindCalls: Record<string, number>;
	readonly registerHits: Record<string, { calls: number; differences: number }>; readonly blocking: readonly BlockingCall[];
	readonly register: readonly ParityRegisterEntry[];
}): string {
	const { count, counts, ready, options } = report;
	const lines = ["Fold parity: native fold engine shadowing billion-context-pi", ""];
	if (ready) lines.push(`Ready to cut over. The latest ${WINDOW} of ${count} comparable calls have no undocumented differences and none was inconclusive.`);
	else {
		const blockers = [
			...(counts.diff ? [`${counts.diff} ${counts.diff === 1 ? "has" : "have"} differences no known entry explains`] : []),
			...(counts.inconclusive ? [`${counts.inconclusive} could not be compared`] : []),
		].join(" and ");
		const progress = count < WINDOW ? `${count} of ${WINDOW} calls recorded` : `In the latest ${WINDOW} of ${count} calls`;
		const reason = blockers || `${WINDOW - count} more ${WINDOW - count === 1 ? "is" : "are"} needed`;
		lines.push(`Not ready to cut over. ${progress}; ${reason}.`);
	}
	lines.push("");
	const parts = [
		...(options.engine ? [`engine ${options.engine.slice(0, 12)}`] : []),
		...(options.folds ? [`folds.firstUserMessage ${options.folds.firstUserMessage}, firstUserMessageMaxTokens ${options.folds.firstUserMessageMaxTokens}`] : []),
	];
	lines.push(`Build    fingerprint ${report.fingerprint.slice(0, 12)}${parts.length ? ` = ${parts.join(" + ")}` : ""}`);
	const win = report.windowInfo;
	lines.push(win
		? `Window   ${plural(win.calls, "compress call")} in ${plural(win.sessions, "session")}, ${shortTime(win.from)} to ${shortTime(win.to)}`
		: "Window   no comparable calls under this fingerprint yet");
	const notCounted = [
		...(report.notComparable ? [`${plural(report.notComparable, "call")} in a session with no file`] : []),
		...(report.earlierBuilds.calls ? [`${plural(report.earlierBuilds.calls, "call")} from ${plural(report.earlierBuilds.builds, "earlier build")}`] : []),
		...(report.olderVersionCalls ? [`${plural(report.olderVersionCalls, "call")} from an older record version`] : []),
	];
	if (notCounted.length) lines.push(`         Not counted: ${notCounted.join("; ")}`);
	const section = (title: string, rows: readonly string[]) => { if (rows.length) lines.push("", title, ...rows); };
	const countWidth = (values: readonly number[]) => Math.max(5, ...values.map((value) => String(value).length + 2));
	const labelled = (rows: readonly [string, number][], label: (key: string) => string) => {
		const width = countWidth(rows.map(([, n]) => n));
		const nameWidth = Math.max(...rows.map(([name]) => name.length)) + 2;
		return rows.map(([name, n]) => `${String(n).padStart(width)}  ${name.padEnd(nameWidth)}${label(name)}`);
	};
	if (win) section("Calls", labelled((Object.keys(BUCKET_LABELS) as (keyof typeof BUCKET_LABELS)[]).map((bucket) => [BUCKET_NAMES[bucket], counts[bucket]]), (name) => BUCKET_LABELS[(Object.keys(BUCKET_NAMES) as (keyof typeof BUCKET_NAMES)[]).find((bucket) => BUCKET_NAMES[bucket] === name)!]));
	const kindLabel = (kind: string) => DIFF_KIND_LABELS[kind as DiffKind] ?? PENDING_LABELS[kind as keyof typeof PENDING_LABELS] ?? "";
	section("Undocumented differences (calls affected)", labelled(countRows(report.undocumentedKindCalls), kindLabel));
	section("Could not compare (calls)", labelled(countRows(report.inconclusiveKindCalls), kindLabel));
	const hits = report.register.filter((entry) => report.registerHits[entry.id]);
	const unknownHits = Object.keys(report.registerHits).filter((id) => !report.register.some((entry) => entry.id === id));
	const hitRows = [...hits.map((entry) => ({ id: entry.id as string, title: entry.title, issue: qualifiedIssue(entry.issue) })), ...unknownHits.map((id) => ({ id, title: "", issue: "" }))]
		.map((row) => ({ ...row, numbers: `${report.registerHits[row.id]!.calls}; ${report.registerHits[row.id]!.differences}` }));
	const titleWidth = Math.max(0, ...hitRows.map((row) => row.title.length));
	const numberWidth = Math.max(0, ...hitRows.map((row) => row.numbers.length));
	section("Known differences that applied (calls; differences)", hitRows.map((row) => `   ${row.id}  ${row.title.padEnd(titleWidth)}  ${row.numbers.padStart(numberWidth)}${row.issue ? `  ${row.issue}` : ""}`.trimEnd()));
	const shown = options.all ? report.blocking : report.blocking.slice(0, DEFAULT_BLOCKING_LINES);
	const blockingTitle = options.all
		? `Calls that block cut-over (${report.blocking.length}, newest first)`
		: `Newest calls that block cut-over (${shown.length} of ${report.blocking.length}; /fold-parity all lists every one)`;
	section(blockingTitle, shown.flatMap((call) => [
		`   ${shortTime(call.at)}  session ${call.sessionId.slice(0, 8)}  ${shortCallId(call.toolCallId)}  ${call.kinds.join(", ")}${call.nested ? "  nested" : ""}`,
		...(options.all ? call.reasons.map(({ kind, reason }) => `      ${kind}: ${reason}`) : []),
	]));
	lines.push("", `Cut-over needs the latest ${WINDOW} comparable calls under one fingerprint with none different and none inconclusive.`,
		"Changing the fold engine or folds config starts a new count. Reference: docs/fold-parity.md");
	return lines.join("\n");
}

export function registerFoldParityCommand(pi: ExtensionAPI, options: {
	agentDir: string;
	fingerprint: string | ((ctx: ExtensionContext) => string);
	/** The engine fingerprint and effective folds config behind the combined fingerprint, for display. */
	build?: (ctx: ExtensionContext) => FoldParityBuild;
	flush?: () => Promise<void>;
}): void {
	pi.registerCommand("fold-parity", {
		description: "Report shadow fold comparisons and readiness toward 500 calls. `/fold-parity all` lists every blocking call.",
		handler: async (args, ctx) => {
			try {
				await options.flush?.();
				const fingerprint = typeof options.fingerprint === "string" ? options.fingerprint : options.fingerprint(ctx);
				const all = (args ?? "").trim().split(/\s+/u).includes("all");
				ctx.ui.notify(buildFoldParityReport(await readParityRecords(options.agentDir), PARITY_REGISTER, fingerprint, { ...options.build?.(ctx), all }).text, "info");
			} catch {
				ctx.ui.notify("Fold parity report could not read diagnostics; readiness is unknown.", "error");
			}
		},
	});
}
