import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type MachineConfig } from "./config.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { backupStateDir, type BackupResult } from "./backup.ts";
import { LockBusy, removeStaleBreaker, withProfileLock } from "./lock.ts";
import { layoutFromEnv, type Env, type Layout } from "./paths.ts";

/**
 * Auto-backup on session end (design: the `session_shutdown` row of
 * "Operations"). The extension calls `autoBackupOnSessionEnd`; everything it
 * needs lives here so the extension stays thin and the rules are testable.
 */

/** `~/.pi/pi-profile/state/autobackup`: machine-local, never replicated (law L10). */
export function autoBackupStateDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "autobackup");
}
function lastStartPath(l: Layout): string {
	return join(autoBackupStateDir(l), "last.json");
}

/** The package's own CLI, found next to this module (src/core or dist/core), never on PATH. */
export const CLI_PATH = fileURLToPath(new URL("../../bin/pi-profile.mjs", import.meta.url));
export const BACKUP_ARGS: readonly string[] = ["backup", "run", "--quiet", "--auto"];
/** The same run started for a pending session end whose waiting run is gone: it waits for the interval first. */
export const RESCUE_ARGS: readonly string[] = [...BACKUP_ARGS, "--wait-first"];

/**
 * True when a session end should start a backup: `autoBackup.onSessionEnd` is
 * on and at least `minIntervalSeconds` have passed since the last start. A
 * last start in the future (the clock went back) does not hold backups off.
 */
export function shouldAutoBackup(config: MachineConfig, lastStart: number | undefined, now: number): boolean {
	const auto = config.autoBackup;
	if (auto === undefined || !auto.onSessionEnd) return false;
	if (lastStart === undefined || lastStart > now) return true;
	return now - lastStart >= auto.minIntervalSeconds * 1000;
}

interface AutoState {
	/** When the last auto-backup started, in ms since the epoch. */
	readonly lastStart: number | undefined;
	/** A session end was skipped and no run has started since. */
	readonly pending: boolean;
	/** The detached run that will act on `pending`, as processIdentity wrote it. */
	readonly waiter: string | undefined;
	/** The last start a waiting run was started again for, so that happens once per interval. */
	readonly rescuedFor: number | undefined;
}

const EMPTY: AutoState = { lastStart: undefined, pending: false, waiter: undefined, rescuedFor: undefined };

function isoMs(at: unknown): number | undefined {
	const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
	return Number.isFinite(ms) ? ms : undefined;
}

function readState(l: Layout): AutoState {
	try {
		const raw = readJson(lastStartPath(l));
		if (typeof raw !== "object" || raw === null) return EMPTY;
		const r = raw as Record<string, unknown>;
		return {
			lastStart: isoMs(r.lastStart),
			pending: r.pending === true,
			waiter: typeof r.waiter === "string" ? r.waiter : undefined,
			rescuedFor: isoMs(r.rescuedFor),
		};
	} catch {
		// A damaged state file must not stop backups for good; the next start rewrites it.
		return EMPTY;
	}
}

function writeState(l: Layout, s: AutoState): void {
	writeJsonAtomic(lastStartPath(l), {
		...(s.lastStart === undefined ? {} : { lastStart: new Date(s.lastStart).toISOString() }),
		...(s.pending ? { pending: true } : {}),
		...(s.waiter === undefined ? {} : { waiter: s.waiter }),
		...(s.rescuedFor === undefined ? {} : { rescuedFor: new Date(s.rescuedFor).toISOString() }),
	});
}

/** When the last auto-backup started, in ms since the epoch; undefined if never or unreadable. */
export function readLastStart(l: Layout): number | undefined {
	return readState(l).lastStart;
}

/** True when a session end was skipped and no run has started since. */
export function readPending(l: Layout): boolean {
	return readState(l).pending;
}

/** The registered waiting run ("<pid> <start>"), if any. */
export function readWaiter(l: Layout): string | undefined {
	return readState(l).waiter;
}

