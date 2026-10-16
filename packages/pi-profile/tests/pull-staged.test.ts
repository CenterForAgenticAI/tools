import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { addReplica, processToolRunner, removeReplica, runBackup, type ToolRunner } from "../src/core/backup.ts";
import { parseConfig, updateConfig } from "../src/core/config.ts";
import { keepCopy, pullFilter, pullSessions, pullStateDir, rclonePullFilter, remoteDir } from "../src/core/pull.ts";
import { Refusal } from "../src/core/result.ts";
import { addStore } from "../src/core/sessions.ts";
import { captureIo, rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";

// Stand-in aws, rclone, ssh (and age, when the real one is not installed) on
// PATH; rsync is real. The fake bucket is a folder: s3://bkt/pfx is <home>/s3/bkt/pfx.
const FAKE = join(import.meta.dirname, "fixtures", "fake-tools.mjs");
const REAL_AGE = spawnSync("sh", ["-c", "command -v age && command -v age-keygen"]).status === 0;
const PATH0 = process.env.PATH ?? "";
const FAKE_ENV = ["FAKE_LOG", "FAKE_S3", "FAKE_S3_EXTRA", "FAKE_SAFE", "FAKE_NO_FILTER", "FAKE_PEER_HOME"];
/** Runs the remote command here, with HOME set to the peer's, like ssh to another device. */
const SSH = '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done\nshift\nHOME="$FAKE_PEER_HOME" exec sh -c "$*"\n';

let s: Sandbox;
let log: string;
beforeEach(() => {
	s = sandbox();
	const bin = join(s.home, "bin");
	mkdirSync(bin);
	for (const t of REAL_AGE ? ["aws", "rclone"] : ["aws", "rclone", "age", "age-keygen"]) writeFileSync(join(bin, t), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${t} "$@"\n`, { mode: 0o755 });
	writeFileSync(join(bin, "ssh"), SSH, { mode: 0o755 });
	log = join(s.home, "tools.log");
	process.env.PATH = `${bin}:${PATH0}`;
	process.env.FAKE_LOG = log;
	process.env.FAKE_S3 = join(s.home, "s3");
	process.env.FAKE_PEER_HOME = join(s.home, "peer-home");
});
afterEach(() => {
	process.env.PATH = PATH0;
	for (const k of FAKE_ENV) delete process.env[k];
	s.cleanup();
});

const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });

function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** Every file under `root`, as relative paths. */
function files(root: string, base = root): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(root, e.name), base) : [join(root, e.name).slice(base.length + 1)])).sort();
}
/** The pulled sessions, without the lock file. */
const pulled = (): string[] => files(remoteDir(s.l)).filter((f) => !f.startsWith(".pi-profile.lock"));

interface Key {
	readonly file: string;
	readonly pub: string;
	readonly secret: string;
}
function keygen(name: string): Key {
	const file = join(s.home, "keys", name);
	mkdirSync(dirname(file), { recursive: true });
	const r = spawnSync("age-keygen", ["-o", file], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const text = readFileSync(file, "utf8");
	const pub = /# public key: (\S+)/.exec(text)?.[1] ?? "";
	const secret = /^AGE-SECRET-KEY-\S+$/m.exec(text)?.[0] ?? "";
	assert.ok(pub !== "" && secret !== "");
	return { file, pub, secret };
}

/** Encrypt `text` to `pub` at `path`, as a backup would. */
function seal(path: string, text: string, pub: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const r = spawnSync("age", ["--encrypt", "-r", pub, "-o", path], { input: text, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
}

/**
 * Other hosts' sealed sessions under `root` (a repository's hosts/), plus what
 * a pull must never take: this host's own subtree, a non-session object, hidden
 * files and folders, a deeper path, a folder that is not `sessions`, a host
 * folder that is not a host ID, and a name with a control character.
 */
function hostile(root: string, pub: string): void {
	seal(join(root, "kiwi/sessions/--home--/2026_a.jsonl.age"), "a\n", pub);
	seal(join(root, "fig/sessions/--work--/2026_b.jsonl.age"), "b\n", pub);
	seal(join(root, "box/sessions/--home--/mine.jsonl.age"), "mine\n", pub);
	put(join(root, "kiwi/host.json"), "{}");
	put(join(root, "kiwi/sessions/--home--/auth.json"), "secret");
	seal(join(root, "kiwi/sessions/--home--/.hidden.jsonl.age"), "hidden\n", pub);
	seal(join(root, "kiwi/sessions/.dot/h.jsonl.age"), "dot folder\n", pub);
	seal(join(root, "kiwi/sessions/--home--/deep/x.jsonl.age"), "deep\n", pub);
	seal(join(root, "kiwi/notes/f/n.jsonl.age"), "notes\n", pub);
	seal(join(root, "Bad_Host/sessions/f/c.jsonl.age"), "not a host ID\n", pub);
	seal(join(root, "kiwi/sessions/--home--/ctl\u0001.jsonl.age"), "control character\n", pub);
}

/**
 * Object keys no folder can hold. The first two climb out of the download
 * folder; the third, normalised as the real CLIs do, lands back inside
 * kiwi's sessions, so only a tool filter can keep it out.
 */
function traversalKeys(normalisedInside = true): void {
	const extra = join(s.home, "extra.json");
	const up = "../".repeat(8);
	writeFileSync(
		extra,
		JSON.stringify({
			[`kiwi/sessions/x/${up}escape/sessions/f/escaped.jsonl`]: "escaped",
			"kiwi/sessions/../../../../../../../pi-profile/remote/evil/sessions/f/escaped2.jsonl": "escaped",
			...(normalisedInside ? { "kiwi/sessions/../../kiwi/sessions/f/escaped3.jsonl": "escaped" } : {}),
		}),
	);
	process.env.FAKE_S3_EXTRA = extra;
}

const SESSIONS = ["fig/sessions/--work--/2026_b.jsonl", "kiwi/sessions/--home--/2026_a.jsonl"];

/** The object keys the fake aws or rclone wrote to this host. */
function downloaded(): string[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, unknown]).filter(([what]) => what === "wrote").map(([, key]) => String(key)).sort();
}

function s3Replica(id: string, tool: "aws" | "rclone", pub?: string): void {
	addReplica(s.l, { id, kind: "s3", uri: "s3://bkt/pfx", tool, encrypt: pub === undefined ? false : { recipients: [pub] } }, env());
}

describe("sessions pull from an encrypted s3 replica", () => {
	for (const tool of ["aws", "rclone"] as const) {
		it(`${tool}: downloads only other hosts' session objects, decrypts them, and nothing else arrives`, () => {
			const key = keygen("id");
			hostile(join(s.home, "s3", "bkt", "pfx", "hosts"), key.pub);
			traversalKeys();
			s3Replica("cloud", tool, key.pub);
			const r = pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, identity: key.file });
			assert.deepEqual([...r.updated].sort(), SESSIONS);
			assert.deepEqual(r.failed, []);
			assert.deepEqual(pulled(), SESSIONS);
			assert.equal(readFileSync(join(remoteDir(s.l), SESSIONS[1] ?? ""), "utf8"), "a\n");
			assert.equal(readFileSync(join(remoteDir(s.l), SESSIONS[0] ?? ""), "utf8"), "b\n");
			// The tool's filter: no other object was downloaded at all, except, for aws, whose
			// patterns cannot single out the first part of a key, the folder that is not a host ID.
			const wrongHost = tool === "aws" ? ["Bad_Host/sessions/f/c.jsonl.age"] : [];
			assert.deepEqual(downloaded(), [...wrongHost, "fig/sessions/--work--/2026_b.jsonl.age", "kiwi/sessions/--home--/2026_a.jsonl.age"]);
			// Nothing climbed out of the download folder.
			assert.deepEqual(files(s.home).filter((f) => /escaped/.test(f)), []);
			// The download folder is gone.
			assert.deepEqual(readdirSync(pullStateDir(s.l)), []);
		});
	}

	it("keeps only session files even when the tool lets everything through", () => {
		const key = keygen("id");
		hostile(join(s.home, "s3", "bkt", "pfx", "hosts"), key.pub);
		traversalKeys(false);
		// A tool whose filters do nothing, but that, like the real CLIs, never writes outside its destination.
		process.env.FAKE_NO_FILTER = "1";
		process.env.FAKE_SAFE = "1";
		for (const tool of ["aws", "rclone"] as const) {
			s3Replica(tool, tool, key.pub);
			const r = pullSessions(s.l, tool, { env: env(), runner: processToolRunner, identity: key.file });
			assert.deepEqual(r.failed, [], tool);
			assert.deepEqual(pulled(), SESSIONS, tool);
			assert.ok(downloaded().includes("kiwi/sessions/--home--/auth.json"), "the tool did download the other objects");
		}
		assert.deepEqual(files(s.home).filter((f) => /escaped/.test(f)), []);
	});

	it("passes the filters to the tool and downloads into a private folder under state/", () => {
		const key = keygen("id");
		seal(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl.age"), "a\n", key.pub);
		s3Replica("cloud", "aws", key.pub);
		const calls: Array<[string, readonly string[]]> = [];
		let scratchMode = 0;
		const run: ToolRunner = (cmd, args, opts) => {
			calls.push([cmd, args]);
			if (cmd === "aws") scratchMode = statSync(dirname(args.at(-1) ?? "")).mode & 0o777;
			return processToolRunner(cmd, args, opts);
		};
		// A run folder a killed pull left behind.
		const stale = join(pullStateDir(s.l), "cloud.run-AbC123");
		put(join(stale, "download", "kiwi", "sessions", "f", "old.jsonl"), "old");
		pullSessions(s.l, "cloud", { env: env(), runner: run, host: "kiwi", identity: key.file });
		const aws = calls.find(([c]) => c === "aws")?.[1] ?? [];
		assert.deepEqual(aws.slice(0, 4), ["s3", "cp", "--recursive", "--only-show-errors"]);
		assert.equal(aws.at(-2), "s3://bkt/pfx/hosts/");
		assert.ok(aws.at(-1)?.startsWith(`${pullStateDir(s.l)}/cloud.run-`));
		// Literal: aws's `*` crosses `/`, so later excludes drop what the includes let through.
		assert.deepEqual(aws.slice(4, -2), [
			"--exclude", "*",
			"--include", "kiwi/sessions/*/*.jsonl",
			"--include", "kiwi/sessions/*/*.jsonl.age",
			"--exclude", "box/*",
			"--exclude", ".*",
			"--exclude", "*/.*",
			"--exclude", "/*",
			"--exclude", "*//*",
			"--exclude", "*[\u0001-\u001f\u007f]*",
			"--exclude", `*${"[!/]".repeat(256)}*`,
			"--exclude", "*/sessions/*/*/*",
		]);
		assert.equal(scratchMode, 0o700);
		assert.equal(existsSync(stale), false);
		assert.deepEqual(pulled(), ["kiwi/sessions/f/a.jsonl"]);
		assert.deepEqual(rclonePullFilter("box").at(-1), "--filter=- **");
		assert.ok(rclonePullFilter("box").includes("--filter=- /box/**"));
	});

	it("replaces changed copies, keeps unchanged ones, never removes a file, and makes them read-only", () => {
		const key = keygen("id");
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		seal(join(hosts, "kiwi/sessions/f/a.jsonl.age"), "a\n", key.pub);
		seal(join(hosts, "kiwi/sessions/f/b.jsonl.age"), "b\n", key.pub);
		s3Replica("cloud", "rclone", key.pub);
		const opts = { env: env(), runner: processToolRunner, identity: key.file };
		assert.deepEqual(pullSessions(s.l, "cloud", opts).updated, ["kiwi/sessions/f/a.jsonl", "kiwi/sessions/f/b.jsonl"]);
		const dir = remoteDir(s.l);
		const a = join(dir, "kiwi/sessions/f/a.jsonl");
		assert.equal(statSync(a).mode & 0o777, 0o400);
		assert.equal(statSync(join(dir, "kiwi")).mode & 0o777, 0o700);
		const inode = statSync(join(dir, "kiwi/sessions/f/b.jsonl")).ino;
		const kept = join(dir, "old", "sessions", "f", "gone.jsonl");
		put(kept, "kept");
		assert.deepEqual(pullSessions(s.l, "cloud", opts).updated, []);
		seal(join(hosts, "kiwi/sessions/f/a.jsonl.age"), "a\na grew\n", key.pub);
		assert.deepEqual(pullSessions(s.l, "cloud", opts).updated, ["kiwi/sessions/f/a.jsonl"]);
		assert.equal(readFileSync(a, "utf8"), "a\na grew\n");
		assert.equal(statSync(a).mode & 0o777, 0o400);
		assert.equal(statSync(join(dir, "kiwi/sessions/f/b.jsonl")).ino, inode);
		assert.ok(existsSync(kept));
	});

	it("never writes through a link in the pulled tree", () => {
		const key = keygen("id");
		seal(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl.age"), "a\n", key.pub);
		s3Replica("cloud", "aws", key.pub);
		const elsewhere = join(s.home, "agent", "sessions");
		mkdirSync(elsewhere, { recursive: true });
		mkdirSync(join(remoteDir(s.l), "kiwi"), { recursive: true });
		symlinkSync(elsewhere, join(remoteDir(s.l), "kiwi", "sessions"));
		const r = pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, identity: key.file });
		assert.deepEqual(r.updated, []);
		assert.equal(r.failed.length, 1);
		assert.match(r.failed[0] ?? "", /^kiwi\/sessions\/f\/a.jsonl: .*not a directory; a pull does not write through links/);
		assert.deepEqual(files(elsewhere), []);
	});

	it("treats a bucket only this host backed up to as empty", () => {
		const key = keygen("id");
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		put(join(hosts, "box", "host.json"), "{}");
		seal(join(hosts, "box/sessions/f/mine.jsonl.age"), "mine\n", key.pub);
		for (const tool of ["aws", "rclone"] as const) {
			s3Replica(tool, tool, key.pub);
			const r = pullSessions(s.l, tool, { env: env(), runner: processToolRunner, identity: key.file });
			assert.deepEqual([r.updated, r.failed], [[], []], tool);
		}
	});

	it("reads a backup another host made (round trip through backup run)", () => {
		const key = keygen("id");
		const kiwi = { piHome: join(s.home, "kiwi-pi") };
		const kenv = { PI_PROFILE_HOME: kiwi.piHome, PI_PROFILE_HOST_ID: "kiwi" };
		const store = join(s.home, "kiwi-store");
		put(join(store, "--home--", "2026_a.jsonl"), '{"type":"session"}\n');
		addStore(kiwi, "main", store, kenv);
		addReplica(kiwi, { id: "cloud", kind: "s3", uri: "s3://bkt/pfx", encrypt: { recipients: [key.pub] } }, kenv);
		assert.deepEqual(runBackup(kiwi, { env: kenv, runner: processToolRunner }).map((x) => x.ok), [true]);
		s3Replica("cloud", "aws", key.pub);
		pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, identity: key.file });
		assert.deepEqual(pulled(), ["kiwi/sessions/--home--/2026_a.jsonl"]);
		assert.equal(readFileSync(join(remoteDir(s.l), "kiwi/sessions/--home--/2026_a.jsonl"), "utf8"), '{"type":"session"}\n');
	});
});

