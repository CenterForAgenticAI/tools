import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";

import type { Cursor } from "../protocol/index.js";


/**
 * Saved TUI resume state (issue 55, "Saved resume state").
 *
 * The file holds an allowlist only: a schema version, the focused session id,
 * and one committed cursor per session. It never holds transcripts,
 * credentials, lease tokens, drafts, UI choices, or the socket path. Every
 * object that enters or leaves the file is rebuilt by copying named fields;
 * nothing the caller supplies is spread or cast through.
 */

export const SAVED_STATE_VERSION = 1;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SAVED_STATE_BYTES = 1024 * 1024;
const ENDPOINT_HASH_LENGTH = 32;

export interface SavedSession {
  readonly id: string;
  readonly committedCursor: Cursor;
}

export interface SavedState {
  readonly version: typeof SAVED_STATE_VERSION;
  readonly focusedSessionId: string | null;
  readonly sessions: readonly SavedSession[];
}

/** Migrates a state of version N (index N-1 in the chain) to version N+1. Must be pure. */
export type SavedStateMigrator = (previous: Record<string, unknown>) => unknown;

/** v1 is the first version, so the chain is empty. Every later version appends one step. */
export const SAVED_STATE_MIGRATORS: readonly SavedStateMigrator[] = [];

export interface SavedStatePathOptions {
  /** The resolved daemon socket path this state belongs to. Must be absolute. */
  readonly socketPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export type SavedStateLoadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "loaded"; readonly state: SavedState }
  /** The file was invalid: it was renamed to `<path>.corrupt` (when `quarantined`) and the TUI starts fresh. */
  | {
      readonly kind: "corrupt";
      readonly quarantined: boolean;
    }
  /** The file has a newer, unknown version. It is left untouched and ignored. */
  | { readonly kind: "newer-version"; readonly version: number }
  /** The state directory is a symlink, foreign-owned or writable by others. Nothing was read; start fresh without saving. */
  | { readonly kind: "unsafe-directory" };

export function savedStateDirectory(options: Omit<SavedStatePathOptions, "socketPath"> = {}): string {
  const environment = options.environment ?? process.env;
  const stateHome =
    environment.XDG_STATE_HOME !== undefined && environment.XDG_STATE_HOME !== ""
      ? environment.XDG_STATE_HOME
      : resolve(options.homeDirectory ?? environment.HOME ?? homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) {
    throw new TypeError("XDG_STATE_HOME must be an absolute path");
  }
  return resolve(stateHome, "pi-daemon", "tui");
}

/** `<state dir>/<hash>.json`, where `<hash>` is a hash of the resolved socket path. */
export function savedStatePath(options: SavedStatePathOptions): string {
  if (!isAbsolute(options.socketPath)) {
    throw new TypeError("socketPath must be an absolute path");
  }
  const resolved = canonicalizeSocketPath(options.socketPath);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, ENDPOINT_HASH_LENGTH);
  return join(savedStateDirectory(options), `${hash}.json`);
}

/**
 * The socket path with every existing ancestor resolved through symlinks and any
 * not-yet-created tail appended lexically. The key therefore does not change when the
 * daemon later creates the socket directory. Failures other than a missing path
 * (a symlink loop, a permission error) propagate: they must not silently select a
 * different identity rule.
 */
function canonicalizeSocketPath(socketPath: string): string {
  const missing: string[] = [];
  let existing = resolve(socketPath);
  for (;;) {
    try {
      return join(realpathSync(existing), ...missing);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseCursor(value: unknown): Cursor | null {
  if (!isRecord(value) || !hasExactKeys(value, ["entryId", "epoch"])) return null;
  const { entryId, epoch } = value;
  if (entryId !== null && typeof entryId !== "string") return null;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return null;
  return { entryId, epoch };
}

/**
 * Strict v1 parser. Copies the named fields into a new object and returns
 * `null` when anything is missing, mistyped, duplicated, or extra.
 */
export function parseSavedState(value: unknown): SavedState | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "focusedSessionId", "sessions"])) {
    return null;
  }
  const { version, focusedSessionId, sessions } = value;
  if (version !== SAVED_STATE_VERSION) return null;
  if (focusedSessionId !== null && (typeof focusedSessionId !== "string" || focusedSessionId === "")) {
    return null;
  }
  if (!Array.isArray(sessions)) return null;

  const seen = new Set<string>();
  const copied: SavedSession[] = [];
  for (const candidate of sessions as readonly unknown[]) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["id", "committedCursor"])) return null;
    const { id } = candidate;
    if (typeof id !== "string" || id === "" || seen.has(id)) return null;
    const committedCursor = parseCursor(candidate.committedCursor);
    if (committedCursor === null) return null;
    seen.add(id);
    copied.push({ id, committedCursor });
  }
  return { version: SAVED_STATE_VERSION, focusedSessionId, sessions: copied };
}

