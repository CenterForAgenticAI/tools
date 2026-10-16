import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { hubRemoteProblem, loadConfig, parseConfig, updateConfig } from "../src/core/config.ts";
import { LOCK_FILE } from "../src/core/lock.ts";
import { gateTree, hubMirror, initHub, pushHubs, type PushHooks, type PushReport } from "../src/core/hub.ts";
import { pullHubs } from "../src/core/hubpull.ts";
import { parseManifest } from "../src/core/manifest.ts";
import { allowEntries, profileSyncRules } from "../src/core/syncmanifest.ts";
import { createProfile } from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Tests for issue 31: `sync init` and `sync push` to a config hub. Every hub is a local bare repository. */

let s: Sandbox;
let remote: string;
let env: Record<string, string | undefined>;
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

function run(args: readonly string[], cwd?: string): string {
	const r = spawnSync("git", [...args], { encoding: "utf8", ...(cwd === undefined ? {} : { cwd }), env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

function bareRepo(): string {
	const dir = join(s.home, `hub-${String(Math.random()).slice(2, 8)}.git`);
	run(["init", "--quiet", "--bare", "--initial-branch=main", dir]);
	return dir;
}

/** The hub's `main`, or undefined when it has none. */
function head(repo: string): string | undefined {
	const r = spawnSync("git", [`--git-dir=${repo}`, "rev-parse", "-q", "--verify", "refs/heads/main"], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}

function files(repo: string, ref = "refs/heads/main"): string[] {
	return run([`--git-dir=${repo}`, "ls-tree", "-r", "--name-only", "--full-tree", ref]).split("\n").filter((x) => x !== "");
}

function show(repo: string, path: string): string {
	return run([`--git-dir=${repo}`, "show", `refs/heads/main:${path}`]);
}

function profile(name = "p"): string {
	const dir = createProfile(s.l, name).dir;
	writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nBe brief.\n");
	mkdirSync(join(dir, "skills", "s"), { recursive: true });
	writeFileSync(join(dir, "skills", "s", "SKILL.md"), "---\nname: s\n---\nA skill.\n");
	return dir;
}

/** The one hub in `r` that failed: it must be a refusal matching `re`. */
function hubRefusal(r: PushReport, re: RegExp): { readonly message: string } {
	const failed = r.hubs.filter((h) => h.failed !== undefined);
	assert.equal(failed.length, 1, `expected one failed hub, got ${JSON.stringify(r.hubs)}`);
	const f = failed[0]?.failed;
	assert.ok(f?.refused === true, `expected a refusal, got ${JSON.stringify(f)}`);
	assert.match(f.message, re);
	return { message: f.message };
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

beforeEach(() => {
	s = sandbox();
	remote = bareRepo();
	env = { HOME: s.home, PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "host-a", PATH: process.env.PATH };
});
afterEach(() => {
	s.cleanup();
});

describe("hub remotes", () => {
	it("accepts a bare repository on a tailnet machine or a local path", () => {
		for (const ok of ["good-kiwi-studio:pi-hub.git", "chris@good-kiwi-studio:/srv/git/pi-hub.git", "ssh://good-kiwi-studio/srv/pi-hub.git", "ssh://git@studio.tail1234.ts.net:22/srv/hub.git", "/srv/git/hub.git", "file:///srv/git/hub.git"])
			assert.equal(hubRemoteProblem(ok), undefined, ok);
	});

	it("refuses third-party hosts, other transports and option-like remotes", () => {
		for (const bad of ["https://gitlab.com/x/hub.git", "git@gitlab.com:x/hub.git", "git@github.com:x/hub.git", "ssh://gitlab.example.com/x/hub.git", "ext::sh -c touch% /tmp/x", "-oProxyCommand=x:y", "host:-x", "relative/path", "/srv/../etc/hub.git", "ssh://host/a b", ""])
			assert.notEqual(hubRemoteProblem(bad), undefined, bad);
	});

	it("stores hubs as a named list that may hold more than one", () => {
		const c = parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, hubs: { default: { remote: "studio:hub.git" }, work: { remote: "/srv/work.git" } } });
		assert.deepEqual(c.hubs, { default: { remote: "studio:hub.git" }, work: { remote: "/srv/work.git" } });
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, hubs: { default: { remote: "https://gitlab.com/x.git" } } }), /hubs.default.remote/);
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, hubs: { default: { remote: "/x.git", token: "t" } } }), /hubs.default must be \{ remote \}/);
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, hubs: { "../x": { remote: "/x.git" } } }), /each name/);
	});

	it("lets a profile name its hub in sync.hub", () => {
		const ok = parseManifest({ schemaVersion: 1, name: "p", sync: { hub: "work" } }, "/tmp/p");
		assert.ok(ok.ok);
		assert.equal(ok.value.sync?.hub, "work");
		const bad = parseManifest({ schemaVersion: 1, name: "p", sync: { hub: "../x" } }, "/tmp/p");
		assert.ok(!bad.ok);
		assert.match(bad.errors.join(), /sync.hub must be a hub name/);
	});
});

