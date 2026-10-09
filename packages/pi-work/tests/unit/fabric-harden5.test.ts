import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { changedSnapshotPaths, snapshotWorktree } from "../../src/dispatch/fabric/snapshot.ts";
import { decodeStatusCache, emptyStatusCache, statusCachePath } from "../../src/status/cache.ts";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import type { WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden5-")));
 const root = path.join(container, "owner");
 await mkdir(path.join(root, "src"), { recursive: true });
 await writeFile(path.join(root, "src/owned.ts"), "original\n");
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\n");
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden5\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [src/owned.ts]\n    acceptance:\n      - id: confirm\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 return { container, root, git, commit: git(["rev-parse", "HEAD"]).trim() };
}

function host(f: Awaited<ReturnType<typeof fixture>>, mutate: () => void = () => {}) {
 const tools = new Map<string, ToolDefinition>();
 const events = { on() { return () => {}; }, emit(channel: string, data: unknown) {
  if (channel !== "pi-fabric:program:run:v1") return;
  const request = data as FabricProgramRunRequest;
  mutate();
  request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden5-run", status: "completed", model: "test/model",
   value: { changedPaths: [], commit: f.commit, evidence: "not proof", checklist: [], gaps: "" } } });
 } };
 piWork({ getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, events } as unknown as ExtensionAPI);
 const ctx = { cwd: f.root, hasUI: true, sessionManager: { getSessionId: () => "harden5", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
 const target = { path: "spec.yaml", worktreePath: f.root, expectedCommit: f.commit };
 return { tools, ctx, target };
}

for (const changed of [false, true]) {
 test(`dir-symlink-confinement: ${changed ? "rejects modified" : "allows unchanged"} external directory contents`, async () => {
  const f = await fixture();
  try {
   const external = path.join(f.container, "external");
   await mkdir(path.join(external, "nested"), { recursive: true });
   await writeFile(path.join(external, "nested/file.txt"), "before");
   await symlink(external, path.join(f.root, "src/external-link"));
   f.git(["add", "src/external-link"]); f.git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "link"]);
   f.commit = f.git(["rev-parse", "HEAD"]).trim();
   const h = host(f, () => { if (changed) execFileSync("node", ["-e", "require('fs').writeFileSync(process.argv[1], 'after!')", path.join(f.root, "src/external-link/nested/file.txt")], { timeout: 10000 }); });
   const previous = process.env.PI_FABRIC_PROJECT_ROOT;
   process.env.PI_FABRIC_PROJECT_ROOT = f.root;
   let details: WorkDispatchDetails;
   try { details = (await h.tools.get("work_dispatch")!.execute("dispatch", { ...h.target, nodeAddress: ["node"] }, undefined, undefined, h.ctx)).details as WorkDispatchDetails; }
   finally { if (previous === undefined) delete process.env.PI_FABRIC_PROJECT_ROOT; else process.env.PI_FABRIC_PROJECT_ROOT = previous; }
   assert.equal(details.outcome, changed ? "indeterminate" : "dispatched", JSON.stringify(details));
   if (changed) {
    assert.match(JSON.stringify(details.findings), /src\/external-link\/nested\/file.txt/);
    assert.equal("receipt" in details, false);
   } else {
    const cache = decodeStatusCache(JSON.parse(await readFile(statusCachePath(f.root, path.join(f.root, "spec.yaml")), "utf8")));
    assert.equal(cache.cache?.dispatch["harden5-run"]?.slot.backend, "fabric");
   }
   assert.equal(await readFile(path.join(external, "nested/file.txt"), "utf8"), changed ? "after!" : "before");
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

test("dir-symlink-confinement: directory loops terminate and aliases retain link-prefixed changes", { timeout: 10000 }, async () => {
 const f = await fixture();
 try {
  const external = path.join(f.container, "external");
  await mkdir(external);
  await writeFile(path.join(external, "file.txt"), "before");
  await symlink(external, path.join(external, "self"));
  await symlink(f.root, path.join(external, "owner"));
  await symlink(external, path.join(f.root, "first"));
  await symlink(external, path.join(f.root, "second"));
  const before = await snapshotWorktree(f.root);
  await writeFile(path.join(external, "file.txt"), "after!");
  assert.deepEqual(changedSnapshotPaths(before, await snapshotWorktree(f.root)).sort(), ["first/file.txt", "second/file.txt"]);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});

for (const backend of [undefined, "pi-delegate", "fabric", "unknown"] as const) {
 test(`delegate-entry-unaffected: ${backend ?? "legacy"} entry with missing runtime artifacts`, async () => {
  const f = await fixture();
  try {
   const specPath = path.join(f.root, "spec.yaml");
   const cachePath = statusCachePath(f.root, specPath);
   const cache = { ...emptyStatusCache(specPath), dispatch: { run: {
    runId: "run", forkName: "worker", nodeId: "node", address: ["node"], createdAt: "2026-10-06T00:00:00.000Z",
    worktreePath: f.root, headCommit: f.commit, branch: "fixture", briefPath: path.join(f.root, "missing-brief"), briefSha256: "a".repeat(64),
    slot: { agent: "worker", maxRounds: 1, inputDigests: [], ...(backend === undefined ? {} : { backend }) },
    receiptPath: path.join(f.root, "missing-receipt"), resultPath: path.join(f.root, "missing-result"),
   } } };
   const decoded = decodeStatusCache(cache);
   if (backend === "unknown") {
    assert.equal(decoded.findings.length, 1);
    assert.equal(decoded.cache?.dispatch.run, undefined);
    return;
   }
   assert.deepEqual(decoded.findings, []);
   await mkdir(path.dirname(cachePath), { recursive: true });
   await writeFile(cachePath, JSON.stringify(cache));
   const h = host(f);
   const details = (await h.tools.get("work_verify")!.execute("verify", { ...h.target, nodeId: "node" }, undefined, undefined, h.ctx)).details as WorkVerifyDetails;
   assert.equal(details.outcome, backend === "fabric" ? "failed" : "passed", JSON.stringify(details));
   if (backend === "fabric") assert.equal(details.failures[0]?.code, "verification-aborted");
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
