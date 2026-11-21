/**
 * Process-wide cap on live leaf workers (#633).
 *
 * A leaf worker is a run whose effective tool surface cannot dispatch further
 * workers. Each leaf takes one slot before its worker session is created and
 * returns it when the run is terminal. At the cap, further leaves wait in FIFO
 * order; nothing is refused, because a refusal invites the model to retry.
 *
 * Coordinators (runs that can call `delegate`) never take a slot. They wait on
 * their own children, so a coordinator holding a slot while its children queue
 * behind it could deadlock the tree at a small cap.
 *
 * Idle reaper: a holder whose session has been idle (not streaming, nothing
 * queued, not compacting) for `idleReapMs` while other runs are queued gives
 * its slot up without ending. Its next prompt re-takes a slot, in FIFO order,
 * before it is sent.
 *
 * The state lives on `globalThis` because a worker session loads its own copy
 * of this extension: a nested coordinator's children must queue on the same
 * counter as the root's.
 */
// No runtime imports: runtime.ts and status surfaces load this module, and it
// must not pull the tool-surface or Pi SDK graph into data-only readers.

/** Default idle time before the reaper frees a slot while others are queued. */
export const DEFAULT_LIVE_WORKER_IDLE_REAP_MS = 60_000;
/** How often the reaper looks at slot holders. */
export const DEFAULT_LIVE_WORKER_REAP_INTERVAL_MS = 5_000;

/** One leaf worker's claim on a slot. */
export interface LiveWorkerLease {
	/** Give the slot up for good; idempotent. Call on every terminal path. */
	release(): void;
	/** True once `release` ran. */
	readonly released: boolean;
	/** True while this lease counts against the cap. False after an idle release. */
	readonly holding: boolean;
	/** Milliseconds this run waited in the queue before its first slot. */
	readonly waitedMs: number;
	/**
	 * Take a slot again after an idle release, waiting in FIFO order. Resolves at
	 * once while the lease holds a slot. Rejects with `LiveWorkerSlotAbortedError`
	 * when `signal` aborts or the lease is released while waiting.
	 */
	reacquire(signal?: AbortSignal): Promise<void>;
	/** Idle probe the reaper polls; `undefined` removes it. */
	setIdleProbe(probe: (() => boolean) | undefined): void;
}

export interface AcquireLiveWorkerSlotOptions {
	/** Configured `maxLiveWorkers`; `0` (or anything below 1) is unlimited. */
	max: number;
	/** Abort while queued: the waiter leaves the queue and the promise rejects. */
	signal?: AbortSignal;
	/** Identity used by status surfaces to show a queued entry. */
	runId?: string;
	forkName?: string;
	/** Called with the 1-based queue position when queued and when it moves. */
	onQueued?: (position: number) => void;
	now?: () => number;
}

export interface LiveWorkerCapSnapshot {
	/** Configured cap; `0` means unlimited. */
	readonly max: number;
	/** Leaf workers holding a slot. */
	readonly live: number;
	/** Leaf workers waiting for a slot, first-time or re-acquiring. */
	readonly queued: number;
}

/** Text for a run cancelled after it joined the queue. */
export const LIVE_WORKER_QUEUED_ABORT_MESSAGE = "aborted while queued for a live-worker slot";
/** Text for a run cancelled before it joined the queue or after its lease ended. */
export const LIVE_WORKER_UNGRANTED_ABORT_MESSAGE = "aborted before a live-worker slot was granted";

/** Rejection for a run cancelled before it got a slot. */
export class LiveWorkerSlotAbortedError extends Error {
	constructor(message: string = LIVE_WORKER_UNGRANTED_ABORT_MESSAGE) {
		super(message);
		this.name = "AbortError";
	}
}

interface Waiter {
	readonly runId?: string;
	readonly forkName?: string;
	readonly onQueued?: (position: number) => void;
	position: number;
	grant(): void;
}

interface Holder {
	probe?: () => boolean;
	idleSince?: number;
	idleRelease(): void;
}

interface CapState {
	limit: number;
	live: number;
	queue: Waiter[];
	holders: Set<Holder>;
	idleReapMs: number;
	reapIntervalMs: number;
	reaper?: ReturnType<typeof setInterval>;
	now: () => number;
}

