import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CLI_PATH, currentRuntime, type AttachedSpawn, type Runtime } from "../src/core/autobackup.ts";
import { createProfile } from "../src/core/profiles.ts";
import piProfile, { badgeFor, titleFor, USAGE, type Deps } from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

type Handler = (e: unknown, ctx: unknown) => unknown;

interface FakePi {
	readonly handlers: Map<string, Handler>;
	readonly commands: Map<string, { handler: (a: string, ctx: unknown) => Promise<void> }>;
}

function load(env: Record<string, string>, deps: Omit<Deps, "env"> = {}): FakePi {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (a: string, ctx: unknown) => Promise<void> }>();
	const api = {
		on: (name: string, h: Handler) => handlers.set(name, h),
		registerCommand: (name: string, c: { handler: (a: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
		appendEntry: () => undefined,
	};
	piProfile(api as never, { env, ...deps });
	return { handlers, commands };
}

interface FakeUi {
	readonly titles: string[];
	readonly notes: Array<[string, string | undefined]>;
	readonly ctx: unknown;
}

function ui(cwd: string): FakeUi {
	const titles: string[] = [];
	const notes: Array<[string, string | undefined]> = [];
	const ctx = {
		hasUI: true,
		cwd,
		sessionManager: { getBranch: () => [] },
		ui: {
			setStatus: () => undefined,
			setTitle: (t: string) => titles.push(t),
			notify: (m: string, type?: string) => notes.push([m, type]),
		},
	};
	return { titles, notes, ctx };
}

const named = (): Record<string, string> => {
	createProfile(s.l, "work", { color: "teal" });
	return { PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "work", PI_CODING_AGENT_DIR: join(s.home, "profiles", "work"), PI_PROFILE_HOST_ID: "laptop" };
};
const plain = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1", PI_PROFILE_HOST_ID: "laptop" });
const start = { type: "session_start", reason: "startup" };

function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(join(s.home, "pi-profile", "config.json"), JSON.stringify({ schemaVersion: 1, sessionStores: {}, ...config }));
}

describe("terminal title", () => {
	it("is π <profile> · <cwd basename> in a named profile", () => {
		assert.equal(titleFor(named(), "/home/user/Code/proj"), "π work · proj");
	});

	it("is left alone for the plain default", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(plain());
		const u = ui("/home/user/Code/proj");
		pi.handlers.get("session_start")?.(start, u.ctx);
		pi.handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "x" }, u.ctx);
		t.mock.timers.tick(5000);
		assert.deepEqual(u.titles, []);
	});

	it("is set at session start and set again after Pi writes its own title", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(named());
		const u = ui("/home/user/Code/proj");
		pi.handlers.get("session_start")?.(start, u.ctx);
		assert.equal(u.titles.at(-1), "π work · proj");
		// Interactive mode writes `π - <cwd>` right after the session_start handlers return.
		u.titles.push("π - proj");
		t.mock.timers.tick(0);
		assert.equal(u.titles.at(-1), "π work · proj");
	});

	it("is set again when Pi writes its title after an async gap", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(named());
		const u = ui("/home/user/Code/proj");
		pi.handlers.get("session_start")?.(start, u.ctx);
		// Pi awaits every resources_discover handler before it writes its own title;
		// one that does I/O puts Pi's title several macrotasks after session_start.
		t.mock.timers.tick(100);
		u.titles.push("π - proj");
		t.mock.timers.tick(1000);
		assert.equal(u.titles.at(-1), "π work · proj");
	});

	it("stops retitling after a bounded time", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(named());
		const u = ui("/home/user/Code/proj");
		pi.handlers.get("session_start")?.(start, u.ctx);
		t.mock.timers.tick(1001);
		u.titles.push("π - renamed by the user");
		t.mock.timers.tick(600_000);
		assert.equal(u.titles.at(-1), "π - renamed by the user");
	});

	it("does not retitle a session that a newer one replaced", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(named());
		const a = ui("/a/one");
		const b = ui("/b/two");
		pi.handlers.get("session_start")?.(start, a.ctx);
		pi.handlers.get("session_start")?.({ type: "session_start", reason: "new" }, b.ctx);
		t.mock.timers.tick(1000);
		assert.deepEqual(a.titles, ["π work · one"]);
		assert.equal(b.titles.at(-1), "π work · two");
	});

	it("follows the session's cwd at each session start", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const pi = load(named());
		const u = ui("/srv/other");
		pi.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, u.ctx);
		t.mock.timers.tick(1000);
		assert.equal(u.titles.at(-1), "π work · other");
	});

	it("is set again after a session rename, which retitles the terminal", () => {
		const pi = load(named());
		const u = ui("/home/user/Code/proj");
		pi.handlers.get("session_info_changed")?.({ type: "session_info_changed", name: "x" }, u.ctx);
		assert.equal(u.titles.at(-1), "π work · proj");
	});

	it("cannot carry terminal control sequences from a directory name", () => {
		const title = titleFor(named(), "/tmp/a\u0007\u001b]0;owned\u0007");
		assert.equal(title, "π work · a??]0;owned?");
	});
});

