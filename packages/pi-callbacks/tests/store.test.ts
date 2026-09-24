import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendDeliveryEvent,
  claimPendingScriptJobForLaunch,
  claimPendingDeliveryEvents,
  cleanupZombieSessions,
  cleanupStore,
  closeSessionPresence,
  getJob,
  listJobs,
  listPendingDeliveryEvents,
  listReapedJobs,
  loadStore,
  markDeliveryEventDelivered,
  registerSessionPresence,
  touchSessionPresence,
  updateJob,
  updateJobWithDelivery,
  upsertJob,
} from "../src/store.ts";
import type { DeliveryEvent, PollJob, ReapedJob, ReminderJob, ScriptJob, SessionPresence } from "../src/types.ts";

function useTempCallbacksDir(t: test.TestContext): string {
  const previous = process.env.PI_CALLBACKS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-store-test-"));
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function reminderJob(overrides: Partial<ReminderJob> = {}): ReminderJob {
  const now = Date.now();
  return {
    id: "rem_test",
    kind: "reminder",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sessionFile: "/tmp/session.json",
    cwd: process.cwd(),
    message: "check the oven",
    delivery: "custom",
    triggerTurn: true,
    dueAt: now + 1_000,
    events: [{ at: now, kind: "created", message: "created" }],
    ...overrides,
  };
}

test("store persists jobs and filters delivery events in isolated callback state", (t) => {
  const dir = useTempCallbacksDir(t);
  const job = reminderJob();

  assert.deepEqual(listJobs(), []);
  upsertJob(job);

  assert.equal(getJob(job.id)?.message, "check the oven");
  assert.equal(listJobs().length, 1);
  const storePath = path.join(dir, "jobs.json");
  assert.ok(fs.existsSync(storePath));
  assert.equal(fs.readFileSync(storePath, "utf8").trimEnd().split("\n").length, 1);

  const matching = appendDeliveryEvent(job, "reminder", "wake up");
  appendDeliveryEvent({ ...job, id: "other", sessionFile: "/tmp/other-session.json" }, "reminder", "not yours");

  assert.deepEqual(listPendingDeliveryEvents("/tmp/session.json").map((event) => event.id), [matching.id]);
  assert.equal(listPendingDeliveryEvents().length, 2);

  markDeliveryEventDelivered(matching.id);
  assert.deepEqual(listPendingDeliveryEvents("/tmp/session.json"), []);
});

test("cleanupStore bounds terminal history while preserving active jobs and pending deliveries", (t) => {
  const dir = useTempCallbacksDir(t);
  const now = 10_000;
  const old = now - 2_000;
  const recent = now - 100;
  const active = reminderJob({ id: "active", status: "pending", createdAt: old, updatedAt: old });
  const running = reminderJob({ id: "running", status: "running", createdAt: old, updatedAt: old });
  const oldTerminal = reminderJob({ id: "old-terminal", status: "completed", createdAt: old, updatedAt: old });
  const boundaryTerminal = reminderJob({ id: "boundary-terminal", status: "completed", createdAt: now - 1_000, updatedAt: now - 1_000 });
  const protectedTerminal = reminderJob({ id: "protected-terminal", status: "failed", createdAt: old, updatedAt: old });
  const recentTerminal = reminderJob({ id: "recent-terminal", status: "cancelled", createdAt: recent, updatedAt: recent });
  const deliveredOld = deliveryEvent("delivered-old", oldTerminal, old, old);
  const deliveredBoundary = deliveryEvent("delivered-boundary", boundaryTerminal, now - 1_000, now - 1_000);
  const deliveredRecent = deliveryEvent("delivered-recent", recentTerminal, recent, recent);
  const pendingOld = deliveryEvent("pending-old", protectedTerminal, old);
  writeStoreFixture(dir, {
    version: 1,
    jobs: [active, running, oldTerminal, boundaryTerminal, protectedTerminal, recentTerminal],
    deliveryEvents: [deliveredOld, deliveredBoundary, deliveredRecent, pendingOld],
  });

  const result = cleanupStore({
    now,
    terminalJobRetentionMs: 1_000,
    deliveredEventRetentionMs: 1_000,
    maxTerminalJobs: 10,
    maxDeliveredEvents: 10,
  });

  assert.deepEqual(result, { jobsRemoved: 2, deliveryEventsRemoved: 2 });
  assert.deepEqual(loadStore().jobs.map((job) => job.id), ["active", "running", "protected-terminal", "recent-terminal"]);
  assert.deepEqual(loadStore().deliveryEvents.map((event) => event.id), ["delivered-recent", "pending-old"]);
});

test("cleanupStore keeps only the newest bounded terminal jobs and delivered events", (t) => {
  const dir = useTempCallbacksDir(t);
  const jobs = [1, 2, 3].map((updatedAt) => reminderJob({
    id: `terminal-${updatedAt}`,
    status: "completed",
    createdAt: updatedAt,
    updatedAt,
  }));
  const deliveryEvents = jobs.map((job, index) => deliveryEvent(`event-${index + 1}`, job, index + 1, index + 1));
  writeStoreFixture(dir, { version: 1, jobs, deliveryEvents });

  cleanupStore({
    now: 10,
    terminalJobRetentionMs: 10,
    deliveredEventRetentionMs: 10,
    maxTerminalJobs: 2,
    maxDeliveredEvents: 2,
  });

  assert.deepEqual(loadStore().jobs.map((job) => job.id), ["terminal-2", "terminal-3"]);
  assert.deepEqual(loadStore().deliveryEvents.map((event) => event.id), ["event-2", "event-3"]);
});

test("cleanupStore applies its requested delivery limit when another removal forces a save", (t) => {
  const dir = useTempCallbacksDir(t);
  const oldTerminal = reminderJob({ id: "old-terminal", status: "completed", createdAt: 0, updatedAt: 0 });
  const deliveryEvents = Array.from({ length: 150 }, (_, index) => (
    deliveryEvent(`delivered-${index}`, oldTerminal, index + 1, index + 1)
  ));
  writeStoreFixture(dir, { version: 1, jobs: [oldTerminal], deliveryEvents });

  const result = cleanupStore({
    now: 200,
    terminalJobRetentionMs: 0,
    deliveredEventRetentionMs: 1_000,
    maxTerminalJobs: 0,
    maxDeliveredEvents: 200,
  });

  assert.deepEqual(result, { jobsRemoved: 1, deliveryEventsRemoved: 0 });
  assert.equal(loadStore().deliveryEvents.length, 150);
});

test("cleanupStore ages out and bounds discarded-job notices", (t) => {
  const dir = useTempCallbacksDir(t);
  const records: ReapedJob[] = [
    { id: "old-reaped", kind: "reminder", message: "old", reapedAt: 1_000, reason: "session-ended" },
    { id: "recent-reaped", kind: "poll", label: "watch deploy", message: "deploy", reapedAt: 9_500, reason: "session-crashed" },
    { id: "newest-reaped", kind: "callback", message: "newest", reapedAt: 9_900, reason: "session-ended" },
  ];
  writeStoreFixture(dir, { version: 2, jobs: [], deliveryEvents: [], sessions: [], reapedJobs: records });

  cleanupStore({ now: 10_000, reapedJobRetentionMs: 1_000, maxReapedJobs: 1 });

  assert.deepEqual(listReapedJobs().map((record) => record.id), ["newest-reaped"]);
});

test("cleanupStore retains reaped records individually when job ids are duplicated", (t) => {
  const dir = useTempCallbacksDir(t);
  const records: ReapedJob[] = [
    { id: "same-id", kind: "reminder", message: "expired", reapedAt: 1_000, reason: "session-ended" },
    { id: "same-id", kind: "reminder", message: "recent", reapedAt: 9_500, reason: "session-ended" },
    { id: "same-id", kind: "reminder", message: "newest", reapedAt: 9_900, reason: "session-crashed" },
  ];
  writeStoreFixture(dir, { version: 2, jobs: [], deliveryEvents: [], sessions: [], reapedJobs: records });

  cleanupStore({ now: 10_000, reapedJobRetentionMs: 1_000, maxReapedJobs: 1 });

  assert.deepEqual(listReapedJobs().map(({ id, message, reapedAt }) => ({ id, message, reapedAt })), [{
    id: "same-id",
    message: "newest",
    reapedAt: 9_900,
  }]);
});

test("appending delivery events never evicts undelivered callbacks", (t) => {
  const dir = useTempCallbacksDir(t);
  const terminal = reminderJob({ id: "terminal-with-pending-deliveries", status: "completed" });
  const pendingEvents = Array.from({ length: 500 }, (_, index) => (
    deliveryEvent(`pending-${index}`, terminal, index)
  ));
  writeStoreFixture(dir, { version: 1, jobs: [terminal], deliveryEvents: pendingEvents });

  appendDeliveryEvent(terminal, "reminder", "new pending delivery");
  cleanupStore({ now: Date.now(), terminalJobRetentionMs: 0, maxTerminalJobs: 0 });

  assert.equal(loadStore().deliveryEvents.length, 501);
  assert.equal(listPendingDeliveryEvents().length, 501);
  assert.equal(getJob(terminal.id)?.id, terminal.id);
});

test("empty delivery claims avoid creating or acquiring the write lock", (t) => {
  const dir = useTempCallbacksDir(t);
  const presence = sessionPresence({ runtimeId: "empty-claim-runtime" });

  assert.deepEqual(claimPendingDeliveryEvents(presence), []);
  assert.equal(
    fs.existsSync(path.join(dir, "jobs.json.lock.sqlite")),
    false,
    "an empty read-side poll must not create the SQLite writer lock",
  );
});

test("store mutations reload after acquiring the cross-process lock", async (t) => {
  const dir = useTempCallbacksDir(t);
  const storePath = path.join(dir, "jobs.json");
  const lockPath = `${storePath}.lock.sqlite`;
  const readyPath = path.join(dir, "child-ready");
  const childJob = reminderJob({ id: "child-job" });
  writeStoreFixture(dir, { version: 1, jobs: [], deliveryEvents: [] });

  const childSource = `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const storePath = ${JSON.stringify(storePath)};
const lockPath = ${JSON.stringify(lockPath)};
const readyPath = ${JSON.stringify(readyPath)};
const job = ${JSON.stringify(childJob)};
const lock = new DatabaseSync(lockPath);
try {
  lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
  const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
  fs.writeFileSync(readyPath, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  data.jobs.push(job);
  const tmp = storePath + ".child.tmp";
  fs.writeFileSync(tmp, JSON.stringify(data) + "\\n", { mode: 0o600 });
  fs.renameSync(tmp, storePath);
  lock.exec("COMMIT");
} finally {
  lock.close();
}
`;
  const child = spawn(process.execPath, ["-e", childSource], { stdio: ["ignore", "ignore", "pipe"] });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
  const childExit = new Promise<number | null>((resolve) => child.on("close", resolve));
  await waitForFile(readyPath);

  upsertJob(reminderJob({ id: "parent-job" }));
  const exitCode = await childExit;

  assert.equal(exitCode, 0, childStderr);
  assert.deepEqual(listJobs().map((job) => job.id).sort(), ["child-job", "parent-job"]);
});

test("store lock is released when its owning process dies or a mutation throws", async (t) => {
  const dir = useTempCallbacksDir(t);
  const lockPath = `${path.join(dir, "jobs.json")}.lock.sqlite`;
  const readyPath = path.join(dir, "dying-child-ready");
  const childSource = `
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const lock = new DatabaseSync(${JSON.stringify(lockPath)});
lock.exec("BEGIN IMMEDIATE");
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
`;
  const child = spawn(process.execPath, ["-e", childSource], { stdio: "ignore" });
  const childExit = new Promise<number | null>((resolve) => child.on("close", resolve));
  await waitForFile(readyPath);
  child.kill("SIGKILL");
  await childExit;

  const first = upsertJob(reminderJob({ id: "after-death" }));
  assert.equal(first.id, "after-death");
  assert.throws(
    () => updateJob(first.id, () => { throw new Error("mutation failed"); }),
    /mutation failed/,
  );
  const second = upsertJob(reminderJob({ id: "after-throw" }));
  assert.equal(second.id, "after-throw");
});

test("version-1 stores migrate in memory without losing legacy jobs", (t) => {
  const dir = useTempCallbacksDir(t);
  const job = reminderJob({ id: "legacy" });
  writeStoreFixture(dir, { version: 1, jobs: [job], deliveryEvents: [] });

  const migrated = loadStore();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.sessions, []);
  assert.deepEqual(migrated.reapedJobs, []);
  assert.equal(migrated.jobs[0]?.id, "legacy");
});

