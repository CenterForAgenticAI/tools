import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { doctor } from "../src/core/doctor.ts";
import { parseManifest } from "../src/core/manifest.ts";
import { createProfile, loadProfile } from "../src/core/profiles.ts";
import { REPLICA_KINDS } from "../src/core/replica.ts";
import { CHANNELS, classifyPath, credentialKeys, mayCarry, PATH_CLASSES, surveyProfile, type Channel, type PathClass, type SyncRules } from "../src/core/syncmanifest.ts";
import { captureIo, sandbox, saveManifest, type Sandbox } from "./helpers.ts";

const NONE: SyncRules = { include: [], exclude: [], sessionDirs: [] };
function rules(r: Partial<SyncRules>): SyncRules {
	return { ...NONE, ...r };
}
function expectAll(paths: readonly string[], r: SyncRules, cls: PathClass): void {
	for (const p of paths) assert.equal(classifyPath(p, r), cls, p);
}

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

describe("sync manifest built-in rules", () => {
	it("classes the portable layer and allowlisted extension configs as config", () => {
		expectAll(
			["profile.json", "settings.json", "AGENTS.md", "skills", "skills/a/SKILL.md", "prompts/x.md", "models.json", "fabric.json", "web-search.json", "context-aware.json", "acp.json", "pi-multi-account/config.json"],
			NONE,
			"config",
		);
	});
	it("classes credential files as secret", () => {
		expectAll(["auth.json", "auth2.json", "AUTH.JSON", "auth.json.bak-1", "auth.json.aside-x", "auth.json.new-y"], NONE, "secret");
	});
	it("classes the sessions directory as sessions", () => {
		expectAll(["sessions", "sessions/--home--/a.jsonl"], NONE, "sessions");
	});
	it("classes caches, tools, logs, backups and registries as state", () => {
		expectAll(
			["cache", "npm/x", "bin/pi", "install", "git-provenance/state.json", "session-registry/a", "crashes.json", "models-store.json", "trust.json", "settings.json.bak-20260929", "context-aware-debug.log", "pi-multi-account", "pi-multi-account/usage.ndjson", "pi-multi-account/config.json.bak-1", "web-search-cache", "fabric/entropy", "skills/a/run.log"],
			NONE,
			"state",
		);
	});
	it("leaves every other path unknown", () => {
		expectAll(["memory", "extensions", "notes.txt", "skillsx/a", "agents"], NONE, "unknown");
	});
	it("a secret-named file inside skills/ or prompts/ is still a secret", () => {
		const paths = ["skills/auth.json", "skills/s/auth2.json", "prompts/x/auth.json.bak-1", "prompts/auth.json"];
		expectAll(paths, NONE, "secret");
		expectAll(paths, rules({ include: ["skills/**", "prompts", "**"] }), "secret");
	});
});

describe("sync.include and sync.exclude", () => {
	it("include widens only unknown paths to config", () => {
		const r = rules({ include: ["memory/**", "npm", "auth.json", "sessions", "trust.json"] });
		assert.equal(classifyPath("memory/notes.md", r), "config");
		assert.equal(classifyPath("npm/x", r), "state");
		assert.equal(classifyPath("trust.json", r), "state");
		assert.equal(classifyPath("auth.json", r), "secret");
		assert.equal(classifyPath("sessions/a.jsonl", r), "sessions");
	});
	it("exclude makes a path state but never reclasses a secret or sessions", () => {
		const r = rules({ exclude: ["skills/big", "auth.json", "sessions"] });
		assert.equal(classifyPath("skills/big/SKILL.md", r), "state");
		assert.equal(classifyPath("skills/other/SKILL.md", r), "config");
		assert.equal(classifyPath("auth.json", r), "secret");
		assert.equal(classifyPath("sessions/a.jsonl", r), "sessions");
	});
	it("an in-profile session directory from settings.json is always sessions", () => {
		assert.equal(classifyPath("store/a.jsonl", rules({ sessionDirs: ["store"], include: ["store/**"] })), "sessions");
		assert.equal(classifyPath("store", rules({ sessionDirs: ["store"], exclude: ["store"] })), "sessions");
		assert.equal(classifyPath("store", NONE), "unknown");
	});
	it("* stays inside one segment and ** spans directories", () => {
		const top = rules({ include: ["memory/*.md"] });
		assert.equal(classifyPath("memory/notes.md", top), "config");
		assert.equal(classifyPath("memory/a/notes.md", top), "unknown");
		const deep = rules({ include: ["docs/**/*.md"] });
		assert.equal(classifyPath("docs/a/b/c.md", deep), "config");
		assert.equal(classifyPath("docs/c.md", deep), "config");
		assert.equal(classifyPath("docs/c.txt", deep), "unknown");
		assert.equal(classifyPath("docs/x.md", rules({ include: ["docs/?.md"] })), "config");
		assert.equal(classifyPath("docs/xy.md", rules({ include: ["docs/?.md"] })), "unknown");
	});
});

