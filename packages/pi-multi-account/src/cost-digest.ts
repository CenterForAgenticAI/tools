import { createHash } from "node:crypto";
import {
	estimateApiEquivalentCost,
	estimatePiCatalogCost,
	lookupApiRate,
	lookupPiCatalogCost,
	OPENROUTER_METHOD_LIMITS,
	PI_CATALOG_METHOD_LIMITS,
	type ApiEquivalentMethod,
	type PiCatalogSnapshot,
} from "./api-pricing.js";
import type { HistoryLogRecord } from "./history-store.js";
import {
	getPeriodBounds,
	type PeriodBounds,
	type PeriodType,
} from "./period-boundaries.js";
import { isProjectKey } from "./project-identity.js";
import type { PricingCacheResult } from "./pricing-cache.js";
export type { ApiEquivalentMethod, PiCatalogSnapshot } from "./api-pricing.js";

const DAY_MS = 86_400_000;

export type CostCoverage = "complete" | "partial" | "unknown";

export interface CostObservation {
	readonly observedAtMs: number;
	readonly projectKey: string | undefined;
	readonly canonicalAccountId: string;
	readonly requestedModel: string;
	readonly status: CostCoverage;
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly cacheWrite1h: number;
	};
	readonly retainedCostUsd: number;
}

export interface CostHistoryGap {
	readonly startMs: number;
	readonly endMs: number;
}

export interface CostDigestRow {
	readonly schemaVersion: 1;
	readonly kind: "cost-period-digest";
	readonly id: string;
	readonly projectKey: string;
	readonly canonicalAccountId: string;
	readonly requestedModel: string;
	readonly periodType: PeriodType;
	readonly periodStartMs: number;
	readonly periodEndMs: number;
	readonly closedAtMs: number;
	readonly source: "raw" | "day-rollup" | "month-rollup";
	readonly childRowCount: number;
	readonly observationCount: number;
	readonly coverage: CostCoverage;
	readonly tokens: CostObservation["tokens"];
	readonly retainedCostUsd: number;
	readonly apiEquivalent:
		| {
				readonly status: "priced";
				readonly estimatedUsd: number;
				readonly rateAsOfMs: readonly number[];
				readonly sourceModelIds: readonly string[];
				readonly methods?: readonly ApiEquivalentMethod[];
		  }
		| {
				readonly status: "unpriced";
				readonly reason: string;
				readonly rateAsOfMs: readonly number[];
				readonly methods?: readonly ApiEquivalentMethod[];
		  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
	);
}

function boundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		!value.includes("\0")
	);
}

function parseObservation(record: HistoryLogRecord): CostObservation | undefined {
	if (record.recordType !== "cost-delta" || !isRecord(record.payload)) {
		return undefined;
	}
	const payload = record.payload;
	if (
		!validTimestamp(record.observedAtMs) ||
		!boundedString(payload.canonicalAccountId, 128) ||
		!boundedString(payload.requestedModel, 200) ||
		!isRecord(payload.tokens) ||
		!isRecord(payload.cost) ||
		!tokenCount(payload.tokens.input) ||
		!tokenCount(payload.tokens.output) ||
		!tokenCount(payload.tokens.cacheRead) ||
		!tokenCount(payload.tokens.cacheWrite) ||
		(payload.tokens.cacheWrite1h !== undefined &&
			!tokenCount(payload.tokens.cacheWrite1h)) ||
		!(["complete", "partial", "unknown", "unpriced"] as const).includes(
			payload.status as CostCoverage | "unpriced",
		) ||
		(payload.status !== "unpriced" &&
			(typeof payload.cost.total !== "number" ||
				!Number.isFinite(payload.cost.total) ||
				payload.cost.total < 0))
	) {
		return undefined;
	}
	const cacheWrite1h = (payload.tokens.cacheWrite1h as number | undefined) ?? 0;
	if (cacheWrite1h > payload.tokens.cacheWrite) return undefined;
	return {
		observedAtMs: record.observedAtMs,
		projectKey:
			typeof payload.projectKey === "string" &&
			isProjectKey(payload.projectKey)
				? payload.projectKey
				: undefined,
		canonicalAccountId: payload.canonicalAccountId,
		requestedModel: payload.requestedModel,
		status:
			payload.status === "unpriced"
				? "unknown"
				: (payload.status as CostCoverage),
		tokens: {
			input: payload.tokens.input,
			output: payload.tokens.output,
			cacheRead: payload.tokens.cacheRead,
			cacheWrite: payload.tokens.cacheWrite,
			cacheWrite1h,
		},
		retainedCostUsd:
			payload.status === "unpriced" ? 0 : (payload.cost.total as number),
	};
}

