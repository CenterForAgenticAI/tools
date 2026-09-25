import { isAsciiOnlyTerminal, resolveFooterIconMode, type IconMode } from "./icons.js";
import type { InProcessRunShape } from "./runtime.js";

/**
 * Footer icon vocabulary.
 *
 * An alias for the shared `IconMode` since the overlay joined the same knob.
 * The name is kept because it is the exported type several modules already
 * import, and because `footerIcons` remains the config key.
 */
export type FooterIconMode = IconMode;

export { isAsciiOnlyTerminal, resolveFooterIconMode };


/** The run facts available to the in-process footer and below-editor widget. */
export interface FooterModeSource {
	shape?: InProcessRunShape;
	/** Legacy in-process background-dispatch marker; true means detached from the parent turn. */
	detached?: boolean;
}

type FooterShape = InProcessRunShape | "unknown";

interface ShapePresentation {
	label: string;
	nerdFontIcon: string;
	order: number;
}

/**
 * One presentation table owns every shape label and private-use glyph.
 * Glyph names and code points come from Nerd Fonts' Codicons set.
 */
const SHAPE_PRESENTATION: Readonly<Record<FooterShape, ShapePresentation>> = {
	supervised: {
		label: "supervised",
		nerdFontIcon: "\uEBBB", // cod-type_hierarchy_super
		order: 0,
	},
	direct: {
		label: "direct",
		nerdFontIcon: "\uEA9C", // cod-arrow_right
		order: 1,
	},
	chain: {
		label: "chain",
		nerdFontIcon: "\uEB15", // cod-link
		order: 2,
	},
	unknown: {
		label: "unknown",
		nerdFontIcon: "\uEB32", // cod-question
		order: 3,
	},
};

const DETACHED_NERD_FONT_ICON = "\uEC53"; // cod-send_to_remote_agent

interface NormalizedFooterMode {
	shape: FooterShape;
	detached: boolean;
}

interface FooterModeCount extends NormalizedFooterMode {
	count: number;
}

function normalizeFooterMode(source: FooterModeSource): NormalizedFooterMode {
	return {
		shape: source.shape === "supervised" || source.shape === "direct" || source.shape === "chain"
			? source.shape
			: "unknown",
		detached: source.detached === true,
	};
}

function modeKey(mode: NormalizedFooterMode): string {
	return `${mode.detached ? "detached" : "foreground"}:${mode.shape}`;
}

function modeLabel(mode: NormalizedFooterMode): string {
	const shapeLabel = SHAPE_PRESENTATION[mode.shape].label;
	return mode.detached ? `background ${shapeLabel}` : shapeLabel;
}

function modeNerdFontIcons(mode: NormalizedFooterMode): string {
	const shapeIcon = SHAPE_PRESENTATION[mode.shape].nerdFontIcon;
	return mode.detached ? `${DETACHED_NERD_FONT_ICON} ${shapeIcon}` : shapeIcon;
}

function countModes(sources: readonly FooterModeSource[]): FooterModeCount[] {
	const counts = new Map<string, FooterModeCount>();
	for (const source of sources) {
		const mode = normalizeFooterMode(source);
		const key = modeKey(mode);
		const existing = counts.get(key);
		if (existing) existing.count += 1;
		else counts.set(key, { ...mode, count: 1 });
	}
	return [...counts.values()].sort((left, right) => {
		if (left.detached !== right.detached) return left.detached ? 1 : -1;
		return SHAPE_PRESENTATION[left.shape].order - SHAPE_PRESENTATION[right.shape].order;
	});
}

// `isAsciiOnlyTerminal` and `resolveFooterIconMode` moved to `icons.ts` when
// the overlay joined the same vocabulary; both are re-exported above so
// existing importers of this module are unaffected.


export type DelegatePresentationKind = FooterShape | "background";

export interface DelegatePresentationLegendEntry {
	kind: DelegatePresentationKind;
	label: string;
	marker: string;
}

export type DelegatePresentationActor = "worker";

export type DelegatePresentationShape = FooterShape;

