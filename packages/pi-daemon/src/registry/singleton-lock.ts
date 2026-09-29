import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { dirname } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECLAIM_RETRY_MS = 2;

export interface SingletonLockRecord {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly daemonInstanceId: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly createdAt: string;
}

export interface SingletonLock {
  readonly path: string;
  readonly record: SingletonLockRecord;
  assertHeld(): void;
  release(): void;
}

export class SingletonLockContendedError extends Error {
  readonly code = "EEXIST";
  readonly owner: SingletonLockRecord;

  constructor(lockPath: string, owner: SingletonLockRecord) {
    super(`daemon singleton lock is held: ${lockPath}`);
    this.name = "SingletonLockContendedError";
    this.owner = owner;
  }
}

interface InspectedLock {
  readonly record: SingletonLockRecord;
  readonly stat: Stats;
}

function effectiveUserId(): number {
  if (process.geteuid === undefined) {
    throw new Error("pi-daemon private paths require an effective user ID");
  }
  return process.geteuid();
}

function modeOf(stat: Stats): number {
  return stat.mode & 0o777;
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`private state path is not a directory: ${path}`);
  }
  if (stat.uid !== effectiveUserId()) {
    throw new Error(`private state directory is not owned by the effective user: ${path}`);
  }
  if (modeOf(stat) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`private state directory mode is not 0700: ${path}`);
  }
}

