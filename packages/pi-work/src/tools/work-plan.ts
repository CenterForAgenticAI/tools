import { readFile } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { validateWorkspec } from "../schema/index.js";
import { validationRootForSpec } from "../schema/validation-root.js";
import { errorCount, renderFinding, warningCount, type Finding } from "../schema/findings.js";
import { compileWorkPlan } from "../plan/compiler.js";
import type { NodeAddress, PlanAdvisory, PlanFinding, PlanReceipt } from "../plan/types.js";
import { confinedPath } from "./confined-path.js";

const MAX_RENDERED_TEXT = 4000;

export interface WorkPlanDetails {
	path: string;
	valid: boolean;
	errorCount: number;
	warningCount: number;
	findings: readonly (Finding | PlanFinding)[];
	plans: readonly PlanReceipt[];
	advisories: readonly PlanAdvisory[];
	worktree: boolean;
	truncated: boolean;
}

const parameters = Type.Object({
	path: Type.String(),
	nodeAddresses: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 }),
}, { additionalProperties: false });

function renderDetails(details: WorkPlanDetails): string {
	const header = `${details.valid ? "valid" : "invalid"}: ${details.errorCount} error(s), ${details.warningCount} warning(s), ${details.plans.length} plan(s), ${details.advisories.length} advisory(s)`;
	const readiness = "readiness: work_plan is not the readiness authority; use work_status before execution";
	const findings = details.findings.map((finding) => {
		if ("severity" in finding) {
			return renderFinding(finding);
		}
		return `error ${finding.code}: ${finding.message}`;
	}).join("\n");
	const receipts = details.plans.map((plan) => `${plan.nodeId} @ ${plan.briefPath} sha256=${plan.briefSha256}`).join("\n");
	const advisories = details.advisories.map((advisory) => {
		const overlaps = advisory.overlaps.map((overlap) => `${overlap.target} (${overlap.nodeIds.join(", ")})`).join("; ");
		return `advisory ${advisory.kind}: ${advisory.overlaps.length} overlap(s): ${overlaps}`;
	}).join("\n");
	return [header, readiness, findings, receipts, advisories].filter(Boolean).join("\n");
}

export const workPlanTool = defineTool({
	name: "work_plan",
	label: "Compile work plan",
	description: "Compile explicit ready Workspec node addresses into by-reference delegate plans without dispatching them.",
	parameters,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const pathInput = confinedPath(params.path, "path");
		if (!pathInput.ok) {
			const details: WorkPlanDetails = { path: params.path, valid: false, errorCount: 1, warningCount: 0, findings: [pathInput.finding], plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details);
		}
		const filePath = path.resolve(ctx.cwd, pathInput.relativePath);
		let source: string;
		try {
			source = await readFile(filePath, "utf8");
		} catch (error) {
			const finding: Finding = { code: "read-error", severity: "error", path: ["path"], message: error instanceof Error ? error.message : String(error) };
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: 1, warningCount: 0, findings: [finding], plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details);
		}
		const validation = validateWorkspec(source, { specPath: filePath, cwd: ctx.cwd });
		if (!validation.structuralValid) {
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: errorCount(validation.findings), warningCount: warningCount(validation.findings), findings: validation.findings, plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details);
		}
		if (!validation.valid) {
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: errorCount(validation.findings), warningCount: warningCount(validation.findings), findings: validation.findings, plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details);
		}
		// Briefs and the delegate cwd belong to the spec's repository, not the caller's.
		const result = await compileWorkPlan(validation.spec, { cwd: validationRootForSpec(filePath, ctx.cwd), nodeAddresses: params.nodeAddresses as NodeAddress[] });
		const details: WorkPlanDetails = {
			path: filePath,
			valid: result.ok && validation.valid,
			errorCount: result.ok ? errorCount(validation.findings) : errorCount(validation.findings) + result.findings.length,
			warningCount: warningCount(validation.findings),
			findings: result.ok ? validation.findings : [...validation.findings, ...result.findings],
			plans: result.plans,
			advisories: result.advisories,
			worktree: result.ok ? result.worktree : false,
			truncated: false,
		};
		return makeResponse(details);
	},
});

function makeResponse(details: WorkPlanDetails): { content: [{ type: "text"; text: string }]; details: WorkPlanDetails } {
	const rendered = renderDetails(details);
	if (rendered.length > MAX_RENDERED_TEXT) {
		details.truncated = true;
		return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details };
	}
	return { content: [{ type: "text", text: rendered }], details };
}

export { MAX_RENDERED_TEXT };
