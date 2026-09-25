import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	CRITERIA_FORMAT,
	parseDraft,
	promoteDraft,
	type PromotionFinding,
} from "../promote/index.js";
import type { PathInputFinding } from "../schema/findings.js";
import { confinedPath } from "./confined-path.js";

const MAX_RENDERED_TEXT = 4000;

export type WorkPromoteFinding = PromotionFinding | PathInputFinding;

export interface WorkPromoteDetails {
	draftPath: string;
	specPath: string;
	valid: boolean;
	written: boolean;
	errorCount: number;
	warningCount: number;
	findings: WorkPromoteFinding[];
	truncated: boolean;
}

function counts(findings: readonly WorkPromoteFinding[]): { errorCount: number; warningCount: number } {
	return {
		errorCount: findings.filter((finding) => finding.severity === "error").length,
		warningCount: findings.filter((finding) => finding.severity === "warning").length,
	};
}

function renderFindings(details: WorkPromoteDetails): string {
	const status = details.valid ? "promoted" : "not promoted";
	const header = `${status}: ${details.errorCount} error(s), ${details.warningCount} warning(s)`;
	const nextStep = details.written
		? "promoted workspec is intentionally incomplete; decomposition is required next before it can validate"
		: undefined;
	return [header, nextStep, ...details.findings.map((finding) => `${finding.severity} ${finding.code} at ${formatPath(finding.path)}: ${finding.message}`)]
		.filter((line) => line !== undefined)
		.join("\n");
}

function formatPath(pathSegments: readonly (string | number)[]): string {
	return pathSegments.length === 0 ? "$" : `$${pathSegments.map((segment) => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("")}`;
}

function finalResult(details: WorkPromoteDetails): { content: [{ type: "text"; text: string }]; details: WorkPromoteDetails } {
	const rendered = renderFindings(details);
	if (rendered.length <= MAX_RENDERED_TEXT) return { content: [{ type: "text", text: rendered }], details };
	details.truncated = true;
	return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details };
}

export const workPromoteTool = defineTool({
	name: "work_promote",
	label: "Promote draft",
	description: "Losslessly promote a marked Markdown draft into a Workspec YAML skeleton.",
	parameters: Type.Object({ draftPath: Type.String(), specPath: Type.String() }, { additionalProperties: false }),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const draftInput = confinedPath(params.draftPath, "draftPath");
		const specInput = confinedPath(params.specPath, "specPath");
		if (!draftInput.ok || !specInput.ok) {
			const findings = [
				...(draftInput.ok ? [] : [draftInput.finding]),
				...(specInput.ok ? [] : [specInput.finding]),
			];
			const count = counts(findings);
			return finalResult({
				draftPath: draftInput.ok ? path.resolve(ctx.cwd, draftInput.relativePath) : params.draftPath,
				specPath: specInput.ok ? path.resolve(ctx.cwd, specInput.relativePath) : params.specPath,
				valid: false,
				written: false,
				...count,
				findings,
				truncated: false,
			});
		}
		const draftRelative = draftInput.relativePath;
		const specRelative = specInput.relativePath;
		const draftFile = path.resolve(ctx.cwd, draftRelative);
		const specFile = path.resolve(ctx.cwd, specRelative);
		let source: string;
		try {
			source = await readFile(draftFile, "utf8");
		} catch (error) {
			const findings: PromotionFinding[] = [{
				code: "read-error",
				severity: "error",
				path: ["draftPath"],
				message: error instanceof Error ? error.message : String(error),
				sourcePath: draftRelative,
				expectedFormat: CRITERIA_FORMAT,
			}];
			const count = counts(findings);
			return finalResult({ draftPath: draftFile, specPath: specFile, valid: false, written: false, ...count, findings, truncated: false });
		}
		const parsed = parseDraft(source, draftRelative);
		if (!parsed.ok) {
			const count = counts(parsed.findings);
			return finalResult({ draftPath: draftFile, specPath: specFile, valid: false, written: false, ...count, findings: parsed.findings, truncated: false });
		}
		const promoted = promoteDraft(parsed);
		if (!promoted.ok) {
			const count = counts(promoted.findings);
			return finalResult({ draftPath: draftFile, specPath: specFile, valid: false, written: false, ...count, findings: promoted.findings, truncated: false });
		}
		try {
			await writeFile(specFile, promoted.specSource, "utf8");
		} catch (error) {
			const findings = [...promoted.findings, {
				code: "write-error" as const,
				severity: "error" as const,
				path: ["specPath"] as const,
				message: error instanceof Error ? error.message : String(error),
				sourcePath: specRelative,
				expectedFormat: "specPath must name a writable destination.",
			}];
			const count = counts(findings);
			return finalResult({ draftPath: draftFile, specPath: specFile, valid: false, written: false, ...count, findings, truncated: false });
		}
		const count = counts(promoted.findings);
		return finalResult({ draftPath: draftFile, specPath: specFile, valid: true, written: true, ...count, findings: promoted.findings, truncated: false });
	},
});

export { MAX_RENDERED_TEXT };
