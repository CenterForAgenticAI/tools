// @centerforagenticai/kleya-server/http: the turn API over HTTP (spec 5.2), as one fetch handler for any platform.
// Ingress controls K1-I10 to K1-I12; follow over SSE, or NDJSON for servers; the optional `POST /turn` wrapper.
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
	LIMITS,
	type AbortBody,
	type Accepted,
	type ErrorCode,
	type FeedError,
	type RejectReason,
	type Rejected,
	type SessionCursor,
	type SessionPage,
	type SubmitBody,
	type TurnCursor,
	type TurnPage,
	type TurnStatus,
	type WhenBusy,
} from "@centerforagenticai/kleya-client/protocol";
import { authorize, principalOf, verifyGrant, type HarnessDirectory, type IssuerKeyStore } from "./grants.ts";
import { harnessIdOf, type Caller, type Right, type Scope, type SessionHost, type SubmitOptions } from "./host/core.ts";
import { MIN_TOKEN_CHARS, sameToken } from "./http/token.ts";

/**
 * Who sent a request, as the product's `authenticate` established it. `credential` is the product credential the
 * request's turns act with (spec 5.3.4); it never comes from the request body, and no response carries it. `harness`,
 * when set, is the one Harness the caller may act in: the edge refuses any other scope before `authorize` runs.
 */
export type Authenticated = { readonly caller: Caller; readonly credential?: string; readonly harness?: string };

export type EdgeOptions = {
	/** The product every scope on this edge belongs to. */
	readonly product: string;
	/** How many path segments name the scope's keys, such as 2 for `<tenant>/<thread>`. */
	readonly keys: number;
	/** A path prefix in front of the keys, such as `/agent`. */
	readonly base?: string;
	/** The request's caller, or undefined to answer 401. */
	authenticate(request: Request, context: Context): Promise<Authenticated | undefined>;
	/**
	 * Whether the caller may act in `scope`. The scope comes from the path, which the caller writes, so it is checked
	 * before a session is opened (K1-I3). A refusal answers 403 whether or not the scope has a session.
	 */
	authorize(caller: Caller, scope: Scope, context: Context): boolean | Promise<boolean>;
	/** The session for a scope: a host's `session`, or on Cloudflare the state owner's stub. */
	session(scope: Scope, context: Context): Promise<SessionHost>;
};

/** A fetch handler. `context` defaults to the background context. */
export type Edge = (request: Request, context?: Context) => Promise<Response>;

type Op = "submit" | "turn" | "session" | "status" | "follow" | "abort";
type Route = { readonly scope: Scope; readonly op: Op; readonly requestId?: string };
type Frame = { readonly event: string; readonly id?: string; readonly data: unknown };
/** The next frame of a stream, if a page had news, and whether the stream ends after it. */
type More = (context: Context) => Promise<{ frame?: Frame; done: boolean }>;

const METHOD: Record<Op, "GET" | "POST"> = { submit: "POST", turn: "POST", abort: "POST", session: "GET", status: "GET", follow: "GET" };
const REJECTED_STATUS: Record<RejectReason, number> = {
	conflict: 409,
	too_old: 409,
	run_ended: 409,
	stale_revision: 409,
	busy: 429,
	forbidden: 403,
	too_large: 413,
	unavailable: 503,
};
const ERROR_STATUS: Record<ErrorCode, number> = {
	invalid_request: 400,
	invalid_cursor: 400,
	cursor_expired: 410,
	not_found: 404,
	unauthorized: 401,
	forbidden: 403,
	unavailable: 503,
	too_large: 413,
};
const WHEN_BUSY: readonly WhenBusy[] = ["followUp", "steer", "reject"];

const error = (code: ErrorCode, retry: NonNullable<FeedError["retry"]> = "never"): FeedError => ({ t: "error", code, retry });

/**
 * A JSON answer. A 503 carries `Retry-After` when the body's retry hint says to try again. No 429 body carries a hint:
 * a `busy` refusal answers what the caller asked for, and the caller decides when to ask again.
 */
