import {
	planClosedCostDigestsFromHistory,
	type CostDigestRow,
} from "./cost-digest.js";
import {
	CostDigestStore,
	defaultCostDigestPaths,
} from "./cost-digest-store.js";
import { iterateHistory, type HistoryLogRecord } from "./history-store.js";
import {
	acquireMachineLease,
	type MachineLeaseHandle,
} from "./machine-lease.js";
import { getPeriodBounds } from "./period-boundaries.js";
import {
	defaultPricingCachePaths,
	OpenRouterPricingCache,
	type PricingCacheResult,
} from "./pricing-cache.js";

export const COST_PERIOD_CLOSER_LEASE_TTL_MS = 60_000;

export interface CostPeriodCloserStore {
	read(): readonly CostDigestRow[];
	appendImmutable(
		rows: readonly CostDigestRow[],
		lease: MachineLeaseHandle,
	): number;
}

export type CostPeriodCloseResult =
	| { readonly status: "closed" | "no-op"; readonly appendedRows: number }
	| { readonly status: "lease-held"; readonly appendedRows: 0 }
	| { readonly status: "failed"; readonly appendedRows: number }
	| {
			readonly status: "skipped";
			readonly reason: "already-attempted-this-day";
	  };

interface CostPeriodCloserOptions {
	readonly store: CostPeriodCloserStore;
	readonly pricingCache: {
		refreshIfNeeded(): Promise<PricingCacheResult>;
	};
	readonly readCostHistory: () => Iterable<HistoryLogRecord>;
	readonly acquireLease: () => MachineLeaseHandle | undefined;
	readonly now: () => number;
}

function validTimestamp(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

export class CostPeriodCloser {
	readonly #store: CostPeriodCloserStore;
	readonly #pricingCache: CostPeriodCloserOptions["pricingCache"];
	readonly #readCostHistory: CostPeriodCloserOptions["readCostHistory"];
	readonly #acquireLease: CostPeriodCloserOptions["acquireLease"];
	readonly #now: CostPeriodCloserOptions["now"];
	#attemptedDayStartMs: number | undefined;

	constructor(options: CostPeriodCloserOptions) {
		this.#store = options.store;
		this.#pricingCache = options.pricingCache;
		this.#readCostHistory = options.readCostHistory;
		this.#acquireLease = options.acquireLease;
		this.#now = options.now;
	}

	async closeCompletedPeriods(): Promise<CostPeriodCloseResult> {
		let lease: MachineLeaseHandle | undefined;
		let appendedRows = 0;
		try {
			const nowMs = this.#now();
			if (!validTimestamp(nowMs)) return { status: "failed", appendedRows };
			lease = this.#acquireLease();
			if (lease === undefined) {
				return { status: "lease-held", appendedRows: 0 };
			}

			const pricing = await this.#pricingCache.refreshIfNeeded();
			const existingRows = this.#store.read();
			const plannedRows = planClosedCostDigestsFromHistory({
				readRecords: this.#readCostHistory,
				existingRows,
				pricing,
				nowMs,
				closedAtMs: nowMs,
			});
			if (plannedRows.length === 0) {
				return { status: "no-op", appendedRows: 0 };
			}

			appendedRows = this.#store.appendImmutable(plannedRows, lease);
			const persistedIds = new Set(this.#store.read().map((row) => row.id));
			if (!plannedRows.every((row) => persistedIds.has(row.id))) {
				return { status: "failed", appendedRows };
			}
			return { status: "closed", appendedRows };
		} catch {
			return { status: "failed", appendedRows };
		} finally {
			lease?.release();
		}
	}

	async closeBeforeRender(): Promise<CostPeriodCloseResult> {
		return this.closeCompletedPeriods();
	}

	async closeAfterObservation(
		observedAtMs: number,
	): Promise<CostPeriodCloseResult> {
		if (!validTimestamp(observedAtMs)) {
			return { status: "failed", appendedRows: 0 };
		}
		const dayStartMs = getPeriodBounds(observedAtMs, "day").startMs;
		if (
			this.#attemptedDayStartMs !== undefined &&
			dayStartMs <= this.#attemptedDayStartMs
		) {
			return {
				status: "skipped",
				reason: "already-attempted-this-day",
			};
		}
		this.#attemptedDayStartMs = dayStartMs;
		const result = await this.closeCompletedPeriods();
		if (result.status === "failed" && this.#attemptedDayStartMs === dayStartMs) {
			this.#attemptedDayStartMs = undefined;
		}
		return result;
	}
}

export function createDefaultCostPeriodCloser(options?: {
	readonly now?: () => number;
}): CostPeriodCloser {
	const now = options?.now ?? Date.now;
	const digestPaths = defaultCostDigestPaths();
	const pricingPaths = defaultPricingCachePaths();
	return new CostPeriodCloser({
		store: new CostDigestStore({ path: digestPaths.path }),
		pricingCache: new OpenRouterPricingCache({
			cachePath: pricingPaths.cachePath,
			lockPath: pricingPaths.lockPath,
			now,
		}),
		readCostHistory: () => iterateHistory("cost-delta"),
		acquireLease: () =>
			acquireMachineLease({
				lockPath: digestPaths.lockPath,
				ttlMs: COST_PERIOD_CLOSER_LEASE_TTL_MS,
				now,
				// A wedged digest lock would otherwise stop every period closure.
				reclaimMalformed: true,
			}),
		now,
	});
}
