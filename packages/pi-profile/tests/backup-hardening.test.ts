// Backup hardening: a store changed during a run (issues 17, 18,
// #19) and the config lock seen from `backup remove` (#20).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { addReplica, backupStateDir, birthOf, loadReplicaState, processToolRunner, removeReplica, runBackup, type Fstat, type ToolResult, type ToolRunner } from "../src/core/backup.ts";
import { configPath, loadConfig } from "../src/core/config.ts";
import { LOCK_FILE } from "../src/core/lock.ts";
import { Refusal } from "../src/core/result.ts";
import { addStore } from "../src/core/sessions.ts";
import { captureIo, rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });
const AGE = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const OTHER_AGE = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj";
const hasRsync = rsyncSkip === false;
const hasMkfifo = spawnSync("mkfifo", ["--version"]).status === 0;

/** A store at `root` (default `<home>/store`) with sessions f1/x.jsonl and f2/y.jsonl. */
function store(root = join(s.home, "store")): string {
	mkdirSync(join(root, "f1"), { recursive: true });
	mkdirSync(join(root, "f2"), { recursive: true });
	writeFileSync(join(root, "f1", "x.jsonl"), '{"inside":1}\n');
	writeFileSync(join(root, "f2", "y.jsonl"), '{"y":1}\n');
	addStore(s.l, "main", root, env());
	return root;
}

/** A folder outside the store holding a session-shaped file with the same name. */
function outside(): string {
	const other = join(s.home, "other");
	mkdirSync(other);
	writeFileSync(join(other, "x.jsonl"), "OUTSIDE SECRET\n");
	return other;
}

function files(root: string, base = root): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(root, e.name), base) : [join(root, e.name).slice(base.length + 1)])).sort();
}

function contents(root: string): string {
	return files(root).map((f) => readFileSync(join(root, f), "utf8")).join("");
}

function localReplica(name = "usb"): string {
	const usb = join(s.home, name);
	mkdirSync(usb);
	addReplica(s.l, { id: name, kind: "local", path: usb }, env());
	return usb;
}

/** The real rsync, with `before` run once at the first call that matches. */
function realRsyncWith(before: () => void, when: (args: readonly string[]) => boolean): ToolRunner {
	let done = false;
	return (cmd, args, o) => {
		if (!done && when(args)) {
			done = true;
			before();
		}
		return processToolRunner(cmd, args, o);
	};
}
const shm = "/dev/shm";
const crossDevice = existsSync(shm) && statSync(shm).dev !== statSync(tmpdir()).dev;
const skeleton = (args: readonly string[]): boolean => args.includes("--omit-dir-times");
const sessionList = (args: readonly string[]): boolean => args.some((a) => a.startsWith("--files-from="));

