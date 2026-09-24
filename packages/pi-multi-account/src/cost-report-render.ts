import type {
	AccountValueSummary,
	CostReport,
	CostReportApiEquivalent,
	CostReportPeriod,
	CostReportTokens,
	RecordedRate,
	SubsidizationPoint,
	ValueComparison,
} from "./cost-report.js";

function iso(timestampMs: number): string {
	return new Date(timestampMs).toISOString();
}

function usd(value: number): string {
	if (value !== 0 && value < 0.000001) return `$${value.toExponential(4)}`;
	return `$${value.toFixed(6)}`;
}

function tokenBreakdown(tokens: CostReportTokens): string {
	return (
		`${tokens.input} input, ${tokens.output} output, ` +
		`${tokens.cacheRead} cache-read, ${tokens.cacheWrite} cache-write, ` +
		`${tokens.cacheWrite1h} one-hour cache-write`
	);
}

function apiEquivalent(value: CostReportApiEquivalent): string {
	if (value.status === "unpriced") {
		return `API-equivalent estimate: unpriced (${value.reasons.join(", ")})`;
	}
	const stamps = value.rateAsOfMs.map(iso).join(", ");
	return `API-equivalent estimate: ${usd(value.estimatedUsd)} (rate snapshot: ${stamps || "none"})`;
}

function periodHeading(period: CostReportPeriod): string {
	const scope = period.completed ? "completed" : "current partial";
	return `${scope} ${iso(period.periodStartMs)} .. ${iso(period.periodEndMs)} through ${iso(period.throughMs)} — coverage: ${period.coverage}`;
}

function renderPeriod(period: CostReportPeriod): readonly string[] {
	const lines = [
		periodHeading(period),
		`  tokens: ${tokenBreakdown(period.tokens)}; Pi model-price estimate (retained provider cost: ${usd(period.retainedCostUsd)}); ${apiEquivalent(period.apiEquivalent)}`,
	];
	if (period.coverage === "gap") {
		lines.push("  gap: no immutable digest row exists for this period.");
		return lines;
	}
	for (const project of period.projects) {
		lines.push(`  project ${project.label} [${project.projectKey}]`);
		for (const account of project.accounts) {
			lines.push(`    account ${account.canonicalAccountId}`);
			for (const model of account.models) {
				lines.push(
					`      model ${model.requestedModel}: ${tokenBreakdown(model.tokens)}; Pi model-price estimate (retained provider cost ${usd(model.retainedCostUsd)}); ${apiEquivalent(model.apiEquivalent)}`,
				);
			}
		}
	}
	return lines;
}

/**
 * The leading, operator-first block: the requested scope, then the saved Pi
 * model-price estimate and the independently calculated API-equivalent
 * estimate as two clearly labeled, terse value lines -- always both, even
 * when their amounts happen to match -- followed by one disclaimer paragraph
 * that neither figure is an actual provider bill, payment, refund, tax
 * record, or bank charge. This runs before any project/account/model detail
 * so the requested-scope summary is the first thing an operator reads.
 */
function renderRequestedScopeSummary(report: CostReport): readonly string[] {
	const current = report.current;
	const matchNote =
		current.apiEquivalent.status === "priced" &&
		current.apiEquivalent.estimatedUsd === current.retainedCostUsd
			? " These two figures happen to match for this window;"
			: "";
	return [
		`Requested scope: ${periodHeading(current)}`,
		`  Pi model-price estimate (saved): ${usd(current.retainedCostUsd)}`,
		`  ${apiEquivalent(current.apiEquivalent)}`,
		`  Both figures above are independent calculations, not the same measurement.${matchNote} Neither is an actual provider bill, payment, refund, tax record, or bank charge.`,
	];
}

function renderRecordedRate(rate: RecordedRate): string {
	if (rate.status === "unknown") return "unknown (no recorded account rate as of this window)";
	return rate.monthlyUsd === 0
		? `${usd(rate.monthlyUsd)} (explicit zero rate)`
		: usd(rate.monthlyUsd);
}

function renderComparison(comparison: ValueComparison): string {
	if (comparison.status === "suppressed") {
		return `not compared (${comparison.reason})`;
	}
	if (comparison.status === "conditional-lower-bound") {
		return `at least ${comparison.ratio.toFixed(4)}x — conditional lower bound (${comparison.premise})`;
	}
	return `${comparison.ratio.toFixed(4)}x — definitive comparison of report figures only`;
}

function renderAccountValue(entry: AccountValueSummary): string {
	const allocation = entry.allocationHasUnknownCoverage
		? `${usd(entry.allocatedAccountCostUsd)} (partial: part of this window has no recorded account rate)`
		: usd(entry.allocatedAccountCostUsd);
	return (
		`  ${entry.canonicalAccountId}: recorded monthly account rate ${renderRecordedRate(entry.recordedRate)}; ` +
		`allocated account cost ${allocation}; comparison: ${renderComparison(entry.comparison)}`
	);
}

