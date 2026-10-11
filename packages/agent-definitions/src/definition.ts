import { LineCounter, isMap, isSeq, parseDocument } from "yaml";
import { splitFrontmatter } from "./frontmatter.ts";

export const CANONICAL_TOP_LEVEL_FIELDS = [
	"schemaVersion",
	"name",
	"description",
	"version",
	"instructions",
	"model",
	"effort",
	"context",
	"tools",
	"disallowedTools",
	"agents",
	"skills",
	"services",
	"requires",
	"workspace",
	"invocation",
	"limits",
	"result",
	"runtimes",
	"license",
	"metadata",
] as const;

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Isolation = "shared" | "worktree" | "ephemeral";
export type PortableToolName = "execute" | "read" | "edit" | "search" | "agent" | "web" | "todo";
export type DefinitionOrigin = "project" | "user" | "package";

export interface Diagnostic {
	readonly severity: "error" | "warning" | "hint";
	readonly code: string;
	readonly path: string;
	readonly message: string;
	readonly line?: number;
}

export interface ToolReference {
	readonly name: string;
	readonly portable: PortableToolName | null;
	readonly namespace: string | null;
}

export interface SkillReference {
	readonly name: string;
	readonly source: string | null;
	readonly version: string | null;
	readonly required: boolean;
}

export interface ArtifactReference {
	readonly path: string;
	readonly check: string | null;
}

export interface ContextFileReference {
	readonly path: string;
	readonly required: boolean;
}

export interface RuntimeOptions {
	readonly required: boolean;
	readonly [key: string]: unknown;
}

export interface AgentDefinition {
	readonly schemaVersion: 1;
	readonly name: string;
	readonly description: string;
	readonly version: string | null;
	readonly instructions: {
		readonly text: string;
		readonly mode: "append" | "replace";
		readonly include: string[];
	};
	readonly model: string[];
	readonly effort: {
		readonly default: EffortLevel | null;
		readonly min: EffortLevel | null;
		readonly max: EffortLevel | null;
	};
	readonly context: {
		readonly project: boolean;
		readonly user: boolean;
		readonly skills: boolean;
		readonly files: ContextFileReference[];
	};
	readonly tools: "inherit" | ToolReference[];
	readonly disallowedTools: ToolReference[];
	readonly agents: string[];
	readonly skills: SkillReference[];
	readonly services: string[];
	readonly requires: string[];
	readonly workspace: { readonly isolation: Isolation };
	readonly invocation: { readonly model: boolean; readonly user: boolean };
	readonly limits: { readonly maxTurns: number | null; readonly timeoutMinutes: number | null };
	readonly result: {
		readonly schema: Record<string, unknown> | null;
		readonly artifacts: ArtifactReference[];
	};
	readonly runtimes: Record<string, RuntimeOptions>;
	readonly license: string | null;
	readonly metadata: Record<string, string>;
}

export type ParseResult =
	| { readonly ok: true; readonly definition: AgentDefinition; readonly diagnostics: Diagnostic[] }
	| { readonly ok: false; readonly diagnostics: Diagnostic[] };

export interface ParseOptions {
	readonly origin?: DefinitionOrigin;
	readonly file?: string;
}

type RawMap = Record<string, unknown>;
type KeyLines = Map<string, number>;

const EFFORT_LEVELS: readonly EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ISOLATIONS: readonly Isolation[] = ["shared", "worktree", "ephemeral"];
const RUNTIME_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECOMMENDED_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LEGACY_KEYS = [
	"systemPrompt",
	"systemPromptMode",
	"inheritProjectContext",
	"omitClaudeMd",
	"inheritSkills",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"fallbackModels",
	"nestedDelegateAgents",
	"allowNestedDelegate",
	"artifact",
	"defaultProgress",
	"defaultReads",
	"isolation",
	"maxTurns",
	"color",
	"permissionMode",
	"hooks",
	"memory",
	"background",
	"initialPrompt",
	"mcpServers",
] as const;

const FOREIGN_RUNTIME_KEYS = new Set<string>([
	"color",
	"permissionMode",
	"hooks",
	"memory",
	"background",
	"initialPrompt",
	"mcpServers",
]);

const canonicalKeys = new Set<string>(CANONICAL_TOP_LEVEL_FIELDS);
const legacyKeys = new Set<string>(LEGACY_KEYS);
const transformedKeys = new Map<string, string>();
for (const key of [...CANONICAL_TOP_LEVEL_FIELDS, ...LEGACY_KEYS]) {
	const separated = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
	if (separated !== key) {
		transformedKeys.set(separated, key);
		transformedKeys.set(separated.replaceAll("_", "-"), key);
	}
}

