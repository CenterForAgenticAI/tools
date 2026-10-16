import assert from "node:assert/strict";
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { createProfile } from "../src/core/profiles.ts";
import { classify, classifyPath, credentialKey, credentialKeys, credentialLines, entryClassAt, pushable, scanConfigFile, surveyProfile, type PathClass, type SyncRules } from "../src/core/syncmanifest.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/** Tests for review round 2 of issue 29 (issue 35). Each `describe` names a finding. */

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

/** `[file, line]` pairs whose line must be flagged. */
function flagged(cases: ReadonlyArray<readonly [string, string]>): string[] {
	return cases.filter(([rel, line]) => credentialLines(line, rel).length === 0).map(([rel, line]) => `${rel}: ${line}`);
}
/** `[file, line]` pairs whose line must not be flagged. */
function clean(cases: ReadonlyArray<readonly [string, string]>): string[] {
	return cases.filter(([rel, line]) => credentialLines(line, rel).length > 0).map(([rel, line]) => `${rel}: ${line}`);
}

describe("CR-29-R2-KEYED-CODE", () => {
	it("pushable refuses both repros of the review, naming the line and never the value", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "k.ts"), `// x\nconst apiKey = "${SECRET}";\n`);
		writeFileSync(join(dir, "skills", "s", "k.md"), `# k\n\napiKey: ${SECRET}\n`);
		assert.deepEqual(pushable(dir, "skills/s/k.ts", NONE), { ok: false, reason: "skills/s/k.ts: credential-looking value at line 2" });
		assert.deepEqual(pushable(dir, "skills/s/k.md", NONE), { ok: false, reason: "skills/s/k.md: credential-looking value at line 3" });
		const out = captureIo({ PI_PROFILE_HOME: s.home, SHELL: "/bin/bash" });
		main(["sync", "status", "--json", "p"], out);
		assert.match(out.stdout, /skills\/s\/k\.ts/);
		assert.doesNotMatch(out.stdout + out.stderr, new RegExp(SECRET));
	});
	it("finds a key in assignment and mapping forms anywhere in a line of code, prose or broken JSON", () => {
		assert.deepEqual(
			flagged([
				["skills/s/k.ts", `const apiKey = "${SECRET}";`],
				["skills/s/k.ts", `call({ user: "bob", apiKey: "${SECRET}" })`],
				["skills/s/k.ts", `opts.token = '${SECRET}';`],
				["skills/s/k.ts", `const Api_Key = \`${SECRET}\`;`],
				["skills/s/k.py", `API_KEY = '${SECRET}'`],
				["skills/s/k.go", `accessKey := "${SECRET}"`],
				["skills/s/k.md", `apiKey: ${SECRET}`],
				["skills/s/k.md", `config = { "client_secret": "${SECRET}" }`],
				["skills/s/k.md", `export GH_TOKEN=${SECRET}`],
				["skills/s/k.md", `run tool --api-key=${SECRET} now`],
				["skills/s/k.md", `Authorization: Basic ${SECRET}`],
				["skills/s/k.txt", "password=hunter2"],
				["skills/s/k.md", "apiKey = fallbackApiKey2"],
				["skills/s/k.html", `<script>const token = "${SECRET}";</script>`],
				["skills/s/k.json", `{"apiKey": "zz",`],
				["skills/s/k.json", `  "name": "x", "apiKey": "zz",`],
				["skills/s/k.yaml", "private_key: abc"],
			]),
			[],
		);
		assert.deepEqual(scanConfigFile("/nonexistent", "skills/s/k.json"), { ok: false, reason: "cannot be read (ENOENT)" });
	});
	it("widens the key names, in any case and in camel, snake and kebab form", () => {
		const names = ["pass", "PASS", "passwd", "pwd", "PWD", "password", "dbPassword", "secret", "CLIENT_SECRET", "client-secret", "token", "GH_TOKEN", "apikey", "apiKey", "api_key", "api-key", "API_KEY", "accessKey", "access_key", "sessionId", "session_id", "session-id", "SESSION_ID", "private_key", "privateKey", "client_secret", "auth", "AUTH", "authorization", "bearer", "cookie", "Cookie"];
		assert.deepEqual(names.filter((k) => !credentialKey(k, false)), []);
		assert.deepEqual(flagged(names.map((k) => ["skills/s/k.ts", `x.${k} = "${SECRET}";`] as const)), []);
		assert.deepEqual(credentialKeys({ pass: "x", pwd: "y", sessionId: "z" }), ["pass", "pwd", "sessionId"]);
		const words = ["passage", "compass", "bypass", "passthrough", "cwd", "author", "authors", "keyboard", "tokenizer", "maxTokens", "separatorToken", "session", "sessionDir", "sessionCount"];
		assert.deepEqual(words.filter((k) => credentialKey(k, false)), []);
	});
	it("exempts ${VAR}, $VAR, env:VAR, !cmd, environment reads, and identifiers or calls in code", () => {
		assert.deepEqual(
			clean([
				["skills/s/k.md", "token: ${GH_TOKEN}"],
				["skills/s/k.md", "apiKey: $OPENAI_API_KEY"],
				["skills/s/k.yaml", "apiKey: env:OPENAI_API_KEY"],
				["skills/s/k.yaml", "apiKey: '!op read x'"],
				["skills/s/k.sh", "GH_TOKEN=$(gh auth token)"],
				["skills/s/k.ts", "const apiKey = process.env.API_KEY;"],
				["skills/s/k.ts", 'const apiKey = process.env["API_KEY"] ?? "";'],
				["skills/s/k.md", "apiKey = process.env.OPENAI_API_KEY"],
				["skills/s/k.py", 'token = os.environ["GH_TOKEN"]'],
				["skills/s/k.py", 'token = os.getenv("GH_TOKEN")'],
				["skills/s/k.ts", "const token = readToken();"],
				["skills/s/k.ts", "const token = opts.token;"],
				["skills/s/k.ts", "return { token: token, apiKey };"],
				["skills/s/k.ts", "const token = `${prefix}-${id}`;"],
				["skills/s/k.ts", "function f(token: string, password?: Secret): void {}"],
				["skills/s/k.ts", "const apiKey = fallbackApiKey2;"],
				["skills/s/k.py", "password = default_password_1"],
				["skills/s/k.md", "token = os.environ.get(GH_TOKEN_1)"],
			]),
			[],
		);
	});
	it("keeps prose, placeholders, comparisons and names clean", () => {
		assert.deepEqual(
			clean([
				["skills/s/k.md", "Token: see the section below"],
				["skills/s/k.md", "- **Token** — the value after `--token`. Pass it as the callback token."],
				["skills/s/k.md", 'apiKey: "<your-api-key>"'],
				["skills/s/k.md", 'token: "xxxxxxxx"'],
				["skills/s/k.md", "auth: required"],
				["skills/s/k.ts", `if (token === "${SECRET}") return;`],
				["skills/s/k.ts", 'const sessionId = "";'],
				["skills/s/k.ts", 'const key = "bend-version";'],
				["skills/s/k.ts", 'const token = "github";'],
				["skills/s/k.ts", 'const sessionId = "session-main-1";'],
				["skills/s/k.yaml", "maxTokens: 50000"],
				["skills/s/k.json", '{"auth": {"mode": "shared"},'],
			]),
			[],
		);
		assert.deepEqual(credentialKeys({ auth: { mode: "shared" }, properties: { token: { type: "string", description: "A token" } } }), []);
		assert.deepEqual(credentialKeys({ auth: "x" }), ["auth"], "auth holding a value directly is a credential");
	});
});

