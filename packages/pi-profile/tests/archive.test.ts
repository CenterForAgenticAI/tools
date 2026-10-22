import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { archiveSessions, keepLocalDaysFor, loadManifest, parseArchive, restoreSession, type ArchiveSettings } from "../src/core/archive.ts";
import { processToolRunner, type ToolRunner } from "../src/core/backup.ts";
import { readStub } from "../src/core/sessionfile.ts";
import { rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";
import { piSession } from "./sessionfixture.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 21);
let s: Sandbox;
let store: string;
let root: string;
let settings: ArchiveSettings;

beforeEach(() => {
	s = sandbox();
	store = join(s.home, "agent", "sessions");
	root = join(s.home, "volume", "archive");
	mkdirSync(store, { recursive: true });
	mkdirSync(root, { recursive: true });
	settings = { store: { kind: "local", path: root }, olderThanDays: 30, keepLocalDays: 0 };
});
afterEach(() => s.cleanup());

/** A session file last changed ageDays before NOW. */
function session(rel: string, ageDays: number, id = rel.replace(/\W/g, ""), cwd = "/nowhere/proj"): string {
	const path = join(store, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, piSession({ id, cwd, name: "name " + id, prompts: ["first " + id, "last " + id], t0: NOW - ageDays * DAY }));
	const t = (NOW - ageDays * DAY) / 1000;
	utimesSync(path, t, t);
	return path;
}

/** Every file below dir with its bytes and mtime, and with folders, each folder's mtime: a dry run must leave this unchanged. */
function snapshot(dir: string, folders = false): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	if (folders) out["./"] = String(lstatSync(dir).mtimeMs);
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			// A folder's time changes when a name is added or removed in it, even
			// for a file that is gone again (a lock taken and released).
			if (e.isDirectory()) {
				if (folders) out[relative(dir, p) + "/"] = String(lstatSync(p).mtimeMs);
				walk(p);
			} else out[relative(dir, p)] = readFileSync(p, "base64") + "@" + String(lstatSync(p).mtimeMs);
		}
	};
	walk(dir);
	return out;
}

const run = (opts: Partial<Parameters<typeof archiveSessions>[3]> = {}) =>
	archiveSessions(s.l, store, settings, { host: "box", apply: true, now: NOW, run: processToolRunner, ...opts });

describe("archive settings", () => {
	it("copies known fields and refuses the rest", () => {
		assert.deepEqual(parseArchive({ store: { kind: "ssh", host: "backup-box", identity: "/k/id_archive" }, olderThanDays: 45 }), { store: { kind: "ssh", host: "backup-box", identity: "/k/id_archive" }, olderThanDays: 45 });
		for (const bad of [
			{ store: { kind: "local", path: "rel/path" } },
			{ store: { kind: "ssh", host: "-oProxyCommand=x" } },
			{ store: { kind: "ssh", host: "h", identity: "/a b" } },
			{ store: { kind: "local", path: "/a" }, olderThanDays: 0 },
			{ store: { kind: "local", path: "/a" }, keepLocalDays: -1 },
			{ store: { kind: "local", path: "/a" }, extra: 1 },
		]) assert.throws(() => parseArchive(bad), { name: "Refusal" }, JSON.stringify(bad));
	});
	it("keeps the local copy 60 more days on macOS and none elsewhere, unless set", () => {
		const base = parseArchive({ store: { kind: "local", path: "/a" } });
		assert.equal(base.olderThanDays, 30);
		assert.equal(keepLocalDaysFor(base, "darwin"), 60);
		assert.equal(keepLocalDaysFor(base, "linux"), 0);
		assert.equal(keepLocalDaysFor({ ...base, keepLocalDays: 7 }, "darwin"), 7);
	});
});

