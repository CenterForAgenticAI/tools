import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureOwnerOnlyDirectory, STATE_DIRECTORY_MODE, STATE_FILE_MODE } from "./state-io.js";

const WORKSPACE_DIRECTORY = "pi-workspace-v2";
const LEGACY_WORKSPACE_DIRECTORY = "pi-workspace";
const WORKSPACE_HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_COMPONENT = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,199}$/u;
const SAFE_ARTIFACT_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)+$/u;
const DEFAULT_ROOT = os.tmpdir();
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ABANDONED_GRACE_MS = 60 * 60 * 1000;
const STORAGE_SCHEMA = "pi-worker-artifact";
const STORAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const storageSweepAttempts = new Map<string, number>();

export const WORKER_ARTIFACT_WORKSPACE_DIRECTORY = WORKSPACE_DIRECTORY;

export interface WorkerArtifactWorkspace {
	version: 2;
	worktreePath: string;
	worktreeHash: string;
	namespaceRoot: string;
	controlRoot: string;
	dataRoot: string;
	/** Compatibility alias for the v2 movable data root. */
	root: string;
	artifactsPath: string;
	runsPath: string;
	lockPath: string;
	worktreePathFile: string;
}

export type WorkerArtifactCheckStatus = "pending" | "passed" | "failed";
export interface WorkerArtifactCheck { status: WorkerArtifactCheckStatus; command?: string; output?: string }
export type WorkerArtifactCheckInput = WorkerArtifactCheck & Record<string, unknown>;

export interface WorkerArtifactReference {
	schema: typeof STORAGE_SCHEMA;
	version: 2;
	artifactId: string;
	worktreeHash: string;
	runId: string;
	forkName: string;
	attempt: number;
	artifactName: string;
	sha256: string;
	bytes: number;
	createdAt: string;
	expiresAt: string;
	absolutePath: string;
	snapshotDev: number;
	snapshotIno: number;
}

export interface WorkerArtifactManifest {
	schema: typeof STORAGE_SCHEMA;
	version: 2;
	artifactRef: WorkerArtifactReference;
	description: string;
	check: WorkerArtifactCheck;
	/** Compatibility projections. */
	name: string;
	producer: string;
	timestamp: string;
}

export interface WorkerArtifactAttempt {
	version: 2;
	id: string;
	workspace: WorkerArtifactWorkspace;
	runId: string;
	forkName: string;
	attempt: number;
	artifactName: string;
	root: string;
	scratchPath: string;
	outputPath: string;
	candidatePath: string;
	ownerPath: string;
	ownerToken: string;
	createdAt: number;
	rootDev: number;
	rootIno: number;
	scratchDev: number;
	scratchIno: number;
	outputDev: number;
	outputIno: number;
}

export interface WorkerArtifactCandidate {
	absolutePath: string;
	bytes: number;
	sha256: string;
	dev: number;
	ino: number;
}

export type WorkerArtifactPublicationPhase =
	| "before-payload-write" | "after-payload-write"
	| "before-payload-sync" | "after-payload-sync"
	| "before-manifest-write" | "after-manifest-write"
	| "before-stage-sync" | "after-stage-sync"
	| "before-commit-lock" | "before-rename" | "after-rename"
	| "before-parent-sync" | "after-parent-sync" | "after-commit-lock";

let publicationPhaseHookForTests: ((phase: WorkerArtifactPublicationPhase) => void) | undefined;

export type WorkerArtifactMetadataLockAcquisitionPhase = "after-create" | "after-write" | "after-sync";
let metadataLockAcquisitionHookForTests: ((phase: WorkerArtifactMetadataLockAcquisitionPhase) => void) | undefined;
let syncMetadataLockTimeoutHookForTests: ((timeoutMs: number) => void) | undefined;

export function __setWorkerArtifactMetadataLockAcquisitionHookForTests(
	hook: ((phase: WorkerArtifactMetadataLockAcquisitionPhase) => void) | undefined,
): () => void {
	const previous = metadataLockAcquisitionHookForTests;
	metadataLockAcquisitionHookForTests = hook;
	return () => { metadataLockAcquisitionHookForTests = previous; };
}

export function __setWorkerArtifactSyncLockTimeoutHookForTests(
	hook: ((timeoutMs: number) => void) | undefined,
): () => void {
	const previous = syncMetadataLockTimeoutHookForTests;
	syncMetadataLockTimeoutHookForTests = hook;
	return () => { syncMetadataLockTimeoutHookForTests = previous; };
}

function metadataLockAcquisitionPhase(phase: WorkerArtifactMetadataLockAcquisitionPhase): void {
	metadataLockAcquisitionHookForTests?.(phase);
}

export function __setWorkerArtifactPublicationPhaseHookForTests(
	hook: ((phase: WorkerArtifactPublicationPhase) => void) | undefined,
): () => void {
	const previous = publicationPhaseHookForTests;
	publicationPhaseHookForTests = hook;
	return () => { publicationPhaseHookForTests = previous; };
}

function publicationPhase(phase: WorkerArtifactPublicationPhase): void {
	publicationPhaseHookForTests?.(phase);
}

export interface PublishedWorkerArtifact {
	artifactRef: WorkerArtifactReference;
	manifest: WorkerArtifactManifest;
	outputFile: { absolutePath: string; bytes: number };
}

export interface OpenWorkerArtifact extends PublishedWorkerArtifact {
	content: string;
	release(): Promise<void>;
}

export interface WorkerArtifactWorkspaceLease {
	readonly token: string;
	isAlive(): boolean;
	renew(): Promise<void>;
	release(): Promise<void>;
}

export interface WorkerArtifactWorkspaceLeaseOptions {
	timeoutMs?: number;
	heartbeatIntervalMs?: number;
	staleAfterMs?: number;
	now?: () => number;
	processIsAlive?: (pid: number, expectedStartTime?: string) => boolean;
	processStartTime?: (pid: number) => string | undefined;
	signal?: AbortSignal;
}

interface LockMetadata {
	pid: number;
	hostname: string;
	token: string;
	processStartTime?: string;
	acquiredAt: number;
	heartbeatAt: number;
}

interface AttemptOwnerRecord extends LockMetadata {
	schema: typeof STORAGE_SCHEMA;
	version: 2;
	kind: "attempt";
	attemptId: string;
	worktreeHash: string;
	runId: string;
	forkName: string;
	attempt: number;
	artifactName: string;
	dataRoot: string;
	rootDev: number;
	rootIno: number;
	scratchDev: number;
	scratchIno: number;
	outputDev: number;
	outputIno: number;
}

export class WorkerArtifactStorageBusyError extends Error {
	readonly kind = "storage-busy" as const;
	readonly lockPath: string;
	readonly retryable = true;
	constructor(lockPath: string, message = `artifact storage metadata is busy: ${lockPath}`) {
		super(message);
		this.name = "WorkerArtifactStorageBusyError";
		this.lockPath = lockPath;
	}
}

export class WorkerArtifactWorkspaceLockedError extends WorkerArtifactStorageBusyError {
	readonly holder?: Pick<LockMetadata, "pid" | "hostname" | "acquiredAt">;
	constructor(lockPath: string, holder?: Pick<LockMetadata, "pid" | "hostname" | "acquiredAt">) {
		const owner = holder ? `pid ${holder.pid} on ${holder.hostname}` : "an unknown holder";
		super(lockPath, `workspace is locked by ${owner}: ${lockPath}`);
		this.name = "WorkerArtifactWorkspaceLockedError";
		this.holder = holder;
	}
}

