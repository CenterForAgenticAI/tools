import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { writeJsonAtomic } from "./fsutil.ts";
import type { Env } from "./paths.ts";

/**
 * The Pi version pin (issue 34): a small, documented subset of
 * npm semver, and the Pi that `pi-profile run` launches.
 *
 * A pin is one of: an exact version `1.1.0`, `^1.1.0` (same major; for
 * 0.x, same minor; for 0.0.x, that patch only), `~1.1.0` (same minor) or
 * `>=1.1.0`. A version is `MAJOR.MINOR.PATCH` with an optional
 * `-PRERELEASE`; no build metadata, no leading zeros, no `v`, at most nine
 * digits a part. Anything else (`1.x`, `*`, `latest`, `>1.0.0`, `<2`, `||`,
 * hyphen ranges) is not a pin. Matching follows npm: a prerelease version
 * matches only a pin whose own prerelease has the same `MAJOR.MINOR.PATCH`.
 *
 * `run` spawns `pi` from its PATH, so the Pi compared is the first
 * executable `pi` on that PATH. Its version is read without running it for
 * the two layouts Pi is installed with: an npm global install (`<prefix>/bin/pi`
 * links into `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent`)
 * and a pi.dev managed install (`<agent>/bin/pi` is a launcher that runs
 * `<agent>/install/releases/<install/current-version>`). Any other layout
 * runs `pi --version`, bounded. The answer is cached by the executable's
 * identity only when that executable is the program itself: never for a
 * script (`#!`: a wrapper or version-manager shim, which does not change
 * when the Pi behind it is upgraded) nor for a managed launcher whose
 * release cannot be read (`pi update` never changes the launcher)
 * (issue 56).
 */

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly pre: readonly string[];
}

export type PinOp = "exact" | "^" | "~" | ">=";

export interface Pin {
	readonly op: PinOp;
	readonly version: Version;
}

const NUM = "(0|[1-9][0-9]{0,8})";
const PRE_ID = "(?:0|[1-9][0-9]{0,8}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);
const MAX_LENGTH = 64;

export function parseVersion(text: string): Version | undefined {
	if (text.length > MAX_LENGTH) return undefined;
	const m = VERSION.exec(text);
	if (m === null) return undefined;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split(".") };
}

/** A pin in the subset above, or undefined. */
export function parsePin(text: string): Pin | undefined {
	const m = /^(\^|~|>=)?(.*)$/s.exec(text);
	if (m === null) return undefined;
	const version = parseVersion(m[2] as string);
	if (version === undefined) return undefined;
	return { op: (m[1] as PinOp | undefined) ?? "exact", version };
}

export function isPin(text: unknown): text is string {
	return typeof text === "string" && parsePin(text) !== undefined;
}

function cmpNum(a: number, b: number): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function cmpCore(a: Version, b: Version): number {
	return cmpNum(a.major, b.major) || cmpNum(a.minor, b.minor) || cmpNum(a.patch, b.patch);
}

/** Semver precedence. */
export function compareVersions(a: Version, b: Version): number {
	const core = cmpCore(a, b);
	if (core !== 0) return core;
	if (a.pre.length === 0 || b.pre.length === 0) return cmpNum(b.pre.length, a.pre.length) === 0 ? 0 : a.pre.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i] as string;
		const y = b.pre[i] as string;
		const xn = /^[0-9]+$/.test(x);
		const yn = /^[0-9]+$/.test(y);
		const c = xn && yn ? cmpNum(Number(x), Number(y)) : xn ? -1 : yn ? 1 : x < y ? -1 : x > y ? 1 : 0;
		if (c !== 0) return c;
	}
	return cmpNum(a.pre.length, b.pre.length);
}

