/** Transcript-backed session task list: a checklist that survives compaction.
 *
 * The durability mechanism is deliberately the same one `session_focus` uses —
 * a full validated snapshot per mutation, carried by a Pi custom entry, with
 * replay as the only way state is loaded. Nothing here reads or writes a file,
 * and there is no second store to reconcile against.
 *
 * The one structural rule worth stating up front: sub-task depth is bounded
 * at write time, and a parent's status is derived from its children rather than
 * set. The parser accepts the hard ceiling so transcript replay never depends
 * on the session's current delegation lineage.
 */

import { randomUUID } from "node:crypto";

export const TASKS_SCHEMA_VERSION = 1 as const;
export const TASKS_ENTRY_TYPE = "context-aware.tasks.v1" as const;

/** Bounds. A checklist that can grow without limit stops being readable. */
export const MAX_TASKS = 100;
export const MAX_SUBTASKS = 50;
export const MAX_TASK_TITLE_CHARS = 200;
export const MAX_TASK_NOTE_CHARS = 240;
export const MAX_TASK_ID_CHARS = 32;
/** The ordinary session may add one level of sub-tasks. Delegation adds one. */
export const DEFAULT_MAX_TASK_DEPTH = 1;
/** Parser ceiling shared by every peer; write budgets may be lower. */
export const HARD_MAX_TASK_DEPTH = 16;

/**
 * `blocked` and `deferred` read alike but answer "is this finished?"
 * differently: everything done or deferred means finished, anything blocked
 * means stuck and something must escalate. Collapsing them would make that
 * question unanswerable mechanically, which is most of the point.
 */
export type TaskStatus = "pending" | "active" | "done" | "blocked" | "deferred";

/** Who put the task on the list. Decides what the agent may do to it. */
export type TaskOrigin = "user" | "spec" | "agent";

/** Who is performing a mutation. `user` is not bound by the origin locks. */
export type TaskActor = "user" | "agent";

export interface TaskDelegation {
	/** The pi session currently responsible for this task. */
	readonly sessionId: string;
}

export interface TaskLastAttempt {
	/** The worker run retained after a delegation is cleared. */
	readonly runId: string;
	/** The worker's terminal end state, kept as a bounded opaque string. */
	readonly endState: string;
}

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly status: TaskStatus;
	/** An optional bounded opaque reference supplied by the task's caller. */
	readonly ref?: string;
	readonly note?: string;
	readonly origin: TaskOrigin;
	readonly delegation?: TaskDelegation;
	readonly lastAttempt?: TaskLastAttempt;
	readonly subtasks?: readonly Task[];
}

