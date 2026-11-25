/**
 * The /checkin reconciliation prompt.
 *
 * The focus comes from the snapshot this package reads. The task list belongs to pi-workstream, so
 * the prompt does not carry it: when the session can reach pi-workstream's task tool, the prompt asks
 * the agent to read the list with it, and otherwise it leaves the list out.
 */

import type { WorkstreamSnapshot } from "../snapshot-contracts/schema.js";

export interface CheckinPressureSnapshot {
	readonly tokens: number;
	readonly window: number;
	readonly fraction: number;
	readonly headroom: number;
}

export interface CheckinSnapshot {
	readonly focus: WorkstreamSnapshot | null;
	readonly pressure: CheckinPressureSnapshot | null;
}

export interface CheckinOptions {
	readonly compactionAvailable?: boolean;
	readonly compactionInvocation?: string;
	/** The exact call that reads pi-workstream's task list; absent when this session cannot reach it. */
	readonly tasksCall?: string;
}

function focusSection(focus: WorkstreamSnapshot | null): string[] {
	if (focus === null) return ["Durable focus: none recorded."];
	const lines = [
		"Durable focus:",
		`- Objective: ${focus.objective}`,
		`- Status: ${focus.status}`,
		`- Revision: ${focus.revision}`,
	];
	if (focus.goals.length > 0) lines.push("- Goals:", ...focus.goals.map((goal) => `  - ${goal.id} [${goal.status}] ${goal.text}`));
	return lines;
}

function tasksSection(tasksCall: string | undefined): string[] {
	if (tasksCall === undefined) return [];
	return [`Task list: read it with ${tasksCall} before you answer. Reading it changes nothing.`];
}

function pressureSection(pressure: CheckinPressureSnapshot | null): string {
	if (pressure === null) return "Context pressure: unavailable.";
	return `Context pressure: ${Math.round(pressure.fraction * 100)}% used (${pressure.tokens}/${pressure.window} tokens), ${pressure.headroom} tokens headroom.`;
}

function absentRecordLine(snapshot: CheckinSnapshot, tasksCall: string | undefined): string[] {
	if (snapshot.focus !== null) return [];
	if (tasksCall === undefined) return ["No durable focus or task list exists. Say that plainly, then still report progress from the current session conversation."];
	return ["No durable focus exists. If the task list is empty too, say that plainly, then still report progress from the current session conversation."];
}

/** Build the read-only reconciliation request from one invocation-time snapshot. */
export function buildCheckinPrompt(snapshot: CheckinSnapshot, options: CheckinOptions = {}): string {
	const compact = options.compactionAvailable !== false;
	const compactionInvocation = options.compactionInvocation ?? "context_compact";
	const tasksCall = options.tasksCall;
	return [
		`Perform a read-only session check-in using the invocation-time snapshot below. ${compact ? `Do not call ${compactionInvocation} and do not change` : "Do not change"} the focus or the task list; propose the exact corrective calls in the Record corrections section instead.`,
		"",
		...focusSection(snapshot.focus),
		...tasksSection(tasksCall),
		pressureSection(snapshot.pressure),
		...absentRecordLine(snapshot, tasksCall),
		"",
		"Answer with exactly these four sections:",
		"Done — report what this session completed, tied to the focus objective or goal ids and task ids where available.",
		"Left — report what remains, including blocked or deferred work and the reason for each.",
		"Record corrections — identify stale focus or task records and show the calls that would fix them. Do not execute those calls merely because this is a check-in.",
		compact
			? `Continue or compact — say whether this is a clean phase boundary, whether to continue, and what a ${compactionInvocation} seed would carry forward if compaction is appropriate. Do not compact from this request.`
			: "Continue — say whether this is a clean phase boundary and whether to continue. Compaction is not available in this session.",
	].join("\n");
}
