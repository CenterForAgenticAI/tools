import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { authPoolOnSessionStart, poolChanged, readPoolState, recordBaseline, retryDelay, RETRY_BASE_MS, RETRY_MAX_MS, syncPooled } from "../src/core/authpool.ts";
import {
	authFiles,
	authSshArgs,
	exportAuth,
	isCommandKey,
	KEEP_BACKUPS,
	MAX_EXPIRES_AHEAD_MS,
	parsePayload,
	PI_LOCK_BREAK_MS,
	PI_LOCK_STALE_MS,
	pruneBackups,
	readAuthSnapshot,
	receiveAuth,
	type SshRunner,
} from "../src/core/authsync.ts";
import { configPath } from "../src/core/config.ts";
import { createProfile } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

// Review round 1 of issue 9. Credential values: no output, message or state may contain any of them.
const SECRETS = ["sk-local-API-SECRET", "sk-remote-API-SECRET", "rt-NEW-REFRESH", "at-NEW-ACCESS", "touch-MARKER-CMD"];
const noSecret = (text: string): void => {
	for (const secret of SECRETS) assert.ok(!text.includes(secret), "leaked " + secret + " in: " + text);
};
const apiKey = (key: string): Record<string, unknown> => ({ type: "api_key", key });
const oauth = (expires: number): Record<string, unknown> => ({ type: "oauth", refresh: "rt-NEW-REFRESH", access: "at-NEW-ACCESS", expires });
const payload = (entries: Record<string, unknown>): string => JSON.stringify({ schemaVersion: 1, entries });
const writeAuth = (path: string, value: Record<string, unknown>): void => writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
const readAuth = (path: string): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
const backups = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith("auth.json.bak-")).sort();
const ago = (path: string, ms: number): void => {
	const t = new Date(Date.now() - ms);
	utimesSync(path, t, t);
};

let s: Sandbox;
let shared: string;
beforeEach(() => {
	s = sandbox();
	shared = join(s.home, "agent", "auth.json");
});
afterEach(() => {
	s.cleanup();
});

describe("CR-9-LOCKPATH: Pi's lock at the path Pi uses", () => {
	it("a shared non-default profile's own auth.json.lock makes receive refuse, with no write", () => {
		createProfile(s.l, "work", { auth: "shared" });
		const before = readFileSync(shared, "utf8");
		mkdirSync(join(s.home, "profiles", "work", "auth.json.lock"));
		assert.throws(() => receiveAuth(s.l, "work", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 100 }), /locked by a running Pi/);
		assert.equal(readFileSync(shared, "utf8"), before);
		assert.deepEqual(backups(join(s.home, "agent")), []);
	});

	it("a shared write also waits for every other profile that links to the shared file", () => {
		createProfile(s.l, "work", { auth: "shared" });
		createProfile(s.l, "home", { auth: "shared" });
		createProfile(s.l, "solo", { auth: "separate" });
		const before = readFileSync(shared, "utf8");
		mkdirSync(join(s.home, "profiles", "home", "auth.json.lock"));
		assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 100 }), /locked by a running Pi/);
		assert.throws(() => receiveAuth(s.l, "work", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 100 }), /locked by a running Pi/);
		assert.equal(readFileSync(shared, "utf8"), before);
		// A separate profile's file is not the shared file: its lock does not block a shared write.
		const { locks } = authFiles(s.l, "work");
		assert.deepEqual([...locks].sort(), [shared, join(s.home, "profiles", "home", "auth.json"), join(s.home, "profiles", "work", "auth.json")].sort());
	});

	it("releases every lock it took, after a write and after a refusal", () => {
		createProfile(s.l, "work", { auth: "shared" });
		createProfile(s.l, "home", { auth: "shared" });
		const locks = [shared, join(s.home, "profiles", "work", "auth.json"), join(s.home, "profiles", "home", "auth.json")].map((f) => f + ".lock");
		receiveAuth(s.l, "work", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })));
		assert.deepEqual(locks.filter((l) => existsSync(l)), []);
		writeAuth(shared, { anthropic: { type: "future" } });
		assert.throws(() => receiveAuth(s.l, "work", parsePayload(payload({ anthropic: apiKey("sk-remote-API-SECRET") })), { force: true }), /unknown entry type/);
		assert.deepEqual(locks.filter((l) => existsSync(l)), []);
		// A lock held on the last file in order: the earlier ones are released too.
		mkdirSync(locks[2] ?? "");
		assert.throws(() => receiveAuth(s.l, "work", parsePayload(payload({ x: apiKey("k") })), { lockWaitMs: 50 }), /locked/);
		assert.deepEqual(locks.filter((l) => existsSync(l)), [locks[2]]);
	});
});

