/**
 * The requester side of pi-memory's session search, for `context_recall`.
 *
 * pi-memory answers searches on Pi's in-process event bus; neither package imports
 * the other. The request and reply shapes below are a copy of the pi-memory
 * repository's `src/contract.ts` at commit 1c60760 (its decision 0002), and the
 * field limits are those of its `validateRequest` (`src/search/index.ts`). Keep
 * them in step by hand.
 *
 * Protocol: emit one request on {@link PI_MEMORY_SEARCH_EVENT}. A responder calls
 * `ack()` before `emit` returns, then `reply` exactly once. No `ack` means
 * pi-memory is not loaded; no reply within `timeoutMs` means the search timed out.
 */

import { redactText } from "../snapshot-contracts/safety.js";
import { expandCall, READ_MAX_ID_CHARS } from "./pi-memory-read.js";
import { isTraceId } from "./pi-memory-recall-log.js";

export const PI_MEMORY_SEARCH_EVENT = "pi-memory:search";
/** How long a search may take before the file search runs instead. */
export const PI_MEMORY_TIMEOUT_MS = 2500;
/** The most cards one search returns. */
export const PI_MEMORY_MAX_CARDS = 5;
/** The responder's limits: a longer query is cut there, so a longer query is not sent. */
export const PI_MEMORY_MAX_QUERY_CHARS = 1000;
export const PI_MEMORY_MAX_ID_CHARS = 256;
export const PI_MEMORY_MAX_CWD_CHARS = 4096;
export const PI_MEMORY_MAX_TIMEOUT_MS = 30_000;

export type PiMemoryErrorKind = "unavailable" | "timeout" | "bad_request" | "internal";
const ERROR_KINDS: readonly PiMemoryErrorKind[] = ["unavailable", "timeout", "bad_request", "internal"];

/** One search result as pi-memory sends it: the best entry of one session lineage. */
export interface PiMemoryCard {
	sessionId: string;
	host?: string;
	repo: string;
	title?: string;
	startedAt: string;
	score: number;
	entryId: string;
	entryTs?: string;
	snippet: string;
	alsoIn?: string[];
}

export type PiMemoryReply =
	| { ok: true; cards: PiMemoryCard[]; tookMs: number }
	| { ok: false; error: PiMemoryErrorKind; message: string; tookMs: number };

/** The fields this extension sends; `ack` and `reply` are added by {@link askPiMemory}. */
export interface PiMemoryRequestFields {
	readonly query: string;
	readonly askingSessionId?: string;
	readonly scope?: "prior" | "all-projects";
	readonly cwd?: string;
	readonly limit: number;
	/** The calling tool call's trace id (caair/pi/pi-memory#25); one that is not a valid trace id is not sent. */
	readonly traceId?: string;
}

export interface PiMemorySearchRequest extends PiMemoryRequestFields {
	readonly v: 1;
	readonly timeoutMs: number;
	ack(): void;
	reply(result: PiMemoryReply): void;
}

/** The only event-bus capability the requester needs. */
export interface PiMemoryEventBus {
	emit(channel: string, data: unknown): void;
}

