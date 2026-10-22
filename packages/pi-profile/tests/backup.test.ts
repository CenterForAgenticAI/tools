import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { parseBackupRun } from "../src/core/autobackup.ts";
import {
	addReplica,
	backupStateDir,
	loadReplicaState,
	processToolRunner,
	removeReplica,
	runBackup,
	sessionFiles,
	sourceStore,
	SSH_COMMAND,
	type ToolResult,
	type ToolRunner,
} from "../src/core/backup.ts";
import { configPath, loadConfig, parseConfig } from "../src/core/config.ts";
import { encrypts, parseReplica, parseReplicas } from "../src/core/replica.ts";
import { REMOTE_READ } from "../src/core/repo.ts";
import { Refusal } from "../src/core/result.ts";
import { addStore } from "../src/core/sessions.ts";
import { archiveSessions } from "../src/core/archive.ts";
import { captureIo, rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";
import { piSession } from "./sessionfixture.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });
const AGE = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

/** A primary store with two sessions, an auth.json and a stray file that must never leave. */
function store(): string {
	const root = join(s.home, "store");
	mkdirSync(join(root, "--home-alice--"), { recursive: true });
	writeFileSync(join(root, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n');
	writeFileSync(join(root, "--home-alice--", "2026_b.jsonl"), '{"b":1}\n');
	writeFileSync(join(root, "--home-alice--", "auth.json"), "secret");
	writeFileSync(join(root, "--home-alice--", "notes.txt"), "stray");
	mkdirSync(join(root, ".hidden"));
	writeFileSync(join(root, ".hidden", "x.jsonl"), "hidden");
	addStore(s.l, "main", root, env());
	return root;
}

function files(root: string, base = root): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(root, e.name), base) : [join(root, e.name).slice(base.length + 1)])).sort();
}

const ok = (stdout = ""): ToolResult => ({ status: 0, stdout, stderr: "" });

/**
 * Fake rsync, age, aws and rclone over the local filesystem. `s3://b/p` and
 * `remote:b/p` map to `<home>/s3/b/p`; `host:path` maps to `<home>/peer/path`.
 */
function fakeTools(calls: Array<[string, readonly string[]]>, opts: { advertised?: string; fail?: (cmd: string, args: readonly string[]) => ToolResult | undefined } = {}): ToolRunner {
	const local = (p: string): string => {
		if (p.startsWith("s3://")) return join(s.home, "s3", p.slice(5));
		const m = /^([a-z0-9-]+):(.*)$/.exec(p);
		if (m !== null && m[1] !== undefined && m[2] !== undefined) return m[1] === "s3" || m[1] === "r2" ? join(s.home, "s3", m[2]) : join(s.home, "peer", m[2]);
		return p;
	};
	return (cmd, args, run) => {
		calls.push([cmd, args]);
		const failed = opts.fail?.(cmd, args);
		if (failed !== undefined) return failed;
		if (cmd === "ssh") return ok(opts.advertised ?? "");
		if (cmd === "age") {
			const out = args[args.indexOf("-o") + 1] ?? "";
			assert.ok(run?.stdin !== undefined, "age reads the session from stdin");
			writeFileSync(out, `AGE[${readFileSync(run.stdin, "utf8")}]`);
			return ok();
		}
		const dd = args.indexOf("--");
		const positional = dd >= 0 ? args.slice(dd + 1) : args.filter((a) => !a.startsWith("-")).slice(cmd === "aws" ? 2 : 1);
		const [from = "", to = ""] = positional;
		const list = args.find((a) => a.startsWith("--files-from="));
		if (list !== undefined) {
			// Like rsync without -r: a listed directory is not descended into.
			assert.ok(!args.includes("-rt"), "the session list is sent without -r");
			for (const rel of readFileSync(list.slice("--files-from=".length), "utf8").split("\0").filter(Boolean)) {
				const dest = join(local(to), rel);
				mkdirSync(dirname(dest), { recursive: true });
				if (lstatSync(join(from, rel)).isFile()) cpSync(join(from, rel), dest);
			}
			return ok();
		}
		mkdirSync(local(to), { recursive: true });
		cpSync(from, local(to), { recursive: true });
		return ok();
	};
}

