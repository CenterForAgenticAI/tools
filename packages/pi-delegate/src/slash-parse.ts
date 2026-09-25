import { THINKING_LEVELS, type ThinkingLevel } from "./thinking-policy.js";

export type DelegateSlashMode = "direct" | "supervised" | "chain";
export type DelegateManagementAction = "agents" | "chains" | "health";

export interface ParsedDelegateDispatch {
	kind: "dispatch";
	task: string;
	mode: DelegateSlashMode;
	agent: string;
	chainName?: string;
	foreground: boolean;
	worktree?: true;
	model?: string;
	thinking?: ThinkingLevel;
	skills: string[];
	cwd?: string;
}

export type ParsedDelegateArgs =
	| { kind: "help" }
	| { kind: "management"; action: DelegateManagementAction }
	| ParsedDelegateDispatch;

export type ParsedDelegateCancelArgs =
	| { kind: "picker" }
	| { kind: "help" }
	| { kind: "exact"; runId: string; entryName?: string };

export type SlashParseErrorCode =
	| "conflict"
	| "duplicate-option"
	| "invalid-value"
	| "missing-value"
	| "unclosed-quote"
	| "unknown-option"
	| "usage";

export interface SlashParseError {
	code: SlashParseErrorCode;
	position: number;
	context: string;
	message: string;
}

export type SlashParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: SlashParseError };

interface SlashToken {
	value: string;
	quoted: boolean;
	position: number;
}

function failure(
	input: string,
	code: SlashParseErrorCode,
	message: string,
	position = -1,
): SlashParseResult<never> {
	return { ok: false, error: { code, position, context: input, message } };
}

function quoteName(quote: string): string {
	return quote === '"' ? "double" : "single";
}

/** Split slash arguments without losing whether an option-like token was quoted. */
function tokenize(input: string): SlashParseResult<SlashToken[]> {
	const tokens: SlashToken[] = [];
	let index = 0;
	while (index < input.length) {
		while (index < input.length && /\s/.test(input[index]!)) index += 1;
		if (index >= input.length) break;

		const position = index;
		let value = "";
		let quoted = false;
		let quote: "'" | '"' | undefined;
		let quotePosition = -1;
		while (index < input.length) {
			const character = input[index]!;
			if (quote) {
				if (character === quote) {
					quote = undefined;
					index += 1;
					continue;
				}
				if (character === "\\") {
					if (index + 1 >= input.length) {
						return failure(input, "usage", `Dangling escape at position ${index}`, index);
					}
					value += input[index + 1]!;
					index += 2;
					continue;
				}
				value += character;
				index += 1;
				continue;
			}
			if ((character === "'" || character === '"') && value.length === 0) {
				quoted = true;
				quote = character;
				quotePosition = index;
				index += 1;
				continue;
			}
			if (/\s/.test(character)) break;
			if (character === "\\") {
				if (index + 1 >= input.length) {
					return failure(input, "usage", `Dangling escape at position ${index}`, index);
				}
				value += input[index + 1]!;
				index += 2;
				continue;
			}
			value += character;
			index += 1;
		}
		if (quote) {
			return failure(
				input,
				"unclosed-quote",
				`Unclosed ${quoteName(quote)} quote at position ${quotePosition} near \`${input}\``,
				quotePosition,
			);
		}
		tokens.push({ value, quoted, position });
	}
	return { ok: true, value: tokens };
}

/** Parse `/delegate-cancel [RUN_ID [ENTRY]]` without treating positional names as options. */
export function parseDelegateCancelArgs(
	rawInput: string,
): SlashParseResult<ParsedDelegateCancelArgs> {
	const input = rawInput.trim();
	if (!input) return { ok: true, value: { kind: "picker" } };

	const tokenResult = tokenize(input);
	if (tokenResult.ok !== true) return { ok: false, error: tokenResult.error };
	const tokens = tokenResult.value;
	if (!tokens[0]!.quoted && tokens[0]!.value === "--help") {
		if (tokens.length === 1) return { ok: true, value: { kind: "help" } };
		return failure(input, "usage", "--help must be used alone.", tokens[1]!.position);
	}
	if (tokens.length > 2) {
		return failure(input, "usage", "/delegate-cancel accepts at most RUN_ID and ENTRY.", tokens[2]!.position);
	}

	const runId = tokens[0]?.value ?? "";
	if (!runId) return failure(input, "usage", "RUN_ID must not be empty.", tokens[0]?.position);
	const entryName = tokens[1]?.value;
	if (entryName !== undefined && entryName.length === 0) {
		return failure(input, "usage", "ENTRY must not be empty.", tokens[1]!.position);
	}
	return {
		ok: true,
		value: entryName === undefined
			? { kind: "exact", runId }
			: { kind: "exact", runId, entryName },
	};
}

const MANAGEMENT_OPTIONS: Readonly<Record<string, DelegateManagementAction | "help">> = {
	"--agents": "agents",
	"--chains": "chains",
	"--health": "health",
	"--help": "help",
};

const VALUE_OPTIONS = new Set(["--agent", "--chain", "--model", "--thinking", "--skill", "--cwd"]);

