/**
 * Runner-side admission for the live leaf-worker cap (#633). Shared by the
 * direct and supervised runners so both take and account for slots the same
 * way; the queue itself lives in `live-worker-cap.ts`.
 */
import { loadConfigReadOnly } from "./config.js";
import { logDelegateDiagnostic } from "./diagnostics-file.js";
import {
	acquireLiveWorkerSlot,
	liveWorkerCapSnapshot,
	LIVE_WORKER_QUEUED_ABORT_MESSAGE,
	LiveWorkerSlotAbortedError,
	type LiveWorkerLease,
} from "./live-worker-cap.js";
import type { CredentialRetryBudget } from "./refusal.js";
import { DELEGATE_TOOL_NAME, type ResolvedToolSurface } from "./tool-surface.js";

/** The AgentSession surface the idle probe and prompt gate read. */
export interface LiveWorkerSession {
	readonly isStreaming: boolean;
	readonly isCompacting?: boolean;
	readonly isRetrying?: boolean;
	readonly isBashRunning?: boolean;
	readonly pendingMessageCount?: number;
	prompt: (...args: never[]) => Promise<void>;
	/** Pi's cancel entry point; the gate wraps it so a cancel reaches a prompt waiting for a slot. */
	abort?: () => Promise<void>;
	/** Starts a turn when called with `triggerTurn` while not streaming. */
	sendCustomMessage?: (message: never, options?: { triggerTurn?: boolean; deliverAs?: string }) => Promise<void>;
	/** `agent.continue()` starts a turn without `prompt` (credential and capacity retries). */
	readonly agent?: { continue: () => Promise<void> };
}

export interface LeafWorkerAdmission {
	agentDir: string;
	surface: Pick<ResolvedToolSurface, "tools" | "delegateOptIn" | "extSelectors">;
	signal?: AbortSignal;
	runId?: string;
	forkName: string;
	/** Human label for the one queued diagnostic. */
	label: string;
	now: () => number;
	/** Shifted by the queued time so the credential retry window starts at admission. */
	credentialRetryBudget?: CredentialRetryBudget;
	/**
	 * After `signal` aborts, the slot is freed once this much longer has passed
	 * even if teardown has not settled, so a hung cancel cannot hold it forever.
	 */
	abortGraceMs: number;
}

/**
 * Whether a worker with this surface can dispatch workers of its own. Such a
 * coordinator takes no slot. When in doubt the answer is yes: an uncounted
 * leaf only loosens the cap, while a counted coordinator can deadlock it.
 */
export function surfaceDispatchesWorkers(
	surface: Pick<ResolvedToolSurface, "tools" | "delegateOptIn" | "extSelectors">,
): boolean {
	if (!surface.delegateOptIn) return false;
	if (surface.tools === undefined || surface.tools.includes(DELEGATE_TOOL_NAME)) return true;
	return surface.extSelectors.some((selector) => selector.tool === undefined || selector.tool === DELEGATE_TOOL_NAME);
}

