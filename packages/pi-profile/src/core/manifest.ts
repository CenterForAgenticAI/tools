import { isColor } from "./color.ts";
import { validateEnv } from "./env.ts";
import { fail, ok, type Result } from "./result.ts";
import { patternProblem } from "./syncpattern.ts";

export const AUTH_MODES = ["shared", "separate", "pooled"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** `profile.json`: the pi-profile manifest kept in each profile directory. */
export interface Manifest {
	schemaVersion: 1;
	name: string;
	description?: string;
	color?: string;
	/** `pushKeys`: also sync API keys automatically (default off, L20). Shared and pooled profiles, and the default profile, always sync OAuth logins on their own (L21, L30). */
	auth: { mode: AuthMode; pushKeys?: boolean };
	multiAccount?: { group: string; members?: string[] };
	sessions?: { store: string };
	env?: Record<string, string>;
	sync?: SyncSetting;
}

/**
 * `sync` in profile.json: relative globs that widen unknown paths to config
 * (`include`) or keep paths local (`exclude`), and credential-scan findings
 * the user has checked (`allowFindings`).
 */
export interface SyncSetting {
	/** The hub (machine config `hubs`) config sync pushes this profile to; `default` when unset. */
	hub?: string;
	include?: string[];
	exclude?: string[];
	allowFindings?: AllowFinding[];
}

/**
 * One allowed credential-scan finding: the file, the line (from 1), the key
 * the scan named, a random 16-byte `salt` (32 lower-case hex digits) and the
 * `scrypt` digest (64 lower-case hex digits) of the path, key and that line's
 * text (`allowDigest` in syncmanifest.ts). It matches only while all of them
 * match, so any edit to the line flags it again. No globs.
 */
export interface AllowFinding {
	readonly path: string;
	readonly line: number;
	readonly key: string;
	readonly salt: string;
	readonly scrypt: string;
}

const ALLOW_KEYS = ["path", "line", "key", "salt", "scrypt"] as const;
const ALLOW_SHAPE = '{ "path", "line", "key", "salt", "scrypt" }';

/** Why `p` is not a normalised relative path to one file, or undefined: no leading `/` or `\\`, no empty, `.` or `..` segment, no glob or control character. */
export function allowPathProblem(p: string): string | undefined {
	if (p.length === 0) return "must not be empty";
	if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return "must be relative and use /";
	if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return "must be normalised: no empty, . or .. segment";
	if (/[*?[\]{}]/.test(p)) return "must name one file: no glob characters";
	if (/[\p{Cc}]/u.test(p)) return "must not hold control characters";
	return undefined;
}

function parseAllow(raw: unknown, i: number): Result<AllowFinding> {
	const where = `sync.allowFindings[${String(i)}]`;
	if (!isRecord(raw)) return fail(`${where} must be ${ALLOW_SHAPE}`);
	if ("sha256" in raw) return fail(`${where} is an old sha256 entry, which is no longer accepted; regenerate it with pi-profile sync status --allow-line PATH:LINE`);
	const errors: string[] = [];
	for (const k of Object.keys(raw)) if (!(ALLOW_KEYS as readonly string[]).includes(k)) errors.push(`${where} has an unknown key: ${k}`);
	const { path, line, key, salt, scrypt } = raw;
	if (typeof path !== "string") errors.push(`${where}.path must be a string`);
	else {
		const problem = allowPathProblem(path);
		if (problem !== undefined) errors.push(`${where}.path ${problem}`);
	}
	if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) errors.push(`${where}.line must be a positive integer`);
	if (typeof key !== "string" || key.trim().length === 0 || key.length > 256 || /[\p{Cc}\s]/u.test(key)) errors.push(`${where}.key must be a non-empty key name without spaces`);
	if (typeof salt !== "string" || !/^[0-9a-f]{32}$/.test(salt)) errors.push(`${where}.salt must be 32 lower-case hex characters`);
	if (typeof scrypt !== "string" || !/^[0-9a-f]{64}$/.test(scrypt)) errors.push(`${where}.scrypt must be 64 lower-case hex characters`);
	if (errors.length > 0) return { ok: false, errors };
	return ok({ path: path as string, line: line as number, key: key as string, salt: salt as string, scrypt: scrypt as string });
}

const TOP_KEYS = new Set(["schemaVersion", "name", "description", "color", "auth", "multiAccount", "sessions", "env", "sync"]);
const GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isAuthMode(v: unknown): v is AuthMode {
	return typeof v === "string" && (AUTH_MODES as readonly string[]).includes(v);
}

export function isGroupName(v: string): boolean {
	return GROUP.test(v);
}

/**
 * Validate a parsed `profile.json`. `profileDir` is needed to check that
 * path-valued environment entries stay inside the profile.
 */
