import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { doctor } from "../src/core/doctor.ts";
import { parseManifest } from "../src/core/manifest.ts";
import { createProfile } from "../src/core/profiles.ts";
import {
	allowDigest,
	allowEntries,
	classifyPath,
	CREDENTIAL_SHAPES,
	credentialLineHits,
	credentialLines,
	LINE_PATTERNS,
	profileSyncRules,
	pushable,
	pushPlan,
	scanConfigFile,
	syncStatus,
	type SyncRules,
} from "../src/core/syncmanifest.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Tests for issue 36, the follow-ups of the review of issue 35. Each `describe` names a finding. */

const NONE: SyncRules = { include: [], exclude: [], sessionDirs: [] };
const SECRET = "abcd1234efgh"; // gitleaks:allow

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

function profileDir(): string {
	const dir = createProfile(s.l, "p").dir;
	mkdirSync(join(dir, "skills", "s"), { recursive: true });
	return dir;
}

const SALT = "0123456789abcdef0123456789abcdef";
/** The allow entry for `key` on line `line` of `path`, whose text is `text`. */
function allowFor(path: string, line: number, key: string, text: string): { path: string; line: number; key: string; salt: string; scrypt: string } {
	return { path, line, key, salt: SALT, scrypt: allowDigest(path, key, text, SALT) };
}

/** Write profile.json for profile `p` with this `sync` setting. */
function setSync(dir: string, sync: unknown): void {
	writeFileSync(join(dir, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "p", sync }));
}

/** `[file, text]` pairs that must be flagged. */
function flagged(cases: ReadonlyArray<readonly [string, string]>): string[] {
	return cases.filter(([rel, text]) => credentialLines(text, rel).length === 0).map(([rel, text]) => `${rel}: ${text}`);
}
/** `[file, text]` pairs that must not be flagged. */
function clean(cases: ReadonlyArray<readonly [string, string]>): string[] {
	return cases.filter(([rel, text]) => credentialLines(text, rel).length > 0).map(([rel, text]) => `${rel}: ${text}`);
}

function cli(...args: string[]): ReturnType<typeof captureIo> & { code: number } {
	const io = captureIo({ PI_PROFILE_HOME: s.home, SHELL: "/bin/bash" });
	const code = main(args, io);
	return Object.assign(io, { code });
}

/** Lines of about 100 KB built to make a backtracking pattern try each start position. */
const N = 100_000;
const HOSTILE: Readonly<Record<string, string>> = {
	letters: "a".repeat(N),
	digits: "7".repeat(N),
	spaces: " ".repeat(N),
	scheme: `a${"+".repeat(N)}`,
	"scheme-colon": "a:".repeat(N / 2),
	"scheme-slashes": "a://".repeat(N / 4),
	userinfo: `https://${"a:".repeat(N / 2)}`,
	"key-colon": "k: ".repeat(N / 3),
	"key-equals": "k=".repeat(N / 2),
	"credential-keys": "db_pass: x ".repeat(N / 11),
	quotes: 'k: "'.repeat(N / 4),
	triple: 'k = """'.repeat(N / 7),
	basic: "Basic ".repeat(N / 6),
	"basic-long": `Basic ${"QUJD".repeat(N / 4)}`,
	bearer: "Bearer ".repeat(N / 7),
	jwt: `eyJ${"a.".repeat(N / 2)}`,
	sk: "sk-".repeat(N / 3),
	dots: "a.".repeat(N / 2),
	dollars: "${".repeat(N / 2),
	brackets: "<".repeat(N),
	dashes: "-".repeat(N),
	pem: "-----BEGIN ".repeat(N / 11),
	underscores: "a_".repeat(N / 2),
	"keyed-words": `${"a_".repeat(N / 2)}: x`,
	"keyed-camel": `${"aB".repeat(N / 2)}: x`,
	"keyed-kebab": `${"a-".repeat(N / 2)}a = x`,
};

const BOUND_MS = 100;

/** Milliseconds `f` takes, best of two runs (the first also warms up). */
function ms(f: () => void): number {
	let best = Infinity;
	for (let k = 0; k < 2; k++) {
		const t = performance.now();
		f();
		best = Math.min(best, performance.now() - t);
	}
	return best;
}

/** Run `re` over `text` as the scanner does: every match of a global pattern, one test of any other. */
function exercise(re: RegExp, text: string): void {
	if (re.global) {
		for (const _m of text.matchAll(re)) {
			// Drain every match.
		}
	} else {
		re.lastIndex = 0;
		re.test(text);
	}
}

describe("CR-35-URL-REDOS", () => {
	it("the URL userinfo pattern takes linear time on a 100 KB line, and still matches", () => {
		const url = CREDENTIAL_SHAPES.find((x) => x.name === "url-userinfo");
		assert.ok(url);
		const t = ms(() => url.re.test("a".repeat(N)));
		assert.ok(t < BOUND_MS, `url-userinfo took ${t.toFixed(1)} ms on 100 KB of letters`);
		assert.equal(url.re.test("see https://bob:hunter2x@example.com"), true);
		assert.equal(url.re.test("git+https://bob:hunter2x@example.com"), true);
	});
	it("every line pattern runs in under 100 ms on every 100 KB hostile line", () => {
		const patterns: Array<[string, RegExp]> = [...CREDENTIAL_SHAPES.map((x): [string, RegExp] => [`shape ${x.name}`, x.re]), ...Object.entries(LINE_PATTERNS)];
		assert.ok(patterns.length >= 25, "every pattern is listed");
		const slow: string[] = [];
		for (const [name, re] of patterns)
			for (const [input, text] of Object.entries(HOSTILE)) {
				const t = ms(() => exercise(re, text));
				if (t >= BOUND_MS) slow.push(`${name} on ${input}: ${t.toFixed(0)} ms`);
			}
		assert.deepEqual(slow, []);
	});
	it("the whole line scan takes under 100 ms on every 100 KB hostile line, in code, settings and prose", () => {
		const slow: string[] = [];
		for (const rel of ["skills/s/f.ts", "skills/s/f.yaml", "skills/s/f.md"])
			for (const [input, text] of Object.entries(HOSTILE)) {
				const t = ms(() => credentialLineHits(text, rel));
				if (t >= BOUND_MS) slow.push(`${rel} on ${input}: ${t.toFixed(0)} ms`);
			}
		assert.deepEqual(slow, []);
	});
});

