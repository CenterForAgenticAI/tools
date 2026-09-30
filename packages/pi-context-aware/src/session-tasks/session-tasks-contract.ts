/** The versioned wire contract between context-aware and pi-delegate.
 *
 * Neither package imports the other. pi-delegate declares `tasks?` on its slot
 * schema as plain JSON and hands it to whoever claims the seed channel; this
 * module is the only thing that decides what that JSON means.
 *
 * The contract ships before real use has stress-tested it, so it is built to
 * survive being wrong:
 *
 * - unknown and newer fields are ignored, never rejected, exactly as
 *   `parseIntercomMetadata` already does for pi-intercom;
 * - the seeded shape is as small as it can be, because every field added now is
 *   a field that has to be supported forever;
 * - the seed payload and the progress payload are versioned separately, so the
 *   write side and the read side can move independently;
 * - when context-aware is absent the plan degrades to a markdown checklist
 *   rather than being dropped.
 */

import {
	MAX_SUBTASKS,
	MAX_TASKS,
	MAX_TASK_NOTE_CHARS,
	MAX_TASK_TITLE_CHARS,
	MAX_TASK_ID_CHARS,
	isValidTaskRef,
	HARD_MAX_TASK_DEPTH,
	TASK_STATUSES,
	countTasks,
	isListFinished,
	isListStuck,
	statusRequiresNote,
	type Task,
	type TaskOrigin,
	type TaskStatus,
	type TasksSnapshot,
} from "./session-tasks.js";
import { renderTasksMarkdown } from "./session-tasks-view.js";

/** The shape pi-delegate sends down when dispatching a worker. */
export const TASKS_SEED_CONTRACT_VERSION = 1 as const;
/** The shape a worker sends up as it makes progress. Versioned separately. */
export const TASKS_PROGRESS_CONTRACT_VERSION = 1 as const;

/** The channel name a host uses to hand a seed to whichever extension claims it. */
export const TASKS_SEED_CHANNEL = "context-aware.tasks.v1" as const;
/** The event emitted when the list changes, carrying counts rather than the list. */
export const TASKS_CHANGED_EVENT = "context-aware.tasks.changed.v1" as const;

/** Deliberately minimal: a title plus optional state, ref, and owner identity. */
export interface SeedTask {
	readonly title: string;
	readonly status?: TaskStatus;
	readonly note?: string;
	/** A bounded opaque reference; never interpreted as task identity. */
	readonly ref?: string;
	/** Owner-side identity used to reconcile a worker report by id. */
	readonly ownerTaskId?: string;
	readonly subtasks?: readonly SeedTask[];
}

export interface TasksSeed {
	readonly schemaVersion: typeof TASKS_SEED_CONTRACT_VERSION;
	readonly tasks: readonly SeedTask[];
	/** Where the list came from. A dispatched plan is not the worker's own. */
	readonly origin?: TaskOrigin;
}

/** Bounded progress, addressed by the lineage path pi-delegate already uses. */
export interface TasksProgressEvent {
	readonly kind: "task";
	readonly schemaVersion: typeof TASKS_PROGRESS_CONTRACT_VERSION;
	readonly lineagePath: string;
	readonly ts: string;
	readonly fields: {
		readonly done: number;
		readonly total: number;
		readonly active: string | null;
		readonly blocked: number;
	};
	/** The mechanical done/gap/blocked verdict a supervisor can act on. */
	readonly outcome: "complete" | "gap" | "stuck";
}

