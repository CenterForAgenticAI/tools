import { randomUUID } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { HostUiRequest } from "../host/index.js";
import { isCustomEntryData } from "../protocol/index.js";
import type {
  Cursor,
  JsonObject,
  OperationResult,
  StreamFrame,
} from "../protocol/index.js";
import { canonicalizeJsonValue } from "../protocol/schema.js";
import {
  BoundedStreamBacklog,
  normalizeStreamBackpressure,
  type StreamBackpressureConfig,
} from "./backpressure.js";
import { validateReplayCursor } from "./cursor.js";
import { projectSdkEvent } from "./sdk-event.js";
import type {
  AttachStreamRequest,
  AttachStreamResult,
  DetachStreamRequest,
  DetachStreamResult,
  ReplayCursorPlan,
  ReplayStreamRequest,
  ReplayStreamResult,
  StreamEngineIds,
  StreamEngineOptions,
  StreamSessionCapture,
  StreamSessionSource,
} from "./types.js";
import { StreamRequestError } from "./types.js";

type ReaderMode = "buffering" | "catch-up" | "live" | "idle" | "detached";

type GapReason = Extract<StreamFrame, { kind: "gap" }>["reason"];

interface PendingOverflow {
  readonly reason: GapReason;
  readonly generation: number;
  readonly epoch: number;
  readonly fromSeq: number;
  readonly toSeq: number;
}

interface Reader {
  readonly attachmentId: string;
  readonly connectionId: string;
  readonly send: AttachStreamRequest["send"];
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  mode: ReaderMode;
  replaying: boolean;
  liveAfterReplay: boolean;
  readonly buffered: BoundedStreamBacklog;
  delivery: Promise<void>;
  deliveryRunning: boolean;
  sendRunning: boolean;
  lastDeliveredCursor: Cursor;
  pendingOverflow?: PendingOverflow;
  queueFullAfterGap: boolean;
  catchUpRetries: number;
  failure?: StreamRequestError;
}

interface CapturedReplay extends StreamSessionCapture {
  readonly highWater: number;
}

interface ReplayExecution {
  readonly result: ReplayStreamResult;
  readonly capture: CapturedReplay;
}

// Live committed entries reach the engine already JSON-clean: the persistence
// observer reads them back from the on-disk JSONL. So the live projection stays
// a zero-copy cast — this deliberately does NOT clone oversized entries.
function entryObject(entry: SessionEntry): JsonObject {
  return entry as unknown as JsonObject;
}

// Replayed entries, by contrast, come from the in-memory SessionManager branch,
// which retains `undefined`-valued fields (e.g. a toolResult message keeps
// `usage: undefined`). Those are not JsonValues, so a replayed frame would fail
// canonical validation on send and tear the reader down mid-history. Canonicalize
// the entry (a copy) only on this path (intel/pi-daemon#45).
function replayEntryObject(entry: SessionEntry): JsonObject {
  return canonicalizeJsonValue(entry) as JsonObject;
}

function cursorAt(entryId: string | null, epoch: number): Cursor {
  return { entryId, epoch };
}

function readerIsDetached(reader: Reader): boolean {
  return reader.mode === "detached";
}

function frameSequence(frame: StreamFrame | undefined): number | undefined {
  return frame !== undefined && "seq" in frame ? frame.seq : undefined;
}

function controlFrame(
  reader: Reader,
  capture: CapturedReplay,
  name: "replay_start" | "replay_end",
  data: JsonObject,
): StreamFrame {
  return {
    t: "ev",
    session: capture.summary.sessionId,
    attachmentId: reader.attachmentId,
    kind: "daemon",
    generation: capture.generation,
    epoch: capture.epoch,
    name,
    data,
  };
}

type UiRequestFrame = Extract<StreamFrame, { kind: "ui_request" }>;
type UiRequestDetails = Omit<
  UiRequestFrame,
  "t" | "session" | "attachmentId" | "kind" | "generation" | "epoch" | "seq"
>;