describe("profile.json sync key", () => {
	it("accepts include and exclude lists", () => {
		const r = parseManifest({ schemaVersion: 1, name: "p", sync: { include: ["memory/**"], exclude: ["skills/big"] } }, "/x");
		assert.ok(r.ok);
		assert.deepEqual(r.value.sync, { include: ["memory/**"], exclude: ["skills/big"] });
	});
	it("rejects absolute patterns, .., bad shapes and unknown keys", () => {
		const bad: Array<[unknown, RegExp]> = [
			[{ include: ["/etc/passwd"] }, /sync\.include: "\/etc\/passwd" must be relative/],
			[{ exclude: ["a/../b"] }, /sync\.exclude: "a\/\.\.\/b" must not contain \.\./],
			[{ include: [".."] }, /must not contain \.\./],
			[{ include: ["a\\b"] }, /must use \/ as the separator/],
			[{ include: ["a//b"] }, /empty or \. segments/],
			[{ include: [""] }, /non-empty/],
			[{ include: "memory" }, /sync\.include must be a list/],
			[{ include: [3] }, /non-empty string/],
			[{ only: ["x"] }, /sync must be/],
			[["x"], /sync must be/],
		];
		for (const [sync, re] of bad) {
			const r = parseManifest({ schemaVersion: 1, name: "p", sync }, "/x");
			assert.equal(r.ok, false, JSON.stringify(sync));
			if (!r.ok) assert.match(r.errors.join("\n"), re);
		}
	});
	it("edit keeps the sync key", () => {
		const p = createProfile(s.l, "p");
		saveManifest(s.l, "p", { ...p.manifest, sync: { include: ["memory/**"] } });
		assert.equal(cli("edit", "p", "--set", "description=x").code, 0);
		assert.deepEqual(loadProfile(s.l, "p").manifest.sync, { include: ["memory/**"] });
	});
});

function fixture(): string {
	const p = createProfile(s.l, "p");
	mkdirSync(join(p.dir, "skills", "s"), { recursive: true });
	writeFileSync(join(p.dir, "skills", "s", "SKILL.md"), "# skill\n");
	writeFileSync(join(p.dir, "skills", "s", "auth.json"), "TOPSECRETCONTENT");
	// A scanned config file that holds a credential: its value must never be printed.
	writeFileSync(join(p.dir, "skills", "s", "setup.md"), "Use this:\n\nAuthorization: Bearer sk-TOPSECRETCONTENT0123456789\n");
	mkdirSync(join(p.dir, "sessions", "--x--"), { recursive: true });
	writeFileSync(join(p.dir, "sessions", "--x--", "a.jsonl"), "{}\n");
	mkdirSync(join(p.dir, "npm", "lib"), { recursive: true });
	mkdirSync(join(p.dir, "memory", "daily"), { recursive: true });
	writeFileSync(join(p.dir, "memory", "daily", "x.md"), "x");
	writeFileSync(join(p.dir, "notes.txt"), "TOPSECRETCONTENT");
	const outside = join(s.home, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "auth.json"), "{}");
	writeFileSync(join(outside, "SKILL.md"), "x");
	symlinkSync(outside, join(p.dir, "linked"));
	symlinkSync(outside, join(p.dir, "skills", "ext"));
	mkdirSync(join(p.dir, "pi-multi-account"));
	writeFileSync(join(p.dir, "pi-multi-account", "config.json"), "{}");
	writeFileSync(join(p.dir, "pi-multi-account", "usage.ndjson"), "");
	return p.dir;
}

