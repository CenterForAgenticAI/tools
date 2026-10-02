import { randomUUID } from "node:crypto";
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";

import {
  ERROR_CODES,
  OPERATIONS,
  OPERATION_ERROR_CODES,
  isOperationResult,
  isStreamFrame,
  type ErrorCode,
  type FailureFrame,
  type JsonValue,
  type RequestFrame,
  type StreamFrame,
  type SuccessFrame,
} from "../protocol/index.js";
import { prepareSocketEndpoint, resolveSocketPath, secureBoundSocket } from "./endpoint.js";
import {
  DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_BYTES,
  DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_FRAMES,
  FrameWriter,
  RequestFrameDecoder,
  type RequestDecoderEvent,
} from "./framing.js";

export const DEFAULT_MAX_INBOUND_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_KEEPALIVE_MS = 15_000;
export const DEFAULT_PROTOCOL_VERSION = "1.0";

export interface RequestDispatchContext {
  readonly connectionId: string;
  readonly actorId: string;
  readonly signal: AbortSignal;
  readonly sendStream: (frame: StreamFrame) => Promise<void>;
  readonly afterResponseSent?: (
    callback: () => void | Promise<void>,
  ) => void;
}

export type RequestDispatcher = (
  request: RequestFrame,
  context: RequestDispatchContext,
) => JsonValue | Promise<JsonValue>;

export interface UnixSocketServerOptions {
  readonly socketPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly protocolVersion?: string;
  readonly daemonVersion: string;
  readonly sdkVersion: string;
  readonly maxInboundRequestBytes?: number;
  readonly outboundQueueHighWaterFrames?: number;
  readonly outboundQueueHighWaterBytes?: number;
  readonly keepaliveMs?: number;
  readonly dispatch?: RequestDispatcher;
  readonly onError?: (error: Error) => void;
  readonly now?: () => Date;
}

export interface UnixSocketServer {
  readonly socketPath: string;
  listen(): Promise<void>;
  stopAccepting(): void;
  close(): Promise<void>;
}

export class ServerRequestError extends Error {
  readonly code: ErrorCode;
  readonly details?: JsonValue;

