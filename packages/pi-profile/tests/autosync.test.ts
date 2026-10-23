import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { authPoolOnSessionEnd, authPoolOnSessionStart, authSyncStatus, CREDENTIAL_CHANGED_CHANNEL, CREDENTIAL_REFRESH_CHANNEL, pullPeers, readPoolState, startAutoSync, syncPooled, driftFindings } from "../src/core/authpool.ts";
import { configPayloadText, readConfigView, receiveConfig, rehome } from "../src/core/authconfig.ts";
import * as authsync from "../src/core/authsync.ts";
import { autoPush, mergeEntry, parsePayloadFull, payloadText, receiveAuth, parseEntry, sendEntries, takeIncoming, type AuthEntry, type SshRunner } from "../src/core/authsync.ts";
import type { Runtime, Spawn } from "../src/core/autobackup.ts";
import { doctor } from "../src/core/doctor.ts";
import { configPath } from "../src/core/config.ts";
import { createProfile, loadProfile, updateManifest } from "../src/core/profiles.ts";
import piProfile from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

// The newest login wins a merge (L26), auto-sync for shared and pooled profiles (L20, L21), config push, pull before refresh, drift.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "tests", "fixtures", "cli-source.mjs");
const REFRESH = "rt-LIVE-REFRESH-TOKEN";
const ACCESS = "at-LIVE-ACCESS-TOKEN";
const HOUR = 3_600_000;
const nodeRuntime: Runtime = { execPath: process.execPath, bunVersion: undefined, releaseName: "node", isSea: () => false };

const login = (expires: number, tag = "A"): Record<string, unknown> => ({ type: "oauth", refresh: `rt-${tag}-${REFRESH}`, access: `at-${tag}-${ACCESS}`, expires });
const entry = (expires: number, tag = "A"): AuthEntry => parseEntry(login(expires, tag), "codex", "test");
const writeAuth = (path: string, v: Record<string, unknown>): void => writeFileSync(path, `${JSON.stringify(v)}\n`, { mode: 0o600 });
const readAuth = (path: string): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
const ago = (path: string, ms: number): void => {
	const t = new Date(Date.now() - ms);
	utimesSync(path, t, t);
};

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

/** A stand-in ssh: runs the peer's pi-profile here against the remote sandbox, as the user `remoteUser`'s home. Host `down` fails as ssh does. */
function fakeSsh(): Record<string, string> {
	writeFileSync(
		join(bin, "ssh"),
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" >> "$SSH_LOG"',
			'while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; -*) exit 64;; *) break;; esac; done',
			'host="$1"; shift',
			'if [ "$host" = down ]; then echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255; fi',
			'[ "$1" = pi-profile ] || exit 127',
			"shift",
			'PI_PROFILE_HOME="$REMOTE_HOME" HOME="$REMOTE_USER_HOME" exec "$NODE_BIN" "$CLI" "$@"',
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	return {
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		SSH_LOG: join(bin, "ssh.log"),
		REMOTE_HOME: remote.home,
		REMOTE_USER_HOME: "/h/peer",
		NODE_BIN: process.execPath,
		CLI,
		PI_PROFILE_HOME: s.home,
		PI_PROFILE_HOST_ID: "box",
		PI_PROFILE_NO_GLOBAL_DEFAULT: "1",
		HOME: "/h/alice",
	};
}
function cli(args: readonly string[], env: Record<string, string>, input = ""): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI, ...args], { input, env, encoding: "utf8", timeout: 60_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function configure(peers: string[]): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, authSync: { peers } }));
}
const localAuth = (): string => join(s.home, "profiles", "work", "auth.json");
const remoteAuth = (): string => join(remote.home, "profiles", "work", "auth.json");
const noToken = (text: string): void => {
	for (const t of [REFRESH, ACCESS]) assert.ok(!text.includes(t), `leaked a token fragment (${t.slice(0, 6)}) in: ${text.slice(0, 200)}`);
};

