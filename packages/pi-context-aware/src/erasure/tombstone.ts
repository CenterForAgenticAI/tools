import { createHash } from "node:crypto";
import { FOLD_ENTRY_TYPE } from "../folds/fold-entries.js";

/**
 * Pure tombstone rules for one session entry. Text, tool-call arguments and tool output become a
 * dated marker. Ids, parent links, roles, types and tool-call ids are never read as content and
 * never rewritten: the tree and the call/result pairing stay valid with no relinking.
 */

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const MARKER_DATE = /\[erased \d{4}-\d{2}-\d{2}\]/gu;

export function erasedMarker(now: Date): string {
	return `[erased ${now.toISOString().slice(0, 10)}]`;
}

/** Every string a value holds, object keys included. Used only on content fields. */
function leaves(value: unknown, out: string[]): void {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) leaves(item, out);
	else if (isObject(value)) for (const [key, item] of Object.entries(value)) { out.push(key); leaves(item, out); }
}

const pushString = (out: string[], value: unknown): void => { if (typeof value === "string") out.push(value); };

function partStrings(part: JsonObject, out: string[]): void {
	if (part.type === "text") pushString(out, part.text);
	else if (part.type === "thinking") pushString(out, part.thinking);
	else if (part.type === "toolCall") { leaves(part.arguments, out); pushString(out, part.argumentsError); }
}

function contentStrings(content: unknown, out: string[]): void {
	if (typeof content === "string") out.push(content);
	else if (Array.isArray(content)) for (const part of content) if (isObject(part)) partStrings(part, out);
}

const MESSAGE_TEXT_FIELDS = ["summary", "command", "output", "errorMessage"] as const;

function nestedCalls(message: JsonObject): JsonObject[] {
	const nested = message.nestedCalls;
	return isObject(nested) && Array.isArray(nested.calls) ? nested.calls.filter(isObject) : [];
}

function messageStrings(message: unknown, out: string[]): void {
	if (!isObject(message)) return;
	contentStrings(message.content, out);
	for (const field of MESSAGE_TEXT_FIELDS) pushString(out, message[field]);
	leaves(message.details, out);
	for (const call of nestedCalls(message)) { leaves(call.arguments, out); pushString(out, call.error); }
}

/** The text an entry can lose: what `--match` searches. Never ids, parent links, roles or tool-call ids. */
export function erasableStrings(entry: JsonObject): string[] {
	const out: string[] = [];
	switch (entry.type) {
		case "message": messageStrings(entry.message, out); break;
		case "custom_message": contentStrings(entry.content, out); leaves(entry.details, out); break;
		case "compaction": case "branch_summary": pushString(out, entry.summary); break;
		case "context_edit": if (isObject(entry.replacement)) contentStrings(entry.replacement.content, out); break;
		case "custom": if (entry.customType === FOLD_ENTRY_TYPE && isObject(entry.data)) pushString(out, entry.data.topic); break;
		default: break;
	}
	return out;
}

function eraseContent(content: unknown, marker: string): unknown {
	if (typeof content === "string") return marker;
	if (!Array.isArray(content)) return content;
	return content.map((part: unknown): unknown => {
		if (!isObject(part)) return part;
		switch (part.type) {
			case "text": return { ...part, text: marker };
			// The signature is opaque reasoning that can encode the thinking text.
			case "thinking": return { type: "thinking", thinking: marker };
			case "toolCall": {
				const { argumentsError: _error, thoughtSignature: _signature, ...kept } = part;
				return { ...kept, arguments: { erased: marker } };
			}
			case "image": return { type: "text", text: marker };
			default: return part;
		}
	});
}

function eraseCall(call: unknown): unknown {
	if (!isObject(call)) return call;
	const { arguments: _arguments, argumentsBytes: _bytes, error: _error, ...kept } = call;
	return kept;
}

function eraseNested(nested: unknown): unknown {
	return isObject(nested) && Array.isArray(nested.calls) ? { ...nested, calls: nested.calls.map(eraseCall) } : nested;
}

function eraseMessage(message: JsonObject, marker: string): JsonObject {
	const next: JsonObject = { ...message };
	if ("content" in next) next.content = eraseContent(next.content, marker);
	for (const field of MESSAGE_TEXT_FIELDS) if (typeof next[field] === "string") next[field] = marker;
	delete next.details;
	if (next.nestedCalls !== undefined) next.nestedCalls = eraseNested(next.nestedCalls);
	return next;
}

type Eraser = (entry: JsonObject, marker: string) => JsonObject;

const eraseMessageEntry: Eraser = (entry, marker) => isObject(entry.message) ? { ...entry, message: eraseMessage(entry.message, marker) } : entry;
const eraseCustomMessage: Eraser = (entry, marker) => { const { details: _details, ...kept } = entry; return { ...kept, content: eraseContent(entry.content, marker) }; };
const eraseSummary: Eraser = (entry, marker) => typeof entry.summary === "string" ? { ...entry, summary: marker } : entry;
const eraseContextEdit: Eraser = (entry, marker) => isObject(entry.replacement) ? { ...entry, replacement: { ...entry.replacement, content: eraseContent(entry.replacement.content, marker) } } : entry;

/** A fold record keeps its ids and links; its topic is a derived summary of the covered text. */
const eraseFoldRecord: Eraser = (entry) => {
	if (entry.customType !== FOLD_ENTRY_TYPE || !isObject(entry.data) || !("topic" in entry.data)) return entry;
	const { topic: _topic, ...data } = entry.data;
	return { ...entry, data };
};

const ERASERS: ReadonlyMap<string, Eraser> = new Map([
	["message", eraseMessageEntry], ["custom_message", eraseCustomMessage], ["compaction", eraseSummary], ["branch_summary", eraseSummary], ["context_edit", eraseContextEdit], ["custom", eraseFoldRecord],
]);

/** A copy of the entry with its content erased. Entry kinds that hold no content come back unchanged. */
export function tombstoneEntry(entry: JsonObject, marker: string): JsonObject {
	const erase = typeof entry.type === "string" ? ERASERS.get(entry.type) : undefined;
	return erase ? erase(entry, marker) : entry;
}

/** True when erasing would change nothing but the date of an earlier marker. */
export function alreadyErased(entry: JsonObject, marker: string): boolean {
	const normal = (value: JsonObject) => JSON.stringify(value).replace(MARKER_DATE, "[erased]");
	return normal(entry) === normal(tombstoneEntry(entry, marker));
}

/** Everything a tombstone must leave alone. Two entries with equal structure keep the same tree and call/result pairing. */
export function structureOf(entry: JsonObject): string {
	const message = isObject(entry.message) ? entry.message : undefined;
	const parts = Array.isArray(message?.content) ? message.content : [];
	const calls = parts.filter((part): part is JsonObject => isObject(part) && part.type === "toolCall").map((part) => [part.id, part.name]);
	return JSON.stringify([entry.type, entry.id, entry.parentId, entry.timestamp, message?.role, message?.toolCallId, message?.toolName, message?.isError, calls,
		entry.customType, entry.targetId, entry.fromId, entry.firstKeptEntryId]);
}

/** Domain-separated by session and entry, so one secret has a different hash in every entry. */
export function contentHash(sessionId: string, entryId: string, line: string): string {
	return createHash("sha256").update(`${sessionId}\0${entryId}\0${line}`).digest("hex");
}
