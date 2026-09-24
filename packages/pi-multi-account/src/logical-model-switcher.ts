import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";

export type LogicalModelCandidate = Readonly<{
  id: string;
  name: string;
  model: Model<Api>;
}>;

export type LogicalModelInventory =
  | {
      status: "ready";
      source: "session-scope" | "available-catalog";
      candidates: readonly LogicalModelCandidate[];
    }
  | { status: "absent" }
  | {
      status: "unusable";
      reason:
        | "provider-not-registered"
        | "provider-api-mismatch"
        | "model-api-mismatch"
        | "duplicate-model-id";
    }
  | { status: "out-of-scope" }
  | { status: "unavailable" };

export type LogicalModelReference =
  | { status: "resolved"; candidate: LogicalModelCandidate }
  | {
      status: "invalid-input";
      reason: "empty" | "control-character" | "too-long";
    }
  | { status: "foreign-provider" }
  | { status: "ambiguous" }
  | { status: "unknown-model" }
  | { status: "out-of-scope"; modelId: string }
  | { status: "unavailable"; modelId: string };

export interface LogicalModelSelector {
  select(input: {
    candidates: readonly LogicalModelCandidate[];
    currentModel: Model<Api> | undefined;
    ui: ExtensionUIContext;
    signal?: AbortSignal;
  }): Promise<LogicalModelCandidate | undefined>;
}

export type LogicalModelRejectionReason =
  | Exclude<LogicalModelInventory["status"], "ready">
  | Exclude<LogicalModelReference["status"], "resolved">
  | "tui-required"
  | "host-refused";

export type LogicalModelSwitchResult =
  | { status: "selected"; modelId: string }
  | { status: "cancelled" }
  | {
      status: "rejected";
      reason: LogicalModelRejectionReason;
      modelId?: string;
    };

export interface LogicalModelRegistry {
  getAll(): readonly Model<Api>[];
  getAvailable(): readonly Model<Api>[];
  getRegisteredProviderConfig(providerId: string): { api?: string } | undefined;
}

export interface LogicalModelScopeEntry {
  readonly model: Model<Api>;
}

interface InventoryMetadata {
  readonly allCandidates: readonly LogicalModelCandidate[];
  readonly availableCandidates: readonly LogicalModelCandidate[];
  readonly providerIds: ReadonlySet<string>;
  readonly scopeIds: ReadonlySet<string> | undefined;
}

const inventoryMetadata = new WeakMap<object, InventoryMetadata>();
const LOGICAL_PREFIX = `${LOGICAL_PROVIDER_ID}/`;
const MAX_REFERENCE_LENGTH = 1024;

function candidateForModel(model: Model<Api>): LogicalModelCandidate {
  return { id: model.id, name: model.name, model };
}

type LogicalModelInventoryReason = Extract<
  LogicalModelInventory,
  { status: "unusable" }
>["reason"];

function unusable(reason: LogicalModelInventoryReason): LogicalModelInventory {
  return { status: "unusable", reason };
}

/**
 * Builds one ordered, credential-free logical model snapshot. The registry is
 * read afresh for each invocation; scope only removes rows from the available
 * catalog and never adds one.
 */