describe("CR-9-STALE: never break a live Pi's lock", () => {
	it("uses Pi's real stale window (30 s) plus a margin", () => {
		assert.equal(PI_LOCK_STALE_MS, 30_000);
		assert.ok(PI_LOCK_BREAK_MS > PI_LOCK_STALE_MS);
	});

	it("a 12 s old lock is not broken; a 40 s old one neither", () => {
		const lock = shared + ".lock";
		for (const age of [12_000, 40_000]) {
			mkdirSync(lock);
			ago(lock, age);
			assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 100 }), /locked by a running Pi/, String(age));
			assert.ok(existsSync(lock), String(age) + " ms old lock must stay");
			assert.equal(readAuth(shared).openai, undefined);
			rmdirSync(lock);
		}
	});

	it("a writer breaks a lock older than the window plus margin", () => {
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, PI_LOCK_BREAK_MS + 5_000);
		const r = receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 200 });
		assert.deepEqual(r.outcomes, [{ provider: "openai", outcome: "added" }]);
		assert.equal(existsSync(lock), false);
	});

	it("read-only paths (export, baseline, session start) never break a lock, however old", () => {
		createProfile(s.l, "pool", { auth: "pooled" });
		const own = join(s.home, "profiles", "pool", "auth.json");
		writeAuth(own, { codex: oauth(1000) });
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, authSync: { peers: ["kiwi"] } }));
		for (const file of [shared, own]) {
			const lock = file + ".lock";
			mkdirSync(lock);
			ago(lock, 10 * 60_000);
		}
		assert.throws(() => exportAuth(s.l, "default", undefined, 100), /locked by a running Pi/);
		assert.throws(() => recordBaseline(s.l, "pool", 100), /locked by a running Pi/);
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box", PI_PROFILE_LABEL: "pool", PI_CODING_AGENT_DIR: join(s.home, "profiles", "pool") };
		assert.equal(authPoolOnSessionStart(env), false);
		assert.throws(() => syncPooled(s.l, "pool", { env, run: () => ({ status: 0, stdout: "", stderr: "" }) }), /locked by a running Pi/);
		assert.ok(existsSync(shared + ".lock"));
		assert.ok(existsSync(own + ".lock"));
	});

	it("two takers: the slower never removes the lock the faster has just taken", () => {
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, 10 * 60_000);
		let taken = false;
		// Between this taker judging the lock stale and breaking it, another taker breaks it and takes a fresh lock.
		const afterStaleRead = (l: string): void => {
			if (taken) return;
			taken = true;
			rmdirSync(l);
			mkdirSync(l);
		};
		assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 150, afterStaleRead }), /locked by a running Pi/);
		assert.ok(taken);
		assert.ok(existsSync(lock), "the other taker's fresh lock must survive");
		assert.equal(readAuth(shared).openai, undefined);
	});

	it("two takers: while another holds the breaker, the lock is not removed", () => {
		const lock = shared + ".lock";
		mkdirSync(lock);
		ago(lock, 10 * 60_000);
		const afterStaleRead = (l: string): void => {
			if (!existsSync(l + ".break")) writeFileSync(l + ".break", "");
		};
		assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ openai: apiKey("sk-remote-API-SECRET") })), { lockWaitMs: 150, afterStaleRead }), /locked by a running Pi/);
		assert.ok(existsSync(lock));
	});
});