/** One bounded task row optionally carried alongside the aggregate progress. */
export interface DelegationTaskRow {
	/** A bounded opaque reference independent of every task id field. */
	readonly ref?: string;
	readonly id?: string;
	/**
	 * The id in THIS session's list, when the dispatcher supplied one.
	 *
	 * Only a row carrying this may be reconciled against the owner's tasks.
	 */
	readonly ownerTaskId?: string;
	/**
	 * The worker's own id for the task, sent when the dispatcher supplied no
	 * owner id — the common case, because a caller writing
	 * `handoff: { tasks: [{ title }] }` supplies none.
	 *
	 * It identifies the row for display so a blocked reason can be attributed,
	 * but it belongs to the WORKER's numbering. Reconciling it against this
	 * session's `t1`/`t2` would silently update the wrong task, so `idKind`
	 * exists to keep the two apart.
	 */
	readonly localTaskId?: string;
	/** Which list the row's id belongs to. Absent on older peers. */
	readonly idKind?: "owner" | "local";
	readonly title?: string;
	readonly status?: TaskStatus;
	/** Additive v1 display detail, bounded to one nested level; older peers safely ignore it. */
	readonly subtasks?: readonly DelegationTaskRow[];
	/**
	 * The written explanation a `blocked` row must carry.
	 *
	 * pi-delegate sends this on the wire as `reason`; this model calls it
	 * `note`, matching `Task.note`. Reading only `note` silently dropped every
	 * blocked explanation, because both sides were green against their own
	 * restatement of the contract and nothing compared them.
	 */
	readonly note?: string;
}

/** The tolerant projection of the `fields.tasks` delegate payload. */
export interface DelegationProgressFields {
	readonly counts?: TasksProgressEvent["fields"] & { readonly outcome: TasksProgressEvent["outcome"] };
	readonly rows: readonly DelegationTaskRow[];
}

/**
 * The loose shape pi-delegate appends to `extensions/pi-delegate/runs.jsonl`.
 *
 * This package only needs the run and owner identities to choose event-bus
 * sinks, but the other stable fields are restated here so the on-disk seam is
 * explicit without importing pi-delegate. Unknown fields are ignored.
 */
export interface DelegationRunRecord {
	readonly runId: string;
	readonly rootRunId: string;
	readonly ownerSessionId: string;
	readonly forkName?: string;
	readonly displayLabel?: string;
	readonly status?: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly cwd?: string;
	readonly agent?: string;
	readonly workerSessionFile?: string;
}

type RecordValue = Record<string, unknown>;

const MAX_DELEGATION_RUN_ID_CHARS = 256;
const MAX_DELEGATION_OWNER_SESSION_ID_CHARS = 256;
const MAX_DELEGATION_RUN_FIELD_CHARS = 4_096;

function boundedRunIdentity(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_DELEGATION_RUN_ID_CHARS
		&& /^[A-Za-z0-9._-]+$/.test(value);
}

function optionalRunField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_DELEGATION_RUN_FIELD_CHARS
		? value
		: undefined;
}

/** Parse one append-only run record without depending on pi-delegate. */
export function parseDelegationRunRecord(value: unknown): DelegationRunRecord | undefined {
	if (!isRecord(value) || !boundedRunIdentity(value.runId) || !boundedRunIdentity(value.rootRunId)
		|| typeof value.ownerSessionId !== "string" || value.ownerSessionId.length === 0
		|| value.ownerSessionId.length > MAX_DELEGATION_OWNER_SESSION_ID_CHARS) return undefined;
	return {
		runId: value.runId,
		rootRunId: value.rootRunId,
		ownerSessionId: value.ownerSessionId,
		...(optionalRunField(value.forkName) === undefined ? {} : { forkName: optionalRunField(value.forkName) }),
		...(optionalRunField(value.displayLabel) === undefined ? {} : { displayLabel: optionalRunField(value.displayLabel) }),
		...(optionalRunField(value.status) === undefined ? {} : { status: optionalRunField(value.status) }),
		...(optionalRunField(value.startedAt) === undefined ? {} : { startedAt: optionalRunField(value.startedAt) }),
		...(optionalRunField(value.finishedAt) === undefined ? {} : { finishedAt: optionalRunField(value.finishedAt) }),
		...(optionalRunField(value.cwd) === undefined ? {} : { cwd: optionalRunField(value.cwd) }),
		...(optionalRunField(value.agent) === undefined ? {} : { agent: optionalRunField(value.agent) }),
		...(optionalRunField(value.workerSessionFile) === undefined ? {} : { workerSessionFile: optionalRunField(value.workerSessionFile) }),
	};
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function parseSeedTask(value: unknown): SeedTask | null {
	if (!isRecord(value)) return null;
	if (!boundedString(value.title, MAX_TASK_TITLE_CHARS)) return null;
	const title = value.title.replaceAll(/[\r\n]+/g, " ").trim();
	if (title.length === 0) return null;

	// An unrecognised status is dropped rather than rejected: a newer peer may
	// know a status this version does not, and losing one task's status is
	// better than losing the plan.
	const status = TASK_STATUSES.includes(value.status as TaskStatus) ? (value.status as TaskStatus) : undefined;
	const note = boundedString(value.note, MAX_TASK_NOTE_CHARS) ? value.note : undefined;
	const ownerTaskId = boundedString(value.ownerTaskId, MAX_TASK_ID_CHARS) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.ownerTaskId)
		? value.ownerTaskId
		: undefined;
	const ref = isValidTaskRef(value.ref) ? value.ref : undefined;

	let subtasks: SeedTask[] | undefined;
	if (Array.isArray(value.subtasks)) {
		subtasks = [];
		for (const child of value.subtasks.slice(0, MAX_SUBTASKS)) {
			const parsed = parseSeedTask(child);
			if (parsed) subtasks.push(parsed);
		}
	}

	// A status needing a reason, sent without one, is downgraded rather than
	// refused. The alternative is a seeded task that the local schema would
	// then reject on write.
	const keepStatus = status !== undefined && statusRequiresNote(status) && note === undefined ? undefined : status;

	return {
		title,
		...(keepStatus === undefined ? {} : { status: keepStatus }),
		...(note === undefined ? {} : { note }),
		...(ref === undefined ? {} : { ref }),
		...(ownerTaskId === undefined ? {} : { ownerTaskId }),
		...(subtasks === undefined || subtasks.length === 0 ? {} : { subtasks }),
	};
}