describe("replica config", () => {
	it("follows the model: s3 encrypts by default, an explicit setting wins (L13, L14)", () => {
		assert.equal(encrypts("s3", undefined), true);
		assert.equal(encrypts("local", undefined), false);
		assert.equal(encrypts("ssh", undefined), false);
		for (const k of ["local", "ssh", "s3"] as const) {
			assert.equal(encrypts(k, false), false);
			assert.equal(encrypts(k, { recipients: [AGE] }), true);
		}
	});

	it("parses each kind and copies only named fields", () => {
		assert.deepEqual(parseReplica({ id: "usb", kind: "local", path: "/media/usb" }), { id: "usb", kind: "local", path: "/media/usb" });
		assert.deepEqual(parseReplica({ id: "studio", kind: "ssh", host: "good-kite-studio", repository: "sessions", encrypt: false }), {
			id: "studio",
			kind: "ssh",
			host: "good-kite-studio",
			repository: "sessions",
			encrypt: false,
		});
		assert.deepEqual(parseReplica({ id: "s3", kind: "s3", uri: "s3://caair-pi/x/", encrypt: { recipients: [AGE] } }), {
			id: "s3",
			kind: "s3",
			uri: "s3://caair-pi/x",
			tool: "aws",
			encrypt: { recipients: [AGE] },
		});
	});

	it("refuses unsafe or incomplete replicas", () => {
		const bad: Array<[unknown, RegExp]> = [
			[{ kind: "local", path: "/x" }, /needs a valid id/],
			[{ id: "../x", kind: "local", path: "/x" }, /needs a valid id/],
			[{ id: "a", kind: "ftp" }, /kind must be local, ssh, s3/],
			[{ id: "a", kind: "local", path: "rel" }, /absolute/],
			[{ id: "a", kind: "local", path: "/x\u001b[2J" }, /control characters/],
			[{ id: "a", kind: "local", path: "/x", extra: 1 }, /unknown keys: extra/],
			[{ id: "a", kind: "ssh", host: "-oProxyCommand=x", repository: "r" }, /host must be/],
			[{ id: "a", kind: "ssh", host: "studio", repository: "../r" }, /repository must be/],
			[{ id: "a", kind: "s3", uri: "https://x", encrypt: false }, /uri must be/],
			[{ id: "a", kind: "s3", uri: "s3://bkt", encrypt: false, tool: "curl" }, /tool must be/],
			[{ id: "a", kind: "s3", uri: "s3://bkt", encrypt: false, remote: "r2" }, /needs tool rclone/],
			[{ id: "a", kind: "s3", uri: "s3://bkt" }, /encrypts by default; give age recipients/],
			[{ id: "a", kind: "local", path: "/x", encrypt: true }, /must be false or \{ recipients/],
			[{ id: "a", kind: "local", path: "/x", encrypt: { recipients: [] } }, /must be false or \{ recipients/],
			[{ id: "a", kind: "local", path: "/x", encrypt: { recipients: ["-R /etc/passwd"] } }, /not an age recipient/],
		];
		for (const [raw, re] of bad) assert.throws(() => parseReplica(raw), (e) => e instanceof Refusal && re.test(e.message), JSON.stringify(raw));
		assert.throws(() => parseReplicas({}), /must be a list/);
		assert.throws(() => parseReplicas([{ id: "a", kind: "local", path: "/x" }, { id: "a", kind: "local", path: "/y" }]), /used twice: a/);
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "box", sessionStores: {}, replicas: [{ id: "a" }] }), /replica a: kind/);
	});

	it("adds, lists and removes replicas in config.json", () => {
		addReplica(s.l, { id: "usb", kind: "local", path: "/media/usb" }, env());
		assert.throws(() => addReplica(s.l, { id: "usb", kind: "local", path: "/other" }, env()), /already exists: usb/);
		assert.deepEqual(loadConfig(s.l).replicas, [{ id: "usb", kind: "local", path: "/media/usb" }]);
		removeReplica(s.l, "usb", env());
		assert.deepEqual(loadConfig(s.l).replicas, []);
		assert.throws(() => removeReplica(s.l, "usb", env()), /does not exist: usb/);
	});
});

describe("source store", () => {
	it("picks --store, the default store, or the only store", () => {
		const c = (stores: string[], d?: string) => parseConfig({ schemaVersion: 1, hostId: "box", sessionStores: Object.fromEntries(stores.map((x) => [x, { path: `/${x}` }])), ...(d ? { defaultSessionStore: d } : {}) });
		assert.equal(sourceStore(c(["a"])).id, "a");
		assert.equal(sourceStore(c(["a", "b"], "b")).id, "b");
		assert.equal(sourceStore(c(["a", "b"]), "a").id, "a");
		assert.throws(() => sourceStore(c(["a", "b"])), /choose one with --store/);
		assert.throws(() => sourceStore(c([])), /no session store/);
		assert.throws(() => sourceStore(c(["a"]), "zz"), /does not exist: zz/);
	});

	it("lists only regular session files one folder deep (L8, L11)", () => {
		const root = store();
		symlinkSync("/etc/passwd", join(root, "--home-alice--", "link.jsonl"));
		mkdirSync(join(root, "--home-alice--", "deep"));
		writeFileSync(join(root, "--home-alice--", "deep", "x.jsonl"), "deep");
		writeFileSync(join(root, "top.jsonl"), "top");
		writeFileSync(join(root, "--home-alice--", "bad\u001b.jsonl"), "x");
		const r = sessionFiles(root);
		assert.deepEqual(r.files.map((f) => f.rel), ["--home-alice--/2026_a.jsonl", "--home-alice--/2026_b.jsonl"]);
		assert.equal(r.skipped, 1);
	});
});

