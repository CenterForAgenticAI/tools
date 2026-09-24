/** Wiring for the session task list: the tool, the commands, and persistence.
 *
 * Kept out of index.ts, which is already long enough that adding a feature to
 * it is how the file got that way.
 */

import { Type } from "typebox";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	MAX_TASK_NOTE_CHARS,
	MAX_TASK_TITLE_CHARS,
	MAX_TASK_ID_CHARS,
	addTask,
	appendTasksSnapshot,
	applyUpdates,
	countTasks,
	createTasksSnapshot,
	findTask,
	nextSnapshot,
	planTasks,
	removeTasks,
	reorderTasks,
	resolveAuthoritativeTasks,
	type MutationResult,
	type Task,
	type TaskActor,
	type TaskOrigin,
	type TaskStatus,
	type TaskUpdate,
	type TasksSnapshot,
} from "./session-tasks.js";
import {
	MAX_TASKS_CONTEXT_CHARS,
	parseTasksMarkdown,
	renderTasksMarkdown,
	tasksWidgetLine,
} from "./session-tasks-view.js";
import {
	TASKS_CHANGED_EVENT,
	buildTasksChangedEvent,
	parseDelegationProgressFields,
	parseDelegationRunRecord,
	type DelegationProgressFields,
	type DelegationRunRecord,
	type DelegationTaskRow,
} from "./session-tasks-contract.js";

export interface TasksRuntimeDeps {
	/** Transcript entries replay reads from; the caller decides which branch. */
	readonly entries: (ctx: ExtensionContext) => readonly unknown[];
	/** Whether the feature is on for this session. */
	readonly enabled: (ctx: ExtensionContext) => boolean;
	/** Redraw the merged focus widget after a mutation. */
	readonly refreshWidget: (ctx: ExtensionContext) => void;
	readonly debugLog: (message: string) => void;
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

export function currentTasks(deps: TasksRuntimeDeps, ctx: ExtensionContext): TasksSnapshot | null {
	if (!deps.enabled(ctx)) return null;
	return resolveAuthoritativeTasks(deps.entries(ctx));
}

/** The widget's second line, or null when this session has no list. */
export function currentTasksWidgetLine(deps: TasksRuntimeDeps, ctx: ExtensionContext): string | null {
	return tasksWidgetLine(currentTasks(deps, ctx));
}

const LINEAGE_ROOT_ENV = "PI_DELEGATE_LINEAGE_ROOT_RUN_ID";
const LINEAGE_RUN_ENV = "PI_DELEGATE_LINEAGE_RUN_ID";
const LINEAGE_CHILD_ENV = "PI_DELEGATE_LINEAGE_CHILD_INDEX";
const MAX_SUBTREE_LANES = 64;
const MAX_RUNS_FILE_BYTES = 256 * 1024;
const MAX_RUNS_FILE_LINE_CHARS = 64 * 1024;

interface DelegationAddress {
	readonly rootRunId: string;
	readonly lineagePath: string;
}

interface SubtreeLane {
	readonly lineagePath: string;
	readonly progress: DelegationProgressFields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delegationAddress(env: NodeJS.ProcessEnv = process.env): DelegationAddress | null {
	const rootRunId = env[LINEAGE_ROOT_ENV];
	const runId = env[LINEAGE_RUN_ENV];
	const rawChildIndex = env[LINEAGE_CHILD_ENV];
	if (!rootRunId || !runId || !/^[A-Za-z0-9._-]+$/.test(rootRunId) || !/^[A-Za-z0-9._-]+$/.test(runId)) return null;
	if (!rawChildIndex || !/^\d+$/.test(rawChildIndex)) return null;
	return { rootRunId, lineagePath: `${rootRunId}/${runId}#${rawChildIndex}` };
}

function eventInSubtree(
	eventLineagePath: string,
	callerLineagePath: string,
	ancestorPrefix: string | undefined,
	eventAncestorPath: string | undefined,
): boolean {
	if (eventLineagePath === callerLineagePath || eventLineagePath.startsWith(`${callerLineagePath}/`)) return true;
	return ancestorPrefix !== undefined && eventAncestorPath !== undefined
		&& (eventAncestorPath === ancestorPrefix || eventAncestorPath.startsWith(`${ancestorPrefix}/`));
}

function eventInOwnedRun(eventLineagePath: string, rootRunId: string): boolean {
	return eventLineagePath.startsWith(`${rootRunId}/`);
}

async function readOwnedRuns(
	agentDir: string,
	ownerSessionId: string,
): Promise<readonly DelegationRunRecord[]> {
	const runsPath = path.join(agentDir, "extensions", "pi-delegate", "runs.jsonl");
	let size: number;
	try {
		size = (await stat(runsPath)).size;
	} catch {
		return [];
	}
	if (size === 0) return [];
	const start = Math.max(0, size - MAX_RUNS_FILE_BYTES);
	const input = createReadStream(runsPath, { encoding: "utf8", start, end: size - 1 });
	const owned: DelegationRunRecord[] = [];
	try {
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (line.length > MAX_RUNS_FILE_LINE_CHARS) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				continue;
			}
			const record = parseDelegationRunRecord(raw);
			if (record !== undefined && record.ownerSessionId === ownerSessionId) owned.push(record);
		}
	} catch {
		// A concurrent append or truncation must not make the subtree tool fail.
		try { input.destroy(); } catch { /* best effort */ }
	}
	return owned;
}

