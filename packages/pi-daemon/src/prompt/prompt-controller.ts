import { createHash, randomUUID } from "node:crypto";

import type { PromptOptions } from "@earendil-works/pi-coding-agent";

import { HostQueue } from "../host/host-queue.js";
import type {
  AwakeSessionHost,
  HostCommittedEntry,
  HostSdkEvent,
} from "../host/index.js";
import type { LeaseArbiter } from "../lease/index.js";
import {
  ERROR_CODES,
  type CustomEntryData,
  type ErrorCode,
  type OperationParams,
  type OperationResult,
  type PromptOutcomeErrorCode,
  type PromptStatusResult,
  type RequestFrame,
} from "../protocol/index.js";
import type { PromptIndexRecord, Registry } from "../registry/index.js";
import {
  ServerRequestError,
  type RequestDispatchContext,
  type RequestDispatcher,
} from "../server/index.js";
import { sanitizeAttributionLabel } from "./attribution.js";

export interface CanonicalPromptOptions {
  readonly expandPromptTemplates?: boolean;
  readonly source?: NonNullable<PromptOptions["source"]>;
}

export interface CanonicalPromptPayload {
  readonly sessionId: string;
  readonly text: string;
  readonly whenBusy: "reject" | "queue";
  readonly options: {
    readonly expandPromptTemplates: boolean;
    readonly source: NonNullable<PromptOptions["source"]>;
  };
}

export interface PromptSubmissionInput {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly text: string;
  readonly whenBusy: "reject" | "queue";
  readonly clientId: string;
  readonly attribution: ControlAttribution;
  readonly options?: CanonicalPromptOptions;
}

export interface AttachmentAuthorityInput {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
}

export interface ControlAttribution {
  readonly actorId: string;
  readonly label?: string;
}

export interface QueuedInputSubmission {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly text: string;
  readonly attribution: ControlAttribution;
}

export interface AbortSubmission {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly reason?: string;
}

export type PromptStatusInput = { readonly sessionId: string } &
  (
    | { readonly promptId: string; readonly idempotencyKey?: never }
    | { readonly promptId?: never; readonly idempotencyKey: string }
  );

export interface PromptControllerOptions {
  readonly registry: Registry;
  readonly leaseArbiter: Pick<LeaseArbiter, "assertDriver">;
  readonly getAwakeHost: (sessionId: string) => AwakeSessionHost | undefined;
  readonly assertAttached: (
    input: AttachmentAuthorityInput,
  ) => void | Promise<void>;
  readonly now?: () => number;
  readonly promptId?: () => string;
  readonly inputId?: () => string;
}

interface ResponseDeferred {
  readonly promise: Promise<OperationResult<"prompt">>;
  readonly resolve: (result: OperationResult<"prompt">) => void;
  readonly reject: (error: unknown) => void;
}

