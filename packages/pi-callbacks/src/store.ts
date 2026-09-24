import fs from "node:fs";
import path from "node:path";
import { callbacksDir, storeFile } from "./paths.ts";
import { withStoreLock } from "./store-lock.ts";
import { effectiveEventOrigin, effectiveEventTarget, effectiveJobOrigin, effectiveJobTarget, selectTargetPresence, sessionMatchesRef } from "./targets.ts";
import type { CallbackJob, DeliveryEvent, DeliveryEventKind, PersistedStoreData, ReapedJob, ReapedJobReason, ScriptJob, SessionPresence, SessionRef, StoreData } from "./types.ts";
import { newId } from "./utils.ts";

const EMPTY: StoreData = { version: 2, jobs: [], deliveryEvents: [], sessions: [], reapedJobs: [] };
const DAY_MS = 24 * 60 * 60 * 1_000;

export const TERMINAL_JOB_RETENTION_MS = 7 * DAY_MS;
export const REAPED_JOB_RETENTION_MS = 7 * DAY_MS;
export const DELIVERED_EVENT_RETENTION_MS = DAY_MS;
export const MAX_TERMINAL_JOBS = 100;
export const MAX_REAPED_JOBS = 100;
export const MAX_DELIVERED_EVENTS = 100;
export const SESSION_CRASH_GRACE_MS = 2 * 60 * 1_000;
export const DELIVERY_CLAIM_MS = 30_000;

export interface StoreCleanupOptions {
  now?: number;
  terminalJobRetentionMs?: number;
  reapedJobRetentionMs?: number;
  deliveredEventRetentionMs?: number;
  maxTerminalJobs?: number;
  maxReapedJobs?: number;
  maxDeliveredEvents?: number;
}

export interface StoreCleanupResult {
  jobsRemoved: number;
  deliveryEventsRemoved: number;
}

export interface ZombieCleanupOptions {
  now?: number;
  graceMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface DeliveryEventMetadata {
  at?: number;
  generatedAt?: number;
  backlogStartedAt?: number;
  droppedResults?: number;
}

export interface DeliveryEventInput extends DeliveryEventMetadata {
  kind: DeliveryEventKind;
  body: string;
  details?: unknown;
  triggerTurn?: boolean;
}

export interface JobTransition {
  job: CallbackJob;
  delivery?: DeliveryEventInput;
}

export interface LoadStoreOptions {
  now?: number;
}

export function ensureCallbacksDir(): void {
  fs.mkdirSync(callbacksDir(), { recursive: true, mode: 0o700 });
}

export function loadStore(options: LoadStoreOptions = {}): StoreData {
  ensureCallbacksDir();
  const file = storeFile();
  if (!fs.existsSync(file)) return freshStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedStoreData>;
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.jobs)) return freshStore();
    const deliveryEvents = Array.isArray(parsed.deliveryEvents) ? parsed.deliveryEvents : [];
    const latestDeliveryAt = new Map<string, number>();
    for (const event of deliveryEvents) {
      if (!event || typeof event !== "object" || typeof event.jobId !== "string" || !Number.isFinite(event.at)) continue;
      const previous = latestDeliveryAt.get(event.jobId);
      if (previous === undefined || event.at > previous) latestDeliveryAt.set(event.jobId, event.at);
    }
    const jobs = parsed.jobs.map((job) => {
      if (Number.isFinite(job.lastDeliveryAt)) return job;
      const lastDelivery = latestDeliveryAt.get(job.id);
      return lastDelivery === undefined ? job : { ...job, lastDeliveryAt: lastDelivery };
    });
    const persistedBaseline = (parsed as { checkInBaselineAt?: unknown }).checkInBaselineAt;
    const checkInBaselineAt = Number.isFinite(persistedBaseline)
      ? persistedBaseline as number
      : options.now ?? Date.now();
    const data: StoreData = {
      version: 2,
      jobs,
      deliveryEvents,
      sessions: parsed.version === 2 && Array.isArray(parsed.sessions) ? parsed.sessions : [],
      reapedJobs: parsed.version === 2 && Array.isArray((parsed as { reapedJobs?: unknown }).reapedJobs)
        ? (parsed as { reapedJobs: ReapedJob[] }).reapedJobs
        : [],
      checkInBaselineAt,
    };
    if (!Number.isFinite(persistedBaseline)) saveStoreUnlocked(data);
    return data;
  } catch {
    return freshStore();
  }
}

