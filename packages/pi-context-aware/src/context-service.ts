import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ContextPressureBand } from "./platform/context-telemetry.js";
import type { EffectiveAmbiguityMode } from "./seed/seed-expansion.js";
import type { ContextAwareSessionCompactionV1 } from "./compaction/compaction-history.js";

export type { ContextAwareSessionCompactionV1 } from "./compaction/compaction-history.js";

export const CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION = 1 as const;
export const CONTEXT_AWARE_SERVICE_DISCOVERY_EVENT = "context-aware:service:v1:discover";
export const CONTEXT_AWARE_HANDOFF_STATE_EVENT = "context-aware:service:v1:handoff-state";
export const CONTEXT_AWARE_POLICY_CHANGED_EVENT = "context-aware:policy:v1:changed";

export const CONTEXT_AWARE_HANDOFF_DEFAULT_MAX_SEED_CHARACTERS = 12_000;
export const CONTEXT_AWARE_HANDOFF_DEFAULT_MAX_SUMMARY_FOCUS_CHARACTERS = 8_000;
export const CONTEXT_AWARE_HANDOFF_HARD_MAX_SEED_CHARACTERS = 50_000;
export const CONTEXT_AWARE_HANDOFF_HARD_MAX_SUMMARY_FOCUS_CHARACTERS = 20_000;

export type ContextAwarePressureBandV1 = ContextPressureBand | "UNKNOWN";
export type ContextAwarePhaseBoundaryV1 = "not-advised" | "advised" | "required" | "unknown";
export type ContextAwareCompactionStateV1 = "idle" | "queued" | "running";
export type ContextAwareProactiveCompactionStateV1 =
	| "idle"
	| "pending"
	| "generating"
	| "queued"
	| "compacting"
	| "cooldown"
	| "failed"
	| "cancelled";
export type ContextAwareProactiveCompactionTriggerV1 = "threshold" | "generation-reserve";
export type ContextAwareProactiveCompactionFailureStageV1 =
	| "seed-generation"
	| "seed-rewrite"
	| "scheduling"
	| "compaction";
export type ContextAwareSeedModeV1 = "auto-gen" | "user-approve";
export type ContextAwareAmbiguityModeV1 = "inherit" | "ask" | "cautious-proceed" | "always-proceed";
export type ContextAwareProactiveCompactionLeafSourceV1 =
	| "default"
	| "global"
	| "project"
	| "cli"
	| "session"
	| "host";
export type ContextAwareProactiveCompactionSourceV1 = ContextAwareProactiveCompactionLeafSourceV1 | "mixed";

export interface ContextAwareProactiveCompactionSourcesV1 {
	enabled: ContextAwareProactiveCompactionLeafSourceV1;
	thresholdFraction: ContextAwareProactiveCompactionLeafSourceV1;
	outputReserveTokens: ContextAwareProactiveCompactionLeafSourceV1;
	preparationStallTimeoutMs: ContextAwareProactiveCompactionLeafSourceV1;
	preparationFirstOutputGraceMs: ContextAwareProactiveCompactionLeafSourceV1;
	/** Added compatibly in protocol v1; older producers may omit this leaf. */
	commitDrainTimeoutMs?: ContextAwareProactiveCompactionLeafSourceV1;
}

export interface ContextAwareProactiveCompactionConfigV1 {
	enabled: boolean;
	thresholdFraction: number;
	outputReserveTokens: number;
	/** Maximum idle time without streamed seed output after a stage starts producing text. */
	preparationStallTimeoutMs: number;
	/** Maximum time before the first text output from a preparation stage. */
	preparationFirstOutputGraceMs: number;
	/** Added compatibly in protocol v1; older producers may omit this leaf. */
	commitDrainTimeoutMs?: number;
	/** One source when every value agrees, otherwise `mixed`. */
	source: ContextAwareProactiveCompactionSourceV1;
	/** Exact winning source for each independently resolved value. */
	sources: ContextAwareProactiveCompactionSourcesV1;
	diagnostic?: string;
}

/** Additive protocol-v1 visibility into context-aware's own proactive work. */
export interface ContextAwareProactiveCompactionLifecycleV1 {
	state: ContextAwareProactiveCompactionStateV1;
	trigger?: ContextAwareProactiveCompactionTriggerV1;
	runId?: string;
	updatedAt?: string;
	cooldownUntil?: string;
	coalescedTriggers?: number;
	cancellationStage?: "disabled" | "session-shutdown" | "session-replaced" | "superseded";
	lastFailure?: {
		stage: ContextAwareProactiveCompactionFailureStageV1;
		message: string;
		at: string;
	};
}

export interface ContextAwarePressureSnapshotV1 {
	available: boolean;
	tokens: number | null;
	contextWindow: number | null;
	fraction: number | null;
	headroom: number | null;
	band: ContextAwarePressureBandV1;
	phaseBoundary: ContextAwarePhaseBoundaryV1;
}

