/**
 * Phase C: round-trippable serialization for agent `.md` files.
 *
 * Produces output that:
 *   1. Round-trips through `discoverAgents` → `serializeAgent` →
 *      `discoverAgents` losslessly for every field the parser
 *      recognises.
 *   2. Has a stable, alphabetised frontmatter field order so two runs
 *      produce byte-identical output (deterministic diffs).
 *   3. Uses YAML-compatible scalar quoting only when needed (preserves
 *      hand-written agent files that don't quote everything).
 *
 * Out of scope (deliberate):
 *   - Free-form YAML with anchors / nested objects. Agent frontmatter
 *     is flat key→scalar/list. We don't try to support nested YAML and
 *     reject it at parse time anyway.
 *   - Preservation of comments / blank lines inside frontmatter. The
 *     `parseFrontmatter` helper already strips them, so a round-trip
 *     would lose them regardless.
 */

import type { AgentConfig } from "./agents.js";
import { parseToolGrant as parseControlToolGrant } from "./control-surface.js";
import { parseToolGrant as parseSelectorToolGrant } from "./tool-selector.js";
import { HARD_MAX_DEPTH, validateMaxSubagentDepth } from "./depth-guard.js";
import { isPiDelegatePackageIdentifier } from "./extension-policy.js";
import { normalizeTimeoutMs } from "./fork-timeout.js";

/**
 * Frontmatter fields we know how to serialize. Order matches what we emit
 * (alphabetical within groups; `name` and `description` always first).
 */
type AgentSerializableField = keyof AgentConfig | "artifact";

const FIELD_ORDER: AgentSerializableField[] = [
	// Required
	"name",
	"description",
	// Core
	"model",
	"env",
	"fallbackModels",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"skills",
	"tools",
	"extensions",
	"extensionInclude",
	"extensionExclude",
	// Delegate-specific
	"defaultMaxRounds",
	"stopConditionHint",
	"collapseMode",
	"summaryModel",
	"escalation",
	// Phase A direct/chain mode
	"defaultReads",
	"parentTranscriptSearch",
	"defaultProgress",
	"artifact",
	"interactive",
	"maxSubagentDepth",
	"allowNestedDelegate",
	"nestedDelegateAgents",
	"maxDurationMs",
	"windDownGraceMs",
];

/**
 * Optional override of the agent's frontmatter. Used by
 * `action: "update"` to merge user-supplied fields on top of the
 * existing config. `false` clears the field. `undefined` keeps it.
 */
export interface AgentConfigPatch {
	name?: string | false;
	description?: string | false;
	model?: string | false;
	env?: Record<string, string | null> | false;
	fallbackModels?: string[] | false;
	thinking?: AgentConfig["thinking"] | false;
	thinkingMin?: AgentConfig["thinkingMin"] | false;
	thinkingMax?: AgentConfig["thinkingMax"] | false;
	systemPromptMode?: "append" | "replace" | false;
	inheritProjectContext?: boolean | false;
	inheritSkills?: boolean | false;
	skills?: string[] | false;
	tools?: string[] | false;
	mcpDirectTools?: string[] | false;
	extensions?: string[] | false;
	extensionInclude?: string[] | false;
	extensionExclude?: string[] | false;
	defaultMaxRounds?: number | false;
	stopConditionHint?: string | false;
	collapseMode?: "final_output" | "summary" | false;
	summaryModel?: string | false;
	escalation?: AgentConfig["escalation"] | false;
	defaultReads?: string[] | false;
	parentTranscriptSearch?: boolean | false;
	defaultProgress?: boolean | false;
	artifact?: string | false;
	interactive?: boolean | false;
	maxSubagentDepth?: number | false;
	allowNestedDelegate?: boolean | false;
	nestedDelegateAgents?: string[] | false;
	maxDurationMs?: number | false;
	windDownGraceMs?: number | false;
	systemPrompt?: string;
}

/**
 * Apply a patch to an agent config, returning a new config object.
 * Falsy values in the patch (literal `false`) clear the corresponding
 * field. Other fields pass through unchanged.
 *
 * Pure function — does NOT touch disk.
 */
export function applyAgentPatch(base: AgentConfig, patch: AgentConfigPatch): AgentConfig {
	const out: AgentConfig = { ...base };
	for (const [key, value] of Object.entries(patch) as Array<[keyof AgentConfigPatch | string, unknown]>) {
		if (value === undefined) continue;
		if (key === "output" || key === "outputFrom") {
			throw new TypeError(`agent field ${key} is removed; declare artifact: instead`);
		}
		if (value === false) {
			// Clear the field. Required fields can't be cleared.
			if (key === "name" || key === "description" || key === "systemPrompt") continue;
			(out as any)[key] = undefined;
			continue;
		}
		if (key === "maxDurationMs" || key === "windDownGraceMs") {
			const normalized = normalizeTimeoutMs(value);
			if (normalized !== undefined) (out as any)[key] = normalized;
			continue;
		}
		(out as any)[key] = value;
	}
	return out;
}

