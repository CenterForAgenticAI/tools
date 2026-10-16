import assert from "node:assert/strict";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { doctor } from "../src/core/doctor.ts";
import { parseManifest } from "../src/core/manifest.ts";
import { createProfile } from "../src/core/profiles.ts";
import { classify, classifyPath, credentialKeys, credentialLines, pushable, surveyProfile, type PathClass, type SyncRules } from "../src/core/syncmanifest.ts";
import { compilePattern, covers, patternProblem, segmentMatches } from "../src/core/syncpattern.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Tests for review round 1 of issue 29. Each `describe` names a finding. */

const NONE: SyncRules = { include: [], exclude: [], sessionDirs: [] };
function classes(paths: readonly string[], r: SyncRules = NONE): Record<string, PathClass> {
	return Object.fromEntries(paths.map((p) => [p, classifyPath(p, r)]));
}
function all(paths: readonly string[], cls: PathClass): Record<string, PathClass> {
	return Object.fromEntries(paths.map((p) => [p, cls]));
}

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

describe("CR-29-NESTED-SECRETS", () => {
	it("classes every credential name of the review as secret, under skills/, prompts/ and the root", () => {
		const names = [
			".npmrc",
			"id_rsa",
			"id_ed25519",
			"id_ecdsa_sk.pub",
			"x/.ssh/id_rsa",
			"x/.ssh/known_hosts",
			"cert.p12",
			"client.pfx",
			"credentials",
			"x/.aws/credentials",
			"x/.aws/config",
			"token.json",
			"x/oauth-token.json",
			".git-credentials",
			"x/.config/gh/hosts.yml",
			"cookies.sqlite",
			".docker/config.json",
			".pypirc",
			"x/kubeconfig",
			"x/service-account.json",
			"x/.gnupg/pubring.kbx",
			"auth.json~",
			".auth.json.swp",
			"auth.json.swo",
			"auth.json ",
			"auth.json\u200b",
			"ＡＵＴＨ.json",
			".netrc",
			"x/.env.local",
		];
		const paths = [...names.map((n) => `skills/${n}`), ...names.map((n) => `prompts/${n}`), ...names];
		assert.deepEqual(classes(paths), all(paths, "secret"));
		assert.deepEqual(classes(paths, { ...NONE, include: ["skills/**", "memory"] }), all(paths, "secret"));
	});
	it("a name with a non-ASCII look-alike, format character or padding is unknown, never config", () => {
		const paths = ["skills/\u0430uth.json", "skills/s/SKILL\u200d.md", "skills/s/n\u00e9.md", "prompts/x.md ", "skills/s\u2024/a.md", "settings\u2024json", "prompts/x.md."];
		assert.deepEqual(classes(paths), all(paths, "unknown"));
		assert.equal(classify("skills/\u0430uth.json", NONE).why, "lookalike");
		assert.equal(classifyPath("memory/n\u00e9.md", { ...NONE, include: ["memory"] }), "unknown");
	});
	it("inside skills/ and prompts/ only allowlisted text types are config", () => {
		const ok = ["skills/s/SKILL.md", "skills/s/a.ts", "skills/s/b.mjs", "skills/s/c.json", "skills/s/d.yaml", "skills/s/e.toml", "skills/s/f.sh", "skills/s/g.py", "skills/s/h.svg", "prompts/p.txt"];
		const no = ["skills/s/blob.bin", "skills/s/model.onnx", "skills/s/a.zip", "skills/s/data.sqlite", "skills/s/notes.docx", "skills/s/tool", "prompts/p.pdf"];
		assert.deepEqual(classes(ok), all(ok, "config"));
		assert.deepEqual(classes(no), all(no, "unknown"));
		assert.deepEqual(classes(no, { ...NONE, include: ["skills", "prompts"] }), all(no, "unknown"));
		assert.equal(classify("skills/s/blob.bin", NONE).why, "filetype");
		assert.equal(classifyPath("skills/s/blob.bin", NONE, true), "config", "a directory is walked, not typed");
	});
	it("ordinary names stay config", () => {
		// `tokens.md` was here until issue 36 made `tokens?` a secret name with any suffix.
		const paths = ["skills/s/references/tokenizer.md", "skills/s/references/token-budget.md", "skills/key-points.md", "prompts/review.md", "settings.json", "models.json"];
		assert.deepEqual(classes(paths), all(paths, "config"));
	});
});

