/**
 * adaptive-thinking: Agent-driven dynamic thinking effort scaling.
 *
 * Capabilities
 * ------------
 *   1. Tool `set_thinking_effort`: LLM-callable. Lets the agent escalate or
 *      de-escalate its reasoning depth mid-response, with explicit scope and
 *      mandatory reason.
 *
 *   2. System-prompt injection: appends a <thinking-effort> block on every turn
 *      so the LLM sees its current thinking state + guidelines for when to
 *      escalate.
 *
 *   3. Status-bar widget (slot "caair.adaptive-thinking/level"):
 *        🧠 medium                           (baseline, no override)
 *        🧠 high ↑ (this response)           (elevated for current run)
 *        🧠 xhigh ↑↑ (3 responses left)     (elevated for N runs)
 *        🧠 high ↑ (persistent)              (until_changed)
 *
 *   4. Auto-decay: overrides with scope "this_response" revert at agent_end.
 *      Overrides with scope "next_N" count down and revert when exhausted.
 *
 *   5. Commands:
 *        /thinking-baseline <level|status>  — set or view the baseline
 *        /thinking-higher                    — move one model-safe level up
 *        /thinking-lower                     — move one model-safe level down
 *        /thinking-bounds <min> <max>       — set the agent-selectable range
 *        /thinking-status                   — full state dump
 *        /thinking-reset                    — clear override, revert to baseline
 *      Shortcuts: Alt+. (higher) and Alt+, (lower). Both are ESC-prefixed, so
 *      terminals and window managers pass them through, unlike the Shift+Tab
 *      chords they replace. Shift+Tab remains Pi's reserved thinking-cycle
 *      shortcut.
 *
 * Config: ~/.pi/agent/adaptive-thinking.json
 *   {
 *     "baseline": "medium",    // default thinking level
 *     "enabled": true,         // tool available to agent
 *     "minLevel": "low",       // floor the agent can pick (default: "low")
 *     "maxLevel": "xhigh"      // ceiling the agent can pick (default: "xhigh")
 *   }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type ConfigurableThinkingLevel,
	type AgentThinkingLevel,
	type OverrideScope,
	type ThinkingState,
	type Config,
	type ResolvedConfig,
	type RuntimeThinkingLevel,
	type ThinkingBoundSpec,
	CONFIGURABLE_LEVELS,
	AGENT_LEVELS,
	DEFAULT_CONFIG,
	isConfigurableLevel,
	isBoundSpec,
	BOUND_SENTINELS,
	boundSpecLabel,
	modelRejectsDisabledThinking,
	guardLevelForModel,
	parseConfig,
	resolveConfigForModel,
	availableAgentLevels,
	resolveModelEffortProfile,
	buildModelProfileBlock,
	modelWithheldLevels,
	allowedLevels,
	clampLevel,
	defaultState,
	effectiveLevel,
	resolveThinkingEffortRequest,
	buildThinkingEffortSuccessText,
	buildStatusLine,
	buildSystemPromptBlock,
	modelSafeThinkingLevels,
	adjacentThinkingLevel,
	fallbackThinkingLevel,
} from "./logic.js";
import {
	ADAPTIVE_THINKING_POLICY_ACK_CHANNEL,
	ADAPTIVE_THINKING_POLICY_CHANNEL,
	ADAPTIVE_THINKING_POLICY_ENV,
	ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE,
	THINKING_POLICY_ENTRY_TYPE,
	environmentPolicyAsSessionPolicy,
	environmentPolicyFromConfig,
	findEnvironmentThinkingPolicy,
	intersectEnvironmentThinkingPolicies,
	findSessionThinkingPolicy,
	normalizeEnvironmentThinkingPolicy,
	normalizePersistedThinkingState,
	normalizeSessionThinkingPolicy,
	policyAck,
	sessionConfig,
	type EnvironmentThinkingPolicy,
	type SessionThinkingPolicy,
} from "./thinking-policy.js";
import {
	ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
	ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL,
	ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL,
	ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL,
	createAdaptiveThinkingSnapshot,
	type AdaptiveThinkingEffectiveSource,
	type AdaptiveThinkingSnapshotRequestV1,
	type AdaptiveThinkingSnapshotV1,
} from "./integration-seam.js";

// ---------------------------------------------------------------------------
// Process-wide child environment policy
// ---------------------------------------------------------------------------

const PROCESS_ENVIRONMENT_POLICY_REGISTRY_KEY = Symbol.for(
	"@caair/adaptive-thinking/process-environment-policy-registry/v1",
);
const FAIL_CLOSED_ENVIRONMENT_POLICY: EnvironmentThinkingPolicy = {
	version: 1,
	thinkingMin: "off",
	thinkingMax: "off",
};

interface ProcessEnvironmentPolicyRegistry {
	inheritedEnvironmentValue: string | undefined;
	inheritedPolicy: EnvironmentThinkingPolicy | undefined;
	activeRanges: Map<symbol, EnvironmentThinkingPolicy>;
	lastExportedValue: string | undefined;
}

function processEnvironmentPolicyRegistry(): ProcessEnvironmentPolicyRegistry {
	const host = globalThis as Record<symbol, unknown>;
	const existing = host[PROCESS_ENVIRONMENT_POLICY_REGISTRY_KEY];
	if (existing) return existing as ProcessEnvironmentPolicyRegistry;

	const inheritedValue = process.env[ADAPTIVE_THINKING_POLICY_ENV];
	let inheritedEnvironmentValue = inheritedValue;
	let inheritedPolicy: EnvironmentThinkingPolicy | undefined;
	if (inheritedValue !== undefined) {
		try {
			inheritedPolicy = normalizeEnvironmentThinkingPolicy(JSON.parse(inheritedValue));
		} catch {
			inheritedPolicy = FAIL_CLOSED_ENVIRONMENT_POLICY;
			inheritedEnvironmentValue = JSON.stringify(FAIL_CLOSED_ENVIRONMENT_POLICY);
		}
	}
	const registry: ProcessEnvironmentPolicyRegistry = {
		inheritedEnvironmentValue,
		inheritedPolicy,
		activeRanges: new Map(),
		lastExportedValue: undefined,
	};
	host[PROCESS_ENVIRONMENT_POLICY_REGISTRY_KEY] = registry;
	return registry;
}

function publishProcessEnvironmentPolicy(registry: ProcessEnvironmentPolicyRegistry): void {
	if (registry.activeRanges.size === 0) {
		registry.lastExportedValue = undefined;
		if (registry.inheritedEnvironmentValue === undefined) {
			delete process.env[ADAPTIVE_THINKING_POLICY_ENV];
		} else {
			process.env[ADAPTIVE_THINKING_POLICY_ENV] = registry.inheritedEnvironmentValue;
		}
		return;
	}

	const policies = [
		...(registry.inheritedPolicy ? [registry.inheritedPolicy] : []),
		...registry.activeRanges.values(),
	];
	let effectivePolicy: EnvironmentThinkingPolicy;
	try {
		effectivePolicy = intersectEnvironmentThinkingPolicies(policies) ?? FAIL_CLOSED_ENVIRONMENT_POLICY;
	} catch {
		// Disjoint live ranges have no safe representable intersection. Export the
		// same off–off policy used for malformed inherited input rather than choosing
		// either session's wider range.
		effectivePolicy = FAIL_CLOSED_ENVIRONMENT_POLICY;
	}
	registry.lastExportedValue = JSON.stringify(effectivePolicy);
	process.env[ADAPTIVE_THINKING_POLICY_ENV] = registry.lastExportedValue;
}

// ---------------------------------------------------------------------------
// Config I/O (filesystem-bound, not in logic.ts)
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "adaptive-thinking.json");

function readConfig(): Config {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf8");
		return parseConfig(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function writeConfig(cfg: Config): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

function renderStatus(
	ctx: ExtensionContext,
	state: ThinkingState,
	cfg: ResolvedConfig,
	ceilingSource: string,
	currentLevel?: ConfigurableThinkingLevel,
): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		"caair.adaptive-thinking/level",
		`${buildStatusLine(state, cfg, currentLevel)} · ceiling: ${ceilingSource}`,
	);
}

function modelRef(ctx: ExtensionContext): string | null {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
}

function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildModelSpecificSystemPromptBlock(
	ctx: ExtensionContext,
	state: ThinkingState,
	cfg: ResolvedConfig,
	currentLevel: ConfigurableThinkingLevel = effectiveLevel(state),
	available: readonly AgentThinkingLevel[] = availableAgentLevels(cfg, undefined),
): string | null {
	if (!cfg.enabled || available.length === 0 || !ctx.model) return null;
	// Curated per-family profile, or nothing: an unprofiled model degrades to the
	// generic block rather than a guessed per-model claim.
	const profile = resolveModelEffortProfile(ctx.model.provider, ctx.model.id);
	if (!profile) return null;
	return buildModelProfileBlock(profile, {
		modelRef: escapeXmlAttr(modelRef(ctx) ?? "unknown"),
		current: currentLevel,
		available,
	});
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

/**
 * The enum is the levels this model can actually run, not the static agent
 * ladder. Advertising a level the model rejects invites the agent to pick it
 * and then reads back as a broken promise.
 */
