/**
 * Trusted, process-local store of the control-action grants in force for a
 * worker session (#265).
 *
 * WHY THIS EXISTS
 *
 * Before the consolidation, the tool allowlist WAS the enforcement: an agent
 * whose `tools:` said `delegate_status` was handed the `delegate_status` tool
 * and nothing else, so it could not cancel a run. After the consolidation there
 * is one `delegate_control` tool that can do all five things, and the allowlist
 * can only grant or withhold the whole tool. The narrowing therefore has to be
 * carried separately and enforced at call time — and it has to arrive by a path
 * the worker cannot influence.
 *
 * The first attempt carried grants only in the detached tool-scope env
 * envelope. That envelope is created solely for DYNAMIC (`ext:`) scopes, so a
 * worker with an ordinary static allowlist received no grant at all and every
 * action was permitted: exactly the privilege escalation the grant exists to
 * prevent. This registry is the in-process half, and it is written by the
 * parent while constructing the worker session, never by the worker.
 *
 * FAIL CLOSED
 *
 * A session that was registered as action-scoped and then loses its entry must
 * deny everything rather than fall back to "unrestricted". The two states are
 * therefore distinct: `undefined` means "no grant state was ever recorded for
 * this session" (a foreground session, which is unrestricted), while a recorded
 * entry with an empty action list denies every action.
 */

/** Grants for one session: tool name → granted actions, or UNRESTRICTED. */
export type SessionControlGrants = Map<string, readonly string[] | typeof UNRESTRICTED>;

/**
 * Explicit sentinel for "every action on this tool", kept distinct from an
 * absent entry so a lookup can tell "granted everything" from "not recorded".
 */
export const UNRESTRICTED = Symbol("delegate.control.grant.unrestricted");

const sessionGrants = new Map<string, SessionControlGrants>();

/**
 * Record the grants for a worker session. Called by the parent during worker
 * construction; the key is the worker's own session identity.
 *
 * Passing `undefined` for a tool's actions records UNRESTRICTED, which is how a
 * bare `tools: delegate_control` entry is represented.
 */
export function registerSessionControlGrants(
	sessionId: string,
	grants: Record<string, readonly string[] | undefined> | undefined,
): void {
	if (!sessionId) return;
	if (grants === undefined) {
		sessionGrants.delete(sessionId);
		return;
	}
	const entry: SessionControlGrants = new Map();
	for (const [tool, actions] of Object.entries(grants)) {
		entry.set(tool, actions === undefined ? UNRESTRICTED : [...actions]);
	}
	sessionGrants.set(sessionId, entry);
}

/** Drop a session's grants when its session is disposed. */
export function clearSessionControlGrants(sessionId: string): void {
	sessionGrants.delete(sessionId);
}

/**
 * The actions granted on `toolName` for this session.
 *
 * Returns `undefined` when no grant state exists for the session at all, which
 * means unrestricted — a foreground session has no entry and must not be
 * narrowed. Returns an array (possibly empty) when the session IS action-scoped
 * but this tool was not granted, which denies every action.
 */
export function lookupSessionControlGrants(
	sessionId: string | undefined,
	toolName: string,
): readonly string[] | undefined {
	if (!sessionId) return undefined;
	const entry = sessionGrants.get(sessionId);
	if (!entry) return undefined;
	const actions = entry.get(toolName);
	if (actions === UNRESTRICTED) return undefined;
	// The session is action-scoped. A tool with no entry is granted nothing,
	// rather than falling through to unrestricted.
	return actions ?? [];
}

/** Is this session recorded as action-scoped at all? */
export function hasSessionControlGrants(sessionId: string | undefined): boolean {
	return sessionId ? sessionGrants.has(sessionId) : false;
}

/** Test seam: drop every recorded session. */
export function __resetSessionControlGrantsForTests(): void {
	sessionGrants.clear();
}
