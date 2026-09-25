/**
 * Keyboard-driven overlay that surfaces delegate supervisor\u2194worker
 * transcripts and durable activity history for the active session. The overlay
 * reads live state from the runtime registry and re-renders on
 * `delegate:*` events. It never writes into session history.
 *
 * Modelled on pi-intercom/ui/session-list.ts (single-view picker overlay
 * with `ui.custom(..., { overlay: true })`) rather than the heavier
 * focus/unfocus dance in pi-interactive-shell's reattach-overlay \u2014
 * nothing here owns a pty.
 *
 * The compose/prompt area is rendered through `renderComposePlaceholder()` so
 * steering controls and worker UI prompt banners share one reserved region in
 * the overlay body.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import {
	boundActivityText,
	safeActivityToolName,
	type ActivityStatusEntry,
} from "./activity-status.js";
import {
	reduceRunDigest,
	projectRunTranscript,
	type RunActivitySummary,
	type RunRoundProjection,
} from "./fork-digest.js";
import type { RunDigest, RunFriction, RunHealth } from "./fork-digest.js";
import { renderRunEntryIdentity } from "./fork-label.js";
import {
	ascendLevelIn,
	bodyKindFor,
	descendLevelIn,
	detailLevelFor,
	resolveOverlayGeometry,
	type OverlayGeometry,
	type OverlayLevel,
	type OverlayPane,
} from "./overlay-layout.js";
import {
	buildOverlayList,
	findRow,
	firstSelectable,
	isEnterable,
	isSelectable,
	lastSelectable,
	moveSelection,
	nextOverlayViewMode,
	sortDetachedByDispatch,
	sortRunsByDispatch,
	type OverlayListRow,
	type OverlayViewMode,
	type SelectableRow,
} from "./overlay-list-model.js";
import { iconSet, overlayIcons, type IconSet } from "./icons.js";
import {
	groupHeadingText,
	headlineKey,
	renderListColumnFitted,
	type RenderListOptions,
} from "./overlay-list-render.js";
import { GUTTER_WIDTH, gutterFor } from "./overlay-summary-stack.js";
import { buildEventLog, renderEventLog } from "./overlay-event-log.js";
import {
	buildCompletion,
	completionTone,
	formatCompletionBanner,
} from "./overlay-completion.js";
import {
	buildPlanBlock,
	formatPlanCount,
	renderExpandedTaskList,
	renderStatusLegend,
	renderStatusStrip,
} from "./overlay-plan-block.js";

import {
	buildTranscriptModel,
	type WaitingSummary,
} from "./overlay-transcript-model.js";
import {
	formatClock,
	renderTranscript,
	renderWaitingRow,
} from "./overlay-transcript-render.js";
import { buildIdentitySegments, buildPolicySegments, type HeaderSegment } from "./overlay-header.js";
import { getDelegatePresentationTerminology } from "./footer-presentation.js";
import { getActivityHeadline } from "./activity-headlines.js";
import type {
	CancelReason,
	DelegateDispatchState,
	RunLiveState,
	PendingPrompt,
} from "./runtime.js";
import {
	appendTranscriptEntry,
	getPendingPrompts,
	getRun,
	isLiveStatus,
	hasLocalRunAuthority,
	isOwnedByThisProcess,
	listRuns,
	resolvePendingPrompt,
	updateRunState,
} from "./runtime.js";
import type { TranscriptEntry } from "./summarize.js";
import { runSupportsSteering } from "./transcript-speaker.js";

export { runHasSupervisor, runSupportsSteering, speakerHeading, transcriptSpeaker } from "./transcript-speaker.js";
export type { TranscriptSpeaker } from "./transcript-speaker.js";
import { formatTokensCompact } from "./usage-rollup.js";
import {
	DEFAULT_CANCEL_FORK_BYPASS_SHORTCUT,
	DEFAULT_CANCEL_FORK_SHORTCUT,
	DEFAULT_CANCEL_CONFIRM_COST_USD,
	DEFAULT_CANCEL_CONFIRM_RUNTIME_MS,
	DEFAULT_AUTO_CLOSE_INSPECTOR_ON_COMPLETE,
	DEFAULT_INSPECTOR_FOLD_MESSAGES,
	DEFAULT_INSPECTOR_THINKING,
	DEFAULT_INSPECTOR_TOOL_DETAIL,
	DEFAULT_OVERLAY_SHORTCUT,
	loadConfig,
} from "./config.js";
import type { DelegateConfig } from "./config.js";
import {
	canonicalRunShape,
	formatUniformRunStatus,
	isUniformRunLive,
	type ListAllRunStatusesResult,
	type RunEventRecord,
	type UniformRunStatus,
} from "./run-introspect.js";



/**
 * Settle window (ms) before the inspector auto-closes once all entries go
 * terminal. Absorbs a complete-then-register burst (one entry finishing while
 * another is being dispatched) so we don't flicker-close. Re-validated when
 * the timer fires. Tests pass `0` for a synchronous close.
 */
const AUTO_CLOSE_SETTLE_MS = 600;
/**
 * Settle window before the overlay HIDES because something else took the
 * keyboard.
 *
 * Shorter than the auto-close window on purpose. Auto-close absorbs a burst of
 * run activity and can afford to wait; this one is covering a prompt the
 * operator cannot see, so every extra millisecond is a millisecond of a
 * terminal that appears frozen. Long enough to ride out the focus flicker in
 * pi's own selector teardown, and no longer. Tests pass `0` to hide
 * synchronously.
 */
const FOCUS_LOSS_CLOSE_MS = 150;
/** Detached cfg/event-bus refresh cadence while the overlay is mounted. */
const DETACHED_REFRESH_INTERVAL_MS = 1_000;
const DETACHED_STATUS_HINT = " status-only · no foreground transcript · r refreshes now";
const DETACHED_CONTROL_HINT = " delegate_control(action=\"status\") for structured details · q/Esc close";

/** Per-node collapse state for thinking traces (cycled with `t`). */
export type ThinkingLevel = 0 | 1 | 2; // hidden · preview · full

/**
 * `ThinkingLevel` as the renderer's three named states.
 *
 * The level used to be flattened to a `hideThinking` boolean on the way to the
 * renderer, which silently made `full` behave exactly like `preview` while the
 * footer claimed otherwise (review finding OV-15). Naming all three states
 * here means the footer label and the rendered body read the same value.
 */
const THINKING_DETAIL: Readonly<Record<ThinkingLevel, "hidden" | "preview" | "full">> = {
	0: "hidden",
	1: "preview",
	2: "full",
};
/** Tool-chip detail state (cycled with `g`). */
export type ToolDetail = "chip" | "hidden" | "expanded";
/** Task-list detail shown in the selected fork's summary. */
export type TaskDisplayMode = "compact" | "expanded";

function runEntryNoun(runShape: string | undefined): string {
	return getDelegatePresentationTerminology(runShape).singular;
}



/**
 * Minimal subset of the pi event bus the overlay needs. Extracted as an
 * interface so the overlay unit tests can inject a stub without pulling in
 * the full ExtensionAPI.
 */
export interface OverlayEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Three composition-mode states for the compose box. */
export type ComposeFocus = "viewing" | "composing" | "banner";
/** Delivery modes for the overlay compose box, matching `DelegateDispatchState.steer`. */
export type ComposeMode = "push" | "followUp" | "queue";

/** Mutable view preferences shared by every overlay opened in one Pi session. */
export interface OverlayPreferences {
	thinkingLevel: ThinkingLevel;
	toolDetail: ToolDetail;
	taskDisplayMode: TaskDisplayMode;
	viewMode: OverlayViewMode;
	foldMessages: boolean;
}

const THINKING_LEVEL_BY_CONFIG = {
	hidden: 0,
	preview: 1,
	full: 2,
} as const satisfies Record<NonNullable<DelegateConfig["inspectorThinking"]>, ThinkingLevel>;

/** Resolve one mutable preference object for a newly started Pi session. */
export function createOverlayPreferences(config: DelegateConfig = {}): OverlayPreferences {
	return {
		thinkingLevel:
			THINKING_LEVEL_BY_CONFIG[config.inspectorThinking ?? DEFAULT_INSPECTOR_THINKING],
		toolDetail: config.inspectorToolDetail ?? DEFAULT_INSPECTOR_TOOL_DETAIL,
		taskDisplayMode: "compact",
		viewMode: "attention",
		foldMessages: config.inspectorFoldMessages ?? DEFAULT_INSPECTOR_FOLD_MESSAGES,
	};
}

/**
 * Retained only as the persisted round-selection shape while stage 2 rebuilds
 * the transcript body. Rounds are no longer a level you navigate to.
 */
export type RoundSelection = { kind: "setup" } | { kind: "round"; index: number };

/** Public state shape exposed to tests for assertions. */
export interface OverlayState {
	runs: DelegateDispatchState[];
	/** Status-only detached orchestrators (never fabricated as transcript entries). */
	detachedRuns: UniformRunStatus[];
	detachedStatusDegraded: boolean;
	detachedStatusTruncated: boolean;
	/**
	 * Index into the flat explorer list, which spans every run and the detached
	 * group. `runIndex` / `forkIndex` are derived from it for the many callers
	 * that still address a specific entry; `forkIndex` remains a v1 field.
	 */
	listIndex: number;
	runIndex: number;
	forkIndex: number;
	scrollOffset: number;
	autoScroll: boolean;
	state: "viewing" | "detached" | "empty";
	focus: ComposeFocus;
	composeMode: ComposeMode;
	composeBuffer: string;
	pendingPrompts: readonly PendingPrompt[];
	thinkingLevel: ThinkingLevel;
	toolDetail: ToolDetail;
	taskDisplayMode: TaskDisplayMode;
	viewMode: OverlayViewMode;
	/**
	 * Retained config/state field. Folding is unconditional since stage 2 —
	 * `Enter` expands one node instead — so no renderer reads this. Removing
	 * `inspectorFoldMessages` is a config-surface change and belongs with the
	 * stage-3 README rewrite, not here.
	 */
	foldMessages: boolean;
	/** How deep the explorer is: list → summary → transcript. */
	level: OverlayLevel;
	/** Which pane owns keyboard input. Meaningful only in two-pane mode. */
	pane: OverlayPane;
	/** Resolved geometry from the last render, for layout assertions. */
	geometry: OverlayGeometry;
	roundSelection: RoundSelection;
}

/**
 * Rows the header costs: top border, identity, policy, separator.
 *
 * The two content rows replace the four navigation rows the previous header
 * spent on run id, counter, view name, and entry list — all of which the left
 * column now answers. Both content rows are clipped to one line each, so this
 * stays a constant and the body budget stays predictable.
 */
const HEADER_ROWS = 4;
const FOOTER_ROWS = 3; // separator + hint + bottom-border
const MIN_BODY_ROWS = 3;
const MIN_NORMAL_ROWS = HEADER_ROWS + MIN_BODY_ROWS + FOOTER_ROWS;
const DEFAULT_BODY_ROWS = 16;
const OVERLAY_HEIGHT_FRAC = 0.8;
const COMPOSE_MODES: readonly ComposeMode[] = ["push", "followUp", "queue"];

/**
 * Who actually reads a composed message, per delivery mode. This is a
 * *recipient* choice, not just a timing one: `push` and `followUp` go to the
 * supervisor's own session, while `queue` lands in `pendingGuidance[]`, which
 * `message_subagent` prepends verbatim to the WORKER's next prompt as a
 * `<user-guidance source="user">` block (see fork-runner's worker-text build).
 */
const COMPOSE_TARGETS: Record<ComposeMode, { to: "supervisor" | "worker"; when: string }> = {
	push: { to: "supervisor", when: "interrupt now" },
	followUp: { to: "supervisor", when: "after this turn" },
	queue: { to: "worker", when: "next round, verbatim" },
};

/**
 * Map the delivery rung the runtime actually used onto its real recipient. The
 * steer ladder can fall back (`steer` → `followUp` → `queue`), and the last
 * rung changes WHO reads the message, so the confirmation reports the outcome
 * rather than what was requested.
 */
export function deliveredRecipient(delivered: string): "supervisor" | "worker" {
	return delivered === "queue" || delivered === "queued" ? "worker" : "supervisor";
}
const OPTION_O_OVERLAY_SHORTCUT = "alt+o";

interface LiveRunEntryLocation {
	runIndex: number;
	entryIndex: number;
	run: DelegateDispatchState;
	entry: RunLiveState;
}

interface OverlayBodyLines {
	lines: string[];
	selectedLine?: number;
	/** Last rendered line owned by the selection, inclusive. */
	selectedLastLine?: number;
	entryAnchors?: ReadonlyMap<number, number>;
	pageRanges?: readonly { start: number; end: number }[];
	/**
	 * Speaker heading in force at each line, so a heading that has scrolled off
	 * the top can be pinned back at the top of the pane.
	 */
	headingAt?: readonly (string | undefined)[];
	/** A live `wait_for_worker`, pinned at the foot of the pane. */
	waiting?: WaitingSummary;
}

type OverlayTheme = Pick<Theme, "bold" | "fg">;

interface OverlayTui {
	terminal: { readonly rows: number };
	requestRender(): void;
}

interface OverlayProjectionReducers {
	reduceDigest: typeof reduceRunDigest;
	projectTranscript: typeof projectRunTranscript;
}

interface RoundActivityCacheEntry {
	transcript: readonly TranscriptEntry[];
	transcriptLength: number;
	finalEntry: TranscriptEntry | undefined;
	runShape: DelegateDispatchState["shape"];
	rounds: RunRoundProjection | undefined;
	activity: RunActivitySummary;
}

interface DigestCacheEntry {
	entry: RunLiveState;
	usage: RunLiveState["usage"];
	cost: number | undefined;
	lastActivityAt: number | undefined;
	pendingGuidance: readonly string[] | undefined;
	pendingGuidanceLength: number;
	rounds: RunRoundProjection | undefined;
	activity: RunActivitySummary;
	activityHistoryLength: number;
	finalActivityEntry: ActivityStatusEntry | undefined;
	terminalResult: RunLiveState["completedResult"];
	pendingPromptFingerprint: string;
	timeBucket: number;
	runShape: DelegateDispatchState["shape"];
	runCreatedAtMs: number;
	digest: RunDigest;
}

interface RenderedBodyCacheEntry {
	level: OverlayLevel;
	/**
	 * Resolved pane geometry. A resize that crosses the two-pane threshold
	 * changes the whole pane structure, not just a width, so the mode belongs
	 * in the key alongside the widths it implies.
	 */
	layoutMode: OverlayGeometry["mode"];
	listWidth: number;
	detailWidth: number;
	/** Which pane is focused, which changes the rendered highlight. */
	pane: OverlayPane;
	/** Selection into the flat list, which the left column renders from. */
	listIndex: number;
	width: number;
	innerWidth: number;
	textWidth: number;
	bodyHeight: number;
	runIndex: number;
	forkIndex: number;
	roundSelection: RoundSelection;
	scrollOffset: number;
	autoScroll: boolean;
	thinkingLevel: ThinkingLevel;
	toolDetail: ToolDetail;
	taskDisplayMode: TaskDisplayMode;
	foldMessages: boolean;
	timeBucket: number;
	projectionIdentity: object | undefined;
	entryIdentity: RunLiveState | undefined;
	activityHistory: readonly ActivityStatusEntry[] | undefined;
	activityHistoryLength: number;
	finalActivityEntry: ActivityStatusEntry | undefined;
	body: OverlayBodyLines;
}

type RenderedBodyCacheKey = Omit<RenderedBodyCacheEntry, "body">;

function runEntryProjectionKey(runId: string, entryName: string): string {
	return JSON.stringify([runId, entryName]);
}

/**
 * A Markdown theme for transcript prose.
 *
 * `getMarkdownTheme()` throws when pi's ambient theme has not been initialised,
 * which is true in unit tests and in any host that never called `initTheme`.
 * The overlay must not crash for want of colour, so the ambient theme is used
 * when available and otherwise built from the overlay's own theme — the same
 * one every other line in the pane is painted with.
 */
function resolveMarkdownTheme(theme: OverlayTheme): MarkdownTheme {
	try {
		const ambient = getMarkdownTheme();
		// `getMarkdownTheme()` returns lazily-bound accessors: it can succeed
		// while every function on it still throws "Theme not initialized" the
		// first time the Markdown component calls one, mid-render. Probe
		// before trusting the whole theme.
		//
		// Probing one accessor is not enough — a theme can bind `bold` while
		// another accessor is still unbound, which passes a one-call probe and
		// then throws inside `Markdown.render`. These are the accessors prose
		// actually reaches, so exercising them is what makes the probe mean
		// something (review finding OV-11).
		// Called as methods, not as detached function references: an accessor
		// that depends on `this` would otherwise throw here and send a
		// perfectly good theme down the fallback path.
		ambient.bold("probe");
		ambient.italic("probe");
		ambient.code("probe");
		ambient.heading("probe");
		ambient.listBullet("probe");
		ambient.link("probe");
		return ambient;
	} catch {
		const fg = (role: string) => (text: string) => theme.fg(role as never, text);
		return {
			heading: (text) => theme.bold(theme.fg("accent", text)),
			link: fg("accent"),
			linkUrl: fg("dim"),
			code: fg("accent"),
			codeBlock: fg("text"),
			codeBlockBorder: fg("dim"),
			quote: fg("dim"),
			quoteBorder: fg("dim"),
			hr: fg("dim"),
			listBullet: fg("accent"),
			bold: (text) => theme.bold(text),
			italic: fg("text"),
			strikethrough: fg("dim"),
			underline: fg("text"),
		};
	}
}

/** Whether two persisted round selections refer to the same place. */
function sameRoundSelection(a: RoundSelection, b: RoundSelection): boolean {
	if (a.kind === "setup" || b.kind === "setup") return a.kind === b.kind;
	return a.index === b.index;
}

/** A terminal entry with an unresolved worker prompt still needs attention. */
function entryNeedsAttention(run: DelegateDispatchState, entry: RunLiveState): boolean {
	return getPendingPrompts(run.runId, entry.name).length > 0;
}