export interface DelegatePresentationTerminologyEntry {
	kind: DelegatePresentationShape;
	label: string;
	singular: string;
	plural: string;
	actor: DelegatePresentationActor;
}

const PRESENTATION_TERMINOLOGY: Readonly<Record<DelegatePresentationShape, DelegatePresentationTerminologyEntry>> = {
	direct: {
		kind: "direct",
		label: SHAPE_PRESENTATION.direct.label,
		singular: "worker",
		plural: "workers",
		actor: "worker",
	},
	supervised: {
		kind: "supervised",
		label: SHAPE_PRESENTATION.supervised.label,
		singular: "fork",
		plural: "forks",
		actor: "worker",
	},
	chain: {
		kind: "chain",
		label: SHAPE_PRESENTATION.chain.label,
		singular: "step",
		plural: "steps",
		actor: "worker",
	},
	unknown: {
		kind: "unknown",
		label: SHAPE_PRESENTATION.unknown.label,
		singular: "run",
		plural: "runs",
		actor: "worker",
	},
};

/** Additive run-entry terminology seam; delivery and marker modes stay separate. */
export function getDelegatePresentationTerminology(
	shape?: DelegatePresentationShape,
): DelegatePresentationTerminologyEntry;
export function getDelegatePresentationTerminology(shape: string): DelegatePresentationTerminologyEntry;
export function getDelegatePresentationTerminology(shape?: string): DelegatePresentationTerminologyEntry {
	const normalized: DelegatePresentationShape = shape === "direct" || shape === "supervised" || shape === "chain" || shape === "unknown"
		? shape
		: "unknown";
	return { ...PRESENTATION_TERMINOLOGY[normalized] };
}

/** Shared labels and markers used by the footer, slash help, and documentation tests. */
export function getDelegatePresentationLegend(
	configured: FooterIconMode | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): DelegatePresentationLegendEntry[] {
	const nerdFont = resolveFooterIconMode(configured, env) === "nerd-font";
	const shapeEntry = (shape: FooterShape): DelegatePresentationLegendEntry => ({
		kind: shape,
		label: SHAPE_PRESENTATION[shape].label,
		marker: nerdFont ? SHAPE_PRESENTATION[shape].nerdFontIcon : SHAPE_PRESENTATION[shape].label,
	});
	return [
		shapeEntry("direct"),
		shapeEntry("supervised"),
		shapeEntry("chain"),
		{
			kind: "background",
			label: "background",
			marker: nerdFont ? DETACHED_NERD_FONT_ICON : "background",
		},
		shapeEntry("unknown"),
	];
}

/**
 * Render the activity footer. Only the Nerd Font tier adds per-shape counts.
 *
 * The shape markers are private-use code points with no Unicode equivalent, so
 * the `unicode` tier gets the same historical aggregate string as `ascii`
 * rather than a row of tofu.
 */
export function formatDelegateActivityFooter(
	live: readonly FooterModeSource[],
	configured: FooterIconMode | undefined,
	env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
	if (live.length === 0) return undefined;
	const aggregate = `${live.length} delegate${live.length === 1 ? "" : "s"} live`;
	if (resolveFooterIconMode(configured, env) !== "nerd-font") return aggregate;

	const modeCounts = countModes(live).map((mode) => {
		const delegateLabel = mode.count === 1 ? "delegate" : "delegates";
		return `${modeNerdFontIcons(mode)} ${mode.count} ${modeLabel(mode)} ${delegateLabel}`;
	});
	return [aggregate, ...modeCounts].join(" · ");
}

/**
 * Render a per-row mode badge for the below-editor widget. Nerd Font mode
 * returns just the shape (and detached) glyph; the icon already conveys the
 * worker type, so the text label is dropped to save room. Every other tier
 * returns no badge, so an unpatched terminal's layout stays unchanged.
 */
export function formatFooterModeBadge(
	source: FooterModeSource,
	configured: FooterIconMode | undefined,
	env?: Readonly<Record<string, string | undefined>>,
): string | undefined {
	if (resolveFooterIconMode(configured, env) !== "nerd-font") return undefined;
	return modeNerdFontIcons(normalizeFooterMode(source));
}
