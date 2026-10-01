import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { forgetSessionVerifications } from "../../src/status/session-verification.ts";
import { workStatusTool, type WorkStatusDetails } from "../../src/tools/work-status.ts";
import { statusCachePath, readStatusCache } from "../../src/status/cache.ts";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { removeTempTree } from "../helpers/temp-tree.ts";

import { workVerifyTool, type WorkVerifyDetails } from "../../src/tools/work-verify.ts";
import { decodeVerificationCacheUpdate } from "../../src/verify/index.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";
import { systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

const execFileAsync = promisify(execFile);
const systemdPrerequisite = await systemdContainmentPrerequisite();
const hostCommandPrerequisite = process.platform === "darwin" ? { available: true, reason: undefined } : systemdPrerequisite;

async function fixtureRepo(spec = `title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`, options: { draftLineage?: boolean } = {}): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-tool-repo-"));
	// A criteria-free spec has no lineage to carry, and the helper's generated draft
	// would not be committed into the fixture tree.
	await writeFile(path.join(root, "spec.yaml"), options.draftLineage === false ? spec : withDraftLineage(spec, { cwd: root }));
	const git = (args: string[]) => execFileAsync("git", args, { cwd: root, timeout: 5000 });
	await git(["init", "-q"]);
	await git(options.draftLineage === false ? ["add", "-f", "spec.yaml"] : ["add", "-f", "spec.yaml", ".test-dist"]);
	await git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	const result = await git(["rev-parse", "HEAD^{commit}"]);
	return { root, commit: result.stdout.trim() };
}

function execute(params: Record<string, unknown>, cwd = REPO_ROOT) {
	return workVerifyTool.execute("test", params, undefined, undefined, { cwd, sessionManager: undefined } as never) as Promise<{ content: { type: string; text?: string }[]; details: WorkVerifyDetails }>;
}

test("work_verify is exported but has no registration side effect and requires explicit identity", async () => {
	assert.equal(workVerifyTool.name, "work_verify");
	assert.equal(workVerifyTool.parameters.additionalProperties, false);
	assert.equal(typeof workVerifyTool.execute, "function");
	const repo = await fixtureRepo();
	const mismatch = await execute({ path: "spec.yaml", nodeId: "x", worktreePath: repo.root, expectedCommit: "0".repeat(40) });
	assert.equal(mismatch.details.failures[0]?.code, "tree-identity-unavailable");
	await removeTempTree(repo.root);
});

test("host integration: work_verify executes an authoritative command and returns its cache update", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo();
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.equal(result.details.outcome, "passed");
	assert.equal(result.details.result?.tree.resolvedCommit, repo.commit);
	const proof = result.details.result?.outcome === "passed" ? result.details.result.criteria[0].proof : undefined;
	assert.equal(proof?.kind === "command-proof" && proof.containment, process.platform === "darwin" ? "process-group" : "systemd-scope");
	assert.equal(result.details.cacheUpdate?.tree.worktreePath, await realpath(repo.root));
	assert.ok(result.details.cacheUpdate);
	assert.equal(result.details.cacheWrite?.status, "written");
	const cachePath = statusCachePath(repo.root, path.join(repo.root, "spec.yaml"));
	const persisted = await readStatusCache(cachePath);
	assert.equal(persisted.cache?.verification[JSON.stringify(["node"])]?.update.record.outcome, "passed");
	assert.match(result.content[0]?.text ?? "", /passed/);
	await rm(cachePath, { force: true });
	await removeTempTree(repo.root);
});