describe("badge host", () => {
	const ssh = (host: string): Record<string, unknown> => ({ id: "hub", kind: "ssh", host, repository: "sessions" });

	it("shows this host when the repository it backs up to is owned by another host", () => {
		writeConfig({ hostId: "laptop", replicas: [ssh("studio")] });
		const b = badgeFor(named());
		assert.equal(b?.host, "laptop");
		assert.match(b?.text ?? "", /● work · laptop/);
	});

	it("hides the host on the repository owner", () => {
		writeConfig({ hostId: "studio", replicas: [ssh("studio")] });
		const b = badgeFor(named());
		assert.equal(b?.host, undefined);
		assert.doesNotMatch(b?.text ?? "", /studio/);
	});

	it("hides the host when no repository owner is known", () => {
		writeConfig({ hostId: "laptop", replicas: [{ id: "usb", kind: "local", path: "/media/usb" }] });
		assert.equal(badgeFor(named())?.host, undefined);
	});

	it("keeps the badge when config.json is broken", () => {
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(join(s.home, "pi-profile", "config.json"), "{ not json");
		const b = badgeFor(named());
		assert.equal(b?.name, "work");
		assert.equal(b?.host, undefined);
	});
});
const node: Runtime = { execPath: "/usr/bin/node", bunVersion: undefined, releaseName: "node", isSea: () => false };

interface Child extends EventEmitter {
	readonly stdout: EventEmitter & { unref: () => void };
	readonly stderr: EventEmitter;
	unref: () => void;
}

interface FakeSpawn {
	readonly spawn: AttachedSpawn;
	readonly calls: Array<{ command: string; args: readonly string[]; stdio: unknown }>;
	readonly children: Child[];
}

