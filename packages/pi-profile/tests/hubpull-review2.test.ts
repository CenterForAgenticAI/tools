import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { hubMirror, initHub, pushHubs } from "../src/core/hub.ts";
import { pullHubs, type PullReport } from "../src/core/hubpull.ts";
import { createProfile } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Round-2 review fixes on MR 31 (issue 32). Host A pushes, host B pulls; the hub is a local bare repository. */

let a: Sandbox;
let b: Sandbox;
let remote: string;
let envA: Record<string, string | undefined>;
let envB: Record<string, string | undefined>;

function run(args: readonly string[]): string {
	const r = spawnSync("git", [...args], {
		encoding: "utf8",
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

describe("round-2 review fixes (MR 31)", () => {
	const hubFiles = (): string[] => run([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "main"]).split("\n").filter((x) => x !== "");
	/** Host A widens sync.include and pushes extra/notes.txt. */
	const extraOnA = (): void => {
		const pj = JSON.parse(readFileSync(aP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(aP("profile.json"), `${JSON.stringify({ ...pj, sync: { include: ["extra"] } }, null, "\t")}\n`);
		mkdirSync(aP("extra"), { recursive: true });
		writeFileSync(aP("extra", "notes.txt"), "notes from A\n");
		pushA();
	};

	it("CR-PULL-HELD-PUSH-AFTER-INIT: refuses a push of a held profile after sync init, so the file stays in the hub and on the host that made it", () => {
		pushA();
		extraOnA();
		// Host B already has its own p, runs sync init (main moves to the hub head), and keeps its own files.
		createProfile(b.l, "p");
		initB();
		assert.equal(head(hubMirror(b.l, "default")), head(remote), "sync init sets main to the hub head");
		const r = pullB([], { resolve: "keep-local" });
		assert.ok(r.skipped.some((s) => s.profile === "p" && s.path === "extra/notes.txt"), JSON.stringify(r.skipped));
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		assert.match(io.stderr, /extra\/notes\.txt/);
		assert.match(io.stderr, /pi-profile sync pull --theirs p/);
		assert.match(io.stderr, /sync\.include/);
		assert.ok(hubFiles().includes("profiles/p/extra/notes.txt"), "the file is still in the hub");
		pullHubs(a.l, [], { env: envA, resolve: "keep-local" });
		assert.equal(readFileSync(aP("extra", "notes.txt"), "utf8"), "notes from A\n", "the file is still on the host that made it");
	});

	it("CR-PULL-HELD-PUSH-AFTER-INIT: refuses a push that would drop a hub file this host never pulled or pushed, and names it", () => {
		pushA();
		createProfile(b.l, "p");
		initB();
		// No pull: host B has never seen A's files, and main is at the hub head.
		const refused = pushHubs(b.l, ["p"], { env: envB }).hubs[0]?.failed;
		assert.equal(refused?.refused, true, JSON.stringify(refused));
		assert.match(refused?.message ?? "", /skills\/s\/SKILL\.md/);
		assert.match(refused?.message ?? "", /sync pull p/);
		assert.ok(hubFiles().includes("profiles/p/skills/s/SKILL.md"), "the file is still in the hub");
		// Once B has pulled the file, a push that removes it is B's own choice and goes through.
		pullB([], { resolve: "keep-local" });
		rmSync(bP("skills", "s", "SKILL.md"));
		const pushed = pushHubs(b.l, ["p"], { env: envB }).hubs[0];
		assert.equal(pushed?.failed, undefined, JSON.stringify(pushed));
		assert.equal(hubFiles().includes("profiles/p/skills/s/SKILL.md"), false);
	});

	it("CR-PULL-RERENDER-DROPS-SESSIONDIR: a push then a pull with no change on either side leaves a hand-set sessionDir alone", () => {
		const dir = profileOnA();
		const mine = `${JSON.stringify({ sessionDir: "/srv/mine", theme: "dark" }, null, "\t")}\n`;
		writeFileSync(join(dir, "settings.json"), mine);
		pushA();
		const r = pullHubs(a.l, [], { env: envA });
		assert.deepEqual(r.profiles.find((p) => p.profile === "p")?.files, [], "nothing is written");
		assert.equal(readFileSync(aP("settings.json"), "utf8"), mine);
	});

	it("CR-PUSH-HELD-NO-WAY-OUT: names the way out of a hold; --theirs after --keep-local clears it and the next push keeps the file", () => {
		pushA();
		initB();
		pullB();
		const pjB = JSON.parse(readFileSync(bP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pjB, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
		extraOnA();
		pullB([], { resolve: "keep-local" });
		// A plain pull leaves the profile held, and says how to get out.
		const again = captureIo(envB);
		assert.equal(main(["sync", "pull", "p"], again), 0, again.stderr);
		assert.match(again.stdout, /extra\/notes\.txt/);
		assert.match(again.stdout, /pi-profile sync pull --theirs p \(it also takes the hub's copy of each other file changed only here in p: run it with --dry-run first to see each file it overwrites\)/);
		assert.match(again.stdout, /sync\.include/);
		const push = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], push), 2);
		assert.match(push.stderr, /pi-profile sync pull --theirs p/);
		assert.match(push.stderr, /sync\.include/);
		assert.match(push.stderr, /extra\/notes\.txt/);
		// --theirs takes the hub's profile.json although only this host changed it since the last pull.
		const theirs = captureIo(envB);
		assert.equal(main(["sync", "pull", "--theirs", "p"], theirs), 0, theirs.stderr);
		assert.match(theirs.stdout, /p\/profile\.json: .*took the hub's copy/);
		assert.equal(readFileSync(bP("extra", "notes.txt"), "utf8"), "notes from A\n");
		assert.doesNotMatch(theirs.stdout, /not pulled in full/);
		const pushed = pushHubs(b.l, ["p"], { env: envB }).hubs[0];
		assert.equal(pushed?.failed, undefined, JSON.stringify(pushed));
		assert.ok(hubFiles().includes("profiles/p/extra/notes.txt"), "the file is still in the hub");
	});

	it("CR-PUSH-HELD-NO-WAY-OUT: --theirs takes the hub's copy of a file changed only here, and lists it", () => {
		pushA();
		initB();
		pullB();
		writeFileSync(bP("AGENTS.md"), "# Agents\n\nOnly B.\n");
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nOnly B.\n");
		const r = pullB(["p"], { resolve: "theirs" });
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
		assert.deepEqual(r.resolved.map((c) => [c.profile, c.path, c.side]), [["p", "AGENTS.md", "theirs"]]);
		assert.deepEqual(r.profiles.find((p) => p.profile === "p")?.files, [{ path: "AGENTS.md", action: "write" }]);
	});

	it("CR-PULL-DRYRUN-PACKAGES-DIFFER: a dry run reports no packages for a settings.json the pull would remove", () => {
		const dir = profileOnA();
		writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ packages: ["npm:gone@1.0.0"] }, null, "\t")}\n`);
		pushA();
		initB();
		assert.deepEqual(pullB().packages.map((p) => p.source), ["npm:gone@1.0.0"]);
		rmSync(join(dir, "settings.json"));
		pushA();
		const dry = pullB([], { dryRun: true });
		assert.deepEqual(dry.profiles.find((p) => p.profile === "p")?.files, [{ path: "settings.json", action: "remove" }]);
		const real = pullB();
		assert.equal(existsSync(bP("settings.json")), false);
		assert.deepEqual(real.packages, []);
		assert.deepEqual(dry.packages, real.packages, "the dry run reports what the real run does");
	});
});
