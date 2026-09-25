/** Telling a worker session what kind of session it is.
 *
 * This is the pi-delegate half of the context-aware session-role handshake.
 * The extension resolves its whole behaviour from one value — the
 * session's role — and reads it from a `context-aware.policy.v1` custom entry
 * carried in the session record. Its README is explicit that **the creating
 * process** sets it. pi-delegate creates worker sessions and never set it, so
 * every worker session ran as a session with a user at a terminal.
 *
 * What that cost: the foreground path arms a *provider drain* — hiding all
 * tools, cancelling the running turn, and replacing the model's output with a
 * placeholder — before a proactive compaction. Inside a worker session the
 * placeholder lands where the supervisor expects the worker's answer, so the round produces
 * nothing and still costs a round. One orchestration lost 7 of 35 lanes that
 * way, with 150 placeholder messages across 36 of 73 worker sessions (#233).
 *
 * The same declaration also stops three other foreground behaviours a worker
 * session cannot use: rewriting the task prompt with a model (which paraphrases the
 * lane contract), auto-sending the rewritten prompt as a new user message, and
 * injecting the context-cache listing.
 *
 * **Neither package imports the other.** The shape below restates the wire
 * contract as plain JSON, exactly as `task-seam.ts` does for the checklist
 * channel, and for the same reason: an optional extension must not become a
 * hard dependency. Two consequences, both load-bearing:
 *
 * - When context-aware is absent, nothing reads the entry and it costs one
 *   unread line in the session file.
 * - When a *newer* context-aware adds fields, this entry stays valid, because
 *   the receiver ignores unknown fields and we send only what we mean.
 */

/** The custom entry type the policy travels in. */
export const SESSION_POLICY_ENTRY_TYPE = "context-aware.policy.v1" as const;

/** Mirrored from the receiver's parser: an entry with another version is dropped. */
export const SESSION_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * The layer a creating process declares into.
 *
 * The receiver resolves six layers, and `host` — "declared by whoever created
 * the session" — is the highest. That is the right one: what a session *is* is
 * not a preference a lower layer should be able to contradict. The alternative,
 * `session`, is the layer a user's own override uses.
 */
export const SESSION_POLICY_LAYER = "host" as const;

/** Who declared it, for display in the receiver's status view. */
export const SESSION_POLICY_DECLARED_BY = "pi-delegate/worker" as const;

/** The role a delegated worker session runs under. */
export const WORKER_SESSION_ROLE = "worker" as const;

/** The entry payload. Only the fields we mean; unknown ones are the receiver's. */
export interface SessionRolePolicy {
	readonly schemaVersion: typeof SESSION_POLICY_SCHEMA_VERSION;
	readonly layer: typeof SESSION_POLICY_LAYER;
	readonly declaredBy: typeof SESSION_POLICY_DECLARED_BY;
	readonly values: { readonly sessionRole: typeof WORKER_SESSION_ROLE };
}

/** The payload declaring a session to be a delegated worker. */
export function workerSessionRolePolicy(): SessionRolePolicy {
	return {
		schemaVersion: SESSION_POLICY_SCHEMA_VERSION,
		layer: SESSION_POLICY_LAYER,
		declaredBy: SESSION_POLICY_DECLARED_BY,
		values: { sessionRole: WORKER_SESSION_ROLE },
	};
}
