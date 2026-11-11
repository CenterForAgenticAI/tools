// The turn reader's pure part: a turn's answer text from its entries, and the events that bring a follower up to it.
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TurnEvent, TurnPosition } from "@centerforagenticai/kleya-client/protocol";

/** Entry kinds that start a new input, so they end the text of the turn before them. */
const INPUT_KINDS = new Set(["kleya.input", "pi.user"]);
export const SEPARATOR = "\n\n";

type Block = { type?: unknown; text?: unknown };
type AssistantJson = { role?: unknown; content?: unknown; stopReason?: unknown };

function textOf(message: AssistantJson | undefined): string {
	if (message === undefined || !Array.isArray(message.content)) return "";
	return (message.content as Block[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
}

/** What a run of entries adds to a turn's text. */
export type Stored = {
	/** Text of finished answers, joined; it never changes. */
	fixed: string;
	/** The last entry `fixed` covers, or undefined when it covers none. */
	fixedEntry: number | undefined;
	/** A cut-off last attempt (a crash or an error); a later attempt replaces it, so it is never spliced to its retry. */
	tail: string;
	/** True once the turn's answer or the next input was read. */
	complete: boolean;
};

/** Reads ascending `entries` of one turn, stopping at `last` (the answer) or at the next input. */
export function readStored(entries: readonly EntryRecord[], last: number | undefined): Stored {
	const parts: string[] = [];
	let fixedEntry: number | undefined;
	let tail = "";
	for (const entry of entries) {
		if ((last !== undefined && entry.id > last) || INPUT_KINDS.has(entry.kind)) return { fixed: parts.join(SEPARATOR), fixedEntry, tail, complete: true };
		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.find((m) => m.role === "assistant") as AssistantJson | undefined;
		const text = textOf(message);
		tail = "";
		if (message?.stopReason === "aborted" || message?.stopReason === "error") tail = text;
		else {
			if (text !== "") parts.push(text);
			fixedEntry = entry.id;
		}
		if (entry.id === last) return { fixed: parts.join(SEPARATOR), fixedEntry, tail, complete: true };
	}
	return { fixed: parts.join(SEPARATOR), fixedEntry, tail, complete: false };
}

/** The text a live, unstored generation has streamed so far, from `pi.live`'s `generation.message`. */
export function liveText(live: unknown): string {
	if (typeof live !== "object" || live === null || Array.isArray(live)) return "";
	const generation = (live as { generation?: { message?: AssistantJson } }).generation;
	return textOf(generation?.message);
}

const join = (a: string, b: string) => (a === "" ? b : b === "" ? a : a + SEPARATOR + b);

const SEED = "811c9dc5" + "5bd1e995";
/** A 64-bit FNV-1a digest as hex, continued from `state` (another digest); it detects changed text, it does not protect it. */
export function textHash(text: string, state = SEED): string {
	let a = Number.parseInt(state.slice(0, 8), 16);
	let b = Number.parseInt(state.slice(8, 16), 16);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export type Page = { events: TurnEvent[]; position: TurnPosition; caughtUp: boolean };

/**
 * One page for a follower at `from`. The turn's text is the follower's stored prefix (`from.stored` characters,
 * through entry `from.entry`; empty for a new attempt) followed by `read` (the entries after it) and `live`. The page
 * resends nothing the follower still holds, rewinds what no longer matches, and sends at most `maxChars` characters.
 */
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export function page(requestId: string, attempt: number, from: TurnPosition | undefined, read: Stored, live: string, ended: boolean, maxChars: number): Page {
	const same = from !== undefined && from.attempt === attempt;
	const base = same ? { entry: from.entry, stored: from.stored, hash: from.storedHash } : { entry: 0, stored: 0, hash: SEED };
	const rest = join(read.fixed, live !== "" ? live : read.tail);
	const suffix = base.stored > 0 && rest !== "" ? SEPARATOR + rest : rest;
	const events: TurnEvent[] = [];
	let at = 0;
	if (same && from.offset - base.stored <= suffix.length && textHash(suffix.slice(0, from.offset - base.stored), base.hash) === from.hash) {
		at = from.offset - base.stored;
	} else if (from !== undefined && from.offset > 0) {
		events.push({ t: "rewind", to: base.stored });
	}
	let end = Math.min(suffix.length, at + Math.max(1, maxChars));
	// A page never ends between the two halves of a surrogate pair.
	if (end < suffix.length && end - 1 > at && isHighSurrogate(suffix.charCodeAt(end - 1))) end -= 1;
	if (end > at) events.push({ t: "text", text: suffix.slice(at, end) });
	const caughtUp = end === suffix.length;
	// The watermark moves to the last fixed entry once the follower holds all of its text.
	const fixedSuffix = read.fixed === "" ? "" : base.stored > 0 ? SEPARATOR + read.fixed : read.fixed;
	const advance = read.fixedEntry !== undefined && end >= fixedSuffix.length;
	const position: TurnPosition = {
		requestId,
		attempt,
		entry: advance ? read.fixedEntry! : base.entry,
		stored: advance ? base.stored + fixedSuffix.length : base.stored,
		storedHash: advance ? textHash(fixedSuffix, base.hash) : base.hash,
		offset: base.stored + end,
		hash: textHash(suffix.slice(0, end), base.hash),
		ended: ended && caughtUp,
	};
	return { events, position, caughtUp };
}