function pendingPromptFingerprint(prompts: readonly PendingPrompt[]): string {
	const counts = new Map<string, number>();
	for (const prompt of prompts) counts.set(prompt.kind, (counts.get(prompt.kind) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([kind, count]) => `${kind}:${count}`)
		.join("|");
}

function boundedExchangeText(value: string): string {
	return boundActivityText(sanitizeTranscriptText(value));
}

function formatDigestHealth(health: RunHealth): string {
	switch (health.kind) {
		case "terminal": return "terminal";
		case "blocked": {
			const reason = health.reason === "worker-prompt" ? "worker prompt" : "escalation";
			const count = health.count !== undefined && health.count > 1 ? ` (${health.count})` : "";
			return `blocked · ${reason}${count}`;
		}
		case "slow": return `slow · silent ${formatToolDuration(health.silentMs)} · threshold ${formatToolDuration(health.thresholdMs)}`;
		case "stalled": return `stalled · silent ${formatToolDuration(health.silentMs)} · threshold ${formatToolDuration(health.thresholdMs)}`;
		case "moving": return "moving";
	}
}

function formatDigestFriction(signal: RunFriction): string {
	switch (signal.kind) {
		case "blocked":
			return signal.reason === "worker-prompt"
				? `blocked on worker prompt${signal.count && signal.count > 1 ? ` (${signal.count})` : ""}`
				: "blocked on escalation";
		case "model-refusal":
			return signal.fallback
				? `model fallback${signal.modelCount > 0 ? ` (${signal.modelCount})` : ""}`
				: `model refusal${signal.modelCount > 0 ? ` (${signal.modelCount})` : ""}`;
		case "wind-down": return `wind-down (${signal.reason})`;
		case "paused": return "paused";
		case "tool-error-streak": return `${signal.count} consecutive worker tool errors`;
		case "repeated-call": {
			const toolName = safeActivityToolName(signal.toolName) ?? "tool";
			return `repeated ${toolName} ×${signal.repetitions}`;
		}
		case "re-ask": return `re-asked ${signal.count}×`;
	}
}

function digestFrictionText(digest: RunDigest, all: boolean): string {
	const signals = all ? digest.friction : digest.friction.slice(0, 1);
	return signals.length === 0
		? "none"
		: signals.map((signal) => boundActivityText(formatDigestFriction(signal))).join(" · ");
}

function formatDigestElapsed(digest: RunDigest): string {
	const { usedMs, limitMs } = digest.consumption.elapsed;
	if (usedMs === undefined) return limitMs === undefined ? "unknown" : `unknown/${formatToolDuration(limitMs)}`;
	const used = formatToolDuration(usedMs);
	return limitMs === undefined ? used : `${used}/${formatToolDuration(limitMs)}`;
}

function formatDigestUsage(digest: RunDigest): string {
	return `tokens ${formatTokensCompact(digest.consumption.usage.totalTokens)} · cost $${digest.consumption.usage.cost.toFixed(3)}`;
}

function formatDigestHeartbeat(digest: RunDigest): string | undefined {
	const heartbeat = digest.consumption.heartbeat;
	if (!heartbeat.applicable) return undefined;
	if (!heartbeat.enabled) return "heartbeat off";
	const silence = heartbeat.silentMs === undefined ? "unknown" : formatToolDuration(heartbeat.silentMs);
	return `heartbeat silence ${silence} · slow ${formatToolDuration(heartbeat.slowAfterMs)} · stall ${formatToolDuration(heartbeat.stalledAfterMs)}`;
}

function wrappedExchangeRows(label: string, value: string, width: number, maxLines: number): string[] {
	const prefix = `  ${label}: `;
	const continuation = " ".repeat(visibleWidth(prefix));
	const textWidth = Math.max(4, width - visibleWidth(prefix));
	const wrapped = wrapTextWithAnsi(boundedExchangeText(value), textWidth);
	const shown = wrapped.slice(0, Math.max(1, maxLines));
	if (wrapped.length > shown.length) {
		shown[shown.length - 1] = truncateToWidth(`${shown[shown.length - 1]}…`, textWidth, "…");
	}
	return shown.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function isOptionOOverlayShortcut(data: string): boolean {
	return matchesKey(data, OPTION_O_OVERLAY_SHORTCUT);
}

export class TranscriptOverlay implements Component, Focusable {
	/**
	 * Keyboard focus, written by pi-tui.
	 *
	 * ## Why this is an accessor rather than a field
	 *
	 * The inspector is a *capturing* overlay: it covers the screen and takes
	 * every key. When something else takes focus while it is mounted — an
	 * escalation prompt, a confirm dialog, another extension's selector — that
	 * something renders in pi's editor container, which is *underneath* this
	 * overlay. The result is the worst of both worlds: the prompt holds the
	 * keyboard but cannot be seen, and the overlay can be seen but answers no
	 * key, including the one that would close it. There is no way out short of
	 * killing the session.
	 *
	 * pi-tui's `setFocusInternal` clears `focused` on the component it is
	 * leaving, so that assignment is the exact moment the trap springs — and
	 * the only signal available to a component that no longer receives input.
	 * Making it a setter is what lets the overlay notice at all.
	 */
	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		const lost = this.focusedValue && !value;
		this.focusedValue = value;
		if (value) {
			// Focus came back on its own; whatever took it did not keep it.
			this.cancelFocusLossClose();
			return;
		}
		if (lost) this.scheduleFocusLossClose();
	}

	private focusedValue = true;
	/**
	 * The host's handle for this overlay entry, once it has been shown.
	 *
	 * Absent until the host calls back, and absent entirely in tests that mount
	 * the component directly. Every use is optional for that reason.
	 */
	private hostHandle: InspectorOverlayHandle | undefined;
	/** Hidden by the focus-loss guard; still mounted, and restorable. */
	private hidden = false;
	/** Removed from the host stack by identity; not restorable. */
	private dismissed = false;
	/** Torn down. Guards `dispose()`, which several paths can reach. */
	private disposed = false;
	private readonly onDismissed: (() => void) | undefined;
	private focusLossTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly focusLossCloseMs: number;
	private readonly onFocusLossClose: (() => void) | undefined;

	private tui: OverlayTui;
	private theme: OverlayTheme;
	/** Provided by pi.ui.custom() \u2014 unused today but required by the signature. */
	private readonly keybindings: KeybindingsManager | undefined;
	/**
	 * The host's resolve callback. **Deliberately never called.**
	 *
	 * Resolving makes the host call pi-tui's `hideOverlay()`, which pops the
	 * TAIL of the overlay stack — never provably this component, because
	 * `showOverlay` pushes every entry but focuses only when `!nonCapturing`
	 * (`tui.js:286-300`). Every exit goes through `close()` → `dismiss()`,
	 * which removes this entry by identity instead.
	 *
	 * Retained only because `ui.custom`'s factory signature supplies it, and
	 * because a `dispose()` reaching the host still needs the parameter in
	 * place. If you are about to call this, call `close()` instead: four
	 * keyboard exits called it directly through three rounds of fixing
	 * `close()`, which is exactly how `CR-HOST-PROMISE-STILL-RESOLVES` outlived
	 * the fix that was supposed to close it.
	 */
	private readonly done: (result: undefined) => void;

	// State (observable via `getState()` for tests).
	private runs: DelegateDispatchState[] = [];
	private detachedRuns: UniformRunStatus[] = [];
	private detachedStatusDegraded = false;
	private detachedStatusTruncated = false;
	/**
	 * Selection into the flat explorer list. This is the authoritative cursor;
	 * `runIndex` and `forkIndex` are kept in step with it so the many existing
	 * callers that address a run or an entry keep working; `forkIndex` is retained
	 * as a v1 compatibility field.
	 */
	private listIndex = 0;
	private runIndex = 0;
	private forkIndex = 0;
	private scrollOffset = 0;
	private autoScroll = true;
	private level: OverlayLevel = "list";
	private pane: OverlayPane = "list";
	/** Geometry from the most recent render, reused by input handlers. */
	private geometry: OverlayGeometry = resolveOverlayGeometry(0);
	/** The explorer list as of the last rebuild. */
	private listRows: OverlayListRow[] = [];
	/** Scroll offset for the left column, independent of the detail pane. */
	private listScrollOffset = 0;
	/**
	 * The node the operator has expanded with `Enter`, if any.
	 *
	 * The redesign replaces a global fold toggle with an explorer gesture:
	 * folding is always on, and you expand the one node you want.
	 *
	 * Scoped to the run entry it was made in, not stored as a bare entry index.
	 * A bare index silently applied to whichever run entry was selected next, so
	 * expanding entry 0 in one run entry auto-expanded entry 0 in another (review
	 * finding OV-16). Carrying the owner makes that impossible rather than
	 * relying on every selection mover remembering to clear it.
	 */
	private expanded: { runId: string; forkName: string; entryIndex: number } | undefined;
	/**
	 * Markdown theme for transcript prose. Resolved once per overlay: it reads
	 * the ambient pi theme, which a render pass must not depend on.
	 */
	private readonly markdownTheme: MarkdownTheme;
	private roundSelection: RoundSelection = { kind: "setup" };

	// Compose / banner state.
	private focus: ComposeFocus = "viewing";
	private composeMode: ComposeMode = "push";
	private composeBuffer = "";
	private lastComposeStatus: string | undefined;
	/** Unique owner of an in-flight steer, so its completion cannot clear a newer draft for the same target. */
	private steerOperationOwner: object | undefined;
	/** Unique owner of an in-flight cancellation status, so identical later operations cannot be cleared by an older completion. */
	private cancelStatusOwner: object | undefined;

	// Structured-view state lives in one mutable object per Pi session so close /
	// reopen keeps the operator's choices without leaking them into a new session.
	private readonly preferences: OverlayPreferences;
	/** Marker vocabulary in force for this mount. */
	private readonly icons: IconSet;
	private get thinkingLevel(): ThinkingLevel {
		return this.preferences.thinkingLevel;
	}
	private set thinkingLevel(value: ThinkingLevel) {
		this.preferences.thinkingLevel = value;
	}
	private get toolDetail(): ToolDetail {
		return this.preferences.toolDetail;
	}
	private set toolDetail(value: ToolDetail) {
		this.preferences.toolDetail = value;
	}
	private get taskDisplayMode(): TaskDisplayMode {
		return this.preferences.taskDisplayMode;
	}
	private set taskDisplayMode(value: TaskDisplayMode) {
		this.preferences.taskDisplayMode = value;
	}
	private get viewMode(): OverlayViewMode {
		return this.preferences.viewMode;
	}
	private set viewMode(value: OverlayViewMode) {
		this.preferences.viewMode = value;
	}
	private get foldMessages(): boolean {
		return this.preferences.foldMessages;
	}
	private set foldMessages(value: boolean) {
		this.preferences.foldMessages = value;
	}
	// Output-line indices where each message node begins, captured by the
	// structured renderer so `[` / `]` can jump message-to-message.
	private entryAnchors: ReadonlyMap<number, number> = new Map();
	private pageRanges: readonly { start: number; end: number }[] = [];
	private lastTextWidth = 78;

	// Debounced render pipeline.
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly renderDebounceMs: number;
	// Last known body height, used to page and to clamp scrollOffset.
	private lastBodyHeight = MIN_BODY_ROWS;
	// Layer projection data separately from rendered body lines. Transcript
	// identity/shape changes invalidate reducers; view/layout changes do not.
	private readonly roundActivityCache = new Map<string, RoundActivityCacheEntry>();
	private readonly digestCache = new Map<string, DigestCacheEntry>();
	private digestProjections: ReadonlyMap<string, {
		rounds?: RunRoundProjection;
		digest: RunDigest;
	}> = new Map();
	private digestProjectionIdentity: object = {};
	private digestStructureFingerprint = "";
	private renderedBodyCache: RenderedBodyCacheEntry | undefined;

	// Event subscription unsubscribers. Populated only when an event bus is
	// passed in; unit tests that don't care about live events omit it.
	private readonly unsubs: Array<() => void> = [];

	// ── Auto-close-on-completion state ──────────────────────────────────────
	// Whether the inspector should auto-dismiss once every owned entry is
	// terminal. Sourced from config; overridable per-construction for tests.
	private readonly autoCloseOnComplete: boolean;
	// Settle window (ms) before the auto-close fires. `0` closes synchronously.
	private readonly autoCloseSettleMs: number;
	// Latch: have we observed at least one live entry during this overlay's
	// lifetime? Auto-close only fires on the
	// live→all-terminal transition, so opening over an already-finished run
	// (latch never set) leaves the overlay open for review.
	private sawRunningEntry = false;
	/** The first non-close key after identity loss belongs to the removed row, not its fallback. */
	private discardNextInputAfterSelectionLoss = false;
	/** An armed compose/cancel interaction keeps auto-close deferred until that key arrives. */
	private autoCloseDeferredAfterTargetInteractionLoss = false;
	// Pending settle timer for a scheduled auto-close, if any.
	private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly detachedEvents?: (runId: string) => {
		events: RunEventRecord[];
		truncated: boolean;
	};
	private readonly detachedStatuses:
		| (() => UniformRunStatus[] | ListAllRunStatusesResult)
		| undefined;
	private readonly detachedRefreshIntervalMs: number;
	private detachedRefreshTimer: ReturnType<typeof setInterval> | null = null;
	private readonly now: () => number;
	private readonly projectionReducers: OverlayProjectionReducers;
	private readonly onRenderedBodyCacheMiss: ((level: OverlayLevel) => void) | undefined;
	/**
	 * The host overlay's `maxHeight`, which the compositor applies to this
	 * component's output after it renders. Undefined when unmounted or in tests
	 * that do not model the host clip.
	 */
	private readonly hostMaxHeight: number | `${number}%` | undefined;

	constructor(
		tui: OverlayTui,
		theme: OverlayTheme,
		keybindings: KeybindingsManager | undefined,
		done: (result: undefined) => void,
		options?: {
			refreshDebounceMs?: number;
			events?: OverlayEventBus;
			autoCloseOnComplete?: boolean;
			autoCloseSettleMs?: number;
			/** Owner-scoped detached status provider wired by index.ts. */
			detachedStatuses?: () => UniformRunStatus[] | ListAllRunStatusesResult;
			detachedEvents?: (runId: string) => {
				events: RunEventRecord[];
				truncated: boolean;
			};
			/** Set to 0 in deterministic tests to disable the periodic refresh. */
			detachedRefreshIntervalMs?: number;
			/** Injected wall clock used by one render and its time projections. */
			now?: () => number;
			/** Narrow test seam for measuring projection-cache behavior. */
			projectionReducers?: Partial<OverlayProjectionReducers>;
			/** Narrow test seam for measuring rendered-body cache misses. */
			onRenderedBodyCacheMiss?: (level: OverlayLevel) => void;
			/**
			 * The host overlay's `maxHeight`, mirrored from the options this
			 * component is mounted with. The host clips rendered lines to this
			 * height *after* the component returns them, so row budgeting must
			 * account for it or the clipped rows are silently discarded.
			 */
			hostMaxHeight?: number | `${number}%`;
			/** Shared session preferences; mutations are retained across reopen. */
			preferences?: OverlayPreferences;
			/**
			 * Marker vocabulary, resolved from `footerIcons` by the caller.
			 * Defaults to `unicode`, which is what the overlay drew before the
			 * setting reached it.
			 */
			icons?: IconSet;
			/**
			 * Settle window before closing after focus is taken. Zero closes
			 * immediately, which is what the unit tests use.
			 */
			focusLossCloseMs?: number;
			/**
			 * Called after the overlay hides because focus was taken. The
			 * extension uses it to tell the operator where the keyboard went,
			 * and how to bring it back.
			 */
			onFocusLossClose?: () => void;
			/**
			 * Called when the overlay removed itself from the host stack by
			 * identity rather than by resolving its promise.
			 *
			 * The extension's `openOverlay` does its bookkeeping in the
			 * promise's `finally`, which never runs on that path, so this is
			 * where `isOpen` and `mountedInstance` get cleared instead.
			 */
			onDismissed?: () => void;
		},
	) {
		this.tui = tui;
		this.theme = theme;
		this.markdownTheme = resolveMarkdownTheme(theme);
		this.keybindings = keybindings;
		this.done = done;
		this.preferences = options?.preferences ?? createOverlayPreferences();
		this.icons = options?.icons ?? iconSet("unicode");
		this.focusLossCloseMs = options?.focusLossCloseMs ?? FOCUS_LOSS_CLOSE_MS;
		this.onFocusLossClose = options?.onFocusLossClose;
		this.onDismissed = options?.onDismissed;
		this.renderDebounceMs = options?.refreshDebounceMs ?? 50;
		this.autoCloseOnComplete =
			options?.autoCloseOnComplete ?? DEFAULT_AUTO_CLOSE_INSPECTOR_ON_COMPLETE;
		this.autoCloseSettleMs = options?.autoCloseSettleMs ?? AUTO_CLOSE_SETTLE_MS;
		this.detachedStatuses = options?.detachedStatuses;
		this.detachedEvents = options?.detachedEvents;
		this.detachedRefreshIntervalMs =
			options?.detachedRefreshIntervalMs ?? DETACHED_REFRESH_INTERVAL_MS;
		this.now = options?.now ?? Date.now;
		this.projectionReducers = {
			reduceDigest: options?.projectionReducers?.reduceDigest ?? reduceRunDigest,
			projectTranscript: options?.projectionReducers?.projectTranscript ?? projectRunTranscript,
		};
		this.onRenderedBodyCacheMiss = options?.onRenderedBodyCacheMiss;
		this.hostMaxHeight = options?.hostMaxHeight;
		// Snapshot runs and pick the default selection per spec:
		// first active run \u2192 else first completed run \u2192 else empty.
		this.refreshRuns(/*resetSelection*/ true);

		// Subscribe to runtime events. We coalesce all state-changing channels
		// through a single debounced re-render path so event bursts don't thrash
		// the TUI. register/complete are listened to separately from update
		// because runtime.ts emits them on dedicated channels, not through
		// update.
		if (options?.events) {
			const onAnyUpdate = () => {
				this.refreshRuns();
				this.scheduleRender();
				this.maybeAutoClose();
			};
			const onTranscript = () => {
				this.invalidate();
				// The left column renders from entry objects and activity
				// headlines, both of which these events change. Without this the
				// list would show a stale snapshot beside a freshly-rendered
				// detail pane — a new entry missing, or a status glyph left on
				// `running` after the entry failed.
				this.rebuildList();
				this.scheduleRender();
				this.maybeAutoClose();
			};
			this.unsubs.push(options.events.on("delegate:update", onAnyUpdate));
			this.unsubs.push(options.events.on("delegate:register", onAnyUpdate));
			this.unsubs.push(options.events.on("luthen.delegate.complete", onAnyUpdate));
			this.unsubs.push(
				options.events.on("delegate:transcript-append", onTranscript),
			);
			// Activity history is a separate display projection. Refresh the
			// inspector without treating it as transcript input or re-evaluating
			// lifecycle/autoclose ownership.
			this.unsubs.push(
				options.events.on("delegate:activity-status", () => {
					this.invalidate();
					this.rebuildList();
					this.scheduleRender();
				}),
			);
			// Phase 3 — compose / prompt-banner channels.
			this.unsubs.push(options.events.on("delegate:prompt-pending", onTranscript));
			this.unsubs.push(options.events.on("delegate:prompt-resolved", onTranscript));
			this.unsubs.push(options.events.on("delegate:guidance-queued", onAnyUpdate));
			this.unsubs.push(options.events.on("delegate:guidance-drained", onAnyUpdate));
			this.unsubs.push(options.events.on("luthen.delegate.guidance_delivered", onTranscript));
			this.unsubs.push(options.events.on("luthen.delegate.worker_notify", onTranscript));
		}

		// Seed the live-entry latch from the mount-time snapshot so a single
		// short-lived entry that completes after mount still triggers auto-close
		// (its terminal event arrives when it is already terminal, so the latch
		// must have been set earlier). If everything is already terminal at
		// mount the latch stays false and we never auto-close — the user opened
		// the inspector to review a finished run.
		this.updateLiveLatch();
		this.startDetachedRefresh();
	}

	/**
	 * Begin polling durable detached status, if this session has that seam.
	 *
	 * Extracted from the constructor so `restore()` can restart it: a hidden
	 * overlay stops polling, and coming back has to resume it or the detached
	 * rows would sit frozen at whatever they said when it went away.
	 */
	private startDetachedRefresh(): void {
		if (this.detachedRefreshTimer) return;
		if (!this.detachedStatuses || this.detachedRefreshIntervalMs <= 0) return;
		this.detachedRefreshTimer = setInterval(() => {
			this.refreshRuns();
			this.scheduleRender();
			this.maybeAutoClose();
		}, this.detachedRefreshIntervalMs);
		(this.detachedRefreshTimer as unknown as { unref?: () => void }).unref?.();
	}

	/** Exposed for tests. */
	getState(): OverlayState {
		return {
			runs: this.runs,
			detachedRuns: this.detachedRuns,
			detachedStatusDegraded: this.detachedStatusDegraded,
			detachedStatusTruncated: this.detachedStatusTruncated,
			listIndex: this.listIndex,
			runIndex: this.runIndex,
			forkIndex: this.forkIndex,
			scrollOffset: this.scrollOffset,
			autoScroll: this.autoScroll,
			state:
				this.runs.length > 0
					? "viewing"
					: this.detachedRuns.length > 0
						? "detached"
						: "empty",
			focus: this.focus,
			composeMode: this.composeMode,
			composeBuffer: this.composeBuffer,
			pendingPrompts: this.currentPendingPrompts(),
			thinkingLevel: this.thinkingLevel,
			toolDetail: this.toolDetail,
			taskDisplayMode: this.taskDisplayMode,
			viewMode: this.viewMode,
			foldMessages: this.foldMessages,
			level: this.level,
			pane: this.pane,
			geometry: this.geometry,
			roundSelection: this.roundSelection,
		};
	}

	/**
	 * Receive the host's handle for this overlay entry.
	 *
	 * Called once, after the host has shown the overlay. The handle is what
	 * lets the focus-loss guard hide THIS entry rather than resolving the
	 * promise and letting the host pop whatever is topmost.
	 */
	attachHostHandle(handle: InspectorOverlayHandle): void {
		this.hostHandle = handle;
		// A handle arriving while hidden would strand the overlay off screen.
		// It cannot happen in the current wiring, and costs one line to rule out.
		if (this.hidden) this.restore();
	}

	/** Hidden by the focus-loss guard rather than closed. */
	isHidden(): boolean {
		return this.hidden;
	}

	/**
	 * Take this overlay off screen deliberately, without unmounting it.
	 *
	 * For a caller that is about to show something the operator must see and
	 * answer — an escalation prompt above all. Distinct from the focus-loss
	 * path, which reaches the same state but also tells the operator where the
	 * keyboard went; here the caller knows, because it is the caller.
	 */
	hideForHost(): void {
		if (this.hidden) return;
		this.cancelAutoClose();
		this.cancelFocusLossClose();
		this.stopDetachedRefresh();
		this.hidden = true;
		try {
			this.hostHandle?.setHidden(true);
		} catch {
			/* the host owns this; a throw must not take the session with it. */
		}
	}

	/**
	 * Put a hidden overlay back on screen.
	 *
	 * The counterpart to the focus-loss hide: same instance, same scroll
	 * position, same selection. Reopening through the handle is what makes
	 * hiding acceptable — a hidden overlay nobody can restore would be the
	 * stuck state this design has to avoid.
	 */
	restore(): void {
		if (!this.hidden) return;
		this.hidden = false;
		try {
			this.hostHandle?.setHidden(false);
		} catch {
			/* the host owns this; a throw must not take the session with it. */
		}
		this.startDetachedRefresh();
		this.scheduleRender();
	}

	/**
	 * Public unmount hook, for callers outside the component (the
	 * `/delegate-inspector` slash command) and for every exit inside it.
	 *
	 * Equivalent to pressing `q` or `Esc` while viewing. It does NOT resolve
	 * the `ctx.ui.custom` promise — see `dismiss()` for why nothing does. The
	 * extension learns about the unmount through `onDismissed`.
	 */
	close(): void {
		this.dismiss();
	}

	/**
	 * Unmount this overlay: remove its own stack entry, then dispose itself.
	 *
	 * ## Why nothing resolves the host promise any more
	 *
	 * Resolving makes the host call pi-tui's `hideOverlay()`, which pops the
	 * **tail** of the overlay stack. Two earlier attempts tried to carve out a
	 * case where the tail is provably us:
	 *
	 * 1. Only the focus-loss guard avoided resolving. Option-O, auto-close and
	 *    disposal still resolved from behind a prompt.
	 * 2. Only `q`/`Esc` resolved, on the theory that a focused capturing
	 *    overlay is necessarily topmost. **That theory is false.**
	 *    `showOverlay` pushes every entry unconditionally and focuses only when
	 *    `!nonCapturing` (`tui.js:286-300`), so a later non-capturing overlay
	 *    sits above a focused one without taking focus. The tail is never
	 *    provably this component.
	 *
	 * So there is no safe resolve, and this is the only exit. `handle.hide()`
	 * splices by identity (`overlayStack.indexOf(entry)`), which can only ever
	 * remove this entry however the stack is arranged.
	 *
	 * ## Why it disposes itself
	 *
	 * The host calls `component.dispose()` from inside its close callback
	 * (`interactive-mode.js:2148`), which runs only on resolution. Nothing
	 * resolves now, so this must dispose itself or leak every event
	 * subscription and cache it holds — the leak review found in round three.
	 *
	 * The `ui.custom` promise is left pending for the life of the session.
	 * That is a real cost, taken knowingly: the alternative is handing the host
	 * a pop it cannot aim, which is how an unrelated prompt gets dismissed.
	 * The extension does its own bookkeeping through `onDismissed`.
	 *
	 * Idempotent: every caller may be racing another.
	 */
	private dismiss(): void {
		if (this.dismissed) return;
		this.dismissed = true;
		this.hidden = false;
		try {
			this.hostHandle?.hide();
		} catch {
			/* the host owns this; teardown must proceed regardless. */
		}
		// Before the callback: the extension may drop its last reference to
		// this component, and disposal must not depend on still being reachable.
		this.dispose();
		this.onDismissed?.();
	}

	// ── Hide-on-focus-loss ──────────────────────────────────────────────────
	/**
	 * Get out of the way because something else took the keyboard.
	 *
	 * Deferred by a short settle window rather than fired on the spot, because
	 * focus legitimately moves and comes straight back: pi's own selector
	 * teardown restores focus to the editor and then to the topmost overlay,
	 * and a component that hid on the first `focused = false` would vanish
	 * during an ordinary flicker. The window is short enough that a real prompt
	 * is never left unreadable for long.
	 *
	 * Hiding, rather than unmounting, keeps the operator's scroll position and
	 * selection: `Option-O` restores the same instance. The stuck-invisible
	 * risk this trades against is covered by `restore()` and by `Option-O`
	 * unhiding rather than toggling closed.
	 */
	private scheduleFocusLossClose(): void {
		if (this.focusLossTimer) return;
		if (this.focusLossCloseMs <= 0) {
			this.handleFocusLoss();
			return;
		}
		this.focusLossTimer = setTimeout(() => {
			this.focusLossTimer = null;
			this.handleFocusLoss();
		}, this.focusLossCloseMs);
		(this.focusLossTimer as any).unref?.();
	}

	/**
	 * Get out of the way, because something else has the keyboard.
	 *
	 * ## Why this hides rather than unmounts (review finding CR-OVERLAY-CLOSE-TOPMOST)
	 *
	 * Unmounting is available — `dismiss()` removes this entry by identity —
	 * but it throws away the operator's scroll position and selection over a
	 * prompt they did not ask for. Hiding keeps the instance so `Option-O`
	 * brings back exactly what was on screen.
	 *
	 * Neither path may resolve the host's `ui.custom` promise: the host answers
	 * that by calling pi-tui's `hideOverlay()`, which pops whatever sits at the
	 * TOP of the overlay stack, and `showOverlay` pushes every entry while
	 * focusing only non-`nonCapturing` ones (`tui.js:286-300`), so the tail is
	 * never provably this component.
	 *
	 * Hiding through the host's handle names this entry and nothing else. The
	 * promise is never resolved, so `hideOverlay()` is never reached, and no
	 * other overlay can be affected however the stack is arranged.
	 *
	 * `q` and `Esc` unmount the overlay for real rather than hiding it, but
	 * they take the same identity-removal route: focus does not prove this
	 * entry is the stack's tail, so there is no exit that may resolve.
	 */
	private handleFocusLoss(): void {
		// Re-check: focus may have returned inside the settle window, in which
		// case the setter already cancelled the timer, but a queued callback can
		// still arrive after a cancel on some runtimes.
		if (this.focusedValue) return;
		this.hideForHost();
		// After the hide, not before: the callback reacts to an overlay that is
		// already off the screen.
		this.onFocusLossClose?.();
	}

	private cancelFocusLossClose(): void {
		if (!this.focusLossTimer) return;
		clearTimeout(this.focusLossTimer);
		this.focusLossTimer = null;
	}

	private stopDetachedRefresh(): void {
		if (!this.detachedRefreshTimer) return;
		clearInterval(this.detachedRefreshTimer);
		this.detachedRefreshTimer = null;
	}

	// ── Auto-close-on-completion ────────────────────────────────────────────
	/**
	 * Latch that we've seen in-flight work this session. Once set it stays set,
	 * which is what distinguishes a genuine live→terminal transition (auto-close)
	 * from opening the inspector over an already-finished run (stay open).
	 */
	private updateLiveLatch(): void {
		if (!this.autoCloseOnComplete || this.sawRunningEntry) return;
		for (const run of this.runs) {
			for (const entry of Object.values(run.forks)) {
				if (isLiveStatus(entry.status)) {
					this.sawRunningEntry = true;
					return;
				}
			}
		}
		if (this.detachedRuns.some(isUniformRunLive)) this.sawRunningEntry = true;
	}

	/**
	 * Re-evaluate auto-close after any state change. Updates the live-entry
	 * latch, then schedules (or cancels) a settle-debounced dismissal. Called
	 * from the event handlers and after compose/steer interactions resolve.
	 */
	private maybeAutoClose(): void {
		if (!this.autoCloseOnComplete) return;
		this.updateLiveLatch();
		if (this.shouldAutoCloseNow()) this.scheduleAutoClose();
		else this.cancelAutoClose();
	}

	/**
	 * True when every gate for auto-close is satisfied right now: enabled, we
	 * previously saw a live entry, there's ≥1 owned entry, none are still live,
	 * the user isn't composing, and no worker prompt is pending. Re-checked
	 * both when scheduling and when the settle timer fires.
	 */
	private shouldAutoCloseNow(): boolean {
		if (!this.autoCloseOnComplete || !this.sawRunningEntry) return false;
		if (this.focus === "composing") return false;
		if (this.autoCloseDeferredAfterTargetInteractionLoss) return false;
		if (this.runs.length === 0 && this.detachedRuns.length === 0) return false;
		let anyEntry = false;
		for (const run of this.runs) {
			for (const entry of Object.values(run.forks)) {
				anyEntry = true;
				if (isLiveStatus(entry.status)) return false;
			}
		}
		const anyDetached = this.detachedRuns.length > 0;
		if (this.detachedRuns.some(isUniformRunLive)) return false;
		if (!anyEntry && !anyDetached) return false;
		if (this.hasAnyPendingPrompt()) return false;
		return true;
	}

	/** Any pending worker prompt across owned runs blocks auto-close. */
	private hasAnyPendingPrompt(): boolean {
		for (const run of this.runs) {
			for (const entry of Object.values(run.forks)) {
				if (getPendingPrompts(run.runId, entry.name).length > 0) return true;
			}
		}
		return false;
	}

	private scheduleAutoClose(): void {
		if (this.autoCloseSettleMs <= 0) {
			this.close();
			return;
		}
		if (this.autoCloseTimer) return; // already scheduled
		this.autoCloseTimer = setTimeout(() => {
			this.autoCloseTimer = null;
			// State may have changed during the settle window (e.g. a new entry
			// registered) — re-validate before actually dismissing.
			if (this.shouldAutoCloseNow()) this.close();
		}, this.autoCloseSettleMs);
		(this.autoCloseTimer as any).unref?.();
	}

	private cancelAutoClose(): void {
		if (this.autoCloseTimer) {
			clearTimeout(this.autoCloseTimer);
			this.autoCloseTimer = null;
		}
	}

	/** Cycle thinking visibility: hidden → preview → full. Bound to `t`. */
	cycleThinking(): void {
		this.thinkingLevel = (((this.thinkingLevel + 1) % 3) as ThinkingLevel);
		this.invalidate();
		this.scheduleRender();
	}

	/** Cycle tool-chip detail: chip → hidden → expanded. Bound to `g`. */
	cycleToolDetail(): void {
		this.toolDetail =
			this.toolDetail === "chip" ? "hidden" : this.toolDetail === "hidden" ? "expanded" : "chip";
		this.invalidate();
		this.scheduleRender();
	}

	/** Toggle selected-summary task detail. Bound to mnemonic `p` for plan. */
	cycleTaskDisplay(): void {
		this.taskDisplayMode = this.taskDisplayMode === "compact" ? "expanded" : "compact";
		this.invalidate();
		this.scheduleRender();
	}

	/** Pending prompts on the currently-focused entry. */
	private currentPendingPrompts(): readonly PendingPrompt[] {
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) return [];
		return getPendingPrompts(run.runId, entry.name);
	}

	/**
	 * Phase 3a.4 — 3-line compose box (label / input / hint) rendered into the
	 * reserved bottom-of-body slot. When the focused entry has a pending worker
	 * prompt we render a 2-line approval banner *above* the compose rows. Kept
	 * here rather than inline in `renderInner` so tests can exercise it
	 * directly.
	 */
	renderComposePlaceholder(width?: number, nowMs: number = this.now()): string[] {
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) return [];
		const theme = this.theme;
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const warn = (s: string) => theme.fg("warning", s);

		const lines: string[] = [];
		const prompts = getPendingPrompts(run.runId, entry.name);
		if (prompts.length > 0) {
			const top = prompts[0]!;
			const countdown =
				top.expiresAt !== undefined
					? Math.max(0, Math.round((top.expiresAt - nowMs) / 1000))
					: undefined;
			const cd = countdown !== undefined ? ` (auto-deny in ${countdown}s)` : "";
			const more = prompts.length > 1 ? ` (+${prompts.length - 1} more)` : "";
			lines.push(warn(` ${this.icons.warning} worker wants to run: ${top.title}${more}`));
			lines.push(dim(` approve? [y] yes [n] no [s] skip-all${cd}`));
		}

		if (!runSupportsSteering(run)) {
			if (this.lastComposeStatus) lines.push(dim(` ${this.lastComposeStatus}`));
			return lines;
		}

		// Steering is rare, so when the user isn't actively composing we collapse
		// the whole guide/input/hint block to a single dim control line. This
		// keeps the compose region from visually colliding with the transcript
		// above it (the full 3-line box only appears once you press `s`).
		const target = COMPOSE_TARGETS[this.composeMode];
		if (this.focus !== "composing") {
			const statusChip = this.lastComposeStatus ? `  ${this.lastComposeStatus}` : "";
			lines.push(
				dim(` s message → ${target.to} (${target.when}) · m change · x cancel${statusChip}`),
			);
			return lines;
		}

		// Active compose: full guide / input / hint box. The recipient is named
		// outright: `push`/`followUp` reach the SUPERVISOR, `queue` reaches the
		// WORKER on its next round (see COMPOSE_TARGETS).
		const focusLabel = dim(`· ${entry.name}`);
		const targetChip = accent(`[${target.to}]`);
		const statusChip = this.lastComposeStatus ? ` ${dim(this.lastComposeStatus)}` : "";
		lines.push(` message → ${targetChip} ${dim(target.when)} ${focusLabel}${statusChip}`);

		// Input row (middle).
		const cursor = accent("█");
		const inputText = this.composeBuffer;
		const maxText = Math.max(2, (width ?? 80) - 4);
		const shown = visibleWidth(inputText) > maxText
			? truncateToWidth(inputText, maxText, "…")
			: inputText;
		lines.push(` › ${shown}${cursor}`);

		// Hint row.
		lines.push(dim(` Enter send · Esc cancel · Tab switch ${runEntryNoun(run.shape)} (m changes recipient before typing)`));

		return lines;
	}

	/** Ask the TUI to re-render, debounced to coalesce event bursts. */
	scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			try {
				this.tui.requestRender();
			} catch {
				/* tui may be detached */
			}
		}, this.renderDebounceMs);
		(this.renderTimer as any).unref?.();
	}

	/**
	 * Re-snapshot runs from the runtime and reconcile selection indexes.
	 *
	 * When `resetSelection` is true (initial mount) we pick the first active
	 * run (or the first completed run if none are active) so the user sees
	 * useful content immediately.
	 *
	 * Otherwise we try to keep the current (runId, forkName) focused across
	 * mutations; if the run/entry disappears we clamp to the nearest valid
	 * index.
	 */
	refreshRuns(resetSelection = false): void {
		// Runtime snapshots may update transcript/activity contents in place, so
		// identity and length alone cannot prove the rendered projections remain
		// valid. Clear derived line anchors before reconciling the new snapshot.
		this.invalidate();
		const prevRunId = this.runs[this.runIndex]?.runId;
		const prevEntryName = this.currentEntryName();
		const previousSelection = this.selectedRow();
		if (this.detachedStatuses) {
			try {
				const snapshot = this.detachedStatuses();
				const statuses = Array.isArray(snapshot) ? snapshot : snapshot.statuses;
				this.detachedStatusDegraded = Array.isArray(snapshot) ? false : snapshot.degraded;
				this.detachedStatusTruncated = Array.isArray(snapshot) ? false : snapshot.truncated;
				// Dispatch order, oldest first — the same rule the in-process
				// runs follow. This used to sort live-first and then newest
				// first, which ran one block of the list in the opposite
				// direction from the rest of it.
				this.detachedRuns = sortDetachedByDispatch(
					statuses.filter((status) => status.source === "detached"),
				);
			} catch {
				// Keep the last good detached snapshot. The overlay is diagnostic and
				// must never perturb (or disappear because of) a transient fs read.
			}
		}
		// Ordered here, not in `buildOverlayList`: `OverlayEntryRow.runIndex`
		// indexes this array, so the two must be sorted as one step.
		this.runs = sortRunsByDispatch(listRuns().filter(isOwnedByThisProcess));
		this.evictProjectionCaches();
		if (this.runs.length === 0 && this.detachedRuns.length === 0) {
			this.listRows = [];
			this.listIndex = 0;
			this.runIndex = 0;
			this.forkIndex = 0;
			if (!resetSelection && previousSelection !== undefined) {
				this.resetAfterSelectionLoss();
			} else {
				this.scrollOffset = 0;
				this.level = "list";
				this.pane = "list";
				this.roundSelection = { kind: "setup" };
			}
			return;
		}
		if (this.runs.length === 0) {
			// Detached-only sessions are an ordinary list now, not a separate
			// full-screen layout, so the selection still has somewhere to live.
			this.runIndex = 0;
			this.forkIndex = 0;
			this.rebuildList();
			if (this.level !== "list" && this.selectedRow() === undefined) this.level = "list";
			return;
		}

		if (resetSelection) {
			const activeIdx = this.runs.findIndex((r) =>
				r.completedAt === undefined && Object.keys(r.forks).length > 0,
			);
			const anyActiveIdx = this.runs.findIndex((r) => r.completedAt === undefined);
			const completedWithEntryIdx = this.runs.findIndex((r) => Object.keys(r.forks).length > 0);
			this.runIndex = activeIdx >= 0
				? activeIdx
				: anyActiveIdx >= 0 ? anyActiveIdx : completedWithEntryIdx >= 0 ? completedWithEntryIdx : 0;
			this.forkIndex = 0;
			this.scrollOffset = 0;
			this.autoScroll = true;
			this.level = "list";
			this.pane = "list";
			this.roundSelection = { kind: "setup" };
			this.listRows = buildOverlayList(
				this.runs,
				this.detachedRuns,
				this.viewMode,
				entryNeedsAttention,
			);
			// Land on the run just chosen, not merely the first row: the choice
			// above deliberately prefers a run with live work over an earlier
			// completed one.
			const target = this.listRows.findIndex(
				(row) =>
					(row.kind === "entry" || row.kind === "constructing")
					&& row.runIndex === this.runIndex,
			);
			this.listIndex = target >= 0 ? target : firstSelectable(this.listRows) ?? 0;
			this.syncDerivedSelection();
			return;
		}

		// Preserve by id when possible.
		if (prevRunId) {
			const idx = this.runs.findIndex((r) => r.runId === prevRunId);
			if (idx >= 0) {
				this.runIndex = idx;
			} else {
				this.runIndex = Math.min(this.runIndex, this.runs.length - 1);
				this.forkIndex = 0;
				this.scrollOffset = 0;
			}
		} else {
			this.runIndex = Math.min(this.runIndex, this.runs.length - 1);
		}

		const entries = this.currentEntries();
		if (entries.length === 0) {
			this.forkIndex = 0;
		} else if (prevEntryName) {
			const entryIndex = entries.findIndex((entry) => entry.name === prevEntryName);
			this.forkIndex = entryIndex >= 0 ? entryIndex : Math.min(this.forkIndex, entries.length - 1);
		} else {
			this.forkIndex = Math.min(this.forkIndex, entries.length - 1);
		}
		const nextRunId = this.currentRun()?.runId;
		const nextEntryName = this.currentEntryName();
		if (prevRunId !== nextRunId || prevEntryName !== nextEntryName) {
			this.roundSelection = { kind: "setup" };
		}
		this.rebuildList();
		// A detail level must have something to show. `selectedRow()` alone is
		// not that test: a run whose last entry vanished still yields a
		// selectable `constructing` row, which has no transcript behind it.
		const row = this.selectedRow();
		const canShowDetail = row !== undefined && isEnterable(row);
		if (!canShowDetail) {
			this.level = "list";
			this.pane = "list";
			this.roundSelection = { kind: "setup" };
		}
	}

	private currentRun(): DelegateDispatchState | undefined {
		return this.runs[this.runIndex];
	}

	private currentEntries(): RunLiveState[] {
		const run = this.currentRun();
		if (!run) return [];
		return Object.values(run.forks);
	}

	private currentEntry(): RunLiveState | undefined {
		return this.currentEntries()[this.forkIndex];
	}

	private currentEntryName(): string | undefined {
		return this.currentEntry()?.name;
	}

	/**
	 * The run a CONTROL should act on, or `undefined` when none should.
	 *
	 * `currentRun()` / `currentEntry()` are the derived pointer into the
	 * foreground inventory, and they deliberately stay put when a detached row
	 * is selected — refresh bookkeeping and the header fallback both need
	 * that. But a control must not act on an entry the operator is not looking
	 * at: with a detached row selected the overlay offered `s message`, and
	 * composing steered whichever foreground entry had been selected before
	 * (review finding OV-12).
	 *
	 * Every steer, compose, prompt answer, and cancel path resolves its target
	 * here instead, so a detached selection makes them all inert and
	 * unadvertised through one rule rather than nine.
	 */
	private targetRun(): DelegateDispatchState | undefined {
		const row = this.selectedRow();
		return row?.kind === "entry" || row?.kind === "constructing" ? row.run : undefined;
	}

	/** The entry a control should act on. */
	private targetEntry(): RunLiveState | undefined {
		const row = this.selectedRow();
		return row?.kind === "entry" ? row.entry : undefined;
	}

	/** Whether an asynchronous control still owns the currently selected target. */
	private isSelectedTarget(run: DelegateDispatchState, entry: RunLiveState): boolean {
		return this.targetRun() === run && this.targetEntry()?.name === entry.name;
	}

	/** Whether the selected row has a concrete entry that accepts steering. */
	private canSteerSelectedTarget(run: DelegateDispatchState | undefined = this.targetRun()): boolean {
		return this.targetEntry() !== undefined && runSupportsSteering(run);
	}

	private runShape(run: DelegateDispatchState | undefined): DelegateDispatchState["shape"] {
		return run?.shape;
	}

	/**
	 * Rebuild the explorer list and keep the selection on the same thing.
	 *
	 * The selection is re-found by identity rather than by position, so a run
	 * registering above the current row does not drag the cursor with it. When
	 * the selected row is gone entirely, the cursor clamps to the nearest row but
	 * open detail navigation returns to the list before controls can target that
	 * replacement.
	 */
	private rebuildList(): void {
		const previous = this.selectedRow();
		this.listRows = buildOverlayList(
			this.runs,
			this.detachedRuns,
			this.viewMode,
			entryNeedsAttention,
		);
		const found = findRow(this.listRows, previous);
		const selectionLost = previous !== undefined && found === undefined;
		if (found !== undefined) {
			this.listIndex = found;
		} else {
			this.listIndex = moveSelection(this.listRows, this.listIndex, 0)
				?? firstSelectable(this.listRows)
				?? 0;
		}
		this.syncDerivedSelection();
		if (selectionLost) this.resetAfterSelectionLoss();
	}

	/** A rebuild must never leave open controls targeting the row selected as fallback. */
	private resetAfterSelectionLoss(): void {
		const hadTargetBoundInteraction = this.focus === "composing" || this.confirmingCancel;
		this.level = "list";
		this.pane = "list";
		this.focus = "viewing";
		this.composeBuffer = "";
		this.lastComposeStatus = undefined;
		this.steerOperationOwner = undefined;
		this.cancelStatusOwner = undefined;
		this.confirmingCancel = false;
		this.discardNextInputAfterSelectionLoss = true;
		if (hadTargetBoundInteraction) this.autoCloseDeferredAfterTargetInteractionLoss = true;
		this.scrollOffset = 0;
		this.autoScroll = false;
		this.roundSelection = { kind: "setup" };
		this.expanded = undefined;
	}

	/** The currently selected row, or `undefined` when nothing is selectable. */
	private selectedRow(): SelectableRow | undefined {
		const row = this.listRows[this.listIndex];
		return row !== undefined && isSelectable(row) ? row : undefined;
	}

	/**
	 * Mirror the list selection onto `runIndex` / `forkIndex`.
	 *
	 * Those two drive projections, steering, cancel targeting, and the compose
	 * box. A detached row has no entry to point at, so they are left where they
	 * were: every caller of `currentEntry()` already handles `undefined`, and
	 * moving them would silently re-target a steer at an unrelated entry.
	 */
	private syncDerivedSelection(): void {
		const row = this.selectedRow();
		if (row === undefined || row.kind === "detached") return;
		this.runIndex = row.runIndex;
		this.forkIndex = row.kind === "entry" ? row.entryIndex : 0;
	}

	/** True when the selected row is a detached orchestrator. */
	private selectedDetached(): UniformRunStatus | undefined {
		const row = this.selectedRow();
		return row?.kind === "detached" ? row.status : undefined;
	}

	private roundActivityProjection(run: DelegateDispatchState, entry: RunLiveState): RoundActivityCacheEntry {
		const key = runEntryProjectionKey(run.runId, entry.name);
		const transcript = entry.transcript;
		const transcriptLength = transcript.length;
		const finalEntry = transcript.at(-1);
		const runShape = this.runShape(run);
		const cached = this.roundActivityCache.get(key);
		if (
			cached
			&& cached.transcript === transcript
			&& cached.transcriptLength === transcriptLength
			&& cached.finalEntry === finalEntry
			&& cached.runShape === runShape
		) {
			return cached;
		}

		const projection = this.projectionReducers.projectTranscript(
			transcript,
			runShape === "supervised",
		);
		const cacheEntry: RoundActivityCacheEntry = {
			transcript,
			transcriptLength,
			finalEntry,
			runShape,
			rounds: projection.rounds,
			activity: projection.activity,
		};
		this.roundActivityCache.set(key, cacheEntry);
		return cacheEntry;
	}

	private digestProjection(
		run: DelegateDispatchState,
		entry: RunLiveState,
		roundActivity: RoundActivityCacheEntry,
		nowMs: number,
	): DigestCacheEntry {
		const key = runEntryProjectionKey(run.runId, entry.name);
		const activityHistory = entry.activityHistory;
		const activityHistoryLength = activityHistory?.length ?? 0;
		const finalActivityEntry = activityHistory?.at(-1);
		const terminalResult = entry.completedResult
			?? run.finalResult?.find((result) => result.name === entry.name);
		const prompts = getPendingPrompts(run.runId, entry.name);
		const promptFingerprint = pendingPromptFingerprint(prompts);
		const timeBucket = Math.floor(nowMs / 5_000);
		const runShape = this.runShape(run);
		const cached = this.digestCache.get(key);
		if (
			cached
			&& cached.entry === entry
			&& cached.usage === entry.usage
			&& cached.cost === entry.cost
			&& cached.lastActivityAt === entry.lastActivityAt
			&& cached.pendingGuidance === entry.pendingGuidance
			&& cached.pendingGuidanceLength === (entry.pendingGuidance?.length ?? 0)
			&& cached.rounds === roundActivity.rounds
			&& cached.activity === roundActivity.activity
			&& cached.activityHistoryLength === activityHistoryLength
			&& cached.finalActivityEntry === finalActivityEntry
			&& cached.terminalResult === terminalResult
			&& cached.pendingPromptFingerprint === promptFingerprint
			&& cached.timeBucket === timeBucket
			&& cached.runShape === runShape
			&& cached.runCreatedAtMs === run.createdAt
		) {
			return cached;
		}

		const digest = this.projectionReducers.reduceDigest({
			runId: run.runId,
			runShape,
			runCreatedAtMs: run.createdAt,
			entry,
			...(terminalResult ? { terminalResult } : {}),
			...(roundActivity.rounds ? { rounds: roundActivity.rounds } : {}),
			activity: roundActivity.activity,
			pendingPromptKinds: prompts.map((prompt) => prompt.kind),
			nowMs,
		});
		const cacheEntry: DigestCacheEntry = {
			entry,
			usage: entry.usage,
			cost: entry.cost,
			lastActivityAt: entry.lastActivityAt,
			pendingGuidance: entry.pendingGuidance,
			pendingGuidanceLength: entry.pendingGuidance?.length ?? 0,
			rounds: roundActivity.rounds,
			activity: roundActivity.activity,
			activityHistoryLength,
			finalActivityEntry,
			terminalResult,
			pendingPromptFingerprint: promptFingerprint,
			timeBucket,
			runShape,
			runCreatedAtMs: run.createdAt,
			digest,
		};
		this.digestCache.set(key, cacheEntry);
		return cacheEntry;
	}

	private updateDigestProjections(nowMs: number): void {
		const next = new Map<string, { rounds?: RunRoundProjection; digest: RunDigest }>();
		const structureFingerprint = JSON.stringify(this.runs.map((run) => ({
			runId: run.runId,
			shape: run.shape,
			forkNames: Object.keys(run.forks),
		})));
		for (const selection of this.listRows) {
			if (selection.kind !== "entry") continue;
			const { run, entry: entry } = selection;
			const roundActivity = this.roundActivityProjection(run, entry);
			const digest = this.digestProjection(run, entry, roundActivity, nowMs).digest;
			const key = runEntryProjectionKey(run.runId, entry.name);
			next.set(key, roundActivity.rounds ? { rounds: roundActivity.rounds, digest } : { digest });
		}

		let changed = structureFingerprint !== this.digestStructureFingerprint
			|| next.size !== this.digestProjections.size;
		if (!changed) {
			for (const [key, projection] of next) {
				const prior = this.digestProjections.get(key);
				if (prior?.rounds !== projection.rounds || prior.digest !== projection.digest) {
					changed = true;
					break;
				}
			}
		}
		if (changed) {
			this.digestProjections = next;
			this.digestProjectionIdentity = {};
			this.digestStructureFingerprint = structureFingerprint;
			this.renderedBodyCache = undefined;
		}
	}

	private evictProjectionCaches(): void {
		const valid = new Set<string>();
		for (const run of this.runs) {
			for (const entry of Object.values(run.forks)) {
				valid.add(runEntryProjectionKey(run.runId, entry.name));
			}
		}
		for (const key of this.roundActivityCache.keys()) {
			if (!valid.has(key)) this.roundActivityCache.delete(key);
		}
		for (const key of this.digestCache.keys()) {
			if (!valid.has(key)) this.digestCache.delete(key);
		}
		const retained = new Map(
			[...this.digestProjections.entries()].filter(([key]) => valid.has(key)),
		);
		if (retained.size !== this.digestProjections.size) {
			this.digestProjections = retained;
			this.digestProjectionIdentity = {};
			this.digestStructureFingerprint = "";
			this.renderedBodyCache = undefined;
		}
	}

	/**
	 * The summary level: every delegate in the session, on one screen.
	 *
	 * ## Why a stack again, and why this one is not the old one
	 *
	 * This rendered every entry as a scrolling stack once before, back when it
	 * was the only place the inventory could live. That was replaced by a
	 * single-entry pane when the left column took the inventory over — and the
	 * pane then spent its width on one delegate while the others were a
	 * keystroke away and out of sight.
	 *
	 * The stack is back, but the two are not the same thing. The old one had to
	 * carry navigation, so every card was equal and none was complete. Here the
	 * left column still owns selection; the stack only decides how much of each
	 * summary that selection buys. The selected entry renders in full — exactly
	 * what the single-entry pane showed — and the rest collapse to a card.
	 *
	 * So nothing is lost from the entry you are looking at, and everything else
	 * is visible beside it at the detail you would want while scanning.
	 */
	private renderSummaryBody(textWidth: number, nowMs: number): OverlayBodyLines {
		const dim = (value: string) => this.theme.fg("dim", value);
		const lines: string[] = [];
		let selectedLine: number | undefined;

		if (this.listRows.length === 0) {
			lines.push(dim(" Nothing selected."));
			return { lines };
		}

		// The gutter is drawn per line, so each block budgets its text against
		// the width left after it. Measured once here rather than per block:
		// every block must wrap to the same column or the stack looks ragged.
		const blockWidth = Math.max(1, textWidth - GUTTER_WIDTH);

		for (const [index, row] of this.listRows.entries()) {
			if (row.kind === "group") {
				// A blank line before every heading but the first, so runs read
				// as blocks rather than one undifferentiated column.
				if (lines.length > 0) lines.push("");
				lines.push(this.theme.fg(
					row.completed === true ? "dim" : "accent",
					` ${groupHeadingText(row)}`,
				));
				continue;
			}
			const selected = index === this.listIndex;
			// One blank line between blocks. Without it the last line of an
			// expanded block butts against the next block's identity line and
			// the two read as one delegate.
			const previous = lines[lines.length - 1];
			if (previous !== undefined && previous !== "") lines.push("");
			if (selected) {
				// The anchor for scroll-into-view is the block's FIRST line, so
				// selecting a block scrolls to its top rather than leaving its
				// heading above the viewport.
				selectedLine = lines.length;
			}
			const gutter = this.theme.fg(
				selected ? "accent" : "dim",
				gutterFor(selected, this.icons.mode === "ascii"),
			);
			const body = selected
				? this.renderSummaryDetail(row, blockWidth, nowMs)
				: this.renderSummaryCard(row, blockWidth, nowMs);
			// The gutter runs the height of the block, including its blank
			// lines, so the selected bar is one unbroken rule rather than a
			// dashed one that stops at every paragraph break.
			for (const line of body) lines.push(`${gutter}${line}`);
		}

		if (lines.length === 0) {
			lines.push(dim(" Nothing selected."));
			return { lines };
		}
		return selectedLine === undefined ? { lines } : { lines, selectedLine };
	}

	/**
	 * One delegate as a card: the facts worth scanning across several.
	 *
	 * Deliberately not the first few lines of the full summary. What you want
	 * when comparing delegates is whether each is moving, how far in it is, and
	 * what it is doing right now. The heartbeat policy and the latest exchange
	 * are things you read after choosing one, so they are the selected block's
	 * job, not this one's.
	 */
	private renderSummaryCard(
		row: SelectableRow,
		width: number,
		nowMs: number,
	): string[] {
		const dim = (value: string) => this.theme.fg("dim", value);
		const clip = (value: string) =>
			visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;

		if (row.kind === "constructing") {
			const noun = runEntryNoun(row.run.shape);
			return [clip(dim(`${this.icons.constructing} constructing · waiting for first ${noun}`))];
		}
		if (row.kind === "detached") {
			// A detached run reports an observed status and nothing else: it
			// runs in another process, so there is no digest to condense.
			const glyph = detachedStatusGlyph(this.theme, row.status, this.icons);
			return [
				clip(`${glyph} ${this.theme.fg("text", row.status.runId)}`),
				clip(dim(`  ${boundActivityText(formatUniformRunStatus(row.status, nowMs))}`)),
			];
		}

		const projection = this.digestProjections.get(
			runEntryProjectionKey(row.run.runId, row.entry.name),
		);
		const glyph = statusGlyph(this.theme, row.entry.status, this.icons);
		// Identity dims with its run; the glyph keeps its own colour, so a
		// finished run still says whether it went well.
		const identityTone = row.completed === true ? "dim" : "text";
		const identity = clip(
			`${glyph} ${this.theme.fg(identityTone, renderRunEntryIdentity(row.entry))}`,
		);
		if (!projection) return [identity];
		const { digest } = projection;
		const rounds = digest.consumption.rounds;
		const friction = digestFrictionText(digest, false);

		const out = [identity];
		// Health and friction share a line: both answer "is this going well",
		// and splitting them costs a row per card across the whole stack.
		const health = boundActivityText(formatDigestHealth(digest.health));
		const frictionPart = friction === "none" ? "" : ` · ${friction}`;
		out.push(clip(dim(`  ${health}${frictionPart}`)));
		out.push(clip(dim(
			`  ${rounds.used}/${rounds.limit}`
			+ ` · ${formatDigestElapsed(digest)}`
			+ ` · ${formatDigestUsage(digest)}`,
		)));
		const headline = boundActivityText(digest.activity.headline.text);
		if (headline.length > 0) out.push(clip(this.theme.fg("muted", `  ${headline}`)));
		return out;
	}

	/**
	 * The selected delegate in full — what the single-entry pane used to show.
	 *
	 * Takes the row explicitly rather than reading the selection, so the caller
	 * decides which block expands and this function has no opinion about it.
	 */
	private renderSummaryDetail(
		row: SelectableRow,
		textWidth: number,
		nowMs: number,
	): string[] {
		const accent = (value: string) => this.theme.fg("accent", value);
		const dim = (value: string) => this.theme.fg("dim", value);
		const lines: string[] = [];

		if (row.kind === "detached") {
			return this.renderDetachedSummaryBody(textWidth, nowMs).lines;
		}
		if (row.kind === "constructing") {
			const noun = runEntryNoun(row.run.shape);
			lines.push(dim(`${this.icons.constructing} constructing · waiting for first ${noun}`));
			return lines;
		}

		const projection = this.digestProjections.get(
			runEntryProjectionKey(row.run.runId, row.entry.name),
		);
		if (!projection) return lines;
		const { digest } = projection;
		const rounds = digest.consumption.rounds;
		const heartbeat = formatDigestHeartbeat(digest);

		// The block names its entry rather than saying "summary". Several blocks
		// are stacked now, so a heading that does not identify its own would
		// leave the reader counting rows back to the list column to find out
		// which delegate they are looking at.
		const glyph = statusGlyph(this.theme, row.entry.status, this.icons);
		// Still bold when the run has finished — this is the block the operator
		// selected, and it has to stay findable — but dim rather than accent,
		// so a finished run reads as finished even while it is expanded.
		const headingTone = row.completed === true ? "dim" : "accent";
		lines.push(
			`${glyph} ${this.theme.fg(headingTone, this.theme.bold(renderRunEntryIdentity(row.entry)))}`,
		);
		lines.push("");
		// Wrap rather than truncate: these are the facts the pane exists to
		// report, and a clipped `friction wind-down (unknow…` loses exactly the
		// word that made the line worth reading.
		const wrapped = (text: string) => wrapTextWithAnsi(text, Math.max(1, textWidth));
		lines.push(...wrapped(
			`lifecycle ${digest.status}`
			+ `  health ${boundActivityText(formatDigestHealth(digest.health))}`,
		));
		// Friction gets its own line. It is the most detailed of the three and
		// the one whose detail matters most: `wind-down (heartbeat)` and
		// `wind-down (max-rounds)` are different problems.
		lines.push(...wrapped(`friction ${digestFrictionText(digest, true)}`));
		lines.push(...wrapped(
			`rounds ${rounds.used}/${rounds.limit}`
			+ ` · elapsed ${formatDigestElapsed(digest)}`
			+ ` · ${formatDigestUsage(digest)}`,
		));
		if (heartbeat) lines.push(heartbeat);
		lines.push("");
		lines.push(`activity ${boundActivityText(digest.activity.actorPhase.label)}`);
		lines.push(dim(boundActivityText(digest.activity.headline.text)));

		const plan = buildPlanBlock(row.entry.taskProgress);
		if (plan) {
			lines.push("");
			const heading = `plan ${formatPlanCount(plan, this.icons)}`;
			lines.push(plan.blocked > 0 ? this.theme.fg("warning", heading) : accent(heading));
			if (plan.active !== null) {
				lines.push(...wrapped(`active ${boundActivityText(plan.active)}`));
			}
			if (plan.blockedReason !== undefined) {
				lines.push(...wrapped(
					this.theme.fg("warning", `blocked ${boundActivityText(plan.blockedReason)}`),
				));
			}
			if (this.taskDisplayMode === "expanded") {
				lines.push(...renderExpandedTaskList(plan.tasks, Math.max(1, textWidth - 1), this.theme, this.icons));
			} else {
				const strip = renderStatusStrip(plan.statuses, Math.max(1, textWidth - 1), this.theme, this.icons);
				for (const line of strip) lines.push(line);
				const legend = renderStatusLegend(plan.statuses, Math.max(1, textWidth - 1), this.icons);
				if (legend) lines.push(dim(legend));
			}
		}

		if (digest.latestExchange) {
			lines.push("");
			lines.push(accent(
				`latest exchange · round ${digest.latestExchange.roundIndex}`
				+ ` · ${digest.latestExchange.state}`,
			));
			lines.push(...wrappedExchangeRows("ask", digest.latestExchange.ask, textWidth, 3));
			lines.push(...wrappedExchangeRows(
				"reply",
				digest.latestExchange.reply ?? "no reply yet",
				textWidth,
				3,
			));
		}

		return lines;
	}

	/**
	 * The summary level for a detached orchestrator.
	 *
	 * A detached run executes in another process, so there is no
	 * supervisor↔worker conversation here to show. The pane reports the status
	 * this process can actually observe and says where it came from, rather
	 * than fabricating a transcript for work it cannot see.
	 */
	private renderDetachedSummaryBody(textWidth: number, nowMs: number): OverlayBodyLines {
		const accent = (value: string) => this.theme.fg("accent", value);
		const dim = (value: string) => this.theme.fg("dim", value);
		const warn = (value: string) => this.theme.fg("warning", value);
		const status = this.selectedDetached();
		const lines: string[] = [];
		if (!status) return { lines };

		lines.push(accent(" status"));
		lines.push("");
		for (const line of wrapTextWithAnsi(
			` ${formatUniformRunStatus(status, nowMs)}`,
			Math.max(1, textWidth),
		)) {
			lines.push(line);
		}
		const warning = detachedStatusWarning(
			this.detachedStatusDegraded,
			this.detachedStatusTruncated,
		);
		if (warning) lines.push(warn(warning));
		lines.push("");
		lines.push(dim(" another process · status read from durable state"));
		lines.push(dim(DETACHED_CONTROL_HINT));
		return { lines };
	}

	/**
	 * A detached run's event log: the deepest level it has.
	 *
	 * Read on demand rather than on every refresh, because the events are only
	 * wanted while someone is looking at this one run. A missing seam is not an
	 * error — it means the host wired the overlay without event access, and the
	 * honest response is to say so rather than render an empty log that implies
	 * the run produced nothing.
	 */
	private renderDetachedEventLogBody(runId: string, textWidth: number): OverlayBodyLines {
		const width = Math.max(1, textWidth);
		const empty = buildEventLog([]);
		const unavailable = (reason: string) => ({
			lines: renderEventLog(empty, width, this.theme, formatClock, reason),
		});
		if (!this.detachedEvents) return unavailable("event log unavailable in this session");
		let tail: { events: RunEventRecord[]; truncated: boolean };
		try {
			tail = this.detachedEvents(runId);
		} catch {
			// Same posture as the status refresh: a failed read degrades this
			// pane, never the foreground.
			return unavailable("event log could not be read");
		}
		const model = buildEventLog(tail.events, {
			truncated: tail.truncated,
		});
		return { lines: renderEventLog(model, width, this.theme, formatClock) };
	}

	private renderTranscriptBody(
		entry: RunLiveState | undefined,
		textWidth: number,
		nowMs: number,
	): OverlayBodyLines {
		const transcript = entry?.transcript ?? [];
		const run = this.currentRun();
		const historyLines = renderActivityHistoryLines(entry?.activityHistory ?? [], textWidth, this.theme);
		const rounds = run && entry
			? this.roundActivityProjection(run, entry).rounds
			: undefined;
		const model = buildTranscriptModel(transcript, {
			runShape: this.runShape(run),
			nowMs,
			rounds,
			maxConsecutiveHeartbeats: entry?.maxConsecutiveHeartbeats,
			// A finished entry is not waiting, however its transcript ended.
			entryIsLive: entry === undefined ? false : isLiveStatus(entry.status),
		});
		const rendered = renderTranscript(model, {
			width: textWidth,
			theme: this.theme,
			markdownTheme: this.markdownTheme,
			nowMs,
			icons: this.icons,
			// `t` still cycles thinking detail until the stage-3 key rewrite;
			// level 0 is the "hidden" rung.
			thinkingDetail: THINKING_DETAIL[this.thinkingLevel],
			toolDetail: this.toolDetail,
			...(this.expandedEntryFor(run, entry) === undefined
				? {}
				: { expandedEntryIndex: this.expandedEntryFor(run, entry) }),
		});
		const offset = historyLines.length;
		return {
			lines: [...historyLines, ...rendered.lines],
			entryAnchors: new Map(
				[...rendered.entryAnchors.entries()].map(([index, anchor]) => [index, anchor + offset]),
			),
			headingAt: [
				...historyLines.map(() => undefined),
				...rendered.headingAt,
			],
			...(model.waiting === undefined ? {} : { waiting: model.waiting }),
		};
	}

	private renderedBodyCacheMatches(
		cached: RenderedBodyCacheEntry,
		key: RenderedBodyCacheKey,
	): boolean {
		return cached.level === key.level
			&& cached.layoutMode === key.layoutMode
			&& cached.listWidth === key.listWidth
			&& cached.detailWidth === key.detailWidth
			&& cached.pane === key.pane
			&& cached.listIndex === key.listIndex
			&& cached.width === key.width
			&& cached.innerWidth === key.innerWidth
			&& cached.textWidth === key.textWidth
			&& cached.bodyHeight === key.bodyHeight
			&& cached.runIndex === key.runIndex
			&& cached.forkIndex === key.forkIndex
			&& sameRoundSelection(cached.roundSelection, key.roundSelection)
			&& cached.scrollOffset === key.scrollOffset
			&& cached.autoScroll === key.autoScroll
			&& cached.thinkingLevel === key.thinkingLevel
			&& cached.toolDetail === key.toolDetail
			&& cached.taskDisplayMode === key.taskDisplayMode
			&& cached.foldMessages === key.foldMessages
			&& cached.timeBucket === key.timeBucket
			&& cached.projectionIdentity === key.projectionIdentity
			&& cached.entryIdentity === key.entryIdentity
			&& cached.activityHistory === key.activityHistory
			&& cached.activityHistoryLength === key.activityHistoryLength
			&& cached.finalActivityEntry === key.finalActivityEntry;
	}

	private renderBodyFromCache(
		key: RenderedBodyCacheKey,
		renderBody: () => OverlayBodyLines,
	): OverlayBodyLines {
		const cached = this.renderedBodyCache;
		if (cached && this.renderedBodyCacheMatches(cached, key)) {
			this.restoreBodyAnchors(cached.body);
			return cached.body;
		}
		const body = renderBody();
		this.onRenderedBodyCacheMiss?.(key.level);
		this.renderedBodyCache = { ...key, body };
		this.restoreBodyAnchors(body);
		return body;
	}

	private restoreBodyAnchors(body: OverlayBodyLines): void {
		this.entryAnchors = body.entryAnchors ?? new Map();
		this.pageRanges = body.pageRanges ?? [];
	}

	/**
	 * Point the selection at a specific run and entry.
	 *
	 * Kept because several callers know an entry rather than a list position:
	 * `l` jumps to live work, `x` targets a cancel, and `refreshRuns` restores
	 * a selection by identity.
	 */
	private selectEntryLocation(runIndex: number, entryIndex: number): void {
		this.runIndex = runIndex;
		this.forkIndex = entryIndex;
		this.roundSelection = { kind: "setup" };
		this.scrollOffset = 0;
		this.autoScroll = true;
		const index = this.listRows.findIndex(
			(row) => row.kind === "entry"
				&& row.runIndex === runIndex
				&& row.entryIndex === entryIndex,
		);
		if (index >= 0) this.listIndex = index;
		if (!this.currentEntry()) this.level = "list";
		this.invalidate();
		this.scheduleRender();
	}

	/**
	 * Move the list selection by whole rows.
	 *
	 * Clamps at both ends rather than wrapping. The old entry navigation wrapped
	 * within one run, which was harmless; wrapping a list that now spans every
	 * run and the detached group would teleport the cursor across unrelated
	 * work.
	 */
	private moveListSelection(delta: number): void {
		const next = moveSelection(this.listRows, this.listIndex, delta);
		if (next === undefined || next === this.listIndex) return;
		this.listIndex = next;
		this.syncDerivedSelection();
		this.roundSelection = { kind: "setup" };
		this.scrollOffset = 0;
		this.autoScroll = false;
		this.invalidate();
		this.scheduleRender();
	}

	/** Jump to the first or last selectable row. */
	private selectListBoundary(last: boolean): void {
		const target = last ? lastSelectable(this.listRows) : firstSelectable(this.listRows);
		if (target === undefined || target === this.listIndex) return;
		this.listIndex = target;
		this.syncDerivedSelection();
		this.roundSelection = { kind: "setup" };
		this.scrollOffset = 0;
		this.autoScroll = last;
		this.invalidate();
		this.scheduleRender();
	}

	/**
	 * Move the list selection by roughly one screen.
	 *
	 * Rows are one or two lines each, so a page is approximated in rows rather
	 * than measured in lines. Getting this slightly wrong costs a keypress;
	 * measuring it exactly would couple selection to the rendered column.
	 */
	private pageListSelection(dir: -1 | 1): void {
		const rowsPerPage = Math.max(1, Math.floor(Math.max(1, this.lastBodyHeight) / 2));
		this.moveListSelection(dir * rowsPerPage);
	}

	/** Stable run/entry locations for every foreground-owned live entry. */
	private liveRunEntryLocations(): LiveRunEntryLocation[] {
		const locations: LiveRunEntryLocation[] = [];
		for (const [runIndex, run] of this.runs.entries()) {
			for (const [entryIndex, entry] of Object.values(run.forks).entries()) {
				if (isLiveStatus(entry.status)) locations.push({ runIndex, entryIndex, run, entry });
			}
		}
		return locations;
	}

	/**
	 * Expand or collapse the transcript node nearest the top of the viewport.
	 *
	 * The entry anchors map source entries to output lines, so the node in view
	 * is the one with the greatest anchor at or before the scroll offset. That
	 * is the block the operator is looking at, which is the one `Enter` should
	 * act on.
	 */
	private toggleExpandedAtViewport(): void {
		let best: number | undefined;
		let bestLine = -1;
		for (const [entryIndex, line] of this.entryAnchors.entries()) {
			if (line <= this.scrollOffset && line > bestLine) {
				bestLine = line;
				best = entryIndex;
			}
		}
		// Nothing at or above the offset (a short transcript scrolled to the
		// top): fall back to the first anchored entry rather than doing nothing.
		if (best === undefined) {
			for (const [entryIndex, line] of this.entryAnchors.entries()) {
				if (bestLine < 0 || line < bestLine) {
					bestLine = line;
					best = entryIndex;
				}
			}
		}
		if (best === undefined) return;
		// An expansion belongs to the entry on screen, so it resolves through the
		// same guard the other controls use. A detached row has no entry, and
		// tagging its expansion with a stale foreground one would be OV-16 and
		// OV-12 combined. Unreachable while detached clamps to the summary, but
		// stage 3 gives detached rows a deeper level, so close it here.
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (run === undefined || entry === undefined) return;
		const already = this.expanded !== undefined
			&& this.expanded.runId === run.runId
			&& this.expanded.forkName === entry.name
			&& this.expanded.entryIndex === best;
		this.expanded = already
			? undefined
			: { runId: run.runId, forkName: entry.name, entryIndex: best };
		this.invalidate();
		this.scheduleRender();
	}

	/**
	 * The expanded entry index, but only for the run entry that owns it.
	 *
	 * Returning `undefined` for any other entry is what stops an expansion
	 * leaking across a selection change (OV-16).
	 */
	private expandedEntryFor(
		run: DelegateDispatchState | undefined,
		entry: RunLiveState | undefined,
	): number | undefined {
		const expanded = this.expanded;
		if (expanded === undefined || run === undefined || entry === undefined) return undefined;
		return expanded.runId === run.runId && expanded.forkName === entry.name
			? expanded.entryIndex
			: undefined;
	}

	private enterTranscriptAtEntry(entryIndex: number | undefined, autoFollow = false): void {
		this.level = "transcript";
		this.pane = "detail";
		if (entryIndex === undefined) {
			this.scrollOffset = 0;
			this.autoScroll = autoFollow;
			this.scheduleRender();
			return;
		}
		const line = this.entryAnchors.get(entryIndex);
		this.scrollOffset = line ?? 0;
		this.autoScroll = false;
		this.scheduleRender();
	}

	/**
	 * `Enter` — descend one level.
	 *
	 * How far that goes depends on the layout: two panes already show the
	 * summary beside the list, so `Enter` opens the transcript; one column
	 * steps through the summary first. A constructing run has no entry to open
	 * and refuses rather than descending into an empty pane.
	 */
	private enterViewingSelection(): void {
		const row = this.selectedRow();
		if (row === undefined || !isEnterable(row)) return;
		// A detached run descends status card -> event log. It has no transcript
		// and never will: the `transcript` level here renders that run's events,
		// which is the deepest thing we can honestly show for another process.
		if (row.kind === "detached") {
			if (this.level === "transcript") return;
			this.level = this.level === "list" ? "summary" : "transcript";
			this.pane = "detail";
			this.scrollOffset = 0;
			this.scheduleRender();
			return;
		}

		const next = descendLevelIn(this.geometry.mode, this.level);
		if (this.level === "transcript") {
			// Deepest level: `Enter` expands the node at the top of the viewport
			// instead of descending. Folding is always on now, so this gesture
			// replaces the old global `f` toggle — you open the one message or
			// tool result you actually want, and pressing it again closes it.
			this.toggleExpandedAtViewport();
			return;
		}

		if (next === "transcript") {
			this.enterTranscriptAtEntry(undefined, true);
			return;
		}
		this.level = next;
		this.pane = "detail";
		this.scrollOffset = 0;
		this.scheduleRender();
	}

	/**
	 * `Esc` — ascend one level, or close when there is nothing left to leave.
	 *
	 * Two panes have exactly one step to give back, because the list and the
	 * summary are the same picture there. One column unwinds all three.
	 */
	private ascendView(): void {
		const next = ascendLevelIn(this.geometry.mode, this.level);
		if (next === undefined) {
			this.close();
			return;
		}
		this.level = next;
		// An expansion is a transient reading gesture, not persistent state:
		// leaving the transcript forgets it.
		this.expanded = undefined;
		// Ascending always hands focus back to the list. Leaving it in the
		// detail pane means the next arrow key scrolls prose when the operator
		// has just stepped out and plainly meant to move the selection.
		this.pane = "list";
		this.roundSelection = { kind: "setup" };
		this.scrollOffset = 0;
		this.scheduleRender();
	}

	// ── Input ────────────────────────────────────────────────────────────────
	handleInput(data: string): void {
		// Option-O is the historical/easy overlay toggle. The global shortcut
		// opens the overlay while the editor has focus; once the overlay owns
		// input, handle the same chord here so pressing it again closes.
		if (isOptionOOverlayShortcut(data)) {
			this.close();
			return;
		}
		if (this.discardNextInputAfterSelectionLoss) {
			this.discardNextInputAfterSelectionLoss = false;
			this.autoCloseDeferredAfterTargetInteractionLoss = false;
			if (matchesKey(data, "escape") || data === "q") {
				this.close();
				return;
			}
			this.scheduleRender();
			this.maybeAutoClose();
			return;
		}

		// Nothing at all to look at: only close and refresh mean anything.
		// A detached-only session does NOT take this path — its runs are
		// ordinary list rows, and swallowing navigation here would strand every
		// row past the first one off-screen.
		if (this.runs.length === 0 && this.detachedRuns.length === 0) {
			if (matchesKey(data, "escape") || data === "q") {
				this.close();
				return;
			}
			if (data === "r") {
				this.refreshRuns();
				this.scheduleRender();
				this.maybeAutoClose();
			}
			return;
		}

		// Composing focus: printable keys type into the buffer.
		if (this.focus === "composing") {
			if (matchesKey(data, "escape")) {
				this.focus = "viewing";
				this.composeBuffer = "";
				this.lastComposeStatus = undefined;
				this.steerOperationOwner = undefined;
				this.scheduleRender();
				// If everything went terminal while we were composing, the
				// auto-close was deferred — re-evaluate now that we've exited.
				this.maybeAutoClose();
				return;
			}
			if (matchesKey(data, "enter")) {
				void this.submitCompose();
				return;
			}
			if (matchesKey(data, "tab")) {
				this.moveListSelection(1);
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
				this.composeBuffer = [...this.composeBuffer].slice(0, -1).join("");
				this.steerOperationOwner = undefined;
				this.scheduleRender();
				return;
			}
			if (data.startsWith("\x1b")) return;
			const printable = [...data].filter((c) => c >= " ").join("");
			if (printable) {
				this.composeBuffer += printable;
				this.steerOperationOwner = undefined;
				this.scheduleRender();
			}
			return;
		}

		// Confirming cancel: y/n to accept or cancel.
		if (this.confirmingCancel) {
			if (data === "y") {
				void this.doCancelFocusedEntry();
				return;
			}
			if (data === "n" || matchesKey(data, "escape")) {
				this.confirmingCancel = false;
				this.lastComposeStatus = undefined;
				this.scheduleRender();
				return;
			}
			return;
		}

		// Banner: pending worker prompt short-circuits y/n/s.
		const banner = this.currentPendingPrompts();
		if (banner.length > 0) {
			if (data === "y") {
				this.resolveTopPrompt(true);
				return;
			}
			if (data === "n") {
				this.resolveTopPrompt(false);
				return;
			}
			if (data === "s") {
				this.skipAllPrompts();
				return;
			}
			// Esc is swallowed while a prompt is up. Falling through would
			// ascend a level and, from the top, unmount the inspector — taking
			// an unanswered worker question off the screen and leaving the
			// worker blocked on it. Compose mode and the cancel confirmation
			// already consume Esc for the same reason; this branch did not
			// (review finding CR-PENDING-PROMPT-ESC-CLOSES). The prompt has its
			// own answers: `y`, `n`, and `s` to skip.
			if (matchesKey(data, "escape")) return;
		}

		if (data === "q") {
			this.close();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.ascendView();
			return;
		}
		if (data === "r") {
			this.refreshRuns();
			this.scheduleRender();
			this.maybeAutoClose();
			return;
		}
		// `s` focuses the compose box to steer (Tab is now entry-nav).
		if (data === "s") {
			if (this.targetEntry() === undefined) return;
			if (!runSupportsSteering(this.targetRun())) {
				this.refuseUnsupportedSteering();
				return;
			}
			this.focus = "composing";
			this.lastComposeStatus = undefined;
			this.steerOperationOwner = undefined;
			this.scheduleRender();
			return;
		}
		if (data === "m") {
			if (this.targetEntry() === undefined) return;
			if (!runSupportsSteering(this.targetRun())) {
				this.refuseUnsupportedSteering();
				return;
			}
			this.cycleComposeMode();
			return;
		}
		if (data === "f") {
			this.cycleViewMode();
			return;
		}
		// Structured-view per-node toggles.
		if (data === "t") {
			this.cycleThinking();
			return;
		}
		if (data === "g") {
			this.cycleToolDetail();
			return;
		}
		if (data === "p") {
			this.cycleTaskDisplay();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.enterViewingSelection();
			return;
		}
		if (data === "x") {
			this.beginCancelConfirm();
			return;
		}
		if (data === "l") {
			this.moveToLiveEntry();
			return;
		}

		// Pane focus. Two panes are visible at once, so left/right and Tab move
		// between them. In one column they are levels, and `movePane` ignores
		// the request rather than pretending focus moved.
		if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
			this.movePane("list");
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.movePane("detail");
			return;
		}

		// Arrows drive whichever pane has focus: the list selection, or the
		// detail pane's scroll.
		if (matchesKey(data, "up")) {
			if (this.listHasFocus()) this.moveListSelection(-1);
			else this.scroll(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.listHasFocus()) this.moveListSelection(1);
			else this.scroll(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			if (this.listHasFocus()) this.pageListSelection(-1);
			else this.scroll(-Math.max(1, this.lastBodyHeight - 1));
			return;
		}
		if (matchesKey(data, "pageDown")) {
			if (this.listHasFocus()) this.pageListSelection(1);
			else this.scroll(Math.max(1, this.lastBodyHeight - 1));
			return;
		}
		if (matchesKey(data, "home")) {
			if (this.listHasFocus()) this.selectListBoundary(false);
			else {
				this.scrollOffset = 0;
				this.autoScroll = false;
				this.scheduleRender();
			}
			return;
		}
		if (matchesKey(data, "end")) {
			if (this.listHasFocus()) this.selectListBoundary(true);
			else {
				this.scrollOffset = Number.MAX_SAFE_INTEGER;
				this.autoScroll = true;
				this.scheduleRender();
			}
			return;
		}
	}

	// ── Phase 3 compose / banner helpers ────────────────────────────────────────────────────
	private confirmingCancel = false;

	private cycleComposeMode(): void {
		const i = COMPOSE_MODES.indexOf(this.composeMode);
		this.composeMode = COMPOSE_MODES[(i + 1) % COMPOSE_MODES.length]!;
		this.scheduleRender();
	}

	private cycleViewMode(): void {
		this.viewMode = nextOverlayViewMode(this.viewMode);
		this.rebuildList();
		this.invalidate();
		this.scheduleRender();
	}

	private refuseUnsupportedSteering(): void {
		const shape = this.targetRun()?.shape;
		const label = getDelegatePresentationTerminology(shape).label;
		this.focus = "viewing";
		this.composeBuffer = "";
		this.lastComposeStatus = `steering unavailable: ${label} runs do not support steering`;
		this.scheduleRender();
	}

	private async submitCompose(): Promise<void> {
		const run = this.targetRun();
		const entry = this.targetEntry();
		const text = this.composeBuffer.trim();
		if (!run || !entry || !text) {
			this.focus = "viewing";
			this.composeBuffer = "";
			this.scheduleRender();
			this.maybeAutoClose();
			return;
		}
		const steerOperationOwner = {};
		this.steerOperationOwner = steerOperationOwner;
		const deliverAs = this.composeMode === "push" ? undefined : this.composeMode;
		let delivered: string = "queued";
		let fallbackNote: string | undefined;
		let deliveryFailed = false;
		let deliveryFailure = "steering call failed";
		try {
			if (!runSupportsSteering(run)) {
				deliveryFailed = true;
				deliveryFailure = `${getDelegatePresentationTerminology(run.shape).label} runs do not support steering`;
			} else if (!hasLocalRunAuthority(run)) {
				deliveryFailed = true;
				deliveryFailure = "run is not live in this session";
			} else if (run.steer) {
				const res = await run.steer(
					entry.name,
					text,
					deliverAs ? { deliverAs } : undefined,
				);
				delivered = res.delivered;
				// The fallback ladder returns diagnostics from failed earlier rungs
				// alongside a successful `queued` delivery. Do not turn that note
				// into a false failure; only missing wiring or a rejected call means
				// the message was not delivered.
				fallbackNote = res.error;
			} else {
				deliveryFailed = true;
				deliveryFailure = "steer not wired";
			}
		} catch (err) {
			deliveryFailed = true;
			const reason = err instanceof Error ? err.message : String(err);
			deliveryFailure = reason.trim().length > 0 ? reason : "steering call failed";
		}
		const recipient = deliveredRecipient(delivered);
		const composeStatus = deliveryFailed
			? `(not delivered: ${deliveryFailure})`
			: fallbackNote
				? `(→ ${recipient}, ${delivered}: ${fallbackNote})`
				: `(→ ${recipient}, ${delivered})`;
		const deliveredText = recipient === "worker"
			? `→ your message, queued verbatim for the worker's next round (${delivered}): ${text}`
			: `→ your message to the supervisor (${delivered}): ${text}`;
		// A same-ID successor is a different run incarnation. Never stamp the old
		// operation's result onto whichever registration currently owns those IDs.
		if (getRun(run.runId) === run) {
			appendTranscriptEntry(run.runId, entry.name, {
				source: "supervisor",
				role: "user",
				text: deliveryFailed
					? `→ your message was not delivered: ${deliveryFailure}. Message: ${text}`
					: fallbackNote
						? `${deliveredText} (fallback note: ${fallbackNote})`
						: deliveredText,
				timestamp: Date.now(),
			});
		}
		if (!this.isSelectedTarget(run, entry) || this.steerOperationOwner !== steerOperationOwner) {
			this.invalidate();
			this.scheduleRender();
			this.maybeAutoClose();
			return;
		}
		this.lastComposeStatus = composeStatus;
		this.composeBuffer = "";
		this.focus = "viewing";
		this.steerOperationOwner = undefined;
		this.invalidate();
		this.scheduleRender();
		// Steering resolved — re-evaluate a possibly-deferred auto-close.
		this.maybeAutoClose();
	}

	private resolveTopPrompt(answer: boolean): void {
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) return;
		const prompts = getPendingPrompts(run.runId, entry.name);
		const top = prompts[0];
		if (!top) return;
		resolvePendingPrompt(run.runId, entry.name, top.id, answer);
		this.scheduleRender();
		// Resolving the last pending prompt may unblock a deferred auto-close.
		this.maybeAutoClose();
	}

	private skipAllPrompts(): void {
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) return;
		updateRunState(run.runId, entry.name, { interactive: false });
		const prompts = [...getPendingPrompts(run.runId, entry.name)];
		for (const p of prompts) {
			const answer = p.kind === "confirm" ? false : undefined;
			resolvePendingPrompt(run.runId, entry.name, p.id, answer);
		}
		this.scheduleRender();
		// Clearing all prompts may unblock a deferred auto-close.
		this.maybeAutoClose();
	}

	private beginCancelConfirm(): void {
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) return;
		if (!isLiveStatus(entry.status)) return;
		this.confirmingCancel = true;
		this.lastComposeStatus = `cancel ${runEntryNoun(run.shape)} ${entry.name}? [y] yes [n] no`;
		this.scheduleRender();
	}

	private async doCancelFocusedEntry(): Promise<void> {
		this.steerOperationOwner = undefined;
		// Synchronous acknowledgement so the user sees `y` was received even if
		// `run.cancel` takes a while to unwind the worker session (in-flight bash
		// / model calls don't drop their promises until the current round ends).
		this.confirmingCancel = false;
		const run = this.targetRun();
		const entry = this.targetEntry();
		if (!run || !entry) {
			this.lastComposeStatus = undefined;
			this.cancelStatusOwner = undefined;
			this.invalidate();
			this.scheduleRender();
			return;
		}
		if (!hasLocalRunAuthority(run)) {
			this.lastComposeStatus = "cancel unavailable: run is not live in this session";
			this.cancelStatusOwner = undefined;
			this.invalidate();
			this.scheduleRender();
			return;
		}
		const cancellingStatus = `cancelling ${entry.name}…`;
		const cancelStatusOwner = {};
		this.cancelStatusOwner = cancelStatusOwner;
		this.lastComposeStatus = cancellingStatus;
		// Stamp the transcript up-front so the cancel is visible in the live
		// body even if the underlying session.abort() is slow to resolve.
		entry.transcript.push({
			source: "supervisor",
			role: "user",
			// The marker follows the vocabulary; the words do not, because this
			// string is transcript content that other surfaces also render.
			text: `${this.icons.cancelled} cancelled by user`,
			timestamp: Date.now(),
		});
		this.invalidate();
		this.scheduleRender();
		try {
			await run.cancel?.(entry.name, "user" as CancelReason);
			// Only clear the status if this completion still owns both the target
			// and the status slot (the user may have moved or started composing).
			if (
				this.isSelectedTarget(run, entry)
				&& this.cancelStatusOwner === cancelStatusOwner
				&& this.lastComposeStatus === cancellingStatus
			) {
				this.lastComposeStatus = undefined;
				this.cancelStatusOwner = undefined;
			}
		} catch (err) {
			if (
				this.isSelectedTarget(run, entry)
				&& this.cancelStatusOwner === cancelStatusOwner
				&& this.lastComposeStatus === cancellingStatus
			) {
				this.lastComposeStatus = `cancel failed: ${(err as Error).message}`;
				this.cancelStatusOwner = undefined;
			}
		}
		this.invalidate();
		this.scheduleRender();
	}

	/**
	 * Entry point for the global cancel keybinding. When `bypass` is true the
	 * cancel fires immediately; otherwise the cost/runtime thresholds from
	 * config decide whether to arm the existing in-overlay y/N confirm banner
	 * (same visual path as the `x` key) or cancel straight away.
	 *
	 * Safe to call with no focused entry (no-op). Returns a short status string
	 * for tests / callers that want to log what happened.
	 *
	 * Resolves through `targetEntry()` like every other control. A detached
	 * selection has no foreground entry to cancel, so this reports the legacy
	 * `no-fork` compatibility outcome rather than reading whichever entry
	 * happened to be selected before it. The downstream cancel already refused,
	 * but the returned verdict was still false, and a caller logging it was told
	 * work had been cancelled.
	 */
	async handleCancelShortcut(
		bypass: boolean,
		opts?: { costThresholdUsd?: number; runtimeThresholdMs?: number; nowMs?: () => number },
	): Promise<"no-fork" | "bypassed" | "confirm" | "immediate"> {
		const entry = this.targetEntry();
		if (!entry) return "no-fork";
		if (!isLiveStatus(entry.status)) return "no-fork";
		if (bypass) {
			await this.doCancelFocusedEntry();
			return "bypassed";
		}
		const costThreshold = opts?.costThresholdUsd ?? DEFAULT_CANCEL_CONFIRM_COST_USD;
		const runtimeThreshold = opts?.runtimeThresholdMs ?? DEFAULT_CANCEL_CONFIRM_RUNTIME_MS;
		const now = (opts?.nowMs ?? Date.now)();
		const runtimeMs = entry.startedAtMs ? now - entry.startedAtMs : 0;
		const cost = entry.cost ?? 0;
		const overCost = costThreshold > 0 && cost >= costThreshold;
		const overRuntime = runtimeThreshold > 0 && runtimeMs >= runtimeThreshold;
		if (overCost || overRuntime) {
			this.beginCancelConfirm();
			return "confirm";
		}
		await this.doCancelFocusedEntry();
		return "immediate";
	}

	/** Programmatic entry into compose mode — used by tests. */
	_enterCompose(): void {
		this.focus = "composing";
		this.steerOperationOwner = undefined;
		this.scheduleRender();
	}
	/** Programmatic compose-mode setter — used by tests. */
	_setComposeMode(mode: ComposeMode): void {
		this.composeMode = mode;
		this.scheduleRender();
	}

	/**
	 * Whether arrow keys should move the list selection rather than scroll.
	 *
	 * Two panes route by pane focus, because both are visible at once. One
	 * column has no focus to route by — the level *is* the focus.
	 */
	private listHasFocus(): boolean {
		if (this.geometry.mode === "single-column") return this.level === "list";
		return this.pane === "list";
	}

	/**
	 * Move keyboard focus between the panes.
	 *
	 * Only meaningful in two panes. In one column the panes are levels, so
	 * `Enter` and `Esc` already do this job and a focus toggle would be a key
	 * that appears to do nothing.
	 */
	private movePane(target: OverlayPane): void {
		if (this.geometry.mode !== "two-pane" || this.pane === target) return;
		this.pane = target;
		this.scheduleRender();
	}

	/** Jump to live work; repeated presses cycle through every live entry. */
	private moveToLiveEntry(): void {
		const locations = this.liveRunEntryLocations();
		if (locations.length === 0) return;
		const current = locations.findIndex(
			(location) => location.runIndex === this.runIndex && location.entryIndex === this.forkIndex,
		);
		const target = locations[current >= 0 ? (current + 1) % locations.length : 0]!;
		this.selectEntryLocation(target.runIndex, target.entryIndex);
	}

	private scroll(deltaLines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + deltaLines);
		this.autoScroll = false;
		this.scheduleRender();
	}

	/**
	 * Render a borderless emergency layout when the terminal cannot hold the
	 * normal header/body/footer frame. Active prompt and compose controls are
	 * represented first so a short terminal never makes either state invisible.
	 */
	private renderCompact(
		width: number,
		maxRows: number,
		nowMs: number,
		mode: "normal" | "error" = "normal",
	): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeRows = Math.max(0, Math.floor(maxRows));
		// Compact content replaces the normal rendered body. Drop anchors from
		// that body and retain the equivalent normal-layout text width so an
		// immediate Enter can rebuild a round drill-down target correctly.
		this.invalidate();
		this.lastTextWidth = Math.max(1, safeWidth - 4);
		if (safeRows === 0) return [];
		const fit = (value: string): string => {
			const sanitized = sanitizeTranscriptText(value).replaceAll("\n", " ");
			return visibleWidth(sanitized) > safeWidth
				? truncateToWidth(sanitized, safeWidth, "…")
				: sanitized;
		};

		if (mode === "error") {
			return ["overlay error", "r retry · q close"]
				.slice(0, safeRows)
				.map(fit);
		}

		const run = this.targetRun();
		const entry = this.targetEntry();
		const prompts = this.currentPendingPrompts();
		const composing = this.focus === "composing";
		const lines: string[] = [];

		if (this.confirmingCancel) {
			lines.push(boundActivityText(
				this.lastComposeStatus ?? `cancel ${runEntryNoun(run?.shape)} ${entry?.name ?? "selected"}? [y] yes [n] no`,
			));
		}

		if (prompts.length > 0 && composing && safeRows === 1 && !this.confirmingCancel) {
			const input = this.composeBuffer.length > 0 ? this.composeBuffer : "(empty)";
			return [fit(`prompt + compose › ${input}`)];
		}

		if (prompts.length > 0) {
			const top = prompts[0]!;
			const countdown = top.expiresAt === undefined
				? ""
				: ` · ${Math.max(0, Math.round((top.expiresAt - nowMs) / 1_000))}s`;
			lines.push(`prompt · ${boundActivityText(top.title)}${countdown}`);
		}
		if (composing) {
			const target = COMPOSE_TARGETS[this.composeMode];
			const input = this.composeBuffer.length > 0 ? this.composeBuffer : "(empty)";
			lines.push(`compose → ${target.to} · › ${input}█`);
		}
		if (prompts.length > 0 || composing) {
			const controls = [
				prompts.length > 0 ? "y/n/s prompt" : "",
				composing ? "Enter send · Esc cancel" : "",
			].filter(Boolean).join(" · ");
			if (controls) lines.push(controls);
		}

		const appendDetachedSummary = (): void => {
			if (this.detachedRuns.length === 0) return;
			lines.push(detachedStatusLine(this.theme, this.detachedRuns[0]!, nowMs, this.icons));
			if (this.detachedRuns.length > 1) {
				lines.push(`… ${this.detachedRuns.length - 1} more detached run(s)`);
			}
			const warning = detachedStatusWarning(
				this.detachedStatusDegraded,
				this.detachedStatusTruncated,
			);
			if (warning) lines.push(warning.trim());
			lines.push(DETACHED_STATUS_HINT.trim(), DETACHED_CONTROL_HINT.trim());
		};

		if (run) {
			lines.push(`${boundActivityText(run.runId)} · [${getDelegatePresentationTerminology(run.shape).label}] · ${this.level}`);
			lines.push(entry
				? `${renderRunEntryIdentity(entry)} · ${entry.status}`
				: `constructing · waiting for first ${runEntryNoun(run.shape)}`);
			appendDetachedSummary();
		} else if (this.detachedRuns.length > 0) {
			lines.push(`delegate · ${this.detachedRuns.length} detached`);
			appendDetachedSummary();
		} else {
			lines.push("delegate · no runs");
		}
		const footer = this.confirmingCancel ? "y cancel · n/Esc keep" : "r refresh · q/Esc close";
		const contentRows = Math.max(0, safeRows - 1);

		return [...lines.slice(0, contentRows), footer].slice(0, safeRows).map(fit);
	}

	/**
	 * Rows this component may actually emit.
	 *
	 * The host clips overlay output to its resolved `maxHeight` *after* calling
	 * `render`, and a percentage `maxHeight` is floored against the terminal
	 * height. On a very short terminal that floor lands below the terminal row
	 * count — `92%` of 2 rows is 1 — so any row budgeted against the raw
	 * terminal height beyond that point is rendered and then silently dropped.
	 * Budgeting against the clipped height instead is what lets the compact
	 * layout make a deliberate choice about which categories survive.
	 */
	private effectiveRows(): number {
		const rawRows = this.tui.terminal.rows;
		const terminalRows = Number.isFinite(rawRows) ? Math.max(0, Math.floor(rawRows)) : 2;
		const cap = this.hostMaxHeight;
		if (cap === undefined) return terminalRows;
		if (typeof cap === "number") {
			return Number.isFinite(cap) ? Math.max(0, Math.min(terminalRows, Math.floor(cap))) : terminalRows;
		}
		const match = /^(\d+(?:\.\d+)?)%$/.exec(cap);
		if (!match) return terminalRows;
		// Mirrors pi-tui's `parseSizeValue`, which floors percentage sizes.
		return Math.max(0, Math.min(terminalRows, Math.floor((terminalRows * Number(match[1])) / 100)));
	}

	// ── Render ───────────────────────────────────────────────────────────────
	render(width: number): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
		try {
			const nowMs = this.now();
			if (safeWidth < 6) {
				return this.renderCompact(safeWidth, this.effectiveRows(), nowMs);
			}
			return this.renderInner(safeWidth, nowMs);
		} catch {
			// Never crash pi or echo an arbitrary exception (which may contain a
			// persisted prompt/error). Keep this surface categorical and bounded.
			let rows = 2;
			try {
				rows = this.effectiveRows();
			} catch {
				// A broken terminal metric still gets the two-row safe fallback.
			}
			return this.renderCompact(safeWidth, rows, 0, "error");
		}
	}

	private renderInner(width: number, nowMs: number): string[] {
		const theme = this.theme;
		const border = (s: string) => theme.fg(this.focused ? "border" : "borderMuted", s);
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);
		const rawTermRows = this.tui.terminal.rows;
		const measuredRows = Number.isFinite(rawTermRows)
			? Math.max(0, Math.floor(rawTermRows))
			: undefined;
		// Budget against the height the host will actually keep, not the raw
		// terminal height it clips from. Rows emitted past the clip are
		// discarded after this component returns them.
		const terminalRows = measuredRows === undefined ? undefined : this.effectiveRows();

		const innerWidth = Math.max(4, width - 2);
		// One geometry per render pass, reused by the input handlers so a key
		// press and the frame it acts on can never disagree about the layout.
		const geometry = resolveOverlayGeometry(innerWidth);
		this.geometry = geometry;
		const pad = (s: string, w: number) => {
			const clipped = visibleWidth(s) > w ? truncateToWidth(s, w, "…") : s;
			return clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
		};
		const row = (content: string) => border("\u2502") + pad(content, innerWidth) + border("\u2502");

		const lines: string[] = [];
		lines.push(border("\u256d" + "\u2500".repeat(innerWidth) + "\u256e"));

		if (this.runs.length === 0 && this.detachedRuns.length === 0) {
			if (terminalRows !== undefined && terminalRows < MIN_NORMAL_ROWS) {
				return this.renderCompact(width, terminalRows, nowMs);
			}
			lines.push(row(accent(" delegate overlay")));
			lines.push(border("\u251c" + "\u2500".repeat(innerWidth) + "\u2524"));
			lines.push(row(""));
			lines.push(row(dim("  No delegate runs in this session.")));
			lines.push(row(dim("  Dispatched runs appear here while they execute.")));
			lines.push(row(""));
			for (const l of this.renderComposePlaceholder(innerWidth, nowMs)) {
				lines.push(row(truncateToWidth(l, innerWidth, "…")));
			}
			lines.push(border("\u251c" + "\u2500".repeat(innerWidth) + "\u2524"));
			lines.push(row(dim(" r refresh \u00b7 q/Esc close")));
			lines.push(border("\u2570" + "\u2500".repeat(innerWidth) + "\u256f"));
			return lines;
		}

		// The list is rebuilt lazily here rather than on every state change:
		// render is the only place that needs it to be current.
		if (this.listRows.length === 0) this.rebuildList();

		// No local `run` here: the footer resolves its own control target, and
		// the header reads the detached status or the entry directly. Keeping a
		// stale run binding around is what let controls drift onto it (OV-12).
		const entry = this.targetEntry();
		const liveLocations = this.liveRunEntryLocations();
		let composeLines = this.renderComposePlaceholder(innerWidth, nowMs);
		let composeSectionRows = composeLines.length > 0 ? composeLines.length + 1 : 0;
		const requiresCompactControls =
			this.focus === "composing" || this.currentPendingPrompts().length > 0;
		// At the minimum normal height, a foreground group, its selected entry,
		// and the inter-group spacer consume the whole list viewport. Compact mode
		// keeps the first detached status visible instead of hiding all evidence
		// that another process is running.
		const requiresCompactMixedInventory = terminalRows !== undefined
			&& terminalRows <= MIN_NORMAL_ROWS
			&& this.runs.length > 0
			&& this.detachedRuns.length > 0;
		if (
			terminalRows !== undefined
			&& (
				terminalRows < MIN_NORMAL_ROWS
				|| requiresCompactMixedInventory
				|| (requiresCompactControls && terminalRows < MIN_NORMAL_ROWS + composeSectionRows)
			)
		) {
			return this.renderCompact(width, terminalRows, nowMs);
		}

		const availRows = measuredRows !== undefined && terminalRows !== undefined
			? Math.max(
					MIN_BODY_ROWS + HEADER_ROWS + FOOTER_ROWS,
					Math.min(terminalRows, Math.floor(measuredRows * OVERLAY_HEIGHT_FRAC)),
				)
			: DEFAULT_BODY_ROWS + HEADER_ROWS + FOOTER_ROWS;
		if (
			terminalRows !== undefined
			&& availRows < HEADER_ROWS + FOOTER_ROWS + MIN_BODY_ROWS + composeSectionRows
		) {
			return this.renderCompact(width, terminalRows, nowMs);
		}

		// ── Header: identity, then policy ────────────────────────────────────
		for (const headerLine of this.renderHeaderLines(entry, innerWidth, nowMs)) {
			lines.push(row(headerLine));
		}
		lines.push(
			geometry.mode === "two-pane"
				? border(
					"\u251c" + "\u2500".repeat(geometry.listWidth)
					+ "\u252c" + "\u2500".repeat(geometry.detailWidth) + "\u2524",
				)
				: border("\u251c" + "\u2500".repeat(innerWidth) + "\u2524"),
		);

		// On the minimum-height layout the collapsed steer hint duplicates the
		// footer's `s message`. Drop it — but never an active compose box,
		// prompt banner, or status message.
		if (
			this.focus === "viewing"
			&& this.lastComposeStatus === undefined
			&& composeLines.length === 1
			&& availRows < HEADER_ROWS + FOOTER_ROWS + MIN_BODY_ROWS + composeSectionRows
		) {
			composeLines = [];
			composeSectionRows = 0;
		}

		const bodyRows = Math.max(
			MIN_BODY_ROWS,
			availRows - HEADER_ROWS - FOOTER_ROWS - composeSectionRows,
		);
		this.lastBodyHeight = bodyRows;

		// Leave one column of the detail pane for the scrollbar marker, and one
		// for the gutter. Every width comes from the resolved geometry.
		const detailWidth = geometry.mode === "two-pane" ? geometry.detailWidth : innerWidth;
		const textWidth = Math.max(1, detailWidth - 2);
		this.lastTextWidth = textWidth;

		const detailLines = this.renderDetailPane(entry, textWidth, nowMs, width, bodyRows);
		const wrapped = detailLines.lines;
		const selectedBodyLine = detailLines.selectedLine;
		const selectedLastBodyLine = detailLines.selectedLastLine ?? selectedBodyLine;
		// A live wait is pinned to the last body row rather than scrolling with
		// the transcript, so it stays visible while you read back through it.
		const waitingRow = detailLines.waiting !== undefined && this.level === "transcript"
			? renderWaitingRow(detailLines.waiting, textWidth, this.theme, this.icons)
			: undefined;
		const scrollRows = waitingRow === undefined ? bodyRows : Math.max(1, bodyRows - 2);

		// Clamp scroll; honour autoScroll to stick to the bottom.
		const maxScroll = Math.max(0, wrapped.length - scrollRows);
		if (this.level === "transcript" && this.autoScroll) {
			this.scrollOffset = maxScroll;
		} else if (
			this.level !== "transcript"
			&& selectedBodyLine !== undefined
			&& selectedLastBodyLine !== undefined
		) {
			if (selectedBodyLine < this.scrollOffset) this.scrollOffset = selectedBodyLine;
			else if (selectedLastBodyLine >= this.scrollOffset + scrollRows) {
				this.scrollOffset = selectedLastBodyLine - scrollRows + 1;
			}
		} else if (this.scrollOffset > maxScroll) {
			this.scrollOffset = maxScroll;
		}
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const viewStart = Math.min(this.scrollOffset, maxScroll);
		const viewEnd = Math.min(wrapped.length, viewStart + scrollRows);

		// The heading of a block that has scrolled past the top is pinned back
		// at the top of the pane. This is what the deleted per-line rail bought:
		// attribution that survives scrolling into the middle of a long block.
		//
		// It costs one viewport row, so it is suppressed when that would leave
		// no row for the transcript itself. On a short terminal with a pinned
		// wait row the budget can fall to a single row, and pinning a heading
		// there made every body line unreachable at any scroll offset (review
		// finding OV-13). Attribution is worth a row only when there is a line
		// left to attribute.
		const stickyHeading = this.level === "transcript" && viewStart > 0 && scrollRows > 1
			? detailLines.headingAt?.[viewStart]
			: undefined;

		const scrollable = wrapped.length > scrollRows;
		let thumbAt = -1;
		if (scrollable) {
			const frac = maxScroll === 0 ? 0 : viewStart / maxScroll;
			thumbAt = Math.round(frac * (scrollRows - 1));
		}

		// The left column is rendered once and scrolled to keep the selection
		// visible; it does not share the detail pane's scroll offset.
		const listPane = geometry.mode === "two-pane"
			? this.renderListLines(geometry.listWidth, bodyRows, nowMs)
			: { lines: [], thumbAt: -1 };

		for (let r = 0; r < bodyRows; r++) {
			const lineIdx = viewStart + r;
			let rawText: string;
			if (waitingRow !== undefined && r === bodyRows - 1) {
				rawText = waitingRow;
			} else if (waitingRow !== undefined && r === bodyRows - 2) {
				rawText = dim("\u2500".repeat(Math.max(0, textWidth)));
			} else if (stickyHeading !== undefined && r === 0) {
				// One row of the viewport is spent on the pinned heading, so the
				// line it covers is reachable by scrolling one further.
				rawText = dim(truncateToWidth(`\u25b8 ${stickyHeading}`, textWidth, "\u2026"));
			} else {
				rawText = lineIdx < viewEnd ? wrapped[lineIdx]! : "";
			}
			// Belt-and-suspenders truncate: guarantee no row exceeds textWidth
			// even if the wrapper miscomputed (e.g. CJK / wide chars).
			const text = visibleWidth(rawText) > textWidth
				? truncateToWidth(rawText, textWidth, "…")
				: rawText;
			const padded = pad(text, textWidth);
			const bar = scrollable
				? r === thumbAt
					? accent("\u2588")
					: dim("\u2502")
				: " ";
			if (geometry.mode === "two-pane") {
				const listLine = listPane.lines[r] ?? " ".repeat(geometry.listWidth);
				// The list's scrollbar lives in the divider the frame already
				// spends a column on, so a crowded inventory says so without
				// taking a cell of identity off every row to say it.
				const listBar = r === listPane.thumbAt ? accent("\u2588") : border("\u2502");
				lines.push(
					border("\u2502") + listLine + listBar
					+ " " + padded + bar + border("\u2502"),
				);
			} else {
				lines.push(border("\u2502") + " " + padded + bar + border("\u2502"));
			}
		}

		if (composeLines.length > 0) {
			lines.push(border("\u251c" + "\u2500".repeat(innerWidth) + "\u2524"));
			for (const l of composeLines) lines.push(row(truncateToWidth(l, innerWidth, "…")));
		}

		lines.push(
			geometry.mode === "two-pane"
				? border(
					"\u251c" + "\u2500".repeat(geometry.listWidth)
					+ "\u2534" + "\u2500".repeat(geometry.detailWidth) + "\u2524",
				)
				: border("\u251c" + "\u2500".repeat(innerWidth) + "\u2524"),
		);

		// The footer advertises what the keys will actually do, so it asks the
		// control target rather than the derived pointer: a detached selection
		// must not offer `s message` for an entry it would not steer (OV-12).
		lines.push(row(this.renderFooterLine(this.targetRun(), liveLocations.length, innerWidth)));
		lines.push(border("\u2570" + "\u2500".repeat(innerWidth) + "\u256f"));
		return lines;
	}

	/**
	 * The two header rows: what the selected worker is, and what it was
	 * allowed to do.
	 *
	 * A detached run has neither in the same sense — it is another process —
	 * so it gets its own pair of rows rather than blank ones.
	 */
	private renderHeaderLines(
		entry: RunLiveState | undefined,
		innerWidth: number,
		nowMs: number,
	): string[] {
		const theme = this.theme;
		const paint = (segments: readonly HeaderSegment[]): string => {
			const painted = segments
				.map((segment) => {
					const text = segment.bold === true ? theme.bold(segment.text) : segment.text;
					return theme.fg(segment.tone, text);
				})
				.join("");
			return truncateToWidth(` ${painted}`, innerWidth, "…");
		};

		const detached = this.selectedDetached();
		if (detached) {
			const glyph = detachedStatusGlyph(theme, detached, this.icons);
			return [
				truncateToWidth(
					` ${glyph} ${theme.bold(detached.runId)}`
					+ theme.fg("dim", " · ")
					+ theme.fg("text", `${canonicalRunShape(detached.shape)} · detached`),
					innerWidth,
					"…",
				),
				truncateToWidth(
					theme.fg("dim", " another process · status read from durable state"),
					innerWidth,
					"…",
				),
			];
		}

		if (entry === undefined) {
			return [
				truncateToWidth(theme.fg("accent", " delegate overlay"), innerWidth, "…"),
				truncateToWidth(theme.fg("dim", ` no ${runEntryNoun(this.currentRun()?.shape)} selected`), innerWidth, "…"),
			];
		}

		const glyph = statusGlyph(theme, entry.status, this.icons);
		const identity = paint(buildIdentitySegments(entry, this.runShape(this.currentRun()), nowMs));
		return [
			truncateToWidth(` ${glyph}${identity}`, innerWidth, "…"),
			paint(buildPolicySegments(entry)),
		];
	}

	/** Options shared by every surface that draws the inventory. */
	private listColumnOptions(width: number, nowMs: number): RenderListOptions {
		return {
			width,
			theme: this.theme,
			selected: this.listIndex,
			focused: this.listHasFocus(),
			headlines: this.collectHeadlines(),
			glyph: (entry) => statusGlyph(this.theme, entry.status, this.icons),
			detachedGlyph: (row) => detachedStatusGlyph(this.theme, row.status, this.icons),
			nowMs,
			icons: this.icons,
		};
	}

	/**
	 * Render the left column, scrolled so the selected row stays visible, and
	 * report where its scrollbar thumb belongs.
	 *
	 * The scrollbar is the point. Selection movement always reached every row,
	 * but with a dozen runs the column showed four of them and said nothing
	 * about the rest, so the inventory looked complete when it was not. The
	 * detail pane has drawn a thumb for exactly this reason since the redesign;
	 * the list simply never got one.
	 *
	 * The thumb is reported rather than drawn, because it goes in the pane
	 * divider the frame already spends a column on. Taking a cell out of the
	 * list instead cost every run heading its dispatch clock at the common
	 * 41-cell width — and it cost it in exactly the crowded session that made
	 * the scrollbar necessary.
	 *
	 * Every returned line is exactly `listWidth` cells, including the padding
	 * rows past the end of a short list, so the caller composes the frame
	 * without re-measuring.
	 */
	private renderListLines(
		listWidth: number,
		bodyRows: number,
		nowMs: number,
	): { lines: string[]; thumbAt: number } {
		const rendered = renderListColumnFitted(
			this.listRows,
			this.listColumnOptions(listWidth, nowMs),
			bodyRows,
		);
		const lines = rendered.lines;
		const maxScroll = Math.max(0, lines.length - bodyRows);
		if (rendered.selectedLine !== undefined && rendered.selectedLastLine !== undefined) {
			if (rendered.selectedLine < this.listScrollOffset) {
				this.listScrollOffset = rendered.selectedLine;
			} else if (rendered.selectedLastLine >= this.listScrollOffset + bodyRows) {
				this.listScrollOffset = rendered.selectedLastLine - bodyRows + 1;
			}
		}
		this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, maxScroll));
		const visible = lines.slice(this.listScrollOffset, this.listScrollOffset + bodyRows);
		const blank = " ".repeat(Math.max(0, listWidth));
		const out: string[] = [];
		for (let r = 0; r < bodyRows; r++) out.push(visible[r] ?? blank);
		// Position the thumb from the scroll offset, exactly as the detail pane
		// does, so one marker does not mean two things on one screen.
		const thumbAt = lines.length > bodyRows && bodyRows > 0
			? Math.round((maxScroll === 0 ? 0 : this.listScrollOffset / maxScroll) * (bodyRows - 1))
			: -1;
		return { lines: out, thumbAt };
	}

	/**
	 * The inventory as a body pane, for the single column.
	 *
	 * One column has no left pane to put the list in, so at the `list` level
	 * the list *is* the body. Before this the level rendered the summary stack
	 * — the same body the `summary` level renders — which made `Enter` produce
	 * an identical frame while silently switching the arrows from selecting to
	 * scrolling.
	 *
	 * Not routed through the rendered-body cache. The column reads live status
	 * and activity for every row, none of which is in the cache key, so a hit
	 * would serve a stale inventory for up to the cache's time bucket. The
	 * two-pane column is uncached for the same reason and costs the same.
	 */
	private renderInventoryBody(textWidth: number, bodyRows: number, nowMs: number): OverlayBodyLines {
		const rendered = renderListColumnFitted(
			this.listRows,
			this.listColumnOptions(textWidth, nowMs),
			bodyRows,
		);
		if (rendered.lines.length === 0) {
			return { lines: [this.theme.fg("dim", " No delegate work to list.")] };
		}
		return rendered.selectedLine === undefined || rendered.selectedLastLine === undefined
			? { lines: rendered.lines }
			: {
				lines: rendered.lines,
				selectedLine: rendered.selectedLine,
				selectedLastLine: rendered.selectedLastLine,
			};
	}

	/** Live activity headlines for every entry on screen, keyed by identity. */
	private collectHeadlines(): ReadonlyMap<string, string> {
		const headlines = new Map<string, string>();
		for (const row of this.listRows) {
			if (row.kind !== "entry") continue;
			const headline = getActivityHeadline(row.run.runId, row.entry.name);
			if (headline) headlines.set(headlineKey(row.run.runId, row.entry.name), headline.text);
		}
		return headlines;
	}

	/**
	 * Render whichever body the layout and level call for.
	 *
	 * Everything but the inventory goes through the rendered-body cache; the
	 * inventory says below why it does not.
	 */
	private renderDetailPane(
		entry: RunLiveState | undefined,
		textWidth: number,
		nowMs: number,
		width: number,
		bodyRows: number,
	): OverlayBodyLines {
		// One column at the `list` level draws the inventory itself, and does it
		// before anything else here: the body is the list, so which row is
		// selected — detached or not — decides nothing about what is rendered.
		if (bodyKindFor(this.geometry.mode, this.level) === "inventory") {
			const body = this.renderInventoryBody(textWidth, bodyRows, nowMs);
			// An inventory has no transcript nodes, so the anchors a transcript
			// left behind must not survive into it: stale anchors would send
			// PgDn and `Enter`-to-expand at rows that are not there.
			this.restoreBodyAnchors(body);
			return body;
		}
		// A detached run has no foreground transcript, and `entry` here is
		// whatever entry was last selected — an unrelated one. Rendering it
		// under a detached run's header would attribute one run's work to
		// another, which is precisely the fabrication the README forbids.
		//
		// The guard is therefore on the BODY, not the level: a detached run
		// never reaches `renderTranscriptBody`. Its deepest level renders its
		// own event log instead, so `entry` is never consulted for it.
		const detached = this.selectedDetached();
		const level = detailLevelFor(this.level);
		let projectionIdentity: object | undefined;
		let renderBody: () => OverlayBodyLines;
		if (detached !== undefined) {
			// Both detached levels ignore `entry` entirely.
			projectionIdentity = undefined;
			renderBody = level === "summary"
				? () => this.renderDetachedSummaryBody(textWidth, nowMs)
				: () => this.renderDetachedEventLogBody(detached.runId, textWidth);
			if (level === "summary") this.updateDigestProjections(nowMs);
		} else if (level === "summary") {
			this.updateDigestProjections(nowMs);
			projectionIdentity = this.digestProjectionIdentity;
			renderBody = () => this.renderSummaryBody(textWidth, nowMs);
		} else {
			projectionIdentity = entry?.transcript;
			renderBody = () => this.renderTranscriptBody(entry, textWidth, nowMs);
		}
		const activityHistory = entry?.activityHistory;
		return this.renderBodyFromCache({
			level,
			layoutMode: this.geometry.mode,
			listWidth: this.geometry.listWidth,
			detailWidth: this.geometry.detailWidth,
			pane: this.pane,
			listIndex: this.listIndex,
			width,
			innerWidth: this.geometry.innerWidth,
			textWidth,
			bodyHeight: bodyRows,
			runIndex: this.runIndex,
			forkIndex: this.forkIndex,
			roundSelection: this.roundSelection,
			scrollOffset: this.scrollOffset,
			autoScroll: this.autoScroll,
			thinkingLevel: this.thinkingLevel,
			toolDetail: this.toolDetail,
			taskDisplayMode: this.taskDisplayMode,
			foldMessages: this.foldMessages,
			timeBucket: Math.floor(nowMs / 5_000),
			projectionIdentity,
			entryIdentity: entry,
			activityHistory,
			activityHistoryLength: activityHistory?.length ?? 0,
			finalActivityEntry: activityHistory?.at(-1),
		}, renderBody);
	}

	/**
	 * The footer hint row, narrowed to what the current level actually offers.
	 *
	 * Advertising a control a shape rejects is how the overlay used to promise
	 * steering on a direct run (issue #198), so `s` is filtered rather than
	 * shown and then refused.
	 */
	private renderFooterLine(
		run: DelegateDispatchState | undefined,
		liveCount: number,
		innerWidth: number,
	): string {
		const accent = (s: string) => this.theme.fg("accent", s);
		const dim = (s: string) => this.theme.fg("dim", s);
		const wide = innerWidth >= 86;
		const medium = innerWidth >= 58;
		const paneHint = this.geometry.mode === "two-pane" ? "tab pane" : undefined;
		const targetProgress = this.targetEntry()?.taskProgress;
		const hasPlan = targetProgress !== undefined && targetProgress.total > 0;
		let footParts: string[];
		if (this.level === "transcript") {
			footParts = wide
				? [
					"Esc back",
					"q close",
					"\u2191\u2193 scroll",
					...(paneHint ? [paneHint] : []),
					"l live",
					`f view:${this.viewMode}`,
					`t think:${["off", "150", "full"][this.thinkingLevel]}`,
					`g tools:${this.toolDetail}`,
					"s message",
				]
				: medium
					? ["Esc back", "q close", "\u2191\u2193 scroll", "l live", "f view", "t/g", "s message"]
					: ["Esc", "q", "\u2191\u2193", "l", "f", "t/g", "s"];
		} else {
			footParts = wide
				? [
					"\u2191\u2193 select",
					"\u23ce open",
					"Esc back",
					"q close",
					...(paneHint ? [paneHint] : []),
					"PgUp/PgDn",
					"l live",
					`f view:${this.viewMode}`,
					...(hasPlan ? [`p plan:${this.taskDisplayMode}`] : []),
					"s message",
				]
				: medium
					? ["\u2191\u2193 select", "\u23ce open", "Esc back", "q close", "l", "f view", ...(hasPlan ? ["p plan"] : []), "s"]
					: ["\u2191\u2193", "\u23ce", "Esc", "q", "l", "f", ...(hasPlan ? ["p"] : []), "s"];
		}
		if (!this.canSteerSelectedTarget(run)) {
			footParts = footParts.filter((part) => part !== "s" && part !== "s message");
		}
		if (liveCount > 0 && wide) footParts.push(`${liveCount} live`);
		const autoLabel = this.autoScroll ? accent("\u25cf") : dim("\u25cb");
		const suffix = this.level === "transcript" ? `  ${autoLabel}` : "";
		const line = ` ${footParts.join(" \u00b7 ")}${suffix}`;
		// The completion banner takes the slot `N live` occupies while work is
		// in flight. `autoCloseInspectorOnComplete` defaults off now, so this
		// is what tells you the run finished — the overlay no longer says it
		// by vanishing.
		const banner = liveCount === 0 ? this.completionBanner(innerWidth) : undefined;
		if (banner === undefined) return truncateToWidth(line, innerWidth, "\u2026");
		const room = innerWidth - visibleWidth(banner) - 3;
		if (room < 1) return truncateToWidth(banner, innerWidth, "\u2026");
		return `${truncateToWidth(line, room, "\u2026")}`
			+ dim(" \u00b7 ")
			+ banner;
	}

	/**
	 * The completion banner, or `undefined` while anything is still running.
	 *
	 * Counts only owned foreground entries. A detached run's outcome is reported
	 * by its own status card: rolling another process's result into this
	 * session's rollup would claim knowledge we do not have.
	 */
	private completionBanner(innerWidth: number): string | undefined {
		const statuses: string[] = [];
		let constructing = 0;
		for (const run of this.runs) {
			const entries = Object.values(run.forks);
			// A registered run with no entry yet contributes no status, so
			// counting statuses alone let it read as finished (OV3-COMPLETION-TRUTH).
			if (entries.length === 0) constructing += 1;
			for (const entry of entries) statuses.push(entry.status);
		}
		const model = buildCompletion(statuses, constructing);
		if (!model) return undefined;
		const text = formatCompletionBanner(model, Math.max(1, Math.floor(innerWidth / 2)), this.icons);
		return text === undefined ? undefined : this.theme.fg(completionTone(model), text);
	}

	invalidate(): void {
		this.renderedBodyCache = undefined;
		this.entryAnchors = new Map();
		this.pageRanges = [];
		// Deliberately does NOT drop `listRows`: the selection movers call this
		// after setting `listIndex`, and rebuilding here would discard the row
		// they just chose. Staleness is handled by `rebuildList()` on the event
		// path instead.
	}

	dispose(): void {
		// Idempotent: `dismiss()` calls this directly, and the extension's own
		// teardown reaches it through `close()`. No current path resolves the
		// host promise, so the host's own dispose-on-resolve never runs.
		// Unsubscribing twice would be harmless, but clearing caches under a
		// later render would not.
		if (this.disposed) return;
		this.disposed = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.stopDetachedRefresh();
		this.cancelAutoClose();
		this.cancelFocusLossClose();
		for (const off of this.unsubs) {
			try {
				off();
			} catch {
				/* noop */
			}
		}
		this.unsubs.length = 0;
		this.invalidate();
		this.roundActivityCache.clear();
		this.digestCache.clear();
		this.digestProjections = new Map();
		this.digestProjectionIdentity = {};
		this.digestStructureFingerprint = "";
	}
}

