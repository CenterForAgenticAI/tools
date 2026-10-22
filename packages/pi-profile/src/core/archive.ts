import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { isSecretName } from "./auth.ts";
import { describeStore, keepLocalDaysFor, type ArchiveSettings, type ArchiveStore } from "./archivesettings.ts";
import { BATCH_BYTES, checkRsync, SSH_COMMAND, type ToolResult, type ToolRunner } from "./backup.ts";
import { LOCK_FILE, withProfileLock } from "./lock.ts";
import { hasOwnLock, lockOwners, syncDir } from "./migrate.ts";
import { type Layout } from "./paths.ts";
import { Refusal } from "./result.ts";
import { buildStub, isArchiveRel, normalizeForgeKey, readHead, readStubFile, readStubHead, sessionFacts, STUB_HEAD, type SessionFacts, type StubDetails } from "./sessionfile.ts";
import { fileId, placeNoClobber, tidy } from "./swap.ts";
import { createHash } from "node:crypto";

import { loadManifest, manifestPath, saveManifest, type ManifestEntry } from "./archivemanifest.ts";

export { keepLocalDaysFor, parseArchive, type ArchiveSettings } from "./archivesettings.ts";
export { loadManifest, manifestPath, type Manifest, type ManifestEntry } from "./archivemanifest.ts";

/**
 * Archive old session files to a cold store, and restore them.
 *
 * A session is archived in four steps, per batch of up to 256 MiB:
 * 1. compress it with zstd into scratch space under state/archive;
 * 2. upload the batch to the archive folder (rsync --ignore-existing: an
 *    archive copy is never replaced, and its name carries the SHA-256 of the
 *    session, so the same name always means the same bytes);
 * 3. read the batch back from the archive and check each copy decompresses
 *    to the exact bytes that were read (SHA-256 and size);
 * 4. only then replace the session with a stub, and only when the session is
 *    still the file that was read and no lock has appeared beside it.
 * The full local copy is never removed before step 3 has passed for it. A
 * dry run reads file metadata and the first lines of each old session, and
 * writes nothing anywhere.
 */

const DAY_MS = 86_400_000;
/** Marks pi-profile's own temporary and aside names in a session folder. */
const MARK = ".pi-profile-archive-";
const ASIDE = MARK + "aside-";
const RSYNC_IO_TIMEOUT = 600;
/** <stem>.kept-<sha16>.jsonl: a second copy restore keeps beside a grown stub; never archived on its own. */
const KEPT = /\.kept-[0-9a-f]{16}\.jsonl$/;

export type ArchiveKind = "archive" | "stub" | "skip" | "fail" | "recover";

export interface ArchiveOutcome {
	readonly rel: string;
	readonly kind: ArchiveKind;
	readonly bytes: number;
	readonly reason?: string;
}

export interface ArchiveResult {
	readonly store: string;
	readonly target: string;
	readonly applied: boolean;
	readonly outcomes: readonly ArchiveOutcome[];
	/** Bytes of full session files replaced by stubs (or that would be). */
	readonly freed: number;
}

export interface ArchiveHooks {
	/** Test seam: after a batch is verified on the archive, before any local file changes. */
	readonly afterVerify?: () => void;
	/** Test seam: after the full file is linked aside, before the new file takes its name. */
	readonly afterAside?: () => void;
	/** Test seam: after the new file has taken the name, before the aside name is removed. */
	readonly afterSwap?: () => void;
	/** Test seam: after a change is found around the swap, just before the old file takes its name back. */
	readonly beforePutBack?: () => void;
	/** Test seam: before a session is replaced with its stub. */
	readonly beforeStub?: (rel: string) => void;
}

export interface ArchiveOptions {
	readonly host: string;
	readonly apply: boolean;
	readonly now?: number;
	readonly run: ToolRunner;
	/** process.platform unless given; decides the default keepLocalDays. */
	readonly platform?: string;
	readonly hooks?: ArchiveHooks;
}

// ---------------------------------------------------------------- the archive folder

/** This host's archive folder: add files to it and read them back; never replace or remove one. */
interface Target {
	readonly label: string;
	/** Copy dir/<rel> for each rel to the archive; a file already there is left as it is. */
	put(dir: string, rels: readonly string[]): void;
	/** Copy each rel the archive holds into dir/<rel>; a missing one is skipped. */
	fetch(rels: readonly string[], dir: string): void;
}

