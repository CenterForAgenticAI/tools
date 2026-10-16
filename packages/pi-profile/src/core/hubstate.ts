import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { isHubName } from "./manifest.ts";
import { isSelectableName } from "./names.ts";
import type { Layout } from "./paths.ts";
import { Refusal } from "./result.ts";

/**
 * What config sync last agreed with each hub (`state/sync/last.json`,
 * machine-local, never synced). `sync pull` reads it to tell a local edit
 * from a hub change; `sync pull` and `sync push` write it under the `sync/`
 * lock.
 *
 * For each config file of each profile, the record holds two ids of the copy
 * this host and the hub last agreed on: `local`, the SHA-256 of the bytes on
 * this host (rendered form), and `hub`, the git blob id in the hub (portable
 * form). A file changed here when its bytes no longer hash to `local`; the
 * hub changed it when its blob is no longer `hub`. `rendered` is the id of
 * the hub copy as this host renders it (path tokens, `sessionDir`): a pull
 * writes a file the hub did not change only when that render changed since,
 * so a local file that was never in rendered form (a hand-set `sessionDir`)
 * is not rewritten by a pull that changes nothing.
 *
 * `held` lists the hub files of a profile the last pull left out because
 * they are not config here. The hold belongs to the record's `hub`, the
 * hub that pull read: while it is set, `sync push` of that profile to that
 * hub is refused, whatever the mirror's `main` is, since the push would
 * drop them from the hub. A push to another hub is not (issue 52).
 * Records written before this rule have the same shape and read the same.
 */

export interface FileRecord {
	readonly local: string;
	readonly hub: string;
	readonly rendered?: string;
}

export interface ProfileRecord {
	readonly hub: string;
	readonly files: ReadonlyMap<string, FileRecord>;
	readonly held?: readonly string[];
}

export interface HubRecord {
	/** The hub commit this host last pulled in full. */
	readonly commit: string;
	readonly at: string;
}

export interface SyncState {
	readonly hubs: Map<string, HubRecord>;
	readonly profiles: Map<string, ProfileRecord>;
}

/** `~/.pi/pi-profile/state/sync/last.json`. */
export function syncStatePath(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "sync", "last.json");
}

/** The id of a local file's bytes: SHA-256, hex. */
export function localId(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Why `rel` is not a plain relative `/` path, or undefined. */
export function relProblem(rel: string): string | undefined {
	if (rel.length === 0 || rel.startsWith("/") || rel.includes("\\")) return "not a relative / path";
	if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) return "not a plain relative path";
	if (/[\p{Cc}]/u.test(rel)) return "holds a control character";
	return undefined;
}

const HEX = /^[0-9a-f]{40,64}$/;

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseSyncState(raw: unknown): SyncState | string {
	const shape = 'last.json must be { "schemaVersion": 1, "hubs": { HUB: { commit, at } }, "profiles": { NAME: { hub, files: { PATH: { local, hub, rendered? } }, held?: [PATH] } } }';
	if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.hubs) || !record(raw.profiles)) return shape;
	const hubs = new Map<string, HubRecord>();
	for (const [hub, v] of Object.entries(raw.hubs)) {
		if (!isHubName(hub) || !record(v) || typeof v.commit !== "string" || !HEX.test(v.commit) || typeof v.at !== "string") return shape;
		hubs.set(hub, { commit: v.commit, at: v.at });
	}
	const profiles = new Map<string, ProfileRecord>();
	for (const [name, v] of Object.entries(raw.profiles)) {
		if (!isSelectableName(name) || !record(v) || !isHubName(v.hub) || !record(v.files)) return shape;
		const files = new Map<string, FileRecord>();
		for (const [rel, f] of Object.entries(v.files)) {
			if (relProblem(rel) !== undefined || !record(f) || typeof f.local !== "string" || !HEX.test(f.local) || typeof f.hub !== "string" || !HEX.test(f.hub)) return shape;
			if (f.rendered !== undefined && (typeof f.rendered !== "string" || !HEX.test(f.rendered))) return shape;
			files.set(rel, { local: f.local, hub: f.hub, ...(f.rendered === undefined ? {} : { rendered: f.rendered }) });
		}
		const held = v.held;
		if (held !== undefined && (!Array.isArray(held) || held.some((h) => typeof h !== "string" || relProblem(h) !== undefined))) return shape;
		profiles.set(name, { hub: v.hub, files, ...(held === undefined || held.length === 0 ? {} : { held: [...(held as string[])] }) });
	}
	return { hubs, profiles };
}

/** The recorded state; empty when there is none yet. A broken file is refused, never guessed at. */
export function readSyncState(l: Layout): SyncState {
	const path = syncStatePath(l);
	let raw: unknown;
	try {
		raw = readJson(path);
	} catch {
		raw = null;
	}
	if (raw === undefined) return { hubs: new Map(), profiles: new Map() };
	const s = parseSyncState(raw);
	if (typeof s === "string")
		throw new Refusal(`${path}: ${s}; remove it to start over (sync pull then treats every config file that differs from the hub as a conflict)`);
	return s;
}

const byKey = <T>(m: ReadonlyMap<string, T>): Array<[string, T]> => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Replace the state file atomically. */
export function writeSyncState(l: Layout, s: SyncState): void {
	const path = syncStatePath(l);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeJsonAtomic(path, {
		schemaVersion: 1,
		hubs: Object.fromEntries(byKey(s.hubs)),
		profiles: Object.fromEntries(
			byKey(s.profiles).map(([name, p]) => [name, { hub: p.hub, files: Object.fromEntries(byKey(p.files)), ...(p.held === undefined || p.held.length === 0 ? {} : { held: [...p.held].sort() }) }]),
		),
	});
}

/**
 * The way out of a hold on profile `name` (user decision on
 * issue 32): take the hub's copy, or widen this host's sync rules.
 */
export function holdWayOut(name: string): string {
	return (
		`to pull ${name} in full, take the hub's copy of its files with pi-profile sync pull --theirs ${name} ` +
		`(it also takes the hub's copy of each other file changed only here in ${name}: run it with --dry-run first to see each file it overwrites), ` +
		`or add the paths to sync.include in ${name}'s profile.json here (and drop any sync.exclude that matches them) and run pi-profile sync pull ${name}`
	);
}
