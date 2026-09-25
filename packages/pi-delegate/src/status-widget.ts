/**
 * Below-editor widget for delegate dispatched runs.
 *
 * One status line plus an optional indented summary line per active entry:
 *   ◆ <entryName>(<agent>) · <activity> · running <elapsed> · r/R · <tokenTotal>/$<cost>
 *      <liveHeadline>
 *
 * Modelled on pi-interactive-shell/background-widget.ts. The widget is
 * self-refreshing (10s elapsed-time tick) and invalidates on
 * `delegate:update` / `delegate:register` / `luthen.delegate.complete` / headline
 * events. Terminal runs remain a render-only projection for fixed status-specific
 * windows, then an expiry timeout requests one final render. When no visible
 * rows remain, a current-session outcome summary may still be rendered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getActivityHeadline, onActivityHeadlinesChanged } from "./activity-headlines.js";
import { boundActivityText, safeActivityToolName } from "./activity-status.js";
import { runEntryDisplayLabel, renderRunEntryIdentity } from "./fork-label.js";
import {
	formatFooterModeBadge,
	type FooterIconMode,
} from "./footer-presentation.js";
import { iconSet, isAsciiOnlyTerminal, resolveIconMode, type IconSet } from "./icons.js";
import { runIsFullyCompleted, sortRunsByDispatch } from "./overlay-list-model.js";
import type { DelegateDispatchState, InProcessRunShape, RunLiveState } from "./runtime.js";
import { summarizeRunActivity, type RunActivitySummary } from "./fork-digest.js";
import {
	compactActivityActorPhase,
	projectActivityActorPhase,
	type ActivityActor,
	type ActivityActorPhase,
	type ActivityPhase,
} from "./activity-state.js";
import { getActorActivity, onActorActivityChanged, type ActorActivity } from "./actor-activity.js";
import { countLiveRuns, isLiveStatus, isOwnedByThisProcess, listRuns, getPendingPromptActivity } from "./runtime.js";
import { effectiveAttempt, resolveFrontier, type ForkIdentity, type RetryForkRecord } from "./fork-predecessor.js";
import {
	addDelegateUsageTotals,
	cumulativeRetryUsage,
	emptyDelegateUsageTotals,
	formatRunUsageCompact,
	formatUsageTotalsCompact,
	runUsageTotals,
	type DelegateUsageTotals,
	type RetryUsageNode,
} from "./usage-rollup.js";

export {
	summarizeRunActivity,
	type RunActivitySummary,
	type RunActivitySummary as ForkActivitySummary,
} from "./fork-digest.js";
export { summarizeForkActivity } from "./fork-activity.js";

const WIDGET_KEY = "delegate-status";
const REFRESH_INTERVAL_MS = 10_000;
const TERMINAL_RETENTION_MS = {
	completed: 10_000,
	aborted: 30_000,
	failed: 300_000,
} as const;
const MAX_PREVIEW_CHARS = 60;
const MAX_PROJECTION_CACHE_ENTRIES = 10_000;
const SUMMARY_INDENT = "   ";

export interface StatusWidgetMountContext {
	hasUI?: boolean;
	ui?: { setWidget?: unknown };
}

/** Return whether the current context can mount the delegate status widget. */
export function canMountStatusWidget(ctx: StatusWidgetMountContext): boolean {
	return ctx.hasUI === true && typeof ctx.ui?.setWidget === "function";
}

export interface StatusWidgetClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(handle: unknown): void;
}

const systemClock: StatusWidgetClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface StatusWidgetSetupOptions {
	clock?: StatusWidgetClock;
	/** Stable foreground session identity used to project terminal history. */
	currentSessionId?: string;
	/** Optional Nerd Font mode badges; ASCII leaves the existing row layout unchanged. */
	footerIcons?: FooterIconMode;
}

/**
 * Responsive width breakpoints (terminal columns). The widget reflows so a
 * phone-over-SSH session still gets a legible at-a-glance line.
 *   ≥ WIDE   → full status line plus an indented summary line when available
 *   ≥ COMPACT→ compact per-entry status plus an indented headline when available
 *   < COMPACT→ one aggregate status; a sole entry may add its headline below
 */
const WIDTH_WIDE = 100;
const WIDTH_COMPACT = 56;
const MAX_RUN_ENTRY_LABEL_WIDTH = 48;
/**
 * Columns reserved for the entry label before metric chips start dropping, so a
 * row never degenerates into metrics beside a one-character name.
 */
const MIN_RUN_ENTRY_LABEL_WIDTH = 6;
/**
 * Tool names can be arbitrarily long (namespaced MCP tools especially). Bounding
 * the name keeps the activity chip — and therefore its trailing timer — a
 * predictable width, so it can sit ahead of the token/cost chip without
 * pushing it off the row.
 */
