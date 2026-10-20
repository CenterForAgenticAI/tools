import { createHash } from "node:crypto";
import { SessionManager, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { importAcpSideFile } from "../folds/acp-import.js";
import { entryToCoreMessages, foldStateFromBranch, keptFirstUserId, planFold, summaryLimitOf, type BranchFoldState, type FoldRequest } from "../folds/fold-adapter.js";
import type { FoldsConfig } from "../platform/config-layers.js";
import { applyFoldDrafts } from "../folds/fold-engine.js";
import { coveredEntryIds, foldDrafts, isEditableEntry, readFoldRecord, type FoldRecord } from "../folds/fold-entries.js";
import { parseCompressArgs } from "../folds/kernel/parse-compress-input.js";
import { baseIdOf, SUMMARY_HEADER } from "../folds/kernel/prune.js";
import { bcpOutcome, compareOutcomes, nativeOutcome, rejectedUnknownRef, type ObservedResult } from "./outcome.js";
import { verdictFor, type BlockEvidence, type Verdict, type OutcomeEvidence, type ParityDiff, type RefusalOutcome, type RefusedCall, type RequestDelta, type RequestDeltaReason, type RequestHashes, type ToolCallHash, type ToolResultHash, type MessageHash } from "./records.js";
import type { SideSnapshot } from "./side-file.js";

export const MAX_BRANCH_ENTRIES = 50_000;
export const MAX_MESSAGE_HASHES = 2_000;
/** BlockEvidence keeps this many sorted coverage ids; `coverageHash` covers the full list. */
export const MAX_COVERAGE_IDS = 50;
export interface ShadowCall {
	readonly toolCallId: string;
	readonly input: unknown;
	readonly before: SideSnapshot;
	/**
	 * billion-context-pi rejected at least one of this call's refs as unknown. A message ref that
	 * neither its side file nor the native engine knows then goes to the native planner unchanged,
	 * so both engines judge the same unknown ref (pi-context-aware#201).
	 */
	readonly bcpUnknownRef?: boolean;
}
export interface PreviewInput {
	readonly sessionId: string;
	readonly cwd: string;
	readonly header: SessionHeader | null;
	readonly branch: readonly SessionEntry[];
	readonly contextWindow: number;
	readonly folds?: FoldsConfig;
}
/** Full digest of the canonical sorted list, not the diagnostic prefix. */
export function coverageHash(ids: readonly string[]): string {
	return createHash("sha256").update(canonicalJson([...ids].sort())).digest("hex");
}
export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** JSON with sorted object keys, so argument key order is not a difference. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
/** Mirror bcp's argument shortening for evidence only; never changes provider content. */
function compactCompressArguments(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const obj = input as Record<string, unknown>;
	let content: unknown = obj.content;
	const wasString = typeof content === "string";
	if (wasString) { try { content = JSON.parse(content as string) as unknown; } catch { return undefined; } }
	if (!Array.isArray(content)) return undefined;
	let changed = false;
	const compacted = content.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const entry = item as Record<string, unknown>;
		if (typeof entry.summary !== "string" || entry.summary.length <= 200) return item;
		changed = true;
		let prefix = entry.summary.slice(0, 199);
		// bcp's clampPrefix never cuts a surrogate pair in half.
		if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
		return { ...entry, summary: `${prefix}…` };
	});
	return changed ? { ...obj, content: wasString ? JSON.stringify(compacted) : compacted } : undefined;
}

const SAFE_TOOL_IDENTIFIER = /^[A-Za-z0-9_.:|/-]{1,128}$/u;
const MAX_TOOL_CALLS_PER_MESSAGE = 128;
/** Ids and names that look like identifiers are kept; anything else is hashed. */
function toolIdentifier(value: string): string {
	return SAFE_TOOL_IDENTIFIER.test(value) ? value : `#${shortHash(value)}`;
}
export interface RequestMessage {
	readonly role: string;
	readonly content?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly isError?: unknown;
}
function toolEvidence(message: RequestMessage) {
	let incomplete = false;
	const toolCalls: ToolCallHash[] = [];
	if (Array.isArray(message.content)) {
		for (const part of message.content as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }[]) {
			if (part?.type !== "toolCall") continue;
			if (typeof part.id !== "string" || typeof part.name !== "string" || toolCalls.length >= MAX_TOOL_CALLS_PER_MESSAGE) { incomplete = true; continue; }
			const compacted = part.name === "compress" ? compactCompressArguments(part.arguments) : undefined;
			toolCalls.push({ id: toolIdentifier(part.id), name: toolIdentifier(part.name), argsHash: shortHash(canonicalJson(part.arguments ?? null)),
				...(compacted === undefined ? {} : { compactedArgsHash: shortHash(canonicalJson(compacted)) }) });
		}
	}
	let toolResult: ToolResultHash | undefined;
	if (message.role === "toolResult") {
		if (typeof message.toolCallId === "string" && typeof message.toolName === "string") toolResult = { toolCallId: toolIdentifier(message.toolCallId), toolName: toolIdentifier(message.toolName), isError: message.isError === true };
		else incomplete = true;
	}
	return { ...(toolCalls.length ? { toolCalls } : {}), ...(toolResult ? { toolResult } : {}), ...(incomplete ? { toolEvidence: "incomplete" as const } : {}) };
}

/**
 * The text billion-context-pi gives a message without text content (`fallbackText` in its 0.1.83
 * projection): the command as `$ <command>`, then the output. Only `bashExecution` messages use it
 * here; billion-context-pi writes this text into the content of the message it sends.
 */
