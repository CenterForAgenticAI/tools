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
const STORE_LEASE_TTL_MS = 5_000;
const MAX_SESSION_ID_LENGTH = 256;

export interface SessionIdSource {
	getSessionId(): string;
}

export interface SessionAccountGroupStoreOptions {
	readonly storePath: string;
	readonly lockPath?: string;
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

export class SessionAccountGroupStoreError extends Error {
	constructor(message: string) {
		super(`[multi-account session groups] ${message}`);
		this.name = "SessionAccountGroupStoreError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSessionId(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_SESSION_ID_LENGTH ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
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

function fsyncDirectory(directory: string): void {
	const descriptor = openSync(directory, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function writeState(storePath: string, state: SessionGroupState): void {
	const directory = dirname(storePath);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
		});
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, storePath);
		chmodSync(storePath, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		throw error;
	}
}

export class SessionAccountGroupStore {
	readonly #storePath: string;
	readonly #lockPath: string;

	constructor(options: SessionAccountGroupStoreOptions) {
		this.#storePath = options.storePath;
		this.#lockPath = options.lockPath ?? `${options.storePath}.lock`;
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
		});
	}

	clearOverride(sessionManager: SessionIdSource): void {
		const sessionId = sessionIdFrom(sessionManager);
		this.#update((state) => {
			delete state.sessions[sessionId];
		});
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
		});
		if (resolved === undefined) {
			throw new SessionAccountGroupStoreError("effective resolution was not written.");
		}
		return copyResolution(resolved);
	}

	#update(mutator: (state: SessionGroupState) => void): void {
		const lease = acquireMachineLease({
			lockPath: this.#lockPath,
			ttlMs: STORE_LEASE_TTL_MS,
			reclaimMalformed: true,
		});
		if (lease === undefined) {
			throw new SessionAccountGroupStoreError("store is busy.");
		}
		try {
			const state = readState(this.#storePath);
			mutator(state);
			writeState(this.#storePath, state);
		} finally {
			lease.release();
		}
	}
}
