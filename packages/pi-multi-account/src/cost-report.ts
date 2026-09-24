import type { AccountRateRecord } from "./account-rate-history.js";
import type { PiCatalogSnapshot } from "./api-pricing.js";
import {
	planClosedCostDigests,
	selectNonOverlappingDigestRows,
	type CostCoverage,
	type CostDigestRow,
	type CostHistoryGap,
	type CostObservation,
} from "./cost-digest.js";
import {
	enumerateCompletedPeriods,
	getPeriodBounds,
	splitAtUtcMonthBoundaries,
	type PeriodBounds,
	type PeriodType,
} from "./period-boundaries.js";
import type { PricingCacheResult } from "./pricing-cache.js";

export interface CostReportTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h: number;
}

export type CostReportApiEquivalent =
	| {
			readonly status: "priced";
			readonly estimatedUsd: number;
			readonly rateAsOfMs: readonly number[];
	  }
	| {
			readonly status: "unpriced";
			readonly reasons: readonly string[];
			readonly rateAsOfMs: readonly number[];
	  };

export interface CostReportModel {
	readonly requestedModel: string;
	readonly tokens: CostReportTokens;
	readonly retainedCostUsd: number;
	readonly apiEquivalent: CostReportApiEquivalent;
}

export interface CostReportAccount {
	readonly canonicalAccountId: string;
	readonly models: readonly CostReportModel[];
}

export interface CostReportProject {
	readonly projectKey: string;
	readonly label: string;
	readonly accounts: readonly CostReportAccount[];
}

export interface CostReportPeriod {
	readonly periodStartMs: number;
	readonly periodEndMs: number;
	readonly throughMs: number;
	readonly completed: boolean;
	readonly coverage: "complete" | "partial" | "unknown" | "gap";
	readonly tokens: CostReportTokens;
	readonly retainedCostUsd: number;
	readonly apiEquivalent: CostReportApiEquivalent;
	readonly projects: readonly CostReportProject[];
	/**
	 * The known API-equivalent subtotal and unknown coverage for this period,
	 * exposed alongside (never instead of) {@link apiEquivalent}'s existing
	 * all-or-nothing verdict. Optional only so an out-of-date hand-built
	 * literal keeps compiling; `buildCostReport` always populates it.
	 */
	readonly apiEquivalentCoverage?: ApiEquivalentCoverage;
}

export type SubsidizationPoint =
	| {
			readonly periodStartMs: number;
			readonly periodEndMs: number;
			readonly status: "gap";
			readonly coverage: "gap";
	  }
	| {
			readonly periodStartMs: number;
			readonly periodEndMs: number;
			readonly status: "unpriced";
			readonly coverage: "complete" | "partial" | "unknown";
	  }
	| {
			readonly periodStartMs: number;
			readonly periodEndMs: number;
			readonly status: "priced";
			readonly coverage: "complete" | "partial" | "unknown";
			readonly apiEquivalentEstimateUsd: number;
			readonly apportionedSubscriptionUsd: number;
			readonly ratio: number;
			readonly deltaFromPrevious?: number;
	  };

export interface SubsidizationSeries {
	readonly canonicalAccountId: string;
	readonly monthlySubscriptionUsd: number;
	readonly observedPeriods: number;
	readonly completed: readonly SubsidizationPoint[];
	readonly current?: SubsidizationPoint;
}

export interface LegacyUnattributedCost {
	readonly canonicalAccountId: string;
	readonly requestedModel: string;
	readonly observationCount: number;
	readonly tokens: CostReportTokens;
	readonly retainedCostUsd: number;
}

/** The account rate effective at a given instant, distinguishing an explicit zero from no known rate at all. */
export type RecordedRate =
	| { readonly status: "known"; readonly monthlyUsd: number }
	| { readonly status: "unknown" };

/** The rate-history allocation over one window: see {@link allocateAccountRateCost}. */
export interface AccountRateAllocation {
	readonly knownUsd: number;
	readonly hasUnknownCoverage: boolean;
}

/**
 * A value comparison that is never a bare, unlabeled ratio. `"suppressed"`
 * omits any ratio or ratio-shaped multiple entirely (a zero denominator, an
 * unknown account rate for part of the window, or legacy-ambiguous pricing).
 * `"conditional-lower-bound"` still carries a ratio, but only when omitting
 * unpriced responses can only ever UNDER-count -- so the true ratio is
 * guaranteed to be at least this value -- and it is always labeled with its
 * premise. `"definitive"` requires full, non-legacy-ambiguous coverage on
 * both sides of the comparison.
 */
export type ValueComparison =
	| { readonly status: "suppressed"; readonly reason: string }
	| {
			readonly status: "conditional-lower-bound";
			readonly ratio: number;
			readonly premise: string;
	  }
	| { readonly status: "definitive"; readonly ratio: number };

/**
 * The account's separate values for one reported window. Never summed into
 * one spend figure: the saved Pi estimate stays on `rows`/`apiEquivalent`
 * untouched; `apiEquivalentCoverage.knownUsd` is the tier-aware API-equivalent
 * known subtotal; `recordedRate` is the operator-selected monthly rate
 * effective at the window's end; `allocatedAccountCostUsd` is the UTC-month
 * rate-history allocation. `comparison` is the only place a ratio between
 * them appears, and it is always labeled.
 */