describe("sessions pull from a plain s3 replica", () => {
	it("needs no identity, runs no age, and takes only .jsonl session files", () => {
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		put(join(hosts, "kiwi/sessions/f/a.jsonl"), "a\n");
		put(join(hosts, "kiwi/sessions/f/sealed.jsonl.age"), "not for a plain replica");
		put(join(hosts, "kiwi/sessions/f/auth.json"), "secret");
		put(join(hosts, "box/sessions/f/mine.jsonl"), "mine");
		for (const tool of ["aws", "rclone"] as const) {
			s3Replica(tool, tool);
			const calls: string[] = [];
			const run: ToolRunner = (cmd, args, opts) => {
				calls.push(cmd);
				return processToolRunner(cmd, args, opts);
			};
			pullSessions(s.l, tool, { env: env(), runner: run });
			assert.deepEqual(calls, [tool]);
			assert.deepEqual(pulled(), ["kiwi/sessions/f/a.jsonl"], tool);
		}
	});
});

describe("sessions pull from encrypted local and ssh replicas", { skip: rsyncSkip }, () => {
	it("local: rsyncs the .age files into staging, decrypts them, and nothing else arrives", () => {
		const key = keygen("id");
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		hostile(join(root, "hosts"), key.pub);
		symlinkSync(join(root, "hosts", "fig", "sessions", "--work--", "2026_b.jsonl.age"), join(root, "hosts", "kiwi", "sessions", "--home--", "link.jsonl.age"));
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, env());
		const r = pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, identity: key.file });
		assert.deepEqual([...r.updated].sort(), SESSIONS);
		assert.deepEqual(pulled(), SESSIONS);
		assert.equal(readFileSync(join(remoteDir(s.l), SESSIONS[1] ?? ""), "utf8"), "a\n");
	});

	it("local: reads a backup another host made", () => {
		const key = keygen("id");
		const root = join(s.home, "usb");
		mkdirSync(root);
		const kiwi = { piHome: join(s.home, "kiwi-pi") };
		const kenv = { PI_PROFILE_HOME: kiwi.piHome, PI_PROFILE_HOST_ID: "kiwi" };
		const store = join(s.home, "kiwi-store");
		put(join(store, "--home--", "2026_a.jsonl"), "kiwi's\n");
		addStore(kiwi, "main", store, kenv);
		addReplica(kiwi, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, kenv);
		assert.deepEqual(runBackup(kiwi, { env: kenv, runner: processToolRunner }).map((x) => x.ok), [true]);
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, env());
		updateConfig(s.l, (c) => ({ ...c, pullIdentity: key.file }), env());
		pullSessions(s.l, "usb", { env: env(), runner: processToolRunner });
		assert.deepEqual(pulled(), ["kiwi/sessions/--home--/2026_a.jsonl"]);
		assert.equal(readFileSync(join(remoteDir(s.l), "kiwi/sessions/--home--/2026_a.jsonl"), "utf8"), "kiwi's\n");
	});

	it("ssh: rsyncs through the stand-in ssh, decrypts, and keeps only session files", () => {
		const key = keygen("id");
		const root = join(s.home, "peer-repo");
		put(join(root, "repository.json"), "{}");
		hostile(join(root, "hosts"), key.pub);
		put(join(s.home, "peer-home", ".pi", "pi-profile", "advertised.json"), JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path: root, createdAt: "2026-01-01T00:00:00Z", ownerHost: "kiwi" } } }));
		addReplica(s.l, { id: "studio", kind: "ssh", host: "kiwi", repository: "sessions", encrypt: { recipients: [key.pub] } }, env());
		const r = pullSessions(s.l, "studio", { env: env(), runner: processToolRunner, identity: key.file });
		assert.deepEqual([...r.updated].sort(), SESSIONS);
		assert.deepEqual(pulled(), SESSIONS);
	});
});