async function readEventSink(
	sink: string,
	ancestorLineagePath: string | undefined,
	accept: (lineagePath: string, ancestorPrefix: string | undefined, eventAncestorPath: string | undefined) => boolean,
	latest: Map<string, DelegationProgressFields>,
	state: { ancestorPrefix?: string; elided: number },
): Promise<void> {
	let input: ReturnType<typeof createReadStream>;
	try {
		input = createReadStream(sink, { encoding: "utf8" });
	} catch {
		return;
	}
	try {
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(raw) || typeof raw.lineagePath !== "string") continue;
			const eventAncestorPath = typeof raw.ancestorPath === "string" ? raw.ancestorPath : undefined;
			if (!accept(raw.lineagePath, state.ancestorPrefix, eventAncestorPath)) continue;
			if (ancestorLineagePath !== undefined && raw.lineagePath === ancestorLineagePath && eventAncestorPath !== undefined) {
				state.ancestorPrefix = eventAncestorPath;
			}
			const progress = parseDelegationProgressFields(raw.fields);
			if (progress === undefined) continue;
			if (!latest.has(raw.lineagePath) && latest.size >= MAX_SUBTREE_LANES) {
				state.elided += 1;
				continue;
			}
			latest.set(raw.lineagePath, progress);
		}
	} catch {
		// Missing sinks, read races, and a file removed between open and read are
		// all an empty current view. A malformed line is handled per line above.
		try { input.destroy(); } catch { /* best effort */ }
	}
}

/**
 * Read only matching NDJSON lines from the existing delegate sink.
 *
 * A delegated worker resolves its subtree from lineage environment variables.
 * A root session has no lineage, so it resolves the roots it owns from the
 * bounded, append-only runs registry by matching its Pi session id.
 * The latest valid event for each lineage is the current-state projection; the
 * sink is not a history API.
 */
export async function readDelegationSubtree(
	env: NodeJS.ProcessEnv = process.env,
	ownerSessionId?: string,
): Promise<{ readonly address: DelegationAddress | null; readonly lanes: readonly SubtreeLane[]; readonly elided: number }> {
	const lineageAddress = delegationAddress(env);
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? os.homedir(), ".pi", "agent");
	const ownedRuns = lineageAddress === null && ownerSessionId !== undefined
		? await readOwnedRuns(agentDir, ownerSessionId)
		: [];
	const rootRunIds = lineageAddress === null
		? [...new Set(ownedRuns.map((run) => run.rootRunId))]
		: [lineageAddress.rootRunId];
	if (rootRunIds.length === 0) return { address: null, lanes: [], elided: 0 };
	const address = lineageAddress ?? {
		rootRunId: rootRunIds[0] ?? "owned-runs",
		lineagePath: rootRunIds.length === 1 ? rootRunIds[0] ?? "owned-runs" : "owned-runs",
	};
	const latest = new Map<string, DelegationProgressFields>();
	let elided = 0;
	for (const rootRunId of rootRunIds) {
		const state: { ancestorPrefix?: string; elided: number } = { elided: 0 };
		const sink = path.join(agentDir, "extensions", "pi-delegate", "event-bus", rootRunId, "events.ndjson");
		await readEventSink(
			sink,
			lineageAddress?.lineagePath,
			(lineagePath, ancestorPrefix, eventAncestorPath) => lineageAddress === null
				? eventInOwnedRun(lineagePath, rootRunId)
				: eventInSubtree(lineagePath, lineageAddress.lineagePath, ancestorPrefix, eventAncestorPath),
			latest,
			state,
		);
		elided += state.elided;
	}
	return { address, lanes: [...latest.entries()].map(([lineagePath, progress]) => ({ lineagePath, progress })), elided };
}

