import test from "node:test";
import assert from "node:assert/strict";
import {
	CONTEXT_AWARE_OWNERSHIP,
	FOCUS_SEED_CHANNEL,
	FOCUS_SEED_CONTRACT_VERSION,
	INTERCOM_CONTRACT_VERSION,
	WORKTREE_LAUNCHER_CONTRACT_VERSION,
	isHandoffExpired,
	parseFocusSeed,
	parseIntercomMetadata,
	parseTerminalLocationAcknowledgement,
	parseWorktreeHandoff,
	type FocusSeed,
	type IntercomMetadata,
	type WorktreeHandoff,
} from "../peer-contracts.js";

const intercom: IntercomMetadata = {
	schemaVersion: INTERCOM_CONTRACT_VERSION,
	workstreamId: "ws-1",
	piSessionId: "pi-1",
	objective: "Ship contracts",
	status: "active",
	refs: [{ kind: "graft-spec", value: "0001" }],
	relevance: { score: 0.8, reason: "same graft spec" },
};

const handoff: WorktreeHandoff = {
	schemaVersion: WORKTREE_LAUNCHER_CONTRACT_VERSION,
	handoffId: "handoff-1",
	workstreamId: "ws-1",
	parentPiSessionId: "pi-1",
	objective: "Ship contracts",
	status: "active",
	requestedLocation: { kind: "branch", value: "feature/contracts" },
	expiresAt: "2026-07-16T00:10:00.000Z",
};

test("peer metadata is additive, optional, and rejects unsupported or malformed versions", () => {
	assert.deepEqual(parseIntercomMetadata({ ...intercom, futureField: { ignored: true } }), intercom);
	assert.equal(parseIntercomMetadata(undefined), undefined);
	assert.equal(parseIntercomMetadata({ ...intercom, schemaVersion: 2 }), undefined);
	assert.equal(parseIntercomMetadata({ ...intercom, relevance: { score: 2, reason: "bad" } }), undefined);
	assert.deepEqual(parseWorktreeHandoff({ ...handoff, optionalLocation: { kind: "tmux" } }), handoff);
	assert.equal(parseWorktreeHandoff({ ...handoff, expiresAt: "not-a-date" }), undefined);
});

const focusSeed: FocusSeed = {
	schemaVersion: FOCUS_SEED_CONTRACT_VERSION,
	objective: "Continue the delegated objective",
	boundaries: ["Keep the transcript authoritative"],
	refs: [{ kind: "gitlab-mr", value: "!48" }],
	host: "pi-delegate",
	parentPiSessionId: "pi-parent",
};

test("focus seed publishes the pinned channel and ignores additive fields", () => {
	assert.equal(FOCUS_SEED_CHANNEL, "context-aware.focus-seed.v1");
	assert.deepEqual(parseFocusSeed({ ...focusSeed, futureField: { ignored: true }, newerBoundaryMetadata: ["ignored"] }), focusSeed);
	assert.equal(parseFocusSeed(undefined), undefined);
	assert.equal(parseFocusSeed({ ...focusSeed, schemaVersion: 2 }), undefined);
	assert.equal(parseFocusSeed({ ...focusSeed, refs: [{ kind: "unknown", value: "bad" }] }), undefined);
});

test("focus seed rejects each mirrored snapshot bound in isolation", () => {
	const rejected = [
		{ ...focusSeed, objective: "" },
		{ ...focusSeed, objective: "x".repeat(1_001) },
		{ ...focusSeed, boundaries: Array.from({ length: 51 }, () => "boundary") },
		{ ...focusSeed, boundaries: [""] },
		{ ...focusSeed, boundaries: ["x".repeat(513)] },
		{ ...focusSeed, host: "" },
		{ ...focusSeed, host: "x".repeat(257) },
		{ ...focusSeed, parentPiSessionId: "" },
		{ ...focusSeed, parentPiSessionId: "x".repeat(257) },
	] as const;
	for (const candidate of rejected) assert.equal(parseFocusSeed(candidate), undefined);
});

test("focus seed parser rejects malformed optional fields without throwing", () => {
	for (const candidate of [
		{ ...focusSeed, boundaries: null },
		{ ...focusSeed, refs: null },
		{ ...focusSeed, host: {} },
		{ ...focusSeed, parentPiSessionId: [] },
	]) {
		assert.doesNotThrow(() => parseFocusSeed(candidate));
		assert.equal(parseFocusSeed(candidate), undefined);
	}
});

test("ownership boundaries exclude routing, worktree lifecycle, and terminal launching", () => {
	assert.ok(CONTEXT_AWARE_OWNERSHIP.owns.some((item) => item.includes("peer metadata")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("routing")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("worktree")));
	assert.ok(CONTEXT_AWARE_OWNERSHIP.doesNotOwn.some((item) => item.includes("terminal process")));
});

test("worktree handoffs expire independently of peer availability", () => {
	assert.equal(isHandoffExpired(handoff, new Date("2026-07-16T00:09:59.000Z")), false);
	assert.equal(isHandoffExpired(handoff, new Date("2026-07-16T00:10:00.000Z")), true);
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
