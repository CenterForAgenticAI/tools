/**
 * Import of legacy billion-context-pi side files (`<session>.jsonl.acp.json`).
 *
 * This is a pure function: it reads the side file's text and the session's
 * entries and returns fold drafts. It never writes, so the side file cannot
 * change. Unknown formats are reported, not converted. Callers must run it
 * only once the erasure ledger exists and pass its erased ids.
 */

import type { SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { erasedSessionIds } from "../erasure/database.js";

import { FOLD_ENTRY_TYPE, foldDrafts, isEditableEntry, renderFoldSummary, type FoldRecord } from "./fold-entries.js";
import { baseIdOf } from "./kernel/prune.js";
import { entryToCoreMessages } from "./fold-adapter.js";
import { widenFoldCoverage } from "./fold-coverage.js";

/** Side-file schema versions this import understands. */
export const SUPPORTED_ACP_SCHEMA_VERSIONS: readonly number[] = [1];

export interface AcpImportInput {
	/** Side-file text, exactly as read from disk. */
	readonly sideFileText: string;
	/** Every entry of the session, used to detect an earlier import. */
	readonly entries: readonly SessionEntry[];
	/** The branch the folds are stored on. */
	readonly branch: readonly SessionEntry[];
	readonly sessionId: string;
	/** Erased sessions and entries; erased content is never imported. */
	readonly erased?: { readonly sessionIds: ReadonlySet<string>; readonly entryIds: ReadonlySet<string> };
}

export type AcpImportResult =
	| { readonly status: "imported"; readonly records: FoldRecord[]; readonly drafts: SessionBoundaryDraft[]; readonly skippedBlocks: AcpSkippedBlock[] }
	| { readonly status: "skipped"; readonly reason: "already-folded" | "erased-session" | "no-blocks" }
	| { readonly status: "unsupported"; readonly reason: string };

export interface AcpSkippedBlock {
	readonly blockId: string;
	readonly reason: string;
}

const BLOCK_ID = /^b[1-9]\d*$/u;
const RUN_ID = /^r[1-9]\d*$/u;

interface LegacyBlock {
	blockId: string;
	runId: string;
	tier: 1 | 2 | 3;
	topic?: string;
	summary: string;
	effectiveMessageIds: string[];
	directBlockIds: string[];
	compressedTokens: number;
	createdAt: number;
	active: boolean;
	startRef?: string;
	endRef?: string;
}

/** Required entry point for persisted imports/backfill; the pure importer below is for shadow previews. */
export function importAcpSideFileFromProfile(agentDir: string, input: AcpImportInput): AcpImportResult {
	return importAcpSideFile({
		...input,
		erased: {
			sessionIds: new Set([...erasedSessionIds(agentDir), ...(input.erased?.sessionIds ?? [])]),
			entryIds: input.erased?.entryIds ?? new Set(),
		},
	});
}

export function importAcpSideFile(input: AcpImportInput): AcpImportResult {
	if (input.entries.some((entry) => entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE)) {
		return { status: "skipped", reason: "already-folded" };
	}
	if (input.erased?.sessionIds.has(input.sessionId)) return { status: "skipped", reason: "erased-session" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(input.sideFileText);
	} catch {
		return { status: "unsupported", reason: "not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { status: "unsupported", reason: "not a JSON object" };
	}
	const document = parsed as Record<string, unknown>;
	const schemaVersion = document.schemaVersion;
	if (typeof schemaVersion !== "number" || !SUPPORTED_ACP_SCHEMA_VERSIONS.includes(schemaVersion)) {
		return { status: "unsupported", reason: `unknown schemaVersion ${JSON.stringify(schemaVersion ?? null)}` };
	}
	if (!Array.isArray(document.blocks)) return { status: "unsupported", reason: "blocks is not an array" };

	const blocks: LegacyBlock[] = [];
	const skippedBlocks: AcpSkippedBlock[] = [];
	document.blocks.forEach((raw, index) => {
		const block = readLegacyBlock(raw);
		if (typeof block === "string") skippedBlocks.push({ blockId: blockIdOf(raw) ?? `#${index}`, reason: block });
		else blocks.push(block);
	});

	// Import folds still in effect and the folds they absorbed. A block that is
	// inactive for any other reason was expanded or discarded upstream.
	const byId = new Map(blocks.map((block) => [block.blockId, block]));
	const keep = new Set<string>();
	const visit = (blockId: string) => {
		if (keep.has(blockId)) return;
		const block = byId.get(blockId);
		if (!block) return;
		keep.add(blockId);
		block.directBlockIds.forEach(visit);
	};
	blocks.filter((block) => block.active).forEach((block) => visit(block.blockId));
	for (const block of blocks) {
		if (!keep.has(block.blockId)) skippedBlocks.push({ blockId: block.blockId, reason: "inactive" });
	}

	const indexById = new Map(input.branch.map((entry, index) => [entry.id, index]));
	const entryById = new Map(input.branch.map((entry) => [entry.id, entry]));
	const erasedEntries = input.erased?.entryIds ?? new Set<string>();
	const messages = input.branch.flatMap(entryToCoreMessages);
	const records: FoldRecord[] = [];
	const drafts: SessionBoundaryDraft[] = [];
	const imported = new Set<string>();
	for (const block of blocks) {
		if (!keep.has(block.blockId)) continue;
		const messageIds = widenFoldCoverage(messages, block.effectiveMessageIds);
		if (messageIds.some((id) => erasedEntries.has(baseIdOf(id)))) {
			skippedBlocks.push({ blockId: block.blockId, reason: "covers erased entries" });
			continue;
		}
		const covered = [...new Set(messageIds.map(baseIdOf))]
			.filter((id) => {
				const entry = entryById.get(id);
				return entry !== undefined && isEditableEntry(entry);
			})
			.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
		const [carrierId, ...hiddenIds] = covered;
		if (!carrierId) {
			skippedBlocks.push({ blockId: block.blockId, reason: "covers no entry on this branch" });
			continue;
		}
		const record: FoldRecord = {
			version: 1,
			blockId: block.blockId,
			runId: block.runId,
			tier: block.tier,
			...(block.topic ? { topic: block.topic } : {}),
			carrierId,
			hiddenIds,
			range: { startId: carrierId, endId: covered[covered.length - 1] ?? carrierId },
			refs: { start: block.startRef ?? "", end: block.endRef ?? "" },
			directBlockIds: block.directBlockIds.filter((id) => imported.has(id)),
			compressedTokens: block.compressedTokens,
			createdAt: block.createdAt,
			origin: "acp-import",
		};
		imported.add(block.blockId);
		records.push(record);
		drafts.push(...foldDrafts(record, renderFoldSummary(block.summary, block.topic)));
	}
	if (records.length === 0 && skippedBlocks.length === 0) return { status: "skipped", reason: "no-blocks" };
	return { status: "imported", records, drafts, skippedBlocks };
}

function blockIdOf(raw: unknown): string | undefined {
	return typeof raw === "object" && raw !== null && typeof (raw as { blockId?: unknown }).blockId === "string"
		? (raw as { blockId: string }).blockId
		: undefined;
}

/** Copy the named fields of one legacy block, or return why it cannot be read. */
function readLegacyBlock(raw: unknown): LegacyBlock | string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not an object";
	const block = raw as Record<string, unknown>;
	const { blockId, runId, tier, topic, summary, effectiveMessageIds, directBlockIds, active } = block;
	if (typeof blockId !== "string" || !BLOCK_ID.test(blockId)) return "invalid blockId";
	if (typeof runId !== "string" || !RUN_ID.test(runId)) return "invalid runId";
	if (tier !== 1 && tier !== 2 && tier !== 3) return "invalid tier";
	if (typeof summary !== "string") return "missing summary";
	if (!isStringArray(effectiveMessageIds)) return "invalid effectiveMessageIds";
	if (directBlockIds !== undefined && !isStringArray(directBlockIds)) return "invalid directBlockIds";
	if (typeof active !== "boolean") return "invalid active flag";
	return {
		blockId,
		runId,
		tier,
		...(typeof topic === "string" && topic.length > 0 ? { topic } : {}),
		summary,
		effectiveMessageIds: [...effectiveMessageIds],
		directBlockIds: (directBlockIds ?? []).filter((id) => BLOCK_ID.test(id)),
		compressedTokens: nonNegative(block.compressedTokens),
		createdAt: nonNegative(block.createdAt),
		active,
		...(typeof block.startRef === "string" ? { startRef: block.startRef } : {}),
		...(typeof block.endRef === "string" ? { endRef: block.endRef } : {}),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
