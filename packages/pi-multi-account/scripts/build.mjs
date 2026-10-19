#!/usr/bin/env node
// Bundles the Pi extension entry into one ESM file.
//
// Pi loads `pi.extensions` through jiti, which resolves, transforms and wraps
// every module separately. Loading `src/index.ts` meant about 130 files and
// roughly 290 ms more on every Pi start than one bundled file.
//
// Only the entry is bundled. Dependencies stay external so the host's own
// module instances still serve `@earendil-works/*` and `typebox`. The two
// vendored forks under `packages/` are loaded at run time by variable
// specifiers relative to the module (`../packages/...`), and the plan catalog
// is read from `../config/`. Both resolve the same from `dist/` as from `src/`,
// so the bundle must stay exactly one directory below the package root.
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Source entry and the bundle `package.json` names in `pi.extensions`. */
export const ENTRY_SOURCE = "src/index.ts";
export const ENTRY_OUTFILE = "dist/index.js";

/** esbuild options shared by the build and by tests that inspect the bundle. */
export function bundleOptions(root = PACKAGE_ROOT) {
	return {
		absWorkingDir: root,
		entryPoints: [join(root, ENTRY_SOURCE)],
		outfile: join(root, ENTRY_OUTFILE),
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		target: "node22",
		// Not minified: identifiers stay readable in stack traces, and minifying
		// saved only another 16 ms.
		sourcemap: "linked",
		sourcesContent: false,
		logLevel: "error",
	};
}

/** Writes `dist/index.js` and its source map. */
export async function buildExtension(root = PACKAGE_ROOT) {
	const { build } = await import("esbuild");
	await build(bundleOptions(root));
	return join(root, ENTRY_OUTFILE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildExtension();
}
