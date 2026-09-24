import type {
	CostReport,
	CostReportApiEquivalent,
	CostReportPeriod,
	SubsidizationPoint,
	SubsidizationSeries,
} from "./cost-report.js";
import type { PeriodType } from "./period-boundaries.js";

/**
 * Bump on any breaking field change to {@link CostReportJson}. A consumer
 * (the standalone `cost --format json` command, or any other JSON reader of
 * this pure projection) reads this before trusting the document's shape.
 */
export const COST_REPORT_JSON_SCHEMA_VERSION = 1;

/**
 * The requested-scope summary carried at the top of {@link CostReportJson},
 * mirroring the text renderer's leading block: the saved Pi model-price
 * estimate and the independently calculated API-equivalent estimate are
 * always both present and separately labeled, even when their amounts match.
 * `note` explains that relationship in prose for a human reading raw JSON;
 * neither `money` field is ever combined into one spend total, and neither is
 * an actual provider bill, payment, refund, tax record, or bank charge -- see
 * {@link CostReportJson.limitations}.
 */
export interface CostReportJsonSummary {
	readonly scope: {
		readonly periodType: PeriodType;
		readonly startMs: number;
		readonly endMs: number;
		readonly throughMs: number;
		readonly completed: boolean;
		readonly coverage: CostReportPeriod["coverage"];
	};
	readonly money: {
		/** Pi's own saved per-response cost for the requested scope, unchanged from `current.retainedCostUsd`. */
		readonly piModelPriceEstimateUsd: number;
		/** The independently calculated, tier-aware estimate for the requested scope, unchanged from `current.apiEquivalent`. */
		readonly apiEquivalentEstimate: CostReportApiEquivalent;
	};
	readonly note: string;
}

/** When this document was generated, and which pricing snapshot instants its API-equivalent estimates were computed against. */
export interface CostReportJsonProvenance {
	readonly generatedAtMs: number;
	readonly generatedAt: string;
	readonly pricingSnapshotAtMs: readonly number[];
}

/** The `"priced"` member of {@link SubsidizationPoint}, isolated so {@link CostReportJsonSubsidizationPoint} can override just its `coverage` field. */
type PricedSubsidizationPoint = Extract<SubsidizationPoint, { readonly status: "priced" }>;

/**
 * The legacy subsidization point as serialized for `--format json`.
 * Identical to {@link SubsidizationPoint} -- plus an explicit
 * `comparisonSuppressed: false` -- when `status` is not `"priced"` or
 * `coverage` is `"complete"`. When `status` is `"priced"` and `coverage` is
 * `"partial"` or `"unknown"`, `ratio` and `deltaFromPrevious` are withheld:
 * the underlying retained data or its completeness classification cannot
 * support a definitive comparison for that window, so `comparisonSuppressed`
 * is `true` and `suppressedReason` names why. `apiEquivalentEstimateUsd` and
 * `apportionedSubscriptionUsd` -- the two figures a shown ratio would have
 * divided -- are always still present either way. This withholds only the
 * ratio itself, never a value {@link SubsidizationPoint} did not already
 * carry: `buildCostReport` and `SubsidizationPoint` itself are unchanged.
 */
export type CostReportJsonSubsidizationPoint =
	| ((
			| Extract<SubsidizationPoint, { readonly status: "gap" }>
			| Extract<SubsidizationPoint, { readonly status: "unpriced" }>
			| (Omit<PricedSubsidizationPoint, "coverage"> & { readonly coverage: "complete" })
	  ) & { readonly comparisonSuppressed: false })
	| {
			readonly periodStartMs: number;
			readonly periodEndMs: number;
			readonly status: "priced";
			readonly coverage: "partial" | "unknown";
			readonly apiEquivalentEstimateUsd: number;
			readonly apportionedSubscriptionUsd: number;
			readonly comparisonSuppressed: true;
			readonly suppressedReason: string;
	  };

/** {@link SubsidizationSeries}, with every point run through {@link CostReportJsonSubsidizationPoint}'s ratio-suppression rule. */
export interface CostReportJsonSubsidizationSeries {
	readonly canonicalAccountId: string;
	readonly monthlySubscriptionUsd: number;
	readonly observedPeriods: number;
	readonly completed: readonly CostReportJsonSubsidizationPoint[];
	readonly current?: CostReportJsonSubsidizationPoint;
}

