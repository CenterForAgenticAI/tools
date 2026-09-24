/**
 * Effective-dated USD rate records for canonical managed accounts.
 *
 * The account is the billing boundary: one canonical accountId owns one
 * ordered sequence of rate records. Selecting a catalog preset COPIES its
 * terms -- provider, account type, label, catalog version, and provenance --
 * into the new record, so a later catalog edit never rewrites an existing
 * record or a closed historical report. A rate stays effective until the next
 * record for the same account begins; this module never inserts a default
 * end, renewal, or effective instant, and an explicit `monthlyUsd: 0` is a
 * valid rate, distinct from no rate being recorded at all.
 */

import type {
	CatalogAccountType,
	CatalogProvider,
	SubscriptionPlanPreset,
} from "./subscription-plan-catalog.js";
import {
	CATALOG_ACCOUNT_TYPES,
	CATALOG_PROVIDERS,
	MAX_PRESET_ID_LENGTH,
	PRESET_ID_PATTERN,
} from "./subscription-plan-catalog.js";

const MAX_ACCOUNT_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 64;
const MAX_PROVENANCE_LENGTH = 256;

export class AccountRateHistoryError extends Error {
	constructor(message: string) {
		super(`[account-rate-history] ${message}`);
		this.name = "AccountRateHistoryError";
	}
}

export interface AccountRateRecord {
	readonly accountId: string;
	readonly provider: CatalogProvider;
	readonly accountType: CatalogAccountType;
	readonly monthlyUsd: number;
	/** RFC 3339 instant with an explicit `Z` or numeric UTC offset. */
	readonly effectiveFrom: string;
	readonly presetId: string;
	readonly presetLabel: string;
	readonly catalogVersion: number;
	readonly provenance: string;
	/** Present only when the operator supplied an explicit rate override. */
	readonly overrideProvenance?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= maxLength
	);
}

/**
 * A strict RFC 3339 timestamp: date, `T`, time, and either `Z` or a signed
 * `HH:MM` numeric offset. An offsetless date-time is rejected, matching the
 * product's custom-range timestamp rule.
 */
const RFC3339_INSTANT_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function parseInstantMs(value: string): number {
	const epochMs = Date.parse(value);
	if (!Number.isFinite(epochMs)) {
		throw new AccountRateHistoryError(
			`"${value}" is not a valid RFC 3339 instant.`,
		);
	}
	return epochMs;
}

/** Validates an RFC 3339 instant string and returns it unchanged. */
export function assertValidEffectiveFrom(value: unknown, context: string): string {
	if (typeof value !== "string" || !RFC3339_INSTANT_PATTERN.test(value)) {
		throw new AccountRateHistoryError(
			`${context} must be an RFC 3339 timestamp with an explicit "Z" or numeric offset.`,
		);
	}
	parseInstantMs(value);
	return value;
}

function assertValidAccountId(value: unknown, context: string): string {
	if (!isBoundedString(value, MAX_ACCOUNT_ID_LENGTH)) {
		throw new AccountRateHistoryError(
			`${context}.accountId must be a non-empty string of at most ${MAX_ACCOUNT_ID_LENGTH} characters.`,
		);
	}
	return value;
}

function assertValidPresetId(value: unknown, context: string): string {
	if (
		!isBoundedString(value, MAX_PRESET_ID_LENGTH) ||
		!PRESET_ID_PATTERN.test(value)
	) {
		throw new AccountRateHistoryError(
			`${context}.presetId must be a lowercase, hyphen-separated identifier of at most ${MAX_PRESET_ID_LENGTH} characters.`,
		);
	}
	return value;
}

function assertValidMonthlyUsd(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new AccountRateHistoryError(
			`${context}.monthlyUsd must be a finite, non-negative USD amount.`,
		);
	}
	return value;
}

function assertValidCatalogVersion(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new AccountRateHistoryError(
			`${context}.catalogVersion must be a positive integer.`,
		);
	}
	return value;
}

function assertValidProvenance(
	value: unknown,
	context: string,
	field: string,
): string {
	if (!isBoundedString(value, MAX_PROVENANCE_LENGTH)) {
		throw new AccountRateHistoryError(
			`${context}.${field} must be a non-empty string of at most ${MAX_PROVENANCE_LENGTH} characters.`,
		);
	}
	return value;
}