export interface MigrationOptions {
  readonly currentVersion?: number;
  readonly migrators?: readonly SavedStateMigrator[];
}

export type MigrationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/**
 * Applies the step migrators from `raw.version` up to the current version.
 * A missing step, a throwing step, or a step that does not produce the next
 * version makes the whole file untrustworthy, so the caller treats it as corrupt.
 */
export function migrateSavedState(raw: Record<string, unknown>, options: MigrationOptions = {}): MigrationResult {
  const currentVersion = options.currentVersion ?? SAVED_STATE_VERSION;
  const migrators = options.migrators ?? SAVED_STATE_MIGRATORS;
  let value: unknown = raw;
  for (;;) {
    if (!isRecord(value)) return { ok: false };
    const version = value.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
      return { ok: false };
    }
    if (version === currentVersion) return { ok: true, value };
    if (version > currentVersion) return { ok: false };
    const step = migrators[version - 1];
    if (step === undefined) return { ok: false };
    try {
      value = step(value);
    } catch {
      return { ok: false };
    }
    if (!isRecord(value) || value.version !== version + 1) return { ok: false };
  }
}


function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const identityOfStats = (info: BigIntStats): FileIdentity => ({ dev: info.dev, ino: info.ino });
const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/** Identity of whatever is at `path` (a symlink is itself, never its target), or null when nothing is. */
async function identityAt(path: string): Promise<FileIdentity | null> {
  try {
    return identityOfStats(await lstat(path, { bigint: true }));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

const ownedByCurrentUser = (uid: number | bigint): boolean =>
  typeof process.getuid !== "function" || Number(uid) === process.getuid();
const writableByOthers = (mode: number | bigint): boolean => (Number(mode) & 0o022) !== 0;

/**
 * Renames the file that was read, and only that file, to `<path>.corrupt`.
 *
 * Another TUI may have atomically replaced the path since the read. The path is first
 * moved to a private holding name; if what was moved is not the file that was read it
 * is put back (unless a still newer file already took its place) and the caller reads
 * again.
 */
async function quarantine(
  path: string,
  identity: FileIdentity | null,
): Promise<"quarantined" | "failed" | "replaced"> {
  if (identity === null) return "replaced";
  const holding = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.quarantine`;
  try {
    await rename(path, holding);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "replaced" : "failed";
  }
  const moved = await identityAt(holding);
  const restore = async (): Promise<void> => {
    // link() fails when a newer file is already in place; that one wins and this one is dropped.
    await link(holding, path).catch(() => undefined);
    await rm(holding, { force: true });
  };
  if (moved === null || !sameIdentity(moved, identity)) {
    await restore();
    return "replaced";
  }
  try {
    await rename(holding, `${path}.corrupt`);
    return "quarantined";
  } catch {
    await restore();
    return "failed";
  }
}

/** The state directory must be a real directory, ours, and not writable by others. */
async function inspectStateDirectory(directory: string): Promise<"ok" | "missing" | "unsafe"> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  if (!info.isDirectory() || !ownedByCurrentUser(info.uid) || writableByOthers(info.mode)) return "unsafe";
  return "ok";
}

export interface LoadSavedStateOptions {
  /** Test seam: runs after the file was read and before the decision to quarantine it. */
  readonly afterRead?: () => Promise<void>;
}

const MAX_LOAD_ATTEMPTS = 5;

async function loadOnce(
  path: string,
  options: LoadSavedStateOptions,
): Promise<SavedStateLoadResult | "retry"> {
  const directory = await inspectStateDirectory(dirname(path));
  if (directory === "missing") return { kind: "absent" };
  if (directory === "unsafe") return { kind: "unsafe-directory" };

  const invalid = async (identity: FileIdentity | null): Promise<SavedStateLoadResult | "retry"> => {
    await options.afterRead?.();
    const outcome = await quarantine(path, identity);
    return outcome === "replaced" ? "retry" : { kind: "corrupt", quarantined: outcome === "quarantined" };
  };

  let handle;
  try {
    // O_NOFOLLOW: a symlink at the path is never followed. O_NONBLOCK: a FIFO cannot hang the TUI.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "absent" };
    // A symlink, or a file this user may not read (for example foreign-owned): never followed,
    // never trusted, and moved aside by name, which needs no read permission.
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM") return invalid(await identityAt(path));
    throw error;
  }

  // The handle stays open until the decision is made so the inode number cannot be reused.
  try {
    const info = await handle.stat({ bigint: true });
    const identity = identityOfStats(info);
    if (
      !info.isFile() ||
      info.size > BigInt(MAX_SAVED_STATE_BYTES) ||
      !ownedByCurrentUser(info.uid) ||
      writableByOthers(info.mode)
    ) {
      return await invalid(identity);
    }
    const text = await handle.readFile({ encoding: "utf8" });

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return await invalid(identity);
    }
    if (!isRecord(raw)) return await invalid(identity);

    const version = raw.version;
    if (typeof version === "number" && Number.isSafeInteger(version) && version > SAVED_STATE_VERSION) {
      return { kind: "newer-version", version };
    }

    const migrated = migrateSavedState(raw);
    const state = migrated.ok ? parseSavedState(migrated.value) : null;
    if (state === null) return await invalid(identity);
    return { kind: "loaded", state };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the saved state at `path`. An invalid file is renamed with a `.corrupt` suffix
 * (never a different file that replaced it meanwhile); a file with a newer version is
 * left untouched; a symlinked, foreign-owned or other-writable state directory or file
 * is not trusted.
 */
export async function loadSavedState(
  path: string,
  options: LoadSavedStateOptions = {},
): Promise<SavedStateLoadResult> {
  for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
    const result = await loadOnce(path, options);
    if (result !== "retry") return result;
  }
  // The path kept changing under us; start fresh without claiming a quarantine.
  return { kind: "corrupt", quarantined: false };
}

/**
 * Reads `key` from `target` only when it is an own data property of a plain (non-proxy)
 * object. Accessors, inherited values and proxies are rejected without being invoked, so
 * a caller cannot make anything but the values themselves reach the file.
 */
function ownData(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null || types.isProxy(target)) {
    throw new TypeError("invalid saved TUI state");
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError("invalid saved TUI state");
  }
  return descriptor.value;
}

/** Rebuilds a state from named own data fields only. Throws `TypeError` when the copy is not a valid v1 state. */
function copyNamedFields(state: SavedState): SavedState {
  const list = ownData(state, "sessions");
  if (!Array.isArray(list) || types.isProxy(list)) throw new TypeError("invalid saved TUI state");
  const length = ownData(list, "length");
  if (typeof length !== "number") throw new TypeError("invalid saved TUI state");

  const sessions: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const session = ownData(list, String(index));
    const cursor = ownData(session, "committedCursor");
    sessions.push({
      id: ownData(session, "id"),
      committedCursor: { entryId: ownData(cursor, "entryId"), epoch: ownData(cursor, "epoch") },
    });
  }
  const copy = parseSavedState({
    version: SAVED_STATE_VERSION,
    focusedSessionId: ownData(state, "focusedSessionId"),
    sessions,
  });
  if (copy === null) throw new TypeError("invalid saved TUI state");
  return copy;
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const named = await lstat(directory);
  if (!named.isDirectory()) {
    throw new Error(`${directory} is not a directory (symbolic links are refused)`);
  }
  // chmod through the descriptor of the very directory that was inspected, never through the path.
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.ino !== named.ino || info.dev !== named.dev) {
      throw new Error(`${directory} changed while it was being prepared`);
    }
    if (!ownedByCurrentUser(info.uid)) throw new Error(`${directory} is not owned by the current user`);
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}

/**
 * Writes `state` to `path` atomically: a private temporary file in the same
 * directory, then a rename over the target. Only the allowlisted fields are
 * written, whatever the caller passes in, and never more than the reader accepts.
 */
export async function saveSavedState(path: string, state: SavedState): Promise<void> {
  const text = `${JSON.stringify(copyNamedFields(state))}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_SAVED_STATE_BYTES) {
    throw new RangeError(`saved TUI state exceeds ${MAX_SAVED_STATE_BYTES} bytes`);
  }
  await preparePrivateDirectory(dirname(path));

  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  try {
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
