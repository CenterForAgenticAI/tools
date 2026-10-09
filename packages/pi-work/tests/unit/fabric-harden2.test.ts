import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import { createFabricWorkProvider } from "../../src/fabric-provider.ts";
import { dispatchPlan, type DispatchDependencies } from "../../src/dispatch/index.ts";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { compileWorkPlan } from "../../src/plan/index.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import type { WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture(worktree = false) {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden2-")));
 const root = path.join(container, "owner");
 await mkdir(path.join(root, "src"), { recursive: true });
 await writeFile(path.join(root, "src/owned.ts"), "original\n");
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\nsrc/ignored.ts\n");
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden2\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [src/owned.ts]\n    checklist: [review complete]\n    acceptance:\n      - id: confirm\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 const commit = git(["rev-parse", "HEAD"]).trim();
 const worker = worktree ? path.join(container, "worker") : root;
 if (worktree) git(["worktree", "add", "-qb", "worker", worker]);
 return { container, root, worker, commit };
}

function host(f: Awaited<ReturnType<typeof fixture>>, available: boolean, attack = false) {
 const tools = new Map<string, ToolDefinition>();
 let requests = 0;
 let provider: ReturnType<typeof createFabricWorkProvider> | undefined;
 piWork({ getAllTools: () => available ? [{ name: "fabric_exec" }] : [],
  registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {},
  events: { on() { return () => {}; }, emit(channel: string, data: unknown) {
   if (channel === "pi-fabric:provider:register:v1") provider = (data as { provider: typeof provider }).provider;
   if (channel !== "pi-fabric:program:run:v1") return;
   requests++;
   const request = data as FabricProgramRunRequest;
   if (attack) execFileSync("node", ["-e", "require('fs').writeFileSync(process.argv[1], 'unauthorized')", path.join(f.worker, "src/ignored.ts")], { timeout: 10000 });
   request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden2-run", status: "completed", model: "test/model",
    ...(f.worker === f.root ? {} : { worktreeResult: { path: f.worker, branch: "worker", baseRef: f.commit } }),
    value: { changedPaths: [], commit: f.commit, evidence: "worker claims success", checklist: [{ index: 0, done: true }], gaps: "" } } });
  } },
 } as unknown as ExtensionAPI);
 const ctx = { cwd: f.root, hasUI: true, sessionManager: { getSessionId: () => "harden2", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as never;
 const target = { path: "spec.yaml", worktreePath: f.root, expectedCommit: f.commit };
 return { tools, provider: () => provider!, requests: () => requests, ctx, target };
}

test("ignored-write-confined: registered dispatch rejects an unreported gitignored sibling", async () => {
 const f = await fixture();
 try {
  const h = host(f, true, true);
  const result = await h.tools.get("work_dispatch")!.execute("attack", { ...h.target, nodeAddress: ["node"] }, undefined, undefined, h.ctx);
  const details = result.details as WorkDispatchDetails;
  assert.equal(details.outcome, "indeterminate");
  assert.match(JSON.stringify(details.findings), /src\/ignored.ts/);
  assert.equal("receipt" in details, false);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});

test("provider-unavailable-fallback: registered provider with only an event bus emits no Fabric request", async () => {
 const f = await fixture();
 try {
  const h = host(f, false);
  const result = await h.provider().invoke("dispatch", { ...h.target, nodeAddress: ["node"] }, { extensionContext: h.ctx, nestedToolCallId: "fallback", signal: undefined }) as { details: WorkDispatchDetails };
  assert.equal(result.details.backend, "plan-only");
  assert.equal(result.details.outcome, "degraded");
  assert.equal(h.requests(), 0);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});

for (const backend of [undefined, "pi-delegate"] as const) {
 test(`provider-unavailable-fallback: preserves caller clientProvider and backend=${backend}`, async () => {
  const f = await fixture();
  try {
   let calls = 0;
   let emitted = 0;
   const dependencies: DispatchDependencies = { ...(backend === undefined ? {} : { backend }), clientProvider: async () => {
    calls++;
    return { status: "unavailable", message: "absent fixture client" };
   } };
   const provider = createFabricWorkProvider({ events: { emit() { emitted++; } }, timeoutMs: 10 }, dependencies);
   const h = host(f, false);
   const result = await provider.invoke("dispatch", { ...h.target, nodeAddress: ["node"] }, { extensionContext: h.ctx, nestedToolCallId: "fallback", signal: undefined }) as { details: WorkDispatchDetails };
   assert.equal(result.details.backend, "plan-only");
   assert.equal(calls, 1);
   assert.equal(emitted, 0);
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

for (const worktree of [false, true]) {
 test(`worktree-result-lookup: work_verify consumes accounting and rejects digest tampering with worktree=${worktree}`, async () => {
  const f = await fixture(worktree);
  try {
   const h = host(f, true);
   const validation = validateWorkspec(await readFile(path.join(f.root, "spec.yaml"), "utf8"), { specPath: path.join(f.root, "spec.yaml"), cwd: f.root });
   assert.ok(validation.structuralValid);
   const compiled = await compileWorkPlan(validation.spec, { cwd: f.root, nodeAddresses: [["node"]] });
   assert.ok(compiled.ok);
   const plan = compiled.plans[0]!;
   const details = await dispatchPlan({ plan: { ...plan, canonicalDelegate: { runs: [{ ...plan.canonicalDelegate.runs[0], worktree }] } },
    target: { worktreePath: f.root, headCommit: f.commit, branch: "fixture", specPath: path.join(f.root, "spec.yaml"), cachePath: statusCachePath(f.root, path.join(f.root, "spec.yaml")) }, context: h.ctx },
    { fabricHost: createFabricDispatchBackend({ events: { emit(_channel, data) {
     const request = data as FabricProgramRunRequest;
     assert.equal(request.input.worktree, worktree);
     request.reply({ ok: true, program: request.ref, logs: [], value: { id: "lookup-run", model: "test/model", status: "completed",
      ...(worktree ? { worktreeResult: { path: f.worker, branch: "worker", baseRef: f.commit } } : {}),
      value: { changedPaths: [], commit: f.commit, evidence: "not proof", checklist: [{ index: 0, done: true }], gaps: "" } } });
    } } }) });
   assert.equal(details.outcome, "dispatched", JSON.stringify(details));
   assert.ok("receipt" in details);
   const verify = async () => (await h.tools.get("work_verify")!.execute("verify", { ...h.target, nodeId: "node", worktreePath: f.worker }, undefined, undefined, h.ctx)).details as WorkVerifyDetails;
   const passed = await verify();
   assert.equal(passed.outcome, "passed", JSON.stringify(passed));
   assert.equal(passed.result?.checklist.outcome, "complete");
   const receipt = JSON.parse(await readFile(details.receipt.receiptPath, "utf8"));
   receipt.forks[0].inputDigests[0].digest = "0".repeat(64);
   await writeFile(details.receipt.receiptPath, JSON.stringify(receipt));
   const failed = await verify();
   assert.equal(failed.outcome, "failed");
   assert.match(JSON.stringify(failed.failures), /digest mismatch/);
   assert.equal(failed.cacheUpdate, undefined);
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}

test("provider-unavailable-fallback: available delegate dispatch and cacheWriter survive plain dependency copy", async () => {
 const f = await fixture();
 try {
  let calls = 0;
  let writes = 0;
  let emitted = 0;
  const provider = createFabricWorkProvider({ events: { emit() { emitted++; } } }, {
   clientProvider: async () => ({ status: "available", grammar: "legacy", client: { async dispatch(request) {
    assert.ok("reads" in request);
    const briefPath = request.reads[0];
    const digest = createHash("sha256").update(await readFile(briefPath)).digest("hex");
    calls++;
    return { schema: "pi-delegate.runtime-receipt", version: 1, runId: "delegate-run", createdAt: "2026-10-06T12:00:00.000Z", shape: "direct", forks: [{ name: "node", agent: "worker", maxRounds: 1, inputDigests: [{ kind: "read", name: briefPath, algorithm: "sha256", digest }] }], receiptPath: path.join(f.root, "receipt.json"), resultPath: path.join(f.root, "result.json") };
   } } }),
   cacheWriter: async () => { writes++; return { status: "written", path: path.join(f.container, "cache.json"), attempts: 1, residualRace: "readback-may-precede-later-overwrite" }; },
  });
  const h = host(f, false);
  const result = await provider.invoke("dispatch", { ...h.target, nodeAddress: ["node"] }, { extensionContext: h.ctx, nestedToolCallId: "delegate", signal: undefined }) as { details: WorkDispatchDetails };
  assert.equal(result.details.backend, "pi-delegate");
  assert.equal(result.details.outcome, "dispatched", JSON.stringify(result.details));
  assert.equal(calls, 1);
  assert.equal(writes, 1);
  assert.equal(emitted, 0);
 } finally { await rm(f.container, { recursive: true, force: true }); }
});

test("docs-availability-rule: shipped execution skill requires registered fabric_exec discovery", async () => {
 const skill = await readFile(path.join(REPO_ROOT, "skills/work-execution/SKILL.md"), "utf8");
 assert.match(skill, /Fabric is discovered.*`fabric_exec`/);
 assert.doesNotMatch(skill, /installs the Fabric adapter when Pi exposes an event bus/);
 // README has the same required correction, but is outside this node's write roots.
});
