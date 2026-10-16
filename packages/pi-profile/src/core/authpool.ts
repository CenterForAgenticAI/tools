import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { authFiles, authTarget, autoPush, readableEntries, readAuthSnapshot, sendEntries, withPiAuthLocks, type AuthEntry, type AuthSnapshot, type SshRunner, entryObject } from "./authsync.ts";
import { currentRuntime, launchCli, nodeExecPath, type Runtime, type Spawn } from "./autobackup.ts";
import { loadConfig } from "./config.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { currentProfile } from "./launch.ts";
import { withProfileLock } from "./lock.ts";
import { isProfileName, DEFAULT_PROFILE } from "./names.ts";
import { layoutFromEnv, type Env, type Layout } from "./paths.ts";
import { loadProfile } from "./profiles.ts";
import { printable } from "./repo.ts";
import { Refusal } from "./result.ts";

/**
 * Pooled auth mode (design: "Cross-device auth"). After a session, the
 * extension checks whether a pooled profile's auth.json changed (its SHA-256
 * against machine-local state, L10) and, if so, starts
 * `pi-profile auth sync` detached. That run pushes only OAuth entries that
 * changed (L20) to the peers in `authSync.peers`, and only for a pooled
 * profile (L21). A peer that fails gets the same entries again, after an
 * exponential backoff (RETRY_BASE_MS, doubling, capped at RETRY_MAX_MS).
 */

/** The first wait after a peer fails. */
export const RETRY_BASE_MS = 5 * 60 * 1000;
/** The longest wait between tries to one peer. */
export const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/** The wait after `failures` failures in a row: 5 min, 10 min, 20 min, ... at most 24 h. */
export function retryDelay(failures: number): number {
	return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(failures - 1, 0), 20));
}

/** `~/.pi/pi-profile/state/authsync`: hashes only, machine-local, never replicated (L10). */
export function authPoolStateDir(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "authsync");
}
function statePath(l: Layout, profile: string): string {
	return join(authPoolStateDir(l), `${profile}.json`);
}

/** What a pooled profile's auth.json looked like at the last check. Hashes, never credentials. */
export interface PoolState {
	readonly mtimeMs: number;
	readonly size: number;
	readonly sha256: string;
	/** SHA-256 of each entry, by provider. */
	readonly entries: Readonly<Record<string, string>>;
	/** Providers a peer has not received yet, because the last push to it failed. */
	readonly pending: Readonly<Record<string, readonly string[]>>;
	/** Peers whose last push failed: when to try again and why. No credentials. */
	readonly failing: Readonly<Record<string, PeerFailure>>;
	/** Set when a saved time had to be clamped on reading; never saved. A sync then saves the clamped times. */
	readonly clamped?: boolean;
}

/** A failing peer. `lastError` is ssh's printable last stderr line or a fixed message, never a payload. */
export interface PeerFailure {
	readonly failures: number;
	readonly lastFailedAt: number;
	readonly nextAttemptAt: number;
	readonly lastError: string;
}

const MAX_ERROR = 300;

