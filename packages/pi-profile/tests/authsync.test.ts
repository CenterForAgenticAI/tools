import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, openSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/main.ts";
import { authPoolOnSessionEnd, authPoolOnSessionStart, authPoolStateDir, poolChanged, readPoolState, RETRY_BASE_MS, syncArgs, syncPooled } from "../src/core/authpool.ts";
import {
	authSshArgs,
	checkHost,
	entryObject,
	MAX_PAYLOAD_BYTES,
	mergeEntry,
	parseEntry,
	parsePayload,
	failure,
	processSshRunner,
	readCapped,
	receiveAuth,
	withPiAuthLock,
	type AuthEntry,
	type SshRunner,
} from "../src/core/authsync.ts";
import type { Runtime, Spawn } from "../src/core/autobackup.ts";
import { configPath, parseConfig } from "../src/core/config.ts";
import { createProfile } from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The source, not bin/pi-profile.mjs: that prefers dist/, which may be an older build.
const CLI = join(repoRoot, "tests", "fixtures", "cli-source.mjs");

// Credential values: no test output, argv or message may contain any of them.
const SECRETS = ["sk-local-API-SECRET", "sk-remote-API-SECRET", "rt-OLD-REFRESH", "at-OLD-ACCESS", "rt-NEW-REFRESH", "at-NEW-ACCESS", "shared"];
const noSecret = (text: string): void => {
	for (const secret of SECRETS.filter((x) => x !== "shared")) assert.ok(!text.includes(secret), `leaked ${secret} in: ${text}`);
};

const apiKey = (key: string): Record<string, unknown> => ({ type: "api_key", key });
const oauth = (expires: number, tag: "OLD" | "NEW"): Record<string, unknown> => ({ type: "oauth", refresh: `rt-${tag}-REFRESH`, access: `at-${tag}-ACCESS`, expires, accountId: `acct-${tag}` });
const payload = (entries: Record<string, unknown>): string => JSON.stringify({ schemaVersion: 1, entries });

let s: Sandbox;
let remote: Sandbox;
let bin: string;
beforeEach(() => {
	s = sandbox();
	remote = sandbox();
	bin = mkdtempSync(join(tmpdir(), "pi-profile-bin-"));
});
afterEach(() => {
	s.cleanup();
	remote.cleanup();
	rmSync(bin, { recursive: true, force: true });
});

function readJsonFile(path: string): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
}
function writeAuth(path: string, value: Record<string, unknown>): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function backups(dir: string): string[] {
	return readdirSync(dir).filter((n) => n.startsWith("auth.json.bak-"));
}