export function parseManifest(raw: unknown, profileDir: string): Result<Manifest> {
	if (!isRecord(raw)) return fail("profile.json must be a JSON object");
	const errors: string[] = [];
	for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) errors.push(`unknown key: ${key}`);
	if (raw["schemaVersion"] !== 1) errors.push("schemaVersion must be 1");
	const name = raw["name"];
	if (typeof name !== "string" || name.length === 0) errors.push("name must be a non-empty string");
	const m: Manifest = { schemaVersion: 1, name: typeof name === "string" ? name : "", auth: { mode: "shared" } };

	const description = raw["description"];
	if (description !== undefined) {
		if (typeof description !== "string" || description.length > 500) errors.push("description must be a string of at most 500 characters");
		else m.description = description;
	}
	const color = raw["color"];
	if (color !== undefined) {
		if (typeof color !== "string" || !isColor(color)) errors.push("color must be #rrggbb or a palette name");
		else m.color = color;
	}
	const auth = raw["auth"];
	if (auth !== undefined) {
		if (!isRecord(auth) || !isAuthMode(auth["mode"]) || Object.keys(auth).some((k) => k !== "mode" && k !== "pushKeys") || (auth["pushKeys"] !== undefined && typeof auth["pushKeys"] !== "boolean"))
			errors.push('auth must be { "mode": "shared" | "separate" | "pooled", "pushKeys": true | false }');
		else m.auth = { mode: auth["mode"], ...(auth["pushKeys"] === undefined ? {} : { pushKeys: auth["pushKeys"] }) };
	}
	const ma = raw["multiAccount"];
	if (ma !== undefined) {
		if (!isRecord(ma) || typeof ma["group"] !== "string" || !GROUP.test(ma["group"]))
			errors.push("multiAccount.group must be a group name");
		else {
			const members = ma["members"];
			if (members !== undefined && !(Array.isArray(members) && members.every((x) => typeof x === "string" && x.length > 0)))
				errors.push("multiAccount.members must be a list of account IDs");
			else if (Object.keys(ma).some((k) => k !== "group" && k !== "members")) errors.push("multiAccount has an unknown key");
			else m.multiAccount = members === undefined ? { group: ma["group"] } : { group: ma["group"], members: [...(members as string[])] };
		}
	}
	const sessions = raw["sessions"];
	if (sessions !== undefined) {
		if (!isRecord(sessions) || typeof sessions["store"] !== "string" || sessions["store"].length === 0)
			errors.push("sessions.store must be a store ID or \"profile\"");
		else m.sessions = { store: sessions["store"] };
	}
	const env = raw["env"];
	if (env !== undefined) {
		const checked = validateEnv(env, profileDir);
		if (checked.ok) m.env = checked.value;
		else errors.push(...checked.errors);
	}
	const sync = raw["sync"];
	if (sync !== undefined) {
		const checked = parseSyncSetting(sync);
		if (checked.ok) m.sync = checked.value;
		else errors.push(...checked.errors);
	}
	return errors.length > 0 ? { ok: false, errors } : ok(m);
}

const SYNC_LISTS = ["include", "exclude"] as const;
const SYNC_KEYS: readonly string[] = ["hub", ...SYNC_LISTS, "allowFindings"];
/** A hub name: one safe path segment, as a profile name. */
const HUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isHubName(v: unknown): v is string {
	return typeof v === "string" && HUB_NAME.test(v);
}

/** Validate the `sync` setting of a profile.json on its own, as config sync reads it from a hub. */
export function parseSyncSetting(raw: unknown): Result<SyncSetting> {
	if (!isRecord(raw) || Object.keys(raw).some((k) => !SYNC_KEYS.includes(k)))
		return fail('sync must be { "hub"?: name, "include"?: [patterns], "exclude"?: [patterns], "allowFindings"?: [{ "path", "line", "key", "salt", "scrypt" }] }');
	const out: SyncSetting = {};
	const errors: string[] = [];
	const hub = raw["hub"];
	if (hub !== undefined) {
		if (!isHubName(hub)) errors.push("sync.hub must be a hub name: letters, digits, '.', '_' or '-'");
		else out.hub = hub;
	}
	const allow = raw["allowFindings"];
	if (allow !== undefined) {
		if (!Array.isArray(allow)) errors.push("sync.allowFindings must be a list");
		else {
			const good: AllowFinding[] = [];
			(allow as unknown[]).forEach((a, i) => {
				const r = parseAllow(a, i);
				if (r.ok) good.push(r.value);
				else errors.push(...r.errors);
			});
			out.allowFindings = good;
		}
	}
	for (const key of SYNC_LISTS) {
		const list = raw[key];
		if (list === undefined) continue;
		if (!Array.isArray(list)) {
			errors.push(`sync.${key} must be a list of patterns`);
			continue;
		}
		const good: string[] = [];
		for (const p of list as unknown[]) {
			if (typeof p !== "string" || p.length === 0) {
				errors.push(`sync.${key} entries must be non-empty strings`);
				continue;
			}
			const problem = patternProblem(p, key);
			if (problem !== undefined) errors.push(`sync.${key}: ${JSON.stringify(p)} ${problem}`);
			else good.push(p);
		}
		out[key] = good;
	}
	return errors.length > 0 ? { ok: false, errors } : ok(out);
}

export function serializeManifest(m: Manifest): string {
	return `${JSON.stringify(m, null, "\t")}\n`;
}
