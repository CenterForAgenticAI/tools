// The model broker adapter (K6): a Gateway whose models are pi-ai's OpenAI Codex and Anthropic catalog entries, and whose
// every request goes to a model broker that holds the provider accounts. Like the OpenRouter adapter, this side holds
// only a client secret that gets it short-lived credentials (D-7). The broker relays two wire formats: OpenAI Codex
// Responses, over SSE only, and Anthropic Messages. Platform-free: it uses fetch and nothing else, and importing it
// starts nothing.
import type { Api, Model, ProviderStreams, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { gatewayAccess } from "./gateway-access.ts";
import type { Gateway } from "./host/core.ts";

export type BrokerGatewayOptions = {
	/** The broker's URL. The adapter posts the scope to `<url>/v1/access`. */
	readonly url: string;
	/** The client secret the broker bound to this product. It is sent to the broker's access endpoint only. */
	readonly secret: string;
	/** Model ids the agent may name, such as `gpt-6.1-sol` or `claude-sonnet-5`. Each must be in pi-ai's OpenAI Codex or Anthropic catalog. */
	readonly models: readonly string[];
	/** Used for every request to the broker: access and model requests. */
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
};

const CATALOG = { ...OPENAI_CODEX_MODELS, ...ANTHROPIC_MODELS } as unknown as Readonly<Record<string, Model<Api> | undefined>>;

/**
 * pi-ai's Codex stream reads a ChatGPT account id out of its API key, a JWT, and throws on anything else. It gets this
 * unsigned placeholder instead, and the request goes out with the broker's credential, which is never decoded. The
 * `chatgpt-account-id` header pi-ai derives from it is removed: the broker adds the account's own.
 */
const CODEX_PLACEHOLDER = [{ alg: "none", typ: "JWT" }, { "https://api.openai.com/auth": { chatgpt_account_id: "model-broker" } }]
	.map((part) => btoa(JSON.stringify(part)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"))
	.concat("unsigned")
	.join(".");
/** What pi-ai's Anthropic stream gets as its key. Its `x-api-key` header is removed before the request leaves. */
const ANTHROPIC_PLACEHOLDER = "model-broker";
/** Headers that carry a provider credential or account. The broker sets its own; the host sends none of them. */
const DROPPED = ["x-api-key", "chatgpt-account-id"];
/** The error a model call ends with when the broker already ran a request under its idempotency key. */
const ALREADY_COMPLETED = "the model broker already ran this model call and does not send it again";

/**
 * A Gateway for OpenAI Codex and Anthropic models served through a model broker. Throws when a model id is not in
 * either catalog. `access` asks the broker for a credential for the scope and keeps it per scope until a minute before
 * it expires. Every model request carries that credential as a bearer token and no provider credential; Codex requests
 * go over SSE only. When the broker answers that it already ran a request under the same idempotency key, the model call
 * ends with an error and is not sent again.
 */
export function brokerGateway(options: BrokerGatewayOptions): Gateway {
	if (options.models.length === 0) throw new Error("the gateway needs at least one model");
	const models = [...new Set(options.models)].map((id) => {
		const model = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
		if (model === undefined) throw new Error(`"${id}" is not an OpenAI Codex or Anthropic model pi-ai knows`);
		return model;
	});
	const send = options.fetch;
	return {
		models,
		streams: {
			"openai-codex-responses": brokered(openAICodexResponsesApi(), (o) => ({ ...o, apiKey: CODEX_PLACEHOLDER, transport: "sse" }), send),
			"anthropic-messages": brokered(anthropicMessagesApi(), (o) => ({ ...o, apiKey: ANTHROPIC_PLACEHOLDER }), send),
		},
		access: gatewayAccess(options),
	};
}

/** `api` with each request's credential moved from its key to a bearer token on a fetch that strips provider credentials. */
function brokered(api: ProviderStreams, adapt: <O extends StreamOptions>(options: O) => O, send: typeof fetch | undefined): ProviderStreams {
	const wrap = <O extends StreamOptions>(options: O | undefined): O => {
		const credential = options?.apiKey;
		if (credential === undefined || credential === "") throw new Error("the model broker gave no credential");
		return adapt({ ...options, fetch: bearer(credential, send ?? options?.fetch) } as O);
	};
	return {
		stream: (model, context, options) => api.stream(model, context, wrap(options)),
		streamSimple: (model, context, options) => api.streamSimple(model, context, wrap(options)),
	};
}

/**
 * A fetch for one model call: it sends `credential` as the bearer token and no provider credential. Once the broker
 * answers that it already ran the call, every later send of it gets that answer here and never reaches the broker:
 * pi-ai's Codex client retries any failed request when `maxRetries` allows, a refusal included.
 */
function bearer(credential: string, send: typeof fetch | undefined): typeof fetch {
	let refused = false;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (refused) return alreadyCompleted();
		const headers = new Headers(init?.headers);
		for (const name of DROPPED) headers.delete(name);
		headers.set("authorization", `Bearer ${credential}`);
		const response = await (send ?? fetch)(input, { ...init, headers });
		if (response.status !== 409) return response;
		const text = await response.text();
		if (refusalCode(text) !== "already-completed") return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
		refused = true;
		return alreadyCompleted();
	}) as typeof fetch;
}

/**
 * The broker ran this call once already. The fixed text matches none of the errors pi-ai or pi-durable retry, so the
 * turn ends with it.
 */
const alreadyCompleted = () =>
	new Response(JSON.stringify({ type: "error", error: { type: "already_completed", code: "already-completed", message: ALREADY_COMPLETED } }), {
		status: 409,
		headers: { "content-type": "application/json" },
	});

function refusalCode(text: string): unknown {
	try {
		return (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
	} catch {
		return undefined;
	}
}