describe("backup run", () => {
	it("rsyncs session files, and nothing else, into hosts/<hostId>/sessions (L6, L8)", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
		const calls: Array<[string, readonly string[]]> = [];
		const results = runBackup(s.l, { env: env(), runner: fakeTools(calls), now: () => new Date("2026-10-06T00:00:00Z") });
		assert.deepEqual(results, [{ id: "usb", ok: true, mode: "rsync", files: 2, bytes: 16, encrypted: false, held: [] }]);
		assert.deepEqual(files(usb), ["hosts/box/host.json", "hosts/box/sessions/--home-alice--/2026_a.jsonl", "hosts/box/sessions/--home-alice--/2026_b.jsonl"]);
		const host = JSON.parse(readFileSync(join(usb, "hosts/box/host.json"), "utf8")) as Record<string, unknown>;
		assert.equal(host.hostId, "box");
		assert.equal(host.lastBackupAt, "2026-10-06T00:00:00.000Z");
		// Every write lands under hosts/box (the subtree skeleton holds only box/sessions).
		for (const [cmd, args] of calls) {
			assert.equal(cmd, "rsync");
			const dest = args[args.length - 1] ?? "";
			assert.ok(dest === `${usb}/hosts/` || dest.startsWith(`${usb}/hosts/box/`), dest);
			assert.ok(args.includes("--no-links") && args.includes("--chmod=D700,F600"), "no links, private modes");
		}
		const main = calls.find(([, a]) => a.some((x) => x.startsWith("--files-from=")))?.[1] ?? [];
		assert.ok(main.includes("--append-verify") && main.includes("--from0"));
		assert.equal(main[main.indexOf("--") - 1]?.startsWith("--files-from="), true, "options end before the paths");
		assert.equal(loadReplicaState(s.l, "usb").lastOkAt, "2026-10-06T00:00:00.000Z");
	});

	it("accepts rsync exit 24, when a session is deleted mid-run", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
		const fail = (cmd: string, args: readonly string[]): ToolResult | undefined => (args.some((a) => a.startsWith("--files-from")) ? { status: 24, stdout: "", stderr: "vanished" } : undefined);
		assert.equal(runBackup(s.l, { env: env(), runner: fakeTools([], { fail }) })[0]?.ok, true);
	});

	it("refuses an unmounted or overlapping local replica, and keeps going with the others", () => {
		const root = store();
		const good = join(s.home, "good");
		mkdirSync(good);
		addReplica(s.l, { id: "gone", kind: "local", path: join(s.home, "unmounted") }, env());
		addReplica(s.l, { id: "inner", kind: "local", path: join(root, "--home-alice--") }, env());
		addReplica(s.l, { id: "good", kind: "local", path: good }, env());
		const r = runBackup(s.l, { env: env(), runner: fakeTools([]) });
		assert.deepEqual(r.map((x) => [x.id, x.ok]), [["gone", false], ["inner", false], ["good", true]]);
		assert.match(r[0]?.ok === false ? r[0].error : "", /does not exist; is the disk mounted/);
		assert.match(r[1]?.ok === false ? r[1].error : "", /overlaps the session store/);
		assert.ok(!existsSync(join(s.home, "unmounted")), "an unmounted disk's mount point is never created");
		assert.match(loadReplicaState(s.l, "gone").lastError ?? "", /is the disk mounted/);
	});

	it("auth.json.bak-* is a secret path: never a session file, and a store holding one is refused (L8)", () => {
		const root = store();
		writeFileSync(join(root, "--home-alice--", "auth.json.bak-20260101-000000-aaaaaaaaaaaa.jsonl"), "secret");
		assert.deepEqual(sessionFiles(root).files.map((f) => f.rel), ["--home-alice--/2026_a.jsonl", "--home-alice--/2026_b.jsonl"]);
		addReplica(s.l, { id: "usb", kind: "local", path: "/nowhere" }, env());
		writeFileSync(join(root, "auth.json.bak-20260101-000000-aaaaaaaaaaaa"), "secret");
		assert.throws(() => runBackup(s.l, { env: env(), runner: fakeTools([]) }), (e) => e instanceof Refusal && /contains a backup of auth.json/.test(e.message));
	});

	it("refuses a store that holds auth.json or the state directory (L8, L10)", () => {
		const root = store();
		addReplica(s.l, { id: "usb", kind: "local", path: "/nowhere" }, env());
		writeFileSync(join(root, "auth.json"), "{}");
		assert.throws(() => runBackup(s.l, { env: env(), runner: fakeTools([]) }), (e) => e instanceof Refusal && /contains auth.json/.test(e.message));
		const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as Record<string, unknown>;
		cfg.sessionStores = { main: { path: s.home } };
		writeFileSync(configPath(s.l), JSON.stringify(cfg));
		assert.throws(() => runBackup(s.l, { env: env(), runner: fakeTools([]) }), /contains pi-profile's state directory/);
	});

	it("reads an ssh replica's repository path from the peer, then rsyncs over BatchMode ssh", () => {
		store();
		const advertised = JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path: "/srv/pi-repo" } } });
		addReplica(s.l, { id: "studio", kind: "ssh", host: "good-kite-studio", repository: "sessions" }, env());
		const calls: Array<[string, readonly string[]]> = [];
		const r = runBackup(s.l, { env: env(), runner: fakeTools(calls, { advertised }) });
		assert.equal(r[0]?.ok, true);
		assert.deepEqual(calls[0], ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "good-kite-studio", REMOTE_READ]]);
		for (const [cmd, args] of calls.slice(1)) {
			assert.equal(cmd, "rsync");
			assert.equal(args[args.indexOf("-e") + 1], SSH_COMMAND);
			assert.match(args[args.length - 1] ?? "", /^good-kite-studio:\/srv\/pi-repo\/hosts\//);
		}
		assert.deepEqual(files(join(s.home, "peer/srv/pi-repo")), ["hosts/box/host.json", "hosts/box/sessions/--home-alice--/2026_a.jsonl", "hosts/box/sessions/--home-alice--/2026_b.jsonl"]);
	});

	it("refuses an ssh repository that is missing or has a path unsafe for a remote shell", () => {
		store();
		addReplica(s.l, { id: "studio", kind: "ssh", host: "studio", repository: "sessions" }, env());
		const run = (advertised: string): string => {
			const r = runBackup(s.l, { env: env(), runner: fakeTools([], { advertised }) })[0];
			return r?.ok === false ? r.error : "ok";
		};
		assert.match(run(""), /does not advertise repository sessions/);
		assert.match(run("{nope"), /advertised.json is not valid JSON/);
		assert.match(run(JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path: "/srv/a;rm -rf ~" } } })), /will not pass to a remote shell/);
		assert.match(run(JSON.stringify({ schemaVersion: 1, repositories: { sessions: { path: "/srv/my repo" } } })), /will not pass to a remote shell/);
		const r = runBackup(s.l, { env: env(), runner: fakeTools([], { fail: (c) => (c === "ssh" ? { status: 255, stdout: "", stderr: "x\nHost key verification \u001b[2Jfailed." } : undefined) }) })[0];
		assert.equal(r?.ok === false ? r.error : "", "ssh studio failed: Host key verification ?[2Jfailed.");
	});

	it("encrypts each changed file with age and uploads only changes to s3", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket/pi", encrypt: { recipients: [AGE] } }, env());
		const calls: Array<[string, readonly string[]]> = [];
		const first = runBackup(s.l, { env: env(), runner: fakeTools(calls) });
		assert.deepEqual(first, [{ id: "cloud", ok: true, mode: "staged", files: 2, bytes: 16, held: [], encrypted: true }]);
		const bucket = join(s.home, "s3/bucket/pi");
		assert.deepEqual(files(bucket), ["hosts/box/host.json", "hosts/box/sessions/--home-alice--/2026_a.jsonl.age", "hosts/box/sessions/--home-alice--/2026_b.jsonl.age"]);
		assert.equal(readFileSync(join(bucket, "hosts/box/sessions/--home-alice--/2026_a.jsonl.age"), "utf8"), 'AGE[{"a":1}\n]');
		const age = calls.find(([c]) => c === "age")?.[1] ?? [];
		assert.deepEqual(age.slice(0, 3), ["--encrypt", "-r", AGE]);
		const up = calls.find(([c]) => c === "aws")?.[1] ?? [];
		assert.deepEqual(up.slice(0, 5), ["s3", "cp", "--recursive", "--no-follow-symlinks", "--only-show-errors"]);
		assert.equal(up[up.length - 1], "s3://bucket/pi/hosts/box/sessions");

		// Nothing changed: nothing is encrypted or sent again.
		calls.length = 0;
		assert.equal((runBackup(s.l, { env: env(), runner: fakeTools(calls) })[0] as { files: number }).files, 0);
		assert.equal(calls.filter(([c]) => c === "age").length, 0);

		// One session grows: only it is sent.
		writeFileSync(join(root, "--home-alice--", "2026_b.jsonl"), '{"b":1}\n{"b":2}\n');
		utimesSync(join(root, "--home-alice--", "2026_b.jsonl"), new Date(), new Date(Date.now() + 5000));
		calls.length = 0;
		assert.equal((runBackup(s.l, { env: env(), runner: fakeTools(calls) })[0] as { files: number }).files, 1);
		assert.deepEqual(calls.filter(([c]) => c === "age").map(([, a]) => a[a.length - 1]?.endsWith("/--home-alice--/2026_b.jsonl.age")), [true]);
	});

	it("resends everything when the replica's recipients change", () => {
		store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		// Change the recipients in config.json directly, keeping the saved state.
		const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as { replicas: Array<{ encrypt: unknown }> };
		const other = "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj";
		(cfg.replicas[0] as { encrypt: unknown }).encrypt = { recipients: [other] };
		writeFileSync(configPath(s.l), JSON.stringify(cfg));
		assert.equal(Object.keys(loadReplicaState(s.l, "cloud").files ?? {}).length, 2, "state survives the edit");
		assert.equal((runBackup(s.l, { env: env(), runner: fakeTools([]) })[0] as { files: number }).files, 2);
	});

	it("saves progress after each batch, so a failed upload resends only the rest", () => {
		store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: false }, env());
		let uploads = 0;
		const fail = (cmd: string): ToolResult | undefined => (cmd === "aws" && ++uploads === 2 ? { status: 1, stdout: "", stderr: "upload failed: network" } : undefined);
		const r = runBackup(s.l, { env: env(), runner: fakeTools([], { fail }), batchBytes: 1 })[0];
		assert.equal(r?.ok === false ? r.error : "", "aws s3 cp failed: upload failed: network");
		assert.deepEqual(Object.keys(loadReplicaState(s.l, "cloud").files ?? {}), ["--home-alice--/2026_a.jsonl"]);
		const calls: Array<[string, readonly string[]]> = [];
		assert.equal((runBackup(s.l, { env: env(), runner: fakeTools(calls), batchBytes: 1 })[0] as { files: number }).files, 1);
		assert.deepEqual(files(join(s.home, "s3/bucket")), ["hosts/box/host.json", "hosts/box/sessions/--home-alice--/2026_a.jsonl", "hosts/box/sessions/--home-alice--/2026_b.jsonl"]);
	});

	it("encrypts a local replica only when told to, and uses rclone with a named remote", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb, encrypt: { recipients: [AGE] } }, env());
		addReplica(s.l, { id: "r2", kind: "s3", uri: "s3://bkt/p", tool: "rclone", remote: "r2", encrypt: false }, env());
		const calls: Array<[string, readonly string[]]> = [];
		const r = runBackup(s.l, { env: env(), runner: fakeTools(calls) });
		assert.deepEqual(r.map((x) => x.ok && x.mode), ["staged", "staged"]);
		assert.ok(files(usb).includes("hosts/box/sessions/--home-alice--/2026_a.jsonl.age"));
		const rc = calls.find(([c]) => c === "rclone")?.[1] ?? [];
		assert.deepEqual([rc[0], rc[1], rc[rc.length - 1]], ["copy", "--", "r2:bkt/p/hosts/box/sessions"]);
		assert.deepEqual(files(join(s.home, "s3/bkt/p")), ["hosts/box/host.json", "hosts/box/sessions/--home-alice--/2026_a.jsonl", "hosts/box/sessions/--home-alice--/2026_b.jsonl"]);
	});

	it("keeps machine-local state out of every replica (L10)", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb, encrypt: false }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		assert.ok(existsSync(join(backupStateDir(s.l), "usb.json")));
		assert.ok(files(usb).every((f) => !f.includes("state") && !f.endsWith("usb.json")));
		assert.deepEqual(readdirSync(backupStateDir(s.l)), ["usb.json"], "scratch directories are removed");
		assert.equal((statSync(backupStateDir(s.l)).mode & 0o777).toString(8), "700");
	});

	it("never replaces a staged copy with a smaller session, and warns", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		const a = join(root, "--home-alice--", "2026_a.jsonl");
		truncateSync(a, 0);
		utimesSync(a, new Date(), new Date(Date.now() + 5000));
		const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(r?.ok === true && [r.files, r.held], [0, ["--home-alice--/2026_a.jsonl"]]);
		assert.equal(readFileSync(join(s.home, "s3/bucket/hosts/box/sessions/--home-alice--/2026_a.jsonl.age"), "utf8"), 'AGE[{"a":1}\n]');
		// Held again next time, not forgotten; --full does not override it either.
		const again = runBackup(s.l, { env: env(), runner: fakeTools([]), full: true })[0];
		assert.deepEqual(again?.ok === true && again.held, ["--home-alice--/2026_a.jsonl"]);
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run"], io), 0);
		assert.match(io.stderr, /cloud: warning: 1 sessions are smaller than their backup and were not sent: --home-alice--\/2026_a.jsonl/);
	});

	it("keeps the full copy of an archived session and does not warn about its stub; a stub with new lines still warns", { skip: rsyncSkip }, () => {
		const root = store();
		const a = join(root, "--home-alice--", "2026_a.jsonl");
		const old = Date.now() - 40 * 86_400_000;
		writeFileSync(a, piSession({ id: "a", cwd: "/nowhere", name: "a", prompts: ["first", "x".repeat(4000), "last"], t0: old }));
		utimesSync(a, old / 1000, old / 1000);
		const full = readFileSync(a, "utf8");
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		const sent = join(s.home, "s3/bucket/hosts/box/sessions/--home-alice--/2026_a.jsonl.age");
		assert.equal(readFileSync(sent, "utf8"), `AGE[${full}]`);
		const vol = join(s.home, "volume");
		mkdirSync(vol);
		const archived = archiveSessions(s.l, root, { store: { kind: "local", path: vol }, olderThanDays: 30, keepLocalDays: 0 }, { host: "box", apply: true, run: processToolRunner });
		assert.deepEqual(archived.outcomes.filter((o) => o.kind === "stub").map((o) => o.rel), ["--home-alice--/2026_a.jsonl"]);
		const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(r?.ok === true && [r.files, r.held], [0, []], "the stub is expected: no warning");
		assert.equal(readFileSync(sent, "utf8"), `AGE[${full}]`, "the replica keeps the full session");
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run"], io), 0);
		assert.doesNotMatch(io.stderr, /smaller than their backup/);
		// Lines Pi adds to the stub are not in any copy yet: that is still worth a warning.
		appendFileSync(a, JSON.stringify({ type: "message", id: "n", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "new", timestamp: 1 } }) + "\n");
		const grown = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(grown?.ok === true && grown.held, ["--home-alice--/2026_a.jsonl"]);
	});

	it("after the recipients change, does not warn about a stub whose archived copy the replica holds, and still warns about a stale one", { skip: rsyncSkip }, () => {
		const root = store();
		const old = Date.now() - 40 * 86_400_000;
		const path = (n: string): string => join(root, "--home-alice--", `2026_${n}.jsonl`);
		for (const n of ["a", "b"]) {
			writeFileSync(path(n), piSession({ id: n, cwd: "/nowhere", name: n, prompts: ["first", "x".repeat(4000), "last"], t0: old }));
			utimesSync(path(n), old / 1000, old / 1000);
		}
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		const sent = (n: string): string => join(s.home, `s3/bucket/hosts/box/sessions/--home-alice--/2026_${n}.jsonl.age`);
		const full = readFileSync(sent("a"), "utf8");
		// b changes after the backup and before the archive, at the same size: the replica's copy of b is not the archived one.
		writeFileSync(path("b"), readFileSync(path("b"), "utf8").replace("first", "FIRST"));
		utimesSync(path("b"), (old + 5000) / 1000, (old + 5000) / 1000);
		const vol = join(s.home, "volume");
		mkdirSync(vol);
		const archived = archiveSessions(s.l, root, { store: { kind: "local", path: vol }, olderThanDays: 30, keepLocalDays: 0 }, { host: "box", apply: true, run: processToolRunner });
		assert.deepEqual(archived.outcomes.filter((o) => o.kind === "stub").map((o) => o.rel).sort(), ["a", "b"].map((n) => `--home-alice--/2026_${n}.jsonl`));
		const cfg = JSON.parse(readFileSync(configPath(s.l), "utf8")) as { replicas: Array<{ encrypt: unknown }> };
		(cfg.replicas[0] as { encrypt: unknown }).encrypt = { recipients: ["age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj"] };
		writeFileSync(configPath(s.l), JSON.stringify(cfg));
		for (const when of ["first run after the change", "next run"]) {
			const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
			assert.deepEqual(r?.ok === true && [r.files, r.held], [0, ["--home-alice--/2026_b.jsonl"]], when);
		}
		assert.equal(readFileSync(sent("a"), "utf8"), full, "the replica keeps the full session");
	});

	it("warns about the stub of a session whose replica copy is older than the archived copy", { skip: rsyncSkip }, () => {
		const root = store();
		const old = Date.now() - 40 * 86_400_000;
		const line = JSON.stringify({ type: "message", id: "n", parentId: null, timestamp: "2026-11-01T00:00:00.000Z", message: { role: "user", content: "new", timestamp: 1 } }) + "\n";
		const path = (n: string): string => join(root, "--home-alice--", `2026_${n}.jsonl`);
		// a: Pi adds a line (size and time change); b: a line, but the old time; c: the same size, another time; d: unchanged.
		for (const n of ["a", "b", "c", "d"]) {
			writeFileSync(path(n), piSession({ id: n, cwd: "/nowhere", name: n, prompts: ["first", "x".repeat(4000), "last"], t0: old }));
			utimesSync(path(n), old / 1000, old / 1000);
		}
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		const sent = (n: string): string => join(s.home, `s3/bucket/hosts/box/sessions/--home-alice--/2026_${n}.jsonl.age`);
		const first = readFileSync(sent("a"), "utf8");
		// The next backup does not run before the archive does.
		appendFileSync(path("a"), line);
		utimesSync(path("a"), (old + 5000) / 1000, (old + 5000) / 1000);
		appendFileSync(path("b"), line);
		utimesSync(path("b"), old / 1000, old / 1000);
		writeFileSync(path("c"), readFileSync(path("c"), "utf8").replace("first", "FIRST"));
		utimesSync(path("c"), (old + 5000) / 1000, (old + 5000) / 1000);
		const vol = join(s.home, "volume");
		mkdirSync(vol);
		const archived = archiveSessions(s.l, root, { store: { kind: "local", path: vol }, olderThanDays: 30, keepLocalDays: 0 }, { host: "box", apply: true, run: processToolRunner });
		assert.deepEqual(archived.outcomes.filter((o) => o.kind === "stub").map((o) => o.rel).sort(), ["a", "b", "c", "d"].map((n) => `--home-alice--/2026_${n}.jsonl`));
		const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(r?.ok === true && [r.files, [...r.held].sort()], [0, ["a", "b", "c"].map((n) => `--home-alice--/2026_${n}.jsonl`)], "the replica lacks what was archived: warn");
		assert.equal(readFileSync(sent("a"), "utf8"), first, "the stub is still not sent");
		const again = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(again?.ok === true && [...again.held].sort(), ["a", "b", "c"].map((n) => `--home-alice--/2026_${n}.jsonl`), "still warned next time");
	});

	it("warns about a stub the archive list does not name", { skip: rsyncSkip }, () => {
		const root = store();
		const a = join(root, "--home-alice--", "2026_a.jsonl");
		const old = Date.now() - 40 * 86_400_000;
		writeFileSync(a, piSession({ id: "a", cwd: "/nowhere", name: "a", prompts: ["first", "x".repeat(4000), "last"], t0: old }));
		utimesSync(a, old / 1000, old / 1000);
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: { recipients: [AGE] } }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		const vol = join(s.home, "volume");
		mkdirSync(vol);
		archiveSessions(s.l, root, { store: { kind: "local", path: vol }, olderThanDays: 30, keepLocalDays: 0 }, { host: "box", apply: true, run: processToolRunner });
		const list = join(root, ".pi-profile-archive.json");
		const m = JSON.parse(readFileSync(list, "utf8")) as { sessions: Record<string, { sha256: string; stubbedAt?: string }> };
		const entry = m.sessions["--home-alice--/2026_a.jsonl"];
		assert.ok(entry?.stubbedAt !== undefined);
		for (const wrong of [{ ...entry, sha256: "0".repeat(64) }, { ...entry, stubbedAt: undefined }]) {
			writeFileSync(list, JSON.stringify({ ...m, sessions: { "--home-alice--/2026_a.jsonl": wrong } }));
			const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
			assert.deepEqual(r?.ok === true && r.held, ["--home-alice--/2026_a.jsonl"], JSON.stringify(wrong));
		}
		rmSync(list);
		const r = runBackup(s.l, { env: env(), runner: fakeTools([]) })[0];
		assert.deepEqual(r?.ok === true && r.held, ["--home-alice--/2026_a.jsonl"], "no archive list");
	});

	it("--full resends every staged file; removed sessions drop out of the state", () => {
		const root = store();
		addReplica(s.l, { id: "cloud", kind: "s3", uri: "s3://bucket", encrypt: false }, env());
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		assert.equal((runBackup(s.l, { env: env(), runner: fakeTools([]), full: true })[0] as { files: number }).files, 2);
		rmSync(join(root, "--home-alice--", "2026_b.jsonl"));
		runBackup(s.l, { env: env(), runner: fakeTools([]) });
		assert.deepEqual(Object.keys(loadReplicaState(s.l, "cloud").files ?? {}), ["--home-alice--/2026_a.jsonl"]);
		assert.ok(existsSync(join(s.home, "s3/bucket/hosts/box/sessions/--home-alice--/2026_b.jsonl")), "a backup never deletes");
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run", "--full"], io), 0);
		assert.match(io.stdout, /cloud: sent 1 changed files/);
	});

	it("reads only the scanned file: a session swapped for a link, a directory or another file, or deleted, is not sent (L8, L11)", () => {
		const root = store();
		const dir = join(root, "--home-alice--");
		writeFileSync(join(dir, "2026_c.jsonl"), '{"c":1}\n');
		writeFileSync(join(dir, "2026_d.jsonl"), '{"d":1}\n');
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb, encrypt: { recipients: [AGE] } }, env());
		// The skeleton rsync runs after the scan and before anything is staged.
		let swapped = false;
		const swap = (cmd: string): undefined => {
			if (cmd !== "rsync" || swapped) return undefined;
			swapped = true;
			rmSync(join(dir, "2026_a.jsonl"));
			symlinkSync(join(dir, "auth.json"), join(dir, "2026_a.jsonl"));
			rmSync(join(dir, "2026_b.jsonl"));
			mkdirSync(join(dir, "2026_b.jsonl"));
			writeFileSync(join(dir, "2026_b.jsonl", "auth.json"), "secret");
			writeFileSync(join(dir, "other"), "secret");
			renameSync(join(dir, "other"), join(dir, "2026_c.jsonl"));
			rmSync(join(dir, "2026_d.jsonl"));
			return undefined;
		};
		const r = runBackup(s.l, { env: env(), runner: fakeTools([], { fail: swap }) })[0];
		assert.deepEqual(r?.ok === true && r.files, 0);
		assert.deepEqual(files(usb), ["hosts/box/host.json"]);
		assert.deepEqual(loadReplicaState(s.l, "usb").files, {});
	});

	it("refuses a second run, or a removal, while a run holds the lock", () => {
		store();
		addReplica(s.l, { id: "usb", kind: "local", path: join(s.home, "usb") }, env());
		mkdirSync(backupStateDir(s.l), { recursive: true });
		// A live process that is not this one holds the backup lock.
		writeFileSync(join(backupStateDir(s.l), ".pi-profile.lock"), `${String(process.ppid)} abc\n`);
		const busy = (e: unknown): boolean => e instanceof Refusal && /another backup run is in progress \(process \d+\)/.test(e.message);
		assert.throws(() => runBackup(s.l, { env: env(), runner: fakeTools([]) }), busy);
		assert.throws(() => removeReplica(s.l, "usb", env()), busy);
		assert.equal(loadConfig(s.l, env()).replicas?.length, 1);
	});

	it("bounds every connection and leaves the shared hosts/ directory's times alone", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
		const calls: Array<[string, readonly string[]]> = [];
		runBackup(s.l, { env: env(), runner: fakeTools(calls) });
		const rsyncs = calls.filter(([c]) => c === "rsync").map(([, a]) => a);
		assert.ok(rsyncs.every((a) => a.includes("--timeout=600")));
		assert.ok(rsyncs[0]?.includes("--omit-dir-times"), "skeleton run");
		assert.match(SSH_COMMAND, /ServerAliveInterval=15 -o ServerAliveCountMax=4/);
	});

	it("refuses with no replicas, an unknown replica, or a missing store", () => {
		assert.throws(() => runBackup(s.l, { env: env() }), /no replicas/);
		addReplica(s.l, { id: "usb", kind: "local", path: "/x" }, env());
		assert.throws(() => runBackup(s.l, { env: env(), replica: "zz" }), /replica does not exist: zz/);
		addStore(s.l, "main", join(s.home, "absent"), env());
		assert.throws(() => runBackup(s.l, { env: env() }), /session store main does not exist/);
	});

	it("reports a missing tool by name", () => {
		const r = processToolRunner("pi-profile-no-such-tool", []);
		assert.equal(r.error, "pi-profile-no-such-tool is not installed");
	});
});

