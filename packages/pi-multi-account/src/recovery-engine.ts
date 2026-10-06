import type {
	AssistantMessage,
	AssistantMessageEventStream,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isManagedFamily } from "./config.js";
import type { MultiAccountConfig } from "./config.js";
import {
	AcceptedOutputError,
	createAcceptedOutputStream,
	type AcceptedOutputErrorCode,
} from "./recovery-output.js";
import type { RecoveryActionKind, RecoveryCandidate } from "./recovery-plan.js";
import { classifyCodexRecoverySendEvidence } from "./recovery-send-evidence.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";

/** A request-owned timer. Cancelling it must prevent its callback from running. */
export interface RecoveryTimer {
	cancel(): void;
}

/** Monotonic time and timers are injected so recovery never depends on wall-clock sleeps. */
export interface RecoveryClock {
	now(): number;
	setTimer(delayMs: number, callback: () => void): RecoveryTimer;
}

export type RecoveryPreDispatchDecision =
	| { readonly status: "eligible" }
	| { readonly status: "skip" }
	| {
			readonly status: "terminate";
			readonly reason: "malformed-config" | "callback-failure";
	  };

export type RecoveryRetrySafety =
	| {
			readonly status: "recoverable";
			readonly action: "account";
			readonly reason:
				| "account-local-quota"
				| "account-local-auth"
				| "account-local-rate-limit"
				/**
				 * A network or transport failure, or a stall, before the attempt
				 * produced any output. Only valid while nothing has been observed;
				 * the engine converts it to `uncertain-external-effects` otherwise.
				 */
				| "pre-start-transient";
	  }
	| {
			readonly status: "model-policy";
			readonly reason: "structured-provider-error";
	  }
	| {
			readonly status: "unsafe";
			readonly reason:
				| "uncertain-external-effects"
				| "completed-tool"
				| "completed-call"
				| "agent-run"
				| "invalid-request"
				| "refusal"
				| "unknown";
	  };

export type RecoveryModelDecision =
	| {
			readonly status: "recoverable";
			readonly action: "model";
			readonly reason: "unsupported-model" | "unsupported-capability";
	  }
	| { readonly status: "none" };

/** Request options after recovery has replaced the provider's inner retry allowance. */
export type RecoveryBoundStreamOptions = SimpleStreamOptions & {
	readonly maxRetries: number;
};

/**
 * Every supported bounded provider invocation reserves one possibly charged
 * send. Pinned Codex non-SSE transport can reconnect or fall back internally,
 * and the vendored Google Antigravity stream ignores `maxRetries` and loops over
 * empty-response retries, runtime-model candidates and endpoint fallbacks, so
 * both counts are explicitly unknown and can never authorize another send.
 */
export type RecoverySendReservation =
	| {
			readonly maximumPossiblyChargedSends: 1;
			readonly basis: "bounded-provider-invocation";
	  }
	| {
			readonly maximumPossiblyChargedSends: "unknown";
			readonly basis: "codex-non-sse-unknown" | "antigravity-inner-unknown";
	  };

export interface RecoverySendReservationRequest {
	readonly ordinal: number;
	readonly candidate: RecoveryCandidate;
	readonly reservation: RecoverySendReservation;
}

/**
 * Post-attempt charge exposure never converts transport uncertainty to zero.
 * The bounded variant repeats the conservative pre-send upper bound; it is not
 * a claim that every reserved send was charged.
 */
export type RecoveryChargedSendExposure =
	| {
			readonly status: "bounded";
			readonly maximumPossiblyChargedSends: 1;
	  }
	| {
			readonly status: "unknown";
			readonly reason: "codex-non-sse-send-count" | "antigravity-inner-sends";
	  };

/**
 * One supported provider invocation. `retrySafety` must classify the final
 * outbound payload after caller payload replacement and every provider callback.
 * Recovery independently overrides that classification for non-SSE Codex
 * attempts unless `classifyCodexRecoverySendEvidence` proves a single
 * pre-execution rejection, because a socket send may have reconnected or fallen
 * back to SSE with uncertain external effects.
 */
export interface RecoveryPhysicalAttempt {
	readonly output: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
	readonly retrySafety: RecoveryRetrySafety | Promise<RecoveryRetrySafety>;
}

export interface RecoveryDispatchRequest {
	readonly candidate: RecoveryCandidate;
	readonly context: unknown;
	readonly options: RecoveryBoundStreamOptions;
	readonly signal: AbortSignal;
	/**
	 * Report bytes arriving on this attempt's connection, keep-alive pings
	 * included. It resets only the request's idle limit: transport activity is
	 * not output and never makes an attempt ineligible for recovery.
	 */
	readonly onTransportActivity: () => void;
}

export type RecoveryUsageCoverage =
	| {
			readonly coverage: "observed";
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly cacheReadTokens: number;
			readonly cacheWriteTokens: number;
			readonly totalTokens: number;
	  }
	| { readonly coverage: "gap" };

export type RecoveryCostCoverage =
	| { readonly coverage: "observed"; readonly amount: number }
	| { readonly coverage: "gap" };

export interface RecoveryAttemptAccounting {
	readonly ordinal: number;
	readonly candidate: RecoveryCandidate;
	/**
	 * `committed` means the attempt started streaming under
	 * `stream-after-first-content` publication and now belongs to the caller; its
	 * usage and cost are unknown here and the caller retains them at the
	 * physical terminal.
	 */
	readonly disposition: "failed" | "accepted" | "committed";
	readonly failureCode?: AcceptedOutputErrorCode | "dispatch-failure";
	readonly reservation: RecoverySendReservation;
	readonly chargedSendExposure: RecoveryChargedSendExposure;
	readonly usage: RecoveryUsageCoverage;
	readonly cost: RecoveryCostCoverage;
}

