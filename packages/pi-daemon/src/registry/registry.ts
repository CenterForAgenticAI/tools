import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Attention,
  ErrorCode,
  Phase,
  PromptOutcomeErrorCode,
  PromptOutcomeName,
  RuntimeState,
} from "../protocol/index.js";
import { migrateRegistry, REGISTRY_SCHEMA_VERSION } from "./migrations.js";
import { canonicalizeSessionFilePath } from "./paths.js";
import {
  projectSessionFile,
  type SessionFileProjection,
} from "./rebuild.js";
import {
  ensurePrivateStateDirectory,
  type SingletonLock,
} from "./singleton-lock.js";

const PRIVATE_FILE_MODE = 0o600;

export const REGISTRY_META_KEYS = [
  "schemaVersion",
  "daemonInstanceId",
  "cleanShutdown",
  "startedAt",
  "sdkStamp",
  "protocolVersion",
] as const;

export type RegistryMetaKey = (typeof REGISTRY_META_KEYS)[number];

export interface RegistryMetaValues {
  readonly schemaVersion: number;
  readonly daemonInstanceId: string;
  readonly cleanShutdown: boolean;
  readonly startedAt: string;
  readonly sdkStamp: string;
  readonly protocolVersion: string;
}

export interface RegistryStartupState {
  readonly previousCleanShutdown: boolean | null;
  readonly previousDaemonInstanceId: string | null;
}

export type RegistryErrorCode = Extract<
  ErrorCode,
  | "duplicate_session"
  | "invalid_state"
  | "lease_expired"
  | "lease_held"
  | "no_lease"
  | "path_mismatch"
  | "stale_generation"
  | "unknown_session"
>;

export type SessionGoneReason = Extract<ErrorCode, "gone" | "path_mismatch">;