export interface ContextAwareSessionReferenceV1 {
	kind: "session";
	id: string;
	uri: string;
	path?: string;
	cwd?: string;
	leafEntryId?: string | null;
}

export interface ContextAwareArtifactReferenceV1 {
	kind: "context-cache-artifact";
	id: string;
	name: string;
	uri: string;
	path: string;
	description: string;
	sizeBytes: number;
	updated: string;
	createdBy: string;
	updatedBy: string;
}

/** A coordinator-supplied absolute workspace artifact to copy into the cache. */
export interface ContextAwareArtifactPromotionRequestV1 {
	sourcePath: string;
	file: string;
	description?: string;
}

export type ContextAwareArtifactPromotionFailureCodeV1 =
	| "INVALID_REQUEST"
	| "SERVICE_UNAVAILABLE"
	| "CACHE_DISABLED"
	| "SOURCE_UNAVAILABLE"
	| "PROMOTION_FAILED";

export type ContextAwareArtifactPromotionResultV1 =
	| {
			status: "promoted";
			artifact: ContextAwareArtifactReferenceV1;
	  }
	| {
			status: "failed";
			code: ContextAwareArtifactPromotionFailureCodeV1;
			message: string;
	  };

export interface ContextAwareEffectiveModeV1 {
	seedMode: ContextAwareSeedModeV1;
	seedRewrite: boolean;
	ambiguityMode: ContextAwareAmbiguityModeV1;
	effectiveAmbiguityMode: EffectiveAmbiguityMode;
	compactionModel: string | null;
	/** Added compatibly in protocol v1. Older producers may omit it. */
	proactiveCompaction?: ContextAwareProactiveCompactionConfigV1;
}

export interface ContextAwareSnapshotV1 {
	protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	capturedAt: string;
	pressure: ContextAwarePressureSnapshotV1;
	session: {
		current: ContextAwareSessionReferenceV1;
		lineage: ContextAwareSessionReferenceV1[];
		/** Added compatibly in protocol v1. Older producers may omit it. */
		compactions?: ContextAwareSessionCompactionV1[];
	};
	artifacts: ContextAwareArtifactReferenceV1[];
	compaction: {
		state: ContextAwareCompactionStateV1;
		runId?: string;
	};
	/** Added compatibly in protocol v1. Older producers may omit it. */
	proactiveCompaction?: ContextAwareProactiveCompactionLifecycleV1;
	effectiveMode: ContextAwareEffectiveModeV1;
	provenance: {
		provider: "context-aware";
		protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
		sessionId: string;
	};
}

export interface ContextAwareSnapshotSourceV1 {
	capturedAt?: string;
	pressure: { tokens: number; contextWindow: number } | null;
	session: {
		id: string;
		cwd: string;
		sessionFile?: string;
		parentSessionFile?: string;
		leafEntryId?: string | null;
	};
	lineageSessionFiles: string[];
	/** Added compatibly in protocol v1. Older producers may omit it. */
	compactions?: ContextAwareSessionCompactionV1[];
	artifacts: Array<{
		id: string;
		file: string;
		path: string;
		description: string;
		sizeBytes: number;
		updated: string;
		createdBy: string;
		updatedBy: string;
	}>;
	compaction: {
		state: ContextAwareCompactionStateV1;
		runId?: string;
	};
	proactiveCompaction?: ContextAwareProactiveCompactionLifecycleV1;
	effectiveMode: ContextAwareEffectiveModeV1;
	/** Telemetry band edges from the session's pressure ladder. Defaults to the default ladder. */
	pressureBands?: ContextAwarePressureBandEdgesV1;
}

export interface ContextAwareHandoffBoundsV1 {
	maxSeedCharacters?: number;
	maxSummaryFocusCharacters?: number;
}

export interface ContextAwareHandoffRequestV1 {
	requestId: string;
	purpose: string;
	nextPhaseSeed: string;
	summaryFocus?: string;
	rewriteSeed?: boolean;
	ambiguityMode?: ContextAwareAmbiguityModeV1;
	interactionMode: "non-interactive";
	bounds?: ContextAwareHandoffBoundsV1;
}

export interface ContextAwareHandoffProvenanceV1 {
	provider: "context-aware";
	protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	requestId: string;
	purpose: string;
	requestedAt: string;
	session: ContextAwareSessionReferenceV1;
	interactionMode: "non-interactive";
	effectiveMode: {
		seedRewrite: boolean;
		ambiguityMode: ContextAwareAmbiguityModeV1;
		effectiveAmbiguityMode: EffectiveAmbiguityMode;
		compactionModel: string | null;
	};
}

export interface ContextAwareHandoffReceiptV1 {
	status: "queued" | "running";
	runId: string;
	requestId: string;
	expandedSeedPrompt: string;
	summaryFocus: string | null;
	provenance: ContextAwareHandoffProvenanceV1;
}

