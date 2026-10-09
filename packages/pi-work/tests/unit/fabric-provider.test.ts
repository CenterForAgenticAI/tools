import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import piWork from "../../src/index.ts";
import { createFabricWorkProvider, type WorkInvocationContext } from "../../src/fabric-provider.ts";
import { withDraftLineage } from "../helpers/workspec-source.ts";

function context(cwd = process.cwd(), signal?: AbortSignal): WorkInvocationContext {
	return { nestedToolCallId: "fabric/test", signal, extensionContext: { cwd, hasUI: false } as WorkInvocationContext["extensionContext"] };
}

async function fixture() {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-work-provider-"));
	await writeFile(path.join(cwd, ".gitignore"), ".work/\n");
	await writeFile(path.join(cwd, "spec.yaml"), withDraftLineage("title: Provider\ndescription: d\nintent: i\nwork:\n  - id: node\n    task: confirm\n    acceptance:\n      - id: U\n        statement: confirmation\n        evidence:\n          kind: user\n          prompt: confirm this result\n", { cwd }));
	const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000 });
	git(["init", "-q"]);
	git(["add", "-f", "spec.yaml", ".gitignore", ".test-dist"]);
	git(["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"]);
	return { cwd, commit: git(["rev-parse", "HEAD"]).trim() };
}

test("fabric-provider: plan creates a real brief and dispatch propagates host cancellation", async () => {
	const repo = await fixture();
	try {
		const provider = createFabricWorkProvider();
		const planned = await provider.invoke("plan", { path: "spec.yaml", nodeAddresses: [["node"]] }, context(repo.cwd)) as { details: { valid: boolean; plans: { briefPath: string }[] } };
		assert.equal(planned.details.valid, true);
		assert.equal(planned.details.plans.length, 1);
		assert.match(await readFile(planned.details.plans[0]!.briefPath, "utf8"), /confirm this result/);
		const controller = new AbortController();
		controller.abort();
		const dispatched = await provider.invoke("dispatch", { path: "spec.yaml", nodeAddress: ["node"], worktreePath: repo.cwd, expectedCommit: repo.commit }, context(repo.cwd, controller.signal)) as { details: { outcome: string; findings: { code: string }[] } };
		assert.equal(dispatched.details.outcome, "rejected");
		assert.equal(dispatched.details.findings[0]?.code, "dispatch-aborted");
	} finally { await rm(repo.cwd, { recursive: true, force: true }); }
});

test("fabric-provider: status derives real nodes and verify retains host user-confirmation capabilities", async () => {
	const repo = await fixture();
	try {
		const provider = createFabricWorkProvider();
		const target = { path: "spec.yaml", worktreePath: repo.cwd, expectedCommit: repo.commit };
		const status = await provider.invoke("status", target, context(repo.cwd)) as { details: { nodes: { address: string[] }[] } };
		assert.deepEqual(status.details.nodes.map((node) => node.address), [["node"]]);
		const confirmations: string[] = [];
		const ctx = { ...context(repo.cwd), extensionContext: { cwd: repo.cwd, hasUI: true, ui: { confirm: async (_title: string, message: string) => { confirmations.push(message); return true; } }, sessionManager: { getSessionId: () => "provider-test", getSessionFile: () => undefined, getBranch: () => [] } } as unknown as WorkInvocationContext["extensionContext"] };
		const verified = await provider.invoke("verify", { ...target, nodeId: "node", checklistReports: [] }, ctx) as { details: { outcome: string } };
		assert.equal(verified.details.outcome, "passed");
		assert.equal(confirmations.length, 1);
		assert.match(confirmations[0]!, /I confirm [a-f0-9]{32}/);
		const closed = await provider.invoke("verify", { ...target, nodeId: "node" }, context(repo.cwd)) as { details: { outcome: string; failures: { code: string }[] } };
		assert.equal(closed.details.outcome, "failed");
		assert.equal(closed.details.failures[0]?.code, "session-unavailable");
	} finally { await rm(repo.cwd, { recursive: true, force: true }); }
});