function bashExecutionText(message: RequestMessage): string {
	const { command, output } = message as { command?: unknown; output?: unknown };
	const parts: string[] = [];
	if (typeof command === "string" && command) parts.push(`$ ${command}`);
	if (typeof output === "string" && output) parts.push(output);
	return parts.join("\n").trim();
}
/** No text, summary bodies, topic lines or tool arguments escape this normalization boundary. */
export function hashRequestMessages(messages: readonly RequestMessage[]): RequestHashes {
	let tagsSeen = false;
	// Pi's context event omits system state; in-memory session contexts include it.
	const conversation = messages.filter((message) => message.role !== "system");
	const hashes = conversation.slice(0, MAX_MESSAGE_HASHES).map((message) => {
		const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
			? message.content.flatMap((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
		if (/<acp(?:\s|>)/u.test(text)) tagsSeen = true;
		const sent = !text && message.role === "bashExecution" ? bashExecutionText(message) : text;
		const clean = sent.replace(/<acp\b[^>]*>[\s\S]*?<\/acp>/gu, "").trim();
		const summary = clean.startsWith(SUMMARY_HEADER);
		const newline = clean.indexOf("\n");
		return summary
			? { role: message.role, summary, topicHash: shortHash(newline < 0 ? clean : clean.slice(0, newline)), hash: shortHash(newline < 0 ? "" : clean.slice(newline + 1)), ...toolEvidence(message) }
			: { role: message.role, summary, hash: shortHash(clean), ...toolEvidence(message) };
	});
	return { messages: hashes, tagsSeen, total: conversation.length };
}

/** Hashes of a fold's model-visible summary, as `hashRequestMessages` hashes the carrier message. */
interface SummaryHash {
	readonly summary: boolean;
	readonly topicHash?: string;
	readonly hash: string;
}
/** A fold the preview created, with the call that created it. Ids and hashes only. */
export interface PreviewFold {
	readonly callId: string;
	readonly blockId: string;
	readonly tier: number;
	readonly carrierId: string;
	/** Covered entries, carrier first. */
	readonly covered: readonly string[];
	readonly directBlockIds: readonly string[];
	/** Undefined when the fold's carrier edit holds no summary text. */
	readonly summary?: SummaryHash;
}
function summaryHash(content: unknown): SummaryHash | undefined {
	if (typeof content !== "string") return undefined;
	const [message] = hashRequestMessages([{ role: "user", content }]).messages;
	return message ? { summary: message.summary, ...(message.topicHash !== undefined ? { topicHash: message.topicHash } : {}), hash: message.hash } : undefined;
}

/**
 * Native ref for a raw id from billion-context-pi's side file. A `<entry>#<call>` id names one
 * native message. Both engines key a single-call assistant entry by the bare entry id and give an
 * entry with several calls one `<entry>#<call>` message per call (pi-context-aware#186). A bare id
 * names the whole entry: a start ref resolves to the entry's first native message and an end ref
 * to its last.
 */
function nativeRefs(state: BranchFoldState): (raw: string, end: boolean) => string | undefined {
	let byEntry: Map<string, string[]> | undefined;
	return (raw, end) => {
		if (raw.includes("#")) return state.kernel.messageRefs.byRaw[raw];
		if (!byEntry) {
			byEntry = new Map();
			for (const message of state.messages) {
				const base = baseIdOf(message.id);
				const ids = byEntry.get(base);
				if (ids) ids.push(message.id); else byEntry.set(base, [message.id]);
			}
		}
		const ids = byEntry.get(raw);
		const id = end ? ids?.at(-1) : ids?.[0];
		return id === undefined ? undefined : state.kernel.messageRefs.byRaw[id];
	};
}
/** A well-formed message ref the native engine does not know, by the kernel's own lookup (exact, then padded). */
function unknownMessageRef(state: BranchFoldState, ref: string): boolean {
	const match = /^m0*(\d{1,5})$/u.exec(ref);
	if (!match) return false;
	const byRef = state.kernel.messageRefs.byRef;
	return byRef[ref] === undefined && byRef[`m${match[1]!.padStart(5, "0")}`] === undefined;
}
/**
 * Build an isolated preview; never appends to the supplied branch or its session. Calls whose ids are
 * in `omit` are skipped and get no outcome; the first call's side-file snapshot still seeds the import,
 * because it is the state before the whole batch.
 */
/** One isolated preview of a batch. Early returns carry only the diagnostics and the empty lists. */
export interface ShadowPreview {
	readonly preview?: SessionManager;
	readonly diffs: ParityDiff[];
	readonly refs: { bcp: string; ours?: string }[];
	readonly records: FoldRecord[];
	readonly folds: PreviewFold[];
	readonly parseKinds: string[];
	readonly parseInvalidItems?: number[];
	readonly outcomes: OutcomeEvidence[];
	readonly dropped: number;
	readonly activeFoldCount?: number;
	readonly activeFoldIds?: string[];
	readonly activeFoldIdsCapped?: boolean;
	readonly expectedSummaryHashes?: readonly string[];
	readonly expectedSummaryTopicHashes?: readonly string[];
	readonly firstUserFolded?: MessageHash;
	readonly firstUserReplacementHash?: string;
}
export function previewShadowCalls(input: PreviewInput, calls: readonly ShadowCall[], omit?: ReadonlySet<string>): ShadowPreview {
	const diffs: ParityDiff[] = [];
	const refs: { bcp: string; ours?: string }[] = [];
	const records: FoldRecord[] = [];
	/** The calls' folds, in creation order; `records` holds the same folds. */
	const folds: PreviewFold[] = [];
	const parseKinds: string[] = [];
	const parseInvalidItems: number[] = [];
	/** Native outcome per call, in call order. */
	const outcomes: OutcomeEvidence[] = [];
	let dropped = 0;
	let firstUserFolded: MessageHash | undefined;
	let firstUserReplacementHash: string | undefined;
	let expectedSummaryHashes: readonly string[] | undefined;
	let expectedSummaryTopicHashes: readonly string[] | undefined;
	// Source evidence, not buildSessionContext(): renderer corruption must not bless itself.
	const summaryHashes = new Map<string, string>();
	const topicHashes = new Map<string, string>();
	const topicHash = (topic?: string) => shortHash(topic ? `${SUMMARY_HEADER} — ${topic}` : SUMMARY_HEADER);
	const blockKey = (record: FoldRecord) => `${record.blockId}/${record.runId}`;
	if (input.branch.length > MAX_BRANCH_ENTRIES) return { expectedSummaryHashes, firstUserReplacementHash, firstUserFolded, diffs: [{ kind: "too-large", reason: "branch exceeds 50,000 entries" } satisfies ParityDiff], refs, records, folds, parseKinds, outcomes, dropped };
	const first = calls[0];
	if (!first) return { expectedSummaryHashes, firstUserReplacementHash, firstUserFolded, diffs, refs, records, folds, parseKinds, outcomes, dropped };
	if (!first.before.ok) return { expectedSummaryHashes, firstUserReplacementHash, firstUserFolded, diffs: [first.before.diff], refs, records, folds, parseKinds, outcomes, dropped };
	if (!input.header) return { expectedSummaryHashes, firstUserReplacementHash, firstUserFolded, diffs: [{ kind: "recorder-error", reason: "session header unavailable" } satisfies ParityDiff], refs, records, folds, parseKinds, outcomes, dropped };
	const preview = SessionManager.inMemory(input.cwd, undefined, [input.header, ...input.branch]);
	const imported = importAcpSideFile({ sideFileText: first.before.text, entries: input.branch, branch: input.branch, sessionId: input.sessionId });
	if (imported.status === "unsupported") diffs.push({ kind: "import-unsupported", reason: imported.reason.slice(0, 200) });
	else if (imported.status === "imported") {
		const kept = keptFirstUserId(input.branch, input.folds);
		// Read bodies and topics from side-file inputs, not the import's rendered drafts.
		const sourceHashes = new Map<string, string | undefined>();
		const sourceTopicHashes = new Map<string, string>();
		const sourceBlocks = (JSON.parse(first.before.text) as { blocks: unknown[] }).blocks;
		for (const raw of sourceBlocks) {
			if (!raw || typeof raw !== "object") continue;
			const block = raw as { blockId?: unknown; runId?: unknown; summary?: unknown; topic?: unknown };
			if (typeof block.blockId !== "string" || typeof block.runId !== "string") continue;
			const key = `${block.blockId}/${block.runId}`;
			sourceHashes.set(key, sourceHashes.has(key) || typeof block.summary !== "string" ? undefined : shortHash(block.summary.trim()));
			sourceTopicHashes.set(key, topicHash(typeof block.topic === "string" ? block.topic : undefined));
		}
		let draftOffset = 0;
		const importedIds = new Set<string>();
		for (const record of imported.records) {
			// foldDrafts emits the carrier, the hidden edits, then metadata for each record.
			const summary = imported.drafts[draftOffset];
			draftOffset += coveredEntryIds(record).length + 1;
			if (!summary || summary.type !== "context_edit" || !summary.replacement) continue;
			const covered = coveredEntryIds(record).filter((id) => id !== kept);
			const [carrierId, ...hiddenIds] = covered;
			if (!carrierId) { diffs.push({ kind: "import-skipped", reason: "opening-only block kept by first-user policy" }); continue; }
			const summaryText = typeof summary.replacement.content === "string" ? summary.replacement.content
				: summary.replacement.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
			const sourceHash = sourceHashes.get(blockKey(record));
			if (sourceHash !== undefined) {
				summaryHashes.set(blockKey(record), sourceHash);
				topicHashes.set(blockKey(record), sourceTopicHashes.get(blockKey(record))!);
			}
			applyFoldDrafts(preview, foldDrafts({ ...record, carrierId, hiddenIds, range: { startId: carrierId, endId: covered.at(-1)! },
				directBlockIds: record.directBlockIds.filter((id) => importedIds.has(id)) }, summaryText));
			importedIds.add(record.blockId);
		}
		if (imported.skippedBlocks.length) diffs.push({ kind: "import-skipped", reason: `${imported.skippedBlocks.length} blocks skipped` });
	} else if (imported.reason !== "no-blocks") diffs.push({ kind: "import-skipped", reason: imported.reason });
	for (const call of calls) {
		if (omit?.has(call.toolCallId)) continue;
		if (!call.before.ok) { diffs.push(call.before.diff); outcomes.push({ type: "unknown", reasons: [] }); continue; }
		const parsed = parseCompressArgs(call.input, { callId: call.toolCallId });
		parseKinds.push(parsed.diagnostics.kind);
		parseInvalidItems.push(parsed.diagnostics.invalidItems);
		if (!parsed.diagnostics.ok || parsed.diagnostics.kind !== "ok" || parsed.diagnostics.invalidItems > 0) diffs.push({ kind: "input-parse", reason: `${parsed.diagnostics.kind}; invalidItems=${parsed.diagnostics.invalidItems}` });
		const state = foldStateFromBranch(preview.getBranch(), preview.buildContextEntries());
		const native = nativeRefs(state);
		const translate = (ref: string, end: boolean): string | undefined => {
			const raw = call.before.ok ? call.before.byRef[ref] : undefined;
			const unknownToBoth = call.bcpUnknownRef === true && raw === undefined && unknownMessageRef(state, ref);
			const mapped = unknownToBoth ? ref : ref.startsWith("b") ? state.records.some((record) => record.blockId === ref) ? ref : undefined : raw === undefined ? undefined : native(raw, end);
			const safeRef = /^[mb]\d{1,7}$/u.test(ref) ? ref : "invalid-ref";
			refs.push({ bcp: safeRef, ...(mapped && mapped !== "BLOCKED" ? { ours: mapped } : {}) });
			if (!mapped || mapped === "BLOCKED") { diffs.push({ kind: "ref-unmapped", reason: `unmapped ref ${safeRef}` }); return undefined; }
			return mapped;
		};
		// bcp 0.1.83's compress tool limits every range by the call's top-level summaryMaxChars and
		// drops a per-range value (its normalizeRanges keeps none), so the parsed ranges' own value is
		// not used (pi-context-aware#183). Pi validated the arguments first: a numeric string is a number here.
		const summaryMaxChars = topLevelSummaryLimit(call.input);
		const requests: FoldRequest[] = [];
		for (const range of parsed.ranges) {
			const startRef = translate(range.startRef, false);
			const endRef = translate(range.endRef, true);
			if (startRef && endRef) requests.push({ startRef, endRef, summary: range.summary, ...(range.topic ? { topic: range.topic } : {}), ...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}) });
		}
		let created = 0;
		const droppedErrors: string[] = [];
		for (const request of requests) {
			// This manager is already isolated. Plan sequentially without cloning it again,
			// binding each accepted record to its own input rather than a rendered draft.
			const plan = planFold({ ...request, branch: preview.getBranch(), contextEntries: preview.buildContextEntries(),
				modelContextLimit: input.contextWindow, folds: input.folds });
			if (!plan.ok) { dropped++; droppedErrors.push(...plan.errors); continue; }
			records.push(...plan.records);
			created += plan.records.length;
			for (const record of plan.records) {
				summaryHashes.set(blockKey(record), shortHash(request.summary.trim()));
				topicHashes.set(blockKey(record), topicHash(request.topic));
			}
			/** The latest summary text written to each carrier; a fold's own carrier edit precedes its metadata. */
			const carrierText = new Map<string, unknown>();
			for (const draft of plan.drafts) {
				if (draft.type === "context_edit") { if (draft.replacement) carrierText.set(draft.targetId, draft.replacement.content); continue; }
				const record = draft.type === "custom" ? readFoldRecord(draft.data) : undefined;
				if (!record) continue;
				const summary = summaryHash(carrierText.get(record.carrierId));
				folds.push({ callId: call.toolCallId, blockId: record.blockId, tier: record.tier, carrierId: record.carrierId, covered: [record.carrierId, ...record.hiddenIds], directBlockIds: record.directBlockIds, ...(summary ? { summary } : {}) });
			}
			applyFoldDrafts(preview, plan.drafts);
		}
		const content = (call.input as { content?: unknown } | null | undefined)?.content;
		outcomes.push(nativeOutcome({ rangeCount: parsed.ranges.length, emptyContent: Array.isArray(content) && content.length === 0, records: created, droppedErrors }));
	}
	const branchOrder = new Map(input.branch.map((entry, index) => [entry.id, index]));
	const active = foldStateFromBranch(preview.getBranch()).active.slice()
		.sort((a, b) => (branchOrder.get(a.carrierId) ?? Infinity) - (branchOrder.get(b.carrierId) ?? Infinity));
	const activeFoldCount = active.length;
	if (active.every((record) => summaryHashes.has(blockKey(record)) && topicHashes.has(blockKey(record)))) {
		expectedSummaryHashes = active.map((record) => summaryHashes.get(blockKey(record))!);
		expectedSummaryTopicHashes = active.map((record) => topicHashes.get(blockKey(record))!);
	}
	const opening = input.branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	const openingFold = opening && active.find((record) => coveredEntryIds(record).includes(opening.id));
	if (opening?.type === "message" && !keptFirstUserId(input.branch, input.folds) && openingFold) {
		firstUserFolded = hashRequestMessages([opening.message]).messages[0];
		firstUserReplacementHash = summaryHashes.get(blockKey(openingFold));
	}
	return { activeFoldCount, activeFoldIds: active.map((record) => record.blockId).sort().slice(0, MAX_MESSAGE_HASHES),
		activeFoldIdsCapped: active.length > MAX_MESSAGE_HASHES,
		expectedSummaryHashes, expectedSummaryTopicHashes, firstUserFolded, firstUserReplacementHash, preview, diffs, refs, records, folds, parseKinds, parseInvalidItems, outcomes, dropped };
}

