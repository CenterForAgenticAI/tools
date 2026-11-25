/**
 * caair/pi/pi-context-aware#246: the parity and metrics stores and the erasure deletes reach each file
 * through the directory they verified and hold open, by its identity (Linux /proc/self/fd, macOS
 * /.vol/<dev>/<ino>), never by its pathname again. These tests swap the store directory, or one of its
 * parents up to two levels above it, for a symlink to an outside directory right after the store has
 * opened a directory, and assert that nothing outside is written, read or deleted. Resolving a later
 * name by pathname instead turns each of them red. The refusal tests make every identity path fail
 * to verify and assert that the stores refuse and touch nothing, so a pathname fallback turns them red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { appendParityRecord, PARITY_RECORD_VERSION, paritySessionFile, readParityRecords, type CompressRecord } from "../src/parity/records.js";
import { appendMetricsRecord, buildMetricsRecord, metricsSessionFile, type MetricsInput } from "../src/metrics/records.js";
import { descriptorPathCandidates, removeStoreFile } from "../src/erasure/files.js";
import { discoverProfileSessions } from "../src/erasure/extension.js";

const record = (sessionId: string): CompressRecord => ({ v: PARITY_RECORD_VERSION, kind: "compress", fingerprint: "test", sessionId, at: "2026-01-01", toolCallId: "call", nested: false, verdict: "match", diffs: [] });
const metricsInput = (seq: number, sessionId: string): MetricsInput => ({ seq, at: new Date("2026-01-01T00:00:00Z"), sessionId, folds: { requested: 0, accepted: 0, refused: {}, dropped: {} } });
const limits = { maxBytes: 4096, maxDirBytes: 1_000_000 };
const PARITY_REFUSAL = /Unsafe parity store: this platform cannot open files relative to a verified directory/u;
const ERASURE_REFUSAL = /Platform cannot safely delete through held directories/u;

function scratch() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-swap-")));
	const agentDir = path.join(root, "agent");
	const outside = path.join(root, "outside");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(outside);
	return { root, agentDir, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Every file below `dir`, relative and sorted, so a test can assert an outside tree is unchanged. */
const tree = (dir: string) => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
/** Like tree, with each file's text, so a test can assert a store is unchanged. */
const snapshot = (dir: string) => tree(dir).map((name) => {
	const file = path.join(dir, name);
	return fs.lstatSync(file).isFile() ? `${name}: ${fs.readFileSync(file, "utf8")}` : name;
});
/** The directory `up` levels above `dir`. */
const ancestor = (dir: string, up: number) => path.resolve(dir, ...Array<string>(up).fill(".."));

/** Rename `victim` aside and leave a symlink to `outside` in its place, once, right after the store opens a directory named `after`. */
function swapAfterOpen(kind: "async" | "sync", after: string, victim: string, outside: string) {
	let armed = true;
	const swap = (file: unknown) => {
		if (!armed || !String(file).endsWith(`/${after}`)) return;
		armed = false;
		fs.renameSync(victim, `${victim}-original`);
		fs.symlinkSync(outside, victim);
	};
	const original = kind === "async" ? fs.promises.open : fs.openSync;
	if (kind === "async") {
		const open = fs.promises.open;
		Reflect.set(fs.promises, "open", async (...args: Parameters<typeof open>) => { const handle = await open(...args); swap(args[0]); return handle; });
	} else {
		const openSync = fs.openSync;
		Reflect.set(fs, "openSync", (...args: Parameters<typeof openSync>) => { const fd = openSync(...args); swap(args[0]); return fd; });
	}
	syncBuiltinESMExports();
	return {
		get fired() { return !armed; },
		restore() {
			if (kind === "async") Reflect.set(fs.promises, "open", original); else Reflect.set(fs, "openSync", original);
			syncBuiltinESMExports();
		},
	};
}

/**
 * Answer the stat of every identity path (`/proc/self/fd/…`, `/dev/fd/…`, `/.vol/…`) with `answer`, which
 * may call `real` for the kernel's answer. Every other path stats as usual.
 */
