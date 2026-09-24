import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CallbackDaemon, SCHEDULER_STALE_AFTER_MS } from "../src/daemon.ts";
import { readServerInfo } from "../src/daemon-control.ts";
import { appendDeliveryEvent, getJob, listJobs, listPendingDeliveryEvents, loadStore, registerSessionPresence, SESSION_CRASH_GRACE_MS, upsertJob } from "../src/store.ts";
import type { CallbackJob, CheckInDetails, DaemonHealth, DeliveryEvent, ExternalCallbackJob, ExternalCallbackPayload, PollJob, ReminderJob, ScriptJob } from "../src/types.ts";
import { parseCondition } from "../src/utils.ts";

interface TestDaemonControls {
  reconcile(): void;
  scheduleReminder(job: ReminderJob): void;
  schedulePoll(job: PollJob): void;
  scheduleScript(job: ScriptJob): void;
  callback(payload: ExternalCallbackPayload): CallbackJob | undefined;
  drainDesktopEvents(): Promise<void>;
}

function useTempCallbacksDir(t: test.TestContext): string {
  const previous = process.env.PI_CALLBACKS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-daemon-test-"));
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = read();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function baseJob(overrides: Partial<CallbackJob> = {}): Omit<CallbackJob, "kind"> {
  const now = Date.now();
  return {
    id: "job_test",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sessionFile: "/tmp/session.json",
    cwd: process.cwd(),
    message: "daemon test",
    delivery: "custom",
    triggerTurn: true,
    events: [{ at: now, kind: "created", message: "created" }],
    ...overrides,
  } as Omit<CallbackJob, "kind">;
}

function controls(daemon: CallbackDaemon): TestDaemonControls {
  return daemon as unknown as TestDaemonControls;
}

function assertGeneratedAt(event: DeliveryEvent | undefined): void {
  assert.ok(event, "poll outcome queues a delivery event");
  assert.equal(typeof event.generatedAt, "number", "poll outcome records generatedAt");
}

async function daemonPort(): Promise<number> {
  const info = await waitFor(
    () => {
      const current = readServerInfo();
      return current.pid === process.pid && current.port > 0 ? current.port : undefined;
    },
    "daemon server info",
  );
  return info;
}

test("daemon completes due reminders and queues session-scoped delivery events", async (t) => {
  useTempCallbacksDir(t);
  const now = Date.now();
  const job: ReminderJob = {
    ...baseJob({ id: "rem_due", message: "stand up" }),
    kind: "reminder",
    dueAt: now,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon();
  t.after(() => daemon.stop());
  controls(daemon).scheduleReminder(job);

  const completed = await waitFor(
    () => getJob(job.id)?.status === "completed" ? getJob(job.id) as ReminderJob : undefined,
    "completed reminder",
  );
  assert.ok(completed.deliveredAt);

  const [event] = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(event?.kind, "reminder");
  assert.equal(event?.body, "Reminder fired: stand up");
  assert.equal(event?.jobSnapshot.status, "completed");
});

test("daemon cleans the store on its first reconciliation and periodically thereafter", (t) => {
  const dir = useTempCallbacksDir(t);
  let now = 10 * 24 * 60 * 60 * 1_000;
  const oldCompleted = {
    ...baseJob({ id: "old-completed", status: "completed", createdAt: 0, updatedAt: 0 }),
    kind: "reminder" as const,
    dueAt: 0,
  };
  writeStoreFixture(dir, { version: 1, jobs: [oldCompleted], deliveryEvents: [] });
  const daemon = new CallbackDaemon({ now: () => now, cleanupIntervalMs: 1_000 });

  controls(daemon).reconcile();
  assert.deepEqual(listJobs(), []);

  const nextOldCompleted = { ...oldCompleted, id: "next-old-completed" };
  writeStoreFixture(dir, { version: 1, jobs: [nextOldCompleted], deliveryEvents: [] });
  now += 999;
  controls(daemon).reconcile();
  assert.deepEqual(listJobs().map((job) => job.id), [nextOldCompleted.id]);

  now += 1;
  controls(daemon).reconcile();
  assert.deepEqual(listJobs(), []);
});

test("daemon records reconciliation failures and keeps the listener available", async (t) => {
  useTempCallbacksDir(t);
  t.mock.method(console, "error", () => undefined);
  registerSessionPresence({
    runtimeId: "reconcile-failure-runtime",
    sessionId: "reconcile-failure-session",
    sessionFile: "/tmp/reconcile-failure.jsonl",
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: Date.now() - SESSION_CRASH_GRACE_MS - 1,
    lastSeenAt: Date.now() - SESSION_CRASH_GRACE_MS - 1,
    lastActiveAt: Date.now() - SESSION_CRASH_GRACE_MS - 1,
  });
  const daemon = new CallbackDaemon({ port: 0, isProcessAlive: () => { throw new Error("process lookup failed"); } });
  t.after(() => daemon.stop());
  daemon.start();
  const port = await daemonPort();

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await response.json() as DaemonHealth;
  assert.equal(response.status, 503);
  assert.equal(health.ok, false);
  assert.equal(health.lastSchedulerTickAt, null);
  assert.equal(health.lastSchedulerError, "process lookup failed");
  assert.ok(health.lastSchedulerErrorAt !== null);
});

test("daemon retries a failed cleanup before the regular cleanup interval", (t) => {
  useTempCallbacksDir(t);
  let now = 1_000;
  let attempts = 0;
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });
  const daemon = new CallbackDaemon({
    now: () => now,
    cleanupIntervalMs: 60_000,
    cleanupRetryMs: 1_000,
    cleanupStore: () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary cleanup failure");
    },
  });

  controls(daemon).reconcile();
  assert.equal(attempts, 1);
  now += 999;
  controls(daemon).reconcile();
  assert.equal(attempts, 1);
  now += 1;
  controls(daemon).reconcile();
  assert.equal(attempts, 2);
});

