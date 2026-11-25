/**
 * The strategy bench's report (pi-context-aware#469): totals per strategy over the corpus, as JSON, and a
 * Markdown rendering of that JSON. Both are deterministic (REQ-STRAT-006): sessions are summed in corpus
 * order, objects are built with a fixed key order, dollars are rounded, and nothing records the time of
 * the run or the machine it ran on.
 */

import { STRATEGY_CONTRACT_VERSION } from "../../strategy/contract.js";
import { ZERO_COST, type Cost, type PriceSource } from "./pricing.js";
import type { BenchOptions, StrategySpec } from "./recipes.js";
import { ERROR_BUCKETS, MAX_ESTIMATE_ERROR, type SessionResult, type StrategyResult, type UnmodelledReason } from "./replay.js";

/** 2: the strategy and recorded totals hold modelled sessions only; sessions the bench cannot model are under `unmodelled`. */
export const REPORT_VERSION = 2;

/** What the report does not measure; printed in both forms. */
export const NOT_MEASURED: readonly string[] = [
	"Quality: whether a fold or compaction lost something the model needed, and whether the task succeeded. Tier 1 judges cost, not quality.",
	"Latency and wall time, including the time a compaction's summarizer call takes.",
	"What a strategy would change downstream: every response, tool call and output token is the recorded one. A session that folded differently would have gone differently.",
	"The stand-in model: it folds on every nudge it can act on, takes every foldable range at once, and writes a mechanical summary of recorded length. Real models ignore nudges, pick ranges and write summaries of varying length, so stand-in fold counts and savings are upper bounds on what the trigger allows, not predictions of what a model does.",
	"Recorded nudges: session files do not store nudges, so the nudges the recorded sessions saw stay inside every strategy's request sizes. Differences between strategies come from the modeled nudges and folds only.",
	"Tier-2 and tier-3 distillation nudges and the emergency truncation step; only the tier-1 growth nudge and its over-limit band are modeled.",
	"Sessions with images: on a synthetic session whose tool results carry images, the kernel's own fold pass showed no nudge where the stand-in nudge showed four. The cause is not known, so stand-in folding may be overstated on image-heavy sessions.",
	"Model-chosen compactions: recorded compactions replay as recorded in every strategy.",
	"Exact token counts: sizes come from the recorded usage plus differences estimated at about four characters per token, scaled by each session's recorded tokens per estimated token. The scale is fitted on the same requests it is applied to; where the fit fails it falls back to 1 (see Token scale).",
	"Provider cache rules: one cached-prefix model serves every provider. Everything before the first entry that changed since the last request with usage is a cache read. Anthropic reads only at cache breakpoints, about 20 blocks back, and OpenAI caches in 128-token steps from 1,024 tokens; neither is modeled, so the rewrite after a fold far back in the context may be understated.",
	"Recall after hides the recording did not make: recall-after-hide counts recorded `context_recall` calls for entries the recording also hid. For a strategy that hides other entries it is a lower bound, near zero by construction, not evidence that its hides were safe.",
	"Re-planned recorded folds: `folds-v1/recorded` applies each recorded fold as it was written. Its refusals count the recorded folds today's `checkPlan` would refuse. Folds re-planned by today's engine cover other entries wherever the engine or its hints changed since the session was recorded: on one 1,809-request session with tier-2 folds, re-planned folds drifted from the recorded sizes by 11 to 18% on average and up to 51% on one request.",
	"Fold hints other extensions register: only context-aware's built-in hints apply, so a stand-in fold may take an entry another extension's hint kept out of folds.",
	"Cache expiry beyond the recording: a request whose recorded cache read was zero is cold in every strategy; otherwise reads move with the modeled cached prefix.",
	"Requests off the active branch and cache-warming calls: counted as recorded, the same in every strategy.",
	"What a stub costs the model in `mask-then-fold` and `trim-then-fold`: every response is the recorded one, so no strategy here makes the model recall a stubbed result or run a tool again to see it. Their recall-after-hide is near zero by construction.",
	"Folds after a stub: a stubbed tool result ends a run the stand-in model can fold, so the `folds-v1` stages of `mask-then-fold` and `trim-then-fold` fold less than they would over the same entries unstubbed.",
	"Repeated tool output in `trim-then-fold` is found by comparing the recorded content of tool results; a result a recorded context edit changed (an image stripped, for instance) is compared as it was recorded.",
];

