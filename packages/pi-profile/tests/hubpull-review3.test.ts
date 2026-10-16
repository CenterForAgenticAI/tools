import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { hubMirror, initHub, pushHubs } from "../src/core/hub.ts";
import { pullHubs, type PullReport } from "../src/core/hubpull.ts";
import { syncStatePath } from "../src/core/hubstate.ts";
import { createProfile } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/**
 * Review follow-ups to MR 31: issues 48 to 52.
 * Host A pushes, host B pulls; each hub is a local bare repository.
 */

let a: Sandbox;
let b: Sandbox;
let remote: string;
let envA: Record<string, string | undefined>;
let envB: Record<string, string | undefined>;

const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" };

function run(args: readonly string[], cwd?: string): string {
	const r = spawnSync("git", [...args], { encoding: "utf8", env: GIT_ENV, ...(cwd === undefined ? {} : { cwd }) });
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
	writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ theme: "dark" }, null, "\t")}\n`);
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

/** A hub commit made by hand, as a broken or hostile hub might: `change` edits a checkout of the hub. */
function commitToHub(repo: string, change: (work: string) => void): void {
	const work = mkdtempSync(join(a.home, "hub-work-"));
	try {
		run(["clone", "--quiet", repo, work]);
		change(work);
		run(["add", "-A"], work);
		run(["commit", "--quiet", "-m", "by hand"], work);
		run(["push", "--quiet", "origin", "HEAD:main"], work);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const hubFiles = (repo = remote): string[] => run([`--git-dir=${repo}`, "ls-tree", "-r", "--name-only", "main"]).split("\n").filter((x) => x !== "");
const bP = (...rel: string[]): string => join(b.home, "profiles", "p", ...rel);
const bQ = (...rel: string[]): string => join(b.home, "profiles", "q", ...rel);
const aP = (...rel: string[]): string => join(a.home, "profiles", "p", ...rel);

/** Run one printed step: a pi-profile command through main, anything else through sh. */
function runStep(step: string, env: Record<string, string | undefined>): { code: number; out: string } {
	if (step.startsWith("pi-profile ")) {
		const io = captureIo(env);
		const code = main(step.slice("pi-profile ".length).split(" "), io);
		return { code, out: io.stdout + io.stderr };
	}
	const r = spawnSync("sh", ["-c", step], { encoding: "utf8", env: { PATH: process.env.PATH } });
	return { code: r.status ?? 1, out: r.stdout + r.stderr };
}

/**
 * Follow the way out a #48 refusal prints, exactly as printed: each
 * `pi-profile sync` command in `reason`, in order, through main, on host B.
 */
function followWayOut(reason: string): void {
	const steps = [...reason.matchAll(/pi-profile sync (?:pull|push)(?: --[a-z-]+)* [a-z0-9_-]+/g)].map((m) => m[0]);
	assert.deepEqual(steps, ["pi-profile sync pull --keep-local p", "pi-profile sync push p"], reason);
	for (const step of steps) {
		const r = runStep(step, envB);
		assert.equal(r.code, 0, `${step}: ${r.out}`);
	}
}

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

describe("issue 48: a hub profile without profile.json", () => {
	it("leaves the local profile intact and refuses only that profile; the named way out restores profile.json in the hub", () => {
		pushA(["p", "q"]);
		initB();
		pullB();
		const pj = readFileSync(bP("profile.json"), "utf8");
		const settings = readFileSync(bP("settings.json"), "utf8");
		// A broken hub drops p's profile.json and settings.json; q changes as usual.
		commitToHub(remote, (work) => {
			rmSync(join(work, "profiles", "p", "profile.json"));
			rmSync(join(work, "profiles", "p", "settings.json"));
			writeFileSync(join(work, "profiles", "q", "AGENTS.md"), "# Agents\n\nFrom the hub.\n");
		});
		const r = pullB();
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj, "profile.json is kept");
		assert.equal(readFileSync(bP("settings.json"), "utf8"), settings, "settings.json is kept");
		const skip = r.skippedProfiles.find((s) => s.profile === "p");
		assert.match(skip?.reason ?? "", /profile\.json/, JSON.stringify(r.skippedProfiles));
		assert.match(skip?.reason ?? "", /pi-profile sync pull --keep-local p/);
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nFrom the hub.\n", "the other profiles are pulled");
		assert.deepEqual(r.hubs[0]?.pending, ["p"]);
		// Named, the pull refuses and writes nothing.
		const named = captureIo(envB);
		assert.equal(main(["sync", "pull", "p"], named), 2, named.stdout + named.stderr);
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj);
		// --theirs never removes profile.json either.
		assert.equal(main(["sync", "pull", "--theirs", "p"], captureIo(envB)), 2);
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj);
		// q changes in the hub again, so q is still to be pulled while the way out runs.
		commitToHub(remote, (work) => writeFileSync(join(work, "profiles", "q", "AGENTS.md"), "# Agents\n\nFrom the hub again.\n"));
		// The way out, exactly as printed and nothing else.
		followWayOut(skip?.reason ?? "");
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj);
		assert.equal(readFileSync(bP("settings.json"), "utf8"), settings);
		assert.ok(hubFiles().includes("profiles/p/profile.json") && hubFiles().includes("profiles/p/settings.json"), hubFiles().join());
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/p/profile.json"]), pj, "the hub holds this host's profile.json");
		// q's second change is still in the hub and still to be pulled here; the push did not touch it.
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/q/AGENTS.md"]), "# Agents\n\nFrom the hub again.\n");
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nFrom the hub.\n");
		// The next full pull refuses nothing, takes q's change, and moves main to the hub head.
		const after = pullB();
		assert.deepEqual(after.skippedProfiles, []);
		assert.deepEqual(after.conflicts, []);
		assert.equal(after.hubs[0]?.pending, undefined);
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nFrom the hub again.\n");
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj);
		assert.equal(head(hubMirror(b.l, "default")), head(remote));
	});

	it("the printed way out also works when the hub holds no other profile", () => {
		pushA(["p"]);
		initB();
		pullB();
		const pj = readFileSync(bP("profile.json"), "utf8");
		commitToHub(remote, (work) => {
			rmSync(join(work, "profiles", "p", "profile.json"));
			rmSync(join(work, "profiles", "p", "settings.json"));
		});
		const r = pullB();
		const skip = r.skippedProfiles.find((s) => s.profile === "p");
		followWayOut(skip?.reason ?? "");
		assert.ok(hubFiles().includes("profiles/p/profile.json") && hubFiles().includes("profiles/p/settings.json"), hubFiles().join());
		const after = pullB();
		assert.deepEqual(after.skippedProfiles, []);
		assert.equal(after.hubs[0]?.pending, undefined);
		assert.equal(readFileSync(bP("profile.json"), "utf8"), pj);
	});
});

describe("issue 49: recording a push", () => {
	it("refuses before anything is sent when last.json is broken, and leaves the hub as it was", () => {
		const before = pushA();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nChanged.\n");
		writeFileSync(syncStatePath(a.l), "{ not json");
		const io = captureIo(envA);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		assert.match(io.stderr, /last\.json/);
		assert.match(io.stderr, /nothing was pushed/i);
		assert.equal(head(remote), before, "the hub did not move");
	});

	it("reports a push that landed as pushed when last.json breaks during the push", () => {
		const before = pushA();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nChanged.\n");
		const r = pushHubs(a.l, ["p"], { env: envA, hooks: { beforeGate: () => writeFileSync(syncStatePath(a.l), "{ not json") } });
		const h = r.hubs[0];
		assert.equal(h?.failed, undefined, JSON.stringify(h));
		assert.notEqual(head(remote), before);
		assert.equal(h?.commit, head(remote));
		assert.match(h?.warning ?? "", /pushed .*could not be recorded in .*last\.json[\s\S]*no need to push again/);
	});

	it("says the push landed, warns and exits 1 when the record cannot be written", { skip: process.getuid?.() === 0 && "root ignores directory permissions" }, () => {
		const before = pushA();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nChanged.\n");
		const stateDir = join(syncStatePath(a.l), "..");
		chmodSync(stateDir, 0o500);
		try {
			const io = captureIo(envA);
			assert.equal(main(["sync", "push", "p"], io), 1, io.stdout + io.stderr);
			const now = head(remote) as string;
			assert.notEqual(now, before, "the push landed");
			assert.match(io.stdout, new RegExp(`hub default: pushed ${now.slice(0, 12)}`));
			assert.match(io.stderr, /warning: .*pushed.*could not be recorded/);
			assert.doesNotMatch(io.stderr, /refused|nothing was pushed/i);
		} finally {
			chmodSync(stateDir, 0o700);
		}
	});
});

describe("issue 50: the --theirs hint", () => {
	/** p conflicts (changed here and in the hub); q has an unpushed edit here only. */
	function conflictInPEditInQ(): void {
		pushA(["p", "q"]);
		initB();
		pullB();
		writeFileSync(aP("AGENTS.md"), "# Agents\n\nFrom A.\n");
		pushA(["p", "q"]);
		writeFileSync(bP("AGENTS.md"), "# Agents\n\nFrom B.\n");
		writeFileSync(bQ("AGENTS.md"), "# Agents\n\nUnpushed on B.\n");
	}

	it("names only the conflicting profile and suggests --dry-run; following it keeps q's edit", () => {
		conflictInPEditInQ();
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull"], io), 2, io.stdout + io.stderr);
		assert.match(io.stderr, /pi-profile sync pull --theirs p\b/);
		assert.match(io.stderr, /pi-profile sync pull --keep-local p\b/);
		assert.match(io.stderr, /--dry-run/);
		assert.doesNotMatch(io.stderr, /--theirs( p)? q|--theirs\s*[,.]/);
		const hint = /(pi-profile sync pull --theirs [^ ,;\n]+)/.exec(io.stderr)?.[1] as string;
		// The dry run of the hint lists what it would overwrite.
		const dry = runStep(`${hint} --dry-run`, envB);
		assert.equal(dry.code, 0, dry.out);
		assert.match(dry.out, /p\/AGENTS\.md/);
		assert.doesNotMatch(dry.out, /q\/AGENTS\.md/);
		const done = runStep(hint, envB);
		assert.equal(done.code, 0, done.out);
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom A.\n");
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nUnpushed on B.\n", "q's edit is kept");
	});

	it("names the conflicting profiles in the dry-run line", () => {
		conflictInPEditInQ();
		const io = captureIo(envB);
		assert.equal(main(["sync", "pull", "--dry-run"], io), 0, io.stdout + io.stderr);
		assert.match(io.stdout, /p\/AGENTS\.md: changed here and in the hub; .*pi-profile sync pull --theirs p\b.*--keep-local p\b/);
		assert.match(io.stdout, /--dry-run/);
	});

	it("--theirs with no name takes the hub's copy of a file changed only here only in a profile with a conflict", () => {
		conflictInPEditInQ();
		writeFileSync(bP("skills", "s", "SKILL.md"), "---\nname: s\n---\nOnly B.\n");
		const r = pullB([], { resolve: "theirs" });
		assert.equal(readFileSync(bP("AGENTS.md"), "utf8"), "# Agents\n\nFrom A.\n");
		assert.equal(readFileSync(bP("skills", "s", "SKILL.md"), "utf8"), "---\nname: s\n---\nA skill.\n", "p has a conflict, so --theirs takes the hub's copy of p's other files");
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nUnpushed on B.\n", "q has no conflict or hold: its edit is kept");
		assert.ok(!r.resolved.some((c) => c.profile === "q"), JSON.stringify(r.resolved));
		// Named, --theirs takes the hub's copy in every named profile.
		pullB(["q"], { resolve: "theirs" });
		assert.equal(readFileSync(bQ("AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
	});
});

describe("issue 51: an alias push refused for unseen hub files", () => {
	it("prints steps that work; following them ends in a pushed alias and no hub file lost", () => {
		pushA(["p"]);
		const hubBlobs = hubFiles().filter((f) => f.startsWith("profiles/p/"));
		// Host B has q, and p as a link to q.
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		initB();
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		assert.match(io.stderr, /link/);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.ok(steps.length >= 3, io.stderr);
		assert.match(steps.at(-1) as string, /^pi-profile sync push p$/);
		for (const step of steps) {
			const r = runStep(step, envB);
			assert.equal(r.code, 0, `${step}: ${r.out}`);
		}
		assert.ok(lstatSync(join(b.home, "profiles", "p")).isSymbolicLink(), "p is a link again");
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		// Every file the hub held for p is on host B, in the trash the steps moved it to.
		const trash = join(b.home, "profiles", ".trash");
		const kept = readdirSync(trash).filter((n) => n.startsWith("p-"));
		assert.equal(kept.length, 1, readdirSync(trash).join());
		for (const f of hubBlobs) assert.ok(existsSync(join(trash, kept[0] as string, f.slice("profiles/p/".length))), f);
		assert.equal(readFileSync(join(trash, kept[0] as string, "AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
	});

	it("CR-51-STEPS-STALE-MAIN: the printed steps work when another profile of the hub moved since this host's last full pull", () => {
		pushA(["p", "r"]);
		// Host B has q, and p as a link to q; sync init sets main to the hub head.
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		initB();
		// Then host A changes r: main on host B is behind the hub.
		const aR = join(a.home, "profiles", "r", "AGENTS.md");
		writeFileSync(aR, "# Agents\n\nr from A, later.\n");
		pushA(["p", "r"]);
		const before = hubFiles();
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.ok(steps.length >= 3, io.stderr);
		assert.match(steps.at(-1) as string, /^pi-profile sync push p$/);
		for (const step of steps) {
			const r = runStep(step, envB);
			assert.equal(r.code, 0, `${step}: ${r.out}`);
		}
		assert.ok(lstatSync(join(b.home, "profiles", "p")).isSymbolicLink(), "p is a link again");
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		// Every hub file but p's is still in the hub, r at A's later copy; p's files are on host B, in the trash.
		assert.deepEqual(hubFiles(), before.filter((f) => !f.startsWith("profiles/p/")));
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/r/AGENTS.md"]), "# Agents\n\nr from A, later.\n");
		assert.equal(readFileSync(join(b.home, "profiles", "r", "AGENTS.md"), "utf8"), "# Agents\n\nr from A, later.\n", "r's change is pulled here");
		const trash = join(b.home, "profiles", ".trash");
		const kept = readdirSync(trash).filter((n) => n.startsWith("p-"));
		assert.equal(kept.length, 1, readdirSync(trash).join());
		for (const f of before.filter((x) => x.startsWith("profiles/p/"))) assert.ok(existsSync(join(trash, kept[0] as string, f.slice("profiles/p/".length))), f);
		// The next full pull refuses nothing and leaves nothing out.
		const next = captureIo(envB);
		assert.equal(main(["sync", "pull"], next), 0, next.stdout + next.stderr);
		assert.doesNotMatch(next.stdout + next.stderr, /skipped profile|not pulled in full/);
	});

	it("CR-51-STEPS-STALE-MAIN: the printed steps work when another profile of the hub is held here and moved since", () => {
		pushA(["p", "r"]);
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		initB();
		pullB(["r"]);
		// Host B excludes r's extra/; host A includes it and pushes a file there: r is held here, so a full pull leaves main.
		const rB = join(b.home, "profiles", "r");
		const pjB = JSON.parse(readFileSync(join(rB, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(rB, "profile.json"), `${JSON.stringify({ ...pjB, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
		const rA = join(a.home, "profiles", "r");
		const pjA = JSON.parse(readFileSync(join(rA, "profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(rA, "profile.json"), `${JSON.stringify({ ...pjA, sync: { include: ["extra"] } }, null, "\t")}\n`);
		mkdirSync(join(rA, "extra"), { recursive: true });
		writeFileSync(join(rA, "extra", "notes.txt"), "notes from A\n");
		pushA(["p", "r"]);
		pullB(["r"], { resolve: "keep-local" });
		// Then host A changes r again.
		writeFileSync(join(rA, "AGENTS.md"), "# Agents\n\nr from A, later.\n");
		pushA(["p", "r"]);
		const before = hubFiles();
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.match(steps.at(-1) as string, /^pi-profile sync push p$/);
		for (const step of steps) {
			const r = runStep(step, envB);
			assert.equal(r.code, 0, `${step}: ${r.out}`);
		}
		assert.ok(lstatSync(join(b.home, "profiles", "p")).isSymbolicLink(), "p is a link again");
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		// r stays as the hub holds it, the file host B never pulled too.
		assert.deepEqual(hubFiles(), before.filter((f) => !f.startsWith("profiles/p/")));
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/r/extra/notes.txt"]), "notes from A\n");
		assert.equal(readFileSync(join(rB, "AGENTS.md"), "utf8"), "# Agents\n\nr from A, later.\n", "r's change is pulled here");
		const trash = join(b.home, "profiles", ".trash");
		assert.equal(readdirSync(trash).filter((n) => n.startsWith("p-")).length, 1, "the pulled copy is in the trash");
		// r is still held: a push of r is refused, and names its own way out.
		const held = captureIo(envB);
		assert.equal(main(["sync", "push", "r"], held), 2, held.stdout + held.stderr);
		assert.match(held.stderr, /extra\/notes\.txt/);
		assert.match(held.stderr, /pi-profile sync pull --theirs r/);
	});

	it("CR-51-STEPS-STALE-MAIN: when another profile conflicts, step 2 refuses with its own way out, and the steps then work", () => {
		pushA(["p", "r"]);
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		initB();
		pullB(["r"]);
		// r changes on both hosts: a conflict.
		writeFileSync(join(a.home, "profiles", "r", "AGENTS.md"), "# Agents\n\nr from A, later.\n");
		pushA(["p", "r"]);
		const rB = join(b.home, "profiles", "r", "AGENTS.md");
		writeFileSync(rB, "# Agents\n\nr from B.\n");
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.equal(steps[1], "pi-profile sync pull", io.stderr);
		assert.equal(runStep(steps[0] as string, envB).code, 0);
		const pulled = runStep(steps[1] as string, envB);
		assert.equal(pulled.code, 2, pulled.out);
		assert.match(pulled.out, /pi-profile sync pull --keep-local r\b/);
		assert.ok(!existsSync(bP("AGENTS.md")), "nothing was written");
		// Its way out, then step 2 again and the rest.
		assert.equal(runStep("pi-profile sync pull --keep-local r", envB).code, 0);
		for (const step of steps.slice(1)) {
			const x = runStep(step, envB);
			assert.equal(x.code, 0, `${step}: ${x.out}`);
		}
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		assert.equal(readFileSync(rB, "utf8"), "# Agents\n\nr from B.\n", "r's local edit is kept");
		assert.equal(run([`--git-dir=${remote}`, "show", "main:profiles/r/AGENTS.md"]), "# Agents\n\nr from A, later.\n", "r stays in the hub as A pushed it");
	});

	it("CR-51-STEPS-STALE-MAIN: an alias push on the hub head still refuses a file of the profile this host has not pulled", () => {
		pushA(["p", "r"]);
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		initB();
		writeFileSync(join(a.home, "profiles", "r", "AGENTS.md"), "# Agents\n\nr from A, later.\n");
		pushA(["p", "r"]);
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		for (const step of steps.slice(0, -1)) {
			const r = runStep(step, envB);
			assert.equal(r.code, 0, `${step}: ${r.out}`);
		}
		// Before the push, host A adds a file to p and changes r: the hub head holds a file of p this host never pulled.
		mkdirSync(aP("skills", "t"), { recursive: true });
		writeFileSync(aP("skills", "t", "SKILL.md"), "---\nname: t\n---\nFrom A after B pulled.\n");
		writeFileSync(join(a.home, "profiles", "r", "AGENTS.md"), "# Agents\n\nr from A, again.\n");
		pushA(["p", "r"]);
		const tip = head(remote);
		// The push builds on the head this host last fetched, so the hub refuses it: pull first.
		const stale = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], stale), 2, stale.stdout + stale.stderr);
		assert.match(stale.stderr, /run pi-profile sync pull first/);
		assert.equal(runStep("pi-profile sync pull", envB).code, 0);
		const refused = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], refused), 2, refused.stdout + refused.stderr);
		assert.match(refused.stderr, /skills\/t\/SKILL\.md/);
		assert.equal(head(remote), tip, "nothing was pushed");
		assert.ok(hubFiles().includes("profiles/p/skills/t/SKILL.md"));
		// The steps it prints again keep that file on this host, in the trash, and push the alias.
		const again = [...refused.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.match(again.at(-1) as string, /^pi-profile sync push p$/);
		for (const step of again) {
			const x = runStep(step, envB);
			assert.equal(x.code, 0, `${step}: ${x.out}`);
		}
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		const trash = join(b.home, "profiles", ".trash");
		assert.ok(readdirSync(trash).some((n) => n.startsWith("p-") && existsSync(join(trash, n, "skills", "t", "SKILL.md"))), readdirSync(trash).join());
		assert.equal(readFileSync(join(b.home, "profiles", "r", "AGENTS.md"), "utf8"), "# Agents\n\nr from A, again.\n");
	});
});