function seedWithinHardDepth(seed: SeedTask, depth = 0): boolean {
	return depth <= HARD_MAX_TASK_DEPTH && (seed.subtasks ?? []).every((child) => seedWithinHardDepth(child, depth + 1));
}

/**
 * Read a seed handed over by a host.
 *
 * Returns undefined only when there is nothing usable at all. Individual
 * unusable tasks are skipped, so one malformed entry cannot discard the rest
 * of a dispatched plan.
 */
export function parseTasksSeed(value: unknown): TasksSeed | undefined {
	if (!isRecord(value)) return undefined;
	// A newer major version is ignored rather than guessed at.
	if (value.schemaVersion !== TASKS_SEED_CONTRACT_VERSION) return undefined;
	if (!Array.isArray(value.tasks)) return undefined;
	const tasks: SeedTask[] = [];
	for (const candidate of value.tasks.slice(0, MAX_TASKS)) {
		const parsed = parseSeedTask(candidate);
		if (parsed !== null && seedWithinHardDepth(parsed)) tasks.push(parsed);
	}
	if (tasks.length === 0) return undefined;
	const origin = value.origin === "user" || value.origin === "spec" || value.origin === "agent"
		? value.origin
		: undefined;
	return {
		schemaVersion: TASKS_SEED_CONTRACT_VERSION,
		tasks,
		...(origin === undefined ? {} : { origin }),
	};
}

/** Build a seed from a local list, for a session that dispatches its own work. */
export function buildTasksSeed(tasks: readonly Task[], origin?: TaskOrigin): TasksSeed {
	const toSeed = (task: Task): SeedTask => ({
		title: task.title,
		status: task.status,
		...(task.note === undefined ? {} : { note: task.note }),
		...(task.ref === undefined ? {} : { ref: task.ref }),
		ownerTaskId: task.id,
		...(task.subtasks === undefined ? {} : { subtasks: task.subtasks.map(toSeed) }),
	});
	return {
		schemaVersion: TASKS_SEED_CONTRACT_VERSION,
		tasks: tasks.map(toSeed),
		...(origin === undefined ? {} : { origin }),
	};
}

/**
 * The degradation path: render a seed as a markdown checklist.
 *
 * A host that cannot find context-aware appends this to the worker's task text.
 * The worker still sees the plan; it just is not durable across the worker's
 * own compaction.
 */
export function renderSeedAsMarkdown(seed: TasksSeed): string {
	const asTask = (item: SeedTask, id: string): Task => ({
		id,
		title: item.title,
		status: item.status ?? "pending",
		...(item.ref === undefined ? {} : { ref: item.ref }),
		...(item.note === undefined ? {} : { note: item.note }),
		origin: "agent",
		...(item.subtasks === undefined
			? {}
			: { subtasks: item.subtasks.map((child, index) => asTask(child, `${id}.${index + 1}`)) }),
	});
	return renderTasksMarkdown(seed.tasks.map((item, index) => asTask(item, `t${index + 1}`)));
}

