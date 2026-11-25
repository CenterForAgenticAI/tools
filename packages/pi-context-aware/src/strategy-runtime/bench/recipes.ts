/**
 * The recipes the strategy bench replays (pi-context-aware#469), written against the strategy contract:
 * each stage reads only the frozen view and returns plans as data.
 *
 * - `folds-v1`, as recorded: re-issues every recorded fold as a `summarize` plan with the recorded
 *   summary, on the request the fold first applied to.
 * - `folds-v1`, stand-in: today's tier-1 growth nudge (the kernel's `decideNudge` in
 *   src/folds/kernel/compress.ts, tier 1 only, with the fold pass's turn gate) with a stand-in model that folds every foldable range
 *   on the request after each nudge, with a mechanical summary of recorded length. Parameters vary the
 *   growth threshold and add a usage floor (pi-context-aware#456).
 * - `compaction-only-v1`: seeded compaction at a pressure threshold, with a mechanical summary of
 *   recorded compaction length.
 * - `mask-then-fold` and `trim-then-fold` (pi-context-aware#471, in recipes/): mechanical stubs of tool
 *   results, then the `folds-v1` stand-in stages.
 *
 * The runner (replay.ts) asks every stage's `wants` exactly once per request, in stage order; the
 * recorded recipe counts requests by those calls.
 */

import { defaultConfig } from "../../folds/kernel/index.js";
import {
	STRATEGY_CONTRACT_VERSION,
	type ContextPlan,
	type ContextView,
	type Recipe,
	type SayOp,
	type Stage,
	type SummarizeOp,
	type ViewEntry,
} from "../../strategy/contract.js";
import type { ExternalRecipeId } from "./external-strategy.js";
import { maskThenFoldRecipe } from "./recipes/mask-then-fold.js";
import { KEEP_RECENT_RESULTS, type ToolOutputIndex } from "./recipes/tool-output.js";
import { TRIM_BATCH_REQUESTS, trimThenFoldRecipe } from "./recipes/trim-then-fold.js";
import type { RecordedFold } from "./recording.js";

/** What a recipe may know about the recorded session besides the view. */
export interface SessionFacts {
	readonly recordedFolds: readonly RecordedFold[];
	/** Characters of a stand-in fold summary. */
	readonly foldSummaryChars: number;
	/** Characters of a stand-in compaction summary. */
	readonly compactionSummaryChars: number;
	/** What each recorded tool result held, by entry id: `trim-then-fold` finds repeated output and writes previews from it. */
	readonly toolOutput: ToolOutputIndex;
}

export interface BenchRecipe {
	readonly recipe: Recipe;
	/** Stages whose accepted `summarize` the bench writes as a Pi compaction entry, as seeded compaction does live. */
	readonly compactionStages: ReadonlySet<string>;
	/** Each plan re-issues the request's next recorded fold: the runner checks it, then applies the fold as recorded. */
	readonly replaysRecorded?: boolean;
	/** Refusals the recipe's adapter made since the last call, by code, before any plan reached `checkPlan` (an external strategy's refused replies). The runner counts them with the plan refusals. */
	readonly takeRefusals?: () => readonly string[];
	/**
	 * Plans still queued for a stage whose plans all come from one answer (an external strategy's reply), or
	 * undefined for a stage that plans afresh each time. The runner takes every queued plan in order, whatever
	 * the one before changed, so no plan of a reply is dropped unchecked: an empty plan changes nothing, a
	 * plan that only says something is applied, and a repeated plan is checked again on the view the first left.
	 */
	readonly queuedPlans?: (stageId: string) => number | undefined;
}

export interface StrategySpec {
	/** Report id, such as `folds-v1/growth-100k`. */
	readonly id: string;
	readonly recipe: "folds-v1" | "compaction-only-v1" | "mask-then-fold" | "trim-then-fold" | ExternalRecipeId;
	/** `recorded`: the recorded folds replay as they happened. `stand-in`: a stand-in model decides. `external`: a strategy in another process decides (external-strategy.ts). */
	readonly mode: "recorded" | "stand-in" | "external";
	readonly params: Readonly<Record<string, number | string>>;
	readonly build: (facts: SessionFacts) => BenchRecipe;
}

