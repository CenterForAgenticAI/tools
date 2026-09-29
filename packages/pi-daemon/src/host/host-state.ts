import type { CustomEntryData, JsonObject } from "../protocol/index.js";
import {
  SessionStateMachine,
  type SessionStateChange,
  type SessionStateSignal,
  type SessionStateSnapshot,
} from "../state/index.js";

export interface HostStatePublication {
  readonly state: SessionStateSnapshot;
  readonly reason: SessionStateSignal["type"];
}

export interface HostStateDaemonFrame {
  readonly session: string;
  readonly kind: "daemon";
  readonly generation: number;
  readonly epoch: number;
  readonly name: "phase" | "attention";
  readonly data: JsonObject;
  readonly sourceEntryId: string;
}

interface HostStateCoordinatorOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly machine: SessionStateMachine;
  readonly now: () => Date;
  readonly persistTransition: (
    data: CustomEntryData<"pi-daemon/phase">,
  ) => Promise<string>;
  readonly updateIndex: (state: SessionStateSnapshot) => void;
}

function transitionData(
  change: SessionStateChange,
  generation: number,
  epoch: number,
  at: string,
): CustomEntryData<"pi-daemon/phase"> {
  return {
    v: 1,
    from: change.before.phase,
    to: change.after.phase,
    attention: change.after.attention,
    pendingQuestionIds: [...change.after.pendingQuestionIds],
    reason: change.reason,
    generation,
    epoch,
    at,
  };
}

function frameData(change: SessionStateChange): JsonObject {
  return {
    runtime: change.after.runtime,
    phase: change.after.phase,
    observedPhase: change.after.observedPhase,
    attention: change.after.attention,
    pendingQuestionIds: [...change.after.pendingQuestionIds],
    reason: change.reason,
  };
}

export class HostStateCoordinator {
  readonly #sessionId: string;
  readonly #generation: number;
  readonly #epoch: number;
  readonly #machine: SessionStateMachine;
  readonly #now: () => Date;
  readonly #persistTransition: HostStateCoordinatorOptions["persistTransition"];
  readonly #updateIndex: HostStateCoordinatorOptions["updateIndex"];
  readonly #stateSubscribers = new Set<(publication: HostStatePublication) => void>();
  readonly #frameSubscribers = new Set<(frame: HostStateDaemonFrame) => void>();
  #failure: unknown;
  #closed = false;

  constructor(options: HostStateCoordinatorOptions) {
    this.#sessionId = options.sessionId;
    this.#generation = options.generation;
    this.#epoch = options.epoch;
    this.#machine = options.machine;
    this.#now = options.now;
    this.#persistTransition = options.persistTransition;
    this.#updateIndex = options.updateIndex;
  }

  get current(): SessionStateSnapshot {
    return this.#machine.current;
  }

  assertHealthy(): void {
    if (this.#failure !== undefined) {
      throw new Error("host state persistence failed", { cause: this.#failure });
    }
  }

  async apply(signal: SessionStateSignal): Promise<void> {
    if (this.#closed || this.#failure !== undefined) return;
    const change = this.#machine.apply(signal);
    if (change === undefined) return;
    try {
      if (!change.durableTransition) {
        this.#updateIndex(change.after);
        this.publishState({ state: change.after, reason: change.reason });
        return;
      }
      const sourceEntryId = await this.#persistTransition(
        transitionData(change, this.#generation, this.#epoch, this.#now().toISOString()),
      );
      this.#updateIndex(change.after);
      this.publishState({ state: change.after, reason: change.reason });
      const data = frameData(change);
      if (change.before.phase !== change.after.phase) {
        this.publishFrame({
          session: this.#sessionId,
          kind: "daemon",
          generation: this.#generation,
          epoch: this.#epoch,
          name: "phase",
          data,
          sourceEntryId,
        });
      }
      if (change.before.attention !== change.after.attention) {
        this.publishFrame({
          session: this.#sessionId,
          kind: "daemon",
          generation: this.#generation,
          epoch: this.#epoch,
          name: "attention",
          data,
          sourceEntryId,
        });
      }
    } catch (error) {
      if (this.#failure !== undefined) return;
      this.#failure = error;
      const failed = this.#machine.apply({ type: "fatal_failure", failed: true });
      if (failed !== undefined) {
        try {
          this.#updateIndex(failed.after);
        } catch {
          // The original persistence failure remains the host fence.
        }
        this.publishState({ state: failed.after, reason: failed.reason });
      }
    }
  }

  subscribeState(listener: (publication: HostStatePublication) => void): () => void {
    this.#stateSubscribers.add(listener);
    return () => this.#stateSubscribers.delete(listener);
  }

  subscribeFrames(listener: (frame: HostStateDaemonFrame) => void): () => void {
    this.#frameSubscribers.add(listener);
    return () => this.#frameSubscribers.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#stateSubscribers.clear();
    this.#frameSubscribers.clear();
  }

  private publishState(publication: HostStatePublication): void {
    for (const subscriber of this.#stateSubscribers) {
      try {
        subscriber(publication);
      } catch {
        // Observation cannot change serialized host state.
      }
    }
  }

  private publishFrame(frame: HostStateDaemonFrame): void {
    for (const subscriber of this.#frameSubscribers) {
      try {
        subscriber(frame);
      } catch {
        // A transport subscriber cannot change a committed transition.
      }
    }
  }
}