function assertPrivateFile(path: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw new Error(`private file path is not a regular file: ${path}`);
  }
  if (stat.uid !== effectiveUserId()) {
    throw new Error(`private file is not owned by the effective user: ${path}`);
  }
  if (modeOf(stat) !== PRIVATE_FILE_MODE) {
    throw new Error(`private file mode is not 0600: ${path}`);
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function errorHasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`singleton lock ${field} must be a positive safe integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`singleton lock ${field} must be a non-empty string`);
  }
  return value;
}

function parseLockRecord(value: unknown): SingletonLockRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("singleton lock record must be an object");
  }
  const input = value as Record<string, unknown>;
  const expectedFields = [
    "pid",
    "processStartIdentity",
    "daemonInstanceId",
    "stateDir",
    "socketPath",
    "createdAt",
  ];
  if (
    Object.keys(input).length !== expectedFields.length ||
    expectedFields.some((field) => !(field in input))
  ) {
    throw new Error("singleton lock record has unexpected fields");
  }
  return {
    pid: positiveInteger(input.pid, "pid"),
    processStartIdentity: nonEmptyString(
      input.processStartIdentity,
      "processStartIdentity",
    ),
    daemonInstanceId: nonEmptyString(input.daemonInstanceId, "daemonInstanceId"),
    stateDir: nonEmptyString(input.stateDir, "stateDir"),
    socketPath: nonEmptyString(input.socketPath, "socketPath"),
    createdAt: nonEmptyString(input.createdAt, "createdAt"),
  };
}

function inspectLock(lockPath: string): InspectedLock {
  const descriptor = openSync(lockPath, "r");
  try {
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(lockPath);
    assertPrivateFile(lockPath, descriptorStat);
    if (!sameFile(descriptorStat, pathStat)) {
      throw new Error(`singleton lock path changed during inspection: ${lockPath}`);
    }
    const encoded = readFileSync(descriptor, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      throw new Error(`singleton lock record is not valid JSON: ${lockPath}`);
    }
    return { record: parseLockRecord(decoded), stat: descriptorStat };
  } finally {
    closeSync(descriptor);
  }
}

function processStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return undefined;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    return startTime === undefined ? undefined : `linux-proc-start:${startTime}`;
  } catch (error) {
    if (errorHasCode(error, "ENOENT") || errorHasCode(error, "ESRCH")) return undefined;
    throw error;
  }
}

export function getProcessStartIdentity(pid = process.pid): string {
  positiveInteger(pid, "pid");
  const identity = processStartIdentity(pid);
  if (identity === undefined) {
    throw new Error(`cannot read process start identity for pid ${pid}`);
  }
  return identity;
}

// The stale instance identity comes from the mode-0600 lock inside the mode-0700 state
// directory, so users outside the daemon's filesystem trust boundary cannot pre-bind it.
function reclaimMutexAddress(lockPath: string, staleOwner: SingletonLockRecord): string {
  const digest = createHash("sha256")
    .update(lockPath)
    .update("\0")
    .update(staleOwner.daemonInstanceId)
    .update("\0")
    .update(staleOwner.processStartIdentity)
    .digest("hex");
  return `\0pi-daemon-reclaim-${digest}`;
}

function acquireReclaimMutex(
  lockPath: string,
  staleOwner: SingletonLockRecord,
): Promise<NetServer | undefined> {
  return new Promise((resolveMutex, rejectMutex) => {
    const server = createNetServer((socket) => socket.destroy());
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === "EADDRINUSE") {
        resolveMutex(undefined);
        return;
      }
      rejectMutex(error);
    };
    const onListening = () => {
      cleanup();
      resolveMutex(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(reclaimMutexAddress(lockPath, staleOwner));
  });
}

function closeReclaimMutex(server: NetServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      rejectProbe(new Error(`timed out probing singleton socket: ${socketPath}`));
    }, 250);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners("connect");
      socket.removeAllListeners("error");
    };
    socket.once("connect", () => {
      cleanup();
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        resolveProbe(false);
        return;
      }
      rejectProbe(error);
    });
  });
}

export function ensurePrivateStateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = lstatSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`private state path is not a directory: ${path}`);
  }
  if (stat.uid !== effectiveUserId()) {
    throw new Error(`private state directory is not owned by the effective user: ${path}`);
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  assertPrivateDirectory(path);
}

export async function acquireSingletonLockWithRecovery(
  lockPath: string,
  record: SingletonLockRecord,
): Promise<SingletonLock> {
  for (;;) {
    try {
      return acquireSingletonLock(lockPath, record);
    } catch (error) {
      if (!errorHasCode(error, "EEXIST")) throw error;
    }

    let inspected: InspectedLock;
    try {
      inspected = inspectLock(lockPath);
    } catch (error) {
      if (errorHasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (inspected.record.stateDir !== record.stateDir) {
      throw new Error(`singleton lock record does not match configured state directory: ${lockPath}`);
    }

    if (
      processStartIdentity(inspected.record.pid) === inspected.record.processStartIdentity ||
      (await socketAcceptsConnections(inspected.record.socketPath))
    ) {
      throw new SingletonLockContendedError(lockPath, inspected.record);
    }

    // Linux abstract Unix sockets are kernel-owned and disappear if a reclaimer dies.
    // They serialize the inode check/unlink/acquire section without another stale file.
    const reclaimMutex = await acquireReclaimMutex(lockPath, inspected.record);
    if (reclaimMutex === undefined) {
      await delay(RECLAIM_RETRY_MS);
      continue;
    }
    try {
      let current: Stats;
      try {
        current = lstatSync(lockPath);
      } catch (error) {
        if (errorHasCode(error, "ENOENT")) continue;
        throw error;
      }
      if (!sameFile(inspected.stat, current)) continue;
      unlinkSync(lockPath);
      try {
        return acquireSingletonLock(lockPath, record);
      } catch (error) {
        if (!errorHasCode(error, "EEXIST")) throw error;
      }
    } finally {
      await closeReclaimMutex(reclaimMutex);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function acquireSingletonLock(
  lockPath: string,
  record: SingletonLockRecord,
): SingletonLock {
  ensurePrivateStateDirectory(dirname(lockPath));
  const candidatePath = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(candidatePath, "wx", PRIVATE_FILE_MODE);
  let released = false;

  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    const descriptorStat = fstatSync(descriptor);
    const candidateStat = lstatSync(candidatePath);
    assertPrivateFile(candidatePath, descriptorStat);
    if (!sameFile(descriptorStat, candidateStat)) {
      throw new Error(`singleton lock candidate changed during acquisition: ${candidatePath}`);
    }

    // Publishing by hard link makes the complete record and ownership visible atomically.
    linkSync(candidatePath, lockPath);
    const pathStat = lstatSync(lockPath);
    if (!sameFile(descriptorStat, pathStat)) {
      throw new Error(`singleton lock path changed during acquisition: ${lockPath}`);
    }
    unlinkSync(candidatePath);
  } catch (error) {
    try {
      const descriptorStat = fstatSync(descriptor);
      for (const ownedPath of [lockPath, candidatePath]) {
        try {
          const pathStat = lstatSync(ownedPath);
          if (sameFile(descriptorStat, pathStat)) unlinkSync(ownedPath);
        } catch (cleanupError) {
          if (!errorHasCode(cleanupError, "ENOENT")) throw cleanupError;
        }
      }
    } catch {
      // The failing acquisition no longer owns either path.
    }
    closeSync(descriptor);
    throw error;
  }

  return {
    path: lockPath,
    record,
    assertHeld(): void {
      if (released) {
        throw new Error(`singleton lock is not held: ${lockPath}`);
      }
      const descriptorStat = fstatSync(descriptor);
      let pathStat: Stats;
      try {
        pathStat = lstatSync(lockPath);
      } catch {
        throw new Error(`singleton lock path changed: ${lockPath}`);
      }
      if (!sameFile(descriptorStat, pathStat)) {
        throw new Error(`singleton lock path changed: ${lockPath}`);
      }
      assertPrivateFile(lockPath, descriptorStat);
    },
    release(): void {
      if (released) {
        return;
      }
      const descriptorStat = fstatSync(descriptor);
      let pathStat: Stats | undefined;
      try {
        pathStat = lstatSync(lockPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      if (pathStat !== undefined && sameFile(descriptorStat, pathStat)) {
        unlinkSync(lockPath);
      }
      closeSync(descriptor);
      released = true;
    },
  };
}
