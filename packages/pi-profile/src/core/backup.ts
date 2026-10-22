import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, futimesSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadManifest, type ManifestEntry } from "./archivemanifest.ts";
import { isSecretName } from "./auth.ts";
import { loadConfig, updateConfig, type HostIdRunner, type MachineConfig } from "./config.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { LockBusy, withProfileLock } from "./lock.ts";
import { overlapsPulled, pullStateDir, remoteDir, type Env, type Layout } from "./paths.ts";
import { encrypts, parseReplica, type Replica, type SshReplica } from "./replica.ts";
import { localHost, parseAdvertised, printable, sshArgs } from "./repo.ts";
import { Refusal } from "./result.ts";
import { readStubFd } from "./sessionfile.ts";

/** What one external tool run returned. */
export interface ToolResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}
/**
 * Runs an external CLI with an argument array and no shell; tests replace it.
 * `stdin` is an open file descriptor. `noTerminal` runs the tool in a new
 * session, with no controlling terminal, so it cannot open `/dev/tty` to ask
 * for anything (such as an age passphrase).
 */
export type ToolRunner = (command: string, args: readonly string[], opts?: { readonly stdin?: number; readonly noTerminal?: boolean }) => ToolResult;

/**
 * The folder a tool runs in: this process's, unless that folder has been
 * removed. rsync reads its working folder before anything else and stops
 * with "errors selecting input/output files, dirs (code 3)" when it is gone;
 * every path pi-profile passes a tool is absolute, so / is as good.
 */
function toolCwd(): string | undefined {
	try {
		// Node keeps the folder's name after it is removed; "." still opens the removed folder itself.
		const here = statSync(".");
		const named = statSync(process.cwd(), { throwIfNoEntry: false });
		return here.nlink === 0 || named === undefined || named.dev !== here.dev || named.ino !== here.ino ? "/" : undefined;
	} catch {
		return "/";
	}
}

export const processToolRunner: ToolRunner = (command, args, opts) => {
	const cwd = toolCwd();
	// spawnSync honours `detached` as spawn does (setsid() on POSIX), though @types/node omits it.
	const options: SpawnSyncOptionsWithStringEncoding & { readonly detached: boolean } = { encoding: "utf8", stdio: [opts?.stdin ?? "ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, detached: opts?.noTerminal === true, ...(cwd === undefined ? {} : { cwd }) };
	const r = spawnSync(command, [...args], options);
	const error = r.error === undefined ? undefined : (r.error as NodeJS.ErrnoException).code === "ENOENT" ? `${command} is not installed` : r.error.message;
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(error === undefined ? {} : { error }) };
};

/** ssh options for every backup connection: no prompts, a bounded connect, a dead link noticed in a minute. */
export const SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4";
/** rsync gives up after this many seconds with no data moving. */
const RSYNC_IO_TIMEOUT = 600;
/** Plaintext bytes encrypted or copied before each upload, so progress is saved as it goes. */
export const BATCH_BYTES = 256 * 1024 * 1024;
/** rsync exit 24: a source file vanished during the transfer (a deleted session). */
const RSYNC_VANISHED = 24;
/** Characters pi-profile will pass to a remote shell in an rsync path. */
// No spaces or shell characters: an older rsync on either side passes the path through the remote shell.
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/@+,=-]*$/;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- config

export function addReplica(l: Layout, raw: Record<string, unknown>, env?: Env, runner?: HostIdRunner): MachineConfig {
	const replica = parseReplica(raw);
	return updateConfig(l, (c) => {
		const list = c.replicas ?? [];
		if (list.some((r) => r.id === replica.id)) throw new Refusal(`replica already exists: ${replica.id}`);
		return { ...c, replicas: [...list, replica] };
	}, env, runner);
}

export function removeReplica(l: Layout, id: string, env?: Env): MachineConfig {
	// Under the backup lock, so a run in progress cannot save the state again,
	// and the pull lock (on remote/), so no pull of it is using its run folders.
	const remote = remoteDir(l);
	mkdirSync(remote, { recursive: true, mode: 0o700 });
	return withBackupLock(l, () =>
		withProfileLock(remote, () => {
			const next = updateConfig(l, (c) => {
				const list = c.replicas ?? [];
				if (!list.some((r) => r.id === id)) throw new Refusal(`replica does not exist: ${id}`);
				return { ...c, replicas: list.filter((r) => r.id !== id) };
			}, env);
			rmSync(statePath(l, id), { force: true });
			removeRunDirs(backupStateDir(l), id);
			// A killed pull's run folder can hold decrypted copies of other hosts' sessions.
			removeRunDirs(pullStateDir(l), id);
			return next;
		}),
	);
}