function profileDir(): string {
	return createProfile(s.l, "p").dir;
}

describe("CR-29-LINK-AS-CONFIG", () => {
	it("a link with a config name is unknown, and a link with a secret name stays secret", () => {
		const dir = profileDir();
		const outside = join(s.home, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "auth.json"), "{}");
		mkdirSync(join(dir, "skills"));
		symlinkSync(join(outside, "auth.json"), join(dir, "models.json"));
		symlinkSync(outside, join(dir, "skills", "ext"));
		symlinkSync(outside, join(dir, "prompts"));
		symlinkSync(join(outside, "auth.json"), join(dir, "skills", "auth.json"));
		const got = Object.fromEntries(surveyProfile(dir, NONE).filter((e) => e.link).map((e) => [e.path, `${e.cls} ${e.why ?? "-"}`]));
		assert.deepEqual(got, { "auth.json": "secret -", "models.json": "unknown link", prompts: "unknown link", "skills/auth.json": "secret -", "skills/ext": "unknown link" });
	});
	it("a config file with more than one hard link is unknown, with the reason", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "models.json"), "{}");
		linkSync(join(dir, "models.json"), join(s.home, "elsewhere.json"));
		const e = surveyProfile(dir, NONE).find((x) => x.path === "models.json");
		assert.deepEqual(e, { path: "models.json", cls: "unknown", dir: false, link: false, why: "hardlink" });
		const r = cli("sync", "status", "p");
		assert.match(r.stdout, /\n {2}models\.json {2}\(a hard link: another name shares its contents\)\n/);
	});
});

describe("CR-29-CRED-SCAN-MISSES", () => {
	it("finds every credential shape and key of the review", () => {
		const v = {
			headers: { Authorization: "Bearer abc123" },
			key: "plain",
			apiKeys: ["one"],
			token: { value: "x" },
			auth: { bearer: "b" },
			secretKey: "k",
			Token: 123,
			url: "https://u:p@h.example",
			note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			password: "HUNTER",
			client_secret: "ABC_DEF",
			cookies: ["c"],
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			openai: { type: "api_key", key: "k" },
			shapes: ["sk-abcdefghijklmnop1234", "xoxb-1234567890-abc", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "github_pat_abcdefghij0123456789xyz"], // gitleaks:allow
		};
		assert.deepEqual(credentialKeys(v), [
			"headers.Authorization",
			"key",
			"apiKeys.0",
			"token.*",
			"auth.bearer",
			"secretKey",
			"Token",
			"url",
			"note",
			"password",
			"client_secret",
			"cookies.0",
			"anthropic.access",
			"anthropic.refresh",
			"openai.key",
			"shapes.0",
			"shapes.1",
			"shapes.2",
			"shapes.3",
			"shapes.4",
		]);
	});
	it("exempts only ${VAR}, $VAR, env:VAR and !command references, and quantities", () => {
		const v = { a: { apiKey: "${OPENAI_API_KEY}" }, b: { apiKey: "$OPENAI_API_KEY" }, c: { apiKey: "env:OPENAI_API_KEY" }, d: { apiKey: "!op read x" }, e: { apiKey: "" }, maxTokens: 5, keepRecentTokens: 9, tokenizer: "x", docs: "Bearer token" };
		assert.deepEqual(credentialKeys(v), []);
		assert.deepEqual(credentialKeys({ apiKey: "OPENAI_API_KEY" }), ["apiKey"], "a bare all-caps name is a literal");
	});
	it("scans text config line by line, by shape everywhere and by key in settings files", () => {
		assert.deepEqual(credentialLines("# x\nAuthorization: Bearer sk-abcdefghijklmnopq\ncurl https://u:pw@h/x\nBearer $TOKEN\n", "skills/s/a.md"), ["line 2", "line 3"]);
		assert.deepEqual(credentialLines("password: hunter2\ntoken: ${T}\nmaxTokens: 5\napi_key = 'abc'\nexport GH_TOKEN=xyz\nkeys: []\n", "skills/s/c.yaml"), ["line 1", "line 4", "line 5"]);
		assert.deepEqual(credentialLines("password: hunter2\n", "skills/s/a.md"), ["line 1"], "prose is checked by key too (CR-29-R2-KEYED-CODE)");
	});
	it("sync status and --json report locations of a secret in yaml, never the value", () => {
		const dir = profileDir();
		mkdirSync(join(dir, "skills", "s"), { recursive: true });
		writeFileSync(join(dir, "skills", "s", "c.yaml"), "name: s\npassword: TOPSECRETVALUE\n");
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "TOPSECRETVALUE" } } }));
		const text = cli("sync", "status", "p").stdout;
		const json = cli("sync", "status", "--json", "p").stdout;
		const doc = doctor(s.l).map((f) => f.message).join("\n");
		assert.match(text, /\n {2}models\.json: credential-looking value at providers\.x\.apiKey\n {2}skills\/s\/c\.yaml: credential-looking value at line 2\n/);
		assert.deepEqual((JSON.parse(json) as { credentials: unknown }).credentials, [
			{ path: "models.json", at: ["providers.x.apiKey"] },
			{ path: "skills/s/c.yaml", at: ["line 2"] },
		]);
		assert.match(doc, /skills\/s\/c\.yaml is config but holds a credential-looking value at line 2/);
		for (const out of [text, json, doc]) assert.doesNotMatch(out, /TOPSECRETVALUE/);
	});
});

