import { vendorForFamily, type Vendor } from "./vendor.js";

const MANAGED_AUTHORS = ["anthropic", "openai", "google"] as const;
const MAX_MODEL_COUNT = 4_096;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_TIER_COUNT = 16;
export const MAX_METHOD_LIMITS_LENGTH = 400;

export interface ApiModelRate {
	readonly sourceModelId: string;
	readonly inputPerToken: number;
	readonly outputPerToken: number;
	readonly cacheReadPerToken?: number;
	readonly cacheWritePerToken?: number;
	readonly cacheWrite1hPerToken?: number;
}

export interface ApiRateSnapshot {
	readonly schemaVersion: 1;
	readonly source: "openrouter";
	readonly fetchedAtMs: number;
	readonly rates: Readonly<Record<string, ApiModelRate>>;
}

/**
 * Per-token USD rates for one matched cost tier or a model's base rates,
 * exactly as Pi's own `calculateCost` reads `model.cost` / `model.cost.tiers`.
 * Values are USD per 1,000,000 tokens.
 */
export interface PiModelCostRates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** A request-wide pricing tier: applies when observed input tokens exceed `inputTokensAbove`. */
export interface PiModelCostTier extends PiModelCostRates {
	readonly inputTokensAbove: number;
}

/** One installed-catalog model's base rates plus any higher-volume tiers. */
export interface PiModelCost extends PiModelCostRates {
	readonly sourceModelId: string;
	readonly tiers?: readonly PiModelCostTier[];
}

/**
 * A caller-supplied snapshot of Pi's installed model catalog cost data.
 * `catalogVersion` is an opaque identity (for example the pinned pi-ai
 * package version) recorded verbatim as immutable pricing-method provenance;
 * this module never fetches or infers it.
 */
export interface PiCatalogSnapshot {
	readonly schemaVersion: 1;
	readonly source: "pi-installed-catalog";
	readonly catalogVersion: string;
	readonly capturedAtMs: number;
	readonly costsBySourceModelId: Readonly<Record<string, PiModelCost>>;
}

/**
 * Immutable provenance for one API-equivalent price: which source produced
 * it, which tier (if any) applied, and the bounded, human-readable limits of
 * that method. Persisted verbatim on priced digest rows and never recomputed.
 */
export interface ApiEquivalentMethod {
	readonly source: "pi-installed-catalog" | "openrouter" | "legacy-day-aggregate";
	readonly catalogVersion: string;
	readonly tierInputTokensAbove: number | undefined;
	readonly limits: string;
}

export interface EstimateTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h?: number;
}