function xml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function taskRowAttributes(row: DelegationTaskRow): string {
	return [
		row.ref === undefined ? "" : ` ref="${xml(row.ref)}"`,
		row.id === undefined ? "" : ` id="${xml(row.id)}"`,
		row.ownerTaskId === undefined ? "" : ` owner-task-id="${xml(row.ownerTaskId)}"`,
		// A worker-numbered row is shown so its status and blocked reason can be
		// attributed to something, but `id-kind` marks it as belonging to the
		// worker's list. Never treat it as an id in this session's own list.
		row.localTaskId === undefined ? "" : ` worker-task-id="${xml(row.localTaskId)}"`,
		row.idKind === undefined ? "" : ` id-kind="${row.idKind}"`,
		row.status === undefined ? "" : ` status="${row.status}"`,
		row.title === undefined ? "" : ` title="${xml(row.title)}"`,
		row.note === undefined ? "" : ` note="${xml(row.note)}"`,
	].join("");
}

function laneLines(lane: SubtreeLane): string[] {
	const counts = lane.progress.counts;
	const summary = counts === undefined ? "" : ` done="${counts.done}" total="${counts.total}" blocked="${counts.blocked}" outcome="${counts.outcome}"${counts.active === null ? "" : ` active="${xml(counts.active)}"`}`;
	if (lane.progress.rows.length === 0) return [`  <lane lineage="${xml(lane.lineagePath)}"${summary} />`];
	return lane.progress.rows.map((row) => `  <task lineage="${xml(lane.lineagePath)}"${summary}${taskRowAttributes(row)} />`);
}

function ownTaskLines(tasks: readonly Task[]): string[] {
	const lines: string[] = [];
	const visit = (items: readonly Task[], indent: string): void => {
		for (const task of items) {
			lines.push(`  ${indent}<own-task id="${xml(task.id)}" status="${task.status}" title="${xml(task.title)}"${task.ref === undefined ? "" : ` ref="${xml(task.ref)}"`}${task.note === undefined ? "" : ` note="${xml(task.note)}"`} />`);
			visit(task.subtasks ?? [], `${indent}  `);
		}
	};
	visit(tasks, "");
	return lines;
}

function renderDelegationSubtree(
	tasks: readonly Task[],
	projection: Awaited<ReturnType<typeof readDelegationSubtree>>,
): string {
	const scope = projection.address === null ? "none" : projection.address.lineagePath;
	const header = `<session-task-subtree source="pi-delegate" scope="${xml(scope)}" state="current">`;
	const footer = "  <instruction>Current state only, not complete history; retained delegate events may omit older progress.</instruction>\n</session-task-subtree>";
	const body: string[] = [];
	let omitted = projection.elided;
	if (projection.lanes.length === 0) body.push("  <empty />");
	for (const line of ownTaskLines(tasks)) {
		if (`${header}\n${[...body, line, footer].join("\n")}`.length <= MAX_TASKS_CONTEXT_CHARS) body.push(line);
		else omitted += 1;
	}
	for (const lane of projection.lanes) {
		for (const line of laneLines(lane)) {
			if (`${header}\n${[...body, line, footer].join("\n")}`.length <= MAX_TASKS_CONTEXT_CHARS) body.push(line);
			else omitted += 1;
		}
	}
	if (body.length === 0 && omitted === 0) body.push("  <empty />");
	if (omitted > 0) {
		const marker = `  <elided count="${omitted}" />`;
		while (`${header}\n${[...body, marker, footer].join("\n")}`.length > MAX_TASKS_CONTEXT_CHARS && body.length > 0) {
			body.pop();
			omitted += 1;
		}
		body.push(`  <elided count="${omitted}" />`);
	}
	const rendered = `${header}\n${body.join("\n")}\n${footer}`;
	return rendered.length <= MAX_TASKS_CONTEXT_CHARS ? rendered : `${header}\n  <elided count="${Math.max(1, omitted)}" />\n${footer}`.slice(0, MAX_TASKS_CONTEXT_CHARS);
}

