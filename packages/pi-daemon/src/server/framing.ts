import type { Socket } from "node:net";

import {
  STREAM_KINDS,
  isProtocolFrame,
  isRequestFrame,
  isStreamFrame,
  type ErrorCode,
  type RequestFrame,
  type ResponseFrame,
  type StreamFrame,
} from "../protocol/index.js";

export const SERVER_STREAM_KINDS = STREAM_KINDS;

export type RequestDecoderEvent =
  | { readonly type: "request"; readonly request: RequestFrame }
  | {
      readonly type: "invalid_request";
      readonly value: unknown;
      readonly id?: string;
      readonly operation?: string;
    }
  | {
      readonly type: "framing_error";
      readonly code: Extract<ErrorCode, "bad_frame" | "frame_too_large">;
      readonly message: string;
    };

export class RequestFrameDecoder {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #failed = false;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("max inbound request bytes must be a positive safe integer");
    }
    this.#maxBytes = maxBytes;
  }

  push(chunk: Buffer): RequestDecoderEvent[] {
    if (this.#failed || chunk.length === 0) return [];
    const events: RequestDecoderEvent[] = [];
    let offset = 0;

    while (offset < chunk.length && !this.#failed) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);

      if (this.#bytes + fragment.length > this.#maxBytes) {
        this.#fail(events, "frame_too_large", "inbound request frame exceeds the configured byte limit");
        break;
      }
      if (fragment.length > 0) {
        this.#chunks.push(fragment);
        this.#bytes += fragment.length;
      }
      if (newline === -1) break;

      events.push(this.#finishFrame());
      offset = newline + 1;
    }

    return events;
  }

  finish(): RequestDecoderEvent | undefined {
    if (this.#failed || this.#bytes === 0) return undefined;
    this.#failed = true;
    this.#reset();
    return {
      type: "framing_error",
      code: "bad_frame",
      message: "connection ended with an incomplete request frame",
    };
  }

  #finishFrame(): RequestDecoderEvent {
    if (this.#bytes === 0) {
      this.#failed = true;
      return {
        type: "framing_error",
        code: "bad_frame",
        message: "blank request frames are not allowed",
      };
    }

    const encoded = Buffer.concat(this.#chunks, this.#bytes);
    this.#reset();

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } catch {
      this.#failed = true;
      return {
        type: "framing_error",
        code: "bad_frame",
        message: "request frame is not valid UTF-8",
      };
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.#failed = true;
      return {
        type: "framing_error",
        code: "bad_frame",
        message: "request frame is not valid JSON",
      };
    }

    const protocolFrame = isProtocolFrame(value);
    if (protocolFrame && isRequestFrame(value)) {
      return { type: "request", request: value };
    }

    const id = getStringProperty(value, "id");
    const operation = getStringProperty(value, "op");
    return {
      type: "invalid_request",
      value,
      ...(id === undefined ? {} : { id }),
      ...(operation === undefined ? {} : { operation }),
    };
  }

  #fail(
    events: RequestDecoderEvent[],
    code: Extract<ErrorCode, "bad_frame" | "frame_too_large">,
    message: string,
  ): void {
    this.#failed = true;
    this.#reset();
    events.push({ type: "framing_error", code, message });
  }

  #reset(): void {
    this.#chunks.length = 0;
    this.#bytes = 0;
  }
}

function getStringProperty(value: unknown, property: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, property) as unknown;
  return typeof candidate === "string" ? candidate : undefined;
}

export type OutboundFrame = ResponseFrame | StreamFrame;

export const DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_FRAMES = 2_048;
export const DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_BYTES = 8 * 1024 * 1024;

export interface FrameWriterOptions {
  readonly highWaterFrames?: number;
  readonly highWaterBytes?: number;
  readonly onPressureChange?: (pressured: boolean) => void;
}

interface PendingFrame {
  readonly line: string;
  readonly byteLength: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class FrameWriter {
  readonly #socket: Socket;
  readonly #queue: PendingFrame[] = [];
  readonly #highWaterFrames: number;
  readonly #highWaterBytes: number;
  readonly #onPressureChange: ((pressured: boolean) => void) | undefined;
  #queuedBytes = 0;
  #writing = false;
  #pressured = false;
  #failure: Error | undefined;
  #current: PendingFrame | undefined;

  constructor(socket: Socket, options: FrameWriterOptions = {}) {
    this.#socket = socket;
    this.#highWaterFrames = positiveSafeInteger(
      options.highWaterFrames ?? DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_FRAMES,
      "highWaterFrames",
    );
    this.#highWaterBytes = positiveSafeInteger(
      options.highWaterBytes ?? DEFAULT_OUTBOUND_QUEUE_HIGH_WATER_BYTES,
      "highWaterBytes",
    );
    this.#onPressureChange = options.onPressureChange;
  }

  write(frame: OutboundFrame): Promise<void> {
    assertOutboundFrame(frame);
    if (this.#failure !== undefined) return Promise.reject(this.#failure);

    const line = JSON.stringify(frame);
    const byteLength = Buffer.byteLength(line) + 1;
    return new Promise((resolve, reject) => {
      this.#queue.push({ line, byteLength, resolve, reject });
      this.#queuedBytes += byteLength;
      void this.#pump();
      this.#updatePressure();
    });
  }

  fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#current?.reject(error);
    for (const pending of this.#queue.splice(0)) pending.reject(error);
    this.#queuedBytes = 0;
    this.#updatePressure();
  }

  async #pump(): Promise<void> {
    if (this.#writing) return;
    this.#writing = true;
    try {
      while ((this.#current = this.#queue.shift()) !== undefined) {
        this.#queuedBytes -= this.#current.byteLength;
        this.#updatePressure();
        try {
          await writeIncrementally(this.#socket, this.#current.line);
          this.#current.resolve();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.#current.reject(failure);
          this.fail(failure);
          return;
        }
      }
    } finally {
      this.#current = undefined;
      this.#writing = false;
      this.#updatePressure();
    }
  }

  #updatePressure(): void {
    const pressured =
      this.#queue.length >= this.#highWaterFrames ||
      this.#queuedBytes >= this.#highWaterBytes;
    if (pressured === this.#pressured) return;
    this.#pressured = pressured;
    this.#onPressureChange?.(pressured);
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertOutboundFrame(frame: OutboundFrame): void {
  if (!isProtocolFrame(frame) || isRequestFrame(frame)) {
    throw new TypeError("outbound frame does not match the canonical protocol schema");
  }
  if (frame.t === "ev" && !isStreamFrame(frame)) {
    throw new TypeError("outbound stream frame does not match the canonical stream partition");
  }
}

const WRITE_CHUNK_CHARACTERS = 64 * 1024;

async function writeIncrementally(socket: Socket, line: string): Promise<void> {
  let offset = 0;
  while (offset < line.length) {
    if (socket.destroyed) throw new Error("socket closed while writing a protocol frame");
    let end = Math.min(offset + WRITE_CHUNK_CHARACTERS, line.length);
    if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) end -= 1;
    const writable = socket.write(line.slice(offset, end));
    offset = end;
    if (!writable) await waitForDrain(socket);
  }
  if (!socket.write("\n")) await waitForDrain(socket);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

async function waitForDrain(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed while waiting for writer backpressure"));
    };
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
