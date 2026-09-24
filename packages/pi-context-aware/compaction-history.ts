import * as os from "node:os";
import * as path from "node:path";
import { MAX_COMPACTION_HISTORY_PROMPT_CHARS } from "./workstream-context.js";

/** Boundary-only metadata for one compaction on the current session branch. */
export interface ContextAwareSessionCompactionV1 {
	ordinal: number;
	id: string | null;
	parentId: string | null;
	timestamp: string | null;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
	fromHook: boolean | null;
	priorTranscriptPath: string | null;
}

export interface CompactionHistoryV1 {
	compactions: ContextAwareSessionCompactionV1[];
	priorTranscriptPaths: string[];
}

/**
 * Render only public boundary metadata for a model-facing history result.
 * Private compaction details and transcript contents are never included.
 */
export function formatCompactionCountPrompt(
	history: CompactionHistoryV1,
	maxChars = MAX_COMPACTION_HISTORY_PROMPT_CHARS,
): string | null {
	const count = history.compactions.length;
	if (count === 0) return null;
	return `Current session branch compaction count: ${count}.`.slice(0, Math.max(1, Math.floor(maxChars)));
}

export function formatCompactionHistory(history: CompactionHistoryV1): string {
	const count = history.compactions.length;
	const lines = [`Current session branch has ${count} compaction${count === 1 ? "" : "s"}.`];
	for (const compaction of history.compactions) {
		const identifiers = [
			["id", compaction.id],
			["parentId", compaction.parentId],
			["firstKeptEntryId", compaction.firstKeptEntryId],
			["timestamp", compaction.timestamp],
			["priorTranscriptPath", compaction.priorTranscriptPath],
		] as const;
		const available = identifiers
			.filter(([, value]) => value !== null)
			.map(([name, value]) => `${name}=${value}`);
		lines.push(`${compaction.ordinal}. ${available.length > 0 ? available.join("; ") : "no boundary metadata available"}`);
	}
	return lines.join("\n");
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	return Number.isNaN(Date.parse(value)) ? null : value;
}

function nullableTokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizePriorTranscriptPath(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		return value.startsWith("~/")
			? path.join(os.homedir(), value.slice(2))
			: path.resolve(value);
	} catch {
		return null;
	}
}

/**
 * Extract boundary metadata from an already-selected current leaf branch.
 * This function never reads the filesystem or transcript files.
 */
export function collectCompactionHistory(branch: readonly unknown[]): CompactionHistoryV1 {
	if (!Array.isArray(branch)) return { compactions: [], priorTranscriptPaths: [] };

	const compactions: ContextAwareSessionCompactionV1[] = [];
	const priorTranscriptPaths: string[] = [];
	for (const entry of branch) {
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "compaction") continue;
		const record = entry as {
			id?: unknown;
			parentId?: unknown;
			timestamp?: unknown;
			firstKeptEntryId?: unknown;
			tokensBefore?: unknown;
			fromHook?: unknown;
			details?: unknown;
		};
		let priorTranscriptPath: string | null = null;
		if (record.details && typeof record.details === "object" && !Array.isArray(record.details)) {
			try {
				priorTranscriptPath = normalizePriorTranscriptPath((record.details as { priorTranscriptPath?: unknown }).priorTranscriptPath);
			} catch {
				// Malformed details are represented as nullable boundary metadata.
			}
		}
		if (priorTranscriptPath !== null) priorTranscriptPaths.push(priorTranscriptPath);
		compactions.push({
			ordinal: compactions.length + 1,
			id: nullableString(record.id),
			parentId: nullableString(record.parentId),
			timestamp: nullableTimestamp(record.timestamp),
			firstKeptEntryId: nullableString(record.firstKeptEntryId),
			tokensBefore: nullableTokenCount(record.tokensBefore),
			fromHook: typeof record.fromHook === "boolean" ? record.fromHook : null,
			priorTranscriptPath,
		});
	}
	return { compactions, priorTranscriptPaths };
}
