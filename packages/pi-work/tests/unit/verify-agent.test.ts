import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgent } from "../../src/verify/agent.ts";
import { childLoaderArgs, REPO_ROOT, sourceModuleUrl } from "../helpers/source-under-test.ts";

async function setup() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-agent-"));
	await writeFile(path.join(root, "diagram.bin"), Buffer.from([0, 255, 1, 2]));
	return { root, tree: { kind: "git" as const, worktreePath: root, resolvedCommit: "a".repeat(40) } };
}

test("agent input failures happen before dispatch", async () => {
	const { root, tree } = await setup();
	let calls = 0;
	const judge = async () => { calls += 1; return { verdict: "approve" as const, dispatchReceipt: "r", inputDigests: [] }; };
	const result = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["missing.bin"], rubric: "inspect" }, tree }, { judge });
	assert.equal(result.outcome, "failed");
	assert.equal(calls, 0);
	if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "input-missing");
	await rm(root, { recursive: true, force: true });
});

test("agent approval accounts for byte digests and production defaults unavailable", async () => {
	const { root, tree } = await setup();
	const rejected = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree });
	assert.equal(rejected.outcome, "failed");
	if (rejected.outcome === "failed") assert.equal(rejected.failures[0]?.code, "agent-unavailable");
	const approved = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, {
		judge: async (request) => ({ verdict: "approve", dispatchReceipt: "receipt-1", inputDigests: request.inputs.map((input) => input.digest) }),
	});
	assert.equal(approved.outcome, "passed");
	if (approved.outcome === "passed") assert.equal(approved.proof.inputs[0]?.bytes, 4);
	const rejectedByJudge = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async () => ({ verdict: "reject", reason: "not legible" }) });
	assert.equal(rejectedByJudge.outcome, "failed");
	const malformed = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async () => ({ verdict: "approve", dispatchReceipt: "r", inputDigests: [] }) });
	assert.equal(malformed.outcome, "failed");
	if (malformed.outcome === "failed") assert.equal(malformed.failures[0]?.code, "agent-malformed");
	const malformedShape = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async () => ({ verdict: "surprise" } as never) });
	assert.equal(malformedShape.outcome, "failed");
	if (malformedShape.outcome === "failed") assert.equal(malformedShape.failures[0]?.code, "agent-malformed");
	const mismatchedDigests = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin", "diagram.bin"], rubric: "inspect" }, tree }, { judge: async (request) => ({ verdict: "approve", dispatchReceipt: "r", inputDigests: [request.inputs[0]!.digest, "0".repeat(64)] }) });
	assert.equal(mismatchedDigests.outcome, "failed");
	if (mismatchedDigests.outcome === "failed") assert.equal(mismatchedDigests.failures[0]?.code, "agent-malformed");
	const oversized = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { maxInputBytes: 1, judge: async () => ({ verdict: "approve", dispatchReceipt: "r", inputDigests: [] }) });
	assert.equal(oversized.outcome, "failed");
	if (oversized.outcome === "failed") assert.equal(oversized.failures[0]?.code, "input-too-large");
	await rm(root, { recursive: true, force: true });
});

test("agent rejects empty inputs, empty receipts, and cancellation at every boundary", async () => {
	const { root, tree } = await setup();
	let calls = 0;
	const empty = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: [], rubric: "inspect" }, tree }, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
	assert.equal(empty.outcome, "failed");
	if (empty.outcome === "failed") assert.equal(empty.failures[0]?.code, "agent-inputs-empty");
	assert.equal(calls, 0);
	const emptyReceipt = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async (request) => ({ verdict: "approve", dispatchReceipt: "  ", inputDigests: request.inputs.map((item) => item.digest) }) });
	assert.equal(emptyReceipt.outcome, "failed");
	if (emptyReceipt.outcome === "failed") assert.equal(emptyReceipt.failures[0]?.code, "agent-malformed");
	const preAborted = new AbortController();
	preAborted.abort();
	const beforeDispatch = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree, signal: preAborted.signal }, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
	assert.equal(beforeDispatch.outcome, "failed");
	if (beforeDispatch.outcome === "failed") assert.equal(beforeDispatch.failures[0]?.code, "verification-aborted");
	const during = new AbortController();
	const afterAwait = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree, signal: during.signal }, { judge: async () => { during.abort(); return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: ["ignored"] }; } });
	assert.equal(afterAwait.outcome, "failed");
	if (afterAwait.outcome === "failed") assert.equal(afterAwait.failures[0]?.code, "verification-aborted");
	await rm(root, { recursive: true, force: true });
});