/** A process's state letter and start time (clock ticks since boot) from /proc; undefined where /proc has none. */
function procStat(pid: number): { state: string; start: string } | undefined {
	try {
		const text = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
		// Fields after the command name, which may itself hold spaces and ")": state is field 3, start time field 22.
		const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
		const state = rest[0];
		const start = rest[19];
		return state === undefined || start === undefined ? undefined : { state, start };
	} catch {
		return undefined;
	}
}

/**
 * "<pid> <start time>" where /proc gives the start time, else "<pid>". A
 * later process that reuses the PID has another start time, so it does not
 * match.
 */
export function processIdentity(pid: number): string {
	const stat = procStat(pid);
	return stat === undefined ? String(pid) : `${String(pid)} ${stat.start}`;
}

/**
 * True when the process `id` names is still running: it answers signal 0,
 * is not a zombie, and, when a start time was recorded, has that start time.
 */
export function processAlive(id: string | undefined): boolean {
	if (id === undefined) return false;
	const [p, start] = id.split(" ");
	const pid = Number(p);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	if (start === undefined) return true;
	const stat = procStat(pid);
	return stat !== undefined && stat.start === start && stat.state !== "Z" && stat.state !== "X";
}

/** Default sleep for the detached run: blocks the thread, which has nothing else to do. */
function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The waiting run's default sleep. It waits in `/`, not in the home it was
 * started in, so a long wait does not keep a removable home busy; the old
 * directory is restored before any work, when it still exists.
 */
function parkedSleep(ms: number): void {
	let here: string | undefined;
	try {
		here = process.cwd();
		process.chdir("/");
	} catch {
		// No usable working directory: sleep where we are.
	}
	try {
		sleepMs(ms);
	} finally {
		if (here !== undefined) {
			try {
				process.chdir(here);
			} catch {
				// The home went away meanwhile; the next config read ends the run.
			}
		}
	}
}

/** How often, and for how long in all, to retry the state lock while another process holds it briefly. */
const CLAIM_RETRIES = 10;
const CLAIM_RETRY_MS = 20;

/**
 * Run `fn` under the state directory's lock. Every holder keeps it for a
 * moment only, so a busy lock is retried for about 200 ms before giving up;
 * a session end then waits for a detached run's check of `pending` rather
 * than being lost beside it.
 */
function withStateLock<T>(l: Layout, fn: () => T, sleep: (ms: number) => void = sleepMs): T {
	const dir = autoBackupStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (let attempt = 1; ; attempt++) {
		try {
			return withProfileLock(dir, fn);
		} catch (error) {
			if (!(error instanceof LockBusy) || attempt >= CLAIM_RETRIES) throw error;
			sleep(CLAIM_RETRY_MS);
		}
	}
}

export interface ClaimHooks {
	/** Test seam: runs under the lock, after the state is read and before the new one is written. */
	readonly afterRead?: () => void;
}

/** What a session end did: started a run, started a waiting run for an orphaned `pending`, or nothing. */
export type Claim = "run" | "rescue" | "none";

/**
 * Decide what this session end starts, and start it, under the state
 * directory's lock; the clock is read under the lock too. So two sessions
 * ending at once cannot both claim one interval: the second either finds the
 * lock held (and throws a Refusal) or reads the first's start time.
 *
 * After the interval, it records `now` as the last start and launches a run.
 * Inside the interval it records `pending`, which a live waiting run picks up
 * (see runAutoBackup). When no live run is registered (killed, capped, or
 * exited early), it launches one that waits out the interval first, at most
 * once per interval. `launch` returns the started process's PID, which is
 * registered as the waiter before the lock is released.
 */
export function claimAutoBackup(l: Layout, config: MachineConfig, now: () => number, launch: (waitFirst: boolean) => number | undefined, hooks: ClaimHooks = {}): Claim {
	if (config.autoBackup?.onSessionEnd !== true) return "none";
	return withStateLock(l, () => {
		const at = now();
		const st = readState(l);
		hooks.afterRead?.();
		if (shouldAutoBackup(config, st.lastStart, at)) {
			const pid = launch(false);
			writeState(l, { ...st, lastStart: at, pending: false, waiter: pid === undefined ? undefined : processIdentity(pid) });
			return "run";
		}
		if (processAlive(st.waiter) || (st.rescuedFor !== undefined && st.rescuedFor === st.lastStart)) {
			if (!st.pending) writeState(l, { ...st, pending: true });
			return "none";
		}
		const pid = launch(true);
		writeState(l, { ...st, pending: true, waiter: pid === undefined ? undefined : processIdentity(pid), rescuedFor: st.lastStart });
		return "rescue";
	});
}

