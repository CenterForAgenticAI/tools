import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerFoldEngine } from "../src/folds/fold-engine.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// folds.engine is read through resolveFoldConfig inside the engine. These tests
// set it in project config and check the mode the engine ends up in.

const BILLION = ["compress", "acp_status"];

function engineFor(root: string, tools: readonly string[]) {
	const pi = {
		on() {},
		registerTool() {},
		registerCommand() {},
		registerFlag() {},
		registerShortcut() {},
		getAllTools: () => tools.map((name) => ({ name, sourceInfo: { source: "extension", path: "/ext/billion-context-pi" } })),
	} as unknown as ExtensionAPI;
	const engine = registerFoldEngine(pi, {});
	const ctx = { cwd: root, sessionManager: { getBranch: () => [], getEntries: () => [] } } as unknown as ExtensionContext;
	return { engine, ctx };
}

function projectWith(t: { after(fn: () => void): void }, setting: string): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-fold-override-")));
	t.after(() => removeFixtureDir(root));
	fs.mkdirSync(path.join(root, ".pi"));
	fs.writeFileSync(path.join(root, ".pi", "context-aware.json"), JSON.stringify({ folds: { engine: setting } }));
	return root;
}

test("folds.engine 'folds' makes the engine live and enables pointers although billion-context-pi is loaded", (t) => {
	const { engine, ctx } = engineFor(projectWith(t, "folds"), BILLION);
	const pointersEnabled = engine.mode(ctx) === "live";
	assert.equal(engine.mode(ctx), "live");
	assert.equal(pointersEnabled, true);
	assert.equal(engine.engine(ctx).engine, "folds");
	assert.equal(engine.engine(ctx).contradictsPresence, true);
});

test("folds.engine 'compaction-only' makes the engine shadow and disables pointers with no billion-context-pi", (t) => {
	const { engine, ctx } = engineFor(projectWith(t, "compaction-only"), []);
	const pointersEnabled = engine.mode(ctx) === "live";
	assert.equal(engine.mode(ctx), "shadow");
	assert.equal(pointersEnabled, false);
	assert.equal(engine.engine(ctx).engine, "compaction-only");
});