export function buildLogicalModelInventory(
  modelRegistry: LogicalModelRegistry,
  scopedModels: readonly LogicalModelScopeEntry[] = [],
): LogicalModelInventory {
  let allModels: readonly Model<Api>[];
  try {
    allModels = modelRegistry.getAll();
  } catch {
    return unusable("provider-not-registered");
  }

  const allLogicalModels = allModels.filter(
    (model) => model.provider === LOGICAL_PROVIDER_ID,
  );
  if (allLogicalModels.length === 0) return { status: "absent" };

  let registered: { api?: string } | undefined;
  try {
    registered = modelRegistry.getRegisteredProviderConfig(LOGICAL_PROVIDER_ID);
  } catch {
    return unusable("provider-not-registered");
  }
  if (registered === undefined) return unusable("provider-not-registered");
  if (registered.api !== LOGICAL_PROVIDER_ID) {
    return unusable("provider-api-mismatch");
  }
  if (allLogicalModels.some((model) => model.api !== LOGICAL_PROVIDER_ID)) {
    return unusable("model-api-mismatch");
  }

  const ids = new Set<string>();
  for (const model of allLogicalModels) {
    if (ids.has(model.id)) return unusable("duplicate-model-id");
    ids.add(model.id);
  }

  let availableModels: readonly Model<Api>[];
  try {
    availableModels = modelRegistry.getAvailable();
  } catch {
    availableModels = [];
  }
  const availableLogicalModels = availableModels.filter(
    (model) =>
      model.provider === LOGICAL_PROVIDER_ID &&
      model.api === LOGICAL_PROVIDER_ID,
  );
  const allCandidates = allLogicalModels.map(candidateForModel);
  const availableCandidates = availableLogicalModels.map(candidateForModel);
  const providerIds = new Set(allModels.map((model) => model.provider));
  const scopeIds =
    scopedModels.length === 0
      ? undefined
      : new Set(
          scopedModels
            .filter(
              ({ model }) =>
                model.provider === LOGICAL_PROVIDER_ID &&
                model.api === LOGICAL_PROVIDER_ID,
            )
            .map(({ model }) => model.id),
        );
  const metadata = { allCandidates, availableCandidates, providerIds, scopeIds };

  if (scopeIds !== undefined) {
    const candidates = availableCandidates.filter((candidate) =>
      scopeIds.has(candidate.id),
    );
    if (candidates.length === 0) {
      const result: LogicalModelInventory = { status: "out-of-scope" };
      inventoryMetadata.set(result, metadata);
      return result;
    }
    const result: LogicalModelInventory = {
      status: "ready",
      source: "session-scope",
      candidates,
    };
    inventoryMetadata.set(result, metadata);
    return result;
  }

  if (availableCandidates.length === 0) {
    const result: LogicalModelInventory = { status: "unavailable" };
    inventoryMetadata.set(result, metadata);
    return result;
  }

  const result: LogicalModelInventory = {
    status: "ready",
    source: "available-catalog",
    candidates: availableCandidates,
  };
  inventoryMetadata.set(result, metadata);
  return result;
}

function invalidReference(input: string): LogicalModelReference | undefined {
  const value = input.trim();
  if (value.length === 0) return { status: "invalid-input", reason: "empty" };
  if (value.length > MAX_REFERENCE_LENGTH) {
    return { status: "invalid-input", reason: "too-long" };
  }
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  })) {
    return { status: "invalid-input", reason: "control-character" };
  }
  return undefined;
}

/** Resolve only a bare exact id or one exact logical-provider prefix. */
export function resolveLogicalModelReference(
  input: string,
  inventory: LogicalModelInventory,
): LogicalModelReference {
  const invalid = invalidReference(input);
  if (invalid) return invalid;

  const normalized = input.trim();
  const metadata = inventoryMetadata.get(inventory);
  const allCandidates =
    metadata?.allCandidates ??
    (inventory.status === "ready" ? inventory.candidates : []);
  const availableCandidates =
    metadata?.availableCandidates ??
    (inventory.status === "ready" ? inventory.candidates : []);
  const scopeIds = metadata?.scopeIds;
  const providerIds = metadata?.providerIds ?? new Set([
    LOGICAL_PROVIDER_ID,
    "anthropic",
    "openai-codex",
    "google-antigravity",
    "openrouter",
  ]);
  const find = (id: string): LogicalModelCandidate | undefined =>
    allCandidates.find((candidate) => candidate.id === id);
  const bare = find(normalized);
  const prefixed = normalized.startsWith(LOGICAL_PREFIX)
    ? find(normalized.slice(LOGICAL_PREFIX.length))
    : undefined;

  if (bare && prefixed && bare.id !== prefixed.id) {
    return { status: "ambiguous" };
  }
  const found = bare ?? prefixed;
  if (found) {
    const available = availableCandidates.find(
      (candidate) => candidate.id === found.id,
    );
    const inScope =
      scopeIds === undefined || scopeIds.has(found.id);
    if (!inScope) return { status: "out-of-scope", modelId: found.id };
    if (!available) return { status: "unavailable", modelId: found.id };
    return { status: "resolved", candidate: available };
  }

  const firstSegment = normalized.split("/", 1)[0];
  if (
    normalized.includes("/") &&
    firstSegment !== undefined &&
    providerIds.has(firstSegment) &&
    firstSegment !== LOGICAL_PROVIDER_ID
  ) {
    return { status: "foreign-provider" };
  }
  return { status: "unknown-model" };
}

function rejected(
  reason: LogicalModelRejectionReason,
  modelId?: string,
): LogicalModelSwitchResult {
  return modelId === undefined
    ? { status: "rejected", reason }
    : { status: "rejected", reason, modelId };
}

function inventoryRejection(
  inventory: LogicalModelInventory,
): LogicalModelSwitchResult | undefined {
  if (inventory.status === "ready") return undefined;
  return inventory.status === "unusable"
    ? rejected("unusable")
    : rejected(inventory.status);
}