/** How one `backup run` went: done, refused because another run holds the backup lock, or failed. */
export type RunOutcome = "done" | "busy" | "failed";

/** At most this many extra runs follow the first, however many session ends were skipped. */
export const MAX_TRAILING_RUNS = 3;
/** The waiting run re-reads the config at least this often, so turning auto-backup off ends the wait. */
export const WAIT_STEP_MS = 60_000;

export interface RunDeps {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => void;
	/** Wait out the interval before the first run (`--wait-first`, the rescue launch). */
	readonly waitFirst?: boolean;
	/** This run's processIdentity; defaults to the current process's. */
	readonly self?: string;
}

/**
 * The detached run's work (`backup run --auto`). Run once, then wait until
 * the interval since the last start has passed. If a session end was skipped
 * meanwhile (`pending`), clear the flag, record the start and run once more.
 * A run refused because another backup is in progress counts as skipped. At
 * most MAX_TRAILING_RUNS extra runs; a flag still set after that is left for
 * the next session end, which starts a waiting run for it. On any exit, it
 * removes its own registration as the waiter.
 */
export function runAutoBackup(l: Layout, env: Env, runOnce: () => RunOutcome, deps: RunDeps = {}): void {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? parkedSleep;
	const self = deps.self ?? processIdentity(process.pid);
	try {
		for (let extra = 0; ; extra++) {
			if ((extra > 0 || deps.waitFirst !== true) && runOnce() === "busy") {
				withStateLock(l, () => writeState(l, { ...readState(l), pending: true }), sleep);
			}
			if (extra >= MAX_TRAILING_RUNS || !claimTrailingRun(l, env, now, sleep)) return;
		}
	} finally {
		unregister(l, self, sleep);
	}
}

/** Drop this run's waiter registration if it is still there; never recreates a removed home. */
function unregister(l: Layout, self: string, sleep: (ms: number) => void): void {
	try {
		if (!existsSync(lastStartPath(l))) return;
		withStateLock(l, () => {
			const st = readState(l);
			if (st.waiter === self) writeState(l, { ...st, waiter: undefined });
		}, sleep);
	} catch {
		// The liveness check covers a registration left behind.
	}
}

/**
 * Wait out the interval of this run's start, then claim a run if a session
 * end is pending. False when there is nothing to do, or when another session
 * end has claimed a new interval: its own run waits on it instead. The start
 * is read under the lock, so a launching session end has registered it.
 */
function claimTrailingRun(l: Layout, env: Env, now: () => number, sleep: (ms: number) => void): boolean {
	const mine = withStateLock(l, () => readLastStart(l), sleep);
	for (;;) {
		const config = loadConfig(l, env);
		const auto = config.autoBackup;
		if (auto === undefined || !auto.onSessionEnd || readLastStart(l) !== mine) return false;
		if (mine !== undefined && !shouldAutoBackup(config, mine, now())) {
			sleep(Math.min(WAIT_STEP_MS, mine + auto.minIntervalSeconds * 1000 - now()));
			continue;
		}
		return withStateLock(l, () => {
			const st = readState(l);
			if (!st.pending || st.lastStart !== mine) return false;
			writeState(l, { ...st, lastStart: now(), pending: false });
			return true;
		}, sleep);
	}
}

/** What the launcher needs to know about the process it runs in. */
export interface Runtime {
	readonly execPath: string;
	/** `process.versions.bun`: set when the host is Bun, or a Bun-compiled binary. */
	readonly bunVersion: string | undefined;
	/** `process.release.name`: "node" for Node. */
	readonly releaseName: string;
	/** True inside a Node single-executable application, whose execPath is the app, not Node. */
	readonly isSea: () => boolean;
}

function processIsSea(): boolean {
	// node:sea's isSea() is newer than single-executable applications; a missing one reads as "not SEA".
	const sea = process.getBuiltinModule("node:sea") as { isSea?: () => boolean } | undefined;
	return typeof sea?.isSea === "function" && sea.isSea();
}

