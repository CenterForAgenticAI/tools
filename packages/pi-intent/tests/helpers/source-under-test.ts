/**
 * Locate artifacts a test is actually running against. npm test runs emitted
 * JavaScript from .test-dist/, while source-mode iteration runs TypeScript
 * directly through tsx.
 *
 * Dynamic module paths and child loader arguments must use this helper because
 * TypeScript cannot rewrite a string literal such as new URL("../../src/x.ts",
 * import.meta.url), and compiled children do not need --import tsx. Tests that
 * inspect committed TypeScript use REPO_ROOT so they never read .test-dist.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNING_COMPILED = import.meta.url.endsWith(".js");
export const SOURCE_EXTENSION = RUNNING_COMPILED ? ".js" : ".ts";

export const REPO_ROOT = (() => {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	return path.basename(packageRoot) === ".test-dist" ? path.dirname(packageRoot) : packageRoot;
})();

export function sourceModuleUrl(moduleName: string): string {
	return new URL(`../../src/${moduleName}${SOURCE_EXTENSION}`, import.meta.url).href;
}

export function childLoaderArgs(): string[] {
	return RUNNING_COMPILED ? [] : ["--import", "tsx"];
}

export function repoSourcePath(...segments: string[]): string {
	return path.join(REPO_ROOT, "src", ...segments);
}