/**
 * Content-free structured projection of a failed terminal for model policy.
 *
 * The engine copies only these named fields; assistant content, thinking, tool
 * calls, error text, raw stop reasons, response identifiers, usage and
 * diagnostic messages/details never reach the hook. A policy must decide from
 * these structured facts alone and must never scan provider or assistant text.
 */
export interface RecoveryModelFailure {
	readonly stopReason: AssistantMessage["stopReason"];
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	/** Only whether the terminal carried an error message, never its text. */
	readonly hasErrorMessage: boolean;
	/** Diagnostic `type` identifiers only, in terminal order. */
	readonly diagnosticTypes: readonly string[];
	/**
	 * Structured provider stop code, copied only from the two-value allowlist.
	 * Absent for any other value; never derived from error or assistant text.
	 */
	readonly code?: "refusal" | "unknown_stop";
}

export interface RecoveryEngineDependencies {
	readonly clock: RecoveryClock;
	/** #129 owns this structured policy hook. Omission means no model recovery. */
	readonly classifyModelRecovery?: (
		failure: RecoveryModelFailure,
		signal: AbortSignal,
	) => RecoveryModelDecision | Promise<RecoveryModelDecision>;
	/** Re-read eligibility, live config authorization and credentials here. */
	readonly recheck: (
		candidate: RecoveryCandidate,
		signal: AbortSignal,
	) => RecoveryPreDispatchDecision | Promise<RecoveryPreDispatchDecision>;
	/** Reserve every possibly charged send before the provider can be invoked. */
	readonly reserve: (
		request: RecoverySendReservationRequest,
		signal: AbortSignal,
	) => "reserved" | "rejected" | Promise<"reserved" | "rejected">;
	readonly dispatch: (
		request: RecoveryDispatchRequest,
	) => RecoveryPhysicalAttempt | Promise<RecoveryPhysicalAttempt>;
	/** Every invoked physical attempt reaches this barrier exactly once. */
	readonly account: (
		attempt: RecoveryAttemptAccounting,
		signal: AbortSignal,
	) => "recorded" | "rejected" | Promise<"recorded" | "rejected">;
}

export type RecoveryTimingConfig = Pick<
	MultiAccountConfig,
	"recoveryIdleTimeoutMs" | "recoveryAbsoluteTimeoutMs"
>;

/**
 * How an attempt's output is published.
 *
 * `buffered` (the default) holds every event until a successful terminal, so a
 * failure at any point may still recover. `stream-after-first-content` holds
 * the attempt's leading `start` events, which a provider pushes as soon as the
 * response headers arrive and before any content: they are neither published
 * nor counted as progress. The first content event (text, thinking or a tool
 * call) commits the attempt and streams one held `start`, that event and the
 * rest of the attempt live to the caller with no further recovery. A terminal,
 * malformed or missing event, or a thrown failure, before any content falls
 * back to the buffered path, so it may still recover and a failed attempt's
 * held `start` is never published. A committed attempt is never retried, so
 * output already shown to a consumer is never followed by a second send.
 */
export type RecoveryPublication = "buffered" | "stream-after-first-content";

export interface RecoveryRequest {
	readonly candidates: readonly RecoveryCandidate[];
	readonly publication?: RecoveryPublication;
	readonly context: unknown;
	readonly options?: SimpleStreamOptions;
	readonly timing: RecoveryTimingConfig;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
}

export type RecoveryTerminationReason =
	| "caller-aborted"
	| "caller-deadline"
	| "idle-timeout"
	| "absolute-timeout"
	| "reload"
	| "shutdown"
	| "malformed-config"
	| "reservation-rejected"
	| "accounting-rejected"
	| "callback-failure"
	| "attempt-aborted"
	| "uncertain-external-effects"
	| "completed-tool"
	| "completed-call"
	| "agent-run"
	| "invalid-request"
	| "refusal"
	| "unknown";

export type RecoveryResult =
	| {
			readonly status: "accepted";
			readonly candidate: RecoveryCandidate;
			readonly attempts: number;
			readonly terminal: AssistantMessage;
			readonly output: AssistantMessageEventStream;
	  }
	| {
			/**
			 * The attempt produced content under `stream-after-first-content`
			 * publication. `output` yields its one held `start` (when it sent
			 * one), the first content event and then the rest of the physical
			 * stream unbuffered; the caller owns its terminal, timers and abort
			 * from here on.
			 */
			readonly status: "committed";
			readonly candidate: RecoveryCandidate;
			readonly attempts: number;
			readonly output: AsyncIterable<unknown>;
	  }
	| {
			readonly status: "exhausted";
			readonly attempts: number;
			readonly errorMessage: string;
	  }
	| {
			readonly status: "terminated";
			readonly reason: RecoveryTerminationReason;
			readonly attempts: number;
			readonly errorMessage: string;
	  };

export interface RecoveryEngine {
	recover(request: RecoveryRequest): Promise<RecoveryResult>;
	/** Abort active requests; later requests use the newly published generation. */
	reload(): void;
	/** Permanently stop this engine and abort every active request. */
	shutdown(): void;
}

type AwaitResult<T> =
	| { readonly status: "value"; readonly value: T }
	| { readonly status: "rejected" }
	| { readonly status: "aborted" };

interface AttemptFacts {
	readonly usage: RecoveryUsageCoverage;
	readonly cost: RecoveryCostCoverage;
}

interface ActiveRequest {
	readonly controller: AbortController;
	reason?: RecoveryTerminationReason;
}

const GAP_USAGE: RecoveryUsageCoverage = Object.freeze({ coverage: "gap" });
const GAP_COST: RecoveryCostCoverage = Object.freeze({ coverage: "gap" });

