import { createHash } from "node:crypto";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PlanReceipt } from "../plan/index.js";
import { writeDispatchCacheEntry } from "../status/cache.js";
import type { StatusCacheDispatchEntry, StatusCacheDispatchWriteResult } from "../status/types.js";
import { decodeDelegateRuntimeReceipt, delegateRuntimeErrorCode, errorMessage, loadDelegateClient } from "./runtime.js";
import type {
	CanonicalDelegateDispatchRequest,
	DelegateClientProvider,
	DelegateDispatchGrammar,
	DelegateDispatchRequest,
	DelegateRuntimeForkReceipt,
	LegacyDelegateDispatchRequest,
	DelegateRuntimeReceipt,
	DispatchFinding,
	DispatchResult,
	DispatchTarget,
} from "./types.js";

export * from "./types.js";
export { decodeDelegateRuntimeReceipt, loadDelegateClient } from "./runtime.js";

export type DispatchCacheWriter = (cachePath: string, specPath: string, worktreePath: string, entry: StatusCacheDispatchEntry) => Promise<StatusCacheDispatchWriteResult>;

export interface DispatchDependencies {
	readonly clientProvider?: DelegateClientProvider;
	readonly cacheWriter?: DispatchCacheWriter;
}

export interface DispatchPlanInput {
	readonly plan: PlanReceipt;
	readonly target: DispatchTarget;
	readonly context: ExtensionContext;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function nonEmptyStrings(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function validLegacyRequest(value: unknown): value is LegacyDelegateDispatchRequest {
	if (!record(value)) return false;
	const allowed = ["agent", "task", "cwd", "reads", "skills", "model", "writableRoots", "confineWrites", "escalation"];
	if (!onlyKeys(value, allowed) || typeof value.agent !== "string" || value.agent.length === 0 || typeof value.task !== "string" || value.task.length === 0 || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) || path.normalize(value.cwd) !== value.cwd || !Array.isArray(value.reads) || value.reads.length !== 1 || typeof value.reads[0] !== "string" || !path.isAbsolute(value.reads[0]) || value.confineWrites !== true || value.escalation !== "local") return false;
	if (value.skills !== undefined && !nonEmptyStrings(value.skills)) return false;
	if (value.model !== undefined && (typeof value.model !== "string" || value.model.length === 0)) return false;
	return value.writableRoots === undefined || nonEmptyStrings(value.writableRoots);
}

function validFocus(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["objective", "boundaries"])) return false;
	if (typeof value.objective !== "string" || value.objective.length === 0) return false;
	return value.boundaries === undefined || nonEmptyStrings(value.boundaries);
}

function validHandoff(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["tasks", "focus"])) return false;
	// Each namespace is independently optional, but an empty carrier would be a
	// dispatch that seeds nothing while reporting success.
	if (value.tasks === undefined && value.focus === undefined) return false;
	if (value.tasks !== undefined && !(Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.every((item) => typeof item === "string"))) return false;
	return value.focus === undefined || validFocus(value.focus);
}

function validCanonicalRequest(value: unknown): value is CanonicalDelegateDispatchRequest {
	if (!record(value) || !onlyKeys(value, ["runs"]) || !Array.isArray(value.runs) || value.runs.length !== 1) return false;
	const run = value.runs[0];
	const allowed = ["name", "agent", "task", "mode", "skills", "model", "cwd", "reads", "writableRoots", "confineWrites", "escalation", "worktree", "handoff"];
	if (!record(run) || !onlyKeys(run, allowed) || typeof run.name !== "string" || run.name.length === 0 || run.mode !== "solo" || run.worktree !== false || (run.handoff !== undefined && !validHandoff(run.handoff))) return false;
	return validLegacyRequest({
		agent: run.agent,
		task: run.task,
		cwd: run.cwd,
		reads: run.reads,
		...(run.skills === undefined ? {} : { skills: run.skills }),
		...(run.model === undefined ? {} : { model: run.model }),
		...(run.writableRoots === undefined ? {} : { writableRoots: run.writableRoots }),
		confineWrites: run.confineWrites,
		escalation: run.escalation,
	});
}

/** Runtime validation is required because pi-delegate's dispatch request is otherwise Record<string, unknown>. */
export function validateDelegateDispatchRequest(value: unknown): value is DelegateDispatchRequest {
	return validLegacyRequest(value) || validCanonicalRequest(value);
}