/** A stand-in `ssh` on PATH: logs its argv, then runs the remote `pi-profile` here against REMOTE_HOME. Host `down` fails as ssh does. */
function fakeSsh(): { env: Record<string, string>; log: string } {
	const log = join(bin, "ssh.log");
	writeFileSync(
		join(bin, "ssh"),
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" >> "$SSH_LOG"',
			'while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; -*) echo "unexpected option $1" >&2; exit 64;; *) break;; esac; done',
			'host="$1"; shift',
			'if [ "$host" = down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi',
			'[ "$1" = pi-profile ] || exit 127',
			"shift",
			'PI_PROFILE_HOME="$REMOTE_HOME" exec "$NODE_BIN" "$CLI" "$@"',
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	return {
		log,
		env: { PATH: `${bin}:${process.env.PATH ?? ""}`, SSH_LOG: log, REMOTE_HOME: remote.home, NODE_BIN: process.execPath, CLI, PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" },
	};
}

/** Run the real CLI in its own process. */
function cli(args: readonly string[], env: Record<string, string>, input = ""): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI, ...args], { input, env, encoding: "utf8", timeout: 60_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const localEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" });

// ---------------------------------------------------------------- the merge rule

describe("mergeEntry mirrors D.merge", () => {
	const key = (k: string): AuthEntry => ({ type: "api_key", key: k });
	const login = (e: number): AuthEntry => ({ type: "oauth", refresh: `r${String(e)}`, access: `a${String(e)}`, expires: e, extra: [] });
	it("L17: a local API key is kept against any incoming entry without --force", () => {
		const local = key("a");
		assert.equal(mergeEntry(local, key("b"), false), local);
		assert.equal(mergeEntry(local, login(9), false), local);
	});
	it("L18: an API key never replaces a local OAuth login without --force", () => {
		const local = login(1);
		assert.equal(mergeEntry(local, key("b"), false), local);
	});
	it("L26 without write times: the login that expires later wins; a tie keeps the local login", () => {
		const early = login(100);
		const late = login(200);
		assert.equal(mergeEntry(early, late, false), late);
		assert.equal(mergeEntry(late, early, false), late);
		const tie = login(100);
		assert.equal(mergeEntry(early, tie, false), early);
	});
	it("L19: --force takes the incoming entry in every case", () => {
		const cases: Array<[AuthEntry, AuthEntry]> = [[key("a"), key("b")], [key("a"), login(1)], [login(5), key("b")], [login(5), login(1)]];
		for (const [l, i] of cases) assert.equal(mergeEntry(l, i, true), i);
	});
});

// ---------------------------------------------------------------- entry and payload shapes

describe("parseEntry and parsePayload", () => {
	it("refuses an unknown entry type, never merging it", () => {
		assert.throws(() => parseEntry({ type: "bearer", token: "sk-remote-API-SECRET" }, "x", "p"), (e: Error) => e instanceof Refusal && /unknown entry type/.test(e.message) && !e.message.includes("sk-remote"));
		assert.throws(() => parseEntry({ key: "sk-remote-API-SECRET" }, "x", "p"), /unknown entry type/);
		assert.throws(() => parseEntry("sk-remote-API-SECRET", "x", "p"), /must be a JSON object/);
	});
	it("refuses a malformed api_key or oauth entry without quoting it", () => {
		const bad: unknown[] = [
			{ type: "api_key", key: 7 },
			{ type: "api_key", key: "k", sk_remote_API_SECRET: 1 },
			{ type: "api_key", env: { "bad name": "sk-remote-API-SECRET" } },
			{ type: "oauth", refresh: "rt-NEW-REFRESH", access: "at-NEW-ACCESS" },
			{ type: "oauth", refresh: "rt-NEW-REFRESH", access: "at-NEW-ACCESS", expires: "soon" },
			{ type: "oauth", refresh: "rt-NEW-REFRESH", access: "at-NEW-ACCESS", expires: 1, nested: { a: "sk-remote-API-SECRET" } },
		];
		for (const raw of bad) assert.throws(() => parseEntry(raw, "prov", "payload"), (e: Error) => e instanceof Refusal && e.message.startsWith("payload: prov: ") && !/SECRET|REFRESH|ACCESS/.test(e.message));
	});
	it("copies only named fields: a __proto__ key cannot reach a prototype", () => {
		const raw = JSON.parse('{"type":"oauth","refresh":"r","access":"a","expires":1,"__proto__":{"polluted":true}}') as unknown;
		assert.throws(() => parseEntry(raw, "p", "w"), /cannot copy/);
		assert.throws(() => parsePayload('{"schemaVersion":1,"entries":{"__proto__":{"type":"api_key","key":"k"}}}'), /provider name is not valid/);
		// An env key named __proto__ is a valid name; it must stay an own field, never set the object's prototype.
		const withEnv = parseEntry(JSON.parse('{"type":"api_key","key":"k","env":{"__proto__":"x"}}') as unknown, "p", "w");
		const env = entryObject(withEnv).env as Record<string, unknown>;
		assert.equal(Object.getPrototypeOf(env), Object.prototype);
		assert.ok(Object.hasOwn(env, "__proto__"));
		assert.equal(Object.getOwnPropertyDescriptor(env, "__proto__")?.value, "x");
	});
	it("refuses a payload over the size cap, and invalid JSON without an excerpt", () => {
		assert.throws(() => parsePayload(" ".repeat(MAX_PAYLOAD_BYTES + 1)), /larger than/);
		assert.throws(() => parsePayload('{"schemaVersion":1,"entries":{"a":{"type":"api_key","key":"sk-remote-API-SECRET"'), (e: Error) => e.message === "auth payload is not valid JSON");
		assert.throws(() => parsePayload('{"schemaVersion":2,"entries":{}}'), /schemaVersion: 1/);
		assert.throws(() => parsePayload('{"schemaVersion":1,"entries":{},"more":1}'), /schemaVersion: 1/);
	});
});

// ---------------------------------------------------------------- auth receive

describe("auth receive (real process, stdin)", () => {
	it("shared mode: merges into the shared file in place, keeps the link, backs up first, prints only outcomes", () => {
		createProfile(s.l, "work", { auth: "shared" });
		const shared = join(s.home, "agent", "auth.json");
		writeAuth(shared, { anthropic: apiKey("sk-local-API-SECRET"), codex: oauth(1000, "OLD"), keep: apiKey("untouched") });
		chmodSync(shared, 0o644);
		const before = readFileSync(shared, "utf8");
		const inode = statSync(shared).ino;
		const r = cli(["auth", "receive", "--profile", "work"], localEnv(), payload({ anthropic: apiKey("sk-remote-API-SECRET"), codex: oauth(2000, "NEW"), openai: apiKey("sk-remote-API-SECRET") }));
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "anthropic: kept\ncodex: replaced\nopenai: added\n");
		noSecret(r.stdout + r.stderr);
		const link = join(s.home, "profiles", "work", "auth.json");
		assert.ok(lstatSync(link).isSymbolicLink());
		assert.equal(readlinkSync(link), shared);
		assert.equal(statSync(shared).ino, inode, "written in place, not renamed over");
		assert.equal(statSync(shared).mode & 0o777, 0o600);
		const after = readJsonFile(shared);
		assert.equal(after.anthropic?.key, "sk-local-API-SECRET");
		assert.deepEqual(after.codex, oauth(2000, "NEW"));
		assert.equal(after.openai?.key, "sk-remote-API-SECRET");
		assert.equal(after.keep?.key, "untouched");
		const [bak, ...more] = backups(join(s.home, "agent"));
		assert.equal(more.length, 0);
		assert.ok(bak !== undefined && /^auth\.json\.bak-sync-\d{8}-\d{6}-\d{10}-[0-9a-f]{12}$/.test(bak));
		assert.equal(readFileSync(join(s.home, "agent", bak), "utf8"), before);
		assert.equal(statSync(join(s.home, "agent", bak)).mode & 0o777, 0o600);
	});

	it("--force replaces a differing API key (L19); nothing changed means no write and no backup", () => {
		const shared = join(s.home, "agent", "auth.json");
		writeAuth(shared, { anthropic: apiKey("sk-local-API-SECRET") });
		const same = cli(["auth", "receive", "--profile", "default"], localEnv(), payload({ anthropic: apiKey("sk-local-API-SECRET") }));
		assert.equal(same.stdout, "anthropic: unchanged\n");
		assert.deepEqual(backups(join(s.home, "agent")), []);
		const forced = cli(["auth", "receive", "--profile", "default", "--force"], localEnv(), payload({ anthropic: apiKey("sk-remote-API-SECRET") }));
		assert.equal(forced.status, 0, forced.stderr);
		assert.equal(forced.stdout, "anthropic: replaced\n");
		assert.equal(readJsonFile(shared).anthropic?.key, "sk-remote-API-SECRET");
	});

	it("separate mode (L16): writes the profile's own file, never the shared one", () => {
		createProfile(s.l, "solo", { auth: "separate" });
		const shared = join(s.home, "agent", "auth.json");
		const sharedBefore = readFileSync(shared, "utf8");
		const r = cli(["auth", "receive", "--profile", "solo"], localEnv(), payload({ codex: oauth(5, "NEW") }));
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(readJsonFile(join(s.home, "profiles", "solo", "auth.json")).codex, oauth(5, "NEW"));
		assert.equal(readFileSync(shared, "utf8"), sharedBefore);
	});

	it("refuses an unknown entry type with exit 2 and leaves the file and its backups alone", () => {
		const shared = join(s.home, "agent", "auth.json");
		const before = readFileSync(shared, "utf8");
		const r = cli(["auth", "receive"], localEnv(), payload({ ok: apiKey("sk-remote-API-SECRET"), weird: { type: "bearer", token: "sk-remote-API-SECRET" } }));
		assert.equal(r.status, 2);
		assert.match(r.stderr, /weird: unknown entry type/);
		noSecret(r.stdout + r.stderr);
		assert.equal(readFileSync(shared, "utf8"), before);
		assert.deepEqual(backups(join(s.home, "agent")), []);
	});

	it("refuses to overwrite a local entry it cannot read", () => {
		const shared = join(s.home, "agent", "auth.json");
		writeAuth(shared, { anthropic: { type: "future", blob: "x" } });
		const before = readFileSync(shared, "utf8");
		const r = cli(["auth", "receive", "--force"], localEnv(), payload({ anthropic: apiKey("sk-remote-API-SECRET") }));
		assert.equal(r.status, 2);
		assert.match(r.stderr, /anthropic: unknown entry type/);
		assert.equal(readFileSync(shared, "utf8"), before);
	});

	it("readCapped stops reading past the cap", () => {
		const f = join(s.home, "big");
		writeFileSync(f, "x".repeat(300_000));
		const fd = openSync(f, "r");
		try {
			assert.throws(() => readCapped(fd, 100_000, "payload"), /payload is larger than 100000 bytes/);
		} finally {
			closeSync(fd);
		}
	});

	it("refuses a payload over the size cap read from stdin", () => {
		const big = payload({ a: apiKey("x".repeat(MAX_PAYLOAD_BYTES)) });
		const r = cli(["auth", "receive"], localEnv(), big);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /larger than 1048576 bytes/);
	});

	it("never writes through a link at the auth file", () => {
		const shared = join(s.home, "agent", "auth.json");
		const elsewhere = join(s.home, "elsewhere.json");
		writeAuth(elsewhere, {});
		unlinkSync(shared);
		symlinkSync(elsewhere, shared);
		const r = cli(["auth", "receive"], localEnv(), payload({ a: apiKey("sk-remote-API-SECRET") }));
		assert.equal(r.status, 2);
		assert.match(r.stderr, /is a symlink/);
		assert.equal(readFileSync(elsewhere, "utf8"), "{}\n");
	});

	it("waits for Pi's auth.json lock and refuses while it is held", () => {
		const shared = join(s.home, "agent", "auth.json");
		mkdirSync(`${shared}.lock`);
		assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ a: apiKey("k") })), { lockWaitMs: 100 }), /locked by a running Pi/);
		// A lock older than Pi's stale time plus a margin is taken over by a writer, as Pi itself does.
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${shared}.lock`, old, old);
		assert.equal(withPiAuthLock(shared, () => existsSync(`${shared}.lock`), { waitMs: 100, breakStale: true }), true);
		assert.equal(existsSync(`${shared}.lock`), false);
	});

	it("refuses a profile whose auth.json disagrees with its mode", () => {
		createProfile(s.l, "work", { auth: "shared" });
		const link = join(s.home, "profiles", "work", "auth.json");
		unlinkSync(link);
		writeAuth(link, {});
		const r = cli(["auth", "receive", "--profile", "work"], localEnv(), payload({ a: apiKey("k") }));
		assert.equal(r.status, 2);
		assert.match(r.stderr, /shared auth mode, but its auth.json is not a link/);
	});
});

// ---------------------------------------------------------------- push and pull over a stand-in ssh

describe("auth push and pull (real processes, stand-in ssh on PATH)", () => {
	function twoHosts(): void {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
	}
	const localAuth = (): string => join(s.home, "profiles", "work", "auth.json");
	const remoteAuth = (): string => join(remote.home, "profiles", "work", "auth.json");

	it("push sends entries on stdin only and the peer merges them by the rules", () => {
		twoHosts();
		const { env, log } = fakeSsh();
		writeAuth(localAuth(), { anthropic: apiKey("sk-local-API-SECRET"), codex: oauth(2000, "NEW") });
		writeAuth(remoteAuth(), { anthropic: apiKey("sk-remote-API-SECRET"), codex: oauth(1000, "OLD") });
		const r = cli(["auth", "push", "kite", "--profile", "work"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: anthropic: kept\nkite: codex: replaced\n");
		noSecret(r.stdout + r.stderr);
		const argv = readFileSync(log, "utf8");
		noSecret(argv);
		assert.equal(argv, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "--", "kite", "pi-profile", "auth", "receive", "--profile", "work", ""].join("\n"));
		const got = readJsonFile(remoteAuth());
		assert.equal(got.anthropic?.key, "sk-remote-API-SECRET");
		assert.deepEqual(got.codex, oauth(2000, "NEW"));
		assert.equal(backups(join(remote.home, "profiles", "work")).length, 1);
	});

	it("push --provider sends only that provider; --force replaces the peer's API key", () => {
		twoHosts();
		const { env } = fakeSsh();
		writeAuth(localAuth(), { anthropic: apiKey("sk-local-API-SECRET"), codex: oauth(2000, "NEW") });
		writeAuth(remoteAuth(), { anthropic: apiKey("sk-remote-API-SECRET") });
		const r = cli(["auth", "push", "kite", "--profile", "work", "--provider", "anthropic", "--force"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: anthropic: replaced\n");
		const got = readJsonFile(remoteAuth());
		assert.equal(got.anthropic?.key, "sk-local-API-SECRET");
		assert.equal(got.codex, undefined);
		const missing = cli(["auth", "push", "kite", "--profile", "work", "--provider", "nope"], env);
		assert.equal(missing.status, 2);
		assert.match(missing.stderr, /has no nope entry/);
	});

	it("pull fetches with auth export and merges locally through the same rules", () => {
		twoHosts();
		const { env, log } = fakeSsh();
		writeAuth(localAuth(), { anthropic: apiKey("sk-local-API-SECRET"), codex: oauth(1000, "OLD") });
		writeAuth(remoteAuth(), { anthropic: apiKey("sk-remote-API-SECRET"), codex: oauth(2000, "NEW"), odd: { type: "future" } });
		const r = cli(["auth", "pull", "kite", "--profile", "work"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "anthropic: kept\ncodex: replaced\n");
		assert.match(r.stderr, /kite: pi-profile: odd: skipped/);
		noSecret(r.stdout + r.stderr + readFileSync(log, "utf8"));
		const got = readJsonFile(localAuth());
		assert.equal(got.anthropic?.key, "sk-local-API-SECRET");
		assert.deepEqual(got.codex, oauth(2000, "NEW"));
		assert.equal(statSync(localAuth()).mode & 0o777, 0o600);
		const forced = cli(["auth", "pull", "kite", "--profile", "work", "--provider", "anthropic", "--force"], env);
		assert.equal(forced.stdout, "anthropic: replaced\n");
		assert.equal(readJsonFile(localAuth()).anthropic?.key, "sk-remote-API-SECRET");
	});

	it("a host that could be an ssh option is refused before ssh runs", () => {
		twoHosts();
		const { env, log } = fakeSsh();
		for (const host of ["-oProxyCommand=touch /tmp/pwned", "-v", "Kite", "kite.tail.net", "user@kite", ""]) {
			for (const sub of ["push", "pull"]) {
				const r = cli(["auth", sub, "--profile", "work", "--", host].filter((x) => x !== "--"), env);
				assert.equal(r.status, 2, `${sub} ${host}: ${r.stderr}`);
			}
		}
		assert.equal(existsSync(log), false, "ssh must never run");
		assert.throws(() => checkHost("-oProxyCommand=x"), /Tailscale short name/);
		assert.throws(() => authSshArgs("kite", ["receive", "$(id)"]), /unsafe word/);
	});

	it("a failed connection exits 1 with ssh's message and no secret", () => {
		twoHosts();
		const { env } = fakeSsh();
		writeAuth(localAuth(), { anthropic: apiKey("sk-local-API-SECRET") });
		const r = cli(["auth", "push", "down", "--profile", "work"], env);
		assert.equal(r.status, 1);
		assert.equal(r.stderr, "pi-profile: down: auth receive failed: ssh could not connect: ssh: connect to host down port 22: Connection refused\n");
		const p = cli(["auth", "pull", "down", "--profile", "work"], env);
		assert.equal(p.status, 1);
		noSecret(p.stderr);
	});

	it("a remote refusal is reported without the payload; a remote that answers garbage is refused", () => {
		twoHosts();
		const { env } = fakeSsh();
		writeAuth(localAuth(), { anthropic: apiKey("sk-local-API-SECRET") });
		writeAuth(remoteAuth(), { anthropic: { type: "future" } });
		const r = cli(["auth", "push", "kite", "--profile", "work"], env);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /kite: auth receive failed: exited 2: \S+auth\.json: anthropic: unknown entry type/);
		noSecret(r.stderr);
		const garbage: SshRunner = () => ({ status: 0, stdout: '{"schemaVersion":1,"entries":{"a":{"type":"api_key","key":"sk-remote-API-SECRET"', stderr: "" });
		const io = Object.assign(captureIo({ PI_PROFILE_HOME: s.home }), { ssh: garbage });
		assert.equal(main(["auth", "pull", "kite", "--profile", "work"], io), 2);
		assert.equal(io.stderr, "pi-profile: kite: auth payload is not valid JSON\n");
	});

	it("a failure message carries ssh's last stderr line, never its stdout", () => {
		const why = failure({ status: 1, stdout: "sk-remote-API-SECRET\n", stderr: "first\npi-profile: boom\u001b[2J\n" });
		assert.equal(why, "exited 1: boom?[2J");
		assert.equal(failure({ status: 3, stdout: "rt-NEW-REFRESH", stderr: "" }), "exited 3");
	});

	it("processSshRunner reports a missing ssh without output", () => {
		const r = processSshRunner({ PATH: bin })(["--", "kite", "true"], "sk-local-API-SECRET");
		assert.equal(r.error, "ssh is not installed");
	});

	it("processSshRunner keeps ssh's status and message when ssh exits without reading stdin (EPIPE)", () => {
		writeFileSync(join(bin, "ssh"), '#!/bin/sh\necho "ssh: connect to host down port 22: Connection refused" >&2\nexit 255\n', { mode: 0o700 });
		// Larger than a pipe buffer (64 KiB), so the write cannot finish before ssh exits.
		const input = `sk-local-API-SECRET${"x".repeat(256 * 1024)}`;
		for (let i = 0; i < 5; i++) {
			const r = processSshRunner({ PATH: bin })(["--", "down", "true"], input);
			assert.equal(r.error, undefined);
			assert.equal(r.status, 255);
			assert.equal(failure(r), "ssh could not connect: ssh: connect to host down port 22: Connection refused");
		}
	});
});

// ---------------------------------------------------------------- pooled mode

describe("pooled mode", () => {
	function setup(mode: "pooled" | "shared" | "separate", peers: readonly string[] = ["kite"]): { env: Record<string, string>; log: string; auth: string; remoteAuth: string } {
		createProfile(s.l, "pool", { auth: mode });
		createProfile(remote.l, "pool", { auth: "separate" });
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, authSync: { peers } }));
		const f = fakeSsh();
		const auth = mode === "shared" ? join(s.home, "agent", "auth.json") : join(s.home, "profiles", "pool", "auth.json");
		return { ...f, env: { ...f.env, PI_PROFILE_LABEL: "pool", PI_CODING_AGENT_DIR: join(s.home, "profiles", "pool") }, auth, remoteAuth: join(remote.home, "profiles", "pool", "auth.json") };
	}

	it("pushes only the OAuth entries that changed (L20, L21); an API key stays home while auth.pushKeys is off", () => {
		const { env, log, auth, remoteAuth } = setup("pooled");
		writeAuth(auth, { anthropic: apiKey("sk-local-API-SECRET"), codex: oauth(1000, "OLD"), gemini: oauth(1000, "OLD") });
		assert.equal(authPoolOnSessionStart(env), true);
		assert.equal(poolChanged(s.l, "pool"), false);
		writeAuth(auth, { anthropic: apiKey("sk-remote-API-SECRET"), codex: oauth(2000, "NEW"), gemini: oauth(1000, "OLD"), fresh: apiKey("sk-local-API-SECRET") });
		assert.equal(poolChanged(s.l, "pool"), true);
		const r = cli(syncArgs("pool").filter((a) => a !== "--quiet"), env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: sent codex\n");
		noSecret(r.stdout + r.stderr + readFileSync(log, "utf8"));
		assert.deepEqual(readJsonFile(remoteAuth), { codex: oauth(2000, "NEW") });
		assert.equal(poolChanged(s.l, "pool"), false);
		const state = readFileSync(join(authPoolStateDir(s.l), "pool.json"), "utf8");
		noSecret(state);
		assert.equal(statSync(join(authPoolStateDir(s.l), "pool.json")).mode & 0o777, 0o600);
	});

	it("the first sync records a baseline and sends nothing", () => {
		const { env, log, auth } = setup("pooled");
		writeAuth(auth, { codex: oauth(1000, "OLD") });
		const r = cli(["auth", "sync", "--profile", "pool"], env);
		assert.equal(r.stdout, "pool: recorded the current logins; later changes will be pushed\n");
		assert.equal(existsSync(log), false);
		assert.notEqual(readPoolState(s.l, "pool"), undefined);
	});

	it("a peer that fails gets the entries again on the next sync", () => {
		const { env, auth, remoteAuth } = setup("pooled", ["down", "kite"]);
		writeAuth(auth, { codex: oauth(1000, "OLD") });
		authPoolOnSessionStart(env);
		writeAuth(auth, { codex: oauth(2000, "NEW") });
		const first = syncPooled(s.l, "pool", { env, run: processSshRunner(env) });
		assert.deepEqual(first.peers.map((p) => [p.peer, p.sent, p.error === undefined]), [["down", [], false], ["kite", ["codex"], true]]);
		assert.deepEqual(readPoolState(s.l, "pool")?.pending, { down: ["codex"] });
		const later = Date.now() + RETRY_BASE_MS + 1000;
		assert.equal(poolChanged(s.l, "pool", later), true, "a pending peer counts as a change once its backoff has passed");
		const seen: string[] = [];
		const second = syncPooled(s.l, "pool", { env, now: () => later, run: (args, input) => { seen.push(args[args.indexOf("--") + 1] ?? ""); return processSshRunner(env)(args.map((a) => (a === "down" ? "kite" : a)), input); } });
		assert.deepEqual(seen, ["down"]);
		assert.deepEqual(second.peers.map((p) => p.sent), [["codex"], []]);
		assert.deepEqual(readPoolState(s.l, "pool")?.pending, {});
		assert.deepEqual(readJsonFile(remoteAuth).codex, oauth(2000, "NEW"));
	});

	it("a separate profile never pushes (L21)", () => {
		for (const mode of ["separate"] as const) {
			const { env, log } = setup(mode);
			const r = cli(["auth", "sync", "--profile", "pool"], env);
			assert.equal(r.status, 2);
			assert.match(r.stderr, /separate auth mode/);
			assert.equal(authPoolOnSessionStart(env), false);
			const calls: unknown[] = [];
			const spawn: Spawn = (...a) => { calls.push(a); return { on: () => undefined, unref: () => undefined }; };
			assert.equal(authPoolOnSessionEnd(env, { spawn, runtime: nodeRuntime }), false);
			assert.deepEqual(calls, []);
			assert.equal(existsSync(log), false);
			s.cleanup();
			remote.cleanup();
			s = sandbox();
			remote = sandbox();
		}
	});

	const nodeRuntime: Runtime = { execPath: process.execPath, bunVersion: undefined, releaseName: "node", isSea: () => false };

	it("the session end starts a detached sync only when auth.json changed, and never throws", () => {
		const { env, auth } = setup("pooled");
		writeAuth(auth, { codex: oauth(1000, "OLD") });
		authPoolOnSessionStart(env);
		const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
		const spawn: Spawn = (command, args, options) => {
			calls.push({ command, args, options: options as Record<string, unknown> });
			return { on: () => undefined, unref: () => undefined };
		};
		assert.equal(authPoolOnSessionEnd(env, { spawn, runtime: nodeRuntime }), false);
		writeAuth(auth, { codex: oauth(2000, "NEW") });
		assert.equal(authPoolOnSessionEnd(env, { spawn, runtime: nodeRuntime }), true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, process.execPath);
		assert.deepEqual(calls[0]?.args.slice(1), ["auth", "sync", "--profile", "pool", "--quiet"]);
		assert.equal(calls[0]?.options.detached, true);
		assert.equal(calls[0]?.options.stdio, "ignore");
		const throwing: Spawn = () => {
			throw new Error("spawn failed");
		};
		assert.equal(authPoolOnSessionEnd(env, { spawn: throwing, runtime: nodeRuntime }), false);
		writeFileSync(configPath(s.l), "{broken");
		assert.equal(authPoolOnSessionEnd(env, { spawn, runtime: nodeRuntime }), false);
		assert.equal(authPoolOnSessionStart(env), false);
	});

	it("a same-size rewrite with the same mtime counts as a change (racy clean)", () => {
		const { env, auth } = setup("pooled");
		const tick = 1_700_000_000;
		writeAuth(auth, { codex: oauth(1000, "OLD") });
		utimesSync(auth, tick, tick);
		assert.equal(authPoolOnSessionStart(env), true);
		assert.equal(poolChanged(s.l, "pool"), false);
		const before = statSync(auth);
		writeAuth(auth, { codex: oauth(2000, "NEW") });
		utimesSync(auth, tick, tick);
		const after = statSync(auth);
		assert.equal(after.size, before.size);
		assert.equal(after.mtimeMs, before.mtimeMs);
		assert.equal(poolChanged(s.l, "pool"), true);
	});
});

describe("config authSync", () => {
	const base = { schemaVersion: 1, hostId: "box", sessionStores: {} };
	it("accepts Tailscale short names and refuses anything that could be an ssh option", () => {
		assert.deepEqual(parseConfig({ ...base, authSync: { peers: ["kite", "good-kite-studio"] } }).authSync, { peers: ["kite", "good-kite-studio"] });
		for (const bad of [{ peers: ["-oProxyCommand=x"] }, { peers: ["Kite"] }, { peers: ["kite", "kite"] }, { peers: "kite" }, { peers: [], more: 1 }, ["kite"]]) {
			assert.throws(() => parseConfig({ ...base, authSync: bad }), Refusal, JSON.stringify(bad));
		}
	});
});
