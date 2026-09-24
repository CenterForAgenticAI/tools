import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Structural guards for issue #92. Generated refusal fallback is derived only
// from current durable state or the current compaction summary. Historical user
// prompts are not an eligible fallback source anywhere in the extension.

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const guardSource = readFileSync(new URL("../seed-authority.ts", import.meta.url), "utf8");

/** Every `lastGroundedSeed(` reference that is neither a function definition nor a line comment. */
function rawCallLines(text) {
	const hits = [];
	text.split("\n").forEach((line, index) => {
		const code = line.replace(/\/\/.*$/u, "");
		if (!/\blastGroundedSeed\s*\(/u.test(code)) return;
		if (/\bfunction\s+lastGroundedSeed\s*\(/u.test(code)) return;
		hits.push({ lineNumber: index + 1, text: line.trim() });
	});
	return hits;
}

test("REQ-5: no generated refusal path can read a historical grounded prompt", () => {
	const calls = rawCallLines(source);
	assert.deepEqual(
		calls,
		[],
		`lastGroundedSeed calls make stale-history replay reachable. Found: ${JSON.stringify(calls, null, 2)}`,
	);
	assert.doesNotMatch(source, /\bfunction\s+lastGroundedSeed\s*\(/u);
});

test("REQ-7: repository-switch is not advertised as a reachable diagnostic without a candidate target", () => {
	assert.doesNotMatch(`${source}\n${guardSource}`, /["']repository-switch["']/u);
});

// Behavioural explicit-seed preservation is asserted at the /compact-then seam.
// The branded SeedRefusal type remains the compile-time guard that prevents a
// caller from relabelling an explicit seed as generated.
