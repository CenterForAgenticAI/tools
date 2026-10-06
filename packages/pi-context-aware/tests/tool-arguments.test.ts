import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { MAX_REPAIRABLE_ARGUMENT_CHARS, MAX_REPAIRABLE_ARRAY_ITEMS, prepareSessionFocusArguments, prepareSessionTasksArguments } from "../src/tool-arguments.js";

// Some Claude models send list arguments as JSON strings. Pi validates tool
// arguments after the tool's prepareArguments hook, exactly as below; without
// the hook, Value.Convert wraps the string in a one-item array and validation
// fails with "tasks.0: must be object".

interface RegisteredTool {
	name: string;
	parameters: unknown;
	prepareArguments?: (args: unknown) => unknown;
}

/** Load the real extension against a permissive fake and collect its tools. */
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
	const extension = await import(`../src/index.js?tool-arguments=${Date.now()}`);
	extension.default(api);
	return tools;
}

/** Pi's pre-execution path: prepareArguments, then schema validation. */
function piValidate(tool: RegisteredTool, args: unknown): unknown {
	const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
	return validateToolArguments(
		{ name: tool.name, description: "", parameters: tool.parameters } as never,
		{ type: "toolCall", id: "call-1", name: tool.name, arguments: prepared } as never,
	);
}

const stringifiedPlan = {
	action: "plan",
	tasks: JSON.stringify([{ title: "alpha", subtasks: JSON.stringify([{ title: "alpha-1" }]) }, { title: "beta", status: "active" }]),
};

test("without repair, a stringified tasks list fails Pi validation with the misleading error", async () => {
	const tool = (await registeredTools()).get("session_tasks");
	assert.ok(tool);
	assert.throws(() => piValidate({ ...tool, prepareArguments: undefined }, stringifiedPlan), /tasks\/?\.?0.*must be object|must be object/u);
});

test("session_tasks repairs a stringified tasks plan, including nested subtasks, before validation", async () => {
	const tool = (await registeredTools()).get("session_tasks");
	assert.ok(tool?.prepareArguments, "session_tasks must register a prepareArguments hook");
	const validated = piValidate(tool, stringifiedPlan) as { tasks: Array<{ title: string; subtasks?: Array<{ title: string }> }> };
	assert.deepEqual(validated.tasks.map((task) => task.title), ["alpha", "beta"]);
	assert.equal(validated.tasks[0]?.subtasks?.[0]?.title, "alpha-1");
});

test("session_tasks repairs stringified updates and ids", async () => {
	const tool = (await registeredTools()).get("session_tasks");
	assert.ok(tool);
	const updates = piValidate(tool, { action: "update", updates: JSON.stringify([{ id: "t1", status: "done" }]) }) as { updates: unknown[] };
	assert.deepEqual(updates.updates, [{ id: "t1", status: "done" }]);
	const ids = piValidate(tool, { action: "remove", ids: '["t1","t2"]' }) as { ids: string[] };
	assert.deepEqual(ids.ids, ["t1", "t2"]);
});

test("strings that are not JSON arrays are left for validation to reject", () => {
	assert.deepEqual(prepareSessionTasksArguments({ action: "plan", tasks: "alpha, beta" }), { action: "plan", tasks: "alpha, beta" });
	assert.deepEqual(prepareSessionTasksArguments({ action: "plan", tasks: '{"title":"x"}' }), { action: "plan", tasks: '{"title":"x"}' });
	assert.equal(prepareSessionTasksArguments("not an object"), "not an object");
});

test("session_focus repairs a stringified ref object", async () => {
	const tool = (await registeredTools()).get("session_focus");
	assert.ok(tool?.prepareArguments, "session_focus must register a prepareArguments hook");
	const validated = piValidate(tool, { action: "ref", ref: JSON.stringify({ kind: "branch", value: "fix/x" }) }) as { ref: unknown };
	assert.deepEqual(validated.ref, { kind: "branch", value: "fix/x" });
});

