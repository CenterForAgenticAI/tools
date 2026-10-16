import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { hostId, loadConfig, type HostIdRunner } from "./config.ts";
import { readJson } from "./fsutil.ts";
import { withProfileLock } from "./lock.ts";
import { type Env, type Layout } from "./paths.ts";
import { Refusal } from "./result.ts";
import { readSnapshot, replaceIfUnchanged } from "./swap.ts";

/** `<repository root>/repository.json`. */
export interface RepositoryInfo {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly ownerHost: string;
	readonly createdAt: string;
}

/** One repository this host offers to peers. */
export interface Advertised {
	readonly path: string;
}

/** `~/.pi/pi-profile/advertised.json`. */
export interface AdvertisedFile {
	readonly schemaVersion: 1;
	readonly repositories: Readonly<Record<string, Advertised>>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Control and format characters (C0, C1, bidi overrides) would let a peer's
// text move the cursor, retitle the terminal, or make a path look different.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
const UNPRINTABLE_ALL = /[\p{Cc}\p{Cf}]/gu;

/** `text` as one POSIX shell word: single-quoted, each `'` written as `'\\''`. */
export function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Text from a peer or a subprocess, safe to print: unprintable characters become "?". */
export function printable(text: string): string {
	return text.replace(UNPRINTABLE_ALL, "?");
}

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function advertisedPath(l: Layout): string {
	return join(l.piHome, "pi-profile", "advertised.json");
}

function checkPath(path: string, what: string): void {
	// Check for unprintable characters first: the other messages quote the path.
	if (UNPRINTABLE.test(path)) throw new Refusal(`${what} must not contain control or format characters`);
	if (!isAbsolute(path)) throw new Refusal(`${what} must be absolute: ${JSON.stringify(path)}`);
}

/**
 * Parse an advertised.json. The text may come from a peer, so it is treated as
 * hostile: every field is checked and only named fields are copied.
 */
export function parseAdvertised(raw: unknown): AdvertisedFile {
	if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.repositories)) {
		throw new Refusal("advertised.json must be { schemaVersion: 1, repositories: { ID: { path } } }");
	}
	const repositories: Record<string, Advertised> = {};
	for (const [id, value] of Object.entries(raw.repositories)) {
		if (!ID.test(id)) throw new Refusal(`advertised.json: invalid repository ID: ${JSON.stringify(id)}`);
		if (!record(value) || typeof value.path !== "string") throw new Refusal(`advertised.json: ${id} must be { path }`);
		checkPath(value.path, `advertised.json: ${id} path`);
		repositories[id] = { path: value.path };
	}
	return { schemaVersion: 1, repositories };
}

export function loadAdvertised(l: Layout): AdvertisedFile {
	const raw = readJson(advertisedPath(l));
	return raw === undefined ? { schemaVersion: 1, repositories: {} } : parseAdvertised(raw);
}

function parseJson(text: string, path: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${path} is not valid JSON`);
	}
}

function parseRepository(raw: unknown, path: string): RepositoryInfo {
	if (
		!record(raw) ||
		raw.schemaVersion !== 1 ||
		typeof raw.id !== "string" ||
		typeof raw.ownerHost !== "string" ||
		typeof raw.createdAt !== "string"
	) {
		throw new Refusal(`${path} is not a pi-profile repository.json`);
	}
	return { schemaVersion: 1, id: raw.id, ownerHost: raw.ownerHost, createdAt: raw.createdAt };
}

/** This host's ID: config.json first, then the Tailscale/hostname lookup. */
export function localHost(l: Layout, env: Env, runner?: HostIdRunner): string {
	return loadConfig(l, env).hostId ?? hostId(env, runner);
}

/** Create repository.json without ever replacing a file that is already there. */
function createRepository(file: string, info: RepositoryInfo): boolean {
	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(info, null, "\t")}\n`);
	} finally {
		closeSync(fd);
	}
	return true;
}

