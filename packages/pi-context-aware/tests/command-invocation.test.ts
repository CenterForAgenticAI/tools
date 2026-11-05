import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandInvocation } from "../src/seed/command-invocation.js";

test("splits a command name from its argument text without altering the arguments", () => {
	assert.deepEqual(parseCommandInvocation('/handoff "a  b" $1\nnext'), { name: "handoff", argsText: '"a  b" $1\nnext' });
	assert.deepEqual(parseCommandInvocation("/skill:review"), { name: "skill:review", argsText: "" });
});

test("does not treat free text or a path as a command", () => {
	assert.equal(parseCommandInvocation("continue the task"), null);
	assert.equal(parseCommandInvocation("/tmp/build is broken"), null);
	assert.equal(parseCommandInvocation("/"), null);
	assert.equal(parseCommandInvocation(" /handoff"), null);
});
