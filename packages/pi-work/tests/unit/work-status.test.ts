import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { workStatusTool, MAX_RENDERED_TEXT, type WorkStatusDetails } from "../../src/tools/work-status.ts";
import { statusCachePath } from "../../src/status/cache.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

const execFileAsync = promisify(execFile);

async function fixtureRepo(spec: string): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-status-tool-"));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage(spec, { cwd: root }));
	await writeFile(path.join(root, ".gitignore"), ".work/.cache/\n");
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["add", "-f", "spec.yaml", ".gitignore", ".test-dist"], { cwd: root });
	await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
	const commit = (await execFileAsync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })).stdout.trim();
	return { root, commit };
}

function execute(params: Record<string, unknown>, signal?: AbortSignal) {
	return workStatusTool.execute("test", params, signal, undefined, {} as never) as Promise<{ content: [{ type: "text"; text: string }]; details: WorkStatusDetails }>;
}

const SPEC = withDraftLineage(`title: status\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`);
const DEPENDENCY_SPEC = withDraftLineage(`title: status\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n  - id: dependent\n    task: wait for node\n    depends_on: [node]\n    acceptance:\n      - id: B\n        statement: dependent signal\n        evidence:\n          kind: command\n          run: printf dependent\n          expect:\n            exit: 0\n            output_includes: dependent\n`);

function dispatchHint(root: string, commit: string, runId: string, nodeId: string) {
	const briefPath = path.join(root, ".work", ".cache", "briefs", `${nodeId}.md`);
	return {
		runId,
		forkName: `${nodeId}-fork`,
		nodeId,
		address: [nodeId],
		createdAt: "2026-08-13T12:00:00.000Z",
		worktreePath: root,
		headCommit: commit,
		branch: "fixture",
		briefPath,
		briefSha256: "b".repeat(64),
		slot: { agent: "implementer", maxRounds: 5, inputDigests: [] },
		receiptPath: path.join(root, "delegate", runId, "receipt.json"),
		resultPath: path.join(root, "delegate", runId, "result.json"),
	};
}

