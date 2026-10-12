import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type PortableToolName, type ToolReference } from "../definition.ts";
import { joinFrontmatter, splitFrontmatter } from "../frontmatter.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/*
 * Claude Code mapping (https://code.claude.com/docs/en/sub-agents):
 * | Canonical | Claude Code | Conversion |
 * | tools / disallowedTools | tools / disallowedTools | Claude aliases are used; coarse portable aliases may weaken. |
 * | model | model | One model is exact; fallback models are weakened to the first. |
 * | effort.default | effort | low through max are supported; bounds and lower levels are dropped. |
 * | invocation | — | Dropped; Claude has no two-flag invocation control. |
 * | limits.maxTurns | maxTurns | Exact. timeoutMinutes is dropped. |
 * | workspace.isolation | isolation: worktree | worktree is exact; ephemeral weakens to a persistent worktree. |
 * | context.project/user | omitClaudeMd | Exact only when both are disabled together. |
 * | skills | skills | Name-only required skills are exact; source/version/optional metadata is weakened. |
 * | services | — | Dropped. |
 */

type Fields = Record<string, unknown>;

const CLAUDE_TOOL: Readonly<Record<PortableToolName, string>> = {
	execute: "Bash",
	read: "Read",
	edit: "Edit",
	search: "Grep",
	agent: "Agent",
	web: "WebFetch",
	todo: "TodoWrite",
};

const EXACT_CLAUDE_TOOLS = new Set([
	"Agent",
	"Bash",
	"Edit",
	"Glob",
	"Grep",
	"MultiEdit",
	"NotebookEdit",
	"NotebookRead",
	"Read",
	"Task",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
	"Write",
]);

function isRecord(value: unknown): value is Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parserFailure(source: string): ImportResult {
	return { ok: false, diagnostics: parseDefinition(source).diagnostics };
}

function importClaudeCode(source: string, options: ImportOptions): ImportResult {
	const split = splitFrontmatter(source);
	if (!split.ok) return parserFailure(source);
	let foreign: unknown;
	try {
		foreign = parse(split.frontmatter);
	} catch {
		return parserFailure(source);
	}
	if (!isRecord(foreign)) return parserFailure(source);

	const canonical: Fields = {};
	for (const key of ["name", "description", "tools", "disallowedTools", "model", "skills"] as const) {
		if (Object.hasOwn(foreign, key)) canonical[key] = foreign[key];
	}
	if (Object.hasOwn(foreign, "effort")) canonical.effort = foreign.effort;
	if (Object.hasOwn(foreign, "maxTurns")) canonical.limits = { maxTurns: foreign.maxTurns };
	if (Object.hasOwn(foreign, "isolation")) canonical.workspace = { isolation: foreign.isolation };
	if (foreign.omitClaudeMd === true) canonical.context = { project: false, user: false };

	const mapped = new Set([
		"name",
		"description",
		"tools",
		"disallowedTools",
		"model",
		"skills",
		"effort",
		"maxTurns",
		"isolation",
		"omitClaudeMd",
	]);
	const runtime: Fields = {};
	const entries: LoweringEntry[] = [];
	for (const [key, value] of Object.entries(foreign)) {
		if (mapped.has(key)) continue;
		runtime[key] = value;
		entries.push({
			path: key,
			action: "unmapped",
			reason: `Claude Code field "${key}" has no canonical mapping.`,
		});
	}
	if (Object.keys(runtime).length > 0) canonical.runtimes = { "claude-code": runtime };

	const parsed = parseDefinition(
		joinFrontmatter(canonical, split.body),
		options.file === undefined ? {} : { file: options.file },
	);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	return {
		ok: true,
		definition: parsed.definition,
		diagnostics: parsed.diagnostics,
		report: { target: "claude-code", direction: "import", entries },
	};
}

function claudeTool(tool: ToolReference): { name: string; changed: boolean } {
	if (tool.namespace === "mcp" && tool.name.startsWith("mcp:")) {
		const [server, target] = tool.name.slice(4).split("/", 2);
		if (server !== undefined && target !== undefined) return { name: `mcp__${server}__${target}`, changed: true };
	}
	if (EXACT_CLAUDE_TOOLS.has(tool.name)) return { name: tool.name, changed: false };
	if (tool.portable !== null) return { name: CLAUDE_TOOL[tool.portable], changed: true };
	return { name: tool.name, changed: false };
}

function exportClaudeCode(definition: AgentDefinition) {
	const fields: Fields = { name: definition.name, description: definition.description };
	const entries: LoweringEntry[] = [];
	const dropped = (path: string, reason: string): void => {
		entries.push({ path, action: "dropped", reason });
	};
	const weakened = (path: string, result: string, reason: string): void => {
		entries.push({ path, action: "weakened", result, reason });
	};

	if (definition.tools !== "inherit") {
		const converted = definition.tools.map((tool) => claudeTool(tool));
		fields.tools = converted.map(({ name }) => name);
		if (converted.some(({ changed }) => changed))
			weakened("tools", "Claude Code tool names", "Claude Code cannot preserve every canonical tool spelling.");
	}
	if (definition.disallowedTools.length > 0) {
		const converted = definition.disallowedTools.map((tool) => claudeTool(tool));
		fields.disallowedTools = converted.map(({ name }) => name);
		if (converted.some(({ changed }) => changed))
			weakened(
				"disallowedTools",
				"Claude Code tool names",
				"Claude Code cannot preserve every canonical tool spelling.",
			);
	}

	if (!(definition.model.length === 1 && definition.model[0] === "inherit")) fields.model = definition.model[0];
	if (definition.model.length > 1)
		weakened("model", String(definition.model[0]), "Claude Code accepts one model and cannot preserve fallbacks.");
	if (definition.effort.default !== null) {
		if (["low", "medium", "high", "xhigh", "max"].includes(definition.effort.default))
			fields.effort = definition.effort.default;
		else dropped("effort.default", "Claude Code does not support off or minimal effort for subagents.");
	}
	if (definition.effort.min !== null) dropped("effort.min", "Claude Code has no per-agent minimum effort.");
	if (definition.effort.max !== null) dropped("effort.max", "Claude Code has no per-agent maximum effort.");

	if (!definition.context.project || !definition.context.user) {
		fields.omitClaudeMd = true;
		if (definition.context.project) weakened("context.project", "false", "omitClaudeMd also disables project context.");
		if (definition.context.user) weakened("context.user", "false", "omitClaudeMd also disables user context.");
	}
	if (!definition.context.skills)
		dropped("context.skills", "Claude Code does not disable inherited skill discovery per agent.");
	if (definition.context.files.length > 0)
		dropped("context.files", "Claude Code agent files have no context file list.");

	if (definition.skills.length > 0) {
		fields.skills = definition.skills.map(({ name }) => name);
		if (definition.skills.some(({ source, version, required }) => source !== null || version !== null || !required))
			weakened("skills", "skill names", "Claude Code cannot preserve skill source, version, or optional status.");
	}
	if (definition.limits.maxTurns !== null) fields.maxTurns = definition.limits.maxTurns;
	if (definition.workspace.isolation === "worktree") fields.isolation = "worktree";
	else if (definition.workspace.isolation === "ephemeral") {
		fields.isolation = "worktree";
		weakened(
			"workspace.isolation",
			"isolation: worktree",
			"Claude Code worktrees keep changes instead of discarding them after the run.",
		);
	}

	if (definition.version !== null) dropped("version", "Claude Code agent files have no version field.");
	if (definition.instructions.mode !== "replace")
		dropped("instructions.mode", "Claude Code uses the Markdown body as the complete subagent prompt.");
	if (definition.instructions.include.length > 0)
		dropped("instructions.include", "Claude Code agent files have no instruction include field.");
	if (definition.agents.length > 0) dropped("agents", "Claude Code has no per-subagent agent allowlist field.");
	if (definition.services.length > 0) dropped("services", "Claude Code agent files have no service requirement field.");
	if (definition.requires.length > 0)
		dropped("requires", "Claude Code agent files have no environment requirement field.");
	if (!definition.invocation.model || !definition.invocation.user)
		dropped("invocation", "Claude Code agent files do not expose both canonical invocation controls.");
	if (definition.limits.timeoutMinutes !== null)
		dropped("limits.timeoutMinutes", "Claude Code agent files have no timeout in minutes.");
	if (definition.result.schema !== null || definition.result.artifacts.length > 0)
		dropped("result", "Claude Code agent files have no result contract.");
	if (definition.license !== null) dropped("license", "Claude Code agent files have no license field.");
	if (Object.keys(definition.metadata).length > 0) dropped("metadata", "Claude Code agent files have no metadata map.");

	for (const [runtime, values] of Object.entries(definition.runtimes)) {
		if (runtime !== "claude-code") {
			dropped(`runtimes.${runtime}`, "Claude Code cannot preserve another runtime's options.");
			continue;
		}
		for (const [key, value] of Object.entries(values)) {
			if (key === "required") {
				if (value === true) dropped("runtimes.claude-code.required", "Claude Code has no required-runtime marker.");
			} else fields[key] = value;
		}
	}

	return {
		files: [
			{ path: `.claude/agents/${definition.name}.md`, text: joinFrontmatter(fields, definition.instructions.text) },
		],
		report: { target: "claude-code", direction: "export", entries } as const,
	};
}

export const claudeCodeFormat: AgentFormat = {
	name: "claude-code",
	import: importClaudeCode,
	export: exportClaudeCode,
};