const toolAliases: ReadonlyMap<string, PortableToolName> = new Map(
	Object.entries({
		execute: "execute",
		read: "read",
		edit: "edit",
		search: "search",
		agent: "agent",
		web: "web",
		todo: "todo",
		bash: "execute",
		notebookread: "read",
		multiedit: "edit",
		write: "edit",
		notebookedit: "edit",
		grep: "search",
		glob: "search",
		task: "agent",
		websearch: "web",
		webfetch: "web",
		todowrite: "todo",
		find: "search",
		ls: "search",
		delegate: "agent",
		delegate_control: "agent",
		delegate_status: "agent",
	}) as [string, PortableToolName][],
);

function isPlainObject(value: unknown): value is RawMap {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(object: RawMap, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function addDiagnostic(
	diagnostics: Diagnostic[],
	keyLines: KeyLines,
	severity: Diagnostic["severity"],
	code: string,
	path: string,
	message: string,
	linePath = path,
): void {
	const line = keyLines.get(linePath);
	diagnostics.push(line === undefined ? { severity, code, path, message } : { severity, code, path, message, line });
}

function error(
	diagnostics: Diagnostic[],
	keyLines: KeyLines,
	path: string,
	message: string,
	code = "invalid-field",
	linePath = path,
): void {
	addDiagnostic(diagnostics, keyLines, "error", code, path, message, linePath);
}

function warning(
	diagnostics: Diagnostic[],
	keyLines: KeyLines,
	path: string,
	message: string,
	code = "legacy-spelling",
): void {
	addDiagnostic(diagnostics, keyLines, "warning", code, path, message);
}

interface YamlCollectionLike {
	readonly items: readonly unknown[];
}

interface YamlKeyLike {
	readonly range: readonly number[];
	readonly value: unknown;
}

interface YamlPairLike {
	readonly key: YamlKeyLike;
	readonly value: unknown;
}

function collectKeyLines(
	node: unknown,
	lineCounter: LineCounter,
	lines: KeyLines,
	duplicates: { path: string; line: number }[],
	path = "",
): void {
	if (isMap(node)) {
		const seen = new Set<string>();
		for (const item of (node as YamlCollectionLike).items) {
			const pair = item as YamlPairLike;
			const key = String(pair.key.value);
			const childPath = path ? `${path}.${key}` : key;
			const line = lineCounter.linePos(pair.key.range[0]!).line + 1;
			if (seen.has(key)) duplicates.push({ path: childPath, line });
			else lines.set(childPath, line);
			seen.add(key);
			collectKeyLines(pair.value, lineCounter, lines, duplicates, childPath);
		}
	} else if (isSeq(node)) {
		for (const [index, item] of (node as YamlCollectionLike).items.entries()) {
			collectKeyLines(item, lineCounter, lines, duplicates, `${path}[${index}]`);
		}
	}
}

function stringValue(
	raw: unknown,
	path: string,
	diagnostics: Diagnostic[],
	lines: KeyLines,
	options: { optional?: boolean } = {},
): string | null {
	if (raw === undefined && options.optional) return null;
	if (typeof raw !== "string" || raw.trim().length === 0) {
		error(diagnostics, lines, path, `${path} must be a non-empty string.`);
		return null;
	}
	return raw;
}

function booleanValue(
	raw: unknown,
	path: string,
	fallback: boolean,
	diagnostics: Diagnostic[],
	lines: KeyLines,
): boolean {
	if (raw === undefined) return fallback;
	if (typeof raw !== "boolean") {
		error(diagnostics, lines, path, `${path} must be a boolean.`);
		return fallback;
	}
	return raw;
}

function positiveInteger(raw: unknown, path: string, diagnostics: Diagnostic[], lines: KeyLines): number | null {
	if (raw === undefined || raw === null) return null;
	if (!Number.isInteger(raw) || (raw as number) <= 0) {
		error(diagnostics, lines, path, `${path} must be a positive integer.`);
		return null;
	}
	return raw as number;
}

function unknownObjectFields(
	object: RawMap,
	known: readonly string[],
	base: string,
	diagnostics: Diagnostic[],
	lines: KeyLines,
): void {
	const allowed = new Set(known);
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) {
			const path = `${base}.${key}`;
			error(diagnostics, lines, path, `Unknown field "${path}".`, "unknown-field");
		}
	}
}

function objectValue(raw: unknown, path: string, diagnostics: Diagnostic[], lines: KeyLines): RawMap {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) {
		error(diagnostics, lines, path, `${path} must be an object.`);
		return {};
	}
	return raw;
}