export interface TasksSnapshot {
	readonly schemaVersion: typeof TASKS_SCHEMA_VERSION;
	readonly eventId: string;
	readonly revision: number;
	readonly piSessionId: string;
	readonly tasks: readonly Task[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "active", "done", "blocked", "deferred"];
export const TASK_ORIGINS: readonly TaskOrigin[] = ["user", "spec", "agent"];

/** A status that must carry a written reason when an actor sets it. */
export function statusRequiresNote(status: TaskStatus): boolean {
	return status === "blocked" || status === "deferred";
}

/** A task nobody needs to do again. Used for "is the list finished?". */
export function isSettled(status: TaskStatus): boolean {
	return status === "done" || status === "deferred";
}

// ---------------------------------------------------------------------------
// Derived parent status
// ---------------------------------------------------------------------------

/**
 * A parent's status is computed from its children and can never be set.
 *
 * This removes the "parent says done, three children still pending" class of
 * lie, which is the failure the whole feature exists to prevent.
 */
function effectiveStatus(task: Task): TaskStatus {
	const children = task.subtasks ?? [];
	return children.length === 0 ? task.status : deriveStatus(children, task.status);
}

export function deriveStatus(children: readonly Task[], own: TaskStatus): TaskStatus {
	if (children.length === 0) return own;
	const statuses = children.map(effectiveStatus);
	if (statuses.some((status) => status === "blocked")) return "blocked";
	if (statuses.some((status) => status === "active")) return "active";
	if (statuses.every(isSettled)) return "done";
	return "pending";
}

/** Apply the derivation rule to a task, leaving leaves untouched. */
function withDerivedStatus(task: Task): Task {
	const children = task.subtasks ?? [];
	if (children.length === 0) {
		const { subtasks: _dropped, ...leaf } = task;
		return leaf;
	}
	const derivedChildren = children.map(withDerivedStatus);
	return { ...task, status: deriveStatus(derivedChildren, task.status), subtasks: derivedChildren };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isoTimestamp(value: unknown): value is string {
	return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

/** A task id must be short and typeable, because a model has to retype it. */
export function isValidTaskRef(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_TASK_ID_CHARS
		&& /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isTaskId(value: unknown): value is string {
	return isValidTaskRef(value);
}

function parseTask(value: unknown): Task | null {
	if (!isRecord(value)) return null;
	if (!isTaskId(value.id) || !boundedString(value.title, MAX_TASK_TITLE_CHARS)) return null;
	if (!TASK_STATUSES.includes(value.status as TaskStatus)) return null;
	if (!TASK_ORIGINS.includes(value.origin as TaskOrigin)) return null;
	if (value.ref !== undefined && !isValidTaskRef(value.ref)) return null;
	if (value.note !== undefined && !boundedString(value.note, MAX_TASK_NOTE_CHARS)) return null;
	if (/[\r\n]/.test(value.title)) return null;

	const delegation = parseDelegation(value.delegation);
	if (value.delegation !== undefined && delegation === null) return null;
	const lastAttempt = parseLastAttempt(value.lastAttempt);
	if (value.lastAttempt !== undefined && lastAttempt === null) return null;
	let subtasks: Task[] | undefined;
	if (value.subtasks !== undefined) {
		if (!Array.isArray(value.subtasks) || value.subtasks.length > MAX_SUBTASKS) return null;
		subtasks = [];
		for (const child of value.subtasks) {
			const parsed = parseTask(child);
			if (!parsed) return null;
			subtasks.push(parsed);
		}
	}

	const task: Task = {
		id: value.id,
		title: value.title,
		status: value.status as TaskStatus,
		...(value.ref === undefined ? {} : { ref: value.ref }),
		...(value.note === undefined ? {} : { note: value.note }),
		origin: value.origin as TaskOrigin,
		...(delegation === null ? {} : { delegation }),
		...(lastAttempt === null ? {} : { lastAttempt }),
		...(subtasks === undefined || subtasks.length === 0 ? {} : { subtasks }),
	};
	return withDerivedStatus(task);
}

function parseDelegation(value: unknown): TaskDelegation | null {
	if (!isRecord(value) || !boundedString(value.sessionId, 256)) return null;
	return { sessionId: value.sessionId };
}

function parseLastAttempt(value: unknown): TaskLastAttempt | null {
	if (!isRecord(value) || !boundedString(value.runId, 256) || !boundedString(value.endState, 64)) return null;
	return { runId: value.runId, endState: value.endState };
}

function hasUniqueIds(tasks: readonly Task[]): boolean {
	const seen = new Set<string>();
	const pending = [...tasks];
	while (pending.length > 0) {
		const task = pending.pop();
		if (task === undefined) continue;
		if (seen.has(task.id)) return false;
		seen.add(task.id);
		pending.push(...(task.subtasks ?? []));
	}
	return true;
}

function withinHardDepth(tasks: readonly Task[]): boolean {
	const pending = tasks.map((task) => ({ task, depth: 0 }));
	while (pending.length > 0) {
		const entry = pending.pop();
		if (entry === undefined) continue;
		if (entry.depth > HARD_MAX_TASK_DEPTH) return false;
		for (const child of entry.task.subtasks ?? []) pending.push({ task: child, depth: entry.depth + 1 });
	}
	return true;
}

export function parseTasks(value: unknown): Task[] | null {
	if (!Array.isArray(value) || value.length > MAX_TASKS) return null;
	const tasks: Task[] = [];
	for (const candidate of value) {
		const parsed = parseTask(candidate);
		if (!parsed) return null;
		tasks.push(parsed);
	}
	return hasUniqueIds(tasks) && withinHardDepth(tasks) ? tasks : null;
}

/** Parse a complete snapshot. Anything unsupported returns null, never a partial. */
export function parseTasksSnapshot(value: unknown): TasksSnapshot | null {
	if (!isRecord(value) || value.schemaVersion !== TASKS_SCHEMA_VERSION) return null;
	if (!boundedString(value.eventId, 256) || !boundedString(value.piSessionId, 256)) return null;
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision <= 0) return null;
	if (!isoTimestamp(value.createdAt) || !isoTimestamp(value.updatedAt)) return null;
	if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return null;
	const tasks = parseTasks(value.tasks);
	if (!tasks) return null;
	return {
		schemaVersion: TASKS_SCHEMA_VERSION,
		eventId: value.eventId,
		revision: value.revision,
		piSessionId: value.piSessionId,
		tasks,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export function isTasksSnapshot(value: unknown): value is TasksSnapshot {
	return parseTasksSnapshot(value) !== null;
}

// ---------------------------------------------------------------------------
// Counts and completion
// ---------------------------------------------------------------------------

export interface TaskCounts {
	readonly total: number;
	readonly done: number;
	readonly active: number;
	readonly blocked: number;
	readonly deferred: number;
	readonly pending: number;
}

/** Count top-level tasks only. Sub-tasks are steps, not items of work. */
export function countTasks(tasks: readonly Task[]): TaskCounts {
	const counts = { total: tasks.length, done: 0, active: 0, blocked: 0, deferred: 0, pending: 0 };
	for (const task of tasks) {
		if (task.status === "done") counts.done += 1;
		else if (task.status === "active") counts.active += 1;
		else if (task.status === "blocked") counts.blocked += 1;
		else if (task.status === "deferred") counts.deferred += 1;
		else counts.pending += 1;
	}
	return counts;
}

/** Everything done or deferred. The mechanical answer to "is this agent done?". */
export function isListFinished(tasks: readonly Task[]): boolean {
	return tasks.length > 0 && tasks.every((task) => isSettled(task.status));
}

/** Anything blocked. The mechanical answer to "is this agent stuck?". */
export function isListStuck(tasks: readonly Task[]): boolean {
	return tasks.some((task) => task.status === "blocked");
}

/**
 * Active leaves own execution; pending rows are only a checklist.
 *
 * A pending row records that something is planned, never that the agent was
 * told to start it. Treating the two alike is what let a settle-time reminder
 * restart a session the user had explicitly stopped, so only leaves carrying
 * `active` count. Recursing past a parent keeps an active child visible
 * beneath a blocked or pending parent.
 */
export function activeTasks(tasks: readonly Task[]): readonly Task[] {
	return tasks.flatMap((task) => task.subtasks?.length
		? activeTasks(task.subtasks)
		: task.status === "active" ? [task] : []);
}

export function findTask(tasks: readonly Task[], id: string): { task: Task; parent: Task | null } | null {
	const visit = (candidates: readonly Task[], parent: Task | null): { task: Task; parent: Task | null } | null => {
		for (const task of candidates) {
			if (task.id === id) return { task, parent };
			const nested = visit(task.subtasks ?? [], task);
			if (nested !== null) return nested;
		}
		return null;
	};
	return visit(tasks, null);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function generatedId(factory: (() => string) | undefined): string {
	const value = (factory ?? randomUUID)();
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
		throw new Error("eventId must be a bounded non-empty string");
	}
	return value;
}

function timestamp(value: string | Date | undefined): string {
	if (value === undefined) return new Date().toISOString();
	const result = value instanceof Date ? value.toISOString() : value;
	if (!Number.isFinite(Date.parse(result))) throw new Error("snapshot timestamp must be an ISO date");
	return result;
}

/** Allocate the next free top-level id in the `t<n>` series. */
export function nextTaskId(tasks: readonly Task[]): string {
	const used = new Set(tasks.map((task) => task.id));
	for (let n = 1; n <= MAX_TASKS + 1; n += 1) {
		const candidate = `t${n}`;
		if (!used.has(candidate)) return candidate;
	}
	throw new Error("no free task id");
}

/** Allocate the next free sub-task id, which reads as "step 2 of t3". */
export function nextSubtaskId(parent: Task): string {
	const used = new Set((parent.subtasks ?? []).map((child) => child.id));
	for (let n = 1; n <= MAX_SUBTASKS + 1; n += 1) {
		const candidate = `${parent.id}.${n}`;
		if (!used.has(candidate)) return candidate;
	}
	throw new Error("no free sub-task id");
}

export interface CreateTasksSnapshotOptions {
	readonly piSessionId: string;
	readonly tasks?: readonly Task[];
	readonly revision?: number;
	readonly eventId?: string;
	readonly createdAt?: string | Date;
	readonly now?: string | Date;
	readonly idFactory?: () => string;
}

export function createTasksSnapshot(options: CreateTasksSnapshotOptions): TasksSnapshot {
	const now = timestamp(options.now);
	const snapshot: TasksSnapshot = {
		schemaVersion: TASKS_SCHEMA_VERSION,
		eventId: options.eventId ?? generatedId(options.idFactory),
		revision: options.revision ?? 1,
		piSessionId: options.piSessionId,
		tasks: [...(options.tasks ?? [])],
		createdAt: timestamp(options.createdAt ?? now),
		updatedAt: now,
	};
	const parsed = parseTasksSnapshot(snapshot);
	if (!parsed) throw new Error("snapshot does not satisfy the task schema");
	return parsed;
}

/** Produce the next revision of a list, preserving identity and creation time. */
export function nextSnapshot(
	previous: TasksSnapshot,
	tasks: readonly Task[],
	options: { readonly now?: string | Date; readonly eventId?: string; readonly idFactory?: () => string } = {},
): TasksSnapshot {
	return createTasksSnapshot({
		piSessionId: previous.piSessionId,
		tasks,
		revision: previous.revision + 1,
		...(options.eventId === undefined ? {} : { eventId: options.eventId }),
		...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
		createdAt: previous.createdAt,
		...(options.now === undefined ? {} : { now: options.now }),
	});
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type MutationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function fail<T>(reason: string): MutationResult<T> {
	return { ok: false, reason };
}

/**
 * Origin decides what the agent may change.
 *
 * This mirrors the pinned-objective rule focus already has: an agent may report
 * progress on work it was given, but may not quietly rewrite or delete what it
 * was asked to do.
 */
export function mayAgentEdit(task: Task): boolean {
	return task.origin === "agent";
}

function validateStatusChange(task: Task, status: TaskStatus, note: string | undefined): string | null {
	if ((task.subtasks?.length ?? 0) > 0) {
		return `${task.id} has sub-tasks, so its status is derived from them; only leaves can be set directly`;
	}
	const effectiveNote = note ?? task.note;
	if (statusRequiresNote(status) && (effectiveNote === undefined || effectiveNote.trim().length === 0)) {
		return `${status} requires a written reason; pass a note`;
	}
	return null;
}

export interface TaskUpdate {
	readonly id: string;
	readonly status?: TaskStatus;
	readonly title?: string;
	readonly note?: string;
	readonly ref?: string;
	readonly delegation?: TaskDelegation | null;
	readonly lastAttempt?: TaskLastAttempt | null;
}

function replaceTask(tasks: readonly Task[], id: string, replace: (task: Task) => Task): Task[] {
	return tasks.map((task) => {
		if (task.id === id) return withDerivedStatus(replace(task));
		const children = task.subtasks;
		if (children === undefined) return task;
		const nextChildren = replaceTask(children, id, replace);
		return nextChildren === children ? task : withDerivedStatus({ ...task, subtasks: nextChildren });
	});
}

/** Apply a batch of updates. All-or-nothing: one bad update rejects the batch. */
export function applyUpdates(tasks: readonly Task[], updates: readonly TaskUpdate[], actor: TaskActor): MutationResult<Task[]> {
	if (updates.length === 0) return fail("no updates supplied");
	let next = [...tasks];
	for (const update of updates) {
		const found = findTask(next, update.id);
		if (!found) return fail(`no task ${update.id}`);
		const { task } = found;
		if (update.ref !== undefined) {
			if (actor === "agent" && !mayAgentEdit(task)) {
				return fail(`${task.id} is ${task.origin}-origin, so it can be transitioned but not retitled or referenced`);
			}
			if (!isValidTaskRef(update.ref)) {
				return fail(`ref for ${task.id} must be a non-empty task-safe value of at most ${MAX_TASK_ID_CHARS} characters`);
			}
		}
		if (update.title !== undefined) {
			if (actor === "agent" && !mayAgentEdit(task)) {
				return fail(`${task.id} is ${task.origin}-origin, so it can be transitioned but not retitled`);
			}
			if (!boundedString(update.title, MAX_TASK_TITLE_CHARS) || /[\r\n]/.test(update.title)) {
				return fail(`title for ${task.id} must be one line of at most ${MAX_TASK_TITLE_CHARS} characters`);
			}
		}
		if (update.note !== undefined && update.note.length > MAX_TASK_NOTE_CHARS) {
			return fail(`note for ${task.id} must be at most ${MAX_TASK_NOTE_CHARS} characters`);
		}
		if (update.delegation !== undefined && update.delegation !== null && parseDelegation(update.delegation) === null) {
			return fail(`delegation for ${task.id} must name a session`);
		}
		if (update.lastAttempt !== undefined && update.lastAttempt !== null && parseLastAttempt(update.lastAttempt) === null) {
			return fail(`last attempt for ${task.id} must name a run and end state`);
		}
		if (update.status !== undefined) {
			const problem = validateStatusChange(task, update.status, update.note);
			if (problem) return fail(problem);
		}
		next = replaceTask(next, update.id, (current) => ({
			...current,
			...(update.title === undefined ? {} : { title: update.title }),
			...(update.ref === undefined ? {} : { ref: update.ref }),
			...(update.status === undefined ? {} : { status: update.status }),
			...(update.note === undefined ? {} : update.note.trim().length === 0 ? {} : { note: update.note }),
			// An explicitly emptied note clears the field rather than storing "".
			...(update.note !== undefined && update.note.trim().length === 0 ? { note: undefined } : {}),
			...(update.delegation === undefined ? {} : { delegation: update.delegation === null ? undefined : update.delegation }),
			...(update.lastAttempt === undefined ? {} : { lastAttempt: update.lastAttempt === null ? undefined : update.lastAttempt }),
		}));
	}
	// Re-parse so derived statuses and bounds are enforced by the schema, not by
	// the caller's care.
	const parsed = parseTasks(next.map(stripUndefined));
	return parsed ? { ok: true, value: parsed } : fail("the resulting list is not valid");
}

function stripUndefined(task: Task): Task {
	const result: Record<string, unknown> = { id: task.id, title: task.title, status: task.status, origin: task.origin };
	if (task.ref !== undefined) result.ref = task.ref;
	if (task.note !== undefined) result.note = task.note;
	if (task.delegation !== undefined) result.delegation = task.delegation;
	if (task.lastAttempt !== undefined) result.lastAttempt = task.lastAttempt;
	if (task.subtasks !== undefined) result.subtasks = task.subtasks.map(stripUndefined);
	return result as unknown as Task;
}

export interface NewTask {
	readonly title: string;
	readonly note?: string;
	readonly status?: TaskStatus;
	readonly ref?: string;
	readonly delegation?: TaskDelegation;
	readonly lastAttempt?: TaskLastAttempt;
	readonly subtasks?: readonly NewTask[];
}

export interface TaskMutationContext {
	/** Number of delegation frames above this session. Defaults to zero. */
	readonly delegationDepth?: number;
}

function writableDepth(context: TaskMutationContext | undefined): number | null {
	const delegationDepth = context?.delegationDepth ?? 0;
	if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) return null;
	return Math.min(HARD_MAX_TASK_DEPTH, DEFAULT_MAX_TASK_DEPTH + delegationDepth);
}

function taskPlanExceedsDepth(item: NewTask, depth: number, allowed: number): boolean {
	if (depth > allowed) return true;
	return (item.subtasks ?? []).some((child) => taskPlanExceedsDepth(child, depth + 1, allowed));
}

function taskPlanHasInvalidRef(item: NewTask): boolean {
	return (item.ref !== undefined && !isValidTaskRef(item.ref))
		|| (item.subtasks ?? []).some(taskPlanHasInvalidRef);
}

function* walkTasks(tasks: readonly Task[]): Generator<Task> {
	for (const task of tasks) {
		yield task;
		yield* walkTasks(task.subtasks ?? []);
	}
}

function buildPlannedTask(item: NewTask, id: string, origin: TaskOrigin): Task {
	const children = (item.subtasks ?? []).map((child, index) => buildPlannedTask(child, `${id}.${index + 1}`, origin));
	return {
		id,
		title: item.title,
		status: item.status ?? "pending",
		...(item.ref === undefined ? {} : { ref: item.ref }),
		...(item.note === undefined ? {} : { note: item.note }),
		origin,
		...(item.delegation === undefined ? {} : { delegation: item.delegation }),
		...(item.lastAttempt === undefined ? {} : { lastAttempt: item.lastAttempt }),
		...(children.length === 0 ? {} : { subtasks: children }),
	};
}

/** Replace the whole list. The normal way an agent starts a multi-task session. */
export function planTasks(plan: readonly NewTask[], origin: TaskOrigin, context: TaskMutationContext = {}): MutationResult<Task[]> {
	if (plan.length === 0) return fail("a plan needs at least one task");
	if (plan.length > MAX_TASKS) return fail(`a plan may hold at most ${MAX_TASKS} tasks`);
	const allowed = writableDepth(context);
	if (allowed === null) return fail("delegation depth must be a non-negative safe integer");
	for (const item of plan) {
		if (taskPlanHasInvalidRef(item)) {
			return fail(`ref must be a non-empty task-safe value of at most ${MAX_TASK_ID_CHARS} characters`);
		}
		if (taskPlanExceedsDepth(item, 0, allowed)) {
			return fail(`task nesting exceeds the delegation depth budget (maximum depth ${allowed})`);
		}
	}
	const tasks: Task[] = [];
	for (const [index, item] of plan.entries()) {
		const task = buildPlannedTask(item, `t${index + 1}`, origin);
		if (statusRequiresNote(task.status) && (task.note === undefined || task.note.trim().length === 0)) {
			return fail(`${task.status} requires a written reason; pass a note for "${task.title}"`);
		}
		const invalid = [...walkTasks([task])].find((candidate) => statusRequiresNote(candidate.status) && (candidate.note === undefined || candidate.note.trim().length === 0));
		if (invalid !== undefined) return fail(`${invalid.status} requires a written reason; pass a note for "${invalid.title}"`);
		tasks.push(task);
	}
	const parsed = parseTasks(tasks);
	return parsed ? { ok: true, value: parsed } : fail("the plan is not valid");
}

export interface AddTaskOptions {
	readonly title: string;
	readonly note?: string;
	readonly ref?: string;
	readonly parent?: string;
	readonly after?: string;
	readonly before?: string;
	readonly origin: TaskOrigin;
	readonly delegationDepth?: number;
}

function findTaskDepth(tasks: readonly Task[], id: string, depth = 0): number | null {
	for (const task of tasks) {
		if (task.id === id) return depth;
		const nested = findTaskDepth(task.subtasks ?? [], id, depth + 1);
		if (nested !== null) return nested;
	}
	return null;
}

export function addTask(tasks: readonly Task[], options: AddTaskOptions): MutationResult<Task[]> {
	if (options.after !== undefined && options.before !== undefined) {
		return fail("pass either after or before, not both");
	}
	if (!boundedString(options.title, MAX_TASK_TITLE_CHARS) || /[\r\n]/.test(options.title)) {
		return fail(`title must be one line of at most ${MAX_TASK_TITLE_CHARS} characters`);
	}
	if (options.ref !== undefined && !isValidTaskRef(options.ref)) {
		return fail(`ref must be a non-empty task-safe value of at most ${MAX_TASK_ID_CHARS} characters`);
	}

	if (options.parent !== undefined) {
		const found = findTask(tasks, options.parent);
		if (!found) return fail(`no task ${options.parent}`);
		const parentDepth = findTaskDepth(tasks, options.parent);
		const allowed = writableDepth({ delegationDepth: options.delegationDepth });
		if (parentDepth === null || allowed === null) return fail("delegation depth must be a non-negative safe integer");
		if (parentDepth + 1 > allowed) {
			return fail(`task nesting exceeds the delegation depth budget (maximum depth ${allowed})`);
		}
		const parent = found.task;
		const children = [...(parent.subtasks ?? [])];
		if (children.length >= MAX_SUBTASKS) return fail(`a task may hold at most ${MAX_SUBTASKS} sub-tasks`);
		const child: Task = {
			id: nextSubtaskId(parent),
			title: options.title,
			status: "pending",
			...(options.ref === undefined ? {} : { ref: options.ref }),
			...(options.note === undefined ? {} : { note: options.note }),
			origin: options.origin,
		};
		const at = insertionIndex(children, options.after, options.before);
		if (at === null) return fail("the after/before task is not a sibling of the new sub-task");
		children.splice(at, 0, child);
		const next = replaceTask(tasks, parent.id, (current) => ({ ...current, subtasks: children }));
		const parsed = parseTasks(next);
		return parsed ? { ok: true, value: parsed } : fail("the resulting list is not valid");
	}

	if (tasks.length >= MAX_TASKS) return fail(`a list may hold at most ${MAX_TASKS} tasks`);
	const next = [...tasks];
	const task: Task = {
		id: nextTaskId(tasks),
		title: options.title,
		status: "pending",
		...(options.ref === undefined ? {} : { ref: options.ref }),
		...(options.note === undefined ? {} : { note: options.note }),
		origin: options.origin,
	};
	const at = insertionIndex(next, options.after, options.before);
	if (at === null) return fail("the after/before task is not in the list");
	next.splice(at, 0, task);
	const parsed = parseTasks(next);
	return parsed ? { ok: true, value: parsed } : fail("the resulting list is not valid");
}

/** Resolve `after`/`before` to an index, or null when the anchor is not a sibling. */
function insertionIndex(siblings: readonly Task[], after: string | undefined, before: string | undefined): number | null {
	if (after !== undefined) {
		const index = siblings.findIndex((task) => task.id === after);
		return index === -1 ? null : index + 1;
	}
	if (before !== undefined) {
		const index = siblings.findIndex((task) => task.id === before);
		return index === -1 ? null : index;
	}
	return siblings.length;
}

export function removeTasks(tasks: readonly Task[], ids: readonly string[], actor: TaskActor): MutationResult<Task[]> {
	if (ids.length === 0) return fail("no ids supplied");
	for (const id of ids) {
		const found = findTask(tasks, id);
		if (!found) return fail(`no task ${id}`);
		if (actor === "agent" && !mayAgentEdit(found.task)) {
			return fail(`${id} is ${found.task.origin}-origin, so it can be transitioned but not removed`);
		}
	}
	const removing = new Set(ids);
	const removeNested = (candidates: readonly Task[]): Task[] => candidates
		.filter((task) => !removing.has(task.id))
		.map((task) => {
			const children = removeNested(task.subtasks ?? []);
			return withDerivedStatus(children.length === 0 ? { ...task, subtasks: undefined } : { ...task, subtasks: children });
		});
	const next = removeNested(tasks);
	const parsed = parseTasks(next.map(stripUndefined));
	return parsed ? { ok: true, value: parsed } : fail("the resulting list is not valid");
}

/** Reorder top-level tasks. The full id sequence is required, so the result is unambiguous. */
export function reorderTasks(tasks: readonly Task[], ids: readonly string[]): MutationResult<Task[]> {
	if (ids.length !== tasks.length) return fail(`reorder needs all ${tasks.length} task ids, in the order you want`);
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const next: Task[] = [];
	for (const id of ids) {
		const task = byId.get(id);
		if (!task) return fail(`no task ${id}`);
		if (next.some((existing) => existing.id === id)) return fail(`${id} appears twice`);
		next.push(task);
	}
	const parsed = parseTasks(next);
	return parsed ? { ok: true, value: parsed } : fail("the resulting list is not valid");
}

// ---------------------------------------------------------------------------
// Transcript entry, append and replay
// ---------------------------------------------------------------------------

export interface AppendEntryApi {
	readonly appendEntry: <T = unknown>(customType: string, data?: T) => void;
}

export function appendTasksSnapshot(api: AppendEntryApi, snapshot: TasksSnapshot): void {
	const parsed = parseTasksSnapshot(snapshot);
	if (!parsed) throw new Error("cannot append an invalid task snapshot");
	api.appendEntry(TASKS_ENTRY_TYPE, parsed);
}

/** Extract a snapshot from a transcript custom entry, ignoring everything else. */
export function parseTasksEntry(value: unknown): TasksSnapshot | null {
	if (!isRecord(value)) return null;
	if (value.type !== "custom" || value.customType !== TASKS_ENTRY_TYPE) return null;
	return parseTasksSnapshot(value.data);
}

export interface TasksReplayResult {
	readonly snapshot: TasksSnapshot | null;
	readonly authority: "transcript" | null;
	readonly rejected: number;
}

export const MAX_TASKS_REPLAY_ENTRIES = 10_000;

/**
 * Rebuild the list from the transcript.
 *
 * The winner is the highest revision. A tie is broken deterministically rather
 * than by input order, so replay of the same transcript always produces the
 * same list — including on a fork, where two branches can hold the same
 * revision number.
 */
export function replayTasksEntries(entries: readonly unknown[], maxEntries = MAX_TASKS_REPLAY_ENTRIES): TasksReplayResult {
	if (!Array.isArray(entries)) return { snapshot: null, authority: null, rejected: 0 };
	const bounded = entries.slice(0, Math.max(0, Math.min(maxEntries, MAX_TASKS_REPLAY_ENTRIES)));
	let rejected = Math.max(0, entries.length - bounded.length);
	let best: TasksSnapshot | null = null;
	for (const entry of bounded) {
		const snapshot = parseTasksEntry(entry);
		if (!snapshot) {
			rejected += 1;
			continue;
		}
		if (best === null || compareSnapshots(snapshot, best) > 0) best = snapshot;
	}
	return { snapshot: best, authority: best === null ? null : "transcript", rejected };
}

function compareSnapshots(a: TasksSnapshot, b: TasksSnapshot): number {
	if (a.revision !== b.revision) return a.revision - b.revision;
	const updated = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
	if (updated !== 0) return updated;
	return a.eventId.localeCompare(b.eventId);
}

/** The tasks a transcript establishes, or an empty list when it establishes none. */
export function resolveAuthoritativeTasks(entries: readonly unknown[]): TasksSnapshot | null {
	const replay = replayTasksEntries(entries);
	return replay.authority === "transcript" ? replay.snapshot : null;
}