test("delivery claims route origin and latest-active events to exactly one runtime", (t) => {
  useTempCallbacksDir(t);
  const origin = sessionPresence({ runtimeId: "runtime-origin", sessionId: "session-origin", sessionFile: "/tmp/origin.jsonl", lastActiveAt: 10 });
  const latest = sessionPresence({ runtimeId: "runtime-latest", sessionId: "session-latest", sessionFile: "/tmp/latest.jsonl", cwd: "/other", lastActiveAt: 20 });
  registerSessionPresence(origin);
  registerSessionPresence(latest);

  const originJob = upsertJob(reminderJob({
    id: "origin-job",
    ...(origin.sessionFile === undefined ? {} : { sessionFile: origin.sessionFile }),
    cwd: origin.cwd,
    origin: origin,
    target: { kind: "origin" },
  }));
  appendDeliveryEvent(originJob, "reminder", "origin");
  const latestJob = upsertJob(reminderJob({
    id: "latest-job",
    ...(origin.sessionFile === undefined ? {} : { sessionFile: origin.sessionFile }),
    cwd: origin.cwd,
    origin,
    target: { kind: "latest-active" },
  }));
  appendDeliveryEvent(latestJob, "reminder", "latest");

  assert.deepEqual(claimPendingDeliveryEvents(origin, { now: 30 }).map((event) => event.body), ["origin"]);
  assert.deepEqual(claimPendingDeliveryEvents(latest, { now: 30 }).map((event) => event.body), ["latest"]);
  assert.deepEqual(claimPendingDeliveryEvents(origin, { now: 30 }), [], "active leases prevent a second claim");
});

