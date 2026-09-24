import { constants as bufferConstants } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
	iterateBoundedFileLines,
	normalizedFileReadChunkBytes,
} from "./bounded-file-lines.js";
import { acquireMachineLease, type MachineLeaseHandle } from "./machine-lease.js";

const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 1_024;
const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const WINDOW_HISTORY_MAX_BYTES = 128 * 1024 * 1024;
const COST_HISTORY_MAX_BYTES = Math.min(
	512 * 1024 * 1024,
	bufferConstants.MAX_STRING_LENGTH,
);

export type HistoryRecordType = "window-sample" | "cost-delta";

export interface HistoryRecordEnvelope {
	readonly schemaVersion: number;
	readonly recordType: HistoryRecordType;
	readonly stableId: string;
	readonly observedAtMs: number;
	readonly recordedAtMs: number;
	readonly payload: unknown;
}

export interface HistoryGapRecord {
	readonly schemaVersion: number;
	readonly recordType: "gap";
	readonly gapStartMs: number;
	readonly gapEndMs: number;
	readonly reason: string;
}

export type HistoryLogRecord = HistoryRecordEnvelope | HistoryGapRecord;

/**
 * Lock-acquisition retry budget.
 *
 * Production defaults spend ~60s of real time exhausting 30 retries, which is
 * correct for a contended machine-global lock but far too slow for a test that
 * deliberately holds the lock to observe refusal. Tests inject a small budget;
 * nothing else should override it.
 */
export interface HistoryLockExhaustion {
	readonly lockPath: string;
	readonly elapsedMs: number;
}

interface HistoryRetryBudget {
	readonly maxRetries?: number;
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
}

interface HistoryStoreOptions {
	readonly windowHistoryPath: string;
	readonly costHistoryPath: string;
	readonly lockPath: string;
	readonly now?: () => number;
	/** Override lock-acquisition retry budget (for testing). */
	readonly retryBudget?: HistoryRetryBudget;
	/** Override window history capacity ceiling (for testing). */
	readonly windowMaxBytes?: number;
	/** Override cost history capacity ceiling (for testing). */
	readonly costMaxBytes?: number;
	/**
	 * Override expected base directory for path validation (for testing).
	 * Defaults to dirname of the default window/cost history paths.
	 * Tests with custom paths should set this to their test base directory.
	 */
	readonly expectedBase?: string;
	/** Test seam for pausing append after acquiring lock but before writing. */
	readonly beforeAppend?: () => void;
	/** Bounded diagnostic callback after cooperative lock retries exhaust. */
	readonly onLockExhausted?: (details: HistoryLockExhaustion) => void;
	/** Test seam for changing the target after validation but before compaction reads. */
	readonly beforeCompactionRead?: () => void;
	/** Test seam for pausing compaction after final read/stat but before atomic rename. */
	readonly beforeCompactionRename?: () => void;
	/** Override bounded sequential read size (for testing). */
	readonly readChunkBytes?: number;
	/** Observe each bounded sequential read without receiving retained contents (for testing). */
	readonly onReadChunk?: (bytes: number) => void;
}

function defaultHistoryPaths(): Pick<HistoryStoreOptions, "windowHistoryPath" | "costHistoryPath" | "lockPath"> {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ??
		join(process.env.HOME ?? ".", ".pi", "agent");
	// Package storage identity stays decoupled from the logical provider ID.
	const baseDir = join(agentDir, "pi-multi-account");
	return {
		windowHistoryPath: join(baseDir, "window-history.ndjson"),
		costHistoryPath: join(baseDir, "cost-history.ndjson"),
		lockPath: join(baseDir, "history.lock"),
	};
}

/**
 * Validate that a target path is safe for appending:
 * - Not a symlink (reject symlinked files)
 * - Within the store directory (reject traversal)
 * 
 * REQ-STORE-PERMISSIONS: symlink write-through protection and traversal rejection.
 * Uses path.relative() containment check: resolved target must be within resolved base.
 * Store directory must NOT be a symlink (same write-through class as symlinked file).
 */
