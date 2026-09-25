/** Refusal and transient-failure classification shared by worker runners. */

export type WorkerErrorKind = "refusal" | "no-model-alternative";
export type WorkerRetryKind = "transient";

/**
 * Why a worker died, in terms an operator can act on without reading the
 * transcript (issues #469, #197).
 *
 * `errorKind` cannot answer this. It says what the runner did next -- it ran
 * out of distinct model alternatives -- and it says the same thing whether the
 * provider was out of quota, the message was a known transient fault, or the
 * worker harness produced nothing usable. Those need opposite responses, so the
 * cause is recorded separately from the consequence and never derived from the
 * error prose downstream, which `markNoModelAlternative` has already suffixed.
 *
 * `provider-capacity` is the only member so far because it is the only one
 * measured: of 120 sampled workers that died after at most one assistant turn
 * on 2026-09-15, 119 carried a provider usage-limit error and every wake said
 * `fork-failed`. Add a member when a cause is observed and classified, not to
 * fill out a taxonomy.
 */
export type WorkerFailureCause = "provider-capacity";

export function isWorkerFailureCause(value: unknown): value is WorkerFailureCause {
	return value === "provider-capacity";
}

export const CREDENTIAL_STORE_RETRY_MIN_DELAY_MS = 5_000;
export const CREDENTIAL_STORE_RETRY_MAX_DELAY_MS = 15_000;
export const CREDENTIAL_STORE_RETRY_TOTAL_CAP_MS = 75_000;
export const CREDENTIAL_STORE_LOCK_EXHAUSTED_MESSAGE =
	"Credential store remained locked after one bounded retry";

export interface CredentialRetryClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Mutable one-shot state allocated by the logical run/fork owner. */
export interface CredentialRetryBudget {
	readonly startedAtMs: number;
	readonly deadlineAtMs: number;
	readonly clock: CredentialRetryClock;
	readonly random: () => number;
	lockRetryConsumed: boolean;
	authRetryConsumed: boolean;
}

export function createCredentialRetryBudget(
	clock: CredentialRetryClock,
	random: () => number = Math.random,
): CredentialRetryBudget {
	const startedAtMs = clock.now();
	return {
		startedAtMs,
		deadlineAtMs: startedAtMs + CREDENTIAL_STORE_RETRY_TOTAL_CAP_MS,
		clock,
		random,
		lockRetryConsumed: false,
		authRetryConsumed: false,
	};
}

function credentialRetryAbortError(): Error {
	const error = new Error("Credential retry cancelled");
	error.name = "AbortError";
	return error;
}

/** Claim and wait the logical run's sole lock retry using full jitter. */
export async function waitForCredentialStoreLockRetry(
	budget: CredentialRetryBudget,
	signal: AbortSignal | undefined,
	onScheduled?: (delayMs: number) => void,
): Promise<boolean> {
	if (budget.lockRetryConsumed) return false;
	// Consume before any asynchronous boundary. A cancellation or deadline cannot
	// reset the monotonic latch and accidentally license a later second retry.
	budget.lockRetryConsumed = true;
	if (signal?.aborted) throw credentialRetryAbortError();
	const unit = Math.min(Math.max(budget.random(), 0), 1 - Number.EPSILON);
	const delayMs = CREDENTIAL_STORE_RETRY_MIN_DELAY_MS + Math.floor(
		unit * (CREDENTIAL_STORE_RETRY_MAX_DELAY_MS - CREDENTIAL_STORE_RETRY_MIN_DELAY_MS + 1),
	);
	if (budget.clock.now() + delayMs > budget.deadlineAtMs) return false;
	onScheduled?.(delayMs);

	let timer: unknown;
	let timerScheduled = false;
	let abortListener: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				callback();
			};
			abortListener = () => settle(() => reject(credentialRetryAbortError()));
			if (signal?.aborted) {
				abortListener();
				return;
			}
			signal?.addEventListener("abort", abortListener, { once: true });
			if (signal?.aborted) {
				abortListener();
				return;
			}
			timer = budget.clock.setTimeout(() => settle(resolve), delayMs);
			timerScheduled = true;
		});
		return true;
	} finally {
		if (timerScheduled) budget.clock.clearTimeout(timer);
		if (abortListener) signal?.removeEventListener("abort", abortListener);
	}
}

export function credentialRetryRemainingMs(budget: CredentialRetryBudget): number {
	return Math.max(0, budget.deadlineAtMs - budget.clock.now());
}