function apiEquivalentEstimate(value: number): string {
	return `API-equivalent estimate ${usd(value)}`;
}

/**
 * A legacy subsidization point never shows a bare ratio unless `coverage` is
 * `"complete"`. `"partial"` or `"unknown"` coverage means the underlying
 * retained data or its data-completeness classification cannot support a
 * definitive comparison for this window, so the ratio (and any consecutive
 * delta, itself a difference of ratios) is withheld -- "not compared", the
 * same vocabulary {@link renderComparison} uses for the modern account-value
 * comparison. The two figures that would have produced the ratio,
 * `apiEquivalentEstimateUsd` and `apportionedSubscriptionUsd`, are always
 * still shown: only the ratio itself is suppressed, nothing is hidden.
 *
 * `deltaFromPrevious` (cost-report.ts's `withConsecutiveDeltas`) is a
 * difference of two ratios, so it is only ever as reliable as its weaker
 * side: it is shown only when both this point AND the immediately
 * preceding point in the same series have `coverage: "complete"`. A
 * complete point that follows a partial or unknown predecessor still shows
 * its own valid ratio, but the delta is withheld with an explicit reason
 * instead of silently bridging past the untrusted predecessor.
 */
function subsidyPoint(point: SubsidizationPoint, previous?: SubsidizationPoint): string {
	const period = `${iso(point.periodStartMs)} .. ${iso(point.periodEndMs)}`;
	if (point.status === "gap") return `${period}: gap`;
	if (point.status === "unpriced") {
		return `${period}: unpriced; coverage ${point.coverage}`;
	}
	const known = `${apiEquivalentEstimate(point.apiEquivalentEstimateUsd)} / apportioned subscription ${usd(point.apportionedSubscriptionUsd)}`;
	if (point.coverage !== "complete") {
		return `${period}: not compared (legacy-subsidization-${point.coverage}-coverage) — ${known}; coverage ${point.coverage}`;
	}
	const deltaBasisComplete =
		previous !== undefined && previous.status === "priced" && previous.coverage === "complete";
	const delta =
		point.deltaFromPrevious === undefined
			? ""
			: deltaBasisComplete
				? `; consecutive delta ${point.deltaFromPrevious >= 0 ? "+" : ""}${point.deltaFromPrevious.toFixed(4)}x`
				: "; consecutive delta withheld (legacy-subsidization-delta-predecessor-incomplete)";
	return `${period}: ${point.ratio.toFixed(4)}x (${known}); coverage ${point.coverage}${delta}`;
}

export function renderCostReport(report: CostReport): string {
	const lines: string[] = [
		`Cost intelligence — ${report.periodType} — generated ${iso(report.generatedAtMs)}`,
		...renderRequestedScopeSummary(report),
		...renderPeriod(report.current),
	];
	if (report.completed.length === 0) {
		lines.push("Completed periods: none available.");
	} else {
		lines.push("Completed periods:");
		for (const period of report.completed) {
			lines.push(...renderPeriod(period).map((line) => `  ${line}`));
		}
	}
	if (report.accountValue !== undefined && report.accountValue.length > 0) {
		lines.push(
			"Recorded account rate and allocated account cost by account (comparison figures only; never an invoice, payment, refund, tax record, or bank charge):",
		);
		for (const entry of report.accountValue) {
			lines.push(renderAccountValue(entry));
		}
	}
	if (report.subsidization.length > 0) {
		lines.push(
			"Subscription subsidization by account (legacy comparison using the superseded flat monthly figure; see recorded account rate above for the current method — not an actual subsidy, bill, or savings figure):",
		);
		for (const series of report.subsidization) {
			lines.push(
				`  ${series.canonicalAccountId}: monthly subscription ${usd(series.monthlySubscriptionUsd)}; completed ratio periods ${series.observedPeriods}`,
			);
			if (series.current !== undefined) {
				lines.push(`    current: ${subsidyPoint(series.current)}`);
			}
			for (const [index, point] of series.completed.entries()) {
				lines.push(`    ${subsidyPoint(point, series.completed[index - 1])}`);
			}
		}
	}
	if (report.legacyUnattributed.length > 0) {
		lines.push("Legacy unattributed retained cost (no project key):");
		for (const entry of report.legacyUnattributed) {
			lines.push(
				`  ${entry.canonicalAccountId}/${entry.requestedModel}: ${entry.observationCount} observations; ${tokenBreakdown(entry.tokens)}; Pi model-price estimate (retained provider cost ${usd(entry.retainedCostUsd)})`,
			);
		}
	}
	return lines.join("\n");
}
