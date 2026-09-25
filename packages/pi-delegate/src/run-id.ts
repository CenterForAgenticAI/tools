/**
 * Derive a filesystem/branch-safe run identifier from a tool call id.
 *
 * Used to namespace per-run worktree branches and tmp directories so that
 * concurrent delegate invocations (or retries) don't collide.
 *
 * Sanitisation rules:
 *   - Replace any non-word character (anything matching [^A-Za-z0-9_])
 *     with a single hyphen.
 *   - Truncate to 32 chars so git ref names and tmp-dir paths stay short.
 */
export function deriveRunId(toolCallId: string): string {
	return toolCallId.replace(/[^\w]/g, "-").slice(0, 32);
}

/**
 * Shape of a filesystem-safe run id: word chars + hyphens, bounded length.
 * Every internally-minted id (`deriveRunId`, orchestrate run ids) matches this
 * by construction.
 */
export const SAFE_RUN_ID_RE = /^[\w-]{1,128}$/;

/**
 * Validate an EXTERNALLY-SUPPLIED run id before it is interpolated into any
 * on-disk path (`<runId>.json`, `<runId>.cfg.json`, ...). Tool args
 * (`delegate_status` / `delegate_result` / `delegate_steer` / `delegate_cancel`)
 * accept arbitrary strings, so without this gate a crafted id like
 * `"../../../x"` traverses out of the orchestrate dirs. Resolvers must treat
 * an unsafe id exactly like an unknown one (undefined / null / unavailable).
 */
export function isSafeRunId(runId: unknown): runId is string {
	return typeof runId === "string" && SAFE_RUN_ID_RE.test(runId);
}
