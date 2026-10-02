import {
  JSON_VALUE_DEFINITION,
  array,
  boolean as booleanSchema,
  boundedString,
  enumeration,
  jsonObject,
  jsonValue,
  literal,
  nonNegativeInteger,
  nullable,
  object,
  optional,
  patternedString,
  positiveInteger,
  projectUnionDiscriminator,
  string as stringSchema,
  timestamp,
  union,
  unionFromRecord,
  type Infer,
  type JsonObject,
  type JsonValue,
  type Schema,
} from "./schema.js";

const enumFromValues = <const T extends readonly [string, ...string[]]>(
  values: T,
) => enumeration(...values);

const keysOf = <const T extends Readonly<Record<string, unknown>>>(value: T) =>
  Object.freeze(Object.keys(value) as Extract<keyof T, string>[]);

const cursorSchema = object({
  entryId: nullable(stringSchema),
  epoch: nonNegativeInteger,
});

const runtimeStateSchema = enumeration("awake", "asleep");
const phaseSchema = enumeration("idle", "working", "blocked", "failed", "gone");
const observedPhaseSchema = enumeration(
  "idle",
  "working",
  "blocked",
  "failed",
  "gone",
  "asleep",
);
const attentionSchema = enumeration(
  "none",
  "question",
  "failed",
  "interrupted",
);
const uiMethodSchema = enumeration("select", "confirm", "input", "editor");

const pendingQuestionSchema = object({
  questionId: stringSchema,
  method: uiMethodSchema,
  title: optional(stringSchema),
});

const sessionSummarySchema = object({
  sessionId: stringSchema,
  sessionFile: stringSchema,
  cwd: stringSchema,
  name: optional(stringSchema),
  runtime: runtimeStateSchema,
  phase: phaseSchema,
  observedPhase: observedPhaseSchema,
  attention: attentionSchema,
  generation: nonNegativeInteger,
  epoch: nonNegativeInteger,
  cursor: cursorSchema,
  pendingQuestions: array(pendingQuestionSchema),
  heartbeat: object({ seq: nonNegativeInteger, at: timestamp }),
});

export type Cursor = Infer<typeof cursorSchema>;
export type RuntimeState = Infer<typeof runtimeStateSchema>;
export type Phase = Infer<typeof phaseSchema>;
export type ObservedPhase = Infer<typeof observedPhaseSchema>;
export type Attention = Infer<typeof attentionSchema>;
export type UiMethod = Infer<typeof uiMethodSchema>;
export type SessionSummary = Infer<typeof sessionSummarySchema>;

const settledPromptOutcome = literal("settled");
const abortedPromptOutcome = literal("aborted");
const failedPromptOutcome = literal("failed");
const abortedPromptOutcomeError = literal("aborted");
const FAILED_PROMPT_OUTCOME_ERROR_CODES = [
  "interrupted",
  "external_writer",
  "provider_error",
  "sdk_error",
  "rejected",
] as const;
const failedPromptOutcomeErrorSchema = enumFromValues(
  FAILED_PROMPT_OUTCOME_ERROR_CODES,
);

const promptOutcomeSource = {
  settled: object({ outcome: settledPromptOutcome }),
  aborted: object({
    outcome: abortedPromptOutcome,
    errorCode: abortedPromptOutcomeError,
  }),
  failed: object({
    outcome: failedPromptOutcome,
    errorCode: failedPromptOutcomeErrorSchema,
  }),
} as const;

export const PROMPT_OUTCOMES = keysOf(promptOutcomeSource);
export const PROMPT_OUTCOME_ERROR_CODES = [
  "aborted",
  ...FAILED_PROMPT_OUTCOME_ERROR_CODES,
] as const;

const promptOutcomeSchema = unionFromRecord(promptOutcomeSource);
const promptOutcomeErrorCodeSchema = enumFromValues(PROMPT_OUTCOME_ERROR_CODES);

export type PromptOutcome = Infer<typeof promptOutcomeSchema>;
export type PromptOutcomeName = (typeof PROMPT_OUTCOMES)[number];
export type PromptOutcomeErrorCode = Infer<
  typeof promptOutcomeErrorCodeSchema
>;

