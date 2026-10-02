import {
  isManagedFamily,
  type ManagedFamily,
  type MultiAccountConfig,
} from "./config.js";
import {
  PROVIDER_ERROR_CODES,
  type ProviderErrorCode,
} from "./error-classification.js";
import { vendorForFamily } from "./vendor.js";

/**
 * Structured facts the pinned provider adapters surface, projected by the
 * caller from exact fields only. Pinned pi-ai 0.84.4 evidence:
 *
 * - HTTP status: `onResponse({ status })` in `dist/api/anthropic-messages.js`,
 *   `openai-responses.js`, and the Codex SSE path of
 *   `openai-codex-responses.js`; SDK errors carry `status`
 *   (`@anthropic-ai/sdk` `APIError`, `utils/error-body.js` `extractStatus`).
 * - Error code: the Anthropic `{type:"error",error:{type}}` envelope and the
 *   Codex `CodexApiError.code` / `response.failed` `error.code` fields, already
 *   canonicalized to {@link ProviderErrorCode} by `src/error-classification.ts`.
 * - Stop reason: `AssistantMessage.rawStopReason`, set from Anthropic
 *   `delta.stop_reason` (`refusal`, `sensitive`) and from Responses/Codex
 *   `status[.incomplete_reason]` (`incomplete.content_filter`).
 *
 * Every adapter flattens failures into a bounded `errorMessage`; that prose is
 * deliberately absent from this contract and is never parsed here.
 *
 * Relationship to the recovery engine's content-free `RecoveryModelFailure`
 * projection (`stopReason`, `api`, `provider`, `model`, `hasErrorMessage`,
 * `diagnosticTypes`, and the optional `code`): no assistant content, thinking,
 * tool call, or error text is needed, and the first six fields are never
 * consulted. The projection's optional `code` carries only the structured stop
 * codes `refusal` and `unknown_stop`; an integration may pass it through as the
 * signal `code`, where both values stop model substitution (`refusal` and
 * `unknown`). The other signal fields lie outside that projection and must be
 * supplied as structured error facts by the integration:
 *
 * - `httpStatus`: the response or SDK error status.
 * - `code`: the canonical code projected from the structured provider error
 *   envelope or Codex error-code field before the hook runs, or the
 *   projection's structured stop code. The projection carries only
 *   `hasErrorMessage`, never the envelope.
 * - `providerStopReason`: `AssistantMessage.rawStopReason`, which the
 *   projection deliberately omits.
 * - `verifiedCapability`: computed locally from the outgoing request and the
 *   catalog entry, never from the response.
 *
 * Given only the projection's fields, no signal field can trigger a fallback:
 * every field is absent or is a stop code that classifies as `refusal` or
 * `unknown`, so no model substitution happens (fail closed).
 * {@link SelectedFallbackModel} likewise needs only request metadata (required
 * input modalities, whether tools are present, a token estimate), never
 * assistant output.
 */
export interface ModelFallbackFailureSignal {
  readonly httpStatus?: number;
  /** Canonical code projected from an exact upstream type/code field. */
  readonly code?: ProviderErrorCode;
  /** Exact `AssistantMessage.rawStopReason`. */
  readonly providerStopReason?: string;
  /** Capability mismatch established from request and catalog metadata, not prose. */
  readonly verifiedCapability?: "input-modality" | "tools";
}

export type ModelFallbackFailureKind =
  | "model_not_found"
  | "capability_incompatibility"
  | "invalid_request"
  | "quota"
  | "auth"
  | "rate_limit"
  | "refusal"
  | "unknown";

export interface ModelFallbackFailureClassification {
  readonly kind: ModelFallbackFailureKind;
}

const PROVIDER_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  PROVIDER_ERROR_CODES,
);
const AUTH_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "invalid_api_key",
  "invalid_token",
  "token_expired",
  "token_revoked",
  "oauth_refresh_rejected",
  "oauth_service_unavailable",
  "insufficient_permissions",
]);
const REFUSAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "refusal",
  "sensitive",
  "incomplete.content_filter",
  "content_filter",
]);
const VERIFIED_CAPABILITIES: ReadonlySet<string> = new Set([
  "input-modality",
  "tools",
]);

/**
 * Classifies only exact status/code/stop-reason fields, each revalidated at
 * runtime so a cast or spread caller cannot smuggle prose through. Account
 * facts (quota, rate limit, auth, permission) and refusals always dominate:
 * they route to another account or stop, never to a different model. A
 * structured `refusal` code or refusal stop reason, and a structured
 * `unknown_stop` code, outrank every model-fallback fact (`model_not_found`,
 * verified capability mismatch, malformed request).
 */
