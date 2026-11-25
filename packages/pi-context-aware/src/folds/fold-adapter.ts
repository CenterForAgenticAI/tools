/**
 * Pi adapter for the copied fold engine.
 *
 * The engine works on a flat list of messages with stable ids and a block
 * state. This module builds both from a Pi session branch: message ids are
 * session entry ids, and the block state is rebuilt from the fold entries on
 * the branch, so nothing outside the session file is needed. A planned fold is
 * returned as boundary drafts; the caller decides when Pi may append them.
 *
 * Planning prepares the turn the way billion-context-pi 0.1.83 does before its
 * compress tool plans (pi-context-aware#186): the same message projection, then
 * the engine's `processTurn` (folded messages pruned, tool calls without a
 * result stripped, earlier compress calls cut to stubs), and only then the
 * protected recent tail. A range whose ends lie inside an active fold is
 * therefore refused as already folded (pi-context-aware#184).
 */

import type { ContextEditableContent, ContextEditEntryDraft, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

import { assignRefs, baseIdOf, countMessageTokens, createCore, createInitialState, defaultConfig, defaultCountTokens, emptyRefMap, parseBoundary, resolveBlockSpan, SUMMARY_HEADER } from "./kernel/index.js";
import type { CompressionBlock, CompressionState, Config, CoreMessage } from "./kernel/index.js";
import { resolveBoundaries } from "./kernel/boundaries.js";
import { buildCompressibleRanges, computeProtectedRefs, mergeRangesToThreshold } from "./kernel/recommend.js";
import type { CompressibleRange, ContextRanges, ProcessTurnResult } from "./kernel/types.js";
import { viableRanges } from "./kernel/viable.js";
import { contentLength, MAX_VERBATIM_CHARS, renderOneLineSection, type FoldHintView, type ResolvedFoldHint } from "./fold-hints.js";
import { widenFoldCoverage } from "./fold-coverage.js";
import { nativeRefusal } from "./fold-refusal.js";
import { sanitizeSummary } from "./summary-sanitize.js";
import { foldRules, refusal, type Refusal, type SummarizeEngine } from "../strategy-runtime/check-plan.js";
import { DEFAULT_FOLDS_CONFIG, type FoldsConfig } from "../platform/config-layers.js";
import {
	coveredEntryIds,
	foldDrafts,
	foldRecordsOnBranch,
	isEditableEntry,
	omittedEntryIds,
	renderFoldSummary,
	type FoldRecord,
	type FoldTier,
} from "./fold-entries.js";

type ContentPart = { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

function partsOf(content: unknown): ContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter((part): part is ContentPart => typeof part === "object" && part !== null) : [];
}

// billion-context-pi strips a ref tag it rendered into a text when it reads the text back.
const REF_TAG_SOURCE = "(?:<acp\\s[^>]*>m\\d{5}</acp>|\\[m\\d{1,5}\\])";
const REF_TAG = new RegExp(`^${REF_TAG_SOURCE}\\s?\\n?`, "u");
const TRAILING_REF_TAG = new RegExp(`\\n*${REF_TAG_SOURCE}\\s*$`, "u");

const PROTECTED_ZONE_WARNING_SUFFIX = " — they stay visible outside the new block; do not target them in another compress call.";
const TEMPORARY_PROTECTED_ZONE_WARNING_SUFFIX = " — they stay visible for now and can be folded in a later call once newer messages push them out of the protected zone.";

function adaptKernelWarning(warning: string): string {
	if (!warning.endsWith(PROTECTED_ZONE_WARNING_SUFFIX)) return warning;
	return `${warning.slice(0, -PROTECTED_ZONE_WARNING_SUFFIX.length)}${TEMPORARY_PROTECTED_ZONE_WARNING_SUFFIX}`;
}

/** The text parts of a message content, joined as billion-context-pi joins them. Images add no text. */
function textOf(content: unknown): string {
	return partsOf(content)
		.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text.replace(REF_TAG, "").replace(TRAILING_REF_TAG, "")] : []))
		.join("\n");
}

/** Context entries of these custom types are billion-context-pi panels; they never reach its planner. */
const PANEL_CUSTOM_TYPES: ReadonlySet<string> = new Set(["acp-status", "acp-export", "acp-rule"]);

function thinkingTokensOf(parts: readonly ContentPart[]): number {
	const thinking = parts.flatMap((part) => (part.type === "thinking" && typeof part.thinking === "string" ? [part.thinking] : []));
	return thinking.length > 0 ? defaultCountTokens(thinking.join("\n")) : 0;
}

function argumentsText(args: unknown): string {
	if (!args) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args) ?? "";
	} catch {
		return String(args);
	}
}

/** The text of a message without text content: a bash execution's command and output, or a summary. */
function fallbackText(message: { command?: unknown; output?: unknown; summary?: unknown }): string {
	const parts: string[] = [];
	if (typeof message.command === "string" && message.command) parts.push(`$ ${message.command}`);
	const output = textOf(message.output);
	if (output) parts.push(output);
	if (typeof message.summary === "string" && message.summary) parts.push(message.summary);
	return parts.join("\n").trim();
}