function listInput(
	raw: unknown,
	path: string,
	diagnostics: Diagnostic[],
	lines: KeyLines,
	allowCsv: boolean,
): unknown[] | undefined {
	if (raw === undefined) return undefined;
	if (Array.isArray(raw)) return raw;
	if (allowCsv && typeof raw === "string") return raw.split(",").map((item) => item.trim());
	error(diagnostics, lines, path, `${path} must be a list${allowCsv ? " or comma-separated string" : ""}.`);
	return [];
}

function stringList(
	raw: unknown,
	path: string,
	diagnostics: Diagnostic[],
	lines: KeyLines,
	allowCsv = false,
): string[] {
	const values = listInput(raw, path, diagnostics, lines, allowCsv) ?? [];
	const result: string[] = [];
	for (const [index, value] of values.entries()) {
		if (typeof value !== "string" || value.trim().length === 0) {
			error(
				diagnostics,
				lines,
				`${path}[${index}]`,
				`${path} entries must be non-empty strings.`,
				"invalid-field",
				path,
			);
		} else {
			result.push(value.trim());
		}
	}
	return result;
}

function invalidContextFilePath(path: string): boolean {
	return (
		path.trim().length === 0 ||
		path.startsWith("/") ||
		path.startsWith("\\") ||
		/^[A-Za-z]:/u.test(path) ||
		path.startsWith("~") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").includes("..") ||
		/[*?[\]{}]/u.test(path)
	);
}

function parseContextFiles(raw: unknown, diagnostics: Diagnostic[], lines: KeyLines): ContextFileReference[] {
	const values = listInput(raw, "context.files", diagnostics, lines, false) ?? [];
	const result: ContextFileReference[] = [];
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		const entryPath = `context.files[${index}]`;
		let path: string;
		let required = false;
		let diagnosticPath = entryPath;
		if (typeof value === "string") {
			path = value;
		} else if (isPlainObject(value)) {
			unknownObjectFields(value, ["path", "required"], entryPath, diagnostics, lines);
			diagnosticPath = `${entryPath}.path`;
			if (typeof value.path !== "string") {
				error(diagnostics, lines, diagnosticPath, "A context file path must be a string.");
				continue;
			}
			path = value.path;
			required = booleanValue(value.required, `${entryPath}.required`, false, diagnostics, lines);
		} else {
			error(
				diagnostics,
				lines,
				entryPath,
				"A context file must be a path or an object.",
				"invalid-field",
				"context.files",
			);
			continue;
		}
		if (invalidContextFilePath(path)) {
			error(diagnostics, lines, diagnosticPath, "A context file path must be a safe relative path.");
			continue;
		}
		if (seen.has(path)) {
			error(diagnostics, lines, diagnosticPath, `The context file path "${path}" is listed more than once.`);
			continue;
		}
		seen.add(path);
		result.push({ path, required });
	}
	return result;
}

function effortValue(raw: unknown, path: string, diagnostics: Diagnostic[], lines: KeyLines): EffortLevel | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || !EFFORT_LEVELS.includes(raw as EffortLevel)) {
		error(diagnostics, lines, path, `${path} must be one of ${EFFORT_LEVELS.join(", ")}.`);
		return null;
	}
	return raw as EffortLevel;
}

function parseEffort(raw: unknown, diagnostics: Diagnostic[], lines: KeyLines): AgentDefinition["effort"] {
	if (typeof raw === "string") return { default: effortValue(raw, "effort", diagnostics, lines), min: null, max: null };
	const object = objectValue(raw, "effort", diagnostics, lines);
	unknownObjectFields(object, ["default", "min", "max"], "effort", diagnostics, lines);
	const result = {
		default: effortValue(object.default, "effort.default", diagnostics, lines),
		min: effortValue(object.min, "effort.min", diagnostics, lines),
		max: effortValue(object.max, "effort.max", diagnostics, lines),
	};
	const rank = (level: EffortLevel | null): number | null => (level === null ? null : EFFORT_LEVELS.indexOf(level));
	const min = rank(result.min);
	const current = rank(result.default);
	const max = rank(result.max);
	if (
		(min !== null && current !== null && min > current) ||
		(current !== null && max !== null && current > max) ||
		(min !== null && max !== null && min > max)
	) {
		error(diagnostics, lines, "effort", "effort must satisfy min <= default <= max where values are set.");
	}
	return result;
}

