import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testDirectory = path.resolve(".test-dist/tests/unit");
// coverage-exclusions.test.js only checks repository coverage configuration,
// which the public export intentionally omits. Non-Linux hosts also cannot
// exercise the verifier's Linux process-containment integration.
const excludedFiles = new Set([
	"coverage-exclusions.test.js",
	...(process.platform === "linux" ? [] : [
		"status-cache.test.js",
		"verify-command.test.js",
		"verify-tree.test.js",
		"verify-vacuous-green.test.js",
	]),
]);
const files = (await readdir(testDirectory))
	.filter((file) => file.endsWith(".test.js") && !excludedFiles.has(file))
	.map((file) => path.join(testDirectory, file));
const result = spawnSync(
	process.execPath,
	["--test", "--test-concurrency=1", ...files],
	{
		env: { ...process.env, TMPDIR: realpathSync(os.tmpdir()) },
		stdio: "inherit",
	},
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
