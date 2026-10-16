import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { autoBackupOnSessionEnd, autoBackupStateDir, MAX_TRAILING_RUNS, processAlive, processIdentity, readLastStart, readPending, readWaiter, RESCUE_ARGS, runAutoBackup, WAIT_STEP_MS, type RunOutcome, type Spawn } from "../src/core/autobackup.ts";
import { configPath } from "../src/core/config.ts";
import { LOCK_FILE } from "../src/core/lock.ts";
import { rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";

// issue 22: a session end skipped inside the interval, or while a
// run is in progress, is backed up by one later run, with no new process.

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const base = { schemaVersion: 1, hostId: "box", sessionStores: {} };
const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });
const T0 = Date.parse("2026-09-20T10:00:00Z");

function writeConfig(extra: Record<string, unknown>): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(configPath(s.l), JSON.stringify({ ...base, ...extra }));
}

/** A spawn that only counts its calls; its "child" is this live process, so it stands for a live waiter. */
function counting(): { spawn: Spawn; calls: () => number } {
	let n = 0;
	return {
		spawn: () => {
			n++;
			return { pid: process.pid, on: () => undefined, unref: () => undefined };
		},
		calls: () => n,
	};
}

/** A fake clock whose sleep moves time on. */
function clock(start: number): { now: () => number; sleep: (ms: number) => void; advance: (ms: number) => void } {
	let t = start;
	return {
		now: () => t,
		sleep: (ms) => {
			assert.ok(ms > 0, "a sleep must move time on");
			t += ms;
		},
		advance: (ms) => {
			t += ms;
		},
	};
}

/** A PID above any pid_max: never a running process. */
const DEAD_PID = 2147483640;

/** A spawn that records each call's CLI arguments and reports `pid` as the started process. */
function recording(pid: number): { spawn: Spawn; args: Array<readonly string[]> } {
	const args: Array<readonly string[]> = [];
	return {
		spawn: (_command, argv) => {
			args.push(argv.slice(1));
			return { pid, on: () => undefined, unref: () => undefined };
		},
		args,
	};
}

const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
	for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
	return ok();
};

// The source CLI, not bin/pi-profile.mjs: that prefers dist/, which may be an older build.
const SOURCE_CLI = join(import.meta.dirname, "fixtures", "cli-source.mjs");

/** A spawn that starts the real detached CLI (from source) and keeps each child, its arguments and its exit. */
function realSpawn(): { spawn: Spawn; children: Array<{ pid: number | undefined; args: readonly string[]; kill: () => void; exited: Promise<number | null> }> } {
	const children: Array<{ pid: number | undefined; args: readonly string[]; kill: () => void; exited: Promise<number | null> }> = [];
	return {
		spawn: (command, args, options) => {
			const child = nodeSpawn(command, [SOURCE_CLI, ...args.slice(1)], options);
			children.push({ pid: child.pid, args: args.slice(1), kill: () => child.kill("SIGKILL"), exited: new Promise((done) => child.on("exit", done)) });
			return child;
		},
		children,
	};
}

/** A store with session A and a local replica, auto-backup every `interval` seconds. */
function realHome(interval: number): { store: string; sessions: string; backupLock: string; fullEnv: Record<string, string | undefined>; config: string } {
	const store = join(s.home, "store");
	const usb = join(s.home, "usb");
	mkdirSync(join(store, "--home-alice--"), { recursive: true });
	mkdirSync(usb);
	writeFileSync(join(store, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n');
	writeConfig({
		sessionStores: { main: { path: store } },
		defaultSessionStore: "main",
		replicas: [{ id: "usb", kind: "local", path: usb }],
		autoBackup: { onSessionEnd: true, minIntervalSeconds: interval },
	});
	return {
		store: join(store, "--home-alice--"),
		sessions: join(usb, "hosts", "box", "sessions", "--home-alice--"),
		backupLock: join(s.home, "pi-profile", "state", "backup", LOCK_FILE),
		fullEnv: { ...process.env, ...env() },
		config: readFileSync(configPath(s.l), "utf8"),
	};
}

describe("auto-backup pending flag", () => {
	it("a session end inside the interval is recorded as pending and starts nothing", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const f = counting();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 }), true);
		assert.equal(readPending(s.l), false);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 60_000 }), false);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 120_000 }), false);
		assert.equal(f.calls(), 1);
		assert.equal(readPending(s.l), true);
		assert.equal(readLastStart(s.l), T0);
	});

	it("a session end after the interval claims a run and clears pending", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 });
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 60_000 });
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 300_000 }), true);
		assert.equal(readPending(s.l), false);
		assert.equal(readLastStart(s.l), T0 + 300_000);
	});
});

