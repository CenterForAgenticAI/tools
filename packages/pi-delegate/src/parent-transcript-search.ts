import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Worker-granted tool name for searching the dispatching session's transcript. */
export const PARENT_TRANSCRIPT_SEARCH_TOOL_NAME = "search_parent_transcript";

/** Conservative caps shared by the pure search result and its worker tool. */
// Follow-up: add transcript redaction policy; v1 relies on the default-off grant.
export const DEFAULT_PARENT_TRANSCRIPT_SEARCH_CAPS = {
	maxExcerptBytes: 4096,
	maxTotalBytes: 16384,
	maxMatches: 32,
} as const;

export interface ParentTranscriptSearchOptions {
	maxExcerptBytes?: number;
	maxTotalBytes?: number;
	maxMatches?: number;
}

export interface ParentTranscriptSearchResult {
	query: string;
	excerpts: string[];
	/** Number of matching lines before result caps were applied. */
	matchCount: number;
	bytes: number;
	truncated: boolean;
	text: string;
}

/**
 * Runtime-only association between a worker SessionManager and its trusted
 * parent snapshot. The worker tool never receives a path or session id from
 * its arguments; the coordinator installs this association before prompting.
 */
const parentSnapshots = new WeakMap<object, readonly SessionEntry[]>();

export function registerParentTranscriptSnapshot(
	sessionManager: object,
	entries: readonly SessionEntry[],
): void {
	parentSnapshots.set(sessionManager, entries);
}

export function getParentTranscriptSnapshot(sessionManager: object): readonly SessionEntry[] | undefined {
	return parentSnapshots.get(sessionManager);
}

function boundedNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const source = Buffer.from(text, "utf8");
	if (source.byteLength <= maxBytes) return text;
	let result = source.subarray(0, maxBytes).toString("utf8");
	// A byte cut through a multibyte code point decodes as U+FFFD, whose
	// replacement bytes can exceed the requested cap. Remove that partial tail.
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function contentText(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "toolCall" && typeof block.name === "string") {
			const args = block.arguments === undefined ? "" : ` ${JSON.stringify(block.arguments)}`;
			parts.push(`Tool ${block.name}${args}`);
		}
	}
	return parts;
}

function entryLines(entry: SessionEntry): { role: string; line: string }[] {
	if (entry.type === "message") {
		const role = typeof entry.message.role === "string" ? entry.message.role : "message";
		const content = "content" in entry.message ? entry.message.content : undefined;
		return contentText(content).flatMap((text) =>
			text.split("\n").map((line) => ({ role, line })),
		);
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return entry.summary.split("\n").map((line) => ({ role: entry.type, line }));
	}
	if (entry.type === "custom_message") {
		return contentText(entry.content).flatMap((text) =>
			text.split("\n").map((line) => ({ role: entry.customType, line })),
		);
	}
	return [];
}

/**
 * Search only the supplied in-memory parent snapshot. This function performs
 * no filesystem or session lookup. A request object is accepted for ergonomic
 * tool-boundary tests, but only its `query` member is read; path/session fields
 * cannot influence the searched data.
 */
export function searchParentTranscript(
	entries: readonly SessionEntry[],
	queryInput: string | { query: string },
	options: ParentTranscriptSearchOptions = {},
): ParentTranscriptSearchResult {
	const query = typeof queryInput === "string" ? queryInput : queryInput.query;
	const normalizedQuery = query.toLocaleLowerCase();
	const maxExcerptBytes = boundedNumber(options.maxExcerptBytes, DEFAULT_PARENT_TRANSCRIPT_SEARCH_CAPS.maxExcerptBytes);
	const maxTotalBytes = boundedNumber(options.maxTotalBytes, DEFAULT_PARENT_TRANSCRIPT_SEARCH_CAPS.maxTotalBytes);
	const maxMatches = boundedNumber(options.maxMatches, DEFAULT_PARENT_TRANSCRIPT_SEARCH_CAPS.maxMatches);
	const matches: Array<{ index: number; role: string; line: string }> = [];

	for (let index = 0; index < entries.length; index++) {
		for (const { role, line } of entryLines(entries[index]!)) {
			if (line.toLocaleLowerCase().includes(normalizedQuery)) matches.push({ index, role, line });
		}
	}

	const excerpts: string[] = [];
	let text = "";
	let truncated = matches.length > maxMatches;
	for (const match of matches.slice(0, maxMatches)) {
		const raw = `[${match.index} ${match.role}] ${match.line}`;
		const excerpt = truncateUtf8(raw, maxExcerptBytes);
		const separator = text.length === 0 ? "" : "\n";
		const available = maxTotalBytes - Buffer.byteLength(text + separator, "utf8");
		if (available <= 0) {
			truncated = true;
			break;
		}
		const bounded = truncateUtf8(excerpt, available);
		if (Buffer.byteLength(bounded, "utf8") < Buffer.byteLength(excerpt, "utf8")) truncated = true;
		text += separator + bounded;
		excerpts.push(bounded);
		if (Buffer.byteLength(bounded, "utf8") < Buffer.byteLength(raw, "utf8")) truncated = true;
	}

	return {
		query,
		excerpts,
		matchCount: matches.length,
		bytes: Buffer.byteLength(text, "utf8"),
		truncated,
		text,
	};
}