const MAX_TOOL_NAME_WIDTH = 16;

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const s = seconds % 60;
	if (minutes < 60) return `${minutes}m${s.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const m = minutes % 60;
	return `${hours}h${m.toString().padStart(2, "0")}m`;
}

/** Minimal theme contract the render helpers need. */
type ThemeLike = { fg: (role: string, text: string) => string };


function previewLine(s: string | undefined, width: number): string {
	if (!s) return "";
	const single = boundActivityText(s);
	if (!single) return "";
	if (visibleWidth(single) <= width) return single;
	return truncateToWidth(single, Math.max(1, width), "…");
}

/** A bounded, visibly nested summary row that never shares the status row. */
function renderSummaryLine(
	summary: string | undefined,
	cols: number,
	theme: ThemeLike,
	role = "dim",
): string | undefined {
	const budget = Math.min(MAX_PREVIEW_CHARS, cols - visibleWidth(SUMMARY_INDENT));
	if (budget <= 0) return undefined;
	const preview = previewLine(summary, budget);
	return preview ? `${SUMMARY_INDENT}${theme.fg(role, preview)}` : undefined;
}

/**
 * `☑3/7`, warning-marked when anything is blocked.
 *
 * Deliberately identical to `formatTaskChip` in `overlay-list-render.ts` and
 * `formatPlanCount` in `overlay-plan-block.ts`. The ASCII tier spells the word
 * rather than drawing a marker, so it needs a separator the glyph tiers do not.
 */
function formatTaskProgressCount(
	progress: RunLiveState["taskProgress"],
	marks: StatusGlyphs,
): string | undefined {
	if (progress === undefined || progress.total === 0) return undefined;
	const count = `${marks.tasks}${marks.mode === "ascii" ? " " : ""}${progress.done}/${progress.total}`;
	if (progress.blocked === 0) return count;
	return `${count} ${marks.warning}${progress.blocked}`;
}

/** Render the bounded task aggregate in the detail-row slot already owned by its entry. */
function renderTaskSummaryLine(
	progress: RunLiveState["taskProgress"],
	cols: number,
	theme: ThemeLike,
	marks: StatusGlyphs,
): string | undefined {
	if (progress === undefined || progress.total === 0) return undefined;
	const ascii = marks.mode === "ascii";
	const count = `${marks.tasks} ${progress.done}/${progress.total}`;
	const active = progress.active === null ? "" : boundActivityText(progress.active);
	const state = progress.blocked > 0
		? `${marks.warning} ${progress.blocked} blocked`
		: active
			? `${marks.taskActive} ${active}`
			: "";
	const summary = state ? `${count}${ascii ? " | " : " · "}${state}` : count;
	return renderSummaryLine(summary, cols, theme, progress.blocked > 0 ? "warning" : "dim");
}

function withSummaryLine(statusLine: string, summaryLine: string | undefined): string[] {
	return summaryLine ? [statusLine, summaryLine] : [statusLine];
}

function boundedToolName(value: string | undefined): string {
	const safe = safeActivityToolName(value);
	return safe ? truncateToWidth(safe, MAX_TOOL_NAME_WIDTH, "…") : "tool";
}

function truncateRunEntryLabel(label: string, width: number): string {
	const budget = Math.max(1, Math.min(MAX_RUN_ENTRY_LABEL_WIDTH, width));
	return visibleWidth(label) <= budget ? label : truncateToWidth(label, budget, "…");
}

/** Render-only facts may include user guidance without entering actor storage. */
type DisplayActivity = Omit<ActorActivity, "actor" | "phase"> & {
	actor: ActivityActor;
	phase: ActivityPhase;
};

/**
 * The widget's lifecycle glyphs, which are now a subset of the shared
 * vocabulary in `icons.ts` rather than a second table saying the same thing.
 *
 * The alias is kept because it names what these call sites use it for, and
 * because every one of them passes it positionally.
 */
type StatusGlyphs = IconSet;

/**
 * Resolve the widget's vocabulary from the configured mode.
 *
 * Before this, the widget read only `isAsciiOnlyTerminal()`, so a Nerd Font
 * user got Nerd Font mode badges beside Unicode status glyphs. One setting
 * drives both now, and since `footerIcons` defaults to `"nerd-font"` in
 * config, that is what a configured project actually renders.
 *
 * The `"unicode"` fallback is for a host that never wired config at all, which
 * is why this does not call `resolveFooterIconMode`: these glyphs have drawn
 * `◆ ✓ ✗ ⏸ ⊘` since before the setting existed, and an unwired caller should
 * keep them rather than drop to ASCII.
 */
function statusGlyphVocabulary(configured?: FooterIconMode): StatusGlyphs {
	return iconSet(resolveIconMode(configured, process.env, "unicode"));
}

/** Status glyph, tinted by run-entry lifecycle state. */
function statusGlyph(theme: ThemeLike, status: RunLiveState["status"], glyphs: StatusGlyphs): string {
	switch (status) {
		case "running":
		case "awaiting-escalation":
		case "pending":
		case "constructing":
			return theme.fg("accent", glyphs.active);
		case "completed":
			return theme.fg("success", glyphs.completed);
		// Spec 0019 / REQ-PAUSE-4 — a paused run entry is parked mid-work, NEVER a
		// silent green ✓; it gets a distinct pause glyph.
		case "paused":
			return theme.fg("warning", glyphs.paused);
		case "failed":
			return theme.fg("error", glyphs.failed);
		default:
			return theme.fg("warning", glyphs.aborted);
	}
}

/** Age of the most recent activity (or elapsed since start as a fallback). */
function ageStr(
	activity: RunActivitySummary,
	entry: RunLiveState,
	createdAt: number,
	now: number,
): string {
	const base = activity.lastEventAt ?? entry.startedAt ?? createdAt;
	return formatDuration(Math.max(0, now - base));
}

/** Total wall-clock time since this run entry started, independent of phase changes. */
function runningElapsedStr(entry: RunLiveState, createdAt: number, now: number): string {
	const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
		? entry.startedAt
		: createdAt;
	return formatDuration(Math.max(0, now - startedAt));
}

/** Frozen start-to-end wall-clock time for a terminal entry, when both timestamps are usable. */
function terminalRuntimeStr(entry: RunLiveState, createdAt: number): string | undefined {
	const startedAt = [entry.startedAtMs, entry.startedAt, createdAt].find(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	if (startedAt === undefined || typeof entry.endedAt !== "number" || !Number.isFinite(entry.endedAt)) {
		return undefined;
	}
	return formatDuration(Math.max(0, entry.endedAt - startedAt));
}

function actorActivityRole(activity: DisplayActivity): string {
	switch (activity.phase) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
		case "paused":
			return "warning";
		case "waiting-model":
		case "waiting-worker":
		case "waiting-supervisor":
			return "dim";
		case "awaiting-prompt":
		case "awaiting-escalation":
		case "cancelling-worker":
			return "warning";
		default:
			return "accent";
	}
}

function actorActivityDescription(
	activity: DisplayActivity,
	now: number,
	compact: boolean,
): string {
	if (activity.message) return boundActivityText(activity.message);
	let description: string;
	switch (activity.phase) {
		case "waiting-worker": description = "waiting for W"; break;
		case "waiting-supervisor": description = "waiting for S"; break;
		case "waiting-model": description = "waiting"; break;
		case "using-tool": {
			const tool = boundedToolName(activity.toolName);
			description = `using ${tool}${compact ? "" : ` ${formatDuration(Math.max(0, now - activity.startedAt))}`}`;
			if ((activity.activeToolCount ?? 0) > 1) description += ` ×${activity.activeToolCount}`;
			break;
		}
		case "writing": description = "writing"; break;
		case "thinking": description = "thinking"; break;
		case "reviewing-worker": description = "reviewing"; break;
		case "awaiting-prompt": description = `awaiting ${activity.promptKind ?? "prompt"}`; break;
		case "awaiting-escalation": description = "awaiting escalation"; break;
		case "guidance": description = "guidance queued"; break;
		default: description = activity.phase.replaceAll("-", " ");
	}
	return description;
}

function actorActivityLabel(
	activity: DisplayActivity,
	now: number,
	theme: ThemeLike,
	compact = false,
): string {
	const prefix = activity.actor === "supervisor"
		? "S"
		: activity.actor === "worker"
			? "W"
			: activity.actor === "user"
				? "U"
				: "F";
	return theme.fg(
		actorActivityRole(activity),
		`${prefix} ${actorActivityDescription(activity, now, compact)}`,
	);
}

function displayedActorActivities(
	runId: string,
	entry: RunLiveState,
	now: number,
	shape: InProcessRunShape | undefined,
): DisplayActivity[] {
	if (
		entry.status === "completed" ||
		entry.status === "failed" ||
		entry.status === "aborted" ||
		entry.status === "paused"
	) {
		// Runtime owns only the run-entry terminal outcome. Do not invent which
		// actor completed, failed, aborted, or paused.
		return [];
	}
	const current = getActorActivity(runId, entry.name);
	const values: DisplayActivity[] = [current?.supervisor, current?.worker].filter((value): value is ActorActivity => value !== undefined);
	if (entry.status === "pending" || entry.status === "constructing") {
		const timestamp = entry.startedAt ?? entry.lastActivityAt ?? now;
		const addStarting = (actor: ActorActivity["actor"]): void => {
			if (values.some((value) => value.actor === actor)) return;
			values.push({ actor, phase: "starting", startedAt: timestamp, updatedAt: timestamp });
		};
		if (shape === "supervised") addStarting("supervisor");
		addStarting("worker");
	}
	const pending = getPendingPromptActivity(runId, entry.name);
	if (pending.first) {
		const prompt = pending.first;
		const worker: DisplayActivity = { actor: "worker", phase: "awaiting-prompt", promptKind: prompt.kind, startedAt: prompt.createdAt, updatedAt: prompt.createdAt };
		const index = values.findIndex((value) => value.actor === "worker");
		if (index >= 0) values[index] = worker; else values.push(worker);
	}
	if ((entry.pendingGuidance?.length ?? 0) > 0 && entry.status !== "awaiting-escalation") {
		const timestamp = entry.lastActivityAt ?? entry.startedAt ?? now;
		values.push({
			actor: "user",
			phase: "guidance",
			startedAt: timestamp,
			updatedAt: timestamp,
		});
	}
	if (entry.status === "awaiting-escalation") {
		const worker: DisplayActivity = { actor: "worker", phase: "awaiting-escalation", startedAt: entry.lastActivityAt ?? entry.startedAt ?? now, updatedAt: now };
		const index = values.findIndex((value) => value.actor === "worker");
		if (index >= 0) values[index] = worker; else values.push(worker);
	}
	// A supervised fork spends most of its lifetime with the supervisor parked
	// in wait_for_worker. That is plumbing, not useful foreground activity, and
	// the worker's concrete phase already proves the relationship. Likewise, a
	// worker waiting for its supervisor is redundant while any concrete phase is
	// visible. Suppress those passive counterpart states before fitting so they
	// cannot crowd out usage or the activity headline.
	let displayValues = values.filter((value) =>
		!(value.actor === "supervisor" && value.phase === "waiting-worker"),
	);
	const hasConcretePhase = displayValues.some((value) =>
		!(value.actor === "worker" && value.phase === "waiting-supervisor"),
	);
	if (hasConcretePhase) {
		displayValues = displayValues.filter((value) =>
			!(value.actor === "worker" && value.phase === "waiting-supervisor"),
		);
	}

	const actorOrder: Record<ActivityActor, number> = {
		supervisor: 0,
		worker: 1,
		user: 2,
	};
	return displayValues.sort((left, right) => actorOrder[left.actor] - actorOrder[right.actor]);
}

function currentActorPhase(
	actorActivities: readonly DisplayActivity[],
	fallback: ActivityActorPhase,
): ActivityActorPhase {
	const current = [...actorActivities].sort((left, right) => right.updatedAt - left.updatedAt)[0];
	return current
		? { actor: current.actor, phase: current.phase, label: `${current.actor} · ${current.phase.replaceAll("-", " ")}` }
		: fallback;
}

/**
 * The activity chip: an in-flight tool (`⚙ bash 25s`), an idle-but-worked
 * entry (`✓ idle 4s`), a terminal status plus frozen runtime, or bare activity
 * age. Legacy terminal entries without usable start/end timestamps omit runtime.
 */
function runEntryStatusChip(
	theme: ThemeLike,
	entry: RunLiveState,
	activity: RunActivitySummary,
	timing: string,
	glyphs: StatusGlyphs,
	phaseLabel?: string,
): string {
	const terminalTiming = timing ? ` ${timing}` : "";
	if (entry.status === "completed") return theme.fg("success", `done${terminalTiming}`);
	if (entry.status === "failed") return theme.fg("error", `failed${terminalTiming}`);
	if (entry.status === "aborted") return theme.fg("warning", `aborted${terminalTiming}`);
	if (entry.status === "paused") return theme.fg("warning", `paused${terminalTiming}`);
	if (entry.status === "awaiting-escalation") return theme.fg("warning", `awaiting escalation ${timing}`);
	if (activity.toolActive) {
		const tool = activity.lastToolName && activity.lastToolActive !== false
			? boundedToolName(activity.lastToolName)
			: `${activity.activeToolCount} active tool${activity.activeToolCount === 1 ? "" : "s"}`;
		return theme.fg("warning", `${phaseLabel ? `${phaseLabel} ` : ""}${glyphs.tool} ${tool} ${timing}`);
	}
	if (activity.lastToolName) {
		return theme.fg("success", `${phaseLabel ? `${phaseLabel} ` : ""}${glyphs.idle} idle ${timing}`);
	}
	return theme.fg("dim", phaseLabel ? `${phaseLabel} ${timing}` : timing);
}

/**
 * Trailing metric chip sets in display order, richest first.
 *
 * Display order is rounds · activity · token/cost · messages: the activity chip
 * carries the age timer, and how long an entry has been working or sitting idle
 * reads before what it has spent.
 *
 * Narrow rows drop whole chips from this list rather than cutting the token/cost
 * chip mid-value — messages first, then the activity chip, then rounds (spec
 * 0032: "Drop rounds, message count, and tool age first").
 *
 * Retry attempt context (issue #159) is the FIRST thing dropped. It says which
 * attempt of a lane this row is, which is useful when it fits and never worth a
 * column that the token/cost chip needs.
 */
function metricChipSets(rounds: string, chip: string, usage: string, msgs: string, tasks = "", retry = ""): string[][] {
	const ordered = usage
		? [
				[retry, tasks, rounds, chip, usage, msgs],
				[tasks, rounds, chip, usage, msgs],
				[tasks, rounds, chip, usage],
				[tasks, rounds, usage],
				[tasks, usage],
				[usage],
			]
		: [[retry, tasks, rounds, chip, msgs], [tasks, rounds, chip, msgs], [tasks, rounds, chip], [tasks, chip], [chip]];
	const seen = new Set<string>();
	const sets: string[][] = [];
	for (const set of ordered) {
		const kept = set.filter(Boolean);
		const key = kept.join("\u0000");
		if (seen.has(key)) continue;
		seen.add(key);
		sets.push(kept);
	}
	return sets.length > 0 ? sets : [[]];
}

/** Actor labels and total running time outrank rounds, usage, messages, and headlines. */
function actorMetricChipSets(
	actorChip: string,
	recentActor: string,
	runningElapsed: string,
	rounds: string,
	usage: string,
	msgs: string,
	tasks = "",
	retry = "",
): string[][] {
	return [
		[actorChip, retry, tasks, runningElapsed, rounds, usage, msgs].filter(Boolean),
		[actorChip, tasks, runningElapsed, rounds, usage, msgs].filter(Boolean),
		[actorChip, tasks, runningElapsed, usage].filter(Boolean),
		[actorChip, tasks, usage].filter(Boolean),
		[actorChip, tasks].filter(Boolean),
		[actorChip].filter(Boolean),
		[recentActor].filter(Boolean),
	];
}

/** Widest metric set that fits `budget` columns; the last set is the floor. */
function fitMetricChips(sets: string[][], budget: number): string {
	for (const set of sets) {
		const joined = set.join(" · ");
		if (visibleWidth(joined) <= budget) return joined;
	}
	return sets[sets.length - 1].join(" · ");
}

/**
 * Fit task counts beside usage without ever truncating the higher-priority usage
 * chip. Retry attempt context rides at the front and drops first, matching the
 * ladder in `metricChipSets` so a row's attempt marker obeys one rule wherever
 * it is drawn.
 */
function fitTaskAndUsage(task: string, usage: string, budget: number, retry = ""): string {
	const candidates = [
		[retry, task, usage],
		[task, usage],
		[usage],
		[task],
		[],
	];
	for (const candidate of candidates) {
		const joined = candidate.filter(Boolean).join(" · ");
		if (visibleWidth(joined) <= budget) return joined;
	}
	return "";
}

/** Build one entry's width-safe status row and optional indented summary row. */
function renderRunEntryLine(
	entry: RunLiveState,
	runId: string,
	createdAt: number,
	now: number,
	theme: ThemeLike,
	cols: number,
	tier: "wide" | "compact",
	shape: InProcessRunShape | undefined,
	detached: boolean | undefined,
	footerIcons: FooterIconMode | undefined,
	glyphs: StatusGlyphs,
	/** This entry's run finished cleanly, so its label recedes. */
	completed: boolean,
	/**
	 * Set when this row heads a retry lane: the attempt number for context, and
	 * the lane's cumulative spend so retiring the predecessors' rows does not
	 * retire what they cost.
	 */
	retry: { attempt: number; usage: DelegateUsageTotals } | undefined,
): string[] {
	const activity = summarizeRunActivity(entry.transcript);
	const glyph = statusGlyph(theme, entry.status, glyphs);
	// A run that finished cleanly recedes to dim. The glyph keeps its own
	// colour, so a grey row still says whether the work went well.
	const labelTone = (value: string) => (completed ? theme.fg("dim", value) : value);
	const modeBadge = formatFooterModeBadge({ shape, detached }, footerIcons);
	const themedModeBadge = modeBadge ? theme.fg("dim", modeBadge) : "";
	const prefix = ` ${glyph} ${themedModeBadge ? `${themedModeBadge} · ` : ""}`;
	const rounds = theme.fg("dim", `${entry.currentRound}/${entry.maxRounds}`);
	const timing = isLiveStatus(entry.status)
		? ageStr(activity, entry, createdAt, now)
		: terminalRuntimeStr(entry, createdAt) ?? "";
	const runningElapsed = isLiveStatus(entry.status)
		? theme.fg("dim", `running ${runningElapsedStr(entry, createdAt, now)}`)
		: "";
	const actorPhase = projectActivityActorPhase({
		status: entry.status,
		activity,
		pendingPromptCount: getPendingPromptActivity(runId, entry.name).count,
		pendingGuidanceCount: entry.pendingGuidance?.length ?? 0,
	});
	const actorActivities = displayedActorActivities(runId, entry, now, shape);
	const displayedActorPhase = currentActorPhase(actorActivities, actorPhase);
	const actorLines = actorActivities.map((value) => actorActivityLabel(value, now, theme));
	const compactActorLines = actorActivities.map((value) => actorActivityLabel(value, now, theme, true));
	const recentActivity = [...actorActivities].sort((left, right) => right.updatedAt - left.updatedAt)[0];
	const recentActorLine = recentActivity ? actorActivityLabel(recentActivity, now, theme) : "";
	const recentCompactActorLine = recentActivity ? actorActivityLabel(recentActivity, now, theme, true) : "";
	const compactPhase = compactActivityActorPhase(displayedActorPhase);
	const chip = actorLines.length > 0
		? actorLines.join(" · ")
		: runEntryStatusChip(
				theme,
				entry,
				activity,
				timing,
				glyphs,
				tier === "compact" && (!activity.lastToolName || visibleWidth(activity.lastToolName) <= MAX_TOOL_NAME_WIDTH) ? compactPhase : undefined,
			);
	const msgs = activity.messageCount > 0 ? `${activity.messageCount}msg` : "";
	// Issue #226 — checklist progress inside the existing row, no new chrome.
	// Ranked with usage rather than with the droppable chips: "how much of the
	// plan is done" is the reason a supervisor looks at this row at all, and a
	// blocked count is the one thing that needs a person.
	const taskChip = tier === "compact" ? formatTaskProgressCount(entry.taskProgress, glyphs) : undefined;
	const themedTasks = taskChip
		? theme.fg(entry.taskProgress && entry.taskProgress.blocked > 0 ? "warning" : "dim", taskChip)
		: "";
	// A retry lane row reports cumulative lane spend; ordinary rows report their
	// own usage. This display projection never mutates stored totals.
	const usage = retry ? formatUsageTotalsCompact(retry.usage) : formatRunUsageCompact(entry.usage);
	const themedUsage = usage ? theme.fg("dim", usage) : "";
	const retryText = retry ? formatRetryAttempt(retry.attempt, tier) : "";
	const themedRetry = retryText ? theme.fg("dim", retryText) : "";
	const themedMsgs = msgs ? theme.fg("dim", msgs) : "";
	const liveHeadline = getActivityHeadline(runId, entry.name)?.text;

	if (tier === "compact") {
		// When the ticker has a current headline, compact rows prioritize the entry
		// name and complete usage chip on the status row, then give the headline its
		// own row. Terminal rows also retain their status-and-runtime chip; live rows
		// keep their existing headline projection. Older metric chips remain only
		// when no headline is available.
		if (liveHeadline && actorLines.length === 0) {
			const metricsBudget = cols - visibleWidth(prefix) - MIN_RUN_ENTRY_LABEL_WIDTH;
			const metrics = isLiveStatus(entry.status)
				? fitTaskAndUsage(themedTasks, themedUsage, metricsBudget, themedRetry)
				: fitMetricChips(
					[
						[themedRetry, themedTasks, chip, themedUsage].filter(Boolean),
						[themedTasks, chip, themedUsage].filter(Boolean),
						[chip, themedUsage].filter(Boolean),
						[chip].filter(Boolean),
					],
					metricsBudget,
				);
			const metricsPart = metrics ? ` ${metrics}` : "";
			const labelBudget = cols - visibleWidth(prefix + metricsPart);
			const label = truncateRunEntryLabel(runEntryDisplayLabel(entry), labelBudget);
			const line = `${prefix}${labelTone(label)}${metricsPart}`;
			const statusLine = visibleWidth(line) <= cols ? line : truncateToWidth(line, cols, "…");
			const summaryLine = renderSummaryLine(liveHeadline, cols, theme);
			return withSummaryLine(statusLine, summaryLine);
		}

		// The activity chip (and its timer) reads before the token/cost chip. When
		// the row is too narrow, whole chips are dropped in reverse priority order
		// so the complete token/cost value survives.
		const suffix = fitMetricChips(
			actorLines.length > 0
				? actorMetricChipSets(
					compactActorLines.join(" · "),
					recentCompactActorLine,
					runningElapsed,
					rounds,
					themedUsage,
					themedMsgs,
					themedTasks,
					themedRetry,
				)
				: metricChipSets(rounds, chip, themedUsage, themedMsgs, themedTasks, themedRetry),
			cols - visibleWidth(prefix) - 1 - MIN_RUN_ENTRY_LABEL_WIDTH,
		);
		const labelBudget = cols - visibleWidth(`${prefix} ${suffix}`);
		const label = truncateRunEntryLabel(runEntryDisplayLabel(entry), labelBudget);
		const line = `${prefix}${labelTone(label)} ${suffix}`;
		return [visibleWidth(line) <= cols ? line : truncateToWidth(line, cols, "…")];
	}

	// Wide tier: prioritize the human-readable agent identity and latest update.
	// Internal run ids remain available in the transcript overlay and
	// `delegate_control` action `status`; repeating them on every row crowds out useful activity.
	const rawLabel = renderRunEntryIdentity(entry);
	const previewSource = isLiveStatus(entry.status)
		? liveHeadline ?? entry.lastWorkerText
		: entry.lastWorkerText ?? liveHeadline;
	const summarySource = actorLines.length > 0
		? previewSource
		: `${previewSource ? `${previewSource} · ` : ""}${displayedActorPhase.label}`;
	const summaryLine = renderTaskSummaryLine(entry.taskProgress, cols, theme, glyphs)
		?? renderSummaryLine(summarySource, cols, theme);
	const suffixWithMetrics = `  ${fitMetricChips(
		actorLines.length > 0
			? actorMetricChipSets(chip, recentActorLine, runningElapsed, rounds, themedUsage, themedMsgs, themedTasks, themedRetry)
			: metricChipSets(rounds, chip, themedUsage, themedMsgs, themedTasks, themedRetry),
		cols - visibleWidth(prefix) - 2 - MIN_RUN_ENTRY_LABEL_WIDTH,
	)}`;
	const label = truncateRunEntryLabel(rawLabel, cols - visibleWidth(prefix + suffixWithMetrics));
	const withMetrics = `${prefix}${labelTone(label)}${suffixWithMetrics}`;
	if (visibleWidth(withMetrics) <= cols) return withSummaryLine(withMetrics, summaryLine);

	// The label budget bottoms out at one column. If even that plus the suffix
	// exceeds the terminal, truncate only the tail; by then `fitMetricChips` has
	// already reduced the suffix to the token/cost chip it must preserve.
	const statusLine = truncateToWidth(withMetrics, cols, "…");
	return withSummaryLine(statusLine, summaryLine);
}

/** Narrow tier: collapse all entries to a single aggregate line. */
function aggregateLine(
	pairs: Array<{
		runId: string;
		createdAt: number;
		shape: InProcessRunShape | undefined;
		entry: RunLiveState;
		retry?: { attempt: number; usage: DelegateUsageTotals } | undefined;
	}>,
	now: number,
	theme: ThemeLike,
	cols: number,
	glyphs: StatusGlyphs,
): string {
	const running = countLiveRuns(pairs.map((p) => p.entry));
	let usage = emptyDelegateUsageTotals();
	for (const pair of pairs) {
		// Predecessors of a collapsed retry lane have no row here to carry their
		// spend, so the surviving row carries the lane total instead.
		usage = addDelegateUsageTotals(usage, pair.retry ? pair.retry.usage : runUsageTotals(pair.entry.usage));
	}
	const usageText = formatUsageTotalsCompact(usage);
	const themedUsage = usageText ? theme.fg("dim", usageText) : "";
	const soleProgress = pairs.length === 1 ? pairs[0]?.entry.taskProgress : undefined;
	const taskText = formatTaskProgressCount(soleProgress, glyphs);
	const themedTasks = taskText
		? theme.fg(soleProgress && soleProgress.blocked > 0 ? "warning" : "dim", taskText)
		: "";
	if (running === 0) {
		const terminalPriority: Partial<Record<RunLiveState["status"], number>> = {
			failed: 4,
			aborted: 3,
			paused: 2,
			completed: 1,
		};
		const representative = pairs.reduce((best, pair) =>
			(terminalPriority[pair.entry.status] ?? 0) > (terminalPriority[best.entry.status] ?? 0)
				? pair
				: best,
		);
		const status = representative.entry.status;
		const count = `${statusGlyph(theme, status, glyphs)}${pairs.length}`;
		const runtime = pairs.length === 1
			? terminalRuntimeStr(representative.entry, representative.createdAt)
			: undefined;
		const base = ` ${count} terminal · ${status}${runtime ? ` ${runtime}` : ""}`;
		const details = fitTaskAndUsage(themedTasks, themedUsage, cols - visibleWidth(`${base} · `));
		const line = details ? `${base} · ${details}` : base;
		return visibleWidth(line) <= cols ? line : truncateToWidth(line, cols, "…");
	}

	const phaseCounts = new Map<string, number>();
	const actorCandidates: Array<{ value: DisplayActivity; pair: (typeof pairs)[number] }> = [];
	let best: { activity: RunActivitySummary; pair: (typeof pairs)[number]; phase: ReturnType<typeof projectActivityActorPhase> } | undefined;
	for (const pair of pairs) {
		const activity = summarizeRunActivity(pair.entry.transcript);
		const phase = projectActivityActorPhase({
			status: pair.entry.status,
			activity,
			pendingPromptCount: getPendingPromptActivity(pair.runId, pair.entry.name).count,
			pendingGuidanceCount: pair.entry.pendingGuidance?.length ?? 0,
		});
		const displayedActivities = displayedActorActivities(pair.runId, pair.entry, now, pair.shape);
		for (const value of displayedActivities) actorCandidates.push({ value, pair });
		const displayedPhase = currentActorPhase(displayedActivities, phase);
		const key = compactActivityActorPhase(displayedPhase);
		if (isLiveStatus(pair.entry.status)) {
			phaseCounts.set(key, (phaseCounts.get(key) ?? 0) + 1);
			if (!best || (activity.lastEventAt ?? 0) > (best.activity.lastEventAt ?? 0)) {
				best = { activity, pair, phase: displayedPhase };
			}
		}
	}
	const count = theme.fg("accent", `${glyphs.active}${running}`);
	const eligibleActorCandidates = actorCandidates.filter(({ pair }) => isLiveStatus(pair.entry.status));
	if (eligibleActorCandidates.length > 0) {
		const phasePriority = (value: DisplayActivity): number => {
			switch (value.phase) {
				case "awaiting-prompt":
				case "awaiting-escalation": return 6;
				case "guidance": return 5;
				case "steering": return 4;
				default: return 0;
			}
		};
		const current = eligibleActorCandidates.sort((left, right) =>
			phasePriority(right.value) - phasePriority(left.value) ||
			right.value.updatedAt - left.value.updatedAt,
		)[0]!;
		const phase = actorActivityLabel(current.value, now, theme, true);
		const base = ` ${count} active · ${phase}`;
		const details = fitTaskAndUsage(themedTasks, themedUsage, cols - visibleWidth(`${base} · `));
		const line = details ? `${base} · ${details}` : base;
		return visibleWidth(line) <= cols ? line : truncateToWidth(line, cols, "…");
	}
	let chip = "";
	if (phaseCounts.size > 1) {
		chip = [...phaseCounts.entries()].map(([phase, phaseCount]) => `${phase}×${phaseCount}`).join(" ");
	} else if (best) {
		const age = ageStr(best.activity, best.pair.entry, best.pair.createdAt, now);
		const projectedPhase = compactActivityActorPhase(best.phase);
		const phaseLabel = best.activity.lastToolName
			? projectedPhase.slice(0, projectedPhase.indexOf(":"))
			: projectedPhase;
		chip = runEntryStatusChip(
			theme,
			best.pair.entry,
			best.activity,
			age,
			glyphs,
			phaseLabel,
		);
	}
	// Same order as the per-entry rows: actor/phase or activity first, usage after.
	const suffix = fitMetricChips(
		metricChipSets("", chip, themedUsage, "", themedTasks),
		cols - visibleWidth(` ${count} · `),
	);
	const fallbackCount = ` ${count}`;
	const line = suffix ? `${fallbackCount} · ${suffix}` : fallbackCount;
	return visibleWidth(line) <= cols ? line : truncateToWidth(line, cols, "…");
}

interface TerminalProjectionObservation {
	observedAt: number;
}

type TerminalProjectionCache = {
	version: 1;
	observations: Map<string, TerminalProjectionObservation>;
};

const TERMINAL_PROJECTION_CACHE_SLOT = Symbol.for("pi-delegate.status-widget.terminal-projection.v1");

type GlobalWithProjectionCache = typeof globalThis & {
	[TERMINAL_PROJECTION_CACHE_SLOT]?: TerminalProjectionCache;
};

/**
 * Acquire display-only observation state from a reload-stable process slot.
 * Pi can evaluate this module again with `moduleCache: false`; keeping the
 * actual map in globalThis preserves timestamp-less deadlines across that
 * replacement without exposing the cache to runtime or durable state.
 */
function terminalProjectionCache(): TerminalProjectionCache {
	const host = globalThis as GlobalWithProjectionCache;
	const existing = host[TERMINAL_PROJECTION_CACHE_SLOT];
	if (existing?.version === 1 && existing.observations instanceof Map) return existing;
	const created: TerminalProjectionCache = { version: 1, observations: new Map() };
	host[TERMINAL_PROJECTION_CACHE_SLOT] = created;
	return created;
}

/** Narrow reset seam for isolated tests; production code never calls this. */
export function __resetStatusWidgetProjectionCacheForTests(): void {
	const host = globalThis as GlobalWithProjectionCache;
	delete host[TERMINAL_PROJECTION_CACHE_SLOT];
}

function runEntryProjectionKey(
	sessionKey: string,
	run: DelegateDispatchState,
	recordKey: string,
	entry: RunLiveState,
): string {
	const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)
		? entry.startedAt
		: "-";
	const startedAtMs = typeof entry.startedAtMs === "number" && Number.isFinite(entry.startedAtMs)
		? entry.startedAtMs
		: "-";
	return [sessionKey, run.runId, run.createdAt, recordKey, entry.name, startedAt, startedAtMs].join("\u0000");
}

function trimProjectionCache(cache: TerminalProjectionCache): void {
	while (cache.observations.size > MAX_PROJECTION_CACHE_ENTRIES) {
		const oldest = cache.observations.keys().next().value;
		if (oldest === undefined) return;
		cache.observations.delete(oldest);
	}
}

function isTerminalStatus(status: RunLiveState["status"]): status is keyof typeof TERMINAL_RETENTION_MS {
	return status === "completed" || status === "aborted" || status === "failed";
}

/**
 * Issue #159 — one ambient row per retry lane.
 *
 * A `failed` or `aborted` fork is the lane's attention signal, so it keeps its
 * row until a DECLARED replacement exists. When `retryOf`/`retriedBy` resolve a
 * complete lane, only its frontier — the newest attempt — draws a row, and that
 * row reports the whole lane's spend.
 *
 * Every decision here fails OPEN. Quarantined, one-sided, cyclic, or
 * attempt-inconsistent metadata leaves `resolveFrontier` incomplete and hides
 * nothing: an extra row is a cosmetic defect, a vanished aborted lane is a lost
 * signal. Nothing in this file mutates a fork record, run history, or session
 * accounting — the lane total is computed per render and thrown away.
 */
interface RetryLaneProjection {
	/** Fork keys whose ambient row a declared replacement has taken over. */
	readonly suppressed: ReadonlySet<string>;
	/** Frontier rows that head a valid lane of more than one attempt. */
	readonly lanes: ReadonlyMap<string, { attempt: number; usage: DelegateUsageTotals }>;
}

function retryLaneKey(runId: string, forkName: string): string {
	return `${runId}\u0000${forkName}`;
}

/**
 * Resolve lanes across EVERY run, then decide visibility within this session.
 *
 * The two scopes are deliberately different. A predecessor may sit in a run
 * this session never dispatched, so lineage has to be validated against the
 * whole registry or a legitimate retry would read as malformed. Whether a row
 * disappears, though, is a question about this session's screen: a replacement
 * running in ANOTHER session must not silently retire the only aborted row this
 * operator can see.
 */
function projectRetryLanes(
	sessionRuns: readonly DelegateDispatchState[],
	allRuns: readonly DelegateDispatchState[],
): RetryLaneProjection {
	const suppressed = new Set<string>();
	const lanes = new Map<string, { attempt: number; usage: DelegateUsageTotals }>();
	const byRunId = new Map(allRuns.map((run) => [run.runId, run]));
	const forkAt = (runId: string, forkName: string): RunLiveState | undefined =>
		byRunId.get(runId)?.forks[forkName];
	const lookup = (runId: string, forkName: string): RetryForkRecord | undefined =>
		forkAt(runId, forkName);
	const usageLookup = (runId: string, forkName: string): RetryUsageNode | undefined => {
		const fork = forkAt(runId, forkName);
		return fork ? usageNode(runId, fork) : undefined;
	};

	// Membership is taken from the RAW session fork set, before terminal grace.
	// Deciding after retention would let a lane reopen: a `completed` retry
	// expires in 10s while the `failed` attempt it replaced is kept for 300s, so
	// the predecessor would return to the screen once its own replacement aged
	// out.
	//
	// Terminal grace is the ONLY visibility rule ignored here. A replacement that
	// the render loop will refuse outright must not retire its predecessor: a
	// live fork owned by another process is hydrated into this session's registry
	// under the same `ownerSessionId`, and the row gate below drops it. Counting
	// it as a frontier would suppress the predecessor and then render neither
	// attempt, leaving the lane invisible in the one session that needs it.
	const sessionForks = new Set<string>();
	for (const run of sessionRuns) {
		for (const fork of Object.values(run.forks)) {
			if (isLiveStatus(fork.status) && !isOwnedByThisProcess(run)) continue;
			sessionForks.add(retryLaneKey(run.runId, fork.name));
		}
	}

	for (const run of sessionRuns) {
		for (const fork of Object.values(run.forks)) {
			if (fork.retryOf === undefined && fork.retriedBy === undefined) continue;
			if (fork.retryQuarantined === true) continue;
			const identity: ForkIdentity = { runId: run.runId, forkName: fork.name };
			const key = retryLaneKey(identity.runId, identity.forkName);
			const frontier = resolveFrontier(lookup, identity);
			if (!frontier.complete) continue;
			const frontierKey = retryLaneKey(frontier.identity.runId, frontier.identity.forkName);
			if (frontierKey !== key) {
				if (sessionForks.has(frontierKey)) suppressed.add(key);
				continue;
			}
			if (fork.retryOf === undefined) continue;
			lanes.set(key, {
				attempt: effectiveAttempt(fork),
				usage: cumulativeRetryUsage(usageNode(identity.runId, fork), usageLookup).usage,
			});
		}
	}
	return { suppressed, lanes };
}

/** Adapt a live fork to the trusted node shape the usage roll-up walks. */
function usageNode(runId: string, fork: RunLiveState): RetryUsageNode {
	return {
		identity: { runId, forkName: fork.name },
		...(fork.attempt !== undefined ? { attempt: fork.attempt } : {}),
		...(fork.retryOf !== undefined ? { retryOf: fork.retryOf } : {}),
		...(fork.retriedBy !== undefined ? { retriedBy: fork.retriedBy } : {}),
		...(fork.usage !== undefined ? { usage: fork.usage } : {}),
	};
}

/** Width-ranked attempt context: the wide row spells it, the compact row marks it. */
function formatRetryAttempt(attempt: number, tier: "wide" | "compact"): string {
	if (!Number.isSafeInteger(attempt) || attempt < 2) return "";
	return tier === "wide" ? `attempt ${attempt}` : `#${attempt}`;
}


