import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from "@earendil-works/pi-ai";

export interface AcceptedOutputLimits {
  readonly maxBufferedBytes: number;
  readonly maxEvents: number;
}

/**
 * Engineering caps for one private physical attempt.
 *
 * The pinned 0.84.4 catalog and repository fixtures advertise at most 128,000
 * output tokens. The 24 MiB byte cap leaves 64 UTF-8 bytes per advertised token
 * for each of the exact terminal, immutable accepted snapshot, and reconstructed
 * deltas. The 262,144-event cap allows two wire events per advertised token.
 * These are explicit safety margins, not measurements of every possible model
 * response. The adapter counts bytes and events while consuming, but retains
 * neither producer events nor their cumulative mutable `partial` objects. A
 * response outside either engineering cap fails in full.
 */
export const ACCEPTED_OUTPUT_DEFAULT_LIMITS: AcceptedOutputLimits = Object.freeze({
  maxBufferedBytes: 24 * 1024 * 1024,
  maxEvents: 262_144,
});

// Give async producer finally blocks one bounded second; timeout fails the
// private attempt without publishing content.
const TERMINAL_CLEANUP_TIMEOUT_MS = 1_000;

export type AcceptedOutputErrorCode =
  | "aborted"
  | "malformed"
  | "overflow"
  | "rejected";

const ERROR_MESSAGES: Readonly<Record<AcceptedOutputErrorCode, string>> = Object.freeze({
  aborted: "The candidate output was aborted before acceptance.",
  malformed: "The candidate output did not satisfy the accepted stream contract.",
  overflow: "The candidate output exceeded the accepted output limit.",
  rejected: "The candidate output was rejected before acceptance.",
});

/** A content-free failure safe to expose outside the private attempt. */
export class AcceptedOutputError extends Error {
  readonly code: AcceptedOutputErrorCode;

  constructor(code: AcceptedOutputErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AcceptedOutputError";
    this.code = code;
  }
}

export interface AcceptedOutputOptions extends Partial<AcceptedOutputLimits> {
  readonly signal?: AbortSignal;
}

type AttemptState =
  | { readonly status: "pending" }
  | {
      readonly status: "accepted";
      readonly terminal: AssistantMessage;
      readonly partial: AssistantMessage | undefined;
    }
  | { readonly status: "failed"; readonly error: AcceptedOutputError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): value is AssistantMessage["usage"] {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return (
    isFiniteNumber(value.input) &&
    isFiniteNumber(value.output) &&
    isFiniteNumber(value.cacheRead) &&
    isFiniteNumber(value.cacheWrite) &&
    isFiniteNumber(value.totalTokens) &&
    isFiniteNumber(value.cost.input) &&
    isFiniteNumber(value.cost.output) &&
    isFiniteNumber(value.cost.cacheRead) &&
    isFiniteNumber(value.cost.cacheWrite) &&
    isFiniteNumber(value.cost.total)
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item, index) => index in value && isJsonValue(item, ancestors)) &&
      Object.keys(value).length === value.length
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isAssistantMessageEnvelope(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    typeof value.api === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.stopReason === "string" &&
    isFiniteNumber(value.timestamp) &&
    isUsage(value.usage)
  );
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (!isAssistantMessageEnvelope(value)) return false;
  return value.content.every((block) => {
    if (!isRecord(block) || typeof block.type !== "string") return false;
    if (block.type === "text") {
      return (
        typeof block.text === "string" &&
        (block.textSignature === undefined || typeof block.textSignature === "string")
      );
    }
    if (block.type === "thinking") {
      return (
        typeof block.thinking === "string" &&
        (block.thinkingSignature === undefined || typeof block.thinkingSignature === "string") &&
        (block.redacted === undefined || typeof block.redacted === "boolean")
      );
    }
    return (
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string" &&
      isRecord(block.arguments) &&
      isJsonValue(block.arguments) &&
      (block.thoughtSignature === undefined || typeof block.thoughtSignature === "string") &&
      (block.namespace === undefined || typeof block.namespace === "string")
    );
  });
}

function isContentIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPartialEventEnvelope(value: Record<string, unknown>): boolean {
  return isContentIndex(value.contentIndex) && isAssistantMessageEnvelope(value.partial);
}

/**
 * Checks only the event envelope while consuming. Producer partials are
 * cumulative mutable snapshots, so recursively walking one for every delta
 * would make a growing response quadratic. The authoritative terminal is
 * deeply validated once after producer cleanup and before any clone.
 */
