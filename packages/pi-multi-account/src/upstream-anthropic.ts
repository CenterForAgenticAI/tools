import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  ANTHROPIC_ALIAS_API,
  createAnthropicAliasStream,
  type AnthropicUpstreamStream,
} from "./anthropic-alias-stream.js";
import { streamAnthropicAdaptive } from "./anthropic-adaptive-stream.js";
import { toPinnedAnthropicContext } from "./anthropic-context-compat.js";

export type UpstreamAnthropicExtension = (pi: ExtensionAPI) => void;

/**
 * Identifies this package's entries in pi-ai's process-global API registry, so
 * ownership is explicit and removal is precise. The registry is keyed by API id
 * with no ownership check, so the tag is the only ownership record there is.
 */
export const ALIAS_API_SOURCE_ID = "hyphagroup-pi-multi-account";

/**
 * The registration seam, injected only so a test can prove the fail-closed
 * contract. Production always uses pi-ai compat's real registrar.
 */
export type AliasApiRegistrar = (
  aliasStream: AnthropicUpstreamStream,
) => void;

const UPSTREAM_ENTRYPOINT = "../packages/pi-anthropic-oauth/src/index.ts";

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/** Loads the package entrypoint by variable specifier so TypeScript does not
 * compile third-party source under this repository's stricter compiler flags.
 * Pi's extension loader (jiti) resolves the exact installed TypeScript module.
 */
export async function loadUpstreamAnthropicExtension(): Promise<UpstreamAnthropicExtension> {
  const loaded: unknown = await import(UPSTREAM_ENTRYPOINT);
  if (!isRecord(loaded) || typeof loaded.default !== "function") {
    throw new UpstreamAnthropicContractError(
      "package entrypoint did not export a default extension function",
    );
  }
  return loaded.default as UpstreamAnthropicExtension;
}

type CompleteAnthropicProviderConfig = ProviderConfig & {
  oauth: NonNullable<ProviderConfig["oauth"]>;
  streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
};

export interface CapturedAnthropicProvider {
  readonly name: "anthropic";
  readonly config: CompleteAnthropicProviderConfig;
}

export class UpstreamAnthropicContractError extends Error {
  constructor(message: string) {
    super(
      `[pi-anthropic-oauth contract] ${message} Run npm run upstream:check and review UPSTREAM.md before release.`,
    );
    this.name = "UpstreamAnthropicContractError";
  }
}

function assertCompleteConfig(
  config: ProviderConfig,
): asserts config is CompleteAnthropicProviderConfig {
  if (config.api !== "anthropic-messages") {
    throw new UpstreamAnthropicContractError(
      `expected provider api anthropic-messages, received ${String(config.api)}`,
    );
  }
  // pi-anthropic-oauth 0.2.0 registers the base provider WITHOUT a `models`
  // field — Pi host-resolves the anthropic catalog from its built-in provider
  // layer. A captured `models` array is therefore optional; alias catalogs are
  // sourced from the live model registry (see index.ts), not the captured
  // config. If a `models` field is present it must still be a non-empty array.
  if (config.models !== undefined) {
    if (!Array.isArray(config.models) || config.models.length === 0) {
      throw new UpstreamAnthropicContractError(
        "captured provider supplied a models field that is not a non-empty array",
      );
    }
  }
  if (!config.oauth) {
    throw new UpstreamAnthropicContractError(
      "captured provider did not supply OAuth callbacks",
    );
  }
  if (typeof config.oauth.login !== "function") {
    throw new UpstreamAnthropicContractError("captured OAuth login is missing");
  }
  if (typeof config.oauth.refreshToken !== "function") {
    throw new UpstreamAnthropicContractError(
      "captured OAuth refreshToken is missing",
    );
  }
  if (typeof config.oauth.getApiKey !== "function") {
    throw new UpstreamAnthropicContractError(
      "captured OAuth getApiKey is missing",
    );
  }
  if (typeof config.streamSimple !== "function") {
    throw new UpstreamAnthropicContractError(
      "captured provider did not supply streamSimple",
    );
  }
}