export interface CorpusSummary {
	readonly label: string;
	/** Session files with at least one request before the cutoff. */
	readonly sessions: number;
	readonly mainSessions: number;
	readonly childSessions: number;
	readonly requests: number;
}

export interface ReportInput {
	readonly corpus: readonly CorpusSummary[];
	readonly slice: { readonly since: string | null; readonly until: string | null };
	readonly price: PriceSource;
	readonly options: BenchOptions & { readonly recallWindow: number; readonly coldCacheMs: number };
	readonly summarySizes: { readonly foldSummaryChars: number; readonly compactionSummaryChars: number };
	readonly strategies: readonly StrategySpec[];
	/** Every session's results, added as they arrived. */
	readonly totals: SessionTotals;
	/** Session files the run left out, and why. */
	readonly skipped: readonly SkippedSession[];
	/** Nudges from metrics records, when the run read them: sessions with records and nudges by kind. */
	readonly metrics?: { readonly sessions: number; readonly nudges: Readonly<Record<string, number>> };
}

export interface SkippedSession {
	/** `<corpus label>/<path in the corpus>` */
	readonly file: string;
	readonly bytes: number;
	readonly reason: string;
}

/**
 * Totals hold dollars as whole nanodollars, so they are integers and their sum does not depend on the
 * order sessions are added in: sessions stream in as workers finish them (REQ-STRAT-006).
 */
const NANO = 1e9;
const nano = (value: number): number => Math.round(value * NANO);
const addNano = (a: Cost, b: Cost): Cost => ({ input: a.input + nano(b.input), cacheRead: a.cacheRead + nano(b.cacheRead), cacheWrite: a.cacheWrite + nano(b.cacheWrite), output: a.output + nano(b.output) });
const dollars = (value: number): number => Math.round(value * 10_000) / 10_000;
const fromNano = (value: number): number => dollars(value / NANO);
const ratio = (value: number): number => Math.round(value * 10_000) / 10_000;
const costOut = (cost: Cost) => {
	const total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
	return { input: fromNano(cost.input), cacheRead: fromNano(cost.cacheRead), cacheWrite: fromNano(cost.cacheWrite), output: fromNano(cost.output), total: fromNano(total) };
};

interface StrategyTotals {
	sessions: number;
	requests: number;
	tokensSent: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	sayTokens: number;
	nudges: number;
	folds: number;
	compactions: number;
	recordedCompactions: number;
	refusals: Record<string, number>;
	cost: Cost;
	compactionCallCost: number;
	hides: number;
	recalledWithinWindow: number;
	sizeDeltaAbs: number;
	recordedTokens: number;
	estimateAbsError: number;
	histogram: number[];
	unpricedRequests: number;
}

function emptyTotals(): StrategyTotals {
	return { sessions: 0, requests: 0, tokensSent: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, sayTokens: 0, nudges: 0, folds: 0, compactions: 0, recordedCompactions: 0, refusals: {}, cost: ZERO_COST, compactionCallCost: 0, hides: 0, recalledWithinWindow: 0, sizeDeltaAbs: 0, recordedTokens: 0, estimateAbsError: 0, histogram: new Array<number>(ERROR_BUCKETS).fill(0), unpricedRequests: 0 };
}

function addResult(totals: StrategyTotals, result: StrategyResult): void {
	totals.sessions++;
	totals.requests += result.requests;
	totals.tokensSent += result.tokensSent;
	totals.input += result.input;
	totals.cacheRead += result.cacheRead;
	totals.cacheWrite += result.cacheWrite;
	totals.output += result.output;
	totals.sayTokens += result.sayTokens;
	totals.nudges += result.nudges;
	totals.folds += result.folds;
	totals.compactions += result.compactions;
	totals.recordedCompactions += result.recordedCompactions;
	for (const [code, n] of Object.entries(result.refusals)) totals.refusals[code] = (totals.refusals[code] ?? 0) + n;
	totals.cost = addNano(totals.cost, result.cost);
	totals.compactionCallCost += nano(result.compactionCallCost);
	totals.hides += result.hides;
	totals.recalledWithinWindow += result.recalledWithinWindow;
	totals.sizeDeltaAbs += result.sizeDeltaAbs;
	totals.recordedTokens += result.estimate.recorded;
	totals.estimateAbsError += result.estimate.absError;
	result.estimate.histogram.forEach((n, bucket) => {
		totals.histogram[bucket] = (totals.histogram[bucket] ?? 0) + n;
	});
	totals.unpricedRequests += result.unpricedRequests;
}

