import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { DelegateDispatchRequest, DelegateRuntimeReceipt } from "../../src/dispatch/index.ts";
import { readStatusCache, statusCachePath } from "../../src/status/cache.ts";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const execFileAsync = promisify(execFile);
const SPEC = withDraftLineage(`title: dispatch\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    worker:\n      agent: implementer\n      skills: [implement-typescript]\n      model: test/model\n    touches: [src/**]\n    checklist: [preserve task carrier]\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`);

async function fixture(source = SPEC): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-dispatch-tool-"));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(source, { cwd: root }));
	await writeFile(path.join(root, ".gitignore"), ".work/.cache/\n");
	await execFileAsync("git", ["init", "-q", "-b", "fixture"], { cwd: root });
	await execFileAsync("git", ["add", "-f", "spec.yaml", ".gitignore", ".test-dist"], { cwd: root });
	await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
	const commit = (await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })).stdout.trim();
	return { root, commit };
}

function receipt(request: DelegateDispatchRequest, digest: string): DelegateRuntimeReceipt {
	const slot = "runs" in request ? request.runs[0] : request;
	assert.ok(slot.cwd);
	const tasks = "runs" in request ? request.runs[0].handoff?.tasks : undefined;
	return {
		schema: "pi-delegate.runtime-receipt",
		version: 1,
		runId: "run-tool",
		createdAt: "2026-08-13T12:00:00.000Z",
		shape: "direct",
		forks: [{
			name: "runs" in request ? request.runs[0].name : "node-fork",
			agent: slot.agent,
			...(slot.cwd === undefined ? {} : { workerCwd: slot.cwd }),
			branch: "fixture",
			maxRounds: 5,
			confineWrites: true,
			...(slot.model === undefined ? {} : { requestedModel: slot.model }),
			resolvedModel: "resolved/model",
			...(slot.skills === undefined ? {} : { skills: slot.skills }),
			inputDigests: [
				{ kind: "task", name: "task", algorithm: "sha256", digest: createHash("sha256").update(slot.task).digest("hex") },
				{ kind: "read", name: slot.reads[0], algorithm: "sha256", digest },
				...(tasks === undefined ? [] : [{ kind: "checklist" as const, name: "checklist", algorithm: "sha256" as const, digest: createHash("sha256").update(JSON.stringify(tasks)).digest("hex") }]),
			],
		}],
		receiptPath: path.join(slot.cwd, "delegate", "run-tool", "receipt.json"),
		resultPath: path.join(slot.cwd, "delegate", "run-tool", "result.json"),
	};
}

function execute(tool: ReturnType<typeof createWorkDispatchTool>, root: string, commit: string) {
	return tool.execute("test", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: root, expectedCommit: commit }, undefined, undefined, { cwd: root } as never) as Promise<{ content: [{ type: "text"; text: string }]; details: WorkDispatchDetails }>;
}

