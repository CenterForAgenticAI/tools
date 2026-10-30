import { describe, expect, it } from "vitest";
import {
	classifyFailure,
	ANTHROPIC_ERROR_TYPES,
	CONTEXT_OVERFLOW_REASONS,
	contextOverflowReason,
	providerErrorCodeFromMessage,
	providerErrorTypeFromMessage,
	upstreamFailureKindFromMessage,
	CODEX_ERROR_CODES,
	CODEX_FAILURE_KINDS,
	codexErrorCodeFromMessage,
	codexFailureKindFromMessage,
	type ProviderFailureSignal,
} from "../src/error-classification.js";

const CANARY = "sk-ant-SUPER-SECRET-CANARY";

describe("providerErrorCodeFromMessage", () => {
	it.each([
		["rate_limit_error", "rate_limit"],
		["overloaded_error", "overloaded"],
	] as const)(
		"projects an Anthropic SSE %s into the bounded %s code",
		(providerErrorType, expected) => {
			const message = JSON.stringify({
				type: "error",
				error: {
					details: null,
					type: providerErrorType,
					message: `Rate limited ${CANARY}`,
				},
				request_id: CANARY,
			});

			const code = providerErrorCodeFromMessage(message);
			expect(code).toBe(expected);
			expect(JSON.stringify(code)).not.toContain(CANARY);
		},
	);

	it.each([
		"not json",
		JSON.stringify({ type: "error", error: { type: "unknown_error" } }),
		JSON.stringify({ type: "message", error: { type: "rate_limit_error" } }),
		"x".repeat(4_097),
	])("rejects unstructured, unknown, or oversized diagnostics %#", (message) => {
		expect(providerErrorCodeFromMessage(message)).toBeUndefined();
	});

	it("projects the exact live Codex subscription-limit wrapper into bounded quota exhaustion", () => {
		const liveMessage = "Codex error: The usage limit has been reached";

		expect(providerErrorCodeFromMessage(liveMessage)).toBe("quota_exhausted");
		expect(
			providerErrorCodeFromMessage(`${liveMessage}: ${CANARY}`),
		).toBeUndefined();
	});

	it("classifies a status-prefixed and retry-wrapped rate limit envelope", () => {
		// Pi prefixes the HTTP status onto the provider envelope, and wraps the
		// result again once its own retries are exhausted. Parsing only the bare
		// envelope silently lost both forms.
		//
		// These two strings are verbatim from the operator's 2026-08-05 log, where
		// four of them were classified as "transient or unknown" -- so `settleTurn`
		// logged `routing.advisory` and never switched account, while a healthy
		// sibling sat idle.
		const statusPrefixed =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CdkCQMJu84ANgLsrsnrEM"}';
		expect(providerErrorCodeFromMessage(statusPrefixed)).toBe("rate_limit");

		const retryWrapped =
			'Retry failed after 3 attempts: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CdkCQMJu84ANgLsrsnrEM"}';
		expect(providerErrorCodeFromMessage(retryWrapped)).toBe("rate_limit");

		// The bare envelope must keep working.
		expect(
			providerErrorCodeFromMessage(
				'{"type":"error","error":{"type":"rate_limit_error"}}',
			),
		).toBe("rate_limit");

		// Prose that merely mentions a brace-less status is still not an envelope.
		expect(providerErrorCodeFromMessage("429 too many requests")).toBeUndefined();
	});
});

// Synthetic proxy data only; exercise the shared public projection.
const biliError = {
	type: "rate_limit_error", code: "bili_throttle_terminal", stage: "forward", retryable: false,
	message: `fixture ${CANARY}`, details: CANARY,
};
const biliEnvelope = JSON.stringify({ error: biliError, request_id: CANARY });