export interface StandInParams {
	/** Tier-1 nudge threshold in tokens of foldable content; `null` resolves it as the kernel does (50k on every window: its floor and cap are both 50000). */
	readonly growthTokens: number | null;
	/** No growth nudge below this share of the context window; 0 for none. */
	readonly usageFloor: number;
	/** Tokens of one stand-in nudge. */
	readonly nudgeTokens: number;
	/** Pressure at which the seeded-compaction stage compacts. */
	readonly compactionFraction: number;
}

export interface BenchOptions {
	readonly nudgeTokens: number;
	/** `folds-v1`'s seeded-compaction stage (the shipped `seededCompactionFraction`). */
	readonly foldsCompactionFraction: number;
	/** `compaction-only-v1`'s threshold. */
	readonly compactionOnlyFraction: number;
}

export const DEFAULT_BENCH_OPTIONS: BenchOptions = Object.freeze({
	// A tier-1 nudge is about 1.8k tokens (pi-context-aware#456).
	nudgeTokens: 1_800,
	foldsCompactionFraction: 0.9,
	compactionOnlyFraction: 0.9,
});

/** Roles a fold or compaction can take: the roles a context edit can replace. */
const EDITABLE: ReadonlySet<ViewEntry["role"]> = new Set(["user", "assistant", "toolResult", "custom"]);
/** The kernel counts a range's characters; the view holds tokens, at four characters each. */
const CHARS_PER_TOKEN = 4;

/** Mechanical text of `chars` characters (at least the kernel's 50-character minimum, at most its 20000 maximum). */
export function standInText(lead: string, chars: number): string {
	const target = Math.min(20_000, Math.max(60, Math.round(chars)));
	const filler = " Mechanical stand-in text of recorded length; it carries none of the folded content.";
	let text = lead;
	while (text.length < target) text += filler;
	return `${text.slice(0, target - 1)}.`;
}

/** Runs of consecutive entries a fold may take, each at least `minChars` characters, oldest first. */
export function foldableRuns(view: ContextView, minChars: number): ViewEntry[][] {
	const kept = new Set(view.protectedEntryIds);
	for (const hide of view.hides) kept.add(hide.targetId);
	const runs: ViewEntry[][] = [];
	let run: ViewEntry[] = [];
	const close = () => {
		if (run.reduce((sum, entry) => sum + entry.tokens, 0) * CHARS_PER_TOKEN >= minChars) runs.push(run);
		run = [];
	};
	const carriers = new Set(view.folds.map((fold) => fold.carrierId));
	for (const entry of view.entries) {
		if (EDITABLE.has(entry.role) && !kept.has(entry.id) && !carriers.has(entry.id) && entry.hint !== "verbatim") run.push(entry);
		else close();
	}
	close();
	return runs;
}

const tokensOf = (entries: readonly ViewEntry[]): number => entries.reduce((sum, entry) => sum + entry.tokens, 0);

/**
 * Foldable runs with the ends a fold names. A range is named by message refs, so its ends are messages
 * the engine numbers: user messages, tool results and assistant messages that call a tool. An assistant
 * message with only thinking has no ref, and the view does not tell it from one with text, so neither is an end.
 */
const namedEnd = (entry: ViewEntry): boolean => entry.tokens > 0 && (entry.role === "user" || entry.role === "toolResult" || (entry.role === "assistant" && (entry.toolCallIds?.length ?? 0) > 0));

function foldRanges(view: ContextView, minChars: number): { run: ViewEntry[]; ends: ViewEntry[]; key: string }[] {
	return foldableRuns(view, minChars).flatMap((run) => {
		const ends = run.filter(namedEnd);
		return ends.length === 0 ? [] : [{ run, ends, key: `${ends[0]!.id}..${ends[ends.length - 1]!.id}` }];
	});
}

/** The turn a request belongs to: its last user entry. */
function lastUserId(view: ContextView): string {
	for (let i = view.entries.length - 1; i >= 0; i--) if (view.entries[i]!.role === "user") return view.entries[i]!.id;
	return "";
}