test("work_dispatch reuses one work_plan receipt, dispatches once in the caller worktree, and writes the join", async () => {
	const repo = await fixture();
	try {
		const requests: DelegateDispatchRequest[] = [];
		const tool = createWorkDispatchTool({
			clientProvider: async () => ({
				status: "available",
				grammar: "canonical",
				client: {
					async dispatch(request) {
						requests.push(request);
						const slot = "runs" in request ? request.runs[0] : request;
						const bytes = await readFile(slot.reads[0]);
						return receipt(request, createHash("sha256").update(bytes).digest("hex"));
					},
				},
			}),
		});
		const result = await execute(tool, repo.root, repo.commit);
		assert.equal(result.details.outcome, "dispatched");
		assert.equal(requests.length, 1);
		const request = requests[0]!;
		assert.ok("runs" in request);
		const run = request.runs[0];
		assert.equal(run.cwd, repo.root);
		assert.equal(run.worktree, false);
		assert.equal(run.name, "node");
		assert.deepEqual(run.handoff, {
			tasks: ["preserve task carrier"],
			focus: {
				objective: "run",
				boundaries: ["Confine writes to the declared touches: src/**"],
			},
		});
		assert.match(run.reads[0], new RegExp(`${result.details.outcome === "dispatched" ? result.details.plan.briefSha256 : "missing"}\\.md$`));
		if (result.details.outcome === "dispatched") {
			assert.equal(result.details.receipt.runId, "run-tool");
			assert.equal(result.details.cacheWrite.status, "written");
		}
		const cachePath = statusCachePath(repo.root, path.join(repo.root, "spec.yaml"));
		const cache = await readStatusCache(cachePath);
		assert.deepEqual(cache.findings, []);
		assert.equal(cache.cache?.dispatch["run-tool"]?.nodeId, "node");
		assert.equal(cache.cache?.dispatch["run-tool"]?.slot.resolvedModel, "resolved/model");
		assert.match(result.content[0].text, /dispatch: run-tool\/node/);
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("work_dispatch preserves the merge-base legacy request end to end", async () => {
	const repo = await fixture();
	try {
		const requests: DelegateDispatchRequest[] = [];
		const tool = createWorkDispatchTool({
			clientProvider: async () => ({
				status: "available",
				grammar: "legacy",
				client: {
					async dispatch(request) {
						requests.push(request);
						assert.ok(!("runs" in request));
						const bytes = await readFile(request.reads[0]);
						return receipt(request, createHash("sha256").update(bytes).digest("hex"));
					},
				},
			}),
		});
		const result = await execute(tool, repo.root, repo.commit);
		assert.equal(result.details.outcome, "dispatched");
		assert.equal(requests.length, 1);
		assert.ok(result.details.outcome === "dispatched");
		assert.deepEqual(requests[0], {
			agent: "implementer",
			task: "Execute the assembled work contract for node node; read the contract from the attached brief.",
			cwd: repo.root,
			reads: [result.details.plan.briefPath],
			skills: ["implement-typescript"],
			model: "test/model",
			writableRoots: ["src/**"],
			confineWrites: true,
			escalation: "local",
		});
		assert.equal(result.details.receipt.forks[0]?.name, "node-fork");
		assert.equal(result.details.cacheWrite.status, "written");
		assert.match(result.content[0].text, /dispatch: run-tool\/node-fork/);
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("work_dispatch returns a paste-ready plan-only degraded result without touching the status cache", async () => {
	const repo = await fixture();
	try {
		const tool = createWorkDispatchTool({ clientProvider: async () => ({ status: "unavailable", message: "optional package absent" }) });
		const result = await execute(tool, repo.root, repo.commit);
		assert.equal(result.details.outcome, "degraded");
		assert.equal(result.details.dispatchState, "not-dispatched");
		assert.equal("receipt" in result.details, false);
		if (result.details.outcome === "degraded") {
			assert.equal(result.details.plan.delegate.cwd, repo.root);
			assert.equal(result.details.plan.delegate.worktree, false);
			assert.deepEqual(result.details.plan.delegate.reads, [result.details.plan.briefPath]);
		}
		await assert.rejects(access(statusCachePath(repo.root, path.join(repo.root, "spec.yaml"))));
		assert.match(result.content[0].text, /use the paste-ready plan receipt/);
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("work_dispatch fails before loading the client for invalid source, unknown nodes, or detached worktrees", async () => {
	let providerCalls = 0;
	const tool = createWorkDispatchTool({ clientProvider: async () => { providerCalls += 1; return { status: "unavailable", message: "unused" }; } });
	const invalid = await fixture("work: [\n");
	try {
		const result = await execute(tool, invalid.root, invalid.commit);
		assert.equal(result.details.outcome, "rejected");
		assert.ok(result.details.findings.some((finding) => finding.code === "yaml-syntax"));
	} finally {
		await rm(invalid.root, { recursive: true, force: true });
	}
	const unknown = await fixture();
	try {
		const result = await tool.execute("test", { path: "spec.yaml", nodeAddress: ["missing"], worktreePath: unknown.root, expectedCommit: unknown.commit }, undefined, undefined, { cwd: unknown.root } as never) as { details: WorkDispatchDetails };
		assert.equal(result.details.outcome, "rejected");
		assert.ok(result.details.findings.some((finding) => finding.code === "node-address-not-found"));
	} finally {
		await rm(unknown.root, { recursive: true, force: true });
	}
	const detached = await fixture();
	try {
		await execFileAsync("git", ["checkout", "-q", "--detach", detached.commit], { cwd: detached.root });
		const result = await execute(tool, detached.root, detached.commit);
		assert.equal(result.details.outcome, "rejected");
		assert.ok(result.details.findings.some((finding) => finding.code === "dispatch-branch-unavailable"));
	} finally {
		await rm(detached.root, { recursive: true, force: true });
	}
	assert.equal(providerCalls, 0);
});

test("work_dispatch tool schema is strict and selects exactly one qualified node", () => {
	const tool = createWorkDispatchTool();
	assert.equal(tool.name, "work_dispatch");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.nodeAddress.type, "array");
	assert.equal("nodeAddresses" in tool.parameters.properties, false);
});
