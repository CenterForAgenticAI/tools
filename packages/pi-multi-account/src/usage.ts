import type { AllowedFamily } from "./config.js";
import { formatDuration } from "./duration.js";
import {
	EXHAUSTION_HOLD_MS,
	SHARED_USAGE_TTL_MS,
	type SharedUsageStore,
	type SharedUsageRateLimit,
	type SharedUsageSnapshot,
} from "./shared-usage.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";
// The one exhaustion rule, imported rather than restated. A second definition
// here would be a second notion of exhaustion, free to drift from the one
// selection enforces -- the drift this defect class has already produced twice.
// `routing.ts` does not import this module, so this adds no cycle.
import { snapshotIndicatesExhaustion } from "./routing.js";
import {
	iterateHistory,
	type HistoryRecordEnvelope,
} from "./history-store.js";
import type { CostRecordPayload } from "./cost-history.js";
import {
	readLatestWindowHistory,
	readWindowHistory,
	type WindowSample,
} from "./window-history.js";
import {
	computeCoverageState,
	type CoverageState,
} from "./coverage-attestation.js";

export interface TokenUsageObservation {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheCreationInputTokens?: number;
	readonly cacheReadInputTokens?: number;
}

export interface RateLimitObservation extends SharedUsageRateLimit {}

export interface UsageObservation {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly observedAtMs: number;
	readonly tokens?: TokenUsageObservation;
	readonly rateLimit?: RateLimitObservation;
}

export interface UsageSnapshot {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly snapshotAtMs: number;
	/** Present only for a peer-only snapshot read from the machine store. */
	readonly observationScope?: "session" | "fleet";
	readonly observerId?: string;
	readonly ageMs?: number;
	/**
	 * True when this snapshot is older than the shared store's freshness window
	 * and was returned only so an operator surface can show a retained reading
	 * instead of claiming no data exists. Routing must not treat it as current.
	 */
	readonly stale?: boolean;
	/** The latest fresh peer observation, retained alongside this session's data. */
	readonly fleetObserved?: FleetUsageSnapshot;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheCreationInputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly remainingRequests?: number;
	readonly remainingTokens?: number;
	readonly recoveryAtMs?: number;
	/**
	 * Largest `remainingRequests` seen for this account. Providers report what is
	 * LEFT but never the ceiling, so the peak is the only available proxy for a
	 * budget denominator. Monotonic within a window; a reset that reports a higher
	 * remaining count raises it.
	 */
	readonly observedPeakRequests?: number;
	/** Largest `remainingTokens` seen for this account. See observedPeakRequests. */
	readonly observedPeakTokens?: number;
	readonly utilization?: number;
	/** When utilization itself was observed; token-only updates do not advance it. */
	readonly utilizationObservedAtMs?: number;
	/** When the cohesive rate-limit observation was recorded. */
	readonly quotaObservedAtMs?: number;
	readonly utilizationSource?: RateLimitObservation["utilizationSource"];
}

export interface FleetUsageSnapshot {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly snapshotAtMs: number;
	readonly ageMs: number;
	readonly observerId: string;
	readonly remainingRequests?: number;
	readonly remainingTokens?: number;
	readonly recoveryAtMs?: number;
	readonly utilization?: number;
	readonly utilizationSource?: RateLimitObservation["utilizationSource"];
}

export type UsageQuotaProjection =
	| Readonly<{
			status: "fresh";
			utilization?: number;
			remainingRequests?: number;
			remainingTokens?: number;
			recoveryAtMs?: number;
	  }>
	| Readonly<{ status: "stale" }>
	| Readonly<{ status: "missing" }>;

type CohesiveQuotaObservation = Readonly<{
	observedAtMs: number;
	remainingRequests?: number;
	remainingTokens?: number;
	recoveryAtMs?: number;
	utilization?: number;
	utilizationSource?: RateLimitObservation["utilizationSource"];
}>;

type QuotaSelection = Readonly<{
	projection: UsageQuotaProjection;
	candidate?: CohesiveQuotaObservation;
}>;

const TOKEN_FIELDS = [
	"inputTokens",
	"outputTokens",
	"cacheCreationInputTokens",
	"cacheReadInputTokens",
] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];

function count(value: number | undefined, name: string): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

function optionalCount(
	value: number | undefined,
	name: string,
): number | undefined {
	if (value === undefined) return undefined;
	return count(value, name);
}

function optionalTimestamp(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(
			"recoveryAtMs must be a finite non-negative timestamp.",
		);
	}
	return value;
}

