/** Receiving deferred worker compaction advisories at a host-owned round boundary.
 *
 * This is the pi-delegate half of the settled cross-repository
 * `context-aware.worker-compaction.v1` handshake. **Neither package imports the
 * other.** This module deliberately restates the wire shape as plain JSON so
 * the optional context-aware extension does not become a hard dependency of
 * pi-delegate. This follows the same seam pattern as
 * `session-role-seam.ts` and `task-seam.ts`.
 *
 * Unknown fields stay valid so a newer producer can extend the payload without
 * breaking this consumer. When the producer is absent, no matching session
 * entry exists and the host keeps its existing round behavior.
 */

/** The custom session-entry type carrying worker compaction advisories. */
export const WORKER_COMPACTION_CHANNEL = "context-aware.worker-compaction.v1" as const;

/** The only schema version this consumer understands. */
export const WORKER_COMPACTION_SCHEMA_VERSION = 1 as const;

/** Maximum producer-supplied summary-instruction length. */
export const MAX_INSTRUCTION_CHARS = 4_000;

/** Maximum UTF-8 size of the whole advisory JSON payload. */
export const MAX_ADVISORY_ENTRY_BYTES = 8_192;

/** Finite default budget for model-backed worker compaction. */
export const DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS = 300_000;

export type WorkerCompactionState = "advised" | "required" | "satisfied";
export type WorkerCompactionReason = "threshold" | "generation-reserve" | "output-limit";

/** Plain-JSON payload published by the optional context-aware extension. */
export interface WorkerCompactionAdvisoryV1 {
	readonly schemaVersion: typeof WORKER_COMPACTION_SCHEMA_VERSION;
	readonly state: WorkerCompactionState;
	readonly revision: number;
	readonly observedAt: string;
	readonly usage?: {
		readonly tokens: number;
		readonly contextWindow: number;
		readonly fraction: number;
	};
	readonly reason?: WorkerCompactionReason;
	readonly instructions?: string;
	readonly satisfiedRevision?: number;
}

/** The slice of a worker SessionManager needed to read the durable channel. */
export interface WorkerCompactionEntryReader {
	getEntries(): readonly unknown[];
}

/** The slice of AgentSession needed to execute a deferred compaction. */
export interface WorkerCompactionSession {
	compact(instructions?: string): Promise<unknown>;
	/** Event subscription on current SDKs; optional for older SDKs and test doubles. */
	subscribe?: (listener: (event: unknown) => void) => () => void;
	/** Public on current SDKs; optional for older SDKs and test doubles. */
	abortCompaction?: () => Promise<unknown> | unknown;
}

/** Cancel an in-progress manual compaction when the SDK exposes that path. */
export function abortWorkerCompaction(session: Pick<WorkerCompactionSession, "abortCompaction">): void {
	try {
		const abortCompaction = session.abortCompaction;
		if (typeof abortCompaction !== "function") return;
		void Promise.resolve(abortCompaction.call(session)).catch(() => {});
	} catch {
		/* cancellation is best-effort and must not replace the original failure */
	}
}

export type WorkerCompactionConsumeResult =
	| { readonly kind: "absent" }
	| { readonly kind: "ignored"; readonly revision: number }
	| { readonly kind: "compacted"; readonly revision: number }
	| { readonly kind: "failed"; readonly revision: number; readonly error: string };

export interface WorkerCompactionConsumeOptions {
	/** Existing host boundary wait; manual compaction is separate from `isIdle`. */
	readonly waitForCompactionBoundary: () => Promise<void>;
	/** The owning operation signal; it must race the full compact() promise. */
	readonly signal?: AbortSignal;
	/** Absolute deadline captured before invoking compact(). */
	readonly deadline?: number;
	/** Timeout used when reporting a deadline failure. */
	readonly timeoutMs?: number;
	/** Best-effort diagnostic sink. A throwing sink must not fail the lane. */
	readonly onFailure?: (message: string) => void;
}

type RecordValue = Record<string, unknown>;

