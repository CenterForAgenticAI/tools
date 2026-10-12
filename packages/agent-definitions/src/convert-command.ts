import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseDefinition, type AgentDefinition } from "./definition.ts";
import { USAGE_EXIT, type Command } from "./cli.ts";
import { findFormat } from "./formats/index.ts";
import { formatLoweringReport, type ExportResult, type ImportResult, type LoweringReport } from "./report.ts";
import { writeDefinition } from "./write-definition.ts";

const usage = "Usage: agent-definitions convert --from <format> --to <format> [--write] [--json] <file>\n";
const canonicalFormat = "agent-definitions";

interface ConvertArguments {
	readonly from: string;
	readonly to: string;
	readonly file: string;
	readonly write: boolean;
	readonly json: boolean;
}

function parseArguments(args: readonly string[]): ConvertArguments | undefined {
	let from: string | undefined;
	let to: string | undefined;
	let file: string | undefined;
	let write = false;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (argument === "--from" || argument === "--to") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) return undefined;
			if (argument === "--from") {
				if (from !== undefined) return undefined;
				from = value;
			} else {
				if (to !== undefined) return undefined;
				to = value;
			}
			index += 1;
		} else if (argument === "--write") {
			if (write) return undefined;
			write = true;
		} else if (argument === "--json") {
			if (json) return undefined;
			json = true;
		} else if (argument.startsWith("-") || file !== undefined) return undefined;
		else file = argument;
	}
	return from === undefined || to === undefined || file === undefined ? undefined : { from, to, file, write, json };
}

function knownFormat(name: string): boolean {
	return name === canonicalFormat || findFormat(name) !== undefined;
}

function canonicalImport(source: string, file: string): ImportResult {
	const parsed = parseDefinition(source, { file });
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	return {
		ok: true,
		definition: parsed.definition,
		diagnostics: parsed.diagnostics,
		report: { target: canonicalFormat, direction: "import", entries: [] },
	};
}

function canonicalExport(definition: AgentDefinition): ExportResult {
	return {
		files: [{ path: `${definition.name}.md`, text: writeDefinition(definition) }],
		report: { target: canonicalFormat, direction: "export", entries: [] },
	};
}

function renderDiagnostic(diagnostic: { severity: string; code: string; path: string; message: string }): string {
	const location = diagnostic.path.length === 0 ? "" : ` ${diagnostic.path}`;
	return `${diagnostic.severity} ${diagnostic.code}${location}: ${diagnostic.message}\n`;
}

function targetInside(cwd: string, path: string): string | undefined {
	const target = resolve(cwd, path);
	const fromCwd = relative(resolve(cwd), target);
	return fromCwd.startsWith(`..${sep}`) ? undefined : target;
}

async function writeOutputs(
	files: ExportResult["files"],
	cwd: string,
	stderr: (text: string) => void,
): Promise<boolean> {
	const targets: { path: string; target: string; text: string }[] = [];
	for (const file of files) {
		const target = targetInside(cwd, file.path);
		if (target === undefined) {
			stderr(`Refusing to write outside the working directory: "${file.path}".\n`);
			return false;
		}
		targets.push({ path: file.path, target, text: file.text });
	}
	for (const file of targets) {
		await mkdir(dirname(file.target), { recursive: true });
		try {
			await writeFile(file.target, file.text, { flag: "wx" });
		} catch {
			stderr(`Refusing to overwrite existing file "${file.path}".\n`);
			return false;
		}
	}
	return true;
}

export const convertCommand: Command = async (args, io) => {
	const parsedArgs = parseArguments(args);
	if (parsedArgs === undefined || !knownFormat(parsedArgs.from) || !knownFormat(parsedArgs.to)) {
		io.stderr(usage);
		return USAGE_EXIT;
	}

	let source: string;
	try {
		source = await readFile(resolve(io.cwd, parsedArgs.file), "utf8");
	} catch (error) {
		io.stderr(`Cannot read "${parsedArgs.file}": ${String(error)}\n`);
		return 1;
	}
	const imported =
		parsedArgs.from === canonicalFormat
			? canonicalImport(source, parsedArgs.file)
			: findFormat(parsedArgs.from)!.import!(source, { file: parsedArgs.file });
	if (!imported.ok) {
		for (const diagnostic of imported.diagnostics) io.stderr(renderDiagnostic(diagnostic));
		return 1;
	}
	const exported =
		parsedArgs.to === canonicalFormat
			? canonicalExport(imported.definition)
			: findFormat(parsedArgs.to)!.export!(imported.definition);
	const reports: readonly LoweringReport[] = [imported.report, exported.report];

	if (parsedArgs.write && !(await writeOutputs(exported.files, io.cwd, io.stderr))) return 1;
	if (parsedArgs.json) {
		io.stdout(`${JSON.stringify({ files: exported.files, reports }, null, 2)}\n`);
		return 0;
	}
	for (const file of exported.files) {
		if (parsedArgs.write) io.stdout(`Wrote ${file.path}\n`);
		else io.stdout(`${file.path}\n${file.text}${file.text.endsWith("\n") ? "" : "\n"}`);
	}
	for (const report of reports) io.stdout(formatLoweringReport(report));
	return 0;
};
