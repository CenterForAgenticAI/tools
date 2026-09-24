import { DiagnosticLog } from "./diagnostics.js";
import type { RuntimeReference } from "./runtime-state.js";
import { RuntimeState } from "./runtime-state.js";

export const WATCHDOG_ADVISORY =
  "The continuation after the routing switch made no progress. Check account limits or switch manually.";

/** Suppresses identical operator notices for 15 minutes across continuation refs. */
export const WATCHDOG_NOTIFICATION_COOLDOWN_MS = 15 * 60 * 1_000;

export interface WatchdogScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface WatchdogRegistration {
  readonly continuationTurnRef: RuntimeReference;
  readonly intervalMs: number;
  readonly cancelContinuation: () => void | Promise<void>;
}

interface ActiveWatchdog {
  readonly continuationTurnRef: RuntimeReference;
  readonly intervalMs: number;
  readonly cancelContinuation: () => void | Promise<void>;
  readonly dispatchedAtMs: number;
  lastProgressAtMs: number;
  toolRunning: boolean;
  timer?: unknown;
  fired: boolean;
}

const defaultScheduler: WatchdogScheduler = {
  set(delayMs, callback) {
    return setTimeout(callback, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ContinuationWatchdog {
  readonly #state: RuntimeState;
  readonly #diagnostics: DiagnosticLog;
  readonly #scheduler: WatchdogScheduler;
  readonly #now: () => number;
  readonly #notify: (message: string) => void | Promise<void>;
  readonly #notificationCooldownMs: number;
  readonly #active = new Map<RuntimeReference, ActiveWatchdog>();
  #lastNotificationAtMs: number | undefined;

  constructor(options: {
    state: RuntimeState;
    diagnostics: DiagnosticLog;
    notify: (message: string) => void | Promise<void>;
    scheduler?: WatchdogScheduler;
    now?: () => number;
    notificationCooldownMs?: number;
  }) {
    const notificationCooldownMs =
      options.notificationCooldownMs ?? WATCHDOG_NOTIFICATION_COOLDOWN_MS;
    if (
      !Number.isSafeInteger(notificationCooldownMs) ||
      notificationCooldownMs < 1
    ) {
      throw new RangeError(
        "watchdog notification cooldown must be a positive safe integer.",
      );
    }
    this.#state = options.state;
    this.#diagnostics = options.diagnostics;
    this.#notify = options.notify;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#now = options.now ?? Date.now;
    this.#notificationCooldownMs = notificationCooldownMs;
  }

  start(registration: WatchdogRegistration): void {
    if (!Number.isSafeInteger(registration.intervalMs) || registration.intervalMs < 1) {
      throw new RangeError("watchdog interval must be a positive safe integer.");
    }
    this.cancel(registration.continuationTurnRef);
    const now = this.#now();
    const active: ActiveWatchdog = {
      ...registration,
      dispatchedAtMs: now,
      lastProgressAtMs: now,
      toolRunning: false,
      fired: false,
    };
    this.#syncState(active);
    this.#active.set(registration.continuationTurnRef, active);
    try {
      this.#arm(active);
    } catch (error) {
      this.#active.delete(registration.continuationTurnRef);
      try {
        this.#state.clearWatchdog(registration.continuationTurnRef);
      } catch (cleanupError) {
        this.#diagnostics.recordError("watchdog.start-cleanup", cleanupError);
      }
      throw error;
    }
  }

  progress(continuationTurnRef: RuntimeReference): void {
    const active = this.#active.get(continuationTurnRef);
    if (!active || active.fired) return;
    active.lastProgressAtMs = this.#now();
    this.#syncState(active);
    if (!active.toolRunning) this.#arm(active);
  }

  setToolRunning(continuationTurnRef: RuntimeReference, running: boolean): void {
    const active = this.#active.get(continuationTurnRef);
    if (!active || active.fired) return;
    active.toolRunning = running;
    active.lastProgressAtMs = this.#now();
    if (active.timer !== undefined) {
      this.#scheduler.clear(active.timer);
      active.timer = undefined;
    }
    this.#syncState(active);
    // A running tool has no polling loop. Tool completion starts one fresh interval.
    if (!running) this.#arm(active);
  }

  progressAll(): void {
    for (const reference of this.#active.keys()) this.progress(reference);
  }

  setAllToolsRunning(running: boolean): void {
    for (const reference of this.#active.keys()) this.setToolRunning(reference, running);
  }

  #syncState(active: ActiveWatchdog): void {
    this.#state.setWatchdog({
      continuationTurnRef: active.continuationTurnRef,
      dispatchedAtMs: active.dispatchedAtMs,
      lastProgressAtMs: active.lastProgressAtMs,
      toolRunning: active.toolRunning,
    });
  }

  #arm(active: ActiveWatchdog): void {
    if (active.timer !== undefined) this.#scheduler.clear(active.timer);
    active.timer = this.#scheduler.set(active.intervalMs, () => {
      active.timer = undefined;
      if (!active.fired && !active.toolRunning) void this.#timeout(active);
    });
  }

  async #timeout(active: ActiveWatchdog): Promise<void> {
    if (active.fired || !this.#active.has(active.continuationTurnRef)) return;
    active.fired = true;
    this.#active.delete(active.continuationTurnRef);
    try {
      this.#state.clearWatchdog(active.continuationTurnRef);
    } catch (error) {
      this.#diagnostics.recordError("watchdog.state", error);
    }
    this.#diagnostics.record("warning", "watchdog.timeout", WATCHDOG_ADVISORY);
    try {
      await active.cancelContinuation();
    } catch (error) {
      this.#diagnostics.recordError("watchdog.cancel", error);
    }
    const now = this.#now();
    if (
      this.#lastNotificationAtMs !== undefined &&
      now - this.#lastNotificationAtMs < this.#notificationCooldownMs
    ) {
      return;
    }
    // Reserve the window before awaiting the sink so concurrent timeouts cannot
    // race identical notices through. A failed notice attempt is still bounded.
    this.#lastNotificationAtMs = now;
    try {
      await this.#notify(this.#diagnostics.sanitizeOutput(WATCHDOG_ADVISORY));
    } catch (error) {
      this.#diagnostics.recordError("watchdog.notify", error);
    }
  }

  cancel(continuationTurnRef: RuntimeReference): boolean {
    const active = this.#active.get(continuationTurnRef);
    if (!active) return false;
    if (active.timer !== undefined) this.#scheduler.clear(active.timer);
    this.#active.delete(continuationTurnRef);
    try {
      this.#state.clearWatchdog(continuationTurnRef);
    } catch (error) {
      this.#diagnostics.recordError("watchdog.cancel", error);
    }
    return true;
  }

  cancelAll(): void {
    for (const active of this.#active.values()) {
      if (active.timer !== undefined) {
        try {
          this.#scheduler.clear(active.timer);
        } catch (error) {
          this.#diagnostics.recordError("watchdog.cancel-timer", error);
        }
      }
      try {
        this.#state.clearWatchdog(active.continuationTurnRef);
      } catch (error) {
        this.#diagnostics.recordError("watchdog.cancel-state", error);
      }
    }
    this.#active.clear();
  }

  activeCount(): number {
    return this.#active.size;
  }
}