function createCaptureProxy(
  pi: ExtensionAPI,
  registrations: Array<{ name: string; config: ProviderConfig }>,
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

/**
 * Invokes the exact-pinned upstream entrypoint against a delegating proxy and
 * returns its one Anthropic registration. Provider configuration is held only
 * by reference; this path never serializes, inspects, or logs OAuth material.
 */
export function captureUpstreamAnthropicProvider(
  pi: ExtensionAPI,
  upstream: UpstreamAnthropicExtension,
): CapturedAnthropicProvider {
  const registrations: Array<{ name: string; config: ProviderConfig }> = [];
  upstream(createCaptureProxy(pi, registrations));

  if (registrations.length !== 1) {
    throw new UpstreamAnthropicContractError(
      `expected exactly one registerProvider call, received ${registrations.length}`,
    );
  }

  const registration = registrations[0];
  if (!registration || registration.name !== "anthropic") {
    throw new UpstreamAnthropicContractError(
      `expected registerProvider(\"anthropic\", config), received ${registration?.name ?? "no registration"}`,
    );
  }

  assertCompleteConfig(registration.config);
  return { name: "anthropic", config: registration.config };
}

/**
 * Chooses the extension-owned exact-provenance adapter only for adaptive
 * thinking requests. Every other request stays on the exact-pinned OAuth
 * stream. Both receive the Pi 0.84 context shape they consume, reconstructed
 * from Pi 0.87 transcript declarations when needed. Errors are not retried
 * through the other implementation.
 */
export function createAnthropicStreamSelector(
  adaptiveStream: AnthropicUpstreamStream,
  pinnedStream: AnthropicUpstreamStream,
): AnthropicUpstreamStream {
  return (model, context, options) => {
    const useAdaptiveStream =
      (model.compat as { forceAdaptiveThinking?: boolean } | undefined)
        ?.forceAdaptiveThinking === true && options?.reasoning !== undefined;
    const selected = useAdaptiveStream ? adaptiveStream : pinnedStream;
    return selected(model, toPinnedAnthropicContext(context), options);
  };
}

/**
 * Publishes the extension-owned alias API id into pi-ai's process-global API
 * registry.
 *
 * Pi's own provider path never needs this: `provider-composer` short-circuits to
 * the extension's `streamSimple` when `model.api` matches the extension's `api`.
 * But any caller that dispatches by `model.api` through pi-ai compat resolves
 * through this registry instead, and threw `No API provider registered for api:
 * hypha-anthropic-oauth` without it (issue #11).
 *
 * Both registry slots share the one alias handler that wraps the derived
 * selector, so the registry entry and every alias provider config dispatch
 * identically by construction. The registry stores function references and the
 * source id only; Pi resolves the alias credential per request and compat
 * forwards it in `options.apiKey`.
 */
const registerAliasApiWithCompat: AliasApiRegistrar = (aliasStream) => {
  // Deliberately uncast. `SimpleStreamOptions` extends `StreamOptions` with
  // optional fields, so the one alias handler satisfies both slots today. If a
  // pi-ai upgrade changes either handler signature, this must fail typecheck
  // rather than be silently bridged by a cast.
  registerApiProvider(
    {
      api: ANTHROPIC_ALIAS_API,
      stream: aliasStream,
      streamSimple: aliasStream,
    },
    ALIAS_API_SOURCE_ID,
  );
};

/**
 * Captures the exact-pinned registration, then derives a distinct base config
 * that replaces only its stream handler with the stateless adaptive selector.
 * OAuth callbacks and every other captured field remain reference-identical.
 *
 * Also registers the alias API id, because this is the one place that holds the
 * derived selector every alias wraps, and it runs once per extension factory
 * generation — which is exactly the registration's lifetime. Pi's `reload()`
 * calls `resetApiProviders()` before rerunning factories, so the following
 * generation restores the entry structurally.
 *
 * The registration is deliberately NOT wrapped in try/catch. A registrar failure
 * must reject out of the extension factory so Pi omits the extension entirely,
 * rather than publishing alias providers whose API id cannot resolve — which is
 * the very defect this function fixes.
 */
export async function registerUpstreamAnthropicProvider(
  pi: ExtensionAPI,
  upstream?: UpstreamAnthropicExtension,
  adaptiveStream: AnthropicUpstreamStream = streamAnthropicAdaptive,
  registerAliasApi: AliasApiRegistrar = registerAliasApiWithCompat,
): Promise<CapturedAnthropicProvider> {
  const extension = upstream ?? (await loadUpstreamAnthropicExtension());
  const captured = captureUpstreamAnthropicProvider(pi, extension);
  const streamSimple = createAnthropicStreamSelector(
    adaptiveStream,
    captured.config.streamSimple,
  );
  const adapted: CompleteAnthropicProviderConfig = {
    ...captured.config,
    streamSimple: streamSimple as CompleteAnthropicProviderConfig["streamSimple"],
  };
  const derived: CapturedAnthropicProvider = {
    name: captured.name,
    config: adapted,
  };
  registerAliasApi(createAnthropicAliasStream(streamSimple));
  pi.registerProvider(derived.name, derived.config);
  return derived;
}

/**
 * Re-asserts the derived base registration once every extension factory has run.
 *
 * A coexisting standalone `pi-anthropic-oauth` extension registers `anthropic`
 * from its own factory. Pi merges a later registration's defined fields over an
 * earlier one, so an extension-first load order would otherwise restore the
 * pinned legacy handler on the base provider and adaptive base requests would
 * fall back to budget thinking. Registering the same derived configuration
 * object again leaves an equivalent effective configuration and handler.
 *
 * This is the one bounded base-provider exception recorded in AGENTS.md. It adds
 * no shared state, lock, timer, or credential path, and it must not be repeated
 * on a schedule. A later `session_start` handler, a post-load dynamic
 * registration, or `unregisterProvider` remains out of scope.
 */
export function reassertAnthropicBaseRegistration(
  pi: ExtensionAPI,
  captured: CapturedAnthropicProvider,
): void {
  pi.registerProvider(captured.name, captured.config);
}

/**
 * Builds an alias registration from captured upstream behavior. OAuth callback
 * identities are preserved; only the API dispatch identity is rebound to the
 * extension-owned adapter. The `models` catalog is REQUIRED and supplied by the
 * caller from the live model registry — pi-anthropic-oauth 0.2.0 no longer
 * carries a `models` field on the captured base config, and alias provider ids
 * have no built-in base provider for Pi to inherit a catalog from.
 */
export function createAnthropicAliasProviderConfig(
  captured: CapturedAnthropicProvider,
  models: readonly ProviderModelConfig[],
): ProviderConfig {
  if (models.length === 0) {
    throw new UpstreamAnthropicContractError(
      "cannot register an Anthropic alias with an empty model catalog",
    );
  }
  if (captured.config.api === ANTHROPIC_ALIAS_API) {
    throw new UpstreamAnthropicContractError(
      "extension-owned alias API must remain distinct from the base handler",
    );
  }

  const upstreamStream = captured.config.streamSimple as unknown as AnthropicUpstreamStream;

  const aliasStream = createAnthropicAliasStream(upstreamStream) as unknown as NonNullable<
    ProviderConfig["streamSimple"]
  >;

  return {
    ...captured.config,
    api: ANTHROPIC_ALIAS_API,
    models: models.map((model) => ({
      ...model,
      api: ANTHROPIC_ALIAS_API,
    })),
    oauth: captured.config.oauth,
    streamSimple: aliasStream,
  };
}
