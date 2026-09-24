/**
 * Decide whether it is safe to fall back to Pi's built-in compaction after the
 * context-aware compaction hook failed for a reason that is neither an exhausted
 * overflow ladder nor an exhausted transient transport (those are handled
 * separately and always cancel).
 *
 * The built-in path re-sends the summarization input with only its own reserve
 * of headroom and performs no payload reduction of its own. When the session is
 * already so large that that request cannot fit, the built-in retry just
 * reproduces the overflow — the "context unchanged" failure that leaves the
 * session stuck. In that case cancelling is strictly better than handing the
 * built-in an oversized request it cannot satisfy.
 *
 * The guard models Pi's actual requests, not an aggregate:
 *
 *   - Pi's `compact` sends the history summary and (for a split turn) the
 *     turn-prefix summary as SEPARATE provider requests, so each must fit on its
 *     own. The binding constraint is the largest single request, not their sum.
 *   - Each request has `settings.reserveTokens` of headroom, which is
 *     configurable and may differ from Pi's default.
 *   - The extension's token estimator is bounded (it stops after a fixed number
 *     of messages), so on a very long session its raw total under-counts. A
 *     bounded estimate is extrapolated from the fraction of messages it actually
 *     counted, so the guard does not silently allow an oversized fallback for the
 *     long sessions it most needs to catch.
 *
 * This stays conservative: it only refuses the fallback when a modelled request
 * already exceeds the space the built-in would have, and otherwise lets the
 * built-in retry proceed (the failure may be unrelated to size).
 */

/** The built-in compaction's default reserve; see DEFAULT_COMPACTION_SETTINGS. */
export const BUILTIN_COMPACTION_RESERVE_TOKENS = 16_384;

export interface BoundedInputEstimate {
	/** Tokens counted for the messages the estimator actually accounted for. */
	tokens: number;
	/** Total messages in the group(s). */
	inputMessageCount: number;
	/** Messages actually counted before the estimator's bound was reached. */
	accountedInputMessageCount: number;
	/** True when the estimator stopped short of counting every message/char. */
	bounded: boolean;
}

/**
 * Scale a bounded token estimate up to the whole message set. When the estimator
 * counted every message, the raw tokens are returned unchanged. When it stopped
 * short, tokens are scaled by the ratio of total to counted messages so a long
 * session is not under-counted. Returns a non-negative, rounded token count.
 */
export function extrapolateBoundedInputTokens(estimate: BoundedInputEstimate): number {
	const { tokens, inputMessageCount, accountedInputMessageCount, bounded } = estimate;
	if (!Number.isFinite(tokens) || tokens <= 0) return 0;
	if (!bounded || accountedInputMessageCount <= 0 || inputMessageCount <= accountedInputMessageCount) {
		return Math.round(tokens);
	}
	return Math.round(tokens * (inputMessageCount / accountedInputMessageCount));
}

export interface BuiltinCompactionFallbackInput {
	/**
	 * Estimated tokens for each request the built-in path would send separately.
	 * The largest one is the binding constraint.
	 */
	requestTokens: readonly number[];
	/** Active model context window, when known. */
	contextWindow: number | undefined;
	/** The built-in reserve; defaults to Pi's DEFAULT_COMPACTION_SETTINGS.reserveTokens. */
	reserveTokens?: number;
}

export type BuiltinCompactionFallbackDecision =
	| { fallback: true }
	| { fallback: false; reason: string };

export function decideBuiltinCompactionFallback(
	input: BuiltinCompactionFallbackInput,
): BuiltinCompactionFallbackDecision {
	const { contextWindow } = input;
	const reserveTokens = typeof input.reserveTokens === "number" && Number.isFinite(input.reserveTokens) && input.reserveTokens >= 0
		? input.reserveTokens
		: BUILTIN_COMPACTION_RESERVE_TOKENS;
	// Without a known window or a usable estimate, do not block the built-in:
	// refusing on missing data would suppress a fallback that might succeed.
	if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return { fallback: true };
	const largestRequest = input.requestTokens.reduce(
		(max, value) => (Number.isFinite(value) && value > max ? value : max),
		0,
	);
	if (largestRequest <= 0) return { fallback: true };
	const available = (contextWindow as number) - reserveTokens;
	if (largestRequest > available) {
		return {
			fallback: false,
			reason: `the largest built-in summarization request (~${largestRequest} tokens) exceeds the space the built-in path would have (~${Math.max(0, available)} tokens = context window ${contextWindow} minus reserve ${reserveTokens})`,
		};
	}
	return { fallback: true };
}
