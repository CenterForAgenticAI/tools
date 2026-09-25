/**
 * Render the overlay's left column to width-bounded text.
 *
 * Two lines per entry, matching the below-editor status widget: identity with a
 * task chip, then the live activity headline. The widget already decided what an
 * entry looks like at a glance; the overlay adopts that rather than inventing
 * a second vocabulary for the same fact.
 *
 * Every function here guarantees `visibleWidth(line) <= width` for any width
 * and any input. A two-pane layout multiplies width decisions, and pi-tui's
 * `Render.draw` hard-asserts on an over-wide line, so the guarantee is pinned
 * by test rather than assumed.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { iconSet, type IconSet } from "./icons.js";
import { boundActivityText } from "./activity-status.js";
import { renderRunEntryIdentity } from "./fork-label.js";
import { formatUniformRunStatus } from "./run-introspect.js";
import type { RunLiveState } from "./runtime.js";
import { getDelegatePresentationTerminology } from "./footer-presentation.js";
import type { OverlayListRow, SelectableRow } from "./overlay-list-model.js";

/** Colour roles used by the list column, mapped onto the theme by the caller. */
export type ListTone = "text" | "dim" | "accent" | "warning" | "success" | "error";

export interface ListTheme {
	fg(role: string, text: string): string;
}

/** Indent for a row's second line, aligning under the identity text. */
const CONTINUATION_INDENT = "    ";

/**
 * Narrowest width at which a row renders anything meaningful. Below this the
 * column emits nothing rather than a column of ellipses.
 */
export const MIN_LIST_ROW_WIDTH = 8;

/**
 * `☑3/7`, warning-marked when anything is blocked.
 *
 * Deliberately the same shape as `formatTaskProgressCount` in
 * `status-widget.ts` and `formatPlanCount` in `overlay-plan-block.ts`: the
 * same fact should not read three ways depending on which surface shows it.
 *
 * The ASCII tier spells the word rather than drawing a marker, so it needs a
 * separator the glyph tiers do not. That is why the vocabulary carries its own
 * tier — the difference is a different string, not a different character.
 */
export function formatTaskChip(
	progress: RunLiveState["taskProgress"],
	marks: IconSet = iconSet("unicode"),
): string | undefined {
	if (progress === undefined || progress.total === 0) return undefined;
	// The ASCII tier spells `tasks` as a word, which needs a space after it;
	// every other marker is a single glyph that must stay flush against its
	// number. One rule, not one per tier.
	const count = `${marks.tasks}${marks.mode === "ascii" ? " " : ""}${progress.done}/${progress.total}`;
	if (progress.blocked === 0) return count;
	return `${count} ${marks.warning}${progress.blocked}`;
}

/**
 * Round counter for the list, or `undefined` when it would say nothing.
 *
 * Only a supervised fork has rounds worth counting; `1/1` on a direct entry is
 * noise the previous entry list already knew to suppress.
 */
export function formatRoundChip(
	entry: RunLiveState,
	shape: string | undefined,
): string | undefined {
	if (shape !== "supervised") return undefined;
	return `${entry.currentRound}/${entry.maxRounds}`;
}

/** Pad or clip `text` to exactly `width` cells. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * The activity headline shown under an entry.
 *
 * Lifecycle truth outranks a generated sentence: an entry that is paused or
 * awaiting escalation says so, because a stale headline from before it stopped
 * would actively mislead. Only a live entry shows prose.
 */
export function activityLineFor(
	entry: RunLiveState,
	headline: string | undefined,
): { text: string; tone: ListTone } | undefined {
	if (entry.status === "awaiting-escalation") {
		return { text: "awaiting escalation", tone: "warning" };
	}
	if (entry.status === "paused") return { text: "paused at max rounds", tone: "warning" };
	if (entry.status === "failed") return { text: "failed", tone: "error" };
	if (entry.status === "aborted") return { text: "aborted", tone: "warning" };
	const bounded = headline === undefined ? "" : boundActivityText(headline);
	if (bounded.length === 0) return undefined;
	return { text: bounded, tone: "dim" };
}

export interface ListRowLines {
	/** First rendered line owned by the selected row. */
	readonly selectedLine?: number;
	/** Last rendered line owned by the selected row, inclusive. */
	readonly selectedLastLine?: number;
	readonly lines: string[];
	readonly dense?: boolean;
}