/**
 * Engine messages for one session entry, projected as billion-context-pi 0.1.83
 * projects them (`projectMessage`), so both engines count the same protected
 * recent tail (pi-context-aware#186). An assistant entry with one tool call is
 * one message keyed by the entry id, its text and then the call's arguments. An
 * entry with several calls becomes one message per call, with ids
 * `<entry id>#<call id>`; the engine maps those back to the entry with
 * `baseIdOf`. An assistant entry without text or calls has no message.
 * Thinking parts count as `thinkingTokens`, on the entry's first message.
 */
export function entryToCoreMessages(entry: SessionEntry): CoreMessage[] {
	if (entry.type === "custom_message") {
		if (entry.customType !== undefined && PANEL_CUSTOM_TYPES.has(entry.customType)) return [];
		const text = textOf(entry.content);
		return text.length > 0 ? [{ id: entry.id, role: "user", contentType: "text", text }] : [];
	}
	if (entry.type !== "message") return [];
	// A persisted entry without a message object (hand-edited or damaged file) holds nothing to send.
	if (typeof entry.message !== "object" || entry.message === null) return [];
	const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; command?: unknown; output?: unknown; summary?: unknown };
	if (message.role === "user") return [{ id: entry.id, role: "user", contentType: "text", text: textOf(message.content) }];
	if (message.role === "toolResult") {
		return [
			{
				id: entry.id,
				role: "tool",
				contentType: "tool-result",
				text: textOf(message.content),
				...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
				...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
			},
		];
	}
	if (message.role !== "assistant") {
		const text = textOf(message.content) || fallbackText(message);
		return text.length > 0 ? [{ id: entry.id, role: "user", contentType: "text", text }] : [];
	}
	const parts = partsOf(message.content);
	const thinking = thinkingTokensOf(parts);
	const thinkingField = thinking > 0 ? { thinkingTokens: thinking } : {};
	const text = textOf(message.content);
	const calls = parts.filter((part) => part.type === "toolCall" && typeof part.name === "string" && part.name.length > 0);
	if (calls.length === 1) {
		const call = calls[0]!;
		const args = argumentsText(call.arguments);
		return [{
			id: entry.id,
			role: "assistant",
			contentType: "tool-call",
			toolName: call.name as string,
			toolCallId: typeof call.id === "string" ? call.id : "",
			text: args && text ? `${text}\n${args}` : args || text,
			...thinkingField,
		}];
	}
	if (calls.length > 1) {
		return calls.map((call, index): CoreMessage => {
			const callId = typeof call.id === "string" ? call.id : "";
			return {
				id: `${entry.id}#${callId}`,
				role: "assistant",
				contentType: "tool-call",
				toolName: call.name as string,
				toolCallId: callId,
				text: argumentsText(call.arguments) || text,
				...(index === 0 ? thinkingField : {}),
			};
		});
	}
	return text.trim() ? [{ id: entry.id, role: "assistant", contentType: "text", text, ...thinkingField }] : [];
}

/** Rebuilt fold state for one branch. */
export interface BranchFoldState {
	/** Every valid fold record on the branch, in path order. */
	readonly records: readonly FoldRecord[];
	/** Folds still in effect: not absorbed by a later, higher-tier fold. */
	readonly active: readonly FoldRecord[];
	/** Engine messages for the model-visible entries, in branch order. */
	readonly messages: CoreMessage[];
	/** Engine state with one block per fold record. */
	readonly kernel: CompressionState;
}

/**
 * Rebuild fold state from a branch. `contextEntries` are the entries Pi still
 * sends to the model (after compaction); they default to the whole branch.
 */
export function foldStateFromBranch(
	branch: readonly SessionEntry[],
	contextEntries: readonly SessionEntry[] = branch,
): BranchFoldState {
	const found = foldRecordsOnBranch(branch);
	const records = found.map(({ record }) => record);
	const absorbed = new Set(records.flatMap((record) => record.directBlockIds));
	const active = records.filter((record) => !absorbed.has(record.blockId));
	const messages = contextEntries.flatMap(entryToCoreMessages);
	const coreIdsByEntry = new Map<string, string[]>();
	for (const message of messages) {
		const base = baseIdOf(message.id);
		coreIdsByEntry.set(base, [...(coreIdsByEntry.get(base) ?? []), message.id]);
	}
	const summaries = latestReplacementText(branch);
	const state = createInitialState();
	state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 1 }).map;
	let highestBlock = 0;
	let highestRun = 0;
	state.blocks = records.map((record): CompressionBlock => {
		highestBlock = Math.max(highestBlock, Number(record.blockId.slice(1)));
		highestRun = Math.max(highestRun, Number(record.runId.slice(1)));
		const coreIds = coveredEntryIds(record).flatMap((id) => coreIdsByEntry.get(id) ?? [id]);
		return {
			blockId: record.blockId,
			runId: record.runId,
			tier: record.tier,
			...(record.topic ? { topic: record.topic } : {}),
			summary: summaries.get(record.carrierId) ?? "",
			directMessageIds: coreIds,
			effectiveMessageIds: coreIds,
			directBlockIds: [...record.directBlockIds],
			compressedTokens: record.compressedTokens,
			createdAt: record.createdAt,
			survivedCount: 0,
			generation: "young",
			active: !absorbed.has(record.blockId),
			// The call that made the fold: the engine keeps an active fold's compress call visible as a
			// stub and hides the calls of absorbed folds, as billion-context-pi does.
			...(record.compressCallId ? { compressCallId: record.compressCallId }
				: record.requestId && record.requestId.lastIndexOf("#") > 0 ? { compressCallId: record.requestId.slice(0, record.requestId.lastIndexOf("#")) } : {}),
			...(record.refs.start ? { startRef: record.refs.start } : {}),
			...(record.refs.end ? { endRef: record.refs.end } : {}),
		};
	});
	state.nextBlockId = highestBlock + 1;
	state.nextRunId = highestRun + 1;
	return { records, active, messages, kernel: state };
}

