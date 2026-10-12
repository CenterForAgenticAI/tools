import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type ToolReference } from "../definition.ts";
import { joinFrontmatter, splitFrontmatter } from "../frontmatter.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/**
 * Gemini CLI mapping, based on https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md
 *
 * | Canonical field | Gemini CLI subagent Markdown |
 * | --- | --- |
 * | name, description, instructions.text | name, description, Markdown body |
 * | tools | tools (portable names translated to Gemini tool names) |
 * | model | model (first candidate only) |
 * | limits.maxTurns, limits.timeoutMinutes | max_turns, timeout_mins |
 * | effort, invocation, workspace.isolation, context | no direct mapping |
 * | skills, services, disallowedTools | no direct mapping |
 *
 * Project files live at `.gemini/agents/<name>.md`. Other native keys are
 * retained under `runtimes.gemini-cli` and written back on export.
 */

const TARGET = "gemini-cli";
const KNOWN_KEYS = new Set(["name", "description", "tools", "model", "max_turns", "timeout_mins"]);
const COLLISION_PATHS: Readonly<Record<string, string>> = {
	name: "name",
	description: "description",
	tools: "tools",
	model: "model",
	max_turns: "limits.maxTurns",
	timeout_mins: "limits.timeoutMinutes",
};
const IMPORT_TOOLS: Readonly<Record<string, string>> = {
	run_shell_command: "execute",
	read_file: "read",
	read_many_files: "read",
	write_file: "edit",
	replace: "edit",
	grep_search: "search",
	glob: "search",
	list_directory: "search",
	google_web_search: "web",
	web_fetch: "web",
};
const EXPORT_TOOLS: Readonly<Record<string, string>> = {
	execute: "run_shell_command",
	read: "read_file",
	edit: "write_file",
	search: "grep_search",
	web: "google_web_search",
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
			reason: "An empty Gemini tool list has no valid canonical equivalent.",
		});
		return undefined;
	}
	return value.map((tool) => {
		if (typeof tool !== "string") return tool;
		return IMPORT_TOOLS[tool] ?? `gemini-cli:${tool}`;
	});
}

function entry(path: string, action: "dropped" | "weakened", reason: string): LoweringEntry {
	return { path, action, reason };
}

