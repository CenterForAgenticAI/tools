/**
 * WorkerChannel — observable wrapper around a worker AgentSession with
 * heartbeat-aware awaits.
 *
 * Purpose (B.2): expose the `send(text) → await reply` lifecycle as a
 * discriminated union (`reply | heartbeat | aborted`) so the supervisor
 * clone can keep its turn alive while a slow worker makes progress, and
 * so the runner can auto-escalate to cancellation after N consecutive
 * heartbeats of silence.
 *
 * State machine:
 *   idle → (send) running → (prompt resolves)          → idle       (kind=reply)
 *                          → (prompt rejects AbortError) aborted    (kind=aborted)
 *                          → (heartbeats reach max)      running    (kind=heartbeat, wind-down steer fired)
 *                          → (silence past max+grace)    aborted    (kind=aborted, reason=heartbeat)
 *                          → (heartbeat fires, n<max)    running    (kind=heartbeat)
 *
 * Note: hitting `maxConsecutiveHeartbeats` no longer aborts immediately. The
 * first time silence reaches the max, the channel fires a soft WIND-DOWN steer
 * (best-effort wrap-up instruction) and grants `heartbeatGraceIntervals` more
 * intervals; the hard abort only fires once silence persists past
 * `maxConsecutiveHeartbeats + heartbeatGraceIntervals`.
 *
 * Re-arming: after a `heartbeat` variant the inflight prompt is still
 * live; the next `awaitReply()` schedules a fresh heartbeat timer. Only
 * `reply` (or a non-AbortError prompt rejection) clears inflight.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_HEARTBEAT_TAIL_LINES } from "./config.js";
import { logDelegateDiagnostic } from "./diagnostics.js";
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	DEFAULT_MAX_CONSECUTIVE_HEARTBEATS,
} from "./heartbeat-defaults.js";
import type { WorkerErrorKind } from "./refusal.js";
import {
	classifyHarvestOutcome,
	createPromptLifecycleHarvest,
	getLastAssistantMessageText,
	formatRunEndingContinuationFailure,
	getLastAssistantText,
	NO_SUBSTANTIVE_WORKER_OUTPUT,
	RUN_ENDING_CONTINUATION_PROMPT,
	shouldAttemptHarvestContinuation,
	type HarvestMessage,
	type HarvestOutcome,
	type PromptLifecycleHarvest,
	type PromptLifecycleHarvestResult,
} from "./harvest-outcome.js";
import type { CancelReason } from "./runtime.js";
import {
	abortWorkerCompaction,
	DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS,
	WorkerCompactionConsumer,
	type WorkerCompactionEntryReader,
} from "./worker-compaction-seam.js";

export {
	getLastAssistantError,
	getLastAssistantText,
	isRunEndingToolExecutionEnd,
} from "./harvest-outcome.js";

/**
 * Default number of EXTRA heartbeat intervals a silent worker is granted
 * after the first wind-down steer, before the channel hard-aborts. The
 * effective abort threshold becomes `maxConsecutiveHeartbeats +
 * heartbeatGraceIntervals`. Defaults to 2 — long enough for a model that
 * was mid-tool-call to land a final answer, short enough that a runaway
 * run is still bounded.
 *
 * Lives here rather than in `config.ts` because the graft WorkNode that
 * introduced wind-down scopes `touches:` to `worker-channel.ts` /
 * `fork-runner.ts` / `index.ts` only; co-locating the heartbeat-specific
 * default with the channel keeps that contract clean. See
 * `DEFAULT_MAX_CONSECUTIVE_HEARTBEATS` in `config.ts` for the sibling knob.
 */
export const DEFAULT_HEARTBEAT_GRACE_INTERVALS = 2;

/**
 * Grace period for a streaming session to go idle before a new prompt is
 * queued as a follow-up. Worker heartbeat/abort policy owns the longer
 * liveness bound after queueing.
 */
export const DEFAULT_PROMPT_IDLE_WAIT_TIMEOUT_MS = 5_000;

/**
 * A compaction includes a model-backed summary request, so it needs the same
 * finite five-minute liveness scale as Pi's default HTTP idle timeout rather
 * than the short prompt-idle grace above. The owning run's AbortSignal can
 * still end this wait earlier.
 *
 * The canonical value lives in worker-compaction-seam.ts.
 */
export { DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS } from "./worker-compaction-seam.js";

export interface WorkerChannelClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const systemClock: WorkerChannelClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const PROMPT_IDLE_POLL_INTERVAL_MS = 10;

type PromptOptions = {
	preflightResult?: (success: boolean) => void;
	streamingBehavior?: "steer" | "followUp";
};

type PromptableSession = {
	prompt: (text: string, options?: PromptOptions) => Promise<void>;
	/** Public on AgentSession; optional for older SDKs and test doubles. */
	agent?: unknown;
	isStreaming?: boolean;
	isIdle?: boolean;
	/** Separate SDK state: current Pi versions report idle during manual compaction. */
	isCompacting?: boolean;
	waitForIdle?: () => Promise<void> | void;
	/** Event-backed compaction wait; optional for older SDKs and test doubles. */
	subscribe?: (listener: (event: unknown) => void) => (() => void);
	/** Public on current SDKs; optional for older SDKs and test doubles. */
	abortCompaction?: () => Promise<unknown> | unknown;
};

type PromptIdentityContext = {
	capture(message: HarvestMessage): void;
};

type RuntimePromptAgent = {
	prompt?: (...args: unknown[]) => unknown;
	followUp?: (...args: unknown[]) => unknown;
};

const promptIdentityContext = new AsyncLocalStorage<PromptIdentityContext>();
const identityInstrumentedAgents = new WeakSet<object>();

function harvestUserMessage(value: unknown): HarvestMessage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as HarvestMessage).role === "user" ? value as HarvestMessage : undefined;
}

function currentPromptUserMessage(input: unknown): HarvestMessage | undefined {
	if (!Array.isArray(input)) return harvestUserMessage(input);
	for (const message of input) {
		const userMessage = harvestUserMessage(message);
		if (userMessage) return userMessage;
	}
	return undefined;
}

/**
 * Instrument the two public Agent entry points that receive the exact user
 * message object created by AgentSession. AsyncLocalStorage keeps concurrent
 * extension activity from being mistaken for this prompt invocation.
 */
function instrumentPromptIdentity(session: PromptableSession): void {
	if (typeof session.agent !== "object" || session.agent === null) return;
	if (identityInstrumentedAgents.has(session.agent)) return;
	const agent = session.agent as RuntimePromptAgent;
	const originalPrompt = agent.prompt;
	if (typeof originalPrompt === "function") {
		agent.prompt = function (this: unknown, ...args: unknown[]): unknown {
			const message = currentPromptUserMessage(args[0]);
			if (message) promptIdentityContext.getStore()?.capture(message);
			return originalPrompt.apply(this, args);
		};
	}
	const originalFollowUp = agent.followUp;
	if (typeof originalFollowUp === "function") {
		agent.followUp = function (this: unknown, ...args: unknown[]): unknown {
			const message = harvestUserMessage(args[0]);
			if (message) promptIdentityContext.getStore()?.capture(message);
			return originalFollowUp.apply(this, args);
		};
	}
	identityInstrumentedAgents.add(session.agent);
}

