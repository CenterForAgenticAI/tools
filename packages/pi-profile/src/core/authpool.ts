import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configPayloadText, readConfigView, sendConfig, type ConfigView } from "./authconfig.ts";
import { stampEntries } from "./authtime.ts";
import { authFiles, authTarget, entryHash, profilePush, isCommandKey, pullAuth, readableEntries, readAuthSnapshot, sendEntries, withPiAuthLocks, type AuthEntry, type AuthSnapshot, type SshRunner } from "./authsync.ts";
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
 * Automatic sync for the default profile and for pooled and shared profiles
 * (design: "Cross-device auth"). After a session, the extension checks whether
 * such a profile's auth.json changed (its SHA-256 against machine-local
 * state, L10) and, if so, starts `pi-profile auth sync` detached. That run
 * pushes the OAuth entries that changed to the peers in `authSync.peers`,
 * whichever machine logged in (L21; the default profile syncs although its
 * stored mode is separate, L30; any other separate profile pushes nothing),
 * and an API key only when the profile sets `auth.pushKeys` (L20). Pushes never pass --force, so a peer
 * takes the login that was written later (L26). It also pushes the
 * profile's pi-multi-account config, and `auth pull-peers` pulls newer
 * logins before this host spends a rotated refresh token. A peer that fails gets the same entries again, after an
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
	/** SHA-256 of pi-multi-account/config.json at the last check; undefined when there was none. */
	readonly config?: string;
	/** Peers that have not received the current config yet. */
	readonly configPending: readonly string[];
	/** Peers that kept their own, newer config. */
	readonly configKept: readonly string[];
	/** What each peer held at the last `auth pull-peers`: expiry times only. */
	readonly peerSeen: Readonly<Record<string, PeerSeen>>;
	/** Set when a saved time had to be clamped on reading; never saved. A sync then saves the clamped times. */
	readonly clamped?: boolean;
}

/** What a peer held when last asked: expiry time of each OAuth login. Never a token. */
export interface PeerSeen {
	readonly at: number;
	readonly expires: Readonly<Record<string, number>>;
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
		const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && NAME.test(p)) : []);
		const peerSeen: Record<string, PeerSeen> = {};
		if (record(raw.peerSeen)) {
			for (const [peer, v] of Object.entries(raw.peerSeen)) {
				if (!NAME.test(peer) || !record(v) || typeof v.at !== "number" || !Number.isFinite(v.at) || !record(v.expires)) continue;
				const expires: Record<string, number> = {};
				for (const [p, e] of Object.entries(v.expires)) if (NAME.test(p) && typeof e === "number" && Number.isFinite(e)) expires[p] = e;
				peerSeen[peer] = { at: v.at, expires };
			}
		}
		const config = typeof raw.config === "string" && HEX.test(raw.config) ? raw.config : undefined;
		return { mtimeMs: raw.mtimeMs, size: raw.size, sha256: raw.sha256, entries, pending, failing, ...(config === undefined ? {} : { config }), configPending: names(raw.configPending), configKept: names(raw.configKept), peerSeen, ...(clamped ? { clamped } : {}) };
	} catch {
		return undefined;
	}
}

interface Extra {
	readonly config?: string | undefined;
	readonly configPending?: readonly string[];
	readonly configKept?: readonly string[];
	readonly peerSeen?: Readonly<Record<string, PeerSeen>>;
}

function stateFor(snap: AuthSnapshot | undefined, entries: ReadonlyMap<string, AuthEntry>, pending: Readonly<Record<string, readonly string[]>>, failing: Readonly<Record<string, PeerFailure>> = {}, extra: Extra = {}): PoolState {
	const hashes: Record<string, string> = {};
	for (const [p, e] of entries) hashes[p] = entryHash(e);
	return {
		mtimeMs: snap?.mtimeMs ?? 0,
		size: snap?.size ?? 0,
		sha256: sha(snap?.text ?? ""),
		entries: hashes,
		pending,
		failing,
		...(extra.config === undefined ? {} : { config: extra.config }),
		configPending: extra.configPending ?? [],
		configKept: extra.configKept ?? [],
		peerSeen: extra.peerSeen ?? {},
	};
}

/** The multi-account config as it is now, or undefined when there is none or it cannot be read. */
function currentConfig(l: Layout, profile: string): ConfigView | undefined {
	try {
		return readConfigView(l, profile);
	} catch {
		return undefined;
	}
}

