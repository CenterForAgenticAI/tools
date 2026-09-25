/**
 * The overlay's left-column inventory — one flat, selectable list of every
 * piece of delegate work in the session.
 *
 * This replaces the previous `digestSelections()` ordering, which knew only
 * about in-process runs. The explorer layout (epic #326) puts detached
 * `orchestrate` drivers in the same list under their own group, so the overlay
 * is one inventory rather than three layouts chosen by what happens to exist.
 *
 * Pure and total: no runtime reads, no clock, no rendering. The renderer turns
 * these rows into text; selection movement is arithmetic over the array.
 */

import type { DelegateDispatchState, RunLiveState } from "./runtime.js";
import { isUniformRunLive, type UniformRunStatus } from "./run-introspect.js";

/**
 * A group heading. Not selectable — moving the selection skips it, exactly as
 * the run headings did in the digest ordering.
 */
export interface OverlayGroupRow {
	readonly kind: "group";
	/** `run <id> · <shape> · N entries · 14:03`, or `detached · driver`. */
	readonly runId?: string;
	readonly shape?: string;
	readonly entryCount?: number;
	/** @deprecated Use entryCount; retained for compatibility. */
	readonly forkCount?: number;
	/**
	 * When `delegate` was called, as a wall-clock epoch.
	 *
	 * The run owns this, not the entry: it is the moment of the dispatch. A
	 * queued entry in a supervised batch starts later — sometimes much later —
	 * so a per-entry start time would answer a different question from "when did
	 * I ask for this".
	 */
	readonly createdAt?: number;
	/** Every entry completed cleanly; the run recedes. See `runIsFullyCompleted`. */
	readonly completed?: true;
	readonly detached?: true;
}

/** A live in-process run entry. */
export interface OverlayEntryRow {
	readonly kind: "entry";
	readonly runIndex: number;
	readonly entryIndex: number;
	readonly run: DelegateDispatchState;
	readonly entry: RunLiveState;
	/**
	 * This entry's run finished cleanly, so the row recedes with it.
	 *
	 * Carried per row rather than recomputed by the renderer: the rule is a
	 * property of the whole run, and a renderer deciding it per entry would grey
	 * a completed entry sitting beside one that is still running.
	 */
	readonly completed?: true;
}

/**
 * A registered run that has not created its first entry yet. Selectable but not
 * enterable, so a chain mid-registration is visible without being fabricated
 * into an entry that does not exist.
 */
export interface OverlayConstructingRow {
	readonly kind: "constructing";
	readonly runIndex: number;
	readonly run: DelegateDispatchState;
}

/** A detached driver, read from durable state in another process. */
export interface OverlayDetachedRow {
	readonly kind: "detached";
	readonly detachedIndex: number;
	readonly status: UniformRunStatus;
}

export type OverlayListRow =
	| OverlayGroupRow
	| OverlayEntryRow
	| OverlayConstructingRow
	| OverlayDetachedRow;

/** Which run outcomes the inventory includes. */
export const OVERLAY_VIEW_MODES = ["live", "attention", "all"] as const;
export type OverlayViewMode = (typeof OVERLAY_VIEW_MODES)[number];

/** Extra attention signal not represented by the terminal status itself. */
export type OverlayEntryNeedsAttention = (
	run: DelegateDispatchState,
	entry: RunLiveState,
) => boolean;

/** Cycle in display order: live → attention → all → live. */
export function nextOverlayViewMode(mode: OverlayViewMode): OverlayViewMode {
	const index = OVERLAY_VIEW_MODES.indexOf(mode);
	return OVERLAY_VIEW_MODES[(index + 1) % OVERLAY_VIEW_MODES.length]!;
}

const UNIFORM_ENTRY_STATE = {
	pending: "constructing",
	constructing: "constructing",
	running: "running",
	"awaiting-escalation": "running",
	completed: "terminal-done",
	failed: "terminal-failed",
	aborted: "terminal-failed",
	paused: "terminal-paused",
} as const satisfies Record<RunLiveState["status"], UniformRunStatus["state"]>;

/** Project an in-process entry onto the same status vocabulary as detached work. */
function uniformEntryStatus(
	run: DelegateDispatchState,
	entry: RunLiveState,
): UniformRunStatus {
	return {
		runId: run.runId,
		shape: run.shape ?? "unknown",
		state: UNIFORM_ENTRY_STATE[entry.status],
		source: "in-memory",
	};
}

function uniformStatusMatchesView(status: UniformRunStatus, mode: OverlayViewMode): boolean {
	if (mode === "all") return true;
	if (isUniformRunLive(status)) return true;
	return mode === "attention"
		&& (status.state === "terminal-failed" || status.state === "terminal-paused");
}

function entryMatchesView(
	run: DelegateDispatchState,
	entry: RunLiveState,
	mode: OverlayViewMode,
): boolean {
	return uniformStatusMatchesView(uniformEntryStatus(run, entry), mode);
}

