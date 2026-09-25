import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { amendCriterion, type CriterionAmendmentFailureCode } from "../amend/index.js";
import { renderFinding, type Finding } from "../schema/findings.js";
import type { CriterionAmendment } from "../schema/workspec.js";
import { confinedPath } from "./confined-path.js";

export type WorkAmendCriterionFailureCode = CriterionAmendmentFailureCode | "absolute-path" | "read-error" | "write-error";

export interface WorkAmendCriterionDetails {
	path: string;
	criterionId: string;
	written: boolean;
	amendment?: CriterionAmendment;
	failure?: { code: WorkAmendCriterionFailureCode; message: string };
	findings: Finding[];
}

function failed(details: WorkAmendCriterionDetails): { content: [{ type: "text"; text: string }]; details: WorkAmendCriterionDetails } {
	const failure = details.failure;
	const header = `not amended: ${failure?.code ?? "unknown"}: ${failure?.message ?? "unknown failure"}`;
	return { content: [{ type: "text", text: [header, ...details.findings.map(renderFinding)].join("\n") }], details };
}

export const workAmendCriterionTool = defineTool({
	name: "work_amend_criterion",
	label: "Amend criterion",
	description: "Change one acceptance criterion through an append-only, authority-backed amendment record.",
	parameters: Type.Object({
		path: Type.String(),
		criterionId: Type.String(),
		before: Type.String(),
		after: Type.String(),
		reason: Type.String(),
		authority: Type.String(),
	}, { additionalProperties: false }),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const pathInput = confinedPath(params.path, "path");
		if (!pathInput.ok) {
			return failed({
				path: params.path,
				criterionId: params.criterionId,
				written: false,
				failure: { code: pathInput.finding.code, message: pathInput.finding.message },
				findings: [pathInput.finding],
			});
		}
		const filePath = path.resolve(ctx.cwd, pathInput.relativePath);
		let source: string;
		try {
			source = await readFile(filePath, "utf8");
		} catch (error) {
			return failed({
				path: filePath,
				criterionId: params.criterionId,
				written: false,
				failure: { code: "read-error", message: error instanceof Error ? error.message : String(error) },
				findings: [],
			});
		}
		const result = amendCriterion(source, {
			criterionId: params.criterionId,
			before: params.before,
			after: params.after,
			reason: params.reason,
			authority: params.authority,
			at: new Date().toISOString(),
		}, { specPath: filePath, cwd: ctx.cwd });
		if (!result.ok) {
			return failed({
				path: filePath,
				criterionId: params.criterionId,
				written: false,
				failure: { code: result.code, message: result.message },
				findings: result.findings,
			});
		}
		try {
			await writeFile(filePath, result.specSource, "utf8");
		} catch (error) {
			return failed({
				path: filePath,
				criterionId: params.criterionId,
				written: false,
				failure: { code: "write-error", message: error instanceof Error ? error.message : String(error) },
				findings: [],
			});
		}
		const details: WorkAmendCriterionDetails = {
			path: filePath,
			criterionId: params.criterionId,
			written: true,
			amendment: result.amendment,
			findings: [],
		};
		return {
			content: [{ type: "text" as const, text: `amended ${params.criterionId}: recorded ${JSON.stringify(params.before)} -> ${JSON.stringify(params.after)} at ${result.amendment.at}` }],
			details,
		};
	},
});
