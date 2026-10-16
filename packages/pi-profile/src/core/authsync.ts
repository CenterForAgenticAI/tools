import { spawnSync } from "node:child_process";
import { isatty } from "node:tty";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { authPath, inspectAuth } from "./auth.ts";
import { stamp } from "./fsutil.ts";
import { clearBreakerIfUnchanged, withProfileLock } from "./lock.ts";
import type { AuthMode } from "./manifest.ts";
import { DEFAULT_PROFILE } from "./names.ts";
import { profileDir, sharedAuthPath, type Env, type Layout } from "./paths.ts";
import { listProfiles, loadProfile } from "./profiles.ts";
import { HOST_LABEL } from "./replica.ts";
import { printable } from "./repo.ts";
import { Refusal } from "./result.ts";
import { uniqueSibling } from "./swap.ts";

/**
 * Cross-device auth (design: "Cross-device auth"). Entries of `auth.json`
 * move between your own devices only over `ssh <tailnet host>`, as JSON on
 * stdin and stdout; never in argv, a log, a backup or config sync (L8, L9, L12).
 */

/** A provider key in auth.json, such as `anthropic` or `github-copilot`. */
export const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An extra OAuth field, such as `accountId` or `enterpriseUrl`. */
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** The largest payload `auth receive` reads from stdin, and `auth pull` accepts from a peer. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 4 * MAX_PAYLOAD_BYTES;
const MAX_ENTRIES = 256;
const MAX_EXTRA = 32;
const MAX_TEXT = 64 * 1024;
const OAUTH_NAMED = new Set(["type", "refresh", "access", "expires"]);
/**
 * Pi's own stale time for `auth.json.lock`: `acquireLockAsync` in Pi's
 * auth-storage.js passes `stale: 30_000` (its sync lock uses proper-lockfile's
 * 10 s default). A live holder refreshes the lock's mtime every stale / 2.
 */
export const PI_LOCK_STALE_MS = 30_000;
/** pi-profile breaks a lock only when it is older than Pi's stale time plus one more refresh interval. */
export const PI_LOCK_BREAK_MS = PI_LOCK_STALE_MS + PI_LOCK_STALE_MS / 2;
const PI_LOCK_WAIT_MS = 5_000;
/** An incoming OAuth `expires` further ahead than this is refused: it would win every later merge and never refresh. */
export const MAX_EXPIRES_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** How many sync backups (`auth.json.bak-sync-*`) pi-profile keeps beside an auth file. */
export const KEEP_BACKUPS = 5;
/**
 * A sync backup's exact name, as `uniqueSibling(path, "bak-sync-<stamp>-<seq>")`
 * makes it: `<seq>` is 10 digits, one more than the highest seq beside the
 * file, so backups made in the same second sort by creation order. A name
 * without `<seq>` was made by an older pi-profile and still matches. A
 * mode-switch backup (`auth.json.bak-<stamp>-<random>`, auth.ts) can hold the
 * only copy of a private login, so it never matches and is never pruned.
 */
const BACKUP_NAME = /^auth\.json\.bak-sync-(\d{8}-\d{6})-(?:(\d{10})-)?[0-9a-f]{12}$/;
const SEQ_DIGITS = 10;
/** A `<lock>.break` file older than this was left by a crashed taker: its holder keeps it for microseconds. */
export const PI_BREAKER_STALE_MS = 60_000;

export type Scalar = string | number | boolean | null;
/** Pi's `ApiKeyCredential`. */
export interface ApiKeyEntry {
	readonly type: "api_key";
	readonly key?: string;
	readonly env?: ReadonlyArray<readonly [string, string]>;
}
/** Pi's `OAuthCredential`; `extra` holds provider fields such as `accountId`, in order. */
export interface OAuthEntry {
	readonly type: "oauth";
	readonly refresh: string;
	readonly access: string;
	readonly expires: number;
	readonly extra: ReadonlyArray<readonly [string, Scalar]>;
}
export type AuthEntry = ApiKeyEntry | OAuthEntry;
export type Entries = ReadonlyMap<string, AuthEntry>;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): v is string {
	return typeof v === "string" && v.length <= MAX_TEXT;
}

/**
 * Check one entry and copy only its named fields. The entry may come from a
 * peer, so it is hostile: a message names the provider and the field, never a
 * value or an unknown field name, which could be a secret. Any type other
 * than `api_key` and `oauth` is refused, never merged.
 */