describe("L26: the newest login wins a merge (D.takeIncoming)", () => {
	it("takeIncoming: a later write wins whatever the expiry says, an earlier one loses, equal writes use the later expiry, a full tie keeps local", () => {
		assert.equal(takeIncoming(10, 9000, 20, 1000), true);
		assert.equal(takeIncoming(20, 1000, 10, 9000), false);
		assert.equal(takeIncoming(10, 1000, 10, 2000), true);
		assert.equal(takeIncoming(10, 2000, 10, 1000), false);
		assert.equal(takeIncoming(10, 1000, 10, 1000), false);
	});

	it("mergeEntry uses write times when both are known, the later expiry when either is missing, and --force always takes the incoming entry", () => {
		const local = entry(9000, "L");
		const incoming = entry(1000, "I");
		assert.equal(mergeEntry(local, incoming, false, { local: 1, incoming: 2 }), incoming, "newer write, earlier expiry");
		assert.equal(mergeEntry(local, incoming, false, { local: 2, incoming: 1 }), local, "older write, earlier expiry");
		const early = entry(1000, "E");
		const late = entry(9000, "T");
		assert.equal(mergeEntry(early, late, false, { local: 2, incoming: 1 }), early, "older write, later expiry");
		assert.equal(mergeEntry(local, incoming, false, { local: 1 }), local, "no incoming time: later expiry");
		assert.equal(mergeEntry(early, late, false, { incoming: 1 }), late, "no local time: later expiry");
		assert.equal(mergeEntry(local, incoming, false), local, "no times: later expiry");
		assert.equal(mergeEntry(local, entry(9000, "U"), false, { local: 5, incoming: 5 }), local, "a full tie keeps the local login");
		assert.equal(mergeEntry(local, incoming, true), incoming, "--force still takes it");
	});

	it("receiveAuth replaces a login with a later write that expires sooner, and keeps one with an earlier write that expires later", () => {
		createProfile(s.l, "work", { auth: "separate" });
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + 9 * HOUR, "L") });
		ago(localAuth(), HOUR);
		const newer = new Map([["codex", entry(now + HOUR, "I")]]);
		const r = receiveAuth(s.l, "work", newer, { writes: new Map([["codex", now - 1000]]), now: () => now });
		assert.deepEqual(r.outcomes, [{ provider: "codex", outcome: "replaced" }]);
		assert.equal(readAuth(localAuth()).codex?.refresh, `rt-I-${REFRESH}`);
		const older = new Map([["codex", entry(now + 99 * HOUR, "O")]]);
		const k = receiveAuth(s.l, "work", older, { writes: new Map([["codex", now - 7_200_000]]), now: () => now });
		assert.deepEqual(k.outcomes, [{ provider: "codex", outcome: "kept" }], "a later expiry does not beat a newer write");
	});

	it("an incoming write time is cut back to now plus 5 minutes, so a far-ahead clock cannot win every merge", () => {
		const now = Date.now();
		const body = payloadText(new Map([["codex", entry(5000)]]), new Map([["codex", now + 10 * 24 * 3_600_000]]));
		const p = parsePayloadFull(body, now);
		assert.ok((p.writes.get("codex") ?? Infinity) <= now + 5 * 60 * 1000);
	});

	it("payloads reject a bad writes object and drop times for API keys", () => {
		const bad = JSON.stringify({ schemaVersion: 1, entries: {}, writes: { codex: "soon" } });
		assert.throws(() => parsePayloadFull(bad), /writes must be an object of times/);
		const key = parseEntry({ type: "api_key", key: "k" }, "anthropic", "t");
		assert.equal(payloadText(new Map([["anthropic", key]]), new Map([["anthropic", 5]])).includes("writes"), false);
	});

	it("auth push keeps a peer's login that was written later although it expires sooner (real processes)", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		const env = fakeSsh();
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + 5 * HOUR, "OLDER") });
		ago(localAuth(), 2 * HOUR);
		writeAuth(remoteAuth(), { codex: login(now + HOUR, "NEWER") });
		const r = cli(["auth", "push", "kite", "--profile", "work"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: codex: kept\n");
		assert.equal(readAuth(remoteAuth()).codex?.refresh, `rt-NEWER-${REFRESH}`);
	});

	it("auth pull takes the peer's login that was written later although it expires sooner (real processes)", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		const env = fakeSsh();
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + 5 * HOUR, "MINE") });
		ago(localAuth(), 2 * HOUR);
		writeAuth(remoteAuth(), { codex: login(now + HOUR, "THEIRS") });
		const r = cli(["auth", "pull", "kite", "--profile", "work"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "codex: replaced\n");
		assert.equal(readAuth(localAuth()).codex?.refresh, `rt-THEIRS-${REFRESH}`);
	});

	it("auth push --force takes the incoming login whatever the write times say (L19, real processes)", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		const env = fakeSsh();
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + HOUR, "OLDER") });
		ago(localAuth(), 2 * HOUR);
		writeAuth(remoteAuth(), { codex: login(now + 5 * HOUR, "NEWER") });
		const r = cli(["auth", "push", "kite", "--profile", "work", "--force"], env);
		assert.equal(r.stdout, "kite: codex: replaced\n");
		assert.equal(readAuth(remoteAuth()).codex?.refresh, `rt-OLDER-${REFRESH}`);
	});

	it("a payload from a sender without write times merges by the later expiry", () => {
		createProfile(s.l, "work", { auth: "separate" });
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + HOUR, "LOCAL") });
		const r = receiveAuth(s.l, "work", new Map([["codex", entry(now + 5 * HOUR, "LONGER")]]));
		assert.deepEqual(r.outcomes, [{ provider: "codex", outcome: "replaced" }]);
		const k = receiveAuth(s.l, "work", new Map([["codex", entry(now + 2 * HOUR, "SHORTER")]]));
		assert.deepEqual(k.outcomes, [{ provider: "codex", outcome: "kept" }]);
	});
});

