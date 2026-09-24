import type {
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
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";

const AUTH_ENTRYPOINT = "../packages/pi-antigravity/src/auth/index.js";
const CLIENT_ENTRYPOINT = "../packages/pi-antigravity/src/client/index.js";
const MODELS_ENTRYPOINT = "../packages/pi-antigravity/src/models/index.js";
const STREAM_ENTRYPOINT = "../packages/pi-antigravity/src/stream/index.js";
const USAGE_ENTRYPOINT = "../packages/pi-antigravity/src/usage/index.js";

const UPSTREAM_API_ID = "antigravity-api" as const;
const UPSTREAM_PROVIDER_ID = "antigravity";

export const GOOGLE_ANTIGRAVITY_API = "hypha-google-antigravity" as const;
export const ANTIGRAVITY_ALIAS_API_SOURCE_ID =
  "hyphagroup-pi-multi-account:google-antigravity";

export type AntigravityUpstreamStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type AntigravityAliasApiRegistrar = (
  aliasStream: AntigravityUpstreamStream,
) => void;

export type AntigravityBoundaryEnvironment = Readonly<{
  ANTIGRAVITY_DEBUG_DUMP?: string;
  NOAGY_DEBUG_DUMP?: string;
}>;

type AntigravityOauth = NonNullable<ProviderConfig["oauth"]>;
type AntigravityCatalog = Readonly<{
  models: ProviderModelConfig[];
  routing: Readonly<Record<string, unknown>>;
}>;

export type UpstreamAntigravityPrimitives = Readonly<{
  login: AntigravityOauth["login"];
  refreshToken: AntigravityOauth["refreshToken"];
  getApiKey: AntigravityOauth["getApiKey"];
  defaultEndpoint: string;
  getCurrentCatalog: () => AntigravityCatalog;
  refreshModels: NonNullable<ProviderConfig["refreshModels"]>;
  upstreamApi: typeof UPSTREAM_API_ID;
  stream: AntigravityUpstreamStream;
  fetchUsage: (
    apiKey?: string,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}>;

export class UpstreamAntigravityContractError extends Error {
  constructor(message: string) {
    super(
      `[pi-antigravity contract] ${message} Run npm run upstream:check before publication.`,
    );
    this.name = "UpstreamAntigravityContractError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function namedFunction(
  module: Record<string, unknown>,
  name: string,
): (...args: never[]) => unknown {
  const value = module[name];
  if (typeof value !== "function") {
    throw new UpstreamAntigravityContractError(
      `reviewed barrel did not export function ${name}`,
    );
  }
  return value as (...args: never[]) => unknown;
}

function namedString(
  module: Record<string, unknown>,
  name: string,
): string {
  const value = module[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UpstreamAntigravityContractError(
      `reviewed barrel did not export string ${name}`,
    );
  }
  return value;
}

let primitivesPromise: Promise<UpstreamAntigravityPrimitives> | undefined;

/**
 * Loads only the five reviewed public barrels by exact specifier, validates the
 * named values, and copies those values into the extension-owned boundary.
 * Variable specifiers prevent this repository's stricter compiler options from
 * compiling third-party TypeScript implementation files as local source.
 */
export function loadUpstreamAntigravityPrimitives(): Promise<UpstreamAntigravityPrimitives> {
  primitivesPromise ??= Promise.all([
    import(AUTH_ENTRYPOINT) as Promise<unknown>,
    import(CLIENT_ENTRYPOINT) as Promise<unknown>,
    import(MODELS_ENTRYPOINT) as Promise<unknown>,
    import(STREAM_ENTRYPOINT) as Promise<unknown>,
    import(USAGE_ENTRYPOINT) as Promise<unknown>,
  ]).then(([auth, client, models, stream, usage]) => {
    if (
      !isRecord(auth) ||
      !isRecord(client) ||
      !isRecord(models) ||
      !isRecord(stream) ||
      !isRecord(usage)
    ) {
      throw new UpstreamAntigravityContractError(
        "a reviewed barrel did not expose a module namespace",
      );
    }

    const upstreamApi = namedString(stream, "ANTIGRAVITY_API");
    const upstreamProvider = namedString(models, "PROVIDER_ID");
    if (upstreamApi !== UPSTREAM_API_ID || upstreamProvider !== UPSTREAM_PROVIDER_ID) {
      throw new UpstreamAntigravityContractError(
        "reviewed upstream provider or API identity changed",
      );
    }

    return Object.freeze({
      login: namedFunction(auth, "loginAntigravity") as AntigravityOauth["login"],
      refreshToken: namedFunction(
        auth,
        "refreshAntigravityToken",
      ) as AntigravityOauth["refreshToken"],
      getApiKey: namedFunction(auth, "getApiKey") as AntigravityOauth["getApiKey"],
      defaultEndpoint: namedString(client, "DEFAULT_ENDPOINT"),
      getCurrentCatalog: namedFunction(
        models,
        "getCurrentAntigravityCatalog",
      ) as UpstreamAntigravityPrimitives["getCurrentCatalog"],
      refreshModels: namedFunction(
        models,
        "refreshAntigravityModels",
      ) as UpstreamAntigravityPrimitives["refreshModels"],
      upstreamApi,
      stream: namedFunction(
        stream,
        "streamAntigravity",
      ) as AntigravityUpstreamStream,
      fetchUsage: namedFunction(
        usage,
        "fetchAccountUsage",
      ) as UpstreamAntigravityPrimitives["fetchUsage"],
    });
  });
  return primitivesPromise;
}

/**
 * Upstream writes raw request and response material when either supported
 * DEBUG_DUMP variable is exactly "1". A hostile or careless caller must not
 * be able to publish this extension's alias API or provider config while that
 * mode can write `/tmp/antigravity-last-request.json`.
 */
export function assertAntigravityDebugDumpDisabled(
  env: AntigravityBoundaryEnvironment = process.env,
): void {
  const debugDump = env.ANTIGRAVITY_DEBUG_DUMP;
  const legacyDebugDump = env.NOAGY_DEBUG_DUMP;
  if (debugDump === "1" || legacyDebugDump === "1") {
    throw new UpstreamAntigravityContractError(
      "unsafe upstream debug-dump mode is enabled",
    );
  }
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
        error: withAliasAttribution(event.error, aliasModel),
      };
    default:
      return {
        ...event,
        partial: withAliasAttribution(event.partial, aliasModel),
      };
  }
}

function reattributeAntigravityStream(
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
 * Rebinds only the request's provider/API identity to the reviewed upstream
 * transport, then restores the caller's exact alias identity on every event.
 * It makes one upstream call and never retries or replays a failed request.
 */
export function createAntigravityAliasStream(
  upstreamStream: AntigravityUpstreamStream,
): AntigravityUpstreamStream {
  return (aliasModel, context, options) => {
    const upstreamModel: Model<Api> = {
      ...aliasModel,
      api: UPSTREAM_API_ID,
      provider: UPSTREAM_PROVIDER_ID,
    };
    return reattributeAntigravityStream(
      upstreamStream(upstreamModel, context, options),
      aliasModel,
    );
  };
}

const registerAliasApiWithCompat: AntigravityAliasApiRegistrar = (
  aliasStream,
) => {
  registerApiProvider(
    {
      api: GOOGLE_ANTIGRAVITY_API,
      stream: aliasStream,
      streamSimple: aliasStream,
    },
    ANTIGRAVITY_ALIAS_API_SOURCE_ID,
  );
};

/**
 * Registers both compat slots for the current extension-factory generation.
 * The debug guard runs before imports or the process-global registry can change.
 */
export async function registerAntigravityAliasApi(
  upstreamStream?: AntigravityUpstreamStream,
  registrar: AntigravityAliasApiRegistrar = registerAliasApiWithCompat,
  env: AntigravityBoundaryEnvironment = process.env,
): Promise<AntigravityUpstreamStream> {
  assertAntigravityDebugDumpDisabled(env);
  const stream = upstreamStream ?? (await loadUpstreamAntigravityPrimitives()).stream;
  const aliasStream = createAntigravityAliasStream(stream);
  registrar(aliasStream);
  return aliasStream;
}

function withManagedApi(
  models: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
  return models.map((model) => ({
    ...model,
    api: GOOGLE_ANTIGRAVITY_API,
  }));
}

/**
 * Creates the extension-owned provider shape without invoking the upstream
 * extension factory. Publication remains with the caller so later registration
 * work can create canonical and numbered aliases from this one boundary.
 */
export async function createAntigravityProviderConfig(
  models?: readonly ProviderModelConfig[],
  upstreamStream?: AntigravityUpstreamStream,
  env: AntigravityBoundaryEnvironment = process.env,
): Promise<ProviderConfig> {
  assertAntigravityDebugDumpDisabled(env);
  const primitives = await loadUpstreamAntigravityPrimitives();
  const aliasStream = createAntigravityAliasStream(
    upstreamStream ?? primitives.stream,
  );
  const selectedModels = models ?? primitives.getCurrentCatalog().models;
  return {
    name: "Google Antigravity",
    baseUrl: primitives.defaultEndpoint,
    api: GOOGLE_ANTIGRAVITY_API,
    models: withManagedApi(selectedModels),
    refreshModels: async (context) =>
      withManagedApi(await primitives.refreshModels(context)),
    oauth: {
      name: "Google Antigravity",
      isSubscription: true,
      login: primitives.login,
      refreshToken: primitives.refreshToken,
      getApiKey: primitives.getApiKey,
    },
    streamSimple: aliasStream,
  };
}
