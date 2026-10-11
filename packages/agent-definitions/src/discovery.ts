import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDefinition, type AgentDefinition, type DefinitionOrigin, type Diagnostic } from "./definition.ts";

export interface DiscoveryOptions {
	readonly cwd: string;
	readonly home?: string;
	readonly userDirs?: string[];
	readonly packageDirs?: string[];
}

export interface DiscoveredFile {
	readonly file: string;
	readonly realPath: string;
	readonly origin: DefinitionOrigin;
	readonly dir: string;
}

export type FileDiagnostic = Diagnostic & { readonly file: string };

export interface LoadedDefinition {
	readonly definition: AgentDefinition;
	readonly file: string;
	readonly origin: DefinitionOrigin;
	readonly diagnostics: Diagnostic[];
}

export interface LoadResult {
	readonly definitions: LoadedDefinition[];
	readonly shadowed: { readonly name: string; readonly file: string; readonly by: string }[];
	readonly diagnostics: FileDiagnostic[];
}

interface DiscoveryResult {
	readonly files: DiscoveredFile[];
	readonly diagnostics: FileDiagnostic[];
}

interface DefinitionDirectory {
	readonly dir: string;
	readonly origin: DefinitionOrigin;
}

const originRank: Readonly<Record<DefinitionOrigin, number>> = { package: 0, user: 1, project: 2 };

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function findNearestProjectRoot(cwd: string, home: string): Promise<string | null> {
	let current = resolve(cwd);
	while (current !== home) {
		if ((await isDirectory(join(current, ".pi", "agents"))) || (await isDirectory(join(current, ".agents")))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

function absoluteDirectories(cwd: string, directories: readonly string[]): string[] {
	return directories.map((directory) => resolve(cwd, directory));
}

async function definitionDirectories(options: DiscoveryOptions): Promise<DefinitionDirectory[]> {
	const cwd = resolve(options.cwd);
	const home = resolve(options.home ?? homedir());
	const packageDirs = absoluteDirectories(cwd, options.packageDirs ?? []);
	const userDirs = absoluteDirectories(
		cwd,
		options.userDirs ?? [join(home, ".pi", "agent", "agents"), join(home, ".agents")],
	);
	const projectRoot = await findNearestProjectRoot(cwd, home);
	const projectDirs = projectRoot
		? [join(projectRoot, ".agents"), join(projectRoot, ".agents", "agents"), join(projectRoot, ".pi", "agents")]
		: [];
	return [
		...packageDirs.map((dir) => ({ dir, origin: "package" as const })),
		...userDirs.map((dir) => ({ dir, origin: "user" as const })),
		...projectDirs.map((dir) => ({ dir, origin: "project" as const })),
	];
}

async function canonicalFilePath(file: string): Promise<string | null> {
	try {
		const realPath = await realpath(file);
		return (await stat(realPath)).isFile() ? realPath : null;
	} catch {
		return null;
	}
}

function discoveryWarning(dir: string): FileDiagnostic {
	return {
		severity: "warning",
		code: "discovery-unreadable",
		path: "",
		message: `Cannot read definition directory "${dir}".`,
		file: dir,
	};
}

async function discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
	const candidates: DiscoveredFile[] = [];
	const diagnostics: FileDiagnostic[] = [];
	for (const { dir, origin } of await definitionDirectories(options)) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(discoveryWarning(dir));
			continue;
		}
		// The default sort compares code units, so the winner of a shared name does not depend on the locale.
		for (const name of entries.map((entry) => entry.name).sort()) {
			if (name.startsWith(".") || !name.endsWith(".md") || name.endsWith(".chain.md")) continue;
			const file = join(dir, name);
			const realPath = await canonicalFilePath(file);
			if (realPath !== null) candidates.push({ file, realPath, origin, dir });
		}
	}

	const winnersByRealPath = new Map<string, DiscoveredFile>();
	for (const candidate of candidates) winnersByRealPath.set(candidate.realPath, candidate);
	return {
		files: candidates.filter((candidate) => winnersByRealPath.get(candidate.realPath) === candidate),
		diagnostics,
	};
}

export async function discoverDefinitionFiles(options: DiscoveryOptions): Promise<DiscoveredFile[]> {
	return (await discover(options)).files;
}

export async function loadDefinitions(options: DiscoveryOptions): Promise<LoadResult> {
	const discovered = await discover(options);
	const diagnostics = [...discovered.diagnostics];
	const loaded: LoadedDefinition[] = [];
	for (const { file, origin } of discovered.files) {
		const parsed = parseDefinition(await readFile(file, "utf8"), { origin, file });
		diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, file })));
		if (parsed.ok) loaded.push({ definition: parsed.definition, file, origin, diagnostics: parsed.diagnostics });
	}

	const winners = new Map<string, LoadedDefinition>();
	for (const candidate of loaded) {
		const current = winners.get(candidate.definition.name);
		if (current === undefined || originRank[candidate.origin] >= originRank[current.origin]) {
			winners.set(candidate.definition.name, candidate);
		}
	}

	const shadowed: LoadResult["shadowed"] = [];
	for (const candidate of loaded) {
		const name = candidate.definition.name;
		const winner = winners.get(name)!;
		if (candidate === winner) continue;
		shadowed.push({ name, file: candidate.file, by: winner.file });
		diagnostics.push({
			severity: "hint",
			code: "definition-shadowed",
			path: name,
			message: `Definition "${name}" from "${candidate.file}" is shadowed by "${winner.file}".`,
			file: candidate.file,
		});
	}

	const definitions = [...winners.keys()].sort().map((name) => winners.get(name)!);
	return {
		definitions,
		shadowed,
		diagnostics,
	};
}
