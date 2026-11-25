/**
 * The emitter side of pi-memory's search log (caair/pi/pi-memory#25, spec section 1).
 *
 * Each `context_recall` call that may ask pi-memory gets one trace id. The id rides on every
 * `pi-memory:search` and `pi-memory:read` request the call emits, and after the call one
 * {@link RecallLogEvent} goes out on {@link RECALL_LOG_EVENT}, so pi-memory can join the
 * call to the searches and reads it caused. The event is fire and forget: no ack, no reply.
 * It is emitted on a later turn of the event loop, inside a try, so a slow, throwing or
 * absent listener never changes the call's result or how long it takes.
 *
 * Nothing is masked here: pi-memory masks the query before it writes the line. Every field
 * is bounded here so an oversize value never reaches the bus.
 */

import { randomBytes } from "node:crypto";

export const RECALL_LOG_EVENT = "pi-memory:recall-log";

/** The contract's limit on a trace id: at most 64 characters of [A-Za-z0-9_-]. */
export const TRACE_ID_MAX_CHARS = 64;
const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** Field bounds: ids 256, cwd 512, query 2000 (the writer's cut), short words 64. */
export const RECALL_LOG_MAX_ID_CHARS = 256;
export const RECALL_LOG_MAX_CWD_CHARS = 512;
export const RECALL_LOG_MAX_QUERY_CHARS = 2000;
export const RECALL_LOG_MAX_REF_CHARS = 512;
export const RECALL_LOG_MAX_WORD_CHARS = 64;
/** Counts and limits above this are logged as this. */
export const RECALL_LOG_MAX_COUNT = 1000;

export type RecallFallbackReason = "absent" | "timeout" | "unavailable" | "internal" | "bad_request" | "not_found" | "other";
const FALLBACK_REASONS: readonly string[] = ["absent", "timeout", "unavailable", "internal", "bad_request", "not_found"];

export interface RecallLogArgs {
	readonly query?: string;
	readonly mode?: string;
	readonly sessionRef?: string;
	readonly limit?: number;
	readonly scope?: string;
}

export interface RecallLogEvent {
	readonly v: 1;
	readonly traceId: string;
	readonly askingSessionId?: string;
	readonly cwd?: string;
	readonly tool: "context_recall";
	readonly args: RecallLogArgs;
	readonly outcome: "store" | "fallback" | "error";
	readonly fallbackReason?: RecallFallbackReason;
	readonly resultCount?: number;
	readonly tookMs: number;
}

export type RecallLogInput = Omit<RecallLogEvent, "v" | "tool">;

/** One trace id: 16 random bytes as lower-case hex. */
export function newTraceId(): string {
	return randomBytes(16).toString("hex");
}

/** Whether a value may be sent as a trace id; anything else is left out of a request, never rejected. */
export function isTraceId(value: unknown): value is string {
	return typeof value === "string" && TRACE_ID.test(value);
}

function cut(value: string | undefined, max: number): string | undefined {
	return value === undefined ? undefined : value.slice(0, max);
}

function count(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.min(Math.max(0, Math.floor(value)), RECALL_LOG_MAX_COUNT);
}

/**
 * The event as sent: named fields only, each bounded. An over-long asking session id is left
 * out rather than cut, since a cut id names a different session; free text is cut.
 */
export function recallLogEvent(input: RecallLogInput): RecallLogEvent {
	const { args } = input;
	const query = cut(args.query, RECALL_LOG_MAX_QUERY_CHARS);
	const mode = cut(args.mode, RECALL_LOG_MAX_WORD_CHARS);
	const sessionRef = cut(args.sessionRef, RECALL_LOG_MAX_REF_CHARS);
	const limit = count(args.limit);
	const scope = cut(args.scope, RECALL_LOG_MAX_WORD_CHARS);
	const cwd = cut(input.cwd, RECALL_LOG_MAX_CWD_CHARS);
	const resultCount = count(input.resultCount);
	const tookMs = Number.isFinite(input.tookMs) ? Math.min(Math.max(0, Math.round(input.tookMs)), 0xffff_ffff) : 0;
	return {
		v: 1,
		traceId: input.traceId.slice(0, TRACE_ID_MAX_CHARS),
		...(input.askingSessionId && input.askingSessionId.length <= RECALL_LOG_MAX_ID_CHARS ? { askingSessionId: input.askingSessionId } : {}),
		...(cwd ? { cwd } : {}),
		tool: "context_recall",
		args: {
			...(query !== undefined ? { query } : {}),
			...(mode !== undefined ? { mode } : {}),
			...(sessionRef !== undefined ? { sessionRef } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(scope !== undefined ? { scope } : {}),
		},
		outcome: input.outcome,
		...(input.fallbackReason !== undefined ? { fallbackReason: input.fallbackReason } : {}),
		...(resultCount !== undefined ? { resultCount } : {}),
		tookMs,
	};
}

/**
 * The fallback reason for a store outcome that was not an answer: the store's own error kind
 * when it is one of the contract's reasons, `absent` or `timeout` from the requester, and
 * `other` for everything else (an invalid reply, two replies, a listener that threw, a query
 * too long to send, an unknown error kind).
 */
export function fallbackReasonOf(status: string, error?: string): RecallFallbackReason {
	if (status === "absent") return "absent";
	if (status === "timeout") return "timeout";
	if (status === "error" && error !== undefined && FALLBACK_REASONS.includes(error)) return error as RecallFallbackReason;
	return "other";
}

/** The only event-bus capability the log needs. */
export interface RecallLogBus {
	emit(channel: string, data: unknown): void;
}

/**
 * Send one event after the current turn. Never throws, never delays the caller: a listener
 * runs on a later turn, and a bus that rethrows a listener's error is caught here.
 */
export function emitRecallLog(events: RecallLogBus, input: RecallLogInput): void {
	let event: RecallLogEvent;
	try {
		event = recallLogEvent(input);
	} catch {
		return;
	}
	setImmediate(() => {
		try {
			events.emit(RECALL_LOG_EVENT, event);
		} catch {
			// Fire and forget: the log never reaches the call.
		}
	});
}
