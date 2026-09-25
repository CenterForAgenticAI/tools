import { readFile } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { validateWorkspec, type Finding } from "../schema/index.js";
import { errorCount, renderFinding, warningCount } from "../schema/findings.js";
import { confinedPath } from "./confined-path.js";

const MAX_RENDERED_TEXT = 4000;

export interface WorkValidateDetails {
	path: string;
	valid: boolean;
	errorCount: number;
	warningCount: number;
	findings: Finding[];
	truncated: boolean;
}

export const workValidateTool = defineTool({
	name: "work_validate",
	label: "Validate workspec",
	description: "Parse and strictly validate a Workspec v2 YAML file.",
	parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const pathInput = confinedPath(params.path, "path");
		if (!pathInput.ok) {
			const details: WorkValidateDetails = {
				path: params.path,
				valid: false,
				errorCount: 1,
				warningCount: 0,
				findings: [pathInput.finding],
				truncated: false,
			};
			return { content: [{ type: "text", text: renderFindings(details) }], details };
		}
		const filePath = path.resolve(ctx.cwd, pathInput.relativePath);
		let source: string;
		try {
			source = await readFile(filePath, "utf8");
		} catch (error) {
			const finding: Finding = {
				code: "read-error",
				severity: "error",
				path: ["path"],
				message: error instanceof Error ? error.message : String(error),
			};
			const details: WorkValidateDetails = {
				path: filePath,
				valid: false,
				errorCount: 1,
				warningCount: 0,
				findings: [finding],
				truncated: false,
			};
			return { content: [{ type: "text", text: renderFindings(details) }], details };
		}
		const result = validateWorkspec(source, { specPath: filePath, cwd: ctx.cwd });
		const details: WorkValidateDetails = {
			path: filePath,
			valid: result.valid,
			errorCount: errorCount(result.findings),
			warningCount: warningCount(result.findings),
			findings: result.findings,
			truncated: false,
		};
		const rendered = renderFindings(details);
		if (rendered.length > MAX_RENDERED_TEXT) {
			details.truncated = true;
			return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details };
		}
		return { content: [{ type: "text", text: rendered }], details };
	},
});

function renderFindings(details: WorkValidateDetails): string {
	const status = details.valid
		? details.warningCount === 0 ? "valid (clean)" : "valid (with advisories)"
		: "invalid";
	const header = `${status}: ${details.errorCount} error(s), ${details.warningCount} warning(s)`;
	if (details.findings.length === 0) return header;
	const lines = details.findings.map(renderFinding);
	return [header, ...lines].join("\n");
}

export { MAX_RENDERED_TEXT };
