/**
 * `context_status`: one read-only status tool (pi-context-aware#194).
 *
 * Views: `pressure` (the measured size and where it sits on the pressure ladder), `compactions`
 * (the current branch's compaction boundaries and the newest committed writer, as /context-status
 * reports it) and `folds` (the fold engine's mode, its pending and dropped requests, and the active
 * folds, and their measured savings apart from the summary-writing and recall costs) and `skills` (the skills loaded this session: name, state, size and ref, never their text).
 * With no view, all four. Prompt-cache numbers are not a model tool: they are the user
 * command `/context-status cache`.
 */

import type { ExtensionAPI, ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import { obj, opt, type Static } from "@earendil-works/pi-schema";

import { collectCompactionBoundaries, formatCompactionHistory, historyOfBoundaries } from "../compaction/compaction-history.js";
import { committedCompactionWriter, compactionWriterOf, formatCommittedCompactionWriter } from "../compaction/compaction-writer.js";
import { pressureLadderStage } from "../compaction/owner-actions.js";
import type { EntryPressure } from "../compaction/entry-pressure.js";
import type { UsageView } from "../compaction/usage-view.js";
import { describeMethods, strategyErrorLines, type SessionAssignment, type SessionStrategy } from "../folds/engine-resolver.js";
import { oneLine } from "../folds/fold-hints.js";
import { foldRecordsOnBranch } from "../folds/fold-entries.js";
import type { FoldEngine } from "../folds/fold-engine.js";
import { foldAccounting, formatFoldAccounting } from "../folds/fold-savings.js";
import type { PressureLadderConfig } from "../policy/context-policy.js";
import { schemaTool } from "../schema-tool.js";
import { formatLoadedSkills, loadedSkillsOf } from "../skills/skill-registry.js";
import { hasMethod } from "../strategy/methods.js";
import { stringEnum } from "../string-enum.js";
import type { ContextToolSurfaceEntry } from "./surface.js";

export const CONTEXT_STATUS_VIEWS = ["pressure", "compactions", "folds", "skills"] as const;
export type ContextStatusView = (typeof CONTEXT_STATUS_VIEWS)[number];

export const contextStatusSchema = obj({
	view: opt(stringEnum(CONTEXT_STATUS_VIEWS, {
		description: "pressure: context size and pressure-ladder stage. compactions: this branch's compaction boundaries and the last committed compaction writer. folds: fold engine mode, pending and dropped requests, active folds, and measured fold savings apart from summary-writing and recall costs. skills: skills loaded this session with state, size and ref. Omit for all four.",
	})),
}, { open: true });
export type ContextStatusInput = Static<typeof contextStatusSchema>;

const MAX_LISTED = 40;

/** What the tool reads from the extension; the module owns no state. */
export interface ContextStatusHost {
	readonly engine: Pick<FoldEngine, "mode" | "engine" | "pending" | "dropped" | "strategy">;
	/** Pi's reported size, or null when no window is known. An unmeasured size says so. */
	readonly usage: (ctx: ExtensionContext) => UsageView | null;
	readonly ladder: (ctx: ExtensionContext) => PressureLadderConfig;
	/** Entries on the branch since the last compaction, or null when the check is off (pi-context-aware#441). */
	readonly entries?: (ctx: ExtensionContext) => EntryPressure | null;
}

interface StatusResult {
	readonly content: [{ readonly type: "text"; readonly text: string }];
	readonly details: unknown;
	readonly isError?: true;
}

const asText = (text: string, details: unknown, isError?: true): StatusResult => ({ content: [{ type: "text", text }], details, ...(isError ? { isError } : {}) });
const percent = (fraction: number): string => (Math.round(fraction * 1000) / 10) + "%";

function pressureView(ctx: ExtensionContext, host: ContextStatusHost): { text: string; details: Record<string, unknown> } {
	const ladder = host.ladder(ctx);
	const usage = host.usage(ctx);
	const measured = usage !== null && usage.unmeasured !== true;
	const stage = pressureLadderStage(measured ? usage.fraction : null, ladder);
	const thresholds = {
		foldNudgeStartFraction: ladder.foldNudgeStartFraction,
		foldNudgeEndFraction: ladder.foldNudgeEndFraction,
		seededCompactionFraction: ladder.seededCompactionFraction,
		recoverableHideFraction: ladder.recoverableHideFraction,
	};
	const ladderText = "Ladder: fold nudges from " + percent(thresholds.foldNudgeStartFraction) + ", approaching compaction from " + percent(thresholds.foldNudgeEndFraction)
		+ ", seeded compaction from " + percent(thresholds.seededCompactionFraction) + ", recoverable hide from " + percent(thresholds.recoverableHideFraction) + ".";
	const sizeText = usage === null
		? "Context size: no model window is known."
		: measured
			? "Context size: " + usage.tokens + " of " + usage.window + " tokens (" + percent(usage.fraction) + "), " + usage.headroom + " tokens of headroom."
			: "Context size: unknown. Pi has not measured it since the last compaction or overflow.";
	const entries = host.entries?.(ctx) ?? null;
	// The entry-count trigger compacts with or without `compact`; only a session that has it can compact itself
	// (pi-context-aware#528). Without it, `context_compact` is refused, so the line names no tool and no action.
	const reached = entries?.exceeded !== true ? ""
		: hasMethod(host.engine.engine(ctx).strategy.methods, "compact") ? " The limit is reached: compact now, whatever the token usage."
		: " The limit is reached: this session compacts on its own at the limit, whatever the token usage.";
	const entryText = entries === null
		? ""
		: "\nEntries since the last compaction: " + entries.entriesSinceCompaction + " of a limit of " + entries.limit + "." + reached;
	return {
		text: sizeText + "\nLadder stage: " + stage + "." + entryText + "\n" + ladderText,
		details: {
			available: true,
			measured,
			...(measured ? { tokens: usage.tokens, window: usage.window, fraction: usage.fraction, headroom: usage.headroom } : {}),
			stage,
			thresholds,
			...(entries === null ? {} : { entriesSinceCompaction: entries.entriesSinceCompaction, entryLimit: entries.limit, entryLimitReached: entries.exceeded }),
		},
	};
}

function compactionsView(ctx: ExtensionContext): { text: string; details: Record<string, unknown>; failed: boolean } {
	try {
		const boundaries = collectCompactionBoundaries(ctx.sessionManager.getBranch());
		const history = historyOfBoundaries(boundaries);
		// Same observation as /context-status, so the two cannot disagree (pi-context-aware#283).
		const writer = committedCompactionWriter(ctx.sessionManager);
		// Each boundary's writer is read from the entry that boundary came from.
		const compactions = boundaries.map(({ compaction, entry }) => ({ ...compaction, writer: compactionWriterOf(entry) }));
		return {
			text: formatCompactionHistory(history) + "\n" + formatCommittedCompactionWriter(writer),
			details: { available: true, count: compactions.length, writer, compactions },
			failed: false,
		};
	} catch {
		return { text: "Current session compaction history is unavailable.", details: { available: false, count: 0, compactions: [] }, failed: true };
	}
}

function skillsView(ctx: ExtensionContext): { text: string; details: Record<string, unknown> } {
	try {
		const views = loadedSkillsOf(ctx.sessionManager);
		// Registry fields only: never the skill text, its condensed form or its path.
		const skills = views.map((view) => ({ name: view.name, state: view.state, bytes: view.bytes, ...(view.ref ? { ref: view.ref } : {}), ...(view.blockId ? { blockId: view.blockId } : {}) }));
		return { text: formatLoadedSkills(views), details: { available: true, count: skills.length, skills } };
	} catch {
		return { text: "Loaded skills are unavailable.", details: { available: false, count: 0, skills: [] } };
	}
}

/** Characters of an assignment's seed or session id the assignment line shows; longer values are clipped with a visible marker. */
const MAX_SHOWN_ASSIGNMENT_CHARS = 64;

/**
 * The session's assignment (pi-context-aware#473) as one line. The seed and session id are checked where they are
 * read; they are made one line and clipped here as well, so no value can forge a line or grow the status.
 */
function assignmentLine(assignment: SessionAssignment): string {
	const shown = (value: string) => oneLine(value, MAX_SHOWN_ASSIGNMENT_CHARS);
	return "Assignment: seed " + shown(assignment.seed) + ", guidance drawn from " + assignment.variants.join(", ") + " for session " + shown(assignment.drawnFor) +
		(assignment.recorded ? ", recorded in the session." : ", not recorded in the session yet.");
}

/**
 * Why the native folds write nothing (pi-context-aware#529). The auto rule leaves `fold` out only while
 * billion-context-pi is loaded; a setting that leaves it out is named instead, whether or not billion-context-pi is loaded.
 */
function shadowReason(strategy: SessionStrategy): string {
	return strategy.source === "auto" ? "billion-context-pi owns folding" : "this session's methods leave out fold, from " + strategy.source;
}

function foldsView(ctx: ExtensionContext, host: ContextStatusHost): { text: string; details: Record<string, unknown> } {
	const mode = host.engine.mode(ctx);
	const { engine, contradictsPresence, strategy } = host.engine.engine(ctx);
	const strategyErrors = strategyErrorLines(strategy);
	// What the stages of the session's methods, and of its shadow lists, did since the session started (pi-context-aware#472).
	const stageCounts = Object.entries(host.engine.strategy(ctx).counts);
	const pending = host.engine.pending(ctx);
	const dropped = host.engine.dropped(ctx);
	const branch = ctx.sessionManager.getBranch();
	const records = foldRecordsOnBranch(branch).map(({ record }) => record);
	// Savings and their two costs, each on its own line (pi-context-aware#414).
	const accounting = foldAccounting(branch);
	const absorbed = new Set(records.flatMap((record) => record.directBlockIds));
	const active = records.filter((record) => !absorbed.has(record.blockId));
	const listed = active.slice(-MAX_LISTED);
	const lines = [
		"Methods: " + describeMethods(strategy) + ".",
		"Guidance: " + strategy.guidance + ".",
		...(strategy.assignment ? [assignmentLine(strategy.assignment)] : []),
		"Shadow: " + (strategy.shadow.length > 0 ? strategy.shadow.map((methods) => methods.join(", ")).join("; ") : "none") + ".",
		...strategyErrors,
		"Stage outcomes since start: " + (stageCounts.length > 0 ? stageCounts.length + " kinds." : "none."),
		...stageCounts.slice(0, MAX_LISTED).map(([key, count]) => "- " + key + ": " + count),
		...(stageCounts.length > MAX_LISTED ? ["- " + (stageCounts.length - MAX_LISTED) + " more not listed"] : []),
		"Engine: " + engine + ".",
		...(contradictsPresence ? ["Warning: " + strategy.source + " runs fold while billion-context-pi is loaded; the setting wins."] : []),
		"Fold engine: " + (mode === "live" ? "live (pi-context-aware owns folding)" : "shadow (" + shadowReason(strategy) + "; nothing is written here)") + ".",
		"Pending fold requests: " + pending + ".",
		"Dropped in the last batch: " + dropped.length + ".",
		...dropped.slice(0, MAX_LISTED).map((drop) => "- " + drop.startRef + ".." + drop.endRef + ": " + (drop.errors.join(" ") || drop.code || "dropped")),
		"Active folds: " + active.length + ".",
		...listed.map((record) => "- " + record.blockId + " (tier " + record.tier + "): " + (record.topic ?? "(no topic)") + " — " + (record.refs.start || "?") + " to " + (record.refs.end || "?")),
		...(active.length > listed.length ? ["- " + (active.length - listed.length) + " older folds not listed"] : []),
		...formatFoldAccounting(accounting),
	];
	return {
		text: lines.join("\n"),
		details: {
			available: true,
			engine,
			strategy: {
				methods: [...strategy.methods], source: strategy.source, shadow: strategy.shadow.map((methods) => [...methods]), guidance: strategy.guidance,
				errors: strategyErrors, stages: Object.fromEntries(stageCounts.slice(0, MAX_LISTED)),
				...(strategy.assignment ? { assignment: { seed: oneLine(strategy.assignment.seed, MAX_SHOWN_ASSIGNMENT_CHARS), variants: [...strategy.assignment.variants], drawnFor: oneLine(strategy.assignment.drawnFor, MAX_SHOWN_ASSIGNMENT_CHARS), recorded: strategy.assignment.recorded } } : {}),
			},
			mode,
			pending,
			dropped: dropped.slice(0, MAX_LISTED).map((drop) => ({ startRef: drop.startRef, endRef: drop.endRef, errors: [...drop.errors], ...(drop.code ? { code: drop.code } : {}) })),
			active: listed.map((record) => ({ blockId: record.blockId, tier: record.tier, ...(record.topic ? { topic: record.topic } : {}), refs: { start: record.refs.start, end: record.refs.end } })),
			activeCount: active.length,
			savings: accounting.savings,
			preprocessing: accounting.preprocessing,
			recovery: accounting.recovery,
		},
	};
}

/** Run one status call. Exported for tests; the tool below is the only caller. */
export function runContextStatus(ctx: ExtensionContext, host: ContextStatusHost, view?: ContextStatusView): StatusResult {
	if (view === "pressure") { const v = pressureView(ctx, host); return asText(v.text, v.details); }
	if (view === "compactions") { const v = compactionsView(ctx); return asText(v.text, v.details, v.failed ? true : undefined); }
	if (view === "folds") { const v = foldsView(ctx, host); return asText(v.text, v.details); }
	if (view === "skills") { const v = skillsView(ctx); return asText(v.text, v.details); }
	const pressure = pressureView(ctx, host);
	const skills = skillsView(ctx);
	const compactions = compactionsView(ctx);
	const folds = foldsView(ctx, host);
	return asText(
		["== pressure ==", pressure.text, "== compactions ==", compactions.text, "== folds ==", folds.text, "== skills ==", skills.text].join("\n"),
		{ pressure: pressure.details, compactions: compactions.details, folds: folds.details, skills: skills.details },
	);
}

const STATUS_DESCRIPTION = "Read-only status of this session's context: pressure (size and pressure-ladder stage), compactions (boundaries on the current branch and the extension that wrote the last committed compaction, no transcript text), folds (fold engine mode, pending and dropped requests, active folds, and measured fold savings apart from summary-writing and recall costs), and skills (skills loaded this session with state, size and ref). Pass view to read one part. Prompt-cache numbers are not available here: the user can run /context-status cache.";
const STATUS_SNIPPET = "Use context_status({ view? }) to read context size and ladder stage, compaction boundaries and the last writer, or active folds without scanning the transcript.";
const STATUS_GUIDELINES = [
	"Use context_status for context size, compaction count, boundary identifiers and the last committed compaction writer, and active folds. Use context_recall with include_current: true when you need compacted-away transcript text.",
	"For prompt-cache numbers, tell the user to run /context-status cache.",
] as const;

export interface ContextStatusSurface {
	/**
	 * Register the status name one session's surface decision lists. A name already
	 * registered with the same exposure is left alone; a name the decision no longer
	 * lists is registered again with `hidden` exposure.
	 */
	apply(entries: readonly ContextToolSurfaceEntry[]): void;
}

export function createContextStatusSurface(pi: ExtensionAPI, host: ContextStatusHost): ContextStatusSurface {
	const register: Record<"context_status", (exposure: ToolExposure) => void> = {
		context_status: (exposure) => pi.registerTool(schemaTool({
			name: "context_status",
			label: "Context Status",
			description: STATUS_DESCRIPTION,
			promptSnippet: STATUS_SNIPPET,
			promptGuidelines: [...STATUS_GUIDELINES],
			parameters: contextStatusSchema,
			annotations: { readOnlyHint: true, idempotentHint: true },
			exposure,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => runContextStatus(ctx, host, params.view),
		})),
	};
	const registered = new Map<"context_status", ToolExposure>();
	return {
		apply(entries) {
			const wanted = new Map<"context_status", ToolExposure>();
			for (const entry of entries) {
				if (entry.name !== "context_status") continue;
				wanted.set(entry.name, entry.exposure);
			}
			for (const [name, exposure] of wanted) {
				if (registered.get(name) === exposure) continue;
				register[name](exposure);
				registered.set(name, exposure);
			}
			for (const [name, exposure] of registered) {
				if (wanted.has(name) || exposure === "hidden") continue;
				register[name]("hidden");
				registered.set(name, "hidden");
			}
		},
	};
}
