/**
 * Management actions for the `delegate` tool: list / get / create / update /
 * delete agents and chain files.
 *
 * All five handlers return an `AgentManagementResult` shape that the
 * delegate tool's `execute()` translates into the standard pi-coding-agent
 * tool result envelope. Pure-ish: handlers read/write the filesystem but
 * don't touch the runtime registry, the UI, or any LLM.
 *
 * Adapted from pi-subagents' `agent-management.ts` so the surface is
 * source-compatible — calls that worked there work here. Differences:
 *
 *   - `disabled` is not yet a builtin overlay (Phase D), so the disabled-
 *     builtin sections of pi-subagents' list output are omitted.
 *   - Model / skill availability warnings are skipped — the management
 *     handler doesn't have a ModelRegistry on hand from the tool execute
 *     path; the parity plan calls these out as Phase D.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	type ChainFileConfig,
	type ChainRunStepFileConfig,
	type ChainStepFileConfig,
	type ChainWorkerStepFileConfig,
	isChainReferenceStepFileConfig,
	isChainRunStepFileConfig,
	isChainWorkerStepFileConfig,
	discoverAgentsAll,
	resolveByScopePrecedence,
	sourceVisibleInAgentScope,
	type PackageAgentDiscoveryOptions,
	discoverAgentFile,
} from "./agents.js";
import { HARD_MAX_DEPTH, validateMaxSubagentDepth } from "./depth-guard.js";
import {
	canonicalizeAgentToolEntries,
	serializeAgent,
	serializeAgentWithBody,
} from "./agent-serializer.js";
import { parseChain, serializeChain } from "./chain-serializer.js";
import { stripRemovedPlaneConfigKeys } from "./config.js";
import { MAX_TIMEOUT_MS, normalizeTimeoutMs } from "./fork-timeout.js";
import { normalizeThinkingFields, type ThinkingLevel } from "./thinking-policy.js";
import { parseEnvOverrides } from "./env-overrides.js";
import {
	validateSavedChainRunCommand,
	validateSavedChainRunCwd,
	validateSavedChainRunLabel,
	validateSavedChainRunTimeoutMs,
} from "./saved-chain-run.js";
import { parseEscalationInvocationValue } from "./escalation-policy.js";

// `defaultInheritProjectContext` doesn't exist as an export today — the
// inherit-default shape pi-subagents uses isn't pi-delegate's. Keep imports
// shallow and define the inherit defaults locally.
//
// Locally enforced defaults for new agent files:
//   systemPromptMode: "replace"
//   inheritProjectContext: false
//   inheritSkills: false
// Mirrors what `loadAgentsFromDir` falls back to when frontmatter omits the
// fields. Centralised here so create / update use the same baseline.
function defaultSystemPromptMode(): "replace" {
	return "replace";
}
function defaultInheritProjectContext(): boolean {
	return false;
}
function defaultInheritSkills(): boolean {
	return false;
}

export type ManagementAction = "list" | "get" | "create" | "update" | "delete" | "canonicalize";
export type ManagementScope = "user" | "project";

const ManagementStringListSchema = Type.Union([Type.Array(Type.String()), Type.Literal(false)]);
const ManagementEnvSchema = Type.Union([
	Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
	Type.Literal(false),
]);
const ManagementThinkingSchema = Type.Union([Type.String(), Type.Literal(false)]);
const EscalationTimeoutBehaviorSchema = Type.Union([
	Type.Literal("useDefault"),
	Type.Literal("noDefaultError"),
	Type.Literal("cancel"),
]);
const EscalationAuthoritySchema = Type.Object({
	decision: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("implementation"), Type.Literal("all")])),
	blocker: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("all")])),
	amendment: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("all")])),
	tags: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
const EscalationPerKindTimeoutMsSchema = Type.Object({
	decision: Type.Optional(Type.Integer({ minimum: 1 })),
	blocker: Type.Optional(Type.Integer({ minimum: 1 })),
	amendment: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const EscalationPerKindTimeoutBehaviorSchema = Type.Object({
	decision: Type.Optional(EscalationTimeoutBehaviorSchema),
	blocker: Type.Optional(EscalationTimeoutBehaviorSchema),
	amendment: Type.Optional(EscalationTimeoutBehaviorSchema),
}, { additionalProperties: false });
const ManagementEscalationSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("local"),
	Type.Literal(false),
	Type.Object({
		mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("local")])),
		authority: Type.Optional(EscalationAuthoritySchema),
		intermediate: Type.Optional(Type.Boolean()),
		hopTimeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
		timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), EscalationPerKindTimeoutMsSchema])),
		timeoutBehavior: Type.Optional(Type.Union([EscalationTimeoutBehaviorSchema, EscalationPerKindTimeoutBehaviorSchema])),
		holdStrategy: Type.Optional(Type.Literal("hold-open")),
	}, { additionalProperties: false }),
]);
export const ManagementChainWorkerStepSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String()),
	env: Type.Optional(ManagementEnvSchema),
	artifact: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	reads: Type.Optional(ManagementStringListSchema),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(ManagementThinkingSchema),
	thinkingMin: Type.Optional(ManagementThinkingSchema),
	thinkingMax: Type.Optional(ManagementThinkingSchema),
	skills: Type.Optional(ManagementStringListSchema),
	progress: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const ManagementChainReferenceStepSchema = Type.Object({
	chain: Type.String(),
	task: Type.Optional(Type.String()),
}, { additionalProperties: false });
export const ManagementChainRunStepSchema = Type.Object({
	run: Type.String(),
	command: Type.String(),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(ManagementEnvSchema),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
}, { additionalProperties: false });
export const ManagementChainStepSchema = Type.Union([
	ManagementChainWorkerStepSchema,
	ManagementChainReferenceStepSchema,
	ManagementChainRunStepSchema,
]);

/** Closed root schema for saved-chain management payloads. */
export const ManagementChainConfigSchema = Type.Object({
	name: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
	steps: Type.Optional(Type.Array(ManagementChainStepSchema)),
}, { additionalProperties: false });

/**
 * Closed management payload schema. Every field accepted here has a durable
 * representation in AgentConfig or ChainFileConfig; unknown keys are errors.
 * Lists use JSON/YAML arrays as their only management representation.
 */
export const ManagementConfigSchema = Type.Object({
	name: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	model: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	env: Type.Optional(ManagementEnvSchema),
	fallbackModels: Type.Optional(ManagementStringListSchema),
	thinking: Type.Optional(ManagementThinkingSchema),
	thinkingMin: Type.Optional(ManagementThinkingSchema),
	thinkingMax: Type.Optional(ManagementThinkingSchema),
	systemPromptMode: Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")])),
	inheritProjectContext: Type.Optional(Type.Boolean()),
	inheritSkills: Type.Optional(Type.Boolean()),
	skills: Type.Optional(ManagementStringListSchema),
	tools: Type.Optional(ManagementStringListSchema),
	extensions: Type.Optional(ManagementStringListSchema),
	extensionInclude: Type.Optional(ManagementStringListSchema),
	extensionExclude: Type.Optional(ManagementStringListSchema),
	defaultMaxRounds: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal(false)])),
	stopConditionHint: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	collapseMode: Type.Optional(Type.Union([Type.Literal("final_output"), Type.Literal("summary"), Type.Literal(false)])),
	summaryModel: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	escalation: Type.Optional(ManagementEscalationSchema),
	reads: Type.Optional(ManagementStringListSchema),
	progress: Type.Optional(Type.Boolean()),
	artifact: Type.Optional(Type.Union([Type.String(), Type.Literal(false)])),
	interactive: Type.Optional(Type.Boolean()),
	maxSubagentDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: HARD_MAX_DEPTH }), Type.Literal(false)])),
	allowNestedDelegate: Type.Optional(Type.Union([Type.Boolean(), Type.Literal(false)])),
	nestedDelegateAgents: Type.Optional(ManagementStringListSchema),
	maxDurationMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS }), Type.Literal(false)])),
	windDownGraceMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_MS }), Type.Literal(false)])),
	scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
	steps: Type.Optional(Type.Array(ManagementChainStepSchema)),
}, { additionalProperties: false });

