import { basename } from "node:path";
import { parse } from "yaml";
import { parseDefinition, type AgentDefinition, type PortableToolName, type ToolReference } from "../definition.ts";
import { joinFrontmatter, splitFrontmatter } from "../frontmatter.ts";
import type { AgentFormat, ImportOptions, ImportResult, LoweringEntry } from "../report.ts";

/*
 * OpenCode mapping (https://opencode.ai/docs/agents/):
 * | Canonical | OpenCode | Conversion |
 * | tools / disallowedTools | permission (tools is deprecated) | Portable categories become permission keys; report weakened. |
 * | model | model | One model is exact; fallback models are weakened to the first. |
 * | effort | — | Dropped. |
 * | invocation | mode / hidden | No exact two-flag mapping; dropped and target fields remain runtime options. |
 * | limits.maxTurns | steps | Exact. timeoutMinutes is dropped. |
 * | workspace.isolation | — | Dropped; edit denial is a tool restriction, not isolation. |
 * | context / skills / services | — | Dropped. |
 */

const PORTABLE_TO_PERMISSIONS: Readonly<Record<PortableToolName, readonly string[]>> = {
	execute: ["bash"],
	read: ["read"],
	edit: ["edit"],
	search: ["glob", "grep", "list"],
	agent: ["task"],
	web: ["webfetch", "websearch"],
	todo: [],
};

const PERMISSION_TO_PORTABLE: Readonly<Record<string, PortableToolName | undefined>> = {
	bash: "execute",
	read: "read",
	edit: "edit",
	write: "edit",
	apply_patch: "edit",
	glob: "search",
	grep: "search",
	list: "search",
	lsp: "search",
	task: "agent",
	webfetch: "web",
	websearch: "web",
};

const ALL_PORTABLE: readonly PortableToolName[] = ["execute", "read", "edit", "search", "agent", "web", "todo"];

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parserFailure(source: string): ImportResult {
	return { ok: false, diagnostics: parseDefinition(source).diagnostics };
}

function availability(value: unknown, legacy: boolean): boolean | undefined {
	if (legacy && typeof value === "boolean") return value;
	if (value === "allow" || value === "ask") return true;
	if (value === "deny") return false;
	if (!isRecord(value)) return undefined;
	const decisions = Object.values(value).map((entry) => availability(entry, false));
	if (decisions.some((entry) => entry === true)) return true;
	if (decisions.length > 0 && decisions.every((entry) => entry === false)) return false;
	return undefined;
}

function deriveName(file: string | undefined): string | undefined {
	return file === undefined ? undefined : basename(file).replace(/\.md$/u, "");
}

function importOpenCode(source: string, options: ImportOptions): ImportResult {
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
	const runtime: Fields = {};
	const report: LoweringEntry[] = [];
	const unmapped = (path: string, key: string, value: unknown, container: Fields = runtime): void => {
		container[key] = value;
		report.push({
			path,
			action: "unmapped",
			reason: `OpenCode field "${path}" has no canonical mapping.`,
		});
	};

	if (Object.hasOwn(foreign, "name")) canonical.name = foreign.name;
	else canonical.name = deriveName(options.file);
	if (Object.hasOwn(foreign, "description")) canonical.description = foreign.description;
	if (Object.hasOwn(foreign, "model")) canonical.model = foreign.model;
	if (Object.hasOwn(foreign, "steps")) canonical.limits = { maxTurns: foreign.steps };
	else if (Object.hasOwn(foreign, "maxSteps")) canonical.limits = { maxTurns: foreign.maxSteps };

	const allowed = new Set<PortableToolName>(ALL_PORTABLE);
	let sawAccessRule = false;
	for (const [field, legacy] of [
		["permission", false],
		["tools", true],
	] as const) {
		if (!Object.hasOwn(foreign, field)) continue;
		const access = foreign[field];
		if (!isRecord(access)) {
			unmapped(field, field, access);
			continue;
		}
		const runtimeAccess: Fields = {};
		for (const [key, value] of Object.entries(access)) {
			const decision = availability(value, legacy);
			if (key === "*" && decision !== undefined) {
				sawAccessRule = true;
				allowed.clear();
				if (decision) for (const portable of ALL_PORTABLE) allowed.add(portable);
				continue;
			}
			const portable = PERMISSION_TO_PORTABLE[key];
			if (portable === undefined || decision === undefined) {
				unmapped(`${field}.${key}`, key, value, runtimeAccess);
				continue;
			}
			sawAccessRule = true;
			if (decision) allowed.add(portable);
			else allowed.delete(portable);
		}
		if (Object.keys(runtimeAccess).length > 0) runtime[field] = runtimeAccess;
	}
	if (sawAccessRule && allowed.size > 0 && allowed.size < ALL_PORTABLE.length) canonical.tools = [...allowed];
	if (sawAccessRule && allowed.size === 0) {
		runtime.permission = foreign.permission ?? foreign.tools;
		report.push({
			path: "permission",
			action: "unmapped",
			reason: "Agent Definitions cannot represent an explicit empty tool set.",
		});
	}

	const mapped = new Set(["name", "description", "model", "steps", "permission", "tools"]);
	if (!Object.hasOwn(foreign, "steps") && Object.hasOwn(foreign, "maxSteps")) mapped.add("maxSteps");
	for (const [key, value] of Object.entries(foreign)) {
		if (!mapped.has(key)) unmapped(key, key, value);
	}
	if (Object.keys(runtime).length > 0) canonical.runtimes = { opencode: runtime };

	const parsed = parseDefinition(
		joinFrontmatter(canonical, split.body),
		options.file === undefined ? {} : { file: options.file },
	);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	return {
		ok: true,
		definition: parsed.definition,
		diagnostics: parsed.diagnostics,
		report: { target: "opencode", direction: "import", entries: report },
	};
}

