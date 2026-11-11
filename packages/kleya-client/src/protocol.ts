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

function seal(prefix: string, value: object): string {
	return prefix + toBase64Url(JSON.stringify(value));
}

function unseal(prefix: string, cursor: unknown): Record<string, unknown> | undefined {
	if (typeof cursor !== "string" || !cursor.startsWith(prefix)) return undefined;
	const json = fromBase64Url(cursor.slice(prefix.length));
	if (json === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(json);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

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
/** What an input does when a run is working: queue for the next run (default), join the run (D36), or be refused. */
export type WhenBusy = "followUp" | "steer" | "reject";
export type Submit = { t: "submit"; requestId: string; text: string; whenBusy?: WhenBusy };
/** The frames of RV1's Feed socket. No host here speaks them since plan step 5: hosts serve turns over HTTP. */
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
/** `invalid_request`: the request could not be read, such as a body that is not JSON or lacks a field. */
export type ErrorCode = "invalid_request" | "invalid_cursor" | "cursor_expired" | "not_found" | "unauthorized" | "forbidden" | "unavailable" | "too_large";
/** `oldest` comes with `cursor_expired` from session follow: the oldest cursor the change index still serves. */
export type FeedError = { t: "error"; code: ErrorCode; retry?: "reattach" | "regrant" | "never"; oldest?: SessionCursor };
export type ServerFrame = AttachOk | Page | Commit | Reset | FeedError;

// Turns (spec 5.2). A turn is one request id's input and the run that answers it.

/** Names one commit in a session's change index (spec 5.2 "Two cursors"). Opaque to clients. */
export type SessionCursor = string;
/** A position in one turn's events. Opaque to clients; resuming from it repeats nothing. */
export type TurnCursor = string;

/** Stored once the input and its request record are committed together; `position` names that commit. */
export type Accepted = { t: "accepted"; requestId: string; conversation: number; position: SessionCursor; state: "queued" | "started" };
export type RejectReason = "conflict" | "too_old" | "forbidden" | "too_large" | "unavailable" | "stale_revision" | "run_ended" | "busy";
/** Nothing ran. `conflict`: the id was used with a different payload. */
export type Rejected = { t: "rejected"; requestId: string; reason: RejectReason };
/** `completed` and `cancelled` end in state `done`; `interrupted` (the run died with its host) and `failed` in `failed`. */
export type TurnOutcome = "completed" | "cancelled" | "interrupted" | "failed";
/** `attempt` counts from 1; a failed turn submitted again under the same id and payload runs as the next attempt. */
export type TurnStatus = {
	t: "status";
	requestId: string;
	conversation: number;
	state: "running" | "done" | "failed";
	started: boolean;
	attempt: number;
	outcome?: TurnOutcome;
	/** The store's reason for a failed or cancelled attempt, such as `model_error`. */
	reason?: string;
};
/**
 * `text` appends to the turn's answer text. `rewind` truncates the client's copy to `to` characters first: the host
 * lost text it had sent (a crash before it was stored, or a new attempt). `end` comes last.
 */
export type TurnEvent = { t: "text"; text: string } | { t: "rewind"; to: number } | { t: "end"; status: TurnStatus };
/** The JSON body of `POST …/submit` and `POST …/turn` over HTTP. Who submits, and the turn's credential, come from authentication, never from the body. */
export type SubmitBody = { requestId: string; text: string; whenBusy?: WhenBusy; conversation?: number };
/** The JSON body of `POST …/turns/<id>/abort`: the abort command's own request id. */
export type AbortBody = { abortId: string; conversation?: number };
/** One page of a turn's events; `done` once `end` was sent. */
export type TurnPage = { t: "turn"; requestId: string; events: TurnEvent[]; cursor: TurnCursor; done: boolean };
/** Session follow: every turn start and end in commit order, host-started turns included. */
export type SessionEvent = { t: "turn"; phase: "start" | "end"; requestId: string; conversation: number; at: SessionCursor };
export type SessionPage = { t: "session"; events: SessionEvent[]; cursor: SessionCursor };

/** Every size and time bound of the turn API, in one place (MIN-15). */
export const LIMITS = {
	/** Characters in a request id. */
	requestIdChars: 256,
	/** UTF-8 bytes of a submitted text: one inline entry. */
	textBytes: 65_536,
	/** Commits read for one session page, and entries read for one turn page. */
	pageEntries: 500,
	/** Characters of text in one turn page: at most 1 MiB as UTF-8. */
	pageChars: 262_144,
	/** Longest a follow call waits for news before it returns an empty page (K2-I9). */
	followWaitMs: 2_000,
	/**
	 * Longest a page request (`wait=<seconds>`) waits for news before it answers an empty page: under the 30 s
	 * whole-request timeout of a client that cannot read a stream, such as a herdr-app mod's `fetch`.
	 */
	pageWaitMs: 25_000,
	/** How long a request id is remembered with its result; later it is refused `too_old`. */
	requestRetentionMs: 7 * 24 * 60 * 60 * 1000,
	/** Bytes of an HTTP request body: a whole text, at most 6 bytes a character once JSON-escaped, and its fields (K1-I11). */
	bodyBytes: 6 * 65_536 + 8_192,
} as const;

/** A commit in the change index: its sequence number and its digest, which a dropped and recreated store does not repeat. */
export type SessionPosition = { seq: number; digest: string };

/** `ks1.` + base64url of `{v: 1, h, s, d}`: format version, session, commit seq and digest. */
export function encodeSessionCursor(harnessId: HarnessId, position: SessionPosition): SessionCursor {
	return seal("ks1.", { v: 1, h: harnessId, s: position.seq, d: position.digest });
}

/** The position, or undefined when the cursor is malformed or names another session. */
export function decodeSessionCursor(cursor: unknown, harnessId: HarnessId): SessionPosition | undefined {
	const value = unseal("ks1.", cursor);
	if (value === undefined || value.v !== 1 || value.h !== harnessId) return undefined;
	return isCount(value.s) && typeof value.d === "string" ? { seq: value.s, digest: value.d } : undefined;
}

/**
 * Where a follower stands in one turn's answer text. The follower holds `offset` characters, and `hash` covers them.
 * The first `stored` of them come from entries up to `entry`, which never change, and `storedHash` covers those: a
 * resume reads only entries after `entry` (MIN-18). When the rest no longer matches (text lost in a crash, or a new
 * attempt), the follower is rewound to `stored`, or to 0 for a new attempt.
 */
export type TurnPosition = { requestId: string; attempt: number; entry: number; stored: number; storedHash: string; offset: number; hash: string; ended: boolean };

/**
 * `kt1.` + base64url of the position, bound to one conversation of one session, one request id and one store: `store`
 * names the session's store, so a cursor from a dropped and recreated store is told apart from a current one.
 */
export function encodeTurnCursor(conv: ConversationRef, store: string, p: TurnPosition): TurnCursor {
	return seal("kt1.", { v: 1, h: conv.harnessId, c: conv.conversationId, s: store, r: p.requestId, a: p.attempt, n: p.entry, m: p.stored, y: p.storedHash, o: p.offset, x: p.hash, e: p.ended ? 1 : 0 });
}

/**
 * The position and the store it was read from, or undefined when the cursor is malformed or names another session,
 * conversation or request. The caller compares `store` with its own: a mismatch means the cursor has expired.
 */
export function decodeTurnCursor(cursor: unknown, conv: ConversationRef, requestId: string): (TurnPosition & { store: string }) | undefined {
	const v = unseal("kt1.", cursor);
	if (v === undefined || v.v !== 1 || v.h !== conv.harnessId || v.c !== conv.conversationId || v.r !== requestId) return undefined;
	const { s, a, n, m, y, o, x, e } = v;
	if (typeof s !== "string" || !isCount(a) || a < 1 || !isCount(n) || !isCount(m) || !isCount(o) || m > o || typeof x !== "string" || typeof y !== "string" || (e !== 0 && e !== 1)) return undefined;
	return { store: s, requestId, attempt: a, entry: n, stored: m, storedHash: y, offset: o, hash: x, ended: e === 1 };
}