function saveStoreUnlocked(data: StoreData, maxDeliveredEvents = MAX_DELIVERED_EVENTS): void {
  ensureCallbacksDir();
  const checkInBaselineAt = Number.isFinite(data.checkInBaselineAt)
    ? data.checkInBaselineAt
    : data.jobs.length > 0
      ? Math.min(...data.jobs.map((job) => job.createdAt))
      : undefined;
  const normalized: StoreData = {
    version: 2,
    jobs: data.jobs,
    deliveryEvents: boundDeliveredEvents(data.deliveryEvents ?? [], maxDeliveredEvents),
    sessions: data.sessions,
    reapedJobs: boundReapedJobs(data.reapedJobs ?? [], MAX_REAPED_JOBS),
    ...(typeof checkInBaselineAt === "number" && Number.isFinite(checkInBaselineAt) ? { checkInBaselineAt } : {}),
  };
  const file = storeFile();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function cleanupStore(options: StoreCleanupOptions = {}): StoreCleanupResult {
  return withStoreLock(() => cleanupStoreUnlocked(options));
}

function cleanupStoreUnlocked(options: StoreCleanupOptions): StoreCleanupResult {
  const data = loadStore();
  const now = options.now ?? Date.now();
  const terminalJobRetentionMs = options.terminalJobRetentionMs ?? TERMINAL_JOB_RETENTION_MS;
  const reapedJobRetentionMs = options.reapedJobRetentionMs ?? REAPED_JOB_RETENTION_MS;
  const deliveredEventRetentionMs = options.deliveredEventRetentionMs ?? DELIVERED_EVENT_RETENTION_MS;
  const maxTerminalJobs = options.maxTerminalJobs ?? MAX_TERMINAL_JOBS;
  const maxReapedJobs = options.maxReapedJobs ?? MAX_REAPED_JOBS;
  const maxDeliveredEvents = options.maxDeliveredEvents ?? MAX_DELIVERED_EVENTS;

  const pendingDeliveryJobIds = new Set(
    data.deliveryEvents
      .filter((event) => !hasDeliveryTimestamp(event))
      .map((event) => event.jobId),
  );
  const retainedTerminalJobIds = new Set(
    data.jobs
      .filter((job) => !isActiveJob(job) && !pendingDeliveryJobIds.has(job.id))
      .filter((job) => now - jobTimestamp(job, now) < terminalJobRetentionMs)
      .sort((left, right) => jobTimestamp(right, now) - jobTimestamp(left, now))
      .slice(0, maxTerminalJobs)
      .map((job) => job.id),
  );
  const jobs = data.jobs.filter((job) => (
    isActiveJob(job)
    || pendingDeliveryJobIds.has(job.id)
    || retainedTerminalJobIds.has(job.id)
  ));

  const reapedJobs = data.reapedJobs
    .filter((record) => now - record.reapedAt < reapedJobRetentionMs)
    .sort((left, right) => right.reapedAt - left.reapedAt)
    .slice(0, maxReapedJobs);

  const retainedDeliveredEventIds = new Set(
    data.deliveryEvents
      .filter(hasDeliveryTimestamp)
      .filter((event) => now - event.deliveredAt < deliveredEventRetentionMs)
      .sort((left, right) => right.deliveredAt - left.deliveredAt)
      .slice(0, maxDeliveredEvents)
      .map((event) => event.id),
  );
  const deliveryEvents = data.deliveryEvents.filter((event) => (
    !hasDeliveryTimestamp(event) || retainedDeliveredEventIds.has(event.id)
  ));

  const result: StoreCleanupResult = {
    jobsRemoved: data.jobs.length - jobs.length,
    deliveryEventsRemoved: data.deliveryEvents.length - deliveryEvents.length,
  };
  const reapedJobsChanged = reapedJobs.length !== data.reapedJobs.length;
  if (result.jobsRemoved > 0 || result.deliveryEventsRemoved > 0 || reapedJobsChanged) {
    saveStoreUnlocked({ ...data, jobs, deliveryEvents, reapedJobs }, maxDeliveredEvents);
  }
  return result;
}

export function listJobs(): CallbackJob[] {
  return loadStore().jobs;
}

export function listReapedJobs(): ReapedJob[] {
  return loadStore().reapedJobs;
}

export function listReapedJobsOwnedBy(session: SessionRef): ReapedJob[] {
  return loadStore().reapedJobs.filter((record) => (
    Boolean(record.origin && sessionMatchesRef(session, record.origin))
  ));
}

export function getJob(idOrToken: string): CallbackJob | undefined {
  return listJobs().find((job) => job.id === idOrToken || job.token === idOrToken);
}

export function upsertJob(job: CallbackJob): CallbackJob {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.jobs.findIndex((existing) => existing.id === job.id);
    const next = { ...job, updatedAt: Date.now() } as CallbackJob;
    if (index >= 0) data.jobs[index] = next;
    else data.jobs.push(next);
    saveStoreUnlocked(data);
    return next;
  });
}