test("daemon health does not fail an in-flight poll within its timeout", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  let now = 10_000;
  const startedFile = path.join(callbacksDir, "poll-started.txt");
  const daemon = new CallbackDaemon({ port: 0, now: () => now, pollTimeoutMs: 2_000 });
  t.after(() => daemon.stop());
  daemon.start();
  const port = await daemonPort();
  const job: PollJob = {
    ...baseJob({ id: "poll-in-flight", message: "long poll" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: 0,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'started'); setTimeout(() => {}, 500)`)}`,
    condition: parseCondition("exit:0"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);
  controls(daemon).reconcile();
  await waitFor(() => fs.existsSync(startedFile) ? true : undefined, "poll to start");

  now = 10_001;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await response.json() as DaemonHealth;
  assert.equal(response.status, 200);
  assert.equal(health.ok, true);
  assert.equal(health.overdueJobCount, 0);
  assert.equal(health.oldestOverdueJobAgeMs, null);
});

test("daemon health degrades when scheduler heartbeat becomes stale", async (t) => {
  useTempCallbacksDir(t);
  let now = 10_000;
  const daemon = new CallbackDaemon({ port: 0, now: () => now });
  t.after(() => daemon.stop());
  daemon.start();
  const port = await daemonPort();

  now += SCHEDULER_STALE_AFTER_MS;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await response.json() as DaemonHealth;
  assert.equal(response.status, 503);
  assert.equal(health.ok, false);
  assert.equal(health.lastSchedulerTickAt, 10_000);
  assert.equal(health.overdueJobCount, 0);
  assert.equal(health.oldestOverdueJobAgeMs, null);
  assert.equal(health.schedulerStaleAfterMs, SCHEDULER_STALE_AFTER_MS);
});

test("daemon polls until a condition matches and delivers each deterministic check result", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const counterFile = path.join(callbacksDir, "poll-count.txt");
  const pollScript = path.join(callbacksDir, "poll-until-ready.mjs");
  fs.writeFileSync(pollScript, `
import fs from "node:fs";
const file = ${JSON.stringify(counterFile)};
const current = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(current + 1));
process.stdout.write(current === 0 ? "warming up" : "server ready");
`);
  const job: PollJob = {
    ...baseJob({ id: "poll_match", message: "wait for readiness" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(pollScript)}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 3,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon();
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);

  const completed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "completed" ? current : undefined;
    },
    "matched poll",
  );

  assert.equal(completed.runCount, 2);
  assert.equal(completed.lastResult?.matched, true);
  const events = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(events.length, 2);
  assert.match(events[0]?.body ?? "", /did not match/);
  assert.match(events[1]?.body ?? "", /condition matched/);
  assert.notEqual(events[0]?.generatedAt, undefined, "non-matching poll delivery records generation time");
  assert.notEqual(events[1]?.generatedAt, undefined, "matching poll delivery records generation time");
  assert.ok(events[0]!.generatedAt! <= events[0]!.at, "generation precedes queueing");
  assert.ok(events[1]!.generatedAt! <= events[1]!.at, "generation precedes queueing");
  assert.ok(completed.lastResult?.at !== undefined, "the final poll result records generation time");
});

test("daemon records poll generation after a delayed final result", async (t) => {
  useTempCallbacksDir(t);
  const startedAt = Date.now();
  const job: PollJob = {
    ...baseJob({ id: "poll-delayed-final", message: "wait for delayed readiness" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: startedAt,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.stdout.write('ready'), 100)")}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 1_000 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);

  const completed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "completed" ? current : undefined;
    },
    "delayed final poll",
    2_000,
  );
  const [event] = listPendingDeliveryEvents(job.sessionFile);
  assert.ok(event?.generatedAt !== undefined, "delayed poll delivery has generatedAt");
  assert.ok(event.generatedAt >= startedAt + 75, "generation time is after the final result");
  assert.equal(completed.lastResult?.at, event.generatedAt, "job result and delivery use final generation time");
});

