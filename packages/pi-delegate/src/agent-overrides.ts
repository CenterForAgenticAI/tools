/**
 * Phase D: apply settings-level builtin filters and per-agent overrides
 * to a discovered agent list.
 *
 * Two operations, performed in order:
 *
 *   1. `disableBuiltins`: filter out every agent whose `source ===
 *      "builtin"` from the discovery result. Useful when an org wants
 *      its own user/project library to be the only canonical one.
 *
 *   2. `agentOverrides`: per-name patch applied AFTER the source filter.
 *      A `disabled: true` entry drops the agent entirely. All other
 *      fields merge onto the AgentConfig in place. Mirrors the
 *      pi-subagents `subagents.agentOverrides` shape.
 *
 * Pure function — no filesystem access, no logging side-effects beyond
 * the `Map`-based diagnostics returned alongside the filtered list.
 */

import {
	copyOptionalGlobalToolEntries,
	getOptionalGlobalToolEntries,
	setOptionalGlobalToolEntries,
	type AgentConfig,
} from "./agents.js";
import type { AgentOverride, DelegateConfig, GlobalToolWhitelistConfig } from "./config.js";
import { normalizeThinkingFields } from "./thinking-policy.js";
import { mergeEnvOverrides } from "./env-overrides.js";
import { canonicalExtensionSelectorKey, parseToolEntries } from "./tool-surface.js";

export interface ApplyOverridesResult {
	/** Agents that survived filtering, with overrides merged. */
	agents: AgentConfig[];
	/** Names of agents that were removed (either via disableBuiltins or `disabled: true`). */
	removed: string[];
	/** Override entries that didn't match any discovered agent — surfaced for diagnostics. */
	unmatched: string[];
}

/**
 * Apply builtin-disable + per-agent overrides. Order:
 *   1. Drop builtins if `disableBuiltins` is true.
 *   2. For each remaining agent, if `agentOverrides[agent.name]` exists:
 *      - `disabled: true` → drop.
 *      - Otherwise: merge fields onto a clone of the agent.
 *   3. Track which override keys matched at least one agent so callers
 *      can warn about typos.
 */
export function applyAgentOverrides(
	agents: AgentConfig[],
	config: DelegateConfig,
): ApplyOverridesResult {
	const removed: string[] = [];
	const filteredBySource = config.disableBuiltins
		? agents.filter((a) => {
				if (a.source === "builtin") {
					removed.push(a.name);
					return false;
				}
				return true;
			})
		: agents;

	const overrides = config.agentOverrides ?? {};
	const matchedOverrideKeys = new Set<string>();
	const out: AgentConfig[] = [];

	for (const agent of filteredBySource) {
		const ov = overrides[agent.name];
		const effectiveInheritSkills = ov?.inheritSkills ?? agent.inheritSkills;
		const withGlobalBaseline = applyGlobalBaseline(
			agent,
			config.globalToolWhitelist,
			effectiveInheritSkills,
		);
		if (!ov) {
			out.push(withGlobalBaseline);
			continue;
		}
		matchedOverrideKeys.add(agent.name);
		if (ov.disabled === true) {
			removed.push(agent.name);
			continue;
		}
		out.push(mergeOverride(withGlobalBaseline, ov, config.globalToolWhitelist));
	}

	const unmatched = Object.keys(overrides).filter((k) => !matchedOverrideKeys.has(k));
	return { agents: out, removed, unmatched };
}

const DEFAULT_WORKER_TOOLS = ["read", "bash", "edit", "write"] as const;