/**
 * One versioned, documented JSON value for the pure `CostReport` projection.
 * Every money, coverage, scope, and comparison field is a direct, unrenamed
 * view of {@link CostReport} -- `current`, `completed`, `accountValue`, and
 * `legacyUnattributed` are the exact same typed values `buildCostReport`
 * produces, reorganized under one schema-versioned wrapper plus a
 * requested-scope `summary` and a `limitations` list. `subsidization` is the
 * one exception: it is the same points with a bare ratio withheld under
 * incomplete coverage (see {@link CostReportJsonSubsidizationPoint}), a
 * serialization decision, not a second computed value. Otherwise this is a
 * serialization and documentation surface, never a second computed report
 * type: it introduces no value this module did not already receive from
 * `CostReport`.
 */
export interface CostReportJson {
	readonly schemaVersion: typeof COST_REPORT_JSON_SCHEMA_VERSION;
	readonly provenance: CostReportJsonProvenance;
	readonly summary: CostReportJsonSummary;
	readonly current: CostReportPeriod;
	readonly completed: CostReport["completed"];
	readonly accountValue: NonNullable<CostReport["accountValue"]>;
	readonly subsidization: readonly CostReportJsonSubsidizationSeries[];
	readonly legacyUnattributed: CostReport["legacyUnattributed"];
	readonly limitations: readonly string[];
}

/**
 * Reuses the spec's own approved billing-claim boundary language verbatim so
 * the JSON document and the product description never drift: neither
 * estimate is an actual provider charge, the recorded rate and allocated
 * account cost are not an invoice/payment/refund/tax record/bank charge, and
 * comparisons never claim a real subsidy, saving, or provider revenue.
 */
const BASE_LIMITATION =
	"Neither the Pi model-price estimate nor the API-equivalent estimate is an actual provider charge. The recorded account rate and allocated account cost are not an invoice, payment, refund, tax record, or bank charge. Differences, ratios, and value multiples compare report values only and do not claim an actual subsidy, saving, provider revenue, or private-contract economics.";

