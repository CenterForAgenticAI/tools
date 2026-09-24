import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  sanitizeDiagnosticText,
  sanitizeHeaderValue,
} from "./diagnostics.js";

export const ANTHROPIC_ALIAS_API = "hypha-anthropic-oauth" as const;

export type AnthropicUpstreamStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * Copies and sanitizes response metadata before it crosses into an
 * extension-owned callback. The upstream response and headers are never
 * retained or serialized by this adapter.
 */
export function sanitizeAnthropicProviderResponse(
  response: ProviderResponse,
): ProviderResponse {
  return {
    status: response.status,
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [
        sanitizeDiagnosticText(name),
        sanitizeHeaderValue(name, value),
      ]),
    ),
  };
}

function withAliasAttribution(
  message: AssistantMessage,
  aliasModel: Model<Api>,
): AssistantMessage {
  return {
    ...message,
    api: aliasModel.api,
    provider: aliasModel.provider,
    model: aliasModel.id,
  };
}

function sanitizeUpstreamError(message: AssistantMessage): AssistantMessage {
  if (message.errorMessage === undefined) return message;
  return {
    ...message,
    errorMessage: sanitizeDiagnosticText(message.errorMessage),
  };
}

function withAliasEvent(
  event: AssistantMessageEvent,
  aliasModel: Model<Api>,
): AssistantMessageEvent {
  switch (event.type) {
    case "done":
      return {
        ...event,
        message: withAliasAttribution(event.message, aliasModel),
      };
    case "error":
      return {
        ...event,
        error: withAliasAttribution(
          sanitizeUpstreamError(event.error),
          aliasModel,
        ),
      };
    default:
      return {
        ...event,
        partial: withAliasAttribution(event.partial, aliasModel),
      };
  }
}

function reattributeStream(
  upstream: AssistantMessageEventStream,
  aliasModel: Model<Api>,
): AssistantMessageEventStream {
  const attributed = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of upstream) {
      attributed.push(withAliasEvent(event, aliasModel));
    }
  })();

  return attributed;
}

/**
 * Creates the sole extension-owned Anthropic alias handler. Pi resolves the
 * alias credential before calling this function, so the adapter forwards the
 * complete options object (including apiKey) to upstream. Its only request-side
 * model change is a shallow clone with provider rebound to `anthropic`, which
 * keeps the exact upstream OAuth/Claude Code transport path active.
 */
export function createAnthropicAliasStream(
  upstreamStream: AnthropicUpstreamStream,
): AnthropicUpstreamStream {
  return (aliasModel, context, options) => {
    const upstreamModel: Model<Api> = {
      ...aliasModel,
      provider: "anthropic",
    };

    let upstreamOptions = options;
    if (options?.onResponse) {
      const aliasOnResponse = options.onResponse;
      upstreamOptions = {
        ...options,
        onResponse: async (response) => {
          await aliasOnResponse(
            sanitizeAnthropicProviderResponse(response),
            aliasModel,
          );
        },
      };
    }

    return reattributeStream(
      upstreamStream(upstreamModel, context, upstreamOptions),
      aliasModel,
    );
  };
}