/** The upper edge of the histogram bucket holding quantile `q`, as a fraction; null for an empty histogram. */
function quantile(histogram: readonly number[], q: number): number | null {
	const total = histogram.reduce((sum, n) => sum + n, 0);
	if (total === 0) return null;
	let seen = 0;
	for (let bucket = 0; bucket < histogram.length; bucket++) {
		seen += histogram[bucket]!;
		if (seen >= q * total) return ratio(bucket === histogram.length - 1 ? 1 : (bucket + 1) * 0.005);
	}
	return 1;
}

function totalsOut(totals: StrategyTotals) {
	const refusals: Record<string, number> = {};
	for (const code of Object.keys(totals.refusals).sort()) refusals[code] = totals.refusals[code]!;
	const cost = costOut(totals.cost);
	return {
		sessions: totals.sessions,
		requests: totals.requests,
		nudges: totals.nudges,
		nudgeTokens: totals.sayTokens,
		folds: totals.folds,
		compactions: { strategy: totals.compactions, recorded: totals.recordedCompactions },
		refusals,
		tokensSent: totals.tokensSent,
		uncachedInput: totals.input,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		output: totals.output,
		cost: { ...cost, compactionCalls: fromNano(totals.compactionCallCost), total: fromNano(totals.cost.input + totals.cost.cacheRead + totals.cost.cacheWrite + totals.cost.output + totals.compactionCallCost) },
		recallAfterHide: { hides: totals.hides, recalledWithinWindow: totals.recalledWithinWindow },
		replay: {
			/** Mean |modeled size - recorded size| over recorded size. */
			sizeDelta: totals.recordedTokens > 0 ? ratio(totals.sizeDeltaAbs / totals.recordedTokens) : null,
			estimateError: {
				mean: totals.recordedTokens > 0 ? ratio(totals.estimateAbsError / totals.recordedTokens) : null,
				p50: quantile(totals.histogram, 0.5),
				p90: quantile(totals.histogram, 0.9),
			},
		},
		unpricedRequests: totals.unpricedRequests,
	};
}

export type StrategyTotalsOut = ReturnType<typeof totalsOut>;

interface RecordedTotals {
	sessions: number;
	requests: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	piCost: number;
	folds: number;
	compactions: number;
	recalls: number;
	cost: Cost;
}

const emptyRecorded = (): RecordedTotals => ({ sessions: 0, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, piCost: 0, folds: 0, compactions: 0, recalls: 0, cost: ZERO_COST });

function addRecorded(sum: RecordedTotals, session: SessionResult): void {
	sum.sessions++;
	sum.requests += session.requests;
	sum.input += session.recorded.input;
	sum.cacheRead += session.recorded.cacheRead;
	sum.cacheWrite += session.recorded.cacheWrite;
	sum.output += session.recorded.output;
	sum.piCost += nano(session.recorded.piCost);
	sum.folds += session.recorded.folds;
	sum.compactions += session.recorded.compactions;
	sum.recalls += session.recorded.recalls;
	sum.cost = addNano(sum.cost, session.recorded.cost);
}

function recordedOut(sum: RecordedTotals) {
	const { cost, piCost, ...counts } = sum;
	return { ...counts, tokensSent: sum.input + sum.cacheRead + sum.cacheWrite, piCost: fromNano(piCost), cost: costOut(cost) };
}

/** Token-scale histogram: buckets of 0.05 from 0.5 (the lowest fitted scale) to 3, the highest. */
const SCALE_BUCKETS = 51;
const scaleBucket = (scale: number): number => Math.min(SCALE_BUCKETS - 1, Math.max(0, Math.floor((scale - 0.5) / 0.05)));