function isAssistantMessageEventEnvelope(value: unknown): value is AssistantMessageEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "start":
      return isAssistantMessageEnvelope(value.partial);
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return isPartialEventEnvelope(value);
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return isPartialEventEnvelope(value) && typeof value.delta === "string";
    case "text_end":
    case "thinking_end":
      return isPartialEventEnvelope(value) && typeof value.content === "string";
    case "toolcall_end":
      return (
        isPartialEventEnvelope(value) &&
        isRecord(value.toolCall) &&
        value.toolCall.type === "toolCall" &&
        typeof value.toolCall.id === "string" &&
        typeof value.toolCall.name === "string" &&
        isRecord(value.toolCall.arguments)
      );
    case "done":
      return (
        (value.reason === "stop" ||
          value.reason === "length" ||
          value.reason === "toolUse" ||
          value.reason === "deferred") &&
        isAssistantMessageEnvelope(value.message) &&
        value.message.stopReason === value.reason
      );
    case "error":
      return (
        (value.reason === "error" || value.reason === "aborted") &&
        isAssistantMessageEnvelope(value.error)
      );
    default:
      return false;
  }
}

function assertLimits(options: AcceptedOutputOptions): AcceptedOutputLimits {
  const maxBufferedBytes =
    options.maxBufferedBytes ?? ACCEPTED_OUTPUT_DEFAULT_LIMITS.maxBufferedBytes;
  const maxEvents = options.maxEvents ?? ACCEPTED_OUTPUT_DEFAULT_LIMITS.maxEvents;
  if (
    !Number.isSafeInteger(maxBufferedBytes) ||
    maxBufferedBytes <= 0 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents <= 0
  ) {
    throw new TypeError("Accepted output limits must be positive safe integers.");
  }
  return { maxBufferedBytes, maxEvents };
}

function measuredBytes(value: unknown, limit: number): number {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, total: number): number => {
    if (total > limit) return total;
    if (candidate === null) return total + 4;
    switch (typeof candidate) {
      case "string":
        return total + Buffer.byteLength(candidate, "utf8");
      case "number":
        return total + 16;
      case "boolean":
        return total + 5;
      case "undefined":
        return total;
      case "object": {
        if (ancestors.has(candidate)) throw new AcceptedOutputError("malformed");
        ancestors.add(candidate);
        let measured = total;
        if (Array.isArray(candidate)) {
          for (const item of candidate) {
            measured = visit(item, measured + 1);
            if (measured > limit) break;
          }
        } else {
          for (const [key, item] of Object.entries(candidate)) {
            measured += Buffer.byteLength(key, "utf8") + 1;
            measured = visit(item, measured);
            if (measured > limit) break;
          }
        }
        ancestors.delete(candidate);
        return measured;
      }
      default:
        throw new AcceptedOutputError("malformed");
    }
  };
  return visit(value, 0);
}

function jsonText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new AcceptedOutputError("malformed");
      items.push(jsonText(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item)}`)
      .join(",")}}`;
  }
  throw new AcceptedOutputError("malformed");
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) {
      bytes += 2;
    } else if (unit <= 0x1f) {
      bytes += unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d
        ? 2
        : 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes += 6;
    } else if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonTextBytes(value: unknown, limit: number): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Object.is(value, -0) ? 2 : String(value).length;
  let bytes = 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new AcceptedOutputError("malformed");
      if (index > 0) bytes += 1;
      bytes += jsonTextBytes(value[index], limit - bytes);
      if (bytes > limit) break;
    }
    return bytes;
  }
  if (isRecord(value)) {
    let index = 0;
    for (const [key, item] of Object.entries(value)) {
      if (index > 0) bytes += 1;
      bytes += jsonStringBytes(key) + 1;
      bytes += jsonTextBytes(item, limit - bytes);
      if (bytes > limit) break;
      index += 1;
    }
    return bytes;
  }
  throw new AcceptedOutputError("malformed");
}

function deltaBytes(event: AssistantMessageEvent): number {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return Buffer.byteLength(event.delta, "utf8");
    default:
      return 0;
  }
}

