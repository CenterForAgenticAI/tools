import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	ADAPTIVE_THINKING_POLICY_ACK_CHANNEL,
	ADAPTIVE_THINKING_POLICY_CHANNEL,
	DETACHED_THINKING_POLICY_ENV,
	THINKING_POLICY_ENTRY_TYPE,
	THINKING_POLICY_PROTOCOL_VERSION,
	normalizeThinkingFields,
	type DetachedThinkingPolicyEnvelope,
	type DetachedThinkingPolicyRequirements,
	type SessionThinkingPolicy,
} from "./thinking-policy.js";
import { normalizeExtensionIdentity } from "./tool-surface.js";

interface ParsedDetachedPolicy {
	policy: SessionThinkingPolicy;
	requirements: DetachedThinkingPolicyRequirements;
}

interface ThinkingPolicyAck {
	protocolVersion?: unknown;
	policyId?: unknown;
	extension?: unknown;
}

/**
 * Process-local transport used only by detached orchestrate's `pi --mode rpc`
 * child. The parent runner places one already-validated policy plus the facts
 * its preflight observed in this child process's spawn environment and loads
 * this bridge after the consumer's adaptive-thinking extension. Nothing is
 * written to global settings or to the parent process environment.
 */
function readPolicy(): ParsedDetachedPolicy | undefined {
	const raw = process.env[DETACHED_THINKING_POLICY_ENV];
	if (!raw) return undefined;
	const parsed = JSON.parse(raw) as Partial<DetachedThinkingPolicyEnvelope>;
	if (
		parsed.protocolVersion !== THINKING_POLICY_PROTOCOL_VERSION ||
		typeof parsed.policyId !== "string" ||
		!parsed.policyId.trim() ||
		typeof parsed.agentName !== "string" ||
		!parsed.agentName.trim()
	) {
		throw new Error(
			`Invalid ${DETACHED_THINKING_POLICY_ENV} payload: expected pi-delegate thinking policy protocol v${THINKING_POLICY_PROTOCOL_VERSION}`,
		);
	}
	const normalized = normalizeThinkingFields({
		thinking: parsed.baseline,
		thinkingMin: parsed.minLevel,
		thinkingMax: parsed.maxLevel,
	});
	const rawRequirements = parsed.detachedRequirements;
	if (
		rawRequirements !== undefined &&
		(typeof rawRequirements !== "object" ||
			rawRequirements === null ||
			typeof rawRequirements.requireProvider !== "boolean" ||
			typeof rawRequirements.requireTool !== "boolean" ||
			(rawRequirements.requireTool && !rawRequirements.requireProvider))
	) {
		throw new Error(
			`Invalid ${DETACHED_THINKING_POLICY_ENV} payload: detachedRequirements must contain boolean requireProvider/requireTool and a required tool requires its provider`,
		);
	}
	return {
		policy: {
			protocolVersion: THINKING_POLICY_PROTOCOL_VERSION,
			policyId: parsed.policyId,
			agentName: parsed.agentName,
			...(normalized.thinking ? { baseline: normalized.thinking } : {}),
			...(normalized.thinkingMin ? { minLevel: normalized.thinkingMin } : {}),
			...(normalized.thinkingMax ? { maxLevel: normalized.thinkingMax } : {}),
		},
		requirements: rawRequirements ?? { requireProvider: false, requireTool: false },
	};
}

function matchesCanonicalAck(
	value: unknown,
	policyId: string,
	expectedProviderIdentities: readonly string[] | undefined,
): boolean {
	if (!value || typeof value !== "object") return false;
	const ack = value as ThinkingPolicyAck;
	if (
		ack.protocolVersion !== THINKING_POLICY_PROTOCOL_VERSION ||
		ack.policyId !== policyId ||
		typeof ack.extension !== "string"
	) {
		return false;
	}
	if (expectedProviderIdentities && expectedProviderIdentities.length > 0) {
		return expectedProviderIdentities.includes(normalizeExtensionIdentity(ack.extension as string));
	}
	return ack.extension === "adaptive-thinking";
}