export function updateJob(id: string, mutate: (job: CallbackJob) => CallbackJob): CallbackJob | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.jobs.findIndex((existing) => existing.id === id || existing.token === id);
    if (index < 0) return undefined;
    const next = { ...mutate(data.jobs[index]!), updatedAt: Date.now() } as CallbackJob;
    data.jobs[index] = next;
    saveStoreUnlocked(data);
    return next;
  });
}

/**
 * Transition a persisted job and append its resulting delivery event under one
 * store lock. Returning undefined from mutate aborts the transition. This keeps
 * graceful session cleanup/delete from interleaving between terminal state and
 * event creation.
 */
export function updateJobWithDelivery(
  id: string,
  mutate: (job: CallbackJob, store: StoreData) => JobTransition | undefined,
): CallbackJob | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.jobs.findIndex((existing) => existing.id === id || existing.token === id);
    if (index < 0) return undefined;
    const transition = mutate(data.jobs[index]!, data);
    if (!transition) return undefined;
    const deliveryAt = transition.delivery ? (transition.delivery.at ?? Date.now()) : undefined;
    const next = {
      ...transition.job,
      updatedAt: Date.now(),
      ...(deliveryAt === undefined ? {} : { lastDeliveryAt: deliveryAt }),
    } as CallbackJob;
    data.jobs[index] = next;
    if (transition.delivery) {
      appendDeliveryEventUnlocked(
        data,
        next,
        transition.delivery.kind,
        transition.delivery.body,
        transition.delivery.details,
        transition.delivery.triggerTurn,
        deliveryAt,
        transition.delivery,
      );
    }
    saveStoreUnlocked(data);
    return next;
  });
}

/**
 * Atomically commits launch ownership before the daemon spawns a script. If
 * close/delete wins the store lock first, this returns undefined and no process
 * is started; if this wins, the launch is committed as running.
 */
export function claimPendingScriptJobForLaunch(id: string): ScriptJob | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.jobs.findIndex((job) => job.id === id);
    const current = index >= 0 ? data.jobs[index] : undefined;
    if (!current || current.kind !== "script" || current.status !== "pending") return undefined;
    const now = Date.now();
    const next: ScriptJob = { ...current, status: "running", startedAt: current.startedAt ?? now, updatedAt: now };
    data.jobs[index] = next;
    saveStoreUnlocked(data);
    return next;
  });
}

