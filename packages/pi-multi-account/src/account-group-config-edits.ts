import { isAbsolute, resolve } from "node:path";
import { isAccountGroupMemberReference } from "./account-group-members.js";
import {
	isAccountGroupId,
	MANAGED_FAMILIES,
	type MultiAccountConfig,
} from "./config.js";
import { canonicalizeAccountGroupCwd } from "./group-policy.js";

/**
 * One operator change to the account-group keys of the machine-global
 * config. `groupId: undefined` on `default` and `dir` is the `none` argument:
 * it removes the default or the folder rule.
 */
export type AccountGroupConfigEdit =
	| { readonly kind: "create"; readonly groupId: string }
	| { readonly kind: "delete"; readonly groupId: string }
	| { readonly kind: "add"; readonly groupId: string; readonly member: string }
	| { readonly kind: "remove"; readonly groupId: string; readonly member: string }
	| { readonly kind: "default"; readonly groupId: string | undefined }
	| {
			readonly kind: "dir";
			readonly path: string;
			readonly groupId: string | undefined;
			readonly tree: boolean;
	  };

export type AccountGroupEditRefusal =
	| "unknown-group"
	| "invalid-group-id"
	| "reserved-group-id"
	| "invalid-member"
	| "invalid-path"
	| "group-referenced";

/** A rule that still names a group, so the group cannot be deleted. */
export type AccountGroupReference =
	| { readonly kind: "global-default" }
	| { readonly kind: "directory"; readonly path: string }
	| { readonly kind: "tree"; readonly path: string };

export type AccountGroupEditPlan =
	| {
			readonly status: "edited";
			readonly config: MultiAccountConfig;
			/** `remove` left the group with no members. */
			readonly emptiedGroup?: boolean;
			/** Groups whose rule for the same folder `dir` replaced or removed. */
			readonly replacedGroupIds?: readonly string[];
	  }
	| { readonly status: "unchanged" }
	| {
			readonly status: "refused";
			readonly refusal: AccountGroupEditRefusal;
			readonly references?: readonly AccountGroupReference[];
	  };

/** `none` clears a default or a folder rule, so no group may take the name. */
export const ACCOUNT_GROUP_NONE = "none";

const UNCHANGED: AccountGroupEditPlan = Object.freeze({ status: "unchanged" });

function refused(
	refusal: AccountGroupEditRefusal,
	references?: readonly AccountGroupReference[],
): AccountGroupEditPlan {
	return references === undefined
		? { status: "refused", refusal }
		: { status: "refused", refusal, references };
}

function hasGroup(config: MultiAccountConfig, groupId: string): boolean {
	return Object.hasOwn(config.accountGroups ?? {}, groupId);
}

function withGroups(
	fresh: MultiAccountConfig,
	groups: Readonly<Record<string, readonly string[]>>,
): MultiAccountConfig {
	return { ...fresh, accountGroups: groups };
}

/**
 * Applies one edit to the config read under the lease. It returns a new
 * config that differs only in the account-group keys, `unchanged` when the
 * file already says what the operator asked for, or a refusal. Only the
 * named fields of `edit` are read; nothing from it is spread into the result.
 */
export function applyAccountGroupEdit(
	fresh: MultiAccountConfig,
	edit: AccountGroupConfigEdit,
): AccountGroupEditPlan {
	const groups = fresh.accountGroups ?? {};
	switch (edit.kind) {
		case "create": {
			const groupId = edit.groupId;
			if (!isAccountGroupId(groupId)) return refused("invalid-group-id");
			if (groupId === ACCOUNT_GROUP_NONE) return refused("reserved-group-id");
			if (hasGroup(fresh, groupId)) return UNCHANGED;
			return {
				status: "edited",
				config: withGroups(fresh, Object.fromEntries([...Object.entries(groups), [groupId, []]])),
			};
		}
		case "add": {
			const { groupId, member } = edit;
			if (!hasGroup(fresh, groupId)) return refused("unknown-group");
			if (!isAccountGroupMemberReference(member, fresh.accountLimit, MANAGED_FAMILIES)) {
				return refused("invalid-member");
			}
			const members = groups[groupId] ?? [];
			if (members.includes(member)) return UNCHANGED;
			return {
				status: "edited",
				config: withGroups(fresh, replaceGroup(groups, groupId, [...members, member])),
			};
		}
		case "remove": {
			const { groupId, member } = edit;
			if (!hasGroup(fresh, groupId)) return refused("unknown-group");
			const members = groups[groupId] ?? [];
			if (!members.includes(member)) return UNCHANGED;
			const remaining = members.filter((candidate) => candidate !== member);
			return {
				status: "edited",
				config: withGroups(fresh, replaceGroup(groups, groupId, remaining)),
				emptiedGroup: remaining.length === 0,
			};
		}
		case "delete": {
			const groupId = edit.groupId;
			if (!hasGroup(fresh, groupId)) return refused("unknown-group");
			const references = accountGroupReferences(fresh, groupId);
			if (references.length > 0) return refused("group-referenced", references);
			return {
				status: "edited",
				config: withGroups(
					fresh,
					Object.fromEntries(Object.entries(groups).filter(([id]) => id !== groupId)),
				),
			};
		}
		case "default": {
			const groupId = edit.groupId;
			if (groupId !== undefined && !hasGroup(fresh, groupId)) return refused("unknown-group");
			if (fresh.defaultAccountGroup === groupId) return UNCHANGED;
			const { defaultAccountGroup: _previous, ...rest } = fresh;
			return {
				status: "edited",
				config: groupId === undefined ? rest : { ...rest, defaultAccountGroup: groupId },
			};
		}
		case "dir":
			return applyDirectoryEdit(fresh, edit.path, edit.groupId, edit.tree);
	}
}

