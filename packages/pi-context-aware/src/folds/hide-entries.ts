/**
 * Recoverable hide (pi-context-aware#268): the last ladder step, stored.
 *
 * At `recoverableHideFraction` the fold pass shortens oversized old messages in the request. Alone that
 * is lost to the model: the request carries no pointer back. This module is the durable half. For each
 * message the pass shortened, the engine writes at the next boundary:
 *
 * - one custom entry of type {@link HIDE_ENTRY_TYPE} naming the hide (`h1`, `h2`, ...) and its target;
 * - one `context_edit` entry that replaces the message content with its head, its tail and a
 *   `context_recall` pointer line.
 *
 * The original entry stays on the branch, so `context_recall({ ref: "h1" })` returns it. A hide is not
 * a fold: the fold engine never counts, nudges about, absorbs or numbers it (its ids are `h<N>`, a fold's
 * `b<N>`), and it is recorded under its own entry type.
 */

import type { ContextEditableContent, ContextEditEntryDraft, CustomEntryDraft, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

import { entryToCoreMessages } from "./fold-adapter.js";
import { isEditableEntry } from "./fold-entries.js";
import { defaultCountTokens } from "./kernel/index.js";
import { clampPrefix, clampWindow } from "./kernel/truncate.js";

export const HIDE_ENTRY_TYPE = "context-aware.hide.v1";

/** The kernel's own marker on a message it shortened (kernel/truncate-tools.ts). A hide keeps it, so the kernel leaves a hidden message alone. */
export const TRUNCATION_MARKER = "[truncated for context space]";

/** Characters kept at each end: the kernel's `keepPrefixChars` and `keepSuffixChars`. */
export const HIDE_KEEP_CHARS = 2_000;

/** At most nine digits: the number stays a safe integer, so a hand-edited record cannot make the next id `hInfinity`. Such a record is ignored. */
const HIDE_ID = /^h[1-9]\d{0,8}$/u;
/** The largest hide number HIDE_ID accepts. */
const MAX_HIDE_NUMBER = 999_999_999;

/** Metadata stored in a hide's custom entry. */
export interface HideRecord {
	readonly version: 1;
	readonly hideId: string;
	/** Entry whose model-visible content the hide shortened. Its original stays on the branch. */
	readonly targetId: string;
	/** Tokens the original text held. */
	readonly originalTokens: number;
	readonly createdAt: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read hide metadata from a custom entry's data. Session files are not trusted: anything that does not
 * match the schema exactly is rejected, and the record holds copies of the named fields only.
 */
export function readHideRecord(data: unknown): HideRecord | undefined {
	if (!isObject(data) || data.version !== 1) return undefined;
	const { hideId, targetId } = data;
	if (typeof hideId !== "string" || !HIDE_ID.test(hideId)) return undefined;
	if (typeof targetId !== "string" || targetId.length === 0) return undefined;
	const originalTokens = nonNegative(data.originalTokens);
	const createdAt = nonNegative(data.createdAt);
	if (originalTokens === undefined || createdAt === undefined) return undefined;
	return { version: 1, hideId, targetId, originalTokens, createdAt };
}

/** True for a ref of the form `h<N>`: a hide, not a fold. */
export function isHideId(ref: string): boolean {
	return HIDE_ID.test(ref);
}

/** Hide metadata entries on a branch, in path order, with the entry that holds each. */
export function hideRecordsOnBranch(branch: readonly SessionEntry[]): { entryId: string; record: HideRecord }[] {
	const found: { entryId: string; record: HideRecord }[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== HIDE_ENTRY_TYPE) continue;
		const record = readHideRecord(entry.data);
		if (record) found.push({ entryId: entry.id, record });
	}
	return found;
}

export function hidePointerLine(hideId: string): string {
	return `[Recover the original with context_recall({ ref: "${hideId}" }).]`;
}

/** The line the kernel writes between a shortened message's head and tail (kernel/truncate-tools.ts). */
const KERNEL_MARK_LINE = /(\.\.\.\[truncated for context space\] — original ~\d+ tokens\]\.\.\.\n)/u;

/**
 * A message the kernel shortened, with the pointer line added after its marker. Text without the kernel's
 * marker line comes back unchanged.
 */
export function withPointer(shortened: string, hideId: string): string {
	return shortened.replace(KERNEL_MARK_LINE, (line) => line + hidePointerLine(hideId) + "\n");
}

/** What the kernel's emergency step makes of `original`: its head, a marker line, its tail. */
export function shortenedText(original: string, originalTokens: number): string {
	const head = clampPrefix(original, HIDE_KEEP_CHARS);
	const tail = clampWindow(original, original.length - HIDE_KEEP_CHARS, original.length);
	return `${head}\n\n...${TRUNCATION_MARKER} — original ~${originalTokens} tokens]...\n\n${tail}`;
}

/** The text a hidden message carries: its head, its tail, the kernel's marker and a pointer line. */
export function hideText(original: string, hideId: string, originalTokens: number): string {
	return withPointer(shortenedText(original, originalTokens), hideId);
}

type Part = { type?: unknown; text?: unknown };

/**
 * The entry's content with its text replaced. The first text part carries the new text and the others
 * are dropped; every other part (an image, a thinking block) stays where it was. Undefined when the
 * entry has no text to replace.
 */
