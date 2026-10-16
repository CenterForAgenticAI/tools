import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inspectAuth, setAuthMode } from "../src/core/auth.ts";
import { doctor } from "../src/core/doctor.ts";
import { applyPlan, currentProfile, nameForDir, profileEnv } from "../src/core/launch.ts";
import { applyGroup, readMultiAccount } from "../src/core/multi-account.ts";
import {
	adoptProfile,
	createProfile,
	deleteProfile,
	getGlobalDefault,
	listProfiles,
	loadProfile,
	requireProfile,
	setGlobalDefault,
} from "../src/core/profiles.ts";
import { Refusal } from "../src/core/result.ts";
import { sandbox, saveManifest, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const shared = (): string => join(s.home, "agent", "auth.json");

describe("create", () => {
	it("makes a shared-auth profile with a manifest", () => {
		const info = createProfile(s.l, "work", { color: "teal", description: "day job" });
		assert.equal(info.hasManifest, true);
		assert.equal(info.manifest.auth.mode, "shared");
		assert.equal(readlinkSync(join(info.dir, "auth.json")), shared());
		assert.equal(info.manifest.description, "day job");
		assert.equal(lstatSync(join(s.home, "profiles")).mode & 0o777, 0o700);
		assert.deepEqual(listProfiles(s.l), ["default", "work"]);
	});
	it("separate auth starts empty: credentials are not copied silently (L16)", () => {
		const info = createProfile(s.l, "solo", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		assert.equal(readFileSync(p, "utf8"), "{}\n");
		assert.equal(lstatSync(p).mode & 0o777, 0o600);
	});
	it("copies credentials only when asked", () => {
		const info = createProfile(s.l, "copy", { auth: "pooled", copyAuth: true });
		assert.match(readFileSync(join(info.dir, "auth.json"), "utf8"), /shared/);
	});
	it("refuses bad names, the reserved name and duplicates", () => {
		assert.throws(() => createProfile(s.l, "../escape"), Refusal);
		assert.throws(() => createProfile(s.l, "default"), Refusal);
		createProfile(s.l, "x");
		assert.throws(() => createProfile(s.l, "x"), /already exists/);
		assert.equal(existsSync(join(s.home, "escape")), false);
	});
	it("--from copies settings and the multi-account group", () => {
		const src = createProfile(s.l, "src");
		writeFileSync(join(src.dir, "settings.json"), '{"theme":"dark"}\n');
		writeFileSync(join(src.dir, "AGENTS.md"), "hi\n");
		applyGroup(src.dir, "caair", ["acct1"]);
		saveManifest(s.l, "src", { ...loadProfile(s.l, "src").manifest, multiAccount: { group: "caair" } });
		const copy = createProfile(s.l, "copy", { from: "src" });
		assert.equal(readFileSync(join(copy.dir, "settings.json"), "utf8"), '{"theme":"dark"}\n');
		assert.equal(readFileSync(join(copy.dir, "AGENTS.md"), "utf8"), "hi\n");
		assert.equal(readMultiAccount(copy.dir).defaultGroup, "caair");
		assert.equal(copy.manifest.multiAccount?.group, "caair");
	});
	it("refuses --from a profile with env paths, and leaves nothing half-made", () => {
		const src = createProfile(s.l, "src");
		saveManifest(s.l, "src", { ...src.manifest, env: { PI_MEMORY_DIR: join(src.dir, "memory") } });
		assert.throws(() => createProfile(s.l, "copy", { from: "src" }), /env/);
		assert.deepEqual(listProfiles(s.l), ["default", "src"]);
	});
	it("an undefined group fails the create, and the staging dir is kept as .failed-*", () => {
		assert.throws(() => createProfile(s.l, "g", { group: "nope" }), /not defined/);
		assert.equal(existsSync(join(s.home, "profiles", "g")), false);
		assert.ok(doctor(s.l).some((f) => f.message.includes(".failed-g")));
	});
});

describe("auth modes (L15, L16)", () => {
	it("switching to shared keeps the private file as a backup", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		writeFileSync(join(info.dir, "auth.json"), '{"mine":1}\n');
		setAuthMode(info.dir, shared(), "shared");
		assert.equal(inspectAuth(info.dir).kind, "link");
		const backups = listBackups(info.dir);
		assert.equal(backups.length, 1);
		assert.equal(readFileSync(join(info.dir, backups[0] ?? ""), "utf8"), '{"mine":1}\n');
	});
	it("switching from shared to separate never writes through the link", () => {
		const info = createProfile(s.l, "p");
		setAuthMode(info.dir, shared(), "separate");
		assert.equal(inspectAuth(info.dir).kind, "file");
		assert.match(readFileSync(shared(), "utf8"), /shared/);
	});
	it("a separate file is left alone when already private", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		writeFileSync(join(info.dir, "auth.json"), '{"keep":1}\n');
		setAuthMode(info.dir, shared(), "pooled");
		assert.equal(readFileSync(join(info.dir, "auth.json"), "utf8"), '{"keep":1}\n');
	});
	it("refuses an auth.json that is a directory", () => {
		const info = createProfile(s.l, "p", { auth: "separate" });
		const p = join(info.dir, "auth.json");
		chmodSync(p, 0o600);
		const dir = join(s.home, "profiles", "q");
		mkdirSync(join(dir, "auth.json"), { recursive: true });
		assert.throws(() => setAuthMode(dir, shared(), "shared"), Refusal);
	});
});

