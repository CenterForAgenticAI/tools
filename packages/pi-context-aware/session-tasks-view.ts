/** Bounded projections of the transcript-authoritative task list.
 *
 * Everything here is a view. Replay stays the authority, so none of these
 * functions can widen what the list says — only show less of it.
 *
 * The projection is what makes the list survive compaction: it is regenerated
 * from replayed state every turn, so no particular transcript message has to
 * survive summarisation for the model to still see its tasks.
 */

import { redactText } from "./workstream-safety.js";
import {
	activeTasks,
	countTasks,
	isListFinished,
	isListStuck,
	type Task,
	type TaskCounts,
	type TaskStatus,
	type TasksSnapshot,
} from "./session-tasks.js";

export const TASKS_CONTEXT_ELEMENT = "session-tasks" as const;
export const TASKS_CONTEXT_SOURCE = "pi-extension:context-aware" as const;

/**
 * Deliberately smaller than the 4,000-character workstream envelope. The task
 * list is repeated every turn, so its cost is paid on every request.
 */
export const MAX_TASKS_CONTEXT_CHARS = 2_000;


const STATUS_MARKER: Record<TaskStatus, string> = {
	pending: " ",
	active: ">",
	done: "x",
	blocked: "!",
	deferred: "~",
};

const MARKER_STATUS: Record<string, TaskStatus> = {
	" ": "pending",
	"": "pending",
	">": "active",
	x: "done",
	X: "done",
	"!": "blocked",
	"~": "deferred",
};

function xmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttribute(value: string): string {
	return xmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function safe(value: string, maxLength: number): string {
	return redactText(value, { maxLength }).trim();
}

// ---------------------------------------------------------------------------
// The per-turn context envelope
// ---------------------------------------------------------------------------

interface RenderBudget {
	readonly titleChars: number;
	readonly noteChars: number;
	readonly showSubtasks: boolean;
	readonly maxDepth: number;
	readonly includeStatus: boolean;
	/**
	 * Drop the progression rule and keep only what the list IS.
	 *
	 * The instruction is fixed overhead paid on every turn, so at the tightest
	 * budgets it competes with the tasks themselves. Showing which tasks remain
	 * matters more than restating how to move them.
	 */
	readonly terseInstruction?: boolean;
	/**
	 * Render at most this many top-level tasks.
	 *
	 * The last resort. Every other stage keeps all of them and trims detail, but
	 * the schema allows 100 tasks and a long enough list does not fit at any
	 * detail level — which used to drop the whole envelope, hiding the list
	 * completely at exactly the point it was largest. A short list is worth more
	 * than no list, provided the count of what was dropped is stated.
	 */
	readonly maxTasks?: number;
}

/**
 * Count detail that will be hidden when the envelope is reduced.
 *
 * Top-level commitments are never removed. Child detail and long titles/notes
 * are the first things to elide, so breadth is preserved before depth.
 */
function hiddenDetailCount(tasks: readonly Task[], budget: RenderBudget, depth = 0): number {
	let hidden = 0;
	for (const task of tasks) {
		if (task.title.length > budget.titleChars || (task.note !== undefined && task.note.length > budget.noteChars)) hidden += 1;
		const children = task.subtasks ?? [];
		if (children.length > 0 && (!budget.showSubtasks || depth >= budget.maxDepth)) hidden += children.length;
		else if (children.length > 0) hidden += hiddenDetailCount(children, budget, depth + 1);
	}
	return hidden;
}

function renderTaskElement(task: Task, budget: RenderBudget, indent: string, depth = 0): string {
	const ref = task.ref === undefined ? "" : ` ref="${xmlAttribute(task.ref)}"`;
	const note = budget.noteChars > 0 && task.note !== undefined ? ` note="${xmlAttribute(safe(task.note, budget.noteChars))}"` : "";
	const status = budget.includeStatus ? ` status="${task.status}"` : "";
	const children = budget.showSubtasks && depth < budget.maxDepth ? task.subtasks ?? [] : [];
	const open = `${indent}<task id="${xmlAttribute(task.id)}"${ref}${status}${note}>`;
	const titleChars = task.status === "active" || task.status === "blocked" ? Math.max(48, budget.titleChars) : budget.titleChars;
	const title = xmlText(safe(task.title, titleChars));
	if (!budget.includeStatus && (task.status === "done" || task.status === "deferred") && children.length === 0) {
		return `${indent}<task id="${xmlAttribute(task.id)}"${ref} />`;
	}
	if (children.length === 0) return `${open}${title}</task>`;
	const childMarkup = children.map((child) => `\n${renderTaskElement(child, budget, `${indent}  `, depth + 1)}`).join("");
	return `${open}${title}${childMarkup}\n${indent}</task>`;
}

/**
 * How this session sees its list.
 *
 * A worker's list is not its own: it was dispatched, and pi-delegate reads its
 * counts back as the lane's progress. Saying so gives a worker a reason to keep
 * the list moving beyond being told to.
 */
export type TasksAudience = "foreground" | "worker";

export interface TasksContextOptions {
	readonly maxChars?: number;
	/**
	 * Whether a `session_tasks` claimant is actually callable in this session.
	 *
	 * Defaults to true so existing callers are unaffected, but the real answer is
	 * not always yes: a delegated worker's tool allowlist could strip the tool
	 * while the extension stayed loaded, and the envelope still instructed a call
	 * that could not be made.
	 */
	readonly toolAvailable?: boolean;
	readonly audience?: TasksAudience;
}

/**
 * The instruction line: what to do, and when to record it.
 *
 * The envelope used to describe position only — counts and statuses — and said
 * to keep one task active. It never said WHEN a status should change, and the
 * field showed it: across 14 days, tasks were set `done` 2093 times but `active`
 * only 1075, so roughly half of all completed work was never shown as in
 * progress, and `update` calls arrived in retrospective bursts.
 */
function renderInstruction(audience: TasksAudience, toolAvailable: boolean, terse = false): string {
	const preamble = "Extension state only; not a new user request.";
	const framing = audience === "worker"
		? "This is the checklist your supervisor dispatched with your task."
		: "This is your task list for this session.";
	if (!toolAvailable) {
		// Naming a tool this session cannot call is worse than saying nothing: it
		// invites a failed call and teaches the model the list is not actionable.
		// This branch is longer than the terse tool-available one, so it has to
		// honour the same budget or a tight envelope cannot shrink far enough.
		if (terse) return `${preamble} ${framing} No task tool here; work through it in order.`;
		return `${preamble} ${framing} No task tool is available here, so work through it in order and report what you completed in your reply.`;
	}
	if (terse) return `${preamble} ${framing} Record each status change with session_tasks as it happens.`;
	const stakes = audience === "worker"
		? " Its status is read back as your lane's progress — a list you never move reports none."
		: "";
	return `${preamble} ${framing}${stakes}`
		+ " Set a task active before you start it, and done once its proof passes — record each change with session_tasks as it happens, not in a batch at the end."
		+ " Keep one task active where you can. blocked and deferred both need a written reason.";
}

/**
 * Retention order when the list will not fit: live work first, finished last.
 *
 * Ties keep their original position because the sort is stable, so the list
 * still reads in the order it was planned.
 */
function rankForRetention(task: Task): number {
	switch (task.status) {
		case "active": return 0;
		case "blocked": return 1;
		case "pending": return 2;
		case "deferred": return 3;
		case "done": return 4;
		default: return 2;
	}
}

function renderEnvelope(
	snapshot: TasksSnapshot,
	budget: RenderBudget,
	audience: TasksAudience,
	toolAvailable: boolean,
): string {
	const counts = countTasks(snapshot.tasks);
	// Keep the work that is still live. A done task is the least useful thing to
	// carry when there is not room for everything, and the progress element still
	// reports the true totals either way.
	const shown = budget.maxTasks === undefined || snapshot.tasks.length <= budget.maxTasks
		? snapshot.tasks
		: [...snapshot.tasks].sort((a, b) => rankForRetention(a) - rankForRetention(b)).slice(0, budget.maxTasks);
	const droppedTasks = snapshot.tasks.length - shown.length;
	const omitted = hiddenDetailCount(shown, budget) + droppedTasks;
	const taskMarkup = shown.map((task) => `\n  ${renderTaskElement(task, budget, "  ").trimStart()}`).join("");
	const elision = omitted > 0 ? `\n  <elided count="${omitted}" />` : "";
	const state = isListStuck(snapshot.tasks) ? "stuck" : isListFinished(snapshot.tasks) ? "finished" : "in-progress";
	return `<${TASKS_CONTEXT_ELEMENT} source="${TASKS_CONTEXT_SOURCE}" user-input="false" response-expected="false">\n` +
		`  <progress done="${counts.done}" total="${counts.total}" active="${counts.active}" blocked="${counts.blocked}" deferred="${counts.deferred}" state="${state}" />` +
		`${taskMarkup}${elision}\n` +
		`  <instruction>${xmlText(renderInstruction(audience, toolAvailable, budget.terseInstruction))}</instruction>\n` +
		`</${TASKS_CONTEXT_ELEMENT}>`;
}

/**
 * What a worker sees when it holds the tool and has no list.
 *
 * `buildTasksContextEnvelope` returns null for an empty list, so a worker whose
 * dispatch seeded nothing was never told the list existed — even with many steps
 * ahead of it. A foreground session keeps its silence: an unprompted list there
 * is noise, and its own tool guidance already reaches it.
 */
function renderPlanningHint(): string {
	return `<${TASKS_CONTEXT_ELEMENT} source="${TASKS_CONTEXT_SOURCE}" user-input="false" response-expected="false">\n` +
		`  <progress done="0" total="0" active="0" blocked="0" deferred="0" state="empty" />\n` +
		`  <instruction>${xmlText("Extension state only; not a new user request. Your dispatch seeded no checklist. If this task has several steps worth tracking, plan one with session_tasks, then set each task active before you start it and done once its proof passes. Your list is read back as this lane's progress.")}</instruction>\n` +
		`</${TASKS_CONTEXT_ELEMENT}>`;
}

/**
 * Build the per-turn envelope, shrinking it until it fits.
 *
 * Elision is always explicit: an elided list carries a count, so the model can
 * tell a shortened list from a complete one. Silently truncating would let an
 * agent believe it had seen every task.
 */
export function buildTasksContextEnvelope(
	snapshot: TasksSnapshot | null,
	options: TasksContextOptions = {},
): string | null {
	const audience = options.audience ?? "foreground";
	const toolAvailable = options.toolAvailable ?? true;
	const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_TASKS_CONTEXT_CHARS));
	if (snapshot === null || snapshot.tasks.length === 0) {
		// `null` is the un-seeded worker: replay found no task entry at all. That
		// and an emptied list are the same thing to the model — nothing to work
		// from — so both get the hint. Everyone else keeps today's silence.
		if (audience !== "worker" || !toolAvailable) return null;
		const hint = renderPlanningHint();
		return hint.length <= maxChars ? hint : null;
	}
	const stages: RenderBudget[] = [
		{ titleChars: 200, noteChars: 240, showSubtasks: true, maxDepth: 16, includeStatus: true },
		{ titleChars: 120, noteChars: 160, showSubtasks: true, maxDepth: 8, includeStatus: true },
		{ titleChars: 80, noteChars: 100, showSubtasks: false, maxDepth: 0, includeStatus: true },
		{ titleChars: 48, noteChars: 60, showSubtasks: false, maxDepth: 0, includeStatus: true },
		{ titleChars: 24, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: true },
		// Past here the list itself is the scarce thing, so the progression rule
		// goes before any more task detail does.
		{ titleChars: 24, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: true, terseInstruction: true },
		{ titleChars: 8, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: true, terseInstruction: true },
		{ titleChars: 1, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: false, terseInstruction: true },
		// Only now start dropping whole tasks, live work first to survive. Before
		// this the envelope was abandoned entirely once a long list stopped fitting,
		// so the list vanished exactly when it was largest.
		{ titleChars: 24, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: true, terseInstruction: true, maxTasks: 40 },
		{ titleChars: 16, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: true, terseInstruction: true, maxTasks: 20 },
		{ titleChars: 8, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: false, terseInstruction: true, maxTasks: 10 },
		{ titleChars: 1, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: false, terseInstruction: true, maxTasks: 1 },
	];
	for (const budget of stages) {
		const rendered = renderEnvelope(snapshot, budget, audience, toolAvailable);
		if (rendered.length <= maxChars) return rendered;
	}
	// A caller-supplied cap below the fixed envelope overhead opts out rather
	// than receiving half an element.
	const minimal = renderEnvelope(
		snapshot,
		{ titleChars: 1, noteChars: 0, showSubtasks: false, maxDepth: 0, includeStatus: false, terseInstruction: true },
		audience,
		toolAvailable,
	);
	return minimal.length <= maxChars ? minimal : null;
}