const promptStatusResultSource = {
  pending: object({
    state: literal("pending"),
    promptId: optional(stringSchema),
    acceptedAt: optional(timestamp),
    reason: optional(literal("external_writer")),
  }),
  unknown: object({ state: literal("unknown") }),
  settled: object({
    state: settledPromptOutcome,
    promptId: optional(stringSchema),
    terminalOutcome: settledPromptOutcome,
    acceptedAt: optional(timestamp),
    settledAt: optional(timestamp),
    finalCursor: optional(cursorSchema),
  }),
  aborted: object({
    state: abortedPromptOutcome,
    promptId: optional(stringSchema),
    terminalOutcome: abortedPromptOutcome,
    acceptedAt: optional(timestamp),
    settledAt: optional(timestamp),
    finalCursor: optional(cursorSchema),
    errorCode: abortedPromptOutcomeError,
  }),
  failed: object({
    state: failedPromptOutcome,
    promptId: optional(stringSchema),
    terminalOutcome: failedPromptOutcome,
    acceptedAt: optional(timestamp),
    settledAt: optional(timestamp),
    finalCursor: optional(cursorSchema),
    errorCode: failedPromptOutcomeErrorSchema,
  }),
} as const;

const promptStatusResultSchema = unionFromRecord(promptStatusResultSource);
export type PromptStatusResult = Infer<typeof promptStatusResultSchema>;

export const ERROR_CODES = [
  "bad_frame",
  "frame_too_large",
  "handshake_required",
  "protocol_mismatch",
  "unsupported_op",
  "invalid_request",
  "unknown_session",
  "duplicate_session",
  "path_mismatch",
  "session_locked",
  "external_writer",
  "gone",
  "not_attached",
  "busy",
  "rejected",
  "no_lease",
  "lease_held",
  "lease_expired",
  "stale_generation",
  "stale_epoch",
  "asleep",
  "already_asleep",
  "invalid_state",
  "cursor_unknown",
  "cursor_off_branch",
  "unknown_question",
  "invalid_ui_answer",
  "idempotency_conflict",
  "queue_full",
  "sdk_incompatible",
  "shutdown_in_progress",
  "unavailable",
  "internal",
] as const;

const errorCodeSchema = enumFromValues(ERROR_CODES);
export type ErrorCode = Infer<typeof errorCodeSchema>;

export const ERROR_GROUPS = {
  frame: ["bad_frame", "frame_too_large"],
  handshake: ["handshake_required", "protocol_mismatch"],
  request: ["invalid_request", "unsupported_op", "unavailable", "internal"],
  session: ["unknown_session"],
  registrationLock: ["session_locked"],
  attachment: ["not_attached"],
  generation: ["stale_generation"],
  awakeHostMutation: ["asleep", "external_writer"],
  driver: ["no_lease", "lease_expired"],
} as const satisfies Readonly<Record<string, readonly ErrorCode[]>>;

type ErrorGroupName = keyof typeof ERROR_GROUPS;
type SessionRequirement = "required" | "optional" | "forbidden";
type AnySchema = Schema<unknown>;

interface OperationDefinition {
  readonly session: SessionRequirement;
  readonly params: AnySchema;
  readonly result: AnySchema;
  readonly errorGroups: readonly ErrorGroupName[];
  readonly extraErrors: readonly ErrorCode[];
}

const operation = <const T extends OperationDefinition>(definition: T) =>
  definition;

const protocolVersionSchema = patternedString(
  "^[0-9]+\\.[0-9]+$",
  /^[0-9]+\.[0-9]+$/,
);
const attributionSchema = object({ label: optional(boundedString(80)) });
const clientSchema = object({ name: stringSchema, version: stringSchema });
const replayOutcomeSchema = enumeration("ok", "cursor_off_branch");
const replayResultSchema = object({
  replayId: stringSchema,
  outcome: replayOutcomeSchema,
  from: cursorSchema,
  through: cursorSchema,
  forkPoint: optional(cursorSchema),
});
const leaseHolderSchema = object({
  connectionId: stringSchema,
  attachmentId: stringSchema,
});
const leaseGrantSchema = object({
  leaseId: stringSchema,
  holder: leaseHolderSchema,
  generation: nonNegativeInteger,
  expiresAt: timestamp,
  ttlMs: positiveInteger,
});
const queuedInputResultSchema = object({
  queued: literal(true),
  inputId: stringSchema,
});

