/**
 * The retry seam shared by extension-owned model calls.
 *
 * Pi 0.84.2 uses three retries and a 2,000 ms base delay by default. Those
 * values are documented here because Pi's public ExtensionContext does not
 * expose its SettingsManager. A host-visible retry object wins when available.
 */

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOrphanedToolResultRejection } from "./history-integrity.js";
import {
	assistantResponseForLlmError,
	ContextOverflowRecoveryExhaustedError,
	runWithContextOverflowRecovery,
} from "./overflow-recovery.js";

export interface TransientRetryPolicy {
	/** Total attempts, including the initial call. */
	maxAttempts: number;
	/** Base delay before the first retry; later delays double. */
	baseDelayMs: number;
	/** Which source supplied the values. */
	source: "pi-settings" | "documented-default";
}

export interface TransientRetryOptions<T> {
	operation: string;
	primary: () => Promise<T>;
	reduced?: () => Promise<T>;
	fallback?: {
		model: string;
		run: () => Promise<T>;
	} | null;
	onRecovery?: (event: {
		operation: string;
		stage: "reduced-payload" | "fallback-model";
		message: string;
		error: unknown;
		fallbackModel?: string;
	}) => void;
	signal?: AbortSignal;
}

type ReadableRetrySettings = {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
};

/**
 * This is Pi's documented 0.84.2 default: maxRetries=3 and baseDelayMs=2000.
 * maxAttempts includes the initial request, so the total is four attempts.
 */
const DOCUMENTED_DEFAULT_POLICY: TransientRetryPolicy = {
	maxAttempts: 4,
	baseDelayMs: 2_000,
	source: "documented-default",
};
// A host may expose an invalidly large delay; keep one retry wait bounded.
const MAX_RETRY_DELAY_MS = 30_000;

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

// Kept in step with pi-ai 0.84.2's RETRYABLE_PROVIDER_ERROR_PATTERN. The
// wrapper receives an Error after the call sites convert AssistantMessage
// failures, so this is the Error-path equivalent of pi-ai's classifier.
const RETRYABLE_PROVIDER_ERROR_PATTERN = /overloaded|rate.?limit|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

function retryableErrorMessage(error: unknown): string | null {
	if (typeof error === "string") return error;
	if (error instanceof Error) return `${error.name}\n${error.message}`;
	if (!error || typeof error !== "object") return null;
	const value = error as Record<string, unknown>;
	const messages = [value.errorMessage, value.message].filter((entry): entry is string => typeof entry === "string");
	return messages.length > 0 ? messages.join("\n") : null;
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	const message = retryableErrorMessage(error);
	return message !== null && /\babort(?:ed|ing)?\b|\bcancelled?\b/i.test(message);
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Request was aborted");
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	if (delayMs <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal!));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function rethrowTransientFailure(error: unknown, attempts: number, exhausted: boolean): never {
	if (!exhausted) throw error;
	const suffix = ` (after ${attempts} ${attempts === 1 ? "attempt" : "attempts"})`;
	if (error instanceof Error) {
		if (!error.message.endsWith(suffix)) error.message = `${error.message}${suffix}`;
		throw error;
	}
	throw new Error(`${String(error)}${suffix}`, { cause: error });
}

/**
 * Resolve Pi retry settings when a host makes them visible through the context.
 * The current public context does not, so the documented Pi default is normal.
 */
export function resolveTransientRetryPolicy(ctx: ExtensionContext): TransientRetryPolicy {
	try {
		const candidate = ctx as unknown as {
			settings?: { retry?: ReadableRetrySettings };
			settingsManager?: { getRetrySettings?: () => ReadableRetrySettings | undefined };
		};
		const settings = candidate.settingsManager?.getRetrySettings?.() ?? candidate.settings?.retry;
		if (settings) {
			const maxRetries = Number.isFinite(settings.maxRetries) ? Math.max(0, Math.floor(settings.maxRetries ?? 0)) : 0;
			const baseDelayMs = Number.isFinite(settings.baseDelayMs) ? Math.max(0, settings.baseDelayMs ?? 0) : 0;
			return {
				maxAttempts: settings.enabled === false ? 1 : 1 + maxRetries,
				baseDelayMs,
				source: "pi-settings",
			};
		}
	} catch {
		// A stale or host-specific context must not make a model call fail here.
	}
	return { ...DOCUMENTED_DEFAULT_POLICY };
}

/**
 * Run an extension-owned call with context-overflow recovery first, then
 * transient retry around the whole recovery operation. This keeps overflow's
 * reduced-payload and configured-fallback stages intact.
 */
export async function runWithTransientRetryRecovery<T>(
	options: TransientRetryOptions<T>,
	policy: TransientRetryPolicy,
): Promise<T> {
	const maxAttempts = Number.isFinite(policy.maxAttempts) ? Math.max(1, Math.floor(policy.maxAttempts)) : 1;
	const baseDelayMs = Number.isFinite(policy.baseDelayMs) ? Math.max(0, policy.baseDelayMs) : 0;
	let attempts = 0;
	while (true) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		attempts++;
		try {
			return await runWithContextOverflowRecovery(options);
		} catch (error) {
			const transient = isTransientFailure(error);
			if (!transient || options.signal?.aborted || attempts >= maxAttempts) {
				return rethrowTransientFailure(error, attempts, transient && attempts >= maxAttempts);
			}
			const delayMs = Math.min(baseDelayMs * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
			await waitForRetry(delayMs, options.signal);
		}
	}
}

/**
 * Classify an extension error using pi-ai's real-response helper when the
 * response survived errorFromLlmResponse, then its exact 0.84.2 pattern list
 * for bare Errors thrown by transports and stream implementations.
 */
export function isTransientFailure(error: unknown): boolean {
	if (error instanceof ContextOverflowRecoveryExhaustedError && error.latestWasOverflow) return false;
	if (isAbortError(error)) return false;
	const response = error instanceof Error ? assistantResponseForLlmError(error) : undefined;
	if (response && isRetryableAssistantError(response)) return true;
	const message = retryableErrorMessage(error);
	// An orphaned tool result is a malformed history, not a malformed request: the
	// history is repaired before every request now, so one more attempt can succeed
	// where treating this as terminal loses the whole session (issue #56).
	if (isOrphanedToolResultRejection(message)) return true;
	return message !== null
		&& !NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(message)
		&& RETRYABLE_PROVIDER_ERROR_PATTERN.test(message);
}
