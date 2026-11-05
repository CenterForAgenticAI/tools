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
// Pi gives a package-loaded extension the path of its pi.extensions entry, the
// .ts wrapper; `pi -e ./dist/extension.js` gives the bundle's path.
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

const ALL_EIGHT = [
	"search_prior_sessions",
	"session_recall",
	"session_compaction_history",
	"compact_session",
	"compress",
	"decompress",
	"search_context",
	"acp_status",
];

test("AC-196-1: with billion-context-pi loaded, only the three context tools register", () => {
	const surface = decideContextToolSurface(bcpLoaded, detectCompactionBlocker(bcpLoaded, plainHost));
	assert.deepEqual(surface.map((entry) => entry.name).sort(), ["context_compact", "context_recall", "context_status"]);
});

test("AC-196-1: without billion-context-pi, only the four context tools register, all direct", () => {
	assert.deepEqual(exposures(bcpAbsent), {
		context_recall: "direct",
		context_status: "direct",
		context_compact: "direct",
		context_fold: "direct",
	});
});

test("AC-196-1: none of the eight old names is listed in any mode, with or without a blocker", () => {
	for (const tools of [bcpLoaded, bcpAbsent]) {
		for (const blocker of [undefined, BILLION_CONTEXT_PI_BLOCKER]) {
			const names = decideContextToolSurface(tools, blocker).map((entry) => entry.name as string);
			for (const old of ALL_EIGHT) assert.ok(!names.includes(old), old);
		}
	}
});

test("AC-196-2: context_fold registers only without billion-context-pi; acp_cache is never listed (pi-context-aware#189)", () => {
	for (const tools of [bcpLoaded, bcpAbsent]) {
		for (const blocker of [undefined, BILLION_CONTEXT_PI_BLOCKER]) {
			const names = decideContextToolSurface(tools, blocker).map((entry) => entry.name as string);
			assert.ok(!names.includes("acp_cache"));
			assert.equal(names.includes("context_fold"), tools === bcpAbsent);
		}
	}
});

test("REQ-192-4: context_compact is hidden while a compaction blocker is present, and the other tools stay direct", () => {
	const blocked = exposures(bcpLoaded);
	assert.equal(blocked.context_compact, "hidden");
	assert.equal(blocked.context_recall, "direct");
	assert.equal(blocked.context_status, "direct");

	const standingDown = exposures(bcpLoaded, { env: { BILLION_CONTEXT_NATIVE: "1" }, modelBaseUrl: "https://api.anthropic.com" });
	assert.equal(standingDown.context_compact, "direct");
});

// pi-context-aware#272. This extension no longer registers compress or acp_status, so a tool list that holds them
// comes from billion-context-pi. Its acp_cache is listed whichever extension registered first.
test("foldModeFor over each shape of billion-context-pi's tool list", () => {
	const at = (name: string, sourcePath: string): RegisteredToolView => ({ name, sourceInfo: { path: sourcePath } });
	const bcp = (names: string[]) => names.map((name) => at(name, BCP_PATH));
	assert.equal(foldModeFor([]), "live");
	assert.equal(foldModeFor([at("context_fold", OWN_BUNDLE)]), "live");
	assert.equal(foldModeFor(signatureFrom(BCP_PATH)), "shadow");
	assert.equal(foldModeFor([at("context_fold", OWN_BUNDLE), ...bcp(["compress", "acp_status"])]), "shadow");
	assert.equal(foldModeFor(bcp(["compress", "decompress", "search_context", "acp_status", "acp_cache"])), "shadow");
	// Half a pair is not billion-context-pi.
	assert.equal(foldModeFor([at("compress", BCP_PATH)]), "live");
	// Two unrelated extensions that each register one of the names are not billion-context-pi.
	assert.equal(foldModeFor([at("compress", BCP_PATH), at("acp_status", "/other/index.js")]), "live");
	// An acp_cache from a file of this package is not billion-context-pi's; one from any other source is.
	assert.equal(foldModeFor([at("acp_cache", OWN_BUNDLE)]), "live");
	assert.equal(foldModeFor([at("acp_cache", BCP_PATH)]), "shadow");
});
