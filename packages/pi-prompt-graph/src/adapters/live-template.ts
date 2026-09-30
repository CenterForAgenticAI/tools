import { randomUUID } from "node:crypto";
import type { TemplateAck, TemplateCapabilities, TemplateCompletion, TemplateInvocation, TemplateRefusalReason } from "./template.js";

/**
 * PTM's event names, reproduced exactly.
 *
 * These are strings on a shared bus, not imports: the graph MUST NOT import
 * `pi-prompt-template-model` (D-006, D-054). Copying the names is the price of
 * that boundary, and getting one wrong fails silently — nothing answers — which
 * is why `probeCapabilities` below asks the bus rather than assuming.
 */
export const PROMPT_INVOKE_EVENT = "prompt-template:prompt:invoke";
export const PROMPT_INVOKE_ACK_EVENT = "prompt-template:prompt:invoke:ack";
export const PROMPT_STARTED_EVENT = "prompt-template:prompt:started";
export const PROMPT_FINISHED_EVENT = "prompt-template:prompt:finished";
export const PROMPT_PROTOCOL_VERSION = 1 as const;

/** The refusal reasons PTM publishes. An unrecognised one is not assumed benign. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set([
	"busy", "chain-template", "invalid-request", "not-ready", "unknown-template", "unsupported-context",
]);

/**
 * The slice of Pi this seam uses.
 *
 * Declared structurally rather than imported so the adapter's tests can supply a
 * plain object. Pi's own `ExtensionAPI` satisfies it.
 */
export interface EventBus {
	emit(event: string, payload: unknown): void;
	// `unknown`, not `any`: every payload here crosses an extension boundary and
	// is read field by field below rather than trusted.
	on(event: string, listener: (payload: unknown) => void): unknown;
}

export interface TurnSource {
	on(event: string, listener: (payload: unknown, ctx?: unknown) => void): unknown;
}

export interface LiveTemplateSessionOptions {
	readonly events: EventBus;
	/** Pi itself, for `turn_end`. Counting turns is what makes corroboration possible (D-051). */
	readonly turns: TurnSource;
	/**
	 * How long to wait for PTM's acknowledgement of an invocation.
	 *
	 * Short by design: an ack is a synchronous decision by an extension already
	 * loaded in this session, not work. Waiting minutes for one only delays
	 * discovering that nothing is listening.
	 */
	readonly ackTimeoutMs?: number;
	/**
	 * How long to wait for a started template to report finishing, when the node
	 * declares no timeout of its own.
	 *
	 * Expiry is NOT a node failure here. It is the wedge signature: started, and
	 * then nothing, with no error and no timeout of the peer's own. §11.2.2 makes
	 * that a run-level fault, so this resolves `undefined` and the adapter
	 * suspends the run.
	 */
	readonly completionTimeoutMs?: number;
}

const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 900_000;

interface Span {
	readonly runId: string;
	readonly turnsAtStart: number;
}

/**
 * The live half of Mode A: a `TemplateSession` that reaches a real PTM.
 *
 * Everything that DECIDES lives behind the port in `template.ts` and is proven
 * by test. This class only carries messages and counts turns, which is the part
 * no test can prove — the D-054 split, and the reason it is a separate file.
 *
 * The event sequence, all of it measured by spike S5 driving a real PTM:
 *
 * 1. emit `prompt-template:prompt:invoke` with a fresh `requestId`
 * 2. PTM answers `…:invoke:ack`, correlated by that `requestId`, either
 *    accepting with a `runId` of its own or refusing with a reason
 * 3. PTM emits `…:started` then `…:finished`, both correlated by `runId`
 *
 * Two ordering hazards, both real, both handled:
 *
 * - **`finished` can arrive before anything awaits it.** A deterministic
 *   template finishes in milliseconds. Late listeners would hang forever, so
 *   arrivals are recorded as they land and a waiter checks the record first.
 * - **A turn counter must be sampled at `started`, not at invoke.** The window
 *   that matters is PTM's, and the gap between asking and starting is not the
 *   node's work.
 */
export class LiveTemplateSession {
	private readonly options: LiveTemplateSessionOptions;
	private turnsSeen = 0;
	private readonly acks = new Map<string, unknown>();
	private readonly started = new Map<string, unknown>();
	private readonly finished = new Map<string, unknown>();
	private readonly spans = new Map<string, Span>();
	private readonly ackWaiters = new Map<string, (payload: unknown) => void>();
	private readonly startedWaiters = new Map<string, (payload: unknown) => void>();
	private readonly finishedWaiters = new Map<string, (payload: unknown) => void>();

	constructor(options: LiveTemplateSessionOptions) {
		this.options = options;
		const { events, turns } = options;

		events.on(PROMPT_INVOKE_ACK_EVENT, (payload: unknown) => {
			const requestId = readString(payload, "requestId");
			if (!requestId) return;
			this.acks.set(requestId, payload);
			this.ackWaiters.get(requestId)?.(payload);
		});

		events.on(PROMPT_STARTED_EVENT, (payload: unknown) => {
			const runId = readString(payload, "runId");
			if (!runId) return;
			// Sampled here, not at invoke: the node's window is the one PTM opened.
			this.spans.set(runId, { runId, turnsAtStart: this.turnsSeen });
			this.started.set(runId, payload);
			this.startedWaiters.get(runId)?.(payload);
		});

		events.on(PROMPT_FINISHED_EVENT, (payload: unknown) => {
			const runId = readString(payload, "runId");
			if (!runId) return;
			this.finished.set(runId, payload);
			this.finishedWaiters.get(runId)?.(payload);
		});

		// The corroboration signal. Without this the adapter would refuse every
		// node for want of a model turn, which is why it is wired here and not
		// left to a caller to remember.
		turns.on("turn_end", () => { this.turnsSeen += 1; });
	}