test("graceful close removes only origin-targeted active work", (t) => {
  useTempCallbacksDir(t);
  const session = sessionPresence({});
  registerSessionPresence(session);
  const originJob = upsertJob(reminderJob({ id: "origin-active", label: "origin watch", origin: session, target: { kind: "origin" } }));
  const redirectedJob = upsertJob(reminderJob({ id: "redirected-active", origin: session, target: { kind: "latest-active" } }));
  appendDeliveryEvent(originJob, "reminder", "remove me");
  appendDeliveryEvent(redirectedJob, "reminder", "keep me");

  const result = closeSessionPresence(session.runtimeId, true);

  assert.deepEqual(result, { jobsRemoved: 1, deliveryEventsRemoved: 1 });
  assert.deepEqual(listJobs().map((job) => job.id), ["redirected-active"]);
  assert.deepEqual(listPendingDeliveryEvents().map((event) => event.body), ["keep me"]);
  assert.deepEqual(listReapedJobs().map(({ id, label, message, reason }) => ({ id, label, message, reason })), [{
    id: "origin-active",
    label: "origin watch",
    message: "check the oven",
    reason: "session-ended",
  }]);
});

test("atomic completion and graceful close cannot strand an origin delivery", (t) => {
  useTempCallbacksDir(t);
  const session = sessionPresence({});
  registerSessionPresence(session);
  upsertJob(reminderJob({ id: "close-wins", origin: session, target: { kind: "origin" } }));

  closeSessionPresence(session.runtimeId, true);
  const afterClose = updateJobWithDelivery("close-wins", (job) => ({
    job: { ...job, status: "completed" } as ReminderJob,
    delivery: { kind: "reminder", body: "must not be stranded" },
  }));
  assert.equal(afterClose, undefined);
  assert.deepEqual(listJobs(), []);
  assert.deepEqual(listPendingDeliveryEvents(), []);

  registerSessionPresence(session);
  upsertJob(reminderJob({ id: "completion-wins", origin: session, target: { kind: "origin" } }));
  const completed = updateJobWithDelivery("completion-wins", (job) => ({
    job: { ...job, status: "completed" } as ReminderJob,
    delivery: { kind: "reminder", body: "removed by close" },
  }));
  assert.equal(completed?.status, "completed");
  assert.equal(listPendingDeliveryEvents().length, 1);

  closeSessionPresence(session.runtimeId, true);
  assert.equal(getJob("completion-wins")?.status, "completed", "terminal history is retained");
  assert.deepEqual(listPendingDeliveryEvents(), [], "the atomic event is removed with its closed origin");
});

