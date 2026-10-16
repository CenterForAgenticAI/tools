import { join, posix } from "node:path";
import type { MachineConfig } from "./config.ts";
import type { Manifest } from "./manifest.ts";
import { Refusal } from "./result.ts";
import { expectedSessionDir, storeChoice } from "./storechoice.ts";

/**
 * Path tokens for synced config (design §Config sync). `portable*` turns this
 * host's home and code root into `${HOME}` and `${CODE}`; `render*` expands
 * them on another host. All are pure: no file, environment or clock access.
 *
 * Only string values change, and only when a root is a whole path prefix: the
 * value equals the root or starts with root + "/". Keys never change. A host
 * root left anywhere else is reported, never rewritten.
 *
 * `sessionDir` is never portable. The settings forms drop a top-level one;
 * `renderSettings` sets it from the caller's `sessionDir` (see `sessionDirFor`).
 * The profile forms leave it alone.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TokenHost {
	/** This host's home directory, such as `/home/alice`. */
	readonly home: string;
	/** This host's code root: machine config `codeRoot`, else `<home>/Code`. */
	readonly codeRoot: string;
}

export interface Tokenized {
	readonly json: Json;
	/** Problems left as written, by JSON path, such as `env.A: unknown token ${USER} ...`. */
	readonly warnings: readonly string[];
}

export interface HostSetup {
	readonly host: TokenHost;
	readonly warnings: readonly string[];
}

type Root = readonly [root: string, name: string];

const SESSION_DIR = "sessionDir";
const TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const LEADING_TOKEN_BACKSLASH = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}\\/;
const KNOWN = new Set(["HOME", "CODE"]);
const CONTROL = /[\p{Cc}\p{Cf}]/u;

/**
 * A root that may stand for a token: an absolute POSIX path, already
 * normalised, not `/`, with no backslash and no control character. A Windows
 * path fails `posix.isAbsolute` or the backslash test.
 */
export function isTokenRoot(path: unknown): path is string {
	return typeof path === "string" && posix.isAbsolute(path) && posix.normalize(path) === path && path !== "/" && !path.endsWith("/") && !path.includes("\\") && !CONTROL.test(path);
}

function checkHost(host: TokenHost): void {
	// The messages never quote a path: a broken host value may be anything.
	if (!isTokenRoot(host.home)) throw new Refusal("the home directory must be an absolute, normalised POSIX path");
	if (!isTokenRoot(host.codeRoot)) throw new Refusal("codeRoot must be an absolute, normalised POSIX path");
}

function checkSessionDir(dir: string | undefined): void {
	if (dir === undefined) return;
	if (!posix.isAbsolute(dir) || posix.normalize(dir) !== dir || CONTROL.test(dir)) throw new Refusal("the session directory must be an absolute, normalised POSIX path without control characters");
}

function child(path: string, key: string | number): string {
	if (typeof key === "number") return `${path}[${key}]`;
	const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
	if (path === "") return name;
	return name.startsWith('"') ? `${path}[${name}]` : `${path}.${name}`;
}

function where(path: string): string {
	return path === "" ? "(top level)" : path;
}

/**
 * Rebuild `value`, mapping every string and showing every key to `onKey`;
 * `Object.fromEntries` keeps a `__proto__` key as an own key.
 */
function mapJson(value: Json, path: string, f: (s: string, path: string) => string, onKey: (key: string, path: string) => void = () => undefined): Json {
	if (typeof value === "string") return f(value, path);
	if (Array.isArray(value)) return value.map((v, i) => mapJson(v, child(path, i), f, onKey));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => {
				const p = child(path, k);
				onKey(k, p);
				return [k, mapJson(v, p, f, onKey)];
			}),
		);
	return value;
}

function withoutSessionDir(value: Json): Json {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(Object.entries(value).filter(([k]) => k !== SESSION_DIR));
}

function isPrefix(root: string, s: string): boolean {
	return s === root || s.startsWith(`${root}/`);
}

/** This host's roots, longer first; on a tie `${HOME}` wins. */
function rootsOf(host: TokenHost): readonly Root[] {
	return host.codeRoot.length > host.home.length ? [[host.codeRoot, "CODE"], [host.home, "HOME"]] : [[host.home, "HOME"], [host.codeRoot, "CODE"]];
}

function tokenise(s: string, roots: readonly Root[]): string {
	for (const [root, name] of roots) if (isPrefix(root, s)) return `\${${name}}${s.slice(root.length)}`;
	return s;
}

/** The one value both directions refuse, so `portable` never keeps what `render` rejects. */
function checkSeparator(s: string, path: string): void {
	const m = LEADING_TOKEN_BACKSLASH.exec(s);
	if (m !== null && KNOWN.has(m[1] as string)) throw new Refusal(`${where(path)}: \${${m[1] as string}} is followed by a Windows-style separator; synced paths use /`);
}

/**
 * Tokens for this host's roots that sit in `s` as whole path segments where
 * `portable` leaves them as written: anywhere in a key; in a value, past the
 * start or followed by "\".
 */