describe("L26: the newest login wins (real processes)", () => {
	it("auth push: a newer-written login that expires earlier replaces an older-written one that expires later", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		const env = fakeSsh();
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + HOUR, "NEWER") });
		writeAuth(remoteAuth(), { codex: login(now + 5 * HOUR, "OLDER") });
		ago(remoteAuth(), 2 * HOUR);
		const r = cli(["auth", "push", "kite", "--profile", "work"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: codex: replaced\n");
		assert.equal(readAuth(remoteAuth()).codex?.refresh, `rt-NEWER-${REFRESH}`);
		noToken(r.stdout + r.stderr + readFileSync(env.SSH_LOG as string, "utf8"));
	});
});

describe("L26: write times are not trusted blindly", () => {
	it("CR-MTIME-DATING: a dead local login with a fresh file time does not beat a live incoming login that expires later", () => {
		createProfile(s.l, "work", { auth: "separate" });
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now - HOUR, "DEAD") }); // mtime is now, but the login expired an hour ago
		const incoming = new Map([["codex", entry(now + HOUR, "LIVE")]]);
		const r = receiveAuth(s.l, "work", incoming, { writes: new Map([["codex", now - 2 * HOUR - 1000]]), now: () => now });
		assert.deepEqual(r.outcomes, [{ provider: "codex", outcome: "replaced" }]);
		assert.equal(readAuth(localAuth()).codex?.refresh, `rt-LIVE-${REFRESH}`);
	});

	it("CR-OLD-PEER-REFUSES-WRITES: a push to a pi-profile that refuses the writes field is sent again without it", () => {
		const seen: string[] = [];
		const run: SshRunner = (_args, input) => {
			seen.push(input);
			if (input.includes('"writes"')) return { status: 2, stdout: "", stderr: "pi-profile: auth payload must be { schemaVersion: 1, entries: { PROVIDER: entry } }\n" };
			return { status: 0, stdout: "codex: replaced\n", stderr: "" };
		};
		const lines = sendEntries("kite", "work", new Map([["codex", entry(5000)]]), false, run, false, new Map([["codex", 1234]]));
		assert.deepEqual(lines, ["codex: replaced"]);
		assert.equal(seen.length, 2);
		assert.match(seen[0] ?? "", /"writes"/);
		assert.doesNotMatch(seen[1] ?? "", /"writes"/);
	});
});