function answer(body: Accepted | Rejected | FeedError | TurnStatus | TurnPage | SessionPage, status?: number, headers: Record<string, string> = {}): Response {
	const code = status ?? (body.t === "accepted" ? 202 : body.t === "status" || body.t === "turn" || body.t === "session" ? 200 : body.t === "rejected" ? REJECTED_STATUS[body.reason] : ERROR_STATUS[body.code]);
	const h = new Headers({ ...headers, "content-type": "application/json", "cache-control": "no-store" });
	if (code === 503 && body.t === "error" && body.retry === "reattach") h.set("retry-after", "1");
	return new Response(JSON.stringify(body), { status: code, headers: h });
}

/** A path segment, percent-decoded, or undefined when it is empty or its encoding is malformed: such a path names nothing (K1-I12). */
function decode(segment: string | undefined): string | undefined {
	if (segment === undefined || segment.length === 0) return undefined;
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

function route(pathname: string, options: EdgeOptions): Route | undefined {
	const base = options.base ?? "";
	if (!pathname.startsWith(`${base}/`)) return undefined;
	const parts = pathname.slice(base.length + 1).split("/");
	if (parts.length <= options.keys) return undefined;
	const keys: string[] = [];
	for (const part of parts.slice(0, options.keys)) {
		const key = decode(part);
		if (key === undefined) return undefined;
		keys.push(key);
	}
	const scope: Scope = { product: options.product, keys };
	const rest = parts.slice(options.keys);
	if (rest.length === 1 && rest[0] === "submit") return { scope, op: "submit" };
	if (rest.length === 1 && rest[0] === "turn") return { scope, op: "turn" };
	if (rest.length === 1 && rest[0] === "events") return { scope, op: "session" };
	if (rest[0] !== "turns" || rest.length < 2 || rest.length > 3) return undefined;
	const requestId = decode(rest[1]);
	if (requestId === undefined) return undefined;
	if (rest.length === 2) return { scope, op: "status", requestId };
	if (rest[2] === "events") return { scope, op: "follow", requestId };
	if (rest[2] === "abort") return { scope, op: "abort", requestId };
	return undefined;
}

/** `application/json`, with or without parameters such as a charset. */
function isJson(contentType: string | null): boolean {
	return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * The body as JSON, or a status: 413 once more than `limit` bytes arrive, read no further, whether or not a length was
 * declared (K1-I11); 400 when it is not JSON.
 */
async function readJson(request: Request, limit: number): Promise<{ value: unknown } | { status: 400 | 413 }> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > limit) return { status: 413 };
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body !== null) {
		const reader = request.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > limit) {
					await reader.cancel().catch(() => {});
					return { status: 413 };
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
	} catch {
		return { status: 400 };
	}
}

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const conversationOf = (value: unknown): number | undefined | false => (value === undefined ? undefined : Number.isSafeInteger(value) ? (value as number) : false);

/** Named fields of a submit body only (`SubmitBody`); anything else it carries, such as a principal or a credential, is ignored. */
function submitBody(value: unknown): SubmitBody | undefined {
	const v = record(value);
	if (v === undefined || typeof v.requestId !== "string" || typeof v.text !== "string") return undefined;
	const whenBusy = v.whenBusy;
	if (whenBusy !== undefined && !WHEN_BUSY.includes(whenBusy as WhenBusy)) return undefined;
	const conversation = conversationOf(v.conversation);
	if (conversation === false) return undefined;
	return {
		requestId: v.requestId,
		text: v.text,
		...(whenBusy === undefined ? {} : { whenBusy: whenBusy as WhenBusy }),
		...(conversation === undefined ? {} : { conversation }),
	};
}

function abortBody(value: unknown): AbortBody | undefined {
	const v = record(value);
	if (v === undefined || typeof v.abortId !== "string") return undefined;
	const conversation = conversationOf(v.conversation);
	if (conversation === false) return undefined;
	return { abortId: v.abortId, ...(conversation === undefined ? {} : { conversation }) };
}

function encode(frame: Frame, ndjson: boolean): string {
	const data = JSON.stringify(frame.data);
	if (ndjson) return `${data}\n`;
	return `event: ${frame.event}\n${frame.id === undefined ? "" : `id: ${frame.id}\n`}data: ${data}\n\n`;
}

/**
 * A streamed answer: `first`, then each frame `more` finds, until a frame ends it or the client closes. Closing stops the
 * reading, never the turn. One SSE message or NDJSON line is one whole page, so a drop mid-page repeats nothing.
 */
