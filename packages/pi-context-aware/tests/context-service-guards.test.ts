import test from "node:test";
import assert from "node:assert/strict";
import {
	supportsContextAwareCondensedSkillsV1,
	supportsContextAwareModeInstanceIdsV1,
	supportsContextAwareModeLayersV1,
	supportsContextAwareModeToolPoliciesV1,
	supportsContextAwareModeUiV1,
	type ContextAwareModeResultV1,
	type ContextAwareModeSnapshotV1,
	type ContextAwareServiceV1,
} from "../src/context-service.js";

// These tests are checked by the compiler as well as run: each guard must narrow
// the service so the capability it reports can be used without a cast or `?.`.
// A guard that returns plain `boolean` makes this file fail to compile.

const baseModes = { defineMode: () => ({ status: "refused" as const, code: "INVALID_REQUEST" as const, message: "" }), current: () => null, setSuggestionConfirmer: () => {} };
const trail: string[] = [];
const layered = {
	protocolVersion: 1,
	modes: { ...baseModes, layered: true, layers: () => [], setTrail: (text: string | undefined) => { trail.push(String(text)); return { status: "ok" }; } },
} as unknown as ContextAwareServiceV1;

test("supportsContextAwareModeLayersV1 narrows the service so layers and setTrail are callable", () => {
	const service: ContextAwareServiceV1 | undefined = layered;
	assert.equal(supportsContextAwareModeLayersV1(service), true);
	if (!supportsContextAwareModeLayersV1(service)) return assert.fail("the guard accepted the service above");
	const flag: true = service.modes.layered;
	const snapshots: readonly ContextAwareModeSnapshotV1[] = service.modes.layers();
	const result: ContextAwareModeResultV1 = service.modes.setTrail("plan › build");
	assert.deepEqual([flag, snapshots, result, trail], [true, [], { status: "ok" }, ["plan › build"]]);
});

test("the other capability-flag guards narrow their flag to true", () => {
	const modes = { protocolVersion: 1, modes: { ...baseModes, instanceIds: true, toolPolicies: true, ui: true } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareModeInstanceIdsV1(modes) || !supportsContextAwareModeToolPoliciesV1(modes) || !supportsContextAwareModeUiV1(modes)) return assert.fail("every flag is set");
	const flags: [true, true, true] = [modes.modes.instanceIds, modes.modes.toolPolicies, modes.modes.ui];
	assert.deepEqual(flags, [true, true, true]);
	const ended: string[] = [];
	const skills = {
		protocolVersion: 1,
		skills: { loaded: () => [], condensed: true, register: () => ({ status: "ok" }), endOwner: (owner: string) => { ended.push(owner); return true; } },
	} as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareCondensedSkillsV1(skills)) return assert.fail("the condensed capability is complete");
	const condensed: true = skills.skills.condensed;
	const removed: boolean = skills.skills.endOwner("me");
	assert.deepEqual([condensed, removed, ended], [true, true, ["me"]]);
});

test("a guard refuses a service whose flag is set but whose methods are missing", () => {
	const flagOnly = { protocolVersion: 1, modes: { ...baseModes, layered: true } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeLayersV1(flagOnly), false);
	const skillsFlagOnly = { protocolVersion: 1, skills: { loaded: () => [], condensed: true } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(skillsFlagOnly), false);
	assert.equal(supportsContextAwareModeLayersV1(undefined), false);
});
