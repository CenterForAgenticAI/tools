/**
 * The text `context_recall` searches in one session, read from its entries.
 *
 * Pi's session listing indexes user and assistant text only. Term and literal
 * queries also search, within character budgets:
 *
 * - tool calls (tool name and JSON arguments) and tool results;
 * - fold summaries: native folds' replacement text, and the summaries in a
 *   legacy billion-context-pi side file (`<session>.jsonl.acp.json`);
 * - compaction and branch summaries.
 *
 * Thinking and custom entries are not searched.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Characters kept from one tool call's name and arguments. */
export const TOOL_CALL_CHARACTERS = 1_000;
/** Characters kept from one tool result. */
export const TOOL_RESULT_CHARACTERS = 4_000;
/** Characters searched in one session; text past this is not searched. */
export const SESSION_SEARCH_CHARACTERS = 8_000_000;
/** A session file larger than this is searched through Pi's user and assistant text only. */
const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
/** A legacy fold side file larger than this is not searched. */
export const MAX_SIDE_FILE_BYTES = 1 * 1024 * 1024;

/** Shared accounting for files read while one recall call searches wider transcript sources. */
export interface TranscriptFileReadBudget {
	readonly byteLimit: number;
	bytesRead: number;
	filesRead: number;
	/** Files left unsearched: over their per-file size limit, missing (a session file), unreadable, or malformed (a side file). */
	filesSkipped: number;
	/** Session-file lines that hold a query word but are not valid JSON, so their text was not searched. */
	linesSkipped: number;
	/** Sessions whose text ran past SESSION_SEARCH_CHARACTERS; the rest of their text was not searched. */
	sessionsTruncated: number;
	exhausted: boolean;
}

export function createTranscriptFileReadBudget(byteLimit: number): TranscriptFileReadBudget {
	return { byteLimit, bytesRead: 0, filesRead: 0, filesSkipped: 0, linesSkipped: 0, sessionsTruncated: 0, exhausted: false };
}

/** `optional`: a missing file is normal (side files) and is not counted as skipped. */
function readBoundedFile(filePath: string, fileLimit: number, budget?: TranscriptFileReadBudget, optional = false): string | undefined {
	let descriptor: number | undefined;
	try {
		const size = statSync(filePath).size;
		if (size > fileLimit) {
			if (budget) budget.filesSkipped++;
			return undefined;
		}
		if (budget && size > budget.byteLimit - budget.bytesRead) {
			budget.exhausted = true;
			return undefined;
		}
		descriptor = openSync(filePath, "r");
		if (budget) {
			// Reserve the stat snapshot before reading, so a short read only makes the accounting conservative.
			budget.bytesRead += size;
			budget.filesRead++;
		}
		const buffer = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			const read = readSync(descriptor, buffer, offset, size - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return buffer.subarray(0, offset).toString("utf8");
	} catch (error) {
		// Most sessions have no side file; any other failure leaves text unsearched.
		const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
		if (budget && !(optional && missing)) budget.filesSkipped++;
		return undefined;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Recall falls back to indexed chat text when wider-source I/O fails.
			}
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

class TextBudget {
	private readonly parts: string[] = [];
	private used = 0;
	/** True once some text was cut or left out because the session limit was reached. */
	truncated = false;

	constructor(private readonly limit: number) {}

	get full(): boolean {
		return this.used >= this.limit;
	}

	add(value: unknown, cap = Number.POSITIVE_INFINITY): void {
		if (typeof value !== "string") return;
		const text = value.trim();
		if (!text) return;
		const left = this.limit - this.used;
		if (Math.min(cap, text.length) > left) this.truncated = true;
		const room = Math.min(cap, left);
		if (room <= 0) return;
		const piece = text.length > room ? text.slice(0, room) : text;
		this.parts.push(piece);
		this.used += piece.length + 1;
	}

	text(): string {
		return this.parts.join("\n");
	}
}

function addTextParts(content: unknown, budget: TextBudget, cap?: number): void {
	if (typeof content === "string") {
		budget.add(content, cap);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (isRecord(part) && part.type === "text") budget.add(part.text, cap);
	}
}

function toolCallText(part: Record<string, unknown>): string | undefined {
	if (typeof part.name !== "string") return undefined;
	let args: string;
	try {
		args = JSON.stringify(part.arguments ?? {}) ?? "";
	} catch {
		args = "";
	}
	return `${part.name} ${args}`;
}

function addEntry(entry: unknown, budget: TextBudget): void {
	if (!isRecord(entry)) return;
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (!isRecord(message)) return;
			if (message.role === "user" || message.role === "assistant") {
				if (!Array.isArray(message.content)) {
					addTextParts(message.content, budget);
					return;
				}
				for (const part of message.content) {
					if (!isRecord(part)) continue;
					if (part.type === "text") budget.add(part.text);
					else if (part.type === "toolCall") budget.add(toolCallText(part), TOOL_CALL_CHARACTERS);
				}
			} else if (message.role === "toolResult") {
				addTextParts(message.content, budget, TOOL_RESULT_CHARACTERS);
			} else if (message.role === "bashExecution" && message.excludeFromContext !== true) {
				// A `!!` command is recorded but never sent to the model; keep it out of recall too.
				budget.add(message.command, TOOL_CALL_CHARACTERS);
				budget.add(message.output, TOOL_RESULT_CHARACTERS);
			}
			return;
		}
		case "compaction":
		case "branch_summary":
			budget.add(entry.summary);
			return;
		case "context_edit": {
			// A native fold's carrier replacement holds the fold summary.
			const replacement = entry.replacement;
			if (isRecord(replacement)) addTextParts(replacement.content, budget);
			return;
		}
		default:
			return;
	}
}

