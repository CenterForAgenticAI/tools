import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { prepareSessionFocusArguments, prepareSessionTasksArguments } from "../src/tool-arguments.js";

// Every request carries each active tool's declaration. These tests keep the
// session_focus and session_tasks declarations small.
//
// Token estimate: ceil(characters / 4) over JSON.stringify({ name, description,
// parameters }), the declaration a provider receives for the tool. Pi's own
// compaction estimator uses the same characters / 4 rule. Before the schemas
// were trimmed the estimates were 841 tokens (session_focus, 3,363 characters)
// and 1,090 tokens (session_tasks, 4,358 characters); after, 308 and 538. The
// goal and brief actions (issue #212, #213) and the task goal
// link added about 70 and 60 tokens, with no new descriptions. The update
// ask and answer fields (issue #214) bring session_tasks to
// 684, again with no new descriptions. The ceilings leave about ten per cent
// for small additions.
const TOKEN_CEILINGS = {
	session_focus: 420,
	session_tasks: 750,
} as const;

interface RegisteredTool {
	name: string;
	description: string;
	parameters: { properties: Record<string, { enum?: readonly string[] }> };
	prepareArguments?: (args: unknown) => unknown;
}

async function registeredTools(): Promise<Map<string, RegisteredTool>> {
	const tools = new Map<string, RegisteredTool>();
	const noop = () => undefined;
	const api = new Proxy({}, {
		get(_target, key) {
			if (key === "registerTool") return (tool: RegisteredTool) => { tools.set(tool.name, tool); };
			if (key === "events") return { emit: noop, on: () => noop };
			return noop;
		},
	}) as unknown as ExtensionAPI;
	const extension = await import(`../src/index.js?tool-schema=${Date.now()}`);
	extension.default(api);
	return tools;
}

function estimatedTokens(tool: RegisteredTool): number {
	const declaration = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
	return Math.ceil(declaration.length / 4);
}

function piValidate(tool: RegisteredTool, args: unknown): unknown {
	const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
	return validateToolArguments(
		{ name: tool.name, description: "", parameters: tool.parameters } as never,
		{ type: "toolCall", id: "call-1", name: tool.name, arguments: prepared } as never,
	);
}

async function tool(name: keyof typeof TOKEN_CEILINGS): Promise<RegisteredTool> {
	const found = (await registeredTools()).get(name);
	assert.ok(found, `${name} must be registered`);
	return found;
}

for (const name of Object.keys(TOKEN_CEILINGS) as Array<keyof typeof TOKEN_CEILINGS>) {
	test(`${name} declaration stays within ${TOKEN_CEILINGS[name]} estimated tokens`, async () => {
		const tokens = estimatedTokens(await tool(name));
		assert.ok(tokens <= TOKEN_CEILINGS[name], `${name} declaration is ${tokens} estimated tokens; the ceiling is ${TOKEN_CEILINGS[name]}`);
	});
}

test("both schemas still advertise every action", async () => {
	assert.deepEqual((await tool("session_focus")).parameters.properties.action?.enum,
		["get", "start", "edit", "ref", "boundary", "status", "detach", "activity", "pin", "goal", "brief"]);
	assert.deepEqual((await tool("session_tasks")).parameters.properties.action?.enum,
		["plan", "add", "update", "remove", "reorder", "list", "subtree"]);
});

test("session_focus names the valid statuses and ref kinds for a wrong value", async () => {
	const focus = await tool("session_focus");
	assert.throws(() => piValidate(focus, { action: "status", status: "bogus" }),
		/session_focus: status "bogus" is not valid\. Valid statuses: active, paused, completed, detached\./u);
	assert.throws(() => piValidate(focus, { action: "ref", ref: { kind: "issue", value: "x" } }),
		/session_focus: ref kind "issue" is not valid\. Valid kinds: gitlab-mr, github-issue, graft-spec, branch, commit, path, url, other\./u);
});

test("the legacy flat ref form is still accepted and still bounded", () => {
	assert.deepEqual(prepareSessionFocusArguments({ action: "ref", refKind: "branch", refValue: "fix/x" }),
		{ action: "ref", refKind: "branch", refValue: "fix/x" });
	assert.throws(() => prepareSessionFocusArguments({ action: "ref", refKind: "branch", refValue: "r".repeat(513) }),
		/session_focus: refValue must be at most 512 characters/u);
	assert.throws(() => prepareSessionFocusArguments({ action: "ref", refKind: "issue", refValue: "x" }),
		/session_focus: ref kind "issue" is not valid\. Valid kinds: gitlab-mr/u);
});

test("session_tasks names the valid actions and statuses for a wrong value", async () => {
	const tasks = await tool("session_tasks");
	assert.throws(() => piValidate(tasks, { action: "done", ids: ["t1"] }),
		/session_tasks: action "done" is not valid\. Valid actions: plan, add, update, remove, reorder, list, subtree\./u);
	assert.throws(() => prepareSessionTasksArguments({}), /session_tasks: no action is not valid/u);
	assert.throws(() => piValidate(tasks, { action: "update", updates: [{ id: "t1", status: "complete" }] }),
		/session_tasks: status "complete" is not valid\. Valid statuses: pending, active, done, blocked, deferred\./u);
	assert.throws(() => piValidate(tasks, { action: "plan", tasks: [{ title: "a", subtasks: [{ title: "b", status: "finished" }] }] }),
		/session_tasks: status "finished" is not valid/u);
	assert.throws(() => piValidate(tasks, { action: "plan", tasks: JSON.stringify([{ title: "a", status: "wip" }]) }),
		/session_tasks: status "wip" is not valid/u);
});

test("trimmed schemas still accept complete calls for every field the tools read", async () => {
	const focus = await tool("session_focus");
	for (const args of [
		{ action: "start", objective: "ship it", reason: "why" },
		{ action: "ref", ref: { kind: "gitlab-mr", value: "group/project!1" }, remove: true },
		{ action: "boundary", boundary: "no force-push" },
		{ action: "pin", pinned_block: "durable fact" },
		{ action: "pin", clear: true },
	]) assert.deepEqual(piValidate(focus, args), args);
	const tasks = await tool("session_tasks");
	for (const args of [
		{ action: "plan", tasks: [{ title: "a", note: "n", ref: "r-1", status: "blocked", subtasks: [{ title: "b", status: "done" }] }] },
		{ action: "add", title: "c", note: "n", ref: "r-2", parent: "t1", after: "t1.1" },
		{ action: "add", title: "d", before: "t1" },
		{ action: "update", updates: [{ id: "t1", status: "deferred", note: "later", title: "e", ref: "r-3" }] },
		{ action: "reorder", ids: ["t2", "t1"] },
	]) assert.deepEqual(piValidate(tasks, args), args);
});