function stream(ndjson: boolean, first: readonly Frame[], more: More | undefined, context: Context): Response {
	const encoder = new TextEncoder();
	const stop = new AbortController();
	const reading = withAbortSignal(stop.signal, context);
	const queue = [...first];
	let ended = more === undefined;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const frame = queue.shift();
				if (frame !== undefined) return controller.enqueue(encoder.encode(encode(frame, ndjson)));
				if (ended || more === undefined) return controller.close();
				let next: Awaited<ReturnType<More>>;
				try {
					next = await more(reading);
				} catch {
					// An error's text may hold anything the turn saw: the stream ends with a bare error frame instead.
					next = { frame: { event: "error", data: error("unavailable", "reattach") }, done: true };
				}
				if (stop.signal.aborted) return;
				ended = next.done;
				if (next.frame !== undefined) queue.push(next.frame);
				// A page with no news: SSE sends a comment, so proxies keep the stream open.
				else if (!ended && !ndjson) return controller.enqueue(encoder.encode(":\n\n"));
			}
		},
		cancel() {
			stop.abort();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": ndjson ? "application/x-ndjson" : "text/event-stream", "cache-control": "no-store" } });
}

/** The turn's pages after `after`, as frames; the stream ends with the page that ends the turn. */
function turnPages(session: SessionHost, caller: Caller, requestId: string, conversation: number | undefined, after: TurnCursor | undefined): More {
	let cursor = after;
	return async (context) => {
		const page = await session.follow(caller, requestId, { ...(cursor === undefined ? {} : { after: cursor }), ...(conversation === undefined ? {} : { conversation }) }, context);
		if (page.t === "error") return { frame: { event: "error", data: page }, done: true };
		cursor = page.cursor;
		if (page.events.length === 0 && !page.done) return { done: false };
		return { frame: { event: "turn", id: page.cursor, data: page }, done: page.done };
	};
}

/** The session's pages after `after`, as frames, until the client closes. */
function sessionPages(session: SessionHost, caller: Caller, after: SessionCursor | undefined): More {
	let cursor = after;
	return async (context) => {
		const page = await session.followSession(caller, cursor === undefined ? {} : { after: cursor }, context);
		if (page.t === "error") return { frame: { event: "error", data: page }, done: true };
		cursor = page.cursor;
		if (page.events.length === 0) return { done: false };
		return { frame: { event: "session", id: page.cursor, data: page }, done: false };
	};
}

/** A stream that starts with the first frame `more` finds, or the JSON error when that first page is one. */
async function follow(ndjson: boolean, opening: readonly Frame[], more: More, context: Context): Promise<Response> {
	if (opening.length === 0) {
		const first = await more(context);
		if (first.frame?.event === "error") return answer(first.frame.data as FeedError);
		return stream(ndjson, first.frame === undefined ? [] : [first.frame], first.done ? undefined : more, context);
	}
	return stream(ndjson, opening, more, context);
}

/**
 * A page request's wait in milliseconds, at most `LIMITS.pageWaitMs`; undefined when the request has no `wait` and so
 * streams; false when `wait` is not a whole number of seconds.
 */
function pageWait(url: URL): number | undefined | false {
	const wait = url.searchParams.get("wait");
	if (wait === null) return undefined;
	if (!/^\d{1,5}$/.test(wait)) return false;
	return Math.min(Number(wait) * 1_000, LIMITS.pageWaitMs);
}

/**
 * One page as JSON, then the response ends: `read` from the cursor, each read at most `LIMITS.followWaitMs` (K2-I9),
 * until a page has events or ends the turn, `waitMs` has passed, or the client went away. A page with no news moves the
 * cursor on, so the next read repeats nothing; the last one answers with its cursor. An error page answers as the
 * stream's first page would.
 */
async function page<P extends TurnPage | SessionPage>(
	read: (cursor: string | undefined, waitMs: number, context: Context) => Promise<P | FeedError>,
	after: string | undefined,
	waitMs: number,
	context: Context,
): Promise<Response> {
	const deadline = Date.now() + waitMs;
	let cursor = after;
	for (;;) {
		const p = await read(cursor, Math.min(Math.max(deadline - Date.now(), 0), LIMITS.followWaitMs), context);
		if (p.t === "error") return answer(p);
		if (p.events.length > 0 || (p.t === "turn" && p.done) || Date.now() >= deadline || context.abortSignal?.aborted) return answer(p);
		cursor = p.cursor;
	}
}