/**
 * One unified logical call owns at most two provider invocations: the initial
 * invocation plus one recovery invocation. Raising this value allows a third
 * invocation and must fail the named `RECOVERY-TWO-SEND-CAP` regression.
 *
 * For the bounded HTTP/SSE families (Anthropic, OpenAI, Codex SSE) inner
 * provider retries are forced to zero, so each invocation is one possibly
 * charged send and the call makes at most two sends. Both Anthropic
 * paths honour that zero: the adaptive adapter
 * (`src/anthropic-adaptive-stream.ts`) and the vendored pinned stream
 * (`packages/pi-anthropic-oauth/src/stream.ts`, local patch 0004) forward a
 * finite non-negative integer `maxRetries` into `client.messages.create`.
 *
 * A Codex non-SSE (auto/WebSocket) invocation has an unknown internal send
 * count: pinned pi-ai 0.84.4 may reconnect or fall back to SSE inside one
 * invocation. The engine therefore never uses such an invocation for the
 * recovery send, but it cannot control the internal count of a non-SSE initial
 * invocation. Consumers, including the production cutover, must not claim the
 * at-most-two-sends guarantee for Codex auto/WebSocket calls; only the
 * two-invocation bound holds there. Routed Codex calls are currently pinned to
 * SSE by `forceCodexSseOptions` (`src/codex-adapter.ts`), so a caller that
 * passes the forced options here receives the bounded-HTTP reservation.
 *
 * A Google Antigravity invocation also has an unknown internal send count: the
 * vendored stream (`packages/pi-antigravity/src/stream/stream.ts`) ignores
 * `maxRetries` and can send once per empty-response retry (up to three), runtime
 * model candidate, and `ENDPOINT_FALLBACKS` entry
 * (`packages/pi-antigravity/src/client/client.ts`, three endpoints). The engine
 * reserves it as unknown, never uses it for the recovery send, and terminates
 * with `uncertain-external-effects` after a failed initial Antigravity
 * invocation. Consumers must not claim the at-most-two-sends guarantee for
 * Antigravity calls; only the two-invocation bound holds there.
 */
export const RECOVERY_MAX_PROVIDER_SENDS_PER_CALL = 2 as const;

/**
 * Supported request-local retry controls. Keep every managed family's entry
 * separate: each provider path has its own compile-valid mutation control and
 * regression test. Anthropic's zero bounds both Anthropic paths: the adaptive
 * adapter (`ANTHROPIC-MAX-RETRIES-ZERO`) and the vendored pinned stream
 * (`ANTHROPIC-PINNED-MAX-RETRIES`) each forward this request-local `maxRetries`
 * into `client.messages.create`, so the SDK's two default retries never run.
 * Google Antigravity receives the same fail-closed zero, but its vendored stream
 * ignores it; its unknown inner send count is handled by the
 * `antigravity-inner-unknown` reservation instead (see
 * {@link RECOVERY_MAX_PROVIDER_SENDS_PER_CALL}).
 */
export const RECOVERY_INNER_RETRY_LIMITS = Object.freeze({
	anthropic: 0,
	openai: 0,
	"openai-codex": 0,
	"google-antigravity": 0,
}) satisfies Readonly<Record<RecoveryCandidate["family"], number>>;

function boundStreamOptions(
	candidate: RecoveryCandidate,
	options: SimpleStreamOptions | undefined,
): RecoveryBoundStreamOptions {
	return Object.freeze({
		...(options ?? {}),
		maxRetries: RECOVERY_INNER_RETRY_LIMITS[candidate.family],
	});
}

function sendReservationFor(
	candidate: RecoveryCandidate,
	options: RecoveryBoundStreamOptions,
): RecoverySendReservation {
	if (candidate.family === "openai-codex" && options.transport !== "sse") {
		// Pinned pi-ai 0.84.4 can resend `response.create` once for
		// previous_response_not_found, once for a connection-limit error, then fall
		// back to one SSE send (`dist/api/openai-codex-responses.js:214-245`), so one
		// invocation may make up to four sends. The supported terminal carries no
		// trustworthy complete count, so this invocation can never authorize a send.
		// Recovery cannot bound the internal sends of an initial non-SSE invocation
		// and never forces SSE; that measured limit remains open for the cutover.
		return Object.freeze({
			maximumPossiblyChargedSends: "unknown",
			basis: "codex-non-sse-unknown",
		});
	}
	if (candidate.family === "google-antigravity") {
		// The vendored stream ignores `maxRetries` and loops over empty-response
		// retries, runtime-model candidates and endpoint fallbacks inside one
		// invocation, so it can make several sends with no trustworthy count.
		return Object.freeze({
			maximumPossiblyChargedSends: "unknown",
			basis: "antigravity-inner-unknown",
		});
	}
	return Object.freeze({
		maximumPossiblyChargedSends: 1,
		basis: "bounded-provider-invocation",
	});
}

function chargedSendExposureFor(
	reservation: RecoverySendReservation,
): RecoveryChargedSendExposure {
	switch (reservation.basis) {
		case "codex-non-sse-unknown":
			return Object.freeze({ status: "unknown", reason: "codex-non-sse-send-count" });
		case "antigravity-inner-unknown":
			return Object.freeze({ status: "unknown", reason: "antigravity-inner-sends" });
		case "bounded-provider-invocation":
			return Object.freeze({ status: "bounded", maximumPossiblyChargedSends: 1 });
	}
}

/**
 * Content-free terminal error text for an exhausted or terminated recovery.
 *
 * Host retries count toward the same two-send cap. Pinned pi-coding-agent 0.84.4
 * `AgentSession._isRetryableError` (`dist/core/agent-session.js:2241-2246`)
 * restarts the turn when `isRetryableAssistantError` from
 * `@earendil-works/pi-ai/compat` matches the final `errorMessage`
 * (`pi-ai/dist/utils/retry.js:166-173`, patterns at `:4-77`), and its overflow
 * path compact-and-retries when `isContextOverflow` matches
 * (`agent-session.js:1652-1690`, `pi-ai/dist/utils/overflow.js:130-156`). A
 * production caller must surface this message, never a provider's own text, so
 * neither host path can add a third send. The named `HOST-RETRY-BOUNDARY`
 * regression checks both classifiers directly.
 */
