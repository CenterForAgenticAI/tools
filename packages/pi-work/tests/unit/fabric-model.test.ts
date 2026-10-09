import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWithFabricModel, resolveFabricDispatchModel } from "../../src/dispatch/fabric/model.ts";

// Boundary shape probed from pi-fabric agents.models({ runner: "pi" }).
const available = [
	{ runner: "pi", provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", key: "anthropic/claude-sonnet-4-6" },
	{ runner: "pi", provider: "openai", id: "gpt-5", name: "GPT-5", key: "openai/gpt-5" },
];

test("model-fallback: requested model wins over available fallbacks", () => {
	assert.deepEqual(resolveFabricDispatchModel({ model: "openai/gpt-5", fallbackModels: ["anthropic/claude-sonnet-4-6"] }, available), {
		status: "resolved", requestedModel: "openai/gpt-5", resolvedModel: "openai/gpt-5", chosenModel: "openai/gpt-5",
	});
});

test("model-fallback: selects first available fallback before starting exactly one run and retains receipt metadata", async () => {
	const order: string[] = [];
	const result = await dispatchWithFabricModel({ model: "missing/requested", fallbackModels: ["missing/first", "openai/gpt-5", "anthropic/claude-sonnet-4-6"] }, {
		async models(options) { assert.deepEqual(options, { runner: "pi" }); order.push("models"); return available; },
		async run(model, selection) {
			order.push("run");
			assert.equal(model, "openai/gpt-5");
			return { runId: "run-1", requestedModel: selection.requestedModel, resolvedModel: selection.resolvedModel, chosenModel: selection.chosenModel };
		},
	});
	assert.deepEqual(order, ["models", "run"]);
	assert.deepEqual(result, {
		status: "dispatched",
		selection: { status: "resolved", requestedModel: "missing/requested", resolvedModel: "openai/gpt-5", chosenModel: "openai/gpt-5" },
		result: { runId: "run-1", requestedModel: "missing/requested", resolvedModel: "openai/gpt-5", chosenModel: "openai/gpt-5" },
	});
});

test("model-fallback: rejects unavailable request and fallbacks with typed finding and starts no run", async () => {
	let runs = 0;
	const result = await dispatchWithFabricModel({ model: "missing/requested", fallbackModels: ["missing/fallback"] }, {
		async models() { return available; },
		async run() { runs += 1; return "unexpected"; },
	});
	assert.equal(runs, 0);
	assert.equal(result.status, "rejected");
	assert.ok(result.status === "rejected");
	assert.equal(result.dispatchState, "not-dispatched");
	assert.equal(result.finding.code, "delegate-runtime-error");
	assert.equal(result.finding.runtimeCode, "model-unavailable");
	assert.match(result.finding.message, /missing\/requested/);
	assert.match(result.finding.message, /missing\/fallback/);
});

test("model-fallback: an empty catalog rejects explicit models, including duplicates", () => {
	const result = resolveFabricDispatchModel({ model: "openai/gpt-5", fallbackModels: ["openai/gpt-5"] }, []);
	assert.equal(result.status, "rejected");
});

test("model-fallback: a near miss cannot substitute for the first available explicit fallback", () => {
	assert.deepEqual(resolveFabricDispatchModel({ model: "openai/gpt-typo", fallbackModels: ["anthropic/claude-sonnet-4-6"] }, available), {
		status: "resolved", requestedModel: "openai/gpt-typo", resolvedModel: "anthropic/claude-sonnet-4-6", chosenModel: "anthropic/claude-sonnet-4-6",
	});
});

test("model-fallback: fallbacks without a request still select in declaration order", () => {
	assert.deepEqual(resolveFabricDispatchModel({ fallbackModels: ["missing/model", "openai/gpt-5"] }, available), {
		status: "resolved", resolvedModel: "openai/gpt-5", chosenModel: "openai/gpt-5",
	});
});

test("model-fallback: omitted models preserve Fabric's inherited default without querying availability", async () => {
	let runs = 0;
	const result = await dispatchWithFabricModel({}, {
		async models() { throw new Error("default must not depend on catalog"); },
		async run(model) { runs += 1; assert.equal(model, undefined); return "inherited"; },
	});
	assert.equal(runs, 1);
	assert.deepEqual(result, { status: "dispatched", selection: { status: "resolved" }, result: "inherited" });
});

test("model-fallback: catalog failure prevents a run and is not treated as model unavailability", async () => {
	let runs = 0;
	await assert.rejects(dispatchWithFabricModel({ model: "openai/gpt-5" }, {
		async models() { throw new Error("catalog unavailable"); },
		async run() { runs += 1; },
	}), /catalog unavailable/);
	assert.equal(runs, 0);
});

test("model-fallback: a run failure is not retried with another model", async () => {
	let runs = 0;
	await assert.rejects(dispatchWithFabricModel({ model: "openai/gpt-5", fallbackModels: ["anthropic/claude-sonnet-4-6"] }, {
		async models() { return available; },
		async run() { runs += 1; throw new Error("submission unknown"); },
	}), /submission unknown/);
	assert.equal(runs, 1);
});

test("model-fallback: caller fields and catalog metadata cannot survive into selection metadata", () => {
	const request = { model: "openai/gpt-5", injected: "secret", writableRoots: ["/"] };
	assert.deepEqual(resolveFabricDispatchModel(request, available), {
		status: "resolved", requestedModel: "openai/gpt-5", resolvedModel: "openai/gpt-5", chosenModel: "openai/gpt-5",
	});
});
