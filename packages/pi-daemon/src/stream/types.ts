import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type {
  Cursor,
  ErrorCode,
  JsonValue,
  OperationResult,
  SessionSummary,
  StreamFrame,
} from "../protocol/index.js";
import type {
  HostCommittedEntry,
  HostSdkEvent,
  HostUiRequest,
} from "../host/index.js";
import type { StreamBackpressureOptions } from "./backpressure.js";

export interface StreamSessionCapture {
  readonly epoch: number;
  readonly generation: number;
  readonly leafId: string | null;
  readonly activeBranch: readonly SessionEntry[];
  readonly allEntries: readonly SessionEntry[];
  readonly summary: SessionSummary;
}

export interface StreamSessionState {
  readonly epoch: number;
  readonly generation: number;
}

export interface StreamSessionSource {
  readonly sessionId: string;
  readonly committedSequence: number;
  currentState(): StreamSessionState;
  capture(): StreamSessionCapture;
  subscribeCommittedEntries(
    listener: (committed: HostCommittedEntry) => void,
  ): () => void;
  subscribeSdkEvents(listener: (event: HostSdkEvent) => void): () => void;
  subscribeUi?(listener: (request: HostUiRequest) => void): () => void;
}

export type StreamFrameSender = (frame: StreamFrame) => Promise<void>;

export type StreamSessionResolver = (
  sessionId: string,
) => StreamSessionSource | undefined;

export interface StreamEngineIds {
  attachmentId(): string;
  replayId(): string;
}

export interface StreamEngineOptions {
  readonly resolveSession: StreamSessionResolver;
  readonly ids?: Partial<StreamEngineIds>;
  readonly keepaliveMs?: number;
  readonly now?: () => Date;
  readonly backpressure?: StreamBackpressureOptions;
  readonly releaseAttachment?: (
    sessionId: string,
    attachmentId: string,
  ) => void | Promise<void>;
}

export interface AttachStreamRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly fromCursor: Cursor | null;
  readonly live: boolean;
  readonly send: StreamFrameSender;
  readonly signal?: AbortSignal;
}

export interface ReplayStreamRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
  readonly fromCursor: Cursor | null;
  readonly throughEntryId?: string;
}

export interface DetachStreamRequest {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
}

export type AttachStreamResult = OperationResult<"attach">;
export type ReplayStreamResult = OperationResult<"replay">;
export type DetachStreamResult = OperationResult<"detach">;

export interface ReplayCursorSnapshot {
  readonly epoch: number;
  readonly activeBranch: readonly SessionEntry[];
  readonly allEntries: readonly SessionEntry[];
}

export type ReplayCursorPlan =
  | {
      readonly outcome: "ok";
      readonly from: Cursor;
      readonly startIndex: number;
    }
  | {
      readonly outcome: "cursor_off_branch";
      readonly from: Cursor;
      readonly forkPoint: Cursor;
      readonly startIndex: number;
    };

export class StreamRequestError extends Error {
  readonly code: ErrorCode;
  readonly details?: JsonValue;

  constructor(code: ErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "StreamRequestError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
