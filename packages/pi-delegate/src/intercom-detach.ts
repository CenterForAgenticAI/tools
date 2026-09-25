/**
 * pi-intercom graceful-detach responder.
 *
 * When pi-intercom receives an inbound message and the parent session is
 * mid-turn (`!ctx.isIdle()`), it emits `pi-intercom:detach-request` on
 * `pi.events`. If a listener replies with `{ requestId, accepted: true }`
 * on `pi-intercom:detach-response` within the configured timeout
 * (`INTERCOM_DETACH_TIMEOUT_MS` in pi-intercom), intercom delivers the
 * message via `triggerTurn`/`followUp` semantics on the *next* turn
 * INSTEAD of calling `ctx.abort()` to interrupt the current turn.
 *
 * Why pi-delegate cares: aborting the parent turn fires the per-run
 * AbortController in pi-agent-core, which fans out to every in-flight
 * tool call's `signal`. Sync delegate calls that haven't returned yet
 * see their `dispatchAbort` cascade-fired through the
 * `signal.addEventListener("abort", …)` wiring in `executeChainShape` /
 * `executeDirectShape` / `executeDelegateTool` — and even after the
 * `wireSignalToDispatch` gate decouples DISPATCH mode, SYNC mode still
 * legitimately runs delegated work tied to the parent signal. The ergonomic right
 * answer is: don't abort the parent turn when a delegate run is alive,
 * just queue the inbound message for the next turn.
 *
 * The decision to ACK is gated on having at least one ACTIVE run in the
 * runtime registry. Idle sessions opt out — the parent agent has no
 * delegate state worth protecting and the default abort-and-deliver flow
 * is fine for everyone else.
 *
 * Mirrors the equivalent handler in pi-subagents at
 * `pi-subagents/execution.ts:245`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isOwnedByThisProcess, listActiveRuns } from "./runtime.js";

/** Channel name pi-intercom emits when it wants to know if anyone wants to detach. */
export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
/** Channel name pi-intercom listens on for the detach response. */
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";

export interface IntercomDetachHandle {
	/** Remove the event listener. Idempotent. */
	dispose: () => void;
}

export interface InstallIntercomDetachOptions {
	/**
	 * Override the active-run probe. Production wires this to
	 * `() => listActiveRuns().filter(isOwnedByThisProcess).length > 0`;
	 * tests pass a deterministic stub (always-true / always-false / counter)
	 * so they don't have to register fake runs in the runtime singleton.
	 */
	hasActiveRuns?: () => boolean;
}

/**
 * Subset of `pi.events` that this module needs. Pinning the contract here
 * keeps the unit test from having to construct a full ExtensionAPI mock.
 */
export interface DetachEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Install a one-shot listener that responds to pi-intercom's graceful-
 * detach request whenever pi-delegate has at least one active run owned by
 * this foreground process (sync, dispatch, chain, or supervised — anything
 * not yet completed).
 *
 * Returns a handle whose `dispose()` removes the listener. Production
 * wires this once at activation / session_start and disposes on
 * session_shutdown.
 */
export function installIntercomDetachResponder(
	pi: { events: DetachEventBus } | { events: ExtensionAPI["events"] },
	opts: InstallIntercomDetachOptions = {},
): IntercomDetachHandle {
	const probe = opts.hasActiveRuns ?? (() => listActiveRuns().filter(isOwnedByThisProcess).length > 0);
	const events = (pi as { events: DetachEventBus }).events;
	const off = events.on(INTERCOM_DETACH_REQUEST_EVENT, (payload: unknown) => {
		if (!payload || typeof payload !== "object") return;
		const requestId = (payload as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string" || requestId.length === 0) return;
		if (!probe()) return;
		try {
			events.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
		} catch {
			// pi.events.emit shouldn't throw; never let an emit failure
			// propagate up into the event bus and crash unrelated handlers.
		}
	});
	return {
		dispose: () => {
			try {
				off?.();
			} catch {
				/* already disposed */
			}
		},
	};
}
