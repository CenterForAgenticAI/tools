/**
 * State-gated visibility for the consolidated control surface (#265, spec §6).
 *
 * `delegate_control` and `delegate_escalation` are only useful once there is
 * something to control. Advertising them in an idle session spends context on
 * tools the model cannot act on, so they are revealed by state:
 *
 *   delegate_control     in-process runs ∪ durable run history ∪ pending recoveries
 *   delegate_escalation  held escalations
 *
 * Two rules make this safe to run beside other extensions:
 *
 * 1. **Additive union, never list replacement.** The active-tool set is shared
 *    process-wide. Computing `setActiveTools(mine)` would silently strip every
 *    other extension's tools, so this module only ever unions onto whatever is
 *    currently active. A competing writer can therefore run before or after
 *    this one without either clobbering the other.
 *
 * 2. **Re-asserted every turn.** Another extension may replace the active list
 *    between turns, and durable state can appear while the session is idle (a
 *    detached run completing, an escalation raised by a worker). Re-running the
 *    union in `before_agent_start` — which precedes prompt assembly, including
 *    for wake-triggered runs — means the tool is present on the first turn that
 *    can use it, without depending on who else wrote to the list.
 *
 * The predicate deliberately reads durable state rather than only in-memory
 * runs, so visibility survives a restart: a session that reattaches to an
 * unfinished run still sees the tool it needs to inspect it.
 */

/** Tool names this module owns. Nothing else is added to the active set. */
export const CONTROL_TOOL_NAME = "delegate_control";
export const ESCALATION_TOOL_NAME = "delegate_escalation";

/** The state signals that justify revealing each tool. */
export interface ControlVisibilityState {
	/** Runs live in this process (dispatched but not yet collapsed). */
	inProcessRunCount: number;
	/** Runs recorded durably, readable after a restart. */
	durableRunCount: number;
	/** Orphaned synchronous runs awaiting recovery. */
	pendingRecoveryCount: number;
	/** Escalations held for a decision. */
	heldEscalationCount: number;
}

/**
 * Which of this module's tools should be visible for the given state.
 *
 * Returned in a stable order so a caller can compare results across turns
 * without sorting.
 */
export function visibleControlTools(state: ControlVisibilityState): string[] {
	const visible: string[] = [];
	const hasRuns =
		state.inProcessRunCount > 0 || state.durableRunCount > 0 || state.pendingRecoveryCount > 0;
	if (hasRuns) visible.push(CONTROL_TOOL_NAME);
	if (state.heldEscalationCount > 0) visible.push(ESCALATION_TOOL_NAME);
	return visible;
}

/**
 * Union the state-gated tools onto the currently active set.
 *
 * Returns `undefined` when nothing would change, so a caller can skip a
 * needless `setActiveTools` write. Suppressing the no-op write matters: every
 * write is a chance to race a competing writer, and re-asserting an unchanged
 * list each turn would churn the registry for no benefit.
 *
 * Never removes a name — including this module's own tools. A tool that became
 * visible stays visible for the rest of the session even if the run it was
 * revealed for completes, because withdrawing a tool mid-session invalidates
 * the model's understanding of what it may call.
 */
export function unionActiveTools(
	currentActive: readonly string[],
	state: ControlVisibilityState,
): string[] | undefined {
	const wanted = visibleControlTools(state);
	const missing = wanted.filter((name) => !currentActive.includes(name));
	if (missing.length === 0) return undefined;
	return [...new Set([...currentActive, ...missing])];
}
