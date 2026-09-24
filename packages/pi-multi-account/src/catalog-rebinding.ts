import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface LiveCatalogCost extends Record<string, unknown> {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<
    Record<string, unknown> & {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      inputTokensAbove: number;
    }
  >;
}

export interface LiveCatalogModel extends Record<string, unknown> {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: LiveCatalogCost;
  contextWindow: number;
  maxTokens: number;
}

export interface LiveModelRegistrySurface {
  getAll(): readonly unknown[];
}

export interface AliasCatalogRequest {
  registry: unknown;
  baseProvider: string;
  aliasProvider: string;
  displayLabel: string;
}

export class CatalogRebindingCompatibilityError extends Error {
  readonly feature = "pi.model-registry-live-catalog" as const;
  readonly remediation =
    "Use the current public ExtensionContext.modelRegistry.getAll surface; do not import a private registry or hard-code model IDs.";

  constructor(message: string) {
    super(
      `[pi.model-registry-live-catalog] ${message} Action: ${
        "Use the current public ExtensionContext.modelRegistry.getAll surface; do not import a private registry or hard-code model IDs."
      }`,
    );
    this.name = "CatalogRebindingCompatibilityError";
  }
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

function isLiveCatalogModel(value: unknown): value is LiveCatalogModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.provider === "string" &&
    typeof value.api === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.reasoning === "boolean" &&
    Array.isArray(value.input) &&
    isRecord(value.cost) &&
    typeof value.contextWindow === "number" &&
    typeof value.maxTokens === "number"
  );
}

function readLiveCatalog(registry: unknown): readonly unknown[] {
  if (!isRecord(registry) || typeof registry.getAll !== "function") {
    throw new CatalogRebindingCompatibilityError(
      "ExtensionContext.modelRegistry.getAll is unavailable, so the live base catalog cannot be derived.",
    );
  }

  let catalog: unknown;
  try {
    catalog = Reflect.apply(registry.getAll, registry, []);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogRebindingCompatibilityError(
      `ExtensionContext.modelRegistry.getAll threw: ${detail}`,
    );
  }

  if (!Array.isArray(catalog)) {
    throw new CatalogRebindingCompatibilityError(
      `ExtensionContext.modelRegistry.getAll returned ${typeof catalog}; expected an array.`,
    );
  }
  return catalog;
}

function cloneModel(model: LiveCatalogModel): LiveCatalogModel {
  try {
    return structuredClone(model) as LiveCatalogModel;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CatalogRebindingCompatibilityError(
      `Live model ${model.provider}/${model.id} could not be losslessly cloned: ${detail}`,
    );
  }
}

/**
 * Reads and deep-clones every model for one live provider. Future public model
 * fields are preserved and no mutable descendant is shared with the registry.
 */
function cloneLiveProviderCatalog(
  registry: unknown,
  baseProvider: string,
): LiveCatalogModel[] {
  const models: LiveCatalogModel[] = [];
  for (const candidate of readLiveCatalog(registry)) {
    if (!isRecord(candidate) || candidate.provider !== baseProvider) continue;
    if (!isLiveCatalogModel(candidate)) {
      const modelId = typeof candidate.id === "string" ? candidate.id : "<unknown>";
      throw new CatalogRebindingCompatibilityError(
        `Live ${baseProvider} model ${modelId} is missing a required public model field.`,
      );
    }
    models.push(cloneModel(candidate));
  }
  return models;
}

/**
 * Converts a lossless live snapshot into provider-registration models. Only the
 * registry-owned provider identity is removed; all current/future model fields
 * and nested metadata remain deeply cloned.
 */
export function cloneProviderModelCatalog(
  registry: unknown,
  baseProvider: string,
): ProviderModelConfig[] {
  return cloneLiveProviderCatalog(registry, baseProvider).map((model) => {
    const providerModel = cloneModel(model);
    Reflect.deleteProperty(providerModel, "provider");
    return providerModel as ProviderModelConfig;
  });
}

/**
 * Derives aliases from the registry snapshot available at call time. The deep
 * clone deliberately occurs before the two intentional identity/display
 * replacements, preserving current and future data fields without shared
 * mutable descendants.
 */
export function deriveLiveAliasCatalog(
  request: AliasCatalogRequest,
): LiveCatalogModel[] {
  const { baseProvider, aliasProvider, displayLabel } = request;
  if (!baseProvider.trim() || !aliasProvider.trim()) {
    throw new CatalogRebindingCompatibilityError(
      "Base and alias provider IDs must both be non-empty.",
    );
  }
  if (baseProvider === aliasProvider) {
    throw new CatalogRebindingCompatibilityError(
      `Alias provider ${aliasProvider} must be distinct from its base provider.`,
    );
  }

  return cloneLiveProviderCatalog(request.registry, baseProvider).map((alias) => {
    alias.provider = aliasProvider;
    alias.name = `${alias.name} (${displayLabel})`;
    return alias;
  });
}