/** What one request came to. Every status except `answered` means the file search runs instead. */
export type PiMemoryOutcome =
	| { readonly status: "answered"; readonly cards: readonly PiMemoryCard[]; readonly tookMs: number }
	| { readonly status: "absent" }
	| { readonly status: "timeout"; readonly timeoutMs: number }
	| { readonly status: "error"; readonly error: PiMemoryErrorKind; readonly message: string }
	| { readonly status: "invalid reply"; readonly reason: string }
	| { readonly status: "replied twice" }
	| { readonly status: "threw" }
	| { readonly status: "query too long" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

/** Copy the named fields of one card, or say why it is not a card. */
function readCard(value: unknown): PiMemoryCard | string {
	if (!isRecord(value)) return "a card is not an object";
	const { sessionId, host, repo, title, startedAt, score, entryId, entryTs, snippet, alsoIn } = value;
	if (typeof sessionId !== "string" || sessionId === "") return "a card has no sessionId";
	if (typeof repo !== "string") return "a card has no repo";
	if (typeof startedAt !== "string") return "a card has no startedAt";
	if (typeof score !== "number" || !Number.isFinite(score)) return "a card has no finite score";
	if (typeof entryId !== "string" || entryId === "") return "a card has no entryId";
	if (typeof snippet !== "string") return "a card has no snippet";
	if (!optionalString(host) || !optionalString(title) || !optionalString(entryTs)) return "a card has a field of the wrong type";
	if (alsoIn !== undefined && (!Array.isArray(alsoIn) || !alsoIn.every((id) => typeof id === "string"))) return "a card's alsoIn is not a list of session ids";
	return {
		sessionId, repo, startedAt, score, entryId, snippet,
		...(host !== undefined ? { host } : {}),
		...(title !== undefined ? { title } : {}),
		...(entryTs !== undefined ? { entryTs } : {}),
		...(alsoIn !== undefined ? { alsoIn: [...alsoIn as string[]] } : {}),
	};
}

/** Check an untrusted reply against the contract, copying named fields only. */
export function readPiMemoryReply(value: unknown, limit: number): PiMemoryOutcome {
	try {
		if (!isRecord(value)) return { status: "invalid reply", reason: "the reply is not an object" };
		if (value.ok === false) {
			const error = value.error;
			if (!ERROR_KINDS.includes(error as PiMemoryErrorKind)) return { status: "invalid reply", reason: "unknown error kind" };
			return { status: "error", error: error as PiMemoryErrorKind, message: typeof value.message === "string" ? value.message : "" };
		}
		if (value.ok !== true) return { status: "invalid reply", reason: "ok is neither true nor false" };
		const { cards, tookMs } = value;
		if (!Array.isArray(cards)) return { status: "invalid reply", reason: "cards is not a list" };
		if (cards.length > PI_MEMORY_MAX_CARDS) return { status: "invalid reply", reason: `more than ${PI_MEMORY_MAX_CARDS} cards` };
		if (typeof tookMs !== "number" || !Number.isFinite(tookMs)) return { status: "invalid reply", reason: "tookMs is not a number" };
		const read: PiMemoryCard[] = [];
		for (const card of cards) {
			const copy = readCard(card);
			if (typeof copy === "string") return { status: "invalid reply", reason: copy };
			read.push(copy);
		}
		return { status: "answered", cards: read.slice(0, limit), tookMs };
	} catch {
		// A getter that throws makes the reply unreadable.
		return { status: "invalid reply", reason: "the reply could not be read" };
	}
}

/**
 * Ask pi-memory once. Returns the outcome itself when it is known during emit
 * (no responder, a bus that rethrew a listener's error, two replies at once),
 * otherwise a promise of it. Never rejects, never waits past `timeoutMs`, and
 * leaves no timer behind once settled. A reply after the result is settled is
 * ignored; two replies before it settles are a fault.
 *
 * Pi's own bus (`createEventBus`) catches a listener's error and logs it, so
 * `emit` never throws there. On that bus a listener that throws before `ack()`
 * reads as `absent` at once, and one that throws after `ack()` reads as
 * `timeout`, bounded by `timeoutMs`. `threw` is reached only on a bus that
 * rethrows. pi-memory's responder catches its own errors and replies
 * `ok: false`, so only another listener can cost the full timeout.
 */
export function askPiMemory(events: PiMemoryEventBus, fields: PiMemoryRequestFields, requestedTimeoutMs: number = PI_MEMORY_TIMEOUT_MS): PiMemoryOutcome | Promise<PiMemoryOutcome> {
	const timeoutMs = Number.isFinite(requestedTimeoutMs) ? Math.min(Math.max(1, Math.floor(requestedTimeoutMs)), PI_MEMORY_MAX_TIMEOUT_MS) : PI_MEMORY_TIMEOUT_MS;
	const sync: { outcome?: PiMemoryOutcome } = {};
	const asked = new Promise<PiMemoryOutcome>((resolve) => {
		let acked = false;
		let emitting = true;
		let settled = false;
		let replies = 0;
		let firstReply: unknown;
		let pending: ReturnType<typeof setImmediate> | undefined;
		const finish = (outcome: PiMemoryOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (pending !== undefined) clearImmediate(pending);
			sync.outcome = outcome;
			resolve(outcome);
		};
		// One turn of the event loop lets a second reply sent right after the first show up.
		const settleSoon = (): void => {
			pending = setImmediate(() => finish(readPiMemoryReply(firstReply, fields.limit)));
		};
		const request: PiMemorySearchRequest = {
			v: 1,
			query: fields.query,
			...(fields.askingSessionId !== undefined ? { askingSessionId: fields.askingSessionId } : {}),
			...(fields.cwd !== undefined ? { cwd: fields.cwd } : {}),
			...(fields.scope !== undefined ? { scope: fields.scope } : {}),
			limit: fields.limit,
			...(isTraceId(fields.traceId) ? { traceId: fields.traceId } : {}),
			timeoutMs,
			ack() { acked = true; },
			reply(result: unknown) {
				if (settled) return;
				replies += 1;
				if (replies > 1) return finish({ status: "replied twice" });
				firstReply = result;
				if (!emitting) settleSoon();
			},
		};
		// Armed before emit so every path, including a reply during emit, has one deadline; finish clears it.
		const timer = setTimeout(() => finish({ status: "timeout", timeoutMs }), timeoutMs);
		try {
			events.emit(PI_MEMORY_SEARCH_EVENT, request);
		} catch {
			return finish({ status: "threw" });
		}
		emitting = false;
		if (settled) return;
		// A reply during emit shows a responder too, even one that skipped ack.
		if (!acked && replies === 0) return finish({ status: "absent" });
		if (replies === 1) settleSoon();
	});
	// An outcome known during emit (no responder, a listener that threw, two replies at once) comes back at once, so the caller need not wait a turn.
	return sync.outcome ?? asked;
}

/** The request fields, each bounded to the responder's limits; an over-long id or cwd is left out, never cut. */
export function piMemoryRequestFields(query: string, maxSessions: number, sessionId: string | undefined, cwd: string, traceId?: string, scope?: PiMemoryRequestFields["scope"]): PiMemoryRequestFields {
	return {
		...(traceId !== undefined ? { traceId } : {}),
		...(scope !== undefined ? { scope } : {}),
		query,
		...(sessionId && sessionId.length <= PI_MEMORY_MAX_ID_CHARS ? { askingSessionId: sessionId } : {}),
		...(cwd && cwd.length <= PI_MEMORY_MAX_CWD_CHARS ? { cwd } : {}),
		limit: Math.max(1, Math.min(Math.floor(maxSessions), PI_MEMORY_MAX_CARDS)),
	};
}

/**
 * The repository name pi-memory stores for a session started in `cwd`, as its
 * `repoOf` computes it (`src/search/terms.ts`): drop the home prefix and any
 * `/.worktrees/...` tail, then take the last path segment; the home itself is `~`.
 */
export function piMemoryRepoOf(cwd: string, home: string): string {
	const root = home.replace(/\/+$/u, "");
	let rel = cwd;
	if (root !== "" && (cwd === root || cwd.startsWith(`${root}/`))) rel = cwd.slice(root.length).replace(/^\//u, "");
	rel = rel.replace(/\/\.worktrees\/.*$/u, "");
	return rel === "" ? "~" : rel.split("/").at(-1) ?? "";
}

/** Bounds for the card fields shown to the model. Every card field is untrusted text. */
const MAX_CARD_ID_CHARACTERS = 128;
const MAX_CARD_TITLE_CHARACTERS = 80;
const MAX_CARD_TIME_CHARACTERS = 40;
const MAX_ALSO_IN_SHOWN = 5;
const MAX_ERROR_MESSAGE_CHARACTERS = 200;

/** One card as `context_recall` reports it: bounded and redacted. */
export interface PiMemoryCardDetails {
	readonly session_id: string;
	readonly repo: string;
	readonly started_at: string;
	readonly score: number;
	readonly entry_id: string;
	readonly snippet: string;
	readonly host?: string;
	readonly title?: string;
	readonly entry_ts?: string;
	readonly also_in?: readonly string[];
	/** alsoIn ids past the first five, not listed. */
	readonly also_in_more?: number;
	/** The exact call that reads around the matched entry, built from the ids as sent, never from their shown forms. */
	readonly expand?: string;
	/** Why there is no expand call when an id is too long for a ref; an id a ref cannot carry gets neither. */
	readonly expand_unavailable?: "id too long";
}

export interface CardBounds {
	readonly home: string;
	readonly cwd: string;
	readonly snippetCharacters: number;
}

function bound(value: string, maxLength: number, bounds: CardBounds): string {
	return redactText(value, { home: bounds.home, cwd: bounds.cwd, maxLength });
}

/**
 * The call that expands a card. Built from the ids the store sent, so an id up to READ_MAX_ID_CHARS is passed back
 * whole; a longer id gets no call rather than a cut one. An id that redaction would change (it looks like a secret
 * or a path) gets no call either, so the call never shows what the card's own fields hide.
 */
function cardExpand(card: PiMemoryCard, bounds: CardBounds): Pick<PiMemoryCardDetails, "expand" | "expand_unavailable"> {
	if (card.sessionId.length > READ_MAX_ID_CHARS || card.entryId.length > READ_MAX_ID_CHARS) return { expand_unavailable: "id too long" };
	if (bound(card.sessionId, READ_MAX_ID_CHARS, bounds) !== card.sessionId || bound(card.entryId, READ_MAX_ID_CHARS, bounds) !== card.entryId) return {};
	const expand = expandCall(card.sessionId, card.entryId);
	return expand !== undefined ? { expand } : {};
}

export function boundCard(card: PiMemoryCard, bounds: CardBounds): PiMemoryCardDetails {
	const alsoIn = card.alsoIn ?? [];
	return {
		session_id: bound(card.sessionId, MAX_CARD_ID_CHARACTERS, bounds),
		repo: bound(card.repo, MAX_CARD_ID_CHARACTERS, bounds),
		started_at: bound(card.startedAt, MAX_CARD_TIME_CHARACTERS, bounds),
		score: card.score,
		entry_id: bound(card.entryId, MAX_CARD_ID_CHARACTERS, bounds),
		snippet: bound(card.snippet, bounds.snippetCharacters, bounds),
		...(card.host ? { host: bound(card.host, MAX_CARD_ID_CHARACTERS, bounds) } : {}),
		...(card.title ? { title: bound(card.title, MAX_CARD_TITLE_CHARACTERS, bounds) } : {}),
		...(card.entryTs ? { entry_ts: bound(card.entryTs, MAX_CARD_TIME_CHARACTERS, bounds) } : {}),
		...(alsoIn.length > 0 ? { also_in: alsoIn.slice(0, MAX_ALSO_IN_SHOWN).map((id) => bound(id, MAX_CARD_ID_CHARACTERS, bounds)) } : {}),
		...(alsoIn.length > MAX_ALSO_IN_SHOWN ? { also_in_more: alsoIn.length - MAX_ALSO_IN_SHOWN } : {}),
		...cardExpand(card, bounds),
	};
}

export function renderCard(card: PiMemoryCardDetails): string[] {
	const lines = [`### Session ${card.session_id}${card.title ? `: ${card.title}` : ""}`];
	lines.push(`- repo: ${card.repo}`);
	if (card.host) lines.push(`- host: ${card.host}`);
	lines.push(`- started: ${card.started_at}`);
	lines.push(`- entry: ${card.entry_id}${card.entry_ts ? ` at ${card.entry_ts}` : ""}`);
	if (card.also_in) lines.push(`- also in: ${card.also_in.join(", ")}${card.also_in_more ? ` and ${card.also_in_more} more` : ""}`);
	lines.push(`  > ${card.snippet}`);
	// The exact call that reads around the matched entry; an id that cannot be passed back gets none.
	if (card.expand !== undefined) lines.push(`- expand: ${card.expand}`);
	else if (card.expand_unavailable === "id too long") lines.push(`- expand: none (an id is longer than ${READ_MAX_ID_CHARS} characters, so no call can name it)`);
	return lines;
}

/** The line that says why the file search ran instead. */
export function fallbackNotice(outcome: Exclude<PiMemoryOutcome, { status: "answered" }>, bounds: CardBounds): string {
	const why = ((): string => {
		switch (outcome.status) {
			case "absent": return "not loaded";
			case "timeout": return `timeout after ${outcome.timeoutMs} ms`;
			case "error": {
				const message = outcome.message ? `: ${bound(outcome.message, MAX_ERROR_MESSAGE_CHARACTERS, bounds)}` : "";
				return `${outcome.error}${message}`;
			}
			case "invalid reply": return `invalid reply: ${outcome.reason}`;
			case "replied twice": return "replied more than once";
			case "threw": return "its listener threw";
			case "query too long": return `query longer than ${PI_MEMORY_MAX_QUERY_CHARS} characters`;
		}
	})();
	return `pi-memory search unavailable (${why}); searched session files instead.`;
}

/** The outcome as reported in `details`, without the reply's untrusted text beyond a bounded message. */
export type PiMemoryOutcomeDetails =
	| { readonly status: "answered"; readonly took_ms: number; readonly returned: number; readonly other_projects_left_out: number; readonly erased_left_out: number; readonly cards: readonly PiMemoryCardDetails[] }
	| { readonly status: Exclude<PiMemoryOutcome["status"], "answered">; readonly error?: PiMemoryErrorKind; readonly timeout_ms?: number };

export function fallbackDetails(outcome: Exclude<PiMemoryOutcome, { status: "answered" }>): PiMemoryOutcomeDetails {
	return {
		status: outcome.status,
		...(outcome.status === "error" ? { error: outcome.error } : {}),
		...(outcome.status === "timeout" ? { timeout_ms: outcome.timeoutMs } : {}),
	};
}
