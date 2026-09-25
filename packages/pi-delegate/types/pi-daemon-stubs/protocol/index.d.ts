// VENDORED build-time type fallback for the OPTIONAL @caair/pi-daemon peer (#35 / #470).
// Copied verbatim from @caair/pi-daemon dist .d.ts. Used ONLY when the package is
// absent (tsconfig `paths` resolves the real node_modules types first, these second),
// so pi-delegate builds/type-checks without the package. Regenerate by re-copying
// @caair/pi-daemon/dist/{client,protocol}/*.d.ts when the daemon protocol changes.
// Do not hand-edit.
export declare const PACKAGE = "@caair/pi-daemon/protocol";
export { CUSTOM_ENTRY_TYPES, DAEMON_FRAME_NAMES, ERROR_CODES, ERROR_GROUPS, EVENT_TYPES, OPERATIONS, OPERATION_ERROR_CODES, PROMPT_OUTCOMES, PROMPT_OUTCOME_ERROR_CODES, PROTOCOL_JSON_SCHEMA, PROTOCOL_VERSION, STREAM_KINDS, isCustomEntryData, isDaemonCustomEntry, isFailureFrame, isOperationResult, isPromptOutcome, isPromptStatusResult, isProtocolFrame, isRequestFrame, isStreamFrame, isSuccessFrame, type Attention, type Cursor, type CustomEntryData, type CustomEntryType, type DaemonCustomEntry, type ErrorCode, type EventType, type FailureFrame, type JsonObject, type JsonValue, type ObservedPhase, type Operation, type OperationParams, type OperationResult, type Phase, type PromptOutcome, type PromptOutcomeErrorCode, type PromptOutcomeName, type PromptStatusResult, type ProtocolFrame, type RequestFrame, type ResponseFrame, type RuntimeState, type SessionSummary, type StreamFrame, type StreamKind, type SuccessFrame, type UiMethod, } from "./canonical.js";
//# sourceMappingURL=index.d.ts.map