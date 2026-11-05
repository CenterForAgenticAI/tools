import test from "node:test";
import assert from "node:assert/strict";
import { readConfigLayer, resolveConfigLayers } from "../src/platform/config-layers.js";

test("context metrics default on, with the 4 MiB file and 64 MiB directory caps", () => {
	const config = resolveConfigLayers([]).config.contextMetrics;
	assert.deepEqual(config, { enabled: true, maxBytes: 4 * 1024 * 1024, maxDirBytes: 64 * 1024 * 1024 });
});

test("contextMetrics.enabled can switch the log off, and a bad cap is rejected", () => {
	const off = resolveConfigLayers([readConfigLayer({ contextMetrics: { enabled: false } }, "global")]).config.contextMetrics;
	assert.equal(off?.enabled, false);
	const bad = readConfigLayer({ contextMetrics: { maxBytes: 3 } }, "global");
	assert.deepEqual(bad.rejected, ["contextMetrics.maxBytes"]);
});
