import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { autoBackupOnSessionEnd, autoBackupStateDir, BACKUP_ARGS, CLI_PATH, currentRuntime, nodeExecPath, readLastStart, shouldAutoBackup, type Runtime, type Spawn } from "../src/core/autobackup.ts";
import { configPath, DEFAULT_MIN_INTERVAL_SECONDS, loadConfig, parseConfig, updateConfig, type MachineConfig } from "../src/core/config.ts";
import { LOCK_FILE } from "../src/core/lock.ts";
import { Refusal } from "../src/core/result.ts";
import piProfile from "../src/index.ts";
import { rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = { schemaVersion: 1, hostId: "box", sessionStores: {} };
const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });

function writeConfig(extra: Record<string, unknown>): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(configPath(s.l), JSON.stringify({ ...base, ...extra }));
}

interface Call {
	command: string;
	args: readonly string[];
	options: Record<string, unknown>;
	child: EventEmitter & { unrefs: number };
}
/** A spawn that records each call and returns an EventEmitter in place of the child. */
function fakeSpawn(): { spawn: Spawn; calls: Call[] } {
	const calls: Call[] = [];
	const spawn: Spawn = (command, args, options) => {
		const child = Object.assign(new EventEmitter(), {
			// This live process stands in for the started run, so the hook sees a live waiter.
			pid: process.pid,
			unrefs: 0,
			unref(): void {
				child.unrefs++;
			},
		});
		calls.push({ command, args, options: options as Record<string, unknown>, child });
		return child;
	};
	return { spawn, calls };
}

const on = (minIntervalSeconds = 300): MachineConfig => parseConfig({ ...base, autoBackup: { onSessionEnd: true, minIntervalSeconds } });
const T0 = Date.parse("2026-09-20T10:00:00Z");

describe("autoBackup config", () => {
	it("is off when absent", () => {
		const c = parseConfig(base);
		assert.equal(c.autoBackup, undefined);
		assert.equal(shouldAutoBackup(c, undefined, T0), false);
	});

	it("parses a valid value", () => {
		assert.deepEqual(parseConfig({ ...base, autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } }).autoBackup, { onSessionEnd: true, minIntervalSeconds: 300 });
		assert.deepEqual(parseConfig({ ...base, autoBackup: { onSessionEnd: false, minIntervalSeconds: 0 } }).autoBackup, { onSessionEnd: false, minIntervalSeconds: 0 });
	});

	it("defaults minIntervalSeconds to 300 when it is absent", () => {
		assert.equal(DEFAULT_MIN_INTERVAL_SECONDS, 300);
		assert.deepEqual(parseConfig({ ...base, autoBackup: { onSessionEnd: true } }).autoBackup, { onSessionEnd: true, minIntervalSeconds: 300 });
		assert.deepEqual(parseConfig({ ...base, autoBackup: { onSessionEnd: false } }).autoBackup, { onSessionEnd: false, minIntervalSeconds: 300 });
	});

	it("refuses invalid values with a clear message", () => {
		const cases: Array<[unknown, RegExp]> = [
			[true, /autoBackup must be \{ onSessionEnd: boolean, minIntervalSeconds\?: number \}/],
			[[], /autoBackup must be/],
			[{ onSessionEnd: "yes", minIntervalSeconds: 300 }, /autoBackup\.onSessionEnd must be true or false/],
			[{ minIntervalSeconds: 300 }, /autoBackup\.onSessionEnd must be true or false/],
			[{ onSessionEnd: true, minIntervalSeconds: null }, /autoBackup\.minIntervalSeconds must be a number of seconds, 0 or more/],
			[{ onSessionEnd: true, minIntervalSeconds: "300" }, /minIntervalSeconds must be a number/],
			[{ onSessionEnd: true, minIntervalSeconds: -1 }, /minIntervalSeconds must be a number/],
			[{ onSessionEnd: true, minIntervalSeconds: 300, every: 5 }, /autoBackup\.every is not a known key/],
		];
		for (const [value, message] of cases) {
			assert.throws(() => parseConfig({ ...base, autoBackup: value }), (e: unknown) => e instanceof Refusal && message.test(e.message), JSON.stringify(value));
		}
	});

	it("refuses an invalid value from config.json alongside other errors", () => {
		writeConfig({ autoBackup: { onSessionEnd: 1, minIntervalSeconds: 300 }, defaultProfile: 3 });
		assert.throws(() => loadConfig(s.l), /defaultProfile must be a string; autoBackup\.onSessionEnd must be true or false/);
	});

	it("survives a config update", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 60 } });
		updateConfig(s.l, (c) => ({ ...c, defaultProfile: "work" }), env());
		assert.deepEqual(loadConfig(s.l).autoBackup, { onSessionEnd: true, minIntervalSeconds: 60 });
	});
});

