/**
 * Fresh machine-global config schema for the multi-account extension.
 *
 * Accepts the Anthropic, OpenAI Codex, and Google Antigravity subscription
 * families. OpenRouter and every unsupported family are rejected from the
 * effective route graph. Same-family failover is enabled by default;
 * cross-family chaining is disabled by default and, when explicitly enabled,
 * only the explicit pairs in {@link ALLOWED_CROSS_FAMILY_PAIRS} are permitted:
 * both Anthropic↔Codex directions, and all four Antigravity directions
 * (Anthropic↔Antigravity and Codex↔Antigravity). Authorizing one direction
 * never implies its reverse.
 * No project-local override loading.
 *
 * Config and state files are written atomically with POSIX mode 0600 and their
 * owning directory is constrained to 0700 (REQ-PERM-1).
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { PROJECT_KEY_PATTERN } from "./project-identity.js";
import {
	AccountRateHistoryError,
	normalizeAccountRateHistory,
	parseAccountRateRecord,
	type AccountRateRecord,
} from "./account-rate-history.js";
import {
	PRESET_ID_PATTERN,
	SubscriptionPlanCatalogError,
	parseSubscriptionPlanCatalogOverride,
	type SubscriptionPlanCatalogOverride,
} from "./subscription-plan-catalog.js";
import {
	MAX_TIER_MODEL_ID_LENGTH,
	type TierModelDestination,
	type TierModelMap,
} from "./tier-model-resolver.js";

export const ALLOWED_FAMILIES = [
	"anthropic",
	"openai-codex",
	"google-antigravity",
] as const;
export type AllowedFamily = (typeof ALLOWED_FAMILIES)[number];

/**
 * Owning-vendor-API families reached by a vendor's own pay-per-token platform
 * API rather than a subscription. This is the distinct `openai` platform
 * provider only; Anthropic's owning-vendor-API tier is the existing `anthropic`
 * family with an `api_key` credential, not a separate token.
 */
export const OWNING_VENDOR_API_FAMILIES = ["openai"] as const;

/**
 * Every managed provider family: the subscription families plus the
 * owning-vendor-API families. Discovery, registration, completion, status, and
 * cost and physical-routing surfaces operate over this set. The unified logical
 * provider also consumes the managed set, but projects `openai-codex` and
 * `openai` through their shared OpenAI vendor while retaining their distinct
 * subscription and owning-vendor-API tiers. The v1 route resolver, usage config,
 * subscription cost, and directional cross-family chains stay on the narrower
 * {@link ALLOWED_FAMILIES}.
 */
export const MANAGED_FAMILIES = [
	...ALLOWED_FAMILIES,
	...OWNING_VENDOR_API_FAMILIES,
] as const;
export type ManagedFamily = (typeof MANAGED_FAMILIES)[number];

/**
 * The absolute maximum number of managed account slots per family, base
 * included. Every numbered-slot enumerator, canonical-id constructor, and
 * downstream credential/registration/state/item sink is bounded by this value
 * before any synchronous work begins, so a hostile or oversized configuration
 * cannot cause discovery, spare search, add-slot search, or completion to visit
 * a slot above it. Configuration accepts only integer account limits from `1`
 * through this maximum.
 */
export const MAX_ACCOUNT_LIMIT = 32;

/**
 * Accepts an account limit: an integer in `1..MAX_ACCOUNT_LIMIT`. This is the
 * one predicate that both config validation and every slot iterator consult
 * before enumerating, so a limit above the maximum never reaches a formatter.
 */
export function isAccountLimit(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_ACCOUNT_LIMIT
	);
}

/**
 * Accepts a numbered account slot index for the current validated limit: an
 * integer in `1..accountLimit` when `accountLimit` itself satisfies
 * {@link isAccountLimit}. Every direct iterator consumer revalidates each
 * yielded index with this predicate before it formats a canonical id or causes
 * a side effect, so a regressed iterator cannot smuggle a slot past a formatter.
 */
export function isAccountSlotIndex(
	value: unknown,
	accountLimit: number,
): value is number {
	if (!isAccountLimit(accountLimit)) return false;
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= accountLimit
	);
}

/**
 * The canonical managed provider id for one family and numbered slot, or `null`
 * when the family, index, or current limit is invalid. Slot `1` is the base
 * family id; slots `2..accountLimit` are `${family}-account-${slotIndex}`. This
 * is the only production constructor used by the direct iterator consumers and
 * downstream current-limit guards for base and numbered managed slot ids.
 */
export function canonicalProviderIdForAccountSlot(
	family: ManagedFamily,
	slotIndex: number,
	accountLimit: number,
): string | null {
	if (!isManagedFamily(family)) return null;
	if (!isAccountSlotIndex(slotIndex, accountLimit)) return null;
	return slotIndex === 1 ? family : `${family}-account-${slotIndex}`;
}

/**
 * The sole production loop that increments a numbered account slot. It
 * validates `accountLimit` and `firstSlot` before its first yield, accepts only
 * `firstSlot: 1 | 2`, and yields each integer from `firstSlot` through
 * `accountLimit` once in ascending order. No other production loop may increment
 * a numbered account slot; every numbered-slot path consumes this iterator and
 * revalidates each yield independently.
 */
export function* accountSlotIndexes(
	accountLimit: number,
	firstSlot: 1 | 2,
): IterableIterator<number> {
	if (!isAccountLimit(accountLimit)) return;
	if (firstSlot !== 1 && firstSlot !== 2) return;
	for (let slot = firstSlot; slot <= accountLimit; slot++) {
		yield slot;
	}
}

export const KNOWN_REJECTED_FAMILIES = ["openrouter"] as const;

export interface CrossFamilyChain {
	readonly from: AllowedFamily;
	readonly to: AllowedFamily;
}