// ---------------------------------------------------------------------------
// The widget line
// ---------------------------------------------------------------------------

/**
 * The second line of the merged focus widget.
 *
 * Returns null when there is no list, so a session that never uses tasks keeps
 * today's single-line focus widget exactly as it is.
 */
export function tasksWidgetLine(snapshot: TasksSnapshot | null): string | null {
	if (snapshot === null || snapshot.tasks.length === 0) return null;
	const counts = countTasks(snapshot.tasks);
	const parts = [`☑ ${counts.done}/${counts.total}`];
	const active = activeTasks(snapshot.tasks)[0];
	if (active !== undefined) parts.push(`▸ ${safe(active.title, 120)}`);
	if (counts.blocked > 0) parts.push(`⚠ ${counts.blocked} blocked`);
	// More than one active task is legitimate with parallel lanes, but drift is
	// common enough that it should be visible rather than silent.
	if (counts.active > 1) parts.push(`⚠ ${counts.active} active`);
	if (counts.deferred > 0) parts.push(`~ ${counts.deferred} deferred`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Markdown, used for /tasks export, /tasks import, and delegate degradation
// ---------------------------------------------------------------------------

function markdownLine(task: Task, indent: string): string {
	const marker = STATUS_MARKER[task.status];
	const note = task.note === undefined ? "" : ` — ${safe(task.note, 240)}`;
	return `${indent}- [${marker}] ${safe(task.title, 200)}${note}`;
}

/** Render the list as an ordinary markdown checklist. */
export function renderTasksMarkdown(tasks: readonly Task[]): string {
	const lines: string[] = [];
	const visit = (items: readonly Task[], indent: string): void => {
		for (const task of items) {
			lines.push(markdownLine(task, indent));
			visit(task.subtasks ?? [], `${indent}  `);
		}
	};
	visit(tasks, "");
	return lines.join("\n");
}

export interface ParsedMarkdownTask {
	readonly title: string;
	readonly status: TaskStatus;
	readonly note?: string;
	readonly subtasks?: readonly ParsedMarkdownTask[];
}

const CHECKLIST_LINE = /^(\s*)[-*]\s*\[([^\]]?)\]\s*(.+)$/;

/**
 * Read a markdown checklist back into tasks.
 *
 * This is the degradation path's other half: whatever pi-delegate rendered when
 * context-aware was absent can be read back when it is present. It fails soft
 * on purpose — an unknown marker becomes pending rather than rejecting the
 * whole list, because losing the plan is worse than losing one status.
 */
export function parseTasksMarkdown(text: string): ParsedMarkdownTask[] {
	type MutableTask = { title: string; status: TaskStatus; note?: string; subtasks?: MutableTask[] };
	const parsed: MutableTask[] = [];
	const stack: Array<{ indent: number; task: MutableTask }> = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const match = CHECKLIST_LINE.exec(rawLine);
		if (!match) continue;
		const [, indentText = "", marker = "", body = ""] = match;
		const status = MARKER_STATUS[marker] ?? "pending";
		const separator = body.indexOf(" — ");
		const title = (separator === -1 ? body : body.slice(0, separator)).trim().slice(0, 200);
		if (title.length === 0) continue;
		const noteText = separator === -1 ? undefined : body.slice(separator + 3).trim().slice(0, 240);
		const note = noteText !== undefined && noteText.length > 0 ? noteText : undefined;
		const task: MutableTask = { title, status, ...(note === undefined ? {} : { note }) };
		const indent = indentText.length;
		while (stack.length > 0 && indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop();
		const parent = stack[stack.length - 1]?.task;
		if (parent === undefined) parsed.push(task);
		else (parent.subtasks ??= []).push(task);
		stack.push({ indent, task });
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Reminders and handoffs
// ---------------------------------------------------------------------------

function taskSummaryLines(tasks: readonly Task[], limit: number): string[] {
	return tasks.slice(0, limit).map((task) => {
		const note = task.note === undefined ? "" : ` (${safe(task.note, 160)})`;
		return `- [${task.status}] ${task.id}: ${safe(task.title, 160)}${note}`;
	});
}

/**
 * The settle-time nudge. Fires once per settle, and only for active work.
 *
 * It recovers a turn that stopped mid-task, which is why it exists. It does
 * not start the next planned one: settlement cannot tell a model that ran out
 * of turn from one that obeyed a bounded request, so promoting a pending row
 * here overrides the user rather than helping the agent.
 */
export function tasksSettleReminder(
	snapshot: TasksSnapshot | null,
	options: { readonly toolAvailable?: boolean } = {},
): string | null {
	if (snapshot === null) return null;
	const remaining = activeTasks(snapshot.tasks);
	if (remaining.length === 0) return null;
	const lines = [
		`${remaining.length} task(s) are still active on this session's list:`,
		...taskSummaryLines(remaining, 10),
	];
	if (remaining.length > 10) lines.push(`- (+${remaining.length - 10} more)`);
	// Without the tool there is nothing to record with, so asking for a call the
	// session cannot make only invites a failure.
	lines.push((options.toolAvailable ?? true)
		? "Resume only the active work. Reconcile completed active work and record its status with `session_tasks`."
		: "Resume only the active work, then say what you finished and why you are stopping.");
	lines.push("Pending tasks do not authorize starting work or changing their status. Honor the user's stopping point.");
	return lines.join("\n");
}

/**
 * One final correction after an automatic continuation made no task-list
 * progress. It gives the model—not the user—the bookkeeping failure and a
 * bounded chance to either keep working or surface the precise blocker.
 *
 * Takes the reminder the caller already rendered rather than re-deriving it,
 * so the correction cannot disagree with the message it decorates. Pass the
 * `toolAvailable` the reminder was built with; the two wordings are one
 * instruction split across the pair.
 */
export function tasksSettleCorrection(
	reminder: string,
	options: { readonly toolAvailable?: boolean } = {},
): string {
	const instruction = (options.toolAvailable ?? true)
		? "Reconcile the active work with `session_tasks`. If it cannot proceed, record its specific blocker and ask the user one precise question in your visible reply."
		: "No task tool is available in this session. Continue what you can, then use your visible reply to state exactly what you finished or ask the user one precise question about the blocker.";
	return [
		"The previous automatic continuation ended without changing this task list.",
		reminder,
		instruction,
	].join("\n");
}

/** The remaining list, appended to a compaction seed so the next phase inherits it. */
export function tasksCompactionCarry(snapshot: TasksSnapshot | null): string | null {
	if (snapshot === null || snapshot.tasks.length === 0) return null;
	const counts = countTasks(snapshot.tasks);
	const remaining = snapshot.tasks.filter((task) => task.status !== "done" && task.status !== "deferred");
	if (remaining.length === 0) return null;
	return [
		`Task list carried forward (${counts.done}/${counts.total} done, extension state, not a new user request):`,
		...taskSummaryLines(remaining, 20),
		...(remaining.length > 20 ? [`- (+${remaining.length - 20} more)`] : []),
	].join("\n");
}

export type { TaskCounts };