describe("the detached auto-backup run", () => {
	it("runs once more after the interval when a session ended during its run", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		const f = counting();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now }), true);
		const runs: number[] = [];
		runAutoBackup(s.l, env(), () => {
			runs.push(c.now());
			c.advance(10_000);
			// Session B ends while the first run is going.
			if (runs.length === 1) assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now }), false);
			return "done";
		}, { now: c.now, sleep: c.sleep });
		assert.deepEqual(runs, [T0, T0 + 300_000]);
		assert.equal(f.calls(), 1);
		assert.equal(readPending(s.l), false);
		assert.equal(readLastStart(s.l), T0 + 300_000);
	});

	it("waits out the interval, so a session that ends after its run is still picked up", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
		const runs: number[] = [];
		let ended = false;
		runAutoBackup(s.l, env(), () => {
			runs.push(c.now());
			return "done";
		}, {
			now: c.now,
			sleep: (ms) => {
				c.sleep(ms);
				// Session B ends two minutes after A's run has finished.
				if (!ended && c.now() >= T0 + 120_000) {
					ended = true;
					assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now }), false);
				}
			},
		});
		assert.ok(ended);
		assert.deepEqual(runs, [T0, T0 + 300_000]);
		assert.equal(f.calls(), 1);
	});

	it("with nothing pending, it runs once and stops when the interval has passed", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		autoBackupOnSessionEnd(env(), { spawn: counting().spawn, now: c.now });
		let runs = 0;
		runAutoBackup(s.l, env(), () => (runs++, "done"), { now: c.now, sleep: c.sleep });
		assert.equal(runs, 1);
		assert.equal(c.now(), T0 + 300_000);
	});

	it("a run refused because another backup is in progress runs again after the interval", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		autoBackupOnSessionEnd(env(), { spawn: counting().spawn, now: c.now });
		const outcomes: RunOutcome[] = ["busy", "done"];
		const runs: number[] = [];
		runAutoBackup(s.l, env(), () => {
			runs.push(c.now());
			return outcomes[runs.length - 1] ?? "done";
		}, { now: c.now, sleep: c.sleep });
		assert.deepEqual(runs, [T0, T0 + 300_000]);
		assert.equal(readPending(s.l), false);
	});

	it("makes at most MAX_TRAILING_RUNS extra runs, however many sessions end", () => {
		assert.equal(MAX_TRAILING_RUNS, 3);
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
		let runs = 0;
		runAutoBackup(s.l, env(), () => {
			runs++;
			// Fail fast rather than loop for ever if the bound is lost.
			if (runs > 10) throw new Error("unbounded trailing runs");
			c.advance(1000);
			autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
			return "done";
		}, { now: c.now, sleep: c.sleep });
		assert.equal(runs, 1 + MAX_TRAILING_RUNS);
		assert.equal(f.calls(), 1);
		assert.equal(readPending(s.l), true, "the last skipped end is left for the next session end");
		// The capped run has exited and dropped its registration, so the next end inside the interval starts a waiting run.
		assert.equal(readWaiter(s.l), undefined);
		const r = recording(DEAD_PID);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: r.spawn, now: () => c.now() + 1000 }), false);
		assert.deepEqual(r.args, [RESCUE_ARGS]);
	});

	it("hands over when a later session end claims a new interval, which its own run covers", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
		let runs = 0;
		runAutoBackup(s.l, env(), () => {
			runs++;
			c.advance(1000);
			autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
			return "done";
		}, {
			now: c.now,
			sleep: (ms) => {
				c.sleep(ms);
				// After the interval, before this run wakes, a session end claims as usual
				// (its own detached run starts), and one more ends inside the new interval.
				if (c.now() >= T0 + 300_000 && f.calls() === 1) {
					assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 300_000 }), true);
					assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 301_000 }), false);
				}
			},
		});
		assert.equal(runs, 1, "the new interval's run covers the pending end, not this one");
		assert.equal(f.calls(), 2);
		assert.equal(readLastStart(s.l), T0 + 300_000);
		assert.equal(readPending(s.l), true);
		assert.ok(c.now() <= T0 + 300_000, "it did not wait on the new interval");
	});

	it("stops waiting when auto-backup is turned off meanwhile", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
		let runs = 0;
		runAutoBackup(s.l, env(), () => {
			runs++;
			c.advance(1000);
			autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
			writeConfig({ autoBackup: { onSessionEnd: false } });
			return "done";
		}, { now: c.now, sleep: c.sleep });
		assert.equal(runs, 1);
	});

	it("stops within one WAIT_STEP_MS when auto-backup is turned off partway through the wait", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 600 } });
		const c = clock(T0);
		const f = counting();
		autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
		const sleeps: number[] = [];
		let runs = 0;
		runAutoBackup(s.l, env(), () => {
			runs++;
			c.advance(1000);
			autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: c.now });
			return "done";
		}, {
			now: c.now,
			sleep: (ms) => {
				sleeps.push(ms);
				c.sleep(ms);
				// Turned off after the first step of the wait, long before the interval ends.
				if (sleeps.length === 1) writeConfig({ autoBackup: { onSessionEnd: false } });
			},
		});
		assert.equal(runs, 1);
		assert.deepEqual(sleeps, [WAIT_STEP_MS]);
		assert.equal(c.now(), T0 + 1000 + WAIT_STEP_MS);
	});
});