describe("CR-35-SECRET-STEMS", () => {
	it("classes credential file stems with any suffix, and token, password and API key files, as secret", () => {
		const names = ["netrc.conf", "pgpass.conf", "htpasswd.conf", "npmrc.txt", ".pypirc.bak2", "s3cfg.ini", "_netrc", "token.txt", "tokens.md", "password.txt", "passwords", "api-key.md", "api_keys.json", "apikey"];
		const paths = names.map((n) => `skills/s/${n}`);
		assert.deepEqual(
			paths.filter((p) => classifyPath(p, NONE) !== "secret"),
			[],
		);
	});
	it("pushable refuses the review's repros by class", () => {
		const dir = profileDir();
		for (const n of ["netrc.conf", "pgpass.conf", "token.txt", "password.txt"]) writeFileSync(join(dir, "skills", "s", n), "hunter2x\n");
		assert.deepEqual(pushable(dir, "skills/s/netrc.conf", NONE), { ok: false, reason: "skills/s/netrc.conf: class secret" });
		assert.deepEqual(pushable(dir, "skills/s/token.txt", NONE), { ok: false, reason: "skills/s/token.txt: class secret" });
	});
	it("keeps names that only start like a stem config", () => {
		const paths = ["skills/s/tokenizer.md", "skills/s/token-budget.md", "skills/s/password-policy.md", "skills/s/passwordless.md", "skills/s/netrcs.md", "skills/s/keys.md"];
		assert.deepEqual(
			paths.filter((p) => classifyPath(p, NONE) !== "config"),
			[],
		);
	});
});

describe("CR-35-KEY-WORDS", () => {
	it("flags pass and pwd as a last word, PASSWORD at the end of a capital word, and a quoted key-like value under …Key", () => {
		assert.deepEqual(
			flagged([
				["skills/s/k.conf", "PGPASSWORD=hunter2x"],
				["skills/s/k.sh", "DB_PASS=hunter2x"],
				["skills/s/k.sh", "export MYSQL_PWD=hunter2x"],
				["skills/s/k.yaml", "db_pass: hunter2x"],
				["skills/s/k.yaml", "redis_auth: hunter2x"],
				["skills/s/k.md", "export PGPASSWORD=hunter2x"],
				["skills/s/k.ts", `const openaiKey = "${SECRET}";`],
				["skills/s/k.py", `openai_key = '${SECRET}'`],
				["skills/s/k.md", `openai_key: ${SECRET}`],
			]),
			[],
		);
		assert.deepEqual(scanConfigFile("/nonexistent", "x.json"), { ok: false, reason: "cannot be read (ENOENT)" });
	});
	it("keeps names, flags and map keys under these words clean", () => {
		assert.deepEqual(
			clean([
				["skills/s/k.yaml", "second_pass: true"],
				["skills/s/k.yaml", "use_auth: required"],
				["skills/s/k.yaml", "bypass: hunter2x"],
				["skills/s/k.sh", "OLDPWD=/home/x"],
				["skills/s/k.ts", 'const sortKey = "name";'],
				["skills/s/k.ts", 'const cacheKey = "user-123";'],
				["skills/s/k.ts", 'const primaryKey = "session-main-12345";'],
				["skills/s/k.ts", "const openaiKey = readKey();"],
				["skills/s/k.md", "sortKey: name"],
			]),
			[],
		);
	});
});

describe("CR-35-SPACED-VALUES", () => {
	it("flags quoted Basic and Bearer values, and quoted passwords with spaces", () => {
		assert.deepEqual(
			flagged([
				["skills/s/k.ts", 'headers: { Authorization: "Basic dXNlcjpwYXNz" }'],
				["skills/s/k.py", '{"Authorization": "Bearer abcdefghijklmnop"}'],
				["skills/s/k.md", 'password: "correct horse battery"'],
				["skills/s/k.ts", 'const password = "correct horse battery";'],
				["skills/s/k.ts", "opts.passphrase = 'staple battery horse';"],
				["skills/s/k.md", "curl -H 'Authorization: Basic dXNlcjpwYXNz' x"], // gitleaks:allow
			]),
			[],
		);
	});
	it("the Basic shape is a hard shape anywhere, but not the word Basic", () => {
		assert.deepEqual(credentialLineHits("see Basic dXNlcjpwYXNz in the log", "skills/s/k.md"), [{ line: 1, key: "basic", shape: true }]);
		assert.deepEqual(
			clean([
				["skills/s/k.md", "Use HTTP Basic authentication"],
				["skills/s/k.md", "Authentication: Basic Authentication"],
				["skills/s/k.md", 'password: "Enter your password here"'],
				["skills/s/k.ts", 'const token = "two words";'],
			]),
			[],
		);
	});
});