export class WorkerArtifactUnavailableError extends Error {
	readonly kind = "artifact-unavailable" as const;
	readonly artifactId?: string;
	constructor(message: string, artifactId?: string) {
		super(message);
		this.name = "WorkerArtifactUnavailableError";
		this.artifactId = artifactId;
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectoryIfSupported(target: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
		fs.fsyncSync(fd);
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(errorCode(error) ?? "")) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function assertNoSymlinkComponents(target: string, description: string): void {
	const absolute = path.resolve(target);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${description} must not contain a symbolic link: ${current}`);
		} catch (error) {
			if (errorCode(error) === "ENOENT") break;
			throw error;
		}
	}
}

function ensureRealOwnerDirectory(target: string): void {
	assertNoSymlinkComponents(target, "artifact storage directory");
	ensureOwnerOnlyDirectory(target);
	const stat = fs.lstatSync(target);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== STATE_DIRECTORY_MODE) {
		throw new Error(`artifact storage directory must be a real owner-only directory: ${target}`);
	}
}

function stripGitLineEnding(value: string): string {
	if (value.endsWith("\n")) value = value.slice(0, -1);
	if (value.endsWith("\r")) value = value.slice(0, -1);
	return value;
}

function gitWorktreeRoot(candidate: string): string | undefined {
	try {
		const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status === 0 && typeof result.stdout === "string") {
			const root = stripGitLineEnding(result.stdout);
			if (root !== "") return root;
		}
	} catch { /* non-Git paths are valid identities */ }
	return undefined;
}

function canonicalPath(candidate: string): string {
	const resolved = path.resolve(gitWorktreeRoot(candidate) ?? candidate);
	try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function workspaceHash(worktreePath: string): string {
	return createHash("sha256").update(worktreePath, "utf8").digest("hex");
}

export function validateWorkerArtifactName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || path.isAbsolute(value) || path.basename(value) !== value || !SAFE_ARTIFACT_NAME.test(value)) {
		throw new Error(`artifact name must be a canonical basename with an extension: ${JSON.stringify(value)}`);
	}
	return value;
}

function canonicalComponent(value: unknown, field: string): string {
	if (typeof value !== "string" || !SAFE_COMPONENT.test(value) || value === "." || value === ".." || path.basename(value) !== value) {
		throw new TypeError(`${field} must be one safe path component`);
	}
	return value;
}

function positiveAttempt(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
		throw new TypeError("attempt must be a positive safe integer");
	}
	return value;
}

function canonicalStorageRoot(root: string): string {
	const resolved = path.resolve(root);
	let existing = resolved;
	const missing: string[] = [];
	while (true) {
		try { return path.join(fs.realpathSync(existing), ...missing); }
		catch (error) {
			if (errorCode(error) !== "ENOENT") return resolved;
			const parent = path.dirname(existing);
			if (parent === existing) return resolved;
			missing.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

function workspaceForPaths(worktreePath: string, root: string): WorkerArtifactWorkspace {
	const canonicalWorktreePath = canonicalPath(worktreePath);
	const worktreeHash = workspaceHash(canonicalWorktreePath);
	// Trusted platform roots may contain symlink aliases (macOS /var -> /private/var).
	// Resolve that existing root once; identities beneath the canonical root still
	// reject symlinked or replaced storage components.
	const namespaceRoot = path.join(canonicalStorageRoot(root), WORKSPACE_DIRECTORY);
	const controlRoot = path.join(namespaceRoot, "control", worktreeHash);
	const dataRoot = path.join(namespaceRoot, "data", worktreeHash);
	return {
		version: 2,
		worktreePath: canonicalWorktreePath,
		worktreeHash,
		namespaceRoot,
		controlRoot,
		dataRoot,
		root: dataRoot,
		artifactsPath: path.join(dataRoot, "artifacts"),
		runsPath: path.join(dataRoot, "attempts"),
		lockPath: path.join(controlRoot, "metadata.lock"),
		worktreePathFile: path.join(controlRoot, "worktree-path"),
	};
}

function assertWorkspaceLayout(workspace: WorkerArtifactWorkspace): void {
	if (!workspace || workspace.version !== 2 || typeof workspace.worktreePath !== "string" || !WORKSPACE_HASH.test(workspace.worktreeHash) || workspaceHash(canonicalPath(workspace.worktreePath)) !== workspace.worktreeHash) {
		throw new TypeError("worker artifact workspace has an invalid worktree identity");
	}
	const namespaceRoot = path.resolve(workspace.namespaceRoot);
	if (path.basename(namespaceRoot) !== WORKSPACE_DIRECTORY) throw new Error("worker artifact workspace has an invalid namespace root");
	const expectedControl = path.join(namespaceRoot, "control", workspace.worktreeHash);
	const expectedData = path.join(namespaceRoot, "data", workspace.worktreeHash);
	const expected: Record<string, string> = {
		controlRoot: expectedControl,
		dataRoot: expectedData,
		root: expectedData,
		artifactsPath: path.join(expectedData, "artifacts"),
		runsPath: path.join(expectedData, "attempts"),
		lockPath: path.join(expectedControl, "metadata.lock"),
		worktreePathFile: path.join(expectedControl, "worktree-path"),
	};
	for (const [field, expectedPath] of Object.entries(expected)) {
		if (path.resolve(workspace[field as keyof WorkerArtifactWorkspace] as string) !== expectedPath) throw new Error(`worker artifact workspace has an invalid ${field} path`);
	}
}

export function resolveWorkerArtifactWorkspace(args: { worktreePath: string; root?: string }): WorkerArtifactWorkspace {
	if (typeof args.worktreePath !== "string" || args.worktreePath.trim() === "") throw new TypeError("worktreePath must be a non-empty path");
	return workspaceForPaths(args.worktreePath, args.root ?? DEFAULT_ROOT);
}

function writeAtomicJson(destination: string, value: unknown, mode = STATE_FILE_MODE): void {
	const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", mode);
		fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fs.fchmodSync(fd, mode);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, destination);
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
		try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
	}
}

function readRegularJson(target: string): unknown {
	const before = fs.lstatSync(target);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`metadata must be one regular file: ${target}`);
	const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1) throw new Error(`metadata identity changed: ${target}`);
		return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
	} finally { fs.closeSync(fd); }
}

export function prepareWorkerArtifactWorkspace(args: { worktreePath: string; root?: string }): WorkerArtifactWorkspace {
	const workspace = resolveWorkerArtifactWorkspace(args);
	assertWorkspaceLayout(workspace);
	for (const directory of [workspace.controlRoot, workspace.artifactsPath, workspace.runsPath, path.join(workspace.dataRoot, "quarantine"), path.join(workspace.controlRoot, "usage", "attempts"), path.join(workspace.controlRoot, "usage", "readers"), path.join(workspace.controlRoot, "pins")]) ensureRealOwnerDirectory(directory);
	writeAtomicJson(workspace.worktreePathFile, { schema: STORAGE_SCHEMA, version: 2, worktreePath: workspace.worktreePath, worktreeHash: workspace.worktreeHash });
	return workspace;
}

function processStartTime(pid: number): string | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(") ");
		return end < 0 ? undefined : stat.slice(end + 2).split(" ")[19];
	} catch { return undefined; }
}

function processIsAlive(pid: number, expectedStartTime?: string): boolean {
	try {
		process.kill(pid, 0);
		return expectedStartTime === undefined || processStartTime(pid) === expectedStartTime;
	} catch (error) { return errorCode(error) === "EPERM"; }
}

function parseLock(value: unknown): LockMetadata | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.hostname !== "string" || r.hostname === "" || typeof r.token !== "string" || !UUID.test(r.token) || typeof r.acquiredAt !== "number" || !Number.isFinite(r.acquiredAt) || typeof r.heartbeatAt !== "number" || !Number.isFinite(r.heartbeatAt)) return undefined;
	return { pid: r.pid, hostname: r.hostname, token: r.token, ...(typeof r.processStartTime === "string" ? { processStartTime: r.processStartTime } : {}), acquiredAt: r.acquiredAt, heartbeatAt: r.heartbeatAt };
}

function readLock(lockPath: string): LockMetadata | undefined {
	try { return parseLock(readRegularJson(lockPath)); } catch { return undefined; }
}

function removeFailedOwnedLock(lockPath: string, fd: number): void {
	const tombstone = `${lockPath}.failed-${randomUUID()}`;
	try {
		const descriptor = fs.fstatSync(fd);
		const current = fs.lstatSync(lockPath);
		if (!sameIdentity(descriptor, current)) return;
		fs.renameSync(lockPath, tombstone);
		const moved = fs.lstatSync(tombstone);
		if (sameIdentity(descriptor, moved)) {
			fs.unlinkSync(tombstone);
		} else if (!fs.existsSync(lockPath)) {
			try { fs.renameSync(tombstone, lockPath); } catch { /* preserve an unknown replacement */ }
		}
	} catch { /* a missing or replacement identity is not ours to remove */ }
}

function createMetadataLock(lockPath: string, metadata: LockMetadata): number {
	let fd: number | undefined;
	try {
		fd = fs.openSync(lockPath, "wx", STATE_FILE_MODE);
		metadataLockAcquisitionPhase("after-create");
		fs.writeFileSync(fd, JSON.stringify(metadata), "utf8");
		fs.fchmodSync(fd, STATE_FILE_MODE);
		metadataLockAcquisitionPhase("after-write");
		fs.fsyncSync(fd);
		metadataLockAcquisitionPhase("after-sync");
		const pathStat = fs.lstatSync(lockPath);
		if (!sameIdentity(pathStat, fs.fstatSync(fd)) || pathStat.isSymbolicLink()) {
			throw new Error("artifact storage lock identity changed during acquisition");
		}
		return fd;
	} catch (error) {
		if (fd !== undefined) {
			removeFailedOwnedLock(lockPath, fd);
			try { fs.closeSync(fd); } catch { /* preserve the acquisition failure */ }
		}
		throw error;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
		const finish = (): void => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(signal!.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function acquireMetadataLeaseAtPath(lockPath: string, options: WorkerArtifactWorkspaceLeaseOptions = {}): Promise<WorkerArtifactWorkspaceLease> {
	ensureRealOwnerDirectory(path.dirname(lockPath));
	const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
	const started = Date.now();
	const token = randomUUID();
	const now = options.now ?? Date.now;
	const metadata: LockMetadata = {
		pid: process.pid, hostname: os.hostname(), token, processStartTime: (options.processStartTime ?? processStartTime)(process.pid), acquiredAt: now(), heartbeatAt: now(),
	};
	let fd: number | undefined;
	while (fd === undefined) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("artifact storage lock wait aborted");
		try {
			fd = createMetadataLock(lockPath, metadata);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const holder = readLock(lockPath);
			const staleAfter = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
			const isAlive = options.processIsAlive ?? processIsAlive;
			if (holder && holder.hostname === os.hostname() && now() - holder.heartbeatAt >= staleAfter && !isAlive(holder.pid, holder.processStartTime)) {
				const tombstone = `${lockPath}.stale-${randomUUID()}`;
				try {
					const before = fs.lstatSync(lockPath);
					fs.renameSync(lockPath, tombstone);
					const moved = fs.lstatSync(tombstone);
					if (!sameIdentity(before, moved) || readLock(tombstone)?.token !== holder.token) {
						if (!fs.existsSync(lockPath)) fs.renameSync(tombstone, lockPath);
					} else fs.unlinkSync(tombstone);
					continue;
				} catch { /* retry until bounded deadline */ }
			}
			if (Date.now() - started >= timeoutMs) throw new WorkerArtifactWorkspaceLockedError(lockPath, holder);
			await sleep(Math.min(25, Math.max(1, timeoutMs - (Date.now() - started))), options.signal);
		}
	}
	let alive = true;
	let released = false;
	const owns = (): boolean => {
		if (!alive || fd === undefined) return false;
		try { return sameIdentity(fs.fstatSync(fd), fs.lstatSync(lockPath)) && readLock(lockPath)?.token === token; } catch { return false; }
	};
	const renew = async (): Promise<void> => {
		if (!owns()) { alive = false; throw new Error("artifact storage lease lost its lock identity"); }
		const heartbeatAt = now();
		const time = new Date(heartbeatAt);
		fs.futimesSync(fd!, time, time);
		metadata.heartbeatAt = heartbeatAt;
	};
	const release = async (): Promise<void> => {
		if (released) return;
		released = true;
		if (owns()) {
			const tombstone = `${lockPath}.release-${token}`;
			try {
				fs.renameSync(lockPath, tombstone);
				if (sameIdentity(fs.fstatSync(fd!), fs.lstatSync(tombstone)) && readLock(tombstone)?.token === token) fs.unlinkSync(tombstone);
			} catch { /* a replacement must survive */ }
		}
		alive = false;
		if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
	};
	return { token, isAlive: owns, renew, release };
}

async function acquireMetadataLease(workspace: WorkerArtifactWorkspace, options: WorkerArtifactWorkspaceLeaseOptions = {}): Promise<WorkerArtifactWorkspaceLease> {
	assertWorkspaceLayout(workspace);
	return acquireMetadataLeaseAtPath(workspace.lockPath, options);
}

export const acquireWorkerArtifactWorkspaceLease = acquireMetadataLease;
async function withMetadataLock<T>(workspace: WorkerArtifactWorkspace, operation: () => T | Promise<T>, options: WorkerArtifactWorkspaceLeaseOptions = {}): Promise<T> {
	const lease = await acquireMetadataLease(workspace, options);
	try { return await operation(); } finally { await lease.release(); }
}

function attemptPaths(workspace: WorkerArtifactWorkspace, id: string, artifactName: string): Pick<WorkerArtifactAttempt, "root" | "scratchPath" | "outputPath" | "candidatePath" | "ownerPath"> {
	const root = path.join(workspace.runsPath, id);
	return {
		root,
		scratchPath: path.join(root, "scratch"),
		outputPath: path.join(root, "output"),
		candidatePath: path.join(root, "output", artifactName),
		ownerPath: path.join(workspace.controlRoot, "usage", "attempts", `${id}.json`),
	};
}

async function maybeSweepWorkerArtifactStorage(root: string): Promise<void> {
	const canonicalRoot = canonicalStorageRoot(root);
	const now = Date.now();
	const previous = storageSweepAttempts.get(canonicalRoot);
	if (previous !== undefined && now - previous < STORAGE_SWEEP_INTERVAL_MS) return;
	storageSweepAttempts.set(canonicalRoot, now);
	try { await sweepWorkerArtifactStorage({ root: canonicalRoot, maxCandidates: 64, timeBudgetMs: 50 }); }
	catch { /* bounded maintenance is best effort at producer admission */ }
}

export async function prepareWorkerArtifactAttempt(workspace: WorkerArtifactWorkspace, input: { runId: string; forkName: string; attempt: number; artifactName: string; signal?: AbortSignal }): Promise<WorkerArtifactAttempt> {
	assertWorkspaceLayout(workspace);
	const runId = canonicalComponent(input.runId, "runId");
	const forkName = canonicalComponent(input.forkName, "forkName");
	const attempt = positiveAttempt(input.attempt);
	const artifactName = validateWorkerArtifactName(input.artifactName);
	const storageRoot = path.dirname(workspace.namespaceRoot);
	prepareWorkerArtifactWorkspace({ worktreePath: workspace.worktreePath, root: storageRoot });
	await maybeSweepWorkerArtifactStorage(storageRoot);
	const id = randomUUID();
	const paths = attemptPaths(workspace, id, artifactName);
	const createdAt = Date.now();
	const ownerToken = randomUUID();
	let rootIdentity: fs.Stats | undefined;
	let scratchIdentity: fs.Stats | undefined;
	let outputIdentity: fs.Stats | undefined;
	await withMetadataLock(workspace, async () => {
		await registerMaintenanceQueueRecords(workspace, [{ kind: "attempt", entryName: id }], input.signal, () => {
			try {
				ensureRealOwnerDirectory(paths.scratchPath);
				ensureRealOwnerDirectory(paths.outputPath);
				rootIdentity = fs.lstatSync(paths.root);
				scratchIdentity = fs.lstatSync(paths.scratchPath);
				outputIdentity = fs.lstatSync(paths.outputPath);
				const owner: AttemptOwnerRecord = {
					schema: STORAGE_SCHEMA, version: 2, kind: "attempt", attemptId: id, worktreeHash: workspace.worktreeHash,
					runId, forkName, attempt, artifactName, dataRoot: workspace.dataRoot,
					rootDev: rootIdentity.dev, rootIno: rootIdentity.ino,
					scratchDev: scratchIdentity.dev, scratchIno: scratchIdentity.ino,
					outputDev: outputIdentity.dev, outputIno: outputIdentity.ino,
					pid: process.pid, hostname: os.hostname(), token: ownerToken, processStartTime: processStartTime(process.pid), acquiredAt: createdAt, heartbeatAt: createdAt,
				};
				writeAtomicJson(paths.ownerPath, owner);
			} catch (error) {
				try { fs.rmSync(paths.root, { recursive: true, force: true }); } catch { /* best effort under both metadata locks */ }
				throw error;
			}
		});
	}, { signal: input.signal });
	if (!rootIdentity || !scratchIdentity || !outputIdentity) throw new Error("artifact attempt identity initialization failed");
	return {
		version: 2, id, workspace, runId, forkName, attempt, artifactName, ...paths,
		ownerToken, createdAt,
		rootDev: rootIdentity.dev, rootIno: rootIdentity.ino,
		scratchDev: scratchIdentity.dev, scratchIno: scratchIdentity.ino,
		outputDev: outputIdentity.dev, outputIno: outputIdentity.ino,
	};
}

function assertAttempt(attempt: WorkerArtifactAttempt): void {
	if (!attempt || attempt.version !== 2 || !UUID.test(attempt.id) || !UUID.test(attempt.ownerToken) ||
		![attempt.rootDev, attempt.rootIno, attempt.scratchDev, attempt.scratchIno, attempt.outputDev, attempt.outputIno].every(Number.isFinite)) {
		throw new TypeError("invalid artifact attempt identity");
	}
	assertWorkspaceLayout(attempt.workspace);
	const runId = canonicalComponent(attempt.runId, "runId");
	const forkName = canonicalComponent(attempt.forkName, "forkName");
	const artifactName = validateWorkerArtifactName(attempt.artifactName);
	positiveAttempt(attempt.attempt);
	const expected = attemptPaths(attempt.workspace, attempt.id, artifactName);
	for (const field of ["root", "scratchPath", "outputPath", "candidatePath", "ownerPath"] as const) {
		if (path.resolve(attempt[field]) !== expected[field]) throw new Error(`artifact attempt has invalid ${field}`);
	}
	if (runId !== attempt.runId || forkName !== attempt.forkName) throw new Error("artifact attempt producer identity changed");
}

function isFileIdentityPart(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseAttemptOwner(value: unknown): AttemptOwnerRecord | undefined {
	const lock = parseLock(value);
	if (!lock || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const r = value as Record<string, unknown>;
	try {
		if (r.schema !== STORAGE_SCHEMA || r.version !== 2 || r.kind !== "attempt" || typeof r.attemptId !== "string" || !UUID.test(r.attemptId) || typeof r.worktreeHash !== "string" || !WORKSPACE_HASH.test(r.worktreeHash) || typeof r.dataRoot !== "string" ||
			!isFileIdentityPart(r.rootDev) || !isFileIdentityPart(r.rootIno) || !isFileIdentityPart(r.scratchDev) || !isFileIdentityPart(r.scratchIno) || !isFileIdentityPart(r.outputDev) || !isFileIdentityPart(r.outputIno)) return undefined;
		return {
			...lock,
			schema: STORAGE_SCHEMA, version: 2, kind: "attempt", attemptId: r.attemptId, worktreeHash: r.worktreeHash,
			runId: canonicalComponent(r.runId, "runId"), forkName: canonicalComponent(r.forkName, "forkName"),
			attempt: positiveAttempt(r.attempt), artifactName: validateWorkerArtifactName(r.artifactName), dataRoot: r.dataRoot,
			rootDev: r.rootDev, rootIno: r.rootIno, scratchDev: r.scratchDev, scratchIno: r.scratchIno,
			outputDev: r.outputDev, outputIno: r.outputIno,
		};
	} catch { return undefined; }
}

function ownedAttemptRecord(attempt: WorkerArtifactAttempt): AttemptOwnerRecord {
	const record = parseAttemptOwner(readRegularJson(attempt.ownerPath));
	if (!record || record.token !== attempt.ownerToken || record.attemptId !== attempt.id || record.worktreeHash !== attempt.workspace.worktreeHash || record.runId !== attempt.runId || record.forkName !== attempt.forkName || record.attempt !== attempt.attempt || record.artifactName !== attempt.artifactName || path.resolve(record.dataRoot) !== attempt.workspace.dataRoot ||
		record.rootDev !== attempt.rootDev || record.rootIno !== attempt.rootIno || record.scratchDev !== attempt.scratchDev || record.scratchIno !== attempt.scratchIno || record.outputDev !== attempt.outputDev || record.outputIno !== attempt.outputIno) {
		throw new Error("artifact attempt ownership is missing, foreign, or replaced");
	}
	return record;
}

interface ReadArtifactPayload {
	candidate: WorkerArtifactCandidate;
	content: Buffer;
}

function readArtifactPayload(candidatePath: string): ReadArtifactPayload {
	const before = fs.lstatSync(candidatePath);
	if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error("artifact candidate must be one regular non-linked file");
	const fd = fs.openSync(candidatePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd);
		if (!sameIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1) throw new Error("artifact candidate identity changed during read");
		const content = fs.readFileSync(fd);
		if (content.byteLength === 0) throw new Error("artifact candidate is empty");
		return {
			candidate: {
				absolutePath: candidatePath,
				bytes: content.byteLength,
				sha256: createHash("sha256").update(content).digest("hex"),
				dev: opened.dev,
				ino: opened.ino,
			},
			content,
		};
	} finally { fs.closeSync(fd); }
}

function readCandidatePath(candidatePath: string): WorkerArtifactCandidate {
	return readArtifactPayload(candidatePath).candidate;
}

function assertDirectoryIdentity(target: string, dev: number, ino: number, description: string): fs.Stats {
	const current = fs.lstatSync(target);
	if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino) {
		throw new Error(`${description} identity is invalid or replaced`);
	}
	return current;
}

function readAttemptCandidatePayload(attempt: WorkerArtifactAttempt): ReadArtifactPayload {
	assertDirectoryIdentity(attempt.root, attempt.rootDev, attempt.rootIno, "artifact attempt directory");
	assertDirectoryIdentity(attempt.outputPath, attempt.outputDev, attempt.outputIno, "artifact attempt output directory");
	const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
	const directoryFd = fs.openSync(attempt.outputPath, flags);
	try {
		const openedDirectory = fs.fstatSync(directoryFd);
		if (!openedDirectory.isDirectory() || openedDirectory.dev !== attempt.outputDev || openedDirectory.ino !== attempt.outputIno) {
			throw new Error("artifact attempt output directory changed during open");
		}
		const fdDirectory = descriptorDirectoryPath(directoryFd);
		if (!fdDirectory) throw new Error("descriptor-relative artifact candidate read is unavailable");
		const payload = readArtifactPayload(path.join(fdDirectory, attempt.artifactName));
		assertDirectoryIdentity(attempt.root, attempt.rootDev, attempt.rootIno, "artifact attempt directory");
		assertDirectoryIdentity(attempt.outputPath, attempt.outputDev, attempt.outputIno, "artifact attempt output directory");
		return { ...payload, candidate: { ...payload.candidate, absolutePath: attempt.candidatePath } };
	} finally {
		fs.closeSync(directoryFd);
	}
}

export function readWorkerArtifactCandidate(attempt: WorkerArtifactAttempt): WorkerArtifactCandidate {
	assertAttempt(attempt);
	ownedAttemptRecord(attempt);
	return readAttemptCandidatePayload(attempt).candidate;
}

function sameCandidate(left: WorkerArtifactCandidate, right: WorkerArtifactCandidate): boolean {
	return left.absolutePath === right.absolutePath && left.bytes === right.bytes && left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino;
}

function projectCheck(input: WorkerArtifactCheckInput | undefined): WorkerArtifactCheck {
	if (!input) return { status: "pending" };
	if (input.status !== "pending" && input.status !== "passed" && input.status !== "failed") throw new TypeError("artifact check status must be pending, passed, or failed");
	return { status: input.status, ...(typeof input.command === "string" ? { command: input.command } : {}), ...(typeof input.output === "string" ? { output: input.output } : {}) };
}

export async function publishWorkerArtifact(attempt: WorkerArtifactAttempt, input: { candidate: WorkerArtifactCandidate; description: string; check?: WorkerArtifactCheckInput; retentionMs?: number; now?: number; signal?: AbortSignal }): Promise<PublishedWorkerArtifact> {
	assertAttempt(attempt);
	if (typeof input.description !== "string") throw new TypeError("artifact description must be a string");
	ownedAttemptRecord(attempt);
	const currentPayload = readAttemptCandidatePayload(attempt);
	const current = currentPayload.candidate;
	if (!sameCandidate(input.candidate, current)) throw new Error("artifact candidate changed after validation; checker-altered bytes are rejected");
	const now = input.now ?? Date.now();
	const retentionMs = input.retentionMs ?? DEFAULT_RETENTION_MS;
	if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new TypeError("artifact retention must be non-negative");
	const artifactId = randomUUID();
	const snapshotPath = path.join(attempt.workspace.artifactsPath, artifactId);
	const stagePath = path.join(attempt.workspace.dataRoot, `.publish-${artifactId}`);
	let stageIdentity: fs.Stats | undefined;
	let publicationRecord: RegisteredMaintenanceRecord | undefined;
	await registerMaintenanceQueueRecords(attempt.workspace, [
		{ kind: "artifact", entryName: artifactId },
	], input.signal, (written) => {
		publicationRecord = written[0];
		ensureRealOwnerDirectory(stagePath);
		stageIdentity = fs.lstatSync(stagePath);
	});
	if (!publicationRecord) throw new Error("artifact publication maintenance registration failed");
	const payloadPath = path.join(stagePath, "payload");
	const finalPayloadPath = path.join(snapshotPath, "payload");
	let committed = false;
	let uncommittedUsage: QuarantinedCandidate | undefined;
	try {
		publicationPhase("before-payload-write");
		fs.writeFileSync(payloadPath, currentPayload.content, { flag: "wx", mode: 0o600 });
		publicationPhase("after-payload-write");
		publicationPhase("before-payload-sync");
		const payloadFd = fs.openSync(payloadPath, "r");
		try { fs.fsyncSync(payloadFd); } finally { fs.closeSync(payloadFd); }
		publicationPhase("after-payload-sync");
		const copied = readCandidatePath(payloadPath);
		if (copied.bytes !== current.bytes || copied.sha256 !== current.sha256) throw new Error("staged artifact bytes differ from the checked candidate");
		fs.chmodSync(payloadPath, 0o400);
		const snapshotIdentity = stageIdentity;
		if (!snapshotIdentity) throw new Error("artifact publication staging identity is unavailable");
		const createdAt = new Date(now).toISOString();
		const expiresAt = new Date(now + retentionMs).toISOString();
		const artifactRef: WorkerArtifactReference = {
			schema: STORAGE_SCHEMA, version: 2, artifactId, worktreeHash: attempt.workspace.worktreeHash,
			runId: attempt.runId, forkName: attempt.forkName, attempt: attempt.attempt, artifactName: attempt.artifactName,
			sha256: current.sha256, bytes: current.bytes, createdAt, expiresAt, absolutePath: finalPayloadPath,
			snapshotDev: snapshotIdentity.dev, snapshotIno: snapshotIdentity.ino,
		};
		const manifest: WorkerArtifactManifest = {
			schema: STORAGE_SCHEMA, version: 2, artifactRef, description: input.description, check: projectCheck(input.check),
			name: attempt.artifactName, producer: attempt.forkName, timestamp: createdAt,
		};
		publicationPhase("before-manifest-write");
		writeAtomicJson(path.join(stagePath, "manifest.json"), manifest, 0o400);
		publicationPhase("after-manifest-write");
		publicationPhase("before-stage-sync");
		syncDirectoryIfSupported(stagePath);
		publicationPhase("after-stage-sync");
		publicationPhase("before-commit-lock");
		try {
			await withMetadataLock(attempt.workspace, async () => {
				ownedAttemptRecord(attempt);
				const revalidated = readAttemptCandidatePayload(attempt).candidate;
				if (!sameCandidate(current, revalidated)) throw new Error("artifact candidate changed before publication commit");
				const usage = initializeArtifactUsageJournal(attempt.workspace.controlRoot, artifactId);
				const usageIdentity = fs.lstatSync(usage.root);
				if (!usageIdentity.isDirectory() || usageIdentity.isSymbolicLink()) throw new Error("artifact usage journal root identity is invalid");
				await initializeArtifactEligibilityWake(attempt.workspace, artifactRef, publicationRecord.sequence, input.signal);
				try {
					publicationPhase("before-rename");
					const stageBeforeRename = fs.lstatSync(stagePath);
					if (!stageBeforeRename.isDirectory() || stageBeforeRename.isSymbolicLink() || !stageIdentity || !sameIdentity(stageIdentity, stageBeforeRename)) {
						throw new Error("staging directory identity changed before publication commit");
					}
					fs.renameSync(stagePath, snapshotPath);
					committed = true;
				} catch (error) {
					uncommittedUsage = await quarantineUncommittedArtifactUsage(
						attempt.workspace.controlRoot, attempt.workspace.dataRoot, artifactId, usageIdentity,
					);
					throw error;
				}
				fs.chmodSync(snapshotPath, 0o500);
				publicationPhase("after-rename");
				publicationPhase("before-parent-sync");
				syncDirectoryIfSupported(attempt.workspace.artifactsPath);
				publicationPhase("after-parent-sync");
			}, { signal: input.signal });
		} catch (error) {
			if (uncommittedUsage) deleteCapturedQuarantine(uncommittedUsage);
			throw error;
		}
		publicationPhase("after-commit-lock");
		return { artifactRef, manifest, outputFile: { absolutePath: finalPayloadPath, bytes: current.bytes } };
	} finally {
		if (!committed && stageIdentity) {
			try {
				const currentStage = fs.lstatSync(stagePath);
				if (currentStage.isDirectory() && !currentStage.isSymbolicLink() && sameIdentity(stageIdentity, currentStage)) {
					fs.chmodSync(stagePath, 0o700);
					fs.rmSync(stagePath, { recursive: true, force: true });
				}
			} catch { /* best effort; never delete a replaced staging directory */ }
		}
	}
}

export async function finishWorkerArtifactAttempt(attempt: WorkerArtifactAttempt): Promise<void> {
	assertAttempt(attempt);
	let captured: QuarantinedCandidate | undefined;
	await withMetadataLock(attempt.workspace, async () => {
		ownedAttemptRecord(attempt);
		const current = assertDirectoryIdentity(attempt.root, attempt.rootDev, attempt.rootIno, "artifact attempt directory");
		const quarantine = path.join(attempt.workspace.dataRoot, "quarantine", `attempt-${attempt.id}-${randomUUID()}`);
		await registerMaintenanceQueueRecords(attempt.workspace, [{
			kind: "quarantine", entryName: path.basename(quarantine), dev: current.dev, ino: current.ino,
		}], undefined, () => { fs.renameSync(attempt.root, quarantine); });
		const moved = fs.lstatSync(quarantine);
		if (!sameIdentity(current, moved) || !moved.isDirectory() || moved.isSymbolicLink()) {
			// Portable Node has no no-replace directory rename. Keep whichever exact
			// captured identity remains under its unique quarantine name rather than
			// risk overwriting a replacement installed at the attempt path.
			throw new Error("artifact attempt quarantine identity changed");
		}
		fs.unlinkSync(attempt.ownerPath);
		captured = { path: quarantine, dev: moved.dev, ino: moved.ino };
	});
	if (captured) deleteCapturedQuarantine(captured);
}

function projectArtifactReference(value: unknown): WorkerArtifactReference {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("artifact reference must be an object");
	const r = value as Record<string, unknown>;
	if (r.schema !== STORAGE_SCHEMA || r.version !== 2 || typeof r.artifactId !== "string" || !UUID.test(r.artifactId) || typeof r.worktreeHash !== "string" || !WORKSPACE_HASH.test(r.worktreeHash) || typeof r.sha256 !== "string" || !SHA256.test(r.sha256) || typeof r.bytes !== "number" || !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt)) || typeof r.expiresAt !== "string" || !Number.isFinite(Date.parse(r.expiresAt)) || typeof r.absolutePath !== "string" || !path.isAbsolute(r.absolutePath) || typeof r.snapshotDev !== "number" || !Number.isFinite(r.snapshotDev) || typeof r.snapshotIno !== "number" || !Number.isFinite(r.snapshotIno)) throw new TypeError("artifact reference has an invalid v2 shape");
	return {
		schema: STORAGE_SCHEMA, version: 2, artifactId: r.artifactId, worktreeHash: r.worktreeHash,
		runId: canonicalComponent(r.runId, "runId"), forkName: canonicalComponent(r.forkName, "forkName"), attempt: positiveAttempt(r.attempt), artifactName: validateWorkerArtifactName(r.artifactName),
		sha256: r.sha256, bytes: r.bytes, createdAt: r.createdAt, expiresAt: r.expiresAt, absolutePath: r.absolutePath,
		snapshotDev: r.snapshotDev, snapshotIno: r.snapshotIno,
	};
}

export function validateWorkerArtifactReference(value: unknown): WorkerArtifactReference {
	return projectArtifactReference(value);
}

/** Return the concise parent-facing receipt for a published artifact result. */
export function workerArtifactReceipt(result: object): string | undefined {
	const detail = result as {
		outputFile?: { absolutePath: string };
		artifactRef?: WorkerArtifactReference;
	};
	const absolutePath = detail.outputFile?.absolutePath;
	if (detail.artifactRef === undefined || typeof absolutePath !== "string") return undefined;
	return `Artifact persisted at ${absolutePath}.`;
}

/** Validate that an exact reference still resolves to its immutable retained bytes. */
export function validateRetainedWorkerArtifact(
	value: unknown,
	options: { root?: string; now?: number; allowExpired?: boolean } = {},
): WorkerArtifactReference {
	const ref = projectArtifactReference(value);
	const paths = artifactPathsFromRef(ref, options.root);
	if (options.allowExpired !== true && (options.now ?? Date.now()) > Date.parse(ref.expiresAt)) {
		throw new WorkerArtifactUnavailableError("artifact reference has expired", ref.artifactId);
	}
	let opened: { fd: number; fdPath: string; manifest: WorkerArtifactManifest } | undefined;
	try {
		opened = openRetainedSnapshotDirectory(ref, paths);
		readRetainedPayload(opened, ref);
	} catch (error) {
		throw new WorkerArtifactUnavailableError(error instanceof Error ? error.message : String(error), ref.artifactId);
	} finally {
		if (opened) fs.closeSync(opened.fd);
	}
	return ref;
}

function storageRootFromReference(ref: WorkerArtifactReference): string {
	const payload = path.resolve(ref.absolutePath);
	const artifactDirectory = path.dirname(payload);
	const artifactsDirectory = path.dirname(artifactDirectory);
	const workspaceData = path.dirname(artifactsDirectory);
	const dataDirectory = path.dirname(workspaceData);
	const namespace = path.dirname(dataDirectory);
	if (
		path.basename(payload) !== "payload" ||
		path.basename(artifactDirectory) !== ref.artifactId ||
		path.basename(artifactsDirectory) !== "artifacts" ||
		path.basename(workspaceData) !== ref.worktreeHash ||
		path.basename(dataDirectory) !== "data" ||
		path.basename(namespace) !== WORKSPACE_DIRECTORY
	) {
		throw new WorkerArtifactUnavailableError("artifact reference path does not match the v2 storage layout", ref.artifactId);
	}
	return path.dirname(namespace);
}

function artifactPathsFromRef(ref: WorkerArtifactReference, suppliedRoot?: string): { root: string; workspaceData: string; snapshot: string; payload: string; manifest: string; control: string } {
	const derivedRoot = storageRootFromReference(ref);
	const root = suppliedRoot === undefined ? derivedRoot : canonicalStorageRoot(suppliedRoot);
	if (root !== derivedRoot) throw new WorkerArtifactUnavailableError("artifact reference belongs to a different storage root", ref.artifactId);
	const namespace = path.join(root, WORKSPACE_DIRECTORY);
	const workspaceData = path.join(namespace, "data", ref.worktreeHash);
	const snapshot = path.join(workspaceData, "artifacts", ref.artifactId);
	const payload = path.join(snapshot, "payload");
	if (path.resolve(ref.absolutePath) !== payload) throw new WorkerArtifactUnavailableError("artifact reference path does not match its derived v2 snapshot", ref.artifactId);
	return { root, workspaceData, snapshot, payload, manifest: path.join(snapshot, "manifest.json"), control: path.join(namespace, "control", ref.worktreeHash) };
}

function parseManifest(value: unknown): WorkerArtifactManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact manifest is not an object");
	const r = value as Record<string, unknown>;
	const artifactRef = projectArtifactReference(r.artifactRef);
	if (r.schema !== STORAGE_SCHEMA || r.version !== 2 || typeof r.description !== "string" || !r.check || typeof r.check !== "object" || Array.isArray(r.check)) throw new Error("artifact manifest has an invalid v2 shape");
	const check = projectCheck(r.check as WorkerArtifactCheckInput);
	return { schema: STORAGE_SCHEMA, version: 2, artifactRef, description: r.description, check, name: artifactRef.artifactName, producer: artifactRef.forkName, timestamp: artifactRef.createdAt };
}

function equalArtifactRef(left: WorkerArtifactReference, right: WorkerArtifactReference): boolean {
	return Object.keys(left).every((key) => left[key as keyof WorkerArtifactReference] === right[key as keyof WorkerArtifactReference]);
}

function openRetainedSnapshotDirectory(
	ref: WorkerArtifactReference,
	paths: { snapshot: string; manifest: string; payload: string },
): { fd: number; fdPath: string; manifest: WorkerArtifactManifest } {
	assertNoSymlinkComponents(paths.snapshot, "retained artifact snapshot");
	const before = fs.lstatSync(paths.snapshot);
	if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== ref.snapshotDev || before.ino !== ref.snapshotIno) {
		throw new Error("retained artifact snapshot identity does not match its reference");
	}
	const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
	const fd = fs.openSync(paths.snapshot, flags);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isDirectory() || opened.dev !== ref.snapshotDev || opened.ino !== ref.snapshotIno) {
			throw new Error("retained artifact snapshot identity changed during open");
		}
		const fdPath = descriptorDirectoryPath(fd);
		if (!fdPath) throw new Error("descriptor-relative retained artifact read is unavailable");
		const manifest = parseManifest(readRegularJson(path.join(fdPath, "manifest.json")));
		if (!equalArtifactRef(manifest.artifactRef, ref)) throw new Error("artifact reference does not match its retained manifest");
		return { fd, fdPath, manifest };
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function readRetainedPayload(
	opened: { fd: number; fdPath: string },
	ref: WorkerArtifactReference,
): ReadArtifactPayload {
	const retained = readArtifactPayload(path.join(opened.fdPath, "payload"));
	const mode = fs.lstatSync(path.join(opened.fdPath, "payload")).mode & 0o222;
	if (mode !== 0 || retained.candidate.bytes !== ref.bytes || retained.candidate.sha256 !== ref.sha256) {
		throw new Error("retained artifact payload no longer matches its immutable manifest");
	}
	return retained;
}

function validPin(controlRoot: string, ref: WorkerArtifactReference, pinId: string, now: number): boolean {
	try {
		const id = canonicalComponent(pinId, "pinId");
		const value = readRegularJson(path.join(controlRoot, "pins", `${id}.json`));
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		return record.schema === STORAGE_SCHEMA && record.version === 2 && record.kind === "pin" &&
			record.pinId === id && record.artifactId === ref.artifactId && record.worktreeHash === ref.worktreeHash &&
			record.sha256 === ref.sha256 && typeof record.expiresAt === "string" && Date.parse(record.expiresAt) >= now;
	} catch { return false; }
}

function hasValidPin(controlRoot: string, ref: WorkerArtifactReference, now: number): boolean {
	for (const entry of safeDirectoryEntries(path.join(controlRoot, "pins"))) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const pinId = entry.name.slice(0, -5);
			if (validPin(controlRoot, ref, pinId, now)) return true;
		} catch { /* malformed pins never grant read authority */ }
	}
	return false;
}

export async function openWorkerArtifact(value: unknown, options: { root?: string; now?: number; pinId?: string; signal?: AbortSignal } = {}): Promise<OpenWorkerArtifact> {
	let ref: WorkerArtifactReference;
	try { ref = projectArtifactReference(value); } catch (error) { throw new WorkerArtifactUnavailableError(error instanceof Error ? error.message : String(error)); }
	const paths = artifactPathsFromRef(ref, options.root);
	const now = options.now ?? Date.now();
	if (now > Date.parse(ref.expiresAt)) {
		const explicitlyPinned = options.pinId !== undefined && validPin(paths.control, ref, options.pinId, now);
		if (!explicitlyPinned && !hasValidPin(paths.control, ref, now)) {
			throw new WorkerArtifactUnavailableError("artifact reference has expired or has no valid retention pin", ref.artifactId);
		}
	}
	// Reference fields derive every path. The original worktree path is deliberately
	// absent so a caller cannot use it to redirect storage coordination.
	ensureRealOwnerDirectory(path.join(paths.control, "usage", "readers"));
	const readerId = randomUUID();
	const readerPath = path.join(paths.control, "usage", "readers", `${readerId}.json`);
	let opened: { fd: number; fdPath: string; manifest: WorkerArtifactManifest } | undefined;
	const lease = await acquireRawMetadataLease(path.join(paths.control, "metadata.lock"), options.signal);
	try {
		opened = openRetainedSnapshotDirectory(ref, paths);
		await scheduleArtifactEligibilityWake(paths.control, ref, options.signal);
		appendArtifactUsageJournalRecord(paths.control, ref, "reader", readerId);
		writeAtomicJson(readerPath, {
			schema: STORAGE_SCHEMA, version: 2, kind: "reader", readerId,
			artifactId: ref.artifactId, worktreeHash: ref.worktreeHash, sha256: ref.sha256,
			pid: process.pid, hostname: os.hostname(), processStartTime: processStartTime(process.pid), admittedAt: now,
		});
	} catch (error) {
		if (opened) fs.closeSync(opened.fd);
		throw new WorkerArtifactUnavailableError(error instanceof Error ? error.message : String(error), ref.artifactId);
	} finally { await lease.release(); }
	try {
		const retained = readRetainedPayload(opened!, ref);
		const manifest = opened!.manifest;
		fs.closeSync(opened!.fd);
		opened = undefined;
		const content = retained.content.toString("utf8");
		let released = false;
		return {
			artifactRef: ref, manifest, outputFile: { absolutePath: paths.payload, bytes: ref.bytes }, content,
			release: async () => {
				if (released) return;
				const readerLease = await acquireRawMetadataLease(path.join(paths.control, "metadata.lock"));
				try {
					await scheduleArtifactEligibilityWake(paths.control, ref);
					fs.rmSync(readerPath, { force: true });
					released = true;
				} finally { await readerLease.release(); }
			},
		};
	} catch (error) {
		if (opened) fs.closeSync(opened.fd);
		try {
			const cleanupLease = await acquireRawMetadataLease(path.join(paths.control, "metadata.lock"));
			try {
				await scheduleArtifactEligibilityWake(paths.control, ref);
				fs.rmSync(readerPath, { force: true });
			} finally { await cleanupLease.release(); }
		} catch { /* dead-reader maintenance is the bounded fallback */ }
		throw new WorkerArtifactUnavailableError(error instanceof Error ? error.message : String(error), ref.artifactId);
	}
}

/** Admit an exact retained payload path without consulting a basename or latest-file index. */
export async function openWorkerArtifactByPath(
	absolutePath: string,
	options: { now?: number; pinId?: string; signal?: AbortSignal } = {},
): Promise<OpenWorkerArtifact> {
	if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
		throw new WorkerArtifactUnavailableError("artifact path must be absolute");
	}
	let manifest: WorkerArtifactManifest;
	try { manifest = parseManifest(readRegularJson(path.join(path.dirname(absolutePath), "manifest.json"))); }
	catch (error) {
		throw new WorkerArtifactUnavailableError(`artifact manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (path.resolve(manifest.artifactRef.absolutePath) !== path.resolve(absolutePath)) {
		throw new WorkerArtifactUnavailableError("artifact path does not match its retained manifest", manifest.artifactRef.artifactId);
	}
	return openWorkerArtifact(manifest.artifactRef, options);
}

async function acquireRawMetadataLease(lockPath: string, signal?: AbortSignal): Promise<WorkerArtifactWorkspaceLease> {
	return acquireMetadataLeaseAtPath(lockPath, { signal });
}

function withMetadataLockSync<T>(lockPath: string, operation: () => T, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): T {
	ensureRealOwnerDirectory(path.dirname(lockPath));
	syncMetadataLockTimeoutHookForTests?.(timeoutMs);
	const token = randomUUID();
	const started = Date.now();
	let fd: number | undefined;
	while (fd === undefined) {
		try {
			const now = Date.now();
			fd = createMetadataLock(lockPath, {
				pid: process.pid, hostname: os.hostname(), token, processStartTime: processStartTime(process.pid),
				acquiredAt: now, heartbeatAt: now,
			});
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const holder = readLock(lockPath);
			if (holder && holder.hostname === os.hostname() && Date.now() - holder.heartbeatAt >= DEFAULT_LOCK_STALE_AFTER_MS && !processIsAlive(holder.pid, holder.processStartTime)) {
				const tombstone = `${lockPath}.stale-${randomUUID()}`;
				try {
					const before = fs.lstatSync(lockPath);
					fs.renameSync(lockPath, tombstone);
					const moved = fs.lstatSync(tombstone);
					if (sameIdentity(before, moved) && readLock(tombstone)?.token === holder.token) fs.unlinkSync(tombstone);
					else if (!fs.existsSync(lockPath)) fs.renameSync(tombstone, lockPath);
					continue;
				} catch { /* retry until the bounded deadline */ }
			}
			if (Date.now() - started >= timeoutMs) throw new WorkerArtifactWorkspaceLockedError(lockPath, holder);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, Math.max(1, timeoutMs - (Date.now() - started))));
		}
	}
	try { return operation(); }
	finally {
		try {
			if (sameIdentity(fs.fstatSync(fd), fs.lstatSync(lockPath)) && readLock(lockPath)?.token === token) {
				const tombstone = `${lockPath}.release-${token}`;
				fs.renameSync(lockPath, tombstone);
				if (sameIdentity(fs.fstatSync(fd), fs.lstatSync(tombstone))) fs.unlinkSync(tombstone);
			}
		} finally { fs.closeSync(fd); }
	}
}

