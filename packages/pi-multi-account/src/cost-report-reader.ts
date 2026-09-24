import type { AccountRateRecord } from "./account-rate-history.js";
import type { PiCatalogSnapshot } from "./api-pricing.js";
import { isAllowedFamily, type MultiAccountConfig } from "./config.js";
import {
	classifyProviderId,
	isProviderSlotWithinAccountLimit,
} from "./discovery.js";
import {
	defaultCostDigestPaths,
	CostDigestStore,
} from "./cost-digest-store.js";
import {
	summarizeCostHistoryForReport,
	type CostDigestRow,
} from "./cost-digest.js";
import { buildCostReport, type CostReport } from "./cost-report.js";
import { iterateHistory } from "./history-store.js";
import { getPeriodBounds, PERIOD_TYPES, type PeriodType } from "./period-boundaries.js";
import {
	defaultPricingCachePaths,
	OpenRouterPricingCache,
} from "./pricing-cache.js";
import {
	resolveCustomRange,
	type GranularitySegment,
	type RetainedGranularity,
} from "./report-range.js";

/**
 * A request for the six existing calendar periods (a bare {@link PeriodType},
 * always UTC and byte-identical to the existing slash/tool compatibility
 * path), the same six periods with an explicit report timezone (the
 * `"period"` kind), an exact custom range described by raw `--from`/`--to`-
 * shaped bounds (see {@link resolveCustomRange}), or all available retained
 * history. A `"period"` request dispatches directly to
 * {@link buildCostReport}'s existing `periodType`/`timeZone` bounds path --
 * never through `"custom"` -- so a non-UTC named period keeps its correct
 * zoned calendar bounds and "current unfinished period" semantics (a
 * populated `completed` series, a still-open `current` period) instead of
 * collapsing to a single exact-bounds custom window. The reader resolves a
 * `"custom"` request's raw bounds and satisfiability against the real
 * retained store itself, exactly as {@link resolveCustomRange} and
 * {@link assertRangeSatisfiable} are documented to be used.
 */
export type CostReportRangeRequest =
	| PeriodType
	| {
			readonly kind: "period";
			readonly periodType: PeriodType;
			readonly timeZone?: string;
	  }
	| {
			readonly kind: "custom";
			readonly fromRaw: string;
			readonly toRaw: string;
			readonly timeZone?: string;
	  }
	| { readonly kind: "all-history" };

/**
 * Thrown when a `"custom"` {@link CostReportRangeRequest} fails syntax
 * validation or the retained store cannot satisfy its requested precision.
 * `exitCode` mirrors {@link ReportRangeResult}'s own stable exit codes (2 for
 * invalid syntax, 3 for unsatisfiable precision) so a later CLI layer can map
 * this exception onto its own process exit without re-deriving the reason.
 */
export class CostReportRangeRequestError extends Error {
	readonly exitCode: 2 | 3;
	constructor(exitCode: 2 | 3, reason: string) {
		super(reason);
		this.name = "CostReportRangeRequestError";
		this.exitCode = exitCode;
	}
}

export type CostReportReader = (request: CostReportRangeRequest) => CostReport;

/**
 * Projects a live `monthlySubscriptionUsd` map to the subset within the current
 * validated account limit.
 *
 * Each key is classified through `classifyProviderId()` and checked against
 * `isProviderSlotWithinAccountLimit(slot, accountLimit)` before its price is
 * copied. A key that does not classify or is above the current limit is dropped,
 * so an in-range-for-maximum key above the current configured limit, or a
 * hostile in-memory slot-33 key that bypassed config parsing, cannot activate a
 * subscription-value series in the report. The result is frozen and retains no
 * reference to the source object.
 */
export function projectMonthlySubscriptionUsdForReport(
	monthlySubscriptionUsd: Readonly<Record<string, number>>,
	accountLimit: number,
): Readonly<Record<string, number>> {
	const projected: Record<string, number> = {};
	for (const [providerId, monthlyCost] of Object.entries(monthlySubscriptionUsd)) {
		const slot = classifyProviderId({ providerId, credentialType: "unknown" });
		if (
			slot === null ||
			!isProviderSlotWithinAccountLimit(slot, accountLimit) ||
			// Subscription-only report sink: an owning-vendor-api `openai` cost key
			// must not enter the subscription-subsidization report, mirroring the
			// parseMonthlySubscriptionUsd config guard.
			!isAllowedFamily(slot.family)
		) {
			continue;
		}
		projected[providerId] = monthlyCost;
	}
	return Object.freeze(projected);
}