export type ApiEquivalentEstimate =
	| {
			readonly status: "priced";
			readonly totalUsd: number;
			readonly rateAsOfMs: number;
			readonly sourceModelId: string;
			readonly components: {
				readonly inputUsd: number;
				readonly outputUsd: number;
				readonly cacheReadUsd: number;
				readonly cacheWriteUsd: number;
			};
	  }
	| { readonly status: "unpriced"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrice(value: unknown): number | undefined {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function managedModelId(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_MODEL_ID_LENGTH
	) {
		return false;
	}
	return MANAGED_AUTHORS.some((author) => value.startsWith(`${author}/`));
}

function parseRate(value: unknown, sourceModelId: string): ApiModelRate | undefined {
	if (!isRecord(value)) return undefined;
	const input = parsePrice(value.prompt);
	const output = parsePrice(value.completion);
	if (input === undefined || output === undefined) return undefined;
	const discount = value.discount === undefined ? 0 : value.discount;
	if (
		typeof discount !== "number" ||
		!Number.isFinite(discount) ||
		discount < 0 ||
		discount > 1
	) {
		return undefined;
	}
	const multiplier = 1 - discount;
	const optionalPrice = (field: string): number | undefined => {
		const raw = value[field];
		if (raw === undefined) return undefined;
		const parsed = parsePrice(raw);
		return parsed === undefined ? Number.NaN : parsed * multiplier;
	};
	const cacheRead = optionalPrice("input_cache_read");
	const cacheWrite = optionalPrice("input_cache_write");
	const cacheWrite1h = optionalPrice("input_cache_write_1h");
	if ([cacheRead, cacheWrite, cacheWrite1h].some(Number.isNaN)) return undefined;
	return Object.freeze({
		sourceModelId,
		inputPerToken: input * multiplier,
		outputPerToken: output * multiplier,
		...(cacheRead === undefined ? {} : { cacheReadPerToken: cacheRead }),
		...(cacheWrite === undefined ? {} : { cacheWritePerToken: cacheWrite }),
		...(cacheWrite1h === undefined
			? {}
			: { cacheWrite1hPerToken: cacheWrite1h }),
	});
}

/** Parse and bound the public OpenRouter model catalogue into a small rate map. */
export function parseOpenRouterRateSnapshot(
	payload: unknown,
	fetchedAtMs: number,
): ApiRateSnapshot {
	if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < 0) {
		throw new RangeError("fetchedAtMs must be a finite non-negative timestamp.");
	}
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new TypeError("OpenRouter model response must contain a data array.");
	}
	if (payload.data.length > MAX_MODEL_COUNT) {
		throw new RangeError("OpenRouter model response exceeds the model limit.");
	}

	const rates: Record<string, ApiModelRate> = {};
	for (const candidate of payload.data) {
		if (!isRecord(candidate) || !managedModelId(candidate.id)) continue;
		const rate = parseRate(candidate.pricing, candidate.id);
		if (rate === undefined) continue;
		if (rates[candidate.id] === undefined) rates[candidate.id] = rate;
		if (
			managedModelId(candidate.canonical_slug) &&
			rates[candidate.canonical_slug] === undefined
		) {
			rates[candidate.canonical_slug] = rate;
		}
	}
	return Object.freeze({
		schemaVersion: 1,
		source: "openrouter",
		fetchedAtMs,
		rates: Object.freeze(rates),
	});
}

function parseStoredRate(value: unknown): ApiModelRate | undefined {
	if (!isRecord(value) || !managedModelId(value.sourceModelId)) return undefined;
	const required = [value.inputPerToken, value.outputPerToken];
	const optional = [
		value.cacheReadPerToken,
		value.cacheWritePerToken,
		value.cacheWrite1hPerToken,
	].filter((entry) => entry !== undefined);
	if (
		![...required, ...optional].every(
			(entry) =>
				typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
		)
	) {
		return undefined;
	}
	return Object.freeze({
		sourceModelId: value.sourceModelId,
		inputPerToken: value.inputPerToken as number,
		outputPerToken: value.outputPerToken as number,
		...(value.cacheReadPerToken === undefined
			? {}
			: { cacheReadPerToken: value.cacheReadPerToken as number }),
		...(value.cacheWritePerToken === undefined
			? {}
			: { cacheWritePerToken: value.cacheWritePerToken as number }),
		...(value.cacheWrite1hPerToken === undefined
			? {}
			: { cacheWrite1hPerToken: value.cacheWrite1hPerToken as number }),
	});
}

/** Re-validate a persisted snapshot before any cached rate is trusted. */
export function parseStoredApiRateSnapshot(value: unknown): ApiRateSnapshot {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.source !== "openrouter" ||
		typeof value.fetchedAtMs !== "number" ||
		!Number.isFinite(value.fetchedAtMs) ||
		value.fetchedAtMs < 0 ||
		!isRecord(value.rates)
	) {
		throw new TypeError("Stored API rate snapshot is invalid.");
	}
	const entries = Object.entries(value.rates);
	if (entries.length > MAX_MODEL_COUNT * 2) {
		throw new RangeError("Stored API rate snapshot exceeds the model limit.");
	}
	const rates: Record<string, ApiModelRate> = {};
	for (const [modelId, candidate] of entries) {
		if (!managedModelId(modelId)) {
			throw new TypeError("Stored API rate snapshot has an invalid model id.");
		}
		const rate = parseStoredRate(candidate);
		if (rate === undefined) {
			throw new TypeError("Stored API rate snapshot has an invalid rate.");
		}
		rates[modelId] = rate;
	}
	return Object.freeze({
		schemaVersion: 1,
		source: "openrouter",
		fetchedAtMs: value.fetchedAtMs,
		rates: Object.freeze(rates),
	});
}

