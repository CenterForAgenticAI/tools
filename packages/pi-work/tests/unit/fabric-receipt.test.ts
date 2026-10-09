import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordFabricDispatchReceipt, verifyFabricDispatchDigests } from "../../src/dispatch/fabric/receipt.ts";
import { decodeDelegateRuntimeReceipt } from "../../src/dispatch/runtime.ts";
import type { PlanReceipt } from "../../src/plan/types.ts";
import { readStatusCache } from "../../src/status/cache.ts";
import { deriveStatus } from "../../src/status/index.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "fabric-receipt-"));
	const briefPath = path.join(root, "brief.md");
	await writeFile(briefPath, "abc");
	const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
	git(["init", "-q", "-b", "fixture"]); git(["add", "."]);
	git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	git(["worktree", "add", "-qb", "worker-branch", path.join(root, "worker")]);
	const run = { name: "node", agent: "worker", task: "abc", mode: "solo", cwd: root, reads: [briefPath], confineWrites: true, escalation: "off", worktree: true, model: "alias" } as const;
	const plan: PlanReceipt = { nodeId: "node", nodeAddress: ["node"], schemaPath: ["work", 0], briefPath, briefSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", delegate: { ...run }, canonicalDelegate: { runs: [run] } };
	const target = { worktreePath: root, headCommit: "a".repeat(40), branch: "parent", specPath: path.join(root, "spec.yaml"), cachePath: path.join(root, "status.json") };
	return { root, plan, target };
}

test("receipt-parity: persists a compatible receipt and status history without copying caller extras", async () => {
	const f = await fixture();
	try {
		const value = { id: "run-1", text: "worker completed", model: "provider/canonical", requestedModel: "alias", resumeCount: 3, totalAttempts: 4, worktreeResult: { path: path.join(f.root, "worker"), branch: "worker-branch", baseRef: "main", secret: "discard" }, secret: "discard" };
		const recorded = await recordFabricDispatchReceipt({ plan: f.plan, target: f.target, value, createdAt: "2026-10-06T12:00:00.000Z" });
		assert.ok(!("outcome" in recorded));
		assert.equal(recorded.cacheWrite.status, "written");
		assert.equal(JSON.parse(await readFile(recorded.receipt.resultPath, "utf8")).text, "worker completed");
		assert.equal(recorded.receipt.runId, "run-1");
		assert.equal(recorded.receipt.resumeCount, 3);
		assert.equal(recorded.receipt.totalAttempts, 4);
		assert.equal(recorded.receipt.forks[0]?.name, "node");
		assert.equal(recorded.receipt.forks[0]?.requestedModel, "alias");
		assert.equal(recorded.receipt.forks[0]?.resolvedModel, "provider/canonical");
		assert.equal(recorded.receipt.forks[0]?.workerCwd, path.join(f.root, "worker"));
		assert.equal(recorded.receipt.forks[0]?.branch, "worker-branch");
		assert.ok(decodeDelegateRuntimeReceipt(JSON.parse(await readFile(recorded.receipt.receiptPath, "utf8"))));
		assert.equal((await readFile(recorded.receipt.receiptPath, "utf8")).includes("discard"), false);
		assert.equal((await readFile(recorded.receipt.resultPath, "utf8")).includes("discard"), false);
		const cache = await readStatusCache(f.target.cachePath);
		assert.deepEqual(cache.findings, []);
		const source = withDraftLineage("title: receipt\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: signal\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n", { cwd: f.root });
		const status = deriveStatus({ source, specPath: f.target.specPath, tree: { kind: "git", worktreePath: f.root, resolvedCommit: f.target.headCommit }, cache: cache.cache });
		assert.equal(status.ok, true, JSON.stringify(status.details.findings));
		assert.equal(status.details.nodes[0]?.dispatches[0]?.runId, "run-1");
		assert.equal(status.details.nodes[0]?.dispatches[0]?.slot.resolvedModel, "provider/canonical");
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("digest-chain: known vectors and independent recomputation detect each altered namespace", async () => {
	const f = await fixture();
	try {
		const run = f.plan.canonicalDelegate.runs[0];
		const handoff = { tasks: ["one"], focus: { objective: "ship", boundaries: ["src/**"] } };
		const plan: PlanReceipt = { ...f.plan, handoffSha256: "79b2a602ceb42ef0c50814dc8e90274ab9c06e8fc8fab32355703f1dd6ccb452", focusSha256: "fe233ef85dec848fe3c94bcd25154fc6d9146ed657a8ed626926e5e46543d64d", canonicalDelegate: { runs: [{ ...run, handoff }] } };
		const recorded = await recordFabricDispatchReceipt({ plan, target: f.target, value: { id: "digests", model: "canonical/model", worktreeResult: { path: f.root, branch: "worker" } } });
		assert.ok(!("outcome" in recorded));
		const { receipt } = recorded;
		assert.deepEqual(receipt.forks[0]?.inputDigests.map((item) => [item.kind, item.digest]), [
			["task", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
			["read", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
			["checklist", "79b2a602ceb42ef0c50814dc8e90274ab9c06e8fc8fab32355703f1dd6ccb452"],
			["focus", "fe233ef85dec848fe3c94bcd25154fc6d9146ed657a8ed626926e5e46543d64d"],
		]);
		assert.equal(await verifyFabricDispatchDigests(receipt, plan), true);
		for (const kind of ["task", "read", "checklist", "focus"]) {
			const fork = receipt.forks[0]!;
			const changed = { ...receipt, forks: [{ ...fork, inputDigests: fork.inputDigests.map((item) => item.kind === kind ? { ...item, digest: "0".repeat(64) } : item) }] };
			assert.equal(await verifyFabricDispatchDigests(changed, plan), false, kind);
		}
		await writeFile(plan.briefPath, "changed brief");
		assert.equal(await verifyFabricDispatchDigests(receipt, plan), false);
		await assert.rejects(recordFabricDispatchReceipt({ plan, target: f.target, value: { id: "stale", model: "canonical/model", worktreeResult: { path: f.root, branch: "worker" } } }), /input digests/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("receipt-parity: rejects malformed identity, model, worktree and attempt metadata", async () => {
	const f = await fixture();
	try {
		const base = { id: "run", model: "canonical/model", worktreeResult: { path: f.root, branch: "worker" } };
		for (const value of [{ ...base, id: "" }, { ...base, model: undefined }, { ...base, worktreeResult: { path: "relative", branch: "worker" } }, { ...base, resumeCount: -1 }, { ...base, resumeCount: 4 }, { ...base, resumeCount: 1, totalAttempts: 1 }]) {
			await assert.rejects(recordFabricDispatchReceipt({ plan: f.plan, target: f.target, value }));
		}
		const recorded = await recordFabricDispatchReceipt({ plan: { ...f.plan, canonicalDelegate: { runs: [{ ...f.plan.canonicalDelegate.runs[0], worktree: false }] } }, target: f.target, value: { id: "../../escape", model: "canonical/model" } });
		assert.ok(!("outcome" in recorded));
		const { receipt } = recorded;
		assert.equal(receipt.resumeCount, 0);
		assert.equal(receipt.totalAttempts, 1);
		assert.ok(receipt.receiptPath.startsWith(path.join(f.root, "fabric") + path.sep));
		await assert.rejects(recordFabricDispatchReceipt({ plan: { ...f.plan, canonicalDelegate: { runs: [{ ...f.plan.canonicalDelegate.runs[0], worktree: false }] } }, target: f.target, value: { id: "../../escape", model: "canonical/model" } }), /EEXIST/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