test("script launch claims serialize with graceful origin cleanup", (t) => {
  useTempCallbacksDir(t);
  const session = sessionPresence({});
  const script = (id: string): ScriptJob => ({
    ...reminderJob({ id, origin: session, target: { kind: "origin" } }),
    kind: "script",
    command: "echo should-be-claimed",
  });

  registerSessionPresence(session);
  upsertJob(script("close-before-claim"));
  closeSessionPresence(session.runtimeId, true);
  assert.equal(claimPendingScriptJobForLaunch("close-before-claim"), undefined);

  registerSessionPresence(session);
  upsertJob(script("claim-before-close"));
  assert.equal(claimPendingScriptJobForLaunch("claim-before-close")?.status, "running");
  closeSessionPresence(session.runtimeId, true);
  assert.equal(getJob("claim-before-close"), undefined);
});

test("reload-style presence close preserves origin jobs for the replacement runtime", (t) => {
  useTempCallbacksDir(t);
  const session = sessionPresence({});
  registerSessionPresence(session);
  upsertJob(reminderJob({ id: "reload-origin", origin: session, target: { kind: "origin" } }));

  assert.deepEqual(closeSessionPresence(session.runtimeId, false), { jobsRemoved: 0, deliveryEventsRemoved: 0 });
  assert.equal(getJob("reload-origin")?.status, "pending");
  assert.deepEqual(listReapedJobs(), [], "reload must not record a discarded-job notice");
});

