import type { OperationParams, RequestFrame } from "../protocol/index.js";
import { sanitizeAttributionLabel } from "../prompt/attribution.js";
import {
  type ControlAttribution,
  type PromptController,
} from "../prompt/index.js";
import {
  ServerRequestError,
  type RequestDispatchContext,
  type RequestDispatcher,
} from "../server/index.js";

export { sanitizeAttributionLabel } from "../prompt/attribution.js";

function requiredSession(request: RequestFrame): string {
  if (request.session === undefined) {
    throw new ServerRequestError("invalid_request", `${request.op} requires a session`);
  }
  return request.session;
}

function controlAttribution(
  context: RequestDispatchContext,
  label: string | undefined,
): ControlAttribution {
  return {
    actorId: context.actorId,
    ...(label === undefined ? {} : { label: sanitizeAttributionLabel(label) }),
  };
}

export function createControlRequestDispatcher(
  controller: PromptController,
): RequestDispatcher {
  return async (request: RequestFrame, context: RequestDispatchContext) => {
    switch (request.op) {
      case "steer":
      case "follow_up": {
        const params: OperationParams<typeof request.op> = request.params;
        const input = {
          sessionId: requiredSession(request),
          connectionId: context.connectionId,
          attachmentId: params.attachmentId,
          generation: params.generation,
          text: params.text,
          attribution: controlAttribution(context, params.attribution?.label),
        };
        return request.op === "steer"
          ? await controller.steer(input)
          : await controller.followUp(input);
      }
      case "abort":
        return await controller.abort({
          sessionId: requiredSession(request),
          connectionId: context.connectionId,
          attachmentId: request.params.attachmentId,
          leaseId: request.params.leaseId,
          generation: request.params.generation,
          ...(request.params.reason === undefined ? {} : { reason: request.params.reason }),
        });
      default:
        throw new ServerRequestError(
          "unavailable",
          `operation ${request.op} is not handled by the control controller`,
        );
    }
  };
}