describe("CR-9-PULLSCOPE: a hostile peer", () => {
	const peer = (entries: Record<string, unknown>): SshRunner => () => ({ status: 0, stdout: payload(entries), stderr: "" });
	const io = (run: SshRunner) => Object.assign(captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), { ssh: run });

	it("pull --provider merges only the requested providers and names the others", () => {
		const run = peer({ anthropic: apiKey("!touch-MARKER-CMD"), zz: apiKey("sk-remote-API-SECRET"), other: oauth(Date.now() + 1000) });
		const c = io(run);
		assert.equal(main(["auth", "pull", "kiwi", "--provider", "zz", "--force"], c), 0, c.stderr);
		assert.equal(c.stdout, "zz: added\n");
		assert.equal(c.stderr, "kiwi: anthropic: ignored: not requested\nkiwi: other: ignored: not requested\n");
		noSecret(c.stdout + c.stderr);
		const got = readAuth(shared);
		assert.equal(got.anthropic?.key, "shared", "--force must not replace a provider the user did not name");
		assert.equal(got.other, undefined);
		assert.equal(got.zz?.key, "sk-remote-API-SECRET");
	});

	it("an incoming key Pi would run as a command is refused in pull unless --allow-command-keys", () => {
		const c = io(peer({ evil: apiKey("!touch-MARKER-CMD") }));
		const before = readFileSync(shared, "utf8");
		assert.equal(main(["auth", "pull", "kiwi"], c), 2);
		assert.match(c.stderr, /kiwi: auth payload: evil: the key starts with "!"/);
		noSecret(c.stdout + c.stderr);
		assert.equal(readFileSync(shared, "utf8"), before);
		const ok = io(peer({ evil: apiKey("!touch-MARKER-CMD") }));
		assert.equal(main(["auth", "pull", "kiwi", "--allow-command-keys"], ok), 0, ok.stderr);
		assert.equal(readAuth(shared).evil?.key, "!touch-MARKER-CMD");
	});

	it("an incoming command key is refused in receive unless --allow-command-keys", () => {
		const before = readFileSync(shared, "utf8");
		const c = Object.assign(captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), { readStdin: () => payload({ ok: apiKey("sk-remote-API-SECRET"), evil: apiKey("!touch-MARKER-CMD") }) });
		assert.equal(main(["auth", "receive"], c), 2);
		assert.match(c.stderr, /evil: the key starts with "!"/);
		noSecret(c.stdout + c.stderr);
		assert.equal(readFileSync(shared, "utf8"), before);
		assert.throws(() => receiveAuth(s.l, "default", parsePayload(payload({ evil: apiKey("!x") }))), /--allow-command-keys/);
		const ok = Object.assign(captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), { readStdin: () => payload({ evil: apiKey("!touch-MARKER-CMD") }) });
		assert.equal(main(["auth", "receive", "--allow-command-keys"], ok), 0, ok.stderr);
		assert.equal(ok.stdout, "evil: added\n");
	});

	it("only the ! prefix runs a command in Pi; $NAME only reads the environment", () => {
		const one = (key: string) => parsePayload(payload({ p: apiKey(key) })).get("p");
		assert.equal(isCommandKey(one("!cmd") ?? { type: "api_key" }), true);
		for (const k of ["$HOME", "${HOME}", "$!x", " !x", "plain"]) assert.equal(isCommandKey(one(k) ?? { type: "api_key", key: "!" }), false, k);
		assert.deepEqual(authSshArgs("kiwi", ["receive", "--allow-command-keys"]).slice(-2), ["receive", "--allow-command-keys"]);
	});
});

