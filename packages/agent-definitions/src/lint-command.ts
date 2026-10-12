import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { USAGE_EXIT, type Command } from "./cli.ts";
import { lintSource, type LintOptions, type LintResult } from "./lint.ts";

const USAGE =
	"Usage: agent-definitions lint [--json] [--models <file>] [--skills <dir>]... [--tools <file>] <path>...\n";

interface LintArguments {
	readonly json: boolean;
	readonly modelsFile?: string;
	readonly skillDirectories: string[];
	readonly toolsFile?: string;
	readonly paths: string[];
}

interface FileResult extends LintResult {
	readonly file: string;
}

function optionValue(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined) throw new Error(`${flag} needs a value.`);
	return value;
}

function parseArguments(args: readonly string[]): LintArguments {
	let json = false;
	let modelsFile: string | undefined;
	let toolsFile: string | undefined;
	const skillDirectories: string[] = [];
	const paths: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === "--json") {
			json = true;
		} else if (argument === "--models") {
			modelsFile = optionValue(args, index, argument);
			index += 1;
		} else if (argument === "--skills") {
			skillDirectories.push(optionValue(args, index, argument));
			index += 1;
		} else if (argument === "--tools") {
			toolsFile = optionValue(args, index, argument);
			index += 1;
		} else if (argument.startsWith("-")) {
			throw new Error(`Unknown flag "${argument}".`);
		} else {
			paths.push(argument);
		}
	}
	if (paths.length === 0) throw new Error("At least one path is required.");
	return {
		json,
		...(modelsFile === undefined ? {} : { modelsFile }),
		skillDirectories,
		...(toolsFile === undefined ? {} : { toolsFile }),
		paths,
	};
}

function parseNameList(text: string, file: string): string[] {
	const trimmed = text.trim();
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
			throw new Error(`Availability file "${file}" must be a JSON array of strings.`);
		}
		return parsed;
	}
	return text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function readNameList(file: string, cwd: string): Promise<string[]> {
	const path = resolve(cwd, file);
	return parseNameList(await readFile(path, "utf8"), file);
}

function isChainFile(path: string): boolean {
	return path.endsWith(".chain.md");
}

async function collectFiles(inputs: readonly string[], cwd: string): Promise<string[]> {
	const files = new Set<string>();
	for (const input of inputs) {
		const path = resolve(cwd, input);
		const details = await stat(path);
		if (details.isDirectory()) {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith(".md") && !isChainFile(entry.name)) {
					files.add(resolve(path, entry.name));
				}
			}
		} else if (!isChainFile(path)) {
			files.add(path);
		}
	}
	return [...files].sort();
}

function counts(files: readonly FileResult[]): { errors: number; warnings: number; hints: number } {
	let errors = 0;
	let warnings = 0;
	let hints = 0;
	for (const { diagnostics } of files) {
		for (const { severity } of diagnostics) {
			if (severity === "error") errors += 1;
			else if (severity === "warning") warnings += 1;
			else hints += 1;
		}
	}
	return { errors, warnings, hints };
}

function textOutput(files: readonly FileResult[], totals: ReturnType<typeof counts>): string {
	const lines: string[] = [];
	for (const file of files) {
		for (const diagnostic of file.diagnostics) {
			const location = diagnostic.line === undefined ? file.file : `${file.file}:${diagnostic.line}`;
			lines.push(`${location}: ${diagnostic.severity} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
		}
	}
	lines.push(`${files.length} files, ${totals.errors} errors, ${totals.warnings} warnings, ${totals.hints} hints`);
	return `${lines.join("\n")}\n`;
}

/** Lint one or more definition files for use in local checks and CI. */
export const lintCommand: Command = async (args, io) => {
	try {
		const parsed = parseArguments(args);
		const [availableModels, availableTools, files] = await Promise.all([
			parsed.modelsFile === undefined ? undefined : readNameList(parsed.modelsFile, io.cwd),
			parsed.toolsFile === undefined ? undefined : readNameList(parsed.toolsFile, io.cwd),
			collectFiles(parsed.paths, io.cwd),
		]);
		const options: LintOptions = {
			...(availableModels === undefined ? {} : { availableModels }),
			...(availableTools === undefined ? {} : { availableTools }),
			...(parsed.skillDirectories.length === 0
				? {}
				: { skillDirectories: parsed.skillDirectories.map((directory) => resolve(io.cwd, directory)) }),
		};
		const results: FileResult[] = [];
		for (const path of files) {
			const file = relative(io.cwd, path);
			results.push({ file, ...lintSource(await readFile(path, "utf8"), options) });
		}
		const totals = counts(results);
		if (parsed.json) io.stdout(`${JSON.stringify({ files: results, ...totals })}\n`);
		else io.stdout(textOutput(results, totals));
		return totals.errors === 0 ? 0 : 1;
	} catch (error) {
		io.stderr(`${String(error)}\n${USAGE}`);
		return USAGE_EXIT;
	}
};
