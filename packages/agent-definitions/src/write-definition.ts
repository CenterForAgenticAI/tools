import type {
	AgentDefinition,
	ArtifactReference,
	ContextFileReference,
	RuntimeOptions,
	SkillReference,
	ToolReference,
} from "./definition.ts";
import { joinFrontmatter } from "./frontmatter.ts";

function hasKeys(value: Readonly<Record<string, unknown>>): boolean {
	return Object.values(value).some((entry) => entry !== undefined);
}

function toolNames(tools: readonly ToolReference[]): string[] {
	return tools.map(({ name }) => name);
}

function writeContextFile(file: ContextFileReference): string | { path: string; required: true } {
	return file.required ? { path: file.path, required: true } : file.path;
}

function writeSkill(skill: SkillReference): string | Readonly<Record<string, unknown>> {
	if (skill.source === null && skill.version === null && skill.required) return skill.name;
	return {
		name: skill.name,
		source: skill.source ?? undefined,
		version: skill.version ?? undefined,
		required: skill.required ? undefined : false,
	};
}

function writeArtifact(artifact: ArtifactReference): string | Readonly<Record<string, unknown>> {
	return artifact.check === null ? artifact.path : { path: artifact.path, check: artifact.check };
}

function writeRuntime(runtime: RuntimeOptions): Readonly<Record<string, unknown>> {
	const { required, ...fields } = runtime;
	return required ? { ...fields, required: true } : fields;
}

/** Write one parsed definition in canonical Agent Definitions authoring form. */
export function writeDefinition(definition: AgentDefinition): string {
	const instructions = {
		mode: definition.instructions.mode === "replace" ? undefined : definition.instructions.mode,
		include: definition.instructions.include.length === 0 ? undefined : definition.instructions.include,
	};
	const effort = {
		default: definition.effort.default ?? undefined,
		min: definition.effort.min ?? undefined,
		max: definition.effort.max ?? undefined,
	};
	const context = {
		project: definition.context.project ? undefined : false,
		user: definition.context.user ? undefined : false,
		skills: definition.context.skills ? undefined : false,
		files:
			definition.context.files.length === 0
				? undefined
				: definition.context.files.map((file) => writeContextFile(file)),
	};
	const workspace = {
		isolation: definition.workspace.isolation === "shared" ? undefined : definition.workspace.isolation,
	};
	const invocation = {
		model: definition.invocation.model ? undefined : false,
		user: definition.invocation.user ? undefined : false,
	};
	const limits = {
		maxTurns: definition.limits.maxTurns ?? undefined,
		timeoutMinutes: definition.limits.timeoutMinutes ?? undefined,
	};
	const result = {
		schema: definition.result.schema ?? undefined,
		artifacts:
			definition.result.artifacts.length === 0
				? undefined
				: definition.result.artifacts.map((artifact) => writeArtifact(artifact)),
	};
	const runtimes = Object.fromEntries(
		Object.entries(definition.runtimes).map(([name, runtime]) => [name, writeRuntime(runtime)]),
	);
	const fields = {
		name: definition.name,
		description: definition.description,
		version: definition.version ?? undefined,
		instructions: hasKeys(instructions) ? instructions : undefined,
		model:
			definition.model.length === 1 && definition.model[0] === "inherit"
				? undefined
				: definition.model.length === 1
					? definition.model[0]
					: definition.model,
		effort: hasKeys(effort) ? effort : undefined,
		context: hasKeys(context) ? context : undefined,
		tools: definition.tools === "inherit" ? undefined : toolNames(definition.tools),
		disallowedTools: definition.disallowedTools.length === 0 ? undefined : toolNames(definition.disallowedTools),
		agents: definition.agents.length === 0 ? undefined : definition.agents,
		skills: definition.skills.length === 0 ? undefined : definition.skills.map((skill) => writeSkill(skill)),
		services: definition.services.length === 0 ? undefined : definition.services,
		requires: definition.requires.length === 0 ? undefined : definition.requires,
		workspace: hasKeys(workspace) ? workspace : undefined,
		invocation: hasKeys(invocation) ? invocation : undefined,
		limits: hasKeys(limits) ? limits : undefined,
		result: hasKeys(result) ? result : undefined,
		runtimes: hasKeys(runtimes) ? runtimes : undefined,
		license: definition.license ?? undefined,
		metadata: hasKeys(definition.metadata) ? definition.metadata : undefined,
	};
	return joinFrontmatter(fields, definition.instructions.text);
}