function validateAppendPath(targetPath: string, storeDir: string): boolean {
	try {
		// REQ-STORE-PERMISSIONS: Reject symlinked store directory
		// A symlinked store dir pointing at victim/ would make resolvedBase = victim/,
		// passing containment and landing writes there. Reject it.
		const storeDirStats = lstatSync(storeDir);
		if (storeDirStats.isSymbolicLink()) {
			// Store directory is a symlink - REJECT
			return false;
		}
		
		const resolvedBase = realpathSync(storeDir);
		
		// Check if target file exists
		let resolvedTarget: string;
		try {
			const stats = lstatSync(targetPath);
			if (stats.isSymbolicLink()) {
				// File is a symlink - REJECT
				return false;
			}
			// File exists and is not a symlink - resolve it
			resolvedTarget = realpathSync(targetPath);
		} catch {
			// File doesn't exist - resolve parent and rejoin basename
			const targetParent = dirname(targetPath);
			const targetName = basename(targetPath);
			const resolvedParent = realpathSync(targetParent);
			resolvedTarget = join(resolvedParent, targetName);
		}
		
		// Check containment: resolved target must be within resolved base
		const rel = relative(resolvedBase, resolvedTarget);
		
		// Valid if:
		// - Non-empty (target is not the base itself - history files are children)
		// - Doesn't start with '..' (not outside base)
		// - Not absolute (relative() returned an absolute path = different roots)
		if (!rel || rel.startsWith('..') || relative(resolvedBase, resolvedTarget).startsWith('/')) {
			return false;
		}
		
		return true;
	} catch {
		// Any resolution error is a validation failure
		return false;
	}
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

async function sleepRealClock(ms: number): Promise<void> {
	if (ms <= 0) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		return;
	}
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function monotonicMilliseconds(): number {
	return Number(process.hrtime.bigint()) / 1_000_000;
}

async function acquireHistoryLockAsync(
	lockPath: string,
	nowFn: () => number,
	retryBudget: HistoryRetryBudget | undefined,
	onLockExhausted: ((details: HistoryLockExhaustion) => void) | undefined,
): Promise<MachineLeaseHandle | undefined> {
	const startedAt = monotonicMilliseconds();
	const maxRetries = retryBudget?.maxRetries ?? 30;
	const initialDelayMs = retryBudget?.initialDelayMs ?? 50;
	const maxDelayMs = retryBudget?.maxDelayMs ?? 2000;
	let delayMs = initialDelayMs;
	for (let retry = 0; retry < maxRetries; retry += 1) {
		const lease = acquireMachineLease({
			lockPath,
			ttlMs: 30_000,
			now: nowFn,
			reclaimMalformed: true,
		});
		if (lease) return lease;
		if (retry < maxRetries - 1) {
			const jitter = Math.floor(Math.random() * (delayMs / 2));
			await sleepRealClock(delayMs + jitter);
			delayMs = Math.min(delayMs * 2, maxDelayMs);
		}
	}
	try {
		onLockExhausted?.({
			lockPath,
			elapsedMs: Math.max(0, Math.round(monotonicMilliseconds() - startedAt)),
		});
	} catch {
		// Diagnostics are fail-soft and must not change storage behavior.
	}
	return undefined;
}

function validRecordEnvelope(value: unknown): value is HistoryRecordEnvelope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === SCHEMA_VERSION &&
		(record.recordType === "window-sample" || record.recordType === "cost-delta") &&
		typeof record.stableId === "string" &&
		record.stableId.length > 0 &&
		record.stableId.length <= 256 &&
		typeof record.observedAtMs === "number" &&
		Number.isFinite(record.observedAtMs) &&
		record.observedAtMs >= 0 &&
		typeof record.recordedAtMs === "number" &&
		Number.isFinite(record.recordedAtMs) &&
		record.recordedAtMs >= 0 &&
		record.payload !== undefined
	);
}

function validGapRecord(value: unknown): value is HistoryGapRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === SCHEMA_VERSION &&
		record.recordType === "gap" &&
		typeof record.gapStartMs === "number" &&
		Number.isFinite(record.gapStartMs) &&
		record.gapStartMs >= 0 &&
		typeof record.gapEndMs === "number" &&
		Number.isFinite(record.gapEndMs) &&
		record.gapEndMs >= record.gapStartMs &&
		typeof record.reason === "string" &&
		record.reason.length > 0 &&
		record.reason.length <= 256
	);
}

