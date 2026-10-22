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

/** A pinned layer's chip carries a flag. */
function chipText(mode: ContextAwareModeSnapshotV1): string {
	return ` ◆ ${modeLabel(mode)}${mode.pinned === true ? " ⚑" : ""} `;
}

/**
 * One line: a solid chip per active layer in its mode's color, lowest rank
 * first, the owners, the step trail, and a rule in the top layer's color to the
 * edge. `modes` is in rank order, as `layers()` returns it.
 */
export function renderModeIndicatorLine(modes: readonly ContextAwareModeSnapshotV1[], theme: Theme, width: number, trail?: string): string {
	const top = modes.at(-1);
	if (width <= 0 || top === undefined) return "";
	const parts: string[] = [];
	modes.forEach((mode, index) => {
		if (index > 0) parts.push(" ");
		parts.push(paint(theme, chipText(mode), modeColor(mode), { inverse: true, bold: true }));
	});
	const owners = [...new Set(modes.map((mode) => modeDisplayText(mode.owner)))];
	parts.push(theme.fg("muted", ` · ${owners.join(", ")}`));
	if (modes.some((mode) => mode.suggestedBy === "model")) parts.push(theme.fg("warning", " [model-confirmed]"));
	if (trail !== undefined) parts.push(theme.fg("muted", " › "), theme.fg("text", modeDisplayText(trail)));
	parts.push(paint(theme, ` ${"─".repeat(width)}`, modeColor(top)));
	// Cut, never wrap: word wrapping would break at the hyphen in an owner such as `pi-stack`.
	return truncateToWidth(parts.join(""), width, "", true);
}

/** A widget factory for the active layers; Pi calls it with the live theme. */
export function createModeIndicatorWidget(modes: readonly ContextAwareModeSnapshotV1[], trail?: string): (tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void } {
	return (_tui, theme) => {
		let cached: { width: number; lines: string[] } | undefined;
		return {
			render(width: number): string[] {
				if (cached?.width !== width) cached = { width, lines: width > 0 ? [renderModeIndicatorLine(modes, theme, width, trail)] : [] };
				return cached.lines;
			},
			invalidate(): void {
				cached = undefined;
			},
		};
	};
}