function permissionKeys(tool: ToolReference): readonly string[] {
	return tool.portable === null ? [] : PORTABLE_TO_PERMISSIONS[tool.portable];
}

function exportOpenCode(definition: AgentDefinition) {
	const fields: Fields = { description: definition.description };
	const entries: LoweringEntry[] = [];
	const dropped = (path: string, reason: string): void => {
		entries.push({ path, action: "dropped", reason });
	};
	const weakened = (path: string, result: string, reason: string): void => {
		entries.push({ path, action: "weakened", result, reason });
	};

	if (!(definition.model.length === 1 && definition.model[0] === "inherit")) fields.model = definition.model[0];
	if (definition.model.length > 1)
		weakened("model", String(definition.model[0]), "OpenCode accepts one model and cannot preserve fallbacks.");
	if (definition.limits.maxTurns !== null) fields.steps = definition.limits.maxTurns;

	const permission: Fields = {};
	if (definition.tools !== "inherit") {
		permission["*"] = "deny";
		for (const tool of definition.tools) for (const key of permissionKeys(tool)) permission[key] = "allow";
		weakened("tools", "permission", "OpenCode permissions cannot preserve canonical tool spellings exactly.");
	}
	if (definition.disallowedTools.length > 0) {
		for (const tool of definition.disallowedTools) for (const key of permissionKeys(tool)) permission[key] = "deny";
		weakened("disallowedTools", "permission", "OpenCode combines allowed and denied tools in one permission map.");
		if (definition.tools === "inherit")
			weakened("tools", "permission", "An OpenCode deny rule becomes an explicit canonical tool list on import.");
	}
	if (Object.keys(permission).length > 0) fields.permission = permission;

	if (definition.version !== null) dropped("version", "OpenCode agent files have no version field.");
	if (definition.instructions.mode !== "replace")
		dropped("instructions.mode", "OpenCode uses the Markdown body as the agent prompt.");
	if (definition.instructions.include.length > 0)
		dropped("instructions.include", "OpenCode agent files have no instruction include field.");
	if (Object.values(definition.effort).some((value) => value !== null))
		dropped("effort", "OpenCode agent files do not configure reasoning effort.");
	if (
		!definition.context.project ||
		!definition.context.user ||
		!definition.context.skills ||
		definition.context.files.length > 0
	)
		dropped("context", "OpenCode agent files cannot preserve canonical context controls.");
	if (definition.agents.length > 0) dropped("agents", "OpenCode task permissions are not a canonical agent allowlist.");
	if (definition.skills.length > 0) dropped("skills", "OpenCode has no agent skill preload list.");
	if (definition.services.length > 0) dropped("services", "OpenCode agent files have no service requirement field.");
	if (definition.requires.length > 0)
		dropped("requires", "OpenCode agent files have no environment requirement field.");
	if (definition.workspace.isolation !== "shared")
		dropped("workspace.isolation", "OpenCode permissions do not provide per-agent workspace isolation.");
	if (!definition.invocation.model || !definition.invocation.user)
		dropped("invocation", "OpenCode mode and hidden flags do not exactly implement both invocation controls.");
	if (definition.limits.timeoutMinutes !== null)
		dropped("limits.timeoutMinutes", "OpenCode agent files have no timeout in minutes.");
	if (definition.result.schema !== null || definition.result.artifacts.length > 0)
		dropped("result", "OpenCode agent files have no result contract.");
	if (definition.license !== null) dropped("license", "OpenCode agent files have no license field.");
	if (Object.keys(definition.metadata).length > 0) dropped("metadata", "OpenCode agent files have no metadata map.");

	for (const [runtime, values] of Object.entries(definition.runtimes)) {
		if (runtime !== "opencode") {
			dropped(`runtimes.${runtime}`, "OpenCode cannot preserve another runtime's options.");
			continue;
		}
		for (const [key, value] of Object.entries(values)) {
			if (key === "required") {
				if (value === true) dropped("runtimes.opencode.required", "OpenCode has no required-runtime marker.");
			} else fields[key] = value;
		}
	}

	return {
		files: [
			{ path: `.opencode/agents/${definition.name}.md`, text: joinFrontmatter(fields, definition.instructions.text) },
		],
		report: { target: "opencode", direction: "export", entries } as const,
	};
}

export const opencodeFormat: AgentFormat = {
	name: "opencode",
	import: importOpenCode,
	export: exportOpenCode,
};
