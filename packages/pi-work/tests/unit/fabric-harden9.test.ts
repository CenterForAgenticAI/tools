import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { fabricOwnershipPath } from "../../src/dispatch/fabric/receipt.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { createWorkVerifyTool, type WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

for (const mode of ["canonical", "alias", "moved"] as const) {
 test(`dispatch-id-identity: corrupt receipt cannot be bypassed through ${mode}`, async () => {
  const scratch = path.resolve(".scratch/tmp");
  await mkdir(scratch, { recursive: true });
  const container = await realpath(await mkdtemp(path.join(scratch, "harden9-")));
  try {
   const root = path.join(container, "owner");
   await mkdir(path.join(root, "src"), { recursive: true });
   await writeFile(path.join(root, "src/owned.ts"), "original\n");
   await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\n");
   await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden9\ndescription: d\nintent: i\nwork:\n  - id: A\n    task: compose\n    touches: [src/owned.ts]\n    acceptance:\n      - id: confirm-a\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
   const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
   git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
   git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
   const commit = git(["rev-parse", "HEAD"]).trim();
   let worker = path.join(container, "worker");
   git(["worktree", "add", "-qb", "worker", worker]);
   const standalone = path.join(container, "standalone");
   git(["worktree", "add", "-qb", "standalone", standalone]);
   const alias = path.join(container, "alias");
   await symlink(worker, alias);
   const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "harden9", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
   const backend = createFabricDispatchBackend({ projectRoot: root, events: { emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden9-run", status: "completed", model: "test/model", worktreeResult: { path: alias, branch: "worker", baseRef: commit }, value: { changedPaths: [], commit, evidence: "not proof", checklist: [], gaps: "" } } });
   } } });
   const tool = createWorkDispatchTool({ fabricHost: { dispatch(input) {
    return backend.dispatch({ ...input, plan: { ...input.plan, canonicalDelegate: { runs: [{ ...input.plan.canonicalDelegate.runs[0], worktree: true }] } } });
   } } });
   const dispatched = (await tool.execute("dispatch", { path: "spec.yaml", nodeAddress: ["A"], worktreePath: root, expectedCommit: commit }, undefined, undefined, ctx)).details as WorkDispatchDetails;
   assert.equal(dispatched.outcome, "dispatched", JSON.stringify(dispatched));
   if (mode === "moved") {
    const moved = path.join(container, "moved");
    git(["worktree", "move", worker, moved]); worker = moved;
   }
   const target = mode === "alias" ? alias : worker;
   const verify = async (tree: string) => (await createWorkVerifyTool().execute("verify", { path: "spec.yaml", nodeId: "A", worktreePath: tree, expectedCommit: commit }, undefined, undefined, { ...ctx, cwd: tree })).details as WorkVerifyDetails;
   assert.equal((await verify(target)).outcome, "passed");
   const cachePath = statusCachePath(root, path.join(root, "spec.yaml"));
   const cache = JSON.parse(await readFile(cachePath, "utf8"));
   const entry = cache.dispatch["harden9-run"];
   const ownershipFile = await fabricOwnershipPath(cachePath, ["A"], target);
   const ownershipSource = await readFile(ownershipFile, "utf8");
   const ownership = JSON.parse(ownershipSource);
   const receiptSource = await readFile(entry.receiptPath, "utf8");
   assert.match(ownership.dispatchId, /^[0-9a-f-]{36}$/);
   assert.equal(entry.dispatchId, ownership.dispatchId);
   assert.equal(JSON.parse(receiptSource).dispatchId, ownership.dispatchId);
   assert.equal(git(["-C", worker, "status", "--porcelain"]), "");
   for (const corruption of ["receipt-id", "cache-id", "ownership-id", "ownership-read"] as const) {
    if (corruption === "receipt-id") await writeFile(entry.receiptPath, JSON.stringify({ ...JSON.parse(receiptSource), dispatchId: "00000000-0000-0000-0000-000000000000" }));
    if (corruption === "cache-id") await writeFile(cachePath, JSON.stringify({ ...cache, dispatch: { "harden9-run": { ...entry, dispatchId: "00000000-0000-0000-0000-000000000000" } } }));
    if (corruption === "ownership-id") await writeFile(ownershipFile, JSON.stringify({ ...ownership, dispatchId: "00000000-0000-0000-0000-000000000000" }));
    if (corruption === "ownership-read") { await rm(ownershipFile); await symlink(path.join(container, "missing"), ownershipFile); }
    assert.equal((await verify(target)).failures[0]?.code, "verification-aborted", corruption);
    const inputs = await createVerifier({ hasUI: false }).readFabricInputs(path.join(root, "spec.yaml"), ["A"], { worktreePath: target, expectedCommit: commit }, { worktreePath: root, expectedCommit: commit });
    assert.equal(inputs.failure?.code, "verification-aborted", corruption);
    await rm(ownershipFile);
    await writeFile(ownershipFile, ownershipSource);
    await writeFile(entry.receiptPath, receiptSource);
    await writeFile(cachePath, JSON.stringify(cache));
   }
   await writeFile(entry.receiptPath, "{broken");
   const result = await verify(target);
   assert.equal(result.outcome, "failed", JSON.stringify(result));
   assert.equal(result.failures[0]?.code, "verification-aborted");
   assert.equal(result.cacheUpdate, undefined);
   await writeFile(cachePath, "{broken");
   assert.equal((await verify(target)).failures[0]?.code, "verification-aborted");
   assert.equal((await verify(standalone)).outcome, "passed");
   const forgedFile = await fabricOwnershipPath(cachePath, ["A"], standalone);
   await mkdir(path.dirname(forgedFile), { recursive: true });
   await writeFile(forgedFile, JSON.stringify({ ...ownership, dispatchId: "00000000-0000-0000-0000-000000000000" }));
   await writeFile(cachePath, JSON.stringify(cache));
   assert.equal((await verify(standalone)).failures[0]?.code, "verification-aborted");
  } finally { await rm(container, { recursive: true, force: true }); }
 });
}