function listBackups(dir: string): string[] {
	return readdirSync(dir).filter((n) => n.startsWith("auth.json.bak-"));
}

describe("multi-account groups (L22, L23)", () => {
	it("refuses an undefined group and writes nothing", () => {
		const info = createProfile(s.l, "p");
		assert.throws(() => applyGroup(info.dir, "ghost"), Refusal);
		assert.equal(readMultiAccount(info.dir).exists, false);
	});
	it("keeps unrelated keys", () => {
		const info = createProfile(s.l, "p");
		mkdirSync(join(info.dir, "pi-multi-account"));
		writeFileSync(
			join(info.dir, "pi-multi-account", "config.json"),
			JSON.stringify({ accountGroupCwdDefaults: { "/x": "a" }, accountGroups: { a: ["1"], b: ["2"] }, defaultAccountGroup: "a" }),
		);
		applyGroup(info.dir, "b");
		const cfg = JSON.parse(readFileSync(join(info.dir, "pi-multi-account", "config.json"), "utf8"));
		assert.deepEqual(cfg, { accountGroupCwdDefaults: { "/x": "a" }, accountGroups: { a: ["1"], b: ["2"] }, defaultAccountGroup: "b" });
	});
	it("refuses a config that is not an object", () => {
		const info = createProfile(s.l, "p");
		mkdirSync(join(info.dir, "pi-multi-account"));
		writeFileSync(join(info.dir, "pi-multi-account", "config.json"), "[]");
		assert.throws(() => readMultiAccount(info.dir), /JSON object/);
	});
});

