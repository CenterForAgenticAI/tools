import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { accessSync, realpathSync, statSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { OperationParams, OperationResult } from "../protocol/index.js";
import {
  Registry,
  RegistryError,
  canonicalizeSessionFilePath,
  projectSessionFile,
  type SessionRecord,
} from "../registry/index.js";
import { SessionOperationError } from "./errors.js";
import { SessionLockRegistry } from "./lock-registry.js";
import { projectSessionSummary } from "./projection.js";

function canonicalizeEnvironmentPath(value: unknown, field: string, directory: boolean): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new SessionOperationError("invalid_request", `${field} must be an absolute path`);
  }
  try {
    const canonical = realpathSync(value);
    const stat = statSync(canonical);
    if ((directory && !stat.isDirectory()) || (!directory && !stat.isFile())) throw new Error("wrong type");
    accessSync(canonical, fsConstants.R_OK);
    return canonical;
  } catch {
    throw new SessionOperationError("invalid_request", `${field} must be an existing readable ${directory ? "directory" : "file"}`);
  }
}

function canonicalizeEnvironment(params: OperationParams<"create">) {
  return {
    agentDir: params.agentDir === undefined ? undefined : canonicalizeEnvironmentPath(params.agentDir, "agentDir", true),
    additionalExtensionPaths: params.additionalExtensionPaths?.map((path, index) =>
      canonicalizeEnvironmentPath(path, `additionalExtensionPaths[${index}]`, false),
    ) ?? [],
  };
}

export interface ColdSessionOperationsOptions {
  readonly registry: Registry;
  readonly lockRegistry?: SessionLockRegistry;
  readonly sessionDir?: string;
  readonly agentDir?: string;
  readonly now?: () => number;
}

function canonicalizeDirectory(path: string): string {
  return realpathSync(resolve(path));
}

interface FileSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNanoseconds: bigint;
}

function snapshotSessionFile(sessionFile: string): FileSnapshot {
  const stat = statSync(sessionFile, { bigint: true });
  if (!stat.isFile()) {
    throw new SessionOperationError(
      "path_mismatch",
      `session path is not a regular file: ${sessionFile}`,
    );
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNanoseconds: stat.mtimeNs,
  };
}

function assertStableSnapshot(
  before: FileSnapshot,
  after: FileSnapshot,
  sessionFile: string,
): void {
  if (
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.size !== after.size ||
    before.modifiedAtNanoseconds !== after.modifiedAtNanoseconds
  ) {
    throw new SessionOperationError(
      "session_locked",
      `session file changed during registration: ${sessionFile}`,
    );
  }
}

function assertSameCreateRequest(
  session: SessionRecord,
  params: OperationParams<"create">,
  cwd: string,
): void {
  if (
    session.cwd !== cwd ||
    (params.name !== undefined && session.name !== params.name) ||
    (params.sleepAfterMs !== undefined &&
      session.sleepAfterMs !== params.sleepAfterMs) ||
    (params.agentDir !== undefined &&
      session.agentDir !== canonicalizeEnvironmentPath(params.agentDir, "agentDir", true)) ||
    (params.additionalExtensionPaths !== undefined &&
      JSON.stringify(session.additionalExtensionPaths) !== JSON.stringify(params.additionalExtensionPaths.map((path, index) =>
        canonicalizeEnvironmentPath(path, `additionalExtensionPaths[${index}]`, false),
      ))) ||
    (params.environment !== undefined && !isDeepStrictEqual(session.environment, params.environment))
  ) {
    throw new SessionOperationError(
      "duplicate_session",
      `session ID is already registered with different create parameters: ${session.sessionId}`,
    );
  }
}

