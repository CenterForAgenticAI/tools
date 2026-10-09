import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import type { WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { dispatchPlan } from "../../src/dispatch/index.ts";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { compileWorkPlan } from "../../src/plan/index.ts";
import { validateWorkspec } from "../../src/schema/index.ts";
import { createVerifier } from "../../src/verify/internal.ts";
import type { WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { FABRIC_DISPATCH_PROGRAM_DIGEST } from "../../src/dispatch/fabric/program.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const container = await realpath(await mkdtemp(path.join(scratch, "harden4-")));
 const root = path.join(container, "owner");
 await mkdir(path.join(root, "src"), { recursive: true });
 await writeFile(path.join(root, "src/owned.ts"), "original\n");
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\nnode_modules/\n");
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: harden4\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    touches: [src/owned.ts]\n    checklist: [review complete]\n    acceptance:\n      - id: confirm\n        statement: independent confirmation\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 return { container, root, git, commit: git(["rev-parse", "HEAD"]).trim() };
}

function host(f: Awaited<ReturnType<typeof fixture>>, mutate: (request: FabricProgramRunRequest) => void = () => {}, worker = f.root) {
 const tools = new Map<string, ToolDefinition>();
 const events = { on() { return () => {}; }, emit(channel: string, data: unknown) {
  if (channel !== "pi-fabric:program:run:v1") return;
  const request = data as FabricProgramRunRequest;
  mutate(request);
  request.reply({ ok: true, program: request.ref, logs: [], value: { id: "harden4-run", status: "completed", model: "test/model",
   ...(worker === f.root ? {} : { worktreeResult: { path: worker, branch: "worker", baseRef: f.commit } }),
   value: { changedPaths: [], commit: f.commit, evidence: "worker claims success", checklist: [{ index: 0, done: true }], gaps: "" } } });
 } };
 piWork({ getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {}, events } as unknown as ExtensionAPI);
 const ctx = { cwd: f.root, hasUI: true, sessionManager: { getSessionId: () => "harden4", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => true } } as unknown as ExtensionToolContext;
 const target = { path: "spec.yaml", worktreePath: f.root, expectedCommit: f.commit };
 return { tools, ctx, target };
}

for (const changed of [false, true]) {
 test(`bootstrap-integrity: ${changed ? "rewritten" : "untouched"} program record`, async () => {
  const f = await fixture();
  try {
   const bootstrap = path.join(f.root, ".pi/fabric/programs", `${FABRIC_DISPATCH_PROGRAM_DIGEST}.json`);
   const h = host(f, () => { if (changed) overwrite(bootstrap); });
   const details = await dispatch(h);
   assert.equal(details.outcome, changed ? "indeterminate" : "dispatched", JSON.stringify(details));
   if (changed) {
    assert.match(JSON.stringify(details.findings), /\.pi\/fabric\/programs/);
    assert.equal("receipt" in details, false);
   }
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
async function dispatch(h: ReturnType<typeof host>): Promise<WorkDispatchDetails> {
 const previous = process.env.PI_FABRIC_PROJECT_ROOT;
 process.env.PI_FABRIC_PROJECT_ROOT = h.ctx.cwd;
 try {
  return (await h.tools.get("work_dispatch")!.execute("dispatch", { ...h.target, nodeAddress: ["node"] }, undefined, undefined, h.ctx)).details as WorkDispatchDetails;
 } finally {
  if (previous === undefined) delete process.env.PI_FABRIC_PROJECT_ROOT;
  else process.env.PI_FABRIC_PROJECT_ROOT = previous;
 }
}

for (const corruption of ["parse", "decode", "read"] as const) {
 test(`owner-cache-fail-closed: worker caller rejects owner cache ${corruption} finding`, async () => {
  const f = await fixture();
  try {
   const worker = path.join(f.container, "worker");
   f.git(["worktree", "add", "-qb", "worker", worker]);
   const h = host(f, undefined, worker);
   const specPath = path.join(f.root, "spec.yaml");
   const validation = validateWorkspec(await readFile(specPath, "utf8"), { specPath, cwd: f.root });
   assert.ok(validation.structuralValid);
   const compiled = await compileWorkPlan(validation.spec, { cwd: f.root, nodeAddresses: [["node"]] });
   assert.ok(compiled.ok);
   const plan = compiled.plans[0]!;
   const cachePath = statusCachePath(f.root, specPath);
   const result = await dispatchPlan({ plan: { ...plan, canonicalDelegate: { runs: [{ ...plan.canonicalDelegate.runs[0], worktree: true }] } }, target: { worktreePath: f.root, headCommit: f.commit, branch: "fixture", specPath, cachePath }, context: h.ctx }, { fabricHost: createFabricDispatchBackend({ projectRoot: f.root, events: { emit(_channel, data) {
    const request = data as FabricProgramRunRequest;
    request.reply({ ok: true, program: request.ref, logs: [], value: { id: "owner-cache-run", status: "completed", model: "test/model", worktreeResult: { path: worker, branch: "worker", baseRef: f.commit }, value: { changedPaths: [], commit: f.commit, evidence: "not proof", checklist: [{ index: 0, done: true }], gaps: "" } } });
   } } }) });
   assert.equal(result.outcome, "dispatched", JSON.stringify(result));
   const verify = async () => (await h.tools.get("work_verify")!.execute("verify", { ...h.target, nodeId: "node", worktreePath: worker }, undefined, undefined, { ...h.ctx, cwd: worker })).details as WorkVerifyDetails;
   const passed = await verify();
   assert.equal(passed.outcome, "passed", JSON.stringify(passed));
   if (corruption === "read") { await rm(cachePath); await mkdir(cachePath); }
   else if (corruption === "parse") await writeFile(cachePath, "{broken");
   else {
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    cache.dispatch["owner-cache-run"] = { malformed: true };
    await writeFile(cachePath, JSON.stringify(cache));
   }
   const failed = await verify();
   assert.equal(failed.outcome, "failed", JSON.stringify(failed));
   assert.equal(failed.failures[0]?.code, "verification-aborted");
   assert.equal(failed.cacheUpdate, undefined);
   const inputs = await createVerifier({ hasUI: false }).readFabricInputs(specPath, ["node"], { worktreePath: worker, expectedCommit: f.commit }, { worktreePath: f.root, expectedCommit: f.commit });
   assert.equal(inputs.failure?.code, "verification-aborted");
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
test("docs-best-effort: README and execution skill state confinement limits", async () => {
 for (const file of ["README.md", "skills/work-execution/SKILL.md"]) {
  const text = await readFile(path.join(REPO_ROOT, file), "utf8");
  assert.match(text, /directory-level `writableRoots` plus a best-effort post-run content diff/, file);
  assert.match(text, /not a hard file-level guard/, file);
  assert.match(text, /[Ff]iles over 8 MiB are compared by size and mtime/, file);
  assert.match(text, /[Ss]napshot traversal has no file-count or time bound/, file);
 }
});
function overwrite(file: string) {
 execFileSync("node", ["-e", "require('fs').writeFileSync(process.argv[1], 'after!')", file], { timeout: 10000 });
}

for (const changed of [false, true]) {
 test(`symlink-confinement: unchanged link with ${changed ? "modified" : "unchanged"} external target`, async () => {
  const f = await fixture();
  try {
   const external = path.join(f.container, "external.txt");
   await writeFile(external, "before");
   await symlink(external, path.join(f.root, "src/external-link"));
   // Track the link so dispatch preflight sees a clean worktree.
   f.git(["add", "src/external-link"]); f.git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "link"]);
   f.commit = f.git(["rev-parse", "HEAD"]).trim();
   const h = host(f, () => { if (changed) overwrite(path.join(f.root, "src/external-link")); });
   const details = await dispatch(h);
   assert.equal(details.outcome, changed ? "indeterminate" : "dispatched", JSON.stringify(details));
   if (changed) {
    assert.match(JSON.stringify(details.findings), /src\/external-link/);
    assert.equal("receipt" in details, false);
   }
   assert.equal(await readFile(external, "utf8"), changed ? "after!" : "before");
  } finally { await rm(f.container, { recursive: true, force: true }); }
 });
}