export function removeJob(id: string): CallbackJob | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.jobs.findIndex((job) => job.id === id || job.token === id);
    if (index < 0) return undefined;
    const [removed] = data.jobs.splice(index, 1);
    data.deliveryEvents = data.deliveryEvents.filter((event) => event.jobId !== removed!.id);
    saveStoreUnlocked(data);
    return removed;
  });
}

export function appendJobEvent(id: string, kind: CallbackJob["events"][number]["kind"], message: string, details?: unknown): CallbackJob | undefined {
  return updateJob(id, (job) => ({
    ...job,
    events: [...job.events, { at: Date.now(), kind, message, details }].slice(-50),
  } as CallbackJob));
}

export function appendDeliveryEvent(
  job: CallbackJob,
  kind: DeliveryEventKind,
  body: string,
  details?: unknown,
  triggerTurn?: boolean,
  metadata: DeliveryEventMetadata = {},
): DeliveryEvent {
  return withStoreLock(() => {
    const data = loadStore();
    const event = appendDeliveryEventUnlocked(data, job, kind, body, details, triggerTurn, metadata.at ?? Date.now(), metadata);
    const index = data.jobs.findIndex((candidate) => candidate.id === event.jobId);
    if (index >= 0) data.jobs[index] = { ...data.jobs[index], lastDeliveryAt: event.at, updatedAt: event.at } as CallbackJob;
    saveStoreUnlocked(data);
    return event;
  });
}

function appendDeliveryEventUnlocked(
  data: StoreData,
  job: CallbackJob,
  kind: DeliveryEventKind,
  body: string,
  details: unknown,
  triggerTurn?: boolean,
  at = Date.now(),
  metadata: DeliveryEventMetadata = {},
): DeliveryEvent {
  const freshJob = data.jobs.find((candidate) => candidate.id === job.id);
  const snapshot = freshJob ?? job;
  const origin = effectiveJobOrigin(snapshot);
  const target = effectiveJobTarget(snapshot);
  const coalescing = (kind === "poll" || kind === "failed") && snapshot.kind === "poll" && snapshot.coalesce === true;
  let backlogStartedAt = metadata.backlogStartedAt;
  let droppedResults = metadata.droppedResults;
  if (coalescing) {
    const removed = data.deliveryEvents.filter((event) => (
      event.jobId === snapshot.id
      && isPendingUnclaimedPollResult(event)
    ));
    if (removed.length > 0) {
      data.deliveryEvents = data.deliveryEvents.filter((event) => !(
        event.jobId === snapshot.id
        && isPendingUnclaimedPollResult(event)
      ));
      backlogStartedAt = Math.min(
        at,
        metadata.backlogStartedAt ?? at,
        ...removed.map((event) => event.backlogStartedAt ?? event.at),
      );
      droppedResults = (metadata.droppedResults ?? 0) + removed.reduce(
        (count, event) => count + 1 + (event.droppedResults ?? 0),
        0,
      );
    } else {
      backlogStartedAt ??= at;
    }
  }
  const event: DeliveryEvent = {
    id: newId("evt"),
    jobId: snapshot.id,
    ...(target.kind === "origin" && origin?.sessionFile !== undefined ? { sessionFile: origin.sessionFile } : {}),
    ...(origin === undefined ? {} : { origin }),
    target,
    at,
    kind,
    body,
    ...(details === undefined ? {} : { details }),
    ...(triggerTurn === undefined ? {} : { triggerTurn }),
    ...(metadata.generatedAt === undefined ? {} : { generatedAt: metadata.generatedAt }),
    ...(backlogStartedAt === undefined ? {} : { backlogStartedAt }),
    ...(droppedResults === undefined || droppedResults <= 0 ? {} : { droppedResults }),
    jobSnapshot: snapshot,
  };
  data.deliveryEvents.push(event);
  return event;
}

function isPendingUnclaimedPollResult(event: DeliveryEvent): boolean {
  return isPollResultEvent(event)
    && event.jobSnapshot.kind === "poll"
    && !hasDeliveryTimestamp(event)
    && event.claimedBy === undefined;
}