/** A spawn whose children run until the test ends them. */
function fakeSpawn(): FakeSpawn {
	const calls: FakeSpawn["calls"] = [];
	const children: Child[] = [];
	const spawn: AttachedSpawn = (command, args, options) => {
		calls.push({ command, args, stdio: options.stdio });
		const child = Object.assign(new EventEmitter(), {
			stdout: Object.assign(new EventEmitter(), { unref: () => undefined }),
			stderr: new EventEmitter(),
			unref: () => undefined,
		});
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

function exit(child: Child | undefined, code: number, stdout: string, stderr = ""): void {
	assert.ok(child, "a backup was started");
	if (stdout !== "") child.stdout.emit("data", Buffer.from(stdout));
	if (stderr !== "") child.stderr.emit("data", Buffer.from(stderr));
	child.emit("close", code);
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
describe("/profile backup", () => {
	const rsync = { id: "usb", ok: true, mode: "rsync", files: 2, bytes: 16, encrypted: false, held: [] };

	it("returns at once with a started notice, before the backup ends", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		assert.deepEqual(u.notes, [["backup: started", "info"]]);
		assert.deepEqual(f.calls, [{ command: "/usr/bin/node", args: [CLI_PATH, "backup", "run", "--json"], stdio: ["ignore", "pipe", "ignore"] }]);
	});

	it("reports each replica when the backup exits", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		const staged = { id: "cloud", ok: true, mode: "staged", files: 3, bytes: 9, encrypted: true, held: ["a.jsonl"] };
		exit(f.children[0], 0, JSON.stringify({ results: [rsync, staged] }));
		await settle();
		assert.deepEqual(u.notes.slice(1), [["backup: usb: checked 2 files; cloud: sent 3 changed files, encrypted, 1 sessions not sent because they are smaller than their backup", "warning"]]);
	});

	it("refuses a second backup while one runs, and allows one after", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(u.notes[1], ["backup: one is already running; wait for its result", "warning"]);
		exit(f.children[0], 0, JSON.stringify({ results: [rsync] }));
		await settle();
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		assert.equal(f.calls.length, 2);
	});

	it("never shows the tool's output for a failed replica or a failed run", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		exit(f.children[0], 1, JSON.stringify({ results: [{ id: "usb", ok: false, error: "key=SECRET-1" }] }), "auth failed: key=SECRET-1");
		await settle();
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		exit(f.children[1], 1, "", "Error: EACCES /home/x token=SECRET-2");
		await settle();
		assert.deepEqual(u.notes.slice(1), [
			["backup: usb: failed; see pi-profile backup list", "error"],
			["backup: started", "info"],
			["backup: failed; run pi-profile backup run for details", "error"],
		]);
		assert.doesNotMatch(JSON.stringify(u.notes), /SECRET/);
	});

	it("reports a refusal in pi-profile's words", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		exit(f.children[0], 2, `${JSON.stringify({ refused: "no replicas; add one with: pi-profile backup add\u001b]0;x" })}\n`);
		await settle();
		assert.deepEqual(u.notes.slice(1), [["backup: no replicas; add one with: pi-profile backup add?]0;x", "error"]]);
	});

	it("reports a run that could not start", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		f.children[0]?.emit("error", new Error("spawn ENOENT"));
		await settle();
		assert.deepEqual(u.notes.slice(1), [["backup: failed; run pi-profile backup run for details", "error"]]);
	});

	it("does not start a hidden Pi when Pi is not Node", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: { ...node, bunVersion: "1.2.0" } });
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("backup", u.ctx);
		assert.equal(f.calls.length, 0);
		assert.deepEqual(u.notes, [["backup: this Pi does not run on Node; run pi-profile backup run in a shell", "error"]]);
	});

	it("still shows the profile with no arguments", async () => {
		const pi = load(named());
		const u = ui("/x");
		await pi.commands.get("profile")?.handler("", u.ctx);
		assert.match(u.notes[0]?.[0] ?? "", /^profile: work /);
	});
});

