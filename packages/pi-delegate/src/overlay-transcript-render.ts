/**
 * Draw transcript blocks into the detail pane.
 *
 * The redesign's transcript decisions live here (epic #326):
 *
 * - **No per-line speaker rail.** `S│`/`W│` on every line was the single
 *   largest source of visual noise. Attribution moves to a block heading, and
 *   the sticky heading in the detail pane recovers what the rail bought:
 *   knowing who is speaking after you scroll into the middle of a long block.
 * - **Prose through pi-tui's `Markdown`,** so `**bold**` stops rendering as
 *   literal asterisks.
 * - **Tool calls as one chip:** dim name, bright argument, right-flushed
 *   duration. The argument is the part you actually read.
 * - **Errors auto-expand; successes stay one line.** A failure is usually why
 *   the transcript got opened.
 *
 * Every function guarantees `visibleWidth(line) <= width`. pi-tui's
 * `Render.draw` hard-asserts on an over-wide line, so it is pinned by test
 * rather than assumed.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi, Markdown } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { iconSet, type IconSet } from "./icons.js";
import { SPEAKER_COLOR, type TranscriptSpeaker } from "./transcript-speaker.js";
import type {
	ProseBlock,
	ThinkingBlock,
	ToolBlock,
	TranscriptBlock,
	TranscriptModel,
	WaitingSummary,
} from "./overlay-transcript-model.js";

/** Lines kept when a long finished message is folded. */
export const FOLD_KEEP_LINES = 8;
/** A message longer than this folds. */
export const FOLD_THRESHOLD_LINES = 12;
/** Characters of a thinking trace shown while collapsed. */
export const THINKING_PREVIEW_CHARS = 150;
/** Lines of tool output shown when a block expands. */
export const TOOL_OUTPUT_LINES = 6;
/** Narrowest width that renders anything meaningful. */
export const MIN_TRANSCRIPT_WIDTH = 12;

export interface RenderTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
}

export interface RenderTranscriptOptions {
	readonly width: number;
	readonly theme: RenderTheme;
	readonly markdownTheme: MarkdownTheme;
	/**
	 * Entry index of the block the operator has expanded, if any. `Enter`
	 * expands one node rather than a global fold toggle being carried around.
	 */
	readonly expandedEntryIndex?: number;
	/**
	 * Thinking-trace detail, cycled with `t`.
	 *
	 * Three states, carried as three states. This was a boolean
	 * (`hideThinking`) that collapsed the key's tri-state at the seam, so
	 * `full` rendered exactly the same 150-character preview as `preview` and
	 * only the footer label changed (review finding OV-15).
	 */
	readonly thinkingDetail?: "hidden" | "preview" | "full";
	/**
	 * Tool-chip detail, cycled with `g`.
	 *
	 * `chip` is the default single line. `hidden` drops tool calls entirely,
	 * for reading prose alone. `expanded` opens every call's arguments and
	 * output at once, which `Enter` otherwise does one block at a time.
	 */
	readonly toolDetail?: "chip" | "hidden" | "expanded";
	readonly nowMs: number;
	/**
	 * Marker vocabulary. Defaults to `unicode`, which is exactly the glyph set
	 * this renderer hardcoded before the setting existed, so a caller that does
	 * not pass one sees no change.
	 */
	readonly icons?: IconSet;

}

export interface RenderedTranscript {
	readonly lines: string[];
	/** Output line for each source entry index, for exact drill-down. */
	readonly entryAnchors: ReadonlyMap<number, number>;
	/**
	 * Speaker heading in force at each output line, so the detail pane can pin
	 * a sticky heading when a block scrolls past the top.
	 */
	readonly headingAt: readonly (string | undefined)[];
}

/**
 * The vocabulary in force, defaulting to the historical Unicode glyphs.
 *
 * Resolved per call rather than per module so this file stays pure: reading
 * config or `process.env` here would make every rendering test depend on the
 * environment it ran in.
 */
function icons(options: RenderTranscriptOptions): IconSet {
	return options.icons ?? iconSet("unicode");
}

