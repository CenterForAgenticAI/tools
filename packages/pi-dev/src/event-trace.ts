import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { TraceMetadata, TraceRecord } from "./dev-types.ts";

const DEFAULT_CAPACITY = 200;
const MAX_CAPACITY = 1_000;

function messageRole(event: { readonly message?: { readonly role?: unknown } }): TraceMetadata {
  return typeof event.message?.role === "string" ? { role: event.message.role } : {};
}

/**
 * Convert one Pi event to a deliberately tiny metadata record. This function
 * never spreads or serializes the event object: every retained field is named
 * here so prompts, messages, headers, payloads, arguments, and results cannot
 * enter the trace by accident.
 */
export function allowlistedEventMetadata(event: ExtensionEvent): TraceMetadata {
  switch (event.type) {
    case "project_trust": return {};
    case "resources_discover": return { reason: event.reason };
    case "session_start": return { reason: event.reason };
    case "session_info_changed": return { hasName: event.name !== undefined };
    case "session_before_switch": return { reason: event.reason, hasTarget: event.targetSessionFile !== undefined };
    case "session_before_fork": return { position: event.position };
    case "session_before_compact": return {
      reason: event.reason,
      willRetry: event.willRetry,
      branchEntryCount: event.branchEntries.length,
    };
    case "session_compact": return {
      reason: event.reason,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
    };
    case "session_compact_failed": return {
      reason: event.reason,
      aborted: event.aborted,
      willRetry: event.willRetry,
      fromExtension: event.fromExtension,
    };
    case "session_shutdown": return { reason: event.reason, hasTarget: event.targetSessionFile !== undefined };
    case "session_before_tree": return {
      entryCount: event.preparation.entriesToSummarize.length,
      wantsSummary: event.preparation.userWantsSummary,
    };
    case "session_tree": return {
      hasSummary: event.summaryEntry !== undefined,
      fromExtension: event.fromExtension === true,
    };
    case "context": return { messageCount: event.messages.length };
    case "before_provider_request": return {};
    case "before_provider_headers": return {};
    case "after_provider_response": return { status: event.status };
    case "before_agent_start": return { imageCount: event.images?.length ?? 0 };
    case "agent_start": return {};
    case "agent_end": return { messageCount: event.messages.length };
    case "agent_settled": return {};
    // Pi 0.85 emits these UI lifecycle events. pi-dev does not trace them: their
    // human-facing titles are unnecessary metadata and may contain private text.
    case "ui_prompt_start": return {};
    case "ui_prompt_end": return {};
    case "turn_start": return { turnIndex: event.turnIndex };
    case "turn_end": return { turnIndex: event.turnIndex, toolResultCount: event.toolResults.length };
    case "message_start": return messageRole(event);
    case "message_update": return messageRole(event);
    case "message_end": return messageRole(event);
    case "tool_execution_start": return { toolName: event.toolName };
    case "tool_execution_update": return { toolName: event.toolName };
    case "tool_execution_end": return { toolName: event.toolName, isError: event.isError };
    case "model_select": return {
      provider: event.model.provider,
      modelId: event.model.id,
      source: event.source,
    };
    case "thinking_level_select": return { level: event.level, previousLevel: event.previousLevel };
    case "user_bash": return { excludeFromContext: event.excludeFromContext };
    case "input": return {
      source: event.source,
      imageCount: event.images?.length ?? 0,
      ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
    };
    case "tool_call": return { toolName: event.toolName };
    case "tool_result": return { toolName: event.toolName, isError: event.isError };
  }
}

export class EventTraceBuffer {
  readonly capacity: number;
  private readonly now: () => Date;
  private readonly retained: TraceRecord[] = [];
  private enabled = false;
  private sequence = 0;

  constructor(options: { readonly capacity?: number; readonly now?: () => Date } = {}) {
    const requested = options.capacity ?? DEFAULT_CAPACITY;
    const finite = Number.isFinite(requested) ? Math.trunc(requested) : DEFAULT_CAPACITY;
    this.capacity = Math.max(1, Math.min(MAX_CAPACITY, finite));
    this.now = options.now ?? (() => new Date());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  clear(): void {
    this.retained.length = 0;
  }

  records(): readonly TraceRecord[] {
    return this.retained.slice();
  }

  record(event: ExtensionEvent): void {
    if (!this.enabled) return;
    const record: TraceRecord = Object.freeze({
      sequence: ++this.sequence,
      at: this.now().toISOString(),
      event: event.type,
      metadata: Object.freeze({ ...allowlistedEventMetadata(event) }),
    });
    this.retained.push(record);
    if (this.retained.length > this.capacity) this.retained.splice(0, this.retained.length - this.capacity);
  }
}

/**
 * Register every passive public Pi lifecycle hook without retaining raw event
 * objects. `project_trust` is intentionally not registered: it is a
 * decision-bearing hook whose handler must return a trust decision, so merely
 * observing it could alter Pi's security flow.
 */
export function wireEventTrace(pi: ExtensionAPI, trace: EventTraceBuffer): void {
  pi.on("resources_discover", (event) => trace.record(event));
  pi.on("session_start", (event) => trace.record(event));
  pi.on("session_info_changed", (event) => trace.record(event));
  pi.on("session_before_switch", (event) => trace.record(event));
  pi.on("session_before_fork", (event) => trace.record(event));
  pi.on("session_before_compact", (event) => trace.record(event));
  pi.on("session_compact", (event) => trace.record(event));
  pi.on("session_shutdown", (event) => trace.record(event));
  pi.on("session_before_tree", (event) => trace.record(event));
  pi.on("session_tree", (event) => trace.record(event));
  pi.on("context", (event) => trace.record(event));
  pi.on("before_provider_request", (event) => trace.record(event));
  pi.on("before_provider_headers", (event) => trace.record(event));
  pi.on("after_provider_response", (event) => trace.record(event));
  pi.on("before_agent_start", (event) => trace.record(event));
  pi.on("agent_start", (event) => trace.record(event));
  pi.on("agent_end", (event) => trace.record(event));
  pi.on("agent_settled", (event) => trace.record(event));
  pi.on("turn_start", (event) => trace.record(event));
  pi.on("turn_end", (event) => trace.record(event));
  pi.on("message_start", (event) => trace.record(event));
  pi.on("message_update", (event) => trace.record(event));
  pi.on("message_end", (event) => trace.record(event));
  pi.on("tool_execution_start", (event) => trace.record(event));
  pi.on("tool_execution_update", (event) => trace.record(event));
  pi.on("tool_execution_end", (event) => trace.record(event));
  pi.on("model_select", (event) => trace.record(event));
  pi.on("thinking_level_select", (event) => trace.record(event));
  pi.on("user_bash", (event) => trace.record(event));
  pi.on("input", (event) => trace.record(event));
  pi.on("tool_call", (event) => trace.record(event));
  pi.on("tool_result", (event) => trace.record(event));
}