test("work_verify redacts an inherited dirty filename in its response and cache", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const name = "PI_WORK_REVIEW_SECRET";
	const secret = "REVIEW_SECRET_984521";
	const previous = process.env[name];
	process.env[name] = secret;
	const spec = `title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: modify a tracked file\n        evidence:\n          kind: command\n          run: printf changed > "$PI_WORK_REVIEW_SECRET"; printf done\n          inherit_env: [${name}]\n          expect:\n            exit: 0\n            output_includes: done\n`;
	const repo = await fixtureRepo(spec);
	try {
		await writeFile(path.join(repo.root, secret), "original");
		await execFileAsync("git", ["add", secret], { cwd: repo.root });
		await execFileAsync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "tracked secret filename"], { cwd: repo.root });
		const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
		const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: commit });
		assert.equal(result.details.outcome, "failed");
		assert.equal(result.details.failures.some((failure) => failure.code === "tree-dirty"), true);
		assert.equal(JSON.stringify(result).includes(secret), false, JSON.stringify(result));
		const cache = await readFile(statusCachePath(repo.root, path.join(repo.root, "spec.yaml")), "utf8");
		assert.equal(cache.includes(secret), false);
		const status = await workStatusTool.execute("test", { path: "spec.yaml", worktreePath: repo.root, expectedCommit: commit }, undefined, undefined, {} as never);
		assert.equal(JSON.stringify(status).includes(secret), false);
		const replay = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: commit });
		assert.equal(JSON.stringify(replay).includes(secret), false);
	} finally {
		if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
		await removeTempTree(repo.root);
	}
});

test("a later criterion cannot persist an earlier criterion's inherited secret as an untracked path", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const name = "PI_WORK_CROSS_CRITERION_SECRET";
	const secret = "cross-criterion-secret-984521";
	const previous = process.env[name];
	process.env[name] = secret;
	const spec = `title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: create an untracked file\n        evidence:\n          kind: command\n          run: 'touch "$PI_WORK_CROSS_CRITERION_SECRET"; printf first'\n          inherit_env: [${name}]\n          expect:\n            exit: 0\n            output_includes: first\n      - id: B\n        statement: observe the path\n        evidence:\n          kind: command\n          run: printf second\n          expect:\n            exit: 0\n            output_includes: second\n`;
	const repo = await fixtureRepo(spec);
	try {
		const params = { path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit };
		const verified = await execute(params);
		assert.equal(verified.details.outcome, "passed", JSON.stringify(verified.details.failures));
		assert.equal(JSON.stringify(verified).includes(secret), false, "work_verify response");
		const cache = await readFile(statusCachePath(repo.root, path.join(repo.root, "spec.yaml")), "utf8");
		assert.equal(cache.includes(secret), false, "persisted cache");
		const status = await workStatusTool.execute("test", params, undefined, undefined, {} as never);
		assert.equal(JSON.stringify(status).includes(secret), false, "work_status response");
	} finally {
		if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
		forgetSessionVerifications();
		await removeTempTree(repo.root);
	}
});

test("a later node cannot persist an earlier node's inherited secret as an untracked path", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const name = "PI_WORK_CROSS_NODE_SECRET";
	const secret = "cross-node-secret-984521";
	const previous = process.env[name];
	process.env[name] = secret;
	const spec = `title: Verify
description: D
intent: I
work:
  - id: first
    task: create an untracked file
    acceptance:
      - id: A
        statement: create a named file
        evidence:
          kind: command
          run: 'touch "$PI_WORK_CROSS_NODE_SECRET"; printf first'
          inherit_env: [${name}]
          expect:
            exit: 0
            output_includes: first
  - id: second
    task: observe paths
    acceptance:
      - id: B
        statement: observe the path
        evidence:
          kind: command
          run: printf second
          expect:
            exit: 0
            output_includes: second
`;
	const repo = await fixtureRepo(spec);
	try {
		const params = { path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit };
		const first = await execute({ ...params, nodeId: "first" });
		assert.equal(first.details.outcome, "passed", JSON.stringify(first.details.failures));
		const second = await execute({ ...params, nodeId: "second" });
		assert.equal(second.details.outcome, "failed", "an untracked file makes the next verification tree dirty");
		assert.equal(second.details.failures[0]?.code, "tree-dirty");
		assert.equal(JSON.stringify(second).includes(secret), false, "later work_verify response");
		const cache = await readFile(statusCachePath(repo.root, path.join(repo.root, "spec.yaml")), "utf8");
		assert.equal(cache.includes(secret), false, "cache of both nodes");
		const status = await workStatusTool.execute("test", params, undefined, undefined, {} as never);
		assert.equal(JSON.stringify(status).includes(secret), false, "later work_status response");
	} finally {
		if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
		forgetSessionVerifications();
		await removeTempTree(repo.root);
	}
});

