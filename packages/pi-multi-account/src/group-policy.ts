import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { MultiAccountConfig } from "./config.js";

export type AccountGroupResolutionSource =
	| "session-override"
	| "cwd-default"
	| "directory-default"
	| "global-default"
	| "unrestricted";

export type EffectiveAccountGroupResolution =
	| {
			readonly groupId: string;
			readonly source: Exclude<AccountGroupResolutionSource, "unrestricted">;
	  }
	| {
			readonly source: "unrestricted";
	  };

/**
 * The operator's group policy is ambiguous for this session: two configured
 * exact-folder rules, or two configured tree rules, canonicalize to the same
 * directory but name different groups. The store is not at fault, so this is
 * reported as a policy cause.
 */
export class AccountGroupPolicyConflictError extends Error {
	constructor() {
		super("Conflicting account-group defaults canonicalize to the same directory.");
		this.name = "AccountGroupPolicyConflictError";
	}
}

export type AccountGroupPolicyConfig = Pick<
	MultiAccountConfig,
	"accountGroupCwdDefaults" | "accountGroupDirectoryDefaults" | "defaultAccountGroup"
>;

/**
 * Canonicalize only the supplied directory. This deliberately does not inspect
 * Git metadata or call projectKeyForCwd/resolveProjectRoot, because linked
 * worktrees that share a git-common-dir remain distinct exact directories.
 */
export function canonicalizeAccountGroupCwd(cwd: string): string {
	const absolute = resolve(cwd);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Whether canonical `cwd` is canonical `root` or a folder below it. The
 * separator test keeps `/foo` from matching `/foobar`; a filesystem root
 * already ends in the separator and so covers every folder.
 */
function isWithinAccountGroupRoot(root: string, cwd: string): boolean {
	if (cwd === root) return true;
	return cwd.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Resolve one session's effective group in strict precedence order: session
 * override, exact-folder rule, the deepest tree rule that contains the cwd,
 * the global default, then unrestricted. The live cwd and every
 * operator-authored key are realpath-canonicalized before comparison, so
 * symlinks and `..` segments resolve to the real folder first. Exact rules
 * compare byte-for-byte; tree rules match the root or a folder below it.
 * Matching uses paths only, never Git metadata: a worktree below a tree root
 * inherits its rule, and a linked worktree outside the root does not.
 */
export function resolveEffectiveAccountGroup(
	config: AccountGroupPolicyConfig,
	cwd: string,
	sessionOverride?: string,
): EffectiveAccountGroupResolution {
	if (sessionOverride !== undefined) {
		return Object.freeze({
			groupId: sessionOverride,
			source: "session-override" as const,
		});
	}

	const canonicalCwd = canonicalizeAccountGroupCwd(cwd);
	let cwdDefault: string | undefined;
	for (const [configuredCwd, groupId] of Object.entries(
		config.accountGroupCwdDefaults ?? {},
	)) {
		if (canonicalizeAccountGroupCwd(configuredCwd) !== canonicalCwd) continue;
		if (cwdDefault !== undefined && cwdDefault !== groupId) {
			throw new AccountGroupPolicyConflictError();
		}
		cwdDefault = groupId;
	}
	if (cwdDefault !== undefined) {
		return Object.freeze({ groupId: cwdDefault, source: "cwd-default" as const });
	}

	// Key order never decides: the longest canonical root that contains the
	// cwd wins, and every key for that root must name the same group. A
	// conflict at a shallower root the winner shadows cannot change the result.
	const treeGroups = new Map<string, Set<string>>();
	for (const [configuredRoot, groupId] of Object.entries(
		config.accountGroupDirectoryDefaults ?? {},
	)) {
		const root = canonicalizeAccountGroupCwd(configuredRoot);
		if (!isWithinAccountGroupRoot(root, canonicalCwd)) continue;
		const groups = treeGroups.get(root) ?? new Set<string>();
		groups.add(groupId);
		treeGroups.set(root, groups);
	}
	let treeRoot: string | undefined;
	for (const root of treeGroups.keys()) {
		if (treeRoot === undefined || root.length > treeRoot.length) treeRoot = root;
	}
	if (treeRoot !== undefined) {
		const [groupId, ...others] = treeGroups.get(treeRoot) ?? [];
		if (groupId === undefined || others.length > 0) {
			throw new AccountGroupPolicyConflictError();
		}
		return Object.freeze({ groupId, source: "directory-default" as const });
	}

	if (config.defaultAccountGroup !== undefined) {
		return Object.freeze({
			groupId: config.defaultAccountGroup,
			source: "global-default" as const,
		});
	}
	return Object.freeze({ source: "unrestricted" as const });
}
