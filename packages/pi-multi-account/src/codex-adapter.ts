/**
 * Codex base and alias provider registration via Pi's maintained
 * openai-codex-responses stream and OAuth callbacks (REQ-CODEX-1).
 *
 * No local transport or refresh flow is implemented. Alias handling is a
 * bounded identity adapter: Pi resolves the alias credential first, then the
 * adapter presents base Codex identity to the maintained stream, normalizes
 * same-alias history for reasoning/tool continuation, and restores alias
 * attribution on emitted events and callbacks.
 */

import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
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
import { cloneProviderModelCatalog } from "./catalog-rebinding.js";
import {
  sanitizeDiagnosticText,
  sanitizeHeaderValue,
} from "./diagnostics.js";

const CODEX_BASE_API = "openai-codex-responses" as const;
/**
 * Keep alias models on Pi's host-known API id. The provider-scoped
 * `streamSimple` adapter still wins normal dispatch, while direct helpers such
 * as compaction and delegate startup can resolve the built-in handler before
 * extension composition is available.
 */
export const CODEX_ALIAS_API = CODEX_BASE_API;
const CODEX_BASE_PROVIDER = "openai-codex" as const;

export interface CapturedCodexProvider {
  readonly name: "openai-codex";
  readonly baseUrl: string;
  readonly oauth: NonNullable<ProviderConfig["oauth"]>;
  readonly streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
  readonly models: readonly ProviderModelConfig[];
}

export class CodexContractError extends Error {
  constructor(message: string) {
    super(
      `[openai-codex contract] ${message} ` +
        "Run npm run upstream:check and review UPSTREAM.md before release.",
    );
    this.name = "CodexContractError";
  }
}

/** Reads a lossless, deeply isolated live Codex catalog. */
function extractCodexModels(registry: unknown): readonly ProviderModelConfig[] {
  let models: ProviderModelConfig[];
  try {
    models = cloneProviderModelCatalog(registry, CODEX_BASE_PROVIDER);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexContractError(detail);
  }
  if (models.length === 0) {
    throw new CodexContractError(
      "No built-in openai-codex models found in the live registry.",
    );
  }
  return models;
}

type CaptureProxyRegistrations = Array<{ name: string; config: ProviderConfig }>;

function createCaptureProxy(
  pi: ExtensionAPI,
  registrations: CaptureProxyRegistrations,
): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerProvider") {
        return (name: string, config: ProviderConfig): void => {
          registrations.push({ name, config });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Captures and validates a maintained Codex provider registration. */
export async function captureCodexProviderViaCaptureProxy(
  pi: ExtensionAPI,
  extension: (pi: ExtensionAPI) => void | Promise<void>,
): Promise<CapturedCodexProvider> {
  const registrations: CaptureProxyRegistrations = [];
  await extension(createCaptureProxy(pi, registrations));

  const matches = registrations.filter(({ name }) => name === CODEX_BASE_PROVIDER);
  if (matches.length !== 1) {
    throw new CodexContractError(
      `Expected exactly one registerProvider('openai-codex', ...) call but found ${matches.length}.`,
    );
  }
  const config = matches[0]?.config;
  if (!config?.oauth) {
    throw new CodexContractError("Captured openai-codex config has no OAuth callbacks.");
  }
  if (typeof config.oauth.login !== "function") {
    throw new CodexContractError("Captured openai-codex OAuth login is missing.");
  }
  if (typeof config.oauth.refreshToken !== "function") {
    throw new CodexContractError("Captured openai-codex OAuth refreshToken is missing.");
  }
  if (typeof config.oauth.getApiKey !== "function") {
    throw new CodexContractError("Captured openai-codex OAuth getApiKey is missing.");
  }
  if (typeof config.streamSimple !== "function") {
    throw new CodexContractError("Captured openai-codex config has no streamSimple.");
  }

  return {
    name: CODEX_BASE_PROVIDER,
    baseUrl: config.baseUrl ?? "https://chatgpt.com/backend-api",
    oauth: config.oauth,
    streamSimple: config.streamSimple,
    models: config.models ?? [],
  };
}

type CodexUpstreamStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

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

function sanitizeProviderResponse(response: ProviderResponse): ProviderResponse {
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

function withAliasEvent(
  event: AssistantMessageEvent,
  aliasModel: Model<Api>,
): AssistantMessageEvent {
  switch (event.type) {
    case "done":
      return { ...event, message: withAliasAttribution(event.message, aliasModel) };
    case "error":
      return {
        ...event,
        error: withAliasAttribution(
          sanitizeUpstreamError(event.error),
          aliasModel,
        ),
      };
    default:
      return { ...event, partial: withAliasAttribution(event.partial, aliasModel) };
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
 * Converts only assistant history emitted by this alias back to maintained base
 * identity before request conversion. Reasoning signatures and tool-call IDs
 * remain byte-for-byte unchanged, so same-model continuation stays native.
 */
function normalizeAliasContext(
  context: Context,
  aliasModel: Model<Api>,
): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (
        message.role !== "assistant" ||
        message.provider !== aliasModel.provider ||
        message.api !== aliasModel.api
      ) {
        return message;
      }
      return {
        ...message,
        provider: CODEX_BASE_PROVIDER,
        api: CODEX_BASE_API,
      };
    }),
  };
}