function savePoolState(l: Layout, profile: string, s: PoolState): void {
	mkdirSync(authPoolStateDir(l), { recursive: true, mode: 0o700 });
	writeJsonAtomic(statePath(l, profile), s);
}

/** True when a peer waits for entries and its backoff has passed. */
function duePending(s: PoolState, now: number): boolean {
	const waiting = (peer: string): boolean => (s.pending[peer]?.length ?? 0) > 0 || s.configPending.includes(peer);
	const peers = new Set([...Object.keys(s.pending), ...s.configPending]);
	return [...peers].some((peer) => waiting(peer) && (s.failing[peer]?.nextAttemptAt ?? 0) <= now);
}

/**
 * True when the profile pushes and pulls on its own. Mirrors
 * `D.syncsOnItsOwn`: the default profile always does, because its auth.json
 * is the shared one (L30), although its stored mode stays separate; any other
 * profile does when it is shared or pooled, and a separate one never does (L21).
 */
export function syncsOnItsOwn(profile: string, auth: { readonly mode: string }): boolean {
	return profile === DEFAULT_PROFILE || auth.mode === "pooled" || auth.mode === "shared";
}

/** Why a profile does not sync on its own, for a refusal or a status line. */
function noSyncReason(profile: string, mode: string, what: string): string {
	return `profile ${profile} is in ${mode} auth mode; only the default profile and shared and pooled profiles ${what} on their own`;
}

/** The profile this process runs in when it pushes on its own, with its peers; undefined when there is nothing to do. */
export function pooledProfile(l: Layout, env: Env): { profile: string; peers: readonly string[] } | undefined {
	const name = currentProfile(l, env).name;
	if (name !== DEFAULT_PROFILE && !isProfileName(name)) return undefined;
	const info = loadProfile(l, name);
	if (info.manifestErrors.length > 0 || !syncsOnItsOwn(name, info.manifest.auth)) return undefined;
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
	if (currentConfig(l, profile)?.sha256 !== s.config) return true;
	const snap = readAuthSnapshot(authTarget(l, profile));
	if (snap === undefined) return s.size !== 0 || s.sha256 !== sha("");
	return sha(snap.text) !== s.sha256;
}

export interface PeerOutcome {
	readonly peer: string;
	readonly sent: readonly string[];
	/** What the peer did with the multi-account config, when one was sent. */
	readonly config?: "added" | "replaced" | "kept" | "unchanged";
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
	/** The home directory pushed paths are rewritten from; HOME or the OS home when absent. */
	readonly home?: string;
	/** The clock; Date.now when absent. */
	readonly now?: () => number;
}

/**
 * `pi-profile auth sync`: push the OAuth entries of a profile that syncs on
 * its own (`syncsOnItsOwn`) that changed since the saved state to every
 * configured peer. The peer merges by
 * newest login (L26), never with --force. The first run records a baseline and
 * sends nothing, so turning pooled mode on does not copy every login at once.
 */
