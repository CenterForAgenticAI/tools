/**
 * An untrusted project's own `.pi/context-aware.json` cannot set any fold-engine or strategy leaf
 * (pi-context-aware#525): the project's `.pi/` directory is writable by the agent working in it, so its file must not
 * choose how this package manages context in a session the operator has not trusted. A trusted project's file and
 * the global file in the agent dir still set them. Expected values are literals, not read from the code under test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveFoldConfig, resolveStrategyConfig, sessionStrategyFor, strategySettingsFor } from "../src/folds/fold-engine.js";
import { CONFIG_LEAVES } from "../src/platform/config-layers.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

/** Every fold-engine and strategy leaf, each set to a value that differs from its default. */
const HOSTILE = {
	folds: { firstUserMessage: "fold", firstUserMessageMaxTokens: 42, condensedSkills: true, engine: "compaction-only" },
	strategy: { methods: ["fold"], shadow: [["compact"]], assign: { guidance: ["default"], seed: "project-seed" } },
};
const HOSTILE_PATHS = [
	"folds.firstUserMessage", "folds.firstUserMessageMaxTokens", "folds.condensedSkills", "folds.engine",
	"strategy.methods", "strategy.shadow", "strategy.assign.guidance", "strategy.assign.seed",
];

const bcpAbsent = [{ name: "read", sourceInfo: { path: "builtin:read" } }];

function projectWith(t: { after(fn: () => void): void }, project: unknown, global?: unknown) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-untrusted-fold-")));
	t.after(() => removeFixtureDir(root));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	if (global !== undefined) fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify(global));
	fs.mkdirSync(path.join(root, ".pi"));
	fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify(project));
	const ctxFor = (trusted: boolean) => ({
		cwd: root,
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "sess-2" },
		isProjectTrusted: () => trusted,
	}) as unknown as ExtensionContext;
	return { agentDir, ctxFor };
}

test("#525: the hostile file covers every fold-engine and strategy leaf", () => {
	// A new folds.* or strategy.* leaf must be added to HOSTILE, so this test keeps checking every one.
	const leaves = CONFIG_LEAVES.map((leaf) => leaf.path).filter((leaf) => leaf.startsWith("folds.") || leaf.startsWith("strategy."));
	assert.deepEqual([...leaves].sort(), [...HOSTILE_PATHS].sort());
});

test("#525: an untrusted project's own file sets no folds.* or strategy.* leaf", (t) => {
	const { agentDir, ctxFor } = projectWith(t, HOSTILE);
	const ctx = ctxFor(false);
	assert.deepEqual(resolveFoldConfig(ctx, agentDir), { firstUserMessage: "keep", firstUserMessageMaxTokens: 8000, condensedSkills: false, engine: "auto" });
	assert.deepEqual(resolveStrategyConfig(ctx, agentDir), { methods: "auto", shadow: [], assign: { guidance: [], seed: "" } });
	const settings = strategySettingsFor(ctx, agentDir);
	assert.equal(settings.methods, "auto");
	assert.deepEqual(settings.shadow, []);
	assert.equal(settings.engine, "auto");
	const strategy = sessionStrategyFor(ctx, bcpAbsent, agentDir);
	assert.deepEqual([...strategy.methods], ["fold", "compact"], "the session keeps both methods");
	assert.equal(strategy.source, "auto");
	assert.deepEqual(strategy.shadow, []);
	assert.equal(strategy.assignment, undefined);
});

test("#525: a value an untrusted project's file sets that a layer rejects is not reported either", (t) => {
	const { agentDir, ctxFor } = projectWith(t, { folds: { engine: "off" }, strategy: { methods: 5, shadow: "compact" } });
	const strategy = sessionStrategyFor(ctxFor(false), bcpAbsent, agentDir);
	assert.deepEqual(strategy.errors, []);
	assert.deepEqual(strategySettingsFor(ctxFor(false), agentDir).rejected, []);
});

test("#525: a trusted project's file still sets every folds.* and strategy.* leaf", (t) => {
	const { agentDir, ctxFor } = projectWith(t, HOSTILE);
	const ctx = ctxFor(true);
	assert.deepEqual(resolveFoldConfig(ctx, agentDir), { firstUserMessage: "fold", firstUserMessageMaxTokens: 42, condensedSkills: true, engine: "compaction-only" });
	assert.deepEqual(resolveStrategyConfig(ctx, agentDir), { methods: ["fold"], shadow: [["compact"]], assign: { guidance: ["default"], seed: "project-seed" } });
	const strategy = sessionStrategyFor(ctx, bcpAbsent, agentDir);
	assert.deepEqual([...strategy.methods], ["fold"]);
	assert.equal(strategy.source, "strategy.methods");
	assert.deepEqual(strategy.shadow.map((methods) => [...methods]), [["compact"]]);
});

test("#525: the global file in the agent dir still sets them for an untrusted project's session", (t) => {
	const { agentDir, ctxFor } = projectWith(t, {}, { folds: { engine: "compaction-only", firstUserMessage: "fold" }, strategy: { shadow: [["fold"]] } });
	const ctx = ctxFor(false);
	assert.equal(resolveFoldConfig(ctx, agentDir).firstUserMessage, "fold");
	const strategy = sessionStrategyFor(ctx, bcpAbsent, agentDir);
	assert.deepEqual([...strategy.methods], ["compact"]);
	assert.equal(strategy.source, "folds.engine");
	assert.deepEqual(strategy.shadow.map((methods) => [...methods]), [["fold"]]);
});
