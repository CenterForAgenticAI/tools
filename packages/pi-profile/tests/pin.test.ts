import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main, type Io } from "../src/cli/main.ts";
import { gateTree, hubMirror, initHub, parseHubJson, pushHubs } from "../src/core/hub.ts";
import { pullHubs } from "../src/core/hubpull.ts";
import type { SshRunner } from "../src/core/authsync.ts";
import type { PackageRunner } from "../src/core/packages.ts";
import type { CommandRunner } from "../src/core/pin.ts";
import { pinStatePath, readPinState } from "../src/core/pinstate.ts";
import { findPi, parsePin, parseVersion, satisfies } from "../src/core/piversion.ts";
import { createProfile } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Captured, type Sandbox } from "./helpers.ts";

/** Tests for issue 34: the fleet's Pi version pin. Host A sets and pushes it; host B pulls it. */

let a: Sandbox;
let b: Sandbox;
let remote: string;

function git(args: readonly string[], input?: string): string {
	const r = spawnSync("git", [...args], {
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
		env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

/** The folder git is in, so a test PATH finds git and nothing else of this machine (no real pi). */
const GIT_DIR = (() => {
	const r = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
	return dirname(r.stdout.trim());
})();

const PKG = ["@earendil-works", "pi-coding-agent"] as const;

/** An npm global install of Pi `version` under `<root>/npm`: `bin/pi` links to the package's cli. Returns the bin folder. */
function npmPi(root: string, version: string): string {
	const pkg = join(root, "npm", "lib", "node_modules", ...PKG);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
	writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
	mkdirSync(join(root, "npm", "bin"), { recursive: true });
	symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", join(root, "npm", "bin", "pi"));
	return join(root, "npm", "bin");
}

/** A pi.dev managed install under `<root>/mpi`, current release `current`; `~/.local/bin/pi` style link to its launcher. Returns the link's folder. */
function managedPi(root: string, current: string, others: readonly string[] = []): string {
	const agent = join(root, "mpi");
	mkdirSync(join(agent, "bin"), { recursive: true });
	writeFileSync(join(agent, "bin", "pi"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
	mkdirSync(join(agent, "install"), { recursive: true });
	writeFileSync(join(agent, "install", "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
	writeFileSync(join(agent, "install", "current-version"), `${current}\n`);
	for (const v of [current, ...others]) {
		const pkg = join(agent, "install", "releases", v, "node_modules", ...PKG);
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: v }));
	}
	mkdirSync(join(root, "local-bin"), { recursive: true });
	symlinkSync(join(agent, "bin", "pi"), join(root, "local-bin", "pi"));
	return join(root, "local-bin");
}

/** A pi of no known layout: a script that prints `printed` for --version. */
function scriptPi(root: string, printed: string): string {
	const bin = join(root, "script-bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), `#!/bin/sh\n[ "$1" = --version ] && printf '%s\\n' '${printed}'\nexit 0\n`, { mode: 0o755 });
	return bin;
}

function envOf(s: Sandbox, host: string, bin?: string): Record<string, string> {
	return { HOME: s.home, PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: host, PATH: [...(bin === undefined ? [] : [bin]), GIT_DIR].join(delimiter) };
}

interface Cli extends Captured {
	code: number;
	installs: Array<readonly string[]>;
}

/** Run the CLI; `installPi` is a stub, so no test runs npm. `piExit` is what the launched pi returns. */
function cli(env: Record<string, string>, argv: readonly string[], opts: { piExit?: number; installer?: CommandRunner } = {}): Cli {
	const io = captureIo(env) as Captured & { installPi?: CommandRunner };
	const installs: Array<readonly string[]> = [];
	const out: Captured & { installPi?: CommandRunner } = Object.assign(io, {
		runPi: (args: readonly string[], e: Record<string, string>) => {
			io.runs.push({ args, env: e });
			return opts.piExit ?? 0;
		},
		installPi: ((argv2, e) => {
			installs.push(argv2);
			return opts.installer?.(argv2, e) ?? { status: 0 };
		}) satisfies CommandRunner,
	});
	const code = main(argv, out as Io);
	return Object.assign(out, { code, installs });
}

function show(path: string): string {
	return git([`--git-dir=${remote}`, "show", `main:${path}`]);
}

function hubCommit(hubJson: string): void {
	const sha = git([`--git-dir=${remote}`, "hash-object", "-w", "--stdin"], hubJson).trim();
	const tree = git([`--git-dir=${remote}`, "mktree"], `100644 blob ${sha}\thub.json\n`).trim();
	const parent = spawnSync("git", [`--git-dir=${remote}`, "rev-parse", "-q", "--verify", "refs/heads/main"], { encoding: "utf8" }).stdout.trim();
	const commit = git([`--git-dir=${remote}`, "commit-tree", tree, ...(parent === "" ? [] : ["-p", parent]), "-m", "hostile"]).trim();
	git([`--git-dir=${remote}`, "update-ref", "refs/heads/main", commit]);
}

beforeEach(() => {
	a = sandbox();
	b = sandbox();
	remote = join(a.home, "hub.git");
	git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
});
afterEach(() => {
	a.cleanup();
	b.cleanup();
});

describe("the semver subset of a Pi version pin", () => {
	it("accepts an exact version, ^, ~ and >=, and nothing else", () => {
		for (const p of ["1.1.0", "^1.1.0", "~1.1.0", ">=1.1.0", "0.0.3", "1.2.0-rc.1", "^0.87.1"]) assert.ok(parsePin(p) !== undefined, p);
		for (const p of ["", "1.1", "1", "latest", "1.x", "*", ">1.0.0", "<=1.0.0", "=1.1.0", "^1.1.0 || 2.0.0", "1.1.0 - 2.0.0", "01.1.0", "1.1.0+build", " 1.1.0", "1.1.0\n", "v1.1.0", "^^1.1.0", `1.1.${"9".repeat(12)}`])
			assert.equal(parsePin(p), undefined, JSON.stringify(p));
	});

	it("matches as npm does for these forms", () => {
		const cases: ReadonlyArray<readonly [string, string, boolean]> = [
			["1.1.0", "1.1.0", true],
			["1.1.0", "1.1.1", false],
			["^1.1.0", "1.1.0", true],
			["^1.1.0", "1.9.3", true],
			["^1.1.0", "2.0.0", false],
			["^1.1.0", "1.0.9", false],
			["^0.87.1", "0.87.5", true],
			["^0.87.1", "0.88.0", false],
			["^0.0.3", "0.0.4", false],
			["~1.1.0", "1.1.7", true],
			["~1.1.0", "1.2.0", false],
			[">=1.1.0", "7.0.0", true],
			[">=1.1.0", "1.0.99", false],
			["^1.1.0", "1.2.0-rc.1", false],
			["^1.2.0-rc.1", "1.2.0-rc.2", true],
			["^1.2.0-rc.1", "1.2.0-rc.0", false],
			["^1.2.0-rc.1", "1.2.0", true],
			["1.2.0-rc.1", "1.2.0-rc.1", true],
			[">=1.2.0-rc.2", "1.2.0-rc.10", true],
		];
		for (const [pin, v, want] of cases) {
			const p = parsePin(pin);
			const ver = parseVersion(v);
			assert.ok(p !== undefined && ver !== undefined, `${pin} ${v}`);
			assert.equal(satisfies(ver, p), want, `${v} against ${pin}`);
		}
	});
});

describe("which Pi run launches, and its version, without running it", () => {
	it("reads an npm global install's version from its package.json", () => {
		const found = findPi({ PATH: [npmPi(a.home, "1.1.0"), GIT_DIR].join(delimiter) });
		assert.equal(found?.version, "1.1.0");
		assert.deepEqual(found?.install, { kind: "npm", prefix: join(a.home, "npm") });
	});

	it("reads a managed install's current release, as its launcher does", () => {
		const bin = managedPi(a.home, "1.0.4", ["1.1.0"]);
		const found = findPi({ PATH: [bin, GIT_DIR].join(delimiter) });
		assert.equal(found?.version, "1.0.4");
		assert.deepEqual(found?.install, { kind: "managed", agentDir: join(a.home, "mpi") });
		writeFileSync(join(a.home, "mpi", "install", "current-version"), "1.1.0\n");
		assert.equal(findPi({ PATH: bin })?.version, "1.1.0");
	});

	it("runs pi --version only for a layout it does not know", () => {
		const found = findPi({ PATH: scriptPi(a.home, "1.3.2") });
		assert.equal(found?.version, "1.3.2");
		assert.equal(found?.install.kind, "other");
		assert.equal(findPi({ PATH: scriptPi(b.home, "\u001b[31mnope") })?.version, undefined);
		assert.equal(findPi({ PATH: GIT_DIR }), undefined, "no pi on PATH");
	});
});

describe("the pi --version cache never goes stale behind a script (issue 56)", () => {
	/** A Pi of no known layout at `<root>/real-<version>/pi`, a script that prints `version`. */
	function target(root: string, version: string): string {
		const dir = join(root, `real-${version}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "pi"), `#!/bin/sh\n[ "$1" = --version ] && echo ${version}\nexit 0\n`, { mode: 0o755 });
		return join(dir, "pi");
	}

	it("a wrapper script whose target is upgraded reports the new version", () => {
		const cache = join(a.home, "cache.json");
		const bin = join(a.home, "wrap-bin");
		mkdirSync(bin, { recursive: true });
		const current = join(a.home, "current");
		symlinkSync(target(a.home, "1.1.0"), current);
		writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec '${current}' "$@"\n`, { mode: 0o755 });
		assert.equal(findPi({ PATH: bin }, { cache })?.version, "1.1.0");
		rmSync(current);
		symlinkSync(target(a.home, "1.2.0"), current);
		assert.equal(findPi({ PATH: bin }, { cache })?.version, "1.2.0");
		assert.equal(existsSync(cache), false, "a script is never cached");
	});

	it("a symlinked shim script reports the new version once the Pi it runs is upgraded", () => {
		const cache = join(a.home, "cache.json");
		const shim = join(a.home, "shims", "pi");
		mkdirSync(dirname(shim), { recursive: true });
		writeFileSync(join(a.home, "selected"), `${target(a.home, "1.1.0")}\n`);
		writeFileSync(shim, `#!/bin/sh\nread -r t < '${join(a.home, "selected")}'\nexec "$t" "$@"\n`, { mode: 0o755 });
		const bin = join(a.home, "shim-bin");
		mkdirSync(bin, { recursive: true });
		symlinkSync(shim, join(bin, "pi"));
		assert.equal(findPi({ PATH: bin }, { cache })?.version, "1.1.0");
		writeFileSync(join(a.home, "selected"), `${target(a.home, "1.2.0")}\n`);
		assert.equal(findPi({ PATH: bin }, { cache })?.version, "1.2.0");
	});

	it("a compiled shim (no #!) whose target is upgraded reports the new version once the cached answer is 10 minutes old", () => {
		// Stands in for volta-shim or a mise shim: an executable that does not start with #! and runs the Pi it selects.
		// Node runs a file without #! through sh, so a plain shell file is such an executable here.
		const cache = join(a.home, "cache.json");
		const bin = join(a.home, "volta-bin");
		mkdirSync(bin, { recursive: true });
		const selected = join(a.home, "selected");
		writeFileSync(selected, `${target(a.home, "1.1.0")}\n`);
		writeFileSync(join(bin, "pi"), `read -r t < '${selected}'\nexec "$t" "$@"\n`, { mode: 0o755 });
		assert.notEqual(readFileSync(join(bin, "pi"), "utf8").slice(0, 2), "#!");
		const t0 = Date.parse("2026-10-11T12:00:00Z");
		assert.equal(findPi({ PATH: bin }, { cache, now: t0 })?.version, "1.1.0");
		writeFileSync(selected, `${target(a.home, "1.2.0")}\n`);
		// The shim did not change, so within the age limit the cached answer stands (the documented cost).
		assert.equal(findPi({ PATH: bin }, { cache, now: t0 + 9 * 60_000 })?.version, "1.1.0");
		assert.equal(findPi({ PATH: bin }, { cache, now: t0 + 10 * 60_000 + 1 })?.version, "1.2.0");
		// The new answer is cached from then on.
		assert.equal((JSON.parse(readFileSync(cache, "utf8")) as { version: string }).version, "1.2.0");
		// A clock set back never makes an answer from the future count as fresh.
		writeFileSync(selected, `${target(a.home, "1.3.0")}\n`);
		assert.equal(findPi({ PATH: bin }, { cache, now: t0 })?.version, "1.3.0");
	});

	it("a real executable of no known layout is cached; a managed launcher whose release cannot be read is not", () => {
		// A real binary that prints a version: node (`v24.x.y`, read as `24.x.y`).
		const cache = join(a.home, "cache.json");
		const bin = join(a.home, "node-bin");
		mkdirSync(bin, { recursive: true });
		symlinkSync(process.execPath, join(bin, "pi"));
		const nodeVersion = process.version.slice(1);
		assert.equal(findPi({ PATH: bin }, { cache })?.version, nodeVersion);
		assert.equal((JSON.parse(readFileSync(cache, "utf8")) as { version: string }).version, nodeVersion, "cached");
		// The cache is used: the same executable is not asked again.
		writeFileSync(cache, readFileSync(cache, "utf8").replace(`"${nodeVersion}"`, '"7.7.7"'));
		assert.equal(findPi({ PATH: bin }, { cache })?.version, "7.7.7");
		// A managed install whose launcher is that binary, with the release's package.json missing.
		const agent = join(b.home, "mpi");
		mkdirSync(join(agent, "bin"), { recursive: true });
		mkdirSync(join(agent, "install"), { recursive: true });
		writeFileSync(join(agent, "install", "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
		writeFileSync(join(agent, "install", "current-version"), "1.1.0\n");
		// The launcher must resolve to a file in `<agent>/bin`: a hard link (or a copy) of the binary.
		const launcher = join(agent, "bin", "pi");
		try {
			linkSync(process.execPath, launcher);
		} catch {
			copyFileSync(process.execPath, launcher);
			chmodSync(launcher, 0o755);
		}
		const mcache = join(b.home, "cache.json");
		const found = findPi({ PATH: join(agent, "bin") }, { cache: mcache });
		assert.deepEqual(found?.install, { kind: "managed", agentDir: agent });
		assert.equal(found?.version, nodeVersion, "asked");
		assert.equal(existsSync(mcache), false, "a managed launcher is never cached: pi update does not change it");
	});
});

describe("pi-profile pin (issue 34)", () => {
	it("shows the pin, sets an exact version or a range, and refuses a malformed one", () => {
		const env = envOf(a, "host-a");
		initHub(a.l, remote, { env });
		const none = cli(env, ["pin"]);
		assert.equal(none.code, 0, none.stderr);
		assert.match(none.stdout, /^hub default: no Pi version pin$/m);
		const set = cli(env, ["pin", "1.1.0"]);
		assert.equal(set.code, 0, set.stderr);
		assert.match(set.stdout, /hub default: Pi version pin 1\.1\.0 \(was none\); sync push records it in the hub/);
		assert.match(cli(env, ["pin"]).stdout, /^hub default: Pi version pin 1\.1\.0, not pushed yet$/m);
		assert.equal(cli(env, ["pin", "^1.1.0"]).code, 0);
		assert.match(cli(env, ["pin"]).stdout, /^hub default: Pi version pin \^1\.1\.0, not pushed yet$/m);
		for (const bad of ["1.x", "latest", ">1.0.0", "1.1.0\u001b[31m"]) {
			const r = cli(env, ["pin", bad]);
			assert.equal(r.code, 2, bad);
			assert.match(r.stderr, /not a Pi version pin: use an exact version such as 1\.1\.0, or \^1\.1\.0, ~1\.1\.0 or >=1\.1\.0/);
			assert.ok(!r.stderr.includes("\u001b"), "printed through printable");
		}
		assert.equal(readPinState(a.l).get("default")?.pin, "^1.1.0", "a refused pin changes nothing");
		const cleared = cli(env, ["pin", "--clear"]);
		assert.equal(cleared.code, 0, cleared.stderr);
		// Never pushed, so clearing it leaves nothing to push.
		assert.match(cli(env, ["pin"]).stdout, /^hub default: no Pi version pin$/m);
	});

	it("refuses a hub that is not configured", () => {
		const env = envOf(a, "host-a");
		initHub(a.l, remote, { env });
		const r = cli(env, ["pin", "1.1.0", "--hub", "work"]);
		assert.equal(r.code, 2);
		assert.match(r.stderr, /hub work is not configured/);
		assert.equal(existsSync(pinStatePath(a.l)), false);
	});

	it("the next sync push records the pin in hub.json, and pull on another host reports it moved and records it", () => {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		createProfile(a.l, "p");
		initHub(a.l, remote, { env: envA });
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		assert.deepEqual(JSON.parse(show("hub.json")), { schemaVersion: 1, aliases: {} }, "no pin: the format old clients read");
		assert.equal(cli(envA, ["pin", "^1.1.0"]).code, 0);
		const push = cli(envA, ["sync", "push"]);
		assert.equal(push.code, 0, push.stderr);
		assert.match(push.stdout, /hub default: Pi version pin \^1\.1\.0 recorded/);
		assert.deepEqual(JSON.parse(show("hub.json")), { schemaVersion: 2, aliases: {}, pi: { version: "^1.1.0" } });
		assert.match(cli(envA, ["pin"]).stdout, /^hub default: Pi version pin \^1\.1\.0$/m, "no longer pending");
		// Host B pulls it.
		initHub(b.l, remote, { env: envB });
		const dry = cli(envB, ["sync", "pull", "--dry-run"]);
		assert.equal(dry.code, 0, dry.stderr);
		assert.match(dry.stdout, /hub default: Pi version pin would move from none to \^1\.1\.0/);
		assert.equal(existsSync(pinStatePath(b.l)), false, "a dry run records nothing");
		const pull = cli(envB, ["sync", "pull"]);
		assert.equal(pull.code, 0, pull.stderr);
		assert.match(pull.stdout, /hub default: Pi version pin moved from none to \^1\.1\.0/);
		assert.deepEqual(readPinState(b.l).get("default"), { pin: "^1.1.0", agreed: "^1.1.0" });
		assert.doesNotMatch(cli(envB, ["sync", "pull"]).stdout, /Pi version pin/, "reported once");
		// A moves it again; B is told.
		assert.equal(cli(envA, ["pin", "1.2.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		assert.match(cli(envB, ["sync", "pull"]).stdout, /hub default: Pi version pin moved from \^1\.1\.0 to 1\.2\.0/);
		// A push from B that did not change the pin keeps it.
		createProfile(b.l, "q");
		assert.equal(cli(envB, ["sync", "push", "q"]).code, 0);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.2.0");
		// --clear goes back to the format old clients read.
		assert.equal(cli(envA, ["sync", "pull"]).code, 0);
		assert.equal(cli(envA, ["pin", "--clear"]).code, 0);
		assert.match(cli(envA, ["sync", "push"]).stdout, /hub default: Pi version pin removed/);
		assert.deepEqual(JSON.parse(show("hub.json")), { schemaVersion: 1, aliases: {} });
		assert.match(cli(envB, ["sync", "pull"]).stdout, /hub default: Pi version pin moved from 1\.2\.0 to none/);
	});

});

/** The commands a refusal names as ways out, in the order printed; a pin may be shell-quoted. */
function waysOut(text: string): string[] {
	return [...text.matchAll(/pi-profile (?:pin (?:--clear|'[^']*'|[^\s,;']+)(?: --hub [a-z0-9_-]+)?|sync pull --(?:theirs|keep-local)(?: [a-z0-9_-]+)*)(?=[\s,;)]|$)/g)].map((m) => m[0]);
}

/** A folder holding a `pi-profile` that runs this build's source, for a test PATH. */
function stubBin(s: Sandbox): string {
	const bin = join(s.home, "stub-bin");
	mkdirSync(bin, { recursive: true });
	const entry = new URL("../src/cli/main.ts", import.meta.url).href;
	writeFileSync(join(bin, "run.mjs"), `const m = await import(${JSON.stringify(entry)});\nprocess.exitCode = m.main(process.argv.slice(2), m.processIo());\n`);
	writeFileSync(join(bin, "pi-profile"), `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(join(bin, "run.mjs"))} "$@"\n`, { mode: 0o755 });
	return bin;
}

function shellWord(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Run a printed `pi-profile ...` command exactly as printed, through `sh -c`, with `pi-profile` on PATH being this build. */
function runPrinted(env: Record<string, string>, command: string): { code: number; stdout: string; stderr: string } {
	assert.ok(command.startsWith("pi-profile "), command);
	const home = env.HOME as string;
	const s = [a, b].find((x) => x.home === home) as Sandbox;
	const r = spawnSync("sh", ["-c", command], { encoding: "utf8", env: { ...env, PATH: [stubBin(s), env.PATH].join(delimiter) } });
	return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe("a diverged Pi version pin is refused like a file conflict (issue 54)", () => {
	/** Host B sets 1.0.4 and does not push it; host A then pushes 1.1.0. Returns B's env. */
	function diverged(): { envA: Record<string, string>; envB: Record<string, string> } {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		createProfile(a.l, "p");
		initHub(a.l, remote, { env: envA });
		initHub(b.l, remote, { env: envB });
		assert.equal(cli(envB, ["pin", "1.0.4"]).code, 0);
		assert.equal(cli(envA, ["pin", "1.1.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		return { envA, envB };
	}

	const refusal =
		"the Pi version pin changed here and in the hub:\n" +
		"  hub default: this host's pin 1.0.4 is not pushed yet, and another host moved the hub's from none to 1.1.0\n" +
		"nothing was written. Take the hub's pin with pi-profile pin 1.1.0, which settles only the pin; or keep this host's with pi-profile sync pull --keep-local p, and the next sync push replaces the hub's pin.";

	it("sync pull exits 2, writes nothing, and names the ways out; --dry-run reports it and writes nothing", () => {
		const { envB } = diverged();
		const before = readFileSync(pinStatePath(b.l), "utf8");
		const dry = cli(envB, ["sync", "pull", "--dry-run"]);
		assert.equal(dry.code, 0, dry.stderr);
		assert.ok(dry.stdout.includes("hub default: this host's pin 1.0.4 is not pushed yet, and another host moved the hub's from none to 1.1.0"), dry.stdout);
		assert.deepEqual(waysOut(dry.stdout), ["pi-profile pin 1.1.0", "pi-profile sync pull --keep-local p"], dry.stdout);
		assert.equal(readFileSync(pinStatePath(b.l), "utf8"), before, "a dry run writes nothing");
		const pull = cli(envB, ["sync", "pull"]);
		assert.equal(pull.code, 2, pull.stdout + pull.stderr);
		assert.equal(pull.stderr, `pi-profile: ${refusal}\n`);
		assert.equal(readFileSync(pinStatePath(b.l), "utf8"), before, "the refusal writes nothing");
		assert.equal(existsSync(join(b.home, "profiles", "p")), false, "no profile written");
		// The push is refused too, instead of replacing the hub's pin unseen.
		const push = cli(envB, ["sync", "push"]);
		assert.equal(push.code, 2, push.stdout + push.stderr);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.1.0");
	});

	for (const [way, hubAfter, pushSays] of [
		["pi-profile pin 1.1.0", "1.1.0", undefined],
		["pi-profile sync pull --keep-local p", "1.0.4", "hub default: Pi version pin 1.0.4 recorded, replacing the hub's 1.1.0\n"],
	] as const) {
		it(`the printed way out "${way}" settles it: the next sync pull and sync push succeed`, () => {
			const { envA, envB } = diverged();
			const pull = cli(envB, ["sync", "pull"]);
			assert.equal(pull.code, 2);
			assert.ok(waysOut(pull.stderr).includes(way), pull.stderr);
			const ran = runPrinted(envB, way);
			assert.equal(ran.code, 0, ran.stdout + ran.stderr);
			const next = cli(envB, ["sync", "pull"]);
			assert.equal(next.code, 0, next.stdout + next.stderr);
			const push = cli(envB, ["sync", "push"]);
			assert.equal(push.code, 0, push.stdout + push.stderr);
			if (pushSays === undefined) assert.doesNotMatch(push.stdout, /Pi version pin/);
			else assert.ok(push.stdout.includes(pushSays), push.stdout);
			assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, hubAfter);
			assert.deepEqual(readPinState(b.l).get("default"), { pin: hubAfter, agreed: hubAfter });
			if (way.includes("--keep-local")) {
				assert.match(ran.stdout, /hub default: Pi version pin moved from none to 1\.1\.0; kept this host's pin 1\.0\.4, so the next sync push replaces the hub's/);
				// Host A is told at its next pull.
				assert.match(cli(envA, ["sync", "pull"]).stdout, /hub default: Pi version pin moved from 1\.1\.0 to 1\.0\.4/);
			}
		});
	}

	it("with names, the flags settle the pin of the hubs those profiles follow, and the way out names them", () => {
		const { envB } = diverged();
		const pull = cli(envB, ["sync", "pull", "p"]);
		assert.equal(pull.code, 2, pull.stdout + pull.stderr);
		assert.deepEqual(waysOut(pull.stderr), ["pi-profile pin 1.1.0", "pi-profile sync pull --keep-local p"], pull.stderr);
		const ran = runPrinted(envB, "pi-profile sync pull --keep-local p");
		assert.equal(ran.code, 0, ran.stderr);
		assert.deepEqual(readPinState(b.l).get("default"), { pin: "1.0.4", agreed: "1.1.0" });
		assert.equal(cli(envB, ["sync", "pull"]).code, 0);
		assert.equal(cli(envB, ["sync", "push"]).code, 0);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.0.4");
	});

	it("--theirs with names settles the pin too, though no way out prints it, since it also takes files", () => {
		const { envB } = diverged();
		const pull = cli(envB, ["sync", "pull", "p"]);
		assert.doesNotMatch(pull.stderr, /--theirs/, pull.stderr);
		const ran = cli(envB, ["sync", "pull", "--theirs", "p"]);
		assert.equal(ran.code, 0, ran.stderr);
		assert.equal(cli(envB, ["sync", "pull"]).code, 0);
		assert.equal(cli(envB, ["sync", "push"]).code, 0);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.1.0");
		assert.deepEqual(readPinState(b.l).get("default"), { pin: "1.1.0", agreed: "1.1.0" });
	});

	it("a pull whose names read no profile of the hub leaves its diverged pin, and the ways out it prints settle it", () => {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		const w = createProfile(a.l, "w").dir;
		const pj = JSON.parse(readFileSync(join(w, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(w, "profile.json"), `${JSON.stringify({ ...pj, sync: { hub: "work" } }, null, "\t")}\n`);
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		for (const [s, env] of [[a, envA], [b, envB]] as const) {
			initHub(s.l, remote, { env });
			initHub(s.l, work, { env, hub: "work" });
		}
		assert.equal(cli(envB, ["pin", "1.0.4"]).code, 0);
		assert.equal(cli(envA, ["pin", "1.1.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		const before = readFileSync(pinStatePath(b.l), "utf8");
		const pull = cli(envB, ["sync", "pull", "w"]);
		assert.equal(pull.code, 0, pull.stdout + pull.stderr);
		assert.ok(pull.stderr.includes("warning: hub default: this host's pin 1.0.4 is not pushed yet, and another host moved the hub's from none to 1.1.0; this pull names no profile of hub default, so its pin is left as it is."), pull.stderr);
		assert.equal(readFileSync(pinStatePath(b.l), "utf8"), before, "left as it is");
		const ways = waysOut(pull.stderr);
		// Hub default holds no profile here, so the --keep-local names none; it reads every hub, so the dry run comes first.
		assert.deepEqual(ways, ["pi-profile pin 1.1.0", "pi-profile sync pull --keep-local"]);
		assert.ok(pull.stderr.includes("run it with --dry-run first"), pull.stderr);
		const ran = runPrinted(envB, ways[1] as string);
		assert.equal(ran.code, 0, ran.stdout + ran.stderr);
		assert.equal(cli(envB, ["sync", "pull"]).code, 0);
		const push = cli(envB, ["sync", "push"]);
		assert.equal(push.code, 0, push.stdout + push.stderr);
		assert.match(push.stdout, /hub default: Pi version pin 1\.0\.4 recorded, replacing the hub's 1\.1\.0/);
		assert.deepEqual(readPinState(b.l).get("default"), { pin: "1.0.4", agreed: "1.0.4" });
	});

	it("a push from a host that never agreed with the hub's pin is refused instead of replacing it", () => {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		createProfile(a.l, "p");
		initHub(a.l, remote, { env: envA });
		assert.equal(cli(envA, ["pin", "1.1.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		// B joins after the pin is in the hub, and sets its own before it pulls.
		initHub(b.l, remote, { env: envB });
		assert.equal(cli(envB, ["pin", "1.0.4"]).code, 0);
		const push = cli(envB, ["sync", "push"]);
		assert.equal(push.code, 2, push.stdout + push.stderr);
		assert.match(push.stderr, /hub default: another host set the Pi version pin 1\.1\.0, and this host's pin 1\.0\.4 is not pushed yet; nothing was pushed\.\nrun pi-profile sync pull first: it names the ways to settle the pin/);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.1.0");
		const pull = cli(envB, ["sync", "pull"]);
		assert.equal(pull.code, 2);
		assert.deepEqual(waysOut(pull.stderr), ["pi-profile pin 1.1.0", "pi-profile sync pull --keep-local p"]);
	});
});

describe("no printed pin way out overwrites a file the user was not shown (issues 54 and 50)", () => {
	/** Start over with two fresh hosts and an empty default hub. */
	function fresh(): void {
		a.cleanup();
		b.cleanup();
		a = sandbox();
		b = sandbox();
		remote = join(a.home, "hub.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	}

	function edit(s: Sandbox, name: string, rel: string, text: string): void {
		writeFileSync(join(s.home, "profiles", name, rel), text);
	}

	function readP(s: Sandbox, name: string, rel: string): string {
		return readFileSync(join(s.home, "profiles", name, rel), "utf8");
	}

	/**
	 * The default hub holds p, hub work holds q; both hosts agreed on pin
	 * 1.0.0. Host B sets 1.0.4 and edits p/AGENTS.md, pushing neither; host A
	 * edits p/AGENTS.md, sets 1.1.0 and pushes. Then B pulls only q.
	 */
	function namedPullOfOtherHub(): { envA: Record<string, string>; envB: Record<string, string>; pull: Cli } {
		fresh();
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		createProfile(a.l, "p");
		const q = createProfile(a.l, "q").dir;
		const pj = JSON.parse(readFileSync(join(q, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(q, "profile.json"), `${JSON.stringify({ ...pj, sync: { hub: "work" } }, null, "\t")}\n`);
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		for (const [s, env] of [[a, envA], [b, envB]] as const) {
			initHub(s.l, remote, { env });
			initHub(s.l, work, { env, hub: "work" });
		}
		edit(a, "p", "AGENTS.md", "base\n");
		assert.equal(cli(envA, ["pin", "1.0.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		const first = cli(envB, ["sync", "pull"]);
		assert.equal(first.code, 0, first.stdout + first.stderr);
		assert.equal(cli(envB, ["pin", "1.0.4"]).code, 0);
		edit(b, "p", "AGENTS.md", "from B\n");
		edit(a, "p", "AGENTS.md", "from A\n");
		assert.equal(cli(envA, ["pin", "1.1.0"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		const pull = cli(envB, ["sync", "pull", "q"]);
		assert.equal(pull.code, 0, pull.stdout + pull.stderr);
		assert.equal(readP(b, "p", "AGENTS.md"), "from B\n");
		return { envA, envB, pull };
	}

	const warning =
		"warning: hub default: this host's pin 1.0.4 is not pushed yet, and another host moved the hub's from 1.0.0 to 1.1.0; this pull names no profile of hub default, so its pin is left as it is. " +
		"Take the hub's pin with pi-profile pin 1.1.0, which settles only the pin; or keep this host's with pi-profile sync pull --keep-local p, and the next sync push replaces the hub's pin. " +
		"--keep-local also keeps this host's copy of any file changed here and in the hub in those profiles, and the next sync push sends it: run it with --dry-run first to see each one.\n";

	it("a named pull that leaves another hub's pin prints only ways out that keep an unpushed edit the pull never showed", () => {
		const ways = waysOut(namedPullOfOtherHub().pull.stderr);
		assert.ok(ways.length > 0);
		for (const [i, way] of ways.entries()) {
			const { envB, pull } = i === 0 ? { envB: envOf(b, "host-b"), pull: undefined } : namedPullOfOtherHub();
			assert.ok(pull === undefined || waysOut(pull.stderr)[i] === way);
			const ran = runPrinted(envB, way);
			assert.equal(ran.code, 0, `${way}: ${ran.stdout}${ran.stderr}`);
			assert.equal(readP(b, "p", "AGENTS.md"), "from B\n", `${way} kept B's unpushed edit`);
			// The pin is settled; the file conflict is now shown, and the next pull and push go through.
			const next = cli(envB, ["sync", "pull"]);
			assert.doesNotMatch(next.stderr, /Pi version pin changed/, way);
			if (next.code !== 0) {
				assert.equal(next.code, 2, next.stderr);
				assert.match(next.stderr, /changed here since the last pull[\s\S]*\n {2}p\/AGENTS\.md\n/, way);
				assert.equal(cli(envB, ["sync", "pull", "--keep-local", "p"]).code, 0, way);
			}
			assert.equal(readP(b, "p", "AGENTS.md"), "from B\n", way);
			assert.equal(cli(envB, ["sync", "pull"]).code, 0, way);
			const push = cli(envB, ["sync", "push"]);
			assert.equal(push.code, 0, `${way}: ${push.stdout}${push.stderr}`);
			assert.equal(show("profiles/p/AGENTS.md"), "from B\n", way);
		}
	});

	it("the named-pull warning leads with the pin-only way out and scopes --keep-local to the hub's profiles", () => {
		const { pull } = namedPullOfOtherHub();
		assert.ok(pull.stderr.includes(warning), pull.stderr);
		assert.doesNotMatch(pull.stderr, /--theirs/);
	});

	it("the no-names refusal never prints a way out that takes the hub's copy of a held profile's unpushed profile.json", () => {
		const setup = (): { envB: Record<string, string>; pull: Cli } => {
			fresh();
			const envA = envOf(a, "host-a");
			const envB = envOf(b, "host-b");
			createProfile(a.l, "p");
			initHub(a.l, remote, { env: envA });
			initHub(b.l, remote, { env: envB });
			assert.equal(cli(envA, ["pin", "1.0.0"]).code, 0);
			assert.equal(cli(envA, ["sync", "push"]).code, 0);
			assert.equal(cli(envB, ["sync", "pull"]).code, 0);
			// B holds extra/ out of sync with an edit of profile.json it keeps and does not push; A pushes extra/.
			const pjB = JSON.parse(readP(b, "p", "profile.json")) as Record<string, unknown>;
			edit(b, "p", "profile.json", `${JSON.stringify({ ...pjB, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
			const pjA = JSON.parse(readP(a, "p", "profile.json")) as Record<string, unknown>;
			edit(a, "p", "profile.json", `${JSON.stringify({ ...pjA, sync: { include: ["extra"] } }, null, "\t")}\n`);
			mkdirSync(join(a.home, "profiles", "p", "extra"), { recursive: true });
			edit(a, "p", "extra/notes.txt", "notes from A\n");
			assert.equal(cli(envA, ["sync", "push"]).code, 0);
			const kept = cli(envB, ["sync", "pull", "--keep-local"]);
			assert.equal(kept.code, 0, kept.stdout + kept.stderr);
			// Then the pin diverges.
			assert.equal(cli(envB, ["pin", "1.0.4"]).code, 0);
			assert.equal(cli(envA, ["pin", "1.1.0"]).code, 0);
			assert.equal(cli(envA, ["sync", "push"]).code, 0);
			const pull = cli(envB, ["sync", "pull"]);
			assert.equal(pull.code, 2, pull.stdout + pull.stderr);
			assert.doesNotMatch(pull.stderr, /profile\.json/, "the refusal does not show profile.json");
			return { envB, pull };
		};
		const ways = waysOut(setup().pull.stderr);
		assert.deepEqual(ways, ["pi-profile pin 1.1.0", "pi-profile sync pull --keep-local p"]);
		for (const [i, way] of ways.entries()) {
			const { envB } = i === 0 ? { envB: envOf(b, "host-b") } : setup();
			const ran = runPrinted(envB, way);
			assert.equal(ran.code, 0, `${way}: ${ran.stdout}${ran.stderr}`);
			assert.deepEqual((JSON.parse(readP(b, "p", "profile.json")) as { sync?: unknown }).sync, { exclude: ["extra"] }, `${way} kept B's profile.json`);
			const next = cli(envB, ["sync", "pull"]);
			assert.equal(next.code, 0, next.stdout + next.stderr);
			assert.doesNotMatch(next.stdout + next.stderr, /Pi version pin changed/);
			assert.deepEqual((JSON.parse(readP(b, "p", "profile.json")) as { sync?: unknown }).sync, { exclude: ["extra"] });
			// p stays held (its own rule, with its own way out); the pin is settled.
			assert.equal(readPinState(b.l).get("default")?.agreed, "1.1.0", way);
		}
	});
});

describe("each printed pin way out works as printed through a shell: range pins, --clear and --hub (issue 54)", () => {
	/**
	 * Two fresh hosts; the default hub holds p and hub work holds q. Both agree on pin `agreed` of
	 * hub `hub`; then B sets `here` (absent: clears it) and does not push, and A sets `theirs`
	 * (absent: clears it) and pushes. Returns B's refused pull.
	 */
	function setup(hub: string, agreed: string, here: string | undefined, theirs: string | undefined): { envB: Record<string, string>; pull: Cli } {
		a.cleanup();
		b.cleanup();
		a = sandbox();
		b = sandbox();
		remote = join(a.home, "hub.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		createProfile(a.l, "p");
		const q = createProfile(a.l, "q").dir;
		const pj = JSON.parse(readFileSync(join(q, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(q, "profile.json"), `${JSON.stringify({ ...pj, sync: { hub: "work" } }, null, "\t")}\n`);
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		for (const [s, env] of [[a, envA], [b, envB]] as const) {
			initHub(s.l, remote, { env });
			initHub(s.l, work, { env, hub: "work" });
		}
		const pin = (env: Record<string, string>, value: string | undefined): void => {
			const r = cli(env, ["pin", value ?? "--clear", "--hub", hub]);
			assert.equal(r.code, 0, r.stderr);
		};
		pin(envA, agreed);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		assert.equal(cli(envB, ["sync", "pull"]).code, 0);
		pin(envB, here);
		pin(envA, theirs);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		const pull = cli(envB, ["sync", "pull"]);
		assert.equal(pull.code, 2, pull.stdout + pull.stderr);
		return { envB, pull };
	}

	for (const [title, hub, agreed, here, theirs, ways] of [
		["a range pin, quoted", "default", "1.0.0", "1.0.4", "^1.1.0", ["pi-profile pin '^1.1.0'", "pi-profile sync pull --keep-local p"]],
		["a hub pin removed: pin --clear", "default", "1.0.0", "1.0.4", undefined, ["pi-profile pin --clear", "pi-profile sync pull --keep-local p"]],
		["another hub: --hub NAME, and --keep-local scoped to its profile", "work", "2.0.0-beta.1", "~2.0.0", ">=2.0.0-rc.1", ["pi-profile pin '>=2.0.0-rc.1' --hub work", "pi-profile sync pull --keep-local q"]],
	] as const) {
		it(`${title}: the printed ways out are ${ways.join(" and ")}, each settles the pin, and the next pull and push succeed`, () => {
			assert.deepEqual(waysOut(setup(hub, agreed, here, theirs).pull.stderr), ways);
			for (const way of ways) {
				const { envB } = setup(hub, agreed, here, theirs);
				const ran = runPrinted(envB, way);
				assert.equal(ran.code, 0, `${way}: ${ran.stdout}${ran.stderr}`);
				const next = cli(envB, ["sync", "pull"]);
				assert.equal(next.code, 0, `${way}: ${next.stdout}${next.stderr}`);
				const push = cli(envB, ["sync", "push"]);
				assert.equal(push.code, 0, `${way}: ${push.stdout}${push.stderr}`);
				const kept = way.includes("--keep-local");
				const want = kept ? here : theirs;
				assert.deepEqual(readPinState(b.l).get(hub) ?? {}, want === undefined ? {} : { pin: want, agreed: want }, way);
				// The push names the pin it replaced; a hub with no pin has none to name.
				if (kept) assert.ok(push.stdout.includes(`hub ${hub}: Pi version pin ${here as string} recorded${theirs === undefined ? "\n" : `, replacing the hub's ${theirs}`}`), push.stdout);
				else assert.doesNotMatch(push.stdout, /Pi version pin/, way);
			}
		});
	}
});

describe("sync push records a waiting pin of a hub no profile here follows (issue 55)", () => {
	it("visits the hub with a commit that changes only hub.json, and the pin is no longer waiting", () => {
		const env = envOf(a, "host-a");
		createProfile(a.l, "p");
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		initHub(a.l, remote, { env });
		initHub(a.l, work, { env, hub: "work" });
		const set = cli(env, ["pin", "2.0.0", "--hub", "work"]);
		assert.match(set.stdout, /hub work: Pi version pin 2\.0\.0 \(was none\); sync push records it in the hub/);
		const push = cli(env, ["sync", "push"]);
		assert.equal(push.code, 0, push.stdout + push.stderr);
		assert.match(push.stdout, /^hub work: pushed [0-9a-f]{12} \(Pi version pin only\)$/m);
		assert.match(push.stdout, /^hub work: Pi version pin 2\.0\.0 recorded$/m);
		assert.equal(git([`--git-dir=${work}`, "ls-tree", "-r", "--name-only", "main"]), "hub.json\n", "only hub.json");
		assert.deepEqual(JSON.parse(git([`--git-dir=${work}`, "show", "main:hub.json"])), { schemaVersion: 2, aliases: {}, pi: { version: "2.0.0" } });
		assert.match(cli(env, ["pin", "--hub", "work"]).stdout, /^hub work: Pi version pin 2\.0\.0$/m, "no longer waiting");
		assert.deepEqual(readPinState(a.l).get("work"), { pin: "2.0.0", agreed: "2.0.0" });
		// Nothing waits now, so the next push does not visit it.
		const again = cli(env, ["sync", "push"]);
		assert.equal(again.code, 0, again.stderr);
		assert.doesNotMatch(again.stdout, /hub work/);
		// Another host pulls it.
		const envB = envOf(b, "host-b");
		initHub(b.l, work, { env: envB, hub: "work" });
		assert.equal(cli(envB, ["sync", "pull"]).code, 0);
		assert.deepEqual(readPinState(b.l).get("work"), { pin: "2.0.0", agreed: "2.0.0" });
	});

	it("a hub that moved is fetched and refused, under the same rules as any push", () => {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		initHub(a.l, remote, { env: envA });
		initHub(a.l, work, { env: envA, hub: "work" });
		initHub(b.l, remote, { env: envB });
		initHub(b.l, work, { env: envB, hub: "work" });
		assert.equal(cli(envA, ["pin", "2.0.0", "--hub", "work"]).code, 0);
		assert.equal(cli(envA, ["sync", "push"]).code, 0);
		assert.equal(cli(envB, ["pin", "3.0.0", "--hub", "work"]).code, 0);
		const push = cli(envB, ["sync", "push"]);
		assert.equal(push.code, 2, push.stdout + push.stderr);
		assert.match(push.stderr, /hub work has commits this host has not pulled \(fetched it\)\. Nothing was merged or pushed\.\nrun pi-profile sync pull first/);
		assert.deepEqual(JSON.parse(git([`--git-dir=${work}`, "show", "main:hub.json"])), { schemaVersion: 2, aliases: {}, pi: { version: "2.0.0" } });
		assert.deepEqual(readPinState(b.l).get("work"), { pin: "3.0.0" }, "still waiting");
	});

	it("a push that names profiles does not visit another hub for its pin", () => {
		const env = envOf(a, "host-a");
		createProfile(a.l, "p");
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		initHub(a.l, remote, { env });
		initHub(a.l, work, { env, hub: "work" });
		assert.equal(cli(env, ["pin", "2.0.0", "--hub", "work"]).code, 0);
		const push = cli(env, ["sync", "push", "p"]);
		assert.equal(push.code, 0, push.stderr);
		assert.doesNotMatch(push.stdout, /hub work/);
		assert.deepEqual(readPinState(a.l).get("work"), { pin: "2.0.0" });
	});
});

describe("a pin.json that cannot be written after a push names pin.json (issue 57)", () => {
	it("records the push in last.json, and warns about pin.json only", () => {
		const env = envOf(a, "host-a");
		createProfile(a.l, "p");
		initHub(a.l, remote, { env });
		assert.equal(cli(env, ["pin", "1.1.0"]).code, 0);
		const pinFile = pinStatePath(a.l);
		const r = pushHubs(a.l, ["p"], {
			env,
			hooks: {
				beforeGate: () => {
					// pin.json was read; now it cannot be read or replaced.
					rmSync(pinFile);
					mkdirSync(join(pinFile, "x"), { recursive: true });
				},
			},
		});
		const h = r.hubs[0];
		assert.equal(h?.failed, undefined);
		assert.ok(h?.commit !== undefined);
		assert.match(h?.warning ?? "", /pin\.json/);
		assert.doesNotMatch(h?.warning ?? "", /last\.json/);
		assert.match(h?.warning ?? "", /hub default: pushed [0-9a-f]{12}, and the hub holds the Pi version pin 1\.1\.0, but it could not be recorded in .*pin\.json: /);
		const last = JSON.parse(readFileSync(join(a.home, "pi-profile", "state", "sync", "last.json"), "utf8")) as { profiles: Record<string, { hub: string }> };
		assert.equal(last.profiles.p?.hub, "default", "last.json records the push");
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "1.1.0");
	});
});

describe("the commit gate reads a hub.json that carries a pin", () => {
	it("parses schemaVersion 2 with a valid pin, and refuses a bad pin or a newer schema with a clear reason", () => {
		assert.deepEqual(parseHubJson(Buffer.from(JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "^1.1.0" } }))), { schemaVersion: 2, aliases: {}, pin: "^1.1.0" });
		assert.match(String(parseHubJson(Buffer.from(JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "1.x" } })))), /pi\.version is not a Pi version pin/);
		assert.match(String(parseHubJson(Buffer.from(JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "1.1.0", url: "x" } })))), /hub\.json must be/);
		assert.match(String(parseHubJson(Buffer.from(JSON.stringify({ schemaVersion: 1, aliases: {}, pi: { version: "1.1.0" } })))), /hub\.json must be/);
		assert.match(String(parseHubJson(Buffer.from(JSON.stringify({ schemaVersion: 3, aliases: {} })))), /schemaVersion 3 is newer than this pi-profile reads; upgrade pi-profile on this host/);
	});

	it("pull refuses a hub whose pin is malformed, writing nothing and never printing the value", () => {
		const envB = envOf(b, "host-b");
		hubCommit(`${JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "1.1.0\u001b]0;pwned\u0007" } })}\n`);
		initHub(b.l, remote, { env: envB });
		const r = cli(envB, ["sync", "pull"]);
		assert.equal(r.code, 2);
		assert.match(r.stderr, /refused to pull from hub default; nothing was written:\n {2}hub\.json: hub\.json: pi\.version is not a Pi version pin/);
		assert.ok(!r.stderr.includes("pwned") && !r.stderr.includes("\u001b"));
		assert.equal(existsSync(pinStatePath(b.l)), false);
	});

	it("pull accepts a hub.json with a valid pin, and push refuses to commit a bad one", () => {
		const envA = envOf(a, "host-a");
		const envB = envOf(b, "host-b");
		hubCommit(`${JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "~1.1.0" } })}\n`);
		assert.deepEqual(gateTree(remote, "main", envB), []);
		initHub(b.l, remote, { env: envB });
		assert.equal(pullHubs(b.l, [], { env: envB }).pins[0]?.to, "~1.1.0");
		createProfile(a.l, "p");
		initHub(a.l, remote, { env: envA });
		pullHubs(a.l, [], { env: envA });
		const r = pushHubs(a.l, ["p"], { env: envA, hooks: { beforeGate: (stage) => stage("hub.json", Buffer.from(JSON.stringify({ schemaVersion: 2, aliases: {}, pi: { version: "nope" } }))) } });
		assert.equal(r.hubs[0]?.failed?.refused, true);
		assert.match(r.hubs[0]?.failed?.message ?? "", /refused to commit to hub default; nothing was pushed:\n {2}hub\.json: hub\.json: pi\.version is not a Pi version pin/);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "~1.1.0");
	});
});

describe("run and doctor compare the pin with the Pi run launches", () => {
	function pinned(pin: string, bin: string): Record<string, string> {
		const env = envOf(a, "host-a", bin);
		createProfile(a.l, "p");
		initHub(a.l, remote, { env });
		assert.equal(cli(env, ["pin", pin]).code, 0);
		return env;
	}

	it("on a mismatch run prints one warning to stderr, launches pi, and passes its exit code through", () => {
		const env = pinned("^1.2.0", npmPi(a.home, "1.1.0"));
		const r = cli(env, ["run", "p", "--", "-p", "hi"], { piExit: 7 });
		assert.equal(r.code, 7);
		assert.deepEqual(r.runs.map((x) => x.args), [["-p", "hi"]]);
		assert.equal(r.stderr.split("\n").filter((x) => x !== "").length, 1, r.stderr);
		assert.match(r.stderr, /^pi-profile: warning: Pi 1\.1\.0 does not match the Pi version pin \^1\.2\.0 of hub default; launching it anyway \(see pi-profile pin\)\n$/);
		assert.equal(r.stdout, "");
		assert.deepEqual(r.installs, [], "run never installs");
	});

	it("on a match, or with no pin, run prints nothing extra", () => {
		const env = pinned("^1.1.0", npmPi(a.home, "1.1.0"));
		const r = cli(env, ["run", "p"]);
		assert.equal(r.code, 0);
		assert.equal(r.stderr, "");
		assert.equal(r.runs.length, 1);
		assert.equal(cli(env, ["pin", "--clear"]).code, 0);
		// The npm Pi stays on PATH, so this fails if run warns without a pin (issue 57).
		const none = cli(env, ["run", "p"]);
		assert.equal(none.code, 0);
		assert.equal(none.runs.length, 1);
		assert.equal(none.stderr, "");
	});

	it("run reads the pin from local state, never the hub", () => {
		const env = pinned("^1.2.0", managedPi(a.home, "1.1.0"));
		rmSync(remote, { recursive: true, force: true });
		rmSync(hubMirror(a.l, "default"), { recursive: true, force: true });
		const r = cli(env, ["run", "p"], { piExit: 3 });
		assert.equal(r.code, 3);
		assert.match(r.stderr, /Pi 1\.1\.0 does not match the Pi version pin \^1\.2\.0 of hub default/);
	});

	it("run still launches when the pin state is broken", () => {
		const env = pinned("^1.2.0", npmPi(a.home, "1.1.0"));
		writeFileSync(pinStatePath(a.l), "{ not json");
		const r = cli(env, ["run", "p"], { piExit: 4 });
		assert.equal(r.code, 4);
		assert.match(r.stderr, /^pi-profile: warning: the Pi version pin was not checked: /);
	});

	it("doctor reports a mismatch, and nothing on a match", () => {
		const env = pinned("^1.2.0", npmPi(a.home, "1.1.0"));
		const r = cli(env, ["doctor"]);
		assert.match(r.stdout, /^warn {2}Pi 1\.1\.0 \(.*\/npm\/bin\/pi\) does not match the Pi version pin \^1\.2\.0 of hub default \(profiles: default, p\); see pi-profile pin$/m);
		assert.deepEqual(r.installs, []);
		assert.equal(cli(env, ["pin", "^1.1.0"]).code, 0);
		assert.doesNotMatch(cli(env, ["doctor"]).stdout, /Pi version pin/);
	});

	it("with two hubs, each profile is checked against its own hub's pin", () => {
		const bin = npmPi(a.home, "1.1.0");
		const env = envOf(a, "host-a", bin);
		createProfile(a.l, "p");
		const w = createProfile(a.l, "w").dir;
		const pj = JSON.parse(readFileSync(join(w, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(w, "profile.json"), `${JSON.stringify({ ...pj, sync: { hub: "work" } }, null, "\t")}\n`);
		const work = join(a.home, "work.git");
		git(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		initHub(a.l, remote, { env });
		initHub(a.l, work, { env, hub: "work" });
		assert.equal(cli(env, ["pin", "^1.1.0"]).code, 0);
		assert.equal(cli(env, ["pin", "2.0.0", "--hub", "work"]).code, 0);
		const shown = cli(env, ["pin"]).stdout;
		assert.match(shown, /^hub default: Pi version pin \^1\.1\.0, not pushed yet; Pi here matches$/m);
		assert.match(shown, /^hub work: Pi version pin 2\.0\.0, not pushed yet; Pi here does not match$/m);
		assert.equal(cli(env, ["run", "p"]).stderr, "");
		assert.match(cli(env, ["run", "w"]).stderr, /does not match the Pi version pin 2\.0\.0 of hub work/);
		const doc = cli(env, ["doctor"]).stdout;
		assert.match(doc, /Pi version pin 2\.0\.0 of hub work \(profiles: w\)/);
		assert.doesNotMatch(doc, /of hub default/);
		// Each push records each hub's own pin; a pull on another host records both.
		const push = cli(env, ["sync", "push"]);
		assert.equal(push.code, 0, push.stderr);
		assert.equal((JSON.parse(show("hub.json")) as { pi: { version: string } }).pi.version, "^1.1.0");
		assert.equal((JSON.parse(git([`--git-dir=${work}`, "show", "main:hub.json"])) as { pi: { version: string } }).pi.version, "2.0.0");
		const envB = envOf(b, "host-b", bin);
		initHub(b.l, remote, { env: envB });
		initHub(b.l, work, { env: envB, hub: "work" });
		const pull = cli(envB, ["sync", "pull"]);
		assert.equal(pull.code, 0, pull.stderr);
		assert.deepEqual([...readPinState(b.l)].sort(), [["default", { pin: "^1.1.0", agreed: "^1.1.0" }], ["work", { pin: "2.0.0", agreed: "2.0.0" }]]);
		assert.match(cli(envB, ["run", "w"]).stderr, /of hub work/);
		assert.equal(cli(envB, ["run", "p"]).stderr, "");
	});
});

describe("pin --install", () => {
	it("prints the exact npm command, then runs it through the runner, for an npm global install", () => {
		const bin = npmPi(a.home, "1.1.0");
		const env = envOf(a, "host-a", bin);
		initHub(a.l, remote, { env });
		let printedFirst = false;
		const io = captureIo(env);
		const installs: Array<readonly string[]> = [];
		const installPi: CommandRunner = (argv) => {
			installs.push(argv);
			printedFirst = io.stdout.includes("running: npm");
			assert.deepEqual(argv, ["npm", "install", "--global", "--prefix", join(a.home, "npm"), "@earendil-works/pi-coding-agent@^1.2.0"]);
			writeFileSync(join(a.home, "npm", "lib", "node_modules", ...PKG, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.3" }));
			return { status: 0 };
		};
		const code = main(["pin", "^1.2.0", "--install"], { ...io, out: io.out, installPi } as Io);
		assert.equal(code, 0, io.stderr);
		assert.equal(installs.length, 1);
		assert.ok(printedFirst, "the command is printed before it runs");
		assert.ok(io.stdout.includes(`running: npm install --global --prefix ${join(a.home, "npm")} '@earendil-works/pi-coding-agent@^1.2.0'\n`), io.stdout);
		assert.match(io.stdout, /Pi 1\.2\.3 here now matches the Pi version pin \^1\.2\.0 of hub default/);
	});

	it("installs Pi only with pin --install: no other command installs Pi, and sync pull installs packages only with --install-packages", () => {
		const env = envOf(a, "host-a", npmPi(a.home, "1.1.0"));
		const p = createProfile(a.l, "p").dir;
		// A package the peer is missing, so an enrol that installed would call the runner.
		writeFileSync(join(p, "settings.json"), `${JSON.stringify({ packages: ["npm:missing@1.0.0"] }, null, "\t")}\n`);
		initHub(a.l, remote, { env });
		// The Pi installer: none of these installs Pi, sync pull --install-packages included.
		for (const argv of [["pin", "^1.2.0"], ["pin"], ["run", "p"], ["doctor"], ["sync", "push"], ["sync", "pull"], ["sync", "pull", "--install-packages"]]) assert.deepEqual(cli(env, argv).installs, [], argv.join(" "));
		// The package runner: sync pull installs the missing package only with --install-packages.
		for (const [argv, want] of [
			[["sync", "pull"], []],
			[["sync", "pull", "--install-packages"], [["install", "npm:missing@1.0.0"]]],
		] as const) {
			const ran: Array<readonly string[]> = [];
			const io = Object.assign(captureIo(env), { packages: ((argv2) => (ran.push(argv2), { status: 0, stderr: "" })) satisfies PackageRunner });
			assert.equal(main([...argv], io as Io), 0, io.stderr);
			assert.deepEqual(ran, want, argv.join(" "));
		}
		// enrol, with a stand-in ssh that runs the peer half on host B in this process: neither host installs Pi or a package.
		// The peer's pi and npm log every call, so an install through the real runners is seen too.
		const installs: Array<readonly string[]> = [];
		const peerBin = join(b.home, "logging-bin");
		const calls = join(b.home, "calls.log");
		mkdirSync(peerBin, { recursive: true });
		writeFileSync(join(peerBin, "pi"), `#!/bin/sh\nif [ "$1" = --version ]; then echo 1.1.0; exit 0; fi\necho "pi $*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
		writeFileSync(join(peerBin, "npm"), `#!/bin/sh\necho "npm $*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
		const peerEnv = envOf(b, "kiwi", peerBin);
		const ssh: SshRunner = (args) => {
			const words = args.slice(args.indexOf("--") + 2);
			if (words[0] !== "pi-profile") return { status: 0, stdout: "node=v24.0.0\npi=/usr/bin/pi\npi-profile=/usr/bin/pi-profile\nshell=/bin/sh\n", stderr: "" };
			const peer = Object.assign(captureIo(peerEnv), {
				installPi: ((argv2) => (installs.push(argv2), { status: 0 })) satisfies CommandRunner,
				packages: ((argv2) => (installs.push(["pi", ...argv2]), { status: 0, stderr: "" })) satisfies PackageRunner,
			});
			const status = main(words.slice(1), peer as Io);
			return { status, stdout: peer.stdout, stderr: peer.stderr };
		};
		const io = Object.assign(captureIo(env), {
			ssh,
			installPi: ((argv2) => (installs.push(argv2), { status: 0 })) satisfies CommandRunner,
			packages: ((argv2) => (installs.push(["pi", ...argv2]), { status: 0, stderr: "" })) satisfies PackageRunner,
		});
		const enrolled = main(["enrol", "kiwi", "--remote", remote], io as Io);
		assert.equal(enrolled, 0, io.stdout + io.stderr);
		assert.match(io.stdout, /kiwi: pull: /, io.stdout);
		assert.deepEqual(installs, [], "enrol never installs");
		assert.equal(existsSync(calls) ? readFileSync(calls, "utf8") : "", "", "the peer's pi and npm were never asked to install");
		assert.ok(existsSync(join(b.home, "profiles", "p", "settings.json")), "the peer pulled the profile with the missing package");
		assert.equal(cli(env, ["pin", "^1.1.0"]).code, 0);
		const r = cli(env, ["pin", "--install"]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.installs, []);
		assert.match(r.stdout, /Pi 1\.1\.0 here already matches the Pi version pin \^1\.1\.0 of hub default; nothing to install/);
	});

	it("refuses a managed install, which has no command that installs a chosen version, and says what to run instead", () => {
		const env = envOf(a, "host-a", managedPi(a.home, "1.1.0"));
		initHub(a.l, remote, { env });
		const r = cli(env, ["pin", "1.0.4", "--install"]);
		assert.equal(r.code, 2);
		assert.deepEqual(r.installs, []);
		assert.match(r.stderr, /is a managed install \(the pi\.dev installer\)/);
		assert.match(r.stderr, /npm install --global '@earendil-works\/pi-coding-agent@1\.0\.4'/);
		assert.equal(readFileSync(join(a.home, "mpi", "install", "current-version"), "utf8"), "1.1.0\n", "never edits the managed install");
		assert.equal(readPinState(a.l).get("default")?.pin, "1.0.4", "the pin is still set");
	});

	it("refuses when there is no pin, and reports a failed install with exit 1", () => {
		const env = envOf(a, "host-a", npmPi(a.home, "1.1.0"));
		initHub(a.l, remote, { env });
		const none = cli(env, ["pin", "--install"]);
		assert.equal(none.code, 2);
		assert.match(none.stderr, /hub default has no Pi version pin/);
		const failed = cli(env, ["pin", "2.0.0", "--install"], { installer: () => ({ status: 1 }) });
		assert.equal(failed.code, 1);
		assert.equal(failed.installs.length, 1);
		assert.match(failed.stderr, /the install failed \(exit 1\)/);
	});
});