export function latestReplacementText(branch: readonly SessionEntry[]): Map<string, string> {
	const texts = new Map<string, string>();
	for (const entry of branch) {
		if (entry.type !== "context_edit") continue;
		if (entry.replacement === null) texts.delete(entry.targetId);
		else texts.set(entry.targetId, textOf(entry.replacement.content));
	}
	return texts;
}

/** Refs the model may name in a fold request: unfolded messages and active folds. */
export function validFoldRefs(state: BranchFoldState): string[] {
	const covered = new Set(state.active.flatMap(coveredEntryIds));
	const refs: string[] = [];
	for (const message of state.messages) {
		if (covered.has(baseIdOf(message.id))) continue;
		const ref = state.kernel.messageRefs.byRaw[message.id];
		if (ref && ref !== "BLOCKED" && !refs.includes(ref)) refs.push(ref);
	}
	return [...refs, ...state.active.map((record) => record.blockId)];
}

export interface FoldRequest {
	/** First message ref (`mNNNNN`) or fold id (`bN`) of the range. */
	readonly startRef: string;
	/** Last message ref or fold id of the range. */
	readonly endRef: string;
	readonly summary: string;
	readonly topic?: string;
	/**
	 * Longest summary this fold accepts, in place of the engine's `maxSummaryLength`
	 * (pi-context-aware#183). Zero or a negative number removes the limit, as in the engine.
	 * Anything but a finite number is ignored; see `summaryLimitOf`.
	 */
	readonly summaryMaxChars?: number;
}

/**
 * The summary limit a caller's value sets, or `undefined` when it sets none. Only a finite
 * number counts, the rule of the kernel's `parseCompressArgs` (kernel/parse-compress-input.ts).
 * The kernel exports no helper for it, and its parsed ranges also carry per-range values, which
 * billion-context-pi's compress tool drops. NaN or Infinity would switch the engine's check off.
 */