export interface AccountValueSummary {
	readonly canonicalAccountId: string;
	readonly recordedRate: RecordedRate;
	readonly allocatedAccountCostUsd: number;
	readonly allocationHasUnknownCoverage: boolean;
	readonly apiEquivalentCoverage: ApiEquivalentCoverage;
	readonly comparison: ValueComparison;
}

export interface CostReport {
	readonly generatedAtMs: number;
	readonly periodType: PeriodType;
	readonly current: CostReportPeriod;
	readonly completed: readonly CostReportPeriod[];
	readonly subsidization: readonly SubsidizationSeries[];
	readonly legacyUnattributed: readonly LegacyUnattributedCost[];
	/**
	 * Per-account separate values for the current reported window, driven by
	 * `accountRateHistory` rather than the legacy mutable `monthlySubscriptionUsd`
	 * apportionment. Optional only so an out-of-date hand-built literal keeps
	 * compiling; `buildCostReport` always populates it. Scoped to the account,
	 * never to a project: a project-filtered view may disclose an entry here as
	 * separate, unallocated context, but it is never a project charge.
	 */
	readonly accountValue?: readonly AccountValueSummary[];
}

/**
 * Overrides the calendar-period-derived window `buildCostReport` otherwise
 * computes from `periodType`: `"custom"` reports exactly `[startMs, endMs)`;
 * `"all-history"` reports every retained instant, from the earliest known
 * digest row or attributed raw observation through `nowMs`. See
 * {@link BuildCostReportInput.range}.
 */
export type ResolvedReportRange =
	| { readonly kind: "custom"; readonly startMs: number; readonly endMs: number }
	| { readonly kind: "all-history" };

interface BuildCostReportInput {
	readonly digestRows: readonly CostDigestRow[];
	readonly observations: readonly CostObservation[];
	readonly gaps: readonly CostHistoryGap[];
	readonly earliestRawObservationAtMs?: number;
	readonly rawAccountIds?: readonly string[];
	readonly groupedLegacyUnattributed?: readonly LegacyUnattributedCost[];
	readonly currentDayDigestRows?: readonly CostDigestRow[];
	readonly pricing: PricingCacheResult;
	readonly periodType: PeriodType;
	readonly nowMs: number;
	readonly projectLabels: Readonly<Record<string, string>>;
	readonly monthlySubscriptionUsd: Readonly<Record<string, number>>;
	/**
	 * Effective-dated USD rate records per canonical account, already validated
	 * and ordered (see `normalizeAccountRateHistory`). Drives `accountValue` --
	 * the rate-history-based allocation that replaces the legacy mutable
	 * `monthlySubscriptionUsd` apportionment for that purpose. `monthlySubscriptionUsd`
	 * itself stays readable and still drives the existing `subsidization` field
	 * unchanged: this input is additive, not a migration.
	 */
	readonly accountRateHistory?: Readonly<Record<string, readonly AccountRateRecord[]>>;
	/** IANA report timezone for period boundaries; defaults to "UTC". Account-cost allocation always splits at UTC month boundaries regardless. */
	readonly timeZone?: string;
	readonly completedLimit?: number;
	/**
	 * Pi's installed model catalog cost data, used to price still-open,
	 * caller-supplied `observations` for the current period under their own
	 * per-response tier before grouping. Only relevant when `currentDayDigestRows`
	 * is omitted, so this pure function itself must build the provisional
	 * current-day rows; when a caller already supplies pre-priced
	 * `currentDayDigestRows`, their own disclosed methods are used unchanged.
	 */
	readonly piCatalog?: PiCatalogSnapshot;
	/**
	 * Overrides `periodType`-derived calendar bounds for the single reported
	 * window: `{kind:"custom"}` reports exactly `[startMs,endMs)`; `{kind:
	 * "all-history"}` reports from the earliest known digest row or
	 * attributed raw observation through `nowMs`. `completed` stays empty in
	 * both modes -- a custom or all-history window has no calendar cadence to
	 * roll into separate prior periods -- and its row set is selected through
	 * `selectNonOverlappingDigestRows` so a window spanning several retained
	 * granularities is never double-counted. `periodType` remains required
	 * and is NOT read for bounds when `range` is present; a caller in this
	 * mode still supplies a nominal `periodType` so `CostReport.periodType`
	 * keeps its existing shape until a later node adds a dedicated range
	 * label. Omitted, this field preserves the exact prior periodType-only
	 * behavior.
	 */
	readonly range?: ResolvedReportRange;
}

function emptyTokens(): CostReportTokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

function addCount(left: number, right: number): number {
	const total = left + right;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new RangeError("Cost report token total exceeds the safe integer range.");
	}
	return total;
}

function addTokens(left: CostReportTokens, right: CostReportTokens): CostReportTokens {
	return {
		input: addCount(left.input, right.input),
		output: addCount(left.output, right.output),
		cacheRead: addCount(left.cacheRead, right.cacheRead),
		cacheWrite: addCount(left.cacheWrite, right.cacheWrite),
		cacheWrite1h: addCount(left.cacheWrite1h, right.cacheWrite1h),
	};
}

