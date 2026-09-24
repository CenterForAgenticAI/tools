import type { EventBus } from "@earendil-works/pi-coding-agent";
import { isActiveJob, jobOwnedBySession, listJobs } from "./store.ts";
import type { CallbackJob, SessionRef } from "./types.ts";

export const CALLBACKS_SERVICE_PROTOCOL_VERSION = 1 as const;
export const CALLBACKS_SERVICE_DISCOVERY_EVENT = "callbacks:service:v1:discover";

export interface PendingWorkSummaryV1 {
  /** Total non-terminal jobs owned by the current session. */
  count: number;
  /** Earliest due time across jobs that have one. Absent when none do. */
  nextDueAt?: string;
  /** Jobs with no due time at all: running scripts and uncalled token callbacks. */
  openEndedCount: number;
}

export interface CallbacksServiceV1 {
  protocolVersion: typeof CALLBACKS_SERVICE_PROTOCOL_VERSION;
  pendingWorkSummary(): PendingWorkSummaryV1;
}

export interface CallbacksServiceDiscoveryRequestV1 {
  protocolVersion: typeof CALLBACKS_SERVICE_PROTOCOL_VERSION;
  consumerId: string;
  accept(service: CallbacksServiceV1): void;
}

export function createCallbacksServiceV1(session: SessionRef): CallbacksServiceV1 {
  return {
    protocolVersion: CALLBACKS_SERVICE_PROTOCOL_VERSION,
    pendingWorkSummary(): PendingWorkSummaryV1 {
      const activeJobs = listJobs()
        .filter((job) => isActiveJob(job))
        .filter((job) => jobOwnedBySession(job, session));
      let nextDueAtMs: number | undefined;
      let openEndedCount = 0;
      for (const job of activeJobs) {
        const dueAt = jobDueAt(job);
        if (dueAt === undefined || !Number.isFinite(dueAt)) {
          openEndedCount++;
          continue;
        }
        if (nextDueAtMs === undefined || dueAt < nextDueAtMs) nextDueAtMs = dueAt;
      }
      return {
        count: activeJobs.length,
        ...(nextDueAtMs === undefined ? {} : { nextDueAt: new Date(nextDueAtMs).toISOString() }),
        openEndedCount,
      };
    },
  };
}

export function provideCallbacksServiceV1(events: EventBus, service: CallbacksServiceV1): () => void {
  return events.on(CALLBACKS_SERVICE_DISCOVERY_EVENT, (value) => {
    if (!isDiscoveryRequest(value)) return;
    value.accept(service);
  });
}

export function discoverCallbacksServiceV1(
  events: EventBus,
  consumerId: string,
): CallbacksServiceV1 | undefined {
  let discovered: CallbacksServiceV1 | undefined;
  events.emit(CALLBACKS_SERVICE_DISCOVERY_EVENT, {
    protocolVersion: CALLBACKS_SERVICE_PROTOCOL_VERSION,
    consumerId,
    accept(service: CallbacksServiceV1) {
      discovered ??= service;
    },
  } satisfies CallbacksServiceDiscoveryRequestV1);
  return discovered;
}

function isDiscoveryRequest(value: unknown): value is CallbacksServiceDiscoveryRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CallbacksServiceDiscoveryRequestV1>;
  return request.protocolVersion === CALLBACKS_SERVICE_PROTOCOL_VERSION &&
    typeof request.consumerId === "string" && request.consumerId.trim().length > 0 &&
    typeof request.accept === "function";
}

function jobDueAt(job: CallbackJob): number | undefined {
  if (job.kind === "reminder") return job.dueAt;
  if (job.kind === "poll") return job.nextRunAt;
  return undefined;
}