/** A normal, non-failure result when Pi has too little history to compact. */
export interface ContextAwareHandoffNothingToCompactV1 {
	status: "nothing-to-compact";
	requestId: string;
	/** Plainly explains that the session was unchanged: "Nothing to compact (session too small); the conversation is unchanged." */
	message: string;
	provenance?: ContextAwareHandoffProvenanceV1;
}

export type ContextAwareHandoffFailureCodeV1 =
	| "INVALID_REQUEST"
	| "BOUNDS_EXCEEDED"
	| "SERVICE_UNAVAILABLE"
	| "INTERACTION_REQUIRED"
	| "COMPACTION_CONFLICT"
	| "PREPARATION_FAILED"
	| "COMPACTION_START_FAILED"
	| "NOT_IMPLEMENTED";

export interface ContextAwareHandoffFailureV1 {
	status: "failed";
	code: ContextAwareHandoffFailureCodeV1;
	message: string;
	stage: "validation" | "preparation" | "scheduling";
	recoverable: boolean;
	activeRun?: { runId: string; state: "queued" | "running" };
	provenance?: ContextAwareHandoffProvenanceV1;
}

export interface ContextAwareHandoffCancelledV1 {
	status: "cancelled";
	requestId: string;
	stage: "preparation" | "queued" | "session-shutdown";
	provenance?: ContextAwareHandoffProvenanceV1;
}

export type ContextAwareHandoffResultV1 =
	| ContextAwareHandoffReceiptV1
	| ContextAwareHandoffNothingToCompactV1
	| ContextAwareHandoffFailureV1
	| ContextAwareHandoffCancelledV1;

export type ContextAwareHandoffCancelResultV1 =
	| { status: "cancelled"; runId: string }
	| { status: "too-late"; runId: string; state: "running" }
	| { status: "not-found" };

export type ContextAwareHandoffLifecycleEventV1 =
	| {
			protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
			requestId: string;
			runId: string;
			state: "queued" | "running" | "completed";
			at: string;
			provenance: ContextAwareHandoffProvenanceV1;
	  }
	| {
			protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
			requestId: string;
			runId: string;
			state: "failed";
			at: string;
			message: string;
			provenance: ContextAwareHandoffProvenanceV1;
	  }
	| {
			protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
			requestId: string;
			runId: string;
			state: "cancelled";
			at: string;
			stage: "queued" | "session-shutdown";
			provenance: ContextAwareHandoffProvenanceV1;
	  };

export type ContextAwareModeRefusalCodeV1 =
	| "INVALID_REQUEST"
	| "DUPLICATE_ID"
	| "OWNER_MISMATCH"
	| "NOT_FOUND"
	| "INACTIVE_HANDLE"
	| "WRONG_EFFECTIVE_HANDLE"
	| "ALREADY_ACTIVE"
	| "NESTING_LIMIT"
	| "UNAVAILABLE"
	| "STALE_RUNTIME"
	| "CONFIRMATION_REQUIRED"
	| "CONFIRMATION_DECLINED"
	| "STATE_CHANGED"
	| "PINNED_LAYER"
	| "RUN_ENDED";

export type ContextAwareModeResultV1 =
	| { status: "ok" }
	| { status: "refused"; code: ContextAwareModeRefusalCodeV1; message: string };

export interface ContextAwareModeGuardResultV1 {
	block: boolean;
	reason?: string;
}

export interface ContextAwareModeToolPolicyV1 {
	/** Tools that may run while the policy applies. Every other tool is refused. At most 64 names. */
	allowedTools: readonly string[];
	/**
	 * When true, `bash` is refused unless its `command` passes the runtime's read-only
	 * shell check, even if `allowedTools` lists `bash`. When false or absent, `bash`
	 * follows `allowedTools` like any other tool.
	 */
	readOnlyShell?: boolean;
	/** When it returns true the policy does not apply to this call. A throw or a non-boolean counts as false. */
	lifted?: () => boolean;
}

/**
 * Theme tokens a mode may name as its indicator color. Each follows the user's
 * Pi theme, so a token stays readable on light and dark terminals.
 */
export const CONTEXT_AWARE_MODE_COLOR_TOKENS_V1 = Object.freeze([
	"accent",
	"success",
	"warning",
	"error",
	"muted",
	"borderAccent",
	"mdHeading",
	"mdLink",
	"toolTitle",
	"bashMode",
] as const);
export type ContextAwareModeColorTokenV1 = (typeof CONTEXT_AWARE_MODE_COLOR_TOKENS_V1)[number];
/** A theme token, or a fixed `#rrggbb` color that Pi maps to the terminal's color mode. */
export type ContextAwareModeColorV1 = ContextAwareModeColorTokenV1 | `#${string}`;

