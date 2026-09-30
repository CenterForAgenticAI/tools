import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
	ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL,
	ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL,
	ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL,
	createAdaptiveThinkingSnapshot,
} from "../integration-seam.js";
import { defaultState, type ResolvedConfig, type RuntimeThinkingLevel } from "../logic.js";

const config: ResolvedConfig = {
	baseline: "medium",
	enabled: true,
	minLevel: "low",
	maxLevel: "xhigh",
};

describe("adaptive-thinking foreground snapshot protocol v1", () => {
	test("uses stable versioned event-bus channels", () => {
		assert.equal(ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION, 1);
		assert.equal(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, "adaptive-thinking:snapshot:request:v1");
		assert.equal(ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL, "adaptive-thinking:snapshot:response:v1");
		assert.equal(ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL, "adaptive-thinking:snapshot:changed:v1");
	});

	test("describes baseline state without exposing mutable extension state", () => {
		const state = defaultState(config);
		const snapshot = createAdaptiveThinkingSnapshot({
			state,
			config,
			effective: "medium",
			source: "baseline",
			model: undefined,
		});

		assert.deepEqual(snapshot, {
			protocolVersion: 1,
			controlScope: "current-session",
			enabled: true,
			baseline: "medium",
			min: "low",
			max: "xhigh",
			effective: "medium",
			source: "baseline",
			scope: null,
			turnsRemaining: null,
			model: null,
			modelSupportedLevels: [],
			modelAgentSelectableLevels: [],
		});

		(snapshot.modelSupportedLevels as RuntimeThinkingLevel[]).push("off");
		assert.deepEqual(state, defaultState(config));
	});

	test("reports override lifecycle and source explicitly", () => {
		const state = {
			...defaultState(config),
			override: "high" as const,
			scope: "next_N" as const,
			turnsRemaining: 3,
			reason: "multi-file review",
		};
		const snapshot = createAdaptiveThinkingSnapshot({
			state,
			config,
			effective: "high",
			source: "agent",
			model: undefined,
		});

		assert.equal(snapshot.effective, "high");
		assert.equal(snapshot.source, "agent");
		assert.equal(snapshot.scope, "next_N");
		assert.equal(snapshot.turnsRemaining, 3);
	});

	test("reports runtime capabilities and adjacent agent-selectable capabilities", () => {
		const snapshot = createAdaptiveThinkingSnapshot({
			state: defaultState(config),
			config,
			effective: "minimal",
			source: "baseline",
			model: {
				provider: "anthropic",
				id: "adaptive-model",
				reasoning: true,
				compat: { forceAdaptiveThinking: true },
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			} as never,
		});

		assert.deepEqual(snapshot.model, { provider: "anthropic", id: "adaptive-model" });
		assert.deepEqual(snapshot.modelSupportedLevels, ["minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(snapshot.modelAgentSelectableLevels, ["low", "medium", "high", "xhigh"]);
	});

	test("reports max as agent-selectable only when configured bounds explicitly permit it", () => {
		const maxConfig: ResolvedConfig = { ...config, maxLevel: "max" };
		const snapshot = createAdaptiveThinkingSnapshot({
			state: defaultState(maxConfig),
			config: maxConfig,
			effective: "medium",
			source: "baseline",
			model: {
				provider: "anthropic",
				id: "max-capable-model",
				reasoning: true,
				thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
			} as never,
		});

		assert.deepEqual(snapshot.modelSupportedLevels, ["minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepEqual(snapshot.modelAgentSelectableLevels, ["low", "medium", "high", "xhigh", "max"]);
	});

	test("follows Pi 0.83 capability semantics for a max-only thinking-level map", () => {
		const snapshot = createAdaptiveThinkingSnapshot({
			state: defaultState(config),
			config,
			effective: "medium",
			source: "baseline",
			model: {
				provider: "example",
				id: "pi-0.83-max-map",
				reasoning: true,
				thinkingLevelMap: { max: "max" },
			} as never,
		});

		assert.deepEqual(snapshot.modelSupportedLevels, ["off", "minimal", "low", "medium", "high", "max"]);
		assert.deepEqual(snapshot.modelAgentSelectableLevels, ["low", "medium", "high"]);
	});

	test("reports model capability but no agent-selectable levels while dynamic adjustment is disabled", () => {
		const disabledConfig: ResolvedConfig = { ...config, enabled: false, maxLevel: "max" };
		const snapshot = createAdaptiveThinkingSnapshot({
			state: defaultState(disabledConfig),
			config: disabledConfig,
			effective: "medium",
			source: "baseline",
			model: {
				provider: "example",
				id: "disabled-agent-control",
				reasoning: true,
				thinkingLevelMap: { max: "max" },
			} as never,
		});

		assert.ok(snapshot.modelSupportedLevels.includes("max"));
		assert.deepEqual(snapshot.modelAgentSelectableLevels, []);
	});

	test("reports only off for a non-reasoning model", () => {
		const snapshot = createAdaptiveThinkingSnapshot({
			state: defaultState(config),
			config,
			effective: "off",
			source: "user",
			model: {
				provider: "example",
				id: "plain-model",
				reasoning: false,
			} as never,
		});

		assert.deepEqual(snapshot.modelSupportedLevels, ["off"]);
		assert.deepEqual(snapshot.modelAgentSelectableLevels, []);
	});
});
