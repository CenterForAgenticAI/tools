/**
 * Commit-time liveness guard for compaction.
 *
 * A compaction only reduces the live context when no agent run is in flight.
 * Pi's agent loop runs on a copy of the message array taken when the run
 * started (`Agent.createContextSnapshot()`), and committing a compaction
 * replaces `agent.state.messages` with a new array. A commit that lands while a
 * loop holds that copy therefore changes nothing the running loop sends: the
 * transcript records a boundary the live context never crossed, and the
 * extension reports success for work that did not happen.
 *
 * Idleness at queue time does not survive summarization. Generating a summary
 * takes minutes, and a message arriving inside that window starts a new run, so
 * liveness has to be re-checked at the moment of commit.
 *
 * The seam is deliberately free of Pi types: the caller supplies liveness, the
 * drain, a clock and a sleep, so every decision path is testable without a
 * session.
 */

/** Why the commit was allowed. */
export type CompactionCommitPath =
	/** No agent loop held a message-array copy; the commit applies as prepared. */
	| "no-run-in-flight"
	/** A run was in flight, was ended, and the loop finished inside the budget. */
	| "drained"
	/** The host does not report run liveness; committing preserves its behaviour. */
	| "liveness-unknown";

export type CompactionCommitDecision =
	| {
		readonly commit: true;
		readonly path: CompactionCommitPath;
		readonly waitedMs: number;
	}
	| {
		readonly commit: false;
		readonly reason: "run-in-flight";
		readonly waitedMs: number;
		readonly drainTimeoutMs: number;
	};

export interface CompactionCommitGuardHooks {
	/**
	 * Whether an agent loop currently holds its own copy of the message array.
	 * `null` when the host does not expose run liveness at all.
	 */
	isRunInFlight(): boolean | null;
	/** End the in-flight run so the boundary can apply to a quiet session. */
	drainInFlightRun(): void;
	/**
	 * Whether the provider drain and every settlement handler have completed.
	 * Hosts without a drain barrier can omit this hook; their existing liveness
	 * behavior remains unchanged.
	 */
	isDrainSettled?(): boolean;
	sleep(ms: number): Promise<void>;
	now(): number;
	note(message: string): void;
}

export interface CompactionCommitGuardOptions {
	/** How long to wait for the ended run to finish before abandoning the commit. */
	readonly drainTimeoutMs?: number;
	readonly pollIntervalMs?: number;
}

/**
 * Ten seconds: ending a run is signal-based and normally unwinds in
 * milliseconds, and a loop still running long after that is not about to
 * release the snapshot. Abandoning the commit costs one re-queued compaction;
 * committing anyway costs a boundary that no request ever crosses.
 */
export const DEFAULT_COMMIT_DRAIN_TIMEOUT_MS = 10_000;
export const COMMIT_DRAIN_POLL_INTERVAL_MS = 25;

/**
 * Decide whether a prepared compaction may be committed now.
 *
 * The quiet case is untouched: with no run in flight the decision is immediate
 * and nothing is aborted. Otherwise the run is ended first — the drain path this
 * extension already owns — and the commit waits for that run to finish. A run
 * that outlives the budget produces a refusal, which the caller must report as
 * unapplied rather than recording a boundary.
 */
export async function decideCompactionCommit(
	hooks: CompactionCommitGuardHooks,
	options: CompactionCommitGuardOptions = {},
): Promise<CompactionCommitDecision> {
	const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_COMMIT_DRAIN_TIMEOUT_MS;
	const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? COMMIT_DRAIN_POLL_INTERVAL_MS);
	const startedAt = hooks.now();

	const initial = hooks.isRunInFlight();
	if (initial === null) {
		hooks.note("commit guard: host does not report agent run liveness; committing as prepared");
		return { commit: true, path: "liveness-unknown", waitedMs: 0 };
	}
	const isDrainSettled = hooks.isDrainSettled ?? (() => true);
	if (!initial && isDrainSettled()) return { commit: true, path: "no-run-in-flight", waitedMs: 0 };

	if (initial) {
		hooks.note(`commit guard: an agent run is in flight at commit time; ending it before the boundary (budget ${drainTimeoutMs}ms)`);
		hooks.drainInFlightRun();
	} else {
		hooks.note("commit guard: the run ended before commit, but its provider drain is still settling");
	}

	for (;;) {
		const elapsedMs = Math.max(0, hooks.now() - startedAt);
		const inFlight = hooks.isRunInFlight();
		const settled = isDrainSettled();
		if (inFlight === null && settled) {
			hooks.note(`commit guard: agent run liveness became unreadable after ${elapsedMs}ms; the provider drain is settled, committing as prepared`);
			return { commit: true, path: "liveness-unknown", waitedMs: elapsedMs };
		}
		if (!inFlight && settled) {
			hooks.note(`commit guard: the in-flight run ended after ${elapsedMs}ms and its provider drain settled; committing against a quiet session`);
			return { commit: true, path: initial ? "drained" : "no-run-in-flight", waitedMs: elapsedMs };
		}
		if (elapsedMs >= drainTimeoutMs) {
			hooks.note(`commit guard: an agent run or its settlement path was still active ${elapsedMs}ms after it was ended; abandoning this commit instead of recording a boundary the live context never crossed`);
			return { commit: false, reason: "run-in-flight", waitedMs: elapsedMs, drainTimeoutMs };
		}
		await hooks.sleep(Math.min(pollIntervalMs, drainTimeoutMs - elapsedMs));
	}
}
