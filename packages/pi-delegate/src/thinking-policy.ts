import { randomUUID } from "node:crypto";

import {
	createEventBus,
	type EventBusController,
	type ExtensionFactory,
	type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import type { AgentConfig } from "./agents.js";
import { extensionSelectorAliases, normalizeExtensionIdentity } from "./tool-surface.js";

import { normalizeThinkingFields, type ThinkingLevel } from "./thinking-fields.js";
export { THINKING_LEVELS, isThinkingLevel, normalizeThinkingFields, type ThinkingLevel, type NormalizedThinkingFields } from "./thinking-fields.js";

export const THINKING_POLICY_PROTOCOL_VERSION = 1 as const;
export const THINKING_POLICY_ENTRY_TYPE = "pi-delegate-thinking-policy";
export const ADAPTIVE_THINKING_POLICY_CHANNEL = "pi-delegate:adaptive-thinking-policy";
export const ADAPTIVE_THINKING_POLICY_ACK_CHANNEL = "adaptive-thinking:pi-delegate-policy-accepted";
export const DETACHED_THINKING_POLICY_ENV = "PI_DELEGATE_THINKING_POLICY_V1";

export interface SessionThinkingPolicy {
	protocolVersion: typeof THINKING_POLICY_PROTOCOL_VERSION;
	policyId: string;
	agentName: string;
	baseline?: ThinkingLevel;
	minLevel?: ThinkingLevel;
	maxLevel?: ThinkingLevel;
}

/** Parent-preflight facts the authoritative detached Pi child must reverify. */
export interface DetachedThinkingPolicyRequirements {
	requireProvider: boolean;
	requireTool: boolean;
	/** All stable aliases for the provider selected during parent preflight. */
	expectedProviderIdentities?: string[];
	/** The exact adaptive-thinking tool selected during parent preflight. */
	expectedToolName?: string;
}

export interface DetachedThinkingPolicyEnvelope extends SessionThinkingPolicy {
	detachedRequirements?: DetachedThinkingPolicyRequirements;
}

interface ThinkingPolicyAck {
	protocolVersion: number;
	policyId: string;
	extension?: unknown;
}

export interface WorkerThinkingPolicyContext {
	policy: SessionThinkingPolicy;
	eventBus: EventBusController;
	extensionFactory: ExtensionFactory;
	/** Validate the loaded provider and return whether adaptive-thinking is present. */
	assertCompatible(extensionsResult: LoadExtensionsResult): boolean;
}

/** Return the session policy only when at least one adaptive bound is set. */
export function resolveAgentThinkingPolicy(agent: Pick<AgentConfig, "name" | "thinking" | "thinkingMin" | "thinkingMax">):
	| Omit<SessionThinkingPolicy, "protocolVersion" | "policyId" | "agentName">
	| undefined {
	const normalized = normalizeThinkingFields(agent);
	if (normalized.thinkingMin === undefined && normalized.thinkingMax === undefined) return undefined;
	return {
		...(normalized.thinking !== undefined ? { baseline: normalized.thinking } : {}),
		...(normalized.thinkingMin !== undefined ? { minLevel: normalized.thinkingMin } : {}),
		...(normalized.thinkingMax !== undefined ? { maxLevel: normalized.thinkingMax } : {}),
	};
}

function isMatchingAck(value: unknown, policyId: string): value is ThinkingPolicyAck {
	if (!value || typeof value !== "object") return false;
	const ack = value as Partial<ThinkingPolicyAck>;
	return ack.protocolVersion === THINKING_POLICY_PROTOCOL_VERSION && ack.policyId === policyId;
}

/**
 * Build the per-worker transport for adaptive-thinking. The transport is
 * deliberately session-local: a fresh event bus and versioned session entry
 * belong to exactly one worker. No environment variable, settings object, or
 * `~/.pi/agent/adaptive-thinking.json` mutation is involved.
 *
 * A compatible adaptive-thinking extension subscribes to
 * `ADAPTIVE_THINKING_POLICY_CHANNEL` during extension load, applies the policy
 * to its closure-local state, and emits the ACK channel. Older versions that
 * register `set_thinking_effort` but do not ACK are rejected before the worker
 * session starts, preventing silent fallback to global bounds.
 */
export function createWorkerThinkingPolicyContext(
	agent: Pick<AgentConfig, "name" | "thinking" | "thinkingMin" | "thinkingMax">,
	eventBus: EventBusController = createEventBus(),
): WorkerThinkingPolicyContext | undefined {
	const resolved = resolveAgentThinkingPolicy(agent);
	if (!resolved) return undefined;

	const policy: SessionThinkingPolicy = {
		protocolVersion: THINKING_POLICY_PROTOCOL_VERSION,
		policyId: randomUUID(),
		agentName: agent.name,
		...resolved,
	};
	const acknowledgements: ThinkingPolicyAck[] = [];
	eventBus.on(ADAPTIVE_THINKING_POLICY_ACK_CHANNEL, (value) => {
		if (!isMatchingAck(value, policy.policyId)) return;
		acknowledgements.push(value as ThinkingPolicyAck);
	});

	const extensionFactory: ExtensionFactory = (pi) => {
		pi.events.emit(ADAPTIVE_THINKING_POLICY_CHANNEL, policy);
		// Consumer extensions load before this inline factory, so this handler
		// runs after their session_start handlers and preserves the agent's
		// declared initial level even if an older global baseline was reapplied.
		pi.on("session_start", () => {
			if (policy.baseline && pi.getThinkingLevel() !== policy.baseline) {
				pi.setThinkingLevel(policy.baseline);
			}
		});
	};

	return {
		policy,
		eventBus,
		extensionFactory,
		assertCompatible(extensionsResult) {
			const adaptiveToolOwners = extensionsResult.extensions.filter((extension) =>
				extension.tools.has("set_thinking_effort")
			);
			if (adaptiveToolOwners.length === 0) return false;
			if (adaptiveToolOwners.length > 1) {
				throw new Error(
					`Agent ${JSON.stringify(agent.name)} loads multiple set_thinking_effort providers (${adaptiveToolOwners
						.map((extension) => extension.path)
						.join(", ")}); bounded adaptive-thinking requires exactly one session-local policy owner.`,
				);
			}
			const owner = adaptiveToolOwners[0]!;
			const ownerAliases = extensionSelectorAliases(owner);
			const matchingAck = acknowledgements.find((ack) =>
				typeof ack.extension === "string" &&
				ownerAliases.has(normalizeExtensionIdentity(ack.extension)),
			);
			if (matchingAck) return true;
			const owners = adaptiveToolOwners.map((extension) => extension.path).join(", ");
			if (acknowledgements.length > 0) {
				const received = acknowledgements
					.map((ack) => typeof ack.extension === "string" && ack.extension.trim() ? ack.extension : "(missing)")
					.join(", ");
				throw new Error(
					`Agent ${JSON.stringify(agent.name)} received a thinking-policy protocol ACK from ${received}, ` +
						`but the unique set_thinking_effort provider is ${owner.path}. ` +
						"The ACK must carry the provider's canonical extension identity.",
				);
			}
			throw new Error(
				`Agent ${JSON.stringify(agent.name)} declares session-local adaptive-thinking bounds, but the loaded ` +
				`set_thinking_effort provider did not acknowledge pi-delegate thinking-policy protocol v${THINKING_POLICY_PROTOCOL_VERSION}. ` +
				`Upgrade adaptive-thinking to a version with session-local policy support (loaded from: ${owners}). ` +
				`pi-delegate will not silently apply global adaptive-thinking bounds.`,
			);
		},
	};
}