function leaks(s: string, roots: readonly Root[], isKey: boolean): string[] {
	const names: string[] = [];
	for (const [root, name] of roots) {
		for (let i = s.indexOf(root); i !== -1; i = s.indexOf(root, i + 1)) {
			const next = s.charAt(i + root.length);
			if ((next === "" || next === "/" || next === "\\") && (isKey || i > 0 || next === "\\")) {
				names.push(`\${${name}}`);
				break;
			}
		}
	}
	return names;
}

function portableJson(json: Json, host: TokenHost, dropSessionDir: boolean): Tokenized {
	checkHost(host);
	const roots = rootsOf(host);
	const warnings: string[] = [];
	const out = mapJson(
		dropSessionDir ? withoutSessionDir(json) : json,
		"",
		(s, path) => {
			checkSeparator(s, path);
			for (const m of s.matchAll(TOKEN)) warnings.push(`${where(path)}: ${m[0]} is already in the local file; it is kept as written, so render will read it as a token`);
			const names = leaks(s, roots, false);
			if (names.length > 0) warnings.push(`${where(path)}: this host's path for ${names.join(" and ")} is after the start of the value or before "\\"; it is kept as written`);
			return tokenise(s, roots);
		},
		(key, path) => {
			const names = leaks(key, roots, true);
			if (names.length > 0) warnings.push(`${path}: the key holds this host's path for ${names.join(" and ")}; keys are never tokenised, so it is kept as written`);
		},
	);
	return { json: out, warnings };
}

/** `settings.json` to its synced form: roots become tokens and a top-level `sessionDir` is dropped. */
export function portableSettings(json: Json, host: TokenHost): Tokenized {
	return portableJson(json, host, true);
}

/** `profile.json` to its synced form: roots become tokens; nothing is dropped. */
export function portableProfile(json: Json, host: TokenHost): Tokenized {
	return portableJson(json, host, false);
}

/**
 * Expand `${HOME}` and `${CODE}` where they start a value and are followed by
 * "/" or the end. Any other token is left unchanged and reported. A known
 * token followed by "\" is refused: synced paths use "/". An expanded value
 * that this host would sync back differently is reported.
 */
function renderJson(json: Json, host: TokenHost): Tokenized {
	checkHost(host);
	const values: Readonly<Record<string, string>> = { HOME: host.home, CODE: host.codeRoot };
	const roots = rootsOf(host);
	const warnings: string[] = [];
	const out = mapJson(json, "", (s, path) => {
		checkSeparator(s, path);
		let expanded: string | undefined;
		for (const m of s.matchAll(TOKEN)) {
			const name = m[1] as string;
			if (!KNOWN.has(name)) {
				warnings.push(`${where(path)}: unknown token ${m[0]} is left unchanged`);
				continue;
			}
			const next = s.charAt(m[0].length);
			if (m.index === 0 && (next === "" || next === "/")) expanded = `${values[name] as string}${s.slice(m[0].length)}`;
			else warnings.push(`${where(path)}: ${m[0]} is not a whole path prefix, so it is left unchanged`);
		}
		if (expanded === undefined) return s;
		const back = tokenise(expanded, roots);
		if (back !== s) warnings.push(`${where(path)}: this host syncs the expanded path back as ${back}, so the value can change on a round trip`);
		return expanded;
	});
	return { json: out, warnings };
}

/**
 * Render a synced `settings.json`: expand tokens, then set `sessionDir` to
 * `sessionDir` (from `sessionDirFor`) or remove it when that is undefined.
 */
export function renderSettings(json: Json, host: TokenHost, sessionDir: string | undefined): Tokenized {
	checkSessionDir(sessionDir);
	const { json: out, warnings } = renderJson(withoutSessionDir(json), host);
	if (sessionDir === undefined || out === null || typeof out !== "object" || Array.isArray(out)) return { json: out, warnings };
	return { json: Object.fromEntries([...Object.entries(out), [SESSION_DIR, sessionDir]]), warnings };
}

/** Render a synced `profile.json`: expand tokens; `sessionDir` is not touched. */
export function renderProfile(json: Json, host: TokenHost): Tokenized {
	return renderJson(json, host);
}

/**
 * The `sessionDir` for a profile's rendered `settings.json`: its own session
 * store (`sessions.store` of the rendered `profile.json`) on this host, by the
 * rule `doctor` checks. Unset or `"profile"` gives none.
 */
export function sessionDirFor(manifest: Pick<Manifest, "sessions">, config: MachineConfig): string | undefined {
	const choice = storeChoice(manifest, config);
	if (choice.kind === "unknown") throw new Refusal(`profile.json references unknown session store: ${choice.id}`);
	return expectedSessionDir(choice);
}

/**
 * The token host for this machine: `codeRoot` from machine config, else
 * `<home>/Code`. Warns when the code root is home or a parent of home: the
 * two tokens then overlap, so a value can change on a round trip.
 */
export function tokenHost(config: MachineConfig, home: string): HostSetup {
	const host: TokenHost = { home, codeRoot: config.codeRoot ?? join(home, "Code") };
	const warnings = isPrefix(host.codeRoot, home) ? ["codeRoot is the home directory or a parent of it, so ${CODE} and ${HOME} overlap and a synced path can change on a round trip"] : [];
	return { host, warnings };
}