describe("a pending session end with no waiting run left", () => {
	it("reads the clock under the state lock", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const lock = join(autoBackupStateDir(s.l), LOCK_FILE);
		const held: boolean[] = [];
		autoBackupOnSessionEnd(env(), { spawn: counting().spawn, now: () => (held.push(existsSync(lock)), T0) });
		assert.deepEqual(held, [true]);
	});

	it("a session end read just before the run finds nothing pending and exits still gets a waiting run", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const c = clock(T0);
		autoBackupOnSessionEnd(env(), { spawn: counting().spawn, now: c.now });
		runAutoBackup(s.l, env(), () => "done", { now: c.now, sleep: c.sleep });
		assert.equal(readPending(s.l), false);
		// The hook read its clock 1 ms before the interval ended, then got the lock after the run had gone.
		const r = recording(DEAD_PID);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: r.spawn, now: () => T0 + 300_000 - 1 }), false);
		assert.deepEqual(r.args, [RESCUE_ARGS]);
		assert.equal(readPending(s.l), true);
		assert.equal(readWaiter(s.l), String(DEAD_PID));
	});

	it("starts at most one waiting run per interval, and none while a waiter is alive", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		mkdirSync(autoBackupStateDir(s.l), { recursive: true });
		writeFileSync(join(autoBackupStateDir(s.l), "last.json"), JSON.stringify({ lastStart: new Date(T0).toISOString(), waiter: `${String(DEAD_PID)} 1` }));
		const dead = recording(DEAD_PID);
		autoBackupOnSessionEnd(env(), { spawn: dead.spawn, now: () => T0 + 10_000 });
		// The waiting run it started died too: no second launch inside this interval.
		autoBackupOnSessionEnd(env(), { spawn: dead.spawn, now: () => T0 + 20_000 });
		assert.deepEqual(dead.args, [RESCUE_ARGS]);
		assert.equal(readPending(s.l), true);
		// After the interval, a session end claims as usual.
		const live = recording(process.pid);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: live.spawn, now: () => T0 + 300_000 }), true);
		autoBackupOnSessionEnd(env(), { spawn: live.spawn, now: () => T0 + 310_000 });
		assert.equal(live.args.length, 1, "a live waiter covers the next end");
	});

	it("judges a reused PID by its start time", { skip: !existsSync("/proc/self/stat") }, () => {
		assert.equal(processAlive(processIdentity(process.pid)), true);
		assert.equal(processAlive(`${String(process.pid)} 1`), false);
		assert.equal(processAlive(String(DEAD_PID)), false);
		assert.equal(processAlive(undefined), false);
	});
});