test("fabric-provider: invalid and disallowed caller fields cannot reach any work handler", async () => {
	const provider = createFabricWorkProvider();
	for (const name of ["plan", "dispatch", "status", "verify"]) {
		await assert.rejects(provider.invoke(name, {}, context()), /Invalid arguments/);
	}
	const valid = {
		plan: { path: "../escape.yaml", nodeAddresses: [["node"]] },
		dispatch: { path: "../escape.yaml", nodeAddress: ["node"], worktreePath: "/absent", expectedCommit: "abc" },
		status: { path: "spec.yaml", worktreePath: "/absent", expectedCommit: "abc" },
		verify: { path: "../escape.yaml", nodeId: "node", worktreePath: "/absent", expectedCommit: "abc" },
	};
	for (const [name, args] of Object.entries(valid)) await assert.rejects(provider.invoke(name, { ...args, injected: "must-not-survive" }, context()), /Invalid arguments/);
	await assert.rejects(provider.invoke("delete", {}, context()), /Unknown work action/);
	assert.equal(await provider.describe("delete"), undefined);
	assert.deepEqual(await provider.list({ namespace: "other" }), []);
	assert.deepEqual((await provider.list({ query: "dispatch", limit: 1 })).map((entry) => entry.name), ["dispatch"]);
});

test("fabric-provider: absent or withdrawn Fabric leaves ordinary work tools callable and unchanged", async () => {
	const loaded = host();
	const before = loaded.tools.slice();
	// Fabric's listener/registry is the external boundary. Withdrawing that
	// host does not unregister or replace Pi's independently registered tools.
	loaded.listeners.clear();
	const plan = loaded.tools.find((tool) => tool.name === "work_plan");
	assert.ok(plan);
	const result = await plan.execute("standalone", { path: "../escape.yaml", nodeAddresses: [["node"]] }, undefined, undefined, { cwd: process.cwd() } as never);
	assert.equal((result.details as { valid: boolean }).valid, false);
	assert.deepEqual(loaded.tools, before);
	const absent: string[] = [];
	piWork({ registerTool: (tool: ToolDefinition) => absent.push(tool.name), registerCommand() {} } as unknown as ExtensionAPI);
	assert.deepEqual(absent, before.map((tool) => tool.name));
});

function host() {
	const tools: ToolDefinition[] = [];
	const events: { name: string; data: unknown }[] = [];
	const listeners = new Map<string, (data: unknown) => void>();
	const pi = {
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		registerCommand() {},
		events: {
			emit(name: string, data: unknown) { events.push({ name, data }); },
			on(name: string, listener: (data: unknown) => void) { listeners.set(name, listener); return () => listeners.delete(name); },
		},
	} as unknown as ExtensionAPI;
	piWork(pi);
	return { tools, events, listeners, pi };
}

test("fabric-provider: extension publishes a work provider and answers discovery without changing work tools", async () => {
	const loaded = host();
	const registration = loaded.events.find((event) => event.name === "pi-fabric:provider:register:v1");
	assert.ok(registration, "provider must be published on the host event bus");
	const { provider, version } = registration.data as { version: number; provider: { name: string; list(request: object): Promise<{ name: string; risk: string; inputSchema: unknown }[]> } };
	assert.equal(version, 1);
	assert.equal(provider.name, "work");
	const actions = await provider.list({});
	assert.deepEqual(actions.map((action) => [action.name, action.risk]), [["plan", "write"], ["dispatch", "agent"], ["status", "write"], ["verify", "execute"]]);
	for (const action of actions) assert.deepEqual(action.inputSchema, loaded.tools.find((tool) => tool.name === `work_${action.name}`)?.parameters);
	const discovered: unknown[] = [];
	loaded.listeners.get("pi-fabric:provider:discover:v1")?.({ version: 1, register: (value: unknown) => discovered.push(value) });
	assert.equal(discovered.length, 1);
	assert.equal(discovered[0], provider);
	loaded.listeners.get("pi-fabric:provider:discover:v1")?.({ version: 2, register: (value: unknown) => discovered.push(value) });
	loaded.listeners.get("pi-fabric:provider:discover:v1")?.(null);
	assert.equal(discovered.length, 1, "unsupported discovery payloads must not register");
	assert.deepEqual(loaded.tools.map((tool) => tool.name), ["work_validate", "work_promote", "work_amend_criterion", "work_status", "work_plan", "work_dispatch", "work_verify"]);
});