describe("issue 51: the alias steps when the link is the global default", () => {
	it("clears the default before the delete and sets it again; following them ends in a pushed alias", () => {
		pushA(["p"]);
		createProfile(b.l, "q");
		symlinkSync("q", join(b.home, "profiles", "p"));
		assert.equal(main(["default", "set", "p"], captureIo(envB)), 0);
		initB();
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 2, io.stdout + io.stderr);
		const steps = [...io.stderr.matchAll(/^ {2}\d+\. (.+)$/gm)].map((m) => m[1] as string);
		assert.ok(steps.indexOf("pi-profile default clear") >= 0 && steps.indexOf("pi-profile default clear") < steps.indexOf("pi-profile delete p --yes"), io.stderr);
		assert.ok(steps.indexOf("pi-profile default set p") > steps.findIndex((s) => s.startsWith("ln -s ")), io.stderr);
		for (const step of steps) {
			const r = runStep(step, envB);
			assert.equal(r.code, 0, `${step}: ${r.out}`);
		}
		assert.ok(lstatSync(join(b.home, "profiles", "p")).isSymbolicLink(), "p is a link again");
		assert.deepEqual(JSON.parse(run([`--git-dir=${remote}`, "show", "main:hub.json"])).aliases, { p: "q" });
		const shown = captureIo(envB);
		assert.equal(main(["default", "show"], shown), 0);
		assert.match(shown.stdout, /global default profile: p\n/, "the default is p again");
		const trash = join(b.home, "profiles", ".trash");
		assert.equal(readdirSync(trash).filter((n) => n.startsWith("p-")).length, 1, "the pulled copy is in the trash");
	});
});