describe("CR-29-R2-SKILL-FILETYPES", () => {
	const cls = (paths: readonly string[]): Record<string, PathClass> => Object.fromEntries(paths.map((p) => [p, classifyPath(p, NONE)]));
	const all = (paths: readonly string[], c: PathClass): Record<string, PathClass> => Object.fromEntries(paths.map((p) => [p, c]));
	it("allows the text types and names real skills use", () => {
		const types = ["bend", "tmpl", "jsonl", "tsx", "jsx", "mdx", "go", "rs", "rb", "lua", "fish", "zsh", "ps1", "sql", "csv", "xml", "ini", "cfg", "conf"];
		const names = ["README", "LICENSE", "Makefile", "Dockerfile", ".gitignore", ".gitkeep", "bend-version", "bun.lock", "package-lock.json", "pnpm-lock.yaml"];
		const ok = [...types.map((t) => `skills/s/f.${t}`), ...names.map((n) => `skills/s/sub/${n}`), "prompts/p.mdx"];
		assert.deepEqual(cls(ok), all(ok, "config"));
	});
	it("keeps .env*, binaries and unknown types out of config", () => {
		assert.deepEqual(cls(["skills/s/.env", "skills/s/.env.local", "skills/s/.envrc"]), all(["skills/s/.env", "skills/s/.env.local", "skills/s/.envrc"], "secret"));
		const no = ["skills/s/a.exe", "skills/s/a.wasm", "skills/s/a.so", "skills/s/a.docx", "skills/s/README.bin", "skills/s/tool", "skills/s/readme", "prompts/makefile"];
		assert.deepEqual(cls(no), all(no, "unknown"));
		assert.equal(classify("skills/s/tool", NONE).why, "filetype");
	});
	it("an extensionless file is config only when it is a #! script in valid UTF-8, and is then scanned", () => {
		const dir = profileDir();
		const at = (n: string): string => join(dir, "skills", "s", n);
		writeFileSync(at("run"), "#!/usr/bin/env node\nconsole.log('é');\n");
		writeFileSync(at("plain"), "echo hi\n");
		writeFileSync(at("latin1"), Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x0a, 0xe9, 0x0a]));
		writeFileSync(at("nul"), Buffer.from([0x23, 0x21, 0x2f, 0x62, 0x0a, 0x00, 0x01]));
		writeFileSync(at("leaky"), `#!/bin/sh\nGH_TOKEN=${SECRET} gh api x\n`);
		const got = Object.fromEntries(surveyProfile(dir, NONE).filter((e) => e.path.startsWith("skills/")).map((e) => [e.path, `${e.cls} ${e.why ?? "-"}`]));
		assert.deepEqual(got, { "skills/s/latin1": "unknown filetype", "skills/s/leaky": "config -", "skills/s/nul": "unknown filetype", "skills/s/plain": "unknown filetype", "skills/s/run": "config -" });
		assert.deepEqual(entryClassAt(at("run"), "skills/s/run", NONE), { cls: "config" });
		assert.deepEqual(pushable(dir, "skills/s/run", NONE), { ok: true });
		assert.deepEqual(pushable(dir, "skills/s/plain", NONE), { ok: false, reason: "skills/s/plain: class unknown: not an allowlisted file type in skills/ or prompts/" });
		assert.deepEqual(pushable(dir, "skills/s/leaky", NONE), { ok: false, reason: "skills/s/leaky: credential-looking value at line 2" });
	});
	it("a script with a second name is not config", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "run"), "#!/bin/sh\necho hi\n");
		linkSync(join(dir, "skills", "s", "run"), join(s.home, "run2"));
		assert.deepEqual(pushable(dir, "skills/s/run", NONE).ok, false);
	});
});