describe("CR-9-EXPIRY", () => {
	it("refuses an OAuth expires more than a year ahead, without quoting the entry", () => {
		const now = Date.UTC(2026, 0, 1);
		assert.ok(parsePayload(payload({ a: oauth(now + MAX_EXPIRES_AHEAD_MS) }), now).has("a"));
		for (const expires of [now + MAX_EXPIRES_AHEAD_MS + 1, now + 2 * MAX_EXPIRES_AHEAD_MS, 1e300]) {
			assert.throws(() => parsePayload(payload({ a: oauth(expires) }), now), (e: Error) => /a: expires is more than a year away/.test(e.message) && !/REFRESH|ACCESS/.test(e.message));
		}
		assert.equal(MAX_EXPIRES_AHEAD_MS, 365 * 24 * 60 * 60 * 1000);
	});
});

describe("CR-9-BAKSPRAWL", () => {
	it("keeps the newest five backups after each changing receive", () => {
		const contents: string[] = [];
		for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
			contents.push(readFileSync(shared, "utf8"));
			receiveAuth(s.l, "default", parsePayload(payload({ ["p" + String(i)]: apiKey("sk-remote-API-SECRET") })));
		}
		const kept = backups(join(s.home, "agent"));
		assert.equal(kept.length, KEEP_BACKUPS);
		const keptText = kept.map((n) => readFileSync(join(s.home, "agent", n), "utf8")).sort();
		assert.deepEqual(keptText, contents.slice(-KEEP_BACKUPS).sort());
	});

	// Rewrite each backup's stamp to one second and give every backup the same
	// mtime, as a coarse clock does: only the name can then say which is newer.
	const sameSecond = (dir: string, t: Date): string[] => {
		const names = backups(dir);
		const out = names.map((n) => n.replace(/^(auth\.json\.bak-sync-)\d{8}-\d{6}-/, "$120260101-000000-"));
		names.forEach((n, i) => renameSync(join(dir, n), join(dir, out[i] ?? n)));
		for (const n of out) utimesSync(join(dir, n), t, t);
		return out;
	};

	it("prunes backups made in the same second by creation order, whatever their mtimes", () => {
		const dir = join(s.home, "agent");
		const made: string[] = [];
		for (let i = 0; i < 5; i++) {
			const r = receiveAuth(s.l, "default", parsePayload(payload({ ["p" + String(i)]: apiKey("sk-remote-API-SECRET") })));
			made.push(readFileSync(r.backup ?? "", "utf8"));
		}
		const text = (): string[] => backups(dir).map((n) => readFileSync(join(dir, n), "utf8")).sort();
		const t = new Date(Date.UTC(2026, 0, 1));
		sameSecond(dir, t);
		for (let keep = 4; keep >= 1; keep--) {
			pruneBackups(shared, keep);
			assert.deepEqual(text(), made.slice(-keep).sort(), "equal mtimes, keep " + String(keep));
		}
	});

	it("prunes by creation order even when mtimes run backwards", () => {
		const dir = join(s.home, "agent");
		const made: string[] = [];
		for (let i = 0; i < 4; i++) {
			const r = receiveAuth(s.l, "default", parsePayload(payload({ ["p" + String(i)]: apiKey("sk-remote-API-SECRET") })));
			made.push(readFileSync(r.backup ?? "", "utf8"));
		}
		const names = sameSecond(dir, new Date(Date.UTC(2026, 0, 1)));
		const byContent = new Map(names.map((n) => [readFileSync(join(dir, n), "utf8"), n]));
		made.forEach((c, i) => {
			const t = new Date(Date.UTC(2026, 0, 1) - i * 1000);
			utimesSync(join(dir, byContent.get(c) ?? ""), t, t);
		});
		pruneBackups(shared, 2);
		assert.deepEqual(backups(dir).map((n) => readFileSync(join(dir, n), "utf8")).sort(), made.slice(-2).sort());
	});

	it("counts an old-format backup as older than any sequenced one in the same second", () => {
		const dir = join(s.home, "agent");
		const old = (h: string): string => "auth.json.bak-sync-20260101-000000-" + h.repeat(12);
		const seq = (n: number, h: string): string => "auth.json.bak-sync-20260101-000000-" + String(n).padStart(10, "0") + "-" + h.repeat(12);
		const t = new Date(Date.UTC(2026, 0, 1));
		for (const n of [old("f"), old("e"), seq(1, "0"), seq(2, "0"), seq(10, "0")]) {
			writeFileSync(join(dir, n), n);
			utimesSync(join(dir, n), t, t);
		}
		assert.deepEqual(pruneBackups(shared, 3).sort(), [old("e"), old("f")]);
		assert.deepEqual(pruneBackups(shared, 1).sort(), [seq(1, "0"), seq(2, "0")]);
		const r = receiveAuth(s.l, "default", parsePayload(payload({ p: apiKey("sk-remote-API-SECRET") })));
		assert.match(r.backup ?? "", /\.bak-sync-\d{8}-\d{6}-0000000011-[0-9a-f]{12}$/);
	});

	it("deletes only regular files with the exact backup name", () => {
		const dir = join(s.home, "agent");
		const name = (i: number): string => "auth.json.bak-sync-2026010" + String(i) + "-000000-" + "a".repeat(12);
		for (let i = 1; i <= 7; i++) writeFileSync(join(dir, name(i)), String(i));
		writeFileSync(join(dir, "auth.json.bak-sync-20200101-000000-aaaa"), "short random: not ours");
		writeFileSync(join(dir, "auth.json.bak-sync-20200101-000000-" + "a".repeat(12) + ".keep"), "suffix: not ours");
		mkdirSync(join(dir, "auth.json.bak-sync-20200101-000000-" + "b".repeat(12)));
		symlinkSync(join(dir, name(7)), join(dir, "auth.json.bak-sync-20200101-000000-" + "c".repeat(12)));
		writeFileSync(join(dir, "auth.json.bak-20200101-000000-" + "d".repeat(12)), "mode-switch backup: never pruned");
		const removed = pruneBackups(join(dir, "auth.json"), 5);
		assert.deepEqual(removed.sort(), [name(1), name(2)]);
		assert.deepEqual(backups(dir), [
			"auth.json.bak-20200101-000000-" + "d".repeat(12),
			"auth.json.bak-sync-20200101-000000-aaaa",
			"auth.json.bak-sync-20200101-000000-" + "a".repeat(12) + ".keep",
			"auth.json.bak-sync-20200101-000000-" + "b".repeat(12),
			"auth.json.bak-sync-20200101-000000-" + "c".repeat(12),
			name(3), name(4), name(5), name(6), name(7),
		].sort());
	});
});