function rejected(plan: PlanReceipt, finding: DispatchFinding): DispatchResult {
	return { outcome: "rejected", dispatchState: "not-dispatched", plan, findings: [finding] };
}

function degraded(plan: PlanReceipt, message: string): DispatchResult {
	return { outcome: "degraded", dispatchState: "not-dispatched", plan, findings: [{ code: "delegate-client-unavailable", message }] };
}

function legacyRequest(plan: PlanReceipt, target: DispatchTarget): LegacyDelegateDispatchRequest | DispatchFinding {
	if (plan.delegate.worktree) {
		return {
			code: "dispatch-worktree-incompatible",
			message: "work_dispatch cannot use reads with worktree: true; supply one caller-managed persistent worktree and compile exactly one node",
		};
	}
	if (plan.delegate.cwd !== target.worktreePath || plan.briefPath !== plan.delegate.reads[0]) {
		return { code: "dispatch-request-invalid", message: "compiled plan cwd and brief reference must match the validated persistent worktree target" };
	}
	const request: LegacyDelegateDispatchRequest = {
		agent: plan.delegate.agent,
		task: plan.delegate.task,
		cwd: target.worktreePath,
		reads: [plan.briefPath],
		...(plan.delegate.skills === undefined ? {} : { skills: plan.delegate.skills }),
		...(plan.delegate.model === undefined ? {} : { model: plan.delegate.model }),
		...(plan.delegate.writableRoots === undefined ? {} : { writableRoots: plan.delegate.writableRoots }),
		confineWrites: true,
		escalation: "local",
	};
	return validLegacyRequest(request) ? request : { code: "dispatch-request-invalid", message: "compiled plan produced an invalid or unsupported delegate runtime request" };
}

function canonicalRequest(plan: PlanReceipt, target: DispatchTarget): CanonicalDelegateDispatchRequest | DispatchFinding {
	const request = plan.canonicalDelegate;
	const run = request.runs[0];
	if (!validCanonicalRequest(request) || run.name !== plan.nodeId || run.cwd !== target.worktreePath || run.reads[0] !== plan.briefPath) {
		return { code: "dispatch-request-invalid", message: "compiled canonical run must name the node and match the validated persistent worktree target" };
	}
	const tasks = run.handoff?.tasks;
	const digest = tasks === undefined ? undefined : createHash("sha256").update(JSON.stringify(tasks), "utf8").digest("hex");
	if (digest !== plan.handoffSha256) return { code: "dispatch-request-invalid", message: "compiled canonical tasks do not match the work_plan digest" };
	return request;
}

function receiptMismatch(receipt: DelegateRuntimeReceipt, plan: PlanReceipt, target: DispatchTarget, grammar: DelegateDispatchGrammar): string | undefined {
	if (receipt.forks.length !== 1) return `direct dispatch returned ${receipt.forks.length} forks instead of exactly one`;
	const fork = receipt.forks[0];
	if (!fork) return "direct dispatch returned no fork";
	if (grammar === "canonical" && fork.name !== plan.nodeId) return `runtime receipt fork ${fork.name} does not match canonical run ${plan.nodeId}`;
	const reads = fork.inputDigests.filter((digest) => digest.kind === "read");
	if (reads.length !== 1 || reads[0]?.name !== plan.briefPath || reads[0]?.digest !== plan.briefSha256) return "runtime receipt brief digest does not match the compiled work_plan receipt";
	if (grammar === "canonical") {
		const recorded = fork.inputDigests.filter((digest) => digest.kind === "checklist");
		if (plan.handoffSha256 === undefined) {
			if (recorded.length !== 0) return "runtime receipt recorded tasks that the canonical run did not submit";
		} else if (recorded.length !== 1 || recorded[0]?.name !== "checklist" || recorded[0].digest !== plan.handoffSha256) {
			return "runtime receipt tasks digest does not match the canonical handoff";
		}
	}
	if (fork.workerCwd !== undefined && path.resolve(fork.workerCwd) !== target.worktreePath) return `runtime receipt workerCwd ${fork.workerCwd} does not match ${target.worktreePath}`;
	if (fork.branch !== undefined && fork.branch !== target.branch) return `runtime receipt branch ${fork.branch} does not match ${target.branch}`;
	return undefined;
}