function promptWithRequestIdentity(
	session: PromptableSession,
	text: string,
	promptOptions: PromptOptions | undefined,
	delivery: "direct" | "followUp",
	onPromptUserMessage?: (message: HarvestMessage) => void,
): Promise<void> {
	instrumentPromptIdentity(session);
	let accepted = false;
	let identityBound = false;
	let queuedCandidate: HarvestMessage | undefined;
	const bindIdentity = (message: HarvestMessage) => {
		if (identityBound) return;
		identityBound = true;
		onPromptUserMessage?.(message);
	};
	const callerPreflight = promptOptions?.preflightResult;
	const options: PromptOptions = {
		...promptOptions,
		preflightResult: (success) => {
			accepted = success;
			if (success && delivery === "followUp" && queuedCandidate) {
				bindIdentity(queuedCandidate);
			}
			callerPreflight?.(success);
		},
	};
	return promptIdentityContext.run(
		{
			capture: (message) => {
				if (delivery === "followUp") {
					if (!accepted) queuedCandidate = message;
					else bindIdentity(message);
				} else if (accepted) {
					bindIdentity(message);
				}
			},
		},
		() => session.prompt(text, options),
	);
}

type WorkerChannelSession = PromptableSession & {
	readonly messages: readonly unknown[];
	abort: () => Promise<void>;
	compact?: (instructions?: string) => Promise<unknown>;
};

export interface PromptWhenIdleOptions {
	/** Abort the bounded idle wait when the owning run is torn down. */
	signal?: AbortSignal;
	/** Override the default bounded wait, primarily for deterministic tests. */
	timeoutMs?: number;
	/** Override the model-backed compaction wait without extending the prompt-idle grace. */
	compactionTimeoutMs?: number;
	/** Invoked immediately before each SDK prompt attempt. */
	onBeforePrompt?: (delivery: "direct" | "followUp") => void;
	/** Receives the exact user-message object accepted for this request. */
	onPromptUserMessage?: (message: HarvestMessage) => void;
}

function isPromptBusyGuard(err: unknown): boolean {
	const message = String((err as { message?: unknown })?.message ?? err);
	return (
		message.includes("Agent is already processing.") &&
		message.includes("Specify streamingBehavior ('steer' or 'followUp') to queue the message.")
	);
}

function makeAbortError(): Error {
	const error = new Error("Prompt idle wait aborted");
	error.name = "AbortError";
	return error;
}

class PromptIdleTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Timed out waiting ${timeoutMs}ms for agent session to become idle`);
		this.name = "PromptIdleTimeoutError";
	}
}

class PromptCompactionTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Timed out waiting ${timeoutMs}ms for agent session compaction to finish`);
		this.name = "PromptCompactionTimeoutError";
	}
}

function makeIdleTimeoutError(timeoutMs: number): PromptIdleTimeoutError {
	return new PromptIdleTimeoutError(timeoutMs);
}

function makeCompactionTimeoutError(timeoutMs: number): PromptCompactionTimeoutError {
	return new PromptCompactionTimeoutError(timeoutMs);
}

function eventType(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" ? type : undefined;
}

/**
 * Hold logical ownership of a prompt while Pi rewrites the active session.
 * AgentSession.isIdle currently ignores manual compaction, so a normal idle
 * wait is not enough: prompting before compaction_end can bypass the session
 * listener that persists the exact user-message boundary.
 */
export async function waitForCompactionBoundary(
	session: PromptableSession,
	signal: AbortSignal | undefined,
	deadline: number,
	timeoutMs: number,
): Promise<void> {
	while (session.isCompacting === true) {
		if (signal?.aborted) throw makeAbortError();
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw makeCompactionTimeoutError(timeoutMs);
		const subscribe = session.subscribe;
		if (typeof subscribe !== "function") {
			let abortListener: (() => void) | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, Math.min(PROMPT_IDLE_POLL_INTERVAL_MS, remainingMs));
					abortListener = () => {
						clearTimeout(timer);
						reject(makeAbortError());
					};
					if (signal?.aborted) abortListener();
					else signal?.addEventListener("abort", abortListener, { once: true });
				});
			} finally {
				if (abortListener) signal?.removeEventListener("abort", abortListener);
			}
			continue;
		}

		let unsubscribe: (() => void) | undefined;
		let abortListener: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				const settle = () => resolve();
				abortListener = () => reject(makeAbortError());
				timer = setTimeout(() => reject(makeCompactionTimeoutError(timeoutMs)), remainingMs);
				if (signal?.aborted) abortListener();
				else signal?.addEventListener("abort", abortListener, { once: true });
				unsubscribe = subscribe.call(session, (event) => {
					if (eventType(event) === "compaction_end") settle();
				});
				// Close the check/subscribe race when compaction ended synchronously.
				if (session.isCompacting !== true) settle();
			});
		} finally {
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		}
	}
	if (signal?.aborted) throw makeAbortError();
}

/**
 * Wait for an active session run to settle without assuming that every test
 * fake or older SDK exposes the newer `waitForIdle()` helper. The polling
 * fallback is deliberately bounded as well: calling plain `prompt()` while
 * `isStreaming` is true would recreate the very guard this helper protects.
 */
async function waitForPromptIdle(
	session: PromptableSession,
	options: PromptWhenIdleOptions,
	forceWait: boolean,
	deadline: number,
	timeoutMs: number,
	compactionTimeoutMs: number,
): Promise<void> {
	const waitForCompaction = () => waitForCompactionBoundary(
		session,
		options.signal,
		Date.now() + compactionTimeoutMs,
		compactionTimeoutMs,
	).catch((error) => {
		abortWorkerCompaction(session);
		throw error;
	});
	await waitForCompaction();
	if (options.signal?.aborted) throw makeAbortError();
	const streaming = session.isStreaming === true;
	if (!forceWait && !streaming) return;

	const waitForIdle = session.waitForIdle;
	if (typeof waitForIdle === "function") {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		try {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw makeIdleTimeoutError(timeoutMs);
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(() => reject(makeIdleTimeoutError(timeoutMs)), remainingMs);
				abortListener = () => reject(makeAbortError());
				if (options.signal?.aborted) abortListener();
				else options.signal?.addEventListener("abort", abortListener, { once: true });
				void Promise.resolve(waitForIdle.call(session)).then(resolve, reject);
			});
		} finally {
			if (timer) clearTimeout(timer);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
		}
	}

	// A feature-detected waitForIdle implementation is still treated as a
	// hint, not permission to prompt: verify the public streaming flag before
	// returning, with the same deadline if an older/fake implementation settles
	// prematurely.
	while (session.isStreaming === true || session.isCompacting === true) {
		if (options.signal?.aborted) throw makeAbortError();
		if (session.isCompacting === true) {
			await waitForCompaction();
			continue;
		}
		if (Date.now() >= deadline) throw makeIdleTimeoutError(timeoutMs);
		await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_IDLE_POLL_INTERVAL_MS));
	}
	if (options.signal?.aborted) throw makeAbortError();
}

/** Wait for a queued follow-up to drain; WorkerChannel heartbeat policy owns the outer bound. */
async function waitForQueuedPrompt(session: PromptableSession, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw makeAbortError();
	const waitForIdle = session.waitForIdle;
	const idle = typeof waitForIdle === "function"
		? Promise.resolve(waitForIdle.call(session))
		: (async () => {
			while (session.isStreaming === true) {
				if (signal?.aborted) throw makeAbortError();
				await new Promise<void>((resolve) => setTimeout(resolve, PROMPT_IDLE_POLL_INTERVAL_MS));
			}
		})();
	if (!signal) {
		await idle;
		return;
	}
	let abortListener: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			abortListener = () => reject(makeAbortError());
			if (signal.aborted) abortListener();
			else signal.addEventListener("abort", abortListener, { once: true });
			void idle.then(resolve, reject);
		});
	} finally {
		if (abortListener) signal.removeEventListener("abort", abortListener);
	}
}

/**
 * Prompt a session only after it is idle, retrying once for pi's narrow
 * "Agent is already processing" guard. If the bounded idle wait expires,
 * queue the prompt as a follow-up instead of treating a live worker as a
 * transport failure. Other provider/runtime failures retain their original
 * error semantics.
 */