function addUsd(left: number, right: number): number {
	const total = left + right;
	if (!Number.isFinite(total) || total < 0) {
		throw new RangeError("Cost report USD total must remain finite and non-negative.");
	}
	return total;
}

function sortedUniqueNumbers(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUniqueStrings(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

function aggregateApi(rows: readonly CostDigestRow[]): CostReportApiEquivalent {
	const rateAsOfMs = sortedUniqueNumbers(
		rows.flatMap((row) => row.apiEquivalent.rateAsOfMs),
	);
	const unpriced = rows.filter((row) => row.apiEquivalent.status === "unpriced");
	if (unpriced.length > 0) {
		return {
			status: "unpriced",
			reasons: sortedUniqueStrings(
				unpriced.map((row) =>
					row.apiEquivalent.status === "unpriced"
						? row.apiEquivalent.reason
						: "unpriced",
				),
			),
			rateAsOfMs,
		};
	}
	return {
		status: "priced",
		estimatedUsd: rows.reduce(
			(total, row) =>
				row.apiEquivalent.status === "priced"
					? addUsd(total, row.apiEquivalent.estimatedUsd)
					: total,
			0,
		),
		rateAsOfMs,
	};
}

/**
 * The known API-equivalent subtotal and unknown coverage for a set of rows,
 * WITHOUT collapsing to an all-or-nothing "unpriced" verdict the moment one
 * row lacks a rate. `legacyAmbiguousCount` counts rows priced only through
 * the coarse pre-tier-pricing method (a day's tokens summed under one rate
 * lookup, potentially mixing tier thresholds); those rows still contribute to
 * `knownUsd`, but a comparison built from them can never be called definitive.
 */
export interface ApiEquivalentCoverage {
	readonly knownUsd: number;
	readonly knownCount: number;
	readonly unknownCount: number;
	readonly unknownReasons: readonly string[];
	readonly legacyAmbiguousCount: number;
}

function isLegacyAmbiguous(row: CostDigestRow): boolean {
	const methods = row.apiEquivalent.methods;
	return (
		methods === undefined ||
		methods.length === 0 ||
		methods.some((method) => method.source === "legacy-day-aggregate")
	);
}

function aggregateKnownCoverage(rows: readonly CostDigestRow[]): ApiEquivalentCoverage {
	let knownUsd = 0;
	let knownCount = 0;
	let unknownCount = 0;
	let legacyAmbiguousCount = 0;
	const unknownReasons = new Set<string>();
	for (const row of rows) {
		if (row.apiEquivalent.status === "priced") {
			knownUsd = addUsd(knownUsd, row.apiEquivalent.estimatedUsd);
			knownCount += 1;
			if (isLegacyAmbiguous(row)) legacyAmbiguousCount += 1;
		} else {
			unknownCount += 1;
			unknownReasons.add(row.apiEquivalent.reason);
		}
	}
	return {
		knownUsd,
		knownCount,
		unknownCount,
		unknownReasons: sortedUniqueStrings([...unknownReasons]),
		legacyAmbiguousCount,
	};
}

function aggregateCoverage(rows: readonly CostDigestRow[]): CostCoverage {
	if (rows.some((row) => row.coverage === "partial")) return "partial";
	return rows.some((row) => row.coverage === "unknown")
		? "unknown"
		: "complete";
}

/**
 * Downgrades a `"complete"` {@link aggregateCoverage} verdict to `"partial"`
 * when the supplied rows do not, between them, span every instant of
 * `[startMs, endMs)`. A zoned {@link completedPeriods} window selects its
 * rows through {@link selectNonOverlappingDigestRows}, which can return a
 * proper subset of the window -- a coarser rollup that straddles the zoned
 * boundary is correctly excluded rather than sliced, but the remaining
 * selected rows may still leave real, unrepresented time inside the window.
 * `aggregateCoverage` alone only reflects each selected row's own internal
 * completeness, so a single fully-complete row covering a small sliver of a
 * much larger gap would otherwise read as a falsely `"complete"` period.
 * An exact-periodType-match result (the existing UTC/no-timezone path) is
 * unaffected: its row(s) already span exactly `[startMs, endMs)` by
 * construction, so this check is always a no-op there.
 */
function windowCoverage(
	rows: readonly CostDigestRow[],
	startMs: number,
	endMs: number,
): CostCoverage {
	const coverage = aggregateCoverage(rows);
	if (coverage !== "complete") return coverage;
	const sorted = [...rows]
		.map((row) => ({ startMs: row.periodStartMs, endMs: row.periodEndMs }))
		.sort((left, right) => left.startMs - right.startMs);
	let cursor = startMs;
	for (const interval of sorted) {
		if (interval.startMs > cursor) return "partial";
		if (interval.endMs > cursor) cursor = interval.endMs;
	}
	return cursor >= endMs ? "complete" : "partial";
}

function aggregateRows(rows: readonly CostDigestRow[]): {
	readonly tokens: CostReportTokens;
	readonly retainedCostUsd: number;
	readonly apiEquivalent: CostReportApiEquivalent;
} {
	return {
		tokens: rows.reduce(
			(total, row) => addTokens(total, row.tokens),
			emptyTokens(),
		),
		retainedCostUsd: rows.reduce(
			(total, row) => addUsd(total, row.retainedCostUsd),
			0,
		),
		apiEquivalent: aggregateApi(rows),
	};
}

function projectBreakdown(
	rows: readonly CostDigestRow[],
	projectLabels: Readonly<Record<string, string>>,
): readonly CostReportProject[] {
	const projects = new Map<string, Map<string, Map<string, CostDigestRow[]>>>();
	for (const row of rows) {
		const accounts = projects.get(row.projectKey) ?? new Map();
		const models = accounts.get(row.canonicalAccountId) ?? new Map();
		const modelRows = models.get(row.requestedModel) ?? [];
		modelRows.push(row);
		models.set(row.requestedModel, modelRows);
		accounts.set(row.canonicalAccountId, models);
		projects.set(row.projectKey, accounts);
	}
	return [...projects.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([projectKey, accounts]) => ({
			projectKey,
			label: projectLabels[projectKey] ?? projectKey,
			accounts: [...accounts.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([canonicalAccountId, models]) => ({
					canonicalAccountId,
					models: [...models.entries()]
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([requestedModel, modelRows]) => ({
							requestedModel,
							...aggregateRows(modelRows),
						})),
				})),
		}));
}

function periodReport(
	bounds: PeriodBounds,
	throughMs: number,
	completed: boolean,
	rows: readonly CostDigestRow[],
	projectLabels: Readonly<Record<string, string>>,
	/**
	 * Overrides the default `completed ? aggregateCoverage(rows) : "partial"`
	 * verdict. Only {@link completedPeriods}'s zoned selection path supplies
	 * this, via {@link windowCoverage}, to downgrade a falsely `"complete"`
	 * result when its selected rows do not fully span the window. Every other
	 * call site omits it and keeps the exact prior coverage computation.
	 */
	coverageOverride?: CostCoverage,
): CostReportPeriod {
	const aggregate =
		rows.length === 0
			? {
					tokens: emptyTokens(),
					retainedCostUsd: 0,
					apiEquivalent: {
						status: "unpriced" as const,
						reasons: ["period-gap"],
						rateAsOfMs: [],
					},
				}
			: aggregateRows(rows);
	return {
		periodStartMs: bounds.startMs,
		periodEndMs: bounds.endMs,
		throughMs,
		completed,
		coverage:
			rows.length === 0
				? "gap"
				: (coverageOverride ?? (completed ? aggregateCoverage(rows) : "partial")),
		...aggregate,
		apiEquivalentCoverage: aggregateKnownCoverage(rows),
		projects: projectBreakdown(rows, projectLabels),
	};
}

/**
 * The still-open current day's own rows, optionally clipped to a
 * `[clip.startMs, clip.endMs)` narrower than the full `[day.startMs,
 * input.nowMs)` window. Undefined `clip` (the existing calendar-period call
 * site in {@link currentRows}) preserves the exact prior behavior, including
 * the `currentDayDigestRows` fast-path override: that pre-aggregated blob
 * has no per-response timestamps left to slice by, so it is only reused when
 * the resolved window is not narrower than the full day-through-now it was
 * built for. A range clipped narrower than that -- see
 * {@link rangeRows} -- is rebuilt from {@link BuildCostReportInput.observations}
 * instead, which for the real reader is today's real per-response raw detail
 * (see `createDefaultCostReportReader` in `cost-report-reader.ts`), never a
 * fabricated finer grain.
 */
function provisionalCurrentDayRows(
	input: BuildCostReportInput,
	clip?: { readonly startMs: number; readonly endMs: number },
): readonly CostDigestRow[] {
	const day = getPeriodBounds(input.nowMs, "day");
	const startMs = clip === undefined ? day.startMs : Math.max(day.startMs, clip.startMs);
	const endMs = clip === undefined ? input.nowMs : Math.min(input.nowMs, clip.endMs);
	const isFullWindow = startMs <= day.startMs && endMs >= input.nowMs;
	if (isFullWindow && input.currentDayDigestRows !== undefined) {
		return input.currentDayDigestRows;
	}
	if (endMs <= startMs) return [];
	const observations = input.observations.filter(
		(observation) =>
			observation.projectKey !== undefined &&
			observation.observedAtMs >= startMs &&
			observation.observedAtMs < endMs,
	);
	if (observations.length === 0) return [];
	return planClosedCostDigests({
		observations,
		gaps: input.gaps,
		existingRows: input.digestRows,
		pricing: input.pricing,
		...(input.piCatalog === undefined ? {} : { piCatalog: input.piCatalog }),
		nowMs: day.endMs,
		closedAtMs: input.nowMs,
	}).filter(
		(row) => row.periodType === "day" && row.periodStartMs === day.startMs,
	);
}

function currentRows(input: BuildCostReportInput): readonly CostDigestRow[] {
	const current = getPeriodBounds(input.nowMs, input.periodType, input.timeZone ?? "UTC");
	const today = getPeriodBounds(input.nowMs, "day");
	const closedDays = input.digestRows.filter(
		(row) =>
			row.periodType === "day" &&
			row.periodStartMs >= current.startMs &&
			row.periodEndMs <= current.endMs &&
			row.periodEndMs <= today.startMs,
	);
	return [...closedDays, ...provisionalCurrentDayRows(input)];
}

function firstReportableTimestamp(input: BuildCostReportInput): number | undefined {
	const matching = input.digestRows
		.filter((row) => row.periodType === input.periodType)
		.map((row) => row.periodStartMs);
	const attributedRaw = input.observations
		.filter((observation) => observation.projectKey !== undefined)
		.map((observation) => observation.observedAtMs);
	const values = [
		...matching,
		...attributedRaw,
		...(input.earliestRawObservationAtMs === undefined
			? []
			: [input.earliestRawObservationAtMs]),
	];
	return values.length === 0 ? undefined : Math.min(...values);
}

/**
 * The earliest instant any retained digest row or attributed raw observation
 * exists for, across EVERY periodType -- unlike {@link firstReportableTimestamp},
 * which only considers rows already rolled up at the exact requested
 * `periodType`. Drives the start of an `"all-history"` {@link ResolvedReportRange}.
 */
function earliestRetainedTimestamp(input: BuildCostReportInput): number | undefined {
	const rowStarts = input.digestRows.map((row) => row.periodStartMs);
	const attributedRaw = input.observations
		.filter((observation) => observation.projectKey !== undefined)
		.map((observation) => observation.observedAtMs);
	const values = [
		...rowStarts,
		...attributedRaw,
		...(input.earliestRawObservationAtMs === undefined
			? []
			: [input.earliestRawObservationAtMs]),
	];
	return values.length === 0 ? undefined : Math.min(...values);
}

function completedPeriods(input: BuildCostReportInput): {
	readonly reports: readonly CostReportPeriod[];
	readonly rowsByStart: ReadonlyMap<number, readonly CostDigestRow[]>;
} {
	const first = firstReportableTimestamp(input);
	if (first === undefined) return { reports: [], rowsByStart: new Map() };
	const timeZone = input.timeZone ?? "UTC";
	/**
	 * A non-UTC request's zoned period boundaries almost never land exactly
	 * on the closer's UTC-aligned rollup bounds (day/week/month/quarter/...),
	 * so the exact-match lookup below would normally find nothing. `zoned`
	 * switches to {@link selectNonOverlappingDigestRows} instead, which picks
	 * the best contained, non-overlapping retained representation for the
	 * window -- see its own JSDoc for why a coarser row straddling the zoned
	 * boundary is excluded rather than sliced or prorated. `timeZone ===
	 * "UTC"` (including the omitted-`timeZone` default) keeps the exact prior
	 * behavior byte-for-byte.
	 */
	const zoned = timeZone !== "UTC";
	const allBounds = enumerateCompletedPeriods(
		input.periodType,
		first,
		input.nowMs,
		{ timeZone },
	);
	const limit = input.completedLimit ?? 12;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		throw new RangeError("completedLimit must be a safe integer from 1 to 1000.");
	}
	const bounds = allBounds.slice(-limit);
	const rowsByStart = new Map<number, readonly CostDigestRow[]>();
	const reports = bounds.map((period) => {
		const rows = zoned
			? selectNonOverlappingDigestRows(input.digestRows, period.startMs, period.endMs)
			: input.digestRows.filter(
					(row) =>
						row.periodType === input.periodType &&
						row.periodStartMs === period.startMs &&
						row.periodEndMs === period.endMs,
				);
		rowsByStart.set(period.startMs, rows);
		return periodReport(
			period,
			period.endMs,
			true,
			rows,
			input.projectLabels,
			zoned ? windowCoverage(rows, period.startMs, period.endMs) : undefined,
		);
	});
	return { reports, rowsByStart };
}