describe("sessions pull: decryption failures and the age identity", () => {
	/** A local encrypted replica: two sessions for `key`, one for someone else. */
	function mixed(key: Key): string {
		const other = keygen("other");
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		seal(join(root, "hosts/kiwi/sessions/f/a.jsonl.age"), "a\n", key.pub);
		seal(join(root, "hosts/kiwi/sessions/f/b.jsonl.age"), "b\n", other.pub);
		seal(join(root, "hosts/kiwi/sessions/f/c.jsonl.age"), "c\n", key.pub);
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, env());
		return root;
	}

	it("a file that will not decrypt is listed and the others are still pulled (exit 1)", { skip: rsyncSkip }, () => {
		const key = keygen("id");
		mixed(key);
		const io = Object.assign(captureIo(env()), { tools: processToolRunner });
		assert.equal(main(["sessions", "pull", "usb", "--identity", key.file], io), 1);
		assert.equal(io.stdout, `kiwi/sessions/f/a.jsonl\nkiwi/sessions/f/c.jsonl\nusb: 2 sessions new or changed in ${remoteDir(s.l)}\n`);
		assert.match(io.stderr, /^pi-profile: kiwi\/sessions\/f\/b.jsonl.age: age could not decrypt it/m);
		assert.match(io.stderr, /usb: 1 failure\(s\) downloading, decrypting or saving session files; the rest were pulled/);
		assert.deepEqual(pulled(), ["kiwi/sessions/f/a.jsonl", "kiwi/sessions/f/c.jsonl"]);
		assert.deepEqual(readdirSync(pullStateDir(s.l)), []);
	});

	it("the identity never appears in output or argv beyond age -i, and is never placed in a replica", () => {
		const key = keygen("id-secret-name");
		const root = mixed(key);
		const before = files(root).map((f) => [f, readFileSync(join(root, f), "latin1")]);
		const calls: Array<[string, readonly string[]]> = [];
		const tools: ToolRunner = (cmd, args, opts) => {
			calls.push([cmd, args]);
			return processToolRunner(cmd, args, opts);
		};
		const io = Object.assign(captureIo(env()), { tools });
		// The failed decrypt matters: age's own message can quote the identity file.
		assert.equal(main(["sessions", "pull", "usb", "--identity", key.file], io), 1);
		const output = io.stdout + io.stderr;
		for (const leak of [key.file, "id-secret-name", key.secret]) assert.ok(!output.includes(leak), `output names ${leak}`);
		// The key itself is never an argument; the file's path is, only to age, only after -i.
		for (const [cmd, args] of calls) {
			assert.ok(!args.some((a) => a.includes(key.secret)), cmd);
			args.forEach((a, i) => a.includes("id-secret-name") && assert.ok(cmd === "age" && args[i - 1] === "-i", `${cmd} ${String(i)}`));
		}
		// The replica is only read.
		assert.deepEqual(files(root).map((f) => [f, readFileSync(join(root, f), "latin1")]), before);
		// A bad identity file is refused without naming it.
		const missing = join(s.home, "nowhere", "id-secret-name");
		const bad = captureIo(env());
		assert.equal(main(["sessions", "pull", "usb", "--identity", missing], bad), 2);
		assert.match(bad.stderr, /cannot read the age identity file/);
		assert.ok(!bad.stderr.includes("id-secret-name"));
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "box", sessionStores: {}, pullIdentity: "keys/id-secret-name" }), (e: unknown) => e instanceof Refusal && /pullIdentity must be an absolute path/.test(e.message) && !e.message.includes("id-secret-name"));
	});

	it("refuses an identity kept inside a replica, and an identity read from nowhere but --identity or config", { skip: rsyncSkip }, () => {
		const key = keygen("id");
		const root = mixed(key);
		const inside = join(root, "hosts", "id.txt");
		writeFileSync(inside, readFileSync(key.file));
		const never: ToolRunner = () => assert.fail("no tool runs for a refused pull");
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: never, identity: inside }), (e: unknown) => e instanceof Refusal && /the age identity is inside replica usb/.test(e.message) && !e.message.includes(inside));
		// Even through a link to it.
		const link = join(s.home, "keys", "link");
		symlinkSync(inside, link);
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: never, identity: link }), /inside replica usb/);
		// A key in the replica is not used without being named.
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: never }), /replica usb is encrypted; give the age identity/);
		// --identity beats pullIdentity.
		updateConfig(s.l, (c) => ({ ...c, pullIdentity: join(s.home, "absent") }), env());
		const r = pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, identity: key.file });
		assert.deepEqual(r.updated, ["kiwi/sessions/f/a.jsonl", "kiwi/sessions/f/c.jsonl"]);
		assert.throws(() => pullSessions(s.l, "usb", { env: env(), runner: never }), /cannot read the age identity file/);
	});

	it("a session changed at the replica keeps its downloaded time", { skip: rsyncSkip }, () => {
		const key = keygen("id");
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		const f = join(root, "hosts/kiwi/sessions/f/a.jsonl.age");
		seal(f, "a\n", key.pub);
		const t = new Date("2026-02-03T04:05:06Z");
		utimesSync(f, t, t);
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, env());
		pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, identity: key.file });
		assert.equal(lstatSync(join(remoteDir(s.l), "kiwi/sessions/f/a.jsonl")).mtimeMs, t.getTime());
	});
});

