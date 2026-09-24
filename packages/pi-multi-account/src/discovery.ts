/**
 * Public-first discovery: enumerates managed-account credential PRESENCE using
 * Pi's public `readStoredCredential` surface without reading credential values.
 * Pi 0.81.1 removed the wholesale `AuthStorage.list()` enumeration, so
 * discovery probes the fixed managed-account provider-id convention
 * (`anthropic`, `openai-codex`, and `google-antigravity`, plus each family's
 * `-account-N` aliases) one id at a time. Only when the public surface is
 * unavailable does discovery
 * use the narrow read-only auth.json fallback (REQ-AUTH-1, REQ-AUTH-2).
 *
 * Credential values are never extracted, retained, hashed, fingerprinted, or
 * logged by this module. auth.json is never mutated.
 */

import { existsSync, readFileSync } from "node:fs";
import type { MultiAccountConfig } from "./config.js";
import {
	MANAGED_FAMILIES,
	accountSlotIndexes,
	canonicalProviderIdForAccountSlot,
	isAccountLimit,
	isAccountSlotIndex,
	isManagedFamily,
	type ManagedFamily,
} from "./config.js";

export type CredentialType = "oauth" | "api_key" | "unknown";

export interface CredentialPresenceRecord {
	readonly providerId: string;
	/** Bounded presence category only; never an arbitrary source string. */
	readonly credentialType: CredentialType;
	/**
	 * Epoch milliseconds at which the stored credential expires, when the store
	 * reports one. This is a bounded timestamp, never credential material. It
	 * exists because Pi's OAuth refresh is lazy: an account that serves no
	 * request is never refreshed and silently ages out, so freshness has to be
	 * observable before a request is attempted.
	 */
	readonly expiresAtMs?: number;
}

export type PublicCredentialMetadataResult =
	| {
			readonly status: "available";
			readonly records: readonly CredentialPresenceRecord[];
	  }
	| {
			readonly status: "unavailable";
	  };

export interface PublicAuthStorageAdapter {
	/**
	 * Distinguishes an authoritative public result (including an empty list)
	 * from an unavailable, failed, or unsupported public surface.
	 */
	listProviders(): Promise<PublicCredentialMetadataResult>;
}

function normalizeCredentialType(value: unknown): CredentialType {
	return value === "oauth" || value === "api_key" ? value : "unknown";
}

/**
 * Reads a single stored credential's bounded presence metadata for one
 * provider id. Returns the normalized credential TYPE only (or `null` when no
 * credential is stored). Credential secret values never cross this boundary.
 */
/** Bounded credential facts a probe may surface. Never a secret value. */
export interface CredentialFacts {
	readonly credentialType: CredentialType;
	readonly expiresAtMs?: number;
}

export type StoredCredentialProbe = (
	providerId: string,
) => CredentialType | CredentialFacts | null;

/** Accepts either probe return shape so existing probes keep working. */
function toCredentialFacts(
	value: CredentialType | CredentialFacts | null,
): CredentialFacts | null {
	if (value === null) return null;
	return typeof value === "string" ? { credentialType: value } : value;
}