export function sanitizedProviderId(providerId: string | undefined): string {
	const sanitized = (providerId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
	return sanitized || "unknown";
}

export function sanitizedRouteAuthFailureMessage(providerId: string | undefined): string {
	return `Authentication failed for provider ${sanitizedProviderId(providerId)} after one refreshed request retry`;
}

export function sanitizedUnrefreshableRouteAuthFailureMessage(providerId: string | undefined): string {
	return `Authentication failed for provider ${sanitizedProviderId(providerId)}`;
}

/**
 * Guard for the retry-cause discriminant published on a terminal `RunResult`.
 * Set only where the runner already knows the underlying failure was
 * transient or a capacity limit; deliberately NOT set on the worker-harness
 * failure path, which shares `errorKind: "no-model-alternative"` but is not a
 * transient cause. Lives beside the type it guards.
 */
export function isWorkerRetryKind(value: unknown): value is WorkerRetryKind {
	return value === "transient";
}

export function formatNoModelAlternative(error: string, attemptedCount: number): string {
	const outcome = attemptedCount > 1
		? "all distinct model alternatives were exhausted"
		: "no distinct model alternative was available";
	return `${error} (no-model-alternative: ${outcome}; same-model retries are already exhausted)`;
}

const NON_MODEL_REFUSAL_PATTERNS: RegExp[] = [
	/\b(?:connect\s+)?ECONNREFUSED\b/i,
	/\bconnection\s+refused\b/i,
	/\buser\s+(?:refus(?:ed|es|ing)|declin(?:ed|es|ing))\s+(?:the\s+)?(?:confirmation|permission|approval)\s+prompt\b/i,
	/\b(?:confirmation|permission|approval)\s+prompt\s+(?:was\s+)?(?:refused|declined)\s+by\s+(?:the\s+)?user\b/i,
];

const REFUSAL_MESSAGE_PATTERNS: RegExp[] = [
	/\bthe\s+model\s+refused\s+to\s+complete\s+the\s+request\b/i,
	/\b(?:model|assistant|llm|response)\s+(?:has\s+)?refus(?:ed|es|ing)\s+to\s+(?:complete|comply|answer|respond|assist|help|fulfill|process)\b/i,
	/\b(?:model|assistant|llm|response)\s+refusal\b/i,
	/\brefusal\b.{0,80}\b(?:from|by)\s+(?:the\s+)?(?:model|assistant|llm)\b/i,
	/\bdeclin(?:ed|es|ing)\s+to\s+(?:complete|comply|answer|respond|assist|help|fulfill|process)\b/i,
	/\bdeclin(?:ed|es|ing)\b.{0,80}\b(?:request|safety|policy)\b/i,
	/\bsafety\s+classifier\b/i,
	/(?:^|[:\s])(?:Codex error:\s*)?This content was flagged for possible cybersecurity risk\.\s*If this seems wrong, try rephrasing your request\.\s*To get authorized for security work, join the Trusted Access for Cyber program\b/i,
	/\bstop[_ -]?(?:reason|details)\b.{0,120}\b(?:refusal|safety)\b/i,
	/\b(?:refusal|safety)\b.{0,120}\bstop[_ -]?(?:reason|details)\b/i,
	/\b(?:i|we)\s+(?:can't|cannot|won't|will\s+not)\s+(?:help|assist|comply|provide|answer)\s+(?:with\s+)?(?:that|this|the\s+request)\b/i,
];

// These patterns intentionally match complete, provider-specific diagnostics.
// Generic provider errors remain permanent because their retryability is
// ambiguous and a false positive would create an expensive retry loop.
const TRANSIENT_WORKER_FAILURE_PATTERNS: RegExp[] = [
	/^Codex error:\s*No tool call found for function call output with call_id\s+\S+$/i,
	/^Timed out waiting\s+\d+ms for agent session to become idle$/i,
	/^OpenAI Responses stream ended before a terminal response event$/i,
	/^Timed out waiting\s+\d+ms for agent session compaction to finish$/i,
	/^Worker tool-harness failure: subagent emitted tool calls as narrated text\b/i,
];

/**
 * The host has already exhausted its own lock retry when this reaches a worker.
 * Require both wrapper and cause so generic lock or credential failures remain
 * permanent; callers may then apply their single bounded retry budget.
 */
export function isCredentialStoreLockErrorMessage(message: string): boolean {
	const text = message.trim();
	return /\bCredential store (?:read|modify) failed\b[\s\S]{0,512}\bLock file is already being held\b/i.test(text);
}

/**
 * Auth-class failures that condemn one account, not one model.
 *
 * These stay excluded from isCapacityFailureMessage, which advances the whole
 * ladder: a bad credential is not a capacity signal, and treating it as one
 * would move a run onto a different model and hide the broken account. What
 * they license instead is narrower and is enforced by the caller, not here --
 * rolling to the next route inside the SAME rung, which is another account
 * serving the SAME model. A 401 on one account is evidence about that account
 * and says nothing about its siblings.
 *
 * That distinction only exists because a bare model ID now expands to several
 * credentialed routes (issue #262). While a rung was a single route, refusing
 * to advance was right, and the comment on isCapacityFailureMessage still
 * describes that case correctly for ladder-wide advancement.
 *
 * Matched against complete diagnostics only. A loose substring here would
 * silently reroute a genuine misconfiguration instead of reporting it.
 */
const ROUTE_AUTH_FAILURE_PATTERNS: RegExp[] = [
	/^No API key found for\s+"?[\w.-]+"?$/i,
	/^No API key for\s+\S+$/i,
	/(?:^|[:\s])401\s+\{[\s\S]*\}$/,
];

/**
 * Classify a failure as "this account cannot authenticate right now".
 *
 * Callers must only use this to select another route for the same model, and
 * must still terminate once the rung's routes are exhausted, so a genuinely
 * broken credential is reported rather than masked.
 */
export function isRouteAuthFailureMessage(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (ROUTE_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return true;

	// Fall back to the structured error type so a 401 reported under a
	// different status still classifies, without matching human-readable prose.
	const framed = STATUS_WITH_JSON_BODY.exec(text);
	if (!framed) return false;
	try {
		const body = JSON.parse(framed[2]!) as { error?: { type?: unknown } };
		return body?.error?.type === "authentication_error";
	} catch {
		return false;
	}
}

/** Classify a provider 401 that can benefit from one credential refresh. */
export function isRefreshableRouteAuthFailureMessage(message: string): boolean {
	const framed = STATUS_WITH_JSON_BODY.exec(message.trim());
	if (!framed || framed[1] !== "401") return false;
	try {
		const body = JSON.parse(framed[2]!) as { error?: { type?: unknown } };
		return body?.error?.type === "authentication_error";
	} catch {
		return false;
	}
}

/**
 * Providers report a spent quota as an ordinary turn error, so the only signal
 * available at classification time is the message itself: the persisted
 * assistant message carries a null `errorKind` for every observed failure,
 * including refusals, and `stopReason` is only ever `"error"` or `"aborted"`.
 *
 * Anthropic emits `<status> <json body>`, which is parsed structurally below
 * rather than matched as prose, so a reworded human message keeps classifying.
 * Codex emits a fixed string with no status and no body, so it is matched
 * literally.
 */
const CAPACITY_FAILURE_PATTERNS: RegExp[] = [
	// Issue #550. OpenRouter persists this plain diagnostic after Pi's same-model
	// retry budget, without an HTTP status or JSON envelope. The model slug is
	// the varying part, so match any leading `\S+` token rather than one model:
	// this is an OpenRouter routing condition, not a Luna-specific one, and every
	// model routed through OpenRouter can hit it. The distinctive wording and the
	// openrouter.ai integration URL stay load-bearing so arbitrary rate-limit
	// prose cannot advance a declared fallback ladder, and both anchors (`^\S+ `
	// at the start, the integration URL at the `$` end) reject quoted or reframed
	// text — a quote adds a trailing `"` past the URL and breaks the `$` anchor,
	// and prefixed narration breaks the `^\S+ is temporarily` anchor.
	/^\S+ is temporarily rate-limited upstream\. Please retry shortly, or add your own key to accumulate your rate limits: https:\/\/openrouter\.ai\/settings\/integrations$/,
	/(?:^|[:\s])Codex error:\s*The usage limit has been reached\.?$/i,
	// Issue #236. The retry instruction is load-bearing, not decoration: it is
	// the provider stating the condition is temporary, which is what lifts this
	// message out of the ambiguous-5xx category discussed below. A truncated
	// variant carrying no such statement stays permanent.
	//
	// Not anchored at the start, for the same reason as STATUS_WITH_JSON_BODY
	// below: by the time this classifier runs, pi has already spent its own
	// retry budget on the same model (see the chain documented on
	// isCapacityFailureMessage), and it re-frames what it gives up on. Every
	// occurrence in the evidence for #236 was the bare form, but an anchored
	// match would miss a re-framed one — which is the exact failure this arm
	// exists to prevent. The message text is still matched in full to its end,
	// so this remains a fixed-string match and never a loose substring: what
	// precedes it is pi's own framing, never provider or model content.
	/(?:^|[:\s])Codex error:\s*Our servers are currently overloaded\.\s*Please try again later\.?$/i,
];

/** Anthropic-style `"429 {\"type\":\"error\",...}"`: status, space, JSON body, with optional Pi framing. */
const STATUS_WITH_JSON_BODY = /(?:^|[^\d])(\d{3})\s+(\{[\s\S]*\})$/;

/**
 * Classify a provider failure that means "this route is out of capacity right
 * now" -- a rate limit or an exhausted usage allowance.
 *
 * Deliberately narrow. It matches only signals observed in real transcripts and
 * excludes several failures that a broader "provider error" rule would swallow:
 *
 * - `400 invalid_request_error` (prefill shape, oversized prompt) is permanent,
 *   and is by a wide margin the most common failure in practice.
 * - `404 not_found_error` means the alias cannot serve that model. Another
 *   account might, but it is not a capacity signal, so routing it here would
 *   conflate two different decisions.
 * - `401` is an auth/account-health problem. Advancing the model ladder cannot
 *   fix it and would mask it.
 * - `fetch failed` / `WebSocket error` are ambiguous transport faults that can
 *   equally be a local network blip, so advancing risks burning a second
 *   account on a client-side failure.
 * - A bare `5xx` is still omitted. The reasoning has been narrowed rather than
 *   withdrawn: a status alone says the request failed on the far side, not
 *   whether repeating it could succeed, and guessing is exactly the
 *   false-positive risk this file's policy warns about. What is classified is a
 *   message in which the provider *states* the condition is temporary and
 *   instructs a retry — the Codex overload arm above. That is a statement about
 *   retryability, so it is not a guess. Three samples, in #236.
 *
 * Aborts never reach here: callers gate on `isAbortLikeError` first, and a
 * user-initiated cancel must never consume a fallback rung.
 *
 * Where this sits in the chain, because it is not the first line of defence and
 * reading it as one leads to the wrong fix (#236 item 4):
 *
 * 1. Pi retries the turn itself. `isRetryableAssistantError` in pi-ai matches
 *    `overloaded`, `rate.?limit`, `429`, `5xx` and much else, and
 *    `AgentSession._prepareRetry` retries up to `retry.maxRetries` (default 3)
 *    with exponential backoff from `retry.baseDelayMs` (default 2000) — so 2s,
 *    4s, 8s on the same model. This package sees those attempts as the
 *    `auto_retry_start` / `auto_retry_end` events handled in `actor-activity.ts`.
 * 2. Only when that budget is spent does the error arrive here. So a message
 *    classified below has already failed four times on its own route, which is
 *    what makes advancing the ladder the proportionate response rather than an
 *    eager one.
 *
 * A same-model retry therefore already exists and is the host's job. Adding
 * another one here would retry a route that has just failed four times. What a
 * run without a declared `fallbackModels` lacks is not retries but an
 * alternative — two of the three runs in #236's evidence were in exactly that
 * position, and no widening of this predicate could have saved them. The open
 * question is consequently about dispatch, not classification: whether a run
 * dispatched with no ladder should be told so up front.
 */
export function isCapacityFailureMessage(message: string): boolean {
	const text = message.trim();
	if (!text) return false;
	if (CAPACITY_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return true;

	const framed = STATUS_WITH_JSON_BODY.exec(text);
	if (!framed) return false;
	if (framed[1] === "429") return true;

	// Fall back to the structured error type so a 429 reported under a different
	// status still classifies, without matching on human-readable prose.
	try {
		const body = JSON.parse(framed[2]) as { error?: { type?: unknown } };
		return body?.error?.type === "rate_limit_error";
	} catch {
		return false;
	}
}

/**
 * Name the actionable cause of a terminal worker failure, or return undefined
 * when the diagnostic does not identify one.
 *
 * Call this with the provider's OWN message, before `markNoModelAlternative`
 * suffixes it: the classifiers above match complete diagnostics to their end,
 * so a suffixed message no longer classifies. That is the same ordering trap
 * `classifyRecoveryTerminalResult` documents for `retryKind`.
 *
 * Returning undefined is the common and correct outcome. A cause is claimed
 * only when a narrow classifier already recognised the message, so this never
 * widens what counts as a capacity failure.
 */
export function classifyWorkerFailureCause(message: string): WorkerFailureCause | undefined {
	return isCapacityFailureMessage(message) ? "provider-capacity" : undefined;
}

/**
 * Classify only known, structurally transient worker diagnostics. This is
 * separate from model refusal classification so a model decline never enters
 * the transient fallback policy.
 */
export function isTransientWorkerErrorMessage(message: string): boolean {
	const text = message.trim();
	return text.length > 0 && (
		isCredentialStoreLockErrorMessage(text) ||
		TRANSIENT_WORKER_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
	);
}

/**
 * pi-ai maps Anthropic `stop_reason: "refusal"` to
 * `stopReason: "error"` plus an explanatory `errorMessage`. Classify only
 * that stopReason+message shape as a refusal so ordinary provider/runtime
 * failures keep their generic error handling.
 */
export function isRefusalErrorMessage(stopReason: string | undefined, message: string): boolean {
	if (stopReason !== "error") return false;
	const text = message.trim();
	if (!text) return false;
	if (NON_MODEL_REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return REFUSAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}
