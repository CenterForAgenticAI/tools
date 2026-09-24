import assert from "node:assert/strict";
import test from "node:test";
import { detectLiteralSleep } from "../src/sleep-reminder.ts";

test("detects complete literal sleep durations in executable command position", () => {
  const cases = [
    ["sleep 10", { maxNonLoopSeconds: 10, hasPositiveLoopSleep: false }],
    ["sleep 10.5", { maxNonLoopSeconds: 10.5, hasPositiveLoopSleep: false }],
    ["sleep .5s 1m 2h 1d", { maxNonLoopSeconds: 93_660.5, hasPositiveLoopSleep: false }],
    ["echo ready; sleep 11; true", { maxNonLoopSeconds: 11, hasPositiveLoopSleep: false }],
    ["sleep 5; sleep 12", { maxNonLoopSeconds: 12, hasPositiveLoopSleep: false }],
    ["(sleep 7)", { maxNonLoopSeconds: 7, hasPositiveLoopSleep: false }],
    ["{ sleep 8; }", { maxNonLoopSeconds: 8, hasPositiveLoopSleep: false }],
    ["true && sleep 9", { maxNonLoopSeconds: 9, hasPositiveLoopSleep: false }],
    ["sleep 5 & sleep 12", { maxNonLoopSeconds: 12, hasPositiveLoopSleep: false }],
  ] as const;
  for (const [command, expected] of cases) assert.deepEqual(detectLiteralSleep(command), expected, command);
});

test("recognizes sleeps in if and loop conditions", () => {
  assert.deepEqual(detectLiteralSleep("if sleep 60; then true; fi"), { maxNonLoopSeconds: 60, hasPositiveLoopSleep: false });
  assert.deepEqual(detectLiteralSleep("if sleep 60 & then true; fi"), { maxNonLoopSeconds: 60, hasPositiveLoopSleep: false });
  assert.deepEqual(detectLiteralSleep("if true && sleep 60; then true; fi"), { maxNonLoopSeconds: 60, hasPositiveLoopSleep: false });
  assert.deepEqual(detectLiteralSleep("if true; then true; elif sleep 90; then true; fi"), { maxNonLoopSeconds: 90, hasPositiveLoopSleep: false });
  for (const command of ["while sleep 1; do true; done", "until sleep 2; do true; done"]) {
    assert.deepEqual(detectLiteralSleep(command), { maxNonLoopSeconds: undefined, hasPositiveLoopSleep: true }, command);
  }
});

test("recognizes positive literal sleeps in all supported loop forms", () => {
  for (const command of [
    "while true; do sleep 1; done",
    "until ready; do sleep .1s; done",
    "for item in one two; do sleep 2; done",
    "for item\nin one; do sleep 1; done",
    "for item\ndo sleep 1\ndone",
    "select item in one; do sleep 3; done",
    "select item\nin one\ndo sleep 1\ndone",
    "while true; do for item in one; do sleep 1; done; done",
  ]) {
    assert.deepEqual(detectLiteralSleep(command), { maxNonLoopSeconds: undefined, hasPositiveLoopSleep: true }, command);
  }
  assert.deepEqual(detectLiteralSleep("while true; do sleep 1; done; sleep 20"), { maxNonLoopSeconds: 20, hasPositiveLoopSleep: true });
});

test("rejects malformed control grammar around a sleep", () => {
  for (const command of [
    "sleep 60; then true",
    "&& sleep 10",
    "|| sleep 10",
    "| sleep 10",
    "|& sleep 10",
    "; sleep 10",
    "& sleep 10",
    "true; ; sleep 10",
    "if ; sleep 60; then true; fi",
    "if true; then ; sleep 60; fi",
    "if true; then true; else ; sleep 60; fi",
    "if true; then true; elif ; sleep 60; then true; fi",
    "while ; sleep 1; do true; done",
    "until ; sleep 1; do true; done",
    "while true; do ; sleep 1; done",
    "for item; do ; sleep 1; done",
    "case x; sleep 60; esac",
    "sleep 60 (true)",
    "sleep 60 { true; }",
    "{ sleep 60 }",
    "{sleep 60; }",
    "true; {sleep 60; }",
    "true && {sleep 60; }",
    "(sleep 60) true",
    "{ sleep 60; } true",
    "if true; then sleep 60; fi true",
    "while true; do sleep 1; done true",
    "if sleep 60 && then true; fi",
    "while sleep 1 && do true; done",
    "if true; then sleep 60 && else true; fi",
    "for item in one; sleep 60; do true; done",
    "if sleep 60 &&\nthen true; fi",
    "if sleep 60 && ; then true; fi",
    "while true; do sleep 1 | done",
    "for item in one && do sleep 1; done",
    "select item\nin one\nsleep 60\ndo true\ndone",
    "sleep 60; else true",
    "sleep 60; elif true; then true",
    "sleep 60; in value",
    "while true; do if true; then sleep 1; done; fi",
  ]) {
    assert.equal(detectLiteralSleep(command), undefined, command);
  }
});

test("ignores non-executable, quoted, zero, and dynamic sleeps", () => {
  for (const command of [
    "echo sleep 60",
    "echo \"sleep 60\"",
    "sleeping 60",
    "sleep.log 60",
    "echo ready sleep 60",
    "A=1 sleep 10",
    "time sleep 10",
    "# sleep 60",
    "sleep 0",
    "sleep -1",
    "sleep 1 $SECONDS",
    "sleep $WAIT",
    "sleep $(printf 60)",
    "sleep $((30 + 30))",
    "while true; do sleep $WAIT; done",
    "while true; do sleep 1",
    "if true; then sleep 60",
    "sleep 60 &&",
    "sleep 60 &&\n",
    "done",
  ]) assert.equal(detectLiteralSleep(command), undefined, command);
});

test("fails closed for unsupported shell syntax and bounded input", () => {
  assert.equal(detectLiteralSleep("sleep 60 && echo \\\"unterminated"), undefined);
  assert.equal(detectLiteralSleep("sleep 60 " + "x".repeat(100_000)), undefined);
});