/** Which speaker icon heads a block. */
const SPEAKER_ICON: Readonly<Record<TranscriptSpeaker, keyof IconSet>> = {
	you: "speakerYou",
	main: "speakerMain",
	supervisor: "speakerSupervisor",
	worker: "speakerWorker",
	run: "speakerRun",
};

/** `1.2s` / `13s` / `6m16s`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `HH:MM:SS`, or a fixed-width placeholder so columns stay aligned. */
export function formatClock(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "--:--:--";
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Normalize raw transcript text for display.
 *
 * Tool output can carry tabs and control characters that `visibleWidth` counts
 * differently from the wrapper, which produces a line wider than the terminal
 * and trips pi-tui's hard assertion.
 */
export function sanitize(raw: string): string {
	return raw
		.replace(/\t/g, "   ")
		.replace(/\r/g, "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Clip to `width`, never exceeding it. */
function clip(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

/**
 * Render prose through pi-tui's `Markdown`.
 *
 * `Markdown` pads every line to the full width; the padding is stripped so the
 * caller controls trailing space and the width invariant stays checkable.
 */
export function renderProseText(
	text: string,
	width: number,
	markdownTheme: MarkdownTheme,
): string[] {
	if (width <= 0) return [];
	const markdown = new Markdown(sanitize(text), 0, 0, markdownTheme);
	return markdown
		.render(width)
		.map((line) => line.replace(/\s+$/, ""))
		.map((line) => clip(line, width));
}

/**
 * The tool chip: `⚙ name  argument                        ✓ 1.2s`, with the
 * markers taken from the vocabulary in force.
 *
 * The duration is right-flushed so a column of calls reads as a column of
 * timings. When the width cannot hold both, the argument gives way first —
 * the outcome and its cost are the part that must survive.
 */
export function renderToolChip(
	block: ToolBlock,
	width: number,
	theme: RenderTheme,
	marks: IconSet = iconSet("unicode"),
): string {
	const statusGlyph = block.state === "ok"
		? marks.ok
		: block.state === "error"
			? marks.error
			: marks.running;
	const status = block.state === "ok"
		? theme.fg("success", statusGlyph)
		: block.state === "error"
			? theme.fg("error", statusGlyph)
			: theme.fg("warning", statusGlyph);
	const durationText = block.durationMs === undefined ? "" : formatDuration(block.durationMs);
	// Measured from a plain stand-in because the themed strings carry invisible
	// ANSI that `visibleWidth` would count as zero but `.length` would not. The
	// stand-in uses the real glyph, not a one-cell placeholder: the Unicode
	// pending marker is two cells wide, and budgeting it as one is how a chip
	// ends up one column over its allowance.
	const suffixPlain = durationText.length > 0 ? `${statusGlyph} ${durationText}` : statusGlyph;
	const suffix = durationText.length > 0
		? `${status} ${theme.fg("dim", durationText)}`
		: status;

	const namePlain = `${marks.tool} ${block.name}`;
	const name = theme.fg("dim", `${marks.tool} `) + theme.fg("text", block.name);
	const argument = block.meta ?? block.args ?? "";

	// Budget in plain characters; the themed strings carry invisible ANSI.
	const suffixWidth = visibleWidth(suffixPlain);
	const available = width - visibleWidth(namePlain) - suffixWidth - 2;
	if (available <= 2 || argument.length === 0) {
		return clip(`${name}  ${suffix}`, width);
	}
	const shownArgument = clip(sanitize(argument).replace(/\s+/g, " "), available);
	const gap = Math.max(
		1,
		width - visibleWidth(namePlain) - visibleWidth(shownArgument) - suffixWidth - 1,
	);
	return clip(
		`${name} ${theme.fg("accent", shownArgument)}${" ".repeat(gap)}${suffix}`,
		width,
	);
}

/**
 * The pinned live-wait row.
 *
 * One `wait_for_worker` row per heartbeat interval is most of what made a slow
 * fork's transcript unreadable. They collapse into this single row, which says
 * the same thing without growing.
 */
export function renderWaitingRow(
	waiting: WaitingSummary,
	width: number,
	theme: RenderTheme,
	marks: IconSet = iconSet("unicode"),
): string {
	const elapsed = formatDuration(waiting.elapsedMs);
	const budget = waiting.maxConsecutive === undefined
		? `${waiting.consecutive}`
		: `${waiting.consecutive}/${waiting.maxConsecutive}`;
	const text = ` ${marks.running} waiting for worker · ${elapsed} · heartbeat ${budget}`;
	return clip(theme.fg("warning", text), width);
}

/** The round separator: a labelled rule carrying the counts. */
function renderRoundSeparator(
	block: Extract<TranscriptBlock, { kind: "round" }>,
	width: number,
	theme: RenderTheme,
): string {
	const tools = `${block.toolCount} tool${block.toolCount === 1 ? "" : "s"}`;
	const errors = block.errorCount > 0
		? ` · ${block.errorCount} error${block.errorCount === 1 ? "" : "s"}`
		: "";
	const clock = block.timestamp === undefined ? "" : ` · ${formatClock(block.timestamp)}`;
	const label = `── round ${block.index}${clock} · ${tools}${errors} `;
	const rule = width > visibleWidth(label) ? "─".repeat(width - visibleWidth(label)) : "";
	return clip(theme.fg("dim", `${label}${rule}`), width);
}

/** Render the whole transcript. */
export function renderTranscript(
	model: TranscriptModel,
	options: RenderTranscriptOptions,
): RenderedTranscript {
	const { width, theme } = options;
	const marks = icons(options);
	const lines: string[] = [];
	const entryAnchors = new Map<number, number>();
	const headingAt: (string | undefined)[] = [];
	let heading: string | undefined;

	if (width < MIN_TRANSCRIPT_WIDTH) return { lines, entryAnchors, headingAt };
	if (model.blocks.length === 0) {
		lines.push(theme.fg("dim", "(no transcript entries yet)"));
		headingAt.push(undefined);
		return { lines, entryAnchors, headingAt };
	}

	const push = (line: string) => {
		lines.push(line);
		headingAt.push(heading);
	};
	/** Blank spacer, suppressed at the top and never doubled. */
	const spacer = () => {
		if (lines.length > 0 && lines[lines.length - 1] !== "") push("");
	};

	for (const block of model.blocks) {
		if (block.kind === "round") {
			spacer();
			heading = undefined;
			entryAnchors.set(block.entryIndex, lines.length);
			push(renderRoundSeparator(block, width, theme));
			continue;
		}

		if (block.kind === "prose") {
			spacer();
			heading = block.heading;
			entryAnchors.set(block.entryIndex, lines.length);
			push(renderProseHeading(block, width, theme, marks));
			for (const line of renderProseBody(block, options)) push(line);
			continue;
		}

		if (block.kind === "thinking") {
			// Anchor AFTER the skip. A hidden block that claims a line claims
			// the same line as the next visible one, and `Enter` — which picks
			// the first entry anchored at or above the viewport top — would
			// then expand something invisible and appear to do nothing.
			if (options.thinkingDetail === "hidden") continue;
			entryAnchors.set(block.entryIndex, lines.length);
			for (const line of renderThinking(block, options)) push(line);
			continue;
		}

		if (block.kind === "tool") {
			// Same rule as thinking: a hidden chip must claim no line, or it
			// shadows the visible block below it for `Enter`.
			if (options.toolDetail === "hidden") continue;
			entryAnchors.set(block.entryIndex, lines.length);
			push(renderToolChip(block, width, theme, marks));
			for (const line of renderToolDetail(block, options)) push(line);
			if (block.resultEntryIndex !== undefined) {
				// The result shares its call's line: they are one chip.
				entryAnchors.set(block.resultEntryIndex, entryAnchors.get(block.entryIndex)!);
			}
			continue;
		}

		entryAnchors.set(block.entryIndex, lines.length);
		for (const line of wrapTextWithAnsi(sanitize(block.text), width)) {
			push(theme.fg("dim", clip(line, width)));
		}
	}

	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
		headingAt.pop();
	}
	return { lines, entryAnchors, headingAt };
}

/**
 * `▸ worker → supervisor · 14:03:20`, tinted by speaker.
 *
 * The Nerd Font tier gives each speaker its own icon; the other tiers keep the
 * single chevron. The heading names the speaker either way, so the icon is
 * reinforcement rather than the only cue — which is what lets the plainer
 * tiers drop it without losing information.
 */
function renderProseHeading(
	block: ProseBlock,
	width: number,
	theme: RenderTheme,
	marks: IconSet = iconSet("unicode"),
): string {
	const colour = SPEAKER_COLOR[block.speaker];
	const label = theme.fg(colour, theme.bold(`${marks[SPEAKER_ICON[block.speaker]]} ${block.heading}`));
	const clock = theme.fg("dim", ` · ${formatClock(block.timestamp)}`);
	return clip(`${label}${clock}`, width);
}

function renderProseBody(block: ProseBlock, options: RenderTranscriptOptions): string[] {
	const { width, theme } = options;
	const rendered = renderProseText(block.text, width, options.markdownTheme);
	const expanded = options.expandedEntryIndex === block.entryIndex;
	const folds = !block.newest && !expanded && rendered.length > FOLD_THRESHOLD_LINES;
	if (!folds) return rendered;
	const kept = rendered.slice(0, FOLD_KEEP_LINES);
	const marks = icons(options);
	kept.push(
		clip(
			theme.fg(
				"dim",
				`${marks.fold} +${rendered.length - FOLD_KEEP_LINES} lines · ${marks.enter} expands`,
			),
			width,
		),
	);
	return kept;
}

function renderThinking(block: ThinkingBlock, options: RenderTranscriptOptions): string[] {
	const { width, theme } = options;
	// `full` shows everything, and so does expanding this one node with Enter.
	const expanded = options.expandedEntryIndex === block.entryIndex
		|| options.thinkingDetail === "full";
	const out: string[] = [];
	// A blank line above keeps a thinking trace from merging into the tool run
	// that precedes it.
	out.push("");
	const marks = icons(options);
	out.push(clip(
		theme.fg(
			"dim",
			`${marks.thinking} ${block.speaker} thinking ${expanded ? marks.expanded : marks.collapsed}`,
		),
		width,
	));
	const full = sanitize(block.text).replace(/\s+/g, " ").trim();
	if (full.length === 0) return out;
	const body = expanded
		? full
		: full.length > THINKING_PREVIEW_CHARS
			? `${full.slice(0, THINKING_PREVIEW_CHARS)}…`
			: full;
	for (const line of wrapTextWithAnsi(body, Math.max(1, width - 1))) {
		out.push(clip(theme.fg("muted", line), width));
	}
	return out;
}

/**
 * Detail lines under a chip.
 *
 * An error expands without being asked, because a failure is usually the
 * reason the transcript was opened at all. A success stays one line unless the
 * operator expands it.
 */
function renderToolDetail(block: ToolBlock, options: RenderTranscriptOptions): string[] {
	const { width, theme } = options;
	const expanded = options.expandedEntryIndex === block.entryIndex
		|| options.toolDetail === "expanded";
	const autoExpand = block.state === "error";
	if (!expanded && !autoExpand) return [];
	const out: string[] = [];
	const indent = "  ";
	const bodyWidth = Math.max(1, width - indent.length);
	if (expanded && block.args !== undefined) {
		for (const line of wrapTextWithAnsi(sanitize(block.args), bodyWidth).slice(0, TOOL_OUTPUT_LINES)) {
			out.push(clip(theme.fg("dim", `${indent}${line}`), width));
		}
	}
	if (block.output !== undefined) {
		const tone = block.state === "error" ? "error" : "dim";
		for (const line of wrapTextWithAnsi(sanitize(block.output), bodyWidth).slice(0, TOOL_OUTPUT_LINES)) {
			out.push(clip(theme.fg(tone, `${indent}${line}`), width));
		}
	}
	return out;
}
