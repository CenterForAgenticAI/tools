import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, futimesSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, writeSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { check, failure, processToolRunner, removeRunDirs, rsyncBase, target, type Target, type ToolResult, type ToolRunner } from "./backup.ts";
import { loadConfig, type HostIdRunner } from "./config.ts";
import { withProfileLock } from "./lock.ts";
import { pullStateDir, realWithin, remoteDir, type Env, type Layout } from "./paths.ts";
import { encrypts, type Replica, type S3Replica } from "./replica.ts";
import { localHost, printable } from "./repo.ts";
import { Refusal } from "./result.ts";

export { pullStateDir, remoteDir } from "./paths.ts";

/** A host ID, as config.ts accepts it. */
const HOST_ID = /^[a-z0-9-]+$/;
/** rsync exit 23: some files could not be transferred. */
const RSYNC_PARTIAL = 23;
/** rsync exit 24: a source file vanished during the transfer. */
const RSYNC_VANISHED = 24;
/** rclone exit 3: the source directory does not exist (no host has backed up yet, or a wrong bucket, prefix or remote). */
const RCLONE_DIR_NOT_FOUND = 3;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
/** The longest name part a file system holds (NAME_MAX), in bytes. */
const NAME_MAX = 255;
/** A part of a key longer than NAME_MAX characters. aws and rclone patterns count characters, not bytes. */
const LONG_PART = `[!/]`.repeat(NAME_MAX + 1);
/** The temporary file place() writes before the rename: short, so any session name fits beside it. */
const TEMP_NAME = /^\.pull-[0-9a-f]{12}\.tmp$/;
/** A temporary file changed this recently may still be in use, so it is not a leftover. */
const TEMP_STALE_MS = 10 * 60 * 1000;
/** Names read from a download: bytes that are not UTF-8 are refused, not replaced. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Errors that mean a path is gone or is a link, which a pull never follows. */
const NOT_A_FILE = new Set(["ENOENT", "ELOOP", "ENOTDIR"]);

export interface PullOptions {
	/** Only this host's sessions. */
	readonly host?: string;
	/** The age identity file for an encrypted replica; else `pullIdentity` in config.json. */
	readonly identity?: string;
	readonly env?: Env;
	readonly runner?: ToolRunner;
	readonly hostRunner?: HostIdRunner;
	readonly hooks?: PullHooks;
}

export interface PullResult {
	readonly replica: string;
	/** Where the sessions are: `remote/<host>/sessions/<folder>/<name>.jsonl`. */
	readonly dir: string;
	/** Session files that were new or changed, relative to `dir`. */
	readonly updated: readonly string[];
	/** rsync's messages for session files the replica would not let it read; the rest were pulled. */
	readonly unreadable: readonly string[];
	/** Staged pulls: a download tool's failure, and session files that could not be decrypted or put in place; the rest were pulled. */
	readonly failed: readonly string[];
	/** Staged pulls: names that were skipped, such as a name that is not UTF-8. Printable, never the raw bytes. */
	readonly skipped: readonly string[];
}

/** Test seams for a staged pull. */
export interface PullHooks {
	/** Runs after a session is written to its temporary file, before the rename; it may throw. */
	readonly afterTempWrite?: (tmp: string) => void;
	/** The time the leftover sweep compares file times with, in ms; default now. */
	readonly now?: number;
	/** The user the leftover sweep treats as this one; default process.getuid(). */
	readonly uid?: number;
}

/**
 * The rsync filter for `hosts/`: each other host's
 * `<host>/sessions/<folder>/<name>.jsonl` (and `.jsonl.age` for an encrypted
 * replica), nothing else (law L11). This host's own subtree is never pulled:
 * its sessions are the ones in its store. Host folders that are not host IDs,
 * names with ASCII control characters, and names longer than 255 bytes (no
 * folder can hold them; rsync's `?` is one byte), stay behind. Other
 * unprintable names can still arrive; they are shown through printable().
 */