/** A one-line description of where a replica writes. */
export function describeReplica(r: Replica): string {
	const where = r.kind === "local" ? r.path : r.kind === "ssh" ? `${r.host}:${r.repository}` : `${r.uri} (${r.tool}${r.kind === "s3" && r.remote !== undefined ? ` remote ${r.remote}` : ""})`;
	return `${r.kind}\t${where}\t${encrypts(r.kind, r.encrypt) ? "encrypted" : "not encrypted"}`;
}

// ---------------------------------------------------------------- state

/** `~/.pi/pi-profile/state/backup`: machine-local, never replicated (law L10). */
export function backupStateDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "backup");
}
function statePath(l: Layout, id: string): string {
	return join(backupStateDir(l), `${id}.json`);
}

/**
 * One backup run, or replica removal, at a time per machine. Only a busy
 * backup lock is reported as another run; a busy lock taken inside `fn`
 * (such as the config lock) keeps its own message.
 */
function withBackupLock<T>(l: Layout, fn: () => T): T {
	const dir = resolve(backupStateDir(l));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		return withProfileLock(dir, fn);
	} catch (error) {
		if (error instanceof LockBusy && error.dir === dir) {
			const who = error.pid === undefined ? "" : ` (process ${String(error.pid)})`;
			throw new Refusal(`another backup run is in progress${who}; try again when it finishes`, { cause: error });
		}
		throw error;
	}
}

/** mkdtemp's suffix: six letters or digits. */
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

/**
 * Remove the `<id>.run-XXXXXX` scratch folders in `dir` that an interrupted
 * run left behind (a crash or Ctrl-C skips the cleanup). A backup's hard links would
 * keep deleted sessions on disk; a pull's can hold decrypted sessions. Call it
 * holding the lock of the runs that use `dir`: the backup lock for
 * `state/backup`, the `remote/` lock for `state/pull`, so no run is using them. Only direct children of the state directory with exactly that
 * name are removed, and only real folders: a link with such a name is left
 * alone and never followed.
 */
export function removeRunDirs(dir: string, id: string): void {
	const prefix = `${id}.run-`;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !MKDTEMP_SUFFIX.test(entry.slice(prefix.length))) continue;
		const path = join(dir, entry);
		if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
		// rmSync removes links inside the folder without following them.
		rmSync(path, { recursive: true, force: true });
	}
}

interface Mark {
	readonly size: number;
	readonly mtimeMs: number;
}
/**
 * What a replica was last sent: the run times and, for staged replicas, each
 * file's size and mtime as sent under `fingerprint`. `sizes` is the size of
 * the copy each replica file holds at the target named by `target`, and
 * `mtimes` the mtime that copy was sent with. They are kept across a change
 * of `fingerprint` alone, so a session that shrank is still held back after
 * the recipients change, and an archived session's stub is still known to
 * have its archived copy there; both are forgotten when the target changes,
 * so the new target gets every session.
 */
export interface ReplicaState {
	readonly schemaVersion: 1;
	readonly lastRunAt?: string;
	readonly lastOkAt?: string;
	readonly lastError?: string;
	readonly fingerprint?: string;
	readonly files?: Readonly<Record<string, Mark>>;
	readonly sizes?: Readonly<Record<string, number>>;
	readonly mtimes?: Readonly<Record<string, number>>;
	readonly target?: string;
}

export function loadReplicaState(l: Layout, id: string): ReplicaState {
	let raw: unknown;
	try {
		raw = readJson(statePath(l, id));
	} catch {
		raw = undefined;
	}
	if (!record(raw) || raw.schemaVersion !== 1) return { schemaVersion: 1 };
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const files: Record<string, Mark> = {};
	if (record(raw.files)) {
		for (const [rel, m] of Object.entries(raw.files)) {
			if (record(m) && typeof m.size === "number" && typeof m.mtimeMs === "number") files[rel] = { size: m.size, mtimeMs: m.mtimeMs };
		}
	}
	const out: Record<string, unknown> = { schemaVersion: 1, files };
	for (const k of ["sizes", "mtimes"] as const) {
		const v = raw[k];
		if (!record(v)) continue;
		const nums: Record<string, number> = {};
		for (const [rel, n] of Object.entries(v)) if (typeof n === "number") nums[rel] = n;
		out[k] = nums;
	}
	for (const k of ["lastRunAt", "lastOkAt", "lastError", "fingerprint", "target"] as const) {
		const v = str(raw[k]);
		if (v !== undefined) out[k] = v;
	}
	return out as unknown as ReplicaState;
}

function saveState(l: Layout, id: string, state: ReplicaState): void {
	mkdirSync(backupStateDir(l), { recursive: true, mode: 0o700 });
	writeJsonAtomic(statePath(l, id), state);
}

// ---------------------------------------------------------------- source

