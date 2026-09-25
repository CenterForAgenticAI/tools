/**
 * One icon vocabulary for every delegate surface.
 *
 * The footer and the below-editor widget already chose glyphs by a configured
 * mode; the overlay hardcoded its own Unicode. Two tables for one fact is how
 * the same status ends up reading two ways depending on which surface shows
 * it, so both now resolve through this module.
 *
 * ## Three tiers, and why the middle one exists
 *
 * - `nerd-font` — Nerd Fonts private-use glyphs, from the Codicons set. The
 *   default, and the only tier that distinguishes a speaker by icon.
 * - `unicode` — exactly the glyphs the overlay rendered before this module
 *   existed. The right choice for a terminal with no patched font, and pinned
 *   to the status quo so that selecting it is a return to known-good output
 *   rather than a third new appearance.
 * - `ascii` — plain 7-bit, for `TERM=dumb` and `PI_DELEGATE_ASCII=1`.
 *
 * Every variant is one terminal cell wide except where noted, checked by test
 * against pi-tui's `visibleWidth`. That matters more than it looks: pi-tui's
 * `Render.draw` hard-asserts on an over-wide line, so a two-cell glyph
 * substituted into a width-budgeted row is a crash, not a cosmetic bug.
 *
 * ## Scope
 *
 * Markers only. Separators (`·`), arrows (`→`), and the compose cursor are
 * typography rather than iconography and are left where they are.
 */

/** Icon vocabulary. Nerd Font rendering is the configured default. */
export type IconMode = "nerd-font" | "unicode" | "ascii";

/**
 * Return whether existing hard ASCII controls force plain terminal output.
 *
 * Lives here rather than in `footer-presentation.ts` (its previous home) so
 * that module can import the vocabulary without a cycle. It is re-exported
 * from there for callers that already had it.
 */
export function isAsciiOnlyTerminal(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return env.PI_DELEGATE_ASCII === "1" || env.TERM?.toLowerCase() === "dumb";
}

/** Every marker any delegate surface draws. */
export type IconName =
	// Transcript
	| "thinking"
	| "tool"
	| "ok"
	| "error"
	| "running"
	| "collapsed"
	| "expanded"
	| "fold"
	| "enter"
	| "cancelled"
	// Speakers
	| "speakerYou"
	| "speakerMain"
	| "speakerSupervisor"
	| "speakerWorker"
	| "speakerRun"
	// List and lifecycle
	| "selected"
	| "active"
	| "completed"
	| "paused"
	| "failed"
	| "aborted"
	| "idle"
	| "constructing"
	| "warning"
	| "tasks"
	// Task-list statuses
	| "taskDone"
	| "taskActive"
	| "taskBlocked"
	| "taskDeferred"
	| "taskPending";

interface IconVariants {
	readonly "nerd-font": string;
	readonly unicode: string;
	readonly ascii: string;
}

/**
 * The vocabulary. Nerd Font code points are named with their Codicons glyph
 * name so a reader can look one up without decoding a private-use escape.
 *
 * The `unicode` column is the rendering the overlay had before this module,
 * and must not be changed to "improve" it. It is not what an unconfigured
 * project renders — `footerIcons` defaults to `nerd-font`, so this tier is
 * reached only by explicitly selecting it or through an unwired host. Its
 * value is being a known-good target for a terminal without a patched font,
 * which editing it would destroy.
 */
