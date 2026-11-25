import test from "node:test";
import assert from "node:assert/strict";
import {
	CONTEXT_AWARE_OWNERSHIP,
	INTERCOM_CONTRACT_VERSION,
	parseIntercomMetadata,
	parseTerminalLocationAcknowledgement,
	type IntercomMetadata,
} from "../src/platform/peer-contracts.js";

const intercom: IntercomMetadata = {
	schemaVersion: INTERCOM_CONTRACT_VERSION,
	workstreamId: "ws-1",
	piSessionId: "pi-1",
	objective: "Ship contracts",
	status: "active",
	refs: [{ kind: "graft-spec", value: "0001" }],
	relevance: { score: 0.8, reason: "same graft spec" },
};

test("peer metadata is additive, optional, and rejects unsupported or malformed versions", () => {
	assert.deepEqual(parseIntercomMetadata({ ...intercom, futureField: { ignored: true } }), intercom);
	assert.equal(parseIntercomMetadata(undefined), undefined);
	assert.equal(parseIntercomMetadata({ ...intercom, schemaVersion: 2 }), undefined);
	assert.equal(parseIntercomMetadata({ ...intercom, relevance: { score: 2, reason: "bad" } }), undefined);
});

test("ownership boundaries exclude routing, worktree lifecycle, and terminal launching", () => {
	assert.ok(CONTEXT_AWARE_OWNERSHIP.owns.some((item) => item.includes("peer metadata")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("routing")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("worktree")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("terminal process")));
});

test("terminal acknowledgements keep launcher-owned location data versioned and optional", () => {
	const acknowledgement = parseTerminalLocationAcknowledgement({
		schemaVersion: 1,
		handoffId: "handoff-1",
		workstreamId: "ws-1",
		piSessionId: "child-pi",
		terminal: { terminalId: "term-1", kind: "cmux", location: "surface-1" },
		workspace: { kind: "path", value: "/project/worktree" },
		acknowledgedAt: "2026-07-16T00:05:00.000Z",
	});
	assert.equal(acknowledgement?.terminal.terminalId, "term-1");
	assert.equal(acknowledgement?.workspace?.kind, "path");
	assert.equal(parseTerminalLocationAcknowledgement({ schemaVersion: 2 }), undefined);
});