describe("shouldAutoBackup", () => {
	it("needs onSessionEnd", () => {
		assert.equal(shouldAutoBackup(parseConfig({ ...base, autoBackup: { onSessionEnd: false, minIntervalSeconds: 0 } }), undefined, T0), false);
	});

	it("runs the first time", () => {
		assert.equal(shouldAutoBackup(on(), undefined, T0), true);
	});

	it("waits minIntervalSeconds after the last start", () => {
		assert.equal(shouldAutoBackup(on(300), T0, T0 + 299_999), false);
		assert.equal(shouldAutoBackup(on(300), T0, T0 + 300_000), true);
		assert.equal(shouldAutoBackup(on(0), T0, T0), true);
	});

	it("is not held off by a last start in the future (the clock went back)", () => {
		assert.equal(shouldAutoBackup(on(300), T0 + 86_400_000, T0), true);
	});
});

describe("auto-backup on session end", () => {
	it("starts the package's own CLI detached, quiet and unreferenced, and records the start", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 }), true);
		assert.equal(f.calls.length, 1);
		const [call] = f.calls;
		assert.ok(call);
		assert.equal(call.command, process.execPath);
		assert.equal(CLI_PATH, join(repoRoot, "bin", "pi-profile.mjs"));
		assert.ok(existsSync(CLI_PATH));
		assert.deepEqual(call.args, [CLI_PATH, ...BACKUP_ARGS]);
		assert.deepEqual(BACKUP_ARGS, ["backup", "run", "--quiet", "--auto"]);
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.equal((call.options.env as Record<string, string>).PI_PROFILE_HOME, s.home);
		assert.equal(call.child.unrefs, 1);
		assert.equal(readLastStart(s.l), T0);
		assert.ok(autoBackupStateDir(s.l).startsWith(join(s.home, "pi-profile", "state")));
	});

	it("does not start again inside the interval, and does after it", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 }), true);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 299_000 }), false);
		assert.equal(f.calls.length, 1);
		assert.equal(readLastStart(s.l), T0);
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 300_000 }), true);
		assert.equal(f.calls.length, 2);
		assert.equal(readLastStart(s.l), T0 + 300_000);
	});

	it("does nothing, and writes no state, when off or unconfigured", () => {
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), false);
		writeConfig({ autoBackup: { onSessionEnd: false, minIntervalSeconds: 0 } });
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), false);
		assert.equal(f.calls.length, 0);
		assert.equal(existsSync(autoBackupStateDir(s.l)), false);
	});

	it("never throws: a broken config, a failing spawn or a late spawn error", () => {
		const f = fakeSpawn();
		writeConfig({ autoBackup: { onSessionEnd: "yes" } });
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), false);
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), "{not json");
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), false);
		assert.equal(f.calls.length, 0);

		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 0 } });
		const throwing: Spawn = () => {
			throw new Error("EAGAIN");
		};
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: throwing }), false);

		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), true);
		// An EventEmitter with no "error" listener throws on emit; the launcher must have one.
		assert.doesNotThrow(() => f.calls[0]?.child.emit("error", new Error("ENOENT")));
	});

	it("treats a damaged state file as never run", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		mkdirSync(autoBackupStateDir(s.l), { recursive: true });
		writeFileSync(join(autoBackupStateDir(s.l), "last.json"), "{oops");
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 }), true);
		assert.equal(readLastStart(s.l), T0);
	});

	it("skips while another process holds the claim lock", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		mkdirSync(autoBackupStateDir(s.l), { recursive: true });
		writeFileSync(join(autoBackupStateDir(s.l), LOCK_FILE), `${String(process.ppid)} other\n`);
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 }), false);
		assert.equal(f.calls.length, 0);
		assert.equal(readLastStart(s.l), undefined);
	});

	it("lets only one of two sessions ending at once start a backup", async () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const marker = join(s.home, "first-has-read");
		// The first session reads the last start, then pauses before writing it.
		const script = `
			import { writeFileSync } from "node:fs";
			import { autoBackupOnSessionEnd } from ${JSON.stringify(join(repoRoot, "src", "core", "autobackup.ts"))};
			const started = autoBackupOnSessionEnd(${JSON.stringify(env())}, {
				spawn: () => ({ on() {}, unref() {} }),
				hooks: { afterRead() { writeFileSync(${JSON.stringify(marker)}, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); } },
			});
			process.stdout.write(String(started));
		`;
		const first = nodeSpawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		first.stdout.on("data", (d: Buffer) => (out += d.toString()));
		const exited = new Promise<number | null>((done) => first.on("exit", done));
		for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(existsSync(marker), "the first session never reached its claim");
		// The second session ends while the first is between its read and its write.
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn }), false);
		assert.equal(f.calls.length, 0);
		assert.equal(await exited, 0);
		assert.equal(out, "true");
		assert.notEqual(readLastStart(s.l), undefined);
	});
});

