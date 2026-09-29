import type { JsonValue, RequestFrame } from "../protocol/index.js";
import {
  ServerRequestError,
  type RequestDispatchContext,
  type RequestDispatcher,
} from "../server/index.js";
import { StreamEngine } from "./stream-engine.js";
import { StreamRequestError } from "./types.js";

export interface StreamRequestDispatcherOptions {
  readonly recover?: RequestDispatcher;
}

function requiredSession(request: RequestFrame): string {
  if (request.session === undefined) {
    throw new ServerRequestError("invalid_request", `${request.op} requires a session`);
  }
  return request.session;
}

async function dispatchStreamRequest(
  engine: StreamEngine,
  options: StreamRequestDispatcherOptions,
  request: RequestFrame,
  context: RequestDispatchContext,
): Promise<JsonValue> {
  try {
    switch (request.op) {
      case "attach":
        return await engine.attach({
          sessionId: requiredSession(request),
          connectionId: context.connectionId,
          fromCursor: request.params.fromCursor ?? null,
          live: request.params.live ?? true,
          send: context.sendStream,
          signal: context.signal,
        });
      case "replay":
        return await engine.replay({
          sessionId: requiredSession(request),
          connectionId: context.connectionId,
          attachmentId: request.params.attachmentId,
          fromCursor: request.params.fromCursor,
          ...(request.params.throughEntryId === undefined
            ? {}
            : { throughEntryId: request.params.throughEntryId }),
        });
      case "detach":
        return await engine.detach({
          sessionId: requiredSession(request),
          connectionId: context.connectionId,
          attachmentId: request.params.attachmentId,
        });
      case "recover":
        if (options.recover !== undefined) {
          return await options.recover(request, context);
        }
        break;
      default:
        break;
    }
    throw new ServerRequestError(
      "unavailable",
      `operation ${request.op} is not handled by the stream engine`,
    );
  } catch (error) {
    if (error instanceof StreamRequestError) {
      throw new ServerRequestError(error.code, error.message, error.details);
    }
    throw error;
  }
}

export function createStreamRequestDispatcher(
  engine: StreamEngine,
  options: StreamRequestDispatcherOptions = {},
): RequestDispatcher {
  return async (request, context) =>
    await dispatchStreamRequest(engine, options, request, context);
}
