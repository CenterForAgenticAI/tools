import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isAccountGroupId } from "./config.js";
import {
	resolveEffectiveAccountGroup,
	type AccountGroupPolicyConfig,
	type EffectiveAccountGroupResolution,
} from "./group-policy.js";
import { acquireMachineLease } from "./machine-lease.js";

const STORE_VERSION = 1;
const LAST_USED_VERSION = 1;
/**
 * A record unused for longer than this is pruned by the next locked write,
 * unless it holds a manual override (issue 187).
 */
const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const STORE_LEASE_TTL_MS = 5_000;
const MAX_SESSION_ID_LENGTH = 256;
/**
 * Concurrent child sessions start together and each writes its own record. One
 * critical section is a few milliseconds, so a short bounded wait clears a
 * burst instead of failing every loser at once (issue 167).
 */
const DEFAULT_LEASE_WAIT_MS = 2_000;
const LEASE_BACKOFF_START_MS = 5;
const LEASE_BACKOFF_MAX_MS = 100;

export interface SessionIdSource {
	getSessionId(): string;
}

export interface SessionAccountGroupStoreOptions {
	readonly storePath: string;
	readonly lockPath?: string;
	/** Longest time one write waits for a contended lease. Zero tries once. */
	readonly leaseWaitMs?: number;
	/** Test seam; production blocks the thread for the backoff interval. */
	readonly sleep?: (ms: number) => void;
	/**
	 * Test seam; production uses a monotonic clock for the wait deadline so a
	 * wall-clock step cannot stretch the blocking wait.
	 */
	readonly now?: () => number;
	/**
	 * Test seam for the wall clock that ages records for retention. It is
	 * separate from `now`, which only bounds the lease wait.
	 */
	readonly wallNow?: () => number;
}

export interface ResolveAndCacheAccountGroupInput {
	readonly sessionManager: SessionIdSource;
	readonly cwd: string;
	readonly config: AccountGroupPolicyConfig;
}

interface StoredSessionGroupRecord {
	manualOverrideGroupId?: string;
	effective?: EffectiveAccountGroupResolution;
}

interface SessionGroupState {
	version: typeof STORE_VERSION;
	sessions: Record<string, StoredSessionGroupRecord>;
}

/**
 * The last-used sidecar. The main store keeps its closed v1 shape so an older
 * running build still reads it; only this file carries wall-clock times.
 */
interface LastUsedState {
	version: typeof LAST_USED_VERSION;
	lastUsedMs: Record<string, number>;
}

export class SessionAccountGroupStoreError extends Error {
	constructor(message: string) {
		super(`[multi-account session groups] ${message}`);
		this.name = "SessionAccountGroupStoreError";
	}
}

/** Another live holder kept the store lease for the whole bounded wait. */
export class SessionAccountGroupStoreBusyError extends SessionAccountGroupStoreError {
	constructor() {
		super("store is busy.");
		this.name = "SessionAccountGroupStoreBusyError";
	}
}