test("work_verify treats a cache write failure as incomplete, without trusting its evidence", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	forgetSessionVerifications();
	const repo = await fixtureRepo();
	try {
		const cachePath = statusCachePath(repo.root, path.join(repo.root, "spec.yaml"));
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, "{broken");
		const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.result?.outcome, "passed", "the executed evidence remains visible");
		assert.equal(result.details.cacheWrite?.status, "failed");
		assert.equal(result.details.outcome, "failed");
		assert.equal(result.details.failures.some((failure) => failure.code === "verification-aborted"), true);
		const status = await workStatusTool.execute("test", { path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, {} as never);
		assert.notEqual((status.details as WorkStatusDetails).nodes.find((node) => node.address.join("/") === "node")?.lifecycle, "done");
	} finally {
		forgetSessionVerifications();
		await removeTempTree(repo.root);
	}
});

test("host integration: work_verify honors authored command timeout and retains it in the cache update", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: release gate\n    acceptance:\n      - id: A\n        statement: delayed result\n        evidence:\n          kind: command\n          run: sleep 1.2; printf delayed\n          expect:\n            exit: 0\n            output_includes: delayed\n          timeout_ms: 3000\n`);
	try {
		const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.outcome, "passed", JSON.stringify(result.details.failures));
		const proof = result.details.result?.outcome === "passed" ? result.details.result.criteria[0].proof : undefined;
		assert.equal(proof?.kind === "command-proof" && proof.timeout_ms, 3000);
		const decoded = decodeVerificationCacheUpdate(JSON.parse(JSON.stringify(result.details.cacheUpdate)));
		assert.equal(decoded?.record.outcome, "passed");
	} finally {
		await removeTempTree(repo.root);
	}
});

test("host integration: work_verify completes beyond the former 30s command ceiling", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: slow release gate\n    acceptance:\n      - id: A\n        statement: delayed result\n        evidence:\n          kind: command\n          run: sleep 31; printf delayed\n          expect:\n            exit: 0\n            output_includes: delayed\n          timeout_ms: 40000\n`);
	try {
		const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.outcome, "passed", JSON.stringify(result.details.failures));
		const proof = result.details.result?.outcome === "passed" ? result.details.result.criteria[0].proof : undefined;
		assert.equal(proof?.kind === "command-proof" && proof.timeout_ms, 40000);
		assert.ok(proof && proof.durationMs >= 30_000);
		if (proof?.kind === "command-proof") assert.ok(proof.monitoring.window.durationMs >= 30_000);
	} finally {
		await removeTempTree(repo.root);
	}
});

test("work_verify rejects semantic invalidity and unknown nodes before evidence", async () => {
	const invalid = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    depends_on: [missing]\n    task: run\n`);
	const invalidResult = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: invalid.root, expectedCommit: invalid.commit });
	assert.equal(invalidResult.details.outcome, "failed");
	assert.ok(invalidResult.details.findings.length > 0);
	const malformed = await fixtureRepo("work: [");
	const malformedResult = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: malformed.root, expectedCommit: malformed.commit });
	assert.equal(malformedResult.details.outcome, "failed");
	assert.ok(malformedResult.details.findings.length > 0);
	const valid = await fixtureRepo();
	const escaped = await execute({ path: "../outside.yaml", nodeId: "node", worktreePath: valid.root, expectedCommit: valid.commit });
	assert.equal(escaped.details.failures[0]?.code, "tree-identity-unavailable");
	const unknown = await execute({ path: "spec.yaml", nodeId: "unknown", worktreePath: valid.root, expectedCommit: valid.commit });
	assert.equal(unknown.details.outcome, "failed");
	assert.equal(unknown.details.failures[0]?.code, "no-execution-evidence");
	assert.ok((unknown.content[0]?.text ?? "").length <= 4000);
	const longUnknown = await execute({ path: "spec.yaml", nodeId: "x".repeat(5000), worktreePath: valid.root, expectedCommit: valid.commit });
	assert.equal(longUnknown.details.truncated, true);
	assert.ok((longUnknown.content[0]?.text ?? "").length <= 4000);
	await removeTempTree(invalid.root);
	await removeTempTree(malformed.root);
	await removeTempTree(valid.root);
});

test("host integration: work_verify resolves nested nodes through the production authority", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const nested = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: group\n    task: group\n    work:\n      - id: child\n        task: child\n        acceptance:\n          - id: A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n`);
	const nestedResult = await execute({ path: "spec.yaml", nodeId: "child", worktreePath: nested.root, expectedCommit: nested.commit });
	assert.equal(nestedResult.details.outcome, "passed");
	await removeTempTree(nested.root);
});