export function buildBoundedRecoveryFinalErrorMessage(): string {
	return "Unified recovery stopped after its bounded provider attempt.";
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function projectAttemptFacts(value: unknown): AttemptFacts | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const usage = (value as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const record = usage as Record<string, unknown>;
	const inputTokens = finiteNonNegative(record.input);
	const outputTokens = finiteNonNegative(record.output);
	const cacheReadTokens = finiteNonNegative(record.cacheRead);
	const cacheWriteTokens = finiteNonNegative(record.cacheWrite);
	const totalTokens = finiteNonNegative(record.totalTokens);
	const cost =
		typeof record.cost === "object" && record.cost !== null
			? (record.cost as Record<string, unknown>)
			: undefined;
	const amount = finiteNonNegative(cost?.total);
	return {
		usage:
			inputTokens === undefined ||
			outputTokens === undefined ||
			cacheReadTokens === undefined ||
			cacheWriteTokens === undefined ||
			totalTokens === undefined
				? GAP_USAGE
				: Object.freeze({
						coverage: "observed",
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						totalTokens,
					}),
		cost:
			amount === undefined
				? GAP_COST
				: Object.freeze({ coverage: "observed", amount }),
	};
}

function terminalFromEvent(event: unknown): unknown {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	if (record.type === "done") return record.message;
	if (record.type === "error") return record.error;
	return undefined;
}

function assistantTerminal(value: unknown): AssistantMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const terminal = value as Partial<AssistantMessage>;
	return terminal.role === "assistant" &&
		Array.isArray(terminal.content) &&
		typeof terminal.api === "string" &&
		typeof terminal.provider === "string" &&
		typeof terminal.model === "string" &&
		typeof terminal.stopReason === "string" &&
		typeof terminal.timestamp === "number"
		? (terminal as AssistantMessage)
		: undefined;
}

/**
 * Assistant content a consumer would see. A provider's `start` event is not
 * here: it only reports that the response headers arrived, so it is held, never
 * counted as progress or output, and a failure after it is still pre-output.
 */
const PROGRESS_EVENT_TYPES = new Set([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

function isProgressEvent(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		PROGRESS_EVENT_TYPES.has((event as { type?: unknown }).type as string)
	);
}

/**
 * Whether an event is assistant content (text, thinking or a tool call). Only
 * content counts as output for in-call recovery; a `start` never does.
 */
export function isRecoveryContentEvent(event: unknown): boolean {
	return isProgressEvent(event);
}

/** Whether an event is the provider's `start`, held until the first content. */
export function isRecoveryStartEvent(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		(event as { type?: unknown }).type === "start"
	);
}

function observedOutput(
	upstream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
	onProgress: () => void,
	onTerminal: (terminal: AssistantMessage) => void,
	onFacts: (facts: AttemptFacts) => void,
): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			const source = await upstream;
			for await (const event of source) {
				if (isProgressEvent(event)) onProgress();
				const terminal = assistantTerminal(terminalFromEvent(event));
				if (terminal !== undefined) {
					onTerminal(terminal);
					const facts = projectAttemptFacts(terminal);
					if (facts !== undefined) onFacts(facts);
				}
				yield event;
			}
		},
	};
}

function validTiming(timing: RecoveryTimingConfig): boolean {
	return (
		Number.isFinite(timing.recoveryIdleTimeoutMs) &&
		timing.recoveryIdleTimeoutMs >= 1_000 &&
		Number.isFinite(timing.recoveryAbsoluteTimeoutMs) &&
		timing.recoveryAbsoluteTimeoutMs >= 1_000
	);
}

function cancelTimer(timer: RecoveryTimer | undefined): void {
	try {
		timer?.cancel();
	} catch {
		// Cleanup is best-effort after the request already owns its terminal result.
	}
}

function abortRequest(
	request: ActiveRequest,
	reason: RecoveryTerminationReason,
): void {
	if (request.reason !== undefined) return;
	request.reason = reason;
	request.controller.abort();
}