// Resolution runs inside synchronous routing filters, so the wait cannot yield.
function monotonicNow(): number {
	return performance.now();
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_SESSION_ID_LENGTH &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function assertSessionId(value: unknown): asserts value is string {
	if (!isSessionId(value)) {
		throw new SessionAccountGroupStoreError(
			`session id must contain 1 through ${MAX_SESSION_ID_LENGTH} non-control characters.`,
		);
	}
}

function sessionIdFrom(source: SessionIdSource): string {
	const sessionId = source.getSessionId();
	assertSessionId(sessionId);
	return sessionId;
}

function copyResolution(value: unknown): EffectiveAccountGroupResolution {
	if (!isRecord(value)) {
		throw new SessionAccountGroupStoreError("cached effective resolution is malformed.");
	}
	const source = value["source"];
	const groupId = value["groupId"];
	const unknownKeys = Object.keys(value).filter(
		(key) => key !== "source" && key !== "groupId",
	);
	if (unknownKeys.length > 0) {
		throw new SessionAccountGroupStoreError("cached effective resolution is malformed.");
	}
	if (source === "unrestricted" && groupId === undefined) {
		return Object.freeze({ source: "unrestricted" });
	}
	if (
		(source === "session-override" ||
			source === "cwd-default" ||
			source === "directory-default" ||
			source === "global-default") &&
		isAccountGroupId(groupId)
	) {
		return Object.freeze({ groupId, source });
	}
	throw new SessionAccountGroupStoreError("cached effective resolution is malformed.");
}

function emptyState(): SessionGroupState {
	return {
		version: STORE_VERSION,
		sessions: Object.create(null) as Record<string, StoredSessionGroupRecord>,
	};
}

function readState(storePath: string): SessionGroupState {
	let raw: string;
	try {
		raw = readFileSync(storePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new SessionAccountGroupStoreError("store is not valid JSON.");
	}
	if (!isRecord(parsed) || parsed["version"] !== STORE_VERSION || !isRecord(parsed["sessions"])) {
		throw new SessionAccountGroupStoreError("store schema is malformed.");
	}
	const unknownRootKeys = Object.keys(parsed).filter(
		(key) => key !== "version" && key !== "sessions",
	);
	if (unknownRootKeys.length > 0) {
		throw new SessionAccountGroupStoreError("store schema is malformed.");
	}

	const state = emptyState();
	for (const [sessionId, candidate] of Object.entries(parsed["sessions"])) {
		assertSessionId(sessionId);
		if (!isRecord(candidate)) {
			throw new SessionAccountGroupStoreError("session record is malformed.");
		}
		const unknownKeys = Object.keys(candidate).filter(
			(key) => key !== "manualOverrideGroupId" && key !== "effective",
		);
		if (unknownKeys.length > 0) {
			throw new SessionAccountGroupStoreError("session record is malformed.");
		}
		const manualOverrideGroupId = candidate["manualOverrideGroupId"];
		if (
			manualOverrideGroupId !== undefined &&
			!isAccountGroupId(manualOverrideGroupId)
		) {
			throw new SessionAccountGroupStoreError("session override group id is malformed.");
		}
		const record: StoredSessionGroupRecord = {};
		if (manualOverrideGroupId !== undefined) {
			record.manualOverrideGroupId = manualOverrideGroupId;
		}
		if (candidate["effective"] !== undefined) {
			record.effective = copyResolution(candidate["effective"]);
		}
		state.sessions[sessionId] = record;
	}
	return state;
}

function emptyLastUsed(): Record<string, number> {
	return Object.create(null) as Record<string, number>;
}

/**
 * Read the sidecar without ever throwing. A missing, unreadable, corrupt, or
 * wrong-version file reads as empty, so every record counts as used now: a lost
 * sidecar only delays pruning and never blocks routing.
 */
function readLastUsed(path: string): Record<string, number> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return emptyLastUsed();
	}
	if (
		!isRecord(parsed) ||
		parsed["version"] !== LAST_USED_VERSION ||
		!isRecord(parsed["lastUsedMs"]) ||
		Object.keys(parsed).some((key) => key !== "version" && key !== "lastUsedMs")
	) {
		return emptyLastUsed();
	}
	const lastUsed = emptyLastUsed();
	for (const [sessionId, value] of Object.entries(parsed["lastUsedMs"])) {
		if (!isSessionId(sessionId) || !Number.isSafeInteger(value) || (value as number) < 0) {
			return emptyLastUsed();
		}
		lastUsed[sessionId] = value as number;
	}
	return lastUsed;
}

/**
 * Stamp the touched sessions with `nowMs`, then keep each record that holds a
 * manual override or was used within the retention window. A record with no
 * entry, or an entry in the future (the wall clock stepped back), counts as
 * used now. Entries for sessions absent from the store are dropped.
 */
function retainRecentSessions(
	state: SessionGroupState,
	recorded: Record<string, number>,
	touched: readonly string[],
	nowMs: number,
): { state: SessionGroupState; lastUsed: LastUsedState } {
	for (const sessionId of touched) recorded[sessionId] = nowMs;
	const kept = emptyState();
	const lastUsedMs = emptyLastUsed();
	for (const [sessionId, record] of Object.entries(state.sessions)) {
		const entry = recorded[sessionId];
		const usedAtMs = entry === undefined || entry > nowMs ? nowMs : entry;
		if (
			record.manualOverrideGroupId === undefined &&
			nowMs - usedAtMs > SESSION_RETENTION_MS
		) {
			continue;
		}
		kept.sessions[sessionId] = record;
		lastUsedMs[sessionId] = usedAtMs;
	}
	return { state: kept, lastUsed: { version: LAST_USED_VERSION, lastUsedMs } };
}

function fsyncDirectory(directory: string): void {
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

/** Write a complete owner-only file through temp file, fsync, and rename. */
function writeJsonAtomic(path: string, value: SessionGroupState | LastUsedState): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
		});
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
}

export class SessionAccountGroupStore {
	readonly #storePath: string;
	readonly #lastUsedPath: string;
	readonly #lockPath: string;
	readonly #leaseWaitMs: number;
	readonly #sleep: (ms: number) => void;
	readonly #now: () => number;
	readonly #wallNow: () => number;

	constructor(options: SessionAccountGroupStoreOptions) {
		this.#storePath = options.storePath;
		this.#lastUsedPath = `${options.storePath.replace(/\.json$/u, "")}.last-used.json`;
		this.#lockPath = options.lockPath ?? `${options.storePath}.lock`;
		const leaseWaitMs = options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS;
		this.#leaseWaitMs = Number.isFinite(leaseWaitMs) && leaseWaitMs > 0 ? leaseWaitMs : 0;
		this.#sleep = options.sleep ?? sleepSync;
		this.#now = options.now ?? monotonicNow;
		this.#wallNow = options.wallNow ?? Date.now;
	}