/** One session file in the primary store, relative to its root. */
export interface SessionFile {
	readonly rel: string;
	readonly size: number;
	readonly mtimeMs: number;
	/**
	 * The scanned file's identity: a staged copy reads only this file. A file
	 * that reuses a deleted session's inode keeps dev and ino, so size, mtime
	 * and birth time must match too (issue 25).
	 */
	readonly dev: number;
	readonly ino: number;
	/** 0 where the platform reports no birth time; see `birthOf`. */
	readonly birthtimeMs: number;
}

/**
 * A file's birth time, or 0 where the platform reports none. Where there is
 * none, libuv reports 0 or the change time, which a hard link moves, so a
 * birth time equal to the change time is not trusted.
 */
export function birthOf(st: { readonly birthtimeMs: number; readonly ctimeMs: number }): number {
	return st.birthtimeMs === st.ctimeMs ? 0 : st.birthtimeMs;
}

/** Whether an opened file still is the scanned session: same identity, size, mtime and (where known) birth time. */
function sameSession(st: Stats, f: SessionFile): boolean {
	return st.isFile() && st.dev === f.dev && st.ino === f.ino && st.size === f.size && st.mtimeMs === f.mtimeMs && (f.birthtimeMs === 0 || st.birthtimeMs === f.birthtimeMs);
}

/**
 * The session files in a store: `<folder>/<name>.jsonl`, regular files only.
 * Anything else in the store (hidden files, links, other names, deeper
 * paths) stays on this host: an unclassified path never leaves (law L11).
 */
export function sessionFiles(root: string): { files: SessionFile[]; skipped: number } {
	const files: SessionFile[] = [];
	let skipped = 0;
	const ok = (name: string): boolean => !name.startsWith(".") && !UNPRINTABLE.test(name);
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory() || !ok(dir.name)) continue;
		for (const f of readdirSync(join(root, dir.name), { withFileTypes: true })) {
			if (!f.isFile() || !f.name.endsWith(".jsonl") || isSecretName(f.name)) continue;
			if (!ok(f.name)) {
				skipped++;
				continue;
			}
			const st = lstatSync(join(root, dir.name, f.name), { throwIfNoEntry: false });
			if (st?.isFile() !== true) continue;
			files.push({ rel: `${dir.name}/${f.name}`, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino, birthtimeMs: birthOf(st) });
		}
	}
	return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), skipped };
}

/** The store a backup reads: `--store`, else the default store, else the only one. */
export function sourceStore(c: MachineConfig, id?: string): { id: string; path: string } {
	const pick = id ?? c.defaultSessionStore ?? (Object.keys(c.sessionStores).length === 1 ? Object.keys(c.sessionStores)[0] : undefined);
	if (pick === undefined) {
		throw new Refusal(Object.keys(c.sessionStores).length === 0 ? "no session store to back up; add one with: pi-profile sessions store add ID PATH" : "several session stores; choose one with --store ID");
	}
	const store = c.sessionStores[pick];
	if (store === undefined) throw new Refusal(`session store does not exist: ${pick}`);
	return { id: pick, path: resolve(store.path) };
}

function inside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

// ---------------------------------------------------------------- targets

/** Where one host's subtree is, for each kind. Only `hosts/<hostId>/` is written (law L6). */
export interface Target {
	/** rsync destination prefix (local path or `host:path`), for local and ssh. */
	readonly rsyncRoot?: string;
	/** The s3 URI or rclone remote path of the repository root, for s3. */
	readonly objectRoot?: string;
}

/** The tool's last message, printable: aws and rclone quote object keys, which can hold any character. */
function lastLine(r: ToolResult, what: string): string {
	return printable(r.error ?? (r.stderr.trim().split("\n").pop() || `${what} exited ${String(r.status)}`));
}

/** `<what> failed: <the tool's last message>`, printable. */
export function failure(r: ToolResult, what: string): string {
	return `${what} failed: ${lastLine(r, what)}`;
}

export function check(r: ToolResult, what: string, allowed: readonly number[] = [0]): void {
	if (r.error !== undefined || r.status === null || !allowed.includes(r.status)) throw new Error(failure(r, what));
}

/** The path of an advertised repository on a peer, read over SSH like `repo discover`. */
function remoteRepository(r: SshReplica, run: ToolRunner): string {
	const res = run("ssh", sshArgs(r.host));
	check(res, `ssh ${r.host}`);
	let parsed;
	try {
		parsed = res.stdout.trim() === "" ? { repositories: {} } : parseAdvertised(JSON.parse(res.stdout) as unknown);
	} catch (error) {
		throw new Error(`${r.host}: ${error instanceof Refusal ? error.message : "advertised.json is not valid JSON"}`, { cause: error });
	}
	const repo = (parsed.repositories as Record<string, { path: string } | undefined>)[r.repository];
	if (repo === undefined) throw new Error(`${r.host} does not advertise repository ${r.repository}`);
	if (!SAFE_REMOTE_PATH.test(repo.path)) throw new Error(`${r.host}: repository ${r.repository} has a path pi-profile will not pass to a remote shell`);
	return repo.path;
}