function renderOutcomeSummary(
	counts: { succeeded: number; failed: number; aborted: number },
	cols: number,
): string {
	const ascii = isAsciiOnlyTerminal();
	const separator = ascii ? " | " : " · ";
	const full = `delegate outcomes: succeeded ${counts.succeeded}${separator}failed ${counts.failed}${separator}aborted ${counts.aborted}`;
	const compact = `outcomes: succeeded ${counts.succeeded}${separator}failed ${counts.failed}${separator}aborted ${counts.aborted}`;
	const narrow = `S ${counts.succeeded}${separator}F ${counts.failed}${separator}A ${counts.aborted}`;
	const hint = " /delegate-inspector";
	const candidates = [
		`${full}${hint}`,
		full,
		compact,
		narrow,
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= cols) return candidate;
	}
	return truncateToWidth(narrow, Math.max(0, cols), "…");
}

export interface StatusWidgetHandle {
	dispose(): void;
	/** Forcibly re-render the widget (used by tests). */
	requestRender(): void;
}

/**
 * Attach the widget to `ctx.ui` and wire up events. Returns a handle whose
 * `dispose()` removes the widget and unsubscribes. Returns null when
 * `ctx.hasUI` is false (print/RPC modes) — matches the pi-interactive-shell
 * pattern.
 */
