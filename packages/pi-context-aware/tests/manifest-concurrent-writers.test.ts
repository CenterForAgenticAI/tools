import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { readManifest, writeManifest } from "../src/cache/context-cache.js";

/**
 * Child process that publishes one cache file and its manifest entry. The
 * barrier sits between the manifest read and the manifest write, so both
 * writers hold the same older snapshot when mode is "unlocked". The barrier
 * waits for the peer's read marker for at most 1.5 s, then proceeds: under the
 * lock the peer cannot read until this writer is done, so it times out and
 * the writers serialise instead of deadlocking.
 */
const CHILD = `
import fs from "node:fs";
const cache = await import(process.argv[1]);
const [ , , dir, name, peer, mode] = process.argv;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function step(manifest) {
	fs.writeFileSync(dir + "/.read-" + name, "1");
	const until = Date.now() + 1500;
	while (!fs.existsSync(dir + "/.read-" + peer) && Date.now() < until) sleep(5);
	return cache.writeCacheFile(dir, manifest, "session-" + name, name + ".md", "content " + name, "doc " + name);
}
if (mode === "unlocked") {
	cache.writeManifest(dir, step(cache.readManifest(dir)));
} else {
	cache.mutateManifest(dir, (manifest) => { const next = step(manifest); return { manifest: next, result: undefined }; });
}
`;

function runChild(dir: string, name: string, peer: string, mode: "unlocked" | "locked"): Promise<number | null> {
	const module = new URL("../src/cache/context-cache.js", import.meta.url).href;
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, module, dir, name, peer, mode], { stdio: "ignore" });
		child.on("close", resolve);
	});
}

function withPool<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-manifest-race-")));
	return run(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const entries = (dir: string): string[] => Object.keys(readManifest(dir).files).sort();

test("harness: without the lock the barrier reproduces the lost update", async () => {
	await withPool(async (dir) => {
		const codes = await Promise.all([runChild(dir, "a", "b", "unlocked"), runChild(dir, "b", "a", "unlocked")]);
		assert.deepEqual(codes, [0, 0]);
		assert.ok(fs.existsSync(path.join(dir, "a.md")) && fs.existsSync(path.join(dir, "b.md")));
		assert.equal(entries(dir).length, 1, "one writer's entry was lost");
	});
});

test("two concurrent mutators in separate processes keep both entries and both files", async () => {
	await withPool(async (dir) => {
		const codes = await Promise.all([runChild(dir, "a", "b", "locked"), runChild(dir, "b", "a", "locked")]);
		assert.deepEqual(codes, [0, 0]);
		assert.deepEqual(entries(dir), ["a.md", "b.md"]);
		assert.equal(fs.readFileSync(path.join(dir, "a.md"), "utf8"), "content a");
		assert.equal(fs.readFileSync(path.join(dir, "b.md"), "utf8"), "content b");
		assert.equal(fs.existsSync(path.join(dir, ".manifest.lock")), false);
	});
});

const CLEANER = `
import fs from "node:fs";
const cache = await import(process.argv[1]);
const [ , , dir, mode ] = process.argv;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === "promote") {
	cache.mutateManifest(dir, (manifest) => {
		const next = cache.writeCacheFile(dir, manifest, "session-p", "promoted.md", "kept", "doc");
		fs.writeFileSync(dir + "/.file-written", "1"); // file on disk, manifest not yet published
		sleep(400);
		return { manifest: next, result: undefined };
	});
} else {
	while (!fs.existsSync(dir + "/.file-written")) sleep(5);
	cache.mutateManifest(dir, (manifest) => {
		const result = cache.runCleanup(dir, manifest, { staleHours: 1000, maxBytes: 1e9 });
		return { manifest: result.changed ? result.manifest : undefined, result: undefined };
	});
}
`;

test("orphan cleanup racing a publish cannot delete the file whose entry is not yet listed", async () => {
	await withPool(async (dir) => {
		const module = new URL("../src/cache/context-cache.js", import.meta.url).href;
		const go = (mode: string): Promise<number | null> => new Promise((resolve) => {
			spawn(process.execPath, ["--input-type=module", "-e", CLEANER, module, dir, mode], { stdio: "ignore" }).on("close", resolve);
		});
		const codes = await Promise.all([go("promote"), go("clean")]);
		assert.deepEqual(codes, [0, 0]);
		assert.deepEqual(entries(dir), ["promoted.md"]);
		assert.equal(fs.readFileSync(path.join(dir, "promoted.md"), "utf8"), "kept");
	});
});

test("failure rollback removes only the failing writer's file, not another writer's", async () => {
	await withPool(async (dir) => {
		const { mutateManifest, writeCacheFile } = await import("../src/cache/context-cache.js");
		mutateManifest(dir, (m) => ({ manifest: writeCacheFile(dir, m, "s1", "other.md", "other", "d"), result: undefined }));
		assert.throws(() => mutateManifest(dir, (m) => {
			const next = writeCacheFile(dir, m, "s2", "mine.md", "mine", "d");
			// Make publication fail: the manifest path becomes a directory.
			fs.rmSync(path.join(dir, "_manifest.json"));
			fs.mkdirSync(path.join(dir, "_manifest.json"));
			return { manifest: next, result: undefined, rollback: () => fs.rmSync(path.join(dir, "mine.md")) };
		}));
		fs.rmSync(path.join(dir, "_manifest.json"), { recursive: true });
		assert.equal(fs.existsSync(path.join(dir, "mine.md")), false);
		assert.equal(fs.readFileSync(path.join(dir, "other.md"), "utf8"), "other");
		void writeManifest;
	});
});