describe("surveyProfile", () => {
	it("walks config dirs, keeps whole-tree classes as one entry, and never follows a link", () => {
		const dir = fixture();
		const got = Object.fromEntries(surveyProfile(dir, NONE).map((e) => [e.path, `${e.cls}${e.dir ? " dir" : ""}${e.link ? " link" : ""}`]));
		assert.deepEqual(got, {
			"auth.json": "secret link",
			linked: "unknown link",
			memory: "unknown dir",
			"notes.txt": "unknown",
			npm: "state dir",
			"pi-multi-account/config.json": "config",
			"pi-multi-account/usage.ndjson": "state",
			"profile.json": "config",
			sessions: "sessions dir",
			"settings.json": "config",
			"skills/ext": "unknown link",
			"skills/s/SKILL.md": "config",
			"skills/s/setup.md": "config",
			"skills/s/auth.json": "secret",
		});
	});
	it("descends into an unknown dir only where an include could match", () => {
		const dir = fixture();
		writeFileSync(join(dir, "memory", "keep.md"), "k");
		const got = surveyProfile(dir, rules({ include: ["memory/keep.md"] })).filter((e) => e.path.startsWith("memory"));
		assert.deepEqual(
			got.map((e) => [e.path, e.cls]),
			[
				["memory/daily", "unknown"],
				["memory/keep.md", "config"],
			],
		);
	});
});

/** mayCarry as written in model/Domain.bend, read from the source so the two cannot drift apart. */
function bendMayCarry(): Map<PathClass, Map<string, boolean>> {
	const enums = JSON.parse(readFileSync("model/enums.json", "utf8")) as { enums: Array<{ name: string; cases: Array<{ ctor: string; key: string }> }> };
	const cases = enums.enums.find((e) => e.name === "PathClass")?.cases ?? [];
	const keyOf = new Map(cases.map((c) => [c.ctor, c.key as PathClass]));
	const text = readFileSync("model/Domain.bend", "utf8");
	const lines = text.slice(text.indexOf("def mayCarry(")).split("\n").slice(1);
	const table = new Map<PathClass, Map<string, boolean>>();
	const channels = ["ConfigSync", "Backup", "AuthTransfer"];
	let cls: PathClass | undefined;
	let channel: string | undefined;
	for (const line of lines) {
		if (line.length > 0 && !line.startsWith(" ")) break;
		const c = /^\s*case N\.(\w+)\{\}:$/.exec(line);
		if (c !== null) {
			cls = keyOf.get(c[1] ?? "");
			assert.ok(cls !== undefined, `unknown PathClass ctor ${c[1]}`);
			table.set(cls, new Map());
			channel = undefined;
			continue;
		}
		const ch = /^\s*case (ConfigSync|Backup|AuthTransfer)\{\w*\}:$/.exec(line);
		if (ch !== null) {
			channel = ch[1];
			continue;
		}
		const v = /^\s*(True|False)\{\}$/.exec(line);
		if (v !== null && cls !== undefined) {
			const row = table.get(cls);
			for (const name of channel === undefined ? channels : [channel]) row?.set(name, v[1] === "True");
		}
	}
	return table;
}

function bendChannel(ch: Channel): string {
	return ch.kind === "configSync" ? "ConfigSync" : ch.kind === "backup" ? "Backup" : "AuthTransfer";
}

describe("mayCarry mirrors model/Domain.bend", () => {
	it("has the PathClass cases of model/enums.json", () => {
		assert.deepEqual([...bendMayCarry().keys()].sort(), [...PATH_CLASSES].sort());
	});
	it("agrees with the model on every class and channel", () => {
		const table = bendMayCarry();
		assert.equal(CHANNELS.length, 2 + REPLICA_KINDS.length);
		for (const cls of PATH_CLASSES) {
			const row = table.get(cls);
			assert.equal(row?.size, 3, `${cls} defines every channel`);
			for (const ch of CHANNELS) assert.equal(mayCarry(cls, ch), row?.get(bendChannel(ch)), `${cls} over ${JSON.stringify(ch)}`);
		}
	});
	it("lets config ride only config sync and secrets only auth transfer", () => {
		assert.equal(mayCarry("secret", { kind: "configSync" }), false);
		assert.equal(mayCarry("state", { kind: "configSync" }), false);
		assert.equal(mayCarry("unknown", { kind: "configSync" }), false);
		assert.equal(mayCarry("config", { kind: "configSync" }), true);
	});
});

