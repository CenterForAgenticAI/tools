import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import { dispatchPlan } from "../../src/dispatch/index.ts";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { compileWorkPlan } from "../../src/plan/index.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import type { WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { changedSnapshotPaths, snapshotWorktree, SNAPSHOT_HASH_CAP } from "../../src/dispatch/fabric/snapshot.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture(worktree = false) {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden3-")));
 const root = path.join(container, "owner");
 await mkdir(path.join(root, "src"), { recursive: true });
 await writeFile(path.join(root, "src/owned.ts"), "original\n");
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\nsrc/ignored.ts\n");
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden3\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [src/owned.ts]\n    checklist: [review complete]\n    acceptance:\n      - id: confirm\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 const commit = git(["rev-parse", "HEAD"]).trim();
 const worker = worktree ? path.join(container, "worker") : root;
 if (worktree) git(["worktree", "add", "-qb", "worker", worker]);
 return { container, root, worker, commit };
}

function host(f: Awaited<ReturnType<typeof fixture>>, change?: string) {
 const tools = new Map<string, ToolDefinition>();
 const events = { on() { return () => {}; }, emit(channel: string, data: unknown) {
  if (channel !== "pi-fabric:program:run:v1") return;
  if (change) execFileSync("node", ["-e", "const fs=require('fs'),p=require('path'); fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true}); fs.writeFileSync(process.argv[1], 'unauthorized')", path.join(f.worker, change)], { timeout: 10000 });
  const request = data as FabricProgramRunRequest;
  request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden3-run", status: "completed", model: "test/model",
   ...(f.worker === f.root ? {} : { worktreeResult: { path: f.worker, branch: "worker", baseRef: f.commit } }),
   value: { changedPaths: [], commit: f.commit, evidence: "worker claims success", checklist: [{ index: 0, done: true }], gaps: "" } } });
 } };
 piWork({ getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, events } as unknown as ExtensionAPI);
 const ctx = { cwd: f.root, hasUI: true, sessionManager: { getSessionId: () => "harden3", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
 const target = { path: "spec.yaml", worktreePath: f.root, expectedCommit: f.commit };
 return { tools, events, ctx, target };
}

for (const change of [undefined, "src/ignored.ts", ".pi/fabric/programs/unauthorized.json", ".work/unauthorized.json"]) {
 test(`snapshot-confinement: ${change ?? "untouched ignored file is allowed"}`, async () => {
  const f = await fixture();
  try {
   await writeFile(path.join(f.root, "src/ignored.ts"), "pre-existing\n");
   const h = host(f, change);
   const details = (await h.tools.get("work_dispatch")!.execute("dispatch", { ...h.target, nodeAddress: ["node"] }, undefined, undefined, h.ctx)).details as WorkDispatchDetails;
   assert.equal(details.outcome, change ? "indeterminate" : "dispatched", JSON.stringify(details));
   if (change) { assert.ok(JSON.stringify(details.findings).includes(change)); assert.equal("receipt" in details, false); }
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

for (const caller of ["owner", "worker"] as const) {
 for (const corruption of ["digest", "missing-result", "missing-receipt"] as const) {
 test(`verify-owner-discovery: ${caller} caller rejects ${corruption}`, async () => {
  const f = await fixture(true);
  try {
   const h = host(f);
   const validation = validateWorkspec(await readFile(path.join(f.root, "spec.yaml"), "utf8"), { specPath: path.join(f.root, "spec.yaml"), cwd: f.root });
   assert.ok(validation.structuralValid);
   const compiled = await compileWorkPlan(validation.spec, { cwd: f.root, nodeAddresses: [["node"]] });
   assert.ok(compiled.ok);
   const plan = compiled.plans[0]!;
   const details = await dispatchPlan({ plan: { ...plan, canonicalDelegate: { runs: [{ ...plan.canonicalDelegate.runs[0], worktree: true }] } }, target: { worktreePath: f.root, headCommit: f.commit, branch: "fixture", specPath: path.join(f.root, "spec.yaml"), cachePath: statusCachePath(f.root, path.join(f.root, "spec.yaml")) }, context: h.ctx }, { fabricHost: createFabricDispatchBackend({ events: h.events }) });
   assert.equal(details.outcome, "dispatched", JSON.stringify(details));
   assert.ok("receipt" in details);
   const ctx = { ...h.ctx, cwd: caller === "owner" ? f.root : f.worker };
   const verify = async () => (await h.tools.get("work_verify")!.execute("verify", { ...h.target, nodeId: "node", worktreePath: f.worker }, undefined, undefined, ctx as never)).details as WorkVerifyDetails;
   const passed = await verify();
   assert.equal(passed.outcome, "passed", JSON.stringify(passed));
   assert.equal(passed.result?.checklist.outcome, "complete");
   if (corruption === "digest") {
    const receipt = JSON.parse(await readFile(details.receipt.receiptPath, "utf8"));
    receipt.forks[0].inputDigests[0].digest = "0".repeat(64);
    await writeFile(details.receipt.receiptPath, JSON.stringify(receipt));
   } else await rm(corruption === "missing-result" ? details.receipt.resultPath : details.receipt.receiptPath);
   const failed = await verify();
   assert.equal(failed.outcome, "failed", JSON.stringify(failed));
   assert.equal(failed.failures[0]?.code, "verification-aborted");
   assert.equal(failed.cacheUpdate, undefined);
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
 }
}

test("snapshot-confinement: hashes same-size changes, removals and symlink replacements; caps large files", async () => {
 const f = await fixture();
 try {
  await writeFile(path.join(f.root, "src/ignored.ts"), "before");
  const big = path.join(f.root, "large.bin");
  await writeFile(big, Buffer.alloc(SNAPSHOT_HASH_CAP + 1));
  await utimes(big, 100, 100);
  await symlink("src/owned.ts", path.join(f.root, "link"));
  await mkdir(path.join(f.root, "node_modules"));
  await writeFile(path.join(f.root, "node_modules/excluded"), "before");
  const before = await snapshotWorktree(f.root);
  assert.equal(before.get("large.bin")?.digest, undefined);
  assert.equal(before.get("large.bin")?.mtimeMs, 100000);
  await writeFile(path.join(f.root, "src/ignored.ts"), "after!");
  await rm(path.join(f.root, "src/owned.ts"));
  await rm(path.join(f.root, "link"));
  await symlink("src/ignored.ts", path.join(f.root, "link"));
  await utimes(big, 200, 200);
  await writeFile(path.join(f.root, "node_modules/excluded"), "after!");
  const changed = changedSnapshotPaths(before, await snapshotWorktree(f.root)).sort();
  assert.deepEqual(changed, ["large.bin", "link", "src/ignored.ts", "src/owned.ts"]);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});

test("docs-both-files: README and execution skill require registered fabric_exec discovery", async () => {
 for (const file of ["README.md", "skills/work-execution/SKILL.md"]) {
  const text = await readFile(path.join(REPO_ROOT, file), "utf8");
  assert.match(text, /Fabric is discovered[\s\S]*?`fabric_exec`/, file);
  assert.doesNotMatch(text, /installs the Fabric adapter when Pi exposes an event bus/, file);
  assert.match(text, /[Aa]n event bus alone (?:does not select|is not) Fabric/, file);
 }
});