/** A plain s3 replica's bucket, with extra keys no folder can hold. */
function extraKeys(keys: Record<string, string>): void {
	const extra = join(s.home, "extra.json");
	writeFileSync(extra, JSON.stringify(keys));
	process.env.FAKE_S3_EXTRA = extra;
}

describe("review round 1: CR-21-TOOL-ABORT", () => {
	for (const tool of ["aws", "rclone"] as const) {
		it(`${tool}: one object that cannot be downloaded fails alone; the good one is pulled and the exit is 1`, () => {
			const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
			put(join(hosts, "kiwi/sessions/f/good.jsonl"), "good\n");
			s3Replica("cloud", tool);
			// 300 characters: the tool's filter keeps it out, so it never reaches the file system.
			const long = `fig/sessions/f/${"x".repeat(300)}.jsonl`;
			extraKeys({ [long]: "long" });
			const first = Object.assign(captureIo(env()), { tools: processToolRunner });
			assert.equal(main(["sessions", "pull", "cloud"], first), 0, first.stderr);
			assert.ok(!downloaded().includes(long));
			assert.equal(first.stderr, "");
			// 200 characters but 400 bytes: past the filter, too long for a folder, so the tool fails on it.
			extraKeys({ [long]: "long", [`fig/sessions/f/${"\u00e9".repeat(200)}.jsonl`]: "wide" });
			put(join(hosts, "kiwi/sessions/f/good.jsonl"), "good, grown\n");
			const io = Object.assign(captureIo(env()), { tools: processToolRunner });
			assert.equal(main(["sessions", "pull", "cloud"], io), 1);
			assert.equal(io.stdout, `kiwi/sessions/f/good.jsonl\ncloud: 1 session new or changed in ${remoteDir(s.l)}\n`);
			const what = tool === "aws" ? "aws s3 cp" : "rclone copy";
			assert.match(io.stderr, new RegExp(`^pi-profile: ${what} failed: download failed: fig/sessions/f/\u00e9{200}\\.jsonl .*ENAMETOOLONG$`, "m"));
			assert.match(io.stderr, /cloud: 1 failure\(s\) downloading, decrypting or saving session files; the rest were pulled/);
			assert.deepEqual(pulled(), ["kiwi/sessions/f/good.jsonl"]);
			assert.equal(readFileSync(join(remoteDir(s.l), "kiwi/sessions/f/good.jsonl"), "utf8"), "good, grown\n");
			assert.deepEqual(readdirSync(pullStateDir(s.l)), []);
		});
	}

	it("the filters drop any name part over 255 bytes (rsync) or 255 characters (aws, rclone)", () => {
		assert.ok(pullFilter("box").includes(`--exclude=${"?".repeat(256)}*`));
		assert.ok(rclonePullFilter("box").includes("--filter=- /**{{(?:[^/]{256})}}**"));
	});
});