describe("CR-LAW-ORDER-L21: automatic push follows L20 and L21", () => {
	it("autoPush: a separate profile pushes nothing; shared and pooled push OAuth logins; an API key only with the flag", () => {
		const key = parseEntry({ type: "api_key", key: "k" }, "a", "t");
		const oauth = entry(1);
		for (const flag of [false, true]) {
			assert.equal(autoPush("separate", flag, oauth), false, "separate pushes no login");
			assert.equal(autoPush("separate", flag, key), false, "separate pushes no key");
			assert.equal(autoPush("shared", flag, oauth), true);
			assert.equal(autoPush("pooled", flag, oauth), true);
		}
		for (const mode of ["shared", "pooled"] as const) {
			assert.equal(autoPush(mode, false, key), false, `${mode}: an API key stays home with the flag off`);
			assert.equal(autoPush(mode, true, key), true, `${mode}: an API key goes with the flag on`);
		}
	});

	it("auth.pushKeys is a boolean in profile.json, defaults off, and survives an auth.mode edit", () => {
		createProfile(s.l, "work", { auth: "pooled" });
		const env = fakeSsh();
		const manifest = (): string => readFileSync(join(s.home, "profiles", "work", "profile.json"), "utf8");
		assert.doesNotMatch(manifest(), /pushKeys/);
		assert.equal(cli(["edit", "work", "--set", "auth.pushKeys=true"], env).status, 0);
		assert.equal(cli(["edit", "work", "--set", "auth.mode=shared"], env).status, 0);
		assert.match(manifest(), /"pushKeys": true/);
		const bad = cli(["edit", "work", "--set", "auth.pushKeys=maybe"], env);
		assert.equal(bad.status, 2);
		assert.equal(cli(["edit", "work", "--set", "auth.pushKeys="], env).status, 0);
		assert.doesNotMatch(manifest(), /pushKeys/);
	});

	it("a separate profile pushes nothing: sync is refused and nothing reaches the peer, flag or no flag", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		configure(["kite"]);
		const env = fakeSsh();
		writeAuth(localAuth(), { codex: login(1000, "OLD") });
		for (const flag of [false, true]) {
			updateManifest(s.l, "work", (m) => ({ ...m, auth: { mode: "separate", pushKeys: flag } }));
			const r = cli(["auth", "sync", "--profile", "work"], env);
			assert.equal(r.status, 2, `pushKeys=${String(flag)}`);
			assert.match(r.stderr, /separate auth mode/);
		}
		assert.equal(existsSync(env.SSH_LOG as string), false, "ssh was never run");
		assert.deepEqual(existsSync(remoteAuth()) ? Object.keys(readAuth(remoteAuth())) : [], [], "nothing reached the peer");
	});

	it("a shared profile pushes a changed OAuth login whoever logged in, and an API key only once auth.pushKeys is on (real processes)", () => {
		createProfile(s.l, "work", { auth: "shared" });
		createProfile(remote.l, "work", { auth: "separate" });
		configure(["kite"]);
		const env = fakeSsh();
		const shared = join(s.home, "agent", "auth.json");
		writeAuth(shared, { codex: login(1000, "OLD") });
		assert.equal(cli(["auth", "sync", "--profile", "work"], env).status, 0, "baseline");
		writeAuth(shared, { codex: login(2000, "NEW"), anthropic: { type: "api_key", key: "sk-SECRET-KEY" } });
		const off = cli(["auth", "sync", "--profile", "work"], env);
		assert.equal(off.status, 0, off.stderr);
		assert.equal(off.stdout, "kite: sent codex\n");
		assert.deepEqual(Object.keys(readAuth(remoteAuth())), ["codex"], "the API key stayed home with the flag off");
		updateManifest(s.l, "work", (m) => ({ ...m, auth: { mode: "shared", pushKeys: true } }));
		writeAuth(shared, { codex: login(2000, "NEW"), anthropic: { type: "api_key", key: "sk-SECRET-KEY2" }, ollama: { type: "api_key", key: "!echo hi" } });
		const on = cli(["auth", "sync", "--profile", "work"], env);
		assert.equal(on.status, 0, on.stderr);
		assert.equal(on.stdout, "kite: sent anthropic\n");
		assert.deepEqual(Object.keys(readAuth(remoteAuth())).sort(), ["anthropic", "codex"], "the key went with the flag on; a key Pi would run as a command did not");
	});
});


