import type { AssistantMessage } from "@earendil-works/pi-ai";

export type CodexRecoverySendEvidence = "pre-execution-rejected" | "uncertain";

/**
 * Classify whether a pinned Codex WebSocket terminal proves that one request was
 * rejected before execution without an internal reconnect or SSE fallback.
 *
 * Pinned pi-ai 0.84.4 sends `response.create` before it observes stream events
 * (`dist/api/openai-codex-responses.js:1182`). Its WebSocket loop can reconnect
 * for two special errors or fall back to SSE (`:218-245`). The
 * `provider_transport_failure` diagnostic is appended only on that transport
 * branch (`:229-237`). Structured `CodexApiError` fields are instead normalized
 * to terminal `errorMessage` (`:483-539`, `:344-346`), which retains neither the
 * code/payload nor proof that no prior reconnect occurred.
 *
 * The per-session `getOpenAICodexWebSocketDebugStats` counters (`:632-654`)
 * are process-global, shared by concurrent requests, and absent from the
 * terminal, so they cannot attribute sends to one invocation either.
 *
 * Consequently no terminal `AssistantMessage` exposed by the pinned package is
 * trustworthy proof of the complete condition. Do not infer safety from prose,
 * status-like text, or the absence of a transport diagnostic.
 */
export function classifyCodexRecoverySendEvidence(
	_terminal: AssistantMessage,
): CodexRecoverySendEvidence {
	return "uncertain";
}