describe("#17: a plain replica gets only the files the scan saw", { skip: hasRsync ? false : "rsync is not installed" }, () => {
	it("a session folder swapped for a link after the scan sends nothing from outside the store", () => {
		const root = store();
		const other = outside();
		const usb = localReplica();
		// The skeleton rsync runs after the scan and before the sessions are staged.
		const swap = (): void => {
			renameSync(join(root, "f1"), join(root, "f1.bak"));
			symlinkSync(other, join(root, "f1"));
		};
		const r = runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton) });
		assert.deepEqual(r, [{ id: "usb", ok: true, mode: "rsync", files: 1, bytes: 8, encrypted: false, held: [] }]);
		assert.deepEqual(files(usb), ["hosts/box/host.json", "hosts/box/sessions/f2/y.jsonl"]);
		assert.doesNotMatch(contents(usb), /OUTSIDE SECRET/);
	});

	it("a folder swapped for a link while rsync starts still sends the scanned file, not the outside one", () => {
		const root = store();
		const other = outside();
		const usb = localReplica();
		const swap = (): void => {
			renameSync(join(root, "f1"), join(root, "f1.bak"));
			symlinkSync(other, join(root, "f1"));
		};
		const r = runBackup(s.l, { env: env(), runner: realRsyncWith(swap, sessionList) });
		assert.equal(r[0]?.ok === true && r[0].files, 2);
		assert.equal(readFileSync(join(usb, "hosts/box/sessions/f1/x.jsonl"), "utf8"), '{"inside":1}\n');
		assert.doesNotMatch(contents(usb), /OUTSIDE SECRET/);
	});

	it("a session swapped for a link to an outside file is not sent, and the store keeps its files", () => {
		const root = store();
		const other = outside();
		const usb = localReplica();
		const swap = (): void => {
			rmSync(join(root, "f1", "x.jsonl"));
			symlinkSync(join(other, "x.jsonl"), join(root, "f1", "x.jsonl"));
		};
		const r = runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton) });
		assert.equal(r[0]?.ok === true && r[0].files, 1);
		assert.doesNotMatch(contents(usb), /OUTSIDE SECRET/);
		assert.equal(readFileSync(join(root, "f2", "y.jsonl"), "utf8"), '{"y":1}\n', "removing the staged tree leaves the store alone");
		assert.equal(readFileSync(join(other, "x.jsonl"), "utf8"), "OUTSIDE SECRET\n");
	});

	it("on another file system, copies each checked session with its mtime and still refuses a swapped folder", { skip: crossDevice ? false : "no second file system at /dev/shm" }, () => {
		const storeDir = mkdtempSync(join(shm, "pi-profile-test-store-"));
		try {
			const root = store(join(storeDir, "store"));
			const other = outside();
			const usb = localReplica();
			const old = new Date("2026-01-02T03:04:05Z");
			utimesSync(join(root, "f2", "y.jsonl"), old, old);
			const swap = (): void => {
				renameSync(join(root, "f1"), join(root, "f1.bak"));
				symlinkSync(other, join(root, "f1"));
			};
			const r = runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton) });
			assert.equal(r[0]?.ok === true && r[0].files, 1);
			assert.doesNotMatch(contents(usb), /OUTSIDE SECRET/);
			const sent = join(usb, "hosts/box/sessions/f2/y.jsonl");
			assert.equal(statSync(sent).mtimeMs, old.getTime(), "the copy keeps the session's mtime");
			// A growing session is appended to, as with a hard link.
			writeFileSync(join(root, "f2", "y.jsonl"), '{"y":1}\n{"y":2}\n');
			assert.equal(runBackup(s.l, { env: env() })[0]?.ok, true);
			assert.equal(readFileSync(sent, "utf8"), '{"y":1}\n{"y":2}\n');
		} finally {
			rmSync(storeDir, { recursive: true, force: true });
		}
	});
});

const ok = (): ToolResult => ({ status: 0, stdout: "", stderr: "" });

