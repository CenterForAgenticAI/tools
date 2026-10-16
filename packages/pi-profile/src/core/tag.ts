import { loadConfig, hostId } from "./config.ts";
import { currentProfile } from "./launch.ts";
import { layoutFromEnv, type Env } from "./paths.ts";

/** The custom entry type the extension appends at session start. */
export const TAG_TYPE = "pi-profile/tag";

/** Which profile and host produced a session. */
export interface Tag {
	readonly profile: string;
	readonly hostId: string;
}

/** The parts of a Pi session entry this module reads; no Pi SDK import. */
export interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/**
 * The tag for a process with this environment. The host ID comes from
 * config.json when it is set, so session start does not wait on Tailscale.
 */
export function tagFor(env: Env, host: (env: Env) => string = hostId): Tag {
	const l = layoutFromEnv(env);
	return { profile: currentProfile(l, env).name, hostId: loadConfig(l, env).hostId ?? host(env) };
}

function isTag(v: unknown): v is Tag {
	return typeof v === "object" && v !== null && typeof (v as Tag).profile === "string" && typeof (v as Tag).hostId === "string";
}

/** The last valid tag on a branch, if any. */
export function lastTag(entries: readonly EntryLike[]): Tag | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "custom" && e.customType === TAG_TYPE && isTag(e.data)) return e.data;
	}
	return undefined;
}

/**
 * The tag to append, or undefined when the branch already carries this one.
 * A session is tagged once. A session forked or resumed from another host or
 * profile gets a new tag, because the local host owns the fork (law L7).
 */
export function tagToAppend(entries: readonly EntryLike[], current: Tag): Tag | undefined {
	const last = lastTag(entries);
	return last !== undefined && last.profile === current.profile && last.hostId === current.hostId ? undefined : current;
}