function hasExactPinOwnership(raw: unknown, ref: WorkerArtifactReference): raw is Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const record = raw as Record<string, unknown>;
	return record.artifactId === ref.artifactId && record.worktreeHash === ref.worktreeHash && record.sha256 === ref.sha256;
}

function isValidOwnedPinRecord(raw: unknown, ref: WorkerArtifactReference, pinId: string): boolean {
	if (!hasExactPinOwnership(raw, ref)) return false;
	return raw.schema === STORAGE_SCHEMA && raw.version === 2 && raw.kind === "pin" && raw.pinId === pinId &&
		typeof raw.expiresAt === "string" && Number.isFinite(Date.parse(raw.expiresAt));
}

function pinWorkerArtifactUnderLock(
	ref: WorkerArtifactReference,
	paths: ReturnType<typeof artifactPathsFromRef>,
	id: string,
	expiresAt: string,
	timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): void {
	let opened: ReturnType<typeof openRetainedSnapshotDirectory> | undefined;
	try { opened = openRetainedSnapshotDirectory(ref, paths); }
	finally { if (opened) fs.closeSync(opened.fd); }
	const pinPath = path.join(paths.control, "pins", `${id}.json`);
	let existingOwnedPin = false;
	try {
		const existing = readRegularJson(pinPath);
		if (!hasExactPinOwnership(existing, ref)) {
			throw new Error(`artifact pin ${id} is already owned by another artifact`);
		}
		existingOwnedPin = isValidOwnedPinRecord(existing, ref, id);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	scheduleArtifactEligibilityWakeSync(paths.control, ref, timeoutMs);
	if (!existingOwnedPin) appendArtifactUsageJournalRecord(paths.control, ref, "pin", id);
	writeAtomicJson(pinPath, {
		schema: STORAGE_SCHEMA, version: 2, kind: "pin", pinId: id,
		artifactId: ref.artifactId, worktreeHash: ref.worktreeHash, sha256: ref.sha256, expiresAt,
	});
}

export function pinWorkerArtifactSync(value: unknown, pinId: string, options: { root?: string; expiresAt?: string; timeoutMs?: number } = {}): void {
	const ref = projectArtifactReference(value);
	const id = canonicalComponent(pinId, "pinId");
	const paths = artifactPathsFromRef(ref, options.root);
	const expiresAt = options.expiresAt ?? ref.expiresAt;
	if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError("artifact pin expiresAt must be an ISO timestamp");
	ensureRealOwnerDirectory(path.join(paths.control, "pins"));
	withMetadataLockSync(path.join(paths.control, "metadata.lock"), () => {
		pinWorkerArtifactUnderLock(ref, paths, id, expiresAt, options.timeoutMs);
	}, options.timeoutMs);
}

export function unpinWorkerArtifactSync(value: unknown, pinId: string, options: { root?: string; timeoutMs?: number } = {}): void {
	const ref = projectArtifactReference(value);
	const paths = artifactPathsFromRef(ref, options.root);
	const id = canonicalComponent(pinId, "pinId");
	const pinPath = path.join(paths.control, "pins", `${id}.json`);
	withMetadataLockSync(path.join(paths.control, "metadata.lock"), () => {
		let existing: Record<string, unknown>;
		try { existing = readRegularJson(pinPath) as Record<string, unknown>; }
		catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
		if (existing.artifactId !== ref.artifactId || existing.worktreeHash !== ref.worktreeHash || existing.sha256 !== ref.sha256) {
			throw new Error(`artifact pin ${id} belongs to another artifact`);
		}
		scheduleArtifactEligibilityWakeSync(paths.control, ref, options.timeoutMs);
		fs.unlinkSync(pinPath);
	}, options.timeoutMs);
}

export async function pinWorkerArtifact(value: unknown, pinId: string, options: { root?: string; expiresAt?: string; signal?: AbortSignal } = {}): Promise<void> {
	const ref = projectArtifactReference(value);
	const id = canonicalComponent(pinId, "pinId");
	const paths = artifactPathsFromRef(ref, options.root);
	const expiresAt = options.expiresAt ?? ref.expiresAt;
	if (!Number.isFinite(Date.parse(expiresAt))) throw new TypeError("artifact pin expiresAt must be an ISO timestamp");
	ensureRealOwnerDirectory(path.join(paths.control, "pins"));
	const lease = await acquireRawMetadataLease(path.join(paths.control, "metadata.lock"), options.signal);
	try {
		const manifest = parseManifest(readRegularJson(paths.manifest));
		if (!equalArtifactRef(manifest.artifactRef, ref)) throw new WorkerArtifactUnavailableError("artifact reference does not match its retained manifest", ref.artifactId);
		const pinPath = path.join(paths.control, "pins", `${id}.json`);
		let existingOwnedPin = false;
		try {
			const existing = readRegularJson(pinPath);
			if (!hasExactPinOwnership(existing, ref)) {
				throw new Error(`artifact pin ${id} is already owned by another artifact`);
			}
			existingOwnedPin = isValidOwnedPinRecord(existing, ref, id);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		await scheduleArtifactEligibilityWake(paths.control, ref, options.signal);
		if (!existingOwnedPin) appendArtifactUsageJournalRecord(paths.control, ref, "pin", id);
		writeAtomicJson(pinPath, {
			schema: STORAGE_SCHEMA, version: 2, kind: "pin", pinId: id,
			artifactId: ref.artifactId, worktreeHash: ref.worktreeHash, sha256: ref.sha256, expiresAt,
		});
	} finally { await lease.release(); }
}

export async function unpinWorkerArtifact(value: unknown, pinId: string, options: { root?: string; signal?: AbortSignal } = {}): Promise<void> {
	const ref = projectArtifactReference(value);
	const paths = artifactPathsFromRef(ref, options.root);
	const id = canonicalComponent(pinId, "pinId");
	const pinPath = path.join(paths.control, "pins", `${id}.json`);
	const lease = await acquireRawMetadataLease(path.join(paths.control, "metadata.lock"), options.signal);
	try {
		let existing: Record<string, unknown>;
		try { existing = readRegularJson(pinPath) as Record<string, unknown>; }
		catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
		if (existing.artifactId !== ref.artifactId || existing.worktreeHash !== ref.worktreeHash || existing.sha256 !== ref.sha256) {
			throw new Error(`artifact pin ${id} belongs to another artifact`);
		}
		await scheduleArtifactEligibilityWake(paths.control, ref, options.signal);
		fs.unlinkSync(pinPath);
	} finally { await lease.release(); }
}

export interface WorkerArtifactStorageSweepOptions {
	root?: string;
	now?: number;
	maxCandidates?: number;
	timeBudgetMs?: number;
	abandonedGraceMs?: number;
}

interface ArtifactUsageScanBudget {
	deadline: number;
	remainingRecords: number;
}

interface ArtifactEligibilityWakeRecord {
	schema: typeof STORAGE_SCHEMA;
	version: 2;
	kind: "artifact-eligibility-wake";
	workspaceHash: string;
	artifactId: string;
	maintenanceSequence: number;
	generation: number;
}

const MAX_ARTIFACT_USAGE_RECORDS_PER_CANDIDATE = 256;
const MAX_ARTIFACT_USAGE_JOURNAL_LINE_BYTES = 1_024;
const MAX_ARTIFACT_USAGE_RECORD_BYTES = 4_096;

function artifactUsageJournalPaths(controlRoot: string, artifactId: string): { root: string; journal: string; cursor: string } {
	const root = path.join(controlRoot, "usage", "artifacts", artifactId);
	return { root, journal: path.join(root, "records.ndjson"), cursor: path.join(root, "cursor.json") };
}

function initializeArtifactUsageJournal(controlRoot: string, artifactId: string): ReturnType<typeof artifactUsageJournalPaths> {
	const paths = artifactUsageJournalPaths(controlRoot, artifactId);
	ensureRealOwnerDirectory(path.dirname(paths.root));
	ensureRealOwnerDirectory(paths.root);
	const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
	const fd = fs.openSync(paths.journal, flags, STATE_FILE_MODE);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1) throw new Error("artifact usage journal must be one regular file");
		fs.fchmodSync(fd, STATE_FILE_MODE);
	} finally { fs.closeSync(fd); }
	return paths;
}