const CAP_STATE_KEY = Symbol.for("pi-delegate.liveWorkerCap.v1");

function capState(): CapState {
	const slots = globalThis as unknown as Record<symbol, CapState | undefined>;
	let state = slots[CAP_STATE_KEY];
	if (!state) {
		state = {
			limit: 0,
			live: 0,
			queue: [],
			holders: new Set(),
			idleReapMs: DEFAULT_LIVE_WORKER_IDLE_REAP_MS,
			reapIntervalMs: DEFAULT_LIVE_WORKER_REAP_INTERVAL_MS,
			now: Date.now,
		};
		slots[CAP_STATE_KEY] = state;
	}
	return state;
}

/** Normalize a configured value: a positive safe integer, otherwise unlimited. */
export function normalizeMaxLiveWorkers(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 0;
}

function hasFreeSlot(state: CapState): boolean {
	return state.limit === 0 || state.live < state.limit;
}

function notifyPositions(state: CapState): void {
	state.queue.forEach((waiter, index) => {
		const position = index + 1;
		if (waiter.position === position) return;
		waiter.position = position;
		try {
			waiter.onQueued?.(position);
		} catch {
			// Position publication is best effort; it must not stall the queue.
		}
	});
}

function drain(state: CapState): void {
	while (state.queue.length > 0 && hasFreeSlot(state)) {
		const next = state.queue.shift()!;
		state.live += 1;
		next.grant();
	}
	notifyPositions(state);
}

/**
 * Wait in the shared FIFO queue. `grant` runs with the slot already counted.
 * Resolves at once, without queueing, when nobody is waiting and a slot is free.
 */
function waitForSlot(
	state: CapState,
	options: { signal?: AbortSignal; runId?: string; forkName?: string; onQueued?: (position: number) => void },
	register?: (cancel: () => void) => void,
): Promise<void> {
	const signal = options.signal;
	if (signal?.aborted) return Promise.reject(new LiveWorkerSlotAbortedError());
	// Strict FIFO: a newcomer never overtakes a queued run.
	if (state.queue.length === 0 && hasFreeSlot(state)) {
		state.live += 1;
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		const leave = () => {
			const index = state.queue.indexOf(waiter);
			if (index < 0) return;
			state.queue.splice(index, 1);
			signal?.removeEventListener("abort", leave);
			reject(new LiveWorkerSlotAbortedError(LIVE_WORKER_QUEUED_ABORT_MESSAGE));
			notifyPositions(state);
		};
		const waiter: Waiter = {
			runId: options.runId,
			forkName: options.forkName,
			onQueued: options.onQueued,
			position: 0,
			grant: () => {
				signal?.removeEventListener("abort", leave);
				resolve();
			},
		};
		state.queue.push(waiter);
		signal?.addEventListener("abort", leave, { once: true });
		register?.(leave);
		drain(state);
	});
}

function reapIdleHolders(state: CapState): void {
	const now = state.now();
	for (const holder of state.holders) {
		let idle: boolean;
		try {
			idle = holder.probe?.() === true;
		} catch {
			idle = false;
		}
		if (!idle) {
			holder.idleSince = undefined;
			continue;
		}
		holder.idleSince ??= now;
		if (state.queue.length > 0 && now - holder.idleSince >= state.idleReapMs) holder.idleRelease();
	}
}

function syncReaper(state: CapState): void {
	const needed = [...state.holders].some((holder) => holder.probe !== undefined);
	if (needed && !state.reaper) {
		state.reaper = setInterval(() => reapIdleHolders(state), state.reapIntervalMs);
		state.reaper.unref?.();
	} else if (!needed && state.reaper) {
		clearInterval(state.reaper);
		state.reaper = undefined;
	}
}

