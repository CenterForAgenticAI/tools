import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "./fsutil.ts";
import { Refusal } from "./result.ts";
import { readSnapshot, replaceIfUnchanged } from "./swap.ts";

/** pi-multi-account's config file inside a profile directory. */
export function multiAccountConfigPath(profileDir: string): string {
	return join(profileDir, "pi-multi-account", "config.json");
}

export interface MultiAccountView {
	readonly exists: boolean;
	readonly groups: readonly string[];
	readonly defaultGroup: string | undefined;
}

function parseConfig(path: string, text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} must be a JSON object`);
	return raw as Record<string, unknown>;
}

function groupsOf(cfg: Record<string, unknown> | undefined): Record<string, unknown> {
	const g = cfg?.["accountGroups"];
	return typeof g === "object" && g !== null && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
}

function readConfig(path: string): Record<string, unknown> | undefined {
	const raw = readJson(path);
	if (raw === undefined) return undefined;
	return parseConfig(path, JSON.stringify(raw));
}

export function readMultiAccount(profileDir: string): MultiAccountView {
	const cfg = readConfig(multiAccountConfigPath(profileDir));
	const d = cfg?.["defaultAccountGroup"];
	return { exists: cfg !== undefined, groups: Object.keys(groupsOf(cfg)), defaultGroup: typeof d === "string" ? d : undefined };
}

/**
 * Make `group` the profile's default account group (laws L22, L23).
 * With `members`, define or replace that group first. Without `members`,
 * the group must already be defined; otherwise this refuses and writes
 * nothing. Every other key in the config is kept as it was.
 * The config is replaced only if it still is the file that was read, with
 * the same content; a change pi-multi-account makes meanwhile is refused,
 * never overwritten. Returns a function that puts the config back as it was,
 * on the same terms.
 */
export function applyGroup(profileDir: string, group: string, members?: readonly string[], hooks: MultiAccountHooks = {}): () => void {
	const path = multiAccountConfigPath(profileDir);
	const read = readSnapshot(path);
	const before = read.text;
	const cfg = parseConfig(path, before) ?? {};
	const groups = { ...groupsOf(cfg) };
	if (members !== undefined) groups[group] = [...members];
	else if (!Object.hasOwn(groups, group)) {
		throw new Refusal(`account group "${group}" is not defined in ${path}; define it with multiAccount.members or in pi-multi-account`);
	}
	const next: Record<string, unknown> = { ...cfg, accountGroups: groups, defaultAccountGroup: group };
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	hooks.afterRead?.();
	const text = `${JSON.stringify(next, null, 2)}\n`;
	const ours = replaceIfUnchanged(path, read, text, "updating");
	return () => {
		replaceIfUnchanged(path, { id: ours, text }, before, "undoing");
	};
}

export interface MultiAccountHooks {
	/** Test seam: runs after the config is read and before it is replaced. */
	readonly afterRead?: () => void;
}