/** Retains the largest observed value, ignoring absent readings. */
function highWaterMark(
	next: number | undefined,
	previous: number | undefined,
): number | undefined {
	if (next === undefined) return previous;
	if (previous === undefined) return next;
	return Math.max(next, previous);
}

function validDisplayUtilization(value: number | undefined): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function validDisplayCount(value: number | undefined): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validDisplayRecovery(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasQuotaEvidence(candidate: CohesiveQuotaObservation): boolean {
	return (
		candidate.remainingRequests !== undefined ||
		candidate.remainingTokens !== undefined ||
		candidate.recoveryAtMs !== undefined ||
		candidate.utilization !== undefined ||
		candidate.utilizationSource !== undefined
	);
}

function compareOptionalCount(
	left: number | undefined,
	right: number | undefined,
): number {
	const leftRanked = validDisplayCount(left);
	const rightRanked = validDisplayCount(right);
	if (leftRanked && !rightRanked) return -1;
	if (!leftRanked && rightRanked) return 1;
	if (!leftRanked || !rightRanked) return 0;
	return left - right;
}

function selectDisplayCandidate(
	candidates: readonly CohesiveQuotaObservation[],
): CohesiveQuotaObservation | undefined {
	const utilizationCandidates = candidates.filter((candidate) =>
		validDisplayUtilization(candidate.utilization),
	);
	if (utilizationCandidates.length > 0) {
		return utilizationCandidates.reduce((selected, candidate) => {
			if ((candidate.utilization ?? 0) > (selected.utilization ?? 0)) return candidate;
			if (
				candidate.utilization === selected.utilization &&
				candidate.observedAtMs > selected.observedAtMs
			) {
				return candidate;
			}
			return selected;
		});
	}
	const countCandidates = candidates.filter(
		(candidate) =>
			validDisplayCount(candidate.remainingRequests) ||
			validDisplayCount(candidate.remainingTokens),
	);
	if (countCandidates.length === 0) return undefined;
	return countCandidates.reduce((selected, candidate) => {
		const requestOrder = compareOptionalCount(
			candidate.remainingRequests,
			selected.remainingRequests,
		);
		if (requestOrder < 0) return candidate;
		if (requestOrder > 0) return selected;
		const tokenOrder = compareOptionalCount(
			candidate.remainingTokens,
			selected.remainingTokens,
		);
		if (tokenOrder < 0) return candidate;
		if (tokenOrder > 0) return selected;
		return candidate.observedAtMs > selected.observedAtMs ? candidate : selected;
	});
}

function projectionFromCandidate(
	candidate: CohesiveQuotaObservation,
): UsageQuotaProjection {
	return {
		status: "fresh",
		...(validDisplayUtilization(candidate.utilization)
			? { utilization: candidate.utilization }
			: {}),
		...(validDisplayCount(candidate.remainingRequests)
			? { remainingRequests: candidate.remainingRequests }
			: {}),
		...(validDisplayCount(candidate.remainingTokens)
			? { remainingTokens: candidate.remainingTokens }
			: {}),
		...(validDisplayRecovery(candidate.recoveryAtMs)
			? { recoveryAtMs: candidate.recoveryAtMs }
			: {}),
	};
}

function selectQuotaProjection(
	candidates: readonly CohesiveQuotaObservation[],
	nowMs: number,
): QuotaSelection {
	const quotaCandidates = candidates.filter(hasQuotaEvidence);
	if (quotaCandidates.length === 0) return { projection: { status: "missing" } };
	const freshCandidates = quotaCandidates.filter(
		(candidate) => nowMs - candidate.observedAtMs <= SHARED_USAGE_TTL_MS,
	);
	const selected = selectDisplayCandidate(freshCandidates);
	if (selected !== undefined) {
		return { projection: projectionFromCandidate(selected), candidate: selected };
	}
	const retained = selectDisplayCandidate(quotaCandidates) ??
		quotaCandidates.reduce((newest, candidate) =>
			candidate.observedAtMs > newest.observedAtMs ? candidate : newest,
		);
	return { projection: { status: "stale" }, candidate: retained };
}

function quotaFromShared(
	snapshot: SharedUsageSnapshot | undefined,
): CohesiveQuotaObservation | undefined {
	if (snapshot === undefined) return undefined;
	return {
		observedAtMs: snapshot.snapshotAtMs,
		...(snapshot.remainingRequests === undefined
			? {}
			: { remainingRequests: snapshot.remainingRequests }),
		...(snapshot.remainingTokens === undefined
			? {}
			: { remainingTokens: snapshot.remainingTokens }),
		...(snapshot.recoveryAtMs === undefined
			? {}
			: { recoveryAtMs: snapshot.recoveryAtMs }),
		...(snapshot.utilization === undefined
			? {}
			: { utilization: snapshot.utilization }),
		...(snapshot.utilizationSource === undefined
			? {}
			: { utilizationSource: snapshot.utilizationSource }),
	};
}

function checkedTotal(
	previous: number,
	increment: number,
	name: string,
): number {
	const total = previous + increment;
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new RangeError(
			`${name} cumulative total exceeds safe integer range.`,
		);
	}
	return total;
}

