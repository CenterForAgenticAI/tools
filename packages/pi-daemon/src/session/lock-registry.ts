import { canonicalizeSessionFilePath } from "../registry/index.js";
import {
  acquireSessionFileLock,
  type SessionFileLock,
} from "./sidecar-lock.js";

interface HeldSessionLock {
  readonly lock: SessionFileLock;
  readonly underlying: SessionFileLock;
  sessionId: string | undefined;
  released: boolean;
}

/** Owns session-file sidecar locks for the lifetime of this daemon process. */
export class SessionLockRegistry {
  readonly #bySessionFile = new Map<string, HeldSessionLock>();
  readonly #sessionFileById = new Map<string, string>();

  acquire(sessionFile: string, sessionId?: string): SessionFileLock {
    const canonicalSessionFile = canonicalizeSessionFilePath(sessionFile);
    const existing = this.#bySessionFile.get(canonicalSessionFile);
    if (existing !== undefined) {
      existing.lock.assertHeld();
      if (sessionId !== undefined) this.bindSession(existing, sessionId);
      return existing.lock;
    }

    const acquired = acquireSessionFileLock(canonicalSessionFile);
    const held: HeldSessionLock = {
      lock: {
        sessionFile: acquired.sessionFile,
        lockPath: acquired.lockPath,
        assertHeld: () => acquired.assertHeld(),
        release: () => this.releaseHeld(held),
      },
      underlying: acquired,
      sessionId: undefined,
      released: false,
    };
    this.#bySessionFile.set(canonicalSessionFile, held);

    try {
      if (sessionId !== undefined) this.bindSession(held, sessionId);
      return held.lock;
    } catch (error) {
      held.lock.release();
      throw error;
    }
  }

  getBySessionFile(sessionFile: string): SessionFileLock | undefined {
    return this.#bySessionFile.get(canonicalizeSessionFilePath(sessionFile))?.lock;
  }

  getBySessionId(sessionId: string): SessionFileLock | undefined {
    const sessionFile = this.#sessionFileById.get(sessionId);
    return sessionFile === undefined ? undefined : this.#bySessionFile.get(sessionFile)?.lock;
  }

  releaseBySessionFile(sessionFile: string): void {
    this.#bySessionFile
      .get(canonicalizeSessionFilePath(sessionFile))
      ?.lock.release();
  }

  releaseBySessionId(sessionId: string): void {
    const lock = this.getBySessionId(sessionId);
    lock?.release();
  }

  dispose(): void {
    for (const { lock } of [...this.#bySessionFile.values()]) lock.release();
  }

  private bindSession(held: HeldSessionLock, sessionId: string): void {
    const sessionFile = held.lock.sessionFile;
    const existingSessionFile = this.#sessionFileById.get(sessionId);
    if (existingSessionFile !== undefined && existingSessionFile !== sessionFile) {
      throw new Error(
        `session lock is already registered at another path: ${sessionId}`,
      );
    }
    if (held.sessionId !== undefined && held.sessionId !== sessionId) {
      throw new Error(
        `session file lock is already registered to another session: ${sessionFile}`,
      );
    }
    held.sessionId = sessionId;
    this.#sessionFileById.set(sessionId, sessionFile);
  }

  private releaseHeld(held: HeldSessionLock): void {
    if (held.released) return;
    held.released = true;
    const sessionId = held.sessionId;
    if (
      sessionId !== undefined &&
      this.#sessionFileById.get(sessionId) === held.lock.sessionFile
    ) {
      this.#sessionFileById.delete(sessionId);
    }
    if (this.#bySessionFile.get(held.lock.sessionFile) === held) {
      this.#bySessionFile.delete(held.lock.sessionFile);
    }
    held.underlying.release();
  }
}