describe("CR-29-INCLUDE-WIDE", () => {
	it("refuses an include pattern with a wildcard in its first segment", () => {
		for (const p of ["**", "*", "*.json", "?emory/x", "m*/x"]) {
			assert.match(patternProblem(p, "include") ?? "", /literal name/, p);
			const r = parseManifest({ schemaVersion: 1, name: "p", sync: { include: [p] } }, "/x");
			assert.equal(r.ok, false, p);
		}
		assert.equal(patternProblem("*.log", "exclude"), undefined, "exclude may start with a wildcard");
		assert.equal(patternProblem("memory/**", "include"), undefined);
	});
	it("* ? and ** do not match a leading dot", () => {
		assert.equal(segmentMatches("*", ".npmrc"), false);
		assert.equal(segmentMatches("?npmrc", ".npmrc"), false);
		assert.equal(segmentMatches(".*", ".npmrc"), true);
		assert.equal(covers(compilePattern("memory/**/x.md"), ["memory", ".hidden", "x.md"]), false);
		assert.equal(classifyPath("memory/.trash", { ...NONE, include: ["memory/*"] }), "unknown");
		assert.equal(classifyPath("memory/notes.md", { ...NONE, include: ["memory/*"] }), "config");
	});
});

describe("CR-29-GLOB-REDOS", () => {
	function ms(f: () => void): number {
		const t = performance.now();
		f();
		return performance.now() - t;
	}
	it("matches a 255-character name against many stars in under 50 ms", () => {
		const name = `${"a".repeat(254)}b`;
		const pat = `${"*a".repeat(40)}*c`;
		let got = true;
		assert.ok(ms(() => (got = segmentMatches(pat, name))) < 50);
		assert.equal(got, false);
		assert.equal(segmentMatches(`${"*a".repeat(40)}*b`, name), true);
	});
	it("matches a deep path against many ** in under 50 ms", () => {
		const segs = Array.from({ length: 60 }, () => "a");
		const p = compilePattern(`m/${"**/a*/".repeat(20)}z`);
		let got = true;
		assert.ok(ms(() => (got = covers(p, ["m", ...segs]))) < 50);
		assert.equal(got, false);
		assert.equal(covers(compilePattern("m/**/**/**/a"), ["m", "x", "y", "a"]), true);
		assert.deepEqual(compilePattern("m/**/**/**/a"), ["m", "**", "a"]);
	});
});

function cli(...argv: string[]): ReturnType<typeof captureIo> & { code: number } {
	const io = captureIo({ PI_PROFILE_HOME: s.home, SHELL: "/bin/bash" });
	const code = main(argv, io);
	return Object.assign(io, { code });
}