function sessionIdOf(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager as unknown as { getSessionId?: () => string };
	const id = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
	return typeof id === "string" && id.length > 0 ? id : "unknown-session";
}

interface PersistOptions {
	readonly changed?: { readonly id: string; readonly status: TaskStatus; readonly title: string };
}

/**
 * Write the new list as a full snapshot.
 *
 * A snapshot per mutation rather than a delta: replay stays a fold over
 * independent records, so a lost or reordered entry cannot corrupt the list —
 * it can only make it older.
 */
function persist(
	pi: ExtensionAPI,
	deps: TasksRuntimeDeps,
	ctx: ExtensionContext,
	previous: TasksSnapshot | null,
	tasks: readonly Task[],
	options: PersistOptions = {},
): TasksSnapshot {
	const snapshot = previous === null
		? createTasksSnapshot({ piSessionId: sessionIdOf(ctx), tasks })
		: nextSnapshot(previous, tasks);
	appendTasksSnapshot(pi as unknown as { appendEntry: <T>(customType: string, data?: T) => void }, snapshot);
	deps.refreshWidget(ctx);
	const counts = countTasks(snapshot.tasks);
	deps.debugLog(`tasks: revision ${snapshot.revision}, ${counts.done}/${counts.total} done, ${counts.blocked} blocked`);
	// Bounded counts on the local bus; cross-process consumers read the
	// pi-delegate event bus instead.
	try {
		(pi as unknown as { events?: { emit?: (name: string, payload: unknown) => void } }).events?.emit?.(
			TASKS_CHANGED_EVENT,
			buildTasksChangedEvent(snapshot, options.changed),
		);
	} catch (err) {
		deps.debugLog(`tasks: change event not delivered: ${String(err)}`);
	}
	return snapshot;
}

// ---------------------------------------------------------------------------
// Rendering for humans
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "☐",
	active: "▸",
	done: "☑",
	blocked: "⚠",
	deferred: "~",
};

const TASK_ID_ORDER = new Intl.Collator("en", { numeric: true });

function tasksInNumberOrder(tasks: readonly Task[]): Task[] {
	return [...tasks].sort((left, right) => TASK_ID_ORDER.compare(left.id, right.id));
}

export function renderTaskList(snapshot: TasksSnapshot | null): string {
	if (snapshot === null || snapshot.tasks.length === 0) return "No task list for this session.";
	const counts = countTasks(snapshot.tasks);
	const lines: string[] = [`${counts.done}/${counts.total} done${counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""}${counts.deferred > 0 ? ` · ${counts.deferred} deferred` : ""}`];
	for (const task of tasksInNumberOrder(snapshot.tasks)) {
		lines.push(renderTaskLine(task, ""));
		for (const child of tasksInNumberOrder(task.subtasks ?? [])) lines.push(renderTaskLine(child, "    "));
	}
	return lines.join("\n");
}