function sortedUniqueNumbers(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function pricingSnapshotAtMs(report: CostReport): readonly number[] {
	return sortedUniqueNumbers([
		...report.current.apiEquivalent.rateAsOfMs,
		...report.completed.flatMap((period) => period.apiEquivalent.rateAsOfMs),
	]);
}

function summaryNote(current: CostReportPeriod): string {
	const lead =
		"The saved Pi model-price estimate and the independently calculated API-equivalent estimate are reported separately below.";
	if (current.apiEquivalent.status !== "priced") {
		return `${lead} The API-equivalent estimate is currently unpriced for this scope.`;
	}
	return current.apiEquivalent.estimatedUsd === current.retainedCostUsd
		? `${lead} They happen to match for this window; they remain two independently produced figures.`
		: lead;
}

/**
 * Serializes one legacy subsidization point, withholding `ratio` and
 * `deltaFromPrevious` when `status` is `"priced"` and `coverage` is not
 * `"complete"`. See {@link CostReportJsonSubsidizationPoint}.
 *
 * `deltaFromPrevious` (cost-report.ts's `withConsecutiveDeltas`) is a
 * difference of two ratios, so even when this point's own `coverage` is
 * `"complete"` the delta is only as reliable as `previous` -- the
 * immediately preceding point in the same `completed` array, never an
 * earlier complete point reached by bridging a gap. When `previous` is
 * missing or not itself a `"priced"`/`"complete"` point, `deltaFromPrevious`
 * is omitted from the output rather than spread through and labeled
 * `comparisonSuppressed: false`; `ratio` and every other field of this
 * point remain valid and present.
 */
function toJsonSubsidizationPoint(
	point: SubsidizationPoint,
	previous?: SubsidizationPoint,
): CostReportJsonSubsidizationPoint {
	if (point.status === "gap") {
		return { ...point, status: point.status, comparisonSuppressed: false };
	}
	if (point.status === "unpriced") {
		return { ...point, status: point.status, comparisonSuppressed: false };
	}
	if (point.coverage === "complete") {
		const deltaBasisComplete =
			previous !== undefined && previous.status === "priced" && previous.coverage === "complete";
		if (deltaBasisComplete || point.deltaFromPrevious === undefined) {
			return { ...point, coverage: point.coverage, comparisonSuppressed: false };
		}
		const { deltaFromPrevious: _omittedDelta, ...pointWithoutDelta } = point;
		return { ...pointWithoutDelta, coverage: point.coverage, comparisonSuppressed: false };
	}
	return {
		periodStartMs: point.periodStartMs,
		periodEndMs: point.periodEndMs,
		status: "priced",
		coverage: point.coverage,
		apiEquivalentEstimateUsd: point.apiEquivalentEstimateUsd,
		apportionedSubscriptionUsd: point.apportionedSubscriptionUsd,
		comparisonSuppressed: true,
		suppressedReason: `legacy-subsidization-${point.coverage}-coverage`,
	};
}

function toJsonSubsidizationSeries(
	series: SubsidizationSeries,
): CostReportJsonSubsidizationSeries {
	return {
		canonicalAccountId: series.canonicalAccountId,
		monthlySubscriptionUsd: series.monthlySubscriptionUsd,
		observedPeriods: series.observedPeriods,
		completed: series.completed.map((point, index) =>
			toJsonSubsidizationPoint(point, series.completed[index - 1]),
		),
		...(series.current === undefined
			? {}
			: { current: toJsonSubsidizationPoint(series.current) }),
	};
}

/** One line disclosing that the legacy subsidization ratio is withheld for one or more periods whose coverage is not complete -- never left to a header disclaimer alone. */
function subsidizationSuppressionLimitations(report: CostReport): readonly string[] {
	const hasSuppressedPoint = report.subsidization.some((series) =>
		[series.current, ...series.completed].some(
			(point) => point !== undefined && point.status === "priced" && point.coverage !== "complete",
		),
	);
	return hasSuppressedPoint
		? [
				"Legacy subsidization comparison is withheld for one or more periods whose coverage is not complete; their apportioned subscription and API-equivalent estimate remain reported without a ratio.",
			]
		: [];
}

/** One line per account-level limitation already disclosed by `CostReport` itself: a suppressed or conditional comparison, or unknown allocation coverage. */
function accountValueLimitations(report: CostReport): readonly string[] {
	const limitations: string[] = [];
	for (const entry of report.accountValue ?? []) {
		if (entry.comparison.status === "suppressed") {
			limitations.push(
				`${entry.canonicalAccountId}: comparison suppressed (${entry.comparison.reason}).`,
			);
		} else if (entry.comparison.status === "conditional-lower-bound") {
			limitations.push(
				`${entry.canonicalAccountId}: comparison is a conditional lower bound (${entry.comparison.premise}).`,
			);
		}
		if (entry.allocationHasUnknownCoverage) {
			limitations.push(
				`${entry.canonicalAccountId}: allocated account cost has unknown coverage for part of this window.`,
			);
		}
	}
	return limitations;
}

function buildLimitations(report: CostReport): readonly string[] {
	const limitations: string[] = [BASE_LIMITATION];
	if (report.current.coverage !== "complete") {
		limitations.push(
			`Requested-scope coverage is "${report.current.coverage}": part or all of the requested window has no immutable retained data.`,
		);
	}
	limitations.push(...accountValueLimitations(report));
	if (report.legacyUnattributed.length > 0) {
		limitations.push(
			"Legacy unattributed retained cost exists for responses saved without a project key.",
		);
	}
	if (report.subsidization.length > 0) {
		limitations.push(
			"Subsidization figures use the legacy flat monthly-subscription value, superseded by recorded account rate for new comparisons.",
		);
		limitations.push(...subsidizationSuppressionLimitations(report));
	}
	return limitations;
}

/**
 * Builds the documented {@link CostReportJson} value for `report`. Pure: no
 * I/O, no clock read, no mutation, and no field not already present on
 * `report` itself.
 */
export function buildCostReportJson(report: CostReport): CostReportJson {
	const current = report.current;
	return {
		schemaVersion: COST_REPORT_JSON_SCHEMA_VERSION,
		provenance: {
			generatedAtMs: report.generatedAtMs,
			generatedAt: new Date(report.generatedAtMs).toISOString(),
			pricingSnapshotAtMs: pricingSnapshotAtMs(report),
		},
		summary: {
			scope: {
				periodType: report.periodType,
				startMs: current.periodStartMs,
				endMs: current.periodEndMs,
				throughMs: current.throughMs,
				completed: current.completed,
				coverage: current.coverage,
			},
			money: {
				piModelPriceEstimateUsd: current.retainedCostUsd,
				apiEquivalentEstimate: current.apiEquivalent,
			},
			note: summaryNote(current),
		},
		current,
		completed: report.completed,
		accountValue: report.accountValue ?? [],
		subsidization: report.subsidization.map(toJsonSubsidizationSeries),
		legacyUnattributed: report.legacyUnattributed,
		limitations: buildLimitations(report),
	};
}

/**
 * Renders `report` as one versioned JSON document with no surrounding prose,
 * for the standalone report's `--format json` output (wired by a later
 * node).
 */
export function renderCostReportJson(report: CostReport): string {
	return JSON.stringify(buildCostReportJson(report), null, 2);
}