/**
 * Classify a finished worker's list mechanically.
 *
 * This is the `done` / `gap` / `blocked` handoff the implement skill already
 * asks workers to produce in prose. Producing it from state means a supervisor
 * can act on it without trusting the prose.
 */
export function classifyOutcome(tasks: readonly Task[]): TasksProgressEvent["outcome"] {
	if (isListStuck(tasks)) return "stuck";
	return isListFinished(tasks) ? "complete" : "gap";
}

export interface ProgressEventOptions {
	readonly lineagePath: string;
	readonly now?: string | Date;
}

/** Build the bounded upward event: counts and the active title, never the list. */
export function buildTasksProgressEvent(tasks: readonly Task[], options: ProgressEventOptions): TasksProgressEvent {
	const counts = countTasks(tasks);
	const active = tasks.find((task) => task.status === "active");
	const now = options.now ?? new Date();
	return {
		kind: "task",
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		lineagePath: options.lineagePath,
		ts: now instanceof Date ? now.toISOString() : now,
		fields: {
			done: counts.done,
			total: counts.total,
			active: active === undefined ? null : active.title.slice(0, MAX_TASK_TITLE_CHARS),
			blocked: counts.blocked,
		},
		outcome: classifyOutcome(tasks),
	};
}

/** Read a progress event sent by a worker; unknown or newer versions are ignored. */
export function parseTasksProgressEvent(value: unknown): TasksProgressEvent | undefined {
	if (!isRecord(value) || value.kind !== "task") return undefined;
	if (value.schemaVersion !== TASKS_PROGRESS_CONTRACT_VERSION) return undefined;
	if (!boundedString(value.lineagePath, 512) || !boundedString(value.ts, 64)) return undefined;
	if (!Number.isFinite(Date.parse(value.ts))) return undefined;
	if (!isRecord(value.fields)) return undefined;
	const fields = parseDelegationProgressFields(value.fields);
	if (fields?.counts === undefined) return undefined;
	return {
		kind: "task",
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		lineagePath: value.lineagePath,
		ts: value.ts,
		fields: {
			done: fields.counts.done,
			total: fields.counts.total,
			active: fields.counts.active,
			blocked: fields.counts.blocked,
		},
		outcome: fields.counts.outcome,
	};
}

function parseDelegationTaskRows(candidates: readonly unknown[], depth: number): DelegationTaskRow[] {
	const limit = depth === 0 ? MAX_TASKS : MAX_SUBTASKS;
	const rows: DelegationTaskRow[] = [];
	for (const candidate of candidates.slice(0, limit)) {
		if (!isRecord(candidate)) continue;
		const status = TASK_STATUSES.includes(candidate.status as TaskStatus) ? candidate.status as TaskStatus : undefined;
		const ref = isValidTaskRef(candidate.ref) ? candidate.ref : undefined;
		const id = boundedString(candidate.id, MAX_TASK_ID_CHARS) ? candidate.id : undefined;
		const ownerTaskId = boundedString(candidate.ownerTaskId, MAX_TASK_ID_CHARS) ? candidate.ownerTaskId : undefined;
		// A dispatch that supplied no owner id gets rows addressed by the worker's
		// own numbering. Keep the marker explicit so reconciliation stays safe.
		const localTaskId = boundedString(candidate.localTaskId, MAX_TASK_ID_CHARS) ? candidate.localTaskId : undefined;
		const idKind = candidate.idKind === "owner" || candidate.idKind === "local"
			? candidate.idKind
			: ownerTaskId !== undefined ? "owner" : localTaskId !== undefined ? "local" : undefined;
		const normalizedTitle = boundedString(candidate.title, MAX_TASK_TITLE_CHARS)
			? candidate.title.replaceAll(/[\r\n]+/g, " ").trim()
			: undefined;
		const title = normalizedTitle === "" ? undefined : normalizedTitle;
		// `reason` is pi-delegate's wire spelling. Prefer it to this model's `note`.
		const rawNote = boundedString(candidate.reason, MAX_TASK_NOTE_CHARS)
			? candidate.reason
			: candidate.note;
		const note = boundedString(rawNote, MAX_TASK_NOTE_CHARS) ? rawNote : undefined;
		const subtasks = depth < 1 && Array.isArray(candidate.subtasks)
			? parseDelegationTaskRows(candidate.subtasks, depth + 1)
			: [];
		// An explicitly supplied malformed ref keeps its row after the bad value is
		// omitted. `idKind` alone still carries no payload and keeps nothing.
		const suppliedRef = "ref" in candidate;
		if (!suppliedRef && id === undefined && ownerTaskId === undefined && localTaskId === undefined
			&& title === undefined && status === undefined && note === undefined && ref === undefined
			&& subtasks.length === 0) continue;
		rows.push({
			...(ref === undefined ? {} : { ref }),
			...(id === undefined ? {} : { id }),
			...(ownerTaskId === undefined ? {} : { ownerTaskId }),
			...(localTaskId === undefined ? {} : { localTaskId }),
			...(idKind === undefined ? {} : { idKind }),
			...(title === undefined ? {} : { title }),
			...(status === undefined ? {} : { status }),
			...(note === undefined ? {} : { note }),
			...(subtasks.length === 0 ? {} : { subtasks }),
		});
	}
	return rows;
}