function evidence(records: readonly { tier: number; directBlockIds: readonly string[] }[], coverage: readonly string[], partialEntries = 0): BlockEvidence {
	return { count: records.length, coverageCount: coverage.length, coverageHash: coverageHash(coverage), coverageIds: coverage.slice(0, MAX_COVERAGE_IDS), partialEntries, tiers: records.map((record) => record.tier), absorbed: [...new Set(records.flatMap((record) => [...record.directBlockIds]))].sort() };
}
function setDiff(kind: "coverage" | "absorbed", ours: readonly string[], bcp: readonly string[]): ParityDiff | undefined {
	const oursSet = new Set(ours);
	const bcpSet = new Set(bcp);
	const oursOnly = ours.filter((id) => !bcpSet.has(id));
	const bcpOnly = bcp.filter((id) => !oursSet.has(id));
	return oursOnly.length || bcpOnly.length ? { kind, oursOnlyCount: oursOnly.length, bcpOnlyCount: bcpOnly.length, oursOnly: oursOnly.slice(0, 50), bcpOnly: bcpOnly.slice(0, 50) } : undefined;
}

/** Compare full coverage counts/digests even when diagnostic id prefixes are capped.
 * Prefix disagreement also contradicts the evidence; prefixes only locate the difference.
 */
export function compareBlockEvidence(ours: BlockEvidence, bcp: BlockEvidence): ParityDiff[] {
	const diffs: ParityDiff[] = [];
	if (ours.count !== bcp.count) diffs.push({ kind: "block-count" });
	const coverage = setDiff("coverage", ours.coverageIds, bcp.coverageIds);
	const inconsistentHash = [ours, bcp].some((blocks) => blocks.coverageCount === blocks.coverageIds.length
		&& blocks.coverageHash !== coverageHash(blocks.coverageIds));
	if (ours.coverageCount !== bcp.coverageCount || ours.coverageHash !== bcp.coverageHash || coverage || inconsistentHash) {
		diffs.push(coverage ?? { kind: "coverage" });
	}
	if (JSON.stringify(ours.tiers) !== JSON.stringify(bcp.tiers)) diffs.push({ kind: "tier" });
	const absorbed = setDiff("absorbed", ours.absorbed, bcp.absorbed);
	if (absorbed) diffs.push(absorbed);
	return diffs;
}