async function awaitRequest<T>(
	value: T | Promise<T>,
	request: ActiveRequest,
): Promise<AwaitResult<T>> {
	if (request.controller.signal.aborted) return { status: "aborted" };
	const operation = Promise.resolve(value);
	void operation.catch(() => {});
	let onAbort!: () => void;
	const aborted = new Promise<AwaitResult<T>>((resolve) => {
		onAbort = () => resolve({ status: "aborted" });
		request.controller.signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([
			operation.then(
				(result): AwaitResult<T> => ({ status: "value", value: result }),
				(): AwaitResult<T> => ({ status: "rejected" }),
			),
			aborted,
		]);
	} finally {
		request.controller.signal.removeEventListener("abort", onAbort);
	}
}

function validCandidate(candidate: RecoveryCandidate): boolean {
	return (
		typeof candidate.providerId === "string" &&
		candidate.providerId.length > 0 &&
		// The canonical managed-family set is the single source of truth here so a
		// future family addition cannot silently fall out of recovery consideration
		// the way the prior hand-listed three-family check did for Google Antigravity.
		isManagedFamily(candidate.family) &&
		// A caller-built candidate must name a canonical account of its own family,
		// so a mislabelled id can never borrow another family's send reservation.
		isCanonicalManagedProviderId(candidate.providerId, candidate.family) &&
		typeof candidate.modelId === "string" &&
		candidate.modelId.length > 0 &&
		(candidate.recoveryAction === "account" || candidate.recoveryAction === "model")
	);
}

function changesOnlyAuthorizedDimension(
	initial: RecoveryCandidate,
	candidate: RecoveryCandidate,
	action: RecoveryActionKind,
): boolean {
	return action === "account"
		? candidate.providerId !== initial.providerId && candidate.modelId === initial.modelId
		: candidate.modelId !== initial.modelId;
}

function observeLatePhysicalAttempt(
	pending: RecoveryPhysicalAttempt | Promise<RecoveryPhysicalAttempt>,
	signal: AbortSignal,
): void {
	void Promise.resolve(pending).then(
		(physical) => {
			if (typeof physical !== "object" || physical === null) return;
			try {
				void Promise.resolve(physical.retrySafety).catch(() => {});
			} catch {
				// A throwing accessor is contained like any other callback failure.
			}
			try {
				const output = createAcceptedOutputStream(physical.output, { signal });
				void output.result().catch(() => {});
			} catch {
				// A throwing accessor is contained like any other callback failure.
			}
		},
		() => {},
	);
}

/**
 * An attempt read up to its first event that is not a `start`. At most one
 * `start` is kept: a provider sends one, and a repeat carries nothing a
 * consumer needs.
 */
interface HeldPrefix {
	readonly iterator: AsyncIterator<unknown>;
	readonly held: readonly unknown[];
	/** The step after the held events; absent when reading it failed. */
	readonly next?: IteratorResult<unknown>;
	readonly failure?: { readonly error: unknown };
}

type PeekResult =
	| { readonly status: "aborted" }
	| { readonly status: "content"; readonly prefix: HeldPrefix }
	| { readonly status: "replay"; readonly prefix: Promise<HeldPrefix> };

/**
 * Read an attempt past its leading `start` events. A held `start` is not
 * progress, so it never resets the request's idle limit. A rejection while
 * opening the stream or before any `start` rejects; a rejection after a held
 * `start` is kept so the replay can rethrow it at the same point.
 */
function readHeldPrefix(
	output: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
): Promise<HeldPrefix> {
	const pending = (async (): Promise<HeldPrefix> => {
		const source = await output;
		const iterator = source[Symbol.asyncIterator]();
		const held: unknown[] = [];
		let sawStart = false;
		for (;;) {
			let step: IteratorResult<unknown>;
			try {
				step = await iterator.next();
			} catch (error) {
				if (!sawStart) throw error;
				return { iterator, held, failure: { error } };
			}
			if (step.done !== true && isRecoveryStartEvent(step.value)) {
				if (!sawStart) held.push(step.value);
				sawStart = true;
				continue;
			}
			return { iterator, held, next: step };
		}
	})();
	void pending.catch(() => {});
	return pending;
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
	try {
		void Promise.resolve(iterator.return?.()).catch(() => {});
	} catch {
		// A throwing `return` is contained like any other callback failure.
	}
}

/**
 * The attempt's output, resumed after the engine read its held prefix. The
 * held `start` replays first, then the step that ended the prefix; a failure
 * the read observed rethrows at the same point, so the buffered path sees
 * exactly what an unread stream would have produced.
 */
function resumedOutput(prefix: Promise<HeldPrefix>): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			const { iterator, held, next, failure } = await prefix;
			let finished = false;
			try {
				for (const event of held) yield event;
				if (failure !== undefined) {
					finished = true;
					throw failure.error;
				}
				if (next === undefined || next.done === true) {
					finished = true;
					return;
				}
				yield next.value;
				for (;;) {
					const step = await iterator.next();
					if (step.done === true) {
						finished = true;
						return;
					}
					yield step.value;
				}
			} finally {
				if (!finished) closeIterator(iterator);
			}
		},
	};
}

async function peekFirstContent(
	output: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
	request: ActiveRequest,
): Promise<PeekResult> {
	const prefix = readHeldPrefix(output);
	const settled = await awaitRequest(prefix, request);
	if (settled.status === "aborted") {
		void prefix.then(({ iterator }) => closeIterator(iterator), () => {});
		return { status: "aborted" };
	}
	if (
		settled.status === "value" &&
		settled.value.next !== undefined &&
		settled.value.next.done !== true &&
		isRecoveryContentEvent(settled.value.next.value)
	) {
		return { status: "content", prefix: settled.value };
	}
	return { status: "replay", prefix };
}

/**
 * The first send must use the call's selected model on an account candidate.
 * A model change happens only through `classifyModelRecovery` after a
 * structured failure, never because recheck skipped every exact-model account.
 */
function eligibleInitialCandidate(candidate: RecoveryCandidate): boolean {
	return (
		candidate.recoveryAction === "account" &&
		candidate.modelId === candidate.selectedModelId
	);
}

function projectModelFailure(terminal: AssistantMessage): RecoveryModelFailure {
	const diagnostics: readonly unknown[] = Array.isArray(terminal.diagnostics)
		? terminal.diagnostics
		: [];
	const diagnosticTypes: string[] = [];
	for (const diagnostic of diagnostics) {
		const type =
			typeof diagnostic === "object" && diagnostic !== null
				? (diagnostic as { type?: unknown }).type
				: undefined;
		if (typeof type === "string") diagnosticTypes.push(type);
	}
	const rawCode = (terminal as { code?: unknown }).code;
	const code =
		rawCode === "refusal" || rawCode === "unknown_stop" ? rawCode : undefined;
	return Object.freeze({
		stopReason: terminal.stopReason,
		api: terminal.api,
		provider: terminal.provider,
		model: terminal.model,
		hasErrorMessage:
			typeof terminal.errorMessage === "string" && terminal.errorMessage.length > 0,
		diagnosticTypes: Object.freeze(diagnosticTypes),
		...(code === undefined ? {} : { code }),
	});
}

