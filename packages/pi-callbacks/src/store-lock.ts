import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storeFile } from "./paths.ts";

const LOCK_TIMEOUT_MS = 5_000;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** Identify only SQLite's transient writer/table contention errors. */
export function isStoreLockContentionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errcode?: unknown };
  return candidate.code === "SQLITE_BUSY"
    || candidate.code === "SQLITE_LOCKED"
    || candidate.errcode === SQLITE_BUSY
    || candidate.errcode === SQLITE_LOCKED;
}

export function withStoreLock<T>(run: () => T): T {
  const file = `${storeFile()}.lock.sqlite`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  let outcome: LockOutcome<T> | undefined;

  try {
    fs.chmodSync(file, 0o600);
    database.exec(`PRAGMA busy_timeout = ${LOCK_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      database.exec("COMMIT");
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error: rollback(database, error) };
    }
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    database.close();
  } catch (error) {
    outcome = combineErrors(outcome, error, "Callback store lock failed and its database could not close");
  }

  if (!outcome) throw new Error("Callback store lock finished without an outcome");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

type LockOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function rollback(database: DatabaseSync, primaryError: unknown): unknown {
  try {
    database.exec("ROLLBACK");
    return primaryError;
  } catch (rollbackError) {
    return new AggregateError(
      [primaryError, rollbackError],
      "Callback store mutation failed and its lock transaction could not roll back",
    );
  }
}

function combineErrors<T>(outcome: LockOutcome<T> | undefined, error: unknown, message: string): LockOutcome<T> {
  if (!outcome) return { ok: false, error };
  if (outcome.ok) return { ok: false, error };
  return { ok: false, error: new AggregateError([outcome.error, error], message) };
}