/**
 * Serialize an `AgentConfig` to a `.md` file body (frontmatter +
 * blank line + system prompt). Round-trips through `parseFrontmatter`
 * losslessly for every field the parser recognises.
 *
 * Always emits JSON-array form for list-valued fields (a canonical YAML
 * representation) so re-parsing is lossless.
 */
function serializeAgentFrontmatter(agent: AgentConfig): string {
	const legacy = agent as unknown as Record<string, unknown>;
	for (const field of ["output", "outputFrom"]) {
		if (legacy[field] !== undefined) throw new TypeError(`agent field ${field} is removed; declare artifact: instead`);
	}
	const lines: string[] = ["---"];
	for (const field of FIELD_ORDER) {
		const rendered = renderField(field, (agent as AgentConfig & { artifact?: string | false })[field]);
		if (rendered !== null) lines.push(rendered);
	}
	// Pass through MCP direct tools by re-merging into the `tools:` line so
	// the parser's `splitToolList` reverses cleanly. We don't add a separate
	// frontmatter key.
	const toolsLine = mergeMcpIntoToolsLine(agent);
	if (toolsLine !== null) {
		// Replace any existing `tools:` line we emitted.
		const idx = lines.findIndex((l) => l.startsWith("tools:"));
		if (idx >= 0) lines[idx] = toolsLine;
		else lines.push(toolsLine);
	}
	lines.push("---");
	return lines.join("\n");
}

export function serializeAgent(agent: AgentConfig): string {
	return `${serializeAgentFrontmatter(agent)}\n\n${agent.systemPrompt.trim()}\n`;
}

/**
 * Serialize canonical frontmatter while retaining an already parsed file's
 * body suffix verbatim. The suffix starts immediately after the closing
 * frontmatter delimiter, so leading/trailing whitespace in the system prompt
 * is not normalized.
 */
export function serializeAgentWithBody(agent: AgentConfig, bodySuffix: string): string {
	return `${serializeAgentFrontmatter(agent)}${bodySuffix}`;
}

/**
 * Merge `mcpDirectTools` back into the `tools:` line as `mcp:<name>`
 * entries. Returns `null` if the agent has neither tools nor MCP tools.
 */
const PI_DELEGATE_SELECTOR_PREFIX = "ext:@caair/pi-delegate:";

/**
 * Canonicalize only pi-delegate's own delegate-family spellings. The
 * `pi-delegate` extension segment is an input alias; foreign `ext:` selectors
 * are preserved and remain subject to runtime owner checks.
 */
export function canonicalizeDelegateToolSelector(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return raw;
	const lower = trimmed.toLowerCase();
	const canonicalizeTool = (tool: string): string | undefined => {
		const normalized = tool.toLowerCase();
		if (normalized === "delegate") return "delegate";
		const grant = parseControlToolGrant(normalized);
		if (!grant || grant.actions?.length === 0 || grant.actions?.includes("recover")) return undefined;
		return grant.actions === undefined ? grant.tool : `${grant.tool}:${grant.actions[0]}`;
	};

	if (lower.startsWith("ext:")) {
		const parsed = parseSelectorToolGrant(trimmed);
		if (!("error" in parsed) && parsed.kind === "extension") {
			const owner = parsed.owner.toLowerCase();
			if (owner === "pi-delegate" || isPiDelegatePackageIdentifier(owner)) {
				const authoredTool = parsed.tool && parsed.action
					? `${parsed.tool}:${parsed.action}`
					: parsed.tool;
				const tool = authoredTool ? canonicalizeTool(authoredTool) : undefined;
				if (tool) return `${PI_DELEGATE_SELECTOR_PREFIX}${tool}`;
			}
		}
		return raw;
	}

	const tool = canonicalizeTool(trimmed);
	return tool ? `${PI_DELEGATE_SELECTOR_PREFIX}${tool}` : raw;
}

export function canonicalizeAgentToolEntries(tools: readonly string[] | undefined): string[] | undefined {
	return tools?.map(canonicalizeDelegateToolSelector);
}

function mergeMcpIntoToolsLine(agent: AgentConfig): string | null {
	const tools = canonicalizeAgentToolEntries(agent.tools) ?? [];
	const mcp = (agent.mcpDirectTools ?? []).map((n) => `mcp:${n}`);
	const all = [...tools, ...mcp];
	if (all.length === 0) return null;
	return `tools: ${JSON.stringify(all)}`;
}

