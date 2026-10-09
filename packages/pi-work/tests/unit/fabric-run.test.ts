import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { homedir } from "node:os";
import { buildFabricRunRequest } from "../../src/dispatch/fabric/run.ts";
import { dispatchFabricRun, type FabricRunOptions } from "../../src/dispatch/fabric/run.ts";
import { FABRIC_PROGRAM_RUN_EVENT, type FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";

const options: FabricRunOptions = {
	ref: "program-digest", projectRoot: "/project", trustedProject: true, globalConfigPath: "/global/fabric.json",
	invocation: { name: "one-node", task: "Read the compiled brief", worktree: false, confineWrites: true, writableRoots: ["src/owned.ts"] },
};

test("single-dispatch: one compiled node starts one run and returns one receipt even on duplicate replies", async () => {
	let runs = 0;
	const result = await dispatchFabricRun(options, {
		async readConfig() { return undefined; },
		events: { emit(channel, data) {
			assert.equal(channel, FABRIC_PROGRAM_RUN_EVENT);
			const request = data as FabricProgramRunRequest;
			runs += 1;
			assert.equal(request.input.task, "Read the compiled brief");
			assert.equal(request.input.name, "one-node");
			request.reply({ ok: true, program: "program-digest", value: { id: "run-1", injected: "discard" }, logs: [] });
			request.reply({ ok: true, program: "program-digest", value: { id: "run-2" }, logs: [] });
		} },
	});
	assert.equal(runs, 1);
	assert.ok("status" in result && result.status === "dispatched");
	assert.deepEqual(result.receipt, { runId: "run-1" });
});

// Faithful Fabric tool-policy double: roots are resolved from worker cwd and
// permit only exact paths or descendants. This is tool confinement, not a shell sandbox.
function toolWrite(input: FabricProgramRunRequest["input"], target: string): string {
	if (input.writableRoots === undefined) return "written";
	const cwd = input.cwd ?? "/project";
	const allowed = input.writableRoots.some((root) => {
		const relative = path.relative(path.resolve(cwd, root), path.resolve(cwd, target));
		return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	});
	return allowed ? "written" : "Fabric write policy refuses write outside writable roots";
}

test("write-confinement: emitted roots refuse outside, sibling-prefix and traversal writes", async () => {
	const writes: string[] = [];
	await dispatchFabricRun(options, {
		async readConfig() { return undefined; },
		events: { emit(_channel, payload) {
			const request = payload as FabricProgramRunRequest;
			writes.push(toolWrite(request.input, "src/owned.ts"), toolWrite(request.input, "src/other.ts"), toolWrite(request.input, "src/owned.ts-evil"), toolWrite(request.input, "src/../outside.ts"));
			request.reply({ ok: true, program: "digest", value: { id: "run" }, logs: [] });
		} },
	});
	assert.deepEqual(writes, ["written", "Fabric write policy refuses write outside writable roots", "Fabric write policy refuses write outside writable roots", "Fabric write policy refuses write outside writable roots"]);
});

test("shell-policy-applied: empty or absent touches and disabled confinement never grant unconfined shell", () => {
	assert.equal(buildFabricRunRequest(options).shell, "unconfined");
	assert.equal(buildFabricRunRequest({ ...options, invocation: { ...options.invocation, writableRoots: [] } }).shell, undefined);
	assert.equal(buildFabricRunRequest({ ...options, invocation: { name: "read", task: "read", worktree: false, confineWrites: true } }).shell, undefined);
	assert.deepEqual(buildFabricRunRequest({ ...options, invocation: { ...options.invocation, confineWrites: false } }).writableRoots, undefined);
	assert.equal(buildFabricRunRequest({ ...options, invocation: { ...options.invocation, confineWrites: false } }).shell, undefined);
	assert.deepEqual(buildFabricRunRequest({ ...options, invocation: { name: "read", task: "read", worktree: false, confineWrites: true } }).writableRoots, []);
});

test("single-dispatch: mapping copies named fields without caller transport or escalation overrides", () => {
	const invocation = { ...options.invocation, shell: "unconfined", childQuestions: "route", injected: "discard", confineWrites: false, cwd: "/worker", model: "provider/model" };
	const request = buildFabricRunRequest({ ...options, invocation, thinking: "high", schema: { type: "object" }, systemPrompt: "worker" });
	assert.deepEqual(JSON.parse(JSON.stringify(request)), { task: "Read the compiled brief", name: "one-node", cwd: "/worker", worktree: false, model: "provider/model", thinking: "high", schema: { type: "object" }, systemPrompt: "worker" });
});

test("worktree-isolation: requests a separate worktree and records only path, branch and base commit", async () => {
	const result = await dispatchFabricRun({ ...options, invocation: { ...options.invocation, worktree: true } }, {
		async readConfig() { return undefined; },
		events: { emit(_channel, payload) {
			const request = payload as FabricProgramRunRequest;
			assert.equal(request.input.worktree, true);
			assert.equal(request.input.cwd, "/project");
			request.reply({ ok: true, program: "digest", value: { id: "run", worktreeResult: { path: "/project/.worktrees/node", branch: "fabric/node", baseRef: "abc123", changedFiles: ["src/owned.ts"], injected: "discard" } }, logs: [] });
		} },
	});
	assert.ok("status" in result && result.status === "dispatched");
	assert.deepEqual(result.receipt, { runId: "run", worktreeResult: { path: "/project/.worktrees/node", branch: "fabric/node", baseRef: "abc123" } });
});

for (const value of [null, {}, { id: "" }, { id: "run" }, { id: "run", worktreeResult: { path: "/tree", branch: "branch" } }]) {
	test(`worktree-isolation: incomplete receipt ${JSON.stringify(value)} is indeterminate, never safe to retry`, async () => {
		const result = await dispatchFabricRun({ ...options, invocation: { ...options.invocation, worktree: true } }, {
			async readConfig() { return undefined; },
			events: { emit(_channel, payload) { (payload as FabricProgramRunRequest).reply({ ok: true, program: "digest", value, logs: [] }); } },
		});
		assert.ok("status" in result && result.status === "indeterminate");
		assert.equal(result.dispatchState, "unknown");
		assert.equal(result.finding.code, "fabric-receipt-invalid");
	});
}

for (const scenario of [
	{ name: "global route", global: { agents: { childQuestions: "route" } }, project: undefined, trusted: true, expected: "rejected" },
	{ name: "trusted cancel cannot override global route", global: { agents: { childQuestions: "route" } }, project: { agents: { childQuestions: "cancel" } }, trusted: true, expected: "rejected" },
	{ name: "trusted route overrides global cancel", global: { agents: { childQuestions: "cancel" } }, project: { agents: { childQuestions: "route" } }, trusted: true, expected: "rejected" },
	{ name: "untrusted cancel cannot override global route", global: { agents: { childQuestions: "route" } }, project: { agents: { childQuestions: "cancel" } }, trusted: false, expected: "rejected" },
	{ name: "untrusted route blocks dispatch", global: undefined, project: { agents: { childQuestions: "route" } }, trusted: false, expected: "rejected" },
	{ name: "absent defaults cancel", global: undefined, project: undefined, trusted: true, expected: "dispatched" },
	{ name: "absent project setting preserves global route", global: { agents: { childQuestions: "route" } }, project: { agents: {} }, trusted: true, expected: "rejected" },
] as const) {
	test(`escalation-off: ${scenario.name}`, async () => {
		let runs = 0;
		const paths: string[] = [];
		const result = await dispatchFabricRun({ ...options, trustedProject: scenario.trusted }, {
			async readConfig(file) { paths.push(file); return file === "/global/fabric.json" ? scenario.global : scenario.project; },
			events: { emit(_channel, payload) {
				runs++;
				const request = payload as FabricProgramRunRequest;
				assert.equal("childQuestions" in request.input, false);
				request.reply({ ok: true, program: "digest", value: { id: "run", value: { blocker: "scope change needed" } }, logs: [] });
			} },
		});
		assert.ok("status" in result);
		assert.equal(result.status, scenario.expected);
		assert.equal(runs, scenario.expected === "rejected" ? 0 : 1);
		assert.deepEqual(paths, ["/global/fabric.json", "/project/.pi/fabric.json"]);
	});
}

for (const invalid of [null, [], { agents: null }, { agents: { childQuestions: "unexpected" } }]) {
	test(`escalation-off: malformed config ${JSON.stringify(invalid)} blocks before emission`, async () => {
		let runs = 0;
		const result = await dispatchFabricRun(options, { async readConfig() { return invalid; }, events: { emit() { runs++; } } });
		assert.ok("status" in result && result.status === "rejected");
		assert.equal(result.finding.code, "fabric-config-invalid");
		assert.equal(runs, 0);
	});
}

test("escalation-off: unreadable config blocks and default global path uses home", async () => {
	const paths: string[] = [];
	const { globalConfigPath: _ignored, ...defaults } = options;
	const result = await dispatchFabricRun(defaults, { async readConfig(file) { paths.push(file); throw new Error("unreadable"); }, events: undefined });
	assert.ok("status" in result && result.status === "rejected");
	assert.equal(result.finding.code, "fabric-config-invalid");
	assert.deepEqual(paths, [path.join(homedir(), ".pi", "agent", "fabric.json")]);
});

test("single-dispatch: transport failures return unchanged without a fabricated receipt", async () => {
	const result = await dispatchFabricRun(options, { async readConfig() { return undefined; }, events: undefined });
	assert.deepEqual(result, { ok: false, finding: { code: "fabric-unavailable", message: "Fabric event bus is unavailable" } });
});