describe("auto-backup trailing run end to end", { skip: rsyncSkip }, () => {
	it("a session that ends inside the interval is backed up by one later run of the same detached process", async () => {
		const store = join(s.home, "store");
		const usb = join(s.home, "usb");
		mkdirSync(join(store, "--home-alice--"), { recursive: true });
		mkdirSync(usb);
		writeFileSync(join(store, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n');
		const interval = 3;
		writeConfig({
			sessionStores: { main: { path: store } },
			defaultSessionStore: "main",
			replicas: [{ id: "usb", kind: "local", path: usb }],
			autoBackup: { onSessionEnd: true, minIntervalSeconds: interval },
		});
		const fullEnv = { ...process.env, ...env() };
		let exited: Promise<number | null> | undefined;
		const real: Spawn = (command, args, options) => {
			const child = nodeSpawn(command, [SOURCE_CLI, ...args.slice(1)], options);
			exited = new Promise((done) => child.on("exit", done));
			return child;
		};
		// Session A ends: the one detached process starts.
		assert.equal(autoBackupOnSessionEnd(fullEnv, { spawn: real }), true);
		const first = readLastStart(s.l);
		assert.ok(first !== undefined && exited !== undefined);
		const sessions = join(usb, "hosts", "box", "sessions", "--home-alice--");
		const lock = join(s.home, "pi-profile", "state", "backup", LOCK_FILE);
		assert.ok(await until(() => existsSync(join(sessions, "2026_a.jsonl")) && !existsSync(lock), 10_000), "the first run did not finish");
		// Session B ends inside the interval, after A's run has finished.
		writeFileSync(join(store, "--home-alice--", "2026_b.jsonl"), '{"b":2}\n');
		const f = counting();
		assert.equal(autoBackupOnSessionEnd(fullEnv, { spawn: f.spawn, now: () => first + 1000 }), false);
		assert.equal(f.calls(), 0, "a skipped session end starts no process");
		assert.equal(readPending(s.l), true);
		// The same process backs B up once the interval has passed, then exits. Count the starts it records.
		const starts = new Set<number>([first]);
		const watch = setInterval(() => {
			const at = readLastStart(s.l);
			if (at !== undefined) starts.add(at);
		}, 10);
		assert.ok(await until(() => existsSync(join(sessions, "2026_b.jsonl")), 20_000), "session B was never backed up");
		assert.equal(readFileSync(join(sessions, "2026_b.jsonl"), "utf8"), '{"b":2}\n');
		const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 20_000))]);
		assert.equal(code, 0);
		clearInterval(watch);
		const second = readLastStart(s.l);
		starts.add(second ?? first);
		assert.equal(starts.size, 2, "exactly one later run");
		assert.ok(second !== undefined && second - first >= interval * 1000, "the later run waited out the interval");
		assert.equal(readPending(s.l), false);
		assert.equal(readWaiter(s.l), undefined, "the run dropped its registration when it exited");
	});

	it("a waiting run killed with SIGKILL is replaced by one waiting run, which backs the pending session up", async () => {
		const interval = 4;
		const h = realHome(interval);
		const real = realSpawn();
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: real.spawn }), true);
		const first = readLastStart(s.l);
		const waiter = real.children[0];
		assert.ok(first !== undefined && waiter?.pid !== undefined);
		assert.equal(readWaiter(s.l), processIdentity(waiter.pid));
		assert.ok(await until(() => existsSync(join(h.sessions, "2026_a.jsonl")) && !existsSync(h.backupLock), 10_000), "the first run did not finish");
		if (existsSync("/proc/self/cwd")) {
			// While it waits it sits in /, so it does not keep the home busy.
			assert.ok(await until(() => readlinkSync(`/proc/${String(waiter.pid)}/cwd`) === "/", 3000), "the waiting run kept its working directory");
		}
		waiter.kill();
		await waiter.exited;
		// Session B ends inside the interval: nothing will act on pending, so one waiting run starts.
		writeFileSync(join(h.store, "2026_b.jsonl"), '{"b":2}\n');
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: real.spawn, now: () => first + 1000 }), false);
		const rescue = real.children[1];
		assert.ok(rescue?.pid !== undefined, "no waiting run was started");
		assert.deepEqual(rescue.args, RESCUE_ARGS);
		assert.equal(readPending(s.l), true);
		assert.equal(readWaiter(s.l), processIdentity(rescue.pid));
		// Another end while it waits starts nothing.
		const f = counting();
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: f.spawn, now: () => first + 2000 }), false);
		assert.equal(f.calls(), 0);
		assert.ok(await until(() => existsSync(join(h.sessions, "2026_b.jsonl")), 20_000), "session B was never backed up");
		assert.ok(Date.now() >= first + interval * 1000, "the waiting run backed up before the interval had passed");
		const code = await Promise.race([rescue.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 20_000))]);
		assert.equal(code, 0);
		const second = readLastStart(s.l);
		assert.ok(second !== undefined && second - first >= interval * 1000, "the waiting run ran before the interval had passed");
		assert.equal(readPending(s.l), false);
		assert.equal(readWaiter(s.l), undefined);
	});

	it("a run that exits early drops its registration, so the next end inside the interval starts a waiting run", async () => {
		const h = realHome(5);
		const real = realSpawn();
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: real.spawn }), true);
		const first = readLastStart(s.l);
		const run = real.children[0];
		assert.ok(first !== undefined && run?.pid !== undefined);
		assert.ok(await until(() => existsSync(join(h.sessions, "2026_a.jsonl")) && !existsSync(h.backupLock), 10_000), "the first run did not finish");
		// Once it is asleep (in /), the config is broken: it exits 1 when it next reads it.
		if (existsSync("/proc/self/cwd")) assert.ok(await until(() => readlinkSync(`/proc/${String(run.pid)}/cwd`) === "/", 5000), "the run never started waiting");
		writeFileSync(configPath(s.l), "{not json");
		const code = await Promise.race([run.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 15_000))]);
		assert.equal(code, 1);
		assert.equal(readWaiter(s.l), undefined, "the exiting run left its registration");
		writeFileSync(configPath(s.l), h.config);
		const r = recording(DEAD_PID);
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: r.spawn, now: () => first + 1000 }), false);
		assert.deepEqual(r.args, [RESCUE_ARGS]);
		assert.equal(readPending(s.l), true);
	});

	it("a real run refused by a held backup lock reports busy, sets pending and runs again after the interval", async () => {
		const h = realHome(2);
		mkdirSync(join(s.home, "pi-profile", "state", "backup"), { recursive: true });
		writeFileSync(h.backupLock, `${String(process.pid)} held\n`);
		const real = realSpawn();
		assert.equal(autoBackupOnSessionEnd(h.fullEnv, { spawn: real.spawn }), true);
		const run = real.children[0];
		assert.ok(run !== undefined);
		// Only a refusal mapped to "busy" (error.cause instanceof LockBusy) sets pending; any other error exits 2 at once.
		assert.ok(await until(() => readPending(s.l), 10_000), "the busy run did not set pending");
		rmSync(h.backupLock);
		assert.ok(await until(() => existsSync(join(h.sessions, "2026_a.jsonl")), 20_000), "the session was never backed up");
		const code = await Promise.race([run.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 20_000))]);
		assert.equal(code, 0);
		assert.equal(readPending(s.l), false);
	});
});