export function pullFilter(self: string, only?: string, encrypted = false): string[] {
	const hosts = only === undefined ? "/*/" : `/${only}/`;
	return [
		`--exclude=/${self}/`,
		"--exclude=/*[!a-z0-9-]*/",
		"--exclude=*[[:cntrl:]]*",
		"--exclude=.*",
		`--exclude=${"?".repeat(NAME_MAX + 1)}*`,
		`--include=${hosts}`,
		`--include=${hosts}sessions/`,
		`--include=${hosts}sessions/*/`,
		`--include=${hosts}sessions/*/*.jsonl`,
		...(encrypted ? [`--include=${hosts}sessions/*/*.jsonl.age`] : []),
		"--exclude=*",
	];
}

/**
 * `aws s3 cp` filters for `hosts/`, so other objects are never downloaded.
 * Later filters win. aws's `*` also matches `/`, so the local check in
 * stagedSessions() still decides the exact shape. A host folder that is not
 * a host ID is downloaded and then dropped: a pattern whose `*` crosses `/`
 * cannot single out the first part of a key. Excluded
 * last: this host, any key with a part that starts with a dot (a hidden
 * file, or `..`, which could climb out of the download folder), an empty
 * part or a leading `/`, ASCII control characters, a part longer than 255
 * characters (no folder can hold it), and deeper paths.
 */
export function awsPullFilter(self: string, only?: string, encrypted = false): string[] {
	const h = only ?? "*";
	const include = [`${h}/sessions/*/*.jsonl`, ...(encrypted ? [`${h}/sessions/*/*.jsonl.age`] : [])];
	const exclude = [`${self}/*`, ".*", "*/.*", "/*", "*//*", `*[${String.fromCharCode(1)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]*`, `*${LONG_PART}*`, "*/sessions/*/*/*"];
	return ["--exclude", "*", ...include.flatMap((p) => ["--include", p]), ...exclude.flatMap((p) => ["--exclude", p])];
}

/**
 * `rclone copy` filter rules for `hosts/`. The first matching rule wins and
 * rclone's `*` stops at `/`, so these give the exact shape: this host,
 * host folders that are not host IDs, hidden names, control characters and
 * parts longer than 255 characters are excluded before the sessions are
 * included. The length rule's group keeps its `}` apart from the closing `}}`.
 */
export function rclonePullFilter(self: string, only?: string, encrypted = false): string[] {
	const h = only ?? "*";
	const deny = [`/${self}/**`, "/*[!a-z0-9/-]*/**", "/**{{[\\x00-\\x1f\\x7f]}}**", `/**{{(?:[^/]{${String(NAME_MAX + 1)}})}}**`, ".*", ".*/**"];
	const rules = [...deny.map((p) => `- ${p}`), `+ /${h}/sessions/*/*.jsonl`, ...(encrypted ? [`+ /${h}/sessions/*/*.jsonl.age`] : []), "- **"];
	return rules.map((rule) => `--filter=${rule}`);
}

/** Over ssh, the receiver also reports the pipe the failed sender closed. */
const RECEIVER_BROKEN_PIPE = "rsync: [Receiver] write error: Broken pipe (32)";

/** Each error is a session file the sender could not open: the others were copied. */
function someUnreadable(r: ToolResult): string[] | undefined {
	if (r.status !== RSYNC_PARTIAL) return undefined;
	const errors = r.stderr.split("\n").filter((line) => line.startsWith("rsync: ") && line !== RECEIVER_BROKEN_PIPE);
	return errors.length > 0 && errors.every((line) => line.startsWith("rsync: [sender] send_files failed to open ")) ? errors.map(printable) : undefined;
}

/** rsync's sender could not enter `<dir>` because it does not exist (errno 2, in any language); nothing else. */
export function noSuchDir(r: ToolResult, dir: string): boolean {
	if (r.status !== RSYNC_PARTIAL) return false;
	const errors = r.stderr.split("\n").filter((line) => line.startsWith("rsync: ") && line !== RECEIVER_BROKEN_PIPE);
	const prefix = `rsync: [sender] change_dir "${dir}" failed: `;
	const [only, ...rest] = errors;
	return only !== undefined && rest.length === 0 && only.startsWith(prefix) && only.endsWith(" (2)");
}

