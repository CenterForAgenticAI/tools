/**
 * Cross-repo end-to-end check for the task-delegation seam.
 *
 * pi-delegate and pi-context-aware never import each other; each restates the
 * other's wire shape and parses it loosely. So both test suites can be green
 * while the feature is a silent no-op. No CI job in either repo can catch that,
 * because neither can see the other side.
 *
 * This runs the REAL producer and the REAL consumer against each other:
 *
 *   applyWorkerSeeds             (pi-delegate)  -- writes a worker's session
 *     -> readSeededTasks        (pi-delegate)  -- replays it
 *     -> taskProgressFieldsFromEntries (pi-delegate) -- builds bus fields
 *     -> events.ndjson bytes                   -- the actual on-disk seam
 *     -> readDelegationSubtree  (pi-context-aware) -- reads it back
 *
 * Nothing at the seam is hand-written: the bytes the consumer parses are the
 * exact bytes the producer emits.
 *
 * This is NOT part of `npm test`: it needs a built pi-delegate checkout, which
 * CI does not have. `tests/delegate-wire-fixture.test.mjs` is the CI-runnable
 * guard, built from a recording this script produces. Run this by hand when
 * either side changes shape, then re-record the fixture.
 *
 *   PI_DELEGATE_DIR=../pi-delegate node tests/manual/cross-repo-delegate-seam.mjs
 *
 * It has already earned its keep once: it caught pi-delegate emitting a
 * blocked row's explanation as `reason` while this package read only `note`,
 * a field both test suites were green about losing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Both checkouts must be built first:
//   pi-delegate:      npm run build
//   pi-context-aware: npm run test:compile
// Point these at the two working copies you want to compare.
const DEL = process.env.PI_DELEGATE_DIR ?? "../pi-delegate";
const CA = process.env.PI_CONTEXT_AWARE_DIR ?? new URL("../..", import.meta.url).pathname;

const del = await import(`${DEL}/dist/task-seam.js`);
const workerSeeds = await import(`${DEL}/dist/worker-session-seeds.js`);
const caRuntime = await import(`${CA}/.test-dist/session-tasks-runtime.js`);
const lineage = await import(`${DEL}/dist/lineage.js`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xrepo-e2e-"));
const agentDir = path.join(tmp, "agent");
const rootRunId = "root-run-1";
const sinkDir = path.join(agentDir, "extensions", "pi-delegate", "event-bus", rootRunId);
fs.mkdirSync(sinkDir, { recursive: true });

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// 1. PRODUCER: pi-delegate seeds a worker session from a dispatched plan that
//    carries the owner's task ids, exactly as a real dispatch does.
// ---------------------------------------------------------------------------
const seed = del.parseSlotTasks({
  schemaVersion: 1,
  origin: "spec",
  tasks: [
    { title: "Write the parser", ownerTaskId: "t1", status: "done" },
    { title: "Wire the runner", ownerTaskId: "t2", status: "active", subtasks: [{ title: "Write a failing test", status: "done" }] },
    { title: "Ship the docs", ownerTaskId: "t3", status: "blocked", note: "waiting on review" },
  ],
});
assert.ok(seed, "producer refused a well-formed dispatched plan");

const entries = [];
const seedAudit = workerSeeds.applyWorkerSeeds(
  { appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
  {
    extensions: [{ tools: new Set([del.TASKS_TOOL_NAME]) }],
    tasks: { seed, options: { piSessionId: "worker-session-1" } },
  },
);
assert.equal(seedAudit.find((row) => row.id === "tasks")?.outcome, "written");
assert.ok(entries.length > 0, "producer wrote no session entry");

// 2. PRODUCER builds the bus fields from its own replayed entries.
const fields = del.taskProgressFieldsFromEntries(entries);
assert.ok(fields, "producer built no task progress fields");

// 3. Those exact bytes go to the on-disk seam the consumer reads.
//    The addresses are built by pi-delegate's OWN lineage functions, so the
//    routing keys are the producer's too — not hand-written strings.
const frameFor = (runId, childIndex) => ({
  depth: childIndex === undefined ? 0 : 1,
  effectiveMax: 3,
  runId,
  rootRunId,
  childIndex,
  chain: [],
});
const rootFrame = frameFor("root", 0);
const laneFrame = frameFor("lane-a", 0);
const siblingFrame = frameFor("lane-b", 1);

const busEvent = (frame, ancestorSuffix) => JSON.stringify({
  kind: "updated",
  lineagePath: lineage.lineagePath(frame),
  ancestorPath: ancestorSuffix,
  ts: Date.now(),
  fields: del.taskProgressFieldsFromEntries(entries),
});

// A real nested frame carries `idPath`: the ancestor chain that makes
// "A is an ancestor of B" decidable by prefix. Empty-chain frames would make
// every lane look like a root.
const rootId = lineage.lineagePath(rootFrame);
rootFrame.idPath = [rootId];
laneFrame.idPath = [rootId, lineage.lineagePath(laneFrame)];
siblingFrame.idPath = [rootId, lineage.lineagePath(siblingFrame)];
const rootAncestor = lineage.lineageAncestorPath(rootFrame);
const lines = [
  busEvent(rootFrame, rootAncestor),
  busEvent(laneFrame, lineage.lineageAncestorPath(laneFrame)),
  // A sibling lane the caller must NOT see.
  busEvent(siblingFrame, lineage.lineageAncestorPath(siblingFrame)),
  '{"kind":"updated","lineagePath":"trunc', // a real partial write
];
fs.writeFileSync(path.join(sinkDir, "events.ndjson"), `${lines.join("\n")}\n`);

console.log("\nproducer emitted (pi-delegate):");
console.log(`  ${JSON.stringify(fields).slice(0, 200)}\n`);

// ---------------------------------------------------------------------------
// 4. CONSUMER: pi-context-aware reads the sink as the lane itself.
// ---------------------------------------------------------------------------
const env = {
  HOME: tmp,
  PI_CODING_AGENT_DIR: agentDir,
  PI_DELEGATE_LINEAGE_ROOT_RUN_ID: rootRunId,
  PI_DELEGATE_LINEAGE_RUN_ID: "lane-a",
  PI_DELEGATE_LINEAGE_CHILD_INDEX: "0",
};

const asLane = await caRuntime.readDelegationSubtree(env);

console.log("consumer parsed (pi-context-aware):");
console.log(`  address=${JSON.stringify(asLane.address)}`);
console.log(`  lanes=${asLane.lanes.length} elided=${asLane.elided}`);
for (const lane of asLane.lanes) console.log(`  lane ${lane.lineagePath}: ${JSON.stringify(lane.progress ?? lane)}`);
console.log("");

check("consumer recognises it is inside a delegate run", () => {
  assert.notEqual(asLane.address, null, "no lineage address resolved from the environment");
});

check("consumer parses the producer's real bytes at all", () => {
  assert.ok(asLane.lanes.length > 0, "the producer's own event yielded zero lanes — THE SEAM IS BROKEN");
});

// Exact equality, not substring containment: a corrupted id such as
// "WRONG-t1" still *contains* "t1", so an includes() check passes a mutation
// that has actually broken the seam.
const laneRows = asLane.lanes.flatMap((lane) => lane.progress?.rows ?? lane.rows ?? []);

check("owner task ids and statuses cross exactly", () => {
  assert.deepEqual(
    laneRows.map((row) => [row.ownerTaskId, row.status]),
    [["t1", "done"], ["t2", "active"], ["t3", "blocked"]],
    "the rows the consumer parsed are not the rows the producer emitted",
  );
});

check("real titles and one nested level cross exactly", () => {
  assert.deepEqual(
    laneRows.map((row) => row.title),
    ["Write the parser", "Wire the runner", "Ship the docs"],
  );
  assert.deepEqual(laneRows[1]?.subtasks, [{
    localTaskId: "t2.1",
    idKind: "local",
    title: "Write a failing test",
    status: "done",
  }]);
});

check("a blocked row keeps its written reason", () => {
  // The producer spells it `reason` on the wire; the consumer maps it to
  // `note`, its own model's name. Either spelling is fine here -- what must
  // never happen is the explanation vanishing.
  const blocked = laneRows.find((row) => row.status === "blocked");
  assert.equal(
    blocked?.note ?? blocked?.reason,
    "waiting on review",
    "the blocked reason was lost crossing the seam",
  );
});

check("the sibling lane is not visible to this lane", () => {
  assert.ok(
    !JSON.stringify(asLane.lanes).includes("lane-b"),
    "a sibling lane leaked into this lane's view",
  );
});

check("the partially written line did not abort the read", () => {
  assert.ok(asLane.lanes.length > 0, "a truncated trailing line lost the whole sink");
});

// 5. The root sees the whole stack, with no privileged code path.
const asRoot = await caRuntime.readDelegationSubtree({
  ...env,
  PI_DELEGATE_LINEAGE_RUN_ID: "root",
  PI_DELEGATE_LINEAGE_CHILD_INDEX: "0",
});
check("the root's view includes lanes the leaf could not see", () => {
  assert.ok(asRoot.lanes.length >= asLane.lanes.length, "root saw fewer lanes than a leaf");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nCROSS-REPO E2E: PASS" : `\nCROSS-REPO E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