  constructor(code: ErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "ServerRequestError";
    if (!ERROR_CODES.includes(code)) throw new TypeError(`unknown protocol error code: ${code}`);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

type HandshakeState = "awaiting" | "ready" | "closing";

interface ConnectionState {
  readonly socket: Socket;
  readonly writer: FrameWriter;
  readonly decoder: RequestFrameDecoder;
  readonly connectionId: string;
  readonly actorId: string;
  readonly abortController: AbortController;
  readonly inFlight: Set<string>;
  handshake: HandshakeState;
  negotiatedProtocol?: string;
}

export class NodeUnixSocketServer implements UnixSocketServer {
  readonly socketPath: string;
  readonly #options: UnixSocketServerOptions;
  readonly #netServer: NetServer;
  readonly #connections = new Set<ConnectionState>();
  readonly #startedAt: string;
  readonly #protocolVersion: ParsedVersion;
  readonly #maxInboundRequestBytes: number;
  readonly #outboundQueueHighWaterFrames: number;
  readonly #outboundQueueHighWaterBytes: number;
  readonly #keepaliveMs: number;
  #listening = false;
  #closed = false;
  #stopRequested = false;
  // Connections the kernel accepted after bind but before listen() verified the
  // socket. They stay paused (pauseOnConnect) until verification settles.
  #heldDuringListen: Socket[] | undefined;
  #listenerClosePromise: Promise<void> | undefined;

  constructor(options: UnixSocketServerOptions) {
    this.#options = options;
    this.socketPath =
      options.socketPath ??
      resolveSocketPath({
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      });
    this.#protocolVersion = parseProtocolVersion(
      options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      "server protocol version",
    );
    this.#maxInboundRequestBytes = positiveSafeInteger(
      options.maxInboundRequestBytes ?? DEFAULT_MAX_INBOUND_REQUEST_BYTES,
      "maxInboundRequestBytes",
    );
    this.#outboundQueueHighWaterFrames = positiveSafeInteger(
      options.outboundQueueHighWaterFrames ?? DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_FRAMES,
      "outboundQueueHighWaterFrames",
    );
    this.#outboundQueueHighWaterBytes = positiveSafeInteger(
      options.outboundQueueHighWaterBytes ?? DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_BYTES,
      "outboundQueueHighWaterBytes",
    );
    this.#keepaliveMs = positiveSafeInteger(
      options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS,
      "keepaliveMs",
    );
    this.#startedAt = (options.now ?? (() => new Date()))().toISOString();
    this.#netServer = createNetServer({ pauseOnConnect: true }, (socket) => {
      this.#accept(socket);
    });
    this.#netServer.on("error", (error) => this.#options.onError?.(error));
  }

  async listen(): Promise<void> {
    if (this.#closed) throw new Error("server is closed");
    if (this.#listening) throw new Error("server is already listening");
    if (this.#stopRequested) throw new Error("server has stopped accepting");
    await prepareSocketEndpoint(this.socketPath);

    this.#heldDuringListen = [];
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        cleanup();
        rejectListen(error);
      };
      const onListening = () => {
        void (async () => {
          try {
            await secureBoundSocket(this.socketPath);
            if (this.#closed) throw new Error("server closed during listen");
            if (this.#stopRequested) throw new Error("server stopped accepting during listen");
            this.#listening = true;
            cleanup();
            this.#releaseHeldConnections(true);
            resolveListen();
          } catch (error) {
            cleanup();
            this.#releaseHeldConnections(false);
            await closeNetServer(this.#netServer);
            rejectListen(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      };
      const cleanup = () => {
        this.#netServer.off("error", onErrorBeforeListening);
        this.#netServer.off("listening", onListening);
      };

      const onErrorBeforeListening = (error: Error) => {
        this.#releaseHeldConnections(false);
        onError(error);
      };
      this.#netServer.once("error", onErrorBeforeListening);
      this.#netServer.once("listening", onListening);
      const previousUmask = process.umask(0o177);
      try {
        this.#netServer.listen(this.socketPath);
      } catch (error) {
        cleanup();
        rejectListen(error instanceof Error ? error : new Error(String(error)));
      } finally {
        process.umask(previousUmask);
      }
    });
  }

  stopAccepting(): void {
    // Latched so an in-flight listen() cannot start accepting after this returns.
    this.#stopRequested = true;
    this.#releaseHeldConnections(false);
    if (this.#closed || !this.#listening) return;
    this.#listening = false;
    this.#listenerClosePromise ??= closeNetServer(this.#netServer);
    for (const connection of this.#connections) {
      connection.handshake = "closing";
      connection.socket.end();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listening = false;
    this.#releaseHeldConnections(false);
    this.#listenerClosePromise ??= closeNetServer(this.#netServer);
    for (const connection of this.#connections) connection.socket.destroy();
    this.#connections.clear();
    await this.#listenerClosePromise;
  }

  #releaseHeldConnections(serve: boolean): void {
    const held = this.#heldDuringListen;
    this.#heldDuringListen = undefined;
    for (const socket of held ?? []) {
      if (serve && !socket.destroyed) this.#accept(socket);
      else socket.destroy();
    }
  }

  #accept(socket: Socket): void {
    if (!this.#listening && !this.#closed && this.#heldDuringListen !== undefined) {
      this.#heldDuringListen.push(socket);
      return;
    }
    if (!this.#listening || this.#closed) {
      socket.destroy();
      return;
    }

    const connection: ConnectionState = {
      socket,
      writer: new FrameWriter(socket, {
        highWaterFrames: this.#outboundQueueHighWaterFrames,
        highWaterBytes: this.#outboundQueueHighWaterBytes,
        onPressureChange: (pressured) => {
          if (socket.destroyed) return;
          if (pressured) socket.pause();
          else socket.resume();
        },
      }),
      decoder: new RequestFrameDecoder(this.#maxInboundRequestBytes),
      connectionId: `c_${randomUUID()}`,
      actorId: `a_${randomUUID()}`,
      abortController: new AbortController(),
      inFlight: new Set(),
      handshake: "awaiting",
    };
    this.#connections.add(connection);

    socket.on("data", (chunk: Buffer) => this.#receive(connection, chunk));
    socket.on("error", (error) => connection.writer.fail(error));
    socket.on("end", () => {
      const finalEvent = connection.decoder.finish();
      if (finalEvent !== undefined) this.#handleDecoderEvent(connection, finalEvent);
    });
    socket.on("close", () => {
      connection.abortController.abort();
      connection.writer.fail(new Error("socket closed"));
      this.#connections.delete(connection);
    });
    socket.resume();
  }

  #receive(connection: ConnectionState, chunk: Buffer): void {
    for (const event of connection.decoder.push(chunk)) {
      this.#handleDecoderEvent(connection, event);
      if (connection.handshake === "closing") break;
    }
  }

  #handleDecoderEvent(connection: ConnectionState, event: RequestDecoderEvent): void {
    if (connection.handshake === "closing") return;
    if (event.type === "framing_error") {
      this.#options.onError?.(new ServerRequestError(event.code, event.message));
      connection.handshake = "closing";
      connection.socket.end();
      return;
    }
    if (event.type === "invalid_request") {
      this.#handleInvalidRequest(connection, event);
      return;
    }
    this.#handleRequest(connection, event.request);
  }

  #handleInvalidRequest(
    connection: ConnectionState,
    event: Extract<RequestDecoderEvent, { type: "invalid_request" }>,
  ): void {
    if (event.id === undefined) {
      connection.handshake = "closing";
      connection.socket.end();
      return;
    }

    let code: ErrorCode = "invalid_request";
    let message = "request does not match the canonical protocol schema";
    if (connection.handshake === "awaiting" && event.operation !== "hello") {
      code = "handshake_required";
      message = "hello must complete before any other request";
    } else if (
      event.operation !== undefined &&
      !OPERATIONS.includes(event.operation as (typeof OPERATIONS)[number])
    ) {
      code = "unsupported_op";
      message = `unsupported operation: ${event.operation}`;
    }
    this.#writeWithoutCorrelationRelease(connection, failureFrame(event.id, code, message));
  }

  #handleRequest(connection: ConnectionState, request: RequestFrame): void {
    if (connection.inFlight.has(request.id)) {
      this.#writeWithoutCorrelationRelease(
        connection,
        failureFrame(request.id, "invalid_request", "duplicate in-flight request id"),
      );
      return;
    }
    connection.inFlight.add(request.id);

    if (connection.handshake === "awaiting") {
      if (!isHelloRequest(request)) {
        void this.#respondAndRelease(
          connection,
          request.id,
          failureFrame(request.id, "handshake_required", "hello must be the first request"),
        );
        return;
      }
      this.#completeHandshake(connection, request);
      return;
    }

    if (isHelloRequest(request)) {
      void this.#respondAndRelease(
        connection,
        request.id,
        failureFrame(request.id, "invalid_request", "hello has already completed"),
      );
      return;
    }

    void this.#dispatch(connection, request);
  }

  #completeHandshake(
    connection: ConnectionState,
    request: Extract<RequestFrame, { op: "hello" }>,
  ): void {
    const clientVersion = parseProtocolVersion(request.params.protocol, "client protocol version");
    if (clientVersion.major !== this.#protocolVersion.major) {
      connection.handshake = "closing";
      const response = failureFrame(
        request.id,
        "protocol_mismatch",
        `client protocol ${request.params.protocol} is incompatible with server protocol ${this.#protocolVersion.text}`,
      );
      void this.#respondAndRelease(connection, request.id, response).finally(() => {
        connection.socket.end();
      });
      return;
    }

    const minor =
      clientVersion.minor < this.#protocolVersion.minor
        ? clientVersion.minor
        : this.#protocolVersion.minor;
    connection.negotiatedProtocol = `${this.#protocolVersion.major}.${minor}`;
    connection.handshake = "ready";
    const response: SuccessFrame<"hello"> = {
      t: "res",
      id: request.id,
      ok: true,
      result: {
        protocol: connection.negotiatedProtocol,
        daemonVersion: this.#options.daemonVersion,
        sdkVersion: this.#options.sdkVersion,
        connectionId: connection.connectionId,
        maxInboundRequestBytes: this.#maxInboundRequestBytes,
        keepaliveMs: this.#keepaliveMs,
      },
    };
    void this.#respondAndRelease(connection, request.id, response);
  }

  async #dispatch(
    connection: ConnectionState,
    request: Exclude<RequestFrame, { op: "hello" }>,
  ): Promise<void> {
    const afterResponseCallbacks: Array<() => void | Promise<void>> = [];
    let acceptingCallbacks = true;
    let response: SuccessFrame | FailureFrame;
    try {
      const result = await this.#dispatchResult(
        connection,
        request,
        afterResponseCallbacks,
        () => acceptingCallbacks,
      );
      if (!isOperationResult(request.op, result)) {
        throw new ServerRequestError("internal", "handler returned an invalid operation result");
      }
      response = { t: "res", id: request.id, ok: true, result };
    } catch (error) {
      afterResponseCallbacks.length = 0;
      const requestError = normalizeRequestError(request.op, error);
      response = failureFrame(
        request.id,
        requestError.code,
        requestError.message,
        requestError.details,
      );
    } finally {
      acceptingCallbacks = false;
    }
    await this.#respondAndRelease(connection, request.id, response);
    for (const callback of afterResponseCallbacks) {
      void Promise.resolve()
        .then(callback)
        .catch((error: unknown) => {
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    }
  }

  async #dispatchResult(
    connection: ConnectionState,
    request: Exclude<RequestFrame, { op: "hello" }>,
    afterResponseCallbacks: Array<() => void | Promise<void>>,
    acceptingCallbacks: () => boolean,
  ): Promise<JsonValue> {
    if (
      request.op === "status" &&
      request.session === undefined &&
      this.#options.dispatch === undefined
    ) {
      return {
        daemon: {
          pid: process.pid,
          startedAt: this.#startedAt,
          version: this.#options.daemonVersion,
          sdkVersion: this.#options.sdkVersion,
          protocol: connection.negotiatedProtocol ?? this.#protocolVersion.text,
          socket: this.socketPath,
        },
        counts: { connections: this.#connections.size, sessions: 0 },
        ...(request.params.verbose === true ? { sessions: [] } : {}),
      };
    }
    if (this.#options.dispatch === undefined) {
      throw new ServerRequestError("unavailable", `operation ${request.op} is unavailable`);
    }

    const context: RequestDispatchContext = {
      connectionId: connection.connectionId,
      actorId: connection.actorId,
      signal: connection.abortController.signal,
      sendStream: async (frame) => {
        if (!isStreamFrame(frame)) {
          throw new TypeError("stream frame does not match the canonical protocol schema");
        }
        await connection.writer.write(frame);
      },
      afterResponseSent: (callback) => {
        if (!acceptingCallbacks()) {
          throw new Error("afterResponseSent must be registered before dispatch completes");
        }
        afterResponseCallbacks.push(callback);
      },
    };
    return await this.#options.dispatch(request, context);
  }

  #writeWithoutCorrelationRelease(
    connection: ConnectionState,
    response: SuccessFrame | FailureFrame,
  ): void {
    void connection.writer.write(response).catch((error: unknown) => {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async #respondAndRelease(
    connection: ConnectionState,
    requestId: string,
    response: SuccessFrame | FailureFrame,
  ): Promise<void> {
    try {
      await connection.writer.write(response);
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      connection.inFlight.delete(requestId);
    }
  }
}

export function createServer(options: UnixSocketServerOptions): UnixSocketServer {
  return new NodeUnixSocketServer(options);
}

export async function listen(options: UnixSocketServerOptions): Promise<UnixSocketServer> {
  const server = createServer(options);
  await server.listen();
  return server;
}

interface ParsedVersion {
  readonly text: string;
  readonly major: bigint;
  readonly minor: bigint;
}

function parseProtocolVersion(value: string, label: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new TypeError(`${label} must use MAJOR.MINOR form`);
  }
  return { text: value, major: BigInt(match[1]), minor: BigInt(match[2]) };
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function failureFrame(
  id: string,
  code: ErrorCode,
  message: string,
  details?: JsonValue,
): FailureFrame {
  return {
    t: "res",
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

function normalizeRequestError(
  operation: RequestFrame["op"],
  error: unknown,
): ServerRequestError {
  if (
    error instanceof ServerRequestError &&
    OPERATION_ERROR_CODES[operation].includes(error.code)
  ) {
    return error;
  }
  return new ServerRequestError("internal", "request handler failed");
}

function isHelloRequest(
  request: RequestFrame,
): request is Extract<RequestFrame, { op: "hello" }> {
  return request.op === "hello";
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