export interface AdvertiseResult {
	readonly repository: RepositoryInfo;
	/** False when repository.json was already there and was adopted. */
	readonly created: boolean;
}

/**
 * Make `path` a session repository owned by this host and offer it to peers.
 * An existing repository.json is adopted only when it has the same ID and
 * owner; anything else is refused, so a directory is never claimed twice.
 */
export interface AdvertiseHooks {
	/** Test seam: runs after advertised.json is read and before it is replaced. */
	readonly afterRead?: () => void;
}

export function advertise(
	l: Layout,
	id: string,
	given: string,
	env: Env = process.env,
	runner?: HostIdRunner,
	now: Date = new Date(),
	hooks: AdvertiseHooks = {},
): AdvertiseResult {
	if (!ID.test(id)) throw new Refusal(`invalid repository ID: ${JSON.stringify(id)}`);
	checkPath(given, "repository path");
	const path = resolve(given);
	const owner = localHost(l, env, runner);
	const dir = join(l.piHome, "pi-profile");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withProfileLock(dir, () => {
		const file = advertisedPath(l);
		const snapshot = readSnapshot(file);
		const current = snapshot.text === undefined ? loadAdvertised(l) : parseAdvertised(parseJson(snapshot.text, file));
		if (current.repositories[id] !== undefined) throw new Refusal(`repository already advertised: ${id} (${current.repositories[id].path})`);
		for (const [other, value] of Object.entries(current.repositories)) {
			if (value.path === path) throw new Refusal(`${path} is already advertised as ${other}`);
		}
		// statSync follows a symlinked root, such as a link to a mounted volume.
		const st = statSync(path, { throwIfNoEntry: false });
		if (st !== undefined && !st.isDirectory()) throw new Refusal(`repository path is not a directory: ${path}`);
		mkdirSync(join(path, "hosts"), { recursive: true, mode: 0o700 });
		const repoFile = join(path, "repository.json");
		const fresh: RepositoryInfo = { schemaVersion: 1, id, ownerHost: owner, createdAt: now.toISOString() };
		const created = createRepository(repoFile, fresh);
		const repository = created ? fresh : parseRepository(readJson(repoFile), repoFile);
		if (repository.id !== id) throw new Refusal(`${path} is already repository ${repository.id}`);
		if (repository.ownerHost !== owner) throw new Refusal(`${path} is owned by host ${repository.ownerHost}, not ${owner}`);
		const next: AdvertisedFile = { schemaVersion: 1, repositories: { ...current.repositories, [id]: { path } } };
		hooks.afterRead?.();
		replaceIfUnchanged(file, snapshot, `${JSON.stringify(next, null, "\t")}\n`, "saving advertised repositories");
		return { repository, created };
	});
}

/** One online tailnet peer, named by its MagicDNS short name. */
export interface Peer {
	readonly host: string;
}

/** What a peer answered: its repositories, or why it could not be read. */
export type PeerAnswer =
	| { readonly host: string; readonly ok: true; readonly repositories: Readonly<Record<string, Advertised>> }
	| { readonly host: string; readonly ok: false; readonly error: string };

/** The processes discovery runs; tests replace them. */
export interface DiscoverRunner {
	/** `tailscale status --json` stdout, or undefined when Tailscale cannot be read. */
	readonly tailscaleStatus: () => string | undefined;
	/** Run the fixed read on `host` over SSH. */
	readonly readRemote: (host: string) => { readonly status: number | null; readonly stdout: string; readonly error?: string };
}

/** The command run on each peer. Always exits 0 once connected; empty output means nothing advertised. */
export const REMOTE_READ = "cat ~/.pi/pi-profile/advertised.json 2>/dev/null; true";

/** The subset of spawnSync discovery uses; a test seam. */
export type Spawn = (
	command: string,
	args: readonly string[],
	options: { encoding: "utf8"; timeout: number; maxBuffer: number; stdio: ["ignore", "pipe", "ignore" | "pipe"] },
) => { status: number | null; stdout: string | null; stderr?: string | null; error?: Error };

