import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { FABRIC_DISPATCH_PROGRAM_DIGEST } from "../../src/dispatch/fabric/program.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { emptyStatusCache, statusCachePath } from "../../src/status/cache.ts";
import { type WorkDispatchDetails, createWorkDispatchTool } from "../../src/tools/work-dispatch.ts";
import { type WorkVerifyDetails, createWorkVerifyTool } from "../../src/tools/work-verify.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden6-")));
 const root = path.join(container, "owner");
 await mkdir(path.join(root, "src"), { recursive: true });
 await writeFile(path.join(root, "src/owned.ts"), "original\n");
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\n");
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden6\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [src/owned.ts]\n    acceptance:\n      - id: confirm\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 const commit = git(["rev-parse", "HEAD"]).trim();
 const worker = path.join(container, "worker");
 git(["worktree", "add", "-qb", "worker", worker]);
 const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "harden6", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
 const target = { path: "spec.yaml", worktreePath: root, expectedCommit: commit };
 return { container, root, worker, commit, ctx, target, cachePath: statusCachePath(root, path.join(root, "spec.yaml")) };
}

async function dispatch(f: Awaited<ReturnType<typeof fixture>>, mutate: () => Promise<void> = async () => {}) {
 const backend = createFabricDispatchBackend({ projectRoot: f.root, events: { emit(_channel, data) {
  const request = data as FabricProgramRunRequest;
  assert.equal(request.input.worktree, true);
  void mutate().then(() => request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden6-run", status: "completed", model: "test/model", worktreeResult: { path: f.worker, branch: "worker", baseRef: f.commit }, value: { changedPaths: [], commit: f.commit, evidence: "not proof", checklist: [], gaps: "" } } }), error => request.reply({ ok: false, error: String(error) }));
 } } });
 const tool = createWorkDispatchTool({ fabricHost: { dispatch(input) {
  return backend.dispatch({ ...input, plan: { ...input.plan, canonicalDelegate: { runs: [{ ...input.plan.canonicalDelegate.runs[0], worktree: true }] } } });
 } } });
 return (await tool.execute("dispatch", { ...f.target, nodeAddress: ["node"] }, undefined, undefined, f.ctx)).details as WorkDispatchDetails;
}

for (const mutation of ["none", "owned", "outside", "bootstrap", "cache"] as const) {
 test(`source-checkout-confinement: ${mutation} source mutation with separate worker tree`, async () => {
  const f = await fixture();
  try {
   await mkdir(path.dirname(f.cachePath), { recursive: true });
   await writeFile(f.cachePath, JSON.stringify(emptyStatusCache(path.join(f.root, "spec.yaml"))));
   const details = await dispatch(f, async () => {
    if (mutation === "outside") await writeFile(path.join(f.root, "careless.txt"), "outside");
    if (mutation === "owned") await writeFile(path.join(f.root, "src/owned.ts"), "allowed");
    if (mutation === "bootstrap") await writeFile(path.join(f.root, ".pi/fabric/programs", `${FABRIC_DISPATCH_PROGRAM_DIGEST}.json`), "rewritten");
    if (mutation === "cache") await writeFile(f.cachePath, "{broken");
   });
   const allowed = mutation === "none" || mutation === "owned";
   assert.equal(details.outcome, allowed ? "dispatched" : "indeterminate", JSON.stringify(details));
   if (!allowed) {
    assert.match(JSON.stringify(details.findings), /outside declared touches/);
    assert.equal("receipt" in details, false);
   }
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

for (const backend of [undefined, "pi-delegate"] as const) {
 for (const corruption of ["parse", "read"] as const) {
  test(`unrelated-cache-ignored: ${backend ?? "standalone"} with unrelated ${corruption} cache`, async () => {
   const f = await fixture();
   try {
    if (backend) {
     const cache = { ...emptyStatusCache(path.join(f.worker, "spec.yaml")), dispatch: { run: {
      runId: "run", forkName: "worker", nodeId: "node", address: ["node"], createdAt: "2026-10-06T00:00:00.000Z", worktreePath: f.worker, headCommit: f.commit, branch: "worker", briefPath: path.join(f.worker, "missing-brief"), briefSha256: "a".repeat(64), slot: { backend, agent: "worker", maxRounds: 1, inputDigests: [] }, receiptPath: path.join(f.worker, "missing-receipt"), resultPath: path.join(f.worker, "missing-result"),
     } } };
     const workerCache = statusCachePath(f.worker, path.join(f.worker, "spec.yaml"));
     await mkdir(path.dirname(workerCache), { recursive: true });
     await writeFile(workerCache, JSON.stringify(cache));
    }
    const verify = async () => (await createWorkVerifyTool().execute("verify", { ...f.target, worktreePath: f.worker, nodeId: "node" }, undefined, undefined, { ...f.ctx, cwd: f.worker })).details as WorkVerifyDetails;
    assert.equal((await verify()).outcome, "passed");
    await mkdir(path.dirname(f.cachePath), { recursive: true });
    if (corruption === "parse") await writeFile(f.cachePath, "{broken");
    else await mkdir(f.cachePath);
    const details = await verify();
    assert.equal(details.outcome, "passed", JSON.stringify(details));
    assert.deepEqual(details.failures, []);
    const inputs = await createVerifier({ hasUI: false }).readFabricInputs(path.join(f.root, "spec.yaml"), ["node"], { worktreePath: f.worker, expectedCommit: f.commit }, { worktreePath: f.root, expectedCommit: f.commit });
    assert.equal(inputs.failure, undefined);
   } finally { await rm(f.container, { recursive: true, force: true }); }
  });
 }
}

test("unrelated-cache-ignored: corrupt actual Fabric owner remains fail-closed", async () => {
 const f = await fixture();
 try {
  assert.equal((await dispatch(f)).outcome, "dispatched");
  await writeFile(f.cachePath, "{broken");
  const details = (await createWorkVerifyTool().execute("verify", { ...f.target, worktreePath: f.worker, nodeId: "node" }, undefined, undefined, { ...f.ctx, cwd: f.worker })).details as WorkVerifyDetails;
  assert.equal(details.outcome, "failed");
  assert.equal(details.failures[0]?.code, "verification-aborted");
  assert.equal(details.cacheUpdate, undefined);
  assert.match(await readFile(f.cachePath, "utf8"), /broken/);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});
