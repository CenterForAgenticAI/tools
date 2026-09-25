// VENDORED build-time type fallback for the OPTIONAL @caair/pi-daemon peer (#35 / #470).
// Copied verbatim from @caair/pi-daemon dist .d.ts. Used ONLY when the package is
// absent (tsconfig `paths` resolves the real node_modules types first, these second),
// so pi-delegate builds/type-checks without the package. Regenerate by re-copying
// @caair/pi-daemon/dist/{client,protocol}/*.d.ts when the daemon protocol changes.
// Do not hand-edit.
import { type Infer, type JsonObject, type JsonValue, type Schema } from "./schema.js";
declare const cursorSchema: Schema<{
    entryId: string | null;
    epoch: number;
}, {
    readonly type: "object";
    readonly properties: {
        readonly entryId: {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        };
        readonly epoch: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: number;
        };
    };
    readonly required: readonly ("entryId" | "epoch")[];
    readonly additionalProperties: false;
}>;
declare const runtimeStateSchema: Schema<"awake" | "asleep", {
    readonly type: "string";
    readonly enum: readonly ["awake", "asleep"];
}>;
declare const phaseSchema: Schema<"idle" | "working" | "blocked" | "failed" | "gone", {
    readonly type: "string";
    readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
}>;
declare const observedPhaseSchema: Schema<"asleep" | "idle" | "working" | "blocked" | "failed" | "gone", {
    readonly type: "string";
    readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
}>;
declare const attentionSchema: Schema<"failed" | "none" | "question" | "interrupted", {
    readonly type: "string";
    readonly enum: readonly ["none", "question", "failed", "interrupted"];
}>;
declare const uiMethodSchema: Schema<"select" | "confirm" | "input" | "editor", {
    readonly type: "string";
    readonly enum: readonly ["select", "confirm", "input", "editor"];
}>;
declare const sessionSummarySchema: Schema<{
    epoch: number;
    pendingQuestions: {
        questionId: string;
        method: "select" | "confirm" | "input" | "editor";
        title?: string;
    }[];
    heartbeat: {
        at: string;
        seq: number;
    };
    sessionId: string;
    sessionFile: string;
    cwd: string;
    runtime: "awake" | "asleep";
    phase: "idle" | "working" | "blocked" | "failed" | "gone";
    observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
    attention: "failed" | "none" | "question" | "interrupted";
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    name?: string;
}, {
    readonly type: "object";
    readonly properties: {
        readonly sessionId: {
            readonly type: "string";
        };
        readonly sessionFile: {
            readonly type: "string";
        };
        readonly cwd: {
            readonly type: "string";
        };
        readonly name: {
            readonly type: "string";
        };
        readonly runtime: {
            readonly type: "string";
            readonly enum: readonly ["awake", "asleep"];
        };
        readonly phase: {
            readonly type: "string";
            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
        };
        readonly observedPhase: {
            readonly type: "string";
            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
        };
        readonly attention: {
            readonly type: "string";
            readonly enum: readonly ["none", "question", "failed", "interrupted"];
        };
        readonly generation: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: number;
        };
        readonly epoch: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: number;
        };
        readonly cursor: {
            readonly type: "object";
            readonly properties: {
                readonly entryId: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly epoch: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
            };
            readonly required: readonly ("entryId" | "epoch")[];
            readonly additionalProperties: false;
        };
        readonly pendingQuestions: {
            readonly type: "array";
            readonly items: Readonly<Record<string, unknown>>;
        };
        readonly heartbeat: {
            readonly type: "object";
            readonly properties: {
                readonly seq: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly at: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
            };
            readonly required: readonly ("at" | "seq")[];
            readonly additionalProperties: false;
        };
    };
    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
    readonly additionalProperties: false;
}>;
export type Cursor = Infer<typeof cursorSchema>;
export type RuntimeState = Infer<typeof runtimeStateSchema>;
export type Phase = Infer<typeof phaseSchema>;
export type ObservedPhase = Infer<typeof observedPhaseSchema>;
export type Attention = Infer<typeof attentionSchema>;
export type UiMethod = Infer<typeof uiMethodSchema>;
export type SessionSummary = Infer<typeof sessionSummarySchema>;
export declare const PROMPT_OUTCOMES: readonly ("failed" | "settled" | "aborted")[];
export declare const PROMPT_OUTCOME_ERROR_CODES: readonly ["aborted", "interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
declare const promptOutcomeSchema: Schema<{
    outcome: "settled";
} | {
    outcome: "aborted";
    errorCode: "aborted";
} | {
    outcome: "failed";
    errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
}, {
    readonly oneOf: readonly ({
        readonly type: "object";
        readonly properties: {
            readonly outcome: {
                readonly const: "settled";
            };
        };
        readonly required: readonly "outcome"[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly outcome: {
                readonly const: "aborted";
            };
            readonly errorCode: {
                readonly const: "aborted";
            };
        };
        readonly required: readonly ("outcome" | "errorCode")[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly outcome: {
                readonly const: "failed";
            };
            readonly errorCode: {
                readonly type: "string";
                readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
            };
        };
        readonly required: readonly ("outcome" | "errorCode")[];
        readonly additionalProperties: false;
    })[];
}>;
declare const promptOutcomeErrorCodeSchema: Schema<"interrupted" | "aborted" | "external_writer" | "provider_error" | "sdk_error" | "rejected", {
    readonly type: "string";
    readonly enum: ["aborted", "interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
}>;
export type PromptOutcome = Infer<typeof promptOutcomeSchema>;
export type PromptOutcomeName = (typeof PROMPT_OUTCOMES)[number];
export type PromptOutcomeErrorCode = Infer<typeof promptOutcomeErrorCodeSchema>;
declare const promptStatusResultSchema: Schema<{
    state: "pending";
    promptId?: string;
    acceptedAt?: string;
    reason?: "external_writer";
} | {
    state: "unknown";
} | {
    state: "settled";
    terminalOutcome: "settled";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
} | {
    errorCode: "aborted";
    state: "aborted";
    terminalOutcome: "aborted";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
} | {
    errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
    state: "failed";
    terminalOutcome: "failed";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
}, {
    readonly oneOf: readonly ({
        readonly type: "object";
        readonly properties: {
            readonly state: {
                readonly const: "pending";
            };
            readonly promptId: {
                readonly type: "string";
            };
            readonly acceptedAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly reason: {
                readonly const: "external_writer";
            };
        };
        readonly required: readonly "state"[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly state: {
                readonly const: "unknown";
            };
        };
        readonly required: readonly "state"[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly state: {
                readonly const: "settled";
            };
            readonly promptId: {
                readonly type: "string";
            };
            readonly terminalOutcome: {
                readonly const: "settled";
            };
            readonly acceptedAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly settledAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly finalCursor: {
                readonly type: "object";
                readonly properties: {
                    readonly entryId: {
                        readonly oneOf: Readonly<Record<string, unknown>>[];
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("entryId" | "epoch")[];
                readonly additionalProperties: false;
            };
        };
        readonly required: readonly ("state" | "terminalOutcome")[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly state: {
                readonly const: "aborted";
            };
            readonly promptId: {
                readonly type: "string";
            };
            readonly terminalOutcome: {
                readonly const: "aborted";
            };
            readonly acceptedAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly settledAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly finalCursor: {
                readonly type: "object";
                readonly properties: {
                    readonly entryId: {
                        readonly oneOf: Readonly<Record<string, unknown>>[];
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("entryId" | "epoch")[];
                readonly additionalProperties: false;
            };
            readonly errorCode: {
                readonly const: "aborted";
            };
        };
        readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly state: {
                readonly const: "failed";
            };
            readonly promptId: {
                readonly type: "string";
            };
            readonly terminalOutcome: {
                readonly const: "failed";
            };
            readonly acceptedAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly settledAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly finalCursor: {
                readonly type: "object";
                readonly properties: {
                    readonly entryId: {
                        readonly oneOf: Readonly<Record<string, unknown>>[];
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("entryId" | "epoch")[];
                readonly additionalProperties: false;
            };
            readonly errorCode: {
                readonly type: "string";
                readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
            };
        };
        readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
        readonly additionalProperties: false;
    })[];
}>;
export type PromptStatusResult = Infer<typeof promptStatusResultSchema>;
export declare const ERROR_CODES: readonly ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
declare const errorCodeSchema: Schema<"asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal", {
    readonly type: "string";
    readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
}>;
export type ErrorCode = Infer<typeof errorCodeSchema>;
export declare const ERROR_GROUPS: {
    readonly frame: readonly ["bad_frame", "frame_too_large"];
    readonly handshake: readonly ["handshake_required", "protocol_mismatch"];
    readonly request: readonly ["invalid_request", "unsupported_op", "unavailable", "internal"];
    readonly session: readonly ["unknown_session"];
    readonly registrationLock: readonly ["session_locked"];
    readonly attachment: readonly ["not_attached"];
    readonly generation: readonly ["stale_generation"];
    readonly awakeHostMutation: readonly ["asleep", "external_writer"];
    readonly driver: readonly ["no_lease", "lease_expired"];
};
type SessionRequirement = "required" | "optional" | "forbidden";
declare const operationSource: {
    readonly hello: {
        readonly session: "forbidden";
        readonly params: Schema<{
            protocol: string;
            client: {
                name: string;
                version: string;
            };
            capabilities?: string[];
        }, {
            readonly type: "object";
            readonly properties: {
                readonly protocol: {
                    readonly type: "string";
                    readonly pattern: "^[0-9]+\\.[0-9]+$";
                };
                readonly client: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly version: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ("name" | "version")[];
                    readonly additionalProperties: false;
                };
                readonly capabilities: {
                    readonly type: "array";
                    readonly items: Readonly<Record<string, unknown>>;
                };
            };
            readonly required: readonly ("protocol" | "client")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            connectionId: string;
            protocol: string;
            daemonVersion: string;
            sdkVersion: string;
            maxInboundRequestBytes: number;
            keepaliveMs: number;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly protocol: {
                    readonly type: "string";
                    readonly pattern: "^[0-9]+\\.[0-9]+$";
                };
                readonly daemonVersion: {
                    readonly type: "string";
                };
                readonly sdkVersion: {
                    readonly type: "string";
                };
                readonly connectionId: {
                    readonly type: "string";
                };
                readonly maxInboundRequestBytes: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: number;
                };
                readonly keepaliveMs: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: number;
                };
            };
            readonly required: readonly ("connectionId" | "protocol" | "daemonVersion" | "sdkVersion" | "maxInboundRequestBytes" | "keepaliveMs")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request"];
        readonly extraErrors: readonly ["protocol_mismatch"];
    };
    readonly list: {
        readonly session: "forbidden";
        readonly params: Schema<{
            cwd?: string;
            phase?: ("asleep" | "idle" | "working" | "blocked" | "failed" | "gone")[];
        }, {
            readonly type: "object";
            readonly properties: {
                readonly phase: {
                    readonly type: "array";
                    readonly items: Readonly<Record<string, unknown>>;
                };
                readonly cwd: {
                    readonly type: "string";
                };
            };
            readonly required: readonly never[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            sessions: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            }[];
        }, {
            readonly type: "object";
            readonly properties: {
                readonly sessions: {
                    readonly type: "array";
                    readonly items: Readonly<Record<string, unknown>>;
                };
            };
            readonly required: readonly "sessions"[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request"];
        readonly extraErrors: readonly [];
    };
    readonly open: {
        readonly session: "forbidden";
        readonly params: Schema<{
            sessionId: string;
            name?: string;
            cwdOverride?: string;
        } | {
            path: string;
            name?: string;
            cwdOverride?: string;
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            created: false;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
                readonly created: {
                    readonly const: false;
                };
            };
            readonly required: readonly ("session" | "created")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "registrationLock"];
        readonly extraErrors: readonly ["unknown_session", "duplicate_session", "path_mismatch", "gone", "sdk_incompatible"];
    };
    readonly create: {
        readonly session: "forbidden";
        readonly params: Schema<{
            cwd: string;
            name?: string;
            sessionId?: string;
            sleepAfterMs?: number;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly cwd: {
                    readonly type: "string";
                };
                readonly name: {
                    readonly type: "string";
                };
                readonly sessionId: {
                    readonly type: "string";
                };
                readonly sleepAfterMs: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
            };
            readonly required: readonly "cwd"[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            created: true;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
                readonly created: {
                    readonly const: true;
                };
            };
            readonly required: readonly ("session" | "created")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "registrationLock"];
        readonly extraErrors: readonly ["duplicate_session", "sdk_incompatible"];
    };
    readonly attach: {
        readonly session: "required";
        readonly params: Schema<{
            fromCursor?: {
                entryId: string | null;
                epoch: number;
            } | null;
            live?: boolean;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly fromCursor: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly live: {
                    readonly type: "boolean";
                };
            };
            readonly required: readonly never[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            attachmentId: string;
            replay: {
                outcome: "cursor_off_branch" | "ok";
                replayId: string;
                from: {
                    entryId: string | null;
                    epoch: number;
                };
                through: {
                    entryId: string | null;
                    epoch: number;
                };
                forkPoint?: {
                    entryId: string | null;
                    epoch: number;
                };
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
                readonly replay: {
                    readonly type: "object";
                    readonly properties: {
                        readonly replayId: {
                            readonly type: "string";
                        };
                        readonly outcome: {
                            readonly type: "string";
                            readonly enum: readonly ["ok", "cursor_off_branch"];
                        };
                        readonly from: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly through: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly forkPoint: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("outcome" | "replayId" | "from" | "through")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("session" | "attachmentId" | "replay")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session"];
        readonly extraErrors: readonly ["gone", "stale_epoch", "cursor_unknown", "queue_full"];
    };
    readonly detach: {
        readonly session: "required";
        readonly params: Schema<{
            attachmentId: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly "attachmentId"[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            detached: true;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly detached: {
                    readonly const: true;
                };
            };
            readonly required: readonly "detached"[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment"];
        readonly extraErrors: readonly [];
    };
    readonly replay: {
        readonly session: "required";
        readonly params: Schema<{
            attachmentId: string;
            fromCursor: {
                entryId: string | null;
                epoch: number;
            } | null;
            throughEntryId?: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly fromCursor: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly throughEntryId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("attachmentId" | "fromCursor")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            outcome: "cursor_off_branch" | "ok";
            replayId: string;
            from: {
                entryId: string | null;
                epoch: number;
            };
            through: {
                entryId: string | null;
                epoch: number;
            };
            forkPoint?: {
                entryId: string | null;
                epoch: number;
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly replayId: {
                    readonly type: "string";
                };
                readonly outcome: {
                    readonly type: "string";
                    readonly enum: readonly ["ok", "cursor_off_branch"];
                };
                readonly from: {
                    readonly type: "object";
                    readonly properties: {
                        readonly entryId: {
                            readonly oneOf: Readonly<Record<string, unknown>>[];
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                    };
                    readonly required: readonly ("entryId" | "epoch")[];
                    readonly additionalProperties: false;
                };
                readonly through: {
                    readonly type: "object";
                    readonly properties: {
                        readonly entryId: {
                            readonly oneOf: Readonly<Record<string, unknown>>[];
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                    };
                    readonly required: readonly ("entryId" | "epoch")[];
                    readonly additionalProperties: false;
                };
                readonly forkPoint: {
                    readonly type: "object";
                    readonly properties: {
                        readonly entryId: {
                            readonly oneOf: Readonly<Record<string, unknown>>[];
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                    };
                    readonly required: readonly ("entryId" | "epoch")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("outcome" | "replayId" | "from" | "through")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment"];
        readonly extraErrors: readonly ["stale_epoch", "cursor_unknown", "cursor_off_branch", "queue_full"];
    };
    readonly prompt: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            leaseId: string;
            whenBusy: "reject" | "queue";
            idempotencyKey: string;
            text: string;
            attribution?: {
                label?: string;
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly leaseId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly idempotencyKey: {
                    readonly type: "string";
                };
                readonly text: {
                    readonly type: "string";
                };
                readonly whenBusy: {
                    readonly type: "string";
                    readonly enum: readonly ["reject", "queue"];
                };
                readonly attribution: {
                    readonly type: "object";
                    readonly properties: {
                        readonly label: {
                            readonly type: "string";
                            readonly maxLength: number;
                        };
                    };
                    readonly required: readonly never[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("generation" | "attachmentId" | "leaseId" | "whenBusy" | "idempotencyKey" | "text")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            generation: number;
            outcome: "accepted";
            promptId: string;
            disposition: "queued" | "started";
        } | {
            outcome: "known";
            status: {
                state: "pending";
                promptId?: string;
                acceptedAt?: string;
                reason?: "external_writer";
            } | {
                state: "unknown";
            } | {
                state: "settled";
                terminalOutcome: "settled";
                promptId?: string;
                acceptedAt?: string;
                settledAt?: string;
                finalCursor?: {
                    entryId: string | null;
                    epoch: number;
                };
            } | {
                errorCode: "aborted";
                state: "aborted";
                terminalOutcome: "aborted";
                promptId?: string;
                acceptedAt?: string;
                settledAt?: string;
                finalCursor?: {
                    entryId: string | null;
                    epoch: number;
                };
            } | {
                errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
                state: "failed";
                terminalOutcome: "failed";
                promptId?: string;
                acceptedAt?: string;
                settledAt?: string;
                finalCursor?: {
                    entryId: string | null;
                    epoch: number;
                };
            };
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation", "driver"];
        readonly extraErrors: readonly ["busy", "rejected", "idempotency_conflict"];
    };
    readonly prompt_status: {
        readonly session: "required";
        readonly params: Schema<{
            promptId: string;
        } | {
            idempotencyKey: string;
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly result: Schema<{
            state: "pending";
            promptId?: string;
            acceptedAt?: string;
            reason?: "external_writer";
        } | {
            state: "unknown";
        } | {
            state: "settled";
            terminalOutcome: "settled";
            promptId?: string;
            acceptedAt?: string;
            settledAt?: string;
            finalCursor?: {
                entryId: string | null;
                epoch: number;
            };
        } | {
            errorCode: "aborted";
            state: "aborted";
            terminalOutcome: "aborted";
            promptId?: string;
            acceptedAt?: string;
            settledAt?: string;
            finalCursor?: {
                entryId: string | null;
                epoch: number;
            };
        } | {
            errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
            state: "failed";
            terminalOutcome: "failed";
            promptId?: string;
            acceptedAt?: string;
            settledAt?: string;
            finalCursor?: {
                entryId: string | null;
                epoch: number;
            };
        }, {
            readonly oneOf: readonly ({
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "pending";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly reason: {
                        readonly const: "external_writer";
                    };
                };
                readonly required: readonly "state"[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "unknown";
                    };
                };
                readonly required: readonly "state"[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "settled";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "settled";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                };
                readonly required: readonly ("state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "aborted";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "aborted";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                    readonly errorCode: {
                        readonly const: "aborted";
                    };
                };
                readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "failed";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "failed";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                    readonly errorCode: {
                        readonly type: "string";
                        readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
                    };
                };
                readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            })[];
        }>;
        readonly errorGroups: readonly ["request", "session"];
        readonly extraErrors: readonly [];
    };
    readonly steer: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            text: string;
            attribution?: {
                label?: string;
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly text: {
                    readonly type: "string";
                };
                readonly attribution: {
                    readonly type: "object";
                    readonly properties: {
                        readonly label: {
                            readonly type: "string";
                            readonly maxLength: number;
                        };
                    };
                    readonly required: readonly never[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("generation" | "attachmentId" | "text")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            queued: true;
            inputId: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly queued: {
                    readonly const: true;
                };
                readonly inputId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("queued" | "inputId")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation"];
        readonly extraErrors: readonly ["invalid_state", "rejected"];
    };
    readonly follow_up: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            text: string;
            attribution?: {
                label?: string;
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly text: {
                    readonly type: "string";
                };
                readonly attribution: {
                    readonly type: "object";
                    readonly properties: {
                        readonly label: {
                            readonly type: "string";
                            readonly maxLength: number;
                        };
                    };
                    readonly required: readonly never[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("generation" | "attachmentId" | "text")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            queued: true;
            inputId: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly queued: {
                    readonly const: true;
                };
                readonly inputId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("queued" | "inputId")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation"];
        readonly extraErrors: readonly ["invalid_state", "rejected"];
    };
    readonly abort: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            leaseId: string;
            reason?: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly leaseId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly reason: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("generation" | "attachmentId" | "leaseId")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            generation: number;
            cursor: {
                entryId: string | null;
                epoch: number;
            };
            aborted: boolean;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly aborted: {
                    readonly type: "boolean";
                };
                readonly cursor: {
                    readonly type: "object";
                    readonly properties: {
                        readonly entryId: {
                            readonly oneOf: Readonly<Record<string, unknown>>[];
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                    };
                    readonly required: readonly ("entryId" | "epoch")[];
                    readonly additionalProperties: false;
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
            };
            readonly required: readonly ("generation" | "cursor" | "aborted")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation", "driver"];
        readonly extraErrors: readonly ["invalid_state"];
    };
    readonly lease: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            action: "acquire";
            ttlMs?: number;
        } | {
            generation: number;
            attachmentId: string;
            leaseId: string;
            action: "heartbeat";
        } | {
            generation: number;
            attachmentId: string;
            leaseId: string;
            action: "release";
        } | {
            generation: number;
            reason: string;
            attachmentId: string;
            action: "takeover";
            ttlMs?: number;
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly result: Schema<{
            generation: number;
            leaseId: string;
            holder: {
                connectionId: string;
                attachmentId: string;
            };
            expiresAt: string;
            ttlMs: number;
        } | {
            generation: number;
            leaseId: string;
            expiresAt: string;
        } | {
            released: true;
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation"];
        readonly extraErrors: readonly ["lease_held", "no_lease", "lease_expired"];
    };
    readonly ui_answer: {
        readonly session: "required";
        readonly params: Schema<{
            questionId: string;
            generation: number;
            attachmentId: string;
            leaseId: string;
            answer: {
                value: string;
            } | {
                confirmed: boolean;
            } | {
                cancelled: true;
            };
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly leaseId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly questionId: {
                    readonly type: "string";
                };
                readonly answer: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
            };
            readonly required: readonly ("questionId" | "generation" | "attachmentId" | "leaseId" | "answer")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            questionId: string;
            answered: true;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly answered: {
                    readonly const: true;
                };
                readonly questionId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("questionId" | "answered")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation", "driver"];
        readonly extraErrors: readonly ["unknown_question", "invalid_ui_answer"];
    };
    readonly sleep: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            reason?: string;
            leaseId?: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly leaseId: {
                    readonly type: "string";
                };
                readonly reason: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("generation" | "attachmentId")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            slept: true;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly slept: {
                    readonly const: true;
                };
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("session" | "slept")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "awakeHostMutation", "driver"];
        readonly extraErrors: readonly ["already_asleep", "busy", "invalid_state"];
    };
    readonly wake: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            reason?: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly reason: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("generation" | "attachmentId")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            woke: boolean;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly woke: {
                    readonly type: "boolean";
                };
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("session" | "woke")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation"];
        readonly extraErrors: readonly ["already_awake", "gone", "path_mismatch", "sdk_incompatible", "external_writer"];
    };
    readonly recover: {
        readonly session: "required";
        readonly params: Schema<{
            generation: number;
            attachmentId: string;
            leaseId?: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly attachmentId: {
                    readonly type: "string";
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly leaseId: {
                    readonly type: "string";
                };
            };
            readonly required: readonly ("generation" | "attachmentId")[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            recovered: true;
            closedPromptIds: string[];
        }, {
            readonly type: "object";
            readonly properties: {
                readonly recovered: {
                    readonly const: true;
                };
                readonly closedPromptIds: {
                    readonly type: "array";
                    readonly items: Readonly<Record<string, unknown>>;
                };
                readonly session: {
                    readonly type: "object";
                    readonly properties: {
                        readonly sessionId: {
                            readonly type: "string";
                        };
                        readonly sessionFile: {
                            readonly type: "string";
                        };
                        readonly cwd: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly runtime: {
                            readonly type: "string";
                            readonly enum: readonly ["awake", "asleep"];
                        };
                        readonly phase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                        };
                        readonly observedPhase: {
                            readonly type: "string";
                            readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                        };
                        readonly attention: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "question", "failed", "interrupted"];
                        };
                        readonly generation: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly cursor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly entryId: {
                                    readonly oneOf: Readonly<Record<string, unknown>>[];
                                };
                                readonly epoch: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                            };
                            readonly required: readonly ("entryId" | "epoch")[];
                            readonly additionalProperties: false;
                        };
                        readonly pendingQuestions: {
                            readonly type: "array";
                            readonly items: Readonly<Record<string, unknown>>;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly seq: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: number;
                                };
                                readonly at: {
                                    readonly type: "string";
                                    readonly format: "date-time";
                                };
                            };
                            readonly required: readonly ("at" | "seq")[];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("session" | "recovered" | "closedPromptIds")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request", "session", "attachment", "generation", "driver", "registrationLock"];
        readonly extraErrors: readonly ["invalid_state", "gone", "path_mismatch", "sdk_incompatible", "external_writer"];
    };
    readonly status: {
        readonly session: "optional";
        readonly params: Schema<{
            verbose?: boolean;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly verbose: {
                    readonly type: "boolean";
                };
            };
            readonly required: readonly never[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            daemon: {
                version: string;
                protocol: string;
                sdkVersion: string;
                pid: number;
                startedAt: string;
                socket: string;
            };
            counts: JsonObject;
            sessions?: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            }[];
        } | {
            session: {
                epoch: number;
                pendingQuestions: {
                    questionId: string;
                    method: "select" | "confirm" | "input" | "editor";
                    title?: string;
                }[];
                heartbeat: {
                    at: string;
                    seq: number;
                };
                sessionId: string;
                sessionFile: string;
                cwd: string;
                runtime: "awake" | "asleep";
                phase: "idle" | "working" | "blocked" | "failed" | "gone";
                observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
                attention: "failed" | "none" | "question" | "interrupted";
                generation: number;
                cursor: {
                    entryId: string | null;
                    epoch: number;
                };
                name?: string;
            };
            readers: number;
            lease?: {
                held: boolean;
                expiresAt?: string;
            };
        }, {
            readonly oneOf: Readonly<Record<string, unknown>>[];
        }>;
        readonly errorGroups: readonly ["request", "session"];
        readonly extraErrors: readonly [];
    };
    readonly shutdown: {
        readonly session: "forbidden";
        readonly params: Schema<{
            graceMs?: number;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly graceMs: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
            };
            readonly required: readonly never[];
            readonly additionalProperties: false;
        }>;
        readonly result: Schema<{
            accepted: true;
            deadline: string;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly accepted: {
                    readonly const: true;
                };
                readonly deadline: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
            };
            readonly required: readonly ("accepted" | "deadline")[];
            readonly additionalProperties: false;
        }>;
        readonly errorGroups: readonly ["request"];
        readonly extraErrors: readonly ["shutdown_in_progress", "busy"];
    };
};
export declare const OPERATIONS: readonly ("replay" | "status" | "lease" | "hello" | "list" | "open" | "create" | "attach" | "detach" | "prompt" | "prompt_status" | "steer" | "follow_up" | "abort" | "ui_answer" | "sleep" | "wake" | "recover" | "shutdown")[];
export type Operation = (typeof OPERATIONS)[number];
export type OperationParams<O extends Operation> = Infer<(typeof operationSource)[O]["params"]>;
export type OperationResult<O extends Operation> = Infer<(typeof operationSource)[O]["result"]>;
type SessionField<S extends SessionRequirement> = S extends "required" ? {
    session: string;
} : S extends "optional" ? {
    session?: string;
} : {
    session?: never;
};
type RequestFor<O extends Operation> = {
    t: "req";
    id: string;
    op: O;
    params: OperationParams<O>;
} & SessionField<(typeof operationSource)[O]["session"]>;
export type RequestFrame<O extends Operation = Operation> = O extends Operation ? RequestFor<O> : never;
export declare const OPERATION_ERROR_CODES: Readonly<Record<"replay" | "status" | "lease" | "hello" | "list" | "open" | "create" | "attach" | "detach" | "prompt" | "prompt_status" | "steer" | "follow_up" | "abort" | "ui_answer" | "sleep" | "wake" | "recover" | "shutdown", readonly ("asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal")[]>>;
declare const failureFrameSchema: Schema<{
    ok: false;
    t: "res";
    id: string;
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
}, {
    readonly type: "object";
    readonly properties: {
        readonly t: {
            readonly const: "res";
        };
        readonly id: {
            readonly type: "string";
        };
        readonly ok: {
            readonly const: false;
        };
        readonly error: {
            readonly type: "object";
            readonly properties: {
                readonly code: {
                    readonly type: "string";
                    readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
                };
                readonly message: {
                    readonly type: "string";
                };
                readonly details: {
                    readonly $ref: "#/$defs/JsonValue";
                };
            };
            readonly required: readonly ("code" | "message")[];
            readonly additionalProperties: false;
        };
    };
    readonly required: readonly ("ok" | "t" | "id" | "error")[];
    readonly additionalProperties: false;
}>;
export type SuccessFrame<O extends Operation = Operation> = {
    t: "res";
    id: string;
    ok: true;
    result: OperationResult<O>;
};
export type FailureFrame = Infer<typeof failureFrameSchema>;
export type ResponseFrame<O extends Operation = Operation> = SuccessFrame<O> | FailureFrame;
export declare const EVENT_TYPES: readonly ("agent_start" | "agent_end" | "turn_start" | "turn_end" | "message_start" | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "agent_settled" | "queue_update" | "compaction_start" | "entry_appended" | "session_info_changed" | "thinking_level_changed" | "compaction_end" | "auto_retry_start" | "auto_retry_end" | "summarization_retry_scheduled" | "summarization_retry_attempt_start" | "summarization_retry_finished" | "bash_execution_update")[];
export type EventType = (typeof EVENT_TYPES)[number];
export declare const DAEMON_FRAME_NAMES: readonly ("phase" | "attention" | "external_writer" | "lease" | "prompt" | "sleep" | "wake" | "replay_start" | "replay_end" | "keepalive" | "restored" | "ui_notice")[];
export declare const STREAM_KINDS: readonly ("daemon" | "error" | "entry" | "event" | "ui_request" | "gap")[];
export type StreamKind = (typeof STREAM_KINDS)[number];
declare const streamFrameSchema: Schema<{
    epoch: number;
    seq: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "live";
} | {
    epoch: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    replayId: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "replay";
    index: number;
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_end";
    durable: false;
    data: {
        messages: JsonObject[];
        willRetry: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_end";
    durable: false;
    data: {
        message: JsonObject;
        toolResults: JsonObject[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_start";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_update";
    durable: false;
    data: {
        message: JsonObject;
        assistantMessageEvent: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_end";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_start";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_update";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
        partialResult: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_end";
    durable: false;
    data: {
        result: JsonValue;
        toolCallId: string;
        toolName: string;
        isError: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_settled";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "queue_update";
    durable: false;
    data: {
        steering: string[];
        followUp: string[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_start";
    durable: false;
    data: {
        reason: "manual" | "threshold" | "overflow";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "entry_appended";
    durable: false;
    data: {
        entry: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "session_info_changed";
    durable: false;
    data: {
        name?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "thinking_level_changed";
    durable: false;
    data: {
        level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_end";
    durable: false;
    data: {
        aborted: boolean;
        reason: "manual" | "threshold" | "overflow";
        willRetry: boolean;
        result?: JsonValue;
        errorMessage?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_start";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_end";
    durable: false;
    data: {
        attempt: number;
        success: boolean;
        finalError?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_scheduled";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_attempt_start";
    durable: false;
    data: {
        source: "branchSummary";
    } | {
        reason: "manual" | "threshold" | "overflow";
        source: "compaction";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_finished";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "bash_execution_update";
    durable: false;
    data: {
        delta: string;
        id?: string;
    };
} | {
    epoch: number;
    name: "phase";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "attention";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "lease";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "prompt";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        outcome: "settled";
    } | {
        outcome: "aborted";
        errorCode: "aborted";
    } | {
        outcome: "failed";
        errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
    };
    sourceEntryId: string;
} | {
    epoch: number;
    name: "replay_start";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "replay_end";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "keepalive";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
        attention: "failed" | "none" | "question" | "interrupted";
        cursor: {
            entryId: string | null;
            epoch: number;
        };
        pendingQuestionIds: string[];
    };
} | {
    epoch: number;
    name: "sleep";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "wake";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "restored";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "external_writer";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "ui_notice";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    questionId: string;
    method: "select";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    options?: string[];
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "confirm";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    message?: string;
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "input";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    placeholder?: string;
    prefill?: string;
} | {
    epoch: number;
    questionId: string;
    method: "editor";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    prefill?: string;
} | {
    epoch: number;
    generation: number;
    reason: "reader_overflow" | "socket_backpressure";
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "gap";
    lost: {
        fromSeq: number;
        toSeq: number;
    };
    demoted: true;
    resumeFrom: {
        entryId: string | null;
        epoch: number;
    };
} | {
    epoch: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
    kind: "error";
    fatal: boolean;
}, {
    readonly oneOf: readonly ({
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "entry";
            };
        };
        readonly required: readonly "kind"[];
        readonly allOf: readonly [Readonly<Record<string, unknown>>];
    } | {
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "event";
            };
        };
        readonly required: readonly "kind"[];
        readonly allOf: readonly [Readonly<Record<string, unknown>>];
    } | {
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "daemon";
            };
        };
        readonly required: readonly "kind"[];
        readonly allOf: readonly [Readonly<Record<string, unknown>>];
    } | {
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "ui_request";
            };
        };
        readonly required: readonly "kind"[];
        readonly allOf: readonly [Readonly<Record<string, unknown>>];
    } | {
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "gap";
            };
            readonly reason: {
                readonly type: "string";
                readonly enum: readonly ["reader_overflow", "socket_backpressure"];
            };
            readonly lost: {
                readonly type: "object";
                readonly properties: {
                    readonly fromSeq: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                    readonly toSeq: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("fromSeq" | "toSeq")[];
                readonly additionalProperties: false;
            };
            readonly resumeFrom: {
                readonly type: "object";
                readonly properties: {
                    readonly entryId: {
                        readonly oneOf: Readonly<Record<string, unknown>>[];
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("entryId" | "epoch")[];
                readonly additionalProperties: false;
            };
            readonly demoted: {
                readonly const: true;
            };
            readonly t: {
                readonly const: "ev";
            };
            readonly session: {
                readonly type: "string";
            };
            readonly attachmentId: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
        };
        readonly required: readonly ("epoch" | "generation" | "reason" | "session" | "attachmentId" | "t" | "kind" | "lost" | "demoted" | "resumeFrom")[];
        readonly additionalProperties: false;
    } | {
        readonly type: "object";
        readonly properties: {
            readonly kind: {
                readonly const: "error";
            };
            readonly error: {
                readonly type: "object";
                readonly properties: {
                    readonly code: {
                        readonly type: "string";
                        readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
                    };
                    readonly message: {
                        readonly type: "string";
                    };
                    readonly details: {
                        readonly $ref: "#/$defs/JsonValue";
                    };
                };
                readonly required: readonly ("code" | "message")[];
                readonly additionalProperties: false;
            };
            readonly fatal: {
                readonly type: "boolean";
            };
            readonly t: {
                readonly const: "ev";
            };
            readonly session: {
                readonly type: "string";
            };
            readonly attachmentId: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
        };
        readonly required: readonly ("epoch" | "generation" | "session" | "attachmentId" | "t" | "error" | "kind" | "fatal")[];
        readonly additionalProperties: false;
    })[];
}>;
export type StreamFrame = Infer<typeof streamFrameSchema>;
declare const customEntryDataSource: {
    readonly "pi-daemon/restored": Schema<{
        at: string;
        epoch: number;
        interrupted: true;
        generation: number;
        v: 1;
        previousPhase: "working" | "blocked" | null;
        unfinishedPromptIds: string[];
        daemonInstanceId: string;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly daemonInstanceId: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly interrupted: {
                readonly const: true;
            };
            readonly previousPhase: {
                readonly oneOf: Readonly<Record<string, unknown>>[];
            };
            readonly unfinishedPromptIds: {
                readonly type: "array";
                readonly items: Readonly<Record<string, unknown>>;
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "interrupted" | "generation" | "v" | "previousPhase" | "unfinishedPromptIds" | "daemonInstanceId")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/lifecycle": Schema<{
        at: string;
        epoch: number;
        generation: number;
        reason: string;
        action: "failed" | "gone" | "created" | "slept" | "woke" | "sleeping";
        v: 1;
        sleepAfterMs?: number;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["created", "woke", "sleeping", "slept", "failed", "gone"];
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly reason: {
                readonly type: "string";
                readonly maxLength: number;
            };
            readonly sleepAfterMs: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "generation" | "reason" | "action" | "v")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/phase": Schema<{
        at: string;
        epoch: number;
        attention: "failed" | "none" | "question" | "interrupted";
        generation: number;
        reason: string;
        from: "idle" | "working" | "blocked" | "failed" | "gone";
        pendingQuestionIds: string[];
        v: 1;
        to: "idle" | "working" | "blocked" | "failed" | "gone";
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly from: {
                readonly type: "string";
                readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
            };
            readonly to: {
                readonly type: "string";
                readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
            };
            readonly attention: {
                readonly type: "string";
                readonly enum: readonly ["none", "question", "failed", "interrupted"];
            };
            readonly pendingQuestionIds: {
                readonly type: "array";
                readonly items: Readonly<Record<string, unknown>>;
            };
            readonly reason: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "attention" | "generation" | "reason" | "from" | "pendingQuestionIds" | "v" | "to")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/lease": Schema<{
        at: string;
        epoch: number;
        generation: number;
        leaseId: string;
        action: "released" | "acquired" | "expired" | "taken_over" | "disconnected";
        v: 1;
        actorId: string;
        expiresAt?: string;
        previousLeaseId?: string;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["acquired", "released", "expired", "taken_over", "disconnected"];
            };
            readonly leaseId: {
                readonly type: "string";
            };
            readonly actorId: {
                readonly type: "string";
            };
            readonly previousLeaseId: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly expiresAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "generation" | "leaseId" | "action" | "v" | "actorId")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/prompt-claim": Schema<{
        promptId: string;
        acceptedAt: string;
        attribution: {
            actorId: string;
        };
        idempotencyKey: string;
        v: 1;
        payloadSha256: string;
        clientId: string;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly promptId: {
                readonly type: "string";
            };
            readonly idempotencyKey: {
                readonly type: "string";
            };
            readonly payloadSha256: {
                readonly type: "string";
            };
            readonly clientId: {
                readonly type: "string";
            };
            readonly attribution: {
                readonly type: "object";
                readonly properties: {
                    readonly actorId: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly "actorId"[];
                readonly additionalProperties: false;
            };
            readonly acceptedAt: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("promptId" | "acceptedAt" | "attribution" | "idempotencyKey" | "v" | "payloadSha256" | "clientId")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/prompt-outcome": Schema<{
        outcome: "settled";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    } | {
        outcome: "aborted";
        errorCode: "aborted";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    } | {
        outcome: "failed";
        errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    }, {
        readonly oneOf: readonly ({
            readonly type: "object";
            readonly properties: {
                readonly v: {
                    readonly const: 1;
                };
                readonly promptId: {
                    readonly type: "string";
                };
                readonly finalEntryId: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly stopReason: {
                    readonly type: "string";
                };
                readonly settledAt: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
                readonly outcome: {
                    readonly const: "settled";
                };
            };
            readonly required: readonly ("outcome" | "promptId" | "settledAt" | "v")[];
            readonly additionalProperties: false;
        } | {
            readonly type: "object";
            readonly properties: {
                readonly v: {
                    readonly const: 1;
                };
                readonly promptId: {
                    readonly type: "string";
                };
                readonly finalEntryId: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly stopReason: {
                    readonly type: "string";
                };
                readonly settledAt: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
                readonly outcome: {
                    readonly const: "aborted";
                };
                readonly errorCode: {
                    readonly const: "aborted";
                };
            };
            readonly required: readonly ("outcome" | "errorCode" | "promptId" | "settledAt" | "v")[];
            readonly additionalProperties: false;
        } | {
            readonly type: "object";
            readonly properties: {
                readonly v: {
                    readonly const: 1;
                };
                readonly promptId: {
                    readonly type: "string";
                };
                readonly finalEntryId: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly stopReason: {
                    readonly type: "string";
                };
                readonly settledAt: {
                    readonly type: "string";
                    readonly format: "date-time";
                };
                readonly outcome: {
                    readonly const: "failed";
                };
                readonly errorCode: {
                    readonly type: "string";
                    readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
                };
            };
            readonly required: readonly ("outcome" | "errorCode" | "promptId" | "settledAt" | "v")[];
            readonly additionalProperties: false;
        })[];
    }>;
    readonly "pi-daemon/input": Schema<{
        at: string;
        epoch: number;
        generation: number;
        inputId: string;
        v: 1;
        actorId: string;
        operation: "steer" | "follow_up";
        contentSha256: string;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly inputId: {
                readonly type: "string";
            };
            readonly operation: {
                readonly type: "string";
                readonly enum: readonly ["steer", "follow_up"];
            };
            readonly actorId: {
                readonly type: "string";
            };
            readonly contentSha256: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "generation" | "inputId" | "v" | "actorId" | "operation" | "contentSha256")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/ui": Schema<{
        at: string;
        epoch: number;
        questionId: string;
        method: "select" | "confirm" | "input" | "editor";
        generation: number;
        action: "cancelled" | "answered" | "opened" | "timed_out";
        v: 1;
        actorId?: string;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly questionId: {
                readonly type: "string";
            };
            readonly action: {
                readonly type: "string";
                readonly enum: readonly ["opened", "answered", "cancelled", "timed_out"];
            };
            readonly method: {
                readonly type: "string";
                readonly enum: readonly ["select", "confirm", "input", "editor"];
            };
            readonly actorId: {
                readonly type: "string";
            };
            readonly generation: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly epoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "epoch" | "questionId" | "method" | "generation" | "action" | "v")[];
        readonly additionalProperties: false;
    }>;
    readonly "pi-daemon/epoch": Schema<{
        at: string;
        reason: "fork" | "switch" | "restore" | "rewind" | "navigate";
        forkPoint: string | null;
        v: 1;
        previousLeaf: string | null;
        currentLeaf: string | null;
        fromEpoch: number;
        toEpoch: number;
    }, {
        readonly type: "object";
        readonly properties: {
            readonly v: {
                readonly const: 1;
            };
            readonly fromEpoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly toEpoch: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: number;
            };
            readonly reason: {
                readonly type: "string";
                readonly enum: readonly ["fork", "switch", "restore", "rewind", "navigate"];
            };
            readonly previousLeaf: {
                readonly oneOf: Readonly<Record<string, unknown>>[];
            };
            readonly currentLeaf: {
                readonly oneOf: Readonly<Record<string, unknown>>[];
            };
            readonly forkPoint: {
                readonly oneOf: Readonly<Record<string, unknown>>[];
            };
            readonly at: {
                readonly type: "string";
                readonly format: "date-time";
            };
        };
        readonly required: readonly ("at" | "reason" | "forkPoint" | "v" | "previousLeaf" | "currentLeaf" | "fromEpoch" | "toEpoch")[];
        readonly additionalProperties: false;
    }>;
};
export declare const CUSTOM_ENTRY_TYPES: readonly ("pi-daemon/restored" | "pi-daemon/lifecycle" | "pi-daemon/phase" | "pi-daemon/lease" | "pi-daemon/prompt-claim" | "pi-daemon/prompt-outcome" | "pi-daemon/input" | "pi-daemon/ui" | "pi-daemon/epoch")[];
export type CustomEntryType = (typeof CUSTOM_ENTRY_TYPES)[number];
export type CustomEntryData<T extends CustomEntryType> = Infer<(typeof customEntryDataSource)[T]>;
export type DaemonCustomEntry<T extends CustomEntryType = CustomEntryType> = T extends CustomEntryType ? {
    type: "custom";
    customType: T;
    data: CustomEntryData<T>;
} : never;
export type ProtocolFrame = RequestFrame | SuccessFrame | FailureFrame | StreamFrame;
export declare const PROTOCOL_VERSION: "1.0";
export declare const PROTOCOL_JSON_SCHEMA: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "https://caair.dev/schemas/pi-daemon/protocol-1.0.schema.json";
    readonly title: "pi-daemon protocol 1.0";
    readonly oneOf: readonly [{
        readonly $ref: "#/$defs/RequestFrame";
    }, {
        readonly $ref: "#/$defs/SuccessFrame";
    }, {
        readonly $ref: "#/$defs/FailureFrame";
    }, {
        readonly $ref: "#/$defs/StreamFrame";
    }];
    readonly $defs: {
        readonly JsonValue: {
            readonly oneOf: readonly [{
                readonly type: "null";
            }, {
                readonly type: "boolean";
            }, {
                readonly type: "number";
            }, {
                readonly type: "string";
            }, {
                readonly type: "array";
                readonly items: {
                    readonly $ref: "#/$defs/JsonValue";
                };
            }, {
                readonly type: "object";
                readonly additionalProperties: {
                    readonly $ref: "#/$defs/JsonValue";
                };
            }];
        };
        readonly Cursor: {
            readonly type: "object";
            readonly properties: {
                readonly entryId: {
                    readonly oneOf: Readonly<Record<string, unknown>>[];
                };
                readonly epoch: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
            };
            readonly required: readonly ("entryId" | "epoch")[];
            readonly additionalProperties: false;
        };
        readonly SessionSummary: {
            readonly type: "object";
            readonly properties: {
                readonly sessionId: {
                    readonly type: "string";
                };
                readonly sessionFile: {
                    readonly type: "string";
                };
                readonly cwd: {
                    readonly type: "string";
                };
                readonly name: {
                    readonly type: "string";
                };
                readonly runtime: {
                    readonly type: "string";
                    readonly enum: readonly ["awake", "asleep"];
                };
                readonly phase: {
                    readonly type: "string";
                    readonly enum: readonly ["idle", "working", "blocked", "failed", "gone"];
                };
                readonly observedPhase: {
                    readonly type: "string";
                    readonly enum: readonly ["idle", "working", "blocked", "failed", "gone", "asleep"];
                };
                readonly attention: {
                    readonly type: "string";
                    readonly enum: readonly ["none", "question", "failed", "interrupted"];
                };
                readonly generation: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly epoch: {
                    readonly type: "integer";
                    readonly minimum: 0;
                    readonly maximum: number;
                };
                readonly cursor: {
                    readonly type: "object";
                    readonly properties: {
                        readonly entryId: {
                            readonly oneOf: Readonly<Record<string, unknown>>[];
                        };
                        readonly epoch: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                    };
                    readonly required: readonly ("entryId" | "epoch")[];
                    readonly additionalProperties: false;
                };
                readonly pendingQuestions: {
                    readonly type: "array";
                    readonly items: Readonly<Record<string, unknown>>;
                };
                readonly heartbeat: {
                    readonly type: "object";
                    readonly properties: {
                        readonly seq: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: number;
                        };
                        readonly at: {
                            readonly type: "string";
                            readonly format: "date-time";
                        };
                    };
                    readonly required: readonly ("at" | "seq")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("epoch" | "pendingQuestions" | "heartbeat" | "sessionId" | "sessionFile" | "cwd" | "runtime" | "phase" | "observedPhase" | "attention" | "generation" | "cursor")[];
            readonly additionalProperties: false;
        };
        readonly Operation: {
            readonly type: "string";
            readonly enum: ["replay" | "status" | "lease" | "hello" | "list" | "open" | "create" | "attach" | "detach" | "prompt" | "prompt_status" | "steer" | "follow_up" | "abort" | "ui_answer" | "sleep" | "wake" | "recover" | "shutdown", ...("replay" | "status" | "lease" | "hello" | "list" | "open" | "create" | "attach" | "detach" | "prompt" | "prompt_status" | "steer" | "follow_up" | "abort" | "ui_answer" | "sleep" | "wake" | "recover" | "shutdown")[]];
        };
        readonly ErrorCode: {
            readonly type: "string";
            readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
        };
        readonly PromptOutcomeName: {
            readonly type: "string";
            readonly enum: ["failed" | "settled" | "aborted", ...("failed" | "settled" | "aborted")[]];
        };
        readonly PromptOutcomeErrorCode: {
            readonly type: "string";
            readonly enum: ["aborted", "interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
        };
        readonly PromptOutcome: {
            readonly oneOf: readonly ({
                readonly type: "object";
                readonly properties: {
                    readonly outcome: {
                        readonly const: "settled";
                    };
                };
                readonly required: readonly "outcome"[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly outcome: {
                        readonly const: "aborted";
                    };
                    readonly errorCode: {
                        readonly const: "aborted";
                    };
                };
                readonly required: readonly ("outcome" | "errorCode")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly outcome: {
                        readonly const: "failed";
                    };
                    readonly errorCode: {
                        readonly type: "string";
                        readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
                    };
                };
                readonly required: readonly ("outcome" | "errorCode")[];
                readonly additionalProperties: false;
            })[];
        };
        readonly PromptStatusResult: {
            readonly oneOf: readonly ({
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "pending";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly reason: {
                        readonly const: "external_writer";
                    };
                };
                readonly required: readonly "state"[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "unknown";
                    };
                };
                readonly required: readonly "state"[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "settled";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "settled";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                };
                readonly required: readonly ("state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "aborted";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "aborted";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                    readonly errorCode: {
                        readonly const: "aborted";
                    };
                };
                readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly state: {
                        readonly const: "failed";
                    };
                    readonly promptId: {
                        readonly type: "string";
                    };
                    readonly terminalOutcome: {
                        readonly const: "failed";
                    };
                    readonly acceptedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly settledAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly finalCursor: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                    readonly errorCode: {
                        readonly type: "string";
                        readonly enum: ["interrupted", "external_writer", "provider_error", "sdk_error", "rejected"];
                    };
                };
                readonly required: readonly ("errorCode" | "state" | "terminalOutcome")[];
                readonly additionalProperties: false;
            })[];
        };
        readonly OperationError: {
            readonly oneOf: readonly Readonly<Record<string, unknown>>[];
        };
        readonly RequestFrame: {
            readonly oneOf: readonly Readonly<Record<string, unknown>>[];
        };
        readonly SuccessFrame: {
            readonly type: "object";
            readonly properties: {
                readonly t: {
                    readonly const: "res";
                };
                readonly id: {
                    readonly type: "string";
                };
                readonly ok: {
                    readonly const: true;
                };
                readonly result: {
                    readonly $ref: "#/$defs/JsonValue";
                };
            };
            readonly required: readonly ("ok" | "result" | "t" | "id")[];
            readonly additionalProperties: false;
        };
        readonly FailureFrame: {
            readonly type: "object";
            readonly properties: {
                readonly t: {
                    readonly const: "res";
                };
                readonly id: {
                    readonly type: "string";
                };
                readonly ok: {
                    readonly const: false;
                };
                readonly error: {
                    readonly type: "object";
                    readonly properties: {
                        readonly code: {
                            readonly type: "string";
                            readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
                        };
                        readonly message: {
                            readonly type: "string";
                        };
                        readonly details: {
                            readonly $ref: "#/$defs/JsonValue";
                        };
                    };
                    readonly required: readonly ("code" | "message")[];
                    readonly additionalProperties: false;
                };
            };
            readonly required: readonly ("ok" | "t" | "id" | "error")[];
            readonly additionalProperties: false;
        };
        readonly StreamKind: {
            readonly type: "string";
            readonly enum: ["daemon" | "error" | "entry" | "event" | "ui_request" | "gap", ...("daemon" | "error" | "entry" | "event" | "ui_request" | "gap")[]];
        };
        readonly StreamFrame: {
            readonly oneOf: readonly ({
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "entry";
                    };
                };
                readonly required: readonly "kind"[];
                readonly allOf: readonly [Readonly<Record<string, unknown>>];
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "event";
                    };
                };
                readonly required: readonly "kind"[];
                readonly allOf: readonly [Readonly<Record<string, unknown>>];
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "daemon";
                    };
                };
                readonly required: readonly "kind"[];
                readonly allOf: readonly [Readonly<Record<string, unknown>>];
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "ui_request";
                    };
                };
                readonly required: readonly "kind"[];
                readonly allOf: readonly [Readonly<Record<string, unknown>>];
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "gap";
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly enum: readonly ["reader_overflow", "socket_backpressure"];
                    };
                    readonly lost: {
                        readonly type: "object";
                        readonly properties: {
                            readonly fromSeq: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                            readonly toSeq: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("fromSeq" | "toSeq")[];
                        readonly additionalProperties: false;
                    };
                    readonly resumeFrom: {
                        readonly type: "object";
                        readonly properties: {
                            readonly entryId: {
                                readonly oneOf: Readonly<Record<string, unknown>>[];
                            };
                            readonly epoch: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: number;
                            };
                        };
                        readonly required: readonly ("entryId" | "epoch")[];
                        readonly additionalProperties: false;
                    };
                    readonly demoted: {
                        readonly const: true;
                    };
                    readonly t: {
                        readonly const: "ev";
                    };
                    readonly session: {
                        readonly type: "string";
                    };
                    readonly attachmentId: {
                        readonly type: "string";
                    };
                    readonly generation: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("epoch" | "generation" | "reason" | "session" | "attachmentId" | "t" | "kind" | "lost" | "demoted" | "resumeFrom")[];
                readonly additionalProperties: false;
            } | {
                readonly type: "object";
                readonly properties: {
                    readonly kind: {
                        readonly const: "error";
                    };
                    readonly error: {
                        readonly type: "object";
                        readonly properties: {
                            readonly code: {
                                readonly type: "string";
                                readonly enum: ["bad_frame", "frame_too_large", "handshake_required", "protocol_mismatch", "unsupported_op", "invalid_request", "unknown_session", "duplicate_session", "path_mismatch", "session_locked", "external_writer", "gone", "not_attached", "busy", "rejected", "no_lease", "lease_held", "lease_expired", "stale_generation", "stale_epoch", "asleep", "already_awake", "already_asleep", "invalid_state", "cursor_unknown", "cursor_off_branch", "unknown_question", "invalid_ui_answer", "idempotency_conflict", "queue_full", "sdk_incompatible", "shutdown_in_progress", "unavailable", "internal"];
                            };
                            readonly message: {
                                readonly type: "string";
                            };
                            readonly details: {
                                readonly $ref: "#/$defs/JsonValue";
                            };
                        };
                        readonly required: readonly ("code" | "message")[];
                        readonly additionalProperties: false;
                    };
                    readonly fatal: {
                        readonly type: "boolean";
                    };
                    readonly t: {
                        readonly const: "ev";
                    };
                    readonly session: {
                        readonly type: "string";
                    };
                    readonly attachmentId: {
                        readonly type: "string";
                    };
                    readonly generation: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                    readonly epoch: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: number;
                    };
                };
                readonly required: readonly ("epoch" | "generation" | "session" | "attachmentId" | "t" | "error" | "kind" | "fatal")[];
                readonly additionalProperties: false;
            })[];
        };
        readonly CustomEntryType: {
            readonly type: "string";
            readonly enum: ["pi-daemon/restored" | "pi-daemon/lifecycle" | "pi-daemon/phase" | "pi-daemon/lease" | "pi-daemon/prompt-claim" | "pi-daemon/prompt-outcome" | "pi-daemon/input" | "pi-daemon/ui" | "pi-daemon/epoch", ...("pi-daemon/restored" | "pi-daemon/lifecycle" | "pi-daemon/phase" | "pi-daemon/lease" | "pi-daemon/prompt-claim" | "pi-daemon/prompt-outcome" | "pi-daemon/input" | "pi-daemon/ui" | "pi-daemon/epoch")[]];
        };
        readonly DaemonCustomEntry: {
            readonly oneOf: readonly Readonly<Record<string, unknown>>[];
        };
    };
};
export declare const isRequestFrame: (value: unknown) => value is RequestFor<"replay"> | RequestFor<"status"> | RequestFor<"lease"> | RequestFor<"hello"> | RequestFor<"list"> | RequestFor<"open"> | RequestFor<"create"> | RequestFor<"attach"> | RequestFor<"detach"> | RequestFor<"prompt"> | RequestFor<"prompt_status"> | RequestFor<"steer"> | RequestFor<"follow_up"> | RequestFor<"abort"> | RequestFor<"ui_answer"> | RequestFor<"sleep"> | RequestFor<"wake"> | RequestFor<"recover"> | RequestFor<"shutdown">;
export declare const isSuccessFrame: (value: unknown) => value is {
    ok: true;
    result: JsonValue;
    t: "res";
    id: string;
};
export declare const isFailureFrame: (value: unknown) => value is {
    ok: false;
    t: "res";
    id: string;
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
};
export declare const isStreamFrame: (value: unknown) => value is {
    epoch: number;
    seq: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "live";
} | {
    epoch: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    replayId: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "replay";
    index: number;
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_end";
    durable: false;
    data: {
        messages: JsonObject[];
        willRetry: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_end";
    durable: false;
    data: {
        message: JsonObject;
        toolResults: JsonObject[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_start";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_update";
    durable: false;
    data: {
        message: JsonObject;
        assistantMessageEvent: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_end";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_start";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_update";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
        partialResult: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_end";
    durable: false;
    data: {
        result: JsonValue;
        toolCallId: string;
        toolName: string;
        isError: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_settled";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "queue_update";
    durable: false;
    data: {
        steering: string[];
        followUp: string[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_start";
    durable: false;
    data: {
        reason: "manual" | "threshold" | "overflow";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "entry_appended";
    durable: false;
    data: {
        entry: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "session_info_changed";
    durable: false;
    data: {
        name?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "thinking_level_changed";
    durable: false;
    data: {
        level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_end";
    durable: false;
    data: {
        aborted: boolean;
        reason: "manual" | "threshold" | "overflow";
        willRetry: boolean;
        result?: JsonValue;
        errorMessage?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_start";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_end";
    durable: false;
    data: {
        attempt: number;
        success: boolean;
        finalError?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_scheduled";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_attempt_start";
    durable: false;
    data: {
        source: "branchSummary";
    } | {
        reason: "manual" | "threshold" | "overflow";
        source: "compaction";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_finished";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "bash_execution_update";
    durable: false;
    data: {
        delta: string;
        id?: string;
    };
} | {
    epoch: number;
    name: "phase";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "attention";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "lease";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "prompt";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        outcome: "settled";
    } | {
        outcome: "aborted";
        errorCode: "aborted";
    } | {
        outcome: "failed";
        errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
    };
    sourceEntryId: string;
} | {
    epoch: number;
    name: "replay_start";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "replay_end";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "keepalive";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
        attention: "failed" | "none" | "question" | "interrupted";
        cursor: {
            entryId: string | null;
            epoch: number;
        };
        pendingQuestionIds: string[];
    };
} | {
    epoch: number;
    name: "sleep";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "wake";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "restored";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "external_writer";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "ui_notice";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    questionId: string;
    method: "select";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    options?: string[];
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "confirm";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    message?: string;
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "input";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    placeholder?: string;
    prefill?: string;
} | {
    epoch: number;
    questionId: string;
    method: "editor";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    prefill?: string;
} | {
    epoch: number;
    generation: number;
    reason: "reader_overflow" | "socket_backpressure";
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "gap";
    lost: {
        fromSeq: number;
        toSeq: number;
    };
    demoted: true;
    resumeFrom: {
        entryId: string | null;
        epoch: number;
    };
} | {
    epoch: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
    kind: "error";
    fatal: boolean;
};
export declare const isDaemonCustomEntry: (value: unknown) => value is {
    type: "custom";
    customType: "pi-daemon/restored";
    data: {
        at: string;
        epoch: number;
        interrupted: true;
        generation: number;
        v: 1;
        previousPhase: "working" | "blocked" | null;
        unfinishedPromptIds: string[];
        daemonInstanceId: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/lifecycle";
    data: {
        at: string;
        epoch: number;
        generation: number;
        reason: string;
        action: "failed" | "gone" | "created" | "slept" | "woke" | "sleeping";
        v: 1;
        sleepAfterMs?: number;
    };
} | {
    type: "custom";
    customType: "pi-daemon/phase";
    data: {
        at: string;
        epoch: number;
        attention: "failed" | "none" | "question" | "interrupted";
        generation: number;
        reason: string;
        from: "idle" | "working" | "blocked" | "failed" | "gone";
        pendingQuestionIds: string[];
        v: 1;
        to: "idle" | "working" | "blocked" | "failed" | "gone";
    };
} | {
    type: "custom";
    customType: "pi-daemon/lease";
    data: {
        at: string;
        epoch: number;
        generation: number;
        leaseId: string;
        action: "released" | "acquired" | "expired" | "taken_over" | "disconnected";
        v: 1;
        actorId: string;
        expiresAt?: string;
        previousLeaseId?: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/prompt-claim";
    data: {
        promptId: string;
        acceptedAt: string;
        attribution: {
            actorId: string;
        };
        idempotencyKey: string;
        v: 1;
        payloadSha256: string;
        clientId: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/prompt-outcome";
    data: {
        outcome: "settled";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    } | {
        outcome: "aborted";
        errorCode: "aborted";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    } | {
        outcome: "failed";
        errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
        promptId: string;
        settledAt: string;
        v: 1;
        finalEntryId?: string | null;
        stopReason?: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/input";
    data: {
        at: string;
        epoch: number;
        generation: number;
        inputId: string;
        v: 1;
        actorId: string;
        operation: "steer" | "follow_up";
        contentSha256: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/ui";
    data: {
        at: string;
        epoch: number;
        questionId: string;
        method: "select" | "confirm" | "input" | "editor";
        generation: number;
        action: "cancelled" | "answered" | "opened" | "timed_out";
        v: 1;
        actorId?: string;
    };
} | {
    type: "custom";
    customType: "pi-daemon/epoch";
    data: {
        at: string;
        reason: "fork" | "switch" | "restore" | "rewind" | "navigate";
        forkPoint: string | null;
        v: 1;
        previousLeaf: string | null;
        currentLeaf: string | null;
        fromEpoch: number;
        toEpoch: number;
    };
};
export declare const isProtocolFrame: (value: unknown) => value is RequestFor<"replay"> | RequestFor<"status"> | RequestFor<"lease"> | RequestFor<"hello"> | RequestFor<"list"> | RequestFor<"open"> | RequestFor<"create"> | RequestFor<"attach"> | RequestFor<"detach"> | RequestFor<"prompt"> | RequestFor<"prompt_status"> | RequestFor<"steer"> | RequestFor<"follow_up"> | RequestFor<"abort"> | RequestFor<"ui_answer"> | RequestFor<"sleep"> | RequestFor<"wake"> | RequestFor<"recover"> | RequestFor<"shutdown"> | {
    ok: true;
    result: JsonValue;
    t: "res";
    id: string;
} | {
    ok: false;
    t: "res";
    id: string;
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "live";
} | {
    epoch: number;
    generation: number;
    cursor: {
        entryId: string | null;
        epoch: number;
    };
    session: string;
    replayId: string;
    attachmentId: string;
    t: "ev";
    kind: "entry";
    entry: JsonObject;
    origin: "replay";
    index: number;
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_end";
    durable: false;
    data: {
        messages: JsonObject[];
        willRetry: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_start";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "turn_end";
    durable: false;
    data: {
        message: JsonObject;
        toolResults: JsonObject[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_start";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_update";
    durable: false;
    data: {
        message: JsonObject;
        assistantMessageEvent: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "message_end";
    durable: false;
    data: {
        message: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_start";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_update";
    durable: false;
    data: {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
        partialResult: JsonValue;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "tool_execution_end";
    durable: false;
    data: {
        result: JsonValue;
        toolCallId: string;
        toolName: string;
        isError: boolean;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "agent_settled";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "queue_update";
    durable: false;
    data: {
        steering: string[];
        followUp: string[];
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_start";
    durable: false;
    data: {
        reason: "manual" | "threshold" | "overflow";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "entry_appended";
    durable: false;
    data: {
        entry: JsonObject;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "session_info_changed";
    durable: false;
    data: {
        name?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "thinking_level_changed";
    durable: false;
    data: {
        level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "compaction_end";
    durable: false;
    data: {
        aborted: boolean;
        reason: "manual" | "threshold" | "overflow";
        willRetry: boolean;
        result?: JsonValue;
        errorMessage?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_start";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "auto_retry_end";
    durable: false;
    data: {
        attempt: number;
        success: boolean;
        finalError?: string;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_scheduled";
    durable: false;
    data: {
        errorMessage: string;
        attempt: number;
        maxAttempts: number;
        delayMs: number;
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_attempt_start";
    durable: false;
    data: {
        source: "branchSummary";
    } | {
        reason: "manual" | "threshold" | "overflow";
        source: "compaction";
    };
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "summarization_retry_finished";
    durable: false;
    data: {};
} | {
    epoch: number;
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "event";
    eventType: "bash_execution_update";
    durable: false;
    data: {
        delta: string;
        id?: string;
    };
} | {
    epoch: number;
    name: "phase";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "attention";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "lease";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "prompt";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        outcome: "settled";
    } | {
        outcome: "aborted";
        errorCode: "aborted";
    } | {
        outcome: "failed";
        errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
    };
    sourceEntryId: string;
} | {
    epoch: number;
    name: "replay_start";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "replay_end";
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "keepalive";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: {
        observedPhase: "asleep" | "idle" | "working" | "blocked" | "failed" | "gone";
        attention: "failed" | "none" | "question" | "interrupted";
        cursor: {
            entryId: string | null;
            epoch: number;
        };
        pendingQuestionIds: string[];
    };
} | {
    epoch: number;
    name: "sleep";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "wake";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "restored";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
    sourceEntryId: string;
} | {
    epoch: number;
    name: "external_writer";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    name: "ui_notice";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "daemon";
    data: JsonObject;
} | {
    epoch: number;
    questionId: string;
    method: "select";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    options?: string[];
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "confirm";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    message?: string;
    timeoutMs?: number;
} | {
    epoch: number;
    questionId: string;
    method: "input";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    placeholder?: string;
    prefill?: string;
} | {
    epoch: number;
    questionId: string;
    method: "editor";
    seq: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "ui_request";
    title?: string;
    timeoutMs?: number;
    prefill?: string;
} | {
    epoch: number;
    generation: number;
    reason: "reader_overflow" | "socket_backpressure";
    session: string;
    attachmentId: string;
    t: "ev";
    kind: "gap";
    lost: {
        fromSeq: number;
        toSeq: number;
    };
    demoted: true;
    resumeFrom: {
        entryId: string | null;
        epoch: number;
    };
} | {
    epoch: number;
    generation: number;
    session: string;
    attachmentId: string;
    t: "ev";
    error: {
        code: "asleep" | "gone" | "external_writer" | "rejected" | "bad_frame" | "frame_too_large" | "handshake_required" | "protocol_mismatch" | "unsupported_op" | "invalid_request" | "unknown_session" | "duplicate_session" | "path_mismatch" | "session_locked" | "not_attached" | "busy" | "no_lease" | "lease_held" | "lease_expired" | "stale_generation" | "stale_epoch" | "already_awake" | "already_asleep" | "invalid_state" | "cursor_unknown" | "cursor_off_branch" | "unknown_question" | "invalid_ui_answer" | "idempotency_conflict" | "queue_full" | "sdk_incompatible" | "shutdown_in_progress" | "unavailable" | "internal";
        message: string;
        details?: JsonValue;
    };
    kind: "error";
    fatal: boolean;
};
export declare const isPromptOutcome: (value: unknown) => value is {
    outcome: "settled";
} | {
    outcome: "aborted";
    errorCode: "aborted";
} | {
    outcome: "failed";
    errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
};
export declare const isPromptStatusResult: (value: unknown) => value is {
    state: "pending";
    promptId?: string;
    acceptedAt?: string;
    reason?: "external_writer";
} | {
    state: "unknown";
} | {
    state: "settled";
    terminalOutcome: "settled";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
} | {
    errorCode: "aborted";
    state: "aborted";
    terminalOutcome: "aborted";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
} | {
    errorCode: "interrupted" | "external_writer" | "provider_error" | "sdk_error" | "rejected";
    state: "failed";
    terminalOutcome: "failed";
    promptId?: string;
    acceptedAt?: string;
    settledAt?: string;
    finalCursor?: {
        entryId: string | null;
        epoch: number;
    };
};
export declare function isOperationResult<O extends Operation>(operationName: O, value: unknown): value is OperationResult<O>;
export declare function isCustomEntryData<T extends CustomEntryType>(customType: T, value: unknown): value is CustomEntryData<T>;
export type { JsonObject, JsonValue };
//# sourceMappingURL=canonical.d.ts.map