describe("sync init", () => {
	it("makes a bare mirror and records the hub as default", () => {
		const r = initHub(s.l, remote, { env });
		assert.equal(r.hub, "default");
		assert.equal(r.created, true);
		assert.equal(r.head, undefined);
		assert.equal(r.dir, join(s.home, "pi-profile", "sync", "default.git"));
		assert.equal(run([`--git-dir=${r.dir}`, "rev-parse", "--is-bare-repository"]).trim(), "true");
		assert.deepEqual(loadConfig(s.l, env).hubs, { default: { remote } });
		// Again: nothing changes.
		assert.equal(initHub(s.l, remote, { env }).created, false);
	});

	it("refuses a remote that is not on the tailnet and records nothing", () => {
		refusal(() => initHub(s.l, "https://gitlab.com/x/hub.git", { env }), /tailnet/);
		assert.equal(loadConfig(s.l, env).hubs, undefined);
	});

	it("refuses a remote that does not exist and leaves no mirror", () => {
		refusal(() => initHub(s.l, join(s.home, "missing.git"), { env }), /cannot fetch hub default/);
		assert.equal(loadConfig(s.l, env).hubs, undefined);
		assert.throws(() => readFileSync(join(hubMirror(s.l, "default"), "HEAD")));
	});

	it("refuses to repoint a hub at another remote", () => {
		initHub(s.l, remote, { env });
		refusal(() => initHub(s.l, bareRepo(), { env }), /already uses another remote/);
	});

	it("takes the history of a hub that has one", () => {
		profile();
		initHub(s.l, remote, { env });
		const pushed = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		const other = sandbox();
		try {
			const r = initHub(other.l, remote, { env: { ...env, HOME: other.home, PI_PROFILE_HOME: other.home, PI_PROFILE_HOST_ID: "host-b" } });
			assert.equal(r.head, pushed);
			assert.equal(head(r.dir), pushed);
		} finally {
			other.cleanup();
		}
	});
});