describe("CR-35-MULTILINE", () => {
	it("checks the next non-empty line after a YAML block marker or an opening triple quote, and reports that line", () => {
		assert.deepEqual(credentialLines("a: 1\npassword: |\n  hunter2x\n", "skills/s/k.yaml"), ["line 3"]);
		assert.deepEqual(credentialLines("password: >-\n\n  hunter2x\n", "skills/s/k.yaml"), ["line 3"]);
		assert.deepEqual(credentialLines("password: |+2 # note\n  hunter2x\n", "skills/s/k.md"), ["line 2"]);
		assert.deepEqual(credentialLines('PASSWORD = """\nhunter2x\n"""\n', "skills/s/k.py"), ["line 2"]);
		assert.deepEqual(credentialLines('password = """\nhunter2x"""\n', "skills/s/k.toml"), ["line 2"]);
		assert.deepEqual(credentialLines("token = '''hunter2x'''\n", "skills/s/k.py"), ["line 1"]);
	});
	it("keeps block text under other keys, and placeholders in blocks, clean", () => {
		assert.deepEqual(credentialLines("description: |\n  hunter2x\n", "skills/s/k.yaml"), []);
		assert.deepEqual(credentialLines("password: |\n  ${PW}\n", "skills/s/k.yaml"), []);
		assert.deepEqual(credentialLines('token = """\nxxxx\n"""\n', "skills/s/k.py"), []);
		assert.deepEqual(credentialLines("password: |\n", "skills/s/k.yaml"), []);
	});
});

describe("CR-35-JSON-KEYS", () => {
	it("runs the shape checks over the raw text of JSON that parses, in key names too", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), '{\n  "a": 1,\n  "sk-A1b2C3d4E5f6G7h8I9": 1\n}\n');
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: ["line 3"] });
		assert.deepEqual(pushable(dir, "skills/s/k.json", NONE), { ok: false, reason: "skills/s/k.json: credential-looking value at line 3" });
	});
	it("reports a shaped value once, by key path", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), '{\n  "x": { "apiKey": "sk-A1b2C3d4E5f6G7h8I9" }\n}\n'); // gitleaks:allow
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: ["x.apiKey"] });
	});
});

describe("hardlink reason (test gap of #35)", () => {
	it("a script with a second name is refused because it is a hard link", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "run"), "#!/bin/sh\necho hi\n");
		linkSync(join(dir, "skills", "s", "run"), join(s.home, "run2"));
		assert.deepEqual(pushable(dir, "skills/s/run", NONE), { ok: false, reason: "skills/s/run: class unknown: a hard link: another name shares its contents" });
	});
});

describe("known limits (expected misses, documented in .spec/design.md)", () => {
	const missed = (rel: string, text: string): void => assert.deepEqual(credentialLines(text, rel), [], "an expected miss: if the scan now finds this, move the case to a flagged test");
	it("known limit: a space as the separator, as in `password hunter2x`", () => {
		missed("skills/s/k.conf", "password hunter2x");
		missed("skills/s/k.md", "machine h login bob password hunter2x");
	});
	it("known limit: an XML element such as `<password>…</password>`", () => {
		missed("skills/s/k.xml", "<password>hunter2x</password>");
	});
	it("known limit: `curl -u user:password`", () => { // gitleaks:allow
		missed("skills/s/k.md", "curl -u admin:hunter2x https://example.com");
	});
	it("known limit: CSV fields", () => {
		missed("skills/s/k.csv", "user,password\nadmin,hunter2abc");
	});
	it("known limit: Markdown table rows", () => {
		missed("skills/s/k.md", "| user | password |\n|---|---|\n| admin | hunter2abc |");
	});
	it("known limit: inline-code spans", () => {
		missed("skills/s/k.md", `Set \`apiKey: ${SECRET}\` in the file.`);
	});
	it("known limit: a password of 6 to 9 characters with no digit, outside settings files", () => {
		missed("skills/s/k.md", "password: hunterx");
		missed("skills/s/k.ts", 'const password = "hunterxyz";');
	});
	it("known limit: prose after a value, as in `password: hunter2 for prod`", () => {
		missed("skills/s/k.md", "password: hunter2 for prod");
	});
});

describe("CR-35-FP-POLICY: placeholders", () => {
	it("a value of one repeated character is a placeholder: a nil UUID, xxxx, 0000", () => {
		assert.deepEqual(
			clean([
				["skills/s/k.ts", 'const token = "00000000-0000-0000-0000-000000000000";'],
				["skills/s/k.ts", 'token: "00000000-0000-4000-8000-000000000000",'],
				["skills/s/k.yaml", "password: 0000"],
				["skills/s/k.yaml", "password: xxxx"],
				["skills/s/k.yaml", "api_key: ••••••••"],
				["skills/s/k.ts", 'const sessionId = "zzzzzzzzzzzz";'],
			]),
			[],
		);
		const dir = profileDir();
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "0000000000" }, y: { apiKey: "ab" } } }));
		assert.deepEqual(scanConfigFile(join(dir, "models.json"), "models.json"), { ok: true, at: ["providers.y.apiKey"] });
	});
	it("a value with two different characters is not a placeholder", () => {
		assert.deepEqual(
			flagged([
				["skills/s/k.ts", 'const token = "00000000-0000-0000-0000-000000000001";'],
				["skills/s/k.yaml", "password: 0001"],
			]),
			[],
		);
	});
	it("never downgrades a finding because of its path", () => {
		const dir = profileDir();
		const paths = ["skills/s/k.ts", "skills/s/fixtures/k.ts", "skills/s/tests/k.ts", "skills/s/test/fixtures/k.ts", "skills/s/examples/k.ts"];
		for (const p of paths) {
			mkdirSync(join(dir, ...p.split("/").slice(0, -1)), { recursive: true });
			writeFileSync(join(dir, ...p.split("/")), `const token = "${SECRET}";\n`);
		}
		assert.deepEqual(
			paths.map((p) => pushable(dir, p, NONE)),
			paths.map((p) => ({ ok: false, reason: `${p}: credential-looking value at line 1` })),
		);
	});
});