/** age's binary header, and the first stanza of a passphrase-protected (scrypt) file: scrypt is always the only stanza. */
const AGE_SCRYPT = "age-encryption.org/v1\n-> scrypt ";
/** The ASCII armor age writes with `--armor`. */
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** The armor of an OpenSSH private key, and the magic its decoded body starts with. */
const OPENSSH_ARMOR = "-----BEGIN OPENSSH PRIVATE KEY-----"; // gitleaks:allow
const OPENSSH_MAGIC = "openssh-key-v1\0";
/** A PEM private key with a passphrase: an encrypted PKCS#8 block, or a legacy `Proc-Type` header. */
const PEM_ENCRYPTED = /-----BEGIN ENCRYPTED PRIVATE KEY-----|^Proc-Type:[ \t]*4,ENCRYPTED[ \t]*\r?$/m;

/** The bytes of the armored block that starts at `at` in `text`. */
function unarmor(text: string, at: number, armor: string): Buffer {
	const body = text.slice(at + armor.length).split("-----END")[0] ?? "";
	return Buffer.from(body.replace(/\s+/g, ""), "base64");
}

/** The cipher an openssh-key-v1 body names (a length-prefixed string after the magic), or undefined when it is not one. */
function opensshCipher(body: Buffer): string | undefined {
	const at = OPENSSH_MAGIC.length;
	if (body.length < at + 4 || body.toString("latin1", 0, at) !== OPENSSH_MAGIC) return undefined;
	const end = at + 4 + body.readUInt32BE(at);
	return end > body.length ? undefined : body.toString("latin1", at + 4, end);
}

/**
 * Whether the identity file is itself protected by a passphrase, and how: an
 * age scrypt file (binary or armored), or an SSH key (OpenSSH with a cipher
 * other than `none`, or encrypted PEM). age would ask for the passphrase on
 * the terminal, once for every file; a pull never asks, and age runs with no
 * terminal to ask on. The file is read once, its first 4 KiB, and none of it
 * is kept or shown.
 */
function passphraseProtected(fd: number): "age" | "ssh" | undefined {
	const head = Buffer.alloc(4096);
	const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("latin1");
	const start = text.search(/\S/);
	if (start >= 0 && text.startsWith(AGE_ARMOR, start)) return unarmor(text, start, AGE_ARMOR).toString("latin1").startsWith(AGE_SCRYPT) ? "age" : undefined;
	if (text.startsWith(AGE_SCRYPT)) return "age";
	const ssh = text.indexOf(OPENSSH_ARMOR);
	if (ssh >= 0) {
		const cipher = opensshCipher(unarmor(text, ssh, OPENSSH_ARMOR));
		return cipher !== undefined && cipher !== "none" ? "ssh" : undefined;
	}
	return PEM_ENCRYPTED.test(text) ? "ssh" : undefined;
}

const PASSPHRASE = "is protected by a passphrase, which a pull cannot ask for";
/** age's message when it needed a passphrase and had no terminal to read it from. */
const AGE_NO_PASSPHRASE = /could not read passphrase/;

/**
 * The age identity file for an encrypted replica: `--identity`, else
 * `pullIdentity` in config.json, never anything in a replica. No message
 * names the path, so it never reaches output or logs.
 */
function identityFile(r: Replica, given: string | undefined, replicas: readonly Replica[]): string {
	if (given === undefined) throw new Refusal(`replica ${r.id} is encrypted; give the age identity that decrypts it with --identity FILE, or set pullIdentity in config.json`);
	const path = resolve(given);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		throw new Refusal("cannot read the age identity file (--identity or pullIdentity)");
	}
	try {
		if (!fstatSync(fd).isFile()) throw new Refusal("the age identity (--identity or pullIdentity) is not a file");
		const kind = passphraseProtected(fd);
		if (kind === "age") throw new Refusal(`the age identity (--identity or pullIdentity) ${PASSPHRASE}; decrypt it to a file only you can read (age --decrypt -o FILE) and give that`);
		if (kind === "ssh") throw new Refusal(`the SSH identity (--identity or pullIdentity) ${PASSPHRASE}; remove the passphrase from a copy only you can read (ssh-keygen -p -f COPY) and give that`);
	} finally {
		closeSync(fd);
	}
	// A key kept beside the copies it protects would let whoever holds the disk read them.
	const holder = replicas.find((x) => x.kind === "local" && realWithin(path, x.path));
	if (holder !== undefined) throw new Refusal(`the age identity is inside replica ${holder.id}; keep it on this host, outside every replica`);
	return path;
}