export async function promptWhenIdle(
	session: PromptableSession,
	text: string,
	promptOptions?: PromptOptions,
	options: PromptWhenIdleOptions = {},
): Promise<void> {
	if (options.signal?.aborted) throw makeAbortError();
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_IDLE_WAIT_TIMEOUT_MS;
	const compactionTimeoutMs =
		options.compactionTimeoutMs ?? DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	let retriedBusyGuard = false;
	const promptDirect = () => {
		options.onBeforePrompt?.("direct");
		return promptWithRequestIdentity(
			session,
			text,
			promptOptions,
			"direct",
			options.onPromptUserMessage,
		);
	};
	const queueFollowUp = () => {
		options.onBeforePrompt?.("followUp");
		return promptWithRequestIdentity(
			session,
			text,
			{ ...promptOptions, streamingBehavior: "followUp" },
			"followUp",
			options.onPromptUserMessage,
		);
	};

	// Keep the historical synchronous send() transition for already-idle
	// sessions: the prompt call itself starts before send() returns, while the
	// busy-session path naturally yields during waitForIdle().
	if (session.isStreaming !== true && session.isCompacting !== true) {
		try {
			await promptDirect();
			return;
		} catch (error) {
			if (!isPromptBusyGuard(error)) throw error;
			retriedBusyGuard = true;
		}
	}
	while (true) {
		try {
			await waitForPromptIdle(
				session,
				options,
				retriedBusyGuard,
				deadline,
				timeoutMs,
				compactionTimeoutMs,
			);
		} catch (error) {
			if (!(error instanceof PromptIdleTimeoutError)) throw error;
			await queueFollowUp();
			await waitForQueuedPrompt(session, options.signal);
			return;
		}
		if (options.signal?.aborted) throw makeAbortError();
		if (session.isStreaming === true || session.isCompacting === true) continue;
		try {
			await promptDirect();
			return;
		} catch (error) {
			if (!retriedBusyGuard && isPromptBusyGuard(error)) {
				retriedBusyGuard = true;
				continue;
			}
			throw error;
		}
	}
}

/** Format a terminal worker prompt error while preserving any assistant text already produced. */
export function formatRecoveredWorkerOutput(
	workerText: string,
	error: string,
	workerSessionFile?: string,
): string {
	const evidence = workerSessionFile ? `\nWorker session: ${workerSessionFile}` : "";
	return (
		"⚠️ RECOVERED WORKER OUTPUT — the worker produced this deliverable before " +
		"its prompt transport failed. Review it as a failed run, not a clean completion.\n\n" +
		(workerText.trim() || NO_SUBSTANTIVE_WORKER_OUTPUT) +
		`\n\nTransport error: ${error}` +
		evidence
	);
}

/**
 * Attach a supervisor's finish payload to a failed run's collapsed content as
 * clearly attributed context, beneath the failure.
 *
 * Two things have to stay true at once, and the difference between them is the
 * whole point (#235):
 *
 * - A supervisor summary must never be presented AS the worker's deliverable.
 *   That refusal is deliberate (#115) — a run whose worker produced nothing
 *   has not done the work, and hiding that behind a confident-sounding summary
 *   is how a parent merges an empty lane. So the error stays first, the status
 *   stays failed, and the report is banner-separated below it.
 * - Deleting the report is not required by any of that, and was never asked
 *   for. The supervisor watched every tool call the worker made, and because
 *   supervisor sessions are in-memory (`noExtensions: true`), its finish
 *   payload is the only place that account ever existed. Discarding it forced
 *   the orchestrator in #235's evidence to re-derive lane state from `git log`
 *   for eight failed runs.
 *
 * Attribution, not suppression. Returns `error` unchanged when there is no
 * usable report, so callers can assign the result unconditionally.
 */
export function withSupervisorReport(
	error: string,
	payload: { final_output?: string; summary?: string } | undefined,
): string {
	const finalOutput = payload?.final_output?.trim() ?? "";
	const summary = payload?.summary?.trim() ?? "";
	const report = finalOutput || summary;
	if (!report) return error;
	return [
		error,
		"",
		`⚠️ SUPERVISOR REPORT (${finalOutput ? "final_output" : "summary"}) — NOT the worker's ` +
			"deliverable. The worker produced no substantive output, so this run failed and the " +
			"error above stands. What follows is the supervisor's own account of the run, kept " +
			"because it is the only record of it. Use it to diagnose or resume, not as the work product.",
		"",
		report,
	].join("\n");
}

// `AgentMessage` isn't re-exported from the top level of pi-coding-agent;
// the harvest classifier only needs this narrow message surface.
type AgentMessage = HarvestMessage;

/** Active tool call surfaced in heartbeat payloads so the supervisor can see what the worker is doing right now. */
export interface HeartbeatActiveToolCall {
	/** Tool name (e.g. "bash", "read"). */
	name: string;
	/** One-line preview of the invocation (e.g. "bash: go test ./..."). Trimmed. */
	preview: string;
	/** Tool-call id, when known. */
	id?: string;
	/** Timestamp (ms since epoch) the toolCall entry was observed. */
	startedAt: number;
}

/** One observed activity entry from the worker transcript, bounded-ring-buffered for heartbeat payloads. */
export interface HeartbeatTailEntry {
	kind: "text" | "toolCall" | "toolResult";
	/** Role of the underlying message ("assistant" for text/toolCall, "tool" for toolResult). */
	role?: string;
	/** Short, supervisor-readable preview (first line / truncated command / truncated output). */
	preview: string;
	/** Tool name, present on toolCall / toolResult entries. */
	toolName?: string;
	/** Tool-call id (for cross-referencing result to call), when known. */
	toolCallId?: string;
	/** Observation timestamp (ms since epoch). */
	ts: number;
}

/**
 * Read-only snapshot of channel state, returned by `inspect()` for the
 * Commit B.3 `inspect_worker` supervisor tool. Fields mirror the heartbeat
 * payload so the supervisor sees the same shape on-demand as it does when
 * a heartbeat auto-fires — no second ring buffer, no duplicated book-keeping.
 */
export interface WorkerInspectSnapshot {
	workerState: WorkerState;
	/** Pending local escalation request(s) currently suspending the worker, if any. */
	awaitingEscalation?: WorkerAwaitingEscalation;
	/** Wall-clock ms since the last observed worker activity (`0` when idle/new). */
	silenceMs: number;
	consecutiveHeartbeats: number;
	activeToolCall: HeartbeatActiveToolCall | undefined;
	/**
	 * Copy of the full ring buffer (bounded by `heartbeatTailLines`). Callers
	 * can mutate the returned array without affecting internal state.
	 */
	recentTail: HeartbeatTailEntry[];
	/** Path to the worker's session jsonl, resolved when the snapshot is taken. */
	workerSessionFile: string | undefined;
}

/** Result of a worker turn. Discriminated by `kind`. */
export type WorkerCallResult =
	| {
			kind: "reply";
			text: string;
			harvest:
				| Extract<HarvestOutcome, { kind: "substantive" }>
				| Extract<HarvestOutcome, { kind: "missing"; reason: "cancellation-only" }>;
			newMessages: AgentMessage[];
	  }
	| {
			kind: "failed";
			text: string;
			error: string;
			harvest: HarvestOutcome;
			/** True when finalized assistant output survived a later transport failure. */
			recoveredOutput?: boolean;
			errorKind?: WorkerErrorKind;
			promptText: string;
			stopReason?: string;
			newMessages: AgentMessage[];
	  }
	| {
			kind: "heartbeat";
			/** True when the worker is blocked in the escalation awaiting a canonical outcome. */
			awaitingEscalation?: boolean;
			/** Pending escalation request(s) that a supervisor can resolve or forward. */
			escalation?: WorkerAwaitingEscalation;
			/** 1-indexed count of consecutive heartbeats observed for this inflight prompt. */
			consecutiveHeartbeats: number;
			/** Max count before auto-escalation; supervisor gets this so prompts can surface "3/5". */
			maxConsecutiveHeartbeats: number;
			/** Wall-clock ms since the last activity observed on the worker transcript. */
			silentMs: number;
			activeToolCall?: HeartbeatActiveToolCall;
			/** Ring-buffered recent transcript entries (bounded by heartbeatTailLines). */
			recentTail: HeartbeatTailEntry[];
	  }
	| {
			kind: "aborted";
			/** Why the channel was aborted. `"heartbeat"` = auto-escalation at max. Others = external cancel. */
			reason: CancelReason;
			/** Populated when reason === "heartbeat". */
			consecutiveHeartbeats?: number;
			silentMs?: number;
			activeToolCall?: HeartbeatActiveToolCall;
			recentTail?: HeartbeatTailEntry[];
			/** Finalized messages observed before the abort, if any. */
			newMessages?: AgentMessage[];
			harvest?: HarvestOutcome;
			/** True when finalized assistant output survived the abort. */
			recoveredOutput?: boolean;
			text?: string;
	  };