export function summaryLimitOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Condenses entries that carry skill text (pi-context-aware#181). An
 * entry it returns content for is kept out of the fold, and the fold shows it
 * with that content instead: the third kind of content, beside protected and
 * summarized.
 */
export interface FoldCondenser {
	/** Replacement content for an entry whose skill blocks condense; `undefined` leaves the entry to the fold. */
	condense(entry: SessionEntry): ContextEditableContent | undefined;
}

export interface FoldPlanInput extends FoldRequest {
	readonly folds?: FoldsConfig;
	/** Set only when `folds.condensedSkills` is on. Every plan of one request must get the same condenser. */
	readonly condenser?: FoldCondenser;
	readonly branch: readonly SessionEntry[];
	readonly contextEntries?: readonly SessionEntry[];
	readonly modelContextLimit: number;
	/** Engine settings that differ from its defaults. */
	readonly config?: Partial<Config>;
	/**
	 * Fold hints (pi-context-aware#281). `verbatim` entries stay out of the fold, `one-line` ones are
	 * listed as one line under the summary, `condensed` ones show their condensed text, and
	 * `drop-after-read` ones are hidden without a line.
	 */
	readonly hints?: FoldHintView;
	/**
	 * Which messages the protected zone counts as the user's (pi-context-aware#284). `typed` (the
	 * default) counts only a message a person typed: an extension-injected `custom_message` is
	 * ordinary history. `all-user-role` counts every user-role message, as billion-context-pi
	 * does; the parity preview sets it so both engines are compared on the same rule.
	 */
	readonly protectedZone?: "typed" | "all-user-role";
	/** False when the session's methods leave out compact (pi-context-aware#526): a refusal then advises no context_compact. */
	readonly compactOffered?: boolean;
}

export type FoldPlan =
	| { readonly ok: true; readonly records: FoldRecord[]; readonly drafts: SessionBoundaryDraft[]; readonly warnings: string[] }
	| { readonly ok: false; readonly errors: string[]; readonly validRefs: string[] };

/** A fold plan whose refusals carry their rule and stable code, from the plan checker (src/strategy-runtime/check-plan.ts). */
export type CodedFoldPlan =
	| Extract<FoldPlan, { ok: true }>
	| { readonly ok: false; readonly refusals: Refusal[]; readonly validRefs: string[] };

/** `planFoldCoded` with each refusal as its message, the form the fold tool and its callers read. */
export function planFold(input: FoldPlanInput): FoldPlan {
	const plan = planFoldCoded(input);
	return plan.ok ? plan : { ok: false, errors: plan.refusals.map((one) => one.message), validRefs: plan.validRefs };
}

/** Opening user entry protected by the effective policy, using the kernel's CJK-aware estimate. */
export function keptFirstUserId(branch: readonly SessionEntry[], folds: FoldsConfig = DEFAULT_FOLDS_CONFIG): string | undefined {
	const first = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (!first || folds.firstUserMessage === "fold") return undefined;
	const tokens = entryToCoreMessages(first).reduce((sum, message) => sum + countMessageTokens(message), 0);
	return folds.firstUserMessage === "keep" || tokens <= folds.firstUserMessageMaxTokens ? first.id : undefined;
}

/**
 * Estimated tokens of the context the model is sent: unfolded messages plus the
 * active folds' summaries. The engine's turn preparation truncates large tool
 * outputs when this nears the context limit, as billion-context-pi's does.
 */
function sentTokens(state: BranchFoldState): number {
	const folded = new Set(state.kernel.blocks.filter((block) => block.active).flatMap((block) => block.effectiveMessageIds.map(baseIdOf)));
	const visible = state.messages.filter((message) => !folded.has(baseIdOf(message.id)));
	const summaries = state.kernel.blocks.filter((block) => block.active).map((block) => defaultCountTokens(block.summary));
	return [...visible.map((message) => countMessageTokens(message)), ...summaries].reduce((sum, tokens) => sum + tokens, 0);
}

/**
 * Coverage after withdrawing every Pi entry the fold would only partly hide,
 * together with the tool pairs it belongs to, until nothing is split. The
 * engine already withdraws split call/result pairs; Pi folds whole entries, so
 * an entry with several calls that the protected tail cuts through is withdrawn
 * the same way rather than refused.
 */
function withdrawSplitEntries(messages: readonly CoreMessage[], ids: readonly string[]): Set<string> {
	const selected = new Set(ids);
	for (;;) {
		const outside = messages.filter((message) => !selected.has(message.id));
		const entries = new Set(outside.map((message) => baseIdOf(message.id)));
		const calls = new Set(outside.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
		const split = messages.filter((message) => selected.has(message.id)
			&& (entries.has(baseIdOf(message.id)) || (message.toolCallId !== undefined && message.toolCallId !== "" && calls.has(message.toolCallId))));
		if (split.length === 0) return selected;
		for (const message of split) selected.delete(message.id);
	}
}

/** The protected zone `planFold` enforces on a branch as it stands. */
export interface ProtectedZone {
	/** The turn `planFold` plans on, prepared at the token count `planFold` uses (`sentTokens`). */
	readonly turn: ProcessTurnResult;
	/** What `planFold` passes to the engine's `applyCompression`. */
	readonly field: { protectedMessageIds?: Set<string> };
	/**
	 * Session entries no fold can take now: entries with a message in the zone, and the entries and
	 * tool pairs `planFold` withdraws with them so that no entry or call/result pair is split.
	 */
	readonly entryIds: ReadonlySet<string>;
}

/**
 * The protected zone of recent messages kept word for word (pi-context-aware#284), as `planFold`
 * computes it: the engine prepares the turn at `sentTokens`, then counts the recent messages it keeps,
 * with an extension-injected message not counted as the user's in `typed` mode. `planFold` and the
 * strategy view (pi-context-aware#467) both call this, so the zone a view reports is the zone a fold
 * is refused for.
 */
export function protectedZone(state: BranchFoldState, config: Config, branch: readonly SessionEntry[], mode: "typed" | "all-user-role"): ProtectedZone {
	const turn = createCore().processTurn({ messages: state.messages, state: state.kernel, config, tokenCount: sentTokens(state) });
	const field = protectedField(turn.messages, turn.state, config, branch, mode);
	const refs = field.protectedMessageIds ?? computeProtectedRefs(turn.messages, turn.state, config, defaultCountTokens);
	const zone = new Set(turn.messages.flatMap((message) => {
		const ref = turn.state.messageRefs.byRaw[message.id];
		return ref !== undefined && refs.has(ref) ? [message.id] : [];
	}));
	const foldable = withdrawSplitEntries(state.messages, state.messages.map((message) => message.id).filter((id) => !zone.has(id)));
	const entryIds = new Set(state.messages.filter((message) => !foldable.has(message.id)).map((message) => baseIdOf(message.id)));
	return { turn, field, entryIds };
}

/**
 * Prepare the turn as billion-context-pi does, widen message ranges to whole Pi
 * entries and tool pairs, then run the engine's validation (protected recent
 * messages, tool pairs, summary limits). Entries the protected tail would split
 * are withdrawn from the fold. Every refusal comes from the plan checker's
 * `foldRules` (pi-context-aware#468), with its rule and stable code. Nothing is
 * written: the drafts go to Pi from a boundary handler.
 */
export function planFoldCoded(input: FoldPlanInput): CodedFoldPlan {
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const config: Config = defaultConfig(input.modelContextLimit, input.config ?? {});
	const refused = (refusals: Refusal[]): CodedFoldPlan => ({ ok: false, refusals, validRefs: validFoldRefs(state) });
	// Double-escaped \uXXXX runs are decoded before anything reads or stores the summary (bcp issue 309).
	const summary = sanitizeSummary(input.summary).text;
	const badSummary = foldRules.summary(summary);
	if (badSummary.length > 0) return refused(badSummary);
	const forgedTurn = foldRules.provenance(summary);
	if (forgedTurn.length > 0) return refused(forgedTurn);
	const core = createCore();
	// billion-context-pi plans on the prepared turn (pi-context-aware#186): folded messages pruned
	// and replaced by their summaries, tool calls without a result stripped (except compress),
	// earlier compress calls cut to stubs, ref tags rendered. The protected tail is counted there.
	const zone = protectedZone(state, config, input.branch, input.protectedZone ?? "typed");
	const turn = zone.turn;
	// The engine's refusals name billion-context-pi's tools; the model gets this package's (pi-context-aware#434).
	const native = (error: string) => nativeRefusal(error, { overlapping: () => overlappingFolds(turn.state, input.startRef, input.endRef), compact: input.compactOffered !== false });
	let startRef = input.startRef;
	let endRef = input.endRef;
	let boundaryKind: string = input.startRef.startsWith("b") || input.endRef.startsWith("b") ? "block" : "message";
	try {
		const resolved = resolveBoundaries({ startRef, endRef, messages: turn.messages, state: turn.state });
		boundaryKind = resolved.boundaryKind;
		const widened = new Set(widenFoldCoverage(turn.messages, resolved.messageIds, true));
		const first = turn.messages.findIndex((message) => widened.has(message.id));
		const last = turn.messages.reduce((last, message, index) => widened.has(message.id) ? index : last, -1);
		if (resolved.boundaryKind === "block") {
			// Replacing a bN endpoint with mNNNNN changes the engine's tier semantics. In the pruned
			// view a range of whole folds holds only their summaries, and nothing can split.
			const split = foldRules.blockSplit({ first, last, startIndex: resolved.startIndex, endIndex: resolved.endIndex });
			if (split.length > 0) return refused(split);
		} else if (first >= 0 && last >= 0) {
			startRef = turn.state.messageRefs.byRaw[turn.messages[first]!.id]!;
			endRef = turn.state.messageRefs.byRaw[turn.messages[last]!.id]!;
		}
	} catch (error) {
		// A ref inside an active fold is consumed: the engine refuses the range with
		// billion-context-pi's wording, so the rule lets it decide (pi-context-aware#184).
		const unresolved = foldRules.boundary(error, native);
		if (unresolved.length > 0) return refused(unresolved);
	}
	const before = new Set(turn.state.blocks.map((block) => block.blockId));
	const hintsById = hintsOnBranch(input.branch, input.hints);
	const summaryMaxChars = summaryLimitOf(input.summaryMaxChars);
	const result = core.applyCompression({
		ranges: [
			{
				startRef,
				endRef,
				summary,
				...(input.topic ? { topic: input.topic } : {}),
				...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}),
			},
		],
		messages: turn.messages,
		state: turn.state,
		config,
		...zone.field,
	});
	const created = result.state.blocks.filter((block) => !before.has(block.blockId));
	const kernelWarnings = result.result.warnings.map(adaptKernelWarning);
	// A consumed range below the size gate is skipped with a warning, not an error; that warning is the reason.
	const engineRefusals = foldRules.engine({ errors: result.result.errors, warnings: kernelWarnings, created: created.length }, native);
	if (engineRefusals.length > 0) return refused(engineRefusals);
	const keptFirst = keptFirstUserId(input.branch, input.folds);
	const indexById = new Map(input.branch.map((entry, index) => [entry.id, index]));
	const entryById = new Map(input.branch.map((entry) => [entry.id, entry]));
	{
		// The engine counts the kept opening message as unfolded, so a message range over
		// folded entries plus that message would refold them and hide nothing new.
		const folded = new Set(state.active.flatMap(coveredEntryIds));
		const touched = new Set(created.flatMap((block) => block.effectiveMessageIds.map(baseIdOf)));
		const fresh = [...touched].filter((id) => {
			const entry = entryById.get(id);
			return id !== keptFirst && entry !== undefined && isEditableEntry(entry) && !folded.has(id);
		});
		const absorbed = [...new Set(created.flatMap((block) => block.directBlockIds))];
		const nothingNew = foldRules.keptFirstOnly({
			startRef: input.startRef,
			endRef: input.endRef,
			blockRange: boundaryKind === "block",
			touchesKeptFirst: keptFirst !== undefined && touched.has(keptFirst),
			fresh: fresh.length,
			absorbed,
		});
		if (nothingNew.length > 0) return refused(nothingNew);
	}
	const records: FoldRecord[] = [];
	const drafts: SessionBoundaryDraft[] = [];
	const warnings = [...kernelWarnings];
	// An entry an earlier fold already hides stays hidden; a swap edit would show it again.
	const alreadyFolded = new Set(state.active.flatMap(coveredEntryIds));
	const swaps = new Map<string, ContextEditableContent>();
	const messageById = new Map(state.messages.map((message) => [message.id, message]));
	const summaryById = new Map(turn.state.blocks.map((block) => [block.blockId, block.summary]));
	// Entries the branch already omits get no second null edit (pi-context-aware#441).
	const omitted = omittedEntryIds(input.branch);
	for (const block of created) {
		const selected = withdrawSplitEntries(state.messages, block.effectiveMessageIds);
		// A verbatim entry an earlier fold already hides stays hidden: taking it out would change that fold's coverage.
		const kept = [...selected].filter((id) => hintsById.get(baseIdOf(id))?.policy === "verbatim" && !alreadyFolded.has(baseIdOf(id)));
		const folding = kept.length > 0 ? withdrawSplitEntries(state.messages, [...selected].filter((id) => !kept.includes(id))) : selected;
		for (const id of new Set([...folding].map(baseIdOf))) {
			const hint = hintsById.get(id);
			const entry = entryById.get(id);
			if (hint?.policy === "condensed" && entry && !alreadyFolded.has(id) && !swaps.has(id) && isEditableEntry(entry)) swaps.set(id, hint.condensed!);
		}
		if (input.condenser) {
			for (const id of new Set([...folding].map(baseIdOf))) {
				const entry = entryById.get(id);
				if (!entry || alreadyFolded.has(id) || swaps.has(id) || !isEditableEntry(entry)) continue;
				const content = input.condenser.condense(entry);
				if (content !== undefined) swaps.set(id, content);
			}
		}
		const withdrawn = block.effectiveMessageIds.filter((id) => !selected.has(id));
		if (withdrawn.length > 0) {
			warnings.push(`Withdrawn ${withdrawn.length} message(s) from fold ${block.blockId} to keep whole session entries and tool pairs visible beside the protected recent messages.`);
		}
		// Tokens this fold hides, counted on the session's own text: the prepared turn carries
		// rendered ref tags, which the engine's own count includes.
		const hiddenTokens = block.directMessageIds.filter((id) => folding.has(id) && id !== keptFirst && !swaps.has(baseIdOf(id)))
			.reduce((sum, id) => sum + (messageById.has(id) ? countMessageTokens(messageById.get(id)!) : 0), 0)
			+ block.directBlockIds.reduce((sum, id) => sum + defaultCountTokens(summaryById.get(id) ?? ""), 0);
		const covered = [...new Set([...folding].map(baseIdOf))]
			.filter((id) => {
				const entry = entryById.get(id);
				return entry !== undefined && isEditableEntry(entry) && id !== keptFirst && !swaps.has(id);
			})
			.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
		const [carrierId, ...hiddenIds] = covered;
		const uncovered = foldRules.coverage({
			blockId: block.blockId,
			carrierId,
			verbatim: kept.length,
			condensed: swaps.size,
			keptFirstInRange: keptFirst !== undefined && block.effectiveMessageIds.includes(keptFirst),
			withdrawn: withdrawn.length,
		});
		if (uncovered.length > 0 || carrierId === undefined) return refused(uncovered);
		const record: FoldRecord = {
			version: 1,
			blockId: block.blockId,
			runId: block.runId,
			tier: block.tier as FoldTier,
			...(block.topic ? { topic: block.topic } : {}),
			carrierId,
			hiddenIds,
			range: { startId: carrierId, endId: covered[covered.length - 1] ?? carrierId },
			// The refs the request named, as billion-context-pi records them: its block map and the
			// kept-call rewrite read these, not the range widened to whole entries and tool pairs.
			refs: boundaryKind === "message" ? { start: input.startRef, end: input.endRef } : { start: block.startRef ?? input.startRef, end: block.endRef ?? input.endRef },
			directBlockIds: [...block.directBlockIds],
			compressedTokens: hiddenTokens,
			createdAt: block.createdAt,
			origin: "fold",
		};
		records.push(record);
		const oneLines = covered.flatMap((id) => {
			const hint = hintsById.get(id);
			return hint?.policy === "one-line" && hint.line ? [hint.line] : [];
		});
		const section = renderOneLineSection(oneLines);
		const rendered = renderFoldSummary(block.summary, block.topic);
		drafts.push(...foldDrafts(record, section ? `${rendered}\n\n${section}` : rendered, omitted));
		for (const id of hiddenIds) omitted.add(id);
	}
	drafts.push(...swapDrafts(input.branch, swaps));
	return { ok: true, records, drafts, warnings };
}

