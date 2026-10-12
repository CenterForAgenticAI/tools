import {
	parseDefinition,
	type AgentDefinition,
	type Diagnostic,
	type EffortLevel,
	type SkillReference,
	type ToolReference,
} from "./definition.ts";
import { checkIsolation, checkRuntime } from "./policy.ts";
import type { ConformanceConsumer, ConformanceRestriction, PrepareRequest, PrepareResult } from "./conformance.ts";
import type { LoweringEntry, LoweringReport } from "./report.ts";

export type PiDurableThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiDurableModelRef {
	readonly provider: string;
	readonly modelId: string;
}

/**
 * pi-durable configure() projects tool and extension objects to their `name`
 * before storing them. This is the smallest structural handle it reads.
 */
export interface PiDurableNamedRegistration {
	readonly name: string;
}

/**
 * Structural shape of the pi-durable 1.1.0 AgentChange fields emitted here.
 * Unset fields continue to follow the host.
 */
export interface PiDurableConfigureInput {
	readonly model?: PiDurableModelRef;
	readonly thinkingLevel?: PiDurableThinkingLevel;
	readonly extensions?: readonly PiDurableNamedRegistration[];
	readonly tools?: readonly PiDurableNamedRegistration[];
	readonly instructions?: string;
	readonly cwd?: string;
}

export interface PiDurableOptions {
	readonly availableModels?: readonly string[];
	readonly parentModel?: string;
	readonly parentTools: readonly string[];
	readonly toolMap?: Readonly<Record<string, string | readonly string[]>>;
	readonly readInstruction?: (path: string) => string | undefined;
	readonly readSkill?: (reference: SkillReference) => string | undefined;
	readonly cwd?: string;
	readonly enforcedBy?: readonly string[];
	readonly downgrade?: { readonly approvedBy: string; readonly paths: readonly string[] };
}

export type PiDurableLowering =
	| { readonly ok: true; readonly input: PiDurableConfigureInput; readonly report: LoweringReport }
	| { readonly ok: false; readonly diagnostics: Diagnostic[]; readonly report: LoweringReport };

// Official references:
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md#tools
// https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#per-conversation-agent
const PORTABLE_TO_PI: Readonly<Partial<Record<NonNullable<ToolReference["portable"]>, readonly string[]>>> = {
	execute: ["bash"],
	read: ["read"],
	edit: ["edit", "write"],
	search: ["grep", "find", "ls"],
};

const PI_THINKING_LEVELS: readonly PiDurableThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function report(entries: readonly LoweringEntry[]): LoweringReport {
	return { target: "pi-durable", direction: "runtime", entries };
}