describe("BILI-TERMINAL-PROJECTION", () => {
	it.each(["", "424 ", "Error: 424 ", "Retry failed after 3 attempts: 424 ", "Retry failed after 3 attempts: Error: 424 "])(
		"projects only rate-limit metadata through supported framing %j", (prefix) => {
			const message = prefix + biliEnvelope;
			expect(providerErrorCodeFromMessage(message)).toBe("rate_limit");
			expect(providerErrorTypeFromMessage(message)).toBe("rate_limit_error");
			expect(classifyFailure({ code: providerErrorCodeFromMessage(message)! })).toEqual({
				category: "quota-rate-limit", accountAction: "cooldown-and-route", cooldownReason: "rate-limit",
			});
		},
	);

	it.each([
		{ ...biliError, type: "overloaded_error" },
		{ ...biliError, type: "constructor" },
		{ ...biliError, code: "rate_limit" },
		{ ...biliError, code: "__proto__" },
		{ ...biliError, stage: "retry" },
		{ ...biliError, retryable: true },
		{ ...biliError, retryable: "false" },
		{ code: "bili_throttle_terminal", stage: "forward", retryable: false },
		{ type: "rate_limit_error", code: "bili_throttle_terminal", stage: "forward" },
		{ type: "rate_limit_error", code: "bili_throttle_terminal", retryable: false },
		{ type: "rate_limit_error", stage: "forward", retryable: false },
		[], null, "rate_limit_error",
	])("rejects a missing or wrong terminal discriminator %#", (error) => {
		const message = `424 ${JSON.stringify({ error })}`;
		expect(providerErrorCodeFromMessage(message)).toBeUndefined();
		expect(providerErrorTypeFromMessage(message)).toBeUndefined();
	});

	it.each([
		`429 ${biliEnvelope}`, `1424 ${biliEnvelope}`, `prose ${biliEnvelope}`,
		`Error: 424 prose ${biliEnvelope}`, `[${biliEnvelope}]`, `424 ${biliEnvelope} trailing`,
		`424 ${biliEnvelope.slice(0, -1)}`, `424 ${JSON.stringify({ type: "message", error: biliError })}`,
		`424 ${JSON.stringify({ error: { __proto__: biliError } })}`,
		`424 {"__proto__":{"error":${JSON.stringify(biliError)}}}`,
		`424 ${JSON.stringify({ error: biliError, extra: "x".repeat(4096) })}`,
	])("rejects malformed, oversized, inherited, array or unsupported framing %#", (message) => {
		expect(providerErrorCodeFromMessage(message)).toBeUndefined();
		expect(providerErrorTypeFromMessage(message)).toBeUndefined();
	});

	it("ignores hostile extra fields rather than retaining or interpreting them", () => {
		const message = `424 {"error":${JSON.stringify(biliError)},"__proto__":{"type":"error"},"constructor":"${CANARY}"}`;
		expect(providerErrorCodeFromMessage(message)).toBe("rate_limit");
		expect(providerErrorTypeFromMessage(message)).toBe("rate_limit_error");
	});
});

const envelopeOf = (type: unknown) => JSON.stringify({ type: "error", error: { type, message: `fixture ${CANARY}` }, request_id: CANARY });

describe("SHAPE-ERROR-TYPE providerErrorTypeFromMessage", () => {
	it.each(ANTHROPIC_ERROR_TYPES)("keeps the documented envelope type %s", (type) => {
		const found = providerErrorTypeFromMessage(envelopeOf(type));
		expect(found).toBe(type);
		expect(JSON.stringify(found)).not.toContain(CANARY);
	});

	it("lists exactly the documented types, so a new one is a reviewed change", () => {
		expect([...ANTHROPIC_ERROR_TYPES].sort()).toEqual([
			"api_error", "authentication_error", "billing_error", "invalid_request_error", "not_found_error",
			"overloaded_error", "permission_error", "rate_limit_error", "timeout_error",
		]);
	});

	it("reads a status-prefixed or retry-wrapped envelope like the routing code does", () => {
		const body = envelopeOf("api_error");
		expect(providerErrorTypeFromMessage(`503 ${body}`)).toBe("api_error");
		expect(providerErrorTypeFromMessage(`Retry 2/3 after 1s: ${body}`)).toBe("api_error");
	});

	it.each([
		"constructor", "__proto__", "toString", "hasOwnProperty", "valueOf",
		"api_error ", "API_ERROR", "api_error\n", `api_error:${CANARY}`, "invented_error", "", " ",
	])("drops the unlisted type %j", (type) => {
		expect(providerErrorTypeFromMessage(envelopeOf(type))).toBeUndefined();
	});

	it.each([1, null, undefined, {}, [], true])("drops a non-string envelope type %j", (type) => {
		expect(providerErrorTypeFromMessage(envelopeOf(type))).toBeUndefined();
	});

	it.each([
		"not json",
		"",
		JSON.stringify({ type: "message", error: { type: "api_error" } }),
		JSON.stringify({ type: "error", error: "api_error" }),
		JSON.stringify({ type: "error", error: null }),
		JSON.stringify({ type: "error" }),
		`{"type":"error","error":{"type":"api_error"}${" ".repeat(4_100)}}`,
		"x".repeat(4_097),
	])("drops a message that is not a bounded error envelope %#", (message) => {
		expect(providerErrorTypeFromMessage(message)).toBeUndefined();
	});

	it("drops a non-string message without throwing", () => {
		for (const value of [undefined, null, 7, {}, [], () => "api_error"]) {
			expect(providerErrorTypeFromMessage(value as unknown as string)).toBeUndefined();
		}
	});
});

