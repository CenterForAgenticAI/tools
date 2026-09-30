import { describe, expect, it } from "vitest";
import {
	classifyFailure,
	providerErrorCodeFromMessage,
	type ProviderFailureSignal,
} from "../src/error-classification.js";

const CANARY = "sk-ant-SUPER-SECRET-CANARY";

describe("providerErrorCodeFromMessage", () => {
	it.each(["rate_limit_error", "overloaded_error"])(
		"projects an Anthropic SSE %s into the bounded rate_limit code",
		(providerErrorType) => {
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
			expect(code).toBe("rate_limit");
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
		[{ httpStatus: 403 }, "permission", "cooldown-and-route"],
		[{ code: "insufficient_permissions" }, "permission", "cooldown-and-route"],
		[{ code: "model_not_found" }, "config", "route-without-retry"],
		[{ transportKind: "socket-reset" }, "transport", "cooldown-and-route"],
		[{ httpStatus: 503 }, "transport", "cooldown-and-route"],
		[{}, "unknown", "cooldown-and-route"],
	] as const)("classifies structured signal %#", (signal, category, action) => {
		expect(classifyFailure(signal)).toMatchObject({
			category,
			accountAction: action,
		});
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