describe("existing profiles from the fish utility", () => {
	it("loads without profile.json, reads profile-env.json, and adopts", () => {
		const dir = join(s.home, "profiles", "legacy");
		mkdirSync(dir, { recursive: true });
		symlinkSync(shared(), join(dir, "auth.json"));
		writeFileSync(join(dir, "profile-env.json"), JSON.stringify({ ACP_AUTO_UPDATE: "0", LD_PRELOAD: "/x" }));
		let info = loadProfile(s.l, "legacy");
		assert.equal(info.hasManifest, false);
		// One bad key drops the whole legacy env rather than applying part of it.
		assert.equal(info.manifest.env, undefined);
		writeFileSync(join(dir, "profile-env.json"), JSON.stringify({ ACP_AUTO_UPDATE: "0" }));
		info = loadProfile(s.l, "legacy");
		assert.deepEqual(info.manifest.env, { ACP_AUTO_UPDATE: "0" });
		assert.ok(doctor(s.l).some((f) => f.profile === "legacy" && f.message.includes("adopt")));
		assert.equal(adoptProfile(s.l, "legacy").adopted, true);
		assert.equal(adoptProfile(s.l, "legacy").adopted, false);
		assert.equal(loadProfile(s.l, "legacy").manifest.auth.mode, "shared");
	});
	it("lists a symlinked profile inside the root, refuses one that escapes", () => {
		createProfile(s.l, "real");
		symlinkSync(join(s.home, "profiles", "real"), join(s.home, "profiles", "alias"));
		mkdirSync(join(s.home, "outside"));
		symlinkSync(join(s.home, "outside"), join(s.home, "profiles", "evil"));
		assert.deepEqual(listProfiles(s.l), ["default", "alias", "real"]);
		assert.throws(() => requireProfile(s.l, "evil"), /outside/);
		assert.throws(() => requireProfile(s.l, "../agent"), Refusal);
		assert.throws(() => requireProfile(s.l, "missing"), /does not exist/);
	});
	it("reports an invalid manifest instead of using it", () => {
		const info = createProfile(s.l, "p");
		writeFileSync(join(info.dir, "profile.json"), '{"schemaVersion":1,"name":"p","token":"x"}');
		const again = loadProfile(s.l, "p");
		assert.ok(again.manifestErrors.length > 0);
		assert.throws(() => profileEnv(s.l, "p"), /invalid/);
	});
});

describe("edit, delete, global default", () => {
	it("the default profile's auth must stay separate", () => {
		const m = loadProfile(s.l, "default").manifest;
		assert.equal(m.auth.mode, "separate");
		assert.throws(() => saveManifest(s.l, "default", { ...m, auth: { mode: "shared" } }), /always separate/);
	});
	it("delete moves to trash and refuses the global default", () => {
		createProfile(s.l, "p");
		setGlobalDefault(s.l, "p");
		assert.equal(getGlobalDefault(s.l), "p");
		assert.throws(() => deleteProfile(s.l, "p"), /global default/);
		setGlobalDefault(s.l, undefined);
		assert.equal(getGlobalDefault(s.l), undefined);
		const to = deleteProfile(s.l, "p");
		assert.ok(existsSync(join(to, "profile.json")));
		assert.deepEqual(listProfiles(s.l), ["default"]);
		assert.throws(() => deleteProfile(s.l, "default"), Refusal);
	});
	it("two deletes of one profile name in the same second both reach the trash, under distinct names (issue 53)", () => {
		createProfile(s.l, "p");
		writeFileSync(join(s.home, "profiles", "p", "first.txt"), "1\n");
		const first = deleteProfile(s.l, "p");
		createProfile(s.l, "p");
		writeFileSync(join(s.home, "profiles", "p", "second.txt"), "2\n");
		const second = deleteProfile(s.l, "p");
		createProfile(s.l, "p");
		const third = deleteProfile(s.l, "p");
		const trash = join(s.home, "profiles", ".trash");
		assert.equal(new Set([first, second, third]).size, 3);
		assert.deepEqual(readdirSync(trash).sort(), [first, second, third].map((t) => t.slice(trash.length + 1)).sort());
		assert.ok(existsSync(join(first, "first.txt")) && existsSync(join(second, "second.txt")));
		// Readable: the name, the time, and a counter only when that name is taken.
		const base = /^p-\d{8}-\d{6}$/;
		const names = [first, second, third].map((t) => t.slice(trash.length + 1));
		for (const n of names) assert.match(n, /^p-\d{8}-\d{6}(-\d+)?$/);
		assert.ok(names.some((n) => base.test(n)));
	});
	it("refuses a global default file holding a bad name", () => {
		mkdirSync(join(s.home, "profiles"), { recursive: true });
		writeFileSync(join(s.home, "profiles", ".global-default"), "../agent\n");
		assert.throws(() => getGlobalDefault(s.l), /invalid name/);
		assert.ok(doctor(s.l).some((f) => f.level === "error"));
		assert.throws(() => setGlobalDefault(s.l, "missing"), /does not exist/);
	});
});