/**
 * The per-entry glyph rendered in the transcript-overlay entry list.
 * Exported so the spec-0019 paused-glyph regression test can invoke the REAL
 * mapping (not a duplicated literal). Pure; total over `RunLiveStatus`.
 */
export function statusGlyph(
	theme: OverlayTheme,
	status: RunLiveState["status"],
	marks: IconSet = iconSet("unicode"),
): string {
	switch (status) {
		case "running":
		case "awaiting-escalation":
		case "pending":
		case "constructing":
			// Spec 0006 / REQ-HANDOFF-3 — `constructing` is a live (in-flight,
			// not-done) status; render it with the same in-flight `active`
			// marker as running/pending so the switch stays exhaustive over
			// RunLiveStatus. The glyph itself follows the configured icon
			// vocabulary and is not fixed.
			return theme.fg("accent", marks.active);
		case "completed":
			return theme.fg("success", marks.completed);
		case "failed":
			return theme.fg("error", marks.failed);
		case "aborted":
			return theme.fg("warning", marks.aborted);
		// Spec 0019 / REQ-PAUSE-4 — a paused supervised fork (supervisor forced
		// to finish at max_rounds) gets the ⏸ pause glyph, matching status-widget.ts
		// + render.ts. Without this case a paused fork rendered blank (undefined).
		case "paused":
			return theme.fg("warning", marks.paused);
	}
}

