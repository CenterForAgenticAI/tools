import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { HELP, main, setKey } from "../src/cli/main.ts";
import { envCode, quote, shellInit } from "../src/cli/shell.ts";
import { createProfile } from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { badgeFor, STATUS_KEY } from "../src/index.ts";
import piProfile from "../src/index.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

function cli(...argv: string[]): ReturnType<typeof captureIo> & { code: number } {
	const io = captureIo({ PI_PROFILE_HOME: s.home, SHELL: "/bin/bash" });
	const code = main(argv, io);
	return Object.assign(io, { code });
}

describe("cli", () => {
	it("help and unknown commands", () => {
		assert.equal(cli("help").stdout, HELP);
		const bad = cli("frobnicate");
		assert.equal(bad.code, 2);
		assert.match(bad.stderr, /unknown command/);
	});
	it("create, list, show, current", () => {
		assert.equal(cli("create", "work", "--color", "teal", "--description", "day job").code, 0);
		assert.match(cli("list").stdout, /\* default {2}\(active\)\n {2}work\n/);
		const show = cli("show", "work").stdout;
		assert.match(show, /auth: shared/);
		assert.match(show, /description: day job/);
		assert.match(cli("current").stdout, /profile: default\n.*\nselected by: builtin-default/);
	});
	it("status, list --json and doctor --json print one JSON line for /profile", () => {
		cli("create", "work");
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "laptop", PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
		const run = (...argv: string[]): ReturnType<typeof captureIo> & { code: number } => {
			const io = captureIo(env);
			return Object.assign(io, { code: main(argv, io) });
		};
		const status = run("status", "--json");
		assert.equal(status.code, 0, status.stderr);
		assert.deepEqual(JSON.parse(status.stdout), { profile: "default", agentDir: join(s.home, "agent"), source: "builtin-default", host: "laptop", replicas: [] });
		assert.match(run("status").stdout, /^profile: default\n.*\nselected by: builtin-default\nhost: laptop\nbackup: no replicas\n$/);
		const list = run("list", "--json");
		assert.deepEqual(JSON.parse(list.stdout), {
			profiles: [
				{ name: "default", active: true, globalDefault: false },
				{ name: "work", active: false, globalDefault: false },
			],
		});
		const doc = run("doctor", "--json");
		assert.equal(doc.code, 0, doc.stderr);
		assert.ok(Array.isArray((JSON.parse(doc.stdout) as { findings: unknown }).findings));
		const refused = run("list", "--json", "extra");
		assert.equal(refused.code, 2);
		assert.match((JSON.parse(refused.stdout) as { refused: string }).refused, /unexpected argument: extra/);
		assert.equal(run("status", "extra").stdout, "");
	});
	it("create validates its options", () => {
		assert.equal(cli("create", "x", "--auth", "magic").code, 2);
		assert.equal(cli("create", "x", "--color", "mauve").code, 2);
		assert.equal(cli("create", "x", "--color").code, 2);
		assert.equal(cli("create").code, 2);
		assert.equal(cli("create", "x", "extra").code, 2);
		assert.equal(cli("create", "x", "--auth", "separate", "--copy-auth", "--group", "g").code, 2);
	});
	it("edit sets and clears keys", () => {
		cli("create", "p");
		const r = cli("edit", "p", "--set", "color=red", "--set", "env.ACP_AUTO_UPDATE=0", "--set", "auth.mode=separate");
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /color: #dc2626/);
		assert.match(r.stdout, /env ACP_AUTO_UPDATE=0/);
		assert.match(cli("edit", "p", "--set", "env.ACP_AUTO_UPDATE=", "--set", "color=").stdout, /\(from name\)/);
		assert.equal(cli("edit", "p", "--set", "env.LD_PRELOAD=/x").code, 2);
		assert.equal(cli("edit", "p").code, 2);
	});
	it("setKey covers every key and refuses bad input", () => {
		const base = { schemaVersion: 1 as const, name: "p", auth: { mode: "shared" as const } };
		let m = setKey(base, "description=hello");
		m = setKey(m, "multiAccount.group=caair");
		m = setKey(m, "sessions.store=profile");
		assert.deepEqual(m, { ...base, description: "hello", multiAccount: { group: "caair" }, sessions: { store: "profile" } });
		m = setKey(setKey(setKey(m, "description="), "multiAccount.group="), "sessions.store=");
		assert.deepEqual(m, base);
		for (const bad of ["nokey", "=x", "color=mauve", "auth.mode=x", "multiAccount.group=../x", "secret=1"]) {
			assert.throws(() => setKey(base, bad), Refusal, bad);
		}
	});
	it("delete needs --yes", () => {
		cli("create", "p");
		assert.equal(cli("delete", "p").code, 2);
		assert.match(cli("delete", "p", "--yes").stdout, /moved p to/);
	});
	it("run passes args through with the profile environment", () => {
		cli("create", "p");
		const r = cli("run", "p", "--", "--model", "x");
		assert.equal(r.code, 0);
		assert.deepEqual(r.runs[0]?.args, ["--model", "x"]);
		assert.equal(r.runs[0]?.env["PI_PROFILE_LABEL"], "p");
		assert.equal(cli("run", "missing").code, 2);
	});
	it("env, use and startup", () => {
		cli("create", "p");
		assert.match(cli("env", "--shell", "fish", "--", "p").stdout, /^set -gx PI_CODING_AGENT_DIR /);
		assert.match(cli("env", "--shell", "fish", "--scope", "function", "--", "p").stdout, /set -fx ACP_DELEGATE\n/);
		assert.equal(cli("env", "--shell", "tcsh", "p").code, 2);
		assert.equal(cli("env", "--scope", "world", "p").code, 2);
		const use = cli("use", "p");
		assert.equal(use.code, 2);
		assert.match(use.stderr, /shell integration/);
		assert.equal(cli("startup").stdout, "");
		cli("default", "set", "p");
		assert.match(cli("startup", "--shell", "zsh").stdout, /export PI_PROFILE_LABEL='p'/);
		assert.equal(main(["startup"], captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" })), 0);
	});
	it("default show, set, clear", () => {
		cli("create", "p");
		assert.match(cli("default").stdout, /default \(Pi's own/);
		assert.match(cli("default", "set", "p").stdout, /global default profile: p/);
		assert.match(cli("current").stdout, /global default: p/);
		assert.match(cli("list").stdout, /\* p {2}\(active, global default\)/);
		assert.match(cli("default", "clear").stdout, /global default profile: default/);
		assert.equal(cli("default", "wat").code, 2);
	});
	it("adopt and doctor", () => {
		cli("create", "p");
		assert.match(cli("adopt", "--all").stdout, /already has profile.json: p/);
		assert.equal(cli("adopt", "nope").code, 1);
		assert.match(cli("doctor").stdout, /no problems found/);
	});
	it("shell-init", () => {
		assert.match(cli("shell-init", "fish").stdout, /function pi-profile/);
		assert.equal(cli("shell-init", "tcsh").code, 2);
	});
});

describe("shell code", () => {
	const hostile = `a'b"c$(touch /tmp/pwn)\`x\` \\ end`;
	it("quotes values so a shell reads them back unchanged (bash)", () => {
		const code = `${envCode("bash", [["ACP_DELEGATE", hostile]])}printf %s "$ACP_DELEGATE"`;
		const r = spawnSync("bash", ["-c", code], { encoding: "utf8" });
		assert.equal(r.stdout, hostile);
	});
	it("quotes values so a shell reads them back unchanged (fish)", (t) => {
		const code = `${envCode("fish", [["ACP_DELEGATE", hostile]])}printf %s "$ACP_DELEGATE"`;
		const r = spawnSync("fish", ["-c", code], { encoding: "utf8" });
		if (r.error !== undefined) {
			t.skip("fish is not installed");
			return;
		}
		assert.equal(r.stdout, hostile);
	});
	it("refuses unsafe variable names and unsets cleared ones", () => {
		assert.throws(() => envCode("bash", [["X; rm -rf ~", "1"]]), Refusal);
		assert.equal(envCode("zsh", [["A", undefined]]), "unset A\n");
		assert.equal(envCode("fish", [["A", undefined]]), "set -e A\n");
		assert.equal(quote("fish", "a'b\\"), "'a\\'b\\\\'");
	});
	it("bash integration: use switches the shell, pi --profile does not leak", () => {
		createProfile(s.l, "p");
		const bin = join(process.cwd(), "bin", "pi-profile.mjs");
		const script = `
pi-profile() { :; }
eval "$(node ${JSON.stringify(bin)} shell-init bash)"
command() { if [ "$1" = pi-profile ]; then shift; node ${JSON.stringify(bin)} "$@"; elif [ "$1" = pi ]; then shift; printf 'pi:%s:%s\\n' "$PI_PROFILE_LABEL" "$*"; else builtin command "$@"; fi; }
pi --profile p --version
printf 'after:%s\\n' "\${PI_PROFILE_LABEL:-none}"
pi-profile use p
printf 'now:%s\\n' "$PI_PROFILE_LABEL"
`;
		const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env["PATH"], PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" } });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /pi:p:--version\nafter:none\nactive profile: p\nnow:p\n/);
	});
	it("every shell has an init script", () => {
		for (const sh of ["fish", "bash", "zsh"] as const) assert.match(shellInit(sh), /pi-profile shell-init/);
	});
});

describe("extension", () => {
	it("no badge for the plain default, a coloured badge otherwise", () => {
		assert.equal(badgeFor({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }), undefined);
		createProfile(s.l, "p", { color: "red" });
		const b = badgeFor({ PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "p", PI_CODING_AGENT_DIR: join(s.home, "profiles", "p") });
		assert.equal(b?.name, "p");
		assert.equal(b?.text, "\u001b[38;2;220;38;38m● p\u001b[39m");
		const custom = badgeFor({ PI_PROFILE_HOME: s.home, PI_CODING_AGENT_DIR: "/somewhere/else" });
		assert.equal(custom?.name, "custom");
	});
	it("registers a status badge on session start and a /profile command", async () => {
		const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
		const commands = new Map<string, { handler: (a: string, ctx: unknown) => Promise<void> }>();
		const api = {
			on: (name: string, h: (e: unknown, ctx: unknown) => void) => handlers.set(name, h),
			registerCommand: (name: string, c: { handler: (a: string, ctx: unknown) => Promise<void> }) => commands.set(name, c),
		};
		piProfile(api as never);
		const statuses: Array<[string, string | undefined]> = [];
		const notes: string[] = [];
		const ctx = { hasUI: true, ui: { setStatus: (k: string, v: string | undefined) => statuses.push([k, v]), notify: (m: string) => notes.push(m) } };
		handlers.get("session_start")?.({}, ctx);
		handlers.get("session_start")?.({}, { hasUI: false });
		assert.equal(statuses.length, 1);
		assert.equal(statuses[0]?.[0], STATUS_KEY);
		await commands.get("profile")?.handler("", ctx);
		assert.match(notes[0] ?? "", /^profile: /);
	});
});

describe("package", () => {
	it("declares the extension and the bin", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8"));
		assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
		assert.equal(pkg.bin["pi-profile"], "./bin/pi-profile.mjs");
	});
});
