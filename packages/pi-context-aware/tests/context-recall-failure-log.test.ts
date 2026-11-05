import test from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createContextRecallSurface, RECALL_FAILURE_STACK_LINES } from "../src/context-tools/context-recall.js";
import { decideContextToolSurface } from "../src/context-tools/surface.js";
import { createHostPi, createSession } from "./compaction-owner-harness.js";

// Seam: the registered context_recall tool's execute() and the host's debug log.

type Execute = (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown>;

function setup(options: { cachePools: () => never; debugLog?: (message: string) => void }) {
	const host = createHostPi();
	const surface = createContextRecallSurface(host.api, {
		listSessions: async () => ({ sessions: [], scannedCwds: [], scopeLabel: "project" }),
		erasedSessionIds: () => new Set(),
		cachePools: options.cachePools,
		home: () => os.homedir(),
		debugLog: options.debugLog,
	});
	surface.apply(decideContextToolSurface([...host.tools.values()] as Array<{ name: string }>, undefined), false);
	const ctx = createSession("/tmp", "failure-log").ctx as unknown as ExtensionContext;
	const execute = (host.tools.get("context_recall") as { execute: Execute }).execute;
	return (params: Record<string, unknown>) => execute("call", params, new AbortController().signal, undefined, ctx);
}

const overflow = (): never => {
	const err = new RangeError("Maximum call stack size exceeded");
	err.stack = Array.from({ length: 100 }, (_, i) => (i === 0 ? "RangeError: Maximum call stack size exceeded" : `    at frame${i} (file.js:${i}:1)`)).join("\n");
	throw err;
};

test("AC-198-1/2: a thrown recall error leaves at most 40 stack lines and the uptime in the debug log, and the same error reaches the caller", async () => {
	const logged: string[] = [];
	const call = setup({ cachePools: overflow, debugLog: (m) => logged.push(m) });
	let caught: unknown;
	try { await call({ query: "anything" }); } catch (err) { caught = err; }
	assert.ok(caught instanceof RangeError);
	assert.equal(caught.message, "Maximum call stack size exceeded");
	assert.equal(logged.length, 1);
	assert.match(logged[0], /RangeError, uptime \d+\.\ds/u);
	assert.match(logged[0], /at frame38 /u);
	assert.doesNotMatch(logged[0], /at frame40 /u);
	assert.ok(logged[0].split("\n").length <= RECALL_FAILURE_STACK_LINES + 1);
});

test("AC-198-3: a throwing debug log does not replace the original error", async () => {
	const call = setup({ cachePools: overflow, debugLog: () => { throw new Error("disk full"); } });
	await assert.rejects(() => call({ query: "anything" }), (err: Error) => err instanceof RangeError && err.message === "Maximum call stack size exceeded");
});

test("a blank question and a successful call write nothing to the debug log", async () => {
	const logged: string[] = [];
	const call = setup({ cachePools: () => [] as never, debugLog: (m) => logged.push(m) });
	await call({ query: "   " });
	await call({ query: "something" });
	assert.deepEqual(logged, []);
});