export type ManagementConfig = Static<typeof ManagementConfigSchema>;

export interface ManagementParams {
	action?: string;
	agent?: string;
	chainName?: string;
	agentScope?: string;
	config?: unknown;
}

export interface AgentManagementResult {
	text: string;
	isError?: boolean;
	/**
	 * Optional structured payload: which file the action read/wrote/deleted,
	 * which agents/chains exist after the action, etc. Currently consumed
	 * only by tests; the tool result delivers `text` to the LLM.
	 */
	details?: {
		action: ManagementAction;
		agent?: string;
		chainName?: string;
		filePath?: string;
		scope?: ManagementScope;
		warnings?: string[];
	};
}

interface ManagementContext {
	cwd: string;
	discoveryOptions?: PackageAgentDiscoveryOptions;
}

function ok(text: string, details?: AgentManagementResult["details"]): AgentManagementResult {
	return { text, details };
}

function err(text: string, details?: AgentManagementResult["details"]): AgentManagementResult {
	return { text, isError: true, details };
}

function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { error: `config must be valid JSON: ${msg}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

function managementConfigError(config: Record<string, unknown>): string | undefined {
	// TypeBox reports only `Expected union value` at the array item when a
	// discriminated saved-chain step is malformed. Run the discriminator-aware
	// parser first so callers keep the field-specific management diagnostics.
	if (hasKey(config, "steps")) {
		const parsedSteps = parseStepList(config.steps);
		if (parsedSteps.error) return parsedSteps.error;
	}
	if (Value.Check(ManagementConfigSchema, config)) return undefined;
	for (const error of Value.Errors(ManagementConfigSchema, config)) {
		const fieldPath = error.path
			.split("/")
			.filter(Boolean)
			.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
			.join(".");
		const displayFieldPath = fieldPath.replace(/^steps\.(\d+)(?:\.|$)/, "steps[$1].");
		const listField = fieldPath.match(
			/^(?:steps\.\d+\.)?(fallbackModels|tools|skills|extensions|extensionInclude|extensionExclude|reads|nestedDelegateAgents)$/,
		);
		if (listField) {
			return `config.${displayFieldPath} must be an array of strings or false.`;
		}
		if (fieldPath === "scope") return "config.scope must be 'user' or 'project'.";
		if (fieldPath === "maxSubagentDepth") {
			return `config.maxSubagentDepth must be a safe integer from 0 to ${HARD_MAX_DEPTH}, or false.`;
		}
		if (fieldPath === "maxDurationMs" || fieldPath === "windDownGraceMs") {
			return `config.${fieldPath} must be a safe integer from 0 to ${MAX_TIMEOUT_MS}, or false.`;
		}
		const stepThinking = fieldPath.match(/^steps\.(\d+)\.(thinking|thinkingMin|thinkingMax)$/);
		if (stepThinking) {
			return `config.steps[${stepThinking[1]}].${stepThinking[2]} must be a thinking level string or false.`;
		}
		return `config${displayFieldPath ? `.${displayFieldPath}` : ""} ${error.message}.`;
	}
	return "config does not match the supported management schema.";
}

const CHAIN_CONFIG_FIELDS = new Set(Object.keys(ManagementChainConfigSchema.properties));

function managementShapeError(config: Record<string, unknown>, isChain: boolean): string | undefined {
	for (const key of Object.keys(config)) {
		if (isChain && !CHAIN_CONFIG_FIELDS.has(key)) {
			return `config.${key} is not supported for saved chains.`;
		}
		if (!isChain && key === "steps") {
			return "config.steps is only supported when creating or updating a saved chain.";
		}
	}
	return undefined;
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function asScopeHint(s: unknown): ManagementScope | undefined {
	return s === "user" || s === "project" ? s : undefined;
}

function managementScope(source: AgentSource): ManagementScope {
	if (source === "user" || source === "project") return source;
	throw new Error(`Immutable ${source} definition cannot be modified.`);
}

function normalizeListScope(s: unknown): AgentScope | undefined {
	if (s === undefined) return "both";
	if (s === "user" || s === "project" || s === "both") return s;
	return undefined;
}

/**
 * Sanitise a user-supplied agent name into a kebab-case filename-safe
 * token. Lowercases, strips non-alphanumeric (except `-`), collapses
 * dashes. Returns empty string when nothing usable remains — caller
 * surfaces that as a validation error.
 */
export function sanitizeName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function allAgents(d: {
	builtin: AgentConfig[];
	package: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
}): AgentConfig[] {
	// Order matters cosmetically only — `findAgents` sorts by source, and
	// management list/get views render their own ordering. Package agents
	// land between builtin and user to mirror the `discoverAgents` priority
	// stack (builtin < package < user < project).
	return [...d.builtin, ...d.package, ...d.user, ...d.project];
}

function availableAgentNames(cwd: string, options?: PackageAgentDiscoveryOptions): string[] {
	const d = discoverAgentsAll(cwd, options);
	return [...new Set(allAgents(d).map((a) => a.name))].sort((a, b) => a.localeCompare(b));
}

function availableChainNames(cwd: string, options?: PackageAgentDiscoveryOptions): string[] {
	const d = discoverAgentsAll(cwd, options);
	return resolveByScopePrecedence(d.chains).map((chain) => chain.name).sort((a, b) => a.localeCompare(b));
}

function warningText(warnings: readonly string[]): string {
	return warnings.length ? `\nDiscovery warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
}

/**
 * Locate agents matching a name across scopes. Both the literal name and
 * its sanitised form match (so `delegate({action:"get", agent:"My Agent"})`
 * finds an `my-agent.md` file). Sorted by source for deterministic output.
 *
 * NOTE (issue #10 nit): the dual literal+sanitized matching is a deliberate
 * UX affordance — but it means a TYPO that happens to sanitize to an
 * existing name (e.g. `"re viewer"` → `reviewer`) silently resolves rather
 * than erroring. Callers that need strict matching should compare
 * `a.name === name` on the result.
 */
export function findAgents(
	name: string,
	cwd: string,
	scope: AgentScope = "both",
	options?: PackageAgentDiscoveryOptions,
): AgentConfig[] {
	const d = discoverAgentsAll(cwd, options);
	const raw = name.trim();
	const sanitised = sanitizeName(raw);
	return allAgents(d)
		.filter(
			(a) =>
				(scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitised),
		)
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function findChains(name: string, cwd: string, scope: AgentScope = "both", options?: PackageAgentDiscoveryOptions): ChainFileConfig[] {
	const raw = name.trim();
	const sanitised = sanitizeName(raw);
	return discoverAgentsAll(cwd, options)
		.chains.filter(
			(c) =>
				(scope === "both" || c.source === scope) && (c.name === raw || c.name === sanitised),
		)
		.sort((a, b) => a.source.localeCompare(b.source));
}

function nameExistsInScope(
	cwd: string,
	scope: ManagementScope,
	name: string,
	excludePath?: string,
): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	for (const c of d.chains) {
		if (c.source === scope && c.name === name && c.filePath !== excludePath) return true;
	}
	return false;
}

