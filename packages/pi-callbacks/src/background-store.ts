import { isStoreLockContentionError } from "./store-lock.ts";

export type BackgroundStoreAttempt<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "contention"; error: unknown };

/**
 * Contain transient shared-store contention at background timer boundaries.
 * Unrelated errors remain fatal so programming and data failures stay visible.
 */
export function attemptBackgroundStoreOperation<T>(run: () => T): BackgroundStoreAttempt<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (isStoreLockContentionError(error)) return { ok: false, reason: "contention", error };
    throw error;
  }
}