function artifactEligibilityWakePath(controlRoot: string, artifactId: string): string {
	return path.join(artifactUsageJournalPaths(controlRoot, artifactId).root, "maintenance-wake.json");
}

function parseArtifactEligibilityWake(
	raw: unknown,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
): ArtifactEligibilityWakeRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.schema !== STORAGE_SCHEMA || value.version !== 2 || value.kind !== "artifact-eligibility-wake" ||
		value.workspaceHash !== ref.worktreeHash || value.artifactId !== ref.artifactId ||
		typeof value.maintenanceSequence !== "number" || !Number.isSafeInteger(value.maintenanceSequence) || value.maintenanceSequence < 1 ||
		typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) return undefined;
	return {
		schema: STORAGE_SCHEMA, version: 2, kind: "artifact-eligibility-wake",
		workspaceHash: ref.worktreeHash, artifactId: ref.artifactId,
		maintenanceSequence: value.maintenanceSequence, generation: value.generation,
	};
}

function readArtifactEligibilityWake(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
): ArtifactEligibilityWakeRecord | undefined {
	try { return parseArtifactEligibilityWake(readBoundedUsageRecord(artifactEligibilityWakePath(controlRoot, ref.artifactId)), ref); }
	catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined; throw error; }
}

interface ArtifactEligibilityWakeSnapshot {
	wake: ArtifactEligibilityWakeRecord;
	dev: number;
	ino: number;
}

function readArtifactEligibilityWakeSnapshot(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
): ArtifactEligibilityWakeSnapshot | undefined {
	const wakePath = artifactEligibilityWakePath(controlRoot, ref.artifactId);
	const before = fs.lstatSync(wakePath);
	const wake = readArtifactEligibilityWake(controlRoot, ref);
	const after = fs.lstatSync(wakePath);
	if (!wake || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !sameIdentity(before, after)) return undefined;
	return { wake, dev: before.dev, ino: before.ino };
}

function artifactEligibilityWakeMatches(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
	expected: { maintenanceSequence: number; generation: number; dev: number; ino: number },
): boolean {
	try {
		const snapshot = readArtifactEligibilityWakeSnapshot(controlRoot, ref);
		return snapshot !== undefined && snapshot.wake.maintenanceSequence === expected.maintenanceSequence &&
			snapshot.wake.generation === expected.generation && snapshot.dev === expected.dev && snapshot.ino === expected.ino;
	} catch {
		return false;
	}
}

function artifactWakeOwnsMaintenanceRecord(namespace: string, wake: ArtifactEligibilityWakeRecord): boolean {
	const recordPath = path.join(namespace, "maintenance-queue", `${wake.maintenanceSequence}.json`);
	let raw: unknown;
	try { raw = readBoundedUsageRecord(recordPath); }
	catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const value = raw as Record<string, unknown>;
	if (value.schema !== STORAGE_SCHEMA || value.version !== 2 || value.sequence !== wake.maintenanceSequence ||
		value.workspaceHash !== wake.workspaceHash) return false;
	if (value.kind === "publication") return value.artifactId === wake.artifactId;
	const transition = parseMaintenanceTransitionRecord(value, wake.maintenanceSequence);
	return transition?.sourceKind === "artifact" && transition.artifactId === wake.artifactId &&
		transition.workspaceHash === wake.workspaceHash;
}

function writeArtifactEligibilityWake(controlRoot: string, wake: ArtifactEligibilityWakeRecord): void {
	writeAtomicJson(artifactEligibilityWakePath(controlRoot, wake.artifactId), wake);
}

function initializeArtifactEligibilityWakeUnderMaintenanceLock(
	namespace: string,
	controlRoot: string,
	ref: WorkerArtifactReference,
	maintenanceSequence: number,
): void {
	const wake: ArtifactEligibilityWakeRecord = {
		schema: STORAGE_SCHEMA, version: 2, kind: "artifact-eligibility-wake",
		workspaceHash: ref.worktreeHash, artifactId: ref.artifactId, maintenanceSequence, generation: 1,
	};
	if (!artifactWakeOwnsMaintenanceRecord(namespace, wake)) {
		throw new Error("artifact eligibility wake does not own its publication ledger record");
	}
	writeArtifactEligibilityWake(controlRoot, wake);
}

async function initializeArtifactEligibilityWake(
	workspace: WorkerArtifactWorkspace,
	ref: WorkerArtifactReference,
	maintenanceSequence: number,
	signal?: AbortSignal,
): Promise<void> {
	const lease = await acquireMetadataLeaseAtPath(path.join(workspace.namespaceRoot, "maintenance.lock"), { signal });
	try { initializeArtifactEligibilityWakeUnderMaintenanceLock(workspace.namespaceRoot, workspace.controlRoot, ref, maintenanceSequence); }
	finally { await lease.release(); }
}

function scheduleArtifactEligibilityWakeUnderMaintenanceLock(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
): void {
	const namespace = maintenanceNamespaceFromControlRoot(controlRoot);
	const wake = readArtifactEligibilityWake(controlRoot, ref);
	if (!wake || !artifactWakeOwnsMaintenanceRecord(namespace, wake)) {
		throw new Error("artifact eligibility wake is missing or does not own its maintenance record");
	}
	if (wake.generation >= Number.MAX_SAFE_INTEGER) throw new Error("artifact eligibility wake generation is exhausted");
	const updated = { ...wake, generation: wake.generation + 1 };
	writeArtifactEligibilityWake(controlRoot, updated);
	const cursorPath = path.join(namespace, "maintenance-cursor.json");
	const state = readMaintenanceCursor(cursorPath);
	state.queueOffset = Math.min(state.queueOffset, wake.maintenanceSequence - 1);
	writeMaintenanceCursor(cursorPath, state);
}

async function scheduleArtifactEligibilityWake(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
	signal?: AbortSignal,
): Promise<void> {
	const namespace = maintenanceNamespaceFromControlRoot(controlRoot);
	const lease = await acquireMetadataLeaseAtPath(path.join(namespace, "maintenance.lock"), { signal });
	try { scheduleArtifactEligibilityWakeUnderMaintenanceLock(controlRoot, ref); }
	finally { await lease.release(); }
}

function scheduleArtifactEligibilityWakeSync(
	controlRoot: string,
	ref: Pick<WorkerArtifactReference, "artifactId" | "worktreeHash">,
	timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): void {
	const namespace = maintenanceNamespaceFromControlRoot(controlRoot);
	withMetadataLockSync(path.join(namespace, "maintenance.lock"), () => {
		scheduleArtifactEligibilityWakeUnderMaintenanceLock(controlRoot, ref);
	}, timeoutMs);
}

async function quarantineUncommittedArtifactUsage(
	controlRoot: string,
	dataRoot: string,
	artifactId: string,
	expected: fs.Stats,
): Promise<QuarantinedCandidate | undefined> {
	const usageRoot = artifactUsageJournalPaths(controlRoot, artifactId).root;
	const quarantineRoot = path.join(dataRoot, "quarantine");
	try {
		ensureRealOwnerDirectory(quarantineRoot);
		const before = fs.lstatSync(usageRoot);
		if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, expected)) return undefined;
		const quarantine = path.join(quarantineRoot, `uncommitted-usage-${artifactId}-${randomUUID()}`);
		await registerMaintenanceRecords(path.dirname(path.dirname(dataRoot)), path.basename(dataRoot), [{
			kind: "quarantine", entryName: path.basename(quarantine), dev: before.dev, ino: before.ino,
		}], undefined, () => { fs.renameSync(usageRoot, quarantine); });
		const moved = fs.lstatSync(quarantine);
		if (!moved.isDirectory() || moved.isSymbolicLink() || !sameIdentity(moved, expected)) {
			// Do not restore by pathname: rename may overwrite a concurrently installed
			// empty directory. The unique quarantine name remains available to maintenance.
			return undefined;
		}
		return { path: quarantine, dev: moved.dev, ino: moved.ino };
	} catch {
		return undefined;
	}
}

function appendArtifactUsageJournalRecord(
	controlRoot: string,
	ref: WorkerArtifactReference,
	kind: "pin" | "reader",
	id: string,
): void {
	const paths = initializeArtifactUsageJournal(controlRoot, ref.artifactId);
	const value = kind === "pin"
		? { schema: STORAGE_SCHEMA, version: 2, kind, artifactId: ref.artifactId, worktreeHash: ref.worktreeHash, sha256: ref.sha256, pinId: id }
		: { schema: STORAGE_SCHEMA, version: 2, kind, artifactId: ref.artifactId, worktreeHash: ref.worktreeHash, sha256: ref.sha256, readerId: id };
	const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	if (encoded.byteLength > MAX_ARTIFACT_USAGE_JOURNAL_LINE_BYTES) throw new Error("artifact usage journal record is too large");
	const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
	const fd = fs.openSync(paths.journal, flags);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1) throw new Error("artifact usage journal identity is invalid");
		fs.writeFileSync(fd, encoded);
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
}

function readArtifactUsageCursor(cursorPath: string, journalSize: number): number {
	try {
		const value = readBoundedUsageRecord(cursorPath) as Record<string, unknown>;
		if (value.schema === STORAGE_SCHEMA && value.version === 2 && value.kind === "artifact-usage-cursor" &&
			typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= journalSize) {
			return value.offset;
		}
	} catch { /* absent or malformed cursor restarts the bounded pass */ }
	return 0;
}

function writeArtifactUsageCursor(cursorPath: string, offset: number): void {
	writeAtomicJson(cursorPath, { schema: STORAGE_SCHEMA, version: 2, kind: "artifact-usage-cursor", offset });
}

function readBoundedJournalLine(fd: number, offset: number, size: number): { line: string; nextOffset: number } | undefined {
	if (offset >= size) return undefined;
	const chunks: Buffer[] = [];
	let bytes = 0;
	while (offset + bytes < size && bytes <= MAX_ARTIFACT_USAGE_JOURNAL_LINE_BYTES) {
		const chunk = Buffer.alloc(Math.min(256, size - (offset + bytes)));
		const read = fs.readSync(fd, chunk, 0, chunk.byteLength, offset + bytes);
		if (read <= 0) break;
		const newline = chunk.subarray(0, read).indexOf(0x0a);
		if (newline >= 0) {
			chunks.push(chunk.subarray(0, newline));
			const lineBytes = bytes + newline;
			if (lineBytes > MAX_ARTIFACT_USAGE_JOURNAL_LINE_BYTES) throw new Error("artifact usage journal line exceeds its bound");
			return { line: Buffer.concat(chunks, lineBytes).toString("utf8"), nextOffset: offset + lineBytes + 1 };
		}
		chunks.push(chunk.subarray(0, read));
		bytes += read;
	}
	throw new Error("artifact usage journal has an oversized or partial record");
}

function readBoundedUsageRecord(target: string): unknown {
	const before = fs.lstatSync(target);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_ARTIFACT_USAGE_RECORD_BYTES) {
		throw new Error("artifact usage metadata exceeds its identity or size bound");
	}
	return readRegularJson(target);
}