function accountAuthor(canonicalAccountId: string): Vendor | undefined {
	const family = canonicalAccountId.startsWith("anthropic")
		? "anthropic"
		: canonicalAccountId.startsWith("openai-codex")
			? "openai-codex"
			: canonicalAccountId.startsWith("google-antigravity")
				? "google-antigravity"
				: undefined;
	if (family === undefined) return undefined;
	if (canonicalAccountId !== family) {
		const prefix = `${family}-account-`;
		if (!canonicalAccountId.startsWith(prefix)) return undefined;
		const suffix = canonicalAccountId.slice(prefix.length);
		if (!/^[1-9]\d*$/.test(suffix) || Number(suffix) < 2) return undefined;
	}
	return vendorForFamily(family);
}

/** Resolve the exact managed-catalog key for a request: never borrow a neighbouring model's price. */
function resolveSourceModelId(
	canonicalAccountId: string,
	requestedModel: string,
): string | undefined {
	const author = accountAuthor(canonicalAccountId);
	if (
		author === undefined ||
		requestedModel.length === 0 ||
		requestedModel.length > MAX_MODEL_ID_LENGTH
	) {
		return undefined;
	}
	const sourceId = requestedModel.includes("/")
		? requestedModel
		: `${author}/${requestedModel}`;
	if (!sourceId.startsWith(`${author}/`)) return undefined;
	return sourceId;
}

/** Exact only: never borrow a neighbouring model's price. */
export function lookupApiRate(
	snapshot: ApiRateSnapshot,
	canonicalAccountId: string,
	requestedModel: string,
): ApiModelRate | undefined {
	const sourceId = resolveSourceModelId(canonicalAccountId, requestedModel);
	return sourceId === undefined ? undefined : snapshot.rates[sourceId];
}

/**
 * Exact only: look up one model's cost in Pi's installed catalog snapshot.
 * This is the authoritative tier metadata source; `lookupApiRate` above only
 * extends coverage for models this catalog lacks.
 */
export function lookupPiCatalogCost(
	snapshot: PiCatalogSnapshot,
	canonicalAccountId: string,
	requestedModel: string,
): PiModelCost | undefined {
	const sourceId = resolveSourceModelId(canonicalAccountId, requestedModel);
	return sourceId === undefined
		? undefined
		: snapshot.costsBySourceModelId[sourceId];
}

function validTokenCount(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value);
}

/** Price one retained token tuple without consulting or replacing retained cost. */
export function estimateApiEquivalentCost(
	tokens: EstimateTokens,
	rate: ApiModelRate,
	rateAsOfMs: number,
): ApiEquivalentEstimate {
	const longWrite = tokens.cacheWrite1h ?? 0;
	if (
		![
			tokens.input,
			tokens.output,
			tokens.cacheRead,
			tokens.cacheWrite,
			longWrite,
		].every(validTokenCount) ||
		longWrite > tokens.cacheWrite ||
		!Number.isFinite(rateAsOfMs)
	) {
		return { status: "unpriced", reason: "invalid-input" };
	}
	const shortWrite = tokens.cacheWrite - longWrite;
	if (tokens.cacheRead > 0 && rate.cacheReadPerToken === undefined) {
		return { status: "unpriced", reason: "missing-cache-read-rate" };
	}
	if (shortWrite > 0 && rate.cacheWritePerToken === undefined) {
		return { status: "unpriced", reason: "missing-cache-write-rate" };
	}
	if (longWrite > 0 && rate.cacheWrite1hPerToken === undefined) {
		return { status: "unpriced", reason: "missing-cache-write-1h-rate" };
	}

	const components = {
		inputUsd: tokens.input * rate.inputPerToken,
		outputUsd: tokens.output * rate.outputPerToken,
		cacheReadUsd: tokens.cacheRead * (rate.cacheReadPerToken ?? 0),
		cacheWriteUsd:
			shortWrite * (rate.cacheWritePerToken ?? 0) +
			longWrite * (rate.cacheWrite1hPerToken ?? 0),
	};
	const totalUsd =
		components.inputUsd +
		components.outputUsd +
		components.cacheReadUsd +
		components.cacheWriteUsd;
	if (!Number.isFinite(totalUsd)) {
		return { status: "unpriced", reason: "estimate-overflow" };
	}
	return {
		status: "priced",
		totalUsd,
		rateAsOfMs,
		sourceModelId: rate.sourceModelId,
		components,
	};
}

