import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Env } from "./paths.ts";
import { shellQuote } from "./repo.ts";

/**
 * The `packages` a profile's `settings.json` lists, checked against this
 * host (issue 32). Pi installs a package into the agent directory
 * (`PI_CODING_AGENT_DIR`): an `npm:` source under `npm/node_modules/<name>`,
 * a `git:` source under `git/<host>/<path>`. A local path is loaded where it
 * is and never copied. `pi install SOURCE` installs one; for a source the
 * settings already list it changes nothing else.
 */

/** One install: `pi` with `args`, in `env`. Tests pass a stub, so no test runs npm. */
export type PackageRunner = (args: readonly string[], env: Readonly<Record<string, string>>) => { readonly status: number | null; readonly stderr: string; readonly error?: string };

/** Pi itself, found on PATH, with a bounded run time. */
export const processPackageRunner: PackageRunner = (args, env) => {
	const r = spawnSync("pi", [...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
	const error = r.error === undefined ? undefined : (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "pi is not installed" : r.error.message;
	return { status: r.status, stderr: r.stderr ?? "", ...(error === undefined ? {} : { error }) };
};

export interface PackageNote {
	readonly profile: string;
	readonly source: string;
	/** `missing`: not on this host and not installed by this run. */
	readonly outcome: "missing" | "installed" | "failed";
	readonly reason?: string;
}

/** The sources `packages` lists: a string or `{ source }` each. */
export function packageSources(settings: unknown): string[] {
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return [];
	const list = (settings as Record<string, unknown>).packages;
	if (!Array.isArray(list)) return [];
	const out: string[] = [];
	for (const p of list as unknown[]) {
		const s = typeof p === "string" ? p : typeof p === "object" && p !== null ? (p as Record<string, unknown>).source : undefined;
		if (typeof s === "string" && s.trim().length > 0) out.push(s.trim());
	}
	return out;
}

const NPM_NAME = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/;
const SEG = /^[A-Za-z0-9._~-]+$/;

type Where = { readonly installable: true; readonly path: string } | { readonly installable: false; readonly path?: string; readonly reason: string };

/** The git host and path Pi installs `spec` (after `git:`) under, or undefined. */
function gitPlace(spec: string): { host: string; path: string } | undefined {
	let host: string;
	let path: string;
	const scp = /^git@([^:/]+):(.+)$/.exec(spec);
	if (scp !== null) {
		host = scp[1] as string;
		path = scp[2] as string;
	} else if (spec.includes("://")) {
		try {
			const u = new URL(spec);
			host = u.hostname;
			path = u.pathname;
		} catch {
			return undefined;
		}
	} else {
		const slash = spec.indexOf("/");
		if (slash < 0) return undefined;
		host = spec.slice(0, slash);
		path = spec.slice(slash + 1);
	}
	const at = path.lastIndexOf("@");
	if (at >= 0) path = path.slice(0, at);
	path = path.replace(/^\/+/, "").replace(/\.git$/, "");
	const segs = path.split("/");
	if (!SEG.test(host) || segs.length < 2 || segs.some((s) => !SEG.test(s) || s === "." || s === "..")) return undefined;
	return { host, path };
}

/** Where Pi keeps `source` for the profile at `dir`, and whether `sync pull` may install it. */
export function packageWhere(dir: string, source: string, home?: string): Where {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const name = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec)?.[1];
		if (name === undefined || !NPM_NAME.test(name)) return { installable: false, reason: "not a valid npm package name" };
		return { installable: true, path: join(dir, "npm", "node_modules", ...name.split("/")) };
	}
	if (source.startsWith("git:")) {
		const place = gitPlace(source.slice(4).trim());
		if (place === undefined) return { installable: false, reason: "cannot tell where Pi installs this git source; install it with pi install" };
		return { installable: true, path: join(dir, "git", place.host, ...place.path.split("/")) };
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
		const place = /^(https?|ssh|git):\/\//i.test(source) ? gitPlace(source) : undefined;
		return { installable: false, ...(place === undefined ? {} : { path: join(dir, "git", place.host, ...place.path.split("/")) }), reason: "only npm: and git: sources are installed; install it with pi install" };
	}
	const path = source.startsWith("~/") ? (home === undefined ? undefined : join(home, source.slice(2))) : isAbsolute(source) ? source : resolve(dir, source);
	return { installable: false, ...(path === undefined ? {} : { path }), reason: "a local path: sync pull never installs one; put it in place by hand" };
}

/** A word the shell reads as itself, quoted only when it needs to be. */
function word(text: string): string {
	return /^[A-Za-z0-9_./=:@%+,-]+$/.test(text) ? text : shellQuote(text);
}

/** The variables `checkPackages` sets, on top of its own environment, to install into profile `profile` at `dir`. */
function installEnv(profile: string, dir: string): Array<readonly [string, string]> {
	return [
		["PI_CODING_AGENT_DIR", dir],
		["PI_PROFILE_LABEL", profile],
	];
}

/**
 * The exact command `checkPackages` runs to install `source` into profile
 * `profile` at `dir`, as a shell line: each variable it sets, then the argv.
 */
export function installCommand(profile: string, dir: string, source: string): string {
	return [...installEnv(profile, dir).map(([k, v]) => `${k}=${word(v)}`), "pi", ...installArgv(source).map(word)].join(" ");
}

function installArgv(source: string): string[] {
	return ["install", source];
}

/**
 * The packages `sources` of profile `profile` (at `dir`) that are missing on
 * this host. With `install`, run `pi install SOURCE` for each missing `npm:`
 * or `git:` source, one at a time, with `PI_CODING_AGENT_DIR` set to `dir`
 * and `PI_PROFILE_LABEL` to `profile`, as `pi-profile run` launches Pi;
 * a failure is reported and the rest still run. `beforeInstall` gets each
 * command (`installCommand`) before it runs, so the caller prints it first
 * (law L25: an install prints the exact command before it runs it).
 */
export function checkPackages(
	profile: string,
	dir: string,
	sources: readonly string[],
	opts: { readonly install: boolean; readonly runner: PackageRunner; readonly env: Env; readonly beforeInstall?: (command: string) => void },
): PackageNote[] {
	const out: PackageNote[] = [];
	for (const source of sources) {
		const w = packageWhere(dir, source, opts.env.HOME);
		if (w.path !== undefined && existsSync(w.path)) continue;
		if (!w.installable) {
			out.push({ profile, source, outcome: "missing", reason: w.reason });
			continue;
		}
		if (!opts.install) {
			out.push({ profile, source, outcome: "missing" });
			continue;
		}
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
		for (const [k, v] of installEnv(profile, dir)) env[k] = v;
		opts.beforeInstall?.(installCommand(profile, dir, source));
		const r = opts.runner(installArgv(source), env);
		if (r.status === 0 && r.error === undefined) out.push({ profile, source, outcome: "installed" });
		else {
			const said = (r.error ?? r.stderr).trim().split("\n").slice(-3).join("; ");
			out.push({ profile, source, outcome: "failed", reason: said.length > 0 ? said.slice(0, 400) : `exit ${String(r.status)}` });
		}
	}
	return out;
}
