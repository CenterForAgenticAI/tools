import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { archiveSessions, findArchived, restoreSession, storeOf, type ArchiveResult, type RestoreResult } from "./archive.ts";
import { parseDays, type ArchiveSettings } from "./archivesettings.ts";
import { scheduleFiles, startCommands, type ScheduleEnv } from "./archiveschedule.ts";
import { CLI_PATH } from "./autobackup.ts";
import { processToolRunner, type ToolRunner } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { type Env, type Layout } from "./paths.ts";
import { listProfiles, loadProfile } from "./profiles.ts";
import { localHost } from "./repo.ts";
import { Refusal } from "./result.ts";
import { settingsSessionDir } from "./sessions.ts";

/** The home directory a command runs for: HOME when set, as Pi reads it, else the OS's. */
export function homeOf(env: Env): string {
	return env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
}

/** The archive settings, or a refusal that says how to set them. */
export function archiveSettings(l: Layout, env: Env): ArchiveSettings {
	const a = loadConfig(l, env).archive;
	if (a === undefined) throw new Refusal("no archive is set: add \"archive\": { \"store\": { \"kind\": \"local\", \"path\": \"/absolute/path\" } } to ~/.pi/pi-profile/config.json (see the README)");
	return a;
}

/**
 * A profile's session folder, as Pi finds it with no flag or variable set:
 * the profile's sessionDir setting, else <profile>/sessions. Profiles that
 * share a store yield the same folder once.
 */
export function sessionFolders(l: Layout, profiles: readonly string[], home: string = homedir()): string[] {
	const out: string[] = [];
	for (const name of profiles) {
		const set = settingsSessionDir(l, name);
		// Pi expands a leading ~ in sessionDir; so does this, or the folder would be skipped.
		const dir = set === undefined ? join(loadProfile(l, name).dir, "sessions") : set === "~" ? home : set.startsWith("~/") ? join(home, set.slice(2)) : set;
		const abs = resolve(dir);
		if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true && !out.includes(abs)) out.push(abs);
	}
	return out;
}

export interface ArchiveRun {
	readonly settings: ArchiveSettings;
	readonly host: string;
	readonly run: ToolRunner;
}

export function archiveRun(l: Layout, env: Env, run?: ToolRunner): ArchiveRun {
	return { settings: archiveSettings(l, env), host: localHost(l, env), run: run ?? processToolRunner };
}

export function archiveFolders(l: Layout, folders: readonly string[], r: ArchiveRun, apply: boolean, olderThan: string | undefined): ArchiveResult[] {
	const settings = olderThan === undefined ? r.settings : { ...r.settings, olderThanDays: parseDays(olderThan, "--older-than") };
	return folders.map((f) => archiveSessions(l, f, settings, { host: r.host, apply, run: r.run }));
}

/** A session path, or an archived session's id (or unique prefix) in one of the folders. */
export function resolveRestoreTarget(folders: readonly string[], arg: string): string {
	if (arg.includes("/") || arg.endsWith(".jsonl")) {
		const p = resolve(arg);
		if (!isAbsolute(p)) throw new Refusal("not a session path: " + arg);
		return p;
	}
	const hits = findArchived(folders, arg);
	if (hits.length === 0) throw new Refusal("no archived session with id " + arg + " in " + (folders.join(", ") || "any session folder"));
	if (hits.length > 1) throw new Refusal("id " + arg + " matches " + String(hits.length) + " archived sessions; give more of it, or the path");
	return hits[0] as string;
}

export function restoreOne(l: Layout, env: Env, path: string, run?: ToolRunner): RestoreResult {
	const settings = loadConfig(l, env).archive;
	return restoreSession(l, path, settings, { host: localHost(l, env), run: run ?? processToolRunner });
}

/**
 * A path for this Node that outlives an upgrade: the first `node` on PATH
 * that is the same binary but not in a versioned install (nvm, fnm, volta,
 * Homebrew's Cellar), else execPath itself.
 */
export function stableNode(execPath: string, path: string): string {
	const real = realOrUndefined(execPath);
	for (const d of path.split(":")) {
		if (!isAbsolute(d)) continue;
		const cand = join(d, "node");
		if (/\/(\.nvm|\.fnm|\.volta|Cellar)\/|\/v?\d+\.\d+\.\d+\//.test(cand)) continue;
		if (real !== undefined && realOrUndefined(cand) === real) return cand;
	}
	return execPath;
}

function realOrUndefined(p: string): string | undefined {
	try {
		return realpathSync(p);
	} catch {
		return undefined;
	}
}

/** Write the scheduler files for this platform; returns what was written and the commands that start it. */
export function installSchedule(l: Layout, env: Env, platform: string = process.platform): { written: string[]; unchanged: string[]; start: string[] } {
	archiveSettings(l, env);
	const home = homeOf(env);
	const path = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	const sched: ScheduleEnv = { node: stableNode(process.execPath, path), cli: CLI_PATH, piHome: l.piHome, path, log: join(l.piHome, "pi-profile", "state", "archive.log") };
	const files = scheduleFiles(platform, home, sched);
	const written: string[] = [];
	const unchanged: string[] = [];
	for (const f of files) {
		let current: string | undefined;
		try {
			current = readFileSync(f.path, "utf8");
		} catch {
			current = undefined;
		}
		if (current === f.text) {
			unchanged.push(f.path);
			continue;
		}
		mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
		writeFileAtomic(f.path, f.text, 0o644);
		written.push(f.path);
	}
	return { written, unchanged, start: startCommands(platform, files) };
}

export { listProfiles, storeOf };
