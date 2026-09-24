import type { Api, Model } from "@earendil-works/pi-ai";
import { DiagnosticLog } from "./diagnostics.js";
import type {
  ContinuationDestinationFamily,
  ContinuationRoutingReason,
  RuntimeReference,
} from "./runtime-state.js";
import { RuntimeState } from "./runtime-state.js";

export const FIXED_CONTINUATION_MESSAGE =
  "Continue after the confirmed account switch. Do not repeat the failed request.";

export interface ContinuationDestination {
  readonly providerId: string;
  readonly family: ContinuationDestinationFamily;
  readonly model: Model<Api>;
  readonly routingReason: ContinuationRoutingReason;
  /** Skip physical setModel and pin this exact account for one unified dispatch. */
  readonly logicalRoutePin?: Readonly<{ readonly requestedModelId: string }>;
}

export interface ContinuationRecord {
  readonly failedTurnRef: RuntimeReference;
  readonly continuationTurnRef: RuntimeReference;
  readonly destinationProviderId: string;
  readonly destinationFamily: ContinuationDestinationFamily;
  readonly routingReason: ContinuationRoutingReason;
  readonly selectedAtMs: number;
}

export interface ContinuationScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface ContinuationDependencies {
  readonly state: RuntimeState;
  readonly diagnostics: DiagnosticLog;
  readonly setModel: (model: Model<Api>) => Promise<boolean>;
  readonly dispatchFollowUp: (message: string, signal: AbortSignal) => void | Promise<void>;
  readonly scheduler?: ContinuationScheduler;
  readonly now?: () => number;
  readonly onDispatched?: (record: ContinuationRecord) => void | Promise<void>;
  readonly onAutomaticRoutingSelected?: (
    destination: ContinuationDestination,
  ) => void | Promise<void>;
  readonly onAutomaticRoutingCleared?: () => void | Promise<void>;
  /**
   * How often a parked turn re-checks whether an account has recovered.
   * Defaults to 30s. Injected so tests drive it with a fake clock.
   */
  readonly parkPollMs?: number;
  /**
   * Resolves whether a parked turn may resume yet. Returning a destination
   * resumes on it; returning undefined keeps the turn parked.
   *
   * This is the RESUME PREDICATE, injected rather than computed inside the
   * controller so a test can make the clock and the usage view DISAGREE. A park
   * that resumes merely because a timer fired is the defect; it must resume
   * because an account is genuinely available. Callers are expected to consult
   * live usage here, not a recorded estimate.
   */
  readonly resolveParkedDestination?: (
    nowMs: number,
  ) =>
    | ContinuationDestination
    | undefined
    | Promise<ContinuationDestination | undefined>;
}

/**
 * How long a turn may stay parked before it is abandoned.
 *
 * A park MUST be bounded. Without this the poll re-arms forever: an account that
 * never recovers leaves a timer cycling for the life of the process, and under
 * fake timers it is a literal infinite loop (vitest aborts at 10000 timers).
 * Found by an existing test failing after the park landed, which is exactly the
 * kind of unbounded-retry bug this spec exists to remove -- a park that never
 * gives up is its own silent dead end.
 */
export const PARK_MAX_DURATION_MS = 30 * 60 * 1000;

/** A turn held because no account was available, awaiting genuine recovery. */
interface ParkedTurn {
  readonly failedTurnRef: RuntimeReference;
  readonly abortController: AbortController;
  readonly parkedAtMs: number;
  timer?: unknown;
  resuming: boolean;
}

/**
 * Why a selection was rejected. The two cases warrant opposite responses, so
 * they must never be collapsed into one status.
 *
 * - `unconfigured` — the host's model-selection call returned false because the
 *   destination is absent from its `configuredProviders` snapshot
 *   (agent-session.ts:2403-2407 -> model-runtime.ts:458-460). The destination
 *   cannot serve this snapshot, so exclude it and try another candidate.
 * - `auth-error` — that same call THREW, because `checkAuth` missed
 *   (agent-session.ts:1586-1589). The check is async and network-capable, so
 *   the failure is transient and MUST NOT exclude the destination: the same
 *   account may authenticate on the next attempt.
 *
 * The host call is named indirectly above because test/lifecycle.test.ts scans
 * these modules for that identifier as a substring to prove selection stays
 * confined to the continuation and operator-command paths.
 */
