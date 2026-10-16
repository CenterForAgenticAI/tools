import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { doctor } from "../src/core/doctor.ts";
import { initHub, pushHubs } from "../src/core/hub.ts";
import { createProfile } from "../src/core/profiles.ts";
import { credentialKeys } from "../src/core/syncmanifest.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

/**
 * Tests for issue 41: API keys in models.json and web-search.json
 * belong in environment variables. Doctor names each field that still holds a
 * literal key, never its value; sync push leaves such a file out and says why,
 * and carries it once every key is a reference.
 */

let s: Sandbox;
let remote: string;
let env: Record<string, string | undefined>;

/** Two literal keys that are not credential shapes, so only the key-path scan finds them. */
const MODELS_KEY = "q7Rk2vLm9Xw4Tz8Np3Hs6Jd1"; // gitleaks:allow
const HEADER_KEY = "b5Gh8Kc2Vn7Qp4Wy9Zt3Lr6M"; // gitleaks:allow
const SEARCH_KEY = "e1f2a3b4c5d6e7f8a9b0c1d2"; // gitleaks:allow
const VALUES = [MODELS_KEY, HEADER_KEY, SEARCH_KEY];

function git(args: readonly string[]): string {
	const r = spawnSync("git", [...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

function hubFiles(): string[] {
	return git([`--git-dir=${remote}`, "ls-tree", "-r", "--name-only", "--full-tree", "refs/heads/main"]).split("\n").filter((x) => x !== "");
}

function literalModels(): string {
	return JSON.stringify({ providers: { x: { baseUrl: "https://llm.example.com/v1", apiKey: MODELS_KEY, models: [{ id: "m", headers: { "x-api-key": HEADER_KEY } }] } } }, null, "\t");
}

function literalSearch(): string {
	return JSON.stringify({ provider: "exa", exaApiKey: SEARCH_KEY }, null, "\t");
}

/** The same files with each key replaced by an environment variable reference, in each form Pi and pi-web-access read. */
function referencedModels(): string {
	return JSON.stringify({ providers: { x: { baseUrl: "https://llm.example.com/v1", apiKey: "${WORK_LLM_API_KEY}", headers: { Authorization: "Bearer ${WORK_LLM_TOKEN}" }, models: [{ id: "m", headers: { "x-api-key": "$WORK_LLM_API_KEY" } }] } } }, null, "\t");
}

function referencedSearch(): string {
	return JSON.stringify({ provider: "exa", exaApiKey: "$EXA_API_KEY" }, null, "\t");
}

beforeEach(() => {
	s = sandbox();
	remote = join(s.home, "hub.git");
	git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
	env = { HOME: s.home, PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "host-a", PATH: process.env.PATH };
});
afterEach(() => {
	s.cleanup();
});

describe("doctor: literal API keys in models.json and web-search.json", () => {
	it("names the file and each field that holds a literal key, never the value", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), literalModels());
		writeFileSync(join(dir, "web-search.json"), literalSearch());
		const found = doctor(s.l).filter((f) => f.profile === "p");
		const text = found.map((f) => `${f.level} ${f.message}`).join("\n");
		assert.match(text, /^warn models\.json holds a literal API key at providers\.x\.apiKey, providers\.x\.models\.0\.headers\.x-api-key; sync push leaves it out of the hub until each is an environment variable reference such as "\$\{NAME\}"/m);
		assert.match(text, /^warn web-search\.json holds a literal API key at exaApiKey; sync push leaves it out of the hub until each is an environment variable reference such as "\$\{NAME\}"/m);
		assert.doesNotMatch(text, /is config but holds a credential-looking value/, "a keyed file gets the API key finding, not the generic one");
		for (const v of VALUES) {
			assert.ok(!text.includes(v), "the value is never printed");
			assert.ok(!text.includes(v.slice(0, 6)) && !text.includes(v.slice(-6)), "no part of the value is printed");
		}
	});

	it("is quiet when every key is an environment variable reference", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), referencedModels());
		writeFileSync(join(dir, "web-search.json"), referencedSearch());
		assert.deepEqual(doctor(s.l), []);
	});
});

