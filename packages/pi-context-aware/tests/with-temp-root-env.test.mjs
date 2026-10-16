import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "with-temp-root.mjs");

/** Run a one-line script under the wrapper and return what it printed. */
function runUnderWrapper(env, script = "process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? '<unset>')") {
	const result = spawnSync(
		process.execPath,
		[wrapper, process.execPath, "-e", script],
		{ env: { ...process.env, ...env }, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("a test run does not inherit the operator's live Pi agent directory", () => {
	assert.equal(runUnderWrapper({ PI_CODING_AGENT_DIR: "/nonexistent/live-profile" }), "<unset>");
});

test("a test run gets an empty home inside its own temp root, not the operator's home", () => {
	const operatorHome = "/nonexistent/operator-home";
	const printed = JSON.parse(runUnderWrapper(
		{ HOME: operatorHome },
		"const fs = require('node:fs'); process.stdout.write(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, entries: fs.readdirSync(process.env.HOME) }))",
	));
	assert.notEqual(printed.home, operatorHome);
	assert.equal(path.dirname(printed.home), printed.tmp);
	assert.deepEqual(printed.entries, []);
});

/**
 * Settings a Fabric worker, a delegated run, or the operator's shell hands a
 * test run. Each one changes what the extension does at run time.
 */
const HOST_SESSION_SETTINGS = {
	PI_FABRIC_TOOL_ALLOWLIST: '["read","bash","fabric_exec"]',
	PI_FABRIC_SCOPE: "worker",
	PI_DELEGATE_LINEAGE_ROOT_RUN_ID: "root-run",
	PI_DELEGATE_LINEAGE_RUN_ID: "child-run",
	PI_DELEGATE_LINEAGE_CHILD_INDEX: "0",
	PI_CONTEXT_AWARE_BUSY_PROBE: "idle",
	PI_CONTEXT_AWARE_BUSY_STALE_MS: "5000",
	BILLION_CONTEXT_NATIVE: "omp",
	BILLION_CONTEXT_PROXY: "1",
	CMUX_BIN: "/nonexistent/cmux",
};

/** Run under the wrapper with `env` set, and return what the child saw for `names`. */
function seenByChild(env, names) {
	return JSON.parse(runUnderWrapper(
		env,
		`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name] ?? null]))))`,
	));
}

test("a test run started inside a Fabric worker or delegated run does not inherit its settings", () => {
	const names = [...Object.keys(HOST_SESSION_SETTINGS), "UNRELATED_SETTING"];
	const seen = seenByChild({ ...HOST_SESSION_SETTINGS, UNRELATED_SETTING: "kept" }, names);
	assert.deepEqual(seen, {
		PI_FABRIC_TOOL_ALLOWLIST: null,
		PI_FABRIC_SCOPE: null,
		PI_DELEGATE_LINEAGE_ROOT_RUN_ID: null,
		PI_DELEGATE_LINEAGE_RUN_ID: null,
		PI_DELEGATE_LINEAGE_CHILD_INDEX: null,
		PI_CONTEXT_AWARE_BUSY_PROBE: null,
		PI_CONTEXT_AWARE_BUSY_STALE_MS: null,
		BILLION_CONTEXT_NATIVE: null,
		BILLION_CONTEXT_PROXY: null,
		CMUX_BIN: null,
		UNRELATED_SETTING: "kept",
	});
});

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Every environment variable name `src/` reads.
 *
 * Covers `env.NAME`, `env["NAME"]`, and `env[CONSTANT]` where the same file
 * declares `const CONSTANT = "NAME"`. A computed read it cannot resolve is an
 * error, so a new read cannot slip past the check below unseen.
 */
function envNamesReadBySrc() {
	const names = new Set();
	for (const entry of fs.readdirSync(srcDir, { recursive: true })) {
		const file = path.join(srcDir, String(entry));
		if (!file.endsWith(".ts")) continue;
		const text = fs.readFileSync(file, "utf8");
		for (const match of text.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)\b/g)) names.add(match[1]);
		for (const match of text.matchAll(/\benv\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g)) names.add(match[1]);
		for (const match of text.matchAll(/\benv\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
			const declared = new RegExp(`\\bconst\\s+${match[1]}\\s*=\\s*["'\`]([A-Z_][A-Z0-9_]*)["'\`]`).exec(text);
			assert.ok(declared, `${path.relative(srcDir, file)} reads env[${match[1]}]; declare it as a const string so this check can see the name`);
			names.add(declared[1]);
		}
	}
	return [...names].sort();
}

test("no environment variable src/ reads reaches a test run unchanged from the host session", () => {
	const names = envNamesReadBySrc();
	// The scan must see the reads it was written for, or it passes by finding nothing.
	for (const known of ["PI_FABRIC_TOOL_ALLOWLIST", "PI_DELEGATE_LINEAGE_RUN_ID", "PI_CODING_AGENT_DIR", "HOME"]) {
		assert.ok(names.includes(known), `scan of src/ did not find ${known}`);
	}
	const sentinel = "host-session-value-must-not-reach-tests";
	const seen = seenByChild(Object.fromEntries(names.map((name) => [name, sentinel])), names);
	const leaked = names.filter((name) => seen[name] === sentinel);
	assert.deepEqual(leaked, [], "add these to HOST_SESSION_ENV_PREFIXES or HOST_SESSION_ENV_NAMES in scripts/with-temp-root.mjs, or replace them there as HOME is");
});
