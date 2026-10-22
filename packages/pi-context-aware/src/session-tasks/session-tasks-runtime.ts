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
import { prepareSessionTasksArguments, SESSION_TASKS_ACTIONS, stringEnum } from "../tool-arguments.js";

import {
	MAX_TASK_NOTE_CHARS,
	MAX_TASK_TITLE_CHARS,
	MAX_TASK_ID_CHARS,
	TASK_STATUSES,
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
	ANSWER_ENTRY_TYPE,
	ASK_CLOSED_ENTRY_TYPE,
	ASK_ANSWER_DELIVERY,
	ASK_ENTRY_TYPE,
	ASK_RAISED_ENTRY_TYPE,
	MAX_ASK_ANSWER_CHARS,
	MAX_ASK_OPTION_LABEL_CHARS,
	MAX_ASK_OPTIONS,
	MAX_ASK_QUESTION_CHARS,
	askAnswerMessage,
	createAskTransport,
	newAskEntry,
	noteText,
	openAskForTask,
	openAskQuestions,
	openAsks,
	prepareAnswer,
	prepareAsk,
	replayAsks,
	resolveAnswerText,
	type AnswerEntry,
	type AnswerRoute,
	type AskClosedEntry,
	type AskCloseReason,
	type AskEntry,
	type AskState,
	type PreparedAsk,
} from "./session-asks.js";
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
	const goal = task.goal === undefined ? "" : ` [goal=${task.goal}]`;
	return `${indent}${STATUS_GLYPH[task.status]} ${task.id}  ${task.title}${origin}${ref}${goal}${note}`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

// Rules that name valid values (actions, statuses) live in the errors of
// prepareSessionTasksArguments, and rules about notes, origins, and nesting in
// the tool's own refusals, not in these descriptions: every request carries
// this schema.
const taskRefSchema = Type.String({
	maxLength: MAX_TASK_ID_CHARS,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

/** update: a goal id, or "" to clear the link. */
const taskGoalUpdateSchema = Type.String({
	maxLength: MAX_TASK_ID_CHARS,
	pattern: "^([A-Za-z0-9][A-Za-z0-9._-]*)?$",
});

const taskIdSchema = Type.String({ maxLength: MAX_TASK_ID_CHARS });
const taskStatusSchema = stringEnum(TASK_STATUSES);

const seedTaskFields = {
	title: Type.String({ maxLength: MAX_TASK_TITLE_CHARS }),
	note: Type.Optional(Type.String({ maxLength: MAX_TASK_NOTE_CHARS })),
	ref: Type.Optional(taskRefSchema),
	status: Type.Optional(taskStatusSchema),
};
const seedTaskSchema = Type.Object(seedTaskFields);

const tasksSchema = Type.Object({
	action: stringEnum(SESSION_TASKS_ACTIONS, { description: "plan replaces the whole list; update batches status changes." }),
	tasks: Type.Optional(Type.Array(Type.Object({
		...seedTaskFields,
		goal: Type.Optional(taskRefSchema),
		subtasks: Type.Optional(Type.Array(seedTaskSchema, { maxItems: 50 })),
	}), { description: "plan: the whole list, in order.", maxItems: 100 })),
	title: Type.Optional(Type.String({ description: "add: the new task.", maxLength: MAX_TASK_TITLE_CHARS })),
	note: Type.Optional(Type.String({ maxLength: MAX_TASK_NOTE_CHARS })),
	ref: Type.Optional(taskRefSchema),
	goal: Type.Optional(taskRefSchema),
	parent: Type.Optional(taskIdSchema),
	after: Type.Optional(taskIdSchema),
	before: Type.Optional(taskIdSchema),
	updates: Type.Optional(Type.Array(Type.Object({
		id: taskIdSchema,
		status: Type.Optional(taskStatusSchema),
		title: Type.Optional(Type.String({ maxLength: MAX_TASK_TITLE_CHARS })),
		ref: Type.Optional(taskRefSchema),
		goal: Type.Optional(taskGoalUpdateSchema),
		note: Type.Optional(Type.String({ maxLength: MAX_TASK_NOTE_CHARS })),
		ask: Type.Optional(Type.Object({
			question: Type.String({ maxLength: MAX_ASK_QUESTION_CHARS }),
			options: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ maxLength: MAX_TASK_ID_CHARS }),
				label: Type.String({ maxLength: MAX_ASK_OPTION_LABEL_CHARS }),
			}), { maxItems: MAX_ASK_OPTIONS })),
		})),
		answer: Type.Optional(Type.String({ maxLength: MAX_ASK_ANSWER_CHARS })),
	}), { description: "update: one entry per task, all in one call.", maxItems: 100 })),
	ids: Type.Optional(Type.Array(taskIdSchema, { description: "remove: tasks to drop; reorder: every id in order.", maxItems: 100 })),
});

