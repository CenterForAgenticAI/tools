import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { addReplica, processToolRunner, runBackup, SSH_COMMAND, type ToolResult, type ToolRunner } from "../src/core/backup.ts";
import { pullFilter, pullSessions, remoteDir } from "../src/core/pull.ts";
import { Refusal } from "../src/core/result.ts";
import { updateConfig } from "../src/core/config.ts";
import { resolveEndpoint } from "../src/core/migrate.ts";
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
const ok = (stdout = ""): ToolResult => ({ status: 0, stdout, stderr: "" });
const AGE = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A repository with this host's subtree, two other hosts, and files that are not sessions. */
function repository(): string {
	const root = join(s.home, "usb");
	put(join(root, "repository.json"), "{}");
	put(join(root, "hosts", "box", "sessions", "--home--", "mine.jsonl"), "mine");
	put(join(root, "hosts", "kite", "host.json"), "{}");
	put(join(root, "hosts", "kite", "sessions", "--home--", "2026_a.jsonl"), "a");
	put(join(root, "hosts", "kite", "sessions", "--home--", "auth.json"), "secret");
	put(join(root, "hosts", "kite", "sessions", "--home--", "deep", "x.jsonl"), "deep");
	put(join(root, "hosts", "kite", "sessions", ".hidden", "h.jsonl"), "hidden");
	put(join(root, "hosts", "kite", "sessions", "top.jsonl"), "top");
	put(join(root, "hosts", "kite", "notes", "n.jsonl"), "notes");
	put(join(root, "hosts", "fig", "sessions", "--work--", "2026_b.jsonl"), "b");
	put(join(root, "hosts", "Bad Host", "sessions", "f", "c.jsonl"), "not a host ID");
	put(join(root, "hosts", "kite", "sessions", "--home--", "ctl\u0001.jsonl"), "control character");
	symlinkSync(join(root, "hosts", "fig", "sessions", "--work--", "2026_b.jsonl"), join(root, "hosts", "kite", "sessions", "--home--", "link.jsonl"));
	return root;
}

function files(root: string, base = root): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(root, e.name), base) : [join(root, e.name).slice(base.length + 1)])).sort();
}

