/**
 * Agent discovery for delegate.
 *
 * Reuses the `~/.pi/agent/agents/*.md` + `.pi/agents/*.md` YAML-frontmatter
 * format used by pi-subagents, and extends it with optional delegate-specific
 * fields.
 *
 * Run-delegate also ships a bundled builtin-agent snapshot under
 * `../builtin-agents/`. User and project agents still override those builtins
 * on name collisions; additional workflow agents may arrive through the
 * package discovery layer.
 *
 * Frontmatter fields (all optional unless noted):
 *   name:                   (required) unique agent identifier
 *   description:            (required) what this agent does
 *   tools:                  YAML array of tool names. Entries prefixed `mcp:`
 *                           are split out into `mcpDirectTools` (prefix stripped).
 *   model:                  provider/id or bare id (default: main agent's model)
 *   fallbackModels:         YAML array of model refs tried in order if
 *                           `model` is unavailable.
 *   thinking:               one of "off" | "minimal" | "low" | "medium" |
 *                           "high" | "xhigh" | "max". Forwarded as thinkingLevel.
 *   thinkingMin/Max:        optional session-local adaptive-thinking bounds.
 *                           When present, `thinking` must fall within them.
 *   systemPromptMode:       "append" | "replace" (default "replace").
 *   inheritProjectContext:  boolean (default false). Accepts bool or "true"/"false".
 *   inheritSkills:          boolean (default false).
 *   skills:                 YAML array of skill names to keep.
 *   extensions:             YAML array of extension paths to load.
 *   extensionInclude:       YAML array of portable extension selectors to require.
 *   extensionExclude:       YAML array of portable extension selectors to remove.
 *   defaultMaxRounds:       max message_subagent calls per run (default: 5)
 *   stopConditionHint:      natural-language cue for when the supervised clone should stop
 *   collapseMode:           "final_output" | "summary" (default: "final_output")
 *   summaryModel:           provider/id for collapse, or "auto" for built-in Haiku 4.5 (omitted: no provider call)
 *   maxDurationMs:          supervised-run absolute budget in milliseconds; 0 disables
 *   windDownGraceMs:        supervised-run grace after budget expiry; 0 hard-cancels after steer
 *
 * Direct/chain mode fields (Phase A; ignored in supervised mode):
 *   defaultReads:           YAML array of paths read into the worker's first message as `<context-file>` blocks.
 *   defaultProgress:        boolean. When true, the worker's chain-dir gets a `progress.md` updated each step.
 *   artifact:               filename the runtime resolves in the per-worktree artifact workspace and
 *                           injects to the worker as an absolute path; its non-empty contents become
 *                           the worker's deliverable after clean completion, while the final message
 *                           stays the handoff. Not the worker cwd.
 *   check:                  shell command that validates the artifact before it is delivered.
 *   interactive:            boolean. Routes worker UI prompts to the overlay (Phase 3c).
 *   maxSubagentDepth:       integer cap on recursive delegate depth.
 *   allowNestedDelegate:    boolean opt-in for delegate-family tools requested in `tools:`.
 *   nestedDelegateAgents:   optional YAML array child-agent allow-list enforced when this worker calls `delegate`.
 *
 * Snake_case aliases and CSV list values remain readable for legacy files, but
 * are deprecated; new files should use the camelCase names and YAML arrays above.
 * Unknown fields are preserved in `extraFields` rather than silently dropped.
 *
 * Package-shipped agents and chains (source="package") additionally come from
 * the same opted-in package agent directories: `pi-delegate.agents` paths or
 * the `agents/` convention directory enabled by any `pi: {...}` manifest.
 * Discovery walks the following locations (in addition to the cwd's own
 * root, which is checked first when cwd is itself a pi package):
 *   - `node_modules` directories from cwd upward (standard Node module
 *     resolution)
 *   - `<cwd>/.pi/npm/node_modules` (pi project-scope npm installs)
 *   - `<cwd>/.pi/git` (pi project-scope git installs, recursive scan)
 *   - `<getAgentDir()>/git` (pi user-scope git installs, recursive scan)
 *   - `<getAgentDir()>/extensions` (pi user-scope extensions, often
 *     dev symlinks back to a working repo)
 * Override priority: builtin < package < user < project (later wins).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseChain } from "./chain-serializer.js";
import { stripRemovedPlaneConfigKeys, type EscalationConfig } from "./config.js";
import { validateMaxSubagentDepth } from "./depth-guard.js";
import { parseEnvOverrides, type EnvOverrides } from "./env-overrides.js";
import { parseEscalationInvocationValue } from "./escalation-policy.js";
import { firstValidTimeoutMs } from "./fork-timeout.js";
import { normalizeThinkingFields, type ThinkingLevel } from "./thinking-policy.js";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "user" | "project" | "package";

/** Whether a definition source participates in a read-only discovery scope. */
export function sourceVisibleInAgentScope(source: AgentSource, scope: AgentScope): boolean {
	if (source === "builtin" || scope === "both") return true;
	if (scope === "user") return source === "package" || source === "user";
	return source === "project";
}

/**
 * Scope precedence, lowest to highest, shared by agent and chain resolution.
 * Package-shipped chains use the same precedence as package agents.
 */
export const SCOPE_PRECEDENCE = ["builtin", "package", "user", "project"] as const;

const scopePrecedence = (source: AgentSource): number => SCOPE_PRECEDENCE.indexOf(source);

/**
 * Discovery warnings are keyed by their complete rendered console text so a
 * repeated filesystem scan cannot re-emit the same line. Keep this set for
 * the process lifetime: evicting entries would allow a long-lived completion
 * callback to reintroduce the warning spam this guard is intended to stop.
 *
 * Because the set outlives any one test and the suite shares a process, a test
 * that asserts on console output must call
 * `__resetDiscoveryWarningConsoleForTests()` first. Otherwise an earlier test
 * that emitted the identical rendered text silently suppresses the line, and
 * the failure looks like a bug in the code under test rather than an ordering
 * artefact. Existing tests are safe only because their warning texts embed
 * per-test temporary paths; a warning with fixed text would not be.
 */
const emittedDiscoveryWarningTexts = new Set<string>();

function warnDiscoveryWarning(warning: string): void {
	const rendered = `[pi-delegate] ${warning}`;
	if (emittedDiscoveryWarningTexts.has(rendered)) return;
	emittedDiscoveryWarningTexts.add(rendered);
	// Issue #10 also surfaces discovery warnings through the delegate_agents
	// list output and its structured details, so this console write is redundant
	// and does corrupt the TUI (#306). It stays until #165 fixes the
	// per-keystroke re-emission it belongs to, and because several tests assert
	// on its exact `[pi-delegate] …` text.
	// eslint-disable-next-line no-console -- see #165
	console.warn(rendered);
}

/** Test-only reset for the process-lifetime discovery warning set. */
export function __resetDiscoveryWarningConsoleForTests(): void {
	emittedDiscoveryWarningTexts.clear();
}

/**
 * Resolve same-named definitions by their own source scope, independent of
 * input order. The optional callback receives each lower-precedence
 * winner/loser shadowing pair. Equal-precedence replacement is silent, matching
 * the caller's existing within-scope last-wins behavior. Winner output
 * preserves first-seen name order so discovery ordering stays stable.
 */
export function resolveByScopePrecedence<T extends { name: string; source: AgentSource }>(
	items: readonly T[],
	onShadow?: (winner: T, loser: T) => void,
): T[] {
	const winners = new Map<string, T>();
	for (const item of items) {
		const current = winners.get(item.name);
		if (!current || scopePrecedence(item.source) >= scopePrecedence(current.source)) {
			winners.set(item.name, item);
		}
	}

	for (const item of items) {
		const winner = winners.get(item.name);
		if (winner && scopePrecedence(item.source) < scopePrecedence(winner.source)) {
			onShadow?.(winner, item);
		}
	}

	return [...winners.values()];
}