export interface RenderListOptions {
	readonly width: number;
	readonly theme: ListTheme;
	/** Index into `rows` currently selected. */
	readonly selected: number;
	/** Whether the list pane owns keyboard focus, which brightens the marker. */
	readonly focused: boolean;
	/** Live activity headline per entry, keyed `runId\u0000forkName`. */
	readonly headlines?: ReadonlyMap<string, string>;
	/** Status glyph for an entry, supplied by the renderer that owns the theme. */
	readonly glyph: (entry: RunLiveState) => string;
	/** Status glyph for a detached run. */
	readonly detachedGlyph: (row: Extract<OverlayListRow, { kind: "detached" }>) => string;
	readonly nowMs: number;
	/**
	 * Marker vocabulary. Defaults to `unicode`, which is what this column drew
	 * before the setting reached it.
	 */
	readonly icons?: IconSet;
	/**
	 * Drop everything that is decoration rather than identity.
	 *
	 * A dense column loses the blank line between runs and the generated
	 * activity headline under each entry, which roughly halves its height.
	 *
	 * Two things keep their second line. The selected row, because that is the
	 * entry you are reading and one row is cheaper than opening it to find out
	 * what it is doing. And any row whose second line reports lifecycle —
	 * `paused`, `failed`, `aborted`, `awaiting escalation` — because the
	 * identity line's glyph does not distinguish those from `running`, so
	 * dropping it would hide a blocked worker in the crowded list that most
	 * needs it seen.
	 *
	 * Callers do not set this by taste. `renderListColumnFitted` turns it on
	 * only when the full column does not fit the viewport it was given.
	 */
	readonly dense?: boolean;
}

export function headlineKey(runId: string, forkName: string): string {
	return `${runId}\u0000${forkName}`;
}

/**
 * Render the whole column.
 *
 * Group headings are blank-line separated so runs read as blocks; the leading
 * blank is suppressed so the column does not start with an empty row. In dense
 * mode the separator goes: with enough runs to overflow the viewport, a blank
 * row per run is a row of inventory you cannot see.
 */
export function renderListColumn(
	rows: readonly OverlayListRow[],
	options: RenderListOptions,
): ListRowLines {
	const { width, theme } = options;
	if (width < MIN_LIST_ROW_WIDTH) return { lines: [] };
	const dense = options.dense === true;
	const lines: string[] = [];
	let selectedLine: number | undefined;
	let selectedLastLine: number | undefined;

	for (const [index, row] of rows.entries()) {
		if (row.kind === "group") {
			if (lines.length > 0 && !dense) lines.push(fit("", width));
			// A run that finished cleanly recedes to dim; anything still running
			// — or finished badly — keeps the accent.
			lines.push(fit(
				theme.fg(row.completed === true ? "dim" : "accent", ` ${groupHeadingText(row)}`),
				width,
			));
			continue;
		}
		const selected = index === options.selected;
		if (selected) selectedLine = lines.length;
		for (const line of renderSelectableRow(row, selected, options)) lines.push(line);
		if (selected) selectedLastLine = lines.length - 1;
	}

	const base = selectedLine === undefined || selectedLastLine === undefined
		? { lines }
		: { lines, selectedLine, selectedLastLine };
	return dense ? { ...base, dense: true } : base;
}

/**
 * Render the column to fit `viewportRows`, falling back to dense rows.
 *
 * Scrolling already reaches every row, but a list that overflows by a factor of
 * three is one you navigate blind. Dropping the decoration first is cheaper
 * than making the operator scroll past it, so density is a response to the
 * viewport rather than a preference to be set.
 *
 * Dense is not guaranteed to fit either — thirty runs will overflow any
 * terminal. It is the best the column can do before scrolling has to take over,
 * which is why this returns whatever it produced rather than a success flag.
 *
 * A non-positive or non-finite `viewportRows` means "height unknown", and
 * renders full: guessing dense from a height nobody measured would strip
 * information from a column that had room for it.
 */