/**
 * Projects a live `accountRateHistory` map to the subset within the current
 * validated account limit, mirroring {@link projectMonthlySubscriptionUsdForReport}.
 * Each key is classified and checked against the same account-limit and
 * allowed-family guards before its records are copied, so a hostile
 * in-memory slot-33 key that bypassed config parsing cannot inject an
 * out-of-range account rate into the report. The result is frozen and
 * retains no reference to the source object.
 */
export function projectAccountRateHistoryForReport(
	accountRateHistory: Readonly<Record<string, readonly AccountRateRecord[]>>,
	accountLimit: number,
): Readonly<Record<string, readonly AccountRateRecord[]>> {
	const projected: Record<string, readonly AccountRateRecord[]> = {};
	for (const [providerId, records] of Object.entries(accountRateHistory)) {
		const slot = classifyProviderId({ providerId, credentialType: "unknown" });
		if (
			slot === null ||
			!isProviderSlotWithinAccountLimit(slot, accountLimit) ||
			!isAllowedFamily(slot.family)
		) {
			continue;
		}
		projected[providerId] = records;
	}
	return Object.freeze(projected);
}

const PERIOD_TYPE_RANK: ReadonlyMap<PeriodType, number> = new Map(
	PERIOD_TYPES.map((periodType, index) => [periodType, index]),
);

/**
 * Describes which granularity is actually retained across `[startMs, endMs)`,
 * derived from real, already-closed digest rows plus the still-open current
 * day's live per-response detail -- never from a fabricated or assumed
 * grain. A stretch covered by no digest row and outside the still-open
 * current day is a genuine coverage gap and is simply absent from the
 * result: {@link assertRangeSatisfiable} in `report-range.ts` then correctly
 * refuses to let a caller slice inside it, rather than this function
 * guessing a granularity for time nothing was ever retained at.
 *
 * A closed digest row is retained forever once written (the digest store
 * never deletes a child once a parent rollup exists), so an old day that was
 * closed while its underlying raw per-response records were still fresh
 * keeps reporting "day" granularity even long after those raw records
 * expired from the separate, bounded-retention raw history log -- this
 * function only reads the immutable digest rows and the live window, never
 * the raw log's own retention state.
 */
export function deriveRetainedGranularitySegments(input: {
	readonly digestRows: readonly CostDigestRow[];
	/** The start of the still-open current day, or `undefined` when no live window applies. */
	readonly liveRawFromMs: number | undefined;
	readonly nowMs: number;
}): readonly GranularitySegment[] {
	const boundaries = new Set<number>();
	for (const row of input.digestRows) {
		boundaries.add(row.periodStartMs);
		boundaries.add(row.periodEndMs);
	}
	if (input.liveRawFromMs !== undefined) {
		boundaries.add(input.liveRawFromMs);
		boundaries.add(input.nowMs);
	}
	const sorted = [...boundaries].sort((left, right) => left - right);
	const raw: Array<{
		readonly startMs: number;
		readonly endMs: number;
		readonly granularity: RetainedGranularity;
	}> = [];
	for (let index = 0; index < sorted.length - 1; index += 1) {
		const segStart = sorted[index]!;
		const segEnd = sorted[index + 1]!;
		if (segEnd <= segStart) continue;
		if (
			input.liveRawFromMs !== undefined &&
			segStart >= input.liveRawFromMs &&
			segEnd <= input.nowMs
		) {
			raw.push({ startMs: segStart, endMs: segEnd, granularity: "raw" });
			continue;
		}
		let finestRank: number | undefined;
		for (const row of input.digestRows) {
			if (row.periodStartMs > segStart || row.periodEndMs < segEnd) continue;
			const rank = PERIOD_TYPE_RANK.get(row.periodType);
			if (rank !== undefined && (finestRank === undefined || rank < finestRank)) {
				finestRank = rank;
			}
		}
		if (finestRank !== undefined) {
			raw.push({
				startMs: segStart,
				endMs: segEnd,
				granularity: PERIOD_TYPES[finestRank]!,
			});
		}
	}
	const merged: GranularitySegment[] = [];
	for (const segment of raw) {
		const previous = merged[merged.length - 1];
		if (
			previous !== undefined &&
			previous.granularity === segment.granularity &&
			previous.endMs === segment.startMs
		) {
			merged[merged.length - 1] = { ...previous, endMs: segment.endMs };
		} else {
			merged.push(segment);
		}
	}
	return merged;
}

export type RetainedHistoryCoverageReader = () => readonly GranularitySegment[];

/**
 * Bind {@link deriveRetainedGranularitySegments} to the current Pi agent
 * directory's real, immutable digest store -- the "all available history"
 * read path. Performs no network request and writes nothing.
 */