export function extractCostHistory(records: Iterable<HistoryLogRecord>): {
	readonly observations: readonly CostObservation[];
	readonly gaps: readonly CostHistoryGap[];
} {
	const observations: CostObservation[] = [];
	const gaps: CostHistoryGap[] = [];
	for (const record of records) {
		if (
			record.recordType === "gap" &&
			validTimestamp(record.gapStartMs) &&
			validTimestamp(record.gapEndMs) &&
			record.gapEndMs > record.gapStartMs
		) {
			gaps.push({ startMs: record.gapStartMs, endMs: record.gapEndMs });
			continue;
		}
		const observation = parseObservation(record);
		if (observation !== undefined) observations.push(observation);
	}
	return { observations, gaps };
}

function addReportCount(left: number, right: number): number {
	const total = left + right;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new RangeError("Cost report token total exceeds the safe integer range.");
	}
	return total;
}

function addReportTokens(
	left: CostObservation["tokens"],
	right: CostObservation["tokens"],
): CostObservation["tokens"] {
	return {
		input: addReportCount(left.input, right.input),
		output: addReportCount(left.output, right.output),
		cacheRead: addReportCount(left.cacheRead, right.cacheRead),
		cacheWrite: addReportCount(left.cacheWrite, right.cacheWrite),
		cacheWrite1h: addReportCount(left.cacheWrite1h, right.cacheWrite1h),
	};
}

function addReportUsd(left: number, right: number): number {
	const total = left + right;
	if (!Number.isFinite(total) || total < 0) {
		throw new RangeError(
			"Cost report USD total must remain finite and non-negative.",
		);
	}
	return total;
}

export interface CostHistoryReportSummary {
	readonly currentDayRows: readonly CostDigestRow[];
	/**
	 * Every attributed (project-keyed) raw observation for the still-open
	 * current day, in arrival order. Kept alongside the pre-aggregated
	 * {@link currentDayRows} so a caller needing a sub-day-precise window
	 * inside today (a custom range ending or starting before `nowMs`) can
	 * rebuild a correctly clipped provisional row instead of slicing the
	 * already-summed aggregate, which has no per-response timestamps left to
	 * slice by.
	 */
	readonly currentDayObservations: readonly CostObservation[];
	/** The same current-day gap set folded into {@link currentDayRows}'s coverage, exposed so a caller rebuilding a clipped provisional row from {@link currentDayObservations} preserves the same gap-aware coverage. */
	readonly currentDayGaps: readonly CostHistoryGap[];
	readonly earliestAttributedObservedAtMs: number | undefined;
	readonly accountIds: readonly string[];
	readonly legacyUnattributed: readonly {
		readonly canonicalAccountId: string;
		readonly requestedModel: string;
		readonly observationCount: number;
		readonly tokens: CostObservation["tokens"];
		readonly retainedCostUsd: number;
	}[];
}