describe("CR-35-FP-POLICY: pushPlan", () => {
	it("skips each refused file with its reason and findings, and keeps the others", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "SKILL.md"), "# s\n");
		writeFileSync(join(dir, "skills", "s", "a.ts"), `// a\nconst token = "${SECRET}";\n`);
		writeFileSync(join(dir, "skills", "s", "b.md"), "sk-A1b2C3d4E5f6G7h8I9\n");
		writeFileSync(join(dir, "skills", "s", "big.md"), "x".repeat(1024 * 1024 + 1));
		const plan = pushPlan(dir, profileSyncRules(s.l, "p", true).rules);
		assert.deepEqual(plan.push, ["profile.json", "settings.json", "skills/s/SKILL.md"]);
		assert.deepEqual(plan.skipped, [
			{ path: "skills/s/a.ts", reason: "credential-looking value at line 2", findings: [{ line: 2, key: "token", at: "line 2", shape: false }] },
			{ path: "skills/s/b.md", reason: "credential-looking value at line 1", findings: [{ line: 1, key: "sk", at: "line 1", shape: true }] },
			{ path: "skills/s/big.md", reason: "larger than 1 MiB, not scanned", findings: [] },
		]);
		assert.doesNotMatch(JSON.stringify(plan), new RegExp(`${SECRET}|A1b2C3`), "findings hold locations only");
	});
	it("agrees with pushable for every config file", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "a.ts"), `const token = "${SECRET}";\n`);
		writeFileSync(join(dir, "skills", "s", "b.ts"), "const x = 1;\n");
		const plan = pushPlan(dir, NONE);
		for (const p of plan.push) assert.deepEqual(pushable(dir, p, NONE), { ok: true });
		for (const k of plan.skipped) assert.deepEqual(pushable(dir, k.path, NONE), { ok: false, reason: `${k.path}: ${k.reason}` });
	});
});

describe("CR-35-FP-POLICY: sync.allowFindings validation", () => {
	const sha = "a".repeat(64);
	const salt = "b".repeat(32);
	const parse = (allowFindings: unknown): string[] => {
		const r = parseManifest({ schemaVersion: 1, name: "p", sync: { allowFindings } }, "/x");
		return r.ok ? [] : [...r.errors];
	};
	it("accepts a well-formed entry", () => {
		const r = parseManifest({ schemaVersion: 1, name: "p", sync: { allowFindings: [{ path: "skills/s/k.ts", line: 3, key: "token", salt, scrypt: sha }] } }, "/x");
		assert.deepEqual(r.ok ? r.value.sync : r.errors, { allowFindings: [{ path: "skills/s/k.ts", line: 3, key: "token", salt, scrypt: sha }] });
	});
	it("refuses a path that is not relative and normalised, or is a glob", () => {
		for (const path of ["/etc/x", "../x", "a/../x", "./x", "a//x", "a/", "a\\x", "C:/x", "skills/*", "skills/**/k.ts", "k?.ts", "", "a\nb"])
			assert.match(parse([{ path, line: 1, key: "k", salt, scrypt: sha }]).join("\n"), /sync\.allowFindings\[0\]\.path /, JSON.stringify(path));
	});
	it("refuses a line that is not a positive integer, an empty key, a bad hash, a missing or unknown field", () => {
		const good = { path: "k.ts", line: 1, key: "k", salt, scrypt: sha };
		for (const line of [0, -1, 1.5, "1", null, Number.NaN, 2 ** 60]) assert.match(parse([{ ...good, line }]).join(), /\.line must be a positive integer/, String(line));
		for (const key of ["", " ", 1, "a b"]) assert.match(parse([{ ...good, key }]).join(), /\.key must be/, JSON.stringify(key));
		for (const scrypt of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), 1]) assert.match(parse([{ ...good, scrypt }]).join(), /\.scrypt must be 64 lower-case hex characters/, String(scrypt));
		for (const bad of ["B".repeat(32), "b".repeat(31), "b".repeat(33), 1]) assert.match(parse([{ ...good, salt: bad }]).join(), /\.salt must be 32 lower-case hex characters/, String(bad));
		assert.match(parse([{ path: "k.ts", line: 1, key: "k" }]).join(), /\.salt must be[^]*\.scrypt must be/);
		assert.match(parse([{ ...good, glob: true }]).join(), /unknown key: glob/);
		assert.match(parse("x").join(), /must be a list/);
		assert.match(parse(["x"]).join(), /allowFindings\[0\] must be/);
	});
});