const TOOL_DESCRIPTION = "Session checklist that survives compaction. subtree reads current delegation state, not complete history. When delegate support is available, a dispatch can seed a worker's list with `handoff: { tasks: [...] }`.";

const TOOL_PROMPT_SNIPPET = [
	"Use session_tasks when a request contains several distinct pieces of work that will outlive one reply, not for a two-file edit.",
	"Lay the whole list out in one plan call, then batch transitions through update — one call can flip several tasks.",
	"Keep one task active where you can. Mark blocked or deferred only with a written reason; both need one.",
	"A parent's status follows its sub-tasks and cannot be set directly.",
	"When only the user can unblock a task, block it with ask: {question}; their answer reopens it. Record a reply they give in chat with answer.",
].join(" ");

function toolFailure(reason: string) {
	return { content: [{ type: "text" as const, text: reason }], details: { error: reason }, isError: true };
}

/** The ask lifecycle hooks the extension's session handlers drive. */
export interface SessionAsksHandle {
	/**
	 * Abort every in-flight Fabric request, then raise each open ask on the
	 * current branch as a new decision (session_start and session_tree).
	 */
	replay(ctx: ExtensionContext): Promise<void>;
	/** Abort every in-flight Fabric request (session_shutdown). */
	shutdown(): void;
	/** Task id to question for each open ask, for the per-turn envelope. */
	openQuestions(ctx: ExtensionContext): ReadonlyMap<string, string>;
}

export function registerSessionTasks(pi: ExtensionAPI, deps: TasksRuntimeDeps): SessionAsksHandle {
	const asks = createAsksRuntime(pi, deps);
	pi.registerTool({
		name: "session_tasks",
		label: "Session Tasks",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		parameters: tasksSchema,
		prepareArguments: prepareSessionTasksArguments,
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

			let askWork: AskUpdateWork | undefined;
			let effective: ToolParams = params;
			if (params.action === "update" && params.updates !== undefined && params.updates.some(hasAskFields)) {
				const prepared = prepareAskUpdates(deps.entries(ctx), existing, params.updates);
				if (!prepared.ok) return toolFailure(prepared.reason);
				askWork = prepared.value;
				effective = { ...params, updates: prepared.value.updates };
			}

			const outcome = applyAction(effective, existing, "agent");
			if (!outcome.ok) return toolFailure(outcome.reason);

			const now = new Date();
			// A plan recreates every task id and remove drops tasks: their asks are
			// closed before the snapshot, so no branch point shows them open on a
			// new task that reuses the id.
			asks.closeDropped(ctx, existing, outcome.value, params.action === "plan", now);
			// Entries before the snapshot: the answer is recorded before the task moves.
			for (const { state, answer } of askWork?.answers ?? []) appendAnswerEntry(pi, state.ask, answer, "agent", now);
			const raised: AskEntry[] = [];
			for (const { taskId, goal, ask } of askWork?.asks ?? []) {
				const entry = newAskEntry(taskId, goal, ask, now);
				pi.appendEntry(ASK_ENTRY_TYPE, entry);
				raised.push(entry);
			}

			const changed = describeChange(effective, outcome.value);
			const snapshot = persist(pi, deps, ctx, previous, outcome.value, changed === undefined ? {} : { changed });
			// The chat answer replaces the Fabric decision, so withdraw it; the agent
			// is already in a turn, so nothing is sent to wake it.
			for (const { state } of askWork?.answers ?? []) asks.abort(state.ask.askId);
			for (const superseded of askWork?.superseded ?? []) asks.abort(superseded);
			for (const entry of raised) void asks.raise(ctx, entry);
			const askLines = [
				...raised.map((entry) => `Asked the user on ${entry.taskId}: ${entry.question}`),
				...(askWork?.answers ?? []).map(({ state }) => `Recorded the user's answer on ${state.ask.taskId}.`),
			];
			return {
				content: [{ type: "text", text: [renderTaskList(snapshot), ...askLines].join("\n") }],
				details: {
					tasks: snapshot.tasks,
					counts: countTasks(snapshot.tasks),
					revision: snapshot.revision,
					...(raised.length === 0 ? {} : { asks: raised.map((entry) => ({ askId: entry.askId, taskId: entry.taskId })) }),
					...(askWork === undefined || askWork.answers.length === 0 ? {} : { answered: askWork.answers.map(({ state }) => state.ask.askId) }),
				},
			};
		},
	});

	pi.registerCommand("tasks", {
		description: "Show or edit this session's task list: add, done, block, defer, reopen, clear, export, import, on/off.",
		handler: async (args, ctx) => {
			await handleTasksCommand(pi, deps, asks, ctx, args.trim());
		},
	});

	pi.registerCommand("answer", {
		description: "Answer a blocked task's question: /answer <taskId> <text>. An option id or label picks that option.",
		handler: async (args, ctx) => {
			handleAnswerCommand(deps, asks, ctx, args.trim());
		},
	});

	return {
		replay: (ctx) => asks.replay(ctx),
		shutdown: () => asks.shutdown(),
		openQuestions: (ctx) => asks.openQuestions(ctx),
	};
}

