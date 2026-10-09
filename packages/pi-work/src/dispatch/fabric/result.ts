import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { decodeDelegateRuntimeReceipt } from "../runtime.js";
import type { FabricDispatchReceipt } from "../types.js";
import type { StatusCacheDispatchEntry } from "../../status/types.js";
import type { FabricDigestInputs } from "./receipt.js";
import type { ChecklistReportInput, FabricResultFinding, FabricWorkerResult, NodeAddress, RefreshRequest } from "../../status/types.js";
import { dispatchFabricRun, type FabricRunDependencies, type FabricRunOptions, type FabricRunReceipt, type FabricRunResult } from "./run.js";

export const FABRIC_WORKER_RESULT_SCHEMA = {
	type: "object", additionalProperties: false,
	required: ["changedPaths", "commit", "evidence", "checklist", "gaps"],
	properties: {
		changedPaths: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
		commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
		evidence: { type: "string", minLength: 1 },
		checklist: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "done"], properties: { index: { type: "integer", minimum: 0 }, done: { type: "boolean" } } } },
		gaps: { type: "string" },
	},
} as const;

export type FabricWorkerResultValidation =
	| { readonly ok: true; readonly value: FabricWorkerResult }
	| { readonly ok: false; readonly finding: FabricResultFinding };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Validate direct schema output, not generated text or an arbitrary JSON fragment. */
export function validateFabricWorkerResult(value: unknown): FabricWorkerResultValidation {
	const invalid = (): FabricWorkerResultValidation => ({ ok: false, finding: { code: "fabric-result-invalid", message: "Fabric returned a malformed structured worker result; do not treat it as verification evidence" } });
	if (!record(value) || !exactKeys(value, ["changedPaths", "commit", "evidence", "checklist", "gaps"]) ||
		!Array.isArray(value.changedPaths) || !value.changedPaths.every((entry: unknown) => typeof entry === "string" && entry.length > 0 && !entry.includes("\\") && !entry.includes("\0") && !path.posix.isAbsolute(entry) && path.posix.normalize(entry) === entry && entry !== "." && entry !== ".." && !entry.startsWith("../") && !/^[A-Za-z]:/.test(entry)) ||
		new Set(value.changedPaths).size !== value.changedPaths.length ||
		typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit) ||
		typeof value.evidence !== "string" || value.evidence.trim().length === 0 || typeof value.gaps !== "string" || !Array.isArray(value.checklist)) return invalid();
	const checklist: ChecklistReportInput[] = [];
	for (const report of value.checklist) {
		if (!record(report) || !exactKeys(report, ["index", "done"]) || typeof report.index !== "number" || !Number.isSafeInteger(report.index) || report.index < 0 || typeof report.done !== "boolean" || checklist.some((entry) => entry.index === report.index)) return invalid();
		checklist.push({ index: report.index, done: report.done });
	}
	return { ok: true, value: { changedPaths: value.changedPaths.map((entry: string) => entry), commit: value.commit, evidence: value.evidence, checklist, gaps: value.gaps } };
}

export type StructuredFabricRunResult =
	| { readonly status: "completed"; readonly receipt: FabricRunReceipt; readonly workerResult: FabricWorkerResult }
	| { readonly status: "invalid"; readonly receipt: FabricRunReceipt; readonly finding: FabricResultFinding }
	| { readonly status: "failed"; readonly runResult: Exclude<FabricRunResult, { status: "dispatched" }> };

