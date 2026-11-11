// The model gateway adapters (K6, spec 3.3). The OpenRouter adapter is a Gateway whose models are OpenRouter catalog
// entries and whose every request goes to a gateway service, never to OpenRouter with a provider key. The service holds
// the key; this side holds only a client secret that lets it ask the service for short-lived credentials (D-7). The
// model broker adapter is in gateway-broker.ts. Platform-free: they use fetch and nothing else, and importing them
// starts nothing.
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { gatewayAccess } from "./gateway-access.ts";
import type { Gateway } from "./host/core.ts";

export type { Access } from "./gateway-access.ts";
export { brokerGateway, type BrokerGatewayOptions } from "./gateway-broker.ts";

export type OpenRouterGatewayOptions = {
	/** The gateway service's URL. The adapter posts the scope to `<url>/v1/access`. */
	readonly url: string;
	/** The client secret the service bound to this product. It is sent to the service only, never to a model. */
	readonly secret: string;
	/** OpenRouter model ids the agent may name, such as `openai/gpt-5-mini`. Each must be in pi-ai's OpenRouter catalog. */
	readonly models: readonly string[];
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
};

const APIS: readonly Api[] = ["openai-completions", "anthropic-messages"];

const CATALOG = OPENROUTER_MODELS as unknown as Readonly<Record<string, Model<Api> | undefined>>;

/**
 * A Gateway for OpenRouter models served through a gateway service. Throws when a model id is not in the catalog. `access`
 * asks the service for a credential for the scope and keeps it per scope until a minute before it expires; callers that
 * ask at the same time share one request, and a failed request is not kept.
 */
export function openRouterGateway(options: OpenRouterGatewayOptions): Gateway {
	if (options.models.length === 0) throw new Error("the gateway needs at least one model");
	const models = [...new Set(options.models)].map((id) => {
		const model = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
		if (model === undefined || !APIS.includes(model.api)) throw new Error(`"${id}" is not an OpenRouter chat model pi-ai knows`);
		return model;
	});
	return {
		models,
		streams: { "openai-completions": openAICompletionsApi(), "anthropic-messages": anthropicMessagesApi() },
		access: gatewayAccess(options),
	};
}