/** Accepts only a finite, non-negative epoch timestamp. */
function boundedExpiry(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/** The fixed set of managed-account provider ids probed by convention. */
export function managedProviderIdCandidates(
	accountLimit: number,
): readonly string[] {
	const candidates: string[] = [];
	for (const family of MANAGED_FAMILIES) {
		for (const index of accountSlotIndexes(accountLimit, 1)) {
			if (!isAccountSlotIndex(index, accountLimit)) continue;
			const providerId = canonicalProviderIdForAccountSlot(
				family,
				index,
				accountLimit,
			);
			if (providerId !== null) candidates.push(providerId);
		}
	}
	return candidates;
}

/**
 * Probes a fixed set of candidate managed provider ids for credential presence,
 * classifying and revalidating each supplied id against the current limit
 * immediately before invoking `probe(providerId)`. This narrow seam lets the
 * pre-probe guard be exercised with hostile canonical above-limit candidate ids
 * without mutating or mocking the sole iterator. A supplied id that does not
 * classify or falls outside the current limit is never probed.
 */
export function probeManagedProviderIdCandidates(
	candidateProviderIds: readonly string[],
	probe: StoredCredentialProbe,
	accountLimit: number,
): PublicCredentialMetadataResult {
	const records: CredentialPresenceRecord[] = [];
	for (const providerId of candidateProviderIds) {
		const slot = classifyProviderId({ providerId, credentialType: "unknown" });
		if (slot === null || !isProviderSlotWithinAccountLimit(slot, accountLimit)) {
			continue;
		}
		let facts: CredentialFacts | null;
		try {
			facts = toCredentialFacts(probe(providerId));
		} catch {
			return { status: "unavailable" };
		}
		if (facts !== null) {
			records.push({
				providerId,
				credentialType: facts.credentialType,
				...(facts.expiresAtMs === undefined
					? {}
					: { expiresAtMs: facts.expiresAtMs }),
			});
		}
	}
	return { status: "available", records };
}

/**
 * Wraps Pi's public `readStoredCredential` surface in the adapter expected by
 * discovery. Probes the managed-account provider-id convention one id at a
 * time; a provider is "present" when the probe returns a credential type.
 * Credential values and arbitrary credential-type strings never cross the
 * adapter boundary — only the provider id and a bounded presence category do.
 */
export function createPublicAuthStorageAdapter(
	probe: StoredCredentialProbe | null | undefined,
	accountLimit: number,
): PublicAuthStorageAdapter {
	return {
		async listProviders(): Promise<PublicCredentialMetadataResult> {
			if (typeof probe !== "function") {
				return { status: "unavailable" };
			}

			return probeManagedProviderIdCandidates(
				managedProviderIdCandidates(accountLimit),
				probe,
				accountLimit,
			);
		},
	};
}

/**
 * Builds a {@link StoredCredentialProbe} over Pi's public
 * `readStoredCredential(providerId, authPath?)`. The reader returns a
 * `Credential | undefined`; this probe surfaces only the normalized `.type`
 * (never the secret value) and maps a missing credential to `null`.
 */
export function createReadStoredCredentialProbe(
	readStoredCredential: (providerId: string, authPath?: string) => unknown,
	authPath?: string,
): StoredCredentialProbe {
	return (providerId: string): CredentialFacts | null => {
		const credential = readStoredCredential(providerId, authPath);
		if (credential === null || typeof credential !== "object") {
			return null;
		}
		const record = credential as Record<string, unknown>;
		const expiresAtMs = boundedExpiry(record["expires"]);
		return {
			credentialType: normalizeCredentialType(record["type"]),
			...(expiresAtMs === undefined ? {} : { expiresAtMs }),
		};
	};
}

export interface AuthJsonFallbackAdapter {
	/** Returns only provider ID and bounded presence metadata. Never writes. */
	listProviders(authPath: string): readonly CredentialPresenceRecord[];
}

export const DEFAULT_AUTH_JSON_FALLBACK: AuthJsonFallbackAdapter = {
	listProviders(authPath: string): readonly CredentialPresenceRecord[] {
		if (!existsSync(authPath)) return [];

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(authPath, "utf-8"));
		} catch {
			return [];
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return [];
		}

		const records: CredentialPresenceRecord[] = [];
		for (const [providerId, value] of Object.entries(parsed)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				continue;
			}
			const record = value as Record<string, unknown>;
			const credentialType = normalizeCredentialType(record["type"]);
			const expiresAtMs = boundedExpiry(record["expires"]);
			records.push({
				providerId,
				credentialType,
				...(expiresAtMs === undefined ? {} : { expiresAtMs }),
			});
		}
		return records;
	},
};

const ANTHROPIC_BASE_PROVIDER = "anthropic";
const CODEX_BASE_PROVIDER = "openai-codex";
const ANTIGRAVITY_BASE_PROVIDER = "google-antigravity";
const OPENAI_BASE_PROVIDER = "openai";
const NUMBERED_SLOT_PATTERN =
	/^(anthropic|openai-codex|google-antigravity|openai)-account-([2-9]|[1-9]\d+)$/;

export interface ProviderSlot {
	readonly family: ManagedFamily;
	readonly providerId: string;
	/** Numeric slot index: 1 for the base provider, 2+ for aliases. */
	readonly slotIndex: number;
	readonly credentialType: CredentialType;
	/** Bounded credential expiry, when the credential store reports one. */
	readonly expiresAtMs?: number;
}

/** Maps only canonical base and `*-account-N` provider IDs to slots. */
export function classifyProviderId(
	record: CredentialPresenceRecord,
): ProviderSlot | null {
	const { providerId, credentialType } = record;
	const expiry =
		record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs };

	if (providerId === ANTHROPIC_BASE_PROVIDER) {
		return {
			family: "anthropic",
			providerId,
			slotIndex: 1,
			credentialType,
			...expiry,
		};
	}
	if (providerId === CODEX_BASE_PROVIDER) {
		return {
			family: "openai-codex",
			providerId,
			slotIndex: 1,
			credentialType,
			...expiry,
		};
	}
	if (providerId === ANTIGRAVITY_BASE_PROVIDER) {
		return {
			family: "google-antigravity",
			providerId,
			slotIndex: 1,
			credentialType,
			...expiry,
		};
	}
	if (providerId === OPENAI_BASE_PROVIDER) {
		return {
			family: "openai",
			providerId,
			slotIndex: 1,
			credentialType,
			...expiry,
		};
	}

	const match = NUMBERED_SLOT_PATTERN.exec(providerId);
	if (!match) return null;
	const family = match[1];
	const rawSlotIndex = match[2];
	if (!family || !rawSlotIndex) return null;
	const slotIndex = Number(rawSlotIndex);
	if (!Number.isSafeInteger(slotIndex) || slotIndex < 2) return null;
	if (!isManagedFamily(family)) return null;

	return {
		family,
		providerId,
		slotIndex,
		credentialType,
		...expiry,
	};
}