const hasRsync = rsyncSkip === false;

describe("the tool runner", () => {
	it("runs a tool in / when the folder pi-profile was started in has been removed", () => {
		const here = process.cwd();
		const gone = join(s.home, "gone");
		mkdirSync(gone);
		process.chdir(gone);
		rmSync(gone, { recursive: true });
		let r;
		try {
			r = processToolRunner("sh", ["-c", "pwd -P"]);
		} finally {
			process.chdir(here);
		}
		assert.deepEqual([r.status, r.stdout], [0, "/\n"]);
		assert.equal(processToolRunner("sh", ["-c", "pwd -P"]).stdout, realpathSync(here) + "\n", "a folder that is still there is kept");
	});
});

describe("backup run with the real rsync", { skip: hasRsync ? false : "rsync is not installed" }, () => {
	it("copies and then appends to a growing session, without links or secrets", () => {
		const root = store();
		symlinkSync("/etc/hostname", join(root, "--home-alice--", "link.jsonl"));
		const usb = join(s.home, "usb drive");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
		assert.deepEqual(runBackup(s.l, { env: env() }).map((r) => r.ok), [true]);
		const out = join(usb, "hosts/box/sessions/--home-alice--");
		assert.deepEqual(readdirSync(out).sort(), ["2026_a.jsonl", "2026_b.jsonl"]);
		assert.equal((statSync(out).mode & 0o777).toString(8), "700");
		writeFileSync(join(root, "--home-alice--", "2026_a.jsonl"), '{"a":1}\n{"a":2}\n');
		assert.deepEqual(runBackup(s.l, { env: env() }).map((r) => r.ok), [true]);
		assert.equal(readFileSync(join(out, "2026_a.jsonl"), "utf8"), '{"a":1}\n{"a":2}\n');
		assert.ok(!existsSync(join(usb, "hosts/box/sessions/--home-alice--/auth.json")));
	});

	it("does not descend into a listed session that became a directory, writes locally to a path with ':', and keeps a longer copy", () => {
		const root = store();
		const usb = join(s.home, "a:b");
		mkdirSync(usb);
		addReplica(s.l, { id: "usb", kind: "local", path: usb }, env());
		assert.deepEqual(runBackup(s.l, { env: env() }).map((r) => r.ok), [true]);
		const out = join(usb, "hosts/box/sessions/--home-alice--");
		assert.ok(existsSync(join(out, "2026_a.jsonl")), "':' after the first '/' is a local path");
		const b = join(root, "--home-alice--", "2026_b.jsonl");
		const swap: ToolRunner = (cmd, args, o) => {
			if (args.some((a) => a.startsWith("--files-from="))) {
				rmSync(b);
				mkdirSync(b);
				writeFileSync(join(b, "auth.json"), "secret");
			}
			return processToolRunner(cmd, args, o);
		};
		writeFileSync(join(root, "--home-alice--", "2026_a.jsonl"), "{}\n");
		assert.deepEqual(runBackup(s.l, { env: env(), runner: swap }).map((r) => r.ok), [true]);
		assert.ok(!existsSync(join(out, "2026_b.jsonl", "auth.json")));
		assert.equal(readFileSync(join(out, "2026_a.jsonl"), "utf8"), '{"a":1}\n', "--append-verify never shortens a copy");
	});
});

