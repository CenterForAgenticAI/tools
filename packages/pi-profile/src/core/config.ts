import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { readJson } from "./fsutil.ts";
import { readSnapshot, replaceIfUnchanged } from "./swap.ts";
import { withProfileLock } from "./lock.ts";
import { isHubName } from "./manifest.ts";
import { parseArchive, type ArchiveSettings } from "./archivesettings.ts";
import { type Layout } from "./paths.ts";
import { HOST_LABEL, parseReplicas, type Replica } from "./replica.ts";
import { Refusal } from "./result.ts";
import { isTokenRoot } from "./tokens.ts";

export interface SessionStore { readonly path: string }
/** Start `backup run` when a Pi session ends, at most once per `minIntervalSeconds` (default 300). */
export interface AutoBackup {
	readonly onSessionEnd: boolean;
	readonly minIntervalSeconds: number;
}
/** Peers that pooled-mode profiles push refreshed OAuth logins to, by Tailscale short name. */
export interface AuthSync {
	readonly peers: readonly string[];
}
/** A config hub: a git repository config sync pushes profiles to (design §Config sync). */
export interface Hub {
	/** A bare repository on a tailnet machine: `host:path`, `ssh://host/path`, or a local path or `file://` URL. */
	readonly remote: string;
}
/** The hub a profile syncs to when its `sync.hub` is unset. */
export const DEFAULT_HUB = "default";
/** `[user@]HOST:PATH` and `ssh://[user@]HOST[:PORT]/PATH`, HOST a Tailscale name (`TAILNET_HOST`). */
const SCP_REMOTE = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,31}@)?([a-z0-9][a-z0-9.-]{0,252}):([^-/][^\s]*|\/[^\s]+)$/;
const SSH_REMOTE = /^ssh:\/\/(?:[A-Za-z_][A-Za-z0-9_-]{0,31}@)?([a-z0-9][a-z0-9.-]{0,252})(?::[0-9]{1,5})?\/[^\s]+$/;
/** A Tailscale short name, or a MagicDNS name under `.ts.net`. */
function tailnetHost(host: string): boolean {
	if (HOST_LABEL.test(host)) return true;
	const labels = host.split(".");
	return labels.length >= 4 && host.endsWith(".ts.net") && labels.every((x) => HOST_LABEL.test(x));
}
const FILE_REMOTE = /^file:\/\/\/[^\s]*$/;
/**
 * Why `remote` cannot be a hub remote, or undefined. A hub is a bare git
 * repository on a tailnet machine, reached over ssh by its Tailscale short
 * name (`HOST:PATH`, `ssh://HOST/PATH`), or a local repository (an
 * absolute path, `file:///PATH`). So config sync stays on the tailnet
 * (`reach(ConfigSync) = Tailnet` in model/Domain.bend): a dotted host
 * name such as gitlab.com, https (which needs a credential helper), `ext::`
 * and any other transport are refused, and nothing can read as an option.
 */