const WORKER_COMPACTION_STATES: readonly WorkerCompactionState[] = ["advised", "required", "satisfied"];
const WORKER_COMPACTION_REASONS: readonly WorkerCompactionReason[] = [
	"threshold",
	"generation-reserve",
	"output-limit",
];
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isObservedAt(value: unknown): value is string {
	return typeof value === "string" && ISO_8601_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function payloadFitsByteBound(value: unknown): boolean {
	try {
		const json = JSON.stringify(value);
		return json !== undefined && Buffer.byteLength(json, "utf8") <= MAX_ADVISORY_ENTRY_BYTES;
	} catch {
		return false;
	}
}

function parseUsage(value: unknown): WorkerCompactionAdvisoryV1["usage"] | undefined | null {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return null;
	const { tokens, contextWindow, fraction } = value;
	if (
		typeof tokens !== "number" || !Number.isFinite(tokens) ||
		typeof contextWindow !== "number" || !Number.isFinite(contextWindow) ||
		typeof fraction !== "number" || !Number.isFinite(fraction) ||
		fraction < 0 || fraction > 1
	) return null;
	return { tokens, contextWindow, fraction };
}

/**
 * Validate one untrusted plain-JSON payload from the durable session record.
 * Unknown fields are deliberately omitted from the returned consumer view.
 */
export function parseWorkerCompactionAdvisory(value: unknown): WorkerCompactionAdvisoryV1 | undefined {
	if (!isRecord(value) || !payloadFitsByteBound(value)) return undefined;
	if (value.schemaVersion !== WORKER_COMPACTION_SCHEMA_VERSION) return undefined;
	if (!WORKER_COMPACTION_STATES.includes(value.state as WorkerCompactionState)) return undefined;
	if (!isPositiveSafeInteger(value.revision) || !isObservedAt(value.observedAt)) return undefined;
	const usage = parseUsage(value.usage);
	if (usage === null) return undefined;
	if (value.instructions !== undefined && (
		typeof value.instructions !== "string" || value.instructions.length > MAX_INSTRUCTION_CHARS
	)) return undefined;
	if (value.reason !== undefined && !WORKER_COMPACTION_REASONS.includes(value.reason as WorkerCompactionReason)) {
		return undefined;
	}
	if (value.satisfiedRevision !== undefined && !isPositiveSafeInteger(value.satisfiedRevision)) return undefined;
	const reason = value.reason as WorkerCompactionReason | undefined;
	const instructions = value.instructions as string | undefined;
	const satisfiedRevision = value.satisfiedRevision as number | undefined;
	return {
		schemaVersion: WORKER_COMPACTION_SCHEMA_VERSION,
		state: value.state as WorkerCompactionState,
		revision: value.revision,
		observedAt: value.observedAt,
		...(usage === undefined ? {} : { usage }),
		...(reason === undefined ? {} : { reason }),
		...(instructions === undefined ? {} : { instructions }),
		...(satisfiedRevision === undefined ? {} : { satisfiedRevision }),
	};
}

/** Read the highest valid revision from the worker's custom-entry channel. */
export function readLatestWorkerCompactionAdvisory(
	entries: readonly unknown[],
): WorkerCompactionAdvisoryV1 | undefined {
	let latest: WorkerCompactionAdvisoryV1 | undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== WORKER_COMPACTION_CHANNEL) continue;
		const advisory = parseWorkerCompactionAdvisory(entry.data);
		if (advisory && (latest === undefined || advisory.revision > latest.revision)) latest = advisory;
	}
	return latest;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function makeAbortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function makeCompactionTimeoutError(timeoutMs: number): Error {
	return new Error(`Timed out waiting ${timeoutMs}ms for agent session compaction to finish`);
}

function isCompactionStartEvent(event: unknown): boolean {
	return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "compaction_start";
}

/** Keep the provider-backed compact() operation bounded from invocation onward. */
function raceCompactionPromise(
	compacting: Promise<unknown>,
	signal: AbortSignal | undefined,
	deadline: number,
	timeoutMs: number,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const state: {
			timer?: ReturnType<typeof setTimeout>;
			abortListener?: () => void;
		} = {};
		let settled = false;
		const cleanup = () => {
			if (state.timer !== undefined) clearTimeout(state.timer);
			if (state.abortListener && signal) signal.removeEventListener("abort", state.abortListener);
		};
		const settle = (callback: (value?: unknown) => void, value?: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback(value);
		};
		const onAbort = () => settle(reject, makeAbortError());
		state.abortListener = onAbort;
		// Always observe the provider promise, even when the operation is already
		// cancelled or over budget, so a late provider rejection is not unhandled.
		void Promise.resolve(compacting).then(
			(value) => settle(resolve, value),
			(error) => settle(reject, error),
		);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			settle(reject, makeCompactionTimeoutError(timeoutMs));
			return;
		}
		state.timer = setTimeout(() => settle(reject, makeCompactionTimeoutError(timeoutMs)), remainingMs);
		(state.timer as unknown as { unref?: () => void }).unref?.();
	});
}

