import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, type Dirent, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, statfsSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isSecretName } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { LOCK_FILE, withProfileLock } from "./lock.ts";
import { overlapsPulled, remoteDir, type Layout } from "./paths.ts";
import { Refusal } from "./result.ts";
import { checkStore } from "./sessions.ts";
import { fileId, placeNoClobber, statId, tidy } from "./swap.ts";

/**
 * Move session files from one directory tree to another without ever losing
 * one. Each file is copied to a temporary name in the destination, hashed
 * while it is written, synced, checked again, and linked into place without
 * replacing anything. The source is removed last, and only when it is still
 * the exact file that was copied. An interrupted run leaves either the source
 * alone or two identical copies, and the next run finishes the job.
 */

/** A file changed this recently may still be open in Pi; it is left for a later run. */
export const RECENT_MS = 10 * 60 * 1000;
const TEMP_MARK = ".pi-profile-migrate-";
const CHUNK = 1 << 20;

export type OutcomeKind = "move" | "duplicate" | "conflict" | "skip" | "fail";

export interface Outcome {
	readonly rel: string;
	readonly kind: OutcomeKind;
	readonly bytes: number;
	readonly reason?: string | undefined;
}

export interface MigrateResult {
	readonly from: string;
	readonly to: string;
	readonly applied: boolean;
	readonly outcomes: readonly Outcome[];
	/** Bytes free at the destination, or undefined when both sides share a volume. */
	readonly freeBytes: number | undefined;
	readonly tempsRemoved: number;
}

export interface MigrateHooks {
	/** Test seam: runs after the scan, before any file is changed. */
	readonly afterScan?: () => void;
	/** Test seam: runs after a file is copied and synced, before it is checked and placed. */
	readonly afterCopy?: (rel: string) => void;
	/** Test seam: runs after the copy is in place, before the source is removed. */
	readonly beforeRemove?: (rel: string) => void;
	/** Test seam: runs after the destination folder is checked, before it is created. */
	readonly beforeMkdir?: (rel: string) => void;
}

export interface MigrateOptions {
	readonly apply: boolean;
	readonly now?: number;
	readonly hooks?: MigrateHooks;
}

interface Planned {
	readonly rel: string;
	readonly kind: OutcomeKind;
	readonly bytes: number;
	readonly reason?: string | undefined;
	/** Identity of the source when it was planned. */
	readonly id?: string | undefined;
	/** For a duplicate: identity of the identical copy at the destination when it was planned. */
	readonly dstId?: string | undefined;
}

interface Plan {
	readonly files: Planned[];
	/** Source directories below the root, parents before children. */
	readonly dirs: string[];
	/** Leftover temporary files from an interrupted run. */
	readonly temps: string[];
}

/** What the copy at the destination must still be before the source is removed. */
interface Expected {
	/** `fileId` of the copy that was placed or found. */
	readonly id: string | undefined;
	/** SHA-256 of the source's bytes. */
	readonly hash: string;
}

/** Resolve a store ID or an absolute path to a directory. */
export function resolveEndpoint(l: Layout, arg: string, env?: Readonly<Record<string, string | undefined>>): string {
	const store = loadConfig(l, env).sessionStores[arg];
	const path = store?.path ?? (isAbsolute(arg) ? arg : undefined);
	// Pulled sessions are other hosts'; moving them into a store would claim them (laws L6, L7).
	if (path !== undefined && overlapsPulled(l, path)) throw new Refusal(`${path} overlaps the pulled sessions in ${remoteDir(l)}; fork a pulled session instead`);
	if (path !== undefined) return path;
	throw new Refusal(`not a session store ID or an absolute path: ${arg}`);
}

function hashFd(fd: number): string {
	const hash = createHash("sha256");
	const buf = Buffer.allocUnsafe(CHUNK);
	for (;;) {
		const n = readSync(fd, buf, 0, CHUNK, null);
		if (n === 0) break;
		hash.update(buf.subarray(0, n));
	}
	return hash.digest("hex");
}

function sha256(path: string): string {
	const fd = openSync(path, "r");
	try {
		return hashFd(fd);
	} finally {
		closeSync(fd);
	}
}

/** Copy `src` to a new file `tmp`, sync it, and return the SHA-256 of the bytes written. */
function copyHashed(src: string, tmp: string): { hash: string; size: number } {
	const input = openSync(src, "r");
	try {
		const output = openSync(tmp, "wx", 0o600);
		try {
			const hash = createHash("sha256");
			const buf = Buffer.allocUnsafe(CHUNK);
			let size = 0;
			for (;;) {
				const n = readSync(input, buf, 0, CHUNK, null);
				if (n === 0) break;
				let written = 0;
				while (written < n) written += writeSync(output, buf, written, n - written);
				hash.update(buf.subarray(0, n));
				size += n;
			}
			fsyncSync(output);
			return { hash: hash.digest("hex"), size };
		} finally {
			closeSync(output);
		}
	} finally {
		closeSync(input);
	}
}