function diagnostic(code: string, path: string, message: string): Diagnostic {
	return { severity: "error", code, path, message };
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function mappedTools(reference: ToolReference, options: PiDurableOptions): readonly string[] {
	const configured =
		options.toolMap?.[reference.name] ??
		(reference.portable === null ? undefined : options.toolMap?.[reference.portable]);
	if (configured !== undefined) return typeof configured === "string" ? [configured] : configured;
	if (reference.portable !== null) return PORTABLE_TO_PI[reference.portable] ?? [];
	return [reference.name];
}

function modelRef(value: string): PiDurableModelRef | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function selectModel(definition: AgentDefinition, options: PiDurableOptions): PiDurableModelRef | undefined {
	const candidates = definition.model.map((candidate) => (candidate === "inherit" ? options.parentModel : candidate));
	const selected =
		options.availableModels === undefined
			? candidates[0]
			: candidates.find(
					(candidate): candidate is string => candidate !== undefined && options.availableModels!.includes(candidate),
				);
	return selected === undefined ? undefined : modelRef(selected);
}

function thinkingLevel(level: EffortLevel): PiDurableThinkingLevel {
	const index = PI_THINKING_LEVELS.indexOf(level);
	return PI_THINKING_LEVELS[Math.max(0, index)]!;
}

function inlineInstructions(
	definition: AgentDefinition,
	options: PiDurableOptions,
	entries: LoweringEntry[],
	diagnostics: Diagnostic[],
): string {
	const parts: string[] = [];
	for (const [index, path] of definition.instructions.include.entries()) {
		const text = options.readInstruction?.(path);
		if (text === undefined) {
			diagnostics.push(
				diagnostic(
					"instruction-include-missing",
					`instructions.include[${index}]`,
					`The included instruction file "${path}" could not be read.`,
				),
			);
			continue;
		}
		parts.push(`## Included instructions: ${path}\n\n${text}`);
		entries.push({
			path: `instructions.include[${index}]`,
			action: "inlined",
			result: "instructions",
			reason: "pi-durable configure() has one instructions string.",
		});
	}
	for (const [index, skill] of definition.skills.entries()) {
		const text = options.readSkill?.(skill);
		if (text === undefined && !skill.required) {
			entries.push({
				path: `skills[${index}]`,
				action: "dropped",
				reason: `The optional skill "${skill.name}" could not be read.`,
			});
			continue;
		}
		if (text === undefined) {
			diagnostics.push(diagnostic("skill-missing", `skills[${index}]`, `The skill "${skill.name}" could not be read.`));
			continue;
		}
		parts.push(`## Skill: ${skill.name}\n\n${text}`);
		entries.push({
			path: `skills[${index}]`,
			action: "inlined",
			result: "instructions",
			reason: "pi-durable configure() has no skill slot.",
		});
	}
	parts.push(definition.instructions.text);
	return parts.join("\n\n");
}

function drop(entries: LoweringEntry[], path: string, reason: string): void {
	entries.push({ path, action: "dropped", reason });
}

function unsupportedFields(definition: AgentDefinition, entries: LoweringEntry[]): void {
	drop(entries, "context.project", "The pi-durable host owns project context loading.");
	drop(entries, "context.user", "The pi-durable host owns user context loading.");
	drop(entries, "context.skills", "The pi-durable host owns inherited skill loading.");
	if (definition.context.files.length > 0)
		drop(entries, "context.files", "The caller must resolve and add context files before the run.");
	if (definition.effort.min !== null)
		drop(entries, "effort.min", "pi-durable configure() has no minimum thinking level.");
	if (definition.effort.max !== null)
		drop(entries, "effort.max", "pi-durable configure() has no maximum thinking level.");
	if (definition.version !== null) drop(entries, "version", "pi-durable configure() has no definition version field.");
	if (definition.services.length > 0) drop(entries, "services", "The caller must provide required services.");
	if (definition.requires.length > 0) drop(entries, "requires", "The caller must satisfy external requirements.");
	if (!definition.invocation.model)
		drop(entries, "invocation.model", "pi-durable configure() cannot hide model invocation.");
	if (!definition.invocation.user)
		drop(entries, "invocation.user", "pi-durable configure() cannot hide user invocation.");
	if (definition.license !== null) drop(entries, "license", "pi-durable configure() has no license field.");
	if (Object.keys(definition.metadata).length > 0)
		drop(entries, "metadata", "pi-durable configure() has no metadata field.");
}

function approveRestriction(
	path: string,
	options: PiDurableOptions,
	entries: LoweringEntry[],
	diagnostics: Diagnostic[],
): void {
	if (options.enforcedBy?.includes(path) === true) {
		entries.push({ path, action: "dropped", reason: "enforced by the caller" });
		return;
	}
	if (options.downgrade?.paths.includes(path) === true && options.downgrade.approvedBy.trim().length > 0) {
		entries.push({
			path,
			action: "weakened",
			reason: `Downgrade approved by "${options.downgrade.approvedBy}".`,
		});
		return;
	}
	refuseRestriction(path, diagnostics);
}

function refuseRestriction(path: string, diagnostics: Diagnostic[]): void {
	diagnostics.push(
		diagnostic(
			"restriction-unenforced",
			path,
			`pi-durable configure() cannot enforce "${path}"; name a caller enforcer or an approved downgrade.`,
		),
	);
}

function applyRestrictions(
	definition: AgentDefinition,
	options: PiDurableOptions,
	unexpressibleDisallowedTools: boolean,
	entries: LoweringEntry[],
	diagnostics: Diagnostic[],
): void {
	if (!(definition.agents.length === 1 && definition.agents[0] === "*"))
		approveRestriction("agents", options, entries, diagnostics);
	if (definition.limits.maxTurns !== null) approveRestriction("limits.maxTurns", options, entries, diagnostics);
	if (definition.limits.timeoutMinutes !== null)
		approveRestriction("limits.timeoutMinutes", options, entries, diagnostics);
	if (definition.workspace.isolation !== "shared") {
		const downgrade = options.downgrade;
		const checked = checkIsolation({
			definition: definition.workspace.isolation,
			requested: "shared",
			...(downgrade?.paths.includes("workspace.isolation") === true
				? {
						grant: {
							kind: "isolation-downgrade" as const,
							from: definition.workspace.isolation,
							to: "shared" as const,
							approvedBy: downgrade.approvedBy,
						},
					}
				: {}),
		});
		if (options.enforcedBy?.includes("workspace.isolation") === true)
			entries.push({ path: "workspace.isolation", action: "dropped", reason: "enforced by the caller" });
		else if (checked.ok) {
			entries.push({
				path: "workspace.isolation",
				action: "weakened",
				reason: `Downgrade approved by "${checked.grant!.approvedBy}".`,
			});
		} else refuseRestriction("workspace.isolation", diagnostics);
	}
	if (definition.result.schema !== null) approveRestriction("result.schema", options, entries, diagnostics);
	if (definition.result.artifacts.length > 0) approveRestriction("result.artifacts", options, entries, diagnostics);
	if (unexpressibleDisallowedTools) approveRestriction("disallowedTools", options, entries, diagnostics);
}

/** Lower a canonical definition to the fields pi-durable configure() stores for one conversation. */
export function lowerToPiDurable(definition: AgentDefinition, options: PiDurableOptions): PiDurableLowering {
	const entries: LoweringEntry[] = [];
	const runtime = checkRuntime(definition, { runtime: "pi-durable", knownKeys: [] });
	if (!runtime.ok) return { ok: false, diagnostics: runtime.diagnostics, report: report(entries) };

	const diagnostics: Diagnostic[] = [];
	const model = selectModel(definition, options);
	if (model === undefined)
		diagnostics.push(
			diagnostic(
				"model-unavailable",
				"model",
				"No declared model is both available and qualified as provider/modelId.",
			),
		);

	const requestedTools =
		definition.tools === "inherit"
			? options.parentTools
			: definition.tools.flatMap((reference, index) => {
					const mapped = mappedTools(reference, options);
					if (mapped.length === 0)
						entries.push({
							path: `tools[${index}]`,
							action: "dropped",
							reason: `pi has no built-in tool for the portable name "${reference.portable}".`,
						});
					return mapped;
				});
	const disallowedMappings = definition.disallowedTools.map((reference) => mappedTools(reference, options));
	const disallowed = new Set(disallowedMappings.flat());
	const tools = unique(requestedTools)
		.filter((name) => !disallowed.has(name))
		.map((name) => ({ name }));
	const instructions = inlineInstructions(definition, options, entries, diagnostics);
	unsupportedFields(definition, entries);
	applyRestrictions(
		definition,
		options,
		disallowedMappings.some((mapping) => mapping.length === 0),
		entries,
		diagnostics,
	);

	const loweringReport = report(entries);
	if (diagnostics.length > 0) return { ok: false, diagnostics, report: loweringReport };
	return {
		ok: true,
		input: {
			model: model!,
			...(definition.effort.default === null ? {} : { thinkingLevel: thinkingLevel(definition.effort.default) }),
			tools,
			instructions,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		},
		report: loweringReport,
	};
}

function prepareRestrictions(definition: AgentDefinition, request: PrepareRequest): PrepareResult {
	if (request.runtime !== "pi-durable")
		return { ok: false, reason: 'This consumer prepares only runtime "pi-durable".' };
	const isolation = checkIsolation({
		definition: definition.workspace.isolation,
		requested: request.requestedIsolation,
		...(request.isolationGrant === undefined ? {} : { grant: request.isolationGrant }),
	});
	if (!isolation.ok) return { ok: false, reason: isolation.reason };
	const runtime = checkRuntime(definition, { runtime: "pi-durable", knownKeys: [] });
	if (!runtime.ok) return { ok: false, reason: runtime.diagnostics.map(({ code }) => code).join(", ") };
	for (const [path, present] of [
		["agents", !(definition.agents.length === 1 && definition.agents[0] === "*")],
		["workspace.isolation", definition.workspace.isolation !== "shared"],
		["limits.maxTurns", definition.limits.maxTurns !== null],
		["limits.timeoutMinutes", definition.limits.timeoutMinutes !== null],
		["result.schema", definition.result.schema !== null],
		["result.artifacts", definition.result.artifacts.length > 0],
	] as const) {
		if (present) return { ok: false, reason: `pi-durable cannot enforce "${path}".` };
	}
	if (definition.disallowedTools.some((reference) => mappedTools(reference, { parentTools: [] }).length === 0))
		return { ok: false, reason: 'pi-durable cannot enforce "disallowedTools".' };
	const enforced: ConformanceRestriction[] = [];
	if (definition.tools !== "inherit") enforced.push({ path: "tools", value: definition.tools });
	if (definition.disallowedTools.length > 0)
		enforced.push({ path: "disallowedTools", value: definition.disallowedTools });
	for (const [index, skill] of definition.skills.entries()) {
		if (skill.required) enforced.push({ path: `skills[${index}].required`, value: true });
	}
	for (const [runtimeName, runtimeOptions] of Object.entries(definition.runtimes)) {
		if (runtimeOptions.required) enforced.push({ path: `runtimes.${runtimeName}.required`, value: true });
	}
	return { ok: true, enforced };
}

export const piDurableConsumer: ConformanceConsumer = {
	name: "pi-durable",
	parse: parseDefinition,
	prepare: prepareRestrictions,
};