describe("review round 1: CR-21-STDERR-RAW", () => {
	const NASTY = "first line\nlast \u001b]0;owned\u0007 \u009b31m \u202eevil";
	/** ESC, BEL, CSI (C1) and RIGHT-TO-LEFT OVERRIDE: none may reach the terminal. */
	const RAW = [0x1b, 0x07, 0x9b, 0x202e].map((c) => String.fromCharCode(c));
	const hasRaw = (text: string): boolean => RAW.some((c) => text.includes(c));
	const failing: ToolRunner = () => ({ status: 255, stdout: "", stderr: NASTY });

	it("pull: a tool's message reaches the terminal printable, whether reported or thrown", () => {
		s3Replica("cloud", "aws");
		const reported = Object.assign(captureIo(env()), { tools: failing });
		assert.equal(main(["sessions", "pull", "cloud"], reported), 1);
		assert.match(reported.stderr, /^pi-profile: aws s3 cp failed: last \?\]0;owned\? \?31m \?evil$/m);
		assert.equal(hasRaw(reported.stderr), false);
		assert.equal(hasRaw(NASTY), true);
		const root = join(s.home, "usb");
		mkdirSync(join(root, "hosts"), { recursive: true });
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		const thrown = Object.assign(captureIo(env()), { tools: failing });
		assert.equal(main(["sessions", "pull", "usb"], thrown), 1);
		assert.equal(thrown.stderr, "pi-profile: rsync failed: last ?]0;owned? ?31m ?evil\n");
	});

	it("backup: a tool's message reaches the terminal printable", () => {
		const store = join(s.home, "store");
		put(join(store, "--home--", "a.jsonl"), "a\n");
		addStore(s.l, "main", store, env());
		s3Replica("cloud", "aws");
		const io = Object.assign(captureIo(env()), { tools: failing });
		assert.equal(main(["backup", "run"], io), 1);
		assert.equal(io.stderr, "cloud: failed: aws s3 cp failed: last ?]0;owned? ?31m ?evil\n");
	});
});

