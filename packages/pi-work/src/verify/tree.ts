import { realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import os from "node:os";

import { runGit } from "../git.js";
import { resolveVerifierExecutable, ExecutableResolutionError } from "./executable.js";
import type { TreeIdentity, TreeMonitoringProof, VerificationFailure } from "./results.js";

export interface TreeSnapshot {
	identity: TreeIdentity;
	clean: boolean;
	gitPath: string;
	excludesFile?: string;
}

export type TreeCheck = { ok: true; snapshot: TreeSnapshot } | { ok: false; failure: VerificationFailure };

export type TreeMonitor = {
	ok: true;
	changed: () => boolean;
	untrackedPaths: () => readonly string[];
	drain: () => Promise<void>;
	monitoring: () => TreeMonitoringProof;
	stop: () => void;
} | { ok: false; failure: VerificationFailure };

const DIRTY_PATH_LIMIT = 10;

function gitArgs(excludesFile: string | undefined, args: string[]): string[] {
	return excludesFile === undefined ? args : ["-c", `core.excludesFile=${excludesFile}`, ...args];
}

/** Resolve only the user's global ignore file; other global Git settings stay disabled. */
async function resolveUserExcludes(gitPath: string, worktreePath: string): Promise<string> {
	const home = process.env.HOME || os.homedir();
	const xdg = process.env.XDG_CONFIG_HOME;
	const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
	const fallback = path.join(configHome, "git", "ignore");
	const environment: NodeJS.ProcessEnv = { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
	if (xdg !== undefined) environment.XDG_CONFIG_HOME = xdg;
	const result = await runGit(gitPath, worktreePath, ["config", "--global", "--path", "--get", "--default", fallback, "core.excludesFile"], { environment });
	const configured = result.stdout.trim();
	return path.isAbsolute(configured) ? configured : path.resolve(home, configured);
}

async function gitStatus(gitPath: string, worktreePath: string, excludesFile: string): Promise<{ hasChanges: boolean; hasTrackedChanges: boolean; paths: string[]; count: number }> {
	let incomplete = "";
	let hasTrackedChanges = false;
	let count = 0;
	const paths: string[] = [];
	let skipRenameSource = false;
	const inspectEntry = (entry: string): void => {
		if (skipRenameSource) { skipRenameSource = false; return; }
		if (entry.length < 4) throw new Error("git status returned an invalid record");
		count += 1;
		if (entry.slice(0, 2) !== "??") hasTrackedChanges = true;
		if (paths.length < DIRTY_PATH_LIMIT) paths.push(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2))) skipRenameSource = true;
	};
	await runGit(gitPath, worktreePath, gitArgs(excludesFile, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), {
		environment: {},
		onStdout(chunk) {
			const entries = `${incomplete}${chunk}`.split("\0");
			incomplete = entries.pop() ?? "";
			for (const entry of entries) inspectEntry(entry);
		},
	});
	if (incomplete.length > 0 || skipRenameSource) throw new Error("git status returned an unterminated record");
	return { hasChanges: count > 0, hasTrackedChanges, paths, count };
}

function failure(code: VerificationFailure["code"], message: string): VerificationFailure {
	if (code === "tree-identity-unavailable") return { code, message };
	return { code: "tree-identity-unavailable", message };
}

