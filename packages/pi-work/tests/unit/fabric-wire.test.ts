import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piWork from "../../src/index.ts";
import { createFabricDispatchBackend } from "../../src/dispatch/fabric/index.ts";
import { createFabricWorkProvider } from "../../src/fabric-provider.ts";
import { createWorkDispatchTool, type WorkDispatchDetails } from "../../src/tools/work-dispatch.ts";
import { workStatusTool, type WorkStatusToolDetails } from "../../src/tools/work-status.ts";
import type { FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

async function fixture() {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-work-wire-")));
	await writeFile(path.join(root, "spec.yaml"), withDraftLineage("title: wire\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: compose\n    worker:\n      model: missing/model\n    checklist: [compose only]\n    touches: [src/**]\n    acceptance:\n      - id: A\n        statement: confirm\n        evidence:\n          kind: user\n          prompt: confirm\n", { cwd: root }));
	await writeFile(path.join(root, ".gitignore"), ".work/\n.pi/\n");
	const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10000 });
	git(["init", "-q", "-b", "fixture"]);
	git(["add", "-f", "spec.yaml", ".gitignore", ".test-dist"]);
	git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	return { root, commit: git(["rev-parse", "HEAD"]).trim() };
}

function context(root: string) {
	return { cwd: root, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] } } as never;
}

