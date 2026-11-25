/**
 * What the mechanical recipes (`mask-then-fold`, `trim-then-fold`; pi-context-aware#471) share: which tool
 * results a stub may take, the stub's text, and the bench's index of what each recorded tool result held.
 *
 * A stub's text reaches the model's context in place of a tool result. Tool output and tool names come
 * from whatever the tool read, so every value that goes into a stub is one line with control and format
 * characters removed, capped with a visible marker, and placed after its label. The runtime appends the
 * `context_recall` pointer (`hidePointerLine` in src/folds/hide-entries.ts); a stub's text never carries one.
 */

import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ContextView, ViewEntry } from "../../../strategy/contract.js";
import { contentText } from "../recording.js";

/** The published masking control keeps the last 10 observations (The Complexity Trap, arXiv 2508.21433). */
export const KEEP_RECENT_RESULTS = 10;
/**
 * A tool result is stubbed only above this many tokens. The largest stub, a trimmed result with its preview
 * and the runtime's pointer line, is about 75 tokens; below twice that a stub saves little or grows the entry.
 */
export const MIN_STUB_TOKENS = 150;
/** Characters of tool output a trimmed result keeps as its preview. */
export const PREVIEW_CHARS = 120;
/** Characters of a tool name or call id in a stub. */
export const NAME_CHARS = 64;
/** The marker a capped value ends with. */
export const CUT_MARKER = "…[cut]";
/** The tool `context_recall` follows a pointer with; without it a stub cannot be recovered. */
export const RECALL_TOOL = "context_recall";

/** What one recorded tool result held. */
export interface ToolOutput {
	/** SHA-256 of the result's content parts: two results with the same digest showed the model the same thing. */
	readonly digest: string;
	/** The text of its text parts. */
	readonly text: string;
}

/** The recorded tool result an entry id names; `undefined` for any other entry. */
export type ToolOutputIndex = (entryId: string) => ToolOutput | undefined;

/** An index over a recorded branch, each result read on first use. */
export function toolOutputIndex(path: readonly SessionEntry[]): ToolOutputIndex {
	const results = new Map<string, SessionEntry>();
	for (const entry of path) if (entry.type === "message" && entry.message.role === "toolResult") results.set(entry.id, entry);
	const read = new Map<string, ToolOutput>();
	return (entryId) => {
		const known = read.get(entryId);
		if (known !== undefined) return known;
		const entry = results.get(entryId);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") return undefined;
		const content: unknown = entry.message.content;
		const output = { digest: createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex"), text: contentText(content) };
		read.set(entryId, output);
		return output;
	};
}

// Control characters (C0, DEL, C1), format characters (bidirectional overrides, zero-width marks) and the line and paragraph separators.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** One printable line of at most `max` characters: unprintable characters and runs of whitespace become one space; a longer value ends with `CUT_MARKER`. */
export function oneLineValue(text: string, max: number): string {
	const flat = text.slice(0, max * 4 + 64).replace(UNPRINTABLE, " ").replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - CUT_MARKER.length).trimEnd()}${CUT_MARKER}`;
}

/** A tool name or call id as a stub shows it: letters, digits and `. _ : @ / -` only, each other character `?`. */
export function nameValue(name: string | undefined): string {
	return oneLineValue((name ?? "tool").replace(/[^A-Za-z0-9._:@/-]/gu, "?"), NAME_CHARS) || "tool";
}

/**
 * The first `PREVIEW_CHARS` characters of tool output, as one line. The preview is quoted after its label,
 * so a double quote or a closing bracket in it becomes a single quote or a parenthesis, and it never names
 * `context_recall`: only the runtime writes a recall pointer.
 */
export function outputPreview(text: string): string {
	return oneLineValue(text.slice(0, PREVIEW_CHARS * 4 + 64).replace(/"/gu, "'").replace(/\]/gu, ")").replace(/context_recall/giu, "context-recall"), PREVIEW_CHARS);
}

/**
 * Tool results a stub may take, in request order. A result is left alone when a rule or a fold hint keeps
 * it: in the protected zone; a `verbatim` or `one-line` hint (the extension that registered the hint chose
 * how the result shows; `drop-after-read` lets it go); already a fold's carrier or a hide's target; or too
 * small for a stub to save anything.
 */
export function stubbable(view: ContextView, options: { readonly zone: boolean } = { zone: true }): ViewEntry[] {
	// `zone: false` skips the protected zone, which only a full view build gives: a cheap first look at whether anything could be stubbed.
	const kept = new Set(options.zone ? view.protectedEntryIds : []);
	for (const hide of view.hides) kept.add(hide.targetId);
	for (const fold of view.folds) kept.add(fold.carrierId);
	return view.entries.filter((entry) => entry.role === "toolResult" && !kept.has(entry.id) && (entry.hint === null || entry.hint === "drop-after-read") && entry.tokens > MIN_STUB_TOKENS);
}

/** Tool results older than the last `keep` tool results of the request. */
export function olderThanRecent(view: ContextView, keep: number): Set<string> {
	const results = view.entries.filter((entry) => entry.role === "toolResult");
	return new Set(results.slice(0, Math.max(0, results.length - keep)).map((entry) => entry.id));
}