function unknownChainAgents(
	cwd: string,
	steps: ChainStepFileConfig[],
	options?: PackageAgentDiscoveryOptions,
): string[] {
	const d = discoverAgentsAll(cwd, options);
	const known = new Set(allAgents(d).map((a) => a.name));
	return [...new Set(steps.flatMap((step) => isChainWorkerStepFileConfig(step) && !known.has(step.agent) ? [step.agent] : []))].sort((a, b) =>
		a.localeCompare(b),
	);
}

function parseStepList(raw: unknown): { steps?: ChainStepFileConfig[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array." };
	if (raw.length === 0) return { error: "config.steps must include at least one step." };
	const steps: ChainStepFileConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return { error: `config.steps[${i}] must be an object.` };
		}
		const itemRecord = item as Record<string, unknown>;
		const hasAgentDiscriminant = hasKey(itemRecord, "agent");
		const hasChainDiscriminant = hasKey(itemRecord, "chain");
		const hasRunDiscriminant = hasKey(itemRecord, "run");
		const discriminantCount = [hasAgentDiscriminant, hasChainDiscriminant, hasRunDiscriminant]
			.filter(Boolean).length;
		if (discriminantCount !== 1) {
			return { error: `config.steps[${i}] must contain exactly one of 'agent', 'chain', or 'run'.` };
		}
		const stepSchema = hasChainDiscriminant
			? ManagementChainReferenceStepSchema
			: hasRunDiscriminant ? ManagementChainRunStepSchema : ManagementChainWorkerStepSchema;
		if (!Value.Check(stepSchema, item)) {
			for (const validation of Value.Errors(stepSchema, item)) {
				const suffix = validation.path
					.split("/")
					.filter(Boolean)
					.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
					.join(".");
				return {
					error: `config.steps[${i}]${suffix ? `.${suffix}` : ""} ${validation.message}.`,
				};
			}
		}
		const s = stripRemovedPlaneConfigKeys(itemRecord, `chain.steps[${i}].`);
		if (typeof s.chain === "string") {
			if (!s.chain.trim()) {
				return { error: `config.steps[${i}].chain must be a non-empty string.` };
			}
			steps.push({
				chain: s.chain.trim(),
				task: typeof s.task === "string" ? s.task : "",
			});
			continue;
		}
		if (typeof s.run === "string") {
			try {
				const runStep: ChainRunStepFileConfig = {
					run: validateSavedChainRunLabel(s.run, `config.steps[${i}].run`),
					command: validateSavedChainRunCommand(s.command, `config.steps[${i}].command`),
				};
				const cwd = validateSavedChainRunCwd(s.cwd, `config.steps[${i}].cwd`);
				if (cwd !== undefined) runStep.cwd = cwd;
				const timeoutMs = validateSavedChainRunTimeoutMs(
					s.timeoutMs,
					`config.steps[${i}].timeoutMs`,
				);
				if (timeoutMs !== undefined) runStep.timeoutMs = timeoutMs;
				if (hasKey(s, "env") && s.env !== false) {
					runStep.env = parseEnvOverrides(s.env, `config.steps[${i}].env`);
				}
				steps.push(runStep);
				continue;
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (typeof s.agent !== "string" || !s.agent.trim()) {
			return { error: `config.steps[${i}].agent must be a non-empty string.` };
		}
		const step: ChainWorkerStepFileConfig = {
			agent: s.agent.trim(),
			task: typeof s.task === "string" ? s.task : "",
		};
		if (hasKey(s, "env")) {
			if (s.env === false) {
				step.env = undefined;
			} else {
				try {
					step.env = parseEnvOverrides(s.env, `config.steps[${i}].env`);
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}
		}
		if (hasKey(s, "artifact")) {
			if (s.artifact === false) step.artifact = false;
			else if (typeof s.artifact === "string") step.artifact = s.artifact;
			else return { error: `config.steps[${i}].artifact must be a string or false.` };
		}
		if (hasKey(s, "reads")) {
			if (s.reads === false) step.reads = false;
			else if (Array.isArray(s.reads)) {
				step.reads = s.reads
					.filter((v): v is string => typeof v === "string")
					.map((v) => v.trim())
					.filter(Boolean);
			} else return { error: `config.steps[${i}].reads must be an array or false.` };
		}
		if (hasKey(s, "model")) {
			if (typeof s.model === "string") step.model = s.model;
			else return { error: `config.steps[${i}].model must be a string.` };
		}
		const rawThinking: { thinking?: unknown; thinkingMin?: unknown; thinkingMax?: unknown } = {};
		for (const field of ["thinking", "thinkingMin", "thinkingMax"] as const) {
			if (!hasKey(s, field)) continue;
			if (s[field] === false) {
				step[field] = false;
			} else if (typeof s[field] === "string") {
				rawThinking[field] = s[field];
			} else {
				return { error: `config.steps[${i}].${field} must be a thinking level string or false.` };
			}
		}
		try {
			const normalized = normalizeThinkingFields(rawThinking);
			for (const field of ["thinking", "thinkingMin", "thinkingMax"] as const) {
				if (normalized[field] !== undefined) step[field] = normalized[field];
			}
		} catch (err) {
			return {
				error: `config.steps[${i}] has an invalid thinking policy: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (hasKey(s, "skills")) {
			if (s.skills === false) step.skills = false;
			else if (Array.isArray(s.skills)) {
				step.skills = s.skills
					.filter((v): v is string => typeof v === "string")
					.map((v) => v.trim())
					.filter(Boolean);
			} else return { error: `config.steps[${i}].skills must be an array or false.` };
		}
		if (hasKey(s, "progress")) {
			if (typeof s.progress === "boolean") step.progress = s.progress;
			else return { error: `config.steps[${i}].progress must be a boolean.` };
		}
		steps.push(step);
	}
	return { steps };
}

function parseManagedList(raw: unknown, field: string): { values?: string[]; clear: boolean; error?: string } {
	if (raw === false) return { clear: true };
	if (!Array.isArray(raw) || !raw.every((value): value is string => typeof value === "string")) {
		return { clear: false, error: `config.${field} must be an array of strings or false.` };
	}
	return {
		clear: false,
		values: [...raw],
	};
}

function parseTools(raw: unknown): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcp: string[] = [];
	if (!Array.isArray(raw)) return {};
	for (const item of raw) {
		if (typeof item !== "string") continue;
		if (item.startsWith("mcp:")) {
			const direct = item.slice(4).trim();
			if (direct) mcp.push(direct);
		} else tools.push(item);
	}
	return {
		tools: canonicalizeAgentToolEntries(tools.length ? tools : undefined),
		mcpDirectTools: mcp.length ? mcp : undefined,
	};
}

/**
 * Apply the `config: {...}` payload onto an in-memory AgentConfig. Used
 * by both `create` (target starts blank) and `update` (target is the
 * existing on-disk agent). Returns an error string when validation fails;
 * undefined on success.
 *
 * Falsy clears: `{ model: false }` clears `model`; `{ tools: false }`
 * clears tools and mcpDirectTools; etc. Empty-string is treated the same
 * as `false` for fields where it makes sense.
 */
function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	cfg = stripRemovedPlaneConfigKeys(cfg, "agent.");
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "env")) {
		if (cfg.env === false) {
			target.env = undefined;
		} else {
			try {
				target.env = parseEnvOverrides(cfg.env, "config.env");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		}
	}
	if (hasKey(cfg, "fallbackModels")) {
		const parsed = parseManagedList(cfg.fallbackModels, "fallbackModels");
		if (parsed.error) return parsed.error;
		target.fallbackModels = parsed.clear ? undefined : parsed.values;
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false) {
			target.tools = undefined;
			target.mcpDirectTools = undefined;
		} else if (Array.isArray(cfg.tools)) {
			const parsed = parseTools(cfg.tools);
			target.tools = parsed.tools;
			target.mcpDirectTools = parsed.mcpDirectTools;
		} else {
			return "config.tools must be an array of strings or false.";
		}
	}
	if (hasKey(cfg, "skills")) {
		const parsed = parseManagedList(cfg.skills, "skills");
		if (parsed.error) return parsed.error;
		target.skills = parsed.clear ? undefined : parsed.values;
	}
	if (hasKey(cfg, "extensions")) {
		const parsed = parseManagedList(cfg.extensions, "extensions");
		if (parsed.error) return parsed.error;
		target.extensions = parsed.clear ? undefined : parsed.values;
	}
	if (hasKey(cfg, "extensionInclude")) {
		const parsed = parseManagedList(cfg.extensionInclude, "extensionInclude");
		if (parsed.error) return parsed.error;
		target.extensionInclude = parsed.clear ? undefined : parsed.values;
	}
	if (hasKey(cfg, "extensionExclude")) {
		const parsed = parseManagedList(cfg.extensionExclude, "extensionExclude");
		if (parsed.error) return parsed.error;
		target.extensionExclude = parsed.clear ? undefined : parsed.values;
	}
	for (const field of ["thinking", "thinkingMin", "thinkingMax"] as const) {
		if (!hasKey(cfg, field)) continue;
		const value = cfg[field];
		if (value === false || value === "") target[field] = undefined;
		else if (typeof value === "string") target[field] = (value.trim() || undefined) as ThinkingLevel | undefined;
		else return `config.${field} must be a thinking level string or false.`;
	}
	try {
		Object.assign(target, normalizeThinkingFields(target));
	} catch (err) {
		return `Invalid thinking policy: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") {
			target.systemPromptMode = cfg.systemPromptMode;
		} else return "config.systemPromptMode must be 'append' or 'replace'.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") {
			return "config.inheritProjectContext must be a boolean.";
		}
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "defaultMaxRounds")) {
		if (cfg.defaultMaxRounds === false) {
			target.defaultMaxRounds = undefined;
		} else if (
			typeof cfg.defaultMaxRounds === "number" &&
			Number.isSafeInteger(cfg.defaultMaxRounds) &&
			cfg.defaultMaxRounds > 0
		) {
			target.defaultMaxRounds = cfg.defaultMaxRounds;
		} else {
			return "config.defaultMaxRounds must be a positive safe integer or false.";
		}
	}
	if (hasKey(cfg, "stopConditionHint")) {
		if (cfg.stopConditionHint === false || cfg.stopConditionHint === "") {
			target.stopConditionHint = undefined;
		} else if (typeof cfg.stopConditionHint === "string") {
			target.stopConditionHint = cfg.stopConditionHint;
		} else {
			return "config.stopConditionHint must be a string or false.";
		}
	}
	if (hasKey(cfg, "collapseMode")) {
		if (cfg.collapseMode === false) target.collapseMode = undefined;
		else if (cfg.collapseMode === "final_output" || cfg.collapseMode === "summary") target.collapseMode = cfg.collapseMode;
		else return "config.collapseMode must be 'final_output', 'summary', or false.";
	}
	if (hasKey(cfg, "summaryModel")) {
		if (cfg.summaryModel === false || cfg.summaryModel === "") target.summaryModel = undefined;
		else if (typeof cfg.summaryModel === "string") target.summaryModel = cfg.summaryModel.trim() || undefined;
		else return "config.summaryModel must be a string or false.";
	}
	if (hasKey(cfg, "escalation")) {
		if (cfg.escalation === false) {
			target.escalation = undefined;
		} else {
			try {
				const parsed = parseEscalationInvocationValue(cfg.escalation, "config.escalation");
				target.escalation = Object.keys(parsed).length > 0 ? parsed : undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		}
	}
	if (hasKey(cfg, "artifact")) {
		if (cfg.artifact === false || cfg.artifact === "") target.artifact = undefined;
		else if (typeof cfg.artifact === "string") target.artifact = cfg.artifact;
		else return "config.artifact must be a string or false.";
	}
	if (hasKey(cfg, "reads")) {
		const parsed = parseManagedList(cfg.reads, "reads");
		if (parsed.error) return parsed.error;
		target.defaultReads = parsed.clear ? undefined : parsed.values;
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "interactive")) {
		if (typeof cfg.interactive !== "boolean") return "config.interactive must be a boolean.";
		target.interactive = cfg.interactive;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") {
			target.maxSubagentDepth = undefined;
		} else if (
			typeof cfg.maxSubagentDepth === "number" &&
			Number.isSafeInteger(cfg.maxSubagentDepth) &&
			cfg.maxSubagentDepth >= 0 &&
			cfg.maxSubagentDepth <= HARD_MAX_DEPTH
		) {
			target.maxSubagentDepth = validateMaxSubagentDepth(cfg.maxSubagentDepth);
		} else {
			return `config.maxSubagentDepth must be a safe integer from 0 to ${HARD_MAX_DEPTH}, or false.`;
		}
	}
	if (hasKey(cfg, "allowNestedDelegate")) {
		if (cfg.allowNestedDelegate === false || cfg.allowNestedDelegate === "") {
			target.allowNestedDelegate = undefined;
		} else if (typeof cfg.allowNestedDelegate === "boolean") {
			target.allowNestedDelegate = cfg.allowNestedDelegate;
		} else {
			return "config.allowNestedDelegate must be a boolean or false.";
		}
	}
	if (hasKey(cfg, "nestedDelegateAgents")) {
		const parsed = parseManagedList(cfg.nestedDelegateAgents, "nestedDelegateAgents");
		if (parsed.error) return parsed.error;
		target.nestedDelegateAgents = parsed.clear ? undefined : parsed.values;
	}
	for (const field of ["maxDurationMs", "windDownGraceMs"] as const) {
		if (!hasKey(cfg, field)) continue;
		const value = cfg[field];
		if (value === false) {
			target[field] = undefined;
			continue;
		}
		const normalized = normalizeTimeoutMs(value);
		if (normalized === undefined) {
			return `config.${field} must be a safe integer from 0 to ${MAX_TIMEOUT_MS}, or false.`;
		}
		target[field] = normalized;
	}
	return undefined;
}