	async invoke(invocation: TemplateInvocation): Promise<TemplateAck> {
		const requestId = randomUUID();
		const wait = this.wait(this.ackWaiters, this.acks, requestId, this.options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
		this.options.events.emit(PROMPT_INVOKE_EVENT, {
			protocolVersion: PROMPT_PROTOCOL_VERSION,
			requestId,
			name: invocation.name,
			...(invocation.args ? { args: invocation.args } : {}),
		});
		const ack = await wait;

		// Nothing answered. Reported as `not-ready` rather than invented as a new
		// reason: from the graph's side an unanswered invocation and a PTM that
		// says it is not ready are the same fact, and both are terminal for the
		// attempt.
		if (ack === undefined) return { accepted: false, reason: "not-ready" };

		if (readBoolean(ack, "accepted") === true) {
			const runId = readString(ack, "runId");
			// Accepted with no run id is a malformed answer, not an acceptance:
			// without one, nothing can correlate the lifecycle events that follow.
			return runId ? { accepted: true, runId } : { accepted: false, reason: "invalid-request" };
		}
		const reason = readString(ack, "reason");
		// An unrecognised reason is `invalid-request`, never a guess at something
		// benign. D-066 made exactly this mistake in the other direction.
		return { accepted: false, reason: reason && KNOWN_REFUSALS.has(reason) ? reason as TemplateRefusalReason : "invalid-request" };
	}

	async awaitCompletion(runId: string, invocation: TemplateInvocation): Promise<TemplateCompletion | undefined> {
		const budget = invocation.timeoutMs ?? this.options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
		// `started` may already have landed; the waiter checks the record first.
		await this.wait(this.startedWaiters, this.started, runId, budget);
		const finished = await this.wait(this.finishedWaiters, this.finished, runId, budget);

		// Started, then silence. No completion, no failure, no timeout of PTM's
		// own — the wedge S5 measured. `undefined` tells the adapter to suspend
		// the run rather than fail the node (§11.2.2).
		if (finished === undefined) return undefined;

		const span = this.spans.get(runId);
		const status = readString(finished, "status");
		return {
			// PTM emits `finished` from a `finally` block, so it reports a
			// completion even when the prompt threw. An unrecognised status is
			// `failed`, never `completed`.
			status: status === "completed" || status === "cancelled" ? status : "failed",
			changed: readBoolean(finished, "changed") === true,
			...(readString(finished, "lastText") ? { lastText: readString(finished, "lastText")! } : {}),
			// The window is PTM's own: turns since it said `started`.
			turnsInWindow: span ? Math.max(0, this.turnsSeen - span.turnsAtStart) : 0,
		};
	}

	/**
	 * Wait for a correlated payload, resolving `undefined` when the bound expires.
	 *
	 * A payload that has already arrived resolves immediately. Without that, a
	 * deterministic template finishing in milliseconds would leave every waiter
	 * registered after the fact hanging until its timeout.
	 */
	private wait(waiters: Map<string, (payload: unknown) => void>, arrived: Map<string, unknown>, key: string, timeoutMs: number): Promise<unknown> {
		const already = arrived.get(key);
		if (already !== undefined) return Promise.resolve(already);
		return new Promise((resolve) => {
			const timer = setTimeout(() => { waiters.delete(key); resolve(undefined); }, timeoutMs);
			timer.unref?.();
			waiters.set(key, (payload: unknown) => {
				clearTimeout(timer);
				waiters.delete(key);
				resolve(payload);
			});
		});
	}
}

/**
 * Ask the session whether a PTM able to run a graph node is present.
 *
 * It is a probe, not a version check: the graph cannot import PTM to ask, and a
 * version string would not prove the events are wired anyway. So it emits a real
 * invocation for a template name that cannot exist and reads what comes back.
 *
 * - **A refusal is a pass.** Something answered the invocation event, which is
 *   the capability being tested. `unknown-template` is the expected answer, and
 *   the sentinel name is deliberately one no template directory would hold.
 * - **Silence is a fail.** No listener, or a PTM too old to have the channel.
 *
 * `publishesLifecycle` cannot be probed without running a real template, so it
 * is reported as equal to `canInvoke`: the fork that added the invocation
 * channel added the lifecycle events in the same protocol version. A PTM that
 * had one and not the other would be refused later by the wedge rule rather
 * than here, which is the safe direction to be wrong in.
 */
export async function probeCapabilities(events: EventBus, timeoutMs = 2_000): Promise<TemplateCapabilities> {
	const requestId = randomUUID();
	const answered = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
		events.on(PROMPT_INVOKE_ACK_EVENT, (payload: unknown) => {
			if (readString(payload, "requestId") !== requestId) return;
			clearTimeout(timer);
			resolve(true);
		});
		events.emit(PROMPT_INVOKE_EVENT, {
			protocolVersion: PROMPT_PROTOCOL_VERSION,
			requestId,
			name: "__pi_prompt_graph_capability_probe__",
		});
	});
	return { canInvoke: answered, publishesLifecycle: answered };
}

function readString(payload: unknown, key: string): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function readBoolean(payload: unknown, key: string): boolean | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : undefined;
}
