import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type Finding, validateWorkspec } from "../schema/index.js";
import { renderFinding } from "../schema/findings.js";
import { createVerifier, type VerificationTarget } from "../verify/internal.js";
import type { VerificationCacheUpdate, VerificationFailure, VerificationResult } from "../verify/results.js";
import { resolveSpecPath } from "../verify/tree.js";
import { confinedPath } from "./confined-path.js";

const MAX_RENDERED_TEXT = 4000;

const ChecklistReportSchema = Type.Object({ index: Type.Integer(), done: Type.Boolean() }, { additionalProperties: false });
const WorkVerifyParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	nodeId: Type.String({ minLength: 1 }),
	worktreePath: Type.String({ minLength: 1 }),
	expectedCommit: Type.String({ minLength: 1 }),
	checklistReports: Type.Optional(Type.Array(ChecklistReportSchema)),
}, { additionalProperties: false });

export interface WorkVerifyDetails {
	path: string;
	nodeId: string;
	worktreePath: string;
	expectedCommit: string;
	outcome: "passed" | "failed";
	findings: Finding[];
	failures: VerificationFailure[];
	result?: VerificationResult;
	cacheUpdate?: VerificationCacheUpdate;
	truncated: boolean;
}

function render(details: WorkVerifyDetails): string {
	const lines = [`${details.outcome}: node ${details.nodeId}`, `tree: ${details.worktreePath}@${details.expectedCommit}`];
	// A path-input rejection is only actionable if the caller can see which path was
	// refused, so defer to the shared renderer that carries the message.
	for (const finding of details.findings) lines.push(finding.code === "absolute-path" ? renderFinding(finding) : `${finding.severity} ${finding.code}`);
	for (const failure of details.failures) lines.push(`failure ${failure.code}: ${failure.message}`);
	if (details.result) {
		lines.push(`criteria: ${details.result.criteria.length}`);
		lines.push(`checklist: ${details.result.checklist.outcome}`);
	}
	return lines.join("\n");
}

function resultPayload(details: WorkVerifyDetails): { content: [{ type: "text"; text: string }]; details: WorkVerifyDetails } {
	const rendered = render(details);
	if (rendered.length <= MAX_RENDERED_TEXT) return { content: [{ type: "text", text: rendered }], details };
	details.truncated = true;
	return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details };
}

function locateNode(nodes: readonly import("../schema/workspec.js").WorkNode[], id: string): import("../schema/workspec.js").WorkNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (Array.isArray(node.work)) {
			const found = locateNode(node.work, id);
			if (found) return found;
		}
	}
	return undefined;
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function failureDetails(params: { path: string; nodeId: string; worktreePath: string; expectedCommit: string }, failures: VerificationFailure[], findings: Finding[] = []): WorkVerifyDetails {
	return { ...params, outcome: "failed", findings, failures, truncated: false };
}

export function createWorkVerifyTool() {
	return defineTool({
		name: "work_verify",
		label: "Verify work node",
		description: "Execute a workspec node's evidence fail-closed in an explicitly identified worktree.",
		parameters: WorkVerifyParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pathInput = confinedPath(params.path, "path");
			if (!pathInput.ok) return resultPayload(failureDetails(params, [], [pathInput.finding]));
			const target: VerificationTarget = { worktreePath: params.worktreePath, expectedCommit: params.expectedCommit };
			const verifier = createVerifier({
				hasUI: ctx.hasUI === true,
				confirm: ctx.hasUI === true ? ctx.ui.confirm.bind(ctx.ui) : undefined,
				sessionManager: ctx.sessionManager,
			});
			const tree = await verifier.inspectTarget(target);
			if (!tree.ok) return resultPayload(failureDetails(params, [tree.failure]));
			const specPath = resolveSpecPath(tree.snapshot.identity.worktreePath, pathInput.relativePath);
			if (!inside(tree.snapshot.identity.worktreePath, specPath)) return resultPayload(failureDetails(params, [{ code: "tree-identity-unavailable", message: "spec path escapes the target worktree" }]));
			let source: string;
			let canonicalSpecPath: string;
			try {
				canonicalSpecPath = await realpath(specPath);
				if (!inside(tree.snapshot.identity.worktreePath, canonicalSpecPath)) return resultPayload(failureDetails(params, [{ code: "tree-identity-unavailable", message: "spec path symlink escapes the target worktree" }]));
				source = await readFile(canonicalSpecPath, "utf8");
			} catch (error) {
				const finding: Finding = { code: "read-error", severity: "error", path: ["path"], message: error instanceof Error ? error.message : String(error) };
				return resultPayload(failureDetails(params, [], [finding]));
			}
			const validation = validateWorkspec(source, { specPath: canonicalSpecPath, cwd: tree.snapshot.identity.worktreePath });
			if (!validation.structuralValid) return resultPayload(failureDetails(params, [], validation.findings));
			if (!validation.valid) return resultPayload(failureDetails(params, [], validation.findings));
			const node = locateNode(validation.spec.work, params.nodeId);
			if (!node) return resultPayload(failureDetails(params, [{ code: "no-execution-evidence", message: `unknown node ${params.nodeId}` }]));
			const verified = await verifier.verifyNodeAndCache({ node, specPath: params.path, target, checklistReports: params.checklistReports, signal });
			const { result, cacheUpdate } = verified;
			const details: WorkVerifyDetails = {
				...params,
				outcome: result.outcome,
				findings: [],
				failures: verifier.verificationFailures(result),
				result,
				...(cacheUpdate === undefined ? {} : { cacheUpdate }),
				truncated: false,
			};
			return resultPayload(details);
		},
	});
}

/** Exported for direct use; src/index.ts deliberately owns registration. */
export const workVerifyTool = createWorkVerifyTool();

export { MAX_RENDERED_TEXT, WorkVerifyParameters };