function isStringMap(value: unknown): value is Record<string, string | null> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string" || entry === null)
	);
}

/**
 * Render a single frontmatter line. Returns `null` when the value is
 * absent / default (so we skip the line and keep output minimal).
 */
function renderField(name: string, value: unknown): string | null {
	if (value === undefined || value === null) return null;
	switch (name) {
		case "name":
		case "description":
			return `${name}: ${quoteIfNeeded(String(value))}`;
		case "model":
		case "env":
		case "thinking":
		case "thinkingMin":
		case "thinkingMax":
		case "systemPromptMode":
		case "stopConditionHint":
		case "collapseMode":
		case "summaryModel":
		case "artifact":
			if (name === "env") {
				if (!isStringMap(value)) return null;
				const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
				return `env: ${JSON.stringify(Object.fromEntries(entries))}`;
			}
			if (typeof value !== "string" || value.length === 0) return null;
			return `${name}: ${quoteIfNeeded(value)}`;
		case "escalation": {
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			const escalation = value as NonNullable<AgentConfig["escalation"]>;
			const fields = Object.keys(escalation);
			if (
				fields.length === 1 &&
				fields[0] === "mode" &&
				(escalation.mode === "off" || escalation.mode === "local")
			) {
				return `escalation: ${escalation.mode}`;
			}
			const serialized = JSON.stringify(escalation);
			return serialized === undefined ? null : `escalation: ${serialized}`;
		}
		case "fallbackModels":
		case "skills":
		case "tools":
		case "extensions":
		case "extensionInclude":
		case "extensionExclude":
		case "defaultReads":
		case "nestedDelegateAgents":
			if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
				return null;
			}
			return `${name}: ${JSON.stringify(value)}`;
		case "inheritProjectContext":
		case "inheritSkills":
		case "parentTranscriptSearch":
		case "defaultProgress":
		case "interactive":
		case "allowNestedDelegate":
			// Skip false booleans for inherit*/default* (false is the parser's default)
			// but emit them when explicitly true.
			if (typeof value !== "boolean") return null;
			if (
				(name === "inheritProjectContext" || name === "inheritSkills") &&
				value === false
			) {
				return null;
			}
			return `${name}: ${value ? "true" : "false"}`;
		case "defaultMaxRounds":
			if (typeof value !== "number" || !Number.isFinite(value)) return null;
			return `${name}: ${value}`;
		case "maxDurationMs":
		case "windDownGraceMs": {
			const normalized = normalizeTimeoutMs(value);
			return normalized === undefined ? null : `${name}: ${normalized}`;
		}
		case "maxSubagentDepth": {
			if (typeof value !== "number") return null;
			const validated = validateMaxSubagentDepth(value);
			return `${name}: ${Math.min(validated, HARD_MAX_DEPTH)}`;
		}
		default:
			// Unknown fields are skipped. extraFields are not round-tripped:
			// we deliberately don't preserve them so a `update` doesn't
			// resurrect arbitrary keys the user may have removed.
			return null;
	}
}

/**
 * Quote a YAML scalar only when it needs it: contains commas (would be
 * interpreted as a list), starts with a YAML reserved character, or
 * contains a literal `:` (would be parsed as nested key:value).
 *
 * Conservative — we don't quote alphanumeric strings, paths, or simple
 * identifiers, matching the style of hand-written agent files.
 */
export function quoteIfNeeded(s: string): string {
	if (s.length === 0) return '""';
	// Always quote if leading/trailing whitespace.
	if (s !== s.trim()) return JSON.stringify(s);
	// Special chars that confuse YAML.
	if (/[\n"]/.test(s)) return JSON.stringify(s);
	// Tokens that look like YAML reserved scalars.
	if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return JSON.stringify(s);
	// Starts with a special marker or a YAML collection/sequence indicator.
	if (/^[-!&*?|>%@`#[{]/.test(s)) return JSON.stringify(s);
	// Contains a list-separating comma OR ANY colon. Issue #10: previously
	// only `/:\s/` (colon-then-space) was quoted, so a value like `evil:key`
	// survived unquoted — fine for our forgiving line parser, but a stricter
	// YAML parser reads `evil:key` differently, breaking the lossless
	// round-trip guarantee. Quote on every colon (the doc comment above
	// always promised this).
	if (s.includes(",") || s.includes(":")) return JSON.stringify(s);
	// Pure number — quote so the parser keeps it as a string.
	if (/^-?\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
	return s;
}