function buildSetThinkingEffortSchema(available: readonly AgentThinkingLevel[]): TSchema {
	const levels = (available.length > 0 ? available : AGENT_LEVELS) as readonly [AgentThinkingLevel, ...AgentThinkingLevel[]];
	return Type.Object({
	level: StringEnum(levels, {
		description: `Target thinking effort level. Available on this model: ${levels.join(", ")}.`,
	}),
	scope: Type.Optional(
		StringEnum(["this_response", "next_N", "until_changed"] as const, {
			description:
				'How long the override lasts. "this_response" (default) reverts after the current agent run. "next_N" persists for N user prompts. "until_changed" stays until explicitly changed.',
		}),
	),
	turns: Type.Optional(
		Type.Number({
			description: 'Number of responses to maintain the override. Required when scope is "next_N".',
			minimum: 1,
			maximum: 20,
		}),
	),
	reason: Type.String({
		description:
			"Why you are changing thinking effort. Be specific: name the complexity factor (e.g., 'multi-file refactor across 8 modules', 'debugging race condition in async pipeline').",
	}),
	}) as TSchema;
}

/**
 * Tool prose for the current level set.
 *
 * `description` may name levels: it travels with the schema, which Pi reads
 * from the registry when it builds the request, so it is always current.
 *
 * `promptSnippet` and `promptGuidelines` may **not**. They are baked into Pi's
 * base system prompt when the tool is registered, and `before_agent_start`
 * receives the string captured before its handlers ran. Any level named here
 * would survive into a request whose schema had already moved on. They point at
 * the `<thinking-effort>` block instead, which is rebuilt from live state on
 * every turn and is therefore the one authoritative list.
 */
function buildSetThinkingEffortPrompts(available: readonly AgentThinkingLevel[]): {
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
} {
	const list = available.join(", ");

	return {
		description: `Adjust your own thinking/reasoning depth for the current or upcoming work. Use this to escalate effort for complex tasks or de-escalate for simple ones. The change takes effect on the next LLM call. Levels available on the active model: ${list}.`,
		promptSnippet:
			"Adjust thinking effort dynamically: set_thinking_effort(level, scope?, turns?, reason) — the <thinking-effort> block lists the levels the active model actually offers.",
		promptGuidelines: [
			"Call set_thinking_effort as your FIRST tool call when the task matches the escalation triggers in the <thinking-effort> block — before reading files or running commands. The elevated thinking applies to subsequent LLM calls, not retroactively.",
			"Use the user prompt itself for the preflight. Do not skip escalation just because you plan to inspect files first; if the prompt already signals complexity, set thinking first.",
			"set_thinking_effort accepts only the levels listed in the <thinking-effort> block. That list is authoritative, is narrowed by the active model, and changes when the model changes.",
			"Do not call set_thinking_effort for simple questions, single-file reads, formatting, or routine edits — those are fine at baseline.",
		],
	};
}

export interface SetThinkingEffortInput {
	level: AgentThinkingLevel;
	scope?: OverrideScope;
	turns?: number;
	reason: string;
}

