import type { Api, Model, AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { PROVIDER_ERROR_CODES, TRANSPORT_FAILURE_KINDS, type ProviderErrorCode, type TransportFailureKind } from "./error-classification.js";
import { hostFinalStopMessage } from "./host-final-stop-message.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";

export interface PublicAssistantIdentity {
  readonly api: AssistantMessage["api"];
  readonly provider: AssistantMessage["provider"];
  readonly model: string;
}
export type PublicAssistantMessage = AssistantMessage & {
  code?: ProviderErrorCode;
  httpStatus?: number;
  transportKind?: TransportFailureKind;
  retryAfterSeconds?: number;
  resetAtMs?: number;
};

/** Bounds accounting/time facts without coercing provider values. */
export function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}
export function projectTerminalUsage(message: AssistantMessage): AssistantMessage["usage"] | undefined {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || typeof usage.cost !== "object" || usage.cost === null) return undefined;
  const input = finiteNonNegative(usage.input);
  const output = finiteNonNegative(usage.output);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  const totalTokens = finiteNonNegative(usage.totalTokens);
  const costInput = finiteNonNegative(usage.cost.input);
  const costOutput = finiteNonNegative(usage.cost.output);
  const costCacheRead = finiteNonNegative(usage.cost.cacheRead);
  const costCacheWrite = finiteNonNegative(usage.cost.cacheWrite);
  const costTotal = finiteNonNegative(usage.cost.total);
  const cacheWrite1h = finiteNonNegative(usage.cacheWrite1h);
  const reasoning = finiteNonNegative(usage.reasoning);
  if ((usage.cacheWrite1h !== undefined && cacheWrite1h === undefined) || (usage.reasoning !== undefined && reasoning === undefined)) return undefined;
  // Construct only validated named accounting fields.
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalTokens === undefined || costInput === undefined || costOutput === undefined || costCacheRead === undefined || costCacheWrite === undefined || costTotal === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens,
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }), ...(reasoning === undefined ? {} : { reasoning }),
    cost: { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite, total: costTotal } };
}

function projectToolCall(block: ToolCall): ToolCall {
  if (typeof block !== "object" || block === null || typeof block.id !== "string" || typeof block.name !== "string" || typeof block.arguments !== "object" || block.arguments === null || Array.isArray(block.arguments)) {
    throw new TypeError("Malformed public tool call.");
  }
  return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments,
    ...(typeof block.thoughtSignature === "string" ? { thoughtSignature: block.thoughtSignature } : {}),
    ...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}) };
}
/** Content is the response, not diagnostic metadata. Keep protocol signatures and tool IDs. */
export function projectAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): AssistantMessage["content"] => {
    if (typeof block !== "object" || block === null) return [];
    switch (block.type) {
      case "text": if (typeof block.text !== "string") return [];
        return [{ type: "text", text: block.text,
        ...(typeof block.textSignature === "string" ? { textSignature: block.textSignature } : {}) }];
      case "thinking": if (typeof block.thinking !== "string") return [];
        return [{ type: "thinking", thinking: block.thinking,
        ...(typeof block.thinkingSignature === "string" ? { thinkingSignature: block.thinkingSignature } : {}),
        ...(typeof block.redacted === "boolean" ? { redacted: block.redacted } : {}) }];
      case "toolCall":
        if (typeof block.id !== "string" || typeof block.name !== "string" || typeof block.arguments !== "object" || block.arguments === null || Array.isArray(block.arguments)) return [];
        return [projectToolCall(block)];
      default: return [];
    }
  });
}

/** Only the managed transport diagnostic's named facts are public; never its Error/details DTO. */
function projectTransportDiagnostics(message: AssistantMessage): AssistantMessage["diagnostics"] {
  if (!Array.isArray(message.diagnostics)) return undefined;
  return message.diagnostics.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || entry.type !== "provider_transport_failure") return [];
    const timestamp = finiteNonNegative(entry.timestamp);
    if (timestamp === undefined) return [];
    const details = entry.details;
    const configured = details?.configuredTransport;
    const fallback = details?.fallbackTransport;
    const phase = details?.phase;
    return [{ type: "provider_transport_failure", timestamp, details: {
      ...(typeof configured === "string" && ["auto", "sse", "websocket", "websocket-cached"].includes(configured) ? { configuredTransport: configured } : {}),
      ...(fallback === "sse" ? { fallbackTransport: "sse" } : {}),
      ...(typeof details?.eventsEmitted === "boolean" ? { eventsEmitted: details.eventsEmitted } : {}),
      ...(phase === "before_message_stream_start" || phase === "after_message_stream_start" ? { phase } : {}),
    } }];
  });
}

