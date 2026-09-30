import {
	AGENT_LEVELS,
	clampLevel,
	CONFIGURABLE_LEVELS,
	isAgentLevel,
	type AgentThinkingLevel,
	type ConfigurableThinkingLevel,
	type ResolvedConfig,
	type OverrideScope,
} from "./logic.js";

/** Protocol v1 shared with pi-delegate's worker-local thinking transport. */
export const THINKING_POLICY_PROTOCOL_VERSION = 1 as const;
export const THINKING_POLICY_ENTRY_TYPE = "pi-delegate-thinking-policy";
export const ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE = "adaptive-thinking-env-policy";
export const ADAPTIVE_THINKING_POLICY_ENV = "PI_ADAPTIVE_THINKING_POLICY";
export const ADAPTIVE_THINKING_POLICY_CHANNEL = "pi-delegate:adaptive-thinking-policy";
export const ADAPTIVE_THINKING_POLICY_ACK_CHANNEL = "adaptive-thinking:pi-delegate-policy-accepted";
/** Stable provider identity used in protocol ACKs (not a filesystem path). */
export const ADAPTIVE_THINKING_EXTENSION_ID = "adaptive-thinking";

const levelIndex = (level: ConfigurableThinkingLevel): number => CONFIGURABLE_LEVELS.indexOf(level);

export interface SessionThinkingPolicy {
	protocolVersion: typeof THINKING_POLICY_PROTOCOL_VERSION;
	policyId: string;
	agentName: string;
	baseline?: ConfigurableThinkingLevel;
	minLevel?: ConfigurableThinkingLevel;
	maxLevel?: ConfigurableThinkingLevel;
}

export interface EnvironmentThinkingPolicy {
	version: typeof THINKING_POLICY_PROTOCOL_VERSION;
	thinkingMin?: ConfigurableThinkingLevel;
	thinkingMax?: ConfigurableThinkingLevel;
}

export interface RestoredThinkingState {
	baseline: ConfigurableThinkingLevel;
	override: AgentThinkingLevel | null;
	scope: OverrideScope | null;
	turnsRemaining: number | null;
	reason: string | null;
}