function syncDir(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Some file systems cannot sync a directory; the file itself is synced.
	}
}

function isTemp(name: string): boolean {
	return name.includes(TEMP_MARK) && name.endsWith(".tmp");
}

const LOCKED = "a lock file beside it says a Pi process may hold it; remove the lock if no process does";
const LEAVES_DEST = "the destination folder is a link that leads outside the destination";
const BROKEN_LINK = "the destination folder is a link that leads to nothing";
const NOT_A_FOLDER = "something that is not a folder is in the way of the destination folder";
const SAME_FILE = "the destination is the same file as the source";
const FOLDER_IN_WAY = "a folder is at the destination where the source has a file";

const COPY_CHANGED = "the copy at the destination is no longer the file that was checked; the source is kept";
/**
 * The lock names checked during `--apply`, before every copy and removal:
 * `<name>.pi-daemon.lock` and `<name>.lock`. The scan catches any
 * `<name>.*.lock`; checking a fixed pair keeps each check to two lookups.
 */
const APPLY_LOCK_ENDINGS = [".pi-daemon.lock", ".lock"];

/**
 * Every name in a folder that a lock there belongs to: `x` and `x.y` for
 * `x.y.pi-daemon.lock`. A file named `n` is locked when `n` is in the set,
 * which matches any `<n>.*.lock` beside it.
 */
function lockOwners(names: readonly string[]): Set<string> {
	const owners = new Set<string>();
	for (const name of names) {
		if (!name.endsWith(".lock")) continue;
		for (let i = name.indexOf(".", 1); i !== -1; i = name.indexOf(".", i + 1)) owners.add(name.slice(0, i));
	}
	return owners;
}

/**
 * True when `<path>.pi-daemon.lock` or `<path>.lock` exists. Checks only the
 * file's own lock names, so its folder is not listed again for every file.
 */
function hasOwnLock(path: string): boolean {
	return APPLY_LOCK_ENDINGS.some((ending) => lstatSync(`${path}${ending}`, { throwIfNoEntry: false }) !== undefined);
}

/** Where a destination folder was made: the path to write below, and how to let go of it. */
type Made = { readonly dir: string; readonly close: () => void } | { readonly blocked: string };

/** More links than this on the way down means the folders keep changing under the walk. */
const MAX_HOPS = 8;

let fdPaths: boolean | undefined;

/** The path of an open folder. On Linux, names below it resolve inside that folder, as `openat` does. */
function fdDir(fd: number): string {
	return `/proc/self/fd/${fd}`;
}

/**
 * True when `/proc/self/fd/<fd>` names the open folder itself, as on Linux.
 * Elsewhere (macOS has no `/proc`) folders are made and written by path.
 */
function hasFdPaths(): boolean {
	if (fdPaths !== undefined) return fdPaths;
	fdPaths = false;
	try {
		const fd = openSync("/", constants.O_RDONLY);
		try {
			const opened = fstatSync(fd);
			const named = statSync(fdDir(fd));
			fdPaths = opened.dev === named.dev && opened.ino === named.ino;
		} finally {
			closeSync(fd);
		}
	} catch {
		// no /proc/self/fd here
	}
	return fdPaths;
}