/** The summary limit set by a recorded compress call's top-level `summaryMaxChars`, if any. */
function topLevelSummaryLimit(input: unknown): number | undefined {
	return input !== null && typeof input === "object" && !Array.isArray(input) ? summaryLimitOf((input as { summaryMaxChars?: unknown }).summaryMaxChars) : undefined;
}

/** Pure call comparison shared by the real-session recorder and differential runner. */
export interface CompressComparison {
	readonly verdict: Verdict;
	readonly diffs: ParityDiff[];
	readonly ours?: BlockEvidence;
	readonly bcp?: BlockEvidence;
	readonly refs: readonly { readonly bcp: string; readonly ours?: string }[];
	readonly refContinuity: { readonly same: number; readonly used: number };
	readonly parseKind?: string;
	readonly parseInvalidItems?: number;
	readonly oursOutcome?: OutcomeEvidence;
	readonly bcpOutcome: OutcomeEvidence;
}
export function compareCompressCall(input: PreviewInput & ShadowCall & { readonly after: SideSnapshot; readonly observed: ObservedResult }): CompressComparison {
	const planned = previewShadowCalls(input, [{ ...input, bcpUnknownRef: rejectedUnknownRef(input.observed) }]);
	const diffs = [...planned.diffs];
	if (!input.after.ok) diffs.push(input.after.diff);
	const textBlocks = input.observed.kind === "panel" ? input.observed.blocks : 0;
	if (input.branch.length > MAX_BRANCH_ENTRIES || diffs.some((diff) => diff.kind === "too-large")) return { verdict: verdictFor(diffs), diffs, refs: [], refContinuity: { same: 0, used: 0 }, bcpOutcome: bcpOutcome(input.observed, textBlocks) };
	const beforeKeys = new Set(input.before.ok ? input.before.blocks.map((block) => `${block.blockId}/${block.runId}`) : []);
	const afterBlocks = input.after.ok ? input.after.blocks : [];
	const matched = afterBlocks.filter((block) => block.compressCallId === input.toolCallId);
	const created = matched.length ? matched : afterBlocks.filter((block) => !beforeKeys.has(`${block.blockId}/${block.runId}`));
	const editable = new Set(input.branch.filter(isEditableEntry).map((entry) => entry.id));
	const selected = new Set(created.flatMap((block) => [...block.effectiveMessageIds]));
	const keptFirst = keptFirstUserId(input.branch, input.folds);
	// bcp includes its pinned opening in block metadata, although it never edits it.
	// Compare editable coverage under our policy; folding the opening is diagnosed on the request.
	const bcpCoverage = [...new Set([...selected].map(baseIdOf))].filter((id) => editable.has(id) && id !== keptFirst).sort();
	const partialIds = new Set(input.branch.flatMap(entryToCoreMessages).filter((message) => !selected.has(message.id)).map((message) => baseIdOf(message.id)));
	const partialEntries = bcpCoverage.filter((id) => partialIds.has(id)).length;
	const oursCoverage = [...new Set(planned.records.flatMap((record) => [record.carrierId, ...record.hiddenIds]))].sort();
	const bcp = evidence(created, bcpCoverage, partialEntries);
	const ours = evidence(planned.records, oursCoverage);
	const observedOutcome = bcpOutcome(input.observed, input.after.ok ? created.length : textBlocks);
	const nativeResult = planned.outcomes[0];
	if (input.before.ok && input.after.ok && planned.preview) {
		diffs.push(...compareOutcomes(nativeResult ?? { type: "unknown", reasons: [] }, observedOutcome));
		diffs.push(...compareBlockEvidence({ ...ours, coverageIds: oursCoverage }, { ...bcp, coverageIds: bcpCoverage }));
	}
	const createdIds = planned.records.map((record) => record.blockId);
	const bounded = (blocks: BlockEvidence): BlockEvidence => ({ ...blocks, absorbed: blocks.absorbed.slice(0, MAX_MESSAGE_HASHES),
		...(blocks.absorbed.length > MAX_MESSAGE_HASHES ? { blockIdsCapped: true } : {}) });
	return { verdict: verdictFor(diffs), diffs, ours: { ...bounded(ours), createdIds: createdIds.slice(0, MAX_MESSAGE_HASHES),
		...(createdIds.length > MAX_MESSAGE_HASHES ? { blockIdsCapped: true } : {}) }, bcp: bounded(bcp),
		refs: planned.refs.slice(0, 2000), refContinuity: { same: planned.refs.filter((ref) => ref.bcp === ref.ours).length, used: planned.refs.length },
		...(planned.parseKinds[0] ? { parseKind: planned.parseKinds[0], parseInvalidItems: planned.parseInvalidItems?.[0] } : {}),
		...(nativeResult ? { oursOutcome: nativeResult } : {}), bcpOutcome: observedOutcome };
}

