import assert from "node:assert/strict";
import test from "node:test";
import { dispatchStructuredFabricRun, fabricResultInputs, validateFabricWorkerResult } from "../../src/dispatch/fabric/result.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";

import { verifyChecklist } from "../../src/verify/checklist.ts";

const commit = "a".repeat(40);
const workerValue = { changedPaths: ["src/owned.ts"], commit, evidence: "npm test: exit 0", checklist: [{ index: 0, done: true }], gaps: "" };

test("structured-result: supplies a closed schema and maps validated output to verify and status inputs", async () => {
	const result = await dispatchStructuredFabricRun({ ref: "digest", projectRoot: "/project", trustedProject: false, invocation: { name: "node", task: "brief", worktree: true, confineWrites: true, writableRoots: ["src/owned.ts"] } }, {
		async readConfig() { return undefined; },
		events: { emit(_channel, payload) {
			const request = payload as FabricProgramRunRequest;
			assert.equal((request.input.schema as { additionalProperties: boolean }).additionalProperties, false);
			assert.deepEqual((request.input.schema as { required: string[] }).required, ["changedPaths", "commit", "evidence", "checklist", "gaps"]);
			request.reply({ ok: true, program: "digest", value: { id: "run-1", status: "completed", value: workerValue, worktreeResult: { path: "/project/.worktrees/node", branch: "fabric/node", baseRef: "b".repeat(40) } }, logs: [] });
		} },
	});
	assert.equal(result.status, "completed");
	assert.ok(result.status === "completed");
	assert.deepEqual(result.workerResult, workerValue);
	const inputs = fabricResultInputs(result.workerResult, "/project/.worktrees/node", ["node"]);
	assert.deepEqual(inputs.verify, { worktreePath: "/project/.worktrees/node", expectedCommit: commit, checklistReports: [{ index: 0, done: true }] });
	assert.deepEqual(inputs.status, { worktreePath: "/project/.worktrees/node", expectedCommit: commit, refresh: { checklists: [{ nodeAddress: ["node"], reports: [{ index: 0, done: true }] }] } });
});

test("structured-result: direct workflow value is validated and copied without retaining mutable caller objects", () => {
	const supplied = { ...workerValue, changedPaths: ["src/owned.ts"], checklist: [{ index: 0, done: false }] };
	const parsed = validateFabricWorkerResult(supplied);
	assert.ok(parsed.ok);
	supplied.changedPaths.push("outside.ts");
	supplied.checklist[0].done = true;
	assert.deepEqual(parsed.value.changedPaths, ["src/owned.ts"]);
	assert.deepEqual(parsed.value.checklist, [{ index: 0, done: false }]);
	const tree = { kind: "git" as const, worktreePath: "/tree", resolvedCommit: commit };
	const inputs = fabricResultInputs(parsed.value, "/tree", ["node"]);
	assert.equal(verifyChecklist(["review done"], inputs.verify.checklistReports, tree).outcome, "incomplete");
});

for (const [name, value] of [
	["null", null], ["text is not parsed", JSON.stringify(workerValue)], ["missing fields", {}],
	["unknown authority", { ...workerValue, verified: true }], ["short commit", { ...workerValue, commit: "abc" }],
	["blank evidence", { ...workerValue, evidence: " " }], ["missing gaps", { changedPaths: [], commit, evidence: "ok", checklist: [] }],
	["duplicate paths", { ...workerValue, changedPaths: ["src/a.ts", "src/a.ts"] }],
	["traversal", { ...workerValue, changedPaths: ["../outside.ts"] }], ["absolute path", { ...workerValue, changedPaths: ["/outside.ts"] }],
	["normalized traversal", { ...workerValue, changedPaths: ["src/../outside.ts"] }],
	["windows path", { ...workerValue, changedPaths: ["C:\\outside.ts"] }],
	["duplicate checklist", { ...workerValue, checklist: [{ index: 0, done: true }, { index: 0, done: false }] }],
	["negative index", { ...workerValue, checklist: [{ index: -1, done: true }] }],
	["nonboolean done", { ...workerValue, checklist: [{ index: 0, done: "true" }] }],
	["unknown checklist field", { ...workerValue, checklist: [{ index: 0, done: true, approved: true }] }],
] as const) {
	test(`structured-result: ${name} yields a typed finding, never a trusted result`, () => {
		const result = validateFabricWorkerResult(value);
		assert.equal(result.ok, false);
		assert.ok(!result.ok);
		assert.equal(result.finding.code, "fabric-result-invalid");
	});
}

test("structured-result: malformed returned value retains run receipt and reports a finding", async () => {
	const result = await dispatchStructuredFabricRun({ ref: "digest", projectRoot: "/project", trustedProject: false, invocation: { name: "node", task: "brief", worktree: false, confineWrites: true } }, {
		async readConfig() { return undefined; },
		events: { emit(_channel, payload) {
			(payload as FabricProgramRunRequest).reply({ ok: true, program: "digest", value: { id: "run", status: "completed", value: { ...workerValue, verified: true } }, logs: [] });
		} },
	});
	assert.equal(result.status, "invalid");
	assert.ok(result.status === "invalid");
	assert.equal(result.receipt.runId, "run");
	assert.equal(result.finding.code, "fabric-result-invalid");
});

test("structured-result: unsuccessful agent cannot smuggle an apparently valid result", async () => {
	const result = await dispatchStructuredFabricRun({ ref: "digest", projectRoot: "/project", trustedProject: false, invocation: { name: "node", task: "brief", worktree: false, confineWrites: true } }, {
		async readConfig() { return undefined; },
		events: { emit(_channel, payload) {
			(payload as FabricProgramRunRequest).reply({ ok: true, program: "digest", value: { id: "run", status: "failed", value: workerValue }, logs: [] });
		} },
	});
	assert.equal(result.status, "invalid");
});

test("structured-result: transport failure is preserved without worker result", async () => {
	const result = await dispatchStructuredFabricRun({ ref: "digest", projectRoot: "/project", trustedProject: false, invocation: { name: "node", task: "brief", worktree: false, confineWrites: true } }, { events: undefined, async readConfig() { return undefined; } });
	assert.deepEqual(result, { status: "failed", runResult: { ok: false, finding: { code: "fabric-unavailable", message: "Fabric event bus is unavailable" } } });
});