function detachedStatusGlyph(
	theme: OverlayTheme,
	status: UniformRunStatus,
	marks: IconSet = iconSet("unicode"),
): string {
	if (isUniformRunLive(status)) return theme.fg("accent", marks.active);
	if (status.state === "terminal-failed") return theme.fg("error", marks.failed);
	if (status.state === "terminal-paused") return theme.fg("warning", marks.paused);
	return theme.fg("success", marks.completed);
}

function detachedStatusLine(
	theme: OverlayTheme,
	status: UniformRunStatus,
	nowMs: number,
	marks: IconSet = iconSet("unicode"),
): string {
	return ` ${detachedStatusGlyph(theme, status, marks)} ${formatUniformRunStatus(status, nowMs)}`;
}

function detachedStatusWarning(degraded: boolean, truncated: boolean): string | undefined {
	const notes = [
		degraded ? "scan degraded" : "",
		truncated ? "truncated (active markers prioritized)" : "",
	].filter(Boolean);
	return notes.length > 0 ? ` status warning: ${notes.join(", ")}` : undefined;
}

/**
 * Normalize raw transcript text for TUI display. Tool results (file reads,
 * test output, etc.) can contain tabs and other control characters that
 * pi-tui's `visibleWidth` expands differently than our local `wrap` counts,
 * which can produce rendered lines wider than the terminal and trip pi-tui's
 * hard-crash assertion in `Render.draw`.
 *
 *  - `\t` → 3 spaces to match `pi-tui/utils.visibleWidth`'s tab handling.
 *  - `\r` is stripped (part of CRLF line endings; CR alone confuses wrap).
 *  - Other C0 control chars except `\n` are stripped as they have no useful
 *    display value in a transcript overlay.
 *
 * Raw text is preserved for summarization, run-history, and heartbeat
 * payloads; only the display path goes through this function.
 */