/** Bounded, human-readable limits disclosed on every Pi-installed-catalog-priced digest row. */
export const PI_CATALOG_METHOD_LIMITS =
	"Priced under this response's own token-volume tier from Pi's installed model catalog (model.cost.tiers matched by inputTokensAbove), independent of Pi's retained cost estimate.";

/** Bounded, human-readable limits disclosed when OpenRouter extends coverage for a model the installed catalog lacks. */
export const OPENROUTER_METHOD_LIMITS =
	"Priced from the cached OpenRouter public rate snapshot because this model is absent from Pi's installed catalog; OpenRouter publishes one flat rate with no per-volume tiering.";

/**
 * Select the tier whose rates apply to one response, exactly mirroring
 * Pi's own `calculateCost`: the highest `inputTokensAbove` threshold that
 * `input + cacheRead + cacheWrite` strictly exceeds. No matching tier keeps
 * the model's base rates and an undefined tier boundary.
 */
export function selectPiCostTier(
	cost: PiModelCost,
	tokens: EstimateTokens,
): {
	readonly rates: PiModelCostRates;
	readonly tierInputTokensAbove: number | undefined;
} {
	const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	let rates: PiModelCostRates = cost;
	let matchedThreshold = -1;
	let tierInputTokensAbove: number | undefined;
	for (const tier of cost.tiers ?? []) {
		if (
			inputTokens > tier.inputTokensAbove &&
			tier.inputTokensAbove > matchedThreshold
		) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
			tierInputTokensAbove = tier.inputTokensAbove;
		}
	}
	return { rates, tierInputTokensAbove };
}

export type PiCatalogApiEquivalentEstimate =
	| {
			readonly status: "priced";
			readonly totalUsd: number;
			readonly rateAsOfMs: number;
			readonly sourceModelId: string;
			readonly tierInputTokensAbove: number | undefined;
			readonly components: {
				readonly inputUsd: number;
				readonly outputUsd: number;
				readonly cacheReadUsd: number;
				readonly cacheWriteUsd: number;
			};
	  }
	| { readonly status: "unpriced"; readonly reason: string };

/**
 * Price one retained token tuple against Pi's installed catalog, exactly
 * matching Pi's own `calculateCost` formula (including the 2x-base-input
 * one-hour cache write surcharge). Never consults or replaces retained cost.
 */
