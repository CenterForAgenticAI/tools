import type { ErrorCode } from "../protocol/index.js";

export type SessionOperationErrorCode = Extract<
  ErrorCode,
  | "duplicate_session"
  | "invalid_request"
  | "gone"
  | "path_mismatch"
  | "sdk_incompatible"
  | "session_locked"
  | "unknown_session"
>;

export class SessionOperationError extends Error {
  readonly code: SessionOperationErrorCode;

  constructor(code: SessionOperationErrorCode, message: string) {
    super(message);
    this.name = "SessionOperationError";
    this.code = code;
  }
}
