import { joinFrontmatter } from "../frontmatter.ts";
import { parseDefinition, type AgentDefinition, type Diagnostic } from "../definition.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/**
 * Codex mapping, based on https://developers.openai.com/codex/agent-configuration/subagents
 *
 * | Canonical field | Codex custom-agent TOML |
 * | --- | --- |
 * | name, description | name, description |
 * | instructions.text | developer_instructions |
 * | model | model (first candidate only) |
 * | effort.default | model_reasoning_effort |
 * | tools, invocation, limits, workspace.isolation, context | no direct mapping |
 * | skills, services, disallowedTools | no direct mapping |
 *
 * Project files live at `.codex/agents/<name>.toml`. Other native config keys
 * are retained under `runtimes.codex` and written back on export.
 */

const TARGET = "codex";
const KNOWN_KEYS = new Set(["name", "description", "developer_instructions", "model", "model_reasoning_effort"]);
const COLLISION_PATHS: Readonly<Record<string, string>> = {
	name: "name",
	description: "description",
	developer_instructions: "instructions.text",
	model: "model",
	model_reasoning_effort: "effort.default",
};

function invalidToml(line: number): ImportResult {
	const diagnostic: Diagnostic = {
		severity: "error",
		code: "invalid-toml",
		path: "",
		message: "The Codex custom-agent TOML is invalid.",
		line,
	};
	return { ok: false, diagnostics: [diagnostic] };
}

function splitValues(source: string): string[] {
	const values: string[] = [];
	let start = 0;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "[" || character === "{") depth += 1;
		else if (character === "]" || character === "}") depth -= 1;
		else if (character === "," && depth === 0) {
			values.push(source.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quoted || depth !== 0) throw new Error("unterminated value");
	values.push(source.slice(start).trim());
	return values;
}

function parseTomlValue(source: string): unknown {
	if (source.startsWith('"')) return JSON.parse(source) as unknown;
	if (source === "true") return true;
	if (source === "false") return false;
	if (/^[+-]?(?:\d+\.?\d*|\d*\.\d+)$/u.test(source)) return Number(source);
	if (source.startsWith("[") && source.endsWith("]")) {
		const inner = source.slice(1, -1).trim();
		return inner === "" ? [] : splitValues(inner).map(parseTomlValue);
	}
	if (source.startsWith("{") && source.endsWith("}")) {
		const object: Record<string, unknown> = {};
		const inner = source.slice(1, -1).trim();
		if (inner === "") return object;
		for (const entry of splitValues(inner)) {
			const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(entry);
			if (!match) throw new Error("invalid inline table");
			object[match[1]!] = parseTomlValue(match[2]!);
		}
		return object;
	}
	throw new Error("unsupported value");
}

function parseToml(source: string): { fields: Record<string, unknown> } | { line: number } {
	const fields: Record<string, unknown> = {};
	const lines = source.replace(/\r\n/gu, "\n").split("\n");
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u.exec(line);
		if (!match) return { line: index + 1 };
		try {
			fields[match[1]!] = parseTomlValue(match[2]!);
		} catch {
			return { line: index + 1 };
		}
	}
	return { fields };
}

function tomlValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	if (value !== null && typeof value === "object") {
		return `{ ${Object.entries(value)
			.map(([key, nested]) => `${key} = ${tomlValue(nested)}`)
			.join(", ")} }`;
	}
	return JSON.stringify(String(value));
}

function safeName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gu, "-")
			.replace(/^[-_]+|[-_]+$/gu, "") || "agent"
	);
}

function entry(path: string, action: "dropped" | "weakened", reason: string): LoweringEntry {
	return { path, action, reason };
}

