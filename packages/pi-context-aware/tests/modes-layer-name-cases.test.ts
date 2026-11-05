import assert from "node:assert/strict";
import test from "node:test";
import { createContextAwareModesV1 } from "../src/modes/modes-runtime.js";
import { isModeLayerName, MODE_LAYER_NAME_CASES } from "../src/modes/modes-state.js";

const { accepted, rejected } = MODE_LAYER_NAME_CASES;

test("isModeLayerName accepts every accepted case and refuses every rejected case", () => {
	for (const name of accepted) assert.equal(isModeLayerName(name), true, JSON.stringify(name));
	for (const name of rejected) assert.equal(isModeLayerName(name), false, JSON.stringify(name));
});

test("the cases cover every printable ASCII character as a first and a later character, and the length bound", () => {
	const all = new Set([...accepted, ...rejected]);
	assert.equal(all.size, accepted.length + rejected.length, "no name is both accepted and rejected, or listed twice");
	for (let code = 0x21; code <= 0x7e; code += 1) {
		const character = String.fromCharCode(code);
		assert.ok(all.has(`${character}x`), `first character ${JSON.stringify(character)}`);
		assert.ok(all.has(`x${character}`), `later character ${JSON.stringify(character)}`);
	}
	assert.ok(accepted.includes("x".repeat(64)), "64 characters are accepted");
	assert.ok(rejected.includes("x".repeat(65)), "65 characters are refused");
	// Spot checks from the rule as /mode exit documents it, independent of the case list's construction.
	for (const name of ["Ax", "0x", "x_", "x.", "x-"]) assert.ok(accepted.includes(name), name);
	for (const name of ["_x", ".x", "-x", "x/", "x:", "x!"]) assert.ok(rejected.includes(name), name);
});

test("defineMode applies the same rule to a layer name as the cases", () => {
	const modes = createContextAwareModesV1({ appendEntry: () => {}, sendMessage: () => {}, entries: () => [] });
	const define = (name: string, index: number) =>
		modes.defineMode({ id: `m${index}`, owner: "cases", transition: "x", blockedTools: [], layer: { name, rank: 1 } }).status;
	// defineMode trims first, and the reserved default layer is refused for another reason, so neither kind is a case.
	accepted.forEach((name, index) => assert.equal(define(name, index), "ok", JSON.stringify(name)));
	rejected.forEach((name, index) => assert.equal(define(name, accepted.length + index), "refused", JSON.stringify(name)));
});