/**
 * Plans a strategy's written `summarize` operations with `planFold` on one session as it stands: the
 * engine `checkPlan` (src/strategy-runtime/check-plan.ts) takes. An operation names entries; the range
 * runs from the first ref of `startId` to the last ref of `endId`. An active fold's id names the fold,
 * as in a `context_fold` request.
 */
export function summarizeEngine(input: Omit<FoldPlanInput, keyof FoldRequest>): SummarizeEngine {
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const refsOf = new Map<string, string[]>();
	for (const message of state.messages) {
		const ref = state.kernel.messageRefs.byRaw[message.id];
		if (ref === undefined || ref === "BLOCKED") continue;
		const base = baseIdOf(message.id);
		refsOf.set(base, [...(refsOf.get(base) ?? []), ref]);
	}
	const folds = new Set(state.active.map((record) => record.blockId));
	const refOf = (id: string, end: boolean): string | undefined => {
		if (folds.has(id)) return id;
		const refs = refsOf.get(id);
		return end ? refs?.[refs.length - 1] : refs?.[0];
	};
	return (op) => {
		const startRef = refOf(op.startId, false);
		const endRef = refOf(op.endId, true);
		if (startRef === undefined || endRef === undefined) {
			const missing = startRef === undefined ? op.startId : op.endId;
			return { ok: false, refusals: [refusal("unknown-ref", `Entry ${missing.slice(0, 64)} is not in the request.`)] };
		}
		const plan = planFoldCoded({ ...input, startRef, endRef, summary: op.summary, ...(op.topic ? { topic: op.topic } : {}) });
		return plan.ok ? plan : { ok: false, refusals: plan.refusals };
	};
}

