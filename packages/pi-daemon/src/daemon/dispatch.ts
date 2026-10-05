import { createControlRequestDispatcher } from "../control/index.js";
import {
  SessionHostController,
  SessionHostError,
  createRecoverRequestDispatcher,
  createUiAnswerRequestDispatcher,
  type SessionHostControllerOptions,
} from "../host/index.js";
import { LeaseArbiter } from "../lease/index.js";
import { PromptController, createPromptRequestDispatcher } from "../prompt/index.js";
import {
  ERROR_CODES,
  isOperationResult,
  type ErrorCode,
  type JsonValue,
  type Operation,
  type RequestFrame,
} from "../protocol/index.js";
import { Registry } from "../registry/index.js";
import {
  ServerRequestError,
  type RequestDispatcher,
} from "../server/index.js";
import {
  ColdSessionOperations,
  SessionLockRegistry,
  projectSessionSummary,
} from "../session/index.js";
import {
  StreamEngine,
  StreamRequestError,
  createSessionStreamSource,
  createStreamRequestDispatcher,
  type BindableStreamSessionSource,
} from "../stream/index.js";

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const MAXIMUM_DATE_MS = 8_640_000_000_000_000;

export interface DaemonShutdownRequest {
  readonly deadlineMs: number;
}

export interface DaemonDispatchOptions {
  readonly registry: Registry;
  readonly agentDir: string;
  readonly daemon: {
    readonly pid: number;
    readonly startedAt: string;
    readonly version: string;
    readonly sdkVersion: string;
    readonly protocolVersion: string;
    readonly socketPath: string;
    readonly launchPath: string;
  };
  readonly onShutdownAccepted: (request: DaemonShutdownRequest) => void | Promise<void>;
  readonly sessionOptions?: SessionHostControllerOptions["sessionOptions"];
  readonly resourceLoaderOptions?: SessionHostControllerOptions["resourceLoaderOptions"];
  readonly sdkCompatibility?: SessionHostControllerOptions["sdkCompatibility"];
  readonly now?: () => number;
}