function parseTool(name: string, path: string, diagnostics: Diagnostic[], lines: KeyLines): ToolReference | null {
	const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
	if (mcp) {
		const normalized = `mcp:${mcp[1]}/${mcp[2]}`;
		warning(diagnostics, lines, path, `Use the namespaced tool spelling "${normalized}".`, "tool-spelling");
		return { name: normalized, portable: null, namespace: "mcp" };
	}
	const portable = toolAliases.get(name.toLowerCase());
	if (portable !== undefined) return { name, portable, namespace: null };
	const colon = name.indexOf(":");
	if (colon > 0 && colon < name.length - 1) return { name, portable: null, namespace: name.slice(0, colon) };
	error(diagnostics, lines, path, `Unknown unqualified tool "${name}".`, "unknown-tool", path.replace(/\[\d+\]$/, ""));
	return null;
}

function parseTools(
	raw: unknown,
	path: "tools" | "disallowedTools",
	diagnostics: Diagnostic[],
	lines: KeyLines,
): "inherit" | ToolReference[] {
	if (raw === undefined && path === "tools") return "inherit";
	if (raw === "inherit" && path === "tools") return "inherit";
	const values = stringList(raw, path, diagnostics, lines, true);
	if (path === "tools" && values.length === 0) error(diagnostics, lines, path, "tools must not be an empty list.");
	const result: ToolReference[] = [];
	for (const [index, name] of values.entries()) {
		const parsed = parseTool(name, `${path}[${index}]`, diagnostics, lines);
		if (parsed) result.push(parsed);
	}
	return result;
}

function parseSkills(raw: unknown, diagnostics: Diagnostic[], lines: KeyLines): SkillReference[] {
	const values = listInput(raw, "skills", diagnostics, lines, true) ?? [];
	const result: SkillReference[] = [];
	for (const [index, value] of values.entries()) {
		const path = `skills[${index}]`;
		if (typeof value === "string" && value.trim().length > 0) {
			result.push({ name: value.trim(), source: null, version: null, required: true });
			continue;
		}
		if (!isPlainObject(value)) {
			error(diagnostics, lines, path, "A skill must be a name or an object.", "invalid-field", "skills");
			continue;
		}
		unknownObjectFields(value, ["name", "source", "version", "required"], path, diagnostics, lines);
		const name = stringValue(value.name, `${path}.name`, diagnostics, lines);
		const source = stringValue(value.source, `${path}.source`, diagnostics, lines, { optional: true });
		const version = stringValue(value.version, `${path}.version`, diagnostics, lines, { optional: true });
		const required = booleanValue(value.required, `${path}.required`, true, diagnostics, lines);
		if (name !== null) result.push({ name, source, version, required });
	}
	return result;
}

function parseArtifacts(raw: unknown, diagnostics: Diagnostic[], lines: KeyLines): ArtifactReference[] {
	const values = listInput(raw, "result.artifacts", diagnostics, lines, false) ?? [];
	const result: ArtifactReference[] = [];
	for (const [index, value] of values.entries()) {
		const path = `result.artifacts[${index}]`;
		if (typeof value === "string" && value.trim().length > 0) {
			result.push({ path: value, check: null });
			continue;
		}
		if (!isPlainObject(value)) {
			error(diagnostics, lines, path, "An artifact must be a path or an object.", "invalid-field", "result.artifacts");
			continue;
		}
		unknownObjectFields(value, ["path", "check"], path, diagnostics, lines);
		const artifactPath = stringValue(value.path, `${path}.path`, diagnostics, lines);
		const check = stringValue(value.check, `${path}.check`, diagnostics, lines, { optional: true });
		if (artifactPath !== null) result.push({ path: artifactPath, check });
	}
	return result;
}

function parseRuntimes(raw: unknown, diagnostics: Diagnostic[], lines: KeyLines): Record<string, RuntimeOptions> {
	const object = objectValue(raw, "runtimes", diagnostics, lines);
	const result: Record<string, RuntimeOptions> = {};
	for (const [name, value] of Object.entries(object)) {
		const path = `runtimes.${name}`;
		if (!RUNTIME_NAME.test(name))
			error(diagnostics, lines, path, "Runtime names use lowercase letters, digits and hyphens.");
		if (!isPlainObject(value)) {
			error(diagnostics, lines, path, "A runtime block must be an object.");
			continue;
		}
		result[name] = { ...value, required: booleanValue(value.required, `${path}.required`, false, diagnostics, lines) };
	}
	return result;
}

function transformedKey(written: string): { logical: string; transformed: boolean } {
	const logical = transformedKeys.get(written);
	return logical === undefined ? { logical: written, transformed: false } : { logical, transformed: true };
}

function conflict(diagnostics: Diagnostic[], lines: KeyLines, written: string, canonicalPath: string): void {
	error(
		diagnostics,
		lines,
		written,
		`The legacy field "${written}" cannot be set with "${canonicalPath}".`,
		"duplicate-spelling",
	);
}