type SessionClass = "all" | "main" | "child";
const CLASSES: readonly SessionClass[] = ["all", "main", "child"];
/** Sessions whose recorded sizes follow their branch, and the rest (`SessionFidelity` in replay.ts). */
type SessionGroup = "modelled" | "unmodelled";

const byClass = <T>(make: () => T): Record<SessionClass, T> => ({ all: make(), main: make(), child: make() });

/**
 * The report's totals, built one session at a time so a run holds no session's results after adding
 * them. Every sum is an integer, so the order sessions are added in does not change the report.
 */
export class SessionTotals {
	readonly strategies: Record<SessionGroup, Record<SessionClass, StrategyTotals>>[];
	readonly recorded: Record<SessionGroup, Record<SessionClass, RecordedTotals>> = { modelled: byClass(emptyRecorded), unmodelled: byClass(emptyRecorded) };
	/** Unmodelled sessions by reason; a session with several reasons counts under each. */
	readonly reasons: Record<UnmodelledReason, number> = { "another-context-manager": 0, "usage-only-log": 0, "estimate-error": 0 };
	readonly models = new Map<string, { pricedAs: string | null; requests: number }>();
	readonly other = { requests: 0, cost: ZERO_COST, piCost: 0 };
	/** Sessions whose token scale fell back to 1, and a histogram of the fitted ones. */
	readonly scale = { fellBack: 0, histogram: new Array<number>(SCALE_BUCKETS).fill(0) };

	constructor(strategyCount: number) {
		this.strategies = Array.from({ length: strategyCount }, () => ({ modelled: byClass(emptyTotals), unmodelled: byClass(emptyTotals) }));
	}

	add(session: SessionResult): void {
		const classes: SessionClass[] = ["all", session.child ? "child" : "main"];
		const group: SessionGroup = session.fidelity.modelled ? "modelled" : "unmodelled";
		session.strategies.forEach((result, index) => {
			for (const cls of classes) addResult(this.strategies[index]![group][cls], result);
		});
		for (const cls of classes) addRecorded(this.recorded[group][cls], session);
		for (const reason of session.fidelity.reasons) this.reasons[reason]++;
		for (const [model, used] of Object.entries(session.models)) {
			const known = this.models.get(model) ?? { pricedAs: used.pricedAs, requests: 0 };
			known.requests += used.requests;
			this.models.set(model, known);
		}
		this.other.requests += session.other.requests;
		this.other.cost = addNano(this.other.cost, session.other.cost);
		this.other.piCost += nano(session.other.piCost);
		if (session.tokenScale.fitted) this.scale.histogram[scaleBucket(session.tokenScale.value)]!++;
		else this.scale.fellBack++;
	}
}

/** The upper edge of the token-scale bucket holding quantile `q`; null when no session fitted a scale. */
function scaleQuantile(histogram: readonly number[], q: number): number | null {
	const total = histogram.reduce((sum, n) => sum + n, 0);
	if (total === 0) return null;
	let seen = 0;
	for (let bucket = 0; bucket < histogram.length; bucket++) {
		seen += histogram[bucket]!;
		if (seen >= q * total) return ratio(Math.min(3, 0.5 + (bucket + 1) * 0.05));
	}
	return 3;
}