const operationSource = {
  hello: operation({
    session: "forbidden",
    params: object({
      protocol: protocolVersionSchema,
      client: clientSchema,
      capabilities: optional(array(stringSchema)),
    }),
    result: object({
      protocol: protocolVersionSchema,
      daemonVersion: stringSchema,
      sdkVersion: stringSchema,
      connectionId: stringSchema,
      maxInboundRequestBytes: positiveInteger,
      keepaliveMs: positiveInteger,
    }),
    errorGroups: ["request"],
    extraErrors: ["protocol_mismatch"],
  }),
  list: operation({
    session: "forbidden",
    params: object({
      phase: optional(array(observedPhaseSchema)),
      cwd: optional(stringSchema),
    }),
    result: object({ sessions: array(sessionSummarySchema) }),
    errorGroups: ["request"],
    extraErrors: [],
  }),
  open: operation({
    session: "forbidden",
    params: union(
      object({
        sessionId: stringSchema,
        cwdOverride: optional(stringSchema),
        name: optional(stringSchema),
      }),
      object({
        path: stringSchema,
        cwdOverride: optional(stringSchema),
        name: optional(stringSchema),
      }),
    ),
    result: object({ session: sessionSummarySchema, created: literal(false) }),
    errorGroups: ["request", "registrationLock"],
    extraErrors: [
      "unknown_session",
      "duplicate_session",
      "path_mismatch",
      "gone",
      "sdk_incompatible",
    ],
  }),
  create: operation({
    session: "forbidden",
    params: object({
      cwd: stringSchema,
      name: optional(stringSchema),
      sessionId: optional(stringSchema),
      sleepAfterMs: optional(nonNegativeInteger),
    }),
    result: object({ session: sessionSummarySchema, created: literal(true) }),
    errorGroups: ["request", "registrationLock"],
    extraErrors: ["duplicate_session", "sdk_incompatible"],
  }),
  attach: operation({
    session: "required",
    params: object({
      fromCursor: optional(nullable(cursorSchema)),
      live: optional(booleanSchema),
    }),
    result: object({
      attachmentId: stringSchema,
      session: sessionSummarySchema,
      replay: replayResultSchema,
    }),
    errorGroups: ["request", "session"],
    extraErrors: ["gone", "stale_epoch", "cursor_unknown", "queue_full"],
  }),
  detach: operation({
    session: "required",
    params: object({ attachmentId: stringSchema }),
    result: object({ detached: literal(true) }),
    errorGroups: ["request", "session", "attachment"],
    extraErrors: [],
  }),
  replay: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      fromCursor: nullable(cursorSchema),
      throughEntryId: optional(stringSchema),
    }),
    result: replayResultSchema,
    errorGroups: ["request", "session", "attachment"],
    extraErrors: [
      "stale_epoch",
      "cursor_unknown",
      "cursor_off_branch",
      "queue_full",
    ],
  }),
  prompt: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      leaseId: stringSchema,
      generation: nonNegativeInteger,
      idempotencyKey: stringSchema,
      text: stringSchema,
      whenBusy: enumeration("reject", "queue"),
      attribution: optional(attributionSchema),
    }),
    result: union(
      object({
        outcome: literal("accepted"),
        disposition: enumeration("started", "queued"),
        promptId: stringSchema,
        generation: nonNegativeInteger,
      }),
      object({ outcome: literal("known"), status: promptStatusResultSchema }),
    ),
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
      "driver",
    ],
    extraErrors: ["busy", "rejected", "idempotency_conflict"],
  }),
  prompt_status: operation({
    session: "required",
    params: union(
      object({ promptId: stringSchema }),
      object({ idempotencyKey: stringSchema }),
    ),
    result: promptStatusResultSchema,
    errorGroups: ["request", "session"],
    extraErrors: [],
  }),
  steer: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      generation: nonNegativeInteger,
      text: stringSchema,
      attribution: optional(attributionSchema),
    }),
    result: queuedInputResultSchema,
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
    ],
    extraErrors: ["invalid_state", "rejected"],
  }),
  follow_up: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      generation: nonNegativeInteger,
      text: stringSchema,
      attribution: optional(attributionSchema),
    }),
    result: queuedInputResultSchema,
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
    ],
    extraErrors: ["invalid_state", "rejected"],
  }),
  abort: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      leaseId: stringSchema,
      generation: nonNegativeInteger,
      reason: optional(stringSchema),
    }),
    result: object({
      aborted: booleanSchema,
      cursor: cursorSchema,
      generation: nonNegativeInteger,
    }),
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
      "driver",
    ],
    extraErrors: ["invalid_state"],
  }),
  lease: operation({
    session: "required",
    params: union(
      object({
        action: literal("acquire"),
        attachmentId: stringSchema,
        generation: nonNegativeInteger,
        ttlMs: optional(positiveInteger),
      }),
      object({
        action: literal("heartbeat"),
        attachmentId: stringSchema,
        leaseId: stringSchema,
        generation: nonNegativeInteger,
      }),
      object({
        action: literal("release"),
        attachmentId: stringSchema,
        leaseId: stringSchema,
        generation: nonNegativeInteger,
      }),
      object({
        action: literal("takeover"),
        attachmentId: stringSchema,
        generation: nonNegativeInteger,
        ttlMs: optional(positiveInteger),
        reason: stringSchema,
      }),
    ),
    result: union(
      leaseGrantSchema,
      object({
        leaseId: stringSchema,
        generation: nonNegativeInteger,
        expiresAt: timestamp,
      }),
      object({ released: literal(true) }),
    ),
    errorGroups: ["request", "session", "attachment", "generation"],
    extraErrors: ["lease_held", "no_lease", "lease_expired"],
  }),
  ui_answer: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      leaseId: stringSchema,
      generation: nonNegativeInteger,
      questionId: stringSchema,
      answer: union(
        object({ value: stringSchema }),
        object({ confirmed: booleanSchema }),
        object({ cancelled: literal(true) }),
      ),
    }),
    result: object({ answered: literal(true), questionId: stringSchema }),
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
      "driver",
    ],
    extraErrors: ["unknown_question", "invalid_ui_answer"],
  }),
  sleep: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      generation: nonNegativeInteger,
      leaseId: optional(stringSchema),
      reason: optional(stringSchema),
    }),
    result: object({ slept: literal(true), session: sessionSummarySchema }),
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "awakeHostMutation",
      "driver",
    ],
    extraErrors: ["already_asleep", "busy", "invalid_state"],
  }),
  wake: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      generation: nonNegativeInteger,
      reason: optional(stringSchema),
    }),
    result: object({ woke: booleanSchema, session: sessionSummarySchema }),
    errorGroups: ["request", "session", "attachment", "generation"],
    extraErrors: [
      "gone",
      "path_mismatch",
      "sdk_incompatible",
      "external_writer",
    ],
  }),
  recover: operation({
    session: "required",
    params: object({
      attachmentId: stringSchema,
      generation: nonNegativeInteger,
      leaseId: optional(stringSchema),
    }),
    result: object({
      recovered: literal(true),
      closedPromptIds: array(stringSchema),
      session: sessionSummarySchema,
    }),
    errorGroups: [
      "request",
      "session",
      "attachment",
      "generation",
      "driver",
      "registrationLock",
    ],
    extraErrors: [
      "invalid_state",
      "gone",
      "path_mismatch",
      "sdk_incompatible",
      "external_writer",
    ],
  }),
  status: operation({
    session: "optional",
    params: object({ verbose: optional(booleanSchema) }),
    result: union(
      object({
        daemon: object({
          pid: nonNegativeInteger,
          startedAt: timestamp,
          version: stringSchema,
          sdkVersion: stringSchema,
          protocol: protocolVersionSchema,
          socket: stringSchema,
          launchPath: optional(stringSchema),
        }),
        counts: jsonObject,
        sessions: optional(array(sessionSummarySchema)),
      }),
      object({
        session: sessionSummarySchema,
        lease: optional(
          object({ held: booleanSchema, expiresAt: optional(timestamp) }),
        ),
        readers: nonNegativeInteger,
      }),
    ),
    errorGroups: ["request", "session"],
    extraErrors: [],
  }),
  shutdown: operation({
    session: "forbidden",
    params: object({ graceMs: optional(nonNegativeInteger), ifIdle: optional(booleanSchema) }),
    result: object({ accepted: literal(true), deadline: timestamp }),
    errorGroups: ["request"],
    extraErrors: ["shutdown_in_progress", "busy"],
  }),
} as const;