test("agent cancellation is observed after input loading and before dispatch", async () => {
	const { root, tree } = await setup();
	let calls = 0;
	let loadingReads = 0;
	const duringLoading = { get aborted() { loadingReads += 1; return loadingReads >= 2; } } as unknown as AbortSignal;
	const loadingResult = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin", "diagram.bin"], rubric: "inspect" }, tree, signal: duringLoading }, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
	assert.equal(loadingResult.outcome, "failed");
	if (loadingResult.outcome === "failed") assert.equal(loadingResult.failures[0]?.code, "verification-aborted");
	let preDispatchReads = 0;
	const beforeDispatch = { get aborted() { preDispatchReads += 1; return preDispatchReads >= 3; } } as unknown as AbortSignal;
	const dispatchResult = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree, signal: beforeDispatch }, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
	assert.equal(dispatchResult.outcome, "failed");
	if (dispatchResult.outcome === "failed") assert.equal(dispatchResult.failures[0]?.code, "verification-aborted");
	assert.equal(calls, 0);
	await rm(root, { recursive: true, force: true });
});

test("agent rejects absolute inputs and dispatch failures before success", async () => {
	const { root, tree } = await setup();
	const absolute = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: [path.join(root, "diagram.bin")], rubric: "inspect" }, tree }, { judge: async () => ({ verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }) });
	assert.equal(absolute.outcome, "failed");
	if (absolute.outcome === "failed") assert.equal(absolute.failures[0]?.code, "input-path-escape");
	const thrown = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async () => { throw new Error("judge unavailable"); } });
	assert.equal(thrown.outcome, "failed");
	if (thrown.outcome === "failed") assert.equal(thrown.failures[0]?.code, "dispatch-failed");
	const infrastructure = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" }, tree }, { judge: async (request) => ({ verdict: "infrastructure-failure", reason: `failed ${request.inputs.length}` }) });
	assert.equal(infrastructure.outcome, "failed");
	if (infrastructure.outcome === "failed") assert.equal(infrastructure.failures[0]?.code, "dispatch-failed");
	await rm(root, { recursive: true, force: true });
});

test("agent rejects named directories before dispatch", async () => {
	const { root, tree } = await setup();
	await mkdir(path.join(root, "directory"));
	let calls = 0;
	const result = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["directory"], rubric: "inspect" }, tree }, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
	assert.equal(result.outcome, "failed");
	if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "input-not-file");
	assert.equal(calls, 0);
	await rm(root, { recursive: true, force: true });
});

test("agent reports unreadable named inputs before dispatch", async () => {
	const { root } = await setup();
	const input = path.join(root, "diagram.bin");
	await chmod(root, 0o755);
	await chmod(input, 0o000);
	const probe = `
const { runAgent } = await import(${JSON.stringify(sourceModuleUrl("verify/agent"))});
if (typeof process.getuid === "function" && process.getuid() === 0) process.setuid(65534);
let calls = 0;
const result = await runAgent({
  evidence: { kind: "agent", agent: "reviewer", inputs: ["diagram.bin"], rubric: "inspect" },
  tree: { kind: "git", worktreePath: process.argv[1], resolvedCommit: "${"a".repeat(40)}" },
}, { judge: async () => { calls += 1; return { verdict: "approve", dispatchReceipt: "receipt", inputDigests: [] }; } });
process.stdout.write(JSON.stringify({ code: result.outcome === "failed" ? result.failures[0]?.code : undefined, calls }));
`;
	try {
		const child = spawn(process.execPath, [...childLoaderArgs(), "-e", probe, root], { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(exitCode, 0, stderr);
		assert.deepEqual(JSON.parse(stdout), { code: "input-unreadable", calls: 0 });
	} finally {
		await chmod(input, 0o644);
		await rm(root, { recursive: true, force: true });
	}
});

test("agent rejects symlink escape", async () => {
	const { root, tree } = await setup();
	const outside = await mkdtemp(path.join(os.tmpdir(), "pi-work-agent-outside-"));
	await writeFile(path.join(outside, "secret"), "secret");
	await symlink(path.join(outside, "secret"), path.join(root, "escape"));
	const result = await runAgent({ evidence: { kind: "agent", agent: "reviewer", inputs: ["escape"], rubric: "inspect" }, tree }, { judge: async () => ({ verdict: "approve", dispatchReceipt: "x", inputDigests: [] }) });
	assert.equal(result.outcome, "failed");
	if (result.outcome === "failed") assert.equal(result.failures[0]?.code, "input-path-escape");
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});