function apportionedSubscriptionUsd(
	monthlyUsd: number,
	startMs: number,
	throughMs: number,
): number {
	if (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0) {
		throw new RangeError("Monthly subscription cost must be finite and positive.");
	}
	let cursor = startMs;
	let total = 0;
	let iterations = 0;
	while (cursor < throughMs) {
		iterations += 1;
		if (iterations > 24) {
			throw new RangeError("Subscription apportionment exceeded 24 calendar months.");
		}
		const month = getPeriodBounds(cursor, "month");
		const segmentEnd = Math.min(throughMs, month.endMs);
		const fraction = (segmentEnd - cursor) / (month.endMs - month.startMs);
		total = addUsd(total, monthlyUsd * fraction);
		cursor = segmentEnd;
	}
	return total;
}

function subsidyPoint(
	rows: readonly CostDigestRow[],
	bounds: PeriodBounds,
	throughMs: number,
	monthlyUsd: number,
	forcePartialCoverage = false,
): SubsidizationPoint {
	const accountRows = rows;
	if (accountRows.length === 0) {
		return {
			periodStartMs: bounds.startMs,
			periodEndMs: bounds.endMs,
			status: "gap",
			coverage: "gap",
		};
	}
	const coverage = forcePartialCoverage
		? "partial"
		: aggregateCoverage(accountRows);
	const apiEquivalent = aggregateApi(accountRows);
	if (apiEquivalent.status === "unpriced") {
		return {
			periodStartMs: bounds.startMs,
			periodEndMs: bounds.endMs,
			status: "unpriced",
			coverage,
		};
	}
	const subscription = apportionedSubscriptionUsd(
		monthlyUsd,
		bounds.startMs,
		throughMs,
	);
	if (subscription <= 0) {
		return {
			periodStartMs: bounds.startMs,
			periodEndMs: bounds.endMs,
			status: "unpriced",
			coverage,
		};
	}
	return {
		periodStartMs: bounds.startMs,
		periodEndMs: bounds.endMs,
		status: "priced",
		coverage,
		apiEquivalentEstimateUsd: apiEquivalent.estimatedUsd,
		apportionedSubscriptionUsd: subscription,
		ratio: apiEquivalent.estimatedUsd / subscription,
	};
}