// ---------------------------------------------------------------------------
// Asks: a blocked task's question for the user
// ---------------------------------------------------------------------------

type ToolUpdate = TaskUpdate & { readonly ask?: unknown; readonly answer?: unknown };

function hasAskFields(update: ToolUpdate): boolean {
	return update.ask !== undefined || update.answer !== undefined;
}

interface AskUpdateWork {
	/** The updates with ask and answer turned into status and note changes. */
	readonly updates: readonly TaskUpdate[];
	readonly asks: readonly { readonly taskId: string; readonly goal?: string; readonly ask: PreparedAsk }[];
	readonly answers: readonly { readonly state: AskState; readonly answer: string }[];
	/** Open asks replaced by a new ask on the same task. */
	readonly superseded: readonly string[];
}

/** Copy only the task-update fields; ask and answer never reach the task list. */
function taskUpdateFields(update: ToolUpdate): TaskUpdate {
	return {
		id: update.id,
		...(update.status === undefined ? {} : { status: update.status }),
		...(update.title === undefined ? {} : { title: update.title }),
		...(update.note === undefined ? {} : { note: update.note }),
		...(update.ref === undefined ? {} : { ref: update.ref }),
		...(update.goal === undefined ? {} : { goal: update.goal }),
	};
}

/**
 * Turn ask and answer fields into ordinary task updates plus the entries to
 * record. Validation is all-or-nothing, like the rest of an update batch.
 */