function prepareTopLevel(
	raw: RawMap,
	diagnostics: Diagnostic[],
	lines: KeyLines,
): {
	canonical: RawMap;
	aliases: Map<string, { written: string; value: unknown }>;
	sourcePaths: Map<string, string>;
} {
	const canonical: RawMap = {};
	const aliases = new Map<string, { written: string; value: unknown }>();
	const sourcePaths = new Map<string, string>();
	for (const [written, value] of Object.entries(raw)) {
		const { logical, transformed } = transformedKey(written);
		if (canonicalKeys.has(logical)) {
			if (has(canonical, logical)) {
				error(
					diagnostics,
					lines,
					written,
					`The field "${logical}" is written with two spellings.`,
					"duplicate-spelling",
				);
			} else {
				canonical[logical] = value;
				sourcePaths.set(logical, written);
			}
			if (transformed) warning(diagnostics, lines, written, `Use the canonical spelling "${logical}".`);
		} else if (legacyKeys.has(logical)) {
			if (aliases.has(logical))
				error(
					diagnostics,
					lines,
					written,
					`The field "${logical}" is written with two spellings.`,
					"duplicate-spelling",
				);
			else aliases.set(logical, { written, value });
			warning(diagnostics, lines, written, `Use the canonical 0.1 field instead.`);
		} else {
			error(diagnostics, lines, written, `Unknown field "${written}".`, "unknown-field");
		}
	}
	return { canonical, aliases, sourcePaths };
}

function aliasValue(
	aliases: Map<string, { written: string; value: unknown }>,
	key: string,
): { written: string; value: unknown } | undefined {
	return aliases.get(key);
}