/**
 * The turn API over HTTP for one product. Every request is authenticated, its path parsed, its scope authorized before a
 * session is opened, and a POST must be JSON within `LIMITS.bodyBytes`. Routes, under `<base>/<key 1>/…/<key n>`:
 *
 *   POST submit                 `SubmitBody`; 202 `Accepted`
 *   POST turn                   `SubmitBody`; submit, then the turn's pages as a stream (the optional wrapper)
 *   GET  events?after=          session follow, a stream; with `wait=<seconds>`, one JSON `SessionPage`
 *   GET  turns/<id>?conversation=          `TurnStatus`
 *   GET  turns/<id>/events?after=&conversation=   follow, a stream; `Last-Event-ID` stands in for `after`; with
 *                               `wait=<seconds>`, one JSON `TurnPage`
 *   POST turns/<id>/abort       `AbortBody`; the turn's `TurnStatus`
 *
 * Streams are SSE, or NDJSON when the request accepts `application/x-ndjson`. A page request (`wait=<seconds>`) reads
 * until a page has news or the turn ends, at most `min(wait, LIMITS.pageWaitMs)`, then answers that one page and ends,
 * for a client that cannot read a stream. The edge sets no CORS headers.
 */
export function edge(options: EdgeOptions): Edge {
	if (!Number.isSafeInteger(options.keys) || options.keys < 1) throw new Error("edge: keys must be a whole number of at least 1");
	const handle = async (request: Request, context: Context): Promise<Response> => {
		const authenticated = await options.authenticate(request, context);
		if (authenticated === undefined) return answer(error("unauthorized", "regrant"));
		// Named fields only: nothing else authenticate returned reaches the host.
		const caller: Caller = { principal: authenticated.caller.principal, rights: authenticated.caller.rights };
		const credential = typeof authenticated.credential === "string" ? authenticated.credential : undefined;
		const url = new URL(request.url);
		const r = route(url.pathname, options);
		if (r === undefined) return answer(error("not_found"));
		if (request.method !== METHOD[r.op]) return answer(error("invalid_request"), 405, { allow: METHOD[r.op] });
		if (authenticated.harness !== undefined && authenticated.harness !== harnessIdOf(r.scope)) return answer(error("forbidden"));
		if (!(await options.authorize(caller, r.scope, context))) return answer(error("forbidden"));
		let body: unknown;
		if (request.method === "POST") {
			// JSON only: a browser's cross-site form post cannot send it without a preflight.
			if (!isJson(request.headers.get("content-type"))) return answer(error("invalid_request"), 415);
			const read = await readJson(request, LIMITS.bodyBytes);
			if ("status" in read) return answer(error(read.status === 413 ? "too_large" : "invalid_request"));
			body = read.value;
		}
		const query = url.searchParams.get("conversation");
		if (query !== null && !/^[1-9]\d{0,14}$/.test(query)) return answer(error("not_found"));
		const conversation = query === null ? undefined : Number(query);
		const after = url.searchParams.get("after") || request.headers.get("last-event-id") || undefined;
		const ndjson = (request.headers.get("accept") ?? "").includes("application/x-ndjson");
		const wait = r.op === "follow" || r.op === "session" ? pageWait(url) : undefined;
		if (wait === false) return answer(error("invalid_request"));
		const session = await options.session(r.scope, context);

		switch (r.op) {
			case "submit":
			case "turn": {
				const submit = submitBody(body);
				if (submit === undefined) return answer(error("invalid_request"));
				const submitOptions: SubmitOptions = {
					...(submit.whenBusy === undefined ? {} : { whenBusy: submit.whenBusy }),
					...(submit.conversation === undefined ? {} : { conversation: submit.conversation }),
					...(credential === undefined ? {} : { credential }),
				};
				const result = await session.submit(caller, submit.requestId, submit.text, submitOptions, context);
				if (r.op === "submit" || result.t !== "accepted") return answer(result);
				const opening: Frame = { event: "accepted", data: result };
				return follow(ndjson, [opening], turnPages(session, caller, result.requestId, result.conversation, undefined), context);
			}
			case "status":
				return answer(await session.status(caller, r.requestId!, context, conversation));
			case "abort": {
				const abort = abortBody(body);
				if (abort === undefined) return answer(error("invalid_request"));
				return answer(await session.abort(caller, r.requestId!, abort.abortId, context, abort.conversation));
			}
			case "follow":
				if (wait !== undefined)
					return page((cursor, waitMs, c) => session.follow(caller, r.requestId!, { ...(cursor === undefined ? {} : { after: cursor }), ...(conversation === undefined ? {} : { conversation }), waitMs }, c), after, wait, withAbortSignal(request.signal, context));
				return follow(ndjson, [], turnPages(session, caller, r.requestId!, conversation, after), context);
			case "session":
				if (wait !== undefined)
					return page((cursor, waitMs, c) => session.followSession(caller, { ...(cursor === undefined ? {} : { after: cursor }), waitMs }, c), after, wait, withAbortSignal(request.signal, context));
				return follow(ndjson, [], sessionPages(session, caller, after), context);
		}
	};
	return async (request, context = BACKGROUND_CONTEXT) => {
		try {
			return await handle(request, context);
		} catch {
			// An error's text may hold anything the request carried, its credential included: answer with none of it.
			return answer(error("unavailable", "reattach"));
		}
	};
}