/** Entries a `verbatim` fold hint keeps visible: no fold can take them, so no range is offered over them. */
export function verbatimEntryIds(branch: readonly SessionEntry[], hints: FoldHintView | undefined): string[] {
	return [...hintsOnBranch(branch, hints)].filter(([, hint]) => hint.policy === "verbatim").map(([id]) => id);
}

/**
 * The engine's range recommendation, with entries no fold may take left out (pi-context-aware#457).
 * The engine offers every unfolded message outside the protected zone, so it offered entries a
 * `verbatim` hint keeps and entries a fold queued earlier this turn already takes; a fold of either
 * was refused. `excludedEntryIds` are treated as the protected zone is: a gap no range spans, so
 * every offered range still clears the size minimum without them.
 *
 * A fold's summary is a gap too. The engine skips a message without a ref, and a summary has none,
 * so it offered one range across several folds, `m00001..m00026` over b1..b12; a fold of that
 * range was refused as already compressed. Mapping each summary to a placeholder ref makes the
 * engine see it as folded content, which it treats as a gap; the placeholder is never offered.
 */
export function foldableRanges(
	messages: CoreMessage[],
	state: CompressionState,
	config: Config,
	branch: readonly SessionEntry[],
	zone: "typed" | "all-user-role",
	excludedEntryIds: ReadonlySet<string>,
	countTokens: (text: string) => number = defaultCountTokens,
): { contextRanges: ContextRanges; recommendedRanges: CompressibleRange[] } {
	const zoneRefs = new Set(protectedField(messages, state, config, branch, zone).protectedMessageIds
		?? computeProtectedRefs(messages, state, config, countTokens));
	const byRaw = { ...state.messageRefs.byRaw };
	for (const message of messages) {
		const ref = byRaw[message.id];
		if (ref && excludedEntryIds.has(baseIdOf(message.id))) zoneRefs.add(ref);
		if (!ref && message.text?.startsWith(SUMMARY_HEADER)) byRaw[message.id] = SUMMARY_PLACEHOLDER_REF;
	}
	const view = { ...state, messageRefs: { ...state.messageRefs, byRaw } };
	const contextRanges = buildCompressibleRanges(messages, view, config, zoneRefs, countTokens);
	return { contextRanges, recommendedRanges: mergeRangesToThreshold(contextRanges.compressible, config.compress.minCompressRange) };
}

