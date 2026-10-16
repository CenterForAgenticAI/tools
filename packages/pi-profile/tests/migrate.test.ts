import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { main } from "../src/cli/main.ts";
import { migrateSessions, RECENT_MS } from "../src/core/migrate.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
let from: string;
let to: string;
/** A clock far enough ahead that every test file counts as closed. */
const later = () => Date.now() + 2 * RECENT_MS;

beforeEach(() => {
	s = sandbox();
	from = join(s.home, "agent", "sessions");
	to = join(s.home, "store");
	mkdirSync(from, { recursive: true });
	mkdirSync(to);
});
afterEach(() => {
	s.cleanup();
});

function put(root: string, rel: string, text: string): string {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, { mode: 0o600 });
	return path;
}
function tree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (rel: string): void => {
		for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
			const child = rel === "" ? e.name : join(rel, e.name);
			if (e.isDirectory()) walk(child);
			else out[child] = readFileSync(join(root, child), "utf8");
		}
	};
	walk("");
	return out;
}
/** Outcomes as [rel, kind, reason], in path order. */
function sorted(outcomes: readonly { rel: string; kind: string; reason?: string | undefined }[]): (string | undefined)[][] {
	return outcomes.map((o) => [o.rel, o.kind, o.reason]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
function cli(...args: string[]) {
	const io = captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "test-host" });
	return Object.assign(io, { code: main(args, io) });
}

