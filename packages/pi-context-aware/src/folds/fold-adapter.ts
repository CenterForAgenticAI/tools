/**
 * Pi adapter for the copied fold engine.
 *
 * The engine works on a flat list of messages with stable ids and a block
 * state. This module builds both from a Pi session branch: message ids are
 * session entry ids, and the block state is rebuilt from the fold entries on
 * the branch, so nothing outside the session file is needed. A planned fold is
 * returned as boundary drafts; the caller decides when Pi may append them.
 */

import type { SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

import { assignRefs, baseIdOf, countMessageTokens, createCore, createInitialState, defaultConfig, emptyRefMap } from "./kernel/index.js";
import type { CompressionBlock, CompressionState, Config, CoreMessage } from "./kernel/index.js";
import { resolveBoundaries } from "./kernel/boundaries.js";
import { widenFoldCoverage } from "./fold-coverage.js";
import { stubSummaryError } from "./stub-summary.js";
import { DEFAULT_FOLDS_CONFIG, type FoldsConfig } from "../platform/config-layers.js";
import {
	coveredEntryIds,
	foldDrafts,
	foldRecordsOnBranch,
	isEditableEntry,
	renderFoldSummary,
	type FoldRecord,
	type FoldTier,
} from "./fold-entries.js";

type ContentPart = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };

function partsOf(content: unknown): ContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter((part): part is ContentPart => typeof part === "object" && part !== null) : [];
}

function textOf(content: unknown): string {
	return partsOf(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : part.type === "image" ? "[image]" : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

/**
 * Engine messages for one session entry. An assistant entry with tool calls
 * becomes one message per call, with ids `<entry id>#<call id>`; the engine
 * maps those back to the entry with `baseIdOf`.
 */
export function entryToCoreMessages(entry: SessionEntry): CoreMessage[] {
	if (entry.type === "custom_message") {
		return [{ id: entry.id, role: "user", contentType: "text", text: textOf(entry.content) }];
	}
	if (entry.type !== "message") return [];
	// A persisted entry without a message object (hand-edited or damaged file) holds nothing to send.
	if (typeof entry.message !== "object" || entry.message === null) return [];
	const message = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown };
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
	if (message.role !== "assistant") return [];
	const parts = partsOf(message.content);
	const out: CoreMessage[] = [];
	const text = textOf(parts.filter((part) => part.type === "text"));
	if (text.length > 0) out.push({ id: entry.id, role: "assistant", contentType: "text", text });
	for (const part of parts) {
		if (part.type !== "toolCall" || typeof part.id !== "string") continue;
		const name = typeof part.name === "string" ? part.name : "tool";
		out.push({
			id: `${entry.id}#${part.id}`,
			role: "assistant",
			contentType: "tool-call",
			toolCallId: part.id,
			toolName: name,
			text: `${name}(${JSON.stringify(part.arguments ?? {})})`,
		});
	}
	if (out.length === 0) out.push({ id: entry.id, role: "assistant", contentType: "text", text: "" });
	return out;
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
			...(record.refs.start ? { startRef: record.refs.start } : {}),
			...(record.refs.end ? { endRef: record.refs.end } : {}),
		};
	});
	state.nextBlockId = highestBlock + 1;
	state.nextRunId = highestRun + 1;
	return { records, active, messages, kernel: state };
}

function latestReplacementText(branch: readonly SessionEntry[]): Map<string, string> {
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
}

export interface FoldPlanInput extends FoldRequest {
	readonly folds?: FoldsConfig;
	readonly branch: readonly SessionEntry[];
	readonly contextEntries?: readonly SessionEntry[];
	readonly modelContextLimit: number;
	/** Engine settings that differ from its defaults. */
	readonly config?: Partial<Config>;
}

export type FoldPlan =
	| { readonly ok: true; readonly records: FoldRecord[]; readonly drafts: SessionBoundaryDraft[]; readonly warnings: string[] }
	| { readonly ok: false; readonly errors: string[]; readonly validRefs: string[] };

/** Opening user entry protected by the effective policy, using the kernel's CJK-aware estimate. */
export function keptFirstUserId(branch: readonly SessionEntry[], folds: FoldsConfig = DEFAULT_FOLDS_CONFIG): string | undefined {
	const first = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	if (!first || folds.firstUserMessage === "fold") return undefined;
	const tokens = entryToCoreMessages(first).reduce((sum, message) => sum + countMessageTokens(message), 0);
	return folds.firstUserMessage === "keep" || tokens <= folds.firstUserMessageMaxTokens ? first.id : undefined;
}

/**
 * Widen message ranges to whole Pi entries and tool pairs, then run the
 * engine's validation (protected recent messages, tool pairs, summary limits).
 * Refuse a cut-off summary, and any protected carve that leaves a partial entry.
 * Nothing is written: the
 * drafts go to Pi from a boundary handler.
 */