describe("review round 1: CR-21-UNPLACEABLE", () => {
	it("a session name of up to 255 bytes is placed: the temporary name is short", () => {
		const name = `${"a".repeat(249)}.jsonl`;
		assert.equal(Buffer.byteLength(name), 255);
		put(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f", name), "long\n");
		s3Replica("cloud", "aws");
		const r = pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner });
		assert.deepEqual(r.failed, []);
		assert.deepEqual(pulled(), [`kiwi/sessions/f/${name}`]);
	});

	it("a name that is not UTF-8 is skipped with a warning that holds none of its bytes", { skip: rsyncSkip }, () => {
		const key = keygen("id");
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		const folder = join(root, "hosts/kiwi/sessions/f");
		seal(join(folder, "good.jsonl.age"), "good\n", key.pub);
		seal(join(folder, "bad.jsonl.age"), "bad\n", key.pub);
		renameSync(join(folder, "bad.jsonl.age"), Buffer.concat([Buffer.from(`${folder}/bad`), Buffer.from([0xff, 0xfe]), Buffer.from(".jsonl.age")]));
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: [key.pub] } }, env());
		const io = Object.assign(captureIo(env()), { tools: processToolRunner });
		assert.equal(main(["sessions", "pull", "usb", "--identity", key.file], io), 0, io.stderr);
		assert.equal(io.stderr, "pi-profile: warning: kiwi/sessions/f: a session whose name is not UTF-8 was skipped\n");
		assert.deepEqual(pulled(), ["kiwi/sessions/f/good.jsonl"]);
	});
});

describe("review round 1: CR-21-TMP-LEAK", () => {
	it("a failed write leaves no temporary file, names the session by its relative path, and old temporaries are swept", () => {
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		put(join(hosts, "kiwi/sessions/f/a.jsonl"), "a\n");
		put(join(hosts, "kiwi/sessions/f/b.jsonl"), "b\n");
		s3Replica("cloud", "aws");
		const folder = join(remoteDir(s.l), "kiwi/sessions/f");
		// What a killed pull left, and a file that is not one of its temporaries.
		put(join(folder, ".pull-0123456789ab.tmp"), "half a session");
		put(join(folder, ".pull-mine.tmp"), "not a pull's");
		// Older than a pull that may still be running.
		for (const name of [".pull-0123456789ab.tmp", ".pull-mine.tmp"]) utimesSync(join(folder, name), new Date(Date.now() - 11 * 60 * 1000), new Date(Date.now() - 11 * 60 * 1000));
		let writes = 0;
		// The first write fails with a real system error that quotes the absolute temporary path.
		const afterTempWrite = (tmp: string): void => {
			if (writes++ === 0) readFileSync(join(tmp, "x"));
		};
		const r = pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, hooks: { afterTempWrite } });
		assert.deepEqual(r.failed, ["kiwi/sessions/f/a.jsonl: ENOTDIR: not a directory (open)"]);
		assert.deepEqual(r.updated, ["kiwi/sessions/f/b.jsonl"]);
		assert.deepEqual(readdirSync(folder).sort(), [".pull-mine.tmp", "b.jsonl"]);
	});

	it("a place() failure names the relative path, never an absolute one", () => {
		put(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl"), "a\n");
		s3Replica("cloud", "aws");
		put(join(remoteDir(s.l), "kiwi", "sessions"), "a file where a folder goes");
		const r = pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner });
		assert.deepEqual(r.failed, ["kiwi/sessions/f/a.jsonl: kiwi/sessions is not a directory; a pull does not write through links"]);
	});
});

describe("review round 1: CR-21-RUNDIR-ORPHAN", () => {
	it("backup remove also removes the replica's pull run folders, and only those", () => {
		const root = join(s.home, "usb");
		mkdirSync(root);
		addReplica(s.l, { id: "usb", kind: "local", path: root }, env());
		const killed = join(pullStateDir(s.l), "usb.run-AbC123");
		put(join(killed, "plain", "kiwi", "sessions", "f", "a.jsonl"), "decrypted");
		const other = join(pullStateDir(s.l), "usb2.run-AbC123");
		mkdirSync(other, { recursive: true });
		removeReplica(s.l, "usb", env());
		assert.equal(existsSync(killed), false);
		assert.equal(existsSync(other), true);
	});
});