/** Process-local aggregate ledger; no per-turn or content-bearing records. */
export class UsageLedger {
	readonly #snapshots = new Map<string, UsageSnapshot>();
	readonly #quotaObservations = new Map<string, CohesiveQuotaObservation>();
	/**
	 * Accounts whose exhaustion holds this process ignores, and from when.
	 *
	 * The operator's `clear` must reach every automatic path, and a durable
	 * exhaustion hold is one. But a hold is machine-global: deleting the record
	 * would revoke it for every other session on the machine, and those peers
	 * may still be refusing work on that account. So the override is
	 * PROCESS-LOCAL -- this session stops honouring holds installed up to the
	 * moment of the clear, and peers keep theirs.
	 *
	 * Stored as the clear time rather than a boolean so a LATER failure still
	 * installs a hold this session honours. A boolean would make one `clear`
	 * exempt the account from exhaustion holds for the life of the process,
	 * which is a permanent effect from a transient instruction.
	 */
	readonly #holdOverrides = new Map<string, number>();
	readonly #sharedStore: SharedUsageStore | undefined;
	readonly #now: () => number;

	constructor(
		options: {
			readonly sharedStore?: SharedUsageStore;
			readonly now?: () => number;
		} = {},
	) {
		this.#sharedStore = options.sharedStore;
		this.#now = options.now ?? Date.now;
	}

	record(observation: UsageObservation): UsageSnapshot {
		if (
			!isCanonicalManagedProviderId(observation.providerId, observation.family)
		) {
			throw new TypeError(
				"usage providerId must be canonical for its managed family.",
			);
		}
		if (
			!Number.isFinite(observation.observedAtMs) ||
			observation.observedAtMs < 0
		) {
			throw new TypeError(
				"observedAtMs must be a finite non-negative timestamp.",
			);
		}
		const previous = this.#snapshots.get(observation.providerId);
		if (previous && previous.family !== observation.family) {
			throw new TypeError(
				"provider family cannot change within a usage ledger.",
			);
		}

		const increments = Object.fromEntries(
			TOKEN_FIELDS.map((field) => [
				field,
				count(observation.tokens?.[field], field),
			]),
		) as Record<TokenField, number>;
		const remainingRequests = optionalCount(
			observation.rateLimit?.remainingRequests,
			"remainingRequests",
		);
		const remainingTokens = optionalCount(
			observation.rateLimit?.remainingTokens,
			"remainingTokens",
		);
		const recoveryAtMs = optionalTimestamp(observation.rateLimit?.recoveryAtMs);
		const previousQuota = this.#quotaObservations.get(observation.providerId);
		const acceptsQuota =
			observation.rateLimit !== undefined &&
			(previousQuota === undefined || observation.observedAtMs >= previousQuota.observedAtMs);
		const nextQuota: CohesiveQuotaObservation | undefined = acceptsQuota
			? Object.freeze({
					observedAtMs: observation.observedAtMs,
					...(remainingRequests === undefined ? {} : { remainingRequests }),
					...(remainingTokens === undefined ? {} : { remainingTokens }),
					...(recoveryAtMs === undefined ? {} : { recoveryAtMs }),
					...(observation.rateLimit?.utilization === undefined
						? {}
						: { utilization: observation.rateLimit.utilization }),
					...(observation.rateLimit?.utilizationSource === undefined
						? {}
						: { utilizationSource: observation.rateLimit.utilizationSource }),
				})
			: previousQuota;
		const latestRemainingRequests = nextQuota?.remainingRequests;
		const latestRemainingTokens = nextQuota?.remainingTokens;
		const latestRecoveryAtMs = nextQuota?.recoveryAtMs;
		const latestUtilization = nextQuota?.utilization;
		const latestUtilizationSource = nextQuota?.utilizationSource;
		const latestUtilizationObservedAtMs =
			latestUtilization === undefined ? undefined : nextQuota?.observedAtMs;
		const snapshotAtMs = Math.max(
			observation.observedAtMs,
			previous?.snapshotAtMs ?? observation.observedAtMs,
		);
		const peakRequests = highWaterMark(
			latestRemainingRequests,
			previous?.observedPeakRequests,
		);
		const peakTokens = highWaterMark(
			latestRemainingTokens,
			previous?.observedPeakTokens,
		);
		const totals = Object.fromEntries(
			TOKEN_FIELDS.map((field) => [
				field,
				checkedTotal(previous?.[field] ?? 0, increments[field], field),
			]),
		) as Record<TokenField, number>;