function prepareAskUpdates(entries: readonly unknown[], tasks: readonly Task[], updates: readonly ToolUpdate[]): MutationResult<AskUpdateWork> {
	const fail = (reason: string): MutationResult<AskUpdateWork> => ({ ok: false, reason });
	const next: TaskUpdate[] = [];
	const asked: { taskId: string; goal?: string; ask: PreparedAsk }[] = [];
	const answers: { state: AskState; answer: string }[] = [];
	const superseded: string[] = [];
	const touched = new Set<string>();
	// An id named twice, once with ask or answer, would let the other update
	// undo the ask's or answer's transition, so the whole batch is refused.
	const counts = new Map<string, number>();
	for (const update of updates) counts.set(update.id, (counts.get(update.id) ?? 0) + 1);
	for (const update of updates) {
		if (hasAskFields(update) && (counts.get(update.id) ?? 0) > 1) return fail(`${update.id} appears more than once in a batch with ask or answer; send one update for it`);
	}
	for (const update of updates) {
		const base = taskUpdateFields(update);
		if (!hasAskFields(update)) {
			next.push(base);
			continue;
		}
		if (touched.has(update.id)) return fail(`${update.id} appears twice with ask or answer; send one`);
		touched.add(update.id);
		if (update.ask !== undefined && update.answer !== undefined) return fail(`${update.id}: send either ask or answer, not both`);
		const found = findTask(tasks, update.id);
		if (found === null) return fail(`no task ${update.id}`);
		if (update.ask !== undefined) {
			if (base.status !== "blocked") return fail(`ask on ${update.id} needs status: "blocked"`);
			const prepared = prepareAsk(update.ask);
			if (!prepared.ok) return fail(`${update.id}: ${prepared.reason}`);
			const note = base.note !== undefined && base.note.trim().length > 0 ? base.note : noteText(prepared.value.question, MAX_TASK_NOTE_CHARS);
			next.push({ ...base, note });
			const goal = base.goal === undefined ? found.task.goal : base.goal.length === 0 ? undefined : base.goal;
			asked.push({ taskId: found.task.id, ...(goal === undefined ? {} : { goal }), ask: prepared.value });
			const previous = openAskForTask(entries, tasks, found.task.id);
			if (previous !== undefined) superseded.push(previous.ask.askId);
			continue;
		}
		if (base.status !== undefined && base.status !== "pending") return fail(`answer on ${update.id} reopens the task as pending; leave status out`);
		const state = openAskForTask(entries, tasks, found.task.id);
		if (state === undefined) return fail(`${update.id} has no open question to answer`);
		const prepared = prepareAnswer(update.answer);
		if (!prepared.ok) return fail(`${update.id}: ${prepared.reason}`);
		next.push({
			...base,
			...(found.task.status === "blocked" ? { status: "pending" as const } : {}),
			note: noteText(prepared.value, MAX_TASK_NOTE_CHARS),
		});
		answers.push({ state, answer: prepared.value });
	}
	return { ok: true, value: { updates: next, asks: asked, answers, superseded } };
}

function appendAnswerEntry(pi: ExtensionAPI, ask: AskEntry, answer: string, route: AnswerRoute, now: Date): void {
	const entry: AnswerEntry = { askId: ask.askId, answer, route, answeredAt: now.toISOString() };
	pi.appendEntry(ANSWER_ENTRY_TYPE, entry);
}

function sessionNameOf(pi: ExtensionAPI): string | undefined {
	try {
		const name = (pi as unknown as { getSessionName?: () => string | undefined }).getSessionName?.();
		return typeof name === "string" && name.trim().length > 0 ? name : undefined;
	} catch {
		return undefined;
	}
}

interface AsksRuntime {
	raise(ctx: ExtensionContext, ask: AskEntry): Promise<void>;
	abort(askId: string): void;
	/**
	 * Close the open asks whose task the change drops, or every open ask when
	 * the change recreates the task ids (a plan or an import), and abort their
	 * Fabric requests.
	 */
	closeDropped(ctx: ExtensionContext, previous: readonly Task[], next: readonly Task[], replaced: boolean, now: Date): void;
	/** The first answer wins; later answers change nothing. */
	answer(ctx: ExtensionContext, askId: string, text: string, route: Exclude<AnswerRoute, "agent">): MutationResult<{ ask: AskEntry; answer: string }>;
	replay(ctx: ExtensionContext): Promise<void>;
	shutdown(): void;
	openQuestions(ctx: ExtensionContext): ReadonlyMap<string, string>;
}

