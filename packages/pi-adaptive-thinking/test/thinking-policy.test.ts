import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	ADAPTIVE_THINKING_EXTENSION_ID,
	ADAPTIVE_THINKING_POLICY_ACK_CHANNEL,
	ADAPTIVE_THINKING_POLICY_CHANNEL,
	ADAPTIVE_THINKING_POLICY_ENV,
	ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE,
	THINKING_POLICY_ENTRY_TYPE,
	environmentPolicyAsSessionPolicy,
	environmentPolicyFromConfig,
	findEnvironmentThinkingPolicy,
	findSessionThinkingPolicy,
	intersectEnvironmentThinkingPolicies,
	normalizeEnvironmentThinkingPolicy,
	normalizePersistedThinkingState,
	normalizeSessionThinkingPolicy,
	policyAck,
	sessionConfig,
} from "../thinking-policy.js";

describe("adaptive-thinking session policy protocol v1", () => {
	it("uses the pi-delegate channel, entry, and canonical provider identity", () => {
		assert.equal(ADAPTIVE_THINKING_POLICY_CHANNEL, "pi-delegate:adaptive-thinking-policy");
		assert.equal(ADAPTIVE_THINKING_POLICY_ACK_CHANNEL, "adaptive-thinking:pi-delegate-policy-accepted");
		assert.equal(THINKING_POLICY_ENTRY_TYPE, "pi-delegate-thinking-policy");
		assert.equal(ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE, "adaptive-thinking-env-policy");
		assert.equal(ADAPTIVE_THINKING_POLICY_ENV, "PI_ADAPTIVE_THINKING_POLICY");
		assert.deepEqual(policyAck("p-1"), {
			protocolVersion: 1,
			policyId: "p-1",
			extension: ADAPTIVE_THINKING_EXTENSION_ID,
		});
	});

	it("normalizes a valid policy and preserves its identity", () => {
		assert.deepEqual(
			normalizeSessionThinkingPolicy({
				protocolVersion: 1,
				policyId: "policy-1",
				agentName: "worker",
				baseline: " HIGH ",
				minLevel: "medium",
				maxLevel: "xhigh",
			}),
			{
				protocolVersion: 1,
				policyId: "policy-1",
				agentName: "worker",
				baseline: "high",
				minLevel: "medium",
				maxLevel: "xhigh",
			},
		);
		assert.deepEqual(
			normalizeSessionThinkingPolicy({
				protocolVersion: 1,
				policyId: "max-authority",
				agentName: "worker",
				baseline: "max",
				minLevel: "xhigh",
				maxLevel: "max",
			}),
			{
				protocolVersion: 1,
				policyId: "max-authority",
				agentName: "worker",
				baseline: "max",
				minLevel: "xhigh",
				maxLevel: "max",
			},
		);
	});

	it("rejects malformed, inverted, and baseline-incompatible policies", () => {
		assert.throws(
			() => normalizeSessionThinkingPolicy({ protocolVersion: 2, policyId: "p", agentName: "worker" }),
			/protocol version/i,
		);
		assert.throws(
			() => normalizeSessionThinkingPolicy({ protocolVersion: 1, policyId: "", agentName: "worker" }),
			/policyId.*non-empty/i,
		);
		assert.throws(
			() => normalizeSessionThinkingPolicy({ protocolVersion: 1, policyId: "p", agentName: "worker", minLevel: "high", maxLevel: "medium" }),
			/minLevel.*high.*maxLevel.*medium/i,
		);
		assert.throws(
			() => normalizeSessionThinkingPolicy({ protocolVersion: 1, policyId: "p", agentName: "worker", baseline: "xhigh", maxLevel: "high" }),
			/baseline.*xhigh.*outside/i,
		);

		for (const malformed of [null, ""]) {
			assert.throws(
				() => normalizeSessionThinkingPolicy({
					protocolVersion: 1,
					policyId: "p",
					agentName: "worker",
					minLevel: malformed,
				}),
				/minLevel.*(?:must be|invalid level)/i,
			);
		}
	});

	it("normalizes, persists, and converts the environment transport with the protocol level validation", () => {
		const policy = normalizeEnvironmentThinkingPolicy({
			version: 1,
			thinkingMin: " MEDIUM ",
			thinkingMax: "HIGH",
		});
		assert.deepEqual(policy, { version: 1, thinkingMin: "medium", thinkingMax: "high" });
		assert.deepEqual(environmentPolicyAsSessionPolicy(policy), {
			protocolVersion: 1,
			policyId: "environment",
			agentName: "environment",
			minLevel: "medium",
			maxLevel: "high",
		});
		assert.deepEqual(
			environmentPolicyFromConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "high" }),
			{ version: 1, thinkingMin: "low", thinkingMax: "high" },
		);
		assert.deepEqual(
			intersectEnvironmentThinkingPolicies([
				{ version: 1, thinkingMin: "low", thinkingMax: "high" },
				{ version: 1, thinkingMin: "medium", thinkingMax: "xhigh" },
			]),
			{ version: 1, thinkingMin: "medium", thinkingMax: "high" },
		);
		assert.deepEqual(
			findEnvironmentThinkingPolicy([
				{ type: "custom", customType: ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE, data: policy },
			]),
			policy,
		);
		for (const malformed of [
			null,
			{ version: 2 },
			{ version: 1, thinkingMax: "turbo" },
			{ version: 1, thinkingMin: "high", thinkingMax: "medium" },
		]) {
			assert.throws(() => normalizeEnvironmentThinkingPolicy(malformed));
		}
		assert.throws(
			() => findEnvironmentThinkingPolicy([
				{ type: "custom", customType: ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE, data: { version: 1, thinkingMax: "turbo" } },
			]),
			/Invalid persisted adaptive-thinking-env-policy/,
		);
	});

	it("recovers the newest matching policy and rejects malformed matching metadata", () => {
		assert.deepEqual(
			findSessionThinkingPolicy([
				{ type: "custom", customType: THINKING_POLICY_ENTRY_TYPE, data: { protocolVersion: 1, policyId: "old", agentName: "old" } },
				{ type: "custom", customType: "unrelated", data: {} },
				{ type: "custom", customType: THINKING_POLICY_ENTRY_TYPE, data: { protocolVersion: 1, policyId: "new", agentName: "new", maxLevel: "high" } },
			]),
			{ protocolVersion: 1, policyId: "new", agentName: "new", maxLevel: "high" },
		);
		assert.throws(
			() => findSessionThinkingPolicy([{ type: "custom", customType: THINKING_POLICY_ENTRY_TYPE, data: { protocolVersion: 1, policyId: "bad", agentName: "worker", minLevel: "xhigh", maxLevel: "low" } }]),
			/invalid persisted pi-delegate-thinking-policy.*minLevel/i,
		);
	});

	it("intersects session bounds with configuration instead of letting a policy widen them", () => {
		const cfg = { baseline: "high", enabled: true, minLevel: "medium", maxLevel: "high" } as const;
		assert.deepEqual(
			sessionConfig(cfg, {
				protocolVersion: 1,
				policyId: "attempted-widening",
				agentName: "worker",
				minLevel: "low",
				maxLevel: "xhigh",
			}),
			cfg,
		);
	});

	it("clamps a global fallback baseline but rejects incompatible bounds or an explicit baseline outside them", () => {
		const cfg = { baseline: "xhigh", enabled: true, minLevel: "low", maxLevel: "xhigh" } as const;
		assert.deepEqual(
			sessionConfig(cfg, {
				protocolVersion: 1,
				policyId: "bounded",
				agentName: "worker",
				maxLevel: "high",
			}),
			{ ...cfg, baseline: "high", maxLevel: "high" },
		);
		assert.throws(
			() => sessionConfig(
				{ ...cfg, maxLevel: "medium" },
				{ protocolVersion: 1, policyId: "conflict", agentName: "worker", minLevel: "high" },
			),
			/incompatible.*high exceeds medium/i,
		);
		assert.throws(
			() => sessionConfig(
				{ ...cfg, baseline: "high", minLevel: "high" },
				{
					protocolVersion: 1,
					policyId: "explicit-baseline-conflict",
					agentName: "worker",
					baseline: "medium",
					maxLevel: "xhigh",
				},
			),
			/explicit baseline.*medium.*outside.*high.*xhigh/i,
		);
	});

	it("validates and bounds persisted worker state before restart", () => {
		const cfg = { baseline: "medium", enabled: true, minLevel: "medium", maxLevel: "high" } as const;
		assert.deepEqual(
			normalizePersistedThinkingState(
				{ baseline: "low", override: "xhigh", scope: "until_changed", turnsRemaining: null, reason: "old" },
				cfg,
			),
			{ baseline: "medium", override: "high", scope: "until_changed", turnsRemaining: null, reason: "old" },
		);
		assert.throws(
			() => normalizePersistedThinkingState(
				{ baseline: "medium", override: "high", scope: "next_N", turnsRemaining: 0 },
				cfg,
			),
			/next_N requires a positive integer/i,
		);
		assert.throws(
			() => normalizePersistedThinkingState(
				{ baseline: "medium", override: "turbo", scope: "until_changed" },
				cfg,
			),
			/persisted override.*invalid level/i,
		);
		assert.throws(
			() => normalizePersistedThinkingState(
				{ baseline: "medium", override: "minimal", scope: "until_changed" },
				cfg,
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal(
					error.message,
					"Invalid persisted adaptive-thinking state: override must be one of low, medium, high, xhigh, max",
				);
				return true;
			},
		);
		assert.throws(
			() => normalizePersistedThinkingState(
				{ baseline: "turbo", override: null, scope: null, turnsRemaining: null },
				cfg,
				"high",
			),
			/persisted baseline.*invalid level/i,
		);
		assert.throws(
			() => normalizePersistedThinkingState([], cfg),
			/expected a record object/i,
		);
		assert.deepEqual(
			normalizePersistedThinkingState(
				{ baseline: "medium", override: "max", scope: "until_changed", turnsRemaining: null, reason: "deep" },
				{ ...cfg, maxLevel: "xhigh" },
			),
			{ baseline: "medium", override: "xhigh", scope: "until_changed", turnsRemaining: null, reason: "deep" },
		);
		assert.deepEqual(
			normalizePersistedThinkingState(
				{ baseline: "medium", override: "max", scope: "until_changed", turnsRemaining: null, reason: "deep" },
				{ ...cfg, maxLevel: "max" },
			),
			{ baseline: "medium", override: "max", scope: "until_changed", turnsRemaining: null, reason: "deep" },
		);
	});
});