export const OPERATIONS = keysOf(operationSource);
export type Operation = (typeof OPERATIONS)[number];

export type OperationParams<O extends Operation> = Infer<
  (typeof operationSource)[O]["params"]
>;
export type OperationResult<O extends Operation> = Infer<
  (typeof operationSource)[O]["result"]
>;

type SessionField<S extends SessionRequirement> = S extends "required"
  ? { session: string }
  : S extends "optional"
    ? { session?: string }
    : { session?: never };

type RequestFor<O extends Operation> = {
  t: "req";
  id: string;
  op: O;
  params: OperationParams<O>;
} & SessionField<(typeof operationSource)[O]["session"]>;

export type RequestFrame<O extends Operation = Operation> = O extends Operation
  ? RequestFor<O>
  : never;

function requestSchemaFor(
  operationName: Operation,
  definition: OperationDefinition,
) {
  const base = {
    t: literal("req"),
    id: stringSchema,
    op: literal(operationName),
    params: definition.params,
  } as const;
  if (definition.session === "required") {
    return object({ ...base, session: stringSchema });
  }
  if (definition.session === "optional") {
    return object({ ...base, session: optional(stringSchema) });
  }
  return object(base);
}

const requestSchemas = Object.fromEntries(
  OPERATIONS.map((name) => [name, requestSchemaFor(name, operationSource[name])]),
) as unknown as Readonly<Record<Operation, Schema<RequestFrame>>>;
const requestFrameSchema = unionFromRecord(requestSchemas);