function validHistoryRecord(value: unknown): value is HistoryLogRecord {
	return validRecordEnvelope(value) || validGapRecord(value);
}

function parseHistoryLine(line: string): HistoryLogRecord | undefined {
	if (line.trim().length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;

		// Readers expose unrecognized schema versions without rewriting the log.
		if (
			typeof record.schemaVersion === "number" &&
			record.schemaVersion !== SCHEMA_VERSION
		) {
			return parsed as HistoryLogRecord;
		}
		if (validHistoryRecord(parsed)) return parsed;

		// Readers also expose unrecognized record types in the current schema.
		return record.schemaVersion === SCHEMA_VERSION
			? (parsed as HistoryLogRecord)
			: undefined;
	} catch {
		// One malformed line must not hide later records.
		return undefined;
	}
}

function isExpired(timestampMs: number, nowMs: number): boolean {
	return nowMs - timestampMs > RETENTION_MS;
}

/** Preserve retained lines exactly; only recognized expired records are removed. */
function retainHistoryLine(line: Buffer, nowMs: number): boolean {
	let decoded: string;
	try {
		decoded = FATAL_UTF8_DECODER.decode(line);
	} catch {
		return true;
	}
	if (decoded.trim().length === 0) return true;
	try {
		const parsed: unknown = JSON.parse(decoded);
		if (validRecordEnvelope(parsed)) {
			return !isExpired(parsed.recordedAtMs, nowMs);
		}
		if (validGapRecord(parsed)) {
			return !isExpired(parsed.gapEndMs, nowMs);
		}
	} catch {
		// Malformed or partial content is preserved rather than rewritten.
	}
	return true;
}

function writeBuffer(descriptor: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
		if (written < 1) throw new Error("History compaction write made no progress.");
		offset += written;
	}
}

function streamRetainedHistory(options: {
	readonly sourceDescriptor: number;
	readonly targetDescriptor?: number;
	readonly nowMs: number;
	readonly chunkBytes: number;
	readonly onReadChunk: (bytes: number) => void;
	readonly renewLease: () => boolean;
}): { readonly changed: boolean; readonly retainedBytes: number } {
	const readBuffer = Buffer.allocUnsafe(options.chunkBytes);
	const newline = Buffer.from("\n");
	let fragments: Buffer[] = [];
	let lineBytes = 0;
	let oversized = false;
	let changed = false;
	let retainedBytes = 0;
	let bytesSinceRenewal = 0;

	const retainBytes = (bytes: Buffer): void => {
		if (options.targetDescriptor !== undefined) {
			writeBuffer(options.targetDescriptor, bytes);
		}
		retainedBytes += bytes.length;
	};
	const addSegment = (segment: Buffer): void => {
		if (segment.length === 0) return;
		if (oversized) {
			retainBytes(segment);
			return;
		}
		if (lineBytes + segment.length > MAX_RECORD_BYTES) {
			for (const fragment of fragments) retainBytes(fragment);
			retainBytes(segment);
			fragments = [];
			lineBytes = 0;
			oversized = true;
			return;
		}
		fragments.push(Buffer.from(segment));
		lineBytes += segment.length;
	};
	const finishLine = (terminated: boolean): void => {
		if (oversized) {
			if (terminated) retainBytes(newline);
		} else {
			const line = Buffer.concat(fragments, lineBytes);
			if (retainHistoryLine(line, options.nowMs)) {
				retainBytes(line);
				if (terminated) retainBytes(newline);
			} else {
				changed = true;
			}
		}
		fragments = [];
		lineBytes = 0;
		oversized = false;
	};

	while (true) {
		const bytesRead = readSync(
			options.sourceDescriptor,
			readBuffer,
			0,
			readBuffer.length,
			null,
		);
		if (bytesRead === 0) break;
		options.onReadChunk(bytesRead);
		bytesSinceRenewal += bytesRead;
		if (bytesSinceRenewal >= 8 * 1024 * 1024) {
			if (!options.renewLease()) {
				throw new Error("History lease ownership changed during compaction.");
			}
			bytesSinceRenewal = 0;
		}
		let segmentStart = 0;
		for (let index = 0; index < bytesRead; index += 1) {
			if (readBuffer[index] !== 0x0a) continue;
			addSegment(readBuffer.subarray(segmentStart, index));
			finishLine(true);
			segmentStart = index + 1;
		}
		addSegment(readBuffer.subarray(segmentStart, bytesRead));
	}
	if (fragments.length > 0 || oversized) finishLine(false);
	return { changed, retainedBytes };
}