export function sanitizeTranscriptText(raw: string): string {
	if (!raw || (!raw.includes("\t") && !/[\x00-\x08\x0b-\x1f\x7f]/.test(raw))) return raw;
	return raw
		.replace(/\t/g, "   ")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Options for the structured inspector renderer. */
export interface StructuredRenderOpts {
	thinkingLevel: ThinkingLevel;
	toolDetail: ToolDetail;
	/** Selected in-process run shape, used for actor/audience attribution. */
	runShape?: string;
	/** Reference time for computing pending-tool ages (ms epoch). */
	now: number;
	/**
	 * Fold long, already-finished messages to a bounded preview so one large
	 * prompt cannot eat the whole viewport. The newest message node is never
	 * folded, so live streaming output stays whole. Defaults to `false` (the
	 * pre-fold behaviour) when omitted.
	 */
	foldLongMessages?: boolean;
}

/**
 * Format a tool duration/age compactly: sub-10s with one decimal (`1.2s`),
 * seconds up to a minute (`25s`), then minutes (`3m`).
 */
function formatToolDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}



/**
 * Format an entry timestamp as `HH:MM:SS` (24h, local time). Returns a
 * fixed-width placeholder when the timestamp is missing so rendered
 * transcripts stay column-aligned.
 */
function formatEntryTime(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "--:--:--";
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function renderActivityHistoryLines(
	entries: readonly ActivityStatusEntry[],
	width: number,
	theme: OverlayTheme,
): string[] {
	if (entries.length === 0) return [];
	const w = Math.max(8, width);
	const lines = [theme.fg("accent", " activity history")];
	for (const entry of entries.slice(-10)) {
		const text = `${formatEntryTime(entry.timestamp)} · ${entry.source} · ${entry.classification} · ${entry.text}`;
		for (const line of wrapTextWithAnsi(sanitizeTranscriptText(text), w - 1)) {
			lines.push(theme.fg("dim", ` ${line}`));
		}
	}
	return lines;
}

// The local `wrap()` function that used to live here was replaced by
// pi-tui's `wrapTextWithAnsi`, which is visible-width-aware end-to-end and
// additionally tracks ANSI state across wrap points (a pure upgrade for
// colored tool output, which our local impl stripped the ANSI context of).
//
// The decision, audit notes, and the specific `remaining.slice(width)` bug
// that prompted the original sanitize commit are documented in
// `.spec/tui-overlay-pattern.md`. We re-export `wrapTextWithAnsi` as `wrap`
// so existing callers (and the unit test file) stay stable.
export { wrapTextWithAnsi as wrap } from "@earendil-works/pi-tui";

// ─── Extension wiring ────────────────────────────────────────────────────────

export interface TranscriptOverlayHandle {
	open(): Promise<void>;
	/**
	 * Run `work` with the inspector out of the way, then put it back if it was
	 * open to begin with.
	 *
	 * For anything that takes the keyboard while the inspector may be mounted —
	 * an escalation prompt above all. Those prompts render *underneath* a
	 * capturing overlay, so without this the operator gets a dialog they cannot
	 * see and an inspector that answers no key.
	 *
	 * The overlay's own focus-loss guard catches this case too, but only after
	 * the fact. This is the deliberate version: it hides the inspector before
	 * the prompt is shown and restores it after, so answering a question costs
	 * the operator neither their scroll position nor their selection.
	 *
	 * Restoring is best-effort and never blocks the result: `work`'s value is
	 * returned, and its rejection is rethrown, whatever the overlay does.
	 */
	withOverlayHidden<T>(work: () => Promise<T>): Promise<T>;
	dispose(): void;
}


/**
 * Narrow, test-friendly contract for the subset of `ctx.ui` we need. The
 * shape matches `ExtensionUIContext.custom` in pi-coding-agent.
 */
/**
 * Subset of pi-tui's OverlayOptions we use to dock the inspector. Kept local
 * (structural) so overlay unit tests don't need to import pi-coding-agent.
 */
/**
 * The subset of pi-tui's `OverlayHandle` the inspector uses.
 *
 * Structural, like `InspectorOverlayOptions` above, so the overlay unit tests
 * do not have to import pi-coding-agent to supply one.
 */
export interface InspectorOverlayHandle {
	/** Temporarily hide or show this overlay, without unmounting it. */
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	/**
	 * Remove THIS overlay from the host's stack, permanently.
	 *
	 * pi-tui splices by identity (`overlayStack.indexOf(entry)`), which is what
	 * makes this safe where resolving the promise is not: the host's
	 * `hideOverlay()` pops the tail of the stack whoever that turns out to be.
	 */
	hide(): void;
}

export interface InspectorOverlayOptions {
	width?: number | `${number}%`;
	minWidth?: number;
	maxHeight?: number | `${number}%`;
	anchor?:
		| "center"
		| "top-left"
		| "top-right"
		| "bottom-left"
		| "bottom-right"
		| "top-center"
		| "bottom-center"
		| "left-center"
		| "right-center";
	visible?: (termWidth: number, termHeight: number) => boolean;
}

export interface OverlayUI {
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: InspectorOverlayOptions;
			/**
			 * Called with the host's handle for THIS overlay once it is shown.
			 *
			 * Needed because resolving the `custom` promise makes the host call
			 * `hideOverlay()`, which pops whatever is topmost — not necessarily
			 * us. The handle is the only way to address our own entry.
			 */
			onHandle?: (handle: InspectorOverlayHandle) => void;
		},
	): Promise<T>;
	notify(msg: string, kind?: "info" | "warning" | "error"): void;
	/**
	 * Optional — real ExtensionUIContext exposes this; overlay unit tests
	 * that never exercise the cancel-confirm fallback may omit it.
	 */
	confirm?(title: string, description?: string): Promise<boolean>;
}