export function currentRuntime(): Runtime {
	return { execPath: process.execPath, bunVersion: process.versions.bun, releaseName: process.release.name, isSea: processIsSea };
}

/**
 * The Node binary to run the CLI with, or undefined when execPath is not Node.
 * In a Bun or SEA build of Pi, execPath is Pi itself, and running it would
 * start a hidden Pi session rather than a backup. PATH is never searched.
 */
export function nodeExecPath(rt: Runtime): string | undefined {
	if (rt.bunVersion !== undefined || rt.releaseName !== "node") return undefined;
	try {
		if (rt.isSea()) return undefined;
	} catch {
		return undefined;
	}
	return rt.execPath;
}

/** The parts of a child process the launcher uses. */
export interface Launched {
	/** Undefined when the process could not be started. */
	readonly pid?: number | undefined;
	on(event: "error", listener: (error: Error) => void): unknown;
	unref(): void;
}
export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => Launched;

/**
 * Start `pi-profile backup run --quiet` with the Node binary `node` in its own process group with no
 * stdio and unreferenced, so the parent can exit at once and the run is not
 * killed with Pi's terminal. A late spawn error is ignored, not thrown.
 */
export function launchBackup(l: Layout, env: Env, node: string, spawn: Spawn = nodeSpawn): number | undefined {
	return launchCli(l, env, node, BACKUP_ARGS, spawn);
}

/** Start `pi-profile ARGS` detached, as launchBackup does; returns its PID when known. */
export function launchCli(l: Layout, env: Env, node: string, args: readonly string[], spawn: Spawn = nodeSpawn): number | undefined {
	const child = spawn(node, [CLI_PATH, ...args], {
		detached: true,
		stdio: "ignore",
		cwd: join(l.piHome, "pi-profile"),
		env: { ...env },
	});
	child.on("error", () => {
		// Nothing can be reported once Pi is exiting; the next session end tries again.
	});
	child.unref();
	return child.pid;
}

/** The parts of an attached child process startBackupRun uses. */
export interface Attached {
	readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown; unref?: () => void } | null;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: (code: number | null) => void): unknown;
	unref(): void;
}
export type AttachedSpawn = (command: string, args: readonly string[], options: SpawnOptions) => Attached;

/** How a `backup run --json` ended: its results, pi-profile's refusal, or a failure with no safe message. */
export type BackupRunOutcome =
	| { readonly kind: "results"; readonly results: readonly BackupResult[] }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "failed" };

export const BACKUP_JSON_ARGS: readonly string[] = ["backup", "run", "--json"];
/** More than any real `backup run --json` prints; output past it is a failure. */
const MAX_JSON_BYTES = 4 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseResult(v: unknown): BackupResult | undefined {
	if (!isRecord(v) || typeof v.id !== "string") return undefined;
	if (v.ok === false) return { id: v.id, ok: false, error: typeof v.error === "string" ? v.error : "" };
	if (v.ok !== true || (v.mode !== "rsync" && v.mode !== "staged") || typeof v.files !== "number" || typeof v.bytes !== "number" || typeof v.encrypted !== "boolean") return undefined;
	if (!Array.isArray(v.held) || !v.held.every((h) => typeof h === "string")) return undefined;
	return { id: v.id, ok: true, mode: v.mode, files: v.files, bytes: v.bytes, encrypted: v.encrypted, held: v.held as string[] };
}

/** Read `backup run --json` output and exit code; anything unexpected is a failure. */
export function parseBackupRun(stdout: string, code: number | null): BackupRunOutcome {
	let doc: unknown;
	try {
		doc = JSON.parse(stdout.trim().split("\n").pop() ?? "");
	} catch {
		return { kind: "failed" };
	}
	if (!isRecord(doc)) return { kind: "failed" };
	if (code === 2 && typeof doc.refused === "string") return { kind: "refused", message: doc.refused };
	if ((code !== 0 && code !== 1) || !Array.isArray(doc.results)) return { kind: "failed" };
	const results = doc.results.map(parseResult);
	if (results.length === 0 || results.some((r) => r === undefined)) return { kind: "failed" };
	return { kind: "results", results: results as BackupResult[] };
}

