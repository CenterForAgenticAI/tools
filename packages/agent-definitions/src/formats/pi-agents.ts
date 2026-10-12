import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type SkillReference, type ToolReference } from "../definition.ts";
import { joinFrontmatter, splitFrontmatter } from "../frontmatter.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/**
 * pi-agents mapping, based on https://github.com/mavam/pi-agents/blob/main/docs/profiles.md
 *
 * | Canonical field | pi-agents profile Markdown |
 * | --- | --- |
 * | name, description | name, description |
 * | instructions.text | Markdown body (append semantics) |
 * | tools | tools, limited to Pi built-ins |
 * | model | model (first candidate only) |
 * | effort.default | thinking |
 * | skills | skills (names only) |
 * | agents | delegate (named lists weaken to an unrestricted boolean) |
 * | invocation, limits, workspace.isolation, context | no direct mapping |
 * | services, disallowedTools | no direct mapping |
 *
 * Project files live at `.pi/agents/<name>.md`. Export intentionally writes
 * only `name`, `description`, `model`, `thinking`, `skills`, `tools`, and `delegate`.
 */

const TARGET = "pi-agents";
const KNOWN_KEYS = new Set(["name", "description", "model", "thinking", "skills", "tools", "delegate"]);
const COLLISION_PATHS: Readonly<Record<string, string>> = {
	name: "name",
	description: "description",
	model: "model",
	thinking: "effort.default",
	skills: "skills",
	tools: "tools",
	delegate: "agents",
};
const PI_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const PORTABLE_TO_PI: Readonly<Record<string, string>> = {
	execute: "bash",
	read: "read",
	edit: "edit",
	search: "grep",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failedSource(source: string, options: ImportOptions): ImportResult {
	const parsed = parseDefinition(source, options.file === undefined ? {} : { file: options.file });
	return { ok: false, diagnostics: parsed.diagnostics };
}

function safeName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gu, "-")
			.replace(/^[-_]+|[-_]+$/gu, "") || "agent"
	);
}

function importedTools(value: unknown, runtime: Record<string, unknown>, reports: LoweringEntry[]): unknown {
	if (!Array.isArray(value)) return value;
	if (value.length === 0) {
		runtime.tools = [];
		reports.push({
			path: "tools",
			action: "unmapped",
			reason: "An empty pi-agents tool list has no valid canonical equivalent.",
		});
		return undefined;
	}
	return value.map((tool) => (typeof tool === "string" && !PI_TOOLS.has(tool) ? `pi-agents:${tool}` : tool));
}

function entry(path: string, action: "dropped" | "weakened", reason: string): LoweringEntry {
	return { path, action, reason };
}

function skillMetadataIsLost(skills: readonly SkillReference[]): boolean {
	return skills.some(({ source, version, required }) => source !== null || version !== null || !required);
}

function toolsAreChanged(tools: readonly ToolReference[]): boolean {
	return tools.some((tool) => !PI_TOOLS.has(tool.name));
}

function losses(definition: AgentDefinition): LoweringEntry[] {
	const entries: LoweringEntry[] = [];
	if (definition.version !== null)
		entries.push(entry("version", "dropped", "pi-agents profiles have no version field."));
	if (definition.instructions.mode !== "append")
		entries.push(
			entry("instructions.mode", "weakened", "pi-agents always appends the Markdown body to its system prompt."),
		);
	if (definition.instructions.include.length > 0)
		entries.push(entry("instructions.include", "dropped", "pi-agents profiles have no instruction includes."));
	if (definition.model.length > 1)
		entries.push(entry("model", "weakened", "pi-agents accepts one model, so only the first candidate is written."));
	if (definition.effort.min !== null)
		entries.push(entry("effort.min", "dropped", "pi-agents has one thinking level and no minimum."));
	if (definition.effort.max !== null)
		entries.push(entry("effort.max", "dropped", "pi-agents has one thinking level and no maximum."));
	if (!definition.context.project)
		entries.push(entry("context.project", "dropped", "pi-agents profiles cannot disable project context."));
	if (!definition.context.user)
		entries.push(entry("context.user", "dropped", "pi-agents profiles cannot disable user context."));
	if (definition.context.files.length > 0)
		entries.push(entry("context.files", "dropped", "pi-agents profiles have no context-file list."));
	if (definition.skills.length > 0 && definition.context.skills)
		entries.push(
			entry("context.skills", "weakened", "A named pi-agents skill list replaces the ambient skill catalog."),
		);
	if (definition.tools !== "inherit" && toolsAreChanged(definition.tools))
		entries.push(
			entry(
				"tools",
				"weakened",
				"pi-agents supports only Pi built-in tools; unsupported tools are omitted or translated.",
			),
		);
	if (definition.disallowedTools.length > 0)
		entries.push(entry("disallowedTools", "dropped", "pi-agents profiles have no tool denylist."));
	if (definition.agents.length > 0 && !(definition.agents.length === 1 && definition.agents[0] === "*"))
		entries.push(
			entry("agents", "weakened", "pi-agents delegate enables all helper agents and cannot retain a named allowlist."),
		);
	if (skillMetadataIsLost(definition.skills))
		entries.push(
			entry("skills", "weakened", "pi-agents keeps skill names but not source, version, or required metadata."),
		);
	if (definition.services.length > 0)
		entries.push(entry("services", "dropped", "pi-agents profiles have no services field."));
	if (definition.requires.length > 0)
		entries.push(entry("requires", "dropped", "pi-agents profiles have no requirements field."));
	if (definition.workspace.isolation !== "shared")
		entries.push(entry("workspace.isolation", "dropped", "pi-agents profiles do not select workspace isolation."));
	if (!definition.invocation.model)
		entries.push(entry("invocation.model", "dropped", "pi-agents profiles cannot disable model invocation."));
	if (!definition.invocation.user)
		entries.push(entry("invocation.user", "dropped", "pi-agents profiles cannot disable user invocation."));
	if (definition.limits.maxTurns !== null)
		entries.push(entry("limits.maxTurns", "dropped", "pi-agents profiles have no turn limit."));
	if (definition.limits.timeoutMinutes !== null)
		entries.push(entry("limits.timeoutMinutes", "dropped", "pi-agents profiles have no timeout."));
	if (definition.result.schema !== null)
		entries.push(entry("result.schema", "dropped", "pi-agents profiles have no result schema."));
	if (definition.result.artifacts.length > 0)
		entries.push(entry("result.artifacts", "dropped", "pi-agents profiles have no artifact declarations."));
	for (const runtime of Object.keys(definition.runtimes)) {
		if (runtime !== TARGET)
			entries.push(
				entry(`runtimes.${runtime}`, "dropped", "A pi-agents profile cannot carry another runtime's options."),
			);
	}
	for (const [key, value] of Object.entries(definition.runtimes[TARGET] ?? {})) {
		if (key === "required") {
			if (value === true)
				entries.push(
					entry("runtimes.pi-agents.required", "dropped", "pi-agents has no portable required-runtime flag."),
				);
		} else if (!KNOWN_KEYS.has(key)) {
			entries.push(
				entry(`runtimes.pi-agents.${key}`, "dropped", "pi-agents rejects keys outside its seven-field profile schema."),
			);
		}
		const path = COLLISION_PATHS[key];
		if (path !== undefined)
			entries.push(
				entry(path, "weakened", `The explicit pi-agents runtime key "${key}" overrides the canonical value.`),
			);
	}
	if (definition.license !== null)
		entries.push(entry("license", "dropped", "pi-agents profiles have no license field."));
	if (Object.keys(definition.metadata).length > 0)
		entries.push(entry("metadata", "dropped", "pi-agents profiles have no metadata map."));
	return entries;
}

