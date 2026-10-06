import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Context,
  type TranscriptContext,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { projectResponseHeaders } from "./diagnostics.js";
import { projectAliasAssistantEvent } from "./public-assistant-projection.js";

export const ANTHROPIC_ALIAS_API = "hypha-anthropic-oauth" as const;

export type AnthropicUpstreamStream = (
  model: Model<Api>,
  context: Context | TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Legacy Pi 0.84 context-shaped stream consumed by the exact-provenance adaptive adapter. */
export type AnthropicLegacyStream = (
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
    headers: projectResponseHeaders(response.headers),
  };
}

function reattributeStream(
  upstream: AssistantMessageEventStream,
  aliasModel: Model<Api>,
): AssistantMessageEventStream {
  const attributed = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of upstream) {
      attributed.push(projectAliasAssistantEvent(event, aliasModel));
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