export function listPendingDeliveryEvents(sessionFile?: string): DeliveryEvent[] {
  return loadStore().deliveryEvents.filter((event) => {
    if (hasDeliveryTimestamp(event)) return false;
    return sessionFile === undefined || event.sessionFile === sessionFile;
  });
}

export function listPendingDeliveryEventsOwnedBy(session: SessionRef): DeliveryEvent[] {
  return loadStore().deliveryEvents.filter((event) => (
    !hasDeliveryTimestamp(event)
    && Boolean(effectiveEventOrigin(event) && sessionMatchesRef(session, effectiveEventOrigin(event)!))
  ));
}

export function claimPendingDeliveryEvents(
  session: SessionPresence,
  options: { now?: number; leaseMs?: number; limit?: number; consumerIdle?: boolean } = {},
): DeliveryEvent[] {
  // The delivery loop polls frequently in every Pi runtime. Avoid contending
  // for the cross-process writer lock when a read snapshot proves this runtime
  // has nothing claimable. The locked path rechecks everything, so a race only
  // defers a newly appended event until the next poll.
  const snapshot = loadStore();
  const snapshotNow = options.now ?? Date.now();
  const liveSnapshotSessions = snapshot.sessions.filter(
    (candidate) => snapshotNow - candidate.lastSeenAt < SESSION_CRASH_GRACE_MS,
  );
  const hasClaimableEvent = snapshot.deliveryEvents.some((event) => {
    if (hasDeliveryTimestamp(event) || effectiveEventTarget(event).kind === "desktop") return false;
    if (event.claimedBy && (event.claimExpiresAt ?? 0) > snapshotNow) return false;
    if (options.consumerIdle === false && isCoalescingConversationDelivery(event)) return false;
    return selectTargetPresence(event, liveSnapshotSessions)?.runtimeId === session.runtimeId;
  });
  if (!hasClaimableEvent) return [];

  return withStoreLock(() => {
    const data = loadStore();
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? DELIVERY_CLAIM_MS;
    const liveSessions = data.sessions.filter((candidate) => now - candidate.lastSeenAt < SESSION_CRASH_GRACE_MS);
    const claimed: DeliveryEvent[] = [];
    for (let index = 0; index < data.deliveryEvents.length; index++) {
      if (claimed.length >= (options.limit ?? 100)) break;
      const event = data.deliveryEvents[index]!;
      if (hasDeliveryTimestamp(event) || effectiveEventTarget(event).kind === "desktop") continue;
      if (event.claimedBy && (event.claimExpiresAt ?? 0) > now) continue;
      if (options.consumerIdle === false && isCoalescingConversationDelivery(event)) continue;
      const selected = selectTargetPresence(event, liveSessions);
      if (selected?.runtimeId !== session.runtimeId) continue;
      const next = { ...event, claimedBy: session.runtimeId, claimExpiresAt: now + leaseMs };
      data.deliveryEvents[index] = next;
      claimed.push(next);
    }
    if (claimed.length > 0) saveStoreUnlocked(data);
    return claimed;
  });
}

export function claimPendingDesktopDeliveryEvents(
  claimant: string,
  options: { now?: number; leaseMs?: number; limit?: number } = {},
): DeliveryEvent[] {
  return withStoreLock(() => {
    const data = loadStore();
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? DELIVERY_CLAIM_MS;
    const claimed: DeliveryEvent[] = [];
    for (let index = 0; index < data.deliveryEvents.length; index++) {
      if (claimed.length >= (options.limit ?? 100)) break;
      const event = data.deliveryEvents[index]!;
      if (hasDeliveryTimestamp(event) || effectiveEventTarget(event).kind !== "desktop") continue;
      if (event.claimedBy && (event.claimExpiresAt ?? 0) > now) continue;
      const next = { ...event, claimedBy: claimant, claimExpiresAt: now + leaseMs };
      data.deliveryEvents[index] = next;
      claimed.push(next);
    }
    if (claimed.length > 0) saveStoreUnlocked(data);
    return claimed;
  });
}

