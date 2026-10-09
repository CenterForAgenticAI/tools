import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { forgetSessionVerifications } from "../../src/status/session-verification.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function flow(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
 const f = await fixture();
 try { await run(f); } finally { forgetSessionVerifications(); await rm(f.root, { recursive: true, force: true }); }
}
async function fixture() {
 const scratch = path.resolve(".scratch/tmp");
 await mkdir(scratch, { recursive: true });
 const root = await realpath(await mkdtemp(path.join(scratch, "result-flow-")));
 await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: result\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: persist accounting\n    checklist: [review complete]\n    touches: [src/**]\n    acceptance:\n      - id: signal\n        statement: check independently\n        evidence:\n          kind: user\n          prompt: confirm independently\n", { cwd: root }));
 await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\n");
 const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
 git(["init", "-q", "-b", "fixture"]); git(["add", "-f", "spec.yaml", ".gitignore", ".test-dist"]);
 git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
 const commit = git(["rev-parse", "HEAD"]).trim();
 const workerResult = { changedPaths: ["src/example.ts"], commit, evidence: "worker says exit 0", checklist: [{ index: 0, done: true }], gaps: "worker accounting only" };
 const tools = new Map<string, ToolDefinition>();
 piWork({ events: { emit(channel: string, data: unknown) {
  if (channel !== "pi-fabric:program:run:v1") return;
  const request = data as FabricProgramRunRequest;
  request.reply({ ok: true, program: request.ref, logs: [], value: { id: "result-run", status: "completed", model: "test/model", value: workerResult } });
 }, on() { return () => {}; } }, getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
 let confirmations = 0;
 let approve = true;
 const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "result-session", getSessionFile: () => undefined, getBranch: () => [] }, ui: { confirm: async () => { confirmations++; return approve; } } } as never;
 const target = { path: "spec.yaml", worktreePath: root, expectedCommit: commit };
 const dispatched = await tools.get("work_dispatch")!.execute("dispatch", { ...target, nodeAddress: ["node"], backend: "fabric" }, undefined, undefined, ctx);
 assert.equal((dispatched.details as { outcome: string }).outcome, "dispatched", JSON.stringify(dispatched.details));
 const status = async () => await tools.get("work_status")!.execute("status", target, undefined, undefined, ctx) as { details: { nodes: { dispatches: { workerResult?: unknown }[]; lifecycle: string }[] } };
 const verify = async () => await tools.get("work_verify")!.execute("verify", { ...target, nodeId: "node" }, undefined, undefined, ctx) as { details: import("../../src/tools/work-verify.ts").WorkVerifyDetails };
 const receiptPath = (dispatched.details as { receipt: { receiptPath: string } }).receipt.receiptPath;
 return { root, commit, workerResult, receiptPath, status, verify, confirmations: () => confirmations, deny: () => { approve = false; } };
}

test("result-persisted: registered dispatch saves accounting and status/verify consume it without trusting evidence", async () => flow(async f => {
 const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
 const saved = JSON.parse(await readFile(receipt.resultPath, "utf8"));
 assert.deepEqual(saved.workerResult, f.workerResult);
 const status = await f.status();
 assert.deepEqual(status.details.nodes[0].dispatches[0].workerResult, f.workerResult);
 assert.notEqual(status.details.nodes[0].lifecycle, "done");
 const verified = await f.verify();
 assert.equal(verified.details.outcome, "passed", JSON.stringify(verified.details));
 assert.equal(verified.details.result?.checklist.outcome, "complete");
 assert.equal(f.confirmations(), 1);
 f.deny();
 const denied = await f.verify();
 assert.equal(denied.details.outcome, "failed");
 assert.equal(f.confirmations(), 2);
}));

for (const kind of ["read", "checklist", "focus"] as const) {
 test(`digest-verified: work_verify rejects a tampered ${kind} digest before asking for evidence`, async () => flow(async f => {
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  const digest = receipt.forks[0].inputDigests.find((item: { kind: string }) => item.kind === kind);
  assert.ok(digest, `fixture must submit ${kind}`);
  digest.digest = "0".repeat(64);
  await writeFile(f.receiptPath, JSON.stringify(receipt));
  const result = await f.verify();
  assert.equal(result.details.outcome, "failed");
  assert.match(JSON.stringify(result.details.failures), /Fabric dispatch input digest mismatch/);
  assert.equal(result.details.cacheUpdate, undefined);
  assert.equal(f.confirmations(), 0);
 }));
}

test("digest-verified: modified brief bytes and handoff sources are independently recomputed", async () => flow(async f => {
 const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
 const saved = JSON.parse(await readFile(receipt.resultPath, "utf8"));
 const original = await readFile(saved.digestInputs.briefPath, "utf8");
 await writeFile(saved.digestInputs.briefPath, `${original}\nchanged`);
 const brief = await f.verify();
 assert.equal(brief.details.outcome, "failed");
 assert.match(JSON.stringify(brief.details.failures), /digest mismatch/);
 await writeFile(saved.digestInputs.briefPath, original);
 saved.digestInputs.handoff.tasks = ["substituted task"];
 await writeFile(receipt.resultPath, JSON.stringify(saved));
 const handoff = await f.verify();
 assert.equal(handoff.details.outcome, "failed");
 assert.match(JSON.stringify(handoff.details.failures), /digest mismatch/);
 assert.equal(f.confirmations(), 0);
}));

for (const attack of ["extra-proof", "wrong-commit", "outside-symlink"] as const) {
 test(`result-persisted: ${attack} accounting cannot bypass verification`, async () => flow(async f => {
  const receipt = JSON.parse(await readFile(f.receiptPath, "utf8"));
  const saved = JSON.parse(await readFile(receipt.resultPath, "utf8"));
  if (attack === "extra-proof") {
   saved.workerResult.verification = { outcome: "passed" };
   await writeFile(receipt.resultPath, JSON.stringify(saved));
  } else if (attack === "wrong-commit") {
   saved.workerResult.commit = "a".repeat(40);
   await writeFile(receipt.resultPath, JSON.stringify(saved));
  } else {
   const outside = path.join(f.root, ".pi", "outside-result.json");
   await mkdir(path.dirname(outside), { recursive: true });
   await writeFile(outside, JSON.stringify(saved));
   await unlink(receipt.resultPath);
   await symlink(outside, receipt.resultPath);
  }
  const result = await f.verify();
  assert.equal(result.details.outcome, "failed");
  assert.equal(result.details.cacheUpdate, undefined);
  assert.equal(f.confirmations(), 0);
 }));
}
