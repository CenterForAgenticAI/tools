import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RegisteredToolView } from "../src/compaction/compaction-blocker.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { engineOverrideContradictsPresence, foldModeForEngine, resolveContextEngine } from "../src/folds/engine-resolver.js";
import { foldModeFor, resolveFoldConfig } from "../src/folds/fold-engine.js";

// pi-context-aware#309: one resolver names the engine. Expected values are literals from the
// issue's order (override, then billion-context-pi presence, else folds), not recomputed.

const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";
const at = (name: string, p: string): RegisteredToolView => ({ name, sourceInfo: { path: p } });
const bcpLoaded: RegisteredToolView[] = [at("read", "builtin:read"), at("compress", BCP_PATH), at("acp_status", BCP_PATH)];
const bcpAbsent: RegisteredToolView[] = [at("read", "builtin:read")];

test("auto with no billion-context-pi gives folds, live", () => {
	assert.equal(resolveContextEngine({ tools: bcpAbsent }), "folds");
	assert.equal(resolveContextEngine({ tools: [], override: "auto" }), "folds");
	assert.equal(foldModeForEngine("folds"), "live");
});

test("auto with billion-context-pi gives compaction-only, shadow, for each tool-list shape", () => {
	assert.equal(resolveContextEngine({ tools: bcpLoaded }), "compaction-only");
	assert.equal(resolveContextEngine({ tools: [at("acp_cache", BCP_PATH)] }), "compaction-only");
	assert.equal(resolveContextEngine({ tools: [at("compress", BCP_PATH)] }), "folds", "one tool of the pair is not enough");
	assert.equal(foldModeForEngine("compaction-only"), "shadow");
});

test("an explicit override wins in both directions", () => {
	assert.equal(resolveContextEngine({ tools: bcpLoaded, override: "folds" }), "folds");
	assert.equal(resolveContextEngine({ tools: bcpAbsent, override: "compaction-only" }), "compaction-only");
	assert.equal(foldModeFor(bcpLoaded, "folds"), "live");
	assert.equal(foldModeFor(bcpAbsent, "compaction-only"), "shadow");
});

test("the override contradicts presence only when it forces folds over a loaded billion-context-pi", () => {
	assert.equal(engineOverrideContradictsPresence({ tools: bcpLoaded, override: "folds" }), true);
	assert.equal(engineOverrideContradictsPresence({ tools: bcpLoaded, override: "auto" }), false);
	assert.equal(engineOverrideContradictsPresence({ tools: bcpAbsent, override: "folds" }), false);
	assert.equal(engineOverrideContradictsPresence({ tools: bcpLoaded, override: "compaction-only" }), false);
});

test("the tool surface follows the engine, not the tool list", () => {
	const names = (tools: RegisteredToolView[], override?: "folds" | "compaction-only") =>
		decideContextToolSurface(tools, undefined, resolveContextEngine({ tools, override })).map((entry) => entry.name as string);
	assert.ok(names(bcpAbsent).includes("context_fold"));
	assert.ok(!names(bcpLoaded).includes("context_fold"));
	assert.ok(names(bcpLoaded, "folds").includes("context_fold"), "folds override registers context_fold with billion-context-pi loaded");
	assert.ok(!names(bcpAbsent, "compaction-only").includes("context_fold"), "compaction-only override drops it with none loaded");
});

test("folds.engine in a config file reaches the fold mode and the surface", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-engine-"));
	try {
		fs.writeFileSync(path.join(dir, "context-aware.json"), JSON.stringify({ folds: { engine: "folds" } }));
		const ctx = { cwd: dir, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
		const override = resolveFoldConfig(ctx, dir).engine;
		assert.equal(override, "folds");
		assert.equal(foldModeFor(bcpLoaded, override), "live");
		fs.writeFileSync(path.join(dir, "context-aware.json"), JSON.stringify({ folds: { engine: "bogus" } }));
		assert.equal(resolveFoldConfig(ctx, dir).engine, "auto", "an unknown value falls back to auto");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("no source file other than the resolver and the compaction blocker asks whether billion-context-pi is loaded", () => {
	const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src");
	const offenders: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.ts$/u.test(entry.name) && fs.readFileSync(full, "utf8").includes("isBillionContextPiLoaded(")) offenders.push(path.relative(root, full));
		}
	};
	walk(root);
	assert.deepEqual(offenders.sort(), ["compaction/compaction-blocker.ts", "folds/engine-resolver.ts"]);
});
