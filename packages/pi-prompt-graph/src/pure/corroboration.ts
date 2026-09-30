/**
 * D-051's rule as a pure function, so it can be tested without a live session.
 *
 * A reported completion is not evidence of work. Spike S5 measured PTM
 * announcing 128 prompts started and finished while the model took 6 turns, and
 * issue #20 measured the same signature from a different cause — a fixture that
 * had run out of work. Both produce nodes that report success having done
 * nothing, which is the one failure a graph runner cannot tolerate: it routes on
 * verdicts derived from empty work.
 *
 * Spike S5's probe measured this rule before the runner used it, and Stage 3
 * now applies the same decision in Mode A. The two share this module rather
 * than each carrying a copy: a corroboration rule that drifted between the
 * instrument and the runner would make the instrument's evidence worthless.
 *
 * Pure by construction — no session, no clock, no filesystem. It is given a
 * window that someone else observed and returns a verdict about it.
 */

export interface NodeWindow {
	/** `turn_end` events observed between the node's `started` and `finished`. */
	turnsInWindow: number;
	/**
	 * PTM's own report, from `prompt-template:prompt:finished`: did the prompt
	 * call `write` or `edit`? Undefined when the event carried no such field.
	 */
	reportedChanged?: boolean;
	/**
	 * The last assistant text of the prompt, from the same event. Read only to
	 * recognise a peer's recovery notice standing in for the node's work — see
	 * `RECOVERY_NOTICE_PATTERNS`.
	 */
	lastText?: string;
}

/**
 * A node whose entire output is a peer extension announcing its own recovery
 * did not do the node's work, however many turns it spent saying so.
 *
 * Measured in the 10-lap run of 2026-08-14: after a compaction, 118 of 160
 * nodes returned exactly this, each spending one turn and about 1.1 seconds,
 * each reporting `status: "completed"`. Only laps 1 and 2 were ever
 * implemented; laps 3 to 10 reported success having done nothing.
 *
 * This is a narrow, evidence-bearing exception, not a return to the duration
 * heuristic D-051 rejected: it matches what the session itself said, not how
 * long it took.
 */
export const RECOVERY_NOTICE_PATTERNS: readonly RegExp[] = [
	/^\s*\[context-aware recovery\]/i,
];

function isRecoveryNotice(lastText: string | undefined): boolean {
	if (!lastText) return false;
	return RECOVERY_NOTICE_PATTERNS.some((pattern) => pattern.test(lastText));
}

export interface Corroboration {
	corroborated: boolean;
	/** Present only when `corroborated` is false, naming the absent evidence. */
	reason?: string;
}

/**
 * Decide whether a node's window holds positive evidence of model work.
 *
 * Two accepted forms of evidence, in this order:
 *
 * 1. **A model turn inside the node's own window.** This is the primary test.
 * 2. **PTM reporting that the prompt wrote or edited a file.** Stronger evidence
 *    when true, but it cannot be required: a legitimate verdict-only node
 *    writes nothing and reports `changed: false` honestly.
 *
 * Duration is deliberately not part of the test. D-051 rejected a duration
 * threshold as an unprincipled heuristic that would also reject a legitimately
 * fast deterministic template, and that reasoning is unchanged here.
 */
export function corroborateWindow(window: NodeWindow): Corroboration {
	// Checked before the turn count: a recovery notice IS a turn, so reading the
	// count first would accept it. This is the gap the 10-lap run found in the
	// rule's first form, where 118 degraded nodes each spent one turn.
	if (isRecoveryNotice(window.lastText)) {
		return {
			corroborated: false,
			reason: "the node's only output was a peer extension's recovery notice, not the node's work",
		};
	}
	if (window.turnsInWindow > 0) return { corroborated: true };
	if (window.reportedChanged === true) return { corroborated: true };
	return {
		corroborated: false,
		reason: window.reportedChanged === false
			? "no model turn in the node's window, and PTM reported no write or edit"
			: "no model turn in the node's window",
	};
}

/**
 * How many nodes in a row may report a completion with no evidence before the
 * run is stopped.
 *
 * Two rather than one: a single verdict-only node that writes nothing is
 * legitimate, but a session that has stopped doing work never recovers, and
 * every node after it inherits the same broken session. Continuing past that
 * point is what produced the 224-node run issue #20 was filed about.
 */
export const DEFAULT_UNCORROBORATED_LIMIT = 2;

/**
 * Decide whether a run should stop, given the length of the current run of
 * uncorroborated nodes.
 */
export function shouldStopRun(consecutiveUncorroborated: number, limit = DEFAULT_UNCORROBORATED_LIMIT): boolean {
	return consecutiveUncorroborated >= Math.max(1, limit);
}
