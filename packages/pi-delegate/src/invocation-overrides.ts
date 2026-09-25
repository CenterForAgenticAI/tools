import { copyOptionalGlobalToolEntries, type AgentConfig } from "./agents.js";
import { HARD_MAX_DEPTH, validateMaxSubagentDepth } from "./depth-guard.js";
import { mergeEnvOverrides, type EnvOverrides } from "./env-overrides.js";
import { normalizeTimeoutMs } from "./fork-timeout.js";
import { normalizeThinkingFields } from "./thinking-policy.js";

export type InvocationSkillOverride = string | string[] | false;

/**
 * High-frequency, invocation-scoped AgentConfig overrides accepted on
 * executable delegate slots. These are intentionally separate from durable
 * `delegate.agentOverrides`: they are never serialized and never mutate the
 * discovered/settings-overridden AgentConfig object.
 */
export type InvocationThinkingOverride = string | false;

export interface InvocationAgentOverrides {
	model?: string;
	env?: EnvOverrides;
	thinking?: InvocationThinkingOverride;
	thinkingMin?: InvocationThinkingOverride;
	thinkingMax?: InvocationThinkingOverride;
	fallbackModels?: string | string[];
	/** Public delegate slot spelling. */
	skill?: InvocationSkillOverride;
	/** Alias used by saved-chain/subagent-compatible shapes. */
	skills?: InvocationSkillOverride;
	/** Supervised-run absolute budget; 0 explicitly disables this layer. */
	maxDurationMs?: number;
	/** Supervised-run wind-down grace; 0 means immediate hard cancel. */
	windDownGraceMs?: number;
	/** Per-slot recursive delegation cap; bounded by the hard depth ceiling. */
	maxSubagentDepth?: number;
}

/** Clone an AgentConfig deeply enough that invocation patches cannot leak to siblings. */
function cloneAgentConfig(agent: AgentConfig): AgentConfig {
	return copyOptionalGlobalToolEntries(agent, {
		...agent,
		...(agent.tools ? { tools: [...agent.tools] } : {}),
		...(agent.skills ? { skills: [...agent.skills] } : {}),
		...(agent.fallbackModels ? { fallbackModels: [...agent.fallbackModels] } : {}),
		...(agent.mcpDirectTools ? { mcpDirectTools: [...agent.mcpDirectTools] } : {}),
		...(agent.extensions ? { extensions: [...agent.extensions] } : {}),
		...(agent.extensionInclude ? { extensionInclude: [...agent.extensionInclude] } : {}),
		...(agent.extensionExclude ? { extensionExclude: [...agent.extensionExclude] } : {}),
		...(agent.defaultReads ? { defaultReads: [...agent.defaultReads] } : {}),
		...(agent.env ? { env: { ...agent.env } } : {}),
		...(agent.extraFields ? { extraFields: { ...agent.extraFields } } : {}),
	});
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: string | string[]): string[] {
	const raw = Array.isArray(value) ? value : value.split(",");
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Apply invocation-scoped overrides to an already-effective AgentConfig.
 *
 * The input `agent` is typically the discovered config after durable
 * `delegate.agentOverrides` have been applied. This helper clones and patches
 * that effective config for one executable slot only. It does not touch the
 * discovered object, global config, durable overrides, or on-disk agent files.
 *
 * `skill:false` means "disable injected skills for this invocation": the
 * returned config has no explicit skills and `inheritSkills=false`, causing the
 * worker resource loader to use `noSkills` for this cloned config only.
 */
export function applyInvocationOverrides(
	agent: AgentConfig,
	overrides: InvocationAgentOverrides | undefined,
): AgentConfig {
	const next = cloneAgentConfig(agent);
	if (!overrides) {
		const normalized = normalizeThinkingFields(next);
		delete next.thinking;
		delete next.thinkingMin;
		delete next.thinkingMax;
		Object.assign(next, normalized);
		return next;
	}

	const model = normalizeString(overrides.model);
	if (model !== undefined) next.model = model;
	if (overrides.env !== undefined) next.env = mergeEnvOverrides(next.env, overrides.env);

	const resolveThinkingOverride = (current: string | undefined, value: InvocationThinkingOverride | undefined) => {
		if (value === false) return undefined;
		if (value !== undefined) return normalizeString(value);
		return current;
	};
	const thinking = resolveThinkingOverride(next.thinking, overrides.thinking);
	const thinkingMin = resolveThinkingOverride(next.thinkingMin, overrides.thinkingMin);
	const thinkingMax = resolveThinkingOverride(next.thinkingMax, overrides.thinkingMax);
	// Object.assign alone would leave a cleared field behind because the
	// normalizer intentionally omits undefined properties.
	delete next.thinking;
	delete next.thinkingMin;
	delete next.thinkingMax;
	Object.assign(next, normalizeThinkingFields({ thinking, thinkingMin, thinkingMax }));

	if (overrides.fallbackModels !== undefined) {
		next.fallbackModels = normalizeStringList(overrides.fallbackModels);
	}
	if (overrides.maxDurationMs !== undefined) {
		const duration = normalizeTimeoutMs(overrides.maxDurationMs);
		if (duration !== undefined) next.maxDurationMs = duration;
	}
	if (overrides.windDownGraceMs !== undefined) {
		const grace = normalizeTimeoutMs(overrides.windDownGraceMs);
		if (grace !== undefined) next.windDownGraceMs = grace;
	}
	if (overrides.maxSubagentDepth !== undefined) {
		next.maxSubagentDepth = Math.min(
			validateMaxSubagentDepth(overrides.maxSubagentDepth),
			HARD_MAX_DEPTH,
		);
	}

	const skillOverride = overrides.skill !== undefined ? overrides.skill : overrides.skills;
	if (skillOverride === false) {
		next.skills = undefined;
		next.inheritSkills = false;
	} else if (skillOverride !== undefined) {
		next.skills = normalizeStringList(skillOverride);
	}

	return next;
}