function importPiAgents(source: string, options: ImportOptions): ImportResult {
	const split = splitFrontmatter(source);
	if (!split.ok) return failedSource(source, options);
	let value: unknown;
	try {
		value = parse(split.frontmatter);
	} catch {
		return failedSource(source, options);
	}
	if (!isRecord(value)) return failedSource(source, options);
	const runtime: Record<string, unknown> = {};
	const reportEntries: LoweringEntry[] = [];
	for (const [key, native] of Object.entries(value)) {
		if (KNOWN_KEYS.has(key)) continue;
		runtime[key] = native;
		reportEntries.push({ path: key, action: "unmapped", reason: `pi-agents key "${key}" has no canonical mapping.` });
	}
	const fields: Record<string, unknown> = {
		name: value.name,
		description: value.description,
		model: value.model === undefined || typeof value.model === "string" ? value.model : { invalid: value.model },
		effort: value.thinking === undefined ? undefined : { default: value.thinking },
		instructions: { mode: "append" },
		context: value.skills === undefined ? undefined : { skills: false },
		agents:
			value.delegate === undefined
				? undefined
				: value.delegate === true
					? ["*"]
					: value.delegate === false
						? []
						: { invalid: value.delegate },
		skills: value.skills,
		tools: value.tools === undefined ? undefined : importedTools(value.tools, runtime, reportEntries),
		runtimes: Object.keys(runtime).length === 0 ? undefined : { [TARGET]: runtime },
	};
	const parsed = parseDefinition(
		joinFrontmatter(fields, split.body),
		options.file === undefined ? {} : { file: options.file },
	);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	return {
		ok: true,
		definition: parsed.definition,
		diagnostics: parsed.diagnostics,
		report: { target: TARGET, direction: "import", entries: reportEntries },
	};
}

function exportedTools(tools: readonly ToolReference[]): string[] {
	const result: string[] = [];
	for (const tool of tools) {
		if (PI_TOOLS.has(tool.name)) result.push(tool.name);
		else if (tool.portable !== null && PORTABLE_TO_PI[tool.portable] !== undefined)
			result.push(PORTABLE_TO_PI[tool.portable]!);
	}
	return result;
}

function exportPiAgents(definition: AgentDefinition) {
	const fields: Record<string, unknown> = {
		name: definition.name,
		description: definition.description,
		model: definition.model.length === 1 && definition.model[0] === "inherit" ? undefined : definition.model[0],
		thinking: definition.effort.default ?? undefined,
		skills:
			definition.skills.length > 0
				? definition.skills.map(({ name }) => name)
				: definition.context.skills
					? undefined
					: [],
		tools: definition.tools === "inherit" ? undefined : exportedTools(definition.tools),
		delegate: definition.agents.length === 0 ? undefined : true,
	};
	for (const [key, value] of Object.entries(definition.runtimes[TARGET] ?? {})) {
		if (key !== "required" && KNOWN_KEYS.has(key)) fields[key] = value;
	}
	return {
		files: [
			{
				path: `.pi/agents/${safeName(definition.name)}.md`,
				text: joinFrontmatter(fields, definition.instructions.text),
			},
		],
		report: { target: TARGET, direction: "export" as const, entries: losses(definition) },
	};
}

export const piAgentsFormat: AgentFormat = { name: TARGET, import: importPiAgents, export: exportPiAgents };
