import test from "node:test";
import assert from "node:assert/strict";
import {
	supportsContextAwareCondensedSkillsV1,
	supportsContextAwareFoldHintsV1,
	supportsContextAwareModesV1,
	supportsContextAwareModeInstanceIdsV1,
	supportsContextAwareModeLayersV1,
	supportsContextAwareModeToolPoliciesV1,
	supportsContextAwareModeUiV1,
	type ContextAwareModeResultV1,
	type ContextAwareModesV1,
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

// Each fixture has the flag and exactly one of the two methods, so each check is
// the only one that can refuse it.
test("the layers guard refuses a service with setTrail but no layers", () => {
	const noLayers = { protocolVersion: 1, modes: { ...baseModes, layered: true, setTrail: () => ({ status: "ok" }) } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeLayersV1(noLayers), false);
});

test("the layers guard refuses a service with layers but no setTrail", () => {
	const noSetTrail = { protocolVersion: 1, modes: { ...baseModes, layered: true, layers: () => [] } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeLayersV1(noSetTrail), false);
});

test("the condensed-skills guard refuses a service with endOwner but no register", () => {
	const noRegister = { protocolVersion: 1, skills: { loaded: () => [], condensed: true, endOwner: () => true } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(noRegister), false);
});

test("the condensed-skills guard refuses a service with register but no endOwner", () => {
	const noEndOwner = { protocolVersion: 1, skills: { loaded: () => [], condensed: true, register: () => ({ status: "ok" }) } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(noEndOwner), false);
});

// Each guard below accepts a service that lacks the member on the
// `@ts-expect-error` line, so its predicate must not claim that member. A guard
// widened to claim it makes the directive unused, and this file stops compiling.
test("a guard's predicate claims no member that its runtime check does not read", () => {
	const bare: ContextAwareServiceV1 = { protocolVersion: 1, modes: { ...baseModes } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareModesV1(bare)) return assert.fail("the base modes capability is complete");
	// @ts-expect-error the base guard does not read `layered`
	const baseLayered: true = bare.modes.layered;
	// @ts-expect-error the base guard does not read `layers`
	const baseLayers: () => unknown = bare.modes.layers;

	const instanceIds = { protocolVersion: 1, modes: { ...baseModes, instanceIds: true } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareModeInstanceIdsV1(instanceIds)) return assert.fail("instanceIds is set");
	// @ts-expect-error the instance-id guard does not read `toolPolicies`
	const instanceToolPolicies: true = instanceIds.modes.toolPolicies;

	const toolPolicies = { protocolVersion: 1, modes: { ...baseModes, toolPolicies: true } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareModeToolPoliciesV1(toolPolicies)) return assert.fail("toolPolicies is set");
	// @ts-expect-error the tool-policy guard does not read `ui`
	const policyUi: true = toolPolicies.modes.ui;

	const ui = { protocolVersion: 1, modes: { ...baseModes, ui: true } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareModeUiV1(ui)) return assert.fail("ui is set");
	// @ts-expect-error the ui guard does not read `instanceIds`
	const uiInstanceIds: true = ui.modes.instanceIds;
	// @ts-expect-error the ui guard does not read `setTrail`
	const uiSetTrail: (text: string | undefined) => ContextAwareModeResultV1 = ui.modes.setTrail;

	const layers: ContextAwareServiceV1 = layered;
	if (!supportsContextAwareModeLayersV1(layers)) return assert.fail("the layers capability is complete");
	// @ts-expect-error the layers guard does not read `ui`
	const layersUi: true = layers.modes.ui;

	const skills = { protocolVersion: 1, skills: { loaded: () => [], condensed: true, register: () => ({ status: "ok" }), endOwner: () => true } } as unknown as ContextAwareServiceV1;
	if (!supportsContextAwareCondensedSkillsV1(skills)) return assert.fail("the condensed capability is complete");
	// @ts-expect-error the condensed-skills guard does not read `modes`
	const skillsModes: ContextAwareModesV1 = skills.modes;

	// Every guard passed although none of these members exists.
	assert.deepEqual(
		[baseLayered, baseLayers, instanceToolPolicies, policyUi, uiInstanceIds, uiSetTrail, layersUi, skillsModes],
		[undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
	);
});

// Each fixture below has every member its guard reads except the one under
// test, so only that check can refuse it. Removing the check turns a test red.
const noop = () => {};
const modeFn = (drop: "defineMode" | "current" | "setSuggestionConfirmer") => {
	const modes: Record<string, unknown> = { ...baseModes };
	delete modes[drop];
	return { protocolVersion: 1, modes } as unknown as ContextAwareServiceV1;
};

test("the base modes guard refuses a service missing exactly one required method", () => {
	assert.equal(supportsContextAwareModesV1(modeFn("defineMode")), false);
	assert.equal(supportsContextAwareModesV1(modeFn("current")), false);
	assert.equal(supportsContextAwareModesV1(modeFn("setSuggestionConfirmer")), false);
	assert.equal(supportsContextAwareModesV1({ protocolVersion: 1 } as unknown as ContextAwareServiceV1), false);
	assert.equal(supportsContextAwareModesV1({ protocolVersion: 1, modes: baseModes } as unknown as ContextAwareServiceV1), true);
});

test("the instanceIds, toolPolicies and ui guards refuse a missing or false flag", () => {
	const guards = [
		["instanceIds", supportsContextAwareModeInstanceIdsV1],
		["toolPolicies", supportsContextAwareModeToolPoliciesV1],
		["ui", supportsContextAwareModeUiV1],
	] as const;
	for (const [flag, guard] of guards) {
		const missing = { protocolVersion: 1, modes: { ...baseModes } } as unknown as ContextAwareServiceV1;
		const off = { protocolVersion: 1, modes: { ...baseModes, [flag]: false } } as unknown as ContextAwareServiceV1;
		const on = { protocolVersion: 1, modes: { ...baseModes, [flag]: true } } as unknown as ContextAwareServiceV1;
		assert.equal(guard(missing), false, `${flag} missing`);
		assert.equal(guard(off), false, `${flag} false`);
		assert.equal(guard(on), true, `${flag} true`);
	}
});

test("the layers guard refuses layers and setTrail without the layered flag", () => {
	const noFlag = { protocolVersion: 1, modes: { ...baseModes, layers: () => [], setTrail: noop } } as unknown as ContextAwareServiceV1;
	const off = { protocolVersion: 1, modes: { ...baseModes, layered: false, layers: () => [], setTrail: noop } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareModeLayersV1(noFlag), false);
	assert.equal(supportsContextAwareModeLayersV1(off), false);
});

test("the condensed-skills guard refuses loaded, register and endOwner without the condensed flag", () => {
	const noFlag = { protocolVersion: 1, skills: { loaded: () => [], register: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	const off = { protocolVersion: 1, skills: { loaded: () => [], condensed: false, register: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	const noLoaded = { protocolVersion: 1, skills: { condensed: true, register: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareCondensedSkillsV1(noFlag), false);
	assert.equal(supportsContextAwareCondensedSkillsV1(off), false);
	assert.equal(supportsContextAwareCondensedSkillsV1(noLoaded), false);
});

test("the fold-hints guard refuses registerHint and endOwner without the hints flag", () => {
	const noFlag = { protocolVersion: 1, folds: { registerHint: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	const off = { protocolVersion: 1, folds: { hints: false, registerHint: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	const on = { protocolVersion: 1, folds: { hints: true, registerHint: noop, endOwner: noop } } as unknown as ContextAwareServiceV1;
	assert.equal(supportsContextAwareFoldHintsV1(noFlag), false);
	assert.equal(supportsContextAwareFoldHintsV1(off), false);
	assert.equal(supportsContextAwareFoldHintsV1(on), true);
});