describe("auto-backup runtime check", () => {
	const node: Runtime = { execPath: "/opt/node/bin/node", bunVersion: undefined, releaseName: "node", isSea: () => false };
	const notNode: Record<string, Runtime> = {
		bun: { ...node, execPath: "/usr/bin/pi", bunVersion: "1.2.0" },
		"a non-node release": { ...node, execPath: "/usr/bin/pi", releaseName: "bun" },
		"a Node SEA binary": { ...node, execPath: "/usr/bin/pi", isSea: () => true },
		"an SEA check that throws": {
			...node,
			execPath: "/usr/bin/pi",
			isSea: () => {
				throw new Error("no node:sea");
			},
		},
	};

	it("runs the CLI with execPath when it is Node, as on this host", () => {
		assert.equal(nodeExecPath(node), "/opt/node/bin/node");
		assert.equal(nodeExecPath(currentRuntime()), process.execPath);
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		const f = fakeSpawn();
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0, runtime: node }), true);
		assert.equal(f.calls[0]?.command, "/opt/node/bin/node");
	});

	for (const [name, runtime] of Object.entries(notNode)) {
		it(`skips without spawning or using up the interval under ${name}`, () => {
			assert.equal(nodeExecPath(runtime), undefined);
			writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
			const f = fakeSpawn();
			assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0, runtime }), false);
			assert.equal(f.calls.length, 0);
			assert.equal(readLastStart(s.l), undefined);
			// A later session end on Node still gets this interval.
			assert.equal(autoBackupOnSessionEnd(env(), { spawn: f.spawn, now: () => T0 + 1000, runtime: node }), true);
			assert.equal(f.calls.length, 1);
		});
	}
});

describe("extension session_shutdown", () => {
	function shutdown(reason: string): void {
		const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
		const api = { on: (name: string, h: (e: unknown, ctx: unknown) => void) => handlers.set(name, h), registerCommand: () => undefined, appendEntry: () => undefined };
		const saved = { ...process.env };
		Object.assign(process.env, env());
		try {
			piProfile(api as never);
			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, { hasUI: false });
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	}

	// No replicas, so the real `backup run` it starts refuses at once and writes nothing.
	it("claims a backup when a session ends", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		shutdown("quit");
		assert.notEqual(readLastStart(s.l), undefined);
	});

	it("does not back up on a reload, which keeps the session", () => {
		writeConfig({ autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } });
		shutdown("reload");
		assert.equal(readLastStart(s.l), undefined);
	});

	it("does not throw on a broken config", () => {
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(configPath(s.l), "{not json");
		assert.doesNotThrow(() => shutdown("quit"));
	});
});

describe("auto-backup end to end", { skip: rsyncSkip }, () => {
	it("runs a real detached backup to a local replica with rsync", async () => {
		const store = join(s.home, "store");
		const usb = join(s.home, "usb");
		mkdirSync(join(store, "--home-alice--"), { recursive: true });
		mkdirSync(usb);
		writeFileSync(join(store, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n');
		writeConfig({
			sessionStores: { main: { path: store } },
			defaultSessionStore: "main",
			replicas: [{ id: "usb", kind: "local", path: usb }],
			// Short, so the detached run's wait for a trailing run (issue 22) ends soon.
			autoBackup: { onSessionEnd: true, minIntervalSeconds: 1 },
		});
		assert.equal(autoBackupOnSessionEnd({ ...process.env, ...env() }), true);
		const copy = join(usb, "hosts", "box", "sessions", "--home-alice--", "2026_a.jsonl");
		const hostJson = join(usb, "hosts", "box", "host.json");
		const lock = join(s.home, "pi-profile", "state", "backup", LOCK_FILE);
		const done = (): boolean => existsSync(copy) && existsSync(hostJson) && !existsSync(lock);
		for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(done(), "the detached backup did not finish");
		assert.equal(readFileSync(copy, "utf8"), '{"a":1}\n');
	});
});
