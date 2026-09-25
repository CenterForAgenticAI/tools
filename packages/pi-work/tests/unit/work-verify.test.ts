import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
	await rm(repo.root, { recursive: true, force: true });
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
	assert.match(result.content[0]?.text ?? "", /passed/);
	await rm(repo.root, { recursive: true, force: true });
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
		await rm(repo.root, { recursive: true, force: true });
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
		await rm(repo.root, { recursive: true, force: true });
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
	await rm(invalid.root, { recursive: true, force: true });
	await rm(malformed.root, { recursive: true, force: true });
	await rm(valid.root, { recursive: true, force: true });
});

test("host integration: work_verify resolves nested nodes through the production authority", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const nested = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: group\n    task: group\n    work:\n      - id: child\n        task: child\n        acceptance:\n          - id: A\n            statement: signal\n            evidence:\n              kind: command\n              run: printf signal\n              expect:\n                exit: 0\n                output_includes: signal\n`);
	const nestedResult = await execute({ path: "spec.yaml", nodeId: "child", worktreePath: nested.root, expectedCommit: nested.commit });
	assert.equal(nestedResult.details.outcome, "passed");
	await rm(nested.root, { recursive: true, force: true });
});

test("host integration: work_verify returns a tree-bound cache update that survives JSON decoding", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo();
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.ok(result.details.cacheUpdate);
	const decoded = decodeVerificationCacheUpdate(JSON.parse(JSON.stringify(result.details.cacheUpdate)));
	assert.ok(decoded);
	if (decoded) assert.equal(decoded.tree.resolvedCommit, repo.commit);
	await rm(repo.root, { recursive: true, force: true });
});

test("work_verify accounts for explicit false checklist reports", async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    checklist:\n      - first\n      - second\n    acceptance:\n      - id: A\n        statement: signal\n        evidence:\n          kind: command\n          run: printf signal\n          expect:\n            exit: 0\n            output_includes: signal\n`);
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit, checklistReports: [{ index: 0, done: true }, { index: 1, done: false }] });
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.result?.checklist.outcome, "incomplete");
	await rm(repo.root, { recursive: true, force: true });
});

test("host integration: work_verify detects HEAD movement and executes in the explicit target tree", { skip: hostCommandPrerequisite.available ? false : hostCommandPrerequisite.reason }, async () => {
	const repo = await fixtureRepo(`title: Verify\ndescription: D\nintent: I\nwork:\n  - id: node\n    task: run\n    acceptance:\n      - id: A\n        statement: moved\n        evidence:\n          kind: command\n          run: git -c user.name=pi-work -c user.email=pi-work@example.invalid commit --allow-empty -qm moved; printf moved\n          expect:\n            exit: 0\n            output_includes: moved\n`);
	const result = await execute({ path: "spec.yaml", nodeId: "node", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.equal(result.details.outcome, "failed");
	assert.ok(result.details.failures.some((failure) => failure.code === "tree-changed"));
	await rm(repo.root, { recursive: true, force: true });
});

test("work_verify handles missing specs without throwing", async () => {
	const repo = await fixtureRepo();
	const result = await execute({ path: "missing-spec.yaml", nodeId: "x", worktreePath: repo.root, expectedCommit: repo.commit });
	assert.equal(result.details.outcome, "failed");
	assert.equal(result.details.findings[0]?.code, "read-error");
	await rm(repo.root, { recursive: true, force: true });
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
	await rm(empty.root, { recursive: true, force: true });
});
