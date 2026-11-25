/**
 * The strategy bench's replay loop (pi-context-aware#469, REQ-STRAT-004, REQ-STRAT-006). It walks one
 * recorded session request by request. Per request it builds the frozen view with the runtime's
 * `buildContextView`, asks each stage of the recipe whether it wants to act, checks every plan with
 * `checkPlan` (summaries planned by `planFold` through `summarizeEngine`), and applies accepted effects
 * to a simulated copy of the branch. Nothing is written anywhere: the simulated branch is an array.
 *
 * Token and cache figures are anchored to the recording. A request's size is its recorded size plus the
 * difference between the strategy's simulated context and the recorded one, both estimated the same way
 * (the view's token estimate). Cache reads are the recorded reads plus the difference in the cached
 * prefix the same model gives each branch; writes are the rest. So a strategy that does what the
 * recording did reproduces the recording, and a variant differs only by what it changed.
 */

import { buildContextEntries, buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { summarizeEngine } from "../../folds/fold-adapter.js";
import { FOLD_ENTRY_TYPE } from "../../folds/fold-entries.js";
import { createFoldHints, type FoldHintView } from "../../folds/fold-hints.js";
import { HIDE_ENTRY_TYPE, hidePointerLine } from "../../folds/hide-entries.js";
import { defaultCountTokens } from "../../folds/kernel/index.js";
import type { ContextPlan, ContextView, Recipe, ViewEntry } from "../../strategy/contract.js";
import { checkPlan, type SummarizeEngine } from "../check-plan.js";
import { buildContextView, cacheAgeMs } from "../context-view.js";
import { addCost, priceRequest, ZERO_COST, type Cost, type PriceBook, type PricedModel, type WriteCharge } from "./pricing.js";
import type { BenchRecipe, SessionFacts, StrategySpec } from "./recipes.js";
import { toolOutputIndex } from "./recipes/tool-output.js";
import type { Recording, RecordedFold, RecordedRequest } from "./recording.js";

/** Context window used when the registry does not list a model; such models are reported. */
export const FALLBACK_CONTEXT_WINDOW = 200_000;
/** Relative-error histogram: buckets of 0.5 percentage points from 0 to 100%, then one overflow bucket. */
export const ERROR_BUCKETS = 201;
const BUCKET_WIDTH = 0.005;

export interface ReplayOptions {
	/** A Fabric worker or subagent session: `context_fold` and `context_compact` are registered but not reachable (pi-context-aware#458). */
	readonly child: boolean;
	readonly prices: PriceBook;
	/** Recall-after-hide counts a recorded `context_recall` within this many requests of a hide. */
	readonly recallWindow: number;
	/** `when-cache-cold` stages act once the cache is at least this old. */
	readonly coldCacheMs: number;
	/** Stand-in summary sizes when the session recorded none of its own. */
	readonly fallbackFoldSummaryChars: number;
	readonly fallbackCompactionSummaryChars: number;
	/** Called once per request of each strategy (`baseline` for the recorded branch) with what the bench modeled and the simulated branch the request carried (live: copy it to keep it). */
	readonly trace?: (strategy: string, request: number, step: TraceStep, branch: readonly SessionEntry[]) => void;
	/** Compare every view the bench extends without a full build with a full build, and throw on a difference (tests). */
	readonly checkIncremental?: boolean;
}

export interface TraceStep {
	/** Modeled request size, before `say` tokens. */
	readonly size: number;
	/** The bench's own estimate: the view's entries plus the session's first-request overhead. */
	readonly estimate: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Uncached input: `size + sayTokens = cacheRead + cacheWrite + input`. */
	readonly input: number;
	readonly sayTokens: number;
}

export interface StrategyResult {
	readonly requests: number;
	readonly tokensSent: number;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
	/** Tokens of accepted `say` messages (nudges), included in `tokensSent`. */
	readonly sayTokens: number;
	readonly nudges: number;
	/** Folds the strategy's stages made (re-issued recorded folds included). */
	readonly folds: number;
	/** Compactions the strategy's stages made. */
	readonly compactions: number;
	/** Recorded compactions, replayed as recorded in every strategy. */
	readonly recordedCompactions: number;
	/** Refused plan operations by reason code. */
	readonly refusals: Readonly<Record<string, number>>;
	readonly cost: Cost;
	/** Dollars of the summarizer calls behind compactions (recorded and the strategy's): pre-compaction context as uncached input, the summary as output. */
	readonly compactionCallCost: number;
	/** Folds and stubs the strategy made, and how many of them a recorded `context_recall` asked for within the recall window. */
	readonly hides: number;
	readonly recalledWithinWindow: number;
	/** Sum over requests of |modeled size - recorded size|. */
	readonly sizeDeltaAbs: number;
	/**
	 * The bench's own size estimate (the view's entries plus the session's first-request overhead) against
	 * each recorded size: a histogram of relative errors and the summed absolute error.
	 */
	readonly estimate: { readonly histogram: readonly number[]; readonly absError: number; readonly recorded: number };
	readonly unpricedRequests: number;
}

export interface SessionResult {
	readonly sessionId: string;
	readonly child: boolean;
	readonly requests: number;
	/** What the session recorded, priced from the registry, and Pi's own recorded cost. */
	readonly recorded: {
		readonly input: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly output: number;
		readonly cost: Cost;
		readonly piCost: number;
		readonly folds: number;
		readonly compactions: number;
		readonly recalls: number;
	};
	/** Requests off the branch or warming the cache: the same in every strategy. */
	readonly other: { readonly requests: number; readonly cost: Cost; readonly piCost: number };
	/** One result per strategy, in the order given. */
	readonly strategies: readonly StrategyResult[];
	/** Requests per `provider/model`, with the registry entry that priced them (`null`: unpriced) and whether its window was known. */
	readonly models: Readonly<Record<string, { readonly pricedAs: string | null; readonly requests: number }>>;
	/** Recorded tokens per estimated token (see `tokenScale`); `fitted` false when it fell back to 1. */
	readonly tokenScale: { readonly value: number; readonly fitted: boolean };
	/** Whether the session's recorded sizes follow its branch, so strategies can be priced on it (see `sessionFidelity`). */
	readonly fidelity: SessionFidelity;
}

/**
 * Why a session's recorded sizes do not follow its branch:
 * - `another-context-manager`: billion-context-pi folded in it. Its folds live in a side file, not on the
 *   branch, so later requests carried less than the branch holds; a strategy without it would have sent
 *   the whole branch, which no recorded size shows.
 * - `usage-only-log`: the file records requests but no user message or tool result (a Fabric worker's usage
 *   log), so the branch holds far less than was sent.
 * - `estimate-error`: the bench's own estimate is off from the recorded sizes by more than
 *   `MAX_ESTIMATE_ERROR` over the session, for a reason the bench does not know.
 */
export type UnmodelledReason = "another-context-manager" | "usage-only-log" | "estimate-error";

export interface SessionFidelity {
	/** True when no reason applies: the session's strategy figures enter the modelled tables. */
	readonly modelled: boolean;
	readonly reasons: readonly UnmodelledReason[];
	/** The bench's own estimate against the recorded sizes over the session: summed absolute error over summed recorded size. */
	readonly estimateError: number;
}

/**
 * Above this session estimate error, the recorded sizes are taken not to follow the branch. A strategy's
 * request size is the recorded size plus the scaled difference between its view and the recorded branch's
 * view; where the recording sent much less than the branch holds, a fold is credited with tokens never
 * sent (pi-context-aware#469, CR-BENCH-UNSENT-CONTEXT-SAVINGS). In the MacBook's slice of the corpus, the
 * 433 modelled main sessions are within 18.1%; 10 of the 11 main sessions above the bound had
 * billion-context-pi folds, and 3 sessions with such folds stayed under it and are caught by that reason.
 */
export const MAX_ESTIMATE_ERROR = 0.25;

const MAIN_TOOLS = ["context_compact", "context_fold", "context_recall"] as const;

const sentOf = (request: RecordedRequest): number => request.usage.input + request.usage.cacheRead + request.usage.cacheWrite;
const modelKey = (provider: string, model: string): string => `${provider}/${model}`;

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The stand-in summary sizes of one session: the median of its own recorded summaries, else the fallback. */
export function sessionFacts(recording: Recording, options: Pick<ReplayOptions, "fallbackFoldSummaryChars" | "fallbackCompactionSummaryChars">): SessionFacts {
	return {
		recordedFolds: recording.folds,
		foldSummaryChars: median(recording.folds.filter((fold) => fold.record.tier === 1).map((fold) => fold.carrierChars)) ?? options.fallbackFoldSummaryChars,
		compactionSummaryChars: median(recording.compactions.map((compaction) => compaction.summaryChars)) ?? options.fallbackCompactionSummaryChars,
		toolOutput: toolOutputIndex(recording.path),
	};
}

/** What the baseline pass measures on the recorded branch, per request, for the strategies to be anchored to. */
interface Baseline {
	readonly estimates: readonly number[];
	readonly prefixes: readonly PrefixParts[];
	/** Recorded tokens per estimated token on this session (see `tokenScale`). */
	readonly scale: number;
}

/** Bounds on `tokenScale`: outside them the fit is noise, and 1 is used. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/**
 * Recorded tokens per estimated token on one session: the least-squares slope of each request's recorded
 * size over its estimate, both measured from the first request with usage. The estimate counts about four
 * characters per token; code and JSON tokenize denser, so a difference in estimated tokens is scaled by
 * this before it is added to a recorded size. 1, not fitted, when the session has too little growth to fit
 * or the fit falls outside [0.5, 3]; the report counts those sessions.
 */
export function tokenScale(recorded: readonly number[], estimates: readonly number[]): { readonly value: number; readonly fitted: boolean } {
	const unfitted = { value: 1, fitted: false };
	const first = recorded.findIndex((size) => size > 0);
	if (first < 0) return unfitted;
	let cross = 0;
	let square = 0;
	recorded.forEach((size, i) => {
		if (i <= first || size <= 0) return;
		const x = estimates[i]! - estimates[first]!;
		cross += x * (size - recorded[first]!);
		square += x * x;
	});
	if (square <= 0) return unfitted;
	const slope = cross / square;
	return slope >= MIN_SCALE && slope <= MAX_SCALE ? { value: slope, fitted: true } : unfitted;
}

/**
 * The bench's own estimate against the recorded sizes: each request with usage is estimated as the first
 * one's size plus `scale` times the growth of the branch's estimate since, and the summed absolute error
 * is divided by the summed recorded size. 0 when no request has usage.
 */
export function estimateError(recorded: readonly number[], estimates: readonly number[], scale: number): number {
	const first = recorded.findIndex((size) => size > 0);
	if (first < 0) return 0;
	let error = 0;
	let total = 0;
	recorded.forEach((size, i) => {
		if (size <= 0) return;
		error += Math.abs(recorded[first]! + scale * (estimates[i]! - estimates[first]!) - size);
		total += size;
	});
	return error / total;
}

/** Whether a session's recorded sizes follow its branch, and why not. */
export function sessionFidelity(recording: Pick<Recording, "foreignFolds" | "transcript">, estimateErrorValue: number): SessionFidelity {
	const reasons: UnmodelledReason[] = [];
	if (recording.foreignFolds > 0) reasons.push("another-context-manager");
	if (!recording.transcript) reasons.push("usage-only-log");
	if (estimateErrorValue > MAX_ESTIMATE_ERROR) reasons.push("estimate-error");
	return { modelled: reasons.length === 0, reasons, estimateError: Math.round(estimateErrorValue * 10_000) / 10_000 };
}

interface Model {
	readonly priced: PricedModel | undefined;
	readonly window: number;
	readonly write: WriteCharge;
}

/** The simulated branch: copies of the recorded entries with their parents relinked, plus what effects added. */
class SimulatedBranch {
	readonly entries: SessionEntry[] = [];
	readonly byId = new Map<string, SessionEntry>();
	readonly position = new Map<string, number>();
	/** Entries whose content changed since the last request: context-edit targets. */
	changed = new Set<string>();
	/** A compaction was added since the last request. */
	compacted = false;
	/** An entry other than an append-only one was added since the last full view build. */
	structural = false;
	private added = 0;

	push(entry: SessionEntry): void {
		const copy = { ...entry, parentId: this.entries[this.entries.length - 1]?.id ?? null } as SessionEntry;
		this.position.set(copy.id, this.entries.length);
		this.entries.push(copy);
		this.byId.set(copy.id, copy);
		if (copy.type === "context_edit") this.changed.add(copy.targetId);
		if (copy.type === "compaction") this.compacted = true;
		if (!appendOnly(copy)) this.structural = true;
	}

	/** Add an entry the bench made, with a deterministic id. */
	add(entry: Record<string, unknown>, at: number): SessionEntry {
		const made = { ...entry, id: `bench-${++this.added}`, parentId: null, timestamp: new Date(at).toISOString() } as unknown as SessionEntry;
		this.push(made);
		return this.entries[this.entries.length - 1]!;
	}
}

/**
 * Entries that change how earlier entries show: context edits, compactions, branch summaries and fold
 * and hide records. After one, the next view is built in full. Every other entry only adds to what the
 * model reads; `checkIncremental` holds that claim against a full build.
 */
const REWRITES: ReadonlySet<string> = new Set(["context_edit", "compaction", "branch_summary", "branch_change"]);
const REWRITING_RECORDS: ReadonlySet<string> = new Set([FOLD_ENTRY_TYPE, HIDE_ENTRY_TYPE]);
const appendOnly = (entry: SessionEntry): boolean => !REWRITES.has(entry.type) && !(entry.type === "custom" && REWRITING_RECORDS.has(entry.customType));

interface ViewModel {
	readonly id: string;
	readonly contextWindow: number;
}

interface FullView {
	readonly view: ContextView;
	/** Sum of the view's entry tokens. */
	readonly estimate: number;
	/** Model and time the view was built for: the protected zone and the cache age depend on them. */
	readonly key: string;
}

function contextEntriesOf(entries: readonly SessionEntry[], byId: ReadonlyMap<string, SessionEntry>): SessionEntry[] {
	return buildContextEntries(entries as SessionEntry[], entries[entries.length - 1]?.id ?? null, byId as Map<string, SessionEntry>);
}

/**
 * Builds each request's view of one simulated branch without rebuilding it from the whole branch on
 * every request (pi-context-aware#469, CR-BENCH-CORPUS-SCALE-COST). A full `buildContextView` over the
 * branch runs after an entry that is not append-only, and when a stage reads a field only a full build
 * gives: the protected zone or the cache age. Otherwise the entries appended since the last full build
 * are viewed on their own and added to it, since an appended entry's view does not depend on the entries
 * before it. Folds and hides change only with entries that force a full build. `check` compares every
 * extension with a full build and throws on a difference.
 */
class ViewBuilder {
	private full: FullView | undefined;
	private extra: ViewEntry[] = [];
	private extraTokens = 0;
	private seen = 0;

	constructor(private readonly branch: SimulatedBranch, private readonly child: boolean, private readonly hints: FoldHintView, private readonly check: boolean) {}

	private viewOf(entries: readonly SessionEntry[], byId: ReadonlyMap<string, SessionEntry>, model: ViewModel, now: number): ContextView {
		return buildContextView({
			branch: entries,
			contextEntries: contextEntriesOf(entries, byId),
			projection: buildSessionProjection(entries as SessionEntry[], entries[entries.length - 1]?.id ?? null, byId as Map<string, SessionEntry>),
			model,
			hints: this.hints,
			tokens: 0,
			reachableTools: this.child ? [] : MAIN_TOOLS,
			registeredTools: MAIN_TOOLS,
			now,
			compactionOwner: "none",
		});
	}

	private rebuild(model: ViewModel, now: number): FullView {
		const view = this.viewOf(this.branch.entries, this.branch.byId, model, now);
		this.full = { view, estimate: -view.unownedTokens, key: `${model.id}/${model.contextWindow}/${now}` };
		this.extra = [];
		this.extraTokens = 0;
		this.seen = this.branch.entries.length;
		this.branch.structural = false;
		return this.full;
	}

	/** A full view of the branch as it stands now. */
	materialize(model: ViewModel, now: number): FullView {
		const current = this.full;
		const fresh = current !== undefined && this.extra.length === 0 && this.seen === this.branch.entries.length && !this.branch.structural;
		return fresh && current.key === `${model.id}/${model.contextWindow}/${now}` ? current : this.rebuild(model, now);
	}

	/** The estimate of the branch as it stands now: the sum of its view's entry tokens. */
	estimate(model: ViewModel, now: number): number {
		if (this.full === undefined || this.branch.structural) this.rebuild(model, now);
		else if (this.seen < this.branch.entries.length) {
			const added = this.branch.entries.slice(this.seen);
			const chained = added.map((entry, i) => ({ ...entry, parentId: i === 0 ? null : added[i - 1]!.id }) as SessionEntry);
			const view = this.viewOf(chained, new Map(chained.map((entry) => [entry.id, entry])), model, now);
			for (const entry of view.entries) {
				this.extra.push(entry);
				this.extraTokens += entry.tokens;
			}
			this.seen = this.branch.entries.length;
			if (this.check) this.compare(model, now);
		}
		return this.full!.estimate + this.extraTokens;
	}

	private compare(model: ViewModel, now: number): void {
		const full = this.viewOf(this.branch.entries, this.branch.byId, model, now);
		const incremental = [...this.full!.view.entries, ...this.extra];
		const shape = (entries: readonly ViewEntry[]) => JSON.stringify(entries);
		if (shape(full.entries) !== shape(incremental)) throw new Error(`incremental view differs from a full build at branch length ${this.seen}`);
		if (JSON.stringify([full.folds, full.hides]) !== JSON.stringify([this.full!.view.folds, this.full!.view.hides])) throw new Error(`incremental folds or hides differ from a full build at branch length ${this.seen}`);
	}

	/** The request's view with its modeled size; fields only a full build gives are built when read. The cache age is read off the branch, as a full build reads it, so a stage that waits for a cold cache costs no full build. */
	view(model: ViewModel, now: number, tokens: number): ContextView {
		const branch = this.branch;
		const estimate = this.full!.estimate + this.extraTokens;
		let entries: readonly ViewEntry[] | undefined;
		const entriesNow = () => (entries ??= this.extra.length === 0 ? this.full!.view.entries : Object.freeze([...this.full!.view.entries, ...this.extra]));
		const current = () => this.full!.view;
		const full = () => this.materialize(model, now).view;
		return Object.freeze({
			get entries() {
				return entriesNow();
			},
			pressure: tokens / model.contextWindow,
			unownedTokens: tokens - estimate,
			get cacheAgeMs() {
				return cacheAgeMs(branch.entries, now);
			},
			model: Object.freeze({ id: model.id, contextWindow: model.contextWindow }),
			tools: Object.freeze(this.child ? [] : [...MAIN_TOOLS]),
			registeredTools: Object.freeze([...MAIN_TOOLS]),
			get folds() {
				return current().folds;
			},
			get hides() {
				return current().hides;
			},
			get protectedEntryIds() {
				return full().protectedEntryIds;
			},
			compactionOwner: "none",
		}) as ContextView;
	}
}

/**
 * A hint view that resolves each entry once. The simulated branch keeps one object per entry for the
 * whole replay, and an entry's hint depends only on the entry, so every full view build reuses it.
 */
function cachedHints(hints: FoldHintView): FoldHintView {
	const resolved = new WeakMap<object, ReturnType<FoldHintView["forEntry"]>>();
	return {
		forEntry: (entry) => {
			if (resolved.has(entry)) return resolved.get(entry);
			const hint = hints.forEntry(entry);
			resolved.set(entry, hint);
			return hint;
		},
		forMessage: (message) => hints.forMessage(message),
		verbatimTools: () => hints.verbatimTools(),
	};
}

/** Plans one stage may make on one request, one after another (see the stage loop in `replayOne`). A recorded replay is not capped: it applies every fold due on the request. */
const MAX_PLANS_PER_STAGE = 64;

/**
 * What the previous request already cached, by the bench's prefix model: everything before the first
 * entry whose content changed since then (`suffix`: estimated tokens from that entry on), only what no
 * entry owns after a compaction (`suffix`: every entry), or the whole previous request when nothing changed.
 */
type PrefixParts = { readonly suffix: number } | { readonly previous: number };

function prefixParts(branch: SimulatedBranch, view: ContextView, previous: { sent: number; say: number } | undefined): PrefixParts {
	if (branch.compacted) return { suffix: view.entries.reduce((sum, entry) => sum + entry.tokens, 0) };
	if (branch.changed.size > 0) {
		let first = Infinity;
		for (const id of branch.changed) first = Math.min(first, branch.position.get(id) ?? Infinity);
		return { suffix: view.entries.reduce((sum, entry) => sum + ((branch.position.get(entry.id) ?? Infinity) >= first ? entry.tokens : 0), 0) };
	}
	return { previous: previous ? previous.sent - previous.say : 0 };
}

/** Cached tokens of a request of `size` tokens, with estimated tokens scaled by `scale`. */
const cachedPrefix = (parts: PrefixParts, size: number, scale: number): number => ("suffix" in parts ? Math.max(0, Math.round(size - scale * parts.suffix)) : parts.previous);

function bucketOf(error: number): number {
	return Math.min(ERROR_BUCKETS - 1, Math.floor(error / BUCKET_WIDTH));
}

const bump = (counts: Record<string, number>, key: string, by = 1): void => {
	counts[key] = (counts[key] ?? 0) + by;
};

/**
 * Replay one strategy over a recording. `baseline` undefined runs the baseline pass: the recorded branch
 * as it is, no stages, measuring what strategies are anchored to.
 */
function replayOne(recording: Recording, bench: BenchRecipe | undefined, strategy: StrategySpec | undefined, facts: SessionFacts, models: readonly Model[], options: ReplayOptions, baseline: Baseline | undefined): { result: StrategyResult; baseline: Baseline } {
	const recipe: Recipe | undefined = bench?.recipe;
	const strip = new Set<number>(recipe ? recording.folds.flatMap((fold) => fold.entryIndexes) : []);
	const standIn = strategy?.mode === "stand-in";
	const recordedDue = new Map<number, RecordedFold[]>();
	for (const fold of recording.folds) recordedDue.set(fold.request, [...(recordedDue.get(fold.request) ?? []), fold]);
	// Output the recorded fold calls spent writing summaries a stand-in strategy does not replay.
	const strippedOutput = new Map<number, number>();
	if (standIn) for (const fold of recording.folds) strippedOutput.set(fold.request - 1, (strippedOutput.get(fold.request - 1) ?? 0) + defaultCountTokens(fold.summary));
	const branch = new SimulatedBranch();
	// The fold hints context-aware registers in every session; hints other extensions register are not known.
	const hints = cachedHints(createFoldHints());
	const views = new ViewBuilder(branch, options.child, hints, options.checkIncremental === true);
	let engines: { length: number; window: number; engine: SummarizeEngine } | undefined;
	const estimates: number[] = [];
	const prefixes: PrefixParts[] = [];
	const refusals: Record<string, number> = {};
	const histogram = new Array<number>(ERROR_BUCKETS).fill(0);
	const hideEvents: { request: number; ids: Set<string> }[] = [];
	let next = 0;
	let previous: { sent: number; say: number; model: string } | undefined;
	let start: { size: number; estimate: number } | undefined;
	const totals = { tokensSent: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sayTokens: 0, nudges: 0, folds: 0, compactions: 0, recordedCompactions: 0, compactionCallCost: 0, sizeDeltaAbs: 0, absError: 0, recorded: 0, unpriced: 0 };
	let cost = ZERO_COST;
	let extraOutput = 0;
	const compactionCall = (model: Model, before: number, summaryTokens: number) => {
		const call = priceRequest(model.priced, { input: before, cacheRead: 0, cacheWrite: 0, output: summaryTokens }, "input");
		totals.compactionCallCost += call.input + call.output;
	};

	recording.requests.forEach((request, ordinal) => {
		const model = models[ordinal]!;
		for (; next < request.pathIndex; next++) {
			if (strip.has(next)) continue;
			const entry = recording.path[next]!;
			branch.push(entry);
			if (entry.type === "compaction") {
				totals.recordedCompactions++;
				compactionCall(model, entry.tokensBefore, defaultCountTokens(entry.summary));
			}
		}
		const recordedSize = sentOf(request);
		// A request without recorded usage failed before the provider counted it: it costs nothing in any strategy.
		const failed = recordedSize === 0;
		const viewModel: ViewModel = { id: request.model, contextWindow: model.window };
		let estimate = views.estimate(viewModel, request.at);
		const sizeOf = (tokens: number): number => (baseline && !failed ? Math.max(0, Math.round(recordedSize + baseline.scale * (tokens - baseline.estimates[ordinal]!))) : recordedSize);
		let view = views.view(viewModel, request.at, sizeOf(estimate));
		let say = 0;
		const due = recordedDue.get(ordinal) ?? [];
		let dueIndex = 0;
		extraOutput = -(strippedOutput.get(ordinal) ?? 0);
		for (const stage of recipe?.stages ?? []) {
			const timing = stage.wants(view);
			if (timing === null) continue;
			if (timing === "at-boundary" && !request.turnStart) continue;
			if (timing === "when-cache-cold" && (view.cacheAgeMs === null || view.cacheAgeMs < options.coldCacheMs)) continue;
			// The stage plans again on the view its last plan left, until it plans nothing or repeats itself. The
			// bench checks one fold per plan, as the fold tool writes one block per range: `checkPlan` plans every
			// `summarize` of one plan on the same session, so two of them would get the same block id. A recorded
			// replay plans once per fold due on the request, without the cap: a session can record more than 64
			// folds at once, and two recorded folds can be written identically.
			// A queued stage (an external reply) instead hands over every plan it holds, each checked in order on
			// the view the one before left: an empty, say-only or repeated plan does not end it.
			const recorded = bench!.replaysRecorded;
			const queued = () => bench!.queuedPlans?.(stage.id);
			const draining = queued() !== undefined;
			let previousPlan = "";
			for (let round = 0; recorded ? dueIndex < due.length : round < MAX_PLANS_PER_STAGE && (!draining || queued()! > 0); round++) {
				const nudge = round === 0 ? stage.nudge?.(view) ?? null : null;
				const plan: ContextPlan = nudge ? [...stage.plan(view), nudge] : stage.plan(view);
				const planKey = JSON.stringify(plan);
				if (draining && plan.length === 0) continue;
				if (plan.length === 0 || (!recorded && !draining && planKey === previousPlan)) break;
				previousPlan = planKey;
				// The engine reads the whole branch: it is built again only once the branch has changed.
				const engine = (op: Parameters<SummarizeEngine>[0]) => {
					if (engines?.length !== branch.entries.length || engines.window !== model.window) engines = { length: branch.entries.length, window: model.window, engine: summarizeEngine({ branch: branch.entries, contextEntries: contextEntriesOf(branch.entries, branch.byId), modelContextLimit: model.window, hints }) };
					return engines.engine(op);
				};
				const check = checkPlan(view, plan, engine);
				if (recorded) {
					// A recorded fold applies as it was written, whatever today's check says: the refusals count the
					// recorded folds today's `checkPlan` would refuse. Re-planned folds would cover other entries
					// wherever the fold engine or its hints changed since the session was recorded.
					if (!check.ok) for (const refusal of check.refusals) bump(refusals, refusal.code);
					const fold = due[dueIndex++];
					if (fold === undefined) break;
					for (const index of fold.entryIndexes) branch.push(recording.path[index]!);
					totals.folds++;
					hideEvents.push({ request: ordinal, ids: new Set([fold.record.carrierId, ...fold.record.hiddenIds]) });
					estimate = views.estimate(viewModel, request.at);
					view = views.view(viewModel, request.at, sizeOf(estimate));
					continue;
				}
				if (!check.ok) {
					for (const refusal of check.refusals) bump(refusals, refusal.code);
					continue;
				}
				let changed = false;
				for (const effect of check.effects) {
					if (effect.kind === "say") {
						say += defaultCountTokens(effect.text);
						totals.nudges++;
					} else if (effect.kind === "stub") {
						const original = view.entries.find((entry) => entry.id === effect.entryId)?.tokens ?? 0;
						branch.add({ type: "context_edit", targetId: effect.entryId, replacement: { content: `${effect.text}\n${hidePointerLine(effect.hideId)}` } }, request.at);
						branch.add({ type: "custom", customType: HIDE_ENTRY_TYPE, data: { version: 1, hideId: effect.hideId, targetId: effect.entryId, originalTokens: original, createdAt: request.at } }, request.at);
						hideEvents.push({ request: ordinal, ids: new Set([effect.entryId]) });
						changed = true;
					} else {
						const op = plan[effect.op]!;
						const summary = op.kind === "summarize" && op.writer === "plan" ? op.summary : "";
						if (bench!.compactionStages.has(stage.id) && op.kind === "summarize") {
							const kept = branch.entries[(branch.position.get(op.endId) ?? branch.entries.length) + 1];
							if (!kept) continue;
							branch.add({ type: "compaction", summary, firstKeptEntryId: kept.id, tokensBefore: Math.round(view.pressure * model.window) }, request.at);
							totals.compactions++;
							compactionCall(model, Math.round(view.pressure * model.window), defaultCountTokens(summary));
						} else {
							for (const draft of effect.drafts) branch.add(draft as unknown as Record<string, unknown>, request.at);
							totals.folds += effect.records.length;
							for (const record of effect.records) hideEvents.push({ request: ordinal, ids: new Set([record.carrierId, ...record.hiddenIds]) });
							// The stand-in model writes the summary as output; a re-issued recorded fold's summary is already in the recorded output.
							if (standIn) extraOutput += defaultCountTokens(summary);
						}
						changed = true;
					}
				}
				if (!changed) {
					if (draining) continue;
					break;
				}
				estimate = views.estimate(viewModel, request.at);
				view = views.view(viewModel, request.at, sizeOf(estimate));
			}
		}
		for (const code of bench?.takeRefusals?.() ?? []) bump(refusals, code);

		const size = sizeOf(estimate);
		const sent = size + say;
		const cold = request.usage.cacheRead === 0 || (previous !== undefined && previous.model !== modelKey(request.provider, request.model));
		const parts = prefixParts(branch, view, previous);
		const read = baseline && !cold
			? Math.min(sent, Math.max(0, request.usage.cacheRead + cachedPrefix(parts, size, baseline.scale) - cachedPrefix(baseline.prefixes[ordinal]!, recordedSize, baseline.scale)))
			: baseline ? 0 : request.usage.cacheRead;
		const input = baseline ? Math.min(request.usage.input, sent - read) : request.usage.input;
		const write = sent - read - input;
		const output = Math.max(0, request.usage.output + extraOutput);
		estimates.push(estimate);
		prefixes.push(parts);
		// A failed request cached nothing: the next request's cached prefix is still the last one with usage,
		// and changes made since that one still count against it (CR-BENCH-FAILED-REQUEST-PREFIX).
		if (!failed) {
			branch.changed = new Set();
			branch.compacted = false;
			previous = { sent, say, model: modelKey(request.provider, request.model) };
		}

		totals.tokensSent += sent;
		totals.input += input;
		totals.cacheRead += read;
		totals.cacheWrite += write;
		totals.output += output;
		totals.sayTokens += say;
		totals.sizeDeltaAbs += Math.abs(size - recordedSize);
		if (!model.priced) totals.unpriced++;
		cost = addCost(cost, priceRequest(model.priced, { input, cacheRead: read, cacheWrite: write, cacheWrite1h: request.usage.cacheWrite1h > 0 ? write : 0, output }, model.write));
		// The bench's own estimate: the first request with usage, plus the scaled growth of the view's entries since.
		if (!failed) start ??= { size: recordedSize, estimate };
		const own = start ? Math.round(start.size + (baseline?.scale ?? 1) * (estimate - start.estimate)) : 0;
		options.trace?.(strategy?.id ?? "baseline", ordinal, { size, estimate: own, cacheRead: read, cacheWrite: write, input, sayTokens: say }, branch.entries);
		if (!failed) {
			const error = Math.abs(own - recordedSize);
			histogram[bucketOf(error / recordedSize)]!++;
			totals.absError += error;
			totals.recorded += recordedSize;
		}
		if (next === request.pathIndex) {
			branch.push(recording.path[next]!);
			next++;
		}
	});

	const targets = recallTargets(recording);
	const recalled = hideEvents.filter((hide) => targets.some((recall) => recall.request >= hide.request && recall.request < hide.request + options.recallWindow && recall.ids.some((id) => hide.ids.has(id)))).length;
	const sortedRefusals: Record<string, number> = {};
	for (const code of Object.keys(refusals).sort()) sortedRefusals[code] = refusals[code]!;
	return {
		result: {
			requests: recording.requests.length,
			tokensSent: totals.tokensSent,
			input: totals.input,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			output: totals.output,
			sayTokens: totals.sayTokens,
			nudges: totals.nudges,
			folds: totals.folds,
			compactions: totals.compactions,
			recordedCompactions: totals.recordedCompactions,
			refusals: sortedRefusals,
			cost,
			compactionCallCost: totals.compactionCallCost,
			hides: hideEvents.length,
			recalledWithinWindow: recalled,
			sizeDeltaAbs: totals.sizeDeltaAbs,
			estimate: { histogram, absError: totals.absError, recorded: totals.recorded },
			unpricedRequests: totals.unpriced,
		},
		baseline: { estimates, prefixes, scale: tokenScale(recording.requests.map(sentOf), estimates).value },
	};
}

/** The entries each recorded `context_recall` by reference asked for: a fold's covered entries, or a hide's target. */
function recallTargets(recording: Recording): { request: number; ids: string[] }[] {
	return recording.recalls.flatMap((recall) => {
		const hide = recording.hides.get(recall.ref);
		if (hide !== undefined) return [{ request: recall.request, ids: [hide] }];
		const fold = [...recording.folds].reverse().find((candidate) => candidate.record.blockId === recall.ref && candidate.request <= recall.request + 1);
		return fold ? [{ request: recall.request, ids: [fold.record.carrierId, ...fold.record.hiddenIds] }] : [];
	});
}

/** Replay every strategy over one recording. */
export function replaySession(recording: Recording, strategies: readonly StrategySpec[], options: ReplayOptions): SessionResult {
	const usedModels: Record<string, { pricedAs: string | null; requests: number }> = {};
	const writesBilled = new Set(recording.requests.filter((request) => request.usage.cacheWrite > 0).map((request) => modelKey(request.provider, request.model)));
	const models = recording.requests.map((request): Model => {
		const key = modelKey(request.provider, request.model);
		const priced = options.prices.lookup(request.provider, request.model);
		const used = (usedModels[key] ??= { pricedAs: priced?.pricedAs ?? null, requests: 0 });
		used.requests++;
		return { priced, window: priced && priced.contextWindow > 0 ? priced.contextWindow : FALLBACK_CONTEXT_WINDOW, write: writesBilled.has(key) ? "cache-write" : "input" };
	});
	const facts = sessionFacts(recording, options);
	const base = replayOne(recording, undefined, undefined, facts, models, options, undefined);
	const results = strategies.map((strategy) => replayOne(recording, strategy.build(facts), strategy, facts, models, options, base.baseline).result);

	let recordedCost = ZERO_COST;
	const recorded = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, piCost: 0 };
	recording.requests.forEach((request, ordinal) => {
		const model = models[ordinal]!;
		recorded.input += request.usage.input;
		recorded.cacheRead += request.usage.cacheRead;
		recorded.cacheWrite += request.usage.cacheWrite;
		recorded.output += request.usage.output;
		recorded.piCost += request.piCost;
		recordedCost = addCost(recordedCost, priceRequest(model.priced, { input: request.usage.input, cacheRead: request.usage.cacheRead, cacheWrite: request.usage.cacheWrite, cacheWrite1h: request.usage.cacheWrite1h, output: request.usage.output }, model.write));
	});
	let otherCost = ZERO_COST;
	let otherPiCost = 0;
	for (const request of recording.other) {
		const key = modelKey(request.provider, request.model);
		const priced = options.prices.lookup(request.provider, request.model);
		const used = (usedModels[key] ??= { pricedAs: priced?.pricedAs ?? null, requests: 0 });
		used.requests++;
		otherCost = addCost(otherCost, priceRequest(priced, { input: request.usage.input, cacheRead: request.usage.cacheRead, cacheWrite: request.usage.cacheWrite, cacheWrite1h: request.usage.cacheWrite1h, output: request.usage.output }, request.usage.cacheWrite > 0 ? "cache-write" : "input"));
		otherPiCost += request.piCost;
	}
	return {
		sessionId: recording.sessionId,
		child: options.child,
		requests: recording.requests.length,
		recorded: { ...recorded, cost: recordedCost, folds: recording.folds.length, compactions: recording.compactions.length, recalls: recording.recalls.length },
		other: { requests: recording.other.length, cost: otherCost, piCost: otherPiCost },
		strategies: results,
		models: usedModels,
		tokenScale: tokenScale(recording.requests.map(sentOf), base.baseline.estimates),
		fidelity: sessionFidelity(recording, estimateError(recording.requests.map(sentOf), base.baseline.estimates, base.baseline.scale)),
	};
}