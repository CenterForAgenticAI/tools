import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
	availableAgentLevels,
	modelSafeThinkingLevels,
	type AgentThinkingLevel,
	type ResolvedConfig,
	type ConfigurableThinkingLevel,
	type OverrideScope,
	type RuntimeThinkingLevel,
	type ThinkingState,
} from "./logic.js";

export const ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION = 1 as const;
export const ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL = "adaptive-thinking:snapshot:request:v1";
export const ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL = "adaptive-thinking:snapshot:response:v1";
export const ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL = "adaptive-thinking:snapshot:changed:v1";

export type AdaptiveThinkingEffectiveSource = "baseline" | "user" | "agent" | "external-recommendation";

type SnapshotModel = Parameters<typeof getSupportedThinkingLevels>[0];

export interface AdaptiveThinkingModelSnapshotV1 {
	readonly provider: string;
	readonly id: string;
}

/**
 * Read-only state for the Pi session whose event bus returned it.
 *
 * This protocol never controls independently spawned delegate workers. Each
 * worker has its own extension instance and event bus; worker bounds remain a
 * pi-delegate invocation concern.
 */
export interface AdaptiveThinkingSnapshotV1 {
	readonly protocolVersion: typeof ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION;
	readonly controlScope: "current-session";
	readonly enabled: boolean;
	readonly baseline: ConfigurableThinkingLevel;
	readonly min: ConfigurableThinkingLevel;
	readonly max: ConfigurableThinkingLevel;
	readonly effective: ConfigurableThinkingLevel;
	readonly source: AdaptiveThinkingEffectiveSource;
	readonly scope: OverrideScope | null;
	readonly turnsRemaining: number | null;
	readonly model: AdaptiveThinkingModelSnapshotV1 | null;
	readonly modelSupportedLevels: readonly RuntimeThinkingLevel[];
	readonly modelAgentSelectableLevels: readonly AgentThinkingLevel[];
}

export interface AdaptiveThinkingSnapshotRequestV1 {
	readonly protocolVersion: typeof ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION;
	readonly requestId: string;
}

export interface AdaptiveThinkingSnapshotResponseV1 {
	readonly protocolVersion: typeof ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION;
	readonly requestId: string;
	readonly snapshot: AdaptiveThinkingSnapshotV1;
}

export interface AdaptiveThinkingSnapshotInput {
	readonly state: Readonly<ThinkingState>;
	readonly config: Readonly<ResolvedConfig>;
	readonly effective: ConfigurableThinkingLevel;
	readonly source: AdaptiveThinkingEffectiveSource;
	readonly model: SnapshotModel | undefined;
}

export function createAdaptiveThinkingSnapshot(input: AdaptiveThinkingSnapshotInput): AdaptiveThinkingSnapshotV1 {
	const modelSupportedLevels = input.model
		? modelSafeThinkingLevels(getSupportedThinkingLevels(input.model), input.model)
		: [];
	// `modelSupportedLevels` is `[]` when no model is known, which correctly
	// yields an empty selectable set here: a consumer must not be told a level
	// is selectable before the session has a model to run it on.
	const modelAgentSelectableLevels: AgentThinkingLevel[] = availableAgentLevels(input.config, modelSupportedLevels);

	return {
		protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
		controlScope: "current-session",
		enabled: input.config.enabled,
		baseline: input.state.baseline,
		min: input.config.minLevel,
		max: input.config.maxLevel,
		effective: input.effective,
		source: input.source,
		scope: input.state.scope,
		turnsRemaining: input.state.turnsRemaining,
		model: input.model ? { provider: input.model.provider, id: input.model.id } : null,
		modelSupportedLevels,
		modelAgentSelectableLevels,
	};
}