export interface DaemonDispatchRuntime {
  readonly dispatch: RequestDispatcher;
  restoreAfterCrash(): Promise<void>;
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

interface AttachmentRecord {
  readonly sessionId: string;
  readonly connectionId: string;
}

interface DispatchRegistration {
  readonly name: string;
  readonly operations: readonly Operation[];
  readonly dispatch: RequestDispatcher;
}

function requiredSession(request: RequestFrame): string {
  if (request.session === undefined) {
    throw new ServerRequestError("invalid_request", `${request.op} requires a session`);
  }
  return request.session;
}

function requestError(error: unknown): ServerRequestError {
  if (error instanceof ServerRequestError) return error;
  if (error instanceof SessionHostError) {
    switch (error.code) {
      case "host_busy":
        return new ServerRequestError("busy", error.message);
      case "external_writer":
      case "invalid_state":
      case "sdk_incompatible":
      case "unknown_session":
        return new ServerRequestError(error.code, error.message);
      case "controller_disposed":
        return new ServerRequestError("internal", "daemon operation failed");
    }
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(error.code)
  ) {
    return new ServerRequestError(error.code as ErrorCode, error.message);
  }
  return new ServerRequestError("internal", "daemon operation failed");
}

export function createDaemonDispatch(options: DaemonDispatchOptions): DaemonDispatchRuntime {
  const now = options.now ?? Date.now;
  const lockRegistry = new SessionLockRegistry();
  const coldSessions = new ColdSessionOperations({
    registry: options.registry,
    lockRegistry,
    agentDir: options.agentDir,
  });
  const sources = new Map<string, BindableStreamSessionSource>();
  const attachments = new Map<string, AttachmentRecord>();
  const hostReference: { current?: SessionHostController } = {};
  const pendingModelDrop: { controller?: PromptController } = {};
  const leaseArbiter = new LeaseArbiter({
    registry: options.registry,
    defaultTtlMs: DEFAULT_LEASE_TTL_MS,
    getAwakeHost: (sessionId) => hostReference.current?.get(sessionId),
    onLeaseChanged: async (sessionId, reason) => {
      await pendingModelDrop.controller?.dropPendingModel(sessionId, reason);
    },
  });
  const hostController = new SessionHostController({
    registry: options.registry,
    lockRegistry,
    agentDir: options.agentDir,
    leaseArbiter,
    ...(options.sessionOptions === undefined
      ? {}
      : { sessionOptions: options.sessionOptions }),
    ...(options.resourceLoaderOptions === undefined
      ? {}
      : { resourceLoaderOptions: options.resourceLoaderOptions }),
    ...(options.sdkCompatibility === undefined
      ? {}
      : { sdkCompatibility: options.sdkCompatibility }),
    // Every sleep path (idle timeout included) must unbind the stream source,
    // or a cached broker keeps reporting the disposed host.
    onHostReleased: (sessionId) => sources.get(sessionId)?.bindHost(undefined),
  });
  hostReference.current = hostController;

  const sourceFor = (sessionId: string): BindableStreamSessionSource => {
    const session = options.registry.getSession(sessionId);
    if (session === undefined) {
      throw new StreamRequestError("unknown_session", `unknown session: ${sessionId}`);
    }
    let source = sources.get(sessionId);
    if (source === undefined) {
      source = createSessionStreamSource({
        sessionId,
        getSessionSummary: () => {
          const current = options.registry.getSession(sessionId);
          if (current === undefined) {
            throw new StreamRequestError("unknown_session", `unknown session: ${sessionId}`);
          }
          return projectSessionSummary(current);
        },
      });
      sources.set(sessionId, source);
    }
    source.bindHost(hostController.get(sessionId));
    return source;
  };

  const streamEngine = new StreamEngine({
    resolveSession: sourceFor,
    releaseAttachment: async (sessionId, attachmentId) => {
      attachments.delete(attachmentId);
      await leaseArbiter.releaseByAttachment(sessionId, attachmentId);
    },
  });

  const assertAttached = async (input: {
    readonly sessionId: string;
    readonly connectionId: string;
    readonly attachmentId: string;
  }): Promise<void> => {
    const attached = attachments.get(input.attachmentId);
    if (
      attached === undefined ||
      attached.sessionId !== input.sessionId ||
      attached.connectionId !== input.connectionId
    ) {
      throw new ServerRequestError("not_attached", "attachment does not belong to this connection");
    }
  };

  const promptController = new PromptController({
    registry: options.registry,
    leaseArbiter,
    getAwakeHost: (sessionId) => hostController.get(sessionId),
    assertAttached,
  });
  pendingModelDrop.controller = promptController;
  const rawUiAnswerDispatch = createUiAnswerRequestDispatcher({ leaseArbiter, hostController });
  const connectionBoundUiAnswerDispatch: RequestDispatcher = async (request, context) => {
    if (request.op === "ui_answer") {
      await assertAttached({
        sessionId: requiredSession(request),
        connectionId: context.connectionId,
        attachmentId: request.params.attachmentId,
      });
    }
    return await rawUiAnswerDispatch(request, context);
  };

  const streamDispatch = createStreamRequestDispatcher(streamEngine);
  const trackedStreamDispatch: RequestDispatcher = async (request, context) => {
    const result = await streamDispatch(request, context);
    if (request.op === "attach" && isOperationResult("attach", result)) {
      attachments.set(result.attachmentId, {
        sessionId: requiredSession(request),
        connectionId: context.connectionId,
      });
    } else if (request.op === "detach" && isOperationResult("detach", result)) {
      attachments.delete(request.params.attachmentId);
    }
    return result;
  };

  const coldSessionDispatch: RequestDispatcher = async (request) => {
    try {
      switch (request.op) {
        case "create":
          return coldSessions.create(request.params);
        case "open":
          return coldSessions.open(request.params);
        case "list":
          return coldSessions.list(request.params);
        default:
          throw new ServerRequestError(
            "unavailable",
            `operation ${request.op} is not handled by cold session operations`,
          );
      }
    } catch (error) {
      throw requestError(error);
    }
  };

  const leaseDispatch: RequestDispatcher = async (request, context) => {
    if (request.op !== "lease") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by the lease arbiter`,
      );
    }
    const sessionId = requiredSession(request);
    await assertAttached({
      sessionId,
      connectionId: context.connectionId,
      attachmentId: request.params.attachmentId,
    });
    try {
      switch (request.params.action) {
        case "acquire": {
          const grant = await leaseArbiter.acquire({
            sessionId,
            connectionId: context.connectionId,
            attachmentId: request.params.attachmentId,
            actorId: context.actorId,
            generation: request.params.generation,
            ...(request.params.ttlMs === undefined ? {} : { ttlMs: request.params.ttlMs }),
          });
          return {
            leaseId: grant.leaseId,
            holder: {
              connectionId: grant.holder.connectionId,
              attachmentId: grant.holder.attachmentId,
            },
            generation: grant.generation,
            expiresAt: grant.expiresAt,
            ttlMs: grant.ttlMs,
          };
        }
        case "takeover": {
          const grant = await leaseArbiter.takeover({
            sessionId,
            connectionId: context.connectionId,
            attachmentId: request.params.attachmentId,
            actorId: context.actorId,
            generation: request.params.generation,
            reason: request.params.reason,
            ...(request.params.ttlMs === undefined ? {} : { ttlMs: request.params.ttlMs }),
          });
          return {
            leaseId: grant.leaseId,
            holder: {
              connectionId: grant.holder.connectionId,
              attachmentId: grant.holder.attachmentId,
            },
            generation: grant.generation,
            expiresAt: grant.expiresAt,
            ttlMs: grant.ttlMs,
          };
        }
        case "heartbeat": {
          const heartbeat = await leaseArbiter.heartbeat({
            sessionId,
            attachmentId: request.params.attachmentId,
            leaseId: request.params.leaseId,
            generation: request.params.generation,
          });
          return {
            leaseId: heartbeat.leaseId,
            generation: heartbeat.generation,
            expiresAt: heartbeat.expiresAt,
          };
        }
        case "release": {
          await leaseArbiter.release({
            sessionId,
            attachmentId: request.params.attachmentId,
            leaseId: request.params.leaseId,
            generation: request.params.generation,
          });
          return { released: true };
        }
      }
    } catch (error) {
      throw requestError(error);
    }
  };

  const lifecycleDispatch: RequestDispatcher = async (request, context) => {
    if (request.op !== "wake" && request.op !== "sleep") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by session lifecycle`,
      );
    }
    const sessionId = requiredSession(request);
    await assertAttached({
      sessionId,
      connectionId: context.connectionId,
      attachmentId: request.params.attachmentId,
    });
    const before = options.registry.getSession(sessionId);
    if (before === undefined) {
      throw new ServerRequestError("unknown_session", `unknown session: ${sessionId}`);
    }
    if (before.generation !== request.params.generation) {
      throw new ServerRequestError("stale_generation", "session generation is stale");
    }
    try {
      if (request.op === "wake") {
        await hostController.wake(sessionId);
        sourceFor(sessionId).bindHost(hostController.get(sessionId));
        const current = options.registry.getSession(sessionId);
        if (current === undefined) throw new Error("session disappeared during wake");
        return { woke: before.runtimeState !== "awake", session: projectSessionSummary(current) };
      }
      await hostController.sleep(sessionId, {
        attachmentId: request.params.attachmentId,
        generation: request.params.generation,
        ...(request.params.leaseId === undefined ? {} : { leaseId: request.params.leaseId }),
        ...(request.params.reason === undefined ? {} : { reason: request.params.reason }),
      });
      sourceFor(sessionId).bindHost(undefined);
      const current = options.registry.getSession(sessionId);
      if (current === undefined) throw new Error("session disappeared during sleep");
      return { slept: true, session: projectSessionSummary(current) };
    } catch (error) {
      throw requestError(error);
    }
  };

  const statusDispatch: RequestDispatcher = async (request) => {
    if (request.op !== "status") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by daemon status`,
      );
    }
    if (request.session !== undefined) {
      const session = options.registry.getSession(request.session);
      if (session === undefined) {
        throw new ServerRequestError("unknown_session", `unknown session: ${request.session}`);
      }
      const lease = options.registry.getLease(request.session);
      return {
        session: projectSessionSummary(session),
        ...(lease === undefined
          ? {}
          : { lease: { held: true, expiresAt: new Date(lease.expiresAtMs).toISOString() } }),
        readers: [...attachments.values()].filter(({ sessionId }) => sessionId === request.session)
          .length,
      };
    }
    const sessions = options.registry.listSessions().map(projectSessionSummary);
    return {
      daemon: {
        pid: options.daemon.pid,
        startedAt: options.daemon.startedAt,
        version: options.daemon.version,
        sdkVersion: options.daemon.sdkVersion,
        protocol: options.daemon.protocolVersion,
        socket: options.daemon.socketPath,
        launchPath: options.daemon.launchPath,
      },
      counts: {
        sessions: sessions.length,
        awake: sessions.filter(({ runtime }) => runtime === "awake").length,
        readers: attachments.size,
      },
      ...(request.params.verbose === true ? { sessions } : {}),
    };
  };

  let shutdownDeadlineMs: number | undefined;
  let activeRequests = 0;
  const shutdownDispatch: RequestDispatcher = (request, context) => {
    if (request.op !== "shutdown") {
      throw new ServerRequestError(
        "unavailable",
        `operation ${request.op} is not handled by daemon shutdown`,
      );
    }
    if (shutdownDeadlineMs !== undefined) {
      throw new ServerRequestError(
        "shutdown_in_progress",
        "daemon shutdown is already in progress",
      );
    }
    if (request.params.ifIdle === true) {
      const hasWork = options.registry.listSessions().some((session) => {
        const { observedPhase } = projectSessionSummary(session);
        return observedPhase === "working" || observedPhase === "blocked";
      });
      if (hasWork || attachments.size > 0 || activeRequests > 1) {
        throw new ServerRequestError("busy", "daemon has active work or attached readers");
      }
    }
    const requestedGraceMs = request.params.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    shutdownDeadlineMs = Math.min(MAXIMUM_DATE_MS, now() + requestedGraceMs);
    if (context.afterResponseSent === undefined) {
      shutdownDeadlineMs = undefined;
      throw new ServerRequestError(
        "internal",
        "server cannot defer shutdown until after its response",
      );
    }
    const accepted = { deadlineMs: shutdownDeadlineMs };
    context.afterResponseSent(() => options.onShutdownAccepted(accepted));
    return {
      accepted: true,
      deadline: new Date(shutdownDeadlineMs).toISOString(),
    };
  };

  const registrations: readonly DispatchRegistration[] = [
    {
      name: "cold-session",
      operations: ["list", "open", "create"],
      dispatch: coldSessionDispatch,
    },
    {
      name: "stream-phase",
      operations: ["attach", "replay", "detach"],
      dispatch: trackedStreamDispatch,
    },
    {
      name: "lease",
      operations: ["lease"],
      dispatch: leaseDispatch,
    },
    {
      name: "prompt",
      operations: ["prompt", "prompt_status"],
      dispatch: createPromptRequestDispatcher(promptController),
    },
    {
      name: "control",
      operations: ["steer", "follow_up", "set_model", "abort"],
      dispatch: createControlRequestDispatcher(promptController),
    },
    {
      name: "ui-answer",
      operations: ["ui_answer"],
      dispatch: connectionBoundUiAnswerDispatch,
    },
    {
      name: "session-lifecycle",
      operations: ["sleep", "wake"],
      dispatch: lifecycleDispatch,
    },
    {
      name: "status",
      operations: ["status"],
      dispatch: statusDispatch,
    },
    {
      name: "recover",
      operations: ["recover"],
      dispatch: createRecoverRequestDispatcher({ hostController, assertAttached }),
    },
    {
      name: "shutdown",
      operations: ["shutdown"],
      dispatch: shutdownDispatch,
    },
  ];
  const routes = new Map<Operation, DispatchRegistration>();
  for (const registration of registrations) {
    for (const operation of registration.operations) {
      if (routes.has(operation)) {
        throw new Error(`duplicate daemon dispatcher registration for ${operation}`);
      }
      routes.set(operation, registration);
    }
  }

  return {
    dispatch: async (request, context): Promise<JsonValue> => {
      if (shutdownDeadlineMs !== undefined && request.op !== "shutdown") {
        throw new ServerRequestError("unavailable", "daemon shutdown is in progress");
      }
      const registration = routes.get(request.op);
      if (registration === undefined) {
        throw new ServerRequestError("unavailable", `operation ${request.op} is unavailable`);
      }
      activeRequests += 1;
      try {
        return await registration.dispatch(request, context);
      } finally {
        activeRequests -= 1;
      }
    },
    async restoreAfterCrash(): Promise<void> {
      await hostController.restoreAfterCrash();
    },
    async drain(): Promise<void> {
      await promptController.drain();
    },
    async dispose(): Promise<void> {
      let failure: unknown;
      try {
        await promptController.drain();
      } catch (error) {
        failure = error;
      }
      promptController.dispose();
      streamEngine.dispose();
      for (const source of sources.values()) source.dispose();
      sources.clear();
      try {
        await hostController.dispose();
      } catch (error) {
        failure ??= error;
      }
      coldSessions.dispose();
      if (failure !== undefined) throw failure;
    },
  };
}