/** `folds-v1` as recorded: each recorded fold, re-issued with its recorded summary on the request it first applied to. */
export function recordedFoldsRecipe(facts: SessionFacts): BenchRecipe {
	const due = new Map<number, RecordedFold[]>();
	for (const fold of facts.recordedFolds) due.set(fold.request, [...(due.get(fold.request) ?? []), fold]);
	let request = -1;
	/** The request's recorded folds not yet planned, in recorded order: one per plan, so each is planned on the view the one before left. */
	let queue: RecordedFold[] = [];
	/** An entry id, or the active fold that took it: a fold over earlier folds names them by block id. */
	const endpoint = (view: ContextView, id: string): string => view.folds.find((fold) => fold.carrierId === id || fold.hiddenIds.includes(id))?.blockId ?? id;
	const stage: Stage = {
		id: "recorded-fold",
		wants: () => {
			queue = [...(due.get(++request) ?? [])];
			return queue.length > 0 ? "now" : null;
		},
		plan: (view) => {
			const fold = queue.shift();
			return fold ? [{
				kind: "summarize",
				startId: endpoint(view, fold.record.range.startId),
				endId: endpoint(view, fold.record.range.endId),
				...(fold.record.topic ? { topic: fold.record.topic } : {}),
				writer: "plan",
				summary: fold.summary,
			} satisfies SummarizeOp] : [];
		},
		offers: ["context_fold"],
	};
	return { recipe: { id: "folds-v1", contractVersion: STRATEGY_CONTRACT_VERSION, stages: [stage] }, compactionStages: new Set(), replaysRecorded: true };
}

function compactionStage(fraction: number, summaryChars: number): Stage {
	return {
		id: "seeded-compaction",
		wants: (view) => (view.pressure >= fraction ? "at-boundary" : null),
		plan: (view): ContextPlan => {
			const kept = new Set(view.protectedEntryIds);
			let tail = view.entries.length;
			while (tail > 0 && kept.has(view.entries[tail - 1]!.id)) tail--;
			const head = view.entries.slice(0, tail).filter((entry) => EDITABLE.has(entry.role) && entry.role !== "custom");
			if (head.length === 0 || tokensOf(head) * CHARS_PER_TOKEN < defaultConfig(view.model.contextWindow).compress.minCompressRange) return [];
			const summary = standInText(`[bench stand-in compaction summary of ${head.length} entries]`, summaryChars);
			return [{ kind: "summarize", startId: head[0]!.id, endId: head[head.length - 1]!.id, writer: "plan", summary }];
		},
		offers: ["context_compact"],
	};
}

