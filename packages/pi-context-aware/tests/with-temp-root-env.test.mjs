import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "with-temp-root.mjs");

/** Run a one-line script under the wrapper and return what it printed. */
function runUnderWrapper(env) {
	const result = spawnSync(
		process.execPath,
		[wrapper, process.execPath, "-e", "process.stdout.write(process.env.PI_CODING_AGENT_DIR ?? '<unset>')"],
		{ env: { ...process.env, ...env }, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("a test run does not inherit the operator's live Pi agent directory", () => {
	assert.equal(runUnderWrapper({ PI_CODING_AGENT_DIR: "/nonexistent/live-profile" }), "<unset>");
});
