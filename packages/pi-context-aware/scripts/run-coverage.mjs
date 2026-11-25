#!/usr/bin/env node
/**
 * Run the test files under V8 coverage, prune the raw data, then report.
 *
 * Usage: node scripts/with-temp-root.mjs --v8-coverage node scripts/run-coverage.mjs <test files...>
 *
 * This replaces `c8 node --test ...`. c8 would merge the raw files as Node
 * wrote them; pruning first (see prune-v8-coverage.mjs) keeps the merge well
 * under the heap Node 24 gets in the pi-latest CI container. The report reads
 * c8's settings from package.json as before, including the coverage floors.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { pruneCoverageDirectory } from "./prune-v8-coverage.mjs";

const directory = process.env.NODE_V8_COVERAGE;
if (!directory) {
	console.error("run-coverage: NODE_V8_COVERAGE is not set; run through with-temp-root.mjs --v8-coverage");
	process.exit(2);
}
const testFiles = process.argv.slice(2);
if (testFiles.length === 0) {
	console.error("run-coverage: usage: run-coverage.mjs <test files...>");
	process.exit(2);
}

const tests = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
if (tests.error) throw tests.error;

const { before, after } = pruneCoverageDirectory(directory);
const mb = (bytes) => (bytes / 2 ** 20).toFixed(0);
console.error(`run-coverage: pruned raw V8 coverage from ${mb(before)} MB to ${mb(after)} MB`);

// The report process must not write coverage of its own into the directory
// it is reading.
const env = { ...process.env };
delete env.NODE_V8_COVERAGE;
const c8 = createRequire(import.meta.url).resolve("c8/bin/c8.js");
const report = spawnSync(process.execPath, [c8, "report", "--temp-directory", directory], { stdio: "inherit", env });
if (report.error) throw report.error;

// As c8 does: a failing test run fails the step even when the report passes.
process.exit(tests.status !== 0 ? (tests.status ?? 1) : (report.status ?? 1));