export type SelectionRejection = "unconfigured" | "auth-error";

export type ContinuationStartResult =
  | { readonly status: "scheduled"; readonly record: ContinuationRecord }
  | {
      readonly status: "selection-failed";
      /** Which rejection path fired. Callers branch on this to decide whether to exclude. */
      readonly rejection: SelectionRejection;
      /**
       * True only when the destination should be excluded from further
       * candidate selection FOR THE CURRENT SNAPSHOT. Never session-scoped:
       * `configuredProviders` mutates mid-session (model-runtime.ts:341-363
       * adds on a successful checkAuth and deletes on a failure), so a
       * session-long exclusion would permanently shrink the usable fleet after
       * a single transient blip.
       */
      readonly excludeDestination: boolean;
    }
  | { readonly status: "duplicate" | "cancelled" };

interface Reservation {
  readonly failedTurnRef: RuntimeReference;
  readonly abortController: AbortController;
  active: boolean;
  dispatchStarted: boolean;
  timer?: unknown;
  record?: ContinuationRecord;
}

const defaultScheduler: ContinuationScheduler = {
  set(delayMs, callback) {
    return setTimeout(callback, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Coordinates reactive, post-failure continuation only; it registers no proactive hook. */
export class ContinuationController {
  readonly #state: RuntimeState;
  readonly #diagnostics: DiagnosticLog;
  readonly #setModel: (model: Model<Api>) => Promise<boolean>;
  readonly #dispatchFollowUp: (message: string, signal: AbortSignal) => void | Promise<void>;
  readonly #scheduler: ContinuationScheduler;
  readonly #now: () => number;
  readonly #onDispatched: ((record: ContinuationRecord) => void | Promise<void>) | undefined;
  readonly #onAutomaticRoutingSelected:
    | ((destination: ContinuationDestination) => void | Promise<void>)
    | undefined;
  readonly #onAutomaticRoutingCleared: (() => void | Promise<void>) | undefined;
  readonly #parkPollMs: number;
  readonly #resolveParkedDestination:
    | ((
        nowMs: number,
      ) =>
        | ContinuationDestination
        | undefined
        | Promise<ContinuationDestination | undefined>)
    | undefined;
  /**
   * Parked turns awaiting an account, keyed by the failed turn each resumes.
   *
   * PER-INSTANCE, NEVER PROCESS-GLOBAL. `delegate-session-scope.ts:60-96` makes
   * some foreground handlers no-op under a delegate bind, so a process-global
   * park would leak a parked turn across sessions and forks and resume it in the
   * wrong one. This Map is also deliberately per-process only: no cross-process
   * reservation is added or implied here.
   */
  readonly #parked = new Map<RuntimeReference, ParkedTurn>();
  readonly #reservations = new Map<RuntimeReference, Reservation>();
  readonly #records: ContinuationRecord[] = [];

  constructor(dependencies: ContinuationDependencies) {
    this.#state = dependencies.state;
    this.#diagnostics = dependencies.diagnostics;
    this.#setModel = dependencies.setModel;
    this.#dispatchFollowUp = dependencies.dispatchFollowUp;
    this.#scheduler = dependencies.scheduler ?? defaultScheduler;
    this.#now = dependencies.now ?? Date.now;
    this.#onDispatched = dependencies.onDispatched;
    this.#onAutomaticRoutingSelected = dependencies.onAutomaticRoutingSelected;
    this.#onAutomaticRoutingCleared = dependencies.onAutomaticRoutingCleared;
    this.#parkPollMs = dependencies.parkPollMs ?? 30_000;
    this.#resolveParkedDestination = dependencies.resolveParkedDestination;
  }

  async start(
    failedTurnRef: RuntimeReference,
    destination: ContinuationDestination,
  ): Promise<ContinuationStartResult> {
    if (this.#reservations.has(failedTurnRef)) return { status: "duplicate" };

    // Reservation and state guard are synchronous and precede every await.
    const reservation: Reservation = {
      failedTurnRef,
      abortController: new AbortController(),
      active: true,
      dispatchStarted: false,
    };
    this.#reservations.set(failedTurnRef, reservation);
    try {
      if (destination.model.provider !== destination.providerId) {
        throw new TypeError("continuation destination model/provider mismatch.");
      }
      if (
        destination.logicalRoutePin !== undefined &&
        (destination.family === "openrouter" ||
          destination.model.id !== destination.logicalRoutePin.requestedModelId)
      ) {
        throw new TypeError("logical route pin must name the exact managed destination model.");
      }
      const established = this.#state.establishContinuationGuard({
        failedTurnRef,
        destinationProviderId: destination.providerId,
        destinationFamily: destination.family,
        routingReason: destination.routingReason,
        guardSetAtMs: this.#now(),
      });
      if (!established) {
        this.#reservations.delete(failedTurnRef);
        return { status: "duplicate" };
      }
    } catch (error) {
      this.#reservations.delete(failedTurnRef);
      this.#diagnostics.recordError("continuation.reserve", error);
      // Guard/reservation failure says nothing about the destination's auth, so
      // it must not exclude it.
      return { status: "selection-failed", rejection: "auth-error", excludeDestination: false };
    }

    let selected = false;
    // Distinguishes the two rejection paths. A throw means checkAuth missed and
    // is transient; a false return means the provider is absent from the
    // snapshot. Collapsing them loses the difference that decides exclusion.
    let rejection: SelectionRejection = "unconfigured";
    try {
      if (destination.logicalRoutePin === undefined) {
        // A physical continuation supersedes any older logical one-shot pin. Clear
        // it BEFORE setModel so the stale pin can never be consumed by a later
        // unified dispatch regardless of whether setModel succeeds, returns false,
        // or throws -- leaving at most one continuation intent.
        this.#state.clearLogicalRoutePin();
        selected = (await this.#setModel(destination.model)) === true;
      } else {
        if (destination.family === "openrouter") {
          throw new TypeError("logical route pin cannot target OpenRouter.");
        }
        this.#state.setLogicalRoutePin({
          destinationProviderId: destination.providerId,
          destinationFamily: destination.family,
          requestedModelId: destination.logicalRoutePin.requestedModelId,
        });
        selected = true;
      }
    } catch (error) {
      rejection = "auth-error";
      if (reservation.active) this.#diagnostics.recordError("continuation.set-model", error);
    }

    if (!reservation.active) return { status: "cancelled" };
    if (!selected) {
      this.#releaseFailedSelection(reservation);
      this.#diagnostics.record(
        "info",
        "continuation.selection-failed",
        `Selection rejected for ${destination.providerId} (${rejection}); ` +
          (rejection === "unconfigured"
            ? "excluding it for this snapshot."
            : "retaining it as a candidate because checkAuth failures are transient."),
      );
      return {
        status: "selection-failed",
        rejection,
        // Only a snapshot-membership rejection excludes. An auth error is
        // transient and must leave the destination selectable.
        excludeDestination: rejection === "unconfigured",
      };
    }

    await this.#reportAutomaticRoutingSelected(destination);
    if (!reservation.active) return { status: "cancelled" };

    const record: ContinuationRecord = Object.freeze({
      failedTurnRef,
      continuationTurnRef: this.#state.mintReference(),
      destinationProviderId: destination.providerId,
      destinationFamily: destination.family,
      routingReason: destination.routingReason,
      selectedAtMs: this.#now(),
    });
    reservation.record = record;
    this.#records.push(record);
    try {
      reservation.timer = this.#scheduler.set(0, () => {
        reservation.timer = undefined;
        void this.#dispatchReserved(reservation, record);
      });
    } catch (error) {
      // Selection already succeeded. Fall back to direct dispatch so a broken
      // scheduler cannot turn a confirmed switch into zero continuations.
      this.#diagnostics.recordError("continuation.schedule", error);
      void this.#dispatchReserved(reservation, record);
    }
    return { status: "scheduled", record };
  }

  async #dispatchReserved(reservation: Reservation, record: ContinuationRecord): Promise<void> {
    if (!reservation.active || reservation.dispatchStarted) return;
    reservation.dispatchStarted = true;
    try {
      await this.#dispatchFollowUp(FIXED_CONTINUATION_MESSAGE, reservation.abortController.signal);
      if (reservation.active) await this.#onDispatched?.(record);
    } catch (error) {
      // Keep the guard/reservation after dispatch failure: automatic retry is forbidden.
      // Cancellation suppresses late callback diagnostics after teardown.
      if (reservation.active) this.#diagnostics.recordError("continuation.dispatch", error);
    }
  }

  /**
   * Hold a turn that could not be routed, and re-check on an interval until an
   * account genuinely recovers.
   *
   * REQ-FAILOVER-PARK. This replaces a no-op: the `paused` branch previously
   * recorded a diagnostic and returned, so a turn that hit a fully-exhausted
   * fleet was abandoned with nothing ever re-checking.
   *
   * Returns false when this turn is already parked, so a repeated settlement
   * cannot stack timers on one turn.
   */
  park(failedTurnRef: RuntimeReference): boolean {
    if (this.#parked.has(failedTurnRef)) return false;
    if (this.#resolveParkedDestination === undefined) return false;
    const parked: ParkedTurn = {
      failedTurnRef,
      abortController: new AbortController(),
      parkedAtMs: this.#now(),
      resuming: false,
    };
    this.#parked.set(failedTurnRef, parked);
    this.#armParkPoll(parked);
    return true;
  }

  /** True when this turn is currently parked. Lets callers avoid double-parking. */
  isParked(failedTurnRef: RuntimeReference): boolean {
    return this.#parked.has(failedTurnRef);
  }

  /** Number of turns currently parked, for the operator surface. */
  parkedCount(): number {
    return this.#parked.size;
  }

  /**
   * Discard a parked turn. REQ-FAILOVER-CANCEL: the operator must be able to
   * escape a park, and the announcement that a turn was parked states how.
   */
  cancelParked(failedTurnRef: RuntimeReference): boolean {
    const parked = this.#parked.get(failedTurnRef);
    if (!parked) return false;
    parked.abortController.abort();
    if (parked.timer !== undefined) {
      try {
        this.#scheduler.clear(parked.timer);
      } catch (error) {
        this.#diagnostics.recordError("continuation.park-cancel-timer", error);
      }
      parked.timer = undefined;
    }
    this.#parked.delete(failedTurnRef);
    this.#state.clearContinuationGuard(failedTurnRef);
    this.#reportAutomaticRoutingCleared();
    return true;
  }

  /** Discard every parked turn, used on stop and shutdown. */
  cancelAllParked(): number {
    let cancelled = 0;
    for (const ref of [...this.#parked.keys()]) {
      if (this.cancelParked(ref)) cancelled += 1;
    }
    return cancelled;
  }

  #armParkPoll(parked: ParkedTurn): void {
    // Bounded, deliberately. An account that never recovers must not leave a
    // timer cycling for the life of the process.
    if (this.#now() - parked.parkedAtMs >= PARK_MAX_DURATION_MS) {
      this.#parked.delete(parked.failedTurnRef);
      this.#state.clearContinuationGuard(parked.failedTurnRef);
      this.#reportAutomaticRoutingCleared();
      this.#diagnostics.record(
        "warning",
        "continuation.park-expired",
        "A parked turn was abandoned after no account recovered within the park window.",
      );
      return;
    }
    try {
      parked.timer = this.#scheduler.set(this.#parkPollMs, () => {
        parked.timer = undefined;
        void this.#attemptParkedResume(parked);
      });
    } catch (error) {
      // A broken scheduler must not silently strand the turn forever.
      this.#diagnostics.recordError("continuation.park-schedule", error);
      this.#parked.delete(parked.failedTurnRef);
      this.#reportAutomaticRoutingCleared();
    }
  }

  async #attemptParkedResume(parked: ParkedTurn): Promise<void> {
    if (parked.resuming) return;
    if (!this.#parked.has(parked.failedTurnRef)) return;
    if (parked.abortController.signal.aborted) return;
    const resolve = this.#resolveParkedDestination;
    if (resolve === undefined) return;

    let destination: ContinuationDestination | undefined;
    try {
      destination = await resolve(this.#now());
    } catch (error) {
      this.#diagnostics.recordError("continuation.park-resolve", error);
      destination = undefined;
    }

    // Cancellation may have landed during the await.
    if (parked.abortController.signal.aborted) return;
    if (!this.#parked.has(parked.failedTurnRef)) return;

    if (destination === undefined) {
      // Still nothing available. Re-arm rather than giving up: the whole point
      // of a park is that it outlives one failed check.
      this.#armParkPoll(parked);
      return;
    }

    parked.resuming = true;
    this.#parked.delete(parked.failedTurnRef);
    // Release the park's hold, then resume under a FRESH reference.
    //
    // The original ref cannot be reused: `clearContinuationGuard` retires it, and
    // RuntimeState then rejects it with "failedTurnRef must be minted by this
    // RuntimeState", which surfaced as a silent `selection-failed` -- the resume
    // appeared to run and simply never switched. Minting a new reference is also
    // the honest model: a park that outlived its window resumes as a NEW turn
    // rather than pretending to continue the original request.
    this.#state.clearContinuationGuard(parked.failedTurnRef);
    const resumeRef = this.#state.mintReference();
    try {
      const result = await this.start(resumeRef, destination);
      if (result.status !== "scheduled") {
        this.#reportAutomaticRoutingCleared();
        this.#diagnostics.record(
          "warning",
          "continuation.park-resume-failed",
          `A parked turn could not resume on ${destination.providerId} (${result.status}).`,
        );
      }
    } catch (error) {
      this.#reportAutomaticRoutingCleared();
      this.#diagnostics.recordError("continuation.park-resume", error);
    }
  }

  #releaseFailedSelection(reservation: Reservation): void {
    reservation.active = false;
    reservation.abortController.abort();
    this.#reservations.delete(reservation.failedTurnRef);
    this.#state.clearContinuationGuard(reservation.failedTurnRef);
  }

  cancelFailedTurn(failedTurnRef: RuntimeReference): boolean {
    const reservation = this.#reservations.get(failedTurnRef);
    if (!reservation) return false;
    reservation.active = false;
    reservation.abortController.abort();
    if (reservation.timer !== undefined) {
      try {
        this.#scheduler.clear(reservation.timer);
      } catch (error) {
        this.#diagnostics.recordError("continuation.cancel-timer", error);
      }
    }
    this.#reservations.delete(failedTurnRef);
    try {
      this.#state.clearContinuationGuard(failedTurnRef);
      if (reservation.record) this.#state.clearWatchdog(reservation.record.continuationTurnRef);
    } catch (error) {
      this.#diagnostics.recordError("continuation.cancel", error);
    }
    this.#reportAutomaticRoutingCleared();
    return true;
  }

  cancelAll(): void {
    // REQ-FAILOVER-CANCEL. Parked turns are cancelled here rather than through a
    // new subcommand, so the existing `/multi-account stop` -- which the park
    // announcement tells the operator to run -- is the single escape hatch.
    this.cancelAllParked();
    for (const reservation of this.#reservations.values()) {
      reservation.active = false;
      reservation.abortController.abort();
      if (reservation.timer !== undefined) {
        try {
          this.#scheduler.clear(reservation.timer);
        } catch (error) {
          this.#diagnostics.recordError("continuation.cancel-timer", error);
        }
      }
    }
    this.#reservations.clear();
    this.#state.clearPendingActivity();
    this.#reportAutomaticRoutingCleared();
  }

  async #reportAutomaticRoutingSelected(
    destination: ContinuationDestination,
  ): Promise<void> {
    try {
      await this.#onAutomaticRoutingSelected?.(destination);
    } catch {
      this.#diagnostics.record(
        "warning",
        "continuation.route-callback",
        "Automatic route selection bookkeeping failed safely.",
      );
    }
  }

  #reportAutomaticRoutingCleared(): void {
    try {
      const pending = this.#onAutomaticRoutingCleared?.();
      if (pending !== undefined) {
        void Promise.resolve(pending).catch(() => {
          this.#diagnostics.record(
            "warning",
            "continuation.route-callback",
            "Automatic route cleanup bookkeeping failed safely.",
          );
        });
      }
    } catch {
      this.#diagnostics.record(
        "warning",
        "continuation.route-callback",
        "Automatic route cleanup bookkeeping failed safely.",
      );
    }
  }

  records(): readonly ContinuationRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  pendingCount(): number {
    return this.#reservations.size;
  }
}