function validPreDispatchDecision(value: unknown): value is RecoveryPreDispatchDecision {
	if (typeof value !== "object" || value === null) return false;
	const decision = value as Record<string, unknown>;
	return (
		decision.status === "eligible" ||
		decision.status === "skip" ||
		(decision.status === "terminate" &&
			(decision.reason === "malformed-config" || decision.reason === "callback-failure"))
	);
}

function validRetrySafety(value: unknown): value is RecoveryRetrySafety {
	if (typeof value !== "object" || value === null) return false;
	const safety = value as Record<string, unknown>;
	if (safety.status === "recoverable") {
		return (
			safety.action === "account" &&
			(safety.reason === "account-local-quota" ||
				safety.reason === "account-local-auth" ||
				safety.reason === "account-local-rate-limit" ||
				safety.reason === "pre-start-transient")
		);
	}
	if (safety.status === "model-policy") {
		return safety.reason === "structured-provider-error";
	}
	return (
		safety.status === "unsafe" &&
		(safety.reason === "uncertain-external-effects" ||
			safety.reason === "completed-tool" ||
			safety.reason === "completed-call" ||
			safety.reason === "agent-run" ||
			safety.reason === "invalid-request" ||
			safety.reason === "refusal" ||
			safety.reason === "unknown")
	);
}

function validModelDecision(value: unknown): value is RecoveryModelDecision {
	if (typeof value !== "object" || value === null) return false;
	const decision = value as Record<string, unknown>;
	return (
		decision.status === "none" ||
		(decision.status === "recoverable" &&
			decision.action === "model" &&
			(decision.reason === "unsupported-model" ||
				decision.reason === "unsupported-capability"))
	);
}

async function reserveAttempt(
	deps: RecoveryEngineDependencies,
	request: ActiveRequest,
	record: RecoverySendReservationRequest,
): Promise<"reserved" | "rejected" | "aborted"> {
	let result: ReturnType<RecoveryEngineDependencies["reserve"]>;
	try {
		result = deps.reserve(record, request.controller.signal);
	} catch {
		return "rejected";
	}
	const pending = Promise.resolve(result);
	void pending.catch(() => {});
	if (request.controller.signal.aborted) return "aborted";
	const settled = await awaitRequest(pending, request);
	if (settled.status === "aborted") return "aborted";
	if (settled.status === "rejected" || settled.value !== "reserved") {
		return "rejected";
	}
	return "reserved";
}

async function accountAttempt(
	deps: RecoveryEngineDependencies,
	request: ActiveRequest,
	record: RecoveryAttemptAccounting,
): Promise<"recorded" | "rejected" | "aborted"> {
	let result: ReturnType<RecoveryEngineDependencies["account"]>;
	try {
		result = deps.account(record, request.controller.signal);
	} catch {
		return "rejected";
	}
	const pending = Promise.resolve(result);
	void pending.catch(() => {});
	if (request.controller.signal.aborted) return "aborted";
	const settled = await awaitRequest(pending, request);
	if (settled.status === "aborted") return "aborted";
	if (settled.status === "rejected" || settled.value !== "recorded") {
		return "rejected";
	}
	return "recorded";
}

