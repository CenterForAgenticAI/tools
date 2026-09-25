import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RUNNING_COMPILED, sourceModuleUrl } from "../helpers/source-under-test.ts";

const EXPECTED_TOOLS = ["work_validate", "work_promote", "work_amend_criterion", "work_status", "work_plan", "work_dispatch", "work_verify"];
const EXPECTED_COMMANDS = ["work-draft", "work-promote", "work-decompose", "work-status", "work-next"];

test(`pi-work extension registers exactly the v1 tools and commands (${RUNNING_COMPILED ? "compiled" : "source"} layout)`, async () => {
	const extension = (await import(sourceModuleUrl("index"))).default as (pi: ExtensionAPI) => void;
	const tools: string[] = [];
	const commands: string[] = [];
	const pi = {
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	} as unknown as ExtensionAPI;

	extension(pi);

	assert.deepEqual(tools, EXPECTED_TOOLS, "the registered tool set must be exact: no missing, renamed, or additional tools");
	assert.deepEqual(commands, EXPECTED_COMMANDS, "the registered command set must be exact: no missing, renamed, or additional commands");
});