/** Format ms as `Hh Mm Ss` / `Mm Ss` / `Ss`. Exported for tests. */
export function formatRuntime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/**
 * Pick the "most interesting" live entry across all runs. Used by the
 * global cancel shortcut when the overlay is closed and we have no explicit
 * focus. Preference: running/awaiting-escalation entries first, then
 * pending/constructing entries, all routed through canonical liveness.
 */
export function pickGlobalCancelTarget(): { run: DelegateDispatchState; entry: RunLiveState; /** @deprecated Use `entry`. */ fork: RunLiveState } | undefined {
	let fallback: { run: DelegateDispatchState; entry: RunLiveState; /** @deprecated Use `entry`. */ fork: RunLiveState } | undefined;
	for (const run of listRuns().filter(hasLocalRunAuthority)) {
		for (const entry of Object.values(run.forks)) {
			if (!isLiveStatus(entry.status)) continue;
			if (entry.status === "running" || entry.status === "awaiting-escalation") {
				return { run, entry, fork: entry };
			}
			fallback ??= { run, entry, fork: entry };
		}
	}
	return fallback;
}

/**
 * Build the confirm-dialog prompt text used by the cancel shortcut when the
 * overlay is closed. Mirrors the wording in the spec. Exported for tests so
	 * they can pin the format without spinning up a full extension context.
 */