/** A time in the state: finite and not negative, or undefined. */
function time(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * A saved failure, or undefined when it is damaged (the peer is then tried at
 * once). The state file is only hashes and times, but it may be corrupt or
 * written under a clock that was far ahead. `lastFailedAt` is clamped to at
 * most `now` and `nextAttemptAt` to at most `lastFailedAt + RETRY_MAX_MS`,
 * so never past `now + RETRY_MAX_MS`. The bound rests on the saved failure
 * time, not on `now` alone, so once saved it stops moving and the peer comes due.
 */
function readFailure(v: unknown, now: number): { failure: PeerFailure; clamped: boolean } | undefined {
	if (!record(v)) return undefined;
	const { failures, lastError } = v;
	const failedAt = time(v.lastFailedAt);
	const nextAt = time(v.nextAttemptAt);
	if (typeof failures !== "number" || !Number.isSafeInteger(failures) || failures < 1) return undefined;
	if (failedAt === undefined || nextAt === undefined || typeof lastError !== "string") return undefined;
	const lastFailedAt = Math.min(failedAt, now);
	const nextAttemptAt = Math.min(nextAt, lastFailedAt + RETRY_MAX_MS);
	const failure = { failures, lastFailedAt, nextAttemptAt, lastError: printable(lastError).slice(0, MAX_ERROR) };
	return { failure, clamped: lastFailedAt !== failedAt || nextAttemptAt !== nextAt };
}

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function entryHash(e: AuthEntry): string {
	return sha(JSON.stringify(entryObject(e)));
}

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
const HEX = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The saved state; undefined when there is none or it is damaged (the next check starts a new baseline). */
export function readPoolState(l: Layout, profile: string, now: number = Date.now()): PoolState | undefined {
	try {
		const raw = readJson(statePath(l, profile));
		if (!record(raw) || typeof raw.mtimeMs !== "number" || !Number.isFinite(raw.mtimeMs) || typeof raw.size !== "number" || !Number.isFinite(raw.size) || typeof raw.sha256 !== "string" || !record(raw.entries) || !record(raw.pending)) return undefined;
		const entries: Record<string, string> = {};
		for (const [p, h] of Object.entries(raw.entries)) if (NAME.test(p) && typeof h === "string" && HEX.test(h)) entries[p] = h;
		const pending: Record<string, string[]> = {};
		for (const [peer, list] of Object.entries(raw.pending)) {
			if (NAME.test(peer) && Array.isArray(list)) pending[peer] = list.filter((p): p is string => typeof p === "string" && NAME.test(p));
		}
		const failing: Record<string, PeerFailure> = {};
		let clamped = false;
		if (record(raw.failing)) {
			for (const [peer, f] of Object.entries(raw.failing)) {
				const checked = readFailure(f, now);
				if (!NAME.test(peer) || checked === undefined) continue;
				failing[peer] = checked.failure;
				clamped ||= checked.clamped;
			}
		}
		return { mtimeMs: raw.mtimeMs, size: raw.size, sha256: raw.sha256, entries, pending, failing, ...(clamped ? { clamped } : {}) };
	} catch {
		return undefined;
	}
}

function stateFor(snap: AuthSnapshot | undefined, entries: ReadonlyMap<string, AuthEntry>, pending: Readonly<Record<string, readonly string[]>>, failing: Readonly<Record<string, PeerFailure>> = {}): PoolState {
	const hashes: Record<string, string> = {};
	for (const [p, e] of entries) hashes[p] = entryHash(e);
	return { mtimeMs: snap?.mtimeMs ?? 0, size: snap?.size ?? 0, sha256: sha(snap?.text ?? ""), entries: hashes, pending, failing };
}

function savePoolState(l: Layout, profile: string, s: PoolState): void {
	mkdirSync(authPoolStateDir(l), { recursive: true, mode: 0o700 });
	writeJsonAtomic(statePath(l, profile), s);
}

/** True when a peer waits for entries and its backoff has passed. */
function duePending(s: PoolState, now: number): boolean {
	return Object.entries(s.pending).some(([peer, list]) => list.length > 0 && (s.failing[peer]?.nextAttemptAt ?? 0) <= now);
}

/** The pooled profile this process runs in, with its peers; undefined when there is nothing to do. */
export function pooledProfile(l: Layout, env: Env): { profile: string; peers: readonly string[] } | undefined {
	const name = currentProfile(l, env).name;
	if (name !== DEFAULT_PROFILE && !isProfileName(name)) return undefined;
	const info = loadProfile(l, name);
	if (info.manifestErrors.length > 0 || info.manifest.auth.mode !== "pooled") return undefined;
	const peers = loadConfig(l, env).authSync?.peers ?? [];
	return peers.length === 0 ? undefined : { profile: name, peers };
}

/**
 * True when the auth file differs from the saved state, or a peer still waits
 * for entries. Always by SHA-256: a same-size rewrite within one mtime tick
 * keeps mtime and size (git's "racy clean"), and the file is already read.
 */
export function poolChanged(l: Layout, profile: string, now: number = Date.now()): boolean {
	const s = readPoolState(l, profile, now);
	// A clamped time is saved by the next sync, so the bound stops moving with the clock.
	if (s === undefined || s.clamped === true || duePending(s, now)) return true;
	const snap = readAuthSnapshot(authTarget(l, profile));
	if (snap === undefined) return s.size !== 0 || s.sha256 !== sha("");
	return sha(snap.text) !== s.sha256;
}

export interface PeerOutcome {
	readonly peer: string;
	readonly sent: readonly string[];
	readonly error?: string;
	/** Set when the peer is failing and its backoff has not passed: nothing was tried. */
	readonly retryAt?: number;
}
export interface SyncResult {
	/** True when this run only recorded the first baseline. */
	readonly baseline: boolean;
	readonly peers: readonly PeerOutcome[];
}

export interface SyncOptions {
	readonly env: Env;
	readonly run: SshRunner;
	/** The clock; Date.now when absent. */
	readonly now?: () => number;
}

/**
 * `pi-profile auth sync`: push the OAuth entries of a pooled profile that
 * changed since the saved state to every configured peer. The peer merges by
 * later expiry, never with --force. The first run records a baseline and
 * sends nothing, so turning pooled mode on does not copy every login at once.
 */
export function syncPooled(l: Layout, profile: string, opts: SyncOptions): SyncResult {
	const info = loadProfile(l, profile);
	const mode = info.manifest.auth.mode;
	if (info.manifestErrors.length > 0 || mode !== "pooled") throw new Refusal(`profile ${profile} is not in pooled auth mode; only pooled profiles push credentials on their own`);
	const peers = loadConfig(l, opts.env).authSync?.peers ?? [];
	const dir = authPoolStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const now = opts.now ?? Date.now;
	return withProfileLock(dir, () => {
		const { path, locks } = authFiles(l, profile);
		// Read-only: waits for Pi, never breaks its lock.
		const snap = withPiAuthLocks(locks, () => readAuthSnapshot(path));
		const entries = readableEntries(snap?.text ?? "", path);
		const before = readPoolState(l, profile, now());
		if (before === undefined) {
			savePoolState(l, profile, stateFor(snap, entries, {}));
			return { baseline: true, peers: [] };
		}
		const changed = [...entries].filter(([p, e]) => before.entries[p] !== entryHash(e)).map(([p]) => p);
		const pending: Record<string, string[]> = {};
		const failing: Record<string, PeerFailure> = {};
		const outcomes: PeerOutcome[] = [];
		for (const peer of peers) {
			const names = [...new Set([...changed, ...(before.pending[peer] ?? [])])].sort();
			const send = new Map<string, AuthEntry>();
			for (const p of names) {
				const e = entries.get(p);
				if (e !== undefined && autoPush(mode, e)) send.set(p, e);
			}
			const was = before.failing[peer];
			if (send.size === 0) {
				outcomes.push({ peer, sent: [] });
				continue;
			}
			const t = now();
			if (was !== undefined && t < was.nextAttemptAt) {
				// Still backing off: keep the entries and the failure for a later run.
				pending[peer] = [...send.keys()];
				failing[peer] = was;
				outcomes.push({ peer, sent: [], error: was.lastError, retryAt: was.nextAttemptAt });
				continue;
			}
			try {
				sendEntries(peer, profile, send, false, opts.run);
				outcomes.push({ peer, sent: [...send.keys()] });
			} catch (error) {
				const message = printable((error as Error).message).slice(0, MAX_ERROR);
				const failures = (was?.failures ?? 0) + 1;
				pending[peer] = [...send.keys()];
				failing[peer] = { failures, lastFailedAt: t, nextAttemptAt: t + retryDelay(failures), lastError: message };
				outcomes.push({ peer, sent: [], error: message });
			}
		}
		savePoolState(l, profile, stateFor(snap, entries, pending, failing));
		return { baseline: false, peers: outcomes };
	});
}

/** Record the first baseline for a pooled profile, if none is saved. `lockWaitMs` bounds the wait for a Pi holding auth.json's lock. */
export function recordBaseline(l: Layout, profile: string, lockWaitMs?: number): boolean {
	if (readPoolState(l, profile) !== undefined) return false;
	const dir = authPoolStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withProfileLock(dir, () => {
		if (readPoolState(l, profile) !== undefined) return false;
		const { path, locks } = authFiles(l, profile);
		// Read-only, and run from session_start: waits briefly, never breaks Pi's lock.
		const snap = withPiAuthLocks(locks, () => readAuthSnapshot(path), { waitMs: lockWaitMs });
		savePoolState(l, profile, stateFor(snap, readableEntries(snap?.text ?? "", path), {}));
		return true;
	});
}

/**
 * `pi-profile auth status`: one line per configured peer of a pooled
 * profile, with entries waiting for it and its last error. Names and
 * times only; the state holds no credentials.
 */
export function authSyncStatus(l: Layout, profile: string, env: Env): string[] {
	const info = loadProfile(l, profile);
	const mode = info.manifest.auth.mode;
	if (info.manifestErrors.length > 0 || mode !== "pooled") return [`${profile}: ${mode} auth mode; only pooled profiles sync on their own`];
	const peers = loadConfig(l, env).authSync?.peers ?? [];
	if (peers.length === 0) return [`${profile}: no peers; add authSync.peers to config.json`];
	const s = readPoolState(l, profile);
	if (s === undefined) return [`${profile}: no sync yet`];
	return peers.map((peer) => {
		const waiting = s.pending[peer] ?? [];
		const f = s.failing[peer];
		if (f === undefined) return waiting.length === 0 ? `${peer}: up to date` : `${peer}: waiting for ${waiting.join(", ")}`;
		const when = (t: number): string => new Date(t).toISOString();
		return `${peer}: failing (${String(f.failures)} in a row, last at ${when(f.lastFailedAt)}); next try after ${when(f.nextAttemptAt)}; waiting for ${waiting.join(", ") || "nothing"}; last error: ${f.lastError}`;
	});
}

export function syncArgs(profile: string): string[] {
	return ["auth", "sync", "--profile", profile, "--quiet"];
}

export interface PoolDeps {
	readonly spawn?: Spawn;
	readonly runtime?: Runtime;
}

/** How long session start waits for Pi's auth.json lock before skipping; the sync records a baseline later. */
const START_LOCK_WAIT_MS = 250;

/** The extension's `session_start` work: a pooled profile's first baseline. Never throws and never waits long. */
export function authPoolOnSessionStart(env: Env): boolean {
	try {
		const l = layoutFromEnv(env);
		const p = pooledProfile(l, env);
		return p === undefined ? false : recordBaseline(l, p.profile, START_LOCK_WAIT_MS);
	} catch {
		return false;
	}
}

/**
 * The extension's `session_shutdown` work. When this is a pooled profile with
 * peers and its auth.json changed, start `pi-profile auth sync` detached, as
 * auto-backup does. Never throws and never waits: a broken config, a held
 * lock or a failed spawn must not stop Pi. Returns whether a sync started.
 */
export function authPoolOnSessionEnd(env: Env, deps: PoolDeps = {}): boolean {
	try {
		const node = nodeExecPath(deps.runtime ?? currentRuntime());
		if (node === undefined) return false;
		const l = layoutFromEnv(env);
		const p = pooledProfile(l, env);
		if (p === undefined || !poolChanged(l, p.profile)) return false;
		launchCli(l, env, node, syncArgs(p.profile), deps.spawn);
		return true;
	} catch {
		return false;
	}
}