export function planFold(input: FoldPlanInput): FoldPlan {
	const state = foldStateFromBranch(input.branch, input.contextEntries);
	const config: Config = defaultConfig(input.modelContextLimit, input.config ?? {});
	const stub = stubSummaryError(input.summary);
	if (stub) return { ok: false, errors: [stub], validRefs: validFoldRefs(state) };
	let startRef = input.startRef;
	let endRef = input.endRef;
	let boundaryKind: string;
	try {
		const resolved = resolveBoundaries({ startRef, endRef, messages: state.messages, state: state.kernel });
		boundaryKind = resolved.boundaryKind;
		const widened = new Set(widenFoldCoverage(state.messages, resolved.messageIds, true));
		const first = state.messages.findIndex((message) => widened.has(message.id));
		const last = state.messages.reduce((last, message, index) => widened.has(message.id) ? index : last, -1);
		if (resolved.boundaryKind === "block") {
			// Replacing a bN endpoint with mNNNNN changes the engine's tier semantics.
			if (first < resolved.startIndex || last > resolved.endIndex) {
				return { ok: false, errors: ["Block range would split an entry or tool pair; include the adjacent entries explicitly."], validRefs: validFoldRefs(state) };
			}
		} else if (first >= 0 && last >= 0) {
			startRef = state.kernel.messageRefs.byRaw[state.messages[first]!.id]!;
			endRef = state.kernel.messageRefs.byRaw[state.messages[last]!.id]!;
		}
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)], validRefs: validFoldRefs(state) };
	}
	const before = new Set(state.kernel.blocks.map((block) => block.blockId));
	const result = createCore().applyCompression({
		ranges: [
			{
				startRef,
				endRef,
				summary: input.summary,
				...(input.topic ? { topic: input.topic } : {}),
			},
		],
		messages: state.messages,
		state: state.kernel,
		config,
	});
	const created = result.state.blocks.filter((block) => !before.has(block.blockId));
	if (result.result.errors.length > 0 || created.length === 0) {
		const errors = result.result.errors.length > 0 ? result.result.errors : ["The engine created no fold for this range."];
		return { ok: false, errors, validRefs: validFoldRefs(state) };
	}
	const keptFirst = keptFirstUserId(input.branch, input.folds);
	const indexById = new Map(input.branch.map((entry, index) => [entry.id, index]));
	const entryById = new Map(input.branch.map((entry) => [entry.id, entry]));
	if (keptFirst && boundaryKind !== "block") {
		// The engine counts the kept opening message as unfolded, so a message range over
		// folded entries plus that message would refold them and hide nothing new. Refuse it
		// as the engine refuses any message range with no new compressible message.
		const folded = new Set(state.active.flatMap(coveredEntryIds));
		const touched = new Set(created.flatMap((block) => block.effectiveMessageIds.map(baseIdOf)));
		const fresh = [...touched].filter((id) => {
			const entry = entryById.get(id);
			return id !== keptFirst && entry !== undefined && isEditableEntry(entry) && !folded.has(id);
		});
		const absorbed = [...new Set(created.flatMap((block) => block.directBlockIds))];
		if (touched.has(keptFirst) && fresh.length === 0 && absorbed.length > 0) {
			return { ok: false, errors: [`Range ${input.startRef}..${input.endRef} contains no new compressible messages: the first user message is kept visible and every other message in it is already covered by active block(s) ${absorbed.join(", ")}. Nothing was compressed.`], validRefs: validFoldRefs(state) };
		}
	}
	const records: FoldRecord[] = [];
	const drafts: SessionBoundaryDraft[] = [];
	for (const block of created) {
		const selected = new Set(block.effectiveMessageIds);
		if (widenFoldCoverage(state.messages, block.effectiveMessageIds).some((id) => !selected.has(id))) {
			return { ok: false, errors: ["Engine protection would split a session entry or tool pair; wait until the whole entry can fold."], validRefs: validFoldRefs(state) };
		}
		const covered = [...new Set(block.effectiveMessageIds.map(baseIdOf))]
			.filter((id) => {
				const entry = entryById.get(id);
				return entry !== undefined && isEditableEntry(entry) && id !== keptFirst;
			})
			.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
		const [carrierId, ...hiddenIds] = covered;
		if (!carrierId) return { ok: false, errors: [keptFirst && block.effectiveMessageIds.includes(keptFirst)
			? "Keeping the first user message leaves nothing else to fold (covers no session entry)."
			: `Fold ${block.blockId} covers no session entry.`], validRefs: validFoldRefs(state) };
		const keptTokens = keptFirst && block.effectiveMessageIds.includes(keptFirst)
			? state.messages.filter((message) => message.id === keptFirst).reduce((sum, message) => sum + countMessageTokens(message), 0) : 0;
		const record: FoldRecord = {
			version: 1,
			blockId: block.blockId,
			runId: block.runId,
			tier: block.tier as FoldTier,
			...(block.topic ? { topic: block.topic } : {}),
			carrierId,
			hiddenIds,
			range: { startId: carrierId, endId: covered[covered.length - 1] ?? carrierId },
			refs: { start: block.startRef ?? input.startRef, end: block.endRef ?? input.endRef },
			directBlockIds: [...block.directBlockIds],
			compressedTokens: Math.max(0, block.compressedTokens - keptTokens),
			createdAt: block.createdAt,
			origin: "fold",
		};
		records.push(record);
		drafts.push(...foldDrafts(record, renderFoldSummary(block.summary, block.topic)));
	}
	return { ok: true, records, drafts, warnings: [...result.result.warnings] };
}