test("session_focus names the valid actions and the objective field for invented actions and fields", async () => {
	const tool = (await registeredTools()).get("session_focus");
	assert.ok(tool);
	for (const action of ["set", "update", "set_focus", "add"]) {
		assert.throws(() => piValidate(tool, { action, focus: "ship it" }), (error: Error) => {
			assert.match(error.message, new RegExp(`action "${action}" is not valid`, "u"));
			assert.match(error.message, /Valid actions: get, start, edit, ref, boundary, status, detach, activity, pin/u);
			assert.match(error.message, /objective/u);
			assert.match(error.message, /The field focus is not recognised; use objective/u);
			return true;
		});
	}
	assert.throws(() => piValidate(tool, { action: "start", purpose: "ship it" }), /session_focus start requires the field objective.*The field purpose is not recognised/u);
	assert.throws(() => prepareSessionFocusArguments({}), /no action is not valid/u);
});

test("session_focus names the missing field for status, boundary and ref", async () => {
	const tool = (await registeredTools()).get("session_focus");
	assert.ok(tool);
	assert.throws(() => piValidate(tool, { action: "status" }), /session_focus status requires the field status \(active, paused, completed or detached\)/u);
	assert.throws(() => piValidate(tool, { action: "boundary" }), /session_focus boundary requires the field boundary/u);
	assert.throws(() => piValidate(tool, { action: "ref" }), /session_focus ref requires the field ref with kind and value/u);
	assert.throws(() => piValidate(tool, { action: "ref", refKind: "branch" }), /session_focus ref requires the field ref/u);
	assert.throws(() => piValidate(tool, { action: "boundary", remove: true }), /session_focus boundary requires the field boundary/u);
	assert.throws(() => piValidate(tool, { action: "status", status: null }), /session_focus status requires the field status/u);
	assert.throws(() => piValidate(tool, { action: "boundary", boundary: null }), /session_focus boundary requires the field boundary/u);
	assert.throws(() => piValidate(tool, { action: "ref", ref: null, refKind: null, refValue: null }), /session_focus ref requires the field ref/u);
});

test("present focus fields are left to schema validation, and complete calls pass", async () => {
	const tool = (await registeredTools()).get("session_focus");
	assert.ok(tool);
	assert.throws(() => piValidate(tool, { action: "status", status: "bogus" }), (error: Error) => !/requires the field/u.test(error.message));
	assert.deepEqual(piValidate(tool, { action: "status", status: "paused" }), { action: "status", status: "paused" });
	assert.deepEqual(piValidate(tool, { action: "boundary", boundary: "no force-push" }), { action: "boundary", boundary: "no force-push" });
	assert.deepEqual(piValidate(tool, { action: "ref", refKind: "branch", refValue: "fix/x" }), { action: "ref", refKind: "branch", refValue: "fix/x" });
});

test("a list string over the size cap is not parsed", () => {
	const oversized = JSON.stringify(Array.from({ length: 40_000 }, (_, index) => ({ title: `task ${index} ${"x".repeat(20)}` })));
	assert.ok(oversized.length > MAX_REPAIRABLE_ARGUMENT_CHARS);
	const prepared = prepareSessionTasksArguments<{ tasks: unknown }>({ action: "plan", tasks: oversized });
	assert.equal(typeof prepared.tasks, "string");
	const small = prepareSessionTasksArguments<{ tasks: unknown }>({ action: "plan", tasks: '[{"title":"a"}]' });
	assert.ok(Array.isArray(small.tasks));
});

test("a list string with too many items is not parsed, but a slightly-too-long one is", () => {
	const items = (count: number) => JSON.stringify(Array.from({ length: count }, () => ({ title: "t" })));
	const huge = prepareSessionTasksArguments<{ tasks: unknown }>({ action: "plan", tasks: items(MAX_REPAIRABLE_ARRAY_ITEMS + 1) });
	assert.equal(typeof huge.tasks, "string");
	const over = prepareSessionTasksArguments<{ tasks: unknown }>({ action: "plan", tasks: items(101) });
	assert.ok(Array.isArray(over.tasks));
});

test("valid session_focus calls pass through unchanged", async () => {
	const tool = (await registeredTools()).get("session_focus");
	assert.ok(tool);
	assert.deepEqual(piValidate(tool, { action: "start", objective: "ship it" }), { action: "start", objective: "ship it" });
	assert.deepEqual(piValidate(tool, { action: "get" }), { action: "get" });
});
