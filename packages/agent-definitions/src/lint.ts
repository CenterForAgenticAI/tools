import { existsSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parseDefinition, type Diagnostic } from "./definition.ts";

export interface LintOptions {
	readonly availableModels?: readonly string[];
	readonly skillDirectories?: readonly string[];
	readonly availableTools?: readonly string[];
}

export interface LintResult {
	readonly ok: boolean;
	readonly diagnostics: Diagnostic[];
}

// Foreign field sources:
// https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md
// https://code.visualstudio.com/docs/copilot/customization/custom-agents
// https://developers.openai.com/codex/subagents/
const FOREIGN_FIELDS: Readonly<Record<string, string>> = {
	max_turns: "limits.maxTurns",
	maxTurns: "limits.maxTurns",
	timeout_mins: "limits.timeoutMinutes",
	"mcp-servers": "services",
	"disable-model-invocation": "invocation",
	"user-invocable": "invocation",
	model_reasoning_effort: "effort",
};

function withForeignSpellingHints(parserDiagnostics: readonly Diagnostic[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const hinted = new Set<string>();
	for (const diagnostic of parserDiagnostics) {
		diagnostics.push(diagnostic);
		const canonical = FOREIGN_FIELDS[diagnostic.path];
		if (canonical === undefined || hinted.has(diagnostic.path)) continue;
		hinted.add(diagnostic.path);
		diagnostics.push({
			...diagnostic,
			severity: "hint",
			code: "foreign-spelling",
			message: `Use the canonical field "${canonical}" instead of "${diagnostic.path}".`,
		});
	}
	return diagnostics;
}

function unavailableModel(model: string, index: number): Diagnostic {
	return {
		severity: "error",
		code: "model-unavailable",
		path: `model[${index}]`,
		message: `Model "${model}" is not available.`,
	};
}

function pathIsInside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path !== ".." && !path.startsWith(`..${sep}`);
}

function skillExists(name: string, directories: readonly string[]): boolean {
	return directories.some((directory) => {
		const root = resolve(directory);
		const candidate = resolve(root, name, "SKILL.md");
		if (!pathIsInside(root, candidate) || !existsSync(candidate)) return false;
		const realRoot = realpathSync(root);
		const realCandidate = realpathSync(candidate);
		return pathIsInside(realRoot, realCandidate) && statSync(realCandidate).isFile();
	});
}

/** Parse one agent definition and apply checks that depend on the current environment. */
export function lintSource(source: string, options: LintOptions): LintResult {
	const parsed = parseDefinition(source);
	const diagnostics = withForeignSpellingHints(parsed.diagnostics);

	if (parsed.ok) {
		if (options.availableModels !== undefined) {
			const available = new Set(options.availableModels);
			for (const [index, model] of parsed.definition.model.entries()) {
				if (model !== "inherit" && !available.has(model)) diagnostics.push(unavailableModel(model, index));
			}
		}

		if (options.skillDirectories !== undefined) {
			for (const [index, skill] of parsed.definition.skills.entries()) {
				if (!skillExists(skill.name, options.skillDirectories)) {
					diagnostics.push({
						severity: "error",
						code: "skill-missing",
						path: `skills[${index}]`,
						message: `Skill "${skill.name}" was not found in the configured skill directories.`,
					});
				}
			}
		}

		if (options.availableTools !== undefined && parsed.definition.tools !== "inherit") {
			const available = new Set(options.availableTools);
			for (const [index, tool] of parsed.definition.tools.entries()) {
				if (tool.portable === null && !available.has(tool.name)) {
					diagnostics.push({
						severity: "error",
						code: "tool-unknown",
						path: `tools[${index}]`,
						message: `Tool "${tool.name}" is not available.`,
					});
				}
			}
		}
	}

	return { ok: !diagnostics.some(({ severity }) => severity === "error"), diagnostics };
}