describe("SHAPE-PROTOTYPE providerErrorCodeFromMessage", () => {
	it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
		"returns no routing code for the inherited key %s", (type) => {
			expect(providerErrorCodeFromMessage(envelopeOf(type))).toBeUndefined();
		},
	);

	it("still returns the routing code for the listed types", () => {
		expect(providerErrorCodeFromMessage(envelopeOf("rate_limit_error"))).toBe("rate_limit");
		expect(providerErrorCodeFromMessage(envelopeOf("overloaded_error"))).toBe("overloaded");
	});
});

describe("SHAPE-UPSTREAM upstreamFailureKindFromMessage", () => {
	it.each([
		["Anthropic stream ended without a stop reason", "no-stop-reason"],
		["Connection error.", "connection-error"],
		["Request timed out.", "request-timeout"],
		["  Connection error.  ", "connection-error"],
	] as const)("names the exact upstream message %j as %s", (message, kind) => {
		expect(upstreamFailureKindFromMessage(message)).toBe(kind);
	});

	it.each([
		"", "connection error.", "Connection error", "Connection error. " + CANARY, "Request timed out",
		"Anthropic stream ended without a stop reason: " + CANARY, "constructor", "__proto__", "toString",
		"x".repeat(4_097),
	])("drops the near-miss or hostile message %j", (message) => {
		expect(upstreamFailureKindFromMessage(message)).toBeUndefined();
	});

	it("drops a non-string message without throwing", () => {
		for (const value of [undefined, null, 7, {}, [], () => "Connection error."]) {
			expect(upstreamFailureKindFromMessage(value as unknown as string)).toBeUndefined();
		}
	});
});

describe("SHAPE-CODEX codexFailureKindFromMessage", () => {
	// The fixed strings pi-ai's Codex and Responses paths produce, with invented tails.
	it.each([
		["Codex error: The usage limit has been reached", "codex-event-error"],
		["Codex error: server_error", "codex-event-error"],
		["Codex response failed", "codex-response-failed"],
		["Codex stream ended without a stop reason", "codex-no-stop-reason"],
		["Codex SSE response headers timed out after 30000ms", "codex-sse-header-timeout"],
		["OpenAI Responses stream ended before a terminal response event", "responses-no-terminal-event"],
		["OpenAI Responses stream completed with an unfinished tool call: fixture_tool (call_1)", "responses-unfinished-tool-call"],
		["Response incomplete: content_filter", "responses-incomplete"],
		["Response incomplete without a provider reason", "responses-incomplete"],
		["  Codex response failed  ", "codex-response-failed"],
	] as const)("names %j as %s", (message, kind) => {
		expect(codexFailureKindFromMessage(message)).toBe(kind);
	});

	it("maps every listed kind from at least one message", () => {
		const seen = new Set([
			"Codex error: x", "Codex response failed", "Codex stream ended without a stop reason",
			"Codex SSE response headers timed out after 1ms", "OpenAI Responses stream ended before a terminal response event",
			"OpenAI Responses stream completed with an unfinished tool call: t (c)", "Response incomplete: r",
		].map((message) => codexFailureKindFromMessage(message)));
		expect([...seen].sort()).toEqual([...CODEX_FAILURE_KINDS].sort());
	});

	it.each([
		"", "codex error: x", "Codex error:" + CANARY, "Codex error " + CANARY, "Codex response failed: " + CANARY,
		"Codex response failed.", "Codex SSE response headers timed out after ms", "Codex SSE response headers timed out after 30000ms " + CANARY,
		"Codex SSE response headers timed out after 1000000000000ms", CANARY + " Codex error: x", "OpenAI Responses stream ended",
		"constructor", "__proto__", "toString", "Codex error: " + "x".repeat(4_097),
	])("drops the near-miss or hostile message %j", (message) => {
		expect(codexFailureKindFromMessage(message)).toBeUndefined();
	});

	it("returns only the kind, never the text after the prefix", () => {
		const kind = codexFailureKindFromMessage("Codex error: " + CANARY);
		expect(kind).toBe("codex-event-error");
		expect(JSON.stringify({ kind })).not.toContain(CANARY);
	});

	it("drops a non-string message without throwing", () => {
		for (const value of [undefined, null, 7, {}, [], () => "Codex response failed"]) {
			expect(codexFailureKindFromMessage(value as unknown as string)).toBeUndefined();
		}
	});
});