const ICONS: Readonly<Record<IconName, IconVariants>> = {
	thinking: { "nerd-font": "\uEA61", unicode: "\u{1F9E0}", ascii: "*" }, // cod-lightbulb
	tool: { "nerd-font": "\uEAF8", unicode: "\u2699", ascii: ">" }, // cod-gear
	ok: { "nerd-font": "\uEAB2", unicode: "\u2713", ascii: "+" }, // cod-check
	error: { "nerd-font": "\uEA87", unicode: "\u2717", ascii: "x" }, // cod-error
	running: { "nerd-font": "\uEB7C", unicode: "\u23F3", ascii: "~" }, // cod-watch
	collapsed: { "nerd-font": "\uEAB6", unicode: "\u25B8", ascii: ">" }, // cod-chevron_right
	expanded: { "nerd-font": "\uEAB4", unicode: "\u25BE", ascii: "v" }, // cod-chevron_down
	fold: { "nerd-font": "\uEA7C", unicode: "\u22EF", ascii: "..." }, // cod-ellipsis
	enter: { "nerd-font": "\uEBEA", unicode: "\u23CE", ascii: "Enter" }, // cod-newline
	cancelled: { "nerd-font": "\uEA76", unicode: "\u2716", ascii: "x" }, // cod-close

	// Only the Nerd Font tier tells speakers apart by icon. The heading already
	// names the speaker in words, so the other tiers keep the single marker the
	// overlay has always drawn rather than inventing ambiguous shapes.
	speakerYou: { "nerd-font": "\uEB99", unicode: "\u25B8", ascii: ">" }, // cod-account
	speakerMain: { "nerd-font": "\uEB06", unicode: "\u25B8", ascii: ">" }, // cod-home
	speakerSupervisor: { "nerd-font": "\uEBBB", unicode: "\u25B8", ascii: ">" }, // cod-type_hierarchy_super
	speakerWorker: { "nerd-font": "\uEC20", unicode: "\u25B8", ascii: ">" }, // cod-robot
	speakerRun: { "nerd-font": "\uEB32", unicode: "?", ascii: "?" }, // cod-question

	selected: { "nerd-font": "\uEB70", unicode: "\u25B6", ascii: ">" }, // cod-triangle_right
	active: { "nerd-font": "\uEA71", unicode: "\u25C6", ascii: "*" }, // cod-circle_filled
	completed: { "nerd-font": "\uEAB2", unicode: "\u2713", ascii: "+" }, // cod-check
	paused: { "nerd-font": "\uEAD1", unicode: "\u23F8", ascii: "|" }, // cod-debug_pause
	failed: { "nerd-font": "\uEA87", unicode: "\u2717", ascii: "x" }, // cod-error
	aborted: { "nerd-font": "\uEABD", unicode: "\u2298", ascii: "!" }, // cod-circle_slash
	idle: { "nerd-font": "\uEAB2", unicode: "\u2713", ascii: "+" }, // cod-check
	constructing: { "nerd-font": "\uEB19", unicode: "\u25CC", ascii: "~" }, // cod-loading
	warning: { "nerd-font": "\uEA6C", unicode: "\u26A0", ascii: "!" }, // cod-warning
	tasks: { "nerd-font": "\uEAB3", unicode: "\u2611", ascii: "tasks" }, // cod-checklist

	taskDone: { "nerd-font": "\uEBB3", unicode: "\u25C6", ascii: "#" }, // cod-pass_filled
	taskActive: { "nerd-font": "\uEAB6", unicode: "\u25B8", ascii: ">" }, // cod-chevron_right
	taskBlocked: { "nerd-font": "\uEA6C", unicode: "\u25A0", ascii: "!" }, // cod-warning
	taskDeferred: { "nerd-font": "\uEB7C", unicode: "\u25CC", ascii: "~" }, // cod-watch
	taskPending: { "nerd-font": "\uEB8A", unicode: "\u00B7", ascii: "." }, // cod-circle_small_filled
};

/**
 * A resolved vocabulary: every marker, plus the tier that produced it.
 *
 * The tier is carried because a few formatters legitimately change more than a
 * glyph — `tasks 3/7` versus `☑3/7` is a different string, not a different
 * character — and they need to know which world they are in.
 */
export type IconSet = { readonly mode: IconMode } & Readonly<Record<IconName, string>>;

const CACHE = new Map<IconMode, IconSet>();

/** Resolve the whole vocabulary for one tier. Cached; the table is constant. */
export function iconSet(mode: IconMode): IconSet {
	const cached = CACHE.get(mode);
	if (cached) return cached;
	const resolved = { mode } as { mode: IconMode } & Record<IconName, string>;
	for (const [name, variants] of Object.entries(ICONS) as [IconName, IconVariants][]) {
		resolved[name] = variants[mode];
	}
	const frozen = Object.freeze(resolved) as IconSet;
	CACHE.set(mode, frozen);
	return frozen;
}

/**
 * The vocabulary in force, given a configured mode.
 *
 * ## What an operator actually gets, and what `whenUnset` is really for
 *
 * **A configured project always reaches here with a real value.** `loadConfig`
 * fills an absent `footerIcons` with `"nerd-font"` (since `113a4df`), so the
 * default an operator sees on every surface is Nerd Font, and `whenUnset`
 * plays no part in it.
 *
 * `whenUnset` covers the other callers: an option bag that omits `footerIcons`
 * because its host never wired config, and tests that call these functions
 * directly. Those get the conservative vocabulary each surface drew before the
 * setting reached it, rather than private-use glyphs nobody asked for.
 *
 * This distinction is documented because it was previously got wrong in the
 * other direction: the comments here claimed that adding the third tier
 * "changes nothing until someone sets it", which review finding
 * CR-ICON-UNSET-PROVENANCE showed to be false — config had already resolved
 * the default before any surface was consulted. The behaviour was right; the
 * claim about it was not. `resolves the production path` in `icons.test.ts`
 * pins what an operator really gets, so the claim cannot drift again.
 *
 * The terminal override outranks everything, configured or not: a terminal
 * that says it cannot draw gets ASCII.
 */
export function resolveIconMode(
	configured: IconMode | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
	whenUnset: IconMode = "ascii",
): IconMode {
	if (isAsciiOnlyTerminal(env)) return "ascii";
	return configured ?? whenUnset;
}

/**
 * The footer and widget tier.
 *
 * An unwired caller gets ASCII, which is what the footer drew before it had a
 * knob. A configured project gets `footerIcons`, which defaults to Nerd Font.
 */
export function resolveFooterIconMode(
	configured: IconMode | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): IconMode {
	return resolveIconMode(configured, env, "ascii");
}

/**
 * The overlay tier.
 *
 * An unwired caller gets the Unicode the overlay drew before this module. A
 * configured project gets `footerIcons`, which defaults to Nerd Font.
 */
export function resolveOverlayIconMode(
	configured: IconMode | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): IconMode {
	return resolveIconMode(configured, env, "unicode");
}

/** The overlay's resolved vocabulary, in one call. */
export function overlayIcons(
	configured: IconMode | undefined,
	env?: Readonly<Record<string, string | undefined>>,
): IconSet {
	return iconSet(resolveOverlayIconMode(configured, env));
}
