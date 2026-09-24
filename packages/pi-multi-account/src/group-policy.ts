import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MultiAccountConfig } from "./config.js";

export type AccountGroupResolutionSource =
	| "session-override"
	| "cwd-default"
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

export type AccountGroupPolicyConfig = Pick<
	MultiAccountConfig,
	"accountGroupCwdDefaults" | "defaultAccountGroup"
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
 * Resolve one session's effective group in strict precedence order. Both the live
 * cwd and each operator-authored absolute cwd key are realpath-canonicalized,
 * then compared byte-for-byte. Subtrees and linked worktrees therefore never
 * inherit a parent or shared-repository default.
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
			throw new Error(
				"Conflicting account-group defaults canonicalize to the same exact cwd.",
			);
		}
		cwdDefault = groupId;
	}
	if (cwdDefault !== undefined) {
		return Object.freeze({ groupId: cwdDefault, source: "cwd-default" as const });
	}

	if (config.defaultAccountGroup !== undefined) {
		return Object.freeze({
			groupId: config.defaultAccountGroup,
			source: "global-default" as const,
		});
	}
	return Object.freeze({ source: "unrestricted" as const });
}
