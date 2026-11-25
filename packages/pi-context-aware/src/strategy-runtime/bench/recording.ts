/**
 * One recorded session, read for the strategy bench (pi-context-aware#469). Reads the JSONL text of a
 * Pi session file and returns its active branch with what the bench replays: every request with its
 * recorded usage, the recorded folds and the entries that wrote them, recorded compactions, and the
 * `context_recall` calls the model made. It parses text only; it never opens or writes a file.
 */

import { migrateSessionEntries, parseSessionEntries, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { FOLD_ENTRY_TYPE, readFoldRecord, renderFoldSummary, type FoldRecord } from "../../folds/fold-entries.js";
import { HIDE_ENTRY_TYPE, readHideRecord } from "../../folds/hide-entries.js";

export interface RecordedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Of `cacheWrite`, the tokens written with the one-hour retention (Anthropic). */
	readonly cacheWrite1h: number;
}

/** One model request: an assistant message on the branch. */
export interface RecordedRequest {
	/** Index of the assistant message in `Recording.path`. */
	readonly pathIndex: number;
	/** Epoch milliseconds of the request. */
	readonly at: number;
	readonly provider: string;
	readonly model: string;
	readonly usage: RecordedUsage;
	/** Pi's own cost for the request (`usage.cost.total`); 0 when absent. */
	readonly piCost: number;
	/** A user message lies on the branch between the previous request and this one: a turn starts here. */
	readonly turnStart: boolean;
}

/** A request the bench cannot replay but counts the same in every strategy: off the branch, or a cache-warming call. */
export interface OtherRequest {
	readonly provider: string;
	readonly model: string;
	readonly usage: RecordedUsage;
	readonly piCost: number;
}

export interface RecordedFold {
	/** Index of the fold's metadata entry in `Recording.path`. */
	readonly pathIndex: number;
	readonly record: FoldRecord;
	/** The summary as the model wrote it: the carrier's text without the heading the fold adds. */
	readonly summary: string;
	/** Characters of the carrier's text as recorded, heading included. */
	readonly carrierChars: number;
	/** Path indexes of the fold's context edits and its metadata entry. */
	readonly entryIndexes: readonly number[];
	/** Ordinal of the first request the fold applies to (`requests.length` when none follows). */
	readonly request: number;
}

export interface RecordedCompaction {
	readonly pathIndex: number;
	readonly request: number;
	readonly summaryChars: number;
	readonly tokensBefore: number;
}

/** A `context_recall` call by reference, made in the response to request `request`. */
export interface RecordedRecall {
	readonly request: number;
	readonly ref: string;
}

export interface Recording {
	readonly sessionId: string;
	/** The active branch, root to leaf: the path to the last entry of the file. */
	readonly path: readonly SessionEntry[];
	readonly requests: readonly RecordedRequest[];
	readonly other: readonly OtherRequest[];
	readonly folds: readonly RecordedFold[];
	readonly compactions: readonly RecordedCompaction[];
	readonly recalls: readonly RecordedRecall[];
	/** Recorded hides on the branch: hide id to the entry it shortened. */
	readonly hides: ReadonlyMap<string, string>;
	/**
	 * Tool results on the branch that report a fold billion-context-pi made. It folds in Pi's `context` hook
	 * and keeps its blocks in a side file (`<session>.jsonl.acp.json`), so the folded entries stay on the
	 * branch while later requests no longer carried them (pi-context-aware#469, CR-BENCH-UNSENT-CONTEXT-SAVINGS).
	 */
	readonly foreignFolds: number;
	/** The branch holds a user message or a tool result. A file with requests and neither is a usage log (a Fabric worker's), not a transcript. */
	readonly transcript: boolean;
}

export interface ReadRecordingOptions {
	/** Epoch milliseconds: entries stamped later are left out, so a session still being written reads the same. */
	readonly until?: number;
}

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Fields : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

function usageOf(value: unknown): RecordedUsage {
	const usage = fieldsOf(value);
	return { input: count(usage?.input), output: count(usage?.output), cacheRead: count(usage?.cacheRead), cacheWrite: count(usage?.cacheWrite), cacheWrite1h: count(usage?.cacheWrite1h) };
}

const costOf = (value: unknown): number => count(fieldsOf(fieldsOf(value)?.cost)?.total);