describe("review of #17: leftover scratch folders and the copy on another file system", () => {
	it("the next run removes the scratch folder of a killed run, and leaves a link named like one alone", { timeout: 15_000 }, () => {
		const root = store();
		localReplica();
		const backup = pathToFileURL(join(import.meta.dirname, "..", "src", "core", "backup.ts")).href;
		// The run is killed while sending, after it staged its hard links: no cleanup runs.
		const script = `
			import { runBackup } from ${JSON.stringify(backup)};
			const runner = (cmd, args) => {
				if (args.some((a) => a.startsWith("--files-from="))) process.kill(process.pid, "SIGKILL");
				return { status: 0, stdout: "", stderr: "" };
			};
			runBackup({ piHome: ${JSON.stringify(s.home)} }, { env: ${JSON.stringify(env())}, runner });
		`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		const state = backupStateDir(s.l);
		const left = readdirSync(state).filter((n) => /^usb\.run-/.test(n));
		assert.equal(left.length, 1, "the killed run left its scratch folder");
		const x = join(root, "f1", "x.jsonl");
		assert.equal(statSync(x).nlink, 2, "the leftover folder holds a hard link to the session");
		// Decoys: a link named like a run folder, a near-miss name, and another replica's folder.
		const other = outside();
		symlinkSync(other, join(state, "usb.run-Ab12Cd"));
		mkdirSync(join(state, "usb.run-short"));
		mkdirSync(join(state, "web.run-Ab12Cd"));
		const r = runBackup(s.l, { env: env(), runner: () => ok() });
		assert.equal(r[0]?.ok, true);
		assert.equal(existsSync(join(state, left[0] ?? "")), false, "the leftover folder is removed");
		assert.equal(statSync(x).nlink, 1);
		assert.equal(lstatSync(join(state, "usb.run-Ab12Cd")).isSymbolicLink(), true, "the link is left alone");
		assert.equal(readFileSync(join(other, "x.jsonl"), "utf8"), "OUTSIDE SECRET\n", "the link is not followed");
		assert.deepEqual(readdirSync(state).sort(), ["usb.json", "usb.run-Ab12Cd", "usb.run-short", "web.run-Ab12Cd"]);
	});

	it("backup remove also removes the replica's leftover scratch folders", () => {
		store();
		localReplica();
		const state = backupStateDir(s.l);
		mkdirSync(join(state, "usb.run-Zz9Yy8", "send-0", "f1"), { recursive: true });
		writeFileSync(join(state, "usb.run-Zz9Yy8", "send-0", "f1", "x.jsonl"), "{}\n");
		removeReplica(s.l, "usb", env());
		assert.deepEqual(readdirSync(state), []);
	});

	it("on another file system, the scratch folder never holds more than one batch of copies", { skip: hasRsync && crossDevice ? false : "rsync or a second file system at /dev/shm is missing" }, () => {
		const storeDir = mkdtempSync(join(shm, "pi-profile-test-store-"));
		try {
			const root = store(join(storeDir, "store"));
			mkdirSync(join(root, "f3"));
			writeFileSync(join(root, "f3", "z.jsonl"), "{}");
			const usb = localReplica();
			const state = backupStateDir(s.l);
			// What the whole state directory holds each time a session list is sent.
			const seen: string[][] = [];
			const runner: ToolRunner = (cmd, args, o) => {
				if (sessionList(args)) seen.push(files(state).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/^usb\.run-[^/]+\/send-\d+\//, "")));
				return processToolRunner(cmd, args, o);
			};
			// Sizes 13, 8 and 2 bytes: x alone, then y and z together.
			const r = runBackup(s.l, { env: env(), runner, batchBytes: 10 });
			assert.deepEqual(r, [{ id: "usb", ok: true, mode: "rsync", files: 3, bytes: 23, encrypted: false, held: [] }]);
			assert.deepEqual(seen, [["f1/x.jsonl"], ["f2/y.jsonl", "f3/z.jsonl"]]);
			assert.deepEqual(files(join(usb, "hosts/box/sessions")), ["f1/x.jsonl", "f2/y.jsonl", "f3/z.jsonl"]);
			assert.deepEqual(readdirSync(state), ["usb.json"]);
		} finally {
			rmSync(storeDir, { recursive: true, force: true });
		}
	});
});

/** Fake rsync (whole trees only), age and aws over the local filesystem; `before` runs once, at the first call. */
function fakeTools(before: () => void = () => undefined): ToolRunner {
	let done = false;
	return (cmd, args, run) => {
		if (!done) {
			done = true;
			before();
		}
		if (cmd === "age") {
			const out = args[args.indexOf("-o") + 1] ?? "";
			writeFileSync(out, `AGE[${readFileSync(run?.stdin ?? -1, "utf8")}]`);
			return ok();
		}
		const [from = "", to = ""] = args.slice(args.indexOf("--") + 1);
		const dest = cmd === "aws" ? join(s.home, "s3", args[args.length - 1]?.slice("s3://".length) ?? "") : to;
		const src = cmd === "aws" ? (args[args.length - 2] ?? "") : from;
		mkdirSync(dest, { recursive: true });
		cpSync(src, dest, { recursive: true });
		return ok();
	};
}

describe("#18: shrink protection survives a mid-run swap and a recipient change", () => {
	it("a session swapped between the scan and the open keeps its mark, so a smaller replacement is held back", () => {
		const root = store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb, encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools() });
		const sent = join(usb, "hosts/box/sessions/f1/x.jsonl.age");
		assert.equal(readFileSync(sent, "utf8"), 'AGE[{"inside":1}\n]');
		const x = join(root, "f1", "x.jsonl");
		// The session grows, so the next run sends it; then, after the scan, a smaller file is renamed over it.
		writeFileSync(x, '{"inside":1}\n{"inside":2}\n');
		utimesSync(x, new Date(), new Date(Date.now() + 5000));
		const swap = (): void => {
			writeFileSync(`${x}.tmp`, "{}\n");
			renameSync(`${x}.tmp`, x);
		};
		const second = runBackup(s.l, { env: env(), runner: fakeTools(swap) })[0];
		assert.deepEqual(second?.ok === true && [second.files, second.held], [0, []]);
		assert.equal(loadReplicaState(s.l, "usb").files?.["f1/x.jsonl"]?.size, 13, "the previous mark is kept");
		const third = runBackup(s.l, { env: env(), runner: fakeTools() })[0];
		assert.deepEqual(third?.ok === true && [third.files, third.held], [0, ["f1/x.jsonl"]]);
		assert.equal(readFileSync(sent, "utf8"), 'AGE[{"inside":1}\n]', "the good copy is kept");
	});

	it("after the recipients change, every session is sent again except one that shrank", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools() });
		const x = join(root, "f1", "x.jsonl");
		truncateSync(x, 0);
		utimesSync(x, new Date(), new Date(Date.now() + 5000));
		const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as { replicas: Array<{ encrypt: unknown }> };
		(cfg.replicas[0] as { encrypt: unknown }).encrypt = { recipients: [OTHER_AGE] };
		writeFileSync(configPath(s.l), JSON.stringify(cfg));
		const r = runBackup(s.l, { env: env(), runner: fakeTools() })[0];
		assert.deepEqual(r?.ok === true && [r.files, r.held], [1, ["f1/x.jsonl"]]);
		assert.equal(readFileSync(join(s.home, "s3/bucket/hosts/box/sessions/f1/x.jsonl.age"), "utf8"), 'AGE[{"inside":1}\n]', "the good copy is kept");
		// The held session is still not marked as sent for the new recipients.
		assert.equal(loadReplicaState(s.l, "cloud").files?.["f1/x.jsonl"], undefined);
		assert.equal(loadReplicaState(s.l, "cloud").sizes?.["f1/x.jsonl"], 13);
	});

	it("after the target changes, a session that shrank is sent to the new target", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://old", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools() });
		const x = join(root, "f1", "x.jsonl");
		writeFileSync(x, "{}\n");
		utimesSync(x, new Date(), new Date(Date.now() + 5000));
		const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as { replicas: Array<{ uri: string }> };
		(cfg.replicas[0] as { uri: string }).uri = "s3://new";
		writeFileSync(configPath(s.l), JSON.stringify(cfg));
		const r = runBackup(s.l, { env: env(), runner: fakeTools() })[0];
		assert.deepEqual(r?.ok === true && [r.files, r.held], [2, []]);
		assert.equal(readFileSync(join(s.home, "s3/new/hosts/box/sessions/f1/x.jsonl.age"), "utf8"), "AGE[{}\n]");
		assert.equal(readFileSync(join(s.home, "s3/old/hosts/box/sessions/f1/x.jsonl.age"), "utf8"), 'AGE[{"inside":1}\n]', "the old target is not touched");
		assert.equal(loadReplicaState(s.l, "cloud").sizes?.["f1/x.jsonl"], 3);
	});

	/** Rewrite the replica's state as an older version saved it: no `sizes`, no `target`. */
	function toOldState(id: string): void {
		const path = join(s.home, "pi-profile", "state", "backup", `${id}.json`);
		const old = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		delete old.sizes;
		delete old.target;
		writeFileSync(path, JSON.stringify(old));
	}

	it("reads the sent sizes from state saved before sizes were kept, under the same fingerprint", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools() });
		toOldState("cloud");
		truncateSync(join(root, "f1", "x.jsonl"), 0);
		const r = runBackup(s.l, { env: env(), runner: fakeTools() })[0];
		assert.deepEqual(r?.ok === true && r.held, ["f1/x.jsonl"]);
	});

	for (const full of [false, true]) {
		it(`state saved before the target was kept, then the target changes: a session that shrank is sent to the new target${full ? " (--full)" : ""}`, () => {
			const root = store();
			addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://old", encrypt: { recipients: [AGE] } }, env());
			runBackup(s.l, { env: env(), runner: fakeTools() });
			toOldState("cloud");
			const x = join(root, "f1", "x.jsonl");
			writeFileSync(x, "{}\n");
			utimesSync(x, new Date(), new Date(Date.now() + 5000));
			const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as { replicas: Array<{ uri: string }> };
			(cfg.replicas[0] as { uri: string }).uri = "s3://new";
			writeFileSync(configPath(s.l), JSON.stringify(cfg));
			const r = runBackup(s.l, { env: env(), runner: fakeTools(), full })[0];
			assert.deepEqual(r?.ok === true && [r.files, r.held], [2, []]);
			assert.equal(readFileSync(join(s.home, "s3/new/hosts/box/sessions/f1/x.jsonl.age"), "utf8"), "AGE[{}\n]");
			assert.equal(loadReplicaState(s.l, "cloud").sizes?.["f1/x.jsonl"], 3);
		});
	}
});