function collectOperationErrors(
  definition: OperationDefinition,
): readonly ErrorCode[] {
  const result = new Set<ErrorCode>();
  for (const group of definition.errorGroups) {
    for (const code of ERROR_GROUPS[group]) result.add(code);
  }
  for (const code of definition.extraErrors) result.add(code);
  return Object.freeze([...result]);
}

export const OPERATION_ERROR_CODES = Object.freeze(
  Object.fromEntries(
    OPERATIONS.map((name) => [name, collectOperationErrors(operationSource[name])]),
  ) as Record<Operation, readonly ErrorCode[]>,
);

const operationErrorSchema = unionFromRecord(
  Object.fromEntries(
    OPERATIONS.map((name) => [
      name,
      object({
        op: literal(name),
        errorCode: enumFromValues(
          OPERATION_ERROR_CODES[name] as [ErrorCode, ...ErrorCode[]],
        ),
      }),
    ]),
  ) as unknown as Record<
    Operation,
    Schema<{ op: Operation; errorCode: ErrorCode }>
  >,
);

const errorSchema = object({
  code: errorCodeSchema,
  message: stringSchema,
  details: optional(jsonValue),
});
const successFrameSchema = object({
  t: literal("res"),
  id: stringSchema,
  ok: literal(true),
  result: jsonValue,
});
const failureFrameSchema = object({
  t: literal("res"),
  id: stringSchema,
  ok: literal(false),
  error: errorSchema,
});

export type SuccessFrame<O extends Operation = Operation> = {
  t: "res";
  id: string;
  ok: true;
  result: OperationResult<O>;
};
export type FailureFrame = Infer<typeof failureFrameSchema>;
export type ResponseFrame<O extends Operation = Operation> =
  | SuccessFrame<O>
  | FailureFrame;

const streamBase = {
  t: literal("ev"),
  session: stringSchema,
  attachmentId: stringSchema,
  generation: nonNegativeInteger,
  epoch: nonNegativeInteger,
} as const;
const liveStreamBase = {
  ...streamBase,
  seq: nonNegativeInteger,
} as const;

const liveEntryFrameSchema = object({
  ...liveStreamBase,
  kind: literal("entry"),
  cursor: cursorSchema,
  entry: jsonObject,
  origin: literal("live"),
});
const replayEntryFrameSchema = object({
  ...streamBase,
  kind: literal("entry"),
  cursor: cursorSchema,
  entry: jsonObject,
  origin: literal("replay"),
  replayId: stringSchema,
  index: nonNegativeInteger,
});
const entryFrameSchema = projectUnionDiscriminator(
  union(liveEntryFrameSchema, replayEntryFrameSchema),
  "kind",
  "entry",
);

const emptyDataSchema = object({});
const messageDataSchema = object({ message: jsonObject });

const eventSource = {
  agent_start: emptyDataSchema,
  agent_end: object({
    messages: array(jsonObject),
    willRetry: booleanSchema,
  }),
  turn_start: emptyDataSchema,
  turn_end: object({
    message: jsonObject,
    toolResults: array(jsonObject),
  }),
  message_start: messageDataSchema,
  message_update: object({
    message: jsonObject,
    assistantMessageEvent: jsonObject,
  }),
  message_end: messageDataSchema,
  tool_execution_start: object({
    toolCallId: stringSchema,
    toolName: stringSchema,
    args: jsonValue,
  }),
  tool_execution_update: object({
    toolCallId: stringSchema,
    toolName: stringSchema,
    args: jsonValue,
    partialResult: jsonValue,
  }),
  tool_execution_end: object({
    toolCallId: stringSchema,
    toolName: stringSchema,
    result: jsonValue,
    isError: booleanSchema,
  }),
  agent_settled: emptyDataSchema,
  queue_update: object({
    steering: array(stringSchema),
    followUp: array(stringSchema),
  }),
  compaction_start: object({
    reason: enumeration("manual", "threshold", "overflow"),
  }),
  entry_appended: object({ entry: jsonObject }),
  session_info_changed: object({ name: optional(stringSchema) }),
  thinking_level_changed: object({
    level: enumeration("off", "minimal", "low", "medium", "high", "xhigh", "max"),
  }),
  compaction_end: object({
    reason: enumeration("manual", "threshold", "overflow"),
    result: optional(jsonValue),
    aborted: booleanSchema,
    willRetry: booleanSchema,
    errorMessage: optional(stringSchema),
  }),
  auto_retry_start: object({
    attempt: positiveInteger,
    maxAttempts: positiveInteger,
    delayMs: nonNegativeInteger,
    errorMessage: stringSchema,
  }),
  auto_retry_end: object({
    success: booleanSchema,
    attempt: positiveInteger,
    finalError: optional(stringSchema),
  }),
  summarization_retry_scheduled: object({
    attempt: positiveInteger,
    maxAttempts: positiveInteger,
    delayMs: nonNegativeInteger,
    errorMessage: stringSchema,
  }),
  summarization_retry_attempt_start: union(
    object({ source: literal("branchSummary") }),
    object({
      source: literal("compaction"),
      reason: enumeration("manual", "threshold", "overflow"),
    }),
  ),
  summarization_retry_finished: emptyDataSchema,
  bash_execution_update: object({
    id: optional(stringSchema),
    delta: stringSchema,
  }),
} as const;