describe("sessions pull from a local replica (real rsync)", () => {
	it("copies only other hosts' session files, read-only, and reports what changed", { skip: rsyncSkip }, () => {
		const root = repository();
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		const first = pullSessions(s.l, "usb", { env: env(), runner: processToolRunner });
		const dir = remoteDir(s.l);
		assert.equal(first.dir, dir);
		assert.deepEqual(files(dir).filter((f) => !f.startsWith(".pi-profile.lock")), ["fig/sessions/--work--/2026_b.jsonl", "kite/sessions/--home--/2026_a.jsonl"]);
		assert.deepEqual([...first.updated].sort(), ["fig/sessions/--work--/2026_b.jsonl", "kite/sessions/--home--/2026_a.jsonl"]);
		assert.equal(statSync(join(dir, "kite/sessions/--home--/2026_a.jsonl")).mode & 0o777, 0o400);
		assert.equal(statSync(join(dir, "kite")).mode & 0o777, 0o700);

		assert.deepEqual(pullSessions(s.l, "usb", { env: env(), runner: processToolRunner }).updated, []);
		const a = join(root, "hosts", "kite", "sessions", "--home--", "2026_a.jsonl");
		writeFileSync(a, "a grew");
		utimesSync(a, new Date(), new Date(Date.now() + 5000));
		const third = pullSessions(s.l, "usb", { env: env(), runner: processToolRunner });
		assert.deepEqual(third.updated, ["kite/sessions/--home--/2026_a.jsonl"]);
		assert.equal(readFileSync(join(dir, "kite/sessions/--home--/2026_a.jsonl"), "utf8"), "a grew");
	});

	it("pulls one host with --host and never deletes what is already pulled", { skip: rsyncSkip }, () => {
		const root = repository();
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, host: "fig" });
		assert.deepEqual(files(remoteDir(s.l)).filter((f) => !f.startsWith(".")), ["fig/sessions/--work--/2026_b.jsonl"]);
		const kept = join(remoteDir(s.l), "old", "sessions", "f", "gone.jsonl");
		put(kept, "kept");
		pullSessions(s.l, "usb", { env: env(), runner: processToolRunner });
		assert.ok(existsSync(kept));
	});

	it("returns nothing from a repository no host has written to yet, but refuses an empty mount point", () => {
		const root = join(s.home, "empty");
		mkdirSync(root);
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: processToolRunner }), /has no hosts\/ and no repository.json; is the disk mounted/);
		writeFileSync(join(root, "repository.json"), "{}");
		assert.deepEqual(pullSessions(s.l, "usb", { env: env(), runner: processToolRunner }).updated, []);
	});

	it("pulls the sessions it can read and reports the ones it cannot", { skip: rsyncSkip }, () => {
		if (process.getuid?.() === 0) return;
		const root = repository();
		const locked = join(root, "hosts", "fig", "sessions", "--work--", "2026_b.jsonl");
		chmodSync(locked, 0o000);
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		const io = Object.assign(captureIo(env()), { tools: processToolRunner });
		assert.equal(main(["sessions", "pull", "usb"], io), 1);
		chmodSync(locked, 0o600);
		assert.match(io.stdout, /^kite\/sessions\/--home--\/2026_a.jsonl\nusb: 1 session new or changed/);
		assert.match(io.stderr, /send_files failed to open ".*2026_b.jsonl": Permission denied/);
		assert.match(io.stderr, /usb: 1 session file\(s\) could not be read; the rest were pulled/);
		assert.ok(existsSync(join(remoteDir(s.l), "kite/sessions/--home--/2026_a.jsonl")));
	});

	it("refuses a hosts/ that is a link, which could pass this host's profiles off as other hosts' sessions", () => {
		const root = join(s.home, "usb");
		put(join(s.home, "profiles", "work", "sessions", "f", "mine.jsonl"), "mine");
		mkdirSync(root);
		symlinkSync(join(s.home, "profiles"), join(root, "hosts"));
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: processToolRunner }), (e: unknown) => e instanceof Refusal && /may be a link/.test(e.message));
		assert.deepEqual(files(remoteDir(s.l)).filter((f) => !f.startsWith(".")), []);
	});

	it("refuses a local replica whose disk is not mounted", () => {
		addReplica(s.l, { id: "usb", kind: "local", path: join(s.home, "absent") }, env());
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: processToolRunner }), /does not exist; is the disk mounted/);
	});
});

