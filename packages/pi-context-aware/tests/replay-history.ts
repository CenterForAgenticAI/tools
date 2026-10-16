/**
 * Generated session branches for long-history replay tests and
 * `npm run bench:replay`.
 *
 * Entries have the shape Pi persists on a branch: focus and task snapshots are
 * `custom` entries, and everything else is an ordinary message. Entry
 * timestamps advance one second per position, so transcript chronology follows
 * array order unless a caller supplies its own timestamp.
 */

import { createWorkstreamSnapshot, workstreamEntry } from "../src/workstream/workstream-state.js";
import type { WorkstreamProvenance } from "../src/workstream/workstream-schema.js";
import { TASKS_ENTRY_TYPE, createTasksSnapshot, type Task } from "../src/session-tasks/session-tasks.js";

/** Earlier than any wall clock a test runs under, so live mutations stay later. */
export const HISTORY_EPOCH_MS = Date.parse("2025-01-01T00:00:00.000Z");

export function historyTime(position: number): string {
	return new Date(HISTORY_EPOCH_MS + position * 1_000).toISOString();
}

export interface FocusEntryOptions {
	readonly workstreamId: string;
	readonly piSessionId: string;
	readonly objective: string;
	readonly entryId: string;
	readonly timestamp: string;
	readonly createdAt: string;
	readonly updatedAt?: string;
	readonly provenance?: WorkstreamProvenance;
	/** Production links every mutation to its predecessor. Omit for a legacy entry. */
	readonly previousEventId?: string;
}

/** One focus snapshot entry, validated by the same builders production uses. */
export function focusEntry(revision: number, eventId: string, options: FocusEntryOptions): unknown {
	const created = createWorkstreamSnapshot({
		workstreamId: options.workstreamId,
		piSessionId: options.piSessionId,
		revision,
		eventId,
		objective: options.objective,
		now: options.createdAt,
		...(options.provenance === undefined ? {} : { provenance: options.provenance }),
	});
	const snapshot = { ...created, updatedAt: options.updatedAt ?? options.createdAt };
	return workstreamEntry(snapshot, {
		entryId: options.entryId,
		timestamp: options.timestamp,
		...(options.previousEventId === undefined ? {} : { priorRevision: revision - 1, previousEventId: options.previousEventId }),
	});
}

export interface FocusChainOptions {
	readonly workstreamId?: string;
	readonly piSessionId?: string;
	readonly eventPrefix?: string;
	/** Legacy entries carry no predecessor ID, so replay must search for one. */
	readonly linked?: boolean;
	readonly objective?: (revision: number) => string;
}

/** A single valid focus chain of `length` revisions, as one session writes it. */
export function focusChain(length: number, options: FocusChainOptions = {}): unknown[] {
	const prefix = options.eventPrefix ?? "focus";
	const entries: unknown[] = [];
	for (let revision = 1; revision <= length; revision += 1) {
		entries.push(focusEntry(revision, `${prefix}-${revision}`, {
			workstreamId: options.workstreamId ?? "ws-history",
			piSessionId: options.piSessionId ?? "pi-history",
			objective: options.objective?.(revision) ?? `objective revision ${revision}`,
			entryId: `${prefix}-entry-${revision}`,
			timestamp: historyTime(revision),
			createdAt: historyTime(revision),
			...(options.linked === false || revision === 1 ? {} : { previousEventId: `${prefix}-${revision - 1}` }),
		}));
	}
	return entries;
}

export interface TasksEntryOptions {
	readonly piSessionId?: string;
	readonly entryId: string;
	readonly timestamp: string;
}

/** One task snapshot entry holding a complete list. */
export function tasksEntry(revision: number, tasks: readonly Task[], options: TasksEntryOptions): unknown {
	const snapshot = createTasksSnapshot({
		piSessionId: options.piSessionId ?? "pi-history",
		tasks,
		revision,
		eventId: `${options.entryId}-event`,
		createdAt: historyTime(0),
		now: options.timestamp,
	});
	return { type: "custom", id: options.entryId, parentId: null, timestamp: options.timestamp, customType: TASKS_ENTRY_TYPE, data: snapshot };
}