/** Where a replica's repository is. `store`, when given, is the session store a backup reads. */
export function target(r: Replica, store: string | undefined, run: ToolRunner): Target {
	switch (r.kind) {
		case "local": {
			const path = resolve(r.path);
			// A disk that is not mounted leaves an empty mount point; never fill it.
			if (statSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Error(`${path} does not exist; is the disk mounted?`);
			if (store !== undefined && (inside(path, store) || inside(store, path))) throw new Refusal(`replica ${r.id} overlaps the session store ${store}`);
			return { rsyncRoot: path };
		}
		case "ssh":
			return { rsyncRoot: `${r.host}:${remoteRepository(r, run)}` };
		case "s3":
			return { objectRoot: r.tool === "aws" ? r.uri : `${r.remote ?? "s3"}:${r.uri.slice("s3://".length)}` };
	}
}

/** The oldest rsync pi-profile works with: `--chmod` and `--append-verify` need 3.1. */
const RSYNC_MIN: readonly [number, number] = [3, 1];

/**
 * Why the rsync on PATH cannot run what pi-profile asks of it, or undefined if
 * it can or its version line is not recognised. macOS ships openrsync as
 * `/usr/bin/rsync`, which has no `--chmod` and no `--append-verify`.
 */
export function unsupportedRsync(run: ToolRunner): string | undefined {
	const v = run("rsync", ["--version"]);
	if (v.error !== undefined || v.status !== 0) return undefined;
	const fix = `install rsync ${RSYNC_MIN.join(".")} or later and put it first on PATH (macOS: brew install rsync)`;
	if (/^openrsync\b/m.test(v.stdout)) return `the rsync on PATH is openrsync, which has no --chmod or --append-verify; ${fix}`;
	const m = /^rsync\s+version\s+v?(\d+)\.(\d+)/m.exec(v.stdout);
	if (m === null) return undefined;
	const major = Number(m[1]);
	const minor = Number(m[2]);
	if (major > RSYNC_MIN[0] || (major === RSYNC_MIN[0] && minor >= RSYNC_MIN[1])) return undefined;
	return `the rsync on PATH is version ${String(major)}.${String(minor)}; ${fix}`;
}

/**
 * check() for an rsync run. On a failure it asks the local rsync for its
 * version, so a missing option reads as "install rsync 3.1" rather than as
 * rsync's own usage error. A run that succeeded costs nothing extra.
 */
export function checkRsync(run: ToolRunner, res: ToolResult, allowed: readonly number[] = [0]): void {
	if (res.error === undefined && res.status !== null && allowed.includes(res.status)) return;
	const why = res.error === undefined ? unsupportedRsync(run) : undefined;
	if (why !== undefined) throw new Error(`rsync failed: ${why}`);
	check(res, "rsync", allowed);
}

export function rsyncBase(r: Replica, recursive: boolean, chmod = "D700,F600"): string[] {
	// No links, devices or specials: only regular session files leave the host.
	// The session list is sent without -r, so a listed name that became a
	// directory is created empty rather than copied.
	const base = [recursive ? "-rt" : "-t", "--no-links", "--no-devices", "--no-specials", `--chmod=${chmod}`, `--timeout=${String(RSYNC_IO_TIMEOUT)}`];
	return r.kind === "ssh" ? [...base, "-e", SSH_COMMAND] : base;
}

/** Make `hosts/<hostId>/sessions/` at the target; rsync creates only the last directory itself. */
function makeSubtree(r: Replica, t: Target, host: string, scratch: string, run: ToolRunner): void {
	if (t.rsyncRoot === undefined) return;
	const skel = join(scratch, "skeleton");
	mkdirSync(join(skel, host, "sessions"), { recursive: true });
	// --omit-dir-times: the shared hosts/ directory is not this host's to touch (law L6).
	checkRsync(run, run("rsync", [...rsyncBase(r, true), "--omit-dir-times", "--", `${skel}/`, `${t.rsyncRoot}/hosts/`]));
}

/** Upload a directory tree of files under `hosts/<hostId>/<under>`. */
function upload(r: Replica, t: Target, from: string, host: string, under: string, run: ToolRunner): void {
	if (t.rsyncRoot !== undefined) {
		checkRsync(run, run("rsync", [...rsyncBase(r, true), "--", `${from}/`, `${t.rsyncRoot}/hosts/${host}/${under}`]));
		return;
	}
	const dest = `${t.objectRoot ?? ""}/hosts/${host}/${under}`;
	if (r.kind === "s3" && r.tool === "rclone") check(run("rclone", ["copy", "--", from, dest]), "rclone copy");
	else check(run("aws", ["s3", "cp", "--recursive", "--no-follow-symlinks", "--only-show-errors", `${from}/`, dest]), "aws s3 cp");
}

// ---------------------------------------------------------------- run

export interface BackupOptions {
	readonly replica?: string;
	readonly store?: string;
	readonly env?: Env;
	readonly runner?: ToolRunner;
	readonly hostRunner?: HostIdRunner;
	readonly now?: () => Date;
	readonly batchBytes?: number;
	/** Staged replicas: resend every file, as if the replica were empty. */
	readonly full?: boolean;
	/** Test seam: stats an opened session (default fstatSync), to simulate a reused inode. */
	readonly fstat?: Fstat;
}

/** How an opened session is stat-ed. */
export type Fstat = (fd: number) => Stats;

export type BackupResult =
	| {
			readonly id: string;
			readonly ok: true;
			readonly mode: "rsync" | "staged";
			readonly files: number;
			readonly bytes: number;
			readonly encrypted: boolean;
			/** Sessions not sent because they are smaller than the copy already there. */
			readonly held: readonly string[];
	  }
	| { readonly id: string; readonly ok: false; readonly error: string };

function where(r: Replica): string {
	return r.kind === "local" ? r.path : r.kind === "ssh" ? `${r.host}:${r.repository}` : `${r.tool}:${r.remote ?? ""}:${r.uri}`;
}
/** What was sent and how: a change resends everything. */
function fingerprint(r: Replica, host: string): string {
	const recipients = r.encrypt === undefined || r.encrypt === false ? [] : [...r.encrypt.recipients].sort();
	return createHash("sha256").update(JSON.stringify([r.kind, where(r), host, encrypts(r.kind, r.encrypt), recipients])).digest("hex");
}
/** Where it was sent, without the recipients: a change forgets the sizes of the copies there. */
function targetFingerprint(r: Replica, host: string): string {
	return createHash("sha256").update(JSON.stringify([r.kind, where(r), host])).digest("hex");
}

/** link() errors after which the session is copied instead: another file system, or no hard links there. */
const NO_HARD_LINK = new Set(["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EOPNOTSUPP"]);
/** Errors that mean a scanned session is gone or is no longer a file under a folder. */
const GONE = new Set(["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"]);

/**
 * Stage one scanned session as a hard link in `send`, kept only if, opened
 * there without following a link, it is the regular file the scan saw.
 * Nothing can change the private scratch tree after the check, so rsync reads
 * only scanned files, even if a session or its folder is swapped for a link
 * meanwhile (laws L8, L11). Returns the bytes staged, undefined if the
 * session is gone or was replaced, or "copy" if a hard link is impossible
 * (the scratch directory is on another file system).
 */
function stageLink(store: string, f: SessionFile, send: string, fstat: Fstat): number | "copy" | undefined {
	const out = join(send, f.rel);
	mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
	try {
		linkSync(join(store, f.rel), out);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (GONE.has(code)) return undefined;
		if (NO_HARD_LINK.has(code)) return "copy";
		throw error;
	}
	const src = openSession(send, f, fstat);
	if (src === undefined) {
		// Deleted or replaced since the scan: not sent, as rsync's exit 24.
		unlinkSync(out);
		return undefined;
	}
	closeSync(src.fd);
	return src.size;
}

/**
 * Copy one scanned session into `send` from the store, opened and checked
 * there, with its mtime so rsync's checks see the same file. Returns the
 * bytes copied, or undefined if the session is gone or was replaced.
 */
function stageCopy(store: string, f: SessionFile, send: string, fstat: Fstat): number | undefined {
	const src = openSession(store, f, fstat);
	if (src === undefined) return undefined;
	try {
		const out = join(send, f.rel);
		mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
		copyFd(src.fd, out, src.mtimeMs);
	} finally {
		closeSync(src.fd);
	}
	return src.size;
}

/**
 * Plain local and ssh replicas: rsync with an exact list of session files,
 * sent from a staged tree of the scanned files. `--append-verify` sends only
 * what a growing session added, and resends a file whose existing part does
 * not match. Hard links cost no space, so every linked session goes in one
 * rsync. Sessions that must be copied (another file system) are sent in
 * batches of `batchBytes`, each removed once sent, so the scratch directory
 * never holds more than one batch.
 */
function runRsync(r: Replica, t: Target, store: string, files: readonly SessionFile[], host: string, opts: { run: ToolRunner; batchBytes: number; scratch: string; fstat: Fstat }): { files: number; bytes: number } {
	let sent = 0;
	let bytes = 0;
	let n = 0;
	const send = (dir: string, rels: readonly string[]): void => {
		const list = join(opts.scratch, "files");
		writeFileSync(list, rels.map((rel) => `${rel}\0`).join(""), { mode: 0o600 });
		const args = [...rsyncBase(r, false), "--append-verify", "--from0", `--files-from=${list}`, "--", `${dir}/`, `${t.rsyncRoot ?? ""}/hosts/${host}/sessions/`];
		checkRsync(opts.run, opts.run("rsync", args), [0, RSYNC_VANISHED]);
		rmSync(list, { force: true });
		sent += rels.length;
	};
	const fresh = (): string => {
		const dir = join(opts.scratch, `send-${String(n++)}`);
		mkdirSync(dir, { mode: 0o700 });
		return dir;
	};
	const links = fresh();
	const linked: string[] = [];
	const toCopy: SessionFile[] = [];
	for (const f of files) {
		const got = stageLink(store, f, links, opts.fstat);
		if (got === "copy") toCopy.push(f);
		else if (got !== undefined) {
			linked.push(f.rel);
			bytes += got;
		}
	}
	// One rsync even with nothing to send, as before, unless copies follow.
	if (linked.length > 0 || toCopy.length === 0) send(links, linked);
	rmSync(links, { recursive: true, force: true });
	for (let i = 0; i < toCopy.length; ) {
		const batch: SessionFile[] = [];
		let size = 0;
		while (i < toCopy.length && (batch.length === 0 || size + (toCopy[i]?.size ?? 0) <= opts.batchBytes)) {
			const f = toCopy[i++] as SessionFile;
			batch.push(f);
			size += f.size;
		}
		const dir = fresh();
		const copied: string[] = [];
		for (const f of batch) {
			const got = stageCopy(store, f, dir, opts.fstat);
			if (got === undefined) continue;
			copied.push(f.rel);
			bytes += got;
		}
		if (copied.length > 0) send(dir, copied);
		rmSync(dir, { recursive: true, force: true });
	}
	return { files: sent, bytes };
}

/**
 * Open a scanned session under `root` for reading, or undefined if it is
 * gone or is no longer the file that was scanned (replaced by a link, a
 * directory, a FIFO or another file). Only the scanned regular file is ever
 * read (laws L8, L11). O_NONBLOCK keeps a FIFO swapped in from blocking the
 * open; it does not change how a regular file is read.
 */
function openSession(root: string, f: SessionFile, fstat: Fstat): { fd: number; size: number; mtimeMs: number } | undefined {
	let fd: number;
	try {
		fd = openSync(join(root, f.rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (GONE.has((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
	const st = fstat(fd);
	if (!sameSession(st, f)) {
		closeSync(fd);
		return undefined;
	}
	return { fd, size: st.size, mtimeMs: st.mtimeMs };
}

/** Copy an open file to a new file `out`, and give the copy `mtimeMs` when it is given. */
function copyFd(fd: number, out: string, mtimeMs?: number): void {
	const w = openSync(out, "wx", 0o600);
	try {
		const buf = Buffer.allocUnsafe(1024 * 1024);
		for (let pos = 0, n = readSync(fd, buf, 0, buf.length, pos); n > 0; pos += n, n = readSync(fd, buf, 0, buf.length, pos)) writeSync(w, buf, 0, n);
		if (mtimeMs !== undefined) futimesSync(w, mtimeMs / 1000, mtimeMs / 1000);
	} finally {
		closeSync(w);
	}
}

/** The store's archive list; none when it cannot be read, so every smaller session is reported. */
function archivedSessions(store: string): Readonly<Record<string, ManifestEntry>> {
	try {
		return loadManifest(store).sessions;
	} catch {
		return {};
	}
}

/**
 * Whether a scanned session is the stub the archive left for it, over a
 * replica copy that is the archived one: the archive list says it was
 * replaced by a stub; the copy at this replica has the archived size (`size`)
 * and was sent with the archived mtime (`mtimeMs`), whatever the recipients
 * were then; and the file is
 * that stub, naming the same archived copy, with no lines added since. Lines
 * Pi added to a stub, or to the session after the replica's copy was sent,
 * are in no replica copy, so such a stub is still reported.
 */
function isArchivedStub(store: string, f: SessionFile, entry: ManifestEntry | undefined, mtimeMs: number | undefined, size: number | undefined, fstat: Fstat): boolean {
	if (entry?.stubbedAt === undefined) return false;
	if (size !== entry.size || mtimeMs !== entry.mtimeMs) return false;
	const src = openSession(store, f, fstat);
	if (src === undefined) return false;
	try {
		const stub = readStubFd(src.fd, src.size);
		return stub !== undefined && !stub.grown && stub.details.sha256 === entry.sha256 && stub.details.size === entry.size && stub.details.archive === entry.archive;
	} catch {
		return false;
	} finally {
		closeSync(src.fd);
	}
}

/**
 * Encrypted replicas, and every s3 replica: send only files whose size or
 * mtime changed since the last run, in batches staged under the state
 * directory. An encrypted file is replaced whole, never appended to, so a
 * session smaller than the copy already sent is held back: a truncated or
 * damaged session never replaces a good copy.
 */
function runStaged(
	l: Layout,
	r: Replica,
	t: Target,
	store: string,
	files: readonly SessionFile[],
	host: string,
	state: ReplicaState,
	opts: { run: ToolRunner; batchBytes: number; scratch: string; full: boolean; fstat: Fstat },
): { files: number; bytes: number; held: string[] } {
	const encrypted = encrypts(r.kind, r.encrypt);
	const fp = fingerprint(r, host);
	const sent0: Readonly<Record<string, Mark>> = state.fingerprint === fp ? (state.files ?? {}) : {};
	const marks: Record<string, Mark> = opts.full ? {} : { ...sent0 };
	// The size of each copy already at this target, whatever the fingerprint
	// was then. State saved before `target` existed (by an older version)
	// cannot say where its copies are, so, as that version did, its marks are
	// trusted only under the same fingerprint.
	const tfp = targetFingerprint(r, host);
	const sameTarget = state.target === undefined ? state.fingerprint === fp : state.target === tfp;
	const sizes: Record<string, number> = sameTarget ? { ...(state.sizes ?? Object.fromEntries(Object.entries(state.files ?? {}).map(([rel, m]) => [rel, m.size]))) } : {};
	// The mtime each copy at this target was sent with, kept like its size. State
	// saved before `mtimes` existed has them only for the files sent under its
	// last fingerprint.
	const mtimes: Record<string, number> = sameTarget ? { ...(state.mtimes ?? Object.fromEntries(Object.entries(state.files ?? {}).map(([rel, m]) => [rel, m.mtimeMs]))) } : {};
	// Forget a session only when it is gone from the store, not when it was swapped mid-run.
	const present = new Set(files.map((f) => f.rel));
	for (const rel of Object.keys(marks)) if (!present.has(rel)) delete marks[rel];
	for (const rel of Object.keys(sizes)) if (!present.has(rel)) delete sizes[rel];
	for (const rel of Object.keys(mtimes)) if (!present.has(rel)) delete mtimes[rel];
	const held: string[] = [];
	const archived = archivedSessions(store);
	const changed = files.filter((f) => {
		const floor = sizes[f.rel];
		if (floor !== undefined && f.size < floor) {
			// An archived session's stub is meant to be smaller: when the replica has the archived copy, no warning.
			if (!isArchivedStub(store, f, archived[f.rel], mtimes[f.rel], floor, opts.fstat)) held.push(f.rel);
			const before = sent0[f.rel];
			if (before !== undefined) marks[f.rel] = before;
			return false;
		}
		return marks[f.rel]?.size !== f.size || marks[f.rel]?.mtimeMs !== f.mtimeMs;
	});
	const recipients = r.encrypt === undefined || r.encrypt === false ? [] : r.encrypt.recipients;
	let sent = 0;
	let bytes = 0;
	for (let i = 0; i < changed.length; ) {
		const stage = mkdtempSync(join(opts.scratch, "stage-"));
		const batch: SessionFile[] = [];
		let size = 0;
		while (i < changed.length && (batch.length === 0 || size + (changed[i]?.size ?? 0) <= opts.batchBytes)) {
			const f = changed[i++] as SessionFile;
			batch.push(f);
			size += f.size;
		}
		const staged: Array<[string, Mark]> = [];
		for (const f of batch) {
			const src = openSession(store, f, opts.fstat);
			if (src === undefined) {
				// Deleted or replaced since the scan: not sent, as rsync's exit 24.
				// Its mark and size stay, so a smaller replacement is held back next
				// run; the next scan drops them if the session is really gone.
				continue;
			}
			try {
				const out = join(stage, encrypted ? `${f.rel}.age` : f.rel);
				mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
				if (encrypted) check(opts.run("age", ["--encrypt", ...recipients.flatMap((x) => ["-r", x]), "-o", out], { stdin: src.fd }), "age");
				else copyFd(src.fd, out);
			} finally {
				closeSync(src.fd);
			}
			// The size and mtime when opened: a session that grows while it is copied is sent again next time.
			staged.push([f.rel, { size: src.size, mtimeMs: src.mtimeMs }]);
			bytes += src.size;
		}
		if (staged.length > 0) upload(r, t, stage, host, "sessions", opts.run);
		rmSync(stage, { recursive: true, force: true });
		for (const [rel, mark] of staged) {
			marks[rel] = mark;
			sizes[rel] = mark.size;
			mtimes[rel] = mark.mtimeMs;
		}
		sent += staged.length;
		saveState(l, r.id, { ...state, fingerprint: fp, target: tfp, files: marks, sizes, mtimes });
	}
	saveState(l, r.id, { ...state, fingerprint: fp, target: tfp, files: marks, sizes, mtimes });
	return { files: sent, bytes, held };
}

function version(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

function backupOne(l: Layout, r: Replica, store: string, host: string, scan: { files: SessionFile[] }, opts: Required<Pick<BackupOptions, "runner" | "now" | "batchBytes" | "full" | "fstat">>): BackupResult {
	const started = opts.now().toISOString();
	const state = loadReplicaState(l, r.id);
	mkdirSync(backupStateDir(l), { recursive: true, mode: 0o700 });
	removeRunDirs(backupStateDir(l), r.id);
	const scratch = mkdtempSync(join(backupStateDir(l), `${r.id}.run-`));
	try {
		const t = target(r, store, opts.runner);
		makeSubtree(r, t, host, scratch, opts.runner);
		const encrypted = encrypts(r.kind, r.encrypt);
		let result: BackupResult;
		if (!encrypted && r.kind !== "s3") {
			const sent = runRsync(r, t, store, scan.files, host, { run: opts.runner, batchBytes: opts.batchBytes, scratch, fstat: opts.fstat });
			result = { id: r.id, ok: true, mode: "rsync", ...sent, encrypted, held: [] };
		} else {
			const sent = runStaged(l, r, t, store, scan.files, host, state, { run: opts.runner, batchBytes: opts.batchBytes, scratch, full: opts.full, fstat: opts.fstat });
			result = { id: r.id, ok: true, mode: "staged", ...sent, encrypted };
		}
		const meta = join(scratch, "meta");
		mkdirSync(meta);
		const finished = opts.now().toISOString();
		writeFileSync(join(meta, "host.json"), `${JSON.stringify({ schemaVersion: 1, hostId: host, lastBackupAt: finished, piProfileVersion: version(), encrypted }, null, "\t")}\n`, { mode: 0o600 });
		upload(r, t, meta, host, "", opts.runner);
		const after = loadReplicaState(l, r.id);
		const ok: Record<string, unknown> = { ...after, lastRunAt: started, lastOkAt: finished };
		delete ok.lastError;
		saveState(l, r.id, ok as unknown as ReplicaState);
		return result;
	} catch (error) {
		const message = printable((error as Error).message);
		saveState(l, r.id, { ...loadReplicaState(l, r.id), lastRunAt: started, lastError: message });
		return { id: r.id, ok: false, error: message };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Copy this host's session files to each replica (or one, with `replica`),
 * under `hosts/<hostId>/sessions/`. One run at a time per machine. A replica
 * that fails is reported and the others still run. Backups never delete:
 * a session removed here stays in its replicas.
 */
export function runBackup(l: Layout, opts: BackupOptions = {}): BackupResult[] {
	const env = opts.env ?? process.env;
	const c = loadConfig(l, env);
	const all = c.replicas ?? [];
	if (all.length === 0) throw new Refusal("no replicas; add one with: pi-profile backup add");
	const chosen = opts.replica === undefined ? all : all.filter((r) => r.id === opts.replica);
	if (chosen.length === 0) throw new Refusal(`replica does not exist: ${opts.replica ?? ""}`);
	const store = sourceStore(c, opts.store);
	if (statSync(store.path, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Refusal(`session store ${store.id} does not exist: ${store.path}`);
	// A store that holds credentials (auth.json or a backup of it, L8) is a profile directory, not a session store.
	const secret = readdirSync(store.path).find(isSecretName);
	if (secret !== undefined) throw new Refusal(`session store ${store.id} contains ${secret === "auth.json" ? "auth.json" : "a backup of auth.json"}; it is not a session store`);
	const state = resolve(join(l.piHome, "pi-profile", "state"));
	if (inside(state, store.path)) throw new Refusal(`session store ${store.id} contains pi-profile's state directory`);
	// Other hosts' sessions are theirs; backing them up here would claim them (laws L6, L7).
	if (overlapsPulled(l, store.path)) throw new Refusal(`session store ${store.id} overlaps the pulled sessions in ${remoteDir(l)}`);
	const host = localHost(l, env, opts.hostRunner);
	return withBackupLock(l, () => {
		const scan = sessionFiles(store.path);
		const run = { runner: opts.runner ?? processToolRunner, now: opts.now ?? (() => new Date()), batchBytes: opts.batchBytes ?? BATCH_BYTES, full: opts.full ?? false, fstat: opts.fstat ?? ((fd: number): Stats => fstatSync(fd)) };
		return chosen.map((r) => backupOne(l, r, store.path, host, scan, run));
	});
}
