/**
 * Prices for the strategy bench (pi-context-aware#469), read from the model registry Pi installs with
 * `@earendil-works/pi-ai`: input, output, cache-read and cache-write dollars per million tokens, with the
 * long-context tiers a model lists. No price is made up: a model the registry does not list is reported
 * as unpriced and costs nothing in the totals.
 */

import { PI_AI_VERSION } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Dollars per million tokens. */
export interface Rates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface RateTier extends Rates {
	/** The tier applies when a request's input tokens (uncached, read and written) exceed this. */
	readonly inputTokensAbove: number;
}

export interface PricedModel {
	/** `provider/model` of the registry entry the price came from. */
	readonly pricedAs: string;
	readonly rates: Rates;
	readonly tiers: readonly RateTier[];
	readonly contextWindow: number;
}

export interface PriceSource {
	readonly package: "@earendil-works/pi-ai";
	readonly version: string;
	/** When the registry's model data was generated (ISO 8601), or null when it does not say. */
	readonly modelDataGeneratedAt: string | null;
}

export interface PriceBook {
	readonly source: PriceSource;
	/** The registry entry for a recorded provider and model; `undefined` when the registry lists neither. */
	lookup(provider: string, model: string): PricedModel | undefined;
}

/**
 * Providers tried, in this order, for a model whose recorded provider the registry does not list (a
 * proxy such as `unified`): the model's own vendor first, then the rest by id. Only an entry that
 * charges something counts, so a subscription listing at zero cost never prices a metered model.
 */
const VENDOR_ORDER = ["anthropic", "openai", "google", "xai", "deepseek", "mistral", "moonshotai", "zai", "minimax"];

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

function ratesOf(cost: unknown): Rates {
	const fields = (typeof cost === "object" && cost !== null ? cost : {}) as Record<string, unknown>;
	return { input: finite(fields.input), output: finite(fields.output), cacheRead: finite(fields.cacheRead), cacheWrite: finite(fields.cacheWrite) };
}

function pricedModel(provider: string, model: { readonly id: string; readonly contextWindow?: number; readonly cost?: unknown }): PricedModel {
	const cost = (typeof model.cost === "object" && model.cost !== null ? model.cost : {}) as { tiers?: unknown };
	const tiers = (Array.isArray(cost.tiers) ? cost.tiers : []).map((tier: unknown): RateTier => ({ ...ratesOf(tier), inputTokensAbove: finite((tier as { inputTokensAbove?: unknown }).inputTokensAbove) }))
		.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return { pricedAs: `${provider}/${model.id}`, rates: ratesOf(model.cost), tiers, contextWindow: finite(model.contextWindow) };
}

const charges = (rates: Rates): boolean => rates.input > 0 || rates.output > 0;

/** The price book of the installed registry. */
export function registryPriceBook(): PriceBook {
	const byProvider = new Map<string, Map<string, PricedModel>>();
	for (const provider of [...getBuiltinProviders()].sort()) {
		const models = new Map<string, PricedModel>();
		for (const model of getBuiltinModels(provider)) models.set(model.id, pricedModel(provider, model));
		byProvider.set(provider, models);
	}
	const fallbackOrder = [...VENDOR_ORDER.filter((id) => byProvider.has(id)), ...[...byProvider.keys()].filter((id) => !VENDOR_ORDER.includes(id))];
	const generated = getBuiltinModelDataGeneratedAt();
	return {
		source: { package: "@earendil-works/pi-ai", version: PI_AI_VERSION, modelDataGeneratedAt: typeof generated === "number" && Number.isFinite(generated) ? new Date(generated).toISOString() : null },
		lookup(provider, model) {
			const exact = byProvider.get(provider)?.get(model);
			if (exact) return exact;
			for (const id of fallbackOrder) {
				const found = byProvider.get(id)?.get(model);
				if (found && charges(found.rates)) return found;
			}
			return undefined;
		},
	};
}

/** The rates for a request of `inputTokens` input tokens: the highest tier it exceeds, else the base rates. */
export function ratesFor(model: PricedModel, inputTokens: number): Rates {
	let rates = model.rates;
	for (const tier of model.tiers) if (inputTokens > tier.inputTokensAbove) rates = tier;
	return rates;
}

/** How a request's written tokens are charged. */
export type WriteCharge =
	/** The provider bills cache writes: the registry's cache-write rate. */
	| "cache-write"
	/** The provider reports no cache writes (it caches on its own and bills uncached input): the input rate. */
	| "input";

export interface TokenCounts {
	/** Uncached input that is not written to the cache. */
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Of `cacheWrite`, tokens written with one-hour retention: twice the input rate, as `calculateCost` in `@earendil-works/pi-ai` charges. */
	readonly cacheWrite1h?: number;
	readonly output: number;
}

export interface Cost {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly output: number;
}

export const ZERO_COST: Cost = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

/** Dollars for one request. Cache reads, cache writes and uncached input are priced separately; nothing is priced flat. */
export function priceRequest(model: PricedModel | undefined, tokens: TokenCounts, write: WriteCharge): Cost {
	if (!model) return ZERO_COST;
	const rates = ratesFor(model, tokens.input + tokens.cacheRead + tokens.cacheWrite);
	const long = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite);
	const writeRate = write === "cache-write" ? rates.cacheWrite : rates.input;
	return {
		input: (tokens.input * rates.input) / 1e6,
		cacheRead: (tokens.cacheRead * rates.cacheRead) / 1e6,
		cacheWrite: ((tokens.cacheWrite - long) * writeRate + long * rates.input * 2) / 1e6,
		output: (tokens.output * rates.output) / 1e6,
	};
}

export function addCost(a: Cost, b: Cost): Cost {
	return { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output };
}
