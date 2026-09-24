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
	readonly accountAction:
		| "cooldown-and-route"
		| "invalidate-and-route"
		| "route-without-retry";
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
	if (errorMessage.length > 4_096) return undefined;

	if (CODEX_QUOTA_EXHAUSTED_MESSAGES.has(errorMessage.trim())) {
		return "quota_exhausted";
	}

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
	if (typeof providerType !== "string") return undefined;
	return STRUCTURED_PROVIDER_ERROR_CODES[providerType];
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

	if (isTransportFailure(signal)) {
		return cooldown("transport", "transport", signal);
	}

	return cooldown("unknown", "unknown", signal);
}