/** A handle on `path` when it is a folder itself; undefined when it is a link, a file, or gone. */
function openDir(path: string): number | undefined {
	try {
		return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Create `dir` below `to` one folder at a time. A link is followed only when
 * its real path is a folder inside `to`. A recursive mkdir would follow a
 * folder swapped for a link after `whyOutside` and create folders outside the
 * destination.
 *
 * Where `/proc/self/fd` works, each folder is opened (never through a link)
 * and the next one is made and opened relative to that handle, starting from
 * `to`. The copy is then written below the last handle, so swapping any
 * folder on the way for a link cannot redirect it. Elsewhere the walk goes by
 * real path, and a folder above the last one swapped at the wrong moment can
 * still redirect the copy; the source is kept then (see .spec/design.md).
 */
function makeDirsInside(to: string, dir: string): Made {
	const parts = relative(to, dir).split(sep).filter((x) => x !== "");
	return hasFdPaths() ? makeDirsByHandle(to, parts) : makeDirsByPath(to, parts);
}

function makeDirsByHandle(to: string, parts: string[]): Made {
	let fd = openDir(to);
	if (fd === undefined) return { blocked: LEAVES_DEST };
	let hops = 0;
	try {
		for (let i = 0; i < parts.length; i++) {
			const path = `${fdDir(fd)}/${parts[i]}`;
			mkdirExisting(path);
			const next = openDir(path);
			if (next !== undefined) {
				closeSync(fd);
				fd = next;
				continue;
			}
			if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return { blocked: NOT_A_FOLDER };
			let real: string;
			try {
				real = realpathSync(path);
			} catch (error) {
				return { blocked: unresolvedReason(error) };
			}
			if (!inside(real, to)) return { blocked: LEAVES_DEST };
			if (++hops > MAX_HOPS) return { blocked: BROKEN_LINK };
			// Walk down again from `to`, along the link's real path, then on with the rest.
			closeSync(fd);
			fd = openDir(to);
			if (fd === undefined) return { blocked: LEAVES_DEST };
			parts.splice(0, i + 1, ...relative(to, real).split(sep).filter((x) => x !== ""));
			i = -1;
		}
		const held = fd;
		fd = undefined;
		return { dir: fdDir(held), close: () => closeSync(held) };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Without folder handles: create by path, and carry on from each link's real path. */
function makeDirsByPath(to: string, parts: readonly string[]): Made {
	let cur = to;
	for (const part of parts) {
		cur = join(cur, part);
		mkdirExisting(cur);
		const st = lstatSync(cur);
		if (st.isDirectory()) continue;
		if (!st.isSymbolicLink()) return { blocked: NOT_A_FOLDER };
		let real: string;
		try {
			real = realpathSync(cur);
		} catch (error) {
			return { blocked: unresolvedReason(error) };
		}
		if (!inside(real, to)) return { blocked: LEAVES_DEST };
		if (!lstatSync(real).isDirectory()) return { blocked: NOT_A_FOLDER };
		cur = real;
	}
	return { dir: cur, close: () => undefined };
}

function mkdirExisting(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Why a path could not be resolved: a broken link, or otherwise treated as leading outside. */
function unresolvedReason(error: unknown): string {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ELOOP" ? BROKEN_LINK : LEAVES_DEST;
}

/**
 * True when `dst` is still the regular file that was placed or checked (not a
 * link to one), and still holds the expected bytes. The bytes are hashed
 * through a descriptor checked to be that same file.
 */
function isExpectedCopy(dst: string, expected: Expected): boolean {
	const st = lstatSync(dst, { bigint: true, throwIfNoEntry: false });
	if (st === undefined || !st.isFile() || statId(st) !== expected.id) return false;
	let fd: number;
	try {
		fd = openSync(dst, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ELOOP") return false;
		throw error;
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		return opened.isFile() && statId(opened) === expected.id && hashFd(fd) === expected.hash;
	} finally {
		closeSync(fd);
	}
}

/**
 * Undefined when the folder that will hold `dst` resolves inside `to`, else
 * why not. A folder under the destination can be a link into the source or
 * elsewhere; a copy placed through it would land outside the destination.
 */
function whyOutside(to: string, dst: string): string | undefined {
	let dir = dirname(dst);
	while (!exists(dir)) dir = dirname(dir);
	let real: string;
	try {
		real = realpathSync(dir);
	} catch (error) {
		return unresolvedReason(error);
	}
	if (!inside(real, to)) return LEAVES_DEST;
	// A file where a folder is needed: report it here, so later lookups below it cannot throw ENOTDIR.
	return lstatSync(real).isDirectory() ? undefined : NOT_A_FOLDER;
}

/** True when `path` exists. A file in the way of one of its folders means it does not. */
function exists(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
		throw error;
	}
}

function sameFile(a: string, b: string): boolean {
	const x = lstatSync(a, { bigint: true });
	const y = lstatSync(b, { bigint: true, throwIfNoEntry: false });
	return y !== undefined && x.dev === y.dev && x.ino === y.ino;
}

function classify(from: string, to: string, rel: string, now: number, lockOwnerNames: ReadonlySet<string>): Planned {
	const src = join(from, rel);
	const dstPath = join(to, rel);
	const st = lstatSync(src);
	const name = basename(rel);
	if (st.isSymbolicLink()) return { rel, kind: "skip", bytes: 0, reason: "symbolic link" };
	if (!st.isFile()) return { rel, kind: "skip", bytes: 0, reason: "not a regular file" };
	if (name.endsWith(".lock")) return { rel, kind: "skip", bytes: st.size, reason: "lock file" };
	if (isSecretName(name)) return { rel, kind: "skip", bytes: st.size, reason: "credentials stay where they are" };
	if (isTemp(name)) return { rel, kind: "skip", bytes: st.size, reason: "temporary file from a migration" };
	if (lockOwnerNames.has(name)) return { rel, kind: "skip", bytes: st.size, reason: LOCKED };
	if (now - st.mtimeMs < RECENT_MS) return { rel, kind: "skip", bytes: st.size, reason: "changed in the last 10 minutes; it may be in use" };
	const outside = whyOutside(to, dstPath);
	if (outside !== undefined) return { rel, kind: "conflict", bytes: st.size, reason: outside };
	const id = fileId(src);
	const dst = lstatSync(dstPath, { throwIfNoEntry: false });
	if (dst === undefined) return { rel, kind: "move", bytes: st.size, id };
	if (sameFile(src, dstPath)) return { rel, kind: "conflict", bytes: st.size, reason: SAME_FILE };
	if (dst.isDirectory()) return { rel, kind: "conflict", bytes: st.size, reason: FOLDER_IN_WAY };
	if (!dst.isFile() || dst.size !== st.size || sha256(src) !== sha256(dstPath)) {
		return { rel, kind: "conflict", bytes: st.size, reason: "a different file is already at the destination" };
	}
	return { rel, kind: "duplicate", bytes: st.size, id, dstId: fileId(dstPath) };
}

function scan(from: string, to: string, now: number): Plan {
	const plan: Plan = { files: [], dirs: [], temps: [] };
	const list = (dir: string): Dirent[] => readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
	/** `inDest`: the destination has this folder, so it may hold leftover temporary files. */
	const walk = (rel: string, inDest: boolean): void => {
		if (inDest) {
			const dst = join(to, rel);
			for (const entry of list(dst)) if (entry.isFile() && isTemp(entry.name)) plan.temps.push(join(dst, entry.name));
		}
		// Each source folder is listed once; its lock names serve every file in it.
		const entries = list(join(from, rel));
		const owners = lockOwners(entries.map((e) => e.name));
		for (const entry of entries) {
			const child = rel === "" ? entry.name : join(rel, entry.name);
			if (rel === "" && entry.name.startsWith(LOCK_FILE)) continue;
			if (entry.isDirectory()) {
				plan.dirs.push(child);
				walk(child, inDest && lstatSync(join(to, child), { throwIfNoEntry: false })?.isDirectory() === true);
			} else {
				plan.files.push(classify(from, to, child, now, owners));
			}
		}
	};
	walk("", true);
	return plan;
}

function moveOne(from: string, to: string, p: Planned, hooks: MigrateHooks): Outcome {
	const src = join(from, p.rel);
	if (fileId(src) !== p.id) return { rel: p.rel, kind: "skip", bytes: p.bytes, reason: "changed since the scan; run again later" };
	if (hasOwnLock(src)) return { rel: p.rel, kind: "skip", bytes: p.bytes, reason: LOCKED };
	const outside = whyOutside(to, join(to, p.rel));
	if (outside !== undefined) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: outside };
	hooks.beforeMkdir?.(p.rel);
	const made = makeDirsInside(to, dirname(join(to, p.rel)));
	if ("blocked" in made) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: made.blocked };
	try {
		return placeCopy(to, src, p, hooks, made.dir);
	} finally {
		made.close();
	}
}

/**
 * Copy, check and place the file below `dir`, then remove the source. `dir`
 * is the held folder handle's path, or the real path where there is none,
 * never a path back through a link that may since have been retargeted.
 */
function placeCopy(to: string, src: string, p: Planned, hooks: MigrateHooks, dir: string): Outcome {
	const dst = join(dir, basename(p.rel));
	const tmp = join(dir, `.${basename(dst)}${TEMP_MARK}${randomBytes(6).toString("hex")}.tmp`);
	let placed: Expected | undefined;
	try {
		const copied = copyHashed(src, tmp);
		hooks.afterCopy?.(p.rel);
		if (fileId(src) !== p.id) return { rel: p.rel, kind: "skip", bytes: p.bytes, reason: "changed while it was copied; run again later" };
		if (copied.size !== p.bytes || sha256(tmp) !== copied.hash) return { rel: p.rel, kind: "fail", bytes: p.bytes, reason: "the copy did not verify; the source is kept" };
		const st = lstatSync(src);
		chmodSync(tmp, st.mode & 0o777);
		utimesSync(tmp, st.atime, st.mtime);
		const id = fileId(tmp);
		if (!placeNoClobber(tmp, dst)) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: "a file appeared at the destination; the source is kept" };
		placed = { id, hash: copied.hash };
		syncDir(dir);
	} finally {
		if (placed === undefined) tidy(tmp);
	}
	hooks.beforeRemove?.(p.rel);
	return removeSource(to, src, dst, p, "move", placed);
}

/**
 * Remove the source only when it is still the file that was verified, no lock
 * has appeared beside it, and the copy is still the separate regular file that
 * was placed or checked, with the source's bytes, inside the destination.
 */
function removeSource(to: string, src: string, dst: string, p: Planned, kind: OutcomeKind, expected: Expected): Outcome {
	if (fileId(src) !== p.id) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: "the source changed after it was copied; both files are kept" };
	if (hasOwnLock(src)) return { rel: p.rel, kind: "skip", bytes: p.bytes, reason: `${LOCKED}; both copies are kept` };
	if (sameFile(src, dst)) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: SAME_FILE };
	if (!isExpectedCopy(dst, expected)) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: COPY_CHANGED };
	const outside = whyOutside(to, dst);
	if (outside !== undefined) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: outside };
	unlinkSync(src);
	syncDir(dirname(src));
	return { rel: p.rel, kind, bytes: p.bytes };
}