describe("SHAPE-CODEX codexErrorCodeFromMessage", () => {
	it.each(CODEX_ERROR_CODES)("keeps the listed bare code %s after the event prefix", (code) => {
		expect(codexErrorCodeFromMessage(`Codex error: ${code}`)).toBe(code);
	});

	it.each([
		"Codex error: invented_code", "Codex error: " + CANARY, "Codex error: server_error " + CANARY,
		"Codex error: SERVER_ERROR", "Codex error: server_error.", "Codex error: The usage limit has been reached",
		"Codex error: constructor", "Codex error: __proto__", "server_error", "Codex response failed",
		"Response incomplete: server_error", "", "Codex error: ",
	])("drops %j", (message) => {
		expect(codexErrorCodeFromMessage(message)).toBeUndefined();
	});

	it("drops a non-string message without throwing", () => {
		for (const value of [undefined, null, 7, {}, [], () => "Codex error: server_error"]) {
			expect(codexErrorCodeFromMessage(value as unknown as string)).toBeUndefined();
		}
	});
});

describe("OVERFLOW-REASON contextOverflowReason", () => {
	const anthropic = (type: unknown) => JSON.stringify({ type: "error", error: { type, message: `fixture ${CANARY}` }, request_id: CANARY });
	// Anthropic's real 413 body has no top-level `type` (pi-ai's documented example).
	const bare = (type: unknown) => JSON.stringify({ error: { type, message: `fixture ${CANARY}` } });
	const openai = (code: unknown) => JSON.stringify({ error: { type: "invalid_request_error", code, message: `fixture ${CANARY}`, param: CANARY } });

	it("lists exactly the closed vocabulary, so a new reason is a reviewed change", () => {
		expect([...CONTEXT_OVERFLOW_REASONS]).toEqual(["input-tokens", "request-bytes", "media-limit", "unknown"]);
	});

	it.each([
		["an Anthropic 413 request_too_large", { message: `413 ${anthropic("request_too_large")}` }, "request-bytes"],
		["a retry-wrapped 413 request_too_large", { message: `Retry failed after 3 attempts: 413 ${anthropic("request_too_large")}` }, "request-bytes"],
		["a bare request_too_large envelope", { message: anthropic("request_too_large") }, "request-bytes"],
		["Anthropic's real 413 body with no top-level type", { errorMessage: `413 ${bare("request_too_large")}` }, "request-bytes"],
		["a retry-wrapped real 413 body", { errorMessage: `Retry failed after 3 attempts: 413 ${bare("request_too_large")}` }, "request-bytes"],
		["a real 413 body with no status", { errorMessage: bare("request_too_large") }, "request-bytes"],
		["a status-colon framed body", { errorMessage: `413: ${bare("api_error")}` }, "request-bytes"],
		["an OpenAI-style context_length_exceeded code in the body", { errorMessage: `400 ${openai("context_length_exceeded")}` }, "input-tokens"],
		["an OpenAI-style image_too_large code in the body", { errorMessage: openai("image_too_large") }, "media-limit"],
		["a structured HTTP 413", { httpStatus: 413, message: `fixture ${CANARY}` }, "request-bytes"],
		["an Anthropic 400 invalid_request_error", { message: `400 ${anthropic("invalid_request_error")}` }, "input-tokens"],
		["a structured 400 with an invalid_request_error envelope", { httpStatus: 400, message: anthropic("invalid_request_error") }, "input-tokens"],
		["a structured 413 with an Anthropic SDK status field", { status: 413, message: `fixture ${CANARY}` }, "request-bytes"],
		["a structured context_length_exceeded code", { code: "context_length_exceeded" }, "input-tokens"],
		["a structured image_too_large code", { code: "image_too_large" }, "media-limit"],
		["a structured image_file_too_large code", { code: "image_file_too_large", message: `fixture ${CANARY}` }, "media-limit"],
		["a 413 that agrees with its request_too_large envelope", { httpStatus: 413, errorMessage: `413 ${anthropic("request_too_large")}` }, "request-bytes"],
	] as const)("names %s", (_label, signal, reason) => {
		expect(contextOverflowReason(signal)).toBe(reason);
	});

	it.each([
		["no evidence", {}],
		["token prose with no envelope", { message: `prompt is too long: 213462 tokens > 200000 maximum ${CANARY}` }],
		["prose that names request_too_large", { message: `request_too_large: Request exceeds the maximum size ${CANARY}` }],
		["an invalid_request_error with no status", { message: anthropic("invalid_request_error") }],
		["an invalid_request_error with a non-400 status", { message: `500 ${anthropic("invalid_request_error")}` }],
		["a 400 with another type", { message: `400 ${anthropic("api_error")}` }],
		["a status digit run that is not framing", { message: `x400 ${anthropic("invalid_request_error")}` }],
		["a status before a brace that starts no envelope", { message: `upstream proxy said 413 {not json ${CANARY}` }],
		["a status before a JSON object that is not an error envelope", { message: `413 ${JSON.stringify({ detail: CANARY })}` }],
		["a status before an object whose error is not an object", { message: `413 ${JSON.stringify({ error: "request_too_large" })}` }],
		["a status before a message-typed object", { message: `413 ${JSON.stringify({ type: "message", error: { type: "api_error" } })}` }],
		["a body code that disagrees with its type", { errorMessage: `400 ${JSON.stringify({ error: { type: "request_too_large", code: "context_length_exceeded" } })}` }],
		["an inherited key as body code", { errorMessage: openai("__proto__") }],
		["a status that is not directly before the envelope", { message: `400 fixture ${anthropic("invalid_request_error")}` }],
		["disagreeing status and code", { httpStatus: 413, code: "context_length_exceeded" }],
		["disagreeing code and envelope", { code: "image_too_large", message: `413 ${anthropic("request_too_large")}` }],
		["an inherited key as code", { code: "__proto__" }],
		["an inherited key as type", { message: `400 ${anthropic("constructor")}` }],
		["a near-miss code", { code: "Request_Too_Large" }],
		["a hostile code", { code: CANARY }],
		["a non-string code", { code: 413 }],
		["a string status", { httpStatus: "413" }],
		["a fractional status", { httpStatus: 413.5 }],
		["an oversized message", { message: `413 ${anthropic("request_too_large")}${" ".repeat(4_100)}` }],
		["a non-string message", { message: { error: { type: "request_too_large" } } }],
	] as const)("answers unknown for %s, never a guess", (_label, signal) => {
		expect(contextOverflowReason(signal)).toBe("unknown");
	});

	it("answers unknown when reading a field throws", () => {
		const hostile = { get code(): never { throw new Error(CANARY); } };
		expect(contextOverflowReason(hostile)).toBe("unknown");
	});
});