export interface OpenRegistryOptions {
  readonly databasePath: string;
  readonly lock: SingletonLock;
  readonly daemonInstanceId: string;
  readonly startedAt: string;
  readonly sdkStamp: string;
  readonly protocolVersion: string;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly fileMaterialized: boolean;
  readonly cwd: string;
  readonly name: string | null;
  readonly runtimeState: RuntimeState;
  readonly lastPhase: Phase;
  readonly attention: Attention;
  readonly generation: number;
  readonly epoch: number;
  readonly activeLeafId: string | null;
  readonly cleanShutdown: boolean;
  readonly sleepAfterMs: number | null;
  readonly sleepDeadlineMs: number | null;
  readonly activityToken: number;
  readonly lastActivityMs: number;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface SessionReservation {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly fileMaterialized?: boolean;
  readonly cwd: string;
  readonly name?: string;
  readonly sleepAfterMs?: number;
  readonly nowMs: number;
}

export interface SessionStateIndexInput {
  readonly sessionId: string;
  readonly runtimeState: RuntimeState;
  readonly lastPhase: Phase;
  readonly attention: Attention;
  readonly updatedAtMs: number;
}

export interface SessionGenerationTransitionInput extends SessionStateIndexInput {
  readonly expectedGeneration: number;
  readonly sleepDeadlineMs: number | null;
}

export interface SessionActivityInput {
  readonly sessionId: string;
  readonly expectedGeneration: number;
  readonly sleepDeadlineMs: number | null;
  readonly updatedAtMs: number;
}

export interface RebindSessionReservationInput {
  readonly sessionId: string;
  readonly expectedSessionFile: string;
  readonly sessionFile: string;
  readonly nowMs: number;
}

export type ReserveSessionResult =
  | { readonly status: "reserved"; readonly session: SessionRecord }
  | {
      readonly status: "existing";
      readonly matchedBy: "sessionId" | "sessionFile";
      readonly session: SessionRecord;
    };

export interface LeaseRecord {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly attachmentId: string;
  readonly actorId: string;
  readonly generation: number;
  readonly expiresAtMs: number;
  readonly ttlMs: number;
}

export interface AcquireLeaseInput extends LeaseRecord {
  readonly nowMs: number;
}

export interface HeartbeatLeaseInput {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly nowMs: number;
}

export interface TakeoverLeaseResult {
  readonly lease: LeaseRecord;
  readonly revokedLeaseId: string;
}

export interface CheckLeaseInput {
  readonly sessionId: string;
  readonly generation: number;
  readonly nowMs: number;
}

export type CheckLeaseResult =
  | { readonly status: "active"; readonly lease: LeaseRecord }
  | { readonly status: "expired"; readonly lease: LeaseRecord }
  | { readonly status: "none" };

export interface PromptIndexRecord {
  readonly sessionId: string;
  readonly keyHash: string;
  readonly payloadHash: string;
  readonly promptId: string;
  readonly claimEntryId: string;
  readonly outcomeEntryId: string | null;
  readonly state: "pending" | PromptOutcomeName;
  readonly finalEntryId: string | null;
  readonly errorCode: PromptOutcomeErrorCode | null;
  readonly acceptedAtMs: number;
  readonly settledAtMs: number | null;
}

export interface PromptClaimIndexInput {
  readonly sessionId: string;
  readonly keyHash: string;
  readonly payloadHash: string;
  readonly promptId: string;
  readonly claimEntryId: string;
  readonly acceptedAtMs: number;
}

interface PromptOutcomeIndexInputBase {
  readonly promptId: string;
  readonly outcomeEntryId: string;
  readonly finalEntryId: string | null;
  readonly settledAtMs: number;
}

export type PromptOutcomeIndexInput = PromptOutcomeIndexInputBase &
  (
    | { readonly outcome: "settled" }
    | { readonly outcome: "aborted"; readonly errorCode: "aborted" }
    | {
        readonly outcome: "failed";
        readonly errorCode: Exclude<PromptOutcomeErrorCode, "aborted">;
      }
  );

export interface RebuildRegistryResult {
  readonly sessions: number;
  readonly prompts: number;
}

export interface ExternalWriterRecoveryProjectionInput {
  readonly projection: SessionFileProjection;
  readonly expectedGeneration: number;
  readonly nowMs: number;
}

export interface SessionStartupFence {
  readonly previous: SessionRecord;
  readonly current: SessionRecord;
}

interface SessionDatabaseRow {
  readonly session_id: string;
  readonly session_file: string;
  readonly file_materialized: number;
  readonly cwd: string;
  readonly name: string | null;
  readonly runtime_state: RuntimeState;
  readonly last_phase: Phase;
  readonly attention: Attention;
  readonly generation: number;
  readonly epoch: number;
  readonly active_leaf_id: string | null;
  readonly clean_shutdown: number;
  readonly sleep_after_ms: number | null;
  readonly sleep_deadline_ms: number | null;
  readonly activity_token: number;
  readonly last_activity_ms: number;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

interface LeaseDatabaseRow {
  readonly session_id: string;
  readonly lease_id: string;
  readonly attachment_id: string;
  readonly actor_id: string;
  readonly generation: number;
  readonly expires_at_ms: number;
  readonly ttl_ms: number;
}

interface PromptIndexDatabaseRow {
  readonly session_id: string;
  readonly key_hash: string;
  readonly payload_hash: string;
  readonly prompt_id: string;
  readonly claim_entry_id: string;
  readonly outcome_entry_id: string | null;
  readonly state: "pending" | PromptOutcomeName;
  readonly final_entry_id: string | null;
  readonly error_code: PromptOutcomeErrorCode | null;
  readonly accepted_at_ms: number;
  readonly settled_at_ms: number | null;
}

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

function effectiveUserId(): number {
  if (process.geteuid === undefined) {
    throw new Error("pi-daemon registry requires an effective user ID");
  }
  return process.geteuid();
}

function ensurePrivateRegistryFile(databasePath: string): void {
  ensurePrivateStateDirectory(dirname(databasePath));
  const descriptor = openSync(
    databasePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(databasePath);
    if (
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino ||
      !descriptorStat.isFile()
    ) {
      throw new Error(`registry path is not a regular owned file: ${databasePath}`);
    }
    if (descriptorStat.uid !== effectiveUserId()) {
      throw new Error(
        `registry file is not owned by the effective user: ${databasePath}`,
      );
    }
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const privateStat = fstatSync(descriptor);
    if ((privateStat.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw new Error(`registry file mode is not 0600: ${databasePath}`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function jsonValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("registry meta values must be JSON values");
  }
  return serialized;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function sessionFromDatabaseRow(row: unknown): SessionRecord {
  const value = row as SessionDatabaseRow;
  return {
    sessionId: value.session_id,
    sessionFile: value.session_file,
    fileMaterialized: value.file_materialized === 1,
    cwd: value.cwd,
    name: value.name,
    runtimeState: value.runtime_state,
    lastPhase: value.last_phase,
    attention: value.attention,
    generation: value.generation,
    epoch: value.epoch,
    activeLeafId: value.active_leaf_id,
    cleanShutdown: value.clean_shutdown === 1,
    sleepAfterMs: value.sleep_after_ms,
    sleepDeadlineMs: value.sleep_deadline_ms,
    activityToken: value.activity_token,
    lastActivityMs: value.last_activity_ms,
    failureCode: value.failure_code,
    failureMessage: value.failure_message,
    createdAtMs: value.created_at_ms,
    updatedAtMs: value.updated_at_ms,
  };
}

function leaseFromDatabaseRow(row: unknown): LeaseRecord {
  const value = row as LeaseDatabaseRow;
  return {
    sessionId: value.session_id,
    leaseId: value.lease_id,
    attachmentId: value.attachment_id,
    actorId: value.actor_id,
    generation: value.generation,
    expiresAtMs: value.expires_at_ms,
    ttlMs: value.ttl_ms,
  };
}

function promptIndexFromDatabaseRow(row: unknown): PromptIndexRecord {
  const value = row as PromptIndexDatabaseRow;
  return {
    sessionId: value.session_id,
    keyHash: value.key_hash,
    payloadHash: value.payload_hash,
    promptId: value.prompt_id,
    claimEntryId: value.claim_entry_id,
    outcomeEntryId: value.outcome_entry_id,
    state: value.state,
    finalEntryId: value.final_entry_id,
    errorCode: value.error_code,
    acceptedAtMs: value.accepted_at_ms,
    settledAtMs: value.settled_at_ms,
  };
}

function isUniquenessError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

function previousMetaValue(database: DatabaseSync, key: RegistryMetaKey): unknown {
  const value = database.prepare("SELECT value_json FROM meta WHERE key = ?").get(key)
    ?.value_json;
  if (typeof value !== "string") return null;
  return JSON.parse(value) as unknown;
}

function readStartupState(database: DatabaseSync): RegistryStartupState {
  const previousCleanShutdown = previousMetaValue(database, "cleanShutdown");
  const previousDaemonInstanceId = previousMetaValue(database, "daemonInstanceId");
  if (previousCleanShutdown !== null && typeof previousCleanShutdown !== "boolean") {
    throw new Error("registry previous cleanShutdown marker is invalid");
  }
  if (previousDaemonInstanceId !== null && typeof previousDaemonInstanceId !== "string") {
    throw new Error("registry previous daemonInstanceId marker is invalid");
  }
  return { previousCleanShutdown, previousDaemonInstanceId };
}

export class Registry {
  static open(options: OpenRegistryOptions): Registry {
    options.lock.assertHeld();
    ensurePrivateRegistryFile(options.databasePath);
    const database = new DatabaseSync(options.databasePath);

    try {
      options.lock.assertHeld();
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA journal_mode = WAL");
      const journalMode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
      if (journalMode !== "wal") {
        throw new Error(`registry did not enter WAL mode: ${String(journalMode)}`);
      }

      options.lock.assertHeld();
      migrateRegistry(database);
      const startupState = readStartupState(database);
      const registry = new Registry(
        options.databasePath,
        options.lock,
        database,
        journalMode,
        startupState,
      );
      options.lock.assertHeld();
      registry.writeStartupMeta(options);
      return registry;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  readonly databasePath: string;
  readonly journalMode: "wal";
  readonly schemaVersion = REGISTRY_SCHEMA_VERSION;
  readonly startupState: RegistryStartupState;

  readonly #lock: SingletonLock;
  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(
    databasePath: string,
    lock: SingletonLock,
    database: DatabaseSync,
    journalMode: "wal",
    startupState: RegistryStartupState,
  ) {
    this.databasePath = databasePath;
    this.#lock = lock;
    this.#database = database;
    this.journalMode = journalMode;
    this.startupState = startupState;
  }

  getMeta<Key extends RegistryMetaKey>(key: Key): RegistryMetaValues[Key] {
    this.assertUsable();
    const value = this.#database
      .prepare("SELECT value_json FROM meta WHERE key = ?")
      .get(key)?.value_json;
    if (typeof value !== "string") {
      throw new Error(`registry meta key is missing: ${key}`);
    }
    return JSON.parse(value) as RegistryMetaValues[Key];
  }

  listMetaKeys(): RegistryMetaKey[] {
    this.assertUsable();
    const keys = this.#database
      .prepare("SELECT key FROM meta ORDER BY key")
      .all()
      .map((row) => row.key);

    if (
      !keys.every(
        (key): key is RegistryMetaKey =>
          typeof key === "string" &&
          (REGISTRY_META_KEYS as readonly string[]).includes(key),
      )
    ) {
      throw new Error("registry contains an undeclared meta key");
    }
    return keys;
  }

  reserveSession(input: SessionReservation): ReserveSessionResult {
    this.assertUsable();
    const sessionFile = this.validateReservation(input);
    const fileMaterialized = input.fileMaterialized ?? false;

    return this.transaction(() => {
      const result = this.#database
        .prepare(
          `INSERT INTO sessions (
             session_id, session_file, file_materialized, cwd, name,
             runtime_state, last_phase, attention, generation, epoch,
             active_leaf_id, clean_shutdown, sleep_after_ms, sleep_deadline_ms,
             activity_token, last_activity_ms, failure_code, failure_message,
             created_at_ms, updated_at_ms
           ) VALUES (
             ?, ?, ?, ?, ?,
             'asleep', 'idle', 'none', 0, 0,
             NULL, 0, ?, NULL,
             0, ?, NULL, NULL,
             ?, ?
           )
           ON CONFLICT DO NOTHING`,
        )
        .run(
          input.sessionId,
          sessionFile,
          fileMaterialized ? 1 : 0,
          input.cwd,
          input.name ?? null,
          input.sleepAfterMs ?? null,
          input.nowMs,
          input.nowMs,
          input.nowMs,
        );

      if (Number(result.changes) === 1) {
        const session = this.getSessionWithoutLockCheck(input.sessionId);
        if (session === undefined) {
          throw new Error("reserved session disappeared inside its transaction");
        }
        return { status: "reserved", session };
      }

      const byId = this.getSessionWithoutLockCheck(input.sessionId);
      const byFile = this.getSessionByFileWithoutLockCheck(sessionFile);
      if (byId !== undefined && byFile !== undefined && byId.sessionId !== byFile.sessionId) {
        throw new RegistryError(
          "duplicate_session",
          "session ID and file are already bound to different identities",
        );
      }
      if (byId !== undefined) {
        return { status: "existing", matchedBy: "sessionId", session: byId };
      }
      if (byFile !== undefined) {
        return { status: "existing", matchedBy: "sessionFile", session: byFile };
      }
      throw new Error("session reservation lost without a conflicting identity");
    });
  }

  reserveSessionRecord(input: SessionRecord): ReserveSessionResult {
    this.assertUsable();
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.sessionFile, "sessionFile");
    requireNonEmpty(input.cwd, "cwd");
    const sessionFile = canonicalizeSessionFilePath(input.sessionFile);
    const session = { ...input, sessionFile };

    return this.transaction(() => {
      const byId = this.getSessionWithoutLockCheck(session.sessionId);
      const byFile = this.getSessionByFileWithoutLockCheck(sessionFile);
      if (
        byId !== undefined &&
        byFile !== undefined &&
        byId.sessionId !== byFile.sessionId
      ) {
        throw new RegistryError(
          "duplicate_session",
          "session ID and file are already bound to different identities",
        );
      }
      if (byId !== undefined) {
        return {
          status: "existing",
          matchedBy: "sessionId",
          session: byId,
        };
      }
      if (byFile !== undefined) {
        return {
          status: "existing",
          matchedBy: "sessionFile",
          session: byFile,
        };
      }

      this.insertSessionRecord(session);
      return { status: "reserved", session };
    });
  }

  getSession(sessionId: string): SessionRecord | undefined {
    this.assertUsable();
    return this.getSessionWithoutLockCheck(sessionId);
  }

  getSessionByFile(sessionFile: string): SessionRecord | undefined {
    this.assertUsable();
    return this.getSessionByFileWithoutLockCheck(
      canonicalizeSessionFilePath(sessionFile),
    );
  }

  listSessions(): SessionRecord[] {
    this.assertUsable();
    return this.#database
      .prepare("SELECT * FROM sessions ORDER BY session_id")
      .all()
      .map(sessionFromDatabaseRow);
  }

  rebuildFromSessionFiles(
    sessionFiles: readonly string[],
    nowMs: number,
  ): RebuildRegistryResult {
    this.assertUsable();
    const projections = sessionFiles.map((sessionFile) =>
      projectSessionFile(sessionFile, nowMs),
    );

    return this.transaction(() => {
      this.#database.exec(`
        DELETE FROM prompt_index;
        DELETE FROM leases;
        DELETE FROM sessions;
      `);

      let promptCount = 0;
      for (const projection of projections) {
        this.insertSessionRecord(projection.session);
        for (const prompt of projection.prompts) {
          this.insertPromptIndexRecord(prompt);
          promptCount += 1;
        }
      }

      return { sessions: projections.length, prompts: promptCount };
    });
  }

  fenceSessionsForStartup(nowMs: number): SessionStartupFence[] {
    this.assertUsable();
    requireNonNegativeInteger(nowMs, "nowMs");
    return this.transaction(() => {
      const previous = this.listSessions();
      if (previous.some((session) => session.generation === Number.MAX_SAFE_INTEGER)) {
        throw new TypeError("session generation cannot exceed Number.MAX_SAFE_INTEGER");
      }
      this.#database.prepare("DELETE FROM leases").run();
      this.#database
        .prepare(
          `UPDATE sessions
           SET runtime_state = 'asleep', generation = generation + 1,
               clean_shutdown = 0, sleep_deadline_ms = NULL,
               activity_token = activity_token + 1,
               last_activity_ms = ?, updated_at_ms = ?`,
        )
        .run(nowMs, nowMs);
      return previous.map((prior) => {
        const current = this.getSessionWithoutLockCheck(prior.sessionId);
        if (current === undefined) {
          throw new Error(`startup-fenced session disappeared: ${prior.sessionId}`);
        }
        return { previous: prior, current };
      });
    });
  }

  applySessionFileProjection(
    projection: SessionFileProjection,
    nowMs: number,
  ): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(nowMs, "nowMs");
    const projected = projection.session;
    return this.transaction(() => {
      const current = this.getSessionWithoutLockCheck(projected.sessionId);
      if (current === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${projected.sessionId}`,
        );
      }
      if (current.sessionFile !== projected.sessionFile) {
        throw new RegistryError(
          "path_mismatch",
          `session file changed during rebuild: ${projected.sessionId}`,
        );
      }
      this.#database
        .prepare("DELETE FROM prompt_index WHERE session_id = ?")
        .run(projected.sessionId);
      this.#database
        .prepare(
          `UPDATE sessions
           SET file_materialized = 1, cwd = ?, name = ?, runtime_state = 'asleep',
               last_phase = ?, attention = ?, epoch = ?, active_leaf_id = ?,
               clean_shutdown = 0, sleep_after_ms = ?, sleep_deadline_ms = NULL,
               last_activity_ms = ?, failure_code = ?, failure_message = NULL,
               created_at_ms = ?, updated_at_ms = ?
           WHERE session_id = ?`,
        )
        .run(
          projected.cwd,
          projected.name,
          projected.lastPhase,
          projected.attention,
          projected.epoch,
          projected.activeLeafId,
          projected.sleepAfterMs,
          nowMs,
          projected.failureCode,
          projected.createdAtMs,
          nowMs,
          projected.sessionId,
        );
      for (const prompt of projection.prompts) {
        if (prompt.sessionId !== projected.sessionId) {
          throw new Error("file projection contains a cross-session prompt row");
        }
        this.insertPromptIndexRecord(prompt);
      }
      const applied = this.getSessionWithoutLockCheck(projected.sessionId);
      if (applied === undefined) {
        throw new Error(`rebuilt session disappeared: ${projected.sessionId}`);
      }
      return applied;
    });
  }

  applyExternalWriterRecoveryProjection(
    input: ExternalWriterRecoveryProjectionInput,
  ): SessionRecord {
    return this.replaceExternalWriterRecoveryProjection(input, false);
  }

  completeExternalWriterRecovery(
    input: ExternalWriterRecoveryProjectionInput,
  ): SessionRecord {
    return this.replaceExternalWriterRecoveryProjection(input, true);
  }

  getPromptById(promptId: string): PromptIndexRecord | undefined {
    this.assertUsable();
    const row = this.#database
      .prepare("SELECT * FROM prompt_index WHERE prompt_id = ?")
      .get(promptId);
    return row === undefined ? undefined : promptIndexFromDatabaseRow(row);
  }

  getPromptByKeyHash(sessionId: string, keyHash: string): PromptIndexRecord | undefined {
    this.assertUsable();
    requireNonEmpty(sessionId, "sessionId");
    requireNonEmpty(keyHash, "keyHash");
    const row = this.#database
      .prepare("SELECT * FROM prompt_index WHERE session_id = ? AND key_hash = ?")
      .get(sessionId, keyHash);
    return row === undefined ? undefined : promptIndexFromDatabaseRow(row);
  }

  recordPromptClaim(input: PromptClaimIndexInput): PromptIndexRecord {
    this.assertUsable();
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.keyHash, "keyHash");
    requireNonEmpty(input.payloadHash, "payloadHash");
    requireNonEmpty(input.promptId, "promptId");
    requireNonEmpty(input.claimEntryId, "claimEntryId");
    requireNonNegativeInteger(input.acceptedAtMs, "acceptedAtMs");

    const record: PromptIndexRecord = {
      sessionId: input.sessionId,
      keyHash: input.keyHash,
      payloadHash: input.payloadHash,
      promptId: input.promptId,
      claimEntryId: input.claimEntryId,
      outcomeEntryId: null,
      state: "pending",
      finalEntryId: null,
      errorCode: null,
      acceptedAtMs: input.acceptedAtMs,
      settledAtMs: null,
    };
    this.insertPromptIndexRecord(record);
    return record;
  }

  recordPromptOutcome(input: PromptOutcomeIndexInput): PromptIndexRecord {
    this.assertUsable();
    requireNonEmpty(input.promptId, "promptId");
    requireNonEmpty(input.outcomeEntryId, "outcomeEntryId");
    if (input.finalEntryId !== null) requireNonEmpty(input.finalEntryId, "finalEntryId");
    requireNonNegativeInteger(input.settledAtMs, "settledAtMs");

    return this.transaction(() => {
      const errorCode = input.outcome === "settled" ? null : input.errorCode;
      const result = this.#database
        .prepare(
          `UPDATE prompt_index
           SET outcome_entry_id = ?, state = ?, final_entry_id = ?, error_code = ?,
               settled_at_ms = ?
           WHERE prompt_id = ? AND state = 'pending'`,
        )
        .run(
          input.outcomeEntryId,
          input.outcome,
          input.finalEntryId,
          errorCode,
          input.settledAtMs,
          input.promptId,
        );
      const record = this.getPromptById(input.promptId);
      if (record === undefined) {
        throw new Error(`prompt outcome has no indexed claim: ${input.promptId}`);
      }
      if (Number(result.changes) === 0 && record.outcomeEntryId !== input.outcomeEntryId) {
        throw new Error(`prompt already has a different terminal outcome: ${input.promptId}`);
      }
      return record;
    });
  }

  listPromptIndex(): PromptIndexRecord[] {
    this.assertUsable();
    return this.#database
      .prepare("SELECT * FROM prompt_index ORDER BY session_id, key_hash")
      .all()
      .map(promptIndexFromDatabaseRow);
  }

  markSessionMaterialized(sessionId: string, updatedAtMs: number): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(updatedAtMs, "updatedAtMs");
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET file_materialized = 1, updated_at_ms = ?
         WHERE session_id = ?`,
      )
      .run(updatedAtMs, sessionId);
    if (Number(result.changes) === 0) {
      throw new RegistryError("unknown_session", `unknown session: ${sessionId}`);
    }
    const session = this.getSessionWithoutLockCheck(sessionId);
    if (session === undefined) {
      throw new Error("materialized session disappeared after update");
    }
    return session;
  }

  rebindSessionReservation(
    input: RebindSessionReservationInput,
  ): SessionRecord {
    this.assertUsable();
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.expectedSessionFile, "expectedSessionFile");
    requireNonEmpty(input.sessionFile, "sessionFile");
    requireNonNegativeInteger(input.nowMs, "nowMs");
    const expectedSessionFile = canonicalizeSessionFilePath(
      input.expectedSessionFile,
    );
    const sessionFile = canonicalizeSessionFilePath(input.sessionFile);

    return this.transaction(() => {
      const existing = this.getSessionWithoutLockCheck(input.sessionId);
      if (existing === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${input.sessionId}`,
        );
      }
      if (
        existing.fileMaterialized ||
        existing.sessionFile !== expectedSessionFile
      ) {
        throw new RegistryError(
          "path_mismatch",
          `session reservation cannot move from ${expectedSessionFile}`,
        );
      }
      const byFile = this.getSessionByFileWithoutLockCheck(sessionFile);
      if (
        byFile !== undefined &&
        byFile.sessionId !== existing.sessionId
      ) {
        throw new RegistryError(
          "duplicate_session",
          `session file is already registered: ${sessionFile}`,
        );
      }
      if (sessionFile === expectedSessionFile) {
        return existing;
      }

      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET session_file = ?, updated_at_ms = ?
           WHERE session_id = ? AND session_file = ? AND file_materialized = 0`,
        )
        .run(
          sessionFile,
          input.nowMs,
          input.sessionId,
          expectedSessionFile,
        );
      if (Number(result.changes) !== 1) {
        throw new RegistryError(
          "path_mismatch",
          `session reservation changed before rebind: ${input.sessionId}`,
        );
      }
      const rebound = this.getSessionWithoutLockCheck(input.sessionId);
      if (rebound === undefined) {
        throw new Error("rebound session disappeared inside its transaction");
      }
      return rebound;
    });
  }

  deleteSessionReservation(sessionId: string): boolean {
    this.assertUsable();
    const result = this.#database
      .prepare(
        "DELETE FROM sessions WHERE session_id = ? AND file_materialized = 0",
      )
      .run(sessionId);
    return Number(result.changes) === 1;
  }

  setSessionState(input: SessionStateIndexInput): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(input.updatedAtMs, "updatedAtMs");
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET runtime_state = ?, last_phase = ?, attention = ?, updated_at_ms = ?
         WHERE session_id = ?`,
      )
      .run(
        input.runtimeState,
        input.lastPhase,
        input.attention,
        input.updatedAtMs,
        input.sessionId,
      );
    if (Number(result.changes) === 0) {
      throw new RegistryError("unknown_session", `unknown session: ${input.sessionId}`);
    }
    const session = this.getSessionWithoutLockCheck(input.sessionId);
    if (session === undefined) throw new Error("session disappeared after state update");
    return session;
  }

