/**
 * Tiny on-disk config loader for delegate.
 *
 * Reads `<agentDir>/config/pi-delegate/config.json`. Missing file, bad
 * JSON, or unreadable file all degrade to `{}` with a one-line warning — we
 * never want config loading to block a tool invocation.
 *
 * Fields (all optional):
 *   worktreeSetupHook:           absolute or repo-relative path to an
 *                                executable hook, forwarded verbatim to
 *                                createWorktrees({ setupHook: { hookPath } }).
 *   worktreeSetupHookTimeoutMs:  positive integer ms cap for the hook.
 *   completionNotifyStrategy:    how the main agent is woken when a dispatched
 *                                run completes. Phase 1 only supports
 *                                "custom-message" (Plan C). "synthetic-tool-pair"
 *                                is reserved; if set it logs once and falls
 *                                back to custom-message. Default: "auto".
 *   overlayShortcut:             fallback keybinding that opens the transcript
 *                                overlay in addition to the built-in Option-O
 *                                (`alt+o`) toggle. Set to the empty string
 *                                ("") to disable both shortcuts and use only
 *                                the slash command `/delegate-inspector`.
 *                                Default: "ctrl+alt+d" (d = delegate).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { logDelegateDiagnostic } from "./diagnostics.js";
import type {
	EscalationAuthority,
	EscalationHoldStrategy,
	EscalationKind,
} from "./escalation-store.js";
import { parseEnvOverrides, type EnvOverrides } from "./env-overrides.js";
import { MAX_TIMEOUT_MS, normalizeTimeoutMs } from "./fork-timeout.js";
import {
	DEFAULT_DELEGATE_ONLY_CONFIG,
	parseDelegateOnly,
	type DelegateOnlyConfig,
} from "./delegate-only/config.js";
import type { FooterIconMode } from "./footer-presentation.js";
import { normalizeThinkingFields, type ThinkingLevel } from "./thinking-policy.js";
import {
	DEFAULT_HEARTBEAT_INTERVAL_MS as HEARTBEAT_INTERVAL_DEFAULT,
	DEFAULT_MAX_CONSECUTIVE_HEARTBEATS as MAX_CONSECUTIVE_HEARTBEATS_DEFAULT,
} from "./heartbeat-defaults.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_DEFAULT;
export const DEFAULT_MAX_CONSECUTIVE_HEARTBEATS = MAX_CONSECUTIVE_HEARTBEATS_DEFAULT;
/** Default direct-worker silence window before the one-shot wind-down steer. */
export const DEFAULT_DIRECT_WORKER_SILENCE_TIMEOUT_MS =
	DEFAULT_HEARTBEAT_INTERVAL_MS * DEFAULT_MAX_CONSECUTIVE_HEARTBEATS;

/**
 * Issue #13 — config validation warnings route through the spec-0017
 * file-backed diagnostics channel (PI_DELEGATE_DEBUG=1 echoes to console)
 * instead of raw console.warn, which pi's TUI surfaces into the user-facing
 * stream and makes routine config nits look like runtime errors.
 */
type ConfigDiagnosticSink = (message: string, options?: { agentDir?: string; level?: "log" | "warn"; throttleKey?: string }) => void;

// Preflight must be able to inspect legacy/current config without creating or
// mutating any state. Config parsing is synchronous, so a scoped sink keeps
// the existing parser helpers simple while allowing read-only callers to
// suppress every diagnostic write (including validation warnings).
let configDiagnosticSink: ConfigDiagnosticSink | undefined = (message, options) =>
	logDelegateDiagnostic(message, { level: "warn", ...options });

const warnConfig = (message: string): void => configDiagnosticSink?.(message, { level: "warn" });

/** Report timeout validation failures without serializing caller-controlled values. */
const warnInvalidTimeout = (field: string): void => {
	warnConfig(`[delegate] ignoring invalid ${field}; expected a safe integer between 0 and ${MAX_TIMEOUT_MS}`);
};

export type CompletionNotifyStrategy = "auto" | "synthetic-tool-pair" | "custom-message";

/** Effective completion-wake transport available in the current Pi API. */
export type EffectiveCompletionNotifyStrategy = "custom-message";

/** Resolve aliases and reserved transports to the only supported wake path. */
export function resolveCompletionNotifyStrategy(
	_strategy: CompletionNotifyStrategy | undefined,
): EffectiveCompletionNotifyStrategy {
	return "custom-message";
}

export type ActivityTickerModel = "auto" | `${string}/${string}`;

/** Initial transcript-thinking detail for a newly started Pi session. */
export type InspectorThinking = "hidden" | "preview" | "full";
/** Initial transcript tool-call detail for a newly started Pi session. */
export type InspectorToolDetail = "chip" | "hidden" | "expanded";

export type EscalationMode = "off" | "local";
export type EscalationTimeoutBehavior = "useDefault" | "noDefaultError" | "cancel";
export type EscalationPerKind<T> = Partial<Record<EscalationKind, T>>;

/**
 * A partial escalation policy from one precedence layer. [spec §5]
 *
 * Scalar timeout values apply to every kind; map values override only the
 * named kinds so higher-precedence layers can remain field-wise partial.
 */
export interface EscalationConfig {
	mode?: EscalationMode;
	authority?: EscalationAuthority;
	intermediate?: boolean;
	hopTimeoutMs?: number | null;
	timeoutMs?: number | EscalationPerKind<number>;
	timeoutBehavior?: EscalationTimeoutBehavior | EscalationPerKind<EscalationTimeoutBehavior>;
	holdStrategy?: EscalationHoldStrategy;
}

/** Canonical, fully-resolved escalation policy consumed by the runtime. */
export interface ResolvedEscalationConfig {
	mode: EscalationMode;
	authority: Required<EscalationAuthority>;
	intermediate: boolean;
	hopTimeoutMs: number | null;
	timeoutMs: Record<EscalationKind, number>;
	timeoutBehavior: Record<EscalationKind, EscalationTimeoutBehavior>;
	holdStrategy: EscalationHoldStrategy;
}

export interface ActivityTickerConfig {
	/** The complete deterministic and semantic ticker surface. */
	enabled: boolean;
	/** Omitted means deterministic-only and guarantees no ticker provider calls. */
	model?: ActivityTickerModel;
	minSummaryIntervalMs: number;
	debounceMs: number;
	maxConcurrentSummaries: number;
	summaryTimeoutMs: number;
	/** @deprecated Retained for config compatibility; the footer no longer rotates. */
	rotateIntervalMs: number;
	/** Zero clears terminal activity immediately. */
	terminalRetentionMs: number;
	maxHeadlineChars: number;
	maxInputChars: number;
}

export interface SkillConfig {
	/** Exact, case-sensitive visible Markdown heading text to omit from pi-delegate/SKILL.md. */
	excludeSections?: string[];
}

/** Global tool and skill grants composed into every discovered delegate agent. */
export interface GlobalToolWhitelistConfig {
	tools?: string[];
	skills?: string[];
}

