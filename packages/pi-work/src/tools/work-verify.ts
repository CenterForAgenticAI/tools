import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isCompositeNode } from "../schema/dependencies.js";
import { type Finding, validateWorkspec } from "../schema/index.js";
import { statusCachePath, writeVerificationCacheEntry } from "../status/cache.js";
import type { StatusCacheVerificationWriteResult } from "../status/types.js";
import { renderFinding } from "../schema/findings.js";
import { createVerifier, type VerificationTarget } from "../verify/internal.js";
import { redactCommandFailure } from "../verify/output.js";
import { captureEvidenceEnvironment } from "../verify/executable.js";
import type { VerificationCacheUpdate, VerificationFailure, VerificationResult } from "../verify/results.js";
import { resolveSpecPath } from "../verify/tree.js";
import { boundedTextWithHint, staleLoadCheck, type StaleLoadCheck } from "../load-identity.js";
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
	cacheWrite?: StatusCacheVerificationWriteResult;
	truncated: boolean;
	/** Present when the pi-work on disk differs from the one this process loaded. */
	restartHint?: string;
}

function render(details: WorkVerifyDetails): string {
	const lines = [`${details.outcome}: node ${details.nodeId}`, `tree: ${details.worktreePath}@${details.expectedCommit}`];
	for (const finding of details.findings) lines.push(renderFinding(finding));
	for (const failure of details.failures) lines.push(`failure ${failure.code}: ${failure.message}`);
	if (details.result) {
		lines.push(`criteria: ${details.result.criteria.length}`);
		lines.push(`checklist: ${details.result.checklist.outcome}`);
	}
	if (details.cacheWrite) lines.push(`cache: ${details.cacheWrite.status}`);
	return lines.join("\n");
}

function payload(details: WorkVerifyDetails, loadCheck: StaleLoadCheck): { content: [{ type: "text"; text: string }]; details: WorkVerifyDetails } {
	const restartHint = loadCheck.hint();
	if (restartHint !== undefined) details.restartHint = restartHint;
	const bounded = boundedTextWithHint(render(details), MAX_RENDERED_TEXT, restartHint);
	if (bounded.truncated) details.truncated = true;
	return { content: [{ type: "text", text: bounded.text }], details };
}

function locateNode(nodes: readonly import("../schema/workspec.js").WorkNode[], id: string, parent: readonly string[] = []): { node: import("../schema/workspec.js").WorkNode; address: string[] } | undefined {
	for (const node of nodes) {
		const address = [...parent, node.id];
		if (node.id === id) return { node, address };
		if (Array.isArray(node.work)) {
			const found = locateNode(node.work, id, address);
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
	return { path: params.path, nodeId: params.nodeId, worktreePath: params.worktreePath, expectedCommit: params.expectedCommit, outcome: "failed", findings, failures, truncated: false };
}

export interface WorkVerifyToolOptions {
	/** Defaults to the check for the pi-work copy this process loaded. */
	readonly loadCheck?: StaleLoadCheck;
}

export function createWorkVerifyTool(options: WorkVerifyToolOptions = {}) {
	const loadCheck = options.loadCheck ?? staleLoadCheck;
	const resultPayload = (details: WorkVerifyDetails) => payload(details, loadCheck);
	return defineTool({
		name: "work_verify",
		label: "Verify work node",
		description: "Execute a workspec node's evidence fail-closed in an explicitly identified worktree.",
		parameters: WorkVerifyParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pathInput = confinedPath(params.path, "path", "worktreePath");
			if (!pathInput.ok) return resultPayload(failureDetails(params, [], [pathInput.finding]));
			const target: VerificationTarget = { worktreePath: params.worktreePath, expectedCommit: params.expectedCommit };
			const verifier = createVerifier({
				hasUI: ctx.hasUI === true,
				confirm: ctx.hasUI === true ? ctx.ui.confirm.bind(ctx.ui) : undefined,
				sessionManager: ctx.sessionManager,
			});
			const tree = await verifier.inspectTarget(target);
			// The spec has not been read yet, so inherit_env names are unavailable.
			// Do not echo Git diagnostics that can contain a prior command's secret filename.
			if (!tree.ok) return resultPayload(failureDetails(params, [tree.failure.code === "tree-dirty"
				? { code: "tree-dirty", message: "target worktree is not clean" }
				: { code: "tree-identity-unavailable", message: `target worktree failed verifier preflight (${tree.failure.code})` }]));
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
			const located = locateNode(validation.spec.work, params.nodeId);
			if (!located) return resultPayload(failureDetails(params, [{ code: "no-execution-evidence", message: `unknown node ${params.nodeId}` }]));
			const names = validation.spec.work.flatMap(function collect(node): string[] {
				return [...(node.acceptance ?? []).flatMap((criterion) => criterion.evidence.kind === "command" ? criterion.evidence.inherit_env ?? [] : []), ...(isCompositeNode(node) ? node.work.flatMap(collect) : [])];
			});
			const inherited = captureEvidenceEnvironment([...new Set(names)]).inherited;
			const { result, cacheUpdate, cacheWrite } = await verifier.verifyNodeAndCache(
				{ node: located.node, address: located.address, specPath: canonicalSpecPath, source, target, inherited, checklistReports: params.checklistReports, signal },
				(update) => writeVerificationCacheEntry(statusCachePath(tree.snapshot.identity.worktreePath, canonicalSpecPath), canonicalSpecPath, tree.snapshot.identity.worktreePath, { address: located.address, update }),
			);
			const cacheFailure: VerificationFailure[] = cacheWrite !== undefined && cacheWrite.status !== "written"
				? [{ code: "verification-aborted", message: `verification cache ${cacheWrite.status}; result was not recorded` }] : [];
			const safeCacheWrite = cacheWrite === undefined || cacheWrite.status === "written" ? cacheWrite : { ...cacheWrite, message: redactCommandFailure(inherited, cacheWrite.message) };
			const details: WorkVerifyDetails = {
				path: params.path, nodeId: params.nodeId, worktreePath: params.worktreePath, expectedCommit: params.expectedCommit,
				outcome: cacheFailure.length > 0 ? "failed" : result.outcome,
				findings: [],
				failures: [...verifier.verificationFailures(result), ...cacheFailure],
				result,
				...(cacheUpdate === undefined ? {} : { cacheUpdate }),
				...(safeCacheWrite === undefined ? {} : { cacheWrite: safeCacheWrite }),
				truncated: false,
			};
			return resultPayload(details);
		},
	});
}

/** Exported for direct use; src/index.ts deliberately owns registration. */
export const workVerifyTool = createWorkVerifyTool();

export { MAX_RENDERED_TEXT, WorkVerifyParameters };