describe("sessions archive", { skip: rsyncSkip }, () => {
	it("a dry run lists what would move and the bytes it frees, and changes nothing", () => {
		const old = session("--p--/old.jsonl", 40);
		session("--p--/young.jsonl", 5);
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		const before = { store: snapshot(store, true), root: snapshot(root, true), state: snapshot(join(s.home, "pi-profile"), true) };
		const r = run({ apply: false });
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--p--/old.jsonl", "stub"]], "with no keep period, --apply replaces it by a stub");
		assert.equal(r.freed, statSync(old).size);
		assert.deepEqual({ store: snapshot(store, true), root: snapshot(root, true), state: snapshot(join(s.home, "pi-profile"), true) }, before);
	});

	it("replaces an old session with a stub Pi still lists, and keeps a verified compressed copy", async () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		const mtime = statSync(path).mtimeMs;
		const r = run();
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--p--/old.jsonl", "stub"]]);
		const stub = readStub(readFileSync(path, "utf8"));
		assert.ok(stub !== undefined && !stub.grown);
		assert.equal(statSync(path).mtimeMs, mtime, "the stub keeps the session's time, so pi -c does not pick it");
		const copy = join(root, "box", stub.details.archive);
		assert.ok(zstdDecompressSync(readFileSync(copy)).equals(original));
		const listed = await SessionManager.list("/nowhere/proj", join(store, "--p--"));
		assert.deepEqual(listed.map((x) => [x.id, x.name, x.firstMessage]), [["abc", "name abc", "first abc"]]);
		const entry = loadManifest(store).sessions["--p--/old.jsonl"];
		assert.equal(entry?.id, "abc");
		assert.equal(entry?.firstPrompt, "first abc");
		assert.equal(entry?.lastPrompt, "last abc");
		assert.equal(entry?.folder, "/nowhere/proj");
		assert.equal(entry?.archive, stub.details.archive);
		assert.ok(entry?.stubbedAt !== undefined && entry.archivedAt !== undefined);
		assert.equal(entry?.summary, undefined, "summary is reserved and never written");
	});

	it("records the forge key and the path inside the repository", () => {
		const repo = join(s.home, "code", "proj");
		mkdirSync(join(repo, "sub"), { recursive: true });
		spawnSync("git", ["init", "-q", repo]);
		spawnSync("git", ["-C", repo, "remote", "add", "origin", "git@forge.example.com:team/proj.git"]);
		session("--q--/a.jsonl", 40, "a", join(repo, "sub"));
		run();
		const entry = loadManifest(store).sessions["--q--/a.jsonl"];
		assert.equal(entry?.forgeKey, "forge.example.com/team/proj");
		assert.equal(entry?.repoPath, "sub");
	});

	it("leaves locked, recently changed and young sessions in place", () => {
		const locked = session("--p--/locked.jsonl", 40);
		writeFileSync(locked + ".pi-daemon.lock", "{}");
		const recent = session("--p--/recent.jsonl", 40);
		utimesSync(recent, NOW / 1000, NOW / 1000);
		const young = session("--p--/young.jsonl", 29);
		const before = snapshot(store);
		const r = run();
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--p--/locked.jsonl", "skip"]]);
		assert.deepEqual(snapshot(store), before);
		for (const p of [locked, recent, young]) assert.equal(readStub(readFileSync(p, "utf8")), undefined);
	});

	it("keeps the full local copy for keepLocalDays, then replaces it after verifying the copy again", () => {
		settings = { ...settings, keepLocalDays: 60 };
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		assert.deepEqual(run().outcomes.map((o) => o.kind), ["archive"]);
		assert.ok(readFileSync(path).equals(original), "the local copy is kept");
		assert.ok(loadManifest(store).sessions["--p--/old.jsonl"]?.archivedAt !== undefined);
		assert.deepEqual(run({ now: NOW + 30 * DAY }).outcomes.map((o) => o.kind), [], "still inside the keep period");
		let fetched = 0;
		const counting: ToolRunner = (c, a, o) => {
			if (c === "rsync" && a.some((x) => x.startsWith("--files-from")) && a.at(-1)?.includes("verify")) fetched++;
			return processToolRunner(c, a, o);
		};
		assert.deepEqual(run({ now: NOW + 61 * DAY, run: counting }).outcomes.map((o) => o.kind), ["stub"]);
		assert.equal(fetched, 1, "the copy is read back from the archive before the local copy goes");
		assert.ok(readStub(readFileSync(path, "utf8")) !== undefined);
	});

	it("never removes a session whose copy does not verify on the archive", () => {
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		// The archive accepts the upload and hands back damaged bytes.
		const damaging: ToolRunner = (c, a, o) => {
			const res = processToolRunner(c, a, o);
			const dest = a.at(-1) ?? "";
			if (c === "rsync" && dest.includes("verify")) for (const f of readdirSync(dest, { recursive: true, encoding: "utf8" })) if (f.endsWith(".zst")) writeFileSync(join(dest, f), "garbage");
			return res;
		};
		const r = run({ run: damaging });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["fail"]);
		assert.ok(readFileSync(path).equals(original));
		assert.equal(loadManifest(store).sessions["--p--/old.jsonl"], undefined);
	});

	it("never removes a session when the upload did not arrive", () => {
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		const dropping: ToolRunner = (c, a, o) => (c === "rsync" && !(a.at(-1) ?? "").includes("verify") ? { status: 0, stdout: "", stderr: "" } : processToolRunner(c, a, o));
		const r = run({ run: dropping });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["fail"]);
		assert.ok(readFileSync(path).equals(original));
	});

	it("keeps the full session when Pi writes to it just before the stub would replace it", () => {
		const path = session("--p--/old.jsonl", 40);
		const r = run({ hooks: { beforeStub: () => appendFileSync(path, "{\"type\":\"message\"}\n") } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["skip"]);
		assert.equal(readStub(readFileSync(path, "utf8")), undefined);
		assert.match(readFileSync(path, "utf8"), /"type":"message"}\n$/);
	});

	it("puts the full session back when Pi writes to it while the stub takes its name", () => {
		const path = session("--p--/old.jsonl", 40);
		const r = run({ hooks: { afterAside: () => appendFileSync(path, "{\"type\":\"late\"}\n") } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["skip"]);
		assert.equal(readStub(readFileSync(path, "utf8")), undefined);
		assert.match(readFileSync(path, "utf8"), /"type":"late"}\n$/);
		assert.deepEqual(readdirSync(join(store, "--p--")), ["old.jsonl"]);
	});

	it("keeps a line Pi adds to the stub while the full session is being put back", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const late = JSON.stringify({ type: "message", id: "late", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "late", timestamp: 1 } }) + "\n";
		const later = JSON.stringify({ type: "message", id: "later", parentId: null, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: "later", timestamp: 2 } }) + "\n";
		const r = run({ hooks: { afterAside: () => appendFileSync(path, late), beforePutBack: () => appendFileSync(path, later) } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["skip"]);
		assert.match(readFileSync(path, "utf8"), /"id":"late".*\n$/, "the full session is back with its own new line");
		const folder = join(store, "--p--");
		const kept = readdirSync(folder).filter((n) => n !== "old.jsonl");
		assert.equal(kept.length, 1, "the stub Pi wrote to is kept beside it: " + JSON.stringify(readdirSync(folder)));
		const copy = readFileSync(join(folder, kept[0] ?? ""), "utf8");
		assert.ok(copy.endsWith(later), "the line written to the stub survives");
		assert.equal(readStub(copy)?.grown, true);
		assert.match(kept[0] ?? "", /^old\.kept-[0-9a-f]{16}\.jsonl$/);
	});

	it("archives when the folder it was started in has been removed", () => {
		const path = session("--p--/old.jsonl", 40);
		const here = process.cwd();
		const gone = join(s.home, "gone");
		mkdirSync(gone);
		process.chdir(gone);
		rmdirSync(gone);
		try {
			assert.deepEqual(run().outcomes.map((o) => o.kind), ["stub"]);
		} finally {
			process.chdir(here);
		}
		assert.ok(readStub(readFileSync(path, "utf8")) !== undefined);
	});

	it("names the rsync step that failed and how many files it carried, and keeps the sessions", () => {
		session("--p--/a.jsonl", 40, "a");
		session("--p--/b.jsonl", 40, "b");
		const before = snapshot(store);
		const code3 = "rsync: [Receiver] getcwd(): No such file or directory (2)\nrsync error: errors selecting input/output files, dirs (code 3) at util1.c(1144) [Receiver=3.4.1]\n";
		const failing = (when: (args: readonly string[]) => boolean): ToolRunner => (c, a, o) => (c === "rsync" && when(a) ? { status: 3, stdout: "", stderr: code3 } : processToolRunner(c, a, o));
		const label = join(root, "box");
		assert.throws(() => run({ run: failing((a) => a.includes("--ignore-existing")) }), (e: Error) => e.message === "rsync failed during the upload of 2 files to " + label + ": rsync error: errors selecting input/output files, dirs (code 3) at util1.c(1144) [Receiver=3.4.1]");
		assert.deepEqual(snapshot(store), before);
		assert.throws(() => run({ run: failing((a) => a.includes("--ignore-missing-args")) }), (e: Error) => e.message.startsWith("rsync failed during the read-back of 2 files from " + label + ": rsync error:"));
		assert.deepEqual(snapshot(store), before);
	});

	it("loses nothing when killed part-way, and the next run finishes", () => {
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		assert.throws(() => run({ hooks: { afterVerify: () => { throw new Error("killed"); } } }), /killed/);
		assert.ok(readFileSync(path).equals(original));
		assert.throws(() => run({ hooks: { afterAside: () => { throw new Error("killed"); } } }), /killed/);
		assert.deepEqual([...new Set(run().outcomes.map((o) => o.kind))].sort(), ["recover", "stub"]);
		const stub = readStub(readFileSync(path, "utf8"));
		assert.ok(stub !== undefined);
		assert.deepEqual(readdirSync(join(store, "--p--")), ["old.jsonl"]);
	});

	it("asks rsync to fsync each archive copy before it is read back", () => {
		session("--p--/old.jsonl", 40);
		const seen: string[][] = [];
		run({ run: (c, a, o) => { seen.push([c, ...a]); return processToolRunner(c, a, o); } });
		const put = seen.filter((x) => x[0] === "rsync" && x.includes("--ignore-existing"));
		assert.equal(put.length, 1);
		assert.ok(put[0]?.includes("--fsync"), JSON.stringify(put[0]));
	});

	it("names a local rsync too old for --fsync, and keeps the session", () => {
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		const old: ToolRunner = (c, a, o) => {
			if (c !== "rsync") return processToolRunner(c, a, o);
			if (a[0] === "--version") return { status: 0, stdout: "rsync  version 3.2.3  protocol version 31\n", stderr: "" };
			return a.includes("--fsync") ? { status: 1, stdout: "", stderr: "rsync: --fsync: unknown option\n" } : processToolRunner(c, a, o);
		};
		assert.throws(() => run({ run: old }), /the rsync on PATH is version 3\.2\.3; the archive needs rsync 3\.2\.4 or later for --fsync/);
		assert.ok(readFileSync(path).equals(original));
	});

	it("fsyncs the stub and the restored file before either takes the session's name", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const events: string[] = [];
		const tmps = new Map<number, string>();
		const { openSync, fsyncSync, closeSync } = fs;
		const spies = [
			mock.method(fs, "openSync", (p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
				const fd = openSync(p, flags, mode);
				if (String(p).endsWith(".tmp") && String(p).includes(".pi-profile-archive-")) {
					tmps.set(fd, String(p));
					events.push("open " + String(fd));
				}
				return fd;
			}),
			mock.method(fs, "fsyncSync", (fd: number) => {
				if (tmps.has(fd)) events.push("fsync " + String(fd));
				return fsyncSync(fd);
			}),
			mock.method(fs, "closeSync", (fd: number) => {
				if (tmps.has(fd)) {
					events.push("close " + String(fd));
					tmps.delete(fd);
				}
				return closeSync(fd);
			}),
		];
		syncBuiltinESMExports();
		try {
			assert.deepEqual(run().outcomes.map((o) => o.kind), ["stub"]);
			assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, now: NOW + DAY }).kind, "restored");
		} finally {
			for (const spy of spies) spy.mock.restore();
			syncBuiltinESMExports();
		}
		const opened = events.filter((e) => e.startsWith("open "));
		assert.equal(opened.length, 2, "one temporary stub, one temporary restored file: " + JSON.stringify(events));
		for (const e of opened) {
			const fd = e.slice("open ".length);
			const synced = events.indexOf("fsync " + fd, events.indexOf(e));
			assert.ok(synced > 0 && synced < events.indexOf("close " + fd, events.indexOf(e)), "fd " + fd + " is fsynced before it is closed: " + JSON.stringify(events));
		}
	});

	it("never archives a stub grown past 1 MiB as a new session; the original stays reachable", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run();
		const entry = loadManifest(store).sessions["--p--/old.jsonl"];
		assert.ok(entry?.stubbedAt !== undefined);
		appendFileSync(path, JSON.stringify({ type: "message", id: "big", parentId: null, timestamp: "2026-10-22T00:00:00.000Z", message: { role: "user", content: "x".repeat(1_100_000), timestamp: 1 } }) + "\n");
		const t = (NOW - 35 * DAY) / 1000;
		utimesSync(path, t, t);
		const grown = readFileSync(path);
		assert.ok(grown.length > 1 << 20);
		const dry = run({ apply: false, now: NOW + DAY });
		assert.deepEqual([dry.outcomes.map((o) => [o.rel, o.kind]), dry.freed], [[], 0], "the dry run leaves the grown stub alone, as --apply does");
		assert.deepEqual(run({ now: NOW + DAY }).outcomes.map((o) => [o.rel, o.kind]), []);
		assert.ok(readFileSync(path).equals(grown), "the grown stub is untouched");
		assert.deepEqual(loadManifest(store).sessions["--p--/old.jsonl"], entry, "the manifest still leads to the original");
		assert.equal(readdirSync(join(root, "box", "--p--")).length, 1, "no second archive copy");
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner });
		assert.equal(r.kind, "kept-both");
		assert.ok(readFileSync(path).equals(grown));
		assert.ok(r.full !== undefined && readFileSync(r.full).equals(original));
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner }).full, r.full, "a second restore finds the same copy");
	});

	it("on a Mac, a dry run past the keep period lists the stub and the bytes it frees, as --apply does", () => {
		settings = { store: settings.store, olderThanDays: 30 };
		const mac = { platform: "darwin" };
		const path = session("--p--/old.jsonl", 40);
		const size = statSync(path).size;
		assert.deepEqual(run(mac).outcomes.map((o) => o.kind), ["archive"], "inside the 60-day keep period");
		session("--p--/other.jsonl", 40);
		const sorted = (r: ReturnType<typeof run>): string[][] => r.outcomes.map((o) => [o.rel, o.kind]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
		const dry = run({ ...mac, apply: false, now: NOW + 61 * DAY });
		assert.deepEqual(sorted(dry), [["--p--/old.jsonl", "stub"], ["--p--/other.jsonl", "archive"]]);
		assert.equal(dry.freed, size);
		const done = run({ ...mac, now: NOW + 61 * DAY });
		assert.deepEqual(sorted(done), sorted(dry));
		assert.equal(done.freed, dry.freed);
	});

	it("drops the full copy an interrupted swap left aside once its stub is in place, and keeps one that does not match", () => {
		const path = session("--p--/old.jsonl", 40);
		assert.throws(() => run({ hooks: { afterSwap: () => { throw new Error("killed"); } } }), /killed/);
		assert.equal(readdirSync(join(store, "--p--")).length, 2, "the stub and the full copy under its aside name");
		assert.deepEqual(run({ now: NOW + DAY }).outcomes.map((o) => o.kind), ["recover"]);
		assert.deepEqual(readdirSync(join(store, "--p--")), ["old.jsonl"]);
		assert.ok(readStub(readFileSync(path, "utf8")) !== undefined);
		const other = session("--p--/b.jsonl", 40, "b");
		assert.throws(() => run({ hooks: { afterSwap: () => { throw new Error("killed"); } } }), /killed/);
		const aside = readdirSync(join(store, "--p--")).find((n) => n.startsWith(".b.jsonl"));
		appendFileSync(join(store, "--p--", aside ?? ""), "{}\n");
		run({ now: NOW + DAY });
		const kept = readdirSync(join(store, "--p--")).filter((n) => n.startsWith("b.kept-"));
		assert.equal(kept.length, 1, "a full copy that is not the archived one is kept: " + JSON.stringify(readdirSync(join(store, "--p--"))));
		assert.ok(readStub(readFileSync(other, "utf8")) !== undefined);
	});

	it("removes the unused stub a killed put-back left under its second name, and keeps one Pi wrote to or that names another copy", () => {
		const late = JSON.stringify({ type: "message", id: "late", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "late", timestamp: 1 } }) + "\n";
		const folder = join(store, "--p--");
		/** Archive name, append to it while the stub takes its name, and kill the run just after the full session is put back. */
		const killAfterPutBack = (name: string): string => {
			const path = session("--p--/" + name, 40, name.replace(/\W/g, ""));
			const { renameSync } = fs;
			let armed = false;
			const spy = mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
				renameSync(from, to);
				if (armed) {
					armed = false;
					throw new Error("killed");
				}
			});
			syncBuiltinESMExports();
			try {
				assert.throws(() => run({ hooks: { afterAside: () => appendFileSync(path, late), beforePutBack: () => { armed = true; } } }), /killed/);
			} finally {
				spy.mock.restore();
				syncBuiltinESMExports();
			}
			const second = readdirSync(folder).filter((n) => n.startsWith("." + name));
			assert.equal(second.length, 1, JSON.stringify(readdirSync(folder)));
			const stub = readStub(readFileSync(join(folder, second[0] ?? ""), "utf8"));
			assert.equal(stub?.grown, false, "the stub that was placed is under its second name");
			return join(folder, second[0] ?? "");
		};
		killAfterPutBack("old.jsonl");
		assert.deepEqual(run({ now: NOW + DAY }).outcomes.map((o) => o.kind), ["recover"]);
		assert.deepEqual(readdirSync(folder), ["old.jsonl"], "nothing to keep: the stub holds no line");
		assert.match(readFileSync(join(folder, "old.jsonl"), "utf8"), /"id":"late".*\n$/, "the full session is at its name");
		// Pi wrote to the stub before the kill: its line is kept.
		appendFileSync(killAfterPutBack("grown.jsonl"), late.replace("\"late\"", "\"on-stub\""));
		run({ now: NOW + DAY });
		const grown = readdirSync(folder).filter((n) => n.startsWith("grown.kept-"));
		assert.equal(grown.length, 1, "a stub Pi wrote to is kept: " + JSON.stringify(readdirSync(folder)));
		assert.match(readFileSync(join(folder, grown[0] ?? ""), "utf8"), /"id":"on-stub".*\n$/);
		// A line put before the notice leaves the notice and the end of the file as placed: its bytes differ, so it is kept.
		const before = killAfterPutBack("before.jsonl");
		const lines = readFileSync(before, "utf8").split("\n");
		writeFileSync(before, [lines[0], late.replace("\"late\"", "\"before-notice\"").trimEnd(), ...lines.slice(1)].join("\n"));
		assert.equal(readStub(readFileSync(before, "utf8"))?.grown, false, "the notice still ends the file");
		run({ now: NOW + DAY });
		const kept = readdirSync(folder).filter((n) => n.startsWith("before.kept-"));
		assert.equal(kept.length, 1, "a stub with a line before its notice is kept: " + JSON.stringify(readdirSync(folder)));
		assert.match(readFileSync(join(folder, kept[0] ?? ""), "utf8"), /"id":"before-notice"/);
		// A stub that does not name the copy the archive list records is not the one placed: kept.
		killAfterPutBack("other.jsonl");
		const list = join(store, ".pi-profile-archive.json");
		const m = JSON.parse(readFileSync(list, "utf8")) as { sessions: Record<string, { sha256: string }> };
		const entry = m.sessions["--p--/other.jsonl"];
		assert.ok(entry !== undefined);
		writeFileSync(list, JSON.stringify({ ...m, sessions: { ...m.sessions, "--p--/other.jsonl": { ...entry, sha256: "0".repeat(64) } } }));
		run({ now: NOW + DAY });
		assert.equal(readdirSync(folder).filter((n) => n.startsWith("other.kept-")).length, 1, "a stub of another copy is kept: " + JSON.stringify(readdirSync(folder)));
		// The name was given another file after the kill: the unused stub holds no line, so it goes as an uninterrupted run would have removed it.
		killAfterPutBack("moved.jsonl");
		writeFileSync(join(folder, "moved.jsonl"), "{}\n");
		run({ now: NOW + DAY });
		assert.deepEqual(readdirSync(folder).filter((n) => n.startsWith("moved") || n.startsWith(".moved")), ["moved.jsonl"]);
		assert.equal(readFileSync(join(folder, "moved.jsonl"), "utf8"), "{}\n", "the file at the name is left alone");
	});

	it("keeps the session when a lock appears just before the stub would replace it", () => {
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		const r = run({ hooks: { beforeStub: () => writeFileSync(path + ".pi-daemon.lock", "{}") } });
		assert.deepEqual(r.outcomes.map((o) => [o.kind, o.reason]), [["skip", "a lock appeared beside it; the archive copy is kept, the session too"]]);
		assert.ok(readFileSync(path).equals(original));
	});

	it("a dry run skips a file that is no Pi session, as --apply does", () => {
		const odd = join(store, "--p--", "notes.jsonl");
		mkdirSync(join(store, "--p--"), { recursive: true });
		writeFileSync(odd, "{\"not\":\"a session\"}\n");
		utimesSync(odd, (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
		session("--p--/old.jsonl", 40);
		const dry = run({ apply: false });
		const done = run();
		const view = (r: ReturnType<typeof run>) => [r.outcomes.map((o) => [o.rel, o.kind, o.reason]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), r.freed];
		assert.deepEqual(view(dry), view(done));
		assert.deepEqual(dry.outcomes.find((o) => o.rel === "--p--/notes.jsonl")?.kind, "skip");
	});

	it("skips a session whose name the archive cannot carry, and archives the rest", () => {
		const odd = session("--p--/odd\u0001.jsonl", 40);
		const ok = session("--p--/ok.jsonl", 40);
		const before = readFileSync(odd);
		const r = run();
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]).sort(), [["--p--/odd\u0001.jsonl", "skip"], ["--p--/ok.jsonl", "stub"]]);
		assert.ok(readFileSync(odd).equals(before));
		assert.ok(readStub(readFileSync(ok, "utf8")) !== undefined);
	});

	it("removes scratch folders a killed run left, and keeps a recent one", () => {
		const root = join(s.home, "pi-profile", "state", "archive");
		mkdirSync(join(root, "run-old", "up"), { recursive: true });
		writeFileSync(join(root, "run-old", "up", "x.zst"), "left");
		mkdirSync(join(root, "run-new"), { recursive: true });
		const t = (Date.now() - 2 * DAY) / 1000;
		utimesSync(join(root, "run-old"), t, t);
		session("--p--/old.jsonl", 40);
		run();
		assert.deepEqual(readdirSync(root).sort(), ["run-new"]);
	});

	it("refuses an archive folder that is not there (a volume that is not mounted)", () => {
		session("--p--/old.jsonl", 40);
		settings = { ...settings, store: { kind: "local", path: join(s.home, "unmounted") } };
		const before = snapshot(store);
		assert.throws(() => run(), /does not exist/);
		assert.deepEqual(snapshot(store), before);
	});
});