export function markDeliveryEventDelivered(id: string, claimedBy?: string, now?: number): DeliveryEvent | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.deliveryEvents.findIndex((event) => event.id === id);
    if (index < 0) return undefined;
    const current = data.deliveryEvents[index]!;
    if (claimedBy && current.claimedBy !== claimedBy) return undefined;
    const { claimedBy: _claimedBy, claimExpiresAt: _claimExpiresAt, ...rest } = current;
    const event: DeliveryEvent = { ...rest, deliveredAt: now ?? Date.now() };
    data.deliveryEvents[index] = event;
    saveStoreUnlocked(data);
    return event;
  });
}

export function releaseDeliveryEventClaim(id: string, claimedBy: string): DeliveryEvent | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.deliveryEvents.findIndex((event) => event.id === id);
    if (index < 0 || data.deliveryEvents[index]!.claimedBy !== claimedBy) return undefined;
    const { claimedBy: _claimedBy, claimExpiresAt: _claimExpiresAt, ...rest } = data.deliveryEvents[index]!;
    const event: DeliveryEvent = rest;
    data.deliveryEvents[index] = event;
    saveStoreUnlocked(data);
    return event;
  });
}

export function renewDeliveryEventClaim(
  id: string,
  claimedBy: string,
  options: { now?: number; leaseMs?: number } = {},
): DeliveryEvent | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.deliveryEvents.findIndex((event) => event.id === id);
    if (index < 0) return undefined;
    const current = data.deliveryEvents[index]!;
    if (hasDeliveryTimestamp(current) || current.claimedBy !== claimedBy) return undefined;
    const event = {
      ...current,
      claimExpiresAt: (options.now ?? Date.now()) + (options.leaseMs ?? DELIVERY_CLAIM_MS),
    };
    data.deliveryEvents[index] = event;
    saveStoreUnlocked(data);
    return event;
  });
}

export function registerSessionPresence(presence: SessionPresence): SessionPresence {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.sessions.findIndex((session) => session.runtimeId === presence.runtimeId);
    if (index >= 0) data.sessions[index] = presence;
    else data.sessions.push(presence);
    clearOrphanMarkers(data, presence);
    saveStoreUnlocked(data);
    return presence;
  });
}

export function touchSessionPresence(runtimeId: string, options: { now?: number; active?: boolean } = {}): SessionPresence | undefined {
  return withStoreLock(() => {
    const data = loadStore();
    const index = data.sessions.findIndex((session) => session.runtimeId === runtimeId);
    if (index < 0) return undefined;
    const now = options.now ?? Date.now();
    const current = data.sessions[index]!;
    const { staleSince: _staleSince, ...healthy } = current;
    const next = { ...healthy, lastSeenAt: now, lastActiveAt: options.active ? now : current.lastActiveAt };
    data.sessions[index] = next;
    clearOrphanMarkers(data, next);
    saveStoreUnlocked(data);
    return next;
  });
}

export function closeSessionPresence(runtimeId: string, cleanupOriginJobs: boolean): StoreCleanupResult {
  return withStoreLock(() => {
    const data = loadStore();
    const presence = data.sessions.find((session) => session.runtimeId === runtimeId);
    if (!presence) return { jobsRemoved: 0, deliveryEventsRemoved: 0 };
    data.sessions = data.sessions.filter((session) => session.runtimeId !== runtimeId);
    let result = { jobsRemoved: 0, deliveryEventsRemoved: 0 };
    if (cleanupOriginJobs && !data.sessions.some((session) => sessionMatchesRef(session, presence))) {
      result = removeOriginWorkForSession(data, presence, "session-ended");
    }
    saveStoreUnlocked(data);
    return result;
  });
}