/**
 * Start `pi-profile backup run --json` with the Node binary `node`, attached
 * and off the event loop, and call `done` once with how it ended. Its stderr is
 * discarded: a tool's message can quote anything it read. The child is
 * unreferenced, so a running backup does not hold Pi open; it takes the same
 * backup lock as every other run.
 */
export function startBackupRun(l: Layout, env: Env, node: string, done: (outcome: BackupRunOutcome) => void, spawn: AttachedSpawn = nodeSpawn): void {
	startCliRun(l, env, node, BACKUP_JSON_ARGS, (run) => done(run === undefined ? { kind: "failed" } : parseBackupRun(run.stdout, run.code)), spawn);
}

/** What an attached CLI run printed on stdout, and its exit code. */
export interface CliRun {
	readonly stdout: string;
	readonly code: number | null;
}

/**
 * Start `pi-profile ARGS` with the Node binary `node`, attached and off the
 * event loop, and call `done` once with its stdout and exit code, or with
 * undefined when it could not start or printed more than any `--json` command
 * does. Its stderr is discarded: a tool's message can quote anything it read.
 * The child is unreferenced, so a running command does not hold Pi open.
 */
export function startCliRun(l: Layout, env: Env, node: string, args: readonly string[], done: (run: CliRun | undefined) => void, spawn: AttachedSpawn = nodeSpawn): void {
	let finished = false;
	const finish = (run: CliRun | undefined): void => {
		if (finished) return;
		finished = true;
		done(run);
	};
	const chunks: Buffer[] = [];
	let size = 0;
	const home = join(l.piHome, "pi-profile");
	const child = spawn(node, [CLI_PATH, ...args], {
		stdio: ["ignore", "pipe", "ignore"],
		// A missing cwd fails the spawn; with no config yet, the run refuses in its own words.
		...(existsSync(home) ? { cwd: home } : {}),
		env: { ...env },
	});
	child.on("error", () => finish(undefined));
	child.stdout?.on("data", (chunk) => {
		size += chunk.length;
		if (size <= MAX_JSON_BYTES) chunks.push(chunk);
	});
	child.on("close", (code) => finish(size > MAX_JSON_BYTES ? undefined : { stdout: Buffer.concat(chunks).toString("utf8"), code }));
	child.unref();
	child.stdout?.unref?.();
}

/**
 * A crash can leave a lock breaker that makes every later lock refuse, which
 * would turn auto-backup off without a word. Remove the state and backup
 * locks' breakers when they are provably stale (removeStaleBreaker).
 */
function clearLeftoverBreakers(l: Layout): void {
	for (const dir of [autoBackupStateDir(l), backupStateDir(l)]) {
		try {
			removeStaleBreaker(dir);
		} catch {
			// Left for `pi-profile doctor` to report.
		}
	}
}

export interface AutoBackupDeps {
	readonly spawn?: Spawn;
	readonly now?: () => number;
	readonly hooks?: ClaimHooks;
	readonly runtime?: Runtime;
}

/**
 * The extension's `session_shutdown` work. Never throws: a broken config, a
 * held lock or a failed spawn must not break Pi's shutdown. Returns whether a
 * backup run was started now; a waiting run started for an orphaned
 * `pending` (see claimAutoBackup) runs later and is not counted. When Pi does
 * not run on Node, it skips before claiming, so the interval is not used up.
 */
export function autoBackupOnSessionEnd(env: Env, deps: AutoBackupDeps = {}): boolean {
	try {
		const node = nodeExecPath(deps.runtime ?? currentRuntime());
		if (node === undefined) return false;
		const l = layoutFromEnv(env);
		const config = loadConfig(l, env);
		if (config.autoBackup?.onSessionEnd !== true) return false;
		clearLeftoverBreakers(l);
		const launch = (waitFirst: boolean): number | undefined => launchCli(l, env, node, waitFirst ? RESCUE_ARGS : BACKUP_ARGS, deps.spawn);
		return claimAutoBackup(l, config, deps.now ?? Date.now, launch, deps.hooks) === "run";
	} catch {
		return false;
	}
}