describe("launch environment", () => {
	it("sets the profile and clears every other managed variable", () => {
		const info = createProfile(s.l, "p");
		saveManifest(s.l, "p", { ...info.manifest, env: { ACP_AUTO_UPDATE: "0" } });
		const env = applyPlan({ HOME: "/h", ACP_DELEGATE: "leaked", PI_PROFILE_LABEL: "old" }, profileEnv(s.l, "p"));
		assert.equal(env["PI_CODING_AGENT_DIR"], info.dir);
		assert.equal(env["PI_PROFILE_LABEL"], "p");
		assert.equal(env["ACP_AUTO_UPDATE"], "0");
		assert.equal(env["ACP_DELEGATE"], undefined);
		assert.equal(env["HOME"], "/h");
	});
	it("the default profile points at ~/.pi/agent", () => {
		const env = applyPlan({}, profileEnv(s.l, "default"));
		assert.equal(env["PI_CODING_AGENT_DIR"], join(s.home, "agent"));
	});
	it("currentProfile follows L1-L3", () => {
		const p = createProfile(s.l, "p");
		assert.equal(currentProfile(s.l, {}).source, "builtin-default");
		setGlobalDefault(s.l, "p");
		assert.deepEqual(currentProfile(s.l, {}), { name: "p", agentDir: p.dir, source: "global-default" });
		assert.equal(currentProfile(s.l, { PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }).source, "builtin-default");
		assert.deepEqual(currentProfile(s.l, { PI_CODING_AGENT_DIR: p.dir }), { name: "p", agentDir: p.dir, source: "exported" });
		assert.equal(currentProfile(s.l, { PI_PROFILE_LABEL: "q", PI_CODING_AGENT_DIR: "/x" }).name, "q");
	});
	it("names directories", () => {
		assert.equal(nameForDir(s.l, join(s.home, "agent")), "default");
		assert.equal(nameForDir(s.l, join(s.home, "profiles", "x")), "x");
		assert.equal(nameForDir(s.l, "/elsewhere"), "custom");
		assert.equal(nameForDir(s.l, join(s.home, "profiles", "x", "y")), "custom");
	});
});

describe("doctor", () => {
	it("is clean for a fresh profile", () => {
		createProfile(s.l, "p");
		assert.deepEqual(doctor(s.l), []);
	});
	it("finds broken auth, loose permissions, missing groups and ignored acp.json", () => {
		const a = createProfile(s.l, "a");
		saveManifest(s.l, "a", { ...a.manifest, auth: { mode: "separate" } });
		chmodSync(join(a.dir, "auth.json"), 0o644);
		writeFileSync(join(a.dir, "acp.json"), "{}");
		const b = createProfile(s.l, "b");
		writeFileSync(join(b.dir, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "b", auth: { mode: "separate" }, multiAccount: { group: "g" } }));
		chmodSync(join(s.home, "profiles"), 0o755);
		const text = doctor(s.l).map((f) => `${f.level} ${f.profile ?? ""} ${f.message}`).join("\n");
		assert.match(text, /error a auth.json is readable by others/);
		assert.match(text, /warn a acp.json here is ignored/);
		assert.match(text, /error b auth mode is separate but auth.json is a link/);
		assert.match(text, /error b multi-account group "g" is not defined/);
		assert.match(text, /open to other users/);
	});
	it("warns when the group in the manifest is not the default group", () => {
		const p = createProfile(s.l, "p");
		applyGroup(p.dir, "a", ["1"]);
		applyGroup(p.dir, "b", ["2"]);
		writeFileSync(join(p.dir, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "p", multiAccount: { group: "a" } }));
		assert.ok(doctor(s.l).some((f) => f.level === "warn" && f.message.includes("defaultAccountGroup")));
	});
});
