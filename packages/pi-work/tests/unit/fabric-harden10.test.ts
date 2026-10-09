import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { createWorkVerifyTool, type WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

for (const mode of ["canonical", "alias", "moved"] as const) {
 test(`ownership-in-git-dir: dispatch stays untracked and verification fails closed through ${mode}`, async () => {
  const scratch = path.resolve(".scratch/tmp");
  await mkdir(scratch, { recursive: true });
  const container = await realpath(await mkdtemp(path.join(scratch, "harden10-")));
  try {
   const root = path.join(container, "owner");
   await mkdir(path.join(root, "src"), { recursive: true });
   await writeFile(path.join(root, "src/owned.ts"), "original\n");
   await writeFile(path.join(root, ".gitignore"), "");
   await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden10\ndescription: d\nintent: i\nwork:\n  - id: A\n    task: compose\n    touches: [src/owned.ts]\n    acceptance:\n      - id: confirm-a\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
   const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.excludesFile=/dev/null", ...args], { cwd, encoding: "utf8", timeout: 10000 });
   git(root, ["init", "-q", "-b", "fixture"]); git(root, ["add", "."]);
   git(root, ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
   const commit = git(root, ["rev-parse", "HEAD"]).trim();
   let worker = path.join(container, "worker");
   const standalone = path.join(container, "standalone");
   git(root, ["worktree", "add", "-qb", "worker", worker]);
   git(root, ["worktree", "add", "-qb", "standalone", standalone]);
   const alias = path.join(container, "alias");
   await symlink(worker, alias);
   const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "harden10", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
   const backend = createFabricDispatchBackend({ projectRoot: root, events: { emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden10-run", status: "completed", model: "test/model", worktreeResult: { path: alias, branch: "worker", baseRef: commit }, value: { changedPaths: [], commit, evidence: "not proof", checklist: [], gaps: "" } } });
   } } });
   const tool = createWorkDispatchTool({ fabricHost: { dispatch(input) {
    return backend.dispatch({ ...input, plan: { ...input.plan, canonicalDelegate: { runs: [{ ...input.plan.canonicalDelegate.runs[0], worktree: true }] } } });
   } } });
   const dispatched = (await tool.execute("dispatch", { path: "spec.yaml", nodeAddress: ["A"], worktreePath: root, expectedCommit: commit }, undefined, undefined, ctx)).details as WorkDispatchDetails;
   assert.equal(dispatched.outcome, "dispatched", JSON.stringify(dispatched));
   assert.equal(git(worker, ["status", "--porcelain", "--untracked-files=all"]), "");
   git(worker, ["add", "."]);
   assert.equal(git(worker, ["diff", "--cached", "--name-only"]), "");
   const cachePath = statusCachePath(root, path.join(root, "spec.yaml"));
   const cache = JSON.parse(await readFile(cachePath, "utf8"));
   const entry = cache.dispatch["harden10-run"];
   const digest = createHash("sha256").update(JSON.stringify([path.basename(cachePath), ["A"]])).digest("hex");
   const markerName = `fabric-ownership/${digest}.json`;
   const marker = (tree: string) => path.resolve(tree, git(tree, ["rev-parse", "--git-path", markerName]).trim());
   const ownershipFile = marker(worker);
   const ownership = JSON.parse(await readFile(ownershipFile, "utf8"));
   assert.equal(ownership.dispatchId, entry.dispatchId);
   assert.equal(JSON.parse(await readFile(entry.receiptPath, "utf8")).dispatchId, ownership.dispatchId);
   assert.equal(marker(alias), ownershipFile);
   if (mode === "moved") {
    const moved = path.join(container, "moved");
    git(root, ["worktree", "move", worker, moved]); worker = moved;
   }
   assert.equal(marker(worker), ownershipFile);
   const target = mode === "alias" ? alias : worker;
   const verify = async (tree: string) => (await createWorkVerifyTool().execute("verify", { path: "spec.yaml", nodeId: "A", worktreePath: tree, expectedCommit: commit }, undefined, undefined, { ...ctx, cwd: tree })).details as WorkVerifyDetails;
   assert.equal((await verify(target)).outcome, "passed");
   assert.equal(git(target, ["status", "--porcelain", "--untracked-files=all"]), "");
   await writeFile(entry.receiptPath, JSON.stringify({ ...JSON.parse(await readFile(entry.receiptPath, "utf8")), dispatchId: "00000000-0000-0000-0000-000000000000" }));
   const failed = await verify(target);
   assert.equal(failed.outcome, "failed");
   assert.equal(failed.failures[0]?.code, "verification-aborted");
   assert.equal(failed.cacheUpdate, undefined);
   assert.equal((await verify(standalone)).outcome, "passed");
   await rm(ownershipFile);
   assert.equal((await verify(target)).outcome, "passed");
  } finally { await rm(container, { recursive: true, force: true }); }
 });
}