export interface DelegateConfig {
	/** False leaves user-held decisions to an external operator surface instead of opening a Pi dialog. */
	nativeEscalationUi?: boolean;
	/** Validated skill resource filtering. */
	skill?: SkillConfig;
	/** Tool/skill baseline applied before agent frontmatter and durable overrides. */
	globalToolWhitelist?: GlobalToolWhitelistConfig;
	/** Validated and fully-resolved escalation policy. [spec §5] */
	escalation?: ResolvedEscalationConfig;
	/**
	 * Raw global escalation layer retained for per-slot field-wise composition.
	 * `escalation` above is already resolved against built-ins and therefore
	 * cannot distinguish an omitted global field from a defaulted one. [spec §5]
	 */
	escalationGlobalLayer?: EscalationConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	completionNotifyStrategy?: CompletionNotifyStrategy;
	/** Default-on per-run terminal failure wakes; false preserves aggregate-only delivery. */
	notifyOnFailure?: boolean;
	/** Validated activity-ticker settings. `loadConfig` always supplies defaults. */
	activityTicker?: ActivityTickerConfig;
	/** Validated delegate-only settings. `loadConfig` always supplies defaults. */
	delegateOnly?: DelegateOnlyConfig;
	/** When true, caller/agent wall-clock budgets hard-cancel after grace. */
	enforceWallClockBudget?: boolean;
	/**
	 * Icon vocabulary for every delegate surface: the footer, the below-editor
	 * widget, and the transcript overlay.
	 *
	 * `"nerd-font"` (the default) needs a patched font. `"unicode"` is the
	 * glyph set the overlay drew before this setting reached it, and is the
	 * right choice for a terminal with no Nerd Font. `"ascii"` is plain 7-bit.
	 * `PI_DELEGATE_ASCII=1` and `TERM=dumb` force `"ascii"` regardless.
	 */
	footerIcons?: FooterIconMode;
	/**
	 * Maximum wall-clock duration before a run receives its one-shot wind-down.
	 * Hard cancellation after grace is controlled by `enforceWallClockBudget`.
	 * Timer starts at the `pending→running` transition (when `startedAt` is stamped).
	 *
	 * Default when the field is absent: `DEFAULT_PER_FORK_MAX_DURATION_MS`
	 * (0 — disabled; heartbeat remains the default liveness guard). Explicit
	 * `0` disables the absolute timeout entirely. Negative, fractional, or
	 * out-of-range values are ignored and fall back to the default.
	 */
	perForkMaxDurationMs?: number;
	/**
	 * Minimum wall-clock duration for every governed run. A positive value
	 * raises only a stated positive selected per-run budget; explicit zero and
	 * no selected budget remain unlimited when the floor is the only bound.
	 * Zero preserves legacy behavior. Values above a positive
	 * `perForkMaxDurationMs` are ignored.
	 */
	perForkMinDurationMs?: number;
	/**
	 * Issue #11 — grace window (ms) granted after the per-run wall-clock
	 * budget elapses: on budget expiry ONE wrap-up steer is issued, then this
	 * long passes before hard-cancel when enforcement is enabled. `0` means
	 * hard-cancel immediately after the wind-down steer when enforcement is enabled. Absent / invalid →
	 * the built-in 90s default (`DEFAULT_WIND_DOWN_GRACE_MS`).
	 */
	windDownGraceMs?: number;
	/**
	 * Phase 3 — fallback keybinding for opening the transcript overlay, in
	 * addition to the built-in Option-O (`alt+o`) toggle. Empty string disables
	 * both shortcuts; the slash command `/delegate-inspector` remains available.
	 * Default: `ctrl+alt+d`.
	 */
	overlayShortcut?: string;
	/**
	 * Inspector overlay placement.
	 *
	 * `"full"` (default) centres a near-fullscreen modal, which is what the
	 * two-pane explorer needs: below roughly 90 inner columns the overlay
	 * collapses to a single-column drill-down instead.
	 *
	 * `"dock"` anchors a narrow right-side panel (`~42%` of the terminal). It
	 * renders the same single-column path, so keeping it costs nothing and
	 * keeps that path exercised on every desktop that prefers the dock.
	 *
	 * Invalid values fall back to `"full"`.
	 */
	inspectorLayout?: "dock" | "full";
	/** Initial thinking detail for the transcript inspector. Default: `"preview"`. */
	inspectorThinking?: InspectorThinking;
	/** Initial tool-call detail for the transcript inspector. Default: `"chip"`. */
	inspectorToolDetail?: InspectorToolDetail;
	/**
	 * Retained for compatibility and currently inert: long finished messages
	 * always fold, and `Enter` expands the one message or tool result you
	 * select. Nothing reads this value.
	 */
	inspectorFoldMessages?: boolean;
	/**
	 * Auto-close the transcript overlay once every delegated run across the
	 * owned run(s) has reached a terminal state (completed / failed / aborted
	 * / paused) — i.e. nothing is still running or pending. Only triggers on
	 * the live→all-terminal transition while the overlay is open; opening it
	 * over an already-finished run keeps it open for review. Deferred while
	 * you are actively composing/steering or a worker prompt is pending.
	 *
	 * Default: `false`. The overlay is a centered modal, and one that
	 * dismisses itself takes a just-arrived result off the screen; a
	 * completion banner reports the outcome instead. Set `true` to restore
	 * the old auto-dismiss.
	 */
	autoCloseInspectorOnComplete?: boolean;
	/**
	 * Keybinding for "cancel focused run" with confirm-guard, wired in the
	 * transcript overlay. Empty string disables. Default: `ctrl+shift+x`.
	 */
	cancelForkShortcut?: string;
	/**
	 * Keybinding for "cancel focused run" that skips the confirm-guard. Use
	 * when muscle memory / a tight loop makes the prompt annoying. Empty
	 * string disables. Default: `ctrl+shift+alt+x`.
	 */
	cancelForkBypassShortcut?: string;
	/**
	 * Cost threshold (USD) above which the cancel keybinding prompts for
	 * confirmation. `0` disables the cost-based confirm check (the runtime
	 * check may still trigger). Default: 0.10.
	 */
	cancelConfirmCostUsd?: number;
	/**
	 * Runtime threshold (ms) above which the cancel keybinding prompts for
	 * confirmation. `0` disables the runtime-based confirm check (the cost
	 * check may still trigger). Default: 300_000 (5 minutes).
	 */
	cancelConfirmRuntimeMs?: number;
	/**
	 * Commit B.2 — heartbeat config. Worker silence for `heartbeatIntervalMs`
	 * milliseconds causes `message_subagent` / `wait_for_worker` to return a
	 * `kind:"heartbeat"` tool result to the supervisor without cancelling the
	 * worker. After `maxConsecutiveHeartbeats` such heartbeats the channel
	 * auto-aborts with `reason:"heartbeat"`. `heartbeatTailLines` bounds the
	 * ring buffer of recent worker transcript entries included in the
	 * heartbeat payload. See docs/heartbeat.md.
	 *
	 * Absent => WorkerChannel defaults (`DEFAULT_HEARTBEAT_INTERVAL_MS`,
	 * `DEFAULT_MAX_CONSECUTIVE_HEARTBEATS`, `DEFAULT_HEARTBEAT_TAIL_LINES`).
	 * `heartbeatIntervalMs = 0` disables heartbeat entirely. Values between
	 * 1 and 30_000 are clamped (with a one-time console warning) to 30_000
	 * so supervisor prompts don't thrash.
	 */
	heartbeatIntervalMs?: number;
	maxConsecutiveHeartbeats?: number;
	heartbeatTailLines?: number;
	/**
	 * Commit B.3 — number of most-recent worker transcript entries included
	 * in the `inspect_worker` tool result's recentTail. Reuses the same ring
	 * buffer as heartbeat payloads (bounded by `heartbeatTailLines`); this
	 * value is currently reserved for future per-inspect tail sizing and is
	 * parsed + validated here so operators can pre-configure it. Must be
	 * `>= 1`; absent falls back to `DEFAULT_INSPECT_TAIL_LINES`.
	 */
	inspectTailLines?: number;
	/**
	 * Phase D: globally hide builtin agents from discovery. When `true`,
	 * builtin-source agents are filtered out before user / project
	 * agents are merged. Useful when an org has its own canonical agent
	 * library and wants to avoid the bundled defaults shadowing them
	 * with stale signatures. Default: false.
	 *
	 * Mirrors pi-subagents' `subagents.disableBuiltins`.
	 */
	disableBuiltins?: boolean;
	/**
	 * Phase D: per-agent overrides applied on top of discovered configs.
	 * Keys are agent names; values are partial AgentConfig fields plus
	 * a `disabled?: boolean` opt-out. Applied AFTER scope dedupe, so an
	 * override targets the agent that actually wins discovery
	 * regardless of source (builtin / user / project).
	 *
	 * Common use cases:
	 *   - Pin a builtin agent to a specific model + thinking level:
	 *     `{ "scout": { "model": "openai/gpt-5", "thinking": "medium" } }`
	 *   - Disable an agent entirely:
	 *     `{ "reviewer": { "disabled": true } }`
	 *   - Override a builtin's description without copying the file:
	 *     `{ "planner": { "description": "Our team's planner" } }`
	 *
	 * Mirrors pi-subagents' `subagents.agentOverrides`.
	 */
	agentOverrides?: Record<string, AgentOverride>;
	/**
	 * Phase D: intercom-bridge instruction injection. When pi-intercom is
	 * installed, we append a runtime instruction to the worker's system
	 * prompt telling it how to coordinate with the orchestrator session.
	 * See `src/intercom-bridge.ts` for resolution semantics. Default
	 * mode: "always" (active when pi-intercom is detected).
	 */
	intercomBridge?: {
		mode?: "off" | "always" | "fork-only";
		instructionFile?: string;
	};
	/**
	 * pi-prompt-template-model bridge. Lets pi-delegate serve as the
	 * delegation backend for PTM templates that use `subagent:`,
	 * `parallel:`, or `bestOfN:` frontmatter. See
	 * `docs/prompt-template-bridge.md` for the full design.
	 *
	 *   - `auto` (default): listen for PTM events iff the legacy
	 *     `~/.pi/agent/extensions/subagent` extension is NOT installed.
	 *   - `always`: listen unconditionally — pi-delegate always wins.
	 *   - `never`: do not subscribe; do not set
	 *     `PI_SUBAGENT_RUNTIME_ROOT`.
	 */
	ptmBridge?: {
		handleRequests?: "auto" | "always" | "never";
	};
}