function stubIdentityStats(answer: (file: string, real: () => fs.BigIntStats) => fs.BigIntStats) {
	const statSync = fs.statSync;
	const stat = fs.promises.stat;
	const identity = (file: fs.PathLike) => /^\/(?:proc\/self\/fd|dev\/fd|\.vol)\//u.test(String(file));
	const real = (file: fs.PathLike) => () => statSync(file, { bigint: true });
	Reflect.set(fs, "statSync", (file: fs.PathLike, options?: fs.StatSyncOptions) => identity(file) ? answer(String(file), real(file)) : statSync(file, options));
	Reflect.set(fs.promises, "stat", async (file: fs.PathLike, options?: fs.StatOptions) => identity(file) ? answer(String(file), real(file)) : stat(file, options));
	syncBuiltinESMExports();
	return {
		restore() {
			Reflect.set(fs, "statSync", statSync);
			Reflect.set(fs.promises, "stat", stat);
			syncBuiltinESMExports();
		},
	};
}

/** Make every identity path that reaches one of `refused` stat as `decoy`, a different directory, so none verifies for it. */
function refuseIdentity(refused: readonly string[], decoy: string) {
	const held = refused.map((dir) => fs.statSync(dir, { bigint: true }));
	const other = fs.statSync(decoy, { bigint: true });
	return stubIdentityStats((_file, real) => {
		const reached = real();
		return held.some((dir) => dir.dev === reached.dev && dir.ino === reached.ino) ? other : reached;
	});
}

for (const { victim, up, after } of [{ victim: "parent", up: 1, after: "sessions" }, { victim: "grandparent", up: 2, after: "fold-parity" }]) {
	test(`#246 parity: the ${victim} swapped for a symlink after ${after} is opened cannot redirect a write or a read`, async () => {
		const { agentDir, outside, cleanup } = scratch();
		try {
			await appendParityRecord(agentDir, record("real"));
			const sessions = path.dirname(paritySessionFile(agentDir, "real"));
			const swapped = ancestor(sessions, up);
			// The outside tree mirrors the store, so a pathname lookup would find a sessions directory there.
			const below = path.relative(swapped, sessions);
			fs.mkdirSync(path.join(outside, below), { recursive: true });
			fs.writeFileSync(path.join(outside, below, "planted.jsonl"), `${JSON.stringify(record("planted"))}\n`);
			const before = snapshot(outside);
			const write = swapAfterOpen("async", after, swapped, outside);
			try { await appendParityRecord(agentDir, record("race")); } finally { write.restore(); }
			assert.ok(write.fired, "the swap ran between the check and the open");
			assert.deepEqual(snapshot(outside), before, "nothing is written outside the store");
			assert.deepEqual(fs.readdirSync(path.join(`${swapped}-original`, below)).sort(), ["race.jsonl", "real.jsonl"], "the write lands in the directory that was checked");
			// Read: the swapped-in tree holds a planted record; the checked tree holds the real records.
			fs.rmSync(swapped);
			fs.renameSync(`${swapped}-original`, swapped);
			const read = swapAfterOpen("async", after, swapped, outside);
			let records: readonly CompressRecord[] | undefined;
			try { records = (await readParityRecords(agentDir)) as CompressRecord[]; } finally { read.restore(); }
			assert.ok(read.fired);
			assert.deepEqual(records.map((item) => item.sessionId).sort(), ["race", "real"], "records outside the store are never read");
		} finally { cleanup(); }
	});
}

