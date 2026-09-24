import assert from "node:assert/strict";
import test from "node:test";
import type { DeliveryEvent, ReminderJob, SessionPresence } from "../src/types.ts";
import { describeDeliveryTarget, parseDeliveryTarget, selectTargetPresence } from "../src/targets.ts";

const now = 1_000;

function presence(overrides: Partial<SessionPresence>): SessionPresence {
  return {
    runtimeId: "runtime-a",
    sessionId: "session-a",
    sessionFile: "/tmp/a.jsonl",
    cwd: "/repo/a",
    pid: 1,
    startedAt: now,
    lastSeenAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

function event(target: NonNullable<ReminderJob["target"]>): DeliveryEvent {
  const job: ReminderJob = {
    id: "rem-target",
    kind: "reminder",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    origin: { sessionId: "session-a", sessionFile: "/tmp/a.jsonl", cwd: "/repo/a" },
    target,
    sessionFile: "/tmp/a.jsonl",
    cwd: "/repo/a",
    message: "target test",
    delivery: "custom",
    triggerTurn: true,
    dueAt: now,
    events: [],
  };
  return {
    id: "evt-target",
    jobId: job.id,
    ...(job.sessionFile === undefined ? {} : { sessionFile: job.sessionFile }),
    ...(job.origin === undefined ? {} : { origin: job.origin }),
    target,
    at: now,
    kind: "reminder",
    body: "done",
    jobSnapshot: job,
  };
}

test("delivery targets parse explicit sessions and reject incomplete selectors", () => {
  assert.deepEqual(parseDeliveryTarget("origin"), { kind: "origin" });
  assert.deepEqual(parseDeliveryTarget("latest-active"), { kind: "latest-active" });
  assert.deepEqual(parseDeliveryTarget("latest-active-cwd"), { kind: "latest-active-cwd" });
  assert.deepEqual(parseDeliveryTarget("desktop"), { kind: "desktop" });
  assert.deepEqual(parseDeliveryTarget("session", "session-b"), { kind: "session", session: "session-b" });
  assert.equal(describeDeliveryTarget({ kind: "session", session: "session-b" }), "session:session-b");
  assert.throws(() => parseDeliveryTarget("session"), /requires targetSession/);
  assert.throws(() => parseDeliveryTarget("broadcast"), /Unknown callback target/);
});

test("target selection keeps origin exact and resolves latest active scopes", () => {
  const origin = presence({});
  const sameCwd = presence({ runtimeId: "runtime-b", sessionId: "session-b", sessionFile: "/tmp/b.jsonl", lastActiveAt: now + 20 });
  const otherCwd = presence({ runtimeId: "runtime-c", sessionId: "session-c", sessionFile: "/tmp/c.jsonl", cwd: "/repo/c", lastActiveAt: now + 30 });
  const sessions = [origin, sameCwd, otherCwd];

  assert.equal(selectTargetPresence(event({ kind: "origin" }), sessions)?.sessionId, "session-a");
  assert.equal(selectTargetPresence(event({ kind: "latest-active" }), sessions)?.sessionId, "session-c");
  assert.equal(selectTargetPresence(event({ kind: "latest-active-cwd" }), sessions)?.sessionId, "session-b");
  assert.equal(selectTargetPresence(event({ kind: "session", session: "/tmp/c.jsonl" }), sessions)?.sessionId, "session-c");
  assert.equal(selectTargetPresence(event({ kind: "desktop" }), sessions), undefined);
});