/**
 * Per-agent override entry in `delegateConfig.agentOverrides`.
 * `disabled: true` removes the agent from discovery; other fields
 * merge onto the discovered AgentConfig (last write wins).
 *
 * `false` is NOT honoured for clearing fields here (unlike the
 * management `update` action) — overrides are intended to *add* to a
 * discovered agent's config, not erase fields. To erase a field via
 * an override, edit the agent file or `update` it.
 */
export interface AgentOverride {
	disabled?: boolean;
	description?: string;
	model?: string;
	env?: EnvOverrides;
	fallbackModels?: string[];
	thinking?: ThinkingLevel;
	thinkingMin?: ThinkingLevel;
	thinkingMax?: ThinkingLevel;
	systemPrompt?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	skills?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	extensions?: string[];
	extensionInclude?: string[];
	extensionExclude?: string[];
	defaultMaxRounds?: number;
	stopConditionHint?: string;
	collapseMode?: "final_output" | "summary";
	summaryModel?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	artifact?: string;
	interactive?: boolean;
	maxSubagentDepth?: number;
	allowNestedDelegate?: boolean;
	nestedDelegateAgents?: string[];
	/** Supervised-run absolute budget override; 0 explicitly disables. */
	maxDurationMs?: number;
	/** Supervised-run wind-down grace override; 0 means immediate cancel. */
	windDownGraceMs?: number;

}

export const DEFAULT_ACTIVITY_TICKER_ENABLED = true;
export const DEFAULT_ACTIVITY_TICKER_MIN_SUMMARY_INTERVAL_MS = 15_000;
export const DEFAULT_ACTIVITY_TICKER_DEBOUNCE_MS = 2_000;
export const DEFAULT_ACTIVITY_TICKER_MAX_CONCURRENT_SUMMARIES = 2;
export const DEFAULT_ACTIVITY_TICKER_SUMMARY_TIMEOUT_MS = 10_000;
export const DEFAULT_ACTIVITY_TICKER_ROTATE_INTERVAL_MS = 4_000;
export const DEFAULT_ACTIVITY_TICKER_TERMINAL_RETENTION_MS = 5_000;
export const DEFAULT_ACTIVITY_TICKER_MAX_HEADLINE_CHARS = 100;
export const DEFAULT_ACTIVITY_TICKER_MAX_INPUT_CHARS = 4_000;

export const DEFAULT_ACTIVITY_TICKER_CONFIG: Readonly<ActivityTickerConfig> = {
	enabled: DEFAULT_ACTIVITY_TICKER_ENABLED,
	minSummaryIntervalMs: DEFAULT_ACTIVITY_TICKER_MIN_SUMMARY_INTERVAL_MS,
	debounceMs: DEFAULT_ACTIVITY_TICKER_DEBOUNCE_MS,
	maxConcurrentSummaries: DEFAULT_ACTIVITY_TICKER_MAX_CONCURRENT_SUMMARIES,
	summaryTimeoutMs: DEFAULT_ACTIVITY_TICKER_SUMMARY_TIMEOUT_MS,
	rotateIntervalMs: DEFAULT_ACTIVITY_TICKER_ROTATE_INTERVAL_MS,
	terminalRetentionMs: DEFAULT_ACTIVITY_TICKER_TERMINAL_RETENTION_MS,
	maxHeadlineChars: DEFAULT_ACTIVITY_TICKER_MAX_HEADLINE_CHARS,
	maxInputChars: DEFAULT_ACTIVITY_TICKER_MAX_INPUT_CHARS,
};

export const DEFAULT_ESCALATION_TIMEOUT_MS = 1_800_000;

/**
 * Built-in escalation policy. `useDefault` delegates kind-specific terminal
 * behavior and selection details to `defaultTimeoutSpecFor` (DE-8).
 */
export const DEFAULT_ESCALATION_CONFIG: Readonly<ResolvedEscalationConfig> = {
	mode: "off",
	authority: {
		decision: "none",
		blocker: "none",
		amendment: "none",
		tags: [],
	},
	intermediate: false,
	hopTimeoutMs: null,
	timeoutMs: {
		decision: DEFAULT_ESCALATION_TIMEOUT_MS,
		blocker: DEFAULT_ESCALATION_TIMEOUT_MS,
		amendment: DEFAULT_ESCALATION_TIMEOUT_MS,
	},
	timeoutBehavior: {
		decision: "useDefault",
		blocker: "useDefault",
		amendment: "useDefault",
	},
	holdStrategy: "hold-open",
};

const ESCALATION_KINDS: readonly EscalationKind[] = ["decision", "blocker", "amendment"];

/**
 * Resolve escalation policy field-wise using invocation > agent > global >
 * built-ins. Authority and per-kind maps are deep-merged. [spec §5]
 */