function createAsksRuntime(pi: ExtensionAPI, deps: TasksRuntimeDeps): AsksRuntime {
	const transport = createAskTransport(
		() => (pi as unknown as { events?: { emit?: (channel: string, data: unknown) => void } }).events,
		deps.debugLog,
	);
	const isOpen = (ctx: ExtensionContext, askId: string): boolean => {
		const tasks = currentTasks(deps, ctx)?.tasks ?? [];
		return openAsks(deps.entries(ctx), tasks).some((state) => state.ask.askId === askId);
	};

	const runtime: AsksRuntime = {
		async raise(ctx, ask) {
			try {
				const outcome = await transport.raise(ctx, ask, sessionNameOf(pi), {
					stillOpen: () => isOpen(ctx, ask.askId),
					onRaised: (decisionId) => pi.appendEntry(ASK_RAISED_ENTRY_TYPE, { askId: ask.askId, decisionId }),
					onAnswer: (text) => {
						const result = runtime.answer(ctx, ask.askId, text, "fabric");
						if (!result.ok) deps.debugLog(`asks: Fabric answer for ${ask.askId} ignored: ${result.reason}`);
					},
				});
				deps.debugLog(`asks: ${ask.askId} on ${ask.taskId}: ${outcome}`);
			} catch (err) {
				deps.debugLog(`asks: raising ${ask.askId} failed: ${String(err)}`);
			}
		},
		abort(askId) {
			transport.abort(askId);
		},
		closeDropped(ctx, previous, next, replaced, now) {
			let open: AskState[];
			try {
				open = openAsks(deps.entries(ctx), previous);
			} catch (err) {
				deps.debugLog(`asks: could not read open asks: ${String(err)}`);
				return;
			}
			for (const state of open) {
				const dropped = findTask(next, state.ask.taskId) === null;
				if (!replaced && !dropped) continue;
				const reason: AskCloseReason = replaced ? "task-replaced" : "task-removed";
				const entry: AskClosedEntry = { askId: state.ask.askId, reason, closedAt: now.toISOString() };
				pi.appendEntry(ASK_CLOSED_ENTRY_TYPE, entry);
				transport.abort(state.ask.askId);
			}
		},
		answer(ctx, askId, text, route) {
			if (!deps.enabled(ctx)) return { ok: false, reason: "The session task list is disabled for this session." };
			const entries = deps.entries(ctx);
			const state = replayAsks(entries).find((candidate) => candidate.ask.askId === askId);
			if (state === undefined) return { ok: false, reason: `no question ${askId}` };
			if (state.answer !== undefined) return { ok: false, reason: `the question on ${state.ask.taskId} was already answered` };
			if (state.closed !== undefined) return { ok: false, reason: `the question on ${state.ask.taskId} was closed when its task was ${state.closed.reason === "task-replaced" ? "replaced" : "removed"}` };
			const previous = currentTasks(deps, ctx);
			const found = previous === null ? null : findTask(previous.tasks, state.ask.taskId);
			if (previous === null || found === null) return { ok: false, reason: `task ${state.ask.taskId} no longer exists` };
			// Only the task's current open ask may be answered: not one replaced by a later ask.
			if (!openAsks(entries, previous.tasks).some((candidate) => candidate.ask.askId === askId)) {
				return { ok: false, reason: `the question ${askId} is no longer open on ${state.ask.taskId}` };
			}
			// Every route has the same limit: an over-long answer is refused, never cut.
			const prepared = prepareAnswer(text);
			if (!prepared.ok) return { ok: false, reason: prepared.reason };
			const answer = prepared.value;
			appendAnswerEntry(pi, state.ask, answer, route, new Date());
			const update: TaskUpdate = {
				id: found.task.id,
				...(found.task.status === "blocked" ? { status: "pending" as const } : {}),
				note: noteText(answer, MAX_TASK_NOTE_CHARS),
			};
			const moved = applyUpdates(previous.tasks, [update], "user");
			if (moved.ok) {
				const task = findTask(moved.value, found.task.id)?.task;
				persist(pi, deps, ctx, previous, moved.value, task === undefined ? {} : { changed: { id: task.id, status: task.status, title: task.title } });
			} else {
				deps.debugLog(`asks: answer recorded but ${found.task.id} not reopened: ${moved.reason}`);
			}
			// /answer replaces the Fabric decision; a Fabric answer has already settled it.
			transport.abort(askId);
			try {
				pi.sendMessage(askAnswerMessage(state.ask, answer, route), ASK_ANSWER_DELIVERY);
			} catch (err) {
				deps.debugLog(`asks: answer message not sent: ${String(err)}`);
			}
			return { ok: true, value: { ask: state.ask, answer } };
		},
		async replay(ctx) {
			transport.abortAll();
			if (!deps.enabled(ctx)) return;
			let open: AskState[];
			try {
				open = openAsks(deps.entries(ctx), currentTasks(deps, ctx)?.tasks ?? []);
			} catch (err) {
				deps.debugLog(`asks: replay failed: ${String(err)}`);
				return;
			}
			// Fabric cancels a session's decisions at shutdown, so each open ask is raised as a new one.
			await Promise.all(open.map((state) => runtime.raise(ctx, state.ask)));
		},
		shutdown() {
			transport.abortAll();
		},
		openQuestions(ctx) {
			if (!deps.enabled(ctx)) return new Map();
			try {
				return openAskQuestions(openAsks(deps.entries(ctx), currentTasks(deps, ctx)?.tasks ?? []));
			} catch {
				return new Map();
			}
		},
	};
	return runtime;
}