function normalizeLevel(value: unknown, field: string): ConfigurableThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${field} must be one of ${CONFIGURABLE_LEVELS.join(", ")}; got ${JSON.stringify(value)}`);
	}
	const normalized = value.trim().toLowerCase();
	if (!CONFIGURABLE_LEVELS.includes(normalized as ConfigurableThinkingLevel)) {
		throw new Error(`${field} has invalid level ${JSON.stringify(value)}; valid levels: ${CONFIGURABLE_LEVELS.join(", ")}`);
	}
	return normalized as ConfigurableThinkingLevel;
}

/** Validate and canonicalize a pi-delegate protocol-v1 policy payload. */
export function normalizeSessionThinkingPolicy(value: unknown): SessionThinkingPolicy {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid thinking policy: expected an object");
	}
	const parsed = value as Partial<SessionThinkingPolicy>;
	if (parsed.protocolVersion !== THINKING_POLICY_PROTOCOL_VERSION) {
		throw new Error(`Invalid thinking policy protocol version: expected ${THINKING_POLICY_PROTOCOL_VERSION}`);
	}
	if (typeof parsed.policyId !== "string" || !parsed.policyId.trim()) {
		throw new Error("Invalid thinking policy: policyId must be a non-empty string");
	}
	if (typeof parsed.agentName !== "string" || !parsed.agentName.trim()) {
		throw new Error("Invalid thinking policy: agentName must be a non-empty string");
	}

	const baseline = normalizeLevel(parsed.baseline, "baseline");
	const minLevel = normalizeLevel(parsed.minLevel, "minLevel");
	const maxLevel = normalizeLevel(parsed.maxLevel, "maxLevel");
	if (minLevel !== undefined && maxLevel !== undefined && levelIndex(minLevel) > levelIndex(maxLevel)) {
		throw new Error(`minLevel ${JSON.stringify(minLevel)} must not exceed maxLevel ${JSON.stringify(maxLevel)}`);
	}
	if (baseline !== undefined && minLevel !== undefined && levelIndex(baseline) < levelIndex(minLevel)) {
		throw new Error(`baseline ${JSON.stringify(baseline)} is outside the declared range ${minLevel}–${maxLevel ?? "xhigh"}`);
	}
	if (baseline !== undefined && maxLevel !== undefined && levelIndex(baseline) > levelIndex(maxLevel)) {
		throw new Error(`baseline ${JSON.stringify(baseline)} is outside the declared range ${minLevel ?? "off"}–${maxLevel}`);
	}

	return {
		protocolVersion: THINKING_POLICY_PROTOCOL_VERSION,
		policyId: parsed.policyId,
		agentName: parsed.agentName,
		...(baseline !== undefined ? { baseline } : {}),
		...(minLevel !== undefined ? { minLevel } : {}),
		...(maxLevel !== undefined ? { maxLevel } : {}),
	};
}

/** Validate and canonicalize the inherited environment transport payload. */
export function normalizeEnvironmentThinkingPolicy(value: unknown): EnvironmentThinkingPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected a JSON object");
	}
	const parsed = value as Partial<EnvironmentThinkingPolicy>;
	if (parsed.version !== THINKING_POLICY_PROTOCOL_VERSION) {
		throw new Error(`invalid version: expected ${THINKING_POLICY_PROTOCOL_VERSION}`);
	}
	const thinkingMin = normalizeLevel(parsed.thinkingMin, "thinkingMin");
	const thinkingMax = normalizeLevel(parsed.thinkingMax, "thinkingMax");
	if (thinkingMin !== undefined && thinkingMax !== undefined && levelIndex(thinkingMin) > levelIndex(thinkingMax)) {
		throw new Error(`thinkingMin ${JSON.stringify(thinkingMin)} must not exceed thinkingMax ${JSON.stringify(thinkingMax)}`);
	}
	return {
		version: THINKING_POLICY_PROTOCOL_VERSION,
		...(thinkingMin !== undefined ? { thinkingMin } : {}),
		...(thinkingMax !== undefined ? { thinkingMax } : {}),
	};
}

export function environmentPolicyFromConfig(cfg: ResolvedConfig): EnvironmentThinkingPolicy {
	return {
		version: THINKING_POLICY_PROTOCOL_VERSION,
		thinkingMin: cfg.minLevel,
		thinkingMax: cfg.maxLevel,
	};
}

export function environmentPolicyAsSessionPolicy(policy: EnvironmentThinkingPolicy): SessionThinkingPolicy {
	return {
		protocolVersion: THINKING_POLICY_PROTOCOL_VERSION,
		policyId: "environment",
		agentName: "environment",
		...(policy.thinkingMin !== undefined ? { minLevel: policy.thinkingMin } : {}),
		...(policy.thinkingMax !== undefined ? { maxLevel: policy.thinkingMax } : {}),
	};
}

export function intersectEnvironmentThinkingPolicies(
	policies: readonly EnvironmentThinkingPolicy[],
): EnvironmentThinkingPolicy | undefined {
	if (policies.length === 0) return undefined;
	let thinkingMin: ConfigurableThinkingLevel | undefined;
	let thinkingMax: ConfigurableThinkingLevel | undefined;
	for (const policy of policies) {
		if (policy.thinkingMin !== undefined && (thinkingMin === undefined || levelIndex(policy.thinkingMin) > levelIndex(thinkingMin))) {
			thinkingMin = policy.thinkingMin;
		}
		if (policy.thinkingMax !== undefined && (thinkingMax === undefined || levelIndex(policy.thinkingMax) < levelIndex(thinkingMax))) {
			thinkingMax = policy.thinkingMax;
		}
	}
	if (thinkingMin !== undefined && thinkingMax !== undefined && levelIndex(thinkingMin) > levelIndex(thinkingMax)) {
		throw new Error(`Environment thinking policies are incompatible: ${thinkingMin} exceeds ${thinkingMax}`);
	}
	return {
		version: THINKING_POLICY_PROTOCOL_VERSION,
		...(thinkingMin !== undefined ? { thinkingMin } : {}),
		...(thinkingMax !== undefined ? { thinkingMax } : {}),
	};
}

/** Recover the newest matching environment policy; malformed metadata fails closed. */
export function findEnvironmentThinkingPolicy(entries: readonly unknown[]): EnvironmentThinkingPolicy | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE) continue;
		try {
			return normalizeEnvironmentThinkingPolicy(candidate.data);
		} catch (error) {
			throw new Error(
				`Invalid persisted ${ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE} entry: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return undefined;
}