/**
 * rsync other hosts' session files from a local or ssh replica into `dest`.
 * Undefined when no host has backed up to the repository yet.
 */
function rsyncHosts(r: Replica, t: Target, dest: string, filter: readonly string[], chmod: string, run: ToolRunner): ToolResult | undefined {
	const root = t.rsyncRoot ?? "";
	if (r.kind === "local") {
		const hosts = lstatSync(join(root, "hosts"), { throwIfNoEntry: false });
		if (hosts === undefined) {
			// No host has backed up yet, or this is an empty mount point (the disk is not mounted).
			if (lstatSync(join(root, "repository.json"), { throwIfNoEntry: false }) !== undefined) return undefined;
			throw new Error(`${root} has no hosts/ and no repository.json; is the disk mounted?`);
		}
		// A link could make another tree (this host's profiles, say) look like other hosts' sessions.
		if (!hosts.isDirectory()) throw new Refusal(`${join(root, "hosts")} is not a directory; it may be a link, which a pull does not follow`);
	}
	const args = [...rsyncBase(r, true, chmod), "--prune-empty-dirs", "--out-format=%n", ...filter, "--", `${root}/hosts/`, `${dest}/`];
	const res = run("rsync", args);
	const path = root.slice(root.indexOf(":") + 1);
	if (r.kind === "ssh" && noSuchDir(res, `${path}/hosts`)) {
		// No host has backed up yet, or the repository itself is gone (an unmounted disk): tell them apart.
		const probe = run("rsync", [...rsyncBase(r, false), "--list-only", "--", `${root}/repository.json`]);
		if (probe.status === 0 && probe.error === undefined) return undefined;
		throw new Error(`${r.id}: no repository.json in ${root}; is the disk mounted?`);
	}
	return res;
}

/** aws s3 ls exit 1 with nothing on stderr: no object has that prefix. */
const AWS_NONE = 1;

/**
 * Whether `root` holds a repository a backup wrote to: some
 * `hosts/<host>/host.json`. A backup to s3 writes no `repository.json` at the
 * root (only `repo advertise` makes one, for a folder), so `host.json` is the
 * marker. Without it, nothing was ever backed up there, or the bucket,
 * prefix or remote is wrong; the two look the same from outside.
 */
function hasHostMarker(r: S3Replica, root: string, run: ToolRunner): boolean {
	if (r.tool === "rclone") {
		const res = run("rclone", ["lsf", "--files-only", "-R", "--max-depth", "2", "--include", "/*/host.json", "--", `${root}/hosts`]);
		if (res.error === undefined && res.status === RCLONE_DIR_NOT_FOUND) return false;
		check(res, "rclone lsf");
		return res.stdout.split("\n").some((line) => /^[a-z0-9-]+\/host\.json$/.test(line));
	}
	const list = (prefix: string): string[] => {
		const res = run("aws", ["s3", "ls", prefix]);
		if (res.error === undefined && res.status === AWS_NONE && res.stderr.trim() === "") return [];
		check(res, "aws s3 ls");
		return res.stdout.split("\n");
	};
	const hosts = list(`${root}/hosts/`).flatMap((line) => /^\s*PRE ([a-z0-9-]+)\/$/.exec(line)?.[1] ?? []);
	return hosts.some((h) => list(`${root}/hosts/${h}/host.json`).some((line) => line.endsWith(" host.json")));
}

/** Whether a folder has nothing in it. */
function empty(dir: string): boolean {
	return readdirSync(dir).length === 0;
}

/**
 * Download other hosts' session objects from an s3 replica into `dest`,
 * filtered by the tool. A tool that fails part-way (aws exits 1 when any one
 * object fails; rclone exits 1 after copying the rest) still leaves the other
 * objects, so its failure is returned, printable, for the pull to report
 * after it places them. A tool that cannot run at all throws.
 */
