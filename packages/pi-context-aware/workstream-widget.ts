/** Width-aware persistent UI projection of the transcript-authoritative workstream focus. */

import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";

import { isCtxInvalidationError } from "./ctx-liveness.js";
import { redactText } from "./workstream-safety.js";
import type { WorkstreamSnapshot } from "./workstream-schema.js";

/**
 * The qualified key from the UI coordination doc. The unqualified key is kept
 * as an alias so an existing host that clears it by name still works.
 */
export const WORKSTREAM_FOCUS_WIDGET_KEY = "caair.context-aware/session-focus" as const;
export const LEGACY_WORKSTREAM_FOCUS_WIDGET_KEY = "ctx-aware-session-focus" as const;

/** Above-editor collapsed budget: two lines per feature (see pi/AGENTS.md UI surface rules). */
export const WORKSTREAM_FOCUS_COLLAPSED_LINES = 2;

interface FocusWidgetTheme {
	fg(color: "accent", text: string): string;
}

interface FocusWidgetOptions {
	/** Whether the user has expanded tool output; expansion lifts the collapsed line budget. */
	isExpanded?: () => boolean;
	/** Optional trailing hint rendered only while expanded. */
	expandedHint?: () => string;
	/**
	 * The task-list line, when this session has a list.
	 *
	 * One widget grows a second line rather than a second widget appearing:
	 * the above-editor budget is two lines per feature, and context-aware has
	 * already spent it on focus.
	 */
	tasksLine?: string | null;
}

function goalProgress(snapshot: WorkstreamSnapshot): string {
	if (snapshot.goals.length === 0) return "";
	const completed = snapshot.goals.filter((goal) => goal.status === "done").length;
	return ` · ${completed}/${snapshot.goals.length} goals`;
}

export function workstreamFocusWidgetText(snapshot: WorkstreamSnapshot): string | null {
	if (snapshot.status !== "active") return null;
	const objective = redactText(snapshot.objective, { maxLength: 1_000 }).trim();
	if (objective.length === 0) return null;
	return `🎯 ${objective} · active${goalProgress(snapshot)}`;
}

function firstVisualLine(text: string, width: number): { line: string; wrapped: boolean } {
	// Prevent Text's word wrapping so the first rendered line behaves like true visual-width truncation.
	const nonBreakingText = text.replaceAll(" ", "\u00a0");
	const visualLines = truncateToVisualLines(nonBreakingText, Number.MAX_SAFE_INTEGER, width, 0).visualLines;
	return {
		line: (visualLines[0] ?? "").trimEnd().replaceAll("\u00a0", " "),
		wrapped: visualLines.length > 1,
	};
}

/** Word-wrap to the available width, keeping the leading lines rather than the trailing ones. */
function wrapFocusText(text: string, width: number): string[] {
	if (text.length === 0 || width <= 0) return [];
	return truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width, 0)
		.visualLines.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

/** Mark a clipped line so a truncated objective never looks complete. */
function withEllipsis(line: string, width: number): string {
	if (width <= 1) return "…";
	return `${firstVisualLine(line, width - 1).line}…`;
}

function focusLines(text: string, width: number, maxLines: number): string[] {
	if (text.length === 0 || width <= 0) return [];
	// A single-column terminal cannot show useful wrapped content; keep the historical marker.
	if (width === 1) return ["…"];
	const wrapped = wrapFocusText(text, width);
	if (wrapped.length <= maxLines) return wrapped;
	if (maxLines <= 0) return [];
	const kept = wrapped.slice(0, maxLines);
	kept[maxLines - 1] = withEllipsis(kept[maxLines - 1] ?? "", width);
	return kept;
}

export function createWorkstreamFocusWidget(
	snapshot: WorkstreamSnapshot | null,
	theme: FocusWidgetTheme,
	options: FocusWidgetOptions = {},
) {
	const text = (snapshot === null ? null : workstreamFocusWidgetText(snapshot)) ?? "";
	const tasksLine = options.tasksLine ?? null;
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			let expanded = false;
			try {
				expanded = options.isExpanded?.() ?? false;
			} catch (error) {
				if (!isCtxInvalidationError(error)) throw error;
			}
			if (cachedLines !== undefined && cachedWidth === width && cachedExpanded === expanded) return cachedLines;
			const availableWidth = Math.max(0, Math.floor(width));
			// The task line takes one of the two collapsed lines when it exists,
			// so the pair never exceeds the budget a single feature is allowed.
			const focusBudget = expanded
				? Number.MAX_SAFE_INTEGER
				: Math.max(1, WORKSTREAM_FOCUS_COLLAPSED_LINES - (tasksLine === null ? 0 : 1));
			const lines = focusLines(text, availableWidth, focusBudget).map((line) => theme.fg("accent", line));
			if (tasksLine !== null && tasksLine.length > 0) {
				for (const line of focusLines(tasksLine, availableWidth, 1)) lines.push(theme.fg("accent", line));
			}
			const hint = expanded ? options.expandedHint?.() : undefined;
			cachedLines = lines.length > 0 && hint !== undefined && hint.length > 0 ? [...lines, hint] : lines;
			cachedWidth = width;
			cachedExpanded = expanded;
			return cachedLines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedExpanded = undefined;
			cachedLines = undefined;
		},
	};
}
