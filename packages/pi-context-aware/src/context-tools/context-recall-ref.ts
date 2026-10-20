/**
 * `context_recall({ ref })`: the original entries behind one fold.
 *
 * A fold hides its covered entries with `context_edit` entries; the entries
 * themselves stay on the branch. Ref mode reads them from the branch, never from
 * the folded context view, and writes nothing: the fold stays in effect.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { coveredEntryIds, foldRecordsOnBranch, type FoldRecord } from "../folds/fold-entries.js";

/** Most characters of original text one call returns. Longer folds page with `offset`. */
export const MAX_REF_PAGE_CHARACTERS = 12_000;

/** billion-context-pi 0.1.83's `decompress` parameters. */
export const decompressSchema = Type.Object({
	blockId: Type.String({ description: "Fold block id to restore, for example \"b5\". The fold stays in place." }),
	full: Type.Optional(Type.Boolean({ description: "Accepted for compatibility with billion-context-pi and ignored: the original entries are always returned." })),
	toFile: Type.Optional(Type.String({ description: "Accepted for compatibility with billion-context-pi and ignored: the content is returned in pages." })),
	inline: Type.Optional(Type.Boolean({ description: "Accepted for compatibility with billion-context-pi and ignored: the content is returned in pages." })),
});
export type DecompressParams = Static<typeof decompressSchema>;

export interface ContextRecallRefRequest {
	readonly ref: string;
	readonly offset?: number;
}

export type ContextRecallRefError = "folds owned by billion-context-pi" | "unknown ref" | "query and ref";

export interface ContextRecallRefDetails {
	readonly mode: "ref";
	readonly ref: string;
	readonly error?: ContextRecallRefError;
	/** Covered entries found on the branch, carrier first. */
	readonly entry_ids: readonly string[];
	/** Covered entries the fold names that the branch no longer holds. */
	readonly missing_entry_ids: readonly string[];
	readonly offset: number;
	readonly end: number;
	readonly total_characters: number;
	readonly next_offset?: number;
}

export interface ContextRecallRefResult {
	content: Array<{ type: "text"; text: string }>;
	details: ContextRecallRefDetails;
	isError?: boolean;
}

export function decompressRequest(params: DecompressParams): ContextRecallRefRequest {
	return { ref: params.blockId };
}

function refusal(ref: string, error: ContextRecallRefError, text: string): ContextRecallRefResult {
	return {
		content: [{ type: "text", text }],
		details: { mode: "ref", ref, error, entry_ids: [], missing_entry_ids: [], offset: 0, end: 0, total_characters: 0 },
		isError: true,
	};
}

export function refuseQueryAndRef(ref: string): ContextRecallRefResult {
	return refusal(ref, "query and ref", "context_recall takes either a query or a ref, not both.");
}

export function refuseBillionContextPiFolds(ref: string): ContextRecallRefResult {
	return refusal(
		ref,
		"folds owned by billion-context-pi",
		`billion-context-pi is loaded, so the folds in this session are its own and context_recall has no record of them. Call decompress({ blockId: ${JSON.stringify(ref)} }) instead.`,
	);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; thinking?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(`[thinking]\n${block.thinking}`);
		else if (block.type === "toolCall") parts.push(`[tool call ${String(block.name)}] ${JSON.stringify(block.arguments ?? {})}`);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** One covered entry as it was written, before any fold replaced or hid it. */
function renderEntry(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message as { role?: unknown; content?: unknown; toolName?: unknown };
		const role = typeof message.role === "string" ? message.role : "message";
		const label = role === "toolResult" && typeof message.toolName === "string" ? `toolResult ${message.toolName}` : role;
		return `--- ${entry.id} (${label}) ---\n${contentText(message.content)}`;
	}
	if (entry.type === "custom_message") {
		return `--- ${entry.id} (custom_message ${entry.customType}) ---\n${contentText(entry.content)}`;
	}
	return `--- ${entry.id} (${entry.type}) ---`;
}

/** The newest record for a block id on this branch: refolding in place keeps the id. */
function recordFor(branch: readonly SessionEntry[], ref: string): FoldRecord | undefined {
	let found: FoldRecord | undefined;
	for (const { record } of foldRecordsOnBranch(branch)) if (record.blockId === ref) found = record;
	return found;
}

function pageStart(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Resolve one fold ref against the branch entries and return one page of the original text. */
export function recallRef(request: ContextRecallRefRequest, branch: readonly SessionEntry[]): ContextRecallRefResult {
	const ref = typeof request.ref === "string" ? request.ref.trim() : "";
	const record = recordFor(branch, ref);
	if (!record) {
		const known = [...new Set(foldRecordsOnBranch(branch).map(({ record: folded }) => folded.blockId))];
		return refusal(ref, "unknown ref", `No fold ${JSON.stringify(ref)} on this branch. ${known.length > 0 ? `Folds on this branch: ${known.join(", ")}.` : "This branch has no folds."}`);
	}
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const covered = coveredEntryIds(record);
	const entries = covered.map((id) => byId.get(id)).filter((entry): entry is SessionEntry => entry !== undefined);
	const missing = covered.filter((id) => !byId.has(id));
	const full = entries.map(renderEntry).join("\n\n");
	const offset = Math.min(pageStart(request.offset), full.length);
	const end = Math.min(full.length, offset + MAX_REF_PAGE_CHARACTERS);
	const more = end < full.length;
	const lines = [
		`Fold ${record.blockId}${record.topic ? ` (${record.topic})` : ""}: ${entries.length} original entr${entries.length === 1 ? "y" : "ies"}, characters ${offset}-${end} of ${full.length}. The fold stays in place.`,
		full.slice(offset, end),
	];
	if (missing.length > 0) lines.push(`[Not on this branch: ${missing.join(", ")}]`);
	if (more) lines.push(`[More: call context_recall({ ref: ${JSON.stringify(record.blockId)}, offset: ${end} }) for the next page.]`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			mode: "ref",
			ref: record.blockId,
			entry_ids: entries.map((entry) => entry.id),
			missing_entry_ids: missing,
			offset,
			end,
			total_characters: full.length,
			...(more ? { next_offset: end } : {}),
		},
	};
}
