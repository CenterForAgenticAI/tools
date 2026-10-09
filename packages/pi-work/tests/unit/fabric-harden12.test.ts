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

async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden12-")));
 const root = path.join(container, "owner");
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
 const run = { name: "node", agent: "worker", task: "abc", mode: "solo", cwd: root, reads: [briefPath], confineWrites: true, escalation: "off", worktree: true } as const;
 const plan: PlanReceipt = { nodeId: "node", nodeAddress: ["node"], schemaPath: ["work", 0], briefPath, briefSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", delegate: { ...run }, canonicalDelegate: { runs: [run] } };
 const target = { worktreePath: root, headCommit: commit, branch: "fixture", specPath: path.join(root, "spec.yaml"), cachePath: path.join(container, "cache", "status.json") };
 let submissions = 0;
 const backend = createFabricDispatchBackend({ projectRoot: root, events: { emit(_channel, data) {
  submissions++;
  const request = data as FabricProgramRunRequest;
  request.reply({ ok: true, program: request.ref, logs: [], value: { id: `harden12-${submissions}`, status: "completed", model: "test/model", worktreeResult: { path: worker, branch: "worker", baseRef: commit }, value: { changedPaths: [], commit, evidence: "not proof", checklist: [], gaps: "" } } });
 } } });
 const context = { cwd: root, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] } } as unknown as ExtensionContext;
 const dispatch = (selectedTarget = target, selectedPlan = plan) => dispatchPlan({ plan: selectedPlan, target: selectedTarget, context }, { fabricHost: backend });
 return { container, root, worker, unrelated, git, plan, target, dispatch, submissions: () => submissions };
}

for (const mode of ["deleted", "locked-deleted", "not-directory", "prunable"] as const) {
 test(`skip-missing-unrelated-worktree: ${mode} unrelated registration dispatches like a pruned repository`, async () => {
  const f = await fixture();
  try {
   if (mode === "prunable") {
    await rm(path.join(f.unrelated, ".git"));
    execFileSync("mkfifo", [path.join(f.unrelated, "unreadable-entry")], { timeout: 10000 });
   }
   else {
    if (mode === "locked-deleted") f.git(["worktree", "lock", f.unrelated]);
    await rm(f.unrelated, { recursive: true });
    if (mode === "not-directory") await writeFile(f.unrelated, "not a directory");
   }
   const listing = f.git(["worktree", "list", "--porcelain", "-z"]);
   assert.ok(listing.includes(`worktree ${f.unrelated}\0`));
   assert.equal(listing.includes("prunable"), mode !== "locked-deleted");
   const result = await f.dispatch();
   if (mode === "prunable") {
    // Existing prunable trees are inspected; the FIFO must fail closed.
    assert.equal(result.outcome, "indeterminate", JSON.stringify(result));
    assert.equal(result.dispatchState, "unknown");
    assert.equal(result.findings[0]?.code, "delegate-runtime-error");
    assert.ok(result.findings[0]?.message.includes("Unsupported worktree file: unreadable-entry"));
    assert.equal(f.submissions(), 0);
   } else {
    assert.equal(result.outcome, "dispatched", JSON.stringify(result));
    assert.equal(f.submissions(), 1);
   }
   if (mode === "locked-deleted") f.git(["worktree", "unlock", f.unrelated]);
   f.git(["worktree", "prune"]);
   assert.equal(f.git(["worktree", "list", "--porcelain", "-z"]).includes(`worktree ${f.unrelated}\0`), false);
   const pruned = await f.dispatch();
   assert.equal(pruned.outcome, "dispatched", JSON.stringify(pruned));
   assert.equal(f.submissions(), mode === "prunable" ? 1 : 2);
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

for (const required of ["target", "source"] as const) {
 test(`skip-missing-unrelated-worktree: missing ${required} remains typed indeterminate without submission`, async () => {
  const f = await fixture();
  try {
   await rm(f.unrelated, { recursive: true });
   const target = required === "target" ? { ...f.target, worktreePath: f.unrelated } : f.target;
   const plan: PlanReceipt = required === "source" ? { ...f.plan, canonicalDelegate: { runs: [{ ...f.plan.canonicalDelegate.runs[0], cwd: f.unrelated }] } } : f.plan;
   const result = await f.dispatch(target, plan);
   assert.equal(result.outcome, "indeterminate");
   assert.equal(result.dispatchState, "unknown");
   assert.equal(result.findings[0]?.code, "delegate-runtime-error");
   assert.equal(f.submissions(), 0);
   assert.equal("receipt" in result, false);
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