export function syncPooled(l: Layout, profile: string, opts: SyncOptions): SyncResult {
	const info = loadProfile(l, profile);
	const mode = info.manifest.auth.mode;
	const pushKeys = info.manifest.auth.pushKeys === true;
	if (info.manifestErrors.length > 0 || !syncsOnItsOwn(profile, info.manifest.auth)) throw new Refusal(noSyncReason(profile, mode, "push credentials"));
	const peers = loadConfig(l, opts.env).authSync?.peers ?? [];
	const home = opts.home ?? opts.env["HOME"] ?? homedir();
	const dir = authPoolStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const now = opts.now ?? Date.now;
	return withProfileLock(dir, () => {
		const { path, locks } = authFiles(l, profile);
		// Read-only: waits for Pi, never breaks its lock.
		const snap = withPiAuthLocks(locks, () => readAuthSnapshot(path));
		const entries = readableEntries(snap?.text ?? "", path);
		const view = currentConfig(l, profile);
		const before = readPoolState(l, profile, now());
		const hashes = new Map([...entries].filter(([, e]) => e.type === "oauth").map(([p, e]) => [p, entryHash(e)] as const));
		// Dates each login by when it was last written here (the file's mtime for one Pi just wrote).
		const writes = stampEntries(l, profile, hashes, snap?.mtimeMs ?? now());
		if (before === undefined) {
			savePoolState(l, profile, stateFor(snap, entries, {}, {}, { config: view?.sha256 }));
			return { baseline: true, peers: [] };
		}
		const changed = [...entries].filter(([p, e]) => before.entries[p] !== entryHash(e)).map(([p]) => p);
		const configChanged = view !== undefined && view.sha256 !== before.config;
		const pending: Record<string, string[]> = {};
		const failing: Record<string, PeerFailure> = {};
		const configPending: string[] = [];
		const configKept = new Set(before.configKept);
		const outcomes: PeerOutcome[] = [];
		for (const peer of peers) {
			const names = [...new Set([...changed, ...(before.pending[peer] ?? [])])].sort();
			const send = new Map<string, AuthEntry>();
			for (const p of names) {
				const e = entries.get(p);
				// A key Pi would run as a shell command is never sent on its own: the peer refuses it, and the whole push with it.
				if (e !== undefined && profilePush(profile, mode, pushKeys, e) && !isCommandKey(e)) send.set(p, e);
			}
			const was = before.failing[peer];
			const sendConfigNow = view !== undefined && (configChanged || before.configPending.includes(peer));
			if (send.size === 0 && !sendConfigNow) {
				outcomes.push({ peer, sent: [] });
				continue;
			}
			const t = now();
			if (was !== undefined && t < was.nextAttemptAt) {
				// Still backing off: keep the entries and the failure for a later run.
				if (send.size > 0) pending[peer] = [...send.keys()];
				if (sendConfigNow) configPending.push(peer);
				failing[peer] = was;
				outcomes.push({ peer, sent: [], error: was.lastError, retryAt: was.nextAttemptAt });
				continue;
			}
			let error: string | undefined;
			let sent: string[] = [];
			if (send.size > 0) {
				try {
					sendEntries(peer, profile, send, false, opts.run, false, new Map(Object.entries(writes)));
					sent = [...send.keys()];
				} catch (e) {
					error = printable((e as Error).message).slice(0, MAX_ERROR);
					pending[peer] = [...send.keys()];
				}
			}
			let config: PeerOutcome["config"];
			if (sendConfigNow) {
				try {
					config = sendConfig(peer, profile, configPayloadText(view, home), opts.run);
					if (config === "kept") configKept.add(peer);
					else configKept.delete(peer);
				} catch (e) {
					error ??= printable((e as Error).message).slice(0, MAX_ERROR);
					configPending.push(peer);
				}
			}
			if (error !== undefined) {
				const failures = (was?.failures ?? 0) + 1;
				failing[peer] = { failures, lastFailedAt: t, nextAttemptAt: t + retryDelay(failures), lastError: error };
				outcomes.push({ peer, sent: [], ...(config === undefined ? {} : { config }), error });
			} else outcomes.push({ peer, sent, ...(config === undefined ? {} : { config }) });
		}
		savePoolState(l, profile, stateFor(snap, entries, pending, failing, { config: view?.sha256, configPending, configKept: [...configKept].filter((p) => peers.includes(p)), peerSeen: before.peerSeen }));
		return { baseline: false, peers: outcomes };
	});
}

/** Record the first baseline for a profile that syncs on its own, if none is saved. `lockWaitMs` bounds the wait for a Pi holding auth.json's lock. */
export function recordBaseline(l: Layout, profile: string, lockWaitMs?: number): boolean {
	if (readPoolState(l, profile) !== undefined) return false;
	const dir = authPoolStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withProfileLock(dir, () => {
		if (readPoolState(l, profile) !== undefined) return false;
		const { path, locks } = authFiles(l, profile);
		// Read-only, and run from session_start: waits briefly, never breaks Pi's lock.
		const snap = withPiAuthLocks(locks, () => readAuthSnapshot(path), { waitMs: lockWaitMs });
		savePoolState(l, profile, stateFor(snap, readableEntries(snap?.text ?? "", path), {}, {}, { config: currentConfig(l, profile)?.sha256 }));
		return true;
	});
}

/**
 * `pi-profile auth status`: one line per configured peer of a profile that
 * syncs on its own, with entries waiting for it and its last error. Names and
 * times only; the state holds no credentials.
 */