		const snapshot: UsageSnapshot = Object.freeze({
			providerId: observation.providerId,
			family: observation.family,
			snapshotAtMs,
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			cacheCreationInputTokens: totals.cacheCreationInputTokens,
			cacheReadInputTokens: totals.cacheReadInputTokens,
			...(latestRemainingRequests === undefined
				? {}
				: { remainingRequests: latestRemainingRequests }),
			...(latestRemainingTokens === undefined
				? {}
				: { remainingTokens: latestRemainingTokens }),
			...(latestRecoveryAtMs === undefined
				? {}
				: { recoveryAtMs: latestRecoveryAtMs }),
			...(peakRequests === undefined
				? {}
				: { observedPeakRequests: peakRequests }),
			...(peakTokens === undefined ? {} : { observedPeakTokens: peakTokens }),
			...(latestUtilization === undefined
				? {}
				: { utilization: latestUtilization }),
			...(latestUtilizationObservedAtMs === undefined
				? {}
				: { utilizationObservedAtMs: latestUtilizationObservedAtMs }),
			...(nextQuota === undefined
				? {}
				: { quotaObservedAtMs: nextQuota.observedAtMs }),
			...(latestUtilizationSource === undefined
				? {}
				: { utilizationSource: latestUtilizationSource }),
		});
		this.#snapshots.set(observation.providerId, snapshot);
		if (nextQuota !== undefined) {
			this.#quotaObservations.set(observation.providerId, nextQuota);
		}
		try {
			this.#sharedStore?.append({
				providerId: observation.providerId,
				family: observation.family,
				observedAtMs: observation.observedAtMs,
				observerId: this.#sharedStore.observerId,
				...(observation.tokens === undefined
					? {}
					: { tokens: observation.tokens }),
				...(observation.rateLimit === undefined
					? {}
					: { rateLimit: observation.rateLimit }),
			});
		} catch {
			// Shared state is an optimization; a failed append never fails a turn.
		}
		return snapshot;
	}

	#quotaSelection(
		providerId: string,
		family: AllowedFamily,
		nowMs: number,
	): QuotaSelection {
		const aggregate = this.#sharedStore?.aggregate(providerId, family, nowMs);
		const candidates = [
			this.#quotaObservations.get(providerId),
			quotaFromShared(aggregate?.session),
			quotaFromShared(aggregate?.fleet),
			quotaFromShared(aggregate?.stale),
		].filter((candidate): candidate is CohesiveQuotaObservation => candidate !== undefined);
		return selectQuotaProjection(candidates, nowMs);
	}

	quotaDisplay(providerId: string, nowMs = this.#now()): UsageQuotaProjection {
		if (!Number.isFinite(nowMs) || nowMs < 0) return { status: "missing" };
		const family = this.#snapshots.get(providerId)?.family ?? this.#familyForProvider(providerId);
		if (family === undefined) return { status: "missing" };
		return this.#quotaSelection(providerId, family, nowMs).projection;
	}

	hasFreshHeaderObservation(
		providerId: string,
		family: AllowedFamily,
		nowMs = this.#now(),
	): boolean {
		if (!Number.isFinite(nowMs) || nowMs < 0) return false;
		const aggregate = this.#sharedStore?.aggregate(providerId, family, nowMs);
		const candidates = [
			this.#quotaObservations.get(providerId),
			quotaFromShared(aggregate?.session),
			quotaFromShared(aggregate?.fleet),
		].filter((candidate): candidate is CohesiveQuotaObservation => candidate !== undefined);
		return candidates.some(
			(candidate) =>
				candidate.utilizationSource === "rate-limit-header" &&
				nowMs - candidate.observedAtMs <= SHARED_USAGE_TTL_MS,
		);
	}

	get(providerId: string): UsageSnapshot | undefined {
		const local = this.#snapshots.get(providerId);
		const family = local?.family ?? this.#familyForProvider(providerId);
		if (family === undefined) return local;
		if (this.#sharedStore === undefined && !this.#quotaObservations.has(providerId)) {
			return local;
		}
		const nowMs = this.#now();
		const aggregate = this.#sharedStore?.aggregate(providerId, family, nowMs);
		const sharedBase = aggregate?.session ?? aggregate?.fleet ?? aggregate?.stale;
		if (local === undefined && sharedBase === undefined) return undefined;

		const source: UsageSnapshot = local ?? {
			providerId: sharedBase!.providerId,
			family: sharedBase!.family,
			snapshotAtMs: sharedBase!.snapshotAtMs,
			observationScope: aggregate?.session === sharedBase ? "session" : "fleet",
			observerId: sharedBase!.observerId,
			ageMs: sharedBase!.ageMs,
			inputTokens: sharedBase!.inputTokens,
			outputTokens: sharedBase!.outputTokens,
			cacheCreationInputTokens: sharedBase!.cacheCreationInputTokens,
			cacheReadInputTokens: sharedBase!.cacheReadInputTokens,
		};
		const {
			remainingRequests: _remainingRequests,
			remainingTokens: _remainingTokens,
			recoveryAtMs: _recoveryAtMs,
			utilization: _utilization,
			utilizationObservedAtMs: _utilizationObservedAtMs,
			quotaObservedAtMs: _quotaObservedAtMs,
			utilizationSource: _utilizationSource,
			stale: _stale,
			fleetObserved: _fleetObserved,
			...base
		} = source;
		const selection = this.#quotaSelection(providerId, family, nowMs);
		const candidate = selection.candidate;
		const fleet = aggregate?.fleet;
		return {
			...base,
			...(selection.projection.status === "stale" ? { stale: true } : {}),
			...(candidate === undefined
				? {}
				: {
						quotaObservedAtMs: candidate.observedAtMs,
						...(validDisplayCount(candidate.remainingRequests)
							? { remainingRequests: candidate.remainingRequests }
							: {}),
						...(validDisplayCount(candidate.remainingTokens)
							? { remainingTokens: candidate.remainingTokens }
							: {}),
						...(validDisplayRecovery(candidate.recoveryAtMs)
							? { recoveryAtMs: candidate.recoveryAtMs }
							: {}),
						...(validDisplayUtilization(candidate.utilization)
							? {
									utilization: candidate.utilization,
									utilizationObservedAtMs: candidate.observedAtMs,
								}
							: {}),
						...(candidate.utilizationSource === undefined
							? {}
							: { utilizationSource: candidate.utilizationSource }),
					}),
			...(local === undefined || fleet === undefined
				? {}
				: {
						fleetObserved: {
							providerId: fleet.providerId,
							family: fleet.family,
							snapshotAtMs: fleet.snapshotAtMs,
							ageMs: fleet.ageMs,
							observerId: fleet.observerId,
							...(fleet.remainingRequests === undefined
								? {}
								: { remainingRequests: fleet.remainingRequests }),
							...(fleet.remainingTokens === undefined
								? {}
								: { remainingTokens: fleet.remainingTokens }),
							...(fleet.recoveryAtMs === undefined
								? {}
								: { recoveryAtMs: fleet.recoveryAtMs }),
							...(fleet.utilization === undefined
								? {}
								: { utilization: fleet.utilization }),
							...(fleet.utilizationSource === undefined
								? {}
								: { utilizationSource: fleet.utilizationSource }),
						},
					}),
		};
	}

	/**
	 * The usage reading ROUTING must consult before it spends a turn.
	 *
	 * Routing used to read a `fleetUsage` method that returned
	 * `aggregate().fleet`, which is peer-only by definition, so a session could
	 * not avoid the account it had itself just measured as spent: it polled the
	 * usage endpoint, recorded utilization 1 with a recovery three days out, and
	 * routed the next turn straight back to that account because its own reading
	 * was invisible to selection. Observed live on `openai-codex`, twice in
	 * ninety seconds, while the operator surface showed the truth at the same
	 * instant (#97). That method is gone; this is its replacement.
	 *
	 * NEITHER OBSERVER WINS BY POSITION. `session ?? fleet` would close that
	 * defect and open its mirror image: a healthy self-reading would hide a
	 * fresh peer reading that says the account is spent, which is a route the
	 * old peer-only read would have refused. `fleet ?? session` restores the
	 * original defect. There is no safe positional order, so the two fresh readings are
	 * arbitrated by WHAT THEY SAY: whichever reports exhaustion is believed.
	 *
	 * That follows the same instinct as {@link selectDisplayCandidate}, which
	 * prefers the most exhausted fresh reading rather than the closest one --
	 * added after a live account showed `0% used` from a local response while
	 * its fresh endpoint record said `0% left`. Routing deserves at least the
	 * caution the display already has.
	 *
	 * NOT the same rule, though, and the difference is deliberate.
	 * `selectDisplayCandidate` ranks by utilization and ignores count-only
	 * candidates whenever any utilization candidate exists, because it is
	 * choosing one number to show. This asks a yes-or-no question through
	 * `snapshotIndicatesExhaustion`, for which a remaining count of zero is
	 * exhaustion just as much as a utilization of 1. A reading the display would
	 * pass over can still decide a route.
	 *
	 * `durableExhaustion` outranks both: it is the only element that survives
	 * the TTL, and a fresher token-only record must not displace a known future
	 * recovery.
	 *
	 * `stale` is deliberately excluded. Beyond a durable recovery time a
	 * retained reading is presentational; letting an hour-old token count gate
	 * routing would be a new defect rather than a fix.
	 */
	routingUsage(
		providerId: string,
		family: AllowedFamily,
		nowMs = this.#now(),
	): SharedUsageSnapshot | undefined {
		const aggregate = this.#sharedStore?.aggregate(providerId, family, nowMs);
		if (aggregate?.durableExhaustion !== undefined) {
			return aggregate.durableExhaustion;
		}
		const session = aggregate?.session;
		const fleet = aggregate?.fleet;
		if (session === undefined) return fleet;
		if (fleet === undefined) return session;
		// Exhaustion is the claim worth acting on, so a reading that reports it
		// is believed over one that does not, whoever observed it. With both or
		// neither exhausted, our own reading is the more direct evidence.
		if (
			snapshotIndicatesExhaustion(fleet, nowMs, "all-observed") &&
			!snapshotIndicatesExhaustion(session, nowMs, "all-observed")
		) {
			return fleet;
		}
		return session;
	}

	/**
	 * End of an active exhaustion hold for this account, or undefined.
	 *
	 * Deliberately separate from `routingUsage`. A hold is not a usage reading
	 * and must not compete with one for selection: it says "requests were being
	 * refused recently" while a snapshot says "this is what the window looked
	 * like". Routing takes the later of this and any authoritative recovery
	 * time, so returning it alongside the snapshot keeps both facts intact
	 * rather than having one silently win.
	 */
	activeExhaustionHoldUntilMs(
		providerId: string,
		family: AllowedFamily,
		nowMs = this.#now(),
	): number | undefined {
		const holdUntilMs = this.#sharedStore?.activeExhaustionHoldUntilMs(
			providerId,
			family,
			nowMs,
		);
		if (holdUntilMs === undefined) return undefined;
		// An operator `clear` in THIS process stops us honouring holds that were
		// already installed when it ran. A hold from a LATER failure is honoured
		// again: the override is a point in time, not a permanent exemption.
		// Peers keep honouring the record either way, because it is not deleted.
		//
		// `holdUntilMs - EXHAUSTION_HOLD_MS` recovers the failure time from the
		// reported deadline without a second store read. The writer always sets
		// exactly that span (asserted by the hold-duration test), and the
		// store's own read bound refuses any record claiming more.
		const clearedAtMs = this.#holdOverrides.get(providerId);
		if (
			clearedAtMs !== undefined &&
			holdUntilMs - EXHAUSTION_HOLD_MS <= clearedAtMs
		) {
			return undefined;
		}
		return holdUntilMs;
	}

	/**
	 * Installs a bounded hold after the provider refused a request for quota or
	 * rate-limit reasons.
	 *
	 * Called at the accepted terminal classification rather than at settlement,
	 * so the hold is visible to peers as soon as the failure is known.
	 *
	 * ONLY for a refusal that carries no recovery time. When the provider says
	 * when it will recover -- `retry-after`, or a reset timestamp -- that is
	 * authoritative and a 60-minute guess must not override it. A `retry-after: 5`
	 * response means five seconds, and holding that account for an hour would
	 * shrink the usable fleet on a refusal the provider already told us was
	 * momentary. The hold exists for the silent case, where nothing says when to
	 * come back.
	 *
	 * Fail-soft like every other shared-store write: a hold that cannot be
	 * persisted degrades to today's behaviour, and must never fail the turn that
	 * discovered the exhaustion.
	 */
	recordExhaustionHold(
		providerId: string,
		family: AllowedFamily,
		failedAtMs: number,
	): void {
		try {
			this.#sharedStore?.append({
				recordType: "usage-exhaustion-hold",
				tokens: null,
				providerId,
				family,
				observedAtMs: failedAtMs,
				observerId: this.#sharedStore.observerId,
				failedAtMs,
				holdUntilMs: failedAtMs + EXHAUSTION_HOLD_MS,
			});
		} catch {
			// Shared state is an optimization; a failed append never fails a turn.
		}
	}

	#familyForProvider(providerId: string): AllowedFamily | undefined {
		if (isCanonicalManagedProviderId(providerId, "anthropic"))
			return "anthropic";
		if (isCanonicalManagedProviderId(providerId, "openai-codex"))
			return "openai-codex";
		// Without this, `get()` on an account this process never itself recorded
		// (a peer process's antigravity slot, or a cold read before this process's
		// first poll) fell through to `return local` at line ~545 while `local` was
		// still undefined -- silently hiding real shared/fleet quota data rather
		// than reading it, for this family alone.
		if (isCanonicalManagedProviderId(providerId, "google-antigravity"))
			return "google-antigravity";
		return undefined;
	}

	snapshots(): readonly UsageSnapshot[] {
		return [...this.#snapshots.values()];
	}

	/**
	 * Clears process-local usage state for an account, or every account.
	 *
	 * Also stops this process honouring exhaustion holds already installed for
	 * those accounts. The shared records are deliberately NOT deleted: they are
	 * machine-global, and peers may still be taking refusals on that account.
	 * An operator clearing state in one session should not silently revoke a
	 * hold another session is relying on.
	 */
	clear(providerId?: string, nowMs = this.#now()): void {
		if (providerId === undefined) {
			this.#snapshots.clear();
			this.#quotaObservations.clear();
			for (const id of this.#sharedStore
				?.readExhaustionHolds()
				.map((hold) => hold.providerId) ?? []) {
				this.#holdOverrides.set(id, nowMs);
			}
		} else {
			this.#snapshots.delete(providerId);
			this.#quotaObservations.delete(providerId);
			this.#holdOverrides.set(providerId, nowMs);
		}
	}
}