/** How the mode indicator shows a mode. Display only; it never changes what the mode allows. */
export interface ContextAwareModeUiV1 {
	/** Indicator color. Defaults to `accent`. */
	color?: ContextAwareModeColorV1;
	/** Indicator text, at most 32 printable characters. Defaults to the mode id. */
	label?: string;
}

/** The layer a mode definition without `layer` sits on, at rank 0. No definition may name it. */
export const CONTEXT_AWARE_MODE_DEFAULT_LAYER_V1 = "default" as const;

/**
 * Where a mode sits. One mode is active per layer, and the modes on different
 * layers are active together. The runtime knows no layer names; it orders
 * layers by `rank`, then by name.
 */
export interface ContextAwareModeLayerV1 {
	/** Layer name, 1 to 64 characters. `default` is reserved. */
	name: string;
	/** An integer from -1000000 to 1000000. A higher rank is drawn later and left first by `/mode exit`. */
	rank: number;
	/**
	 * A pinned layer is entered only through the handle, in a new session before
	 * its first agent run. Every later enter or exit on it is refused; only the
	 * user can clear it, with `/mode exit <layer>`, once its definition is gone.
	 */
	pinned?: true;
}

export interface ContextAwareModeDefinitionV1 {
	id: string;
	/** Display metadata only. It is never an authorization credential. */
	owner: string;
	transition: string;
	blockedTools: readonly string[];
	guard?: (toolName: string, input: Record<string, unknown>) => ContextAwareModeGuardResultV1 | undefined;
	/** Advisory only; this callback never intercepts command execution. */
	commandAllowed?: (name: string) => boolean;
	/** Allow-list of tools for this mode. Check `supportsContextAwareModeToolPoliciesV1` first; older runtimes ignore it. */
	toolPolicy?: ContextAwareModeToolPolicyV1;
	/** Indicator color and label. Check `supportsContextAwareModeUiV1` first; older runtimes ignore it. */
	ui?: ContextAwareModeUiV1;
	/** The layer this mode sits on. Absent means the `default` layer at rank 0. Check `supportsContextAwareModeLayersV1` first; older runtimes ignore it. */
	layer?: ContextAwareModeLayerV1;
}

export interface ContextAwareModeEnterOptionsV1 {
	/**
	 * Enter the mode for one run: when this signal aborts, the mode leaves its
	 * layer, unless another mode has replaced it there. A run-scoped mode is not
	 * restored on resume. Refused with `RUN_ENDED` when the signal has already
	 * aborted, and with `INVALID_REQUEST` on a pinned layer.
	 */
	until?: AbortSignal;
}

export interface ContextAwareModeSuggestionV1 extends ContextAwareModeEnterOptionsV1 {
	suggestedBy: "model";
	/** Model suggestions must opt in to confirmation explicitly. */
	confirm?: true;
}

export interface ContextAwareModeSnapshotV1 {
	readonly id: string;
	readonly owner: string;
	/**
	 * Unique per enter, so two enters of one mode never share it even within one
	 * millisecond. Present when `ContextAwareModesV1.instanceIds` is true; older
	 * producers omit it. A mode restored from an entry written before this field
	 * existed gets a stable id derived from the session branch.
	 */
	readonly instanceId?: string;
	readonly available: boolean;
	readonly suggestedBy?: "model";
	readonly enteredAt: string;
	readonly updatedAt: string;
	readonly outer?: ContextAwareModeSnapshotV1;
	/** The definition's indicator color and label. Present only while the mode is available and its definition set `ui`. */
	readonly ui?: Readonly<ContextAwareModeUiV1>;
	/** The layer the mode sits on. Present when `ContextAwareModesV1.layered` is true. */
	readonly layer?: string;
	/** The layer's rank. Present when `ContextAwareModesV1.layered` is true. */
	readonly rank?: number;
	/** True when the layer is pinned. */
	readonly pinned?: true;
	/** True when the mode was entered with `until` and ends with that run. */
	readonly runScoped?: true;
}

export interface ContextAwareModeHandleV1 {
	readonly enter: (options?: ContextAwareModeSuggestionV1 | ContextAwareModeEnterOptionsV1) => Promise<ContextAwareModeResultV1>;
	readonly exit: () => ContextAwareModeResultV1;
	readonly commandAllowed: (name: string) => boolean;
}

export type ContextAwareModeDefinitionResultV1 =
	| { status: "ok"; handle: ContextAwareModeHandleV1 }
	| { status: "refused"; code: ContextAwareModeRefusalCodeV1; message: string };

export type ContextAwareModeConfirmerV1 = (request: {
	mode: string;
	action: "enter" | "exit";
	reason?: string;
}) => Promise<boolean>;

