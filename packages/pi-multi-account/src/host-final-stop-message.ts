import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/** Fixed public reasons: provider prose and unknown reason payloads are never retained. */
export const REFUSAL_FALLBACK_MESSAGE = "The model refused to complete the request";
export const UNKNOWN_STOP_FALLBACK_MESSAGE = "Provider stopped with an unrecognized stop reason";
// Kept for source compatibility; reasons are now entirely withheld, not reworded.
export const PARTLY_WITHHELD_MARKER = " (partly withheld)";

/** Probe pinned host predicates without publishing the provider DTO. */
export function hostWouldRedispatch(message: AssistantMessage, text: string): boolean {
  try {
    // Private predicate probe only; this object is never published or retained.
    const probe = { ...message, errorMessage: text };
    return isRetryableAssistantError(probe) || isContextOverflow(probe, 0);
  } catch { return true; }
}

/** A structured stop is an answer, never retry/overflow evidence or a prose retention permission. */
export function hostFinalStopMessage(message: AssistantMessage): {
  readonly errorMessage: string;
  readonly rawStopReason: "refusal" | "unknown_stop";
} | undefined {
  const code = Object.getOwnPropertyDescriptor(message, "code")?.value;
  if (message.stopReason !== "error" || (code !== "refusal" && code !== "unknown_stop")) return undefined;
  return { errorMessage: code === "refusal" ? REFUSAL_FALLBACK_MESSAGE : UNKNOWN_STOP_FALLBACK_MESSAGE, rawStopReason: code };
}
