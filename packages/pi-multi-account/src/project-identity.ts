import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

/** Bounded, non-identifying key allowed in the machine-global history store. */
export const PROJECT_KEY_PATTERN = /^project-[0-9a-f]{24}$/;

export type GitRootResolver = (absoluteCwd: string) => string | undefined;

export interface ProjectKeyResolverOptions {
	readonly gitRoot?: GitRootResolver;
	readonly memoize?: boolean;
}

export function isProjectKey(value: string): boolean {
	return PROJECT_KEY_PATTERN.test(value);
}

function canonicalAbsolute(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Convert an already-resolved local project root into the only representation
 * that may cross into retained machine-global records.
 */
export function deriveProjectKey(identityRoot: string): string {
	const absoluteRoot = canonicalAbsolute(identityRoot);
	const digest = createHash("sha256").update(absoluteRoot).digest("hex");
	return `project-${digest.slice(0, 24)}`;
}

function discoverGitRoot(absoluteCwd: string): string | undefined {
	try {
		const output = execFileSync(
			"git",
			[
				"-C",
				absoluteCwd,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1_000,
			},
		).trim();
		if (output.length === 0) return undefined;
		const commonDirectory = canonicalAbsolute(output);
		return basename(commonDirectory) === ".git"
			? dirname(commonDirectory)
			: commonDirectory;
	} catch {
		return undefined;
	}
}

/** Resolve linked worktrees to their shared repository root, or use cwd. */
export function resolveProjectRoot(
	cwd: string,
	gitRoot: GitRootResolver = discoverGitRoot,
): string {
	const absoluteCwd = canonicalAbsolute(cwd);
	try {
		const root = gitRoot(absoluteCwd);
		return root && root.trim().length > 0
			? canonicalAbsolute(root)
			: absoluteCwd;
	} catch {
		return absoluteCwd;
	}
}

/** Build a resolver whose optional cache never stores a path outside process memory. */
export function createProjectKeyResolver(
	options: ProjectKeyResolverOptions = {},
): (cwd?: string) => string {
	const gitRoot = options.gitRoot ?? discoverGitRoot;
	const cache = new Map<string, string>();
	return (cwd = process.cwd()) => {
		const absoluteCwd = canonicalAbsolute(cwd);
		if (options.memoize === true) {
			const cached = cache.get(absoluteCwd);
			if (cached !== undefined) return cached;
		}
		const key = deriveProjectKey(resolveProjectRoot(absoluteCwd, gitRoot));
		if (options.memoize === true) cache.set(absoluteCwd, key);
		return key;
	};
}

export const projectKeyForCwd = createProjectKeyResolver({ memoize: true });