describe("credential scan: references in API key fields", () => {
	it("does not count a reference Pi or pi-web-access resolves, including after an auth scheme", () => {
		assert.deepEqual(credentialKeys({ apiKey: "${A}", token: "$B", exaApiKey: "!pass show exa", headers: { Authorization: "Bearer ${C}", "Proxy-Authorization": "Basic $D" } }), []);
	});
	it("still counts a literal, a bare variable name, an escaped $$ and a reference with literal text around it", () => {
		const value = { a: { apiKey: "OPENAI_API_KEY" }, b: { apiKey: "$$abcdef123456" }, c: { apiKey: "key-${X}" }, d: { headers: { Authorization: "Bearer abcdefghijklmnop" } }, e: { headers: { Authorization: "Bearer ${X} extra" } } };
		assert.deepEqual(credentialKeys(value), ["a.apiKey", "b.apiKey", "c.apiKey", "d.headers.Authorization", "e.headers.Authorization"]);
	});
	it("counts a scheme followed by ! or env: as a literal: Pi runs a command only for a value that starts with !", () => {
		const value = { a: { headers: { Authorization: "Bearer !abc123secret" } }, b: { headers: { Authorization: "Token env:abc123secret" } } };
		assert.deepEqual(credentialKeys(value), ["a.headers.Authorization", "b.headers.Authorization"]);
	});
});

describe("sync push: models.json and web-search.json follow their keys", () => {
	it("leaves out a file with a literal key and says why, then carries it once the key is a reference", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
		writeFileSync(join(dir, "models.json"), literalModels());
		writeFileSync(join(dir, "web-search.json"), literalSearch());
		initHub(s.l, remote, { env });

		const first = pushHubs(s.l, ["p"], { env });
		assert.deepEqual(first.skipped.map((x) => x.path).sort(), ["models.json", "web-search.json"]);
		for (const x of first.skipped) {
			assert.match(x.reason, /credential-looking value at /);
			assert.match(x.reason, /it stays out of the hub while it holds a literal key: replace each with an environment variable reference such as "\$\{NAME\}"/);
			assert.doesNotMatch(x.reason, /issue 41/);
			for (const v of VALUES) assert.ok(!x.reason.includes(v));
		}
		assert.ok(first.hubs[0]?.commit !== undefined, "the other files are still pushed");
		assert.deepEqual(hubFiles().filter((f) => /models|web-search/.test(f)), []);

		writeFileSync(join(dir, "models.json"), referencedModels());
		writeFileSync(join(dir, "web-search.json"), referencedSearch());
		const second = pushHubs(s.l, ["p"], { env });
		assert.deepEqual(second.skipped, []);
		assert.ok(second.hubs[0]?.commit !== undefined, JSON.stringify(second.hubs));
		assert.deepEqual(hubFiles().filter((f) => /models|web-search/.test(f)).sort(), ["profiles/p/models.json", "profiles/p/web-search.json"]);
		assert.equal(git([`--git-dir=${remote}`, "show", "refs/heads/main:profiles/p/models.json"]), referencedModels());
		assert.equal(git([`--git-dir=${remote}`, "show", "refs/heads/main:profiles/p/web-search.json"]), referencedSearch());
	});

	it("leaves the file out again when a literal key comes back", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), referencedModels());
		initHub(s.l, remote, { env });
		assert.deepEqual(pushHubs(s.l, ["p"], { env }).skipped, []);
		writeFileSync(join(dir, "models.json"), literalModels());
		const r = pushHubs(s.l, ["p"], { env });
		assert.deepEqual(r.skipped.map((x) => x.path), ["models.json"]);
		assert.equal(git([`--git-dir=${remote}`, "show", "refs/heads/main:profiles/p/models.json"]), referencedModels(), "the hub keeps its last clean copy");
	});
});
