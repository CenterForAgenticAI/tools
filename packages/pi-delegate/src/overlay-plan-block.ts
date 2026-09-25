/**
 * The plan block: what a run entry's task list looks like from the overlay.
 *
 * ## Compact and expanded projections
 *
 * Everything here is bounded by `context-aware.tasks.v1`. The original version-1
 * row carried reconciliation ids, status, and a reason. Optional real titles and
 * one nested level are additive fields: old progress still parses, and old peers
 * can ignore the detail without losing the status snapshot.
 *
 * Compact mode keeps the established count, active title, blocked reason, and
 * status strip. Expanded mode names every title that actually crossed the seam
 * and reports titleless legacy rows as unavailable. It never turns an id into a
 * plausible-looking task name.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { boundActivityText } from "./activity-status.js";
import { iconSet, type IconName, type IconSet } from "./icons.js";
import type { SeedTaskStatus, TaskProgressFields, TaskProgressRow } from "./task-seam.js";

/** Which marker each task status draws. The glyphs themselves live in `icons.ts`. */
const STATUS_ICON: Readonly<Record<SeedTaskStatus, IconName>> = {
	done: "taskDone",
	active: "taskActive",
	blocked: "taskBlocked",
	deferred: "taskDeferred",
	pending: "taskPending",
};

/** Tone per status, resolved by the caller's theme. */
const STATUS_TONE: Readonly<Record<SeedTaskStatus, "accent" | "warning" | "dim">> = {
	done: "accent",
	active: "accent",
	blocked: "warning",
	deferred: "dim",
	pending: "dim",
};

/** Order the legend and any grouping follow: the shape of progress. */
const STATUS_ORDER: readonly SeedTaskStatus[] = [
	"done",
	"active",
	"blocked",
	"deferred",
	"pending",
];

/** One wire row projected for display without exposing reconciliation ids. */
export interface PlanTaskModel {
	readonly title?: string;
	readonly status: SeedTaskStatus;
	readonly reason?: string;
	readonly subtasks: readonly PlanTaskModel[];
}

/** What the plan block can say, once the seam limit is applied. */
export interface PlanBlockModel {
	readonly done: number;
	readonly total: number;
	readonly blocked: number;
	/** Aggregate title of the active top-level task, or null when none is active. */
	readonly active: string | null;
	/**
	 * The first reason given by a blocked row. `TaskProgressRow.reason` is
	 * required when a row is blocked or deferred, so this is the nearest thing
	 * to "why is the plan stuck" that reaches us.
	 */
	readonly blockedReason?: string;
	/** Per-task statuses, in the order the rows arrived. Empty when unsent. */
	readonly statuses: readonly SeedTaskStatus[];
	/** Titled rows and nested steps for expanded display; titles may be absent on legacy rows. */
	readonly tasks: readonly PlanTaskModel[];
	/** The worker's own verdict, when it sent one. */
	readonly outcome?: TaskProgressFields["outcome"];
}

function firstBlockedReason(rows: readonly TaskProgressRow[]): string | undefined {
	for (const row of rows) {
		if (row.status === "blocked" && row.reason !== undefined && row.reason !== "") {
			return row.reason;
		}
	}
	return undefined;
}

function projectTask(row: TaskProgressRow): PlanTaskModel {
	return {
		...(row.title === undefined ? {} : { title: row.title }),
		status: row.status,
		...(row.reason === undefined ? {} : { reason: row.reason }),
		subtasks: (row.subtasks ?? []).map(projectTask),
	};
}

/**
 * Project a run entry's task progress into what the overlay can show.
 *
 * Returns `undefined` when there is no plan to speak of. A run entry with zero
 * total tasks has not seeded a list, which is different from a list that is
 * empty, and neither earns a block that says "0/0".
 */
export function buildPlanBlock(
	progress: TaskProgressFields | undefined,
): PlanBlockModel | undefined {
	if (progress === undefined || progress.total === 0) return undefined;
	const rows = progress.rows ?? [];
	return {
		done: progress.done,
		total: progress.total,
		blocked: progress.blocked,
		active: progress.active,
		...(firstBlockedReason(rows) !== undefined
			? { blockedReason: firstBlockedReason(rows) }
			: {}),
		statuses: rows.map((row) => row.status),
		tasks: rows.map(projectTask),
		...(progress.outcome ? { outcome: progress.outcome } : {}),
	};
}

