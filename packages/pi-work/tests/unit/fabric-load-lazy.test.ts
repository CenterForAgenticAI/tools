import assert from "node:assert/strict";
import test from "node:test";

import piWork from "../../src/index.js";

test("fabric-load-lazy: loading the extension never asks the host for its tools", () => {
	const registered: string[] = [];
	const bus = { emit() {}, on() { return () => {}; } };
	const pi = {
		events: bus,
		registerTool(tool: { name: string }) { registered.push(tool.name); },
		registerCommand() {},
		on() {},
		getAllTools() { throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading."); },
	};
	assert.doesNotThrow(() => piWork(pi as never));
	assert.ok(registered.includes("work_dispatch"));
});