async function runRecovery(
	deps: RecoveryEngineDependencies,
	input: RecoveryRequest,
	request: ActiveRequest,
	onProgress: () => void,
): Promise<RecoveryResult> {
	let attempts = 0;
	let initialCandidate: RecoveryCandidate | undefined;
	let recoveryAction: RecoveryActionKind | undefined;
	const terminated = (): RecoveryResult => ({
		status: "terminated",
		reason: request.reason ?? "callback-failure",
		attempts,
		errorMessage: buildBoundedRecoveryFinalErrorMessage(),
	});
	const exhausted = (): RecoveryResult => ({
		status: "exhausted",
		attempts,
		errorMessage: buildBoundedRecoveryFinalErrorMessage(),
	});
	const consideredPairs = new Set<string>();

	for (const candidate of [...input.candidates]) {
		if (request.controller.signal.aborted) return terminated();
		if (attempts >= RECOVERY_MAX_PROVIDER_SENDS_PER_CALL) return exhausted();
		if (!validCandidate(candidate)) continue;
		if (initialCandidate === undefined && !eligibleInitialCandidate(candidate)) continue;
		if (
			recoveryAction !== undefined &&
			(initialCandidate === undefined ||
				candidate.recoveryAction !== recoveryAction ||
				!changesOnlyAuthorizedDimension(initialCandidate, candidate, recoveryAction))
		) {
			continue;
		}
		const pair = `${candidate.providerId}\u0000${candidate.modelId}`;
		if (consideredPairs.has(pair)) continue;
		consideredPairs.add(pair);

		let checkValue: ReturnType<RecoveryEngineDependencies["recheck"]>;
		try {
			checkValue = deps.recheck(candidate, request.controller.signal);
		} catch {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		const check = await awaitRequest(checkValue, request);
		if (check.status === "aborted") return terminated();
		let validCheck = false;
		if (check.status === "value") {
			try {
				validCheck = validPreDispatchDecision(check.value);
			} catch {
				validCheck = false;
			}
		}
		if (check.status === "rejected" || !validCheck) {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		if (check.value.status === "skip") continue;
		if (check.value.status === "terminate") {
			abortRequest(request, check.value.reason);
			return terminated();
		}

		let streamOptions: RecoveryBoundStreamOptions;
		let reservation: RecoverySendReservation;
		try {
			streamOptions = boundStreamOptions(candidate, input.options);
			reservation = sendReservationFor(candidate, streamOptions);
		} catch {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		if (attempts > 0 && reservation.maximumPossiblyChargedSends === "unknown") {
			// The recovery send is the call's last send. A pinned Codex non-SSE or a
			// vendored Antigravity invocation can make several internal sends, so it
			// cannot fit a one-send remainder.
			continue;
		}
		// A reservation keeps its ordinal even when the request aborts before dispatch.
		const ordinal = attempts + 1;
		const reserved = await reserveAttempt(deps, request, {
			ordinal,
			candidate,
			reservation,
		});
		if (reserved === "aborted") return terminated();
		if (reserved === "rejected") {
			abortRequest(request, "reservation-rejected");
			return terminated();
		}

		let facts: AttemptFacts = { usage: GAP_USAGE, cost: GAP_COST };
		let failureCode: RecoveryAttemptAccounting["failureCode"] = "dispatch-failure";
		let accepted:
			| { readonly terminal: AssistantMessage; readonly output: AssistantMessageEventStream }
			| undefined;
		let safety: RecoveryRetrySafety | undefined;
		let terminal: AssistantMessage | undefined;
		let callbackFailed = false;
		let sawProgress = false;
		let committed: { readonly output: AsyncIterable<unknown> } | undefined;
		const attemptController = new AbortController();
		const abortAttempt = (): void => attemptController.abort();
		request.controller.signal.addEventListener("abort", abortAttempt, { once: true });
		if (request.controller.signal.aborted) abortAttempt();

		let physicalValue: ReturnType<RecoveryEngineDependencies["dispatch"]> | undefined;
		if (!request.controller.signal.aborted) {
			try {
				// A physical attempt begins exactly when this callback is invoked.
				initialCandidate ??= candidate;
				attempts += 1;
				physicalValue = deps.dispatch({
					candidate,
					context: input.context,
					options: streamOptions,
					signal: attemptController.signal,
					onTransportActivity: () => {
						// Liveness, not output: only the idle limit is reset.
						if (!attemptController.signal.aborted) onProgress();
					},
				});
			} catch {
				callbackFailed = true;
			}
		}

		if (physicalValue !== undefined) {
				const physicalResult = await awaitRequest(physicalValue, request);
				if (physicalResult.status === "aborted") {
					observeLatePhysicalAttempt(physicalValue, attemptController.signal);
				} else if (physicalResult.status === "rejected") {
					callbackFailed = true;
				} else if (physicalResult.status === "value") {
					try {
						const physical = physicalResult.value;
						if (typeof physical !== "object" || physical === null) {
							throw new TypeError("malformed physical attempt");
						}
						const safetyPromise = Promise.resolve(physical.retrySafety);
						void safetyPromise.catch(() => {});
						let upstream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> =
							physical.output;
						let peekAborted = false;
						if (input.publication === "stream-after-first-content") {
							const peek = await peekFirstContent(physical.output, request);
							if (peek.status === "aborted") {
								peekAborted = true;
							} else if (peek.status === "content") {
								onProgress();
								sawProgress = true;
								committed = { output: resumedOutput(Promise.resolve(peek.prefix)) };
							} else {
								upstream = resumedOutput(peek.prefix);
							}
						}
						if (committed === undefined && !peekAborted) {
							const output = createAcceptedOutputStream(
								observedOutput(
									upstream,
									() => {
										sawProgress = true;
										onProgress();
									},
									(observed) => {
										terminal = observed;
									},
									(observed) => {
										facts = observed;
									},
								),
								{ signal: request.controller.signal },
							);
							const outputResult = await awaitRequest(output.result(), request);
							if (outputResult.status === "value") {
								accepted = { terminal: outputResult.value, output };
								facts = projectAttemptFacts(outputResult.value) ?? facts;
							} else if (outputResult.status === "rejected") {
								try {
									await output.result();
								} catch (error) {
									failureCode =
										error instanceof AcceptedOutputError
											? error.code
											: "dispatch-failure";
								}
							}
							if (accepted === undefined) {
								if (
									reservation.basis === "antigravity-inner-unknown" ||
									(reservation.basis === "codex-non-sse-unknown" &&
										(terminal === undefined ||
											classifyCodexRecoverySendEvidence(terminal) !==
												"pre-execution-rejected"))
								) {
									// A non-SSE Codex invocation may have reconnected or fallen back
									// to SSE after socket.send; only structured proof of a single
									// pre-execution rejection may consult the caller's classifier.
									// An Antigravity invocation may already have sent to several
									// endpoints or runtime models; no supported evidence bounds it.
									safety = {
										status: "unsafe",
										reason: "uncertain-external-effects",
									};
								} else {
									const safetyResult = await awaitRequest(safetyPromise, request);
									if (
										safetyResult.status === "value" &&
										validRetrySafety(safetyResult.value)
									) {
										safety = safetyResult.value;
									} else if (
										safetyResult.status === "rejected" ||
										safetyResult.status === "value"
									) {
										callbackFailed = true;
									}
								}
							}
						}
					} catch {
						callbackFailed = true;
					}
				}
			}

		const accounting = await accountAttempt(deps, request, {
			ordinal,
			candidate,
			disposition:
				committed !== undefined ? "committed" : accepted === undefined ? "failed" : "accepted",
			...(accepted === undefined && committed === undefined ? { failureCode } : {}),
			reservation,
			chargedSendExposure: chargedSendExposureFor(reservation),
			usage: facts.usage,
			cost: facts.cost,
		});
		request.controller.signal.removeEventListener("abort", abortAttempt);
		if (
			committed !== undefined &&
			accounting === "recorded" &&
			!request.controller.signal.aborted
		) {
			// The live attempt now belongs to the caller: its signal stays open and
			// no later send exists for this call.
			return { status: "committed", candidate, attempts, output: committed.output };
		}
		if (!attemptController.signal.aborted) abortAttempt();
		if (committed !== undefined) {
			// Close the started stream; a committed attempt is never retried.
			void (async () => {
				try {
					for await (const _event of committed.output) break;
				} catch {
					// The attempt was already aborted.
				}
			})();
		}
		if (request.controller.signal.aborted) return terminated();
		if (accounting === "rejected") {
			abortRequest(request, "accounting-rejected");
			return terminated();
		}
		if (committed !== undefined) {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		if (accepted !== undefined) {
			return {
				status: "accepted",
				candidate,
				attempts,
				terminal: accepted.terminal,
				output: accepted.output,
			};
		}
		if (callbackFailed || safety === undefined) {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		if (safety.status === "recoverable" && safety.reason === "pre-start-transient" && sawProgress) {
			// A transient failure is retried only while nothing was produced.
			abortRequest(request, "uncertain-external-effects");
			return terminated();
		}
		if (safety.status === "recoverable") {
			recoveryAction = safety.action;
			continue;
		}
		if (safety.status === "unsafe") {
			abortRequest(request, safety.reason);
			return terminated();
		}
		// The recovery send was the last send; do not consult model policy for a
		// third send that the call can never make.
		if (attempts >= RECOVERY_MAX_PROVIDER_SENDS_PER_CALL) return exhausted();
		if (terminal === undefined || deps.classifyModelRecovery === undefined) {
			abortRequest(request, "unknown");
			return terminated();
		}
		let modelValue: ReturnType<NonNullable<RecoveryEngineDependencies["classifyModelRecovery"]>>;
		try {
			modelValue = deps.classifyModelRecovery(
				projectModelFailure(terminal),
				request.controller.signal,
			);
		} catch {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		const modelDecision = await awaitRequest(modelValue, request);
		if (modelDecision.status === "aborted") return terminated();
		if (
			modelDecision.status === "rejected" ||
			!validModelDecision(modelDecision.value)
		) {
			abortRequest(request, "callback-failure");
			return terminated();
		}
		if (modelDecision.value.status === "none") {
			abortRequest(request, "unknown");
			return terminated();
		}
		recoveryAction = modelDecision.value.action;
	}
	return exhausted();
}

export function createRecoveryEngine(
	deps: RecoveryEngineDependencies,
): RecoveryEngine {
	const active = new Set<ActiveRequest>();
	let shutdown = false;

	const terminateAll = (reason: "reload" | "shutdown"): void => {
		if (reason === "shutdown") shutdown = true;
		for (const request of active) abortRequest(request, reason);
	};

	return {
		async recover(input): Promise<RecoveryResult> {
			if (shutdown) {
				return {
					status: "terminated",
					reason: "shutdown",
					attempts: 0,
					errorMessage: buildBoundedRecoveryFinalErrorMessage(),
				};
			}
			if (
				!validTiming(input.timing) ||
				(input.deadlineMs !== undefined &&
					(!Number.isFinite(input.deadlineMs) || input.deadlineMs < 0))
			) {
				return {
					status: "terminated",
					reason: "malformed-config",
					attempts: 0,
					errorMessage: buildBoundedRecoveryFinalErrorMessage(),
				};
			}

			const activeRequest: ActiveRequest = { controller: new AbortController() };
			active.add(activeRequest);
			let deadlineTimer: RecoveryTimer | undefined;
			let idleTimer: RecoveryTimer | undefined;
			let absoluteTimer: RecoveryTimer | undefined;
			let callerAbort: (() => void) | undefined;
			let idleGeneration = 0;
			let settled = false;
			const resetIdle = (): void => {
				// A committed attempt's connection outlives the invocation; its late
				// transport activity must not arm a timer for a settled request.
				if (settled || activeRequest.controller.signal.aborted) return;
				const generation = ++idleGeneration;
				cancelTimer(idleTimer);
				try {
					idleTimer = deps.clock.setTimer(input.timing.recoveryIdleTimeoutMs, () => {
						if (generation === idleGeneration) {
							abortRequest(activeRequest, "idle-timeout");
						}
					});
				} catch {
					abortRequest(activeRequest, "callback-failure");
				}
			};
			try {
				if (input.signal?.aborted) abortRequest(activeRequest, "caller-aborted");
				else if (input.signal !== undefined) {
					callerAbort = () => abortRequest(activeRequest, "caller-aborted");
					input.signal.addEventListener("abort", callerAbort, { once: true });
				}
				if (input.deadlineMs !== undefined && !activeRequest.controller.signal.aborted) {
					try {
						const remaining = input.deadlineMs - deps.clock.now();
						if (remaining <= 0) abortRequest(activeRequest, "caller-deadline");
						else {
							deadlineTimer = deps.clock.setTimer(remaining, () => {
								abortRequest(activeRequest, "caller-deadline");
							});
						}
					} catch {
						abortRequest(activeRequest, "callback-failure");
					}
				}
				resetIdle();
				if (!activeRequest.controller.signal.aborted) {
					try {
						absoluteTimer = deps.clock.setTimer(
							input.timing.recoveryAbsoluteTimeoutMs,
							() => abortRequest(activeRequest, "absolute-timeout"),
						);
					} catch {
						abortRequest(activeRequest, "callback-failure");
					}
				}
				if (activeRequest.controller.signal.aborted) {
					return {
						status: "terminated",
						reason: activeRequest.reason ?? "callback-failure",
						attempts: 0,
						errorMessage: buildBoundedRecoveryFinalErrorMessage(),
					};
				}
				return await runRecovery(deps, input, activeRequest, resetIdle);
			} finally {
				settled = true;
				idleGeneration += 1;
				cancelTimer(deadlineTimer);
				cancelTimer(idleTimer);
				cancelTimer(absoluteTimer);
				if (callerAbort !== undefined) {
					input.signal?.removeEventListener("abort", callerAbort);
				}
				active.delete(activeRequest);
			}
		},
		reload: () => terminateAll("reload"),
		shutdown: () => terminateAll("shutdown"),
	};
}