describe("L30: the default profile syncs logins on its own, though its stored mode stays separate", () => {
	// The default profile is Pi's own agent directory; its auth.json is the shared file.
	const sharedLocal = (): string => join(s.home, "agent", "auth.json");
	const sharedRemote = (): string => join(remote.home, "agent", "auth.json");
	const defaultEnv = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1", PI_PROFILE_HOST_ID: "box" });
	const recorder = (): { calls: Array<readonly string[]>; spawn: Spawn } => {
		const calls: Array<readonly string[]> = [];
		const spawn: Spawn = (_command, args) => {
			calls.push(args);
			return { on: () => undefined, unref: () => undefined };
		};
		return { calls, spawn };
	};

	it("profilePush mirrors D.profilePush: the default profile pushes logins in any stored mode, an API key only with the flag; a named profile follows autoPush", () => {
		const profilePush = (authsync as Record<string, unknown>)["profilePush"] as ((profile: string, mode: "shared" | "separate" | "pooled", pushKeys: boolean, e: AuthEntry) => boolean) | undefined;
		assert.equal(typeof profilePush, "function", "authsync exports profilePush");
		const key = parseEntry({ type: "api_key", key: "k" }, "a", "t");
		const oauth = entry(1);
		for (const mode of ["shared", "separate", "pooled"] as const) {
			for (const flag of [false, true]) {
				assert.equal(profilePush?.("default", mode, flag, oauth), true, `default (${mode}) pushes a login`);
				assert.equal(profilePush?.("default", mode, flag, key), flag, `default (${mode}) pushes a key only with the flag`);
				for (const e of [oauth, key]) assert.equal(profilePush?.("work", mode, flag, e), autoPush(mode, flag, e), `work (${mode}) follows autoPush`);
			}
		}
		assert.equal(profilePush?.("work", "separate", true, oauth), false, "a named separate profile pushes nothing");
	});

	it("a default profile with authSync.peers starts auto-sync, and auth sync pushes a changed OAuth login to the peer's default profile (real processes)", (t) => {
		configure(["kite"]);
		const env = fakeSsh();
		writeAuth(sharedLocal(), { codex: login(1000, "OLD") });
		writeAuth(sharedRemote(), {});
		// The extension: session start records a baseline, starts auto-sync and pulls from the peers.
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const { calls, spawn } = recorder();
		assert.equal(authPoolOnSessionStart(defaultEnv()), true, "session start records a baseline for the default profile");
		const sync = startAutoSync(defaultEnv(), { spawn, runtime: nodeRuntime, debounceMs: 10, pollMs: 600_000 });
		assert.notEqual(sync, undefined, "auto-sync starts for the default profile");
		assert.equal(sync?.pullNow(), true);
		assert.equal(sync?.onChange({ provider: "codex", kind: "refresh" }), true);
		t.mock.timers.tick(10);
		sync?.stop();
		assert.deepEqual(calls.map((a) => a.slice(1)), [["auth", "pull-peers", "--profile", "default", "--quiet"], ["auth", "sync", "--profile", "default", "--quiet"]]);
		t.mock.timers.reset();
		// The detached run, for real: the changed login reaches the peer's shared file.
		writeAuth(sharedLocal(), { codex: login(2000, "NEW") });
		const r = cli(["auth", "sync", "--profile", "default"], env);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, "kite: sent codex\n");
		assert.equal(readAuth(sharedRemote()).codex?.refresh, `rt-NEW-${REFRESH}`);
		assert.deepEqual(authSyncStatus(s.l, "default", defaultEnv()), ["kite: up to date"]);
		// The session end starts a sync when the file changed again.
		writeAuth(sharedLocal(), { codex: login(3000, "NEWER") });
		const end = recorder();
		assert.equal(authPoolOnSessionEnd(defaultEnv(), { spawn: end.spawn, runtime: nodeRuntime }), true);
		assert.deepEqual(end.calls.map((a) => a.slice(1)), [["auth", "sync", "--profile", "default", "--quiet"]]);
		// The stored mode is untouched.
		assert.equal(loadProfile(s.l, "default").manifest.auth.mode, "separate");
		noToken(r.stdout + r.stderr);
	});

	it("an API key from the default profile is pushed only with auth.pushKeys (real processes)", () => {
		configure(["kite"]);
		const env = fakeSsh();
		writeAuth(sharedLocal(), { codex: login(1000, "OLD") });
		writeAuth(sharedRemote(), {});
		assert.equal(cli(["auth", "sync", "--profile", "default"], env).status, 0, "baseline");
		writeAuth(sharedLocal(), { codex: login(2000, "NEW"), openai: { type: "api_key", key: "sk-SECRET-KEY" } });
		const off = cli(["auth", "sync", "--profile", "default"], env);
		assert.equal(off.status, 0, off.stderr);
		assert.equal(off.stdout, "kite: sent codex\n");
		assert.deepEqual(Object.keys(readAuth(sharedRemote())), ["codex"], "the API key stayed home with the flag off");
		updateManifest(s.l, "default", (m) => ({ ...m, auth: { mode: "separate", pushKeys: true } }));
		writeAuth(sharedLocal(), { codex: login(2000, "NEW"), openai: { type: "api_key", key: "sk-SECRET-KEY2" } });
		const on = cli(["auth", "sync", "--profile", "default"], env);
		assert.equal(on.status, 0, on.stderr);
		assert.equal(on.stdout, "kite: sent openai\n");
		assert.deepEqual(Object.keys(readAuth(sharedRemote())).sort(), ["codex", "openai"], "the key went with the flag on");
		assert.equal(loadProfile(s.l, "default").manifest.auth.mode, "separate");
	});

	it("while the default profile syncs, a separate profile that is not the default still pushes nothing and has no auto-sync", () => {
		configure(["kite"]);
		const env = fakeSsh();
		writeAuth(sharedLocal(), { codex: login(1000, "OLD") });
		writeAuth(sharedRemote(), {});
		assert.equal(cli(["auth", "sync", "--profile", "default"], env).status, 0, "the default profile syncs");
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		updateManifest(s.l, "work", (m) => ({ ...m, auth: { mode: "separate", pushKeys: true } }));
		writeAuth(localAuth(), { codex: login(1000, "OLD") });
		rmSync(env.SSH_LOG as string, { force: true });
		const r = cli(["auth", "sync", "--profile", "work"], env);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /separate auth mode/);
		assert.equal(existsSync(env.SSH_LOG as string), false, "ssh was never run for work");
		const workEnv = { PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "work", PI_CODING_AGENT_DIR: join(s.home, "profiles", "work") };
		assert.equal(startAutoSync(workEnv), undefined);
		assert.deepEqual(driftFindings(s.l, "work", workEnv), []);
	});
});