/** Rows a selection may land on. A group heading is never one. */
export type SelectableRow = OverlayEntryRow | OverlayConstructingRow | OverlayDetachedRow;

export function isSelectable(row: OverlayListRow): row is SelectableRow {
	return row.kind !== "group";
}

/**
 * Whether `Enter` has somewhere to go from this row.
 *
 * A constructing run has no entry to open. A detached run does open, onto its
 * status card — which is the deepest level it has here, because the detail
 * pane would otherwise show an unrelated entry's transcript under a detached
 * run's header. Giving it a real event log is stage 3.
 */
export function isEnterable(row: SelectableRow): boolean {
	return row.kind !== "constructing";
}

/**
 * Has this run finished cleanly, with every entry completed?
 *
 * Drives the recede-to-grey rule on every surface that lists delegate work.
 * Work that is done and went well has nothing left to tell you, so it steps
 * back and leaves the contrast for whatever is still running.
 *
 * ## Why `completed` and not "terminal"
 *
 * `failed`, `aborted`, and `paused` are terminal too, and a rule written as
 * "every entry is terminal" would dim them — which is precisely backwards. A
 * failure is the row you most need to see, and it does not become less
 * important by virtue of having stopped moving. Only a clean success earns the
 * right to recede.
 *
 * A run with no entries yet is still constructing, not finished, so it does not
 * grey: `every` over an empty list is vacuously true and would say otherwise.
 */
export function runIsFullyCompleted(run: DelegateDispatchState): boolean {
	const entries = Object.values(run.forks);
	if (entries.length === 0) return false;
	return entries.every((entry) => entry.status === "completed");
}

/**
 * Order runs by when `delegate` was called, oldest first.
 *
 * ## Why this is a sort and not the registry order it usually matches
 *
 * The list used to take `listRuns()` as it came, which is `Map` insertion
 * order. That *usually* reads as dispatch order, and it was never guaranteed
 * to: runs hydrated from a previous session are inserted ahead of this
 * session's work regardless of age, and a run that is deleted and re-added
 * moves to the end of the map. Nothing pinned it, so nothing would have
 * noticed it drifting.
 *
 * Ties keep the order they arrived in. `Array.prototype.sort` is specified as
 * stable, so returning `0` preserves registry insertion order — and for two
 * runs dispatched in the same millisecond that order *is* the dispatch order,
 * which is exactly what this function claims to produce. Breaking the tie on
 * `runId` instead would sort them alphabetically, replacing a true ordering
 * with an arbitrary one.
 */
export function sortRunsByDispatch(runs: readonly DelegateDispatchState[]): DelegateDispatchState[] {
	return [...runs].sort((left, right) => {
		// A run with no timestamp cannot be placed by age. Sorting it to the end
		// keeps it visible and out of the way; treating a missing value as 0
		// would claim it was the very first dispatch of the session.
		const leftAt = Number.isFinite(left.createdAt) ? left.createdAt : Number.POSITIVE_INFINITY;
		const rightAt = Number.isFinite(right.createdAt) ? right.createdAt : Number.POSITIVE_INFINITY;
		return leftAt - rightAt;
	});
}

/**
 * Order detached drivers by when they started, oldest first.
 *
 * Detached runs previously sorted live-first and then *newest* first, which
 * put one block of the same list in the opposite order from the rest of it.
 * They follow the same rule as everything else now. `startedAt` is the nearest
 * thing a detached run has to a dispatch time; `lastActivityAt` stands in when
 * a driver reported activity before it reported a start.
 *
 * Ties keep their arrival order, for the same reason as `sortRunsByDispatch`.
 */
export function sortDetachedByDispatch(
	detached: readonly UniformRunStatus[],
): UniformRunStatus[] {
	return [...detached].sort((left, right) => {
		const leftAt = left.startedAt ?? left.lastActivityAt ?? Number.POSITIVE_INFINITY;
		const rightAt = right.startedAt ?? right.lastActivityAt ?? Number.POSITIVE_INFINITY;
		return leftAt - rightAt;
	});
}

/**
 * Build the inventory. In-process runs first in dispatch order, each preceded
 * by its group heading; detached drivers last under one `detached` heading.
 *
 * Run groups stay contiguous, so moving down the list never jumps between runs
 * and back again.
 *
 * Takes `runs` already ordered, and does not sort: `OverlayEntryRow.runIndex`
 * indexes the caller's array, so ordering here would desync every row from the
 * array the overlay resolves it against. Callers order with
 * `sortRunsByDispatch` / `sortDetachedByDispatch` before they store the array.
 */