function downloadObjects(r: S3Replica, t: Target, dest: string, filter: { self: string; only: string | undefined; encrypted: boolean }, run: ToolRunner): string | undefined {
	const root = t.objectRoot ?? "";
	const src = `${root}/hosts`;
	const what = r.tool === "rclone" ? "rclone copy" : "aws s3 cp";
	const res =
		r.tool === "rclone"
			? run("rclone", ["copy", ...rclonePullFilter(filter.self, filter.only, filter.encrypted), "--", src, dest])
			: run("aws", ["s3", "cp", "--recursive", "--only-show-errors", ...awsPullFilter(filter.self, filter.only, filter.encrypted), `${src}/`, `${dest}/`]);
	if (res.error !== undefined || res.status === null) throw new Error(failure(res, what));
	const none = new Error(`${r.id}: no hosts/<host>/host.json at ${printable(root)}; nothing has been backed up there, or the bucket, prefix or remote is wrong`);
	// rclone exit 3: there is no hosts/ at all, so no backup wrote there.
	if (r.tool === "rclone" && res.status === RCLONE_DIR_NOT_FOUND) throw none;
	// Nothing downloaded: no other host's sessions yet, or nothing there at all.
	if (res.status === 0 && empty(dest) && !hasHostMarker(r, root, run)) throw none;
	return res.status === 0 ? undefined : failure(res, what);
}

/** One session file found in a download: `rel` is where it goes under the remote directory. */
export interface StagedSession {
	/** `<host>/sessions/<folder>/<name>.jsonl`. */
	readonly rel: string;
	readonly src: string;
	readonly encrypted: boolean;
}

/** What a download holds: the session files, and printable notes on names skipped. */
export interface StagedDownload {
	readonly sessions: readonly StagedSession[];
	readonly skipped: readonly string[];
}

/** A name a pull accepts: no leading dot (so not `.` or `..`), no control or format characters, no separator. */
function plainName(name: string): boolean {
	return name.length > 0 && !name.startsWith(".") && !UNPRINTABLE.test(name) && !name.includes("/") && !name.includes("\\");
}

/** A folder's entries, names as bytes; none when it is gone or not a folder. */
function entries(dir: string): Array<Dirent<Buffer>> {
	try {
		return readdirSync(dir, { withFileTypes: true, encoding: "buffer" });
	} catch (error) {
		if (NOT_A_FILE.has((error as NodeJS.ErrnoException).code ?? "")) return [];
		throw error;
	}
}

/** A name as text, or undefined when its bytes are not UTF-8 (so no text names the same file). */
function utf8(name: Buffer): string | undefined {
	try {
		return UTF8.decode(name);
	} catch {
		return undefined;
	}
}

/**
 * Of two copies of one session, the one to keep, in whichever order they are
 * found: the encrypted copy wins, since it was written after encryption was
 * turned on; otherwise the first.
 */
export function keepCopy(seen: StagedSession | undefined, next: StagedSession): StagedSession {
	return seen === undefined || (next.encrypted && !seen.encrypted) ? next : seen;
}

/**
 * The session files in a download, checked whatever the tool let through:
 * `<host>/sessions/<folder>/<name>.jsonl`, and `<name>.jsonl.age` when
 * `encrypted`, for host folders that are host IDs other than `self` (and
 * `only`, when given). Real folders and regular files only; links, hidden
 * names, names with control characters, deeper paths and anything else stay
 * behind (law L11). Names are read as bytes: a folder or session name that
 * is not UTF-8 is skipped and noted, without its bytes. Where both
 * `<name>.jsonl` and `<name>.jsonl.age` exist, the encrypted copy wins: it
 * was written after encryption was turned on.
 */