/** Retain only current-day detail and grouped legacy totals needed by cost rendering. */
export function summarizeCostHistoryForReport(
	records: Iterable<HistoryLogRecord>,
	nowMs: number,
	pricing: PricingCacheResult,
	piCatalog?: PiCatalogSnapshot,
): CostHistoryReportSummary {
	if (!validTimestamp(nowMs)) {
		throw new RangeError("Cost report clock must be a finite timestamp.");
	}
	const day = getPeriodBounds(nowMs, "day");
	const currentDayGroups = new Map<string, RawCostGroup>();
	const accountIds = new Set<string>();
	const legacy = new Map<
		string,
		CostHistoryReportSummary["legacyUnattributed"][number]
	>();
	let earliestAttributedObservedAtMs: number | undefined;
	let currentDayGap = false;
	const currentDayObservations: CostObservation[] = [];
	for (const record of records) {
		if (
			record.recordType === "gap" &&
			validTimestamp(record.gapStartMs) &&
			validTimestamp(record.gapEndMs) &&
			record.gapEndMs > record.gapStartMs
		) {
			currentDayGap ||=
				record.gapStartMs < day.endMs && record.gapEndMs > day.startMs;
			continue;
		}
		const observation = parseObservation(record);
		if (observation === undefined) continue;
		accountIds.add(observation.canonicalAccountId);
		if (observation.projectKey === undefined) {
			const key = JSON.stringify([
				observation.canonicalAccountId,
				observation.requestedModel,
			]);
			const previous = legacy.get(key);
			legacy.set(
				key,
				previous === undefined
					? {
							canonicalAccountId: observation.canonicalAccountId,
							requestedModel: observation.requestedModel,
							observationCount: 1,
							tokens: observation.tokens,
							retainedCostUsd: observation.retainedCostUsd,
						}
					: {
							...previous,
							observationCount: addReportCount(previous.observationCount, 1),
							tokens: addReportTokens(previous.tokens, observation.tokens),
							retainedCostUsd: addReportUsd(
								previous.retainedCostUsd,
								observation.retainedCostUsd,
							),
						},
			);
			continue;
		}
		earliestAttributedObservedAtMs =
			earliestAttributedObservedAtMs === undefined
				? observation.observedAtMs
				: Math.min(earliestAttributedObservedAtMs, observation.observedAtMs);
		if (
			observation.observedAtMs >= day.startMs &&
			observation.observedAtMs < nowMs
		) {
			addRawObservation(currentDayGroups, observation, day.endMs);
			currentDayObservations.push(observation);
		}
	}
	const currentDayGaps: readonly CostHistoryGap[] = currentDayGap
		? [{ startMs: day.startMs, endMs: day.endMs }]
		: [];
	const currentDayRows = planClosedCostDigestGroups({
		groups: currentDayGroups,
		gaps: currentDayGaps,
		existingRows: [],
		pricing,
		...(piCatalog === undefined ? {} : { piCatalog }),
		nowMs: day.endMs,
		closedAtMs: nowMs,
	}).filter(
		(row) => row.periodType === "day" && row.periodStartMs === day.startMs,
	);
	return {
		currentDayRows,
		currentDayObservations,
		currentDayGaps,
		earliestAttributedObservedAtMs,
		accountIds: [...accountIds],
		legacyUnattributed: [...legacy.values()].sort(
			(left, right) =>
				left.canonicalAccountId.localeCompare(right.canonicalAccountId) ||
				left.requestedModel.localeCompare(right.requestedModel),
		),
	};
}

function identityKey(
	projectKey: string,
	canonicalAccountId: string,
	requestedModel: string,
	periodType: PeriodType,
	periodStartMs: number,
): string {
	return JSON.stringify([
		projectKey,
		canonicalAccountId,
		requestedModel,
		periodType,
		periodStartMs,
	]);
}