export interface MultiAccountConfig {
	readonly accountLimit: number;
	readonly sameFamilyFailover: boolean;
	readonly crossFamilyChainEnabled: boolean;
	readonly crossFamilyChains: readonly CrossFamilyChain[];
	readonly watchdogIntervalMs: number;
	readonly cooldownMaxMs: number;
	/** Idle time allowed between qualifying progress events in one recovery invocation. */
	readonly recoveryIdleTimeoutMs: number;
	/** Total elapsed time allowed for one complete recovery invocation. */
	readonly recoveryAbsoluteTimeoutMs: number;
	/**
	 * Operator-chosen display labels keyed by canonical provider id, so managed
	 * accounts are distinguishable in Pi's login list and the status view.
	 * Anthropic credentials are opaque, so configuration is the only way to name
	 * them; Codex labels can be derived from the credential's identity claim.
	 */
	readonly accountLabels: Readonly<Record<string, string>>;
	/** Local-only display mapping for bounded project digests. Raw paths are invalid. */
	readonly projectLabels: Readonly<Record<string, string>>;
	/**
	 * Named allow-lists of explicit canonical OAuth provider ids. Group names are
	 * local policy identifiers; members never derive from labels, email addresses,
	 * or credential metadata.
	 */
	readonly accountGroups?: Readonly<Record<string, readonly string[]>>;
	/** Exact absolute cwd to account-group id defaults. No project-root folding. */
	readonly accountGroupCwdDefaults?: Readonly<Record<string, string>>;
	/** Optional machine-wide fallback when no exact-cwd or session override applies. */
	readonly defaultAccountGroup?: string;
	/**
	 * Monthly subscription price in USD, keyed by canonical managed provider
	 * id. Legacy, mutable, and retroactive: it has no effective start. Kept
	 * readable and untouched for compatibility; not migrated into
	 * {@link MultiAccountConfig.accountRateHistory}.
	 */
	readonly monthlySubscriptionUsd: Readonly<Record<string, number>>;
	/**
	 * Machine-global overrides for the shipped subscription-plan preset
	 * catalog ({@link ../config/subscription-plans.v1.json}), keyed by preset
	 * id. A key that matches a shipped id replaces that preset; any other key
	 * adds a validated custom preset. There is no project-local catalog layer.
	 */
	readonly subscriptionPlanCatalogOverrides?: Readonly<
		Record<string, SubscriptionPlanCatalogOverride>
	>;
	/**
	 * Effective-dated USD rate records per canonical accountId, ordered
	 * ascending by `effectiveFrom`. Selecting a catalog preset copies its
	 * terms into the record, so a later catalog edit never rewrites an
	 * existing record. No duplicate or overlapping `effectiveFrom` instants;
	 * never carries a default end, renewal, or effective instant.
	 */
	readonly accountRateHistory?: Readonly<Record<string, readonly AccountRateRecord[]>>;
	/**
	 * Per-family model preference, best first, keyed by family.
	 *
	 * Consulted when failover crosses FAMILIES, where the failed turn's model id
	 * is meaningless: `claude-opus-5` does not exist in the Codex catalog. Without
	 * a preference the destination falls back to the catalog head -- whatever
	 * happens to be first -- which is the defect fixed in 37c4317, where an opus
	 * turn silently resumed on fable.
	 *
	 * Ported from the Sarrius reference (index.ts:3784-3790), which reached the
	 * same conclusion: a per-family list rather than N-by-N model pairs. Adding a
	 * model to a list is enough; there is no mapping matrix to maintain.
	 *
	 * Same-family failover ignores this entirely and keeps the exact model.
	 */
	readonly preferredModels: Readonly<Record<string, readonly string[]>>;
	readonly tierModelMap: TierModelMap;
	/**
	 * How close to expiry a credential may get before routing prefers a fresher
	 * same-family account, in milliseconds. Pre-emption avoids spending a turn to
	 * discover an expiry that was predictable. Zero disables pre-emption, leaving
	 * purely reactive routing.
	 */
	readonly preemptiveExpiryWindowMs: number;
	/** Whether undocumented provider usage fetches run for each managed family. */
	readonly usageFetchEnabled?: Readonly<Record<AllowedFamily, boolean>>;
}

export const DEFAULT_USAGE_FETCH_ENABLED: Readonly<
	Record<AllowedFamily, boolean>
> = Object.freeze({
	anthropic: true,
	"openai-codex": true,
	"google-antigravity": true,
});

/** Warming starts before pre-flight's expiry avoidance window can trigger. */
export const CREDENTIAL_WARMING_WINDOW_MULTIPLIER = 2;

export function credentialWarmingThresholdMs(
	config: Pick<MultiAccountConfig, "preemptiveExpiryWindowMs">,
): number {
	return config.preemptiveExpiryWindowMs * CREDENTIAL_WARMING_WINDOW_MULTIPLIER;
}

export const DEFAULT_CONFIG: MultiAccountConfig = {
	accountLimit: 4,
	sameFamilyFailover: true,
	crossFamilyChainEnabled: false,
	crossFamilyChains: [],
	watchdogIntervalMs: 30_000,
	cooldownMaxMs: 300_000,
	recoveryIdleTimeoutMs: 5 * 60_000,
	recoveryAbsoluteTimeoutMs: 30 * 60_000,
	accountLabels: {},
	projectLabels: {},
	accountGroups: {},
	accountGroupCwdDefaults: {},
	monthlySubscriptionUsd: {},
	subscriptionPlanCatalogOverrides: {},
	accountRateHistory: {},
	preferredModels: {},
	tierModelMap: Object.freeze({}),
	// Comfortably longer than a turn, short enough that accounts are not retired
	// while they still have useful life.
	preemptiveExpiryWindowMs: 120_000,
	usageFetchEnabled: DEFAULT_USAGE_FETCH_ENABLED,
};