/** The ssh arguments for one peer: no shell, no prompts, a fixed remote command. */
export function sshArgs(host: string): string[] {
	return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host, REMOTE_READ];
}

export function spawnDiscoverRunner(spawn: Spawn): DiscoverRunner {
	return {
		tailscaleStatus: () => {
			// A large tailnet's status is several MB; the 1 MiB default would fail.
			const r = spawn("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
			return r.error === undefined && r.status === 0 && typeof r.stdout === "string" ? r.stdout : undefined;
		},
		readRemote: (host) => {
			const r = spawn("ssh", sshArgs(host), { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
			const error = r.error?.message ?? (r.status === 0 ? undefined : (r.stderr ?? "").trim().split("\n").pop());
			return { status: r.status, stdout: r.stdout ?? "", ...(error === undefined ? {} : { error }) };
		},
	};
}

export const processDiscoverRunner: DiscoverRunner = spawnDiscoverRunner(spawnSync as unknown as Spawn);

/**
 * Online peers from `tailscale status --json` that belong to the same
 * Tailscale user as this host. A shared tailnet can hold hundreds of other
 * people's servers; only your own devices can hold your repositories.
 * Tagged devices all share one Tailscale user, so a tagged peer is never
 * asked and a tagged host is refused. A name that is not a safe host label is
 * skipped, so nothing from the tailnet can become an ssh option.
 */
export function onlinePeers(statusJson: string): Peer[] {
	let raw: unknown;
	try {
		raw = JSON.parse(statusJson);
	} catch {
		throw new Error("tailscale status --json did not return JSON");
	}
	if (!record(raw)) throw new Error("tailscale status --json did not return an object");
	const self = record(raw.Self) ? raw.Self : undefined;
	if (typeof self?.UserID !== "number") throw new Error("tailscale status --json has no Self.UserID");
	if (tagged(self)) throw new Refusal("this host is a tagged Tailscale device; repo discover runs only on a device owned by a user");
	const user = self.UserID;
	const peers = record(raw.Peer) ? Object.values(raw.Peer) : [];
	const seen = new Set<string>();
	const out: Peer[] = [];
	for (const p of peers) {
		if (!record(p) || p.Online !== true || p.UserID !== user || tagged(p) || typeof p.DNSName !== "string") continue;
		const host = (p.DNSName.split(".")[0] ?? "").toLowerCase();
		if (!HOST.test(host) || seen.has(host)) continue;
		seen.add(host);
		out.push({ host });
	}
	return out.sort((a, b) => a.host.localeCompare(b.host));
}

function tagged(node: Record<string, unknown>): boolean {
	return Array.isArray(node.Tags) && node.Tags.length > 0;
}

function askPeer(host: string, runner: DiscoverRunner): PeerAnswer {
	const r = runner.readRemote(host);
	if (r.status !== 0) return { host, ok: false, error: printable(r.error ?? `ssh exited ${String(r.status)}`) };
	if (r.stdout.trim() === "") return { host, ok: true, repositories: {} };
	try {
		return { host, ok: true, repositories: parseAdvertised(JSON.parse(r.stdout) as unknown).repositories };
	} catch (error) {
		const why = error instanceof Refusal ? error.message : "advertised.json is not valid JSON";
		return { host, ok: false, error: printable(why) };
	}
}

/**
 * Every advertised repository on the tailnet: this host's own file first, then
 * each online peer's, read over SSH with a fixed command and no shell here.
 */
export function discover(l: Layout, env: Env = process.env, runner: DiscoverRunner = processDiscoverRunner, hostRunner?: HostIdRunner): PeerAnswer[] {
	const self = localHost(l, env, hostRunner);
	const status = runner.tailscaleStatus();
	if (status === undefined) throw new Error("cannot read tailscale status --json; is Tailscale running?");
	const peers = onlinePeers(status);
	return [{ host: self, ok: true, repositories: loadAdvertised(l).repositories }, ...peers.map((p) => askPeer(p.host, runner))];
}
