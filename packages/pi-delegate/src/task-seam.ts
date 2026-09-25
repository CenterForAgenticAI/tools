/** Carrying a task checklist through a dispatch, in both directions.
 *
 * This is the pi-delegate half of the context-aware task handshake. The design
 * decision that shapes the whole module: **neither package imports the other.**
 * context-aware publishes a versioned wire contract; this file restates the
 * shape it needs as plain JSON and validates it loosely, the same way
 * `peer-contracts.ts` already handles pi-intercom metadata over there.
 *
 * So the duplication of the shape below is deliberate, not an oversight. The
 * alternative — importing the context-aware package — would make a checklist
 * feature a hard dependency on an optional extension.
 *
 * Two consequences follow, and both are load-bearing:
 *
 * - Unknown and newer fields are ignored rather than rejected, so a newer
 *   context-aware can add fields without breaking this package.
 * - When nothing claims the seed channel the plan degrades to a markdown
 *   checklist appended to the worker's prompt. The worker still sees its plan;
 *   only the durability is lost.
 */

/** The channel a host publishes a seed on, for whichever extension claims it. */
export const TASKS_SEED_CHANNEL = "context-aware.tasks.v1" as const;
/** Process-local environment transport used only by the detached child bootstrap. */
export const TASKS_SEED_ENV = "PI_DELEGATE_TASK_SEED_V1" as const;
/** Trusted recovery-attempt identity paired with the detached seed transport. */
export const TASK_ATTEMPT_ENV = "PI_DELEGATE_TASK_ATTEMPT_V1" as const;
/** Internal event field used to keep task snapshots within one runner attempt. */
export const TASK_ATTEMPT_FIELD = "taskAttempt" as const;
/** Keep the owner-only cfg and child environment bounded independently of the item caps. */
export const MAX_TASK_SEED_TRANSPORT_BYTES = 64 * 1024;

/** The custom entry type a worker session stores its list under. */
export const TASKS_ENTRY_TYPE = "context-aware.tasks.v1" as const;

/** Versioned separately from the progress payload, so each side can move alone. */
export const TASKS_SEED_CONTRACT_VERSION = 1 as const;
export const TASKS_PROGRESS_CONTRACT_VERSION = 1 as const;

/** Bounds mirrored from the contract; a checklist that grows without limit stops being one. */
export const MAX_SEED_TASKS = 100;
export const MAX_SEED_SUBTASKS = 50;
export const MAX_SEED_TITLE_CHARS = 200;
export const MAX_SEED_NOTE_CHARS = 240;
export const MAX_SEED_TASK_ID_CHARS = 32;
/** External correlation metadata is bounded independently of worker-local task ids. */
export const MAX_SEED_REF_CHARS = 32;
/** Keep task snapshots comfortably below the event-bus 64 KiB hard cap. */
export const MAX_TASK_PROGRESS_BYTES = 60 * 1024;

export type SeedTaskStatus = "pending" | "active" | "done" | "blocked" | "deferred";

const SEED_STATUSES: readonly SeedTaskStatus[] = ["pending", "active", "done", "blocked", "deferred"];

/** A status that carries no meaning without a stated reason. */
function statusNeedsNote(status: SeedTaskStatus): boolean {
	return status === "blocked" || status === "deferred";
}

export interface SeedTask {
	readonly title: string;
	readonly status?: SeedTaskStatus;
	readonly note?: string;
	/** The owner's stable id; worker-local ids are generated separately. */
	readonly ownerTaskId?: string;
	/** Opaque external correlation metadata; never used as a task address. */
	readonly ref?: string;
	readonly subtasks?: readonly SeedTask[];
}