const toolCallKeys = (request: RequestHashes) => request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => JSON.stringify([call.id, call.name, call.argsHash]))).sort();
/**
 * Each result's call id, name and error status together with its complete normalized content (the
 * summary flag, the topic-line hash when the result starts with the summary header, and the body
 * hash), so the whole answer stays bound to the call it answers. The call side (id, name, argument hash) is joined through the id, which
 * `toolPairing` checks and `duplicateCallIds` keeps unambiguous.
 */
const toolResultKeys = (request: RequestHashes) => request.messages.flatMap((message) => message.toolResult ? [JSON.stringify([message.toolResult.toolCallId, message.toolResult.toolName, message.toolResult.isError, message.summary, message.topicHash ?? null, message.hash])] : []).sort();
/** Two calls sharing an id make the result-to-call binding ambiguous. */
function duplicateCallIds(request: RequestHashes): boolean {
	const ids = new Set<string>();
	for (const message of request.messages) for (const call of message.toolCalls ?? []) {
		if (ids.has(call.id)) return true;
		ids.add(call.id);
	}
	return false;
}
/** Results whose call is not earlier in the request, and calls with no result. */
function toolPairing(request: RequestHashes): string[] {
	const calls = new Set<string>();
	const answered = new Set<string>();
	const problems: string[] = [];
	for (const message of request.messages) {
		for (const call of message.toolCalls ?? []) calls.add(call.id);
		if (!message.toolResult) continue;
		if (calls.has(message.toolResult.toolCallId)) answered.add(message.toolResult.toolCallId);
		else problems.push(`unpaired-result:${message.toolResult.toolCallId}`);
	}
	for (const id of calls) if (!answered.has(id)) problems.push(`unanswered-call:${id}`);
	return problems.sort();
}