/** Resolve and freeze the explicit target worktree and expected commit. */
export async function inspectTree(worktreePath: string, expectedCommit: string, options: { allowUntracked?: boolean; excludesFile?: string | undefined } = {}): Promise<TreeCheck> {
	if (worktreePath.length === 0 || expectedCommit.length === 0) {
		return { ok: false, failure: failure("tree-identity-unavailable", "worktreePath and expectedCommit are required") };
	}
	let canonicalInput: string;
	let gitPath: string;
	try {
		gitPath = await resolveVerifierExecutable("git");
	} catch (error) {
		if (error instanceof ExecutableResolutionError) return { ok: false, failure: { code: "executable-unavailable", message: error.message, executable: error.executable } };
		return { ok: false, failure: failure("tree-identity-unavailable", `cannot resolve verifier git: ${error instanceof Error ? error.message : String(error)}`) };
	}
	try {
		canonicalInput = await realpath(worktreePath);
	} catch (error) {
		return { ok: false, failure: failure("tree-identity-unavailable", `cannot resolve worktree: ${error instanceof Error ? error.message : String(error)}`) };
	}
	try {
		const excludesFile = options.excludesFile ?? await resolveUserExcludes(gitPath, canonicalInput);
		// Status can invoke a configured clean/process filter for attributed files.
		// Filter names are arbitrary, so fail closed rather than attempting to
		// override a guessed set of local commands.
		const localConfig = await runGit(gitPath, canonicalInput, ["config", "--local", "--includes", "--name-only", "--list"], { environment: {} });
		if (localConfig.stdout.split("\n").some((name) => /^filter\..+\.(?:clean|smudge|process)$/i.test(name))) {
			return { ok: false, failure: failure("tree-identity-unavailable", "repository-local Git filters cannot run during verifier tree inspection") };
		}
		const rootResult = await runGit(gitPath, canonicalInput, gitArgs(excludesFile, ["rev-parse", "--show-toplevel"]), { environment: {} });
		const root = await realpath(rootResult.stdout.trim());
		if (root !== canonicalInput) {
			return { ok: false, failure: failure("tree-identity-unavailable", `target is not the worktree root: ${canonicalInput}`) };
		}
		const [headResult, expectedResult, status] = await Promise.all([
			runGit(gitPath, root, gitArgs(excludesFile, ["rev-parse", "HEAD^{commit}"]), { environment: {} }),
			runGit(gitPath, root, gitArgs(excludesFile, [`rev-parse`, `${expectedCommit}^{commit}`]), { environment: {} }),
			gitStatus(gitPath, root, excludesFile),
		]);
		const head = headResult.stdout.trim();
		const expected = expectedResult.stdout.trim();
		if (head !== expected) {
			return { ok: false, failure: { code: "tree-mismatch", message: `expected ${expected}, found ${head}`, expected, actual: head } };
		}
		if (status.hasTrackedChanges || (!options.allowUntracked && status.hasChanges)) {
			return { ok: false, failure: { code: "tree-dirty", message: `target worktree is not clean: ${status.paths.map((name) => JSON.stringify(name)).join(", ")}${status.count > status.paths.length ? ` (and ${status.count - status.paths.length} more; ${status.count} total)` : ""}` } };
		}
		return { ok: true, snapshot: { identity: { kind: "git", worktreePath: root, resolvedCommit: head }, clean: true, gitPath, excludesFile } };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, failure: failure("tree-identity-unavailable", `git identity probe failed: ${detail}`) };
	}
}

/** Verify that no tracked/untracked mutation or commit movement occurred. */
export async function verifyTreeUnchanged(snapshot: TreeSnapshot): Promise<TreeCheck> {
	const current = await inspectTree(snapshot.identity.worktreePath, snapshot.identity.resolvedCommit, { allowUntracked: true, excludesFile: snapshot.excludesFile });
	if (!current.ok) {
		if (current.failure.code === "tree-dirty") return current;
		return { ok: false, failure: { code: "tree-changed", message: current.failure.message } };
	}
	if (current.snapshot.identity.worktreePath !== snapshot.identity.worktreePath || current.snapshot.identity.resolvedCommit !== snapshot.identity.resolvedCommit || current.snapshot.gitPath !== snapshot.gitPath || current.snapshot.excludesFile !== snapshot.excludesFile) {
		return { ok: false, failure: { code: "tree-changed", message: "target tree identity changed" } };
	}
	return current;
}