export function classifyModelFallbackFailure(
  signal: ModelFallbackFailureSignal,
): ModelFallbackFailureClassification {
  const httpStatus = Number.isInteger(signal.httpStatus)
    ? signal.httpStatus
    : undefined;
  const code =
    typeof signal.code === "string" && PROVIDER_ERROR_CODE_SET.has(signal.code)
      ? signal.code
      : undefined;
  if (code === "quota_exhausted") return { kind: "quota" };
  if (httpStatus === 429 || code === "rate_limit") return { kind: "rate_limit" };
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    (code !== undefined && AUTH_CODES.has(code))
  ) {
    return { kind: "auth" };
  }
  if (
    code === "refusal" ||
    (typeof signal.providerStopReason === "string" &&
      REFUSAL_STOP_REASONS.has(signal.providerStopReason))
  ) {
    return { kind: "refusal" };
  }
  // An unknown stop proves nothing about the model; it is never a fallback.
  if (code === "unknown_stop") return { kind: "unknown" };
  // A server failure proves nothing about the model; it is never a fallback.
  if (httpStatus !== undefined && httpStatus >= 500) return { kind: "unknown" };
  if (code === "model_not_found") return { kind: "model_not_found" };
  const malformed =
    code === "invalid_request" || code === "unsupported_api_version";
  if (
    typeof signal.verifiedCapability === "string" &&
    VERIFIED_CAPABILITIES.has(signal.verifiedCapability)
  ) {
    // A provider rejection of the sent request cannot be attributed to the
    // locally verified mismatch rather than to a malformed request.
    return malformed ? { kind: "unknown" } : { kind: "capability_incompatibility" };
  }
  if (malformed) return { kind: "invalid_request" };
  return { kind: "unknown" };
}

/**
 * The physical family that serves a model. `openrouter` is the metered router:
 * it has no single model vendor, so it is never "same-vendor" with anything.
 */
export type ModelFallbackFamily = ManagedFamily | "openrouter";

export interface SelectedFallbackModel {
  readonly modelId: string;
  /** Missing or unknown at runtime fails closed. */
  readonly family?: ModelFallbackFamily;
  readonly requiredInput: readonly string[];
  readonly requiresTools: boolean;
  /**
   * The caller's estimate of the whole request (context plus reserved output)
   * in tokens. Required: an unknown size cannot prove fit and refuses.
   */
  readonly requestContextTokens: number;
}

export type ModelFallbackIneligibilityReason =
  | "unavailable"
  | "disabled"
  | "credential-unavailable"
  | "group-excluded"
  | "pricing-unknown"
  | "egress-consent-missing"
  | "delegate-excluded";

export type ModelFallbackEligibility =
  | { readonly status: "eligible" }
  | {
      readonly status: "ineligible";
      readonly reason: ModelFallbackIneligibilityReason;
    };

/** One exact catalog identity with all live eligibility already projected. */
export interface ModelFallbackCandidate {
  readonly modelId: string;
  /** Missing or unknown at runtime fails closed. */
  readonly family?: ModelFallbackFamily;
  readonly input: readonly string[];
  readonly supportsTools: boolean;
  readonly contextWindow: number;
  readonly eligibility: ModelFallbackEligibility;
}

export interface SelectFallbackModelInput {
  readonly selectedModel: SelectedFallbackModel;
  readonly failure: ModelFallbackFailureClassification;
  readonly config: Pick<
    MultiAccountConfig,
    "modelFallbacks" | "modelFallbackEgress"
  >;
  readonly candidates: readonly ModelFallbackCandidate[];
  readonly cancelled: boolean;
}

export type ModelFallbackRefusalReason =
  | "not-configured"
  | "failure-not-eligible"
  | "cancelled"
  | "model-family-ambiguous"
  | "request-size-unknown"
  | "cross-vendor-egress-unauthorized"
  | "no-eligible-destination";

export type ModelFallbackEgress = "same-vendor" | "authorized-cross-vendor";

export type SelectFallbackModelResult =
  | {
      readonly status: "fallback";
      readonly modelId: string;
      readonly egress: ModelFallbackEgress;
    }
  | { readonly status: "none"; readonly reason: ModelFallbackRefusalReason };

/** Injected-hook shape for the recovery engine's `model` action. */
export type SelectFallbackModel = (
  input: SelectFallbackModelInput,
) => SelectFallbackModelResult;

/** Managed vendor, the metered router, or `null` when the family is unknown. */
type EgressIdentity =
  | { readonly kind: "vendor"; readonly vendor: string }
  | { readonly kind: "openrouter" };