test("live-PID stale presences expire in two phases and heartbeat recovery clears the marker", (t) => {
  useTempCallbacksDir(t);
  const presence = sessionPresence({ runtimeId: "ended-child", pid: process.pid, lastSeenAt: 1_000 });
  registerSessionPresence(presence);
  upsertJob(reminderJob({
    id: "ended-child-job",
    origin: presence,
    target: { kind: "origin" },
  }));

  cleanupZombieSessions({ now: 121_000, graceMs: 120_000, isProcessAlive: () => true });
  assert.equal(loadStore().sessions[0]?.staleSince, 121_000, "first stale observation only marks the runtime");
  assert.equal(getJob("ended-child-job")?.id, "ended-child-job");

  touchSessionPresence(presence.runtimeId, { now: 130_000 });
  assert.equal(loadStore().sessions[0]?.staleSince, undefined, "a renewed heartbeat rescues a suspended runtime");

  cleanupZombieSessions({ now: 250_000, graceMs: 120_000, isProcessAlive: () => true });
  assert.equal(loadStore().sessions[0]?.staleSince, 250_000);
  cleanupZombieSessions({ now: 369_999, graceMs: 120_000, isProcessAlive: () => true });
  assert.equal(loadStore().sessions.length, 1, "the second grace remains suspension-safe");
  cleanupZombieSessions({ now: 370_000, graceMs: 120_000, isProcessAlive: () => true });
  assert.equal(loadStore().sessions.length, 0, "an ended in-process runtime is pruned although its host PID lives");
  assert.equal(getJob("ended-child-job"), undefined, "origin work follows existing stale-session cleanup semantics");
});

test("crashed sessions receive a two-minute grace before origin jobs are removed", (t) => {
  useTempCallbacksDir(t);
  const session = sessionPresence({ lastSeenAt: 1_000, lastActiveAt: 1_000, pid: 999_999 });
  registerSessionPresence(session);
  upsertJob(reminderJob({ id: "crash-origin", origin: session, target: { kind: "origin" } }));
  upsertJob(reminderJob({ id: "crash-redirected", origin: session, target: { kind: "desktop" } }));

  cleanupZombieSessions({ now: 120_999, graceMs: 120_000, isProcessAlive: () => false });
  assert.deepEqual(listJobs().map((job) => job.id).sort(), ["crash-origin", "crash-redirected"]);

  const result = cleanupZombieSessions({ now: 121_000, graceMs: 120_000, isProcessAlive: () => false });
  assert.deepEqual(result, { jobsRemoved: 1, deliveryEventsRemoved: 0 });
  assert.deepEqual(listJobs().map((job) => job.id), ["crash-redirected"]);
  assert.deepEqual(listReapedJobs().map(({ id, message, reason }) => ({ id, message, reason })), [{
    id: "crash-origin",
    message: "check the oven",
    reason: "session-crashed",
  }]);
});

function pollJob(overrides: Partial<PollJob> = {}): PollJob {
  const now = Date.now();
  return {
    ...reminderJob(),
    id: "poll_test",
    kind: "poll",
    intervalMs: 100,
    nextRunAt: now,
    condition: { type: "always" },
    runCount: 0,
    pushEachResult: true,
    coalesce: false,
    ...overrides,
  } as PollJob;
}

