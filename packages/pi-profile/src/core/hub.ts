import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { SSH_COMMAND } from "./backup.ts";
import { configPath, DEFAULT_HUB, hubRemoteProblem, loadConfig, updateConfig, type MachineConfig } from "./config.ts";
import { lstatOrUndefined } from "./fsutil.ts";
import { renderFile } from "./hubrender.ts";
import { holdWayOut, localId, readSyncState, syncStatePath, writeSyncState, type FileRecord, type SyncState } from "./hubstate.ts";
import { pinDiverged, pinPending, pinStatePath, readPinState, shownPin, writePinState } from "./pinstate.ts";
import { isPin } from "./piversion.ts";
import { withProfileLock } from "./lock.ts";
import { isHubName, parseSyncSetting } from "./manifest.ts";
import { DEFAULT_PROFILE, isProfileName, isSelectableName } from "./names.ts";
import { profilesRoot, trashDir, type Env, type Layout } from "./paths.ts";
import { getGlobalDefault, listProfiles, loadProfile, requireProfile } from "./profiles.ts";
import { localHost, printable, shellQuote } from "./repo.ts";
import { Refusal } from "./result.ts";
import { classifyContent, isSecretSegment, MAX_SCAN_BYTES, profileSyncRules, pushPlan, scanContent, UNKNOWN_REASONS, type SyncRules } from "./syncmanifest.ts";
import { isTokenRoot, portableProfile, portableSettings, sessionDirFor, tokenHost, type Json, type TokenHost } from "./tokens.ts";

/**
 * The config hub (design §Config sync, issue 31): a bare git repository on a
 * tailnet machine. `sync init` makes a local bare mirror of it; `sync push`
 * commits each profile's portable layer to `profiles/<name>/` and pushes.
 *
 * Hub layout, which `sync pull` reads:
 *
 * - `profiles/<name>/<path>`: the profile's config files, `profile.json` and
 *   `settings.json` in portable form (path tokens, no `sessionDir`).
 * - `hub.json`: `{ "schemaVersion": 1, "aliases": { NAME: TARGET } }`, a
 *   profile that is a link to another profile on the pushing host. With a
 *   Pi version pin (issue 34) it is
 *   `{ "schemaVersion": 2, "aliases": {...}, "pi": { "version": PIN } }`;
 *   without one it stays schema 1, so an older pi-profile still reads it.
 *
 * The mirror's `refs/heads/main` is the last hub commit this host synced
 * with. A push builds on it and is a fast-forward or nothing: when the hub
 * has moved, push fetches and stops. It never merges.
 */

/** The branch every hub keeps its history on. */
export const HUB_BRANCH = "main";
export const MAIN = `refs/heads/${HUB_BRANCH}`;
export const ORIGIN_MAIN = `refs/remotes/origin/${HUB_BRANCH}`;
export const HUB_JSON = "hub.json";
export const PROFILES = "profiles";
/** Config files whose API keys belong in environment variables (issue 41): push leaves one out while it holds a literal key. */
export const KEYED_FILES: ReadonlySet<string> = new Set(["models.json", "web-search.json"]);
/** How to make a keyed file pushable. It names no value. */
export const KEY_REFERENCE_FIX = 'replace each with an environment variable reference such as "${NAME}"';
/** The prefix of the scratch folder a push makes in the mirror. */
const STAGE_PREFIX = "pi-profile-stage-";
const LOCAL_MS = 60_000;
const NETWORK_MS = 120_000;
/**
 * Every git call: no hooks, no signing, and only ssh and local transports,
 * so a rewritten URL (`url.*.insteadOf`) cannot send the hub elsewhere.
 */
const GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "protocol.file.allow=always"];

/** `~/.pi/pi-profile/sync`: one bare mirror per hub, `<hub>.git`. Machine-local, never synced. */
export function hubsDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "sync");
}

export function hubMirror(l: Layout, hub: string): string {
	if (!isHubName(hub)) throw new Refusal(`invalid hub name: ${printable(hub)}`);
	return join(hubsDir(l), `${hub}.git`);
}

export interface Git {
	readonly dir: string;
	readonly env: Readonly<Record<string, string>>;
}

export interface GitResult {
	readonly status: number | null;
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly error?: string;
}

/**
 * The environment git runs with, copied by name: no global or system git
 * config, no prompt, ssh in batch mode with bounded timeouts.
 */