export interface LogicalModelSwitchDependencies {
  readonly mode: ExtensionContext["mode"];
  readonly ui: ExtensionUIContext;
  readonly modelRegistry: LogicalModelRegistry;
  readonly scopedModels: readonly LogicalModelScopeEntry[];
  readonly currentModel: Model<Api> | undefined;
  readonly selector: LogicalModelSelector;
  readonly setModel: (model: Model<Api>) => Promise<boolean>;
  readonly signal?: AbortSignal;
}

/** Execute the operator-only command, with direct mode kept free of terminal UI. */
export async function executeLogicalModelSwitch(
  argument: string,
  dependencies: LogicalModelSwitchDependencies,
): Promise<LogicalModelSwitchResult> {
  const normalized = argument.trim();
  if (normalized.length === 0 && dependencies.mode !== "tui") {
    return rejected("tui-required");
  }

  const inventory = buildLogicalModelInventory(
    dependencies.modelRegistry,
    dependencies.scopedModels,
  );
  const apply = async (
    candidate: LogicalModelCandidate,
  ): Promise<LogicalModelSwitchResult> => {
    try {
      if ((await dependencies.setModel(candidate.model)) !== true) {
        return rejected("host-refused", candidate.id);
      }
    } catch {
      return rejected("host-refused", candidate.id);
    }
    return { status: "selected", modelId: candidate.id };
  };
  if (inventory.status !== "ready") {
    if (
      normalized.length > 0 &&
      (inventory.status === "unavailable" || inventory.status === "out-of-scope")
    ) {
      const reference = resolveLogicalModelReference(normalized, inventory);
      if (reference.status === "resolved") {
        return apply(reference.candidate);
      }
      if (reference.status === "out-of-scope" || reference.status === "unavailable") {
        return rejected(reference.status, reference.modelId);
      }
      if (reference.status === "invalid-input") {
        return rejected("invalid-input");
      }
      return rejected(reference.status);
    }
    return inventoryRejection(inventory)!;
  }

  let candidate: LogicalModelCandidate | undefined;
  if (normalized.length === 0) {
    candidate = await dependencies.selector.select({
      candidates: inventory.candidates,
      currentModel: dependencies.currentModel,
      ui: dependencies.ui,
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal }),
    });
    if (candidate === undefined) return { status: "cancelled" };
    if (!inventory.candidates.some((entry) => entry === candidate)) {
      return rejected("unknown-model");
    }
  } else {
    const reference = resolveLogicalModelReference(normalized, inventory);
    if (reference.status !== "resolved") {
      return reference.status === "invalid-input"
        ? rejected("invalid-input")
        : reference.status === "out-of-scope" ||
            reference.status === "unavailable"
          ? rejected(reference.status, reference.modelId)
          : rejected(reference.status);
    }
    candidate = reference.candidate;
  }

  return apply(candidate);
}

function validatedModelId(modelId: string): string | undefined {
  if (modelId.trim() !== modelId || invalidReference(modelId) !== undefined) {
    return undefined;
  }
  return modelId;
}

/** Convert a result to fixed, non-sensitive operator output. */
export function renderLogicalModelSwitchResult(
  result: LogicalModelSwitchResult,
): string {
  if (result.status === "selected") {
    const modelId = validatedModelId(result.modelId);
    return modelId === undefined
      ? "Selected an exact unified model."
      : `Selected unified model ${modelId}.`;
  }
  if (result.status === "cancelled") {
    return "Model selection cancelled; the current model is unchanged.";
  }
  switch (result.reason) {
    case "absent":
      return "No usable unified models are declared. Run /multi-account models install, then reload or restart Pi.";
    case "unusable":
      return "The unified declaration is unusable. Run /multi-account models update, then reload or restart Pi.";
    case "out-of-scope":
      return "That exact logical model is outside this session's scope. Adjust enabledModels or launch with a matching --models value.";
    case "unavailable":
      return "That exact logical model is currently unavailable. Choose another logical row or reconcile changed catalogs.";
    case "foreign-provider":
      return "Exact logical identity is required; a foreign provider was not selected.";
    case "unknown-model":
      return "Exact logical identity is required; no model was selected.";
    case "ambiguous":
      return "That reference is ambiguous; exact logical identity is required.";
    case "invalid-input":
      return "The model reference is invalid; enter one exact logical model id.";
    case "tui-required":
      return "The picker requires terminal UI. Use /multi-account model <exact-model-id>.";
    case "host-refused": {
      const modelId =
        result.modelId === undefined ? undefined : validatedModelId(result.modelId);
      return modelId === undefined
        ? "Pi refused the exact model; the current model is unchanged."
        : `Pi refused the exact model ${modelId}; the current model is unchanged.`;
    }
    default: {
      const exhaustive: never = result.reason;
      return exhaustive;
    }
  }
}
