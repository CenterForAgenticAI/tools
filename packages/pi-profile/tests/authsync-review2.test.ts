import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { isSecretName } from "../src/core/auth.ts";
import { poolChanged, readPoolState, RETRY_MAX_MS, syncPooled } from "../src/core/authpool.ts";
import { authFiles, KEEP_BACKUPS, parsePayload, PI_BREAKER_STALE_MS, receiveAuth, type SshRunner } from "../src/core/authsync.ts";
import { configPath } from "../src/core/config.ts";
import { createProfile, updateManifest } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

// Review round 2 of issue 9. Credential values: no output or message may contain any of them.
const PRIVATE = "sk-PRIVATE-ONLY-COPY";
const SECRETS = [PRIVATE, "sk-remote-API-SECRET", "rt-NEW-REFRESH", "at-NEW-ACCESS"];
const noSecret = (text: string): void => {
	for (const secret of SECRETS) assert.ok(!text.includes(secret), "leaked a credential");
};
const apiKey = (key: string): Record<string, unknown> => ({ type: "api_key", key });
const oauth = (expires: number): Record<string, unknown> => ({ type: "oauth", refresh: "rt-NEW-REFRESH", access: "at-NEW-ACCESS", expires });
const payload = (entries: Record<string, unknown>): string => JSON.stringify({ schemaVersion: 1, entries });
const writeAuth = (path: string, value: Record<string, unknown>): void => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const readAuth = (path: string): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
const ago = (path: string, ms: number): void => {
	const t = new Date(Date.now() - ms);
	utimesSync(path, t, t);
};
const MODE_SWITCH = /^auth\.json\.bak-\d{8}-\d{6}-[0-9a-f]{12}$/;
const SYNC = /^auth\.json\.bak-sync-\d{8}-\d{6}-\d{10}-[0-9a-f]{12}$/;

let s: Sandbox;
let shared: string;
beforeEach(() => {
	s = sandbox();
	shared = join(s.home, "agent", "auth.json");
});
afterEach(() => {
	s.cleanup();
});

describe("CR-9-R2-PRUNE: sync pruning never deletes a mode-switch backup", () => {
	it("a private login kept by a switch to shared survives more than five receives after the switch back", () => {
		const info = createProfile(s.l, "solo", { auth: "separate" });
		writeAuth(join(info.dir, "auth.json"), { mine: apiKey(PRIVATE) });
		updateManifest(s.l, "solo", (m) => ({ ...m, auth: { mode: "shared" } }));
		updateManifest(s.l, "solo", (m) => ({ ...m, auth: { mode: "separate" } }));
		const kept = readdirSync(info.dir).filter((n) => MODE_SWITCH.test(n));
		assert.equal(kept.length, 1);
		const modeSwitch = join(info.dir, kept[0] ?? "");
		assert.ok(readFileSync(modeSwitch, "utf8").includes(PRIVATE), "the switch must keep the private login");
		for (let i = 0; i < KEEP_BACKUPS + 2; i++) receiveAuth(s.l, "solo", parsePayload(payload({ ["p" + String(i)]: apiKey("sk-remote-API-SECRET") })));
		assert.ok(readFileSync(modeSwitch, "utf8").includes(PRIVATE), "the mode-switch backup must survive pruning");
		assert.equal(readdirSync(info.dir).filter((n) => SYNC.test(n)).length, KEEP_BACKUPS);
		assert.deepEqual(readdirSync(info.dir).filter((n) => MODE_SWITCH.test(n)), kept);
	});
});