describe("pi-multi-account config push", () => {
	const view = (text: string, mtimeMs: number) => ({ text, sha256: "0".repeat(64), mtimeMs });
	const cfg = (cwd: Record<string, string>): string => JSON.stringify({ accountGroups: { a: ["x"] }, accountGroupCwdDefaults: cwd });

	it("rehome swaps the sender's home prefix and nothing that merely starts with it", () => {
		assert.equal(rehome("/h/alice/Code/x", "/h/alice", "/h/c"), "/h/c/Code/x");
		assert.equal(rehome("/h/alice", "/h/alice", "/h/c"), "/h/c");
		assert.equal(rehome("/h/alicex/Code", "/h/alice", "/h/c"), "/h/alicex/Code");
		assert.equal(rehome("/opt/work", "/h/alice", "/h/c"), "/opt/work");
	});

	it("the receiver rewrites home paths, backs up its old file, and keeps its own when that is newer", () => {
		createProfile(remote.l, "work", { auth: "separate" });
		const home = "/h/peer";
		const payload = configPayloadText(view(cfg({ "/h/alice/Code/a": "a", "/srv/b": "b" }), 5_000), "/h/alice");
		assert.equal(receiveConfig(remote.l, "work", payload, { home, now: () => 10_000 }), "added");
		const path = join(remote.home, "profiles", "work", "pi-multi-account", "config.json");
		assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as { accountGroupCwdDefaults: unknown }).accountGroupCwdDefaults, { "/h/peer/Code/a": "a", "/srv/b": "b" });
		assert.equal(receiveConfig(remote.l, "work", payload, { home, now: () => 10_000 }), "unchanged");
		// Our file is now newer than a payload written at t=1: keep ours.
		const old = configPayloadText(view(cfg({ "/h/alice/Code/z": "z" }), 1), "/h/alice");
		assert.equal(receiveConfig(remote.l, "work", old, { home, now: () => Date.now() }), "kept");
		assert.match(readFileSync(path, "utf8"), /Code\/a/);
		// A later payload replaces it and keeps a backup.
		const fresh = configPayloadText(view(cfg({ "/h/alice/Code/n": "n" }), Date.now() + 1000), "/h/alice");
		assert.equal(receiveConfig(remote.l, "work", fresh, { home, now: () => Date.now() + 2000 }), "replaced");
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	it("refuses a payload with a wrong shape without echoing it", () => {
		createProfile(remote.l, "work", { auth: "separate" });
		assert.throws(() => receiveConfig(remote.l, "work", "{\"secret\":\"sk-ECHO\"}", { home: "/h" }), (e: Error) => !e.message.includes("sk-ECHO") && /must be/.test(e.message));
		assert.throws(() => receiveConfig(remote.l, "work", "not json sk-ECHO", { home: "/h" }), (e: Error) => !e.message.includes("sk-ECHO"));
	});

	it("auth sync pushes a changed config with rewritten paths; a down peer is queued and shown by auth status (real processes)", () => {
		createProfile(s.l, "work", { auth: "separate" });
		createProfile(remote.l, "work", { auth: "separate" });
		updateManifest(s.l, "work", (m) => ({ ...m, auth: { mode: "pooled" } }));
		configure(["down", "kite"]);
		const env = fakeSsh();
		writeAuth(localAuth(), { codex: login(1000) });
		const cfgPath = join(s.home, "profiles", "work", "pi-multi-account", "config.json");
		mkdirSync(dirname(cfgPath), { recursive: true });
		writeFileSync(cfgPath, cfg({ "/h/alice/Code/a": "a" }));
		assert.equal(cli(["auth", "sync", "--profile", "work"], env).status, 0, "baseline");
		writeFileSync(cfgPath, cfg({ "/h/alice/Code/a": "a", "/h/alice/Code/b": "b" }));
		const r = cli(["auth", "sync", "--profile", "work"], env);
		assert.equal(r.status, 1, "the down peer fails");
		assert.match(r.stdout, /kite: multi-account config added/);
		const got = JSON.parse(readFileSync(join(remote.home, "profiles", "work", "pi-multi-account", "config.json"), "utf8")) as { accountGroupCwdDefaults: Record<string, string> };
		assert.deepEqual(Object.keys(got.accountGroupCwdDefaults), ["/h/peer/Code/a", "/h/peer/Code/b"]);
		const st = cli(["auth", "status", "--profile", "work"], env);
		assert.match(st.stdout, /down: failing .*waiting for multi-account config/);
		assert.match(st.stdout, /kite: up to date/);
		assert.deepEqual(readPoolState(s.l, "work")?.configPending, ["down"]);
		assert.notEqual(readConfigView(s.l, "work"), undefined);
		noToken(r.stdout + r.stderr);
	});
});

