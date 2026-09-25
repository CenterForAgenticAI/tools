import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { boundActivityText, safeActivityToolName } from "./activity-status.js";

/** Model/session role represented in one delegate-widget row. */
export type DelegateActor = "supervisor" | "worker";

/**
 * Short-lived UI phases. These are categorical facts only: no prompt body,
 * tool arguments/results, or model reasoning text belongs in this shape.
 */
export type ActorActivityPhase =
	| "starting"
	| "waiting-model"
	| "thinking"
	| "writing"
	| "preparing-tool"
	| "using-tool"
	| "sending-task"
	| "waiting-worker"
	| "waiting-supervisor"
	| "reviewing-worker"
	| "inspecting-worker"
	| "steering"
	| "cancelling-worker"
	| "restarting-worker"
	| "resolving-escalation"
	| "forwarding-escalation"
	| "finishing"
	| "repairing-prompt"
	| "retrying-primary"
	| "awaiting-prompt"
	| "awaiting-escalation"
	| "completed"
	| "failed"
	| "aborted"
	| "paused";

export type ActorPromptKind = "confirm" | "select" | "input";

export interface ActorActivity {
	actor: DelegateActor;
	phase: ActorActivityPhase;
	/** Bounded tool name only. Never a command, argument, or result preview. */
	toolName?: string;
	activeToolCount?: number;
	promptKind?: ActorPromptKind;
	/** Bounded extension-owned categorical label; raw prompt/error text is excluded. */
	message?: string;
	/** Time the current phase (or oldest active parallel tool) began. */
	startedAt: number;
	/** Time the categorical projection last changed. */
	updatedAt: number;
}

export interface RunActorActivity {
	supervisor?: ActorActivity;
	worker?: ActorActivity;
}

export type ActorActivityUpdate = Omit<ActorActivity, "actor" | "startedAt" | "updatedAt"> & {
	startedAt?: number;
};

export interface ActorActivityChange {
	runId: string;
	forkName: string;
	activity: RunActorActivity | undefined;
}

/** Redacted identity/timestamp notification for liveness consumers. */
export interface ActorActivityObservation {
	runId: string;
	forkName: string;
	actor: DelegateActor;
	observedAt: number;
}

export interface ActorActivityPublisher {
	publish(actor: DelegateActor, update: ActorActivityUpdate): void;
	clear(actor: DelegateActor): void;
	dispose(): void;
}

export type AgentActivityMode = "supervisor" | "supervised-worker" | "direct-worker";

export interface AgentActivityProjector {
	handle(event: AgentSessionEvent): void;
}

interface OwnedRunEntryActorActivity {
	owner: object;
	activity: RunActorActivity;
}

interface ActiveTool {
	name: string;
	startedAt: number;
	sequence: number;
	controlPhase?: ActorActivityPhase;
}

const MAX_TOOL_NAME_CHARS = 48;
const activityByRunEntry = new Map<string, OwnedRunEntryActorActivity>();
/** Current publication capability for each run/entry key. Claimed at creation. */
const activePublisherByRunEntry = new Map<string, object>();
const listeners = new Set<(change: ActorActivityChange) => void>();
const observationListeners = new Set<(observation: ActorActivityObservation) => void>();
let publisherEpoch = 0;

function activityKey(runId: string, forkName: string): string {
	return `${runId}\u0000${forkName}`;
}

function cloneActorActivity(activity: ActorActivity | undefined): ActorActivity | undefined {
	return activity ? { ...activity } : undefined;
}

function cloneRunEntryActivity(activity: RunActorActivity): RunActorActivity {
	return {
		supervisor: cloneActorActivity(activity.supervisor),
		worker: cloneActorActivity(activity.worker),
	};
}

function isEmptyActivity(activity: RunActorActivity): boolean {
	return activity.supervisor === undefined && activity.worker === undefined;
}