function applyAliases(
	canonical: RawMap,
	aliases: Map<string, { written: string; value: unknown }>,
	sourcePaths: Map<string, string>,
	body: string,
	diagnostics: Diagnostic[],
	lines: KeyLines,
): { body: string; runtimes: Record<string, RuntimeOptions> } {
	let instructionText = body;
	const instructions = objectValue(canonical.instructions, "instructions", diagnostics, lines);
	const context = objectValue(canonical.context, "context", diagnostics, lines);
	const limits = objectValue(canonical.limits, "limits", diagnostics, lines);
	const workspace = objectValue(canonical.workspace, "workspace", diagnostics, lines);
	const result = objectValue(canonical.result, "result", diagnostics, lines);
	const runtimes = parseRuntimes(canonical.runtimes, diagnostics, lines);

	const systemPrompt = aliasValue(aliases, "systemPrompt");
	if (systemPrompt) {
		if (body.trim().length > 0) conflict(diagnostics, lines, systemPrompt.written, "instructions.text");
		else {
			const text = stringValue(systemPrompt.value, systemPrompt.written, diagnostics, lines);
			if (text !== null) instructionText = text;
		}
	}
	const directAliases: readonly [string, RawMap, string, (value: unknown) => unknown][] = [
		["systemPromptMode", instructions, "mode", (value) => value],
		["inheritProjectContext", context, "project", (value) => value],
		["omitClaudeMd", context, "project", (value) => (typeof value === "boolean" ? !value : value)],
		["inheritSkills", context, "skills", (value) => value],
		["maxTurns", limits, "maxTurns", (value) => value],
		["isolation", workspace, "isolation", (value) => value],
	];
	for (const [key, target, targetKey, transform] of directAliases) {
		const alias = aliasValue(aliases, key);
		if (!alias) continue;
		if (has(target, targetKey))
			conflict(
				diagnostics,
				lines,
				alias.written,
				`${key === "isolation" ? "workspace" : key === "maxTurns" ? "limits" : key === "systemPromptMode" ? "instructions" : "context"}.${targetKey}`,
			);
		else {
			target[targetKey] = transform(alias.value);
			const base =
				key === "isolation"
					? "workspace"
					: key === "maxTurns"
						? "limits"
						: key === "systemPromptMode"
							? "instructions"
							: "context";
			sourcePaths.set(`${base}.${targetKey}`, alias.written);
		}
	}
	const defaultReads = aliasValue(aliases, "defaultReads");
	if (defaultReads) {
		if (has(context, "files")) conflict(diagnostics, lines, defaultReads.written, "context.files");
		else {
			context.files = stringList(defaultReads.value, defaultReads.written, diagnostics, lines, true);
			sourcePaths.set("context.files", defaultReads.written);
		}
	}

	canonical.instructions = instructions;
	canonical.context = context;
	canonical.limits = limits;
	canonical.workspace = workspace;

	const thinkingKeys = ["thinking", "thinkingMin", "thinkingMax"] as const;
	if (thinkingKeys.some((key) => aliases.has(key))) {
		if (has(canonical, "effort")) {
			for (const key of thinkingKeys) {
				const alias = aliasValue(aliases, key);
				if (alias) conflict(diagnostics, lines, alias.written, "effort");
			}
		} else {
			canonical.effort = {
				default: aliasValue(aliases, "thinking")?.value,
				min: aliasValue(aliases, "thinkingMin")?.value,
				max: aliasValue(aliases, "thinkingMax")?.value,
			};
			for (const [key, suffix] of [
				["thinking", "default"],
				["thinkingMin", "min"],
				["thinkingMax", "max"],
			] as const) {
				const alias = aliasValue(aliases, key);
				if (alias) sourcePaths.set(`effort.${suffix}`, alias.written);
			}
		}
	}
	const fallbackModels = aliasValue(aliases, "fallbackModels");
	if (fallbackModels) {
		const current =
			canonical.model === undefined ? [] : Array.isArray(canonical.model) ? canonical.model : [canonical.model];
		canonical.model = [
			...current,
			...stringList(fallbackModels.value, fallbackModels.written, diagnostics, lines, false),
		];
	}

	const nested = aliasValue(aliases, "nestedDelegateAgents");
	const allow = aliasValue(aliases, "allowNestedDelegate");
	if (nested || allow) {
		if (allow && typeof allow.value !== "boolean") {
			error(diagnostics, lines, allow.written, `${allow.written} must be a boolean.`);
		} else if (nested && allow?.value === false) {
			error(
				diagnostics,
				lines,
				allow.written,
				`${allow.written}: false conflicts with ${nested.written}.`,
				"duplicate-spelling",
			);
		}
		if (has(canonical, "agents")) conflict(diagnostics, lines, nested?.written ?? allow!.written, "agents");
		else if (nested) {
			canonical.agents = nested.value;
			sourcePaths.set("agents", nested.written);
		} else if (allow?.value === true) {
			canonical.agents = ["*"];
			sourcePaths.set("agents", allow.written);
		} else if (allow?.value === false) {
			canonical.agents = [];
			sourcePaths.set("agents", allow.written);
		}
	}

	const artifact = aliasValue(aliases, "artifact");
	if (artifact) {
		if (has(result, "artifacts")) conflict(diagnostics, lines, artifact.written, "result.artifacts");
		else if (artifact.value === false) result.artifacts = [];
		else {
			result.artifacts = [artifact.value];
			sourcePaths.set("result.artifacts", artifact.written);
		}
	}
	canonical.result = result;

	const progress = aliasValue(aliases, "defaultProgress");
	if (progress) {
		const block: RawMap = { ...(runtimes["pi-delegate"] ?? { required: false }) };
		if (has(block, "defaultProgress"))
			conflict(diagnostics, lines, progress.written, "runtimes.pi-delegate.defaultProgress");
		else block.defaultProgress = progress.value;
		runtimes["pi-delegate"] = block as RuntimeOptions;
	}
	for (const key of FOREIGN_RUNTIME_KEYS) {
		const alias = aliasValue(aliases, key);
		if (!alias) continue;
		const block: RawMap = { ...(runtimes["claude-code"] ?? { required: false }) };
		if (has(block, key)) conflict(diagnostics, lines, alias.written, `runtimes.claude-code.${key}`);
		else block[key] = alias.value;
		runtimes["claude-code"] = block as RuntimeOptions;
	}
	return { body: instructionText, runtimes };
}

function validatePackageOrigin(
	canonical: RawMap,
	runtimes: Record<string, RuntimeOptions>,
	aliases: Map<string, { written: string; value: unknown }>,
	diagnostics: Diagnostic[],
	lines: KeyLines,
): void {
	if (Array.isArray(canonical.services) && canonical.services.length > 0) {
		error(diagnostics, lines, "services", "Package definitions may not declare services.", "package-restriction");
	}
	for (const key of ["mcpServers", "hooks", "permissionMode"] as const) {
		const alias = aliasValue(aliases, key);
		if (alias)
			error(diagnostics, lines, alias.written, `Package definitions may not declare ${key}.`, "package-restriction");
		for (const [runtime, block] of Object.entries(runtimes)) {
			// A top-level key was folded into the claude-code block and is already reported above.
			if (alias && runtime === "claude-code") continue;
			if (has(block, key)) {
				error(
					diagnostics,
					lines,
					`runtimes.${runtime}.${key}`,
					`Package definitions may not declare ${key}.`,
					"package-restriction",
				);
			}
		}
	}
}