export function projectUsageQuota(
	snapshot: UsageSnapshot | undefined,
	nowMs: number,
): UsageQuotaProjection {
	if (snapshot === undefined || !Number.isFinite(nowMs) || nowMs < 0) {
		return { status: "missing" };
	}
	const hasEvidence =
		snapshot.remainingRequests !== undefined ||
		snapshot.remainingTokens !== undefined ||
		snapshot.recoveryAtMs !== undefined ||
		snapshot.utilization !== undefined ||
		snapshot.utilizationSource !== undefined;
	if (!hasEvidence) return { status: "missing" };
	const observedAtMs =
		snapshot.quotaObservedAtMs ??
		snapshot.utilizationObservedAtMs ??
		snapshot.snapshotAtMs;
	if (snapshot.stale === true || nowMs - observedAtMs > SHARED_USAGE_TTL_MS) {
		return { status: "stale" };
	}
	const candidate: CohesiveQuotaObservation = {
		observedAtMs,
		...(snapshot.remainingRequests === undefined
			? {}
			: { remainingRequests: snapshot.remainingRequests }),
		...(snapshot.remainingTokens === undefined
			? {}
			: { remainingTokens: snapshot.remainingTokens }),
		...(snapshot.recoveryAtMs === undefined
			? {}
			: { recoveryAtMs: snapshot.recoveryAtMs }),
		...(snapshot.utilization === undefined
			? {}
			: { utilization: snapshot.utilization }),
		...(snapshot.utilizationSource === undefined
			? {}
			: { utilizationSource: snapshot.utilizationSource }),
	};
	return selectDisplayCandidate([candidate]) === undefined
		? { status: "stale" }
		: projectionFromCandidate(candidate);
}