describe("sessions migrate", () => {
	it("changes nothing in a dry run", () => {
		put(from, "--home-a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: false, now: later() });
		assert.equal(r.applied, false);
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--home-a--/1.jsonl", "move"]]);
		assert.deepEqual(tree(from), { "--home-a--/1.jsonl": "one\n" });
		assert.deepEqual(tree(to), {});
	});

	it("moves every file with its bytes, mode and time, then removes emptied folders", () => {
		const big = "x".repeat(3 * 1024 * 1024 + 7);
		put(from, "--home-a--/1.jsonl", "one\n");
		const b = put(from, "--home-b--/sub/2.jsonl", big);
		utimesSync(b, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["move", "move"]);
		assert.deepEqual(tree(to), { "--home-a--/1.jsonl": "one\n", "--home-b--/sub/2.jsonl": big });
		assert.deepEqual(readdirSync(from), []);
		const st = statSync(join(to, "--home-b--/sub/2.jsonl"));
		assert.equal(st.mode & 0o777, 0o600);
		assert.equal(st.mtime.toISOString(), "2026-01-02T00:00:00.000Z");
	});

	it("leaves recent files, lock files, links and its own lock behind", () => {
		put(from, "--a--/open.jsonl", "live\n");
		put(from, "--a--/old.jsonl.pi-daemon.lock", "{}");
		symlinkSync("/etc/hostname", join(from, "--a--", "link.jsonl"));
		const r = migrateSessions(from, to, { apply: true, now: Date.now() });
		assert.deepEqual(Object.fromEntries(r.outcomes.map((o) => [o.rel, o.kind])), {
			"--a--/open.jsonl": "skip",
			"--a--/old.jsonl.pi-daemon.lock": "skip",
			"--a--/link.jsonl": "skip",
		});
		assert.equal(readFileSync(join(from, "--a--/open.jsonl"), "utf8"), "live\n");
		assert.deepEqual(tree(to), {});
		assert.equal(existsSync(join(from, ".pi-profile.lock")), false);
	});

	it("never moves auth.json or an auth.json.bak-* backup: they are secret paths (L8)", () => {
		put(from, "--a--/1.jsonl", "one");
		put(from, "--a--/auth.json", "{}");
		put(from, "--a--/auth.json.bak-20260101-000000-aaaaaaaaaaaa", "{}");
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(Object.fromEntries(r.outcomes.map((o) => [o.rel, o.kind])), { "--a--/1.jsonl": "move", "--a--/auth.json": "skip", "--a--/auth.json.bak-20260101-000000-aaaaaaaaaaaa": "skip" });
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one" });
	});

	it("keeps both files on a conflict and removes an identical source", () => {
		put(from, "--a--/same.jsonl", "same\n");
		put(to, "--a--/same.jsonl", "same\n");
		put(from, "--a--/diff.jsonl", "mine\n");
		put(to, "--a--/diff.jsonl", "theirs\n");
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(Object.fromEntries(r.outcomes.map((o) => [o.rel, o.kind])), { "--a--/same.jsonl": "duplicate", "--a--/diff.jsonl": "conflict" });
		assert.deepEqual(tree(from), { "--a--/diff.jsonl": "mine\n" });
		assert.deepEqual(tree(to), { "--a--/same.jsonl": "same\n", "--a--/diff.jsonl": "theirs\n" });
	});

	it("keeps the source when interrupted mid-copy, and finishes on the next run", () => {
		put(from, "--a--/1.jsonl", "one\n");
		assert.throws(() =>
			migrateSessions(from, to, {
				apply: true,
				now: later(),
				hooks: {
					afterCopy: () => {
						// Simulate a crash: leave a temp file the way a killed process would.
						put(to, "--a--/.1.jsonl.pi-profile-migrate-dead.tmp", "o");
						throw Object.assign(new Error("killed"), { fatal: true });
					},
				},
			}).outcomes.forEach((o) => {
				if (o.kind === "fail") throw new Error(o.reason);
			}),
		);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n" });
		assert.deepEqual(tree(to), { "--a--/.1.jsonl.pi-profile-migrate-dead.tmp": "o" });
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.equal(r.tempsRemoved, 1);
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["move"]);
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one\n" });
		assert.deepEqual(tree(from), {});
	});

	it("keeps both copies when interrupted after placing, and removes the source on the next run", () => {
		put(from, "--a--/1.jsonl", "one\n");
		const first = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeRemove: () => { throw new Error("killed"); } } });
		assert.deepEqual(first.outcomes.map((o) => o.kind), ["fail"]);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n" });
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one\n" });
		const second = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(second.outcomes.map((o) => o.kind), ["duplicate"]);
		assert.deepEqual(tree(from), {});
	});

	it("never removes a source whose identical copy changed after the scan", () => {
		put(from, "--a--/1.jsonl", "one\n");
		put(to, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterScan: () => { put(to, "--a--/1.jsonl", "eno\n"); } } });
		assert.deepEqual(r.outcomes.map((o) => [o.kind, o.reason]), [["conflict", "the copy at the destination is no longer the file that was checked; the source is kept"]]);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n" });
	});

	it("never removes a source that changed during the copy", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterCopy: () => appendFileSync(src, "two\n") } });
		assert.equal(r.outcomes[0]?.kind, "skip");
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\ntwo\n" });
		assert.deepEqual(tree(to), {});
	});

	it("never removes a source that changed after the copy was placed", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeRemove: () => appendFileSync(src, "two\n") } });
		assert.equal(r.outcomes[0]?.kind, "conflict");
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\ntwo\n" });
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one\n" });
	});

	it("never overwrites a file that appears at the destination during the copy", () => {
		put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterCopy: () => { put(to, "--a--/1.jsonl", "theirs\n"); } } });
		assert.equal(r.outcomes[0]?.kind, "conflict");
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n" });
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "theirs\n" });
	});

	it("leaves a session that has a lock file beside it, however old", () => {
		put(from, "--a--/held.jsonl", "live\n");
		put(from, "--a--/held.jsonl.pi-daemon.lock", "{}");
		put(from, "--a--/free.jsonl", "done\n");
		const dry = migrateSessions(from, to, { apply: false, now: later() });
		assert.equal(dry.outcomes.find((o) => o.rel === "--a--/held.jsonl")?.kind, "skip");
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(Object.fromEntries(r.outcomes.map((o) => [o.rel, o.kind])), {
			"--a--/held.jsonl": "skip",
			"--a--/held.jsonl.pi-daemon.lock": "skip",
			"--a--/free.jsonl": "move",
		});
		assert.match(r.outcomes.find((o) => o.rel === "--a--/held.jsonl")?.reason ?? "", /lock file beside it/);
		assert.deepEqual(tree(from), { "--a--/held.jsonl": "live\n", "--a--/held.jsonl.pi-daemon.lock": "{}" });
		assert.deepEqual(tree(to), { "--a--/free.jsonl": "done\n" });
	});

	it("does not copy a session whose lock appears after the scan", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterScan: () => { put(from, "--a--/1.jsonl.pi-daemon.lock", "{}"); } } });
		assert.equal(r.outcomes[0]?.kind, "skip");
		assert.equal(readFileSync(src, "utf8"), "one\n");
		assert.deepEqual(tree(to), {});
	});

	it("keeps the source when a lock appears after the copy is placed", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeRemove: () => { put(from, "--a--/1.jsonl.pi-daemon.lock", "{}"); } } });
		assert.equal(r.outcomes[0]?.kind, "skip");
		assert.equal(readFileSync(src, "utf8"), "one\n");
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one\n" });
	});

	it("never deletes a source reached through a destination folder that links back into it", () => {
		put(from, "--a--/1.jsonl", "only copy\n");
		symlinkSync(join(from, "--a--"), join(to, "--a--"));
		for (const apply of [false, true]) {
			const r = migrateSessions(from, to, { apply, now: later() });
			assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--a--/1.jsonl", "conflict"]]);
			assert.match(r.outcomes[0]?.reason ?? "", /leads outside the destination/);
			assert.equal(readFileSync(join(from, "--a--/1.jsonl"), "utf8"), "only copy\n");
		}
	});

	it("never writes through a destination folder that links outside the destination", () => {
		const elsewhere = join(s.home, "elsewhere");
		mkdirSync(elsewhere);
		put(from, "--a--/sub/1.jsonl", "one\n");
		symlinkSync(elsewhere, join(to, "--a--"));
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.deepEqual(readdirSync(elsewhere), []);
		assert.deepEqual(tree(from), { "--a--/sub/1.jsonl": "one\n" });
	});

	it("creates nothing outside the destination when a folder there becomes a link during the run", () => {
		const elsewhere = join(s.home, "elsewhere");
		mkdirSync(elsewhere);
		put(from, "--a--/sub/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterScan: () => { symlinkSync(elsewhere, join(to, "--a--")); } } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.deepEqual(readdirSync(elsewhere), []);
		assert.deepEqual(tree(from), { "--a--/sub/1.jsonl": "one\n" });
	});

	it("keeps an identical source when its destination folder becomes a link elsewhere during the run", () => {
		const elsewhere = join(s.home, "elsewhere");
		put(from, "--a--/1.jsonl", "one\n");
		put(to, "--a--/1.jsonl", "one\n");
		put(elsewhere, "1.jsonl", "one\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: { afterScan: () => { rmSync(join(to, "--a--"), { recursive: true }); symlinkSync(elsewhere, join(to, "--a--")); } },
		});
		assert.equal(r.outcomes[0]?.kind, "conflict");
		assert.equal(readFileSync(join(from, "--a--/1.jsonl"), "utf8"), "one\n");
	});

	it("treats a destination that is the same file as the source as a conflict", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		mkdirSync(join(to, "--a--"));
		linkSync(src, join(to, "--a--/1.jsonl"));
		const r = migrateSessions(from, to, { apply: false, now: later() });
		assert.deepEqual(r.outcomes.map((o) => [o.kind, o.reason]), [["conflict", "the destination is the same file as the source"]]);
	});

	it("keeps an identical source whose copy is replaced by the source itself during the run", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		put(to, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: { afterScan: () => { rmSync(join(to, "--a--/1.jsonl")); linkSync(src, join(to, "--a--/1.jsonl")); } },
		});
		assert.equal(r.outcomes[0]?.kind, "conflict");
		assert.equal(readFileSync(src, "utf8"), "one\n");
	});

	it("keeps the source when a destination folder is swapped for a link during the run", () => {
		put(from, "--a--/1.jsonl", "only copy\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: { afterScan: () => { symlinkSync(join(from, "--a--"), join(to, "--a--")); } },
		});
		assert.equal(r.outcomes[0]?.kind, "conflict");
		assert.equal(readFileSync(join(from, "--a--/1.jsonl"), "utf8"), "only copy\n");
	});

	it("keeps the source when its placed copy is swapped for a link to the source", () => {
		const src = put(from, "--a--/1.jsonl", "only copy\n");
		const dst = join(to, "--a--/1.jsonl");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeRemove: () => { rmSync(dst); symlinkSync(src, dst); } } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.equal(readFileSync(src, "utf8"), "only copy\n");
	});

	it("keeps an identical source when its copy is swapped for a link to the source during the run", () => {
		const src = put(from, "--a--/1.jsonl", "only copy\n");
		const dst = put(to, "--a--/1.jsonl", "only copy\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { afterScan: () => { rmSync(dst); symlinkSync(src, dst); } } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.equal(readFileSync(src, "utf8"), "only copy\n");
	});

	it("keeps the source when its placed copy is replaced by another file with the same bytes", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const dst = join(to, "--a--/1.jsonl");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeRemove: () => { rmSync(dst); put(to, "--a--/1.jsonl", "one\n"); } } });
		assert.deepEqual(r.outcomes.map((o) => [o.kind, o.reason]), [["conflict", "the copy at the destination is no longer the file that was checked; the source is kept"]]);
		assert.equal(readFileSync(src, "utf8"), "one\n");
	});

	it("keeps the source when the placed copy's bytes change without changing its identity", () => {
		const src = put(from, "--a--/1.jsonl", "one\n");
		const dst = join(to, "--a--/1.jsonl");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: {
				beforeRemove: () => {
					const { atime, mtime } = statSync(dst);
					const fd = openSync(dst, "r+");
					writeSync(fd, "ONE\n", 0);
					closeSync(fd);
					utimesSync(dst, atime, mtime);
				},
			},
		});
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.equal(readFileSync(src, "utf8"), "one\n");
	});

	it("creates nothing outside the destination when a folder there becomes a link just before it is created", () => {
		const elsewhere = join(s.home, "elsewhere");
		mkdirSync(elsewhere);
		put(from, "--a--/sub/1.jsonl", "one\n");
		const r = migrateSessions(from, to, { apply: true, now: later(), hooks: { beforeMkdir: () => { symlinkSync(elsewhere, join(to, "--a--")); } } });
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.deepEqual(readdirSync(elsewhere), []);
		assert.deepEqual(tree(from), { "--a--/sub/1.jsonl": "one\n" });
	});

	it("keeps the source when the folder holding its placed copy is moved out behind a link", () => {
		const moved = join(s.home, "moved");
		put(from, "--a--/1.jsonl", "one\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: { beforeRemove: () => { renameSync(join(to, "--a--"), moved); symlinkSync(moved, join(to, "--a--")); } },
		});
		assert.deepEqual(r.outcomes.map((o) => o.kind), ["conflict"]);
		assert.equal(readFileSync(join(from, "--a--/1.jsonl"), "utf8"), "one\n");
	});

	it("notices only <name>.pi-daemon.lock and <name>.lock when they appear during --apply", () => {
		for (const n of ["daemon", "plain", "other", "seen"]) put(from, `--a--/${n}.jsonl`, `${n}\n`);
		put(from, "--a--/seen.jsonl.other-tool.lock", "{}");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: {
				afterScan: () => {
					put(from, "--a--/daemon.jsonl.pi-daemon.lock", "{}");
					put(from, "--a--/plain.jsonl.lock", "{}");
					put(from, "--a--/other.jsonl.other-tool.lock", "{}");
				},
			},
		});
		const kinds = Object.fromEntries(r.outcomes.filter((o) => !o.rel.endsWith(".lock")).map((o) => [o.rel, o.kind]));
		// Any <name>.*.lock seen by the scan holds a session back; during --apply only the two fixed names do.
		assert.deepEqual(kinds, { "--a--/daemon.jsonl": "skip", "--a--/plain.jsonl": "skip", "--a--/other.jsonl": "move", "--a--/seen.jsonl": "skip" });
		assert.deepEqual(tree(to), { "--a--/other.jsonl": "other\n" });
	});

	it("moves a file through a destination folder that links to a folder inside the destination", () => {
		mkdirSync(join(to, "real"));
		symlinkSync(join(to, "real"), join(to, "--a--"));
		put(from, "--a--/1.jsonl", "one\n");
		put(from, "--a--/sub/2.jsonl", "two\n");
		const dry = migrateSessions(from, to, { apply: false, now: later() });
		assert.deepEqual(dry.outcomes.map((o) => o.kind), ["move", "move"]);
		const r = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--a--/1.jsonl", "move"], ["--a--/sub/2.jsonl", "move"]]);
		assert.deepEqual(tree(join(to, "real")), { "1.jsonl": "one\n", "sub/2.jsonl": "two\n" });
		assert.deepEqual(tree(from), {});
	});

	it("creates folders and places the copy below a linked folder through its real path, so retargeting the link cannot redirect them", () => {
		const elsewhere = join(s.home, "elsewhere");
		// With elsewhere/sub present, a copy made back through the link would land there.
		mkdirSync(join(elsewhere, "sub"), { recursive: true });
		mkdirSync(join(to, "real"));
		symlinkSync(join(to, "real"), join(to, "--a--"));
		put(from, "--a--/sub/1.jsonl", "one\n");
		const original = fs.mkdirSync;
		// Retarget the link just before the folder below it is created.
		const made = mock.method(fs, "mkdirSync", (path: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
			if (String(path).endsWith("sub")) {
				rmSync(join(to, "--a--"));
				symlinkSync(elsewhere, join(to, "--a--"));
			}
			return original(path, opts);
		});
		syncBuiltinESMExports();
		let r;
		try {
			r = migrateSessions(from, to, { apply: true, now: later() });
		} finally {
			made.mock.restore();
			syncBuiltinESMExports();
		}
		assert.deepEqual(readdirSync(join(elsewhere, "sub")), []);
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--a--/sub/1.jsonl", "move"]]);
		assert.deepEqual(tree(join(to, "real")), { "sub/1.jsonl": "one\n" });
		assert.deepEqual(tree(from), {});
	});

	it("#24: writes nothing outside the destination when a folder above the last one is swapped for a link during --apply", { skip: process.platform !== "linux" && "needs /proc/self/fd" }, () => {
		const outside = join(s.home, "outside");
		// With outside/sub/deep present, a copy made by path after the swap would land there.
		mkdirSync(join(outside, "sub", "deep"), { recursive: true });
		mkdirSync(join(to, "--a--", "sub", "deep"), { recursive: true });
		put(from, "--a--/sub/deep/1.jsonl", "one\n");
		const original = fs.openSync;
		let swapped = false;
		// Swap the upper folder after the folders are checked, just before the copy is written.
		const opened = mock.method(fs, "openSync", (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			if (!swapped && String(path).endsWith(".tmp")) {
				swapped = true;
				renameSync(join(to, "--a--"), join(to, "kept"));
				symlinkSync(outside, join(to, "--a--"));
			}
			return original(path, flags, mode);
		});
		syncBuiltinESMExports();
		let r;
		try {
			r = migrateSessions(from, to, { apply: true, now: later() });
		} finally {
			opened.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(swapped, true);
		assert.deepEqual(tree(outside), {});
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--a--/sub/deep/1.jsonl", "move"]]);
		assert.deepEqual(tree(join(to, "kept")), { "sub/deep/1.jsonl": "one\n" });
		assert.deepEqual(tree(from), {});
	});

	it("#24: creates no folder outside the destination when a folder above is swapped for a link while the folders are made", { skip: process.platform !== "linux" && "needs /proc/self/fd" }, () => {
		const outside = join(s.home, "outside");
		// With outside/sub present, a folder made by path after the swap would land in it.
		mkdirSync(join(outside, "sub"), { recursive: true });
		mkdirSync(join(to, "--a--", "sub"), { recursive: true });
		put(from, "--a--/sub/deep/1.jsonl", "one\n");
		const original = fs.mkdirSync;
		let swapped = false;
		const made = mock.method(fs, "mkdirSync", (path: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
			if (!swapped && String(path).endsWith("deep")) {
				swapped = true;
				renameSync(join(to, "--a--"), join(to, "kept"));
				symlinkSync(outside, join(to, "--a--"));
			}
			return original(path, opts);
		});
		syncBuiltinESMExports();
		let r;
		try {
			r = migrateSessions(from, to, { apply: true, now: later() });
		} finally {
			made.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(swapped, true);
		assert.deepEqual(readdirSync(join(outside, "sub")), []);
		// The folders were held open, so the rest are made where the swapped folder went, inside the destination.
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind]), [["--a--/sub/deep/1.jsonl", "move"]]);
		assert.deepEqual(tree(join(to, "kept")), { "sub/deep/1.jsonl": "one\n" });
		assert.deepEqual(tree(from), {});
	});

	it("names a destination folder that is a broken link as the reason, at the scan and during --apply", () => {
		symlinkSync(join(to, "missing"), join(to, "--a--"));
		symlinkSync(join(to, "--c--"), join(to, "--c--"));
		put(from, "--a--/1.jsonl", "one\n");
		put(from, "--b--/2.jsonl", "two\n");
		put(from, "--c--/3.jsonl", "three\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: { beforeMkdir: (rel) => { if (rel.startsWith("--b--")) symlinkSync(join(to, "gone"), join(to, "--b--")); } },
		});
		const reason = "the destination folder is a link that leads to nothing";
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind, o.reason]), [
			["--a--/1.jsonl", "conflict", reason],
			["--b--/2.jsonl", "conflict", reason],
			["--c--/3.jsonl", "conflict", reason],
		]);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n", "--b--/2.jsonl": "two\n", "--c--/3.jsonl": "three\n" });
	});

	it("names a non-folder in the way of the destination folder as the reason", () => {
		put(from, "--a--/1.jsonl", "one\n");
		put(from, "--b--/2.jsonl", "two\n");
		const r = migrateSessions(from, to, {
			apply: true,
			now: later(),
			hooks: {
				afterScan: () => {
					put(to, "--a--", "a file\n");
					symlinkSync(put(to, "target", "a file\n"), join(to, "--b--"));
				},
			},
		});
		const reason = "something that is not a folder is in the way of the destination folder";
		assert.deepEqual(r.outcomes.map((o) => [o.rel, o.kind, o.reason]), [["--a--/1.jsonl", "conflict", reason], ["--b--/2.jsonl", "conflict", reason]]);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n", "--b--/2.jsonl": "two\n" });
	});

	it("#26: a file in the destination where a folder is needed is a conflict for its sessions, and the rest still move", () => {
		put(to, "--a--", "a file\n");
		put(to, "--b--/sub", "a file\n");
		put(from, "--a--/1.jsonl", "one\n");
		put(from, "--a--/deeper/2.jsonl", "two\n");
		put(from, "--b--/sub/3.jsonl", "three\n");
		put(from, "--c--/4.jsonl", "four\n");
		const reason = "something that is not a folder is in the way of the destination folder";
		const expected = [
			["--a--/1.jsonl", "conflict", reason],
			["--a--/deeper/2.jsonl", "conflict", reason],
			["--b--/sub/3.jsonl", "conflict", reason],
			["--c--/4.jsonl", "move", undefined],
		];
		const dry = migrateSessions(from, to, { apply: false, now: later() });
		assert.deepEqual(sorted(dry.outcomes), expected);
		assert.deepEqual(tree(to), { "--a--": "a file\n", "--b--/sub": "a file\n" });
		const real = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(sorted(real.outcomes), expected);
		assert.deepEqual(tree(from), { "--a--/1.jsonl": "one\n", "--a--/deeper/2.jsonl": "two\n", "--b--/sub/3.jsonl": "three\n" });
		assert.deepEqual(tree(to), { "--a--": "a file\n", "--b--/sub": "a file\n", "--c--/4.jsonl": "four\n" });
	});

	it("#26: a file in the source where the destination has a folder is a conflict for that file, and the rest still move", () => {
		put(to, "--a--/1.jsonl", "theirs\n");
		put(to, "--b--/x/2.jsonl", "theirs\n");
		put(from, "--a--", "a file\n");
		put(from, "--b--/x", "a file\n");
		put(from, "--c--/4.jsonl", "four\n");
		const reason = "a folder is at the destination where the source has a file";
		const expected = [
			["--a--", "conflict", reason],
			["--b--/x", "conflict", reason],
			["--c--/4.jsonl", "move", undefined],
		];
		const dry = migrateSessions(from, to, { apply: false, now: later() });
		assert.deepEqual(sorted(dry.outcomes), expected);
		assert.deepEqual(tree(from), { "--a--": "a file\n", "--b--/x": "a file\n", "--c--/4.jsonl": "four\n" });
		const real = migrateSessions(from, to, { apply: true, now: later() });
		assert.deepEqual(sorted(real.outcomes), expected);
		assert.deepEqual(tree(from), { "--a--": "a file\n", "--b--/x": "a file\n" });
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "theirs\n", "--b--/x/2.jsonl": "theirs\n", "--c--/4.jsonl": "four\n" });
	});

	it("lists each folder once per run, however many files it holds", () => {
		const count = (n: number, apply: boolean): number => {
			const dir = join(from, `--n${n}--`);
			mkdirSync(dir);
			for (let i = 0; i < n; i++) writeFileSync(join(dir, `${i}.jsonl`), "x\n");
			writeFileSync(join(dir, "0.jsonl.pi-daemon.lock"), "{}");
			// Count every real directory listing, including one a helper makes.
			const listed = mock.method(fs, "readdirSync");
			syncBuiltinESMExports();
			let r;
			try {
				r = migrateSessions(from, to, { apply, now: later() });
			} finally {
				listed.mock.restore();
				syncBuiltinESMExports();
			}
			assert.equal(r.outcomes.length, n + 1);
			assert.equal(r.outcomes.find((o) => o.rel === `--n${n}--/0.jsonl`)?.kind, "skip");
			assert.equal(r.outcomes.filter((o) => o.kind === "move").length, n - 1);
			rmSync(dir, { recursive: true });
			rmSync(join(to, `--n${n}--`), { recursive: true, force: true });
			return listed.mock.callCount();
		};
		// The root of each side, then the one source folder.
		assert.equal(count(4000, false), 3);
		assert.equal(count(100, true), 3);
	});

	it("refuses overlapping, relative, missing and unwritable endpoints", () => {
		assert.throws(() => migrateSessions(from, join(from, "inner"), { apply: false }), /does not exist/);
		mkdirSync(join(from, "inner"));
		assert.throws(() => migrateSessions(from, join(from, "inner"), { apply: false }), /overlap/);
		assert.throws(() => migrateSessions(to, s.home, { apply: false }), /overlap/);
		assert.throws(() => migrateSessions("rel", to, { apply: false }), /absolute/);
		assert.throws(() => migrateSessions(join(s.home, "nope"), to, { apply: false }), /not a directory/);
		const file = put(s.home, "file", "");
		assert.throws(() => migrateSessions(from, file, { apply: false }), /not a directory/);
	});

	it("runs from the CLI with store IDs, dry run first", () => {
		put(from, "--a--/1.jsonl", "one\n");
		utimesSync(join(from, "--a--/1.jsonl"), new Date(0), new Date(0));
		assert.equal(cli("sessions", "store", "add", "big", to).code, 0);
		const dry = cli("sessions", "migrate", from, "big");
		assert.equal(dry.code, 0);
		assert.match(dry.stdout, /dry run: .* -> .*\n {2}would move: 1 files, 0\.0 KB\n/);
		assert.match(dry.stdout, /repeat with --apply/);
		assert.deepEqual(tree(to), {});
		const real = cli("sessions", "migrate", from, "big", "--apply");
		assert.equal(real.code, 0);
		assert.match(real.stdout, /moved: 1 files/);
		assert.deepEqual(tree(to), { "--a--/1.jsonl": "one\n" });
		assert.equal(cli("sessions", "migrate", "nostore", "big").code, 2);
		assert.equal(cli("sessions", "migrate", from).code, 2);
		assert.match(cli("sessions", "migrate", from, "big").stdout, /nothing to migrate/);
	});

	it("reports conflicts and failures with exit 1", () => {
		put(from, "--a--/1.jsonl", "mine\n");
		put(to, "--a--/1.jsonl", "theirs\n");
		utimesSync(join(from, "--a--/1.jsonl"), new Date(0), new Date(0));
		const r = cli("sessions", "migrate", from, to, "--apply");
		assert.equal(r.code, 1);
		assert.match(r.stdout, /conflict, kept: 1 files/);
		assert.match(r.stderr, /conflict: --a--\/1\.jsonl: a different file/);
	});
});
