import test from "node:test";
import assert from "node:assert/strict";

import { isFabricChild, seedContinuation, seedContinuationRefusalMessage } from "../src/compaction/seed-continuation.js";

const childLineage = JSON.stringify({ version: 1, rootSessionId: "root", runId: "run-1", depth: 1, childIndex: 0, worker: true });

test("a session without Fabric's child variables is not a Fabric child", () => {
	assert.equal(isFabricChild({}), false);
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "0" }), false, "the root has depth 0");
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "" }), false);
	assert.deepEqual(seedContinuation({}), { available: true });
});

test("Fabric's stable lineage variable marks a child", () => {
	assert.equal(isFabricChild({ PI_FABRIC_LINEAGE: childLineage }), true);
	assert.deepEqual(seedContinuation({ PI_FABRIC_LINEAGE: childLineage }), { available: false, reason: "fabric-child" });
});

test("a child depth marks a child when no lineage is set", () => {
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "1" }), true);
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "3" }), true);
});

test("an unreadable lineage or depth still marks a child, so the run keeps going", () => {
	assert.equal(isFabricChild({ PI_FABRIC_LINEAGE: "{not json" }), true);
	assert.equal(isFabricChild({ PI_FABRIC_LINEAGE: "null" }), true);
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "deep" }), true);
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "-1" }), true, "only 0 is the root");
	assert.equal(isFabricChild({ PI_FABRIC_DEPTH: "0.5" }), true);
});

test("only an explicit root lineage defers to the depth variable", () => {
	const root = JSON.stringify({ version: 1, rootSessionId: "root", runId: "run-0", depth: 0, childIndex: 0, worker: false });
	assert.equal(isFabricChild({ PI_FABRIC_LINEAGE: root }), false);
	assert.equal(isFabricChild({ PI_FABRIC_LINEAGE: root, PI_FABRIC_DEPTH: "2" }), true);
});

// A persistent actor keeps its session file between activations, but each
// activation is an ordinary Fabric child run that Fabric closes once it
// settles: pi-fabric starts it through agents.run with a worker lineage and a
// child depth, and adds PI_FABRIC_ACTOR_ID. Nothing would deliver a seed after
// that run ends, so an actor is refused like any other child. An exemption keyed
// on PI_FABRIC_ACTOR_ID would make this test fail.
test("a persistent actor activation is refused like any other Fabric child", () => {
	const actorEnv = { PI_FABRIC_ACTOR_ID: "actor-reviewer", PI_FABRIC_LINEAGE: childLineage, PI_FABRIC_DEPTH: "1" };
	assert.equal(isFabricChild(actorEnv), true);
	assert.deepEqual(seedContinuation(actorEnv), { available: false, reason: "fabric-child" });
});

test("the refusal tells the model nothing was compacted and to keep working", () => {
	const message = seedContinuationRefusalMessage();
	assert.match(message, /^Refused: context_compact is unavailable in a Fabric child session\./u);
	assert.match(message, /Nothing was compacted\. Keep working and finish your result in this run\.$/u);
	assert.match(seedContinuationRefusalMessage("context_fold"), /use context_fold to fold finished, older ranges\.$/u);
});