export type CollapseMode = "final_output" | "summary";
export type SystemPromptMode = "append" | "replace";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Per-worker environment patch; values are never rendered in diagnostics. */
	env?: EnvOverrides;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	/**
	 * Package name (`package.json:name`) of the source package when
	 * `source === "package"`. Surfaced for debugging / audit; consumers can
	 * answer "where did this agent come from" without re-walking node_modules.
	 */
	packageName?: string;

	// pi-subagents alignment fields
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	fallbackModels?: string[];
	mcpDirectTools?: string[];
	extensions?: string[];
	extensionInclude?: string[];
	extensionExclude?: string[];
	thinking?: ThinkingLevel;
	thinkingMin?: ThinkingLevel;
	thinkingMax?: ThinkingLevel;

	// Delegate-specific extensions (all optional)
	defaultMaxRounds?: number;
	stopConditionHint?: string;
	collapseMode?: CollapseMode;
	summaryModel?: string;

	// Phase A: direct/chain-mode fields. Honoured by `runDirectWorker` and
	// chain-mode steps; supervised runs ignore them.
	defaultReads?: string[];
	/** Grant this agent's workers capped search access to the parent transcript. */
	parentTranscriptSearch?: boolean;
	defaultProgress?: boolean;
	artifact?: string;
	/**
	 * Validation command run against this agent's declared artifact when a
	 * producing worker finishes (#419). Honoured as an agent-level default on
	 * independent direct runs and on chain-mode steps that use this agent. There
	 * is deliberately no per-step `check` override on the legacy chain-step
	 * schema: saved chains are deprecated (#182), so the check contract targets
	 * the current independent-`runs[]` dispatch model, not new chain surface.
	 */
	check?: string;
	interactive?: boolean;
	maxSubagentDepth?: number;
	allowNestedDelegate?: boolean;
	nestedDelegateAgents?: string[];
	/** Supervised-run absolute budget override; 0 explicitly disables. */
	maxDurationMs?: number;
	/** Supervised-run wind-down grace override; 0 means immediate cancel. */
	windDownGraceMs?: number;
	/** This agent's partial escalation-policy layer. [spec §5, Q4] */
	escalation?: EscalationConfig;

	// Other unknown keys are preserved verbatim in extraFields.
	extraFields?: Record<string, string>;
}


const EMPTY_OPTIONAL_GLOBAL_TOOL_ENTRIES: ReadonlySet<string> = new Set();
const optionalGlobalToolEntries = new WeakMap<AgentConfig, ReadonlySet<string>>();

/** @internal Trusted post-discovery provenance; never populated from agent input. */
export function setOptionalGlobalToolEntries(
	agent: AgentConfig,
	entries: readonly string[],
): void {
	if (entries.length === 0) {
		optionalGlobalToolEntries.delete(agent);
		return;
	}
	optionalGlobalToolEntries.set(agent, new Set(entries));
}

/** @internal Read trusted global-only tool provenance without exposing mutable state. */
export function getOptionalGlobalToolEntries(agent: AgentConfig): ReadonlySet<string> {
	return optionalGlobalToolEntries.get(agent) ?? EMPTY_OPTIONAL_GLOBAL_TOOL_ENTRIES;
}

/** @internal Preserve trusted provenance across an ordinary AgentConfig clone. */
export function copyOptionalGlobalToolEntries(source: AgentConfig, target: AgentConfig): AgentConfig {
	setOptionalGlobalToolEntries(target, [...getOptionalGlobalToolEntries(source)]);
	return target;
}
export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/**
	 * Resolved repo root that owns `projectAgentsDir` (the ancestor with project
	 * agent and chain definitions in `.agents/`, `.agents/agents/`, or
	 * `.pi/agents/`, listed from lowest to highest precedence). `null` when no
	 * project root was found or when scope === "user". Used by trust-list logic
	 * so we key "remember this approval" off the repo path, not the agents dir.
	 */
	projectRoot: string | null;
	/**
	 * Non-fatal discovery warnings, including skipped files and actionable
	 * frontmatter deprecations or invalid optional values. Empty when every
	 * file loaded without diagnostics.
	 */
	warnings: string[];
}

/** Bounds used by read-only health discovery; ordinary dispatch remains unbounded. */
export interface AgentDiscoveryLimits {
	/** Maximum number of agent definition files to open across one discovery. */
	maxFiles: number;
	/** Maximum number of bytes read from one agent definition file. */
	maxFileBytes: number;
	/** Maximum package manifests to inspect during one discovery. */
	maxPackageEntries?: number;
	/** Maximum directory entries examined by package enumeration. */
	maxPackageDirectoryEntries?: number;
	/** Maximum chain definition files to open during one discovery. */
	maxChainFiles?: number;
}

/** Shared state for one bounded discovery pass. */
export interface AgentDiscoveryBudget {
	limits: AgentDiscoveryLimits;
	filesRead: number;
	packageEntriesRead: number;
	packageDirectoryEntriesRead: number;
	chainFilesRead: number;
	degraded: boolean;
	truncated: boolean;
}

/** Additive roots resolved by Pi's configured package manager. */
export interface PackageAgentDiscoveryOptions {
	additionalResolvedPackageRoots?: readonly string[];
	/** Optional bounded mode used only by read-only health discovery. */
	agentDiscoveryLimits?: AgentDiscoveryLimits;
	/** Internal health seam; absent for normal dispatch and management discovery. */
	agentDiscoveryBudget?: AgentDiscoveryBudget;
}

export interface AgentDiscoveryScanStatus {
	filesRead: number;
	degraded: boolean;
	truncated: boolean;
}

// Chain-file types live next to the agent types so management actions and
// chain-serializer.ts can share them without a circular import.
export type ChainWorkerStepFileConfig = {
	agent: string;
	chain?: never;
	run?: never;
	task: string;
	env?: EnvOverrides;
	artifact?: string | false;
	reads?: string[] | false;
	model?: string;
	thinking?: string | false;
	thinkingMin?: string | false;
	thinkingMax?: string | false;
	skills?: string[] | false;
	progress?: boolean;
};

/** A saved-chain composition boundary. Worker-only options are deliberately absent. */
export type ChainReferenceStepFileConfig = {
	chain: string;
	agent?: never;
	run?: never;
	task: string;
	env?: never;
	artifact?: never;
	reads?: never;
	model?: never;
	thinking?: never;
	thinkingMin?: never;
	thinkingMax?: never;
	skills?: never;
	progress?: never;
};

/** A native deterministic command stage in a persisted saved chain. */
export type ChainRunStepFileConfig = {
	run: string;
	command: string;
	cwd?: string;
	env?: EnvOverrides;
	timeoutMs?: number;
	agent?: never;
	chain?: never;
	task?: never;
	artifact?: never;
	reads?: never;
	model?: never;
	thinking?: never;
	thinkingMin?: never;
	thinkingMax?: never;
	skills?: never;
	progress?: never;
};

/** Persisted saved-chain steps are workers, deterministic runs, or references. */
export type ChainStepFileConfig = ChainWorkerStepFileConfig | ChainRunStepFileConfig | ChainReferenceStepFileConfig;

export function isChainReferenceStepFileConfig(
	step: ChainStepFileConfig,
): step is ChainReferenceStepFileConfig {
	return typeof (step as { chain?: unknown }).chain === "string";
}

export function isChainRunStepFileConfig(
	step: ChainStepFileConfig,
): step is ChainRunStepFileConfig {
	return typeof (step as { run?: unknown }).run === "string";
}

export function isChainWorkerStepFileConfig(
	step: ChainStepFileConfig,
): step is ChainWorkerStepFileConfig {
	return typeof (step as { agent?: unknown }).agent === "string";
}

export type ChainFileSource = AgentSource;

export interface ChainFileConfig {
	name: string;
	description: string;
	source: ChainFileSource;
	filePath: string;
	steps: ChainStepFileConfig[];
	extraFields?: Record<string, string>;
}

/** Render the diagnostic emitted when a lower-scope chain is shadowed. */
export function formatChainShadowWarning(winner: ChainFileConfig, loser: ChainFileConfig): string {
	return (
		`Chain '${loser.name}' from ${loser.filePath} is shadowed by ${winner.filePath}; ` +
		`using ${winner.filePath} (${winner.source} scope).`
	);
}