export function resolveEscalationConfig(args: {
	global?: EscalationConfig;
	agent?: EscalationConfig;
	invocation?: EscalationConfig;
}): ResolvedEscalationConfig {
	const resolved: ResolvedEscalationConfig = {
		mode: DEFAULT_ESCALATION_CONFIG.mode,
		authority: {
			...DEFAULT_ESCALATION_CONFIG.authority,
			tags: [...DEFAULT_ESCALATION_CONFIG.authority.tags],
		},
		intermediate: DEFAULT_ESCALATION_CONFIG.intermediate,
		hopTimeoutMs: DEFAULT_ESCALATION_CONFIG.hopTimeoutMs,
		timeoutMs: { ...DEFAULT_ESCALATION_CONFIG.timeoutMs },
		timeoutBehavior: { ...DEFAULT_ESCALATION_CONFIG.timeoutBehavior },
		holdStrategy: DEFAULT_ESCALATION_CONFIG.holdStrategy,
	};

	for (const layer of [args.global, args.agent, args.invocation]) {
		if (layer === undefined) continue;
		if (layer.mode !== undefined) resolved.mode = layer.mode;
		if (layer.intermediate !== undefined) resolved.intermediate = layer.intermediate;
		if (layer.hopTimeoutMs !== undefined) resolved.hopTimeoutMs = layer.hopTimeoutMs;
		if (layer.holdStrategy !== undefined) resolved.holdStrategy = layer.holdStrategy;
		if (layer.authority !== undefined) {
			resolved.authority = {
				...resolved.authority,
				...layer.authority,
				...(layer.authority.tags !== undefined ? { tags: [...layer.authority.tags] } : {}),
			};
		}
		mergePerKind(resolved.timeoutMs, layer.timeoutMs);
		mergePerKind(resolved.timeoutBehavior, layer.timeoutBehavior);
	}
	return resolved;
}

function mergePerKind<T>(target: Record<EscalationKind, T>, source: T | EscalationPerKind<T> | undefined): void {
	if (source === undefined) return;
	if (typeof source !== "object" || source === null) {
		for (const kind of ESCALATION_KINDS) target[kind] = source as T;
		return;
	}
	const overrides = source as EscalationPerKind<T>;
	for (const kind of ESCALATION_KINDS) {
		const value = overrides[kind];
		if (value !== undefined) target[kind] = value;
	}
}

/** Default ring-buffer size for `recentTail` in heartbeat payloads. */
export const DEFAULT_HEARTBEAT_TAIL_LINES = 5;
/** Default ring-buffer size for `recentTail` in `inspect_worker` results. */
export const DEFAULT_INSPECT_TAIL_LINES = 10;

/** Default overlay shortcut when the user hasn't configured one. */
export const DEFAULT_OVERLAY_SHORTCUT = "ctrl+alt+d";

/** Default thinking detail for each newly started Pi session's inspector. */
export const DEFAULT_INSPECTOR_THINKING: InspectorThinking = "preview";
/** Default tool-call detail for each newly started Pi session's inspector. */
export const DEFAULT_INSPECTOR_TOOL_DETAIL: InspectorToolDetail = "chip";
/** Default long-message folding for each newly started Pi session's inspector. */
export const DEFAULT_INSPECTOR_FOLD_MESSAGES = true;

/**
 * Default for `autoCloseInspectorOnComplete`, which is **off**.
 *
 * Auto-close was designed for a side dock quietly getting out of the way. The
 * overlay is a centered modal now, and a modal that dismisses itself takes a
 * just-arrived result off the screen at the moment you would read it. A
 * completion banner carries the signal instead, and closing stays a decision
 * the reader makes. Set the option to `true` to restore the old behaviour.
 */
export const DEFAULT_AUTO_CLOSE_INSPECTOR_ON_COMPLETE = false;

/**
 * Default per-run wall-clock cap when `perForkMaxDurationMs` is absent from
 * config. `0` disables the absolute cap so active workers are not killed at a
 * legacy wall-clock boundary; heartbeat and direct-worker silence guards remain.
 */
export const DEFAULT_PER_FORK_MAX_DURATION_MS = 0;
/** Default wall-clock budget mode; false preserves soft caller/agent budgets. */
export const DEFAULT_ENFORCE_WALL_CLOCK_BUDGET = false;
/** Default global per-run floor; zero preserves the legacy disabled behavior. */
export const DEFAULT_PER_FORK_MIN_DURATION_MS = 0;

/**
 * Default keybinding for "cancel focused run" (with confirm).
 *
 * Empty (disabled) by default as of the TUI redesign: the keyboard scheme
 * deliberately registers only ONE global chord (the inspector open shortcut)
 * to avoid tmux / other-extension collisions. Cancel is reachable via the
 * inspector-local `x` key (with confirm) and the `delegate_cancel` tool. Set
 * a non-empty value in config.json to re-enable a global cancel chord.
 */
export const DEFAULT_CANCEL_FORK_SHORTCUT = "";

/** Default keybinding for "cancel focused run, no confirm". Empty (disabled) — see above. */
export const DEFAULT_CANCEL_FORK_BYPASS_SHORTCUT = "";

/** Default cost threshold (USD) that arms the cancel-confirm prompt. */
export const DEFAULT_CANCEL_CONFIRM_COST_USD = 0.10;

/** Default runtime threshold (ms) that arms the cancel-confirm prompt. */
export const DEFAULT_CANCEL_CONFIRM_RUNTIME_MS = 300_000;

/** Resolve the current on-disk config directory for delegate. */
export function getConfigDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "config", "pi-delegate");
}

/** Resolve the legacy config directory used before package/state separation. */
export function getLegacyConfigDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "extensions", "pi-delegate");
}

/** Resolve the on-disk config file path for delegate. */
export function getConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(getConfigDir(agentDir), "config.json");
}

/** Resolve the legacy base config path for migration/backward compatibility. */
export function getLegacyConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(getLegacyConfigDir(agentDir), "config.json");
}

/**
 * Resolve the LOCAL config overlay path (issue #6). Runtime-specific settings
 * must not rewrite the base operator config. Mutable state lives in this
 * sibling overlay, merged over `config.json` at load time (overlay wins).
 */
export function getLocalConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(getConfigDir(agentDir), "config.local.json");
}

/** Resolve the legacy local overlay path for migration/backward compatibility. */
export function getLegacyLocalConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(getLegacyConfigDir(agentDir), "config.local.json");
}

function fileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Best-effort one-time migration from the pre-package-state path
 * `<agentDir>/extensions/pi-delegate/{config.json,config.local.json}` to the
 * current config namespace `<agentDir>/config/pi-delegate/…`.
 *
 * The old path was confusing for package-installed/local-path extensions: it
 * looked like the extension source directory even when the actual package lived
 * elsewhere. Config is now intentionally separate from extension source and
 * volatile runtime state. Existing users keep working because a missing new
 * file is renamed in place; if both old and new files exist, the new file wins
 * and the old file is left untouched for a human merge.
 */
