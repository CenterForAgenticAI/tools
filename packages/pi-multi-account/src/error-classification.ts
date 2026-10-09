import type { CooldownReason, NumericServerHint } from "./runtime-state.js";

export const PROVIDER_ERROR_CODES = [
	"rate_limit",
	"quota_exhausted",
	"invalid_api_key",
	"invalid_token",
	"token_expired",
	"token_revoked",
	"oauth_refresh_rejected",
	"oauth_service_unavailable",
	"insufficient_permissions",
	"model_not_found",
	"unsupported_api_version",
	"invalid_request",
	"refusal",
	"unknown_stop",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export const TRANSPORT_FAILURE_KINDS = [
	"connection-timeout",
	"dns-failure",
	"socket-reset",
	"incomplete-response",
] as const;
export type TransportFailureKind = (typeof TRANSPORT_FAILURE_KINDS)[number];

/**
 * A deliberately narrow, structured projection of an upstream failure. Raw
 * errors, messages, headers, request/response bodies, and credentials must be
 * sanitized/parsed before crossing this boundary.
 */
export interface ProviderFailureSignal {
	readonly httpStatus?: number;
	readonly code?: ProviderErrorCode;
	/** Bounded model id from the current request, when the host exposes it. */
	readonly modelId?: string;
	readonly transportKind?: TransportFailureKind;
	readonly retryAfterSeconds?: number;
	readonly resetAtMs?: number;
}

export type FailureCategory =
	| "quota-rate-limit"
	| "terminal-auth"
	| "transient-auth"
	| "permission"
	| "config"
	| "transport"
	| "unknown";

export interface FailureClassification {
	readonly category: FailureCategory;
	readonly kind?: "refusal" | "unknown-stop";
	readonly accountAction:
		| "cooldown-and-route"
		| "invalidate-and-route"
		| "route-without-retry"
		| "retain-account";
	readonly cooldownReason?: CooldownReason;
	readonly serverHint?: NumericServerHint;
}

const RATE_LIMIT_CODES: ReadonlySet<ProviderErrorCode> = new Set([
	"rate_limit",
	"quota_exhausted",
]);
const TERMINAL_AUTH_CODES: ReadonlySet<ProviderErrorCode> = new Set([
	"invalid_api_key",
	"invalid_token",
	"token_expired",
	"token_revoked",
	"oauth_refresh_rejected",
]);
const CONFIG_CODES: ReadonlySet<ProviderErrorCode> = new Set([
	"model_not_found",
	"unsupported_api_version",
	"invalid_request",
]);

const STRUCTURED_PROVIDER_ERROR_CODES: Readonly<
	Record<string, ProviderErrorCode>
> = Object.freeze({
	rate_limit_error: "rate_limit",
	overloaded_error: "rate_limit",
	quota_exhausted: "quota_exhausted",
	authentication_error: "invalid_token",
	permission_error: "insufficient_permissions",
	not_found_error: "model_not_found",
	invalid_request_error: "invalid_request",
});

/**
 * Fixed, bounded messages emitted by pi-ai's Codex wrapper when the upstream
 * SSE error has no HTTP response event for extensions to observe. Keep this an
 * exact allowlist: arbitrary provider prose must never become routing state.
 * Sarrius independently treats `usage limit` as exhaustion; the narrower exact
 * projection here preserves that behavior without retaining the raw message.
 */
const CODEX_QUOTA_EXHAUSTED_MESSAGES: ReadonlySet<string> = new Set([
	"Codex error: The usage limit has been reached",
	"Codex error: The usage limit has been reached.",
]);

/**
 * Extracts a bounded, allow-listed provider error code from a structured SSE
 * error payload. Anthropic can open a stream with HTTP 200 and later emit
 * `event: error` whose JSON becomes `AssistantMessage.errorMessage`; without
 * this projection a real `rate_limit_error` is misclassified as unknown.
 *
 * JSON objects shaped as `{ type: "error", error: { type } }` are accepted.
 * The exact fixed Codex wrapper message for subscription exhaustion is also
 * projected because that SSE failure exposes no response status to extensions.
 * Raw messages, request ids, details, and credentials never cross the
 * classification boundary.
 *
 * The envelope is NOT always the whole string. Pi prefixes the HTTP status and
 * may wrap the result again after exhausting its retries, so the same upstream
 * rate limit arrives as any of:
 *
 *   {"type":"error",...}                                  (bare envelope)
 *   429 {"type":"error",...}                              (status-prefixed)
 *   Retry failed after 3 attempts: 429 {"type":"error",…}  (retry-wrapped)
 *
 * Parsing only the bare form silently lost the other two. Observed live on
 * 2026-08-05: four `429 {"type":"error","error":{"type":"rate_limit_error"}}`
 * messages classified as "transient or unknown", so `settleTurn` logged
 * `routing.advisory` and never switched account -- the exact failure this
 * projection exists to prevent, reintroduced by a leading `429 `.
 *
 * The scan therefore starts at the first `{`. Everything before it is Pi's own
 * framing, never provider content.
 */
export function providerErrorCodeFromMessage(
	errorMessage: unknown,
): ProviderErrorCode | undefined {
	if (typeof errorMessage !== "string" || errorMessage.length === 0) {
		return undefined;
	}
	// Provider error envelopes are small. Refuse oversized/unbounded diagnostic
	// strings rather than parsing arbitrary assistant output.
	if (errorMessage.length > MAX_ENVELOPE_MESSAGE_LENGTH) return undefined;

	if (CODEX_QUOTA_EXHAUSTED_MESSAGES.has(errorMessage.trim())) {
		return "quota_exhausted";
	}

	const providerType = providerErrorEnvelopeType(errorMessage);
	// The type is provider-supplied. An own-property lookup keeps an inherited
	// name such as `constructor` or `__proto__` from resolving to a function or
	// object and flowing on as a code.
	return providerType !== undefined &&
		Object.hasOwn(STRUCTURED_PROVIDER_ERROR_CODES, providerType)
		? STRUCTURED_PROVIDER_ERROR_CODES[providerType]
		: undefined;
}

const MAX_ENVELOPE_MESSAGE_LENGTH = 4_096;

/**
 * Parses the provider error envelope described above and returns its raw
 * `error.type` string, or `undefined` when the message carries no envelope.
 * The result is provider-supplied: callers must match it against a closed
 * list before keeping it.
 */
function providerErrorEnvelopeType(errorMessage: unknown): string | undefined {
	if (typeof errorMessage !== "string" || errorMessage.length === 0) {
		return undefined;
	}
	if (errorMessage.length > MAX_ENVELOPE_MESSAGE_LENGTH) return undefined;

	const envelopeStart = errorMessage.indexOf("{");
	if (envelopeStart < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(errorMessage.slice(envelopeStart));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const envelope = parsed as Record<string, unknown>;
	if (envelope.type !== "error") return undefined;
	if (typeof envelope.error !== "object" || envelope.error === null) {
		return undefined;
	}
	const providerType = (envelope.error as Record<string, unknown>).type;
	return typeof providerType === "string" ? providerType : undefined;
}

/**
 * Anthropic error types kept as failure evidence. A closed list: a type the
 * provider invents, or one that merely resembles these, is dropped.
 */
export const ANTHROPIC_ERROR_TYPES = [
	"invalid_request_error",
	"authentication_error",
	"billing_error",
	"permission_error",
	"not_found_error",
	"rate_limit_error",
	"timeout_error",
	"api_error",
	"overloaded_error",
] as const;

export type AnthropicErrorType = (typeof ANTHROPIC_ERROR_TYPES)[number];

const ANTHROPIC_ERROR_TYPE_SET: ReadonlySet<string> = new Set(
	ANTHROPIC_ERROR_TYPES,
);

/**
 * Projects a provider error envelope onto the closed Anthropic error-type
 * list, with the same envelope rules as `providerErrorCodeFromMessage`. The
 * routing code map is deliberately not reused: it only holds the types that
 * route, and evidence needs the types that do not (`api_error`,
 * `timeout_error`, `billing_error`).
 */
export function providerErrorTypeFromMessage(
	errorMessage: unknown,
): AnthropicErrorType | undefined {
	const providerType = providerErrorEnvelopeType(errorMessage);
	return providerType !== undefined && ANTHROPIC_ERROR_TYPE_SET.has(providerType)
		? (providerType as AnthropicErrorType)
		: undefined;
}

/**
 * Upstream failures that arrive as fixed strings with no envelope. pi-ai
 * throws the first from a stream that ends without a stop reason; the Anthropic
 * SDK produces the other two. Exact match only: arbitrary provider prose never
 * becomes evidence.
 */
const UPSTREAM_FAILURE_MESSAGES = Object.freeze({
	"Anthropic stream ended without a stop reason": "no-stop-reason",
	"Connection error.": "connection-error",
	"Request timed out.": "request-timeout",
} as const);

export type UpstreamFailureKind =
	(typeof UPSTREAM_FAILURE_MESSAGES)[keyof typeof UPSTREAM_FAILURE_MESSAGES];

export function upstreamFailureKindFromMessage(
	errorMessage: unknown,
): UpstreamFailureKind | undefined {
	if (typeof errorMessage !== "string") return undefined;
	if (errorMessage.length > MAX_ENVELOPE_MESSAGE_LENGTH) return undefined;
	const text = errorMessage.trim();
	return Object.hasOwn(UPSTREAM_FAILURE_MESSAGES, text)
		? UPSTREAM_FAILURE_MESSAGES[text as keyof typeof UPSTREAM_FAILURE_MESSAGES]
		: undefined;
}

/**
 * Closed sub-reasons for a detected context overflow. They name which limit
 * the provider reported, so an operator knows whether to shorten the text or
 * drop media. `unknown` means the structured facts did not say.
 */
export const CONTEXT_OVERFLOW_REASONS = [
	"input-tokens",
	"request-bytes",
	"media-limit",
	"unknown",
] as const;

export type ContextOverflowReason = (typeof CONTEXT_OVERFLOW_REASONS)[number];

/**
 * Structured provider codes and envelope types that name an overflow limit.
 * `request_too_large` is Anthropic's HTTP 413 envelope type for the request
 * byte limit; the others are OpenAI error codes.
 */
const OVERFLOW_REASON_BY_CODE: Readonly<Record<string, ContextOverflowReason>> =
	Object.freeze({
		request_too_large: "request-bytes",
		context_length_exceeded: "input-tokens",
		image_too_large: "media-limit",
		image_file_too_large: "media-limit",
	});

function overflowReasonForCode(code: unknown): ContextOverflowReason | undefined {
	return typeof code === "string" && Object.hasOwn(OVERFLOW_REASON_BY_CODE, code)
		? OVERFLOW_REASON_BY_CODE[code]
		: undefined;
}

function boundedStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
		? value
		: undefined;
}

/**
 * The HTTP status Pi writes directly before a provider error body, as in
 * `413 {...}`, `413: {...}` or `Retry failed after 3 attempts: 413 {...}`.
 * Only Pi's own framing before the first `{` is read, and the caller uses it
 * only when a provider error body follows.
 */
function errorBodyStatusPrefix(text: string): number | undefined {
	const bodyStart = text.indexOf("{");
	if (bodyStart < 0) return undefined;
	const match = /(?:^|[\s:])([1-5]\d\d):? $/.exec(text.slice(0, bodyStart));
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

interface OverflowErrorBody {
	readonly type?: string;
	readonly code?: string;
}

/**
 * The provider error body after Pi's framing: `{"error":{"type","code"}}`,
 * with an optional top-level `"type":"error"`. Anthropic's 413 body has no
 * top-level `type`, so the routing envelope parser does not accept it. Only
 * the two string fields are returned; callers match them against a closed list.
 */
function overflowErrorBody(text: string): OverflowErrorBody | undefined {
	const bodyStart = text.indexOf("{");
	if (bodyStart < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(bodyStart));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const body = parsed as Record<string, unknown>;
	if (body.type !== undefined && body.type !== "error") return undefined;
	if (typeof body.error !== "object" || body.error === null || Array.isArray(body.error)) return undefined;
	const error = body.error as Record<string, unknown>;
	const type = typeof error.type === "string" ? error.type : undefined;
	const code = typeof error.code === "string" ? error.code : undefined;
	if (type === undefined && code === undefined) return undefined;
	return { ...(type === undefined ? {} : { type }), ...(code === undefined ? {} : { code }) };
}

/**
 * Names which limit a detected context overflow hit, from structured facts
 * only: an HTTP status, the provider envelope's error type, or a provider
 * error code, each matched against a closed list. Provider prose is never
 * read for meaning and never returned. Facts that disagree, or no fact at
 * all, give `unknown` rather than a guess.
 *
 * Call this only after the overflow itself was detected. Anthropic reports a
 * token overflow as HTTP 400 `invalid_request_error`, so that pair names
 * `input-tokens` only in that context: it assumes a detected overflow with
 * that generic pair is a token overflow.
 */
export function contextOverflowReason(source: unknown): ContextOverflowReason {
	try {
		if (typeof source !== "object" || source === null) return "unknown";
		const fields = source as Record<string, unknown>;
		const text =
			typeof fields.errorMessage === "string"
				? fields.errorMessage
				: typeof fields.message === "string"
					? fields.message
					: undefined;
		const bounded = text !== undefined && text.length <= MAX_ENVELOPE_MESSAGE_LENGTH ? text : undefined;
		const body = bounded === undefined ? undefined : overflowErrorBody(bounded);
		// Text before a `{` is Pi's framing only when a real error body follows it.
		const status =
			boundedStatus(fields.httpStatus) ??
			boundedStatus(fields.status) ??
			(bounded === undefined || body === undefined ? undefined : errorBodyStatusPrefix(bounded));
		const reasons = new Set<ContextOverflowReason>();
		for (const code of [fields.code, body?.type, body?.code]) {
			const reason = overflowReasonForCode(code);
			if (reason !== undefined) reasons.add(reason);
		}
		if (status === 413) reasons.add("request-bytes");
		if (status === 400 && body?.type === "invalid_request_error") reasons.add("input-tokens");
		const [only, ...rest] = [...reasons];
		return only !== undefined && rest.length === 0 ? only : "unknown";
	} catch {
		return "unknown";
	}
}

function numericServerHint(
	signal: ProviderFailureSignal,
): NumericServerHint | undefined {
	const retryAfterSeconds =
		typeof signal.retryAfterSeconds === "number" &&
		Number.isSafeInteger(signal.retryAfterSeconds) &&
		signal.retryAfterSeconds >= 0
			? signal.retryAfterSeconds
			: undefined;
	const resetAtMs =
		typeof signal.resetAtMs === "number" &&
		Number.isFinite(signal.resetAtMs) &&
		signal.resetAtMs >= 0
			? signal.resetAtMs
			: undefined;
	if (retryAfterSeconds === undefined && resetAtMs === undefined)
		return undefined;
	return {
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		...(resetAtMs === undefined ? {} : { resetAtMs }),
	};
}

function hasCode(
	signal: ProviderFailureSignal,
	codes: ReadonlySet<ProviderErrorCode>,
): boolean {
	return signal.code !== undefined && codes.has(signal.code);
}

function isRateLimited(signal: ProviderFailureSignal): boolean {
	return signal.httpStatus === 429 || hasCode(signal, RATE_LIMIT_CODES);
}

function isTerminalAuth(signal: ProviderFailureSignal): boolean {
	return signal.httpStatus === 401 || hasCode(signal, TERMINAL_AUTH_CODES);
}

function isPermissionFailure(signal: ProviderFailureSignal): boolean {
	return (
		signal.code === "insufficient_permissions" || signal.httpStatus === 403
	);
}

function isTransportFailure(signal: ProviderFailureSignal): boolean {
	if (signal.transportKind !== undefined) return true;
	return signal.httpStatus !== undefined && signal.httpStatus >= 500;
}

function cooldown(
	category: FailureCategory,
	cooldownReason: CooldownReason,
	signal: ProviderFailureSignal,
): FailureClassification {
	const serverHint = numericServerHint(signal);
	return {
		category,
		accountAction: "cooldown-and-route",
		cooldownReason,
		...(serverHint === undefined ? {} : { serverHint }),
	};
}

/** Classifies from structured status/code/type only; error.message is never inspected. */
export function classifyFailure(
	signal: ProviderFailureSignal,
): FailureClassification {
	if (isRateLimited(signal)) {
		return cooldown("quota-rate-limit", "rate-limit", signal);
	}

	if (isTerminalAuth(signal)) {
		return { category: "terminal-auth", accountAction: "invalidate-and-route" };
	}

	if (signal.code === "oauth_service_unavailable") {
		return cooldown("transient-auth", "auth-transient", signal);
	}

	if (isPermissionFailure(signal)) {
		return cooldown("permission", "permission", signal);
	}

	if (hasCode(signal, CONFIG_CODES)) {
		return { category: "config", accountAction: "route-without-retry" };
	}

	if (signal.code === "refusal" || signal.code === "unknown_stop") {
		return {
			category: "unknown",
			kind: signal.code === "refusal" ? "refusal" : "unknown-stop",
			accountAction: "retain-account",
		};
	}

	if (isTransportFailure(signal)) {
		return cooldown("transport", "transport", signal);
	}

	return cooldown("unknown", "unknown", signal);
}