function assertValidPresetLabel(value: unknown, context: string): string {
	if (!isBoundedString(value, MAX_LABEL_LENGTH)) {
		throw new AccountRateHistoryError(
			`${context}.presetLabel must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters.`,
		);
	}
	return value;
}

function assertValidProvider(value: unknown, context: string): CatalogProvider {
	if (
		typeof value !== "string" ||
		!(CATALOG_PROVIDERS as readonly string[]).includes(value)
	) {
		throw new AccountRateHistoryError(
			`${context}.provider must be one of [${CATALOG_PROVIDERS.join(", ")}].`,
		);
	}
	return value as CatalogProvider;
}

function assertValidAccountType(value: unknown, context: string): CatalogAccountType {
	if (
		typeof value !== "string" ||
		!(CATALOG_ACCOUNT_TYPES as readonly string[]).includes(value)
	) {
		throw new AccountRateHistoryError(
			`${context}.accountType must be one of [${CATALOG_ACCOUNT_TYPES.join(", ")}].`,
		);
	}
	return value as CatalogAccountType;
}

const RECORD_FIELDS = new Set([
	"accountId",
	"provider",
	"accountType",
	"monthlyUsd",
	"effectiveFrom",
	"presetId",
	"presetLabel",
	"catalogVersion",
	"provenance",
	"overrideProvenance",
]);

/**
 * Validates one already-persisted rate record, allowlisting exactly the
 * fields above and rejecting any other field. Structural only: never
 * resolves `presetId` against a live catalog, so a stored record stays valid
 * -- and unchanged -- after the catalog that produced it is edited.
 */
export function parseAccountRateRecord(
	value: unknown,
	context: string,
): AccountRateRecord {
	if (!isRecord(value)) {
		throw new AccountRateHistoryError(`${context} must be a JSON object.`);
	}
	const unknownKeys = Object.keys(value).filter((key) => !RECORD_FIELDS.has(key));
	if (unknownKeys.length > 0) {
		throw new AccountRateHistoryError(
			`${context} has unsupported field "${unknownKeys[0]}".`,
		);
	}
	const hasOverrideProvenance = value["overrideProvenance"] !== undefined;
	const record: AccountRateRecord = {
		accountId: assertValidAccountId(value["accountId"], context),
		provider: assertValidProvider(value["provider"], context),
		accountType: assertValidAccountType(value["accountType"], context),
		monthlyUsd: assertValidMonthlyUsd(value["monthlyUsd"], context),
		effectiveFrom: assertValidEffectiveFrom(
			value["effectiveFrom"],
			`${context}.effectiveFrom`,
		),
		presetId: assertValidPresetId(value["presetId"], context),
		presetLabel: assertValidPresetLabel(value["presetLabel"], context),
		catalogVersion: assertValidCatalogVersion(value["catalogVersion"], context),
		provenance: assertValidProvenance(value["provenance"], context, "provenance"),
		...(hasOverrideProvenance
			? {
					overrideProvenance: assertValidProvenance(
						value["overrideProvenance"],
						context,
						"overrideProvenance",
					),
				}
			: {}),
	};
	return Object.freeze(record);
}

export interface CreateAccountRateRecordInput {
	readonly accountId: string;
	readonly preset: SubscriptionPlanPreset;
	readonly catalogVersion: number;
	readonly effectiveFrom: string;
	readonly monthlyUsdOverride?: number;
	readonly overrideProvenance?: string;
}

/**
 * Builds one immutable rate record by COPYING the preset's terms -- provider,
 * account type, label, provenance -- and the caller-supplied catalog version
 * into plain fields on the record. The record holds no reference back to the
 * preset or catalog, so a later catalog edit or removal cannot change it.
 */