export interface TasksSeed {
	readonly schemaVersion: typeof TASKS_SEED_CONTRACT_VERSION;
	readonly tasks: readonly SeedTask[];
	readonly origin?: "user" | "spec" | "agent";
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Whether opaque external task-correlation metadata matches the shared v1 contract. */
export function isValidSeedRef(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_SEED_REF_CHARS && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

const TRUNCATION_MARKER = "…";

function truncateSeedNote(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	if (value.length <= MAX_SEED_NOTE_CHARS) return value;
	// Preserve one character for a visible marker so truncation is detectable.
	let truncated = "";
	for (const character of value) {
		if (truncated.length + character.length + TRUNCATION_MARKER.length > MAX_SEED_NOTE_CHARS) break;
		truncated += character;
	}
	return `${truncated}${TRUNCATION_MARKER}`;
}

function truncateTaskTextToBytes(value: string, maxBytes: number): string | undefined {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	if (maxBytes < markerBytes) return undefined;
	let truncated = "";
	for (const character of value) {
		if (Buffer.byteLength(truncated, "utf8") + Buffer.byteLength(character, "utf8") + markerBytes > maxBytes) break;
		truncated += character;
	}
	return `${truncated}${TRUNCATION_MARKER}`;
}

function maximizeTextWithinTaskProgressBudget<T>(
	largestTextBytes: number,
	buildCandidate: (textBytes: number) => T,
): T | undefined {
	let low = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	let high = largestTextBytes;
	let best: T | undefined;
	while (low <= high) {
		const textBytes = Math.floor((low + high) / 2);
		const candidate = buildCandidate(textBytes);
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_TASK_PROGRESS_BYTES) {
			best = candidate;
			low = textBytes + 1;
		} else {
			high = textBytes - 1;
		}
	}
	return best;
}

function parseSlotTask(value: unknown, depth: number): SeedTask | null {
	// A bare string is accepted as a title. A caller writing a checklist by hand
	// should not have to wrap every line in an object.
	if (typeof value === "string") {
		const title = value.replaceAll(/[\r\n]+/g, " ").trim().slice(0, MAX_SEED_TITLE_CHARS);
		return title.length === 0 ? null : { title };
	}
	if (!isRecord(value) || !boundedString(value.title, MAX_SEED_TITLE_CHARS)) return null;
	const title = value.title.replaceAll(/[\r\n]+/g, " ").trim();
	if (title.length === 0) return null;

	const status = SEED_STATUSES.includes(value.status as SeedTaskStatus)
		? (value.status as SeedTaskStatus)
		: undefined;
	const note = truncateSeedNote(value.note);
	const ownerTaskId = boundedString(value.ownerTaskId, MAX_SEED_TASK_ID_CHARS)
		? value.ownerTaskId
		: undefined;
	const ref = isValidSeedRef(value.ref) ? value.ref : undefined;

	let subtasks: SeedTask[] | undefined;
	// One level only, matching the structural limit on the other side. Deeper
	// input is truncated rather than refused, because losing a nested step is
	// better than losing the dispatch.
	if (Array.isArray(value.subtasks) && depth < 1) {
		subtasks = [];
		for (const child of value.subtasks.slice(0, MAX_SEED_SUBTASKS)) {
			const parsed = parseSlotTask(child, depth + 1);
			if (parsed) subtasks.push(parsed);
		}
	}

	// A status that needs a reason but has none is downgraded, not refused: the
	// receiving schema would reject it on write otherwise.
	const keepStatus = status !== undefined && statusNeedsNote(status) && note === undefined ? undefined : status;

	return {
		title,
		...(keepStatus === undefined ? {} : { status: keepStatus }),
		...(note === undefined ? {} : { note }),
		...(ownerTaskId === undefined ? {} : { ownerTaskId }),
		...(ref === undefined ? {} : { ref }),
		...(subtasks === undefined || subtasks.length === 0 ? {} : { subtasks }),
	};
}

/**
 * Read the `tasks` a dispatch carried.
 *
 * Accepts either a bare array (the common case a model will write) or the full
 * versioned envelope. One malformed entry is skipped rather than discarding the
 * whole plan.
 */
export function parseSlotTasks(value: unknown): TasksSeed | undefined {
	const candidates = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.tasks)
			? value.tasks
			: undefined;
	if (candidates === undefined) return undefined;
	// An explicit envelope from the future is ignored rather than guessed at.
	if (!Array.isArray(value) && isRecord(value)) {
		const declared = value.schemaVersion;
		if (declared !== undefined && declared !== TASKS_SEED_CONTRACT_VERSION) return undefined;
	}
	const tasks: SeedTask[] = [];
	for (const candidate of candidates.slice(0, MAX_SEED_TASKS)) {
		const parsed = parseSlotTask(candidate, 0);
		if (parsed) tasks.push(parsed);
	}
	if (tasks.length === 0) return undefined;
	const origin = !Array.isArray(value) && isRecord(value) ? value.origin : undefined;
	return {
		schemaVersion: TASKS_SEED_CONTRACT_VERSION,
		tasks,
		// A dispatched plan is not the worker's own idea, so it defaults to spec
		// origin: the worker may report progress but not quietly delete it.
		origin: origin === "user" || origin === "spec" || origin === "agent" ? origin : "spec",
	};
}

const TASKS_SEED_TRANSPORT_KEYS = new Set(["schemaVersion", "tasks", "origin"]);
const TASK_TRANSPORT_KEYS = new Set(["title", "status", "note", "ownerTaskId", "ref", "subtasks"]);

function assertTransportKeys(value: RecordValue, allowed: ReadonlySet<string>, path: string): void {
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	if (unexpected !== undefined) throw new Error(`${path}.${unexpected} is unsupported`);
}

function validateTransportTask(value: unknown, path: string, depth: number): void {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	assertTransportKeys(value, TASK_TRANSPORT_KEYS, path);
	if (!boundedString(value.title, MAX_SEED_TITLE_CHARS)) {
		throw new Error(`${path}.title must be a non-empty string of at most ${MAX_SEED_TITLE_CHARS} characters`);
	}
	if (value.status !== undefined && !SEED_STATUSES.includes(value.status as SeedTaskStatus)) {
		throw new Error(`${path}.status is unsupported`);
	}
	if (value.note !== undefined && !boundedString(value.note, MAX_SEED_NOTE_CHARS)) {
		throw new Error(`${path}.note must be a non-empty string of at most ${MAX_SEED_NOTE_CHARS} characters`);
	}
	if ((value.status === "blocked" || value.status === "deferred") && value.note === undefined) {
		throw new Error(`${path}.note is required for ${value.status} tasks`);
	}
	if (value.ownerTaskId !== undefined && !boundedString(value.ownerTaskId, MAX_SEED_TASK_ID_CHARS)) {
		throw new Error(`${path}.ownerTaskId must be a non-empty string of at most ${MAX_SEED_TASK_ID_CHARS} characters`);
	}
	if (value.ref !== undefined && !isValidSeedRef(value.ref)) {
		if (typeof value.ref !== "string") {
			throw new Error(`${path}.ref must be a string matching ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
		}
		if (value.ref.length > MAX_SEED_REF_CHARS) {
			throw new Error(`${path}.ref is ${value.ref.length} characters; the limit is ${MAX_SEED_REF_CHARS}`);
		}
		throw new Error(`${path}.ref must match ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
	}
	if (value.subtasks !== undefined) {
		if (depth > 0) throw new Error(`${path}.subtasks nests too deeply`);
		if (!Array.isArray(value.subtasks) || value.subtasks.length > MAX_SEED_SUBTASKS) {
			throw new Error(`${path}.subtasks must contain at most ${MAX_SEED_SUBTASKS} entries`);
		}
		value.subtasks.forEach((child, index) => validateTransportTask(child, `${path}.subtasks[${index}]`, depth + 1));
	}
}

/** Validate the canonical owner→child payload before it crosses a process boundary. */
export function assertValidTasksSeed(value: unknown): asserts value is TasksSeed {
	if (!isRecord(value) || value.schemaVersion !== TASKS_SEED_CONTRACT_VERSION) {
		throw new Error(`task seed transport must declare schemaVersion ${TASKS_SEED_CONTRACT_VERSION}`);
	}
	assertTransportKeys(value, TASKS_SEED_TRANSPORT_KEYS, "task seed transport");
	if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > MAX_SEED_TASKS) {
		throw new Error(`task seed transport tasks must contain 1-${MAX_SEED_TASKS} entries`);
	}
	if (value.origin !== undefined && value.origin !== "user" && value.origin !== "spec" && value.origin !== "agent") {
		throw new Error("task seed transport origin is unsupported");
	}
	value.tasks.forEach((task, index) => validateTransportTask(task, `tasks[${index}]`, 0));
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TASK_SEED_TRANSPORT_BYTES) {
		throw new Error(`task seed transport exceeds ${MAX_TASK_SEED_TRANSPORT_BYTES} bytes`);
	}
}