describe("/profile status, list, doctor and switch", () => {
	const run = async (pi: FakePi, args: string, u: FakeUi): Promise<void> => {
		await pi.commands.get("profile")?.handler(args, u.ctx);
	};
	const stdio = ["ignore", "pipe", "ignore"];

	it("status runs status --json off the UI and shows profile, host and each replica's last backup", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await run(pi, "status", u);
		// The handler returned before the CLI exited: nothing is shown yet.
		assert.deepEqual(u.notes, []);
		assert.deepEqual(f.calls, [{ command: "/usr/bin/node", args: [CLI_PATH, "status", "--json"], stdio }]);
		const doc = {
			profile: "work",
			agentDir: "/h/profiles/work",
			source: "env",
			host: "laptop",
			replicas: [
				{ id: "usb", lastOkAt: "2025-01-02T03:04:05.000Z", ok: true },
				{ id: "cloud", ok: false },
			],
		};
		exit(f.children[0], 0, JSON.stringify(doc));
		await settle();
		assert.deepEqual(u.notes, [
			["status: profile work (selected by env); host laptop; backup usb: last backup 2025-01-02T03:04:05.000Z; backup cloud: last run failed; see pi-profile backup list", "warning"],
		]);
	});

	it("list marks the active profile", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await run(pi, "list", u);
		assert.deepEqual(f.calls[0]?.args, [CLI_PATH, "list", "--json"]);
		exit(f.children[0], 0, JSON.stringify({ profiles: [{ name: "default", active: false }, { name: "work", active: true }] }));
		await settle();
		assert.deepEqual(u.notes, [["profiles: default, *work", "info"]]);
	});

	it("doctor shows each finding at the worst finding's level", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await run(pi, "doctor", u);
		assert.deepEqual(f.calls[0]?.args, [CLI_PATH, "doctor", "--json"]);
		const findings = [
			{ level: "warn", profile: "work", message: "no profile.json" },
			{ level: "error", message: "bad\u001b]0;x" },
		];
		exit(f.children[0], 1, JSON.stringify({ findings }));
		await settle();
		assert.deepEqual(u.notes, [["doctor:\nwarn work: no profile.json\nerror bad?]0;x", "error"]]);
		await run(pi, "doctor", u);
		exit(f.children[1], 0, JSON.stringify({ findings: [] }));
		await settle();
		assert.deepEqual(u.notes[1], ["doctor: no problems found", "info"]);
	});

	it("switch names the command that starts Pi in the other profile, and does not switch", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		const profiles = JSON.stringify({ profiles: [{ name: "default", active: false }, { name: "work", active: true }, { name: "play", active: false }] });
		await run(pi, "switch play", u);
		assert.deepEqual(f.calls[0]?.args, [CLI_PATH, "list", "--json"]);
		exit(f.children[0], 0, profiles);
		await run(pi, "switch work", u);
		exit(f.children[1], 0, profiles);
		await run(pi, "switch nope", u);
		exit(f.children[2], 0, profiles);
		await settle();
		assert.deepEqual(u.notes, [
			["switch: Pi cannot change profile while it runs. Quit, then start it with: pi-profile run play (or pi --profile play with the shell integration)", "info"],
			["switch: Pi already runs in profile work", "info"],
			["switch: no profile named nope; /profile list shows them", "error"],
		]);
	});

	it("shows a refusal in pi-profile's words and hides any other failure", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		await run(pi, "status", u);
		exit(f.children[0], 2, JSON.stringify({ refused: "host ID is not a safe path segment: x" }));
		await run(pi, "list", u);
		exit(f.children[1], 1, "", "EACCES token=SECRET");
		await run(pi, "doctor", u);
		f.children[2]?.emit("error", new Error("spawn ENOENT"));
		await settle();
		assert.deepEqual(u.notes, [
			["status: host ID is not a safe path segment: x", "error"],
			["list: failed; run pi-profile list for details", "error"],
			["doctor: failed; run pi-profile doctor for details", "error"],
		]);
		assert.doesNotMatch(JSON.stringify(u.notes), /SECRET/);
	});

	it("does not start a hidden Pi when Pi is not Node", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: { ...node, bunVersion: "1.2.0" } });
		const u = ui("/x");
		await run(pi, "status", u);
		assert.equal(f.calls.length, 0);
		assert.deepEqual(u.notes, [["status: this Pi does not run on Node; run pi-profile status in a shell", "error"]]);
	});

	it("shows usage for an unknown subcommand or a wrong argument count, and starts nothing", async () => {
		const f = fakeSpawn();
		const pi = load(named(), { spawn: f.spawn, runtime: node });
		const u = ui("/x");
		for (const args of ["frobnicate", "switch", "switch a b", "list extra", "backup now"]) await run(pi, args, u);
		assert.equal(f.calls.length, 0);
		assert.deepEqual(u.notes, Array.from({ length: 5 }, () => [USAGE, "warning"]));
	});

	it("list and switch run the real CLI end to end", async () => {
		createProfile(s.l, "play");
		const pi = load(named(), { runtime: currentRuntime() });
		const u = ui("/x");
		const shown = (n: number): Promise<void> =>
			new Promise((resolve, reject) => {
				const deadline = Date.now() + 20_000;
				const poll = (): void => {
					if (u.notes.length >= n) resolve();
					else if (Date.now() > deadline) reject(new Error(`no notice: ${JSON.stringify(u.notes)}`));
					else setTimeout(poll, 20);
				};
				poll();
			});
		await run(pi, "list", u);
		await shown(1);
		await run(pi, "switch play", u);
		await shown(2);
		assert.deepEqual(u.notes, [
			["profiles: default, play, *work", "info"],
			["switch: Pi cannot change profile while it runs. Quit, then start it with: pi-profile run play (or pi --profile play with the shell integration)", "info"],
		]);
	});
});