export interface AgentsAllDiscoveryResult {
	cwd: string;
	builtin: AgentConfig[];
	/**
	 * Agents shipped by installed packages (source = "package"). See
	 * `loadPackageAgents()` for discovery rules. Always present for
	 * `scope: "both"` consumers; `discoverAgents` filters them out under
	 * `scope: "project"`.
	 */
	package: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	/**
	 * Every discovered chain candidate across all scopes. Several entries may
	 * share a name; candidates are ordered from lowest to highest precedence.
	 * Callers wanting the resolved chain for a name must use
	 * `resolveByScopePrecedence` rather than selecting the first candidate.
	 */
	chains: ChainFileConfig[];
	userDir: string;
	projectDir: string | null;
	projectRoot: string | null;
	/** Issue #10 — non-fatal discovery warnings (skipped agent files). */
	warnings: string[];
	/** Present only for bounded health discovery. */
	agentDiscoveryScan?: AgentDiscoveryScanStatus;
}

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"tools",
	"model",
	"env",
	"fallbackModels",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"skill",
	"skills",
	"extensions",
	"extensionInclude",
	"extension_include",
	"extensionExclude",
	"extension_exclude",
	// delegate delegate fields (snake + camel)
	"default_max_rounds",
	"defaultMaxRounds",
	"stop_condition_hint",
	"stopConditionHint",
	"collapse_mode",
	"collapseMode",
	"summary_model",
	"summaryModel",
	// Phase A direct/chain-mode fields (snake + camel where applicable)
	"defaultReads",
	"default_reads",
	"parentTranscriptSearch",
	"parent_transcript_search",
	"defaultProgress",
	"default_progress",
	"artifact",
	"check",
	"interactive",
	"maxSubagentDepth",
	"max_subagent_depth",
	"allowNestedDelegate",
	"allow_nested_delegate",
	"nestedDelegateAgents",
	"nested_delegate_agents",
	"maxDurationMs",
	"max_duration_ms",
	"windDownGraceMs",
	"wind_down_grace_ms",
	"escalation",
]);

const FRONTMATTER_ALIASES = {
	default_max_rounds: "defaultMaxRounds",
	stop_condition_hint: "stopConditionHint",
	collapse_mode: "collapseMode",
	summary_model: "summaryModel",
	default_reads: "defaultReads",
	parent_transcript_search: "parentTranscriptSearch",
	default_progress: "defaultProgress",
	max_subagent_depth: "maxSubagentDepth",
	allow_nested_delegate: "allowNestedDelegate",
	nested_delegate_agents: "nestedDelegateAgents",
	max_duration_ms: "maxDurationMs",
	wind_down_grace_ms: "windDownGraceMs",
	extension_include: "extensionInclude",
	extension_exclude: "extensionExclude",
} as const;

type FrontmatterAlias = keyof typeof FRONTMATTER_ALIASES;

function warnFrontmatter(filePath: string, detail: string, warnings?: string[]): void {
	const warning = `${filePath}: ${detail}`;
	warnDiscoveryWarning(warning);
	warnings?.push(warning);
}

function warnDeprecatedAlias(
	key: FrontmatterAlias,
	filePath: string,
	warnings?: string[],
): void {
	warnFrontmatter(
		filePath,
		`deprecated frontmatter spelling '${key}'; use canonical '${FRONTMATTER_ALIASES[key]}' instead.`,
		warnings,
	);
}

function warnInvalidValue(
	field: string,
	raw: unknown,
	accepted: string,
	filePath?: string,
	warnings?: string[],
): void {
	if (!filePath) return;
	let value: string;
	try {
		const rendered = JSON.stringify(raw);
		value = rendered === undefined ? String(raw) : rendered;
	} catch {
		value = String(raw);
	}
	warnFrontmatter(
		filePath,
		`invalid ${field} value ${value}; accepted values are ${accepted}.`,
		warnings,
	);
}

function warnAliases(frontmatter: Record<string, unknown>, filePath: string, warnings?: string[]): void {
	for (const key of Object.keys(FRONTMATTER_ALIASES) as FrontmatterAlias[]) {
		if (Object.prototype.hasOwnProperty.call(frontmatter, key)) warnDeprecatedAlias(key, filePath, warnings);
	}
}

const ESCALATION_FIELDS = [
	"mode",
	"authority",
	"intermediate",
	"hopTimeoutMs",
	"timeoutMs",
	"timeoutBehavior",
	"holdStrategy",
] as const;
const ESCALATION_AUTHORITY_FIELDS = ["decision", "blocker", "amendment", "tags"] as const;


/**
 * Parse the canonical YAML flow-list form emitted by agent-serializer.ts.
 * Legacy hand-written CSV remains readable so existing agent files do not
 * disappear when discovery is upgraded; management writes only flow lists.
 */
function splitCsv(raw: unknown): string[] | undefined {
	if (Array.isArray(raw)) {
		// YAML sequence elements are already individual values. Do not trim,
		// drop empty strings, or split commas inside an element.
		return raw.filter((value): value is string => typeof value === "string");
	}
	if (typeof raw !== "string") return undefined;
	const parts = raw
		.split(",")
		.map((s) => {
			const trimmed = s.trim();
			if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
				try {
					const parsed = JSON.parse(trimmed);
					if (typeof parsed === "string") return parsed;
				} catch {
					/* keep the literal value; malformed YAML is diagnosed upstream */
				}
			}
			return trimmed;
		})
		.filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

/**
 * Split a tools CSV into plain tool names and MCP direct-tool names.
 * Mirrors pi-subagents' agents.ts splitToolList logic: entries prefixed
 * `mcp:` are moved to mcpDirectTools with the prefix stripped.
 */
export function splitToolList(raw: unknown): {
	tools: string[] | undefined;
	mcpDirectTools: string[] | undefined;
} {
	const all = splitCsv(raw);
	if (!all) return { tools: undefined, mcpDirectTools: undefined };
	const tools: string[] = [];
	const mcp: string[] = [];
	for (const t of all) {
		if (t.startsWith("mcp:")) mcp.push(t.slice(4));
		else tools.push(t);
	}
	return {
		tools: tools.length > 0 ? tools : undefined,
		mcpDirectTools: mcp.length > 0 ? mcp : undefined,
	};
}

function parseBoolLoose(
	raw: unknown,
	fallback: boolean,
	field?: string,
	filePath?: string,
	warnings?: string[],
): boolean {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		if (v === "true") return true;
		if (v === "false") return false;
	}
	if (raw !== undefined) warnInvalidValue(field ?? "boolean field", raw, "true or false", filePath, warnings);
	return fallback;
}

/**
 * Like `parseBoolLoose` but returns `undefined` when the input isn't a
 * recognisable boolean — used for optional frontmatter fields where we
 * want to distinguish "absent" from "explicit false".
 */
function parseBoolMaybe(
	raw: unknown,
	field?: string,
	filePath?: string,
	warnings?: string[],
): boolean | undefined {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		if (v === "true") return true;
		if (v === "false") return false;
	}
	if (raw !== undefined) warnInvalidValue(field ?? "boolean field", raw, "true or false", filePath, warnings);
	return undefined;
}

function parseSystemPromptMode(
	raw: unknown,
	filePath?: string,
	warnings?: string[],
): SystemPromptMode {
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		if (v === "replace") return "replace";
		if (v === "append") return "append";
	}
	if (raw !== undefined) warnInvalidValue("systemPromptMode", raw, '"append" or "replace"', filePath, warnings);
	return "replace";
}

function parseModelRef(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseFilename(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseCollapseMode(
	raw: unknown,
	filePath?: string,
	warnings?: string[],
): CollapseMode | undefined {
	if (typeof raw !== "string") {
		if (raw !== undefined) warnInvalidValue(
			"collapseMode",
			raw,
			'"final_output", "final-output", "final", "summary", "summarize", or "summarised"',
			filePath,
			warnings,
		);
		return undefined;
	}
	const v = raw.trim().toLowerCase();
	if (v === "final_output" || v === "final-output" || v === "final") return "final_output";
	if (v === "summary" || v === "summarize" || v === "summarised") return "summary";
	warnInvalidValue(
		"collapseMode",
		raw,
		'"final_output", "final-output", "final", "summary", "summarize", or "summarised"',
		filePath,
		warnings,
	);
	return undefined;
}

function parseIntMaybe(raw: unknown): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Strict parser for the security-sensitive recursive-depth policy. */
function parseMaxSubagentDepth(raw: unknown): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	let value: number;
	if (typeof raw === "number") {
		value = raw;
	} else if (typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw.trim())) {
		value = Number(raw.trim());
	} else {
		throw new TypeError(`maxSubagentDepth must be a non-negative integer; received ${String(raw)}`);
	}
	return validateMaxSubagentDepth(value);
}