export interface ContextAwareModesV1 {
	/** True when every snapshot carries `instanceId`. Lets a client check support before any mode is active. */
	readonly instanceIds?: true;
	/** True when the runtime enforces `ContextAwareModeDefinitionV1.toolPolicy`. */
	readonly toolPolicies?: true;
	/** True when the runtime accepts `ContextAwareModeDefinitionV1.ui` and shows the mode indicator widget. */
	readonly ui?: true;
	/** True when the runtime accepts `ContextAwareModeDefinitionV1.layer` and provides `layers` and `setTrail`. */
	readonly layered?: true;
	defineMode(definition: ContextAwareModeDefinitionV1): ContextAwareModeDefinitionResultV1;
	/**
	 * The mode on the highest-ranked active layer. With layers, `outer` is the
	 * mode on the next layer down; read `layers()` for all of them.
	 */
	current(): ContextAwareModeSnapshotV1 | null;
	/** Every active layer's mode, lowest rank first. Present when `layered` is true. */
	layers?(): readonly ContextAwareModeSnapshotV1[];
	/**
	 * Show a short step trail after the mode chips in the indicator, or clear it
	 * with `undefined`. At most 64 characters with no control or format
	 * characters. Display only: held in process memory, never persisted, and any
	 * extension may replace it. Present when `layered` is true.
	 */
	setTrail?(text: string | undefined): ContextAwareModeResultV1;
	setSuggestionConfirmer(confirmer: ContextAwareModeConfirmerV1 | undefined): void;
}

/** The values `contextPolicy` accepts in this release. */
export const CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1 = Object.freeze(["summaries"] as const);
export type ContextAwareContextPolicyValueV1 = (typeof CONTEXT_AWARE_CONTEXT_POLICY_VALUES_V1)[number];

/** The configuration layer a policy value came from. */
export type ContextAwarePolicySourceV1 = ContextAwareProactiveCompactionLeafSourceV1;

/** Context-usage fractions of the pressure ladder, lowest step first. */
export interface ContextAwarePressureLadderV1 {
	/** Fold nudges begin. The WARN telemetry band starts here. */
	readonly foldNudgeStartFraction: number;
	/** Fold nudges end. */
	readonly foldNudgeEndFraction: number;
	/** Seeded compaction runs. The URGENT telemetry band starts here. */
	readonly seededCompactionFraction: number;
	/** Oldest entries are hidden recoverably, only when compaction cannot run. */
	readonly recoverableHideFraction: number;
}

/** Starting defaults of the pressure ladder. */
export const CONTEXT_AWARE_DEFAULT_PRESSURE_LADDER_V1: ContextAwarePressureLadderV1 = Object.freeze({
	foldNudgeStartFraction: 0.45,
	foldNudgeEndFraction: 0.75,
	seededCompactionFraction: 0.9,
	recoverableHideFraction: 0.95,
});

/** Where the WARN and URGENT telemetry bands begin. */
export interface ContextAwarePressureBandEdgesV1 {
	readonly warnFraction: number;
	readonly urgentFraction: number;
}

/** The one mapping from ladder steps to telemetry bands. */
export function contextAwarePressureBandEdgesV1(
	ladder: ContextAwarePressureLadderV1 = CONTEXT_AWARE_DEFAULT_PRESSURE_LADDER_V1,
): ContextAwarePressureBandEdgesV1 {
	return { warnFraction: ladder.foldNudgeStartFraction, urgentFraction: ladder.seededCompactionFraction };
}

export type ContextAwarePressureLadderSourcesV1 = {
	readonly [K in keyof ContextAwarePressureLadderV1]: ContextAwarePolicySourceV1;
};

export interface ContextAwarePolicySnapshotV1 {
	readonly protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	readonly value: ContextAwareContextPolicyValueV1;
	/** The layer that supplied `value`. */
	readonly source: ContextAwarePolicySourceV1;
	readonly ladder: ContextAwarePressureLadderV1;
	/** The layer that supplied each ladder threshold. */
	readonly ladderSources: ContextAwarePressureLadderSourcesV1;
	readonly bands: ContextAwarePressureBandEdgesV1;
	/** Present when an invalid value was ignored or the ladder fell back to defaults. */
	readonly diagnostic?: string;
}

/** Read-only view of the session's context policy on the current branch. */
export interface ContextAwarePolicyV1 {
	current(): ContextAwarePolicySnapshotV1;
}

/** Payload of `context-aware:policy:v1:changed`. */
export interface ContextAwarePolicyChangedEventV1 {
	readonly protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	/**
	 * `command` after `/context-policy`; `branch` after tree navigation moved
	 * the branch; `session-entry` when a policy entry appended by someone else,
	 * such as a host, changed it. That last case is seen at the next turn end.
	 */
	readonly reason: "command" | "branch" | "session-entry";
	readonly sessionId: string;
	readonly at: string;
	readonly previous: ContextAwarePolicySnapshotV1 | null;
	readonly current: ContextAwarePolicySnapshotV1;
}