/** `folds-v1` with the stand-in model: growth nudge, the model's fold on the next request, seeded compaction. */
export function standInFoldsRecipe(params: StandInParams, facts: SessionFacts): BenchRecipe {
	const nudge = { baseline: 0, shown: 0, folds: new Set<string>(), foldNext: false, turns: new Map<string, number>() };
	/** Ranges planned on this request, by first entry: the model folds every foldable range, one per plan. */
	let tried = new Set<string>();
	/** Ranges a check refused: the same entries are refused again, so the model does not retry them. */
	const refused = new Set<string>();
	let last: string | undefined;
	const foldStage: Stage = {
		id: "model-fold",
		wants: (view) => {
			const nudged = nudge.foldNext;
			nudge.foldNext = false;
			tried = new Set();
			last = undefined;
			return nudged && view.tools.includes("context_fold") ? "now" : null;
		},
		plan: (view) => {
			const ranges = foldRanges(view, defaultConfig(view.model.contextWindow).compress.minCompressRange);
			// The range planned last is still there: its check refused it.
			if (last !== undefined && ranges.some((range) => range.key === last)) refused.add(last);
			for (const { run, ends, key } of ranges) {
				if (tried.has(ends[0]!.id) || refused.has(key)) continue;
				tried.add(ends[0]!.id);
				last = key;
				return [{
					kind: "summarize",
					startId: ends[0]!.id,
					endId: ends[ends.length - 1]!.id,
					writer: "plan",
					summary: standInText(`[bench stand-in fold summary of ${run.length} entries]`, facts.foldSummaryChars),
				} satisfies SummarizeOp];
			}
			return [];
		},
		offers: ["context_fold"],
	};
	// A copy of the kernel's decision, not a call: `decideNudge` is not exported from the vendored kernel, and
	// the fold pass that runs it (`prepareFoldTurn`) rebuilds the kernel state from the whole branch on every
	// request and reads more than the view. tests/strategy-bench.test.ts compares the whole nudge sequence with
	// `prepareFoldTurn` on several sessions (CR-BENCH-STANDIN-NUDGE-NOT-KERNEL).
	const nudgeStage: Stage = {
		id: "growth-nudge",
		wants: (view) => {
			const window = view.model.contextWindow;
			const config = defaultConfig(window);
			const tokens = view.pressure * window;
			// A fold made since the last request resets the growth baselines, as the kernel's applyCompression does.
			const folds = new Set(view.folds.map((fold) => fold.blockId));
			if ([...folds].some((id) => !nudge.folds.has(id))) {
				nudge.baseline = 0;
				nudge.shown = 0;
			}
			nudge.folds = folds;
			const growthTokens = params.growthTokens ?? Math.min(config.nudge.growthCap, Math.max(config.nudge.growthFloor, Math.round(window * config.nudge.growthRatio)));
			const reference = nudge.shown > 0 ? nudge.shown : nudge.baseline > 0 ? nudge.baseline : tokens;
			const growthFloor = Math.max(config.nudge.minGrowthFloor, config.nudge.minGrowthRatio * growthTokens);
			const overLimit = view.pressure >= config.nudge.maxContextLimitPct;
			const firstSightBand = nudge.shown === 0 && nudge.baseline === 0 && view.pressure >= config.nudge.minContextLimitPct;
			const growthReady = tokens - reference >= growthFloor;
			// Pending needs the protected zone, a full view build over the whole branch, so it is measured only on a
			// request where it can decide; there it is measured every time, as decideNudge does. Ranges a check
			// refused do not count: the kernel offers only ranges a fold can take.
			const decides = overLimit || ((firstSightBand || growthReady) && view.pressure >= params.usageFloor);
			const pending = decides ? tokensOf(foldRanges(view, config.compress.minCompressRange).filter((range) => !refused.has(range.key)).flatMap((range) => range.run)) : 0;
			const inject = overLimit
				? pending >= Math.max(5_000, Math.round(window * 0.01))
				: (firstSightBand || growthReady) && pending >= growthTokens && view.pressure >= params.usageFloor;
			// The kernel's stamps (src/folds/kernel/compress.ts, after decideNudge).
			if ((nudge.baseline > 0 && tokens < nudge.baseline - growthTokens) || (nudge.shown > 0 && tokens < nudge.shown - growthTokens)) {
				nudge.baseline = tokens;
				nudge.shown = 0;
			}
			if (nudge.baseline === 0) nudge.baseline = tokens;
			// The fold pass's turn gate (nudgeGate in src/folds/fold-turn.ts): once a turn has shown a nudge, another
			// shows only after the re-inject growth, unless usage is in the emergency band. Like nudgeGate, it
			// re-anchors on every request, so a fold that shrank the context lets the same turn nudge again.
			const turn = lastUserId(view);
			let shownAt = nudge.turns.get(turn);
			if (shownAt !== undefined && tokens < shownAt - growthTokens) {
				shownAt = tokens;
				nudge.turns.set(turn, tokens);
			}
			if (!inject) return null;
			nudge.shown = tokens;
			const emergency = view.pressure >= config.nudge.emergencyThresholdPct;
			if (!emergency && shownAt !== undefined && tokens - shownAt < growthFloor) return null;
			if (!emergency) nudge.turns.set(turn, tokens);
			nudge.foldNext = true;
			return "now";
		},
		plan: () => [],
		// Live, the nudge names only tools the session can call, and there is none without one (`reachableNudgeText`
		// in src/folds/nudge-tools.ts): a Fabric worker session gets no nudge (pi-context-aware#458).
		nudge: (view): SayOp | null => (view.tools.includes("context_fold") ? { kind: "say", text: standInText("Context is growing: fold a consumed range with `context_fold`. [bench stand-in nudge]", params.nudgeTokens * CHARS_PER_TOKEN) } : null),
		offers: ["context_fold"],
	};
	return {
		recipe: { id: "folds-v1", contractVersion: STRATEGY_CONTRACT_VERSION, stages: [foldStage, nudgeStage, compactionStage(params.compactionFraction, facts.compactionSummaryChars)] },
		compactionStages: new Set(["seeded-compaction"]),
	};
}