describe("issue 52: a hold belongs to one hub", () => {
	it("a hold on hub default does not block a push to hub work, and default stays protected", () => {
		pushA();
		initB();
		pullB();
		// Host B excludes extra/; host A includes it and pushes a file there: p is held on default.
		const pjB = JSON.parse(readFileSync(bP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pjB, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
		const pjA = JSON.parse(readFileSync(aP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(aP("profile.json"), `${JSON.stringify({ ...pjA, sync: { include: ["extra"] } }, null, "\t")}\n`);
		mkdirSync(aP("extra"), { recursive: true });
		writeFileSync(aP("extra", "notes.txt"), "notes from A\n");
		pushA();
		pullB([], { resolve: "keep-local" });
		assert.equal(pushHubs(b.l, ["p"], { env: envB }).hubs[0]?.failed?.refused, true, "p is held on default");
		// p moves to hub work, which is empty.
		const work = join(b.home, "work.git");
		run(["init", "--quiet", "--bare", "--initial-branch=main", work]);
		initHub(b.l, work, { env: envB, hub: "work" });
		const pj = JSON.parse(readFileSync(bP("profile.json"), "utf8")) as Record<string, unknown>;
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pj, sync: { hub: "work", exclude: ["extra"] } }, null, "\t")}\n`);
		const io = captureIo(envB);
		assert.equal(main(["sync", "push", "p"], io), 0, io.stdout + io.stderr);
		assert.ok(hubFiles(work).includes("profiles/p/AGENTS.md"), hubFiles(work).join());
		// Back on default, the push is refused again: the file B never pulled stays in the hub.
		writeFileSync(bP("profile.json"), `${JSON.stringify({ ...pj, sync: { exclude: ["extra"] } }, null, "\t")}\n`);
		assert.equal(pushHubs(b.l, ["p"], { env: envB }).hubs[0]?.failed?.refused, true);
		assert.ok(hubFiles().includes("profiles/p/extra/notes.txt"));
		assert.equal(head(hubMirror(b.l, "work")), head(work));
	});

	it("reads a last.json written before this change, whose holds carry only the profile's hub", () => {
		pushA();
		initB();
		pullB();
		const state = JSON.parse(readFileSync(syncStatePath(b.l), "utf8")) as { profiles: Record<string, Record<string, unknown>> };
		(state.profiles.p as Record<string, unknown>).held = ["extra/notes.txt"];
		writeFileSync(syncStatePath(b.l), JSON.stringify(state));
		const refused = pushHubs(b.l, ["p"], { env: envB }).hubs[0]?.failed;
		assert.equal(refused?.refused, true, "the hold counts for the hub recorded with it");
		assert.match(refused?.message ?? "", /extra\/notes\.txt/);
	});
});
