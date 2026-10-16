import { basename, resolve, sep } from "node:path";
import { ENV_KEYS } from "./env.ts";
import { loadProfile } from "./profiles.ts";
import { DEFAULT_PROFILE } from "./names.ts";
import { defaultAgentDir, profilesRoot, type Env, type Layout } from "./paths.ts";
import { selectSource, type Source } from "./select.ts";
import { getGlobalDefault } from "./profiles.ts";

/** Variables to set (string) or clear (undefined) when entering a profile. */
export type EnvPlan = ReadonlyArray<readonly [name: string, value: string | undefined]>;

/**
 * The environment for running Pi in `name`. Every allow-listed profile
 * variable the profile does not set is cleared, so one profile's settings
 * never leak into the next.
 */
export function profileEnv(l: Layout, name: string): EnvPlan {
	const info = loadProfile(l, name);
	if (info.manifestErrors.length > 0) throw new Error(`${name}/profile.json is invalid: ${info.manifestErrors.join("; ")}`);
	const plan: Array<readonly [string, string | undefined]> = [
		["PI_CODING_AGENT_DIR", name === DEFAULT_PROFILE ? defaultAgentDir(l) : info.dir],
		["PI_PROFILE_LABEL", name],
	];
	const env = info.manifest.env ?? {};
	for (const key of ENV_KEYS) plan.push([key, env[key]]);
	return plan;
}

export function applyPlan(base: Env, plan: EnvPlan): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
	for (const [k, v] of plan) {
		if (v === undefined) delete out[k];
		else out[k] = v;
	}
	return out;
}

export interface Current {
	readonly name: string;
	readonly agentDir: string;
	readonly source: Source;
}

/** Which profile a process with this environment is in (laws L1-L3). */
export function currentProfile(l: Layout, env: Env): Current {
	const label = env["PI_PROFILE_LABEL"];
	const exported = env["PI_CODING_AGENT_DIR"];
	const global = env["PI_PROFILE_NO_GLOBAL_DEFAULT"] !== undefined ? undefined : safeGlobal(l);
	const source = selectSource({
		explicit: label,
		exportedDir: exported,
		globalDefault: global,
		noGlobalDefault: env["PI_PROFILE_NO_GLOBAL_DEFAULT"] !== undefined,
	});
	switch (source) {
		case "explicit":
			return { name: label ?? DEFAULT_PROFILE, agentDir: exported ?? defaultAgentDir(l), source };
		case "exported":
			return { name: nameForDir(l, exported ?? ""), agentDir: exported ?? "", source };
		case "global-default":
			return { name: global ?? DEFAULT_PROFILE, agentDir: loadProfile(l, global ?? DEFAULT_PROFILE).dir, source };
		case "builtin-default":
			return { name: DEFAULT_PROFILE, agentDir: defaultAgentDir(l), source };
	}
}

function safeGlobal(l: Layout): string | undefined {
	try {
		return getGlobalDefault(l);
	} catch {
		return undefined;
	}
}

/** Name a profile from its agent directory; `custom` when it is not one of ours. */
export function nameForDir(l: Layout, dir: string): string {
	const d = resolve(dir);
	if (d === resolve(defaultAgentDir(l))) return DEFAULT_PROFILE;
	const root = resolve(profilesRoot(l));
	if (d.startsWith(root + sep) && !d.slice(root.length + 1).includes(sep)) return basename(d);
	return "custom";
}