function appendEncodedUnderLease(options: {
	readonly targetPath: string;
	readonly maxBytes: number;
	readonly encoded: string;
	readonly recordBytes: number;
	readonly expectedBase: string;
	readonly nowMs: number;
	readonly beforeAppend: () => void;
	readonly beforeCompactionRead: () => void;
	readonly beforeCompactionRename: () => void;
	readonly readChunkBytes: number;
	readonly onReadChunk: (bytes: number) => void;
	readonly renewLease: () => boolean;
}): boolean {
	const markerPath = retentionMarkerPath(options.targetPath);
	if (!validateAppendPath(markerPath, options.expectedBase)) return false;
	let compacted = false;
	if (retentionCheckDue(markerPath, options.nowMs)) {
		if (
			!compactHistoryUnderLease({
				targetPath: options.targetPath,
				maxBytes: options.maxBytes,
				nowMs: options.nowMs,
				beforeRead: options.beforeCompactionRead,
				beforeRename: options.beforeCompactionRename,
				readChunkBytes: options.readChunkBytes,
				onReadChunk: options.onReadChunk,
				renewLease: options.renewLease,
			})
		) {
			return false;
		}
		recordRetentionCheck(markerPath, options.nowMs);
		compacted = true;
	}

	options.beforeAppend();
	let currentSize = 0;
	try {
		currentSize = statSync(options.targetPath).size;
	} catch {
		// File doesn't exist yet.
	}
	if (currentSize + options.recordBytes > options.maxBytes && !compacted) {
		if (
			!compactHistoryUnderLease({
				targetPath: options.targetPath,
				maxBytes: options.maxBytes,
				nowMs: options.nowMs,
				beforeRead: options.beforeCompactionRead,
				beforeRename: options.beforeCompactionRename,
				readChunkBytes: options.readChunkBytes,
				onReadChunk: options.onReadChunk,
				renewLease: options.renewLease,
			})
		) {
			return false;
		}
		try {
			currentSize = statSync(options.targetPath).size;
		} catch {
			currentSize = 0;
		}
	}
	if (currentSize + options.recordBytes > options.maxBytes) return false;

	appendFileSync(options.targetPath, options.encoded, {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(options.targetPath, 0o600);
	return true;
}

function retentionMarkerPath(targetPath: string): string {
	return `${targetPath}.retention`;
}

function retentionDayStart(nowMs: number): number {
	return Math.floor(Math.max(0, nowMs) / DAY_MS) * DAY_MS;
}

function retentionCheckDue(markerPath: string, nowMs: number): boolean {
	try {
		const value = Number(readFileSync(markerPath, "utf8").trim());
		return value !== retentionDayStart(nowMs);
	} catch {
		return true;
	}
}

function recordRetentionCheck(markerPath: string, nowMs: number): void {
	writeFileSync(markerPath, `${retentionDayStart(nowMs)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(markerPath, 0o600);
}

/** Rewrite one store while the caller holds the dedicated history lock. */
function compactHistoryUnderLease(options: {
	readonly targetPath: string;
	readonly maxBytes: number;
	readonly nowMs: number;
	readonly beforeRead: () => void;
	readonly beforeRename: () => void;
	readonly renewLease: () => boolean;
	readonly readChunkBytes: number;
	readonly onReadChunk: (bytes: number) => void;
}): boolean {
	let sourceDescriptor: number | undefined;
	try {
		options.beforeRead();
		sourceDescriptor = openSync(options.targetPath, "r");
	} catch (error) {
		return isMissingPathError(error) && options.renewLease();
	}

	const temporaryPath = `${options.targetPath}.${process.pid}.${randomUUID()}.tmp`;
	let targetDescriptor: number | undefined;
	let published = false;
	try {
		const scan = streamRetainedHistory({
			sourceDescriptor,
			nowMs: options.nowMs,
			chunkBytes: options.readChunkBytes,
			onReadChunk: options.onReadChunk,
			renewLease: options.renewLease,
		});
		closeSync(sourceDescriptor);
		sourceDescriptor = undefined;
		if (scan.retainedBytes > options.maxBytes) return false;
		if (!scan.changed) return options.renewLease();

		sourceDescriptor = openSync(options.targetPath, "r");
		targetDescriptor = openSync(temporaryPath, "wx", 0o600);
		const copy = streamRetainedHistory({
			sourceDescriptor,
			targetDescriptor,
			nowMs: options.nowMs,
			chunkBytes: options.readChunkBytes,
			onReadChunk: options.onReadChunk,
			renewLease: options.renewLease,
		});
		closeSync(sourceDescriptor);
		sourceDescriptor = undefined;
		if (!copy.changed || copy.retainedBytes !== scan.retainedBytes) return false;
		fsyncSync(targetDescriptor);
		closeSync(targetDescriptor);
		targetDescriptor = undefined;
		options.beforeRename();
		if (!options.renewLease()) {
			throw new Error("History lease ownership changed before publication.");
		}
		renameSync(temporaryPath, options.targetPath);
		published = true;
		chmodSync(options.targetPath, 0o600);
		return true;
	} catch {
		return false;
	} finally {
		if (sourceDescriptor !== undefined) {
			try {
				closeSync(sourceDescriptor);
			} catch {
				// Continue with temporary-file cleanup.
			}
		}
		if (targetDescriptor !== undefined) {
			try {
				closeSync(targetDescriptor);
			} catch {
				// Continue with temporary-file cleanup.
			}
		}
		if (!published) {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// Best-effort cleanup; the source file remains authoritative.
			}
		}
	}
}

/**
 * Append one history record under the cooperative machine-global history lease.
 * The lease remains held through retention, compaction, and append publication.
 */
export async function appendHistory(
	record: HistoryRecordEnvelope,
	options?: Partial<HistoryStoreOptions>,
): Promise<boolean> {
	const defaults = defaultHistoryPaths();
	const normalized = {
		windowHistoryPath: options?.windowHistoryPath ?? defaults.windowHistoryPath,
		costHistoryPath: options?.costHistoryPath ?? defaults.costHistoryPath,
		lockPath: options?.lockPath ?? defaults.lockPath,
		now: options?.now ?? Date.now,
		windowMaxBytes: options?.windowMaxBytes ?? WINDOW_HISTORY_MAX_BYTES,
		costMaxBytes: options?.costMaxBytes ?? COST_HISTORY_MAX_BYTES,
		beforeAppend: options?.beforeAppend ?? (() => {}),
		beforeCompactionRead: options?.beforeCompactionRead ?? (() => {}),
		beforeCompactionRename: options?.beforeCompactionRename ?? (() => {}),
		readChunkBytes: normalizedFileReadChunkBytes(options?.readChunkBytes),
		onReadChunk: options?.onReadChunk ?? (() => {}),
		retryBudget: options?.retryBudget,
		onLockExhausted: options?.onLockExhausted,
	};
	const targetPath = record.recordType === "window-sample"
		? normalized.windowHistoryPath
		: normalized.costHistoryPath;
	const maxBytes = record.recordType === "window-sample"
		? normalized.windowMaxBytes
		: normalized.costMaxBytes;
	const encoded = `${JSON.stringify(record)}\n`;
	const recordBytes = Buffer.byteLength(encoded, "utf8");
	if (recordBytes > MAX_RECORD_BYTES) return false;
	const expectedBase = options?.expectedBase ?? dirname(
		record.recordType === "window-sample" ? defaults.windowHistoryPath : defaults.costHistoryPath,
	);
	try {
		mkdirSync(expectedBase, { recursive: true, mode: 0o700 });
		if (!validateAppendPath(targetPath, expectedBase)) return false;
		const directory = dirname(targetPath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const lease = await acquireHistoryLockAsync(
			normalized.lockPath,
			normalized.now,
			normalized.retryBudget,
			normalized.onLockExhausted,
		);
		if (!lease) return false;
		try {
			return appendEncodedUnderLease({
				targetPath,
				maxBytes,
				encoded,
				recordBytes,
				expectedBase,
				nowMs: normalized.now(),
				beforeAppend: normalized.beforeAppend,
				beforeCompactionRead: normalized.beforeCompactionRead,
				beforeCompactionRename: normalized.beforeCompactionRename,
				readChunkBytes: normalized.readChunkBytes,
				onReadChunk: normalized.onReadChunk,
				renewLease: () => lease.renew(),
			});
		} catch {
			return false;
		} finally {
			lease.release();
		}
	} catch {
		return false;
	}
}

/**
 * Append a gap record indicating an interval where observations could not be written.
 * 
 * REQ-RETENTION-NUMERIC: at most one gap record per unwritable interval.
 * 
 * One-gap-per-interval is CALLER DISCIPLINE, not enforced here. Enforcement would
 * require cross-call state tracking ("has a gap been emitted for interval X?"),
 * violating the stateless contract of this storage layer. The caller determines
 * interval boundaries and is responsible for emitting at most one gap per interval.
 */
export async function appendGap(
	recordType: HistoryRecordType,
	gapStartMs: number,
	gapEndMs: number,
	reason: string,
	options?: Partial<HistoryStoreOptions>,
): Promise<boolean> {
	const defaults = defaultHistoryPaths();
	const normalized = {
		windowHistoryPath: options?.windowHistoryPath ?? defaults.windowHistoryPath,
		costHistoryPath: options?.costHistoryPath ?? defaults.costHistoryPath,
		lockPath: options?.lockPath ?? defaults.lockPath,
		now: options?.now ?? Date.now,
		windowMaxBytes: options?.windowMaxBytes ?? WINDOW_HISTORY_MAX_BYTES,
		costMaxBytes: options?.costMaxBytes ?? COST_HISTORY_MAX_BYTES,
		beforeAppend: options?.beforeAppend ?? (() => {}),
		beforeCompactionRead: options?.beforeCompactionRead ?? (() => {}),
		beforeCompactionRename: options?.beforeCompactionRename ?? (() => {}),
		readChunkBytes: normalizedFileReadChunkBytes(options?.readChunkBytes),
		onReadChunk: options?.onReadChunk ?? (() => {}),
		retryBudget: options?.retryBudget,
		onLockExhausted: options?.onLockExhausted,
	};
	const targetPath = recordType === "window-sample"
		? normalized.windowHistoryPath
		: normalized.costHistoryPath;
	const maxBytes = recordType === "window-sample"
		? normalized.windowMaxBytes
		: normalized.costMaxBytes;
	const gapRecord: HistoryGapRecord = {
		schemaVersion: SCHEMA_VERSION,
		recordType: "gap",
		gapStartMs,
		gapEndMs,
		reason,
	};
	const encoded = `${JSON.stringify(gapRecord)}\n`;
	const recordBytes = Buffer.byteLength(encoded, "utf8");
	if (recordBytes > MAX_RECORD_BYTES) return false;
	const expectedBase = options?.expectedBase ?? dirname(
		recordType === "window-sample" ? defaults.windowHistoryPath : defaults.costHistoryPath,
	);
	try {
		mkdirSync(expectedBase, { recursive: true, mode: 0o700 });
		if (!validateAppendPath(targetPath, expectedBase)) return false;
		const directory = dirname(targetPath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const lease = await acquireHistoryLockAsync(
			normalized.lockPath,
			normalized.now,
			normalized.retryBudget,
			normalized.onLockExhausted,
		);
		if (!lease) return false;
		try {
			return appendEncodedUnderLease({
				targetPath, maxBytes, encoded, recordBytes, expectedBase,
				nowMs: normalized.now(), beforeAppend: normalized.beforeAppend,
				beforeCompactionRead: normalized.beforeCompactionRead,
				beforeCompactionRename: normalized.beforeCompactionRename,
				readChunkBytes: normalized.readChunkBytes,
				onReadChunk: normalized.onReadChunk,
				renewLease: () => lease.renew(),
			});
		} catch {
			return false;
		} finally {
			lease.release();
		}
	} catch {
		return false;
	}
}

/** Iterate history records with bounded sequential reads and per-line parsing. */
export function* iterateHistory(
	recordType: HistoryRecordType,
	options?: Partial<HistoryStoreOptions>,
): Generator<HistoryLogRecord> {
	const defaults = defaultHistoryPaths();
	const targetPath =
		recordType === "window-sample"
			? (options?.windowHistoryPath ?? defaults.windowHistoryPath)
			: (options?.costHistoryPath ?? defaults.costHistoryPath);

	try {
		for (const line of iterateBoundedFileLines(targetPath, {
			maxLineBytes: MAX_RECORD_BYTES,
			...(options?.readChunkBytes === undefined
				? {}
				: { chunkBytes: options.readChunkBytes }),
			...(options?.onReadChunk === undefined
				? {}
				: { onReadChunk: options.onReadChunk }),
		})) {
			const record = parseHistoryLine(line);
			if (record !== undefined) yield record;
		}
	} catch (error) {
		if (isMissingPathError(error)) return;
		throw error;
	}
}

/** Read all parsed records for compatibility; hot consumers iterate directly. */
export function readHistory(
	recordType: HistoryRecordType,
	options?: Partial<HistoryStoreOptions>,
): HistoryLogRecord[] {
	return [...iterateHistory(recordType, options)];
}

/**
 * Apply age retention immediately under the same machine-global lock used by
 * appenders. Retained unknown and malformed lines remain byte-for-byte exact.
 */
export async function compactHistory(
	recordType: HistoryRecordType,
	options?: Partial<HistoryStoreOptions>,
): Promise<boolean> {
	const defaults = defaultHistoryPaths();
	const normalized = {
		windowHistoryPath: options?.windowHistoryPath ?? defaults.windowHistoryPath,
		costHistoryPath: options?.costHistoryPath ?? defaults.costHistoryPath,
		lockPath: options?.lockPath ?? defaults.lockPath,
		now: options?.now ?? Date.now,
		windowMaxBytes: options?.windowMaxBytes ?? WINDOW_HISTORY_MAX_BYTES,
		costMaxBytes: options?.costMaxBytes ?? COST_HISTORY_MAX_BYTES,
		beforeCompactionRead: options?.beforeCompactionRead ?? (() => {}),
		beforeCompactionRename: options?.beforeCompactionRename ?? (() => {}),
		readChunkBytes: normalizedFileReadChunkBytes(options?.readChunkBytes),
		onReadChunk: options?.onReadChunk ?? (() => {}),
		retryBudget: options?.retryBudget,
		onLockExhausted: options?.onLockExhausted,
	};
	const targetPath =
		recordType === "window-sample"
			? normalized.windowHistoryPath
			: normalized.costHistoryPath;
	const maxBytes =
		recordType === "window-sample"
			? normalized.windowMaxBytes
			: normalized.costMaxBytes;
	const expectedBase =
		options?.expectedBase ??
		dirname(
			recordType === "window-sample"
				? defaults.windowHistoryPath
				: defaults.costHistoryPath,
		);
	mkdirSync(expectedBase, { recursive: true, mode: 0o700 });
	if (
		!validateAppendPath(targetPath, expectedBase) ||
		!validateAppendPath(retentionMarkerPath(targetPath), expectedBase)
	) {
		return false;
	}
	const directory = dirname(targetPath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const lease = await acquireHistoryLockAsync(
		normalized.lockPath,
		normalized.now,
		normalized.retryBudget,
		normalized.onLockExhausted,
	);
	if (!lease) return false;
	try {
		const nowMs = normalized.now();
		const compacted = compactHistoryUnderLease({
			targetPath,
			maxBytes,
			nowMs,
			beforeRead: normalized.beforeCompactionRead,
			beforeRename: normalized.beforeCompactionRename,
			readChunkBytes: normalized.readChunkBytes,
			onReadChunk: normalized.onReadChunk,
			renewLease: () => lease.renew(),
		});
		if (!compacted) return false;
		recordRetentionCheck(retentionMarkerPath(targetPath), nowMs);
		return true;
	} catch {
		return false;
	} finally {
		lease.release();
	}
}

export const HISTORY_SCHEMA_VERSION = SCHEMA_VERSION;
export const HISTORY_MAX_RECORD_BYTES = MAX_RECORD_BYTES;
export const HISTORY_RETENTION_DAYS = RETENTION_DAYS;
export const HISTORY_WINDOW_MAX_BYTES = WINDOW_HISTORY_MAX_BYTES;
export const HISTORY_COST_MAX_BYTES = COST_HISTORY_MAX_BYTES;