/** Always supplies the worker schema; callers cannot replace it with a looser one. */
export async function dispatchStructuredFabricRun(options: Omit<FabricRunOptions, "schema">, dependencies: FabricRunDependencies): Promise<StructuredFabricRunResult> {
	const run = await dispatchFabricRun({
		ref: options.ref, invocation: {
			name: options.invocation.name, task: options.invocation.task, worktree: options.invocation.worktree,
			confineWrites: options.invocation.confineWrites,
			...(options.invocation.cwd === undefined ? {} : { cwd: options.invocation.cwd }),
			...(options.invocation.model === undefined ? {} : { model: options.invocation.model }),
			...(options.invocation.writableRoots === undefined ? {} : { writableRoots: [...options.invocation.writableRoots] }),
		},
		projectRoot: options.projectRoot, trustedProject: options.trustedProject,
		...(options.globalConfigPath === undefined ? {} : { globalConfigPath: options.globalConfigPath }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
		...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
		schema: FABRIC_WORKER_RESULT_SCHEMA,
	}, dependencies);
	if (!("status" in run) || run.status !== "dispatched") return { status: "failed", runResult: run };
	const envelope = run.result.value;
	const parsed = validateFabricWorkerResult(record(envelope) && envelope.status === "completed" ? envelope.value : undefined);
	return parsed.ok ? { status: "completed", receipt: run.receipt, workerResult: parsed.value } : { status: "invalid", receipt: run.receipt, finding: parsed.finding };
}

function strings(value: unknown): value is string[] {
 return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** Only read artifacts within the owning cache; persisted accounting is untrusted. */
export async function readFabricDispatchResult(entry: StatusCacheDispatchEntry, cachePath: string, dispatchRoot: string = entry.worktreePath): Promise<{
 readonly receipt: FabricDispatchReceipt;
 readonly workerResult: FabricWorkerResult;
 readonly digestInputs: FabricDigestInputs;
} | undefined> {
 const root = path.join(path.dirname(cachePath), "fabric");
 const relative = path.relative(root, entry.receiptPath);
 if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
 async function confined(file: string): Promise<string> {
  const resolved = await realpath(file);
  const rel = path.relative(await realpath(root), resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Fabric artifact escapes cache storage");
  return resolved;
 }
 const raw: unknown = JSON.parse(await readFile(await confined(entry.receiptPath), "utf8"));
 const decoded = decodeDelegateRuntimeReceipt(raw);
 if (!record(raw) || raw.backend !== "fabric" || !decoded || decoded.runId !== entry.runId || decoded.forks.length !== 1 || decoded.forks[0]?.name !== entry.forkName || decoded.receiptPath !== entry.receiptPath || decoded.resultPath !== entry.resultPath) throw new Error("Fabric dispatch receipt is invalid");
 const resumeCount = raw.resumeCount;
 const totalAttempts = raw.totalAttempts;
 if (typeof resumeCount !== "number" || !Number.isInteger(resumeCount) || resumeCount < 0 || resumeCount > 3 || typeof totalAttempts !== "number" || totalAttempts !== resumeCount + 1) throw new Error("Fabric receipt attempts are invalid");
 const saved: unknown = JSON.parse(await readFile(await confined(entry.resultPath), "utf8"));
 if (!record(saved) || saved.runId !== entry.runId) throw new Error("Fabric result identity is invalid");
 const parsed = validateFabricWorkerResult(saved.workerResult);
 if (!parsed.ok) throw new Error(parsed.finding.message);
 const inputs = saved.digestInputs;
 if (!record(inputs) || inputs.briefPath !== entry.briefPath || typeof inputs.task !== "string") throw new Error("Fabric digest inputs are invalid");
 const brief = await realpath(inputs.briefPath);
 const briefRelative = path.relative(await realpath(path.join(dispatchRoot, ".work", ".cache", "briefs")), brief);
 if (!briefRelative || briefRelative.startsWith("..") || path.isAbsolute(briefRelative)) throw new Error("Fabric brief escapes cache storage");
 const handoff = inputs.handoff;
 if (handoff !== undefined && (!record(handoff) || (handoff.tasks !== undefined && !strings(handoff.tasks)) || (handoff.focus !== undefined && (!record(handoff.focus) || typeof handoff.focus.objective !== "string" || (handoff.focus.boundaries !== undefined && !strings(handoff.focus.boundaries)))))) throw new Error("Fabric handoff inputs are invalid");
 return {
  receipt: { ...decoded, backend: "fabric", resumeCount, totalAttempts },
  workerResult: parsed.value,
  digestInputs: { briefPath: entry.briefPath, task: inputs.task, ...(record(handoff) ? { handoff: {
   ...(strings(handoff.tasks) ? { tasks: [...handoff.tasks] } : {}),
   ...(record(handoff.focus) && typeof handoff.focus.objective === "string" ? { focus: { objective: handoff.focus.objective, ...(strings(handoff.focus.boundaries) ? { boundaries: [...handoff.focus.boundaries] } : {}) } } : {}),
  } } : {}) },
 };
}

/** Explicit inputs for independent verification/status; worker claims do not mark done. */
export function fabricResultInputs(result: FabricWorkerResult, worktreePath: string, nodeAddress: NodeAddress): {
	readonly verify: { readonly worktreePath: string; readonly expectedCommit: string; readonly checklistReports: readonly ChecklistReportInput[] };
	readonly status: { readonly worktreePath: string; readonly expectedCommit: string; readonly refresh: RefreshRequest };
} {
	const reports = result.checklist.map((report) => ({ index: report.index, done: report.done }));
	return {
		verify: { worktreePath, expectedCommit: result.commit, checklistReports: reports },
		status: { worktreePath, expectedCommit: result.commit, refresh: { checklists: [{ nodeAddress: [...nodeAddress], reports }] } },
	};
}