/** Ref a fold summary gets only while ranges are offered: it marks a gap and is never offered. */
const SUMMARY_PLACEHOLDER_REF = "fold-summary";

/** A range a fold request can name now, as a refusal lists it. */
export interface OfferedRange {
	readonly startRef: string;
	readonly endRef: string;
	readonly tokens: number;
}

export interface OfferedRangesInput {
	readonly branch: readonly SessionEntry[];
	readonly contextEntries?: readonly SessionEntry[];
	readonly modelContextLimit: number;
	readonly config?: Partial<Config>;
	/** Entries a pending fold or a `verbatim` hint already takes. */
	readonly excludedEntryIds?: readonly string[];
	readonly protectedZone?: "typed" | "all-user-role";
}

/**
 * The ranges a fold of the branch as it is now would accept, on the view `planFold` plans on, as
 * the fold nudge offers them. A refusal lists these instead of single refs, which models read as
 * a menu and folded one or two at a time, below the size minimum (pi-context-aware#457).
 */
export function offeredFoldRanges(input: OfferedRangesInput): OfferedRange[] {
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const config: Config = defaultConfig(input.modelContextLimit, input.config ?? {});
	const turn = createCore().processTurn({ messages: state.messages, state: state.kernel, config, tokenCount: sentTokens(state) });
	const { recommendedRanges } = foldableRanges(turn.messages, turn.state, config, input.branch, input.protectedZone ?? "typed", new Set(input.excludedEntryIds ?? []));
	return viableRanges(recommendedRanges).map((range) => ({ startRef: range.startRef, endRef: range.endRef, tokens: range.tokens }));
}