function activeArtifactUsage(
	controlRoot: string,
	ref: WorkerArtifactReference,
	now: number,
	graceMs: number,
	budget: ArtifactUsageScanBudget,
	maintenanceLockHeld = false,
): boolean {
	const paths = artifactUsageJournalPaths(controlRoot, ref.artifactId);
	let fd: number | undefined;
	try {
		const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
		fd = fs.openSync(paths.journal, flags);
		const journal = fs.fstatSync(fd);
		if (!journal.isFile() || journal.nlink !== 1) return true;
		let offset = readArtifactUsageCursor(paths.cursor, journal.size);
		while (budget.remainingRecords > 0 && maintenanceClock() < budget.deadline) {
			const recordOffset = offset;
			const next = readBoundedJournalLine(fd, offset, journal.size);
			if (!next) {
				fs.rmSync(paths.cursor, { force: true });
				return false;
			}
			offset = next.nextOffset;
			budget.remainingRecords -= 1;
			let raw: unknown;
			try { raw = JSON.parse(next.line) as unknown; }
			catch { return true; }
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
			const event = raw as Record<string, unknown>;
			const kind = event.kind === "pin" || event.kind === "reader" ? event.kind : undefined;
			if (!kind || event.schema !== STORAGE_SCHEMA || event.version !== 2 || event.artifactId !== ref.artifactId ||
				event.worktreeHash !== ref.worktreeHash || event.sha256 !== ref.sha256) return true;
			const id = kind === "pin" ? event.pinId : event.readerId;
			if (typeof id !== "string") return true;
			if (kind === "reader" && !UUID.test(id)) return true;
			if (kind === "pin") {
				try { if (canonicalComponent(id, "pinId") !== id) return true; }
				catch { return true; }
			}
			afterArtifactUsageRecordForTests?.(kind, id);
			const recordPath = kind === "pin"
				? path.join(controlRoot, "pins", `${id}.json`)
				: path.join(controlRoot, "usage", "readers", `${id}.json`);
			let recordRaw: unknown;
			try { recordRaw = readBoundedUsageRecord(recordPath); }
			catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				writeArtifactUsageCursor(paths.cursor, recordOffset);
				return true;
			}
			if (!recordRaw || typeof recordRaw !== "object" || Array.isArray(recordRaw)) {
				writeArtifactUsageCursor(paths.cursor, recordOffset);
				return true;
			}
			const record = recordRaw as Record<string, unknown>;
			if (record.artifactId !== ref.artifactId || record.worktreeHash !== ref.worktreeHash || record.sha256 !== ref.sha256) continue;
			if (kind === "pin") {
				if (record.schema !== STORAGE_SCHEMA || record.version !== 2 || record.kind !== "pin" || record.pinId !== id ||
					typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) >= now) {
					writeArtifactUsageCursor(paths.cursor, recordOffset);
					return true;
				}
				continue;
			}
			if (record.schema !== STORAGE_SCHEMA || record.version !== 2 || record.kind !== "reader" || record.readerId !== id ||
				typeof record.hostname !== "string" || typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0 ||
				typeof record.admittedAt !== "number" || !Number.isFinite(record.admittedAt) || record.hostname !== os.hostname()) {
				writeArtifactUsageCursor(paths.cursor, recordOffset);
				return true;
			}
			const startTime = typeof record.processStartTime === "string" ? record.processStartTime : undefined;
			if (processIsAlive(record.pid, startTime) || now - record.admittedAt < graceMs) {
				writeArtifactUsageCursor(paths.cursor, recordOffset);
				return true;
			}
			try {
				if (maintenanceLockHeld) scheduleArtifactEligibilityWakeUnderMaintenanceLock(controlRoot, ref);
				else scheduleArtifactEligibilityWakeSync(controlRoot, ref, 0);
			} catch { writeArtifactUsageCursor(paths.cursor, recordOffset); return true; }
			try { fs.unlinkSync(recordPath); }
			catch (error) { if (errorCode(error) !== "ENOENT") return true; }
		}
		writeArtifactUsageCursor(paths.cursor, offset);
		return true;
	} catch {
		return true;
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort descriptor cleanup */ }
	}
}

function safeDirectoryEntries(directory: string): fs.Dirent[] {
	try { return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); } catch { return []; }
}

interface QuarantinedCandidate {
	path: string;
	dev: number;
	ino: number;
	related?: QuarantinedCandidate[];
}

let beforeQuarantineDeleteForTests: ((candidatePath: string) => void) | undefined;
let afterQuarantineDeleteCaptureForTests: ((candidatePath: string) => void) | undefined;
let maintenanceClockForTests: (() => number) | undefined;
let beforeMaintenanceCandidateForTests: ((candidateKey: string) => void) | undefined;
let afterMaintenanceCandidateForTests: ((candidateKey: string) => void) | undefined;
let afterMaintenancePhysicalEntryForTests: ((directory: string, entryName: string) => void) | undefined;
let afterArtifactUsageRecordForTests: ((kind: "pin" | "reader", entryName: string) => void) | undefined;
export type WorkerArtifactQuarantinePhase =
	| "before-snapshot-move"
	| "after-snapshot-move"
	| "before-usage-move"
	| "after-usage-move";
interface WorkerArtifactQuarantinePaths {
	snapshot: string;
	snapshotQuarantine: string;
	usageRoot: string;
	usageQuarantine: string;
}
let artifactQuarantinePhaseHookForTests: ((phase: WorkerArtifactQuarantinePhase, paths: WorkerArtifactQuarantinePaths) => void) | undefined;

export type WorkerArtifactAttemptQuarantinePhase =
	| "before-attempt-move"
	| "after-attempt-move"
	| "before-owner-bind"
	| "after-owner-bind"
	| "before-owner-unlink"
	| "after-owner-unlink";
interface WorkerArtifactAttemptQuarantinePaths {
	attemptRoot: string;
	attemptQuarantine: string;
	ownerPath: string;
	ownerQuarantine: string;
}
let artifactAttemptQuarantinePhaseHookForTests: ((phase: WorkerArtifactAttemptQuarantinePhase, paths: WorkerArtifactAttemptQuarantinePaths) => void) | undefined;
let beforeCapturedDirectoryRollbackForTests: ((originalPath: string, quarantinePath: string) => void) | undefined;
const pendingQuarantineDeletes = new Map<string, Promise<void>>();

export function __setArtifactMaintenanceClockForTests(clock: (() => number) | undefined): () => void {
	const previous = maintenanceClockForTests;
	maintenanceClockForTests = clock;
	return () => { maintenanceClockForTests = previous; };
}

export function __setArtifactMaintenanceBeforeCandidateHookForTests(hook: ((candidateKey: string) => void) | undefined): () => void {
	const previous = beforeMaintenanceCandidateForTests;
	beforeMaintenanceCandidateForTests = hook;
	return () => { beforeMaintenanceCandidateForTests = previous; };
}

export function __setArtifactMaintenanceCandidateHookForTests(hook: ((candidateKey: string) => void) | undefined): () => void {
	const previous = afterMaintenanceCandidateForTests;
	afterMaintenanceCandidateForTests = hook;
	return () => { afterMaintenanceCandidateForTests = previous; };
}

export function __setArtifactMaintenancePhysicalEntryHookForTests(
	hook: ((directory: string, entryName: string) => void) | undefined,
): () => void {
	const previous = afterMaintenancePhysicalEntryForTests;
	afterMaintenancePhysicalEntryForTests = hook;
	return () => { afterMaintenancePhysicalEntryForTests = previous; };
}

export function __setArtifactUsageRecordEnumerationHookForTests(
	hook: ((kind: "pin" | "reader", entryName: string) => void) | undefined,
): () => void {
	const previous = afterArtifactUsageRecordForTests;
	afterArtifactUsageRecordForTests = hook;
	return () => { afterArtifactUsageRecordForTests = previous; };
}

export function __setArtifactQuarantinePhaseHookForTests(
	hook: typeof artifactQuarantinePhaseHookForTests,
): () => void {
	const previous = artifactQuarantinePhaseHookForTests;
	artifactQuarantinePhaseHookForTests = hook;
	return () => { artifactQuarantinePhaseHookForTests = previous; };
}

export function __setArtifactAttemptQuarantinePhaseHookForTests(
	hook: typeof artifactAttemptQuarantinePhaseHookForTests,
): () => void {
	const previous = artifactAttemptQuarantinePhaseHookForTests;
	artifactAttemptQuarantinePhaseHookForTests = hook;
	return () => { artifactAttemptQuarantinePhaseHookForTests = previous; };
}

export function __setArtifactRollbackRaceHookForTests(
	hook: typeof beforeCapturedDirectoryRollbackForTests,
): () => void {
	const previous = beforeCapturedDirectoryRollbackForTests;
	beforeCapturedDirectoryRollbackForTests = hook;
	return () => { beforeCapturedDirectoryRollbackForTests = previous; };
}

function maintenanceClock(): number {
	return maintenanceClockForTests?.() ?? Date.now();
}

export function __setArtifactQuarantineDeleteHookForTests(hook: ((candidatePath: string) => void) | undefined): () => void {
	const previous = beforeQuarantineDeleteForTests;
	beforeQuarantineDeleteForTests = hook;
	return () => { beforeQuarantineDeleteForTests = previous; };
}

export function __setArtifactQuarantineDeleteAfterCaptureHookForTests(hook: ((candidatePath: string) => void) | undefined): () => void {
	const previous = afterQuarantineDeleteCaptureForTests;
	afterQuarantineDeleteCaptureForTests = hook;
	return () => { afterQuarantineDeleteCaptureForTests = previous; };
}

export async function __waitForArtifactQuarantineDeletesForTests(): Promise<void> {
	await Promise.allSettled([...pendingQuarantineDeletes.values()]);
}

let descriptorDirectoryPathForTests: ((fd: number) => string | undefined) | undefined;

export function __setArtifactDescriptorDirectoryPathForTests(
	resolver: ((fd: number) => string | undefined) | undefined,
): () => void {
	const previous = descriptorDirectoryPathForTests;
	descriptorDirectoryPathForTests = resolver;
	return () => { descriptorDirectoryPathForTests = previous; };
}

function descriptorDirectoryPath(fd: number): string | undefined {
	if (descriptorDirectoryPathForTests) return descriptorDirectoryPathForTests(fd);
	for (const candidate of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
		try {
			const stat = fs.statSync(candidate);
			if (stat.isDirectory()) return candidate;
		} catch { /* try the next descriptor namespace */ }
	}
	return undefined;
}

function descriptorCurrentPath(fd: number): string | undefined {
	for (const candidate of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) {
		try {
			const target = fs.readlinkSync(candidate);
			if (path.isAbsolute(target) && !target.endsWith(" (deleted)")) return target;
		} catch { /* descriptor symlinks are not available on every platform */ }
	}
	return undefined;
}

function descriptorPathWithin(fd: number, quarantineRoot: string): string {
	const currentPath = descriptorCurrentPath(fd);
	if (!currentPath) throw new Error("quarantine path is no longer identity-pinned");
	const relative = path.relative(quarantineRoot, currentPath);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("quarantine identity moved outside its owned root");
	}
	return currentPath;
}

async function removePinnedDirectory(
	fd: number,
	expected: Pick<fs.Stats, "dev" | "ino">,
	quarantineRoot: string,
): Promise<void> {
	descriptorPathWithin(fd, quarantineRoot);
	const descriptorPath = descriptorDirectoryPath(fd);
	if (!descriptorPath) throw new Error("descriptor-relative quarantine deletion is unavailable");
	for (const entry of await fs.promises.readdir(descriptorPath, { withFileTypes: true })) {
		descriptorPathWithin(fd, quarantineRoot);
		const childPath = path.join(descriptorPath, entry.name);
		const before = await fs.promises.lstat(childPath);
		if (!before.isDirectory() || before.isSymbolicLink()) {
			descriptorPathWithin(fd, quarantineRoot);
			await fs.promises.unlink(childPath);
			continue;
		}
		const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
		const childFd = fs.openSync(childPath, flags);
		try {
			const opened = fs.fstatSync(childFd);
			if (!opened.isDirectory() || !sameIdentity(before, opened)) {
				throw new Error("quarantine child identity changed during deletion");
			}
			await removePinnedDirectory(childFd, opened, quarantineRoot);
			const currentPath = descriptorPathWithin(childFd, quarantineRoot);
			const current = fs.lstatSync(currentPath);
			if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, opened)) {
				throw new Error("quarantine child path was replaced during deletion");
			}
			await fs.promises.rmdir(currentPath);
		} finally {
			fs.closeSync(childFd);
		}
	}
	const opened = fs.fstatSync(fd);
	if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
		throw new Error("quarantine root identity changed during deletion");
	}
}

async function removePinnedQuarantineRoot(fd: number, candidate: QuarantinedCandidate): Promise<void> {
	const quarantineRoot = path.resolve(path.dirname(candidate.path));
	await removePinnedDirectory(fd, candidate, quarantineRoot);
	const currentPath = descriptorPathWithin(fd, quarantineRoot);
	const current = fs.lstatSync(currentPath);
	if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== candidate.dev || current.ino !== candidate.ino) {
		throw new Error("quarantine root path was replaced during deletion");
	}
	await fs.promises.rmdir(currentPath);
}

function deleteCapturedQuarantine(candidate: QuarantinedCandidate): boolean {
	let deletionFd: number | undefined;
	try {
		beforeQuarantineDeleteForTests?.(candidate.path);
		const current = fs.lstatSync(candidate.path);
		if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== candidate.dev || current.ino !== candidate.ino) return false;
		// Hold the exact unique quarantine identity open across the asynchronous
		// recursive walk. Avoid a second pathname rename: it would need another
		// no-replace transition record and cannot improve descriptor confinement.
		const deletePath = candidate.path;
		const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
		deletionFd = fs.openSync(deletePath, flags);
		const opened = fs.fstatSync(deletionFd);
		if (!opened.isDirectory() || !sameIdentity(opened, current)) throw new Error("quarantine delete descriptor identity changed");
		fs.fchmodSync(deletionFd, 0o700);
		afterQuarantineDeleteCaptureForTests?.(deletePath);
		const ownedFd = deletionFd;
		deletionFd = undefined;
		const deletion = removePinnedQuarantineRoot(ownedFd, candidate).catch(() => {
			// Exact identity can no longer be proved. Fail safely and let a later
			// bounded sweep retry whichever captured inode remains.
		}).finally(() => {
			try { fs.closeSync(ownedFd); } catch { /* already closed or process teardown */ }
			pendingQuarantineDeletes.delete(deletePath);
		});
		pendingQuarantineDeletes.set(deletePath, deletion);
		return true;
	} catch {
		if (deletionFd !== undefined) try { fs.closeSync(deletionFd); } catch { /* best effort */ }
		return false;
	}
}

function retainCapturedDirectory(
	originalPath: string,
	quarantinePath: string,
	expected: fs.Stats,
): boolean {
	try {
		const quarantined = fs.lstatSync(quarantinePath);
		if (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !sameIdentity(quarantined, expected)) return false;
		// Keep the old absence check only as the deterministic race-test barrier; it
		// grants no authority to mutate the pathname after the hook returns.
		try { fs.lstatSync(originalPath); return false; }
		catch (error) { if (errorCode(error) !== "ENOENT") return false; }
		// Node exposes no portable RENAME_NOREPLACE for directories. Once captured,
		// keep this exact identity at its unique owned quarantine path. This code is
		// not an OS sandbox against arbitrary same-user native code, but the storage
		// API must not overwrite a sibling/replacement identity through a
		// check-then-rename rollback.
		beforeCapturedDirectoryRollbackForTests?.(originalPath, quarantinePath);
		return true;
	} catch {
		return false;
	}
}

type MaintenanceTransitionPhase = "prepared" | "maintenance-owned";

interface MaintenanceTransitionBase {
	schema: typeof STORAGE_SCHEMA;
	version: 2;
	kind: "cleanup-transition";
	sequence: number;
	workspaceHash: string;
	transitionId: string;
	phase: MaintenanceTransitionPhase;
}

interface ArtifactMaintenanceTransitionRecord extends MaintenanceTransitionBase {
	sourceKind: "artifact";
	artifactId: string;
	snapshotSourceDev: number;
	snapshotSourceIno: number;
	snapshotDestinationDev: number;
	snapshotDestinationIno: number;
	usageSourceDev: number;
	usageSourceIno: number;
	usageDestinationDev: number;
	usageDestinationIno: number;
}

interface AttemptMaintenanceTransitionRecord extends MaintenanceTransitionBase {
	sourceKind: "attempt";
	attemptId: string;
	attemptSourceDev: number;
	attemptSourceIno: number;
	attemptDestinationDev: number;
	attemptDestinationIno: number;
	scratchDev: number;
	scratchIno: number;
	outputDev: number;
	outputIno: number;
	ownerSourceDev: number;
	ownerSourceIno: number;
	ownerDestinationDev: number;
	ownerDestinationIno: number;
}

type MaintenanceTransitionRecord = ArtifactMaintenanceTransitionRecord | AttemptMaintenanceTransitionRecord;
type MaintenanceTransitionInput =
	| Omit<ArtifactMaintenanceTransitionRecord, "schema" | "version" | "sequence" | "workspaceHash">
	| Omit<AttemptMaintenanceTransitionRecord, "schema" | "version" | "sequence" | "workspaceHash">;

type ExpectedIdentity = Pick<fs.Stats, "dev" | "ino">;
type IdentityState =
	| { kind: "exact"; stat: fs.Stats }
	| { kind: "absent" }
	| { kind: "foreign" };

function inspectIdentity(target: string, expected: ExpectedIdentity, expectedKind: "directory" | "file"): IdentityState {
	try {
		const stat = fs.lstatSync(target);
		const correctKind = expectedKind === "directory" ? stat.isDirectory() : stat.isFile();
		return correctKind && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino
			? { kind: "exact", stat }
			: { kind: "foreign" };
	} catch (error) {
		return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "foreign" };
	}
}

function moveExactDirectory(
	source: string,
	destination: string,
	expected: ExpectedIdentity,
	beforeMove?: () => void,
	afterMove?: () => void,
): fs.Stats | undefined {
	const destinationBefore = inspectIdentity(destination, expected, "directory");
	const sourceBefore = inspectIdentity(source, expected, "directory");
	if (destinationBefore.kind === "exact") {
		return sourceBefore.kind === "exact" ? undefined : destinationBefore.stat;
	}
	if (destinationBefore.kind !== "absent" || sourceBefore.kind !== "exact") return undefined;
	beforeMove?.();
	if (inspectIdentity(destination, expected, "directory").kind !== "absent" ||
		inspectIdentity(source, expected, "directory").kind !== "exact") return undefined;
	fs.renameSync(source, destination);
	afterMove?.();
	const moved = inspectIdentity(destination, expected, "directory");
	return moved.kind === "exact" ? moved.stat : undefined;
}

function artifactTransitionPaths(
	dataRoot: string,
	controlRoot: string,
	record: ArtifactMaintenanceTransitionRecord,
): WorkerArtifactQuarantinePaths {
	return {
		snapshot: path.join(dataRoot, "artifacts", record.artifactId),
		snapshotQuarantine: path.join(dataRoot, "quarantine", `artifact-${record.artifactId}-${record.transitionId}`),
		usageRoot: path.join(controlRoot, "usage", "artifacts", record.artifactId),
		usageQuarantine: path.join(dataRoot, "quarantine", `usage-artifact-${record.artifactId}-${record.transitionId}`),
	};
}