/** Recover the newest matching policy entry; malformed matching metadata fails closed. */
export function findSessionThinkingPolicy(entries: readonly unknown[]): SessionThinkingPolicy | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== THINKING_POLICY_ENTRY_TYPE) continue;
		try {
			return normalizeSessionThinkingPolicy(candidate.data);
		} catch (error) {
			throw new Error(
				`Invalid persisted ${THINKING_POLICY_ENTRY_TYPE} entry: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return undefined;
}

/**
 * Validate worker restart state before it can influence a bounded session.
 * Ordinary foreground sessions retain their historical permissive restore
 * behavior; this stricter path is used only when a valid delegate policy is
 * active and therefore must fail closed on malformed matching metadata.
 */
export function normalizePersistedThinkingState(
	value: unknown,
	cfg: ResolvedConfig,
	authoritativeBaseline?: ConfigurableThinkingLevel,
): RestoredThinkingState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid persisted adaptive-thinking state: expected a record object");
	}
	const data = value as Record<string, unknown>;
	// Validate persisted input even when the delegate policy supplies the
	// authoritative baseline; corrupt matching metadata must still fail closed.
	const persistedBaseline = normalizeLevel(data.baseline, "persisted baseline");
	const restoredBaseline = authoritativeBaseline ?? persistedBaseline ?? cfg.baseline;
	const baseline = clampLevel(restoredBaseline, cfg);

	let restoredOverride: AgentThinkingLevel | null = null;
	if (data.override !== undefined && data.override !== null) {
		const normalized = normalizeLevel(data.override, "persisted override");
		if (!normalized || !isAgentLevel(normalized)) {
			throw new Error(
				`Invalid persisted adaptive-thinking state: override must be one of ${AGENT_LEVELS.join(", ")}`,
			);
		}
		restoredOverride = normalized;
	}

	const rawScope = data.scope;
	let scope: OverrideScope | null;
	if (rawScope === undefined || rawScope === null) {
		scope = null;
	} else if (rawScope === "this_response" || rawScope === "next_N" || rawScope === "until_changed") {
		scope = rawScope;
	} else {
		throw new Error(`Invalid persisted adaptive-thinking state: unknown scope ${JSON.stringify(rawScope)}`);
	}
	const rawTurns = data.turnsRemaining;
	const turnsRemaining = rawTurns === undefined || rawTurns === null ? null : rawTurns;
	if (restoredOverride === null && (scope !== null || turnsRemaining !== null)) {
		throw new Error("Invalid persisted adaptive-thinking state: scope/turn count requires an override");
	}
	if (restoredOverride !== null && scope === null) {
		throw new Error("Invalid persisted adaptive-thinking state: override requires a scope");
	}
	if (scope === "next_N") {
		if (!Number.isInteger(turnsRemaining) || (turnsRemaining as number) <= 0) {
			throw new Error("Invalid persisted adaptive-thinking state: next_N requires a positive integer turnsRemaining");
		}
	} else if (turnsRemaining !== null) {
		throw new Error("Invalid persisted adaptive-thinking state: turnsRemaining is only valid for next_N");
	}
	if (data.reason !== undefined && data.reason !== null && typeof data.reason !== "string") {
		throw new Error("Invalid persisted adaptive-thinking state: reason must be a string or null");
	}

	if (restoredOverride !== null) {
		const boundedOverride = clampLevel(restoredOverride, cfg);
		if (!isAgentLevel(boundedOverride)) {
			return { baseline, override: null, scope: null, turnsRemaining: null, reason: null };
		}
		return {
			baseline,
			override: boundedOverride,
			scope,
			turnsRemaining: turnsRemaining as number | null,
			reason: typeof data.reason === "string" ? data.reason : null,
		};
	}
	return { baseline, override: null, scope: null, turnsRemaining: null, reason: null };
}

/**
 * Merge a worker-local policy over the global fallback.
 *
 * The fallback must already be resolved. Protocol v1 carries explicit levels
 * only, and a delegated worker's authority is fixed by its caller: re-reading
 * a `model-min`/`model-max` sentinel per worker model would let the worker
 * widen past what the caller granted.
 */
export function sessionConfig(cfg: ResolvedConfig, policy: SessionThinkingPolicy | undefined): ResolvedConfig {
	if (!policy) return cfg;
	const minLevel =
		policy.minLevel !== undefined && levelIndex(policy.minLevel) > levelIndex(cfg.minLevel)
			? policy.minLevel
			: cfg.minLevel;
	const maxLevel =
		policy.maxLevel !== undefined && levelIndex(policy.maxLevel) < levelIndex(cfg.maxLevel)
			? policy.maxLevel
			: cfg.maxLevel;
	if (levelIndex(minLevel) > levelIndex(maxLevel)) {
		throw new Error(
			`Session thinking policy and global fallback bounds are incompatible: ${minLevel} exceeds ${maxLevel}`,
		);
	}
	const requestedBaseline = policy.baseline ?? cfg.baseline;
	const baselineIndex = levelIndex(requestedBaseline);
	const minIndex = levelIndex(minLevel);
	const maxIndex = levelIndex(maxLevel);
	if (policy.baseline !== undefined && (baselineIndex < minIndex || baselineIndex > maxIndex)) {
		throw new Error(
			`Session thinking policy explicit baseline ${policy.baseline} is outside the completed range ${minLevel}–${maxLevel}`,
		);
	}
	const baseline =
		baselineIndex < minIndex
			? minLevel
			: baselineIndex > maxIndex
				? maxLevel
				: requestedBaseline;
	return {
		...cfg,
		baseline,
		minLevel,
		maxLevel,
	};
}

export function policyAck(policyId: string): {
	protocolVersion: typeof THINKING_POLICY_PROTOCOL_VERSION;
	policyId: string;
	extension: typeof ADAPTIVE_THINKING_EXTENSION_ID;
} {
	return {
		protocolVersion: THINKING_POLICY_PROTOCOL_VERSION,
		policyId,
		extension: ADAPTIVE_THINKING_EXTENSION_ID,
	};
}