function withConsecutiveDeltas(
	points: readonly SubsidizationPoint[],
): readonly SubsidizationPoint[] {
	return points.map((point, index) => {
		const previous = points[index - 1];
		if (point.status !== "priced" || previous?.status !== "priced") {
			return point;
		}
		return { ...point, deltaFromPrevious: point.ratio - previous.ratio };
	});
}

function buildSubsidization(
	input: BuildCostReportInput,
	completed: ReturnType<typeof completedPeriods>,
	currentBounds: PeriodBounds,
	currentPeriodRows: readonly CostDigestRow[],
	/**
	 * Overrides for a resolved custom/all-history window, where the reported
	 * window's own true end (when already fully elapsed) replaces `nowMs`,
	 * and coverage reflects the rows themselves rather than being forced
	 * `"partial"` -- mirroring how {@link completedPeriods} treats a fully
	 * elapsed calendar period. Defaults preserve the exact prior behavior for
	 * the still-open current calendar period.
	 */
	options: {
		readonly throughMs?: number;
		readonly forcePartialCoverage?: boolean;
	} = {},
): readonly SubsidizationSeries[] {
	const throughMs = options.throughMs ?? input.nowMs;
	const forcePartialCoverage = options.forcePartialCoverage ?? true;
	const presentAccounts = new Set([
		...input.digestRows.map((row) => row.canonicalAccountId),
		...input.observations.map((observation) => observation.canonicalAccountId),
		...(input.rawAccountIds ?? []),
	]);
	return Object.entries(input.monthlySubscriptionUsd)
		.filter(([accountId]) => presentAccounts.has(accountId))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([canonicalAccountId, monthlySubscriptionUsd]) => {
			const completedPoints = completed.reports.map((report) => {
				const rows = (
					completed.rowsByStart.get(report.periodStartMs) ?? []
				).filter(
					(row) => row.canonicalAccountId === canonicalAccountId,
				);
				return subsidyPoint(
					rows,
					{
						startMs: report.periodStartMs,
						endMs: report.periodEndMs,
					},
					report.periodEndMs,
					monthlySubscriptionUsd,
				);
			});
			const completedWithDeltas = withConsecutiveDeltas(completedPoints);
			const currentAccountRows = currentPeriodRows.filter(
				(row) => row.canonicalAccountId === canonicalAccountId,
			);
			return {
				canonicalAccountId,
				monthlySubscriptionUsd,
				observedPeriods: completedWithDeltas.filter(
					(point) => point.status === "priced",
				).length,
				completed: completedWithDeltas,
				current: subsidyPoint(
					currentAccountRows,
					currentBounds,
					throughMs,
					monthlySubscriptionUsd,
					forcePartialCoverage,
				),
			};
		});
}

