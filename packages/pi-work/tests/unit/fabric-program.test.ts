import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ensureFabricDispatchProgram, FABRIC_DISPATCH_PROGRAM_SOURCE } from "../../src/dispatch/fabric/program.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";

async function project(t: TestContext): Promise<string> {
	const scratch = path.join(REPO_ROOT, ".scratch", "tmp");
	await mkdir(scratch, { recursive: true });
	const cwd = await mkdtemp(path.join(scratch, "fabric-program-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("program-bootstrap: creates a candidate record with Fabric's own source digest", async (t) => {
	const cwd = await project(t);
	const saved = await ensureFabricDispatchProgram(cwd);
	// Oracle: pi-fabric 0.108.1 ProgramStore.save, probed against the installed
	// dist on 2026-10-06 with this exact source and kernel (no inputSchema).
	const fabricDigest = "abd7d309be0f5a9de81b416bcc87312794f8c1651b6c99e1a0f8c6b1a64a15ec";
	assert.equal(saved.digest, fabricDigest);
	assert.equal(saved.ref, fabricDigest);
	assert.equal(saved.created, true);
	assert.equal(saved.path, path.join(cwd, ".pi", "fabric", "programs", `${fabricDigest}.json`));
	const record = JSON.parse(await readFile(saved.path, "utf8"));
	assert.deepEqual(record, {
		version: 1, digest: fabricDigest, name: "pi-work-dispatch", kind: "fabric",
		kernel: "typescript", code: FABRIC_DISPATCH_PROGRAM_SOURCE,
		createdAt: record.createdAt, status: "candidate",
	});
	assert.equal(typeof record.createdAt, "number");
});

test("program-bootstrap: never rewrites a present record or its promotion metadata", async (t) => {
	const cwd = await project(t);
	const saved = await ensureFabricDispatchProgram(cwd);
	const record = JSON.parse(await readFile(saved.path, "utf8"));
	const promoted = JSON.stringify({ ...record, status: "promoted", createdAt: 123 });
	await writeFile(saved.path, promoted);
	const before = await stat(saved.path);
	const again = await ensureFabricDispatchProgram(cwd);
	assert.equal(again.created, false);
	assert.equal(await readFile(saved.path, "utf8"), promoted);
	assert.equal((await stat(saved.path)).mtimeMs, before.mtimeMs);
	// A damaged record is still not ours to replace silently.
	await writeFile(saved.path, "operator-owned bytes");
	assert.equal((await ensureFabricDispatchProgram(cwd)).created, false);
	assert.equal(await readFile(saved.path, "utf8"), "operator-owned bytes");
});

test("program-bootstrap: concurrent callers publish only one complete record", async (t) => {
	const cwd = await project(t);
	const results = await Promise.all(Array.from({ length: 12 }, () => ensureFabricDispatchProgram(cwd)));
	assert.equal(results.filter((result) => result.created).length, 1);
	const record = JSON.parse(await readFile(results[0].path, "utf8"));
	assert.equal(record.code, FABRIC_DISPATCH_PROGRAM_SOURCE);
	assert.equal(record.status, "candidate");
});

test("program-bootstrap: saved source runs one agent and drops unapproved caller fields", async () => {
	const input = {
		task: "Implement the node", name: "worker", model: "test/model", thinking: "high",
		cwd: "/project", worktree: true, writableRoots: ["src"], shell: "unconfined",
		schema: { type: "object" }, systemPrompt: "Stay in scope",
		runner: "untrusted", inheritedScope: { grants: ["*"] }, surprise: "must not survive",
	};
	const calls: unknown[] = [];
	const run = async (request: unknown) => {
		calls.push(request);
		return { id: "run-1", worktreeResult: { branch: "worker" } };
	};
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const execute = new AsyncFunction("agents", "input", FABRIC_DISPATCH_PROGRAM_SOURCE);
	assert.deepEqual(await execute({ run }, input), { id: "run-1", worktreeResult: { branch: "worker" } });
	assert.deepEqual(calls, [{
		task: "Implement the node", name: "worker", model: "test/model", thinking: "high",
		cwd: "/project", worktree: true, writableRoots: ["src"], shell: "unconfined",
		schema: { type: "object" }, systemPrompt: "Stay in scope",
	}]);
});

test("program-bootstrap: source preserves agent failures", async () => {
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	const execute = new AsyncFunction("agents", "input", FABRIC_DISPATCH_PROGRAM_SOURCE);
	await assert.rejects(execute({ run: async () => { throw new Error("agent unavailable"); } }, { task: "node" }), /agent unavailable/);
});

test("program-bootstrap: filesystem failures propagate without changing the obstruction", async (t) => {
	const cwd = await project(t);
	await writeFile(path.join(cwd, ".pi"), "not a directory");
	await assert.rejects(ensureFabricDispatchProgram(cwd), /ENOTDIR/);
	assert.equal(await readFile(path.join(cwd, ".pi"), "utf8"), "not a directory");
});