export function buildReport(input: ReportInput) {
	const totals = input.totals;
	const strategies = input.strategies.map((strategy, index) => {
		const out = (group: SessionGroup) => Object.fromEntries(CLASSES.map((cls) => [cls, totalsOut(totals.strategies[index]![group][cls])])) as Record<SessionClass, StrategyTotalsOut>;
		// all, main and child hold modelled sessions only: the tables a strategy comparison reads.
		return { id: strategy.id, recipe: strategy.recipe, mode: strategy.mode, params: strategy.params, ...out("modelled"), unmodelled: out("unmodelled") };
	});
	const recordedOf = (group: SessionGroup) => ({ all: recordedOut(totals.recorded[group].all), main: recordedOut(totals.recorded[group].main), child: recordedOut(totals.recorded[group].child) });
	const modelList = [...totals.models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const fitted = totals.scale.histogram.reduce((sum, n) => sum + n, 0);
	return {
		report: "pi-context-aware strategy bench",
		reportVersion: REPORT_VERSION,
		tier: 1,
		judges: "cost, not quality",
		contractVersion: STRATEGY_CONTRACT_VERSION,
		corpus: { slice: input.slice, hosts: input.corpus },
		pricing: {
			source: input.price,
			priced: modelList.filter(([, used]) => used.pricedAs !== null).map(([model, used]) => ({ model, pricedAs: used.pricedAs, requests: used.requests })),
			unpriced: modelList.filter(([, used]) => used.pricedAs === null).map(([model, used]) => ({ model, requests: used.requests })),
		},
		options: input.options,
		summarySizes: input.summarySizes,
		sessionGroups: {
			maxEstimateError: MAX_ESTIMATE_ERROR,
			modelled: { sessions: totals.recorded.modelled.all.sessions, requests: totals.recorded.modelled.all.requests },
			unmodelled: { sessions: totals.recorded.unmodelled.all.sessions, requests: totals.recorded.unmodelled.all.requests, reasons: { ...totals.reasons } },
		},
		recorded: {
			...recordedOf("modelled"),
			unmodelled: recordedOf("unmodelled"),
			other: { requests: totals.other.requests, cost: costOut(totals.other.cost), piCost: fromNano(totals.other.piCost) },
			metrics: input.metrics ?? null,
		},
		tokenScale: { fitted, fellBackToOne: totals.scale.fellBack, p10: scaleQuantile(totals.scale.histogram, 0.1), p50: scaleQuantile(totals.scale.histogram, 0.5), p90: scaleQuantile(totals.scale.histogram, 0.9) },
		skipped: input.skipped,
		strategies,
		notMeasured: NOT_MEASURED,
	};
}

export type Report = ReturnType<typeof buildReport>;

/** The report as JSON text: two-space indent and a final newline. */
export function reportJson(report: Report): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}

const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const signed = (n: number, base: number): string => (base === 0 ? "n/a" : `${n >= base ? "+" : ""}${(((n - base) / base) * 100).toFixed(1)}%`);
const cell = (text: string): string => text.replace(/[|\r\n]/gu, " ");

type StrategyRow = Report["strategies"][number];

function strategyTable(report: Report, pick: (strategy: StrategyRow) => StrategyTotalsOut): string[] {
	const found = report.strategies.find((s) => s.id === "folds-v1/growth-50k");
	const current = found && pick(found);
	const rows = [
		"| Strategy | Nudges | Folds | Compactions (strategy + recorded) | Tokens sent | Cache read | Cache write | Output | Cost | vs growth-50k |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const strategy of report.strategies) {
		const t = pick(strategy);
		const nudges = strategy.mode === "recorded" ? "not recorded" : int(t.nudges);
		rows.push(`| ${cell(strategy.id)} | ${nudges} | ${int(t.folds)} | ${int(t.compactions.strategy)} + ${int(t.compactions.recorded)} | ${int(t.tokensSent)} | ${int(t.cacheRead)} | ${int(t.cacheWrite)} | ${int(t.output)} | ${usd(t.cost.total)} | ${current ? signed(t.cost.total, current.cost.total) : "n/a"} |`);
	}
	return rows;
}

