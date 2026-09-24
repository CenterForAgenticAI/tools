import type { Task, TasksSnapshot } from "./session-tasks.js";
import type { WorkstreamSnapshot } from "./workstream-schema.js";

export interface CheckinPressureSnapshot {
	readonly tokens: number;
	readonly window: number;
	readonly fraction: number;
	readonly headroom: number;
}

export interface CheckinSnapshot {
	readonly focus: WorkstreamSnapshot | null;
	readonly tasks: TasksSnapshot | null;
	readonly pressure: CheckinPressureSnapshot | null;
}

function taskLines(tasks: readonly Task[], indent = ""): string[] {
	return tasks.flatMap((task) => [
		`${indent}- ${task.id} [${task.status}] ${task.title}${task.note === undefined ? "" : ` — ${task.note}`}`,
		...taskLines(task.subtasks ?? [], `${indent}  `),
	]);
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

function tasksSection(tasks: TasksSnapshot | null): string[] {
	if (tasks === null || tasks.tasks.length === 0) return ["Durable task list: none recorded."];
	return [
		`Durable task list (revision ${tasks.revision}):`,
		...taskLines(tasks.tasks),
	];
}

function pressureSection(pressure: CheckinPressureSnapshot | null): string {
	if (pressure === null) return "Context pressure: unavailable.";
	return `Context pressure: ${Math.round(pressure.fraction * 100)}% used (${pressure.tokens}/${pressure.window} tokens), ${pressure.headroom} tokens headroom.`;
}

/** Build the read-only reconciliation request from one invocation-time snapshot. */
export function buildCheckinPrompt(snapshot: CheckinSnapshot): string {
	const hasDurableRecord = snapshot.focus !== null || (snapshot.tasks?.tasks.length ?? 0) > 0;
	return [
		"Perform a read-only session check-in using the invocation-time snapshot below. Do not call compact_session and do not mutate session_focus or session_tasks unless proposing the exact corrective calls in the Record corrections section.",
		"",
		...focusSection(snapshot.focus),
		...tasksSection(snapshot.tasks),
		pressureSection(snapshot.pressure),
		...(hasDurableRecord ? [] : ["No durable focus or task list exists. Say that plainly, then still report progress from the current session conversation."]),
		"",
		"Answer with exactly these four sections:",
		"Done — report what this session completed, tied to the focus objective or goal ids and task ids where available.",
		"Left — report what remains, including blocked or deferred work and the reason for each.",
		"Record corrections — identify stale focus or task records and show the session_focus / session_tasks calls that would fix them. Do not execute those calls merely because this is a check-in.",
		"Continue or compact — say whether this is a clean phase boundary, whether to continue, and what a compact_session seed would carry forward if compaction is appropriate. Do not compact from this request.",
	].join("\n");
}