/** `compaction-only-v1`: seeded compaction at its threshold. */
export function compactionOnlyRecipe(fraction: number, facts: SessionFacts): BenchRecipe {
	return {
		recipe: { id: "compaction-only-v1", contractVersion: STRATEGY_CONTRACT_VERSION, stages: [compactionStage(fraction, facts.compactionSummaryChars)] },
		compactionStages: new Set(["seeded-compaction"]),
	};
}

/** The strategies of the bench report: the two baselines, the pi-context-aware#456 trigger variants, and the pi-context-aware#471 mechanical recipes. */
export function benchStrategies(options: BenchOptions = DEFAULT_BENCH_OPTIONS): StrategySpec[] {
	const standIn = (id: string, growthTokens: number | null, usageFloor: number): StrategySpec => ({
		id: `folds-v1/${id}`,
		recipe: "folds-v1",
		mode: "stand-in",
		params: { growthTokens: growthTokens ?? "kernel (50000)", usageFloor, nudgeTokens: options.nudgeTokens, compactionFraction: options.foldsCompactionFraction },
		build: (facts) => standInFoldsRecipe({ growthTokens, usageFloor, nudgeTokens: options.nudgeTokens, compactionFraction: options.foldsCompactionFraction }, facts),
	});
	// The mechanical recipes' `folds-v1` stages: today's kernel nudge, as in `folds-v1/growth-50k`.
	const kernelStandIn: StandInParams = { growthTokens: null, usageFloor: 0, nudgeTokens: options.nudgeTokens, compactionFraction: options.foldsCompactionFraction };
	return [
		{ id: "folds-v1/recorded", recipe: "folds-v1", mode: "recorded", params: {}, build: recordedFoldsRecipe },
		standIn("growth-50k", null, 0),
		standIn("growth-100k", 100_000, 0),
		standIn("floor-30", null, 0.3),
		standIn("floor-45", null, 0.45),
		standIn("floor-30+growth-100k", 100_000, 0.3),
		standIn("floor-45+growth-100k", 100_000, 0.45),
		{
			id: "compaction-only-v1",
			recipe: "compaction-only-v1",
			mode: "stand-in",
			params: { compactionFraction: options.compactionOnlyFraction },
			build: (facts) => compactionOnlyRecipe(options.compactionOnlyFraction, facts),
		},
		{
			id: "mask-then-fold",
			recipe: "mask-then-fold",
			mode: "stand-in",
			params: { keep: KEEP_RECENT_RESULTS, growthTokens: "kernel (50000)", nudgeTokens: options.nudgeTokens, compactionFraction: options.foldsCompactionFraction },
			build: (facts) => maskThenFoldRecipe({ keep: KEEP_RECENT_RESULTS }, kernelStandIn, facts),
		},
		{
			id: "trim-then-fold",
			recipe: "trim-then-fold",
			mode: "stand-in",
			params: { keep: KEEP_RECENT_RESULTS, batch: TRIM_BATCH_REQUESTS, growthTokens: "kernel (50000)", nudgeTokens: options.nudgeTokens, compactionFraction: options.foldsCompactionFraction },
			build: (facts) => trimThenFoldRecipe({ keep: KEEP_RECENT_RESULTS, batch: TRIM_BATCH_REQUESTS }, kernelStandIn, facts),
		},
	];
}