describe("#19: a FIFO swapped in after the scan is skipped without hanging", { skip: hasRsync && hasMkfifo ? false : "rsync or mkfifo is not installed" }, () => {
	it("both the rsync stage and the staged upload skip it", { timeout: 15_000 }, () => {
		const root = store();
		const usb = localReplica();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: false }, env());
		// A blocking open would stall this process, so the run is a child with a deadline.
		const backup = pathToFileURL(join(import.meta.dirname, "..", "src", "core", "backup.ts")).href;
		const script = `
			import { rmSync } from "node:fs";
			import { spawnSync } from "node:child_process";
			import { processToolRunner, runBackup } from ${JSON.stringify(backup)};
			const x = ${JSON.stringify(join(root, "f1", "x.jsonl"))};
			let swapped = false;
			const runner = (cmd, args, o) => {
				if (!swapped) {
					swapped = true;
					rmSync(x);
					if (spawnSync("mkfifo", [x]).status !== 0) throw new Error("mkfifo failed");
				}
				return cmd === "aws" ? { status: 0, stdout: "", stderr: "" } : processToolRunner(cmd, args, o);
			};
			const results = runBackup({ piHome: ${JSON.stringify(s.home)} }, { env: ${JSON.stringify(env())}, runner });
			process.stdout.write(JSON.stringify(results));
		`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
		assert.equal(child.signal, null, "the run finished before its deadline");
		assert.equal(child.status, 0, child.stderr);
		const results = JSON.parse(child.stdout) as Array<{ id: string; ok: boolean; files: number }>;
		assert.deepEqual(results.map((r) => [r.id, r.ok, r.files]), [["usb", true, 1], ["cloud", true, 1]]);
		assert.deepEqual(files(join(usb, "hosts/box/sessions")), ["f2/y.jsonl"]);
	});
});

