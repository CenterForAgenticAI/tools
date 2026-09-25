/**
 * Detached run event log — the deepest level a detached `orchestrate` row has.
 *
 * A detached driver is another process. We hold no transcript for it and must
 * not invent one: issue #53 fixed a version of this surface that fabricated
 * detached drivers as transcript entries, and the README's honesty rule came out
 * of that. What we *do* hold is the status bus — a timestamped append-only
 * record of what the child announced about itself.
 *
 * So this module renders **events, not a transcript**: timestamped records with
 * no speaker headings and no chat framing, explicitly labelled as an event log
 * in the UI. The distinction is not cosmetic. A transcript implies we can see
 * what the agent said; an event log claims only that the process reported these
 * moments, which is all we can honestly stand behind.
 *
 * Every field crossing into a row passes an allow-list, mirroring
 * `formatUniformRunStatus`'s `safeCategorical`. A bus event's `fields` is
 * free-form and emitter-controlled, so nothing is rendered because it happened
 * to be present — only because it was named here.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { BusEventKind } from "./event-bus.js";
import type { RunEventRecord } from "./run-introspect.js";

/**
 * One rendered event-log row.
 *
 * Structurally the redacted record `run-introspect` hands over: this module
 * renders what that boundary already allow-listed rather than re-deriving it
 * from a raw bus event.
 */
export type EventLogRow = RunEventRecord;

/** A detached run's event log, plus what we know about its completeness. */
export interface EventLogModel {
	readonly rows: readonly EventLogRow[];
	/**
	 * True when the underlying tail was truncated, so the oldest events are
	 * missing. Surfaced rather than hidden: a log that silently drops its
	 * beginning is worse than one that admits it.
	 */
	readonly truncated: boolean;
	/**
	 * Total events, when genuinely known. Absent means "unknown", which is not
	 * the same as "equal to the rows we kept".
	 */
	readonly totalCount?: number;
}

/**
 * Order the redacted records for display.
 *
 * Oldest-first by timestamp. The bus is append-only, but a crash-recovery
 * generation can interleave, so order is imposed rather than assumed.
 *
 * `totalCount` is only meaningful when the caller actually knows the total.
 * Defaulting it to the retained row count made a truncated log print
 * "oldest events dropped · showing 4 of 4", claiming in one breath that events
 * were omitted and that all of them are shown (OV3-EVENT-TRUNCATION). It is
 * left undefined unless supplied.
 */
export function buildEventLog(
	events: readonly RunEventRecord[] | undefined,
	options: {
		readonly truncated?: boolean;
		readonly totalCount?: number;
	} = {},
): EventLogModel {
	const rows = [...(events ?? [])].sort((a, b) => a.ts - b.ts);
	return {
		rows,
		truncated: options.truncated ?? false,
		...(options.totalCount === undefined ? {} : { totalCount: options.totalCount }),
	};
}


/** Row prefix by kind: a coarse glyph so the eye can find lifecycle moments. */
const KIND_GLYPH: Readonly<Record<BusEventKind, string>> = {
	started: "\u25b8",
	updated: "\u00b7",
	completed: "\u25c6",
};

/** Tone for each kind, resolved by the caller's theme. */
const KIND_TONE: Readonly<Record<BusEventKind, "accent" | "dim" | "text">> = {
	started: "accent",
	updated: "dim",
	completed: "accent",
};

/**
 * Render one event as a single line: clock, glyph, then the bounded facts.
 *
 * No speaker, no quoted content, no wrapping — an event is one record and a
 * record that needs two lines is a record carrying more than it should.
 */
export function renderEventRow(
	row: EventLogRow,
	width: number,
	theme: { fg(role: string, value: string): string },
	formatClockFn: (ms: number) => string,
): string {
	const dim = (value: string) => theme.fg("dim", value);
	const parts: string[] = [];
	// The phase is the most useful single word; the kind is the fallback when
	// the emitter reported a phase we do not recognise.
	parts.push(row.phase ?? row.kind);
	if (row.outcome) parts.push(row.outcome);
	if (row.tools !== undefined) parts.push(`${row.tools} tool${row.tools === 1 ? "" : "s"}`);
	if (row.pid !== undefined) parts.push(`pid=${row.pid}`);
	const glyph = KIND_GLYPH[row.kind];
	const body = `${formatClockFn(row.ts)} ${glyph} ${parts.join(" \u00b7 ")}`;
	// `.length` is not width: a clock is ASCII but a glyph need not be, and
	// pi-tui's Render.draw hard-asserts on an over-wide line.
	const clipped = visibleWidth(body) > width ? truncateToWidth(body, width, "\u2026") : body;
	return KIND_TONE[row.kind] === "dim" ? dim(clipped) : theme.fg("accent", clipped);
}

/**
 * Render the whole log, newest last, under a heading that says what this is.
 *
 * The heading is not decoration: it is the honesty rule made visible. A reader
 * who lands here from a run-entry transcript must be able to tell at a glance that
 * these are process events, not something the agent said.
 */
export function renderEventLog(
	model: EventLogModel,
	width: number,
	theme: { fg(role: string, value: string): string },
	formatClockFn: (ms: number) => string,
	/**
	 * Replaces the rows when the log could not be read at all. The heading
	 * still renders: a reader must be able to tell what level they are on even
	 * when it has nothing to show.
	 */
	unavailable?: string,
): string[] {
	const dim = (value: string) => theme.fg("dim", value);
	const lines: string[] = [];
	// Every literal below is plain text, so clip before theming: the ANSI a
	// theme adds is invisible but `truncateToWidth` would still count it.
	const fit = (text: string) =>
		visibleWidth(text) > width ? truncateToWidth(text, width, "\u2026") : text;
	lines.push(theme.fg("accent", fit(" event log")));
	lines.push(dim(fit(" events reported by another process \u00b7 not a transcript")));
	lines.push("");
	if (unavailable !== undefined) {
		lines.push(dim(fit(` ${unavailable}`)));
		return lines;
	}
	if (model.rows.length === 0) {
		lines.push(dim(fit(" no events recorded yet")));
		return lines;
	}
	if (model.truncated) {
		// Only claim a total when one is actually known; otherwise say the
		// beginning is missing and stop there.
		const shown = model.rows.length;
		lines.push(dim(fit(
			model.totalCount === undefined
				? ` oldest events dropped \u00b7 showing the newest ${shown}`
				: ` oldest events dropped \u00b7 showing ${shown} of ${model.totalCount}`,
		)));
		lines.push("");
	}
	for (const row of model.rows) {
		// The leading space is part of the line, so the row gets width - 1.
		if (width <= 1) {
			lines.push(renderEventRow(row, width, theme, formatClockFn));
			continue;
		}
		lines.push(` ${renderEventRow(row, width - 1, theme, formatClockFn)}`);
	}
	return lines;
}
