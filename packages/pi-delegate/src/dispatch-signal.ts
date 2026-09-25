/**
 * Decoupling the parent-turn AbortSignal from a dispatched run.
 *
 * Background — the abort cascade we're avoiding:
 *
 *   1. pi-delegate's `executeChainShape` / `executeDirectShape` /
 *      supervised-mode entrypoint each create a `dispatchAbort` controller
 *      that they hand down to the fork-runner / chain executor as the
 *      effective cancellation signal.
 *   2. The tool's `execute(toolCallId, params, signal, …)` parameter is
 *      pi-agent-core's per-run AbortSignal — i.e. the signal that fires
 *      when the parent turn is aborted (Esc, retry, recompaction
 *      interrupt, or pi-intercom's `ctx.abort()` when an inbound message
 *      arrives mid-turn).
 *   3. We *want* the parent signal to propagate into `dispatchAbort` in
 *      SYNC mode — the user pressing Esc on a sync delegate call should
 *      cancel the in-flight runs.
 *   4. We *don't* want it in DISPATCH mode. By design, dispatch returns
 *      from the tool immediately and lets runs keep running detached.
 *      The previously-installed `signal.addEventListener("abort", …)` is
 *      never torn down, so a parent-turn abort minutes later (a perfectly
 *      legitimate intercom message that just expects the agent to handle
 *      the inbound text on the next turn) cascades through the listener
 *      and nukes every detached run along with it.
 *
 * The fix is purely the gate inside `wireSignalToDispatch`: we only attach
 * the listener when `sync === true`. Dispatch / supervised-dispatch leave
 * `dispatchAbort` decoupled from the parent turn lifecycle. Cancellation
 * of detached runs continues to flow through `runState.abort` /
 * `runState.cancel` (driven by `delegate_control` action `cancel`, the per-run timeout,
 * `abortAllRuns()` on session_shutdown, etc.).
 *
 * Cross-reference: `pi-intercom/index.ts` `handleIncomingMessage` calls
 * `ctx.abort()` if the session is non-idle and graceful-detach times out.
 * The companion `installIntercomDetachResponder` (see
 * `intercom-detach.ts`) ACKs that detach so the abort never fires in the
 * first place when there's a live delegate run; this helper is the
 * second line of defence for any other parent-turn abort source.
 */

/**
 * Wire `signal -> dispatchAbort` only in SYNC mode. No-op for missing
 * signals or for dispatch mode. Idempotent and safe to call multiple
 * times.
 *
 * Returns a `dispose()` for callers that want to manually tear down the
 * listener early (e.g. tests that care about leak-free signal listeners).
 * Production code can ignore the return value — the listener uses
 * `{ once: true }` so it self-removes when it fires, and the parent
 * `AbortSignal` is owned by the run that's about to be torn down anyway.
 */
export function wireSignalToDispatch(
	signal: AbortSignal | undefined,
	dispatchAbort: AbortController,
	opts: { sync: boolean },
): () => void {
	if (!signal || !opts.sync) return () => {};
	if (signal.aborted) {
		dispatchAbort.abort();
		return () => {};
	}
	const onAbort = () => dispatchAbort.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	return () => {
		try {
			signal.removeEventListener("abort", onAbort);
		} catch {
			/* listener already removed (signal fired) — no-op. */
		}
	};
}