/** Whether `v` matches `pin`, as npm's `semver.satisfies` does for these forms. */
export function satisfies(v: Version, pin: Pin): boolean {
	const p = pin.version;
	// A prerelease matches only a pin that names a prerelease of the same MAJOR.MINOR.PATCH.
	if (v.pre.length > 0 && (p.pre.length === 0 || cmpCore(v, p) !== 0)) return false;
	if (pin.op === "exact") return compareVersions(v, p) === 0;
	if (compareVersions(v, p) < 0) return false;
	if (pin.op === ">=") return true;
	const upper: Version =
		pin.op === "~" ? { major: p.major, minor: p.minor + 1, patch: 0, pre: [] }
		: p.major > 0 ? { major: p.major + 1, minor: 0, patch: 0, pre: [] }
		: p.minor > 0 ? { major: 0, minor: p.minor + 1, patch: 0, pre: [] }
		: { major: 0, minor: 0, patch: p.patch + 1, pre: [] };
	return cmpCore(v, upper) < 0;
}

/** How the Pi on PATH was installed. */
export type PiInstall =
	| { readonly kind: "npm"; readonly prefix: string }
	| { readonly kind: "managed"; readonly agentDir: string }
	| { readonly kind: "other" };

export interface FoundPi {
	/** The `pi` on PATH, as found. */
	readonly path: string;
	/** Its version; undefined when it cannot be read. */
	readonly version?: string;
	readonly install: PiInstall;
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The first executable `pi` on `env.PATH`, as `spawn` finds it. */
export function piOnPath(env: Env): string | undefined {
	const path = env.PATH;
	if (path === undefined) return undefined;
	for (const entry of path.split(delimiter)) {
		const candidate = resolve(entry === "" ? "." : entry, "pi");
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

function readSmall(path: string): string | undefined {
	try {
		if (statSync(path).size > 1024 * 1024) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The version in Pi's own `package.json` under `pkgDir`, when it is Pi's and valid. */
function packageVersion(pkgDir: string): string | undefined {
	const text = readSmall(join(pkgDir, "package.json"));
	if (text === undefined) return undefined;
	try {
		const raw = JSON.parse(text) as unknown;
		if (typeof raw !== "object" || raw === null) return undefined;
		const { name, version } = raw as { name?: unknown; version?: unknown };
		return name === PI_PACKAGE && typeof version === "string" && parseVersion(version) !== undefined ? version : undefined;
	} catch {
		return undefined;
	}
}

function realOf(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** `<prefix>/bin/pi` linking into `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent`: npm's global layout. */
function npmLayout(found: string, real: string): FoundPi | undefined {
	let dir = dirname(real);
	while (dir !== dirname(dir)) {
		if (basename(dir) === "pi-coding-agent" && basename(dirname(dir)) === "@earendil-works" && basename(dirname(dirname(dir))) === "node_modules") break;
		dir = dirname(dir);
	}
	if (dir === dirname(dir)) return undefined;
	const version = packageVersion(dir);
	const nodeModules = dirname(dirname(dir));
	const lib = dirname(nodeModules);
	const prefix = dirname(lib);
	const global = basename(lib) === "lib" && realOf(dirname(found)) === realOf(join(prefix, "bin"));
	return { path: found, ...(version === undefined ? {} : { version }), install: global ? { kind: "npm", prefix } : { kind: "other" } };
}

/** `<agent>/bin/pi`, a pi.dev launcher: the release named by `install/current-version`. */
function managedLayout(found: string, real: string): FoundPi | undefined {
	if (basename(dirname(real)) !== "bin") return undefined;
	const agentDir = dirname(dirname(real));
	const marker = readSmall(join(agentDir, "install", "managed-install.json"));
	if (marker === undefined) return undefined;
	try {
		const m = JSON.parse(marker) as { kind?: unknown; layout?: unknown };
		if (m.kind !== "pi-managed-install" || m.layout !== "releases-v1") return undefined;
	} catch {
		return undefined;
	}
	// The same check the launcher makes on the version file before it uses it as a folder name.
	const current = (readSmall(join(agentDir, "install", "current-version")) ?? "").split("\n")[0] ?? "";
	const valid = /^[0-9A-Za-z._+-]+$/.test(current) && current !== "." && current !== "..";
	const version = valid ? packageVersion(join(agentDir, "install", "releases", current, "node_modules", ...PI_PACKAGE.split("/"))) : undefined;
	return { path: found, ...(version === undefined ? {} : { version }), install: { kind: "managed", agentDir } };
}

interface CacheEntry {
	readonly real: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly version: string;
	/** When the answer was asked, in ms since the epoch. */
	readonly at: number;
}

const VERSION_TIMEOUT_MS = 3000;

/**
 * How long a cached `pi --version` stands. A compiled version-manager shim
 * (volta, mise) does not start with `#!` and does not change when the Pi
 * behind it is upgraded, so its identity alone could report the old version
 * for ever (issue 56); this bounds that to 10 minutes.
 */
export const VERSION_CACHE_MAX_AGE_MS = 10 * 60_000;

/**
 * `pi --version` of an executable of no known layout, cached in `cache` by
 * the executable's identity, for at most `VERSION_CACHE_MAX_AGE_MS`.
 */
function askVersion(found: string, real: string, env: Env, cache: string | undefined, now: number): string | undefined {
	let id: Omit<CacheEntry, "version" | "at"> | undefined;
	try {
		const st = statSync(real);
		id = { real, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		id = undefined;
	}
	if (cache !== undefined && id !== undefined) {
		try {
			const c = JSON.parse(readFileSync(cache, "utf8")) as Partial<CacheEntry>;
			const k = id;
			// An entry with no time, or from the future (a clock set back), is not fresh.
			const fresh = typeof c.at === "number" && c.at <= now && now - c.at <= VERSION_CACHE_MAX_AGE_MS;
			if (fresh && c.real === k.real && c.dev === k.dev && c.ino === k.ino && c.size === k.size && c.mtimeMs === k.mtimeMs && typeof c.version === "string" && parseVersion(c.version) !== undefined) return c.version;
		} catch {
			// No cache yet, or a broken one: ask.
		}
	}
	const e: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
	const r = spawnSync(found, ["--version"], { env: e, encoding: "utf8", timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 });
	if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
	const line = (r.stdout.trim().split("\n")[0] ?? "").trim().replace(/^v/, "");
	if (parseVersion(line) === undefined) return undefined;
	if (cache !== undefined && id !== undefined) {
		try {
			mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
			writeJsonAtomic(cache, { ...id, version: line, at: now });
		} catch {
			// A cache that cannot be written only costs the next run a `pi --version`.
		}
	}
	return line;
}

/** Whether the file at `path` starts with `#!`: a script, whose identity says nothing of the program it runs. */
function isScript(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(2);
		return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") === "#!";
	} catch {
		// Unreadable: treat it as a script, so nothing is cached for it.
		return true;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The Pi that `spawn("pi")` with `env` runs, and its version. Undefined when
 * there is no `pi` on PATH. Runs nothing for an npm global or a managed
 * install; otherwise runs `pi --version` (at most 3 s), cached in `cache`
 * for up to 10 minutes, only for an executable of no known layout that is
 * not a script. `now` (ms since the epoch) is for tests.
 */
export function findPi(env: Env, opts: { readonly cache?: string; readonly now?: number } = {}): FoundPi | undefined {
	const found = piOnPath(env);
	if (found === undefined) return undefined;
	const real = realOf(found) ?? found;
	const known = npmLayout(found, real) ?? managedLayout(found, real);
	if (known !== undefined && known.version !== undefined) return known;
	const cacheable = known === undefined && !isScript(real);
	const version = askVersion(found, real, env, cacheable ? opts.cache : undefined, opts.now ?? Date.now());
	return { path: found, ...(version === undefined ? {} : { version }), install: known?.install ?? { kind: "other" } };
}