function makeLease(state: CapState, base: AcquireLiveWorkerSlotOptions, waitedMs: number): LiveWorkerLease {
	let released = false;
	let holding = true;
	let pending: Promise<void> | undefined;
	let cancelPending: (() => void) | undefined;
	const holder: Holder = {
		idleRelease: () => {
			if (released || !holding) return;
			holding = false;
			holder.idleSince = undefined;
			state.holders.delete(holder);
			syncReaper(state);
			state.live = Math.max(0, state.live - 1);
			drain(state);
		},
	};
	const hold = () => {
		holding = true;
		state.holders.add(holder);
		syncReaper(state);
	};
	hold();
	return {
		get released() {
			return released;
		},
		get holding() {
			return holding;
		},
		waitedMs,
		release() {
			if (released) return;
			released = true;
			state.holders.delete(holder);
			syncReaper(state);
			cancelPending?.();
			if (holding) {
				holding = false;
				state.live = Math.max(0, state.live - 1);
				drain(state);
			}
		},
		reacquire(signal) {
			if (holding) return Promise.resolve();
			if (released) return Promise.reject(new LiveWorkerSlotAbortedError());
			pending ??= waitForSlot(
				state,
				{ signal, runId: base.runId, forkName: base.forkName, onQueued: base.onQueued },
				(cancel) => { cancelPending = cancel; },
			).then(
				() => {
					pending = undefined;
					cancelPending = undefined;
					if (released) {
						// Released while the grant was in flight: hand the slot straight on.
						state.live = Math.max(0, state.live - 1);
						drain(state);
						throw new LiveWorkerSlotAbortedError();
					}
					hold();
				},
				(error: unknown) => {
					pending = undefined;
					cancelPending = undefined;
					throw error;
				},
			);
			return pending;
		},
		setIdleProbe(probe) {
			holder.probe = probe;
			holder.idleSince = undefined;
			syncReaper(state);
		},
	};
}

/**
 * Take a slot for one leaf worker, waiting in FIFO order while the cap is full.
 *
 * The configured limit is applied on every call, so a changed `maxLiveWorkers`
 * takes effect for the next acquisition. Lowering it never preempts a holder;
 * raising it admits queued runs at once.
 */
export async function acquireLiveWorkerSlot(options: AcquireLiveWorkerSlotOptions): Promise<LiveWorkerLease> {
	const state = capState();
	const now = options.now ?? Date.now;
	state.limit = normalizeMaxLiveWorkers(options.max);
	// Unlimited admission never waits, so a cancel has nothing to interrupt here:
	// the runner's own abort check reports it as before the cap existed.
	const signal = state.limit === 0 ? undefined : options.signal;
	if (signal?.aborted) throw new LiveWorkerSlotAbortedError();
	const queuedAt = now();
	await waitForSlot(state, { ...options, signal });
	return makeLease(state, options, Math.max(0, now() - queuedAt));
}

/** Live and queued counts for status surfaces. */
export function liveWorkerCapSnapshot(): LiveWorkerCapSnapshot {
	const state = capState();
	return { max: state.limit, live: state.live, queued: state.queue.length };
}

/** 1-based queue position of one run entry, or `undefined` when it is not queued. */
export function liveWorkerQueuePosition(runId: string, forkName: string): number | undefined {
	const index = capState().queue.findIndex((waiter) => waiter.runId === runId && waiter.forkName === forkName);
	return index < 0 ? undefined : index + 1;
}

/** Number of this run's entries waiting for a slot. */
export function queuedLiveWorkerCount(runId: string): number {
	return capState().queue.filter((waiter) => waiter.runId === runId).length;
}

/** Run one reaper pass now. Tests only. */
export function __reapIdleLiveWorkersForTests(): void {
	reapIdleHolders(capState());
}

/** Override reaper timing and clock. Tests only; applies to the current state. */
export function __setLiveWorkerReaperForTests(options: { idleReapMs?: number; reapIntervalMs?: number; now?: () => number }): void {
	const state = capState();
	if (options.idleReapMs !== undefined) state.idleReapMs = options.idleReapMs;
	if (options.now !== undefined) state.now = options.now;
	if (options.reapIntervalMs !== undefined) {
		state.reapIntervalMs = options.reapIntervalMs;
		if (state.reaper) {
			clearInterval(state.reaper);
			state.reaper = undefined;
			syncReaper(state);
		}
	}
}

/** Reset the shared counter. Tests only: leases from before the reset stop counting. */
export function __resetLiveWorkerCapForTests(): void {
	const slots = globalThis as unknown as Record<symbol, CapState | undefined>;
	const state = slots[CAP_STATE_KEY];
	if (state?.reaper) clearInterval(state.reaper);
	delete slots[CAP_STATE_KEY];
}