export const EVENT_TYPES = keysOf(eventSource);
export type EventType = (typeof EVENT_TYPES)[number];

type EventFrameFor<E extends EventType> = Infer<
  ReturnType<typeof eventFrameSchemaFor<E>>
>;

function eventFrameSchemaFor<const E extends EventType>(eventType: E) {
  return object({
    ...liveStreamBase,
    kind: literal("event"),
    eventType: literal(eventType),
    data: eventSource[eventType],
    durable: literal(false),
  });
}

const eventFrameVariants = Object.fromEntries(
  EVENT_TYPES.map((eventType) => [eventType, eventFrameSchemaFor(eventType)]),
) as unknown as { readonly [E in EventType]: Schema<EventFrameFor<E>> };
const eventFrameSchema = projectUnionDiscriminator(
  unionFromRecord(eventFrameVariants),
  "kind",
  "event",
);

const sourceBackedDaemonFrame = <
  const Name extends string,
  const Data extends AnySchema,
>(name: Name, data: Data) =>
  object({
    ...liveStreamBase,
    kind: literal("daemon"),
    name: literal(name),
    data,
    sourceEntryId: stringSchema,
  });

const liveControlDaemonFrame = <
  const Name extends string,
  const Data extends AnySchema,
>(name: Name, data: Data) =>
  object({
    ...liveStreamBase,
    kind: literal("daemon"),
    name: literal(name),
    data,
  });

const readerControlDaemonFrame = <const Name extends string>(name: Name) =>
  object({
    ...streamBase,
    kind: literal("daemon"),
    name: literal(name),
    data: jsonObject,
  });

const daemonFrameSource = {
  phase: sourceBackedDaemonFrame("phase", jsonObject),
  attention: sourceBackedDaemonFrame("attention", jsonObject),
  lease: sourceBackedDaemonFrame("lease", jsonObject),
  prompt: sourceBackedDaemonFrame("prompt", promptOutcomeSchema),
  replay_start: readerControlDaemonFrame("replay_start"),
  replay_end: readerControlDaemonFrame("replay_end"),
  keepalive: liveControlDaemonFrame(
    "keepalive",
    object({
      cursor: cursorSchema,
      observedPhase: observedPhaseSchema,
      attention: attentionSchema,
      pendingQuestionIds: array(stringSchema),
    }),
  ),
  sleep: sourceBackedDaemonFrame("sleep", jsonObject),
  wake: sourceBackedDaemonFrame("wake", jsonObject),
  restored: sourceBackedDaemonFrame("restored", jsonObject),
  external_writer: liveControlDaemonFrame("external_writer", jsonObject),
  ui_notice: liveControlDaemonFrame("ui_notice", jsonObject),
} as const;

export const DAEMON_FRAME_NAMES = keysOf(daemonFrameSource);
const daemonFrameSchema = projectUnionDiscriminator(
  unionFromRecord(daemonFrameSource),
  "kind",
  "daemon",
);

const uiFrameCommon = {
  ...liveStreamBase,
  kind: literal("ui_request"),
  questionId: stringSchema,
  title: optional(stringSchema),
  timeoutMs: optional(positiveInteger),
} as const;
const uiRequestVariants = {
  select: object({
    ...uiFrameCommon,
    method: literal("select"),
    options: optional(array(stringSchema)),
  }),
  confirm: object({
    ...uiFrameCommon,
    method: literal("confirm"),
    message: optional(stringSchema),
  }),
  input: object({
    ...uiFrameCommon,
    method: literal("input"),
    placeholder: optional(stringSchema),
    prefill: optional(stringSchema),
  }),
  editor: object({
    ...uiFrameCommon,
    method: literal("editor"),
    prefill: optional(stringSchema),
  }),
} as const;
const uiRequestFrameSchema = projectUnionDiscriminator(
  unionFromRecord(uiRequestVariants),
  "kind",
  "ui_request",
);