describe("review round 1: CR-21-RCLONE-EXIT3", () => {
	for (const tool of ["aws", "rclone"] as const) {
		it(`${tool}: a prefix no backup wrote to is an error, not an empty pull`, () => {
			put(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi", "host.json"), "{}");
			addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bkt/typo", tool, encrypt: false }, env());
			const root = tool === "aws" ? "s3://bkt/typo" : "s3:bkt/typo";
			const io = Object.assign(captureIo(env()), { tools: processToolRunner });
			assert.equal(main(["sessions", "pull", "cloud"], io), 1);
			assert.equal(io.stderr, `pi-profile: cloud: no hosts/<host>/host.json at ${root}; nothing has been backed up there, or the bucket, prefix or remote is wrong\n`);
		});
	}
});

describe("review round 1: CR-21-TEST-GAPS", () => {
	it("the encrypted copy wins over the plain one, in either order", () => {
		const plain = { rel: "kiwi/sessions/f/x.jsonl", src: "/d/x.jsonl", encrypted: false };
		const sealed = { rel: "kiwi/sessions/f/x.jsonl", src: "/d/x.jsonl.age", encrypted: true };
		assert.equal(keepCopy(keepCopy(undefined, plain), sealed), sealed);
		assert.equal(keepCopy(keepCopy(undefined, sealed), plain), sealed);
		const key = keygen("id");
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		put(join(hosts, "kiwi/sessions/f/x.jsonl"), "plain, older\n");
		seal(join(hosts, "kiwi/sessions/f/x.jsonl.age"), "sealed, newer\n", key.pub);
		s3Replica("cloud", "rclone", key.pub);
		pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, identity: key.file });
		assert.equal(readFileSync(join(remoteDir(s.l), "kiwi/sessions/f/x.jsonl"), "utf8"), "sealed, newer\n");
	});

	it("a failed decrypt leaves no partial plaintext, even while the pull goes on", () => {
		const key = keygen("id");
		const hosts = join(s.home, "s3", "bkt", "pfx", "hosts");
		for (const n of ["a", "b", "c"]) seal(join(hosts, `kiwi/sessions/f/${n}.jsonl.age`), `${n}\n`, key.pub);
		s3Replica("cloud", "aws", key.pub);
		const outs: string[] = [];
		// age that, like real age on a damaged file, writes part of the plaintext before it fails on b.
		const run: ToolRunner = (cmd, args, opts) => {
			if (cmd !== "age") return processToolRunner(cmd, args, opts);
			for (const out of outs) assert.equal(existsSync(out), false, "a failed decrypt's plaintext was left behind");
			const out = args[args.indexOf("-o") + 1] ?? "";
			if (!out.endsWith("b.jsonl")) return processToolRunner(cmd, args, opts);
			writeFileSync(out, '{"half":');
			outs.push(out);
			return { status: 1, stdout: "", stderr: "age: error: unexpected EOF" };
		};
		const r = pullSessions(s.l, "cloud", { env: env(), runner: run, identity: key.file });
		assert.deepEqual(r.updated, ["kiwi/sessions/f/a.jsonl", "kiwi/sessions/f/c.jsonl"]);
		assert.deepEqual(r.failed, ["kiwi/sessions/f/b.jsonl.age: age could not decrypt it (exit 1); is the identity one of the replica's recipients?"]);
		assert.equal(outs.length, 1);
	});
});

describe("review round 1: age never asks for a passphrase", () => {
	function encryptedReplica(): void {
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: ["age1" + "q".repeat(58)] } }, env());
	}

	it("refuses a passphrase-protected identity up front, binary or armored, without naming it", () => {
		encryptedReplica();
		const never: ToolRunner = () => assert.fail("no tool runs for a refused pull");
		const header = "age-encryption.org/v1\n-> scrypt c2FsdHNhbHRzYWx0c2FsdA 18\nAAAA\n--- BBBB\n";
		const binary = join(s.home, "keys", "id-secret-name.age");
		put(binary, header + "\u0000\u0001ciphertext");
		const armored = join(s.home, "keys", "id-secret-armored.age");
		put(armored, `-----BEGIN AGE ENCRYPTED FILE-----\n${Buffer.from(header + "ciphertext").toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END AGE ENCRYPTED FILE-----\n`);
		for (const identity of [binary, armored]) {
			assert.throws(
				() => pullSessions(s.l, "usb", { env: env(), runner: never, identity }),
				(e: unknown) => e instanceof Refusal && /protected by a passphrase, which a pull cannot ask for/.test(e.message) && !e.message.includes("id-secret"),
			);
		}
		// A file encrypted to recipients (an X25519 stanza) is not refused as passphrase-protected.
		const plain = join(s.home, "keys", "id");
		put(plain, "# created: 2026-01-01T00:00:00Z\n# public key: age1x\nAGE-SECRET-KEY-1ABC\n");
		assert.doesNotThrow(() => pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, identity: plain }));
	});

	it("runs age with no controlling terminal and only the ciphertext on stdin", () => {
		const key = keygen("id");
		seal(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl.age"), "a\n", key.pub);
		s3Replica("cloud", "aws", key.pub);
		const seen: Array<{ readonly stdin?: number; readonly noTerminal?: boolean } | undefined> = [];
		const run: ToolRunner = (cmd, args, opts) => {
			if (cmd === "age") seen.push(opts);
			return processToolRunner(cmd, args, opts);
		};
		pullSessions(s.l, "cloud", { env: env(), runner: run, identity: key.file });
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.noTerminal, true);
		assert.equal(typeof seen[0]?.stdin, "number");
		// noTerminal: the tool leads a new session, so it has no terminal to open /dev/tty on.
		const probe = 'echo $$; cut -d" " -f6 /proc/$$/stat';
		const [pid, sid] = processToolRunner("sh", ["-c", probe], { noTerminal: true }).stdout.trim().split("\n");
		assert.equal(sid, pid);
		const [pid2, sid2] = processToolRunner("sh", ["-c", probe]).stdout.trim().split("\n");
		assert.notEqual(sid2, pid2);
	});
});

const SSH_KEYGEN = spawnSync("sh", ["-c", "command -v ssh-keygen"]).status === 0;
/** A time past the age at which a pull treats a `.pull-<hex>.tmp` as left behind. */
const LATER = (): number => Date.now() + 11 * 60 * 1000;