export function parseEntry(raw: unknown, provider: string, where: string): AuthEntry {
	const bad = (what: string): Refusal => new Refusal(`${where}: ${provider}: ${what}`);
	if (!isRecord(raw)) throw bad("an entry must be a JSON object");
	if (raw.type === "api_key") {
		if (Object.keys(raw).some((k) => k !== "type" && k !== "key" && k !== "env")) throw bad("an api_key entry has a field pi-profile does not know");
		if (raw.key !== undefined && !text(raw.key)) throw bad("key must be a string");
		let env: Array<[string, string]> | undefined;
		if (raw.env !== undefined) {
			if (!isRecord(raw.env)) throw bad("env must be an object of strings");
			env = [];
			for (const [k, v] of Object.entries(raw.env)) {
				if (!ENV_NAME.test(k) || !text(v) || env.length >= MAX_EXTRA) throw bad("env must be an object of strings");
				env.push([k, v]);
			}
		}
		return { type: "api_key", ...(raw.key === undefined ? {} : { key: raw.key }), ...(env === undefined ? {} : { env }) };
	}
	if (raw.type === "oauth") {
		if (!text(raw.refresh)) throw bad("refresh must be a string");
		if (!text(raw.access)) throw bad("access must be a string");
		const expires = raw.expires;
		if (typeof expires !== "number" || !Number.isFinite(expires) || expires < 0) throw bad("expires must be a time in ms");
		const extra: Array<[string, Scalar]> = [];
		for (const [k, v] of Object.entries(raw)) {
			if (OAUTH_NAMED.has(k)) continue;
			const scalar = v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || text(v);
			if (!FIELD.test(k) || !scalar || extra.length >= MAX_EXTRA) throw bad("an oauth entry has a field pi-profile cannot copy");
			extra.push([k, v]);
		}
		return { type: "oauth", refresh: raw.refresh, access: raw.access, expires, extra };
	}
	throw bad("unknown entry type; only api_key and oauth entries are merged");
}

/** The entry as auth.json holds it. Built from named fields; `fromEntries` defines own properties, so no key reaches a prototype. */
export function entryObject(e: AuthEntry): Record<string, unknown> {
	if (e.type === "api_key") {
		const pairs: Array<[string, unknown]> = [["type", "api_key"]];
		if (e.key !== undefined) pairs.push(["key", e.key]);
		if (e.env !== undefined) pairs.push(["env", Object.fromEntries(e.env)]);
		return Object.fromEntries(pairs);
	}
	const pairs: Array<readonly [string, unknown]> = [["type", "oauth"], ["refresh", e.refresh], ["access", e.access], ["expires", e.expires], ...e.extra];
	return Object.fromEntries(pairs);
}

function sameEntry(a: AuthEntry, b: AuthEntry): boolean {
	return JSON.stringify(entryObject(a)) === JSON.stringify(entryObject(b));
}

/** JSON.parse, with a message that never quotes the text: V8's own message shows an excerpt, which may be a secret. */
function parseJson(source: string, what: string): unknown {
	try {
		return JSON.parse(source) as unknown;
	} catch {
		throw new Refusal(`${what} is not valid JSON`);
	}
}

/** Parse a transfer payload `{ schemaVersion: 1, entries: { PROVIDER: entry } }`, checking every entry. */
export function parsePayload(source: string, now: number = Date.now()): Map<string, AuthEntry> {
	if (Buffer.byteLength(source) > MAX_PAYLOAD_BYTES) throw new Refusal(`auth payload is larger than ${String(MAX_PAYLOAD_BYTES)} bytes`);
	const raw = parseJson(source, "auth payload");
	const shape = "auth payload must be { schemaVersion: 1, entries: { PROVIDER: entry } }";
	if (!isRecord(raw) || raw.schemaVersion !== 1 || Object.keys(raw).some((k) => k !== "schemaVersion" && k !== "entries")) throw new Refusal(shape);
	const entries = raw.entries;
	if (!isRecord(entries)) throw new Refusal(shape);
	const keys = Object.keys(entries);
	if (keys.length > MAX_ENTRIES) throw new Refusal(`auth payload has more than ${String(MAX_ENTRIES)} entries`);
	const out = new Map<string, AuthEntry>();
	for (const p of keys) {
		if (!PROVIDER.test(p)) throw new Refusal("auth payload: a provider name is not valid");
		const e = parseEntry(entries[p], p, "auth payload");
		if (e.type === "oauth" && e.expires > now + MAX_EXPIRES_AHEAD_MS) throw new Refusal(`auth payload: ${p}: expires is more than a year away`);
		out.set(p, e);
	}
	return out;
}

/**
 * True when Pi would run the entry's key as a shell command: Pi's
 * `resolveConfigValue` runs a value that starts with `!`. No other prefix
 * runs anything (`$NAME` and `${NAME}` only read the environment).
 */
