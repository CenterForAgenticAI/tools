import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** Owner-only permissions for state-plane directories and lock directories. */
export const STATE_DIRECTORY_MODE = 0o700;
/** Owner-only permissions for state-plane files and lock metadata. */
export const STATE_FILE_MODE = 0o600;

const LOCK_DIRECTORY_SUFFIX = ".lockdir";
const LOCK_METADATA_SUFFIX = ".owner.json";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const LOCK_RETRY_INITIAL_MS = 2;
const LOCK_RETRY_MAX_MS = 100;

/** Internal fault seam used by state-lock crash-safety tests. */
export const __testHooks: {
	beforeStateLockPublish?: () => void;
	beforeStateFilePublish?: (file: string) => void;
	beforeCorruptFilePreserve?: (file: string) => void;
} = {};

export interface StateLockOptions {
	timeoutMs?: number;
	staleAfterMs?: number;
}

export class StateLockTimeoutError extends Error {
	readonly target: string;
	readonly timeoutMs: number;

	constructor(target: string, timeoutMs: number) {
		super(`timed out acquiring state lock for ${target} after ${timeoutMs}ms`);
		this.name = "StateLockTimeoutError";
		this.target = target;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Refusal is the deliberate degradation when a target filesystem cannot retain
 * mode 0700. State and scratch data may contain private prompts or credentials,
 * so callers must never continue under a wider, unverifiable directory mode.
 */
export class OwnerOnlyDirectoryCapabilityError extends Error {
	readonly directory: string;
	readonly observedMode: number | undefined;

	constructor(directory: string, observedMode?: number) {
		const observed = observedMode === undefined
			? "the enforced mode could not be read back"
			: `the enforced mode read back as ${observedMode.toString(8).padStart(4, "0")}`;
		super(
			`cannot enforce owner-only directory mode 0700 for ${directory}: ${observed}; ` +
			"refusing to persist private state without the owner-only guarantee. " +
			"Use a filesystem that can represent and read back POSIX mode 0700.",
		);
		this.name = "OwnerOnlyDirectoryCapabilityError";
		this.directory = directory;
		this.observedMode = observedMode;
	}
}

export type StateReadResult<T> =
	| { kind: "ok"; value: T }
	| { kind: "absent" }
	| { kind: "corrupt"; error: Error };

interface LockMetadata {
	pid: number;
	hostname: string;
	token: string;
	createdAt: number;
}

interface LockInspection {
	metadata?: LockMetadata;
	malformed: boolean;
	entries: string[];
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLockMetadata(value: unknown): value is LockMetadata {
	if (!isRecord(value)) return false;
	return (
		typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
		typeof value.hostname === "string" && value.hostname.length > 0 &&
		typeof value.token === "string" && value.token.length > 0 &&
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt > 0
	);
}

export function resolveDelegateStateDir(agentDir: string): string {
	return path.join(agentDir, "extensions", "pi-delegate");
}

type OwnerOnlyDirectoryEnforcement =
	| { readonly kind: "enforced" }
	| { readonly kind: "identity-mismatch" }
	| { readonly kind: "capability-unavailable"; readonly observedMode?: number };

export function ensureOwnerOnlyDirectory(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
	const observed = fs.lstatSync(directory);
	if (!observed.isDirectory() || observed.isSymbolicLink()) {
		throw new Error(`owner-only directory identity changed during enforcement: ${directory}`);
	}
	const enforcement = enforceOwnerOnlyDirectory(directory, { dev: observed.dev, ino: observed.ino });
	if (enforcement.kind === "capability-unavailable") {
		throw new OwnerOnlyDirectoryCapabilityError(directory, enforcement.observedMode);
	}
	if (enforcement.kind !== "enforced") {
		throw new Error(`owner-only directory identity changed during enforcement: ${directory}`);
	}
}

export interface DirectoryIdentity {
	readonly dev: number;
	readonly ino: number;
}

function sameDirectoryIdentity(stat: fs.Stats, expected: DirectoryIdentity): boolean {
	return stat.dev === expected.dev && stat.ino === expected.ino;
}

function enforceOwnerOnlyDirectory(
	directory: string,
	expected: DirectoryIdentity,
): OwnerOnlyDirectoryEnforcement {
	let fd: number | undefined;
	try {
		const before = fs.lstatSync(directory);
		if (!before.isDirectory() || before.isSymbolicLink() || !sameDirectoryIdentity(before, expected)) {
			return { kind: "identity-mismatch" };
		}
		fd = fs.openSync(
			directory,
			fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
		);
		const opened = fs.fstatSync(fd);
		if (!opened.isDirectory() || !sameDirectoryIdentity(opened, expected)) {
			return { kind: "identity-mismatch" };
		}
		let enforced: fs.Stats;
		try {
			fs.fchmodSync(fd, STATE_DIRECTORY_MODE);
			enforced = fs.fstatSync(fd);
		} catch {
			return { kind: "capability-unavailable" };
		}
		if (!enforced.isDirectory() || !sameDirectoryIdentity(enforced, expected)) {
			return { kind: "identity-mismatch" };
		}
		const observedMode = enforced.mode & 0o777;
		if (observedMode !== STATE_DIRECTORY_MODE) {
			return { kind: "capability-unavailable", observedMode };
		}
		const current = fs.lstatSync(directory);
		return current.isDirectory() && !current.isSymbolicLink() && sameDirectoryIdentity(current, expected)
			? { kind: "enforced" }
			: { kind: "identity-mismatch" };
	} catch {
		return { kind: "identity-mismatch" };
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* best-effort descriptor close */ }
		}
	}
}

/** Enforce mode through a no-follow descriptor and require the pathname to keep the expected identity. */
export function enforceOwnerOnlyDirectoryIdentity(directory: string, expected: DirectoryIdentity): boolean {
	return enforceOwnerOnlyDirectory(directory, expected).kind === "enforced";
}

/** Create one new owner-only directory; fail rather than adopt an existing path. */
export function createOwnerOnlyDirectory(directory: string): DirectoryIdentity {
	fs.mkdirSync(directory, { recursive: false, mode: STATE_DIRECTORY_MODE });
	const created = fs.lstatSync(directory);
	const identity = { dev: created.dev, ino: created.ino };
	if (!created.isDirectory() || created.isSymbolicLink()) {
		throw new Error(`owner-only directory identity changed during creation: ${directory}`);
	}
	const enforcement = enforceOwnerOnlyDirectory(directory, identity);
	if (enforcement.kind === "capability-unavailable") {
		throw new OwnerOnlyDirectoryCapabilityError(directory, enforcement.observedMode);
	}
	if (enforcement.kind !== "enforced") {
		throw new Error(`owner-only directory identity changed during creation: ${directory}`);
	}
	return identity;
}

export function ensureOwnerOnlyFile(file: string): void {
	fs.chmodSync(file, STATE_FILE_MODE);
}

export function readUtf8File(file: string): StateReadResult<string> {
	try {
		return { kind: "ok", value: fs.readFileSync(file, "utf8") };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		return { kind: "corrupt", error: asError(error) };
	}
}

export function readJsonFile(file: string): StateReadResult<unknown> {
	const result = readUtf8File(file);
	if (result.kind !== "ok") return result;
	try {
		return { kind: "ok", value: JSON.parse(result.value) as unknown };
	} catch (error) {
		return { kind: "corrupt", error: asError(error) };
	}
}

/**
 * Move a corrupt state file beside itself before a caller recovers. The source
 * path is never deleted silently, and a second call sees the source as absent.
 */
export function preserveCorruptFile(file: string): string | undefined {
	try {
		__testHooks.beforeCorruptFilePreserve?.(file);
		const source = fs.lstatSync(file);
		if (!source.isFile()) return undefined;
		const stamp = Date.now();
		let candidate = `${file}.corrupt-${stamp}`;
		let suffix = 0;
		while (fs.existsSync(candidate)) {
			suffix += 1;
			candidate = `${file}.corrupt-${stamp}-${suffix}`;
		}
		fs.renameSync(file, candidate);
		try {
			ensureOwnerOnlyFile(candidate);
		} catch {
			/* Preserve the source even if a mode reassertion is unavailable. */
		}
		return candidate;
	} catch {
		return undefined;
	}
}

function uniqueTemporaryPath(file: string): string {
	return `${file}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
}

function syncFile(file: string): void {
	const descriptor = fs.openSync(file, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

export function replaceTextFile(file: string, contents: string): void {
	ensureOwnerOnlyDirectory(path.dirname(file));
	const temporary = uniqueTemporaryPath(file);
	try {
		fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: STATE_FILE_MODE, flag: "wx" });
		ensureOwnerOnlyFile(temporary);
		syncFile(temporary);
		__testHooks.beforeStateFilePublish?.(file);
		fs.renameSync(temporary, file);
		ensureOwnerOnlyFile(file);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			/* best-effort cleanup; preserve the original failure */
		}
		throw error;
	}
}

export function replaceJsonFile(file: string, value: unknown): void {
	replaceTextFile(file, JSON.stringify(value, null, 2));
}

export function appendJsonLine(file: string, value: unknown): void {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("cannot append undefined as a JSONL value");
	ensureOwnerOnlyDirectory(path.dirname(file));
	fs.appendFileSync(file, `${serialized}\n`, { encoding: "utf8", mode: STATE_FILE_MODE });
	ensureOwnerOnlyFile(file);
}

function lockPath(target: string): string {
	return `${target}${LOCK_DIRECTORY_SUFFIX}`;
}

function metadataName(token: string): string {
	return `${token}${LOCK_METADATA_SUFFIX}`;
}

function metadataPath(directory: string, token: string): string {
	return path.join(directory, metadataName(token));
}

function inspectLock(directory: string): LockInspection {
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { malformed: false, entries: [] };
		return { malformed: true, entries: [] };
	}
	if (entries.length === 0) return { malformed: false, entries };
	if (entries.length !== 1 || !entries[0]!.endsWith(LOCK_METADATA_SUFFIX)) {
		return { malformed: true, entries };
	}
	const owner = readUtf8File(path.join(directory, entries[0]!));
	if (owner.kind === "absent") return { malformed: true, entries };
	if (owner.kind === "corrupt") return { malformed: true, entries };
	try {
		const parsed: unknown = JSON.parse(owner.value);
		return isLockMetadata(parsed) && entries[0] === metadataName(parsed.token)
			? { metadata: parsed, malformed: false, entries }
			: { malformed: true, entries };
	} catch {
		return { malformed: true, entries };
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function sleepForRetry(milliseconds: number): void {
	if (milliseconds <= 0) return;
	const signal = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(signal, 0, 0, milliseconds);
}

function removeDeadOwnerLock(directory: string, token: string): boolean {
	const current = inspectLock(directory);
	if (current.metadata?.token !== token) return false;
	try {
		fs.unlinkSync(metadataPath(directory, token));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return false;
	}
	try {
		fs.rmdirSync(directory);
		return true;
	} catch (error) {
		// A successor or an unexpected entry makes the non-recursive removal fail.
		return errorCode(error) === "ENOENT";
	}
}

function reclaimStaleLock(directory: string, staleAfterMs: number): boolean {
	const inspection = inspectLock(directory);
	if (inspection.metadata) {
		const sameHost = inspection.metadata.hostname === os.hostname();
		if (sameHost) {
			// A same-host dead PID is definitive. Reclaim it without waiting for
			// mtime, while a live PID is never reclaimed.
			return processIsAlive(inspection.metadata.pid)
				? false
				: removeDeadOwnerLock(directory, inspection.metadata.token);
		}
		// A different host may have a valid PID we cannot inspect. Mtime is the
		// only safe recovery signal in that case.
		let modifiedAt: number;
		try {
			modifiedAt = fs.statSync(directory).mtimeMs;
		} catch (error) {
			return errorCode(error) === "ENOENT";
		}
		if (Date.now() - modifiedAt < staleAfterMs) return false;
		return removeDeadOwnerLock(directory, inspection.metadata.token);
	}

	let modifiedAt: number;
	try {
		modifiedAt = fs.statSync(directory).mtimeMs;
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
	if (Date.now() - modifiedAt < staleAfterMs) return false;
	if (inspection.malformed || inspection.entries.length !== 0) return false;
	try {
		fs.rmdirSync(directory);
		return true;
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
}

function uniqueTemporaryDirectory(directory: string): string {
	return `${directory}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
}

function publishLock(directory: string, metadata: LockMetadata): boolean {
	const temporary = uniqueTemporaryDirectory(directory);
	let created = false;
	try {
		fs.mkdirSync(temporary, { mode: STATE_DIRECTORY_MODE });
		created = true;
		fs.chmodSync(temporary, STATE_DIRECTORY_MODE);
		const metadataFile = metadataPath(temporary, metadata.token);
		fs.writeFileSync(metadataFile, JSON.stringify(metadata), {
			encoding: "utf8",
			mode: STATE_FILE_MODE,
			flag: "wx",
		});
		ensureOwnerOnlyFile(metadataFile);
		// Lock metadata is advisory and generation-specific. The canonical lock
		// directory is published atomically below, so fsyncing this private
		// metadata file only adds latency to every uncontended acquisition.
		__testHooks.beforeStateLockPublish?.();
		try {
			fs.renameSync(temporary, directory);
			return true;
		} catch (error) {
			const code = errorCode(error);
			if (code === "EEXIST" || code === "ENOTEMPTY") return false;
			throw error;
		}
	} finally {
		if (created) {
			try {
				fs.rmSync(temporary, { recursive: true, force: true });
			} catch {
				/* best-effort private temp cleanup */
			}
		}
	}
}

function acquireLock(target: string, timeoutMs: number, staleAfterMs: number): { directory: string; metadata: LockMetadata } {
	const directory = lockPath(target);
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	for (;;) {
		ensureOwnerOnlyDirectory(path.dirname(directory));
		const metadata: LockMetadata = {
			pid: process.pid,
			hostname: os.hostname(),
			token: randomBytes(16).toString("hex"),
			createdAt: Date.now(),
		};
		if (publishLock(directory, metadata)) return { directory, metadata };

		if (reclaimStaleLock(directory, staleAfterMs)) {
			attempt = 0;
			continue;
		}
		if (Date.now() >= deadline) throw new StateLockTimeoutError(target, timeoutMs);
		const base = Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_INITIAL_MS * (2 ** Math.min(attempt, 6)));
		const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
		sleepForRetry(Math.min(LOCK_RETRY_MAX_MS, base + jitter));
		attempt += 1;
	}
}

