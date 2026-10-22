import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	BILLION_CONTEXT_PI_BLOCKER,
	detectCompactionBlocker,
	type RegisteredToolView,
} from "../src/compaction/compaction-blocker.js";
import { foldModeFor } from "../src/folds/fold-engine.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";

// This file compiles to <root>/.test-dist/tests/, so the package root is two levels up.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Pi gives a package-loaded extension the path of its pi.extensions entry.
const OWN_BUNDLE = path.join(PACKAGE_ROOT, "dist", "extension.js");
const OWN_SOURCE_ENTRY = path.join(PACKAGE_ROOT, "src", "index.ts");
const BCP_PATH = "/profile/node_modules/billion-context-pi/dist/index.js";
const plainHost = { env: {}, modelBaseUrl: "https://api.anthropic.com" };

const signatureFrom = (sourcePath: string): RegisteredToolView[] => [
	{ name: "read", sourceInfo: { path: "builtin:read" } },
	{ name: "compress", sourceInfo: { path: sourcePath } },
	{ name: "acp_status", sourceInfo: { path: sourcePath } },
];

test("REQ-192-1: compress and acp_status from this extension's own source path are not billion-context-pi", () => {
	for (const own of [OWN_BUNDLE, OWN_SOURCE_ENTRY]) {
		const tools = signatureFrom(own);
		assert.equal(foldModeFor(tools), "live", own);
		assert.equal(detectCompactionBlocker(tools, plainHost), undefined, own);
	}
	// `pi -e ./dist/extension.js` keeps the path as given and records where it resolved.
	const relative = { path: "./dist/extension.js", baseDir: path.join(PACKAGE_ROOT, "dist") };
	const tools = [{ name: "compress", sourceInfo: relative }, { name: "acp_status", sourceInfo: relative }];
	assert.equal(foldModeFor(tools), "live");
	assert.equal(detectCompactionBlocker(tools, plainHost), undefined);
});

test("REQ-192-1: the same pair from any other source path is still billion-context-pi", () => {
	const others = [
		BCP_PATH,
		// A copy installed under this package's own node_modules is another package.
		path.join(PACKAGE_ROOT, "node_modules", "billion-context-pi", "dist", "index.js"),
		// Inline factories have synthetic paths. Resolved against a cwd at the package
		// root they would land inside it, but they name no file of this package.
		"<inline:2>",
	];
	for (const other of others) {
		const tools = signatureFrom(other);
		assert.equal(foldModeFor(tools), "shadow", other);
		assert.deepEqual(detectCompactionBlocker(tools, plainHost), BILLION_CONTEXT_PI_BLOCKER, other);
	}
});
const bcpLoaded = signatureFrom(BCP_PATH);
const bcpAbsent: RegisteredToolView[] = [{ name: "read", sourceInfo: { path: "builtin:read" } }];
const exposures = (tools: readonly RegisteredToolView[], host = plainHost) =>
	Object.fromEntries(decideContextToolSurface(tools, detectCompactionBlocker(tools, host)).map((entry) => [entry.name, entry.exposure]));

test("REQ-192-2: with billion-context-pi loaded, the new names and our old names register, and none of its names", () => {
	const surface = decideContextToolSurface(bcpLoaded, detectCompactionBlocker(bcpLoaded, plainHost));
	assert.deepEqual(surface.map((entry) => entry.name).sort(), [
		"compact_session",
		"context_compact",
		"context_recall",
		"context_status",
		"search_prior_sessions",
		"session_compaction_history",
		"session_recall",
	]);
});

test("REQ-192-2: billion-context-pi standing down still keeps its names, because they are still registered", () => {
	const names = Object.keys(exposures(bcpLoaded, { env: { BILLION_CONTEXT_NATIVE: "1" }, modelBaseUrl: "https://api.anthropic.com" }));
	for (const name of ["compress", "decompress", "search_context", "acp_status"]) assert.ok(!names.includes(name), name);
});

test("REQ-192-3: without billion-context-pi, its four names also register, and every old name is deferred", () => {
	assert.deepEqual(exposures(bcpAbsent), {
		context_recall: "direct",
		context_status: "direct",
		context_compact: "direct",
		context_fold: "direct",
		search_prior_sessions: "deferred",
		session_recall: "deferred",
		session_compaction_history: "deferred",
		compact_session: "deferred",
		compress: "deferred",
		decompress: "deferred",
		search_context: "deferred",
		acp_status: "deferred",
	});
});

test("REQ-192-3: our own compress and acp_status aliases do not withdraw billion-context-pi's names at the next session", () => {
	const afterOwnAliases = [...bcpAbsent, ...signatureFrom(OWN_BUNDLE).slice(1)];
	assert.deepEqual(exposures(afterOwnAliases), exposures(bcpAbsent));
});

test("REQ-192-3: each alias names the new tool it stands for", () => {
	const aliases = Object.fromEntries(decideContextToolSurface(bcpAbsent, undefined).map((entry) => [entry.name, entry.aliasOf]));
	assert.deepEqual(aliases, {
		context_recall: undefined,
		context_status: undefined,
		context_compact: undefined,
		context_fold: undefined,
		search_prior_sessions: "context_recall",
		session_recall: "context_recall",
		session_compaction_history: "context_status",
		compact_session: "context_compact",
		compress: "context_fold",
		decompress: "context_recall",
		search_context: "context_recall",
		acp_status: "context_status",
	});
});

test("REQ-192-4: acp_cache is never listed; context_fold only without billion-context-pi (pi-context-aware#189)", () => {
	for (const tools of [bcpLoaded, bcpAbsent]) {
		for (const blocker of [undefined, BILLION_CONTEXT_PI_BLOCKER]) {
			const names = decideContextToolSurface(tools, blocker).map((entry) => entry.name);
			assert.ok(!names.includes("acp_cache" as never));
			assert.equal(names.includes("context_fold"), tools === bcpAbsent);
		}
	}
});

test("REQ-192-4: context_compact and compact_session are hidden while a compaction blocker is present", () => {
	const blocked = exposures(bcpLoaded);
	assert.equal(blocked.context_compact, "hidden");
	assert.equal(blocked.compact_session, "hidden");
	assert.equal(blocked.context_recall, "direct");
	assert.equal(blocked.context_status, "direct");
	assert.equal(blocked.search_prior_sessions, "deferred");

	const standingDown = exposures(bcpLoaded, { env: { BILLION_CONTEXT_NATIVE: "1" }, modelBaseUrl: "https://api.anthropic.com" });
	assert.equal(standingDown.context_compact, "direct");
	assert.equal(standingDown.compact_session, "deferred");
});
