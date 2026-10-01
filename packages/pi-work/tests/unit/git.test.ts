import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { runGit } from "../../src/git.ts";

const MAX_BUFFERED_OUTPUT_BYTES = 256 * 1024;

async function fakeGit(t: TestContext, body: string): Promise<{ dir: string; gitPath: string }> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-work-git-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	const gitPath = path.join(dir, "fake-git.mjs");
	await writeFile(gitPath, `#!${process.execPath}\nimport { writeSync } from "node:fs";\n${body}`);
	await chmod(gitPath, 0o755);
	return { dir, gitPath };
}

function writeBytes(fd: 1 | 2, bytes: number, character: string): string {
	return `writeSync(${fd}, ${JSON.stringify(character)}.repeat(${bytes}));\n`;
}

test("runGit accepts exactly the combined in-memory output limit", async (t) => {
	const half = MAX_BUFFERED_OUTPUT_BYTES / 2;
	const { dir, gitPath } = await fakeGit(t, `${writeBytes(1, half, "o")}${writeBytes(2, half, "e")}`);
	const result = await runGit(gitPath, dir, ["status"]);
	assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), MAX_BUFFERED_OUTPUT_BYTES);
});

test("runGit rejects when buffered stdout exceeds the in-memory output limit", async (t) => {
	const { dir, gitPath } = await fakeGit(t, writeBytes(1, MAX_BUFFERED_OUTPUT_BYTES + 1, "o"));
	await assert.rejects(runGit(gitPath, dir, ["rev-parse", "HEAD"]), /exceeded the 262144-byte in-memory output limit/);
});

test("runGit rejects when buffered stderr exceeds the in-memory output limit", async (t) => {
	const { dir, gitPath } = await fakeGit(t, writeBytes(2, MAX_BUFFERED_OUTPUT_BYTES + 1, "e"));
	await assert.rejects(runGit(gitPath, dir, ["ls-files", "-z"]), /exceeded the 262144-byte in-memory output limit/);
});

test("runGit rejects when individually bounded stdout and stderr exceed the combined limit", async (t) => {
	const half = MAX_BUFFERED_OUTPUT_BYTES / 2;
	const { dir, gitPath } = await fakeGit(t, `${writeBytes(1, half, "o")}${writeBytes(2, half + 1, "e")}`);
	await assert.rejects(runGit(gitPath, dir, ["status"]), /exceeded the 262144-byte in-memory output limit/);
});

test("runGit does not cap or buffer streamed stdout", async (t) => {
	const { dir, gitPath } = await fakeGit(t, `${writeBytes(1, MAX_BUFFERED_OUTPUT_BYTES * 2, "o")}process.stderr.write("warning");\n`);
	let streamedBytes = 0;
	const result = await runGit(gitPath, dir, ["status"], {
		onStdout: (chunk) => { streamedBytes += Buffer.byteLength(chunk); },
	});
	assert.equal(streamedBytes, MAX_BUFFERED_OUTPUT_BYTES * 2);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "warning");
});

test("runGit still bounds stderr while stdout is streamed", async (t) => {
	const { dir, gitPath } = await fakeGit(t, `${writeBytes(1, MAX_BUFFERED_OUTPUT_BYTES * 2, "o")}${writeBytes(2, MAX_BUFFERED_OUTPUT_BYTES + 1, "e")}`);
	let streamedBytes = 0;
	await assert.rejects(
		runGit(gitPath, dir, ["status"], { onStdout: (chunk) => { streamedBytes += Buffer.byteLength(chunk); } }),
		/exceeded the 262144-byte in-memory output limit/,
	);
	assert.equal(streamedBytes, MAX_BUFFERED_OUTPUT_BYTES * 2);
});

test("runGit preserves errors thrown by the stdout consumer", async (t) => {
	const { dir, gitPath } = await fakeGit(t, `process.stdout.write("output");\nsetInterval(() => {}, 1_000);\n`);
	const callbackError = new Error("stdout consumer failed");
	await assert.rejects(
		runGit(gitPath, dir, ["status"], { onStdout: () => { throw callbackError; } }),
		(error: unknown) => error === callbackError,
	);
});

test("runGit preserves small stderr in the nonzero-exit error", async (t) => {
	const { dir, gitPath } = await fakeGit(t, `process.stderr.write("boom detail\\n");\nprocess.exit(3);\n`);
	await assert.rejects(runGit(gitPath, dir, ["ls-files"]), /code 3: boom detail/);
});

test("runGit preserves timeout handling", async (t) => {
	const { dir, gitPath } = await fakeGit(t, `setInterval(() => {}, 1_000);\n`);
	await assert.rejects(runGit(gitPath, dir, ["status"], { timeoutMs: 50 }), /timed out after 50ms/);
});

test("runGit preserves launch error handling", async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-work-git-launch-"));
	t.after(async () => { await rm(dir, { recursive: true, force: true }); });
	await assert.rejects(runGit(path.join(dir, "missing-git"), dir, ["status"]), (error: unknown) => {
		assert.ok(error instanceof Error);
		return "code" in error && error.code === "ENOENT";
	});
});
