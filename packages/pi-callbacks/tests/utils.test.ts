import assert from "node:assert/strict";
import test from "node:test";
import { conditionMatches, formatJobBlock, parseCondition, parseDuration } from "../src/utils.ts";
import type { ExternalCallbackJob, PollJob, PollResult, ReminderJob, ScriptJob } from "../src/types.ts";

test("parseDuration supports compact and compound durations", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2_000);
  assert.equal(parseDuration("3m"), 180_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1h 30m"), 5_400_000);
});

test("parseCondition defaults bare text to contains", () => {
  assert.deepEqual(parseCondition("ready"), { type: "text_contains", value: "ready" });
  assert.deepEqual(parseCondition("contains:ready"), { type: "text_contains", value: "ready" });
  assert.deepEqual(parseCondition("regex:^ok"), { type: "regex", value: "^ok" });
  assert.deepEqual(parseCondition("exit:0"), { type: "exit_code", value: 0 });
  assert.deepEqual(parseCondition("status:200"), { type: "status_code", value: 200 });
});

test("conditionMatches checks command/url poll results", () => {
  const result: PollResult = { at: Date.now(), ok: true, exitCode: 0, statusCode: 200, stdout: "server ready", matched: false };
  assert.equal(conditionMatches({ type: "text_contains", value: "ready" }, result), true);
  assert.equal(conditionMatches({ type: "not_contains", value: "failed" }, result), true);
  assert.equal(conditionMatches({ type: "regex", value: "server\\s+ready" }, result), true);
  assert.equal(conditionMatches({ type: "regex", value: "^success$" }, { ...result, stdout: "success\n" }), true);
  assert.equal(conditionMatches({ type: "regex", value: "^success$" }, { ...result, stdout: " success\n" }), false);
  assert.equal(conditionMatches({ type: "exit_code", value: 0 }, result), true);
  assert.equal(conditionMatches({ type: "status_code", value: 200 }, result), true);
  assert.equal(conditionMatches({ type: "status_code", value: 500 }, result), false);
});

test("formatJobBlock presents poll timing and delivery state as a readable block", () => {
  const now = 1_000_000;
  const job: PollJob = {
    id: "poll_list",
    kind: "poll",
    status: "pending",
    createdAt: now - 10_000,
    updatedAt: now,
    label: "Pipeline watch",
    message: "Wait for the pipeline terminal state",
    delivery: "custom",
    triggerTurn: true,
    intervalMs: 60_000,
    nextRunAt: now + 30_000,
    command: "check-pipeline",
    condition: { type: "text_contains", value: "TERMINAL" },
    maxRuns: 10,
    runCount: 3,
    pushEachResult: false,
    events: [],
  };

  const formatted = formatJobBlock(job, { now, pendingDeliveries: 2 });
  assert.match(formatted, /^poll_list — Pipeline watch/m);
  assert.match(formatted, /^ {2}status: pending · kind: poll$/m);
  assert.match(formatted, /^ {2}timing: every 1m · next in 30s \(.+\) · runs 3\/10$/m);
  assert.match(formatted, /^ {2}poll scheduled$/m);
  assert.match(formatted, /^ {2}message: Wait for the pipeline terminal state$/m);
  assert.match(formatted, /^ {2}pending deliveries: 2$/m);

  const withResult = formatJobBlock({
    ...job,
    lastResult: { at: now - 5_000, ok: false, exitCode: 1, stderr: "not ready", matched: false },
  }, { now });
  assert.match(withResult, /^ {2}last poll exit=1 @ .+$/m);
});

test("formatJobBlock presents reminder due timing", () => {
  const now = 2_000_000;
  const job: ReminderJob = {
    id: "rem_list",
    kind: "reminder",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    message: "Check the oven",
    delivery: "custom",
    triggerTurn: true,
    dueAt: now + 300_000,
    events: [],
  };

  const formatted = formatJobBlock(job, { now });
  assert.match(formatted, /^rem_list$/m);
  assert.match(formatted, /^ {2}timing: due in 5m \(.+\)$/m);
  assert.match(formatted, /^ {2}message: Check the oven$/m);
});

test("formatJobBlock presents script and external callback lifecycle timing", () => {
  const now = 3_000_000;
  const script: ScriptJob = {
    id: "script_list",
    kind: "script",
    status: "running",
    createdAt: now - 180_000,
    updatedAt: now,
    message: "Build release",
    delivery: "custom",
    triggerTurn: true,
    command: "npm run build",
    pid: 1234,
    startedAt: now - 120_000,
    events: [],
  };
  const callback: ExternalCallbackJob = {
    id: "cb_list",
    kind: "callback",
    status: "pending",
    createdAt: now - 300_000,
    updatedAt: now,
    message: "Wait for deploy hook",
    delivery: "custom",
    triggerTurn: true,
    token: "pi_cb_test",
    events: [],
  };

  const scriptFormatted = formatJobBlock(script, { now });
  assert.match(scriptFormatted, /^ {2}status: running · kind: script · pid: 1234$/m);
  assert.match(scriptFormatted, /^ {2}timing: started 2m ago \(.+\)$/m);

  const callbackFormatted = formatJobBlock(callback, { now });
  assert.match(callbackFormatted, /^ {2}status: pending · kind: callback · token$/m);
  assert.match(callbackFormatted, /^ {2}timing: created 5m ago \(.+\)$/m);
});
