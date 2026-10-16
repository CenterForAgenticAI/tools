import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { autoBackupOnSessionEnd, autoBackupStateDir, readLastStart, type Spawn } from "../src/core/autobackup.ts";
import { backupStateDir } from "../src/core/backup.ts";
import { configPath } from "../src/core/config.ts";
import { doctor, shellQuote } from "../src/core/doctor.ts";
import { BREAKER_STALE_MS, LOCK_FILE, removeStaleBreaker, withProfileLock } from "../src/core/lock.ts";
import { main } from "../src/cli/main.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

// issue 23: a lock breaker left by a crash under state/autobackup
// or state/backup must not turn auto-backup off without a word.

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const DEAD_LOCK = "2147483646 dead\n";
const DEAD_BREAKER = "2147483645 crashed\n";
const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });
const noSpawn: Spawn = () => ({ on: () => undefined, unref: () => undefined });

function ago(path: string, ms: number): void {
	const t = (Date.now() - ms) / 1000;
	utimesSync(path, t, t);
}

/** Leave a breaker as a crashed pi-profile would, beside a lock (stale by default). */
function leave(dir: string, opts: { lock?: string | undefined; breaker?: string; ageMs?: number } = {}): string {
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, LOCK_FILE);
	const lockText = "lock" in opts ? opts.lock : DEAD_LOCK;
	if (lockText !== undefined) writeFileSync(lock, lockText);
	const breaker = `${lock}.break`;
	writeFileSync(breaker, opts.breaker ?? DEAD_BREAKER);
	ago(breaker, opts.ageMs ?? BREAKER_STALE_MS + 5000);
	return breaker;
}

function autoOn(): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(configPath(s.l), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, autoBackup: { onSessionEnd: true, minIntervalSeconds: 300 } }));
}

describe("a leftover lock breaker", () => {
	it("beside a stale lock makes the lock refuse (the problem)", () => {
		const dir = join(s.home, "d");
		leave(dir);
		assert.throws(() => withProfileLock(dir, () => assert.fail("must not run")), /left by a process that is gone/);
	});
});

describe("removeStaleBreaker", () => {
	it("removes a provably stale breaker beside a stale lock, and the lock works again", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir);
		assert.equal(removeStaleBreaker(dir), true);
		assert.equal(existsSync(breaker), false);
		assert.equal(withProfileLock(dir, () => "ran"), "ran");
		assert.deepEqual(readdirSync(dir), []);
	});

	it("removes a provably stale breaker when the lock is gone", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir, { lock: undefined });
		assert.equal(removeStaleBreaker(dir), true);
		assert.equal(existsSync(breaker), false);
	});

	it("keeps a breaker younger than BREAKER_STALE_MS", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir, { ageMs: BREAKER_STALE_MS - 3000 });
		assert.equal(removeStaleBreaker(dir), false);
		assert.equal(existsSync(breaker), true);
	});

	it("keeps a breaker whose writer is still running", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir, { breaker: `${String(process.ppid)} live\n` });
		assert.equal(removeStaleBreaker(dir), false);
		assert.equal(existsSync(breaker), true);
	});

	it("keeps a breaker that names no process", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir, { breaker: "" });
		assert.equal(removeStaleBreaker(dir), false);
		assert.equal(existsSync(breaker), true);
	});

	it("keeps a breaker beside a lock whose holder is still running", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir, { lock: `${String(process.ppid)} live\n` });
		assert.equal(removeStaleBreaker(dir), false);
		assert.equal(existsSync(breaker), true);
	});

	it("keeps a fresh breaker that replaced the stale one after it was judged", () => {
		const dir = join(s.home, "d");
		const breaker = leave(dir);
		const fresh = `${String(process.ppid)} fresh\n`;
		const afterJudged = (): void => {
			rmSync(breaker);
			writeFileSync(breaker, fresh);
		};
		assert.equal(removeStaleBreaker(dir, { afterJudged }), false);
		assert.equal(existsSync(breaker), true);
		assert.deepEqual(readdirSync(dir).sort(), [LOCK_FILE, `${LOCK_FILE}.break`]);
	});
});

describe("the auto-backup hook and a leftover breaker", () => {
	it("clears a provably stale breaker under state/autobackup and claims the backup", () => {
		autoOn();
		const breaker = leave(autoBackupStateDir(s.l));
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: noSpawn }), true);
		assert.equal(existsSync(breaker), false);
		assert.notEqual(readLastStart(s.l), undefined);
	});

	it("clears a provably stale breaker under state/backup before starting the run", () => {
		autoOn();
		const breaker = leave(backupStateDir(s.l));
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: noSpawn }), true);
		assert.equal(existsSync(breaker), false);
		assert.equal(withProfileLock(backupStateDir(s.l), () => "ran"), "ran");
	});

	it("leaves a breaker alone when auto-backup is off", () => {
		const breaker = leave(autoBackupStateDir(s.l));
		assert.equal(autoBackupOnSessionEnd(env(), { spawn: noSpawn }), false);
		assert.equal(existsSync(breaker), true);
	});
});

describe("pi-profile doctor and a leftover breaker", () => {
	it("reports a leftover breaker under state/autobackup and state/backup, with how to remove it", () => {
		const auto = leave(autoBackupStateDir(s.l));
		const backup = leave(backupStateDir(s.l));
		const found = doctor(s.l).filter((f) => f.message.includes(".pi-profile.lock.break"));
		assert.equal(found.length, 2);
		for (const [f, path] of [[found[0], auto], [found[1], backup]] as const) {
			assert.equal(f?.level, "warn");
			assert.ok(f?.message.includes(`rm ${shellQuote(path)}`), f?.message);
		}
		const io = captureIo(env());
		assert.equal(main(["doctor"], io), 0);
		assert.ok(io.stdout.includes(`rm '${auto}'`) && io.stdout.includes(`rm '${backup}'`));
	});

	it("prints an rm command that removes exactly the breaker, whatever the home's name holds", () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
		try {
			const marker = join(parent, "pwned");
			const home = join(parent, `p b it's $(touch ${marker}) \`touch ${marker}\``);
			const l = { piHome: home };
			const breaker = leave(autoBackupStateDir(l));
			const f = doctor(l).find((x) => x.message.includes(".pi-profile.lock.break"));
			const command = f?.message.slice(f.message.indexOf("remove it: ") + "remove it: ".length) ?? "";
			assert.ok(command.startsWith("rm '"), f?.message);
			const run = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
			assert.equal(run.status, 0, run.stderr);
			assert.equal(existsSync(breaker), false, "the command did not remove the breaker");
			assert.equal(existsSync(marker), false, "the command ran a substitution");
			assert.equal(existsSync(join(autoBackupStateDir(l), LOCK_FILE)), true, "the command removed something else");
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("does not report a breaker younger than BREAKER_STALE_MS", () => {
		leave(autoBackupStateDir(s.l), { ageMs: 0 });
		assert.deepEqual(doctor(s.l).filter((f) => f.message.includes(".break")), []);
	});
});