for (const entry of ["tool", "provider"] as const) {
	test(`fabric-dispatch-wired: ${entry} registration composes the run and status receipt`, async () => {
		const repo = await fixture();
		const previousRoot = process.env.PI_FABRIC_PROJECT_ROOT;
		process.env.PI_FABRIC_PROJECT_ROOT = repo.root;
		try {
			const tools: ToolDefinition[] = [];
			const requests: FabricProgramRunRequest[] = [];
			let provider: ReturnType<typeof createFabricWorkProvider> | undefined;
			const handlers = new Map<string, (event: never) => unknown>();
			const events = {
				emit(channel: string, data: unknown) {
					if (channel === "pi-fabric:provider:register:v1") provider = (data as { provider: ReturnType<typeof createFabricWorkProvider> }).provider;
					if (channel !== "pi-fabric:program:run:v1") return;
					const request = data as FabricProgramRunRequest;
					requests.push(request);
					request.reply({ ok: true, program: request.ref, logs: [], value: {
						id: "wire-run", status: "completed", model: "test/model",
						value: { changedPaths: ["src/example.ts"], commit: repo.commit, evidence: "probe exit 0", checklist: [], gaps: "" },
					} });
				},
				on() { return () => {}; },
			};
			piWork({ events, getAllTools: () => [{ name: "fabric_exec" }], registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: (event: never) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
			const params = { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit, backend: "fabric" as const, fallbackModels: ["test/model"] };
			const ctx = context(repo.root);
			const response = entry === "tool"
				? await tools.find((tool) => tool.name === "work_dispatch")!.execute("wire", params, undefined, undefined, ctx)
				: await provider!.invoke("dispatch", params, { extensionContext: ctx, signal: undefined, nestedToolCallId: "wire" });
			assert.equal(response.details.outcome, "dispatched", JSON.stringify(response.details));
			assert.equal(requests.length, 1);
			assert.equal(requests[0]!.input.model, "test/model");
			assert.equal(requests[0]!.input.shell, "unconfined");
			assert.equal(requests[0]!.input.worktree, false);
			assert.ok(requests[0]!.input.schema);
			assert.match(requests[0]!.input.task, /brief/);
			assert.deepEqual(requests[0]!.input.writableRoots, [path.join(repo.root, "src")]);
			const program = JSON.parse(await readFile(path.join(repo.root, ".pi", "fabric", "programs", `${requests[0]!.ref}.json`), "utf8"));
			assert.equal(program.digest, requests[0]!.ref);
			const status = await workStatusTool.execute("status", { path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, ctx);
			const statusDetails = status.details as WorkStatusToolDetails;
			assert.equal(statusDetails.nodes[0]!.dispatches[0]!.runId, "wire-run");
			assert.equal(statusDetails.nodes[0]!.dispatches[0]!.slot.requestedModel, "missing/model");
			assert.equal(statusDetails.nodes[0]!.dispatches[0]!.slot.resolvedModel, "test/model");
			assert.notEqual(statusDetails.nodes[0]!.lifecycle, "done");
			const completion = { messages: [{ role: "custom", customType: "pi-fabric-agent-complete", content: "finished", details: { ids: ["wire-run"] }, display: true, timestamp: 0 }] };
			const annotated = handlers.get("context")?.(completion as never) as { messages: { content: string }[] };
			assert.match(annotated.messages[0]!.content, /Inspect its result before claiming/);
		} finally {
			if (previousRoot === undefined) delete process.env.PI_FABRIC_PROJECT_ROOT;
			else process.env.PI_FABRIC_PROJECT_ROOT = previousRoot;
			await rm(repo.root, { recursive: true, force: true });
		}
	});
}

test("fabric-dispatch-wired: no host keeps explicit Fabric plan-only and default delegate fallback", async () => {
	const repo = await fixture();
	try {
		let calls = 0;
		const tool = createWorkDispatchTool({ clientProvider: async () => { calls++; return { status: "unavailable", message: "absent" }; } });
		const params = { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit };
		const explicit = await tool.execute("test", { ...params, backend: "fabric" }, undefined, undefined, context(repo.root));
		assert.equal((explicit.details as WorkDispatchDetails).outcome, "degraded");
		assert.equal(calls, 0);
		const implicit = await tool.execute("test", params, undefined, undefined, context(repo.root));
		assert.equal(implicit.details.outcome, "degraded");
		assert.equal(calls, 1);
	} finally { await rm(repo.root, { recursive: true, force: true }); }
});
test("fabric-dispatch-wired: unavailable model rejects before submission", async () => {
	const repo = await fixture();
	try {
		let calls = 0;
		const backend = createFabricDispatchBackend({ projectRoot: repo.root, events: { emit() { calls++; } } });
		const result = await createWorkDispatchTool({ fabricHost: backend }).execute("test", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, context(repo.root));
		assert.equal((result.details as WorkDispatchDetails).outcome, "rejected");
		assert.equal((result.details as WorkDispatchDetails).dispatchState, "not-dispatched");
		assert.equal(calls, 0);
		assert.match(JSON.stringify((result.details as WorkDispatchDetails).findings), /model-unavailable/);
	} finally { await rm(repo.root, { recursive: true, force: true }); }
});

test("fabric-dispatch-wired: invalid structured output is not recorded or retried", async () => {
	const repo = await fixture();
	try {
		let calls = 0;
		const backend = createFabricDispatchBackend({ projectRoot: repo.root, events: { emit(_channel, data) {
			calls++;
			const request = data as FabricProgramRunRequest;
			request.reply({ ok: true, program: request.ref, logs: [], value: { id: "invalid-run", status: "completed", model: "test/model", value: { changedPaths: [], commit: repo.commit, evidence: "probe", checklist: [], gaps: "", injected: "must not survive" } } });
		} } });
		const result = await createWorkDispatchTool({ fabricHost: backend }).execute("test", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit, model: "test/model" }, undefined, undefined, context(repo.root));
		assert.equal((result.details as WorkDispatchDetails).outcome, "indeterminate");
		assert.equal(calls, 1);
		assert.match(JSON.stringify((result.details as WorkDispatchDetails).findings), /fabric-result-invalid/);
		assert.doesNotMatch(JSON.stringify(result.details), /must not survive/);
		const status = await workStatusTool.execute("status", { path: "spec.yaml", worktreePath: repo.root, expectedCommit: repo.commit }, undefined, undefined, context(repo.root));
		assert.deepEqual((status.details as WorkStatusToolDetails).nodes[0]!.dispatches, []);
	} finally { await rm(repo.root, { recursive: true, force: true }); }
});

test("fabric-dispatch-wired: cancellation reaches the program event without redispatch", async () => {
	const repo = await fixture();
	try {
		let calls = 0;
		const controller = new AbortController();
		const backend = createFabricDispatchBackend({ projectRoot: repo.root, events: { emit(_channel, data) {
			calls++;
			assert.equal((data as FabricProgramRunRequest).signal, controller.signal);
			controller.abort();
		} } });
		const result = await createWorkDispatchTool({ fabricHost: backend }).execute("test", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.root, expectedCommit: repo.commit, model: "test/model" }, controller.signal, undefined, context(repo.root));
		assert.equal((result.details as WorkDispatchDetails).outcome, "indeterminate");
		assert.equal(calls, 1);
		assert.match(JSON.stringify((result.details as WorkDispatchDetails).findings), /fabric-aborted/);
	} finally { await rm(repo.root, { recursive: true, force: true }); }
});