export type WorkerState = "idle" | "running" | "aborted" | "awaiting-escalation";

export interface WorkerAwaitingEscalation {
	rootRunId: string;
	requestIds: string[];
	holderId?: string;
	routingPolicy?: string;
}

/** Construction options — all are optional; unresolved values fall back to the module defaults. */
export interface WorkerChannelOptions {
	/**
	 * Milliseconds of silence after which `awaitReply` emits a `heartbeat`
	 * variant instead of continuing to block. `0` disables heartbeat entirely
	 * (channel behaves like B.1: awaitReply returns inflight verbatim).
	 * Values `>0 && <30_000` are clamped to 30_000 with a one-time console
	 * warning — supervisors tolerate a 30s minimum so we don't spam them.
	 */
	heartbeatIntervalMs?: number;
	/**
	 * Maximum consecutive heartbeats before WIND-DOWN. Reaching this count
	 * no longer aborts immediately: the channel first issues a wrap-up steer
	 * (`onWindDownSteer`) and grants `heartbeatGraceIntervals` more intervals
	 * of silence before the hard `abort("heartbeat")`.
	 */
	maxConsecutiveHeartbeats?: number;
	/**
	 * Extra heartbeat intervals of silence tolerated AFTER the first
	 * wind-down steer, before the channel hard-aborts. Defaults to
	 * `DEFAULT_HEARTBEAT_GRACE_INTERVALS` (2). The effective abort threshold
	 * is `maxConsecutiveHeartbeats + heartbeatGraceIntervals`.
	 */
	heartbeatGraceIntervals?: number;
	/**
	 * Best-effort callback fired ONCE, when `consecutiveHeartbeats` first
	 * reaches `maxConsecutiveHeartbeats`. The runner uses it to steer the
	 * worker with a wrap-up instruction ("you've gone silent past the limit
	 * — produce your final answer now"). Throws/rejections are swallowed so
	 * a failed steer never blocks the heartbeat from continuing into grace.
	 */
	onWindDownSteer?: () => void | Promise<void>;
	/**
	 * Spec 0024 / REQ-LIVE-1 — best-effort liveness sink. Invoked from
	 * `notifyActivity` on every observed worker-channel activity (the same
	 * reply/heartbeat/tool-event path that already resets the silence clock),
	 * carrying the channel's freshly-bumped `lastActivityAt` (ms epoch). The
	 * fork-runner wires this to `updateRunState(runId, forkName, {
	 * lastActivityAt })` so the run-state record carries a real liveness
	 * timestamp; run-introspect's reducer then advances an in-flight run's
	 * status elapsed instead of freezing it at the dispatch gap. Optional and
	 * decoupled (the channel has no run identity of its own); throws are
	 * swallowed so a failing sink never disrupts activity tracking — same
	 * best-effort contract as `onWindDownSteer`.
	 */
	onActivity?: (lastActivityAt: number) => void;
	/** Ring-buffer depth for `recentTail` entries in each heartbeat payload. */
	heartbeatTailLines?: number;
	/**
	 * Path to the worker's session jsonl, or a resolver for it. A resolver is
	 * called when `inspect()` runs because the jsonl is created lazily on the
	 * first prompt. A concrete string remains supported for callers that
	 * already have a path at construction time.
	 */
	workerSessionFile?: string | (() => string | undefined);
	/** Grace before a busy prompt is queued; defaults to DEFAULT_PROMPT_IDLE_WAIT_TIMEOUT_MS. */
	promptIdleWaitTimeoutMs?: number;
	/** Budget for model-backed worker compaction; defaults to DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS. */
	workerCompactionWaitTimeoutMs?: number;
	/** Read the optional extension's durable advisory entries after each harvest. */
	workerCompactionEntries?: () => readonly unknown[];
	/** Explicit diagnostics destination for worker-compaction housekeeping failures. */
	workerCompactionAgentDir?: string;
	/** Test/embedding override for the otherwise file-backed failure diagnostic. */
	onWorkerCompactionFailure?: (message: string) => void;
	/**
	 * Nested-liveness probe (spec 0004 / REQ-BUS-2). Returns `true` when ANY
	 * DESCENDANT of this run emitted an event-bus liveness event within the
	 * liveness window. The fork-runner wires this to
	 * `readDescendantActivity(rootRunId, lineagePath(frame), …)` so a
	 * foreground → orchestrator → worker tree does NOT false-cancel a healthy
	 * orchestrator whose own transcript is idle while its WORKER does the real
	 * work. Consulted in `fireHeartbeat` BEFORE the silence count / wind-down
	 * logic: an active descendant means the run is not silent at all, so the
	 * heartbeat is reset rather than escalated. Best-effort — a throwing probe
	 * is swallowed and treated as "no descendant activity".
	 */
	descendantActivityProbe?: () => boolean;
	/** Clock seam for deterministic heartbeat scheduling and silence accounting. */
	clock?: WorkerChannelClock;
}

/**
 * Minimum heartbeat interval to accept without clamping.
 *
 * The WorkerChannel constructor clamps any `heartbeatIntervalMs` in the
 * range `1..29_999` up to this value and logs a one-time warning. The
 * floor exists because supervisor prompts (LLM latency, tool-result
 * processing, the supervisor's own reasoning budget) are not designed
 * to tolerate sub-30s heartbeat cadence — below that, the supervisor
 * would spend more tokens reasoning about heartbeats than doing useful
 * work.
 *
 * Alternative clocks may use shorter intervals for deterministic tests or
 * other runtimes. The production system clock retains this floor.
 */
const MIN_HEARTBEAT_INTERVAL_MS = 30_000;

/** Module-level once-flag so `WorkerChannel` instances don't re-warn on the same pathological config. */
let clampWarnOnce = false;
/** Test-only reset helper so unit tests can re-observe the clamp warning. */
export function __resetHeartbeatClampWarnForTests(): void {
	clampWarnOnce = false;
}

/** Extract the newest substantive assistant text, or an honest lifecycle marker. */
export function recoverWorkerDeliverable(messages: AgentMessage[]): string {
	return getLastAssistantText(messages);
}

export interface AssistantErrorInfo {
	message: string;
	kind?: WorkerErrorKind;
	stopReason?: string;
}


function isAbortLikeError(err: any): boolean {
	if (!err) return false;
	if (err.name === "AbortError") return true;
	const msg = String(err.message ?? err);
	return /abort/i.test(msg);
}