export function cleanupZombieSessions(options: ZombieCleanupOptions = {}): StoreCleanupResult {
  return withStoreLock(() => {
    const data = loadStore();
    const now = options.now ?? Date.now();
    const graceMs = options.graceMs ?? SESSION_CRASH_GRACE_MS;
    const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const originalJobCount = data.jobs.length;
    const originalEventCount = data.deliveryEvents.length;
    let changed = false;

    const removedPresences: SessionPresence[] = [];
    const retainedPresences: SessionPresence[] = [];
    for (const session of data.sessions) {
      const heartbeatExpired = now - session.lastSeenAt >= graceMs;
      if (!heartbeatExpired) {
        if (session.staleSince !== undefined) {
          const { staleSince: _staleSince, ...healthy } = session;
          retainedPresences.push(healthy);
          changed = true;
        } else {
          retainedPresences.push(session);
        }
        continue;
      }
      if (!isProcessAlive(session.pid) || (session.staleSince !== undefined && now - session.staleSince >= graceMs)) {
        removedPresences.push(session);
        changed = true;
        continue;
      }
      if (session.staleSince === undefined) {
        retainedPresences.push({ ...session, staleSince: now });
        changed = true;
      } else {
        retainedPresences.push(session);
      }
    }
    data.sessions = retainedPresences;

    const removedJobIds = new Set<string>();
    const abandonedOriginKeys = new Set<string>();
    for (let index = 0; index < data.jobs.length; index++) {
      const job = data.jobs[index]!;
      if (effectiveJobTarget(job).kind !== "origin") {
        if (job.orphanedAt !== undefined) {
          const { orphanedAt: _orphanedAt, ...rest } = job;
          data.jobs[index] = rest as CallbackJob;
          changed = true;
        }
        continue;
      }
      const origin = effectiveJobOrigin(job);
      if (!origin) continue;
      if (data.sessions.some((session) => sessionMatchesRef(session, origin))) {
        if (job.orphanedAt !== undefined) {
          const { orphanedAt: _orphanedAt, ...rest } = job;
          data.jobs[index] = rest as CallbackJob;
          changed = true;
        }
        continue;
      }
      const removedPresenceSeenAt = removedPresences
        .filter((session) => sessionMatchesRef(session, origin))
        .reduce((latest, session) => Math.max(latest, session.lastSeenAt), 0);
      const orphanedAt = job.orphanedAt ?? (removedPresenceSeenAt || now);
      if (job.orphanedAt === undefined) {
        data.jobs[index] = { ...job, orphanedAt } as CallbackJob;
        changed = true;
      }
      if (now - orphanedAt < graceMs) continue;
      abandonedOriginKeys.add(sessionKey(origin));
      if (isActiveJob(job)) removedJobIds.add(job.id);
    }

    if (removedJobIds.size > 0) {
      const removedJobs = data.jobs.filter((job) => removedJobIds.has(job.id));
      recordReapedJobs(data, removedJobs, "session-crashed", now);
      data.jobs = data.jobs.filter((job) => !removedJobIds.has(job.id));
      changed = true;
    }
    const nextEvents = data.deliveryEvents.filter((event) => {
      if (hasDeliveryTimestamp(event)) return true;
      if (removedJobIds.has(event.jobId)) return false;
      if (effectiveEventTarget(event).kind !== "origin") return true;
      const origin = effectiveEventOrigin(event);
      return !origin || !abandonedOriginKeys.has(sessionKey(origin));
    });
    if (nextEvents.length !== data.deliveryEvents.length) {
      data.deliveryEvents = nextEvents;
      changed = true;
    }

    if (changed) saveStoreUnlocked(data);
    return {
      jobsRemoved: originalJobCount - data.jobs.length,
      deliveryEventsRemoved: originalEventCount - data.deliveryEvents.length,
    };
  });
}

export function jobOwnedBySession(job: CallbackJob, session: SessionRef): boolean {
  const origin = effectiveJobOrigin(job);
  return Boolean(origin && sessionMatchesRef(session, origin));
}

export function projectRelative(file: string): string {
  return path.relative(process.cwd(), file) || ".";
}

function freshStore(): StoreData {
  return { ...EMPTY, jobs: [], deliveryEvents: [], sessions: [] };
}

