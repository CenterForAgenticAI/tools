import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMetrics, summarise } from "../scripts/context-metrics-summary.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/context-metrics/", import.meta.url));
const script = fileURLToPath(new URL("../scripts/context-metrics-summary.mjs", import.meta.url));

// Hand-computed from the fixtures: alpha has 3 whole records and a torn fourth line; beta has 2 v1 records and one v2 record.
test("the reader summarises the fixture sessions and tolerates a torn last line and an unknown version", () => {
	const summary = summarise(["alpha", "beta"].flatMap((name) => parseMetrics(readFileSync(`${fixtures}${name}.jsonl`, "utf8"))));
	const [alpha, beta] = summary.sessions;
	assert.equal(alpha.requests, 3);
	assert.equal(alpha.folds, 2);
	assert.equal(alpha.requested, 3);
	assert.deepEqual(alpha.refused, { "summary-short": 1 });
	assert.deepEqual(alpha.dropped, { "branch-changed": 1 });
	assert.deepEqual(alpha.foldPressures, [0.5, 0.75]);
	assert.equal(alpha.compactions, 1);
	assert.equal(alpha.cacheReadShare, 350 / 600);
	assert.equal(beta.requests, 2);
	assert.deepEqual(beta.refused, { "unknown-ref": 2 });
	assert.deepEqual(beta.foldPressures, [0.6]);
	assert.equal(beta.cacheReadShare, 0.5);
	assert.equal(summary.total.requests, 5);
	assert.equal(summary.total.folds, 3);
	assert.equal(summary.total.cacheReadShare, 450 / 800);
});

test("the command prints a summary for a directory and fails without arguments", () => {
	const ok = spawnSync(process.execPath, [script, fixtures], { encoding: "utf8" });
	assert.equal(ok.status, 0);
	assert.match(ok.stdout, /alpha: 3 requests, 2 folds accepted of 3 requested, 1 compactions, cache-read 58\.3%/u);
	assert.match(ok.stdout, /pressure at each fold: 0\.50 0\.75/u);
	assert.match(ok.stdout, /total: 2 sessions, 5 requests/u);
	assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
});
