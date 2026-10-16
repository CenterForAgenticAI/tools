import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DEFAULT_HUB } from "./config.ts";
import type { Env, Layout } from "./paths.ts";
import { listProfiles, loadProfile } from "./profiles.ts";
import { findPi, parsePin, parseVersion, PI_PACKAGE, satisfies, type FoundPi } from "./piversion.ts";
import { readPinState, shownPin } from "./pinstate.ts";
import { printable, shellQuote } from "./repo.ts";
import { Refusal } from "./result.ts";

/**
 * What the Pi version pin (issue 34) means for `run`, `doctor`
 * and `pin --install`. A profile follows the pin of its own hub:
 * `sync.hub` in its `profile.json`, else `default`, the hub `sync push`
 * sends it to. The pin is read from this host's state (`pinstate.ts`),
 * never from the hub, so `run` makes no network call.
 *
 * A mismatch is a warning: `run` launches Pi anyway and `doctor` reports
 * it (user decisions on issue 34). Only `pin --install` installs
 * anything, after it prints the exact command.
 */

/** One install: `argv[0]` with the rest, in `env`. Tests pass a stub, so no test runs npm. */
export type CommandRunner = (argv: readonly string[], env: Readonly<Record<string, string>>) => { readonly status: number | null; readonly error?: string };

/** The real command, its output shown, bounded to 15 minutes. */
export const processCommandRunner: CommandRunner = (argv, env) => {
	const r = spawnSync(argv[0] as string, argv.slice(1), { env, stdio: "inherit", timeout: 15 * 60_000 });
	const error = r.error === undefined ? undefined : (r.error as NodeJS.ErrnoException).code === "ENOENT" ? `${argv[0] as string} is not installed` : r.error.message;
	return { status: r.status, ...(error === undefined ? {} : { error }) };
};

/** Where `pi --version` of a Pi of no known layout is cached, by the executable's identity. */
export function piVersionCache(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "pi-version.json");
}

/** The hub whose pin profile `name` follows. */
export function hubOf(l: Layout, name: string): string {
	return loadProfile(l, name).manifest.sync?.hub ?? DEFAULT_HUB;
}

/** Whether Pi version `version` matches `pin`; undefined when either cannot be read. */
export function matches(version: string | undefined, pin: string): boolean | undefined {
	const v = version === undefined ? undefined : parseVersion(version);
	const p = parsePin(pin);
	return v === undefined || p === undefined ? undefined : satisfies(v, p);
}

/**
 * The one warning `run` prints before it launches Pi in profile `name` with
 * `env`, or undefined. It never refuses: a pin that cannot be read or
 * checked is a warning too. Costs one small file read when no pin applies.
 */
export function runWarning(l: Layout, name: string, env: Env): string | undefined {
	let pin: string | undefined;
	let hub: string;
	try {
		hub = hubOf(l, name);
		pin = readPinState(l).get(hub)?.pin;
	} catch (error) {
		return `the Pi version pin was not checked: ${printable((error as Error).message)}`;
	}
	if (pin === undefined) return undefined;
	const found = findPi(env, { cache: piVersionCache(l) });
	// No pi on PATH: launching it reports that.
	if (found === undefined) return undefined;
	const ok = matches(found.version, pin);
	if (ok === true) return undefined;
	if (ok === undefined) return `cannot read the version of ${printable(found.path)}, so the Pi version pin ${shownPin(pin)} of hub ${hub} was not checked`;
	return `Pi ${shownPin(found.version)} does not match the Pi version pin ${shownPin(pin)} of hub ${hub}; launching it anyway (see pi-profile pin)`;
}

/** `doctor`: each hub with a pin and a profile here that follows it, checked against the Pi on PATH. */
export function pinFindings(l: Layout, env: Env): Array<{ readonly level: "warn" | "error"; readonly message: string }> {
	let pins: ReturnType<typeof readPinState>;
	try {
		pins = readPinState(l);
	} catch (error) {
		return [{ level: "error", message: (error as Error).message }];
	}
	const byHub = new Map<string, string[]>();
	for (const name of listProfiles(l)) {
		let hub: string;
		try {
			hub = hubOf(l, name);
		} catch {
			continue; // checkProfile reports a broken profile.json
		}
		if (pins.get(hub)?.pin !== undefined) byHub.set(hub, [...(byHub.get(hub) ?? []), name]);
	}
	if (byHub.size === 0) return [];
	const found = findPi(env, { cache: piVersionCache(l) });
	const out: Array<{ level: "warn" | "error"; message: string }> = [];
	for (const [hub, names] of [...byHub].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		const pin = pins.get(hub)?.pin as string;
		const which = `the Pi version pin ${shownPin(pin)} of hub ${hub} (profiles: ${names.join(", ")})`;
		if (found === undefined) out.push({ level: "warn", message: `no pi on PATH, so ${which} was not checked` });
		else {
			const ok = matches(found.version, pin);
			if (ok === undefined) out.push({ level: "warn", message: `cannot read the version of ${printable(found.path)}, so ${which} was not checked` });
			else if (!ok) out.push({ level: "warn", message: `Pi ${shownPin(found.version)} (${printable(found.path)}) does not match ${which}; see pi-profile pin` });
		}
	}
	return out;
}

/** A word the shell reads as itself, quoted only when it needs to be. */
function word(text: string): string {
	return /^[A-Za-z0-9_./=:@%+,-]+$/.test(text) ? text : shellQuote(text);
}

/** A command line to print: each word quoted when needed, the package spec always. */
export function commandLine(argv: readonly string[]): string {
	return argv.map((a) => (a.startsWith(`${PI_PACKAGE}@`) ? shellQuote(a) : word(a))).join(" ");
}

/** The npm command that installs Pi `pin` as a global package; `prefix` names the npm prefix Pi is in. */
export function npmInstall(pin: string, prefix?: string): string[] {
	return ["npm", "install", "--global", ...(prefix === undefined ? [] : ["--prefix", prefix]), `${PI_PACKAGE}@${pin}`];
}

export type InstallPlan =
	| { readonly kind: "matches"; readonly found: FoundPi }
	| { readonly kind: "run"; readonly argv: readonly string[]; readonly found: FoundPi };

/**
 * How `pin --install` brings the Pi on PATH to `pin` of `hub`. Only an npm
 * global install has a command that installs a chosen version (npm itself,
 * into the same prefix). A pi.dev managed install has none (its installer
 * and `pi update` take only the latest release), and pi-profile never edits
 * its files, so that, an unknown layout and no pi at all are refused with
 * what the user can run instead.
 */
export function installPlan(env: Env, pin: string, hub: string, cache?: string): InstallPlan {
	const found = findPi(env, cache === undefined ? {} : { cache });
	const instead = `To install Pi ${shownPin(pin)} with npm instead: ${commandLine(npmInstall(pin))}, and put its bin folder first on PATH.`;
	if (found === undefined) throw new Refusal(`no pi on PATH, so pi-profile cannot tell how to install Pi ${shownPin(pin)} for hub ${hub}; nothing was installed. ${instead}`);
	if (matches(found.version, pin) === true) return { kind: "matches", found };
	switch (found.install.kind) {
		case "npm":
			return { kind: "run", argv: npmInstall(pin, found.install.prefix), found };
		case "managed":
			throw new Refusal(
				`Pi at ${printable(found.path)} is a managed install (the pi.dev installer), which installs only the latest release (pi update); ` +
					`pi-profile never edits its files, so nothing was installed. ${instead}`,
			);
		case "other":
			throw new Refusal(`pi-profile cannot tell how Pi at ${printable(found.path)} was installed, so nothing was installed. ${instead}`);
	}
}
