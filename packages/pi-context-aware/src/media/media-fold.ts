import type { ContextEditEntryDraft } from "@earendil-works/pi-coding-agent";
import { formatApproxBytes } from "./image-stripping.js";

/**
 * Media policy for the native fold path (issue #163).
 *
 * billion-context-pi never folds a message that carries an image, because the
 * bytes could not be recovered after the fold. An image-heavy session then has
 * a floor that only grows. Pi folds with `context_edit` entries, which change
 * what the model sees and leave the original entry in the session file, so the
 * bytes stay recoverable. That makes old media safe to fold:
 *
 * - `planMediaElision` replaces the images of all but the newest `keepRecent`
 *   image-bearing entries with a text placeholder that names the media type,
 *   the size, and the session entry that still holds the original.
 * - `describeFoldedMedia` lists the media in a range that a fold summary
 *   replaces, so the summary can say what the range held.
 *
 * Both functions are pure. The fold engine (issue #130) calls
 * them; nothing here writes to a session.
 */

/** The parts of Pi's `ProjectedSessionEntry` this module reads. */
export interface ProjectedEntryView {
	readonly sourceEntry: {
		readonly id: string;
		readonly type: string;
		/** Set on `message` entries: the original message, before any context edit. */
		readonly message?: unknown;
		/** Set on `custom_message` entries: the original content, before any context edit. */
		readonly content?: unknown;
	};
	/** What the model sees for this entry, after context edits. */
	readonly messages: readonly unknown[];
}

export interface MediaRef {
	readonly entryId: string;
	readonly mimeType: string;
	readonly approxBytes: number;
}

export interface MediaElisionPlan {
	/** One draft per entry whose images leave the context, oldest first. */
	readonly drafts: readonly ContextEditEntryDraft[];
	readonly removed: readonly MediaRef[];
}

export interface MediaElisionOptions {
	/** How many of the newest image-bearing entries keep their images. */
	readonly keepRecent: number;
}

/** At most this many images are named in a fold notice. */
export const FOLDED_MEDIA_LIST_LIMIT = 8;

interface ImageBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageBlock(part: unknown): part is ImageBlock {
	return isRecord(part) && part.type === "image" && typeof part.data === "string";
}

/** A text part. Once its images are elided, an entry may hold nothing else. */
interface TextPart {
	readonly type: "text";
	readonly text: string;
}

function isTextPart(part: unknown): part is TextPart {
	return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function mediaRef(entryId: string, image: ImageBlock): MediaRef {
	const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
	return {
		entryId,
		mimeType: typeof image.mimeType === "string" && image.mimeType.length > 0 ? image.mimeType : "image",
		approxBytes: Math.max(0, Math.floor((image.data.length * 3) / 4) - padding),
	};
}

function placeholderText(ref: MediaRef): string {
	return `[${ref.mimeType}, ~${formatApproxBytes(ref.approxBytes)} image omitted from context; the original is in session entry ${ref.entryId}]`;
}

/** Only these entries project one editable message that can carry an image. */
function isEditableMediaEntry(entry: ProjectedEntryView): boolean {
	return entry.sourceEntry.type === "message" || entry.sourceEntry.type === "custom_message";
}

function projectedContent(entry: ProjectedEntryView): readonly unknown[] | null {
	if (!isEditableMediaEntry(entry) || entry.messages.length !== 1) return null;
	const message = entry.messages[0];
	return isRecord(message) && Array.isArray(message.content) ? message.content : null;
}

/**
 * Context edits that move every image older than the newest `keepRecent`
 * image-bearing entries out of the model context. The plan reads the projected
 * content, so an image an earlier edit already removed is not planned again.
 */
export function planMediaElision(entries: readonly ProjectedEntryView[], options: MediaElisionOptions): MediaElisionPlan {
	const candidates = entries.flatMap((entry) => {
		const content = projectedContent(entry);
		return content && content.some(isImageBlock) ? [{ id: entry.sourceEntry.id, content }] : [];
	});
	const keepRecent = Number.isFinite(options.keepRecent) ? Math.max(0, Math.floor(options.keepRecent)) : 0;
	const elided = candidates.slice(0, Math.max(0, candidates.length - keepRecent));
	const drafts: ContextEditEntryDraft[] = [];
	const removed: MediaRef[] = [];
	for (const candidate of elided) {
		const refs: MediaRef[] = [];
		const content = candidate.content.map((part) => {
			if (!isImageBlock(part)) return part;
			const ref = mediaRef(candidate.id, part);
			refs.push(ref);
			return { type: "text", text: placeholderText(ref) };
		});
		// Pi's image-bearing messages (user, tool result, custom) hold only text
		// and images, so an elided entry holds only text. Any other part is a
		// shape this plan does not know; that entry keeps its images.
		if (!content.every(isTextPart)) continue;
		removed.push(...refs);
		drafts.push({
			type: "context_edit",
			targetId: candidate.id,
			replacement: { content },
		});
	}
	return { drafts, removed };
}

/** The original content of an entry, before any context edit. */
function originalContent(entry: ProjectedEntryView): readonly unknown[] {
	const source = entry.sourceEntry;
	if (source.type === "message" && isRecord(source.message) && Array.isArray(source.message.content)) return source.message.content;
	if (source.type === "custom_message" && Array.isArray(source.content)) return source.content;
	return entry.messages.flatMap((message) => (isRecord(message) && Array.isArray(message.content) ? message.content : []));
}

/**
 * One bounded line for a fold summary that names the media its range held,
 * including images an earlier elision already removed. Null when the range
 * held no media.
 */
export function describeFoldedMedia(entries: readonly ProjectedEntryView[]): string | null {
	const refs = entries.flatMap((entry) => originalContent(entry).filter(isImageBlock).map((image) => mediaRef(entry.sourceEntry.id, image)));
	if (refs.length === 0) return null;
	const listed = refs.slice(0, FOLDED_MEDIA_LIST_LIMIT).map((ref) => `${ref.mimeType} ~${formatApproxBytes(ref.approxBytes)} (entry ${ref.entryId})`);
	const rest = refs.length - listed.length;
	const noun = refs.length === 1 ? "image" : "images";
	return `Media in this folded range: ${refs.length} ${noun}. The originals stay in the session file. ${listed.join("; ")}${rest > 0 ? `; and ${rest} more.` : "."}`;
}