export function renderListColumnFitted(
	rows: readonly OverlayListRow[],
	options: RenderListOptions,
	viewportRows: number,
): ListRowLines {
	const full = renderListColumn(rows, { ...options, dense: false });
	if (!Number.isFinite(viewportRows) || viewportRows <= 0) return full;
	if (full.lines.length <= viewportRows) return full;
	return renderListColumn(rows, { ...options, dense: true });
}

/** `HH:MM` for a dispatch time, or nothing when the run carries none. */
function formatDispatchClock(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `run a1b2 · supervised · 2 forks · 14:03`, or `detached · driver`.
 *
 * The clock is the time `delegate` was called. Minutes, not seconds: the list
 * column is 28–44 cells wide and `fit` clips the heading to it, so the three
 * cells `:SS` would cost come off the run id.
 *
 * It is last because it is the part that can be lost. Everything before it
 * identifies *which* run this is; the timestamp says when, which is the first
 * thing worth dropping at a narrow width.
 */
export function groupHeadingText(row: Extract<OverlayListRow, { kind: "group" }>): string {
	if (row.detached === true) return "detached · driver";
	const count = row.entryCount ?? row.forkCount ?? 0;
	const terminology = getDelegatePresentationTerminology(row.shape);
	const entries = count === 1 ? terminology.singular : terminology.plural;
	const clock = formatDispatchClock(row.createdAt);
	const base = `run ${boundActivityText(row.runId ?? "")} · ${terminology.label} · ${count} ${entries}`;
	return clock === undefined ? base : `${base} · ${clock}`;
}

function renderSelectableRow(
	row: SelectableRow,
	selected: boolean,
	options: RenderListOptions,
): string[] {
	const { width, theme } = options;
	const marks = options.icons ?? iconSet("unicode");
	const marker = selected
		? theme.fg(options.focused ? "accent" : "dim", marks.selected)
		: " ";

	if (row.kind === "constructing") {
		const terminology = getDelegatePresentationTerminology(row.run.shape);
		return [fit(`${marker} ${theme.fg("dim", `${marks.constructing} constructing ${terminology.singular}`)}`, width)];
	}

	// A dense column keeps the second line for the selected row, and for any
	// row whose second line is lifecycle truth rather than a generated
	// headline. Identity is what a list is for; prose is what you read once you
	// have chosen one.
	const secondLine = options.dense !== true || selected;

	if (row.kind === "detached") {
		const glyph = options.detachedGlyph(row);
		const summary = boundActivityText(formatUniformRunStatus(row.status, options.nowMs));
		const identityLine = fit(`${marker} ${glyph} ${row.status.runId}`, width);
		if (!secondLine) return [identityLine];
		return [
			identityLine,
			fit(theme.fg("dim", `${CONTINUATION_INDENT}${summary}`), width),
		];
	}

	const glyph = options.glyph(row.entry);
	const identity = renderRunEntryIdentity(row.entry);
	const chips = [
		formatRoundChip(row.entry, row.run.shape),
		formatTaskChip(row.entry.taskProgress, marks),
	].filter((chip): chip is string => chip !== undefined);
	const blocked = (row.entry.taskProgress?.blocked ?? 0) > 0;
	const chipText = chips.length > 0
		? ` ${theme.fg(blocked ? "warning" : "dim", chips.join(" "))}`
		: "";
	// The identity dims with its run. The glyph keeps its own colour either
	// way: it is the one cue of outcome, and a run of grey rows with no green
	// tick would say "finished" without saying it went well.
	const identityTone = row.completed === true ? "dim" : "text";
	const identityLine = fit(
		`${marker} ${glyph} ${theme.fg(identityTone, identity)}${chipText}`,
		width,
	);

	const activity = activityLineFor(
		row.entry,
		options.headlines?.get(headlineKey(row.run.runId, row.entry.name)),
	);
	if (activity === undefined) return [identityLine];
	// Dense drops the generated headline, never lifecycle truth. `paused`,
	// `failed`, `aborted`, and `awaiting-escalation` all render the same glyph
	// as `running` on the identity line, so dropping their line would hide a
	// blocked worker in exactly the crowded list that needs it seen.
	if (!secondLine && activity.tone === "dim") return [identityLine];
	return [
		identityLine,
		fit(theme.fg(activity.tone, `${CONTINUATION_INDENT}${activity.text}`), width),
	];
}