function assertSameOpenRequest(
  session: SessionRecord,
  params: OperationParams<"open">,
): void {
  if (
    (params.name !== undefined && session.name !== params.name) ||
    (params.cwdOverride !== undefined &&
      session.cwd !== canonicalizeDirectory(params.cwdOverride))
  ) {
    throw new SessionOperationError(
      "path_mismatch",
      `session is already registered with different open parameters: ${session.sessionId}`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class ColdSessionOperations {
  readonly #registry: Registry;
  readonly #lockRegistry: SessionLockRegistry;
  readonly #sessionDir: string | undefined;
  readonly #agentDir: string;
  readonly #now: () => number;

  constructor(options: ColdSessionOperationsOptions) {
    this.#registry = options.registry;
    this.#lockRegistry = options.lockRegistry ?? new SessionLockRegistry();
    this.#sessionDir =
      options.sessionDir === undefined
        ? undefined
        : canonicalizeDirectory(options.sessionDir);
    this.#agentDir = options.agentDir ?? "";
    this.#now = options.now ?? Date.now;
  }

  create(params: OperationParams<"create">): OperationResult<"create"> {
    const cwd = canonicalizeDirectory(params.cwd);
    const environment = canonicalizeEnvironment(params);
    const sessionId = params.sessionId ?? randomUUID();
    const existing = this.#registry.getSession(sessionId);

    if (existing !== undefined) {
      assertSameCreateRequest(existing, params, cwd);
      if (existing.fileMaterialized) {
        this.openRegistered(existing, { sessionId: existing.sessionId });
      } else {
        this.retainLock(existing.sessionFile, existing.sessionId);
      }
      return { session: projectSessionSummary(existing), created: true };
    }

    const manager = SessionManager.create(cwd, this.#sessionDir, { id: sessionId });
    manager.appendCustomEntry("pi-daemon/environment", {
      v: 1,
      agentDir: environment.agentDir ?? this.#agentDir,
      additionalExtensionPaths: [...environment.additionalExtensionPaths],
      ...(params.environment === undefined ? {} : { environment: params.environment }),
    });
    const plannedPath = manager.getSessionFile();
    if (manager.getSessionId() !== sessionId || plannedPath === undefined) {
      throw new SessionOperationError(
        "sdk_incompatible",
        "SessionManager.create() did not preserve the requested identity",
      );
    }

    const sessionFile = canonicalizeSessionFilePath(plannedPath);
    const lock = this.#lockRegistry.acquire(sessionFile, sessionId);
    try {
      const reservation = this.#registry.reserveSession({
        sessionId,
        sessionFile,
        cwd,
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.sleepAfterMs === undefined
          ? {}
          : { sleepAfterMs: params.sleepAfterMs }),
        agentDir: environment.agentDir ?? this.#agentDir,
        additionalExtensionPaths: environment.additionalExtensionPaths,
        ...(params.environment === undefined ? {} : { environment: params.environment }),
        nowMs: this.#now(),
      });
      if (
        reservation.session.sessionId !== sessionId ||
        reservation.session.sessionFile !== sessionFile
      ) {
        throw new SessionOperationError(
          "duplicate_session",
          "session ID or path is already registered to another identity",
        );
      }
      if (reservation.status === "existing") {
        assertSameCreateRequest(reservation.session, params, cwd);
      }
      return {
        session: projectSessionSummary(reservation.session),
        created: true,
      };
    } catch (error) {
      lock.release();
      if (error instanceof RegistryError && error.code === "duplicate_session") {
        throw new SessionOperationError(error.code, error.message);
      }
      throw error;
    }
  }

  open(params: OperationParams<"open">): OperationResult<"open"> {
    if ("sessionId" in params) {
      const existing = this.#registry.getSession(params.sessionId);
      if (existing === undefined) {
        throw new SessionOperationError(
          "unknown_session",
          `unknown session: ${params.sessionId}`,
        );
      }
      return this.openRegistered(existing, params);
    }

    let sessionFile: string;
    try {
      sessionFile = canonicalizeSessionFilePath(resolve(params.path));
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new SessionOperationError(
          "gone",
          `session path does not exist: ${resolve(params.path)}`,
        );
      }
      throw error;
    }

    const existing = this.#registry.getSessionByFile(sessionFile);
    if (existing !== undefined) {
      return this.openRegistered(existing, params);
    }

    const lock = this.#lockRegistry.acquire(sessionFile);
    try {
      let projection = this.inspectMaterializedFile(sessionFile, params);
      const registeredById = this.#registry.getSession(projection.sessionId);
      if (
        registeredById !== undefined &&
        registeredById.sessionFile !== projection.sessionFile
      ) {
        throw new SessionOperationError(
          "duplicate_session",
          `pi session ID is already registered at ${registeredById.sessionFile}`,
        );
      }
      if (
        params.name !== undefined &&
        projection.name !== params.name
      ) {
        const manager = SessionManager.open(
          sessionFile,
          dirname(sessionFile),
          params.cwdOverride,
        );
        manager.appendSessionInfo(params.name);
        projection = this.inspectMaterializedFile(sessionFile, params);
      }
      const reservation = this.#registry.reserveSessionRecord(projection);
      if (
        reservation.session.sessionId !== projection.sessionId ||
        reservation.session.sessionFile !== projection.sessionFile
      ) {
        throw new SessionOperationError(
          "duplicate_session",
          "pi session ID or path is already registered to another identity",
        );
      }
      this.#lockRegistry.acquire(sessionFile, reservation.session.sessionId);
      return {
        session: projectSessionSummary(reservation.session),
        created: false,
      };
    } catch (error) {
      lock.release();
      if (error instanceof RegistryError && error.code === "duplicate_session") {
        throw new SessionOperationError(error.code, error.message);
      }
      throw error;
    }
  }

  list(params: OperationParams<"list">): OperationResult<"list"> {
    const cwd =
      params.cwd === undefined ? undefined : canonicalizeDirectory(params.cwd);
    const sessions = this.#registry
      .listSessions()
      .filter((session) => cwd === undefined || session.cwd === cwd)
      .toSorted((left, right) => {
        const activityOrder = right.lastActivityMs - left.lastActivityMs;
        return activityOrder === 0
          ? left.sessionId.localeCompare(right.sessionId)
          : activityOrder;
      })
      .map(projectSessionSummary)
      .filter(
        (session) =>
          params.phase === undefined ||
          params.phase.includes(session.observedPhase),
      );
    return { sessions };
  }
  dispose(): void {
    this.#lockRegistry.dispose();
  }

  private openRegistered(
    session: SessionRecord,
    params: OperationParams<"open">,
  ): OperationResult<"open"> {
    assertSameOpenRequest(session, params);
    this.retainLock(session.sessionFile, session.sessionId);
    if (!session.fileMaterialized) {
      return { session: projectSessionSummary(session), created: false };
    }

    let physical: SessionRecord;
    try {
      physical = this.inspectMaterializedFile(session.sessionFile, params);
      if (
        physical.sessionId !== session.sessionId ||
        physical.sessionFile !== session.sessionFile ||
        physical.cwd !== session.cwd
      ) {
        throw new SessionOperationError(
          "path_mismatch",
          `registered identity does not match pi session file: ${session.sessionFile}`,
        );
      }
    } catch (error) {
      if (
        error instanceof SessionOperationError &&
        (error.code === "gone" || error.code === "path_mismatch")
      ) {
        this.#registry.markSessionGone(session.sessionId, error.code, this.#now());
      }
      throw error;
    }
    return { session: projectSessionSummary(session), created: false };
  }

  private inspectMaterializedFile(
    sessionFile: string,
    params: OperationParams<"open">,
  ): SessionRecord {
    let before: FileSnapshot;
    try {
      before = snapshotSessionFile(sessionFile);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new SessionOperationError(
          "gone",
          `materialized session file is missing: ${sessionFile}`,
        );
      }
      throw error;
    }

    let manager: SessionManager;
    try {
      manager = SessionManager.open(
        sessionFile,
        dirname(sessionFile),
        params.cwdOverride,
      );
    } catch (error) {
      throw new SessionOperationError(
        "path_mismatch",
        `SessionManager.open() rejected ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertStableSnapshot(before, snapshotSessionFile(sessionFile), sessionFile);

    const header = manager.getHeader();
    const managerSessionFile = manager.getSessionFile();
    if (
      header === null ||
      managerSessionFile === undefined ||
      manager.getSessionId() !== header.id ||
      canonicalizeSessionFilePath(managerSessionFile) !== sessionFile
    ) {
      throw new SessionOperationError(
        "path_mismatch",
        `pi session header and path do not agree: ${sessionFile}`,
      );
    }

    let headerCwd: string;
    let managerCwd: string;
    try {
      headerCwd = canonicalizeDirectory(header.cwd);
      managerCwd = canonicalizeDirectory(manager.getCwd());
    } catch (error) {
      throw new SessionOperationError(
        "path_mismatch",
        `pi session cwd is unavailable for ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (headerCwd !== managerCwd) {
      throw new SessionOperationError(
        "path_mismatch",
        `pi session header cwd does not match the opened cwd: ${sessionFile}`,
      );
    }

    const beforeProjection = snapshotSessionFile(sessionFile);
    let projection: ReturnType<typeof projectSessionFile>;
    try {
      projection = projectSessionFile(sessionFile, this.#now());
    } catch (error) {
      throw new SessionOperationError(
        "path_mismatch",
        `cannot project pi session file ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    assertStableSnapshot(
      beforeProjection,
      snapshotSessionFile(sessionFile),
      sessionFile,
    );
    if (
      projection.session.sessionId !== manager.getSessionId() ||
      projection.session.sessionFile !== sessionFile ||
      projection.session.cwd !== header.cwd ||
      projection.session.activeLeafId !== manager.getLeafId()
    ) {
      throw new SessionOperationError(
        "path_mismatch",
        `pi session identity changed during registration: ${sessionFile}`,
      );
    }

    return { ...projection.session, cwd: headerCwd };
  }
  private retainLock(sessionFile: string, sessionId: string): void {
    this.#lockRegistry.acquire(sessionFile, sessionId);
  }
}