describe("CR-29-R2-LINKED-ROOT", () => {
	it("refuses a profile directory reached through a link, with reason linked-root", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "SKILL.md"), "# s\n");
		const link = join(s.home, "linked");
		symlinkSync(dir, link);
		assert.deepEqual(pushable(dir, "skills/s/SKILL.md", NONE), { ok: true });
		assert.deepEqual(pushable(link, "skills/s/SKILL.md", NONE), { ok: false, reason: "skills/s/SKILL.md: linked-root: the profile directory is reached through a link" });
		mkdirSync(join(s.home, "via"));
		symlinkSync(join(dir, ".."), join(s.home, "via", "profiles"));
		assert.match((pushable(join(s.home, "via", "profiles", "p"), "skills/s/SKILL.md", NONE) as { reason: string }).reason, /linked-root/, "a link above the profile directory counts too");
	});
	it("resolves a relative or unnormalised path before comparing", () => {
		const dir = profileDir();
		writeFileSync(join(dir, "skills", "s", "SKILL.md"), "# s\n");
		assert.deepEqual(pushable(relative(process.cwd(), dir), "skills/s/SKILL.md", NONE), { ok: true });
		assert.deepEqual(pushable(`${dir}/skills/..`, "skills/s/SKILL.md", NONE), { ok: true });
		assert.match((pushable(join(s.home, "missing"), "x.md", NONE) as { reason: string }).reason, /profile directory cannot be read \(ENOENT\)/);
	});
});