interface SettlementBarrier {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface PromptDispatchState {
  readonly sessionId: string;
  readonly keyHash: string;
  readonly payloadHash: string;
  readonly promptId: string;
  readonly text: string;
  readonly acceptedAtMs: number;
  readonly disposition: "started" | "queued";
  readonly host: AwakeSessionHost;
  readonly response: ResponseDeferred;
  readonly eventStartSequence: number;
  readonly claimEntryId: string;
  readonly deliveryOrder: number;
  promptPromise: Promise<void>;
  preflightAccepted: boolean | undefined;
  queuedBySdk: boolean;
  agentStarted: boolean;
  userEntryId: string | undefined;
  finalEntryId: string | undefined;
  settlementScheduled: boolean;
  terminalEntryId: string | null;
  responseSettled: boolean;
  terminal: boolean;
}

interface PromptResponseBox {
  readonly response: Promise<OperationResult<"prompt">>;
}

interface HostBinding {
  readonly host: AwakeSessionHost;
  readonly unsubscribe: () => void;
  unclaimedUserEntriesToSkip: number;
}

type TerminalSelection =
  | { readonly outcome: "settled" }
  | { readonly outcome: "aborted"; readonly errorCode: "aborted" }
  | {
      readonly outcome: "failed";
      readonly errorCode: Exclude<PromptOutcomeErrorCode, "aborted">;
    };

function settlementBarrier(): SettlementBarrier {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredResponse(): ResponseDeferred {
  let resolve!: ResponseDeferred["resolve"];
  let reject!: ResponseDeferred["reject"];
  const promise = new Promise<OperationResult<"prompt">>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function canonicalPromptPayload(
  input: Pick<PromptSubmissionInput, "sessionId" | "text" | "whenBusy" | "options">,
): CanonicalPromptPayload {
  return {
    sessionId: input.sessionId,
    text: input.text,
    whenBusy: input.whenBusy,
    options: {
      expandPromptTemplates: input.options?.expandPromptTemplates ?? true,
      source: input.options?.source ?? "interactive",
    },
  };
}

export function promptPayloadSha256(
  input: Pick<PromptSubmissionInput, "sessionId" | "text" | "whenBusy" | "options">,
): string {
  return sha256(JSON.stringify(canonicalPromptPayload(input)));
}

export function promptIdempotencyKeyHash(idempotencyKey: string): string {
  return sha256(idempotencyKey);
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
  return new ServerRequestError("internal", "prompt handler failed");
}

function statusFromRecord(
  record: PromptIndexRecord,
  epoch: number,
  externalWriter: boolean,
): PromptStatusResult {
  const acceptedAt = new Date(record.acceptedAtMs).toISOString();
  if (record.state === "pending") {
    return {
      state: "pending",
      promptId: record.promptId,
      acceptedAt,
      ...(externalWriter ? { reason: "external_writer" as const } : {}),
    };
  }

  if (record.settledAtMs === null) {
    throw new Error(`terminal prompt index has no settled timestamp: ${record.promptId}`);
  }
  const common = {
    promptId: record.promptId,
    acceptedAt,
    settledAt: new Date(record.settledAtMs).toISOString(),
    ...(record.finalEntryId === null
      ? {}
      : { finalCursor: { entryId: record.finalEntryId, epoch } }),
  };
  if (record.state === "settled") {
    return { state: "settled", terminalOutcome: "settled", ...common };
  }
  if (record.state === "aborted") {
    if (record.errorCode !== "aborted") {
      throw new Error(`aborted prompt index has invalid error code: ${record.promptId}`);
    }
    return {
      state: "aborted",
      terminalOutcome: "aborted",
      errorCode: "aborted",
      ...common,
    };
  }
  if (record.errorCode === null || record.errorCode === "aborted") {
    throw new Error(`failed prompt index has invalid error code: ${record.promptId}`);
  }
  return {
    state: "failed",
    terminalOutcome: "failed",
    errorCode: record.errorCode,
    ...common,
  };
}

export class PromptController {
  readonly #registry: Registry;
  readonly #leaseArbiter: Pick<LeaseArbiter, "assertDriver">;
  readonly #getAwakeHost: PromptControllerOptions["getAwakeHost"];
  readonly #assertAttached: PromptControllerOptions["assertAttached"];
  readonly #now: () => number;
  readonly #promptId: () => string;
  readonly #inputId: () => string;
  readonly #queues = new Map<string, HostQueue>();
  readonly #statesByKey = new Map<string, PromptDispatchState>();
  readonly #bindings = new Map<string, HostBinding>();
  readonly #backgroundTasks = new Map<Promise<void>, string>();
  readonly #backgroundErrors = new Map<string, unknown>();
  readonly #abortSettlements = new Map<string, SettlementBarrier>();
  readonly #abortSettlementFailures = new Map<string, ServerRequestError>();
  #nextDeliveryOrder = 1;
  #disposed = false;

  constructor(options: PromptControllerOptions) {
    this.#registry = options.registry;
    this.#leaseArbiter = options.leaseArbiter;
    this.#getAwakeHost = options.getAwakeHost;
    this.#assertAttached = options.assertAttached;
    this.#now = options.now ?? Date.now;
    this.#promptId = options.promptId ?? randomUUID;
    this.#inputId = options.inputId ?? randomUUID;
  }

  async prompt(input: PromptSubmissionInput): Promise<OperationResult<"prompt">> {
    try {
      this.assertActive();
      this.assertAbortSettlementHealthy(input.sessionId);
      const abortSettlement = this.#abortSettlements.get(input.sessionId);
      if (abortSettlement !== undefined) {
        await abortSettlement.promise;
        return await this.prompt(input);
      }
      const box = await this.queueFor(input.sessionId).enqueue(async () => {
        const nowMs = this.#now();
        await this.#leaseArbiter.assertDriver({
          sessionId: input.sessionId,
          attachmentId: input.attachmentId,
          leaseId: input.leaseId,
          generation: input.generation,
          nowMs,
        });
        const host = this.requireAwakeHost(input.sessionId);
        return await this.acceptPrompt(host, input, nowMs);
      });
      return await box.response;
    } catch (error) {
      throw requestError(error);
    }
  }

  async steer(input: QueuedInputSubmission): Promise<OperationResult<"steer">> {
    return await this.queueInput("steer", input);
  }

  async followUp(input: QueuedInputSubmission): Promise<OperationResult<"follow_up">> {
    return await this.queueInput("follow_up", input);
  }

  async abort(input: AbortSubmission): Promise<OperationResult<"abort">> {
    this.assertAbortSettlementHealthy(input.sessionId);
    let precedingAbort = this.#abortSettlements.get(input.sessionId);
    while (precedingAbort !== undefined) {
      await precedingAbort.promise;
      this.assertAbortSettlementHealthy(input.sessionId);
      precedingAbort = this.#abortSettlements.get(input.sessionId);
    }
    const barrier = settlementBarrier();
    this.#abortSettlements.set(input.sessionId, barrier);
    let abortStarted = false;
    try {
      this.assertActive();
      const accepted = await this.queueFor(input.sessionId).enqueue(async () => {
        this.requireCurrentGeneration(input.sessionId, input.generation);
        await this.#assertAttached({
          sessionId: input.sessionId,
          connectionId: input.connectionId,
          attachmentId: input.attachmentId,
        });
        await this.#leaseArbiter.assertDriver({
          sessionId: input.sessionId,
          attachmentId: input.attachmentId,
          leaseId: input.leaseId,
          generation: input.generation,
          nowMs: this.#now(),
        });
        const host = this.requireAwakeHost(input.sessionId);
        const aborted = host.session.isStreaming;
        abortStarted = true;
        await host.session.abort();
        // The SDK now preserves undelivered steering and follow-ups on abort.
        // Discard them only after the run settles so they cannot reach a later prompt.
        host.session.clearQueue();
        await host.drain();
        return { aborted, host };
      });
      await this.drain(input.sessionId);
      const session = this.requireCurrentGeneration(input.sessionId, input.generation);
      await accepted.host.drain();
      return {
        aborted: accepted.aborted,
        cursor: {
          entryId: accepted.host.sessionManager.getLeafId(),
          epoch: session.epoch,
        },
        generation: session.generation,
      };
    } catch (error) {
      const normalized = requestError(error);
      if (abortStarted) this.#abortSettlementFailures.set(input.sessionId, normalized);
      throw normalized;
    } finally {
      if (this.#abortSettlements.get(input.sessionId) === barrier) {
        this.#abortSettlements.delete(input.sessionId);
      }
      barrier.resolve();
    }
  }

  promptStatus(input: PromptStatusInput): PromptStatusResult {
    try {
      const session = this.#registry.getSession(input.sessionId);
      if (session === undefined) {
        throw new ServerRequestError("unknown_session", `unknown session: ${input.sessionId}`);
      }
      const record =
        input.promptId === undefined
          ? this.#registry.getPromptByKeyHash(
              input.sessionId,
              promptIdempotencyKeyHash(input.idempotencyKey),
            )
          : this.#registry.getPromptById(input.promptId);
      if (record === undefined || record.sessionId !== input.sessionId) {
        return { state: "unknown" };
      }
      return statusFromRecord(
        record,
        session.epoch,
        session.failureCode === "external_writer",
      );
    } catch (error) {
      throw requestError(error);
    }
  }

  async drain(sessionId?: string): Promise<void> {
    const queues =
      sessionId === undefined ? [...this.#queues.values()] : [this.queueFor(sessionId)];
    const pendingTasks = () =>
      [...this.#backgroundTasks].filter(
        ([, taskSessionId]) => sessionId === undefined || taskSessionId === sessionId,
      );
    for (const queue of queues) await queue.drain();
    while (pendingTasks().length > 0) {
      await Promise.allSettled(pendingTasks().map(([task]) => task));
      for (const queue of queues) await queue.drain();
    }
    const error =
      sessionId === undefined
        ? this.#backgroundErrors.values().next().value
        : this.#backgroundErrors.get(sessionId);
    if (error !== undefined) throw error;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const binding of this.#bindings.values()) binding.unsubscribe();
    this.#bindings.clear();
  }

  private async queueInput<O extends "steer" | "follow_up">(
    operation: O,
    input: QueuedInputSubmission,
  ): Promise<OperationResult<O>> {
    try {
      this.assertActive();
      this.assertAbortSettlementHealthy(input.sessionId);
      const abortSettlement = this.#abortSettlements.get(input.sessionId);
      if (abortSettlement !== undefined) {
        await abortSettlement.promise;
        return await this.queueInput(operation, input);
      }
      return await this.queueFor(input.sessionId).enqueue(async () => {
        const session = this.requireCurrentGeneration(input.sessionId, input.generation);
        await this.#assertAttached({
          sessionId: input.sessionId,
          connectionId: input.connectionId,
          attachmentId: input.attachmentId,
        });
        const host = this.requireAwakeHost(input.sessionId);
        if (!host.session.isStreaming) {
          throw new ServerRequestError(
            "invalid_state",
            `${operation} requires an active session run`,
          );
        }
        const inputId = this.#inputId();
        const data: CustomEntryData<"pi-daemon/input"> = {
          v: 1,
          inputId,
          operation,
          actorId: input.attribution.actorId,
          contentSha256: sha256(input.text),
          generation: input.generation,
          epoch: session.epoch,
          at: new Date(this.#now()).toISOString(),
        };
        await host.appendDaemonEntry("pi-daemon/input", data);
        await host.drain();
        try {
          if (operation === "steer") await host.session.steer(input.text);
          else await host.session.followUp(input.text);
        } catch {
          throw new ServerRequestError("rejected", `${operation} was rejected by the SDK`);
        }
        return { queued: true, inputId } as OperationResult<O>;
      });
    } catch (error) {
      throw requestError(error);
    }
  }

  private assertAbortSettlementHealthy(sessionId: string): void {
    if (this.#abortSettlementFailures.has(sessionId)) {
      throw new ServerRequestError(
        "unavailable",
        `previous abort settlement failed for session ${sessionId}`,
      );
    }
  }

  private requireCurrentGeneration(sessionId: string, generation: number) {
    const session = this.#registry.getSession(sessionId);
    if (session === undefined) {
      throw new ServerRequestError("unknown_session", `unknown session: ${sessionId}`);
    }
    if (session.generation !== generation) {
      throw new ServerRequestError(
        "stale_generation",
        `stale generation ${generation}; current generation is ${session.generation}`,
      );
    }
    return session;
  }

  private requireAwakeHost(sessionId: string): AwakeSessionHost {
    const host = this.#getAwakeHost(sessionId);
    if (host !== undefined) return host;
    const session = this.#registry.getSession(sessionId);
    throw new ServerRequestError(
      session?.failureCode === "external_writer" ? "external_writer" : "asleep",
      `session has no awake host: ${sessionId}`,
    );
  }

  private queueFor(sessionId: string): HostQueue {
    let queue = this.#queues.get(sessionId);
    if (queue === undefined) {
      queue = new HostQueue();
      this.#queues.set(sessionId, queue);
    }
    return queue;
  }

  private stateKey(sessionId: string, keyHash: string): string {
    return `${sessionId}\u0000${keyHash}`;
  }

  private async acceptPrompt(
    host: AwakeSessionHost,
    input: PromptSubmissionInput,
    acceptedAtMs: number,
  ): Promise<PromptResponseBox> {
    this.assertActive();
    const keyHash = promptIdempotencyKeyHash(input.idempotencyKey);
    const payloadHash = promptPayloadSha256(input);
    const stateKey = this.stateKey(input.sessionId, keyHash);
    const live = this.#statesByKey.get(stateKey);
    if (live !== undefined) {
      if (live.payloadHash !== payloadHash) {
        throw new ServerRequestError(
          "idempotency_conflict",
          "idempotency key is already bound to a different prompt payload",
        );
      }
      return {
        response: live.responseSettled
          ? Promise.resolve({
              outcome: "known",
              status: this.promptStatus({
                sessionId: input.sessionId,
                idempotencyKey: input.idempotencyKey,
              }),
            })
          : live.response.promise,
      };
    }

    const indexed = this.#registry.getPromptByKeyHash(input.sessionId, keyHash);
    if (indexed !== undefined) {
      if (indexed.payloadHash !== payloadHash) {
        throw new ServerRequestError(
          "idempotency_conflict",
          "idempotency key is already bound to a different prompt payload",
        );
      }
      return {
        response: Promise.resolve({
          outcome: "known",
          status: statusFromRecord(
            indexed,
            this.#registry.getSession(input.sessionId)?.epoch ?? 0,
            this.#registry.getSession(input.sessionId)?.failureCode === "external_writer",
          ),
        }),
      };
    }

    const hasControllerWork = [...this.#statesByKey.values()].some(
      (state) => state.sessionId === input.sessionId && !state.terminal,
    );
    const busy = host.session.isStreaming || hasControllerWork;
    if (busy && input.whenBusy === "reject") {
      throw new ServerRequestError("busy", `session is busy: ${input.sessionId}`);
    }
    const disposition = busy ? "queued" : "started";
    const promptId = this.#promptId();
    const claimData: CustomEntryData<"pi-daemon/prompt-claim"> = {
      v: 1,
      promptId,
      idempotencyKey: input.idempotencyKey,
      payloadSha256: payloadHash,
      clientId: input.clientId,
      attribution: { actorId: input.attribution.actorId },
      acceptedAt: new Date(acceptedAtMs).toISOString(),
    };
    const claimEntryId = await host.appendDaemonEntry(
      "pi-daemon/prompt-claim",
      claimData,
    );
    await host.drain();
    this.#registry.recordPromptClaim({
      sessionId: input.sessionId,
      keyHash,
      payloadHash,
      promptId,
      claimEntryId,
      acceptedAtMs,
    });

    this.bindHost(host, host.session.isStreaming && !hasControllerWork);
    const canonical = canonicalPromptPayload(input);
    const response = deferredResponse();
    const state: PromptDispatchState = {
      sessionId: input.sessionId,
      keyHash,
      payloadHash,
      promptId,
      text: input.text,
      acceptedAtMs,
      disposition,
      host,
      response,
      eventStartSequence: host.sdkEventSequence,
      claimEntryId,
      deliveryOrder: this.#nextDeliveryOrder++,
      promptPromise: Promise.resolve(),
      preflightAccepted: undefined,
      queuedBySdk: false,
      agentStarted: false,
      userEntryId: undefined,
      finalEntryId: undefined,
      settlementScheduled: false,
      terminalEntryId: null,
      responseSettled: false,
      terminal: false,
    };
    this.#statesByKey.set(stateKey, state);

    const promptOptions: PromptOptions = {
      expandPromptTemplates: canonical.options.expandPromptTemplates,
      source: canonical.options.source,
      ...(disposition === "queued" ? { streamingBehavior: "followUp" as const } : {}),
      preflightResult: (result) => {
        const success = true;
        const queuedBySdk =
          result === "queued" && disposition === "queued" && host.session.pendingMessageCount > 0;
        this.track(
          this.queueFor(input.sessionId).enqueue(() =>
            this.handlePreflight(state, success, queuedBySdk),
          ),
          input.sessionId,
        );
      },
    };
    state.promptPromise = host.session.prompt(input.text, promptOptions);
    this.observePromptCompletion(state);
    return { response: state.response.promise };
  }

  private bindHost(host: AwakeSessionHost, skipUnclaimedUserEntry: boolean): void {
    const existing = this.#bindings.get(host.sessionId);
    if (existing?.host === host) {
      if (skipUnclaimedUserEntry) existing.unclaimedUserEntriesToSkip += 1;
      return;
    }
    existing?.unsubscribe();
    const unsubscribeSdk = host.subscribeSdkEvents((event) => {
      this.track(
        this.queueFor(host.sessionId).enqueue(() => this.handleSdkEvent(event)),
        host.sessionId,
      );
    });
    const unsubscribeCommitted = host.subscribeCommittedEntries((entry) => {
      this.track(
        this.queueFor(host.sessionId).enqueue(() => this.handleCommittedEntry(entry)),
        host.sessionId,
      );
    });
    this.#bindings.set(host.sessionId, {
      host,
      unsubscribe: () => {
        unsubscribeSdk();
        unsubscribeCommitted();
      },
      unclaimedUserEntriesToSkip: skipUnclaimedUserEntry ? 1 : 0,
    });
  }

  private handlePreflight(
    state: PromptDispatchState,
    success: boolean,
    queuedBySdk: boolean,
  ): void {
    if (this.#disposed || state.terminal || state.preflightAccepted !== undefined) return;
    state.preflightAccepted = success;
    state.queuedBySdk = queuedBySdk;
    if (success) {
      state.responseSettled = true;
      state.response.resolve({
        outcome: "accepted",
        disposition: state.disposition,
        promptId: state.promptId,
        generation: state.host.generation,
      });
      return;
    }
    this.scheduleTerminal(
      state,
      { outcome: "failed", errorCode: "rejected" },
      new ServerRequestError("rejected", "prompt was rejected before acceptance"),
    );
  }

  private handleCommittedEntry(publication: HostCommittedEntry): void {
    if (this.#disposed || publication.entry.type !== "message") return;
    const entry = publication.entry;
    if (entry.message.role === "user") {
      const candidates = [...this.#statesByKey.values()]
        .filter(
          (state) =>
            state.sessionId === publication.sessionId &&
            !state.terminal &&
            state.preflightAccepted === true &&
            state.userEntryId === undefined,
        )
        .sort((left, right) => left.deliveryOrder - right.deliveryOrder);
      const binding = this.#bindings.get(publication.sessionId);
      if (binding !== undefined && binding.unclaimedUserEntriesToSkip > 0) {
        binding.unclaimedUserEntriesToSkip -= 1;
        return;
      }
      const content = "content" in entry.message ? entry.message.content : undefined;
      const exact = candidates.find(
        (state) => state.text === messageText(content),
      );
      if (exact !== undefined) {
        exact.userEntryId = entry.id;
        return;
      }
      const next = candidates[0];
      if (next !== undefined) next.userEntryId = entry.id;
      return;
    }
    if (entry.message.role !== "assistant") return;
    const current = [...this.#statesByKey.values()]
      .filter(
        (state) =>
          state.sessionId === publication.sessionId &&
          !state.terminal &&
          state.userEntryId !== undefined,
      )
      .sort((left, right) => right.deliveryOrder - left.deliveryOrder)[0];
    if (current !== undefined) current.finalEntryId = entry.id;
  }

  private handleSdkEvent(publication: HostSdkEvent): void {
    if (this.#disposed) return;
    const candidates = [...this.#statesByKey.values()].filter(
      (state) =>
        state.sessionId === publication.sessionId &&
        !state.terminal &&
        publication.sequence > state.eventStartSequence,
    );
    if (publication.event.type === "agent_start") {
      for (const state of candidates) {
        if (state.disposition === "started") state.agentStarted = true;
      }
      return;
    }
    if (publication.event.type !== "agent_settled") return;
    for (const state of candidates) {
      if (
        state.preflightAccepted === true &&
        (state.agentStarted || state.queuedBySdk)
      ) {
        this.scheduleTerminal(state);
      }
    }
  }

  private observePromptCompletion(state: PromptDispatchState): void {
    const observed = state.promptPromise.then(
      async () => {
        try {
          await state.host.drain();
        } catch (error) {
          if (!this.isExternalWriter(state.sessionId)) throw error;
        }
        await this.queueFor(state.sessionId).enqueue(() => {
          if (
            this.#disposed ||
            state.terminal ||
            state.settlementScheduled ||
            state.preflightAccepted !== true
          ) {
            return;
          }
          if (!state.agentStarted && !state.queuedBySdk) {
            this.scheduleTerminal(state, { outcome: "settled" });
          }
        });
      },
      async (error: unknown) => {
        try {
          await state.host.drain();
        } catch {
          // The registry failure state below is authoritative after host fencing.
        }
        await this.queueFor(state.sessionId).enqueue(() => {
          if (this.#disposed || state.terminal || state.settlementScheduled) return;
          if (this.isExternalWriter(state.sessionId)) {
            if (!state.responseSettled) {
              state.responseSettled = true;
              state.response.reject(requestError(error));
            }
            return;
          }
          const preflightRejected = state.preflightAccepted !== true;
          this.scheduleTerminal(
            state,
            preflightRejected
              ? { outcome: "failed", errorCode: "rejected" }
              : { outcome: "failed", errorCode: "sdk_error" },
            preflightRejected
              ? new ServerRequestError("rejected", "prompt was rejected before acceptance")
              : undefined,
          );
        });
      },
    );
    this.track(observed, state.sessionId);
  }

  private scheduleTerminal(
    state: PromptDispatchState,
    forced?: TerminalSelection,
    responseError?: ServerRequestError,
  ): void {
    if (this.#disposed || state.terminal || state.settlementScheduled) return;
    state.settlementScheduled = true;
    state.terminalEntryId =
      state.finalEntryId ?? state.userEntryId ?? state.claimEntryId;
    const task = (async () => {
      await state.promptPromise.catch(() => undefined);
      try {
        await state.host.drain();
      } catch {
        // An external-writer fence is checked before the only possible write.
      }
      await this.queueFor(state.sessionId).enqueue(() =>
        this.persistTerminal(state, forced, responseError),
      );
    })();
    this.track(task, state.sessionId);
  }

  private async persistTerminal(
    state: PromptDispatchState,
    forced: TerminalSelection | undefined,
    responseError: ServerRequestError | undefined,
  ): Promise<void> {
    if (this.#disposed || state.terminal) return;
    if (this.isExternalWriter(state.sessionId)) {
      state.settlementScheduled = false;
      this.rejectPendingForExternalWriter(state);
      return;
    }

    const terminal = forced ?? this.terminalFromSession(state.host);
    const finalEntryId = state.terminalEntryId;
    const settledAtMs = this.#now();
    const stopReason = forced === undefined ? this.lastAssistantStopReason(state.host) : undefined;
    const common = {
      v: 1 as const,
      promptId: state.promptId,
      finalEntryId,
      ...(stopReason === undefined ? {} : { stopReason }),
      settledAt: new Date(settledAtMs).toISOString(),
    };
    const data: CustomEntryData<"pi-daemon/prompt-outcome"> =
      terminal.outcome === "settled"
        ? { ...common, outcome: "settled" }
        : terminal.outcome === "aborted"
          ? { ...common, outcome: "aborted", errorCode: terminal.errorCode }
          : { ...common, outcome: "failed", errorCode: terminal.errorCode };

    let outcomeEntryId: string;
    try {
      outcomeEntryId = await state.host.appendDaemonEntry(
        "pi-daemon/prompt-outcome",
        data,
      );
      await state.host.drain();
    } catch (error) {
      if (this.isExternalWriter(state.sessionId)) {
        state.settlementScheduled = false;
        this.rejectPendingForExternalWriter(state);
        return;
      }
      throw error;
    }
    this.#registry.recordPromptOutcome({
      promptId: state.promptId,
      outcomeEntryId,
      finalEntryId,
      settledAtMs,
      ...(terminal.outcome === "settled"
        ? { outcome: "settled" as const }
        : terminal.outcome === "aborted"
          ? { outcome: "aborted" as const, errorCode: terminal.errorCode }
          : { outcome: "failed" as const, errorCode: terminal.errorCode }),
    });
    state.terminal = true;
    this.#statesByKey.delete(this.stateKey(state.sessionId, state.keyHash));
    if (!state.responseSettled) {
      state.responseSettled = true;
      if (responseError === undefined) {
        state.response.resolve({
          outcome: "known",
          status: this.promptStatus({
            sessionId: state.sessionId,
            promptId: state.promptId,
          }),
        });
      } else {
        state.response.reject(responseError);
      }
    }
  }

  private rejectPendingForExternalWriter(state: PromptDispatchState): void {
    if (state.responseSettled) return;
    state.responseSettled = true;
    state.response.reject(
      new ServerRequestError(
        "external_writer",
        `session file ownership changed: ${state.sessionId}`,
      ),
    );
  }

  private terminalFromSession(host: AwakeSessionHost): TerminalSelection {
    const stopReason = this.lastAssistantStopReason(host);
    if (stopReason === "aborted") return { outcome: "aborted", errorCode: "aborted" };
    if (stopReason === "error") {
      return { outcome: "failed", errorCode: "provider_error" };
    }
    return { outcome: "settled" };
  }

  private lastAssistantStopReason(host: AwakeSessionHost): string | undefined {
    const assistant = [...host.session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    return assistant?.role === "assistant" ? assistant.stopReason : undefined;
  }

  private isExternalWriter(sessionId: string): boolean {
    return this.#registry.getSession(sessionId)?.failureCode === "external_writer";
  }

  private track(task: Promise<unknown>, sessionId: string): void {
    if (this.#disposed) return;
    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        if (!this.#backgroundErrors.has(sessionId)) {
          this.#backgroundErrors.set(sessionId, error);
        }
      },
    );
    this.#backgroundTasks.set(tracked, sessionId);
    void tracked.finally(() => this.#backgroundTasks.delete(tracked));
  }

  private assertActive(): void {
    if (this.#disposed) {
      throw new ServerRequestError("unavailable", "prompt controller is disposed");
    }
  }
}

function requiredSession(request: RequestFrame): string {
  if (request.session === undefined) {
    throw new ServerRequestError("invalid_request", `${request.op} requires a session`);
  }
  return request.session;
}

export function createPromptRequestDispatcher(
  controller: PromptController,
): RequestDispatcher {
  return async (request: RequestFrame, context: RequestDispatchContext) => {
    switch (request.op) {
      case "prompt":
        return await controller.prompt({
          sessionId: requiredSession(request),
          attachmentId: request.params.attachmentId,
          leaseId: request.params.leaseId,
          generation: request.params.generation,
          idempotencyKey: request.params.idempotencyKey,
          text: request.params.text,
          whenBusy: request.params.whenBusy,
          clientId: context.connectionId,
          attribution: {
            actorId: context.actorId,
            ...(request.params.attribution?.label === undefined
              ? {}
              : {
                  label: sanitizeAttributionLabel(request.params.attribution.label),
                }),
          },
        });
      case "prompt_status": {
        const params: OperationParams<"prompt_status"> = request.params;
        return controller.promptStatus({
          sessionId: requiredSession(request),
          ...("promptId" in params
            ? { promptId: params.promptId }
            : { idempotencyKey: params.idempotencyKey }),
        });
      }
      default:
        throw new ServerRequestError(
          "unavailable",
          `operation ${request.op} is not handled by the prompt controller`,
        );
    }
  };
}
