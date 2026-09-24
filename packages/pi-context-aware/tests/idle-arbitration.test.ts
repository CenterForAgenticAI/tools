import test from "node:test";
import assert from "node:assert/strict";
import { arbitrateQueuedInteraction, mayRunQueuedInteraction } from "../idle-arbitration.js";

test("queued interactions run at an idle boundary", () => {
	assert.deepEqual(arbitrateQueuedInteraction({ isIdle: true }), { mayRun: true, waitFor: "none" });
	assert.equal(mayRunQueuedInteraction({ isIdle: true }), true);
});

test("queued interactions wait for agent_settled while a turn is active", () => {
	assert.deepEqual(arbitrateQueuedInteraction({ isIdle: false }), { mayRun: false, waitFor: "agent_settled" });
	assert.equal(mayRunQueuedInteraction({ isIdle: false }), false);
});
