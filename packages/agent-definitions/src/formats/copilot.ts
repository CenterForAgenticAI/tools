import { basename } from "node:path";
import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type ToolReference } from "../definition.ts";
import { joinFrontmatter, splitFrontmatter } from "../frontmatter.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/*
 * GitHub Copilot mapping (https://docs.github.com/en/copilot/reference/custom-agents-configuration):
 * | Canonical | Copilot | Conversion |
 * | tools | tools | Portable aliases are native; target-specific spellings are weakened. |
 * | disallowedTools | — | Dropped. |
 * | model | model | One model is exact; fallback models are weakened to the first. |
 * | effort | — | Dropped. |
 * | invocation.model | disable-model-invocation | Exact inverse. |
 * | invocation.user | user-invocable | Exact. |
 * | limits / workspace.isolation / context / skills / services | — | Dropped. |
 * | metadata | metadata | Exact string map. |
 */

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parserFailure(source: string): ImportResult {
	return { ok: false, diagnostics: parseDefinition(source).diagnostics };
}

function deriveName(file: string | undefined): string | undefined {
	if (file === undefined) return undefined;
	return basename(file)
		.replace(/\.agent\.md$/u, "")
		.replace(/\.md$/u, "");
}

function copilotToolInput(value: unknown): unknown {
	if (typeof value === "string") {
		const values = value.split(",").map((item) => item.trim());
		return values.length === 1 && values[0] === "*" ? "inherit" : values.map((item) => namespacedTool(item));
	}
	if (!Array.isArray(value)) return value;
	if (value.length === 1 && value[0] === "*") return "inherit";
	return value.map((item) => (typeof item === "string" ? namespacedTool(item) : item));
}

function namespacedTool(name: string): string {
	return name.includes("/") && !name.includes(":") ? `mcp:${name}` : name;
}

function importCopilot(source: string, options: ImportOptions): ImportResult {
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
	canonical.name = Object.hasOwn(foreign, "name") ? foreign.name : deriveName(options.file);
	for (const key of ["description", "model", "metadata"] as const) {
		if (Object.hasOwn(foreign, key)) canonical[key] = foreign[key];
	}
	if (Object.hasOwn(foreign, "tools")) {
		const tools = copilotToolInput(foreign.tools);
		if (!Array.isArray(tools) || tools.length > 0) canonical.tools = tools;
	}
	const invocation: Fields = {};
	if (typeof foreign["disable-model-invocation"] === "boolean") invocation.model = !foreign["disable-model-invocation"];
	else if (typeof foreign.infer === "boolean") invocation.model = foreign.infer;
	if (typeof foreign["user-invocable"] === "boolean") invocation.user = foreign["user-invocable"];
	if (Object.keys(invocation).length > 0) canonical.invocation = invocation;

	const mapped = new Set([
		"name",
		"description",
		"tools",
		"model",
		"metadata",
		"disable-model-invocation",
		"user-invocable",
		"infer",
	]);
	const runtime: Fields = {};
	const entries: LoweringEntry[] = [];
	if (Array.isArray(foreign.tools) && foreign.tools.length === 0) {
		runtime.tools = [];
		entries.push({
			path: "tools",
			action: "unmapped",
			reason: "Agent Definitions cannot represent an explicit empty tool set.",
		});
	}
	for (const [key, value] of Object.entries(foreign)) {
		if (mapped.has(key)) continue;
		runtime[key] = value;
		entries.push({
			path: key,
			action: "unmapped",
			reason: `GitHub Copilot field "${key}" has no canonical mapping.`,
		});
	}
	if (Object.keys(runtime).length > 0) canonical.runtimes = { copilot: runtime };

	const parsed = parseDefinition(
		joinFrontmatter(canonical, split.body),
		options.file === undefined ? {} : { file: options.file },
	);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	return {
		ok: true,
		definition: parsed.definition,
		diagnostics: parsed.diagnostics,
		report: { target: "copilot", direction: "import", entries },
	};
}

function copilotTool(tool: ToolReference): { name: string; changed: boolean } {
	if (tool.namespace === "mcp" && tool.name.startsWith("mcp:")) return { name: tool.name.slice(4), changed: true };
	if (tool.portable !== null) return { name: tool.portable, changed: tool.name !== tool.portable };
	return { name: tool.name, changed: false };
}

function exportCopilot(definition: AgentDefinition) {
	const fields: Fields = { name: definition.name, description: definition.description };
	const entries: LoweringEntry[] = [];
	const dropped = (path: string, reason: string): void => {
		entries.push({ path, action: "dropped", reason });
	};
	const weakened = (path: string, result: string, reason: string): void => {
		entries.push({ path, action: "weakened", result, reason });
	};

	if (definition.tools !== "inherit") {
		const converted = definition.tools.map((tool) => copilotTool(tool));
		fields.tools = converted.map(({ name }) => name);
		if (converted.some(({ changed }) => changed))
			weakened("tools", "portable Copilot aliases", "Copilot cannot preserve every canonical tool spelling.");
	}
	if (!(definition.model.length === 1 && definition.model[0] === "inherit")) fields.model = definition.model[0];
	if (definition.model.length > 1)
		weakened("model", String(definition.model[0]), "Copilot accepts one model and cannot preserve fallbacks.");
	if (!definition.invocation.model) fields["disable-model-invocation"] = true;
	if (!definition.invocation.user) fields["user-invocable"] = false;
	if (Object.keys(definition.metadata).length > 0) fields.metadata = definition.metadata;

	if (definition.version !== null) dropped("version", "Copilot agent profiles have no version field.");
	if (definition.instructions.mode !== "replace")
		dropped("instructions.mode", "Copilot uses the Markdown body as the complete agent prompt.");
	if (definition.instructions.include.length > 0)
		dropped("instructions.include", "Copilot agent profiles have no instruction include field.");
	if (Object.values(definition.effort).some((value) => value !== null))
		dropped("effort", "Copilot agent profiles do not configure reasoning effort.");
	if (
		!definition.context.project ||
		!definition.context.user ||
		!definition.context.skills ||
		definition.context.files.length > 0
	)
		dropped("context", "Copilot agent profiles cannot preserve canonical context controls.");
	if (definition.disallowedTools.length > 0)
		dropped("disallowedTools", "Copilot profiles have an allowlist but no tool denylist.");
	if (definition.agents.length > 0) dropped("agents", "Copilot agent profiles have no agent allowlist field.");
	if (definition.skills.length > 0) dropped("skills", "Copilot agent profiles have no skill preload field.");
	if (definition.services.length > 0) dropped("services", "Copilot agent profiles have no service requirement field.");
	if (definition.requires.length > 0)
		dropped("requires", "Copilot agent profiles have no environment requirement field.");
	if (definition.workspace.isolation !== "shared")
		dropped("workspace.isolation", "Copilot agent profiles have no workspace isolation field.");
	if (definition.limits.maxTurns !== null || definition.limits.timeoutMinutes !== null)
		dropped("limits", "Copilot agent profiles have no turn or timeout limits.");
	if (definition.result.schema !== null || definition.result.artifacts.length > 0)
		dropped("result", "Copilot agent profiles have no result contract.");
	if (definition.license !== null) dropped("license", "Copilot agent profiles have no license field.");

	for (const [runtime, values] of Object.entries(definition.runtimes)) {
		if (runtime !== "copilot") {
			dropped(`runtimes.${runtime}`, "Copilot cannot preserve another runtime's options.");
			continue;
		}
		for (const [key, value] of Object.entries(values)) {
			if (key === "required") {
				if (value === true) dropped("runtimes.copilot.required", "Copilot has no required-runtime marker.");
			} else fields[key] = value;
		}
	}

	return {
		files: [
			{
				path: `.github/agents/${definition.name}.agent.md`,
				text: joinFrontmatter(fields, definition.instructions.text),
			},
		],
		report: { target: "copilot", direction: "export", entries } as const,
	};
}

export const copilotFormat: AgentFormat = {
	name: "copilot",
	import: importCopilot,
	export: exportCopilot,
};
