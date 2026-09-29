import {
  ERROR_CODES,
  type ErrorCode,
  type RequestFrame,
} from "../protocol/index.js";
import { projectSessionSummary } from "../session/index.js";
import {
  ServerRequestError,
  type RequestDispatchContext,
  type RequestDispatcher,
} from "../server/index.js";
import type { SessionHostController } from "./session-host.js";

export interface RecoverAttachmentInput {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
}

export interface RecoverRequestDispatcherOptions {
  readonly hostController: Pick<SessionHostController, "recover">;
  readonly assertAttached: (
    input: RecoverAttachmentInput,
  ) => void | Promise<void>;
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
  return new ServerRequestError("internal", "recover handler failed");
}

export function createRecoverRequestDispatcher(
  options: RecoverRequestDispatcherOptions,
): RequestDispatcher {
  return async (request: RequestFrame, context: RequestDispatchContext) => {
    if (request.op !== "recover") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by the recover dispatcher`,
      );
    }
    const sessionId = requiredSession(request);
    try {
      await options.assertAttached({
        sessionId,
        connectionId: context.connectionId,
        attachmentId: request.params.attachmentId,
      });
      const recovered = await options.hostController.recover(sessionId, {
        attachmentId: request.params.attachmentId,
        generation: request.params.generation,
        ...(request.params.leaseId === undefined
          ? {}
          : { leaseId: request.params.leaseId }),
      });
      return {
        recovered: true,
        closedPromptIds: [...recovered.closedPromptIds],
        session: projectSessionSummary(recovered.session),
      };
    } catch (error) {
      throw requestError(error);
    }
  };
}