/** Parse and validate the environment payload used by the detached bootstrap. */
export function parseTasksSeedTransport(raw: string): TasksSeed {
	if (Buffer.byteLength(raw, "utf8") > MAX_TASK_SEED_TRANSPORT_BYTES) {
		throw new Error(`task seed transport exceeds ${MAX_TASK_SEED_TRANSPORT_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`task seed transport is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	assertValidTasksSeed(parsed);
	return parsed;
}

// ---------------------------------------------------------------------------
// Downward: building a worker-session payload
// ---------------------------------------------------------------------------

/** What the worker's session stores. A full snapshot, matching the receiver's schema. */
export interface SeededSnapshot {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly revision: 1;
	readonly piSessionId: string;
	readonly tasks: readonly SeededTask[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface SeededTask {
	readonly id: string;
	readonly title: string;
	readonly status: SeedTaskStatus;
	readonly note?: string;
	/** Stable id in the owner session; absent for legacy/non-delegated seeds. */
	readonly ownerTaskId?: string;
	/** Opaque external correlation metadata; independent of both ids. */
	readonly ref?: string;
	readonly origin: "user" | "spec" | "agent";
	readonly subtasks?: readonly SeededTask[];
}

function seededTask(task: SeedTask, id: string, origin: "user" | "spec" | "agent"): SeededTask {
	const children = (task.subtasks ?? []).map((child, index) => seededTask(child, `${id}.${index + 1}`, origin));
	return {
		id,
		title: task.title,
		status: task.status ?? "pending",
		...(task.note === undefined ? {} : { note: task.note }),
		...(task.ownerTaskId === undefined ? {} : { ownerTaskId: task.ownerTaskId }),
		...(task.ref === undefined ? {} : { ref: task.ref }),
		origin,
		...(children.length === 0 ? {} : { subtasks: children }),
	};
}

/** The tool an extension registers when it owns a durable session task list. */
export const TASKS_TOOL_NAME = "session_tasks" as const;

export interface SeedSessionOptions {
	readonly piSessionId: string;
	readonly now?: Date;
	readonly eventId?: string;
}

/** Build the exact snapshot stored in a worker session by the seed registry. */
export function buildSessionTasksSeed(seed: TasksSeed, options: SeedSessionOptions): SeededSnapshot {
	const now = (options.now ?? new Date()).toISOString();
	const origin = seed.origin ?? "spec";
	return {
		schemaVersion: 1,
		eventId: options.eventId ?? `seed-${options.piSessionId}`,
		revision: 1,
		piSessionId: options.piSessionId,
		tasks: seed.tasks.map((task, index) => seededTask(task, `t${index + 1}`, origin)),
		createdAt: now,
		updatedAt: now,
	};
}

// ---------------------------------------------------------------------------
// The degradation path
// ---------------------------------------------------------------------------

const STATUS_MARKER: Record<SeedTaskStatus, string> = {
	pending: " ",
	active: ">",
	done: "x",
	blocked: "!",
	deferred: "~",
};

function markdownLine(task: SeedTask, indent: string): string {
	const marker = STATUS_MARKER[task.status ?? "pending"];
	const note = task.note === undefined ? "" : ` — ${task.note}`;
	return `${indent}- [${marker}] ${task.title}${note}`;
}

/** Render the plan as an ordinary markdown checklist. */
export function renderTasksMarkdown(seed: TasksSeed): string {
	const lines: string[] = [];
	for (const task of seed.tasks) {
		lines.push(markdownLine(task, ""));
		for (const child of task.subtasks ?? []) lines.push(markdownLine(child, "  "));
	}
	return lines.join("\n");
}

/**
 * Append the checklist to the worker's prompt when nothing claims the channel.
 *
 * The heading matters: without it a worker cannot tell a dispatched plan from
 * the task text itself, and may treat the list as prose to summarise.
 */
export function appendTasksToPrompt(task: string, seed: TasksSeed): string {
	return `${task}\n\n## Task checklist\n\nWork through these and report which are done:\n\n${renderTasksMarkdown(seed)}`;
}

// ---------------------------------------------------------------------------
// Upward: progress
// ---------------------------------------------------------------------------

/**
 * The key task progress occupies inside a bus event's `fields`.
 *
 * Namespaced rather than merged flat because `fields.kind` already carries
 * this package's terminal markers (`"paused"`, `"steered"`, read by
 * `updateBusTerminalSummary` and run-introspect). A second meaning on that key
 * would be a collision waiting to happen.
 */
export const TASK_PROGRESS_FIELD = "tasks" as const;
/** The sibling event field carrying the canonical terminal ledger. */
export const TASK_LEDGER_FIELD = "taskLedger" as const;

export type TaskProgressIdKind = "owner" | "local";

export interface TaskProgressRow {
	/** Identifies whether the row id addresses the owner list or the worker list. */
	readonly idKind?: TaskProgressIdKind;
	/** Stable id in the owner session; present when idKind is "owner". */
	readonly ownerTaskId?: string;
	/** Stable id generated in the worker session; present when idKind is "local". */
	readonly localTaskId?: string;
	/** Opaque external correlation metadata; never an address or reconciliation key. */
	readonly ref?: string;
	/** Real bounded title. Absent on legacy progress rows. */
	readonly title?: string;
	readonly status: SeedTaskStatus;
	readonly reason?: string;
	/** One supported nested level, preserved as an additive v1 field. */
	readonly subtasks?: readonly TaskProgressRow[];
}

export interface TaskProgressFields {
	/** Marks the payload as task progress once nested under its key. */
	readonly kind: "task";
	readonly schemaVersion: typeof TASKS_PROGRESS_CONTRACT_VERSION;
	readonly done: number;
	readonly total: number;
	readonly active: string | null;
	readonly blocked: number;
	readonly outcome: TaskOutcome;
	/** Full status snapshot; optional titles/subtasks keep schema v1 legacy-compatible. */
	readonly rows?: readonly TaskProgressRow[];
}

/** The `done` / `gap` / `stuck` verdict a supervisor can act on without reading prose. */
export type TaskOutcome = "complete" | "gap" | "stuck";

export interface TaskCounts {
	readonly done: number;
	readonly total: number;
	readonly active: string | null;
	readonly blocked: number;
	readonly pending: number;
	readonly deferred: number;
}

/** Count a replayed snapshot's top-level tasks. Sub-tasks are steps, not items. */
export function countSeededTasks(tasks: readonly SeededTask[]): TaskCounts {
	let done = 0;
	let blocked = 0;
	let pending = 0;
	let deferred = 0;
	let active: string | null = null;
	for (const task of tasks) {
		if (task.status === "done") done += 1;
		else if (task.status === "blocked") blocked += 1;
		else if (task.status === "deferred") deferred += 1;
		else if (task.status === "active") {
			if (active === null) active = task.title;
		} else pending += 1;
	}
	return { done, total: tasks.length, active, blocked, pending, deferred };
}

/**
 * Classify a list mechanically.
 *
 * `stuck` beats `gap`: both need attention, but blocked is the one that needs a
 * person. An unrecognised state must never read as success.
 */
export function classifyTaskOutcome(counts: TaskCounts): TaskOutcome {
	if (counts.blocked > 0) return "stuck";
	if (counts.total === 0) return "gap";
	return counts.done + counts.deferred === counts.total ? "complete" : "gap";
}

/**
 * Build the payload that rides a bus event's `fields`.
 *
 * NOT a new bus `kind`. `BusEventKind` is a lifecycle discriminator
 * (`started` / `updated` / `completed`) and two parts of the bus depend on it:
 * `isBusEvent` rejects any other value outright, and `applyBounds` keeps only
 * `started`, the latest `updated`, and `completed` when a child exceeds
 * `MAX_STEPS` — so a `kind: "task"` event would be dropped precisely when a
 * fork is busiest and its progress matters most.
 *
 * Riding inside `fields` on an `updated` event inherits exactly the right
 * retention instead: the latest task counts win, which is what progress means.
 */
export function buildTaskProgressFields(
	counts: TaskCounts,
	rows?: readonly TaskProgressRow[],
): TaskProgressFields {
	const boundedRows = rows === undefined ? undefined : boundTaskProgressRows(rows);
	const hasRowEvidence = boundedRows !== undefined && boundedRows.length > 0;
	return {
		kind: "task",
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		done: counts.done,
		total: counts.total,
		active: counts.active === null ? null : counts.active.slice(0, MAX_SEED_TITLE_CHARS),
		blocked: counts.blocked,
		// A complete verdict is meaningful only with rows. Keep non-success
		// progress visible when an older caller has only aggregate counts.
		outcome: hasRowEvidence ? classifyTaskOutcome(counts) : counts.blocked > 0 ? "stuck" : "gap",
		...(hasRowEvidence ? { rows: boundedRows } : {}),
	};
}

/**
 * Keep the full row snapshot intact under the event-bus cap. Reasons are the
 * expendable part: progressively shorten them rather than dropping every
 * explanation when the rows cross the budget.
 */
function normalizeTaskProgressTitle(value: unknown): string | undefined {
	if (!boundedString(value, MAX_SEED_TITLE_CHARS)) return undefined;
	const title = value.replaceAll(/[\r\n]+/g, " ").trim();
	return title === "" ? undefined : title;
}

function normalizeTaskProgressRow(row: TaskProgressRow, depth: number): TaskProgressRow {
	// Missing idKind is the legacy in-process owner-row shape. Every row put
	// on the wire gets an explicit marker so local ids cannot be reconciled as
	// owner ids by a consumer.
	const idKind = row.idKind ?? (row.ownerTaskId === undefined ? "local" : "owner");
	const title = normalizeTaskProgressTitle(row.title);
	const reason = row.status === "blocked" ? truncateSeedNote(row.reason) : undefined;
	const ref = isValidSeedRef(row.ref) ? row.ref : undefined;
	const subtasks = depth < 1
		? (row.subtasks ?? []).slice(0, MAX_SEED_SUBTASKS).map((child) => normalizeTaskProgressRow(child, depth + 1))
		: [];
	return {
		idKind,
		...(idKind === "local"
			? { localTaskId: (row.localTaskId ?? "").slice(0, MAX_SEED_TASK_ID_CHARS) }
			: { ownerTaskId: (row.ownerTaskId ?? "").slice(0, MAX_SEED_TASK_ID_CHARS) }),
		...(ref === undefined ? {} : { ref }),
		...(title === undefined ? {} : { title }),
		status: row.status,
		...(reason === undefined ? {} : { reason }),
		...(subtasks.length === 0 ? {} : { subtasks }),
	};
}

function mapTaskProgressRows(
	rows: readonly TaskProgressRow[],
	mapRow: (row: TaskProgressRow) => TaskProgressRow,
): TaskProgressRow[] {
	return rows.map((row) => {
		const subtasks = row.subtasks === undefined
			? undefined
			: mapTaskProgressRows(row.subtasks, mapRow);
		return mapRow({
			...row,
			...(subtasks === undefined ? {} : { subtasks }),
		});
	});
}

function largestTaskRowTextBytes(
	rows: readonly TaskProgressRow[],
	select: (row: TaskProgressRow) => string | undefined,
): number {
	let largest = 0;
	for (const row of rows) {
		const value = select(row);
		if (value !== undefined) largest = Math.max(largest, Buffer.byteLength(value, "utf8"));
		largest = Math.max(largest, largestTaskRowTextBytes(row.subtasks ?? [], select));
	}
	return largest;
}

function rowsFitProgressBudget(rows: readonly TaskProgressRow[]): boolean {
	return Buffer.byteLength(JSON.stringify(rows), "utf8") <= MAX_TASK_PROGRESS_BYTES;
}

function truncateTaskRowText(
	rows: readonly TaskProgressRow[],
	field: "reason" | "title",
	maxBytes: number,
): TaskProgressRow[] {
	return mapTaskProgressRows(rows, (row) => {
		const value = row[field];
		if (value === undefined) return row;
		const truncated = truncateTaskTextToBytes(value, maxBytes);
		if (field === "reason") {
			const { reason: _reason, ...rest } = row;
			return truncated === undefined ? rest : { ...rest, reason: truncated };
		}
		const { title: _title, ...rest } = row;
		return truncated === undefined ? rest : { ...rest, title: truncated };
	});
}

function boundTaskProgressRows(rows: readonly TaskProgressRow[]): TaskProgressRow[] {
	const normalized = rows.slice(0, MAX_SEED_TASKS).map((row) => normalizeTaskProgressRow(row, 0));
	if (rowsFitProgressBudget(normalized)) return normalized;

	// Human explanations are expendable before task identity. Shorten all of them
	// evenly so one early blocked row cannot consume the rest of the budget.
	const reasonBounded = maximizeTextWithinTaskProgressBudget(
		largestTaskRowTextBytes(normalized, (row) => row.reason),
		(reasonBytes) => truncateTaskRowText(normalized, "reason", reasonBytes),
	);
	if (reasonBounded !== undefined) return reasonBounded;

	const withoutReasons = mapTaskProgressRows(normalized, (row) => {
		const { reason: _reason, ...rest } = row;
		return rest;
	});
	if (rowsFitProgressBudget(withoutReasons)) return withoutReasons;

	// A maximal self-authored list can exceed the bus cap once titles and nested
	// steps are added. Keep every structural row when possible and visibly bound
	// its real title rather than inventing or silently replacing it.
	const titleBounded = maximizeTextWithinTaskProgressBudget(
		largestTaskRowTextBytes(withoutReasons, (row) => row.title),
		(titleBytes) => truncateTaskRowText(withoutReasons, "title", titleBytes),
	);
	if (titleBounded !== undefined) return titleBounded;

	// Top-level rows are the reconciliation snapshot and therefore outrank nested
	// display detail at the absolute limit.
	const topLevel = normalized.map((row) => {
		const { subtasks: _subtasks, ...rest } = row;
		return rest;
	});
	if (rowsFitProgressBudget(topLevel)) return topLevel;
	const boundedTopLevelReasons = maximizeTextWithinTaskProgressBudget(
		largestTaskRowTextBytes(topLevel, (row) => row.reason),
		(reasonBytes) => truncateTaskRowText(topLevel, "reason", reasonBytes),
	);
	if (boundedTopLevelReasons !== undefined) return boundedTopLevelReasons;

	const topLevelWithoutReasons = topLevel.map((row) => {
		const { reason: _reason, ...rest } = row;
		return rest;
	});
	if (rowsFitProgressBudget(topLevelWithoutReasons)) return topLevelWithoutReasons;
	const boundedTopLevelTitles = maximizeTextWithinTaskProgressBudget(
		largestTaskRowTextBytes(topLevelWithoutReasons, (row) => row.title),
		(titleBytes) => truncateTaskRowText(topLevelWithoutReasons, "title", titleBytes),
	);
	if (boundedTopLevelTitles !== undefined) return boundedTopLevelTitles;

	// The published id/status bounds fit. Preserve that mechanical snapshot if a
	// future title or encoding change defeats every display-detail fallback.
	return topLevelWithoutReasons.map((row) => {
		const { title: _title, ...mechanical } = row;
		return mechanical;
	});
}

/** Read task progress out of a bus event's `fields`; anything else yields undefined. */
export function readTaskProgressFields(busFields: unknown): TaskProgressFields | undefined {
	if (!isRecord(busFields)) return undefined;
	const fields = busFields[TASK_PROGRESS_FIELD];
	if (!isRecord(fields) || fields.kind !== "task") return undefined;
	if (fields.schemaVersion !== TASKS_PROGRESS_CONTRACT_VERSION) return undefined;
	const { done, total, blocked, active } = fields;
	if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || !Number.isSafeInteger(blocked)) return undefined;
	if ((done as number) < 0 || (total as number) < 0 || (blocked as number) < 0) return undefined;
	if ((total as number) > MAX_SEED_TASKS) return undefined;
	if ((done as number) > (total as number) || (blocked as number) > (total as number)) return undefined;
	const projectedActive = active === null
		? null
		: boundedString(active, MAX_SEED_TITLE_CHARS)
			? active
			: undefined;
	if (projectedActive === undefined) return undefined;
	const activeCount = projectedActive === null ? 0 : 1;
	if ((done as number) + (blocked as number) + activeCount > (total as number)) return undefined;
	const canonicalOutcome: TaskOutcome = (blocked as number) > 0
		? "stuck"
		: projectedActive === null && (done as number) === (total as number)
			? "complete"
			: "gap";
	// An unknown verdict reads as a gap only when the counts themselves imply
	// a gap. A supervisor must never be told a worker finished because the
	// verdict could not be understood.
	const statedOutcome = fields.outcome === "complete" || fields.outcome === "stuck" || fields.outcome === "gap"
		? fields.outcome
		: undefined;
	if (statedOutcome === undefined && canonicalOutcome !== "gap") return undefined;
	const outcome: TaskOutcome = statedOutcome ?? "gap";
	const rowsSupplied = Object.prototype.hasOwnProperty.call(fields, "rows");
	// Counts alone cannot prove that every task is settled: deferred rows are
	// intentionally excluded from the numeric wire counters. Completion must
	// therefore carry the full row evidence, including the all-deferred case.
	if (!rowsSupplied && outcome === "complete") return undefined;
	// A builder without rows downgrades complete counts to a conservative gap;
	// accept that downgrade while still rejecting every other inconsistent claim.
	if (!rowsSupplied && outcome !== canonicalOutcome && !(outcome === "gap" && canonicalOutcome === "complete")) return undefined;
	if (rowsSupplied) {
		let rowBytes: number;
		try {
			rowBytes = Buffer.byteLength(JSON.stringify(fields.rows), "utf8");
		} catch {
			return undefined;
		}
		if (rowBytes > MAX_TASK_PROGRESS_BYTES) return undefined;
	}
	const rows = rowsSupplied ? parseTaskProgressRows(fields.rows) : undefined;
	if (rowsSupplied && rows === undefined) return undefined;
	if (rowsSupplied) {
		const rowCounts = countTaskProgressRows(rows ?? []);
		if (
			rows?.length !== total ||
			rowCounts.done !== done ||
			rowCounts.blocked !== blocked ||
			rowCounts.pending !== total - done - blocked - rowCounts.active - rowCounts.deferred ||
			rowCounts.active !== activeCount ||
			rowCounts.deferred + rowCounts.done + rowCounts.blocked + rowCounts.pending + rowCounts.active !== total
		) return undefined;
		const rowOutcome = classifyTaskOutcome({
			done: rowCounts.done,
			total,
			active: rowCounts.active === 0 ? null : projectedActive,
			blocked: rowCounts.blocked,
			pending: rowCounts.pending,
			deferred: rowCounts.deferred,
		});
		if (rowOutcome !== outcome) return undefined;
	}
	return {
		kind: "task",
		schemaVersion: TASKS_PROGRESS_CONTRACT_VERSION,
		done: done as number,
		total: total as number,
		active: projectedActive,
		blocked: blocked as number,
		outcome,
		...(rowsSupplied ? { rows } : {}),
	};
}

interface TaskProgressRowCounts {
	done: number;
	blocked: number;
	pending: number;
	active: number;
	deferred: number;
}

function countTaskProgressRows(rows: readonly TaskProgressRow[]): TaskProgressRowCounts {
	const counts: TaskProgressRowCounts = { done: 0, blocked: 0, pending: 0, active: 0, deferred: 0 };
	for (const row of rows) counts[row.status] += 1;
	return counts;
}

function parseTaskProgressRow(value: unknown, depth: number, seen: Set<string>): TaskProgressRow | undefined {
	if (!isRecord(value) || !SEED_STATUSES.includes(value.status as SeedTaskStatus)) return undefined;
	const idKind = value.idKind === "local" || value.idKind === "owner"
		? value.idKind
		: value.idKind === undefined
			? "owner"
			: undefined;
	if (idKind === undefined) return undefined;
	const id = idKind === "local" ? value.localTaskId : value.ownerTaskId;
	const otherId = idKind === "local" ? value.ownerTaskId : value.localTaskId;
	if (!boundedString(id, MAX_SEED_TASK_ID_CHARS) || otherId !== undefined) return undefined;
	const logicalId = `${idKind}:${id}`;
	if (seen.has(logicalId)) return undefined;
	seen.add(logicalId);
	const status = value.status as SeedTaskStatus;
	const ref = isValidSeedRef(value.ref) ? value.ref : undefined;
	const candidateReason = value.reason;
	if (candidateReason !== undefined && (status !== "blocked" || !boundedString(candidateReason, MAX_SEED_NOTE_CHARS))) return undefined;
	const reason = status === "blocked" && typeof candidateReason === "string" ? candidateReason : undefined;
	let title: string | undefined;
	if (value.title !== undefined) {
		if (!boundedString(value.title, MAX_SEED_TITLE_CHARS)) return undefined;
		title = normalizeTaskProgressTitle(value.title);
		if (title === undefined) return undefined;
	}
	let subtasks: TaskProgressRow[] | undefined;
	if (value.subtasks !== undefined) {
		if (depth > 0 || !Array.isArray(value.subtasks) || value.subtasks.length > MAX_SEED_SUBTASKS) return undefined;
		subtasks = [];
		for (const child of value.subtasks) {
			const parsed = parseTaskProgressRow(child, depth + 1, seen);
			if (parsed === undefined) return undefined;
			subtasks.push(parsed);
		}
	}
	return {
		idKind,
		...(idKind === "local" ? { localTaskId: id } : { ownerTaskId: id }),
		...(ref === undefined ? {} : { ref }),
		...(title === undefined ? {} : { title }),
		status,
		...(reason === undefined ? {} : { reason }),
		...(subtasks === undefined || subtasks.length === 0 ? {} : { subtasks }),
	};
}

function parseTaskProgressRows(value: unknown): TaskProgressRow[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_SEED_TASKS) return undefined;
	const rows: TaskProgressRow[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const parsed = parseTaskProgressRow(candidate, 0, seen);
		if (parsed === undefined) return undefined;
		rows.push(parsed);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Reading a worker's list back
// ---------------------------------------------------------------------------

function parseSeededTask(value: unknown, depth: number): SeededTask | null {
	if (!isRecord(value)) return null;
	if (!boundedString(value.id, 64) || !boundedString(value.title, MAX_SEED_TITLE_CHARS)) return null;
	if (!SEED_STATUSES.includes(value.status as SeedTaskStatus)) return null;
	const origin = value.origin === "user" || value.origin === "spec" || value.origin === "agent" ? value.origin : "agent";
	const note = truncateSeedNote(value.note);
	const ref = isValidSeedRef(value.ref) ? value.ref : undefined;
	let subtasks: SeededTask[] | undefined;
	if (Array.isArray(value.subtasks) && depth < 1) {
		subtasks = [];
		for (const child of value.subtasks) {
			const parsed = parseSeededTask(child, depth + 1);
			if (parsed) subtasks.push(parsed);
		}
	}
	return {
		id: value.id,
		title: value.title,
		status: value.status as SeedTaskStatus,
		...(note === undefined ? {} : { note }),
		...(boundedString(value.ownerTaskId, MAX_SEED_TASK_ID_CHARS) ? { ownerTaskId: value.ownerTaskId } : {}),
		...(ref === undefined ? {} : { ref }),
		origin,
		...(subtasks === undefined || subtasks.length === 0 ? {} : { subtasks }),
	};
}

/**
 * Recover a worker's task list from its transcript entries.
 *
 * The highest revision wins, with a deterministic tie-break, so reading the
 * same transcript twice gives the same answer even on a fork where two
 * branches share a revision number.
 */
export function readSeededTasks(entries: readonly unknown[]): readonly SeededTask[] {
	let best: { revision: number; eventId: string; tasks: SeededTask[] } | undefined;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TASKS_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.tasks)) continue;
		const revision = typeof data.revision === "number" && Number.isSafeInteger(data.revision) ? data.revision : 0;
		if (revision <= 0) continue;
		const eventId = typeof data.eventId === "string" ? data.eventId : "";
		const tasks: SeededTask[] = [];
		let malformed = false;
		for (const candidate of data.tasks) {
			const parsed = parseSeededTask(candidate, 0);
			if (!parsed) {
				malformed = true;
				break;
			}
			tasks.push(parsed);
		}
		if (malformed) continue;
		if (best === undefined || revision > best.revision || (revision === best.revision && eventId > best.eventId)) {
			best = { revision, eventId, tasks };
		}
	}
	return best?.tasks ?? [];
}

/**
 * Progress fields for a worker's current list, or `undefined` when it has none.
 *
 * In-process runners merge these fields into the SAME `updated` message-end event
 * rather than sending a second event. Under `MAX_STEPS`, `applyBounds` retains the
 * latest ordinary update plus the latest task snapshots. Carrying progress on each
 * message-end keeps it current without an extra write; the detached bridge may
 * publish progress and its larger terminal ledger separately, and each keeps its
 * own latest bounded snapshot.
 */
export function taskProgressFieldsFromEntries(
	entries: readonly unknown[] | undefined,
): { readonly [TASK_PROGRESS_FIELD]: TaskProgressFields } | undefined {
	if (entries === undefined || entries.length === 0) return undefined;
	const tasks = readSeededTasks(entries);
	if (tasks.length === 0) return undefined;
	return {
		[TASK_PROGRESS_FIELD]: buildTaskProgressFields(
			countSeededTasks(tasks),
			taskProgressRows(tasks),
		),
	};
}

/** Build titled rows with explicit id markers and one supported nested level. */
export function taskProgressRows(tasks: readonly SeededTask[]): readonly TaskProgressRow[] {
	const buildRow = (task: SeededTask): TaskProgressRow => {
		const reason = task.status === "blocked" ? truncateSeedNote(task.note) : undefined;
		const subtasks = task.subtasks?.map(buildRow) ?? [];
		return task.ownerTaskId === undefined
			? {
				idKind: "local",
				localTaskId: task.id,
				...(task.ref === undefined ? {} : { ref: task.ref }),
				title: task.title,
				status: task.status,
				...(reason === undefined ? {} : { reason }),
				...(subtasks.length === 0 ? {} : { subtasks }),
			}
			: {
				idKind: "owner",
				ownerTaskId: task.ownerTaskId,
				...(task.ref === undefined ? {} : { ref: task.ref }),
				title: task.title,
				status: task.status,
				...(reason === undefined ? {} : { reason }),
				...(subtasks.length === 0 ? {} : { subtasks }),
			};
	};
	return tasks.map(buildRow);
}

/** Runtime-owned last attempt retained when a worker never reports. */
export interface TaskLastAttempt {
	readonly runId: string;
	readonly endState: string;
}

/** The owner-side shape needed for id-based, title-preserving reconciliation. */
export interface OwnerTaskRecord {
	readonly id: string;
	readonly title: string;
	readonly status: SeedTaskStatus;
	readonly delegation?: unknown;
	readonly lastAttempt?: TaskLastAttempt;
	readonly note?: string;
	readonly [key: string]: unknown;
}

/**
 * Apply a full worker snapshot in the runtime, never in model prose. Rows are
 * keyed by the carried owner id, so either side may reorder without changing
 * the result. A missing snapshot is an orphan: reset to pending, clear the
 * delegation reference, and retain the run id for investigation.
 */
export function reconcileTaskRows(
	tasks: readonly OwnerTaskRecord[],
	rows: readonly TaskProgressRow[] | undefined,
	attempt: TaskLastAttempt,
): OwnerTaskRecord[] {
	if (rows === undefined) {
		return tasks.map((task) => {
			const { delegation: _delegation, ...retryable } = task;
			return { ...retryable, status: "pending", lastAttempt: attempt };
		});
	}
	const byOwnerId = new Map(
		rows
			.filter((row) => (row.idKind ?? "owner") === "owner" && row.ownerTaskId !== undefined)
			.map((row) => [row.ownerTaskId!, row]),
	);
	return tasks.map((task) => {
		const row = byOwnerId.get(task.id);
		if (row === undefined) return task;
		return {
			...task,
			status: row.status,
			...(row.status === "blocked" && row.reason !== undefined ? { note: row.reason } : {}),
		};
	});
}

/** The per-task detail a collapsed result carries, so a gap is inspectable. */
export interface TaskLedger {
	readonly outcome: TaskOutcome;
	readonly counts: TaskCounts;
	readonly unfinished: readonly { readonly id: string; readonly title: string; readonly status: SeedTaskStatus; readonly note?: string; readonly ownerTaskId?: string; readonly ref?: string }[];
	/** Owner-addressed rows are also retained in the collapsed result. */
	readonly rows: readonly TaskProgressRow[];
}

/** Build the final ledger for a fork's collapsed result. */
export function buildTaskLedger(tasks: readonly SeededTask[]): TaskLedger | undefined {
	if (tasks.length === 0) return undefined;
	const counts = countSeededTasks(tasks);
	return {
		outcome: classifyTaskOutcome(counts),
		counts,
		rows: taskProgressRows(tasks),
		unfinished: tasks
			.filter((task) => task.status !== "done" && task.status !== "deferred")
			.map((task) => ({
				id: task.id,
				title: task.title,
				status: task.status,
				...(task.note === undefined ? {} : { note: task.note }),
				...(task.ownerTaskId === undefined ? {} : { ownerTaskId: task.ownerTaskId }),
				...(task.ref === undefined ? {} : { ref: task.ref }),
			})),
	};
}

/**
 * Build the ledger projection carried by detached task events.
 *
 * Full rows duplicate the owner-addressed progress snapshot. When the accepted
 * seed reaches the event payload bound, retain every unfinished item and status,
 * but omit reconstructible rows and bound human-readable titles and notes. The
 * terminal result remains a mechanically complete blocked/unfinished ledger
 * without triggering the event bus's whole-field truncation.
 */
export function buildTaskLedgerTransport(tasks: readonly SeededTask[]): TaskLedger | undefined {
	const ledger = buildTaskLedger(tasks);
	if (ledger === undefined || Buffer.byteLength(JSON.stringify(ledger), "utf8") <= MAX_TASK_PROGRESS_BYTES) return ledger;
	const withoutRows: TaskLedger = { ...ledger, rows: [] };
	if (Buffer.byteLength(JSON.stringify(withoutRows), "utf8") <= MAX_TASK_PROGRESS_BYTES) return withoutRows;

	// Preserve every task id and status. Bound only the human-readable title/note
	// fields, with a visible marker, so a maximal valid child snapshot remains a
	// complete mechanical ledger instead of triggering whole-event truncation.
	const largestTextBytes = withoutRows.unfinished.reduce(
		(max, item) => Math.max(
			max,
			Buffer.byteLength(item.title, "utf8"),
			item.note === undefined ? 0 : Buffer.byteLength(item.note, "utf8"),
		),
		0,
	);
	const best = maximizeTextWithinTaskProgressBudget(
		largestTextBytes,
		(textBytes): TaskLedger => ({
			...withoutRows,
			unfinished: withoutRows.unfinished.map((item) => ({
				...item,
				title: truncateTaskTextToBytes(item.title, textBytes) ?? TRUNCATION_MARKER,
				...(item.note === undefined
					? {}
					: { note: truncateTaskTextToBytes(item.note, textBytes) ?? TRUNCATION_MARKER }),
			})),
		}),
	);
	if (best !== undefined) return best;

	// Under the published task-count and identifier caps, marker-only details fit.
	// Throw if those contracts ever drift rather than silently dropping tasks.
	throw new Error(`task ledger transport cannot fit within ${MAX_TASK_PROGRESS_BYTES} bytes`);
}

/** Validate a task ledger read back from the detached event bus. */
export function parseTaskLedger(value: unknown): TaskLedger | undefined {
	if (!isRecord(value)) return undefined;
	const countsValue = value.counts;
	if (!isRecord(countsValue)) return undefined;
	const integer = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && (candidate as number) >= 0;
	if (!integer(countsValue.done) || !integer(countsValue.total) || !integer(countsValue.blocked) ||
		!integer(countsValue.pending) || !integer(countsValue.deferred)) return undefined;
	const total = countsValue.total;
	const categorized = countsValue.done + countsValue.blocked + countsValue.pending + countsValue.deferred;
	if (total === 0 || total > MAX_SEED_TASKS || categorized > total ||
		[countsValue.done, countsValue.blocked, countsValue.pending, countsValue.deferred]
			.some((count) => count > total)) return undefined;
	const active = countsValue.active === null
		? null
		: boundedString(countsValue.active, MAX_SEED_TITLE_CHARS)
			? countsValue.active as string
			: undefined;
	if (active === undefined) return undefined;
	const activeCount = total - categorized;
	if ((activeCount === 0) !== (active === null)) return undefined;
	const outcome = value.outcome === "complete" || value.outcome === "gap" || value.outcome === "stuck"
		? value.outcome
		: undefined;
	if (!outcome || !Array.isArray(value.unfinished) || value.unfinished.length > total) return undefined;
	const unfinished: TaskLedger["unfinished"][number][] = [];
	for (const item of value.unfinished) {
		if (!isRecord(item) || !boundedString(item.id, MAX_SEED_TASK_ID_CHARS) || !boundedString(item.title, MAX_SEED_TITLE_CHARS) ||
			(item.status !== "pending" && item.status !== "active" && item.status !== "blocked")) return undefined;
		const id = item.id;
		const title = item.title;
		const status = item.status as SeedTaskStatus;
		const note = item.note;
		const ownerTaskId = item.ownerTaskId;
		const ref = isValidSeedRef(item.ref) ? item.ref : undefined;
		if (note !== undefined && !boundedString(note, MAX_SEED_NOTE_CHARS)) return undefined;
		if (ownerTaskId !== undefined && !boundedString(ownerTaskId, MAX_SEED_TASK_ID_CHARS)) return undefined;
		unfinished.push({
			id,
			title,
			status,
			...(typeof note === "string" ? { note } : {}),
			...(typeof ownerTaskId === "string" ? { ownerTaskId } : {}),
			...(ref === undefined ? {} : { ref }),
		});
	}
	if (unfinished.length !== total - countsValue.done - countsValue.deferred) return undefined;
	const expectedOutcome: TaskOutcome = countsValue.blocked > 0
		? "stuck"
		: countsValue.done + countsValue.deferred >= total
			? "complete"
			: "gap";
	if (outcome !== expectedOutcome) return undefined;
	const rows = value.rows === undefined ? [] : parseTaskProgressRows(value.rows);
	if (rows === undefined) return undefined;
	return {
		outcome,
		counts: {
			done: countsValue.done,
			total: countsValue.total,
			active,
			blocked: countsValue.blocked,
			pending: countsValue.pending,
			deferred: countsValue.deferred,
		},
		unfinished,
		rows,
	};
}

/** The widget fragment for a fork's existing row, e.g. `☑2/5`. */
export function formatTaskProgress(progress: TaskProgressFields | undefined): string | undefined {
	if (progress === undefined || progress.total === 0) return undefined;
	const blocked = progress.blocked > 0 ? `⚠${progress.blocked}` : "";
	return `☑${progress.done}/${progress.total}${blocked}`;
}

export type { SeededTask };
