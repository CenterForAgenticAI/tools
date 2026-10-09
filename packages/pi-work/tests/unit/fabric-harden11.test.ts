import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { recordFabricDispatchReceipt } from "../../src/dispatch/fabric/receipt.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import type { PlanReceipt } from "../../src/plan/types.ts";

async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden11-")));
 const root = path.join(container, "owner");
 await mkdir(root);
 const briefPath = path.join(root, "brief.md");
 await writeFile(briefPath, "abc");
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 const commit = git(["rev-parse", "HEAD"]).trim();
 const run = { name: "node", agent: "worker", task: "abc", mode: "solo", cwd: root, reads: [briefPath], confineWrites: true, escalation: "off", worktree: true } as const;
 const plan: PlanReceipt = { nodeId: "node", nodeAddress: ["node"], schemaPath: ["work", 0], briefPath, briefSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", delegate: { ...run }, canonicalDelegate: { runs: [run] } };
 const target = { worktreePath: root, headCommit: commit, branch: "fixture", specPath: path.join(root, "spec.yaml"), cachePath: path.join(container, "cache", "status.json") };
 return { container, root, plan, target, commit };
}

for (const mode of ["non-repository", "missing"] as const) {
 test(`receipt-non-repo-typed: publication into a ${mode} worker tree fails typed without artifacts`, async () => {
  const f = await fixture();
  try {
   const worker = path.join(f.container, mode);
   if (mode === "non-repository") await mkdir(worker);
   const result = await recordFabricDispatchReceipt({ plan: f.plan, target: f.target, value: { id: "invalid-tree", model: "test/model", worktreeResult: { path: worker, branch: "worker" } } });
   assert.ok("outcome" in result);
   assert.equal(result.outcome, "indeterminate");
   assert.equal(result.dispatchState, "unknown");
   assert.equal(result.plan, f.plan);
   assert.equal(result.findings[0]?.code, "delegate-receipt-invalid");
   assert.ok(result.findings[0]?.message.includes(worker));
   assert.equal("receipt" in result, false);
   await assert.rejects(stat(path.dirname(f.target.cachePath)), { code: "ENOENT" });
   assert.equal(await readFile(f.plan.briefPath, "utf8"), "abc");
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });

 test(`receipt-non-repo-typed: backend returns indeterminate for a ${mode} Fabric worker tree`, async () => {
  const f = await fixture();
  try {
   const worker = path.join(f.container, mode);
   if (mode === "non-repository") await mkdir(worker);
   const backend = createFabricDispatchBackend({ projectRoot: f.root, events: { emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: "invalid-tree", status: "completed", model: "test/model", worktreeResult: { path: worker, branch: "worker", baseRef: f.commit }, value: { changedPaths: [], commit: f.commit, evidence: "worker claim", checklist: [], gaps: "" } } });
   } } });
   const context = { cwd: f.root, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] } } as unknown as ExtensionContext;
   const result = await backend.dispatch({ plan: f.plan, target: f.target, context });
   assert.equal(result.outcome, "indeterminate");
   assert.equal(result.dispatchState, "unknown");
   assert.equal(result.findings[0]?.code, "delegate-receipt-invalid");
   assert.ok(result.findings[0]?.message.includes(worker));
   assert.equal("receipt" in result, false);
   await assert.rejects(stat(path.dirname(f.target.cachePath)), { code: "ENOENT" });
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
