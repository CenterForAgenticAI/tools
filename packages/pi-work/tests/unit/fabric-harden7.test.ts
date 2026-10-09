import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { createWorkVerifyTool, type WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

for (const corruption of ["parse", "read"] as const) {
 test(`node-scoped-cache-signal: ${corruption} owner cache affects only the dispatched spec and node`, async () => {
  const scratch = path.resolve(".scratch/tmp");
  await mkdir(scratch, { recursive: true });
  const container = await realpath(await mkdtemp(path.join(scratch, "harden7-")));
  try {
   const root = path.join(container, "owner");
   await mkdir(path.join(root, "src"), { recursive: true });
   await writeFile(path.join(root, "src/owned.ts"), "original\n");
   await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\n");
   const source = withDraftLineage("title: harden7\ndescription: d\nintent: i\nwork:\n  - id: A\n    task: compose\n    touches: [src/owned.ts]\n    acceptance:\n      - id: confirm-a\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n  - id: B\n    task: independent\n    acceptance:\n      - id: confirm-b\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root });
   await writeFile(path.join(root, "spec.yaml"), source);
   await writeFile(path.join(root, "other.yaml"), source);
   const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
   git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
   git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
   const commit = git(["rev-parse", "HEAD"]).trim();
   const worker = path.join(container, "worker");
   git(["worktree", "add", "-qb", "worker", worker]);
   const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "harden7", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
   const backend = createFabricDispatchBackend({ projectRoot: root, events: { emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden7-run", status: "completed", model: "test/model", worktreeResult: { path: worker, branch: "worker", baseRef: commit }, value: { changedPaths: [], commit, evidence: "not proof", checklist: [], gaps: "" } } });
   } } });
   const dispatchTool = createWorkDispatchTool({ fabricHost: { dispatch(input) {
    return backend.dispatch({ ...input, plan: { ...input.plan, canonicalDelegate: { runs: [{ ...input.plan.canonicalDelegate.runs[0], worktree: true }] } } });
   } } });
   const dispatched = (await dispatchTool.execute("dispatch", { path: "spec.yaml", nodeAddress: ["A"], worktreePath: root, expectedCommit: commit }, undefined, undefined, ctx)).details as WorkDispatchDetails;
   assert.equal(dispatched.outcome, "dispatched", JSON.stringify(dispatched));
   const cachePath = statusCachePath(root, path.join(root, "spec.yaml"));
   if (corruption === "parse") await writeFile(cachePath, "{broken");
   else { await rm(cachePath); await mkdir(cachePath); }
   const verify = async (nodeId: string, spec = "spec.yaml") => (await createWorkVerifyTool().execute("verify", { path: spec, nodeId, worktreePath: worker, expectedCommit: commit }, undefined, undefined, { ...ctx, cwd: worker })).details as WorkVerifyDetails;
   const independent = await verify("B");
   assert.equal(independent.outcome, "passed", JSON.stringify(independent));
   assert.deepEqual(independent.failures, []);
   const otherSpec = await verify("A", "other.yaml");
   assert.equal(otherSpec.outcome, "passed", JSON.stringify(otherSpec));
   const own = await verify("A");
   assert.equal(own.outcome, "failed");
   assert.equal(own.failures[0]?.code, "verification-aborted");
   assert.equal(own.cacheUpdate, undefined);
   const verifier = createVerifier({ hasUI: false });
   const target = { worktreePath: worker, expectedCommit: commit };
   const owner = { worktreePath: root, expectedCommit: commit };
   assert.equal((await verifier.readFabricInputs(path.join(root, "spec.yaml"), ["B"], target, owner)).failure, undefined);
   assert.equal((await verifier.readFabricInputs(path.join(root, "other.yaml"), ["A"], target, owner)).failure, undefined);
   assert.equal((await verifier.readFabricInputs(path.join(root, "spec.yaml"), ["A"], target, owner)).failure?.code, "verification-aborted");
   if (corruption === "parse") assert.equal(await readFile(cachePath, "utf8"), "{broken");
  } finally { await rm(container, { recursive: true, force: true }); }
 });
}