/** Watch the selected tree while evidence runs, including nested tracked paths. */
export async function monitorTree(snapshot: TreeSnapshot): Promise<TreeMonitor> {
	if (snapshot.identity.kind !== "git") return { ok: false, failure: { code: "tree-identity-unavailable", message: "tree monitoring requires a git identity" } };
	const gitPath = snapshot.gitPath;
	let changed = false;
	const untracked = new Set<string>();
	const tracked = new Set<string>();
	const trackedDirectories = new Set<string>();
	const addTrackedPath = (relative: string): void => {
		if (relative.length === 0) return;
		const normalized = relative.split(path.sep).join("/");
		tracked.add(normalized);
		let directory = path.posix.dirname(normalized);
		while (directory !== ".") {
			trackedDirectories.add(directory);
			directory = path.posix.dirname(directory);
		}
	};
	let incompletePath = "";
	try {
		await runGit(gitPath, snapshot.identity.worktreePath, gitArgs(snapshot.excludesFile, ["ls-files", "-z"]), {
			environment: {},
			onStdout(chunk) {
				const paths = `${incompletePath}${chunk}`.split("\0");
				incompletePath = paths.pop() ?? "";
				for (const relative of paths) addTrackedPath(relative);
			},
		});
		if (incompletePath.length > 0) throw new Error("git ls-files returned an unterminated path");
	} catch (error) {
		return { ok: false, failure: { code: "tree-identity-unavailable", message: `cannot establish tree monitor: ${error instanceof Error ? error.message : String(error)}` } };
	}
	const watchers: FSWatcher[] = [];
	const root = snapshot.identity.worktreePath;
	const monitoringStartedAt = new Date().toISOString();
	let monitoringFinishedAt = monitoringStartedAt;
	let monitoringMode: "recursive" | "directory-fallback" = "recursive";
	let drainPromise: Promise<void> | undefined;
	const relativeEvent = (base: string, filename: string | Buffer | null): string => {
		if (filename === null) return "";
		const absolute = path.resolve(base, filename.toString());
		return path.relative(root, absolute).split(path.sep).join("/");
	};
	const markEvent = (base: string, filename: string | Buffer | null): void => {
		const relative = relativeEvent(base, filename);
		if (relative === ".git" || relative.startsWith(".git/")) return;
		if (relative.length === 0) {
			// A nameless event cannot be attributed safely. Fail closed because it
			// may describe a tracked write; this is part of the stated race limit.
			changed = true;
			return;
		}
		if (tracked.has(relative) || trackedDirectories.has(relative)) changed = true;
		else untracked.add(relative);
	};
	const addWatcher = (base: string, recursive: boolean): void => {
		const watcher = watch(base, { persistent: false, recursive }, (event, filename) => {
			void event;
			markEvent(base, filename);
		});
		watcher.on("error", () => { changed = true; });
		watchers.push(watcher);
	};
	try {
		try {
			// Linux Node supports recursive inotify watches. This is the primary
			// monitor because a new untracked subtree must still be reported.
			addWatcher(root, true);
		} catch {
			// Keep a conservative fallback for platforms without recursive watches.
			monitoringMode = "directory-fallback";
			addWatcher(root, false);
			for (const directory of trackedDirectories) addWatcher(path.join(root, directory), false);
		}
	} catch (error) {
		for (const watcher of watchers) watcher.close();
		return { ok: false, failure: { code: "tree-identity-unavailable", message: `cannot establish tree monitor: ${error instanceof Error ? error.message : String(error)}` } };
	}
	return {
		ok: true,
		changed: () => changed,
		untrackedPaths: () => [...untracked].sort(),
		drain: async () => {
			if (drainPromise !== undefined) {
				await drainPromise;
				drainPromise = undefined;
			}
			drainPromise = (async () => {
				// Let queued fs.watch callbacks run before taking the path snapshot.
				await new Promise<void>((resolve) => setImmediate(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
				monitoringFinishedAt = new Date().toISOString();
			})();
			await drainPromise;
		},
		monitoring: () => {
			const started = Date.parse(monitoringStartedAt);
			const finished = Date.parse(monitoringFinishedAt);
			const monitoring: TreeMonitoringProof = {
				method: "fs.watch",
				mode: monitoringMode,
				window: { startedAt: monitoringStartedAt, finishedAt: monitoringFinishedAt, durationMs: Math.max(0, finished - started) },
				residualRace: "events-after-final-drain-may-be-missed",
			};
			return monitoring;
		},
		stop: () => { for (const watcher of watchers) watcher.close(); },
	};
}

export function resolveSpecPath(worktreePath: string, authoredPath: string): string {
	const withoutAt = authoredPath.replace(/^@/, "").replace(/^[/\\]+/, "");
	return path.resolve(worktreePath, withoutAt);
}
