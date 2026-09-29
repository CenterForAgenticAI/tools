import type { StreamFrame } from "../protocol/index.js";

export const DEFAULT_STREAM_BACKLOG_MAX_FRAMES = 2_048;
export const DEFAULT_STREAM_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CATCH_UP_RETRIES = 2;

export interface StreamBacklogLimits {
  readonly maxFrames: number;
  readonly maxBytes: number;
}

export interface StreamBackpressureConfig {
  readonly reader: StreamBacklogLimits;
  readonly maxCatchUpRetries: number;
}

export interface StreamBackpressureOptions {
  readonly readerMaxFrames?: number;
  readonly readerMaxBytes?: number;
  readonly maxCatchUpRetries?: number;
}

interface QueuedFrame {
  readonly frame: StreamFrame;
  readonly byteLength: number;
}

export class BoundedStreamBacklog {
  readonly #limits: StreamBacklogLimits;
  readonly #frames: QueuedFrame[] = [];
  #bytes = 0;

  constructor(limits: StreamBacklogLimits) {
    this.#limits = limits;
  }

  get count(): number {
    return this.#frames.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  push(frame: StreamFrame): boolean {
    const byteLength = streamFrameByteLength(frame);
    if (
      this.#frames.length + 1 > this.#limits.maxFrames ||
      this.#bytes + byteLength > this.#limits.maxBytes
    ) {
      return false;
    }
    this.#frames.push({ frame, byteLength });
    this.#bytes += byteLength;
    return true;
  }

  shift(): StreamFrame | undefined {
    const queued = this.#frames.shift();
    if (queued === undefined) return undefined;
    this.#bytes -= queued.byteLength;
    return queued.frame;
  }

  first(): StreamFrame | undefined {
    return this.#frames[0]?.frame;
  }

  last(): StreamFrame | undefined {
    return this.#frames.at(-1)?.frame;
  }

  hasUnsequencedFrame(): boolean {
    return this.#frames.some(({ frame }) => !("seq" in frame));
  }

  clear(): void {
    this.#frames.length = 0;
    this.#bytes = 0;
  }
}

export function normalizeStreamBackpressure(
  input: StreamBackpressureOptions = {},
): StreamBackpressureConfig {
  return {
    reader: {
      maxFrames: positiveSafeInteger(
        input.readerMaxFrames ?? DEFAULT_STREAM_BACKLOG_MAX_FRAMES,
        "backpressure.readerMaxFrames",
      ),
      maxBytes: positiveSafeInteger(
        input.readerMaxBytes ?? DEFAULT_STREAM_BACKLOG_MAX_BYTES,
        "backpressure.readerMaxBytes",
      ),
    },
    maxCatchUpRetries: positiveSafeInteger(
      input.maxCatchUpRetries ?? DEFAULT_MAX_CATCH_UP_RETRIES,
      "backpressure.maxCatchUpRetries",
    ),
  };
}

export function streamFrameByteLength(frame: StreamFrame): number {
  return jsonByteLength(frame) + 1;
}

function jsonByteLength(value: unknown): number {
  if (value === null) return 4;
  switch (typeof value) {
    case "boolean":
      return value ? 4 : 5;
    case "number":
      return Number.isFinite(value) ? (Object.is(value, -0) ? 1 : String(value).length) : 4;
    case "string":
      return jsonStringByteLength(value);
    case "bigint":
      throw new TypeError("cannot measure a bigint as JSON");
    case "undefined":
    case "function":
    case "symbol":
      return 0;
    case "object": {
      if (Array.isArray(value)) {
        let bytes = 2;
        for (const [index, item] of value.entries()) {
          if (index > 0) bytes += 1;
          bytes += isOmittedJsonValue(item) ? 4 : jsonByteLength(item);
        }
        return bytes;
      }
      let bytes = 2;
      let first = true;
      for (const [key, item] of Object.entries(value)) {
        if (isOmittedJsonValue(item)) continue;
        if (!first) bytes += 1;
        first = false;
        bytes += jsonStringByteLength(key) + 1 + jsonByteLength(item);
      }
      return bytes;
    }
  }
  throw new TypeError("cannot measure value as JSON");
}

function isOmittedJsonValue(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function jsonStringByteLength(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes += codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a ||
          codeUnit === 0x0c || codeUnit === 0x0d
        ? 2
        : 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
