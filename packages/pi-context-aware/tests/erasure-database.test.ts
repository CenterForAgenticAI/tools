import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { erasedSessionIds, SessionDatabase, sessionDatabaseFile } from "../src/erasure/database.js";

const LOCK_HOLDER = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
process.stdout.write("locked\\n");
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  setTimeout(() => {
    const unlockStartedAt = performance.timeOrigin + performance.now();
    db.exec("ROLLBACK");
    db.close();
    process.stdout.write("unlocking:" + unlockStartedAt + "\\n");
  }, 200);
});
`;

test("erasedSessionIds waits for a concurrent database lock and then reads", { timeout: 3_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-read-lock-"));
	const db = new SessionDatabase(root);
	db.erase(["gone"]);
	db.close();

	const child = spawn(process.execPath, ["--input-type=module", "--eval", LOCK_HOLDER, sessionDatabaseFile(root)], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let stdout = "";
	let markReady!: () => void;
	let markUnlocking!: (unlockStartedAt: number) => void;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`lock holder exited before the read: ${code}\n${stderr}`)));
	});
	const unlocking = new Promise<number>((resolve) => { markUnlocking = resolve; });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		if (stdout.includes("locked\n")) markReady();
		const match = /(?:^|\n)unlocking:(\d+(?:\.\d+)?)\n/.exec(stdout);
		if (match) markUnlocking(Number(match[1]));
	});

	try {
		await ready;
		child.stdin.end("release\n");
		const readStartedAt = performance.timeOrigin + performance.now();
		const sessionIds = [...erasedSessionIds(root)];
		const readFinishedAt = performance.timeOrigin + performance.now();
		const unlockStartedAt = await Promise.race([
			unlocking,
			exit.then((code) => { throw new Error(`lock holder exited without reporting release: ${code}\n${stderr}`); }),
		]);

		assert.deepEqual(sessionIds, ["gone"]);
		assert.ok(readStartedAt < unlockStartedAt, `read started at ${readStartedAt} after unlocking began at ${unlockStartedAt}`);
		assert.ok(unlockStartedAt <= readFinishedAt, `read finished at ${readFinishedAt} before unlocking began at ${unlockStartedAt}`);
		assert.equal(await exit, 0, stderr);
	} finally {
		if (child.exitCode === null) child.kill();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