function gitEnv(env: Env, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
	const out: Record<string, string> = { GIT_SSH_COMMAND: SSH_COMMAND, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
	for (const k of ["PATH", "HOME", "SSH_AUTH_SOCK"]) {
		const v = env[k] ?? (k === "PATH" ? process.env.PATH : undefined);
		if (v !== undefined) out[k] = v;
	}
	return { ...out, ...extra };
}

function runGit(g: Git, args: readonly string[], opts: { readonly input?: Buffer | string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {}): GitResult {
	const r = spawnSync("git", [...GIT_ARGS, `--git-dir=${g.dir}`, ...args], {
		env: { ...g.env, ...(opts.env ?? {}) },
		input: opts.input ?? "",
		timeout: opts.timeoutMs ?? LOCAL_MS,
		maxBuffer: 1024 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const error = r.error === undefined ? undefined : (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "git is not installed" : r.error.message;
	return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr?.toString("utf8") ?? "", ...(error === undefined ? {} : { error }) };
}

/** git's own words, safe to print and short. */
export function said(r: GitResult): string {
	const text = (r.error ?? r.stderr).trim().split("\n").filter((x) => !x.startsWith("hint:")).join("; ");
	return printable(text.length > 400 ? `${text.slice(0, 400)}…` : text) || `exit ${String(r.status)}`;
}

export function git(g: Git, args: readonly string[], opts: { readonly input?: Buffer | string; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {}): Buffer {
	const r = runGit(g, args, opts);
	if (r.status !== 0 || r.error !== undefined) throw new Error(`git ${args[0] ?? ""} failed: ${said(r)}`);
	return r.stdout;
}

function gitLine(g: Git, args: readonly string[], env?: Readonly<Record<string, string>>): string {
	return git(g, args, env === undefined ? {} : { env }).toString("utf8").trim();
}

/** The commit `ref` names in the mirror, or undefined. */
export function commitAt(g: Git, ref: string): string | undefined {
	const r = runGit(g, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
	return r.status === 0 ? r.stdout.toString("utf8").trim() : undefined;
}

/**
 * When git did not run at all (not installed, timed out), an Error that
 * names git: the mirror is not at fault, so the caller must not say it is
 * (issue 45).
 */
function ranGit(r: GitResult, what: string): void {
	if (r.error !== undefined) throw new Error(`git ${what} failed: ${r.error}`);
}

/** True when the mirror is a bare repository; a folder git reads and rejects is not one. */
function isBare(g: Git): boolean {
	const r = runGit(g, ["rev-parse", "--is-bare-repository"]);
	ranGit(r, "rev-parse");
	return r.status === 0 && r.stdout.toString("utf8").trim() === "true";
}

/** The mirror's `remote.origin.url`, or undefined when it has none. */
function mirrorRemote(g: Git): string | undefined {
	const r = runGit(g, ["config", "--get", "remote.origin.url"]);
	ranGit(r, "config");
	return r.status === 0 ? r.stdout.toString("utf8").replace(/\n$/, "") : undefined;
}

/**
 * The mirror of hub `hub`, checked: a real directory, a bare repository,
 * following `remote`. Shared by push and pull.
 */
export function openMirror(l: Layout, hub: string, remote: string, env: Env): Git {
	const dir = hubMirror(l, hub);
	const st = lstatOrUndefined(dir);
	if (st === undefined || st.isSymbolicLink() || !st.isDirectory()) throw new Refusal(`hub ${hub} is not set up on this host: run ${initCommand(hub, remote)}`);
	const g: Git = { dir, env: gitEnv(env) };
	if (!isBare(g)) throw new Refusal(`${dir} is not a bare git repository; move it away and run ${initCommand(hub, remote)}`);
	const was = mirrorRemote(g);
	if (was !== remote) throw remoteMismatch(hub, dir, was, remote);
	return g;
}

function initCommand(hub: string, remote: string): string {
	return `pi-profile sync init ${printable(remote)}${hub === DEFAULT_HUB ? "" : ` --hub ${hub}`}`;
}

/**
 * The mirror holds the history of the remote it was made for. Built on by
 * another remote, it would send the old hub's whole history to the new one.
 */
function remoteMismatch(hub: string, dir: string, was: string | undefined, remote: string): Refusal {
	return new Refusal(`hub ${hub}: the mirror ${dir} follows ${was === undefined ? "no remote" : printable(was)}, not ${printable(remote)}; remove the mirror and run ${initCommand(hub, remote)} again`);
}

export function fetch(g: Git): GitResult {
	return runGit(g, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/*:refs/remotes/origin/*`], { timeoutMs: NETWORK_MS });
}

export interface InitResult {
	readonly hub: string;
	readonly remote: string;
	readonly dir: string;
	/** True when the local mirror was made by this call. */
	readonly created: boolean;
	/** The hub's last commit, when it has one. */
	readonly head?: string;
}

/**
 * `sync init REMOTE [--hub NAME]`: record hub NAME (default `default`) in
 * machine config `hubs` and make or refresh its local bare mirror. The
 * remote must exist already (`git init --bare` on the hub machine). A hub
 * that already has history is cloned: the mirror's `main` becomes the hub's.
 * Changing an existing hub's remote is refused, and so is a mirror that
 * follows another remote.
 */
export function initHub(l: Layout, remote: string, opts: { readonly hub?: string; readonly env?: Env; readonly hooks?: InitHooks } = {}): InitResult {
	const env = opts.env ?? process.env;
	const hub = opts.hub ?? DEFAULT_HUB;
	if (!isHubName(hub)) throw new Refusal(`invalid hub name: ${printable(hub)} (letters, digits, '.', '_' or '-')`);
	const problem = hubRemoteProblem(remote);
	if (problem !== undefined) throw new Refusal(`hub remote ${problem}`);
	const root = hubsDir(l);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	opts.hooks?.beforeLock?.();
	return withProfileLock(root, () => {
		const dir = hubMirror(l, hub);
		// Read under the lock, so a concurrent init of the same hub is seen.
		const known = loadConfig(l, env).hubs?.[hub];
		if (known !== undefined && known.remote !== remote) throw new Refusal(`hub ${hub} already uses another remote (${printable(known.remote)}); to change it, set hubs.${hub}.remote in ${configPath(l)}, remove ${dir}, and run sync init again`);
		const g: Git = { dir, env: gitEnv(env) };
		const st = lstatOrUndefined(dir);
		const created = st === undefined;
		if (created) {
			const r = runGit({ dir: root, env: g.env }, ["init", "--quiet", "--bare", `--initial-branch=${HUB_BRANCH}`, "--", dir]);
			if (r.status !== 0) throw new Error(`git init failed: ${said(r)}`);
		} else if (st.isSymbolicLink() || !st.isDirectory() || !isBare(g)) {
			throw new Refusal(`${dir} is not a bare git repository; move it away and run sync init again`);
		} else {
			// A mirror with no remote is one an init left before its first fetch; it holds no history.
			const was = mirrorRemote(g);
			if (was !== remote && !(was === undefined && commitAt(g, MAIN) === undefined)) throw remoteMismatch(hub, dir, was, remote);
		}
		try {
			git(g, ["config", "remote.origin.url", remote]);
			const f = fetch(g);
			if (f.status !== 0 || f.error !== undefined) throw new Refusal(`cannot fetch hub ${hub}: ${said(f)}\ncreate the hub first on the hub machine: git init --bare PATH`);
		} catch (error) {
			if (created) rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		const head = commitAt(g, ORIGIN_MAIN);
		if (head !== undefined && commitAt(g, MAIN) === undefined) git(g, ["update-ref", MAIN, head, ""]);
		updateConfig(l, (c) => ({ ...c, hubs: { ...(c.hubs ?? {}), [hub]: { remote } } }), env);
		return { hub, remote, dir, created, ...(head === undefined ? {} : { head }) };
	});
}

/** A file config sync did not carry, and why. Locations only, never a value. */
export interface SkippedPath {
	readonly profile: string;
	readonly path: string;
	readonly reason: string;
}

/** Test seams for `initHub`. Production code passes none. */
export interface InitHooks {
	/** After the remote is checked, before the sync lock is taken: another init may run here. */
	readonly beforeLock?: () => void;
}

export interface HubPush {
	readonly hub: string;
	readonly profiles: readonly string[];
	/** The pushed commit; undefined when the hub already held this layer or the push failed. */
	readonly commit?: string;
	/** Why this hub was not pushed; the other hubs are pushed regardless. `refused` when a rule said no. */
	readonly failed?: { readonly message: string; readonly refused: boolean };
	/** The hub holds the push, but `last.json` could not record it (issue 49). */
	readonly warning?: string;
	/**
	 * Set when this push changed the hub's Pi version pin: `to` is the pin it
	 * holds now (absent when removed), `from` the pin it replaced (absent: none).
	 */
	readonly pin?: { readonly to?: string; readonly from?: string };
}

export interface PushReport {
	/** One entry for each hub, pushed or failed. */
	readonly hubs: readonly HubPush[];
	/** Files left out; the hub keeps its copy of each, if it has one. */
	readonly skipped: readonly SkippedPath[];
	/** Profiles left out entirely (only when no names were given). */
	readonly skippedProfiles: ReadonlyArray<{ readonly profile: string; readonly reason: string }>;
	readonly aliases: ReadonlyArray<{ readonly profile: string; readonly target: string }>;
	readonly warnings: readonly string[];
}

/** Test seams. Production code passes none. */
export interface PushHooks {
	/** After the plan of each profile, before its files are read: `dir` is its real path. */
	readonly afterPlan?: (profile: string, dir: string) => void;
	/** Before the commit gate: `stage` adds or replaces a file in the hub tree, as a bug or race might. */
	readonly beforeGate?: (stage: (path: string, bytes: Buffer) => void) => void;
}

interface Blob {
	readonly mode: string;
	readonly bytes: Buffer;
	/** `localId` of the bytes as they are on this host, before the portable form. */
	readonly local?: string;
	/** `localId` of the portable bytes rendered back for this host, as `sync pull` would write them. */
	readonly rendered?: string;
}

type Prepared =
	| { readonly kind: "files"; readonly name: string; readonly hub: string; readonly files: ReadonlyMap<string, Blob>; readonly kept: ReadonlySet<string> }
	| { readonly kind: "alias"; readonly name: string; readonly hub: string; readonly target: string };

type Read = { readonly ok: true; readonly blob: Blob } | { readonly ok: false; readonly reason: string };

/**
 * Read config file `rel` of the profile at `dir` (a real path): opened with
 * O_NOFOLLOW, and the open file must be a regular file with one link and at
 * most 1 MiB. Where `/proc/self/fd` exists, the open file must be at
 * `dir/rel`, so a parent directory swapped for a link is refused; elsewhere
 * the path must still name the same inode.
 */
function readPinned(dir: string, rel: string): Read {
	const abs = join(dir, ...rel.split("/"));
	let fd: number | undefined;
	try {
		fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st: Stats = fstatSync(fd);
		if (!st.isFile()) return { ok: false, reason: "not a regular file" };
		if (st.nlink !== 1) return { ok: false, reason: "a hard link: another name shares its contents" };
		if (st.size > MAX_SCAN_BYTES) return { ok: false, reason: "larger than 1 MiB, not scanned" };
		let at: string | undefined;
		try {
			at = readlinkSync(`/proc/self/fd/${String(fd)}`);
		} catch {
			at = undefined;
		}
		if (at !== undefined ? at !== abs : (() => {
			const now = lstatSync(abs);
			return now.dev !== st.dev || now.ino !== st.ino;
		})()) return { ok: false, reason: "moved while it was read (a link is never followed)" };
		const buf = Buffer.alloc(st.size);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (n === 0) break;
			got += n;
		}
		return { ok: true, blob: { mode: (st.mode & 0o111) !== 0 ? "100755" : "100644", bytes: buf.subarray(0, got) } };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { ok: false, reason: code === "ELOOP" ? "a link: never followed, never config" : `cannot be read (${code ?? "error"})` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** `profile.json` and `settings.json` in portable form; any other file as it is. */
export function portable(rel: string, bytes: Buffer, host: TokenHost): { ok: true; bytes: Buffer; warnings: readonly string[] } | { ok: false; reason: string } {
	if (rel !== "profile.json" && rel !== "settings.json") return { ok: true, bytes, warnings: [] };
	const text = bytes.toString("utf8");
	let json: Json;
	try {
		json = JSON.parse(text) as Json;
	} catch {
		return { ok: false, reason: "not valid JSON" };
	}
	try {
		const t = rel === "settings.json" ? portableSettings(json, host) : portableProfile(json, host);
		if (JSON.stringify(t.json) === JSON.stringify(json)) return { ok: true, bytes, warnings: t.warnings };
		const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1] ?? "\t";
		return { ok: true, bytes: Buffer.from(`${JSON.stringify(t.json, null, indent)}\n`), warnings: t.warnings };
	} catch (error) {
		if (error instanceof Refusal) return { ok: false, reason: error.message };
		throw error;
	}
}

function keyedHint(rel: string, reason: string): string {
	return KEYED_FILES.has(rel) && reason.includes("credential-looking") ? `${reason}; it stays out of the hub while it holds a literal key: ${KEY_REFERENCE_FIX}` : reason;
}

/**
 * The profile `name` ready to stage: its files, or the alias record of a
 * profile that is a link to another. Read under the profile's lock, so no
 * other pi-profile changes it meanwhile.
 */
function prepare(l: Layout, config: MachineConfig, name: string, host: TokenHost, skipped: SkippedPath[], warnings: string[], hooks: PushHooks): Prepared {
	const linkPath = requireProfile(l, name);
	return withProfileLock(linkPath, () => prepareLocked(l, config, name, linkPath, host, skipped, warnings, hooks));
}

/** The id of portable `bytes` rendered back for this host, as `sync pull` renders them; undefined when it cannot render them. */
function renderedId(rel: string, bytes: Buffer, host: TokenHost, sessionDir: () => string | undefined): string | undefined {
	try {
		return localId(renderFile(rel, bytes, host, rel === "settings.json" ? sessionDir() : undefined).bytes);
	} catch (error) {
		if (error instanceof Refusal) return undefined;
		throw error;
	}
}

function prepareLocked(l: Layout, config: MachineConfig, name: string, linkPath: string, host: TokenHost, skipped: SkippedPath[], warnings: string[], hooks: PushHooks): Prepared {
	const info = loadProfile(l, name);
	const sessionDir = (): string | undefined => sessionDirFor(info.manifest, config);
	if (info.manifestErrors.length > 0) throw new Refusal(`${name}: profile.json: ${info.manifestErrors.join("; ")}`);
	const hub = info.manifest.sync?.hub ?? DEFAULT_HUB;
	if (name !== DEFAULT_PROFILE && lstatSync(linkPath).isSymbolicLink()) {
		const target = relative(realpathSync(profilesRoot(l)), realpathSync(linkPath));
		if (!isProfileName(target) || target.includes(sep) || lstatSync(join(profilesRoot(l), target)).isSymbolicLink())
			throw new Refusal(`${name}: a link to a profile is synced as an alias, and this link does not point straight at a profile directory`);
		return { kind: "alias", name, hub, target };
	}
	// One real path for the plan and every read: a link at the root could be repointed between them.
	const dir = realpathSync(linkPath);
	const { rules } = profileSyncRules(l, name, true);
	const plan = pushPlan(dir, rules);
	hooks.afterPlan?.(name, dir);
	const kept = new Set<string>();
	const skip = (path: string, reason: string): void => {
		kept.add(path);
		skipped.push({ profile: name, path, reason: keyedHint(path, reason) });
	};
	for (const s of plan.skipped) skip(s.path, s.reason);
	const files = new Map<string, Blob>();
	for (const rel of plan.push) {
		const read = readPinned(dir, rel);
		if (!read.ok) {
			skip(rel, read.reason);
			continue;
		}
		const cls = classifyContent(rel, rules, read.blob.bytes);
		if (cls.cls !== "config") {
			skip(rel, `class ${cls.cls}${cls.why === undefined ? "" : `: ${UNKNOWN_REASONS[cls.why]}`}`);
			continue;
		}
		const raw = scanContent(rel, rules, read.blob.bytes);
		if (!raw.ok) {
			skip(rel, raw.reason.slice(printable(rel).length + 2));
			continue;
		}
		const out = portable(rel, read.blob.bytes, host);
		if (!out.ok) {
			skip(rel, out.reason);
			continue;
		}
		warnings.push(...out.warnings.map((w) => `${name}/${rel}: ${w}`));
		if (out.bytes !== read.blob.bytes) {
			const again = scanContent(rel, rules, out.bytes);
			if (!again.ok) {
				skip(rel, `${again.reason.slice(printable(rel).length + 2)} (in its portable form)`);
				continue;
			}
		}
		const rendered = renderedId(rel, out.bytes, host, sessionDir);
		files.set(rel, { mode: read.blob.mode, bytes: out.bytes, local: localId(read.blob.bytes), ...(rendered === undefined ? {} : { rendered }) });
	}
	return { kind: "files", name, hub, files, kept };
}

export interface Entry {
	readonly mode: string;
	readonly type: string;
	readonly sha: string;
	/** The blob's size in bytes, when `ls-tree -l` gave one. */
	readonly size?: number;
}

/** `ls-tree -r -l` of `tree`, by path. */
export function treeEntries(g: Git, tree: string): Map<string, Entry> {
	const out = new Map<string, Entry>();
	for (const rec of git(g, ["ls-tree", "-r", "-l", "-z", "--full-tree", tree]).toString("utf8").split("\0")) {
		if (rec === "") continue;
		const tab = rec.indexOf("\t");
		const [mode, type, sha, size] = rec.slice(0, tab).split(/ +/);
		const n = Number(size);
		out.set(rec.slice(tab + 1), { mode: mode as string, type: type as string, sha: sha as string, ...(Number.isSafeInteger(n) ? { size: n } : {}) });
	}
	return out;
}

/** The contents of blobs `shas`, read by one `cat-file --batch`. */
export function readBlobs(g: Git, shas: readonly string[]): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	const unique = [...new Set(shas)];
	if (unique.length === 0) return out;
	const buf = git(g, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n` });
	let at = 0;
	for (const sha of unique) {
		const nl = buf.indexOf(0x0a, at);
		const head = buf.subarray(at, nl).toString("utf8").split(" ");
		if (head[0] !== sha || head[1] !== "blob") throw new Error(`git cat-file: unexpected object for ${sha}`);
		const size = Number(head[2]);
		out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
		at = nl + 1 + size + 1;
	}
	return out;
}

/** Write `blobs` to the mirror with one `fast-import`; their object names, in order. */
function writeBlobs(g: Git, blobs: readonly Buffer[], scratch: string): string[] {
	if (blobs.length === 0) return [];
	const parts: Buffer[] = [];
	blobs.forEach((b, i) => {
		parts.push(Buffer.from(`blob\nmark :${String(i + 1)}\ndata ${String(b.length)}\n`), b, Buffer.from("\n"));
	});
	const marks = join(scratch, "marks");
	git(g, ["fast-import", "--quiet", `--export-marks=${marks}`], { input: Buffer.concat(parts) });
	const shas = new Map<number, string>();
	for (const line of readFileSync(marks, "utf8").split("\n")) {
		const m = /^:(\d+) ([0-9a-f]+)$/.exec(line);
		if (m !== null) shas.set(Number(m[1]), m[2] as string);
	}
	return blobs.map((_, i) => {
		const sha = shas.get(i + 1);
		if (sha === undefined) throw new Error("git fast-import did not report every blob");
		return sha;
	});
}

export interface HubJson {
	/** 1 without a Pi version pin; 2 with one (issue 34). */
	readonly schemaVersion: 1 | 2;
	readonly aliases: Record<string, string>;
	/** The fleet's Pi version pin (`pi.version`), checked by `isPin`. */
	readonly pin?: string;
}

/** The newest hub.json schema this pi-profile reads and writes. */
export const HUB_SCHEMA = 2;

/**
 * Parse a hub's `hub.json` (untrusted). Schema 1 holds `aliases` only;
 * schema 2 may add `pi: { version }`, a pin in the subset `isPin`
 * accepts. A newer schema is refused with a request to upgrade. A reason
 * never quotes a value from the file.
 */
export function parseHubJson(bytes: Buffer | undefined): HubJson | string {
	if (bytes === undefined) return { schemaVersion: 1, aliases: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch {
		return "hub.json is not valid JSON";
	}
	const shape = 'hub.json must be { "schemaVersion": 1, "aliases": { PROFILE: PROFILE } } or { "schemaVersion": 2, "aliases": { PROFILE: PROFILE }, "pi": { "version": PIN } }';
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return shape;
	const r = raw as Record<string, unknown>;
	const v = r.schemaVersion;
	if (typeof v === "number" && Number.isSafeInteger(v) && v > HUB_SCHEMA)
		return `hub.json schemaVersion ${String(v)} is newer than this pi-profile reads; upgrade pi-profile on this host`;
	if (v !== 1 && v !== 2) return shape;
	const keys = v === 1 ? ["schemaVersion", "aliases"] : ["schemaVersion", "aliases", "pi"];
	if (Object.keys(r).some((k) => !keys.includes(k))) return shape;
	const a = r.aliases;
	if (typeof a !== "object" || a === null || Array.isArray(a)) return shape;
	const aliases: Record<string, string> = {};
	for (const [k, t] of Object.entries(a)) {
		if (!isProfileName(k) || typeof t !== "string" || !isProfileName(t) || k === t) return shape;
		aliases[k] = t;
	}
	if (r.pi === undefined) return { schemaVersion: v, aliases };
	const pi = r.pi;
	if (typeof pi !== "object" || pi === null || Array.isArray(pi) || Object.keys(pi).some((k) => k !== "version")) return shape;
	const pin = (pi as Record<string, unknown>).version;
	if (!isPin(pin)) return "hub.json: pi.version is not a Pi version pin (an exact version such as 1.1.0, or ^, ~ or >= before one)";
	return { schemaVersion: 2, aliases, pin };
}

/** hub.json as push writes it: schema 1 without a pin, so a pi-profile older than issue 34 still reads it. */
function hubJsonBytes(aliases: Readonly<Record<string, string>>, pin: string | undefined): Buffer {
	const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const body = pin === undefined ? { schemaVersion: 1, aliases: sorted } : { schemaVersion: 2, aliases: sorted, pi: { version: pin } };
	return Buffer.from(`${JSON.stringify(body, null, "\t")}\n`);
}

/** The sync rules a staged profile carries in its own staged `profile.json`. */
function stagedRules(bytes: Buffer | undefined): SyncRules | string {
	if (bytes === undefined) return { include: [], exclude: [], sessionDirs: [], allowFindings: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch {
		return "profile.json is not valid JSON";
	}
	const sync = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).sync : undefined;
	if (sync === undefined) return { include: [], exclude: [], sessionDirs: [], allowFindings: [] };
	const s = parseSyncSetting(sync);
	if (!s.ok) return `profile.json: ${s.errors.join("; ")}`;
	return { include: s.value.include ?? [], exclude: s.value.exclude ?? [], sessionDirs: [], allowFindings: s.value.allowFindings ?? [] };
}

/**
 * The commit gate: every path in hub tree `tree`, checked again from the
 * staged bytes alone, before it may be committed. Each path must be
 * `hub.json` (its schema) or `profiles/<name>/<path>` as a plain file; no
 * segment may be a credential name (`auth.json` and every other secret
 * name, the profile name included); the path must be class `config` under
 * the sync rules of the staged `profile.json`; and the credential scan of
 * its bytes must be clean. Returns the problems: locations, never values.
 */
export function gateTree(gitDir: string, tree: string, env: Env = process.env): GateProblem[] {
	const g: Git = { dir: gitDir, env: gitEnv(env) };
	const entries = treeEntries(g, tree);
	// A blob over the scan limit is refused unread, so a hostile hub cannot make a pull read a huge file.
	const big = (e: Entry): boolean => e.size === undefined || e.size > MAX_SCAN_BYTES;
	const blobs = readBlobs(g, [...entries.values()].filter((e) => e.type === "blob" && !big(e)).map((e) => e.sha));
	const bytesOf = (path: string): Buffer | undefined => {
		const e = entries.get(path);
		return e === undefined || e.type !== "blob" ? undefined : blobs.get(e.sha);
	};
	const problems: GateProblem[] = [];
	const no = (path: string, reason: string): void => {
		problems.push({ path, reason });
	};
	const rulesOf = new Map<string, SyncRules | string>();
	const hubJson = parseHubJson(bytesOf(HUB_JSON));
	if (typeof hubJson === "string") no(HUB_JSON, hubJson);
	for (const [path, e] of entries) {
		const segs = path.split("/");
		if (segs.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || /[\p{Cc}]/u.test(s))) {
			no(path, "not a plain relative path");
			continue;
		}
		if (segs.some(isSecretSegment)) {
			no(path, "a credential file name; auth.json and other secrets never go to the hub");
			continue;
		}
		if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) {
			no(path, `not a plain file (mode ${e.mode})`);
			continue;
		}
		if (big(e)) {
			no(path, "larger than 1 MiB, not scanned");
			continue;
		}
		if (path === HUB_JSON) continue;
		const name = segs[1] ?? "";
		if (segs[0] !== PROFILES || segs.length < 3 || !isSelectableName(name)) {
			no(path, "outside profiles/<name>/");
			continue;
		}
		if (typeof hubJson !== "string" && name in hubJson.aliases) {
			no(path, `${name} is an alias and holds no files`);
			continue;
		}
		let rules = rulesOf.get(name);
		if (rules === undefined) {
			rules = stagedRules(bytesOf(`${PROFILES}/${name}/profile.json`));
			rulesOf.set(name, rules);
		}
		if (typeof rules === "string") {
			no(path, rules);
			continue;
		}
		const rel = segs.slice(2).join("/");
		const bytes = bytesOf(path) ?? Buffer.alloc(0);
		const c = classifyContent(rel, rules, bytes);
		if (c.cls !== "config") {
			no(path, `class ${c.cls}${c.why === undefined ? "" : `: ${UNKNOWN_REASONS[c.why]}`}; only config goes to the hub`);
			continue;
		}
		const scan = scanContent(rel, rules, bytes);
		if (!scan.ok) no(path, scan.reason.slice(printable(rel).length + 2));
	}
	return problems;
}

/** A staged path the commit gate refuses: where, and why. Never a value. */
export interface GateProblem {
	readonly path: string;
	readonly reason: string;
}

export function shownProblems(ps: readonly GateProblem[]): string {
	return ps.map((x) => `${printable(x.path)}: ${x.reason}`).join("\n  ");
}

function moved(r: GitResult): boolean {
	return /^!\t.*\[rejected\]/m.test(r.stdout.toString("utf8")) || /\[rejected\]|fetch first|non-fast-forward/.test(r.stderr);
}

/**
 * Refuse a push that would remove from hub `hub` a file of a profile in `ps`
 * that this host has not seen: one the last pull from `hub` left out (the
 * profile is held there), or one `state/sync/last.json` has no record of at the blob the hub
 * holds (never pulled or pushed from here). Such a file came from another
 * host; rebuilding the profile without it would delete it from the hub, and
 * from that host on its next pull. This does not rest on the mirror's `main`
 * staying behind the hub: `sync init` sets it to the hub head.
 */
function refuseUnseen(l: Layout, hub: string, ps: readonly Prepared[], entries: ReadonlyMap<string, Entry>, state: SyncState): void {
	for (const p of ps) {
		const rec = state.profiles.get(p.name);
		const recorded = rec?.hub === hub ? rec.files : new Map<string, FileRecord>();
		// A hold belongs to the hub the pull that made it read: the record's hub (issue 52).
		if (rec?.hub === hub && rec.held !== undefined && rec.held.length > 0) {
			throw new Refusal(
				`${p.name}: the last sync pull left out hub files that are not config on this host: ${rec.held.map(printable).join(", ")}. ` +
					`A push would remove them from hub ${hub}, so nothing was pushed.\n${holdWayOut(p.name)}, then sync push again.`,
			);
		}
		const prefix = `${PROFILES}/${p.name}/`;
		const unseen: string[] = [];
		for (const [path, e] of entries) {
			if (!path.startsWith(prefix)) continue;
			const rel = path.slice(prefix.length);
			if (p.kind === "files" && (p.kept.has(rel) || p.files.has(rel))) continue;
			if (recorded.get(rel)?.hub !== e.sha) unseen.push(rel);
		}
		if (unseen.length > 0 && p.kind === "alias") {
			// `sync pull` refuses to write files into a link, so "pull first" alone is no way out (issue 51).
			throw new Refusal(
				`${p.name}: ${p.name} is a link to ${p.target} here, and hub ${hub} holds files for ${p.name} this host has not pulled: ${unseen.map(printable).join(", ")}. ` +
					`Pushing ${p.name} as an alias would remove them from the hub, so nothing was pushed.\n` +
					`To keep them, pull them into a real ${p.name}, move that copy to the trash (${printable(trashDir(l))}), link ${p.name} again, and push:\n${aliasSteps(l, p.name, p.target)}`,
			);
		}
		if (unseen.length > 0) {
			throw new Refusal(
				`${p.name}: a push would remove from hub ${hub} files this host has not pulled: ${unseen.map(printable).join(", ")}. Nothing was pushed.\n` +
					`run pi-profile sync pull ${p.name} first; if it leaves ${p.name} not pulled in full, ${holdWayOut(p.name)}.`,
			);
		}
	}
}

/**
 * The steps that let profile `name`, a link to `target` here, be pushed as an
 * alias when the hub holds files for it this host never pulled: pull them
 * into a real `name`, keep that copy in the trash, link again, push
 * (issue 51). One command a line, numbered. `delete` refuses the
 * global default, so when `name` is it, the steps clear it before the
 * delete and set it again once the link is back.
 */
export function aliasSteps(l: Layout, name: string, target: string): string {
	const link = printable(join(profilesRoot(l), name));
	let isDefault: boolean;
	try {
		isDefault = getGlobalDefault(l) === name;
	} catch (error) {
		// A broken default file: `delete` refuses with its own way out, naming the file.
		if (!(error instanceof Refusal)) throw error;
		isDefault = false;
	}
	return [
		`rm ${shellQuote(link)}`,
		"pi-profile sync pull",
		...(isDefault ? ["pi-profile default clear"] : []),
		`pi-profile delete ${name} --yes`,
		`ln -s ${shellQuote(printable(target))} ${shellQuote(link)}`,
		...(isDefault ? [`pi-profile default set ${name}`] : []),
		`pi-profile sync push ${name}`,
	]
		.map((s, i) => `  ${String(i + 1)}. ${s}`)
		.join("\n");
}

/** The files of profile `name` in a hub tree, as path → blob. */
function profileView(entries: ReadonlyMap<string, Entry>, name: string): Map<string, string> {
	const prefix = `${PROFILES}/${name}/`;
	const view = new Map<string, string>();
	for (const [path, e] of entries) if (path.startsWith(prefix)) view.set(path.slice(prefix.length), e.sha);
	return view;
}

function sameView(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	return a.size === b.size && [...a].every(([rel, sha]) => b.get(rel) === sha);
}

/**
 * Whether a push of `ps` to hub `hub` builds on the fetched hub head `tip`
 * instead of the mirror's `main`. A pull with names can take a profile past
 * `main` while the hub's other profiles stay to be pulled, and `main` stays
 * (issue 48: `sync pull --keep-local p`). A push built on that
 * stale `main` would compare with copies this host no longer holds, and
 * could not land. So it builds on `tip` when `main` is an ancestor of it,
 * and each pushed profile is either a real profile here whose record has
 * no hold and names exactly the files `tip` holds for it at the same blobs,
 * with no alias for it in `tip`, or an alias that `tip` names an alias of
 * nothing else; and a pushed profile is an alias, or at least one record no
 * longer matches `main`. Then the push changes only the pushed profiles and
 * keeps every other profile as the hub holds it. For an alias, `refuseUnseen`
 * then runs on `tip`'s files for it, so the push removes only files this
 * host recorded at the blobs `tip` holds, and refuses with the alias steps
 * otherwise. An alias needs no record past `main`: when the hub holds files
 * for a link, a full pull leaves the link and keeps `main` (it never writes
 * into a link), so after the alias steps a push on `main` could not land
 * while another profile is held or moved again (issue 51). When
 * every record of a real profile still matches `main`, the push builds on
 * `main` as before, so a hub that moved is refused and the user pulls
 * first.
 */
function pulledPastMain(g: Git, hub: string, ps: readonly Prepared[], state: SyncState, main: string, tip: string): boolean {
	const ancestor = runGit(g, ["merge-base", "--is-ancestor", main, tip]);
	if (ancestor.status !== 0 || ancestor.error !== undefined) return false;
	const atTip = treeEntries(g, tip);
	const atMain = treeEntries(g, main);
	const hubJson = atTip.get(HUB_JSON);
	const aliases = parseHubJson(hubJson === undefined ? undefined : readBlobs(g, [hubJson.sha]).get(hubJson.sha));
	if (typeof aliases === "string") return false;
	let past = false;
	for (const p of ps) {
		const named = aliases.aliases[p.name];
		if (p.kind === "alias") {
			// An alias removes the profile's files: refuseUnseen, run on `tip`, refuses unless this host recorded each one at the blob
			// `tip` holds. A full pull never moves `main` past a link whose files the hub holds, so a push on `main` could not land.
			if (named !== undefined && named !== p.target) return false;
			past = true;
			continue;
		}
		const rec = state.profiles.get(p.name);
		if (named !== undefined || rec === undefined || rec.hub !== hub || (rec.held !== undefined && rec.held.length > 0)) return false;
		const seen = new Map([...rec.files].map(([rel, f]) => [rel, f.hub]));
		if (!sameView(seen, profileView(atTip, p.name))) return false;
		if (!sameView(seen, profileView(atMain, p.name))) past = true;
	}
	return past;
}

/** The hub.json of tree `entries`, parsed, or why it is invalid. */
function hubJsonAt(g: Git, entries: ReadonlyMap<string, Entry>): ReturnType<typeof parseHubJson> {
	const e = entries.get(HUB_JSON);
	return parseHubJson(e === undefined ? undefined : readBlobs(g, [e.sha]).get(e.sha));
}

/** Build, gate, commit and push the profiles `ps` of hub `hub`. */
function pushHub(l: Layout, hub: string, remote: string, ps: readonly Prepared[], host: string, env: Env, hooks: PushHooks, dropped: SkippedPath[]): HubPush {
	const g = openMirror(l, hub, remote, env);
	const dir = g.dir;
	// The caller holds the sync lock, so a stage folder here was left by a push that was killed.
	for (const name of readdirSync(dir)) if (name.startsWith(STAGE_PREFIX)) rmSync(join(dir, name), { recursive: true, force: true });
	// Read before anything is sent: a broken last.json refuses with the hub as it was (issue 49).
	let state: SyncState;
	try {
		state = readSyncState(l);
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(`hub ${hub}: nothing was pushed: ${error.message}`);
		throw error;
	}
	let localPin: ReturnType<typeof readPinState>;
	try {
		localPin = readPinState(l);
	} catch (error) {
		if (error instanceof Refusal) throw new Refusal(`hub ${hub}: nothing was pushed: ${error.message}`);
		throw error;
	}
	const main = commitAt(g, MAIN);
	const tip = commitAt(g, ORIGIN_MAIN);
	const onTip = main !== undefined && tip !== undefined && tip !== main && pulledPastMain(g, hub, ps, state, main, tip);
	const base = onTip ? tip : main;
	const entries = base === undefined ? new Map<string, Entry>() : treeEntries(g, base);
	const hubJson = hubJsonAt(g, entries);
	if (typeof hubJson === "string") throw new Refusal(`hub ${hub}: ${hubJson}; fix the hub before pushing`);
	// The hub's pin is the fetched head's. `main` stays behind it while a profile is held, and the pull that settled a
	// diverged pin compared it with the head, so reading `main` here would refuse a pin already settled.
	const headJson = tip === undefined || tip === base ? hubJson : hubJsonAt(g, treeEntries(g, tip));
	if (typeof headJson === "string") throw new Refusal(`hub ${hub}: ${headJson}; fix the hub before pushing`);
	const mine = localPin.get(hub);
	// A pin waiting here never replaces one another host set since this host last agreed with the hub (issue 54).
	if (pinDiverged(mine, headJson.pin)) {
		const theirs = headJson.pin === undefined ? "another host removed the Pi version pin" : `another host set the Pi version pin ${shownPin(headJson.pin)}`;
		const here = mine?.pin === undefined ? "this host's removal of its pin" : `this host's pin ${shownPin(mine.pin)}`;
		throw new Refusal(`hub ${hub}: ${theirs}, and ${here} is not pushed yet; nothing was pushed.\nrun pi-profile sync pull first: it names the ways to settle the pin.`);
	}
	refuseUnseen(l, hub, ps, entries, state);
	const aliases = { ...hubJson.aliases };
	const pending = new Map<string, Blob>();
	for (const p of ps) {
		const prefix = `${PROFILES}/${p.name}/`;
		for (const path of [...entries.keys()]) {
			if (!path.startsWith(prefix)) continue;
			if (p.kind === "files" && p.kept.has(path.slice(prefix.length))) continue;
			entries.delete(path);
		}
		if (p.kind === "alias") aliases[p.name] = p.target;
		else {
			delete aliases[p.name];
			for (const [rel, b] of p.files) pending.set(prefix + rel, b);
		}
	}
	// A pin set here and not pushed yet replaces the hub's; otherwise the hub keeps its own (issue 34).
	const pin = pinPending(mine) ? mine?.pin : hubJson.pin;
	const pinMoved = pin !== hubJson.pin;
	pending.set(HUB_JSON, { mode: "100644", bytes: hubJsonBytes(aliases, pin) });
	hooks.beforeGate?.((path, bytes) => {
		pending.set(path, { mode: "100644", bytes });
	});
	const scratch = mkdtempSync(join(dir, STAGE_PREFIX));
	try {
		const list = [...pending];
		const shas = writeBlobs(g, list.map(([, b]) => b.bytes), scratch);
		const staged = new Set<string>();
		list.forEach(([path, b], i) => {
			entries.set(path, { mode: b.mode, type: "blob", sha: shas[i] as string });
			staged.add(path);
		});
		const index = { GIT_INDEX_FILE: join(scratch, "index") };
		const writeTree = (): string => {
			git(g, ["read-tree", "--empty"], { env: index });
			const info = [...entries].map(([path, e]) => `${e.mode} ${e.sha}\t${path}\0`).join("");
			git(g, ["update-index", "-z", "--index-info"], { input: info, env: index });
			return gitLine(g, ["write-tree"], index);
		};
		let tree = writeTree();
		let problems = gateTree(dir, tree, env);
		// A skipped file keeps the hub's last copy, unless that copy no longer passes the gate (its rules changed): then it leaves the hub.
		const stale = problems.filter((x) => !staged.has(x.path) && ps.some((p) => x.path.startsWith(`${PROFILES}/${p.name}/`)));
		if (stale.length === problems.length && stale.length > 0) {
			for (const x of stale) {
				entries.delete(x.path);
				dropped.push({ profile: x.path.split("/")[1] as string, path: x.path.split("/").slice(2).join("/"), reason: `its last copy in the hub was removed: ${x.reason}` });
			}
			tree = writeTree();
			problems = gateTree(dir, tree, env);
		}
		if (problems.length > 0) throw new Refusal(`refused to commit to hub ${hub}; nothing was pushed:\n  ${shownProblems(problems)}`);
		const names = ps.map((p) => p.name);
		const shaOf = (path: string): string | undefined => entries.get(path)?.sha;
		const pinned = { pin, moved: pinMoved, ...(hubJson.pin === undefined ? {} : { from: hubJson.pin }) };
		if (base !== undefined && gitLine(g, ["rev-parse", `${base}^{tree}`]) === tree) return recorded(l, hub, ps, dropped, shaOf, undefined, pinned);
		const who = { GIT_AUTHOR_NAME: host, GIT_AUTHOR_EMAIL: `pi-profile@${host}`, GIT_COMMITTER_NAME: host, GIT_COMMITTER_EMAIL: `pi-profile@${host}` };
		const subject = names.length === 0 ? "Pi version pin" : names.join(", ");
		const commit = git(g, ["commit-tree", tree, ...(base === undefined ? [] : ["-p", base]), "-m", `${host}: ${subject}`], { env: who }).toString("utf8").trim();
		const r = runGit(g, ["push", "--porcelain", "--quiet", "origin", `${commit}:${MAIN}`], { timeoutMs: NETWORK_MS });
		if (r.status !== 0 || r.error !== undefined) {
			if (r.error === undefined && moved(r)) {
				const f = fetch(g);
				const fetched = f.status === 0 ? "fetched it" : `could not fetch it: ${said(f)}`;
				throw new Refusal(`hub ${hub} has commits this host has not pulled (${fetched}). Nothing was merged or pushed.\nrun pi-profile sync pull first, then sync push again.`);
			}
			throw new Error(`git push to hub ${hub} failed: ${said(r)}`);
		}
		// Built on the hub head past main, the commit holds other profiles this host has not pulled: main stays, so a push of
		// one of them is still refused until a full pull (see pulledPastMain).
		if (!onTip) git(g, ["update-ref", MAIN, commit, base ?? ""]);
		git(g, ["update-ref", ORIGIN_MAIN, commit]);
		return recorded(l, hub, ps, dropped, shaOf, commit, pinned);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The result of a push that landed (or found the hub up to date), once
 * recorded. When the record cannot be written, the push is still reported
 * as pushed, with a warning that names the file: the hub holds it, and a
 * retry is not needed (issue 49).
 */
function recorded(
	l: Layout,
	hub: string,
	ps: readonly Prepared[],
	dropped: readonly SkippedPath[],
	shaOf: (path: string) => string | undefined,
	commit: string | undefined,
	pinned: { readonly pin: string | undefined; readonly moved: boolean; readonly from?: string },
): HubPush {
	const names = ps.map((p) => p.name);
	const moved = pinned.moved ? { pin: { ...(pinned.pin === undefined ? {} : { to: pinned.pin }), ...(pinned.from === undefined ? {} : { from: pinned.from }) } } : {};
	const done = { hub, profiles: names, ...(commit === undefined ? {} : { commit }), ...moved };
	const what = commit === undefined ? "already holds this host's config" : `pushed ${commit.slice(0, 12)}`;
	const warnings: string[] = [];
	try {
		recordPushed(l, hub, ps, dropped, shaOf);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		warnings.push(
			`hub ${hub}: ${what}, but it could not be recorded in ${syncStatePath(l)}: ${error.message}\n` +
				`no need to push again; make that file writable and valid (or remove it), then run pi-profile sync pull to record it`,
		);
	}
	// Its own try, so a failure names pin.json, never last.json (issue 57).
	try {
		// The hub holds this pin now: this host agrees with it, and it is no longer waiting to be pushed.
		const pins = readPinState(l);
		pins.set(hub, pinned.pin === undefined ? {} : { pin: pinned.pin, agreed: pinned.pin });
		writePinState(l, pins);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const holds = pinned.pin === undefined ? "no Pi version pin" : `the Pi version pin ${shownPin(pinned.pin)}`;
		warnings.push(
			`hub ${hub}: ${what}, and the hub holds ${holds}, but it could not be recorded in ${pinStatePath(l)}: ${error.message}\n` +
				`no need to push again; make that file writable and valid (or remove it), then run pi-profile sync pull to record the hub's pin`,
		);
	}
	return warnings.length === 0 ? done : { ...done, warning: warnings.join("\n") };
}

/**
 * After a push, the hub holds what this host pushed: record each file's blob
 * as the copy both sides agree on, so `sync pull` can tell a later edit on
 * either side. A file the push skipped keeps its earlier record; one the hub
 * dropped loses it.
 */
function recordPushed(l: Layout, hub: string, ps: readonly Prepared[], dropped: readonly SkippedPath[], shaOf: (path: string) => string | undefined): void {
	const state = readSyncState(l);
	for (const p of ps) {
		if (p.kind === "alias") {
			state.profiles.delete(p.name);
			continue;
		}
		const before = state.profiles.get(p.name)?.files ?? new Map<string, FileRecord>();
		const files = new Map<string, FileRecord>();
		for (const [rel, b] of p.files) {
			const sha = shaOf(`${PROFILES}/${p.name}/${rel}`);
			if (sha !== undefined && b.local !== undefined) files.set(rel, { local: b.local, hub: sha, ...(b.rendered === undefined ? {} : { rendered: b.rendered }) });
		}
		for (const rel of p.kept) {
			const was = before.get(rel);
			if (was !== undefined && !dropped.some((d) => d.profile === p.name && d.path === rel)) files.set(rel, was);
		}
		state.profiles.set(p.name, { hub, files });
	}
	writeSyncState(l, state);
}

/**
 * `sync push [NAME...]`: commit each profile's portable layer to its hub
 * (`sync.hub`, else `default`) as `<host>: <profiles>` and push. With no
 * names, every profile; a profile that cannot be prepared is then listed and
 * left out. A file `pushable` refuses is skipped and listed, never aborting
 * the push. The whole commit is refused if the gate (`gateTree`) finds any
 * staged path that is not config, a credential name, or a credential.
 * Each profile is read under its lock. A hub that fails does not stop the
 * others: `hubs` holds a result or a failure for each.
 */
export function pushHubs(l: Layout, names: readonly string[], opts: { readonly env?: Env; readonly hooks?: PushHooks } = {}): PushReport {
	const env = opts.env ?? process.env;
	const hooks = opts.hooks ?? {};
	const config: MachineConfig = loadConfig(l, env);
	const hubs = config.hubs ?? {};
	if (Object.keys(hubs).length === 0) throw new Refusal("no config hub: run pi-profile sync init REMOTE first");
	const home = env.HOME ?? homedir();
	if (!isTokenRoot(home)) throw new Refusal("the home directory must be an absolute, normalised path");
	const setup = tokenHost(config, home);
	const host = localHost(l, env);
	const all = names.length === 0;
	const chosen = all ? listProfiles(l) : [...new Set(names)];
	const skipped: SkippedPath[] = [];
	const skippedProfiles: Array<{ profile: string; reason: string }> = [];
	const warnings: string[] = [...setup.warnings];
	const byHub = new Map<string, Prepared[]>();
	const root = hubsDir(l);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return withProfileLock(root, () => {
		for (const name of chosen) {
			try {
				const p = prepare(l, config, name, setup.host, skipped, warnings, hooks);
				if (hubs[p.hub] === undefined) throw new Refusal(`${name}: hub ${p.hub} is not configured (pi-profile sync init REMOTE${p.hub === DEFAULT_HUB ? "" : ` --hub ${p.hub}`})`);
				byHub.set(p.hub, [...(byHub.get(p.hub) ?? []), p]);
			} catch (error) {
				if (!all || !(error instanceof Refusal)) throw error;
				skippedProfiles.push({ profile: name, reason: error.message });
			}
		}
		// A hub no profile here follows is visited too when its pin waits, with a commit of hub.json only (issue 55).
		// Only with no names: a push of named profiles sends those profiles. A broken pin.json is reported by each hub's push.
		if (all) {
			let waiting: string[] = [];
			try {
				const pins = readPinState(l);
				waiting = Object.keys(hubs).filter((h) => !byHub.has(h) && pinPending(pins.get(h)));
			} catch (error) {
				if (!(error instanceof Refusal)) throw error;
			}
			for (const h of waiting) byHub.set(h, []);
		}
		const pushed: HubPush[] = [];
		for (const [hub, ps] of [...byHub].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			const dropped: SkippedPath[] = [];
			try {
				pushed.push(pushHub(l, hub, (hubs[hub] as { remote: string }).remote, ps, host, env, hooks, dropped));
				skipped.push(...dropped);
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				pushed.push({ hub, profiles: ps.map((p) => p.name), failed: { message: error.message, refused: error instanceof Refusal } });
			}
		}
		const aliases = [...byHub.values()].flat().flatMap((p) => (p.kind === "alias" ? [{ profile: p.name, target: p.target }] : []));
		return { hubs: pushed, skipped, skippedProfiles, aliases, warnings };
	});
}