describe("CR-9-R2-STATECLAMP: a corrupt or far-future backoff", () => {
	const env = { PI_PROFILE_HOME: "", PI_PROFILE_HOST_ID: "box", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
	let own: string;
	let statePath: string;
	const t0 = Date.UTC(2026, 0, 1);
	beforeEach(() => {
		env.PI_PROFILE_HOME = s.home;
		createProfile(s.l, "pool", { auth: "pooled" });
		own = join(s.home, "profiles", "pool", "auth.json");
		statePath = join(s.home, "pi-profile", "state", "authsync", "pool.json");
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, authSync: { peers: ["down"] } }));
		writeAuth(own, { codex: oauth(1000) });
		syncPooled(s.l, "pool", { env, run: () => ({ status: 0, stdout: "", stderr: "" }), now: () => t0 });
	});
	/** Write a failing peer whose fields are raw JSON text, such as 1e400. */
	const plant = (lastFailedAt: string, nextAttemptAt: string): void => {
		const base = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		const text = JSON.stringify({ ...base, pending: { down: ["codex"] }, failing: { down: { failures: 3, lastFailedAt: "@A", nextAttemptAt: "@B", lastError: "x" } } });
		writeFileSync(statePath, text.replace('"@A"', lastFailedAt).replace('"@B"', nextAttemptAt));
	};
	const cli = (args: string[], run: SshRunner) => {
		const c = Object.assign(captureIo(env), { ssh: run });
		return Object.assign(c, { code: main(args, c) });
	};

	for (const [label, last, next] of [
		["1e400 (Infinity)", "1e400", "1e400"],
		["a non-number", '"yesterday"', '"soon"'],
		["a negative number", "-5", "-5"],
	] as const) {
		it(`drops a failure whose times are ${label}: status and sync work and the peer is tried at once`, () => {
			plant(last, next);
			assert.deepEqual(readPoolState(s.l, "pool")?.failing, {});
			assert.deepEqual(readPoolState(s.l, "pool")?.pending, { down: ["codex"] });
			const status = cli(["auth", "status", "--profile", "pool"], () => assert.fail("status runs no ssh"));
			assert.equal(status.code, 0, status.stderr);
			assert.equal(status.stdout, "down: waiting for codex\n");
			let calls = 0;
			const sync = cli(["auth", "sync", "--profile", "pool"], () => {
				calls++;
				return { status: 0, stdout: "codex: replaced\n", stderr: "" };
			});
			assert.equal(sync.code, 0, sync.stderr);
			assert.equal(calls, 1);
			noSecret(status.stdout + status.stderr + sync.stdout + sync.stderr);
		});
	}

	it("clamps a far-future next try to at most 24 h from now, so the peer is retried", () => {
		const far = String(Date.UTC(2100, 0, 1));
		plant(far, far);
		const t = Date.UTC(2026, 5, 1);
		const f = readPoolState(s.l, "pool", t)?.failing.down;
		assert.equal(f?.nextAttemptAt, t + RETRY_MAX_MS);
		assert.equal(f?.lastFailedAt, t);
		// A next try within the cap but after a far-future failure time is clamped too.
		plant(far, String(t + 1000));
		assert.equal(readPoolState(s.l, "pool", t)?.failing.down?.nextAttemptAt, t + 1000);
		plant(far, far);
		const status = cli(["auth", "status", "--profile", "pool"], () => assert.fail("status runs no ssh"));
		assert.equal(status.code, 0, status.stderr);
		const shown = /next try after (\S+);/.exec(status.stdout)?.[1] ?? "";
		assert.ok(Date.parse(shown) <= Date.now() + RETRY_MAX_MS, "next try within 24 h: " + shown);
		const early = cli(["auth", "sync", "--profile", "pool"], () => assert.fail("still backing off"));
		assert.equal(early.code, 1);
		assert.match(early.stderr, /down: not tried: waiting until /);
		let calls = 0;
		const run: SshRunner = () => {
			calls++;
			return { status: 0, stdout: "codex: replaced\n", stderr: "" };
		};
		// The clamp starts one sync, which saves the clamped times; the bound then stays put and comes due.
		plant(far, far);
		assert.equal(poolChanged(s.l, "pool", t), true);
		const parked = syncPooled(s.l, "pool", { env, run, now: () => t });
		assert.equal(parked.peers[0]?.retryAt, t + RETRY_MAX_MS);
		assert.equal(calls, 0);
		assert.equal(readPoolState(s.l, "pool", t + 1)?.clamped, undefined);
		assert.equal(poolChanged(s.l, "pool", t + 1), false);
		assert.equal(poolChanged(s.l, "pool", t + RETRY_MAX_MS + 1), true);
		syncPooled(s.l, "pool", { env, run, now: () => t + RETRY_MAX_MS + 1 });
		assert.equal(calls, 1);
		assert.deepEqual(readPoolState(s.l, "pool")?.failing, {});
	});
});

describe("CR-9-R2-LINKMATCH: shared links matched by real path", () => {
	const write = (profile: string) => () => receiveAuth(s.l, profile, parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 100 });

	it("a chained link z -> w -> agent: z's lock blocks a receive to w", () => {
		createProfile(s.l, "w", { auth: "shared" });
		const z = createProfile(s.l, "z", { auth: "shared" });
		unlinkSync(join(z.dir, "auth.json"));
		symlinkSync(join("..", "w", "auth.json"), join(z.dir, "auth.json"));
		assert.ok(authFiles(s.l, "w").locks.includes(join(z.dir, "auth.json")));
		mkdirSync(join(z.dir, "auth.json.lock"));
		assert.throws(write("w"), /locked by a running Pi/);
		assert.equal(readAuth(shared).openai, undefined);
	});

	it("CR-9-R3-DOTDOT: a link through d/.. where d is a link: z's lock blocks a receive to w", () => {
		createProfile(s.l, "w", { auth: "shared" });
		const z = createProfile(s.l, "z", { auth: "shared" });
		mkdirSync(join(s.home, "agent", "sub"));
		symlinkSync(join(s.home, "agent", "sub"), join(z.dir, "d"));
		unlinkSync(join(z.dir, "auth.json"));
		// A literal target: path.join would drop d/.. as text.
		symlinkSync("d/../auth.json", join(z.dir, "auth.json"));
		assert.ok(authFiles(s.l, "w").locks.includes(join(z.dir, "auth.json")));
		mkdirSync(join(z.dir, "auth.json.lock"));
		assert.throws(write("w"), /locked by a running Pi/);
		assert.equal(readAuth(shared).openai, undefined);
	});

	it("a link written through a symlinked home: its lock blocks a shared receive", () => {
		const alias = join(s.home, "alias-home");
		symlinkSync(s.home, alias);
		const y = createProfile(s.l, "y", { auth: "shared" });
		unlinkSync(join(y.dir, "auth.json"));
		symlinkSync(join(alias, "agent", "auth.json"), join(y.dir, "auth.json"));
		assert.ok(authFiles(s.l, "default").locks.includes(join(y.dir, "auth.json")));
		mkdirSync(join(y.dir, "auth.json.lock"));
		assert.throws(write("default"), /locked by a running Pi/);
		assert.equal(readAuth(shared).openai, undefined);
	});

	it("a dangling link, a link loop and a link into a missing directory do not throw", () => {
		const a = createProfile(s.l, "a", { auth: "shared" });
		const b = createProfile(s.l, "b", { auth: "shared" });
		const c = createProfile(s.l, "c", { auth: "shared" });
		for (const d of [a.dir, b.dir, c.dir]) unlinkSync(join(d, "auth.json"));
		symlinkSync(join(s.home, "nowhere.json"), join(a.dir, "auth.json"));
		symlinkSync("auth.json", join(b.dir, "auth.json"));
		symlinkSync(join(s.home, "gone", "dir", "auth.json"), join(c.dir, "auth.json"));
		const { locks } = authFiles(s.l, "default");
		assert.deepEqual(locks, [join(s.home, "agent", "auth.json")]);
		receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })));
		assert.equal(readAuth(shared).openai?.type, "api_key");
		rmSync(join(s.home, "profiles"), { recursive: true });
	});
});