describe("sync push", () => {
	it("commits each profile's config in portable form as <host>: <profiles>", () => {
		const dir = profile();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ sessionDir: join(s.home, "sessions"), skillPaths: [join(s.home, "Code", "skills"), join(s.home, "notes")] }, null, "\t"));
		mkdirSync(join(dir, "sessions"));
		writeFileSync(join(dir, "sessions", "x.jsonl"), "{}\n");
		writeFileSync(join(dir, "debug.log"), "log\n");
		initHub(s.l, remote, { env });
		const r = pushHubs(s.l, ["p"], { env });
		const commit = r.hubs[0]?.commit;
		assert.ok(commit !== undefined);
		assert.equal(head(remote), commit);
		assert.equal(run([`--git-dir=${remote}`, "log", "-1", "--format=%s", "main"]).trim(), "host-a: p");
		assert.deepEqual(files(remote), ["hub.json", "profiles/p/AGENTS.md", "profiles/p/profile.json", "profiles/p/settings.json", "profiles/p/skills/s/SKILL.md"]);
		const settings = JSON.parse(show(remote, "profiles/p/settings.json")) as Record<string, unknown>;
		assert.deepEqual(settings, { skillPaths: ["${CODE}/skills", "${HOME}/notes"] });
		assert.deepEqual(JSON.parse(show(remote, "hub.json")), { schemaVersion: 1, aliases: {} });
	});

	it("never stages auth.json, whether shared or a profile's own file", () => {
		profile("shared");
		const own = createProfile(s.l, "own", { auth: "separate", copyAuth: true }).dir;
		assert.match(readFileSync(join(own, "auth.json"), "utf8"), /api_key/);
		initHub(s.l, remote, { env });
		pushHubs(s.l, [], { env });
		const all = files(remote);
		assert.ok(all.includes("profiles/own/profile.json") && all.includes("profiles/shared/profile.json"), all.join());
		assert.deepEqual(all.filter((f) => /auth/.test(f)), []);
	});

	it("skips models.json and web-search.json while they hold a literal key, and says why", () => {
		const dir = profile();
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: KEY } } }, null, "\t"));
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ exaApiKey: "e1f2a3b4c5d6e7f8a9b0c1d2" }, null, "\t")); // gitleaks:allow
		initHub(s.l, remote, { env });
		const r = pushHubs(s.l, ["p"], { env });
		assert.deepEqual(r.skipped.map((x) => x.path).sort(), ["models.json", "web-search.json"]);
		for (const x of r.skipped) {
			assert.match(x.reason, /credential-looking value at/);
			assert.match(x.reason, /literal key: replace each with an environment variable reference/);
			assert.ok(!x.reason.includes(KEY) && !x.reason.includes("e1f2a3b4"));
		}
		assert.ok(r.hubs[0]?.commit !== undefined, "the other files are still pushed");
		assert.ok(!files(remote).some((f) => /models|web-search/.test(f)));
	});

	it("keeps the hub's copy of a file it skips, and removes a deleted file", () => {
		const dir = profile();
		mkdirSync(join(dir, "prompts"));
		writeFileSync(join(dir, "prompts", "p.md"), "Review.\n");
		initHub(s.l, remote, { env });
		pushHubs(s.l, ["p"], { env });
		writeFileSync(join(dir, "AGENTS.md"), `# Agents\n\napi_key: ${KEY}\n`);
		rmSync(join(dir, "prompts", "p.md"));
		const r = pushHubs(s.l, ["p"], { env });
		assert.deepEqual(r.skipped.map((x) => x.path), ["AGENTS.md"]);
		assert.equal(show(remote, "profiles/p/AGENTS.md"), "# Agents\n\nBe brief.\n");
		assert.ok(!files(remote).includes("profiles/p/prompts/p.md"));
	});

	it("removes the hub's copy of a skipped file once that copy no longer passes the gate", () => {
		const dir = profile();
		const line = "password: hunter2hunter2";
		writeFileSync(join(dir, "AGENTS.md"), `# Agents\n\n${line}\n`);
		const entries = allowEntries(dir, "AGENTS.md", 3, profileSyncRules(s.l, "p", true).rules);
		const manifest = (sync: unknown): string => JSON.stringify({ schemaVersion: 1, name: "p", auth: { mode: "shared" }, sync }, null, "\t");
		writeFileSync(join(dir, "profile.json"), manifest({ allowFindings: entries }));
		initHub(s.l, remote, { env });
		pushHubs(s.l, ["p"], { env });
		assert.ok(files(remote).includes("profiles/p/AGENTS.md"), "allowed, so pushed");
		// The allow entry is withdrawn: the local file is skipped, and the hub's copy, which holds the same line, must go.
		writeFileSync(join(dir, "profile.json"), manifest({}));
		const r = pushHubs(s.l, ["p"], { env });
		assert.ok(r.hubs[0]?.commit !== undefined);
		assert.deepEqual(r.skipped.map((x) => x.path), ["AGENTS.md", "AGENTS.md"]);
		assert.match(r.skipped[1]?.reason ?? "", /^its last copy in the hub was removed: credential-looking value at line 3/);
		assert.ok(!files(remote).includes("profiles/p/AGENTS.md"));
	});

	it("makes no commit when nothing changed", () => {
		profile();
		initHub(s.l, remote, { env });
		const first = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		const again = pushHubs(s.l, ["p"], { env });
		assert.equal(again.hubs[0]?.commit, undefined);
		assert.equal(head(remote), first);
	});

	it("syncs a profile that links to another profile as an alias, not a second copy", () => {
		profile("fabric");
		symlinkSync(join(s.home, "profiles", "fabric"), join(s.home, "profiles", "fabric-dogfood"));
		initHub(s.l, remote, { env });
		const r = pushHubs(s.l, ["fabric", "fabric-dogfood"], { env });
		assert.deepEqual(r.aliases, [{ profile: "fabric-dogfood", target: "fabric" }]);
		assert.deepEqual(JSON.parse(show(remote, "hub.json")), { schemaVersion: 1, aliases: { "fabric-dogfood": "fabric" } });
		assert.ok(!files(remote).some((f) => f.startsWith("profiles/fabric-dogfood/")));
	});

	it("pushes each profile to the hub it names, falling back to default", () => {
		profile("a");
		const b = profile("b");
		writeFileSync(join(b, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "b", auth: { mode: "shared" }, sync: { hub: "work" } }, null, "\t"));
		const work = bareRepo();
		initHub(s.l, remote, { env });
		refusal(() => pushHubs(s.l, ["b"], { env }), /hub work is not configured/);
		initHub(s.l, work, { env, hub: "work" });
		pushHubs(s.l, ["a", "b"], { env });
		assert.ok(files(remote).includes("profiles/a/AGENTS.md") && !files(remote).some((f) => f.startsWith("profiles/b/")));
		assert.ok(files(work).includes("profiles/b/AGENTS.md") && !files(work).some((f) => f.startsWith("profiles/a/")));
	});

	it("lists a profile it cannot push when pushing all, and refuses it when named", () => {
		profile("good");
		const bad = profile("bad");
		writeFileSync(join(bad, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "bad", sync: { hub: "nowhere" } }));
		initHub(s.l, remote, { env });
		const r = pushHubs(s.l, [], { env });
		assert.deepEqual(r.skippedProfiles.map((x) => x.profile), ["bad"]);
		assert.ok(files(remote).includes("profiles/good/AGENTS.md"));
		refusal(() => pushHubs(s.l, ["bad"], { env }), /hub nowhere is not configured/);
	});

	it("refuses before sync init", () => {
		profile();
		refusal(() => pushHubs(s.l, ["p"], { env }), /sync init/);
	});

	it("reads the bytes it checked: a file swapped for a link after the plan is skipped", () => {
		profile();
		initHub(s.l, remote, { env });
		const hooks: PushHooks = {
			afterPlan: (_name, real) => {
				rmSync(join(real, "AGENTS.md"));
				symlinkSync(join(s.home, "agent", "auth.json"), join(real, "AGENTS.md"));
			},
		};
		const r = pushHubs(s.l, ["p"], { env, hooks });
		assert.deepEqual(r.skipped, [{ profile: "p", path: "AGENTS.md", reason: "a link: never followed, never config" }]);
		assert.ok(!files(remote).includes("profiles/p/AGENTS.md"));
	});

	it("skips a file that gained a second name after the plan", () => {
		profile();
		initHub(s.l, remote, { env });
		const hooks: PushHooks = {
			afterPlan: (_name, real) => {
				spawnSync("ln", [join(real, "AGENTS.md"), join(s.home, "elsewhere")]);
			},
		};
		const r = pushHubs(s.l, ["p"], { env, hooks });
		assert.deepEqual(r.skipped.map((x) => [x.path, x.reason]), [["AGENTS.md", "a hard link: another name shares its contents"]]);
	});

	it("rechecks the bytes it read: a file that gained a key after the plan is skipped", () => {
		profile();
		initHub(s.l, remote, { env });
		const hooks: PushHooks = {
			afterPlan: (_name, real) => {
				writeFileSync(join(real, "AGENTS.md"), `token = "${KEY}"\n`);
			},
		};
		const r = pushHubs(s.l, ["p"], { env, hooks });
		assert.deepEqual(r.skipped.map((x) => x.path), ["AGENTS.md"]);
		assert.match(r.skipped[0]?.reason ?? "", /credential-looking value at line 1/);
		assert.ok(!files(remote).includes("profiles/p/AGENTS.md"));
	});
});