export function migrateLegacyConfigFiles(agentDir: string = getAgentDir()): void {
	for (const [legacyPath, currentPath] of [
		[getLegacyConfigPath(agentDir), getConfigPath(agentDir)],
		[getLegacyLocalConfigPath(agentDir), getLocalConfigPath(agentDir)],
	] as const) {
		if (!fileExists(legacyPath)) continue;
		if (fileExists(currentPath)) {
			logDelegateDiagnostic(
				`legacy config remains at ${legacyPath}; current config at ${currentPath} wins. Merge/remove the legacy file manually if needed.`,
				{ agentDir, level: "warn", throttleKey: `legacy-config:${legacyPath}` },
			);
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(currentPath), { recursive: true });
			fs.renameSync(legacyPath, currentPath);
			logDelegateDiagnostic(`migrated legacy config ${legacyPath} -> ${currentPath}`, {
				agentDir,
				level: "log",
			});
		} catch (err) {
			logDelegateDiagnostic(
				`failed to migrate legacy config ${legacyPath} -> ${currentPath}: ${(err as Error)?.message ?? err}`,
				{ agentDir, level: "warn", throttleKey: `legacy-config-migrate:${legacyPath}` },
			);
		}
	}
}

/**
 * Read + parse one config file into a raw object. `undefined` when the file
 * is missing (common case, silent) or invalid (logged) — callers merge
 * whatever survives.
 */
function readConfigObject(file: string): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return undefined; // missing file is the common case; do not warn.
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		configDiagnosticSink?.(`ignoring invalid config at ${file}: ${(err as Error).message}`);
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		configDiagnosticSink?.(`ignoring non-object config at ${file}`);
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

/** Merge the tracked base config with the local overlay; overlay wins. */
function mergeConfigObjects(
	base: Record<string, unknown>,
	overlay: Record<string, unknown>,
): Record<string, unknown> {
	return { ...base, ...overlay };
}

/**
 * Stamp Commit A defaults for the new timeout / cancel-confirm / shortcut
 * fields. Called from every `loadConfig` early-exit so missing / invalid
 * config files still produce a fully-populated object.
 */
function applyCommitADefaults(out: DelegateConfig): DelegateConfig {
	if (out.escalation === undefined) out.escalation = resolveEscalationConfig({});
	if (out.perForkMaxDurationMs === undefined)
		out.perForkMaxDurationMs = DEFAULT_PER_FORK_MAX_DURATION_MS;
	if (out.enforceWallClockBudget === undefined)
		out.enforceWallClockBudget = DEFAULT_ENFORCE_WALL_CLOCK_BUDGET;
	if (out.perForkMinDurationMs === undefined)
		out.perForkMinDurationMs = DEFAULT_PER_FORK_MIN_DURATION_MS;
	if (out.notifyOnFailure === undefined) out.notifyOnFailure = true;
	if (out.completionNotifyStrategy === undefined) out.completionNotifyStrategy = "auto";
	if (out.cancelForkShortcut === undefined) out.cancelForkShortcut = DEFAULT_CANCEL_FORK_SHORTCUT;
	if (out.cancelForkBypassShortcut === undefined)
		out.cancelForkBypassShortcut = DEFAULT_CANCEL_FORK_BYPASS_SHORTCUT;
	if (out.cancelConfirmCostUsd === undefined) out.cancelConfirmCostUsd = DEFAULT_CANCEL_CONFIRM_COST_USD;
	if (out.cancelConfirmRuntimeMs === undefined)
		out.cancelConfirmRuntimeMs = DEFAULT_CANCEL_CONFIRM_RUNTIME_MS;
	if (out.activityTicker === undefined)
		out.activityTicker = { ...DEFAULT_ACTIVITY_TICKER_CONFIG };
	if (out.delegateOnly === undefined) {
		out.delegateOnly = {
			...DEFAULT_DELEGATE_ONLY_CONFIG,
			allowlist: [...DEFAULT_DELEGATE_ONLY_CONFIG.allowlist],
		};
	}
	if (out.footerIcons === undefined) out.footerIcons = "nerd-font";
	return out;
}

function parseActivityTicker(source: unknown): ActivityTickerConfig {
	const defaults = { ...DEFAULT_ACTIVITY_TICKER_CONFIG };
	if (source === undefined) return defaults;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		warnConfig(
			`[delegate] ignoring invalid activityTicker=${JSON.stringify(source)}; expected an object`,
		);
		return defaults;
	}

	const raw = source as Record<string, unknown>;
	const out: ActivityTickerConfig = defaults;
	if ("enabled" in raw) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else {
			warnConfig(
				`[delegate] ignoring invalid activityTicker.enabled=${JSON.stringify(raw.enabled)}; expected a boolean`,
			);
		}
	}

	if ("model" in raw) {
		const model = raw.model;
		if (
			typeof model === "string" &&
			(model === "auto" || /^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/.test(model))
		) {
			out.model = model as ActivityTickerModel;
		} else {
			warnConfig(
				`[delegate] ignoring invalid activityTicker.model=${JSON.stringify(model)}; expected "auto" or a non-empty "provider/model" reference`,
			);
		}
	}

	const positiveIntegerFields = {
		minSummaryIntervalMs: DEFAULT_ACTIVITY_TICKER_MIN_SUMMARY_INTERVAL_MS,
		debounceMs: DEFAULT_ACTIVITY_TICKER_DEBOUNCE_MS,
		maxConcurrentSummaries: DEFAULT_ACTIVITY_TICKER_MAX_CONCURRENT_SUMMARIES,
		summaryTimeoutMs: DEFAULT_ACTIVITY_TICKER_SUMMARY_TIMEOUT_MS,
		rotateIntervalMs: DEFAULT_ACTIVITY_TICKER_ROTATE_INTERVAL_MS,
		maxHeadlineChars: DEFAULT_ACTIVITY_TICKER_MAX_HEADLINE_CHARS,
		maxInputChars: DEFAULT_ACTIVITY_TICKER_MAX_INPUT_CHARS,
	} as const;
	for (const [field, fallback] of Object.entries(positiveIntegerFields) as Array<
		[keyof typeof positiveIntegerFields, number]
	>) {
		if (!(field in raw)) continue;
		const value = raw[field];
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
			out[field] = value;
		} else {
			warnConfig(
				`[delegate] ignoring invalid activityTicker.${field}=${JSON.stringify(value)}; expected a positive safe integer`,
			);
			out[field] = fallback;
		}
	}

	if ("terminalRetentionMs" in raw) {
		const value = raw.terminalRetentionMs;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			out.terminalRetentionMs = value;
		} else {
			warnConfig(
				`[delegate] ignoring invalid activityTicker.terminalRetentionMs=${JSON.stringify(value)}; expected a non-negative safe integer`,
			);
		}
	}

	return out;
}