test("poll delivery coalescing retains the newest unclaimed result and persists aggregate drops", (t) => {
  useTempCallbacksDir(t);
  const job = upsertJob(pollJob({ id: "poll-coalesce", coalesce: true }));
  appendDeliveryEvent(job, "poll", "first", undefined, undefined, { at: 100, generatedAt: 90 });
  appendDeliveryEvent(job, "poll", "second", undefined, undefined, { at: 200, generatedAt: 190 });
  const newest = appendDeliveryEvent(job, "poll", "third", undefined, undefined, { at: 300, generatedAt: 290 });

  assert.deepEqual(listPendingDeliveryEvents().map((event) => event.body), ["third"]);
  assert.equal(newest.droppedResults, 2);
  assert.equal(newest.backlogStartedAt, 100);
  assert.equal(loadStore().deliveryEvents[0]?.droppedResults, 2);
  assert.equal(loadStore().jobs[0]?.lastDeliveryAt, 300);
});

test("poll coalescing leaves claimed and delivered history intact while legacy polls stay ordered", (t) => {
  useTempCallbacksDir(t);
  const presence = sessionPresence({ runtimeId: "poll-claim-runtime" });
  registerSessionPresence(presence);
  const coalescing = upsertJob(pollJob({ id: "poll-claimed", coalesce: true }));
  const claimed = appendDeliveryEvent(coalescing, "poll", "claimed", undefined, undefined, { at: 100 });
  assert.equal(claimPendingDeliveryEvents(presence, { now: 100 }).at(0)?.id, claimed.id);
  const delivered = appendDeliveryEvent(coalescing, "poll", "delivered", undefined, undefined, { at: 200 });
  markDeliveryEventDelivered(delivered.id, undefined, 250);
  appendDeliveryEvent(coalescing, "poll", "newest", undefined, undefined, { at: 300 });
  assert.deepEqual(loadStore().deliveryEvents.map((event) => event.body), ["claimed", "delivered", "newest"]);

  const legacy = upsertJob(pollJob({ id: "poll-legacy" }));
  appendDeliveryEvent(legacy, "poll", "legacy-first", undefined, undefined, { at: 400 });
  appendDeliveryEvent(legacy, "poll", "legacy-second", undefined, undefined, { at: 500 });
  assert.deepEqual(listPendingDeliveryEvents().filter((event) => event.jobId === legacy.id).map((event) => event.body), ["legacy-first", "legacy-second"]);
});

test("busy consumers defer coalesced conversation results but still claim notification-only polls", (t) => {
  useTempCallbacksDir(t);
  const presence = sessionPresence({ runtimeId: "poll-busy-runtime" });
  registerSessionPresence(presence);
  const conversation = upsertJob(pollJob({ id: "poll-busy", coalesce: true, delivery: "custom" }));
  const notification = upsertJob(pollJob({ id: "poll-notify", coalesce: true, delivery: "notify-only" }));
  appendDeliveryEvent(conversation, "poll", "defer", undefined, undefined, { at: 100 });
  appendDeliveryEvent(notification, "poll", "notify", undefined, undefined, { at: 200 });

  assert.deepEqual(claimPendingDeliveryEvents(presence, { now: 200, consumerIdle: false }).map((event) => event.body), ["notify"]);
  assert.equal(listPendingDeliveryEvents().find((event) => event.body === "defer")?.claimedBy, undefined);
});

test("append-time coalescing retains opt-in results across every delivery mode", (t) => {
  useTempCallbacksDir(t);
  const cases = [
    { delivery: "custom" as const, target: { kind: "origin" } as const },
    { delivery: "user" as const, target: { kind: "origin" } as const },
    { delivery: "notify-only" as const, target: { kind: "origin" } as const },
    { delivery: "custom" as const, target: { kind: "desktop" } as const },
  ];

  for (const [index, options] of cases.entries()) {
    const job = upsertJob(pollJob({ id: `poll-coalesce-mode-${index}`, coalesce: true, ...options }));
    appendDeliveryEvent(job, "poll", "old result", undefined, undefined, { at: 100 });
    const newest = appendDeliveryEvent(job, "poll", "new result", undefined, undefined, { at: 200 });

    assert.deepEqual(
      listPendingDeliveryEvents().filter((event) => event.jobId === job.id).map((event) => event.body),
      ["new result"],
      `${options.delivery}/${options.target.kind} retains the newest unclaimed result`,
    );
    assert.equal(newest.droppedResults, 1);
  }
});
test("coalescing preserves expired claimed results and reclaims them separately", (t) => {
  useTempCallbacksDir(t);
  const presence = sessionPresence({ runtimeId: "expired-claim-runtime" });
  registerSessionPresence(presence);
  const job = upsertJob(pollJob({ id: "poll-expired-claim", coalesce: true }));
  const claimed = appendDeliveryEvent(job, "poll", "claimed result", undefined, undefined, { at: 100 });
  assert.equal(claimPendingDeliveryEvents(presence, { now: 100, leaseMs: 10 }).at(0)?.id, claimed.id);

  appendDeliveryEvent(job, "poll", "new result", undefined, undefined, { at: 200 });
  assert.deepEqual(
    listPendingDeliveryEvents().filter((event) => event.jobId === job.id).map((event) => event.body),
    ["claimed result", "new result"],
  );
  assert.deepEqual(
    claimPendingDeliveryEvents(presence, { now: 200 }).map((event) => event.body),
    ["claimed result", "new result"],
    "an expired lease is reclaimable but remains outside append-time coalescing",
  );
});