const CONFIG_KEYS = new Set<keyof MultiAccountConfig>([
	"accountLimit",
	"sameFamilyFailover",
	"crossFamilyChainEnabled",
	"crossFamilyChains",
	"watchdogIntervalMs",
	"cooldownMaxMs",
	"recoveryIdleTimeoutMs",
	"recoveryAbsoluteTimeoutMs",
	"accountLabels",
	"projectLabels",
	"accountGroups",
	"accountGroupCwdDefaults",
	"defaultAccountGroup",
	"monthlySubscriptionUsd",
	"subscriptionPlanCatalogOverrides",
	"accountRateHistory",
	"preferredModels",
	"tierModelMap",
	"preemptiveExpiryWindowMs",
	"usageFetchEnabled",
]);

/**
 * Validates the optional `accountLabels` map. Rejects non-object containers and
 * non-string entries so a malformed config fails closed at load rather than
 * surfacing a broken label at render time.
 */
function parseUsageFetchEnabled(
	value: unknown,
): Readonly<Record<AllowedFamily, boolean>> {
	if (value === undefined) return DEFAULT_USAGE_FETCH_ENABLED;
	if (!isRecord(value)) {
		throw new ConfigValidationError("usageFetchEnabled must be a JSON object.");
	}
	const unknownKeys = Object.keys(value).filter(
		(key) => !isAllowedFamily(key),
	);
	if (unknownKeys.length > 0) {
		throw new ConfigValidationError(
			`usageFetchEnabled has unsupported family "${unknownKeys[0]}".`,
		);
	}
	const anthropic = value["anthropic"];
	if (typeof anthropic !== "boolean") {
		throw new ConfigValidationError(
			"usageFetchEnabled.anthropic must be a boolean.",
		);
	}
	const openaiCodex = value["openai-codex"];
	if (typeof openaiCodex !== "boolean") {
		throw new ConfigValidationError(
			"usageFetchEnabled.openai-codex must be a boolean.",
		);
	}
	const googleAntigravity = value["google-antigravity"];
	if (
		googleAntigravity !== undefined &&
		typeof googleAntigravity !== "boolean"
	) {
		throw new ConfigValidationError(
			"usageFetchEnabled.google-antigravity must be a boolean.",
		);
	}
	return Object.freeze({
		anthropic,
		"openai-codex": openaiCodex,
		"google-antigravity": googleAntigravity ?? true,
	});
}

function parseAccountLabels(value: unknown): Readonly<Record<string, string>> {
	if (value === undefined) return DEFAULT_CONFIG.accountLabels;
	if (!isRecord(value)) {
		throw new ConfigValidationError("accountLabels must be a JSON object.");
	}
	const labels: Record<string, string> = {};
	for (const [providerId, label] of Object.entries(value)) {
		const slotIndex = configuredManagedProviderSlotIndex(providerId);
		if (slotIndex !== null && slotIndex > MAX_ACCOUNT_LIMIT) {
			throw new ConfigValidationError(ACCOUNT_LABEL_LIMIT_ERROR);
		}
		if (typeof label !== "string") {
			throw new ConfigValidationError(
				`accountLabels.${providerId} must be a string.`,
			);
		}
		labels[providerId] = label;
	}
	return Object.freeze(labels);
}

const MAX_PROJECT_LABEL_LENGTH = 128;

function parseProjectLabels(value: unknown): Readonly<Record<string, string>> {
	if (value === undefined) return DEFAULT_CONFIG.projectLabels;
	if (!isRecord(value)) {
		throw new ConfigValidationError("projectLabels must be a JSON object.");
	}
	const labels: Record<string, string> = {};
	for (const [projectKey, label] of Object.entries(value)) {
		if (!PROJECT_KEY_PATTERN.test(projectKey)) {
			throw new ConfigValidationError(
				`projectLabels.${projectKey} must use a bounded project digest key.`,
			);
		}
		if (
			typeof label !== "string" ||
			label.trim().length === 0 ||
			label.length > MAX_PROJECT_LABEL_LENGTH
		) {
			throw new ConfigValidationError(
				`projectLabels.${projectKey} must be a non-empty string of at most ${MAX_PROJECT_LABEL_LENGTH} characters.`,
			);
		}
		labels[projectKey] = label;
	}
	return Object.freeze(labels);
}

/**
 * The numbered slot an operator-supplied config key names, or `null` when the
 * key is not a canonical managed provider id in `families`. The base family id
 * maps to slot `1`; `${family}-account-${decimal}` maps to its safe integer
 * slot only when the decimal is at least `2`, carries no sign, fraction,
 * exponent, whitespace, or leading zero, and round-trips through `String(slot)`;
 * every unknown family and other string maps to `null`. It normalizes nothing
 * and performs no I/O.
 *
 * The `families` parameter is the predicate split: `parseAccountLabels()` passes
 * the managed set (an `openai` label key is valid), while
 * `parseMonthlySubscriptionUsd()` passes the subscription set (an `openai` id
 * must be rejected — an owning-vendor-API family is not a subscription-cost key).
 */
function configuredProviderSlotIndex(
	providerId: string,
	families: readonly string[],
): number | null {
	for (const family of families) {
		if (providerId === family) return 1;
		const prefix = `${family}-account-`;
		if (!providerId.startsWith(prefix)) continue;
		const suffix = providerId.slice(prefix.length);
		const slot = Number(suffix);
		return Number.isSafeInteger(slot) && slot >= 2 && String(slot) === suffix
			? slot
			: null;
	}
	return null;
}

/** Managed-scoped slot recognizer: accepts `openai` keys (labels). */
function configuredManagedProviderSlotIndex(providerId: string): number | null {
	return configuredProviderSlotIndex(providerId, MANAGED_FAMILIES);
}

/** Subscription-scoped slot recognizer: rejects `openai` keys (monthly cost). */
function configuredSubscriptionProviderSlotIndex(
	providerId: string,
): number | null {
	return configuredProviderSlotIndex(providerId, ALLOWED_FAMILIES);
}