function losses(definition: AgentDefinition): LoweringEntry[] {
	const entries: LoweringEntry[] = [];
	if (definition.version !== null)
		entries.push(entry("version", "dropped", "Gemini CLI subagents have no version field."));
	if (definition.instructions.mode !== "replace")
		entries.push(
			entry(
				"instructions.mode",
				"weakened",
				"Gemini CLI uses the body as a system prompt without an append-mode field.",
			),
		);
	if (definition.instructions.include.length > 0)
		entries.push(entry("instructions.include", "dropped", "Gemini CLI subagents have no instruction includes."));
	if (definition.model.length > 1)
		entries.push(entry("model", "weakened", "Gemini CLI accepts one model, so only the first candidate is written."));
	if (definition.effort.default !== null)
		entries.push(entry("effort.default", "dropped", "Gemini CLI subagent files have no reasoning-effort field."));
	if (definition.effort.min !== null)
		entries.push(entry("effort.min", "dropped", "Gemini CLI subagent files have no minimum effort."));
	if (definition.effort.max !== null)
		entries.push(entry("effort.max", "dropped", "Gemini CLI subagent files have no maximum effort."));
	if (!definition.context.project)
		entries.push(entry("context.project", "dropped", "Gemini CLI subagent files cannot disable project context."));
	if (!definition.context.user)
		entries.push(entry("context.user", "dropped", "Gemini CLI subagent files cannot disable user context."));
	if (!definition.context.skills)
		entries.push(entry("context.skills", "dropped", "Gemini CLI subagent files cannot disable inherited skills."));
	if (definition.context.files.length > 0)
		entries.push(entry("context.files", "dropped", "Gemini CLI subagent files have no context-file list."));
	if (definition.tools !== "inherit")
		entries.push(
			entry(
				"tools",
				"weakened",
				"Portable tool categories are translated to Gemini CLI tool names and unsupported categories are omitted.",
			),
		);
	if (definition.disallowedTools.length > 0)
		entries.push(
			entry("disallowedTools", "dropped", "Gemini CLI uses external policies rather than a subagent denylist."),
		);
	if (definition.agents.length > 0)
		entries.push(entry("agents", "dropped", "Gemini CLI prevents subagents from invoking other subagents."));
	if (definition.skills.length > 0)
		entries.push(entry("skills", "dropped", "Gemini CLI subagent files have no skills field."));
	if (definition.services.length > 0)
		entries.push(entry("services", "dropped", "Gemini CLI subagent files have no portable services field."));
	if (definition.requires.length > 0)
		entries.push(entry("requires", "dropped", "Gemini CLI subagent files have no portable requirements field."));
	if (definition.workspace.isolation !== "shared")
		entries.push(entry("workspace.isolation", "dropped", "Gemini CLI isolates context, not workspace files."));
	if (!definition.invocation.model)
		entries.push(entry("invocation.model", "dropped", "Gemini CLI subagent files cannot disable model invocation."));
	if (!definition.invocation.user)
		entries.push(entry("invocation.user", "dropped", "Gemini CLI subagent files cannot disable user invocation."));
	if (definition.result.schema !== null)
		entries.push(entry("result.schema", "dropped", "Gemini CLI subagent files have no result schema."));
	if (definition.result.artifacts.length > 0)
		entries.push(entry("result.artifacts", "dropped", "Gemini CLI subagent files have no artifact declarations."));
	for (const runtime of Object.keys(definition.runtimes)) {
		if (runtime !== TARGET)
			entries.push(
				entry(`runtimes.${runtime}`, "dropped", "A Gemini CLI file cannot carry another runtime's options."),
			);
	}
	if (definition.runtimes[TARGET]?.required === true)
		entries.push(entry("runtimes.gemini-cli.required", "dropped", "Gemini CLI has no portable required-runtime flag."));
	for (const key of Object.keys(definition.runtimes[TARGET] ?? {})) {
		const path = COLLISION_PATHS[key];
		if (path !== undefined)
			entries.push(
				entry(path, "weakened", `The explicit Gemini CLI runtime key "${key}" overrides the canonical value.`),
			);
	}
	if (definition.license !== null)
		entries.push(entry("license", "dropped", "Gemini CLI subagent files have no license field."));
	if (Object.keys(definition.metadata).length > 0)
		entries.push(entry("metadata", "dropped", "Gemini CLI subagent files have no portable metadata map."));
	return entries;
}

function importGemini(source: string, options: ImportOptions): ImportResult {
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
		reportEntries.push({ path: key, action: "unmapped", reason: `Gemini CLI key "${key}" has no canonical mapping.` });
	}
	const fields: Record<string, unknown> = {
		name: value.name,
		description: value.description,
		model: value.model,
		tools: value.tools === undefined ? undefined : importedTools(value.tools, runtime, reportEntries),
		limits:
			value.max_turns === undefined && value.timeout_mins === undefined
				? undefined
				: { maxTurns: value.max_turns, timeoutMinutes: value.timeout_mins },
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
		if (tool.namespace === TARGET && tool.name.startsWith(`${TARGET}:`))
			result.push(tool.name.slice(TARGET.length + 1));
		else if (tool.portable !== null && EXPORT_TOOLS[tool.portable] !== undefined)
			result.push(EXPORT_TOOLS[tool.portable]!);
	}
	return result;
}

function exportGemini(definition: AgentDefinition) {
	const fields: Record<string, unknown> = {
		name: definition.name,
		description: definition.description,
		tools: definition.tools === "inherit" ? undefined : exportedTools(definition.tools),
		model: definition.model.length === 1 && definition.model[0] === "inherit" ? undefined : definition.model[0],
		max_turns: definition.limits.maxTurns ?? undefined,
		timeout_mins: definition.limits.timeoutMinutes ?? undefined,
	};
	for (const [key, value] of Object.entries(definition.runtimes[TARGET] ?? {})) {
		if (key !== "required") fields[key] = value;
	}
	return {
		files: [
			{
				path: `.gemini/agents/${safeName(definition.name)}.md`,
				text: joinFrontmatter(fields, definition.instructions.text),
			},
		],
		report: { target: TARGET, direction: "export" as const, entries: losses(definition) },
	};
}

export const geminiCliFormat: AgentFormat = { name: TARGET, import: importGemini, export: exportGemini };
