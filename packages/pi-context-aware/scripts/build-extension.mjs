#!/usr/bin/env node
// Bundles the Pi extension entry into one ESM file, `dist/extension.js`.
//
// Pi loads `pi.extensions` through jiti. With the tsc output that meant Node
// resolving, linking and compiling about 150 separate modules on every start.
//
// `npm run build` runs tsc first. The tsc output stays: it serves the package
// exports (`.` and `./context-service`, with their declarations), and its
// `dist/folds/` files are what the parity fingerprint hashes. The entry passes
// that directory explicitly, because the fingerprint's own default resolves
// relative to its module, which no longer exists inside a bundle.
//
// Packages stay external, so the host's own module instances still serve
// `@earendil-works/*` and `typebox`. The bundle sits directly in `dist/`, so
// paths resolved from `import.meta.url` (`./folds/`, the package root two
// levels up from `dist/compaction/`) keep their meaning.
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Source entry, and the bundle `package.json` names in `pi.extensions`. */
export const ENTRY_SOURCE = "src/index.ts";
export const ENTRY_OUTFILE = "dist/extension.js";

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
		// Not minified: identifiers stay readable in stack traces.
		sourcemap: "linked",
		sourcesContent: false,
		logLevel: "error",
	};
}

/** Writes `dist/extension.js` and its source map. */
export async function buildExtension(root = PACKAGE_ROOT) {
	const { build } = await import("esbuild");
	await build(bundleOptions(root));
	return join(root, ENTRY_OUTFILE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await buildExtension();
}