export function estimatePiCatalogCost(
	tokens: EstimateTokens,
	cost: PiModelCost,
	rateAsOfMs: number,
): PiCatalogApiEquivalentEstimate {
	const longWrite = tokens.cacheWrite1h ?? 0;
	if (
		![
			tokens.input,
			tokens.output,
			tokens.cacheRead,
			tokens.cacheWrite,
			longWrite,
		].every(validTokenCount) ||
		longWrite > tokens.cacheWrite ||
		!Number.isFinite(rateAsOfMs)
	) {
		return { status: "unpriced", reason: "invalid-input" };
	}
	const { rates, tierInputTokensAbove } = selectPiCostTier(cost, tokens);
	const shortWrite = tokens.cacheWrite - longWrite;
	const components = {
		inputUsd: (tokens.input * rates.input) / 1_000_000,
		outputUsd: (tokens.output * rates.output) / 1_000_000,
		cacheReadUsd: (tokens.cacheRead * rates.cacheRead) / 1_000_000,
		cacheWriteUsd:
			(rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000,
	};
	const totalUsd =
		components.inputUsd +
		components.outputUsd +
		components.cacheReadUsd +
		components.cacheWriteUsd;
	if (!Number.isFinite(totalUsd)) {
		return { status: "unpriced", reason: "estimate-overflow" };
	}
	return {
		status: "priced",
		totalUsd,
		rateAsOfMs,
		sourceModelId: cost.sourceModelId,
		tierInputTokensAbove,
		components,
	};
}

function finiteNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePiModelCostRates(value: unknown): PiModelCostRates | undefined {
	if (
		!isRecord(value) ||
		![value.input, value.output, value.cacheRead, value.cacheWrite].every(
			finiteNonNegativeNumber,
		)
	) {
		return undefined;
	}
	return {
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
	};
}

function parsePiModelCostTier(value: unknown): PiModelCostTier | undefined {
	const rates = parsePiModelCostRates(value);
	if (rates === undefined || !isRecord(value)) return undefined;
	if (!finiteNonNegativeNumber(value.inputTokensAbove)) return undefined;
	return Object.freeze({ ...rates, inputTokensAbove: value.inputTokensAbove });
}

function parsePiModelCost(
	value: unknown,
	sourceModelId: string,
): PiModelCost | undefined {
	const rates = parsePiModelCostRates(value);
	if (rates === undefined || !isRecord(value)) return undefined;
	if (value.tiers === undefined) {
		return Object.freeze({ sourceModelId, ...rates });
	}
	if (!Array.isArray(value.tiers) || value.tiers.length > MAX_TIER_COUNT) {
		return undefined;
	}
	const tiers: PiModelCostTier[] = [];
	for (const candidate of value.tiers) {
		const tier = parsePiModelCostTier(candidate);
		if (tier === undefined) return undefined;
		tiers.push(tier);
	}
	return Object.freeze({
		sourceModelId,
		...rates,
		tiers: Object.freeze(tiers),
	});
}

/** Re-validate a caller-supplied installed-catalog snapshot before any cost is trusted. */
export function parsePiCatalogSnapshot(value: unknown): PiCatalogSnapshot {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.source !== "pi-installed-catalog" ||
		typeof value.catalogVersion !== "string" ||
		value.catalogVersion.length === 0 ||
		value.catalogVersion.length > MAX_MODEL_ID_LENGTH ||
		typeof value.capturedAtMs !== "number" ||
		!Number.isFinite(value.capturedAtMs) ||
		value.capturedAtMs < 0 ||
		!isRecord(value.costsBySourceModelId)
	) {
		throw new TypeError("Pi installed-catalog snapshot is invalid.");
	}
	const entries = Object.entries(value.costsBySourceModelId);
	if (entries.length > MAX_MODEL_COUNT) {
		throw new RangeError("Pi installed-catalog snapshot exceeds the model limit.");
	}
	const costsBySourceModelId: Record<string, PiModelCost> = {};
	for (const [modelId, candidate] of entries) {
		if (!managedModelId(modelId)) {
			throw new TypeError("Pi installed-catalog snapshot has an invalid model id.");
		}
		const cost = parsePiModelCost(candidate, modelId);
		if (cost === undefined) {
			throw new TypeError("Pi installed-catalog snapshot has an invalid model cost.");
		}
		costsBySourceModelId[modelId] = cost;
	}
	return Object.freeze({
		schemaVersion: 1,
		source: "pi-installed-catalog",
		catalogVersion: value.catalogVersion,
		capturedAtMs: value.capturedAtMs,
		costsBySourceModelId: Object.freeze(costsBySourceModelId),
	});
}
