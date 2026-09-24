/** Human-readable, non-authoritative presentation of the transcript-authoritative focus state. */

import type { FocusResult } from "./workstream-focus.js";
import { redactText, sanitizeSnapshot } from "./workstream-safety.js";
import type { WorkstreamGoal } from "./workstream-schema.js";

const GOAL_MARKERS: Readonly<Record<WorkstreamGoal["status"], string>> = {
	pending: "○",
	active: "▶",
	blocked: "!",
	done: "✓",
};

function safeText(value: string, maxLength: number): string {
	return redactText(value, { maxLength });
}

function resultHeader(result: FocusResult): string[] {
	if (!result.accepted) {
		return [`⚠ Focus unchanged: ${safeText(result.message ?? "request was not accepted", 512)}`];
	}
	if (!result.changed) return ["🎯 Session focus"];
	const lines = [result.mutation?.priorRevision === 0 ? "✓ Focus started" : "✓ Focus updated"];
	if (result.mutation) {
		lines.push(`Change: ${result.mutation.kind} · by ${result.mutation.actor}`);
		lines.push(`Reason: ${safeText(result.mutation.reason, 240)}`);
	}
	return lines;
}

/** Render a bounded snapshot for people; the returned text never becomes focus authority. */
export function renderFocusView(result: FocusResult): string {
	if (!result.snapshot) return "No durable session focus is set.";
	const snapshot = sanitizeSnapshot(result.snapshot);
	const completedGoals = snapshot.goals.filter((goal) => goal.status === "done").length;
	const lines = [
		...resultHeader(result),
		`Objective: ${snapshot.objective}`,
		`Status: ${snapshot.status} · ${snapshot.objectivePinned ? "pinned" : "provisional"}`,
		`Goals: ${snapshot.goals.length === 0 ? "none" : `${completedGoals}/${snapshot.goals.length} done`}`,
	];
	for (const goal of snapshot.goals) {
		lines.push(`  ${GOAL_MARKERS[goal.status]} [${goal.status}] ${safeText(goal.id, 96)} — ${goal.text}`);
	}
	if (snapshot.refs.length === 0) {
		lines.push("References: none");
	} else {
		lines.push("References:");
		for (const ref of snapshot.refs) lines.push(`  • ${ref.kind}: ${ref.value}`);
	}
	if (snapshot.boundaries.length === 0) {
		lines.push("Boundaries: none");
	} else {
		lines.push("Boundaries:");
		for (const boundary of snapshot.boundaries) lines.push(`  • ${boundary}`);
	}
	lines.push(`Workstream: ${snapshot.workstreamId} · session ${snapshot.piSessionId}`);
	lines.push(`Revision: ${snapshot.revision} · updated ${safeText(snapshot.updatedAt, 64)}`);
	return lines.join("\n");
}