function firstString(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === "string" && v.trim().length > 0) return v;
	}
	return undefined;
}

/**
 * Parse optional agent frontmatter field-by-field. A malformed block is
 * ignored; malformed optional fields warn and are omitted without dropping
 * the otherwise-valid agent, matching the other tolerant agent fields.
 */
function parseAgentEscalation(
	raw: unknown,
	filePath: string,
	warnings?: string[],
): EscalationConfig | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string") {
		try {
			return parseEscalationInvocationValue(raw, "escalation");
		} catch (error) {
			warnAgentEscalation(filePath, (error as Error).message, warnings);
			return undefined;
		}
	}
	if (!isPlainObject(raw)) {
		warnAgentEscalation(filePath, "escalation must be \"off\", \"local\", or an object; block ignored", warnings);
		return undefined;
	}

	const out: EscalationConfig = {};
	for (const field of ESCALATION_FIELDS) {
		if (!(field in raw) || field === "authority") continue;
		try {
			Object.assign(out, parseEscalationInvocationValue({ [field]: raw[field] }, "escalation"));
		} catch (error) {
			warnAgentEscalation(filePath, (error as Error).message, warnings);
		}
	}
	if ("authority" in raw) {
		if (!isPlainObject(raw.authority)) {
			warnAgentEscalation(filePath, "escalation.authority must be an object; field ignored", warnings);
		} else {
			const authority: NonNullable<EscalationConfig["authority"]> = {};
			for (const field of ESCALATION_AUTHORITY_FIELDS) {
				if (!(field in raw.authority)) continue;
				try {
					const parsed = parseEscalationInvocationValue(
						{ authority: { [field]: raw.authority[field] } },
						"escalation",
					);
					Object.assign(authority, parsed.authority);
				} catch (error) {
					warnAgentEscalation(filePath, (error as Error).message, warnings);
				}
			}
			if (Object.keys(authority).length > 0) out.authority = authority;
		}
	}
	for (const field of Object.keys(raw)) {
		if ((ESCALATION_FIELDS as readonly string[]).includes(field)) continue;
		warnAgentEscalation(filePath, `escalation.${field} is not a supported escalation field; field ignored`, warnings);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function warnAgentEscalation(filePath: string, detail: string, warnings?: string[]): void {
	const warning = `${filePath}: invalid escalation frontmatter — ${detail}.`;
	warnDiscoveryWarning(warning);
	warnings?.push(warning);
}

/**
 * Summarize a frontmatter parser failure without echoing its message. YAML
 * parser messages commonly include the offending source line, which may hold
 * environment values or other credentials. Structured error metadata is safe
 * and keeps the warning actionable without exposing file contents.
 */
function summarizeFrontmatterParseError(error: unknown): string {
	const candidate = error as {
		name?: unknown;
		code?: unknown;
		linePos?: unknown;
	};
	const errorName = typeof candidate?.name === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.name)
		? candidate.name
		: "YAML parse error";
	const code = typeof candidate?.code === "string" && /^[A-Za-z0-9_-]+$/.test(candidate.code)
		? candidate.code
		: undefined;
	const firstPosition = Array.isArray(candidate?.linePos) ? candidate.linePos[0] : undefined;
	const line = typeof firstPosition?.line === "number" && Number.isFinite(firstPosition.line)
		? firstPosition.line
		: undefined;
	const column = typeof firstPosition?.col === "number" && Number.isFinite(firstPosition.col)
		? firstPosition.col
		: undefined;

	return [
		errorName,
		code ? `(${code})` : undefined,
		line === undefined ? undefined : `at line ${line}${column === undefined ? "" : `, column ${column}`}`,
	].filter(Boolean).join(" ");
}

function isFrontmatterParseError(error: unknown): boolean {
	const candidate = error as { name?: unknown; code?: unknown; linePos?: unknown };
	return (
		(typeof candidate?.name === "string" && /yaml/i.test(candidate.name)) ||
		Array.isArray(candidate?.linePos)
	);
}