/**
 * True when `accountId` is the canonical id of a subscription-scoped managed
 * account slot -- an {@link ALLOWED_FAMILIES} member, base or numbered --
 * within the current `accountLimit`. Reuses the exact same slot recognizer
 * `parseMonthlySubscriptionUsd()` and `parseAccountRateHistory()` apply, so
 * "is a configured account" means one thing across every config-shape
 * validator and the `account set-plan` CLI surface that must agree with it.
 */
export function isCanonicalSubscriptionAccountId(
	accountId: string,
	accountLimit: number,
): boolean {
	if (!isAccountLimit(accountLimit)) return false;
	const slotIndex = configuredSubscriptionProviderSlotIndex(accountId);
	return slotIndex !== null && slotIndex <= accountLimit;
}

/** Fixed, bounded, key-free rejection for an over-limit canonical label key. */
export const ACCOUNT_LABEL_LIMIT_ERROR =
	"accountLabels contains a canonical managed provider id above slot 32.";
/** Fixed, bounded, key-free rejection for an over-limit canonical subscription key. */
export const SUBSCRIPTION_LIMIT_ERROR =
	"monthlySubscriptionUsd contains a canonical managed provider id above slot 32.";

function parseMonthlySubscriptionUsd(
	value: unknown,
): Readonly<Record<string, number>> {
	if (value === undefined) return DEFAULT_CONFIG.monthlySubscriptionUsd;
	if (!isRecord(value)) {
		throw new ConfigValidationError(
			"monthlySubscriptionUsd must be a JSON object.",
		);
	}
	const costs: Record<string, number> = {};
	for (const [providerId, monthlyCost] of Object.entries(value)) {
		const slotIndex = configuredSubscriptionProviderSlotIndex(providerId);
		if (slotIndex === null) {
			throw new ConfigValidationError(
				`monthlySubscriptionUsd.${providerId} is not a canonical managed provider id.`,
			);
		}
		if (slotIndex > MAX_ACCOUNT_LIMIT) {
			throw new ConfigValidationError(SUBSCRIPTION_LIMIT_ERROR);
		}
		if (
			typeof monthlyCost !== "number" ||
			!Number.isFinite(monthlyCost) ||
			monthlyCost <= 0
		) {
			throw new ConfigValidationError(
				`monthlySubscriptionUsd.${providerId} must be a finite positive USD amount.`,
			);
		}
		costs[providerId] = monthlyCost;
	}
	return Object.freeze(costs);
}

const MAX_SUBSCRIPTION_PLAN_OVERRIDE_ID_LENGTH = 64;

/**
 * Validates the optional `subscriptionPlanCatalogOverrides` map: preset id ->
 * override fields. Reuses the catalog module's own field-level validation so
 * there is exactly one definition of a valid preset entry; wraps its errors
 * as `ConfigValidationError` so every config-schema failure shares one error
 * class. There is no project-local catalog layer -- this is the only place
 * subscription-plan overrides are read.
 */
function parseSubscriptionPlanCatalogOverrides(
	value: unknown,
): Readonly<Record<string, SubscriptionPlanCatalogOverride>> {
	if (value === undefined) {
		return DEFAULT_CONFIG.subscriptionPlanCatalogOverrides ?? {};
	}
	if (!isRecord(value)) {
		throw new ConfigValidationError(
			"subscriptionPlanCatalogOverrides must be a JSON object.",
		);
	}
	const overrides: Record<string, SubscriptionPlanCatalogOverride> = {};
	for (const [presetId, rawOverride] of Object.entries(value)) {
		if (
			presetId.length === 0 ||
			presetId.length > MAX_SUBSCRIPTION_PLAN_OVERRIDE_ID_LENGTH ||
			!PRESET_ID_PATTERN.test(presetId)
		) {
			throw new ConfigValidationError(
				`subscriptionPlanCatalogOverrides has an invalid preset id "${presetId}".`,
			);
		}
		try {
			overrides[presetId] = parseSubscriptionPlanCatalogOverride(
				rawOverride,
				`subscriptionPlanCatalogOverrides.${presetId}`,
			);
		} catch (error) {
			if (error instanceof SubscriptionPlanCatalogError) {
				throw new ConfigValidationError(error.message);
			}
			throw error;
		}
	}
	return Object.freeze(overrides);
}

/**
 * Validates the optional `accountRateHistory` map: canonical accountId ->
 * an array of already-selected rate records. Each key must be the same
 * canonical managed provider id shape used by `monthlySubscriptionUsd`, and
 * each record's own `accountId` field must equal its map key. Reuses the
 * account-rate-history module's own record and ordering validation, wrapping
 * its errors as `ConfigValidationError`.
 */
function parseAccountRateHistory(
	value: unknown,
): Readonly<Record<string, readonly AccountRateRecord[]>> {
	if (value === undefined) return DEFAULT_CONFIG.accountRateHistory ?? {};
	if (!isRecord(value)) {
		throw new ConfigValidationError("accountRateHistory must be a JSON object.");
	}
	const history: Record<string, readonly AccountRateRecord[]> = {};
	try {
		for (const [accountId, rawRecords] of Object.entries(value)) {
			const slotIndex = configuredSubscriptionProviderSlotIndex(accountId);
			if (slotIndex === null) {
				throw new ConfigValidationError(
					`accountRateHistory.${accountId} is not a canonical managed provider id.`,
				);
			}
			if (slotIndex > MAX_ACCOUNT_LIMIT) {
				throw new ConfigValidationError(SUBSCRIPTION_LIMIT_ERROR);
			}
			if (!Array.isArray(rawRecords)) {
				throw new ConfigValidationError(
					`accountRateHistory.${accountId} must be an array of rate records.`,
				);
			}
			const candidates = rawRecords.map((rawRecord, index) => {
				const record = parseAccountRateRecord(
					rawRecord,
					`accountRateHistory.${accountId}[${index}]`,
				);
				if (record.accountId !== accountId) {
					throw new ConfigValidationError(
						`accountRateHistory.${accountId}[${index}].accountId must equal "${accountId}".`,
					);
				}
				return { record };
			});
			history[accountId] = normalizeAccountRateHistory(candidates);
		}
	} catch (error) {
		if (error instanceof AccountRateHistoryError) {
			throw new ConfigValidationError(error.message);
		}
		throw error;
	}
	return Object.freeze(history);
}

