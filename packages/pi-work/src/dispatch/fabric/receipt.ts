import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../../git.js";
import { resolveVerifierExecutable } from "../../verify/executable.js";

import type { PlanReceipt, DelegateHandoff } from "../../plan/types.js";
import type { FabricWorkerResult } from "../../status/types.js";
import { validateFabricWorkerResult } from "./result.js";
import { writeDispatchCacheEntry } from "../../status/cache.js";
import type { StatusCacheDispatchEntry } from "../../status/types.js";
import type { DelegateRuntimeInputDigest, DispatchCacheOutcome, DispatchIndeterminate, DispatchTarget, FabricDispatchReceipt } from "../types.js";

export interface FabricReceiptInput {
	readonly plan: PlanReceipt;
	readonly target: DispatchTarget;
	/** Untrusted terminal Fabric AgentRunRecord, not the transport envelope. */
	readonly value: unknown;
	readonly workerResult?: FabricWorkerResult;
	readonly createdAt?: string;
}

function validatedResultCopy(value: FabricWorkerResult): FabricWorkerResult {
 const parsed = validateFabricWorkerResult(value);
 if (!parsed.ok) throw new Error(parsed.finding.message);
 return parsed.value;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function absolute(value: unknown): value is string {
	return text(value) && path.isAbsolute(value) && path.normalize(value) === value;
}
function sha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

async function inputDigests(plan: PlanReceipt): Promise<DelegateRuntimeInputDigest[]> {
	const run = plan.canonicalDelegate.runs[0];
	const brief = sha256(await readFile(plan.briefPath, "utf8"));
	const tasks = run.handoff?.tasks;
	const focus = run.handoff?.focus;
	const checklistDigest = tasks === undefined ? undefined : sha256(JSON.stringify(tasks));
	// Copy the named focus fields before hashing; never persist caller extras.
	const focusDigest = focus === undefined ? undefined : sha256(JSON.stringify({ objective: focus.objective, ...(focus.boundaries === undefined ? {} : { boundaries: [...focus.boundaries] }) }));
	if (brief !== plan.briefSha256 || checklistDigest !== plan.handoffSha256 || focusDigest !== plan.focusSha256) throw new Error("Fabric input digests do not match the compiled work_plan receipt");
	return [
		{ kind: "task", name: "task", algorithm: "sha256", digest: sha256(run.task) },
		{ kind: "read", name: plan.briefPath, algorithm: "sha256", digest: brief },
		...(checklistDigest === undefined ? [] : [{ kind: "checklist" as const, name: "checklist", algorithm: "sha256" as const, digest: checklistDigest }]),
		...(focusDigest === undefined ? [] : [{ kind: "focus" as const, name: "focus", algorithm: "sha256" as const, digest: focusDigest }]),
	];
}

/** Named source bytes retained for independent digest recomputation. */
export interface FabricDigestInputs {
 readonly briefPath: string;
 readonly task: string;
 readonly handoff?: DelegateHandoff;
}
/** Re-read the brief and recompute each namespace, without trusting recorded hashes. */
export async function verifyFabricDispatchDigests(receipt: FabricDispatchReceipt, plan: PlanReceipt | FabricDigestInputs): Promise<boolean> {
 const run = "canonicalDelegate" in plan ? plan.canonicalDelegate.runs[0] : plan;
	const expected: DelegateRuntimeInputDigest[] = [
		{ kind: "task", name: "task", algorithm: "sha256", digest: createHash("sha256").update(run.task, "utf8").digest("hex") },
		{ kind: "read", name: plan.briefPath, algorithm: "sha256", digest: createHash("sha256").update(await readFile(plan.briefPath)).digest("hex") },
	];
	if (run.handoff?.tasks !== undefined) expected.push({ kind: "checklist", name: "checklist", algorithm: "sha256", digest: createHash("sha256").update(JSON.stringify(run.handoff.tasks)).digest("hex") });
	if (run.handoff?.focus !== undefined) expected.push({ kind: "focus", name: "focus", algorithm: "sha256", digest: createHash("sha256").update(JSON.stringify(run.handoff.focus)).digest("hex") });
	const actual = receipt.forks[0]?.inputDigests;
	return receipt.forks.length === 1 && actual !== undefined && actual.length === expected.length && expected.every((digest) => actual.filter((item) => item.kind === digest.kind && item.name === digest.name && item.algorithm === digest.algorithm && item.digest === digest.digest).length === 1);
}

export interface FabricDispatchOwnership {
 readonly dispatchId: string;
 readonly specPath: string;
 readonly address: readonly string[];
}

/** Tree-local accounting travels with worktree moves; no absolute tree path is hashed. */
export async function fabricOwnershipPath(cachePath: string, address: readonly string[], worktreePath: string): Promise<string> {
 const name = `fabric-ownership/${sha256(JSON.stringify([path.basename(cachePath), [...address]]))}.json`;
 const git = await resolveVerifierExecutable("git");
 const root = await runGit(git, worktreePath, ["rev-parse", "--show-toplevel"]);
 if (await realpath(root.stdout.trim()) !== await realpath(worktreePath)) throw new Error("Worker tree is not a Git worktree root");
 const result = await runGit(git, worktreePath, ["rev-parse", "--git-path", name]);
 const resolved = result.stdout.trim();
 if (!resolved) throw new Error("Git returned an empty Fabric ownership path");
 return path.resolve(worktreePath, resolved);
}

export async function readFabricOwnership(cachePath: string, address: readonly string[], worktreePath: string): Promise<FabricDispatchOwnership | undefined> {
 const file = await fabricOwnershipPath(cachePath, address, worktreePath);
 try { await lstat(file); }
 catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
 }
 // Once present, unreadable or dangling ownership must never masquerade as absent.
 const source = await readFile(file, "utf8");
 const value: unknown = JSON.parse(source);
 if (!record(value) || typeof value.dispatchId !== "string" || !/^[0-9a-f-]{36}$/.test(value.dispatchId) || !absolute(value.specPath) || JSON.stringify(value.address) !== JSON.stringify(address)) throw new Error("Invalid Fabric dispatch ownership");
 return { dispatchId: value.dispatchId, specPath: value.specPath, address: [...address] };
}
/** Resolve ownership before any publication; invalid worker trees are not success receipts. */
export async function resolveFabricReceiptOwnership(plan: PlanReceipt, target: DispatchTarget, workerCwd: string): Promise<string | DispatchIndeterminate> {
 try { return await fabricOwnershipPath(target.cachePath, plan.nodeAddress, workerCwd); }
 catch (error) {
  return { outcome: "indeterminate", dispatchState: "unknown", plan, findings: [{ code: "delegate-receipt-invalid", message: `Fabric worker tree ${JSON.stringify(workerCwd)} is not a resolvable Git worktree: ${String(error)}; do not redispatch automatically` }] };
 }
}
/** Adapt Fabric into the existing receipt and status-cache protocol, not a parallel history. */
export async function recordFabricDispatchReceipt(input: FabricReceiptInput): Promise<{ readonly receipt: FabricDispatchReceipt; readonly cacheWrite: DispatchCacheOutcome } | DispatchIndeterminate> {
	const { plan, target, value } = input;
	const run = plan.canonicalDelegate.runs[0];
	if (!record(value) || !text(value.id) || !text(value.model)) throw new Error("Fabric receipt requires run identity and canonical model");
	const worktree = value.worktreeResult;
	if (run.worktree && (!record(worktree) || !absolute(worktree.path) || !text(worktree.branch))) throw new Error("Fabric receipt requires the worker worktree path and branch");
	const workerCwd = record(worktree) && absolute(worktree.path) ? worktree.path : run.cwd ?? target.worktreePath;
	const branch = record(worktree) && text(worktree.branch) ? worktree.branch : target.branch;
	if (!absolute(workerCwd) || !absolute(target.worktreePath) || !absolute(target.cachePath)) throw new Error("Fabric receipt paths must be normalized absolute paths");
	const resumeCount = value.resumeCount ?? 0;
	const totalAttempts = value.totalAttempts ?? (typeof resumeCount === "number" ? resumeCount + 1 : undefined);
	if (typeof resumeCount !== "number" || !Number.isInteger(resumeCount) || resumeCount < 0 || resumeCount > 3 || totalAttempts !== resumeCount + 1) throw new Error("Fabric resume count and total attempts are inconsistent");
	const createdAt = input.createdAt ?? new Date().toISOString();
	if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Fabric receipt timestamp is invalid");
	const digests = await inputDigests(plan);
	const marker = await resolveFabricReceiptOwnership(plan, target, workerCwd);
	if (typeof marker !== "string") return marker;
	// Hash the identity as a path component so an untrusted run id cannot traverse storage.
	const directory = path.join(path.dirname(target.cachePath), "fabric", sha256(value.id));
	const dispatchId = randomUUID();
	const receipt: FabricDispatchReceipt & { readonly dispatchId: string } = {
		schema: "pi-delegate.runtime-receipt", version: 1, backend: "fabric", dispatchId, runId: value.id, createdAt, shape: "direct", resumeCount, totalAttempts: resumeCount + 1,
		forks: [{ name: run.name, agent: run.agent, workerCwd, branch, maxRounds: 1, confineWrites: run.confineWrites,
			...(run.model === undefined ? {} : { requestedModel: run.model }), resolvedModel: value.model,
			...(run.skills === undefined ? {} : { skills: [...run.skills] }), inputDigests: digests }],
		receiptPath: path.join(directory, "receipt.json"), resultPath: path.join(directory, "result.json"),
	};
	const handoff = run.handoff;
	const digestInputs: FabricDigestInputs = {
		briefPath: plan.briefPath,
		task: run.task,
		...(handoff === undefined ? {} : { handoff: {
			...(handoff.tasks === undefined ? {} : { tasks: [...handoff.tasks] }),
			...(handoff.focus === undefined ? {} : { focus: {
				objective: handoff.focus.objective,
				...(handoff.focus.boundaries === undefined ? {} : { boundaries: [...handoff.focus.boundaries] }),
			} }),
		} }),
	};
	// Publish tree-local ownership before artifacts/cache so partial publication fails closed.
	// This pi-work write happens after post-run confinement snapshots, never during the worker run.
	await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
	// Reject duplicate run publication before replacing a previous tree identity.
	await mkdir(directory, { mode: 0o700 });
	await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
	const temporary = `${marker}.${dispatchId}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ dispatchId, specPath: target.specPath, address: [...plan.nodeAddress] })}\n`, { flag: "wx", mode: 0o600 });
	try { await rename(temporary, marker); }
	finally { await unlink(temporary).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }); }
	await writeFile(receipt.resultPath, `${JSON.stringify({ runId: receipt.runId, model: value.model, workerCwd, branch, resumeCount, totalAttempts: receipt.totalAttempts, ...(typeof value.text === "string" ? { text: value.text } : {}), ...(input.workerResult === undefined ? {} : { workerResult: validatedResultCopy(input.workerResult) }), digestInputs })}\n`, { flag: "wx", mode: 0o600 });
	await writeFile(receipt.receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
	const fork = receipt.forks[0]!;
	const entry: StatusCacheDispatchEntry = {
		dispatchId, runId: receipt.runId, forkName: fork.name, nodeId: plan.nodeId, address: [...plan.nodeAddress], createdAt,
		worktreePath: target.worktreePath, headCommit: target.headCommit, branch, briefPath: plan.briefPath, briefSha256: plan.briefSha256,
		slot: { backend: "fabric", agent: fork.agent, workerCwd, branch, maxRounds: fork.maxRounds, confineWrites: run.confineWrites,
			...(fork.requestedModel === undefined ? {} : { requestedModel: fork.requestedModel }), resolvedModel: value.model,
			...(fork.skills === undefined ? {} : { skills: [...fork.skills] }), inputDigests: digests },
		receiptPath: receipt.receiptPath, resultPath: receipt.resultPath,
	};
	let cacheWrite: DispatchCacheOutcome;
	try { cacheWrite = await writeDispatchCacheEntry(target.cachePath, target.specPath, target.worktreePath, entry); }
	catch (error) { cacheWrite = { status: "failed", path: target.cachePath, attempts: 0, reason: "cache-write-error", message: String(error) }; }
	return { receipt, cacheWrite };
}
