import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BILLION_CONTEXT_PI_BLOCKER, detectCompactionBlocker } from "../src/compaction/compaction-blocker.js";

const billionContextSource = { path: "/profile/node_modules/billion-context-pi/dist/index.js" };
const signatureTools = [
	{ name: "read" },
	{ name: "compress", sourceInfo: billionContextSource },
	{ name: "acp_status", sourceInfo: billionContextSource },
];
const plainHost = { env: {}, modelBaseUrl: "https://api.anthropic.com" };
// This file compiles to <root>/.test-dist/tests/, so the package root is two levels up.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("billion-context-pi's compress and acp_status tools mark compaction as blocked", () => {
	assert.deepEqual(detectCompactionBlocker(signatureTools, plainHost), BILLION_CONTEXT_PI_BLOCKER);
	assert.deepEqual(
		detectCompactionBlocker([{ name: "compress" }, { name: "acp_status" }], { env: {} }),
		BILLION_CONTEXT_PI_BLOCKER,
		"hosts that omit source metadata still match on the tool pair",
	);
});

test("one signature tool alone, or the pair from two extensions, is not billion-context-pi", () => {
	assert.equal(detectCompactionBlocker([{ name: "compress", sourceInfo: billionContextSource }], plainHost), undefined);
	assert.equal(detectCompactionBlocker([{ name: "acp_status" }], plainHost), undefined);
	assert.equal(detectCompactionBlocker([
		{ name: "compress", sourceInfo: { path: "/profile/node_modules/other-compressor/index.js" } },
		{ name: "acp_status", sourceInfo: billionContextSource },
	], plainHost), undefined);
	assert.equal(detectCompactionBlocker([], plainHost), undefined);
});

test("billion-context-pi's documented stand-down cases leave compaction available", () => {
	assert.equal(detectCompactionBlocker(signatureTools, { env: { BILLION_CONTEXT_NATIVE: "omp" } }), undefined);
	assert.equal(detectCompactionBlocker(signatureTools, { env: { BILLION_CONTEXT_PROXY: "1" } }), undefined);
	assert.equal(detectCompactionBlocker(signatureTools, {
		env: {},
		modelBaseUrl: "http://localhost:8787/bili/https://api.anthropic.com",
	}), undefined);
	assert.deepEqual(
		detectCompactionBlocker(signatureTools, { env: { BILLION_CONTEXT_NATIVE: "", BILLION_CONTEXT_PROXY: "" } }),
		BILLION_CONTEXT_PI_BLOCKER,
		"empty variables do not stand billion-context-pi down",
	);
	assert.deepEqual(
		detectCompactionBlocker(signatureTools, { env: {}, modelBaseUrl: "https://example.com/bili" }),
		BILLION_CONTEXT_PI_BLOCKER,
		"a /bili path without an upstream URL is not the proxy",
	);
	assert.deepEqual(
		detectCompactionBlocker(signatureTools, { env: {}, modelBaseUrl: "not a url" }),
		BILLION_CONTEXT_PI_BLOCKER,
	);
});

// pi-context-aware#272: Pi lists only the first tool registered under a name, so when this extension's compress and acp_status come
// first, billion-context-pi is visible only through the tools it alone registers. acp_cache is one.
const ownBundle = path.join(PACKAGE_ROOT, "dist", "extension.js");
const ownAliases = [
	{ name: "compress", sourceInfo: { path: ownBundle } },
	{ name: "acp_status", sourceInfo: { path: ownBundle } },
];
const maskedTools = [...ownAliases, { name: "acp_cache", sourceInfo: billionContextSource }];

test("billion-context-pi behind this extension's own compress and acp_status still marks compaction as blocked", () => {
	assert.deepEqual(detectCompactionBlocker(maskedTools, plainHost), BILLION_CONTEXT_PI_BLOCKER);
	assert.deepEqual(detectCompactionBlocker([{ name: "acp_cache", sourceInfo: billionContextSource }], plainHost), BILLION_CONTEXT_PI_BLOCKER);
	assert.deepEqual(detectCompactionBlocker([{ name: "acp_cache" }], { env: {} }), BILLION_CONTEXT_PI_BLOCKER, "hosts that omit source metadata still match on acp_cache");
});

test("without acp_cache, this extension's own aliases and a partial billion-context-pi are not a blocker", () => {
	assert.equal(detectCompactionBlocker(ownAliases, plainHost), undefined);
	assert.equal(detectCompactionBlocker([...ownAliases, { name: "decompress", sourceInfo: billionContextSource }], plainHost), undefined);
});

test("an acp_cache from a file of this package is not billion-context-pi", () => {
	assert.equal(detectCompactionBlocker([{ name: "acp_cache", sourceInfo: { path: ownBundle } }], plainHost), undefined);
});

test("the stand-down cases also leave compaction available when billion-context-pi is detected through acp_cache", () => {
	assert.equal(detectCompactionBlocker(maskedTools, { env: { BILLION_CONTEXT_NATIVE: "omp" } }), undefined);
	assert.equal(detectCompactionBlocker(maskedTools, { env: { BILLION_CONTEXT_PROXY: "1" } }), undefined);
	assert.equal(detectCompactionBlocker(maskedTools, { env: {}, modelBaseUrl: "http://localhost:8787/bili/https://api.anthropic.com" }), undefined);
});