describe("CR-35-FP-POLICY: allowing a finding", () => {
	const KEY_LINE = `const token = "${SECRET}";`;
	function setup(): string {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.ts"), `// k\n${KEY_LINE}\n`);
		return dir;
	}
	const entry = allowFor("skills/s/k.ts", 2, "token", KEY_LINE);
	it("allows a finding only while path, line, key and the hash of that line all match", () => {
		const dir = setup();
		const rules = (allowFindings: unknown[]): SyncRules => {
			setSync(dir, { allowFindings });
			return profileSyncRules(s.l, "p", true).rules;
		};
		assert.deepEqual(pushable(dir, "skills/s/k.ts", rules([entry])), { ok: true });
		for (const wrong of [{ ...entry, line: 1 }, { ...entry, key: "apiKey" }, { ...entry, path: "skills/s/j.ts" }, { ...entry, scrypt: allowDigest(entry.path, entry.key, `${KEY_LINE} `, SALT) }, { ...entry, salt: "f".repeat(32) }])
			assert.equal(pushable(dir, "skills/s/k.ts", rules([wrong])).ok, false, JSON.stringify(wrong));
	});
	it("any edit to the line flags it again", () => {
		const dir = setup();
		setSync(dir, { allowFindings: [entry] });
		const rules = profileSyncRules(s.l, "p", true).rules;
		assert.deepEqual(pushable(dir, "skills/s/k.ts", rules), { ok: true });
		writeFileSync(join(dir, "skills", "s", "k.ts"), `// k\n${KEY_LINE.replace("abcd", "abce")}\n`);
		assert.deepEqual(pushable(dir, "skills/s/k.ts", rules), { ok: false, reason: "skills/s/k.ts: credential-looking value at line 2" });
		writeFileSync(join(dir, "skills", "s", "k.ts"), `// k\n\n${KEY_LINE}\n`);
		assert.deepEqual(pushable(dir, "skills/s/k.ts", rules), { ok: false, reason: "skills/s/k.ts: credential-looking value at line 3" }, "moving the line flags it");
	});
	it("one entry allows one finding: another finding in the file still refuses it", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.ts"), `// k\n${KEY_LINE}\n${KEY_LINE}\n`);
		setSync(dir, { allowFindings: [entry] });
		assert.deepEqual(pushable(dir, "skills/s/k.ts", profileSyncRules(s.l, "p", true).rules), { ok: false, reason: "skills/s/k.ts: credential-looking value at line 3" });
	});
	it("a shape hit can never be allowed, and sync status and doctor report the entry as ignored", () => {
		const dir = profileDir();
		const shapes = ["sk-A1b2C3d4E5f6G7h8I9", "ghp_A1b2C3d4E5f6G7h8I9j0", "github_pat_A1b2C3d4E5f6G7h8I9j0", "xoxb-1234567890ab", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "-----BEGIN RSA PRIVATE KEY-----", "https://bob:hunter2x@example.com", "Basic dXNlcjpwYXNz"]; // gitleaks:allow
		const lines = shapes.map((x) => `token = "${x}"`);
		writeFileSync(join(dir, "skills", "s", "k.md"), `${lines.join("\n")}\n`);
		const hits = credentialLineHits(lines.join("\n"), "skills/s/k.md");
		assert.deepEqual(
			lines.map((_l, i) => hits.some((h) => h.line === i + 1 && h.shape)),
			shapes.map(() => true),
		);
		const allow = hits.map((h) => allowFor("skills/s/k.md", h.line, h.key, lines[h.line - 1] as string));
		allow.push(...lines.map((l, i) => allowFor("skills/s/k.md", i + 1, "token", l)));
		setSync(dir, { allowFindings: allow });
		const rules = profileSyncRules(s.l, "p", true).rules;
		assert.deepEqual(pushable(dir, "skills/s/k.md", rules), { ok: false, reason: `skills/s/k.md: credential-looking value at ${shapes.map((_x, i) => `line ${String(i + 1)}`).join(", ")}` });
		const st = syncStatus(s.l, "p");
		assert.equal(st.ignoredAllows.length, allow.length);
		assert.deepEqual(new Set(st.ignoredAllows.map((g) => g.reason)), new Set(["the line holds a credential shape, which can never be allowed"]));
		const out = cli("sync", "status", "p");
		assert.match(out.stdout, /\nignored sync\.allowFindings entries:\n {2}skills\/s\/k\.md:1 \(sk\): the line holds a credential shape, which can never be allowed\n/);
		const doc = doctor(s.l)
			.filter((f) => f.profile === "p")
			.map((f) => f.message)
			.join("\n");
		assert.match(doc, /sync\.allowFindings entry for skills\/s\/k\.md:1 is ignored: the line holds a credential shape/);
		assert.doesNotMatch(out.stdout + out.stderr + doc, /A1b2C3|hunter2x|dXNlcjpwYXNz|1234567890ab/);
	});
	it("a shape and a keyed finding on one line: the line stays refused", () => {
		const dir = profileDir();
		const line = 'token = "Bearer abc123def456" # sk-A1b2C3d4E5f6G7h8I9';
		writeFileSync(join(dir, "skills", "s", "k.md"), `${line}\n`);
		setSync(dir, { allowFindings: [allowFor("skills/s/k.md", 1, "token", line), allowFor("skills/s/k.md", 1, "sk", line), allowFor("skills/s/k.md", 1, "bearer", line)] });
		assert.equal(pushable(dir, "skills/s/k.md", profileSyncRules(s.l, "p", true).rules).ok, false);
	});
});

