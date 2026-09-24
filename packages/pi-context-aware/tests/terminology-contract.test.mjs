import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PROJECT_ROOT = new URL("../", import.meta.url);
const ACTIVE_AGENT_FACING_SURFACES = readdirSync(PROJECT_ROOT, { withFileTypes: true })
	.filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".ts")))
	.map((entry) => entry.name)
	.sort();
const RETIRED_GENERIC_FORK_PHRASES = [
	/\b(?:delegate(?:d)?|worker|reviewer|tester) forks?\b/i,
	/\b(?:nothing in|useful to) a fork\b/i,
	/\bsessions and forks\b/i,
	/\b(?:recognisable|unrecognisable) forks?\b/i,
	/\bowner-?less child fork\b/i,
	/\ba fork has no user\b/i,
	/\btelling a fork\b/i,
];

function terminologyDrift(text) {
	return RETIRED_GENERIC_FORK_PHRASES.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

test("the guard inventory includes every top-level source and document", () => {
	assert.ok(ACTIVE_AGENT_FACING_SURFACES.length > 10, "the active-surface inventory must not be vacuous");
	for (const file of ["README.md", "index.ts", "session-tasks-runtime.ts", "session-tasks-view.ts", "worker-compaction-contract.ts"]) {
		assert.ok(ACTIVE_AGENT_FACING_SURFACES.includes(file), file);
	}
});

test("active agent-facing surfaces distinguish delegated runs from worker sessions", () => {
	const drift = ACTIVE_AGENT_FACING_SURFACES.flatMap((file) => {
		const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		return terminologyDrift(text).map((pattern) => ({ file, pattern }));
	});
	assert.deepEqual(drift, []);
});

test("the terminology guard rejects retired generic fork wording", () => {
	for (const phrase of [
		"delegated fork",
		"worker fork",
		"nothing in a fork",
		"useful to a fork",
		"sessions and forks",
		"no recognisable forks",
		"an unrecognisable fork",
		"owner-less child fork",
		"a fork has no user",
		"telling a fork",
	]) {
		assert.notDeepEqual(terminologyDrift(phrase), [], phrase);
	}
	for (const phrase of ["delegated run", "worker session", "sessions/forks/context/", "resume, fork, or clone"]) {
		assert.deepEqual(terminologyDrift(phrase), [], phrase);
	}
});