test("host integration: work_verify returns a tree-bound cache update that survives JSON decoding", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo();
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.ok(result.details.cacheUpdate);
	const decoded = decodeVerificationCacheUpdate(JSON.parse(JSON.stringify(result.details.cacheUpdate)));
	assert.ok(decoded);
	if (decoded) assert.equal(decoded.tree.resolvedCommit, repo.commit);
	await removeTempTree(repo.root);
});

test("work_verify persists failed observations without exposing inherited secrets", async () => {
	const name = "PI_WORK_TEST_CACHE_SECRET";
	const secret = "secret-for-persisted-cache-82631";
	const previous = process.env[name];
	process.env[name] = secret;
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: secret output must not escape\n        evidence:\n          kind: command\n          run: printf %s "$${name}"; exit 3\n          inherit_env: [${name}]\n          expect:\n            exit: 0\n            output_includes: ${secret}\n`);
	const cachePath = statusCachePath(repo.root, path.join(repo.root, "spec.yaml"));
	try {
		const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
		assert.equal(result.details.outcome, "failed");
		assert.equal(result.details.cacheWrite?.status, "written");
		const persisted = await readFile(cachePath, "utf8");
		assert.ok(persisted.includes(name));
		assert.equal((result.content[0]?.text ?? "").includes(secret), false);
		assert.equal(JSON.stringify(result.details).includes(secret), false);
		assert.equal(persisted.includes(secret), false);
		assert.equal((await readStatusCache(cachePath)).cache?.verification[JSON.stringify(["node"])]?.update.record.outcome, "failed");
	} finally {
		if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
		await rm(cachePath, { force: true });
		await removeTempTree(repo.root);
	}
});

test("work_verify accounts for explicit false checklist reports", async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    checklist:\n      - first\n      - second\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`);
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit, checklistReports: [{ index: 0, done: true }, { index: 1, done: false }] });
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.result?.checklist.outcome, "incomplete");
	await removeTempTree(repo.root);
});

test("host integration: work_verify detects HEAD movement and executes in the explicit target tree", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: moved\n        evidence:\n          kind: command\n          run: git -c user.name=pi-work -c user.email=pi-work@example.invalid commit --allow-empty -qm moved; printf moved\n          expect:\n            exit: 0\n            output_includes: moved\n`);
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.equal(result.details.outcome, "failed");
	assert.ok(result.details.failures.some((failure) => failure.code === "tree-changed"));
	await removeTempTree(repo.root);
});

test("work_verify handles missing specs without throwing", async () => {
	const repo = await fixtureRepo();
	const result = await execute({ path: "missing-spec.yaml", nodeId: "x", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.findings[0]?.code, "read-error");
	await removeTempTree(repo.root);
});

test("work_verify reports a node-free spec as unverifiable rather than throwing", async () => {
	// A root `work: []` validates: the schema sets no minItems on the root list. Node
	// lookup must therefore fail closed on the empty list instead of dereferencing a
	// node it never found.
	const empty = await fixtureRepo("title: Verify\ndescription: D\nintent: I\nwork: []\n", { draftLineage: false });
	const result = await execute({ path: "spec.yaml", nodeId: "any", worktreePath: empty.root, expectedCommit: empty.commit });
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.failures[0]?.code, "no-execution-evidence");
	assert.equal(result.details.result, undefined);
	assert.equal(result.details.cacheUpdate, undefined);
	await removeTempTree(empty.root);
});
