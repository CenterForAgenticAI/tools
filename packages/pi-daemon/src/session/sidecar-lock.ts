import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { canonicalizeSessionFilePath } from "../registry/index.js";
import { SessionOperationError } from "./errors.js";

const PRIVATE_FILE_MODE = 0o600;

export interface SessionFileLock {
  readonly sessionFile: string;
  readonly lockPath: string;
  assertHeld(): void;
  release(): void;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  try {
    const before = lstatSync(lockPath);
    if (
      !before.isFile() ||
      (process.geteuid !== undefined && before.uid !== process.geteuid())
    ) {
      return false;
    }
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as {
      readonly pid?: unknown;
    };
    if (
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      isProcessAlive(value.pid)
    ) {
      return false;
    }
    const after = lstatSync(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function openLockFile(lockPath: string, sessionFile: string): number {
  try {
    return openSync(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (reclaimStaleLock(lockPath)) {
      try {
        return openSync(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          PRIVATE_FILE_MODE,
        );
      } catch (retryError) {
        if (errorCode(retryError) !== "EEXIST") throw retryError;
      }
    }
    throw new SessionOperationError(
      "session_locked",
      `session file is already locked: ${sessionFile}`,
    );
  }
}

export function sessionFileLockPath(sessionFile: string): string {
  return `${canonicalizeSessionFilePath(sessionFile)}.pi-daemon.lock`;
}

export function acquireSessionFileLock(sessionFile: string): SessionFileLock {
  const canonicalSessionFile = canonicalizeSessionFilePath(sessionFile);
  const lockPath = `${canonicalSessionFile}.pi-daemon.lock`;
  const descriptor = openLockFile(lockPath, canonicalSessionFile);
  let released = false;
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile()) {
      throw new Error(`session lock is not a regular file: ${lockPath}`);
    }
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
    );
    const lockDevice = descriptorStat.dev;
    const lockInode = descriptorStat.ino;

    const assertHeld = (): void => {
      if (released) {
        throw new Error(`session lock is not held: ${lockPath}`);
      }
      const pathStat = lstatSync(lockPath);
      const heldStat = fstatSync(descriptor);
      if (
        !pathStat.isFile() ||
        pathStat.dev !== lockDevice ||
        pathStat.ino !== lockInode ||
        heldStat.dev !== lockDevice ||
        heldStat.ino !== lockInode
      ) {
        throw new Error(`session lock ownership changed: ${lockPath}`);
      }
    };

    return {
      sessionFile: canonicalSessionFile,
      lockPath,
      assertHeld,
      release(): void {
        if (released) return;
        try {
          const pathStat = lstatSync(lockPath);
          if (pathStat.dev === lockDevice && pathStat.ino === lockInode) {
            unlinkSync(lockPath);
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            (error as NodeJS.ErrnoException).code !== "ENOENT"
          ) {
            throw error;
          }
        } finally {
          closeSync(descriptor);
          released = true;
        }
      },
    };
  } catch (error) {
    try {
      const descriptorStat = fstatSync(descriptor);
      const pathStat = lstatSync(lockPath);
      if (
        descriptorStat.dev === pathStat.dev &&
        descriptorStat.ino === pathStat.ino
      ) {
        unlinkSync(lockPath);
      }
    } catch {
      // The failing acquisition no longer owns the lock path.
    }
    closeSync(descriptor);
    throw error;
  }
}
