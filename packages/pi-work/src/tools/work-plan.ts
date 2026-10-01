import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
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
const CONTINUATION_MARKER = "… output truncated; rerun work_plan with responseOffset=";

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
	nextResponseOffset?: number;
	responseSnapshot?: string;
	continuationError?: { code: "response-offset-out-of-range" | "response-snapshot-required" | "response-snapshot-mismatch" | "response-offset-not-issued"; message: string };
}

const parameters = Type.Object({
	path: Type.String(),
	nodeAddresses: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 }),
	responseOffset: Type.Optional(Type.Integer({ minimum: 0 })),
	responseSnapshot: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
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
	// Advisory gates must appear before potentially numerous receipt lines.
	return [header, readiness, findings, advisories, receipts].filter(Boolean).join("\n");
}

export const workPlanTool = defineTool({
	name: "work_plan",
	label: "Compile work plan",
	description: "Compile explicit ready Workspec node addresses into by-reference delegate plans without dispatching them.",
	parameters,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const responseOffset = params.responseOffset ?? 0;
		const responseSnapshot = params.responseSnapshot;
		const pathInput = confinedPath(params.path, "path", "working-directory");
		if (!pathInput.ok) {
			const details: WorkPlanDetails = { path: params.path, valid: false, errorCount: 1, warningCount: 0, findings: [pathInput.finding], plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details, responseOffset, responseSnapshot);
		}
		const filePath = path.resolve(ctx.cwd, pathInput.relativePath);
		let source: string;
		try {
			source = await readFile(filePath, "utf8");
		} catch (error) {
			const finding: Finding = { code: "read-error", severity: "error", path: ["path"], message: error instanceof Error ? error.message : String(error) };
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: 1, warningCount: 0, findings: [finding], plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details, responseOffset, responseSnapshot);
		}
		const validation = validateWorkspec(source, { specPath: filePath, cwd: ctx.cwd });
		if (!validation.structuralValid) {
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: errorCount(validation.findings), warningCount: warningCount(validation.findings), findings: validation.findings, plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details, responseOffset, responseSnapshot);
		}
		if (!validation.valid) {
			const details: WorkPlanDetails = { path: filePath, valid: false, errorCount: errorCount(validation.findings), warningCount: warningCount(validation.findings), findings: validation.findings, plans: [], advisories: [], worktree: false, truncated: false };
			return makeResponse(details, responseOffset, responseSnapshot);
		}
		// Briefs and delegate cwd belong to the spec repository. Canonicalize even
		// before its .work directory exists, so the first page and later pages use
		// the same filesystem identity on hosts with aliases such as /var.
		const planRoot = await realpath(validationRootForSpec(filePath, ctx.cwd));
		const result = await compileWorkPlan(validation.spec, { cwd: planRoot, nodeAddresses: params.nodeAddresses as NodeAddress[] });
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
		return makeResponse(details, responseOffset, responseSnapshot, source);
	},
});

function continuationError(details: WorkPlanDetails, code: NonNullable<WorkPlanDetails["continuationError"]>["code"], message: string): { content: [{ type: "text"; text: string }]; details: WorkPlanDetails } {
	return { content: [{ type: "text", text: `invalid work_plan continuation: ${message}` }], details: { ...details, continuationError: { code, message } } };
}

function makeResponse(details: WorkPlanDetails, responseOffset: number, responseSnapshot: string | undefined, source = ""): { content: [{ type: "text"; text: string }]; details: WorkPlanDetails } {
	const rendered = renderDetails(details);
	const snapshot = createHash("sha256").update(source).update("\0").update(rendered).digest("hex");
	if (responseOffset >= rendered.length) return continuationError(details, "response-offset-out-of-range", `response offset ${responseOffset} is outside rendering length ${rendered.length}`);
	if (responseOffset > 0 && responseSnapshot === undefined) return continuationError(details, "response-snapshot-required", "responseSnapshot is required when responseOffset resumes a truncated rendering");
	if (responseOffset > 0 && responseSnapshot !== snapshot) return continuationError(details, "response-snapshot-mismatch", "response snapshot does not match the rendering that produced this cursor");
	const markerBudget = CONTINUATION_MARKER.length + String(rendered.length).length + "&responseSnapshot=".length + snapshot.length + 1;
	const pageEnd = (start: number): number => {
		const endAtCap = Math.min(rendered.length, start + MAX_RENDERED_TEXT - markerBudget);
		const lastNewline = rendered.lastIndexOf("\n", endAtCap);
		return endAtCap < rendered.length && lastNewline >= start ? lastNewline + 1 : endAtCap;
	};
	if (responseOffset > 0) {
		let issued = 0;
		while (issued < responseOffset) issued = pageEnd(issued);
		if (issued !== responseOffset) return continuationError(details, "response-offset-not-issued", `response offset ${responseOffset} was not issued as a page boundary`);
	}
	const end = pageEnd(responseOffset);
	const page = rendered.slice(responseOffset, end);
	if (end < rendered.length) {
		const marker = `${CONTINUATION_MARKER}${end}&responseSnapshot=${snapshot}`;
		return { content: [{ type: "text", text: `${page}${page.endsWith("\n") ? "" : "\n"}${marker}` }], details: { ...details, truncated: true, nextResponseOffset: end, responseSnapshot: snapshot } };
	}
	return { content: [{ type: "text", text: page }], details: { ...details, ...(responseOffset > 0 ? { responseSnapshot: snapshot } : {}) } };
}

export { MAX_RENDERED_TEXT };
