/**
 * What a live session does *to* a run, decided as data.
 *
 * Stage 3's last three criteria all have the same shape: something outside the
 * graph — a person typing, a session ending, a compaction — interrupts a run
 * that is otherwise minding its own business. Each has a rule about *when* the
 * interruption may take effect, and each of those rules is a decision, so it
 * lives here where it can be tested without a session (the D-054 separation).
 *
 * The session wiring that observes these events is `src/runners/lifecycle.ts`.
 * This file has no Pi, no clock, no filesystem.
 */

/** Why a run stopped between nodes rather than at a terminal. */
export type InterruptionKind = "operator-input" | "session-ended";

/**
 * A request to interrupt a run, recorded the moment it arrives.
 *
 * It carries no node id on purpose: an interruption belongs to the **run**, not
 * to whichever node happened to be in flight when it landed. Which node was
 * running is already in the journal.
 */
export interface Interruption {
	readonly kind: InterruptionKind;
	/** Free text for the journal and the operator, never parsed. */
	readonly detail?: string;
}

/**
 * Somewhere a run checks for a pending interruption.
 *
 * A `Promise`-free, synchronous read: the run loop asks between nodes and must
 * not await anything to find out, or the check itself becomes a place a node
 * boundary can slip past.
 */
export interface InterruptionSource {
	pending(): Interruption | undefined;
}

/**
 * What the run loop should do at a node boundary.
 *
 * `continue` is the overwhelmingly common answer, so it is the one with no
 * payload: a run that is not being interrupted pays nothing for this.
 */
export type BoundaryDecision =
	| { readonly action: "continue" }
	| { readonly action: "pause"; readonly reason: "operator-input"; readonly detail?: string }
	| { readonly action: "suspend"; readonly reason: "session-ended"; readonly detail?: string };

const CONTINUE: BoundaryDecision = { action: "continue" };

/**
 * Decide what a pending interruption means at a node boundary.
 *
 * The distinction that matters is **who is still there afterwards**:
 *
 * - **Operator input pauses.** A person is present and about to say something,
 *   so the run stops and waits for them to resume, cancel, or send it. Their
 *   message is never delivered into a node's turn: it would join that node's
 *   context and change its output, and it would move the session leaf that the
 *   collapse anchor depends on (D-021).
 * - **A session ending suspends.** Nobody is present at all, so there is
 *   nothing to wait for in this process. The run is written down and left for a
 *   person to decide about later (D-022).
 *
 * Both are checked at a **boundary**, never mid-node. Waiting for the boundary
 * is why every node has a timeout: without one a hung node would hold the
 * session with no way out.
 */
export function decideAtBoundary(pending: Interruption | undefined): BoundaryDecision {
	if (!pending) return CONTINUE;
	if (pending.kind === "operator-input") {
		return { action: "pause", reason: "operator-input", ...(pending.detail ? { detail: pending.detail } : {}) };
	}
	return { action: "suspend", reason: "session-ended", ...(pending.detail ? { detail: pending.detail } : {}) };
}

/**
 * Whether a graph's collapse anchor may be used at all.
 *
 * `collapse: on-back-edge` folds a cycle's transcript back to a remembered
 * session entry. That entry id is a weak reference: a compaction rewrites the
 * session tree and the id may no longer resolve.
 *
 * Two independent reasons to refuse, and neither is a failure:
 *
 * - **The graph did not ask for it.** `collapse: "off"` is the default.
 * - **`pi-context-aware` is absent.** Without the peer that owns compaction,
 *   the graph cannot be told a compaction happened, so it holds an anchor it
 *   cannot protect. `.spec/0009` C1 says it SHOULD warn once and disable
 *   collapse rather than navigate to an id it cannot trust — degrading rather
 *   than failing, because collapse is an optimisation and not a capability the
 *   graph's correctness rests on.
 */
export function collapseEnabled(collapse: "off" | "on-back-edge", contextAwarePresent: boolean): boolean {
	return collapse === "on-back-edge" && contextAwarePresent;
}

/** Why collapse is not in force, for the one warning a run may emit about it. */
export function collapseDisabledReason(collapse: "off" | "on-back-edge", contextAwarePresent: boolean): string | undefined {
	if (collapse !== "on-back-edge") return undefined;
	if (contextAwarePresent) return undefined;
	return "collapse: on-back-edge is declared, but pi-context-aware is not loaded in this session. "
		+ "Without it the run cannot be told when a compaction invalidates the collapse anchor, so collapse is disabled "
		+ "rather than navigating to a session entry it cannot trust (.spec/0009 C1).";
}

/**
 * The state a run keeps about its collapse anchor.
 *
 * `undefined` means no anchor is held — either none has been set yet, or one
 * was discarded and not yet replaced.
 */
export interface AnchorState {
	readonly anchorId?: string;
	/** Compactions observed since the anchor was set. Kept for the journal, not for a decision. */
	readonly compactionsSinceSet: number;
}

export const NO_ANCHOR: AnchorState = { compactionsSinceSet: 0 };

/**
 * Record that a compaction happened.
 *
 * **The anchor is discarded, not repaired.** `.spec/0009` C1 is explicit: after
 * a compaction the graph MUST re-anchor and MUST NOT navigate to a
 * pre-compaction leaf id. Spike S5 measured one surviving a forced compaction,
 * and that is a reason to expect re-anchoring to be cheap — not a licence to
 * keep the old id, because a surviving anchor was measured once, at a node
 * boundary, in a forced compaction (D-066, D-067).
 *
 * Discarding is why this needs no knowledge of whether the anchor *did*
 * survive: the rule is the same either way.
 */
export function afterCompaction(_state: AnchorState): AnchorState {
	return { compactionsSinceSet: 0 };
}

/** Set a fresh anchor at the current session leaf. */
export function anchorAt(anchorId: string): AnchorState {
	return { anchorId, compactionsSinceSet: 0 };
}

/**
 * Whether a back edge may collapse to the anchor now.
 *
 * Only with an anchor in hand. After a compaction there is none until the run
 * re-anchors, so the back edge simply proceeds without collapsing — which costs
 * context, and is the cost D-067 said a negative S5 result would change.
 */
export function canCollapseTo(state: AnchorState): string | undefined {
	return state.anchorId;
}