describe("classifyFailure", () => {
	it.each([
		[{ httpStatus: 429 }, "quota-rate-limit", "cooldown-and-route"],
		[{ code: "quota_exhausted" }, "quota-rate-limit", "cooldown-and-route"],
		[{ httpStatus: 401 }, "terminal-auth", "invalidate-and-route"],
		[{ code: "token_revoked" }, "terminal-auth", "invalidate-and-route"],
		[
			{ code: "oauth_service_unavailable" },
			"transient-auth",
			"cooldown-and-route",
		],
		// A dispatch that could not resolve a credential may clear by itself
		// (issue #214): a bounded cooldown, never an invalidation.
		[
			{ code: "credential_unresolved" },
			"transient-auth",
			"cooldown-and-route",
		],
		[{ httpStatus: 403 }, "permission", "cooldown-and-route"],
		[{ code: "insufficient_permissions" }, "permission", "cooldown-and-route"],
		[{ code: "model_not_found" }, "config", "route-without-retry"],
		[{ code: "refusal" }, "unknown", "retain-account"],
		[{ code: "unknown_stop" }, "unknown", "retain-account"],
		[{ transportKind: "socket-reset" }, "transport", "cooldown-and-route"],
		[{ httpStatus: 503 }, "transport", "cooldown-and-route"],
		[{ code: "overloaded" }, "transport", "cooldown-and-route"],
		[{ httpStatus: 529, code: "overloaded" }, "transport", "cooldown-and-route"],
		[{}, "unknown", "cooldown-and-route"],
	] as const)("classifies structured signal %#", (signal, category, action) => {
		expect(classifyFailure(signal)).toMatchObject({
			category,
			accountAction: action,
		});
	});

	it("classifies overload as a transport cooldown, never a rate limit (internal issue #194)", () => {
		expect(classifyFailure({ code: "overloaded" })).toEqual({
			category: "transport",
			accountAction: "cooldown-and-route",
			cooldownReason: "transport",
		});
		// A real 429 stays a rate limit even with an overload code attached.
		expect(classifyFailure({ httpStatus: 429, code: "overloaded" }).category).toBe("quota-rate-limit");
	});

	it("classifies a refusal or unknown provider stop as retain-account without a cooldown", () => {
		for (const code of ["refusal", "unknown_stop"] as const) {
			const classification = classifyFailure({ code });
			expect(classification).toEqual({
				category: "unknown",
				kind: code === "refusal" ? "refusal" : "unknown-stop",
				accountAction: "retain-account",
			});
			expect(classification).not.toHaveProperty("cooldownReason");
		}
	});

	it("treats a single 401 as terminal but network/OAuth service failures as transient", () => {
		expect(classifyFailure({ httpStatus: 401 }).accountAction).toBe(
			"invalidate-and-route",
		);
		expect(
			classifyFailure({ transportKind: "connection-timeout" }).accountAction,
		).toBe("cooldown-and-route");
		expect(
			classifyFailure({ code: "oauth_service_unavailable" }).accountAction,
		).toBe("cooldown-and-route");
	});

	it("uses structured credential codes to disambiguate terminal auth from 403 permission", () => {
		expect(
			classifyFailure({ httpStatus: 403, code: "invalid_token" }).category,
		).toBe("terminal-auth");
		expect(classifyFailure({ httpStatus: 403 }).category).toBe("permission");
	});

	it("projects only bounded numeric server hints", () => {
		expect(
			classifyFailure({
				httpStatus: 429,
				retryAfterSeconds: 42,
				resetAtMs: 123_456,
			}),
		).toMatchObject({
			serverHint: { retryAfterSeconds: 42, resetAtMs: 123_456 },
		});
		expect(
			classifyFailure({
				httpStatus: 429,
				retryAfterSeconds: 42.5,
				resetAtMs: -1,
			}),
		).not.toHaveProperty("serverHint");
	});

	it("does not inspect or retain error messages, headers, bodies, or malicious canaries", () => {
		const hostile = {
			httpStatus: 500,
			modelId: "claude-opus-5",
			message: `Bearer ${CANARY}`,
			headers: { authorization: CANARY },
			requestBody: { prompt: CANARY },
			responseBody: { thinking: CANARY },
		} as unknown as ProviderFailureSignal;
		const classification = classifyFailure(hostile);
		expect(classification.category).toBe("transport");
		expect(JSON.stringify(classification)).not.toContain(CANARY);
		expect(Object.keys(classification)).not.toEqual(
			expect.arrayContaining([
				"message",
				"headers",
				"requestBody",
				"responseBody",
			]),
		);
	});
});