/**
 * Per-worker consumer state. A successful compaction spends one revision;
 * failed housekeeping leaves it retryable at the next host-owned boundary.
 */
export class WorkerCompactionConsumer {
	private lastActedRevision = 0;

	constructor(
		private readonly entries: WorkerCompactionEntryReader,
		private readonly session: WorkerCompactionSession,
	) {}

	async consume(options: WorkerCompactionConsumeOptions): Promise<WorkerCompactionConsumeResult> {
		let advisory: WorkerCompactionAdvisoryV1 | undefined;
		try {
			advisory = readLatestWorkerCompactionAdvisory(this.entries.getEntries());
		} catch (error) {
			const message = `worker compaction advisory read failed: ${errorMessage(error)}`;
			try { options.onFailure?.(message); } catch { /* diagnostics must not fail the lane */ }
			return { kind: "failed", revision: 0, error: message };
		}
		if (advisory === undefined) return { kind: "absent" };
		if (advisory.state === "satisfied" || advisory.revision <= this.lastActedRevision) {
			return { kind: "ignored", revision: advisory.revision };
		}

		let compacting: Promise<unknown> | undefined;
		let compactSettled = false;
		let cancellationRequested = false;
		let unsubscribeCompactionStart: (() => void) | undefined;
		const cleanupCompactionStart = () => {
			const unsubscribe = unsubscribeCompactionStart;
			unsubscribeCompactionStart = undefined;
			try { unsubscribe?.(); } catch { /* observer cleanup is best-effort */ }
		};
		try {
			const subscribe = this.session.subscribe;
			if (typeof subscribe === "function") {
				try {
					const unsubscribe = subscribe.call(this.session, (event) => {
						if (cancellationRequested && isCompactionStartEvent(event)) {
							abortWorkerCompaction(this.session);
						}
					});
					if (typeof unsubscribe === "function") unsubscribeCompactionStart = unsubscribe;
				} catch {
					/* optional SDK observation must not prevent compaction */
				}
			}
			const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_COMPACTION_WAIT_TIMEOUT_MS;
			// Capture the deadline before invocation. The provider request may spend
			// time becoming visible as compaction, so the boundary wait cannot own
			// the whole operation's budget by itself.
			const deadline = options.deadline ?? Date.now() + timeoutMs;
			compacting = advisory.instructions === undefined
				? this.session.compact()
				: this.session.compact(advisory.instructions);
			// Observe settlement immediately so a late provider rejection is handled
			// and the start observer remains armed without blocking this consumer.
			void Promise.resolve(compacting).then(
				() => {
					compactSettled = true;
					cleanupCompactionStart();
				},
				() => {
					compactSettled = true;
					cleanupCompactionStart();
				},
			);
			// Attach the owning budget and signal race immediately after invocation.
			// `compact()` first awaits the session's idle abort; yield once so the
			// SDK can expose its distinct `isCompacting` state before the existing
			// boundary helper inspects it.
			const boundedCompacting = raceCompactionPromise(compacting, options.signal, deadline, timeoutMs);
			await Promise.resolve();
			await Promise.all([boundedCompacting, options.waitForCompactionBoundary()]);
			this.lastActedRevision = advisory.revision;
			return { kind: "compacted", revision: advisory.revision };
		} catch (error) {
			cancellationRequested = true;
			abortWorkerCompaction(this.session);
			if (compacting === undefined || compactSettled) cleanupCompactionStart();
			const message = `worker compaction revision ${advisory.revision} failed: ${errorMessage(error)}`;
			try { options.onFailure?.(message); } catch { /* diagnostics must not fail the lane */ }
			return { kind: "failed", revision: advisory.revision, error: message };
		}
	}
}