export function hubRemoteProblem(remote: unknown): string | undefined {
	if (typeof remote !== "string" || remote.length === 0 || remote.length > 1024) return "must be a non-empty string";
	if (/[\p{Cc}\p{Cf}\s\\]/u.test(remote)) return "must not hold spaces, backslashes or control characters";
	if (remote.startsWith("-") || remote.includes("::")) return "must not start with - or name a git transport (::)";
	const path = posix.isAbsolute(remote) ? remote : FILE_REMOTE.test(remote) ? remote.slice("file://".length) : undefined;
	if (path !== undefined) return path.split("/").includes("..") ? "must not hold a .. segment" : undefined;
	const m = SSH_REMOTE.exec(remote) ?? (remote.includes("://") ? null : SCP_REMOTE.exec(remote));
	if (m !== null && tailnetHost(m[1] as string)) return undefined;
	return "must be a bare git repository on a tailnet machine (HOST:PATH or ssh://HOST/PATH, HOST a Tailscale short name or a MagicDNS name ending in .ts.net) or a local path";
}
/** `hubs: { NAME: { remote } }`, each copied field by field. */
export function parseHubs(raw: unknown): Record<string, Hub> {
	if (!record(raw)) throw new Refusal("hubs must be { NAME: { remote } }");
	const hubs: Record<string, Hub> = {};
	const errors: string[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (!isHubName(name)) {
			errors.push("hubs: each name must be letters, digits, '.', '_' or '-'");
			continue;
		}
		if (!record(value) || Object.keys(value).some((k) => k !== "remote")) {
			errors.push(`hubs.${name} must be { remote }`);
			continue;
		}
		const problem = hubRemoteProblem(value.remote);
		if (problem !== undefined) errors.push(`hubs.${name}.remote ${problem}`);
		else hubs[name] = { remote: value.remote as string };
	}
	if (errors.length) throw new Refusal(errors.join("; "));
	return hubs;
}
export interface MachineConfig {
	readonly schemaVersion: 1;
	readonly hostId?: string;
	readonly defaultProfile?: string;
	readonly sessionStores: Record<string, SessionStore>;
	readonly defaultSessionStore?: string;
	readonly replicas?: readonly Replica[];
	readonly autoBackup?: AutoBackup;
	readonly authSync?: AuthSync;
	/** The age identity file `sessions pull` decrypts with when `--identity` is not given. A path on this host, never a key. */
	readonly pullIdentity?: string;
	/** The root that `${CODE}` stands for in synced settings; `<home>/Code` when unset. */
	readonly codeRoot?: string;
	/** Config hubs by name; a profile names one in `sync.hub`, else `default`. */
	readonly hubs?: Readonly<Record<string, Hub>>;
	/** Where `sessions archive` puts old sessions, and when. */
	readonly archive?: ArchiveSettings;
}
const KEYS = new Set(["schemaVersion", "hostId", "defaultProfile", "sessionStores", "defaultSessionStore", "replicas", "autoBackup", "authSync", "pullIdentity", "codeRoot", "hubs", "archive"]);
const MAX_AUTH_PEERS = 32;
function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
export function configPath(l: Layout): string { return join(l.piHome, "pi-profile", "config.json"); }
export type HostIdRunner = () => string;
function tailscaleHostId(): string {
	try {
		const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
		return typeof r.stdout === "string" ? r.stdout : "";
	} catch { return ""; }
}
export function hostId(env: Readonly<Record<string, string | undefined>> = process.env, runner: HostIdRunner = tailscaleHostId): string {
	const validate = (value: string): string => {
		const normalized = value.toLowerCase();
		if (!/^[a-z0-9-]+$/.test(normalized)) throw new Refusal(`host ID is not a safe path segment: ${value}`);
		return normalized;
	};
	if (env.PI_PROFILE_HOST_ID) return validate(env.PI_PROFILE_HOST_ID);
	try {
		const data = JSON.parse(runner()) as unknown;
		if (record(data) && typeof data.Self === "object" && data.Self !== null && typeof (data.Self as Record<string, unknown>).DNSName === "string") {
			const dns = ((data.Self as Record<string, unknown>).DNSName as string).replace(/\.$/, "");
			if (dns.length > 0) return validate(dns.split(".")[0] ?? dns);
		}
	} catch (error) {
		if (error instanceof Refusal) throw error;
	}
	return validate(hostname());
}
/** The interval when `autoBackup.minIntervalSeconds` is absent, as in the design's example. */
export const DEFAULT_MIN_INTERVAL_SECONDS = 300;
export function parseAutoBackup(raw: unknown): AutoBackup {
	const shape = "autoBackup must be { onSessionEnd: boolean, minIntervalSeconds?: number }";
	if (!record(raw)) throw new Refusal(shape);
	const errors = Object.keys(raw).filter((k) => k !== "onSessionEnd" && k !== "minIntervalSeconds").map((k) => `autoBackup.${k} is not a known key`);
	if (typeof raw.onSessionEnd !== "boolean") errors.push("autoBackup.onSessionEnd must be true or false");
	const interval = "minIntervalSeconds" in raw ? raw.minIntervalSeconds : DEFAULT_MIN_INTERVAL_SECONDS;
	if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) errors.push("autoBackup.minIntervalSeconds must be a number of seconds, 0 or more");
	if (errors.length) throw new Refusal(errors.join("; "));
	return { onSessionEnd: raw.onSessionEnd as boolean, minIntervalSeconds: interval as number };
}
/**
 * `authSync: { peers: [HOST, ...] }`. Each peer is a Tailscale short name
 * (HOST_LABEL), so a peer can never be read as an ssh option; the list is
 * copied, never passed through.
 */
