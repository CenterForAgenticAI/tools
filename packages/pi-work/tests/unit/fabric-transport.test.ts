import assert from "node:assert/strict";
import test from "node:test";

import { runFabricProgram, type FabricProgramRunRequest } from "../../src/dispatch/fabric/transport.ts";

test("program-run-transport: emits one host event with caller signal and by-reference task", async () => {
	const controller = new AbortController();
	const calls: { channel: string; payload: unknown }[] = [];
	const value = { id: "run-1", worktreeResult: { branch: "worker" } };
	const result = await runFabricProgram({ emit(channel, payload) {
		calls.push({ channel, payload });
		const request = payload as FabricProgramRunRequest;
		request.reply({ ok: true, program: "digest", value, logs: ["done"] });
	} }, { ref: "digest", input: { task: "Read .work/brief.md (sha256 abc)", name: "node" }, signal: controller.signal });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].channel, "pi-fabric:program:run:v1");
	const payload = calls[0].payload as FabricProgramRunRequest;
	assert.equal(payload.signal, controller.signal);
	assert.deepEqual(JSON.parse(JSON.stringify(payload.input)), { task: "Read .work/brief.md (sha256 abc)", name: "node" });
	assert.deepEqual(result, { ok: true, program: "digest", value, logs: ["done"] });
});

test("program-run-transport: absent listener and silent listener return timeout without hanging", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const pending = runFabricProgram({ emit() { calls++; } }, { ref: "digest", input: { task: "path and hash" }, timeoutMs: 10 });
	t.mock.timers.tick(10);
	assert.deepEqual(await pending, { ok: false, finding: { code: "fabric-timeout", message: "Fabric did not reply within the bound; its listener may be absent" } });
	assert.equal(calls, 1);
	assert.deepEqual(await runFabricProgram(undefined, { ref: "digest", input: { task: "path" } }), {
		ok: false, finding: { code: "fabric-unavailable", message: "Fabric event bus is unavailable" },
	});
});

test("program-run-transport: unknown ref, missing session and failed run replies are typed failures", async () => {
	for (const error of ["Unknown program ref", "No active session", "Worker failed"]) {
		const result = await runFabricProgram({ emit(_channel, payload) {
			(payload as FabricProgramRunRequest).reply({ ok: false, error });
		} }, { ref: "unknown", input: { task: "path" } });
		assert.deepEqual(result, { ok: false, finding: { code: "fabric-run-failed", message: error } });
	}
});

test("program-run-transport: synchronous host throw becomes a typed finding", async () => {
	assert.deepEqual(await runFabricProgram({ emit() { throw new Error("host unavailable"); } }, { ref: "digest", input: { task: "path" } }), {
		ok: false, finding: { code: "fabric-emit-failed", message: "Error: host unavailable" },
	});
});

test("program-run-transport: abort cancels the wait and removes the listener", async () => {
	const controller = new AbortController();
	let added = 0;
	let removed = 0;
	const add = controller.signal.addEventListener.bind(controller.signal);
	const remove = controller.signal.removeEventListener.bind(controller.signal);
	controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => { added++; add(...args); };
	controller.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => { removed++; remove(...args); };
	let request: FabricProgramRunRequest | undefined;
	const pending = runFabricProgram({ emit(_channel, payload) { request = payload as FabricProgramRunRequest; } }, {
		ref: "digest", input: { task: "path" }, signal: controller.signal,
	});
	controller.abort();
	assert.deepEqual(await pending, { ok: false, finding: { code: "fabric-aborted", message: "Fabric dispatch was aborted" } });
	assert.equal(added, 1);
	assert.equal(removed, 1);
	assert.ok(request);
	request.reply({ ok: true, program: "late", value: "ignored", logs: [] });
	let emitted = false;
	assert.deepEqual(await runFabricProgram({ emit() { emitted = true; } }, { ref: "digest", input: { task: "path" }, signal: controller.signal }), {
		ok: false, finding: { code: "fabric-aborted", message: "Fabric dispatch was aborted" },
	});
	assert.equal(emitted, false);
});

