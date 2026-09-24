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
import type { RecoveryCandidate } from "./recovery-plan.js";

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
			readonly status: "retryable";
			readonly reason: "generation-only-incomplete" | "definitively-rejected";
	  }
	| {
			readonly status: "unsafe";
			readonly reason:
				| "uncertain-external-effects"
				| "completed-tool"
				| "completed-call"
				| "agent-run";
	  };

/** Request options after recovery has replaced the provider's inner retry allowance. */
export type RecoveryBoundStreamOptions = SimpleStreamOptions & {
	readonly maxRetries: number;
};

/**
 * A pre-send reservation is an upper bound, not an observed charge count.
 *
 * `deliberate` is part of the type so future accounting cannot "tighten" the
 * reservation to an optimistic count. Adaptive Anthropic may use three SDK
 * sends under the provenance-locked adapter. A Codex WebSocket-capable request
 * may send three socket frames and then one SSE request. Recovery reserves all
 * sends that could be charged even though fewer (often one) normally occur.
 */
export type RecoverySendReservation =
	| {
			readonly maximumPossiblyChargedSends: 1;
			readonly overReservation: "none";
			readonly basis: "bounded-http";
	  }
	| {
			readonly maximumPossiblyChargedSends: 3;
			readonly overReservation: "deliberate";
			readonly basis: "adaptive-anthropic-provenance";
	  }
	| {
			readonly maximumPossiblyChargedSends: 4;
			readonly overReservation: "deliberate";
			readonly basis: "codex-websocket-uncertain";
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
			readonly maximumPossiblyChargedSends: 1 | 3;
	  }
	| {
			readonly status: "unknown";
			readonly reason: "codex-websocket-send";
	  };

/**
 * One supported provider invocation. `retrySafety` must classify the final
 * outbound payload after caller payload replacement and every provider callback.
 * Recovery independently overrides that classification for WebSocket-capable
 * Codex attempts because a completed socket send has uncertain external effects.
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
	readonly disposition: "failed" | "accepted";
	readonly failureCode?: AcceptedOutputErrorCode | "dispatch-failure";
	readonly reservation: RecoverySendReservation;
	readonly chargedSendExposure: RecoveryChargedSendExposure;
	readonly usage: RecoveryUsageCoverage;
	readonly cost: RecoveryCostCoverage;
}

export interface RecoveryEngineDependencies {
	readonly clock: RecoveryClock;
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

export interface RecoveryRequest {
	readonly candidates: readonly RecoveryCandidate[];
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
	| "agent-run";

export type RecoveryResult =
	| {
			readonly status: "accepted";
			readonly candidate: RecoveryCandidate;
			readonly attempts: number;
			readonly terminal: AssistantMessage;
			readonly output: AssistantMessageEventStream;
	  }
	| { readonly status: "exhausted"; readonly attempts: number }
	| {
			readonly status: "terminated";
			readonly reason: RecoveryTerminationReason;
			readonly attempts: number;
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
 * Supported request-local retry controls. Keep every managed family's entry
 * separate: each provider path has its own compile-valid mutation control and
 * regression test. The provenance-locked adaptive Anthropic adapter ignores
 * this option, so its possible three SDK sends are over-reserved instead of
 * assumed away. Google Antigravity has no supported inner-retry behavior yet,
 * so it gets the same conservative zero the other non-Anthropic families use.
 */