/**
 * Read the delegate-facing `fields.tasks` shape without importing pi-delegate.
 *
 * The bus is written by another process. Unknown fields and malformed rows are
 * therefore ignored, while a malformed aggregate causes that event to be
 * skipped. Both the aggregate shape used by older peers and a row collection
 * used by newer peers are accepted.
 */
export function parseDelegationProgressFields(value: unknown): DelegationProgressFields | undefined {
	if (!isRecord(value)) return undefined;
	const payload = isRecord(value.tasks)
		? value.tasks
		: Array.isArray(value.tasks) ? { tasks: value.tasks }
			: value.tasks === undefined ? value : undefined;
	if (payload === undefined) return undefined;

	let counts: DelegationProgressFields["counts"];
	const { done, total, blocked, active } = payload;
	if ((payload.kind === undefined || (payload.kind === "task" && payload.schemaVersion === TASKS_PROGRESS_CONTRACT_VERSION))
		&& Number.isSafeInteger(done) && Number.isSafeInteger(total) && Number.isSafeInteger(blocked)
		&& (done as number) >= 0 && (total as number) >= 0 && (blocked as number) >= 0
		&& (done as number) <= (total as number)) {
		const outcome = payload.outcome === "complete" || payload.outcome === "stuck" ? payload.outcome : "gap";
		counts = {
			done: done as number,
			total: total as number,
			active: boundedString(active, MAX_TASK_TITLE_CHARS) ? active : null,
			blocked: blocked as number,
			outcome,
		};
	}

	const candidateRows = Array.isArray(payload)
		? payload
		: Array.isArray(payload.rows) ? payload.rows
			: Array.isArray(payload.items) ? payload.items
				: Array.isArray(payload.tasks) ? payload.tasks : [];
	const rows = parseDelegationTaskRows(candidateRows, 0);
	return counts === undefined && rows.length === 0 ? undefined : { counts, rows };
}

/** The bounded payload emitted locally on `pi.events` when the list changes. */
export interface TasksChangedEvent {
	readonly schemaVersion: typeof TASKS_PROGRESS_CONTRACT_VERSION;
	readonly piSessionId: string;
	readonly revision: number;
	readonly counts: ReturnType<typeof countTasks>;
	readonly changed?: { readonly id: string; readonly status: TaskStatus; readonly title: string };
}

export function buildTasksChangedEvent(
	snapshot: TasksSnapshot,
	changed?: { readonly id: string; readonly status: TaskStatus; readonly title: string },
): TasksChangedEvent {
	return {
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		piSessionId: snapshot.piSessionId,
		revision: snapshot.revision,
		counts: countTasks(snapshot.tasks),
		...(changed === undefined ? {} : { changed: { ...changed, title: changed.title.slice(0, MAX_TASK_TITLE_CHARS) } }),
	};
}