function renderTaskLine(task: Task, indent: string): string {
	const note = task.note === undefined ? "" : ` — ${task.note}`;
	const origin = task.origin === "agent" ? "" : ` [${task.origin}]`;
	const ref = task.ref === undefined ? "" : ` [ref=${task.ref}]`;
	return `${indent}${STATUS_GLYPH[task.status]} ${task.id}  ${task.title}${origin}${ref}${note}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const taskRefSchema = Type.String({
	description: "Optional bounded opaque reference; not a task id or reconciliation key.",
	maxLength: MAX_TASK_ID_CHARS,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

const seedTaskSchema = Type.Object({
	title: Type.String({ description: "One line naming the task.", maxLength: MAX_TASK_TITLE_CHARS }),
	note: Type.Optional(Type.String({ description: "Required when the status is blocked or deferred: why.", maxLength: MAX_TASK_NOTE_CHARS })),
	ref: Type.Optional(taskRefSchema),
	status: Type.Optional(Type.Union([
		Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("deferred"),
	], { description: "Defaults to pending." })),
});

const tasksSchema = Type.Object({
	action: Type.Union([
		Type.Literal("plan"), Type.Literal("add"), Type.Literal("update"),
		Type.Literal("remove"), Type.Literal("reorder"), Type.Literal("list"), Type.Literal("subtree"),
	], { description: "plan replaces the whole list and is the normal way to start. update takes an array so one call can flip several tasks." }),
	tasks: Type.Optional(Type.Array(Type.Intersect([
		seedTaskSchema,
		Type.Object({ subtasks: Type.Optional(Type.Array(seedTaskSchema, { description: "One level only; a sub-task cannot have its own sub-tasks.", maxItems: 50 })) }),
	]), { description: "For plan: the whole list, in order.", maxItems: 100 })),
	title: Type.Optional(Type.String({ description: "For add: the new task's title.", maxLength: MAX_TASK_TITLE_CHARS })),
	note: Type.Optional(Type.String({ description: "For add: an optional note.", maxLength: MAX_TASK_NOTE_CHARS })),
	ref: Type.Optional(taskRefSchema),
	parent: Type.Optional(Type.String({ description: "For add: the task this becomes a step of.", maxLength: 32 })),
	after: Type.Optional(Type.String({ description: "For add: place the new task after this sibling.", maxLength: 32 })),
	before: Type.Optional(Type.String({ description: "For add: place the new task before this sibling.", maxLength: 32 })),
	updates: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ description: "The task to change.", maxLength: 32 }),
		status: Type.Optional(Type.Union([
			Type.Literal("pending"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked"), Type.Literal("deferred"),
		], { description: "blocked and deferred both require a note saying why." })),
		title: Type.Optional(Type.String({ description: "Only for tasks you created; user and spec tasks cannot be retitled.", maxLength: MAX_TASK_TITLE_CHARS })),
		ref: Type.Optional(taskRefSchema),
		note: Type.Optional(Type.String({ description: "Required when moving to blocked or deferred.", maxLength: MAX_TASK_NOTE_CHARS })),
	}), { description: "For update: one entry per task to change. Batch them; do not call once per task.", maxItems: 100 })),
	ids: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { description: "For remove: the tasks to drop. For reorder: every task id, in the order you want.", maxItems: 100 })),
});

const TOOL_DESCRIPTION = "Keep an enumerable checklist for this session that survives compaction. Use it for multi-step work that will cross a compaction or a delegation, so the remaining tasks are still known afterwards. The subtree action reads current delegation state (current state), not complete history: delegate retention keeps at most MAX_STEPS=12 events per child and MAX_CHILDREN=16 children. When delegate support is available, a dispatch can seed a worker's list with `handoff: { tasks: [...] }`; otherwise subtree may be empty.";

const TOOL_PROMPT_SNIPPET = [
	"Use session_tasks when a request contains several distinct pieces of work that will outlive one reply, not for a two-file edit.",
	"Lay the whole list out in one plan call, then batch transitions through update — one call can flip several tasks.",
	"Keep one task active where you can. Mark blocked or deferred only with a written reason; both need one.",
	"A parent's status follows its sub-tasks and cannot be set directly.",
].join(" ");

function toolFailure(reason: string) {
	return { content: [{ type: "text" as const, text: reason }], details: { error: reason }, isError: true };
}

export function registerSessionTasks(pi: ExtensionAPI, deps: TasksRuntimeDeps): void {
	pi.registerTool({
		name: "session_tasks",
		label: "Session Tasks",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		parameters: tasksSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!deps.enabled(ctx)) return toolFailure("The session task list is disabled for this session.");
			const previous = currentTasks(deps, ctx);
			const existing = previous?.tasks ?? [];

			if (params.action === "list") {
				return {
					content: [{ type: "text", text: renderTaskList(previous) }],
					details: { tasks: existing, counts: countTasks(existing) },
				};
			}
			if (params.action === "subtree") {
				const projection = await readDelegationSubtree(process.env, sessionIdOf(ctx));
				return {
					content: [{ type: "text", text: renderDelegationSubtree(existing, projection) }],
					details: {
						tasks: existing,
						delegation: projection.address,
						lanes: projection.lanes,
						elided: projection.elided,
					},
				};
			}

			const outcome = applyAction(params, existing, "agent");
			if (!outcome.ok) return toolFailure(outcome.reason);

			const changed = describeChange(params, outcome.value);
			const snapshot = persist(pi, deps, ctx, previous, outcome.value, changed === undefined ? {} : { changed });
			return {
				content: [{ type: "text", text: renderTaskList(snapshot) }],
				details: { tasks: snapshot.tasks, counts: countTasks(snapshot.tasks), revision: snapshot.revision },
			};
		},
	});

	pi.registerCommand("tasks", {
		description: "Show or edit this session's task list: add, done, block, defer, reopen, clear, export, import, on/off.",
		handler: async (args, ctx) => {
			await handleTasksCommand(pi, deps, ctx, args.trim());
		},
	});
}

type ToolParams = {
	action: "plan" | "add" | "update" | "remove" | "reorder" | "list" | "subtree";
	tasks?: readonly { title: string; note?: string; ref?: string; status?: TaskStatus; subtasks?: readonly { title: string; note?: string; ref?: string; status?: TaskStatus }[] }[];
	title?: string;
	note?: string;
	ref?: string;
	parent?: string;
	after?: string;
	before?: string;
	updates?: readonly TaskUpdate[];
	ids?: readonly string[];
};

function applyAction(params: ToolParams, existing: readonly Task[], actor: TaskActor): MutationResult<Task[]> {
	switch (params.action) {
		case "plan": {
			if (!params.tasks || params.tasks.length === 0) return { ok: false, reason: "plan needs a tasks array" };
			return planTasks(params.tasks, actor === "user" ? "user" : "agent");
		}
		case "add": {
			if (!params.title) return { ok: false, reason: "add needs a title" };
			return addTask(existing, {
				title: params.title,
				...(params.note === undefined ? {} : { note: params.note }),
				...(params.ref === undefined ? {} : { ref: params.ref }),
				...(params.parent === undefined ? {} : { parent: params.parent }),
				...(params.after === undefined ? {} : { after: params.after }),
				...(params.before === undefined ? {} : { before: params.before }),
				origin: actor === "user" ? "user" : "agent",
			});
		}
		case "update": {
			if (!params.updates || params.updates.length === 0) return { ok: false, reason: "update needs an updates array" };
			return applyUpdates(existing, params.updates, actor);
		}
		case "remove": {
			if (!params.ids || params.ids.length === 0) return { ok: false, reason: "remove needs an ids array" };
			return removeTasks(existing, params.ids, actor);
		}
		case "reorder": {
			if (!params.ids || params.ids.length === 0) return { ok: false, reason: "reorder needs the full id sequence" };
			return reorderTasks(existing, params.ids);
		}
		case "subtree":
			return { ok: false, reason: "subtree is a read action" };
		default:
			return { ok: false, reason: `unsupported action ${String(params.action)}` };
	}
}

function describeChange(params: ToolParams, tasks: readonly Task[]): { id: string; status: TaskStatus; title: string } | undefined {
	const id = params.updates?.length === 1 ? params.updates[0]?.id : undefined;
	if (id === undefined) return undefined;
	const found = findTask(tasks, id);
	return found === null ? undefined : { id: found.task.id, status: found.task.status, title: found.task.title };
}

// ---------------------------------------------------------------------------
// The /tasks command
// ---------------------------------------------------------------------------

const USAGE = "Usage: /tasks [add <title>|done <id>|block <id> <reason>|defer <id> <reason>|reopen <id>|clear|export [path]|import <path>|on|off]";

async function handleTasksCommand(pi: ExtensionAPI, deps: TasksRuntimeDeps, ctx: ExtensionContext, text: string): Promise<void> {
	const [verb = "", ...rest] = text.split(/\s+/).filter((part) => part.length > 0);
	const remainder = text.slice(verb.length).trim();
	const previous = currentTasks(deps, ctx);
	const existing = previous?.tasks ?? [];

	if (verb === "" ) {
		ctx.ui.notify(renderTaskList(previous), "info");
		return;
	}
	if (verb === "on" || verb === "off") {
		// Enablement is a settings concern; the command reports where it lives
		// rather than writing a second source of truth.
		ctx.ui.notify(`Set contextAware.tasks.enabled to ${verb === "on"} in your settings, or pass the session policy. Currently ${deps.enabled(ctx) ? "on" : "off"}.`, "info");
		return;
	}
	if (verb === "export") {
		const markdown = renderTasksMarkdown(existing);
		if (existing.length === 0) {
			ctx.ui.notify("No task list to export.", "warning");
			return;
		}
		if (rest.length === 0) {
			ctx.ui.notify(markdown, "info");
			return;
		}
		const { writeFileSync } = await import("node:fs");
		try {
			writeFileSync(remainder, `${markdown}\n`);
			ctx.ui.notify(`Wrote ${existing.length} tasks to ${remainder}`, "info");
		} catch (err) {
			ctx.ui.notify(`Could not write ${remainder}: ${String(err)}`, "warning");
		}
		return;
	}
	if (verb === "import") {
		if (rest.length === 0) {
			ctx.ui.notify("Usage: /tasks import <path>", "warning");
			return;
		}
		const { readFileSync } = await import("node:fs");
		let contents: string;
		try {
			contents = readFileSync(remainder, "utf8");
		} catch (err) {
			ctx.ui.notify(`Could not read ${remainder}: ${String(err)}`, "warning");
			return;
		}
		const parsed = parseTasksMarkdown(contents);
		if (parsed.length === 0) {
			ctx.ui.notify(`No markdown checklist items found in ${remainder}`, "warning");
			return;
		}
		// An import is the user's list, so it carries the user's origin lock.
		const planned = planTasks(parsed, "user");
		if (!planned.ok) {
			ctx.ui.notify(planned.reason, "warning");
			return;
		}
		const snapshot = persist(pi, deps, ctx, previous, planned.value);
		ctx.ui.notify(`Imported ${planned.value.length} tasks from ${remainder}.\n${renderTaskList(snapshot)}`, "info");
		return;
	}
	if (verb === "clear") {
		if (existing.length === 0) {
			ctx.ui.notify("No task list to clear.", "info");
			return;
		}
		const snapshot = persist(pi, deps, ctx, previous, []);
		deps.debugLog(`tasks: cleared at revision ${snapshot.revision}`);
		ctx.ui.notify("Cleared the task list.", "info");
		return;
	}

	const result = userMutation(verb, rest, remainder, existing);
	if (result === null) {
		ctx.ui.notify(USAGE, "warning");
		return;
	}
	if (!result.ok) {
		ctx.ui.notify(result.reason, "warning");
		return;
	}
	const snapshot = persist(pi, deps, ctx, previous, result.value);
	ctx.ui.notify(renderTaskList(snapshot), "info");
}

function userMutation(verb: string, rest: readonly string[], remainder: string, existing: readonly Task[]): MutationResult<Task[]> | null {
	const id = rest[0];
	switch (verb) {
		case "add":
			if (remainder.length === 0) return { ok: false, reason: "Usage: /tasks add <title>" };
			// A task the user typed is the user's, so the agent may transition it
			// but not retitle or delete it.
			return addTask(existing, { title: remainder, origin: "user" as TaskOrigin });
		case "done":
			if (!id) return { ok: false, reason: "Usage: /tasks done <id>" };
			return applyUpdates(existing, [{ id, status: "done" }], "user");
		case "reopen":
			if (!id) return { ok: false, reason: "Usage: /tasks reopen <id>" };
			return applyUpdates(existing, [{ id, status: "pending", note: "" }], "user");
		case "block":
		case "defer": {
			if (!id) return { ok: false, reason: `Usage: /tasks ${verb} <id> <reason>` };
			const reason = remainder.slice(id.length).trim();
			if (reason.length === 0) return { ok: false, reason: `${verb} needs a reason: /tasks ${verb} ${id} <reason>` };
			return applyUpdates(existing, [{ id, status: verb === "block" ? "blocked" : "deferred", note: reason }], "user");
		}
		default:
			return null;
	}
}