describe("CR-29-RAW-NAMES", () => {
	it("doctor prints unknown paths and key paths through printable()", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "evil\u001b[31m.txt"), "");
		writeFileSync(join(dir, "models.json"), JSON.stringify({ "\u001b]0;x\u0007apiKey": "v" }));
		const text = doctor(s.l).map((f) => f.message).join("\n");
		assert.match(text, /evil\?\[31m\.txt/);
		assert.match(text, /at \?\]0;x\?apiKey;/);
		assert.ok(!text.includes("\u001b") && !text.includes("\u0007"), "no raw escape or bell reaches the terminal");
	});
});

describe("pushable (the gate #31 calls)", () => {
	function setup(): string {
		const dir = profileDir();
		mkdirSync(join(dir, "skills", "s"), { recursive: true });
		writeFileSync(join(dir, "skills", "s", "SKILL.md"), "# s\n");
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "${X}" } } }));
		return dir;
	}
	it("allows a clean regular config file with one name", () => {
		const dir = setup();
		assert.deepEqual(pushable(dir, "skills/s/SKILL.md", NONE), { ok: true });
		assert.deepEqual(pushable(dir, "models.json", NONE), { ok: true });
		assert.deepEqual(pushable(dir, "profile.json", NONE), { ok: true });
	});
	it("refuses a non-config class, with the reason", () => {
		const dir = setup();
		writeFileSync(join(dir, "skills", "s", "blob.bin"), "x");
		assert.deepEqual(pushable(dir, "auth.json", NONE), { ok: false, reason: "auth.json: class secret" });
		assert.deepEqual(pushable(dir, "skills/s/blob.bin", NONE), { ok: false, reason: "skills/s/blob.bin: class unknown: not an allowlisted file type in skills/ or prompts/" });
		assert.deepEqual(pushable(dir, "../x", NONE), { ok: false, reason: "../x: not a plain relative path" });
		assert.deepEqual(pushable(dir, "settings.json", NONE).ok, true);
		assert.match((pushable(dir, "missing.json", NONE) as { reason: string }).reason, /cannot be read \(ENOENT\)/);
	});
	it("refuses a link, a file under a linked directory, a hard link and a directory", () => {
		const dir = setup();
		const outside = join(s.home, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "x.md"), "x");
		symlinkSync(join(outside, "x.md"), join(dir, "AGENTS.md"));
		symlinkSync(outside, join(dir, "prompts"));
		linkSync(join(dir, "models.json"), join(s.home, "copy.json"));
		assert.deepEqual(pushable(dir, "AGENTS.md", NONE), { ok: false, reason: "AGENTS.md: class unknown: a link: never followed, never config" });
		assert.deepEqual(pushable(dir, "prompts/x.md", NONE), { ok: false, reason: "prompts/x.md: prompts is not a directory (a link is never followed)" });
		assert.deepEqual(pushable(dir, "models.json", NONE), { ok: false, reason: "models.json: class unknown: a hard link: another name shares its contents" });
		assert.deepEqual(pushable(dir, "skills/s", NONE), { ok: false, reason: "skills/s: not a regular file" });
	});
	it("refuses a config file with a credential-looking value, naming where but never the value", () => {
		const dir = setup();
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ exaApiKey: "TOPSECRETVALUE" }));
		writeFileSync(join(dir, "skills", "s", "notes.md"), "curl -H 'Authorization: Bearer TOPSECRET-VALUE1'\n"); // gitleaks:allow
		assert.deepEqual(pushable(dir, "web-search.json", NONE), { ok: false, reason: "web-search.json: credential-looking value at exaApiKey" });
		assert.deepEqual(pushable(dir, "skills/s/notes.md", NONE), { ok: false, reason: "skills/s/notes.md: credential-looking value at line 1" });
	});
	it("honours include for an unknown path", () => {
		const dir = setup();
		mkdirSync(join(dir, "memory"));
		writeFileSync(join(dir, "memory", "n.md"), "n");
		assert.equal(pushable(dir, "memory/n.md", NONE).ok, false);
		assert.deepEqual(pushable(dir, "memory/n.md", { ...NONE, include: ["memory"] }), { ok: true });
	});
});
