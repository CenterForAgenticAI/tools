import { basename, dirname } from "node:path";
import { watch, type FSWatcher } from "node:fs";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import type { Registry } from "../registry/index.js";
import type { SessionFileLock } from "../session/index.js";
import type { HostExternalWriterFrame } from "./session-host.js";
import { HostQueue } from "./host-queue.js";
import {
  readSessionFileState,
  sessionFileStateEquals,
  type SessionFileState,
} from "./file-signature.js";

export class ExternalWriterError extends Error {
  readonly code = "external_writer" as const;

  constructor(sessionId: string, cause?: unknown) {
    super(`external_writer: session file ownership changed: ${sessionId}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "ExternalWriterError";
  }
}

export interface ExternalWriterMonitorOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly sessionFile: string;
  readonly lock: SessionFileLock;
  readonly queue: HostQueue;
  readonly registry: Registry;
  readonly initialExpected?: SessionFileState;
  readonly emit: (frame: HostExternalWriterFrame) => void;
  readonly onDetected: () => void;
}

export class ExternalWriterMonitor {
  readonly sessionId: string;
  generation: number;
  readonly epoch: number;
  readonly #registry: Registry;
  readonly #emit: ExternalWriterMonitorOptions["emit"];
  readonly #onDetected: ExternalWriterMonitorOptions["onDetected"];
  #sessionFile: string;
  #lock: SessionFileLock;
  #queue: HostQueue;
  #expected: SessionFileState;
  #watcher: FSWatcher | undefined;
  #gateOpen = true;
  #released = false;
  #failure: ExternalWriterError | undefined;

  constructor(options: ExternalWriterMonitorOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.epoch = options.epoch;
    this.#registry = options.registry;
    this.#emit = options.emit;
    this.#onDetected = options.onDetected;
    this.#sessionFile = options.sessionFile;
    this.#lock = options.lock;
    this.#queue = options.queue;
    this.#lock.assertHeld();
    const initialExpected = options.initialExpected;
    this.#expected =
      initialExpected === undefined
        ? readSessionFileState(this.#sessionFile)
        : {
            signature: { ...initialExpected.signature },
            branchEntryIds: [...initialExpected.branchEntryIds],
          };
    this.startWatcher();
  }

  get sessionFile(): string {
    return this.#sessionFile;
  }

  get failure(): ExternalWriterError | undefined {
    return this.#failure;
  }

  useQueue(queue: HostQueue, generation = this.generation): void {
    this.#queue = queue;
    this.generation = generation;
  }

  verify(): void {
    this.assertGateOpen();
    try {
      this.#lock.assertHeld();
      const actual = readSessionFileState(this.#sessionFile);
      if (!sessionFileStateEquals(actual, this.#expected)) {
        throw new Error(`unaccounted session file change: ${this.#sessionFile}`);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  bindManager(manager: SessionManager): () => void {
    const originalPersist = manager._persist.bind(manager);
    const wrappedPersist: SessionManager["_persist"] = (entry) => {
      this.verify();
      originalPersist(entry);
      try {
        this.#lock.assertHeld();
        this.#expected = readSessionFileState(this.#sessionFile);
      } catch (error) {
        this.fail(error);
      }
    };
    manager._persist = wrappedPersist;
    return () => {
      if (manager._persist === wrappedPersist) manager._persist = originalPersist;
    };
  }

  retarget(sessionFile: string, lock: SessionFileLock): void {
    this.assertGateOpen();
    lock.assertHeld();
    const expected = readSessionFileState(sessionFile);
    this.#watcher?.close();
    this.#lock.release();
    this.#sessionFile = sessionFile;
    this.#lock = lock;
    this.#expected = expected;
    this.startWatcher();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#lock.release();
  }

  private assertGateOpen(): void {
    if (this.#gateOpen) return;
    throw this.#failure ?? new ExternalWriterError(this.sessionId);
  }

  private fail(cause: unknown): never {
    if (!this.#gateOpen) this.assertGateOpen();

    // Fence persistence before projecting or publishing the failure.
    this.#gateOpen = false;
    this.#failure = new ExternalWriterError(this.sessionId, cause);
    const failed = this.#registry.markSessionExternalWriter(this.sessionId, Date.now());
    try {
      this.#emit({
        session: this.sessionId,
        kind: "daemon",
        generation: this.generation,
        epoch: failed.epoch,
        name: "external_writer",
        data: {},
      });
    } catch {
      // A frame consumer cannot reopen the persistence gate or retain ownership.
    }
    try {
      this.#onDetected();
    } finally {
      this.release();
    }
    throw this.#failure;
  }

  private startWatcher(): void {
    const watchedName = basename(this.#sessionFile);
    this.#watcher = watch(
      dirname(this.#sessionFile),
      { persistent: false },
      (_eventType, filename) => {
        if (filename !== null && String(filename) !== watchedName) return;
        void this.#queue.enqueue(() => this.verify()).catch(() => undefined);
      },
    );
  }
}