const gapFrameSchema = object({
  ...streamBase,
  kind: literal("gap"),
  reason: enumeration("reader_overflow", "socket_backpressure"),
  lost: object({
    fromSeq: nonNegativeInteger,
    toSeq: nonNegativeInteger,
  }),
  resumeFrom: cursorSchema,
  demoted: literal(true),
});

const streamErrorFrameSchema = object({
  ...streamBase,
  kind: literal("error"),
  error: errorSchema,
  fatal: booleanSchema,
});

const streamSource = {
  entry: entryFrameSchema,
  event: eventFrameSchema,
  daemon: daemonFrameSchema,
  ui_request: uiRequestFrameSchema,
  gap: gapFrameSchema,
  error: streamErrorFrameSchema,
} as const;

export const STREAM_KINDS = keysOf(streamSource);
export type StreamKind = (typeof STREAM_KINDS)[number];
const streamFrameSchema = unionFromRecord(streamSource);
export type StreamFrame = Infer<typeof streamFrameSchema>;

const customEntryDataSource = {
  "pi-daemon/restored": object({
    v: literal(1),
    daemonInstanceId: stringSchema,
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    interrupted: literal(true),
    previousPhase: nullable(enumeration("working", "blocked")),
    unfinishedPromptIds: array(stringSchema),
    at: timestamp,
  }),
  "pi-daemon/lifecycle": object({
    v: literal(1),
    action: enumeration("created", "woke", "sleeping", "slept", "failed", "gone"),
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    reason: boundedString(80),
    sleepAfterMs: optional(nonNegativeInteger),
    at: timestamp,
  }),
  "pi-daemon/phase": object({
    v: literal(1),
    from: phaseSchema,
    to: phaseSchema,
    attention: attentionSchema,
    pendingQuestionIds: array(stringSchema),
    reason: stringSchema,
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    at: timestamp,
  }),
  "pi-daemon/lease": object({
    v: literal(1),
    action: enumeration(
      "acquired",
      "released",
      "expired",
      "taken_over",
      "disconnected",
    ),
    leaseId: stringSchema,
    actorId: stringSchema,
    previousLeaseId: optional(stringSchema),
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    expiresAt: optional(timestamp),
    at: timestamp,
  }),
  "pi-daemon/prompt-claim": object({
    v: literal(1),
    promptId: stringSchema,
    idempotencyKey: stringSchema,
    payloadSha256: stringSchema,
    clientId: stringSchema,
    attribution: object({ actorId: stringSchema }),
    acceptedAt: timestamp,
  }),
  "pi-daemon/prompt-outcome": unionFromRecord({
    settled: object({
      v: literal(1),
      promptId: stringSchema,
      finalEntryId: optional(nullable(stringSchema)),
      stopReason: optional(stringSchema),
      settledAt: timestamp,
      outcome: settledPromptOutcome,
    }),
    aborted: object({
      v: literal(1),
      promptId: stringSchema,
      finalEntryId: optional(nullable(stringSchema)),
      stopReason: optional(stringSchema),
      settledAt: timestamp,
      outcome: abortedPromptOutcome,
      errorCode: abortedPromptOutcomeError,
    }),
    failed: object({
      v: literal(1),
      promptId: stringSchema,
      finalEntryId: optional(nullable(stringSchema)),
      stopReason: optional(stringSchema),
      settledAt: timestamp,
      outcome: failedPromptOutcome,
      errorCode: failedPromptOutcomeErrorSchema,
    }),
  }),
  "pi-daemon/input": object({
    v: literal(1),
    inputId: stringSchema,
    operation: enumeration("steer", "follow_up"),
    actorId: stringSchema,
    contentSha256: stringSchema,
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    at: timestamp,
  }),
  "pi-daemon/ui": object({
    v: literal(1),
    questionId: stringSchema,
    action: enumeration("opened", "answered", "cancelled", "timed_out"),
    method: uiMethodSchema,
    actorId: optional(stringSchema),
    generation: nonNegativeInteger,
    epoch: nonNegativeInteger,
    at: timestamp,
  }),
  "pi-daemon/epoch": object({
    v: literal(1),
    fromEpoch: nonNegativeInteger,
    toEpoch: nonNegativeInteger,
    reason: enumeration("fork", "switch", "restore", "rewind", "navigate"),
    previousLeaf: nullable(stringSchema),
    currentLeaf: nullable(stringSchema),
    forkPoint: nullable(stringSchema),
    at: timestamp,
  }),
} as const;