/** Clamp, logging once, per spec. */
function resolveHeartbeatIntervalMs(raw: number | undefined, clock: WorkerChannelClock): number {
	if (raw === undefined) return DEFAULT_HEARTBEAT_INTERVAL_MS;
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_HEARTBEAT_INTERVAL_MS;
	if (raw === 0) return 0;
	if (raw < MIN_HEARTBEAT_INTERVAL_MS && clock === systemClock) {
		if (!clampWarnOnce) {
			clampWarnOnce = true;
			logDelegateDiagnostic(
				`heartbeatIntervalMs=${raw} is below the ${MIN_HEARTBEAT_INTERVAL_MS}ms minimum; ` +
					`clamping to ${MIN_HEARTBEAT_INTERVAL_MS}ms.`,
			);
		}
		return MIN_HEARTBEAT_INTERVAL_MS;
	}
	return raw;
}

/**
 * Observable wrapper around a worker `AgentSession`.
 *
 * `send()` kicks off `workerSession.prompt()` once and stores the inflight
 * promise. `awaitReply()` races that inflight against a heartbeat timer.
 * `notifyActivity()` is called by fork-runner from the worker transcript
 * subscription so heartbeats reset on real progress. `abort(reason?)` flips
 * state to `"aborted"` and best-effort aborts the underlying session —
 * fork-runner still aborts the clone session separately.
 */
export class WorkerChannel {
	private state: WorkerState = "idle";
	private stateBeforeAwaitingEscalation:
		| Exclude<WorkerState, "awaiting-escalation" | "aborted">
		| undefined;
	private inflight: Promise<WorkerCallResult> | null = null;
	private readonly workerSession: WorkerChannelSession;
	private readonly clock: WorkerChannelClock;

	// Heartbeat config (resolved at construction).
	private readonly heartbeatIntervalMs: number;
	private readonly maxConsecutiveHeartbeats: number;
	private readonly heartbeatGraceIntervals: number;
	private readonly onWindDownSteer?: () => void | Promise<void>;
	private readonly onActivity?: (lastActivityAt: number) => void;
	private readonly heartbeatTailLines: number;
	private readonly workerSessionFile: WorkerChannelOptions["workerSessionFile"];
	private readonly promptIdleWaitTimeoutMs: number | undefined;
	private readonly workerCompactionWaitTimeoutMs: number;
	private promptIdleAbortController?: AbortController;
	private readonly workerCompactionConsumer?: WorkerCompactionConsumer;
	private readonly workerCompactionAgentDir?: string;
	private readonly onWorkerCompactionFailure?: (message: string) => void;
	private readonly descendantActivityProbe?: () => boolean;
	private awaitingEscalation: WorkerAwaitingEscalation | undefined;
	private promptHarvest?: PromptLifecycleHarvest;
	/**
	 * Set true the first time `consecutiveHeartbeats` reaches
	 * `maxConsecutiveHeartbeats` and the wind-down steer fires. Latches for
	 * the lifetime of the channel: surfaced via `getWindDownSteered()` so the
	 * runner can tag the `RunResult.steered` flag whether the run then
	 * finishes cleanly within grace OR is hard-aborted past it.
	 */
	private windDownSteered = false;
	// Heartbeat state (mutated during an inflight prompt).
	private lastActivityAt = 0;
	/**
	 * Scheduling reference: the next heartbeat fires `heartbeatIntervalMs`
	 * after `max(lastActivityAt, lastHeartbeatAt)`. Updating on heartbeat
	 * fire means a continuously-silent worker emits heartbeats every
	 * interval (300, 600, 900…) rather than firing immediately on each
	 * re-await. Reset to 0 on notifyActivity / send.
	 */
	private lastHeartbeatAt = 0;
	private consecutiveHeartbeats = 0;
	private activeToolCall?: HeartbeatActiveToolCall;
	private recentTail: HeartbeatTailEntry[] = [];
	private heartbeatTimer?: unknown;
	private heartbeatTimerScheduled = false;
	private heartbeatResolve?: (r: WorkerCallResult) => void;

	/**
	 * Records the reason the channel was aborted. Defaults to `"supervisor"`
	 * — the catch-all for externally-triggered cancels. Overwritten to
	 * `"heartbeat"` by the auto-escalation path, or to the explicit reason
	 * passed to `abort(reason)` (the runner uses this for `"user"` /
	 * `"timeout"` / `"shutdown"`).
	 */
	private abortReason: CancelReason = "supervisor";

	/** Mark a locally observed terminal transition and retain its cancellation reason. */
	private markAborted(reason: CancelReason = "supervisor"): void {
		if (this.state !== "aborted") this.abortReason = reason;
		this.state = "aborted";
		this.stateBeforeAwaitingEscalation = undefined;
		this.awaitingEscalation = undefined;
	}

	constructor(workerSession: WorkerChannelSession, options?: WorkerChannelOptions) {
		this.workerSession = workerSession;
		this.clock = options?.clock ?? systemClock;
		this.heartbeatIntervalMs = resolveHeartbeatIntervalMs(options?.heartbeatIntervalMs, this.clock);
		this.maxConsecutiveHeartbeats =
			options?.maxConsecutiveHeartbeats !== undefined &&
			Number.isFinite(options.maxConsecutiveHeartbeats) &&
			options.maxConsecutiveHeartbeats > 0
				? Math.floor(options.maxConsecutiveHeartbeats)
				: DEFAULT_MAX_CONSECUTIVE_HEARTBEATS;
		this.heartbeatGraceIntervals =
			options?.heartbeatGraceIntervals !== undefined &&
			Number.isFinite(options.heartbeatGraceIntervals) &&
			options.heartbeatGraceIntervals >= 0
				? Math.floor(options.heartbeatGraceIntervals)
				: DEFAULT_HEARTBEAT_GRACE_INTERVALS;
		this.onWindDownSteer = options?.onWindDownSteer;
		this.onActivity = options?.onActivity;
		this.heartbeatTailLines =
			options?.heartbeatTailLines !== undefined &&
			Number.isFinite(options.heartbeatTailLines) &&
			options.heartbeatTailLines >= 0
				? Math.floor(options.heartbeatTailLines)
				: DEFAULT_HEARTBEAT_TAIL_LINES;
		this.workerSessionFile = options?.workerSessionFile;
		this.promptIdleWaitTimeoutMs = options?.promptIdleWaitTimeoutMs;
		this.workerCompactionWaitTimeoutMs =
			options?.workerCompactionWaitTimeoutMs ?? DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS;
		this.workerCompactionAgentDir = options?.workerCompactionAgentDir;
		this.onWorkerCompactionFailure = options?.onWorkerCompactionFailure;
		if (options?.workerCompactionEntries && typeof workerSession.compact === "function") {
			const entries: WorkerCompactionEntryReader = { getEntries: options.workerCompactionEntries };
			this.workerCompactionConsumer = new WorkerCompactionConsumer(entries, {
				compact: (instructions?: string) => {
					const compact = workerSession.compact;
					if (typeof compact !== "function") throw new Error("AgentSession.compact is unavailable");
					return instructions === undefined
						? compact.call(workerSession)
						: compact.call(workerSession, instructions);
				},
				subscribe: typeof workerSession.subscribe === "function"
					? (listener) => workerSession.subscribe!.call(workerSession, listener)
					: undefined,
				abortCompaction: typeof workerSession.abortCompaction === "function"
					? () => workerSession.abortCompaction!.call(workerSession)
					: undefined,
			});
		}
		this.descendantActivityProbe = options?.descendantActivityProbe;
	}

	private async consumeWorkerCompaction(signal: AbortSignal | undefined): Promise<void> {
		if (!this.workerCompactionConsumer) return;
		const timeoutMs = this.workerCompactionWaitTimeoutMs;
		const deadline = Date.now() + timeoutMs;
		await this.workerCompactionConsumer.consume({
			signal,
			deadline,
			timeoutMs,
			waitForCompactionBoundary: () => waitForCompactionBoundary(
				this.workerSession,
				signal,
				deadline,
				timeoutMs,
			),
			onFailure: (message) => {
				if (this.onWorkerCompactionFailure) this.onWorkerCompactionFailure(message);
				else logDelegateDiagnostic(message, { agentDir: this.workerCompactionAgentDir });
			},
		});
	}