/**
 * Resolve the single mutable target (user or project, never builtin) for an
 * update / delete action. When two scopes have the same name and no
 * `agentScope` hint disambiguates, returns an error result the caller
 * should surface verbatim.
 */
/**
 * A target `resolveTarget` has already proven mutable.
 *
 * `resolveTarget` filters `builtin` and `package` out before returning, so its
 * result can only carry a `ManagementScope`. Saying so in the type lets callers
 * pass `source` straight into scope-typed fields instead of asserting it.
 */
type MutableTarget<T extends { source: AgentConfig["source"] }> = T & { source: ManagementScope };

function resolveTarget<T extends { source: AgentConfig["source"]; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): MutableTarget<T> | AgentManagementResult {
	const mutable = matches.filter(
		(m): m is MutableTarget<T> => m.source !== "builtin" && m.source !== "package",
	);
	if (mutable.length === 0) {
		if (matches.length > 0) {
			const src = matches[0]!.source;
			let origin = "builtin";
			if (src === "package") {
				const maybe = matches[0] as unknown as { packageName?: string };
				origin = `installed by package '${maybe.packageName ?? "(unknown)"}'`;
			}
			return err(
				`${kind === "agent" ? "Agent" : "Chain"} '${name}' is ${origin} and cannot be modified. ` +
					`Create a same-named ${kind} in user or project scope to override it.`,
			);
		}
		const available = (kind === "agent" ? availableAgentNames(cwd) : availableChainNames(cwd)).join(
			", ",
		);
		return err(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${available || "none"}.`);
	}
	if (mutable.length === 1) return mutable[0]!;

	const scope = asScopeHint(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return err(
			`${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`,
		);
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return err(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found in scope '${scope}'.`);
	if (scoped.length > 1) {
		return err(
			`Multiple ${kind}s named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`,
		);
	}
	return scoped[0]!;
}

function renamePath(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	cwd: string,
): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) {
		return { error: `Name '${newName}' already exists in ${scope} scope.` };
	}
	const ext = kind === "agent" ? ".md" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return {
			error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.`,
		};
	}
	return { filePath };
}

/** Format a single agent for `get` output. */
export function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [
		`Agent: ${agent.name} (${agent.source})`,
		`Path: ${agent.filePath}`,
		`Description: ${agent.description}`,
	];
	if (agent.source === "package" && agent.packageName) {
		lines.splice(1, 0, `Package: ${agent.packageName}`);
	}
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.env && Object.keys(agent.env).length > 0) lines.push(`Environment overrides: ${Object.keys(agent.env).sort().join(", ")}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.extensions !== undefined) {
		lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	}
	if (agent.extensionInclude !== undefined) {
		lines.push(`Extension include: ${agent.extensionInclude.length ? agent.extensionInclude.join(", ") : "(none)"}`);
	}
	if (agent.extensionExclude !== undefined) {
		lines.push(`Extension exclude: ${agent.extensionExclude.length ? agent.extensionExclude.join(", ") : "(none)"}`);
	}
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.thinkingMin) lines.push(`Thinking min: ${agent.thinkingMin}`);
	if (agent.thinkingMax) lines.push(`Thinking max: ${agent.thinkingMax}`);
	if (agent.defaultMaxRounds !== undefined) lines.push(`Default max rounds: ${agent.defaultMaxRounds}`);
	if (agent.stopConditionHint) lines.push(`Stop condition hint: ${agent.stopConditionHint}`);
	if (agent.collapseMode) lines.push(`Collapse mode: ${agent.collapseMode}`);
	if (agent.summaryModel) lines.push(`Summary model: ${agent.summaryModel}`);
	if (agent.escalation) lines.push(`Escalation: ${JSON.stringify(agent.escalation)}`);
	if (agent.artifact) lines.push(`Artifact: ${agent.artifact}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.allowNestedDelegate !== undefined) lines.push(`Allow nested delegate: ${agent.allowNestedDelegate ? "true" : "false"}`);
	if (agent.nestedDelegateAgents?.length) lines.push(`Nested delegate agents: ${agent.nestedDelegateAgents.join(", ")}`);
	if (agent.maxDurationMs !== undefined) lines.push(`Max duration: ${agent.maxDurationMs} ms`);
	if (agent.windDownGraceMs !== undefined) lines.push(`Wind-down grace: ${agent.windDownGraceMs} ms`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function formatChainDetail(chain: ChainFileConfig): string {
	const lines: string[] = [
		`Chain: ${chain.name} (${chain.source})`,
		`Path: ${chain.filePath}`,
		`Description: ${chain.description}`,
		"",
		"Steps:",
	];
	for (let i = 0; i < chain.steps.length; i++) {
		const s = chain.steps[i]!;
		if (isChainReferenceStepFileConfig(s)) {
			lines.push(`${i + 1}. chain: ${s.chain}`);
			if (s.task.trim()) lines.push(`   Task: ${s.task}`);
			continue;
		}
		if (isChainRunStepFileConfig(s)) {
			lines.push(`${i + 1}. run: ${s.run}`);
			lines.push(`   Command: ${s.command}`);
			if (s.cwd) lines.push(`   Cwd: ${s.cwd}`);
			if (s.env && Object.keys(s.env).length > 0) {
				lines.push(`   Environment overrides: ${Object.keys(s.env).sort().join(", ")}`);
			}
			if (s.timeoutMs !== undefined) lines.push(`   Timeout: ${s.timeoutMs} ms`);
			continue;
		}
		lines.push(`${i + 1}. ${s.agent}`);
		if (s.task.trim()) lines.push(`   Task: ${s.task}`);
		if (s.artifact === false) lines.push("   Artifact: false");
		else if (s.artifact) lines.push(`   Artifact: ${s.artifact}`);
		if (s.reads === false) lines.push("   Reads: false");
		else if (Array.isArray(s.reads) && s.reads.length > 0) lines.push(`   Reads: ${s.reads.join(", ")}`);
		if (s.model) lines.push(`   Model: ${s.model}`);
		if (s.env && Object.keys(s.env).length > 0) lines.push(`   Environment overrides: ${Object.keys(s.env).sort().join(", ")}`);
		if (s.thinking === false) lines.push("   Thinking: false");
		else if (s.thinking) lines.push(`   Thinking: ${s.thinking}`);
		if (s.thinkingMin === false) lines.push("   Thinking min: false");
		else if (s.thinkingMin) lines.push(`   Thinking min: ${s.thinkingMin}`);
		if (s.thinkingMax === false) lines.push("   Thinking max: false");
		else if (s.thinkingMax) lines.push(`   Thinking max: ${s.thinkingMax}`);
		if (s.skills === false) lines.push("   Skills: false");
		else if (Array.isArray(s.skills) && s.skills.length > 0) lines.push(`   Skills: ${s.skills.join(", ")}`);
		if (s.progress !== undefined) lines.push(`   Progress: ${s.progress ? "true" : "false"}`);
	}
	return lines.join("\n");
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonicalize(entry)]),
		);
	}
	return value;
}

function agentFingerprint(agent: AgentConfig): string {
	return JSON.stringify(canonicalize({
		name: agent.name,
		description: agent.description,
		source: agent.source,
		model: agent.model,
		env: agent.env,
		tools: canonicalizeAgentToolEntries(agent.tools),
		mcpDirectTools: agent.mcpDirectTools,
		systemPrompt: agent.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: agent.skills,
		fallbackModels: agent.fallbackModels,
		extensions: agent.extensions,
		extensionInclude: agent.extensionInclude,
		extensionExclude: agent.extensionExclude,
		thinking: agent.thinking,
		thinkingMin: agent.thinkingMin,
		thinkingMax: agent.thinkingMax,
		defaultMaxRounds: agent.defaultMaxRounds,
		stopConditionHint: agent.stopConditionHint,
		collapseMode: agent.collapseMode,
		summaryModel: agent.summaryModel,
		defaultReads: agent.defaultReads,
		defaultProgress: agent.defaultProgress,
		artifact: agent.artifact,
		interactive: agent.interactive,
		maxSubagentDepth: agent.maxSubagentDepth,
		allowNestedDelegate: agent.allowNestedDelegate,
		nestedDelegateAgents: agent.nestedDelegateAgents,
		maxDurationMs: agent.maxDurationMs,
		windDownGraceMs: agent.windDownGraceMs,
		escalation: agent.escalation,
	}));
}

function chainFingerprint(chain: ChainFileConfig): string {
	return JSON.stringify(canonicalize({
		name: chain.name,
		description: chain.description,
		source: chain.source,
		steps: chain.steps.map((step) => {
			if (isChainReferenceStepFileConfig(step)) return { chain: step.chain, task: step.task };
			if (isChainRunStepFileConfig(step)) {
				return {
					run: step.run,
					command: step.command,
					cwd: step.cwd,
					env: step.env,
					timeoutMs: step.timeoutMs,
				};
			}
			return {
				agent: step.agent,
				task: step.task,
				env: step.env,
				artifact: step.artifact,
				reads: step.reads,
				model: step.model,
				thinking: step.thinking,
				thinkingMin: step.thinkingMin,
				thinkingMax: step.thinkingMax,
				skills: step.skills,
				progress: step.progress,
			};
		}),
	}));
}

function candidatePath(targetPath: string): string {
	const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${targetPath}.roundtrip-${suffix}.tmp`;
}