describe("review round 2: CR-21-R2-SSH-PASSPHRASE", () => {
	const PASSPHRASE = /protected by a passphrase, which a pull cannot ask for/;
	const never: ToolRunner = () => assert.fail("no tool runs for a refused pull");
	function encryptedReplica(): void {
		const root = join(s.home, "usb");
		put(join(root, "repository.json"), "{}");
		addReplica(s.l, { id: "usb", kind: "local", path: root, encrypt: { recipients: ["age1" + "q".repeat(58)] } }, env());
	}
	function refused(identity: string): void {
		assert.throws(
			() => pullSessions(s.l, "usb", { env: env(), runner: never, identity }),
			(e: unknown) => e instanceof Refusal && PASSPHRASE.test(e.message) && !e.message.includes("id-ssh"),
			identity,
		);
	}
	function accepted(identity: string): void {
		assert.doesNotThrow(() => pullSessions(s.l, "usb", { env: env(), runner: processToolRunner, identity }), identity);
	}
	/** An OpenSSH private key file whose header names `cipher`; the rest is filler. */
	function openssh(cipher: string): string {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(cipher.length);
		const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), len, Buffer.from(cipher), Buffer.alloc(64, 7)]);
		return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64").replace(/(.{70})/g, "$1\n")}\n-----END OPENSSH PRIVATE KEY-----\n`; // gitleaks:allow
	}
	const key = (name: string): string => join(s.home, "keys", name);

	it("refuses OpenSSH and PEM keys that carry a passphrase, from their header bytes, and takes plain ones", () => {
		encryptedReplica();
		put(key("id-ssh-aes"), openssh("aes256-ctr"));
		put(key("id-ssh-pem"), "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00112233445566778899AABBCCDDEEFF\n\nAAAA\n-----END RSA PRIVATE KEY-----\n"); // gitleaks:allow
		put(key("id-ssh-pkcs8"), "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"); // gitleaks:allow
		for (const name of ["id-ssh-aes", "id-ssh-pem", "id-ssh-pkcs8"]) refused(key(name));
		put(key("plain-openssh"), openssh("none"));
		put(key("plain-pem"), "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n");
		for (const name of ["plain-openssh", "plain-pem"]) accepted(key(name));
	});

	it("refuses keys ssh-keygen protected with a passphrase, and takes one without", { skip: !SSH_KEYGEN && "ssh-keygen is not installed" }, () => {
		encryptedReplica();
		mkdirSync(join(s.home, "keys"), { recursive: true });
		const gen = (name: string, pass: string, ...args: string[]): string => {
			const r = spawnSync("ssh-keygen", ["-q", "-N", pass, "-C", "", "-f", key(name), ...args], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
			return key(name);
		};
		refused(gen("id-ssh-ed25519", "correct horse", "-t", "ed25519"));
		refused(gen("id-ssh-ecdsa-pem", "correct horse", "-t", "ecdsa", "-m", "PEM"));
		refused(gen("id-ssh-ecdsa-pkcs8", "correct horse", "-t", "ecdsa", "-m", "PKCS8"));
		accepted(gen("plain-ed25519", "", "-t", "ed25519"));
	});

	it("maps age's 'could not read passphrase' to the same refusal, and passes none of age's message on", () => {
		const id = keygen("id");
		seal(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl.age"), "a\n", id.pub);
		s3Replica("cloud", "aws", id.pub);
		const run: ToolRunner = (cmd, args, opts) =>
			cmd === "age" ? { status: 1, stdout: "", stderr: `age: error: reading ${JSON.stringify(id.file)}: could not read passphrase: open /dev/tty: no such device\n` } : processToolRunner(cmd, args, opts);
		assert.throws(
			() => pullSessions(s.l, "cloud", { env: env(), runner: run, identity: id.file }),
			(e: unknown) => e instanceof Refusal && PASSPHRASE.test(e.message) && !e.message.includes("keys") && !e.message.includes("tty"),
		);
		assert.deepEqual(pulled(), []);
	});
});

describe("review round 2: CR-21-R2-SWEEP-SCOPE", () => {
	it("removes an old leftover in a folder no session lands in; keeps a fresh one, another user's, and anything through a link", () => {
		put(join(s.home, "s3", "bkt", "pfx", "hosts", "kiwi/sessions/f/a.jsonl"), "a\n");
		s3Replica("cloud", "aws");
		const remote = remoteDir(s.l);
		const idle = join(remote, "fig/sessions/g");
		const tmp = join(idle, ".pull-0123456789ab.tmp");
		put(tmp, "half a session");
		const outside = join(s.home, "outside");
		put(join(outside, ".pull-aaaaaaaaaaaa.tmp"), "not a pull's");
		symlinkSync(join(outside, ".pull-aaaaaaaaaaaa.tmp"), join(idle, ".pull-bbbbbbbbbbbb.tmp"));
		symlinkSync(outside, join(remote, "fig/sessions/lnk"));
		// Fresh: a pull may still be writing it.
		assert.deepEqual(pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner }).updated, ["kiwi/sessions/f/a.jsonl"]);
		assert.ok(existsSync(tmp), "a fresh leftover is kept");
		// Old, but not this user's.
		pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, hooks: { now: LATER(), uid: (process.getuid?.() ?? 0) + 1 } });
		assert.ok(existsSync(tmp), "another user's leftover is kept");
		// Old and this user's, though no session lands in its folder this run.
		pullSessions(s.l, "cloud", { env: env(), runner: processToolRunner, hooks: { now: LATER() } });
		assert.deepEqual(readdirSync(idle), [".pull-bbbbbbbbbbbb.tmp"]);
		assert.deepEqual(readdirSync(outside), [".pull-aaaaaaaaaaaa.tmp"]);
	});
});