function egressIdentity(family: unknown): EgressIdentity | null {
  if (typeof family !== "string") return null;
  if (family === "openrouter") return { kind: "openrouter" };
  if (!isManagedFamily(family)) return null;
  return { kind: "vendor", vendor: vendorForFamily(family) };
}

function sameEgressIdentity(left: EgressIdentity, right: EgressIdentity): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "openrouter" ||
      (right.kind === "vendor" && left.vendor === right.vendor))
  );
}

/** Only a managed destination authored by the source's vendor is same-vendor. */
function isSameVendor(source: EgressIdentity, destination: EgressIdentity): boolean {
  return (
    source.kind === "vendor" &&
    destination.kind === "vendor" &&
    source.vendor === destination.vendor
  );
}

function configuredDestinations(
  config: SelectFallbackModelInput["config"],
  modelId: string,
): readonly string[] {
  const map = config.modelFallbacks;
  // Own keys only: an inherited name such as `constructor` is never policy.
  if (map === undefined || !Object.hasOwn(map, modelId)) return [];
  return map[modelId] ?? [];
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fitsRequest(
  candidate: ModelFallbackCandidate,
  selected: SelectedFallbackModel,
): boolean {
  const supported = new Set(candidate.input);
  return (
    selected.requiredInput.every((modality) => supported.has(modality)) &&
    (!selected.requiresTools || candidate.supportsTools === true) &&
    isTokenCount(candidate.contextWindow) &&
    selected.requestContextTokens <= candidate.contextWindow
  );
}

function hasDirectionalEgressAuthorization(
  input: SelectFallbackModelInput,
  destinationModelId: string,
): boolean {
  return (input.config.modelFallbackEgress ?? []).some(
    (edge) =>
      edge.sourceModelId === input.selectedModel.modelId &&
      edge.destinationModelId === destinationModelId,
  );
}

/**
 * Selects at most one configured model and performs no I/O or dispatch.
 *
 * Only the first configured destination that is present, unambiguous,
 * currently eligible, and able to carry the request unchanged is returned. A
 * smaller context window is not a rejection on its own; a window the request
 * does not fit is, because nothing downstream may truncate or summarize.
 * Metered (OpenRouter) and other-vendor destinations always require the exact
 * directional `modelFallbackEgress` edge.
 */
export const selectFallbackModel: SelectFallbackModel = (input) => {
  if (input.cancelled) return { status: "none", reason: "cancelled" };
  if (
    input.failure.kind !== "model_not_found" &&
    input.failure.kind !== "capability_incompatibility"
  ) {
    return { status: "none", reason: "failure-not-eligible" };
  }
  const source = input.selectedModel;
  const destinations = configuredDestinations(input.config, source.modelId);
  if (destinations.length === 0) {
    return { status: "none", reason: "not-configured" };
  }
  const sourceIdentity = egressIdentity(source.family);
  if (sourceIdentity === null) {
    return { status: "none", reason: "model-family-ambiguous" };
  }
  if (!isTokenCount(source.requestContextTokens)) {
    return { status: "none", reason: "request-size-unknown" };
  }

  let sawUnauthorizedCrossVendor = false;
  for (const destinationModelId of destinations) {
    if (destinationModelId === source.modelId) continue;
    const matches = input.candidates.filter(
      (candidate) => candidate.modelId === destinationModelId,
    );
    if (matches.length === 0) continue;
    const identities = matches.map((candidate) =>
      egressIdentity(candidate.family),
    );
    const destinationIdentity = identities[0];
    if (
      destinationIdentity === undefined ||
      destinationIdentity === null ||
      identities.some(
        (identity) =>
          identity === null || !sameEgressIdentity(identity, destinationIdentity),
      )
    ) {
      return { status: "none", reason: "model-family-ambiguous" };
    }
    const usable = matches.some(
      (candidate) =>
        candidate.eligibility.status === "eligible" &&
        fitsRequest(candidate, source),
    );
    if (!usable) continue;

    if (isSameVendor(sourceIdentity, destinationIdentity)) {
      return { status: "fallback", modelId: destinationModelId, egress: "same-vendor" };
    }
    if (hasDirectionalEgressAuthorization(input, destinationModelId)) {
      return {
        status: "fallback",
        modelId: destinationModelId,
        egress: "authorized-cross-vendor",
      };
    }
    sawUnauthorizedCrossVendor = true;
  }

  return {
    status: "none",
    reason: sawUnauthorizedCrossVendor
      ? "cross-vendor-egress-unauthorized"
      : "no-eligible-destination",
  };
};