test("coalescing is isolated to one poll job and never removes check-ins", (t) => {
  useTempCallbacksDir(t);
  const firstJob = upsertJob(pollJob({ id: "poll-isolation-first", coalesce: true }));
  const otherJob = upsertJob(pollJob({ id: "poll-isolation-other", coalesce: true }));
  appendDeliveryEvent(firstJob, "poll", "first old", undefined, undefined, { at: 100 });
  appendDeliveryEvent(otherJob, "poll", "other old", undefined, undefined, { at: 110 });
  appendDeliveryEvent(firstJob, "check-in", "check-in", undefined, undefined, { at: 120 });
  appendDeliveryEvent(firstJob, "poll", "first new", undefined, undefined, { at: 130 });

  assert.deepEqual(
    listPendingDeliveryEvents().map((event) => `${event.jobId}:${event.body}`),
    [
      `${otherJob.id}:other old`,
      `${firstJob.id}:check-in`,
      `${firstJob.id}:first new`,
    ],
  );
});

test("legacy poll jobs and delivery events work without new optional fields in v1 and v2 stores", (t) => {
  const dir = useTempCallbacksDir(t);

  for (const version of [1, 2] as const) {
    const current = pollJob({ id: `legacy-poll-optional-fields-v${version}`, coalesce: false });
    const { coalesce: _coalesce, ...legacyJob } = current;
    const legacyEvent: DeliveryEvent = {
      id: `legacy-poll-event-v${version}`,
      jobId: legacyJob.id,
      ...(legacyJob.sessionFile === undefined ? {} : { sessionFile: legacyJob.sessionFile }),
      at: 100,
      kind: "poll",
      body: "legacy result",
      jobSnapshot: legacyJob,
    };
    writeStoreFixture(dir, {
      version,
      jobs: [legacyJob],
      deliveryEvents: [legacyEvent],
      ...(version === 2 ? { sessions: [], reapedJobs: [] } : {}),
    });

    const loaded = loadStore();
    assert.equal(loaded.jobs[0]?.kind, "poll");
    const loadedPoll = loaded.jobs[0] as PollJob;
    assert.equal("coalesce" in loadedPoll, false);
    assert.equal(loadedPoll.coalesce, undefined);
    assert.equal(loadedPoll.coalesce ?? false, false, "legacy polls default to ordered delivery");
    assert.equal(loaded.deliveryEvents[0]?.generatedAt, undefined);
    assert.equal(loaded.deliveryEvents[0]?.backlogStartedAt, undefined);
    assert.equal(loaded.deliveryEvents[0]?.droppedResults, undefined);
    assert.equal(listPendingDeliveryEvents()[0]?.id, legacyEvent.id);
  }
});




function deliveryEvent(id: string, jobSnapshot: ReminderJob, at: number, deliveredAt?: number): DeliveryEvent {
  return {
    id,
    jobId: jobSnapshot.id,
    ...(jobSnapshot.sessionFile === undefined ? {} : { sessionFile: jobSnapshot.sessionFile }),
    at,
    kind: "reminder",
    body: id,
    jobSnapshot,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  };
}

function sessionPresence(overrides: Partial<SessionPresence> = {}): SessionPresence {
  return {
    runtimeId: "runtime-session",
    sessionId: "session-id",
    sessionFile: "/tmp/session.json",
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: 1,
    lastSeenAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function writeStoreFixture(dir: string, data: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "jobs.json"), `${JSON.stringify(data)}\n`, { mode: 0o600 });
}
