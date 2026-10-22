/**
 * The session brief: a short, agent-written note of where the session stands.
 *
 * It is replaced, never appended, and shown to the model in the per-turn
 * message so a resumed or compacted session starts from it. The session entry
 * is the source of truth; the latest `context-aware.brief.v1` entry on the
 * current branch wins, and an entry without text means the brief was cleared.
 */

import { redactText } from "./workstream-safety.js";

export const BRIEF_ENTRY_TYPE = "context-aware.brief.v1";
export const BRIEF_SCHEMA_VERSION = 1;
/** Longer text is refused with a reason, never truncated. */
export const MAX_BRIEF_CHARS = 1_200;

export interface SessionBriefEntry {
	readonly schemaVersion: typeof BRIEF_SCHEMA_VERSION;
	/** Absent when the brief was cleared. */
	readonly text?: string;
	readonly updatedAt: string;
}

export interface SessionBrief {
	readonly text: string;
	readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly parse one entry's data, or null when it is not a brief entry. */
export function parseBriefEntry(value: unknown): SessionBriefEntry | null {
	if (!isRecord(value) || value.schemaVersion !== BRIEF_SCHEMA_VERSION) return null;
	if (typeof value.updatedAt !== "string" || value.updatedAt.length > 64 || !Number.isFinite(Date.parse(value.updatedAt))) return null;
	if (value.text === undefined) return { schemaVersion: BRIEF_SCHEMA_VERSION, updatedAt: value.updatedAt };
	if (typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > MAX_BRIEF_CHARS) return null;
	return { schemaVersion: BRIEF_SCHEMA_VERSION, text: value.text, updatedAt: value.updatedAt };
}

/** The current brief on a branch: the latest valid entry wins; a cleared entry yields null. */
export function replayBrief(entries: readonly unknown[]): SessionBrief | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== BRIEF_ENTRY_TYPE) continue;
		const parsed = parseBriefEntry(entry.data);
		if (parsed === null) continue;
		return parsed.text === undefined ? null : { text: parsed.text, updatedAt: parsed.updatedAt };
	}
	return null;
}

export type BriefCommand = { readonly text: string } | { readonly clear: true };

export type BriefChange =
	| { readonly accepted: true; readonly changed: boolean; readonly entry: SessionBriefEntry | null; readonly brief: SessionBrief | null; readonly redacted: boolean }
	| { readonly accepted: false; readonly reason: string; readonly brief: SessionBrief | null };

/**
 * Decide the entry to append for a brief change. Only the named fields are
 * copied into the entry, and the text is redacted before it is stored.
 */
export function changeBrief(current: SessionBrief | null, command: BriefCommand, now: Date): BriefChange {
	const updatedAt = now.toISOString();
	if ("clear" in command) {
		if (current === null) return { accepted: true, changed: false, entry: null, brief: null, redacted: false };
		return { accepted: true, changed: true, entry: { schemaVersion: BRIEF_SCHEMA_VERSION, updatedAt }, brief: null, redacted: false };
	}
	if (typeof command.text !== "string" || command.text.trim().length === 0) {
		return { accepted: false, reason: "brief must be non-empty text; use clear: true to remove it", brief: current };
	}
	if (command.text.length > MAX_BRIEF_CHARS) {
		return { accepted: false, reason: `brief is ${command.text.length} characters; the limit is ${MAX_BRIEF_CHARS}. Shorten it; it is never truncated.`, brief: current };
	}
	// The cap above bounds the input, so redaction never needs to cut it.
	const text = redactText(command.text, { maxLength: MAX_BRIEF_CHARS }).trim();
	if (text.length === 0) return { accepted: false, reason: "brief is empty after redaction", brief: current };
	const redacted = text !== command.text.trim();
	if (current !== null && current.text === text) return { accepted: true, changed: false, entry: null, brief: current, redacted };
	const entry: SessionBriefEntry = { schemaVersion: BRIEF_SCHEMA_VERSION, text, updatedAt };
	return { accepted: true, changed: true, entry, brief: { text, updatedAt }, redacted };
}

function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The per-turn block, or null when there is no brief. */
export function buildBriefContextBlock(brief: SessionBrief | null): string | null {
	if (brief === null) return null;
	return [
		`<session-brief source="pi-extension:context-aware" user-input="false" response-expected="false" updated-at="${xmlEscape(brief.updatedAt)}">`,
		"Agent-written session brief kept with session_focus; extension state, not a new user request.",
		xmlEscape(brief.text),
		"</session-brief>",
	].join("\n");
}

/** One line for /focus and session_focus get. */
export function briefViewText(brief: SessionBrief | null): string {
	return brief === null ? "Brief: none." : `Brief (updated ${brief.updatedAt}):\n${brief.text}`;
}
