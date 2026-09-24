import { randomUUID } from "node:crypto";
import {
	appendHistory,
	iterateHistory,
} from "./history-store.js";
import { isAllowedFamily, type AllowedFamily } from "./config.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";

/**
 * The subscription family a retained window sample names, or `undefined` for a
 * non-string, unknown, or owning-vendor-api `openai` family. Its fixed
 * `AllowedFamily | undefined` return type is what keeps the retained window
 * schema subscription-only while still narrowing `family` to `AllowedFamily` for
 * the downstream `isCanonicalManagedProviderId` check. The mutation control for
 * this guard changes only this body (to `return family as AllowedFamily`), which
 * still compiles because the signature is unchanged.
 */
function subscriptionFamilyForWindow(family: unknown): AllowedFamily | undefined {
	return typeof family === "string" && isAllowedFamily(family)
		? family
		: undefined;
}

const MAX_OBSERVER_ID_LENGTH = 128;
const DEFAULT_BUILD_PROVENANCE = "pi-multi-account@0.1.0";
const UNUSABLE_REASON = "reset-time-unavailable";
const MAX_PROJECT_DIGEST_LENGTH = 64;
/**
 * Bounded, opaque, non-identifying digest shape (e.g. a truncated sha256 hex
 * digest with a short type prefix, as produced by
 * `usage-fetch.ts#deriveAntigravityProjectDigest`). This module never derives
 * the digest itself and never accepts a raw project id: it only bounds and
 * stores whatever already-projected value a caller supplies.
 */
function validProjectDigest(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PROJECT_DIGEST_LENGTH &&
		/^[a-z0-9-]+$/.test(value)
	);
}

/** A retained sample for one provider-reported rate-limit window. */
export interface WindowSample {
	readonly providerId: string;
	/** Canonical account identity; deliberately not a human-readable label. */
	readonly accountId: string;
	readonly family: AllowedFamily;
	readonly windowId: string;
	/** Reset epoch used by rate calculation; absent samples are unusable. */
	readonly resetEpoch?: number;
	/** Canonical stored unit: fraction of the provider budget remaining. */
	readonly remainingFraction?: number;
	readonly resetAtMs?: number;
	/**
	 * Bounded, non-identifying digest of an upstream account-scoped project id
	 * (e.g. Google Antigravity's Cloud project). Absent for a family with no such
	 * concept. Never the raw id -- see `validProjectDigest`.
	 */
	readonly projectDigest?: string;
	readonly recordedAtMs: number;
	readonly schemaVersion: number;
	readonly buildProvenance: string;
	readonly observerId: string;
	readonly usable: boolean;
	readonly unusableReason?: string;
}

export type WindowHistoryWriteOptions = NonNullable<
	Parameters<typeof appendHistory>[1]
>;

type WindowSampleInput = Omit<
	WindowSample,
	"schemaVersion" | "buildProvenance" | "observerId" | "usable"