describe("sync status: skipped files and --allow-line", () => {
	it("lists each skipped file with its reason, never a value", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "a.ts"), `const token = "${SECRET}";\n`);
		writeFileSync(join(dir, "skills", "s", "big.md"), "x".repeat(1024 * 1024 + 1));
		const r = cli("sync", "status", "p");
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /\nconfig sync would skip 2 config files \(locations only, never values\):\n {2}skills\/s\/a\.ts: credential-looking value at line 1\n {2}skills\/s\/big\.md: larger than 1 MiB, not scanned\n/);
		assert.match(r.stdout, /--allow-line PATH:LINE/);
		const j = JSON.parse(cli("sync", "status", "--json", "p").stdout) as { skipped: Array<{ path: string; reason: string }> };
		assert.deepEqual(
			j.skipped.map((k) => k.path),
			["skills/s/a.ts", "skills/s/big.md"],
		);
		assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET));
	});
	it("--allow-line prints the exact entry to paste, with the hash and never the line, and the entry allows the finding", () => {
		const dir = profileDir();
		const line = `const token = "${SECRET}";`;
		writeFileSync(join(dir, "skills", "s", "a.ts"), `// a\n${line}\n`);
		const r = cli("sync", "status", "p", "--allow-line", "skills/s/a.ts:2");
		assert.equal(r.code, 0, r.stderr);
		const got = JSON.parse(r.stdout) as { path: string; line: number; key: string; salt: string; scrypt: string };
		assert.deepEqual(Object.keys(got), ["path", "line", "key", "salt", "scrypt"]);
		assert.deepEqual([got.path, got.line, got.key], ["skills/s/a.ts", 2, "token"]);
		assert.match(got.salt, /^[0-9a-f]{32}$/);
		assert.equal(got.scrypt, allowDigest("skills/s/a.ts", "token", line, got.salt));
		assert.notEqual(JSON.parse(cli("sync", "status", "p", "--allow-line", "skills/s/a.ts:2").stdout).salt, got.salt, "a fresh salt for each entry");
		assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET));
		setSync(dir, { allowFindings: [JSON.parse(r.stdout) as unknown] });
		const after = cli("sync", "status", "p");
		assert.equal(after.code, 0, after.stderr);
		assert.doesNotMatch(after.stdout, /would skip/, "profile.json holding the entry is not flagged either");
		assert.deepEqual(pushPlan(dir, profileSyncRules(s.l, "p", true).rules).skipped, []);
	});
	it("--allow-line refuses a shape, a line without a finding, a clean file and a bad path", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "a.ts"), `// a\nconst token = "${SECRET}";\nconst k = "sk-A1b2C3d4E5f6G7h8I9";\n`);
		writeFileSync(join(dir, "skills", "s", "ok.ts"), "const x = 1;\n");
		const refused = (arg: string, re: RegExp): void => {
			const r = cli("sync", "status", "p", "--allow-line", arg);
			assert.equal(r.code, 2, arg);
			assert.equal(r.stdout, "", arg);
			assert.match(r.stderr, re, arg);
			assert.doesNotMatch(r.stderr, new RegExp(`${SECRET}|A1b2C3`), arg);
		};
		refused("skills/s/a.ts:3", /a credential shape \(sk\) can never be allowed/);
		refused("skills/s/a.ts:1", /no credential-looking value on this line \(found at line 2, line 3\)/);
		refused("skills/s/ok.ts:1", /no credential-looking value; config sync carries it/);
		refused("../x.ts:1", /must be normalised/);
		refused("skills/s/a.ts", /--allow-line needs PATH:LINE/);
		refused("skills/s/a.ts:0", /--allow-line needs PATH:LINE/);
		assert.throws(() => allowEntries(dir, "skills/s/*.ts", 2, NONE), /no glob characters/);
	});
	it("a JSON finding is allowed by its key path, at the line of its value", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "models.json"), `{\n\t"providers": {\n\t\t"x": { "apiKey": "${SECRET}" }\n\t}\n}\n`);
		const e = allowEntries(dir, "models.json", 3, NONE);
		assert.deepEqual(
			e.map((x) => [x.path, x.line, x.key]),
			[["models.json", 3, "providers.x.apiKey"]],
		);
		setSync(dir, { allowFindings: e });
		assert.deepEqual(pushable(dir, "models.json", profileSyncRules(s.l, "p", true).rules), { ok: true });
		assert.deepEqual(pushable(dir, "profile.json", profileSyncRules(s.l, "p", true).rules), { ok: true });
	});
	it("a password pasted into an allow entry's key in profile.json is still flagged", () => {
		const dir = profileDir();
		setSync(dir, { allowFindings: [{ path: "skills/s/a.ts", line: 1, key: SECRET, salt: "b".repeat(32), scrypt: "a".repeat(64) }] });
		assert.deepEqual(pushable(dir, "profile.json", profileSyncRules(s.l, "p", true).rules), { ok: false, reason: "profile.json: credential-looking value at sync.allowFindings.0.key" });
	});
});

/** Tests for review round 1 of issue 36. */

describe("CR-36-KEY-WORDS-QUADRATIC", () => {
	it("a key of 50,000 words scans in under 100 ms in code, settings and prose", () => {
		const slow: string[] = [];
		for (const rel of ["skills/s/f.ts", "skills/s/f.yaml", "skills/s/f.md"])
			for (const text of [`${"a_".repeat(50_000)}: x`, `${"aB".repeat(50_000)}: x`]) {
				const t = ms(() => credentialLineHits(text, rel));
				if (t >= BOUND_MS) slow.push(`${rel} on ${text.slice(0, 4)}…: ${t.toFixed(0)} ms`);
			}
		assert.deepEqual(slow, []);
	});
	it("still names a long key a credential key by its last words", () => {
		assert.deepEqual(credentialLines(`${"a_".repeat(500)}api_key: "${SECRET}"`, "skills/s/f.yaml"), ["line 1"]);
		assert.deepEqual(credentialLines(`${"aB".repeat(500)}_password = "${SECRET}"`, "skills/s/f.ts"), ["line 1"]);
	});
});

describe("CR-36-JSON-DUPKEY", () => {
	const REPRO = `{"apiKey": "${SECRET}", "apiKey": "${"${KEY}"}"}`;
	it("refuses JSON with a duplicate key, once, as a hard finding that cannot be allowed", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), REPRO);
		assert.deepEqual(pushable(dir, "skills/s/k.json", NONE), { ok: false, reason: "skills/s/k.json: credential-looking value at line 1 (duplicate key)" });
		assert.throws(() => allowEntries(dir, "skills/s/k.json", 1, NONE), /credential shape \(duplicate-key\) can never be allowed/);
	});
	it("refuses a duplicate key in a nested object, at its line", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), '{\n  "a": {\n    "x": 1,\n    "x": 2\n  }\n}\n');
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: ["line 4 (duplicate key)"] });
	});
	it("keeps the same key in different objects clean", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), '{"a": {"x": 1}, "b": {"x": 2}, "c": [{"x": 1}, {"x": 2}]}');
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: [] });
	});
});

