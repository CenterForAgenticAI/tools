/**
 * Transpile src/** and tests/** once so the normal suite executes emitted
 * JavaScript instead of asking every test process to re-transpile TypeScript.
 * Type checking remains in the explicit typecheck scripts.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(projectDirectory, ".test-dist");

rmSync(outputDirectory, { recursive: true, force: true });

const result = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["tsc", "-p", "tsconfig.test.json", "--noCheck", "--pretty", "false"],
	{ cwd: projectDirectory, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