function translateDiagnostics(
	diagnostics: Diagnostic[],
	sourcePaths: Map<string, string>,
	lines: KeyLines,
): Diagnostic[] {
	const mappings = [...sourcePaths].sort(([left], [right]) => right.length - left.length);
	return diagnostics.map((diagnostic) => {
		const mapping = mappings.find(
			([canonical]) =>
				diagnostic.path === canonical ||
				diagnostic.path.startsWith(`${canonical}.`) ||
				diagnostic.path.startsWith(`${canonical}[`),
		);
		const path = mapping ? `${mapping[1]}${diagnostic.path.slice(mapping[0].length)}` : diagnostic.path;
		let line = diagnostic.line;
		let linePath = path;
		while (line === undefined && linePath.length > 0) {
			line = lines.get(linePath);
			const parent = linePath.replace(/(?:\[[0-9]+\]|\.[^.]+)$/, "");
			linePath = parent === linePath ? "" : parent;
		}
		return line === undefined ? { ...diagnostic, path } : { ...diagnostic, path, line };
	});
}

export function parseDefinition(source: string, options: ParseOptions = {}): ParseResult {
	const split = splitFrontmatter(source);
	if (!split.ok) {
		return {
			ok: false,
			diagnostics: [{ severity: "error", code: split.code, path: "", message: split.message, line: split.line }],
		};
	}
	const lineCounter = new LineCounter();
	const document = parseDocument(split.frontmatter, {
		lineCounter,
		prettyErrors: false,
		schema: "core",
		uniqueKeys: false,
		version: "1.2",
	});
	if (document.errors.length > 0) {
		const first = document.errors[0]!;
		const offset = first.pos[0];
		return {
			ok: false,
			diagnostics: [
				{
					severity: "error",
					code: "invalid-yaml",
					path: "",
					message: "The YAML frontmatter is invalid.",
					line: lineCounter.linePos(offset!).line + 1,
				},
			],
		};
	}
	if (!isMap(document.contents)) {
		return {
			ok: false,
			diagnostics: [
				{
					severity: "error",
					code: "frontmatter-not-mapping",
					path: "",
					message: "The YAML frontmatter must be a mapping.",
					line: 2,
				},
			],
		};
	}
	const lines: KeyLines = new Map();
	const duplicates: { path: string; line: number }[] = [];
	collectKeyLines(document.contents, lineCounter, lines, duplicates);
	const diagnostics: Diagnostic[] = duplicates.map(({ path, line }) => ({
		severity: "error",
		code: "duplicate-key",
		path,
		message: `The field "${path}" is written more than once.`,
		line,
	}));
	const raw = document.toJS({ maxAliasCount: 100 }) as RawMap;
	const { canonical, aliases, sourcePaths } = prepareTopLevel(raw, diagnostics, lines);
	const aliased = applyAliases(canonical, aliases, sourcePaths, split.body, diagnostics, lines);

	const schemaVersion = canonical.schemaVersion === undefined ? 1 : canonical.schemaVersion;
	if (schemaVersion !== 1) error(diagnostics, lines, "schemaVersion", "schemaVersion must be 1.");
	const name = stringValue(canonical.name, "name", diagnostics, lines) ?? "";
	if (name.includes(":")) error(diagnostics, lines, "name", "name may not contain a colon.");
	else if (name.length > 0 && !RECOMMENDED_NAME.test(name))
		warning(
			diagnostics,
			lines,
			"name",
			"Use lowercase letters, digits and single hyphens for agent names.",
			"name-spelling",
		);
	const description = stringValue(canonical.description, "description", diagnostics, lines) ?? "";
	if (aliased.body.trim().length === 0) {
		if (!lines.has("instructions")) lines.set("instructions", split.bodyLine);
		error(diagnostics, lines, "instructions", "The Markdown body must contain instructions.", "missing-instructions");
	}
	const version = stringValue(canonical.version, "version", diagnostics, lines, { optional: true });

	const instructions = objectValue(canonical.instructions, "instructions", diagnostics, lines);
	unknownObjectFields(instructions, ["mode", "include"], "instructions", diagnostics, lines);
	const mode = instructions.mode === undefined ? "replace" : instructions.mode;
	if (mode !== "append" && mode !== "replace")
		error(diagnostics, lines, "instructions.mode", "instructions.mode must be append or replace.");
	const include = stringList(instructions.include, "instructions.include", diagnostics, lines);

	let model: string[];
	if (canonical.model === undefined) model = ["inherit"];
	else if (typeof canonical.model === "string") model = canonical.model.trim().length > 0 ? [canonical.model] : [];
	else model = stringList(canonical.model, "model", diagnostics, lines);
	if (model.length === 0)
		error(diagnostics, lines, "model", "model must contain at least one non-empty model reference.");

	const effort = parseEffort(canonical.effort, diagnostics, lines);
	const context = objectValue(canonical.context, "context", diagnostics, lines);
	unknownObjectFields(context, ["project", "user", "skills", "files"], "context", diagnostics, lines);
	const tools = parseTools(canonical.tools, "tools", diagnostics, lines);
	const disallowedTools = parseTools(
		canonical.disallowedTools,
		"disallowedTools",
		diagnostics,
		lines,
	) as ToolReference[];
	const agents = stringList(canonical.agents, "agents", diagnostics, lines, true);
	if (agents.includes("*") && agents.length !== 1)
		error(diagnostics, lines, "agents", '"*" must be the only agents entry.');
	const skills = parseSkills(canonical.skills, diagnostics, lines);
	const services = stringList(canonical.services, "services", diagnostics, lines);
	const requires = stringList(canonical.requires, "requires", diagnostics, lines);

	const workspace = objectValue(canonical.workspace, "workspace", diagnostics, lines);
	unknownObjectFields(workspace, ["isolation"], "workspace", diagnostics, lines);
	const isolation = workspace.isolation === undefined ? "shared" : workspace.isolation;
	if (!ISOLATIONS.includes(isolation as Isolation))
		error(diagnostics, lines, "workspace.isolation", "workspace.isolation must be shared, worktree or ephemeral.");
	const invocation = objectValue(canonical.invocation, "invocation", diagnostics, lines);
	unknownObjectFields(invocation, ["model", "user"], "invocation", diagnostics, lines);
	const limits = objectValue(canonical.limits, "limits", diagnostics, lines);
	unknownObjectFields(limits, ["maxTurns", "timeoutMinutes"], "limits", diagnostics, lines);
	const result = objectValue(canonical.result, "result", diagnostics, lines);
	unknownObjectFields(result, ["schema", "artifacts"], "result", diagnostics, lines);
	let resultSchema: Record<string, unknown> | null = null;
	if (result.schema !== undefined && result.schema !== null) {
		if (isPlainObject(result.schema)) resultSchema = result.schema;
		else error(diagnostics, lines, "result.schema", "result.schema must be an object.");
	}
	const artifacts = parseArtifacts(result.artifacts, diagnostics, lines);
	const license = stringValue(canonical.license, "license", diagnostics, lines, { optional: true });
	const metadata = objectValue(canonical.metadata, "metadata", diagnostics, lines);
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof value !== "string") error(diagnostics, lines, `metadata.${key}`, "metadata values must be strings.");
	}
	const contextProject = booleanValue(context.project, "context.project", true, diagnostics, lines);
	const contextUser = booleanValue(context.user, "context.user", true, diagnostics, lines);
	const contextSkills = booleanValue(context.skills, "context.skills", true, diagnostics, lines);
	const contextFiles = parseContextFiles(context.files, diagnostics, lines);
	const invocationModel = booleanValue(invocation.model, "invocation.model", true, diagnostics, lines);
	const invocationUser = booleanValue(invocation.user, "invocation.user", true, diagnostics, lines);
	const maxTurns = positiveInteger(limits.maxTurns, "limits.maxTurns", diagnostics, lines);
	const timeoutMinutes = positiveInteger(limits.timeoutMinutes, "limits.timeoutMinutes", diagnostics, lines);
	if (options.origin === "package") validatePackageOrigin(canonical, aliased.runtimes, aliases, diagnostics, lines);

	const translatedDiagnostics = translateDiagnostics(diagnostics, sourcePaths, lines);
	const errorPaths = new Set(
		translatedDiagnostics.filter(({ severity }) => severity === "error").map(({ path }) => path),
	);
	const finalDiagnostics = translatedDiagnostics.filter(
		({ severity, path }) => severity !== "warning" || !errorPaths.has(path),
	);
	if (errorPaths.size > 0) return { ok: false, diagnostics: finalDiagnostics };
	return {
		ok: true,
		definition: {
			schemaVersion: 1,
			name,
			description,
			version,
			instructions: { text: aliased.body, mode: mode as "append" | "replace", include },
			model,
			effort,
			context: { project: contextProject, user: contextUser, skills: contextSkills, files: contextFiles },
			tools,
			disallowedTools,
			agents,
			skills,
			services,
			requires,
			workspace: { isolation: isolation as Isolation },
			invocation: { model: invocationModel, user: invocationUser },
			limits: { maxTurns, timeoutMinutes },
			result: { schema: resultSchema, artifacts },
			runtimes: aliased.runtimes,
			license,
			metadata: metadata as Record<string, string>,
		},
		diagnostics: finalDiagnostics,
	};
}