function losses(definition: AgentDefinition): LoweringEntry[] {
	const entries: LoweringEntry[] = [];
	if (definition.version !== null)
		entries.push(entry("version", "dropped", "Codex custom agents have no version field."));
	if (definition.instructions.mode !== "replace")
		entries.push(
			entry("instructions.mode", "weakened", "Codex uses developer instructions without an append-mode field."),
		);
	if (definition.instructions.include.length > 0)
		entries.push(entry("instructions.include", "dropped", "Codex custom-agent files have no instruction includes."));
	if (definition.model.length > 1)
		entries.push(
			entry("model", "weakened", "Codex accepts one custom-agent model, so only the first candidate is written."),
		);
	if (definition.effort.min !== null)
		entries.push(entry("effort.min", "dropped", "Codex has one reasoning effort and no minimum."));
	if (definition.effort.max !== null)
		entries.push(entry("effort.max", "dropped", "Codex has one reasoning effort and no maximum."));
	if (!definition.context.project)
		entries.push(entry("context.project", "dropped", "The custom-agent file cannot disable project context."));
	if (!definition.context.user)
		entries.push(entry("context.user", "dropped", "The custom-agent file cannot disable user context."));
	if (!definition.context.skills)
		entries.push(
			entry("context.skills", "dropped", "The custom-agent file cannot disable inherited skills as a group."),
		);
	if (definition.context.files.length > 0)
		entries.push(entry("context.files", "dropped", "Codex custom-agent files have no context-file list."));
	if (definition.tools !== "inherit")
		entries.push(entry("tools", "dropped", "Codex custom-agent files have no portable tool allowlist."));
	if (definition.disallowedTools.length > 0)
		entries.push(entry("disallowedTools", "dropped", "Codex custom-agent files have no portable tool denylist."));
	if (definition.agents.length > 0)
		entries.push(entry("agents", "dropped", "Codex custom-agent files do not declare nested-agent names."));
	if (definition.skills.length > 0)
		entries.push(
			entry("skills", "dropped", "Codex skill configuration is not equivalent to portable required skills."),
		);
	if (definition.services.length > 0)
		entries.push(entry("services", "dropped", "Codex custom-agent files have no portable services field."));
	if (definition.requires.length > 0)
		entries.push(entry("requires", "dropped", "Codex custom-agent files have no portable requirements field."));
	if (definition.workspace.isolation !== "shared")
		entries.push(
			entry(
				"workspace.isolation",
				"dropped",
				"Codex sandbox modes do not create worktree or ephemeral workspace copies.",
			),
		);
	if (!definition.invocation.model)
		entries.push(entry("invocation.model", "dropped", "Codex custom-agent files cannot disable model invocation."));
	if (!definition.invocation.user)
		entries.push(entry("invocation.user", "dropped", "Codex custom-agent files cannot disable user invocation."));
	if (definition.limits.maxTurns !== null)
		entries.push(entry("limits.maxTurns", "dropped", "Codex custom-agent files have no per-agent turn limit."));
	if (definition.limits.timeoutMinutes !== null)
		entries.push(entry("limits.timeoutMinutes", "dropped", "Codex custom-agent files have no per-agent timeout."));
	if (definition.result.schema !== null)
		entries.push(entry("result.schema", "dropped", "Codex custom-agent files have no result schema."));
	if (definition.result.artifacts.length > 0)
		entries.push(
			entry("result.artifacts", "dropped", "Codex custom-agent files have no result artifact declarations."),
		);
	for (const runtime of Object.keys(definition.runtimes)) {
		if (runtime !== TARGET)
			entries.push(entry(`runtimes.${runtime}`, "dropped", "A Codex file cannot carry another runtime's options."));
	}
	if (definition.runtimes[TARGET]?.required === true)
		entries.push(entry("runtimes.codex.required", "dropped", "Codex has no portable required-runtime flag."));
	for (const key of Object.keys(definition.runtimes[TARGET] ?? {})) {
		const path = COLLISION_PATHS[key];
		if (path !== undefined)
			entries.push(entry(path, "weakened", `The explicit Codex runtime key "${key}" overrides the canonical value.`));
	}
	if (definition.license !== null)
		entries.push(entry("license", "dropped", "Codex custom-agent files have no license field."));
	if (Object.keys(definition.metadata).length > 0)
		entries.push(entry("metadata", "dropped", "Codex custom-agent files have no portable metadata map."));
	return entries;
}

function importCodex(source: string, options: ImportOptions): ImportResult {
	const parsedToml = parseToml(source);
	if ("line" in parsedToml) return invalidToml(parsedToml.line);
	const native = parsedToml.fields;
	const runtime: Record<string, unknown> = {};
	const reportEntries: LoweringEntry[] = [];
	for (const [key, value] of Object.entries(native)) {
		if (KNOWN_KEYS.has(key)) continue;
		runtime[key] = value;
		reportEntries.push({ path: key, action: "unmapped", reason: `Codex key "${key}" has no canonical mapping.` });
	}
	const fields: Record<string, unknown> = {
		name: native.name,
		description: native.description,
		model: native.model,
		effort: native.model_reasoning_effort === undefined ? undefined : { default: native.model_reasoning_effort },
		runtimes: Object.keys(runtime).length === 0 ? undefined : { codex: runtime },
	};
	const body = typeof native.developer_instructions === "string" ? native.developer_instructions : "";
	const parsed = parseDefinition(
		joinFrontmatter(fields, body),
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

function exportCodex(definition: AgentDefinition) {
	const fields: Record<string, unknown> = {
		name: definition.name,
		description: definition.description,
		developer_instructions: definition.instructions.text,
	};
	if (!(definition.model.length === 1 && definition.model[0] === "inherit")) fields.model = definition.model[0];
	if (definition.effort.default !== null) fields.model_reasoning_effort = definition.effort.default;
	for (const [key, value] of Object.entries(definition.runtimes[TARGET] ?? {})) {
		if (key !== "required") fields[key] = value;
	}
	const text = `${Object.entries(fields)
		.map(([key, value]) => `${key} = ${tomlValue(value)}`)
		.join("\n")}\n`;
	return {
		files: [{ path: `.codex/agents/${safeName(definition.name)}.toml`, text }],
		report: { target: TARGET, direction: "export" as const, entries: losses(definition) },
	};
}

export const codexFormat: AgentFormat = { name: TARGET, import: importCodex, export: exportCodex };