export function isCommandKey(e: AuthEntry): boolean {
	return e.type === "api_key" && e.key !== undefined && e.key.startsWith("!");
}

/** Refuse incoming command keys unless the user allowed them. The message names the provider, never the key. */
export function checkCommandKeys(incoming: Entries, allow: boolean): void {
	if (allow) return;
	for (const [p, e] of incoming) {
		if (isCommandKey(e)) throw new Refusal(`auth payload: ${p}: the key starts with "!", so Pi would run it as a shell command; pass --allow-command-keys to accept it`);
	}
}

export function payloadText(entries: Entries): string {
	return `${JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries([...entries].map(([p, e]) => [p, entryObject(e)])) })}\n`;
}

// ---------------------------------------------------------------- the rules (mirror model/Domain.bend)

/**
 * Merge an incoming entry into the local one. Mirrors `D.merge`: --force
 * takes the incoming entry (L19); otherwise a local API key is never
 * replaced (L17), an API key never replaces a local OAuth login (L18), and an
 * OAuth login is replaced only by one that expires later.
 */
export function mergeEntry(local: AuthEntry, incoming: AuthEntry, force: boolean): AuthEntry {
	if (force) return incoming;
	if (local.type === "oauth" && incoming.type === "oauth") return local.expires < incoming.expires ? incoming : local;
	// An API key on either side: the local entry stays (L17 for a local key, L18 for a local login).
	return local;
}

/** Which file a mode's auth.json is. Mirrors `D.authFile` (L15, L16): pooled is private, like separate. */
export function authFileFor(mode: AuthMode): "shared" | "profile" {
	return mode === "shared" ? "shared" : "profile";
}

/** Whether pooled auto-push sends an entry. Mirrors `D.autoPush`: OAuth only (L20), pooled mode only (L21). */
export function autoPush(mode: AuthMode, e: AuthEntry): boolean {
	return mode === "pooled" && e.type === "oauth";
}

// ---------------------------------------------------------------- the file

/**
 * The auth file a profile's mode names (L15, L16). A broken profile.json, or
 * an auth.json that disagrees with the mode, is refused: guessing could put
 * one profile's credentials in another's file.
 */
export function authTarget(l: Layout, profile: string): string {
	return authFiles(l, profile).path;
}

/**
 * The auth file a profile's mode names, and every file whose `.lock` a Pi
 * may take while it writes that file. Pi locks `<its agent dir>/auth.json.lock`
 * without resolving links, so a shared file is locked under the default agent
 * dir and under each profile that links to it.
 */
export function authFiles(l: Layout, profile: string): { path: string; locks: string[] } {
	const path = resolveAuthFile(l, profile);
	const shared = sharedAuthPath(l);
	const locks = [authPath(profileDir(l, profile)), path];
	if (resolve(path) === resolve(shared)) {
		for (const name of listProfiles(l)) {
			if (name === DEFAULT_PROFILE) continue;
			const dir = profileDir(l, name);
			if (inspectAuth(dir).kind !== "link") continue;
			const target = finalPath(authPath(dir));
			if (target !== undefined && target === finalPath(shared)) locks.push(authPath(dir));
		}
	}
	return { path, locks: [...new Set(locks)] };
}

const MAX_LINK_HOPS = 40;

/**
 * The real path a name finally names: every link in the chain followed and
 * every directory resolved with realpath, so `z -> w -> agent/auth.json` and
 * a link written through a symlinked home both match the shared file. The
 * last file may be missing. A loop, a missing directory or any other odd
 * link gives undefined, never an error.
 */
