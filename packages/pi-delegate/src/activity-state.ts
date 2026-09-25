import type { RunLiveStatus } from "./runtime.js";
import type { RunActivitySummary } from "./fork-digest.js";
import type { ActorActivityPhase } from "./actor-activity.js";

/** Structured actor labels used by lossy activity UI projections. */
export type ActivityActor = "user" | "supervisor" | "worker";

/** Structured phase labels. These values are UI-neutral and never persisted. */
export type ActivityPhase = ActorActivityPhase
	| "running"
	| "planning"
	| "guidance"
	| "completed"
	| "failed"
	| "aborted"
	| "paused";

export interface ActivityActorPhase {
	actor: ActivityActor;
	phase: ActivityPhase;
	/** Stable, color-independent text suitable for a bounded display chip. */
	label: string;
}

const ACTOR_LABELS: Record<ActivityActor, string> = {
	user: "user",
	supervisor: "supervisor",
	worker: "worker",
};

const PHASE_LABELS: Record<ActivityPhase, string> = {
	starting: "starting",
	running: "running",
	planning: "planning",
	"awaiting-prompt": "awaiting prompt",
	"awaiting-escalation": "awaiting escalation",
	guidance: "guidance",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
	paused: "paused",
	"waiting-model": "waiting on model",
	thinking: "thinking",
	writing: "writing response",
	"preparing-tool": "preparing tool",
	"using-tool": "using tool",
	"sending-task": "sending task",
	"waiting-worker": "waiting for worker",
	"waiting-supervisor": "waiting for supervisor",
	"reviewing-worker": "reviewing worker result",
	"inspecting-worker": "inspecting worker",
	steering: "steering",
	"cancelling-worker": "cancelling worker",
	"restarting-worker": "restarting worker",
	"resolving-escalation": "resolving escalation",
	"forwarding-escalation": "forwarding escalation",
	"repairing-prompt": "repairing prompt",
	"retrying-primary": "retrying primary model",
	finishing: "finishing",
};

function projection(actor: ActivityActor, phase: ActivityPhase): ActivityActorPhase {
	return { actor, phase, label: `${ACTOR_LABELS[actor]} · ${PHASE_LABELS[phase]}` };
}

/**
 * Derive the current display phase from structured runtime/transcript facts.
 * Prompt counts and guidance counts are supplied by the event controller so
 * this module does not depend on runtime storage or prompt text.
 */
export function projectActivityActorPhase(input: {
	status: RunLiveStatus;
	activity: Pick<RunActivitySummary, "toolActive" | "lastToolSource" | "activeToolSource">;
	pendingPromptCount?: number;
	pendingGuidanceCount?: number;
}): ActivityActorPhase {
	// Lifecycle truth must win over transient prompt/guidance queues. A prompt
	// can still be draining while a run entry terminalizes, and escalation is the
	// stronger blocking fact when both states overlap briefly.
	switch (input.status) {
		case "awaiting-escalation":
			return projection("worker", "awaiting-escalation");
		case "completed":
			return projection("worker", "completed");
		case "failed":
			return projection("worker", "failed");
		case "aborted":
			return projection("worker", "aborted");
		case "paused":
			return projection("worker", "paused");
		default:
			break;
	}

	const pendingPromptCount = Math.max(0, input.pendingPromptCount ?? 0);
	if (pendingPromptCount > 0) return projection("worker", "awaiting-prompt");
	if ((input.pendingGuidanceCount ?? 0) > 0) return projection("user", "guidance");

	switch (input.status) {
		case "pending":
		case "constructing":
			return projection("worker", "starting");
		case "running":
			if (input.activity.toolActive) {
				return projection(
					(input.activity.activeToolSource ?? input.activity.lastToolSource) === "supervisor"
						? "supervisor"
						: "worker",
					"using-tool",
				);
			}
			return projection(input.activity.lastToolSource === "supervisor" ? "supervisor" : "worker", "running");
	}
}

/** Short stable form for narrow aggregate rows. */
export function compactActivityActorPhase(value: ActivityActorPhase): string {
	const actor = value.actor === "supervisor" ? "S" : value.actor === "worker" ? "W" : "U";
	const phase = value.phase === "using-tool" ? "tool" : value.phase === "awaiting-prompt" ? "prompt" : value.phase === "awaiting-escalation" ? "escalation" : value.phase;
	return `${actor}:${phase}`;
}