export const CUSTOM_ENTRY_TYPES = keysOf(customEntryDataSource);
export type CustomEntryType = (typeof CUSTOM_ENTRY_TYPES)[number];
export type CustomEntryData<T extends CustomEntryType> = Infer<
  (typeof customEntryDataSource)[T]
>;
export type DaemonCustomEntry<T extends CustomEntryType = CustomEntryType> =
  T extends CustomEntryType
    ? { type: "custom"; customType: T; data: CustomEntryData<T> }
    : never;

function customEntrySchemaFor<const T extends CustomEntryType>(customType: T) {
  return object({
    type: literal("custom"),
    customType: literal(customType),
    data: customEntryDataSource[customType],
  });
}

const customEntrySchemas = Object.fromEntries(
  CUSTOM_ENTRY_TYPES.map((customType) => [
    customType,
    customEntrySchemaFor(customType),
  ]),
) as unknown as Readonly<
  Record<CustomEntryType, Schema<DaemonCustomEntry>>
>;
const customEntrySchema = unionFromRecord(customEntrySchemas);

const operationSchema = enumFromValues(
  OPERATIONS as [Operation, ...Operation[]],
);
const promptOutcomeNameSchema = enumFromValues(
  PROMPT_OUTCOMES as [PromptOutcomeName, ...PromptOutcomeName[]],
);
const streamKindSchema = enumFromValues(
  STREAM_KINDS as [StreamKind, ...StreamKind[]],
);
const customEntryTypeSchema = enumFromValues(
  CUSTOM_ENTRY_TYPES as [CustomEntryType, ...CustomEntryType[]],
);

const protocolFrameSchema = union(
  requestFrameSchema,
  successFrameSchema,
  failureFrameSchema,
  streamFrameSchema,
);

export type ProtocolFrame =
  | RequestFrame
  | SuccessFrame
  | FailureFrame
  | StreamFrame;

export const PROTOCOL_VERSION = "1.0" as const;

export const PROTOCOL_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://caair.dev/schemas/pi-daemon/protocol-${PROTOCOL_VERSION}.schema.json`,
  title: `pi-daemon protocol ${PROTOCOL_VERSION}`,
  oneOf: [
    { $ref: "#/$defs/RequestFrame" },
    { $ref: "#/$defs/SuccessFrame" },
    { $ref: "#/$defs/FailureFrame" },
    { $ref: "#/$defs/StreamFrame" },
  ],
  $defs: {
    JsonValue: JSON_VALUE_DEFINITION,
    Cursor: cursorSchema.jsonSchema,
    SessionSummary: sessionSummarySchema.jsonSchema,
    Operation: operationSchema.jsonSchema,
    ErrorCode: errorCodeSchema.jsonSchema,
    PromptOutcomeName: promptOutcomeNameSchema.jsonSchema,
    PromptOutcomeErrorCode: promptOutcomeErrorCodeSchema.jsonSchema,
    PromptOutcome: promptOutcomeSchema.jsonSchema,
    PromptStatusResult: promptStatusResultSchema.jsonSchema,
    OperationError: operationErrorSchema.jsonSchema,
    RequestFrame: requestFrameSchema.jsonSchema,
    SuccessFrame: successFrameSchema.jsonSchema,
    FailureFrame: failureFrameSchema.jsonSchema,
    StreamKind: streamKindSchema.jsonSchema,
    StreamFrame: streamFrameSchema.jsonSchema,
    CustomEntryType: customEntryTypeSchema.jsonSchema,
    DaemonCustomEntry: customEntrySchema.jsonSchema,
  },
} as const;

export const isRequestFrame = requestFrameSchema.is;
export const isSuccessFrame = successFrameSchema.is;
export const isFailureFrame = failureFrameSchema.is;
export const isStreamFrame = streamFrameSchema.is;
export const isDaemonCustomEntry = customEntrySchema.is;
export const isProtocolFrame = protocolFrameSchema.is;
export const isPromptOutcome = promptOutcomeSchema.is;
export const isPromptStatusResult = promptStatusResultSchema.is;

export function isOperationResult<O extends Operation>(
  operationName: O,
  value: unknown,
): value is OperationResult<O> {
  return operationSource[operationName].result.is(value);
}

export function isCustomEntryData<T extends CustomEntryType>(
  customType: T,
  value: unknown,
): value is CustomEntryData<T> {
  return customEntryDataSource[customType].is(value);
}

export type { JsonObject, JsonValue };
