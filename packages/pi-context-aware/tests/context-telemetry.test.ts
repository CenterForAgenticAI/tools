import test from "node:test";
import assert from "node:assert/strict";
import { buildContextTelemetry } from "../context-telemetry.js";

const continuationInstruction =
	"This is extension telemetry, not user input. No response or acknowledgement is expected. It does not supersede the preceding user request or tool result. Continue the current agent loop without acknowledging this telemetry, using the pressure data only for context-management decisions.";

test("builds self-describing XML telemetry without an action in the OK band", () => {
	const telemetry = buildContextTelemetry({ fraction: 0.224, headroom: 211_000 });

	assert.equal(
		telemetry,
		`<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">
  <pressure band="OK" usage-percent="22" approximate-headroom="211k" />
  <instruction>${continuationInstruction}</instruction>
</context-telemetry>`,
	);
	assert.doesNotMatch(telemetry, / action=/);
	assert.doesNotMatch(telemetry, /\[ctx\b/);
});

test("includes gate-broad-work action in WARN telemetry", () => {
	const telemetry = buildContextTelemetry({ fraction: 0.635, headroom: 98_400 });

	assert.match(telemetry, /<context-telemetry source="pi-extension:context-aware" user-input="false" response-expected="false">/);
	assert.match(telemetry, /<pressure band="WARN" usage-percent="64" approximate-headroom="98k" action="gate-broad-work" \/>/);
	assert.match(telemetry, new RegExp(continuationInstruction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("includes compact-before-tool action in URGENT telemetry", () => {
	const telemetry = buildContextTelemetry({ fraction: 0.82, headroom: 49_000 });

	assert.match(telemetry, /<pressure band="URGENT" usage-percent="82" approximate-headroom="49k" action="compact-before-tool" \/>/);
	assert.match(telemetry, /Continue the current agent loop without acknowledging this telemetry/);
});