test("command timeout keeps SIGKILL armed after the group leader exits", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const descendantPidFile = path.join(callbacksDir, "timeout-descendant.pid");
  const descendantSource = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000)";
  const leaderSource = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid)); process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 10_000)`;
  const job: PollJob = {
    ...baseJob({ id: "poll_timeout_leader_exit", message: "escalate descendants" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(leaderSource)}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 100 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);
  await waitFor(() => fs.existsSync(descendantPidFile) ? true : undefined, "timeout descendant to start");
  await waitFor(() => getJob(job.id)?.status === "failed" ? true : undefined, "timed-out leader poll");
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);

  await waitFor(
    () => {
      const pid = Number(fs.readFileSync(descendantPidFile, "utf8"));
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    },
    "timed-out descendant to exit after escalation",
    2_000,
  );
});

test("daemon stop terminates in-flight poll groups and prevents post-stop updates", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const childPidFile = path.join(callbacksDir, "shutdown-child.pid");
  const childSource = `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000)`;
  const job: PollJob = {
    ...baseJob({ id: "poll_shutdown", message: "shutdown poll" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childSource)}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 3,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ port: 0, pollTimeoutMs: 10_000 });
  controls(daemon).schedulePoll(job);
  await waitFor(() => fs.existsSync(childPidFile) ? true : undefined, "shutdown poll to start");
  const beforeStop = getJob(job.id) as PollJob;
  await daemon.stop();

  const afterStop = getJob(job.id) as PollJob;
  assert.equal(afterStop.runCount, beforeStop.runCount);
  assert.equal(afterStop.status, beforeStop.status);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((getJob(job.id) as PollJob).runCount, 0);

  const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
  await waitFor(
    () => {
      try {
        process.kill(childPid, 0);
        return undefined;
      } catch {
        return true;
      }
    },
    "shutdown poll group to exit",
    2_000,
  );
});

test("daemon records a failed poll attempt when the command timeout kills a hung child", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const shellPidFile = path.join(callbacksDir, "poll-shell.pid");
  const childPidFile = path.join(callbacksDir, "poll-child.pid");
  const childSource = `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => {}, 10_000)`;
  const job: PollJob = {
    ...baseJob({ id: "poll_timeout", message: "bounded command" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `printf '%s' "$$" > ${JSON.stringify(shellPidFile)}; ${JSON.stringify(process.execPath)} -e ${JSON.stringify(childSource)}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 500 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);
  await waitFor(() => fs.existsSync(shellPidFile) && fs.existsSync(childPidFile) ? true : undefined, "poll process group to start");

  const failed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "failed" ? current : undefined;
    },
    "timed out poll",
  );

  assert.equal(failed.runCount, 1);
  assert.match(failed.lastResult?.error ?? "", /^Poll timed out after 500ms$/);
  assert.equal(failed.lastResult?.ok, false);
  assert.match(listPendingDeliveryEvents(job.sessionFile)[0]?.body ?? "", /timed out/);
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);

  await waitFor(
    () => {
      const pids = [shellPidFile, childPidFile].map((file) => fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : undefined);
      if (pids.some((pid) => pid === undefined || !Number.isInteger(pid) || pid <= 0)) return undefined;
      return pids.every((pid) => {
        try {
          process.kill(pid!, 0);
          return false;
        } catch {
          return true;
        }
      }) ? true : undefined;
    },
    "timed-out poll process group to exit",
    2_000,
  );
});