describe("event-driven sync (startAutoSync)", () => {
	function setup(): { env: Record<string, string>; calls: Array<{ command: string; args: readonly string[] }>; spawn: Spawn } {
		createProfile(s.l, "work", { auth: "shared" });
		configure(["kite"]);
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		const spawn: Spawn = (command, args) => {
			calls.push({ command, args });
			return { on: () => undefined, unref: () => undefined };
		};
		return { env: { PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "work", PI_CODING_AGENT_DIR: join(s.home, "profiles", "work"), PI_PROFILE_HOST_ID: "box" }, calls, spawn };
	}

	it("a change event starts one detached sync after the debounce, however many events arrive, and no token reaches argv", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const { env, calls, spawn } = setup();
		const sync = startAutoSync(env, { spawn, runtime: nodeRuntime, debounceMs: 30_000, pollMs: 600_000 });
		assert.notEqual(sync, undefined);
		// Hostile payload: extra fields carrying tokens must not travel anywhere.
		const payload = { provider: "anthropic", kind: "refresh", refresh: REFRESH, access: ACCESS };
		for (let i = 0; i < 5; i++) assert.equal(sync?.onChange(payload), true);
		t.mock.timers.tick(29_999);
		assert.equal(calls.length, 0, "nothing before the debounce ends");
		t.mock.timers.tick(1);
		assert.equal(calls.length, 1, "one run for the burst");
		assert.deepEqual(calls[0]?.args.slice(1), ["auth", "sync", "--profile", "work", "--quiet"]);
		noToken(JSON.stringify(calls));
		sync?.stop();
	});

	it("an event without a valid provider or a known kind is ignored", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const { env, calls, spawn } = setup();
		const sync = startAutoSync(env, { spawn, runtime: nodeRuntime, debounceMs: 10, pollMs: 600_000 });
		for (const bad of [undefined, null, "x", { provider: "../etc", kind: "refresh" }, { provider: "a", kind: "rm -rf" }, { provider: 3, kind: "login" }, { kind: "login" }]) assert.equal(sync?.onChange(bad), false);
		t.mock.timers.tick(1000);
		assert.deepEqual(calls, []);
		sync?.stop();
	});

	it("the poll notices an auth.json change nobody announced", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const { env, calls, spawn } = setup();
		const shared = join(s.home, "agent", "auth.json");
		writeAuth(shared, { codex: login(1000) });
		syncPooled(s.l, "work", { env, run: () => ({ status: 0, stdout: "", stderr: "" }) });
		const sync = startAutoSync(env, { spawn, runtime: nodeRuntime, debounceMs: 100, pollMs: 60_000 });
		t.mock.timers.tick(60_000);
		t.mock.timers.tick(200);
		assert.equal(calls.length, 0, "nothing changed");
		writeAuth(shared, { codex: login(2000, "B") });
		t.mock.timers.tick(60_000);
		t.mock.timers.tick(200);
		assert.equal(calls.length, 1);
		sync?.stop();
	});

	it("a separate profile has no auto-sync", () => {
		createProfile(s.l, "plain", { auth: "separate" });
		configure(["kite"]);
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "plain", PI_CODING_AGENT_DIR: join(s.home, "profiles", "plain") };
		assert.equal(startAutoSync(env), undefined);
	});

	it("the extension subscribes to pi-multi-account's channels at session start and unsubscribes at shutdown", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		const { env, calls, spawn } = setup();
		const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
		const bus = new Map<string, Array<(p: unknown) => void>>();
		const pi = {
			on: (name: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
			registerCommand: () => undefined,
			appendEntry: () => undefined,
			events: {
				on: (ch: string, h: (p: unknown) => void) => {
					bus.set(ch, [...(bus.get(ch) ?? []), h]);
					return () => bus.set(ch, (bus.get(ch) ?? []).filter((x) => x !== h));
				},
				emit: (ch: string, p: unknown) => (bus.get(ch) ?? []).forEach((h) => h(p)),
			},
		};
		piProfile(pi as never, { env, runtime: nodeRuntime, autoSync: { spawn, debounceMs: 1000, pollMs: 600_000 } });
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { hasUI: false, cwd: "/x", sessionManager: { getBranch: () => [] }, ui: {} });
		assert.equal(bus.get(CREDENTIAL_CHANGED_CHANNEL)?.length, 1);
		assert.equal(bus.get(CREDENTIAL_REFRESH_CHANNEL)?.length, 1);
		pi.events.emit(CREDENTIAL_CHANGED_CHANNEL, { provider: "anthropic", kind: "login" });
		t.mock.timers.tick(1000);
		assert.deepEqual(calls.map((c) => c.args[1]), ["auth", "sync"].slice(0, 1).concat([]).length ? calls.map((c) => c.args[1]) : []);
		assert.ok(calls.some((c) => c.args[2] === "sync"), "the change started a sync");
		pi.events.emit(CREDENTIAL_REFRESH_CHANNEL, { provider: "anthropic" });
		assert.ok(calls.some((c) => c.args[2] === "pull-peers"), "a refresh-due event pulls from the peers first");
		handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {});
		assert.equal(bus.get(CREDENTIAL_CHANGED_CHANNEL)?.length, 0);
		assert.equal(bus.get(CREDENTIAL_REFRESH_CHANNEL)?.length, 0);
	});
});