function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
	packageName?: string,
	/**
	 * Issue #10 — collector for skipped-file warnings. When provided, every
	 * warn-and-skip (malformed frontmatter) ALSO records a warning string so
	 * discovery consumers (`action:"list"`) can show that an agent file was
	 * silently dropped instead of it just vanishing from the list.
	 */
	warnings?: string[],
	onlyFilePath?: string,
	budget?: AgentDiscoveryBudget,
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[] | undefined;
	let directory: fs.Dir | undefined;
	try {
		if (budget) directory = fs.opendirSync(dir);
		else entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	let entryIndex = 0;
	let directoryEntriesRead = 0;
	try {
		while (true) {
			if (budget && budget.filesRead >= budget.limits.maxFiles) {
				budget.truncated = true;
				break;
			}
			if (budget && directoryEntriesRead >= Math.max(budget.limits.maxFiles * 2, 100)) {
				budget.truncated = true;
				break;
			}
			const entry = directory ? directory.readSync() : entries?.[entryIndex++];
			if (!entry) break;
			directoryEntriesRead++;

			if (onlyFilePath === undefined && (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md"))) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const filePath = path.join(dir, entry.name);
			if (onlyFilePath !== undefined && path.resolve(filePath) !== path.resolve(onlyFilePath)) continue;
			if (budget) {
				budget.filesRead++;
			}
			let content: string;
			try {
				if (!budget) {
					content = fs.readFileSync(filePath, "utf-8");
				} else {
					const fd = fs.openSync(filePath, "r");
					try {
						const stat = fs.fstatSync(fd);
						if (stat.size > budget.limits.maxFileBytes) {
							budget.degraded = true;
							budget.truncated = true;
							warnings?.push(`Skipping agent file ${filePath}: definition exceeds the health scan size bound.`);
							continue;
						}
						const buffer = Buffer.alloc(budget.limits.maxFileBytes + 1);
						const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
						if (bytesRead > budget.limits.maxFileBytes) {
							budget.degraded = true;
							budget.truncated = true;
							warnings?.push(`Skipping agent file ${filePath}: definition exceeds the health scan size bound.`);
							continue;
						}
						content = buffer.subarray(0, bytesRead).toString("utf-8");
					} finally {
						fs.closeSync(fd);
					}
				}
			} catch {
				continue;
			}

			let frontmatter: Record<string, unknown>;
			let body: string;
			try {
				({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
			} catch (err) {
			// One bad file should not poison the entire directory's discovery.
			// Do not include the parser's message: common YAML parsers embed the
			// offending source line (and therefore potentially secret values).
			const hint = summarizeFrontmatterParseError(err);
			const warning =
				`Skipping agent file ${filePath}: malformed YAML frontmatter — ${hint}. ` +
				`Quote string values that contain colons or other YAML special characters.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}
		frontmatter = stripRemovedPlaneConfigKeys(frontmatter, "agent.");
		const removedArtifactField = ["output", "outputFrom"].find((field) =>
			Object.prototype.hasOwnProperty.call(frontmatter, field),
		);
		if (removedArtifactField) {
			const warning = `Skipping agent file ${filePath}: agent field ${removedArtifactField} is removed; declare artifact instead.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}
		warnAliases(frontmatter, filePath, warnings);
		const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
		const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
		if (!name || !description) {
			// Same surfacing as the malformed-YAML skip (issue #10): a file
			// missing its required fields should not silently vanish from
			// discovery.
			warnings?.push(
				`Skipping agent file ${filePath}: missing required frontmatter ` +
					`field${!name && !description ? "s 'name' and 'description'" : !name ? " 'name'" : " 'description'"}.`,
			);
			continue;
		}


		const artifact = parseFilename(frontmatter.artifact);
		const check = parseFilename(frontmatter.check);
		if (check !== undefined && artifact === undefined) {
			const warning = `Skipping agent file ${filePath}: agent check requires artifact; there is nothing to validate without an artifact.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}

		const { tools, mcpDirectTools } = splitToolList(frontmatter.tools);
		let thinkingFields: ReturnType<typeof normalizeThinkingFields>;
		try {
			thinkingFields = normalizeThinkingFields({
				thinking: frontmatter.thinking,
				thinkingMin: frontmatter.thinkingMin,
				thinkingMax: frontmatter.thinkingMax,
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const warning = `Skipping agent file ${filePath}: invalid thinking policy — ${detail}.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}
		let maxSubagentDepth: number | undefined;
		try {
			maxSubagentDepth = parseMaxSubagentDepth(
				frontmatter.maxSubagentDepth ?? frontmatter.max_subagent_depth,
			);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const warning = `Skipping agent file ${filePath}: invalid maxSubagentDepth — ${detail}.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}
		const escalation = parseAgentEscalation(frontmatter.escalation, filePath, warnings);
		let env: Record<string, string | null> | undefined;
		try {
			env = parseEnvOverrides(frontmatter.env, `${filePath}: env`);
		} catch (error) {
			const warning = `${filePath}: invalid env frontmatter — ${error instanceof Error ? error.message : String(error)}.`;
			warnDiscoveryWarning(warning);
			warnings?.push(warning);
			continue;
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (KNOWN_FIELDS.has(key)) continue;
			// Preserve as string so the shape is stable for downstream readers.
			extraFields[key] = typeof value === "string" ? value : String(value);
		}

		agents.push({
			name,
			description,
			tools,
			mcpDirectTools,
			model: parseModelRef(frontmatter.model),
			env,
			fallbackModels: splitCsv(frontmatter.fallbackModels),
			...thinkingFields,
			systemPromptMode: parseSystemPromptMode(frontmatter.systemPromptMode, filePath, warnings),
			inheritProjectContext: parseBoolLoose(frontmatter.inheritProjectContext, false, "inheritProjectContext", filePath, warnings),
			inheritSkills: parseBoolLoose(frontmatter.inheritSkills, false, "inheritSkills", filePath, warnings),
			skills: splitCsv(frontmatter.skills ?? frontmatter.skill),
			extensions: splitCsv(frontmatter.extensions),
			extensionInclude: splitCsv(frontmatter.extensionInclude ?? frontmatter.extension_include),
			extensionExclude: splitCsv(frontmatter.extensionExclude ?? frontmatter.extension_exclude),
			systemPrompt: body.trim(),
			source,
			filePath,
			defaultMaxRounds: parseIntMaybe(frontmatter.default_max_rounds ?? frontmatter.defaultMaxRounds),
			stopConditionHint: firstString(frontmatter.stop_condition_hint, frontmatter.stopConditionHint),
			collapseMode: parseCollapseMode(frontmatter.collapse_mode ?? frontmatter.collapseMode, filePath, warnings),
			summaryModel: parseModelRef(frontmatter.summary_model ?? frontmatter.summaryModel),
			defaultReads: splitCsv(frontmatter.defaultReads ?? frontmatter.default_reads),
			parentTranscriptSearch: parseBoolMaybe(frontmatter.parentTranscriptSearch ?? frontmatter.parent_transcript_search, "parentTranscriptSearch", filePath, warnings),
			defaultProgress: parseBoolMaybe(frontmatter.defaultProgress ?? frontmatter.default_progress, "defaultProgress", filePath, warnings),
			artifact,
			check,
			interactive: parseBoolMaybe(frontmatter.interactive, "interactive", filePath, warnings),
			maxSubagentDepth,
			allowNestedDelegate: parseBoolMaybe(frontmatter.allowNestedDelegate ?? frontmatter.allow_nested_delegate, "allowNestedDelegate", filePath, warnings),
			nestedDelegateAgents: splitCsv(frontmatter.nestedDelegateAgents ?? frontmatter.nested_delegate_agents),
			maxDurationMs: firstValidTimeoutMs(frontmatter.maxDurationMs, frontmatter.max_duration_ms),
			windDownGraceMs: firstValidTimeoutMs(frontmatter.windDownGraceMs, frontmatter.wind_down_grace_ms),
			escalation,
			packageName: source === "package" ? packageName : undefined,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
		}
	} finally {
		directory?.closeSync();
	}

	return agents;
}

/**
 * Parse one candidate through the same file parser used by directory
 * discovery. Management uses this before publishing a generated definition.
 */
export function discoverAgentFile(
	filePath: string,
	source: AgentSource,
	warnings: string[] = [],
): AgentConfig | undefined {
	return loadAgentsFromDir(path.dirname(filePath), source, undefined, warnings, filePath)[0];
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectRoot(cwd: string): string | null {
	// Walks up looking for either .pi/agents/ or .agents/ (including its nested
	// agents/ convention directory). Returns the first ancestor that has either
	// so project-scope loading can read all supported layouts. Stop at HOME
	// before testing it: ~/.agents is the canonical user-agent directory, not a
	// project marker for every repository beneath the user's home.
	const homeDir = path.resolve(os.homedir());
	let currentDir = path.resolve(cwd);
	while (true) {
		if (currentDir === homeDir) return null;
		const piDir = path.join(currentDir, ".pi", "agents");
		const legacyDir = path.join(currentDir, ".agents");
		if (isDirectory(piDir) || isDirectory(legacyDir)) return currentDir;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return null;
		currentDir = parent;
	}
}

type ProjectAgentDirectories = readonly [
	legacyDir: string | null,
	nestedDir: string | null,
	preferredDir: string | null,
];

function projectAgentDirectories(projectRoot: string | null): ProjectAgentDirectories {
	if (!projectRoot) return [null, null, null];
	// Project definitions load from lowest to highest precedence: flat .agents,
	// shared .agents/agents, then .pi/agents. Later definitions win. This keeps
	// the existing .pi/agents-over-.agents rule while giving the nested shared
	// directory a deterministic place between them.
	return [
		path.join(projectRoot, ".agents"),
		path.join(projectRoot, ".agents", "agents"),
		path.join(projectRoot, ".pi", "agents"),
	];
}

/**
 * Merge named definitions by name. Later entries override earlier ones.
 * Used for within-scope dedupe where load order encodes priority.
 */
function dedupeByName<T extends { name: string }>(lists: T[][]): T[] {
	const map = new Map<string, T>();
	for (const list of lists) {
		for (const definition of list) map.set(definition.name, definition);
	}
	return Array.from(map.values());
}

// ── Package-shipped agent discovery ─────────────────────────────────────────
//
// `loadPackageAgents()` discovers agents from pi-aware packages reachable
// from `cwd`. Five location families are walked, in priority order
// (later wins on duplicate names):
//
//   1. cwd's own root — when `cwd/package.json` is itself a pi package.
//   2. cwd-up `node_modules/*` (standard Node module resolution).
//   3. `<cwd>/.pi/npm/node_modules/*` (pi project-scope npm installs).
//   4. `<cwd>/.pi/git/<host>/<path…>/` and
//      `<getAgentDir()>/git/<host>/<path…>/` (pi git installs, both
//      project- and user-scope; recursive scan since git path depth
//      varies).
//   5. `<getAgentDir()>/extensions/*` (pi user-scope extensions —
//      typically dev symlinks back to a working repo). Walked
//      recursively to handle both flat layouts (one extension per
//      child) and nested ones.
//
// A package is loaded iff its `package.json` matches ONE of two opt-in
// signals:
//   1. Explicit:   `pi-delegate: { agents: ["./agents", "./more"] }`
//   2. Convention: an `agents/` directory at the package root, IFF the
//      package also has a `pi: {...}` manifest field (i.e. it self-
//      identifies as a pi package). The `pi.*` signal is required so
//      arbitrary npm packages with an unrelated `agents/` directory
//      don't bleed into discovery.
//
// Loaded agents are tagged with `source: "package"` and the originating
// `packageName` (from the source package's `package.json:name`).
// Symlinked packages are deduped via `fs.realpathSync()` so a dev
// repo reachable through both cwd-own + `~/.pi/agent/extensions/<name>`
// only loads once.
//
// We deliberately do NOT walk the global npm root (`npm root -g`).
// pi-coding-agent installs user-scope packages there, but doing so
// would require a sync `npm` invocation per discovery. Users who want
// global pi-installed packages discoverable should use `pi install
// git:...` (which lands under `<getAgentDir()>/git`, covered above)
// or symlink them into `<getAgentDir()>/extensions`.

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readBoundedText(filePath: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const stat = fs.fstatSync(fd);
		if (stat.size > maxBytes) return undefined;
		const buffer = Buffer.alloc(maxBytes + 1);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) return undefined;
		return buffer.subarray(0, bytesRead).toString("utf-8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* raced close */ }
		}
	}
}

function boundedDirectoryEntries(
	dir: string,
	budget: AgentDiscoveryBudget,
): fs.Dirent[] | undefined {
	const maxEntries = budget.limits.maxPackageDirectoryEntries;
	if (maxEntries === undefined) return fs.readdirSync(dir, { withFileTypes: true });
	if (budget.packageDirectoryEntriesRead >= maxEntries) {
		budget.degraded = true;
		budget.truncated = true;
		return [];
	}
	const entries: fs.Dirent[] = [];
	let directory: fs.Dir | undefined;
	try {
		directory = fs.opendirSync(dir);
		while (entries.length < maxEntries && budget.packageDirectoryEntriesRead < maxEntries) {
			const entry = directory.readSync();
			if (!entry) break;
			entries.push(entry);
			budget.packageDirectoryEntriesRead++;
		}
		if (entries.length >= maxEntries || budget.packageDirectoryEntriesRead >= maxEntries) {
			budget.degraded = true;
			budget.truncated = true;
		}
		return entries;
	} catch {
		return undefined;
	} finally {
		try { directory?.closeSync(); } catch { /* raced close */ }
	}
}

interface PackageManifest {
	name?: string;
	piDelegateAgents?: string[];
	hasPiManifest: boolean;
}

function readPackageManifest(packageJsonPath: string, budget?: AgentDiscoveryBudget): PackageManifest | null {
	let raw: string;
	try {
		raw = budget
			? readBoundedText(packageJsonPath, budget.limits.maxFileBytes)
			: fs.readFileSync(packageJsonPath, "utf-8");
		if (raw === undefined) {
			if (budget) {
				budget.degraded = true;
				budget.truncated = true;
			}
			return null;
		}
	} catch {
		return null;
	}
	let pkg: unknown;
	try {
		pkg = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(pkg)) return null;
	const name = typeof pkg.name === "string" && pkg.name.trim().length > 0 ? pkg.name : undefined;
	const piDelegate = isPlainObject(pkg["pi-delegate"]) ? pkg["pi-delegate"] : null;
	let piDelegateAgents: string[] | undefined;
	if (piDelegate && Array.isArray(piDelegate.agents)) {
		const paths = piDelegate.agents
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (paths.length > 0) piDelegateAgents = paths;
	}
	const hasPiManifest = isPlainObject(pkg.pi);
	return { name, piDelegateAgents, hasPiManifest };
}

function loadAgentsForPackage(
	packageRoot: string,
	manifest: PackageManifest,
	warnings?: string[],
	budget?: AgentDiscoveryBudget,
): AgentConfig[] {
	const packageName = manifest.name ?? path.basename(packageRoot);
	if (manifest.piDelegateAgents && manifest.piDelegateAgents.length > 0) {
		// Explicit paths — load each in declared order; later wins on
		// duplicate names within the same package.
		const lists: AgentConfig[][] = [];
		for (const rel of manifest.piDelegateAgents) {
			const resolved = path.resolve(packageRoot, rel);
			if (!isDirectory(resolved)) continue;
			lists.push(loadAgentsFromDir(resolved, "package", packageName, warnings, undefined, budget));
		}
		return dedupeByName(lists);
	}
	if (manifest.hasPiManifest) {
		// Convention-dir auto-discovery (only when `pi.*` is present).
		const conventionDir = path.join(packageRoot, "agents");
		if (isDirectory(conventionDir)) {
			return loadAgentsFromDir(conventionDir, "package", packageName, warnings, undefined, budget);
		}
	}
	return [];
}

function loadChainsForPackage(
	packageRoot: string,
	manifest: PackageManifest,
	warnings?: string[],
	budget?: AgentDiscoveryBudget,
): ChainFileConfig[] {
	const lists: ChainFileConfig[][] = [];
	if (manifest.piDelegateAgents && manifest.piDelegateAgents.length > 0) {
		// Chain files share the package agent directories, matching the
		// existing user/project scope layout and opt-in rules.
		for (const rel of manifest.piDelegateAgents) {
			const resolved = path.resolve(packageRoot, rel);
			if (!isDirectory(resolved)) continue;
			lists.push(loadChainsFromDir(resolved, "package", warnings, budget));
		}
	} else if (manifest.hasPiManifest) {
		const conventionDir = path.join(packageRoot, "agents");
		if (isDirectory(conventionDir)) lists.push(loadChainsFromDir(conventionDir, "package", warnings, budget));
	}
	return dedupeByName(lists);
}

interface PackageEntry {
	root: string;
	packageJsonPath: string;
}

function pushBoundedPackageEntry(
	out: PackageEntry[],
	entry: PackageEntry,
	budget?: AgentDiscoveryBudget,
): boolean {
	if (budget) {
		const maxEntries = budget.limits.maxPackageEntries;
		if (maxEntries !== undefined && budget.packageEntriesRead >= maxEntries) {
			budget.degraded = true;
			budget.truncated = true;
			return false;
		}
		budget.packageEntriesRead++;
	}
	out.push(entry);
	return true;
}

function enumeratePackagesInNodeModules(nodeModulesDir: string, budget?: AgentDiscoveryBudget): PackageEntry[] {
	const out: PackageEntry[] = [];
	if (!isDirectory(nodeModulesDir)) return out;
	let entries: fs.Dirent[];
	try {
		entries = budget ? boundedDirectoryEntries(nodeModulesDir, budget) ?? [] : fs.readdirSync(nodeModulesDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const name = entry.name;
		if (name.startsWith(".")) continue; // skip .bin, .cache, .package-lock.json, etc.
		const fullPath = path.join(nodeModulesDir, name);
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = fs.statSync(fullPath).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDir) continue;
		if (name.startsWith("@")) {
			// Scoped packages live one level deeper: <node_modules>/@scope/<pkg>.
			let inner: fs.Dirent[];
			try {
				inner = budget ? boundedDirectoryEntries(fullPath, budget) ?? [] : fs.readdirSync(fullPath, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const sub of inner) {
				if (sub.name.startsWith(".")) continue;
				const subPath = path.join(fullPath, sub.name);
				let isSubDir = sub.isDirectory();
				if (sub.isSymbolicLink()) {
					try {
						isSubDir = fs.statSync(subPath).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isSubDir) continue;
				const pjson = path.join(subPath, "package.json");
				if (fs.existsSync(pjson)) pushBoundedPackageEntry(out, { root: subPath, packageJsonPath: pjson }, budget);
			}
			continue;
		}
		const pjson = path.join(fullPath, "package.json");
		if (fs.existsSync(pjson)) pushBoundedPackageEntry(out, { root: fullPath, packageJsonPath: pjson }, budget);
	}
	return out;
}

/**
 * Collect `node_modules`-shaped directories. Each is a parent directory
 * containing one level of installed packages (with optional `@scope/<pkg>`
 * nesting). Used together with `enumeratePackagesInNodeModules`.
 */
function collectPackageRootDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	const add = (p: string): void => {
		if (seen.has(p)) return;
		seen.add(p);
		if (isDirectory(p)) dirs.push(p);
	};

	// Walk cwd upward, collecting every `node_modules/` dir along the way.
	let dir = path.resolve(cwd);
	while (true) {
		add(path.join(dir, "node_modules"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// pi's project-scope npm install root sits under `<cwd>/.pi/npm`.
	add(path.join(path.resolve(cwd), ".pi", "npm", "node_modules"));

	return dirs;
}

/**
 * Recursively scan `rootDir` looking for `package.json` files. Used for
 * containers whose layout isn't a flat node_modules — git installs nest
 * under `<host>/<path…>/` (variable depth) and `~/.pi/agent/extensions/`
 * may hold either flat dirs or symlinked subprojects.
 *
 * Stops descending into a directory as soon as a `package.json` is
 * found there (a package is a leaf for our purposes). Skips
 * `node_modules/` and dot-prefixed entries to keep the walk bounded.
 *
 * `maxDepth` is the maximum number of directory levels below `rootDir`
 * to descend before giving up. A typical git install is 3 levels
 * (`host/owner/repo`) and a typical extensions dir is 1, so the
 * default of 5 is generous. Increasing it doesn't add agents — it
 * just slows down discovery on pathological layouts.
 */
function enumeratePackagesByScan(rootDir: string, maxDepth = 5, budget?: AgentDiscoveryBudget): PackageEntry[] {
	const out: PackageEntry[] = [];
	if (!isDirectory(rootDir)) return out;

	const visit = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		let entries: fs.Dirent[];
		try {
			entries = budget ? boundedDirectoryEntries(dir, budget) ?? [] : fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		// First check whether this dir is itself a package.
		const hasPjson = entries.some((e) => e.isFile() && e.name === "package.json");
		if (hasPjson && depth > 0) {
			// `depth > 0` means we don't treat the container root itself
			// (e.g. `~/.pi/agent/git`) as a package — only its descendants.
			pushBoundedPackageEntry(out, { root: dir, packageJsonPath: path.join(dir, "package.json") }, budget);
			return; // don't descend further into a package
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue; // skip .git, .cache, etc.
			if (entry.name === "node_modules") continue; // never descend into nested deps
			const child = path.join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = fs.statSync(child).isDirectory();
				} catch {
					continue;
				}
			}
			if (!isDir) continue;
			visit(child, depth + 1);
		}
	};

	visit(rootDir, 0);
	return out;
}

/**
 * Container directories whose layout requires a recursive `package.json`
 * scan rather than a flat node_modules-style enumeration. Each entry
 * here is paired with `enumeratePackagesByScan` in `loadPackageAgents`.
 */
function collectScanRoots(cwd: string): string[] {
	const dirs: string[] = [];
	const seen = new Set<string>();
	const add = (p: string): void => {
		if (seen.has(p)) return;
		seen.add(p);
		if (isDirectory(p)) dirs.push(p);
	};

	const agentDir = getAgentDir();
	add(path.join(path.resolve(cwd), ".pi", "git")); // project-scope git installs
	add(path.join(agentDir, "git")); // user-scope git installs
	add(path.join(agentDir, "extensions")); // user-scope extensions (often dev symlinks)

	return dirs;
}

function enumeratePackageEntries(
	cwd: string,
	options: PackageAgentDiscoveryOptions,
): PackageEntry[] {
	const seenInstalls = new Set<string>();
	const entries: PackageEntry[] = [];
	const add = (pkg: PackageEntry): void => {
		let realRoot = pkg.root;
		try {
			realRoot = fs.realpathSync(pkg.root);
		} catch {
			/* keep literal path */
		}
		if (seenInstalls.has(realRoot)) return;
		seenInstalls.add(realRoot);
		entries.push(pkg);
	};

	// Check cwd itself first for the dogfood case: its package.json is not
	// reachable through node_modules or the Pi install paths.
	const cwdRoot = path.resolve(cwd);
	const cwdPkgJson = path.join(cwdRoot, "package.json");
	if (fs.existsSync(cwdPkgJson)) add({ root: cwdRoot, packageJsonPath: cwdPkgJson });

	// node_modules-style containers (cwd-up + pi project-scope npm).
	for (const nodeModulesDir of collectPackageRootDirs(cwd)) {
		for (const pkg of enumeratePackagesInNodeModules(nodeModulesDir, options.agentDiscoveryBudget)) add(pkg);
	}

	// Recursive-scan containers (.pi/git, ~/.pi/agent/git,
	// ~/.pi/agent/extensions). Layouts are `<host>/<path…>/<repo>` for
	// git installs and either flat or one-level-nested for extensions.
	for (const scanRoot of collectScanRoots(cwd)) {
		for (const pkg of enumeratePackagesByScan(scanRoot, 5, options.agentDiscoveryBudget)) add(pkg);
	}

	// Pi settings may point at an installed absolute package root that is not
	// reachable from cwd/node_modules or the historical Pi install locations.
	for (const root of options.additionalResolvedPackageRoots ?? []) {
		const resolvedRoot = path.resolve(root);
		if (options.agentDiscoveryBudget) {
			const bounded: PackageEntry[] = [];
			if (pushBoundedPackageEntry(bounded, { root: resolvedRoot, packageJsonPath: path.join(resolvedRoot, "package.json") }, options.agentDiscoveryBudget)) add(bounded[0]!);
		} else {
			add({ root: resolvedRoot, packageJsonPath: path.join(resolvedRoot, "package.json") });
		}
	}
	return entries;
}

export function loadPackageAgents(
	cwd: string,
	warnings?: string[],
	options: PackageAgentDiscoveryOptions = {},
): AgentConfig[] {
	const lists: AgentConfig[][] = [];
	for (const pkg of enumeratePackageEntries(cwd, options)) {
		const manifest = readPackageManifest(pkg.packageJsonPath, options.agentDiscoveryBudget);
		if (!manifest || (!manifest.piDelegateAgents?.length && !manifest.hasPiManifest)) continue;
		const loaded = loadAgentsForPackage(pkg.root, manifest, warnings, options.agentDiscoveryBudget);
		if (loaded.length > 0) lists.push(loaded);
	}
	return dedupeByName(lists);
}

/** Discover chain files shipped by Pi-aware packages. */
export function loadPackageChains(
	cwd: string,
	warnings?: string[],
	options: PackageAgentDiscoveryOptions = {},
): ChainFileConfig[] {
	const lists: ChainFileConfig[][] = [];
	for (const pkg of enumeratePackageEntries(cwd, options)) {
		const manifest = readPackageManifest(pkg.packageJsonPath, options.agentDiscoveryBudget);
		if (!manifest || (!manifest.piDelegateAgents?.length && !manifest.hasPiManifest)) continue;
		const loaded = loadChainsForPackage(pkg.root, manifest, warnings, options.agentDiscoveryBudget);
		if (loaded.length > 0) lists.push(loaded);
	}
	return dedupeByName(lists);
}

const BUILTIN_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"builtin-agents",
);

function createAgentDiscoveryBudget(options: PackageAgentDiscoveryOptions): AgentDiscoveryBudget | undefined {
	if (options.agentDiscoveryBudget) return options.agentDiscoveryBudget;
	const limits = options.agentDiscoveryLimits;
	if (!limits) return undefined;
	return {
		limits,
		filesRead: 0,
		packageEntriesRead: 0,
		packageDirectoryEntriesRead: 0,
		chainFilesRead: 0,
		degraded: false,
		truncated: false,
	};
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	options: PackageAgentDiscoveryOptions = {},
): AgentDiscoveryResult {
	const warnings: string[] = [];
	const budget = createAgentDiscoveryBudget(options);
	const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", undefined, warnings, undefined, budget);

	// User scope: load legacy .pi/agent/agents first, then ~/.agents. Later wins.
	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");

	const projectRoot = findNearestProjectRoot(cwd);
	const [projectLegacyDir, projectNestedDir, projectPreferredDir] = projectAgentDirectories(projectRoot);
	const canonicalPath = (candidate: string): string => {
		const resolved = path.resolve(candidate);
		try {
			return fs.realpathSync(resolved);
		} catch {
			return resolved;
		}
	};
	const projectOwnedAgentDirs = new Set(
		[projectLegacyDir, projectNestedDir, projectPreferredDir]
			.filter((dir): dir is string => dir !== null)
			.map(canonicalPath),
	);
	const safeUserDirOld = projectOwnedAgentDirs.has(canonicalPath(userDirOld))
		? null
		: userDirOld;

	// Package agents are installed globally (relative to cwd's node_modules
	// chain or pi's project-scope npm root). They sit between builtin and
	// user in the override stack and are skipped only when the caller asks
	// for *strictly* project-scope agents — symmetric with how user agents
	// are skipped under `scope: "project"`.
	const packageAgents = sourceVisibleInAgentScope("package", scope)
		? loadPackageAgents(cwd, warnings, { ...options, agentDiscoveryBudget: budget })
		: [];

	const userLists: AgentConfig[][] =
		sourceVisibleInAgentScope("user", scope)
			? [
					safeUserDirOld
						? loadAgentsFromDir(safeUserDirOld, "user", undefined, warnings, undefined, budget)
						: [],
					loadAgentsFromDir(userDirNew, "user", undefined, warnings, undefined, budget),
				]
			: [];
	const userAgents = dedupeByName(userLists);

	const projectLists: AgentConfig[][] =
		sourceVisibleInAgentScope("project", scope) && projectRoot
			? [
					projectLegacyDir ? loadAgentsFromDir(projectLegacyDir, "project", undefined, warnings, undefined, budget) : [],
					projectNestedDir ? loadAgentsFromDir(projectNestedDir, "project", undefined, warnings, undefined, budget) : [],
					projectPreferredDir
						? loadAgentsFromDir(projectPreferredDir, "project", undefined, warnings, undefined, budget)
						: [],
				]
			: [];
	const projectAgents = dedupeByName(projectLists);

	// Each excluded source is already an empty list, so precedence resolution is
	// identical for every scope and cannot drift from the visibility policy.
	const merged = resolveByScopePrecedence([
		...builtinAgents,
		...packageAgents,
		...userAgents,
		...projectAgents,
	]);

	return {
		agents: merged,
		projectAgentsDir: projectPreferredDir ?? projectLegacyDir,
		projectRoot: scope === "user" ? null : projectRoot,
		warnings,
	};
}

/** Parse `provider/id` or bare `id` into a registry lookup key. */
export function parseModelId(ref: string): { provider?: string; id: string } {
	const idx = ref.indexOf("/");
	if (idx > 0) {
		return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
	}
	return { id: ref };
}

// ── Chain-file discovery ────────────────────────────────────────────────────
//
// Chain templates (`*.chain.md`) live in the same opted-in package agent
// directories and user/project scope dirs as agents:
//   package: package `pi-delegate.agents` paths or package `agents/`
//   user:    ~/.pi/agent/agents/, ~/.agents/
//   project: <repo>/.agents/, <repo>/.agents/agents/, <repo>/.pi/agents/
//
// We don't bundle "builtin chains" — package, user, and project chains all
// participate in the shared precedence resolver. pi-subagents uses identical
// user/project paths so those chain files migrate without edits.

function loadChainFile(
	filePath: string,
	source: ChainFileSource,
	warnings?: string[],
	budget?: AgentDiscoveryBudget,
): ChainFileConfig | undefined {
	if (budget) {
		const maxChainFiles = budget.limits.maxChainFiles;
		if (maxChainFiles !== undefined && budget.chainFilesRead >= maxChainFiles) {
			budget.degraded = true;
			budget.truncated = true;
			return undefined;
		}
		budget.chainFilesRead++;
	}
	let content: string | undefined;
	try {
		content = budget
			? readBoundedText(filePath, budget.limits.maxFileBytes)
			: fs.readFileSync(filePath, "utf-8");
		if (content === undefined) {
			if (budget) {
				budget.degraded = true;
				budget.truncated = true;
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
	try {
		// chain-serializer.ts imports only types from agents.ts (`import
		// type`), so this module-top import does NOT create a runtime cycle.
		return parseChain(content, source, filePath);
	} catch (error) {
		const detail = isFrontmatterParseError(error)
			? summarizeFrontmatterParseError(error)
			: error instanceof Error
				? error.message
				: "unknown validation error";
		const warning = `Skipping chain file ${filePath}: invalid definition — ${detail}.`;
		warnDiscoveryWarning(warning);
		warnings?.push(warning);
		return undefined;
	}
}

function loadChainsFromDir(
	dir: string,
	source: ChainFileSource,
	warnings?: string[],
	budget?: AgentDiscoveryBudget,
): ChainFileConfig[] {
	const out: ChainFileConfig[] = [];
	if (!fs.existsSync(dir)) return out;
	let entries: fs.Dirent[];
	try {
		entries = budget ? boundedDirectoryEntries(dir, budget) ?? [] : fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const chain = loadChainFile(path.join(dir, entry.name), source, warnings, budget);
		if (chain) out.push(chain);
	}
	return out;
}

/**
 * Discover agents AND chain files across all scopes. Returns the data shape
 * agent-management.ts needs: builtins/user/project split, all chains
 * regardless of source, and the canonical write directories per scope.
 *
 * Builtin agents are always included even when only user or project scope
 * is requested at runtime — list/get views show them, but management
 * actions reject create/update/delete on builtin sources (immutable).
 */
export function discoverAgentsAll(
	cwd: string,
	options: PackageAgentDiscoveryOptions = {},
): AgentsAllDiscoveryResult {
	const warnings: string[] = [];
	const budget = createAgentDiscoveryBudget(options);
	const builtin = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", undefined, warnings, undefined, budget);

	const userDirOld = path.join(getAgentDir(), "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const userAgents = dedupeByName([
		loadAgentsFromDir(userDirOld, "user", undefined, warnings, undefined, budget),
		loadAgentsFromDir(userDirNew, "user", undefined, warnings, undefined, budget),
	]);

	const projectRoot = findNearestProjectRoot(cwd);
	const [projectLegacyDir, projectNestedDir, projectPreferredDir] = projectAgentDirectories(projectRoot);

	const projectAgents = dedupeByName([
		projectLegacyDir ? loadAgentsFromDir(projectLegacyDir, "project", undefined, warnings, undefined, budget) : [],
		projectNestedDir ? loadAgentsFromDir(projectNestedDir, "project", undefined, warnings, undefined, budget) : [],
		projectPreferredDir
			? loadAgentsFromDir(projectPreferredDir, "project", undefined, warnings, undefined, budget)
			: [],
	]);

	const packageAgents = loadPackageAgents(cwd, warnings, { ...options, agentDiscoveryBudget: budget });
	const packageChains = loadPackageChains(cwd, warnings, { ...options, agentDiscoveryBudget: budget });

	const userChains = [
		...loadChainsFromDir(userDirOld, "user", warnings, budget),
		...loadChainsFromDir(userDirNew, "user", warnings, budget),
	];
	const projectChains = [
		...(projectLegacyDir ? loadChainsFromDir(projectLegacyDir, "project", warnings, budget) : []),
		...(projectNestedDir ? loadChainsFromDir(projectNestedDir, "project", warnings, budget) : []),
		...(projectPreferredDir ? loadChainsFromDir(projectPreferredDir, "project", warnings, budget) : []),
	];

	// Dedupe chains within each scope by name (preferred dir wins, matching
	// agents). Keep every cross-scope candidate for management and reference
	// scans; the shared resolver below determines the winner and warnings.
	const dedupeChainsByName = (candidates: ChainFileConfig[]): ChainFileConfig[] => {
		const map = new Map<string, ChainFileConfig>();
		for (const candidate of candidates) map.set(candidate.name, candidate);
		return Array.from(map.values());
	};
	const chains = [
		...packageChains,
		...dedupeChainsByName(userChains),
		...dedupeChainsByName(projectChains),
	].sort((a, b) => scopePrecedence(a.source) - scopePrecedence(b.source));
	resolveByScopePrecedence(chains, (winner, loser) => {
		const warning = formatChainShadowWarning(winner, loser);
		warnDiscoveryWarning(warning);
		warnings.push(warning);
	});

	return {
		cwd,
		builtin,
		package: packageAgents,
		user: userAgents,
		project: projectAgents,
		chains,
		userDir: userDirNew, // canonical write dir for `create scope: "user"`
		projectDir: projectPreferredDir ?? projectLegacyDir,
		projectRoot,
		warnings,
		...(budget
			? { agentDiscoveryScan: { filesRead: budget.filesRead, degraded: budget.degraded, truncated: budget.truncated } }
			: {}),
	};
}

/**
 * Discover chain templates only. Convenience for slash commands that need
 * the chain set without the agent overhead.
 */
export function discoverChains(
	cwd: string,
	options: PackageAgentDiscoveryOptions = {},
): ChainFileConfig[] {
	return discoverAgentsAll(cwd, options).chains;
}

/** Resolve one saved chain from the complete candidate set. */
export function resolveChainByName(
	name: string,
	candidates: readonly ChainFileConfig[],
): ChainFileConfig | undefined {
	return resolveByScopePrecedence(candidates).find((chain) => chain.name === name);
}