export function buildOverlayList(
	runs: readonly DelegateDispatchState[],
	detached: readonly UniformRunStatus[] = [],
	viewMode: OverlayViewMode = "all",
	entryNeedsAttention?: OverlayEntryNeedsAttention,
): OverlayListRow[] {
	const rows: OverlayListRow[] = [];
	for (const [runIndex, run] of runs.entries()) {
		const entries = Object.values(run.forks);
		if (entries.length === 0) {
			rows.push({
				kind: "group",
				runId: run.runId,
				shape: run.shape ?? "unknown",
				entryCount: 0,
				/** @deprecated Use entryCount; retained for compatibility. */
				forkCount: 0,
				...(Number.isFinite(run.createdAt) ? { createdAt: run.createdAt } : {}),
			});
			rows.push({ kind: "constructing", runIndex, run });
			continue;
		}

		const visibleEntries = entries
			.map((entry, entryIndex) => ({ entry, entryIndex }))
			.filter(({ entry }) =>
				entryMatchesView(run, entry, viewMode)
				|| (viewMode === "attention" && entryNeedsAttention?.(run, entry) === true),
			);
		if (visibleEntries.length === 0) continue;

		// Decided once per run and stamped on every row it owns, so the heading
		// and its entries can never disagree about whether the run is finished.
		const completed = runIsFullyCompleted(run);
		rows.push({
			kind: "group",
			runId: run.runId,
			shape: run.shape ?? "unknown",
			entryCount: visibleEntries.length,
			/** @deprecated Use entryCount; retained for compatibility. */
			forkCount: visibleEntries.length,
			...(Number.isFinite(run.createdAt) ? { createdAt: run.createdAt } : {}),
			...(completed ? { completed: true as const } : {}),
		});
		for (const { entry, entryIndex } of visibleEntries) {
			rows.push({
				kind: "entry",
				runIndex,
				entryIndex,
				run,
				entry,
				...(completed ? { completed: true as const } : {}),
			});
		}
	}
	const visibleDetached = detached
		.map((status, detachedIndex) => ({ status, detachedIndex }))
		.filter(({ status }) => uniformStatusMatchesView(status, viewMode));
	if (visibleDetached.length > 0) {
		rows.push({ kind: "group", detached: true });
		for (const { status, detachedIndex } of visibleDetached) {
			rows.push({ kind: "detached", detachedIndex, status });
		}
	}
	return rows;
}

/** Indices of every selectable row, in list order. */
export function selectableIndices(rows: readonly OverlayListRow[]): number[] {
	const out: number[] = [];
	for (const [index, row] of rows.entries()) if (isSelectable(row)) out.push(index);
	return out;
}

/**
 * Move the selection by `delta` selectable rows, clamping at both ends.
 *
 * Deliberately clamps rather than wrapping: the previous design wrapped entry
 * navigation, which in a list that now holds every run plus detached drivers
 * would silently teleport you from the last detached row to the first entry of
 * the first run. Returns `undefined` when nothing is selectable.
 */
export function moveSelection(
	rows: readonly OverlayListRow[],
	current: number,
	delta: number,
): number | undefined {
	const indices = selectableIndices(rows);
	if (indices.length === 0) return undefined;
	const position = indices.indexOf(current);
	if (position < 0) {
		// Current selection is stale (its row vanished): land on the nearest
		// selectable row at or after it rather than jumping to the top.
		const next = indices.find((index) => index >= current);
		return next ?? indices[indices.length - 1];
	}
	const target = Math.max(0, Math.min(indices.length - 1, position + delta));
	return indices[target];
}

/** First selectable row, or `undefined` when the list holds none. */
export function firstSelectable(rows: readonly OverlayListRow[]): number | undefined {
	return selectableIndices(rows)[0];
}

/** Last selectable row, or `undefined` when the list holds none. */
export function lastSelectable(rows: readonly OverlayListRow[]): number | undefined {
	const indices = selectableIndices(rows);
	return indices[indices.length - 1];
}

/**
 * Re-find a previously selected row after the list is rebuilt.
 *
 * Foreground rows keep the registration object as the run incarnation and the
 * entry name as the stable identity within it. Entry objects may be replaced by
 * canonical state updates; a new registration reusing the same IDs is different work.
 * Returns `undefined` when the row is gone, leaving the caller to clamp.
 */
export function findRow(
	rows: readonly OverlayListRow[],
	target: SelectableRow | undefined,
): number | undefined {
	if (target === undefined) return undefined;
	for (const [index, row] of rows.entries()) {
		if (row.kind !== target.kind) continue;
		if (row.kind === "entry" && target.kind === "entry") {
			if (row.run === target.run && row.entry.name === target.entry.name) return index;
			continue;
		}
		if (row.kind === "constructing" && target.kind === "constructing") {
			if (row.run === target.run) return index;
			continue;
		}
		if (row.kind === "detached" && target.kind === "detached") {
			if (row.status.runId === target.status.runId) return index;
		}
	}
	return undefined;
}