test("daemon bounds URL polls that never produce a response", async (t) => {
  useTempCallbacksDir(t);
  const server = http.createServer(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const job: PollJob = {
    ...baseJob({ id: "poll_url_timeout", message: "bounded URL" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    url: `http://127.0.0.1:${address.port}/never-completes`,
    condition: parseCondition("status:200"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 30 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);

  const failed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "failed" ? current : undefined;
    },
    "timed out URL poll",
  );
  assert.equal(failed.runCount, 1);
  assert.equal(failed.lastResult?.error, "Poll timed out after 30ms");
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);
});

function installFakeGlab(t: test.TestContext, callbacksDir: string): void {
  const binDir = path.join(callbacksDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fakeGlab = path.join(binDir, "glab");
  fs.writeFileSync(fakeGlab, `#!/usr/bin/env node
if (process.env.FAKE_GLAB_FAILURE === "1") {
  process.stderr.write("authentication failed");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ status: process.env.FAKE_GLAB_STATUS || "running" }));
`);
  fs.chmodSync(fakeGlab, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
}

test("GitLab pipeline source completes on success and exposes its normalised status", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  installFakeGlab(t, callbacksDir);
  process.env.FAKE_GLAB_STATUS = "success";
  t.after(() => delete process.env.FAKE_GLAB_STATUS);
  const job: PollJob = {
    ...baseJob({ id: "poll_gitlab_success", message: "wait for pipeline" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    source: { kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 },
    condition: parseCondition("contains:success"),
    maxRuns: 3,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 2_000 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);

  const completed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "completed" ? current : undefined;
    },
    "successful GitLab pipeline poll",
  );
  assert.equal(completed.lastResult?.status, "success");
  assert.equal(completed.lastResult?.matched, true);
  assert.equal(completed.runCount, 1);
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);
});

for (const { status, expectedJobStatus } of [
  { status: "running", expectedJobStatus: "pending" },
  { status: "pending", expectedJobStatus: "pending" },
  { status: "failed", expectedJobStatus: "failed" },
  { status: "canceled", expectedJobStatus: "completed" },
  { status: "skipped", expectedJobStatus: "completed" },
  { status: "manual", expectedJobStatus: "completed" },
  { status: "future_status", expectedJobStatus: "pending" },
] as const) {
  test(`GitLab pipeline source handles ${status} status`, async (t) => {
    const callbacksDir = useTempCallbacksDir(t);
    installFakeGlab(t, callbacksDir);
    process.env.FAKE_GLAB_STATUS = status;
    t.after(() => delete process.env.FAKE_GLAB_STATUS);
    const job: PollJob = {
      ...baseJob({ id: `poll_gitlab_${status}`, message: "wait for pipeline" }),
      kind: "poll",
      intervalMs: 10,
      nextRunAt: Date.now(),
      source: { kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 },
      condition: parseCondition("always"),
      runCount: 0,
      pushEachResult: true,
    };
    upsertJob(job);

    const daemon = new CallbackDaemon({ pollTimeoutMs: 2_000 });
    t.after(() => daemon.stop());
    controls(daemon).schedulePoll(job);
    const checked = await waitFor(
      () => {
        const current = getJob(job.id) as PollJob | undefined;
        return current !== undefined && current.runCount > 0 ? current : undefined;
      },
      `${status} GitLab pipeline poll`,
    );
    assert.equal(checked.status, expectedJobStatus);
    assert.equal(checked.lastResult?.status, status);
    assert.equal(checked.lastResult?.matched, false);
    assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);
  });
}

test("GitLab source failures are monitoring failures, not pipeline verdicts", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  installFakeGlab(t, callbacksDir);
  process.env.FAKE_GLAB_FAILURE = "1";
  t.after(() => delete process.env.FAKE_GLAB_FAILURE);
  const job: PollJob = {
    ...baseJob({ id: "poll_gitlab_auth_failure", message: "wait for pipeline" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    source: { kind: "gitlab_pipeline", host: "gitlab.test", project: "group/project", pipelineId: 42 },
    condition: parseCondition("contains:failed"),
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ pollTimeoutMs: 2_000 });
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);
  const checked = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current !== undefined && current.runCount > 0 ? current : undefined;
    },
    "failed GitLab source poll",
  );
  assert.equal(checked.status, "pending");
  assert.equal(checked.lastResult?.matched, false);
  assert.match(checked.lastResult?.error ?? "", /failed/);
  assert.equal(checked.events.at(-1)?.message, "Poll monitoring failed");
  assert.match(listPendingDeliveryEvents(job.sessionFile)[0]?.body ?? "", /monitoring failed/);
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);
});

test("started daemon advances runCount for a due poll created through the store path", async (t) => {
  useTempCallbacksDir(t);
  const daemon = new CallbackDaemon({ port: 0 });
  t.after(() => daemon.stop());
  daemon.start();
  await daemonPort();

  const job: PollJob = {
    ...baseJob({ id: "poll_started", message: "started daemon poll" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('poll-ok')")}`,
    condition: parseCondition("exit:0"),
    maxRuns: 1,
    runCount: 0,
    pushEachResult: true,
  };
  upsertJob(job);

  const completed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current && current.runCount > 0 ? current : undefined;
    },
    "started daemon poll attempt",
    2_000,
  );

  assert.equal(completed.runCount, 1);
  assert.equal(completed.status, "completed");
  assert.equal(completed.lastResult?.exitCode, 0);
  assertGeneratedAt(listPendingDeliveryEvents(job.sessionFile)[0]);
});

