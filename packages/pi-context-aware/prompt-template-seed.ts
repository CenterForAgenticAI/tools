import { readFileSync } from "node:fs";
import { parseFrontmatter, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export type PromptTemplateSeedResolution =
	| { kind: "literal"; seed: string }
	| {
		kind: "resolved";
		seed: string;
		invocation: string;
		commandName: string;
		templatePath: string;
	}
	| {
		kind: "error";
		seed: string;
		commandName: string;
		templatePath?: string;
		message: string;
	};

interface SlashCommandInvocation {
	commandName: string;
	argsText: string;
}

function parseSlashCommandInvocation(seed: string): SlashCommandInvocation | null {
	if (!seed.startsWith("/")) return null;
	const match = seed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match?.[1]) return null;
	return {
		commandName: match[1],
		argsText: match[2] ?? "",
	};
}

// Pi exposes prompt-command metadata but does not publicly export its argument
// helpers. Keep this behavior aligned with core/prompt-templates.ts.
function parseCommandArgs(argsText: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (const char of argsText) {
		if (inQuote !== null) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === "\"" || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

// One replacement pass is intentional: placeholder-looking argument text must
// not be expanded recursively.
function substitutePromptArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
					? allArgs
					: args[Number.parseInt(defaultTarget, 10) - 1];
				return value || defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
				if (sliceLength) {
					return args.slice(start, start + Number.parseInt(sliceLength, 10)).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple, 10) - 1] ?? "";
		},
	);
}

export function resolvePromptTemplateSeed(
	seed: string,
	commands: readonly SlashCommandInfo[],
): PromptTemplateSeedResolution {
	const invocation = parseSlashCommandInvocation(seed);
	if (invocation === null) return { kind: "literal", seed };

	const promptCommand = commands.find(
		(command) => command.source === "prompt" && command.name === invocation.commandName,
	);
	if (promptCommand === undefined) {
		const registeredCommand = commands.find((command) => command.name === invocation.commandName);
		if (registeredCommand !== undefined) {
			return {
				kind: "error",
				seed,
				commandName: invocation.commandName,
				message: `Cannot resolve /${invocation.commandName} as a compaction seed because it is a registered ${registeredCommand.source} command, not a prompt template.`,
			};
		}
		return { kind: "literal", seed };
	}

	const templatePath = promptCommand.sourceInfo.path;
	try {
		const raw = readFileSync(templatePath, "utf8");
		const body = parseFrontmatter(raw).body;
		const expanded = substitutePromptArgs(body, parseCommandArgs(invocation.argsText)).trim();
		if (!expanded) {
			return {
				kind: "error",
				seed,
				commandName: invocation.commandName,
				templatePath,
				message: `Prompt template /${invocation.commandName} expanded to an empty compaction seed.`,
			};
		}
		return {
			kind: "resolved",
			seed: expanded,
			invocation: seed,
			commandName: invocation.commandName,
			templatePath,
		};
	} catch (error) {
		return {
			kind: "error",
			seed,
			commandName: invocation.commandName,
			templatePath,
			message: `Failed to resolve prompt template /${invocation.commandName}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
