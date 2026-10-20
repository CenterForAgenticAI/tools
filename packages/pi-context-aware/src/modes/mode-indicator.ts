import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ContextAwareModeColorV1, ContextAwareModeSnapshotV1 } from "../context-service.js";
import { modeDisplayText } from "./modes-state.js";

export const MODES_WIDGET_KEY = "caair.context-aware/mode-indicator";

const DEFAULT_MODE_COLOR: ThemeColor = "accent";
const UNAVAILABLE_MODE_COLOR: ThemeColor = "muted";

type RgbColor = { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number };
type IndicatorColor = ThemeColor | RgbColor;

function indicatorColor(color: ContextAwareModeColorV1 | undefined): IndicatorColor {
	if (color === undefined) return DEFAULT_MODE_COLOR;
	if (!color.startsWith("#")) return color as ThemeColor;
	const value = Number.parseInt(color.slice(1), 16);
	return { kind: "rgb", r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** Older Pi themes have no `style`; they still get the theme token, but no fixed colors. */
function paint(theme: Theme, text: string, color: IndicatorColor, options: { inverse?: boolean; bold?: boolean } = {}): string {
	if (typeof theme.style === "function") return theme.style(text, { fg: color, ...options });
	const token = typeof color === "string" ? color : DEFAULT_MODE_COLOR;
	const colored = theme.fg(token, text);
	return options.bold === true ? theme.bold(colored) : colored;
}

function modeColor(mode: ContextAwareModeSnapshotV1): IndicatorColor {
	return mode.available ? indicatorColor(mode.ui?.color) : UNAVAILABLE_MODE_COLOR;
}

function modeLabel(mode: ContextAwareModeSnapshotV1): string {
	const label = modeDisplayText(mode.ui?.label ?? mode.id);
	return mode.available ? label : `${label} (unavailable)`;
}

/**
 * One line: the effective mode as a solid chip in its color, the outer mode it
 * returns to, the owner, and a rule in the effective mode's color to the edge.
 */
export function renderModeIndicatorLine(mode: ContextAwareModeSnapshotV1, theme: Theme, width: number): string {
	if (width <= 0) return "";
	const color = modeColor(mode);
	const parts = [paint(theme, ` ◆ ${modeLabel(mode)} `, color, { inverse: true, bold: true })];
	if (mode.outer !== undefined) {
		parts.push(theme.fg("muted", " ← "), paint(theme, `◇ ${modeLabel(mode.outer)}`, modeColor(mode.outer), { bold: true }));
	}
	parts.push(theme.fg("muted", ` · ${modeDisplayText(mode.owner)}`));
	if (mode.suggestedBy === "model") parts.push(theme.fg("warning", " [model-confirmed]"));
	parts.push(paint(theme, ` ${"─".repeat(width)}`, color));
	// Cut, never wrap: word wrapping would break at the hyphen in an owner such as `pi-stack`.
	return truncateToWidth(parts.join(""), width, "", true);
}

/** A widget factory for the effective mode; Pi calls it with the live theme. */
export function createModeIndicatorWidget(mode: ContextAwareModeSnapshotV1): (tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void } {
	return (_tui, theme) => {
		let cached: { width: number; lines: string[] } | undefined;
		return {
			render(width: number): string[] {
				if (cached?.width !== width) cached = { width, lines: width > 0 ? [renderModeIndicatorLine(mode, theme, width)] : [] };
				return cached.lines;
			},
			invalidate(): void {
				cached = undefined;
			},
		};
	};
}