function readSideFile(sessionPath: string, readBudget?: TranscriptFileReadBudget): string | undefined {
	return readBoundedFile(`${sessionPath}.acp.json`, MAX_SIDE_FILE_BYTES, readBudget, true);
}

function addSideFileSummaries(sessionPath: string, budget: TextBudget, raw = readSideFile(sessionPath), readBudget?: TranscriptFileReadBudget): void {
	if (raw === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		if (readBudget) readBudget.filesSkipped++;
		return;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) {
		if (readBudget) readBudget.filesSkipped++;
		return;
	}
	for (const block of parsed.blocks) {
		if (!isRecord(block)) continue;
		budget.add(block.topic);
		budget.add(block.summary);
	}
}

/** Search text for in-memory session entries, plus the session's side-file summaries when it has a file. */
export function entriesSearchText(entries: Iterable<unknown>, sessionPath?: string, readBudget?: TranscriptFileReadBudget): string {
	const budget = new TextBudget(SESSION_SEARCH_CHARACTERS);
	if (sessionPath) addSideFileSummaries(sessionPath, budget, readSideFile(sessionPath, readBudget), readBudget);
	for (const entry of entries) {
		if (budget.full) {
			budget.truncated = true;
			break;
		}
		addEntry(entry, budget);
	}
	if (budget.truncated && readBudget) readBudget.sessionsTruncated++;
	return budget.text();
}

/** Words a session file must contain before it is parsed. */
export interface RawPrefilter {
	readonly needles: readonly string[];
	readonly caseSensitive: boolean;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A needle JSON writes unchanged: printable ASCII without a quote or backslash. */
function survivesJson(needle: string): boolean {
	return /^[\x20-\x7e]+$/u.test(needle) && !/["\\]/u.test(needle);
}

/**
 * Checks on raw JSONL text. The raw file holds every searched string, JSON
 * escaped, so a needle JSON writes unchanged and that is absent from the raw
 * text cannot match. `all` holds one pattern per such needle; `any` matches a
 * line holding any needle, and is undefined when some needle could be escaped,
 * because then a line cannot be ruled out.
 */
function needleChecks(prefilter: RawPrefilter): { all: RegExp[]; any?: RegExp } {
	const flags = prefilter.caseSensitive ? "u" : "iu";
	const safe = prefilter.needles.filter(survivesJson);
	const all = safe.map((needle) => new RegExp(escapeRegExp(needle), flags));
	const any = safe.length === prefilter.needles.length && safe.length > 0
		? new RegExp(safe.map(escapeRegExp).join("|"), flags)
		: undefined;
	return { all, any };
}

/**
 * Search text for a session file, or undefined when the file cannot be read or,
 * with a prefilter, cannot hold every needle.
 */
export function sessionFileSearchText(sessionPath: string, prefilter?: RawPrefilter, readBudget?: TranscriptFileReadBudget): string | undefined {
	const raw = readBoundedFile(sessionPath, MAX_SESSION_FILE_BYTES, readBudget);
	if (raw === undefined) return undefined;
	const side = readSideFile(sessionPath, readBudget);
	const checks = prefilter ? needleChecks(prefilter) : undefined;
	if (checks && !checks.all.every((pattern) => pattern.test(raw) || (side !== undefined && pattern.test(side)))) return undefined;
	const budget = new TextBudget(SESSION_SEARCH_CHARACTERS);
	addSideFileSummaries(sessionPath, budget, side, readBudget);
	let start = 0;
	while (start < raw.length && !budget.full) {
		let end = raw.indexOf("\n", start);
		if (end === -1) end = raw.length;
		const line = raw.slice(start, end);
		start = end + 1;
		if (!line.trim()) continue;
		// A line holding none of the words adds nothing a match could use, so it is not parsed.
		if (checks?.any && !checks.any.test(line)) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			if (readBudget) readBudget.linesSkipped++;
			continue;
		}
		addEntry(entry, budget);
	}
	// Lines left when the loop stopped were never read.
	if (budget.full && start < raw.length) budget.truncated = true;
	if (budget.truncated && readBudget) readBudget.sessionsTruncated++;
	return budget.text();
}
