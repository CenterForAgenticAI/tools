import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { MANIFEST_LOCK_FILE_NAME, MANIFEST_LOCK_TAKEOVER_FILE_NAME, isManifestLockFileName, processStartTime, withManifestLock } from "../src/cache/manifest-lock.js";
import { isReservedManifestName, runCleanup } from "../src/cache/context-cache.js";

function withTempDir(run: (dir: string) => void): void {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-manifest-lock-")));
	try { run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const lockPath = (dir: string): string => path.join(dir, MANIFEST_LOCK_FILE_NAME);
const FAST = { timeoutMs: 150, pollMs: 1, corruptGraceMs: 60_000 };

test("acquire runs fn, returns its value and releases the lock", () => {
	withTempDir((dir) => {
		const value = withManifestLock(dir, () => {
			assert.ok(fs.existsSync(lockPath(dir)));
			return 42;
		});
		assert.equal(value, 42);
		assert.equal(fs.existsSync(lockPath(dir)), false);
	});
});

test("a throwing fn still releases the lock", () => {
	withTempDir((dir) => {
		assert.throws(() => withManifestLock(dir, () => { throw new Error("boom"); }), /boom/);
		assert.equal(fs.existsSync(lockPath(dir)), false);
	});
});

test("the lock is re-entrant inside one process", () => {
	withTempDir((dir) => {
		withManifestLock(dir, () => withManifestLock(dir, () => assert.ok(fs.existsSync(lockPath(dir)))));
		assert.equal(fs.existsSync(lockPath(dir)), false);
	});
});

test("a lock whose owner pid is dead is taken over", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999, startTime: "1", token: "dead" }));
		let ran = false;
		withManifestLock(dir, () => { ran = true; }, { ...FAST, isAlive: () => false });
		assert.ok(ran);
		assert.equal(fs.existsSync(lockPath(dir)), false);
	});
});

test("a live owner with the same start time is never taken over, however old the lock", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 4242, startTime: "100", token: "live" }));
		const old = new Date(Date.now() - 365 * 24 * 3600_000);
		fs.utimesSync(lockPath(dir), old, old);
		let ran = false;
		assert.throws(
			() => withManifestLock(dir, () => { ran = true; }, { ...FAST, isAlive: () => true, startTimeOf: (pid) => (pid === 4242 ? "100" : "self") }),
			/Timed out/,
		);
		assert.equal(ran, false);
		assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).token, "live");
	});
});

test("a live pid with a different start time (pid reuse) is taken over", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 4242, startTime: "100", token: "reused" }));
		let ran = false;
		withManifestLock(dir, () => { ran = true; }, { ...FAST, isAlive: () => true, startTimeOf: (pid) => (pid === 4242 ? "999" : "self") });
		assert.ok(ran);
	});
});

test("an owner whose start time cannot be read is treated as live and kept", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 4242, startTime: null, token: "unknown" }));
		assert.throws(() => withManifestLock(dir, () => undefined, { ...FAST, isAlive: () => true, startTimeOf: () => null }), /Timed out/);
		assert.ok(fs.existsSync(lockPath(dir)));
	});
});

test("a corrupt lock is not stolen inside the grace period but is once it is old", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), "");
		assert.throws(() => withManifestLock(dir, () => undefined, FAST), /Timed out/);
		assert.ok(fs.existsSync(lockPath(dir)));
		const old = new Date(Date.now() - 3600_000);
		fs.utimesSync(lockPath(dir), old, old);
		let ran = false;
		withManifestLock(dir, () => { ran = true; }, { ...FAST, corruptGraceMs: 1000 });
		assert.ok(ran);
	});
});

test("release does not remove a lock that now belongs to another owner", () => {
	withTempDir((dir) => {
		withManifestLock(dir, () => {
			fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startTime: null, token: "someone-else" }));
		});
		assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).token, "someone-else");
	});
});

test("an abandoned takeover marker from a dead process is cleared", () => {
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999, startTime: "1", token: "dead" }));
		fs.writeFileSync(path.join(dir, MANIFEST_LOCK_TAKEOVER_FILE_NAME), JSON.stringify({ pid: 999_998, startTime: "1", token: "dead-taker" }));
		let ran = false;
		withManifestLock(dir, () => { ran = true; }, { timeoutMs: 2000, pollMs: 1, corruptGraceMs: 60_000, isAlive: () => false });
		assert.ok(ran);
	});
});

test("lock files are reserved names, so orphan cleanup never deletes them", () => {
	assert.ok(isManifestLockFileName(MANIFEST_LOCK_FILE_NAME));
	assert.ok(isReservedManifestName(MANIFEST_LOCK_FILE_NAME));
	assert.ok(isReservedManifestName(MANIFEST_LOCK_TAKEOVER_FILE_NAME));
	withTempDir((dir) => {
		fs.writeFileSync(lockPath(dir), "{}");
		fs.writeFileSync(path.join(dir, "orphan.md"), "x");
		const result = runCleanup(dir, { version: 1, files: {} }, { staleHours: 1000, maxBytes: 1e9 });
		assert.ok(result.changed);
		assert.ok(fs.existsSync(lockPath(dir)));
		assert.equal(fs.existsSync(path.join(dir, "orphan.md")), false);
	});
});

test("processStartTime reads this process and returns null for a nonexistent pid", () => {
	assert.equal(processStartTime(process.pid), processStartTime(process.pid));
	assert.ok(processStartTime(process.pid));
	assert.equal(processStartTime(2 ** 22 + 12345), null);
});

test("two real processes never hold the lock at once", async () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-manifest-lock-mx-")));
	try {
		const lockModule = new URL("../src/cache/manifest-lock.js", import.meta.url).href;
		const code = `
			import fs from "node:fs";
			const { withManifestLock } = await import(process.argv[1]);
			const dir = process.argv[2];
			for (let i = 0; i < 20; i++) {
				withManifestLock(dir, () => {
					const f = dir + "/inside";
					if (fs.existsSync(f)) { console.error("OVERLAP"); process.exit(3); }
					fs.writeFileSync(f, String(process.pid));
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
					fs.unlinkSync(f);
				});
			}`;
		const run = (): Promise<{ code: number | null; stderr: string }> => new Promise((resolve) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", code, lockModule, dir], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (d) => { stderr += d; });
			child.on("close", (c) => resolve({ code: c, stderr }));
		});
		const results = await Promise.all([run(), run(), run()]);
		for (const r of results) assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: "" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