function replaceGroup(
	groups: Readonly<Record<string, readonly string[]>>,
	groupId: string,
	members: readonly string[],
): Record<string, readonly string[]> {
	return Object.fromEntries(
		Object.entries(groups).map(([id, current]) => [id, id === groupId ? members : current]),
	);
}

/** Every rule that names `groupId`, in a fixed order for the refusal text. */
export function accountGroupReferences(
	config: MultiAccountConfig,
	groupId: string,
): readonly AccountGroupReference[] {
	const references: AccountGroupReference[] = [];
	if (config.defaultAccountGroup === groupId) references.push({ kind: "global-default" });
	for (const [path, ruleGroupId] of Object.entries(config.accountGroupCwdDefaults ?? {})) {
		if (ruleGroupId === groupId) references.push({ kind: "directory", path });
	}
	for (const [path, ruleGroupId] of Object.entries(config.accountGroupDirectoryDefaults ?? {})) {
		if (ruleGroupId === groupId) references.push({ kind: "tree", path });
	}
	return references;
}

function applyDirectoryEdit(
	fresh: MultiAccountConfig,
	path: string,
	groupId: string | undefined,
	tree: boolean,
): AccountGroupEditPlan {
	if (!isAbsolute(path) || path.includes("\u0000")) return refused("invalid-path");
	if (groupId !== undefined && !hasGroup(fresh, groupId)) return refused("unknown-group");
	const key = tree ? "accountGroupDirectoryDefaults" : "accountGroupCwdDefaults";
	const rules = fresh[key] ?? {};
	// A key that names the same folder through a trailing separator, `..`, or
	// a symlink is the same rule; resolution would treat two such keys with
	// different groups as a conflict, so the edit replaces all of them.
	const folder = canonicalizeAccountGroupCwd(path);
	const matches = Object.keys(rules).filter(
		(candidate) => canonicalizeAccountGroupCwd(candidate) === folder,
	);
	const alreadyExact =
		groupId === undefined
			? matches.length === 0
			: matches.length === 1 && matches[0] === path && rules[path] === groupId;
	if (alreadyExact) return UNCHANGED;
	const replacedGroupIds = [
		...new Set(
			matches
				.map((candidate) => rules[candidate])
				.filter((candidate): candidate is string => candidate !== undefined && candidate !== groupId),
		),
	];
	const kept = Object.entries(rules).filter(([candidate]) => !matches.includes(candidate));
	const next = Object.fromEntries(groupId === undefined ? kept : [...kept, [path, groupId]]);
	if (tree && Object.keys(next).length === 0) {
		const { accountGroupDirectoryDefaults: _previous, ...rest } = fresh;
		return { status: "edited", config: rest, replacedGroupIds };
	}
	return { status: "edited", config: { ...fresh, [key]: next }, replacedGroupIds };
}

/**
 * Resolves the folder argument of `group dir` to the absolute path the rule
 * stores. `~` and `~/...` use the operator's home; any other relative path is
 * taken from the session cwd. Returns undefined for a NUL byte, another
 * user's home (`~name`), or a missing absolute base.
 */
export function resolveAccountGroupDirectoryPath(
	input: string,
	context: { readonly cwd: string; readonly home: string },
): string | undefined {
	if (input.includes("\u0000")) return undefined;
	if (input === "~" || input.startsWith("~/")) {
		if (!isAbsolute(context.home)) return undefined;
		return resolve(context.home, input.slice(2));
	}
	if (input.startsWith("~")) return undefined;
	if (isAbsolute(input)) return resolve(input);
	if (!isAbsolute(context.cwd)) return undefined;
	return resolve(context.cwd, input);
}