export function createAccountRateRecord(
	input: CreateAccountRateRecordInput,
): AccountRateRecord {
	const context = "accountRateRecord";
	const accountId = assertValidAccountId(input.accountId, context);
	const effectiveFrom = assertValidEffectiveFrom(
		input.effectiveFrom,
		`${context}.effectiveFrom`,
	);
	const catalogVersion = assertValidCatalogVersion(input.catalogVersion, context);
	const hasOverride = input.monthlyUsdOverride !== undefined;
	if (hasOverride !== (input.overrideProvenance !== undefined)) {
		throw new AccountRateHistoryError(
			`${context}.monthlyUsdOverride and ${context}.overrideProvenance must be supplied together.`,
		);
	}
	const monthlyUsd = hasOverride
		? assertValidMonthlyUsd(input.monthlyUsdOverride, context)
		: input.preset.monthlyUsd;
	const overrideProvenance = hasOverride
		? assertValidProvenance(input.overrideProvenance, context, "overrideProvenance")
		: undefined;
	const record: AccountRateRecord = {
		accountId,
		provider: input.preset.provider,
		accountType: input.preset.accountType,
		monthlyUsd,
		effectiveFrom,
		presetId: input.preset.id,
		presetLabel: input.preset.label,
		catalogVersion,
		provenance: input.preset.provenance,
		...(overrideProvenance !== undefined ? { overrideProvenance } : {}),
	};
	return Object.freeze(record);
}

/**
 * One candidate going into {@link normalizeAccountRateHistory}. `effectiveUntil`
 * is an optional, input-only, EXPLICIT upper bound the caller asserts for this
 * record's coverage; it is exclusive, never inferred when omitted, and never
 * copied onto the normalized {@link AccountRateRecord}. It lets a caller
 * reconstructing history from known bounds catch an inconsistent, overlapping
 * claim before it reaches storage.
 */
export interface AccountRateHistoryCandidate {
	readonly record: AccountRateRecord;
	readonly effectiveUntil?: string;
}

/**
 * Orders one account's candidate rate records ascending by `effectiveFrom`
 * instant, and rejects:
 *
 * - more than one accountId in the input (each call normalizes one account);
 * - two records that resolve to the same effective instant, even when their
 *   raw strings differ (e.g. `Z` vs `+00:00`); and
 * - an explicit `effectiveUntil` bound that does not follow its own record's
 *   `effectiveFrom`, or that overlaps a later record's `effectiveFrom`.
 *
 * Never inserts a default end, renewal, or effective instant: an omitted
 * `effectiveUntil` places no upper bound on a record other than the next
 * record's `effectiveFrom`, once sorted.
 */
export function normalizeAccountRateHistory(
	candidates: readonly AccountRateHistoryCandidate[],
): readonly AccountRateRecord[] {
	if (candidates.length === 0) return Object.freeze([]);
	const accountId = candidates[0]!.record.accountId;
	for (const candidate of candidates) {
		if (candidate.record.accountId !== accountId) {
			throw new AccountRateHistoryError(
				"normalizeAccountRateHistory received records for more than one accountId.",
			);
		}
		if (candidate.effectiveUntil !== undefined) {
			assertValidEffectiveFrom(
				candidate.effectiveUntil,
				`accountRateHistory.${accountId}.effectiveUntil`,
			);
			if (
				parseInstantMs(candidate.effectiveUntil) <=
				parseInstantMs(candidate.record.effectiveFrom)
			) {
				throw new AccountRateHistoryError(
					`Account "${accountId}" has an explicit effectiveUntil ("${candidate.effectiveUntil}") that does not follow its own effectiveFrom ("${candidate.record.effectiveFrom}").`,
				);
			}
		}
	}

	const sorted = [...candidates].sort(
		(a, b) =>
			parseInstantMs(a.record.effectiveFrom) - parseInstantMs(b.record.effectiveFrom),
	);

	for (let i = 0; i < sorted.length; i += 1) {
		const current = sorted[i]!;
		const currentFrom = parseInstantMs(current.record.effectiveFrom);
		const currentUntil =
			current.effectiveUntil !== undefined
				? parseInstantMs(current.effectiveUntil)
				: undefined;
		for (let j = i + 1; j < sorted.length; j += 1) {
			const other = sorted[j]!;
			const otherFrom = parseInstantMs(other.record.effectiveFrom);
			if (otherFrom === currentFrom) {
				throw new AccountRateHistoryError(
					`Account "${accountId}" has duplicate effectiveFrom "${current.record.effectiveFrom}".`,
				);
			}
			if (currentUntil !== undefined && otherFrom < currentUntil) {
				throw new AccountRateHistoryError(
					`Account "${accountId}" has overlapping explicit intervals: the record effective "${current.record.effectiveFrom}" claims coverage until "${current.effectiveUntil}", which overlaps the record effective "${other.record.effectiveFrom}".`,
				);
			}
		}
	}

	return Object.freeze(sorted.map((candidate) => candidate.record));
}