describe("sessions restore", { skip: rsyncSkip }, () => {
	it("restores the session byte for byte, with its time", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		const mtime = statSync(path).mtimeMs;
		run();
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, now: NOW + DAY });
		assert.equal(r.kind, "restored");
		assert.ok(readFileSync(path).equals(original));
		assert.equal(statSync(path).mtimeMs, mtime);
		assert.ok(loadManifest(store).sessions["--p--/old.jsonl"]?.restoredAt !== undefined);
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner }).kind, "not-archived");
	});

	it("never overwrites a stub Pi has added lines to: both copies are kept", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run();
		appendFileSync(path, JSON.stringify({ type: "message", id: "n", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "new", timestamp: 1 } }) + "\n");
		const grown = readFileSync(path);
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner });
		assert.equal(r.kind, "kept-both");
		assert.ok(readFileSync(path).equals(grown), "the grown stub is untouched");
		assert.ok(r.full !== undefined && readFileSync(r.full).equals(original));
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner }).full, r.full, "a second restore finds the same copy");
	});

	it("does not stub a restored session again until it has been left alone for olderThanDays", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run();
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, now: NOW + DAY }).kind, "restored");
		assert.deepEqual(run({ now: NOW + 2 * DAY }).outcomes.map((o) => [o.rel, o.kind]), []);
		assert.ok(readFileSync(path).equals(original), "the restored session stays in full");
		assert.deepEqual(run({ now: NOW + 30 * DAY }).outcomes.map((o) => [o.rel, o.kind]), [], "29 days after the restore");
		assert.deepEqual(run({ now: NOW + 32 * DAY }).outcomes.map((o) => [o.rel, o.kind]), [["--p--/old.jsonl", "stub"]], "then it is archived like any other session");
	});

	it("on a Mac, a restored session gets a fresh keep period", () => {
		settings = { store: settings.store, olderThanDays: 30 };
		const mac = { platform: "darwin" };
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run(mac);
		assert.deepEqual(run({ ...mac, now: NOW + 61 * DAY }).outcomes.map((o) => o.kind), ["stub"]);
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, now: NOW + 62 * DAY }).kind, "restored");
		assert.deepEqual(run({ ...mac, now: NOW + 63 * DAY }).outcomes.map((o) => o.kind), []);
		assert.deepEqual(run({ ...mac, now: NOW + 93 * DAY }).outcomes.map((o) => o.kind), ["archive"], "archived again, the local copy kept");
		assert.ok(readFileSync(path).equals(original));
		assert.deepEqual(run({ ...mac, apply: false, now: NOW + 100 * DAY }).outcomes.map((o) => o.kind), [], "inside the new keep period");
		assert.deepEqual(run({ ...mac, now: NOW + 155 * DAY }).outcomes.map((o) => o.kind), ["stub"]);
	});

	it("never archives the full copy kept beside a grown stub", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		run();
		appendFileSync(path, JSON.stringify({ type: "message", id: "n", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "new", timestamp: 1 } }) + "\n");
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, now: NOW + DAY });
		assert.equal(r.kind, "kept-both");
		const kept = readFileSync(r.full ?? "");
		assert.deepEqual(run({ now: NOW + 2 * DAY }).outcomes.map((o) => [o.rel, o.kind]), []);
		assert.ok(readFileSync(r.full ?? "").equals(kept));
		assert.deepEqual(Object.values(loadManifest(store).sessions).map((e) => e.id), ["abc"], "one manifest entry per session id");
	});

	it("reports, not throws, when the archive list cannot be updated after the session is back", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run();
		writeFileSync(join(store, ".pi-profile-archive.json"), "{ not json");
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner });
		assert.equal(r.kind, "restored");
		assert.match(r.warning ?? "", /restored, but the archive list could not be updated/);
		assert.ok(readFileSync(path).equals(original));
	});

	it("keeps both when Pi writes to the stub while the full session takes its name", () => {
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		run();
		const line = JSON.stringify({ type: "message", id: "late", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "late", timestamp: 1 } }) + "\n";
		const r = restoreSession(s.l, path, settings, { host: "box", run: processToolRunner, hooks: { afterAside: () => appendFileSync(path, line) } });
		assert.equal(r.kind, "kept-both");
		assert.equal(readStub(readFileSync(path, "utf8"))?.grown, true, "the stub with the new line stays");
		assert.ok(r.full !== undefined && readFileSync(r.full).equals(original));
	});

	it("refuses a stub archived by another host", () => {
		const path = session("--p--/old.jsonl", 40);
		run();
		assert.throws(() => restoreSession(s.l, path, settings, { host: "other", run: processToolRunner }), { name: "Refusal" });
	});
});