function prepareAgentCandidate(
	targetPath: string,
	serialized: string,
	expected: AgentConfig,
): { candidatePath?: string; warnings: string[]; error?: string } {
	const temporaryPath = candidatePath(targetPath);
	const warnings: string[] = [];
	try {
		fs.writeFileSync(temporaryPath, serialized, { encoding: "utf-8", flag: "wx" });
		const discovered = discoverAgentFile(temporaryPath, expected.source, warnings);
		if (!discovered) {
			cleanupCandidate(temporaryPath);
			return {
				warnings,
				error: `Generated agent '${expected.name}' failed discovery round-trip.${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
			};
		}
		if (agentFingerprint(discovered) !== agentFingerprint(expected)) {
			cleanupCandidate(temporaryPath);
			return {
				warnings,
				error: `Generated agent '${expected.name}' changed effective configuration during discovery round-trip.`,
			};
		}
		return { candidatePath: temporaryPath, warnings };
	} catch (error) {
		cleanupCandidate(temporaryPath);
		return {
			warnings,
			error: `Generated agent '${expected.name}' failed discovery round-trip: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function prepareChainCandidate(
	targetPath: string,
	serialized: string,
	expected: ChainFileConfig,
): { candidatePath?: string; warnings: string[]; error?: string } {
	const temporaryPath = candidatePath(targetPath);
	const warnings: string[] = [];
	try {
		fs.writeFileSync(temporaryPath, serialized, { encoding: "utf-8", flag: "wx" });
		const discovered = parseChain(fs.readFileSync(temporaryPath, "utf-8"), expected.source, temporaryPath);
		if (chainFingerprint(discovered) !== chainFingerprint(expected)) {
			cleanupCandidate(temporaryPath);
			return {
				warnings,
				error: `Generated chain '${expected.name}' changed effective configuration during discovery round-trip.`,
			};
		}
		return { candidatePath: temporaryPath, warnings };
	} catch (error) {
		cleanupCandidate(temporaryPath);
		return {
			warnings,
			error: `Generated chain '${expected.name}' failed discovery round-trip: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function publishCandidate(candidate: string, target: string, previous?: string): void {
	if (previous === undefined || previous === target) {
		fs.renameSync(candidate, target);
		return;
	}
	const backup = `${previous}.managed-backup-${process.pid}-${Date.now()}`;
	fs.renameSync(previous, backup);
	try {
		fs.renameSync(candidate, target);
	} catch (error) {
		fs.renameSync(backup, previous);
		throw error;
	}
	fs.rmSync(backup, { force: true });
}

function cleanupCandidate(candidate: string | undefined): void {
	if (candidate !== undefined) fs.rmSync(candidate, { force: true });
}

/** Narrow seams for deterministic management round-trip tests. */
type ManagementTestHooks = {
	agentFingerprint: (agent: AgentConfig) => string;
	chainFingerprint: (chain: ChainFileConfig) => string;
	prepareAgentCandidate: (
		targetPath: string,
		serialized: string,
		expected: AgentConfig,
	) => { candidatePath?: string; warnings: string[]; error?: string };
};

export const __testHooks: ManagementTestHooks = {
	agentFingerprint,
	chainFingerprint,
	prepareAgentCandidate,
};

function bodySuffix(content: string): string | undefined {
	const opening = /^---[ \t]*(?:\r\n|\n|$)/.exec(content);
	if (!opening) return undefined;
	const closingPattern = /^---[ \t]*(?=\r?$)/gm;
	closingPattern.lastIndex = opening[0].length;
	const closing = closingPattern.exec(content);
	if (!closing) return undefined;
	return content.slice(closing.index + closing[0].length);
}

function canonicalizeWarnings(warnings: readonly string[]): string[] {
	return warnings.filter((warning) => !warning.includes("deprecated frontmatter spelling"));
}

export function handleCanonicalize(
	params: ManagementParams,
	ctx: ManagementContext,
): AgentManagementResult {
	if (!params.agent) return err("Specify 'agent' for canonicalize.");
	if (params.chainName) return err("Canonicalize only supports agent definitions, not chains.");
	const targetOrErr = resolveTarget(
		"agent",
		params.agent,
		findAgents(params.agent, ctx.cwd, asScopeHint(params.agentScope) ?? "both", ctx.discoveryOptions),
		ctx.cwd,
		params.agentScope,
	);
	if ("text" in targetOrErr && targetOrErr.isError) return targetOrErr;
	const target = targetOrErr as MutableTarget<AgentConfig>;
	let content: string;
	try {
		content = fs.readFileSync(target.filePath, "utf-8");
	} catch (error) {
		return err(`Could not read agent '${target.name}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const suffix = bodySuffix(content);
	if (suffix === undefined) return err(`Could not canonicalize '${target.filePath}': missing frontmatter delimiters.`);
	try {
		parseFrontmatter<Record<string, unknown>>(content);
	} catch {
		return err(`Could not canonicalize '${target.filePath}': malformed YAML frontmatter.`);
	}
	const discoveryWarnings: string[] = [];
	const parsed = discoverAgentFile(target.filePath, target.source, discoveryWarnings);
	if (!parsed) return err(`Could not canonicalize '${target.filePath}': the agent cannot be represented safely.`);
	if (parsed.extraFields && Object.keys(parsed.extraFields).length > 0) {
		return err(
			`Could not canonicalize '${target.filePath}': unknown frontmatter fields cannot be represented by the canonical serializer (${Object.keys(parsed.extraFields).sort().join(", ")}).`,
		);
	}
	const unsafeWarnings = canonicalizeWarnings(discoveryWarnings);
	if (unsafeWarnings.length > 0) {
		return err(
			`Could not canonicalize '${target.filePath}': frontmatter contains values the canonical serializer cannot represent safely. ${unsafeWarnings.join(" ")}`,
		);
	}
	const serialized = serializeAgentWithBody(parsed, suffix);
	const candidate = prepareAgentCandidate(target.filePath, serialized, parsed);
	if (candidate.error) {
		return err(`Could not canonicalize '${target.filePath}': ${candidate.error}`, {
			action: "canonicalize",
			agent: target.name,
			scope: target.source,
			warnings: candidate.warnings,
		});
	}
	try {
		publishCandidate(candidate.candidatePath!, target.filePath);
	} catch (error) {
		cleanupCandidate(candidate.candidatePath);
		return err(`Could not canonicalize '${target.filePath}': ${error instanceof Error ? error.message : String(error)}`);
	}
	return ok(`Canonicalized agent '${target.name}' at ${target.filePath}.`, {
		action: "canonicalize",
		agent: target.name,
		scope: target.source,
		filePath: target.filePath,
		warnings: discoveryWarnings.filter((warning) => warning.includes("deprecated frontmatter spelling")),
	});
}

// ── Public handlers ─────────────────────────────────────────────────────────

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentManagementResult {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd, ctx.discoveryOptions);
	const agents = allAgents(d)
		.filter((agent) => sourceVisibleInAgentScope(agent.source, scope))
		.sort((a, b) => a.name.localeCompare(b.name));
	const resolvedChains = new Map(
		resolveByScopePrecedence(d.chains).map((chain) => [chain.name, chain]),
	);
	const chains = d.chains
		.filter((chain) => sourceVisibleInAgentScope(chain.source, scope))
		.sort((a, b) => a.name.localeCompare(b.name));
	const formatChain = (chain: ChainFileConfig): string => {
		const winner = resolvedChains.get(chain.name);
		const shadow = winner && winner.filePath !== chain.filePath
			? `, shadowed by ${winner.source} (${winner.filePath})`
			: "";
		return `- ${chain.name} (${chain.source}${shadow}): ${chain.description}`;
	};

	const lines = [
		`Agents (${agents.length}):`,
		...(agents.length
			? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`)
			: ["- (none)"]),
		"",
		`Chains (${chains.length}):`,
		...(chains.length ? chains.map(formatChain) : ["- (none)"]),
	];
	// Issue #10 — a broken agent file previously vanished from the list with
	// only a console.warn (invisible in the TUI). Surface discovery warnings
	// in the list output AND structured details so authors notice.
	if (d.warnings.length) {
		lines.push("", `Warnings (${d.warnings.length}):`, ...d.warnings.map((w) => `- ${w}`));
	}
	return ok(lines.join("\n"), {
		action: "list",
		...(d.warnings.length ? { warnings: d.warnings } : {}),
	});
}

export function handleGet(params: ManagementParams, ctx: ManagementContext): AgentManagementResult {
	if (!params.agent && !params.chainName) return err("Specify 'agent' or 'chainName' for get.");
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const discovery = discoverAgentsAll(ctx.cwd, ctx.discoveryOptions);
	const discoveryWarnings = discovery.warnings;
	const blocks: string[] = [];
	let anyFound = false;
	type GetCandidate = { name: string; source: AgentSource; render: () => string };
	const queries: Array<{ label: "Agent" | "Chain"; name: string; candidates: GetCandidate[] }> = [];
	if (params.agent) {
		queries.push({
			label: "Agent",
			name: params.agent,
			candidates: allAgents(discovery).map((agent) => ({
				name: agent.name,
				source: agent.source,
				render: () => formatAgentDetail(agent),
			})),
		});
	}
	if (params.chainName) {
		queries.push({
			label: "Chain",
			name: params.chainName,
			candidates: discovery.chains.map((chain) => ({
				name: chain.name,
				source: chain.source,
				render: () => formatChainDetail(chain),
			})),
		});
	}

	for (const query of queries) {
		const visible = query.candidates.filter((candidate) => sourceVisibleInAgentScope(candidate.source, scope));
		const raw = query.name.trim();
		const sanitised = sanitizeName(raw);
		const matches = visible
			.filter((candidate) => candidate.name === raw || candidate.name === sanitised)
			.sort((a, b) => a.source.localeCompare(b.source));
		if (matches.length) {
			anyFound = true;
			blocks.push(...matches.map((candidate) => candidate.render()));
			continue;
		}
		const available = [...new Set(visible.map((candidate) => candidate.name))]
			.sort((a, b) => a.localeCompare(b))
			.join(", ");
		blocks.push(`${query.label} '${query.name}' not found. Available: ${available || "none"}.`);
	}
	const text = blocks.join("\n\n") + warningText(discoveryWarnings);
	return anyFound
		? ok(text, { action: "get", ...(discoveryWarnings.length ? { warnings: discoveryWarnings } : {}) })
		: err(text, { action: "get", ...(discoveryWarnings.length ? { warnings: discoveryWarnings } : {}) });
}

export function handleCreate(
	params: ManagementParams,
	ctx: ManagementContext,
): AgentManagementResult {
	const parsed = configObject(params.config);
	if (parsed.error) return err(parsed.error);
	const cfg = parsed.value;
	if (!cfg) return err("config required for create.");
	const schemaError = managementConfigError(cfg);
	if (schemaError) return err(schemaError);
	const isChain = hasKey(cfg, "steps");
	const shapeError = managementShapeError(cfg, isChain);
	if (shapeError) return err(shapeError);
	if (typeof cfg.name !== "string" || !cfg.name.trim()) {
		return err("config.name is required and must be a non-empty string.");
	}
	if (typeof cfg.description !== "string" || !cfg.description.trim()) {
		return err("config.description is required and must be a non-empty string.");
	}
	const name = sanitizeName(cfg.name);
	if (!name)
		return err(
			`config.name ${JSON.stringify(cfg.name)} contains no usable characters after sanitization — ` +
				"the name must contain at least one letter or number (letters, numbers, spaces, and hyphens are kept).",
		);

	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") {
		return err("config.scope must be 'user' or 'project'.");
	}
	const scope = scopeRaw as ManagementScope;
	const d = discoverAgentsAll(ctx.cwd, ctx.discoveryOptions);
	const targetDir =
		scope === "user" ? d.userDir : d.projectDir ?? path.join(ctx.cwd, ".pi", "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, name)) {
		return err(`Name '${name}' already exists in ${scope} scope. Use update instead.`);
	}
	const targetPath = path.join(targetDir, isChain ? `${name}.chain.md` : `${name}.md`);
	if (fs.existsSync(targetPath)) {
		return err(
			`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`,
		);
	}

	const warnings: string[] = [];
	if (!isChain && d.builtin.some((a) => a.name === name)) {
		warnings.push(`Note: this shadows the builtin agent '${name}'.`);
	} else if (!isChain) {
		const pkg = d.package.find((a) => a.name === name);
		if (pkg) {
			warnings.push(
				`Note: this shadows the package agent '${name}'` +
					(pkg.packageName ? ` (from ${pkg.packageName})` : "") +
					".",
			);
		}
	}

	if (isChain) {
		const stepsParsed = parseStepList(cfg.steps);
		if (stepsParsed.error) return err(stepsParsed.error);
		const chain: ChainFileConfig = {
			name,
			description: cfg.description.trim(),
			source: scope,
			filePath: targetPath,
			steps: stepsParsed.steps!,
		};
		const candidate = prepareChainCandidate(targetPath, serializeChain(chain), chain);
		if (candidate.error) return err(candidate.error, { action: "create", chainName: name, scope, warnings: candidate.warnings });
		try {
			publishCandidate(candidate.candidatePath!, targetPath);
		} catch (error) {
			cleanupCandidate(candidate.candidatePath);
			return err(`Could not publish chain '${name}': ${error instanceof Error ? error.message : String(error)}`);
		}
		const missing = unknownChainAgents(ctx.cwd, chain.steps, ctx.discoveryOptions);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		return ok(
			[`Created chain '${name}' at ${targetPath}.`, ...warnings].join("\n"),
			{ action: "create", chainName: name, scope, filePath: targetPath, warnings },
		);
	}

	const agent: AgentConfig = {
		name,
		description: cfg.description.trim(),
		source: scope,
		filePath: targetPath,
		systemPrompt: "",
		systemPromptMode: defaultSystemPromptMode(),
		inheritProjectContext: defaultInheritProjectContext(),
		inheritSkills: defaultInheritSkills(),
	};
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return err(applyError);
	const candidate = prepareAgentCandidate(targetPath, serializeAgent(agent), agent);
	if (candidate.error) return err(candidate.error, { action: "create", agent: name, scope, warnings: candidate.warnings });
	try {
		publishCandidate(candidate.candidatePath!, targetPath);
	} catch (error) {
		cleanupCandidate(candidate.candidatePath);
		return err(`Could not publish agent '${name}': ${error instanceof Error ? error.message : String(error)}`);
	}
	return ok(
		[`Created agent '${name}' at ${targetPath}.`, ...warnings].join("\n"),
		{ action: "create", agent: name, scope, filePath: targetPath, warnings },
	);
}

export function handleUpdate(
	params: ManagementParams,
	ctx: ManagementContext,
): AgentManagementResult {
	if (!params.agent && !params.chainName) return err("Specify 'agent' or 'chainName' for update.");
	if (params.agent && params.chainName) return err("Specify either 'agent' or 'chainName', not both.");
	const parsed = configObject(params.config);
	if (parsed.error) return err(parsed.error);
	const cfg = parsed.value;
	if (!cfg) return err("config required for update.");
	const schemaError = managementConfigError(cfg);
	if (schemaError) return err(schemaError);
	if (hasKey(cfg, "scope")) return err("config.scope is only supported for create.");
	const shapeError = managementShapeError(cfg, Boolean(params.chainName));
	if (shapeError) return err(shapeError);
	const warnings: string[] = [];

	if (params.agent) {
		const scopeHint = asScopeHint(params.agentScope);
		const targetOrErr = resolveTarget(
			"agent",
			params.agent,
			findAgents(params.agent, ctx.cwd, scopeHint ?? "both", ctx.discoveryOptions),
			ctx.cwd,
			params.agentScope,
		);
		if ("text" in targetOrErr && targetOrErr.isError) return targetOrErr;
		const target = targetOrErr as MutableTarget<AgentConfig>;
		const updated: AgentConfig = { ...target };
		const oldName = target.name;
		if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) {
			return err("config.name must be a non-empty string when provided.");
		}
		if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) {
			return err("config.description must be a non-empty string when provided.");
		}
		let newName: string | undefined;
		if (hasKey(cfg, "name")) {
			newName = sanitizeName(cfg.name as string);
			if (!newName)
			return err(
				`config.name ${JSON.stringify(cfg.name)} contains no usable characters after sanitization — ` +
					"the name must contain at least one letter or number.",
			);
		}
		const applyError = applyAgentConfig(updated, cfg);
		if (applyError) return err(applyError);
		if (newName !== undefined) updated.name = newName;
		if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();

		if (updated.name !== oldName) {
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, ctx.cwd);
			if (renamed.error) return err(renamed.error);
			updated.filePath = renamed.filePath!;
		}
		const candidate = prepareAgentCandidate(updated.filePath, serializeAgent(updated), updated);
		if (candidate.error) {
			return err(candidate.error, {
				action: "update",
				agent: updated.name,
				scope: target.source,
				warnings: candidate.warnings,
			});
		}
		try {
			publishCandidate(
				candidate.candidatePath!,
				updated.filePath,
				updated.name !== oldName ? target.filePath : undefined,
			);
		} catch (error) {
			cleanupCandidate(candidate.candidatePath);
			return err(`Could not publish agent '${updated.name}': ${error instanceof Error ? error.message : String(error)}`);
		}

		if (updated.name !== oldName) {
			const refs = discoverAgentsAll(ctx.cwd, ctx.discoveryOptions)
				.chains.filter((c) => c.steps.some((s) => isChainWorkerStepFileConfig(s) && s.agent === oldName))
				.map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		const headline =
			updated.name === oldName
				? `Updated agent '${updated.name}' at ${updated.filePath}.`
				: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
		return ok([headline, ...warnings].join("\n"), {
			action: "update",
			agent: updated.name,
			scope: target.source,
			filePath: updated.filePath,
			warnings,
		});
	}

	const scopeHint = asScopeHint(params.agentScope);
	const targetOrErr = resolveTarget(
		"chain",
		params.chainName!,
		findChains(params.chainName!, ctx.cwd, scopeHint ?? "both", ctx.discoveryOptions),
		ctx.cwd,
		params.agentScope,
	);
	if ("text" in targetOrErr && targetOrErr.isError) return targetOrErr;
	const target = targetOrErr as MutableTarget<ChainFileConfig>;
	const updated: ChainFileConfig = { ...target, steps: [...target.steps] };
	const oldName = target.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) {
		return err("config.name must be a non-empty string when provided.");
	}
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) {
		return err("config.description must be a non-empty string when provided.");
	}
	let newName: string | undefined;
	if (hasKey(cfg, "name")) {
		newName = sanitizeName(cfg.name as string);
		if (!newName)
		return err(
			`config.name ${JSON.stringify(cfg.name)} contains no usable characters after sanitization — ` +
				"the name must contain at least one letter or number.",
		);
	}
	let parsedSteps: ChainStepFileConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const stepsParsed = parseStepList(cfg.steps);
		if (stepsParsed.error) return err(stepsParsed.error);
		parsedSteps = stepsParsed.steps!;
	}
	if (newName !== undefined) updated.name = newName;
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(ctx.cwd, updated.steps, ctx.discoveryOptions);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
	}
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, managementScope(target.source), ctx.cwd);
		if (renamed.error) return err(renamed.error);
		updated.filePath = renamed.filePath!;
	}
	const candidate = prepareChainCandidate(updated.filePath, serializeChain(updated), updated);
	if (candidate.error) {
		return err(candidate.error, {
			action: "update",
			chainName: updated.name,
			scope: target.source,
			warnings: candidate.warnings,
		});
	}
	try {
		publishCandidate(
			candidate.candidatePath!,
			updated.filePath,
			updated.name !== oldName ? target.filePath : undefined,
		);
	} catch (error) {
		cleanupCandidate(candidate.candidatePath);
		return err(`Could not publish chain '${updated.name}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const headline =
		updated.name === oldName
			? `Updated chain '${updated.name}' at ${updated.filePath}.`
			: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return ok([headline, ...warnings].join("\n"), {
		action: "update",
		chainName: updated.name,
		scope: managementScope(target.source),
		filePath: updated.filePath,
		warnings,
	});
}

export function handleDelete(
	params: ManagementParams,
	ctx: ManagementContext,
): AgentManagementResult {
	if (!params.agent && !params.chainName) return err("Specify 'agent' or 'chainName' for delete.");
	if (params.agent && params.chainName) return err("Specify either 'agent' or 'chainName', not both.");
	const scopeHint = asScopeHint(params.agentScope);
	if (params.agent) {
		const targetOrErr = resolveTarget(
			"agent",
			params.agent,
			findAgents(params.agent, ctx.cwd, scopeHint ?? "both", ctx.discoveryOptions),
			ctx.cwd,
			params.agentScope,
		);
		if ("text" in targetOrErr && targetOrErr.isError) return targetOrErr;
		const target = targetOrErr as MutableTarget<AgentConfig>;
		fs.unlinkSync(target.filePath);
		const refs = discoverAgentsAll(ctx.cwd, ctx.discoveryOptions)
			.chains.filter((c) => c.steps.some((s) => isChainWorkerStepFileConfig(s) && s.agent === target.name))
			.map((c) => `${c.name} (${c.source})`);
		const lines = [`Deleted agent '${target.name}' at ${target.filePath}.`];
		if (refs.length) lines.push(`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`);
		return ok(lines.join("\n"), {
			action: "delete",
			agent: target.name,
			scope: target.source,
			filePath: target.filePath,
		});
	}
	const targetOrErr = resolveTarget(
		"chain",
		params.chainName!,
		findChains(params.chainName!, ctx.cwd, scopeHint ?? "both", ctx.discoveryOptions),
		ctx.cwd,
		params.agentScope,
	);
	if ("text" in targetOrErr && targetOrErr.isError) return targetOrErr;
	const target = targetOrErr as MutableTarget<ChainFileConfig>;
	fs.unlinkSync(target.filePath);
	return ok(`Deleted chain '${target.name}' at ${target.filePath}.`, {
		action: "delete",
		chainName: target.name,
		scope: managementScope(target.source),
		filePath: target.filePath,
	});
}

export function handleManagementAction(
	action: string,
	params: ManagementParams,
	ctx: ManagementContext,
): AgentManagementResult {
	switch (action as ManagementAction) {
		case "list":
			return handleList(params, ctx);
		case "get":
			return handleGet(params, ctx);
		case "create":
			return handleCreate(params, ctx);
		case "update":
			return handleUpdate(params, ctx);
		case "delete":
			return handleDelete(params, ctx);
		case "canonicalize":
			return handleCanonicalize(params, ctx);
		default:
			return err(`Unknown action: ${action}. Expected one of: list, get, create, update, delete, canonicalize.`);
	}
}