export function setupStatusWidget(
	pi: ExtensionAPI,
	ctx: {
		ui: {
			setWidget: (
				key: string,
				renderer: (tui: any, theme: any) => unknown,
				options?: unknown,
			) => void;
		};
		hasUI?: boolean;
	},
	opts: StatusWidgetSetupOptions = {},
): StatusWidgetHandle | null {
	if (!canMountStatusWidget(ctx)) return null;

	const clock = opts.clock ?? systemClock;
	const sessionKey = opts.currentSessionId ?? `pid:${process.pid}`;
	let tuiRef: { requestRender: () => void } | null = null;
	let refreshTimer: unknown = null;
	let terminalExpiryTimer: { expiresAt: number; generation: number; handle: unknown } | null = null;
	let terminalExpiryGeneration = 0;
	let disposed = false;

	const requestRender = () => {
		if (!disposed) tuiRef?.requestRender();
	};

	const clearTerminalExpiryTimer = (): void => {
		if (!terminalExpiryTimer) return;
		clock.clearTimeout(terminalExpiryTimer.handle);
		terminalExpiryTimer = null;
	};

	const scheduleTerminalExpiryRender = (expiresAt: number, now: number): void => {
		if (terminalExpiryTimer?.expiresAt === expiresAt) return;
		clearTerminalExpiryTimer();
		const generation = ++terminalExpiryGeneration;
		const timer: { expiresAt: number; generation: number; handle: unknown } = {
			expiresAt,
			generation,
			handle: undefined,
		};
		timer.handle = clock.setTimeout(() => {
			if (terminalExpiryTimer !== timer || timer.generation !== terminalExpiryGeneration) return;
			terminalExpiryTimer = null;
			requestRender();
		}, Math.max(0, expiresAt - now));
		terminalExpiryTimer = timer;
		(timer.handle as { unref?: () => void } | null)?.unref?.();
	};

	const sessionMatches = (run: DelegateDispatchState): boolean =>
		opts.currentSessionId === undefined
			? isOwnedByThisProcess(run)
			: run.ownerSessionId === opts.currentSessionId;

	const projectVisibleEntries = (now: number): {
		pairs: Array<{
			runId: string;
			createdAt: number;
			shape: InProcessRunShape | undefined;
			detached: boolean | undefined;
			/** Every entry in this run completed cleanly; the row recedes. */
			completed: boolean;
			entry: RunLiveState;
			/** Present when this row is the frontier of a multi-attempt retry lane. */
			retry: { attempt: number; usage: DelegateUsageTotals } | undefined;
		}>;
		expiredTerminal: boolean;
		outcomes: { succeeded: number; failed: number; aborted: number };
	} => {
		// Dispatch order, oldest first, matching the overlay's list. `listRuns`
		// returns `Map` insertion order, which usually reads as dispatch order
		// but is not: runs hydrated from an earlier session are inserted ahead
		// of this session's work whatever their age.
		const allRuns = listRuns();
		const sessionRuns = sortRunsByDispatch(allRuns.filter(sessionMatches));
		const retryLanes = projectRetryLanes(sessionRuns, allRuns);
		const cache = terminalProjectionCache();
		const seenKeys = new Set<string>();
		const visibleEntries: Array<{
			runId: string;
			createdAt: number;
			shape: InProcessRunShape | undefined;
			detached: boolean | undefined;
			completed: boolean;
			entry: RunLiveState;
			retry: { attempt: number; usage: DelegateUsageTotals } | undefined;
		}> = [];
		const outcomes = { succeeded: 0, failed: 0, aborted: 0 };
		let nearestExpiry: number | undefined;
		let expiredTerminal = false;

		for (const run of sessionRuns) {
			// Decided per run, not per entry: a completed entry sitting beside a
			// running one belongs to a run that is still working, and dimming
			// it would say the run had finished.
			const runCompleted = runIsFullyCompleted(run);
			for (const [recordKey, entry] of Object.entries(run.forks)) {
				const key = runEntryProjectionKey(sessionKey, run, recordKey, entry);
				seenKeys.add(key);
				if (entry.status === "completed") outcomes.succeeded += 1;
				else if (entry.status === "failed") outcomes.failed += 1;
				else if (entry.status === "aborted") outcomes.aborted += 1;

				// Issue #159 — a declared replacement takes over this lane's row.
				// The attempt is still counted above, still in run history, and
				// still reachable through `delegate_control`: only the ambient row
				// is retired, and only because a successor now speaks for it.
				const laneKey = retryLaneKey(run.runId, entry.name);
				if (retryLanes.suppressed.has(laneKey)) {
					cache.observations.delete(key);
					continue;
				}
				const retry = retryLanes.lanes.get(laneKey);

				// Process ownership gates live work only. Matching-session paused and
				// terminal history may survive process replacement for read-only display.
				if (isLiveStatus(entry.status) && !isOwnedByThisProcess(run)) continue;
				if (!isTerminalStatus(entry.status)) {
					cache.observations.delete(key);
					visibleEntries.push({
						runId: run.runId,
						createdAt: run.createdAt,
						shape: run.shape,
						detached: run.detached,
						completed: runCompleted,
						entry,
						retry,
					});
					continue;
				}

				const retentionMs = TERMINAL_RETENTION_MS[entry.status];
				const runCompletedAt = typeof run.completedAt === "number" && Number.isFinite(run.completedAt)
					? run.completedAt
					: undefined;
				let observedAt = Number.isFinite(entry.endedAt) ? entry.endedAt : runCompletedAt;
				if (observedAt === undefined) {
					observedAt = cache.observations.get(key)?.observedAt;
					if (observedAt === undefined) {
						observedAt = now;
						cache.observations.set(key, { observedAt });
						trimProjectionCache(cache);
					}
				} else {
					cache.observations.delete(key);
				}

				const expiresAt = observedAt + retentionMs;
				if (now < expiresAt) {
					visibleEntries.push({
						runId: run.runId,
						createdAt: run.createdAt,
						shape: run.shape,
						detached: run.detached,
						completed: runCompleted,
						entry,
						retry,
					});
					nearestExpiry = nearestExpiry === undefined ? expiresAt : Math.min(nearestExpiry, expiresAt);
				} else {
					expiredTerminal = true;
				}
			}
		}

		for (const key of cache.observations.keys()) {
			if (key.startsWith(`${sessionKey}\u0000`) && !seenKeys.has(key)) cache.observations.delete(key);
		}
		if (nearestExpiry === undefined) clearTerminalExpiryTimer();
		else scheduleTerminalExpiryRender(nearestExpiry, now);
		return { pairs: visibleEntries, expiredTerminal, outcomes };
	};

	const unsubs: Array<() => void> = [];
	unsubs.push(pi.events.on("delegate:register", () => requestRender()));
	unsubs.push(pi.events.on("delegate:update", () => requestRender()));
	unsubs.push(pi.events.on("delegate:transcript-append", () => requestRender()));
	unsubs.push(onActivityHeadlinesChanged(requestRender));
	unsubs.push(onActorActivityChanged(requestRender));
	unsubs.push(pi.events.on("delegate:prompt-pending", () => requestRender()));
	unsubs.push(pi.events.on("delegate:prompt-resolved", () => requestRender()));
	unsubs.push(pi.events.on("delegate:guidance-queued", () => requestRender()));
	unsubs.push(pi.events.on("delegate:guidance-drained", () => requestRender()));
	unsubs.push(pi.events.on("luthen.delegate.complete", () => requestRender()));

	const manageTimer = () => {
		// Spec 0014 / REQ-OWN-1: only THIS session's own live entries may keep the
		// 10s self-refresh timer armed. A hydrated FOREIGN live session's run
		// (owningPid = a different pid) must not perturb this session's TUI. A
		// terminal-only grace projection is refreshed by a one-shot expiry timer,
		// never by this live-work interval.
		const active = listRuns().some((run) =>
			sessionMatches(run) &&
			isOwnedByThisProcess(run) &&
			run.completedAt === undefined &&
			Object.values(run.forks).some((entry) => isLiveStatus(entry.status)),
		);
		if (active && refreshTimer === null) {
			refreshTimer = clock.setInterval(requestRender, REFRESH_INTERVAL_MS);
			// unref so the timer never keeps the process alive
			(refreshTimer as { unref?: () => void } | null)?.unref?.();
		} else if (!active && refreshTimer !== null) {
			clock.clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui: any, theme: any) => {
			tuiRef = tui;
			return {
				render: (width: number) => {
					manageTimer();
					// Spec 0014 / REQ-OWN-1: render only runs owned by THIS process. A
					// foreign live session's hydrated active run stays in the shared
					// registry (un-orphaned, retrievable by its owner — REQ-OWN-3) but
					// must NOT paint in this session's widget.
					const now = clock.now();
					const projection = projectVisibleEntries(now);
					const pairs = projection.pairs;
					if (pairs.length === 0 && !projection.expiredTerminal) return [];
					const fallbackColumns = tui.terminal?.columns;
					const cols = Number.isFinite(width)
						? Math.max(0, Math.floor(width))
						: Number.isFinite(fallbackColumns)
							? Math.max(0, Math.floor(fallbackColumns))
							: 120;
					const glyphs = statusGlyphVocabulary(opts.footerIcons);
					const lines: string[] = [];

					// ── Narrow tier: aggregate status plus an attributable sole headline ─
					if (pairs.length > 0 && cols < WIDTH_COMPACT) {
						const aggregate = aggregateLine(pairs, now, theme, cols, glyphs);
						lines.push(aggregate);
						const solePair = pairs.length === 1 ? pairs[0] : undefined;
						const activityLine = solePair
							? renderSummaryLine(getActivityHeadline(solePair.runId, solePair.entry.name)?.text, cols, theme)
							: undefined;
						if (activityLine) lines.push(activityLine);
					} else if (pairs.length > 0) {
						const tier: "wide" | "compact" = cols >= WIDTH_WIDE ? "wide" : "compact";
						for (const { runId, createdAt, shape, detached, completed, entry, retry } of pairs) {
							lines.push(
								...renderRunEntryLine(
									entry,
									runId,
									createdAt,
									now,
									theme,
									cols,
									tier,
									shape,
									detached,
									opts.footerIcons,
									glyphs,
									completed,
									retry,
								),
							);
						}
					}
					if (projection.expiredTerminal) {
						lines.push(theme.fg("dim", renderOutcomeSummary(projection.outcomes, cols)));
					}
					return lines;
				},
				invalidate: () => {},
			};
		},
		{ placement: "belowEditor" },
	);

	manageTimer();

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of unsubs.splice(0)) {
				try {
					off();
				} catch {
					/* noop */
				}
			}
			if (refreshTimer !== null) {
				clock.clearInterval(refreshTimer);
				refreshTimer = null;
			}
			clearTerminalExpiryTimer();
			tuiRef = null;
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				/* widget may already be gone */
			}
		},
		requestRender,
	};
}