describe("credential-looking config values", () => {
	it("names literal credentials, skips env references and commands", () => {
		const value = {
			apiKey: "sk-12345678",
			maxTokens: 5,
			outputReserveTokens: "x",
			nested: [{ token: "abcdefghij" }, { client_secret: "s" }],
			env: { apiKey: "${OPENAI_API_KEY}", password: "$PW", token: "env:TOKEN" },
			cmd: { apiKey: "!op read x" },
			empty: { apiKey: "" },
		};
		assert.deepEqual(credentialKeys(value), ["apiKey", "nested.0.token", "nested.1.client_secret"]);
	});
});

describe("doctor sync checks", () => {
	it("reports unknown paths and credential-looking config, never the value", () => {
		const dir = fixture();
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "sk-live-VALUE" }, y: { apiKey: "${Y_API_KEY}" } } }));
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ exaApiKey: "!pass show exa" }));
		writeFileSync(join(dir, "models-store.json"), JSON.stringify({ apiKey: "state-VALUE" }));
		const found = doctor(s.l).filter((f) => f.profile === "p");
		const text = found.map((f) => `${f.level} ${f.message}`).join("\n");
		assert.match(text, /warn 4 unknown paths stay on this host: linked \(a link: never followed, never config\), memory\/, notes\.txt, skills\/ext \(a link/);
		assert.match(text, /warn models\.json holds a literal API key at providers\.x\.apiKey; sync push leaves it out/);
		assert.match(text, /warn skills\/s\/setup\.md is config but holds a credential-looking value at line 3;/);
		assert.doesNotMatch(text, /VALUE|TOPSECRETCONTENT|web-search|models-store|providers\.y/);
	});
	it("is quiet when every path is classified", () => {
		createProfile(s.l, "p");
		assert.deepEqual(doctor(s.l), []);
	});
});

describe("pi-profile sync status", () => {
	it("counts each class and lists unknown paths and links by name, never contents", () => {
		fixture();
		const r = cli("sync", "status", "p");
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /^config +5 +rides config sync$/m);
		assert.match(r.stdout, /\nconfig sync would skip 1 config file \(locations only, never values\):\n {2}skills\/s\/setup\.md: credential-looking value at line 3\n/);
		assert.match(r.stdout, /^secret +2 +moves only through pi-profile auth$/m);
		assert.match(r.stdout, /^sessions +1 +rides backups$/m);
		assert.match(r.stdout, /^state +2 +stays on this host$/m);
		assert.match(r.stdout, /^unknown +4 +stays on this host until classified$/m);
		assert.match(r.stdout, /\n {2}memory\/\n/);
		assert.match(r.stdout, /\n {2}skills\/ext {2}\(a link: never followed, never config\)\n/);
		assert.match(r.stdout, /\n {2}skills\/ext -> unknown\n/);
		assert.doesNotMatch(r.stdout, /TOPSECRETCONTENT/);
	});
	it("prints JSON with --json", () => {
		fixture();
		const r = cli("sync", "status", "--json", "p");
		assert.equal(r.code, 0, r.stderr);
		const j = JSON.parse(r.stdout) as { profile: string; counts: Record<string, number>; unknown: string[]; links: Array<{ path: string; class: string }>; credentials: unknown };
		assert.equal(j.profile, "p");
		assert.deepEqual(j.counts, { config: 5, state: 2, secret: 2, sessions: 1, unknown: 4 });
		assert.deepEqual(j.unknown, ["linked", "memory/", "notes.txt", "skills/ext"]);
		assert.deepEqual(j.credentials, [{ path: "skills/s/setup.md", at: ["line 3"] }]);
		assert.deepEqual(j.links.map((x) => x.path), ["auth.json", "linked", "skills/ext"]);
		assert.doesNotMatch(r.stdout, /TOPSECRETCONTENT/);
	});
	it("uses the current profile and refuses bad requests", () => {
		assert.equal(cli("sync", "status").code, 0);
		assert.equal(cli("sync", "status", "nope").code, 2);
		assert.equal(cli("sync", "status", "--bogus").code, 2);
		assert.equal(cli("sync", "frob").code, 2);
		assert.equal(cli("sync").code, 2);
		const p = createProfile(s.l, "q");
		writeFileSync(join(p.dir, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "q", sync: { include: ["/abs"] } }));
		const bad = cli("sync", "status", "q");
		assert.equal(bad.code, 2);
		assert.match(bad.stderr, /profile\.json/);
	});
});