/** A task list history of `length` revisions, each a complete list. */
export function tasksHistory(length: number, tasksAt: (revision: number) => readonly Task[], piSessionId?: string): unknown[] {
	const entries: unknown[] = [];
	for (let revision = 1; revision <= length; revision += 1) {
		entries.push(tasksEntry(revision, tasksAt(revision), {
			...(piSessionId === undefined ? {} : { piSessionId }),
			entryId: `tasks-entry-${revision}`,
			timestamp: historyTime(revision),
		}));
	}
	return entries;
}

export function ordinaryMessage(position: number): unknown {
	return {
		type: "message",
		id: `message-${position}`,
		parentId: null,
		timestamp: historyTime(position),
		message: { role: "user", content: [{ type: "text", text: `ordinary message ${position}` }] },
	};
}

/**
 * Mostly ordinary messages with state entries spread through them: one focus
 * revision every `stateEvery` positions and one task revision offset from it.
 */
export function sparseHistory(total: number, stateEvery: number, tasks: readonly Task[]): unknown[] {
	const entries: unknown[] = [];
	let focusRevision = 0;
	let tasksRevision = 0;
	for (let position = 1; position <= total; position += 1) {
		if (position % stateEvery === 0) {
			focusRevision += 1;
			entries.push(focusEntry(focusRevision, `sparse-focus-${focusRevision}`, {
				workstreamId: "ws-history",
				piSessionId: "pi-history",
				objective: `objective revision ${focusRevision}`,
				entryId: `sparse-focus-entry-${focusRevision}`,
				timestamp: historyTime(position),
				createdAt: historyTime(position),
				...(focusRevision === 1 ? {} : { previousEventId: `sparse-focus-${focusRevision - 1}` }),
			}));
		} else if (position % stateEvery === Math.floor(stateEvery / 2)) {
			tasksRevision += 1;
			entries.push(tasksEntry(tasksRevision, tasks, { entryId: `sparse-tasks-entry-${tasksRevision}`, timestamp: historyTime(position) }));
		} else {
			entries.push(ordinaryMessage(position));
		}
	}
	return entries;
}

/**
 * `levels` revisions of legacy focus entries, `width` per revision after the
 * root, none naming its predecessor. Creation times overlap between adjacent
 * revisions, so each entry can follow only some of the previous revision. The
 * last entry of each revision is created after all of the previous one, which
 * keeps every revision reachable. A fixed linear congruential generator keeps
 * the history reproducible.
 */
export function competingLegacyHistory(levels: number, width: number, seed = 148): unknown[] {
	let state = seed >>> 0;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
	const step = 10;
	const spread = 25;
	const entries: unknown[] = [];
	let position = 0;
	entries.push(focusEntry(1, "legacy-1-0", {
		workstreamId: "ws-history",
		piSessionId: "pi-history",
		objective: "legacy revision 1",
		entryId: "legacy-entry-1-0",
		timestamp: historyTime(position),
		createdAt: historyTime(0),
	}));
	for (let revision = 2; revision <= levels; revision += 1) {
		for (let slot = 0; slot < width; slot += 1) {
			position += 1;
			// Creation order within a revision is random against entry order.
			const offset = slot === width - 1 ? spread : Math.floor(next() * spread);
			entries.push(focusEntry(revision, `legacy-${revision}-${slot}`, {
				workstreamId: "ws-history",
				piSessionId: "pi-history",
				objective: `legacy revision ${revision} slot ${slot}`,
				entryId: `legacy-entry-${revision}-${slot}`,
				timestamp: historyTime(position),
				createdAt: historyTime(revision * step + offset),
			}));
		}
	}
	return entries;
}
