import * as fs from "node:fs";
import * as path from "node:path";
import { logDelegateDiagnostic, type DelegateDiagnosticOptions } from "./diagnostics.js";

export const PROJECT_CONFIG_RELATIVE_PATH = path.join(".pi", "pi-delegate.json");

export interface ProjectConfig {
	readonly artifactNameExceptions: readonly string[];
}

export type ProjectConfigDiagnostic = (
	message: string,
	options?: DelegateDiagnosticOptions,
) => void;

function noArtifactNameExceptions(): ProjectConfig {
	return { artifactNameExceptions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitDiagnostic(
	diagnostic: ProjectConfigDiagnostic,
	repositoryRoot: string,
	detail: string,
): void {
	try {
		diagnostic(
			`[delegate] ${detail}; repository artifact-name exceptions disabled`,
			{ level: "warn", throttleKey: `project-config:${repositoryRoot}` },
		);
	} catch {
		// Diagnostics are best-effort and must not weaken the write guard.
	}
}

function normalizedRepoPattern(value: string): string | undefined {
	if (value.length === 0 || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
		return undefined;
	}
	let normalized = value.replaceAll("\\", "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized.length === 0 || normalized.split("/").includes("..")) return undefined;
	try {
		path.matchesGlob("artifact-name-probe", normalized);
		return normalized;
	} catch {
		return undefined;
	}
}

/** Match a Git-root-relative path against validated repository-local exceptions. */
export function matchesArtifactNameException(
	relativePath: string,
	exceptions: readonly string[],
): boolean {
	let normalizedPath = relativePath.replaceAll("\\", "/");
	while (normalizedPath.startsWith("./")) normalizedPath = normalizedPath.slice(2);
	return exceptions.some((exception) => {
		const pattern = normalizedRepoPattern(exception);
		return pattern !== undefined && path.matchesGlob(normalizedPath, pattern);
	});
}

/**
 * Read `<git-root>/.pi/pi-delegate.json` without consulting user-level config.
 * Only the named field crosses this caller-controlled JSON boundary.
 */
export function loadProjectConfig(
	repositoryRoot: string,
	diagnostic: ProjectConfigDiagnostic = logDelegateDiagnostic,
): ProjectConfig {
	const file = path.join(path.resolve(repositoryRoot), PROJECT_CONFIG_RELATIVE_PATH);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		emitDiagnostic(diagnostic, repositoryRoot, "could not read repository .pi/pi-delegate.json");
		return noArtifactNameExceptions();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		emitDiagnostic(diagnostic, repositoryRoot, "ignoring invalid JSON in repository .pi/pi-delegate.json");
		return noArtifactNameExceptions();
	}
	if (!isRecord(parsed)) {
		emitDiagnostic(diagnostic, repositoryRoot, "ignoring invalid repository .pi/pi-delegate.json; expected an object");
		return noArtifactNameExceptions();
	}

	const artifactNameExceptions = parsed.artifactNameExceptions;
	if (!Array.isArray(artifactNameExceptions)) {
		emitDiagnostic(
			diagnostic,
			repositoryRoot,
			"ignoring invalid repository .pi/pi-delegate.json; artifactNameExceptions must contain only repo-relative paths or globs",
		);
		return noArtifactNameExceptions();
	}
	const copiedExceptions: string[] = [];
	for (const entry of artifactNameExceptions) {
		if (typeof entry !== "string" || normalizedRepoPattern(entry) === undefined) {
			emitDiagnostic(
				diagnostic,
				repositoryRoot,
				"ignoring invalid repository .pi/pi-delegate.json; artifactNameExceptions must contain only repo-relative paths or globs",
			);
			return noArtifactNameExceptions();
		}
		copiedExceptions.push(entry);
	}

	return { artifactNameExceptions: copiedExceptions };
}