function attemptTransitionPaths(
	dataRoot: string,
	controlRoot: string,
	record: AttemptMaintenanceTransitionRecord,
): WorkerArtifactAttemptQuarantinePaths {
	const attemptQuarantine = path.join(dataRoot, "quarantine", `abandoned-${record.attemptId}-${record.transitionId}`);
	return {
		attemptRoot: path.join(dataRoot, "attempts", record.attemptId),
		attemptQuarantine,
		ownerPath: path.join(controlRoot, "usage", "attempts", `${record.attemptId}.json`),
		ownerQuarantine: path.join(attemptQuarantine, ".attempt-owner.json"),
	};
}

function removeCompletedTransitionRecord(recordPath: string, record: MaintenanceTransitionRecord): void {
	try {
		const current = parseMaintenanceTransitionRecord(readBoundedUsageRecord(recordPath), record.sequence);
		if (!current || current.workspaceHash !== record.workspaceHash || current.transitionId !== record.transitionId ||
			current.sourceKind !== record.sourceKind || current.phase !== "maintenance-owned") return;
		fs.unlinkSync(recordPath);
	} catch { /* a missing or replaced transition remains diagnostic */ }
}

function capturedDirectories(
	directories: Array<{ path: string; state: IdentityState }>,
): QuarantinedCandidate | undefined {
	const exact = directories.flatMap(({ path: candidatePath, state }) =>
		state.kind === "exact" ? [{ path: candidatePath, dev: state.stat.dev, ino: state.stat.ino }] : []);
	if (exact.length === 0) return undefined;
	const [first, ...related] = exact;
	return { ...first, ...(related.length > 0 ? { related } : {}) };
}

function advanceArtifactMaintenanceTransition(
	recordPath: string,
	dataRoot: string,
	controlRoot: string,
	record: ArtifactMaintenanceTransitionRecord,
	invokeHooks: boolean,
): QuarantinedCandidate | undefined {
	const paths = artifactTransitionPaths(dataRoot, controlRoot, record);
	const snapshotExpected = { dev: record.snapshotDestinationDev, ino: record.snapshotDestinationIno };
	const usageExpected = { dev: record.usageDestinationDev, ino: record.usageDestinationIno };
	if (record.phase === "maintenance-owned") {
		const destinations = [
			{ path: paths.snapshotQuarantine, state: inspectIdentity(paths.snapshotQuarantine, snapshotExpected, "directory") },
			{ path: paths.usageQuarantine, state: inspectIdentity(paths.usageQuarantine, usageExpected, "directory") },
		];
		if (destinations.some(({ state }) => state.kind === "foreign")) return undefined;
		const captured = capturedDirectories(destinations);
		if (!captured) {
			const sources = [
				inspectIdentity(paths.snapshot, { dev: record.snapshotSourceDev, ino: record.snapshotSourceIno }, "directory"),
				inspectIdentity(paths.usageRoot, { dev: record.usageSourceDev, ino: record.usageSourceIno }, "directory"),
			];
			if (sources.every((state) => state.kind === "absent")) removeCompletedTransitionRecord(recordPath, record);
		}
		return captured;
	}
	const snapshotSource = inspectIdentity(paths.snapshot, snapshotExpected, "directory");
	if (snapshotSource.kind === "exact") fs.chmodSync(paths.snapshot, 0o700);
	let snapshot: fs.Stats | undefined;
	try {
		snapshot = moveExactDirectory(
			paths.snapshot, paths.snapshotQuarantine, snapshotExpected,
			invokeHooks ? () => artifactQuarantinePhaseHookForTests?.("before-snapshot-move", paths) : undefined,
			invokeHooks ? () => artifactQuarantinePhaseHookForTests?.("after-snapshot-move", paths) : undefined,
		);
	} catch (error) {
		if (inspectIdentity(paths.snapshot, snapshotExpected, "directory").kind === "exact") {
			try { fs.chmodSync(paths.snapshot, 0o500); } catch { /* preserve the transition failure */ }
		}
		throw error;
	}
	if (!snapshot) {
		if (inspectIdentity(paths.snapshot, snapshotExpected, "directory").kind === "exact") {
			try { fs.chmodSync(paths.snapshot, 0o500); } catch { /* preserve the identity conflict */ }
		}
		return undefined;
	}
	const usage = moveExactDirectory(
		paths.usageRoot, paths.usageQuarantine, usageExpected,
		invokeHooks ? () => artifactQuarantinePhaseHookForTests?.("before-usage-move", paths) : undefined,
		invokeHooks ? () => artifactQuarantinePhaseHookForTests?.("after-usage-move", paths) : undefined,
	);
	if (!usage) return undefined;
	const maintenanceOwned: ArtifactMaintenanceTransitionRecord = { ...record, phase: "maintenance-owned" };
	writeAtomicJson(recordPath, maintenanceOwned);
	return {
		path: paths.snapshotQuarantine, dev: snapshot.dev, ino: snapshot.ino,
		related: [{ path: paths.usageQuarantine, dev: usage.dev, ino: usage.ino }],
	};
}

function attemptChildrenMatch(root: string, record: AttemptMaintenanceTransitionRecord): boolean {
	return inspectIdentity(path.join(root, "scratch"), { dev: record.scratchDev, ino: record.scratchIno }, "directory").kind === "exact" &&
		inspectIdentity(path.join(root, "output"), { dev: record.outputDev, ino: record.outputIno }, "directory").kind === "exact";
}

function bindExactAttemptOwner(
	paths: WorkerArtifactAttemptQuarantinePaths,
	record: AttemptMaintenanceTransitionRecord,
	invokeHooks: boolean,
): boolean {
	const expected = { dev: record.ownerDestinationDev, ino: record.ownerDestinationIno };
	let destination = inspectIdentity(paths.ownerQuarantine, expected, "file");
	let source = inspectIdentity(paths.ownerPath, { dev: record.ownerSourceDev, ino: record.ownerSourceIno }, "file");
	if (destination.kind === "absent") {
		if (source.kind !== "exact" || source.stat.nlink !== 1) return false;
		if (invokeHooks) artifactAttemptQuarantinePhaseHookForTests?.("before-owner-bind", paths);
		destination = inspectIdentity(paths.ownerQuarantine, expected, "file");
		source = inspectIdentity(paths.ownerPath, expected, "file");
		if (destination.kind !== "absent" || source.kind !== "exact" || source.stat.nlink !== 1) return false;
		fs.linkSync(paths.ownerPath, paths.ownerQuarantine);
		if (invokeHooks) artifactAttemptQuarantinePhaseHookForTests?.("after-owner-bind", paths);
		destination = inspectIdentity(paths.ownerQuarantine, expected, "file");
		source = inspectIdentity(paths.ownerPath, expected, "file");
	}
	if (destination.kind !== "exact" || source.kind === "foreign") return false;
	if (source.kind === "exact") {
		if (destination.stat.nlink !== 2 || source.stat.nlink !== 2) return false;
		if (invokeHooks) artifactAttemptQuarantinePhaseHookForTests?.("before-owner-unlink", paths);
		destination = inspectIdentity(paths.ownerQuarantine, expected, "file");
		source = inspectIdentity(paths.ownerPath, expected, "file");
		if (destination.kind !== "exact" || source.kind !== "exact" || destination.stat.nlink !== 2 || source.stat.nlink !== 2) return false;
		fs.unlinkSync(paths.ownerPath);
		if (invokeHooks) artifactAttemptQuarantinePhaseHookForTests?.("after-owner-unlink", paths);
		destination = inspectIdentity(paths.ownerQuarantine, expected, "file");
	}
	return destination.kind === "exact" && destination.stat.nlink === 1;
}

function advanceAttemptMaintenanceTransition(
	recordPath: string,
	dataRoot: string,
	controlRoot: string,
	record: AttemptMaintenanceTransitionRecord,
	invokeHooks: boolean,
): QuarantinedCandidate | undefined {
	const paths = attemptTransitionPaths(dataRoot, controlRoot, record);
	const expected = { dev: record.attemptDestinationDev, ino: record.attemptDestinationIno };
	if (record.phase === "maintenance-owned") {
		const destination = inspectIdentity(paths.attemptQuarantine, expected, "directory");
		if (destination.kind === "foreign") return undefined;
		if (destination.kind === "absent") {
			const attemptSource = inspectIdentity(paths.attemptRoot, { dev: record.attemptSourceDev, ino: record.attemptSourceIno }, "directory");
			const ownerSource = inspectIdentity(paths.ownerPath, { dev: record.ownerSourceDev, ino: record.ownerSourceIno }, "file");
			if (attemptSource.kind === "absent" && ownerSource.kind === "absent") removeCompletedTransitionRecord(recordPath, record);
			return undefined;
		}
		return { path: paths.attemptQuarantine, dev: destination.stat.dev, ino: destination.stat.ino };
	}
	const moved = moveExactDirectory(
		paths.attemptRoot, paths.attemptQuarantine, expected,
		invokeHooks ? () => artifactAttemptQuarantinePhaseHookForTests?.("before-attempt-move", paths) : undefined,
		invokeHooks ? () => artifactAttemptQuarantinePhaseHookForTests?.("after-attempt-move", paths) : undefined,
	);
	if (!moved || inspectIdentity(paths.attemptRoot, expected, "directory").kind === "foreign" ||
		!attemptChildrenMatch(paths.attemptQuarantine, record) || !bindExactAttemptOwner(paths, record, invokeHooks)) return undefined;
	const maintenanceOwned: AttemptMaintenanceTransitionRecord = { ...record, phase: "maintenance-owned" };
	writeAtomicJson(recordPath, maintenanceOwned);
	return { path: paths.attemptQuarantine, dev: moved.dev, ino: moved.ino };
}

async function quarantineExpiredArtifact(args: {
	root: string;
	dataRoot: string;
	controlRoot: string;
	workspaceHash: string;
	artifactId: string;
	now: number;
	graceMs: number;
	deadline: number;
	maintenanceRecordPath: string;
	maintenanceSequence: number;
	wakeGeneration: number;
	wakeDev: number;
	wakeIno: number;
}): Promise<QuarantinedCandidate | undefined> {
	const snapshot = path.join(args.dataRoot, "artifacts", args.artifactId);
	const quarantineRoot = path.join(args.dataRoot, "quarantine");
	ensureRealOwnerDirectory(quarantineRoot);
	let captured: QuarantinedCandidate | undefined;
	let lease: WorkerArtifactWorkspaceLease;
	try { lease = await acquireMetadataLeaseAtPath(path.join(args.controlRoot, "metadata.lock"), { timeoutMs: 0 }); }
	catch (error) { if (error instanceof WorkerArtifactStorageBusyError) return undefined; throw error; }
	try {
		if (!artifactEligibilityWakeMatches(args.controlRoot, {
			artifactId: args.artifactId, worktreeHash: args.workspaceHash,
		}, {
			maintenanceSequence: args.maintenanceSequence, generation: args.wakeGeneration,
			dev: args.wakeDev, ino: args.wakeIno,
		})) return undefined;
		const before = fs.lstatSync(snapshot);
		if (!before.isDirectory() || before.isSymbolicLink()) return undefined;
		const manifest = parseManifest(readRegularJson(path.join(snapshot, "manifest.json")));
		const ref = manifest.artifactRef;
		if (ref.artifactId !== args.artifactId || ref.worktreeHash !== args.workspaceHash) return undefined;
		if (before.dev !== ref.snapshotDev || before.ino !== ref.snapshotIno) return undefined;
		artifactPathsFromRef(ref, args.root);
		const usageBudget: ArtifactUsageScanBudget = {
			deadline: args.deadline,
			remainingRecords: MAX_ARTIFACT_USAGE_RECORDS_PER_CANDIDATE,
		};
		if (Date.parse(ref.expiresAt) > args.now ||
			activeArtifactUsage(args.controlRoot, ref, args.now, args.graceMs, usageBudget)) return undefined;
		const usageRoot = artifactUsageJournalPaths(args.controlRoot, ref.artifactId).root;
		const usageBefore = fs.lstatSync(usageRoot);
		if (!usageBefore.isDirectory() || usageBefore.isSymbolicLink()) return undefined;

		const transitionId = randomUUID();
		const quarantine = path.join(quarantineRoot, `artifact-${ref.artifactId}-${transitionId}`);
		const transition: MaintenanceTransitionInput = {
			kind: "cleanup-transition", sourceKind: "artifact", transitionId, phase: "prepared", artifactId: ref.artifactId,
			snapshotSourceDev: before.dev, snapshotSourceIno: before.ino,
			snapshotDestinationDev: before.dev, snapshotDestinationIno: before.ino,
			usageSourceDev: usageBefore.dev, usageSourceIno: usageBefore.ino,
			usageDestinationDev: usageBefore.dev, usageDestinationIno: usageBefore.ino,
		};
		fs.chmodSync(snapshot, 0o700);
		try {
			await beginMaintenanceTransition({
				namespace: path.dirname(path.dirname(args.dataRoot)), workspaceHash: args.workspaceHash,
				recordPath: args.maintenanceRecordPath, sequence: args.maintenanceSequence,
				expectedKind: "publication", expectedId: ref.artifactId, transition,
				operation: (registered) => {
					const record = parseMaintenanceTransitionRecord(readBoundedUsageRecord(registered.path), registered.sequence);
					if (!record || record.sourceKind !== "artifact") throw new Error("artifact cleanup transition registration failed");
					captured = advanceArtifactMaintenanceTransition(registered.path, args.dataRoot, args.controlRoot, record, true);
					if (!captured) throw new Error("artifact cleanup transition could not capture both exact identities");
				},
			});
		} catch {
			if (inspectIdentity(quarantine, before, "directory").kind === "exact") {
				retainCapturedDirectory(snapshot, quarantine, before);
			} else if (inspectIdentity(snapshot, before, "directory").kind === "exact") {
				try { fs.chmodSync(snapshot, 0o500); } catch { /* preserve the original identity failure */ }
			}
			return undefined;
		}
	} catch { return undefined; }
	finally { await lease.release(); }
	return captured;
}

async function quarantineAbandonedAttempt(args: {
	dataRoot: string;
	controlRoot: string;
	workspaceHash: string;
	ownerName: string;
	now: number;
	graceMs: number;
	maintenanceRecordPath: string;
	maintenanceSequence: number;
}): Promise<QuarantinedCandidate | undefined> {
	if (!args.ownerName.endsWith(".json")) return undefined;
	const expectedAttemptId = args.ownerName.slice(0, -5);
	if (!UUID.test(expectedAttemptId)) return undefined;
	const ownerPath = path.join(args.controlRoot, "usage", "attempts", args.ownerName);
	const quarantineRoot = path.join(args.dataRoot, "quarantine");
	ensureRealOwnerDirectory(quarantineRoot);
	let captured: QuarantinedCandidate | undefined;
	let lease: WorkerArtifactWorkspaceLease;
	try { lease = await acquireMetadataLeaseAtPath(path.join(args.controlRoot, "metadata.lock"), { timeoutMs: 0 }); }
	catch (error) { if (error instanceof WorkerArtifactStorageBusyError) return undefined; throw error; }
	try {
		const ownerPathBefore = fs.lstatSync(ownerPath);
		const owner = parseAttemptOwner(readRegularJson(ownerPath));
		if (!owner || !ownerPathBefore.isFile() || ownerPathBefore.isSymbolicLink() || ownerPathBefore.nlink !== 1 ||
			owner.attemptId !== expectedAttemptId || owner.worktreeHash !== args.workspaceHash || path.resolve(owner.dataRoot) !== args.dataRoot) return undefined;
		if (owner.hostname !== os.hostname() || processIsAlive(owner.pid, owner.processStartTime) || args.now - owner.heartbeatAt < args.graceMs) return undefined;
		const attemptRoot = path.join(args.dataRoot, "attempts", owner.attemptId);
		const scratchRoot = path.join(attemptRoot, "scratch");
		const outputRoot = path.join(attemptRoot, "output");
		const before = fs.lstatSync(attemptRoot);
		const scratchBefore = fs.lstatSync(scratchRoot);
		const outputBefore = fs.lstatSync(outputRoot);
		if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== owner.rootDev || before.ino !== owner.rootIno ||
			!scratchBefore.isDirectory() || scratchBefore.isSymbolicLink() || scratchBefore.dev !== owner.scratchDev || scratchBefore.ino !== owner.scratchIno ||
			!outputBefore.isDirectory() || outputBefore.isSymbolicLink() || outputBefore.dev !== owner.outputDev || outputBefore.ino !== owner.outputIno) return undefined;

		const transitionId = randomUUID();
		const quarantine = path.join(quarantineRoot, `abandoned-${owner.attemptId}-${transitionId}`);
		const transition: MaintenanceTransitionInput = {
			kind: "cleanup-transition", sourceKind: "attempt", transitionId, phase: "prepared", attemptId: owner.attemptId,
			attemptSourceDev: before.dev, attemptSourceIno: before.ino,
			attemptDestinationDev: before.dev, attemptDestinationIno: before.ino,
			scratchDev: scratchBefore.dev, scratchIno: scratchBefore.ino,
			outputDev: outputBefore.dev, outputIno: outputBefore.ino,
			ownerSourceDev: ownerPathBefore.dev, ownerSourceIno: ownerPathBefore.ino,
			ownerDestinationDev: ownerPathBefore.dev, ownerDestinationIno: ownerPathBefore.ino,
		};
		try {
			await beginMaintenanceTransition({
				namespace: path.dirname(path.dirname(args.dataRoot)), workspaceHash: args.workspaceHash,
				recordPath: args.maintenanceRecordPath, sequence: args.maintenanceSequence,
				expectedKind: "attempt", expectedId: owner.attemptId, transition,
				operation: (registered) => {
					const record = parseMaintenanceTransitionRecord(readBoundedUsageRecord(registered.path), registered.sequence);
					if (!record || record.sourceKind !== "attempt") throw new Error("attempt cleanup transition registration failed");
					captured = advanceAttemptMaintenanceTransition(registered.path, args.dataRoot, args.controlRoot, record, true);
					if (!captured) throw new Error("attempt cleanup transition could not capture both exact identities");
				},
			});
		} catch {
			if (inspectIdentity(quarantine, before, "directory").kind === "exact") {
				retainCapturedDirectory(attemptRoot, quarantine, before);
			}
			return undefined;
		}
	} catch { return undefined; }
	finally { await lease.release(); }
	return captured;
}