/**
 * Validates the optional `preferredModels` map: family -> ordered model ids.
 *
 * Strict, because a config error here breaks every agent on this machine at
 * startup. An unknown family is rejected rather than ignored: silently dropping
 * a typo'd key would leave the operator believing a preference is in force when
 * a catalog head is being shipped instead, which is precisely the failure this
 * config exists to prevent.
 */
function parsePreferredModels(
	value: unknown,
): Readonly<Record<string, readonly string[]>> {
	if (value === undefined) return DEFAULT_CONFIG.preferredModels;
	if (!isRecord(value)) {
		throw new ConfigValidationError("preferredModels must be a JSON object.");
	}
	const preferred: Record<string, readonly string[]> = {};
	for (const [family, models] of Object.entries(value)) {
		if (!isAllowedFamily(family)) {
			throw new ConfigValidationError(
				`preferredModels.${family} is not a managed family.`,
			);
		}
		if (!Array.isArray(models)) {
			throw new ConfigValidationError(
				`preferredModels.${family} must be an array of model ids.`,
			);
		}
		for (const modelId of models) {
			if (typeof modelId !== "string" || modelId.length === 0) {
				throw new ConfigValidationError(
					`preferredModels.${family} entries must be non-empty strings.`,
				);
			}
		}
		preferred[family] = Object.freeze([...(models as readonly string[])]);
	}
	return Object.freeze(preferred);
}

const TIER_MODEL_DESTINATIONS: readonly TierModelDestination[] = [
	"anthropic",
	"openai",
	"openrouter",
];
const MAX_TIER_MODEL_ENTRIES = 256;
const TIER_MODEL_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isTierModelDestination(
	value: string,
): value is TierModelDestination {
	return TIER_MODEL_DESTINATIONS.includes(value as TierModelDestination);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	try {
		const prototype = Object.getPrototypeOf(value) as unknown;
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function isValidTierModelId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_TIER_MODEL_ID_LENGTH &&
		value.trim().length > 0 &&
		!TIER_MODEL_CONTROL_CHARACTER.test(value)
	);
}

export function parseTierModelMap(value: unknown): TierModelMap {
	if (value === undefined) return DEFAULT_CONFIG.tierModelMap;
	if (!isRecord(value)) {
		throw new ConfigValidationError("tierModelMap must be a JSON object.");
	}

	const destinations: Array<{
		readonly destination: TierModelDestination;
		readonly entries: readonly (readonly [string, unknown])[];
	}> = [];
	let totalEntries = 0;
	for (const [destination, destinationValue] of Object.entries(value)) {
		if (!isTierModelDestination(destination)) {
			throw new ConfigValidationError(
				`tierModelMap has unsupported destination "${destination}".`,
			);
		}
		if (!isPlainObject(destinationValue)) {
			throw new ConfigValidationError(
				`tierModelMap.${destination} must be a plain object.`,
			);
		}
		const entries = Object.entries(destinationValue);
		totalEntries += entries.length;
		if (totalEntries > MAX_TIER_MODEL_ENTRIES) {
			throw new ConfigValidationError(
				`tierModelMap must contain at most ${MAX_TIER_MODEL_ENTRIES} entries.`,
			);
		}
		destinations.push({ destination, entries });
	}

	const projected: Partial<
		Record<TierModelDestination, Readonly<Record<string, string>>>
	> = {};
	for (const { destination, entries } of destinations) {
		// A null-prototype object so a source id of `__proto__` (a valid
		// model-id string) creates a real own entry instead of invoking the
		// legacy prototype setter and being silently dropped, and so the
		// resolver's later `map[dest][requested]` read cannot return an inherited
		// `Object.prototype` member (e.g. `constructor`, `toString`).
		const destinationProjection: Record<string, string> = Object.create(
			null,
		) as Record<string, string>;
		for (const [sourceId, destinationId] of entries) {
			if (sourceId === "*") {
				throw new ConfigValidationError(
					`tierModelMap.${destination} cannot use the reserved source key "*".`,
				);
			}
			if (!isValidTierModelId(sourceId)) {
				throw new ConfigValidationError(
					`tierModelMap.${destination} source ids must be non-empty strings without control characters and at most ${MAX_TIER_MODEL_ID_LENGTH} characters.`,
				);
			}
			if (!isValidTierModelId(destinationId)) {
				throw new ConfigValidationError(
					`tierModelMap.${destination} destination ids must be non-empty strings without control characters and at most ${MAX_TIER_MODEL_ID_LENGTH} characters.`,
				);
			}
			destinationProjection[sourceId] = destinationId;
		}
		projected[destination] = Object.freeze(destinationProjection);
	}
	return Object.freeze(projected);
}

/**
 * The currently permitted cross-family pairs: both Anthropic↔Codex
 * directions, and all four Antigravity directions (into and out of each of
 * its two managed partners, Anthropic and Codex). Every direction is its own
 * explicit tuple; authorizing one direction never authorizes its reverse, so
 * `anthropic` → `google-antigravity` requires its own entry independent of
 * `google-antigravity` → `anthropic`, and likewise for the Codex↔Antigravity
 * pair.
 */
export const ALLOWED_CROSS_FAMILY_PAIRS: ReadonlyArray<
	readonly [AllowedFamily, AllowedFamily]