/**
 * Sums each known-rate segment's `monthlyUsd * coveredMs / thatUtcMonthMs`
 * across `[startMs, endMs)`, splitting at every effective-rate change AND
 * every UTC calendar-month boundary (via {@link splitAtUtcMonthBoundaries}),
 * independent of any report display timezone. A full UTC month at one known
 * rate contributes exactly that rate; an explicit `monthlyUsd: 0` contributes
 * 0 while remaining "known"; any covered instant before the first record's
 * `effectiveFrom` is unknown and contributes nothing to `knownUsd`, but is
 * reported via `hasUnknownCoverage` rather than silently coerced to 0.
 */
export function allocateAccountRateCost(
	records: readonly AccountRateRecord[],
	startMs: number,
	endMs: number,
): AccountRateAllocation {
	if (endMs <= startMs) return { knownUsd: 0, hasUnknownCoverage: false };
	const sortedRecords = [...records].sort(
		(left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom),
	);
	let knownUsd = 0;
	let hasUnknownCoverage = false;
	for (const monthSegment of splitAtUtcMonthBoundaries(startMs, endMs)) {
		// `monthSegment` is clipped to `[startMs, endMs)`, so its own span is NOT
		// the allocation denominator: a request that starts or ends mid-month
		// (e.g. a non-UTC report timezone's local month boundary) must still
		// divide by that UTC month's TRUE full length, never the clipped
		// fraction being measured -- otherwise every clipped segment would
		// wrongly normalize to a full month's rate.
		const fullMonth = getPeriodBounds(monthSegment.startMs, "month");
		const monthMs = fullMonth.endMs - fullMonth.startMs;
		const changePoints = sortedRecords
			.map((record) => Date.parse(record.effectiveFrom))
			.filter((ms) => ms > monthSegment.startMs && ms < monthSegment.endMs);
		const boundaries = [
			monthSegment.startMs,
			...sortedUniqueNumbers(changePoints),
			monthSegment.endMs,
		];
		for (let index = 0; index < boundaries.length - 1; index += 1) {
			const segStart = boundaries[index]!;
			const segEnd = boundaries[index + 1]!;
			if (segEnd <= segStart) continue;
			const applicable = sortedRecords
				.filter((record) => Date.parse(record.effectiveFrom) <= segStart)
				.pop();
			if (applicable === undefined) {
				hasUnknownCoverage = true;
				continue;
			}
			const coveredMs = segEnd - segStart;
			knownUsd = addUsd(knownUsd, applicable.monthlyUsd * (coveredMs / monthMs));
		}
	}
	return { knownUsd, hasUnknownCoverage };
}