async function quarantineOrphanedData(args: {
kind: "orphan-attempt" | "staging" | "quarantine";
dataRoot: string;
controlRoot: string;
entryName: string;
expectedDev?: number;
expectedIno?: number;
now: number;
graceMs: number;
}): Promise<QuarantinedCandidate | undefined> {
	const isOrphanAttempt = args.kind === "orphan-attempt";
	if (isOrphanAttempt && !UUID.test(args.entryName)) return undefined;
	if (args.kind === "staging" && (!args.entryName.startsWith(".publish-") || !UUID.test(args.entryName.slice(".publish-".length)))) return undefined;
	if (path.basename(args.entryName) !== args.entryName || args.entryName === "." || args.entryName === "..") return undefined;
	const quarantineRoot = path.join(args.dataRoot, "quarantine");
	ensureRealOwnerDirectory(quarantineRoot);
	const source = args.kind === "orphan-attempt"
		? path.join(args.dataRoot, "attempts", args.entryName)
		: args.kind === "staging"
			? path.join(args.dataRoot, args.entryName)
			: path.join(quarantineRoot, args.entryName);
	let lease: WorkerArtifactWorkspaceLease;
	try { lease = await acquireMetadataLeaseAtPath(path.join(args.controlRoot, "metadata.lock"), { timeoutMs: 0 }); }
	catch (error) { if (error instanceof WorkerArtifactStorageBusyError) return undefined; throw error; }
	try {
		if (isOrphanAttempt) {
			const ownerPath = path.join(args.controlRoot, "usage", "attempts", `${args.entryName}.json`);
			try { fs.lstatSync(ownerPath); return undefined; }
			catch (error) { if (errorCode(error) !== "ENOENT") return undefined; }
		}
		const before = fs.lstatSync(source);
		if (!before.isDirectory() || before.isSymbolicLink() || args.now - before.mtimeMs < args.graceMs) return undefined;
		if (args.kind === "quarantine") {
			if (before.dev !== args.expectedDev || before.ino !== args.expectedIno) return undefined;
			return { path: source, dev: before.dev, ino: before.ino };
		}
		const quarantine = path.join(quarantineRoot, `${args.kind}-${randomUUID()}`);
		await registerMaintenanceRecords(path.dirname(path.dirname(args.dataRoot)), path.basename(args.dataRoot), [{
			kind: "quarantine", entryName: path.basename(quarantine), dev: before.dev, ino: before.ino,
		}], undefined, () => { fs.renameSync(source, quarantine); });
		const moved = fs.lstatSync(quarantine);
		if (!sameIdentity(before, moved) || !moved.isDirectory() || moved.isSymbolicLink()) {
			// Preserve the unique captured name; a path-based rollback could overwrite
			// a replacement installed at the source.
			return undefined;
		}
		return { path: quarantine, dev: moved.dev, ino: moved.ino };
	} catch {
		return undefined;
	} finally {
		await lease.release();
	}
}

type MaintenanceCandidate = (
	| { key: string; kind: "artifact"; workspaceHash: string; dataRoot: string; controlRoot: string; artifactId: string }
	| { key: string; kind: "attempt"; workspaceHash: string; dataRoot: string; controlRoot: string; ownerName: string }
	| { key: string; kind: "orphan-attempt" | "staging"; workspaceHash: string; dataRoot: string; controlRoot: string; entryName: string }
	| { key: string; kind: "quarantine"; workspaceHash: string; dataRoot: string; controlRoot: string; entryName: string; expectedDev: number; expectedIno: number }
	| { key: string; kind: "transition"; workspaceHash: string; dataRoot: string; controlRoot: string; transition: MaintenanceTransitionRecord }
) & {
	queueOffset?: number;
	scanOffset?: number;
	queueRecordPath?: string;
	wakeGeneration?: number;
	wakeDev?: number;
	wakeIno?: number;
	cursorGeneration?: number;
};

const INVALID_ARTIFACT_ELIGIBILITY_WAKE = Symbol("invalid artifact eligibility wake");
type QueuedMaintenanceCandidate = MaintenanceCandidate | typeof INVALID_ARTIFACT_ELIGIBILITY_WAKE;

type MaintenanceRecordInput =
	| { kind: "artifact"; entryName: string }
	| { kind: "attempt"; entryName: string }
	| { kind: "quarantine"; entryName: string; dev: number; ino: number };

interface RegisteredMaintenanceRecord {
	path: string;
	sequence: number;
}

function maintenanceTransitionJson(
	workspaceHash: string,
	sequence: number,
	record: MaintenanceTransitionInput,
): MaintenanceTransitionRecord {
	const common: MaintenanceTransitionBase = {
		schema: STORAGE_SCHEMA, version: 2, kind: "cleanup-transition", sequence, workspaceHash,
		transitionId: record.transitionId, phase: record.phase,
	};
	return record.sourceKind === "artifact" ? {
		...common, sourceKind: "artifact", artifactId: record.artifactId,
		snapshotSourceDev: record.snapshotSourceDev, snapshotSourceIno: record.snapshotSourceIno,
		snapshotDestinationDev: record.snapshotDestinationDev, snapshotDestinationIno: record.snapshotDestinationIno,
		usageSourceDev: record.usageSourceDev, usageSourceIno: record.usageSourceIno,
		usageDestinationDev: record.usageDestinationDev, usageDestinationIno: record.usageDestinationIno,
	} : {
		...common, sourceKind: "attempt", attemptId: record.attemptId,
		attemptSourceDev: record.attemptSourceDev, attemptSourceIno: record.attemptSourceIno,
		attemptDestinationDev: record.attemptDestinationDev, attemptDestinationIno: record.attemptDestinationIno,
		scratchDev: record.scratchDev, scratchIno: record.scratchIno,
		outputDev: record.outputDev, outputIno: record.outputIno,
		ownerSourceDev: record.ownerSourceDev, ownerSourceIno: record.ownerSourceIno,
		ownerDestinationDev: record.ownerDestinationDev, ownerDestinationIno: record.ownerDestinationIno,
	};
}

async function beginMaintenanceTransition(args: {
	namespace: string;
	workspaceHash: string;
	recordPath: string;
	sequence: number;
	expectedKind: "publication" | "attempt";
	expectedId: string;
	transition: MaintenanceTransitionInput;
	operation: (registered: RegisteredMaintenanceRecord) => void;
}): Promise<void> {
	const expectedRecordPath = path.join(args.namespace, "maintenance-queue", `${args.sequence}.json`);
	if (path.resolve(args.recordPath) !== expectedRecordPath || !Number.isSafeInteger(args.sequence) || args.sequence < 1) {
		throw new Error("artifact cleanup transition has an invalid ledger position");
	}
	const lease = await acquireMetadataLeaseAtPath(path.join(args.namespace, "maintenance.lock"));
	try {
		const current = readBoundedUsageRecord(expectedRecordPath) as Record<string, unknown>;
		const currentId = args.expectedKind === "publication" ? current.artifactId : current.attemptId;
		if (current.schema !== STORAGE_SCHEMA || current.version !== 2 || current.kind !== args.expectedKind ||
			current.sequence !== args.sequence || current.workspaceHash !== args.workspaceHash || currentId !== args.expectedId ||
			(args.transition.sourceKind === "artifact" ? args.transition.artifactId : args.transition.attemptId) !== args.expectedId) {
			throw new Error("artifact cleanup transition cannot replace a foreign ledger record");
		}
		writeAtomicJson(expectedRecordPath, maintenanceTransitionJson(args.workspaceHash, args.sequence, args.transition));
		if (args.transition.sourceKind === "artifact") {
			scheduleArtifactEligibilityWakeUnderMaintenanceLock(
				path.join(args.namespace, "control", args.workspaceHash),
				{ artifactId: args.transition.artifactId, worktreeHash: args.workspaceHash },
			);
		}
		args.operation({ path: expectedRecordPath, sequence: args.sequence });
	} finally { await lease.release(); }
}

async function registerMaintenanceRecords(
	namespace: string,
	workspaceHash: string,
	records: MaintenanceRecordInput[],
	signal?: AbortSignal,
	operation?: (written: RegisteredMaintenanceRecord[]) => void,
): Promise<void> {
	ensureRealOwnerDirectory(namespace);
	const lease = await acquireMetadataLeaseAtPath(path.join(namespace, "maintenance.lock"), { signal });
	try {
		const queueRoot = path.join(namespace, "maintenance-queue");
		ensureRealOwnerDirectory(queueRoot);
		const counterPath = path.join(namespace, "maintenance-queue-counter.json");
		let sequence = 0;
		try {
			const counter = readBoundedUsageRecord(counterPath) as Record<string, unknown>;
			if (counter.schema !== STORAGE_SCHEMA || counter.version !== 2 || counter.kind !== "maintenance-queue-counter" ||
				typeof counter.sequence !== "number" || !Number.isSafeInteger(counter.sequence) || counter.sequence < 0) {
				throw new Error("artifact maintenance queue counter is invalid");
			}
			sequence = counter.sequence;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const written: RegisteredMaintenanceRecord[] = [];
		for (const record of records) {
			sequence += 1;
			if (!Number.isSafeInteger(sequence)) throw new Error("artifact maintenance queue sequence is exhausted");
			writeAtomicJson(counterPath, { schema: STORAGE_SCHEMA, version: 2, kind: "maintenance-queue-counter", sequence });
			const recordPath = path.join(queueRoot, `${sequence}.json`);
			if (record.kind === "attempt") {
				writeAtomicJson(recordPath, { schema: STORAGE_SCHEMA, version: 2, kind: "attempt", sequence, workspaceHash, attemptId: record.entryName });
			} else if (record.kind === "artifact") {
				writeAtomicJson(recordPath, { schema: STORAGE_SCHEMA, version: 2, kind: "publication", sequence, workspaceHash, artifactId: record.entryName });
			} else {
				writeAtomicJson(recordPath, { schema: STORAGE_SCHEMA, version: 2, kind: "quarantine", sequence, workspaceHash, entryName: record.entryName, dev: record.dev, ino: record.ino });
			}
			written.push({ path: recordPath, sequence });
		}
		// Registration and the first transition step share the short maintenance
		// transaction, so a scanner cannot retire a new record before its source move.
		operation?.(written);
	} finally { await lease.release(); }
}

async function registerMaintenanceQueueRecords(
	workspace: WorkerArtifactWorkspace,
	records: MaintenanceRecordInput[],
	signal?: AbortSignal,
	operation?: (written: RegisteredMaintenanceRecord[]) => void,
): Promise<void> {
	await registerMaintenanceRecords(workspace.namespaceRoot, workspace.worktreeHash, records, signal, operation);
}


interface MaintenanceCursorState {
	key: string;
	scanKey: string;
	scanOffset: number;
	queueOffset: number;
	source: "queue" | "scan";
	generation: number;
}

function readMaintenanceCursor(cursorPath: string): MaintenanceCursorState {
	try {
		const value = readBoundedUsageRecord(cursorPath) as Record<string, unknown>;
		if (value.schema === STORAGE_SCHEMA && value.version === 2 && value.kind === "maintenance-cursor" && typeof value.key === "string") {
			return {
				key: value.key,
				scanKey: typeof value.scanKey === "string" ? value.scanKey : value.key,
				scanOffset: typeof value.scanOffset === "number" && Number.isSafeInteger(value.scanOffset) && value.scanOffset >= 0 ? value.scanOffset : 0,
				queueOffset: typeof value.queueOffset === "number" && Number.isSafeInteger(value.queueOffset) && value.queueOffset >= 0 ? value.queueOffset : 0,
				source: value.source === "scan" ? "scan" : "queue",
				generation: typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
			};
		}
	} catch { /* absent or malformed cursor restarts a safe deterministic pass */ }
	return { key: "", scanKey: "", scanOffset: 0, queueOffset: 0, source: "queue", generation: 0 };
}

function writeMaintenanceCursor(cursorPath: string, state: MaintenanceCursorState): void {
	if (state.generation >= Number.MAX_SAFE_INTEGER) throw new Error("artifact maintenance cursor generation is exhausted");
	state.generation += 1;
	writeAtomicJson(cursorPath, { schema: STORAGE_SCHEMA, version: 2, kind: "maintenance-cursor", ...state });
}

function maintenanceNamespaceFromControlRoot(controlRoot: string): string {
	return path.dirname(path.dirname(controlRoot));
}

function parseMaintenanceTransitionRecord(raw: unknown, expectedSequence: number): MaintenanceTransitionRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.schema !== STORAGE_SCHEMA || value.version !== 2 || value.kind !== "cleanup-transition" ||
		value.sequence !== expectedSequence || typeof value.workspaceHash !== "string" || !WORKSPACE_HASH.test(value.workspaceHash) ||
		typeof value.transitionId !== "string" || !UUID.test(value.transitionId) ||
		(value.phase !== "prepared" && value.phase !== "maintenance-owned")) return undefined;
	if (value.sourceKind === "artifact") {
		if (typeof value.artifactId !== "string" || !UUID.test(value.artifactId) ||
			!isFileIdentityPart(value.snapshotSourceDev) || !isFileIdentityPart(value.snapshotSourceIno) ||
			!isFileIdentityPart(value.snapshotDestinationDev) || !isFileIdentityPart(value.snapshotDestinationIno) ||
			!isFileIdentityPart(value.usageSourceDev) || !isFileIdentityPart(value.usageSourceIno) ||
			!isFileIdentityPart(value.usageDestinationDev) || !isFileIdentityPart(value.usageDestinationIno) ||
			value.snapshotSourceDev !== value.snapshotDestinationDev || value.snapshotSourceIno !== value.snapshotDestinationIno ||
			value.usageSourceDev !== value.usageDestinationDev || value.usageSourceIno !== value.usageDestinationIno) return undefined;
		return {
			schema: STORAGE_SCHEMA, version: 2, kind: "cleanup-transition", sequence: expectedSequence,
			workspaceHash: value.workspaceHash, transitionId: value.transitionId, phase: value.phase,
			sourceKind: "artifact", artifactId: value.artifactId,
			snapshotSourceDev: value.snapshotSourceDev, snapshotSourceIno: value.snapshotSourceIno,
			snapshotDestinationDev: value.snapshotDestinationDev, snapshotDestinationIno: value.snapshotDestinationIno,
			usageSourceDev: value.usageSourceDev, usageSourceIno: value.usageSourceIno,
			usageDestinationDev: value.usageDestinationDev, usageDestinationIno: value.usageDestinationIno,
		};
	}
	if (value.sourceKind !== "attempt" || typeof value.attemptId !== "string" || !UUID.test(value.attemptId) ||
		!isFileIdentityPart(value.attemptSourceDev) || !isFileIdentityPart(value.attemptSourceIno) ||
		!isFileIdentityPart(value.attemptDestinationDev) || !isFileIdentityPart(value.attemptDestinationIno) ||
		!isFileIdentityPart(value.scratchDev) || !isFileIdentityPart(value.scratchIno) ||
		!isFileIdentityPart(value.outputDev) || !isFileIdentityPart(value.outputIno) ||
		!isFileIdentityPart(value.ownerSourceDev) || !isFileIdentityPart(value.ownerSourceIno) ||
		!isFileIdentityPart(value.ownerDestinationDev) || !isFileIdentityPart(value.ownerDestinationIno) ||
		value.attemptSourceDev !== value.attemptDestinationDev || value.attemptSourceIno !== value.attemptDestinationIno ||
		value.ownerSourceDev !== value.ownerDestinationDev || value.ownerSourceIno !== value.ownerDestinationIno) return undefined;
	return {
		schema: STORAGE_SCHEMA, version: 2, kind: "cleanup-transition", sequence: expectedSequence,
		workspaceHash: value.workspaceHash, transitionId: value.transitionId, phase: value.phase,
		sourceKind: "attempt", attemptId: value.attemptId,
		attemptSourceDev: value.attemptSourceDev, attemptSourceIno: value.attemptSourceIno,
		attemptDestinationDev: value.attemptDestinationDev, attemptDestinationIno: value.attemptDestinationIno,
		scratchDev: value.scratchDev, scratchIno: value.scratchIno,
		outputDev: value.outputDev, outputIno: value.outputIno,
		ownerSourceDev: value.ownerSourceDev, ownerSourceIno: value.ownerSourceIno,
		ownerDestinationDev: value.ownerDestinationDev, ownerDestinationIno: value.ownerDestinationIno,
	};
}

function artifactTransitionCanResumeFromSources(args: {
	root: string;
	dataRoot: string;
	controlRoot: string;
	record: ArtifactMaintenanceTransitionRecord;
	now: number;
	graceMs: number;
	deadline: number;
}): boolean {
	const paths = artifactTransitionPaths(args.dataRoot, args.controlRoot, args.record);
	const snapshot = inspectIdentity(paths.snapshot, { dev: args.record.snapshotSourceDev, ino: args.record.snapshotSourceIno }, "directory");
	const usage = inspectIdentity(paths.usageRoot, { dev: args.record.usageSourceDev, ino: args.record.usageSourceIno }, "directory");
	if (snapshot.kind !== "exact" || usage.kind !== "exact") return true;
	try {
		const manifest = parseManifest(readRegularJson(path.join(paths.snapshot, "manifest.json")));
		const ref = manifest.artifactRef;
		if (ref.artifactId !== args.record.artifactId || ref.worktreeHash !== args.record.workspaceHash) return false;
		artifactPathsFromRef(ref, args.root);
		const budget: ArtifactUsageScanBudget = {
			deadline: args.deadline,
			remainingRecords: MAX_ARTIFACT_USAGE_RECORDS_PER_CANDIDATE,
		};
		return Date.parse(ref.expiresAt) <= args.now && !activeArtifactUsage(args.controlRoot, ref, args.now, args.graceMs, budget, true);
	} catch { return false; }
}

async function completeMaintenanceTransition(
	candidate: Extract<MaintenanceCandidate, { kind: "transition" }>,
	options: { root: string; now: number; graceMs: number; deadline: number },
): Promise<QuarantinedCandidate | undefined> {
	if (!candidate.queueRecordPath) return undefined;
	let metadataLease: WorkerArtifactWorkspaceLease | undefined;
	let maintenanceLease: WorkerArtifactWorkspaceLease | undefined;
	try {
		metadataLease = await acquireMetadataLeaseAtPath(path.join(candidate.controlRoot, "metadata.lock"), { timeoutMs: 0 });
		maintenanceLease = await acquireMetadataLeaseAtPath(path.join(path.dirname(path.dirname(candidate.dataRoot)), "maintenance.lock"), { timeoutMs: 0 });
		const record = parseMaintenanceTransitionRecord(readBoundedUsageRecord(candidate.queueRecordPath), candidate.transition.sequence);
		if (!record || record.workspaceHash !== candidate.workspaceHash ||
			JSON.stringify(record) !== JSON.stringify(candidate.transition)) return undefined;
		if (record.sourceKind === "artifact") {
			if (record.phase === "prepared" && !artifactTransitionCanResumeFromSources({
				root: options.root, dataRoot: candidate.dataRoot, controlRoot: candidate.controlRoot, record,
				now: options.now, graceMs: options.graceMs, deadline: options.deadline,
			})) return undefined;
			return advanceArtifactMaintenanceTransition(candidate.queueRecordPath, candidate.dataRoot, candidate.controlRoot, record, false);
		}
		return advanceAttemptMaintenanceTransition(candidate.queueRecordPath, candidate.dataRoot, candidate.controlRoot, record, false);
	} catch (error) {
		if (error instanceof WorkerArtifactStorageBusyError || errorCode(error) === "ENOENT") return undefined;
		return undefined;
	} finally {
		if (maintenanceLease) await maintenanceLease.release();
		if (metadataLease) await metadataLease.release();
	}
}


