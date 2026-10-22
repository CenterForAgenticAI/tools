import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { launchdPlist, scheduleFiles, systemdUnits } from "../src/core/archiveschedule.ts";
import { stableNode } from "../src/core/archivecli.ts";
import { loadManifest } from "../src/core/archive.ts";
import { readStub } from "../src/core/sessionfile.ts";
import { captureIo, rsyncSkip, sandbox, type Sandbox } from "./helpers.ts";
import { piSession } from "./sessionfixture.ts";

const DAY = 86_400_000;
let s: Sandbox;
let store: string;
let root: string;

beforeEach(() => {
	s = sandbox();
	store = join(s.home, "agent", "sessions");
	root = join(s.home, "volume");
	mkdirSync(store, { recursive: true });
	mkdirSync(root);
});
afterEach(() => s.cleanup());

function config(extra: Record<string, unknown> = {}): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(join(s.home, "pi-profile", "config.json"), JSON.stringify({ schemaVersion: 1, hostId: "box", sessionStores: {}, archive: { store: { kind: "local", path: root }, keepLocalDays: 0 }, ...extra }));
}

function cli(...args: Array<string | Record<string, string>>): ReturnType<typeof captureIo> & { code: number } {
	const extra = args.find((a): a is Record<string, string> => typeof a !== "string") ?? {};
	const argv = args.filter((a): a is string => typeof a === "string");
	const io = captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1", HOME: s.home, ...extra });
	const code = main(argv, io);
	return Object.assign(io, { code });
}

function old(rel: string, days: number, id: string): string {
	const path = join(store, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, piSession({ id, cwd: "/nowhere", name: "n " + id, prompts: ["p " + id], t0: Date.now() - days * DAY }));
	const t = (Date.now() - days * DAY) / 1000;
	utimesSync(path, t, t);
	return path;
}

describe("pi-profile sessions archive", { skip: rsyncSkip }, () => {
	it("is a dry run without --apply, and says what --apply would do", () => {
		config();
		const path = old("--a--/x.jsonl", 40, "x1");
		const before = readFileSync(path);
		const r = cli("sessions", "archive");
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /dry run/);
		assert.match(r.stdout, /would replace by a stub: 1 session/);
		assert.match(r.stdout, /repeat with --apply/);
		assert.ok(readFileSync(path).equals(before));
		assert.equal(existsSync(join(root, "box")), false);
	});

	it("--apply archives the default profile's sessions; restore brings one back by id", () => {
		config();
		const path = old("--a--/x.jsonl", 40, "x1");
		const before = readFileSync(path);
		const r = cli("sessions", "archive", "--apply");
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /archived and replaced by a stub: 1 session/);
		assert.ok(readStub(readFileSync(path, "utf8")) !== undefined);
		const back = cli("sessions", "restore", "x1");
		assert.equal(back.code, 0, back.stderr);
		assert.match(back.stdout, /restored/);
		assert.ok(readFileSync(path).equals(before));
	});

	it("--older-than overrides the setting", () => {
		config();
		old("--a--/x.jsonl", 10, "x1");
		assert.match(cli("sessions", "archive").stdout, /nothing to archive/);
		assert.match(cli("sessions", "archive", "--older-than", "7d").stdout, /would replace by a stub: 1 session/);
	});

	it("restore of a grown stub keeps both and says where the full session is", () => {
		config();
		const path = old("--a--/x.jsonl", 40, "x1");
		cli("sessions", "archive", "--apply");
		writeFileSync(path, readFileSync(path, "utf8") + "{\"type\":\"message\",\"id\":\"q\",\"parentId\":null,\"timestamp\":\"x\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n");
		const back = cli("sessions", "restore", path);
		assert.equal(back.code, 0, back.stderr);
		assert.match(back.stdout, /kept both/);
		assert.equal(readdirSync(join(store, "--a--")).filter((n) => n.includes(".kept-")).length, 1);
	});

	it("finds the sessions of a sessionDir set with ~, as Pi does", () => {
		config();
		const home = join(s.home, "home");
		mkdirSync(join(home, "pi-sessions", "--a--"), { recursive: true });
		writeFileSync(join(s.home, "agent", "settings.json"), JSON.stringify({ sessionDir: "~/pi-sessions" }));
		const path = join(home, "pi-sessions", "--a--", "x.jsonl");
		writeFileSync(path, piSession({ id: "x1", cwd: "/nowhere", prompts: ["p"], t0: Date.now() - 40 * DAY }));
		utimesSync(path, (Date.now() - 40 * DAY) / 1000, (Date.now() - 40 * DAY) / 1000);
		const r = cli("sessions", "archive", { HOME: home });
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /would replace by a stub: 1 session/);
		assert.match(r.stdout, /pi-sessions/);
	});

	it("refuses without an archive setting, and for unknown or clashing flags", () => {
		old("--a--/x.jsonl", 40, "x1");
		assert.equal(cli("sessions", "archive").code, 2);
		config();
		assert.equal(cli("sessions", "archive", "--all", "--profile", "default").code, 2);
		assert.equal(cli("sessions", "archive", "--older-than", "soon").code, 2);
		assert.equal(cli("sessions", "restore").code, 2);
		assert.equal(cli("sessions", "restore", "no-such-id").code, 2);
	});
});