/**
 * Authentication by one service token, for a server that calls the edge on its users' behalf. The token needs at least
 * 32 characters and is compared in constant time (K1-I10); every request that presents it acts as `caller`. `scope` is
 * the one scope the token may act in, or `"any"`, which a product must choose by name. No header names the principal.
 */
export function bearerToken(options: { readonly token: string; readonly caller: Caller; readonly scope: Scope | "any" }): Pick<EdgeOptions, "authenticate" | "authorize"> {
	const { token, caller, scope } = options;
	if (typeof token !== "string" || token.length < MIN_TOKEN_CHARS) throw new Error(`bearerToken: a token needs at least ${MIN_TOKEN_CHARS} characters`);
	if (scope !== "any" && (typeof scope !== "object" || scope === null)) throw new Error('bearerToken: scope must be a scope or "any"');
	const allowed = scope === "any" ? undefined : harnessIdOf(scope);
	return {
		async authenticate(request) {
			const header = request.headers.get("authorization") ?? "";
			const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
			return (await sameToken(presented, token)) ? { caller } : undefined;
		},
		authorize: (_caller, requested) => allowed === undefined || harnessIdOf(requested) === allowed,
	};
}

const KLEYA_RIGHTS: readonly Right[] = ["read", "submit", "steer", "cancel"];

/**
 * Authentication by session grant (spec 5.3.1): the `Authorization: Bearer` header carries a grant that `verifyGrant`
 * accepts. The caller is the grant's `sub`, and its rights are those of Kleya's rights the grant holds that `authorize`
 * allows in the grant's own Harness, so the directory's tenant and issuer and the grant's expiry are checked on every
 * request. A product's own rights stay out of the caller. The edge refuses every Harness but the grant's `hid`, and a
 * caller left with no right is refused before a session opens.
 */
export function grantAuth(options: {
	readonly keys: IssuerKeyStore;
	readonly audience: string;
	readonly directory: HarnessDirectory;
	readonly isRevoked?: (jti: string) => boolean | Promise<boolean>;
	/** Seconds since the epoch. Defaults to the wall clock. */
	readonly now?: () => number;
}): Pick<EdgeOptions, "authenticate" | "authorize"> {
	const { keys, audience, directory, isRevoked } = options;
	const now = options.now ?? (() => Math.floor(Date.now() / 1000));
	return {
		async authenticate(request) {
			const header = request.headers.get("authorization") ?? "";
			if (!header.startsWith("Bearer ")) return undefined;
			const verified = await verifyGrant(header.slice(7), { keys, audience, now, ...(isRevoked === undefined ? {} : { isRevoked }) });
			if (!verified.ok || verified.grant.sub.startsWith("host:")) return undefined;
			const principal = principalOf(verified.grant);
			const at = now();
			const rights = KLEYA_RIGHTS.filter((right) => authorize(principal, principal.hid, right, directory, at).ok);
			return { caller: { principal: principal.sub, rights }, harness: principal.hid };
		},
		authorize: (caller) => caller.rights.length > 0,
	};
}