	/**
	 * Read-only snapshot of current channel state. Used by the B.3
	 * `inspect_worker` tool to render an on-demand status without disturbing
	 * the inflight prompt or the heartbeat timer. `silenceMs` is `0` when no
	 * activity has ever been observed (fresh channel, no `send()` yet);
	 * `recentTail` is a copy so callers can sort/slice freely.
	 */
	inspect(): WorkerInspectSnapshot {
		return {
			workerState: this.state,
			awaitingEscalation: this.awaitingEscalation
				? { ...this.awaitingEscalation, requestIds: [...this.awaitingEscalation.requestIds] }
				: undefined,
			silenceMs: this.lastActivityAt > 0 ? this.clock.now() - this.lastActivityAt : 0,
			consecutiveHeartbeats: this.consecutiveHeartbeats,
			activeToolCall: this.activeToolCall
				? { ...this.activeToolCall }
				: undefined,
			recentTail: [...this.recentTail],
			workerSessionFile:
				typeof this.workerSessionFile === "function"
					? this.workerSessionFile()
					: this.workerSessionFile,
		};
	}

	getState(): WorkerState {
		return this.state;
	}

	isBusy(): boolean {
		return (
			this.state === "running" ||
			(this.state === "awaiting-escalation" && this.stateBeforeAwaitingEscalation === "running")
		);
	}

	/** Feed one SDK event into the currently active prompt-boundary harvest. */
	observePromptEvent(event: unknown): void {
		this.promptHarvest?.observe(event);
	}

	/**
	 * Mark the channel as externally paused on an originator-owned user
	 * escalation. While in this state, heartbeat payloads may still be emitted
	 * for liveness, but they DO NOT advance the wind-down/abort counters; the
	 * originator owns `escalation timeout`, not WorkerChannel.
	 */
	enterAwaitingEscalation(escalation?: WorkerAwaitingEscalation): void {
		if (this.state === "aborted" || this.state === "awaiting-escalation") return;
		this.stateBeforeAwaitingEscalation = this.state;
		this.state = "awaiting-escalation";
		this.awaitingEscalation = escalation
			? { ...escalation, requestIds: [...escalation.requestIds] }
			: undefined;
		this.consecutiveHeartbeats = 0;
		const resolve = this.heartbeatResolve;
		if (resolve) {
			this.heartbeatResolve = undefined;
			this.clearHeartbeatTimer();
			const now = this.clock.now();
			this.lastHeartbeatAt = now;
			resolve({
				kind: "heartbeat",
				awaitingEscalation: true,
				escalation: this.awaitingEscalation
					? { ...this.awaitingEscalation, requestIds: [...this.awaitingEscalation.requestIds] }
					: undefined,
				consecutiveHeartbeats: 0,
				maxConsecutiveHeartbeats: this.maxConsecutiveHeartbeats,
				silentMs: now - this.lastActivityAt,
				activeToolCall: this.activeToolCall,
				recentTail: [...this.recentTail],
			});
		}
	}

	/**
	 * Leave the originator-owned escalation wait and resume the previous worker
	 * state with a clean heartbeat counter so a run is not instantly wound down
	 * for silence accumulated while the user escalation was pending.
	 */
	resolveAwaitingEscalation(): void {
		if (this.state !== "awaiting-escalation") return;
		const previous = this.stateBeforeAwaitingEscalation ?? "idle";
		this.stateBeforeAwaitingEscalation = undefined;
		this.state = previous;
		this.awaitingEscalation = undefined;
		this.consecutiveHeartbeats = 0;
		this.lastHeartbeatAt = 0;
		this.lastActivityAt = this.clock.now();
		if (this.heartbeatResolve && this.heartbeatIntervalMs > 0) {
			this.scheduleHeartbeat();
		}
	}

	private workerSessionFilePath(): string | undefined {
		return typeof this.workerSessionFile === "function"
			? this.workerSessionFile()
			: this.workerSessionFile;
	}

	/** Diagnostics — exposed for tests and for fork-runner's busy-error tool result. */
	getHeartbeatIntervalMs(): number {
		return this.heartbeatIntervalMs;
	}
	getMaxConsecutiveHeartbeats(): number {
		return this.maxConsecutiveHeartbeats;
	}
	getConsecutiveHeartbeats(): number {
		return this.consecutiveHeartbeats;
	}
	/**
	 * True once the wind-down steer has fired (worker went silent past
	 * `maxConsecutiveHeartbeats`). Latches for the channel's lifetime so the
	 * runner can tag `RunResult.steered` regardless of whether the worker
	 * then finished within grace or was hard-aborted past it.
	 */
	getWindDownSteered(): boolean {
		return this.windDownSteered;
	}

	/**
	 * Called by fork-runner from the worker session's `subscribe` hook on
	 * every `message_end` event. Resets the silence clock, clears the
	 * consecutive-heartbeat counter, tracks the most-recent active
	 * `toolCall` (cleared by the matching `toolResult`), and appends to a
	 * bounded ring buffer. Safe to call while idle — it just updates state
	 * that will be reused on the next `send()`.
	 *
	 * Reschedules an outstanding heartbeat timer if a wait is pending, so
	 * real progress pushes the heartbeat back out to a fresh full interval.
	 */
	notifyActivity(entry: HeartbeatTailEntry): void {
		this.lastActivityAt = this.clock === systemClock ? entry.ts || this.clock.now() : this.clock.now();
		this.lastHeartbeatAt = 0;
		this.consecutiveHeartbeats = 0;
		// Spec 0024 / REQ-LIVE-1 — propagate the freshly-bumped liveness clock to
		// the run's run-state record (via the fork-runner-wired sink), on the
		// activity that already happens. Best-effort: a throwing sink must never
		// crash activity tracking, same contract as `onWindDownSteer`.
		if (this.onActivity) {
			try {
				this.onActivity(this.lastActivityAt);
			} catch {
				/* best-effort liveness propagation — never let it disrupt the channel */
			}
		}
		if (entry.kind === "toolCall" && entry.toolName) {
			this.activeToolCall = {
				name: entry.toolName,
				preview: entry.preview,
				id: entry.toolCallId,
				startedAt: entry.ts || this.clock.now(),
			};
		} else if (entry.kind === "toolResult") {
			// Clear only if this result matches the tracked active call (or
			// activeToolCall has no id — be tolerant of partial data).
			if (
				!this.activeToolCall ||
				!entry.toolCallId ||
				!this.activeToolCall.id ||
				entry.toolCallId === this.activeToolCall.id
			) {
				this.activeToolCall = undefined;
			}
		}
		if (this.heartbeatTailLines > 0) {
			this.recentTail.push(entry);
			while (this.recentTail.length > this.heartbeatTailLines) {
				this.recentTail.shift();
			}
		}
		// If a wait is pending, push the heartbeat out to a fresh interval.
		if (this.heartbeatResolve && this.heartbeatIntervalMs > 0) {
			this.scheduleHeartbeat();
		}
	}

