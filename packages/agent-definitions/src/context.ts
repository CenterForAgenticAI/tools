import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentDefinition, Diagnostic } from "./definition.ts";

export interface ContextFilesResult {
	readonly ok: boolean;
	readonly files: { readonly path: string; readonly realPath: string }[];
	readonly diagnostics: Diagnostic[];
}

function contextFileDiagnostic(
	severity: Diagnostic["severity"],
	code: string,
	path: string,
	message: string,
): Diagnostic {
	return { severity, code, path, message };
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
	return candidate === workspace || candidate.startsWith(`${workspace}${sep}`);
}

/** Resolve declared context files without reading their contents. */
export async function resolveContextFiles(
	definition: AgentDefinition,
	options: { cwd: string },
): Promise<ContextFilesResult> {
	const workspace = await realpath(options.cwd);
	const files: ContextFilesResult["files"] = [];
	const diagnostics: Diagnostic[] = [];
	for (const [index, reference] of definition.context.files.entries()) {
		const diagnosticPath = `context.files[${index}]`;
		let filePath: string;
		try {
			filePath = await realpath(resolve(workspace, reference.path));
		} catch (cause: unknown) {
			if (Reflect.get(Object(cause), "code") !== "ENOENT") throw cause;
			const severity = reference.required ? "error" : "warning";
			const code = reference.required ? "context-file-required-missing" : "context-file-missing";
			diagnostics.push(
				contextFileDiagnostic(severity, code, diagnosticPath, `The context file "${reference.path}" is missing.`),
			);
			continue;
		}
		if (!isInsideWorkspace(workspace, filePath)) {
			diagnostics.push(
				contextFileDiagnostic(
					"error",
					"context-file-outside-workspace",
					diagnosticPath,
					`The context file "${reference.path}" resolves outside the workspace.`,
				),
			);
			continue;
		}
		if (!(await stat(filePath)).isFile()) {
			diagnostics.push(
				contextFileDiagnostic(
					"error",
					"context-file-not-a-file",
					diagnosticPath,
					`The context file "${reference.path}" is not a regular file.`,
				),
			);
			continue;
		}
		files.push({ path: reference.path, realPath: filePath });
	}
	return { ok: !diagnostics.some(({ severity }) => severity === "error"), files, diagnostics };
}