export interface ContextAwareServiceV1 {
	readonly protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	getSnapshot(): ContextAwareSnapshotV1;
	promoteArtifact?(request: ContextAwareArtifactPromotionRequestV1): ContextAwareArtifactPromotionResultV1;
	modes?: ContextAwareModesV1;
	/** Added compatibly in protocol v1. Older producers may omit it. */
	policy?: ContextAwarePolicyV1;
	requestHandoff(
		request: ContextAwareHandoffRequestV1,
		options?: { signal?: AbortSignal },
	): Promise<ContextAwareHandoffResultV1>;
	cancelHandoff(runId: string): ContextAwareHandoffCancelResultV1;
}

/** Return true when the producer exposes the additive modes capability. */
export function supportsContextAwareModesV1(service: ContextAwareServiceV1 | undefined): service is ContextAwareServiceV1 & Required<Pick<ContextAwareServiceV1, "modes">> {
	return typeof service?.modes?.defineMode === "function"
		&& typeof service.modes.current === "function"
		&& typeof service.modes.setSuggestionConfirmer === "function";
}

/** Return true when the modes capability gives every snapshot an `instanceId`. */
export function supportsContextAwareModeInstanceIdsV1(service: ContextAwareServiceV1 | undefined): boolean {
	return supportsContextAwareModesV1(service) && service.modes.instanceIds === true;
}

/** Return true when the modes capability enforces a mode's `toolPolicy`. */
export function supportsContextAwareModeToolPoliciesV1(service: ContextAwareServiceV1 | undefined): boolean {
	return supportsContextAwareModesV1(service) && service.modes.toolPolicies === true;
}

/** Return true when the modes capability accepts a mode's `layer` and provides `layers` and `setTrail`. */
export function supportsContextAwareModeLayersV1(service: ContextAwareServiceV1 | undefined): boolean {
	return supportsContextAwareModesV1(service)
		&& service.modes.layered === true
		&& typeof service.modes.layers === "function"
		&& typeof service.modes.setTrail === "function";
}

/** Return true when the modes capability accepts a mode's `ui` color and label. */
export function supportsContextAwareModeUiV1(service: ContextAwareServiceV1 | undefined): boolean {
	return supportsContextAwareModesV1(service) && service.modes.ui === true;
}

/** Return true when the producer exposes the additive read-only context policy capability. */
export function supportsContextAwarePolicyV1(
	service: ContextAwareServiceV1 | undefined,
): service is ContextAwareServiceV1 & Required<Pick<ContextAwareServiceV1, "policy">> {
	return typeof service?.policy?.current === "function";
}

/** Return true when a discovered producer implements the additive promotion capability. */
export function supportsContextAwareArtifactPromotionV1(
	service: ContextAwareServiceV1 | undefined,
): service is ContextAwareServiceV1 & Required<Pick<ContextAwareServiceV1, "promoteArtifact">> {
	return typeof service?.promoteArtifact === "function";
}

export interface ContextAwareServiceDiscoveryRequestV1 {
	protocolVersion: typeof CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION;
	consumerId: string;
	accept(service: ContextAwareServiceV1): void;
}

export type ContextAwareHandoffValidationResultV1 =
	| { ok: true; request: ContextAwareHandoffRequestV1 }
	| {
			ok: false;
			code: "INVALID_REQUEST" | "BOUNDS_EXCEEDED";
			message: string;
	  };

function pressureSnapshot(
	pressure: ContextAwareSnapshotSourceV1["pressure"],
	bands: ContextAwarePressureBandEdgesV1 = contextAwarePressureBandEdgesV1(),
): ContextAwarePressureSnapshotV1 {
	if (
		!pressure ||
		!Number.isFinite(pressure.tokens) ||
		!Number.isFinite(pressure.contextWindow) ||
		pressure.tokens < 0 ||
		pressure.contextWindow <= 0
	) {
		return {
			available: false,
			tokens: null,
			contextWindow: null,
			fraction: null,
			headroom: null,
			band: "UNKNOWN",
			phaseBoundary: "unknown",
		};
	}

	const fraction = pressure.tokens / pressure.contextWindow;
	const band: ContextPressureBand = fraction >= bands.urgentFraction ? "URGENT" : fraction >= bands.warnFraction ? "WARN" : "OK";
	return {
		available: true,
		tokens: pressure.tokens,
		contextWindow: pressure.contextWindow,
		fraction,
		headroom: Math.max(0, pressure.contextWindow - pressure.tokens),
		band,
		phaseBoundary: band === "URGENT" ? "required" : band === "WARN" ? "advised" : "not-advised",
	};
}

