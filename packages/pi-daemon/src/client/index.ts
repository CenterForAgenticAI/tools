import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isFailureFrame,
  isOperationResult,
  isStreamFrame,
  isSuccessFrame,
  type Cursor,
  type ErrorCode,
  type Operation,
  type OperationParams,
  type OperationResult,
  type StreamFrame,
} from "../protocol/index.js";

export const PACKAGE = "@caair/pi-daemon/client";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 20;
type ClientOperation = Exclude<Operation, "hello">;

export interface DaemonClientIdentity {
  readonly name: string;
  readonly version: string;
  readonly capabilities?: readonly string[];
}

export interface DaemonDisconnectInfo {
  readonly error: Error;
}

export interface DaemonClientHooks {
  readonly onDisconnect?: (info: DaemonDisconnectInfo) => void | Promise<void>;
  readonly onReconnect?: (client: DaemonClient) => void | Promise<void>;
}

export interface ConnectDaemonOptions {
  readonly socketPath?: string;
  readonly client: DaemonClientIdentity;
  readonly protocolVersion?: string;
  readonly autoSpawn?: boolean;
  readonly startupTimeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly stateDir?: string;
  readonly agentDir?: string;
  readonly daemonEntrypoint?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hooks?: DaemonClientHooks;
}

export interface SpawnDaemonProcessOptions {
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly agentDir?: string;
  readonly daemonEntrypoint?: string;
  readonly detached?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export class DaemonSpawnError extends Error {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  override readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "DaemonSpawnError";
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
    if (options.signal !== undefined) this.signal = options.signal;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class DaemonRequestError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DaemonRequestError";
    this.code = code;
    this.details = details;
  }
}