test("program-run-transport: first reply wins over duplicates, throws and timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const controller = new AbortController();
	const result = await runFabricProgram({ emit(_channel, payload) {
		const request = payload as FabricProgramRunRequest;
		request.reply({ ok: true, program: "first", value: 42, logs: [] });
		request.reply({ ok: false, error: "duplicate" });
		throw new Error("after reply");
	} }, { ref: "digest", input: { task: "path" }, signal: controller.signal, timeoutMs: 1 });
	t.mock.timers.tick(1);
	controller.abort();
	assert.deepEqual(result, { ok: true, program: "first", value: 42, logs: [] });
});

test("program-run-transport: late reply cannot replace timeout", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let request: FabricProgramRunRequest | undefined;
	const pending = runFabricProgram({ emit(_channel, payload) { request = payload as FabricProgramRunRequest; } }, { ref: "digest", input: { task: "path" }, timeoutMs: 1 });
	t.mock.timers.tick(1);
	assert.ok(request);
	request.reply({ ok: true, program: "late", value: 42, logs: [] });
	const result = await pending;
	assert.equal(result.ok, false);
	assert.ok("finding" in result);
	assert.equal(result.finding.code, "fabric-timeout");
});

test("program-run-transport: invalid bounds cannot disable the wait deadline", async () => {
	let calls = 0;
	for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 600_001]) {
		const result = await runFabricProgram({ emit() { calls++; } }, { ref: "digest", input: { task: "path" }, timeoutMs });
		assert.equal(result.ok, false);
		assert.ok("finding" in result);
		assert.equal(result.finding.code, "fabric-request-invalid");
	}
	assert.equal(calls, 0);
});

test("program-run-transport: copies approved fields and caps serialized input at 64 KiB", async () => {
	const input = {
		task: "path and sha256", name: "node", model: "provider/model", thinking: "high", cwd: "/project",
		worktree: true, writableRoots: ["src/owned.ts"], shell: "unconfined" as const,
		schema: { type: "object" }, systemPrompt: "stay in scope", runner: "injected", inheritedScope: { grants: ["*"] },
	};
	let request: FabricProgramRunRequest | undefined;
	await runFabricProgram({ emit(_channel, payload) {
		request = payload as FabricProgramRunRequest;
		request.reply({ ok: true, program: "digest", value: null, logs: [] });
	} }, { ref: "digest", input, requirePromoted: true });
	assert.ok(request);
	assert.equal(request.requirePromoted, true);
	assert.deepEqual(request.input, {
		task: "path and sha256", name: "node", model: "provider/model", thinking: "high", cwd: "/project",
		worktree: true, writableRoots: ["src/owned.ts"], shell: "unconfined", schema: { type: "object" }, systemPrompt: "stay in scope",
	});
	assert.deepEqual(Object.keys(request).sort(), ["input", "ref", "reply", "requirePromoted", "signal"]);
	let calls = 0;
	const bus = { emit(_channel: string, payload: unknown) {
		calls++;
		(payload as FabricProgramRunRequest).reply({ ok: true, program: "digest", value: null, logs: [] });
	} };
	// JSON wrapper {"task":""} consumes eleven bytes. Multibyte text must be counted in bytes.
	assert.equal((await runFabricProgram(bus, { ref: "digest", input: { task: "a".repeat(65_525) } })).ok, true);
	const oversized = await runFabricProgram(bus, { ref: "digest", input: { task: "a".repeat(65_526) } });
	assert.deepEqual(oversized, { ok: false, finding: { code: "fabric-request-invalid", message: "Fabric program input exceeds 64 KiB; pass the brief by path and hash" } });
	assert.equal((await runFabricProgram(bus, { ref: "digest", input: { task: "é".repeat(32_763) } })).ok, false);
	const circular: { self?: unknown } = {};
	circular.self = circular;
	const unserializable = await runFabricProgram(bus, { ref: "digest", input: { task: "path", schema: circular } });
	assert.equal(unserializable.ok, false);
	assert.ok("finding" in unserializable);
	assert.equal(unserializable.finding.code, "fabric-request-invalid");
	assert.equal(calls, 1);
});