export function stagedSessions(root: string, self: string, only: string | undefined, encrypted: boolean): StagedDownload {
	const found = new Map<string, StagedSession>();
	const skipped: string[] = [];
	const session = (name: Buffer): boolean => {
		const text = name.toString("latin1");
		return text.endsWith(".jsonl") || (encrypted && text.endsWith(".jsonl.age"));
	};
	for (const h of entries(root)) {
		const host = utf8(h.name);
		if (!h.isDirectory() || host === undefined || !HOST_ID.test(host) || host === self || (only !== undefined && host !== only)) continue;
		const sessions = join(root, host, "sessions");
		if (lstatSync(sessions, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
		for (const d of entries(sessions)) {
			const folder = utf8(d.name);
			if (d.isDirectory() && folder === undefined) skipped.push(`${host}/sessions: a folder whose name is not UTF-8 was skipped`);
			if (!d.isDirectory() || folder === undefined || !plainName(folder)) continue;
			for (const f of entries(join(sessions, folder))) {
				const file = utf8(f.name);
				if (f.isFile() && file === undefined && session(f.name)) skipped.push(`${host}/sessions/${printable(folder)}: a session whose name is not UTF-8 was skipped`);
				if (!f.isFile() || file === undefined || !plainName(file)) continue;
				const sealed = encrypted && file.endsWith(".jsonl.age");
				if (!sealed && !file.endsWith(".jsonl")) continue;
				const name = sealed ? file.slice(0, -".age".length) : file;
				const rel = `${host}/sessions/${folder}/${name}`;
				found.set(rel, keepCopy(found.get(rel), { rel, src: join(sessions, folder, file), encrypted: sealed }));
			}
		}
	}
	return { sessions: [...found.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)), skipped };
}

/** Open a regular file without following a link; undefined if it is gone, a link or not a file. */
function openFile(path: string): { fd: number; size: number; mtimeMs: number } | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (NOT_A_FILE.has((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
	const st = fstatSync(fd);
	if (!st.isFile()) {
		closeSync(fd);
		return undefined;
	}
	return { fd, size: st.size, mtimeMs: st.mtimeMs };
}

/** Whether the open file and the regular file at `path` hold the same bytes. */
function sameBytes(fd: number, size: number, path: string): boolean {
	const other = openFile(path);
	if (other === undefined) return false;
	try {
		if (other.size !== size) return false;
		const a = Buffer.allocUnsafe(1024 * 1024);
		const b = Buffer.allocUnsafe(1024 * 1024);
		for (let pos = 0; pos < size; ) {
			const n = readSync(fd, a, 0, a.length, pos);
			const m = readSync(other.fd, b, 0, n, pos);
			if (n === 0 || m !== n || !a.subarray(0, n).equals(b.subarray(0, n))) return false;
			pos += n;
		}
		return true;
	} finally {
		closeSync(other.fd);
	}
}

/**
 * A failure, without the absolute paths a system error quotes: the caller
 * names the session by its path relative to the remote directory.
 */
function reason(error: unknown): string {
	const e = error as NodeJS.ErrnoException;
	if (typeof e.code === "string" && typeof e.syscall === "string") return `${e.message.split(`, ${e.syscall}`)[0] ?? e.code} (${e.syscall})`;
	return e.message;
}

/** Make a folder of the remote tree, or check that it is a real folder: a pull never writes through a link. `rel` names it in a message. */
function realDir(path: string, rel: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (lstatSync(path).isDirectory() !== true) throw new Error(`${rel} is not a directory; a pull does not write through links`);
}

/**
 * The folder `<dir>/<host>/sessions/<folder>` a session in `rel` goes to,
 * each folder on the way made or checked to be a real folder.
 */
function destFolder(dir: string, rel: string): string {
	const [host = "", , folder = ""] = rel.split("/");
	realDir(join(dir, host), host);
	realDir(join(dir, host, "sessions"), `${host}/sessions`);
	const path = join(dir, host, "sessions", folder);
	realDir(path, `${host}/sessions/${folder}`);
	return path;
}

/** The real folders in `dir`, by name; a link is never followed. */
function subfolders(dir: string): string[] {
	return entries(dir).flatMap((e) => {
		const name = utf8(e.name);
		return e.isDirectory() && name !== undefined ? [join(dir, name)] : [];
	});
}

/**
 * Remove the `.pull-<hex>.tmp` files a killed pull left in every
 * `<host>/sessions/<folder>` of the remote tree `dir`, whether or not a
 * session lands there this run. Called holding the `remote/` lock, so no pull
 * is writing them. A leftover is a regular file with exactly that name, owned
 * by this user, and unchanged for TEMP_STALE_MS; a link is never followed,
 * neither as a file nor as a folder on the way.
 */
function sweepTemps(dir: string, hooks: PullHooks): void {
	const now = hooks.now ?? Date.now();
	const uid = hooks.uid ?? process.getuid?.();
	for (const host of subfolders(dir)) {
		const sessions = join(host, "sessions");
		if (lstatSync(sessions, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
		for (const folder of subfolders(sessions)) {
			for (const e of entries(folder)) {
				const name = utf8(e.name);
				if (!e.isFile() || name === undefined || !TEMP_NAME.test(name)) continue;
				const path = join(folder, name);
				const st = lstatSync(path, { throwIfNoEntry: false });
				if (st?.isFile() !== true || (uid !== undefined && st.uid !== uid) || now - st.mtimeMs < TEMP_STALE_MS) continue;
				// rmSync removes a name, never what a link points at.
				rmSync(path, { force: true });
			}
		}
	}
}

/**
 * Put one session at `<folder>/<name>`, read-only, as rsync would: a new or
 * changed copy replaces the old one through a rename, an identical one is
 * left alone, and nothing is removed. `folder` comes from destFolder(). The
 * temporary file has a short name (`.pull-<hex>.tmp`), so a session name of
 * up to 255 bytes fits, and it is removed on any error. Returns whether the
 * copy changed.
 */
function place(folder: string, name: string, src: string, mtimeMs: number, hooks: PullHooks): boolean {
	const dest = join(folder, name);
	const from = openFile(src);
	if (from === undefined) throw new Error("not a regular file");
	try {
		if (sameBytes(from.fd, from.size, dest)) return false;
		const tmp = join(folder, `.pull-${randomBytes(6).toString("hex")}.tmp`);
		const w = openSync(tmp, "wx", 0o600);
		try {
			try {
				const buf = Buffer.allocUnsafe(1024 * 1024);
				for (let pos = 0, n = readSync(from.fd, buf, 0, buf.length, pos); n > 0; pos += n, n = readSync(from.fd, buf, 0, buf.length, pos)) writeSync(w, buf, 0, n);
				hooks.afterTempWrite?.(tmp);
				futimesSync(w, mtimeMs / 1000, mtimeMs / 1000);
				// A pulled session is for reading and forking, not for writing in place.
				fchmodSync(w, 0o400);
			} finally {
				closeSync(w);
			}
			renameSync(tmp, dest);
		} catch (error) {
			// A failed write (a full disk, say) leaves no part of a session behind.
			rmSync(tmp, { force: true });
			throw error;
		}
		return true;
	} finally {
		closeSync(from.fd);
	}
}

/**
 * Decrypt one `.jsonl.age` file to `out` with `age --decrypt -i IDENTITY`.
 * The file goes to age's stdin, opened without following a link, and age
 * runs with no controlling terminal, so it can never stop to ask for a
 * passphrase. Returns an error message, or undefined. age's own messages are
 * not passed on: they can quote the identity file. A failed decrypt leaves
 * no partial plaintext behind.
 */
function decrypt(src: string, out: string, identity: string, run: ToolRunner): string | undefined {
	const from = openFile(src);
	if (from === undefined) return "not a regular file";
	try {
		mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
		const r = run("age", ["--decrypt", "-i", identity, "-o", out], { stdin: from.fd, noTerminal: true });
		if (r.error !== undefined) throw new Error(r.error === "age is not installed" ? "age is not installed; it is needed to read an encrypted replica" : "age could not be started");
		if (r.status === 0) return undefined;
		rmSync(out, { force: true });
		// The checks in identityFile() missed a passphrase: refuse with its cause, not "wrong recipient".
		if (AGE_NO_PASSPHRASE.test(r.stderr)) throw new Refusal(`the identity (--identity or pullIdentity) ${PASSPHRASE}; give a copy without one, only you can read`);
		return `age could not decrypt it (exit ${String(r.status)}); is the identity one of the replica's recipients?`;
	} finally {
		closeSync(from.fd);
	}
}

/**
 * s3 and encrypted replicas: download into a private folder under
 * `state/pull/`, keep only the session files stagedSessions() accepts,
 * decrypt `.jsonl.age` files, and put each in the remote tree with place().
 * A download tool that failed part-way, and a file that will not decrypt or
 * cannot be placed, are reported; the others are still pulled. The download
 * folder is removed afterwards.
 */
function stagedPull(l: Layout, r: Replica, t: Target, dir: string, who: { self: string; only: string | undefined }, identity: string | undefined, run: ToolRunner, hooks: PullHooks = {}): PullResult {
	const encrypted = identity !== undefined;
	const state = pullStateDir(l);
	mkdirSync(state, { recursive: true, mode: 0o700 });
	removeRunDirs(state, r.id);
	const scratch = mkdtempSync(join(state, `${r.id}.run-`));
	try {
		const download = join(scratch, "download");
		mkdirSync(download, { mode: 0o700 });
		let unreadable: string[] = [];
		const failed: string[] = [];
		if (r.kind === "s3") {
			const tool = downloadObjects(r, t, download, { self: who.self, only: who.only, encrypted }, run);
			if (tool !== undefined) failed.push(tool);
		} else {
			const res = rsyncHosts(r, t, download, pullFilter(who.self, who.only, encrypted), "D700,F600", run);
			if (res !== undefined) {
				unreadable = someUnreadable(res) ?? [];
				if (unreadable.length === 0) check(res, "rsync", [0, RSYNC_VANISHED]);
			}
		}
		const updated: string[] = [];
		const plain = join(scratch, "plain");
		const found = stagedSessions(download, who.self, who.only, encrypted);
		for (const s of found.sessions) {
			// The downloaded file's time (the object's, for s3), also for the copy decrypted from it.
			const mtimeMs = lstatSync(s.src, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
			let src = s.src;
			if (s.encrypted) {
				src = join(plain, s.rel);
				const error = decrypt(s.src, src, identity ?? "", run);
				if (error !== undefined) {
					failed.push(`${printable(s.rel)}.age: ${error}`);
					continue;
				}
			}
			try {
				const folder = destFolder(dir, s.rel);
				if (place(folder, s.rel.slice(s.rel.lastIndexOf("/") + 1), src, mtimeMs, hooks)) updated.push(printable(s.rel));
			} catch (error) {
				failed.push(`${printable(s.rel)}: ${printable(reason(error))}`);
			} finally {
				if (s.encrypted) rmSync(src, { force: true });
			}
		}
		return { replica: r.id, dir, updated, unreadable, failed, skipped: [...found.skipped] };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Copy the sessions other hosts backed up to a replica into
 * `~/.pi/pi-profile/remote/<host>/`, so this device can browse them and fork
 * one (the fork is this host's, law L7). A pull only reads the replica. The
 * cache cannot become a session store or a migration source, so pulled
 * sessions are never backed up as this host's (law L6). New files are
 * read-only; a pull replaces changed copies and never removes a file.
 * Plain local and ssh replicas are rsynced straight into the cache; s3 and
 * encrypted replicas are staged first (see stagedPull()).
 */
export function pullSessions(l: Layout, replicaId: string, opts: PullOptions = {}): PullResult {
	const env = opts.env ?? process.env;
	const c = loadConfig(l, env);
	const r = (c.replicas ?? []).find((x) => x.id === replicaId);
	if (r === undefined) throw new Refusal(`replica does not exist: ${replicaId}`);
	const self = localHost(l, env, opts.hostRunner);
	const only = opts.host?.toLowerCase();
	if (only !== undefined) {
		if (!HOST_ID.test(only)) throw new Refusal(`invalid host ID: ${opts.host ?? ""}`);
		if (only === self) throw new Refusal(`${only} is this host; its sessions are already here`);
	}
	const encrypted = encrypts(r.kind, r.encrypt);
	const identity = encrypted ? identityFile(r, opts.identity ?? c.pullIdentity, c.replicas ?? []) : undefined;
	const run = opts.runner ?? processToolRunner;
	const dir = remoteDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withProfileLock(dir, () => {
		// Under the lock, so no pull is writing what this removes.
		sweepTemps(dir, opts.hooks ?? {});
		const t = target(r, undefined, run);
		if (r.kind === "s3" || encrypted) return stagedPull(l, r, t, dir, { self, only }, identity, run, opts.hooks);
		// F400: a pulled session is for reading and forking, not for writing in place.
		const res = rsyncHosts(r, t, dir, pullFilter(self, only), "D700,F400", run);
		if (res === undefined) return { replica: r.id, dir, updated: [], unreadable: [], failed: [], skipped: [] };
		const unreadable = someUnreadable(res) ?? [];
		if (unreadable.length === 0) check(res, "rsync", [0, RSYNC_VANISHED]);
		const updated = res.stdout.split("\n").filter((line) => line.endsWith(".jsonl")).map(printable);
		return { replica: r.id, dir, updated, unreadable, failed: [], skipped: [] };
	});
}