> = [
	["anthropic", "openai-codex"],
	["openai-codex", "anthropic"],
	["google-antigravity", "anthropic"],
	["anthropic", "google-antigravity"],
	["google-antigravity", "openai-codex"],
	["openai-codex", "google-antigravity"],
];

export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(`[multi-account config] ${message}`);
		this.name = "ConfigValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const ACCOUNT_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isAccountGroupId(value: unknown): value is string {
	return typeof value === "string" && ACCOUNT_GROUP_ID_PATTERN.test(value);
}

function parseAccountGroups(
	value: unknown,
	accountLimit: number,
): Readonly<Record<string, readonly string[]>> {
	if (value === undefined) return DEFAULT_CONFIG.accountGroups ?? {};
	if (!isRecord(value)) {
		throw new ConfigValidationError("accountGroups must be a JSON object.");
	}
	const groups = Object.create(null) as Record<string, readonly string[]>;
	for (const [groupId, members] of Object.entries(value)) {
		if (!isAccountGroupId(groupId)) {
			throw new ConfigValidationError(
				"accountGroups group ids must use 1 through 64 letters, digits, dots, underscores, or hyphens.",
			);
		}
		if (!Array.isArray(members)) {
			throw new ConfigValidationError(`accountGroups.${groupId} must be an array.`);
		}
		const providerIds = members.map((member, index) => {
			if (
				typeof member !== "string" ||
				!isCanonicalSubscriptionAccountId(member, accountLimit)
			) {
				throw new ConfigValidationError(
					`accountGroups.${groupId}[${index}] must be a canonical managed subscription provider id within accountLimit.`,
				);
			}
			return member;
		});
		groups[groupId] = Object.freeze(providerIds);
	}
	return Object.freeze(groups);
}

function parseAccountGroupCwdDefaults(
	value: unknown,
	groups: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, string>> {
	if (value === undefined) return DEFAULT_CONFIG.accountGroupCwdDefaults ?? {};
	if (!isRecord(value)) {
		throw new ConfigValidationError(
			"accountGroupCwdDefaults must be a JSON object.",
		);
	}
	const defaults = Object.create(null) as Record<string, string>;
	for (const [cwd, groupId] of Object.entries(value)) {
		if (!isAbsolute(cwd) || cwd.includes("\u0000")) {
			throw new ConfigValidationError(
				"accountGroupCwdDefaults keys must be absolute directory paths.",
			);
		}
		if (typeof groupId !== "string" || !Object.hasOwn(groups, groupId)) {
			throw new ConfigValidationError(
				"accountGroupCwdDefaults values must name a configured accountGroups entry.",
			);
		}
		defaults[cwd] = groupId;
	}
	return Object.freeze(defaults);
}

function parseDefaultAccountGroup(
	value: unknown,
	groups: Readonly<Record<string, readonly string[]>>,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !Object.hasOwn(groups, value)) {
		throw new ConfigValidationError(
			"defaultAccountGroup must name a configured accountGroups entry.",
		);
	}
	return value;
}

export function isAllowedFamily(family: string): family is AllowedFamily {
	return (ALLOWED_FAMILIES as readonly string[]).includes(family);
}

/**
 * Broad managed-family predicate: the subscription families plus the
 * owning-vendor-API `openai` family. Use for canonical identity, discovery,
 * registration, completion, and the account listing — anywhere an `openai`
 * account must be recognized. Subscription-tier checks (proactive routing, the
 * v1 resolver, usage config, subscription cost, cross-family chains, and the
 * logical provider's subscription-tier usage attribution) keep using
 * {@link isAllowedFamily}; the logical provider's routing pool itself also
 * admits owning-vendor-API accounts.
 */
export function isManagedFamily(family: string): family is ManagedFamily {
	return (MANAGED_FAMILIES as readonly string[]).includes(family);
}

export function assertFamilyAllowed(
	family: string,
): asserts family is AllowedFamily {
	if (!isAllowedFamily(family)) {
		const hint = (KNOWN_REJECTED_FAMILIES as readonly string[]).includes(family)
			? ` (${family} is explicitly excluded from the route graph)`
			: "";
		throw new ConfigValidationError(
			`Family "${family}" is not in the allowed set [${ALLOWED_FAMILIES.join(", ")}]${hint}. ` +
				"Only managed subscription families may appear in the effective route graph.",
		);
	}
}

export function validateCrossChain(chain: CrossFamilyChain): void {
	assertFamilyAllowed(chain.from);
	assertFamilyAllowed(chain.to);
	if (chain.from === chain.to) {
		throw new ConfigValidationError(
			`Cross-family chain from "${chain.from}" to itself is not permitted.`,
		);
	}
	const allowed = ALLOWED_CROSS_FAMILY_PAIRS.some(
		([from, to]) => from === chain.from && to === chain.to,
	);
	if (!allowed) {
		throw new ConfigValidationError(
			`Cross-family chain from "${chain.from}" to "${chain.to}" is not permitted. ` +
				"Each cross-family direction requires its own explicit pair in ALLOWED_CROSS_FAMILY_PAIRS.",
		);
	}
}

/**
 * Collapses duplicate directional edges, keeping the FIRST occurrence.
 *
 * The base parser has always accepted duplicates and routing already treats
 * them as one membership fact (`crossFamilyChains.some(...)`). Rejecting them
 * would make a machine-global file that worked yesterday fail extension
 * initialization closed today, which is a worse outcome than a redundant entry.
 * First-seen order is kept because the stored order is operator-authored, even
 * though it does not express runtime precedence.
 */
