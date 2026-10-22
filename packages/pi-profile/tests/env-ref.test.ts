import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { doctor } from "../src/core/doctor.ts";
import { createProfile } from "../src/core/profiles.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

/**
 * `env:NAME` is a reference some extension configs resolve, but Pi does not
 * resolve it in models.json and pi-web-access does not resolve it in
 * web-search.json. The key scan still counts it as a reference, so such a
 * file passes; doctor says the key never resolves and suggests `${NAME}`.
 */

let s: Sandbox;

beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

function messages(): string {
	return doctor(s.l)
		.filter((f) => f.profile === "p")
		.map((f) => `${f.level} ${f.message}`)
		.join("\n");
}

const SUGGESTION = /write each as an environment variable reference such as "\$\{NAME\}"/;

describe("doctor: env:NAME in models.json and web-search.json", () => {
	it("reports env:NAME in models.json, at each field, and suggests ${NAME}", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "env:WORK_LLM_API_KEY", models: [{ id: "m", headers: { "x-api-key": " env:WORK_LLM_TOKEN " } }] } } }, null, "\t"));
		const text = messages();
		assert.match(text, /^warn models\.json uses env:NAME at providers\.x\.apiKey, providers\.x\.models\.0\.headers\.x-api-key, which Pi does not resolve, so the key never reaches the provider; /m);
		assert.match(text, SUGGESTION);
		assert.ok(!text.includes("WORK_LLM"), "the variable name is not printed");
	});

	it("reports env:NAME in web-search.json and suggests ${NAME}", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "exa", exaApiKey: "env:EXA_API_KEY" }, null, "\t"));
		const text = messages();
		assert.match(text, /^warn web-search\.json uses env:NAME at exaApiKey, which pi-web-access does not resolve, so the key never reaches the provider; /m);
		assert.match(text, SUGGESTION);
	});

	it("does not report env:NAME in another config file, which may resolve it", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "fabric.json"), JSON.stringify({ apiKey: "env:EXA_API_KEY" }, null, "\t"));
		writeFileSync(join(dir, "context-aware.json"), JSON.stringify({ providers: { x: { apiKey: "env:WORK_LLM_API_KEY" } } }, null, "\t"));
		assert.equal(messages(), "");
	});

	it("does not report ${NAME} or $NAME, which Pi and pi-web-access resolve", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { apiKey: "${WORK_LLM_API_KEY}", models: [{ id: "m", headers: { "x-api-key": "$WORK_LLM_TOKEN" } }] } } }, null, "\t"));
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "exa", exaApiKey: "$EXA_API_KEY", braveApiKey: "${BRAVE_API_KEY}" }, null, "\t"));
		assert.equal(messages(), "");
	});

	it("does not report env:NAME inside a longer value, or a name that is not a shell name", () => {
		const dir = createProfile(s.l, "p").dir;
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { x: { baseUrl: "https://llm.example.com/env:X", name: "env:", models: [{ id: "env:1abc" }] } } }, null, "\t"));
		assert.equal(messages(), "");
	});
});