/** Active folds whose span overlaps the requested range, in id order. A range named by fold ids overlaps the folds between them. */
function overlappingFolds(state: CompressionState, startRef: string, endRef: string): string[] {
	const start = parseBoundary(startRef);
	const end = parseBoundary(endRef);
	if (!start || !end) return [];
	const lo = Math.min(start.numericId, end.numericId);
	const hi = Math.max(start.numericId, end.numericId);
	const ids: string[] = [];
	for (const block of state.blocks) {
		if (!block.active) continue;
		if (start.kind === "block" && end.kind === "block") {
			const id = Number(block.blockId.slice(1));
			if (id >= lo && id <= hi) ids.push(block.blockId);
			continue;
		}
		const span = resolveBlockSpan(block, state.messageRefs.byRaw);
		const from = span ? parseBoundary(span.startRef) : null;
		const to = span ? parseBoundary(span.endRef) : null;
		if (from && to && from.numericId <= hi && to.numericId >= lo) ids.push(block.blockId);
	}
	return ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The hint each entry on the branch resolves to, after `dropOversizedPairs`. Empty without hints. */
export function hintsOnBranch(branch: readonly SessionEntry[], hints: FoldHintView | undefined): Map<string, ResolvedFoldHint> {
	const found = new Map<string, ResolvedFoldHint>();
	if (!hints) return found;
	for (const entry of branch) {
		const hint = hints.forEntry(entry);
		if (hint) found.set(entry.id, hint);
	}
	dropOversizedPairs(branch, found);
	return found;
}

/**
 * A `verbatim` pair keeps both sides visible, so a large side would pin the other. A pair with a
 * result over the cap, or a call over the cap (#312), folds whole: drop the hint from the call's
 * entry and from every result that pairs with it, so the entry and its results fold together.
 * The call side is measured without its own hint, because `resolve` already dropped it.
 */
function dropOversizedPairs(branch: readonly SessionEntry[], found: Map<string, ResolvedFoldHint>): void {
	const resultOf = new Map<string, { id: string; size: number }>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		resultOf.set(entry.message.toolCallId, { id: entry.id, size: contentLength(entry.message.content) });
	}
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const callIds = entry.message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
		const results = callIds.flatMap((id) => resultOf.get(id) ?? []);
		const callOversized = results.some((result) => found.get(result.id)?.policy === "verbatim") && contentLength(entry.message.content) > MAX_VERBATIM_CHARS;
		const resultOversized = found.get(entry.id)?.policy === "verbatim" && results.some((result) => result.size > MAX_VERBATIM_CHARS);
		if (!callOversized && !resultOversized) continue;
		found.delete(entry.id);
		for (const result of results) found.delete(result.id);
	}
}

/**
 * The protected zone when an extension-injected message would be "the most recent user message"
 * (pi-context-aware#284). Pi sends a `custom_message` as a user-role message, but only a message a
 * person typed moves the boundary: the engine's own rules run with every `custom_message` counted
 * as the assistant's. Typed user messages are unchanged. In `all-user-role` mode, or without a
 * `custom_message` on the branch, the engine computes the zone itself. The per-turn nudge
 * (fold-turn.ts) uses this same helper, so the two rules cannot drift (pi-context-aware#319).
 */
export function protectedField(
	messages: CoreMessage[],
	state: CompressionState,
	config: Config,
	branch: readonly SessionEntry[],
	mode: "typed" | "all-user-role",
): { protectedMessageIds?: Set<string> } {
	if (mode === "all-user-role") return {};
	const injected = new Set(branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.id));
	const extension = (message: CoreMessage) => message.role === "user" && injected.has(baseIdOf(message.id)) && !message.toolCallId;
	if (!messages.some(extension)) return {};
	const projected = messages.map((message) => (extension(message) ? { ...message, role: "assistant" as const } : message));
	return { protectedMessageIds: computeProtectedRefs(projected, state, config, defaultCountTokens) };
}

/** Context edits that show condensed skill text, skipping an entry already showing the same content. */
function swapDrafts(branch: readonly SessionEntry[], swaps: ReadonlyMap<string, ContextEditableContent>): ContextEditEntryDraft[] {
	if (swaps.size === 0) return [];
	const shown = new Map<string, string | null>();
	for (const entry of branch) {
		if (entry.type === "context_edit" && swaps.has(entry.targetId)) {
			shown.set(entry.targetId, entry.replacement === null ? null : JSON.stringify(entry.replacement.content));
		}
	}
	return [...swaps].flatMap(([targetId, content]): ContextEditEntryDraft[] =>
		shown.get(targetId) === JSON.stringify(content) ? [] : [{ type: "context_edit", targetId, replacement: { content } }]);
}