/**
 * Whether a classified slot is within the current validated account limit. A
 * non-iterating structural predicate over named `{ providerId, family,
 * slotIndex }` fields: it requires the slot to round-trip through
 * `canonicalProviderIdForAccountSlot(family, slotIndex, accountLimit)`, so a
 * hostile record whose `providerId`, `family`, and `slotIndex` disagree, or
 * whose index exceeds the limit, is rejected. `classifyProviderId()` stays
 * deliberately limit-agnostic so fallback can parse a legacy high-slot id long
 * enough to reject it here at a caller-owned boundary.
 */
export function isProviderSlotWithinAccountLimit(
	slot: Pick<ProviderSlot, "providerId" | "family" | "slotIndex">,
	accountLimit: number,
): boolean {
	return (
		canonicalProviderIdForAccountSlot(
			slot.family,
			slot.slotIndex,
			accountLimit,
		) === slot.providerId
	);
}

export interface DiscoveryResult {
	readonly slots: readonly ProviderSlot[];
	readonly usedPublicMetadata: boolean;
	readonly spareSlots: ReadonlyMap<ManagedFamily, string>;
}

function nextFreeSlotId(
	family: ManagedFamily,
	existing: readonly ProviderSlot[],
	limit: number,
): string | null {
	const occupied = new Set<number>();
	for (const slot of existing) {
		if (slot.family === family) occupied.add(slot.slotIndex);
	}
	for (const slotIndex of accountSlotIndexes(limit, 1)) {
		if (occupied.has(slotIndex)) continue;
		if (!isAccountSlotIndex(slotIndex, limit)) continue;
		const providerId = canonicalProviderIdForAccountSlot(
			family,
			slotIndex,
			limit,
		);
		if (providerId !== null) return providerId;
	}
	return null;
}

function compareSlots(left: ProviderSlot, right: ProviderSlot): number {
	const familyOrder =
		MANAGED_FAMILIES.indexOf(left.family) -
		MANAGED_FAMILIES.indexOf(right.family);
	return familyOrder !== 0
		? familyOrder
		: left.slotIndex - right.slotIndex ||
				left.providerId.localeCompare(right.providerId);
}

/**
 * Discovers canonical slots from authoritative public metadata or, only when
 * that public surface is unavailable, the read-only fallback. Exact provider
 * IDs are deduplicated; no real-account identity equivalence is inferred.
 */
export async function discoverAccounts(options: {
	publicAdapter: PublicAuthStorageAdapter;
	fallbackAdapter?: AuthJsonFallbackAdapter;
	authJsonPath?: string;
	config: MultiAccountConfig;
}): Promise<DiscoveryResult> {
	const {
		publicAdapter,
		fallbackAdapter = DEFAULT_AUTH_JSON_FALLBACK,
		authJsonPath,
		config,
	} = options;

	let publicResult: PublicCredentialMetadataResult;
	try {
		publicResult = await publicAdapter.listProviders();
	} catch {
		publicResult = { status: "unavailable" };
	}

	let records: readonly CredentialPresenceRecord[];
	let usedPublicMetadata: boolean;
	if (publicResult.status === "available") {
		records = publicResult.records;
		usedPublicMetadata = true;
	} else if (authJsonPath) {
		records = fallbackAdapter.listProviders(authJsonPath);
		usedPublicMetadata = false;
	} else {
		records = [];
		usedPublicMetadata = false;
	}

	const seenProviderIds = new Set<string>();
	const slots: ProviderSlot[] = [];
	if (usedPublicMetadata) {
		// The public probe already visits only in-range candidates, but a hostile
		// or unavailable-then-fabricated public result is defended in depth: each
		// classified slot must pass the current-limit predicate before projection.
		for (const record of records) {
			if (seenProviderIds.has(record.providerId)) continue;
			seenProviderIds.add(record.providerId);
			const slot = classifyProviderId(record);
			if (slot && isProviderSlotWithinAccountLimit(slot, config.accountLimit)) {
				slots.push(slot);
			}
		}
	} else {
		// The read-only fallback can name a legacy above-limit id. Build the set of
		// canonical provider ids allowed for the current limit from the sole
		// iterator, revalidating each yield before the canonical formatter, then
		// admit only a classified fallback record whose id is a member.
		const allowedProviderIds = new Set<string>();
		for (const family of MANAGED_FAMILIES) {
			for (const index of accountSlotIndexes(config.accountLimit, 1)) {
				if (!isAccountSlotIndex(index, config.accountLimit)) continue;
				const providerId = canonicalProviderIdForAccountSlot(
					family,
					index,
					config.accountLimit,
				);
				if (providerId !== null) allowedProviderIds.add(providerId);
			}
		}
		for (const record of records) {
			if (seenProviderIds.has(record.providerId)) continue;
			seenProviderIds.add(record.providerId);
			const slot = classifyProviderId(record);
			if (slot && allowedProviderIds.has(slot.providerId)) {
				slots.push(slot);
			}
		}
	}
	slots.sort(compareSlots);

	const spareSlots = new Map<ManagedFamily, string>();
	for (const family of MANAGED_FAMILIES) {
		const spare = nextFreeSlotId(family, slots, config.accountLimit);
		if (spare !== null) spareSlots.set(family, spare);
	}

	return { slots, usedPublicMetadata, spareSlots };
}