/** Text of a message or replacement content: a string, or the text of its text parts. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => {
		const fields = fieldsOf(part);
		return fields?.type === "text" && typeof fields.text === "string" ? [fields.text] : [];
	}).join("\n");
}

function timeOf(entry: { readonly timestamp?: unknown }): number {
	const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	return Number.isFinite(at) ? at : 0;
}

/** `context_recall({ ref: "b3" })` inside a Fabric program's code. */
const PROGRAM_RECALL = /context_recall\s*\(\s*\{[^}]*?\bref\s*:\s*["'`]([bh]\d{1,9})["'`]/gu;

/** billion-context-pi's status line after a fold, such as `▣ ACP | 59.7K → 7.1K tokens (~52.6K reclaimed, blocks: b1=m00001–m00129)`. */
const FOREIGN_FOLD = /▣ ACP \| [\d.]+K? → [\d.]+K? tokens \(~(\d+(?:\.\d+)?)K? reclaimed/u;

/** The tool result reports tokens billion-context-pi reclaimed by folding. */
export function reportsForeignFold(text: string): boolean {
	const match = FOREIGN_FOLD.exec(text);
	return match !== null && Number(match[1]) > 0;
}

function recallRefs(part: Fields): string[] {
	const args = fieldsOf(part.arguments);
	if (part.name === "context_recall") {
		const ref = stringOf(args?.ref);
		return ref.length > 0 && ref.length <= 32 ? [ref] : [];
	}
	const code = stringOf(args?.code);
	return code.includes("context_recall") ? [...code.matchAll(PROGRAM_RECALL)].map((match) => match[1]!) : [];
}

/** The model's summary from a carrier's text: the text after the heading `renderFoldSummary` writes. */
function summaryOf(carrierText: string, topic: string | undefined): string {
	const heading = renderFoldSummary("", topic);
	return carrierText.startsWith(`${heading}\n`) ? carrierText.slice(heading.length + 1) : carrierText;
}

/**
 * A message recorded without content (a request that failed before the provider answered) shows the
 * model nothing: it is read with empty content. The fold engine's hint pass reads every assistant
 * message's content as an array and throws on one without (`dropOversizedPairs` in src/folds/fold-adapter.ts).
 */
function withContent(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message") return entry;
	const content = (entry.message as unknown as Fields).content;
	if (typeof content === "string" || Array.isArray(content)) return entry;
	return { ...entry, message: { ...entry.message, content: [] } } as SessionEntry;
}

/**
 * Read one session file's text. Returns `undefined` when it holds no session entries. The file is parsed
 * as Pi parses it (`parseSessionEntries`, then `migrateSessionEntries` on the parsed copy).
 */
export function readRecording(text: string, options: ReadRecordingOptions = {}): Recording | undefined {
	const until = options.until;
	const parsed: FileEntry[] = parseSessionEntries(text);
	migrateSessionEntries(parsed);
	let sessionId = "";
	const entries: SessionEntry[] = [];
	for (const entry of parsed) {
		if (entry.type === "session") {
			sessionId = stringOf((entry as { id?: unknown }).id);
			continue;
		}
		if (typeof entry.id !== "string") continue;
		if (until !== undefined && timeOf(entry) > until) continue;
		entries.push(withContent(entry));
	}
	if (entries.length === 0) return undefined;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	for (let entry: SessionEntry | undefined = entries[entries.length - 1]; entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		seen.add(entry.id);
		path.push(entry);
	}
	path.reverse();

	const requests: RecordedRequest[] = [];
	const requestAt = new Map<number, number>();
	let userSince = true;
	path.forEach((entry, index) => {
		if (entry.type !== "message") return;
		const message = entry.message as unknown as Fields;
		if (message.role === "user") userSince = true;
		if (message.role !== "assistant") return;
		requestAt.set(index, requests.length);
		requests.push({
			pathIndex: index,
			at: typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : timeOf(entry),
			provider: stringOf(message.provider),
			model: stringOf(message.model),
			usage: usageOf(message.usage),
			piCost: costOf(message.usage),
			turnStart: userSince,
		});
		userSince = false;
	});
	/** Ordinal of the first request at or after a path index. */
	const nextRequest = (index: number): number => {
		const found = requests.findIndex((request) => request.pathIndex > index);
		return found < 0 ? requests.length : found;
	};

	const other: OtherRequest[] = [];
	for (const entry of entries) {
		if (entry.type === "usage") {
			const usage = entry as unknown as Fields;
			other.push({ provider: stringOf(usage.provider), model: stringOf(usage.model), usage: usageOf(usage.usage), piCost: costOf(usage.usage) });
		} else if (entry.type === "message" && !seen.has(entry.id)) {
			const message = entry.message as unknown as Fields;
			if (message.role === "assistant") other.push({ provider: stringOf(message.provider), model: stringOf(message.model), usage: usageOf(message.usage), piCost: costOf(message.usage) });
		}
	}

	const folds: RecordedFold[] = [];
	const compactions: RecordedCompaction[] = [];
	const recalls: RecordedRecall[] = [];
	const hides = new Map<string, string>();
	let foreignFolds = 0;
	let transcript = false;
	path.forEach((entry, index) => {
		if (entry.type === "message") {
			const message = entry.message as unknown as Fields;
			if (message.role === "user" || message.role === "toolResult") transcript = true;
			if (message.role === "toolResult" && reportsForeignFold(contentText(message.content))) foreignFolds++;
		}
		if (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE) {
			const record = readFoldRecord(entry.data);
			if (!record) return;
			const covered = new Set([record.carrierId, ...record.hiddenIds]);
			const entryIndexes = [index];
			let carrierText: string | undefined;
			for (let i = index - 1; i >= 0; i--) {
				const edit = path[i]!;
				if (edit.type !== "context_edit" || !covered.has(edit.targetId)) break;
				entryIndexes.unshift(i);
				if (edit.targetId === record.carrierId && edit.replacement !== null) carrierText = contentText(edit.replacement.content);
			}
			const text = carrierText ?? "";
			folds.push({ pathIndex: index, record, summary: summaryOf(text, record.topic), carrierChars: text.length, entryIndexes, request: nextRequest(index) });
		} else if (entry.type === "custom" && entry.customType === HIDE_ENTRY_TYPE) {
			const record = readHideRecord(entry.data);
			if (record) hides.set(record.hideId, record.targetId);
		} else if (entry.type === "compaction") {
			compactions.push({ pathIndex: index, request: nextRequest(index), summaryChars: stringOf(entry.summary).length, tokensBefore: count(entry.tokensBefore) });
		} else if (entry.type === "message" && (entry.message as unknown as Fields).role === "assistant") {
			const content = (entry.message as unknown as Fields).content;
			const ordinal = requestAt.get(index)!;
			for (const part of Array.isArray(content) ? content : []) {
				const fields = fieldsOf(part);
				if (fields?.type !== "toolCall") continue;
				for (const ref of recallRefs(fields)) recalls.push({ request: ordinal, ref });
			}
		}
	});
	return { sessionId, path, requests, other, folds, compactions, recalls, hides, foreignFolds, transcript };
}