function finalPath(name: string): string | undefined {
	try {
		return realpathSync.native(name);
	} catch {
		// The last file may be missing: walk the chain by hand.
	}
	try {
		let p = name;
		for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
			// Not path.resolve or join: they drop `d/..` as text, but the kernel
			// follows the link d first. realpath.native resolves as the kernel does.
			p = `${realpathSync.native(dirname(p))}/${basename(p)}`;
			const st = lstatSync(p, { throwIfNoEntry: false });
			if (st?.isSymbolicLink() !== true) return p;
			const target = readlinkSync(p);
			p = isAbsolute(target) ? target : `${dirname(p)}/${target}`;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function resolveAuthFile(l: Layout, profile: string): string {
	const info = loadProfile(l, profile);
	if (info.manifestErrors.length > 0) throw new Refusal(`profile ${profile}: profile.json has errors; run pi-profile doctor`);
	const mode = info.manifest.auth.mode;
	const shared = sharedAuthPath(l);
	const own = authPath(info.dir);
	if (resolve(own) === resolve(shared)) return shared;
	const st = inspectAuth(info.dir);
	if (authFileFor(mode) === "shared") {
		if (st.kind !== "link" || st.target !== shared) throw new Refusal(`profile ${profile} is in shared auth mode, but its auth.json is not a link to ${shared}; run pi-profile doctor`);
		return shared;
	}
	if (st.kind === "link" || st.kind === "other") throw new Refusal(`profile ${profile} is in ${mode} auth mode, but its auth.json is not a private file; run pi-profile doctor`);
	return own;
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface PiLockOptions {
	/** How long to wait for a Pi holding a lock. */
	readonly waitMs?: number | undefined;
	/**
	 * Break a lock older than PI_LOCK_BREAK_MS. Only a writer does; a read-only
	 * path waits and then gives up. Default false.
	 */
	readonly breakStale?: boolean;
	/** Test seam: runs after a lock is judged stale and before it is broken. */
	readonly afterStaleRead?: (lock: string) => void;
}

/** A directory's identity: a new lock has a new inode or a new mtime. */
interface DirId {
	readonly ino: bigint;
	readonly mtimeNs: bigint;
}

function dirId(path: string): DirId | undefined {
	const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	return st?.isDirectory() === true ? { ino: st.ino, mtimeNs: st.mtimeNs } : undefined;
}

function sameDir(a: DirId, b: DirId | undefined): boolean {
	return b !== undefined && a.ino === b.ino && a.mtimeNs === b.mtimeNs;
}

/**
 * Remove a stale lock only if it is still the directory judged stale, while
 * holding `<lock>.break` (O_EXCL), so two pi-profile takers never both
 * remove it and a lock taken after the judgement is never removed.
 */
function breakIfStill(lock: string, seen: DirId): boolean {
	const breaker = `${lock}.break`;
	let fd: number | undefined;
	for (let attempt = 0; fd === undefined; attempt++) {
		try {
			fd = openSync(breaker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt > 0 || !clearStaleBreaker(lock, breaker, seen)) return false;
		}
	}
	const mine = fstatSync(fd, { bigint: true });
	try {
		closeSync(fd);
		if (!sameDir(seen, dirId(lock))) return false;
		rmdirSync(lock);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTEMPTY") return false;
		throw error;
	} finally {
		// Only our own breaker: never one another taker made after ours was cleared.
		if (sameFile(mine, lstatSync(breaker, { bigint: true, throwIfNoEntry: false }))) unlinkSync(breaker);
	}
}

function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint } | undefined): boolean {
	return b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

/**
 * A crashed taker leaves `<lock>.break` behind. Remove it only when it is a
 * regular file older than PI_BREAKER_STALE_MS and the lock is still the
 * directory judged stale. The breaker is cleared by link-aside
 * (clearBreakerIfUnchanged), which sweeps leftovers of an earlier clearing first.
 */
function clearStaleBreaker(lock: string, breaker: string, seen: DirId): boolean {
	const old = lstatSync(breaker, { bigint: true, throwIfNoEntry: false });
	if (old === undefined) return true;
	if (!old.isFile() || Date.now() - Number(old.mtimeNs / 1_000_000n) <= PI_BREAKER_STALE_MS) return false;
	if (!sameDir(seen, dirId(lock))) return false;
	return clearBreakerIfUnchanged(breaker, old);
}

function acquirePiLock(file: string, lock: string, deadline: number, opts: PiLockOptions): DirId {
	for (;;) {
		try {
			mkdirSync(lock);
			const mine = dirId(lock);
			if (mine !== undefined) return mine;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const seen = dirId(lock);
		if (opts.breakStale === true && seen !== undefined && Date.now() - Number(seen.mtimeNs / 1_000_000n) > PI_LOCK_BREAK_MS) {
			opts.afterStaleRead?.(lock);
			if (breakIfStill(lock, seen)) continue;
		}
		if (Date.now() >= deadline) {
			const breaker = `${lock}.break`;
			const left = lstatSync(breaker, { throwIfNoEntry: false }) === undefined ? "" : ` and ${breaker}`;
			throw new Refusal(`${file} is locked by a running Pi; try again (if no Pi is running, remove ${lock}${left})`);
		}
		sleep(50);
	}
}

/** Release a lock only if it is still the directory this process made. */
function releasePiLock(lock: string, mine: DirId): void {
	if (!sameDir(mine, dirId(lock))) return;
	try {
		rmdirSync(lock);
	} catch {
		// Already gone: nothing to release.
	}
}

/** One name per physical lock, in a stable order, so two takers never wait on each other in a cycle. */
function lockOrder(files: readonly string[]): string[] {
	const real = (dir: string): string => {
		try {
			return realpathSync(dir);
		} catch {
			return resolve(dir);
		}
	};
	return [...new Set(files.map((f) => join(real(dirname(f)), basename(f))))].sort();
}

/**
 * Hold Pi's own locks (`<file>.lock`, a directory, as proper-lockfile makes
 * it) on every file in `files`, so no Pi refreshing a token writes at the
 * same time. Locks are taken in a stable order and all released on every path.
 */
export function withPiAuthLocks<T>(files: readonly string[], fn: () => T, opts: PiLockOptions = {}): T {
	const deadline = Date.now() + (opts.waitMs ?? PI_LOCK_WAIT_MS);
	const held: Array<readonly [string, DirId]> = [];
	try {
		for (const file of lockOrder(files)) {
			const lock = `${file}.lock`;
			held.push([lock, acquirePiLock(file, lock, deadline, opts)]);
		}
		return fn();
	} finally {
		for (const [lock, mine] of held.reverse()) releasePiLock(lock, mine);
	}
}

export function withPiAuthLock<T>(file: string, fn: () => T, opts: PiLockOptions = {}): T {
	return withPiAuthLocks([file], fn, opts);
}

function openNoFollow(path: string, flags: number, mode?: number): number {
	try {
		return openSync(path, flags | constants.O_NOFOLLOW, mode);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") throw new Refusal(`${path} is a symlink; pi-profile writes only the file the profile's auth mode names`);
		if (code === "EEXIST") throw new Refusal(`${path} appeared while pi-profile was writing it; try again`);
		throw error;
	}
}

/** Open an existing auth file (O_RDONLY to read, O_RDWR to update); undefined when there is none. */
function openExisting(path: string, flags: number): number | undefined {
	try {
		return openNoFollow(path, flags);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read from `fd` until EOF, refusing more than `max` bytes without reading past them. */
export function readCapped(fd: number, max: number, what: string): string {
	const chunks: Buffer[] = [];
	const buf = Buffer.alloc(64 * 1024);
	let total = 0;
	for (;;) {
		let n: number;
		try {
			n = readSync(fd, buf, 0, buf.length, null);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EAGAIN") {
				sleep(10);
				continue;
			}
			if (code === "EOF") break;
			throw error;
		}
		if (n === 0) break;
		total += n;
		if (total > max) throw new Refusal(`${what} is larger than ${String(max)} bytes`);
		chunks.push(Buffer.from(buf.subarray(0, n)));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The transfer payload from this process's stdin. A terminal is refused: the payload is piped in. */
export function readStdinPayload(max = MAX_PAYLOAD_BYTES): string {
	if (isatty(0)) throw new Refusal("auth receive reads a JSON payload from stdin; pipe it in (pi-profile auth push does)");
	return readCapped(0, max, "auth payload");
}

function readFd(fd: number, path: string): string {
	if (!fstatSync(fd).isFile()) throw new Refusal(`${path} is not a regular file`);
	return readCapped(fd, MAX_AUTH_FILE_BYTES, path);
}

export interface AuthSnapshot {
	readonly text: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** Read an auth file without following a link; undefined when there is none. */
export function readAuthSnapshot(path: string): AuthSnapshot | undefined {
	const fd = openExisting(path, constants.O_RDONLY);
	if (fd === undefined) return undefined;
	try {
		const st = fstatSync(fd);
		return { text: readFd(fd, path), mtimeMs: st.mtimeMs, size: st.size };
	} finally {
		closeSync(fd);
	}
}

/** auth.json as provider -> raw value, in file order. Values are not checked here. */
function parseLocal(source: string, path: string): Map<string, unknown> {
	if (source.trim() === "") return new Map();
	const raw = parseJson(source, path);
	if (!isRecord(raw)) throw new Refusal(`${path} is not a JSON object`);
	return new Map(Object.entries(raw));
}

/** The entries of an auth file that pi-profile can read; others are left out. */
export function readableEntries(source: string, path: string): Map<string, AuthEntry> {
	const out = new Map<string, AuthEntry>();
	for (const [p, raw] of parseLocal(source, path)) {
		if (!PROVIDER.test(p)) continue;
		try {
			out.set(p, parseEntry(raw, p, path));
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
		}
	}
	return out;
}

export type OutcomeKind = "added" | "replaced" | "kept" | "unchanged";
export interface Outcome {
	readonly provider: string;
	readonly outcome: OutcomeKind;
}

/** Merge incoming entries by provider key. Local entries for other providers stay as they are. */
function mergeInto(local: Map<string, unknown>, incoming: Entries, force: boolean, path: string): { next: Map<string, unknown>; outcomes: Outcome[]; changed: boolean } {
	const next = new Map(local);
	const outcomes: Outcome[] = [];
	let changed = false;
	for (const [provider, inc] of incoming) {
		if (!local.has(provider)) {
			next.set(provider, entryObject(inc));
			outcomes.push({ provider, outcome: "added" });
			changed = true;
			continue;
		}
		// A local entry pi-profile cannot read is refused, never overwritten.
		const current = parseEntry(local.get(provider), provider, path);
		if (sameEntry(current, inc)) {
			outcomes.push({ provider, outcome: "unchanged" });
		} else if (mergeEntry(current, inc, force) === inc) {
			next.set(provider, entryObject(inc));
			outcomes.push({ provider, outcome: "replaced" });
			changed = true;
		} else {
			outcomes.push({ provider, outcome: "kept" });
		}
	}
	return { next, outcomes, changed };
}

function writeAll(fd: number, data: string, position: number | null): void {
	const buf = Buffer.from(data);
	let off = 0;
	while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, position === null ? null : position + off);
}

/**
 * The next backup sequence beside `path`: one more than the highest seq on
 * any sync backup name there. The caller holds the pi-profile lock on the
 * directory, so two receives never take the same number.
 */
function nextBackupSeq(path: string): string {
	let max = 0;
	for (const name of readdirSync(dirname(path))) {
		const seq = BACKUP_NAME.exec(name)?.[2];
		if (seq !== undefined) max = Math.max(max, Number(seq));
	}
	return String(max + 1).padStart(SEQ_DIGITS, "0");
}

/**
 * Keep the file's current contents as `auth.json.bak-sync-<stamp>-<seq>-<random>`,
 * mode 0600. Call it only under the pi-profile lock on the file's directory.
 */
function keepBackup(path: string, contents: string): string {
	const name = uniqueSibling(path, `bak-sync-${stamp()}-${nextBackupSeq(path)}`);
	const fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		fchmodSync(fd, 0o600);
		writeAll(fd, contents, null);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return name;
}

/**
 * Keep the newest `keep` sync backups beside `path` and delete the others.
 * Only regular files whose name is exactly `auth.json.bak-sync-<stamp>-<seq>-<random>`
 * (or the older `auth.json.bak-sync-<stamp>-<random>`) are touched; a
 * mode-switch backup is never deleted. Newest means the later stamp, then the
 * higher seq (a name without one counts as older than any with one), then the
 * later mtime. The seq, not the mtime, orders backups made in the same second:
 * a coarse file system clock gives them equal mtimes.
 */
export function pruneBackups(path: string, keep: number = KEEP_BACKUPS): string[] {
	const dir = dirname(path);
	const found: Array<{ name: string; stamp: string; seq: number; mtimeNs: bigint }> = [];
	for (const d of readdirSync(dir, { withFileTypes: true })) {
		const m = BACKUP_NAME.exec(d.name);
		if (m === null) continue;
		const st = lstatSync(join(dir, d.name), { bigint: true, throwIfNoEntry: false });
		if (st?.isFile() !== true) continue;
		found.push({ name: d.name, stamp: m[1] ?? "", seq: m[2] === undefined ? -1 : Number(m[2]), mtimeNs: st.mtimeNs });
	}
	const newestFirst = <T extends string | number | bigint>(a: T, b: T): number => (a === b ? 0 : a < b ? 1 : -1);
	found.sort((a, b) => newestFirst(a.stamp, b.stamp) || newestFirst(a.seq, b.seq) || newestFirst(a.mtimeNs, b.mtimeNs) || newestFirst(a.name, b.name));
	const removed: string[] = [];
	for (const f of found.slice(keep)) {
		try {
			unlinkSync(join(dir, f.name));
			removed.push(f.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return removed;
}

/**
 * Rewrite the open file in place, as Pi does, and make it 0600. Never a
 * rename over the name: that would replace a shared auth.json's link with a
 * private file, and the profiles would silently stop sharing.
 */
function overwrite(fd: number, contents: string): void {
	ftruncateSync(fd, 0);
	writeAll(fd, contents, 0);
	fchmodSync(fd, 0o600);
	fsyncSync(fd);
}

export interface ReceiveOptions {
	readonly force?: boolean;
	/** How long to wait for a Pi holding auth.json's lock. */
	readonly lockWaitMs?: number;
	/** Accept an api_key whose key Pi would run as a shell command. */
	readonly allowCommandKeys?: boolean;
	/** Test seam: see PiLockOptions. */
	readonly afterStaleRead?: (lock: string) => void;
}
export interface ReceiveResult {
	readonly path: string;
	readonly outcomes: readonly Outcome[];
	/** The backup of the file as it was, when it changed. */
	readonly backup?: string;
}

/**
 * Merge entries into a profile's auth file (`auth receive`). Under the
 * pi-profile lock on the file's directory and Pi's own lock on the file, it
 * keeps a 0600 backup and then rewrites the file in place with mode 0600.
 * Nothing is written when nothing changes.
 */
export function receiveAuth(l: Layout, profile: string, incoming: Entries, opts: ReceiveOptions = {}): ReceiveResult {
	const { path, locks } = authFiles(l, profile);
	const force = opts.force ?? false;
	checkCommandKeys(incoming, opts.allowCommandKeys ?? false);
	return withProfileLock(dirname(path), () =>
		withPiAuthLocks(
			locks,
			() => {
				let fd = openExisting(path, constants.O_RDWR);
				try {
					const before = fd === undefined ? "" : readFd(fd, path);
					const { next, outcomes, changed } = mergeInto(parseLocal(before, path), incoming, force, path);
					if (!changed) return { path, outcomes };
					const after = `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`;
					let backup: string | undefined;
					if (fd === undefined) fd = openNoFollow(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
					else backup = keepBackup(path, before);
					overwrite(fd, after);
					if (backup !== undefined) pruneBackups(path);
					return { path, outcomes, ...(backup === undefined ? {} : { backup }) };
				} finally {
					if (fd !== undefined) closeSync(fd);
				}
			},
			{ waitMs: opts.lockWaitMs, breakStale: true, ...(opts.afterStaleRead === undefined ? {} : { afterStaleRead: opts.afterStaleRead }) },
		),
	);
}

function checkProviders(providers: readonly string[] | undefined): void {
	for (const p of providers ?? []) if (!PROVIDER.test(p)) throw new Refusal("--provider needs a provider name, such as anthropic");
}

export interface ExportResult {
	readonly entries: Map<string, AuthEntry>;
	/** Providers left out because pi-profile cannot read their entries. */
	readonly skipped: readonly string[];
}

/**
 * The entries to send from a profile's auth file (`auth export`). A named
 * provider must exist and be readable; without names, every readable entry is
 * sent and the others are reported as skipped.
 */
export function exportAuth(l: Layout, profile: string, providers?: readonly string[], lockWaitMs?: number): ExportResult {
	checkProviders(providers);
	const { path, locks } = authFiles(l, profile);
	// Read-only: waits for Pi, never breaks its lock.
	const snap = withPiAuthLocks(locks, () => readAuthSnapshot(path), { waitMs: lockWaitMs });
	const local = parseLocal(snap?.text ?? "", path);
	const entries = new Map<string, AuthEntry>();
	const skipped: string[] = [];
	if (providers !== undefined && providers.length > 0) {
		for (const p of providers) {
			if (!local.has(p)) throw new Refusal(`profile ${profile} has no ${p} entry`);
			entries.set(p, parseEntry(local.get(p), p, path));
		}
		return { entries, skipped };
	}
	for (const [p, raw] of local) {
		try {
			if (!PROVIDER.test(p)) throw new Refusal("bad name");
			entries.set(p, parseEntry(raw, p, path));
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			skipped.push(PROVIDER.test(p) ? p : "(an entry with an unusual name)");
		}
	}
	return { entries, skipped };
}

// ---------------------------------------------------------------- transport

export interface SshResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}
/** Runs `ssh ARGS` with `input` on stdin; tests replace it. */
export type SshRunner = (args: readonly string[], input: string) => SshResult;

export const SSH_TIMEOUT_MS = 120_000;

/** The real ssh, found on the PATH in `env`, with a hard deadline. Error text never includes stdin or stdout. */
export function processSshRunner(env: Env, timeout = SSH_TIMEOUT_MS): SshRunner {
	return (args, input) => {
		const r = spawnSync("ssh", [...args], { input, encoding: "utf8", env: { ...env }, timeout, maxBuffer: 2 * MAX_PAYLOAD_BYTES, stdio: ["pipe", "pipe", "pipe"] });
		const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
		// ssh that fails to connect exits without reading stdin, so writing a large
		// payload gets EPIPE; the child did exit, so its status and stderr say why.
		const exitedEarly = code === "EPIPE" && r.status !== null;
		const error = r.error === undefined || exitedEarly ? undefined : code === "ENOENT" ? "ssh is not installed" : code === "ETIMEDOUT" ? "ssh timed out" : `ssh failed (${code ?? "unknown error"})`;
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(error === undefined ? {} : { error }) };
	};
}

/** A host must be a Tailscale short name, so it can never be read as an ssh option. The value is not echoed. */
export function checkHost(host: string): void {
	if (!HOST_LABEL.test(host)) throw new Refusal("host must be a Tailscale short name, such as good-kite-studio");
}

const REMOTE_TOKEN = /^(--[a-z]+(-[a-z]+)*|[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * `ssh` arguments for a remote `pi-profile auth ...`: no prompts, a bounded
 * connect, `--` before the host. Every word of the remote command is a fixed
 * word or a checked name, so the remote shell has nothing to interpret, and
 * no credential is ever an argument.
 */
export function authSshArgs(host: string, remote: readonly string[]): string[] {
	checkHost(host);
	for (const t of remote) if (!REMOTE_TOKEN.test(t)) throw new Refusal("refusing to pass an unsafe word to a remote shell");
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "--", host, "pi-profile", "auth", ...remote];
}

/** Why a remote run failed: the last line of stderr, printable. Never stdout, which may hold credentials. */
export function failure(r: SshResult): string | undefined {
	if (r.error !== undefined) return r.error;
	if (r.status === 0) return undefined;
	const line = printable(r.stderr.trim().split("\n").pop() ?? "").replace(/^pi-profile: /, "").slice(0, 300);
	const what = r.status === 255 ? "ssh could not connect" : `exited ${String(r.status)}`;
	return line.length > 0 ? `${what}: ${line}` : what;
}

function lines(s: string): string[] {
	return s.split("\n").filter((x) => x.trim().length > 0).map(printable);
}

export interface TransferOptions {
	readonly profile: string;
	readonly providers?: readonly string[];
	readonly force?: boolean;
	/** Accept (pull) or let the peer accept (push) an api_key Pi would run as a shell command. */
	readonly allowCommandKeys?: boolean;
	readonly run: SshRunner;
}

export interface PushResult {
	/** The receiver's report: `provider: outcome` lines. */
	readonly lines: readonly string[];
	readonly skipped: readonly string[];
}

/** Send entries to `host`'s profile, which merges them with `auth receive`. Returns the receiver's report lines. */
export function sendEntries(host: string, profile: string, entries: Entries, force: boolean, run: SshRunner, allowCommandKeys = false): string[] {
	const args = authSshArgs(host, ["receive", "--profile", profile, ...(force ? ["--force"] : []), ...(allowCommandKeys ? ["--allow-command-keys"] : [])]);
	const r = run(args, payloadText(entries));
	const why = failure(r);
	if (why !== undefined) throw new Error(`${host}: auth receive failed: ${why}`);
	return lines(r.stdout);
}

/** Send this profile's entries to `host`, which merges them with `auth receive` (`auth push`). */
export function pushAuth(l: Layout, host: string, opts: TransferOptions): PushResult {
	checkHost(host);
	const { entries, skipped } = exportAuth(l, opts.profile, opts.providers);
	if (entries.size === 0) throw new Refusal(`profile ${opts.profile} has no credentials to push`);
	return { lines: sendEntries(host, opts.profile, entries, opts.force ?? false, opts.run, opts.allowCommandKeys ?? false), skipped };
}

export interface PullResult extends ReceiveResult {
	/** The peer's warnings, printable. */
	readonly warnings: readonly string[];
}

/**
 * Fetch entries from `host` with `auth export` and merge them here, as
 * `auth receive` would (`auth pull`). With `--provider`, only those
 * providers are merged: anything else the peer sends is dropped and named in
 * a warning.
 */
export function pullAuth(l: Layout, host: string, opts: TransferOptions): PullResult {
	checkHost(host);
	checkProviders(opts.providers);
	authTarget(l, opts.profile);
	const args = authSshArgs(host, ["export", "--profile", opts.profile, ...(opts.providers ?? []).flatMap((p) => ["--provider", p])]);
	const r = opts.run(args, "");
	const why = failure(r);
	if (why !== undefined) throw new Error(`${host}: auth export failed: ${why}`);
	let incoming: Map<string, AuthEntry>;
	try {
		incoming = parsePayload(r.stdout);
	} catch (error) {
		throw new Refusal(`${host}: ${(error as Error).message}`);
	}
	const warnings = lines(r.stderr);
	const requested = new Set(opts.providers ?? []);
	if (requested.size > 0) {
		for (const p of [...incoming.keys()]) {
			if (requested.has(p)) continue;
			incoming.delete(p);
			warnings.push(`${p}: ignored: not requested`);
		}
	}
	try {
		checkCommandKeys(incoming, opts.allowCommandKeys ?? false);
	} catch (error) {
		throw new Refusal(`${host}: ${(error as Error).message}`);
	}
	return { ...receiveAuth(l, opts.profile, incoming, { force: opts.force ?? false, allowCommandKeys: opts.allowCommandKeys ?? false }), warnings };
}
