import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { dispatchPlan } from "../../src/dispatch/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import type { PlanReceipt } from "../../src/plan/types.ts";

for (const mode of ["ordinary", "prunable", "separate-target", "allowed-touch"] as const) {
 test(`compare-all-snapshotted-trees: ${mode} checkout uses the declared touch contract`, async () => {
  const scratch = path.resolve(".scratch/tmp");
  await mkdir(scratch, { recursive: true });
  const container = await realpath(await mkdtemp(path.join(scratch, "harden13-")));
  const root = path.join(container, "owner");
  try {
   await mkdir(root);
   const briefPath = path.join(root, "brief.md");
   await writeFile(briefPath, "abc");
   const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
   git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
   git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
   const commit = git(["rev-parse", "HEAD"]).trim();
   const worker = path.join(container, "worker");
   const unrelated = path.join(container, "unrelated");
   git(["worktree", "add", "-qb", "worker", worker]);
   git(["worktree", "add", "-qb", "unrelated", unrelated]);
   if (mode === "prunable") await rm(path.join(unrelated, ".git"));
   const listing = git(["worktree", "list", "--porcelain", "-z"]);
   assert.ok(listing.includes(`worktree ${unrelated}\0`));
   assert.equal(listing.includes("prunable"), mode === "prunable");
   const run = { name: "node", agent: "worker", task: "abc", mode: "solo", cwd: root, reads: [briefPath], writableRoots: ["allowed.txt"], confineWrites: true, escalation: "off", worktree: true } as const;
   const plan: PlanReceipt = { nodeId: "node", nodeAddress: ["node"], schemaPath: ["work", 0], briefPath, briefSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", delegate: { ...run }, canonicalDelegate: { runs: [run] } };
   const target = { worktreePath: mode === "separate-target" ? unrelated : root, headCommit: commit, branch: mode === "separate-target" ? "unrelated" : "fixture", specPath: path.join(root, "spec.yaml"), cachePath: path.join(container, "cache", "status.json") };
   const changedFile = mode === "allowed-touch" ? "allowed.txt" : "outside.txt";
   const backend = createFabricDispatchBackend({ projectRoot: root, events: { async emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    await writeFile(path.join(unrelated, changedFile), "worker wrote here");
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: `harden13-${mode}`, status: "completed", model: "test/model", worktreeResult: { path: worker, branch: "worker", baseRef: commit }, value: { changedPaths: [], commit, evidence: "not proof", checklist: [], gaps: "" } } });
   } } });
   const context = { cwd: root, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] } } as unknown as ExtensionContext;
   const result = await dispatchPlan({ plan, target, context }, { fabricHost: backend });
   if (mode === "allowed-touch") {
    assert.equal(result.outcome, "dispatched", JSON.stringify(result));
   } else {
    assert.equal(result.outcome, "indeterminate", JSON.stringify(result));
    assert.equal(result.dispatchState, "unknown");
    assert.equal(result.findings[0]?.code, "delegate-receipt-invalid");
    assert.ok(result.findings[0]?.message.includes("outside declared touches"));
    assert.ok(result.findings[0]?.message.includes(path.join(unrelated, "outside.txt")));
    assert.equal("receipt" in result, false);
   }
  } finally { await rm(container, { recursive: true, force: true }); }
 });
}