export function formatUsageSnapshot(
	snapshot: UsageSnapshot,
	nowMs: number,
): string {
	const parts = [
		`${snapshot.providerId} — ${snapshot.inputTokens} input, ${snapshot.outputTokens} output`,
		`${snapshot.cacheCreationInputTokens} cache-create, ${snapshot.cacheReadInputTokens} cache-read`,
	];
	if (snapshot.remainingRequests !== undefined) {
		parts.push(`${snapshot.remainingRequests} requests remaining`);
	}
	if (snapshot.remainingTokens !== undefined) {
		parts.push(`${snapshot.remainingTokens} tokens remaining`);
	}
	if (snapshot.recoveryAtMs !== undefined) {
		parts.push(`recovers in ${formatDuration(snapshot.recoveryAtMs - nowMs)}`);
	}
	const hasQuota =
		snapshot.remainingRequests !== undefined ||
		snapshot.remainingTokens !== undefined ||
		snapshot.recoveryAtMs !== undefined ||
		snapshot.utilization !== undefined ||
		snapshot.utilizationSource !== undefined;
	if (hasQuota) {
		const observedAtMs =
			snapshot.quotaObservedAtMs ??
			snapshot.utilizationObservedAtMs ??
			snapshot.snapshotAtMs;
		const ageMs = Math.max(0, nowMs - observedAtMs);
		const stale = snapshot.stale === true || ageMs > SHARED_USAGE_TTL_MS;
		parts.push(
			`quota observed ${formatDuration(ageMs)} ago${stale ? " (stale)" : ""}`,
		);
	}
	return parts.join("; ");
}
/**
 * Cost record with observation timestamp for aggregation.
 * REQ-COST-INCOMPLETE: preserves status classification.
 */