function parseEscalationConfig(source: unknown): EscalationConfig | undefined {
	if (source === undefined) return undefined;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		warnConfig(
			`[delegate] ignoring invalid escalation=${JSON.stringify(source)}; expected an object`,
		);
		return undefined;
	}

	const raw = source as Record<string, unknown>;
	const out: EscalationConfig = {};
	if (raw.mode === "off" || raw.mode === "local") out.mode = raw.mode;
	else if (raw.mode !== undefined) warnEscalationField("mode", raw.mode, '"off" or "local"');

	if (typeof raw.intermediate === "boolean") out.intermediate = raw.intermediate;
	else if (raw.intermediate !== undefined) warnEscalationField("intermediate", raw.intermediate, "a boolean");

	if (raw.hopTimeoutMs === null) out.hopTimeoutMs = null;
	else if (isPositiveSafeInteger(raw.hopTimeoutMs)) out.hopTimeoutMs = raw.hopTimeoutMs;
	else if (raw.hopTimeoutMs !== undefined) {
		warnEscalationField("hopTimeoutMs", raw.hopTimeoutMs, "null or a positive safe integer");
	}

	const timeoutMs = parseEscalationPerKind(
		raw.timeoutMs,
		isPositiveSafeInteger,
		"timeoutMs",
		"a positive safe integer or a per-kind map",
	);
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	const timeoutBehavior = parseEscalationPerKind(
		raw.timeoutBehavior,
		isEscalationTimeoutBehavior,
		"timeoutBehavior",
		'a timeout behavior or a per-kind map ("useDefault", "noDefaultError", "cancel")',
	);
	if (timeoutBehavior !== undefined) out.timeoutBehavior = timeoutBehavior;

	if (raw.holdStrategy === "hold-open" || raw.holdStrategy === "park") {
		out.holdStrategy = raw.holdStrategy;
	} else if (raw.holdStrategy !== undefined) {
		warnEscalationField("holdStrategy", raw.holdStrategy, '"hold-open" or reserved "park"');
	}

	if (raw.authority !== undefined) {
		if (!raw.authority || typeof raw.authority !== "object" || Array.isArray(raw.authority)) {
			warnEscalationField("authority", raw.authority, "an object");
		} else {
			const authorityRaw = raw.authority as Record<string, unknown>;
			const authority: EscalationAuthority = {};
			if (
				authorityRaw.decision === "none" ||
				authorityRaw.decision === "implementation" ||
				authorityRaw.decision === "all"
			) authority.decision = authorityRaw.decision;
			else if (authorityRaw.decision !== undefined) {
				warnEscalationField("authority.decision", authorityRaw.decision, '"none", "implementation", or "all"');
			}
			for (const kind of ["blocker", "amendment"] as const) {
				const value = authorityRaw[kind];
				if (value === "none" || value === "all") authority[kind] = value;
				else if (value !== undefined) {
					warnEscalationField(`authority.${kind}`, value, '"none" or "all"');
				}
			}
			if (Array.isArray(authorityRaw.tags)) {
				const tags = authorityRaw.tags.filter((tag): tag is string => typeof tag === "string");
				if (tags.length !== authorityRaw.tags.length) {
					warnEscalationField("authority.tags", authorityRaw.tags, "an array of strings");
				}
				authority.tags = tags;
			} else if (authorityRaw.tags !== undefined) {
				warnEscalationField("authority.tags", authorityRaw.tags, "an array of strings");
			}
			if (Object.keys(authority).length > 0) out.authority = authority;
		}
	}
	return out;
}