describe("CR-9-R2-SECRETNAME: credential leftovers are secret paths", () => {
	it("a sessions migrate dry run never plans to move AUTH.json, auth.json.aside-* or auth.json.new-*", () => {
		const from = join(s.home, "agent", "sessions");
		const to = join(s.home, "store");
		mkdirSync(to);
		const names = ["AUTH.json", "auth.json.aside-abc", "auth.json.new-abc", "Auth.Json.BAK-sync-x", "1.jsonl"];
		mkdirSync(join(from, "--a--"), { recursive: true });
		for (const n of names) {
			const p = join(from, "--a--", n);
			writeFileSync(p, n === "1.jsonl" ? "one\n" : JSON.stringify({ x: apiKey(PRIVATE) }), { mode: 0o600 });
			utimesSync(p, new Date(0), new Date(0));
		}
		const io = captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "test-host" });
		assert.equal(main(["sessions", "migrate", from, to], io), 0, io.stderr);
		assert.match(io.stdout, /would move: 1 files/);
		assert.match(io.stdout, /would skip: 4 files/);
		assert.match(io.stdout, /4 × credentials stay where they are/);
		noSecret(io.stdout + io.stderr);
		for (const n of names.slice(0, 4)) assert.equal(isSecretName(n), true, n);
		assert.equal(isSecretName("auth.jsonl"), false);
		assert.equal(isSecretName("session-auth.json"), false);
	});
});

describe("CR-9-R2-BREAKER: a breaker left by a crash", () => {
	const write = (opts: Parameters<typeof receiveAuth>[3] = {}) => () => receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 150, ...opts });

	it("a breaker older than 60 s is stale: it is removed and the stale lock is broken", () => {
		assert.equal(PI_BREAKER_STALE_MS, 60_000);
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, 10 * 60_000);
		writeFileSync(lock + ".break", "");
		ago(lock + ".break", 2 * 60_000);
		write()();
		assert.equal(readAuth(shared).openai?.type, "api_key");
		assert.deepEqual(readdirSync(join(s.home, "agent")).filter((n) => n.includes(".lock")), []);
	});

	it("a stale breaker is kept when the lock changed after it was judged stale", () => {
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, 10 * 60_000);
		writeFileSync(lock + ".break", "");
		ago(lock + ".break", 2 * 60_000);
		let swapped = false;
		const afterStaleRead = (l: string): void => {
			if (swapped) return;
			swapped = true;
			rmSync(l, { recursive: true });
			mkdirSync(l);
		};
		assert.throws(write({ afterStaleRead }), /locked by a running Pi/);
		assert.ok(readdirSync(join(s.home, "agent")).includes("auth.json.lock.break"), "breaker kept");
		assert.ok(readdirSync(join(s.home, "agent")).includes("auth.json.lock"), "fresh lock kept");
		assert.equal(readAuth(shared).openai, undefined);
	});

	it("a fresh leftover breaker is named in the refusal", () => {
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, 10 * 60_000);
		writeFileSync(lock + ".break", "");
		assert.throws(write(), (e: unknown) => e instanceof Error && e.message.includes(`remove ${lock} and ${lock}.break`));
		assert.ok(readdirSync(join(s.home, "agent")).includes("auth.json.lock.break"));
		rmSync(lock + ".break");
		rmSync(lock, { recursive: true });
		mkdirSync(lock);
		assert.throws(write(), (e: unknown) => e instanceof Error && e.message.endsWith(`remove ${lock})`));
	});
});