export function normalizeCrossFamilyChains(
	chains: readonly CrossFamilyChain[],
): readonly CrossFamilyChain[] {
	const seen = new Set<string>();
	const normalized: CrossFamilyChain[] = [];
	for (const chain of chains) {
		const key = `${chain.from}\u0000${chain.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(chain);
	}
	return normalized;
}

function parseCrossFamilyChains(value: unknown): readonly CrossFamilyChain[] {
	if (!Array.isArray(value)) {
		throw new ConfigValidationError("crossFamilyChains must be an array.");
	}

	const parsed = value.map((candidate, index) => {
		if (!isRecord(candidate)) {
			throw new ConfigValidationError(
				`crossFamilyChains[${index}] must be an object.`,
			);
		}
		const unknownKeys = Object.keys(candidate).filter(
			(key) => key !== "from" && key !== "to",
		);
		if (unknownKeys.length > 0) {
			throw new ConfigValidationError(
				`crossFamilyChains[${index}] has unsupported field "${unknownKeys[0]}".`,
			);
		}
		if (
			typeof candidate["from"] !== "string" ||
			typeof candidate["to"] !== "string"
		) {
			throw new ConfigValidationError(
				`crossFamilyChains[${index}] must contain string from/to fields.`,
			);
		}
		assertFamilyAllowed(candidate["from"]);
		assertFamilyAllowed(candidate["to"]);
		const chain: CrossFamilyChain = {
			from: candidate["from"],
			to: candidate["to"],
		};
		validateCrossChain(chain);
		return chain;
	});
	return normalizeCrossFamilyChains(parsed);
}

/**
 * The config fields the interactive configure flow may change, and the only
 * fields it may publish into a running process.
 *
 * Everything else read from disk during a routing edit stays on disk: applying
 * it to the live closure would change account, usage, or label behavior without
 * the rediscovery that `/multi-account reload` performs.
 */
export const ROUTING_CONFIG_FIELDS = Object.freeze([
	"crossFamilyChainEnabled",
	"crossFamilyChains",
	"preferredModels",
	"tierModelMap",
] as const);

export type RoutingConfigField = (typeof ROUTING_CONFIG_FIELDS)[number];

export interface RoutingProjection {
	readonly crossFamilyChainEnabled: boolean;
	readonly crossFamilyChains: readonly CrossFamilyChain[];
	readonly preferredModels: Readonly<Record<string, readonly string[]>>;
	readonly tierModelMap: TierModelMap;
}

export type NonRoutingProjection = Omit<MultiAccountConfig, RoutingConfigField>;

export function routingProjection(
	config: Pick<MultiAccountConfig, RoutingConfigField>,
): RoutingProjection {
	return {
		crossFamilyChainEnabled: config.crossFamilyChainEnabled,
		crossFamilyChains: normalizeCrossFamilyChains(config.crossFamilyChains),
		preferredModels: config.preferredModels,
		tierModelMap: config.tierModelMap,
	};
}

export function nonRoutingProjection(
	config: MultiAccountConfig,
): NonRoutingProjection {
	const {
		crossFamilyChainEnabled: _enabled,
		crossFamilyChains: _chains,
		preferredModels: _preferred,
		tierModelMap: _tierModelMap,
		...rest
	} = config;
	return rest;
}

/**
 * Order-insensitive canonical form for comparison only.
 *
 * Object key order is a JSON accident: two configs whose `preferredModels` keys
 * were written in a different order describe the same policy. Array order is
 * NOT normalized, because best-first model order and stored edge order are
 * operator intent.
 */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, nested]) => [key, canonical(nested)]);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

export function routingProjectionsEqual(
	left: RoutingProjection,
	right: RoutingProjection,
): boolean {
	return (
		canonicalJson(routingProjection(left)) ===
		canonicalJson(routingProjection(right))
	);
}

export function nonRoutingProjectionsEqual(
	left: MultiAccountConfig,
	right: MultiAccountConfig,
): boolean {
	return (
		canonicalJson(nonRoutingProjection(left)) ===
		canonicalJson(nonRoutingProjection(right))
	);
}

/**
 * Parses unknown machine-global JSON, materializes omitted fields from the
 * fresh defaults, and rejects malformed or unknown fields before they can enter
 * the effective route graph.
 */
export function parseConfig(value: unknown): MultiAccountConfig {
	if (!isRecord(value)) {
		throw new ConfigValidationError("Config must be a JSON object.");
	}

	const unknownKeys = Object.keys(value).filter(
		(key) => !CONFIG_KEYS.has(key as keyof MultiAccountConfig),
	);
	if (unknownKeys.length > 0) {
		throw new ConfigValidationError(
			`Unsupported config field "${unknownKeys[0]}".`,
		);
	}

	const accountLimit = value["accountLimit"] ?? DEFAULT_CONFIG.accountLimit;
	const sameFamilyFailover =
		value["sameFamilyFailover"] ?? DEFAULT_CONFIG.sameFamilyFailover;
	const crossFamilyChainEnabled =
		value["crossFamilyChainEnabled"] ?? DEFAULT_CONFIG.crossFamilyChainEnabled;
	const crossFamilyChains = parseCrossFamilyChains(
		value["crossFamilyChains"] ?? DEFAULT_CONFIG.crossFamilyChains,
	);
	const watchdogIntervalMs =
		value["watchdogIntervalMs"] ?? DEFAULT_CONFIG.watchdogIntervalMs;
	const cooldownMaxMs = value["cooldownMaxMs"] ?? DEFAULT_CONFIG.cooldownMaxMs;
	const recoveryIdleTimeoutMs =
		value["recoveryIdleTimeoutMs"] ?? DEFAULT_CONFIG.recoveryIdleTimeoutMs;
	const recoveryAbsoluteTimeoutMs =
		value["recoveryAbsoluteTimeoutMs"] ?? DEFAULT_CONFIG.recoveryAbsoluteTimeoutMs;
	const accountLabels = parseAccountLabels(value["accountLabels"]);
	const projectLabels = parseProjectLabels(value["projectLabels"]);
	const monthlySubscriptionUsd = parseMonthlySubscriptionUsd(
		value["monthlySubscriptionUsd"],
	);
	const subscriptionPlanCatalogOverrides = parseSubscriptionPlanCatalogOverrides(
		value["subscriptionPlanCatalogOverrides"],
	);
	const accountRateHistory = parseAccountRateHistory(value["accountRateHistory"]);
	const preferredModels = parsePreferredModels(value["preferredModels"]);
	const tierModelMap = parseTierModelMap(value["tierModelMap"]);
	const preemptiveExpiryWindowMs =
		value["preemptiveExpiryWindowMs"] ??
		DEFAULT_CONFIG.preemptiveExpiryWindowMs;
	const usageFetchEnabled = parseUsageFetchEnabled(value["usageFetchEnabled"]);

	if (!isAccountLimit(accountLimit)) {
		throw new ConfigValidationError(
			`accountLimit must be an integer from 1 through ${MAX_ACCOUNT_LIMIT}.`,
		);
	}
	const accountGroups = parseAccountGroups(value["accountGroups"], accountLimit);
	const accountGroupCwdDefaults = parseAccountGroupCwdDefaults(
		value["accountGroupCwdDefaults"],
		accountGroups,
	);
	const defaultAccountGroup = parseDefaultAccountGroup(
		value["defaultAccountGroup"],
		accountGroups,
	);
	if (typeof sameFamilyFailover !== "boolean") {
		throw new ConfigValidationError("sameFamilyFailover must be a boolean.");
	}
	if (typeof crossFamilyChainEnabled !== "boolean") {
		throw new ConfigValidationError(
			"crossFamilyChainEnabled must be a boolean.",
		);
	}
	if (
		typeof watchdogIntervalMs !== "number" ||
		!Number.isFinite(watchdogIntervalMs) ||
		watchdogIntervalMs < 1_000
	) {
		throw new ConfigValidationError(
			"watchdogIntervalMs must be a finite number of at least 1000 ms.",
		);
	}
	if (
		typeof cooldownMaxMs !== "number" ||
		!Number.isFinite(cooldownMaxMs) ||
		cooldownMaxMs < 0
	) {
		throw new ConfigValidationError(
			"cooldownMaxMs must be a finite non-negative number.",
		);
	}
	for (const [field, timeoutMs] of [
		["recoveryIdleTimeoutMs", recoveryIdleTimeoutMs],
		["recoveryAbsoluteTimeoutMs", recoveryAbsoluteTimeoutMs],
	] as const) {
		if (
			typeof timeoutMs !== "number" ||
			!Number.isFinite(timeoutMs) ||
			timeoutMs < 1_000
		) {
			throw new ConfigValidationError(
				`${field} must be a finite number of at least 1000 ms.`,
			);
		}
	}
	if (
		typeof preemptiveExpiryWindowMs !== "number" ||
		!Number.isFinite(preemptiveExpiryWindowMs) ||
		preemptiveExpiryWindowMs < 0
	) {
		throw new ConfigValidationError(
			"preemptiveExpiryWindowMs must be a finite non-negative number.",
		);
	}

	const parsedConfig: MultiAccountConfig = {
		accountLimit: accountLimit as number,
		sameFamilyFailover,
		crossFamilyChainEnabled,
		crossFamilyChains,
		watchdogIntervalMs,
		cooldownMaxMs,
		recoveryIdleTimeoutMs: recoveryIdleTimeoutMs as number,
		recoveryAbsoluteTimeoutMs: recoveryAbsoluteTimeoutMs as number,
		accountLabels,
		projectLabels,
		accountGroups,
		accountGroupCwdDefaults,
		monthlySubscriptionUsd,
		subscriptionPlanCatalogOverrides,
		accountRateHistory,
		preferredModels,
		tierModelMap,
		preemptiveExpiryWindowMs,
		usageFetchEnabled,
	};
	if (defaultAccountGroup === undefined) return parsedConfig;
	return { ...parsedConfig, defaultAccountGroup };
}

export function validateConfig(
	config: unknown,
): asserts config is MultiAccountConfig {
	parseConfig(config);
}

/**
 * Reads and validates the config from disk. Returns DEFAULT_CONFIG when the
 * file does not exist. Missing fields are materialized from DEFAULT_CONFIG;
 * malformed values and unsupported fields fail closed. Never loads a
 * project-local override.
 */
export function readConfig(configPath: string): MultiAccountConfig {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return parseConfig({});
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ConfigValidationError(
			`Config file at ${configPath} is not valid JSON.`,
		);
	}

	return parseConfig(parsed);
}

function fsyncDirectory(directory: string): void {
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

/**
 * `committed` means the new bytes are authoritative AND their mode and
 * durability were verified. `committed-warning` means the atomic rename already
 * happened -- so the new bytes are authoritative and any commit callback has
 * run -- but a later mode or durability step failed. The distinction exists
 * because a caller that publishes on commit cannot treat a post-rename failure
 * as "nothing happened".
 */
export type ConfigWriteOutcome = "committed" | "committed-warning";

/**
 * Validates then atomically replaces config using a same-directory 0600
 * temporary file. Existing permissive files are not reused, and both fresh and
 * existing owning directories are constrained to 0700 (REQ-PERM-1).
 *
 * `onCommitted` runs as the FIRST statement after `renameSync`, so a caller can
 * publish the committed value before any step that may still fail. It must not
 * throw; a throw is treated as a post-rename failure because disk is already
 * replaced.
 */
export function writeConfig(
	configPath: string,
	config: MultiAccountConfig,
	onCommitted?: () => void,
): ConfigWriteOutcome {
	const normalized = parseConfig(config);
	const directory = dirname(configPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);

	const temporaryPath = join(
		directory,
		`.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let descriptor: number | undefined;
	let replaced = false;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, {
			encoding: "utf-8",
		});
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, configPath);
		replaced = true;
		onCommitted?.();
		chmodSync(configPath, 0o600);
		fsyncDirectory(directory);
		return "committed";
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (replaced) return "committed-warning";
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
}
