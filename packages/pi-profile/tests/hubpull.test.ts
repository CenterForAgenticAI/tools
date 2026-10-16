import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { updateConfig } from "../src/core/config.ts";
import { hubMirror, hubsDir, initHub, pushHubs } from "../src/core/hub.ts";
import { pullHubs, type PullHooks, type PullReport } from "../src/core/hubpull.ts";
import { syncStatePath } from "../src/core/hubstate.ts";
import { LOCK_FILE } from "../src/core/lock.ts";
import type { PackageRunner } from "../src/core/packages.ts";
import { createProfile } from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Tests for issue 32: `sync pull`. Host A pushes, host B pulls; the hub is a local bare repository. */

let a: Sandbox;
let b: Sandbox;
let remote: string;
let envA: Record<string, string | undefined>;
let envB: Record<string, string | undefined>;

function run(args: readonly string[], input?: string | Buffer): string {
	const r = spawnSync("git", [...args], {
		encoding: "utf8",
		...(input === undefined ? {} : { input }),
		env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

function head(repo: string, ref = "refs/heads/main"): string | undefined {
	const r = spawnSync("git", [`--git-dir=${repo}`, "rev-parse", "-q", "--verify", ref], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}

function profileOnA(name = "p"): string {
	const dir = createProfile(a.l, name).dir;
	writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nBe brief.\n");
	mkdirSync(join(dir, "skills", "s"), { recursive: true });
	writeFileSync(join(dir, "skills", "s", "SKILL.md"), "---\nname: s\n---\nA skill.\n");
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "dark", tool: `${a.home}/Code/tool` }, null, "\t")}\n`);
	return dir;
}

function pushA(names: readonly string[] = ["p"]): string {
	for (const n of names) if (!existsSync(join(a.home, "profiles", n))) profileOnA(n);
	initHub(a.l, remote, { env: envA });
	const r = pushHubs(a.l, names, { env: envA });
	assert.deepEqual(r.hubs.filter((h) => h.failed !== undefined), [], JSON.stringify(r.hubs));
	return head(remote) as string;
}

function initB(): void {
	initHub(b.l, remote, { env: envB });
}

function pullB(names: readonly string[] = [], opts: Omit<Parameters<typeof pullHubs>[2], "env"> = {}): PullReport {
	return pullHubs(b.l, names, { env: envB, ...opts });
}

function refusal(fn: () => unknown, re: RegExp): Refusal {
	try {
		fn();
	} catch (error) {
		assert.ok(error instanceof Refusal, `expected a Refusal, got ${String(error)}`);
		assert.match(error.message, re);
		return error;
	}
	assert.fail("expected a Refusal");
}

const bP = (...rel: string[]): string => join(b.home, "profiles", "p", ...rel);
const aP = (...rel: string[]): string => join(a.home, "profiles", "p", ...rel);

beforeEach(() => {
	a = sandbox();
	b = sandbox();
	remote = join(a.home, "hub.git");
	run(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	envA = { HOME: a.home, PI_PROFILE_HOME: a.home, PI_PROFILE_HOST_ID: "host-a", PATH: process.env.PATH };
	envB = { HOME: b.home, PI_PROFILE_HOME: b.home, PI_PROFILE_HOST_ID: "host-b", PATH: process.env.PATH };
});
afterEach(() => {
	a.cleanup();
	b.cleanup();
});

/** A commit made by hand in the hub, as a hostile or broken host might: `files` are [path, mode, content]. */
function hostileCommit(files: ReadonlyArray<readonly [string, string, string | Buffer]>): string {
	type Node = Map<string, Node | { mode: string; sha: string }>;
	const root: Node = new Map();
	for (const [path, mode, content] of files) {
		const sha = run([`--git-dir=${remote}`, "hash-object", "-w", "--stdin"], content).trim();
		const segs = path.split("/");
		let at = root;
		for (const seg of segs.slice(0, -1)) {
			let next = at.get(seg);
			if (!(next instanceof Map)) {
				next = new Map();
				at.set(seg, next);
			}
			at = next;
		}
		at.set(segs[segs.length - 1] as string, { mode, sha });
	}
	const write = (node: Node): string =>
		run([`--git-dir=${remote}`, "mktree"], [...node].map(([name, v]) => (v instanceof Map ? `040000 tree ${write(v)}\t${name}` : `${v.mode} blob ${v.sha}\t${name}`)).join("\n") + "\n").trim();
	const commit = run([`--git-dir=${remote}`, "commit-tree", write(root), "-m", "hostile"]).trim();
	run([`--git-dir=${remote}`, "update-ref", "refs/heads/main", commit]);
	return commit;
}

const MANIFEST = (name: string): string => `${JSON.stringify({ schemaVersion: 1, name, auth: { mode: "shared" } }, null, "\t")}\n`;

describe("sync pull renders the hub into local profiles (issue 32)", () => {
	it("creates a profile this host does not have, with path tokens rendered for this host", () => {
		const commit = pushA();
		initB();
		const r = pullB();
		assert.deepEqual(r.hubs.map((h) => [h.hub, h.commit, h.failed]), [["default", commit, undefined]]);
		assert.equal(r.profiles.find((p) => p.profile === "p")?.created, true);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
		assert.equal(readFileSync(bP("skills", "s", "SKILL.md"), "utf8"), "---\nname: s\n---\nA skill.\n");
		const settings = JSON.parse(readFileSync(bP("settings.json"), "utf8")) as Record<string, unknown>;
		assert.equal(settings.tool, `${b.home}/Code/tool`, "${CODE} expands to this host's code root");
		assert.equal("sessionDir" in settings, false);
		assert.equal((JSON.parse(readFileSync(bP("profile.json"), "utf8")) as { name: string }).name, "p");
		// A new profile gets its auth link as `create` makes it; pull never carries auth.json.
		assert.ok(lstatSync(bP("auth.json")).isSymbolicLink());
		assert.equal(readlinkSync(bP("auth.json")), join(b.home, "agent", "auth.json"));
		const last = JSON.parse(readFileSync(syncStatePath(b.l), "utf8")) as { hubs: Record<string, { commit: string }> };
		assert.equal(last.hubs.default?.commit, commit);
		assert.equal(head(hubMirror(b.l, "default")), commit);
	});

	it("sets sessionDir from this host's machine config, never from the hub", () => {
		updateConfig(a.l, (c) => ({ ...c, sessionStores: { big: { path: "/srv/a-sessions" } } }), envA);
		updateConfig(b.l, (c) => ({ ...c, sessionStores: { big: { path: "/srv/b-sessions" } } }), envB);
		const dir = profileOnA();
		writeFileSync(join(dir, "profile.json"), `${JSON.stringify({ schemaVersion: 1, name: "p", auth: { mode: "shared" }, sessions: { store: "big" } }, null, "\t")}\n`);
		writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "dark", sessionDir: "/srv/a-sessions" }, null, "\t")}\n`);
		pushA();
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/p/settings.json"]).includes("sessionDir"), false);
		initB();
		pullB();
		assert.equal((JSON.parse(readFileSync(bP("settings.json"), "utf8")) as { sessionDir?: string }).sessionDir, "/srv/b-sessions");
	});

	it("links an alias to its target and never makes a second copy", () => {
		profileOnA();
		symlinkSync("p", join(a.home, "profiles", "al"));
		pushA(["p", "al"]);
		initB();
		pullB();
		const al = join(b.home, "profiles", "al");
		assert.ok(lstatSync(al).isSymbolicLink());
		assert.equal(readlinkSync(al), "p");
		assert.ok(existsSync(bP("AGENTS.md")));
	});

	it("refuses a hostile hub: non-config, traversal, links, credential names and oversize files; writes nothing", () => {
		initB();
		const cases: Array<[Array<readonly [string, string, string | Buffer]>, RegExp]> = [
			[[["profiles/p/cache/x.json", "100644", "{}\n"]], /profiles\/p\/cache\/x\.json: class state/],
			[[["profiles/p/skills/../../q/settings.json", "100644", "{}\n"]], /profiles\/p\/skills\/\.\.\/\.\.\/q\/settings\.json: not a plain relative path/],
			[[["profiles/p/AGENTS.md", "120000", "/etc/passwd"]], /profiles\/p\/AGENTS\.md: not a plain file \(mode 120000\)/],
			[[["profiles/p/auth.json", "100644", "{}\n"]], /profiles\/p\/auth\.json: a credential file name/],
			[[["profiles/p/AGENTS.md", "100644", Buffer.alloc(1024 * 1024 + 1, 0x61)]], /profiles\/p\/AGENTS\.md: larger than 1 MiB/],
		];
		for (const [files, re] of cases) {
			hostileCommit([["profiles/p/profile.json", "100644", MANIFEST("p")], ...files]);
			const r = pullB();
			const f = r.hubs[0]?.failed;
			assert.ok(f?.refused === true, JSON.stringify(r.hubs));
			assert.match(f.message, re);
			assert.match(f.message, /nothing was written/);
			assert.equal(existsSync(join(b.home, "profiles", "p")), false);
			assert.equal(existsSync(join(b.home, "profiles", "q")), false);
			assert.equal(existsSync(syncStatePath(b.l)), false);
		}
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull"], io), 2, io.stderr);
		assert.match(io.stderr, /refused to pull from hub default/);
	});

	it("refuses with exit 2 and lists the files when a file changed here since the last pull", () => {
		pushA();
		initB();
		pullB();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nFrom A.\n");
		writeFileSync(aP("skills", "s", "SKILL.md"), "---\nname: s\n---\nA's skill.\n");
		pushA();
		writeFileSync(bP("AGENTS.md"), "# Agents\n\nFrom B.\n");
		refusal(() => pullB(), /changed here since the last pull[\s\S]*\n {2}p\/AGENTS\.md\n[\s\S]*--theirs[\s\S]*--keep-local/);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom B.\n");
		assert.equal(readFileSync(bP("skills", "s", "SKILL.md"), "utf8"), "---\nname: s\n---\nA skill.\n", "nothing is written when a pull is refused");
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull"], io), 2);
		assert.match(io.stderr, /p\/AGENTS\.md/);
		assert.doesNotMatch(io.stderr, /SKILL\.md/, "a file changed only in the hub is not a conflict");
	});

	it("--keep-local keeps the local file and records the pull; --theirs takes the hub's copy", () => {
		pushA();
		initB();
		pullB();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nFrom A.\n");
		writeFileSync(aP("skills", "s", "SKILL.md"), "---\nname: s\n---\nA's skill.\n");
		const second = pushA();
		writeFileSync(bP("AGENTS.md"), "# Agents\n\nFrom B.\n");
		const kept = pullB([], { resolve: "keep-local" });
		assert.deepEqual(kept.conflicts, []);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom B.\n");
		assert.equal(readFileSync(bP("skills", "s", "SKILL.md"), "utf8"), "---\nname: s\n---\nA's skill.\n");
		assert.equal((JSON.parse(readFileSync(syncStatePath(b.l), "utf8")) as { hubs: Record<string, { commit: string }> }).hubs.default?.commit, second);
		// The hub has not changed the file since: a plain pull keeps the local edit and does not refuse.
		pullB();
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom B.\n");
		// The hub changes it again: a conflict once more, until a side is picked.
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nFrom A, again.\n");
		pushA();
		refusal(() => pullB(), /p\/AGENTS\.md/);
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull", "--theirs"], io), 0, io.stderr);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom A, again.\n");
		assert.equal(main(["sync", "pull", "--theirs", "--keep-local"], captureIo(envB)), 2);
		refusal(() => pullB(["nope"]), /not in any hub: nope/);
	});

	it("treats a first pull onto a file that differs from the hub as a conflict", () => {
		pushA();
		initB();
		const dir = createProfile(b.l, "p").dir;
		writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nMine.\n");
		refusal(() => pullB(), /\n {2}p\/AGENTS\.md\n/);
		assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "# Agents\n\nMine.\n");
	});

	it("--dry-run prints the plan and writes nothing", () => {
		initB();
		pushA();
		const before = head(hubMirror(b.l, "default"));
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull", "--dry-run"], io), 0, io.stderr);
		assert.match(io.stdout, /p: would create the profile/);
		assert.match(io.stdout, /p\/AGENTS\.md: would write/);
		assert.equal(existsSync(join(b.home, "profiles", "p")), false);
		assert.equal(existsSync(syncStatePath(b.l)), false);
		assert.equal(head(hubMirror(b.l, "default")), before);
	});

	it("removes a file the hub dropped when it is unchanged here", () => {
		const extra = (): string => aP("skills", "s", "notes.md");
		profileOnA();
		writeFileSync(extra(), "notes\n");
		pushA();
		initB();
		pullB();
		assert.ok(existsSync(bP("skills", "s", "notes.md")));
		rmSync(extra());
		pushA();
		const r = pullB();
		assert.equal(existsSync(bP("skills", "s", "notes.md")), false);
		assert.deepEqual(r.profiles.find((p) => p.profile === "p")?.files, [{ path: "skills/s/notes.md", action: "remove" }]);
		// A dropped file this host now excludes is state here: left alone.
		writeFileSync(extra(), "notes\n");
		pushA();
		pullB();
		const pj = JSON.parse(readFileSync(bP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pj, sync: { exclude: ["skills/s/notes.md"] } }, null, "\t")}\n`);
		rmSync(extra());
		pushA();
		pullB([], { resolve: "keep-local" });
		assert.equal(readFileSync(bP("skills", "s", "notes.md"), "utf8"), "notes\n");
	});

	it("holds the sync lock for the whole pull and one profile lock at a time; every lock refuses at once", () => {
		profileOnA("p");
		profileOnA("q");
		pushA(["p", "q"]);
		initB();
		const seen: Array<[string, boolean, boolean, boolean]> = [];
		const locked = (dir: string): boolean => existsSync(join(dir, LOCK_FILE));
		const hooks: PullHooks = {
			beforeWrite: (name) => {
				const other = name === "p" ? "q" : "p";
				seen.push([name, locked(hubsDir(b.l)), locked(join(b.home, "profiles", name)), existsSync(join(b.home, "profiles", other)) && locked(join(b.home, "profiles", other))]);
			},
		};
		pullB([], { hooks });
		const firstPulled = head(hubMirror(b.l, "default"));
		assert.deepEqual(seen, [
			["p", true, true, false],
			["q", true, true, false],
		]);
		assert.equal(locked(hubsDir(b.l)), false);
		// A live process (the test runner's parent) holds the sync lock: refused at once.
		writeFileSync(join(hubsDir(b.l), LOCK_FILE), `${String(process.ppid)} other\n`);
		const t0 = Date.now();
		refusal(() => pullB(), /being changed by process/);
		assert.ok(Date.now() - t0 < 5000);
		rmSync(join(hubsDir(b.l), LOCK_FILE));
		// A profile another pi-profile is changing: refused when named, left out and listed otherwise.
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nNew.\n");
		writeFileSync(join(a.home, "profiles", "q", "AGENTS.md"), "# Agents\n\nNew q.\n");
		pushA(["p", "q"]);
		writeFileSync(bP(LOCK_FILE), `${String(process.ppid)} other\n`);
		const named = pullB(["p"]).hubs[0]?.failed;
		assert.ok(named?.refused === true && /being changed by process/.test(named.message), JSON.stringify(named));
		const r = pullB();
		assert.ok(r.skippedProfiles.some((x) => x.profile === "p" && /being changed/.test(x.reason)), JSON.stringify(r.skippedProfiles));
		assert.equal(readFileSync(join(b.home, "profiles", "q", "AGENTS.md"), "utf8"), "# Agents\n\nNew q.\n");
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
		assert.deepEqual(r.hubs[0]?.pending, ["p"], "main does not move past a profile that was not pulled");
		assert.equal(head(hubMirror(b.l, "default")), firstPulled, "the mirror's main stays at the last commit pulled in full");
		rmSync(bP(LOCK_FILE));
		const done = pullB();
		assert.equal(done.hubs[0]?.pending, undefined);
		assert.equal(head(hubMirror(b.l, "default")), head(remote), "main moves once every profile is pulled");
	});

	it("a pull killed while writing leaves every file whole, and the next pull finishes", () => {
		pushA();
		initB();
		pullB();
		const first = head(hubMirror(b.l, "default"));
		const big = `# Agents\n\n${"New line.\n".repeat(50_000)}`;
		writeFileSync(aP("AGENTS.md"), big);
		pushA();
		const mod = pathToFileURL(resolve("src/core/hubpull.ts")).href;
		const script = `import { pullHubs } from ${JSON.stringify(mod)};\npullHubs({ piHome: ${JSON.stringify(b.home)} }, [], { env: ${JSON.stringify(envB)}, hooks: { beforeRename: (_p, rel) => { if (rel === "AGENTS.md") process.kill(process.pid, "SIGKILL"); } } });\n`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n", "the old file is whole");
		assert.equal(head(hubMirror(b.l, "default")), first, "main did not move");
		rmSync(join(hubsDir(b.l), LOCK_FILE), { force: true });
		rmSync(bP(LOCK_FILE), { force: true });
		pullB();
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), big);
		assert.deepEqual(readdirSync(bP()).filter((n) => n.endsWith(".tmp")), [], "the staged copy the killed pull left is cleared");
	});

	it("classes a hub file under the hub's own sync rules, so the next push from either host keeps it", () => {
		pushA();
		initB();
		pullB();
		// Host A widens sync.include and pushes a file only that rule makes config.
		const pj = JSON.parse(readFileSync(aP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(aP("profile.json"), `${JSON.stringify({ ...pj, sync: { include: ["extra"] } }, null, "\t")}\n`);
		mkdirSync(aP("extra"), { recursive: true });
		writeFileSync(aP("extra", "notes.txt"), "notes from A\n");
		pushA();
		const r = pullB();
		assert.deepEqual(r.skipped, []);
		assert.equal(readFileSync(bP("extra", "notes.txt"), "utf8"), "notes from A\n");
		// Host B edits the profile and pushes it; host A pulls.
		writeFileSync(bP("AGENTS.md"), "# Agents\n\nFrom B.\n");
		const pushed = pushHubs(b.l, ["p"], { env: envB }).hubs[0];
		assert.equal(pushed?.failed, undefined, JSON.stringify(pushed));
		assert.ok(run([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main"]).includes("profiles/p/extra/notes.txt"), "the file is still in the hub");
		const back = pullHubs(a.l, [], { env: envA });
		assert.deepEqual(back.conflicts, []);
		assert.equal(readFileSync(aP("AGENTS.md"), "utf8"), "# Agents\n\nFrom B.\n");
		assert.equal(readFileSync(aP("extra", "notes.txt"), "utf8"), "notes from A\n", "the file is still on the host that made it");
	});

	it("keeps the mirror's main when a hub file is not config here, so a push from this host cannot drop it", () => {
		pushA();
		initB();
		pullB();
		const before = head(hubMirror(b.l, "default"));
		// Host B excludes extra/; host A includes it and pushes a file there.
		const pjB = JSON.parse(readFileSync(bP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pjB, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
		const pjA = JSON.parse(readFileSync(aP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(aP("profile.json"), `${JSON.stringify({ ...pjA, sync: { include: ["extra"] } }, null, "\t")}\n`);
		mkdirSync(aP("extra"), { recursive: true });
		writeFileSync(aP("extra", "notes.txt"), "notes from A\n");
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nFrom A.\n");
		pushA();
		const r = pullB([], { resolve: "keep-local" });
		assert.ok(r.skipped.some((s) => s.profile === "p" && s.path === "extra/notes.txt"), JSON.stringify(r.skipped));
		assert.equal(existsSync(bP("extra", "notes.txt")), false);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom A.\n", "the rest of the profile is pulled");
		assert.deepEqual(r.hubs[0]?.pending, ["p"]);
		assert.equal(head(hubMirror(b.l, "default")), before, "main does not move past a hub file this host left out");
		const refused = pushHubs(b.l, ["p"], { env: envB }).hubs[0]?.failed;
		assert.equal(refused?.refused, true);
		assert.match(refused?.message ?? "", /extra\/notes\.txt[\s\S]*pi-profile sync pull --theirs p[\s\S]*sync\.include/);
		assert.ok(run([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main"]).includes("profiles/p/extra/notes.txt"), "the file is still in the hub");
	});

	it("renders sessionDir again when the hub changes sessions.store but not settings.json; a local edit then conflicts", () => {
		updateConfig(a.l, (c) => ({ ...c, sessionStores: { big: { path: "/srv/a-sessions" } } }), envA);
		updateConfig(b.l, (c) => ({ ...c, sessionStores: { big: { path: "/srv/b-sessions" } } }), envB);
		pushA();
		initB();
		pullB();
		const sessionDirB = (): string | undefined => (JSON.parse(readFileSync(bP("settings.json"), "utf8")) as { sessionDir?: string }).sessionDir;
		assert.equal(sessionDirB(), undefined);
		const blob = (): string => run([`--git-dir=${remote}`, "rev-parse", "main:profiles/p/settings.json"]).trim();
		const settingsBlob = blob();
		const pj = JSON.parse(readFileSync(aP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(aP("profile.json"), `${JSON.stringify({ ...pj, sessions: { store: "big" } }, null, "\t")}\n`);
		pushA();
		assert.equal(blob(), settingsBlob, "the hub's settings.json did not change");
		const r = pullB();
		assert.equal(sessionDirB(), "/srv/b-sessions", "sessionDir from this host's machine config");
		assert.deepEqual(r.profiles.find((p) => p.profile === "p")?.files, [
			{ path: "profile.json", action: "write" },
			{ path: "settings.json", action: "write" },
		]);
		// Host A moves the profile back to the default store; host B edited settings.json meanwhile.
		writeFileSync(aP("profile.json"), `${JSON.stringify(pj, null, "\t")}\n`);
		pushA();
		const edited = `${JSON.stringify({ theme: "light", sessionDir: "/srv/b-sessions" }, null, "\t")}\n`;
		writeFileSync(bP("settings.json"), edited);
		refusal(() => pullB(), /\n {2}p\/settings\.json\n/);
		assert.equal(readFileSync(bP("settings.json"), "utf8"), edited);
		pullB([], { resolve: "keep-local" });
		assert.equal(readFileSync(bP("settings.json"), "utf8"), edited, "--keep-local keeps the local edit");
	});
});

describe("sync pull and packages (issue 32)", () => {
	it("reports missing packages; installs only with --install-packages, never a local path, and reports a failure", () => {
		const dir = profileOnA();
		const sources = ["npm:@x/present", "npm:missing@1.0.0", "git:github.com/u/repo@v1", "./local-missing", "npm:fails", "https://github.com/u/web"];
		writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: [...sources.slice(0, 4), { source: "npm:fails" }, sources[5]] }, null, "\t")}\n`);
		pushA();
		initB();
		const calls: Array<{ args: readonly string[]; dir: string | undefined }> = [];
		const runner: PackageRunner = (args, env) => {
			calls.push({ args, dir: env.PI_CODING_AGENT_DIR });
			return args[1] === "npm:fails" ? { status: 1, stderr: "npm error 404\n" } : { status: 0, stderr: "" };
		};
		const first = pullB([], { runner });
		assert.equal(calls.length, 0, "without the flag nothing is installed");
		assert.deepEqual(first.packages.map((p) => [p.source, p.outcome]), sources.map((s) => [s, "missing"]));
		mkdirSync(bP("npm", "node_modules", "@x", "present"), { recursive: true });
		const second = pullB([], { runner, installPackages: true });
		assert.deepEqual(calls.map((c) => c.args), [["install", "npm:missing@1.0.0"], ["install", "git:github.com/u/repo@v1"], ["install", "npm:fails"]]);
		assert.ok(calls.every((c) => c.dir === bP()), JSON.stringify(calls));
		assert.deepEqual(second.packages.map((p) => [p.source, p.outcome]), [
			["npm:missing@1.0.0", "installed"],
			["git:github.com/u/repo@v1", "installed"],
			["./local-missing", "missing"],
			["npm:fails", "failed"],
			["https://github.com/u/web", "missing"],
		]);
		assert.match(second.packages.find((p) => p.source === "./local-missing")?.reason ?? "", /local path/);
		assert.match(second.packages.find((p) => p.source === "npm:fails")?.reason ?? "", /404/);
		const cap = captureIo(envB);
		assert.equal(main(["sync", "pull", "--install-packages"], { ...cap, packages: runner }), 1);
		assert.match(cap.stdout, /p: npm:fails: install failed: npm error 404/);
		assert.match(cap.stdout, /p: \.\/local-missing \(a local path/);
	});

	it("prints each pi install command before it runs it, and nothing on --dry-run (law L25, issue 58)", () => {
		const dir = profileOnA();
		writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: ["npm:missing@1.0.0", "git:github.com/u/repo@v1"] }, null, "\t")}\n`);
		pushA();
		initB();
		const dry = captureIo(envB);
		const never: PackageRunner = () => assert.fail("a dry run installs nothing");
		assert.equal(main(["sync", "pull", "--dry-run", "--install-packages"], { ...dry, packages: never }), 0, dry.stderr);
		assert.doesNotMatch(dry.stdout, /running:/, "a dry run never says it ran an install");
		const cap = captureIo(envB);
		const printedFirst: boolean[] = [];
		const runner: PackageRunner = (args, env) => {
			// The printed line is the exact command: each variable the install sets on top of this process's
			// environment, then pi and its argv, each word as the shell reads it back.
			const set = Object.entries(env).filter(([k, v]) => envB[k as keyof typeof envB] !== v);
			const line = /running: (.*)\n$/.exec(cap.stdout)?.[1] ?? "";
			const words = spawnSync("sh", ["-c", `for w in ${line}; do printf '%s\\n' "$w"; done`], { encoding: "utf8" }).stdout.split("\n").slice(0, -1);
			const argvAt = words.indexOf("pi");
			printedFirst.push(
				argvAt >= 0 &&
					JSON.stringify(words.slice(0, argvAt).sort()) === JSON.stringify(set.map(([k, v]) => `${k}=${v}`).sort()) &&
					JSON.stringify(words.slice(argvAt + 1)) === JSON.stringify(args),
			);
			return { status: 0, stderr: "" };
		};
		assert.equal(main(["sync", "pull", "--install-packages"], { ...cap, out: cap.out, packages: runner }), 0, cap.stderr);
		assert.deepEqual(printedFirst, [true, true], cap.stdout);
		assert.ok(cap.stdout.includes(`running: PI_CODING_AGENT_DIR=${bP()} PI_PROFILE_LABEL=p pi install npm:missing@1.0.0\n`), cap.stdout);
		assert.match(cap.stdout, /^package p: npm:missing@1\.0\.0: installed$/m);
	});

	it("takes packages from settings.json as it is here after the pull, so a package removed here is never installed again", () => {
		const dir = profileOnA();
		const hubSettings = (theme: string): string => `${JSON.stringify({ theme, packages: ["npm:gone@1.0.0"] }, null, "\t")}\n`;
		writeFileSync(join(dir, "settings.json"), hubSettings("dark"));
		pushA();
		initB();
		const calls: Array<readonly string[]> = [];
		const runner: PackageRunner = (args) => {
			calls.push(args);
			return { status: 0, stderr: "" };
		};
		assert.deepEqual(pullB([], { runner }).packages.map((p) => [p.source, p.outcome]), [["npm:gone@1.0.0", "missing"]]);
		// Removed on this host; the hub did not change settings.json, so the file is kept.
		const mine = `${JSON.stringify({ theme: "dark" }, null, "\t")}\n`;
		writeFileSync(bP("settings.json"), mine);
		const kept = pullB([], { runner, installPackages: true });
		assert.deepEqual(kept.packages, []);
		assert.deepEqual(calls, []);
		// The hub changes settings.json too: --keep-local keeps the removal.
		writeFileSync(join(dir, "settings.json"), hubSettings("light"));
		pushA();
		const r = pullB([], { runner, installPackages: true, resolve: "keep-local" });
		assert.deepEqual(r.resolved.map((c) => [c.path, c.side]), [["settings.json", "keep-local"]]);
		assert.deepEqual(r.packages, [], "not reported missing");
		assert.deepEqual(calls, [], "the runner never runs for it");
		assert.equal(readFileSync(bP("settings.json"), "utf8"), mine);
	});
});

describe("sync push after sync pull (issue 32)", () => {
	it("refuses a push when the hub moved; after sync pull the push fast-forwards and keeps the other host's profile", () => {
		pushA();
		initB();
		createProfile(b.l, "q");
		const theirs = pushHubs(b.l, ["q"], { env: envB }).hubs[0]?.commit;
		assert.ok(theirs !== undefined);
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nEdited on A.\n");
		const refused = pushHubs(a.l, ["p"], { env: envA }).hubs[0]?.failed;
		assert.match(refused?.message ?? "", /run pi-profile sync pull first/);
		const r = pullHubs(a.l, [], { env: envA });
		assert.deepEqual(r.conflicts, []);
		assert.ok(existsSync(join(a.home, "profiles", "q", "profile.json")), "the other host's profile is pulled");
		assert.equal(readFileSync(aP("AGENTS.md"), "utf8"), "# Agents\n\nEdited on A.\n", "a local edit the hub did not change is kept");
		assert.equal(head(hubMirror(a.l, "default")), theirs);
		const again = pushHubs(a.l, ["p"], { env: envA }).hubs[0];
		assert.equal(again?.failed, undefined, JSON.stringify(again));
		assert.equal(head(remote), again?.commit);
		assert.equal(run([`--git-dir=${remote}`, "rev-parse", `${again?.commit ?? ""}^`]).trim(), theirs, "a fast-forward on the other host's commit");
		assert.equal(run([`--git-dir=${remote}`, "rev-list", "--merges", "--count", "main"]).trim(), "0");
		assert.ok(run([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main"]).includes("profiles/q/profile.json"));
		// Pulling on B now: A's edit arrives and nothing conflicts, since B pushed q and never edited p.
		const back = pullB();
		assert.deepEqual(back.conflicts, []);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nEdited on A.\n");
	});
});