test("work_status is exported, strict, explicit, bounded, and unregistered", async () => {
	assert.equal(workStatusTool.name, "work_status");
	assert.equal(workStatusTool.parameters.additionalProperties, false);
	const repo = await fixtureRepo(SPEC);
	try {
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });

		assert.equal(result.details.valid, true);
		assert.equal(result.details.nodes[0]?.lifecycle, "ready");
		assert.equal(result.details.nodes[0]?.verification, "unverified");
		assert.equal(result.details.specState, "not-done");
		assert.ok(result.content[0].text.length <= MAX_RENDERED_TEXT);
		assert.match(result.content[0].text, /READY — dependencies are done/);
		assert.match(result.content[0].text, /No verification observation is available/);
		assert.equal(result.details.cachePath, statusCachePath(repo.root, path.join(repo.root, "spec.yaml")));
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("work_status surfaces dispatch joins as hints without changing lifecycle or dependency gating", async () => {
	const repo = await fixtureRepo(DEPENDENCY_SPEC);
	try {
		const specPath = path.join(repo.root, "spec.yaml");
		const cachePath = statusCachePath(repo.root, specPath);
		const nodeRunId = "run-status-node";
		const dependentRunId = "run-status-dependent";
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, JSON.stringify({
			kind: "pi-work-status-cache",
			version: 1,
			specPath,
			verification: {},
			review: {},
			dispatch: {
				[nodeRunId]: dispatchHint(repo.root, repo.commit, nodeRunId, "node"),
				[dependentRunId]: dispatchHint(repo.root, repo.commit, dependentRunId, "dependent"),
			},
		}));
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		const node = result.details.nodes.find((entry) => entry.nodeId === "node");
		const dependent = result.details.nodes.find((entry) => entry.nodeId === "dependent");
		assert.equal(node?.lifecycle, "ready");
		assert.equal(node?.verification, "unverified");
		assert.equal(node?.dispatches[0]?.runId, nodeRunId);
		assert.equal(dependent?.lifecycle, "blocked");
		assert.equal(dependent?.verification, "unverified");
		assert.equal(dependent?.dispatches[0]?.runId, dependentRunId);
		assert.deepEqual(dependent?.blockers.find((blocker) => blocker.code === "dependency"), { code: "dependency", addresses: [["node"]] });
		assert.equal(result.details.specState, "not-done");
		assert.equal(result.details.dispatch[nodeRunId]?.nodeId, "node");
		assert.equal(result.details.dispatch[dependentRunId]?.nodeId, "dependent");
		assert.match(result.content[0].text, /dispatch hint only: node node ↔ run run-status-node\/node-fork/);
		assert.match(result.content[0].text, /dispatch hint only: node dependent ↔ run run-status-dependent\/dependent-fork/);
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("refresh reports the missing production authority instead of passing", async () => {
	const repo = await fixtureRepo(SPEC);
	try {
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit, refresh: { nodeAddresses: [["node"]] } });
		assert.equal(result.details.refresh.status, "blocked");
		assert.equal(result.details.refresh.ran, false);
		assert.equal(result.details.refreshed, false);
		assert.match(result.content[0].text, /refresh: blocked/);
		assert.equal(result.details.nodes[0]?.lifecycle, "ready");
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("invalid specs have no cache side effects through the tool boundary", async () => {
	const repo = await fixtureRepo("work: [\n");
	try {
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.valid, false);
		assert.ok(result.details.findings.some((finding) => finding.code === "yaml-syntax"));
		await assert.rejects(access(statusCachePath(repo.root, path.join(repo.root, "spec.yaml"))));
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("explicit refresh selection rejects bare, duplicate, missing, and invalid checklist addresses", async () => {
	const repo = await fixtureRepo(SPEC);
	try {
		const bare = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit, refresh: { nodeAddresses: ["node"] } });
		assert.ok(bare.details.findings.some((finding) => finding.code === "refresh-address-required"));
		const duplicate = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit, refresh: { nodeAddresses: [["node"], ["node"]] } });
		assert.ok(duplicate.details.findings.some((finding) => finding.code === "duplicate-node-address"));
		const missing = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit, refresh: { nodeAddresses: [["missing"]] } });
		assert.ok(missing.details.findings.some((finding) => finding.code === "missing-node-address"));
		const wrongChecklist = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit, refresh: { checklists: [{ nodeAddress: ["node"], reports: [{ index: 0, done: true }, { index: 0, done: false }] }] } });
		assert.ok(wrongChecklist.details.findings.some((finding) => finding.code === "invalid-checklist-report"));
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("already-aborted calls stop at the owned status boundary", async () => {
	const repo = await fixtureRepo(SPEC);
	try {
		const controller = new AbortController();
		controller.abort();
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit }, controller.signal);
		assert.equal(result.details.valid, false);
		assert.equal(result.details.findings[0]?.code, "verification-aborted");
		await assert.rejects(access(statusCachePath(repo.root, path.join(repo.root, "spec.yaml"))));
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("explicit tree and spec path failures are typed", async () => {
	const repo = await fixtureRepo(SPEC);
	try {
		const mismatch = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: "0".repeat(40) });
		assert.equal(mismatch.details.findings[0]?.code, "tree-identity-error");
		const escaped = await execute({ path: "../outside.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(escaped.details.findings[0]?.code, "spec-path-escape");
		const missing = await execute({ path: "missing.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(missing.details.findings[0]?.code, "spec-read-error");
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});

test("status boundary rejects malformed requests and cache reads without deriving done", async () => {
	const invalid = await execute({});
	assert.equal(invalid.details.valid, false);
	assert.equal(invalid.details.findings[0]?.code, "invalid-status-input");

	const missingRoot = await execute({ path: "spec.yaml", worktreePath: "/tmp/pi-work-status-no-such-root", expectedCommit: "a".repeat(40) });
	assert.equal(missingRoot.details.valid, false);
	assert.equal(missingRoot.details.findings[0]?.code, "tree-identity-error");

	const repo = await fixtureRepo(SPEC);
	try {
		const cachePath = statusCachePath(repo.root, path.join(repo.root, "spec.yaml"));
		await mkdir(cachePath, { recursive: true });
		const result = await execute({ path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.valid, true);
		assert.ok(result.details.findings.some((finding) => finding.code === "cache-read-error"));
		assert.equal(result.details.nodes[0]?.lifecycle, "ready");
		assert.equal(result.details.specState, "not-done");
	} finally {
		await rm(repo.root, { recursive: true, force: true });
	}
});
