import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

import { bundleOptions, ENTRY_OUTFILE, ENTRY_SOURCE, PACKAGE_ROOT } from "../scripts/build-extension.mjs";

// Pi loads one bundled file instead of about 150 tsc output modules.
// Issue #182.

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

test("Pi loads the bundled entry, every build writes it, and the exports stay on tsc output", () => {
	assert.deepEqual(manifest.pi?.extensions, [`./${ENTRY_OUTFILE}`]);
	assert.match(manifest.scripts.build, /^tsc -p tsconfig\.build\.json && .* && node scripts\/build-extension\.mjs$/u);
	assert.equal(manifest.scripts.prepare, "npm run build");
	assert.ok(manifest.files.includes(dirname(ENTRY_OUTFILE)), "the bundle's directory ships");
	assert.equal(manifest.exports["."].import, "./dist/index.js");
	assert.equal(manifest.exports["./context-service"].import, "./dist/context-service.js");
});

test("the bundle holds all source and resolves module-relative paths from dist/", async () => {
	const result = await build({ ...bundleOptions(), write: false, metafile: true });
	const output = result.metafile.outputs[ENTRY_OUTFILE];
	assert.ok(output, `esbuild wrote no ${ENTRY_OUTFILE}`);
	assert.equal(output.entryPoint, ENTRY_SOURCE);
	const relativeExternals = output.imports.filter((entry) => entry.external && /^[./]/u.test(entry.path)).map((entry) => entry.path);
	assert.deepEqual(relativeExternals, [], "only packages stay outside the bundle");

	const bundle = result.outputFiles.find((file) => file.path === join(PACKAGE_ROOT, ENTRY_OUTFILE));
	assert.ok(bundle, `esbuild produced no ${ENTRY_OUTFILE}`);
	// Inside the bundle, import.meta.url is dist/extension.js for every module.
	// tsc mirrors src/ into dist/, so each such path must exist relative to src/.
	const moduleRelative = [...bundle.text.matchAll(/new URL\("([^"]+)", import\.meta\.url\)/gu)].map((match) => match[1]);
	assert.ok(moduleRelative.includes("./folds/"), "the entry passes the fold engine directory");
	assert.deepEqual(moduleRelative.filter((relative) => !existsSync(resolve(PACKAGE_ROOT, "src", relative))), []);
});
