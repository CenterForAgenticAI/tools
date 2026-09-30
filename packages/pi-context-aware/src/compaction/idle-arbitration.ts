/**
 * Shared arbitration for extension work that must wait for a quiet agent.
 *
 * A queued interaction may run only at Pi's public idle boundary. Consumers
 * keep their work queued while the agent is active and retry from
 * `agent_settled`; they must not invent a second active-run check.
 */

export interface QueuedInteractionState {
	readonly isIdle: boolean;
}

export type QueuedInteractionWaitFor = "none" | "agent_settled";

export interface QueuedInteractionArbitration {
	readonly mayRun: boolean;
	readonly waitFor: QueuedInteractionWaitFor;
}

/** Decide whether queued extension work may run, and the boundary to retry at. */
export function arbitrateQueuedInteraction(state: QueuedInteractionState): QueuedInteractionArbitration {
	return state.isIdle
		? { mayRun: true, waitFor: "none" }
		: { mayRun: false, waitFor: "agent_settled" };
}

/** Predicate form for callers that only need the safe-to-run decision. */
export function mayRunQueuedInteraction(state: QueuedInteractionState): boolean {
	return arbitrateQueuedInteraction(state).mayRun;
}
