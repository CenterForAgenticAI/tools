/**
 * `context_recall({ ref })`: the original entries behind one fold or one recoverable hide.
 *
 * A fold hides its covered entries with `context_edit` entries; the entries
 * themselves stay on the branch. A recoverable hide (`h1`, ..., pi-context-aware#268) shortens one
 * entry the same way. Ref mode reads the originals from the branch, never from
 * the folded context view, and writes nothing: the fold or hide stays in effect.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { coveredEntryIds, foldRecordsOnBranch, type FoldRecord } from "../folds/fold-entries.js";
import { hideRecordsOnBranch, isHideId, type HideRecord } from "../folds/hide-entries.js";

/** Most characters of original text one call returns. Longer folds page with `offset`. */
export const MAX_REF_PAGE_CHARACTERS = 12_000;

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
		`billion-context-pi is loaded, so the folds in this session are its own and context_recall has no record of them. Use its own tool to restore ${JSON.stringify(ref)}.`,
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
/** The newest record for a hide id on this branch. */
function hideFor(branch: readonly SessionEntry[], ref: string): HideRecord | undefined {
	let found: HideRecord | undefined;
	for (const { record } of hideRecordsOnBranch(branch)) if (record.hideId === ref) found = record;
	return found;
}

export function recallRef(request: ContextRecallRefRequest, branch: readonly SessionEntry[]): ContextRecallRefResult {
	const ref = typeof request.ref === "string" ? request.ref.trim() : "";
	const hide = isHideId(ref) ? hideFor(branch, ref) : undefined;
	const record = hide ? undefined : recordFor(branch, ref);
	if (!hide && !record) {
		const known = [...new Set(foldRecordsOnBranch(branch).map(({ record: folded }) => folded.blockId))];
		const hides = [...new Set(hideRecordsOnBranch(branch).map(({ record: hidden }) => hidden.hideId))];
		const listed = [
			known.length > 0 ? `Folds on this branch: ${known.join(", ")}.` : "This branch has no folds.",
			...(hides.length > 0 ? [`Hides on this branch: ${hides.join(", ")}.`] : []),
		].join(" ");
		return refusal(ref, "unknown ref", `No fold or hide ${JSON.stringify(ref)} on this branch. ${listed}`);
	}
	const label = hide ? `Hide ${hide.hideId}` : `Fold ${record!.blockId}${record!.topic ? ` (${record!.topic})` : ""}`;
	const refId = hide ? hide.hideId : record!.blockId;
	const stays = hide ? "The hide stays in place." : "The fold stays in place.";
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const covered = hide ? [hide.targetId] : coveredEntryIds(record!);
	const entries = covered.map((id) => byId.get(id)).filter((entry): entry is SessionEntry => entry !== undefined);
	const missing = covered.filter((id) => !byId.has(id));
	const full = entries.map(renderEntry).join("\n\n");
	const offset = Math.min(pageStart(request.offset), full.length);
	const end = Math.min(full.length, offset + MAX_REF_PAGE_CHARACTERS);
	const more = end < full.length;
	const lines = [
		`${label}: ${entries.length} original entr${entries.length === 1 ? "y" : "ies"}, characters ${offset}-${end} of ${full.length}. ${stays}`,
		full.slice(offset, end),
	];
	if (missing.length > 0) lines.push(`[Not on this branch: ${missing.join(", ")}]`);
	if (more) lines.push(`[More: call context_recall({ ref: ${JSON.stringify(refId)}, offset: ${end} }) for the next page.]`);
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			mode: "ref",
			ref: refId,
			entry_ids: entries.map((entry) => entry.id),
			missing_entry_ids: missing,
			offset,
			end,
			total_characters: full.length,
			...(more ? { next_offset: end } : {}),
		},
	};
}