function contentWithText(entry: SessionEntry, text: string): ContextEditableContent | undefined {
	const content = entry.type === "custom_message" ? entry.content : entry.type === "message" ? (entry.message as { content?: unknown }).content : undefined;
	if (typeof content === "string") return text;
	if (!Array.isArray(content)) return undefined;
	let placed = false;
	const parts: unknown[] = [];
	for (const part of content as Part[]) {
		if (part?.type !== "text") { parts.push(part); continue; }
		if (placed) continue;
		placed = true;
		parts.push({ ...part, text });
	}
	return placed ? parts as ContextEditableContent : undefined;
}

/** Text of a replacement's content, as the fold pass reads an entry's text. */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Part[]).flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** A hide still in effect on a branch. */
export interface ActiveHide {
	readonly record: HideRecord;
	/** Entry that holds the hide's metadata. */
	readonly recordEntryId: string;
	/** The text the hidden entry carries now. */
	readonly text: string;
}

/**
 * The hides in effect on a branch. A hide stays in effect while the newest `context_edit` of its target is
 * its own edit, the one that carries its pointer line. A later edit of the target (a fold's carrier summary,
 * or a fold omitting it) ends the hide, so the fold's own accounting stands.
 */
export function activeHides(branch: readonly SessionEntry[]): ActiveHide[] {
	const records = hideRecordsOnBranch(branch);
	if (records.length === 0) return [];
	const targets = new Set(records.map(({ record }) => record.targetId));
	const newest = new Map<string, string | null>();
	for (const entry of branch) {
		if (entry.type !== "context_edit" || !targets.has(entry.targetId)) continue;
		newest.set(entry.targetId, entry.replacement === null ? null : textOfContent(entry.replacement.content));
	}
	const found: ActiveHide[] = [];
	for (const { entryId, record } of records) {
		const text = newest.get(record.targetId);
		if (typeof text === "string" && text.includes(hidePointerLine(record.hideId))) found.push({ record, recordEntryId: entryId, text });
	}
	return found;
}

/** The highest hide number used by the branch or by drafts not yet written. */
export function highestHideNumber(branch: readonly SessionEntry[], pending: readonly SessionBoundaryDraft[] = []): number {
	let highest = 0;
	const note = (record: HideRecord | undefined) => { if (record) highest = Math.max(highest, Number(record.hideId.slice(1))); };
	for (const { record } of hideRecordsOnBranch(branch)) note(record);
	for (const draft of pending) if (draft.type === "custom" && draft.customType === HIDE_ENTRY_TYPE) note(readHideRecord(draft.data));
	return highest;
}

/** One hide, ready to write: its metadata entry, then the content edit. Both or neither. */
export interface HidePlan {
	readonly hideId: string;
	readonly targetId: string;
	readonly drafts: readonly [CustomEntryDraft, ContextEditEntryDraft];
}

/**
 * Plan the hides for `candidates` (entry ids). A candidate is skipped when it can no longer be hidden safely:
 *
 * - it is not on the branch, or Pi would refuse an edit of it;
 * - it was edited already (an earlier hide, a fold's carrier or covered entry), on the branch or in
 *   `pending` drafts of the same boundary: a second edit would replace the first, or bring back an entry
 *   a fold omitted;
 * - it holds more than one engine message, no text, or text the kernel would not shorten (too short, or
 *   already shortened).
 *
 * The metadata entry comes first, so a write that stops between the two leaves a record whose target is
 * unchanged (not an active hide), never an edit that names an id nothing resolves.
 */
export function planHides(
	branch: readonly SessionEntry[],
	candidates: readonly string[],
	pending: readonly SessionBoundaryDraft[] = [],
	now: number = Date.now(),
): HidePlan[] {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const edited = new Set<string>();
	for (const entry of branch) if (entry.type === "context_edit") edited.add(entry.targetId);
	for (const draft of pending) if (draft.type === "context_edit") edited.add(draft.targetId);
	let number = highestHideNumber(branch, pending);
	const plans: HidePlan[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const entry = byId.get(candidate);
		if (!entry || !isEditableEntry(entry) || edited.has(entry.id)) continue;
		const cores = entryToCoreMessages(entry);
		const core = cores[0];
		if (cores.length !== 1 || !core || core.id !== entry.id || (core.contentType !== "text" && core.contentType !== "tool-result")) continue;
		const text = core.text ?? "";
		if (text.length <= 2 * HIDE_KEEP_CHARS || text.includes(TRUNCATION_MARKER)) continue;
		const originalTokens = defaultCountTokens(text);
		// The next id must still read back: past the largest number HIDE_ID accepts, nothing more is hidden.
		if (number >= MAX_HIDE_NUMBER) break;
		const hideId = `h${number + 1}`;
		const content = contentWithText(entry, hideText(text, hideId, originalTokens));
		if (content === undefined) continue;
		number += 1;
		const record: HideRecord = { version: 1, hideId, targetId: entry.id, originalTokens, createdAt: now };
		plans.push({
			hideId,
			targetId: entry.id,
			drafts: [{ type: "custom", customType: HIDE_ENTRY_TYPE, data: record }, { type: "context_edit", targetId: entry.id, replacement: { content } }],
		});
	}
	return plans;
}