export function parseAuthSync(raw: unknown): AuthSync {
	const shape = "authSync must be { peers: [Tailscale short name, ...] }";
	if (!record(raw) || Object.keys(raw).some((k) => k !== "peers") || !Array.isArray(raw.peers) || raw.peers.length > MAX_AUTH_PEERS) throw new Refusal(shape);
	const peers: string[] = [];
	for (const p of raw.peers) {
		if (typeof p !== "string" || !HOST_LABEL.test(p)) throw new Refusal("authSync.peers: each peer must be a Tailscale short name, such as good-kite-studio");
		if (peers.includes(p)) throw new Refusal(`authSync.peers: ${p} is listed twice`);
		peers.push(p);
	}
	return { peers };
}
export function parseConfig(raw: unknown): MachineConfig {
	if (!record(raw)) throw new Refusal("config.json must be a JSON object");
	const errors = Object.keys(raw).filter((k) => !KEYS.has(k));
	if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	const normalizedHostId = typeof raw.hostId === "string" ? raw.hostId.toLowerCase() : undefined;
	if (normalizedHostId === undefined || normalizedHostId.length === 0) errors.push("hostId must be a non-empty string");
	else if (!/^[a-z0-9-]+$/.test(normalizedHostId)) errors.push("hostId must be a safe path segment");
	const stores: Record<string, SessionStore> = {};
	if (!record(raw.sessionStores)) errors.push("sessionStores must be an object");
	else for (const [id, value] of Object.entries(raw.sessionStores)) {
		if (!record(value) || typeof value.path !== "string" || value.path.length === 0 || Object.keys(value).some((k) => k !== "path")) errors.push(`sessionStores.${id} must be { path }`);
		else stores[id] = { path: value.path };
	}
	if (raw.defaultProfile !== undefined && typeof raw.defaultProfile !== "string") errors.push("defaultProfile must be a string");
	if (raw.defaultSessionStore !== undefined && (typeof raw.defaultSessionStore !== "string" || !(raw.defaultSessionStore in stores))) errors.push("defaultSessionStore must name a session store");
	let replicas: Replica[] | undefined;
	if (raw.replicas !== undefined) {
		try {
			replicas = parseReplicas(raw.replicas);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	let autoBackup: AutoBackup | undefined;
	if (raw.autoBackup !== undefined) {
		try {
			autoBackup = parseAutoBackup(raw.autoBackup);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	let authSync: AuthSync | undefined;
	if (raw.authSync !== undefined) {
		try {
			authSync = parseAuthSync(raw.authSync);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	// The message never quotes the path: it names an identity file.
	if (raw.pullIdentity !== undefined && (typeof raw.pullIdentity !== "string" || !isAbsolute(raw.pullIdentity) || /[\p{Cc}\p{Cf}]/u.test(raw.pullIdentity))) errors.push("pullIdentity must be an absolute path without control characters");
	if (raw.codeRoot !== undefined && !isTokenRoot(raw.codeRoot)) errors.push("codeRoot must be an absolute, normalised path, such as /home/user/Code");
	let hubs: Record<string, Hub> | undefined;
	if (raw.hubs !== undefined) {
		try {
			hubs = parseHubs(raw.hubs);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	let archive: ArchiveSettings | undefined;
	if (raw.archive !== undefined) {
		try {
			archive = parseArchive(raw.archive);
		} catch (error) {
			errors.push((error as Error).message);
		}
	}
	if (errors.length) throw new Refusal(errors.join("; "));
	return {
		schemaVersion: 1,
		hostId: normalizedHostId as string,
		sessionStores: stores,
		...(raw.defaultProfile === undefined ? {} : { defaultProfile: raw.defaultProfile as string }),
		...(raw.defaultSessionStore === undefined ? {} : { defaultSessionStore: raw.defaultSessionStore as string }),
		...(replicas === undefined ? {} : { replicas }),
		...(autoBackup === undefined ? {} : { autoBackup }),
		...(authSync === undefined ? {} : { authSync }),
		...(raw.pullIdentity === undefined ? {} : { pullIdentity: raw.pullIdentity as string }),
		...(raw.codeRoot === undefined ? {} : { codeRoot: raw.codeRoot as string }),
		...(hubs === undefined ? {} : { hubs }),
		...(archive === undefined ? {} : { archive }),
	};
}
export function loadConfig(l: Layout, _env: Readonly<Record<string, string | undefined>> = process.env, _runner?: HostIdRunner): MachineConfig {
	const path = configPath(l);
	const raw = readJson(path);
	if (raw === undefined) return { schemaVersion: 1, sessionStores: {} };
	return parseConfig(raw);
}
export function updateConfig(l: Layout, change: (c: MachineConfig) => MachineConfig, env: Readonly<Record<string, string | undefined>> = process.env, runner?: HostIdRunner): MachineConfig {
	const dir = join(l.piHome, "pi-profile");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return withProfileLock(dir, () => {
		const path = configPath(l);
		let snapshot = readSnapshot(path);
		const current = snapshot.text === undefined ? { ...loadConfig(l, env), hostId: hostId(env, runner) } : parseConfig(JSON.parse(snapshot.text) as unknown);
		if (snapshot.text === undefined) snapshot = readSnapshot(path);
		const next = change(current);
		parseConfig(next);
		replaceIfUnchanged(path, snapshot, `${JSON.stringify(next, null, "\t")}\n`, "saving config");
		return next;
	});
}