export interface CostRecordWithTimestamp extends CostRecordPayload {
	readonly observedAtMs: number;
}

/**
 * Read all cost records from the history store.
 * REQ-COST-INCOMPLETE: separates complete, partial, and unpriced records.
 */
function* iterateCostHistory(options?: {
	readonly costHistoryPath?: string;
}): Generator<CostRecordWithTimestamp> {
	for (const record of iterateHistory("cost-delta", options)) {
		if (record.recordType !== "cost-delta") continue;
		const envelope = record as HistoryRecordEnvelope;
		if (typeof envelope.payload !== "object" || envelope.payload === null) {
			continue;
		}
		const payload = envelope.payload as CostRecordPayload;
		if (typeof payload.status !== "string") continue;
		yield { ...payload, observedAtMs: envelope.observedAtMs };
	}
}

export function readCostHistory(options?: {
	readonly costHistoryPath?: string;
}): readonly CostRecordWithTimestamp[] {
	return [...iterateCostHistory(options)];
}

/**
 * Aggregate cost records for a period.
 * REQ-COST-INCOMPLETE: only `complete` records contribute to the principal aggregate.
 * REQ-COVERAGE-STATE: returns coverage state for the requested period.
 */
export interface CostAggregate {
	readonly coverageState: CoverageState;
	readonly periodStartMs: number;
	readonly periodEndMs: number;
	/** Sum of `complete` records only. */
	readonly completeTotal: number;
	/** Count of `partial` records (excluded from total). */
	readonly partialCount: number;
	/** Count of `unpriced` records (excluded from total). */
	readonly unpricedCount: number;
}

