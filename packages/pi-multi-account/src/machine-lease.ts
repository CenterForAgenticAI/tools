import {
	chmodSync,
	closeSync,
	fstatSync,
	ftruncateSync,
	lstatSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname as readHostname } from "node:os";
import { dirname } from "node:path";

const DEFAULT_TTL_MS = 30_000;
const MAX_RECORD_BYTES = 2_048;
const TOKEN_PATTERN = /^[a-f0-9]{16,128}$/;

export interface MachineLeaseRecord {
	readonly pid: number;
	readonly hostname: string;
	readonly token: string;
	readonly acquiredAtMs: number;
	readonly expiresAtMs: number;
}

export interface MachineLeaseOptions {
	readonly lockPath: string;
	readonly ttlMs?: number;
	/**
	 * Wall clock used for expiry and for the malformed-record age gate. It must
	 * be the same clock as filesystem mtime: the age gate subtracts an mtime
	 * from this, so a clock running ahead of the filesystem ages every record
	 * and can reclaim a live one.
	 */
	readonly now?: () => number;
	readonly pid?: number;
	readonly hostname?: string;
	readonly tokenFactory?: () => string;
	/** Test seam for pausing a stale reclaim before its atomic rename. */
	readonly beforeReclaimRename?: () => void;
	/** Test seam for pausing a stale reclaim before it restores the moved record. */
	readonly beforeReclaimRestore?: () => void;
	/** Test seam for inspecting the complete record after fsync and before publication. */
	readonly beforePublish?: (temporaryPath: string) => void;
	/** Test seam for racing the moved record between release's rename and its verification. */
	readonly beforeReleaseVerify?: (tombstonePath: string) => void;
	/**
	 * Reclaim a lock whose stored record cannot be read, so a contentless or
	 * corrupt lock recovers instead of refusing every caller forever. The
	 * reclaim is additionally gated on a regular file, a finite mtime, an age of
	 * at least this lease's ttl, and the same move-verify-unlink identity check
	 * as a stale reclaim, so it can never displace a live holder.
	 *
	 * That guarantee assumes `now` is the same wall clock as filesystem mtime.
	 * The age gate compares the two directly, so a caller injecting a clock
	 * ahead of the filesystem defeats it. For a valid record the gate is
	 * equivalent to the expiry check anyway, because mtime is the write time
	 * and `expiresAtMs` is that write time plus the ttl, so reclaiming a
	 * malformed record grants nothing an expired one would not.
	 */
	readonly reclaimMalformed?: boolean;
}

export interface MachineLeaseHandle {
	readonly record: MachineLeaseRecord;
	/** The caller must renew before this interval elapses. */
	readonly renewalIntervalMs: number;
	renew(): boolean;
	release(): boolean;
}

function assertFiniteTimestamp(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError(`${name} must be a finite non-negative timestamp.`);
	}
}

function validRecord(value: unknown): value is MachineLeaseRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		typeof record.hostname === "string" &&
		record.hostname.length > 0 &&
		record.hostname.length <= 255 &&
		typeof record.token === "string" &&
		TOKEN_PATTERN.test(record.token) &&
		typeof record.acquiredAtMs === "number" &&
		Number.isFinite(record.acquiredAtMs) &&
		typeof record.expiresAtMs === "number" &&
		Number.isFinite(record.expiresAtMs) &&
		record.acquiredAtMs >= 0 &&
		record.expiresAtMs > record.acquiredAtMs
	);
}

interface RecordSnapshot {
	readonly record: MachineLeaseRecord | undefined;
	readonly raw: string | undefined;
	readonly device: number;
	readonly inode: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly regular: boolean;
}

function snapshotMetadata(identity: ReturnType<typeof fstatSync>): Pick<RecordSnapshot, "device" | "inode" | "size" | "mtimeMs" | "regular"> {
	return {
		device: Number(identity.dev),
		inode: Number(identity.ino),
		size: Number(identity.size),
		mtimeMs: Number(identity.mtimeMs),
		regular: identity.isFile(),
	};
}