function releaseLock(lock: { directory: string; metadata: LockMetadata }): void {
	const current = inspectLock(lock.directory);
	if (
		current.metadata?.token !== lock.metadata.token ||
		current.metadata.pid !== lock.metadata.pid ||
		current.metadata.hostname !== lock.metadata.hostname
	) {
		return;
	}
	try {
		fs.unlinkSync(metadataPath(lock.directory, lock.metadata.token));
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return;
	}
	try {
		fs.rmdirSync(lock.directory);
	} catch {
		/* Never recursively remove a non-empty lock directory. */
	}
}

export function withStateFileLock<T>(
	target: string,
	operation: () => T,
	options: StateLockOptions = {},
): T {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("state lock timeout must be non-negative");
	if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new RangeError("state lock stale threshold must be non-negative");
	const lock = acquireLock(target, timeoutMs, staleAfterMs);
	try {
		return operation();
	} finally {
		releaseLock(lock);
	}
}

/**
 * Attempt one lock generation without waiting. Synchronous hot paths use this
 * to divert work that needs a rewrite to an append-only fallback instead of
 * blocking the foreground event loop behind another process.
 */
export function tryWithStateFileLock<T>(
	target: string,
	operation: () => T,
	options: Omit<StateLockOptions, "timeoutMs"> = {},
): { acquired: true; value: T } | { acquired: false } {
	try {
		return {
			acquired: true,
			value: withStateFileLock(target, operation, { ...options, timeoutMs: 0 }),
		};
	} catch (error) {
		if (error instanceof StateLockTimeoutError) return { acquired: false };
		throw error;
	}
}