describe("CR-9-RDWR", () => {
	it("snapshots and export read a 0400 auth.json", () => {
		writeAuth(shared, { openai: apiKey("sk-local-API-SECRET") });
		chmodSync(shared, 0o400);
		assert.match(readAuthSnapshot(shared)?.text ?? "", /openai/);
		assert.deepEqual([...exportAuth(s.l, "default").entries.keys()], ["openai"]);
		const c = Object.assign(captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), { stdoutIsTty: () => false });
		assert.equal(main(["auth", "export"], c), 0, c.stderr);
		assert.match(c.stdout, /"openai"/);
	});
});

describe("CR-9-TTY", () => {
	it("auth export refuses a terminal on stdout and prints nothing", () => {
		writeAuth(shared, { openai: apiKey("sk-local-API-SECRET") });
		const c = Object.assign(captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), { stdoutIsTty: () => true });
		assert.equal(main(["auth", "export"], c), 2);
		assert.equal(c.stdout, "");
		assert.match(c.stderr, /pipe its output/);
	});
});

describe("CR-9-RETRY: a failing peer backs off", () => {
	it("retryDelay is 5 min, doubling, at most 24 h", () => {
		assert.equal(retryDelay(1), RETRY_BASE_MS);
		assert.equal(retryDelay(2), 2 * RETRY_BASE_MS);
		assert.equal(retryDelay(3), 4 * RETRY_BASE_MS);
		assert.equal(retryDelay(50), RETRY_MAX_MS);
		assert.equal(RETRY_BASE_MS, 5 * 60 * 1000);
		assert.equal(RETRY_MAX_MS, 24 * 60 * 60 * 1000);
	});

	it("does not retry before the backoff passes, records the last error without secrets, and auth status shows it", () => {
		createProfile(s.l, "pool", { auth: "pooled" });
		const own = join(s.home, "profiles", "pool", "auth.json");
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, authSync: { peers: ["down"] } }));
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
		writeAuth(own, { codex: { ...oauth(1000), refresh: "rt-OLD" } });
		const t0 = Date.UTC(2026, 0, 1);
		syncPooled(s.l, "pool", { env, run: () => ({ status: 0, stdout: "", stderr: "" }), now: () => t0 });
		writeAuth(own, { codex: oauth(2000) });
		const calls: number[] = [];
		const down: SshRunner = () => {
			calls.push(1);
			return { status: 255, stdout: "rt-NEW-REFRESH", stderr: "ssh: connect to host down port 22: Connection refused\n" };
		};
		const first = syncPooled(s.l, "pool", { env, run: down, now: () => t0 });
		assert.equal(calls.length, 1);
		assert.match(first.peers[0]?.error ?? "", /ssh could not connect/);
		const st = readPoolState(s.l, "pool");
		assert.deepEqual(st?.failing.down, { failures: 1, lastFailedAt: t0, nextAttemptAt: t0 + RETRY_BASE_MS, lastError: "down: auth receive failed: ssh could not connect: ssh: connect to host down port 22: Connection refused" });
		noSecret(readFileSync(join(s.home, "pi-profile", "state", "authsync", "pool.json"), "utf8"));
		// Before the backoff passes: nothing is tried, and the session end does not start a sync.
		assert.equal(poolChanged(s.l, "pool", t0 + 60_000), false);
		const early = syncPooled(s.l, "pool", { env, run: down, now: () => t0 + 60_000 });
		assert.equal(calls.length, 1);
		assert.equal(early.peers[0]?.retryAt, t0 + RETRY_BASE_MS);
		assert.deepEqual(readPoolState(s.l, "pool")?.pending, { down: ["codex"] });
		// After it: tried again, and the next wait doubles.
		const t1 = t0 + RETRY_BASE_MS + 1;
		assert.equal(poolChanged(s.l, "pool", t1), true);
		syncPooled(s.l, "pool", { env, run: down, now: () => t1 });
		assert.equal(calls.length, 2);
		assert.equal(readPoolState(s.l, "pool")?.failing.down?.nextAttemptAt, t1 + 2 * RETRY_BASE_MS);
		const c = captureIo(env);
		assert.equal(main(["auth", "status", "--profile", "pool"], c), 0, c.stderr);
		assert.match(c.stdout, /^down: failing \(2 in a row, last at 2026-01-01T00:05:00\.001Z\); next try after 2026-01-01T00:15:00\.001Z; waiting for codex; last error: down: auth receive failed: ssh could not connect/);
		noSecret(c.stdout + c.stderr);
		// A success clears the failure.
		const t2 = t1 + 2 * RETRY_BASE_MS;
		syncPooled(s.l, "pool", { env, run: () => ({ status: 0, stdout: "codex: replaced\n", stderr: "" }), now: () => t2 });
		assert.deepEqual(readPoolState(s.l, "pool")?.failing, {});
		assert.deepEqual(readPoolState(s.l, "pool")?.pending, {});
	});
});