describe("pull before refresh and drift reporting", () => {
	function twoHosts(): Record<string, string> {
		createProfile(s.l, "work", { auth: "pooled" });
		createProfile(remote.l, "work", { auth: "separate" });
		configure(["kite"]);
		return fakeSsh();
	}
	const runner = (env: Record<string, string>) => (args: readonly string[], input: string) => {
		const r = spawnSync("ssh", [...args], { input, encoding: "utf8", env });
		return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};

	it("takes the peer's newer-written login before this host refreshes, even if it expires sooner; ignores its API keys; sends no refresh request", () => {
		const env = twoHosts();
		const now = Date.now();
		writeAuth(localAuth(), { codex: login(now + 5 * HOUR, "STALE") });
		ago(localAuth(), 3_600_000);
		writeAuth(remoteAuth(), { codex: login(now + HOUR, "FRESH"), anthropic: { type: "api_key", key: "sk-PEER-KEY" } });
		const r = pullPeers(s.l, "work", { env, run: runner(env) });
		assert.deepEqual(r.peers.map((p) => p.error), [undefined]);
		const got = readAuth(localAuth());
		assert.equal(got.codex?.refresh, `rt-FRESH-${REFRESH}`, "the newer-written login replaced the stale copy although it expires sooner");
		assert.equal(got.anthropic, undefined, "automatic pulls never take an API key");
		// The only process run was ssh to the peer's pi-profile; nothing contacts a provider.
		const log = readFileSync(env.SSH_LOG as string, "utf8");
		assert.match(log, /export/);
		assert.doesNotMatch(log, /refresh_token|oauth\/token|grant_type/);
	});

	it("keeps this host's login when it was written after the peer's, though it expires sooner (L26)", () => {
		const env = twoHosts();
		const now = Date.now();
		writeAuth(remoteAuth(), { codex: login(now + 5 * HOUR, "THEIRS") });
		ago(remoteAuth(), 3_600_000);
		writeAuth(localAuth(), { codex: login(now + HOUR, "MINE") });
		pullPeers(s.l, "work", { env, run: runner(env) });
		assert.equal(readAuth(localAuth()).codex?.refresh, `rt-MINE-${REFRESH}`);
	});

	it("an unreachable peer is skipped and reported, not thrown", () => {
		const env = twoHosts();
		configure(["down"]);
		writeAuth(localAuth(), { codex: login(1000) });
		const r = pullPeers(s.l, "work", { env, run: runner(env) });
		assert.match(r.peers[0]?.error ?? "", /could not connect/);
		assert.equal(cli(["auth", "pull-peers", "--profile", "work", "--quiet"], env).status, 1);
	});

	it("doctor reports expiry drift against what a peer held at the last pull, and entries a peer has not received", () => {
		const env = twoHosts();
		// The peer wrote a login that expires later, and this host holds an older-written one. The pull takes the newer (L26). Something then shortens this host's copy behind the pull's back; the saved peer expiry now sits above it.
		writeAuth(localAuth(), { codex: login(1000, "MINE") });
		ago(localAuth(), 3_600_000);
		writeAuth(remoteAuth(), { codex: login(5000, "THEIRS") });
		syncPooled(s.l, "work", { env, run: runner(env) }); // baseline
		pullPeers(s.l, "work", { env, run: runner(env) });
		assert.equal(readAuth(localAuth()).codex?.refresh, `rt-THEIRS-${REFRESH}`);
		writeAuth(localAuth(), { codex: login(1000, "MINE") });
		const findings = driftFindings(s.l, "work", env);
		assert.ok(findings.some((m) => /expiry drift: kite holds a codex login that expires later than this host's/.test(m)), findings.join("\n"));
		const d = doctor(s.l, env).filter((f) => f.profile === "work" && /drift|has not received/.test(f.message));
		assert.ok(d.length > 0 && d.every((f) => f.level === "warn"));
		noToken(JSON.stringify(d));
	});

	it("doctor says nothing for a profile that does not sync on its own", () => {
		createProfile(s.l, "plain", { auth: "separate" });
		configure(["kite"]);
		assert.deepEqual(driftFindings(s.l, "plain", {}), []);
	});
});