describe("backup CLI", () => {
	it("adds, lists, runs and removes a replica", () => {
		store();
		const usb = join(s.home, "usb");
		mkdirSync(usb);
		const io = captureIo(env());
		assert.equal(main(["backup", "add", "usb", "local", usb], io), 0);
		assert.equal(main(["backup", "add", "cloud", "s3", "s3://bkt", "--encrypt-to", AGE, "--tool", "rclone", "--remote", "r2"], io), 0);
		assert.equal(main(["backup", "list"], io), 0);
		assert.match(io.stdout, new RegExp(`usb\\tlocal\\t${usb}\\tnot encrypted\\tnever run`));
		assert.match(io.stdout, /cloud\ts3\ts3:\/\/bkt \(rclone remote r2\)\tencrypted\tnever run/);
		const run = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run", "--replica", "usb"], run), 0);
		assert.equal(run.stdout, "usb: checked 2 files\n");
		const quiet = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run", "--quiet"], quiet), 0);
		assert.equal(quiet.stdout, "");
		assert.equal(main(["backup", "remove", "cloud"], io), 0);
		assert.match(io.stdout, /removed replica cloud; its copies are kept/);
	});

	it("exits 1 when a replica fails, 2 on a bad request", () => {
		store();
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "add", "gone", "local", join(s.home, "nope")], io), 0);
		assert.equal(main(["backup", "run"], io), 1);
		assert.match(io.stderr, /gone: failed: .*is the disk mounted/);
		assert.equal(main(["backup", "add", "x", "s3", "s3://bkt"], io), 2);
		assert.match(io.stderr, /encrypts by default/);
		assert.equal(main(["backup", "add", "x", "local", "/x", "--tool", "aws"], io), 2);
		assert.equal(main(["backup", "add", "x", "s3", "s3://bkt", "--encrypt-to", AGE, "--no-encrypt"], io), 2);
		assert.equal(main(["backup", "add", "x", "ftp", "/x"], io), 2);
		assert.equal(main(["backup", "nope"], io), 2);
		assert.equal(main(["backup", "list", "extra"], io), 2);
	});

	it("--json prints one line of results, or the refusal, for /profile backup", () => {
		const none = captureIo(env());
		assert.equal(main(["backup", "run", "--json"], none), 2);
		assert.equal(none.stdout, `${JSON.stringify({ refused: "no replicas; add one with: pi-profile backup add" })}\n`);
		store();
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "add", "usb", "local", join(s.home, "usb")], io), 0);
		mkdirSync(join(s.home, "usb"));
		assert.equal(main(["backup", "add", "gone", "local", join(s.home, "nope")], io), 0);
		const run = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		assert.equal(main(["backup", "run", "--json"], run), 1);
		const out = run.stdout.trim().split("\n");
		assert.equal(out.length, 1);
		const outcome = parseBackupRun(run.stdout, 1);
		assert.equal(outcome.kind, "results");
		const results = outcome.kind === "results" ? outcome.results : [];
		assert.deepEqual(results.map((r) => [r.id, r.ok]), [["usb", true], ["gone", false]]);
		assert.deepEqual(results[0]?.ok === true && [results[0].mode, results[0].files], ["rsync", 2]);
		assert.equal(main(["backup", "run", "--json", "--quiet"], run), 2);
		assert.equal(main(["backup", "run", "--json", "--auto"], run), 2);
	});

	it("reads --json output strictly", () => {
		const good = JSON.stringify({ results: [{ id: "usb", ok: true, mode: "rsync", files: 1, bytes: 2, encrypted: false, held: [] }] });
		assert.equal(parseBackupRun(good, 0).kind, "results");
		assert.equal(parseBackupRun(`noise\n${good}\n`, 1).kind, "results");
		assert.deepEqual(parseBackupRun(JSON.stringify({ refused: "x" }), 2), { kind: "refused", message: "x" });
		// A refusal is only trusted from a refused run; a crash's exit code is not 2.
		assert.deepEqual(parseBackupRun(JSON.stringify({ refused: "x" }), 1), { kind: "failed" });
		assert.deepEqual(parseBackupRun(good, null), { kind: "failed" });
		assert.deepEqual(parseBackupRun("", 1), { kind: "failed" });
		assert.deepEqual(parseBackupRun(JSON.stringify({ results: [] }), 0), { kind: "failed" });
		assert.deepEqual(parseBackupRun(JSON.stringify({ results: [{ id: "usb", ok: true, mode: "rsync" }] }), 0), { kind: "failed" });
	});

	it("lists the last run's result", () => {
		store();
		const io = Object.assign(captureIo(env()), { tools: fakeTools([]) });
		main(["backup", "add", "gone", "local", join(s.home, "nope")], io);
		main(["backup", "run"], io);
		const list = captureIo(env());
		main(["backup", "list"], list);
		assert.match(list.stdout, /gone\tlocal\t.*\tlast run failed: .*is the disk mounted/);
	});
});