function projectUiRequest(request: HostUiRequest): UiRequestDetails {
  const timeoutMs = request.timeout;
  const common = {
    questionId: request.questionId,
    title: request.title,
    ...(timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
  };
  switch (request.method) {
    case "select":
      return {
        ...common,
        method: request.method,
        ...(request.options === undefined ? {} : { options: [...request.options] }),
      };
    case "confirm":
      return {
        ...common,
        method: request.method,
        ...(request.message === undefined ? {} : { message: request.message }),
      };
    case "input":
      return {
        ...common,
        method: request.method,
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
        ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
      };
    case "editor":
      return {
        ...common,
        method: request.method,
        ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
      };
  }
}

class SessionStreamBroker {
  readonly source: StreamSessionSource;
  readonly #readers = new Map<string, Reader>();
  readonly #onReaderFailure: (reader: Reader) => void;
  readonly #onCatchUp: (reader: Reader) => void;
  readonly #keepaliveMs: number;
  readonly #now: () => Date;
  readonly #unsubscribeCommitted: () => void;
  readonly #unsubscribeSdk: () => void;
  readonly #unsubscribeUi: () => void;
  readonly #keepaliveTimer: NodeJS.Timeout | undefined;
  #sequence: number;
  #generation: number;
  #lastLiveFrameAt: number;
  #disposed = false;

  constructor(options: {
    readonly source: StreamSessionSource;
    readonly keepaliveMs: number;
    readonly now: () => Date;
    readonly onReaderFailure: (reader: Reader) => void;
    readonly onCatchUp: (reader: Reader) => void;
  }) {
    this.source = options.source;
    this.#sequence = options.source.committedSequence;
    this.#generation = options.source.currentState().generation;
    this.#keepaliveMs = options.keepaliveMs;
    this.#now = options.now;
    this.#lastLiveFrameAt = options.now().getTime();
    this.#onReaderFailure = options.onReaderFailure;
    this.#onCatchUp = options.onCatchUp;
    this.#unsubscribeCommitted = options.source.subscribeCommittedEntries(
      (committed) => {
        if (committed.sessionId !== this.source.sessionId || this.#disposed) return;
        const state = this.source.currentState();
        this.syncGeneration(state.generation);
        this.#sequence += 1;
        const entrySequence = this.#sequence;
        const modelData =
          committed.entry.type === "custom" &&
          committed.entry.customType === "pi-daemon/model" &&
          isCustomEntryData("pi-daemon/model", committed.entry.data)
            ? committed.entry.data
            : undefined;
        let modelSequence: number | undefined;
        if (modelData !== undefined) {
          this.#sequence += 1;
          modelSequence = this.#sequence;
        }
        this.#lastLiveFrameAt = this.#now().getTime();
        for (const reader of this.#readers.values()) {
          const frame: StreamFrame = {
            t: "ev",
            session: this.source.sessionId,
            attachmentId: reader.attachmentId,
            kind: "entry",
            generation: state.generation,
            epoch: state.epoch,
            seq: entrySequence,
            cursor: cursorAt(committed.entry.id, state.epoch),
            entry: entryObject(committed.entry),
            origin: "live",
          };
          this.routeLive(reader, frame);
          if (modelData !== undefined && modelSequence !== undefined) {
            this.routeLive(reader, {
              t: "ev",
              session: this.source.sessionId,
              attachmentId: reader.attachmentId,
              kind: "daemon",
              generation: state.generation,
              epoch: state.epoch,
              seq: modelSequence,
              name: "model",
              data: modelData,
              sourceEntryId: committed.entry.id,
            });
          }
        }
      },
    );
    this.#unsubscribeSdk = options.source.subscribeSdkEvents((publication) => {
      if (publication.sessionId !== this.source.sessionId || this.#disposed) return;
      const state = this.source.currentState();
      this.syncGeneration(state.generation);
      let projected: ReturnType<typeof projectSdkEvent>;
      try {
        projected = projectSdkEvent(publication.event);
      } catch {
        for (const reader of this.#readers.values()) {
          this.routeLive(reader, {
            t: "ev",
            session: this.source.sessionId,
            attachmentId: reader.attachmentId,
            kind: "error",
            generation: state.generation,
            epoch: state.epoch,
            error: {
              code: "sdk_incompatible",
              message: "host emitted an unsupported SDK event",
            },
            fatal: true,
          });
        }
        return;
      }
      this.#sequence += 1;
      this.#lastLiveFrameAt = this.#now().getTime();
      for (const reader of this.#readers.values()) {
        this.routeLive(reader, {
          t: "ev",
          session: this.source.sessionId,
          attachmentId: reader.attachmentId,
          kind: "event",
          generation: state.generation,
          epoch: state.epoch,
          seq: this.#sequence,
          durable: false,
          ...projected,
        });
      }
    });
    this.#unsubscribeUi =
      options.source.subscribeUi?.((request) => {
        if (this.#disposed) return;
        const state = this.source.currentState();
        this.syncGeneration(state.generation);
        this.#sequence += 1;
        this.#lastLiveFrameAt = this.#now().getTime();
        const projected = projectUiRequest(request);
        for (const reader of this.#readers.values()) {
          this.routeLive(reader, {
            t: "ev",
            session: this.source.sessionId,
            attachmentId: reader.attachmentId,
            kind: "ui_request",
            generation: state.generation,
            epoch: state.epoch,
            seq: this.#sequence,
            ...projected,
          });
        }
      }) ?? (() => undefined);
    this.#keepaliveTimer =
      this.#keepaliveMs > 0
        ? setInterval(() => this.emitKeepaliveIfIdle(), this.#keepaliveMs)
        : undefined;
    this.#keepaliveTimer?.unref();
  }

  register(reader: Reader): void {
    if (this.#disposed) {
      throw new StreamRequestError("unavailable", "session stream broker is disposed");
    }
    if (this.#readers.has(reader.attachmentId)) {
      throw new StreamRequestError(
        "internal",
        `duplicate attachment id: ${reader.attachmentId}`,
      );
    }
    this.#readers.set(reader.attachmentId, reader);
  }

  getReader(attachmentId: string, connectionId: string): Reader {
    const reader = this.#readers.get(attachmentId);
    if (reader === undefined || reader.connectionId !== connectionId) {
      throw new StreamRequestError("not_attached", "attachment does not belong to this session");
    }
    return reader;
  }

  remove(attachmentId: string): Reader | undefined {
    const reader = this.#readers.get(attachmentId);
    if (reader === undefined) return undefined;
    this.#readers.delete(attachmentId);
    reader.mode = "detached";
    reader.buffered.clear();
    if (reader.signal !== undefined && reader.onAbort !== undefined) {
      reader.signal.removeEventListener("abort", reader.onAbort);
    }
    return reader;
  }

  capture(): CapturedReplay {
    const capture = this.source.capture();
    this.syncGeneration(capture.generation);
    if (capture.summary.sessionId !== this.source.sessionId) {
      throw new StreamRequestError("internal", "stream source returned another session");
    }
    return { ...capture, highWater: this.#sequence };
  }

  async finishReplay(reader: Reader, replayEnd: StreamFrame): Promise<void> {
    if (!reader.liveAfterReplay) {
      await this.sendCurrent(reader, replayEnd);
      reader.buffered.clear();
      reader.mode = "idle";
      return;
    }

    reader.mode = "live";
    this.enqueue(reader, replayEnd);
    await reader.delivery;
  }

  enqueueBufferedAsLive(reader: Reader): void {
    reader.mode = reader.liveAfterReplay ? "live" : "idle";
    if (reader.mode === "idle") {
      reader.buffered.clear();
      return;
    }
    const first = reader.buffered.shift();
    if (first !== undefined && !reader.deliveryRunning) this.enqueue(reader, first);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#keepaliveTimer !== undefined) clearInterval(this.#keepaliveTimer);
    this.#unsubscribeCommitted();
    this.#unsubscribeSdk();
    this.#unsubscribeUi();
    for (const reader of this.#readers.values()) {
      reader.mode = "detached";
      reader.buffered.clear();
      if (reader.signal !== undefined && reader.onAbort !== undefined) {
        reader.signal.removeEventListener("abort", reader.onAbort);
      }
    }
    this.#readers.clear();
  }

  private syncGeneration(generation: number): void {
    if (generation === this.#generation) return;
    for (const reader of this.#readers.values()) this.partitionBufferedGeneration(reader);
    this.#generation = generation;
    this.#sequence = 0;
  }

  private partitionBufferedGeneration(reader: Reader): void {
    const first = reader.buffered.first();
    const last = reader.buffered.last();
    if (first === undefined || last === undefined) return;
    const fromSeq = frameSequence(first);
    const toSeq = frameSequence(last);
    if (fromSeq === undefined || toSeq === undefined || reader.pendingOverflow !== undefined) {
      this.readerFailure(
        reader,
        new StreamRequestError("queue_full", "attachment queue crossed a generation boundary"),
      );
      return;
    }
    reader.buffered.clear();
    reader.mode = "catch-up";
    reader.pendingOverflow = {
      reason: reader.deliveryRunning ? "socket_backpressure" : "reader_overflow",
      generation: first.generation,
      epoch: first.epoch,
      fromSeq,
      toSeq,
    };
  }

  readerFailure(reader: Reader, failure: StreamRequestError): void {
    if (reader.failure !== undefined || readerIsDetached(reader)) return;
    reader.failure = failure;
    reader.buffered.clear();
    this.#onReaderFailure(reader);
  }

  private routeLive(reader: Reader, frame: StreamFrame): void {
    if (!reader.liveAfterReplay || readerIsDetached(reader) || reader.failure !== undefined) return;
    if (reader.mode === "buffering" || reader.mode === "catch-up") {
      this.bufferLive(reader, frame, "reader_overflow");
      return;
    }
    if (reader.mode !== "live") return;
    if (reader.deliveryRunning) {
      this.bufferLive(reader, frame, "socket_backpressure");
      return;
    }
    this.enqueue(reader, frame);
  }

  private bufferLive(reader: Reader, frame: StreamFrame, reason: GapReason): void {
    if (!reader.buffered.push(frame)) this.recordOverflow(reader, reason, frame);
  }

  private recordOverflow(reader: Reader, reason: GapReason, incoming: StreamFrame): void {
    const incomingSequence = frameSequence(incoming);
    if (incomingSequence === undefined || reader.buffered.hasUnsequencedFrame()) {
      this.readerFailure(
        reader,
        new StreamRequestError("queue_full", "attachment queue contains an unsequenced frame"),
      );
      return;
    }
    const fromSeq = frameSequence(reader.buffered.first()) ?? incomingSequence;
    reader.buffered.clear();
    reader.mode = "catch-up";
    if (reader.pendingOverflow !== undefined) {
      if (reader.sendRunning) {
        this.readerFailure(
          reader,
          new StreamRequestError("queue_full", "attachment queue repeatedly overflowed"),
        );
      } else {
        reader.queueFullAfterGap = true;
      }
      return;
    }
    reader.pendingOverflow = {
      reason,
      generation: incoming.generation,
      epoch: incoming.epoch,
      fromSeq,
      toSeq: incomingSequence,
    };
  }

  private enqueue(reader: Reader, frame: StreamFrame): void {
    if (reader.deliveryRunning) {
      this.bufferLive(reader, frame, "socket_backpressure");
      return;
    }

    reader.deliveryRunning = true;
    reader.delivery = this.pumpDelivery(reader, frame);
    void reader.delivery.catch(() => this.#onReaderFailure(reader));
  }

  private async pumpDelivery(reader: Reader, initial: StreamFrame): Promise<void> {
    let frame: StreamFrame | undefined = initial;
    try {
      while (frame !== undefined && !readerIsDetached(reader)) {
        await this.sendCurrent(reader, frame);
        if (reader.mode !== "live") break;
        frame = reader.buffered.shift();
      }
    } finally {
      reader.deliveryRunning = false;
      if (
        reader.mode === "catch-up" &&
        !reader.replaying &&
        reader.pendingOverflow !== undefined &&
        !readerIsDetached(reader)
      ) {
        this.#onCatchUp(reader);
      }
    }
  }

  private async sendCurrent(reader: Reader, frame: StreamFrame): Promise<void> {
    if (readerIsDetached(reader)) return;
    reader.sendRunning = true;
    try {
      await reader.send(frame);
    } finally {
      reader.sendRunning = false;
    }
    if (frame.kind === "entry") reader.lastDeliveredCursor = frame.cursor;
  }

  private emitKeepaliveIfIdle(): void {
    if (this.#disposed || this.#now().getTime() - this.#lastLiveFrameAt < this.#keepaliveMs) {
      return;
    }
    const liveReaders = [...this.#readers.values()].filter(
      (reader) => reader.mode === "live",
    );
    if (liveReaders.length === 0) return;

    const capture = this.capture();
    this.#sequence += 1;
    this.#lastLiveFrameAt = this.#now().getTime();
    for (const reader of liveReaders) {
      this.enqueue(reader, {
        t: "ev",
        session: this.source.sessionId,
        attachmentId: reader.attachmentId,
        kind: "daemon",
        generation: capture.generation,
        epoch: capture.epoch,
        seq: this.#sequence,
        name: "keepalive",
        data: {
          cursor: cursorAt(capture.leafId, capture.epoch),
          observedPhase: capture.summary.observedPhase,
          attention: capture.summary.attention,
          pendingQuestionIds: capture.summary.pendingQuestions.map(
            ({ questionId }) => questionId,
          ),
        },
      });
    }
  }
}

export class StreamEngine {
  readonly #options: StreamEngineOptions;
  readonly #ids: StreamEngineIds;
  readonly #keepaliveMs: number;
  readonly #now: () => Date;
  readonly #backpressure: StreamBackpressureConfig;
  readonly #brokers = new Map<string, SessionStreamBroker>();
  #disposed = false;

  constructor(options: StreamEngineOptions) {
    this.#options = options;
    this.#ids = {
      attachmentId: options.ids?.attachmentId ?? randomUUID,
      replayId: options.ids?.replayId ?? randomUUID,
    };
    this.#keepaliveMs = options.keepaliveMs ?? 15_000;
    this.#now = options.now ?? (() => new Date());
    this.#backpressure = normalizeStreamBackpressure(options.backpressure);
  }

  async attach(request: AttachStreamRequest): Promise<AttachStreamResult> {
    this.assertAvailable();
    const broker = this.getOrCreateBroker(request.sessionId);
    const reader: Reader = {
      attachmentId: this.#ids.attachmentId(),
      connectionId: request.connectionId,
      send: request.send,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      mode: "buffering",
      replaying: false,
      liveAfterReplay: request.live,
      buffered: new BoundedStreamBacklog(this.#backpressure.reader),
      delivery: Promise.resolve(),
      deliveryRunning: false,
      sendRunning: false,
      lastDeliveredCursor: request.fromCursor ?? { entryId: null, epoch: 0 },
      queueFullAfterGap: false,
      catchUpRetries: 0,
    };
    broker.register(reader);
    if (request.signal !== undefined) {
      const onAbort = () => {
        void this.removeReader(request.sessionId, reader.attachmentId);
      };
      Object.assign(reader, { onAbort });
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    }

    try {
      const execution = await this.runReplay(
        broker,
        reader,
        request.fromCursor,
        undefined,
        false,
      );
      const summary = {
        ...execution.capture.summary,
        generation: execution.capture.generation,
        epoch: execution.capture.epoch,
        cursor: cursorAt(execution.capture.leafId, execution.capture.epoch),
        heartbeat: {
          seq: execution.capture.highWater,
          at: this.#now().toISOString(),
        },
      };
      return {
        attachmentId: reader.attachmentId,
        session: summary,
        replay: execution.result,
      };
    } catch (error) {
      await this.removeReader(request.sessionId, reader.attachmentId);
      throw error;
    }
  }

  async replay(request: ReplayStreamRequest): Promise<ReplayStreamResult> {
    this.assertAvailable();
    const broker = this.getExistingBroker(request.sessionId);
    const reader = broker.getReader(request.attachmentId, request.connectionId);
    const execution = await this.runReplay(
      broker,
      reader,
      request.fromCursor,
      request.throughEntryId,
      true,
    );
    return execution.result;
  }

  async detach(request: DetachStreamRequest): Promise<DetachStreamResult> {
    this.assertAvailable();
    const broker = this.getExistingBroker(request.sessionId);
    broker.getReader(request.attachmentId, request.connectionId);
    await this.removeReader(request.sessionId, request.attachmentId);
    return { detached: true };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const broker of this.#brokers.values()) broker.dispose();
    this.#brokers.clear();
  }

  private async runReplay(
    broker: SessionStreamBroker,
    reader: Reader,
    fromCursor: Cursor | null,
    throughEntryId: string | undefined,
    waitForPendingDelivery: boolean,
  ): Promise<ReplayExecution> {
    if (reader.replaying) {
      throw new StreamRequestError("queue_full", "attachment already has a replay in progress");
    }
    reader.replaying = true;
    reader.mode = "buffering";

    try {
      if (waitForPendingDelivery) await reader.delivery;
      let nextCursor = fromCursor;
      let nextThroughEntryId = throughEntryId;
      let requestedExecution: ReplayExecution | undefined;

      while (true) {
        await this.emitPendingOverflow(broker, reader);
        if (readerIsDetached(reader)) {
          if (reader.failure !== undefined) throw reader.failure;
          if (requestedExecution === undefined) {
            throw new StreamRequestError("queue_full", "attachment queue is full");
          }
          return requestedExecution;
        }
        if (reader.pendingOverflow !== undefined) continue;

        reader.mode = "buffering";
        const capture = broker.capture();
        const plan = validateReplayCursor(nextCursor, capture);
        reader.lastDeliveredCursor =
          plan.outcome === "cursor_off_branch" ? plan.forkPoint : plan.from;
        const throughIndex = this.throughIndex(capture, plan, nextThroughEntryId);
        const replayEntries = capture.activeBranch.slice(plan.startIndex, throughIndex + 1);
        const through = cursorAt(
          capture.activeBranch[throughIndex]?.id ?? plan.from.entryId,
          capture.epoch,
        );
        const replayId = this.#ids.replayId();
        const result = this.replayResult(replayId, plan, through);
        const execution = { result, capture };
        requestedExecution ??= execution;
        const controlData: JsonObject = {
          replayId,
          outcome: result.outcome,
          from: result.from,
          through: result.through,
          highWater: capture.highWater,
          ...(result.forkPoint === undefined ? {} : { forkPoint: result.forkPoint }),
        };
        await this.sendCurrent(reader, controlFrame(reader, capture, "replay_start", controlData));

        const replayedEntryIds = new Set<string>();
        for (const [index, entry] of replayEntries.entries()) {
          if (readerIsDetached(reader)) break;
          await this.sendCurrent(reader, {
            t: "ev",
            session: broker.source.sessionId,
            attachmentId: reader.attachmentId,
            kind: "entry",
            generation: capture.generation,
            epoch: capture.epoch,
            cursor: cursorAt(entry.id, capture.epoch),
            entry: replayEntryObject(entry),
            origin: "replay",
            replayId,
            index,
          });
          replayedEntryIds.add(entry.id);
        }

        while (
          reader.liveAfterReplay &&
          !readerIsDetached(reader) &&
          reader.pendingOverflow === undefined
        ) {
          const frame = reader.buffered.shift();
          if (frame === undefined) break;
          if (
            frame.kind === "entry" &&
            frame.origin === "live" &&
            replayedEntryIds.has(frame.cursor.entryId ?? "")
          ) {
            continue;
          }
          await this.sendCurrent(reader, frame);
        }

        if (reader.pendingOverflow !== undefined) {
          nextCursor = reader.lastDeliveredCursor;
          nextThroughEntryId = undefined;
          continue;
        }

        if (!readerIsDetached(reader)) {
          await broker.finishReplay(
            reader,
            controlFrame(reader, capture, "replay_end", controlData),
          );
        }
        if (reader.pendingOverflow !== undefined) {
          nextCursor = reader.lastDeliveredCursor;
          nextThroughEntryId = undefined;
          continue;
        }
        reader.catchUpRetries = 0;
        return { result: requestedExecution.result, capture };
      }
    } catch (error) {
      if (!readerIsDetached(reader)) broker.enqueueBufferedAsLive(reader);
      throw error;
    } finally {
      reader.replaying = false;
    }
  }

  private async emitPendingOverflow(
    broker: SessionStreamBroker,
    reader: Reader,
  ): Promise<void> {
    const overflow = reader.pendingOverflow;
    if (overflow === undefined) return;
    delete reader.pendingOverflow;

    if (reader.catchUpRetries >= this.#backpressure.maxCatchUpRetries) {
      await this.closeQueueFull(broker, reader);
    }

    await this.sendCurrent(reader, {
      t: "ev",
      session: broker.source.sessionId,
      attachmentId: reader.attachmentId,
      kind: "gap",
      generation: overflow.generation,
      epoch: overflow.epoch,
      reason: overflow.reason,
      lost: { fromSeq: overflow.fromSeq, toSeq: overflow.toSeq },
      resumeFrom: reader.lastDeliveredCursor,
      demoted: true,
    });
    reader.catchUpRetries += 1;
    if (reader.queueFullAfterGap) await this.closeQueueFull(broker, reader);
  }

  private async closeQueueFull(
    broker: SessionStreamBroker,
    reader: Reader,
  ): Promise<never> {
    const state = broker.source.currentState();
    await this.sendCurrent(reader, {
      t: "ev",
      session: broker.source.sessionId,
      attachmentId: reader.attachmentId,
      kind: "error",
      generation: state.generation,
      epoch: state.epoch,
      error: { code: "queue_full", message: "attachment queue repeatedly overflowed" },
      fatal: true,
    });
    const failure = new StreamRequestError(
      "queue_full",
      "attachment queue repeatedly overflowed",
    );
    broker.readerFailure(reader, failure);
    throw failure;
  }

  private async sendCurrent(reader: Reader, frame: StreamFrame): Promise<void> {
    if (readerIsDetached(reader)) return;
    reader.sendRunning = true;
    try {
      await reader.send(frame);
    } finally {
      reader.sendRunning = false;
    }
    if (frame.kind === "entry") reader.lastDeliveredCursor = frame.cursor;
  }

  private throughIndex(
    capture: CapturedReplay,
    plan: ReplayCursorPlan,
    throughEntryId: string | undefined,
  ): number {
    if (throughEntryId === undefined) return capture.activeBranch.length - 1;
    const index = capture.activeBranch.findIndex(({ id }) => id === throughEntryId);
    if (index === -1) {
      throw new StreamRequestError(
        "cursor_off_branch",
        `through entry ${throughEntryId} is not on the active branch`,
        { throughEntryId },
      );
    }
    return Math.max(index, plan.startIndex - 1);
  }

  private replayResult(
    replayId: string,
    plan: ReplayCursorPlan,
    through: Cursor,
  ): OperationResult<"replay"> {
    if (plan.outcome === "cursor_off_branch") {
      return {
        replayId,
        outcome: plan.outcome,
        from: plan.from,
        through,
        forkPoint: plan.forkPoint,
      };
    }
    return { replayId, outcome: plan.outcome, from: plan.from, through };
  }

  private getOrCreateBroker(sessionId: string): SessionStreamBroker {
    const existing = this.#brokers.get(sessionId);
    if (existing !== undefined) return existing;
    const source = this.#options.resolveSession(sessionId);
    if (source === undefined || source.sessionId !== sessionId) {
      throw new StreamRequestError("unknown_session", `unknown session: ${sessionId}`);
    }
    const broker = new SessionStreamBroker({
      source,
      keepaliveMs: this.#keepaliveMs,
      now: this.#now,
      onReaderFailure: (reader) => {
        void this.removeReader(sessionId, reader.attachmentId);
      },
      onCatchUp: (reader) => {
        const activeBroker = this.#brokers.get(sessionId);
        if (activeBroker !== undefined) void this.catchUp(activeBroker, reader);
      },
    });
    this.#brokers.set(sessionId, broker);
    return broker;
  }

  private async catchUp(broker: SessionStreamBroker, reader: Reader): Promise<void> {
    try {
      await this.runReplay(broker, reader, reader.lastDeliveredCursor, undefined, false);
    } catch {
      if (!readerIsDetached(reader)) {
        await this.removeReader(broker.source.sessionId, reader.attachmentId);
      }
    }
  }

  private getExistingBroker(sessionId: string): SessionStreamBroker {
    const broker = this.#brokers.get(sessionId);
    if (broker === undefined) {
      throw new StreamRequestError("not_attached", "attachment does not belong to this session");
    }
    return broker;
  }

  private async removeReader(sessionId: string, attachmentId: string): Promise<void> {
    const broker = this.#brokers.get(sessionId);
    if (broker === undefined) return;
    const reader = broker.remove(attachmentId);
    if (reader === undefined) return;
    await this.#options.releaseAttachment?.(sessionId, attachmentId);
  }

  private assertAvailable(): void {
    if (this.#disposed) {
      throw new StreamRequestError("unavailable", "stream engine is disposed");
    }
  }
}