function cacheEntry(receipt: DelegateRuntimeReceipt, fork: DelegateRuntimeForkReceipt, plan: PlanReceipt, target: DispatchTarget): StatusCacheDispatchEntry {
	return {
		runId: receipt.runId,
		forkName: fork.name,
		nodeId: plan.nodeId,
		address: [...plan.nodeAddress],
		createdAt: receipt.createdAt,
		worktreePath: target.worktreePath,
		headCommit: target.headCommit,
		branch: target.branch,
		briefPath: plan.briefPath,
		briefSha256: plan.briefSha256,
		slot: {
			agent: fork.agent,
			...(fork.workerCwd === undefined ? {} : { workerCwd: fork.workerCwd }),
			...(fork.branch === undefined ? {} : { branch: fork.branch }),
			maxRounds: fork.maxRounds,
			...(fork.cloneMode === undefined ? {} : { cloneMode: fork.cloneMode }),
			...(fork.collapseMode === undefined ? {} : { collapseMode: fork.collapseMode }),
			...(fork.confineWrites === undefined ? {} : { confineWrites: fork.confineWrites }),
			...(fork.readOnly === undefined ? {} : { readOnly: fork.readOnly }),
			...(fork.requestedModel === undefined ? {} : { requestedModel: fork.requestedModel }),
			...(fork.resolvedModel === undefined ? {} : { resolvedModel: fork.resolvedModel }),
			...(fork.skills === undefined ? {} : { skills: [...fork.skills] }),
			inputDigests: fork.inputDigests.map((digest) => ({ ...digest })),
		},
		receiptPath: receipt.receiptPath,
		resultPath: receipt.resultPath,
	};
}

/**
 * Submit one closed direct request. The injected client surface contains only
 * dispatch, so this module cannot poll, wait on, steer, cancel, or sequence a run.
 */
export async function dispatchPlan(input: DispatchPlanInput, dependencies: DispatchDependencies = {}): Promise<DispatchResult> {
	const legacy = legacyRequest(input.plan, input.target);
	if ("code" in legacy) return rejected(input.plan, legacy);
	const provider = dependencies.clientProvider ?? loadDelegateClient;
	const availability = await provider(input.context);
	if (availability.status === "unavailable") return degraded(input.plan, availability.message);
	const selected = availability.grammar === "canonical" ? canonicalRequest(input.plan, input.target) : legacy;
	if ("code" in selected) return rejected(input.plan, selected);

	let rawReceipt: unknown;
	try {
		rawReceipt = await availability.client.dispatch(selected);
	} catch (error) {
		const runtimeCode = delegateRuntimeErrorCode(error);
		if (runtimeCode === "core-unavailable") return degraded(input.plan, errorMessage(error));
		return {
			outcome: "indeterminate",
			dispatchState: "unknown",
			plan: input.plan,
			findings: [{ code: "delegate-runtime-error", ...(runtimeCode === undefined ? {} : { runtimeCode }), message: errorMessage(error) }],
		};
	}
	const receipt = decodeDelegateRuntimeReceipt(rawReceipt);
	if (!receipt) {
		return { outcome: "indeterminate", dispatchState: "unknown", plan: input.plan, findings: [{ code: "delegate-receipt-invalid", message: "pi-delegate returned a malformed runtime receipt after dispatch" }] };
	}
	const mismatch = receiptMismatch(receipt, input.plan, input.target, availability.grammar);
	if (mismatch !== undefined) {
		return {
			outcome: "dispatched",
			dispatchState: "dispatched",
			plan: input.plan,
			receipt,
			cacheWrite: { status: "skipped", reason: "receipt-not-recordable", message: mismatch },
			findings: [{ code: "delegate-receipt-mismatch", message: mismatch }],
		};
	}
	const fork = receipt.forks[0]!;
	const writer = dependencies.cacheWriter ?? writeDispatchCacheEntry;
	let cacheWrite: StatusCacheDispatchWriteResult;
	try {
		cacheWrite = await writer(input.target.cachePath, input.target.specPath, input.target.worktreePath, cacheEntry(receipt, fork, input.plan, input.target));
	} catch (error) {
		cacheWrite = { status: "failed", path: input.target.cachePath, attempts: 0, reason: "cache-write-error", message: errorMessage(error) };
	}
	const findings: DispatchFinding[] = cacheWrite.status === "contended"
		? [{ code: "cache-write-contended", message: cacheWrite.message }]
		: cacheWrite.status === "failed"
			? [{ code: "cache-write-failed", message: cacheWrite.message }]
			: [];
	return { outcome: "dispatched", dispatchState: "dispatched", plan: input.plan, receipt, cacheWrite, findings };
}