function recordedRateAsOf(
	records: readonly AccountRateRecord[],
	asOfMs: number,
): RecordedRate {
	const applicable = [...records]
		.filter((record) => Date.parse(record.effectiveFrom) <= asOfMs)
		.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
		.pop();
	return applicable === undefined
		? { status: "unknown" }
		: { status: "known", monthlyUsd: applicable.monthlyUsd };
}

function buildValueComparison(
	apiCoverage: ApiEquivalentCoverage,
	allocation: AccountRateAllocation,
): ValueComparison {
	if (allocation.hasUnknownCoverage) {
		return {
			status: "suppressed",
			reason: "account-rate-unknown-for-part-of-window",
		};
	}
	if (allocation.knownUsd <= 0) {
		return { status: "suppressed", reason: "zero-denominator" };
	}
	if (apiCoverage.legacyAmbiguousCount > 0) {
		return { status: "suppressed", reason: "legacy-ambiguous-pricing-method" };
	}
	const ratio = apiCoverage.knownUsd / allocation.knownUsd;
	if (apiCoverage.unknownCount > 0) {
		return {
			status: "conditional-lower-bound",
			ratio,
			premise: `excludes ${apiCoverage.unknownCount} response(s) without a known API-equivalent price; the true ratio is at least this value`,
		};
	}
	return { status: "definitive", ratio };
}

/**
 * Builds the per-account value summary for one reported window: the saved Pi
 * estimate stays in `rows`/the existing `apiEquivalent` aggregate untouched;
 * this exposes the recorded rate, the rate-history allocation, the known/
 * unknown API-equivalent split, and a comparison that is never a bare
 * unlabeled ratio. Scoped to the account itself -- independent of how many
 * (or which) projects reference it, so a project-filtered view can disclose
 * this as separate, unallocated context without ever calling it a project
 * charge, subtracting it, splitting it, or duplicating it per response.
 */
function buildAccountValue(
	input: BuildCostReportInput,
	bounds: { readonly startMs: number; readonly endMs: number },
	rows: readonly CostDigestRow[],
): readonly AccountValueSummary[] {
	const accountRateHistory = input.accountRateHistory ?? {};
	const presentAccounts = new Set([
		...Object.keys(accountRateHistory),
		...input.digestRows.map((row) => row.canonicalAccountId),
		...input.observations.map((observation) => observation.canonicalAccountId),
		...(input.rawAccountIds ?? []),
	]);
	return [...presentAccounts].sort().map((canonicalAccountId) => {
		const records = accountRateHistory[canonicalAccountId] ?? [];
		const allocation = allocateAccountRateCost(records, bounds.startMs, bounds.endMs);
		const accountRows = rows.filter(
			(row) => row.canonicalAccountId === canonicalAccountId,
		);
		const apiEquivalentCoverage = aggregateKnownCoverage(accountRows);
		return {
			canonicalAccountId,
			recordedRate: recordedRateAsOf(records, bounds.endMs),
			allocatedAccountCostUsd: allocation.knownUsd,
			allocationHasUnknownCoverage: allocation.hasUnknownCoverage,
			apiEquivalentCoverage,
			comparison: buildValueComparison(apiEquivalentCoverage, allocation),
		};
	});
}

function legacyUnattributed(
	observations: readonly CostObservation[],
): readonly LegacyUnattributedCost[] {
	const groups = new Map<string, CostObservation[]>();
	for (const observation of observations) {
		if (observation.projectKey !== undefined) continue;
		const key = JSON.stringify([
			observation.canonicalAccountId,
			observation.requestedModel,
		]);
		const group = groups.get(key) ?? [];
		group.push(observation);
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => {
			const first = group[0];
			if (first === undefined) return undefined;
			return {
				canonicalAccountId: first.canonicalAccountId,
				requestedModel: first.requestedModel,
				observationCount: group.length,
				tokens: group.reduce(
					(total, observation) => addTokens(total, observation.tokens),
					emptyTokens(),
				),
				retainedCostUsd: group.reduce(
					(total, observation) => addUsd(total, observation.retainedCostUsd),
					0,
				),
			};
		})
		.filter((entry): entry is LegacyUnattributedCost => entry !== undefined)
		.sort(
			(left, right) =>
				left.canonicalAccountId.localeCompare(right.canonicalAccountId) ||
				left.requestedModel.localeCompare(right.requestedModel),
		);
}