test("daemon keeps quiet poll checks quiet until maxRuns is exhausted", async (t) => {
  const callbacksDir = useTempCallbacksDir(t);
  const pollScript = path.join(callbacksDir, "poll-not-ready.mjs");
  fs.writeFileSync(pollScript, "process.stdout.write('not yet');\n");
  const job: PollJob = {
    ...baseJob({ id: "poll_exhaust", message: "bounded wait" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: Date.now(),
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(pollScript)}`,
    condition: parseCondition("contains:ready"),
    maxRuns: 2,
    runCount: 0,
    pushEachResult: false,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon();
  t.after(() => daemon.stop());
  controls(daemon).schedulePoll(job);

  const failed = await waitFor(
    () => {
      const current = getJob(job.id) as PollJob | undefined;
      return current?.status === "failed" ? current : undefined;
    },
    "exhausted poll",
  );

  assert.equal(failed.runCount, 2);
  const events = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "failed");
  assert.match(events[0]?.body ?? "", /exhausted without a match/);
  assertGeneratedAt(events[0]);
});

test("daemon delivers periodic check-ins for a quiet poll and resets the check-in timer", (t) => {
  useTempCallbacksDir(t);
  let now = 1_000_000;
  const job: PollJob = {
    ...baseJob({ id: "poll_check_in", createdAt: now - 2_000, updatedAt: now - 2_000, message: "wait for release" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: now + 10_000,
    condition: parseCondition("contains:ready"),
    runCount: 4,
    pushEachResult: false,
    lastResult: { at: now - 500, ok: true, text: "not ready ".repeat(100), matched: false },
  };
  upsertJob(job);

  const daemon = new CallbackDaemon({ port: 0, now: () => now, checkInIntervalMs: 1_000, checkInTriggerTurn: false });
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 1);
  const first = listPendingDeliveryEvents(job.sessionFile)[0]!;
  assert.equal(first.kind, "check-in");
  assert.equal(first.triggerTurn, false);
  assert.equal((first.details as CheckInDetails).schedulerDegraded, false);
  assert.match(first.body, /Status check-in \(not a condition match\)/);
  assert.match(first.body, /poll_check_in/);
  assert.match(first.body, /Runs: 4 \(no maxRuns\)/);
  assert.match(first.body, /Most recent non-matching poll result/);
  assert.match(first.body, /callbacks action="info" id=poll_check_in/);
  assert.ok(first.body.length < 1_500);

  const afterFirst = getJob(job.id) as PollJob;
  assert.equal(afterFirst.status, "pending");
  assert.equal(afterFirst.events.at(-1)?.kind, "check-in");
  assert.equal(afterFirst.lastDeliveryAt, now);

  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 1, "the check-in resets its timer");
  now += 1_000;
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 2);
});

test("daemon delivers degraded check-ins with scheduler details and keeps them interval-bounded", (t) => {
  useTempCallbacksDir(t);
  t.mock.method(console, "error", () => undefined);
  let now = 2_000_000;
  const job: PollJob = {
    ...baseJob({ id: "degraded_check_in", createdAt: now, updatedAt: now, message: "wait for stalled scheduler" }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: now + 1_000,
    condition: parseCondition("contains:ready"),
    runCount: 7,
    pushEachResult: false,
  };
  upsertJob(job);

  let failCleanup = false;
  registerSessionPresence({
    runtimeId: "degraded-check-in-runtime",
    sessionId: "degraded-check-in-session",
    sessionFile: "/tmp/degraded-check-in.jsonl",
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: now - SESSION_CRASH_GRACE_MS - 1,
    lastSeenAt: now - SESSION_CRASH_GRACE_MS - 1,
    lastActiveAt: now - SESSION_CRASH_GRACE_MS - 1,
  });
  const daemon = new CallbackDaemon({
    port: 0,
    now: () => now,
    checkInIntervalMs: 1_000,
    isProcessAlive: () => {
      if (failCleanup) throw new Error("scheduler test failure");
      return true;
    },
  });

  controls(daemon).reconcile();
  failCleanup = true;
  now += 1;
  controls(daemon).reconcile();
  failCleanup = false;
  now += SCHEDULER_STALE_AFTER_MS;
  controls(daemon).reconcile();

  const first = listPendingDeliveryEvents(job.sessionFile)[0]!;
  const firstDetails = first.details as CheckInDetails;
  assert.equal(first.kind, "check-in");
  assert.equal(firstDetails.schedulerDegraded, true);
  assert.equal(firstDetails.scheduler?.lastSuccessfulTickAgeMs, SCHEDULER_STALE_AFTER_MS + 1);
  assert.equal(firstDetails.scheduler?.overduePollCount, 1);
  assert.equal(firstDetails.scheduler?.error, "scheduler test failure");
  assert.match(first.body, /^Scheduler stalled:/);
  assert.match(first.body, /not a condition match/);
  assert.match(first.body, /counters cannot be trusted as evidence of progress/);
  assert.match(first.body, /last successful tick 3s ago/);
  assert.match(first.body, /overdue polls: 1/);
  assert.match(first.body, /current scheduler error: scheduler test failure/);
  assert.ok(first.body.length < 1_500);
  assert.equal((getJob(job.id) as PollJob).status, "pending");
  assert.equal((getJob(job.id) as PollJob).events.at(-1)?.kind, "check-in");

  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 1, "repeated degraded ticks do not flood before the interval");
  now += 999;
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 1, "the degraded timer is still active");
  now += 1;
  controls(daemon).reconcile();
  const events = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(events.length, 2, "a second notice arrives only after one interval");
  daemon.stop();
});

test("daemon uses a persisted delivery event to delay the first upgraded check-in", (t) => {
  useTempCallbacksDir(t);
  let now = 4_000_000;
  const job: PollJob = {
    ...baseJob({ id: "upgraded_check_in", createdAt: now - 10_000 }),
    kind: "poll", intervalMs: 10, nextRunAt: now + 10_000, condition: parseCondition("contains:ready"), runCount: 1, pushEachResult: false,
  };
  writeStoreFixture(process.env.PI_CALLBACKS_DIR!, {
    version: 2,
    jobs: [job],
    deliveryEvents: [{
      id: "old-delivery",
      jobId: job.id,
      target: { kind: "origin" },
      at: now - 500,
      kind: "poll",
      body: "old delivery",
      jobSnapshot: job,
      deliveredAt: now - 400,
    }],
    sessions: [],
  });
  const daemon = new CallbackDaemon({ now: () => now, checkInIntervalMs: 1_000 });
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 0);
  now += 499;
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).length, 0);
  now += 1;
  controls(daemon).reconcile();
  assert.equal(listPendingDeliveryEvents(job.sessionFile).at(-1)?.kind, "check-in");
});

test("daemon baselines legacy jobs with absent or evicted delivery history once", (t) => {
  const dir = useTempCallbacksDir(t);
  let now = 5_000_000;
  const noHistory: PollJob = {
    ...baseJob({ id: "legacy-no-history", createdAt: now - 10_000, updatedAt: now - 10_000 }),
    kind: "poll",
    intervalMs: 10,
    nextRunAt: now + 10_000,
    condition: parseCondition("contains:ready"),
    runCount: 2,
    pushEachResult: false,
  };
  const evictedHistory: ExternalCallbackJob = {
    ...baseJob({
      id: "legacy-evicted-history",
      createdAt: now - 10_000,
      updatedAt: now - 10_000,
      events: [{ at: now - 8_000, kind: "external-callback", message: "A delivered callback event was pruned" }],
      token: "legacy-evicted-token",
    }),
    kind: "callback",
    endpoint: "http://127.0.0.1:47837/callback",
  };
  writeStoreFixture(dir, {
    version: 2,
    jobs: [noHistory, evictedHistory],
    // The callback delivery event was evicted by pruning; no retained timestamp remains.
    deliveryEvents: [],
    sessions: [],
  });

  const daemon = new CallbackDaemon({ now: () => now, checkInIntervalMs: 1_000 });
  controls(daemon).reconcile();

  assert.deepEqual(listPendingDeliveryEvents(), [], "the upgrade reconcile does not burst check-ins");
  const firstBaseline = (JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")) as { checkInBaselineAt: number }).checkInBaselineAt;
  assert.equal(firstBaseline, now);
  assert.equal(loadStore().checkInBaselineAt, firstBaseline, "a second load keeps the persisted baseline");
  assert.equal((JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")) as { checkInBaselineAt: number }).checkInBaselineAt, firstBaseline);

  now += 1_000;
  controls(daemon).reconcile();
  const events = listPendingDeliveryEvents();
  assert.deepEqual(events.map((event) => event.jobId).sort(), [noHistory.id, evictedHistory.id].sort());
  assert.ok(events.every((event) => event.kind === "check-in"));

  daemon.stop();
});

test("daemon does not check in terminal jobs or push-each-result polls", (t) => {
  useTempCallbacksDir(t);
  const now = 2_000_000;
  const terminal: PollJob = {
    ...baseJob({ id: "terminal_check_in", status: "completed", createdAt: now - 10_000 }),
    kind: "poll", intervalMs: 10, nextRunAt: now, condition: parseCondition("always"), runCount: 1, maxRuns: 1, pushEachResult: false,
  };
  const noisy: PollJob = {
    ...baseJob({ id: "noisy_check_in", createdAt: now - 10_000 }),
    kind: "poll", intervalMs: 10, nextRunAt: now + 10_000, condition: parseCondition("contains:ready"), runCount: 1, pushEachResult: true,
  };
  upsertJob(terminal);
  upsertJob(noisy);
  const daemon = new CallbackDaemon({ now: () => now, checkInIntervalMs: 1_000 });
  controls(daemon).reconcile();
  assert.deepEqual(listPendingDeliveryEvents(), []);
});

test("daemon delivers periodic check-ins for passive callback jobs", (t) => {
  useTempCallbacksDir(t);
  const now = 3_000_000;
  const job: ExternalCallbackJob = {
    ...baseJob({ id: "passive_check_in", createdAt: now - 2_000, message: "wait for external system", token: "passive-token" }),
    kind: "callback",
    endpoint: "http://127.0.0.1:47837/callback",
  };
  upsertJob(job);
  const daemon = new CallbackDaemon({ now: () => now, checkInIntervalMs: 1_000 });
  controls(daemon).reconcile();
  const [event] = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(event?.kind, "check-in");
  assert.match(event?.body ?? "", /passive_check_in/);
  assert.match(event?.body ?? "", /\(callback\)/);
  assert.equal((getJob(job.id) as ExternalCallbackJob).status, "pending");
});

test("external token callbacks can deliver progress without completion and then fail the job", (t) => {
  useTempCallbacksDir(t);
  const job: ExternalCallbackJob = {
    ...baseJob({ id: "cb_token", message: "external work", token: "pi_cb_test_token" }),
    kind: "callback",
    endpoint: "http://127.0.0.1:47837/callback",
  };
  upsertJob(job);

  const daemon = new CallbackDaemon();
  const progress = controls(daemon).callback({ token: job.token!, message: "half done", status: "info", complete: false, details: { step: 1 } });
  assert.equal(progress?.status, "pending");
  assert.equal((getJob(job.id) as ExternalCallbackJob | undefined)?.completedAt, undefined);

  const failed = controls(daemon).callback({ token: job.token!, message: "boom", status: "failure", details: { code: "EFAIL" } });
  assert.equal(failed?.status, "failed");

  const events = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.kind, "external-callback");
  assert.equal(events[1]?.kind, "failed");
  assert.match(events[1]?.body ?? "", /boom/);
});

test("daemon runs script jobs with callback environment and captures bounded output", async (t) => {
  useTempCallbacksDir(t);
  const scriptSource = "process.stdout.write(process.env.PI_CALLBACK_TOKEN + ':' + process.env.PI_CALLBACK_JOB_ID); process.stderr.write('warn');";
  const job: ScriptJob = {
    ...baseJob({ id: "script_ok", message: "script smoke", token: "pi_cb_script_token" }),
    kind: "script",
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(scriptSource)}`,
  };
  upsertJob(job);

  const daemon = new CallbackDaemon();
  t.after(() => daemon.stop());
  controls(daemon).scheduleScript(job);

  const completed = await waitFor(
    () => {
      const current = getJob(job.id) as ScriptJob | undefined;
      return current?.status === "completed" ? current : undefined;
    },
    "completed script",
    2_000,
  );

  assert.equal(completed.exitCode, 0);
  assert.equal(completed.stdoutTail, "pi_cb_script_token:script_ok");
  assert.equal(completed.stderrTail, "warn");
  const [event] = listPendingDeliveryEvents(job.sessionFile);
  assert.equal(event?.kind, "script-exit");
  assert.match(event?.body ?? "", /Background script completed/);
});

test("daemon delivers desktop-targeted events through the injected notifier", async (t) => {
  useTempCallbacksDir(t);
  const delivered: DeliveryEvent[] = [];
  const job: ReminderJob = {
    ...baseJob({
      id: "desktop-reminder",
      status: "completed",
      origin: { sessionId: "owner", sessionFile: "/tmp/owner.jsonl", cwd: process.cwd() },
      target: { kind: "desktop" },
    }),
    kind: "reminder",
    dueAt: Date.now(),
  };
  upsertJob(job);
  appendDeliveryEvent(job, "reminder", "desktop body");
  const daemon = new CallbackDaemon({ desktopNotifier: async (event) => { delivered.push(event); } });

  await controls(daemon).drainDesktopEvents();

  assert.deepEqual(delivered.map((event) => event.body), ["desktop body"]);
  assert.deepEqual(listPendingDeliveryEvents(), []);
});

test("desktop poll delivery includes freshness metadata and persists the notifier handoff time", async (t) => {
  useTempCallbacksDir(t);
  const delivered: DeliveryEvent[] = [];
  const job: PollJob = {
    ...baseJob({
      id: "desktop-poll",
      status: "pending",
      origin: { sessionId: "owner", sessionFile: "/tmp/owner.jsonl", cwd: process.cwd() },
      target: { kind: "desktop" },
    }),
    kind: "poll",
    intervalMs: 60_000,
    nextRunAt: Date.now(),
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
  };
  upsertJob(job);
  const queuedAt = Date.now();
  const event = appendDeliveryEvent(job, "poll", "desktop poll body", undefined, undefined, { at: queuedAt, generatedAt: queuedAt - 10 });
  const daemon = new CallbackDaemon({ desktopNotifier: async (notification) => { delivered.push(notification); } });

  await controls(daemon).drainDesktopEvents();

  assert.match(delivered[0]?.body ?? "", /^generated=.* delivered=.* queued=/);
  const deliveredPart = delivered[0]!.body.split(" ").find((part) => part.startsWith("delivered="));
  assert.equal(loadStore().deliveryEvents.find((candidate) => candidate.id === event.id)?.deliveredAt, Date.parse(deliveredPart!.slice("delivered=".length)));
  assert.deepEqual(listPendingDeliveryEvents(), []);
});

test("desktop freshness warning starts after three intervals, not at the boundary", async (t) => {
  useTempCallbacksDir(t);
  let now = 300;
  const delivered: DeliveryEvent[] = [];
  const job: PollJob = {
    ...baseJob({
      id: "desktop-warning-boundary",
      createdAt: 0,
      updatedAt: 0,
      status: "pending",
      origin: { sessionId: "owner", sessionFile: "/tmp/desktop-warning.jsonl", cwd: process.cwd() },
      target: { kind: "desktop" },
    }),
    kind: "poll",
    intervalMs: 100,
    nextRunAt: 0,
    condition: { type: "always" },
    runCount: 1,
    pushEachResult: true,
  };
  upsertJob(job);
  appendDeliveryEvent(job, "poll", "desktop boundary", undefined, undefined, { at: 0, generatedAt: 0, backlogStartedAt: 0 });
  const daemon = new CallbackDaemon({ now: () => now, desktopNotifier: async (event) => { delivered.push(event); } });
  await controls(daemon).drainDesktopEvents();
  assert.doesNotMatch(delivered[0]?.body ?? "", /consumer is not keeping up/);

  appendDeliveryEvent(job, "poll", "desktop late", undefined, undefined, { at: 1, generatedAt: 1, backlogStartedAt: 1 });
  now = 302;
  await controls(daemon).drainDesktopEvents();
  assert.match(delivered[1]?.body ?? "", /consumer is not keeping up/);
});

test("desktop drain claims one event at a time and does not overlap a slow notifier", async (t) => {
  useTempCallbacksDir(t);
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const makeJob = (id: string): ReminderJob => ({
    ...baseJob({
      id,
      status: "completed",
      origin: { sessionId: "owner", sessionFile: "/tmp/owner.jsonl", cwd: process.cwd() },
      target: { kind: "desktop" },
    }),
    kind: "reminder",
    dueAt: Date.now(),
  });
  for (const id of ["desktop-slow-1", "desktop-slow-2"]) {
    const job = upsertJob(makeJob(id));
    appendDeliveryEvent(job, "reminder", id);
  }
  const daemon = new CallbackDaemon({
    desktopNotifier: async (event) => {
      calls.push(event.body);
      if (calls.length === 1) await firstGate;
    },
  });

  const firstDrain = controls(daemon).drainDesktopEvents();
  await waitFor(() => calls.length === 1 ? true : undefined, "first desktop notification to block");
  await controls(daemon).drainDesktopEvents();

  const duringBlock = loadStore().deliveryEvents.filter((event) => event.deliveredAt === undefined);
  assert.equal(duringBlock.filter((event) => event.claimedBy !== undefined).length, 1);
  assert.equal(duringBlock.filter((event) => event.claimedBy === undefined).length, 1);
  assert.deepEqual(calls, ["desktop-slow-1"]);

  releaseFirst();
  await firstDrain;
  assert.deepEqual(calls, ["desktop-slow-1", "desktop-slow-2"]);
  assert.deepEqual(listPendingDeliveryEvents(), []);
});

test("desktop notifier failure releases once and retries only on a later drain", async (t) => {
  useTempCallbacksDir(t);
  t.mock.method(console, "error", () => undefined);
  const job = upsertJob({
    ...baseJob({
      id: "desktop-retry",
      status: "completed",
      origin: { sessionId: "owner", sessionFile: "/tmp/owner.jsonl", cwd: process.cwd() },
      target: { kind: "desktop" },
    }),
    kind: "reminder",
    dueAt: Date.now(),
  });
  appendDeliveryEvent(job, "reminder", "retry later");
  let attempts = 0;
  let shouldFail = true;
  const daemon = new CallbackDaemon({
    desktopNotifier: async () => {
      attempts++;
      if (shouldFail) throw new Error("notification service unavailable");
    },
  });

  await controls(daemon).drainDesktopEvents();
  assert.equal(attempts, 1);
  assert.equal(listPendingDeliveryEvents().length, 1);
  assert.equal(loadStore().deliveryEvents[0]?.claimedBy, undefined);

  shouldFail = false;
  await controls(daemon).drainDesktopEvents();
  assert.equal(attempts, 2);
  assert.deepEqual(listPendingDeliveryEvents(), []);
});

test("daemon reconciliation removes crashed origin-session jobs after the grace period", (t) => {
  useTempCallbacksDir(t);
  const presence = {
    runtimeId: "dead-runtime",
    sessionId: "dead-session",
    sessionFile: "/tmp/dead.jsonl",
    cwd: process.cwd(),
    pid: 999_999,
    startedAt: 1_000,
    lastSeenAt: 1_000,
    lastActiveAt: 1_000,
  };
  registerSessionPresence(presence);
  upsertJob({
    ...baseJob({ id: "dead-origin-job", origin: presence, target: { kind: "origin" } }),
    kind: "reminder",
    dueAt: 999_999,
  });
  const daemon = new CallbackDaemon({ now: () => 121_000, isProcessAlive: () => false });

  controls(daemon).reconcile();

  assert.deepEqual(listJobs(), []);
});

function writeStoreFixture(dir: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, "jobs.json"), `${JSON.stringify(data)}\n`, { mode: 0o600 });
}