function listFile(dir: string, rels: readonly string[]): string {
	for (const r of rels) if (!isArchiveRel(r)) throw new Error("not an archive path: " + r);
	const path = join(dir, ".files-" + randomBytes(4).toString("hex"));
	writeFileSync(path, rels.map((r) => r + "\n").join(""), { mode: 0o600, flag: "wx" });
	return path;
}

/**
 * rrsync's own message when its argument parser does not know an option the
 * forced command passes. rrsync gained -no-overwrite in rsync 3.3.0; the
 * rrsync of rsync 3.2.x (Debian 12, Ubuntu 24.04) stops here before rsync
 * starts, and the local rsync then reports only "protocol data stream (code 12)".
 */
const OLD_RRSYNC = /rrsync error: unrecognized arguments:.*-no-overwrite\b/;

/** --fsync, which the archive needs so a copy is on disk before the session is stubbed, came in rsync 3.2.4. */
const ARCHIVE_RSYNC_MIN: readonly [number, number, number] = [3, 2, 4];

/** Why the local rsync is too old for an archive run, or undefined. */
function oldArchiveRsync(run: ToolRunner): string | undefined {
	const v = run("rsync", ["--version"]);
	const m = /^rsync\s+version\s+v?(\d+)\.(\d+)\.(\d+)/m.exec(v.stdout);
	if (v.status !== 0 || m === null) return undefined;
	const have = [Number(m[1]), Number(m[2]), Number(m[3])];
	for (let i = 0; i < 3; i++) {
		const a = have[i] as number, b = ARCHIVE_RSYNC_MIN[i] as number;
		if (a !== b) return a > b ? undefined : `the rsync on PATH is version ${have.join(".")}; the archive needs rsync ${ARCHIVE_RSYNC_MIN.join(".")} or later for --fsync (macOS: brew install rsync)`;
	}
	return undefined;
}

/** checkRsync() for an archive run, naming an archive host whose rrsync is too old: like an old local rsync, that is exit 1, not a refusal. */
function checkArchiveRsync(store: ArchiveStore, run: ToolRunner, res: ToolResult): void {
	if (store.kind === "ssh" && res.status !== 0 && OLD_RRSYNC.test(res.stderr)) {
		throw new Error(`rsync failed: the rrsync on ${store.host} has no -no-overwrite option; it needs the rrsync of rsync 3.3.0 or later (see "Archive to another machine over SSH" in the README)`);
	}
	if (res.error === undefined && res.status !== 0) {
		const old = oldArchiveRsync(run);
		if (old !== undefined) throw new Error("rsync failed: " + old);
	}
	checkRsync(run, res);
}

const files = (n: number): string => String(n) + (n === 1 ? " file" : " files");

/** Run one rsync step; its failure says which step it was, how many files it carried and where. */
function rsyncStep(step: string, fn: () => void): void {
	try {
		fn();
	} catch (error) {
		const m = (error as Error).message;
		const prefix = "rsync failed: ";
		if (!m.startsWith(prefix)) throw error;
		throw new Error("rsync failed during the " + step + ": " + m.slice(prefix.length), { cause: error });
	}
}