for (const { victim, up } of [{ victim: "store directory", up: 0 }, { victim: "parent", up: 1 }, { victim: "grandparent", up: 2 }]) {
	const metricsAfter = up === 2 ? "context-aware" : "v1";
	test(`#246 metrics: the ${victim} swapped for a symlink after ${metricsAfter} is opened cannot redirect an append or a trim`, async () => {
		const { agentDir, outside, cleanup } = scratch();
		try {
			for (const [i, id] of ["a", "b"].entries()) {
				await appendMetricsRecord(agentDir, buildMetricsRecord(metricsInput(1, id)), limits);
				fs.utimesSync(metricsSessionFile(agentDir, id), new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
			}
			const store = path.dirname(metricsSessionFile(agentDir, "a"));
			// Room for two session files and half a third: appending "d" must trim exactly the oldest, "a".
			const line = fs.statSync(metricsSessionFile(agentDir, "a")).size;
			const small = { maxBytes: 4096, maxDirBytes: Math.floor(line * 2.5) };
			const swapped = ancestor(store, up);
			// The outside tree mirrors the store, so a pathname lookup would find the same names there.
			const below = path.relative(swapped, store);
			const mirror = path.join(outside, below);
			fs.mkdirSync(mirror, { recursive: true });
			for (const id of ["a", "b"]) fs.copyFileSync(metricsSessionFile(agentDir, id), path.join(mirror, `${id}.jsonl`));
			for (const [i, id] of ["a", "b"].entries()) fs.utimesSync(path.join(mirror, `${id}.jsonl`), new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
			const before = snapshot(outside);
			const race = swapAfterOpen("async", metricsAfter, swapped, outside);
			try { await appendMetricsRecord(agentDir, buildMetricsRecord(metricsInput(1, "d")), small); } finally { race.restore(); }
			assert.ok(race.fired, "the swap ran between the check and the open");
			assert.deepEqual(snapshot(outside), before, "nothing outside the store is written or deleted");
			const left = fs.readdirSync(path.join(`${swapped}-original`, below)).sort();
			assert.ok(left.includes("d.jsonl"), "the append lands in the directory that was checked");
			assert.ok(!left.includes("a.jsonl"), "the trim removes the oldest file from the directory that was checked");
		} finally { cleanup(); }
	});

	const erasureAfter = up === 2 ? "fold-parity" : "sessions";
	test(`#246 erasure: the ${victim} swapped for a symlink after ${erasureAfter} is opened cannot redirect a delete`, () => {
		const { agentDir, outside, cleanup } = scratch();
		try {
			const file = paritySessionFile(agentDir, "old");
			const sessions = path.dirname(file);
			fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, "store\n", { mode: 0o600 });
			const swapped = ancestor(sessions, up);
			const below = path.relative(swapped, sessions);
			const mirror = path.join(outside, below);
			fs.mkdirSync(mirror, { recursive: true });
			fs.writeFileSync(path.join(mirror, "old.jsonl"), "OUTSIDE\n", { mode: 0o600 });
			const before = snapshot(outside);
			const race = swapAfterOpen("sync", erasureAfter, swapped, outside);
			try { removeStoreFile(agentDir, file); } finally { race.restore(); }
			assert.ok(race.fired, "the swap ran between the check and the delete");
			assert.deepEqual(snapshot(outside), before, "nothing outside the store is deleted");
			assert.deepEqual(fs.readdirSync(path.join(`${swapped}-original`, below)), [], "the delete lands in the directory that was checked");
		} finally { cleanup(); }
	});
}

for (const refused of ["agent directory", "store directory"] as const) {
	test(`#246 refusal: when no identity path verifies the ${refused}, parity, metrics and erasure refuse and touch nothing`, async () => {
		const { agentDir, outside, cleanup } = scratch();
		try {
			await appendParityRecord(agentDir, record("real"));
			await appendMetricsRecord(agentDir, buildMetricsRecord(metricsInput(1, "real")), limits);
			const parityStore = path.dirname(paritySessionFile(agentDir, "real"));
			const metricsStore = path.dirname(metricsSessionFile(agentDir, "real"));
			const stores = [path.join(agentDir, "fold-parity"), path.join(agentDir, "context-aware")];
			const before = stores.map(snapshot);
			const stub = refuseIdentity(refused === "agent directory" ? [agentDir] : [parityStore, metricsStore], outside);
			try {
				await assert.rejects(appendParityRecord(agentDir, record("real")), PARITY_REFUSAL, "the parity append refuses");
				await assert.rejects(readParityRecords(agentDir), PARITY_REFUSAL, "the parity read refuses");
				await assert.rejects(appendMetricsRecord(agentDir, buildMetricsRecord(metricsInput(2, "real")), limits), PARITY_REFUSAL, "the metrics append refuses");
				assert.throws(() => removeStoreFile(agentDir, paritySessionFile(agentDir, "real")), ERASURE_REFUSAL, "the held-directory delete refuses");
			} finally { stub.restore(); }
			assert.deepEqual(stores.map(snapshot), before, "nothing in the stores is written or deleted");
			assert.deepEqual(tree(outside), [], "nothing outside the stores is touched");
		} finally { cleanup(); }
	});
}

test("#246 refusal: the session listing refuses, and closes its descriptor, when that descriptor has no identity path", async () => {
	const { agentDir, outside, cleanup } = scratch();
	try {
		fs.mkdirSync(path.join(agentDir, "sessions"), { mode: 0o700 });
		const decoy = fs.statSync(outside, { bigint: true });
		const openSync = fs.openSync;
		let listing: number | undefined;
		// Only the descriptor the listing opens for itself (`<held>/.`) fails to verify; the walk to it verifies.
		Reflect.set(fs, "openSync", (...args: Parameters<typeof openSync>) => {
			const fd = openSync(...args);
			if (String(args[0]).endsWith("/.")) listing ??= fd;
			return fd;
		});
		const stub = stubIdentityStats((_file, real) => listing === undefined ? real() : decoy);
		try {
			await assert.rejects(discoverProfileSessions(agentDir), ERASURE_REFUSAL);
		} finally { stub.restore(); Reflect.set(fs, "openSync", openSync); }
		assert.notEqual(listing, undefined, "the listing opened its own descriptor");
		assert.throws(() => fs.fstatSync(listing ?? -1), { code: "EBADF" }, "the refused descriptor is closed");
	} finally { cleanup(); }
});

test("#246 platform: off macOS /.vol is never offered, so without /proc the parity store and the erasure delete refuse", async () => {
	const { agentDir, cleanup } = scratch();
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	try {
		const file = paritySessionFile(agentDir, "old");
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, "store\n", { mode: 0o600 });
		const store = path.join(agentDir, "fold-parity");
		const before = snapshot(store);
		Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
		assert.deepEqual(descriptorPathCandidates(3, { dev: 1n, ino: 2n }), ["/proc/self/fd/3", "/dev/fd/3", "/.vol/1/2"], "macOS offers /.vol");
		Object.defineProperty(process, "platform", { ...platform, value: "linux" });
		// No /proc or /dev/fd, and a /.vol/<dev>/<ino> that stats as the held directory, as a planted path would.
		const stub = stubIdentityStats((candidate) => {
			const vol = /^\/\.vol\/(\d+)\/(\d+)\/\.$/u.exec(candidate);
			if (!vol) throw Object.assign(new Error(`ENOENT: ${candidate}`), { code: "ENOENT" });
			return { dev: BigInt(vol[1] ?? 0), ino: BigInt(vol[2] ?? 0) } as fs.BigIntStats;
		});
		try {
			assert.deepEqual(descriptorPathCandidates(3, { dev: 1n, ino: 2n }), ["/proc/self/fd/3", "/dev/fd/3"], "only macOS offers /.vol");
			await assert.rejects(appendParityRecord(agentDir, record("new")), PARITY_REFUSAL, "the parity append refuses");
			assert.throws(() => removeStoreFile(agentDir, file), ERASURE_REFUSAL, "the held-directory delete refuses");
		} finally { stub.restore(); }
		assert.deepEqual(snapshot(store), before, "nothing in the store is written or deleted");
	} finally {
		Object.defineProperty(process, "platform", platform);
		cleanup();
	}
});
