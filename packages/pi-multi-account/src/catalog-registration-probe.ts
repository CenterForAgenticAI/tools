import type {
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  deriveLiveAliasCatalog,
  type LiveCatalogModel,
  type LiveModelRegistrySurface,
} from "./catalog-rebinding.js";

export interface AliasProviderProbe {
  baseProvider: string;
  aliasProvider: string;
  displayLabel: string;
  isolatedApi: string;
  streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
}

export interface ProviderRegistrationSurface {
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
}

export interface CatalogRegistrationProbeInput {
  extensionApi: ProviderRegistrationSurface;
  extensionContext: { modelRegistry: LiveModelRegistrySurface };
  aliases: readonly AliasProviderProbe[];
}

export interface AliasRegistrationRecord {
  baseProvider: string;
  aliasProvider: string;
  isolatedApi: string;
  sourceApis: readonly string[];
  models: readonly LiveCatalogModel[];
}

function asProviderModel(
  model: LiveCatalogModel,
  isolatedApi: string,
): ProviderModelConfig {
  const registeredModel = structuredClone(model);
  Reflect.deleteProperty(registeredModel, "provider");
  registeredModel.api = isolatedApi;
  return registeredModel as ProviderModelConfig;
}

/**
 * Investigation-only composition probe. It reads the live public registry on
 * every invocation, then calls the public provider-registration surface. An
 * isolated API ID is used only at registration time so OAuth-specific stream
 * behavior cannot replace a base provider's shared API handler.
 */
export function registerLiveAliasCatalogs(
  input: CatalogRegistrationProbeInput,
): AliasRegistrationRecord[] {
  const seenProviders = new Set<string>();
  const seenApis = new Set<string>();
  const records: AliasRegistrationRecord[] = [];

  for (const aliasRequest of input.aliases) {
    if (seenProviders.has(aliasRequest.aliasProvider)) {
      throw new Error(`Duplicate alias provider: ${aliasRequest.aliasProvider}`);
    }
    if (seenApis.has(aliasRequest.isolatedApi)) {
      throw new Error(`Duplicate isolated API handler slot: ${aliasRequest.isolatedApi}`);
    }

    const aliases = deriveLiveAliasCatalog({
      registry: input.extensionContext.modelRegistry,
      baseProvider: aliasRequest.baseProvider,
      aliasProvider: aliasRequest.aliasProvider,
      displayLabel: aliasRequest.displayLabel,
    });
    const sourceApis = [...new Set(aliases.map(({ api }) => api))];
    if (sourceApis.includes(aliasRequest.isolatedApi)) {
      throw new Error(
        `Alias provider ${aliasRequest.aliasProvider} must use an isolated API handler slot, not source API ${aliasRequest.isolatedApi}.`,
      );
    }

    seenProviders.add(aliasRequest.aliasProvider);
    seenApis.add(aliasRequest.isolatedApi);

    // Public unregister is required even for an empty new snapshot: Pi treats
    // registerProvider({ models: [] }) as no replacement, which would otherwise
    // leave the previous alias catalog stale.
    input.extensionApi.unregisterProvider(aliasRequest.aliasProvider);
    const firstAlias = aliases[0];
    if (firstAlias) {
      input.extensionApi.registerProvider(aliasRequest.aliasProvider, {
        api: aliasRequest.isolatedApi,
        baseUrl: firstAlias.baseUrl,
        streamSimple: aliasRequest.streamSimple,
        models: aliases.map((model) =>
          asProviderModel(model, aliasRequest.isolatedApi),
        ),
      });
    }

    records.push({
      baseProvider: aliasRequest.baseProvider,
      aliasProvider: aliasRequest.aliasProvider,
      isolatedApi: aliasRequest.isolatedApi,
      sourceApis,
      models: aliases,
    });
  }

  return records;
}