/** Reconcile source evidence with preview state, even when stored diffs claim a match. */
export function summaryEvidenceDiff(request?: RequestHashes): ParityDiff | undefined {
	if (request?.expectedSummaryHashes === undefined || request.expectedSummaryTopicHashes === undefined) {
		return { kind: "recorder-error", reason: "expected summary evidence unavailable" };
	}
	const count = request.activeFoldCount;
	if (count === undefined || !Number.isSafeInteger(count) || count < 0
		|| request.expectedSummaryHashes.length !== count || request.expectedSummaryTopicHashes.length !== count) {
		return { kind: "recorder-error", reason: "expected summary evidence disagrees with active fold count" };
	}
	return undefined;
}

/** Count, body, topic and order must match independent source evidence, including an empty plan. */
export function expectedSummariesMatch(request: RequestHashes): boolean {
	const bodies = request.expectedSummaryHashes;
	const topics = request.expectedSummaryTopicHashes;
	if (bodies === undefined || topics === undefined || summaryEvidenceDiff(request)) return false;
	const actual = request.messages.filter((message) => message.summary);
	return actual.length === bodies.length && topics.length === bodies.length
		&& bodies.every((hash, index) => actual[index]?.hash === hash && actual[index]?.topicHash === topics[index]);
}

/**
 * The sorted role and text hash of each non-summary message. Pi sends a custom_message with role
 * `custom`; billion-context-pi rebuilds it as a `user` message with the same text, and the provider
 * sees a user message either way. The comparison therefore reads `custom` as `user`. It does not
 * read `bashExecution` as `user`: billion-context-pi keeps that role, and Pi sends the message to the
 * provider as different text from a user message with the same content.
 */
export function contentKeys(request: RequestHashes): string[] {
	return request.messages.filter((message) => !message.summary).map((message) => `${message.role === "custom" ? "user" : message.role}:${message.hash}`).sort();
}
/** Summary order is significant; non-summary text order is not. Tool calls, results and their pairing are compared too. */
export function compareNextRequest(ours: RequestHashes, bcp: RequestHashes, priorDiffs: readonly ParityDiff[] = []) {
	const diffs = [...priorDiffs];
	// Every shadow next-request comparison needs source evidence, including an
	// explicit empty list after a no-op. Absence cannot certify an empty render.
	const evidenceDiff = summaryEvidenceDiff(ours);
	if (evidenceDiff) diffs.push(evidenceDiff);
	if (ours.total > MAX_MESSAGE_HASHES || bcp.total > MAX_MESSAGE_HASHES) diffs.push({ kind: "too-large", reason: "request exceeds 2,000 messages" });
	else {
		const summaries = (request: RequestHashes) => request.messages.filter((message) => message.summary).map((message) => `${message.topicHash}:${message.hash}`);
		// If every native summary disappears, both sides' sequences are empty.
		// Independent planned bodies and topics must still diagnose the lost context.
		const expectedMismatch = ours.expectedSummaryHashes !== undefined && !expectedSummariesMatch(ours);
		if (expectedMismatch || JSON.stringify(summaries(ours)) !== JSON.stringify(summaries(bcp))) diffs.push({ kind: "summaries" });
		if (JSON.stringify(contentKeys(ours)) !== JSON.stringify(contentKeys(bcp))) diffs.push({ kind: "content" });
		if ([ours, bcp].some((request) => request.messages.some((message) => message.toolEvidence))) diffs.push({ kind: "tool-evidence", reason: "a tool call or result lacks an id or name" });
		if ([ours, bcp].some(duplicateCallIds)) diffs.push({ kind: "tool-evidence", reason: "two tool calls share an id" });
		if (JSON.stringify(toolCallKeys(ours)) !== JSON.stringify(toolCallKeys(bcp))) diffs.push({ kind: "tool-calls" });
		if (JSON.stringify(toolResultKeys(ours)) !== JSON.stringify(toolResultKeys(bcp))) diffs.push({ kind: "tool-results" });
		if (JSON.stringify(toolPairing(ours)) !== JSON.stringify(toolPairing(bcp))) diffs.push({ kind: "tool-pairing" });
	}
	if (!bcp.tagsSeen) diffs.push({ kind: "tags-absent" });
	return { verdict: verdictFor(diffs), diffs };
}

