import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authSshArgs, failure, MAX_PAYLOAD_BYTES, type SshRunner } from "./authsync.ts";
import { stamp } from "./fsutil.ts";
import { multiAccountConfigPath } from "./multi-account.ts";
import { profileDir, type Layout } from "./paths.ts";
import { Refusal } from "./result.ts";
import { readSnapshot, replaceIfUnchanged, uniqueSibling } from "./swap.ts";

/**
 * Push pi-multi-account's `config.json` to peers.
 * The file holds account group names and working directories, never a
 * credential. Directories under the sender's home are rewritten to the
 * receiver's home (`accountGroupCwdDefaults` keys); the rest is copied as is.
 * The receiver keeps its own file when that was written later than the sender's.
 */

export interface ConfigView {
	readonly text: string;
	readonly sha256: string;
	readonly mtimeMs: number;
}

/** The profile's multi-account config as it is now; undefined when there is none. */
export function readConfigView(l: Layout, profile: string): ConfigView | undefined {
	const path = multiAccountConfigPath(profileDir(l, profile));
	const snap = readSnapshot(path);
	if (snap.text === undefined) return undefined;
	return { text: snap.text, sha256: createHash("sha256").update(snap.text).digest("hex"), mtimeMs: statSync(path).mtimeMs };
}

export function configPayloadText(view: ConfigView, home: string): string {
	let config: unknown;
	try {
		config = JSON.parse(view.text);
	} catch {
		throw new Refusal("pi-multi-account/config.json is not valid JSON; fix it before it can be pushed");
	}
	return `${JSON.stringify({ schemaVersion: 1, home, writtenAt: view.mtimeMs, config })}\n`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `path` with the `from` home prefix replaced by `to`; unchanged when it is not under `from`. */
export function rehome(path: string, from: string, to: string): string {
	if (path === from) return to;
	return path.startsWith(from + "/") ? to + path.slice(from.length) : path;
}

export type ConfigOutcome = "added" | "replaced" | "kept" | "unchanged";

export interface ConfigReceiveOptions {
	readonly home: string;
	readonly now?: () => number;
}

/** Apply a pushed config. Returns what happened; throws a Refusal for a bad payload. Never echoes the payload. */
export function receiveConfig(l: Layout, profile: string, source: string, opts: ConfigReceiveOptions): ConfigOutcome {
	if (Buffer.byteLength(source) > MAX_PAYLOAD_BYTES) throw new Refusal("config payload is too large");
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch {
		throw new Refusal("config payload is not valid JSON");
	}
	const shape = "config payload must be { schemaVersion: 1, home, writtenAt, config }";
	if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.home !== "string" || !raw.home.startsWith("/") || typeof raw.writtenAt !== "number" || !Number.isFinite(raw.writtenAt) || !isRecord(raw.config)) throw new Refusal(shape);
	if (Object.keys(raw).some((k) => !["schemaVersion", "home", "writtenAt", "config"].includes(k))) throw new Refusal(shape);
	const now = (opts.now ?? Date.now)();
	const writtenAt = Math.min(raw.writtenAt, now);
	const config: Record<string, unknown> = { ...raw.config };
	const cwd = config["accountGroupCwdDefaults"];
	if (cwd !== undefined) {
		if (!isRecord(cwd)) throw new Refusal("config payload: accountGroupCwdDefaults must be an object");
		config["accountGroupCwdDefaults"] = Object.fromEntries(Object.entries(cwd).map(([k, v]) => [rehome(k, raw.home as string, opts.home), v]));
	}
	const text = `${JSON.stringify(config, null, 2)}\n`;
	const path = multiAccountConfigPath(profileDir(l, profile));
	const read = readSnapshot(path);
	if (read.text === text) return "unchanged";
	if (read.text !== undefined) {
		if (statSync(path).mtimeMs >= writtenAt) return "kept";
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (read.text !== undefined) writeFileSync(uniqueSibling(path, `bak-sync-${stamp()}`), read.text, { mode: 0o600, flag: "wx" });
	replaceIfUnchanged(path, read, text, "updating");
	return read.text === undefined ? "added" : "replaced";
}

/** Send the config to `host`, which applies it with `auth config-receive`. Throws with ssh's last stderr line on failure. */
export function sendConfig(host: string, profile: string, payload: string, run: SshRunner): ConfigOutcome {
	const r = run(authSshArgs(host, ["config-receive", "--profile", profile]), payload);
	const why = failure(r);
	if (why !== undefined) throw new Error(`${host}: auth config-receive failed: ${why}`);
	const word = r.stdout.trim().split("\n").pop() ?? "";
	return word === "added" || word === "replaced" || word === "kept" ? word : "unchanged";
}