interface PendingResponse {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface QueueWaiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: Error) => void;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #ended: { readonly error?: Error } | undefined;

  push(value: T): void {
    if (this.#ended !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  end(error?: Error): void {
    if (this.#ended !== undefined) return;
    this.#ended = error === undefined ? {} : { error };
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#ended?.error !== undefined) throw this.#ended.error;
        if (this.#ended !== undefined) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<T>> => ({ done: true, value: undefined }),
    };
  }
}

class JsonLineDecoder {
  readonly #fragments: Buffer[] = [];
  #bytes = 0;

  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      if (fragment.length > 0) {
        this.#fragments.push(fragment);
        this.#bytes += fragment.length;
      }
      if (newline === -1) break;
      if (this.#bytes === 0) throw new Error("daemon returned a blank line");
      const encoded = Buffer.concat(this.#fragments, this.#bytes);
      this.#fragments.length = 0;
      this.#bytes = 0;
      try {
        frames.push(JSON.parse(encoded.toString("utf8")) as unknown);
      } catch {
        throw new Error("daemon returned invalid JSON");
      }
      offset = newline + 1;
    }
    return frames;
  }
}

export interface DaemonCursorStore {
  load(sessionId: string): Cursor | null | undefined | Promise<Cursor | null | undefined>;
  save(sessionId: string, cursor: Cursor): void | Promise<void>;
}

export interface DaemonAttachmentOptions {
  readonly cursorStore?: DaemonCursorStore;
  readonly onCursor?: (cursor: Cursor, frame: Extract<StreamFrame, { kind: "entry" }>) => void | Promise<void>;
}

export type AcquireLeaseOptions = Omit<
  Extract<OperationParams<"lease">, { action: "acquire" }>,
  "action" | "attachmentId" | "generation"
>;
export type TakeoverLeaseOptions = Omit<
  Extract<OperationParams<"lease">, { action: "takeover" }>,
  "action" | "attachmentId" | "generation"
>;
export type AttachmentWakeOptions = Omit<
  OperationParams<"wake">,
  "attachmentId" | "generation"
>;
export type AttachmentSleepOptions = Omit<
  OperationParams<"sleep">,
  "attachmentId" | "generation" | "leaseId"
>;
export type LeasePromptOptions = Omit<
  OperationParams<"prompt">,
  "attachmentId" | "leaseId" | "generation"
>;
export type LeaseAbortOptions = Omit<
  OperationParams<"abort">,
  "attachmentId" | "leaseId" | "generation"
>;
export type LeaseUiAnswerOptions = Omit<
  OperationParams<"ui_answer">,
  "attachmentId" | "leaseId" | "generation"
>;

export class DaemonAttachment implements AsyncIterable<StreamFrame> {
  readonly client: DaemonClient;
  readonly sessionId: string;
  readonly result: OperationResult<"attach">;
  readonly attachmentId: string;
  readonly #queue: AsyncQueue<StreamFrame>;
  readonly #options: DaemonAttachmentOptions;
  #cursor: Cursor | undefined;

  constructor(
    client: DaemonClient,
    sessionId: string,
    result: OperationResult<"attach">,
    queue: AsyncQueue<StreamFrame>,
    options: DaemonAttachmentOptions,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.result = result;
    this.attachmentId = result.attachmentId;
    this.#queue = queue;
    this.#options = options;
  }

  get cursor(): Cursor | undefined {
    return this.#cursor;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamFrame> {
    return this.#queue[Symbol.asyncIterator]();
  }

  async acknowledge(frame: Extract<StreamFrame, { kind: "entry" }>): Promise<void> {
    await this.#options.cursorStore?.save(this.sessionId, frame.cursor);
    await this.#options.onCursor?.(frame.cursor, frame);
    this.#cursor = frame.cursor;
  }

  async wake(
    generation: number,
    options: AttachmentWakeOptions = {},
  ): Promise<OperationResult<"wake">> {
    return await this.client.request(
      "wake",
      { ...options, attachmentId: this.attachmentId, generation },
      this.sessionId,
    );
  }

  async sleep(
    generation: number,
    options: AttachmentSleepOptions = {},
  ): Promise<OperationResult<"sleep">> {
    return await this.client.request(
      "sleep",
      { ...options, attachmentId: this.attachmentId, generation },
      this.sessionId,
    );
  }

  async recover(
    generation: number,
    options: { readonly leaseId?: string } = {},
  ): Promise<OperationResult<"recover">> {
    return await this.client.recover(this.sessionId, {
      ...options,
      attachmentId: this.attachmentId,
      generation,
    });
  }

  async promptStatus(
    params: OperationParams<"prompt_status">,
  ): Promise<OperationResult<"prompt_status">> {
    return await this.client.promptStatus(this.sessionId, params);
  }

  async steer(
    generation: number,
    params: Omit<OperationParams<"steer">, "attachmentId" | "generation">,
  ): Promise<OperationResult<"steer">> {
    return await this.client.request(
      "steer",
      { ...params, attachmentId: this.attachmentId, generation },
      this.sessionId,
    );
  }

  async followUp(
    generation: number,
    params: Omit<OperationParams<"follow_up">, "attachmentId" | "generation">,
  ): Promise<OperationResult<"follow_up">> {
    return await this.client.request(
      "follow_up",
      { ...params, attachmentId: this.attachmentId, generation },
      this.sessionId,
    );
  }

  async acquireLease(
    generation: number,
    options: AcquireLeaseOptions = {},
  ): Promise<DaemonLease> {
    const result = await this.client.request(
      "lease",
      {
        ...options,
        action: "acquire",
        attachmentId: this.attachmentId,
        generation,
      },
      this.sessionId,
    );
    if (!("holder" in result)) throw new Error("daemon returned an invalid lease grant");
    return new DaemonLease(this, result);
  }

  async takeoverLease(
    generation: number,
    options: TakeoverLeaseOptions,
  ): Promise<DaemonLease> {
    const result = await this.client.request(
      "lease",
      {
        ...options,
        action: "takeover",
        attachmentId: this.attachmentId,
        generation,
      },
      this.sessionId,
    );
    if (!("holder" in result)) throw new Error("daemon returned an invalid lease grant");
    return new DaemonLease(this, result);
  }

  async replay(
    params: Omit<OperationParams<"replay">, "attachmentId">,
  ): Promise<OperationResult<"replay">> {
    return await this.client.request(
      "replay",
      { ...params, attachmentId: this.attachmentId },
      this.sessionId,
    );
  }

  async detach(): Promise<OperationResult<"detach">> {
    const result = await this.client.request(
      "detach",
      { attachmentId: this.attachmentId },
      this.sessionId,
    );
    this.#queue.end();
    return result;
  }
}
export type LeaseGrant = Extract<OperationResult<"lease">, { holder: unknown }>;
export type LeaseHeartbeatResult = Exclude<
  OperationResult<"lease">,
  LeaseGrant | { released: true }
>;
export type LeaseReleaseResult = Extract<OperationResult<"lease">, { released: true }>;

export class DaemonLease {
  readonly attachment: DaemonAttachment;
  readonly grant: LeaseGrant;
  readonly leaseId: string;
  readonly generation: number;
  #expiresAt: string;
  #released = false;

  constructor(attachment: DaemonAttachment, grant: LeaseGrant) {
    this.attachment = attachment;
    this.grant = grant;
    this.leaseId = grant.leaseId;
    this.generation = grant.generation;
    this.#expiresAt = grant.expiresAt;
  }

  get expiresAt(): string {
    return this.#expiresAt;
  }

  get released(): boolean {
    return this.#released;
  }

  async heartbeat(): Promise<LeaseHeartbeatResult> {
    const result = await this.attachment.client.request(
      "lease",
      {
        action: "heartbeat",
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
    if (!("expiresAt" in result) || "holder" in result) {
      throw new Error("daemon returned an invalid lease heartbeat");
    }
    this.#expiresAt = result.expiresAt;
    return result;
  }

  async release(): Promise<LeaseReleaseResult> {
    const result = await this.attachment.client.request(
      "lease",
      {
        action: "release",
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
    if (!("released" in result)) throw new Error("daemon returned an invalid lease release");
    this.#released = true;
    return result;
  }

  async prompt(params: LeasePromptOptions): Promise<OperationResult<"prompt">> {
    return await this.attachment.client.request(
      "prompt",
      {
        ...params,
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
  }

  async abort(params: LeaseAbortOptions = {}): Promise<OperationResult<"abort">> {
    return await this.attachment.client.request(
      "abort",
      {
        ...params,
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
  }

  async answerUi(params: LeaseUiAnswerOptions): Promise<OperationResult<"ui_answer">> {
    return await this.attachment.client.request(
      "ui_answer",
      {
        ...params,
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
  }

  async sleep(options: AttachmentSleepOptions = {}): Promise<OperationResult<"sleep">> {
    return await this.attachment.client.request(
      "sleep",
      {
        ...options,
        attachmentId: this.attachment.attachmentId,
        leaseId: this.leaseId,
        generation: this.generation,
      },
      this.attachment.sessionId,
    );
  }

  async recover(): Promise<OperationResult<"recover">> {
    return await this.attachment.recover(this.generation, { leaseId: this.leaseId });
  }
}



interface DaemonClientConnectionOptions {
  readonly hooks?: DaemonClientHooks;
  readonly reconnect?: () => Promise<DaemonClient>;
}

export class DaemonClient {
  readonly hello: OperationResult<"hello">;
  readonly #socket: Socket;
  readonly #pending = new Map<string, PendingResponse>();
  readonly #attachmentFrames = new Map<string, AsyncQueue<StreamFrame>>();
  readonly #decoder = new JsonLineDecoder();
  readonly #connectionOptions: DaemonClientConnectionOptions;
  #disconnectComplete: Promise<void> = Promise.resolve();
  #nextRequestId = 1;
  #closed = false;

  constructor(
    socket: Socket,
    hello: OperationResult<"hello">,
    connectionOptions: DaemonClientConnectionOptions = {},
  ) {
    this.#socket = socket;
    this.hello = hello;
    this.#connectionOptions = connectionOptions;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("daemon socket closed")));
  }

  get closed(): boolean {
    return this.#closed;
  }

  async request<O extends ClientOperation>(
    operation: O,
    params: OperationParams<O>,
    session?: string,
  ): Promise<OperationResult<O>> {
    const id = `client-${this.#nextRequestId}`;
    this.#nextRequestId += 1;
    return await this.requestWithId(id, operation, params, session);
  }

  async requestWithId<O extends ClientOperation>(
    id: string,
    operation: O,
    params: OperationParams<O>,
    session?: string,
  ): Promise<OperationResult<O>> {
    if (this.#closed) throw new Error("daemon client is closed");
    if (this.#pending.has(id)) throw new Error(`daemon request ID is already in flight: ${id}`);
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const frame = {
      t: "req",
      id,
      op: operation,
      ...(session === undefined ? {} : { session }),
      params,
    };
    this.#socket.write(`${JSON.stringify(frame)}\n`);
    const result = await response;
    if (!isOperationResult(operation, result)) {
      throw new Error(`daemon returned an invalid ${operation} result`);
    }
    if (operation === "detach") {
      this.endAttachment((params as OperationParams<"detach">).attachmentId);
    }
    return result;
  }

  async attach(
    sessionId: string,
    params: OperationParams<"attach"> = {},
    options: DaemonAttachmentOptions = {},
  ): Promise<DaemonAttachment> {
    const storedCursor =
      params.fromCursor === undefined ? await options.cursorStore?.load(sessionId) : undefined;
    const fromCursor =
      params.fromCursor === undefined ? storedCursor : params.fromCursor;
    const result = await this.request(
      "attach",
      {
        ...(fromCursor === undefined ? {} : { fromCursor }),
        ...(params.live === undefined ? {} : { live: params.live }),
      },
      sessionId,
    );
    return new DaemonAttachment(
      this,
      sessionId,
      result,
      this.queueForAttachment(result.attachmentId),
      options,
    );
  }

  /**
   * Read status without waking or resubmitting. Keep the original submission key.
   * `unknown` means no indexed claim, not proof that provider work never started;
   * reconcile explicitly or accept duplicate risk before resending. A new file's
   * first claim may not be saved before dispatch (O10); an ordinary crash can
   * retain `pending` in SQLite. Neither uncertain state authorizes automatic retry.
   * A known, received pre-claim `busy` refusal remains safe to re-evaluate.
   */
  async promptStatus(
    sessionId: string,
    params: OperationParams<"prompt_status">,
  ): Promise<OperationResult<"prompt_status">> {
    return await this.request("prompt_status", params, sessionId);
  }

  async recover(
    sessionId: string,
    params: OperationParams<"recover">,
  ): Promise<OperationResult<"recover">> {
    return await this.request("recover", params, sessionId);
  }

  close(): void {
    if (this.#closed) return;
    this.#socket.destroy();
    this.fail(new Error("daemon client closed"));
  }

  /**
   * Open a fresh connection; no prompts, attachments, or leases are replayed.
   * Caller hooks own recovery policy and must not turn an `unknown` prompt
   * status into automatic resend. Query with the original submission key.
   */
  async reconnect(): Promise<DaemonClient> {
    if (!this.#closed) throw new Error("daemon client must be closed before reconnecting");
    if (this.#connectionOptions.reconnect === undefined) {
      throw new Error("daemon client was not created by connectDaemon");
    }
    await this.#disconnectComplete;
    const client = await this.#connectionOptions.reconnect();
    await this.#connectionOptions.hooks?.onReconnect?.(client);
    return client;
  }

  private receive(chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("daemon returned an invalid frame"));
      this.#socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (isStreamFrame(frame)) {
        this.routeStreamFrame(frame);
        continue;
      }
      if (isSuccessFrame(frame) || isFailureFrame(frame)) {
        const pending = this.#pending.get(frame.id);
        if (pending === undefined) {
          this.fail(new Error(`daemon returned an unexpected response ID: ${frame.id}`));
          this.#socket.destroy();
          return;
        }
        this.#pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else {
          pending.reject(
            new DaemonRequestError(frame.error.code, frame.error.message, frame.error.details),
          );
        }
        continue;
      }
      this.fail(new Error("daemon returned an invalid protocol frame"));
      this.#socket.destroy();
      return;
    }
  }

  private routeStreamFrame(frame: StreamFrame): void {
    switch (frame.kind) {
      case "entry":
      case "event":
      case "daemon":
      case "ui_request":
      case "gap":
        this.queueForAttachment(frame.attachmentId).push(frame);
        return;
      case "error": {
        const queue = this.queueForAttachment(frame.attachmentId);
        queue.push(frame);
        if (frame.fatal) {
          queue.end();
          this.#attachmentFrames.delete(frame.attachmentId);
        }
        return;
      }
    }
    const exhaustive: never = frame;
    throw new Error(`unsupported daemon stream frame: ${String(exhaustive)}`);
  }

  private queueForAttachment(attachmentId: string): AsyncQueue<StreamFrame> {
    let queue = this.#attachmentFrames.get(attachmentId);
    if (queue === undefined) {
      queue = new AsyncQueue<StreamFrame>();
      this.#attachmentFrames.set(attachmentId, queue);
    }
    return queue;
  }

  private endAttachment(attachmentId: string): void {
    this.#attachmentFrames.get(attachmentId)?.end();
    this.#attachmentFrames.delete(attachmentId);
  }

  private fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const queue of this.#attachmentFrames.values()) queue.end(error);
    this.#attachmentFrames.clear();
    const onDisconnect = this.#connectionOptions.hooks?.onDisconnect;
    this.#disconnectComplete =
      onDisconnect === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => onDisconnect({ error }));
    void this.#disconnectComplete.catch(() => undefined);
  }
}

export function spawnDaemonProcess(options: SpawnDaemonProcessOptions = {}): ChildProcess {
  const entrypoint =
    options.daemonEntrypoint ??
    fileURLToPath(new URL("../../bin/pi-daemon-daemon.mjs", import.meta.url));
  const inherited = options.environment ?? process.env;
  const environment: NodeJS.ProcessEnv = {
    ...(inherited.PATH === undefined ? {} : { PATH: inherited.PATH }),
    ...(inherited.HOME === undefined ? {} : { HOME: inherited.HOME }),
    ...(inherited.NODE_PATH === undefined ? {} : { NODE_PATH: inherited.NODE_PATH }),
    ...(inherited.XDG_STATE_HOME === undefined
      ? {}
      : { XDG_STATE_HOME: inherited.XDG_STATE_HOME }),
    ...(inherited.XDG_RUNTIME_DIR === undefined
      ? {}
      : { XDG_RUNTIME_DIR: inherited.XDG_RUNTIME_DIR }),
    ...(options.stateDir ?? inherited.PI_DAEMON_STATE_DIR) === undefined
      ? {}
      : { PI_DAEMON_STATE_DIR: options.stateDir ?? inherited.PI_DAEMON_STATE_DIR },
    ...(options.socketPath ?? inherited.PI_DAEMON_SOCKET) === undefined
      ? {}
      : { PI_DAEMON_SOCKET: options.socketPath ?? inherited.PI_DAEMON_SOCKET },
    ...(options.agentDir ?? inherited.PI_DAEMON_AGENT_DIR) === undefined
      ? {}
      : { PI_DAEMON_AGENT_DIR: options.agentDir ?? inherited.PI_DAEMON_AGENT_DIR },
    ...(inherited.PI_DAEMON_MODEL_RUNTIME_MODULE === undefined
      ? {}
      : { PI_DAEMON_MODEL_RUNTIME_MODULE: inherited.PI_DAEMON_MODEL_RUNTIME_MODULE }),
    ...(inherited.PI_DAEMON_GATE_PROVIDER_SCRIPT === undefined
      ? {}
      : { PI_DAEMON_GATE_PROVIDER_SCRIPT: inherited.PI_DAEMON_GATE_PROVIDER_SCRIPT }),
  };
  const detached = options.detached ?? true;
  const child = spawn(process.execPath, [entrypoint], {
    detached,
    env: environment,
    stdio: detached ? "ignore" : "inherit",
  });
  child.on("error", () => {
    // Callers can attach their own listener; this prevents an unhandled EventEmitter error.
  });
  if (detached) child.unref();
  return child;
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonClient> {
  const socketPath = resolveClientSocketPath(options);
  const timeoutMs = positiveInteger(
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    "startupTimeoutMs",
  );
  const retryIntervalMs = positiveInteger(
    options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
    "retryIntervalMs",
  );
  const deadline = Date.now() + timeoutMs;
  let spawned = false;
  let spawnFailure: DaemonSpawnError | undefined;
  let lastError: unknown;

  for (;;) {
    try {
      return await connectOnce(socketPath, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectionError(error)) throw error;
      if (!spawned && (options.autoSpawn ?? true)) {
        spawned = true;
        const child = spawnDaemonProcess({
          ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
          socketPath,
          ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
          ...(options.daemonEntrypoint === undefined
            ? {}
            : { daemonEntrypoint: options.daemonEntrypoint }),
          detached: true,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
        });
        child.once("error", (spawnError) => {
          spawnFailure = new DaemonSpawnError("failed to spawn pi-daemon", {
            cause: spawnError,
          });
        });
        child.once("exit", (code, signal) => {
          if (code !== 0) {
            spawnFailure = new DaemonSpawnError(
              `spawned pi-daemon exited before accepting connections (code=${code}, signal=${signal})`,
              {
                ...(code === null ? {} : { exitCode: code }),
                ...(signal === null ? {} : { signal }),
              },
            );
          }
        });
      }
      if (spawnFailure !== undefined) throw spawnFailure;
      if (Date.now() >= deadline) {
        throw lastError instanceof Error
          ? lastError
          : new Error("timed out connecting to pi-daemon");
      }
      await delay(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

async function connectOnce(
  socketPath: string,
  options: ConnectDaemonOptions,
): Promise<DaemonClient> {
  const socket = createConnection(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(connectionError("ETIMEDOUT", "timed out opening daemon socket"));
      }, Math.min(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 1_000));
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    const hello = await exchangeHello(socket, options);
    return new DaemonClient(socket, hello, {
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      reconnect: async () => await connectDaemon(options),
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function exchangeHello(
  socket: Socket,
  options: ConnectDaemonOptions,
): Promise<OperationResult<"hello">> {
  const id = "hello-1";
  socket.write(
    `${JSON.stringify({
      t: "req",
      id,
      op: "hello",
      params: {
        protocol: options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        client: { name: options.client.name, version: options.client.version },
        ...(options.client.capabilities === undefined
          ? {}
          : { capabilities: [...options.client.capabilities] }),
      },
    })}\n`,
  );
  const frame = await readOneFrame(socket, 1_000);
  if (isFailureFrame(frame)) {
    throw new DaemonRequestError(frame.error.code, frame.error.message, frame.error.details);
  }
  if (!isSuccessFrame(frame) || frame.id !== id || !isOperationResult("hello", frame.result)) {
    throw new Error("daemon returned an invalid hello response");
  }
  return frame.result;
}

function readOneFrame(socket: Socket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(connectionError("ETIMEDOUT", "timed out waiting for daemon hello"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        reject(new Error("daemon returned invalid hello JSON"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(connectionError("ECONNRESET", "daemon socket closed before hello completed"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function resolveClientSocketPath(options: ConnectDaemonOptions): string {
  if (options.socketPath !== undefined) {
    if (!isAbsolute(options.socketPath)) {
      throw new TypeError("socketPath must be an absolute path");
    }
    return options.socketPath;
  }

  const environment = options.environment ?? process.env;
  if (environment.PI_DAEMON_SOCKET !== undefined) {
    if (!isAbsolute(environment.PI_DAEMON_SOCKET)) {
      throw new TypeError("PI_DAEMON_SOCKET must be an absolute path");
    }
    return environment.PI_DAEMON_SOCKET;
  }
  if (environment.XDG_RUNTIME_DIR !== undefined) {
    return resolve(environment.XDG_RUNTIME_DIR, "pi-daemon", "pi-daemon.sock");
  }
  return resolve(
    environment.HOME ?? homedir(),
    ".local",
    "state",
    "pi-daemon",
    "run",
    "pi-daemon.sock",
  );
}

function isRetryableConnectionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "EPIPE" ||
      error.code === "ETIMEDOUT")
  );
}

function connectionError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
