import type { Api, Model, ModelCostRates } from "@earendil-works/pi-ai";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_ENABLE_ENV = "PI_MULTI_ACCOUNT_OPENROUTER_ENABLED";
export const OPENROUTER_ENABLE_VALUE = "conversation-egress";
export const OPENROUTER_MODEL_ENV = "PI_MULTI_ACCOUNT_OPENROUTER_MODEL";
export const OPENROUTER_DAILY_LIMIT_ENV =
	"PI_MULTI_ACCOUNT_OPENROUTER_DAILY_USD_LIMIT";

const MAX_MODEL_ID_LENGTH = 200;
const MAX_DAILY_LIMIT_USD = 1_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/;
const USD_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;

export type OpenRouterPolicyReason =
	| "enabled"
	| "not-enabled"
	| "delegate-session"
	| "model-unconfigured"
	| "budget-unconfigured"
	| "session-disabled";

export type OpenRouterEnvironmentPolicy =
	| {
			readonly enabled: true;
			readonly reason: "enabled";
			readonly modelId: string;
			readonly dailyLimitUsd: number;
			readonly conversationEgressConsented: true;
			readonly delegatesAllowed: false;
	  }
	| {
			readonly enabled: false;
			readonly reason: Exclude<OpenRouterPolicyReason, "enabled">;
			readonly conversationEgressConsented: boolean;
			readonly delegatesAllowed: false;
	  };

export function isDelegateEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): boolean {
	return Object.keys(environment).some((key) => {
		if (!key.startsWith("PI_DELEGATE_LINEAGE_")) return false;
		const value = environment[key];
		return typeof value === "string" && value.length > 0;
	});
}

/**
 * Resolve the explicit per-project OpenRouter policy without reading the API key.
 * Partial, malformed, absent, and delegate-process configurations all disable the
 * metered rung without turning an optional capability into a startup failure.
 */
export function resolveOpenRouterEnvironmentPolicy(options: {
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly sessionDisabled?: boolean;
} = {}): OpenRouterEnvironmentPolicy {
	const environment = options.environment ?? process.env;
	const consented =
		environment[OPENROUTER_ENABLE_ENV] === OPENROUTER_ENABLE_VALUE;
	const disabled = (
		reason: Exclude<OpenRouterPolicyReason, "enabled">,
	): OpenRouterEnvironmentPolicy => ({
		enabled: false,
		reason,
		conversationEgressConsented: consented,
		delegatesAllowed: false,
	});
	if (options.sessionDisabled) return disabled("session-disabled");
	if (isDelegateEnvironment(environment)) return disabled("delegate-session");
	if (!consented) return disabled("not-enabled");

	const modelId = environment[OPENROUTER_MODEL_ENV]?.trim();
	if (
		modelId === undefined ||
		modelId.length === 0 ||
		modelId.length > MAX_MODEL_ID_LENGTH ||
		!MODEL_ID_PATTERN.test(modelId)
	) {
		return disabled("model-unconfigured");
	}
	const rawLimit = environment[OPENROUTER_DAILY_LIMIT_ENV]?.trim();
	if (rawLimit === undefined || !USD_PATTERN.test(rawLimit)) {
		return disabled("budget-unconfigured");
	}
	const dailyLimitUsd = Number(rawLimit);
	if (
		!Number.isFinite(dailyLimitUsd) ||
		dailyLimitUsd <= 0 ||
		dailyLimitUsd > MAX_DAILY_LIMIT_USD
	) {
		return disabled("budget-unconfigured");
	}
	return {
		enabled: true,
		reason: "enabled",
		modelId,
		dailyLimitUsd,
		conversationEgressConsented: true,
		delegatesAllowed: false,
	};
}

function validRates(value: ModelCostRates): boolean {
	return [value.input, value.output, value.cacheRead, value.cacheWrite].every(
		(rate) => Number.isFinite(rate) && rate >= 0,
	);
}

/**
 * Conservative maximum charge for one request using Pi's live model catalogue.
 * Context and output maxima are both charged, intentionally double-counting the
 * output share of a context window. The largest base/tier/cache rate wins.
 */
export function worstCaseOpenRouterTurnUsd(
	model: Model<Api>,
): number | undefined {
	if (
		model.provider !== OPENROUTER_PROVIDER_ID ||
		!Number.isSafeInteger(model.contextWindow) ||
		model.contextWindow <= 0 ||
		!Number.isSafeInteger(model.maxTokens) ||
		model.maxTokens <= 0 ||
		!validRates(model.cost)
	) {
		return undefined;
	}
	const rates: readonly ModelCostRates[] = [
		model.cost,
		...(model.cost.tiers ?? []),
	];
	if (!rates.every(validRates)) return undefined;
	const inputRate = Math.max(
		...rates.flatMap((rate) => [
			rate.input,
			rate.input * 2,
			rate.cacheRead,
			rate.cacheWrite,
		]),
	);
	const outputRate = Math.max(...rates.map((rate) => rate.output));
	const total =
		(model.contextWindow * inputRate + model.maxTokens * outputRate) /
		1_000_000;
	return Number.isFinite(total) && total > 0 ? total : undefined;
}
