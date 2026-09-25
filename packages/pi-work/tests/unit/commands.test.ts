import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { RUNNING_COMPILED, sourceModuleUrl } from "../helpers/source-under-test.ts";

type Command = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

const EXPECTED = new Map([
	["work-draft", "work-authoring"],
	["work-promote", "work_promote"],
	["work-decompose", "work-decomposition"],
	["work-status", "work_status"],
	["work-next", "exactly one ready"],
]);

test(`pi-work commands send one workflow request and return (${RUNNING_COMPILED ? "compiled" : "source"} layout)`, async () => {
	const extension = (await import(sourceModuleUrl("index"))).default as (pi: ExtensionAPI) => void;
	const commands = new Map<string, Command>();
	const messages: string[] = [];
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: Command) {
			commands.set(name, options);
		},
		sendUserMessage(content: string) {
			messages.push(content);
		},
	} as unknown as ExtensionAPI;
	extension(pi);

	assert.deepEqual([...commands.keys()], [...EXPECTED.keys()]);
	for (const [name, marker] of EXPECTED) {
		messages.length = 0;
		const command = commands.get(name);
		assert.ok(command, `missing ${name}`);
		await command.handler("one request", new Proxy({}, { get(_target, property) {
			throw new Error(`command ${name} accessed session control ${String(property)}`);
		}}) as ExtensionCommandContext);
		assert.equal(messages.length, 1, `${name} must send exactly one user message`);
		assert.match(messages[0]!, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(messages[0]!, /User arguments: one request/);

		// Whitespace-only arguments take the no-arguments branch: the request is sent
		// bare rather than with an empty trailing arguments section.
		messages.length = 0;
		await command.handler("   ", new Proxy({}, { get(_target, property) {
			throw new Error(`command ${name} accessed session control ${String(property)}`);
		}}) as ExtensionCommandContext);
		assert.equal(messages.length, 1, `${name} must send exactly one user message without arguments`);
		assert.match(messages[0]!, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(messages[0]!.includes("User arguments:"), false, `${name} must omit the arguments section when none were given`);
	}
});

test("work-decompose relays one decomposition round without planning or dispatching", async () => {
	const extension = (await import(sourceModuleUrl("index"))).default as (pi: ExtensionAPI) => void;
	let decompose: Command | undefined;
	const messages: string[] = [];
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: Command) {
			if (name === "work-decompose") decompose = options;
		},
		sendUserMessage(content: string) {
			messages.push(content);
		},
	} as unknown as ExtensionAPI;
	extension(pi);

	assert.ok(decompose);
	assert.equal(decompose.description, "Start one pi-work decomposition round.");
	await decompose.handler(".work/drafts/widget.yaml", {} as ExtensionCommandContext);
	assert.equal(messages.length, 1);
	assert.match(messages[0]!, /work-decomposition skill/);
	assert.match(messages[0]!, /one decomposition round/);
	assert.match(messages[0]!, /carve the work graph/);
	assert.match(messages[0]!, /assign criterion homes/);
	assert.match(messages[0]!, /scope touches/);
	assert.match(messages[0]!, /record open decisions/);
	assert.match(messages[0]!, /validate the result as appropriate/);
	assert.match(messages[0]!, /Do not plan or dispatch work/);
	assert.match(messages[0]!, /return control after this round/);
	assert.doesNotMatch(messages[0]!, /\bwork_plan\b/);
});

test("work-next states its single-round boundary instead of owning a loop", async () => {
	const extension = (await import(sourceModuleUrl("index"))).default as (pi: ExtensionAPI) => void;
	let next: Command | undefined;
	let message = "";
	const pi = {
		registerTool() {},
		registerCommand(name: string, options: Command) {
			if (name === "work-next") next = options;
		},
		sendUserMessage(content: string) {
			message = content;
		},
	} as unknown as ExtensionAPI;
	extension(pi);

	assert.ok(next);
	await next.handler("", {} as ExtensionCommandContext);
	assert.match(message, /exactly one ready/);
	assert.match(message, /Do not loop, wait, sequence, retry, or poll/);
});
