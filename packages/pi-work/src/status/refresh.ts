import { validateWorkspec } from "../schema/index.js";
import { resolveSpecPath } from "../verify/tree.js";
import type { Finding } from "../schema/findings.js";
import { refreshBlocked, type RefreshBlocked, type RefreshRequest, type StatusRequest } from "./types.js";

/**
 * The v1 public verifier barrel is observational only. Keep this boundary typed
 * and fail closed instead of calling a tool wrapper or reconstructing authority.
 */
export async function refreshStatus(input: { readonly source: string; readonly request: StatusRequest; readonly specPath?: string; readonly refresh?: RefreshRequest; readonly cwd?: string }): Promise<RefreshBlocked | { readonly status: "invalid"; readonly findings: readonly Finding[] }> {
	const validation = validateWorkspec(input.source, { specPath: input.specPath ?? resolveSpecPath(input.request.worktreePath, input.request.path), cwd: input.cwd ?? input.request.worktreePath });
	if (!validation.structuralValid || !validation.valid) return { status: "invalid", findings: validation.findings };
	void input.request;
	void input.refresh;
	return refreshBlocked();
}

export function blockedRefresh(): RefreshBlocked {
	return refreshBlocked();
}