export default function thinkingPolicyBridge(pi: ExtensionAPI): void {
	const parsed = readPolicy();
	if (!parsed) return;
	const { policy, requirements } = parsed;
	const acknowledgements: unknown[] = [];
	let compatibilityError: Error | undefined;
	const expectedProviderIdentities = requirements.expectedProviderIdentities?.map(normalizeExtensionIdentity);
	const expectedToolName = requirements.expectedToolName ?? "set_thinking_effort";
	const verifyCompatibility = (): void => {
		if (
			requirements.requireProvider &&
			!acknowledgements.some((ack) =>
				matchesCanonicalAck(ack, policy.policyId, expectedProviderIdentities),
			)
		) {
			throw new Error(
				`Detached thinking-policy protocol v${THINKING_POLICY_PROTOCOL_VERSION} did not receive a matching ACK from the expected adaptive-thinking provider in the authoritative Pi child`,
			);
		}
		if (!requirements.requireTool) return;
		if (!pi.getActiveTools().includes(expectedToolName)) {
			throw new Error(
				`Detached thinking-policy selected tool ${expectedToolName} is not active in the authoritative Pi child`,
			);
		}
		if (!expectedProviderIdentities || expectedProviderIdentities.length === 0) return;
		const owners = pi.getAllTools().filter((candidate) => candidate.name === expectedToolName);
		if (owners.length !== 1) {
			throw new Error(
				`Detached thinking-policy selected tool ${expectedToolName} does not have a unique authoritative child owner`,
			);
		}
		const toolIdentity = owners[0]?.sourceInfo?.path ?? owners[0]?.sourceInfo?.source;
		if (
			!toolIdentity ||
			!expectedProviderIdentities.includes(normalizeExtensionIdentity(toolIdentity))
		) {
			throw new Error(
				`Detached thinking-policy selected tool ${expectedToolName} is owned by an unexpected provider in the authoritative Pi child`,
			);
		}
	};

	// Register before delivery because protocol-v1 ACKs are synchronous.
	pi.events.on(ADAPTIVE_THINKING_POLICY_ACK_CHANNEL, (value) => {
		acknowledgements.push(value);
	});
	pi.events.emit(ADAPTIVE_THINKING_POLICY_CHANNEL, policy);

	pi.on("session_start", (_event, ctx) => {
		try {
			verifyCompatibility();

			const completedPolicyAlreadyPersisted = (ctx.sessionManager?.getEntries?.() ?? []).some((entry) => {
				if (entry.type !== "custom" || entry.customType !== THINKING_POLICY_ENTRY_TYPE) return false;
				const data = entry.data as Partial<SessionThinkingPolicy> | undefined;
				return data?.policyId === policy.policyId &&
					data.baseline !== undefined && data.minLevel !== undefined && data.maxLevel !== undefined;
			});
			if (!completedPolicyAlreadyPersisted) pi.appendEntry(THINKING_POLICY_ENTRY_TYPE, policy);
			// A compatible adaptive-thinking implementation preserves the worker's
			// declared baseline. Reassert it after all earlier consumer extension
			// session_start handlers as defense in depth against a global baseline.
			if (policy.baseline && pi.getThinkingLevel() !== policy.baseline) {
				pi.setThinkingLevel(policy.baseline);
			}
		} catch (error) {
			compatibilityError = error instanceof Error ? error : new Error(String(error));
			console.error(`[pi-delegate] ${compatibilityError.message}`);
			// Extension handler errors alone are non-fatal in Pi. Request shutdown
			// and pair it with the input gate below so no provider request can race.
			ctx.shutdown();
		}
	});

	pi.on("input", (_event, ctx) => {
		if (compatibilityError) return { action: "handled" as const };
		try {
			verifyCompatibility();
		} catch (error) {
			compatibilityError = error instanceof Error ? error : new Error(String(error));
			console.error(`[pi-delegate] ${compatibilityError.message}`);
			ctx.shutdown();
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});

}