export function computeCostAggregate(
	periodStartMs: number,
	periodEndMs: number,
	extensionDir?: string,
): CostAggregate {
	const coverageResult = computeCoverageState(
		periodStartMs,
		periodEndMs,
		extensionDir,
	);
	const records = iterateCostHistory(
		extensionDir
			? { costHistoryPath: `${extensionDir}/cost-history.ndjson` }
			: undefined,
	);

	let completeTotal = 0;
	let partialCount = 0;
	let unpricedCount = 0;

	for (const record of records) {
		if (
			record.observedAtMs < periodStartMs ||
			record.observedAtMs > periodEndMs
		)
			continue;

		if (record.status === "complete") {
			completeTotal += record.cost.total;
		} else if (record.status === "partial") {
			partialCount++;
		} else if (record.status === "unpriced") {
			unpricedCount++;
		}
	}

	return {
		coverageState: coverageResult.state,
		periodStartMs,
		periodEndMs,
		completeTotal,
		partialCount,
		unpricedCount,
	};
}

/**
 * Expose window samples for status rendering.
 * REQ-WINDOW-MULTI: returns all windows with their identities.
 */
export function getWindowSamples(
	extensionDir?: string,
): readonly WindowSample[] {
	return readWindowHistory(
		extensionDir
			? { windowHistoryPath: `${extensionDir}/window-history.ndjson` }
			: undefined,
	);
}

/** Fold retained status data to one latest sample per provider/window identity. */
export function getLatestWindowSamples(
	extensionDir?: string,
): ReadonlyMap<string, readonly WindowSample[]> {
	return readLatestWindowHistory(
		extensionDir
			? { windowHistoryPath: `${extensionDir}/window-history.ndjson` }
			: undefined,
	);
}
