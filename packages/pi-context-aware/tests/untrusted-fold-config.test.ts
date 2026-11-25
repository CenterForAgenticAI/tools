/**
 * An untrusted project's own `.pi/context-aware.json` cannot set any fold-engine leaf (pi-context-aware#525): the
 * project's `.pi/` directory is writable by the agent working in it, so its file must not choose how this package
 * manages context in a session the operator has not trusted. A trusted project's file and the global file in the
 * agent dir still set them. Expected values are literals, not read from the code under test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerFoldEngine, resolveFoldConfig } from "../src/folds/fold-engine.js";
import { CONFIG_LEAVES } from "../src/platform/config-layers.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

/** Every fold-engine leaf, each set to a value that differs from its default. */
const HOSTILE = { folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 42, condensedSkills: true, engine: "compaction-only" } };
const HOSTILE_PATHS = ["folds.firstUserMessage", "folds.firstUserMessageMaxTokens", "folds.condensedSkills", "folds.engine"];

function projectWith(t: { after(fn: () => void): void }, project: unknown, global?: unknown) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-untrusted-fold-")));
	t.after(() => removeFixtureDir(root));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	if (global !== undefined) fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify(global));
	fs.mkdirSync(path.join(root, ".pi"));
	fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify(project));
	const ctxFor = (trusted: boolean | "throws" | "absent") => ({
		cwd: root,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		...(trusted === "absent" ? {} : { isProjectTrusted: () => { if (trusted === "throws") throw new Error("no answer"); return trusted; } }),
	}) as unknown as ExtensionContext;
	return { root, agentDir, ctxFor };
}

test("#525: the hostile file covers every fold-engine leaf", () => {
	// A new folds.* leaf must be added to HOSTILE, so this test keeps checking every one.
	const leaves = CONFIG_LEAVES.map((leaf) => leaf.path).filter((leaf) => leaf.startsWith("folds."));
	assert.deepEqual([...leaves].sort(), [...HOSTILE_PATHS].sort());
});

test("#525: an untrusted project's own file sets no folds.* leaf; a trust lookup that throws or is missing counts as untrusted", (t) => {
	const { agentDir, ctxFor } = projectWith(t, HOSTILE);
	for (const trusted of [false, "throws", "absent"] as const) {
		assert.deepEqual(resolveFoldConfig(ctxFor(trusted), agentDir), { firstUserMessage: "keep", firstUserMessageMaxTokens: 8000, condensedSkills: false, engine: "auto" }, String(trusted));
	}
});

test("#525: an untrusted project's folds.engine does not take the fold engine out of live mode", (t) => {
	const { root, ctxFor } = projectWith(t, HOSTILE);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	t.after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
	const modeFor = (trusted: boolean) => {
		const pi = { on() {}, registerTool() {}, registerCommand() {}, registerFlag() {}, registerShortcut() {}, getAllTools: () => [{ name: "read", sourceInfo: { path: "builtin:read" } }] } as unknown as ExtensionAPI;
		return registerFoldEngine(pi, {}).mode(ctxFor(trusted));
	};
	assert.equal(modeFor(false), "live");
	assert.equal(modeFor(true), "shadow", "a trusted project's folds.engine still applies");
});

test("#525: a trusted project's file still sets every folds.* leaf", (t) => {
	const { agentDir, ctxFor } = projectWith(t, HOSTILE);
	assert.deepEqual(resolveFoldConfig(ctxFor(true), agentDir), { firstUserMessage: "fold", firstUserMessageMaxTokens: 42, condensedSkills: true, engine: "compaction-only" });
});

test("#525: the global file in the agent dir still sets them for an untrusted project's session", (t) => {
	const { agentDir, ctxFor } = projectWith(t, {}, { folds: { engine: "compaction-only", firstUserMessage: "fold" } });
	assert.deepEqual(resolveFoldConfig(ctxFor(false), agentDir), { firstUserMessage: "fold", firstUserMessageMaxTokens: 8000, condensedSkills: false, engine: "compaction-only" });
});
