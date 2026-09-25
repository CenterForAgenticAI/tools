import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { dispatchPlan, type DispatchDependencies, type DispatchFinding, type DispatchResult } from "../dispatch/index.js";
import { runGit } from "../git.js";
import { compileWorkPlan, type NodeAddress, type PlanFinding } from "../plan/index.js";
import { errorCount, renderFinding as renderSchemaFinding, type Finding } from "../schema/findings.js";
import { validateWorkspec } from "../schema/index.js";
import { statusCachePath } from "../status/cache.js";
import { inspectTree, resolveSpecPath, type VerificationFailure } from "../verify/index.js";
import { confinedPath } from "./confined-path.js";

export const MAX_RENDERED_TEXT = 4000;

const NodeAddressSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });
export const WorkDispatchParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	nodeAddress: NodeAddressSchema,
	worktreePath: Type.String({ minLength: 1 }),
	expectedCommit: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export type WorkDispatchPreflightFinding =
	| Finding
	| PlanFinding
	| VerificationFailure
	| { readonly code: "dispatch-input-invalid" | "dispatch-spec-read-error" | "dispatch-spec-path-escape" | "dispatch-branch-unavailable" | "dispatch-aborted"; readonly message: string };

interface WorkDispatchBase {
	readonly path: string;
	readonly nodeAddress: NodeAddress;
	readonly worktreePath: string;
	readonly expectedCommit: string;
	readonly truncated: boolean;
}

export type WorkDispatchDetails =
	| (WorkDispatchBase & { readonly outcome: "rejected"; readonly dispatchState: "not-dispatched"; readonly findings: readonly WorkDispatchPreflightFinding[] })
	| (WorkDispatchBase & DispatchResult);

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function preflightDetails(params: Partial<{ path: string; nodeAddress: NodeAddress; worktreePath: string; expectedCommit: string }>, findings: readonly WorkDispatchPreflightFinding[]): WorkDispatchDetails {
	return {
		path: params.path ?? "",
		nodeAddress: params.nodeAddress ?? [],
		worktreePath: params.worktreePath ?? "",
		expectedCommit: params.expectedCommit ?? "",
		outcome: "rejected",
		dispatchState: "not-dispatched",
		findings,
		truncated: false,
	};
}

async function currentBranch(gitPath: string, worktreePath: string): Promise<string> {
	const result = await runGit(gitPath, worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = result.stdout.trim();
	if (branch.length === 0) throw new Error("target worktree has no attached branch");
	return branch;
}

function renderFinding(finding: WorkDispatchPreflightFinding | DispatchFinding): string {
	if ("severity" in finding) return finding.code === "absolute-path" ? renderSchemaFinding(finding) : `${finding.severity} ${finding.code}`;
	return `finding ${finding.code}: ${finding.message}`;
}

function render(details: WorkDispatchDetails): string {
	const lines = [`${details.outcome}: ${details.nodeAddress.join(" /") || "no node"}`, `tree: ${details.worktreePath}@${details.expectedCommit}`];
	if ("plan" in details) lines.push(`plan: ${details.plan.briefPath} sha256=${details.plan.briefSha256}`);
	if (details.outcome === "dispatched") {
		lines.push(`dispatch: ${details.receipt.runId}/${details.receipt.forks[0]?.name ?? "unknown"}`);
		lines.push(`cache: ${details.cacheWrite.status}`);
	} else if (details.outcome === "degraded") lines.push("dispatch: unavailable; use the paste-ready plan receipt");
	else if (details.outcome === "indeterminate") lines.push("dispatch: indeterminate; do not retry automatically");
	for (const finding of details.findings) lines.push(renderFinding(finding));
	return lines.join("\n");
}

function response(details: WorkDispatchDetails): { content: [{ type: "text"; text: string }]; details: WorkDispatchDetails } {
	const rendered = render(details);
	if (rendered.length <= MAX_RENDERED_TEXT) return { content: [{ type: "text", text: rendered }], details };
	return { content: [{ type: "text", text: `${rendered.slice(0, MAX_RENDERED_TEXT - 24)}\n… output truncated` }], details: { ...details, truncated: true } };
}

export function createWorkDispatchTool(dependencies: DispatchDependencies = {}) {
	return defineTool({
		name: "work_dispatch",
		label: "Dispatch work node",
		description: "Compile and submit exactly one Workspec node through pi-delegate, or return a paste-ready degraded plan.",
		parameters: WorkDispatchParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const nodeAddress = params.nodeAddress as NodeAddress;
			const input = { path: params.path, nodeAddress, worktreePath: params.worktreePath, expectedCommit: params.expectedCommit };
			if (!params.path || !Array.isArray(nodeAddress) || nodeAddress.length === 0 || nodeAddress.some((segment) => typeof segment !== "string" || segment.length === 0) || !params.worktreePath || !params.expectedCommit) return response(preflightDetails(input, [{ code: "dispatch-input-invalid", message: "path, one qualified nodeAddress, worktreePath, and expectedCommit are required" }]));
			if (signal?.aborted) return response(preflightDetails(input, [{ code: "dispatch-aborted", message: "dispatch was aborted before planning" }]));
			const pathInput = confinedPath(params.path, "path");
			if (!pathInput.ok) return response(preflightDetails(input, [pathInput.finding]));

			const tree = await inspectTree(params.worktreePath, params.expectedCommit);
			if (!tree.ok) return response(preflightDetails(input, [tree.failure]));
			const root = tree.snapshot.identity.worktreePath;
			let branch: string;
			try {
				branch = await currentBranch(tree.snapshot.gitPath, root);
			} catch (error) {
				return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-branch-unavailable", message: error instanceof Error ? error.message : String(error) }]));
			}
			const authoredPath = resolveSpecPath(root, pathInput.relativePath);
			if (!inside(root, authoredPath)) return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-spec-path-escape", message: "spec path escapes the target worktree" }]));
			let specPath: string;
			let source: string;
			try {
				specPath = await realpath(authoredPath);
				if (!inside(root, specPath)) return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-spec-path-escape", message: "spec path symlink escapes the target worktree" }]));
				source = await readFile(specPath, "utf8");
			} catch (error) {
				return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-spec-read-error", message: error instanceof Error ? error.message : String(error) }]));
			}
			const validation = validateWorkspec(source, { specPath, cwd: root });
			if (!validation.structuralValid || !validation.valid || errorCount(validation.findings) > 0) return response(preflightDetails({ ...input, worktreePath: root }, validation.findings));
			const compiled = await compileWorkPlan(validation.spec, { cwd: root, nodeAddresses: [nodeAddress] });
			if (!compiled.ok) return response(preflightDetails({ ...input, worktreePath: root }, compiled.findings));
			const plan = compiled.plans[0];
			if (!plan) return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-input-invalid", message: "work_plan returned no plan for the selected node" }]));
			if (signal?.aborted) return response(preflightDetails({ ...input, worktreePath: root }, [{ code: "dispatch-aborted", message: "dispatch was aborted after planning and before submission" }]));
			const result = await dispatchPlan({
				plan,
				target: {
					worktreePath: root,
					headCommit: tree.snapshot.identity.resolvedCommit,
					branch,
					specPath,
					cachePath: statusCachePath(root, specPath),
				},
				context: ctx,
			}, dependencies);
			return response({ ...input, worktreePath: root, expectedCommit: tree.snapshot.identity.resolvedCommit, ...result, truncated: false });
		},
	});
}

/** Exported for direct use; src/index.ts deliberately owns registration. */
export const workDispatchTool = createWorkDispatchTool();
