/**
 * Channel names pi-delegate uses on Pi's in-process event bus (`pi.events`).
 *
 * `pi.events` is a Node `EventEmitter` shared by the extensions loaded into one
 * Pi process. Nothing on it crosses a process boundary: RPC mode, pi-daemon and
 * session files do not carry these events. A host that wants delegate lifecycle
 * in its own naming scheme should subscribe here and translate at its own
 * boundary, rather than asking pi-delegate to emit under the host's name.
 *
 * Every channel is `delegate:<kebab-case>`. Payloads only grow; consumers must
 * ignore fields they do not know. Import these constants instead of repeating
 * the strings.
 *
 * `delegate:complete` is also the `customType` of the completion wake message
 * that pi-delegate adds to the session (`DELEGATE_COMPLETE_CUSTOM_TYPE`). That
 * message and this bus event are separate mechanisms that share a name.
 */
export const DELEGATE_EVENTS = Object.freeze({
	/** A run was registered or its registration changed. Payload: `{ runId }`. */
	register: "delegate:register",
	/** A run's registration was withdrawn. Payload: `{ runId }`. */
	registrationRevoked: "delegate:registration-revoked",
	/** One run entry changed state. Payload: `{ runId, forkName, forkState }`. */
	update: "delegate:update",
	/** A transcript entry was appended to one run entry. Payload: `{ runId, forkName, entry }`. */
	transcriptAppend: "delegate:transcript-append",
	/** A run entry's live activity line changed. Payload: `{ runId, forkName, activityStatus }`. */
	activityStatus: "delegate:activity-status",
	/** A worker asked a question that is waiting for an answer. */
	promptPending: "delegate:prompt-pending",
	/** A pending worker question was answered or withdrawn. */
	promptResolved: "delegate:prompt-resolved",
	/** Guidance was queued for a worker. Payload: `{ runId, forkName, count }`. */
	guidanceQueued: "delegate:guidance-queued",
	/** Queued guidance was taken by the worker. Payload: `{ runId, forkName, count }`. */
	guidanceDrained: "delegate:guidance-drained",
	/** Queued guidance reached the worker's transcript. Payload: `{ runId, forkName, count }`. */
	guidanceDelivered: "delegate:guidance-delivered",
	/** A worker tool called `ctx.ui.notify`. Payload: `{ runId, forkName, message, kind }`. */
	workerNotify: "delegate:worker-notify",
	/** A run reached a terminal state. Payload: `{ runId, finalResult }`. */
	complete: "delegate:complete",
	/** An orphaned synchronous run was surfaced for recovery. Payload: `{ runId, surfacedAt }`. */
	syncOrphanRecoverySurfaced: "delegate:sync-orphan-recovery-surfaced",
	/**
	 * Inbound: ask pi-delegate to show its control tools now. No payload.
	 * The only channel pi-delegate listens to rather than emits.
	 */
	revealControlTools: "delegate:reveal-control-tools",
} as const);

/**
 * `customType` of the completion wake message pi-delegate adds to the session
 * (`pi.sendMessage`). It is persisted in session files, so hosts that read
 * sessions key on it. It is not a bus channel and must not change.
 */
export const DELEGATE_COMPLETE_CUSTOM_TYPE = "delegate:complete" as const;

export type DelegateEventName = (typeof DELEGATE_EVENTS)[keyof typeof DELEGATE_EVENTS];

/** Emit a canonical delegate event. */
export function emitDelegateEvent(
	emit: (channel: string, data: unknown) => void,
	name: DelegateEventName,
	data: unknown,
): void {
	emit(name, data);
}