// Known wire reasons are public enums, not arbitrary provider prose. Managed streams
// emit no DeferredHandle; responseId/responseModel are output-only metadata here.
const PUBLIC_RAW_STOP_REASONS = [
  "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "sensitive",
  "completed", "incomplete", "incomplete.max_output_tokens", "incomplete.content_filter", "content_filter", "failed", "cancelled",
  "STOP", "MAX_TOKENS", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "FINISH_REASON_UNSPECIFIED", "OTHER",
] as const;
/** Public managed response DTO: no provider-object spread, request IDs, raw bodies or unknown fields. */
export function projectPublicAssistantMessage(
  message: AssistantMessage, identity: PublicAssistantIdentity, errorMessage?: string,
): PublicAssistantMessage {
  const stop = hostFinalStopMessage(message);
  const codeValue = Object.getOwnPropertyDescriptor(message, "code")?.value;
  const code = PROVIDER_ERROR_CODES.find((value) => value === codeValue);
  const statusValue = Object.getOwnPropertyDescriptor(message, "httpStatus")?.value ?? Object.getOwnPropertyDescriptor(message, "status")?.value;
  const httpStatus = typeof statusValue === "number" && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined;
  const transportValue = Object.getOwnPropertyDescriptor(message, "transportKind")?.value;
  const transportKind = TRANSPORT_FAILURE_KINDS.find((value) => value === transportValue);
  const retryAfterSeconds = finiteNonNegative(Object.getOwnPropertyDescriptor(message, "retryAfterSeconds")?.value);
  const resetAtMs = finiteNonNegative(Object.getOwnPropertyDescriptor(message, "resetAtMs")?.value);
  const diagnostics = projectTransportDiagnostics(message);
  const usage = projectTerminalUsage(message) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return {
    role: "assistant", content: projectAssistantContent(message.content),
    api: identity.api, provider: identity.provider, model: identity.model,
    usage, timestamp: finiteNonNegative(message.timestamp) ?? 0,
    stopReason: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(message.stopReason) ? message.stopReason : "error",
    ...(typeof message.endTurn === "boolean" ? { endTurn: message.endTurn } : {}),
    ...(PUBLIC_RAW_STOP_REASONS.find((reason) => reason === message.rawStopReason) === undefined ? {} : { rawStopReason: message.rawStopReason }),
    ...(code === undefined ? {} : { code }), ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(transportKind === undefined ? {} : { transportKind }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }), ...(resetAtMs === undefined ? {} : { resetAtMs }),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
    ...(stop ?? (errorMessage === undefined ? {} : { errorMessage })),
  };
}

/** Named event variants prevent extra fields on progress and terminal envelopes from surviving. */
export function projectPublicAssistantEvent(event: unknown, identity: PublicAssistantIdentity, errorMessage?: string): AssistantMessageEvent | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  // The public stream union is validated by its producer/registration bridge.
  const source = event as AssistantMessageEvent;
  const contentIndex = "contentIndex" in source && typeof source.contentIndex === "number" && Number.isSafeInteger(source.contentIndex) && source.contentIndex >= 0 ? source.contentIndex : 0;
  switch (source.type) {
    case "done": return { type: "done", reason: ["stop", "length", "toolUse", "deferred"].includes(source.reason) ? source.reason : "stop", message: projectPublicAssistantMessage(source.message, identity, errorMessage) };
    case "error": return { type: "error", reason: source.reason === "aborted" ? "aborted" : "error", error: projectPublicAssistantMessage(source.error, identity, errorMessage) };
    case "start": return { type: "start", partial: projectPublicAssistantMessage(source.partial, identity) };
    case "text_start": case "thinking_start": case "toolcall_start":
      return { type: source.type, contentIndex, partial: projectPublicAssistantMessage(source.partial, identity) };
    case "text_delta": case "thinking_delta": case "toolcall_delta":
      return { type: source.type, contentIndex, delta: typeof source.delta === "string" ? source.delta : "", partial: projectPublicAssistantMessage(source.partial, identity) };
    case "text_end": case "thinking_end":
      return { type: source.type, contentIndex, content: typeof source.content === "string" ? source.content : "", partial: projectPublicAssistantMessage(source.partial, identity) };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex, toolCall: projectToolCall(source.toolCall), partial: projectPublicAssistantMessage(source.partial, identity) };
    default: return undefined;
  }
}

/** Alias errors keep existing bounded retry prose; structured stops always use fixed reasons. */
export function projectAliasAssistantEvent(event: AssistantMessageEvent, model: Model<Api>): AssistantMessageEvent {
  const rawError = event.type === "error" ? event.error.errorMessage : undefined;
  const projected = projectPublicAssistantEvent(event, {
    api: model.api, provider: model.provider, model: model.id,
  }, rawError === undefined ? undefined : sanitizeDiagnosticText(rawError));
  if (projected === undefined) throw new TypeError("Unsupported provider stream event.");
  return projected;
}