export function authSyncStatus(l: Layout, profile: string, env: Env): string[] {
	const info = loadProfile(l, profile);
	const mode = info.manifest.auth.mode;
	if (info.manifestErrors.length > 0 || !syncsOnItsOwn(profile, info.manifest.auth)) return [`${profile}: ${mode} auth mode; only the default profile and shared and pooled profiles sync on their own`];
	const peers = loadConfig(l, env).authSync?.peers ?? [];
	if (peers.length === 0) return [`${profile}: no peers; add authSync.peers to config.json`];
	const s = readPoolState(l, profile);
	if (s === undefined) return [`${profile}: no sync yet`];
	return peers.map((peer) => {
		const waiting = [...(s.pending[peer] ?? []), ...(s.configPending.includes(peer) ? ["multi-account config"] : [])];
		const f = s.failing[peer];
		if (f === undefined) return waiting.length === 0 ? `${peer}: up to date${s.configKept.includes(peer) ? " (it kept its own, newer multi-account config)" : ""}` : `${peer}: waiting for ${waiting.join(", ")}`;
		const when = (t: number): string => new Date(t).toISOString();
		return `${peer}: failing (${String(f.failures)} in a row, last at ${when(f.lastFailedAt)}); next try after ${when(f.nextAttemptAt)}; waiting for ${waiting.join(", ") || "nothing"}; last error: ${f.lastError}`;
	});
}

export function syncArgs(profile: string): string[] {
	return ["auth", "sync", "--profile", profile, "--quiet"];
}

export function pullPeersArgs(profile: string): string[] {
	return ["auth", "pull-peers", "--profile", profile, "--quiet"];
}

export interface PullPeersResult {
	readonly peers: ReadonlyArray<{ readonly peer: string; readonly outcomes: readonly string[]; readonly error?: string }>;
}

/**
 * `pi-profile auth pull-peers`: before this host spends a refresh token, take
 * any login that was written later from each peer (the merge takes the
 * newest login, L26). An API key is taken only when the profile sets `auth.pushKeys`. Records the expiry
 * times the peers hold, for `doctor`. A peer that cannot be reached is skipped.
 */
export function pullPeers(l: Layout, profile: string, opts: { env: Env; run: SshRunner; now?: () => number }): PullPeersResult {
	const info = loadProfile(l, profile);
	if (info.manifestErrors.length > 0 || !syncsOnItsOwn(profile, info.manifest.auth)) throw new Refusal(noSyncReason(profile, info.manifest.auth.mode, "pull from peers"));
	const peers = loadConfig(l, opts.env).authSync?.peers ?? [];
	const now = opts.now ?? Date.now;
	const seen: Record<string, PeerSeen> = {};
	const results: Array<{ peer: string; outcomes: string[]; error?: string }> = [];
	for (const peer of peers) {
		try {
			const r = pullAuth(l, peer, { profile, oauthOnly: info.manifest.auth.pushKeys !== true, run: opts.run });
			seen[peer] = { at: now(), expires: r.seen };
			results.push({ peer, outcomes: r.outcomes.map((o) => `${o.provider}: ${o.outcome}`) });
		} catch (error) {
			results.push({ peer, outcomes: [], error: printable((error as Error).message).slice(0, MAX_ERROR) });
		}
	}
	const dir = authPoolStateDir(l);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	withProfileLock(dir, () => {
		const s = readPoolState(l, profile, now());
		if (s !== undefined) savePoolState(l, profile, { ...s, peerSeen: { ...s.peerSeen, ...seen } });
	});
	return { peers: results };
}

/** What `doctor` says about a profile that syncs on its own: pending pushes and drift against the peers at the last check. Offline: reads state only. */
export function driftFindings(l: Layout, profile: string, env: Env): string[] {
	const info = loadProfile(l, profile);
	if (info.manifestErrors.length > 0 || !syncsOnItsOwn(profile, info.manifest.auth)) return [];
	const peers = loadConfig(l, env).authSync?.peers ?? [];
	const s = readPoolState(l, profile);
	if (peers.length === 0 || s === undefined) return [];
	const out: string[] = [];
	let local = new Map<string, AuthEntry>();
	try {
		const path = authTarget(l, profile);
		local = readableEntries(readAuthSnapshot(path)?.text ?? "", path);
	} catch {
		// An unreadable auth file is reported by the other checks.
	}
	for (const peer of peers) {
		const waiting = s.pending[peer] ?? [];
		if (waiting.length > 0) out.push(`auth sync: ${peer} has not received ${waiting.join(", ")}${s.failing[peer] === undefined ? "" : ` (${s.failing[peer].lastError})`}`);
		if (s.configPending.includes(peer)) out.push(`auth sync: ${peer} has not received pi-multi-account/config.json`);
		if (s.configKept.includes(peer)) out.push(`config drift: ${peer} kept its own, newer pi-multi-account/config.json; the two differ`);
		const seen = s.peerSeen[peer];
		if (seen === undefined) continue;
		const when = new Date(seen.at).toISOString();
		for (const [p, expires] of Object.entries(seen.expires)) {
			const mine = local.get(p);
			if (mine === undefined) out.push(`expiry drift: ${peer} holds a login for ${p} that this host lacks (checked ${when})`);
			else if (mine.type === "oauth" && mine.expires < expires) out.push(`expiry drift: ${peer} holds a ${p} login that expires later than this host's (checked ${when}); run: pi-profile auth pull ${peer} --profile ${profile}`);
			else if (mine.type === "oauth" && mine.expires > expires) out.push(`expiry drift: ${peer} holds a ${p} login that expires earlier than this host's (checked ${when})`);
		}
	}
	return out.map((m) => printable(m));
}