/** The Markdown rendering of a report. Every figure comes from the JSON. */
export function reportMarkdown(report: Report): string {
	const lines: string[] = [];
	const push = (...more: string[]) => lines.push(...more);
	const rec = report.recorded.all;
	push("# Strategy bench report (tier 1: cost, not quality)", "");
	push(`Report version ${report.reportVersion}, strategy contract version ${report.contractVersion}. Offline replay of recorded Pi sessions; no model was called.`, "");
	push("## Corpus slice", "");
	push(`Session files modified since ${report.corpus.slice.since ?? "any time"}; entries stamped up to ${report.corpus.slice.until ?? "the end of each file"}. Each session replays its active branch (the path to its last entry).`, "");
	push("| Host | Sessions | Main | Child | Requests |", "| --- | ---: | ---: | ---: | ---: |");
	for (const host of report.corpus.hosts) push(`| ${cell(host.label)} | ${int(host.sessions)} | ${int(host.mainSessions)} | ${int(host.childSessions)} | ${int(host.requests)} |`);
	push("", "## Pricing", "");
	push(`Prices per million tokens from \`${report.pricing.source.package}\` ${report.pricing.source.version} (model data generated ${report.pricing.source.modelDataGeneratedAt ?? "at an unstated time"}). Cache reads, cache writes, uncached input and output are priced separately; long-context tiers apply by request size. A model whose provider bills no cache writes has its written tokens priced as input.`, "");
	if (report.pricing.unpriced.length > 0) {
		push("Models the registry does not price (their requests cost nothing in the totals):", "");
		for (const model of report.pricing.unpriced) push(`- \`${cell(model.model)}\`: ${int(model.requests)} requests`);
		push("");
	}
	const groups = report.sessionGroups;
	const unmodelled = report.recorded.unmodelled.all;
	push("## Session groups", "");
	push(`A strategy's request size is the recorded size plus the scaled difference between its view and the recorded branch's view. That holds only where the recorded requests carried what the branch holds. Sessions where they did not are reported apart, in "Sessions the bench cannot model", and are left out of every other table: there a fold is credited with tokens the recording never sent, which favours growth-triggered folding over usage floors.`, "");
	push("| Group | Sessions | Main | Child | Requests |", "| --- | ---: | ---: | ---: | ---: |");
	push(`| Modelled | ${int(groups.modelled.sessions)} | ${int(report.recorded.main.sessions)} | ${int(report.recorded.child.sessions)} | ${int(groups.modelled.requests)} |`);
	push(`| Not modelled | ${int(groups.unmodelled.sessions)} | ${int(report.recorded.unmodelled.main.sessions)} | ${int(report.recorded.unmodelled.child.sessions)} | ${int(groups.unmodelled.requests)} |`, "");
	push(`Why sessions are not modelled (a session can have several reasons): billion-context-pi folded in it, so its folds are in a side file and not on the branch: ${int(groups.unmodelled.reasons["another-context-manager"])}; a usage log with no user message or tool result (Fabric worker logs): ${int(groups.unmodelled.reasons["usage-only-log"])}; the bench's own estimate off from the recorded sizes by more than ${pct(groups.maxEstimateError)} over the session: ${int(groups.unmodelled.reasons["estimate-error"])}.`, "");
	push("## Recorded", "");
	push("Modelled sessions:", "");
	push(`${int(rec.requests)} requests in ${int(rec.sessions)} sessions sent ${int(rec.tokensSent)} tokens: ${int(rec.cacheRead)} cache reads, ${int(rec.cacheWrite)} cache writes, ${int(rec.input)} uncached input; ${int(rec.output)} output. Registry price ${usd(rec.cost.total)}; Pi's recorded cost ${usd(rec.piCost)}. ${int(rec.folds)} folds, ${int(rec.compactions)} compactions, ${int(rec.recalls)} \`context_recall\` calls by reference.`, "");
	push(`Requests off the active branch and cache-warming calls, the same in every strategy: ${int(report.recorded.other.requests)}, ${usd(report.recorded.other.cost.total)}.`, "");
	push(`Sessions the bench cannot model: ${int(unmodelled.requests)} requests in ${int(unmodelled.sessions)} sessions sent ${int(unmodelled.tokensSent)} tokens; registry price ${usd(unmodelled.cost.total)}; Pi's recorded cost ${usd(unmodelled.piCost)}.`, "");
	if (report.recorded.metrics) push(`Metrics records cover ${int(report.recorded.metrics.sessions)} sessions; nudges they recorded: ${Object.entries(report.recorded.metrics.nudges).map(([kind, n]) => `${kind} ${int(n)}`).join(", ") || "none"}.`, "");
	for (const cls of ["all", "main", "child"] as const) {
		push("", `## Strategies: modelled ${cls === "all" ? "sessions" : cls === "main" ? "main sessions" : "Fabric worker and subagent sessions"}`, "");
		push(...strategyTable(report, (strategy) => strategy[cls]));
	}
	push("", "Cost includes the modeled summarizer calls behind compactions, recorded and the strategy's own, so the `folds-v1/recorded` row costs more than the recorded registry price by the recorded compactions' modeled calls. Nudge tokens are included in tokens sent.", "");
	push("## Sessions the bench cannot model", "");
	push("Do not compare strategies on these rows: their request sizes add view differences to recorded sizes that do not follow the branch, so a fold can be credited with tokens the recording never sent. They are listed so every recorded session is accounted for.", "");
	push(...strategyTable(report, (strategy) => strategy.unmodelled.all));
	push("");
	push("## Refusals by code (all sessions)", "");
	push("For `folds-v1/recorded`, the recorded folds today's `checkPlan` would refuse; each is applied as recorded all the same.", "");
	for (const strategy of report.strategies) {
		const codes = Object.entries(strategy.all.refusals);
		push(`- ${cell(strategy.id)}: ${codes.length === 0 ? "none" : codes.map(([code, n]) => `\`${code}\` ${int(n)}`).join(", ")}`);
	}
	push("", `## Recall after hide (within ${report.options.recallWindow} requests, from recorded \`context_recall\` calls)`, "");
	push(`A hide counts as recalled when the response to a request in [h, h + ${report.options.recallWindow}) calls \`context_recall\` for one of its entries, where h is the first request the hide applies to. For strategies that hide entries the recording did not, this is a lower bound.`, "");
	for (const strategy of report.strategies) push(`- ${cell(strategy.id)}: ${int(strategy.all.recallAfterHide.recalledWithinWindow)} of ${int(strategy.all.recallAfterHide.hides)} hides`);
	push("", "## Replay fidelity", "");
	const recorded = report.strategies.find((s) => s.mode === "recorded");
	if (recorded) {
		const folds = recorded.all.folds + recorded.unmodelled.all.folds;
		const recordedFolds = report.recorded.all.folds + report.recorded.unmodelled.all.folds;
		push(`\`${recorded.id}\` checks every recorded fold with \`checkPlan\` and applies it as written: ${int(folds)} of the ${int(recordedFolds)} recorded folds in all sessions; a fold recorded after a session's last request applies to none. It replays the recorded branch, so its request sizes equal the recorded ones by construction (${pct(recorded.all.replay.sizeDelta)} apart on modelled sessions): that checks the replay of recorded folds, not the pricing of view differences.`, "");
		push(`The bench's own estimate is the first request's size plus the scaled growth of the view's entries. Strategy figures add exactly such view differences to recorded sizes, so its error bounds how far they can be trusted. Off from recorded usage on average, and per request at p50 and p90:`, "");
		push("| Sessions | Mean | p50 | p90 |", "| --- | ---: | ---: | ---: |");
		const errorRow = (label: string, t: StrategyTotalsOut) => push(`| ${label} | ${pct(t.replay.estimateError.mean)} | ${pct(t.replay.estimateError.p50)} | ${pct(t.replay.estimateError.p90)} |`);
		errorRow("Modelled, all", recorded.all);
		errorRow("Modelled, main", recorded.main);
		errorRow("Modelled, child", recorded.child);
		errorRow("Not modelled, all", recorded.unmodelled.all);
		errorRow("Not modelled, main", recorded.unmodelled.main);
		errorRow("Not modelled, child", recorded.unmodelled.child);
		push("");
	}
	const scale = report.tokenScale;
	push(`Token scale (recorded tokens per estimated token, fitted per session): p10 ${scale.p10 ?? "n/a"}, p50 ${scale.p50 ?? "n/a"}, p90 ${scale.p90 ?? "n/a"} over ${int(scale.fitted)} sessions; ${int(scale.fellBackToOne)} sessions had too little growth to fit, or a fit outside [0.5, 3], and use 1.`, "");
	push(`Stand-in summaries: the session's median recorded size, else ${int(report.summarySizes.foldSummaryChars)} characters per fold and ${int(report.summarySizes.compactionSummaryChars)} per compaction (corpus medians). Stand-in nudge: ${int(report.options.nudgeTokens)} tokens.`, "");
	if (report.skipped.length > 0) {
		push("", "## Sessions not replayed", "");
		for (const skipped of report.skipped) push(`- \`${cell(skipped.file)}\` (${int(skipped.bytes)} bytes): ${cell(skipped.reason)}`);
	}
	push("", "## Not measured", "");
	for (const item of report.notMeasured) push(`- ${item}`);
	return `${lines.join("\n")}\n`;
}