	readOverride(sessionId: string): string | undefined {
		assertSessionId(sessionId);
		return readState(this.#storePath).sessions[sessionId]?.manualOverrideGroupId;
	}

	readCachedResolution(sessionId: string): EffectiveAccountGroupResolution | undefined {
		assertSessionId(sessionId);
		const resolution = readState(this.#storePath).sessions[sessionId]?.effective;
		return resolution === undefined ? undefined : copyResolution(resolution);
	}

	setOverride(sessionManager: SessionIdSource, groupId: string): void {
		const sessionId = sessionIdFrom(sessionManager);
		if (!isAccountGroupId(groupId)) {
			throw new SessionAccountGroupStoreError("group id is malformed.");
		}
		this.#update((state) => {
			state.sessions[sessionId] = { manualOverrideGroupId: groupId };
			return [sessionId];
		});
	}

	clearOverride(sessionManager: SessionIdSource): void {
		const sessionId = sessionIdFrom(sessionManager);
		this.#update((state) => {
			delete state.sessions[sessionId];
			return [];
		});
	}

	/**
	 * Persist an inherited effective result under the child's own session id in
	 * one locked write, without consulting the child's cwd or default policy. An
	 * inherited session override stays a manual override for the next hop; every
	 * other source replaces any record the child had. The same write refreshes
	 * the parent's last-used time, because its record is what children inherit.
	 */
	cacheInheritedResolution(
		sessionManager: SessionIdSource,
		resolution: EffectiveAccountGroupResolution,
		parentSessionId: string,
	): EffectiveAccountGroupResolution {
		const sessionId = sessionIdFrom(sessionManager);
		assertSessionId(parentSessionId);
		const effective = copyResolution(resolution);
		this.#update((state) => {
			state.sessions[sessionId] = effective.source === "session-override"
				? { effective, manualOverrideGroupId: effective.groupId }
				: { effective };
			return [sessionId, parentSessionId];
		});
		return copyResolution(effective);
	}

	resolveAndCache(
		input: ResolveAndCacheAccountGroupInput,
	): EffectiveAccountGroupResolution {
		const sessionId = sessionIdFrom(input.sessionManager);
		let resolved: EffectiveAccountGroupResolution | undefined;
		this.#update((state) => {
			const manualOverrideGroupId =
				state.sessions[sessionId]?.manualOverrideGroupId;
			resolved = resolveEffectiveAccountGroup(
				input.config,
				input.cwd,
				manualOverrideGroupId,
			);
			const record: StoredSessionGroupRecord = { effective: resolved };
			if (manualOverrideGroupId !== undefined) {
				record.manualOverrideGroupId = manualOverrideGroupId;
			}
			state.sessions[sessionId] = record;
			return [sessionId];
		});
		if (resolved === undefined) {
			throw new SessionAccountGroupStoreError("effective resolution was not written.");
		}
		return copyResolution(resolved);
	}

	#acquireLease(): NonNullable<ReturnType<typeof acquireMachineLease>> {
		const deadlineMs = this.#now() + this.#leaseWaitMs;
		let backoffMs = LEASE_BACKOFF_START_MS;
		for (;;) {
			const lease = acquireMachineLease({
				lockPath: this.#lockPath,
				ttlMs: STORE_LEASE_TTL_MS,
				reclaimMalformed: true,
			});
			if (lease !== undefined) return lease;
			const remainingMs = deadlineMs - this.#now();
			if (!(remainingMs > 0)) throw new SessionAccountGroupStoreBusyError();
			// Jitter keeps a burst of children from retrying in lockstep.
			const delayMs = Math.min(remainingMs, LEASE_BACKOFF_MAX_MS, backoffMs * (0.5 + Math.random()));
			this.#sleep(Math.max(1, Math.ceil(delayMs)));
			backoffMs = Math.min(LEASE_BACKOFF_MAX_MS, backoffMs * 2);
		}
	}

	/**
	 * One locked read-modify-write of both files. The mutator returns the
	 * sessions it used; touching happens before pruning, so a touched record is
	 * never pruned. A touched session without a record, such as a pruned
	 * parent, gets no entry.
	 *
	 * The sidecar is renamed first. A failure or crash after that rename leaves
	 * the old main file next to a sidecar that only makes records look more
	 * recent, so it can delay pruning but never prune a record in use. If the
	 * sidecar cannot be written, the main file is written without pruning,
	 * because pruning is only safe once the new last-used times are durable.
	 */
	#update(mutator: (state: SessionGroupState) => readonly string[]): void {
		const lease = this.#acquireLease();
		try {
			const state = readState(this.#storePath);
			const recorded = readLastUsed(this.#lastUsedPath);
			const touched = mutator(state);
			const retained = retainRecentSessions(
				state,
				recorded,
				touched,
				Math.floor(this.#wallNow()),
			);
			let lastUsedDurable = true;
			try {
				writeJsonAtomic(this.#lastUsedPath, retained.lastUsed);
			} catch {
				lastUsedDurable = false;
			}
			writeJsonAtomic(this.#storePath, lastUsedDurable ? retained.state : state);
		} finally {
			lease.release();
		}
	}
}