	/**
	 * Send `text` to the worker. Throws if `state !== "idle"` — callers
	 * must gate on `isBusy()`. Returns a promise that resolves to a
	 * `reply | heartbeat | aborted` result (first thing that fires).
	 * The optional signal covers the pre-prompt idle wait as well as the
	 * caller's teardown boundary.
	 */
	send(text: string, signal?: AbortSignal): Promise<WorkerCallResult> {
		if (this.state !== "idle") {
			throw new Error(`WorkerChannel.send() called while state=${this.state}`);
		}
		this.state = "running";
		// Reset per-prompt heartbeat state.
		this.lastActivityAt = this.clock.now();
		this.lastHeartbeatAt = 0;
		this.consecutiveHeartbeats = 0;
		this.activeToolCall = undefined;
		this.recentTail = [];

		const promptIdleAbortController = new AbortController();
		this.promptIdleAbortController = promptIdleAbortController;
		const externalAbortListener = signal
			? () => {
				promptIdleAbortController.abort();
				abortWorkerCompaction(this.workerSession);
			}
			: undefined;
		if (signal) {
			if (signal.aborted) externalAbortListener!();
			else signal.addEventListener("abort", externalAbortListener!, { once: true });
		}
		const callerCancellationRequested = (): boolean =>
			this.state === "aborted" ||
			promptIdleAbortController.signal.aborted ||
			signal?.aborted === true;
		const makeAbortedResult = (
			harvest: HarvestOutcome,
			newMessages: AgentMessage[],
		): WorkerCallResult => {
			const harvestedText = harvest.kind === "substantive"
				? harvest.text
				: harvest.kind === "failure"
					? harvest.error
					: getLastAssistantMessageText(newMessages);
			this.markAborted();
			return {
				kind: "aborted",
				reason: this.abortReason,
				consecutiveHeartbeats: this.consecutiveHeartbeats,
				silentMs: this.clock.now() - this.lastActivityAt,
				activeToolCall: this.activeToolCall,
				recentTail: [...this.recentTail],
				newMessages,
				harvest,
				recoveredOutput: harvest.kind === "substantive",
				text: harvestedText,
			};
		};
		const runPromptAttempt = async (
			promptText: string,
		): Promise<{ collected: PromptLifecycleHarvestResult; error?: unknown }> => {
			const promptHarvest = createPromptLifecycleHarvest();
			this.promptHarvest = promptHarvest;
			let error: unknown;
			try {
				await promptWhenIdle(
					this.workerSession,
					promptText,
					{ preflightResult: () => {} },
					{
						signal: promptIdleAbortController.signal,
						timeoutMs: this.promptIdleWaitTimeoutMs,
						compactionTimeoutMs: this.workerCompactionWaitTimeoutMs,
						onBeforePrompt: (delivery) => {
							promptHarvest.begin(delivery === "direct" ? this.workerSession.messages.length : undefined);
						},
						onPromptUserMessage: (message) => promptHarvest.expectUserMessage(message),
					},
				);
			} catch (caught) {
				error = caught;
			}
			return {
				collected: promptHarvest.finish(this.workerSession.messages as AgentMessage[]),
				...(error === undefined ? {} : { error }),
			};
		};

		this.inflight = (async (): Promise<WorkerCallResult> => {
				const newMessages: AgentMessage[] = [];
				let continuationAttempts = 0;
				let promptText = text;
				let harvest: HarvestOutcome;

				while (true) {
					const attempt = await runPromptAttempt(promptText);
					const { collected } = attempt;
					newMessages.push(...collected.messages as AgentMessage[]);
					harvest = classifyHarvestOutcome(newMessages);
					// The full reply is harvested before housekeeping. A continuation or
					// later supervisor round cannot prompt until this host-owned boundary
					// either compacts successfully or records a non-fatal failure.
					await this.consumeWorkerCompaction(promptIdleAbortController.signal);
					if (callerCancellationRequested()) return makeAbortedResult(harvest, newMessages);
					if (attempt.error !== undefined) {
						const harvestedText = harvest.kind === "substantive"
							? harvest.text
							: harvest.kind === "failure"
								? harvest.error
								: getLastAssistantMessageText(newMessages);
						const abortLike = isAbortLikeError(attempt.error);
						if (abortLike && callerCancellationRequested()) {
							return makeAbortedResult(harvest, newMessages);
						}
						if (harvest.kind === "missing" && !abortLike) throw attempt.error;
						this.markAborted();
						const transportError = String(
							(attempt.error as { message?: unknown })?.message ?? attempt.error,
						);
						return {
							kind: "failed",
							text: harvestedText,
							error: transportError,
							harvest,
							recoveredOutput: harvest.kind === "substantive",
							...(harvest.kind === "failure" && harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
							promptText: text,
							...(harvest.kind === "failure" ? { stopReason: harvest.stopReason } : {}),
							newMessages,
						};
					}
					if (shouldAttemptHarvestContinuation(
						harvest,
						{
							...collected,
							hasUserMessage: collected.messages.some((message) => message.role === "user"),
						},
						continuationAttempts,
					)) {
						continuationAttempts += 1;
						promptText = RUN_ENDING_CONTINUATION_PROMPT;
						continue;
					}
					break;
				}

				if (harvest.kind === "failure") {
					const callerCancelled = callerCancellationRequested();
					this.markAborted();
					if (callerCancelled) {
						return {
							kind: "aborted",
							reason: this.abortReason,
							consecutiveHeartbeats: this.consecutiveHeartbeats,
							silentMs: this.clock.now() - this.lastActivityAt,
							activeToolCall: this.activeToolCall,
							recentTail: [...this.recentTail],
						};
					}
					return {
						kind: "failed",
						text: harvest.error,
						error: harvest.error,
						harvest,
						...(harvest.errorKind ? { errorKind: harvest.errorKind } : {}),
						promptText: text,
						stopReason: harvest.stopReason,
						newMessages,
					};
				}
				if (harvest.kind === "missing" && continuationAttempts > 0) {
					this.markAborted();
					return {
						kind: "failed",
						text: "",
						error: formatRunEndingContinuationFailure(this.workerSessionFilePath()),
						harvest,
						promptText: text,
						newMessages,
					};
				}
				if (harvest.kind === "missing" && harvest.reason !== "cancellation-only") {
					this.markAborted();
					return {
						kind: "failed",
						text: "",
						error: "No substantive assistant output recovered",
						harvest,
						promptText: text,
						newMessages,
					};
				}
				const replyText = harvest.kind === "missing"
					? getLastAssistantMessageText(newMessages)
					: harvest.text;
				// Reply transitions to idle unless a concurrent abort flipped us.
				if (this.state === "awaiting-escalation") {
					this.stateBeforeAwaitingEscalation = "idle";
					this.awaitingEscalation = undefined;
				} else if (this.state !== "aborted") {
					this.state = "idle";
				}
				return { kind: "reply", text: replyText, harvest, newMessages };
			})()
			.catch((err): WorkerCallResult => {
				if (callerCancellationRequested()) {
					this.markAborted();
					return {
						kind: "aborted",
						reason: this.abortReason,
						consecutiveHeartbeats: this.consecutiveHeartbeats,
						silentMs: this.clock.now() - this.lastActivityAt,
						activeToolCall: this.activeToolCall,
						recentTail: [...this.recentTail],
					};
				}
				// Non-cancellation errors propagate — fork-runner's outer try/catch
				// still treats them as real failures.
				this.markAborted();
				throw err;
			})
			.finally(() => {
				if (signal && externalAbortListener) signal.removeEventListener("abort", externalAbortListener);
				if (this.promptIdleAbortController === promptIdleAbortController) {
					this.promptIdleAbortController = undefined;
				}
				this.promptHarvest = undefined;
			});
		return this.awaitReply();
	}

	/**
	 * Await a result. Internally races the inflight prompt against a
	 * heartbeat timer. Returns `reply` (inflight won), `heartbeat` (timer
	 * won, n<max), or `aborted` (inflight rejected with AbortError, or the
	 * heartbeat counter hit max and auto-escalation fired).
	 *
	 * After a `heartbeat` variant the inflight promise is still live; the
	 * caller can call `awaitReply()` again to re-arm. After `reply` or
	 * `aborted` the inflight is cleared.
	 */
	awaitReply(): Promise<WorkerCallResult> {
		if (!this.inflight) {
			throw new Error(`WorkerChannel.awaitReply() with no inflight prompt`);
		}
		// Disabled → B.1 passthrough.
		if (this.heartbeatIntervalMs === 0) {
			return this.inflight.then((r) => this.handleResult(r));
		}

		const heartbeatPromise = new Promise<WorkerCallResult>((resolve) => {
			this.heartbeatResolve = resolve;
		});
		this.scheduleHeartbeat();

		return Promise.race([this.inflight, heartbeatPromise]).then((r) => {
			// Cleanup race state regardless of winner.
			this.clearHeartbeatTimer();
			this.heartbeatResolve = undefined;
			return this.handleResult(r);
		});
	}

	private handleResult(r: WorkerCallResult): WorkerCallResult {
		if (r.kind === "reply") {
			// Terminal reply — clear inflight.
			this.inflight = null;
		} else if (r.kind === "failed") {
			// Terminal failure — clear inflight.
			this.inflight = null;
		} else if (r.kind === "aborted") {
			// Channel done; clear inflight so a subsequent send() doesn't
			// collide (though `send()` rejects on non-idle state anyway, a
			// caller doing isBusy()+send flow expects inflight to be gone).
			this.inflight = null;
		}
		// heartbeat: keep inflight live; next awaitReply re-arms.
		return r;
	}

	private scheduleHeartbeat(): void {
		this.clearHeartbeatTimer();
		if (!this.heartbeatResolve || this.heartbeatIntervalMs <= 0) return;
		const clockBase = Math.max(this.lastActivityAt, this.lastHeartbeatAt);
		const elapsed = this.clock.now() - clockBase;
		const delay = Math.max(0, this.heartbeatIntervalMs - elapsed);
		this.heartbeatTimer = this.clock.setTimeout(() => this.fireHeartbeat(), delay);
		this.heartbeatTimerScheduled = true;
		// Don't keep production processes alive just for a heartbeat.
		if (this.clock === systemClock) {
			(this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
		}
	}

	private clearHeartbeatTimer(): void {
		if (this.heartbeatTimerScheduled) {
			this.clock.clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
			this.heartbeatTimerScheduled = false;
		}
	}

	private fireHeartbeat(): void {
		const resolve = this.heartbeatResolve;
		if (!resolve) return; // Race already settled.
		this.heartbeatResolve = undefined;
		this.clearHeartbeatTimer();
		const now = this.clock.now();
		if (this.state === "awaiting-escalation") {
			this.consecutiveHeartbeats = 0;
			this.lastHeartbeatAt = now;
			resolve({
				kind: "heartbeat",
				awaitingEscalation: true,
				escalation: this.awaitingEscalation
					? { ...this.awaitingEscalation, requestIds: [...this.awaitingEscalation.requestIds] }
					: undefined,
				consecutiveHeartbeats: this.consecutiveHeartbeats,
				maxConsecutiveHeartbeats: this.maxConsecutiveHeartbeats,
				silentMs: now - this.lastActivityAt,
				activeToolCall: this.activeToolCall,
				recentTail: [...this.recentTail],
			});
			return;
		}
		// ── Nested-liveness false-cancel fix (spec 0004 / REQ-BUS-2) ────────
		// BEFORE counting this tick as silence, ask the event bus whether any
		// DESCENDANT of this run is still producing events. If so, the run is
		// not silent at all — its grandchild is doing the real work — so we
		// RESET the silence clock and emit a fresh (n=1) heartbeat instead of
		// marching toward wind-down / hard-abort. This runs ahead of the
		// spec-0002 wind-down logic precisely because an active descendant means
		// there is nothing to wind down. Best-effort: a throwing probe is
		// swallowed and read as "no descendant activity".
		let descendantActive = false;
		if (this.descendantActivityProbe) {
			try {
				descendantActive = this.descendantActivityProbe() === true;
			} catch {
				descendantActive = false;
			}
		}
		if (descendantActive) {
			// Treat the run as ACTIVE: reset the silence accumulation so the
			// next interval starts fresh, and surface a normal heartbeat so the
			// supervisor's turn stays alive without any escalation.
			this.consecutiveHeartbeats = 0;
			this.lastActivityAt = now;
			this.lastHeartbeatAt = now;
			if (this.onActivity) {
				try {
					this.onActivity(now);
				} catch {
					/* best-effort liveness propagation — never let it disrupt the channel */
				}
			}
			const resolveActive = resolve;
			resolveActive({
				kind: "heartbeat",
				consecutiveHeartbeats: this.consecutiveHeartbeats,
				maxConsecutiveHeartbeats: this.maxConsecutiveHeartbeats,
				silentMs: 0,
				activeToolCall: this.activeToolCall,
				recentTail: [...this.recentTail],
			});
			return;
		}
		this.consecutiveHeartbeats += 1;
		this.lastHeartbeatAt = now;
		const silentMs = now - this.lastActivityAt;
		// Wind-down: the FIRST time silence reaches the soft budget
		// (`maxConsecutiveHeartbeats`), steer the worker to wrap up instead of
		// aborting, then grant `heartbeatGraceIntervals` more intervals. The
		// hard abort only happens once silence persists past
		// `maxConsecutiveHeartbeats + heartbeatGraceIntervals`.
		if (
			this.consecutiveHeartbeats >= this.maxConsecutiveHeartbeats &&
			!this.windDownSteered
		) {
			this.windDownSteered = true;
			// Best-effort wrap-up steer — swallow throws/rejections so a failed
			// steer can never wedge the heartbeat loop. The runner wires this to
			// push a wrap-up instruction into the worker transcript.
			if (this.onWindDownSteer) {
				try {
					void Promise.resolve(this.onWindDownSteer()).catch(() => {});
				} catch {
					/* best-effort */
				}
			}
		}
		const abortThreshold = this.maxConsecutiveHeartbeats + this.heartbeatGraceIntervals;
		if (this.windDownSteered && this.consecutiveHeartbeats >= abortThreshold) {
			// Grace exhausted (or grace === 0): escalate. Abort the underlying
			// session and emit an aborted result. abort() is fire-and-forget here
			// — it resolves once the session acknowledges; if it rejects we
			// swallow (best-effort).
			this.abort("heartbeat").catch(() => {});
			resolve({
				kind: "aborted",
				reason: "heartbeat",
				consecutiveHeartbeats: this.consecutiveHeartbeats,
				silentMs,
				activeToolCall: this.activeToolCall,
				recentTail: [...this.recentTail],
			});
			return;
		}
		resolve({
			kind: "heartbeat",
			consecutiveHeartbeats: this.consecutiveHeartbeats,
			maxConsecutiveHeartbeats: this.maxConsecutiveHeartbeats,
			silentMs,
			activeToolCall: this.activeToolCall,
			recentTail: [...this.recentTail],
		});
	}

	/** Wait for the current prompt to settle after its session has been aborted. */
	async waitForSettlement(): Promise<void> {
		const inflight = this.inflight;
		if (!inflight) return;
		await inflight.catch(() => undefined);
	}

	/**
	 * Abort the worker session. Idempotent — repeated callers preserve the
	 * first cancellation reason. Callers that own a replacement/teardown
	 * transition can await waitForSettlement() after this returns; abort itself
	 * must not wait on a provider prompt that may only settle asynchronously
	 * after the caller has returned to the provider event loop.
	 */
	async abort(reason: CancelReason = "supervisor"): Promise<void> {
		// Only overwrite the reason on the first abort — first-writer-wins so
		// that e.g. a heartbeat-escalation-then-user-cancel race still reports
		// "heartbeat" as the cause.
		if (this.state !== "aborted") {
			this.abortReason = reason;
		}
		this.state = "aborted";
		this.stateBeforeAwaitingEscalation = undefined;
		this.awaitingEscalation = undefined;
		this.clearHeartbeatTimer();
		this.promptIdleAbortController?.abort();
		abortWorkerCompaction(this.workerSession);
		try {
			await this.workerSession.abort();
		} catch {
			/* best-effort */
		}
	}
}