const RECOVERY_INNER_RETRY_LIMITS = Object.freeze({
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
	if (candidate.family === "anthropic") {
		// Recovery cannot see the model compat selector. Reserve the provenance-locked
		// adaptive SDK's initial send plus two retries for every Anthropic candidate.
		return Object.freeze({
			maximumPossiblyChargedSends: 3,
			overReservation: "deliberate",
			basis: "adaptive-anthropic-provenance",
		});
	}
	if (candidate.family === "openai-codex" && options.transport !== "sse") {
		// Pinned Codex can reconnect twice after socket.send, then fall back to one
		// bounded SSE send. The supported API exposes no narrower send observation.
		return Object.freeze({
			maximumPossiblyChargedSends: 4,
			overReservation: "deliberate",
			basis: "codex-websocket-uncertain",
		});
	}
	return Object.freeze({
		maximumPossiblyChargedSends: 1,
		overReservation: "none",
		basis: "bounded-http",
	});
}

function chargedSendExposureFor(
	reservation: RecoverySendReservation,
): RecoveryChargedSendExposure {
	return reservation.basis === "codex-websocket-uncertain"
		? Object.freeze({ status: "unknown", reason: "codex-websocket-send" })
		: Object.freeze({
				status: "bounded",
				maximumPossiblyChargedSends: reservation.maximumPossiblyChargedSends,
			});
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

const PROGRESS_EVENT_TYPES = new Set([
	"start",
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

function observedOutput(
	upstream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
	onProgress: () => void,
	onFacts: (facts: AttemptFacts) => void,
): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			const source = await upstream;
			for await (const event of source) {
				if (isProgressEvent(event)) onProgress();
				const facts = projectAttemptFacts(terminalFromEvent(event));
				if (facts !== undefined) onFacts(facts);
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
		typeof candidate.modelId === "string" &&
		candidate.modelId.length > 0
	);
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
	if (safety.status === "retryable") {
		return (
			safety.reason === "generation-only-incomplete" ||
			safety.reason === "definitively-rejected"
		);
	}
	return (
		safety.status === "unsafe" &&
		(safety.reason === "uncertain-external-effects" ||
			safety.reason === "completed-tool" ||
			safety.reason === "completed-call" ||
			safety.reason === "agent-run")
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
	const terminated = (): RecoveryResult => ({
		status: "terminated",
		reason: request.reason ?? "callback-failure",
		attempts,
	});
	const consideredPairs = new Set<string>();

	for (const candidate of [...input.candidates]) {
		if (request.controller.signal.aborted) return terminated();
		if (!validCandidate(candidate)) continue;
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
		const reserved = await reserveAttempt(deps, request, {
			ordinal: attempts + 1,
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
		let callbackFailed = false;
		const attemptController = new AbortController();
		const abortAttempt = (): void => attemptController.abort();
		request.controller.signal.addEventListener("abort", abortAttempt, { once: true });
		if (request.controller.signal.aborted) abortAttempt();

		let physicalValue: ReturnType<RecoveryEngineDependencies["dispatch"]> | undefined;
		if (!request.controller.signal.aborted) {
			try {
				// A physical attempt begins exactly when this callback is invoked.
				attempts += 1;
				physicalValue = deps.dispatch({
					candidate,
					context: input.context,
					options: streamOptions,
					signal: attemptController.signal,
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
						const output = createAcceptedOutputStream(
							observedOutput(
								physical.output,
								onProgress,
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
							if (reservation.basis === "codex-websocket-uncertain") {
								// No supported hook distinguishes an unsent connection failure from
								// a failure after socket.send. The latter may already be executing,
								// so recovery must never dispatch another candidate.
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
					} catch {
						callbackFailed = true;
					}
				}
			}

		const accounting = await accountAttempt(deps, request, {
			ordinal: attempts,
			candidate,
			disposition: accepted === undefined ? "failed" : "accepted",
			...(accepted === undefined ? { failureCode } : {}),
			reservation,
			chargedSendExposure: chargedSendExposureFor(reservation),
			usage: facts.usage,
			cost: facts.cost,
		});
		request.controller.signal.removeEventListener("abort", abortAttempt);
		if (!attemptController.signal.aborted) abortAttempt();
		if (request.controller.signal.aborted) return terminated();
		if (accounting === "rejected") {
			abortRequest(request, "accounting-rejected");
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
		if (safety.status === "unsafe") {
			abortRequest(request, safety.reason);
			return terminated();
		}
	}
	return { status: "exhausted", attempts };
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
				return { status: "terminated", reason: "shutdown", attempts: 0 };
			}
			if (
				!validTiming(input.timing) ||
				(input.deadlineMs !== undefined &&
					(!Number.isFinite(input.deadlineMs) || input.deadlineMs < 0))
			) {
				return { status: "terminated", reason: "malformed-config", attempts: 0 };
			}

			const activeRequest: ActiveRequest = { controller: new AbortController() };
			active.add(activeRequest);
			let deadlineTimer: RecoveryTimer | undefined;
			let idleTimer: RecoveryTimer | undefined;
			let absoluteTimer: RecoveryTimer | undefined;
			let callerAbort: (() => void) | undefined;
			let idleGeneration = 0;
			const resetIdle = (): void => {
				if (activeRequest.controller.signal.aborted) return;
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
					};
				}
				return await runRecovery(deps, input, activeRequest, resetIdle);
			} finally {
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