function maintenanceRecordHasPendingDelete(raw: unknown, dataBase: string): boolean {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const value = raw as Record<string, unknown>;
	// A malformed or identity-conflicted transition is evidence, not disposable
	// queue noise. Only its validated transition completer may remove it.
	if (value.kind === "cleanup-transition") return true;
	if (value.kind !== "quarantine" || typeof value.workspaceHash !== "string" || !WORKSPACE_HASH.test(value.workspaceHash) ||
		typeof value.entryName !== "string" || path.basename(value.entryName) !== value.entryName) return false;
	return pendingQuarantineDeletes.has(path.join(dataBase, value.workspaceHash, "quarantine", value.entryName));
}

function queuedMaintenanceCandidate(
	raw: unknown,
	dataBase: string,
	controlBase: string,
	recordOffset: number,
	queueRecordPath: string,
	source: "queue" | "scan",
): QueuedMaintenanceCandidate | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.schema !== STORAGE_SCHEMA || value.version !== 2 || value.sequence !== recordOffset ||
		typeof value.workspaceHash !== "string" || !WORKSPACE_HASH.test(value.workspaceHash)) return undefined;
	const workspaceHash = value.workspaceHash;
	const dataRoot = path.join(dataBase, workspaceHash);
	const controlRoot = path.join(controlBase, workspaceHash);
	const position = source === "queue" ? { queueOffset: recordOffset } : { scanOffset: recordOffset };
	const wakePosition = (artifactId: string): {
		wakeGeneration: number;
		wakeDev: number;
		wakeIno: number;
	} | typeof INVALID_ARTIFACT_ELIGIBILITY_WAKE => {
		try {
			const snapshot = readArtifactEligibilityWakeSnapshot(controlRoot, { artifactId, worktreeHash: workspaceHash });
			if (!snapshot || snapshot.wake.maintenanceSequence !== recordOffset) return INVALID_ARTIFACT_ELIGIBILITY_WAKE;
			return { wakeGeneration: snapshot.wake.generation, wakeDev: snapshot.dev, wakeIno: snapshot.ino };
		} catch {
			return INVALID_ARTIFACT_ELIGIBILITY_WAKE;
		}
	};
	const transition = parseMaintenanceTransitionRecord(value, recordOffset);
	if (transition) {
		let wake: ReturnType<typeof wakePosition> | undefined;
		if (transition.sourceKind === "artifact") {
			const artifactUsageRoot = artifactUsageJournalPaths(controlRoot, transition.artifactId).root;
			const usage = inspectIdentity(artifactUsageRoot, {
				dev: transition.usageSourceDev, ino: transition.usageSourceIno,
			}, "directory");
			if (usage.kind === "foreign") return INVALID_ARTIFACT_ELIGIBILITY_WAKE;
			if (usage.kind === "exact") wake = wakePosition(transition.artifactId);
		}
		if (wake === INVALID_ARTIFACT_ELIGIBILITY_WAKE) return wake;
		return {
			key: `${workspaceHash}/transition/${recordOffset}`, kind: "transition", workspaceHash, dataRoot, controlRoot,
			transition, ...position, queueRecordPath, ...(wake ?? {}),
		};
	}
	if (value.kind === "attempt" && typeof value.attemptId === "string" && UUID.test(value.attemptId)) {
		const ownerName = `${value.attemptId}.json`;
		if (fs.existsSync(path.join(controlRoot, "usage", "attempts", ownerName))) {
			return { key: `${workspaceHash}/attempt/${ownerName}`, kind: "attempt", workspaceHash, dataRoot, controlRoot, ownerName, ...position, queueRecordPath };
		}
		if (fs.existsSync(path.join(dataRoot, "attempts", value.attemptId))) {
			return { key: `${workspaceHash}/orphan-attempt/${value.attemptId}`, kind: "orphan-attempt", workspaceHash, dataRoot, controlRoot, entryName: value.attemptId, ...position, queueRecordPath };
		}
		return undefined;
	}
	if (value.kind === "quarantine" && typeof value.entryName === "string" && path.basename(value.entryName) === value.entryName &&
		isFileIdentityPart(value.dev) && isFileIdentityPart(value.ino)) {
		const candidatePath = path.join(dataRoot, "quarantine", value.entryName);
		if (pendingQuarantineDeletes.has(candidatePath)) return undefined;
		try {
			const current = fs.lstatSync(candidatePath);
			if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== value.dev || current.ino !== value.ino) return undefined;
		} catch { return undefined; }
		return {
			key: `${workspaceHash}/quarantine/${value.entryName}`, kind: "quarantine", workspaceHash, dataRoot, controlRoot,
			entryName: value.entryName, expectedDev: value.dev, expectedIno: value.ino, ...position, queueRecordPath,
		};
	}
	if (value.kind !== "publication" || typeof value.artifactId !== "string" || !UUID.test(value.artifactId)) return undefined;
	const artifactId = value.artifactId;
	if (fs.existsSync(path.join(dataRoot, "artifacts", artifactId))) {
		const wake = wakePosition(artifactId);
		if (wake === INVALID_ARTIFACT_ELIGIBILITY_WAKE) return wake;
		return {
			key: `${workspaceHash}/artifact/${artifactId}`, kind: "artifact", workspaceHash, dataRoot, controlRoot,
			artifactId, ...position, queueRecordPath, ...wake,
		};
	}
	const entryName = `.publish-${artifactId}`;
	if (fs.existsSync(path.join(dataRoot, entryName))) {
		return { key: `${workspaceHash}/staging/${entryName}`, kind: "staging", workspaceHash, dataRoot, controlRoot, entryName, ...position, queueRecordPath };
	}
	return undefined;
}

function reserveQueuedMaintenanceCandidates(
	namespace: string,
	dataBase: string,
	controlBase: string,
	state: MaintenanceCursorState,
	maximum: number,
	deadline: number,
): MaintenanceCandidate[] {
	const cursorPath = path.join(namespace, "maintenance-cursor.json");
	const counterPath = path.join(namespace, "maintenance-queue-counter.json");
	let counter: Record<string, unknown>;
	try { counter = readBoundedUsageRecord(counterPath) as Record<string, unknown>; }
	catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	if (counter.schema !== STORAGE_SCHEMA || counter.version !== 2 || counter.kind !== "maintenance-queue-counter" ||
		typeof counter.sequence !== "number" || !Number.isSafeInteger(counter.sequence) || counter.sequence < 0) return [];
	const maximumSequence = counter.sequence;
	const selected: MaintenanceCandidate[] = [];
	let sequence = state.queueOffset <= maximumSequence ? state.queueOffset : 0;
	let examined = 0;
	while (selected.length < maximum && examined < MAX_ARTIFACT_USAGE_RECORDS_PER_CANDIDATE && maintenanceClock() < deadline) {
		if (sequence >= maximumSequence) {
			state.queueOffset = 0;
			state.source = "scan";
			writeMaintenanceCursor(cursorPath, state);
			break;
		}
		sequence += 1;
		examined += 1;
		const recordPath = path.join(namespace, "maintenance-queue", `${sequence}.json`);
		afterMaintenancePhysicalEntryForTests?.(path.dirname(recordPath), path.basename(recordPath));
		let raw: unknown;
		try { raw = readBoundedUsageRecord(recordPath); }
		catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			state.queueOffset = sequence;
			continue;
		}
		const candidate = queuedMaintenanceCandidate(raw, dataBase, controlBase, sequence, recordPath, "queue");
		if (candidate && candidate !== INVALID_ARTIFACT_ELIGIBILITY_WAKE) selected.push(candidate);
		else {
			if (candidate !== INVALID_ARTIFACT_ELIGIBILITY_WAKE && !maintenanceRecordHasPendingDelete(raw, dataBase)) {
				fs.rmSync(recordPath, { force: true });
			}
			state.queueOffset = sequence;
		}
	}
	if (selected.length === 0) writeMaintenanceCursor(cursorPath, state);
	return selected;
}

const MAX_MAINTENANCE_LEDGER_RECORDS_PER_TURN = 64;

function reserveScannedMaintenanceCandidates(
	namespace: string,
	dataBase: string,
	controlBase: string,
	state: MaintenanceCursorState,
	maximum: number,
	deadline: number,
): MaintenanceCandidate[] {
	const cursorPath = path.join(namespace, "maintenance-cursor.json");
	const counterPath = path.join(namespace, "maintenance-queue-counter.json");
	let counter: Record<string, unknown>;
	try { counter = readBoundedUsageRecord(counterPath) as Record<string, unknown>; }
	catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	if (counter.schema !== STORAGE_SCHEMA || counter.version !== 2 || counter.kind !== "maintenance-queue-counter" ||
		typeof counter.sequence !== "number" || !Number.isSafeInteger(counter.sequence) || counter.sequence < 0) return [];
	const maximumSequence = counter.sequence;
	let sequence = state.scanOffset <= maximumSequence ? state.scanOffset : 0;
	const initialSequence = sequence;
	let wrapped = false;
	let examined = 0;
	const selected: MaintenanceCandidate[] = [];
	while (selected.length < maximum && examined < MAX_MAINTENANCE_LEDGER_RECORDS_PER_TURN && maintenanceClock() < deadline) {
		if (wrapped && sequence >= initialSequence) break;
		if (sequence >= maximumSequence) {
			state.scanOffset = 0;
			state.scanKey = "";
			if (initialSequence > 0 && !wrapped) {
				sequence = 0;
				wrapped = true;
				continue;
			}
			break;
		}
		sequence += 1;
		examined += 1;
		const recordPath = path.join(namespace, "maintenance-queue", `${sequence}.json`);
		afterMaintenancePhysicalEntryForTests?.(path.dirname(recordPath), path.basename(recordPath));
		let raw: unknown;
		try { raw = readBoundedUsageRecord(recordPath); }
		catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			state.scanOffset = sequence;
			continue;
		}
		const candidate = queuedMaintenanceCandidate(raw, dataBase, controlBase, sequence, recordPath, "scan");
		state.scanKey = candidate && candidate !== INVALID_ARTIFACT_ELIGIBILITY_WAKE ? candidate.key : `record/${sequence}`;
		if (candidate && candidate !== INVALID_ARTIFACT_ELIGIBILITY_WAKE) selected.push(candidate);
		else {
			if (candidate !== INVALID_ARTIFACT_ELIGIBILITY_WAKE && !maintenanceRecordHasPendingDelete(raw, dataBase)) {
				fs.rmSync(recordPath, { force: true });
			}
			state.scanOffset = sequence;
		}
	}
	state.source = "queue";
	writeMaintenanceCursor(cursorPath, state);
	return selected;
}

async function reserveMaintenanceCandidates(
	namespace: string,
	dataBase: string,
	controlBase: string,
	maximum: number,
	deadline: number,
): Promise<MaintenanceCandidate[]> {
	if (maximum <= 0 || maintenanceClock() >= deadline) return [];
	ensureRealOwnerDirectory(namespace);
	const cursorPath = path.join(namespace, "maintenance-cursor.json");
	const lease = await acquireMetadataLeaseAtPath(path.join(namespace, "maintenance.lock"), { timeoutMs: 0 });
	try {
		const state = readMaintenanceCursor(cursorPath);
		if (state.source === "queue") {
			// Priority and exhaustive service have independent durable offsets over the
			// same append-only numeric ledger. No directory snapshot or filesystem
			// directory cookie is needed, so restart cannot lose physical scan progress.
			const queueShare = Math.max(1, Math.ceil(maximum / 2));
			const queued = reserveQueuedMaintenanceCandidates(namespace, dataBase, controlBase, state, queueShare, deadline);
			if (queued.length > 0) return queued.map((candidate) => ({ ...candidate, cursorGeneration: state.generation }));
			state.source = "scan";
			writeMaintenanceCursor(cursorPath, state);
		}
		const scanned = reserveScannedMaintenanceCandidates(namespace, dataBase, controlBase, state, maximum, deadline);
		return scanned.map((candidate) => ({ ...candidate, cursorGeneration: state.generation }));
	} finally { await lease.release(); }
}

async function advanceMaintenanceCursor(
	namespace: string,
	candidate: MaintenanceCandidate,
	expectedCursorGeneration: number,
): Promise<number | undefined> {
	let lease: WorkerArtifactWorkspaceLease;
	try { lease = await acquireMetadataLeaseAtPath(path.join(namespace, "maintenance.lock"), { timeoutMs: 0 }); }
	catch (error) { if (error instanceof WorkerArtifactStorageBusyError) return undefined; throw error; }
	try {
		const artifactId = candidate.kind === "artifact"
			? candidate.artifactId
			: candidate.kind === "transition" && candidate.transition.sourceKind === "artifact"
				? candidate.transition.artifactId
				: undefined;
		if (artifactId && candidate.wakeGeneration !== undefined && candidate.wakeDev !== undefined && candidate.wakeIno !== undefined) {
			if (!artifactEligibilityWakeMatches(candidate.controlRoot, {
				artifactId, worktreeHash: candidate.workspaceHash,
			}, {
				maintenanceSequence: candidate.queueOffset ?? candidate.scanOffset ?? 0,
				generation: candidate.wakeGeneration, dev: candidate.wakeDev, ino: candidate.wakeIno,
			})) return;
		}
		const cursorPath = path.join(namespace, "maintenance-cursor.json");
		const state = readMaintenanceCursor(cursorPath);
		if (state.generation !== expectedCursorGeneration) return undefined;
		if (candidate.queueOffset !== undefined) {
			state.queueOffset = candidate.queueOffset;
			state.source = "scan";
		} else {
			if (candidate.scanOffset !== undefined) state.scanOffset = candidate.scanOffset;
			state.key = candidate.key;
			state.source = "queue";
		}
		writeMaintenanceCursor(cursorPath, state);
		return state.generation;
	} finally { await lease.release(); }
}

export async function sweepWorkerArtifactStorage(options: WorkerArtifactStorageSweepOptions = {}): Promise<number> {
	const root = canonicalStorageRoot(options.root ?? DEFAULT_ROOT);
	const namespace = path.join(root, WORKSPACE_DIRECTORY);
	const dataBase = path.join(namespace, "data");
	const controlBase = path.join(namespace, "control");
	const now = options.now ?? Date.now();
	const maxCandidates = options.maxCandidates ?? 1_000;
	const timeBudgetMs = options.timeBudgetMs ?? 100;
	if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 0) {
		throw new TypeError("artifact maintenance maxCandidates must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 0) {
		throw new TypeError("artifact maintenance timeBudgetMs must be a non-negative safe integer");
	}
	const deadline = maintenanceClock() + timeBudgetMs;
	let selected: MaintenanceCandidate[];
	try { selected = await reserveMaintenanceCandidates(namespace, dataBase, controlBase, maxCandidates, deadline); }
	catch (error) { if (error instanceof WorkerArtifactStorageBusyError) return 0; throw error; }
	let removed = 0;
	let attempted = 0;
	let expectedCursorGeneration = selected[0]?.cursorGeneration ?? 0;
	let cursorAdvanceBlocked = false;
	for (const candidate of selected) {
		// Always make one bounded attempt for forward progress; after that, honor the
		// scan deadline before beginning another filesystem unit. A scan reservation
		// advances only its durable lexical position and revisits skipped work on wrap.
		if (attempted > 0 && maintenanceClock() >= deadline) break;
		beforeMaintenanceCandidateForTests?.(candidate.key);
		attempted += 1;
		let captured: QuarantinedCandidate | undefined;
		const maintenanceSequence = candidate.queueOffset ?? candidate.scanOffset;
		if (candidate.kind === "artifact") {
			if (candidate.queueRecordPath && maintenanceSequence !== undefined && candidate.wakeGeneration !== undefined &&
				candidate.wakeDev !== undefined && candidate.wakeIno !== undefined) captured = await quarantineExpiredArtifact({
				root, dataRoot: candidate.dataRoot, controlRoot: candidate.controlRoot,
				workspaceHash: candidate.workspaceHash, artifactId: candidate.artifactId, now,
				graceMs: options.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS, deadline,
				maintenanceRecordPath: candidate.queueRecordPath, maintenanceSequence,
				wakeGeneration: candidate.wakeGeneration, wakeDev: candidate.wakeDev, wakeIno: candidate.wakeIno,
			});
		} else if (candidate.kind === "attempt") {
			if (candidate.queueRecordPath && maintenanceSequence !== undefined) captured = await quarantineAbandonedAttempt({
				dataRoot: candidate.dataRoot, controlRoot: candidate.controlRoot,
				workspaceHash: candidate.workspaceHash, ownerName: candidate.ownerName, now,
				graceMs: options.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS,
				maintenanceRecordPath: candidate.queueRecordPath, maintenanceSequence,
			});
		} else if (candidate.kind === "transition") {
			captured = await completeMaintenanceTransition(candidate, {
				root, now, graceMs: options.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS, deadline,
			});
		} else {
			captured = await quarantineOrphanedData({
				kind: candidate.kind, dataRoot: candidate.dataRoot, controlRoot: candidate.controlRoot,
				entryName: candidate.entryName,
				...(candidate.kind === "quarantine" ? { expectedDev: candidate.expectedDev, expectedIno: candidate.expectedIno } : {}),
				now, graceMs: options.abandonedGraceMs ?? DEFAULT_ABANDONED_GRACE_MS,
			});
		}
		if (captured) {
			if (deleteCapturedQuarantine(captured)) removed += 1;
			for (const related of captured.related ?? []) deleteCapturedQuarantine(related);
		}
		if (!cursorAdvanceBlocked) {
			const advancedGeneration = await advanceMaintenanceCursor(namespace, candidate, expectedCursorGeneration);
			if (advancedGeneration === undefined) cursorAdvanceBlocked = true;
			else expectedCursorGeneration = advancedGeneration;
		}
		afterMaintenanceCandidateForTests?.(candidate.key);
	}
	return removed;
}

export function __resetWorkerArtifactWorkspaceRegistryForTests(): void {
	// Maintenance scan progress is durable; there is no process-local iterator to reset.
}

export const WORKER_ARTIFACT_WORKSPACE_DEFAULTS = {
	heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
	lockStaleAfterMs: DEFAULT_LOCK_STALE_AFTER_MS,
	lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
	retentionMs: DEFAULT_RETENTION_MS,
	abandonedGraceMs: DEFAULT_ABANDONED_GRACE_MS,
	legacyDirectory: LEGACY_WORKSPACE_DIRECTORY,
} as const;
