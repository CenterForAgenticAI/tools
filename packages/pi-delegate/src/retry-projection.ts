import { effectiveAttempt, isValidForkIdentity, MAX_LINEAGE_DEPTH, validateRetryComponent, type ForkIdentity, type RetryForkRecord, type RetryLookup } from "./fork-predecessor.js";
import { saturatingAdd } from "./usage-rollup.js";
import { isSafeRunId } from "./run-id.js";

/** Public fork-entry cap. It is intentionally separate from MAX_LINEAGE_DEPTH. */
export const MAX_RETRY_PROJECTION_ENTRIES = 32;
export interface RetryProjectionFork extends RetryForkRecord { readonly runId: string; readonly name: string; readonly usage?: Record<string, unknown>; }
export interface RetryProjectionEntry {
	readonly ordinal: number;
	readonly attempt: number;
	readonly isRetry: boolean;
	readonly predecessorRunId?: string;
	readonly cumulativeUsage: Record<string, number>;
	readonly incomplete?: boolean;
}
export interface RetryProjection {
	readonly retryForkCount: number;
	readonly maxAttempt: number;
	readonly retryMetadataIncomplete: boolean;
	readonly retryMetadataTruncated: boolean;
	readonly entries: readonly RetryProjectionEntry[];
}

export const RETRY_PROJECTION_USAGE_KEYS = ["supervisorInput", "supervisorOutput", "supervisorCacheRead", "supervisorCacheWrite", "workerInput", "workerOutput", "workerCacheRead", "workerCacheWrite", "input", "output", "cacheRead", "cacheWrite", "tickerInput", "tickerOutput", "tickerCacheRead", "tickerCacheWrite", "tickerCost", "totalTokens", "cost"] as const;
function numericUsage(value: Record<string, unknown> | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of RETRY_PROJECTION_USAGE_KEYS) {
		const n = value?.[key];
		if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
	}
	return out;
}
function addUsage(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = { ...a };
	for (const [key, value] of Object.entries(b)) {
		out[key] = saturatingAdd(out[key] ?? 0, value);
	}
	return out;
}
function sameOptionalIdentity(a: ForkIdentity | undefined, b: ForkIdentity | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return isValidForkIdentity(a) && isValidForkIdentity(b) && a.runId === b.runId && a.forkName === b.forkName;
}
function hasRetryMetadata(fork: RetryProjectionFork): boolean {
	return fork.retryOf !== undefined || fork.retriedBy !== undefined || fork.retryQuarantined === true ||
		(fork.attempt !== undefined && fork.attempt !== 1);
}
function retryMetadataAgrees(fork: RetryProjectionFork, lookedUp: RetryForkRecord): boolean {
	return sameOptionalIdentity(fork.retryOf, lookedUp.retryOf) &&
		sameOptionalIdentity(fork.retriedBy, lookedUp.retriedBy) &&
		effectiveAttempt(fork) === effectiveAttempt(lookedUp) &&
		(fork.retryQuarantined === true) === (lookedUp.retryQuarantined === true);
}

/** Build the sole privacy-safe retry projection from an explicit fork order. */
export function buildRetryProjection(
	forks: readonly RetryProjectionFork[],
	lookup: RetryLookup,
): RetryProjection {
	let incomplete = false;
	const entries = forks.slice(0, MAX_RETRY_PROJECTION_ENTRIES).map((fork, ordinal): RetryProjectionEntry => {
		const identity: ForkIdentity = { runId: (fork as RetryProjectionFork & { runId?: string }).runId ?? "", forkName: fork.name };
		const predecessor = fork.retryOf;
		const identityValid = isValidForkIdentity(identity);
		const linksValid = (fork.retryOf === undefined || isValidForkIdentity(fork.retryOf)) &&
			(fork.retriedBy === undefined || isValidForkIdentity(fork.retriedBy));
		const rawAttempt = effectiveAttempt(fork);
		const safeAttempt = Number.isSafeInteger(rawAttempt) && rawAttempt >= 1 && rawAttempt <= MAX_LINEAGE_DEPTH;
		const relationFreeAttemptValid = (fork.retryOf !== undefined || fork.retriedBy !== undefined) || rawAttempt === 1;
		const rootMetadataValid = identityValid && linksValid && safeAttempt && relationFreeAttemptValid && fork.retryQuarantined !== true;
		const lookedUp = identityValid ? lookup(identity.runId, identity.forkName) : undefined;
		const lookupAgrees = lookedUp === undefined ? !hasRetryMetadata(fork) : retryMetadataAgrees(fork, lookedUp);
		const componentValid = rootMetadataValid && lookupAgrees && validateRetryComponent(lookup, identity).ok;
		const isRetry = componentValid && predecessor !== undefined;
		const entryIncomplete = !rootMetadataValid || !lookupAgrees || (hasRetryMetadata(fork) && !componentValid);
		if (entryIncomplete) incomplete = true;
		let cumulative = numericUsage(fork.usage);
		if (isRetry && predecessor) {
			let cursor: ForkIdentity | undefined = predecessor;
			const seen = new Set<string>();
			while (cursor) {
				const key = `${cursor.runId}\u0000${cursor.forkName}`;
				if (seen.has(key)) { incomplete = true; break; }
				seen.add(key);
				const prior = lookup(cursor.runId, cursor.forkName) as (RetryProjectionFork | undefined);
				if (!prior) { incomplete = true; break; }
				cumulative = addUsage(cumulative, numericUsage(prior.usage));
				cursor = prior.retryOf;
			}
		}
		return {
			ordinal,
			attempt: componentValid ? rawAttempt : 1,
			isRetry,
			...(isRetry && predecessor && isSafeRunId(predecessor.runId) ? { predecessorRunId: predecessor.runId } : {}),
			cumulativeUsage: cumulative,
			...(entryIncomplete ? { incomplete: true } : {}),
		};
	});
	return {
		retryForkCount: entries.filter((entry) => entry.isRetry).length,
		maxAttempt: entries.reduce((max, entry) => Math.max(max, entry.attempt), 1),
		retryMetadataIncomplete: incomplete,
		retryMetadataTruncated: forks.length > MAX_RETRY_PROJECTION_ENTRIES,
		entries,
	};
}