function notifyChanged(runId: string, forkName: string, activity: RunActorActivity | undefined): void {
	for (const listener of [...listeners]) {
		try {
			listener({
				runId,
				forkName,
				activity: activity ? cloneRunEntryActivity(activity) : undefined,
			});
		} catch {
			// A stale UI/test listener must never interrupt a worker session.
		}
	}
}

function finiteTime(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeToolName(value: string | undefined): string | undefined {
	return safeActivityToolName(value, MAX_TOOL_NAME_CHARS);
}

function safeMessage(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const message = boundActivityText(value);
	return message || undefined;
}

function safeActiveToolCount(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value)) return 1;
	return Math.min(999, Math.max(1, Math.floor(value)));
}

/** Keep provider call ids usable for correlation without retaining the raw id. */
function opaqueToolCallKey(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sameCategoricalActivity(left: ActorActivity, right: ActorActivity): boolean {
	return (
		left.actor === right.actor &&
		left.phase === right.phase &&
		left.toolName === right.toolName &&
		left.activeToolCount === right.activeToolCount &&
		left.promptKind === right.promptKind &&
		left.message === right.message &&
		left.startedAt === right.startedAt
	);
}

/** Return elapsed activity silence, preserving the zero sentinel for no activity. */
export function actorActivitySilenceMs(lastActivityAt: number, now: number): number {
	return lastActivityAt > 0 ? now - lastActivityAt : 0;
}

function notifyObserved(observation: ActorActivityObservation): void {
	for (const listener of [...observationListeners]) {
		try {
			listener({ ...observation });
		} catch {
			// A stale liveness observer must never interrupt a worker session.
		}
	}
}

export function createActorActivityPublisher(
	runId: string,
	forkName: string,
	clock: () => number = Date.now,
	onActivity?: (lastActivityAt: number) => void,
): ActorActivityPublisher {
	const owner = {};
	const key = activityKey(runId, forkName);
	const epoch = publisherEpoch;
	let disposed = false;
	// Publisher creation is the ownership hand-off. Clear the predecessor's
	// projection immediately so a publisher that never reaches its first event
	// cannot leave stale UI behind, then reject every late predecessor method.
	activePublisherByRunEntry.set(key, owner);
	if (activityByRunEntry.delete(key)) notifyChanged(runId, forkName, undefined);
	const isActive = (): boolean =>
		!disposed && epoch === publisherEpoch && activePublisherByRunEntry.get(key) === owner;

	return {
		publish(actor, update) {
			if (!isActive()) return;
			const now = finiteTime(clock(), Date.now());
			const currentOwned = activityByRunEntry.get(key);
			const current = currentOwned?.owner === owner ? currentOwned.activity : {};
			const previous = current[actor];
			const toolName = safeToolName(update.toolName);
			const message = safeMessage(update.message);
			const activeToolCount = safeActiveToolCount(update.activeToolCount);
			const samePayload =
				previous !== undefined &&
				previous.phase === update.phase &&
				previous.toolName === toolName &&
				previous.activeToolCount === activeToolCount &&
				previous.promptKind === update.promptKind &&
				previous.message === message;
			const startedAt = finiteTime(
				update.startedAt ?? (samePayload ? previous.startedAt : now),
				now,
			);
			const nextActor: ActorActivity = {
				actor,
				phase: update.phase,
				...(toolName ? { toolName } : {}),
				...(activeToolCount !== undefined
					? { activeToolCount }
					: {}),
				...(update.promptKind ? { promptKind: update.promptKind } : {}),
				...(message ? { message } : {}),
				startedAt,
				updatedAt: now,
			};
			try {
				onActivity?.(now);
			} catch {
				// A failing liveness sink must never interrupt actor activity tracking.
			}
			notifyObserved({ runId, forkName, actor, observedAt: now });
			if (previous && sameCategoricalActivity(previous, nextActor)) return;

			const next: RunActorActivity = { ...current, [actor]: nextActor };
			activityByRunEntry.set(key, { owner, activity: next });
			notifyChanged(runId, forkName, next);
		},
		clear(actor) {
			if (!isActive()) return;
			const current = activityByRunEntry.get(key);
			if (current?.owner !== owner || current.activity[actor] === undefined) return;
			const next = { ...current.activity };
			delete next[actor];
			if (isEmptyActivity(next)) activityByRunEntry.delete(key);
			else activityByRunEntry.set(key, { owner, activity: next });
			notifyChanged(runId, forkName, isEmptyActivity(next) ? undefined : next);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (epoch !== publisherEpoch || activePublisherByRunEntry.get(key) !== owner) return;
			activePublisherByRunEntry.delete(key);
			if (activityByRunEntry.get(key)?.owner === owner) {
				activityByRunEntry.delete(key);
				notifyChanged(runId, forkName, undefined);
			}
		},
	};
}

const SUPERVISOR_TOOL_PHASES: Readonly<Record<string, ActorActivityPhase>> = {
	message_subagent: "sending-task",
	wait_for_worker: "waiting-worker",
	inspect_worker: "inspecting-worker",
	cancel_worker: "cancelling-worker",
	restart_worker: "restarting-worker",
	resolve_escalation: "resolving-escalation",
	escalate: "forwarding-escalation",
	finish_delegation: "finishing",
};

/** True only for the private supervisor loop's coordination tools. */
export function isSupervisorControlToolName(value: string | undefined): boolean {
	return value !== undefined && Object.hasOwn(SUPERVISOR_TOOL_PHASES, value);
}

const REVIEW_AFTER_SUPERVISOR_TOOLS = new Set([
	"message_subagent",
	"wait_for_worker",
	"inspect_worker",
	"cancel_worker",
	"restart_worker",
	"resolve_escalation",
	"escalate",
]);

function assistantUpdateType(event: AgentSessionEvent): string | undefined {
	return event.type === "message_update" ? event.assistantMessageEvent.type : undefined;
}

export function createAgentActivityProjector(args: {
	mode: AgentActivityMode;
	publisher: ActorActivityPublisher;
	clock?: () => number;
}): AgentActivityProjector {
	const clock = args.clock ?? Date.now;
	const actor: DelegateActor = args.mode === "supervisor" ? "supervisor" : "worker";
	const activeTools = new Map<string, ActiveTool>();
	let reviewPending = false;
	let toolSequence = 0;

	const publish = (update: ActorActivityUpdate): void => args.publisher.publish(actor, update);
	const now = (): number => finiteTime(clock(), Date.now());

	const publishActiveTools = (): void => {
		const tools = [...activeTools.values()];
		if (tools.length === 0) {
			publish({ phase: actor === "supervisor" && reviewPending ? "reviewing-worker" : "waiting-model" });
			return;
		}
		if (actor === "supervisor") {
			const control = tools
				.filter((tool): tool is ActiveTool & { controlPhase: ActorActivityPhase } => tool.controlPhase !== undefined)
				.sort((left, right) => right.sequence - left.sequence)[0];
			if (control) {
				publish({ phase: control.controlPhase, startedAt: control.startedAt });
				return;
			}
		}
		const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
		publish({
			phase: "using-tool",
			...(tools.length === 1 ? { toolName: tools[0]!.name } : {}),
			activeToolCount: tools.length,
			startedAt,
		});
	};

	publish({ phase: "starting" });

	return {
		handle(event) {
			const updateType = assistantUpdateType(event);
			if (updateType?.startsWith("thinking_")) {
				if (updateType !== "thinking_end") {
					reviewPending = false;
					publish({ phase: "thinking" });
				}
				return;
			}
			if (updateType?.startsWith("text_")) {
				reviewPending = false;
				publish({ phase: "writing" });
				return;
			}
			if (updateType?.startsWith("toolcall_")) {
				reviewPending = false;
				publish({ phase: "preparing-tool" });
				return;
			}

			switch (event.type) {
				case "agent_start":
				case "message_start":
				case "auto_retry_start":
					publish({
						phase: actor === "supervisor" && reviewPending ? "reviewing-worker" : "waiting-model",
					});
					break;
				case "turn_start":
					publish({
						phase: actor === "supervisor" && reviewPending ? "reviewing-worker" : "waiting-model",
					});
					break;
				case "tool_execution_update":
					// Tool updates carry no new categorical fact, but they are real
					// activity for liveness even while the widget phase is unchanged.
					if (event.toolCallId && activeTools.has(opaqueToolCallKey(event.toolCallId))) {
						publishActiveTools();
					}
					break;
				case "tool_execution_start": {
					const startedAt = now();
					const controlPhase = actor === "supervisor" ? SUPERVISOR_TOOL_PHASES[event.toolName] : undefined;
					// Sanitize before retaining even this projector-local copy. The
					// publisher sanitizes again at its public boundary, but raw provider
					// values must not sit in the short-lived actor projection meanwhile.
					activeTools.set(opaqueToolCallKey(event.toolCallId), {
						name: safeToolName(event.toolName) ?? "tool",
						startedAt,
						sequence: ++toolSequence,
						...(controlPhase ? { controlPhase } : {}),
					});
					reviewPending = false;
					publishActiveTools();
					break;
				}
				case "tool_execution_end": {
					activeTools.delete(opaqueToolCallKey(event.toolCallId));
					if (actor === "supervisor" && REVIEW_AFTER_SUPERVISOR_TOOLS.has(event.toolName)) {
						reviewPending = true;
					}
					if (activeTools.size > 0) {
						publishActiveTools();
						break;
					}
					if (actor === "supervisor" && event.toolName === "finish_delegation") {
						publish({ phase: "finishing" });
						break;
					}
					publish({ phase: reviewPending ? "reviewing-worker" : "waiting-model" });
					break;
				}
				case "queue_update":
					if (actor === "supervisor") {
						if (event.steering.length > 0 || event.followUp.length > 0) {
							publish({ phase: "steering" });
						} else {
							// Queue drain is itself a meaningful transition. Do not leave a
							// stale steering label until the next model/tool event arrives.
							publishActiveTools();
						}
					}
					break;
				case "agent_end":
				case "agent_settled":
					publish({
						phase:
							args.mode === "supervised-worker"
								? "waiting-supervisor"
								: "finishing",
					});
					break;
				case "auto_retry_end":
					publish({ phase: event.success ? "waiting-model" : "finishing" });
					break;
				default:
					// message_end, tool updates, compaction, and metadata changes carry
					// no new categorical fact for this compact projection.
					break;
			}
		},
	};
}

export function getActorActivity(
	runId: string,
	forkName: string,
): RunActorActivity | undefined {
	const activity = activityByRunEntry.get(activityKey(runId, forkName))?.activity;
	return activity ? cloneRunEntryActivity(activity) : undefined;
}

export function onActorActivityChanged(
	listener: (change: ActorActivityChange) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Subscribe to redacted actor activity without changing the categorical UI stream. */
export function onActorActivityObserved(
	listener: (observation: ActorActivityObservation) => void,
): () => void {
	observationListeners.add(listener);
	return () => observationListeners.delete(listener);
}

/**
 * Clear every short-lived actor projection and invalidate existing publishers.
 * Session replacement/shutdown uses this boundary so a late event from an old
 * worker cannot repopulate state after the next foreground session starts.
 */
export function clearAllActorActivity(): void {
	publisherEpoch += 1;
	const keys = [...activityByRunEntry.keys()];
	activityByRunEntry.clear();
	activePublisherByRunEntry.clear();
	for (const key of keys) {
		const separator = key.indexOf("\u0000");
		notifyChanged(key.slice(0, separator), key.slice(separator + 1), undefined);
	}
}

/** Test-only reset for module-global short-lived UI state. */
export function __resetActorActivityForTests(): void {
	publisherEpoch += 1;
	activityByRunEntry.clear();
	activePublisherByRunEntry.clear();
	listeners.clear();
	observationListeners.clear();
}