> &
	Partial<
		Pick<
			WindowSample,
			"schemaVersion" | "buildProvenance" | "observerId" | "usable" | "unusableReason"
		>
	>;

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validFraction(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function validWindowSample(value: unknown): value is WindowSample {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const sample = value as Record<string, unknown>;
	// Retained window schema stays subscription-only: an owning-vendor-api
	// `openai` family yields `undefined` here and is rejected below, even though
	// isCanonicalManagedProviderId now widens. `family` is AllowedFamily when set.
	const family = subscriptionFamilyForWindow(sample.family);
	if (
		typeof sample.providerId !== "string" ||
		typeof sample.accountId !== "string" ||
		family === undefined ||
		!isCanonicalManagedProviderId(sample.providerId, family) ||
		sample.accountId !== sample.providerId ||
		typeof sample.windowId !== "string" ||
		sample.windowId.length === 0 ||
		sample.windowId.length > 128 ||
		!validTimestamp(sample.recordedAtMs) ||
		sample.schemaVersion !== 1 ||
		typeof sample.buildProvenance !== "string" ||
		sample.buildProvenance.length === 0 ||
		sample.buildProvenance.length > 128 ||
		typeof sample.observerId !== "string" ||
		sample.observerId.length === 0 ||
		sample.observerId.length > MAX_OBSERVER_ID_LENGTH ||
		typeof sample.usable !== "boolean"
	) {
		return false;
	}
	if (sample.remainingFraction !== undefined && !validFraction(sample.remainingFraction)) {
		return false;
	}
	if (sample.resetAtMs !== undefined && !validTimestamp(sample.resetAtMs)) {
		return false;
	}
	if (sample.resetEpoch !== undefined && !validTimestamp(sample.resetEpoch)) {
		return false;
	}
	if (sample.projectDigest !== undefined && !validProjectDigest(sample.projectDigest)) {
		return false;
	}
	if (sample.usable && (!validFraction(sample.remainingFraction) || !validTimestamp(sample.resetAtMs))) {
		return false;
	}
	if (!sample.usable && typeof sample.unusableReason !== "string") {
		return false;
	}
	return true;
}

function normalizeSample(sample: WindowSampleInput): WindowSample {
	const usable =
		sample.usable === true &&
		validFraction(sample.remainingFraction) &&
		validTimestamp(sample.resetAtMs);
	const suppliedObserverId = sample.observerId;
	const observerId =
		typeof suppliedObserverId === "string" &&
		/^process-[a-zA-Z0-9-]+$/.test(suppliedObserverId)
			? suppliedObserverId
			: `process-${process.pid}`;
	const normalized: WindowSample = {
		providerId: sample.providerId,
		accountId: sample.accountId,
		family: sample.family,
		windowId: sample.windowId,
		...(sample.resetAtMs === undefined ? {} : { resetAtMs: sample.resetAtMs }),
		...(sample.resetEpoch === undefined
			? {}
			: { resetEpoch: sample.resetEpoch }),
		...(sample.remainingFraction === undefined
			? {}
			: { remainingFraction: sample.remainingFraction }),
		...(sample.projectDigest === undefined
			? {}
			: { projectDigest: sample.projectDigest }),
		recordedAtMs: sample.recordedAtMs,
		schemaVersion: sample.schemaVersion ?? 1,
		buildProvenance: sample.buildProvenance ?? DEFAULT_BUILD_PROVENANCE,
		observerId: observerId.slice(0, MAX_OBSERVER_ID_LENGTH),
		usable,
		...(usable
			? {}
			: {
				unusableReason:
					sample.unusableReason ?? UNUSABLE_REASON,
			}),
	};
	return normalized;
}

/** Convert a utilization fraction into the canonical remaining fraction. */
export function remainingFractionFromUtilization(
	utilization: number,
): number | undefined {
	return validFraction(utilization)
		? Math.round((1 - utilization) * 1_000_000_000_000) / 1_000_000_000_000
		: undefined;
}

/** Convert the stored remaining fraction into utilization at read time. */
export function utilizationFromRemainingFraction(
	remainingFraction: number,
): number | undefined {
	return validFraction(remainingFraction) ? 1 - remainingFraction : undefined;
}

/** Mark a provider window unusable without discarding or inventing its reset. */
export function markWindowUnusable(sample: WindowSampleInput): WindowSample {
	return normalizeSample({ ...sample, usable: false });
}

/** Persist one immutable window sample through the shared history lock. */
export async function writeHistoryWindowSample(
	sample: WindowSampleInput,
	options?: WindowHistoryWriteOptions,
): Promise<boolean> {
	try {
		const normalized = normalizeSample(sample);
		if (!validWindowSample(normalized)) return false;
		return await appendHistory(
			{
				schemaVersion: 1,
				recordType: "window-sample",
				stableId: randomUUID(),
				observedAtMs: normalized.recordedAtMs,
				recordedAtMs: normalized.recordedAtMs,
				payload: normalized,
			},
			options,
		);
	} catch {
		return false;
	}
}

function* iterateValidWindowHistory(
	options?: WindowHistoryWriteOptions,
): Generator<WindowSample> {
	for (const record of iterateHistory("window-sample", options)) {
		if (record.recordType !== "window-sample") continue;
		if (validWindowSample(record.payload)) yield record.payload;
	}
}

/** Read valid window payloads while preserving the history store's append log. */
export function readWindowHistory(
	options?: WindowHistoryWriteOptions,
): readonly WindowSample[] {
	return [...iterateValidWindowHistory(options)];
}

/** Fold status history to one latest sample per provider/window identity. */
export function readLatestWindowHistory(
	options?: WindowHistoryWriteOptions,
): ReadonlyMap<string, readonly WindowSample[]> {
	const latest = new Map<string, WindowSample>();
	for (const sample of iterateValidWindowHistory(options)) {
		const key = JSON.stringify([sample.providerId, sample.windowId]);
		const previous = latest.get(key);
		if (previous === undefined || sample.recordedAtMs > previous.recordedAtMs) {
			latest.set(key, sample);
		}
	}
	const byProvider = new Map<string, WindowSample[]>();
	for (const sample of latest.values()) {
		const samples = byProvider.get(sample.providerId) ?? [];
		samples.push(sample);
		byProvider.set(sample.providerId, samples);
	}
	return byProvider;
}