describe("#20: backup remove reports a busy config lock as itself", () => {
	it("says the config is being changed, not that a backup run is in progress", () => {
		store();
		addReplica(s.l, { id: "usb", kind: "local", path: join(s.home, "usb") }, env());
		// A live process that is not this one holds the config lock.
		writeFileSync(join(s.home, "pi-profile", LOCK_FILE), `${String(process.ppid)} abc\n`);
		const configBusy = (e: unknown): boolean =>
			e instanceof Refusal && /pi-profile is being changed by process \d+; try again when it finishes/.test(e.message) && !/backup run/.test(e.message);
		assert.throws(() => removeReplica(s.l, "usb", env()), configBusy);
		const io = captureIo(env());
		assert.equal(main(["backup", "remove", "usb"], io), 2);
		assert.match(io.stderr, /pi-profile is being changed by process \d+/);
		assert.doesNotMatch(io.stderr, /another backup run is in progress/);
		assert.equal(loadConfig(s.l, env()).replicas?.length, 1);
	});

	it("still reports a busy backup lock as a run in progress, with or without a pid", () => {
		store();
		addReplica(s.l, { id: "usb", kind: "local", path: join(s.home, "usb") }, env());
		const lock = join(s.home, "pi-profile", "state", "backup", LOCK_FILE);
		mkdirSync(join(lock, ".."), { recursive: true });
		// A stale lock that another live process is breaking: no holder pid to report.
		writeFileSync(lock, "2147483646 dead\n");
		writeFileSync(`${lock}.break`, `${String(process.ppid)} C\n`);
		assert.throws(() => removeReplica(s.l, "usb", env()), (e) => e instanceof Refusal && e.message === "another backup run is in progress; try again when it finishes");
	});
});

/** Stats like `st` with `change` applied: what fstat reports for a file that reuses a scanned inode. */
function statsLike(st: Stats, change: Partial<Record<"size" | "mtimeMs" | "birthtimeMs", number>>): Stats {
	return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, change);
}