function sessionReference(
	id: string,
	file: string | undefined,
	extra: Pick<ContextAwareSessionReferenceV1, "cwd" | "leafEntryId"> = {},
): ContextAwareSessionReferenceV1 {
	if (!file) {
		return {
			kind: "session",
			id,
			uri: `pi-session:${encodeURIComponent(id)}`,
			...extra,
		};
	}
	return {
		kind: "session",
		id,
		uri: pathToFileURL(file).href,
		path: file,
		...extra,
	};
}

export function buildContextAwareSnapshotV1(source: ContextAwareSnapshotSourceV1): ContextAwareSnapshotV1 {
	const current = sessionReference(source.session.id, source.session.sessionFile, {
		cwd: source.session.cwd,
		leafEntryId: source.session.leafEntryId,
	});
	const lineagePaths = [source.session.parentSessionFile, ...source.lineageSessionFiles]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	const lineage = [...new Set(lineagePaths)]
		.filter((file) => file !== source.session.sessionFile)
		.map((file) => sessionReference(`path:${file}`, file));

	return {
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		capturedAt: source.capturedAt ?? new Date().toISOString(),
		pressure: pressureSnapshot(source.pressure, source.pressureBands),
		session: {
			current,
			lineage,
			compactions: (source.compactions ?? []).map((compaction) => ({ ...compaction })),
		},
		artifacts: source.artifacts.map((artifact) => ({
			kind: "context-cache-artifact",
			id: artifact.id,
			name: artifact.file,
			uri: pathToFileURL(artifact.path).href,
			path: artifact.path,
			description: artifact.description,
			sizeBytes: artifact.sizeBytes,
			updated: artifact.updated,
			createdBy: artifact.createdBy,
			updatedBy: artifact.updatedBy,
		})),
		compaction: { ...source.compaction },
		...(source.proactiveCompaction
			? {
				proactiveCompaction: {
					...source.proactiveCompaction,
					...(source.proactiveCompaction.lastFailure
						? { lastFailure: { ...source.proactiveCompaction.lastFailure } }
						: {}),
				},
			}
			: {}),
		effectiveMode: { ...source.effectiveMode },
		provenance: {
			provider: "context-aware",
			protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
			sessionId: source.session.id,
		},
	};
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateContextAwareArtifactPromotionRequestV1Internal(
	request: ContextAwareArtifactPromotionRequestV1,
): { ok: true; request: ContextAwareArtifactPromotionRequestV1 } | { ok: false; code: "INVALID_REQUEST"; message: string } {
	if (!request || typeof request !== "object") {
		return { ok: false, code: "INVALID_REQUEST", message: "Promotion request must be an object." };
	}
	const allowedProperties = new Set<PropertyKey>(["sourcePath", "file", "description"]);
	for (const property of Reflect.ownKeys(request)) {
		if (!allowedProperties.has(property)) {
			const name = typeof property === "string" ? `: ${property}` : "";
			return { ok: false, code: "INVALID_REQUEST", message: `Promotion request contains an unknown property${name}.` };
		}
	}
	const sourcePath = typeof request.sourcePath === "string" ? request.sourcePath.trim() : "";
	if (!path.isAbsolute(sourcePath)) {
		return { ok: false, code: "INVALID_REQUEST", message: "sourcePath must be an absolute path." };
	}
	const file = typeof request.file === "string" ? request.file.trim() : "";
	// Mirrors context-cache's isSafeCacheFileName. This module ships as raw .ts and
	// is import-checked with plain type-stripping, so it cannot take a runtime
	// import of that helper; the reserved manifest name is matched case-insensitively
	// here so a `_MANIFEST.JSON` alias cannot pass on a case-insensitive filesystem.
	if (file.toLowerCase() === "_manifest.json" || !/^[\w][\w.-]{0,98}\.[a-z]{1,10}$/i.test(file) || file.includes("..") || file.includes("/") || file.includes("\\")) {
		return { ok: false, code: "INVALID_REQUEST", message: "file must be a safe cache filename with an extension." };
	}
	if (request.description !== undefined && typeof request.description !== "string") {
		return { ok: false, code: "INVALID_REQUEST", message: "description must be a string when provided." };
	}
	const description = request.description?.trim();
	return {
		ok: true,
		request: {
			sourcePath,
			file,
			...(description ? { description } : {}),
		},
	};
}

export function validateContextAwareArtifactPromotionRequestV1(
	request: ContextAwareArtifactPromotionRequestV1,
): { ok: true; request: ContextAwareArtifactPromotionRequestV1 } | { ok: false; code: "INVALID_REQUEST"; message: string } {
	try {
		return validateContextAwareArtifactPromotionRequestV1Internal(request);
	} catch {
		return { ok: false, code: "INVALID_REQUEST", message: "Promotion request is malformed." };
	}
}

export function validateContextAwareHandoffRequestV1(
	request: ContextAwareHandoffRequestV1,
): ContextAwareHandoffValidationResultV1 {
	if (!request || typeof request !== "object") {
		return { ok: false, code: "INVALID_REQUEST", message: "Handoff request must be an object." };
	}
	if (typeof request.requestId !== "string" || request.requestId.trim().length === 0) {
		return { ok: false, code: "INVALID_REQUEST", message: "requestId is required." };
	}
	if (typeof request.purpose !== "string" || request.purpose.trim().length === 0) {
		return { ok: false, code: "INVALID_REQUEST", message: "purpose is required." };
	}
	if (typeof request.nextPhaseSeed !== "string" || request.nextPhaseSeed.trim().length === 0) {
		return { ok: false, code: "INVALID_REQUEST", message: "nextPhaseSeed is required." };
	}
	if (request.interactionMode !== "non-interactive") {
		return {
			ok: false,
			code: "INVALID_REQUEST",
			message: "Protocol v1 supports only interactionMode=non-interactive.",
		};
	}
	if (request.summaryFocus !== undefined && typeof request.summaryFocus !== "string") {
		return { ok: false, code: "INVALID_REQUEST", message: "summaryFocus must be a string when provided." };
	}
	if (request.rewriteSeed !== undefined && typeof request.rewriteSeed !== "boolean") {
		return { ok: false, code: "INVALID_REQUEST", message: "rewriteSeed must be boolean when provided." };
	}
	if (
		request.bounds !== undefined &&
		(!request.bounds || typeof request.bounds !== "object" || Array.isArray(request.bounds))
	) {
		return { ok: false, code: "INVALID_REQUEST", message: "bounds must be an object when provided." };
	}
	if (
		request.ambiguityMode !== undefined &&
		request.ambiguityMode !== "inherit" &&
		request.ambiguityMode !== "ask" &&
		request.ambiguityMode !== "cautious-proceed" &&
		request.ambiguityMode !== "always-proceed"
	) {
		return { ok: false, code: "INVALID_REQUEST", message: "ambiguityMode is invalid." };
	}

	const maxSeedCharacters = request.bounds?.maxSeedCharacters ?? CONTEXT_AWARE_HANDOFF_DEFAULT_MAX_SEED_CHARACTERS;
	const maxSummaryFocusCharacters = request.bounds?.maxSummaryFocusCharacters ?? CONTEXT_AWARE_HANDOFF_DEFAULT_MAX_SUMMARY_FOCUS_CHARACTERS;
	if (
		!isPositiveInteger(maxSeedCharacters) ||
		maxSeedCharacters > CONTEXT_AWARE_HANDOFF_HARD_MAX_SEED_CHARACTERS ||
		!isPositiveInteger(maxSummaryFocusCharacters) ||
		maxSummaryFocusCharacters > CONTEXT_AWARE_HANDOFF_HARD_MAX_SUMMARY_FOCUS_CHARACTERS
	) {
		return {
			ok: false,
			code: "INVALID_REQUEST",
			message: `bounds must be positive integers no greater than ${CONTEXT_AWARE_HANDOFF_HARD_MAX_SEED_CHARACTERS} seed characters and ${CONTEXT_AWARE_HANDOFF_HARD_MAX_SUMMARY_FOCUS_CHARACTERS} summary-focus characters.`,
		};
	}
	if (
		request.nextPhaseSeed.length > maxSeedCharacters ||
		(request.summaryFocus?.length ?? 0) > maxSummaryFocusCharacters
	) {
		return {
			ok: false,
			code: "BOUNDS_EXCEEDED",
			message: `Handoff input exceeds declared bounds (${maxSeedCharacters} seed characters, ${maxSummaryFocusCharacters} summary-focus characters).`,
		};
	}

	return { ok: true, request };
}

function isDiscoveryRequest(value: unknown): value is ContextAwareServiceDiscoveryRequestV1 {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<ContextAwareServiceDiscoveryRequestV1>;
	return request.protocolVersion === CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION &&
		typeof request.consumerId === "string" && request.consumerId.trim().length > 0 &&
		typeof request.accept === "function";
}

export function provideContextAwareServiceV1(events: EventBus, service: ContextAwareServiceV1): () => void {
	return events.on(CONTEXT_AWARE_SERVICE_DISCOVERY_EVENT, (value) => {
		if (!isDiscoveryRequest(value)) return;
		value.accept(service);
	});
}

export function discoverContextAwareServiceV1(
	events: EventBus,
	consumerId: string,
): ContextAwareServiceV1 | undefined {
	let discovered: ContextAwareServiceV1 | undefined;
	events.emit(CONTEXT_AWARE_SERVICE_DISCOVERY_EVENT, {
		protocolVersion: CONTEXT_AWARE_SERVICE_PROTOCOL_VERSION,
		consumerId,
		accept(service: ContextAwareServiceV1) {
			discovered ??= service;
		},
	} satisfies ContextAwareServiceDiscoveryRequestV1);
	return discovered;
}