export function buildCancelConfirmPrompt(
	entry: RunLiveState,
	nowMs: number = Date.now(),
	shape?: string,
): { title: string; description: string } {
	const runtimeMs = entry.startedAtMs ? nowMs - entry.startedAtMs : 0;
	const cost = entry.cost ?? 0;
	const title = `Cancel ${runEntryNoun(shape)} '${entry.name}'?`;
	const description =
		`${formatRuntime(runtimeMs)}, $${cost.toFixed(2)}, round ${entry.currentRound}/${entry.maxRounds}\n` +
		`agent: ${entry.agent}\n\n` +
		`[y] yes  [N] no`;
	return { title, description };
}

/**
 * Wire the transcript inspector handle and keyboard shortcuts. Slash-command
 * registration is centralized in `slash-commands.ts`; callers give its
 * `/delegate-inspector` handler the returned handle's `open` method.
 *
 * Called from `session_start`. The returned handle must be disposed on
 * `session_shutdown` so pi reload cycles don't leak shortcuts.
 *
 * Shortcut resolution:
 *   - Option-O / `alt+o` is always registered as the convenience toggle.
 *   - `opts.shortcut`, config `overlayShortcut`, or `DEFAULT_OVERLAY_SHORTCUT`
 *     (`ctrl+alt+d`) adds the fallback open chord.
 * An empty fallback string ("") disables both shortcuts. Registration errors
 * are surfaced via `ctx.ui.notify` so extension load never aborts.
 */