  advanceSessionGeneration(input: SessionGenerationTransitionInput): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(input.expectedGeneration, "expectedGeneration");
    requireNonNegativeInteger(input.updatedAtMs, "updatedAtMs");
    if (input.sleepDeadlineMs !== null) {
      requireNonNegativeInteger(input.sleepDeadlineMs, "sleepDeadlineMs");
    }
    if (input.expectedGeneration === Number.MAX_SAFE_INTEGER) {
      throw new TypeError("session generation cannot exceed Number.MAX_SAFE_INTEGER");
    }

    return this.transaction(() => {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError("unknown_session", `unknown session: ${input.sessionId}`);
      }
      if (session.generation !== input.expectedGeneration) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.expectedGeneration}; current generation is ${session.generation}`,
        );
      }
      const generation = input.expectedGeneration + 1;
      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET runtime_state = ?, last_phase = ?, attention = ?, generation = ?,
               sleep_deadline_ms = ?, activity_token = activity_token + 1,
               last_activity_ms = ?, updated_at_ms = ?
           WHERE session_id = ? AND generation = ?`,
        )
        .run(
          input.runtimeState,
          input.lastPhase,
          input.attention,
          generation,
          input.sleepDeadlineMs,
          input.updatedAtMs,
          input.updatedAtMs,
          input.sessionId,
          input.expectedGeneration,
        );
      if (Number(result.changes) !== 1) {
        throw new RegistryError(
          "stale_generation",
          `session generation changed during transition: ${input.sessionId}`,
        );
      }
      this.#database
        .prepare("UPDATE leases SET generation = ? WHERE session_id = ?")
        .run(generation, input.sessionId);
      const updated = this.getSessionWithoutLockCheck(input.sessionId);
      if (updated === undefined) {
        throw new Error("session disappeared after generation transition");
      }
      return updated;
    });
  }

  recordSessionActivity(input: SessionActivityInput): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(input.expectedGeneration, "expectedGeneration");
    requireNonNegativeInteger(input.updatedAtMs, "updatedAtMs");
    if (input.sleepDeadlineMs !== null) {
      requireNonNegativeInteger(input.sleepDeadlineMs, "sleepDeadlineMs");
    }
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET sleep_deadline_ms = ?, activity_token = activity_token + 1,
             last_activity_ms = ?, updated_at_ms = ?
         WHERE session_id = ? AND generation = ?`,
      )
      .run(
        input.sleepDeadlineMs,
        input.updatedAtMs,
        input.updatedAtMs,
        input.sessionId,
        input.expectedGeneration,
      );
    if (Number(result.changes) !== 1) {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError("unknown_session", `unknown session: ${input.sessionId}`);
      }
      throw new RegistryError(
        "stale_generation",
        `stale generation ${input.expectedGeneration}; current generation is ${session.generation}`,
      );
    }
    const session = this.getSessionWithoutLockCheck(input.sessionId);
    if (session === undefined) throw new Error("session disappeared after activity update");
    return session;
  }

  markSessionGone(
    sessionId: string,
    reason: SessionGoneReason,
    updatedAtMs: number,
  ): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(updatedAtMs, "updatedAtMs");
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET runtime_state = 'asleep', last_phase = 'gone', attention = 'failed',
             failure_code = ?, failure_message = NULL,
             activity_token = activity_token + 1,
             last_activity_ms = ?, updated_at_ms = ?
         WHERE session_id = ?`,
      )
      .run(reason, updatedAtMs, updatedAtMs, sessionId);
    if (Number(result.changes) === 0) {
      throw new RegistryError("unknown_session", `unknown session: ${sessionId}`);
    }
    const session = this.getSessionWithoutLockCheck(sessionId);
    if (session === undefined) {
      throw new Error("gone session disappeared after update");
    }
    return session;
  }
  markSessionExternalWriter(sessionId: string, updatedAtMs: number): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(updatedAtMs, "updatedAtMs");
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET runtime_state = 'asleep', last_phase = 'failed', attention = 'failed',
             failure_code = 'external_writer', failure_message = NULL,
             activity_token = activity_token + 1,
             last_activity_ms = ?, updated_at_ms = ?
         WHERE session_id = ?`,
      )
      .run(updatedAtMs, updatedAtMs, sessionId);
    if (Number(result.changes) === 0) {
      throw new RegistryError("unknown_session", `unknown session: ${sessionId}`);
    }
    const session = this.getSessionWithoutLockCheck(sessionId);
    if (session === undefined) {
      throw new Error("external-writer session disappeared after update");
    }
    return session;
  }

  acquireLease(input: AcquireLeaseInput): LeaseRecord {
    this.assertUsable();
    this.validateLease(input);

    return this.transaction(() => {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${input.sessionId}`,
        );
      }
      if (session.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.generation}; current generation is ${session.generation}`,
        );
      }

      this.#database
        .prepare("DELETE FROM leases WHERE session_id = ? AND expires_at_ms <= ?")
        .run(input.sessionId, input.nowMs);

      try {
        this.#database
          .prepare(
            `INSERT INTO leases (
               session_id, lease_id, attachment_id, actor_id,
               generation, expires_at_ms, ttl_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.sessionId,
            input.leaseId,
            input.attachmentId,
            input.actorId,
            input.generation,
            input.expiresAtMs,
            input.ttlMs,
          );
      } catch (error) {
        if (isUniquenessError(error)) {
          throw new RegistryError(
            "lease_held",
            `a driver lease is already held for session ${input.sessionId}`,
          );
        }
        throw error;
      }

      const lease = this.getLeaseWithoutLockCheck(input.sessionId);
      if (lease === undefined) {
        throw new Error("acquired lease disappeared inside its transaction");
      }
      return lease;
    });
  }

  takeoverLease(input: AcquireLeaseInput): TakeoverLeaseResult {
    this.assertUsable();
    this.validateLease(input);

    const result = this.leaseTransaction<
      | { readonly status: "expired" }
      | { readonly status: "missing" }
      | {
          readonly status: "replaced";
          readonly lease: LeaseRecord;
          readonly revokedLeaseId: string;
        }
    >(() => {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${input.sessionId}`,
        );
      }
      if (session.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.generation}; current generation is ${session.generation}`,
        );
      }

      const previous = this.getLeaseWithoutLockCheck(input.sessionId);
      if (previous === undefined) {
        return { status: "missing" };
      }
      if (previous.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `lease generation ${previous.generation} does not match current generation ${input.generation}`,
        );
      }
      if (previous.expiresAtMs <= input.nowMs) {
        this.#database
          .prepare("DELETE FROM leases WHERE session_id = ? AND lease_id = ?")
          .run(input.sessionId, previous.leaseId);
        return { status: "expired" };
      }

      this.#database
        .prepare("DELETE FROM leases WHERE session_id = ? AND lease_id = ?")
        .run(input.sessionId, previous.leaseId);
      this.#database
        .prepare(
          `INSERT INTO leases (
             session_id, lease_id, attachment_id, actor_id,
             generation, expires_at_ms, ttl_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.leaseId,
          input.attachmentId,
          input.actorId,
          input.generation,
          input.expiresAtMs,
          input.ttlMs,
        );
      const lease = this.getLeaseWithoutLockCheck(input.sessionId);
      if (lease === undefined || lease.leaseId !== input.leaseId) {
        throw new Error("replacement lease disappeared inside takeover transaction");
      }
      return {
        status: "replaced",
        lease,
        revokedLeaseId: previous.leaseId,
      };
    });

    if (result.status === "missing") {
      throw new RegistryError(
        "no_lease",
        `no driver lease to take over for session ${input.sessionId}`,
      );
    }
    if (result.status === "expired") {
      throw new RegistryError(
        "lease_expired",
        `driver lease expired for session ${input.sessionId}`,
      );
    }

    return { lease: result.lease, revokedLeaseId: result.revokedLeaseId };
  }

  heartbeatLease(input: HeartbeatLeaseInput): number {
    this.assertUsable();
    this.validateLeaseIdentity(input);

    const result = this.transaction<
      | { readonly status: "extended"; readonly expiresAtMs: number }
      | { readonly status: "expired" }
      | { readonly status: "missing" }
    >(() => {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${input.sessionId}`,
        );
      }
      if (session.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.generation}; current generation is ${session.generation}`,
        );
      }

      const lease = this.getLeaseWithoutLockCheck(input.sessionId);
      if (
        lease === undefined ||
        lease.leaseId !== input.leaseId ||
        lease.attachmentId !== input.attachmentId
      ) {
        return { status: "missing" };
      }
      if (lease.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `lease generation ${lease.generation} does not match current generation ${input.generation}`,
        );
      }
      if (lease.expiresAtMs <= input.nowMs) {
        this.#database
          .prepare("DELETE FROM leases WHERE session_id = ? AND lease_id = ?")
          .run(input.sessionId, input.leaseId);
        return { status: "expired" };
      }

      const expiresAtMs = input.nowMs + lease.ttlMs;
      requireNonNegativeInteger(expiresAtMs, "expiresAtMs");
      const update = this.#database
        .prepare(
          `UPDATE leases
           SET expires_at_ms = ?
           WHERE session_id = ? AND lease_id = ? AND attachment_id = ?
             AND generation = ? AND expires_at_ms > ?`,
        )
        .run(
          expiresAtMs,
          input.sessionId,
          input.leaseId,
          input.attachmentId,
          input.generation,
          input.nowMs,
        );
      if (Number(update.changes) !== 1) {
        throw new Error("lease changed inside heartbeat transaction");
      }
      return { status: "extended", expiresAtMs };
    });

    if (result.status === "missing") {
      throw new RegistryError(
        "no_lease",
        `no matching driver lease for session ${input.sessionId}`,
      );
    }
    if (result.status === "expired") {
      throw new RegistryError(
        "lease_expired",
        `driver lease expired for session ${input.sessionId}`,
      );
    }
    return result.expiresAtMs;
  }

  checkLease(input: CheckLeaseInput): CheckLeaseResult {
    this.assertUsable();
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonNegativeInteger(input.generation, "generation");
    requireNonNegativeInteger(input.nowMs, "nowMs");

    return this.transaction(() => {
      const session = this.getSessionWithoutLockCheck(input.sessionId);
      if (session === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${input.sessionId}`,
        );
      }
      if (session.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.generation}; current generation is ${session.generation}`,
        );
      }

      const lease = this.getLeaseWithoutLockCheck(input.sessionId);
      if (lease === undefined) {
        return { status: "none" };
      }
      if (lease.generation !== input.generation) {
        throw new RegistryError(
          "stale_generation",
          `lease generation ${lease.generation} does not match current generation ${input.generation}`,
        );
      }
      if (lease.expiresAtMs > input.nowMs) {
        return { status: "active", lease };
      }

      this.#database
        .prepare("DELETE FROM leases WHERE session_id = ? AND lease_id = ?")
        .run(input.sessionId, lease.leaseId);
      return { status: "expired", lease };
    });
  }

  getLease(sessionId: string): LeaseRecord | undefined {
    this.assertUsable();
    return this.getLeaseWithoutLockCheck(sessionId);
  }

  listLeases(): LeaseRecord[] {
    this.assertUsable();
    return this.#database
      .prepare("SELECT * FROM leases ORDER BY session_id")
      .all()
      .map(leaseFromDatabaseRow);
  }

  releaseLease(sessionId: string, leaseId: string): boolean {
    this.assertUsable();
    const result = this.#database
      .prepare("DELETE FROM leases WHERE session_id = ? AND lease_id = ?")
      .run(sessionId, leaseId);
    return Number(result.changes) === 1;
  }

  clearLeases(): number {
    this.assertUsable();
    return Number(this.#database.prepare("DELETE FROM leases").run().changes);
  }

  setCleanShutdown(cleanShutdown: boolean): void {
    this.assertUsable();
    this.setMeta("cleanShutdown", cleanShutdown);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#lock.assertHeld();
    this.#database.close();
    this.#closed = true;
  }

  private assertUsable(): void {
    if (this.#closed || !this.#database.isOpen) {
      throw new Error("registry is closed");
    }
    this.#lock.assertHeld();
  }

  private getSessionWithoutLockCheck(sessionId: string): SessionRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId);
    return row === undefined ? undefined : sessionFromDatabaseRow(row);
  }

  private getSessionByFileWithoutLockCheck(
    sessionFile: string,
  ): SessionRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM sessions WHERE session_file = ?")
      .get(sessionFile);
    return row === undefined ? undefined : sessionFromDatabaseRow(row);
  }

  private getLeaseWithoutLockCheck(sessionId: string): LeaseRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM leases WHERE session_id = ?")
      .get(sessionId);
    return row === undefined ? undefined : leaseFromDatabaseRow(row);
  }

  private replaceExternalWriterRecoveryProjection(
    input: ExternalWriterRecoveryProjectionInput,
    complete: boolean,
  ): SessionRecord {
    this.assertUsable();
    requireNonNegativeInteger(input.expectedGeneration, "expectedGeneration");
    requireNonNegativeInteger(input.nowMs, "nowMs");
    const projected = input.projection.session;
    return this.transaction(() => {
      const current = this.getSessionWithoutLockCheck(projected.sessionId);
      if (current === undefined) {
        throw new RegistryError(
          "unknown_session",
          `unknown session: ${projected.sessionId}`,
        );
      }
      if (current.generation !== input.expectedGeneration) {
        throw new RegistryError(
          "stale_generation",
          `stale generation ${input.expectedGeneration}; current generation is ${current.generation}`,
        );
      }
      if (
        current.runtimeState !== "asleep" ||
        current.lastPhase !== "failed" ||
        current.failureCode !== "external_writer"
      ) {
        throw new RegistryError(
          "invalid_state",
          `session is not failed by external_writer: ${projected.sessionId}`,
        );
      }
      if (current.sessionFile !== projected.sessionFile) {
        throw new RegistryError(
          "path_mismatch",
          `session file changed during recovery: ${projected.sessionId}`,
        );
      }

      this.#database
        .prepare("DELETE FROM prompt_index WHERE session_id = ?")
        .run(projected.sessionId);
      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET file_materialized = 1, cwd = ?, name = ?, runtime_state = 'asleep',
               last_phase = ?, attention = ?, epoch = ?, active_leaf_id = ?,
               clean_shutdown = 0, sleep_after_ms = ?, sleep_deadline_ms = NULL,
               last_activity_ms = ?, failure_code = ?, failure_message = NULL,
               updated_at_ms = ?
           WHERE session_id = ? AND generation = ? AND runtime_state = 'asleep'
             AND last_phase = 'failed' AND failure_code = 'external_writer'`,
        )
        .run(
          projected.cwd,
          projected.name,
          complete ? "idle" : "failed",
          complete ? "none" : "failed",
          projected.epoch,
          projected.activeLeafId,
          projected.sleepAfterMs,
          input.nowMs,
          complete ? null : "external_writer",
          input.nowMs,
          projected.sessionId,
          input.expectedGeneration,
        );
      if (Number(result.changes) !== 1) {
        throw new RegistryError(
          "stale_generation",
          `session changed during external-writer recovery: ${projected.sessionId}`,
        );
      }
      for (const prompt of input.projection.prompts) {
        if (prompt.sessionId !== projected.sessionId) {
          throw new Error("recovery projection contains a cross-session prompt row");
        }
        this.insertPromptIndexRecord(prompt);
      }
      const recovered = this.getSessionWithoutLockCheck(projected.sessionId);
      if (recovered === undefined) {
        throw new Error(`recovered session disappeared: ${projected.sessionId}`);
      }
      return recovered;
    });
  }

  private insertSessionRecord(session: SessionRecord): void {
    this.#database
      .prepare(
        `INSERT INTO sessions (
           session_id, session_file, file_materialized, cwd, name,
           runtime_state, last_phase, attention, generation, epoch,
           active_leaf_id, clean_shutdown, sleep_after_ms, sleep_deadline_ms,
           activity_token, last_activity_ms, failure_code, failure_message,
           created_at_ms, updated_at_ms
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        session.sessionId,
        session.sessionFile,
        session.fileMaterialized ? 1 : 0,
        session.cwd,
        session.name,
        session.runtimeState,
        session.lastPhase,
        session.attention,
        session.generation,
        session.epoch,
        session.activeLeafId,
        session.cleanShutdown ? 1 : 0,
        session.sleepAfterMs,
        session.sleepDeadlineMs,
        session.activityToken,
        session.lastActivityMs,
        session.failureCode,
        session.failureMessage,
        session.createdAtMs,
        session.updatedAtMs,
      );
  }

  private insertPromptIndexRecord(prompt: PromptIndexRecord): void {
    this.#database
      .prepare(
        `INSERT INTO prompt_index (
           session_id, key_hash, payload_hash, prompt_id, claim_entry_id,
           outcome_entry_id, state, final_entry_id, error_code,
           accepted_at_ms, settled_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prompt.sessionId,
        prompt.keyHash,
        prompt.payloadHash,
        prompt.promptId,
        prompt.claimEntryId,
        prompt.outcomeEntryId,
        prompt.state,
        prompt.finalEntryId,
        prompt.errorCode,
        prompt.acceptedAtMs,
        prompt.settledAtMs,
      );
  }

  private setMeta<Key extends RegistryMetaKey>(
    key: Key,
    value: RegistryMetaValues[Key],
  ): void {
    this.#database
      .prepare(
        `INSERT INTO meta (key, value_json)
         VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, jsonValue(value));
  }

  private transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  private leaseTransaction<T>(operation: () => T): T {
    try {
      return this.transaction(operation);
    } catch (error) {
      if (isUniquenessError(error)) {
        throw new RegistryError(
          "lease_held",
          "the replacement lease ID is already in use",
        );
      }
      throw error;
    }
  }

  private validateReservation(input: SessionReservation): string {
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.sessionFile, "sessionFile");
    requireNonEmpty(input.cwd, "cwd");
    if (input.sleepAfterMs !== undefined) {
      requireNonNegativeInteger(input.sleepAfterMs, "sleepAfterMs");
    }
    requireNonNegativeInteger(input.nowMs, "nowMs");
    return canonicalizeSessionFilePath(input.sessionFile);
  }

  private validateLeaseIdentity(input: HeartbeatLeaseInput): void {
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.leaseId, "leaseId");
    requireNonEmpty(input.attachmentId, "attachmentId");
    requireNonNegativeInteger(input.generation, "generation");
    requireNonNegativeInteger(input.nowMs, "nowMs");
  }

  private validateLease(input: AcquireLeaseInput): void {
    this.validateLeaseIdentity(input);
    requireNonEmpty(input.actorId, "actorId");
    requireNonNegativeInteger(input.expiresAtMs, "expiresAtMs");
    requireNonNegativeInteger(input.ttlMs, "ttlMs");
    if (input.ttlMs === 0 || input.expiresAtMs <= input.nowMs) {
      throw new TypeError("lease expiry and TTL must be in the future");
    }
  }

  private writeStartupMeta(options: OpenRegistryOptions): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.setMeta("schemaVersion", REGISTRY_SCHEMA_VERSION);
      this.setMeta("daemonInstanceId", options.daemonInstanceId);
      this.setMeta("cleanShutdown", false);
      this.setMeta("startedAt", options.startedAt);
      this.setMeta("sdkStamp", options.sdkStamp);
      this.setMeta("protocolVersion", options.protocolVersion);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
