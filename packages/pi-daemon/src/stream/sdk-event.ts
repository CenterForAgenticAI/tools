import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  JsonObject,
  JsonValue,
  StreamFrame,
} from "../protocol/index.js";
import { canonicalizeJsonValue } from "../protocol/schema.js";

export type ProjectedSdkEvent = Extract<
  StreamFrame,
  { kind: "event" }
> extends infer Frame
  ? Frame extends { eventType: string; data: JsonObject }
    ? Pick<Frame, "eventType" | "data">
    : never
  : never;

// SDK events carry plain JS objects whose optional fields may be `undefined`
// (e.g. a toolResult message has `usage: undefined`). Those are not JsonValues,
// so they must be canonicalized before entering a protocol frame — otherwise the
// frame fails canonical validation on send and the reader is torn down
// (intel/pi-daemon#45).
function jsonObject(value: object): JsonObject {
  return canonicalizeJsonValue(value) as JsonObject;
}

function jsonValue(value: unknown): JsonValue {
  return canonicalizeJsonValue(value);
}

export function projectSdkEvent(event: AgentSessionEvent): ProjectedSdkEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "agent_settled":
    case "summarization_retry_finished":
      return { eventType: event.type, data: {} };
    case "agent_end":
      return {
        eventType: event.type,
        data: {
          messages: event.messages.map(jsonObject),
          willRetry: event.willRetry,
        },
      };
    case "turn_end":
      return {
        eventType: event.type,
        data: {
          message: jsonObject(event.message),
          toolResults: event.toolResults.map(jsonObject),
        },
      };
    case "message_start":
    case "message_end":
      return {
        eventType: event.type,
        data: { message: jsonObject(event.message) },
      };
    case "message_update":
      return {
        eventType: event.type,
        data: {
          message: jsonObject(event.message),
          assistantMessageEvent: jsonObject(event.assistantMessageEvent),
        },
      };
    case "tool_execution_start":
      return {
        eventType: event.type,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: jsonValue(event.args),
        },
      };
    case "tool_execution_update":
      return {
        eventType: event.type,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: jsonValue(event.args),
          partialResult: jsonValue(event.partialResult),
        },
      };
    case "tool_execution_end":
      return {
        eventType: event.type,
        data: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: jsonValue(event.result),
          isError: event.isError,
        },
      };
    case "queue_update":
      return {
        eventType: event.type,
        data: {
          steering: [...event.steering],
          followUp: [...event.followUp],
        },
      };
    case "compaction_start":
      return { eventType: event.type, data: { reason: event.reason } };
    case "entry_appended":
      return {
        eventType: event.type,
        data: { entry: jsonObject(event.entry) },
      };
    case "session_info_changed":
      return {
        eventType: event.type,
        data: event.name === undefined ? {} : { name: event.name },
      };
    case "thinking_level_changed":
      return { eventType: event.type, data: { level: event.level } };
    case "compaction_end":
      return {
        eventType: event.type,
        data: {
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(event.result === undefined ? {} : { result: jsonValue(event.result) }),
          ...(event.errorMessage === undefined
            ? {}
            : { errorMessage: event.errorMessage }),
        },
      };
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return {
        eventType: event.type,
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
      };
    case "auto_retry_end":
      return {
        eventType: event.type,
        data: {
          success: event.success,
          attempt: event.attempt,
          ...(event.finalError === undefined
            ? {}
            : { finalError: event.finalError }),
        },
      };
    case "summarization_retry_attempt_start":
      return {
        eventType: event.type,
        data:
          event.source === "branchSummary"
            ? { source: event.source }
            : { source: event.source, reason: event.reason },
      };
    case "bash_execution_update":
      return {
        eventType: event.type,
        data: {
          delta: event.delta,
          ...(event.id === undefined ? {} : { id: event.id }),
        },
      };
    default: {
      const incompatible: never = event;
      throw new TypeError(
        `unsupported AgentSessionEvent: ${String((incompatible as { type?: unknown }).type)}`,
      );
    }
  }
}