function configuredMaxLiveWorkers(agentDir: string): number {
	try {
		return loadConfigReadOnly(agentDir).maxLiveWorkers ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Take a live-worker slot for a leaf, or return `undefined` for a coordinator.
 * Rejects with `LiveWorkerSlotAbortedError` when `signal` aborts while queued.
 */
export async function admitLeafWorker(admission: LeafWorkerAdmission): Promise<LiveWorkerLease | undefined> {
	if (surfaceDispatchesWorkers(admission.surface)) return undefined;
	let logged = false;
	const lease = await acquireLiveWorkerSlot({
		max: configuredMaxLiveWorkers(admission.agentDir),
		signal: admission.signal,
		runId: admission.runId,
		forkName: admission.forkName,
		now: admission.now,
		onQueued: (position) => {
			if (logged) return;
			logged = true;
			const { live, max } = liveWorkerCapSnapshot();
			logDelegateDiagnostic(
				`${admission.label} queued for a live-worker slot (position ${position}; live ${live}/${max}). ` +
					"Its time budgets start when it gets a slot.",
				{ agentDir: admission.agentDir, throttleKey: "live-worker-queued" },
			);
		},
	});
	if (lease.waitedMs > 0 && admission.credentialRetryBudget) {
		// The budget is readonly so retry seams cannot extend it. Admission is the
		// one owner-side shift: time spent queued was never a retry window.
		const budget = admission.credentialRetryBudget as { deadlineAtMs: number };
		budget.deadlineAtMs += lease.waitedMs;
	}
	const signal = admission.signal;
	if (signal) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const forceRelease = () => {
			timer = setTimeout(() => {
				if (lease.released) return;
				lease.release();
				logDelegateDiagnostic(
					`${admission.label} freed its live-worker slot ${admission.abortGraceMs}ms after cancellation; teardown had not settled.`,
					{ agentDir: admission.agentDir },
				);
			}, Math.max(0, admission.abortGraceMs));
			timer.unref?.();
		};
		if (signal.aborted) forceRelease();
		else signal.addEventListener("abort", forceRelease, { once: true });
		// The run's own final release drops the listener and any pending timer.
		const release = lease.release.bind(lease);
		lease.release = () => {
			signal.removeEventListener("abort", forceRelease);
			if (timer !== undefined) clearTimeout(timer);
			release();
		};
	}
	return lease;
}

/** True when the session is doing nothing and has nothing waiting to run. */
export function isLiveWorkerSessionIdle(session: LiveWorkerSession | undefined): boolean {
	if (!session) return false;
	return !session.isStreaming &&
		session.isCompacting !== true &&
		session.isRetrying !== true &&
		session.isBashRunning !== true &&
		(session.pendingMessageCount ?? 0) === 0;
}

/**
 * The method `key` would resolve to on `target` before an own-property wrapper
 * shadows it. An inherited method is looked up again on every call, so a later
 * patch of the prototype (instrumentation, tests) still runs under the gate.
 */
function underlyingMethod<F extends (...args: never[]) => unknown>(target: object, key: string): () => F | undefined {
	if (Object.prototype.hasOwnProperty.call(target, key)) {
		const own = (target as Record<string, unknown>)[key];
		return () => (typeof own === "function" ? own as F : undefined);
	}
	const proto = Object.getPrototypeOf(target) as Record<string, unknown> | null;
	return () => {
		const inherited = proto?.[key];
		return typeof inherited === "function" ? inherited as F : undefined;
	};
}

/**
 * Let the idle reaper free this lease's slot and make every new turn take one
 * back first (#633). `busy` reports runner-side work the session cannot see,
 * such as an open escalation.
 *
 * The gate wraps the instance's `prompt` (which Pi's own follow-up paths also
 * call), `sendCustomMessage` when it would start a turn, and `agent.continue`,
 * so a turn started any of those ways after an idle release waits in the queue.
 * It also wraps `abort`: a supervisor-internal cancel (`cancel_worker`,
 * `restart_worker`, the heartbeat auto-cancel) reaches the worker only through
 * `session.abort()`, which does nothing to a turn that has not started. A
 * gated turn therefore also waits on the gate's own abort, and one aborted
 * while it waited is never sent, even when its slot arrives first.
 *
 * While any wrapped call is in flight the idle probe reports busy: Pi marks a
 * run active only after its async preflight, which must not read as idle.
 */
export function installLiveWorkerSessionGate(
	lease: LiveWorkerLease,
	session: LiveWorkerSession,
	options: { signal?: AbortSignal; busy?: () => boolean },
): void {
	let inFlight = 0;
	let abortEpoch = 0;
	let gateAbort = new AbortController();

	const gateTurn = (start: () => Promise<void>): Promise<void> => {
		inFlight += 1;
		const settle = () => { inFlight -= 1; };
		if (lease.holding || lease.released) {
			// Pass through in the same tick, exactly as an ungated session would.
			let started: Promise<void>;
			try {
				started = start();
			} catch (error) {
				settle();
				throw error;
			}
			return Promise.resolve(started).finally(settle);
		}
		const epoch = abortEpoch;
		const signal = options.signal ? AbortSignal.any([options.signal, gateAbort.signal]) : gateAbort.signal;
		return (async () => {
			try {
				await lease.reacquire(signal);
				// A grant that raced the abort must not send the cancelled turn.
				if (abortEpoch !== epoch || options.signal?.aborted) {
					throw new LiveWorkerSlotAbortedError(LIVE_WORKER_QUEUED_ABORT_MESSAGE);
				}
				await start();
			} finally {
				settle();
			}
		})();
	};

	const writable = session as {
		prompt: LiveWorkerSession["prompt"];
		abort?: LiveWorkerSession["abort"];
		sendCustomMessage?: LiveWorkerSession["sendCustomMessage"];
	};
	const originalPrompt = underlyingMethod<LiveWorkerSession["prompt"]>(session, "prompt");
	writable.prompt = (...args: never[]): Promise<void> => gateTurn(() => originalPrompt()!.apply(session, args));

	const originalSend = underlyingMethod<NonNullable<LiveWorkerSession["sendCustomMessage"]>>(session, "sendCustomMessage");
	if (originalSend()) {
		writable.sendCustomMessage = (message, sendOptions) => {
			// Only a turn-starting send waits; a steer, follow-up, append or next-turn
			// message joins the current turn or none.
			const startsTurn = sendOptions?.triggerTurn === true && sendOptions.deliverAs !== "nextTurn" && !session.isStreaming;
			const send = () => originalSend()!.call(session, message, sendOptions);
			return startsTurn ? gateTurn(send) : send();
		};
	}

	const agent = session.agent as { continue: () => Promise<void> } | undefined;
	const originalContinue = agent ? underlyingMethod<() => Promise<void>>(agent, "continue") : undefined;
	if (agent && originalContinue?.()) {
		agent.continue = () => gateTurn(() => originalContinue()!.call(agent));
	}

	const originalAbort = underlyingMethod<NonNullable<LiveWorkerSession["abort"]>>(session, "abort");
	if (originalAbort()) {
		writable.abort = (): Promise<void> => {
			abortEpoch += 1;
			const aborted = gateAbort;
			gateAbort = new AbortController();
			aborted.abort();
			return originalAbort()!.call(session);
		};
	}

	lease.setIdleProbe(() => inFlight === 0 && options.busy?.() !== true && isLiveWorkerSessionIdle(session));
}