const ANSWER_USAGE = "Usage: /answer <taskId> <text>";

function handleAnswerCommand(deps: TasksRuntimeDeps, asks: AsksRuntime, ctx: ExtensionContext, text: string): void {
	const tasks = currentTasks(deps, ctx)?.tasks ?? [];
	const open = deps.enabled(ctx) ? openAsks(deps.entries(ctx), tasks) : [];
	const [taskId = ""] = text.split(/\s+/).filter((part) => part.length > 0);
	if (taskId.length === 0) {
		const lines = open.map((state) => `${state.ask.taskId}: ${state.ask.question}${state.ask.options === undefined ? "" : ` [${state.ask.options.map((option) => `${option.id}=${option.label}`).join(", ")}]`}`);
		ctx.ui.notify(lines.length === 0 ? `No open questions. ${ANSWER_USAGE}` : [`Open questions (${ANSWER_USAGE}):`, ...lines].join("\n"), "info");
		return;
	}
	const reply = text.slice(text.indexOf(taskId) + taskId.length).trim();
	if (reply.length === 0) {
		ctx.ui.notify(ANSWER_USAGE, "warning");
		return;
	}
	const state = open.find((candidate) => candidate.ask.taskId === taskId);
	if (state === undefined) {
		ctx.ui.notify(`Task ${taskId} has no open question.`, "warning");
		return;
	}
	const result = asks.answer(ctx, state.ask.askId, resolveAnswerText(state.ask, reply), "command");
	if (!result.ok) {
		ctx.ui.notify(result.reason, "warning");
		return;
	}
	ctx.ui.notify(`Answered ${taskId}; the agent will continue.\n${renderTaskList(currentTasks(deps, ctx))}`, "info");
}

type ToolParams = {
	action: "plan" | "add" | "update" | "remove" | "reorder" | "list" | "subtree";
	tasks?: readonly { title: string; note?: string; ref?: string; goal?: string; status?: TaskStatus; subtasks?: readonly { title: string; note?: string; ref?: string; status?: TaskStatus }[] }[];
	title?: string;
	note?: string;
	ref?: string;
	goal?: string;
	parent?: string;
	after?: string;
	before?: string;
	updates?: readonly ToolUpdate[];
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
				...(params.goal === undefined ? {} : { goal: params.goal }),
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

async function handleTasksCommand(pi: ExtensionAPI, deps: TasksRuntimeDeps, asks: AsksRuntime, ctx: ExtensionContext, text: string): Promise<void> {
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
		asks.closeDropped(ctx, existing, planned.value, true, new Date());
		const snapshot = persist(pi, deps, ctx, previous, planned.value);
		ctx.ui.notify(`Imported ${planned.value.length} tasks from ${remainder}.\n${renderTaskList(snapshot)}`, "info");
		return;
	}
	if (verb === "clear") {
		if (existing.length === 0) {
			ctx.ui.notify("No task list to clear.", "info");
			return;
		}
		asks.closeDropped(ctx, existing, [], false, new Date());
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
	asks.closeDropped(ctx, existing, result.value, false, new Date());
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