function dedupe(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function extensionSelectorKeys(entries: readonly string[]): Set<string> {
	return new Set(
		parseToolEntries(entries).extSelectors.map(canonicalExtensionSelectorKey),
	);
}

function withoutCanonicalExtensionSelectorDuplicates(
	globalEntries: readonly string[],
	explicitEntries: readonly string[],
): string[] {
	const explicitKeys = extensionSelectorKeys(explicitEntries);
	return globalEntries.filter((entry) => {
		if (!entry.startsWith("ext:")) return false;
		const selectors = parseToolEntries([entry]).extSelectors;
		return selectors.length > 0 && selectors.every(
			(selector) => !explicitKeys.has(canonicalExtensionSelectorKey(selector)),
		);
	});
}

/** Apply the global baseline without mutating the discovered AgentConfig. */
function applyGlobalBaseline(
	agent: AgentConfig,
	baseline: GlobalToolWhitelistConfig | undefined,
	effectiveInheritSkills: boolean | undefined,
): AgentConfig {
	const globalTools = baseline?.tools ?? [];
	const globalSkills = baseline?.skills ?? [];
	if (globalTools.length === 0 && globalSkills.length === 0) return agent;

	const next = copyOptionalGlobalToolEntries(agent, { ...agent });
	if (globalTools.length > 0) {
		const explicitTools = agent.tools && agent.tools.length > 0 ? agent.tools : undefined;
		next.tools = explicitTools
			? dedupe([...globalTools, ...explicitTools])
			: dedupe([...DEFAULT_WORKER_TOOLS, ...globalTools]);
		setOptionalGlobalToolEntries(
			next,
			withoutCanonicalExtensionSelectorDuplicates(globalTools, explicitTools ?? []),
		);
	}
	if (globalSkills.length > 0) {
		const explicitSkills = agent.skills && agent.skills.length > 0 ? agent.skills : undefined;
		if (explicitSkills) next.skills = dedupe([...globalSkills, ...explicitSkills]);
		else if (!effectiveInheritSkills) next.skills = [...globalSkills];
	}
	return next;
}

/**
 * Merge an override patch onto an AgentConfig. Returns a new object;
 * does NOT mutate the input. Only fields explicitly set on the
 * override overwrite — `undefined` fields pass through unchanged.
 *
 * With a global baseline, non-empty tool/skill lists extend the composed
 * surface while explicit empty lists clear it. Without one, the historical
 * whole-array replacement behavior remains.
 */
function mergeOverride(
	agent: AgentConfig,
	ov: AgentOverride,
	baseline: GlobalToolWhitelistConfig | undefined,
): AgentConfig {
	const next = copyOptionalGlobalToolEntries(agent, { ...agent });
	if (ov.env !== undefined) next.env = mergeEnvOverrides(next.env, ov.env);
	const keys: Array<keyof AgentOverride> = [
		"description",
		"model",
		"fallbackModels",
		"thinking",
		"thinkingMin",
		"thinkingMax",
		"systemPrompt",
		"systemPromptMode",
		"inheritProjectContext",
		"inheritSkills",
		"mcpDirectTools",
		"extensions",
		"extensionInclude",
		"extensionExclude",
		"defaultMaxRounds",
		"stopConditionHint",
		"collapseMode",
		"summaryModel",
		"defaultReads",
		"defaultProgress",
		"artifact",
		"interactive",
		"maxSubagentDepth",
		"allowNestedDelegate",
		"nestedDelegateAgents",
		"maxDurationMs",
		"windDownGraceMs",
	];
	for (const k of keys) {
		const v = ov[k];
		if (v === undefined) continue;
		Object.assign(next, { [k]: v });
	}

	if (ov.tools !== undefined) {
		if (baseline === undefined || ov.tools.length === 0) {
			next.tools = [...ov.tools];
		} else {
			next.tools = dedupe([...(next.tools ?? []), ...ov.tools]);
		}
		setOptionalGlobalToolEntries(
			next,
			ov.tools.length === 0
				? []
				: withoutCanonicalExtensionSelectorDuplicates(
						[...getOptionalGlobalToolEntries(next)],
						ov.tools,
					),
		);
	}
	if (ov.skills !== undefined) {
		if (baseline === undefined || ov.skills.length === 0) {
			next.skills = [...ov.skills];
		} else {
			next.skills = dedupe([...(next.skills ?? baseline.skills ?? []), ...ov.skills]);
		}
	}

	const thinkingKeys = ["thinking", "thinkingMin", "thinkingMax"] as const;
	if (thinkingKeys.some((key) => ov[key] !== undefined)) {
		Object.assign(next, normalizeThinkingFields(next));
	}
	return next;
}