function removeDuplicate(from: string, to: string, p: Planned): Outcome {
	const src = join(from, p.rel);
	const dst = join(to, p.rel);
	const outside = whyOutside(to, dst);
	if (outside !== undefined) return { rel: p.rel, kind: "conflict", bytes: p.bytes, reason: outside };
	if (fileId(src) !== p.id) return { rel: p.rel, kind: "skip", bytes: p.bytes, reason: "changed since the scan; run again later" };
	// isExpectedCopy reads the copy once, through a descriptor checked to be the file found at the scan.
	return removeSource(to, src, dst, p, "duplicate", { id: p.dstId, hash: sha256(src) });
}

function inside(child: string, parent: string): boolean {
	const r = relative(parent, child);
	return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

function freeBytes(from: string, to: string): number | undefined {
	if (lstatSync(from).dev === lstatSync(to).dev) return undefined;
	const fs = statfsSync(to);
	return fs.bavail * fs.bsize;
}

/**
 * Plan, and with `apply` carry out, the move of every session file under
 * `fromPath` to the same relative path under `toPath`.
 */
export function migrateSessions(fromPath: string, toPath: string, opts: MigrateOptions): MigrateResult {
	if (!isAbsolute(fromPath) || !isAbsolute(toPath)) throw new Refusal("migrate needs absolute paths");
	if (!lstatSync(fromPath, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal(`source is not a directory: ${fromPath}`);
	const problem = checkStore(toPath);
	if (problem !== undefined) throw new Refusal(`destination ${problem}: ${toPath}`);
	if (!lstatSync(toPath).isDirectory()) throw new Refusal(`destination is not a directory: ${toPath}`);
	const from = realpathSync(fromPath);
	const to = realpathSync(toPath);
	if (inside(from, to) || inside(to, from)) throw new Refusal(`source and destination overlap: ${from} and ${to}`);
	const run = (): MigrateResult => {
		const plan = scan(from, to, opts.now ?? Date.now());
		const free = freeBytes(from, to);
		if (!opts.apply) return { from, to, applied: false, outcomes: plan.files, freeBytes: free, tempsRemoved: 0 };
		const needed = plan.files.filter((f) => f.kind === "move").reduce((n, f) => n + f.bytes, 0);
		if (free !== undefined && needed > free) throw new Refusal(`not enough space at ${to}: need ${needed} bytes, ${free} free; nothing was moved`);
		const hooks = opts.hooks ?? {};
		hooks.afterScan?.();
		for (const temp of plan.temps) tidy(temp);
		const outcomes = plan.files.map((p): Outcome => {
			try {
				if (p.kind === "move") return moveOne(from, to, p, hooks);
				if (p.kind === "duplicate") return removeDuplicate(from, to, p);
				return { rel: p.rel, kind: p.kind, bytes: p.bytes, reason: p.reason };
			} catch (error) {
				return { rel: p.rel, kind: "fail", bytes: p.bytes, reason: (error as Error).message };
			}
		});
		for (const dir of [...plan.dirs].reverse()) {
			try {
				rmdirSync(join(from, dir));
			} catch {
				// not empty: something was kept
			}
		}
		return { from, to, applied: true, outcomes, freeBytes: free, tempsRemoved: plan.temps.length };
	};
	return withProfileLock(to, () => withProfileLock(from, run));
}
