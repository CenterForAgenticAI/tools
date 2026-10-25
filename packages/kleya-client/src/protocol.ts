// @centerforagenticai/kleya-client/protocol: ids, conversation refs, cursor format, wire types, error codes (K1, K2).
// Spec 5.1 and 5.2. Only the frames RV1 serves are defined; History, Answer, Withdraw, Presence and Live arrive with
// the work packages that serve them.

/** Minted by the session host, globally unique (K1). */
export type HarnessId = `h_${string}`;
/** Every record outside a store names a conversation with this, never a bare conversation id (K1-I1). */
export type ConversationRef = { harnessId: HarnessId; conversationId: number };
/** Opaque to clients, bound to one conversation of one Harness; an entry id, never a count. */
export type Cursor = string;

const PREFIX = "kc1.";

function toBase64Url(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
	} catch {
		return undefined;
	}
}

/** `kc1.` + base64url of `{v: 1, h, c, e}`: format version, Harness, conversation and entry id (0 = before the first entry). */
export function encodeCursor(conv: ConversationRef, entryId: number): Cursor {
	return PREFIX + toBase64Url(JSON.stringify({ v: 1, h: conv.harnessId, c: conv.conversationId, e: entryId }));
}

/** The entry id the cursor names, or undefined when it is malformed or names another Harness or conversation. */
export function decodeCursor(cursor: unknown, conv: ConversationRef): number | undefined {
	if (typeof cursor !== "string" || !cursor.startsWith(PREFIX)) return undefined;
	const json = fromBase64Url(cursor.slice(PREFIX.length));
	if (json === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { v, h, c, e } = value as Record<string, unknown>;
	if (v !== 1 || h !== conv.harnessId || c !== conv.conversationId) return undefined;
	return typeof e === "number" && Number.isSafeInteger(e) && e >= 0 ? e : undefined;
}

/** One stored entry as the client sees it. `body` is the entry record; large bodies become blob references later (U-K8-blob). */
export type EntryView = { id: Cursor; kind: string; bytes: number; body?: unknown };

// client → edge
export type Attach = { t: "attach"; conv: ConversationRef; cursor?: Cursor };
export type Since = { t: "since"; after: Cursor; through: Cursor; maxBytes?: number };
export type Submit = { t: "submit"; requestId: string; text: string; whenBusy?: "followUp" | "steer" };
/** RV1's Feed socket reads Attach and Since; turns arrive over the host's HTTP route. */
export type ClientFrame = Attach | Since | Submit;

// edge → client
/** Bounded live state; RV1 sends none. */
export type LiveState = Record<string, never>;
export type Window = { entries: EntryView[]; floor: Cursor; head: Cursor; truncated: boolean };
export type AttachOk = { t: "attached"; watermark: Cursor; live: LiveState; window: Window };
export type Page = { t: "page"; entries: EntryView[]; last: Cursor; more: boolean };
export type Commit = { t: "commit"; entries: EntryView[]; head: Cursor };
/** "wake" (added in RV1): the host restarted, so a restored socket must reattach and catch up by cursor (P4). */
export type Reset = { t: "reset"; reason: "slow_client" | "fork" | "cursor_expired" | "moved" | "compacted" | "wake"; reload: "live" | "full" };
export type ErrorCode = "invalid_cursor" | "unauthorized" | "forbidden" | "unavailable" | "too_large";
export type FeedError = { t: "error"; code: ErrorCode; retry?: "reattach" | "regrant" | "never" };
export type ServerFrame = AttachOk | Page | Commit | Reset | FeedError;