function readRecordSnapshot(lockPath: string): RecordSnapshot | undefined {
	let descriptor: number | undefined;
	let metadata: Pick<RecordSnapshot, "device" | "inode" | "size" | "mtimeMs" | "regular"> | undefined;
	try {
		metadata = snapshotMetadata(lstatSync(lockPath));
		if (!metadata.regular) return { record: undefined, raw: undefined, ...metadata };
		descriptor = openSync(lockPath, "r");
		metadata = snapshotMetadata(fstatSync(descriptor));
		const raw = readFileSync(descriptor, "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
			return { record: undefined, raw: undefined, ...metadata };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
		return { record: validRecord(parsed) ? parsed : undefined, raw, ...metadata };
	} catch {
		// Retain stat metadata for a regular file whose contents are currently
		// unreadable. This is the only evidence history may use for guarded reclaim.
		return metadata === undefined ? undefined : { record: undefined, raw: undefined, ...metadata };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function sameSnapshot(left: RecordSnapshot, right: RecordSnapshot): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.regular === right.regular &&
		left.raw === right.raw
	);
}

function sameIdentity(left: RecordSnapshot, right: RecordSnapshot): boolean {
	return left.device === right.device && left.inode === right.inode;
}

/**
 * Puts a record this caller moved aside back at `lockPath`, without ever
 * displacing whatever owns that path now. `rename(2)` cannot express that: it
 * never fails on an existing destination, so it would silently destroy a
 * replacement holder's live lock. Linking refuses with EEXIST instead, and the
 * moved copy is this caller's own isolated file, so it is dropped rather than
 * left as an orphan beside the live lock.
 */
function restoreMovedRecord(movedPath: string, lockPath: string): void {
	try {
		linkSync(movedPath, lockPath);
		unlinkSync(movedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
		try {
			unlinkSync(movedPath);
		} catch {
			// Isolated cleanup of this caller's own copy is best-effort.
		}
	}
}

function writeRecord(
	lockPath: string,
	record: MachineLeaseRecord,
	expected?: RecordSnapshot,
): boolean {
	const encoded = `${JSON.stringify(record)}\n`;
	if (Buffer.byteLength(encoded, "utf8") > MAX_RECORD_BYTES) {
		throw new RangeError("machine lease record exceeds its size bound.");
	}
	const descriptor = openSync(lockPath, "r+");
	try {
		if (expected !== undefined) {
			const identity = fstatSync(descriptor);
			if (identity.dev !== expected.device || identity.ino !== expected.inode) {
				return false;
			}
		}
		ftruncateSync(descriptor, 0);
		writeFileSync(descriptor, encoded, { encoding: "utf8" });
		fsyncSync(descriptor);
		return true;
	} finally {
		closeSync(descriptor);
	}
}

function validateOptions(
	options: MachineLeaseOptions,
): Required<
	Pick<
		MachineLeaseOptions,
		"ttlMs" | "now" | "pid" | "hostname" | "tokenFactory"
	>
> {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	if (!Number.isFinite(ttlMs) || ttlMs < 2_000 || ttlMs > 86_400_000) {
		throw new RangeError(
			"machine lease ttlMs must be between 2000 and 86400000.",
		);
	}
	const pid = options.pid ?? process.pid;
	if (!Number.isSafeInteger(pid) || pid < 1) {
		throw new RangeError("machine lease pid must be a positive safe integer.");
	}
	const hostname = options.hostname ?? readHostname();
	if (hostname.length === 0 || hostname.length > 255) {
		throw new RangeError(
			"machine lease hostname must contain 1 through 255 characters.",
		);
	}
	return {
		ttlMs,
		now: options.now ?? Date.now,
		pid,
		hostname,
		tokenFactory:
			options.tokenFactory ?? (() => randomBytes(16).toString("hex")),
	};
}

/**
 * Acquires the one machine-global lease represented by `lockPath`.
 *
 * Acquisition uses exclusive creation rather than a read-then-write sequence.
 * A stale, valid record may be removed and then retried. Any caller may opt into
 * identity-checked malformed-record reclaim with `reclaimMalformed`; leases that
 * do not opt in leave malformed records alone and stay refused. Losing the race
 * returns undefined without diagnostics: most callers are not holders.
 */
export function acquireMachineLease(
	options: MachineLeaseOptions,
): MachineLeaseHandle | undefined {
	const normalized = validateOptions(options);
	const directory = dirname(options.lockPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const nowMs = normalized.now();
		assertFiniteTimestamp(nowMs, "now");
		const token = normalized.tokenFactory();
		if (!TOKEN_PATTERN.test(token)) {
			throw new TypeError(
				"machine lease tokenFactory returned an invalid token.",
			);
		}
		const record: MachineLeaseRecord = {
			pid: normalized.pid,
			hostname: normalized.hostname,
			token,
			acquiredAtMs: nowMs,
			expiresAtMs: nowMs + normalized.ttlMs,
		};
		const temporaryPath = `${options.lockPath}.${process.pid}.${randomUUID()}.tmp`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(temporaryPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			options.beforePublish?.(temporaryPath);
			linkSync(temporaryPath, options.lockPath);
			return createHandle(
				options.lockPath,
				record,
				normalized.ttlMs,
				normalized.now,
				options.beforeReleaseVerify,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const observed = readRecordSnapshot(options.lockPath);
			if (!observed) return undefined;
			if (observed.record !== undefined) {
				if (observed.record.expiresAtMs > nowMs) return undefined;
			} else {
				const malformedAgeMs = nowMs - observed.mtimeMs;
				if (
					!options.reclaimMalformed ||
					!observed.regular ||
					!Number.isFinite(observed.mtimeMs) ||
					malformedAgeMs < normalized.ttlMs
				) return undefined;
			}
			// Move the observed record out of the way atomically, then verify that
			// the moved inode and all ownership fields are still the record we saw.
			// A contender may reclaim and replace the path while this caller stalls;
			// never unlink that fresh holder's record.
			try {
				options.beforeReclaimRename?.();
			} catch {
				return undefined;
			}
			const stalePath = `${options.lockPath}.${process.pid}.${randomUUID()}.stale`;
			try {
				renameSync(options.lockPath, stalePath);
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
				return undefined;
			}
			const moved = readRecordSnapshot(stalePath);
			if (!moved || !sameSnapshot(observed, moved)) {
				try {
					options.beforeReclaimRestore?.();
				} catch {
					// A failing seam must not change the restore below.
				}
				restoreMovedRecord(stalePath, options.lockPath);
				return undefined;
			}
			try {
				unlinkSync(stalePath);
			} catch {
				restoreMovedRecord(stalePath, options.lockPath);
				return undefined;
			}
		} finally {
			if (descriptor !== undefined) {
				try { closeSync(descriptor); } catch { /* cleanup continues */ }
			}
			try { unlinkSync(temporaryPath); } catch { /* already linked or absent */ }
		}
	}
	return undefined;
}

function createHandle(
	lockPath: string,
	initial: MachineLeaseRecord,
	ttlMs: number,
	now: () => number,
	beforeReleaseVerify?: (tombstonePath: string) => void,
): MachineLeaseHandle {
	let record = initial;
	let released = false;
	return {
		get record() {
			return record;
		},
		renewalIntervalMs: Math.max(1_000, Math.floor(ttlMs / 3)),
		renew(): boolean {
			if (released) return false;
			const current = readRecordSnapshot(lockPath);
			if (!current?.record || current.record.token !== record.token) return false;
			const nowMs = now();
			try {
				assertFiniteTimestamp(nowMs, "now");
				if (current.record.expiresAtMs <= nowMs) return false;
				const renewed: MachineLeaseRecord = {
					...record,
					acquiredAtMs: current.record.acquiredAtMs,
					expiresAtMs: nowMs + ttlMs,
				};
				if (!writeRecord(lockPath, renewed, current)) return false;
				const after = readRecordSnapshot(lockPath);
				if (
					!after?.record ||
					after.record.token !== record.token ||
					!sameIdentity(after, current)
				) {
					return false;
				}
				record = after.record;
				return true;
			} catch {
				return false;
			}
		},
		release(): boolean {
			if (released) return false;
			const current = readRecordSnapshot(lockPath);
			if (!current?.record || current.record.token !== record.token) {
				released = true;
				return false;
			}
			const tombstone = `${lockPath}.${process.pid}.${randomUUID()}.release`;
			try {
				renameSync(lockPath, tombstone);
			} catch {
				released = true;
				return false;
			}
			try {
				beforeReleaseVerify?.(tombstone);
			} catch {
				// A failing seam must not change the verification below.
			}
			const moved = readRecordSnapshot(tombstone);
			if (
				!moved?.record ||
				moved.record.token !== record.token ||
				!sameIdentity(moved, current)
			) {
				// This caller moved a record it does not own, so put it back -- but
				// only if nothing has taken the path since. A replacement's live lock
				// is never overwritten, and the moved copy is never left orphaned.
				restoreMovedRecord(tombstone, lockPath);
				released = true;
				return false;
			}
			try {
				unlinkSync(tombstone);
				released = true;
				return true;
			} catch {
				// The tombstone survived, so this lease record is restored under the
				// same rule: keep it only while the path is still free.
				restoreMovedRecord(tombstone, lockPath);
				return false;
			}
		},
	};
}

export const MACHINE_LEASE_TTL_MS = DEFAULT_TTL_MS;