/**
 * The count chip: `☑3/7`, warning-coloured when anything is blocked.
 *
 * Deliberately identical in wording to `formatTaskChip` in
 * `overlay-list-render.ts` and `formatTaskProgressCount` in
 * `status-widget.ts`. The same fact must not read three ways depending on
 * which surface shows it.
 */
export function formatPlanCount(model: PlanBlockModel, marks: IconSet = iconSet("unicode")): string {
	// The ASCII tier spells `tasks` as a word, which needs a space after it;
	// every other marker is a single glyph that must stay flush against its
	// number. One rule, not one per tier.
	const count = `${marks.tasks}${marks.mode === "ascii" ? " " : ""}${model.done}/${model.total}`;
	if (model.blocked === 0) return count;
	return `${count} ${marks.warning}${model.blocked}`;
}

/** Render every titled row, retaining nesting and naming each status explicitly. */
export function renderExpandedTaskList(
	tasks: readonly PlanTaskModel[],
	width: number,
	theme: { fg(role: string, value: string): string },
	marks: IconSet = iconSet("unicode"),
): string[] {
	if (width < 1) return [];
	const lines: string[] = [];
	let unavailableTitles = 0;
	const renderRows = (rows: readonly PlanTaskModel[], depth: number): void => {
		for (const row of rows) {
			const title = row.title === undefined ? undefined : boundActivityText(row.title);
			if (title === undefined || title === "") {
				unavailableTitles += 1;
			} else {
				const indent = " ".repeat(Math.min(depth * 2, Math.max(0, width - 1)));
				const marker = theme.fg(
					STATUS_TONE[row.status],
					`${marks[STATUS_ICON[row.status]]} ${row.status}`,
				);
				const boundedReason = row.reason === undefined ? undefined : boundActivityText(row.reason);
				const reason = boundedReason === undefined || boundedReason === "" ? "" : ` — ${boundedReason}`;
				lines.push(...wrapTextWithAnsi(`${indent}${marker} · ${title}${reason}`, width));
			}
			renderRows(row.subtasks, depth + 1);
		}
	};
	renderRows(tasks, 0);
	if (unavailableTitles > 0) {
		const noun = unavailableTitles === 1 ? "task title" : "task titles";
		lines.push(...wrapTextWithAnsi(
			theme.fg("dim", `${unavailableTitles} ${noun} unavailable from progress`),
			width,
		));
	}
	return lines;
}

/**
 * The status strip: one glyph per task, wrapped to the available width.
 *
 * Returns an empty array when no rows crossed — the counts still rendered, and
 * a strip of nothing would imply the plan itself is empty.
 */
export function renderStatusStrip(
	statuses: readonly SeedTaskStatus[],
	width: number,
	theme: { fg(role: string, value: string): string },
	marks: IconSet = iconSet("unicode"),
): string[] {
	if (statuses.length === 0 || width < 1) return [];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const status of statuses) {
		const glyph = marks[STATUS_ICON[status]];
		const themed = theme.fg(STATUS_TONE[status], glyph);
		// Glyphs are separated by a space, so each costs its own width plus one
		// — except the first on a line.
		const cost = currentWidth === 0 ? visibleWidth(glyph) : visibleWidth(glyph) + 1;
		if (currentWidth + cost > width) {
			if (current !== "") lines.push(current);
			current = themed;
			currentWidth = visibleWidth(glyph);
			continue;
		}
		current = currentWidth === 0 ? themed : `${current} ${themed}`;
		currentWidth += cost;
	}
	if (current !== "") lines.push(current);
	return lines;
}

/** The legend explaining the strip, clipped to width. */
export function renderStatusLegend(
	statuses: readonly SeedTaskStatus[],
	width: number,
	marks: IconSet = iconSet("unicode"),
): string | undefined {
	if (statuses.length === 0) return undefined;
	const present = STATUS_ORDER.filter((status) => statuses.includes(status));
	if (present.length === 0) return undefined;
	const text = present
		.map((status) => `${marks[STATUS_ICON[status]]} ${status}`)
		.join("  ");
	return visibleWidth(text) > width ? truncateToWidth(text, width, "\u2026") : text;
}