const rrsyncs = ["/usr/local/bin/rrsync", "/usr/bin/rrsync", "/opt/homebrew/bin/rrsync"].filter((p) => existsSync(p));
/** The README's forced command needs rrsync -no-overwrite (rsync 3.3.0 and later); Debian 12's /usr/bin/rrsync (3.2.7) has none. */
const rrsync = rrsyncs.find((p) => spawnSync(p, ["-help"], { encoding: "utf8" }).stdout.includes("-no-overwrite"));
// Where rsync is required (this project's CI), a missing or too old rrsync fails the test rather than skipping it.
const rrsyncSkip = rsyncSkip || (rrsync === undefined && process.env.PI_PROFILE_REQUIRE_RSYNC !== "1" ? "no rrsync with -no-overwrite (rsync 3.3.0 or later) is installed" : false);

/** An ssh stand-in that runs forced as the README's authorized_keys line does: the command sshd would run goes to SSH_ORIGINAL_COMMAND. */
function forcedSsh(forced: readonly string[]): ToolRunner {
	const fake = join(s.home, "fake-ssh.cjs");
	writeFileSync(fake, [
		"#!/usr/bin/env node",
		"const { spawnSync } = require('node:child_process');",
		"const a = process.argv.slice(2); let i = 0;",
		"while (i < a.length && a[i].startsWith('-')) i += ['-o', '-i', '-p'].includes(a[i]) ? 2 : 1;",
		"const r = spawnSync(" + JSON.stringify(forced[0]) + ", " + JSON.stringify(forced.slice(1)) + ", { stdio: 'inherit', env: { ...process.env, SSH_ORIGINAL_COMMAND: a.slice(i + 1).join(' ') } });",
		"process.exit(r.status ?? 1);",
	].join("\n"));
	chmodSync(fake, 0o755);
	return (c, a, o) => processToolRunner(c, a.map((x) => (x.startsWith("ssh ") ? fake + x.slice(3) : x)), o);
}

