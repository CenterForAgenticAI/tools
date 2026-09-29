import type { SessionHostController } from "./session-host.js";
import type { LeaseArbiter } from "../lease/index.js";
import {
  ERROR_CODES,
  type ErrorCode,
  type RequestFrame,
} from "../protocol/index.js";
import {
  ServerRequestError,
  type RequestDispatcher,
} from "../server/index.js";

export interface UiAnswerRequestDispatcherOptions {
  readonly leaseArbiter: Pick<LeaseArbiter, "assertDriver">;
  readonly hostController: Pick<SessionHostController, "answerUiRequest">;
  readonly now?: () => number;
}

function requiredSession(request: RequestFrame): string {
  if (request.session === undefined) {
    throw new ServerRequestError("invalid_request", `${request.op} requires a session`);
  }
  return request.session;
}

function isErrorWithCode(error: unknown): error is Error & { readonly code: ErrorCode } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(error.code)
  );
}

function requestError(error: unknown): ServerRequestError {
  if (error instanceof ServerRequestError) return error;
  if (isErrorWithCode(error)) return new ServerRequestError(error.code, error.message);
  return new ServerRequestError("internal", "ui_answer handler failed");
}

export function createUiAnswerRequestDispatcher(
  options: UiAnswerRequestDispatcherOptions,
): RequestDispatcher {
  const now = options.now ?? Date.now;
  return async (request: RequestFrame) => {
    if (request.op !== "ui_answer") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by the ui_answer dispatcher`,
      );
    }

    const sessionId = requiredSession(request);
    try {
      await options.leaseArbiter.assertDriver({
        sessionId,
        attachmentId: request.params.attachmentId,
        leaseId: request.params.leaseId,
        generation: request.params.generation,
        nowMs: now(),
      });
      const outcome = options.hostController.answerUiRequest(
        sessionId,
        request.params.questionId,
        request.params.answer,
      );
      if (outcome === "unknown_question") {
        throw new ServerRequestError(
          "unknown_question",
          `unknown UI question for session ${sessionId}: ${request.params.questionId}`,
        );
      }
      if (outcome === "invalid_ui_answer") {
        throw new ServerRequestError(
          "invalid_ui_answer",
          `answer does not match UI question ${request.params.questionId}`,
        );
      }
      return { answered: true, questionId: request.params.questionId };
    } catch (error) {
      throw requestError(error);
    }
  };
}
