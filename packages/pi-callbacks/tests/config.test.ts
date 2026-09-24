import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCallbackConfig } from "../src/config.ts";

function useTempCallbacksDir(t: test.TestContext): string {
  const previous = process.env.PI_CALLBACKS_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-callbacks-config-test-"));
  process.env.PI_CALLBACKS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CALLBACKS_DIR;
    else process.env.PI_CALLBACKS_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("callback config defaults to origin and accepts package-level target overrides", (t) => {
  const dir = useTempCallbacksDir(t);
  assert.deepEqual(loadCallbackConfig(), {
    version: 1,
    defaultTarget: { kind: "origin" },
    checkInIntervalMs: 1_800_000,
    checkInTriggerTurn: true,
    sleepReminderMinSeconds: 10,
  });

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "latest-active-cwd" }));
  assert.deepEqual(loadCallbackConfig(), {
    version: 1,
    defaultTarget: { kind: "latest-active-cwd" },
    checkInIntervalMs: 1_800_000,
    checkInTriggerTurn: true,
    sleepReminderMinSeconds: 10,
  });

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "session:dedicated-session-id" }));
  assert.deepEqual(loadCallbackConfig(), {
    version: 1,
    defaultTarget: { kind: "session", session: "dedicated-session-id" },
    checkInIntervalMs: 1_800_000,
    checkInTriggerTurn: true,
    sleepReminderMinSeconds: 10,
  });
});
test("callback config accepts and disables sleep reminders", (t) => {
  const dir = useTempCallbacksDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", sleepReminderMinSeconds: 12.5 }));
  assert.equal(loadCallbackConfig().sleepReminderMinSeconds, 12.5);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", sleepReminderMinSeconds: null }));
  assert.equal(loadCallbackConfig().sleepReminderMinSeconds, null);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin" }));
  assert.equal(loadCallbackConfig().sleepReminderMinSeconds, 10);
});

test("callback config rejects malformed sleep reminder thresholds", (t) => {
  const dir = useTempCallbacksDir(t);
  for (const value of [0, -1, "10", {}, []]) {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", sleepReminderMinSeconds: value }));
    assert.throws(() => loadCallbackConfig(), /sleepReminderMinSeconds must be a positive finite number or null/);
  }
});



test("callback config accepts check-in interval and trigger settings", (t) => {
  const dir = useTempCallbacksDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    version: 1,
    defaultTarget: "origin",
    checkInIntervalMs: 5_000,
    checkInTriggerTurn: false,
  }));
  assert.deepEqual(loadCallbackConfig(), {
    version: 1,
    defaultTarget: { kind: "origin" },
    checkInIntervalMs: 5_000,
    checkInTriggerTurn: false,
    sleepReminderMinSeconds: 10,
  });

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", checkInIntervalMs: null }));
  assert.equal(loadCallbackConfig().checkInIntervalMs, null);
});

test("callback config fails closed for malformed targets and check-ins", (t) => {
  const dir = useTempCallbacksDir(t);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "session:" }));
  assert.throws(() => loadCallbackConfig(), /requires targetSession/);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", checkInIntervalMs: 0 }));
  assert.throws(() => loadCallbackConfig(), /checkInIntervalMs must be a positive integer or null/);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, defaultTarget: "origin", checkInTriggerTurn: "yes" }));
  assert.throws(() => loadCallbackConfig(), /checkInTriggerTurn must be a boolean/);

  fs.writeFileSync(path.join(dir, "config.json"), "not json");
  assert.throws(() => loadCallbackConfig(), /Invalid pi-callbacks config/);
});
