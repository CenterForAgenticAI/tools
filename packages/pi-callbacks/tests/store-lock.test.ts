import assert from "node:assert/strict";
import test from "node:test";
import { attemptBackgroundStoreOperation } from "../src/background-store.ts";
import { isStoreLockContentionError } from "../src/store-lock.ts";

test("classifies Node SQLite busy and locked errors as transient contention", () => {
  for (const error of [
    Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" }),
    Object.assign(new Error("database table is locked"), { code: "SQLITE_LOCKED" }),
    Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }),
    Object.assign(new Error("database is locked"), { errcode: 6 }),
  ]) {
    assert.equal(isStoreLockContentionError(error), true);
  }
});

test("background store operations contain contention but preserve fatal failures", () => {
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const attempt = attemptBackgroundStoreOperation(() => { throw busy; });
  assert.deepEqual(attempt, { ok: false, reason: "contention", error: busy });
  assert.throws(
    () => attemptBackgroundStoreOperation(() => { throw new TypeError("bad callback state"); }),
    /bad callback state/,
  );
});

test("does not hide unrelated SQLite, filesystem, or programming failures", () => {
  for (const error of [
    Object.assign(new Error("malformed database"), { code: "ERR_SQLITE_ERROR", errcode: 11 }),
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    new TypeError("bad callback state"),
    "database is locked",
  ]) {
    assert.equal(isStoreLockContentionError(error), false);
  }
});