describe("CR-36-USERINFO-PLACEHOLDER", () => {
	const hits = (text: string): string[] => credentialLineHits(text, "skills/s/a.md").map((h) => `${h.key}:${String(h.shape)}`);
	it("a placeholder password is a soft url-userinfo-example finding", () => {
		for (const pw of ["pass", "password", "PASSWORD", "Passwd", "pw", "secret", "changeme", "xxx", "XXXX", "****", "*", "<pass>", "<password>", "${PASS}", "{password}", "{{password}}"])
			assert.deepEqual(hits(`see https://user:${pw}@example.com/x`), ["url-userinfo-example:false"], pw);
	});
	it("any other password is a hard url-userinfo finding", () => {
		for (const pw of ["hunter2x", "passw0rd", "password1", "mypass", "$PASS", "x1x", "secrets", "<a>b", "{a}b"])
			assert.deepEqual(hits(`see https://user:${pw}@example.com/x`), ["url-userinfo:true"], pw);
	});
	it("a hard userinfo next to an example one keeps the line hard", () => {
		assert.deepEqual(hits("https://a:pass@h.example https://b:hunter2x@h.example").sort(), ["url-userinfo-example:false", "url-userinfo:true"]);
	});
	it("an example userinfo line can be allowed, a real one cannot", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "a.md"), "curl https://user:password@example.com/x\ncurl https://user:hunter2x@example.com/x\n");
		const e = allowEntries(dir, "skills/s/a.md", 1, NONE);
		assert.deepEqual(
			e.map((x) => x.key),
			["url-userinfo-example"],
		);
		assert.throws(() => allowEntries(dir, "skills/s/a.md", 2, NONE), /credential shape \(url-userinfo\) can never be allowed/);
		writeFileSync(join(dir, "skills", "s", "a.md"), "curl https://user:password@example.com/x\n");
		setSync(dir, { allowFindings: e });
		assert.deepEqual(pushable(dir, "skills/s/a.md", profileSyncRules(s.l, "p", true).rules), { ok: true });
	});
});

describe("CR-36-KEYPATH-VALUE", () => {
	const KEY = "hunter2pass99";
	it("shows a map key below a credential key as *, in JSON reasons and keys", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), `{"tokens":{"${KEY}":"${SECRET}"},"apiKeys":[{"${KEY}":"v"}]}`);
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: ["tokens.*", "apiKeys.0.*"] });
		assert.doesNotMatch(JSON.stringify(pushable(dir, "skills/s/k.json", NONE)), new RegExp(KEY));
	});
	it("keeps the keys below a section key such as auth", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.json"), `{"auth":{"token":"${SECRET}"}}`);
		assert.deepEqual(scanConfigFile(join(dir, "skills", "s", "k.json"), "skills/s/k.json"), { ok: true, at: ["auth.token"] });
	});
	it("--allow-line never writes the masked key, and the masked entry allows the finding", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "models.json"), `{\n\t"tokens": {\n\t\t"${KEY}": "${SECRET}"\n\t}\n}\n`);
		const r = cli("sync", "status", "p", "--allow-line", "models.json:3");
		assert.equal(r.code, 0, r.stderr);
		assert.doesNotMatch(r.stdout + r.stderr, new RegExp(`${KEY}|${SECRET}`));
		assert.equal((JSON.parse(r.stdout) as { key: string }).key, "tokens.*");
		setSync(dir, { allowFindings: [JSON.parse(r.stdout) as unknown] });
		const rules = profileSyncRules(s.l, "p", true).rules;
		assert.deepEqual(pushable(dir, "models.json", rules), { ok: true });
		assert.deepEqual(pushable(dir, "profile.json", rules), { ok: true }, "the masked key in profile.json is not a finding");
	});
});

describe("CR-36-LINE-MASK", () => {
	const PW = "Zr8kq2LmNp4x";
	it("reports every finding on a line", () => {
		const keys = (text: string, rel: string): string[] => credentialLineHits(text, rel).map((h) => h.key);
		assert.deepEqual(keys(`token: ${SECRET}, password: ${PW}`, "skills/s/a.yaml"), ["token", "password"]);
		assert.deepEqual(keys(`password = "${PW}"; // Bearer abc123def456`, "skills/s/a.ts"), ["bearer", "password"]);
	});
	it("one entry covers one (line, key): a second finding on the line needs its own entry", () => {
		const dir = profileDir();
		const line = `password = "${PW}"; // Bearer abc123def456`;
		writeFileSync(join(dir, "skills", "s", "a.ts"), `${line}\n`);
		const rules = (allowFindings: unknown[]): SyncRules => {
			setSync(dir, { allowFindings });
			return profileSyncRules(s.l, "p", true).rules;
		};
		assert.deepEqual(pushable(dir, "skills/s/a.ts", rules([allowFor("skills/s/a.ts", 1, "bearer", line)])), { ok: false, reason: "skills/s/a.ts: credential-looking value at line 1" });
		assert.deepEqual(pushable(dir, "skills/s/a.ts", rules([allowFor("skills/s/a.ts", 1, "password", line)])), { ok: false, reason: "skills/s/a.ts: credential-looking value at line 1" });
		assert.deepEqual(pushable(dir, "skills/s/a.ts", rules([allowFor("skills/s/a.ts", 1, "bearer", line), allowFor("skills/s/a.ts", 1, "password", line)])), { ok: true });
		assert.deepEqual(
			allowEntries(dir, "skills/s/a.ts", 1, NONE).map((e) => e.key),
			["bearer", "password"],
		);
	});
	it("a hard shape anywhere on the line keeps every finding on it", () => {
		const dir = profileDir();
		const line = `password = "${PW}"; // https://u:hunter2x@h.example`;
		writeFileSync(join(dir, "skills", "s", "a.ts"), `${line}\n`);
		setSync(dir, { allowFindings: [allowFor("skills/s/a.ts", 1, "password", line)] });
		const rules = profileSyncRules(s.l, "p", true).rules;
		assert.equal(pushable(dir, "skills/s/a.ts", rules).ok, false);
		assert.deepEqual(
			pushPlan(dir, rules).skipped.flatMap((k) => k.findings.map((f) => f.key)),
			["url-userinfo", "password"],
			"the entry allows nothing on the line",
		);
		assert.deepEqual(
			syncStatus(s.l, "p").ignoredAllows.map((g) => g.entry.key),
			["password"],
		);
	});
});