/** Parse the task-first `/delegate` grammar into a dispatch or management action. */
export function parseDelegateArgs(rawInput: string): SlashParseResult<ParsedDelegateArgs> {
	const input = rawInput.trim();
	if (!input) return { ok: true, value: { kind: "help" } };

	const tokenResult = tokenize(input);
	if (tokenResult.ok !== true) return { ok: false, error: tokenResult.error };
	const tokens = tokenResult.value;
	const firstManagement = !tokens[0]?.quoted ? MANAGEMENT_OPTIONS[tokens[0]?.value ?? ""] : undefined;
	if (firstManagement) {
		if (tokens.length !== 1) {
			return failure(input, "conflict", "Management forms cannot be combined with a task or other options.");
		}
		return firstManagement === "help"
			? { ok: true, value: { kind: "help" } }
			: { ok: true, value: { kind: "management", action: firstManagement } };
	}

	const optionStart = tokens.findIndex((token) => !token.quoted && token.value.startsWith("--"));
	const taskTokens = optionStart === -1 ? tokens : tokens.slice(0, optionStart);
	const task = taskTokens.map((token) => token.value).join(" ").trim();
	const optionTokens = optionStart === -1 ? [] : tokens.slice(optionStart);

	let mode: DelegateSlashMode = "direct";
	let selector: string | undefined;
	let chainName: string | undefined;
	let agent = "delegate";
	let foreground = false;
	let worktree = false;
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;
	let cwd: string | undefined;
	const skills: string[] = [];
	const seen = new Set<string>();
	const chainIncompatible = new Set<string>();

	const duplicate = (option: string): SlashParseResult<never> | undefined => {
		if (seen.has(option)) return failure(input, "duplicate-option", `Option ${option} may only be supplied once.`);
		seen.add(option);
		return undefined;
	};
	const selectMode = (option: string, nextMode: DelegateSlashMode): SlashParseResult<never> | undefined => {
		if (selector) {
			return failure(
				input,
				"conflict",
				`Mode selectors are mutually exclusive; received ${selector} and ${option}.`,
			);
		}
		selector = option;
		mode = nextMode;
		return undefined;
	};

	for (let index = 0; index < optionTokens.length; index += 1) {
		const token = optionTokens[index]!;
		const option = token.value;
		if (token.quoted || !option.startsWith("--")) {
			return failure(input, "usage", `Unexpected argument after options: ${JSON.stringify(option)}.`, token.position);
		}
		if (MANAGEMENT_OPTIONS[option]) {
			return failure(input, "conflict", "Management forms cannot be combined with a task or other options.", token.position);
		}
		if (VALUE_OPTIONS.has(option)) {
			const valueToken = optionTokens[index + 1];
			if (
				!valueToken ||
				valueToken.value.length === 0 ||
				(!valueToken.quoted && valueToken.value.startsWith("--"))
			) {
				return failure(input, "missing-value", `${option} requires a value.`, token.position);
			}
			index += 1;
			const value = valueToken.value;
			switch (option) {
				case "--agent": {
					const error = duplicate(option);
					if (error) return error;
					agent = value;
					chainIncompatible.add(option);
					break;
				}
				case "--chain": {
					const error = selectMode(option, "chain");
					if (error) return error;
					chainName = value;
					break;
				}
				case "--model": {
					const error = duplicate(option);
					if (error) return error;
					model = value;
					chainIncompatible.add(option);
					break;
				}
				case "--thinking": {
					const error = duplicate(option);
					if (error) return error;
					const normalized = value.toLowerCase();
					if (!THINKING_LEVELS.includes(normalized as ThinkingLevel)) {
						return failure(
							input,
							"invalid-value",
							`Invalid thinking level ${JSON.stringify(value)}; expected one of ${THINKING_LEVELS.join(", ")}.`,
							valueToken.position,
						);
					}
					thinking = normalized as ThinkingLevel;
					chainIncompatible.add(option);
					break;
				}
				case "--skill":
					skills.push(value);
					chainIncompatible.add(option);
					break;
				case "--cwd": {
					const error = duplicate(option);
					if (error) return error;
					cwd = value;
					break;
				}
			}
			continue;
		}

		switch (option) {
			case "--direct": {
				const error = selectMode(option, "direct");
				if (error) return error;
				break;
			}
			case "--fork":
			case "--supervised": {
				const error = selectMode(option, "supervised");
				if (error) return error;
				break;
			}
			case "--foreground":
			case "--fg": {
				const error = duplicate("--foreground");
				if (error) return error;
				foreground = true;
				break;
			}
			case "--worktree": {
				const error = duplicate(option);
				if (error) return error;
				worktree = true;
				chainIncompatible.add(option);
				break;
			}
			default:
				return failure(input, "unknown-option", `Unknown option ${option}.`, token.position);
		}
	}

	if (!task) return failure(input, "usage", "A task is required before dispatch options.");
	if (worktree && cwd !== undefined) {
		return failure(input, "conflict", "--worktree cannot be combined with --cwd.");
	}
	if (chainName !== undefined && chainIncompatible.size > 0) {
		return failure(
			input,
			"conflict",
			`--chain only permits task, --cwd, and foreground control; remove ${[...chainIncompatible].join(", ")}.`,
		);
	}

	const dispatch: ParsedDelegateDispatch = {
		kind: "dispatch",
		task,
		mode,
		agent,
		foreground,
		skills,
	};
	if (chainName !== undefined) dispatch.chainName = chainName;
	if (worktree) dispatch.worktree = true;
	if (model !== undefined) dispatch.model = model;
	if (thinking !== undefined) dispatch.thinking = thinking;
	if (cwd !== undefined) dispatch.cwd = cwd;
	return { ok: true, value: dispatch };
}