describe("an ssh archive behind a key forced to rrsync", { skip: rrsyncSkip }, () => {
	it("archives into the restricted folder and restores from it", () => {
		assert.ok(rrsync !== undefined, "no rrsync with -no-overwrite among " + JSON.stringify(rrsyncs) + "; install the rrsync of rsync 3.3.0 or later");
		const remote = join(s.home, "remote-archive", "box");
		mkdirSync(remote, { recursive: true });
		const viaFake = forcedSsh([rrsync, "-munge", "-no-del", "-no-overwrite", remote]);
		settings = { ...settings, store: { kind: "ssh", host: "archive-host", identity: "/keys/id_archive" } };
		const path = session("--p--/old.jsonl", 40, "abc");
		const original = readFileSync(path);
		const seen: string[][] = [];
		const r = run({ run: (c, a, o) => { seen.push([c, ...a]); return viaFake(c, a, o); } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["stub"]);
		assert.ok(seen.some((x) => x.some((y) => y.includes("-i /keys/id_archive -o IdentitiesOnly=yes"))));
		assert.ok(readdirSync(remote, { recursive: true, encoding: "utf8" }).some((f) => f.endsWith(".jsonl.zst")));
		assert.equal(restoreSession(s.l, path, settings, { host: "box", run: viaFake }).kind, "restored");
		assert.ok(readFileSync(path).equals(original));
	});
});

describe("an ssh archive whose rrsync is older than 3.3.0", { skip: rsyncSkip }, () => {
	it("names the old rrsync and keeps the session", () => {
		// The rrsync of rsync 3.2.7 stops at its argument parser with exactly this line and exit 1, before rsync starts.
		const old = join(s.home, "old-rrsync.sh");
		writeFileSync(old, "#!/bin/sh\necho '/usr/bin/rrsync error: unrecognized arguments: -no-overwrite' >&2\nexit 1\n");
		chmodSync(old, 0o755);
		settings = { ...settings, store: { kind: "ssh", host: "archive-host" } };
		const path = session("--p--/old.jsonl", 40);
		const original = readFileSync(path);
		assert.throws(() => run({ run: forcedSsh([old, "-no-del", "-no-overwrite", "/srv/archive/box"]) }), /the rrsync on archive-host has no -no-overwrite option; it needs the rrsync of rsync 3\.3\.0 or later/);
		assert.ok(readFileSync(path).equals(original), "the session is not replaced by a stub");
		assert.equal(loadManifest(store).sessions["--p--/old.jsonl"], undefined);
	});
});
