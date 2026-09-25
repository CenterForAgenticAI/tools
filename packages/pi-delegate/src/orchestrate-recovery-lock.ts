/**
 * Shared, owner-only cross-process lock for detached-orchestrate recovery and
 * control posts. A lock is an atomically published, non-empty directory whose
 * sole entry is generation-specific. Reclaim/release remove only that exact
 * entry and then use non-recursive `rmdir`, so a delayed process cannot delete
 * a successor generation.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveOrchestrateDir } from "./detached-spawn.js";
import {
	captureProcessIdentity,
	getProcessNonce,
	isValidProcessBootId,
	isValidProcessNonce,
	isValidProcessStartTicks,
	verifyProcessIdentity,
	type ProcessIdentityDependencies,
} from "./process-identity.js";
import { isSafeRunId } from "./run-id.js";

export const ORCHESTRATE_RECOVERY_LOCK_STALE_MS = 60_000;

export interface OrchestrateRecoveryLock {
	/** Canonical lock-directory path. */
	file: string;
	token: string;
}

/** Internal fault seams shared with recovery tests; production never assigns them. */
export const __testHooks: {
	beforeRecoveryLockWrite?: () => void;
	afterRecoveryLockWrite?: () => void;
	afterRecoveryLockFsync?: () => void;
	beforeRecoveryLockReclaim?: () => void;
	beforePendingPublish?: () => void;
	afterRouteDelete?: () => void;
} = {};

interface PersistedLockOwner {
	token: string;
	pid: number;
	acquiredAt: number;
	startTicks?: string;
	bootId?: string;
	nonce?: string;
}

function resolveRecoveryDir(agentDir: string): string {
	return path.join(resolveOrchestrateDir(agentDir), "recovery");
}

function resolveRecoveryLockDir(agentDir: string, runId: string): string {
	// `.lockdir` deliberately does not reuse the regular-file `.lock` prototype
	// from pre-merge development. There is no released version to migrate, and
	// ignoring such artifacts is safer than destructively guessing their inode.
	return path.join(resolveRecoveryDir(agentDir), `${runId}.lockdir`);
}

function ownerEntryName(token: string): string {
	return `${token}.owner.json`;
}

function ownerEntryPath(lockDir: string, token: string): string {
	return path.join(lockDir, ownerEntryName(token));
}

function ensureOwnerOnlyDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

