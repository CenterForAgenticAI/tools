import { type BigIntStats, linkSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { Refusal } from "./result.ts";
import { fileId, placeNoClobber, statId, tidy, uniqueSibling } from "./swap.ts";

export const LOCK_FILE = ".pi-profile.lock";

/** Profile directories this process holds, with the token it wrote, so nested calls do not deadlock. */
const held = new Map<string, string>();

/**
 * A refusal because another process holds, or is taking over, the lock on
 * `dir`. It carries the locked directory (resolved) so a caller can tell its
 * own lock from a nested one without reading the message.
 */
export class LockBusy extends Refusal {
	readonly dir: string;
	/** The live holder, when known; undefined while another process breaks a stale lock. */
	readonly pid: number | undefined;
	constructor(dir: string, pid: number | undefined) {
		super(pid === undefined ? `${dir} is being changed by another pi-profile; try again when it finishes` : `${dir} is being changed by process ${String(pid)}; try again when it finishes`);
		this.dir = dir;
		this.pid = pid;
	}
}

export interface LockHooks {
	/** Test seam: runs after a stale lock is read and before it is taken over. */
	readonly afterStaleRead?: () => void;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Create `lock` holding `token`, or return false if it exists. The token is
 * written to a private name first and then linked into place, so the lock
 * name never holds an empty or partly written file another process could
 * mistake for a stale lock.
 */
function tryCreate(lock: string, token: string): boolean {
	const tmp = uniqueSibling(lock, "new");
	writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
	try {
		return placeNoClobber(tmp, lock);
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			// placeNoClobber already removed it
		}
	}
}

/** How long a breaker file may live before it is reported as left behind, or removed when provably stale. */
export const BREAKER_STALE_MS = 10_000;

function holder(text: string): number | undefined {
	const pid = Number.parseInt(text, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Remove the lock only if it still holds `seen`. Only a process whose lock
 * holder is gone removes another's lock, and it does so while holding the
 * breaker file `<lock>.break`. A live holder never loses its lock, and the
 * lock name is never left empty while another lock is being checked.
 */
function breakStale(dir: string, lock: string, seen: string, token: string): void {
	const breaker = `${lock}.break`;
	if (!tryCreate(breaker, token)) {
		const other = readOrUndefined(breaker);
		const pid = other === undefined ? undefined : holder(other);
		const age = Date.now() - (lstatSync(breaker, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
		if (pid !== undefined && !alive(pid) && age > BREAKER_STALE_MS) {
			throw new Refusal(`could not lock ${dir}: ${breaker} was left by a process that is gone; remove it if no pi-profile is running`);
		}
		throw new LockBusy(dir, undefined);
	}
	try {
		if (readOrUndefined(lock) === seen) unlinkSync(lock);
	} finally {
		unlinkSync(breaker);
	}
}

/**
 * Each lock holds "<pid> <random>". A stale lock (its process is gone) is
 * removed by breakStale, and then the lock is created as usual.
 */
function acquire(dir: string, lock: string, token: string, hooks: LockHooks): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (tryCreate(lock, token)) return;
		const seen = readOrUndefined(lock);
		if (seen === undefined) continue;
		const pid = holder(seen);
		if (pid !== undefined && alive(pid)) {
			throw new LockBusy(dir, pid);
		}
		hooks.afterStaleRead?.();
		breakStale(dir, lock, seen, token);
	}
	throw new Refusal(`could not lock ${dir}; remove ${lock} if no pi-profile is running`);
}

/**
 * Remove the lock only if it is still the one this process wrote. While this
 * process is alive no other process removes its lock, so the check and the
 * unlink cannot be separated by a change.
 */
function release(lock: string, token: string): void {
	if (readOrUndefined(lock) === token) unlinkSync(lock);
}

/** `dir`'s breaker when it is older than BREAKER_STALE_MS, so it may have been left by a crash; otherwise undefined. */
export function leftoverBreaker(dir: string): string | undefined {
	const breaker = `${join(resolve(dir), LOCK_FILE)}.break`;
	const st = lstatSync(breaker, { throwIfNoEntry: false });
	return st !== undefined && Date.now() - st.mtimeMs > BREAKER_STALE_MS ? breaker : undefined;
}

export interface BreakerHooks {
	/** Test seam: runs after the breaker is judged stale and before it is removed. */
	readonly afterJudged?: () => void;
}

/**
 * Remove `dir`'s breaker only when it is provably stale: a regular file older
 * than BREAKER_STALE_MS, written by a process that is gone, beside a lock that
 * is gone or whose holder is gone. Returns true when it was removed.
 */
export function removeStaleBreaker(dir: string, hooks: BreakerHooks = {}): boolean {
	const lock = join(resolve(dir), LOCK_FILE);
	const breaker = `${lock}.break`;
	const judged = lstatSync(breaker, { bigint: true, throwIfNoEntry: false });
	if (judged === undefined || !judged.isFile() || Date.now() - Number(judged.mtimeNs / 1_000_000n) <= BREAKER_STALE_MS) return false;
	const writer = holder(readOrUndefined(breaker) ?? "");
	if (writer === undefined || alive(writer)) return false;
	const seen = readOrUndefined(lock);
	const owner = seen === undefined ? undefined : holder(seen);
	if (owner !== undefined && alive(owner)) return false;
	hooks.afterJudged?.();
	return clearBreakerIfUnchanged(breaker, judged);
}

/** How long a name put aside while clearing a breaker may live before it is swept as left by a crash. */
export const BREAKER_ASIDE_STALE_MS = 60_000;

/**
 * Remove the breaker judged stale without ever leaving the breaker name empty
 * while another taker could look. Leftovers of an earlier clearing are swept
 * first. The breaker's inode is then linked aside to
 * `<breaker>.stale-<inode in hex>` (O_EXCL by nature), so only one taker at a
 * time clears a given breaker; a taker that finds the name taken leaves the
 * breaker to it. The breaker path is unlinked only if a fresh lstat still
 * shows the file judged stale; a fresh breaker linked aside by mistake stays
 * in place. Returns true when the judged breaker is gone.
 *
 * Shared by the profile lock and the Pi auth lock (issues 27 and 38).
 */
export function clearBreakerIfUnchanged(breaker: string, judged: BigIntStats): boolean {
	sweepBreakerLeftovers(breaker);
	const aside = `${breaker}.stale-${judged.ino.toString(16)}`;
	try {
		linkSync(breaker, aside);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "EEXIST") return false;
		throw error;
	}
	try {
		const id = statId(judged);
		if (fileId(aside) !== id || fileId(breaker) !== id) return false;
		unlinkSync(breaker);
		return true;
	} finally {
		// Left behind on a failure, it is swept once older than BREAKER_ASIDE_STALE_MS.
		tidy(aside);
	}
}

/**
 * A crash while clearing a breaker leaves `<breaker>.stale-<hex>` behind.
 * Remove such names put aside more than BREAKER_ASIDE_STALE_MS ago, judged by
 * lstat: only regular files and empty folders, never what a link points to.
 * The age is the ctime: a link aside keeps the breaker's old mtime, and a
 * taker still clearing it linked it moments ago.
 */
function sweepBreakerLeftovers(breaker: string): void {
	const dir = dirname(breaker);
	const prefix = `${basename(breaker)}.stale-`;
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(prefix) || !/^[0-9a-f]+$/.test(name.slice(prefix.length))) continue;
		const path = join(dir, name);
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st === undefined || Date.now() - st.ctimeMs <= BREAKER_ASIDE_STALE_MS) continue;
		try {
			if (st.isFile()) unlinkSync(path);
			else if (st.isDirectory()) rmdirSync(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
		}
	}
}

/**
 * Run `fn` while holding the profile's lock file, so two pi-profile processes
 * never change the same profile at once. Re-entrant within one process.
 */
export function withProfileLock<T>(dir: string, fn: () => T, hooks: LockHooks = {}): T {
	const key = resolve(dir);
	if (held.has(key)) return fn();
	const lock = join(key, LOCK_FILE);
	const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
	acquire(key, lock, token, hooks);
	held.set(key, token);
	try {
		return fn();
	} finally {
		held.delete(key);
		release(lock, token);
	}
}