function clearOrphanMarkers(data: StoreData, presence: SessionRef): void {
  data.jobs = data.jobs.map((job) => {
    const origin = effectiveJobOrigin(job);
    if (job.orphanedAt === undefined || !origin || !sessionMatchesRef(presence, origin)) return job;
    const { orphanedAt: _orphanedAt, ...rest } = job;
    return rest as CallbackJob;
  });
}

function removeOriginWorkForSession(data: StoreData, session: SessionRef, reason: ReapedJobReason): StoreCleanupResult {
  const removedJobs = data.jobs.filter(
    (job) => isActiveJob(job) && effectiveJobTarget(job).kind === "origin" && jobOwnedBySession(job, session),
  );
  const removedJobIds = new Set(removedJobs.map((job) => job.id));
  recordReapedJobs(data, removedJobs, reason, Date.now());
  const originalJobCount = data.jobs.length;
  const originalEventCount = data.deliveryEvents.length;
  data.jobs = data.jobs.filter((job) => !removedJobIds.has(job.id));
  data.deliveryEvents = data.deliveryEvents.filter((event) => {
    if (hasDeliveryTimestamp(event)) return true;
    if (removedJobIds.has(event.jobId)) return false;
    if (effectiveEventTarget(event).kind !== "origin") return true;
    const origin = effectiveEventOrigin(event);
    return !origin || !sessionMatchesRef(session, origin);
  });
  return {
    jobsRemoved: originalJobCount - data.jobs.length,
    deliveryEventsRemoved: originalEventCount - data.deliveryEvents.length,
  };
}

function recordReapedJobs(data: StoreData, jobs: CallbackJob[], reason: ReapedJobReason, reapedAt: number): void {
  data.reapedJobs.push(...jobs.map((job): ReapedJob => {
    const origin = effectiveJobOrigin(job);
    return {
      id: job.id,
      kind: job.kind,
      ...(job.label === undefined ? {} : { label: job.label }),
      message: job.message,
      ...(origin === undefined ? {} : { origin }),
      reapedAt,
      reason,
    };
  }));
}

export function isActiveJob(job: CallbackJob): boolean {
  return job.status === "pending" || job.status === "running";
}

function jobTimestamp(job: CallbackJob, fallback: number): number {
  if (Number.isFinite(job.updatedAt)) return job.updatedAt;
  if (Number.isFinite(job.createdAt)) return job.createdAt;
  return fallback;
}

function isPollResultEvent(event: DeliveryEvent): boolean {
  return (event.kind === "poll" || event.kind === "failed") && event.jobSnapshot.kind === "poll";
}

function isCoalescingConversationDelivery(event: DeliveryEvent): boolean {
  return isPollResultEvent(event)
    && event.jobSnapshot.kind === "poll"
    && event.jobSnapshot.coalesce === true
    && effectiveEventTarget(event).kind !== "desktop"
    && event.jobSnapshot.delivery !== "notify-only";
}

function hasDeliveryTimestamp(event: DeliveryEvent): event is DeliveryEvent & { deliveredAt: number } {
  return typeof event.deliveredAt === "number" && Number.isFinite(event.deliveredAt);
}

function boundReapedJobs(records: ReapedJob[], maxReapedJobs: number): ReapedJob[] {
  return records
    .slice()
    .sort((left, right) => right.reapedAt - left.reapedAt)
    .slice(0, maxReapedJobs);
}

function boundDeliveredEvents(events: DeliveryEvent[], maxDeliveredEvents: number): DeliveryEvent[] {
  const retainedDeliveredIds = new Set(
    events
      .filter(hasDeliveryTimestamp)
      .sort((left, right) => right.deliveredAt - left.deliveredAt)
      .slice(0, maxDeliveredEvents)
      .map((event) => event.id),
  );
  return events.filter((event) => !hasDeliveryTimestamp(event) || retainedDeliveredIds.has(event.id));
}

function sessionKey(session: SessionRef): string {
  return session.sessionFile ? `file:${session.sessionFile}` : `id:${session.sessionId}`;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