export interface PoolDeps {
	readonly spawn?: Spawn;
	readonly runtime?: Runtime;
}

/** How long session start waits for Pi's auth.json lock before skipping; the sync records a baseline later. */
const START_LOCK_WAIT_MS = 250;

/** The extension's `session_start` work: the first baseline of a profile that syncs on its own. Never throws and never waits long. */
export function authPoolOnSessionStart(env: Env): boolean {
	try {
		const l = layoutFromEnv(env);
		const p = pooledProfile(l, env);
		return p === undefined ? false : recordBaseline(l, p.profile, START_LOCK_WAIT_MS);
	} catch {
		return false;
	}
}

/** Pi event-bus channels pi-multi-account emits on. Payload: `{ provider, kind }` only; never a token. */
export const CREDENTIAL_CHANGED_CHANNEL = "pi-multi-account:credential-changed";
/** Emitted just before pi-multi-account refreshes a login: take any newer login from the peers first. */
export const CREDENTIAL_REFRESH_CHANNEL = "pi-multi-account:credential-refresh-due";
export const CHANGE_KINDS: readonly string[] = ["refresh", "login", "invalidated"];

/** Wait this long after the last change before pushing, so a burst of refreshes is one push. */
export const DEBOUNCE_MS = 30_000;
/** How often the `auth.json` hash is checked for changes pi-multi-account did not announce. */
export const POLL_MS = 60_000;

export interface AutoSyncDeps extends PoolDeps {
	readonly debounceMs?: number;
	readonly pollMs?: number;
}

export interface AutoSync {
	/** An event-bus payload. Only a known `kind` and a valid `provider` count; nothing else is read or kept. */
	readonly onChange: (payload: unknown) => boolean;
	/** Take newer logins from the peers (detached `auth pull-peers`). */
	readonly pullNow: () => boolean;
	readonly stop: () => void;
}

/**
 * The extension's live auto-sync for a profile that syncs on its own (the
 * default profile, or a shared or pooled one):
 * a change event starts a debounced detached `auth sync`, and a fallback poll
 * of the `auth.json` hash covers changes made outside pi-multi-account. The
 * detached run finds what changed by hash, so the event's payload is not
 * passed on: no token can reach argv, a log or a diagnostic through it.
 * Never throws and never blocks.
 */
export function startAutoSync(env: Env, deps: AutoSyncDeps = {}): AutoSync | undefined {
	let l: Layout;
	let p: ReturnType<typeof pooledProfile>;
	try {
		l = layoutFromEnv(env);
		p = pooledProfile(l, env);
	} catch {
		return undefined;
	}
	if (p === undefined) return undefined;
	const profile = p.profile;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const launch = (args: readonly string[]): boolean => {
		try {
			const node = nodeExecPath(deps.runtime ?? currentRuntime());
			if (node === undefined) return false;
			launchCli(l, env, node, args, deps.spawn);
			return true;
		} catch {
			return false;
		}
	};
	const schedule = (): void => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			launch(syncArgs(profile));
		}, deps.debounceMs ?? DEBOUNCE_MS);
		timer.unref();
	};
	const poll = setInterval(() => {
		try {
			if (poolChanged(l, profile)) schedule();
		} catch {
			// A held lock or a damaged file: the next poll tries again.
		}
	}, deps.pollMs ?? POLL_MS);
	poll.unref();
	return {
		onChange: (payload) => {
			const v = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
			if (typeof v["provider"] !== "string" || !NAME.test(v["provider"]) || typeof v["kind"] !== "string" || !CHANGE_KINDS.includes(v["kind"])) return false;
			schedule();
			return true;
		},
		pullNow: () => launch(pullPeersArgs(profile)),
		stop: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			clearInterval(poll);
		},
	};
}

/**
 * The extension's `session_shutdown` work. When this profile syncs on its own,
 * has peers, and its auth.json changed, start `pi-profile auth sync` detached, as
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