/**
 * Wraps the exact maintained stream without replacing transport or OAuth. Pi's
 * alias-resolved apiKey and every other option field are forwarded unchanged;
 * only model/context identity and callback attribution are adapted.
 */
export function createCodexAliasStream(
  maintainedStream: NonNullable<ProviderConfig["streamSimple"]>,
): NonNullable<ProviderConfig["streamSimple"]> {
  const upstream = maintainedStream as unknown as CodexUpstreamStream;
  const aliasStream: CodexUpstreamStream = (aliasModel, context, options) => {
    const upstreamModel: Model<Api> = {
      ...aliasModel,
      provider: CODEX_BASE_PROVIDER,
      api: CODEX_BASE_API,
    };
    const upstreamContext = normalizeAliasContext(context, aliasModel);

    let upstreamOptions = options;
    if (options?.onPayload || options?.onResponse) {
      const aliasOnPayload = options.onPayload;
      const aliasOnResponse = options.onResponse;
      upstreamOptions = {
        ...options,
        ...(aliasOnPayload
          ? {
              onPayload: (payload: unknown) =>
                aliasOnPayload(payload, aliasModel),
            }
          : {}),
        ...(aliasOnResponse
          ? {
              onResponse: (response: Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>[0]) =>
                aliasOnResponse(sanitizeProviderResponse(response), aliasModel),
            }
          : {}),
      };
    }

    return reattributeStream(
      upstream(upstreamModel, upstreamContext, upstreamOptions),
      aliasModel,
    );
  };
  return aliasStream as unknown as NonNullable<ProviderConfig["streamSimple"]>;
}

function createAliasModels(
  sourceModels: readonly ProviderModelConfig[],
  aliasDisplayLabel: string,
): ProviderModelConfig[] {
  try {
    return sourceModels.map((source) => {
      const model = structuredClone(source);
      model.api = CODEX_ALIAS_API;
      model.name = `${source.name} (${aliasDisplayLabel})`;
      return model;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexContractError(
      `Codex live catalog could not be losslessly cloned: ${detail}`,
    );
  }
}

function buildAliasConfig(
  captured: Pick<CapturedCodexProvider, "oauth" | "streamSimple" | "baseUrl">,
  sourceModels: readonly ProviderModelConfig[],
  aliasDisplayLabel: string,
): ProviderConfig {
  if (sourceModels.length === 0) {
    throw new CodexContractError("Cannot register a Codex alias with an empty model catalog.");
  }
  return {
    api: CODEX_ALIAS_API,
    baseUrl: captured.baseUrl,
    oauth: captured.oauth,
    streamSimple: createCodexAliasStream(captured.streamSimple),
    models: createAliasModels(sourceModels, aliasDisplayLabel),
  };
}

/** Builds a Codex alias from captured maintained behavior. */
export function createCodexAliasProviderConfig(
  captured: CapturedCodexProvider,
  aliasDisplayLabel: string,
  registryModels?: readonly ProviderModelConfig[],
): ProviderConfig {
  return buildAliasConfig(
    captured,
    registryModels ?? captured.models,
    aliasDisplayLabel,
  );
}

/** Builds a Codex alias from maintained base behavior and a live catalog. */
export function buildCodexAliasFromBaseConfig(
  baseCaptured: Pick<CapturedCodexProvider, "oauth" | "streamSimple" | "baseUrl">,
  liveRegistryModels: readonly ProviderModelConfig[],
  aliasDisplayLabel: string,
): ProviderConfig {
  return buildAliasConfig(baseCaptured, liveRegistryModels, aliasDisplayLabel);
}

export function getCodexModelsFromRegistry(
  registry: unknown,
): readonly ProviderModelConfig[] {
  return extractCodexModels(registry);
}