export interface BatchCall extends ShadowCall {
	/** Set when billion-context-pi refused this call with an ending only it has. */
	readonly refusal?: RefusalOutcome;
}
export interface BatchComparison {
	readonly ours: RequestHashes;
	readonly verdict: Verdict;
	readonly diffs: ParityDiff[];
	readonly refused?: RefusedCall[];
	readonly counterfactual?: { readonly diffs: ParityDiff[]; readonly delta?: RequestDelta };
	readonly counterfactualOurs?: RequestHashes;
}
const COUNTERFACTUAL_FAILED: ParityDiff = { kind: "recorder-error", reason: "counterfactual preview failed" };
const COUNTERFACTUAL_INCONCLUSIVE: ParityDiff = { kind: "recorder-error", reason: "counterfactual preview inconclusive" };
/** One preview's request hashes, the entry each hashed message comes from, and the folds the calls created. */
interface PreviewedRequest {
	readonly ours: RequestHashes;
	readonly diffs: readonly ParityDiff[];
	/** Source entry id per hashed message; undefined when the preview does not expose its projection. */
	readonly sources?: readonly string[];
	readonly folds: readonly PreviewFold[];
}
type Projection = { readonly entries: readonly { readonly sourceEntry: { readonly id: string }; readonly messages: readonly { readonly role: string }[] }[] };
/**
 * The entry each request message comes from, aligned with `hashRequestMessages`: system messages are
 * dropped and the list stops at the same bound. Undefined when the projection does not line up with
 * the request, so attribution fails closed.
 */
function messageSources(preview: { buildSessionProjection?: () => Projection } | undefined, messages: readonly RequestMessage[]): string[] | undefined {
	if (typeof preview?.buildSessionProjection !== "function") return undefined;
	const projected = preview.buildSessionProjection().entries.flatMap((entry) => entry.messages.map((message) => ({ id: entry.sourceEntry.id, role: message.role })));
	if (projected.length !== messages.length || projected.some((message, i) => message.role !== messages[i]!.role)) return undefined;
	return projected.filter((message) => message.role !== "system").slice(0, MAX_MESSAGE_HASHES).map((message) => message.id);
}
/** Hash one preview's request; the preview session is dropped when this returns. */
function previewRequest(preview: typeof previewShadowCalls, input: PreviewInput, calls: readonly ShadowCall[], omit?: ReadonlySet<string>): PreviewedRequest {
	const planned = preview(input, calls, omit);
	const messages = planned.preview?.buildSessionContext().messages ?? [];
	const sources = messageSources(planned.preview as { buildSessionProjection?: () => Projection } | undefined, messages);
	return { ours: requestEvidence(planned, messages), diffs: planned.diffs, ...(sources ? { sources } : {}), folds: Array.isArray(planned.folds) ? planned.folds : [] };
}
/** A preview's request hashes with the preview's own source evidence for its summaries and opening user. */
export function requestEvidence(planned: ShadowPreview, messages: readonly RequestMessage[]): RequestHashes {
	return { ...hashRequestMessages(messages),
		activeFoldCount: planned.activeFoldCount,
		activeFoldIds: planned.activeFoldIds,
		activeFoldIdsCapped: planned.activeFoldIdsCapped,
		...(planned.expectedSummaryHashes ? { expectedSummaryHashes: planned.expectedSummaryHashes } : {}),
		...(planned.expectedSummaryTopicHashes ? { expectedSummaryTopicHashes: planned.expectedSummaryTopicHashes } : {}),
		...(planned.firstUserFolded ? { firstUserFolded: planned.firstUserFolded } : {}),
		...(planned.firstUserReplacementHash ? { firstUserReplacementHash: planned.firstUserReplacementHash } : {}) };
}
const overlaps = (ids: readonly string[], set: ReadonlySet<string>) => ids.some((id) => set.has(id));
/**
 * Check that the full native request is the counterfactual one with only the refused calls' own folds
 * applied: the counterfactual messages from entries those folds cover are gone, each surviving refused
 * fold's summary stands at its carrier, and every other message is identical by hash, source entry and
 * order. Accepted siblings must fold the same way in both previews, and no refused fold may cover or
 * absorb a sibling's fold. Anything else is `other`. Works on hashes and entry ids only.
 */
