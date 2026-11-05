import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import * as path from "node:path";

/**
 * Per-pool cross-process lock for context-cache manifest mutation.
 *
 * Every read-modify-write of a pool's `_manifest.json` runs inside
 * `withManifestLock`, so two writers cannot derive manifests from the same older
 * snapshot. See docs/context-cache-concurrency.md for the inventory and the
 * stale-owner rules.
 */

export const MANIFEST_LOCK_FILE_NAME = ".manifest.lock";
export const MANIFEST_LOCK_TAKEOVER_FILE_NAME = ".manifest.lock.takeover";

/** True for the lock files, which cleanup and listings must never treat as artifacts. */
export function isManifestLockFileName(file: string): boolean {
	const lower = file.toLowerCase();
	return lower === MANIFEST_LOCK_FILE_NAME || lower === MANIFEST_LOCK_TAKEOVER_FILE_NAME;
}

interface LockOwner {
	pid: number;
	startTime: string | null;
	token: string;
}

export interface ManifestLockOptions {
	/** Longest wait for a live owner before failing. Never steals. Default 60 s. */
	timeoutMs?: number;
	/** How old an unreadable lock file must be before it counts as abandoned. Default 10 s. */
	corruptGraceMs?: number;
	pollMs?: number;
	/** Test seams. */
	isAlive?: (pid: number) => boolean;
	startTimeOf?: (pid: number) => string | null;
}

/** Start time of a process, or null when this host cannot report it. */
export function processStartTime(pid: number): string | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 2 (comm) may contain spaces and parentheses; fields resume after the last ")".
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const field22 = rest[19];
		if (field22 && /^\d+$/.test(field22)) return field22;
	} catch { /* no procfs */ }
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
		if (out) return out;
	} catch { /* ps unavailable or process gone */ }
	return null;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readOwner(file: string): LockOwner | "absent" | "unreadable" {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
	try {
		const parsed = JSON.parse(raw) as Partial<LockOwner>;
		if (Number.isInteger(parsed.pid) && typeof parsed.token === "string" && (typeof parsed.startTime === "string" || parsed.startTime === null)) {
			return { pid: parsed.pid as number, startTime: parsed.startTime ?? null, token: parsed.token };
		}
	} catch { /* fall through */ }
	return "unreadable";
}

/** Create `file` exclusively with this owner's record. Returns false when it exists. */
function createExclusive(file: string, owner: LockOwner): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		if (code === "ENOENT") {
			// The pool directory was removed (purge) while we waited; recreate and retry.
			fs.mkdirSync(path.dirname(file), { recursive: true });
			return createExclusive(file, owner);
		}
		throw err;
	}
	try {
		fs.writeFileSync(fd, JSON.stringify(owner));
		fs.fsyncSync(fd);
	} catch (err) {
		fs.closeSync(fd);
		try { fs.unlinkSync(file); } catch { /* best effort */ }
		throw err;
	}
	fs.closeSync(fd);
	return true;
}

function releaseIfOwned(file: string, token: string): void {
	const owner = readOwner(file);
	if (typeof owner === "object" && owner.token === token) {
		try { fs.unlinkSync(file); } catch { /* already gone */ }
	}
}

const held = new Map<string, number>();

/**
 * Run `fn` while holding the pool's manifest lock. Re-entrant within one process.
 * `fn` must be synchronous: the lock is held across it, and a suspended caller
 * would hold the pool.
 *
 * A lock is taken over only when its owner pid is dead, or alive with a different
 * process start time (pid reuse). A live owner is waited for and never robbed,
 * whatever the lock's age. When the owner cannot be identified the lock is kept.
 */
export function withManifestLock<T>(cacheDir: string, fn: () => T, options: ManifestLockOptions = {}): T {
	const key = path.resolve(cacheDir);
	const depth = held.get(key) ?? 0;
	if (depth > 0) {
		held.set(key, depth + 1);
		try { return fn(); } finally { held.set(key, depth); }
	}

	const isAlive = options.isAlive ?? pidAlive;
	const startTimeOf = options.startTimeOf ?? processStartTime;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const corruptGraceMs = options.corruptGraceMs ?? 10_000;
	const pollMs = options.pollMs ?? 5;
	fs.mkdirSync(cacheDir, { recursive: true });
	const lockFile = path.join(cacheDir, MANIFEST_LOCK_FILE_NAME);
	const takeoverFile = path.join(cacheDir, MANIFEST_LOCK_TAKEOVER_FILE_NAME);
	const self: LockOwner = { pid: process.pid, startTime: startTimeOf(process.pid), token: randomUUID() };

	/** True when the lock file holds no live owner. */
	const isStale = (file: string, owner: LockOwner | "unreadable"): boolean => {
		if (owner === "unreadable") {
			// A crash between create and write leaves an empty file. Give a live creator time to finish.
			try { return Date.now() - fs.statSync(file).mtimeMs > corruptGraceMs; } catch { return false; }
		}
		if (!isAlive(owner.pid)) return true;
		if (owner.startTime === null) return false;
		const current = startTimeOf(owner.pid);
		return current !== null && current !== owner.startTime;
	};

	const deadline = Date.now() + timeoutMs;
	let delay = pollMs;
	for (;;) {
		if (createExclusive(lockFile, self)) break;
		const owner = readOwner(lockFile);
		if (owner === "absent") continue;
		if (isStale(lockFile, owner === "unreadable" ? owner : owner)) {
			// Takeover is serialised so two waiters cannot both remove and re-create.
			if (createExclusive(takeoverFile, self)) {
				try {
					const again = readOwner(lockFile);
					const same = typeof owner === "object" ? typeof again === "object" && again.token === owner.token : again === "unreadable";
					if (same && isStale(lockFile, again as LockOwner | "unreadable")) {
						try { fs.unlinkSync(lockFile); } catch { /* raced with nobody; retry creates */ }
					}
				} finally {
					releaseIfOwned(takeoverFile, self.token);
				}
				continue;
			}
			// A taker that crashed mid-takeover leaves its marker behind; clear it by the same rule.
			const taker = readOwner(takeoverFile);
			if (taker !== "absent" && isStale(takeoverFile, taker)) {
				const again = readOwner(takeoverFile);
				if (typeof taker === "object" ? typeof again === "object" && again.token === taker.token : again === "unreadable") {
					try { fs.unlinkSync(takeoverFile); } catch { /* raced */ }
				}
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out after ${timeoutMs} ms waiting for the context-cache manifest lock ${lockFile}; the owner is still running. Remove it by hand only after confirming no cache writer is active.`);
		}
		sleep(delay);
		delay = Math.min(delay * 2, 100);
	}

	held.set(key, 1);
	try {
		return fn();
	} finally {
		held.delete(key);
		releaseIfOwned(lockFile, self.token);
	}
}