function parseEscalationPerKind<T>(
	source: unknown,
	isValue: (value: unknown) => value is T,
	field: string,
	expected: string,
): T | EscalationPerKind<T> | undefined {
	if (source === undefined) return undefined;
	if (isValue(source)) return source;
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		warnEscalationField(field, source, expected);
		return undefined;
	}
	const raw = source as Record<string, unknown>;
	const out: EscalationPerKind<T> = {};
	for (const kind of ESCALATION_KINDS) {
		const value = raw[kind];
		if (value === undefined) continue;
		if (isValue(value)) out[kind] = value;
		else warnEscalationField(`${field}.${kind}`, value, expected);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isEscalationTimeoutBehavior(value: unknown): value is EscalationTimeoutBehavior {
	return value === "useDefault" || value === "noDefaultError" || value === "cancel";
}

function warnEscalationField(field: string, value: unknown, expected: string): void {
	warnConfig(
		`[delegate] ignoring invalid escalation.${field}=${JSON.stringify(value)}; expected ${expected}`,
	);
}

const REMOVED_PLANE_CONFIG_KEY = /^decision/i;
let removedPlaneConfigWarningEmitted = false;

/** Warn once per process when a removed decision-plane setting is encountered. */
export function warnRemovedPlaneConfigKey(key: string): void {
	if (removedPlaneConfigWarningEmitted || !configDiagnosticSink) return;
	warnConfig(
		key
			? `pi-delegate: decision-plane config is removed; escalation replaces it (ignored: ${key})`
			: "pi-delegate: decision-plane config is removed; escalation replaces it (ignored)",
	);
	removedPlaneConfigWarningEmitted = true;
}

/** Drop legacy decision-plane keys without letting stale config block startup. */
export function stripRemovedPlaneConfigKeys(
	source: Record<string, unknown>,
	prefix = "",
	redactKey = false,
): Record<string, unknown> {
	const cleaned = { ...source };
	for (const key of Object.keys(cleaned)) {
		if (!REMOVED_PLANE_CONFIG_KEY.test(key)) continue;
		warnRemovedPlaneConfigKey(redactKey ? "" : `${prefix}${key}`);
		delete cleaned[key];
	}
	return cleaned;
}

let removedSyncByDefaultWarningEmitted = false;

/** Drop the retired launch default and warn once with the invocation-level migration. */
function stripRemovedSyncByDefaultConfigKey(
	source: Record<string, unknown>,
): Record<string, unknown> {
	if (!Object.prototype.hasOwnProperty.call(source, "syncByDefault")) return source;
	if (!removedSyncByDefaultWarningEmitted && configDiagnosticSink) {
		warnConfig(
			"pi-delegate: syncByDefault config is removed and ignored; " +
				"remove the key and use explicit `await:true` only when blocking is required.",
		);
		removedSyncByDefaultWarningEmitted = true;
	}
	const cleaned = { ...source };
	delete cleaned.syncByDefault;
	return cleaned;
}

export interface LoadConfigOptions {
	/** Inspect config without migration, diagnostics, directory creation, or renames. */
	readonly?: boolean;
}

export function loadConfig(agentDir: string = getAgentDir(), options: LoadConfigOptions = {}): DelegateConfig {
	const previousDiagnosticSink = configDiagnosticSink;
	configDiagnosticSink = options.readonly ? undefined : (message, diagnosticOptions) =>
		logDelegateDiagnostic(message, { agentDir, level: "warn", ...diagnosticOptions });
	try {
		if (!options.readonly) migrateLegacyConfigFiles(agentDir);
	// Issue #6 — two-file layering: the base config.json plus the
	// config.local.json overlay (runtime-mutated state). See
	// getLocalConfigPath for the rationale.
	const currentBasePath = getConfigPath(agentDir);
	const currentLocalPath = getLocalConfigPath(agentDir);
	// Read-only preflight mirrors migration's precedence without touching the
	// filesystem: current config wins when present, otherwise inspect legacy.
	const baseObj = fileExists(currentBasePath)
		? readConfigObject(currentBasePath)
		: readConfigObject(options.readonly ? getLegacyConfigPath(agentDir) : currentBasePath);
	const localObj = fileExists(currentLocalPath)
		? readConfigObject(currentLocalPath)
		: readConfigObject(options.readonly ? getLegacyLocalConfigPath(agentDir) : currentLocalPath);
	if (!baseObj && !localObj) {
		return applyCommitADefaults({});
	}

	const obj = stripRemovedSyncByDefaultConfigKey(
		stripRemovedPlaneConfigKeys(mergeConfigObjects(baseObj ?? {}, localObj ?? {})),
	);
	const out: DelegateConfig = {};
	if (typeof obj.nativeEscalationUi === "boolean") out.nativeEscalationUi = obj.nativeEscalationUi;
	else if (obj.nativeEscalationUi !== undefined) {
		warnConfig("[delegate] ignoring invalid nativeEscalationUi; expected a boolean");
	}
	if ("globalToolWhitelist" in obj) {
		const raw = obj.globalToolWhitelist;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warnConfig("[delegate] ignoring invalid globalToolWhitelist; expected an object");
		} else {
			const source = raw as Record<string, unknown>;
			const cleaned: GlobalToolWhitelistConfig = {};
			for (const field of ["tools", "skills"] as const) {
				const value = source[field];
				if (value === undefined) continue;
				if (
					!Array.isArray(value) ||
					value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
				) {
					warnConfig(
						`[delegate] ignoring invalid globalToolWhitelist.${field}; expected an array of non-empty strings`,
					);
					continue;
				}
				cleaned[field] = [...new Set(value.map((entry) => entry.trim()))];
			}
			out.globalToolWhitelist = cleaned;
		}
	}
	if ("skill" in obj) {
		const rawSkill = obj.skill;
		if (!rawSkill || typeof rawSkill !== "object" || Array.isArray(rawSkill)) {
			warnConfig("[delegate] ignoring invalid skill; expected an object");
		} else {
			const rawExclude = (rawSkill as Record<string, unknown>).excludeSections;
			if (rawExclude !== undefined) {
				if (
					!Array.isArray(rawExclude) ||
					rawExclude.some((value) => typeof value !== "string" || value.length === 0)
				) {
					warnConfig("[delegate] ignoring invalid skill.excludeSections; expected an array of non-empty strings");
				} else {
					// Project the named field only. Unknown nested caller properties never
					// cross into the resolved configuration.
					out.skill = { excludeSections: [...rawExclude] };
				}
			}
		}
	}
	out.activityTicker = parseActivityTicker(obj.activityTicker);
	out.delegateOnly = parseDelegateOnly(obj.delegateOnly, warnConfig);
	if (typeof obj.enforceWallClockBudget === "boolean") {
		out.enforceWallClockBudget = obj.enforceWallClockBudget;
	} else if (obj.enforceWallClockBudget !== undefined) {
		warnConfig("[delegate] ignoring invalid enforceWallClockBudget; expected a boolean");
	}
	if (
		obj.footerIcons === "ascii" ||
		obj.footerIcons === "unicode" ||
		obj.footerIcons === "nerd-font"
	) {
		out.footerIcons = obj.footerIcons;
	} else if (obj.footerIcons !== undefined) {
		warnConfig(
			`[delegate] ignoring invalid footerIcons=${JSON.stringify(obj.footerIcons)}; expected "ascii", "unicode", or "nerd-font"`,
		);
		out.footerIcons = "ascii";
	}
	const escalationGlobalLayer = parseEscalationConfig(obj.escalation);
	if (escalationGlobalLayer !== undefined) out.escalationGlobalLayer = escalationGlobalLayer;
	out.escalation = resolveEscalationConfig({ global: escalationGlobalLayer });
	if (typeof obj.worktreeSetupHook === "string" && obj.worktreeSetupHook.trim().length > 0) {
		out.worktreeSetupHook = obj.worktreeSetupHook;
	}
	if (typeof obj.worktreeSetupHookTimeoutMs === "number" && Number.isFinite(obj.worktreeSetupHookTimeoutMs)) {
		out.worktreeSetupHookTimeoutMs = obj.worktreeSetupHookTimeoutMs;
	}
	if (typeof obj.notifyOnFailure === "boolean") {
		out.notifyOnFailure = obj.notifyOnFailure;
	} else if (obj.notifyOnFailure !== undefined) {
		warnConfig("[delegate] ignoring invalid notifyOnFailure; expected a boolean");
	}
	if ("perForkMaxDurationMs" in obj) {
		const v = obj.perForkMaxDurationMs;
		const normalized = normalizeTimeoutMs(v);
		if (normalized !== undefined) {
			// 0 = disabled, >0 = cap. Preserve both; absence → default below.
			out.perForkMaxDurationMs = normalized;
		} else {
			warnInvalidTimeout("perForkMaxDurationMs");
		}
	}
	if ("perForkMinDurationMs" in obj) {
		const v = obj.perForkMinDurationMs;
		const normalized = normalizeTimeoutMs(v);
		if (normalized !== undefined) {
			out.perForkMinDurationMs = normalized;
		} else {
			warnInvalidTimeout("perForkMinDurationMs");
		}
	}
	if (
		(out.perForkMinDurationMs ?? 0) > 0 &&
		(out.perForkMaxDurationMs ?? 0) > 0 &&
		(out.perForkMinDurationMs ?? 0) > (out.perForkMaxDurationMs ?? 0)
	) {
		warnConfig(
			"[delegate] ignoring contradictory timeout bounds: positive perForkMinDurationMs " +
			"exceeds positive perForkMaxDurationMs; the floor is ignored",
		);
		out.perForkMinDurationMs = DEFAULT_PER_FORK_MIN_DURATION_MS;
	}
	if ("windDownGraceMs" in obj) {
		const v = obj.windDownGraceMs;
		const normalized = normalizeTimeoutMs(v);
		if (normalized !== undefined) {
			// 0 = hard-cancel immediately after the wind-down steer.
			out.windDownGraceMs = normalized;
		} else {
			warnInvalidTimeout("windDownGraceMs");
		}
	}
	for (const field of ["cancelForkShortcut", "cancelForkBypassShortcut"] as const) {
		const v = obj[field];
		if (typeof v === "string") {
			// Empty string is a valid opt-out; any other string is accepted
			// verbatim (pi's shortcut registrar validates the actual keys).
			out[field] = v;
		} else if (v !== undefined) {
			warnConfig(
				`[delegate] ignoring invalid ${field}=${JSON.stringify(v)}; expected a string`,
			);
		}
	}
	for (const field of [
		"cancelConfirmCostUsd",
		"cancelConfirmRuntimeMs",
		"heartbeatIntervalMs",
		"maxConsecutiveHeartbeats",
		"heartbeatTailLines",
	] as const) {
		if (!(field in obj)) continue;
		const v = obj[field];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
			out[field] = v;
		} else {
			warnConfig(
				`[delegate] ignoring invalid ${field}=${JSON.stringify(v)}; expected a non-negative finite number`,
			);
		}
	}
	// inspectTailLines is stricter: must be >= 1 (a zero-sized tail would
	// render `inspect_worker` useless — diagnostic tools should always show
	// at least one entry of context). Reject 0 with a warning rather than
	// silently accepting it.
	if ("inspectTailLines" in obj) {
		const v = obj.inspectTailLines;
		if (typeof v === "number" && Number.isFinite(v) && v >= 1) {
			out.inspectTailLines = v;
		} else {
			warnConfig(
				`[delegate] ignoring invalid inspectTailLines=${JSON.stringify(v)}; expected a finite number >= 1`,
			);
		}
	}
	applyCommitADefaults(out);
	if (typeof obj.overlayShortcut === "string") {
		// Empty string is a valid explicit opt-out — preserve it.
		out.overlayShortcut = obj.overlayShortcut;
	}
	if (typeof obj.inspectorLayout === "string") {
		const v = obj.inspectorLayout as string;
		if (v === "dock" || v === "full") {
			out.inspectorLayout = v;
		} else {
			warnConfig(
				`[delegate] ignoring unknown inspectorLayout=${JSON.stringify(v)}; expected "dock" or "full"`,
			);
		}
	}
	if (
		obj.inspectorThinking === "hidden"
		|| obj.inspectorThinking === "preview"
		|| obj.inspectorThinking === "full"
	) {
		out.inspectorThinking = obj.inspectorThinking;
	} else if (obj.inspectorThinking !== undefined) {
		warnConfig(
			'[delegate] ignoring invalid inspectorThinking; expected "hidden", "preview", or "full"',
		);
	}
	if (
		obj.inspectorToolDetail === "chip"
		|| obj.inspectorToolDetail === "hidden"
		|| obj.inspectorToolDetail === "expanded"
	) {
		out.inspectorToolDetail = obj.inspectorToolDetail;
	} else if (obj.inspectorToolDetail !== undefined) {
		warnConfig(
			'[delegate] ignoring invalid inspectorToolDetail; expected "chip", "hidden", or "expanded"',
		);
	}
	if (typeof obj.inspectorFoldMessages === "boolean") {
		out.inspectorFoldMessages = obj.inspectorFoldMessages;
	} else if (obj.inspectorFoldMessages !== undefined) {
		warnConfig(
			"[delegate] ignoring invalid inspectorFoldMessages; expected a boolean",
		);
	}
	if (typeof obj.autoCloseInspectorOnComplete === "boolean") {
		out.autoCloseInspectorOnComplete = obj.autoCloseInspectorOnComplete;
	} else if (obj.autoCloseInspectorOnComplete !== undefined) {
		warnConfig(
			`[delegate] ignoring invalid autoCloseInspectorOnComplete=${JSON.stringify(obj.autoCloseInspectorOnComplete)}; expected a boolean`,
		);
	}
	if (typeof obj.disableBuiltins === "boolean") {
		out.disableBuiltins = obj.disableBuiltins;
	} else if (obj.disableBuiltins !== undefined) {
		warnConfig(
			`[delegate] ignoring invalid disableBuiltins=${JSON.stringify(obj.disableBuiltins)}; expected a boolean`,
		);
	}
	if ("intercomBridge" in obj) {
		const raw = obj.intercomBridge;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const r = raw as Record<string, unknown>;
			const cleaned: NonNullable<DelegateConfig["intercomBridge"]> = {};
			if (
				r.mode === "off" ||
				r.mode === "always" ||
				r.mode === "fork-only"
			) {
				cleaned.mode = r.mode;
			} else if (r.mode !== undefined) {
				warnConfig(
					`[delegate] ignoring invalid intercomBridge.mode=${JSON.stringify(r.mode)}; expected one of "off", "always", "fork-only"`,
				);
			}
			if (typeof r.instructionFile === "string" && r.instructionFile.trim().length > 0) {
				cleaned.instructionFile = r.instructionFile;
			} else if (r.instructionFile !== undefined) {
				warnConfig(
					`[delegate] ignoring invalid intercomBridge.instructionFile=${JSON.stringify(r.instructionFile)}; expected a non-empty string`,
				);
			}
			if (Object.keys(cleaned).length > 0) out.intercomBridge = cleaned;
		} else if (raw !== undefined) {
			warnConfig(
				`[delegate] ignoring invalid intercomBridge=${JSON.stringify(raw)}; expected an object`,
			);
		}
	}
	if ("ptmBridge" in obj) {
		const raw = obj.ptmBridge;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const r = raw as Record<string, unknown>;
			const cleaned: NonNullable<DelegateConfig["ptmBridge"]> = {};
			if (
				r.handleRequests === "auto" ||
				r.handleRequests === "always" ||
				r.handleRequests === "never"
			) {
				cleaned.handleRequests = r.handleRequests;
			} else if (r.handleRequests !== undefined) {
				warnConfig(
					`[delegate] ignoring invalid ptmBridge.handleRequests=${JSON.stringify(r.handleRequests)}; expected one of "auto", "always", "never"`,
				);
			}
			if (Object.keys(cleaned).length > 0) out.ptmBridge = cleaned;
		} else if (raw !== undefined) {
			warnConfig(
				`[delegate] ignoring invalid ptmBridge=${JSON.stringify(raw)}; expected an object`,
			);
		}
	}
	if ("agentOverrides" in obj) {
		const raw = obj.agentOverrides;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const cleaned: Record<string, AgentOverride> = {};
			for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
				const trimmed = name.trim();
				if (!trimmed) continue;
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					warnConfig("[delegate] ignoring invalid agent override; expected each value to be an object");
					continue;
				}
				const rawOverride = stripRemovedPlaneConfigKeys(
					value as Record<string, unknown>,
					"agentOverrides.",
					true,
				);
				const removedArtifactField = ["output", "outputFrom"].find((field) =>
					Object.prototype.hasOwnProperty.call(rawOverride, field),
				);
				if (removedArtifactField) {
					warnConfig(`[delegate] ignoring agent override with removed field ${removedArtifactField}; use artifact instead`);
					continue;
				}
				const override: Record<string, unknown> = { ...rawOverride };
				for (const field of ["maxDurationMs", "max_duration_ms", "windDownGraceMs", "wind_down_grace_ms"] as const) {
					if (!(field in rawOverride)) continue;
					const value = rawOverride[field];
					if (normalizeTimeoutMs(value) !== undefined) continue;
					delete override[field];
					// The agent name is caller-controlled too; keep it out of diagnostics.
					warnInvalidTimeout(`agentOverrides.${field}`);
				}
				if (override.maxDurationMs === undefined && override.max_duration_ms !== undefined) {
					override.maxDurationMs = override.max_duration_ms;
				}
				if (override.windDownGraceMs === undefined && override.wind_down_grace_ms !== undefined) {
					override.windDownGraceMs = override.wind_down_grace_ms;
				}
				delete override.max_duration_ms;
				delete override.wind_down_grace_ms;
				if ("env" in rawOverride) {
					try {
						override.env = parseEnvOverrides(rawOverride.env, "agentOverrides.env");
					} catch (_err) {
						warnConfig("[delegate] ignoring invalid agent override environment");
						continue;
					}
				}
				const thinkingKeys = ["thinking", "thinkingMin", "thinkingMax"] as const;
				if (thinkingKeys.some((key) => key in rawOverride)) {
					try {
						const normalized = normalizeThinkingFields(rawOverride);
						for (const key of thinkingKeys) delete override[key];
						Object.assign(override, normalized);
					} catch (_err) {
						warnConfig("[delegate] ignoring invalid agent override thinking policy");
						continue;
					}
				}
				cleaned[trimmed] = override as AgentOverride;
			}
			if (Object.keys(cleaned).length > 0) out.agentOverrides = cleaned;
		} else if (raw !== undefined) {
			warnConfig("[delegate] ignoring invalid agentOverrides; expected an object map");
		}
	}
	if (typeof obj.completionNotifyStrategy === "string") {
		const v = obj.completionNotifyStrategy as string;
		if (v === "auto" || v === "synthetic-tool-pair" || v === "custom-message") {
			out.completionNotifyStrategy = v;
			if (v === "synthetic-tool-pair") {
				warnConfig(
					"[delegate] completionNotifyStrategy=synthetic-tool-pair is reserved and " +
						"unsupported by the current Pi API; falling back to custom-message.",
				);
			}
		} else {
			warnConfig(
				`[delegate] ignoring unknown completionNotifyStrategy=${JSON.stringify(v)}; ` +
					'expected one of "auto", "synthetic-tool-pair", "custom-message"',
			);
		}
	}
		return out;
	} finally {
		configDiagnosticSink = previousDiagnosticSink;
	}
}

/**
 * Read the effective config snapshot for invocation preflight. Unlike the
 * normal loader this never migrates legacy files, creates directories, or
 * emits diagnostics; callers may safely discard it on a rejected call.
 */
export function loadConfigReadOnly(agentDir: string = getAgentDir()): DelegateConfig {
	return loadConfig(agentDir, { readonly: true });
}