function digestId(identity: string): string {
	return `cost-digest-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function costDigestId(
	projectKey: string,
	canonicalAccountId: string,
	requestedModel: string,
	periodType: PeriodType,
	periodStartMs: number,
): string {
	return digestId(
		identityKey(
			projectKey,
			canonicalAccountId,
			requestedModel,
			periodType,
			periodStartMs,
		),
	);
}

function emptyTokens(): CostObservation["tokens"] {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

function addTokens(
	target: CostObservation["tokens"],
	value: CostObservation["tokens"],
): CostObservation["tokens"] {
	return addReportTokens(target, value);
}

function priceRaw(
	tokens: CostObservation["tokens"],
	canonicalAccountId: string,
	requestedModel: string,
	pricing: PricingCacheResult,
): CostDigestRow["apiEquivalent"] {
	if (pricing.state !== "fresh") {
		return {
			status: "unpriced",
			reason:
				pricing.state === "stale" ? "pricing-stale" : "pricing-unavailable",
			rateAsOfMs:
				pricing.state === "stale" ? [pricing.snapshot.fetchedAtMs] : [],
		};
	}
	const rate = lookupApiRate(
		pricing.snapshot,
		canonicalAccountId,
		requestedModel,
	);
	if (rate === undefined) {
		return {
			status: "unpriced",
			reason: "model-rate-missing",
			rateAsOfMs: [pricing.snapshot.fetchedAtMs],
		};
	}
	const estimate = estimateApiEquivalentCost(
		tokens,
		rate,
		pricing.snapshot.fetchedAtMs,
	);
	return estimate.status === "priced"
		? {
				status: "priced",
				estimatedUsd: estimate.totalUsd,
				rateAsOfMs: [estimate.rateAsOfMs],
				sourceModelIds: [estimate.sourceModelId],
			}
		: {
				status: "unpriced",
				reason: estimate.reason,
				rateAsOfMs: [pricing.snapshot.fetchedAtMs],
			};
}

type PricedObservationResult =
	| {
			readonly status: "priced";
			readonly totalUsd: number;
			readonly rateAsOfMs: number;
			readonly sourceModelId: string;
			readonly method: ApiEquivalentMethod;
	  }
	| { readonly status: "unpriced"; readonly reason: string };

/**
 * Price one response under its own matched tier, before any grouping.
 * Tries Pi's installed catalog first (the authoritative tier metadata
 * source); OpenRouter extends coverage only for models the catalog lacks.
 */
function priceObservationApiEquivalent(
	tokens: CostObservation["tokens"],
	canonicalAccountId: string,
	requestedModel: string,
	piCatalog: PiCatalogSnapshot,
	pricing: PricingCacheResult,
): PricedObservationResult {
	const catalogCost = lookupPiCatalogCost(
		piCatalog,
		canonicalAccountId,
		requestedModel,
	);
	if (catalogCost !== undefined) {
		const estimate = estimatePiCatalogCost(
			tokens,
			catalogCost,
			piCatalog.capturedAtMs,
		);
		if (estimate.status !== "priced") {
			return { status: "unpriced", reason: estimate.reason };
		}
		return {
			status: "priced",
			totalUsd: estimate.totalUsd,
			rateAsOfMs: estimate.rateAsOfMs,
			sourceModelId: estimate.sourceModelId,
			method: {
				source: "pi-installed-catalog",
				catalogVersion: piCatalog.catalogVersion,
				tierInputTokensAbove: estimate.tierInputTokensAbove,
				limits: PI_CATALOG_METHOD_LIMITS,
			},
		};
	}
	// Unsupported by the installed catalog: fall back to the cached OpenRouter
	// snapshot, which only extends coverage and never overrides the catalog.
	if (pricing.state !== "fresh") {
		return {
			status: "unpriced",
			reason:
				pricing.state === "stale" ? "pricing-stale" : "pricing-unavailable",
		};
	}
	const rate = lookupApiRate(pricing.snapshot, canonicalAccountId, requestedModel);
	if (rate === undefined) {
		return { status: "unpriced", reason: "model-rate-missing" };
	}
	const estimate = estimateApiEquivalentCost(tokens, rate, pricing.snapshot.fetchedAtMs);
	if (estimate.status !== "priced") {
		return { status: "unpriced", reason: estimate.reason };
	}
	return {
		status: "priced",
		totalUsd: estimate.totalUsd,
		rateAsOfMs: estimate.rateAsOfMs,
		sourceModelId: estimate.sourceModelId,
		method: {
			source: "openrouter",
			catalogVersion: `openrouter-snapshot-${pricing.snapshot.fetchedAtMs}`,
			tierInputTokensAbove: undefined,
			limits: OPENROUTER_METHOD_LIMITS,
		},
	};
}

function methodKey(method: ApiEquivalentMethod): string {
	return JSON.stringify([
		method.source,
		method.catalogVersion,
		method.tierInputTokensAbove ?? null,
	]);
}

function sortedMethods(
	methods: ReadonlyMap<string, ApiEquivalentMethod>,
): readonly ApiEquivalentMethod[] {
	return [...methods.values()].sort(
		(left, right) =>
			left.source.localeCompare(right.source) ||
			left.catalogVersion.localeCompare(right.catalogVersion) ||
			(left.tierInputTokensAbove ?? -1) - (right.tierInputTokensAbove ?? -1),
	);
}

/**
 * Price every response in a raw day group under its own matched tier before
 * summing into the group's total: REQ-TIER-PER-RESPONSE. A day mixing
 * responses below and above a tier threshold must never be priced as if the
 * whole day's tokens were one request.
 */
function priceRawPerResponse(
	group: RawCostGroup,
	piCatalog: PiCatalogSnapshot,
	pricing: PricingCacheResult,
): CostDigestRow["apiEquivalent"] {
	let estimatedUsd = 0;
	let unpriced = false;
	let reason: string | undefined;
	const rateAsOfMs = new Set<number>();
	const sourceModelIds = new Set<string>();
	const methods = new Map<string, ApiEquivalentMethod>();
	for (const tokens of group.observationTokens) {
		const priced = priceObservationApiEquivalent(
			tokens,
			group.canonicalAccountId,
			group.requestedModel,
			piCatalog,
			pricing,
		);
		if (priced.status === "unpriced") {
			unpriced = true;
			reason ??= priced.reason;
			continue;
		}
		estimatedUsd = addReportUsd(estimatedUsd, priced.totalUsd);
		rateAsOfMs.add(priced.rateAsOfMs);
		sourceModelIds.add(priced.sourceModelId);
		methods.set(methodKey(priced.method), priced.method);
	}
	if (unpriced) {
		return {
			status: "unpriced",
			reason: reason ?? "response-unpriced",
			rateAsOfMs: sortedUniqueNumbers([...rateAsOfMs]),
		};
	}
	return {
		status: "priced",
		estimatedUsd,
		rateAsOfMs: sortedUniqueNumbers([...rateAsOfMs]),
		sourceModelIds: sortedUniqueStrings([...sourceModelIds]),
		methods: sortedMethods(methods),
	};
}

function sortedUniqueNumbers(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function sortedUniqueStrings(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

function rollupPrice(
	children: readonly CostDigestRow[],
): CostDigestRow["apiEquivalent"] {
	const rateAsOfMs = sortedUniqueNumbers(
		children.flatMap((child) => child.apiEquivalent.rateAsOfMs),
	);
	if (children.some((child) => child.apiEquivalent.status === "unpriced")) {
		return { status: "unpriced", reason: "child-unpriced", rateAsOfMs };
	}
	const priced = children.filter(
		(child): child is CostDigestRow & {
			readonly apiEquivalent: Extract<
				CostDigestRow["apiEquivalent"],
				{ readonly status: "priced" }
			>;
		} => child.apiEquivalent.status === "priced",
	);
	return {
		status: "priced",
		estimatedUsd: priced.reduce(
			(total, child) => addReportUsd(total, child.apiEquivalent.estimatedUsd),
			0,
		),
		rateAsOfMs,
		sourceModelIds: sortedUniqueStrings(
			priced.flatMap((child) => child.apiEquivalent.sourceModelIds),
		),
	};
}

function rollupCoverage(
	children: readonly CostDigestRow[],
	expectedChildren: number,
): CostCoverage {
	if (
		children.length !== expectedChildren ||
		children.some((child) => child.coverage === "partial")
	) {
		return "partial";
	}
	return children.some((child) => child.coverage === "unknown")
		? "unknown"
		: "complete";
}

function expectedChildCount(
	periodType: Exclude<PeriodType, "day">,
	bounds: PeriodBounds,
): number {
	switch (periodType) {
		case "week":
			return 7;
		case "month":
			return Math.round((bounds.endMs - bounds.startMs) / 86_400_000);
		case "quarter":
			return 3;
		case "half-year":
			return 6;
		case "year":
			return 12;
	}
}

function parentRows(
	children: readonly CostDigestRow[],
	periodType: Exclude<PeriodType, "day">,
	source: "day-rollup" | "month-rollup",
	nowMs: number,
	closedAtMs: number,
	existingIds: Set<string>,
): CostDigestRow[] {
	const groups = new Map<
		string,
		{ readonly bounds: PeriodBounds; readonly children: CostDigestRow[] }
	>();
	for (const child of children) {
		const bounds = getPeriodBounds(child.periodStartMs, periodType);
		if (bounds.endMs > nowMs) continue;
		const key = identityKey(
			child.projectKey,
			child.canonicalAccountId,
			child.requestedModel,
			periodType,
			bounds.startMs,
		);
		const current = groups.get(key) ?? { bounds, children: [] };
		current.children.push(child);
		groups.set(key, current);
	}

	const rows: CostDigestRow[] = [];
	for (const group of groups.values()) {
		const first = group.children[0];
		if (first === undefined) continue;
		const id = costDigestId(
			first.projectKey,
			first.canonicalAccountId,
			first.requestedModel,
			periodType,
			group.bounds.startMs,
		);
		if (existingIds.has(id)) continue;
		const tokens = group.children.reduce(
			(total, child) => addTokens(total, child.tokens),
			emptyTokens(),
		);
		rows.push({
			schemaVersion: 1,
			kind: "cost-period-digest",
			id,
			projectKey: first.projectKey,
			canonicalAccountId: first.canonicalAccountId,
			requestedModel: first.requestedModel,
			periodType,
			periodStartMs: group.bounds.startMs,
			periodEndMs: group.bounds.endMs,
			closedAtMs,
			source,
			childRowCount: group.children.length,
			observationCount: group.children.reduce(
				(total, child) => addReportCount(total, child.observationCount),
				0,
			),
			coverage: rollupCoverage(
				group.children,
				expectedChildCount(periodType, group.bounds),
			),
			tokens,
			retainedCostUsd: group.children.reduce(
				(total, child) => addReportUsd(total, child.retainedCostUsd),
				0,
			),
			apiEquivalent: rollupPrice(group.children),
		});
		existingIds.add(id);
	}
	return rows;
}

interface RawCostGroup {
	readonly bounds: PeriodBounds;
	readonly projectKey: string;
	readonly canonicalAccountId: string;
	readonly requestedModel: string;
	tokens: CostObservation["tokens"];
	retainedCostUsd: number;
	observationCount: number;
	coverage: CostCoverage;
	/** Per-response token tuples in arrival order, priced individually before grouping. */
	readonly observationTokens: CostObservation["tokens"][];
}

function addRawObservation(
	groups: Map<string, RawCostGroup>,
	observation: CostObservation,
	nowMs: number,
): void {
	if (observation.projectKey === undefined) return;
	const bounds = getPeriodBounds(observation.observedAtMs, "day");
	if (bounds.endMs > nowMs) return;
	const key = identityKey(
		observation.projectKey,
		observation.canonicalAccountId,
		observation.requestedModel,
		"day",
		bounds.startMs,
	);
	const current = groups.get(key);
	if (current === undefined) {
		groups.set(key, {
			bounds,
			projectKey: observation.projectKey,
			canonicalAccountId: observation.canonicalAccountId,
			requestedModel: observation.requestedModel,
			tokens: observation.tokens,
			retainedCostUsd: observation.retainedCostUsd,
			observationCount: 1,
			coverage: observation.status,
			observationTokens: [observation.tokens],
		});
		return;
	}
	current.tokens = addReportTokens(current.tokens, observation.tokens);
	current.retainedCostUsd = addReportUsd(
		current.retainedCostUsd,
		observation.retainedCostUsd,
	);
	current.observationCount = addReportCount(current.observationCount, 1);
	current.observationTokens.push(observation.tokens);
	if (current.coverage !== "partial") {
		current.coverage =
			observation.status === "partial"
				? "partial"
				: current.coverage === "unknown" || observation.status === "unknown"
					? "unknown"
					: "complete";
	}
}

interface PlanCostDigestGroupsInput {
	readonly groups: ReadonlyMap<string, RawCostGroup>;
	readonly gaps: readonly CostHistoryGap[];
	readonly existingRows: readonly CostDigestRow[];
	readonly pricing: PricingCacheResult;
	readonly piCatalog?: PiCatalogSnapshot;
	readonly nowMs: number;
	readonly closedAtMs: number;
}

function planClosedCostDigestGroups(
	input: PlanCostDigestGroupsInput,
): readonly CostDigestRow[] {
	const existingIds = new Set(input.existingRows.map((row) => row.id));
	const newRows: CostDigestRow[] = [];
	for (const group of input.groups.values()) {
		const id = costDigestId(
			group.projectKey,
			group.canonicalAccountId,
			group.requestedModel,
			"day",
			group.bounds.startMs,
		);
		if (existingIds.has(id)) continue;
		const gapOverlaps = input.gaps.some(
			(gap) =>
				gap.startMs < group.bounds.endMs && gap.endMs > group.bounds.startMs,
		);
		newRows.push({
			schemaVersion: 1,
			kind: "cost-period-digest",
			id,
			projectKey: group.projectKey,
			canonicalAccountId: group.canonicalAccountId,
			requestedModel: group.requestedModel,
			periodType: "day",
			periodStartMs: group.bounds.startMs,
			periodEndMs: group.bounds.endMs,
			closedAtMs: input.closedAtMs,
			source: "raw",
			childRowCount: 0,
			observationCount: group.observationCount,
			coverage: gapOverlaps ? "partial" : group.coverage,
			tokens: group.tokens,
			retainedCostUsd: group.retainedCostUsd,
			apiEquivalent:
				input.piCatalog === undefined
					? priceRaw(
							group.tokens,
							group.canonicalAccountId,
							group.requestedModel,
							input.pricing,
						)
					: priceRawPerResponse(group, input.piCatalog, input.pricing),
		});
		existingIds.add(id);
	}

	const allRows = [...input.existingRows, ...newRows];
	const days = allRows.filter((row) => row.periodType === "day");
	const weeks = parentRows(
		days,
		"week",
		"day-rollup",
		input.nowMs,
		input.closedAtMs,
		existingIds,
	);
	const months = parentRows(
		days,
		"month",
		"day-rollup",
		input.nowMs,
		input.closedAtMs,
		existingIds,
	);
	newRows.push(...weeks, ...months);
	const allMonths = [...input.existingRows, ...newRows].filter(
		(row) => row.periodType === "month",
	);
	for (const periodType of ["quarter", "half-year", "year"] as const) {
		newRows.push(
			...parentRows(
				allMonths,
				periodType,
				"month-rollup",
				input.nowMs,
				input.closedAtMs,
				existingIds,
			),
		);
	}
	const order: Record<PeriodType, number> = {
		day: 0,
		week: 1,
		month: 2,
		quarter: 3,
		"half-year": 4,
		year: 5,
	};
	return newRows.sort(
		(left, right) =>
			left.periodEndMs - right.periodEndMs ||
			order[left.periodType] - order[right.periodType] ||
			left.id.localeCompare(right.id),
	);
}

function assertDigestClocks(nowMs: number, closedAtMs: number): void {
	if (!validTimestamp(nowMs) || !validTimestamp(closedAtMs)) {
		throw new RangeError("Cost digest clocks must be finite timestamps.");
	}
}

export function planClosedCostDigests(input: {
	readonly observations: readonly CostObservation[];
	readonly gaps: readonly CostHistoryGap[];
	readonly existingRows: readonly CostDigestRow[];
	readonly pricing: PricingCacheResult;
	readonly piCatalog?: PiCatalogSnapshot;
	readonly nowMs: number;
	readonly closedAtMs: number;
}): readonly CostDigestRow[] {
	assertDigestClocks(input.nowMs, input.closedAtMs);
	const groups = new Map<string, RawCostGroup>();
	for (const observation of input.observations) {
		addRawObservation(groups, observation, input.nowMs);
	}
	return planClosedCostDigestGroups({ ...input, groups });
}

export function planClosedCostDigestsFromHistory(input: {
	readonly readRecords: () => Iterable<HistoryLogRecord>;
	readonly existingRows: readonly CostDigestRow[];
	readonly pricing: PricingCacheResult;
	readonly piCatalog?: PiCatalogSnapshot;
	readonly nowMs: number;
	readonly closedAtMs: number;
}): readonly CostDigestRow[] {
	assertDigestClocks(input.nowMs, input.closedAtMs);
	const groups = new Map<string, RawCostGroup>();
	for (const record of input.readRecords()) {
		const observation = parseObservation(record);
		if (observation !== undefined) {
			addRawObservation(groups, observation, input.nowMs);
		}
	}

	if (groups.size > 0) {
		const groupsByDay = new Map<number, RawCostGroup[]>();
		for (const group of groups.values()) {
			const dayGroups = groupsByDay.get(group.bounds.startMs) ?? [];
			dayGroups.push(group);
			groupsByDay.set(group.bounds.startMs, dayGroups);
		}
		const dayStarts = [...groupsByDay.keys()].sort((left, right) => left - right);
		for (const record of input.readRecords()) {
			if (
				record.recordType !== "gap" ||
				!validTimestamp(record.gapStartMs) ||
				!validTimestamp(record.gapEndMs) ||
				record.gapEndMs <= record.gapStartMs
			) {
				continue;
			}
			let low = 0;
			let high = dayStarts.length;
			while (low < high) {
				const middle = Math.floor((low + high) / 2);
				const start = dayStarts[middle];
				if (start === undefined || start + DAY_MS > record.gapStartMs) {
					high = middle;
				} else {
					low = middle + 1;
				}
			}
			for (let index = low; index < dayStarts.length; index += 1) {
				const start = dayStarts[index];
				if (start === undefined || start >= record.gapEndMs) break;
				for (const group of groupsByDay.get(start) ?? []) {
					group.coverage = "partial";
				}
			}
		}
	}
	return planClosedCostDigestGroups({ ...input, groups, gaps: [] });
}

const PERIOD_COARSENESS: Readonly<Record<PeriodType, number>> = {
	year: 0,
	"half-year": 1,
	quarter: 2,
	month: 3,
	week: 4,
	day: 5,
};

function digestRowIdentityKey(row: CostDigestRow): string {
	return JSON.stringify([row.projectKey, row.canonicalAccountId, row.requestedModel]);
}

/**
 * Selects one non-overlapping retained representation per (project, account,
 * model) identity across `[rangeStartMs, rangeEndMs)`, so a report spanning
 * several granularities never double-counts an observation that is present
 * both in a raw/day row and in a coarser rollup that already absorbed it.
 *
 * Only rows fully contained in the requested range are candidates -- a row
 * that only partially overlaps the boundary is excluded rather than sliced,
 * since neither this function nor its callers may fabricate a sub-period
 * total a coarser rollup never recorded. Candidates are considered coarsest
 * first per identity; a candidate is accepted only when its interval does not
 * overlap an already-accepted interval for that same identity, so finer rows
 * fill exactly the gaps a coarser rollup left uncovered.
 */
export function selectNonOverlappingDigestRows(
	rows: readonly CostDigestRow[],
	rangeStartMs: number,
	rangeEndMs: number,
): readonly CostDigestRow[] {
	if (rangeEndMs <= rangeStartMs) return [];
	const byIdentity = new Map<string, CostDigestRow[]>();
	for (const row of rows) {
		if (row.periodStartMs < rangeStartMs || row.periodEndMs > rangeEndMs) continue;
		const key = digestRowIdentityKey(row);
		const list = byIdentity.get(key) ?? [];
		list.push(row);
		byIdentity.set(key, list);
	}
	const selected: CostDigestRow[] = [];
	for (const candidates of byIdentity.values()) {
		const sorted = [...candidates].sort(
			(left, right) =>
				PERIOD_COARSENESS[left.periodType] - PERIOD_COARSENESS[right.periodType] ||
				left.periodStartMs - right.periodStartMs,
		);
		const covered: Array<{ readonly startMs: number; readonly endMs: number }> = [];
		for (const row of sorted) {
			const overlapsCovered = covered.some(
				(interval) =>
					row.periodStartMs < interval.endMs && row.periodEndMs > interval.startMs,
			);
			if (overlapsCovered) continue;
			covered.push({ startMs: row.periodStartMs, endMs: row.periodEndMs });
			selected.push(row);
		}
	}
	return selected.sort(
		(left, right) =>
			left.periodStartMs - right.periodStartMs ||
			PERIOD_COARSENESS[left.periodType] - PERIOD_COARSENESS[right.periodType] ||
			left.id.localeCompare(right.id),
	);
}