function target(store: ArchiveStore, host: string, run: ToolRunner): Target {
	const common = ["-t", "--no-links", "--no-devices", "--no-specials", "--timeout=" + String(RSYNC_IO_TIMEOUT)];
	let remote: string;
	let ssh: string[] = [];
	let label: string;
	if (store.kind === "local") {
		// A volume that is not mounted leaves an empty mount point; never fill it.
		if (statSync(store.path, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Error(store.path + " does not exist; is the archive volume mounted?");
		remote = join(store.path, host) + "/";
		label = join(store.path, host);
	} else {
		// The key on the far side is forced to rrsync <archive>/<host>, so "./" is this host's folder there.
		const e = SSH_COMMAND + (store.identity === undefined ? "" : " -i " + store.identity + " -o IdentitiesOnly=yes");
		ssh = ["-e", e];
		remote = store.host + ":./";
		label = describeStore(store);
	}
	return {
		label,
		put(dir, rels) {
			if (rels.length === 0) return;
			if (store.kind === "local") mkdirSync(remote, { recursive: true, mode: 0o700 });
			const list = listFile(dirname(dir), rels);
			try {
				// --fsync: each copy is on the archive's disk, not only in its page
				// cache, before it is read back and the session is stubbed (L27).
				rsyncStep("upload of " + files(rels.length) + " to " + label, () => checkArchiveRsync(store, run, run("rsync", [...common, ...ssh, "--ignore-existing", "--fsync", "--chmod=D700,F600", "--files-from=" + list, "--", dir + "/", remote])));
			} finally {
				tidy(list);
			}
		},
		fetch(rels, dir) {
			if (rels.length === 0) return;
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const list = listFile(dirname(dir), rels);
			try {
				rsyncStep("read-back of " + files(rels.length) + " from " + label, () => checkArchiveRsync(store, run, run("rsync", [...common, ...ssh, "--ignore-missing-args", "--files-from=" + list, "--", remote, dir + "/"])));
			} finally {
				tidy(list);
			}
		},
	};
}

/** A scratch folder older than this was left by a run that was killed; a live run is stopped after 6 hours. */
const SCRATCH_STALE_MS = DAY_MS;

function scratch(l: Layout, now: number = Date.now()): string {
	const root = join(l.piHome, "pi-profile", "state", "archive");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	for (const e of readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !e.name.startsWith("run-")) continue;
		const st = lstatSync(join(root, e.name), { throwIfNoEntry: false });
		if (st !== undefined && now - st.mtimeMs > SCRATCH_STALE_MS) rmSync(join(root, e.name), { recursive: true, force: true });
	}
	return mkdtempSync(join(root, "run-"));
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** The bytes at dir/rel decompress to a file with this SHA-256 and size. */
function verifies(dir: string, rel: string, sha: string, size: number): Buffer | undefined {
	let packed: Buffer;
	try {
		packed = readFileSync(join(dir, rel));
	} catch {
		return undefined;
	}
	let full: Buffer;
	try {
		full = zstdDecompressSync(packed);
	} catch {
		return undefined;
	}
	return full.length === size && sha256(full) === sha ? full : undefined;
}

// ---------------------------------------------------------------- replacing a file in place

/**
 * Put tmp at path, but only while path is still the file with id expected.
 * The old file keeps a second name (aside) until the swap is checked: a line
 * Pi appends to the old file just before the rename lands in aside and is
 * found, so the old file is put back. An interrupted swap leaves aside, and
 * recover() puts it right on the next run.
 */
function swapIn(path: string, expected: string, tmp: string, hooks: ArchiveHooks): "done" | "changed" {
	const dir = dirname(path);
	const aside = join(dir, "." + basename(path) + ASIDE + randomBytes(6).toString("hex"));
	try {
		linkSync(path, aside);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "changed";
		throw error;
	}
	if (fileId(aside) !== expected) {
		tidy(aside);
		return "changed";
	}
	hooks.afterAside?.();
	const placed = fileId(tmp);
	renameSync(tmp, path);
	syncDir(dir);
	hooks.afterSwap?.();
	if (fileId(aside) === expected) {
		tidy(aside);
		syncDir(dir);
		return "done";
	}
	// The old file changed around the swap. Put it back, unless the new
	// file has changed too; then keep both under visible names.
	// The new file gets a second name first: Pi appends by path, so a line it
	// adds between the check and the rename lands in the new file, and that
	// name keeps it after the old file takes the path back.
	const extra = join(dir, "." + basename(path) + ASIDE + randomBytes(6).toString("hex"));
	let pinned = true;
	try {
		linkSync(path, extra);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		pinned = false;
	}
	if (!pinned) {
		if (!placeNoClobber(aside, path)) keepBoth(aside, path);
	} else if (fileId(extra) !== placed) {
		tidy(extra);
		keepBoth(aside, path);
	} else {
		hooks.beforePutBack?.();
		renameSync(aside, path);
		if (fileId(extra) === placed) tidy(extra);
		else keepBoth(extra, path);
	}
	syncDir(dir);
	return "changed";
}

/** The name a second copy of a session is kept under, beside it: <stem>.kept-<sha16>.jsonl. */
function keptName(path: string, sha: string): string {
	return join(dirname(path), basename(path, ".jsonl") + ".kept-" + sha.slice(0, 16) + ".jsonl");
}

function keepBoth(aside: string, path: string): string {
	const dest = keptName(path, sha256(readFileSync(aside)));
	if (!placeNoClobber(aside, dest)) tidy(aside);
	return dest;
}

/**
 * Write bytes to a new private temporary file beside path, with the given
 * time, and fsync it: it is renamed over a session, so its bytes must be on
 * disk before the rename makes the session's last full copy unreachable.
 */
function writeTemp(path: string, bytes: Buffer | string, mode: number, mtimeMs: number): string {
	const tmp = join(dirname(path), "." + basename(path) + MARK + randomBytes(6).toString("hex") + ".tmp");
	const fd = openSync(tmp, "wx", 0o600);
	try {
		const buf = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
		let off = 0;
		while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
		fchmodSync(fd, mode & 0o777);
		futimesSync(fd, mtimeMs / 1000, mtimeMs / 1000);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return tmp;
}

/**
 * Put right what an interrupted run left in a folder. A temporary file is
 * removed (it is a stub or a restored copy that can be made again). A full
 * session linked aside goes back to its name when that name is free, is
 * dropped when the name holds the same file or a stub of exactly this
 * session (whose archive copy was verified before the stub was placed), and
 * is otherwise kept beside it under a visible name. A stub left under a
 * second name (a run killed just after it put the full session back) is
 * dropped only when its bytes are the stub that run placed, by the hash the
 * archive list records, as the run would have dropped it: everything in it is
 * in that copy. A stub with any byte changed or added is kept like any other
 * file.
 */
function recover(store: string, folder: string, apply: boolean, sessions: Readonly<Record<string, ManifestEntry>>): ArchiveOutcome[] {
	const dir = join(store, folder);
	const out: ArchiveOutcome[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(".") || !name.includes(MARK)) continue;
		const path = join(dir, name);
		const st = lstatSync(path, { throwIfNoEntry: false });
		if (st?.isFile() !== true) continue;
		const at = name.indexOf(ASIDE);
		const base = at > 1 ? name.slice(1, at) : undefined;
		const rel = folder === "" ? (base ?? name) : folder + "/" + (base ?? name);
		out.push({ rel, kind: "recover", bytes: st.size });
		if (!apply) continue;
		if (base === undefined || !base.endsWith(".jsonl")) {
			tidy(path);
			continue;
		}
		const original = join(dir, base);
		const now = lstatSync(original, { throwIfNoEntry: false });
		if (now === undefined) {
			if (!placeNoClobber(path, original)) keepBoth(path, original);
			continue;
		}
		if (now.ino === st.ino && now.dev === st.dev) {
			tidy(path);
			continue;
		}
		const stub = now.isFile() ? readStubFile(original) : undefined;
		if (stub !== undefined && !stub.grown && stub.details.size === st.size && stub.details.sha256 === sha256(readFileSync(path))) tidy(path);
		else if (stub === undefined && now.isFile() && isPlacedStub(path, sessions[rel])) tidy(path);
		else keepBoth(path, original);
	}
	if (apply && out.length > 0) syncDir(dir);
	return out;
}

/**
 * Whether path holds exactly the bytes of the stub the run that wrote entry
 * placed: its SHA-256 is the one entry records, and it names the archived
 * copy entry records. Any other byte (a line added before or after the
 * notice, another notice) makes it another file. An entry written before the
 * hash was recorded matches nothing, so its leftover is kept.
 */
function isPlacedStub(path: string, entry: ManifestEntry | undefined): boolean {
	if (entry?.stubSha256 === undefined || sha256(readFileSync(path)) !== entry.stubSha256) return false;
	const stub = readStubFile(path);
	return stub !== undefined && stub.id === entry.id && stub.details.sha256 === entry.sha256 && stub.details.size === entry.size && stub.details.archive === entry.archive;
}

// ---------------------------------------------------------------- scan

interface Candidate {
	readonly rel: string;
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

/** Session folders of a store: the store itself (flat sessionDir) and each visible folder below it. */
function folders(store: string): string[] {
	const out = [""];
	for (const e of readdirSync(store, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) out.push(e.name);
	return out;
}

/** The forge key and path in the checkout of a session's folder, when it is a git checkout with an origin. */
function forgeOf(cwd: string, run: ToolRunner, cache: Map<string, { forgeKey?: string; repoPath?: string }>): { forgeKey?: string; repoPath?: string } {
	const hit = cache.get(cwd);
	if (hit !== undefined) return hit;
	let found: { forgeKey?: string; repoPath?: string } = {};
	if (isAbsolute(cwd) && statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true) {
		const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
		const url = run("git", ["-C", cwd, "config", "--get", "remote.origin.url"]);
		const key = url.status === 0 ? normalizeForgeKey(url.stdout.trim()) : undefined;
		if (top.status === 0 && top.stdout.trim() !== "") {
			const rel = relative(top.stdout.trim(), realpathSync(cwd)).split(sep).join("/");
			found = { ...(key === undefined ? {} : { forgeKey: key }), repoPath: rel === "" ? "." : rel };
		}
	}
	cache.set(cwd, found);
	return found;
}

function entryFor(f: SessionFacts, d: StubDetails, forge: { forgeKey?: string; repoPath?: string }, archivedAt: string): ManifestEntry {
	return {
		id: f.id, folder: f.cwd, created: f.created, modified: f.modified,
		...(f.name === undefined ? {} : { name: f.name }),
		...(f.firstPrompt === undefined ? {} : { firstPrompt: f.firstPrompt }),
		...(f.lastPrompt === undefined ? {} : { lastPrompt: f.lastPrompt }),
		...forge,
		size: d.size, mtimeMs: d.mtimeMs, sha256: d.sha256, host: d.host, archive: d.archive, archivedAt,
	};
}

/** The archive name of a session: its path with the SHA-256 prefix of its bytes, so a name never holds two contents. */
function archiveRel(rel: string, sha: string): string {
	return rel.slice(0, -".jsonl".length) + "." + sha.slice(0, 16) + ".jsonl.zst";
}

/** The first STUB_HEAD bytes of a file and its size, read without changing it; undefined when it cannot be read. */
function headOf(path: string): { bytes: Buffer; size: number } | undefined {
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	let fd: number;
	try {
		// O_NOATIME where the system has it, so a dry run leaves even the access time alone.
		fd = openSync(path, flags | (constants.O_NOATIME ?? 0));
	} catch {
		try {
			fd = openSync(path, flags);
		} catch {
			return undefined;
		}
	}
	try {
		const st = fstatSync(fd);
		return st.isFile() ? { bytes: readHead(fd, st.size), size: st.size } : undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

// ---------------------------------------------------------------- archive

/** Archive the sessions in store that have not changed for settings.olderThanDays. */
export function archiveSessions(l: Layout, storePath: string, settings: ArchiveSettings, opts: ArchiveOptions): ArchiveResult {
	if (!isAbsolute(storePath)) throw new Refusal("the session store must be an absolute path: " + storePath);
	if (statSync(storePath, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Refusal("not a session folder: " + storePath);
	const store = realpathSync(storePath);
	const now = opts.now ?? Date.now();
	const cutoff = now - settings.olderThanDays * DAY_MS;
	const keepMs = keepLocalDaysFor(settings, opts.platform ?? process.platform) * DAY_MS;
	const hooks = opts.hooks ?? {};
	const go = (): ArchiveResult => {
		const manifest = loadManifest(store);
		const sessions: Record<string, ManifestEntry> = { ...manifest.sessions };
		const outcomes: ArchiveOutcome[] = [];
		const candidates: Candidate[] = [];
		for (const folder of folders(store)) {
			outcomes.push(...recover(store, folder, opts.apply, sessions));
			const dir = join(store, folder);
			const names = readdirSync(dir);
			const owners = lockOwners(names);
			for (const name of names) {
				if (!name.endsWith(".jsonl") || name.startsWith(".") || isSecretName(name) || name === LOCK_FILE || KEPT.test(name)) continue;
				const rel = folder === "" ? name : folder + "/" + name;
				const path = join(dir, name);
				if (!isArchiveRel(archiveRel(rel, "0".repeat(64)))) {
					// A name rsync's file list cannot carry; it must not stop the run for every other session.
					outcomes.push({ rel, kind: "skip", bytes: 0, reason: "its name holds a character the archive does not take" });
					continue;
				}
				const st = lstatSync(path, { throwIfNoEntry: false });
				// olderThanDays is at least 1, so this also leaves every file changed in
				// the last RECENT_MS (10 minutes, the migrate rule) in place.
				if (st?.isFile() !== true || st.mtimeMs > cutoff) continue;
				const known = sessions[rel];
				// A restored session is a live session again: it waits olderThanDays from the restore, as from any other change.
				if (known?.restoredAt !== undefined && now < Date.parse(known.restoredAt) + settings.olderThanDays * DAY_MS) continue;
				if (known !== undefined && known.stubbedAt !== undefined && st.size < known.size) continue;
				if (known !== undefined && known.stubbedAt === undefined && known.size === st.size && known.mtimeMs === st.mtimeMs && now < Date.parse(known.archivedAt) + keepMs) continue;
				if (owners.has(name)) {
					outcomes.push({ rel, kind: "skip", bytes: st.size, reason: "a lock file beside it says a Pi process may hold it" });
					continue;
				}
				candidates.push({ rel, path, size: st.size, mtimeMs: st.mtimeMs });
			}
		}
		if (!opts.apply) {
			// What --apply would do, from metadata and the first lines of each file:
			// a stub (however much Pi has added to it) and a file that is no Pi
			// session are left alone, as --apply leaves them; a session whose keep
			// period is over (or that has none) is replaced by a stub; any other one
			// is archived with its local copy kept.
			const listed = candidates.flatMap((c): ArchiveOutcome[] => {
				const head = headOf(c.path);
				if (head !== undefined && readStubHead(head.bytes, head.size) !== undefined) return [];
				// A Pi session's header is its first line, so the head shows it.
				if (head !== undefined && sessionFacts(head.bytes.toString("utf8")) === undefined) return [{ rel: c.rel, kind: "skip", bytes: c.size, reason: "not a Pi session file" }];
				const known = sessions[c.rel];
				const archivedAt = known !== undefined && known.restoredAt === undefined && known.size === c.size && known.mtimeMs === c.mtimeMs ? Date.parse(known.archivedAt) : now;
				return [{ rel: c.rel, kind: now < archivedAt + keepMs ? "archive" : "stub", bytes: c.size }];
			});
			const freed = listed.reduce((n, o) => n + (o.kind === "stub" ? o.bytes : 0), 0);
			return { store, target: describeStore(settings.store), applied: false, outcomes: [...outcomes, ...listed], freed };
		}
		const t = target(settings.store, opts.host, opts.run);
		const work = scratch(l);
		let freed = 0;
		const forgeCache = new Map<string, { forgeKey?: string; repoPath?: string }>();
		try {
			let i = 0;
			while (i < candidates.length) {
				const batch: Array<{ c: Candidate; id: string; facts: SessionFacts; details: StubDetails; mode: number; stub: string }> = [];
				const at = new Date(now).toISOString();
				let bytes = 0;
				const up = join(work, "up");
				rmSync(up, { recursive: true, force: true });
				for (; i < candidates.length && (bytes < BATCH_BYTES || batch.length === 0); i++) {
					const c = candidates[i] as Candidate;
					const before = fileId(c.path);
					let full: Buffer;
					try {
						full = readFileSync(c.path);
					} catch (error) {
						outcomes.push({ rel: c.rel, kind: "fail", bytes: c.size, reason: (error as Error).message });
						continue;
					}
					if (before === undefined || fileId(c.path) !== before || full.length !== c.size) {
						outcomes.push({ rel: c.rel, kind: "skip", bytes: c.size, reason: "changed while it was read; run again later" });
						continue;
					}
					// A stub is known by its first lines, however much Pi has added to it: a
					// grown stub is never archived as a new session, so its manifest entry
					// keeps leading to the full session (L28).
					const stub = readStubHead(full.subarray(0, STUB_HEAD), full.length);
					if (stub !== undefined) {
						// Already archived. A manifest a killed run did not finish is completed from the stub.
						const e = sessions[c.rel];
						if (e !== undefined && e.sha256 === stub.details.sha256 && e.stubbedAt === undefined) sessions[c.rel] = { ...e, stubbedAt: new Date(now).toISOString() };
						continue;
					}
					const text = full.toString("utf8");
					const facts = sessionFacts(text);
					if (facts === undefined) {
						outcomes.push({ rel: c.rel, kind: "skip", bytes: c.size, reason: "not a Pi session file" });
						continue;
					}
					const sha = sha256(full);
					const rel = archiveRel(c.rel, sha);
					const packed = zstdCompressSync(full);
					mkdirSync(dirname(join(up, rel)), { recursive: true, mode: 0o700 });
					writeFileSync(join(up, rel), packed, { mode: 0o600 });
					bytes += packed.length;
					const mode = lstatSync(c.path).mode;
					const details: StubDetails = { schemaVersion: 1, sessionId: facts.id, host: opts.host, archive: rel, sha256: sha, size: full.length, mtimeMs: c.mtimeMs };
					batch.push({ c, id: before, facts, mode, details, stub: buildStub(facts, details, at) });
				}
				const rels = batch.map((b) => b.details.archive);
				t.put(up, rels);
				const back = join(work, "verify");
				rmSync(back, { recursive: true, force: true });
				t.fetch(rels, back);
				const verified = batch.filter((b) => verifies(back, b.details.archive, b.details.sha256, b.details.size) !== undefined);
				for (const b of batch) if (!verified.includes(b)) outcomes.push({ rel: b.c.rel, kind: "fail", bytes: b.c.size, reason: "the archive copy did not verify; the session is kept" });
				for (const b of verified) {
					const prior = sessions[b.c.rel];
					// Archived again after a restore: the keep period starts again too.
					const archivedAt = prior !== undefined && prior.sha256 === b.details.sha256 && prior.restoredAt === undefined ? prior.archivedAt : at;
					// The stub's hash is recorded before the stub is placed, so recover() can tell the stub this run placed from any other bytes.
					sessions[b.c.rel] = { ...entryFor(b.facts, b.details, forgeOf(b.facts.cwd, opts.run, forgeCache), archivedAt), stubSha256: sha256(Buffer.from(b.stub)) };
				}
				saveManifest(store, { schemaVersion: 1, sessions });
				rmSync(back, { recursive: true, force: true });
				rmSync(up, { recursive: true, force: true });
				hooks.afterVerify?.();
				for (const b of verified) {
					const entry = sessions[b.c.rel] as ManifestEntry;
					if (now < Date.parse(entry.archivedAt) + keepMs) {
						outcomes.push({ rel: b.c.rel, kind: "archive", bytes: b.c.size });
						continue;
					}
					hooks.beforeStub?.(b.c.rel);
					if (hasOwnLock(b.c.path)) {
						outcomes.push({ rel: b.c.rel, kind: "skip", bytes: b.c.size, reason: "a lock appeared beside it; the archive copy is kept, the session too" });
						continue;
					}
					if (fileId(b.c.path) !== b.id) {
						outcomes.push({ rel: b.c.rel, kind: "skip", bytes: b.c.size, reason: "changed after it was archived; the session is kept" });
						continue;
					}
					const tmp = writeTemp(b.c.path, b.stub, b.mode, b.c.mtimeMs);
					if (swapIn(b.c.path, b.id, tmp, hooks) === "changed") {
						tidy(tmp);
						outcomes.push({ rel: b.c.rel, kind: "skip", bytes: b.c.size, reason: "changed while the stub was placed; the session is kept" });
						continue;
					}
					sessions[b.c.rel] = { ...entry, stubbedAt: at };
					freed += b.c.size;
					outcomes.push({ rel: b.c.rel, kind: "stub", bytes: b.c.size });
				}
				saveManifest(store, { schemaVersion: 1, sessions });
			}
			if (candidates.length === 0 && JSON.stringify(sessions) !== JSON.stringify(manifest.sessions)) saveManifest(store, { schemaVersion: 1, sessions });
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		return { store, target: t.label, applied: true, outcomes, freed };
	};
	// A dry run takes no lock: it writes nothing, not even a lock file.
	return opts.apply ? withProfileLock(store, go) : go();
}

// ---------------------------------------------------------------- restore

export type RestoreKind = "restored" | "kept-both" | "not-archived";

export interface RestoreResult {
	readonly kind: RestoreKind;
	readonly path: string;
	/** For kept-both: where the full session was put, beside the stub that has new lines. */
	readonly full?: string;
	/** Set when the session was restored but a later step failed. */
	readonly warning?: string;
}

export interface RestoreOptions {
	readonly host: string;
	readonly run: ToolRunner;
	readonly now?: number;
	readonly hooks?: ArchiveHooks;
}

/** The store that holds a session file: the nearest of its folder and that folder's parent with a manifest. */
export function storeOf(path: string): string | undefined {
	const dir = dirname(path);
	for (const d of [dir, dirname(dir)]) if (statSync(manifestPath(d), { throwIfNoEntry: false })?.isFile() === true) return d;
	return undefined;
}

/**
 * Restore the archived session whose stub is at path. The stub is replaced
 * only while it is still the stub that was read and has no lines after the
 * archive notice; a stub Pi has added lines to stays, and the full session
 * is put beside it (<stem>.kept-<sha16>.jsonl), so neither copy is lost.
 */
export function restoreSession(l: Layout, path: string, settings: ArchiveSettings | undefined, opts: RestoreOptions): RestoreResult {
	if (!isAbsolute(path) || !path.endsWith(".jsonl")) throw new Refusal("not a session file path: " + path);
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (st?.isFile() !== true) throw new Refusal("no session file at " + path);
	// A stub is known by its first lines, whatever its size: one Pi has added a
	// lot to is still a stub, and its full session is still in the archive.
	if (readStubFile(path) === undefined) return { kind: "not-archived", path };
	const store = storeOf(path);
	const go = (): RestoreResult => {
		const id = fileId(path);
		const bytes = readFileSync(path);
		if (fileId(path) !== id || id === undefined) throw new Refusal(path + " changed while it was read; try again");
		const stub = readStubHead(bytes.subarray(0, STUB_HEAD), bytes.length);
		if (stub === undefined) return { kind: "not-archived", path };
		if (settings === undefined) throw new Refusal("no archive is set in config.json; see pi-profile help sessions archive");
		if (stub.details.host !== opts.host) throw new Refusal("this session was archived by host " + stub.details.host + ", not " + opts.host + "; restore it there");
		const work = scratch(l);
		try {
			const back = join(work, "verify");
			target(settings.store, opts.host, opts.run).fetch([stub.details.archive], back);
			const full = verifies(back, stub.details.archive, stub.details.sha256, stub.details.size);
			if (full === undefined) throw new Error("the archive copy of " + path + " is missing or does not verify; the stub is kept");
			const mode = st.mode;
			const tmp = writeTemp(path, full, mode, stub.details.mtimeMs);
			let kind: RestoreKind = "restored";
			let kept: string | undefined;
			if (stub.grown || swapIn(path, id, tmp, opts.hooks ?? {}) === "changed") {
				kept = keptName(path, stub.details.sha256);
				// A swap that met a change may have used tmp up; the full bytes are still here.
				const src = lstatSync(tmp, { throwIfNoEntry: false }) === undefined ? writeTemp(path, full, mode, stub.details.mtimeMs) : tmp;
				if (!placeNoClobber(src, kept)) tidy(src);
				kind = "kept-both";
			}
			// The file is back: from here on a failure is reported, never thrown,
			// so a caller does not take a done restore for a failed one.
			let warning: string | undefined;
			if (store !== undefined && kind === "restored") {
				try {
					const m = loadManifest(store);
					const rel = relative(store, path).split(sep).join("/");
					const e = m.sessions[rel];
					if (e !== undefined && e.sha256 === stub.details.sha256) {
						const { stubbedAt: _gone, ...rest } = e;
						void _gone;
						saveManifest(store, { schemaVersion: 1, sessions: { ...m.sessions, [rel]: { ...rest, restoredAt: new Date(opts.now ?? Date.now()).toISOString() } } });
					}
				} catch (error) {
					warning = "the session is restored, but the archive list could not be updated: " + (error as Error).message;
				}
			}
			return { kind, path, ...(kept === undefined ? {} : { full: kept }), ...(warning === undefined ? {} : { warning }) };
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	};
	return store === undefined ? go() : withProfileLock(store, go);
}

/** Find archived sessions by id (or a unique prefix of one) in these stores. */
export function findArchived(stores: readonly string[], id: string): string[] {
	const out: string[] = [];
	for (const store of stores) {
		for (const [rel, e] of Object.entries(loadManifest(store).sessions)) if (e.stubbedAt !== undefined && (e.id === id || e.id.startsWith(id))) out.push(join(store, rel));
	}
	return out;
}