describe("sessions pull refusals", () => {
	it("refuses an unknown replica, this host, an invalid host, and an encrypted replica without an identity", () => {
		addReplica(s.l, { id: "usb", kind: "local", path: s.home }, env());
		addReplica(s.l, { id: "s3", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		addReplica(s.l, { id: "sealed", kind: "local", path: s.home, encrypt: { recipients: [AGE] } }, env());
		const never: ToolRunner = () => assert.fail("no tool runs for a refused pull");
		const cases: Array<[string, string | undefined, RegExp]> = [
			["nope", undefined, /replica does not exist: nope/],
			["usb", "box", /box is this host/],
			["usb", "../etc", /invalid host ID/],
			["usb", "*", /invalid host ID/],
			["s3", undefined, /replica s3 is encrypted; give the age identity that decrypts it with --identity FILE, or set pullIdentity/],
			["sealed", undefined, /replica sealed is encrypted; give the age identity/],
		];
		for (const [id, host, msg] of cases) {
			assert.throws(() => pullSessions(s.l, id, { env: env(), runner: never, ...(host === undefined ? {} : { host }) }), (e: unknown) => e instanceof Refusal && msg.test(e.message));
		}
	});

	it("backup run refuses a store inside, holding, or linked into the pulled sessions (L6, L7)", () => {
		const dir = remoteDir(s.l);
		mkdirSync(join(dir, "kite", "sessions"), { recursive: true });
		symlinkSync(join(dir, "kite", "sessions"), join(s.home, "linked"));
		addReplica(s.l, { id: "usb", kind: "local", path: join(s.home, "agent") }, env());
		// Written straight into config.json, as an older version or a hand edit could.
		for (const path of [join(dir, "kite"), join(s.home, "pi-profile"), join(s.home, "linked")]) {
			updateConfig(s.l, (c) => ({ ...c, sessionStores: { x: { path } }, defaultSessionStore: "x" }), env());
			assert.throws(() => runBackup(s.l, { env: env(), runner: () => assert.fail("never runs") }), /overlaps the pulled sessions|contains pi-profile's state directory/, path);
		}
	});

	it("store add and migrate refuse the pulled sessions, even through a link", () => {
		const dir = remoteDir(s.l);
		mkdirSync(join(dir, "kite", "sessions"), { recursive: true });
		symlinkSync(join(dir, "kite", "sessions"), join(s.home, "linked"));
		for (const path of [join(dir, "kite", "sessions"), join(s.home, "linked"), join(s.home, "pi-profile"), join(dir, "new", "sessions")]) {
			assert.throws(() => addStore(s.l, "x", path, env()), /overlaps the pulled sessions/, path);
			assert.throws(() => resolveEndpoint(s.l, path, env()), /overlaps the pulled sessions/, path);
		}
		const io = captureIo(env());
		assert.equal(main(["sessions", "migrate", join(s.home, "linked"), join(s.home, "agent")], io), 2);
		assert.match(io.stderr, /fork a pulled session instead/);
		mkdirSync(join(s.home, "elsewhere"));
		addStore(s.l, "fine", join(s.home, "elsewhere"), env());
	});
});

describe("sessions pull over ssh", () => {
	const advertised = JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path: "/srv/pi", createdAt: "2026-01-01T00:00:00Z", ownerHost: "kite" } } });

	it("reads the advertised path and rsyncs other hosts' sessions with the backup ssh options", () => {
		addReplica(s.l, { id: "studio", kind: "ssh", host: "kite", repository: "sessions" }, env());
		const calls: Array<[string, readonly string[]]> = [];
		const run: ToolRunner = (cmd, args) => {
			calls.push([cmd, args]);
			return cmd === "ssh" ? { status: 0, stdout: advertised, stderr: "" } : { status: 0, stdout: "kite/sessions/f/a.jsonl\nkite/\n", stderr: "" };
		};
		const r = pullSessions(s.l, "studio", { env: env(), runner: run, host: "KITE" });
		assert.deepEqual(r.updated, ["kite/sessions/f/a.jsonl"]);
		const rsync = calls.find(([c]) => c === "rsync")?.[1] ?? [];
		assert.deepEqual(rsync.slice(rsync.indexOf("-e"), rsync.indexOf("-e") + 2), ["-e", SSH_COMMAND]);
		assert.deepEqual(rsync.slice(-2), ["kite:/srv/pi/hosts/", `${remoteDir(s.l)}/`]);
		assert.ok(rsync.includes("--exclude=/box/"));
		assert.ok(rsync.includes("--include=/kite/sessions/*/*.jsonl"));
		assert.ok(rsync.includes("--no-links"));
	});

	it("treats a repository without hosts/ as empty, but not a missing repository or an unreadable hosts/", () => {
		addReplica(s.l, { id: "studio", kind: "ssh", host: "kite", repository: "sessions" }, env());
		const tail = "\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1356) [sender=3.4.1]";
		const answer = (rsync: ToolResult, repo: ToolResult = ok()): ToolRunner => (cmd, args) => (cmd === "ssh" ? { status: 0, stdout: advertised, stderr: "" } : args.includes("--list-only") ? repo : rsync);
		const missing = { status: 23, stdout: "", stderr: `rsync: [sender] change_dir "/srv/pi/hosts" failed: No such file or directory (2)${tail}` };
		assert.deepEqual(pullSessions(s.l, "studio", { env: env(), runner: answer(missing) }).updated, []);
		const gone = { status: 23, stdout: "", stderr: `rsync: [sender] link_stat "/srv/pi/repository.json" failed: No such file or directory (2)${tail}` };
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: answer(missing, gone) }), /studio: no repository.json in kite:\/srv\/pi; is the disk mounted/);
		const denied = { status: 23, stdout: "", stderr: `rsync: [sender] change_dir "/srv/pi/hosts" failed: Permission denied (13)${tail}` };
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: answer(denied) }), /rsync failed/);
		const elsewhere = { status: 23, stdout: "", stderr: `rsync: [sender] change_dir "/other/hosts" failed: No such file or directory (2)${tail}` };
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: answer(elsewhere) }), /rsync failed/);
		const otherFailure = { status: 23, stdout: "", stderr: `rsync: [sender] send_files failed to open "/srv/pi/hosts/k/sessions/f/a.jsonl": Permission denied (13)\nrsync: [sender] readlink_stat("/srv/pi/hosts/k/x") failed: Input/output error (5)${tail}` };
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: answer(otherFailure) }), /rsync failed/);
		const broken = { status: 12, stdout: "", stderr: "rsync error: error in rsync protocol data stream (code 12)" };
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: answer(broken) }), /rsync failed: rsync error: error in rsync protocol/);
	});
});