describe("CR-36-STALE-ALLOW", () => {
	it("sync status and doctor report an entry that matches no finding, by path, line and key only", () => {
		const dir = profileDir();
		const line = `const token = "${SECRET}";`;
		writeFileSync(join(dir, "skills", "s", "a.ts"), `${line}\n`);
		const live = allowFor("skills/s/a.ts", 1, "token", line);
		const edited = allowFor("skills/s/a.ts", 1, "token", `${line} `);
		const gone = allowFor("skills/s/gone.ts", 7, "apiKey", line);
		setSync(dir, { allowFindings: [live, gone] });
		const st = syncStatus(s.l, "p");
		assert.deepEqual(st.staleAllows, [{ path: "skills/s/gone.ts", line: 7, key: "apiKey" }]);
		assert.deepEqual(st.skipped, []);
		setSync(dir, { allowFindings: [edited] });
		assert.deepEqual(syncStatus(s.l, "p").staleAllows, [{ path: "skills/s/a.ts", line: 1, key: "token" }]);
		const out = cli("sync", "status", "p");
		assert.match(out.stdout, /\n {2}stale allow entry: skills\/s\/a\.ts:1 \(token\)\n/);
		const doc = doctor(s.l)
			.filter((f) => f.profile === "p")
			.map((f) => f.message)
			.join("\n");
		assert.match(doc, /stale allow entry: skills\/s\/a\.ts:1 \(token\) matches no finding/);
		assert.doesNotMatch(out.stdout + doc, new RegExp(`${SECRET}|${edited.salt}|${edited.scrypt}`));
		const j = JSON.parse(cli("sync", "status", "--json", "p").stdout) as { staleAllows: unknown[] };
		assert.deepEqual(j.staleAllows, [{ path: "skills/s/a.ts", line: 1, key: "token" }]);
	});
	it("an entry on a shape line is reported as ignored, not stale", () => {
		const dir = profileDir();
		const line = 'token = "sk-A1b2C3d4E5f6G7h8I9"'; // gitleaks:allow
		writeFileSync(join(dir, "skills", "s", "a.md"), `${line}\n`);
		setSync(dir, { allowFindings: [allowFor("skills/s/a.md", 1, "token", line)] });
		const st = syncStatus(s.l, "p");
		assert.equal(st.ignoredAllows.length, 1);
		assert.deepEqual(st.staleAllows, []);
	});
});

describe("allow entries: salted scrypt", () => {
	it("the digest is scrypt N=2^14, r=8, p=1, 32 bytes, over the domain, path, key and raw line", () => {
		const salt = "00112233445566778899aabbccddeeff";
		const want = scryptSync("pi-profile/allow/v1\0skills/s/a.ts\0token\0const token = 1;", Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 }).toString("hex");
		assert.equal(allowDigest("skills/s/a.ts", "token", "const token = 1;", salt), want);
		assert.notEqual(allowDigest("skills/s/a.ts", "token", "const token = 1;", "f".repeat(32)), want, "the salt changes the digest");
		assert.notEqual(allowDigest("skills/s/b.ts", "token", "const token = 1;", salt), want, "the path is bound");
		assert.notEqual(allowDigest("skills/s/a.ts", "apiKey", "const token = 1;", salt), want, "the key is bound");
	});
	it("the soft bearer shape can be allowed", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "a.md"), "curl -H 'Authorization: Bearer abc123def456'\n"); // gitleaks:allow
		const e = allowEntries(dir, "skills/s/a.md", 1, NONE);
		assert.deepEqual(
			e.map((x) => x.key),
			["bearer"],
		);
		setSync(dir, { allowFindings: e });
		assert.deepEqual(pushable(dir, "skills/s/a.md", profileSyncRules(s.l, "p", true).rules), { ok: true });
	});
	it("refuses an old sha256 entry and says to regenerate it", () => {
		const r = parseManifest({ schemaVersion: 1, name: "p", sync: { allowFindings: [{ path: "a.ts", line: 1, key: "token", sha256: "a".repeat(64) }] } }, "/x");
		assert.match(r.ok ? "" : r.errors.join("\n"), /sync\.allowFindings\[0\] is an old sha256 entry, which is no longer accepted; regenerate it with pi-profile sync status --allow-line PATH:LINE/);
	});
	it("computes scrypt only for an entry whose path, line and key match a finding", () => {
		const dir = profileDir();
		const line = `const token = "${SECRET}";`;
		writeFileSync(join(dir, "skills", "s", "a.ts"), `${line}\n${"// filler\n".repeat(200)}`);
		const many = Array.from({ length: 200 }, (_x, i) => ({ path: "skills/s/a.ts", line: i + 2, key: "token", salt: SALT, scrypt: "a".repeat(64) }));
		setSync(dir, { allowFindings: [...many, allowFor("skills/s/a.ts", 1, "token", line)] });
		const rules = profileSyncRules(s.l, "p", true).rules;
		const t = ms(() => pushable(dir, "skills/s/a.ts", rules));
		assert.ok(t < 1500, `201 entries took ${t.toFixed(0)} ms; scrypt for each would take seconds`);
		assert.deepEqual(pushable(dir, "skills/s/a.ts", rules), { ok: true });
	});
});