const CONFIGURABLE_LEVEL_USAGE = CONFIGURABLE_LEVELS.join("|");
const BOUND_SPEC_LIST = [...CONFIGURABLE_LEVELS, ...BOUND_SENTINELS].join(", ");

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const environmentRegistry = processEnvironmentPolicyRegistry();
	const environmentRegistration = Symbol("adaptive-thinking session environment range");
	let state: ThinkingState = defaultState(resolveConfigForModel(readConfig(), undefined));
	let effectiveSource: AdaptiveThinkingEffectiveSource = "baseline";
	let activePolicy: SessionThinkingPolicy | undefined;
	let activeDelegatePolicy: SessionThinkingPolicy | undefined;
	let activeEnvironmentPolicy: EnvironmentThinkingPolicy | undefined;
	let activePolicyConfig: ResolvedConfig | undefined;
	let ceilingSource = "config";
	let sessionContext: ExtensionContext | undefined;
	let acceptedPolicySnapshot: {
		requested: SessionThinkingPolicy;
		completed: SessionThinkingPolicy;
		config: ResolvedConfig;
	} | undefined;
	let policyPendingSession = false;
	let pendingEnvironmentError: Error | undefined;
	let fatalSessionError: Error | undefined;
	let selfSetInFlight = false;
	// Last level we set ourselves + when. Used to ignore the async
	// thinking_level_select echo of our own setThinkingLevel() calls
	// (selfSetInFlight alone is insufficient: the event is emitted
	// asynchronously, after the flag has already been cleared).
	let lastSelfSet: { level: ConfigurableThinkingLevel; at: number } | null = null;
	// Most recently observed model (updated from ctx in event handlers),
	// used for compat guards when no ctx is at hand.
	let currentModel: ExtensionContext["model"];
	let modelObservation:
		| { model: ExtensionContext["model"]; capabilitySignature: string }
		| undefined;
	let runtimeFallbackLevel: ConfigurableThinkingLevel | undefined;
	let lastSnapshotSignature: string | undefined;
	let sessionReady = false;

	function refreshStatus(
		ctx: ExtensionContext,
		currentState: ThinkingState,
		cfg: ResolvedConfig,
		currentLevel?: ConfigurableThinkingLevel,
	): void {
		renderStatus(ctx, currentState, cfg, ceilingSource, currentLevel);
	}

	function displayedLevel(): ConfigurableThinkingLevel {
		return runtimeFallbackLevel ?? effectiveLevel(state);
	}

	/**
	 * The model's own level ladder, in canonical order. `undefined` means no
	 * model has been observed yet, which callers must treat as "do not filter"
	 * rather than "nothing is supported".
	 */
	function modelLadder(model: ExtensionContext["model"] = currentModel): readonly RuntimeThinkingLevel[] | undefined {
		if (!model) return undefined;
		return modelSafeThinkingLevels(getSupportedThinkingLevels(model), model);
	}

	/** Configuration exactly as written, with sentinel bounds still unresolved. */
	function activeConfigSpec(): Config {
		if (activePolicy) {
			if (!activePolicyConfig) throw new Error("Active session thinking policy is missing its accepted configuration");
			return activePolicyConfig;
		}
		return readConfig();
	}

	function activeConfig(): ResolvedConfig {
		if (activePolicy) {
			if (!activePolicyConfig) throw new Error("Active session thinking policy is missing its accepted configuration");
			return activePolicyConfig;
		}
		return resolveConfigForModel(readConfig(), modelLadder());
	}

	/** Levels `set_thinking_effort` may offer for the model in hand. */
	function availableLevels(cfg: ResolvedConfig = activeConfig()): AgentThinkingLevel[] {
		return availableAgentLevels(cfg, modelLadder());
	}

	function completePolicy(policy: SessionThinkingPolicy, cfg: ResolvedConfig): SessionThinkingPolicy {
		return {
			...policy,
			baseline: cfg.baseline,
			minLevel: cfg.minLevel,
			maxLevel: cfg.maxLevel,
		};
	}

	function readEnvironmentPolicy(ctx?: ExtensionContext): EnvironmentThinkingPolicy | undefined {
		const raw = process.env[ADAPTIVE_THINKING_POLICY_ENV];
		const isManagedProcessExport =
			environmentRegistry.activeRanges.size > 0 && raw === environmentRegistry.lastExportedValue;
		if (isManagedProcessExport) return environmentRegistry.inheritedPolicy;
		if (raw === undefined) return undefined;
		try {
			return normalizeEnvironmentThinkingPolicy(JSON.parse(raw));
		} catch (error) {
			const failClosedPolicy: EnvironmentThinkingPolicy = {
				version: 1,
				thinkingMin: "off",
				thinkingMax: "off",
			};
			process.env[ADAPTIVE_THINKING_POLICY_ENV] = JSON.stringify(failClosedPolicy);
			const message = `Invalid ${ADAPTIVE_THINKING_POLICY_ENV}; refusing to run with wider bounds: ${error instanceof Error ? error.message : String(error)}`;
			pendingEnvironmentError = new Error(message);
			if (ctx?.hasUI) ctx.ui.notify(message, "warning");
			throw pendingEnvironmentError;
		}
	}

	function sourceForCeiling(
		cfg: ResolvedConfig,
		environmentPolicy: EnvironmentThinkingPolicy | undefined,
		delegatePolicy: SessionThinkingPolicy | undefined,
		effectiveCfg: ResolvedConfig,
	): string {
		const sources: string[] = [];
		if (cfg.maxLevel === effectiveCfg.maxLevel) sources.push("config");
		if (environmentPolicy?.thinkingMax === effectiveCfg.maxLevel) sources.push("env");
		if (delegatePolicy?.maxLevel === effectiveCfg.maxLevel) sources.push("delegate");
		if (sources.length > 0) return sources.join("+");
		if (delegatePolicy) return "delegate";
		if (environmentPolicy) return "env";
		return "config";
	}

	function propagateEnvironmentPolicy(cfg: ResolvedConfig): void {
		environmentRegistry.activeRanges.set(environmentRegistration, environmentPolicyFromConfig(cfg));
		publishProcessEnvironmentPolicy(environmentRegistry);
	}

	function releaseEnvironmentPolicy(): void {
		if (!environmentRegistry.activeRanges.delete(environmentRegistration)) return;
		publishProcessEnvironmentPolicy(environmentRegistry);
	}

	function policyForEffectiveConfig(
		environmentPolicy: EnvironmentThinkingPolicy | undefined,
		delegatePolicy: SessionThinkingPolicy | undefined,
		cfg: ResolvedConfig,
	): SessionThinkingPolicy | undefined {
		const identity = delegatePolicy ?? (environmentPolicy ? environmentPolicyAsSessionPolicy(environmentPolicy) : undefined);
		return identity ? completePolicy(identity, cfg) : undefined;
	}

	function matchesAcceptedPolicySnapshot(policy: SessionThinkingPolicy): boolean {
		const snapshot = acceptedPolicySnapshot;
		if (
			!snapshot ||
			policy.protocolVersion !== snapshot.requested.protocolVersion ||
			policy.policyId !== snapshot.requested.policyId ||
			policy.agentName !== snapshot.requested.agentName
		) {
			return false;
		}
		for (const field of ["baseline", "minLevel", "maxLevel"] as const) {
			const supplied = snapshot.requested[field];
			const observed = policy[field];
			if (supplied !== undefined && observed !== supplied) return false;
			if (observed !== undefined && observed !== snapshot.completed[field]) return false;
		}
		return true;
	}

	function failClosed(error: unknown, ctx: ExtensionContext): void {
		const normalized = error instanceof Error ? error : new Error(String(error));
		const firstFailure = fatalSessionError === undefined;
		if (firstFailure) {
			fatalSessionError = normalized;
			console.error(`[adaptive-thinking] ${normalized.message}`);
		}
		// Pi logs and swallows extension-handler exceptions. Abort on every gate:
		// before_agent_start may run before Agent creates an active controller,
		// while before_provider_headers runs after it exists and must re-abort an
		// already-latched failure. Shutdown remains a supplemental first-failure
		// request; the input and provider-adjacent gates are authoritative.
		ctx.abort();
		if (firstFailure) ctx.shutdown();
	}

	function snapshotEffectiveLevel(): ConfigurableThinkingLevel {
		const runtimeLevel = pi.getThinkingLevel();
		if (isConfigurableLevel(runtimeLevel)) return runtimeLevel;
		return boundForCurrentModel(effectiveLevel(state), activeConfig());
	}

	function currentSnapshot(): AdaptiveThinkingSnapshotV1 {
		return createAdaptiveThinkingSnapshot({
			state,
			config: activeConfig(),
			effective: snapshotEffectiveLevel(),
			source: effectiveSource,
			model: currentModel,
		});
	}

	function publishSnapshot(force = false): void {
		if (!pi.events) return;
		const snapshot = currentSnapshot();
		const signature = JSON.stringify(snapshot);
		if (!force && signature === lastSnapshotSignature) return;
		lastSnapshotSignature = signature;
		pi.events.emit(ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL, snapshot);
	}

	if (pi.events) {
		pi.events.on(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, (value) => {
			if (!sessionReady || !value || typeof value !== "object" || Array.isArray(value)) return;
			const request = value as Partial<AdaptiveThinkingSnapshotRequestV1>;
			if (
				request.protocolVersion !== ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION ||
				typeof request.requestId !== "string" ||
				request.requestId.trim().length === 0
			) {
				return;
			}
			pi.events.emit(ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL, {
				protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
				requestId: request.requestId,
				snapshot: currentSnapshot(),
			});
		});
	}

	// This listener is intentionally closure-local. A pi-delegate worker gives
	// each session its own event bus, so accepting a policy cannot affect the
	// global config or another worker/session in this process. The runtime guard
	// keeps lightweight extension-registration consumers that predate pi.events
	// working as ordinary global-config sessions.
	if (pi.events) {
		pi.events.on(ADAPTIVE_THINKING_POLICY_CHANNEL, (value) => {
			let policy: SessionThinkingPolicy;
			let requested: SessionThinkingPolicy;
			try {
				requested = normalizeSessionThinkingPolicy(value);
				const configured = resolveConfigForModel(readConfig(), undefined);
				const inheritedEnvironmentPolicy = readEnvironmentPolicy();
				const environmentPolicy = intersectEnvironmentThinkingPolicies(
					[activeEnvironmentPolicy, inheritedEnvironmentPolicy].filter(
						(candidate): candidate is EnvironmentThinkingPolicy => candidate !== undefined,
					),
				);
				const environmentConfig = environmentPolicy
					? sessionConfig(configured, environmentPolicyAsSessionPolicy(environmentPolicy))
					: configured;
				const baseConfig = sessionReady && activePolicyConfig ? activePolicyConfig : environmentConfig;
				activePolicyConfig = sessionConfig(baseConfig, requested);
				policy = completePolicy(requested, activePolicyConfig);
				activeDelegatePolicy = requested;
				activeEnvironmentPolicy = environmentPolicy;
				activePolicy = policy;
				ceilingSource = sourceForCeiling(configured, environmentPolicy, requested, activePolicyConfig);
				acceptedPolicySnapshot = {
					requested,
					completed: policy,
					config: activePolicyConfig,
				};
				if (sessionReady) {
					propagateEnvironmentPolicy(activePolicyConfig);
					state.baseline = activePolicyConfig.baseline;
					if (state.override) {
						const boundedOverride = clampLevel(state.override, activePolicyConfig);
						state.override = isConfigurableLevel(boundedOverride) && AGENT_LEVELS.includes(boundedOverride as AgentThinkingLevel)
							? boundedOverride as AgentThinkingLevel
							: null;
						if (!state.override) {
							state.scope = null;
							state.turnsRemaining = null;
							state.reason = null;
						}
					}
					applyLevel();
					syncThinkingTool();
					pi.appendEntry(THINKING_POLICY_ENTRY_TYPE, policy);
					pi.appendEntry(ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE, environmentPolicyFromConfig(activePolicyConfig));
					if (sessionContext) refreshStatus(sessionContext, state, activePolicyConfig, displayedLevel());
					publishSnapshot(true);
				}
			} catch {
				// Invalid payloads, incompatible intersections, or malformed inherited
				// policy are rejected without an ACK. The caller cannot assume wider
				// global bounds when this transport fails.
				return;
			}
			policyPendingSession = !sessionReady;
			pi.events.emit(ADAPTIVE_THINKING_POLICY_ACK_CHANNEL, policyAck(policy.policyId));
		});
	}

	function selfSetLevel(level: ConfigurableThinkingLevel): void {
		selfSetInFlight = true;
		lastSelfSet = { level, at: Date.now() };
		pi.setThinkingLevel(level);
		selfSetInFlight = false;
	}

	function isSelfSetEcho(level: ConfigurableThinkingLevel): boolean {
		if (selfSetInFlight) {
			if (lastSelfSet?.level === level) lastSelfSet = null;
			return true;
		}
		if (lastSelfSet && lastSelfSet.level === level && Date.now() - lastSelfSet.at < 2000) {
			lastSelfSet = null; // consume — a later identical change is user-initiated
			return true;
		}
		return false;
	}

	function boundForCurrentModel(level: ConfigurableThinkingLevel, cfg: ResolvedConfig): ConfigurableThinkingLevel {
		// Guard first, then re-clamp: a model compatibility fallback must never
		// escape the active worker's session-local range.
		const guarded = guardLevelForModel(level, currentModel);
		const bounded = activePolicy ? clampLevel(guarded, cfg) : guarded;
		if (modelRejectsDisabledThinking(currentModel) && bounded === "off") {
			throw new Error(
				`Session thinking policy bounds ${cfg.minLevel}–${cfg.maxLevel} are incompatible with model ${currentModel?.id ?? "(unknown)"}, which requires at least minimal thinking.`,
			);
		}
		return bounded;
	}

	function managedRuntimeLevel(level: string): ConfigurableThinkingLevel | undefined {
		return isConfigurableLevel(level) ? level : undefined;
	}

	function modelCapabilitySignature(model: ExtensionContext["model"]): string {
		if (!model) return "none";
		return JSON.stringify({
			supportedThinkingLevels: getSupportedThinkingLevels(model),
			forceAdaptiveThinking: modelRejectsDisabledThinking(model),
		});
	}

	function observeModel(model: ExtensionContext["model"]): boolean {
		const capabilitySignature = modelCapabilitySignature(model);
		const changed =
			modelObservation === undefined ||
			modelObservation.model !== model ||
			modelObservation.capabilitySignature !== capabilitySignature;
		currentModel = model;
		modelObservation = { model, capabilitySignature };
		return changed;
	}

	function reconcileObservedModel(model: ExtensionContext["model"], ctx: ExtensionContext): boolean {
		const changed = observeModel(model);
		if (!changed) return false;
		// Sentinel bounds move with the model, so re-resolve after observing it
		// rather than reusing a range computed for the previous one.
		const cfg = activeConfig();
		refreshRuntimeLevelForModel(model, cfg);
		propagateEnvironmentPolicy(cfg);
		syncThinkingTool();
		refreshStatus(ctx, state, cfg, displayedLevel());
		publishSnapshot();
		return true;
	}

	function modelSafeCandidates(
		model: ExtensionContext["model"] = currentModel,
		cfg: ResolvedConfig = activeConfig(),
		constrainToConfig = false,
	): ConfigurableThinkingLevel[] {
		if (!model) return [];
		return modelSafeThinkingLevels(
			getSupportedThinkingLevels(model),
			model,
			(activePolicy || constrainToConfig) ? cfg : undefined,
		);
	}

	function safeLevelForModel(level: ConfigurableThinkingLevel, cfg: ResolvedConfig): ConfigurableThinkingLevel {
		const guarded = boundForCurrentModel(level, cfg);
		if (!currentModel) return guarded;
		const candidates = modelSafeCandidates(currentModel, cfg, Boolean(state.override) || Boolean(activePolicy));
		if (candidates.includes(guarded)) return guarded;
		const fallback = fallbackThinkingLevel(guarded, candidates);
		if (!fallback) {
			throw new Error(`Model ${currentModel.id} exposes no safe thinking level for runtime selection`);
		}
		return fallback;
	}

	function refreshRuntimeLevelForModel(model: ExtensionContext["model"], cfg: ResolvedConfig): void {
		if (!model) return;
		const desired = boundForCurrentModel(effectiveLevel(state), cfg);
		const candidates = modelSafeCandidates(model, cfg, Boolean(state.override) || Boolean(activePolicy));
		const target = candidates.includes(desired) ? desired : fallbackThinkingLevel(desired, candidates);
		if (!target) throw new Error(`Model ${model.id} exposes no safe thinking level for runtime selection`);
		runtimeFallbackLevel = target === desired ? undefined : target;
		if (pi.getThinkingLevel() !== target) selfSetLevel(target);
	}

	// Apply the effective thinking level to pi.
	function applyLevel(): void {
		const desired = effectiveLevel(state);
		const level = safeLevelForModel(desired, activeConfig());
		runtimeFallbackLevel = level === desired ? undefined : level;
		const current = pi.getThinkingLevel();
		if (current !== level) selfSetLevel(level);
	}

	// Revert override and apply baseline
	function revertToBaseline(source: AdaptiveThinkingEffectiveSource = "baseline"): void {
		state.override = null;
		state.scope = null;
		state.turnsRemaining = null;
		state.reason = null;
		effectiveSource = source;
		applyLevel();
	}

	// -- Tool surface ---------------------------------------------------------
	// The tool's enum and prose are rebuilt whenever the model or the bounds
	// change, so the agent is never offered a level this model would reject.
	//
	// Every rebuild must happen BEFORE Pi assembles the turn's system prompt.
	// `pi.registerTool` rebuilds Pi's base prompt, but `before_agent_start`
	// receives the string captured before its handlers ran, and the value that
	// handler returns replaces the rebuild. So nothing baked into that prompt
	// may name a level: `promptSnippet` and `promptGuidelines` defer to the
	// `<thinking-effort>` block, which is rebuilt from live state every turn.

	const TOOL_NAME = "set_thinking_effort";
	let registeredToolSignature: string | undefined;


	function toolSurfaceSignature(available: readonly AgentThinkingLevel[], cfg: ResolvedConfig): string {
		return JSON.stringify([available, currentModel?.id ?? null, cfg.enabled]);
	}

	function registerThinkingTool(available: readonly AgentThinkingLevel[]): void {
		const prompts = buildSetThinkingEffortPrompts(available);
		pi.registerTool({
			name: TOOL_NAME,
			label: "Thinking Effort",
			description: prompts.description,
			promptSnippet: prompts.promptSnippet,
			promptGuidelines: prompts.promptGuidelines,
			parameters: buildSetThinkingEffortSchema(available),
			execute: executeSetThinkingEffort,
		});
	}

	/**
	 * Add or remove the tool from the active set without disturbing anyone
	 * else's. Only acts when our own membership is actually wrong, so a
	 * concurrent extension's tool selection survives.
	 */
	function setToolActive(active: boolean): void {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		const current = pi.getActiveTools();
		if (!Array.isArray(current)) return;
		if (current.includes(TOOL_NAME) === active) return;
		pi.setActiveTools(active ? [...current, TOOL_NAME] : current.filter((name) => name !== TOOL_NAME));
	}

	/**
	 * Whether Pi currently has the tool active — asked of Pi, never inferred.
	 *
	 * Wanting the tool active is not the same as having it. Pi filters its
	 * registry through `--tools`, `--exclude-tools`, and `--no-tools` first, so
	 * an activation for an excluded name is silently dropped. `undefined` means
	 * the runtime is not bound yet and the question cannot be answered.
	 */
	function toolIsActive(): boolean | undefined {
		if (typeof pi.getActiveTools !== "function") return undefined;
		const current = pi.getActiveTools();
		if (!Array.isArray(current)) return undefined;
		return current.includes(TOOL_NAME);
	}

	/**
	 * Whether the base prompt captured for this request advertises the tool.
	 *
	 * Mirrors Pi's own rule in `buildSystemPrompt`: a custom prompt lists no
	 * tools at all and returns before that section, and a generated prompt lists
	 * a tool only when it is in `selectedTools` and supplies a snippet.
	 */
	function promptAdvertisesTool(options: unknown): boolean {
		if (!options || typeof options !== "object") return false;
		const parsed = options as { customPrompt?: unknown; selectedTools?: unknown; toolSnippets?: unknown };
		if (typeof parsed.customPrompt === "string" && parsed.customPrompt.length > 0) return false;
		if (!Array.isArray(parsed.selectedTools) || !parsed.selectedTools.includes(TOOL_NAME)) return false;
		if (!parsed.toolSnippets || typeof parsed.toolSnippets !== "object") return false;
		return Boolean((parsed.toolSnippets as Record<string, unknown>)[TOOL_NAME]);
	}

	/**
	 * Re-register only when the offered set actually changed.
	 *
	 * Safe from any hook. The enum and `description` travel with the schema, and
	 * the baked-in prose names no level, so a rebuild cannot contradict a prompt
	 * already in flight. Only the tool's presence can — see
	 * `toolPresenceDriftError`.
	 */
	function syncThinkingTool(): void {
		const cfg = activeConfig();
		const available = availableLevels(cfg);
		const signature = toolSurfaceSignature(available, cfg);
		if (signature === registeredToolSignature) return;
		registeredToolSignature = signature;
		if (available.length === 0) {
			setToolActive(false);
			return;
		}
		registerThinkingTool(available);
		setToolActive(true);
	}

	/**
	 * Report a tool the captured prompt advertises having since gone away.
	 *
	 * Pi lists the active tools in the base system prompt, and
	 * `before_agent_start` cannot rewrite that line: the string it returns is
	 * built on the one captured before it ran. A prompt that offers a tool the
	 * request will not carry is the contradiction worth aborting for, as the
	 * provider boundary already does for late level drift.
	 *
	 * Nothing else here is drift. A prompt that never advertised the tool — a
	 * custom system prompt, or a session where Pi filtered the tool out — has no
	 * stale line to contradict. Neither does a change in *which* levels are
	 * offered: the schema is read fresh at request time and the
	 * `<thinking-effort>` block is rebuilt below from the same live state.
	 */
	function toolPresenceDriftError(advertisedAtAssembly: boolean): Error | undefined {
		if (!advertisedAtAssembly || toolIsActive() !== false) return undefined;
		return new Error(
			`set_thinking_effort became unavailable on ${currentModel?.id ?? "(unknown)"} after the system prompt was ` +
				"assembled, which already offers it. Aborting rather than sending a prompt that disagrees with the active tools.",
		);
	}


	// -- Session lifecycle --------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		sessionReady = false;
		fatalSessionError = undefined;
		modelObservation = undefined;
		sessionContext = ctx;
		try {
			currentModel = ctx.model;
			if (pendingEnvironmentError) {
				if (ctx.hasUI) ctx.ui.notify(pendingEnvironmentError.message, "warning");
				throw pendingEnvironmentError;
			}
			const cfg = readConfig();
			const entries = ctx.sessionManager.getEntries();
			// A factory can be exercised across multiple session_start events. Only
			// carry an event-delivered policy into the session it was delivered for;
			// otherwise recover from this session's persisted entries.
			const deliveredPolicy = policyPendingSession ? activePolicy : undefined;
			const deliveredDelegate = policyPendingSession ? activeDelegatePolicy : undefined;
			const deliveredConfig = policyPendingSession ? activePolicyConfig : undefined;
			const liveEnvironmentPolicy = policyPendingSession ? activeEnvironmentPolicy : readEnvironmentPolicy(ctx);
			const persistedEnvironmentPolicy = findEnvironmentThinkingPolicy(entries);
			const environmentPolicy = intersectEnvironmentThinkingPolicies(
				[liveEnvironmentPolicy, persistedEnvironmentPolicy].filter(
					(policy): policy is EnvironmentThinkingPolicy => policy !== undefined,
				),
			);
			const persistedPolicy = findSessionThinkingPolicy(entries);
			const recoveredPolicy = deliveredDelegate ?? persistedPolicy;
			policyPendingSession = false;
			const matchingSnapshot =
				deliveredPolicy === undefined && recoveredPolicy && matchesAcceptedPolicySnapshot(recoveredPolicy)
					? acceptedPolicySnapshot
					: undefined;
			const hasSessionPolicy = Boolean(environmentPolicy || recoveredPolicy);
			// Sentinel bounds resolve against the model only for ordinary sessions.
			// An inherited or delegated ceiling must not widen with the child model.
			const globalFallback = resolveConfigForModel(cfg, hasSessionPolicy ? undefined : modelLadder(ctx.model));
			let effectiveCfg = deliveredConfig ?? matchingSnapshot?.config ?? globalFallback;
			if (environmentPolicy) {
				effectiveCfg = sessionConfig(effectiveCfg, environmentPolicyAsSessionPolicy(environmentPolicy));
			}
			if (persistedPolicy) effectiveCfg = sessionConfig(effectiveCfg, persistedPolicy);
			if (deliveredDelegate) effectiveCfg = sessionConfig(effectiveCfg, deliveredDelegate);
			activeDelegatePolicy = recoveredPolicy;
			activeEnvironmentPolicy = environmentPolicy;
			activePolicy = policyForEffectiveConfig(environmentPolicy, recoveredPolicy, effectiveCfg);
			activePolicyConfig = activePolicy ? effectiveCfg : undefined;
			ceilingSource = sourceForCeiling(globalFallback, environmentPolicy, recoveredPolicy, effectiveCfg);
			if (environmentPolicy) {
				pi.appendEntry(ENVIRONMENT_THINKING_POLICY_ENTRY_TYPE, environmentPolicyFromConfig(effectiveCfg));
			}
			if (
				recoveredPolicy &&
				(deliveredPolicy !== undefined ||
					recoveredPolicy.baseline === undefined ||
					recoveredPolicy.minLevel === undefined ||
					recoveredPolicy.maxLevel === undefined)
			) {
				// Persist the completed immutable range after accepting/recovering a
				// one-sided policy so future restarts cannot reread mutable fallbacks.
				pi.appendEntry(THINKING_POLICY_ENTRY_TYPE, completePolicy(recoveredPolicy, effectiveCfg));
			}
			propagateEnvironmentPolicy(effectiveCfg);
			if (activePolicy && modelRejectsDisabledThinking(currentModel) && effectiveCfg.maxLevel === "off") {
				throw new Error(
					`Session thinking policy bounds ${effectiveCfg.minLevel}–${effectiveCfg.maxLevel} are incompatible with model ${currentModel?.id ?? "(unknown)"}, which requires at least minimal thinking.`,
				);
			}
			state = defaultState(effectiveCfg);
			observeModel(ctx.model);

			// Reconstruct from session entries.
			for (const entry of ctx.sessionManager.getEntries()) {
				if (
					entry.type === "custom" &&
					(entry as { customType?: string }).customType === "adaptive-thinking-state"
				) {
					const data = (entry as { data?: unknown }).data;
					if (activePolicy) {
						const restored = normalizePersistedThinkingState(data, effectiveCfg, activePolicy.baseline);
						Object.assign(state, restored);
					} else if (data && typeof data === "object" && !Array.isArray(data)) {
						const legacyState = data as Partial<ThinkingState>;
						state.baseline = legacyState.baseline ?? effectiveCfg.baseline;
						state.override = legacyState.override ?? null;
						state.scope = legacyState.scope ?? null;
						state.turnsRemaining = legacyState.turnsRemaining ?? null;
						state.reason = legacyState.reason ?? null;
					}
				}
			}
			effectiveSource = state.override ? "agent" : "baseline";

			applyLevel();
			syncThinkingTool();
			refreshStatus(ctx, state, activeConfig(), displayedLevel());
			lastSnapshotSignature = undefined;
			sessionReady = true;
			publishSnapshot(true);
		} catch (error) {
			policyPendingSession = false;
			pendingEnvironmentError = undefined;
			releaseEnvironmentPolicy();
			activePolicy = undefined;
			activeDelegatePolicy = undefined;
			activeEnvironmentPolicy = undefined;
			activePolicyConfig = undefined;
			modelObservation = undefined;
			failClosed(error, ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("caair.adaptive-thinking/level", undefined);
		sessionReady = false;
		releaseEnvironmentPolicy();
		sessionContext = undefined;
		activePolicy = undefined;
		activeDelegatePolicy = undefined;
		activeEnvironmentPolicy = undefined;
		activePolicyConfig = undefined;
		policyPendingSession = false;
		currentModel = undefined;
		modelObservation = undefined;
		runtimeFallbackLevel = undefined;
		lastSnapshotSignature = undefined;
	});

	pi.on("input", (_event, ctx) => {
		if (fatalSessionError) return { action: "handled" as const };
		try {
			reconcileObservedModel(ctx.model, ctx);
			const cfg = activeConfig();
			// The last point before Pi assembles this turn's prompt, so it is the
			// last chance to rebuild the tool surface and inherited child policy.
			// Catches an out-of-band config edit as well as a model change.
			propagateEnvironmentPolicy(cfg);
			syncThinkingTool();
			if (activePolicy) {
				const selected = pi.getThinkingLevel();
				const managedLevel = managedRuntimeLevel(selected);
				if (managedLevel) {
					const safeLevel = boundForCurrentModel(managedLevel, cfg);
					if (selected !== safeLevel) selfSetLevel(safeLevel);
				}
			}
		} catch (error) {
			failClosed(error, ctx);
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});

	// -- System prompt injection --------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		if (fatalSessionError) return { systemPrompt: event.systemPrompt };
		try {
			// Safety net for keybind changes, stale settings, and model switches.
			// Model compatibility remains subordinate to a delegated session range.
			//
			// Pi lists the active tools in the base prompt it captured before this
			// handler ran, and the string returned below is built on that one, so
			// a tool that disappears here cannot be taken back out of it. Read
			// what that prompt actually advertises rather than trusting a cached
			// flag: Pi may have filtered the tool out entirely, or the prompt may
			// be a custom one that lists no tools.
			const advertisedAtAssembly = promptAdvertisesTool(event.systemPromptOptions);
			reconcileObservedModel(ctx.model, ctx);
			// Read the range after reconciling: a model switch can move a sentinel
			// bound, and the prompt must describe the model about to run.
			const cfg = activeConfig();
			propagateEnvironmentPolicy(cfg);
			const selected = pi.getThinkingLevel();
			const managedLevel = managedRuntimeLevel(selected);
			if (managedLevel) {
				const safeLevel = boundForCurrentModel(managedLevel, cfg);
				if (selected !== safeLevel) selfSetLevel(safeLevel);
			}
			syncThinkingTool();
			const drift = toolPresenceDriftError(advertisedAtAssembly);
			if (drift) throw drift;
			const ladder = modelLadder();
			// Pi may have filtered the tool out of its registry entirely, in which
			// case no level is selectable however capable the model is. That is a
			// different fact from the intersection being empty, and only counts
			// when we asked for the tool and Pi still does not have it.
			const modelAvailable = availableAgentLevels(cfg, ladder);
			const toolFilteredOut = modelAvailable.length > 0 && toolIsActive() === false;
			const available = toolFilteredOut ? [] : modelAvailable;
			const promptModel = {
				available,
				withheld: toolFilteredOut ? [] : modelWithheldLevels(cfg, ladder),
				modelId: currentModel?.id ?? null,
				toolFilteredOut,
			};
			const block = buildSystemPromptBlock(state, cfg, displayedLevel(), promptModel);
			const modelBlock = buildModelSpecificSystemPromptBlock(ctx, state, cfg, displayedLevel(), available);
			return { systemPrompt: `${event.systemPrompt}\n\n${block}${modelBlock ? `\n\n${modelBlock}` : ""}` };
		} catch (error) {
			failClosed(error, ctx);
			return { systemPrompt: event.systemPrompt };
		}
	});

	// Last synchronous gate before provider transport. A pre-run abort from
	// before_agent_start is not sticky because Agent has not created its active
	// run yet; at this hook the run's AbortController exists. Revalidate instead
	// of mutating: payload construction has already begun, so any late drift is
	// aborted rather than silently rewritten after the fact.
	pi.on("before_provider_headers", (_event, ctx) => {
		try {
			if (fatalSessionError) throw fatalSessionError;
			currentModel = ctx.model;
			const cfg = activeConfig();
			propagateEnvironmentPolicy(cfg);
			const selected = pi.getThinkingLevel();
			const managedLevel = managedRuntimeLevel(selected);
			if (!managedLevel) {
				throw new Error(`Adaptive thinking cannot validate unmanaged runtime level ${JSON.stringify(selected)}`);
			}
			if (ctx.model && managedLevel) {
				const candidates = modelSafeCandidates(ctx.model, cfg, Boolean(state.override) || Boolean(activePolicy));
				if (!candidates.includes(managedLevel)) {
					throw new Error(
						`Detected late runtime drift to unsupported thinking level ${selected} for model ${ctx.model.id} before provider transport`,
					);
				}
			}
			if (activePolicy && managedLevel) {
				const safeLevel = boundForCurrentModel(managedLevel, cfg);
				if (selected !== safeLevel) {
					throw new Error(
						`Session thinking policy detected late runtime drift from ${safeLevel} to ${selected} before provider transport`,
					);
				}
			}
		} catch (error) {
			failClosed(error, ctx);
		}
	});

	// -- Agent lifecycle (decay logic) --------------------------------------

	pi.on("agent_start", async () => {
		state.inAgentRun = true;
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.inAgentRun = false;

		if (!state.override || !state.scope) return;

		switch (state.scope) {
			case "this_response": {
				const previous = displayedLevel();
				revertToBaseline();
				if (ctx.hasUI) {
					ctx.ui.notify(`Thinking reverted: ${previous} → ${displayedLevel()} (response complete)`, "info");
				}
				break;
			}

			case "next_N":
				if (state.turnsRemaining !== null && state.turnsRemaining > 0) {
					state.turnsRemaining--;
					if (state.turnsRemaining <= 0) {
						const previous = displayedLevel();
						revertToBaseline();
						if (ctx.hasUI) {
							ctx.ui.notify(`Thinking reverted: ${previous} → ${displayedLevel()} (turn count exhausted)`, "info");
						}
					}
				}
				break;

			case "until_changed":
				// No auto-decay
				break;
		}

		// Persist state
		pi.appendEntry("adaptive-thinking-state", { ...state });
		refreshStatus(ctx, state, activeConfig(), displayedLevel());
		publishSnapshot();
	});

	// -- Status updates -----------------------------------------------------

	pi.on("turn_end", async (_event, ctx) => {
		refreshStatus(ctx, state, activeConfig(), displayedLevel());
	});

	pi.on("model_select", (event, ctx) => {
		observeModel(event.model);
		try {
			const cfg = activeConfig();
			refreshRuntimeLevelForModel(event.model, cfg);
			propagateEnvironmentPolicy(cfg);
		} catch (error) {
			// The next provider gate remains authoritative, but refresh failures
			// must still latch the session before another run can start.
			failClosed(error, ctx);
		}
		syncThinkingTool();
		refreshStatus(ctx, state, activeConfig(), displayedLevel());
		publishSnapshot();
	});

	function adoptManualLevel(level: ConfigurableThinkingLevel, selectedLevel: ConfigurableThinkingLevel, ctx: ExtensionContext): void {
		runtimeFallbackLevel = undefined;
		state.baseline = level;
		state.override = null;
		state.scope = null;
		state.turnsRemaining = null;
		state.reason = null;
		effectiveSource = "user";

		// Delegated policy sessions are session-local. Never persist a manual
		// selection from one worker into the user's global adaptive config.
		if (!activePolicy && selectedLevel !== "max") {
			try {
				const cfg = readConfig();
				cfg.baseline = level;
				writeConfig(cfg);
			} catch {
				// non-fatal
			}
		}

		refreshStatus(ctx, state, activeConfig(), displayedLevel());
		publishSnapshot();
	}

	async function changeThinkingDirection(direction: "higher" | "lower", ctx: ExtensionContext): Promise<void> {
		const cfg = activeConfig();
		reconcileObservedModel(ctx.model, ctx);
		const candidates = modelSafeCandidates(ctx.model, cfg);
		if (!ctx.model || candidates.length === 0) {
			ctx.ui.notify("No active model-safe thinking levels are available.", "warning");
			return;
		}
		const current = pi.getThinkingLevel();
		const target = adjacentThinkingLevel(current, candidates, direction);
		if (!target) {
			ctx.ui.notify(
				`${direction === "higher" ? "Higher" : "Lower"} thinking level is already at the ${direction === "higher" ? "highest" : "lowest"} available candidate.`,
				"info",
			);
			return;
		}
		if (!candidates.includes(target)) return;
		selfSetLevel(target);
		adoptManualLevel(target, target, ctx);
		ctx.ui.notify(`Thinking level changed: ${current} → ${target}.`, "info");
	}

	// -- User manual override detection -------------------------------------
	// If the user manually changes thinking level (via /model, Ctrl+T, etc.),
	// it becomes the new baseline and clears any agent override.
	// selfSetInFlight (set by applyLevel) prevents our own calls from
	// being treated as user-initiated.

	pi.on("thinking_level_select", async (event, ctx) => {
		const selectedLevel = event.level;

		// AgentSession.setModel() changes the active model before it re-clamps
		// Pi's thinking level, then may suppress model_select for a same-identity
		// replacement. Classify that event from Pi's clamp invariants before any
		// reconciliation can overwrite a genuine manual selection.
		const previousObservation = modelObservation;
		const previousDisplayedLevel = displayedLevel();
		const previousRuntimeLevel = managedRuntimeLevel(pi.getThinkingLevel());
		const previousEventLevel = managedRuntimeLevel(event.previousLevel);
		try {
			const modelChanged = observeModel(ctx.model);
			const cfg = activeConfig();
			if (modelChanged) {
				propagateEnvironmentPolicy(cfg);
				const candidates = modelSafeCandidates(ctx.model, cfg);
				const expectedFallback = previousEventLevel
					? fallbackThinkingLevel(previousEventLevel, candidates)
					: undefined;
				const automaticClamp =
					previousObservation !== undefined &&
					previousEventLevel !== undefined &&
					isConfigurableLevel(selectedLevel) &&
					previousRuntimeLevel === selectedLevel &&
					previousDisplayedLevel === previousEventLevel &&
					!candidates.includes(previousEventLevel) &&
					expectedFallback === selectedLevel &&
					selectedLevel !== previousEventLevel;

				if (automaticClamp) {
					refreshRuntimeLevelForModel(ctx.model, cfg);
					refreshStatus(ctx, state, cfg, displayedLevel());
					publishSnapshot();
					return;
				}
			}
		} catch (error) {
			failClosed(error, ctx);
			return;
		}

		if (!isConfigurableLevel(selectedLevel)) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Thinking level "${selectedLevel}" is not managed by adaptive-thinking; keeping baseline ${state.baseline}.`,
					"warning",
				);
			}
			refreshStatus(ctx, state, activeConfig(), displayedLevel());
			return;
		}

		// Ignore events we triggered ourselves.
		if (isSelfSetEcho(selectedLevel)) return;

		const boundedLevel = activePolicy ? clampLevel(selectedLevel, activeConfig()) : selectedLevel;
		if (selectedLevel !== boundedLevel) {
			selfSetLevel(boundedLevel);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Thinking level "${selectedLevel}" is outside this session policy's bounds — using "${boundedLevel}" instead.`,
					"warning",
				);
			}
		}

		// Workaround for pi/issues/5569 (pi <= 0.79.1): "off" sends
		// thinking.type.disabled, which adaptive-thinking models
		// (claude-fable-5 etc.) reject with a 400. Redirect to "minimal"
		// and do NOT adopt "off" as the baseline.
		//
		// This correction is silent. Several catalog models carry
		// `compat.forceAdaptiveThinking` while their `thinkingLevelMap` still
		// omits `"off": null`, so Pi's own thinking cycle keeps offering `off`
		// and a warning here would fire on every pass through it. The level
		// simply never applies. Removing `off` from the cycle itself is a
		// `modelOverrides` fix in models.json, not something an extension can do.
		if (boundedLevel === "off" && modelRejectsDisabledThinking(currentModel)) {
			let guardedLevel: ConfigurableThinkingLevel;
			try {
				guardedLevel = boundForCurrentModel("off", activeConfig());
			} catch (error) {
				failClosed(error, ctx);
				return;
			}
			runtimeFallbackLevel = guardedLevel;
			selfSetLevel(guardedLevel);
			effectiveSource = "user";
			refreshStatus(ctx, state, activeConfig(), displayedLevel());
			publishSnapshot();
			return;
		}

		// This is a user-initiated change — adopt it as the new baseline.
		adoptManualLevel(boundedLevel, selectedLevel, ctx);
	});

	// -- Tool: set_thinking_effort ------------------------------------------

	const executeSetThinkingEffort: Parameters<ExtensionAPI["registerTool"]>[0]["execute"] = async (
		_toolCallId,
		params,
		_signal,
		_onUpdate,
		ctx,
	) => {
		{
			const input = params as SetThinkingEffortInput;
			const cfg = activeConfig();
			const resolution = resolveThinkingEffortRequest(
				{
					level: input.level,
					scope: input.scope,
					turns: input.turns,
					reason: input.reason,
				},
				cfg,
				availableLevels(cfg),
				currentModel?.id ?? null,
			);

			if (!resolution.ok) {
				return {
					content: [
						{
							type: "text",
							text: resolution.message,
						},
					],
					details: resolution.details,
					isError: resolution.isError,
				};
			}

			const reason = input.reason;

			const previousLevel = displayedLevel();

			// Apply override
			state.override = resolution.level;
			state.scope = resolution.scope;
			state.turnsRemaining = resolution.scope === "next_N" ? resolution.turns : null;
			state.reason = reason;
			effectiveSource = "agent";

			applyLevel();

			// Persist
			pi.appendEntry("adaptive-thinking-state", { ...state });
			refreshStatus(ctx, state, activeConfig(), displayedLevel());
			publishSnapshot();

			const newLevel = displayedLevel();

			return {
				content: [
					{
						type: "text",
						text: buildThinkingEffortSuccessText({
							previousLevel,
							newLevel,
							baseline: state.baseline,
							requestedLevel: resolution.requestedLevel,
							level: resolution.level,
							scope: resolution.scope,
							turns: resolution.turns,
							reason,
							wasClamped: resolution.wasClamped,
							cfg,
						}),
					},
				],
				details: {
					previous_level: previousLevel,
					new_level: newLevel,
					requested_level: resolution.requestedLevel,
					was_clamped: resolution.wasClamped,
					scope: resolution.scope,
					turns_remaining: state.turnsRemaining,
					baseline: state.baseline,
					allowed_range: [cfg.minLevel, cfg.maxLevel],
					reason,
				},
			};
		}
	};

	// Registered eagerly so the tool exists before the first session. Bounds and
	// model capability narrow the enum from session_start onwards.
	//
	// `syncThinkingTool` cannot run here: it reaches for the active tool list,
	// which throws before Pi binds the extension runtime. Record the signature
	// by hand so the first real sync compares against what was registered rather
	// than against `undefined`.
	{
		const initialConfig = resolveConfigForModel(readConfig(), undefined);
		const initialAvailable = availableAgentLevels(initialConfig, undefined);
		registerThinkingTool(initialAvailable);
		registeredToolSignature = toolSurfaceSignature(initialAvailable, initialConfig);
	}


	// -- Commands -----------------------------------------------------------

	const higherDescription = "Move thinking up one fresh model-supported level; stop at the highest endpoint without wrapping.";
	const lowerDescription = "Move thinking down one fresh model-supported level; stop at the lowest endpoint without wrapping.";
	pi.registerCommand("thinking-higher", {
		description: higherDescription,
		handler: async (_args, ctx) => changeThinkingDirection("higher", ctx),
	});
	pi.registerCommand("thinking-lower", {
		description: lowerDescription,
		handler: async (_args, ctx) => changeThinkingDirection("lower", ctx),
	});
	pi.registerShortcut("alt+.", {
		description: "Move thinking up one model-supported level without wrapping",
		handler: (ctx) => changeThinkingDirection("higher", ctx),
	});
	pi.registerShortcut("alt+,", {
		description: "Move thinking down one model-supported level without wrapping",
		handler: (ctx) => changeThinkingDirection("lower", ctx),
	});

	pi.registerCommand("thinking-baseline", {
		description:
			`Get/set the baseline thinking level. Usage: /thinking-baseline <${CONFIGURABLE_LEVEL_USAGE}|status>`,
		getArgumentCompletions: (prefix) => {
			const items = [
				...CONFIGURABLE_LEVELS.map((level) => ({
					value: level,
					label: level === "medium" ? "medium (default)" : level === "max" ? "max — provider maximum" : level,
				})),
				{ value: "status", label: "status — show current baseline" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg || arg === "status") {
				const cfg = activeConfig();
				ctx.ui.notify(
					`Baseline: ${cfg.baseline}\nBounds: ${cfg.minLevel}–${cfg.maxLevel}\nEnabled: ${cfg.enabled}\nCurrent effective: ${displayedLevel()}${state.override ? ` (override: ${state.override}, scope: ${state.scope})` : ""}`,
					"info",
				);
				return;
			}

			const validLevels = CONFIGURABLE_LEVELS;
			if (!validLevels.includes(arg as ConfigurableThinkingLevel)) {
				ctx.ui.notify(
					`Usage: /thinking-baseline <${CONFIGURABLE_LEVEL_USAGE}|status>`,
					"warning",
				);
				return;
			}

			try {
				const cfg = readConfig();
				const requested = arg as ConfigurableThinkingLevel;
				const baseline = activePolicy ? clampLevel(requested, activeConfig()) : requested;
				if (!activePolicy) {
					cfg.baseline = baseline;
					writeConfig(cfg);
				}
				state.baseline = baseline;
				if (!state.override) effectiveSource = "user";

				// If no override, apply immediately
				if (!state.override) {
					applyLevel();
				}

				refreshStatus(ctx, state, activeConfig(), displayedLevel());
				publishSnapshot();
				ctx.ui.notify(
					`Baseline set to: ${baseline}${baseline !== requested ? ` (requested ${requested}, clamped to session bounds)` : ""}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("thinking-status", {
		description: "Show full adaptive thinking state.",
		handler: async (_args, ctx) => {
			const spec = activeConfigSpec();
			const cfg = activeConfig();
			const ladder = modelLadder();
			const available = availableAgentLevels(cfg, ladder);
			const withheld = modelWithheldLevels(cfg, ladder);
			const lines: string[] = [
				`Baseline: ${state.baseline}`,
				`Effective level: ${displayedLevel()}`,
				`Override: ${state.override ?? "(none)"}`,
				`Scope: ${state.scope ?? "(none)"}`,
				`Turns remaining: ${state.turnsRemaining ?? "n/a"}`,
				`Reason: ${state.reason ?? "(none)"}`,
				`Bounds: ${boundSpecLabel(spec.minLevel, cfg.minLevel)}–${boundSpecLabel(spec.maxLevel, cfg.maxLevel)} (${allowedLevels(cfg).join(", ")})`,
				`Ceiling source: ${ceilingSource}`,
				`Model: ${currentModel?.id ?? "(none)"}`,
				`Model supports: ${ladder ? ladder.join(", ") || "(nothing)" : "(unknown)"}`,
				`Agent can select: ${available.join(", ") || "(nothing — set_thinking_effort is not offered)"}`,
				...(withheld.length > 0 ? [`Withheld by model: ${withheld.join(", ")}`] : []),
				`Enabled: ${cfg.enabled}`,
				`In agent run: ${state.inAgentRun}`,
				`Config: ${CONFIG_FILE}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("thinking-bounds", {
		description:
			`Get/set the min–max thinking levels the agent can pick from. Usage: /thinking-bounds [<min> <max>|status]. Levels: ${BOUND_SPEC_LIST}.`,
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status — show current bounds" },
				{ value: "low xhigh", label: "low xhigh — full agent range (default)" },
				{ value: "low model-max", label: "low model-max — up to whatever this model's top level is" },
				{ value: "medium model-max", label: "medium model-max — medium up to this model's top level" },
				{ value: "medium high", label: "medium high — constrain to medium–high" },
				{ value: "medium xhigh", label: "medium xhigh — medium through xhigh" },
				{ value: "low high", label: "low high — cap at high (no xhigh)" },
				{ value: "high xhigh", label: "high xhigh — only high and xhigh" },
				{ value: "high model-max", label: "high model-max — high up to this model's top level" },
				{ value: "low max", label: "low max — explicitly allow provider maximum" },
				{ value: "model-min model-max", label: "model-min model-max — every level this model exposes" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg || arg === "status") {
				const spec = activeConfigSpec();
				const cfg = activeConfig();
				const ladder = modelLadder();
				ctx.ui.notify(
					`Bounds: ${boundSpecLabel(spec.minLevel, cfg.minLevel)}–${boundSpecLabel(spec.maxLevel, cfg.maxLevel)}\nAllowed levels: ${allowedLevels(cfg).join(", ")}\nAgent can select: ${availableAgentLevels(cfg, ladder).join(", ") || "(nothing)"}`,
					"info",
				);
				return;
			}

			const parts = arg.split(/\s+/);
			if (parts.length !== 2) {
				ctx.ui.notify(
					`Usage: /thinking-bounds <min> <max>\nLevels: ${BOUND_SPEC_LIST}`,
					"warning",
				);
				return;
			}

			const [minStr, maxStr] = parts;
			if (!isBoundSpec(minStr) || !isBoundSpec(maxStr)) {
				ctx.ui.notify(
					`Invalid level(s). Valid: ${BOUND_SPEC_LIST}`,
					"warning",
				);
				return;
			}

			const minLevel: ThinkingBoundSpec = minStr;
			const maxLevel: ThinkingBoundSpec = maxStr;

			// Only two explicit levels have a comparable position. A sentinel is
			// ordered against the model at resolve time instead.
			if (
				isConfigurableLevel(minLevel) &&
				isConfigurableLevel(maxLevel) &&
				CONFIGURABLE_LEVELS.indexOf(minLevel) > CONFIGURABLE_LEVELS.indexOf(maxLevel)
			) {
				ctx.ui.notify(
					`Min (${minLevel}) must be ≤ max (${maxLevel}).`,
					"warning",
				);
				return;
			}
			if (activePolicy) {
				ctx.ui.notify("Thinking bounds are owned by the active session policy.", "warning");
				return;
			}

			try {
				const spec = readConfig();
				spec.minLevel = minLevel;
				spec.maxLevel = maxLevel;
				writeConfig(spec);
				const cfg = resolveConfigForModel(spec, modelLadder());

				// If there's an active override outside the new bounds, clamp it
				if (state.override) {
					const clamped = clampLevel(state.override, cfg) as AgentThinkingLevel;
					if (clamped !== state.override) {
						ctx.ui.notify(
							`Active override ${state.override} clamped to ${clamped} (new bounds: ${cfg.minLevel}–${cfg.maxLevel})`,
							"info",
						);
						state.override = AGENT_LEVELS.includes(clamped) ? clamped : null;
						if (!state.override) {
							state.scope = null;
							state.turnsRemaining = null;
							state.reason = null;
						}
						applyLevel();
					}
				}

				propagateEnvironmentPolicy(cfg);
				syncThinkingTool();
				refreshStatus(ctx, state, activeConfig(), displayedLevel());
				publishSnapshot();
				const available = availableAgentLevels(cfg, modelLadder());
				ctx.ui.notify(
					`Bounds set: ${boundSpecLabel(minLevel, cfg.minLevel)}–${boundSpecLabel(maxLevel, cfg.maxLevel)} (${allowedLevels(cfg).join(", ")})\nAgent can select: ${available.join(", ") || "(nothing)"}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("thinking-reset", {
		description: "Clear any thinking override and revert to baseline.",
		handler: async (_args, ctx) => {
			const previous = displayedLevel();
			revertToBaseline("user");
			refreshStatus(ctx, state, activeConfig(), displayedLevel());
			publishSnapshot();
			ctx.ui.notify(
				`Thinking reset: ${previous} → ${displayedLevel()} (override cleared)`,
				"info",
			);
		},
	});

	pi.registerCommand("thinking-toggle", {
		description: "Toggle adaptive thinking on/off.",
		handler: async (_args, ctx) => {
			try {
				if (activePolicy) {
					ctx.ui.notify("Adaptive thinking enablement is owned by global config and cannot be changed from a delegated session.", "warning");
					return;
				}
				const cfg = readConfig();
				cfg.enabled = !cfg.enabled;
				writeConfig(cfg);
				syncThinkingTool();
				publishSnapshot();
				ctx.ui.notify(`Adaptive thinking: ${cfg.enabled ? "enabled" : "disabled"}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