/**
 * After the scan, f1/x.jsonl is deleted and a new file takes its name. The
 * fstat seam reports the scanned dev, inode and stats for the new file, with
 * `change` applied, as if the file system had reused the old inode.
 */
function reusedInode(root: string, change: Parameters<typeof statsLike>[1]): { swap: () => void; fstat: Fstat } {
	const x = join(root, "f1", "x.jsonl");
	let old: Stats | undefined;
	let neu: Stats | undefined;
	return {
		swap: () => {
			old = lstatSync(x);
			rmSync(x);
			writeFileSync(x, "REPLACED SECRET\n");
			neu = lstatSync(x);
		},
		fstat: (fd) => {
			const st = fstatSync(fd);
			return old !== undefined && neu !== undefined && st.dev === neu.dev && st.ino === neu.ino ? statsLike(old, change) : st;
		},
	};
}

/** Bump f1/x.jsonl's ctime past its birth time, so the scan sees a birth time; false if the platform reports none. */
function reportsBirth(root: string): boolean {
	const x = join(root, "f1", "x.jsonl");
	for (const end = Date.now() + 500; Date.now() < end; ) {
		if (birthOf(lstatSync(x)) !== 0) return true;
		utimesSync(x, new Date(), new Date());
	}
	return false;
}

describe("#25: a replaced session that reuses the scanned inode is not staged under the old name", { skip: hasRsync ? false : "rsync is not installed" }, () => {
	const sendsOnlyY = (r: ReturnType<typeof runBackup>, usb: string): void => {
		assert.deepEqual(r, [{ id: "usb", ok: true, mode: "rsync", files: 1, bytes: 8, encrypted: false, held: [] }]);
		assert.deepEqual(files(usb), ["hosts/box/host.json", "hosts/box/sessions/f2/y.jsonl"]);
		assert.doesNotMatch(contents(usb), /REPLACED/);
	};

	it("the seam is sound: with every scanned field the same, the new file cannot be told apart", () => {
		const root = store();
		const usb = localReplica();
		const { swap, fstat } = reusedInode(root, {});
		const r = runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton), fstat });
		assert.equal(r[0]?.ok === true && r[0].files, 2);
		assert.match(contents(usb), /REPLACED/);
	});

	it("a different size is not staged", () => {
		const root = store();
		const usb = localReplica();
		const { swap, fstat } = reusedInode(root, { size: 16 });
		sendsOnlyY(runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton), fstat }), usb);
	});

	it("a different mtime is not staged", () => {
		const root = store();
		const usb = localReplica();
		const { swap, fstat } = reusedInode(root, { mtimeMs: Date.now() + 5000 });
		sendsOnlyY(runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton), fstat }), usb);
	});

	it("a different birth time is not staged, where the platform reports one", (t) => {
		const root = store();
		if (!reportsBirth(root)) {
			t.skip("no birth time on this file system");
			return;
		}
		const usb = localReplica();
		const { swap, fstat } = reusedInode(root, { birthtimeMs: Date.now() + 5000 });
		sendsOnlyY(runBackup(s.l, { env: env(), runner: realRsyncWith(swap, skeleton), fstat }), usb);
	});

	it("a staged replica skips it too, and keeps no mark for it", () => {
		const root = store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb, encrypt: { recipients: [AGE] } }, env());
		const { swap, fstat } = reusedInode(root, { size: 16 });
		const r = runBackup(s.l, { env: env(), runner: fakeTools(swap), fstat })[0];
		assert.deepEqual(r?.ok === true && [r.files, r.held], [1, []]);
		assert.deepEqual(files(usb), ["hosts/box/host.json", "hosts/box/sessions/f2/y.jsonl.age"]);
		assert.equal(loadReplicaState(s.l, "usb").files?.["f1/x.jsonl"], undefined);
	});

	it("a birth time equal to the change time is not trusted: libuv reports ctime there when the platform has none", () => {
		assert.equal(birthOf({ birthtimeMs: 0, ctimeMs: 5 }), 0);
		assert.equal(birthOf({ birthtimeMs: 5, ctimeMs: 5 }), 0);
		assert.equal(birthOf({ birthtimeMs: 4, ctimeMs: 5 }), 4);
	});
});