function copyUsage(usage: AssistantMessage["usage"]): AssistantMessage["usage"] {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

function copyPartialMessage(
  terminal: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: terminal.api,
    provider: terminal.provider,
    model: terminal.model,
    ...(terminal.responseModel === undefined ? {} : { responseModel: terminal.responseModel }),
    ...(terminal.responseId === undefined ? {} : { responseId: terminal.responseId }),
    usage: copyUsage(terminal.usage),
    stopReason: "pending",
    timestamp: terminal.timestamp,
  };
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

function acceptedPartial(terminal: AssistantMessage): AssistantMessage {
  const content = structuredClone(terminal.content);
  const partial = copyPartialMessage(terminal, content);
  deepFreeze(partial);
  return partial;
}

function projectedAcceptedBytes(
  terminal: AssistantMessage,
  limit: number,
): number {
  let total = measuredBytes(terminal, limit);
  total += measuredBytes(copyPartialMessage(terminal, terminal.content), limit - total);
  total += measuredBytes(copyPartialMessage(terminal, []), limit - total);
  for (const block of terminal.content) {
    total += block.type === "text"
      ? Buffer.byteLength(block.text, "utf8")
      : block.type === "thinking"
        ? Buffer.byteLength(block.thinking, "utf8")
        : jsonTextBytes(block.arguments, limit - total);
    if (total > limit) break;
  }
  return total;
}

/**
 * Replays a newly constructed accepted sequence. Delta consumers can rebuild
 * every block from the emitted deltas, while snapshot consumers see one stable,
 * immutable accepted snapshot rather than retained mutable producer partials.
 * The terminal event and `result()` retain the exact accepted object.
 */
async function* acceptedEvents(
  terminal: AssistantMessage,
  partial: AssistantMessage,
): AsyncGenerator<AssistantMessageEvent> {
  const start = copyPartialMessage(terminal, []);
  deepFreeze(start);
  yield { type: "start", partial: start };

  for (let contentIndex = 0; contentIndex < partial.content.length; contentIndex += 1) {
    const accepted = partial.content[contentIndex]!;
    if (accepted.type === "text") {
      yield { type: "text_start", contentIndex, partial };
      yield { type: "text_delta", contentIndex, delta: accepted.text, partial };
      yield {
        type: "text_end",
        contentIndex,
        content: accepted.text,
        partial,
        ...(accepted.textSignature === undefined
          ? {}
          : { contentSignature: accepted.textSignature }),
      } as AssistantMessageEvent;
      continue;
    }
    if (accepted.type === "thinking") {
      yield { type: "thinking_start", contentIndex, partial };
      yield { type: "thinking_delta", contentIndex, delta: accepted.thinking, partial };
      yield {
        type: "thinking_end",
        contentIndex,
        content: accepted.thinking,
        partial,
        ...(accepted.thinkingSignature === undefined
          ? {}
          : { contentSignature: accepted.thinkingSignature }),
        ...(accepted.redacted === undefined ? {} : { redacted: accepted.redacted }),
      } as AssistantMessageEvent;
      continue;
    }
    yield { type: "toolcall_start", contentIndex, partial };
    yield {
      type: "toolcall_delta",
      contentIndex,
      delta: jsonText(accepted.arguments),
      partial,
    };
    yield { type: "toolcall_end", contentIndex, toolCall: accepted, partial };
  }

  yield {
    type: "done",
    reason: terminal.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse" | "deferred">,
    message: terminal,
  };
}

/**
 * Consume one candidate physical attempt privately and publish only an accepted
 * successful terminal. This function never selects or retries an account.
 */
export function createAcceptedOutputStream(
  upstream: AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
  options: AcceptedOutputOptions = {},
): AssistantMessageEventStream {
  const limits = assertLimits(options);
  let state: AttemptState = { status: "pending" };
  let claimed = false;
  let iterator: AsyncIterator<unknown> | undefined;
  let sourceReturn: Promise<void> | undefined;
  let resolveResult!: (message: AssistantMessage) => void;
  let rejectResult!: (error: AcceptedOutputError) => void;
  const resultPromise = new Promise<AssistantMessage>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A caller may consume iteration only. Mark the independent result branch as
  // observed so a rejected candidate cannot become an unhandled rejection.
  void resultPromise.catch(() => {});
  // Observe the caller-supplied promise synchronously. A pre-aborted signal must
  // not leave an already-rejecting upstream without a rejection handler.
  const upstreamPromise: Promise<AsyncIterable<unknown>> = Promise.resolve(upstream);
  void upstreamPromise.catch(() => {});

  const fail = (error: AcceptedOutputError): void => {
    if (state.status !== "pending") return;
    state = { status: "failed", error };
    rejectResult(error);
  };
  const accept = (terminal: AssistantMessage, partial: AssistantMessage): void => {
    if (state.status !== "pending") return;
    state = { status: "accepted", terminal, partial };
    resolveResult(terminal);
  };

  type AbortRace<T> =
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "aborted" };
  type TerminalCleanupRace = AbortRace<void> | { readonly kind: "timed-out" };

  let abortRequested = false;
  let abortWaiter: (() => void) | undefined;
  const onAbort = (): void => {
    if (abortRequested) return;
    abortRequested = true;
    const wake = abortWaiter;
    abortWaiter = undefined;
    wake?.();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  // A fresh, short-lived abort promise keeps at most one waiter reachable. In
  // contrast, repeatedly chaining from one never-settled promise retains one
  // reaction closure for every producer event until cancellation.
  const raceWithAbort = async <T>(operation: Promise<T>): Promise<AbortRace<T>> => {
    if (abortRequested) return { kind: "aborted" };
    let wake!: () => void;
    const abortForOperation = new Promise<AbortRace<T>>((resolve) => {
      wake = () => resolve({ kind: "aborted" });
      abortWaiter = wake;
    });
    if (abortRequested) wake();
    try {
      return await Promise.race([
        operation.then(
          (value): AbortRace<T> => ({ kind: "value", value }),
          (error: unknown): AbortRace<T> => ({ kind: "rejected", error }),
        ),
        abortForOperation,
      ]);
    } finally {
      if (abortWaiter === wake) abortWaiter = undefined;
    }
  };

  const raceTerminalCleanup = async (
    operation: Promise<void>,
  ): Promise<TerminalCleanupRace> => {
    if (abortRequested) return { kind: "aborted" };
    let wake!: () => void;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const abortForOperation = new Promise<TerminalCleanupRace>((resolve) => {
      wake = () => resolve({ kind: "aborted" });
      abortWaiter = wake;
    });
    const cleanupDeadline = new Promise<TerminalCleanupRace>((resolve) => {
      cleanupTimer = setTimeout(
        () => resolve({ kind: "timed-out" }),
        TERMINAL_CLEANUP_TIMEOUT_MS,
      );
    });
    if (abortRequested) wake();
    try {
      return await Promise.race([
        operation.then(
          (): TerminalCleanupRace => ({ kind: "value", value: undefined }),
          (error: unknown): TerminalCleanupRace => ({ kind: "rejected", error }),
        ),
        abortForOperation,
        cleanupDeadline,
      ]);
    } finally {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      if (abortWaiter === wake) abortWaiter = undefined;
    }
  };

  const releaseSource = (): Promise<void> => {
    if (sourceReturn !== undefined) return sourceReturn;
    const active = iterator;
    if (active === undefined) return Promise.resolve();
    iterator = undefined;
    try {
      const close = active.return;
      sourceReturn = close === undefined
        ? Promise.resolve()
        : Promise.resolve(close.call(active)).then(() => undefined);
    } catch (error) {
      sourceReturn = Promise.reject(error);
    }
    void sourceReturn.catch(() => {});
    return sourceReturn;
  };
  const releaseSourceQuietly = (): void => {
    void releaseSource().catch(() => {});
  };

  // Opening is started even for a pre-aborted call. If a promised source arrives
  // after cancellation, acquiring and immediately returning its iterator gives
  // the producer one deterministic cleanup path instead of abandoning it.
  const openedPromise = upstreamPromise.then((value) => {
    if (!isRecord(value) || !(Symbol.asyncIterator in value)) {
      throw new AcceptedOutputError("malformed");
    }
    let opened: AsyncIterator<unknown>;
    try {
      opened = value[Symbol.asyncIterator]();
    } catch {
      throw new AcceptedOutputError("malformed");
    }
    iterator = opened;
    if (abortRequested) releaseSourceQuietly();
    return opened;
  });
  void openedPromise.catch(() => {});

  void (async () => {
    let eventCount = 0;
    let byteCount = 0;
    try {
      if (abortRequested) {
        fail(new AcceptedOutputError("aborted"));
        return;
      }
      const opened = await raceWithAbort(openedPromise);
      if (opened.kind === "aborted" || abortRequested) {
        fail(new AcceptedOutputError("aborted"));
        return;
      }
      if (opened.kind === "rejected") {
        fail(
          opened.error instanceof AcceptedOutputError
            ? opened.error
            : new AcceptedOutputError("rejected"),
        );
        return;
      }

      while (state.status === "pending") {
        if (abortRequested) {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("aborted"));
          return;
        }
        let nextPromise: Promise<IteratorResult<unknown>>;
        try {
          nextPromise = Promise.resolve(opened.value.next());
        } catch {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("rejected"));
          return;
        }
        const next = await raceWithAbort(nextPromise);
        if (next.kind === "aborted" || abortRequested) {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("aborted"));
          return;
        }
        if (next.kind === "rejected") {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("rejected"));
          return;
        }
        if (next.value.done) {
          fail(new AcceptedOutputError("malformed"));
          return;
        }
        if (!isAssistantMessageEventEnvelope(next.value.value)) {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("malformed"));
          return;
        }

        const event = next.value.value;
        eventCount += 1;
        if (eventCount > limits.maxEvents) {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("overflow"));
          return;
        }
        byteCount += deltaBytes(event);
        if (byteCount > limits.maxBufferedBytes) {
          releaseSourceQuietly();
          fail(new AcceptedOutputError("overflow"));
          return;
        }

        if (event.type === "error") {
          releaseSourceQuietly();
          if (!isAssistantMessage(event.error)) {
            fail(new AcceptedOutputError("malformed"));
            return;
          }
          fail(new AcceptedOutputError(event.reason === "aborted" ? "aborted" : "rejected"));
          return;
        }
        if (event.type === "done") {
          const released = await raceTerminalCleanup(releaseSource());
          if (released.kind === "aborted" || abortRequested) {
            fail(new AcceptedOutputError("aborted"));
            return;
          }
          if (released.kind === "rejected" || released.kind === "timed-out") {
            fail(new AcceptedOutputError("rejected"));
            return;
          }
          // Cleanup is allowed to run producer finally blocks. Revalidate and
          // deeply validate the authoritative terminal only now, before sizing
          // or cloning, so replay and exact result cannot diverge.
          if (
            !isAssistantMessageEventEnvelope(event) ||
            event.type !== "done" ||
            !isAssistantMessage(event.message)
          ) {
            fail(new AcceptedOutputError("malformed"));
            return;
          }
          const replayEvents = 2 + event.message.content.length * 3;
          if (replayEvents > limits.maxEvents) {
            fail(new AcceptedOutputError("overflow"));
            return;
          }
          let projectedBytes: number;
          try {
            projectedBytes = projectedAcceptedBytes(
              event.message,
              limits.maxBufferedBytes,
            );
          } catch {
            fail(new AcceptedOutputError("malformed"));
            return;
          }
          if (projectedBytes > limits.maxBufferedBytes) {
            fail(new AcceptedOutputError("overflow"));
            return;
          }
          let partial: AssistantMessage;
          try {
            partial = acceptedPartial(event.message);
          } catch {
            fail(new AcceptedOutputError("malformed"));
            return;
          }
          accept(event.message, partial);
          return;
        }
      }
    } catch (error) {
      releaseSourceQuietly();
      fail(error instanceof AcceptedOutputError ? error : new AcceptedOutputError("malformed"));
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      iterator = undefined;
    }
  })();

  const stream = {
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      if (claimed) {
        return {
          next: () => Promise.reject(new AcceptedOutputError("malformed")),
        };
      }
      claimed = true;
      let closed = false;
      let replay: AsyncIterator<AssistantMessageEvent> | undefined;
      return {
        async next(): Promise<IteratorResult<AssistantMessageEvent>> {
          if (closed) return { value: undefined, done: true };
          if (replay === undefined) {
            await resultPromise;
            if (closed) return { value: undefined, done: true };
            if (state.status !== "accepted" || state.partial === undefined) {
              throw new AcceptedOutputError("malformed");
            }
            const { terminal, partial } = state;
            replay = acceptedEvents(terminal, partial)[Symbol.asyncIterator]();
            // The replay iterator now owns the sole accepted snapshot. The stream
            // retains only the exact terminal object required by result().
            state = { status: "accepted", terminal, partial: undefined };
          }
          const next = await replay.next();
          if (closed) return { value: undefined, done: true };
          if (next.done) {
            replay = undefined;
            closed = true;
          }
          return next;
        },
        async return(): Promise<IteratorResult<AssistantMessageEvent>> {
          if (closed) return { value: undefined, done: true };
          closed = true;
          onAbort();
          releaseSourceQuietly();
          if (state.status === "accepted" && state.partial !== undefined) {
            state = { status: "accepted", terminal: state.terminal, partial: undefined };
          }
          if (replay?.return !== undefined) {
            try {
              await replay.return();
            } catch {
              // The replay is local and content-free on cleanup failure.
            }
          }
          replay = undefined;
          return { value: undefined, done: true };
        },
      };
    },
    result(): Promise<AssistantMessage> {
      return resultPromise;
    },
  };

  return stream as AssistantMessageEventStream;
}