describe("sessions pull over ssh (real rsync through a local stand-in for ssh)", { skip: rsyncSkip }, () => {
	/** A replica on "kite" whose ssh runs the remote command here, so rsync's ssh-only messages are real. */
	function overSsh(path: string): ToolRunner {
		const fake = join(s.home, "fake-ssh");
		writeFileSync(fake, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; -*) shift;; *) break;; esac; done\nshift\nexec "$@"\n', { mode: 0o700 });
		const advertised = JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path, createdAt: "2026-01-01T00:00:00Z", ownerHost: "kite" } } });
		addReplica(s.l, { id: "studio", kind: "ssh", host: "kite", repository: "sessions" }, env());
		return (cmd, args, opts) => {
			if (cmd === "ssh") return ok(advertised);
			const i = args.indexOf("-e");
			return processToolRunner(cmd, i < 0 ? args : [...args.slice(0, i + 1), fake, ...args.slice(i + 2)], opts);
		};
	}

	it("pulls sessions, treats a repository without hosts/ as empty, and refuses a missing one", () => {
		const root = repository();
		const run = overSsh(root);
		assert.deepEqual([...pullSessions(s.l, "studio", { env: env(), runner: run }).updated].sort(), ["fig/sessions/--work--/2026_b.jsonl", "kite/sessions/--home--/2026_a.jsonl"]);
		const empty = join(s.home, "fresh");
		put(join(empty, "repository.json"), "{}");
		updateConfig(s.l, (c) => ({ ...c, replicas: [] }));
		assert.deepEqual(pullSessions(s.l, "studio", { env: env(), runner: overSsh(empty) }).updated, []);
		updateConfig(s.l, (c) => ({ ...c, replicas: [] }));
		const gone = overSsh(join(s.home, "unmounted"));
		assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: gone }), /studio: no repository.json in kite:.*unmounted; is the disk mounted/);
		if (process.getuid?.() === 0) return;
		chmodSync(join(root, "hosts"), 0o000);
		updateConfig(s.l, (c) => ({ ...c, replicas: [] }));
		const denied = overSsh(root);
		try {
			assert.throws(() => pullSessions(s.l, "studio", { env: env(), runner: denied }), /rsync failed/);
		} finally {
			chmodSync(join(root, "hosts"), 0o700);
		}
	});
});

describe("pullFilter", () => {
	it("excludes this host first and everything that is not a session last", () => {
		const f = pullFilter("box");
		assert.equal(f[0], "--exclude=/box/");
		assert.equal(f.at(-1), "--exclude=*");
		assert.ok(f.includes("--exclude=/*[!a-z0-9-]*/") && f.includes("--exclude=*[[:cntrl:]]*"));
		assert.deepEqual(pullFilter("box", "kite").slice(5, 9), ["--include=/kite/", "--include=/kite/sessions/", "--include=/kite/sessions/*/", "--include=/kite/sessions/*/*.jsonl"]);
	});
});

describe("sessions pull command", () => {
	it("lists updated sessions and a summary; refuses bad usage", { skip: rsyncSkip }, () => {
		const root = repository();
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		const io = Object.assign(captureIo(env()), { tools: processToolRunner });
		assert.equal(main(["sessions", "pull", "usb", "--host", "kite"], io), 0);
		assert.equal(io.stdout, `kite/sessions/--home--/2026_a.jsonl\nusb: 1 session new or changed in ${remoteDir(s.l)}\n`);
		const bad = captureIo(env());
		assert.equal(main(["sessions", "pull"], bad), 2);
		assert.match(bad.stderr, /usage: pi-profile sessions pull REPLICA/);
		assert.equal(main(["sessions", "pull", "usb", "extra"], bad), 2);
	});

	it("a pulled file cannot be written in place", { skip: rsyncSkip }, () => {
		const root = repository();
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		pullSessions(s.l, "usb", { env: env(), runner: processToolRunner });
		const f = join(remoteDir(s.l), "kite/sessions/--home--/2026_a.jsonl");
		if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(f, "x"), /EACCES/);
		chmodSync(f, 0o600);
	});
});
