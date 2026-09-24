/**
 * OpenAI platform-API alias registration (REQ-NATIVE-API-ALIAS-AUTH).
 *
 * The distinct `openai` platform family is reached by the vendor's own
 * pay-per-token API using a stored `api_key` credential, not an OAuth
 * subscription. Unlike the Codex alias, this needs no stream reattribution and
 * no OAuth capture: the OpenAI platform provider is a plain API-key provider on
 * Pi's built-in `openai-responses` handler, so an alias only has to declare
 * real API-key auth and the `OPENAI_MODELS` catalog re-pointed at its own
 * provider id. Pi resolves the alias slot's stored `api_key` at dispatch; this
 * module never reads the key value.
 *
 * Catalog source is capture-or-compose: the live model registry's base `openai`
 * provider catalog when the host has registered it (the pinned Pi 0.84.4 ships
 * it), else the pinned `@earendil-works/pi-ai` `openaiProvider()` factory. Base
 * providers are only read, never mutated or re-registered.
 */

import type {
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { cloneProviderModelCatalog } from "./catalog-rebinding.js";

/** pi-ai model API id for the OpenAI platform Responses API. */
export const OPENAI_ALIAS_API = "openai-responses" as const;
/** The base OpenAI platform provider id shipped by pi-ai. */
export const OPENAI_BASE_PROVIDER = "openai" as const;
/** Env var the OpenAI platform provider resolves its API key from. */
const OPENAI_API_KEY_ENV = "OPENAI_API_KEY" as const;
/** Base URL the pinned pi-ai `openaiProvider()` declares. */
const OPENAI_BASE_URL = "https://api.openai.com/v1" as const;

export class OpenAiAdapterContractError extends Error {
	constructor(message: string) {
		super(
			`[openai platform contract] ${message} ` +
				"Run npm run upstream:check and review UPSTREAM.md before release.",
		);
		this.name = "OpenAiAdapterContractError";
	}
}

/**
 * Model configs for the OpenAI platform catalog, deeply isolated from any
 * registry-owned object. Prefers the live registry's base `openai` catalog;
 * falls back to the pinned pi-ai `openaiProvider()` factory when the host has
 * not registered a base `openai` provider. The registry-owned `provider`
 * identity is stripped so the caller can re-point each model at the alias id.
 */
export function openaiPlatformModels(
	registry: unknown,
): readonly ProviderModelConfig[] {
	const captured = tryCaptureRegistryModels(registry);
	if (captured.length > 0) return captured;
	return composeModelsFromFactory();
}

function tryCaptureRegistryModels(
	registry: unknown,
): readonly ProviderModelConfig[] {
	try {
		return cloneProviderModelCatalog(registry, OPENAI_BASE_PROVIDER);
	} catch {
		// The base openai provider is not registered in this session's registry;
		// fall back to the pinned factory catalog rather than failing.
		return [];
	}
}

function composeModelsFromFactory(): readonly ProviderModelConfig[] {
	const provider = openaiProvider();
	const models = provider.getModels();
	if (models.length === 0) {
		throw new OpenAiAdapterContractError(
			"The pinned pi-ai openai provider factory yielded no models.",
		);
	}
	return models.map((model: unknown) => {
		// Strip the registry-owned provider identity; keep every other field so
		// the alias catalog stays a lossless superset of the base catalog.
		const clone = structuredClone(model) as ProviderModelConfig & {
			provider?: unknown;
		};
		delete clone.provider;
		return clone as ProviderModelConfig;
	});
}

/**
 * Builds an OpenAI platform-API alias `ProviderConfig` for one numbered slot:
 * real API-key auth (`$OPENAI_API_KEY`), the `openai-responses` API, and the
 * platform catalog re-pointed at the alias. No OAuth, no custom stream — Pi's
 * built-in `openai-responses` handler serves it once it resolves the slot's
 * stored `api_key`.
 */
export function createOpenAiAliasProviderConfig(
	sourceModels: readonly ProviderModelConfig[],
	aliasDisplayLabel: string,
): ProviderConfig {
	if (sourceModels.length === 0) {
		throw new OpenAiAdapterContractError(
			"Cannot register an OpenAI platform alias with an empty model catalog.",
		);
	}
	return {
		api: OPENAI_ALIAS_API,
		baseUrl: OPENAI_BASE_URL,
		apiKey: `$${OPENAI_API_KEY_ENV}`,
		models: sourceModels.map((model) => ({
			...structuredClone(model),
			api: OPENAI_ALIAS_API,
			name: `${model.name} (${aliasDisplayLabel})`,
		})),
	};
}
