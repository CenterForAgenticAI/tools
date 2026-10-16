import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Where pi-profile keeps everything. Tests pass their own; the CLI reads the environment. */
export interface Layout {
	/** `PI_PROFILE_HOME`, default `~/.pi`. */
	readonly piHome: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function layoutFromEnv(env: Env = process.env): Layout {
	const configured = env["PI_PROFILE_HOME"];
	return { piHome: resolve(configured && configured.length > 0 ? configured : join(homedir(), ".pi")) };
}

/** `~/.pi/pi-profile/remote`: other hosts' pulled sessions, a read-only cache. */
export function remoteDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "remote");
}

/** `~/.pi/pi-profile/state/pull`: a staged pull's private download area, never replicated (law L10). */
export function pullStateDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "pull");
}

/** A path with every symlink resolved; the resolved parent plus the rest when it does not exist yet. */
function real(path: string): string {
	const p = resolve(path);
	try {
		return realpathSync(p);
	} catch {
		const parent = resolve(p, "..");
		return parent === p ? p : join(real(parent), relative(parent, p));
	}
}

function within(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** True when `child` is `parent` or inside it, after following symlinks in both. */
export function realWithin(child: string, parent: string): boolean {
	return within(real(child), real(parent));
}

/**
 * True when `path` is inside the pulled-sessions cache, or holds it, after
 * following symlinks. Pulled sessions are other hosts'; a store or migration
 * that reaches them would back them up as this host's (laws L6, L7).
 */
export function overlapsPulled(l: Layout, path: string): boolean {
	const a = real(path);
	const b = real(remoteDir(l));
	return within(a, b) || within(b, a);
}

/** The built-in `default` profile: Pi's own agent directory. */
export function defaultAgentDir(l: Layout): string {
	return join(l.piHome, "agent");
}

export function profilesRoot(l: Layout): string {
	return join(l.piHome, "profiles");
}

export function profileDir(l: Layout, name: string): string {
	return name === "default" ? defaultAgentDir(l) : join(profilesRoot(l), name);
}

/** The auth file every `shared` profile links to. */
export function sharedAuthPath(l: Layout): string {
	return join(defaultAgentDir(l), "auth.json");
}

/** Holds the global default profile name. Kept from the fish utility so existing setups keep working. */
export function globalDefaultFile(l: Layout): string {
	return join(profilesRoot(l), ".global-default");
}

/** Deleted profiles are moved here, never removed. */
export function trashDir(l: Layout): string {
	return join(profilesRoot(l), ".trash");
}