function refusedFoldDelta(full: PreviewedRequest, counterfactual: PreviewedRequest, refusedIds: ReadonlySet<string>): RequestDelta {
	const refused = full.folds.filter((fold) => refusedIds.has(fold.callId));
	const siblings = full.folds.filter((fold) => !refusedIds.has(fold.callId));
	const covered = new Set(refused.flatMap((fold) => fold.covered));
	const counts = { refusedFolds: refused.length, coveredEntries: covered.size };
	const other = (reason: RequestDeltaReason, extra: Partial<RequestDelta> = {}): RequestDelta => ({ verdict: "other", reason, ...counts, ...extra });
	if (!full.sources || !counterfactual.sources) return other("attribution-unavailable");
	if (full.ours.total > MAX_MESSAGE_HASHES || counterfactual.ours.total > MAX_MESSAGE_HASHES) return other("too-large");
	if (counterfactual.folds.some((fold) => refusedIds.has(fold.callId)) || refused.some((fold) => !fold.summary?.summary)) return other("unattributed-fold");
	if ([...siblings, ...counterfactual.folds].some((fold) => overlaps(fold.covered, covered))) return other("sibling-covered");
	const refusedBlocks = new Set(refused.map((fold) => fold.blockId));
	const siblingBlocks = new Set(siblings.map((fold) => fold.blockId));
	if (refused.some((fold) => overlaps(fold.directBlockIds, siblingBlocks)) || siblings.some((fold) => overlaps(fold.directBlockIds, refusedBlocks))) return other("sibling-absorbed");
	// Block ids are allocated per preview, so siblings are compared by call, tier, coverage and summary.
	const sibling = (fold: PreviewFold) => canonicalJson([fold.callId, fold.tier, fold.covered, fold.summary ?? null]);
	if (siblings.length !== counterfactual.folds.length || siblings.some((fold, i) => sibling(fold) !== sibling(counterfactual.folds[i]!))) return other("sibling-changed");
	// A refused fold absorbed by a later refused fold has no summary of its own in the request.
	const absorbed = new Set(refused.flatMap((fold) => fold.directBlockIds));
	const carriers = new Map(refused.filter((fold) => !absorbed.has(fold.blockId)).map((fold) => [fold.carrierId, fold.summary!]));
	const expected: string[] = [];
	const placed = new Set<string>();
	let removed = 0;
	counterfactual.ours.messages.forEach((message, i) => {
		const source = counterfactual.sources![i]!;
		if (!covered.has(source)) { expected.push(canonicalJson([source, message])); return; }
		removed++;
		const summary = carriers.get(source);
		if (!summary || placed.has(source)) return;
		placed.add(source);
		// The carrier keeps its role and tool-result binding; its text becomes the summary.
		const toolEvidence = message.role === "toolResult" && !message.toolResult && message.toolEvidence ? { toolEvidence: message.toolEvidence } : {};
		expected.push(canonicalJson([source, { role: message.role, ...summary, ...(message.toolResult ? { toolResult: message.toolResult } : {}), ...toolEvidence }]));
	});
	if (placed.size !== carriers.size) return other("summary-missing", { removedMessages: removed });
	const actual = full.ours.messages.map((message, i) => canonicalJson([full.sources![i], message]));
	const length = Math.max(actual.length, expected.length);
	for (let i = 0; i < length; i++) if (actual[i] !== expected[i]) return other("message-changed", { removedMessages: removed, mismatchAt: i });
	return { verdict: "refused-folds-only", ...counts, removedMessages: removed };
}
/**
 * Compare billion-context-pi's next request with a native preview of the whole batch. When that
 * differs and billion-context-pi refused some calls with an ending only it has, also compare it with
 * a counterfactual preview of the same batch that omits those calls, and check the full native
 * request against the counterfactual one (`refusedFoldDelta`). The differences are the refusals' own
 * only when the counterfactual is clean and the full request differs from it only by the refused
 * folds; the register reads both from the record. The counterfactual reuses the batch's snapshot and
 * runs after the first preview is released, so it adds no copy to the recorder's retained memory; the
 * check keeps only the first preview's hashes and entry ids until it is done. If the counterfactual
 * cannot be computed, or its comparison is inconclusive, the request is inconclusive.
 */
export function compareBatchRequest(input: PreviewInput, calls: readonly BatchCall[], bcp: RequestHashes, preview: typeof previewShadowCalls = previewShadowCalls): BatchComparison {
	const full = previewRequest(preview, input, calls);
	const compared = compareNextRequest(full.ours, bcp, full.diffs);
	const refused = calls.flatMap((call) => call.refusal ? [{ toolCallId: call.toolCallId, type: call.refusal }] : []);
	if (!refused.length) return { ours: full.ours, ...compared };
	if (compared.verdict !== "diff") return { ours: full.ours, ...compared, refused };
	let counterfactual: { diffs: ParityDiff[]; delta?: RequestDelta };
	let counterfactualOurs: RequestHashes;
	try {
		const refusedIds = new Set(refused.map((call) => call.toolCallId));
		const omitted = previewRequest(preview, input, calls, refusedIds);
		const diffs = compareNextRequest(omitted.ours, bcp, omitted.diffs).diffs;
		if (verdictFor(diffs) === "inconclusive") {
			const all = [...compared.diffs, COUNTERFACTUAL_INCONCLUSIVE];
			return { ours: full.ours, verdict: verdictFor(all), diffs: all, refused, counterfactual: { diffs }, counterfactualOurs: omitted.ours };
		}
		counterfactual = { diffs, delta: refusedFoldDelta(full, omitted, refusedIds) };
		counterfactualOurs = omitted.ours;
	} catch {
		const diffs = [...compared.diffs, COUNTERFACTUAL_FAILED];
		return { ours: full.ours, verdict: verdictFor(diffs), diffs, refused };
	}
	return { ours: full.ours, ...compared, refused, counterfactual, counterfactualOurs };
}