describe("archive schedule", () => {
	const node = "/usr/bin/node";
	const cliPath = "/opt/pi-profile/bin/pi-profile.mjs";

	it("a systemd user timer runs the archive daily, with the profile home and a bounded run", () => {
		const u = systemdUnits({ node, cli: cliPath, piHome: "/srv/u/.pi", path: "/usr/local/bin:/usr/bin:/bin" });
		assert.match(u.service, /^ExecStart=\/usr\/bin\/node \/opt\/pi-profile\/bin\/pi-profile\.mjs sessions archive --all --apply --quiet$/m);
		assert.match(u.service, /^Environment="PI_PROFILE_HOME=\/srv\/u\/\.pi"$/m);
		assert.match(u.service, /^TimeoutStartSec=/m);
		assert.match(u.timer, /^OnCalendar=daily$/m);
		assert.match(u.timer, /^Persistent=true$/m);
		assert.match(u.timer, /^WantedBy=timers\.target$/m);
	});

	it("a launchd agent runs the same command daily", () => {
		const p = launchdPlist({ node, cli: cliPath, piHome: "/srv/mac/.pi", path: "/opt/homebrew/bin:/usr/bin:/bin" });
		assert.match(p, /<string>\/usr\/bin\/node<\/string>\s*<string>\/opt\/pi-profile\/bin\/pi-profile\.mjs<\/string>\s*<string>sessions<\/string>\s*<string>archive<\/string>\s*<string>--all<\/string>\s*<string>--apply<\/string>/);
		assert.match(p, /<key>StartCalendarInterval<\/key>/);
		assert.match(p, /<key>PI_PROFILE_HOME<\/key>\s*<string>\/srv\/mac\/\.pi<\/string>/);
		const logged = launchdPlist({ node, cli: cliPath, piHome: "/srv/mac/.pi", path: "/bin", log: "/srv/mac/.pi/pi-profile/state/archive.log" });
		assert.match(logged, /<key>StandardOutPath<\/key>\s*<string>\/srv\/mac\/\.pi\/pi-profile\/state\/archive\.log<\/string>/);
		assert.match(logged, /<key>StandardErrorPath<\/key>\s*<string>\/srv\/mac\/\.pi\/pi-profile\/state\/archive\.log<\/string>/);
		assert.throws(() => launchdPlist({ node, cli: cliPath, piHome: "/h", path: "/bin", log: "rel.log" }), { name: "Refusal" });
	});

	it("runs a node that outlives an upgrade: an unversioned one on PATH that is the same binary", () => {
		const nvm = join(s.home, ".nvm", "versions", "node", "v24.1.0", "bin");
		const stable = join(s.home, "usr", "bin");
		mkdirSync(nvm, { recursive: true });
		mkdirSync(stable, { recursive: true });
		writeFileSync(join(nvm, "node"), "");
		symlinkSync(join(nvm, "node"), join(stable, "node"));
		assert.equal(stableNode(join(nvm, "node"), nvm + ":" + stable), join(stable, "node"));
		assert.equal(stableNode(join(nvm, "node"), nvm), join(nvm, "node"), "no stable one: the versioned path");
		mkdirSync(join(s.home, "other"));
		writeFileSync(join(s.home, "other", "node"), "");
		assert.equal(stableNode(join(nvm, "node"), join(s.home, "other")), join(nvm, "node"), "another node is not used");
	});

	it("escapes what it embeds, and refuses a path systemd or a plist cannot hold", () => {
		const p = launchdPlist({ node, cli: cliPath, piHome: "/srv/mac/a&b<c", path: "/bin" });
		assert.match(p, /a&amp;b&lt;c/);
		assert.throws(() => systemdUnits({ node, cli: cliPath, piHome: "/srv/u/new\nline", path: "/bin" }), { name: "Refusal" });
		assert.throws(() => systemdUnits({ node: "relative/node", cli: cliPath, piHome: "/h", path: "/bin" }), { name: "Refusal" });
		assert.match(systemdUnits({ node, cli: cliPath, piHome: "/srv/u/with space/%h", path: "/bin" }).service, /Environment="PI_PROFILE_HOME=\/srv\/u\/with space\/%%h"/);
	});

	it("files go where each platform reads them", () => {
		const env = { node, cli: cliPath, piHome: "/h/.pi", path: "/bin" };
		assert.deepEqual(scheduleFiles("linux", "/h", env).map((f) => f.path), ["/h/.config/systemd/user/pi-profile-archive.service", "/h/.config/systemd/user/pi-profile-archive.timer"]);
		assert.deepEqual(scheduleFiles("darwin", "/h", env).map((f) => f.path), ["/h/Library/LaunchAgents/io.pi-profile.archive.plist"]);
	});

	it("systemd-analyze accepts the units", { skip: spawnSync("systemd-analyze", ["--version"]).status === 0 ? false : "systemd-analyze is not installed" }, () => {
		const dir = join(s.home, "units");
		mkdirSync(dir);
		const u = systemdUnits({ node: process.execPath, cli: cliPath, piHome: s.home, path: "/usr/bin:/bin" });
		writeFileSync(join(dir, "pi-profile-archive.service"), u.service);
		writeFileSync(join(dir, "pi-profile-archive.timer"), u.timer);
		const r = spawnSync("systemd-analyze", ["verify", "--user", "--man=no", join(dir, "pi-profile-archive.timer"), join(dir, "pi-profile-archive.service")], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	});

	it("plutil accepts the plist", { skip: spawnSync("plutil", ["-help"]).status === 0 ? false : "plutil is not installed" }, () => {
		const f = join(s.home, "a.plist");
		writeFileSync(f, launchdPlist({ node, cli: cliPath, piHome: s.home, path: "/bin" }));
		assert.equal(spawnSync("plutil", ["-lint", f]).status, 0);
	});

	it("--install-schedule writes the files without loading them, and prints how to start them", () => {
		config();
		const r = cli("sessions", "archive", "--install-schedule");
		assert.equal(r.code, 0, r.stderr);
		const files = process.platform === "darwin" ? [join(s.home, "Library/LaunchAgents/io.pi-profile.archive.plist")] : [join(s.home, ".config/systemd/user/pi-profile-archive.timer"), join(s.home, ".config/systemd/user/pi-profile-archive.service")];
		for (const f of files) assert.ok(statSync(f).isFile(), f);
		assert.match(r.stdout, process.platform === "darwin" ? /launchctl bootstrap/ : /systemctl --user enable --now pi-profile-archive\.timer/);
		const again = cli("sessions", "archive", "--install-schedule");
		assert.equal(again.code, 0);
		assert.match(again.stdout, /unchanged/);
	});
});

describe("manifest after archive", { skip: rsyncSkip }, () => {
	it("lives in the store as .pi-profile-archive.json", () => {
		config();
		old("--a--/x.jsonl", 40, "x1");
		cli("sessions", "archive", "--apply");
		assert.equal(loadManifest(store).sessions["--a--/x.jsonl"]?.id, "x1");
	});
});