function uniqueTmp(lockDir: string): string {
	return `${lockDir}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
}

function readOwner(lockDir: string): { owner: PersistedLockOwner; file: string; mtimeMs: number } | undefined {
	try {
		if (!fs.statSync(lockDir).isDirectory()) return undefined;
		const entries = fs.readdirSync(lockDir, { withFileTypes: true });
		if (entries.length !== 1 || !entries[0]?.isFile() || !entries[0].name.endsWith(".owner.json")) {
			return undefined;
		}
		const file = path.join(lockDir, entries[0].name);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PersistedLockOwner>;
		if (
			typeof parsed.token !== "string" ||
			parsed.token.length === 0 ||
			entries[0].name !== ownerEntryName(parsed.token) ||
			typeof parsed.pid !== "number" ||
			!Number.isInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.acquiredAt !== "number" ||
			!Number.isFinite(parsed.acquiredAt)
		) {
			return undefined;
		}
		const owner: PersistedLockOwner = {
			token: parsed.token,
			pid: parsed.pid,
			acquiredAt: parsed.acquiredAt,
			...(isValidProcessStartTicks(parsed.startTicks) ? { startTicks: parsed.startTicks } : {}),
			...(isValidProcessBootId(parsed.bootId) ? { bootId: parsed.bootId } : {}),
			...(isValidProcessNonce(parsed.nonce) ? { nonce: parsed.nonce } : {}),
		};
		return {
			owner,
			file,
			mtimeMs: fs.statSync(file).mtimeMs,
		};
	} catch {
		return undefined;
	}
}

/**
 * Acquire the shared lock. The internal `.rotation` key is reserved for the
 * durable fairness cursor; all externally-derived keys must be safe run ids.
 */
export function acquireOrchestrateRecoveryLock(args: {
	agentDir: string;
	runId: string;
	now?: number;
	staleMs?: number;
	/** @deprecated Prefer processIdentityDependencies.probePid for deterministic tests. */
	lockPidAliveFn?: (pid: number) => boolean;
	/** Test seam for deterministic generation identity verification and capture. */
	processIdentityDependencies?: Partial<ProcessIdentityDependencies>;
	invokeCreationHook?: boolean;
}): OrchestrateRecoveryLock | undefined {
	const { agentDir, runId } = args;
	if (runId !== ".rotation" && !isSafeRunId(runId)) return undefined;
	const now = typeof args.now === "number" && Number.isFinite(args.now) ? args.now : Date.now();
	const requestedStale = typeof args.staleMs === "number" && Number.isFinite(args.staleMs)
		? args.staleMs
		: ORCHESTRATE_RECOVERY_LOCK_STALE_MS;
	const staleMs = Math.max(1, requestedStale);
	const invokeCreationHook = args.invokeCreationHook ?? true;
	const captureDependencies = args.processIdentityDependencies;
	const verifyDependencies = args.lockPidAliveFn && captureDependencies?.probePid === undefined
		? {
			...captureDependencies,
			probePid: (pid: number) => args.lockPidAliveFn!(pid) ? "present" : "absent",
		}
		: captureDependencies;
	const parent = resolveRecoveryDir(agentDir);
	ensureOwnerOnlyDir(parent);
	const file = resolveRecoveryLockDir(agentDir, runId);
	const token = randomBytes(16).toString("hex");
	const capturedIdentity = captureProcessIdentity(process.pid, captureDependencies);
	const ownerRecord: PersistedLockOwner = {
		token,
		pid: process.pid,
		acquiredAt: now,
		nonce: getProcessNonce(),
		...(capturedIdentity
			? { startTicks: capturedIdentity.startTicks, bootId: capturedIdentity.bootId }
			: {}),
	};

	const create = (): boolean => {
		// Build a complete, fsynced, non-empty private directory, then publish it
		// with one rename. A competing non-empty canonical directory cannot be
		// replaced by POSIX rename; one generation therefore wins atomically.
		const tmp = uniqueTmp(file);
		let fd: number | undefined;
		try {
			fs.mkdirSync(tmp, { mode: 0o700 });
			fs.chmodSync(tmp, 0o700);
			const ownerFile = ownerEntryPath(tmp, token);
			fd = fs.openSync(ownerFile, "wx", 0o600);
			if (invokeCreationHook) __testHooks.beforeRecoveryLockWrite?.();
			fs.writeFileSync(fd, JSON.stringify(ownerRecord), "utf8");
			if (invokeCreationHook) __testHooks.afterRecoveryLockWrite?.();
			fs.fsyncSync(fd);
			if (invokeCreationHook) __testHooks.afterRecoveryLockFsync?.();
			fs.closeSync(fd);
			fd = undefined;
			fs.chmodSync(ownerFile, 0o600);
			try {
				fs.renameSync(tmp, file);
				return true;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (code === "EEXIST" || code === "ENOTEMPTY") return false;
				throw error;
			}
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {
					/* preserve the initializer error */
				}
			}
			try {
				fs.rmSync(tmp, { recursive: true, force: true });
			} catch {
				/* best-effort private temp cleanup */
			}
		}
	};

	if (create()) return { file, token };

	const observed = readOwner(file);
	if (!observed) {
		// An aged empty directory can remain when a releaser crashes between its
		// generation-specific unlink and rmdir (notably on platforms where rename
		// cannot replace an empty destination). Non-recursive rmdir is generation
		// safe: it fails rather than deleting a non-empty successor.
		try {
			const stat = fs.statSync(file);
			if (
				stat.isDirectory() &&
				fs.readdirSync(file).length === 0 &&
				now - stat.mtimeMs >= staleMs
			) {
				fs.rmdirSync(file);
				return create() ? { file, token } : undefined;
			}
		} catch {
			/* a concurrent owner/releaser changed the canonical generation */
		}
		// A non-empty malformed directory is never recursively removed: it may be
		// a successor being published or corruption needing manual hygiene.
		return undefined;
	}
	const verdict = verifyProcessIdentity(
		{
			pid: observed.owner.pid,
			startTicks: observed.owner.startTicks,
			bootId: observed.owner.bootId,
		},
		verifyDependencies,
	);
	if (verdict === "match" || verdict === "unproven") {
		// `match`: a live owner still holds this generation.
		// `unproven`: legacy pid-only or unreadable identity; never reclaim on PID alone.
		return undefined;
	}
	// Only a proven absence or generation mismatch is reclaimable immediately;
	// the age threshold applies only to empty/malformed cleanup artifacts above.
	__testHooks.beforeRecoveryLockReclaim?.();

	// Remove only the generation-specific entry that was proven dead. If another
	// reclaimer already replaced the canonical directory, this exact pathname is
	// absent (or its non-recursive rmdir below sees the successor as non-empty).
	try {
		fs.rmSync(observed.file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return undefined;
	}
	try {
		fs.rmdirSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") return undefined;
	}
	return create() ? { file, token } : undefined;
}

/** Release only this generation's unique owner entry, then its empty directory. */
export function releaseOrchestrateRecoveryLock(lock: OrchestrateRecoveryLock): void {
	try {
		fs.rmSync(ownerEntryPath(lock.file, lock.token));
	} catch {
		/* a delayed former owner never touches a successor token */
	}
	try {
		// Non-recursive rmdir cannot remove a successor's non-empty directory.
		fs.rmdirSync(lock.file);
	} catch {
		/* already released or a successor generation owns the canonical path */
	}
}