export function setupTranscriptOverlay(
	pi: ExtensionAPI,
	ctx: { ui: OverlayUI; hasUI?: boolean },
	opts?: {
		shortcut?: string;
		cancelShortcut?: string;
		cancelBypassShortcut?: string;
		/** Owner-scoped status-only detached orchestrators. */
		detachedStatuses?: () => UniformRunStatus[] | ListAllRunStatusesResult;
		/**
		 * Bounded per-run event read for a detached run's event log. Called
		 * only while that run's deepest level is on screen, never per refresh.
		 */
		detachedEvents?: (runId: string) => {
			events: RunEventRecord[];
			truncated: boolean;
		};
		/** Test/config seam; default one second while mounted. */
		detachedRefreshIntervalMs?: number;
		/** Test seam; default `FOCUS_LOSS_CLOSE_MS`. Zero closes synchronously. */
		focusLossCloseMs?: number;
	},
): TranscriptOverlayHandle | null {
	if (!ctx.hasUI) return null;

	let disposed = false;
	let isOpen = false;
	let mountedInstance: TranscriptOverlay | null = null;
	// Resolve configuration once for this Pi session. In particular, retain one
	// mutable preference object across every overlay instance opened by this
	// handle; a later setup call creates a fresh object from config.
	const config: DelegateConfig = (() => {
		try {
			return loadConfig();
		} catch {
			return {};
		}
	})();
	const preferences = createOverlayPreferences(config);
	// One vocabulary for the whole session. Resolved once, because the setting
	// cannot change while mounted and re-reading `process.env` per render would
	// make the overlay's output depend on when it was drawn.
	const icons = overlayIcons(config.footerIcons);

	// Resolve the inspector's placement once at setup. `dock` anchors a
	// responsive right-side panel (clamps to a legible min width, collapses
	// to ~fullscreen on narrow phones-over-SSH); `full` centres a near-
	// fullscreen overlay. Best-effort — any config error falls back to dock.
	const inspectorOverlayOptions: InspectorOverlayOptions = (() => {
		// Centred is the default now: the explorer needs the width for two
		// panes. An explicit `"dock"` still gets the narrow anchored panel.
		const layout: "dock" | "full" = config.inspectorLayout === "dock" ? "dock" : "full";
		return layout === "full"
			? { anchor: "center", width: "90%", maxHeight: "90%" }
			: { anchor: "right-center", width: "42%", minWidth: 64, maxHeight: "92%" };
	})();
	// Resolve auto-close-on-completion once at setup. Best-effort — any config
	// error falls back to the default, which is now OFF: a centered modal must
	// not dismiss a result the reader has not looked at yet.
	const autoCloseOnComplete =
		config.autoCloseInspectorOnComplete ?? DEFAULT_AUTO_CLOSE_INSPECTOR_ON_COMPLETE;
	// No handle is kept on the `ctx.ui.custom` promise. The overlay unmounts by
	// removing its own stack entry and never resolves it (see `dismiss`), so it
	// stays pending for the life of the session and awaiting it would hang.
	// `onDismissed` reports the unmount synchronously instead.
	const openOverlay = async () => {
		if (disposed) return;
		// A hidden instance is still mounted: bring it back rather than opening
		// a second one, which would leave the hidden overlay stranded on the
		// stack and cost the operator their scroll position and selection.
		if (isOpen && mountedInstance?.isHidden()) {
			mountedInstance.restore();
			return;
		}
		if (isOpen) return;
		isOpen = true;
		// Deliberately not awaited and not retained: the overlay unmounts by
		// removing its own stack entry rather than resolving (see `dismiss`), so
		// this promise stays pending for the life of the session.
		void ctx.ui
			.custom<undefined>(
				(tui, theme, keybindings, done) => {
					const inst = new TranscriptOverlay(tui, theme, keybindings, done, {
						events: pi.events as unknown as OverlayEventBus,
						autoCloseOnComplete,
						detachedStatuses: opts?.detachedStatuses,
						detachedEvents: opts?.detachedEvents,
						detachedRefreshIntervalMs: opts?.detachedRefreshIntervalMs,
						// Mirror the host clip so short-terminal row budgeting
						// matches the height the compositor actually keeps.
						hostMaxHeight: inspectorOverlayOptions.maxHeight,
						preferences,
						icons,
						...(opts?.focusLossCloseMs === undefined
							? {}
							: { focusLossCloseMs: opts.focusLossCloseMs }),
						// Runs when the overlay unmounted itself by identity
						// instead of resolving, so the promise's `finally`
						// never fired. Same bookkeeping, different trigger.
						onDismissed: () => {
							isOpen = false;
							mountedInstance = null;
						},
						onFocusLossClose: () => {
							// The operator's screen just changed without them
							// asking. Say why, and say how to come back, because
							// the alternative is an inspector that vanishes for
							// no visible reason.
							ctx.ui.notify(
								`delegate: inspector hidden — the main thread needs input. Press ${OPTION_O_OVERLAY_SHORTCUT} to bring it back.`,
								"info",
							);
						},
					});
					mountedInstance = inst;
					return inst;
				},
				{
					overlay: true,
					overlayOptions: inspectorOverlayOptions,
					// The handle is the ONLY way this overlay can leave the
					// stack safely. Resolving the promise makes the host pop
					// the tail, which is never provably this entry
					// (review finding CR-OVERLAY-CLOSE-TOPMOST).
					onHandle: (handle) => {
						mountedInstance?.attachHostHandle(handle);
					},
				},
			)
			.catch((err: unknown) => {
				ctx.ui.notify(
					`delegate overlay failed: ${(err as Error).message ?? err}`,
					"error",
				);
			})
			.finally(() => {
				// Not reached by an ordinary unmount: nothing RESOLVES this
				// promise, so `onDismissed` does that bookkeeping. It is still
				// reached when the promise REJECTS — the `.catch()` above turns
				// a mount failure into a notify, and this then clears the
				// state. Both routes are idempotent, so whichever arrives first
				// wins.
				isOpen = false;
				mountedInstance = null;
			});
	};

	// Slash-command recovery path. If the overlay is already mounted but the
	// user can still run a slash command, it means the main input has focus
	// and the overlay is present-but-unreachable (e.g. focus reclaimed by the
	// editor, a nested modal stole input, or another extension's overlay
	// raced in). A hidden instance is restored in place; otherwise the stale
	// instance is unmounted by identity and a fresh one mounted, so the TUI
	// refocuses on it.
	const reopenOverlay = async () => {
		if (disposed) return;
		// Hidden but mounted: unhide in place. Tearing it down and remounting
		// would throw away the scroll position and selection for no reason.
		if (isOpen && mountedInstance?.isHidden()) {
			mountedInstance.restore();
			return;
		}
		if (isOpen && mountedInstance) {
			try {
				// Removes its entry by identity and fires `onDismissed`
				// synchronously, which clears `isOpen`/`mountedInstance`. There
				// is nothing to await: the promise never resolves.
				mountedInstance.close();
			} catch {
				/* close is best-effort — if it throws we still try to reopen. */
			}
		}
		await openOverlay();
	};

	/** Take the inspector off screen for the duration of `work`, then restore it. */
	const withOverlayHidden = async <T>(work: () => Promise<T>): Promise<T> => {
		// Hide, not close, for the same reason the focus-loss guard does:
		// resolving the promise makes the host pop whatever is topmost, which
		// need not be this overlay (review finding CR-OVERLAY-CLOSE-TOPMOST).
		// Hiding names this entry, and restoring keeps the operator's scroll
		// position and selection across a prompt they did not ask for.
		const instance = mountedInstance;
		const wasVisible = isOpen && instance !== null && !instance.isHidden();
		if (wasVisible) instance.hideForHost();
		try {
			return await work();
		} finally {
			// `finally`, so a rejected or cancelled prompt still gives the
			// inspector back.
			if (wasVisible && !disposed && mountedInstance === instance) {
				try {
					instance.restore();
				} catch {
					/* restore is best-effort; never fail the caller's result. */
				}
			}
		}
	};

	// Shortcuts: Option-O (`alt+o`) is the historical/easy overlay toggle and
	// remains registered as a convenience alias. `overlayShortcut` controls the
	// additional fallback chord, defaulting to `ctrl+alt+d` (d = delegate) for
	// terminals where Option is not configured as Meta. Empty string disables
	// both shortcuts; `/delegate-inspector` remains the universal fallback.
	const resolvedShortcut = opts?.shortcut !== undefined
		? opts.shortcut
		: config.overlayShortcut ?? DEFAULT_OVERLAY_SHORTCUT;
	if (resolvedShortcut.length > 0) {
		const shortcuts = [OPTION_O_OVERLAY_SHORTCUT, resolvedShortcut].filter(
			(shortcut, index, arr) => arr.indexOf(shortcut) === index,
		);
		for (const shortcut of shortcuts) {
			try {
				pi.registerShortcut(shortcut as any, {
					description:
						shortcut === OPTION_O_OVERLAY_SHORTCUT
							? "Toggle delegate transcript overlay"
							: "Open delegate transcript overlay",
					handler: () => {
						if (shortcut === OPTION_O_OVERLAY_SHORTCUT && mountedInstance) {
							// Toggle, but a hidden overlay toggles back ON.
							// Option-O is how the operator is told to recover
							// after a prompt hid the inspector, so closing it
							// here would answer "bring it back" with "no".
							if (mountedInstance.isHidden()) mountedInstance.restore();
							else mountedInstance.close();
							return;
						}
						void openOverlay();
					},
				});
			} catch (err) {
				// Unknown/malformed key — log but don't abort extension load.
				ctx.ui.notify(
					`delegate: could not register overlay shortcut ${JSON.stringify(shortcut)}: ${(err as Error).message ?? err}. Use /delegate-inspector instead.`,
					"warning",
				);
			}
		}
	}


	// ── Cancel shortcuts ─────────────────────────────────────────────────
	// Primary arms the confirm dialog when the focused entry is past the cost
	// or runtime threshold in config; below the threshold it cancels straight
	// away. Bypass skips the confirm entirely. When the overlay is already
	// mounted we delegate to its `handleCancelShortcut` so the in-overlay
	// y/N banner is reused; when it isn't, we fall back to `ctx.ui.confirm`
	// (real pi ExtensionUIContext exposes it) and a direct `run.cancel`.
	const cancelShortcut = opts?.cancelShortcut ?? config.cancelForkShortcut ?? DEFAULT_CANCEL_FORK_SHORTCUT;
	const bypassShortcut =
		opts?.cancelBypassShortcut ?? config.cancelForkBypassShortcut ?? DEFAULT_CANCEL_FORK_BYPASS_SHORTCUT;
	const costThreshold = config.cancelConfirmCostUsd ?? DEFAULT_CANCEL_CONFIRM_COST_USD;
	const runtimeThreshold = config.cancelConfirmRuntimeMs ?? DEFAULT_CANCEL_CONFIRM_RUNTIME_MS;

	const triggerCancel = async (bypass: boolean) => {
		if (disposed) return;
		if (mountedInstance) {
			try {
				await mountedInstance.handleCancelShortcut(bypass, {
					costThresholdUsd: costThreshold,
					runtimeThresholdMs: runtimeThreshold,
				});
			} catch (err) {
				ctx.ui.notify(
					`delegate: cancel shortcut failed: ${(err as Error).message ?? err}`,
					"error",
				);
			}
			return;
		}
		const target = pickGlobalCancelTarget();
		if (!target) {
			ctx.ui.notify("delegate: no running worker to cancel.", "info");
			return;
		}
		const { run, entry } = target;
		if (!bypass) {
			const runtimeMs = entry.startedAtMs ? Date.now() - entry.startedAtMs : 0;
			const cost = entry.cost ?? 0;
			const overCost = costThreshold > 0 && cost >= costThreshold;
			const overRuntime = runtimeThreshold > 0 && runtimeMs >= runtimeThreshold;
			if (overCost || overRuntime) {
				const { title, description } = buildCancelConfirmPrompt(entry, Date.now(), run.shape);
				let ok: boolean;
				if (typeof ctx.ui.confirm === "function") {
					try {
						ok = await ctx.ui.confirm(title, description);
					} catch {
						ok = false;
					}
				} else {
					// No confirm primitive available — refuse to cancel an
					// expensive worker silently. Prompt the user to open the
					// overlay and use the `x` flow.
					ctx.ui.notify(
						`delegate: ${entry.name} exceeds confirm threshold; open overlay (${DEFAULT_OVERLAY_SHORTCUT}) to cancel.`,
						"warning",
					);
					return;
				}
				if (!ok) return;
			}
		}
		try {
			if (!hasLocalRunAuthority(run)) return;
			await run.cancel?.(entry.name, "user" as CancelReason);
			ctx.ui.notify(`delegate: cancelling ${entry.name}.`, "info");
		} catch (err) {
			ctx.ui.notify(
				`delegate: cancel failed: ${(err as Error).message ?? err}`,
				"error",
			);
		}
	};

	if (cancelShortcut && cancelShortcut.length > 0) {
		try {
			pi.registerShortcut(cancelShortcut as any, {
				description: "Cancel focused delegate work (with confirm guard)",
				handler: () => {
					void triggerCancel(false);
				},
			});
		} catch (err) {
			ctx.ui.notify(
				`delegate: could not register cancel shortcut ${JSON.stringify(cancelShortcut)}: ${(err as Error).message ?? err}.`,
				"warning",
			);
		}
	}
	if (bypassShortcut && bypassShortcut.length > 0 && bypassShortcut !== cancelShortcut) {
		try {
			pi.registerShortcut(bypassShortcut as any, {
				description: "Cancel focused delegate work (no confirm)",
				handler: () => {
					void triggerCancel(true);
				},
			});
		} catch (err) {
			ctx.ui.notify(
				`delegate: could not register bypass cancel shortcut ${JSON.stringify(bypassShortcut)}: ${(err as Error).message ?? err}.`,
				"warning",
			);
		}
	}

	return {
		open: reopenOverlay,
		withOverlayHidden,
		dispose() {
			disposed = true;
			try {
				// Removes the stack entry by identity and disposes the
				// component. The `ui.custom` promise is left pending — nothing
				// resolves it — so the host is never asked to pop a tail that
				// may not be ours.
				mountedInstance?.close();
			} catch {
				/* unmount is best-effort during session teardown */
			}
			mountedInstance = null;
			isOpen = false;
		},
	};
}
