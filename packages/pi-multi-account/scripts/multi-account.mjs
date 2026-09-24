#!/usr/bin/env node
// The published `multi-account` bin entry.
//
// This package ships raw TypeScript (see `package.json`'s `"exports":
// "./src/index.ts"`); it is never compiled to `dist/*.js`. Every module under
// `src/` uses NodeNext-style relative specifiers -- `import "./config.js"` --
// that point at a ".ts" sibling, exactly as `tsc -p tsconfig.json` requires.
// The Pi coding-agent host and Vitest both already know how to resolve that;
// a bare `node` invocation of this standalone launcher does not, and this
// package intentionally carries no `tsx`/`ts-node`-class dependency.
//
// So this file installs a small, synchronous Node module-customization hook
// (see https://nodejs.org/api/module.html#module-registerhooksoptions) that
// redirects a relative ".js" specifier to its ".ts" sibling when one exists,
// then hands off to `runStandaloneCli`. `module.registerHooks()` installs
// in-thread and takes effect immediately for every module resolution issued
// afterward in this same realm -- including this file's own dynamic import
// below -- so, unlike the async, loader-thread `module.register()` API this
// replaced, no `--import` preload and no re-exec are needed to avoid a race
// against that import. (`module.register()` also emits Node's DEP0205
// deprecation warning to stderr as of Node 26, which broke this CLI's
// documented empty-stderr contract on a clean run; `registerHooks()` has no
// such warning on any currently supported Node major.)
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try {
				return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
			} catch {
				// No ".ts" sibling: fall through to normal resolution below, which
				// will raise Node's own not-found error for a genuinely missing
				// specifier.
			}
		}
		return nextResolve(specifier, context);
	},
});

const { runStandaloneCli } = await import(
	new URL("../src/standalone-cli.ts", import.meta.url)
);
process.exitCode = await runStandaloneCli(process.argv.slice(2));