describe("the commit gate", () => {
	/** Push profile p with `path` staged as `text` just before the gate; the refusal it must give. */
	function staged(path: string, text: string): { readonly message: string } {
		profile();
		initHub(s.l, remote, { env });
		const before = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		writeFileSync(join(s.home, "profiles", "p", "AGENTS.md"), "# Agents\n\nChanged.\n");
		const hooks: PushHooks = { beforeGate: (stage) => stage(path, Buffer.from(text)) };
		const e = hubRefusal(pushHubs(s.l, ["p"], { env, hooks }), /refused to commit to hub default; nothing was pushed/);
		assert.equal(head(remote), before, "the hub did not move");
		assert.equal(head(hubMirror(s.l, "default")), before, "the mirror did not move");
		return e;
	}

	it("refuses a staged auth.json", () => {
		const e = staged("profiles/p/auth.json", '{"anthropic":{"type":"api_key","key":"shared"}}\n');
		assert.match(e.message, /profiles\/p\/auth\.json: a credential file name; auth\.json and other secrets never go to the hub/);
	});

	it("refuses any staged secret name", () => {
		assert.match(staged("profiles/p/skills/s/.env", "A=1\n").message, /skills\/s\/\.env: a credential file name/);
	});

	it("refuses a staged path under a secret directory", () => {
		assert.match(staged("profiles/p/skills/.ssh/config", "Host x\n").message, /skills\/\.ssh\/config: a credential file name/);
	});

	it("refuses a staged path that is not config", () => {
		const e = staged("profiles/p/cache/models.bin", "x");
		assert.match(e.message, /profiles\/p\/cache\/models\.bin: class state; only config goes to the hub/);
	});

	it("refuses a staged path of unknown class", () => {
		const e = staged("profiles/p/notes.txt", "hello\n");
		assert.match(e.message, /profiles\/p\/notes\.txt: class unknown; only config goes to the hub/);
	});

	it("refuses a staged credential string and never prints it", () => {
		const e = staged("profiles/p/AGENTS.md", `# Agents\n\nexport ANTHROPIC_API_KEY=${KEY}\n`);
		assert.match(e.message, /profiles\/p\/AGENTS\.md: credential-looking value at line 3/);
		assert.ok(!e.message.includes(KEY));
	});

	it("refuses a staged path outside profiles/<name>/", () => {
		assert.match(staged("README.md", "hi\n").message, /README\.md: outside profiles\/<name>\//);
	});

	it("classes a staged file by the staged profile.json, not this host's", () => {
		const e = staged("profiles/p/profile.json", JSON.stringify({ schemaVersion: 1, name: "p", sync: { exclude: ["AGENTS.md"] } }));
		assert.match(e.message, /profiles\/p\/AGENTS\.md: class state; only config goes to the hub/);
	});

	it("refuses files staged under a profile the hub records as an alias", () => {
		profile("fabric");
		symlinkSync(join(s.home, "profiles", "fabric"), join(s.home, "profiles", "fabric-dogfood"));
		initHub(s.l, remote, { env });
		const hooks: PushHooks = { beforeGate: (stage) => stage("profiles/fabric-dogfood/AGENTS.md", Buffer.from("# A\n")) };
		hubRefusal(pushHubs(s.l, ["fabric", "fabric-dogfood"], { env, hooks }), /profiles\/fabric-dogfood\/AGENTS\.md: fabric-dogfood is an alias and holds no files/);
		assert.equal(head(remote), undefined);
	});

	it("refuses a staged profile.json whose sync rules do not parse", () => {
		const e = staged("profiles/p/profile.json", JSON.stringify({ schemaVersion: 1, name: "p", sync: { include: ["/abs"] } }));
		assert.match(e.message, /profiles\/p\/AGENTS\.md: profile\.json: sync\.include/);
	});

	it("checks an existing tree directly", () => {
		profile();
		initHub(s.l, remote, { env });
		pushHubs(s.l, ["p"], { env });
		assert.deepEqual(gateTree(remote, "refs/heads/main", env), []);
		// A tree with an auth.json, made by hand.
		const work = mkdtempSync(join(tmpdir(), "pi-profile-gate-"));
		try {
			run(["clone", "--quiet", remote, work]);
			writeFileSync(join(work, "profiles", "p", "auth.json"), "{}\n");
			run(["add", "-A"], work);
			run(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "x"], work);
			assert.deepEqual(gateTree(join(work, ".git"), "HEAD", env).map((x) => x.path), ["profiles/p/auth.json"]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("a hub that moved", () => {
	it("refuses a push when the hub moved: fetches, names sync pull as the recovery, never merges or moves main", () => {
		profile();
		initHub(s.l, remote, { env });
		const mine = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		const other = sandbox();
		let theirs: string | undefined;
		try {
			const envB = { ...env, HOME: other.home, PI_PROFILE_HOME: other.home, PI_PROFILE_HOST_ID: "host-b" };
			createProfile(other.l, "q");
			initHub(other.l, remote, { env: envB });
			theirs = pushHubs(other.l, ["q"], { env: envB }).hubs[0]?.commit;
		} finally {
			other.cleanup();
		}
		assert.ok(theirs !== undefined && theirs !== mine);
		writeFileSync(join(s.home, "profiles", "p", "AGENTS.md"), "# Agents\n\nNew.\n");
		const e = hubRefusal(pushHubs(s.l, ["p"], { env }), /has commits this host has not pulled \(fetched it\)\. Nothing was merged or pushed\./);
		// The recovery is sync pull (issue 32); no command with a path is printed (issue 45).
		assert.match(e.message, /run pi-profile sync pull first, then sync push again/);
		assert.doesNotMatch(e.message, /update-ref|--git-dir/);
		assert.equal(head(remote), theirs, "the hub keeps the other host's commit");
		const mirror = hubMirror(s.l, "default");
		assert.equal(head(mirror), mine, "the mirror's main is not merged or moved");
		assert.equal(run([`--git-dir=${mirror}`, "rev-parse", "refs/remotes/origin/main"]).trim(), theirs, "it fetched the hub");
		assert.equal(run([`--git-dir=${remote}`, "rev-list", "--merges", "--count", "main"]).trim(), "0");
		assert.deepEqual(pullHubs(s.l, [], { env }).conflicts, []);
		const again = pushHubs(s.l, ["p"], { env }).hubs[0];
		assert.equal(again?.failed, undefined, JSON.stringify(again));
		assert.equal(head(remote), again?.commit);
		assert.deepEqual(files(remote).filter((f) => f.endsWith("profile.json")), ["profiles/p/profile.json", "profiles/q/profile.json"], "the other host's profile is kept");
	});
});

describe("sync init and sync push on the command line", () => {
	it("runs init then push, and exits 2 on a refusal", () => {
		const dir = profile();
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: KEY } } }, null, "\t"));
		const io = captureIo(env);
		assert.equal(main(["sync", "init", remote], io), 0, io.stderr);
		assert.match(io.stdout, /hub default: .*\nmirror: .*default\.git\nthe hub is empty/);
		assert.equal(main(["sync", "push", "p"], io), 0, io.stderr);
		assert.match(io.stdout, /not pushed \(1 file; locations only, never values\):\n {2}p\/models\.json: credential-looking value at providers\.x\.apiKey; it stays out of the hub/);
		assert.match(io.stdout, /hub default: pushed [0-9a-f]{12} \(p\)/);
		assert.ok(!io.stdout.includes(KEY) && !io.stderr.includes(KEY));
		const bad = captureIo(env);
		assert.equal(main(["sync", "init", "https://gitlab.com/x/y.git"], bad), 2);
		assert.equal(main(["sync", "push", "--force"], bad), 2);
		assert.equal(main(["sync", "push", "missing"], bad), 2);
	});

	it("keeps an executable script executable", () => {
		const dir = profile();
		writeFileSync(join(dir, "skills", "s", "run"), "#!/bin/sh\necho hi\n");
		chmodSync(join(dir, "skills", "s", "run"), 0o755);
		initHub(s.l, remote, { env });
		pushHubs(s.l, ["p"], { env });
		assert.match(run([`--git-dir=${remote}`, "ls-tree", "main", "profiles/p/skills/s/run"]), /^100755 /);
	});

	it("refuses a mirror that was replaced by something else", () => {
		profile();
		initHub(s.l, remote, { env });
		const mirror = hubMirror(s.l, "default");
		renameSync(mirror, `${mirror}.old`);
		symlinkSync(`${mirror}.old`, mirror);
		hubRefusal(pushHubs(s.l, ["p"], { env }), /not set up on this host/);
	});
});

/** Tests for issue 42: the gaps the review of #31 found. */
describe("hub review gaps (issue 42)", () => {
	function setRemote(to: string): void {
		updateConfig(s.l, (c) => ({ ...c, hubs: { ...(c.hubs ?? {}), default: { remote: to } } }), env);
	}

	it("refuses to push the old hub's history to a hub whose remote was changed by hand", () => {
		profile();
		initHub(s.l, remote, { env });
		const old = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		assert.ok(old !== undefined);
		const moved = bareRepo();
		setRemote(moved);
		writeFileSync(join(s.home, "profiles", "p", "AGENTS.md"), "# Agents\n\nChanged.\n");
		hubRefusal(pushHubs(s.l, ["p"], { env }), /the mirror .* follows .*, not .*; remove the mirror and run pi-profile sync init .* again/);
		assert.equal(head(moved), undefined, "nothing reached the new hub");
		assert.equal(head(remote), old, "nothing reached the old hub");
		// sync init refuses the same mirror.
		refusal(() => initHub(s.l, moved, { env }), /remove the mirror/);
		assert.equal(head(moved), undefined);
		// The way the refusal names works, and the new hub gets one commit, not the old history.
		rmSync(hubMirror(s.l, "default"), { recursive: true, force: true });
		initHub(s.l, moved, { env });
		const fresh = pushHubs(s.l, ["p"], { env }).hubs[0]?.commit;
		assert.equal(head(moved), fresh);
		assert.equal(run([`--git-dir=${moved}`, "rev-list", "--count", "main"]).trim(), "1");
	});

	it("refuses sync init when the mirror follows another remote and the hub is not recorded", () => {
		profile();
		initHub(s.l, remote, { env });
		pushHubs(s.l, ["p"], { env });
		updateConfig(s.l, (c) => ({ schemaVersion: c.schemaVersion, sessionStores: c.sessionStores, ...(c.hostId === undefined ? {} : { hostId: c.hostId }) }), env);
		assert.equal(loadConfig(s.l, env).hubs, undefined);
		const moved = bareRepo();
		refusal(() => initHub(s.l, moved, { env }), /follows .*; remove the mirror/);
		assert.equal(loadConfig(s.l, env).hubs, undefined, "the new remote is not recorded");
		assert.equal(head(moved), undefined);
	});

	it("reports each hub: a later hub's failure keeps an earlier hub's push, and the command exits nonzero", () => {
		profile("a");
		const b = profile("b");
		writeFileSync(join(b, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "b", auth: { mode: "shared" }, sync: { hub: "work" } }, null, "\t"));
		initHub(s.l, remote, { env });
		initHub(s.l, bareRepo(), { env, hub: "work" });
		rmSync(hubMirror(s.l, "work"), { recursive: true, force: true });
		const r = pushHubs(s.l, ["a", "b"], { env });
		assert.deepEqual(r.hubs.map((h) => [h.hub, h.commit !== undefined, h.failed?.refused]), [["default", true, undefined], ["work", false, true]]);
		assert.equal(head(remote), r.hubs[0]?.commit);
		assert.match(r.hubs[1]?.failed?.message ?? "", /hub work is not set up on this host/);
		writeFileSync(join(s.home, "profiles", "a", "AGENTS.md"), "# Agents\n\nChanged.\n");
		const io = captureIo(env);
		assert.equal(main(["sync", "push", "a", "b"], io), 2);
		assert.match(io.stdout, /hub default: pushed [0-9a-f]{12} \(a\)/);
		assert.match(io.stderr, /pi-profile: hub work is not set up on this host/);
	});

	it("checks the recorded remote under the sync lock", () => {
		const other = bareRepo();
		// Another init records the hub between the checks before the lock and the lock.
		const hooks = { beforeLock: () => void initHub(s.l, remote, { env }) };
		refusal(() => initHub(s.l, other, { env, hooks }), /hub default already uses another remote/);
		assert.deepEqual(loadConfig(s.l, env).hubs, { default: { remote } });
	});

	it("reads each profile under its lock: a profile another pi-profile is changing is not pushed", () => {
		const dir = profile();
		profile("q");
		initHub(s.l, remote, { env });
		// A live process (the test runner's parent) holds p's lock.
		writeFileSync(join(dir, LOCK_FILE), `${String(process.ppid)} other\n`);
		refusal(() => pushHubs(s.l, ["p"], { env }), /is being changed by process/);
		assert.equal(head(remote), undefined);
		const r = pushHubs(s.l, [], { env });
		assert.ok(r.skippedProfiles.some((x) => x.profile === "p" && /being changed/.test(x.reason)), JSON.stringify(r.skippedProfiles));
		assert.ok(!files(remote).some((f) => f.startsWith("profiles/p/")) && files(remote).includes("profiles/q/AGENTS.md"));
	});

	it("runs no hook and ignores GIT_DIR and GIT_CONFIG_PARAMETERS", () => {
		profile();
		initHub(s.l, remote, { env });
		const marker = join(s.home, "hook-ran");
		const script = `#!/bin/sh\necho "$0" >> ${marker}\nexit 0\n`;
		const plant = (hooks: string): void => {
			mkdirSync(hooks, { recursive: true });
			for (const name of ["pre-push", "reference-transaction", "post-update"]) {
				writeFileSync(join(hooks, name), script);
				chmodSync(join(hooks, name), 0o755);
			}
		};
		plant(join(hubMirror(s.l, "default"), "hooks"));
		const elsewhere = join(s.home, "other-hooks");
		plant(elsewhere);
		const decoy = bareRepo();
		const hostile = { ...env, GIT_DIR: decoy, GIT_CONFIG_PARAMETERS: `'core.hookspath'='${elsewhere}' 'remote.origin.url'='${decoy}'` };
		const r = pushHubs(s.l, ["p"], { env: hostile });
		assert.equal(r.hubs[0]?.failed, undefined, JSON.stringify(r.hubs));
		assert.equal(head(remote), r.hubs[0]?.commit, "it pushed to the recorded hub");
		assert.equal(head(decoy), undefined, "GIT_DIR and the config parameter had no effect");
		assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
	});

	it("refuses a mirror path that is an ordinary folder", () => {
		profile();
		const mirror = hubMirror(s.l, "default");
		mkdirSync(mirror, { recursive: true });
		writeFileSync(join(mirror, "notes.txt"), "x\n");
		refusal(() => initHub(s.l, remote, { env }), /is not a bare git repository; move it away/);
		const io = captureIo(env);
		assert.equal(main(["sync", "init", remote], io), 2, io.stderr);
		// A hub recorded before the mirror was replaced is refused at push too.
		updateConfig(s.l, (c) => ({ ...c, hubs: { default: { remote } } }), env);
		hubRefusal(pushHubs(s.l, ["p"], { env }), /is not a bare git repository/);
	});

	it("exits 1 and names git when git cannot run, and leaves the mirror in place (issue 45)", () => {
		profile();
		initHub(s.l, remote, { env });
		const mirror = hubMirror(s.l, "default");
		const noGit = { ...env, PATH: "/nonexistent-bin" };
		assert.throws(
			() => initHub(s.l, remote, { env: noGit }),
			(error: unknown) => error instanceof Error && !(error instanceof Refusal) && /git is not installed/.test(error.message),
		);
		const r = pushHubs(s.l, ["p"], { env: noGit });
		assert.equal(r.hubs[0]?.failed?.refused, false, JSON.stringify(r.hubs));
		assert.match(r.hubs[0]?.failed?.message ?? "", /git is not installed/);
		assert.doesNotMatch(r.hubs[0]?.failed?.message ?? "", /move it away|not a bare/);
		for (const args of [["sync", "init", remote], ["sync", "push", "p"], ["sync", "pull"]]) {
			const io = captureIo(noGit);
			assert.equal(main(args, io), 1, `${args.join(" ")}: ${io.stderr}`);
			assert.match(io.stderr, /git/);
			assert.doesNotMatch(io.stderr, /move it away|not a bare|follows no remote/);
		}
		assert.ok(existsSync(join(mirror, "HEAD")), "the mirror is left in place");
		assert.equal(head(remote), undefined, "nothing reached the hub");
	});

	it("clears the stage folders a killed push left in the mirror", () => {
		profile();
		initHub(s.l, remote, { env });
		const mirror = hubMirror(s.l, "default");
		mkdirSync(join(mirror, "pi-profile-stage-killed"));
		writeFileSync(join(mirror, "pi-profile-stage-killed", "index"), "x");
		const r = pushHubs(s.l, ["p"], { env });
		assert.ok(r.hubs[0]?.commit !== undefined);
		assert.deepEqual(readdirSync(mirror).filter((n) => n.startsWith("pi-profile-stage-")), []);
	});
});