export function createDefaultRetainedHistoryCoverageReader(options: {
	readonly now?: () => number;
}): RetainedHistoryCoverageReader {
	const digestStore = new CostDigestStore({ path: defaultCostDigestPaths().path });
	const now = options.now ?? Date.now;
	return () => {
		const nowMs = now();
		const today = getPeriodBounds(nowMs, "day");
		return deriveRetainedGranularitySegments({
			digestRows: digestStore.read(),
			liveRawFromMs: today.startMs,
			nowMs,
		});
	};
}

/**
 * Bind the read-only cost-report surfaces to the current Pi agent directory.
 * The returned reader performs no network request and writes nothing; the
 * machine-leased period closer is invoked separately before this reader.
 */
export function createDefaultCostReportReader(options: {
	readonly config: () => Pick<
		MultiAccountConfig,
		"accountLimit" | "projectLabels" | "monthlySubscriptionUsd" | "accountRateHistory"
	>;
	readonly now?: () => number;
	/**
	 * Supplies Pi's installed model catalog cost data for per-response
	 * tier-aware pricing (see `api-pricing.ts`). This adapter never fetches or
	 * derives that snapshot itself; when omitted, the read path prices
	 * responses only from the retained OpenRouter rate snapshot, exactly as it
	 * did before per-response tier pricing existed.
	 */
	readonly piCatalog?: () => PiCatalogSnapshot | undefined;
}): CostReportReader {
	const digestStore = new CostDigestStore({ path: defaultCostDigestPaths().path });
	const pricingCache = new OpenRouterPricingCache({
		...defaultPricingCachePaths(),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const now = options.now ?? Date.now;
	// The same "all available history" read path a caller can bind directly
	// (see `createDefaultRetainedHistoryCoverageReader`'s own doc comment):
	// reused here so a "custom" request's satisfiability is checked against
	// the real retained store, never a caller-asserted or absent set of
	// segments.
	const coverageReader = createDefaultRetainedHistoryCoverageReader(
		options.now === undefined ? {} : { now: options.now },
	);
	return (request) => {
		const nowMs = now();
		const pricing = pricingCache.readStatus();
		const piCatalog = options.piCatalog?.();
		const history = summarizeCostHistoryForReport(
			iterateHistory("cost-delta"),
			nowMs,
			pricing,
			piCatalog,
		);
		const config = options.config();
		const baseInput = {
			digestRows: digestStore.read(),
			// Only today's still-open window has per-response raw detail left to
			// filter by; a resolved sub-day-precise range clipped inside today
			// (see `provisionalCurrentDayRows` in `cost-report.ts`) rebuilds its
			// provisional row from these instead of slicing the pre-aggregated
			// `currentDayDigestRows` below, which has no per-observation
			// timestamps left once summed.
			observations: history.currentDayObservations,
			gaps: history.currentDayGaps,
			currentDayDigestRows: history.currentDayRows,
			...(history.earliestAttributedObservedAtMs === undefined
				? {}
				: {
						earliestRawObservationAtMs:
							history.earliestAttributedObservedAtMs,
					}),
			rawAccountIds: history.accountIds,
			groupedLegacyUnattributed: history.legacyUnattributed,
			pricing,
			nowMs,
			projectLabels: config.projectLabels,
			monthlySubscriptionUsd: projectMonthlySubscriptionUsdForReport(
				config.monthlySubscriptionUsd,
				config.accountLimit,
			),
			accountRateHistory: projectAccountRateHistoryForReport(
				config.accountRateHistory ?? {},
				config.accountLimit,
			),
		} as const;

		if (typeof request === "string") {
			return buildCostReport({ ...baseInput, periodType: request });
		}
		if (request.kind === "period") {
			return buildCostReport({
				...baseInput,
				periodType: request.periodType,
				...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
			});
		}
		// `periodType` below is a nominal placeholder for both branches: neither
		// `buildCostReport`'s `"custom"` nor `"all-history"` range mode reads it
		// for bounds (see `BuildCostReportInput.range`); it only keeps
		// `CostReport.periodType`'s existing required shape until a later node
		// gives a range-mode report its own dedicated label.
		if (request.kind === "custom") {
			const resolved = resolveCustomRange({
				fromRaw: request.fromRaw,
				toRaw: request.toRaw,
				...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
				retainedGranularity: coverageReader(),
			});
			if (resolved.status !== "resolved") {
				throw new CostReportRangeRequestError(resolved.exitCode, resolved.reason);
			}
			return buildCostReport({
				...baseInput,
				periodType: "day",
				range: {
					kind: "custom",
					startMs: resolved.startMs,
					endMs: resolved.endMs,
				},
			});
		}
		return buildCostReport({
			...baseInput,
			periodType: "day",
			range: { kind: "all-history" },
		});
	};
}