/** The `[startMs,endMs)` a {@link ResolvedReportRange} resolves to against this input's own retained data. */
function resolveRangeBounds(
	input: BuildCostReportInput,
	range: ResolvedReportRange,
): { readonly startMs: number; readonly endMs: number } {
	if (range.kind === "custom") {
		return { startMs: range.startMs, endMs: range.endMs };
	}
	const startMs = earliestRetainedTimestamp(input) ?? input.nowMs;
	return { startMs, endMs: input.nowMs };
}

/**
 * The row set for an arbitrary `[startMs,endMs)` window -- unlike
 * {@link currentRows}, which only ever assembles rows shaped by a calendar
 * `periodType`. Every CLOSED digest row is a candidate for
 * {@link selectNonOverlappingDigestRows}, which picks exactly one
 * representation per (project, account, model) identity so a window
 * spanning several retained granularities (raw, day, month, ...) is never
 * double-counted. A closed row's `periodEndMs` never exceeds today's own
 * start, so none of them can ever represent today; the still-open current
 * day's own provisional rows are appended afterward whenever `bounds`
 * overlaps today at all, explicitly clipped to `bounds` itself by
 * {@link provisionalCurrentDayRows} rather than the nominal full-calendar-day
 * shape a closed row would have -- a window ending or starting mid-day-today
 * excludes exactly the out-of-window instants instead of either silently
 * absorbing everything through `nowMs` or dropping today's data entirely.
 */
function rangeRows(
	input: BuildCostReportInput,
	bounds: { readonly startMs: number; readonly endMs: number },
): readonly CostDigestRow[] {
	const closed = selectNonOverlappingDigestRows(
		input.digestRows,
		bounds.startMs,
		bounds.endMs,
	);
	const today = getPeriodBounds(input.nowMs, "day");
	// Overlap with today, not just "starts on/before today": a window whose own
	// `--from` lands mid-day (after today's midnight) still needs today's live
	// data, so containment against `today.startMs` alone would wrongly drop it.
	const spansToday = bounds.endMs > today.startMs && bounds.startMs < today.endMs;
	const provisional = spansToday
		? provisionalCurrentDayRows(input, {
				startMs: bounds.startMs,
				endMs: bounds.endMs,
			})
		: [];
	return [...closed, ...provisional];
}

/**
 * Builds a `CostReport` for a resolved custom range or all-history window
 * instead of a calendar period. See {@link BuildCostReportInput.range}. A
 * `"custom"` window is `completed` once its own `endMs` has fully elapsed;
 * `"all-history"` is never `completed` -- it always extends through `nowMs`
 * by construction, so it is reported exactly like the still-open current
 * calendar period, folding in today's provisional rows the same way.
 */
function buildRangeReport(
	input: BuildCostReportInput,
	range: ResolvedReportRange,
): CostReport {
	const bounds = resolveRangeBounds(input, range);
	const rows = rangeRows(input, bounds);
	const elapsed = range.kind === "custom" && bounds.endMs <= input.nowMs;
	const throughMs = elapsed ? bounds.endMs : input.nowMs;
	return {
		generatedAtMs: input.nowMs,
		periodType: input.periodType,
		current: periodReport(bounds, throughMs, elapsed, rows, input.projectLabels),
		completed: [],
		subsidization: buildSubsidization(
			input,
			{ reports: [], rowsByStart: new Map() },
			bounds,
			rows,
			{ throughMs, forcePartialCoverage: !elapsed },
		),
		legacyUnattributed:
			input.groupedLegacyUnattributed ?? legacyUnattributed(input.observations),
		accountValue: buildAccountValue(input, bounds, rows),
	};
}

export function buildCostReport(input: BuildCostReportInput): CostReport {
	if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
		throw new RangeError("Cost report nowMs must be a finite timestamp.");
	}
	if (input.range !== undefined) {
		return buildRangeReport(input, input.range);
	}
	const completed = completedPeriods(input);
	const currentBounds = getPeriodBounds(
		input.nowMs,
		input.periodType,
		input.timeZone ?? "UTC",
	);
	const rows = currentRows(input);
	return {
		generatedAtMs: input.nowMs,
		periodType: input.periodType,
		current: periodReport(
			currentBounds,
			input.nowMs,
			false,
			rows,
			input.projectLabels,
		),
		completed: completed.reports,
		subsidization: buildSubsidization(
			input,
			completed,
			currentBounds,
			rows,
		),
		legacyUnattributed:
			input.groupedLegacyUnattributed ?? legacyUnattributed(input.observations),
		accountValue: buildAccountValue(
			input,
			{ startMs: currentBounds.startMs, endMs: input.nowMs },
			rows,
		),
	};
}
