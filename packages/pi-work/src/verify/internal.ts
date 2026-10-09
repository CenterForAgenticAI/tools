import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readStatusCache, statusCachePath } from "../status/cache.js";
import { readFabricDispatchResult, fabricResultInputs } from "../dispatch/fabric/result.js";
import { readFabricOwnership, verifyFabricDispatchDigests } from "../dispatch/fabric/receipt.js";

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validateWorkspec } from "../schema/index.js";
import type { StatusCacheVerificationWriteResult } from "../status/types.js";
import { isEnvironmentVariableList } from "../schema/environment.js";
import { captureEvidenceEnvironment } from "./executable.js";
import { commandEvidenceMatches, commandExpectationMatches, commandOutputMatches, redactCommandEvidence, redactCommandFailure, redactCommandText, inheritedValuesSnapshot, type InheritedValuesSnapshot } from "./output.js";
import type { AcceptanceCriterion, WorkNode } from "../schema/workspec.js";
import { runAgent, type AgentJudge } from "./agent.js";
import { verifyChecklist, type ChecklistReports } from "./checklist.js";
import { runCommand, type CommandRunnerOptions } from "./command.js";
import { validCommandContainment } from "./containment.js";
import {
	decodeVerificationCacheUpdate,
	observeVerificationResult,
	type ChecklistItemResult,
	type CriterionProof,
	type FailedCriterionResult,
	type ExecutionWindow,
	type IncompleteChecklistResults,
	type ChecklistResults,
	type CompleteChecklistResults,
	type NodeVerificationRecord,
	type PassedCriterionResult,
	type ObservedVerificationCacheUpdate,
	type ObservedVerificationResult,
	type TreeIdentity,
	type VerificationCacheUpdate,
	type VerificationFailure,
	type VerificationResult,
} from "./results.js";
import { inspectTree, monitorTree, verifyTreeUnchanged, type TreeCheck, type TreeSnapshot } from "./tree.js";
import { runUser, type HostUserCapabilities, type SessionReader } from "./user.js";

/** Dispatch accounting supplies inputs only; this boundary never mints proof. */
async function readFabricVerificationInputs(specPath: string, address: readonly string[], target: VerificationTarget, dispatchTree: VerificationTarget = target): Promise<{ readonly checklistReports?: ChecklistReports; readonly failure?: VerificationFailure }> {
 const cachePath = statusCachePath(dispatchTree.worktreePath, specPath);
 try {
  const ownership = await readFabricOwnership(cachePath, address, target.worktreePath);
  const cache = await readStatusCache(cachePath);
  if (ownership && (ownership.specPath !== specPath || cache.findings.length > 0 || !cache.cache || cache.cache.specPath !== ownership.specPath)) throw new Error("Dispatch owner cache is unreadable or invalid");
  const entries = Object.values(cache.cache?.dispatch ?? {}).filter(entry => ownership
   ? entry.dispatchId === ownership.dispatchId
   : entry.dispatchId === undefined && entry.slot.backend === "fabric" && (entry.worktreePath === target.worktreePath || entry.slot.workerCwd === target.worktreePath) && JSON.stringify(entry.address) === JSON.stringify(address));
  // Preserve valid legacy accounting, but ignore malformed caches without tree-local ownership.
  if (!ownership && entries.length === 0) return {};
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.slot.backend !== "fabric" || JSON.stringify(entry.address) !== JSON.stringify(address)) throw new Error("Dispatch identity missing or mismatched in cache");
  const saved = await readFabricDispatchResult(entry, cachePath, dispatchTree.worktreePath);
  if (!saved) throw new Error("Fabric receipt outside cache storage");
  const receipt: unknown = JSON.parse(await readFile(entry.receiptPath, "utf8"));
  if (ownership && (typeof receipt !== "object" || receipt === null || !("dispatchId" in receipt) || receipt.dispatchId !== ownership.dispatchId)) throw new Error("Dispatch receipt identity mismatch");
  if (!await verifyFabricDispatchDigests(saved.receipt, saved.digestInputs)) return { failure: { code: "verification-aborted", message: "Fabric dispatch input digest mismatch" } };
  const inputs = fabricResultInputs(saved.workerResult, saved.receipt.forks[0]?.workerCwd ?? entry.worktreePath, entry.address).verify;
  if (inputs.expectedCommit !== target.expectedCommit) return { failure: { code: "verification-aborted", message: "Fabric result does not match the explicit verification target" } };
  return { checklistReports: inputs.checklistReports };
 } catch {
  return { failure: { code: "verification-aborted", message: "Fabric dispatch result or digest inputs are unreadable or invalid" } };
 }
}

/** Attestations live with the verifier that mints them. Serialized data has no entry point. */
const recorded = new Map<string, { readonly update: ObservedVerificationCacheUpdate; readonly sourceDigest: string }>();
export function digestSpecSource(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}
export function sessionVerifications(): readonly { readonly update: ObservedVerificationCacheUpdate; readonly sourceDigest: string }[] {
	return [...recorded.values()].map((entry) => deepFreeze(structuredClone(entry)));
}
/** Test-only reset; it can only remove authority, never grant it. */
export function forgetSessionVerifications(): void { recorded.clear(); }
function recordMintedVerification(update: VerificationCacheUpdate, source: string): void {
	const observed = decodeVerificationCacheUpdate(update);
	if (!observed) return;
	const key = JSON.stringify([observed.specPath, observed.nodeId]);
	const existing = recorded.get(key);
	if (existing && existing.update.tree.worktreePath === observed.tree.worktreePath && existing.update.tree.resolvedCommit === observed.tree.resolvedCommit && existing.update.recordedAt > observed.recordedAt) return;
	recorded.set(key, { update: observed, sourceDigest: digestSpecSource(source) });
}

export interface VerificationTarget {
	readonly worktreePath: string;
	readonly expectedCommit: string;
}

export interface VerifyNodeRequest {
	readonly node: WorkNode;
	/** Qualified address disambiguates duplicate IDs in different assemblies. */
	readonly address?: readonly string[] | undefined;
	readonly specPath: string;
	/** Exact validated source supplied by work_verify; absent in observation-only calls. */
	readonly source?: string | undefined;
	/** Additional spec-wide values captured by the tool before verification. */
	readonly inherited?: InheritedValuesSnapshot | undefined;
	readonly target: VerificationTarget;
	// These optional members are plumbed straight through from callers that hold
	// `T | undefined`. Absent and explicitly undefined mean the same thing here, so
	// they accept undefined rather than forcing every call site to spread.
	readonly checklistReports?: ChecklistReports | undefined;
	readonly signal?: AbortSignal | undefined;
}

/** Compatibility name for the request shape; it contains no caller capabilities. */
export type VerifyNodeOptions = VerifyNodeRequest;

export interface VerifierCapabilities {
	readonly hasUI: boolean;
	readonly confirm?: HostUserCapabilities["confirm"] | undefined;
	readonly sessionManager?: SessionReader | undefined;
}

export interface ObservationalVerifierAdapters {
	readonly command?: CommandRunnerOptions | undefined;
	readonly judge?: AgentJudge | undefined;
	readonly session?: SessionReader | undefined;
	readonly maxInputBytes?: number | undefined;
}

export type PersistVerification = (update: VerificationCacheUpdate) => Promise<StatusCacheVerificationWriteResult>;

export interface AuthorityVerifier {
	readonly readFabricInputs: typeof readFabricVerificationInputs;
	readonly inspectTarget: (target: VerificationTarget) => Promise<TreeCheck>;
	readonly verifyNode: (request: VerifyNodeRequest) => Promise<VerificationResult>;
	readonly verifyNodeAndCache: (request: VerifyNodeRequest, persist?: PersistVerification) => Promise<{ result: VerificationResult; cacheUpdate?: VerificationCacheUpdate; cacheWrite?: StatusCacheVerificationWriteResult }>;
	readonly isCriterionPassed: (value: unknown) => value is PassedCriterionResult;
	readonly isCompleteChecklist: (value: unknown) => value is CompleteChecklistResults;
	readonly isNodePassed: (value: unknown) => value is NodeVerificationRecord;
	readonly isCacheUpdate: (value: unknown) => value is VerificationCacheUpdate;
	readonly verificationFailures: (result: VerificationResult) => VerificationFailure[];
}

export interface ObservationalVerifier {
	readonly inspectTarget: (target: VerificationTarget) => Promise<TreeCheck>;
	readonly verifyNode: (request: VerifyNodeRequest) => Promise<ObservedVerificationResult>;
	readonly verifyNodeAndCache: (request: VerifyNodeRequest) => Promise<{ result: ObservedVerificationResult; cacheUpdate?: ObservedVerificationCacheUpdate }>;
	readonly isCriterionPassed: (value: unknown) => value is PassedCriterionResult;
	readonly isCompleteChecklist: (value: unknown) => value is CompleteChecklistResults;
	readonly isNodePassed: (value: unknown) => value is NodeVerificationRecord;
	readonly isCacheUpdate: (value: unknown) => value is VerificationCacheUpdate;
	readonly verificationFailures: (result: ObservedVerificationResult) => VerificationFailure[];
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
	}
	return Object.freeze(value);
}

/** Snapshot request data synchronously so caller mutation cannot cross an await. */
function snapshotRequest(request: VerifyNodeRequest): VerifyNodeRequest {
	const snapshot = structuredClone({
		node: request.node,
		address: request.address,
		specPath: request.specPath,
		source: request.source,
		inherited: request.inherited,
		target: request.target,
		checklistReports: request.checklistReports,
	});
	deepFreeze(snapshot);
	return { ...snapshot, signal: request.signal };
}

function assertNodeMatchesSource(request: VerifyNodeRequest): void {
	if (request.source === undefined) return; // Legacy observation-only calls cannot attest.
	const validation = validateWorkspec(request.source, { specPath: request.specPath, cwd: request.target.worktreePath });
	if (!validation.valid || !validation.structuralValid) throw new TypeError("node source is not a valid workspec");
	const matching: WorkNode[] = [];
	function visit(nodes: readonly WorkNode[], parent: readonly string[]): void {
		for (const node of nodes) {
			const address = [...parent, node.id];
			if (request.address ? isDeepStrictEqual(address, request.address) : node.id === request.node.id) matching.push(node);
			if (Array.isArray(node.work)) visit(node.work, address);
		}
	}
	visit(validation.spec.work, []);
	if (matching.length !== 1 || !isDeepStrictEqual(matching[0], request.node)) throw new TypeError("node does not match validated source");
}

function nodeInheritedValues(node: WorkNode): InheritedValuesSnapshot {
	const names = node.acceptance?.flatMap((criterion) => criterion.evidence.kind === "command" ? criterion.evidence.inherit_env ?? [] : []) ?? [];
	return captureEvidenceEnvironment([...new Set(names)]).inherited;
}

function validTree(tree: TreeIdentity): boolean {
	return tree.kind === "git" && tree.worktreePath.startsWith("/") && /^[0-9a-f]{40}$/.test(tree.resolvedCommit);
}

function sameTree(left: TreeIdentity, right: TreeIdentity): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "git":
			return right.kind === "git" && left.worktreePath === right.worktreePath && left.resolvedCommit === right.resolvedCommit;
	}
}

function validWindow(value: ExecutionWindow): boolean {
	const started = Date.parse(value.startedAt);
	const finished = Date.parse(value.finishedAt);
	return Number.isFinite(started) && Number.isFinite(finished) && finished >= started && value.durationMs === finished - started;
}

function validProof(proof: CriterionProof): boolean {
	if (!validWindow(proof) || !validTree(proof.tree)) return false;
	if (proof.kind === "command-proof") {
		if (!validCommandContainment(proof.containment, proof.executorPath, proof.shellPath)) return false;
		return proof.authoredCommand.length > 0 && proof.authoredCommand === redactCommandText(inheritedValuesSnapshot([]), proof.authoredCommand) && isEnvironmentVariableList(proof.inherit_env) && (proof.timeout_ms === undefined || Number.isInteger(proof.timeout_ms) && proof.timeout_ms >= 1_000 && proof.timeout_ms <= 3_600_000) && proof.gitPath.startsWith("/") && proof.executorPath.startsWith("/") && proof.shellPath.startsWith("/") && validWindow(proof.monitoring.window) && proof.monitoring.method === "fs.watch" && (proof.monitoring.mode === "recursive" || proof.monitoring.mode === "directory-fallback") && proof.monitoring.residualRace === "events-after-final-drain-may-be-missed" && Number.isInteger(proof.expectation.exit) && proof.expectation.output_includes !== undefined && proof.expectation.output_includes.length > 0 && commandExpectationMatches(inheritedValuesSnapshot([]), proof.expectation) && Number.isInteger(proof.exitCode) && proof.exitCode === proof.expectation.exit && proof.signal === null && proof.outputMatched === proof.expectation.output_includes && proof.outputMatched === redactCommandText(inheritedValuesSnapshot([]), proof.outputMatched) && (proof.untrackedPaths === undefined || proof.untrackedPaths.every((path) => path.length > 0)) && commandOutputMatches(inheritedValuesSnapshot([]), proof.stdout, proof.stderr, proof.outputMatched);
	}
	if (proof.kind === "agent-proof") {
		return proof.agent.length > 0 && proof.rubric.length > 0 && proof.rubricDigest === createHash("sha256").update(proof.rubric, "utf8").digest("hex") && proof.verdict === "approve" && proof.dispatchReceipt.trim().length > 0 && proof.inputs.length > 0 && proof.inputs.every((input) => input.path.length > 0 && /^[a-f0-9]{64}$/.test(input.digest) && Number.isInteger(input.bytes) && input.bytes >= 0);
	}
	if (proof.prompt.length === 0 || proof.challenge.length === 0 || proof.sessionId.length === 0) return false;
	if (proof.source === "ui") return proof.sessionFile === undefined && proof.entryId === undefined && proof.entryTimestamp === undefined;
	return proof.sessionFile.length > 0 && proof.entryId.length > 0 && Number.isFinite(Date.parse(proof.entryTimestamp));
}

function validCriterion(criterion: PassedCriterionResult): boolean {
	return criterion.criterion.id.length > 0 && validProof(criterion.proof) && validWindow(criterion) && criterion.startedAt === criterion.proof.startedAt && criterion.finishedAt === criterion.proof.finishedAt && criterion.durationMs === criterion.proof.durationMs;
}

function validChecklist(checklist: CompleteChecklistResults): boolean {
	return checklist.outcome === "complete" && checklist.failures.length === 0 && validTree(checklist.tree) && checklist.items.every((item) => item.index >= 0 && Number.isInteger(item.index) && item.item.length >= 0 && item.done && validTree(item.tree) && sameTree(item.tree, checklist.tree));
}

function validAttempt(attempt: FailedCriterionResult["attempt"]): boolean {
	return (attempt.kind !== "command" || attempt.evidence.kind !== "command" || commandEvidenceMatches(attempt.evidence, inheritedValuesSnapshot([])) && commandOutputMatches(inheritedValuesSnapshot([]), attempt.stdout ?? "", attempt.stderr ?? "", attempt.evidence.expect.output_includes)) && validTree(attempt.tree) && Number.isFinite(Date.parse(attempt.startedAt)) && Number.isFinite(Date.parse(attempt.finishedAt)) && Date.parse(attempt.finishedAt) >= Date.parse(attempt.startedAt) && (attempt.stdout === undefined || typeof attempt.stdout === "string") && (attempt.stderr === undefined || typeof attempt.stderr === "string") && (attempt.exitCode === undefined || attempt.exitCode === null || Number.isInteger(attempt.exitCode));
}

function validIncompleteChecklist(checklist: IncompleteChecklistResults): boolean {
	return validTree(checklist.tree) && checklist.items.every((item) => Number.isInteger(item.index) && item.index >= 0 && item.item.length >= 0 && typeof item.done === "boolean" && validTree(item.tree) && sameTree(item.tree, checklist.tree)) && checklist.failures.length > 0 && checklist.failures.every((failure) => failure.message.length > 0);
}

function validResult(result: VerificationResult): boolean {
	if (result.nodeId.length === 0 || !validTree(result.tree) || !Number.isFinite(Date.parse(result.recordedAt))) return false;
	if (result.outcome === "passed") return result.criteria.length > 0 && result.criteria.every((criterion) => validCriterion(criterion)) && validChecklist(result.checklist);
	return result.criteria.every((criterion) => criterion.outcome === "passed" ? validCriterion(criterion) : criterion.criterion.id.length > 0 && validAttempt(criterion.attempt) && sameTree(criterion.attempt.tree, result.tree) && criterion.failures.length > 0 && criterion.failures.every((failure) => failure.message.length > 0)) && (result.checklist.outcome === "incomplete" ? validIncompleteChecklist(result.checklist) : validChecklist(result.checklist));
}

function now(): string { return new Date().toISOString(); }

function criterionSummary(criterion: AcceptanceCriterion): Pick<AcceptanceCriterion, "id" | "statement"> {
	return { id: criterion.id, statement: criterion.statement };
}

function fallbackTree(target: VerificationTarget): TreeIdentity {
	const worktreePath = path.resolve(target.worktreePath || ".");
	return { kind: "git", worktreePath, resolvedCommit: /^[0-9a-f]{40}$/.test(target.expectedCommit) ? target.expectedCommit : "0".repeat(40) };
}

function attemptFor(criterion: AcceptanceCriterion, tree: TreeIdentity, inherited: InheritedValuesSnapshot, startedAt = now(), finishedAt = now()): FailedCriterionResult["attempt"] {
	const evidence = criterion.evidence.kind === "command" ? redactCommandEvidence(criterion.evidence, inherited) : criterion.evidence;
	return { kind: evidence.kind, evidence, startedAt, finishedAt, tree };
}

function failed(criterion: AcceptanceCriterion, tree: TreeIdentity, failures: VerificationFailure[], inherited: InheritedValuesSnapshot, startedAt?: string, finishedAt?: string): FailedCriterionResult {
	const [first, ...rest] = failures;
	return {
		outcome: "failed",
		criterion: criterionSummary(criterion),
		attempt: attemptFor(criterion, tree, inherited, startedAt, finishedAt),
		failures: first ? [first, ...rest] : [{ code: "no-execution-evidence", message: "criterion produced no failure detail" }],
	};
}

function failureForTree(code: VerificationFailure["code"], message: string, inherited: InheritedValuesSnapshot): VerificationFailure {
	const safeMessage = redactCommandFailure(inherited, message);
	return code === "tree-dirty" ? { code, message: safeMessage } : { code: "tree-changed", message: safeMessage };
}

function failedRecord(node: WorkNode, tree: TreeIdentity, failures: VerificationFailure[], inherited: InheritedValuesSnapshot, checklistReports?: ChecklistReports): VerificationResult {
	const criteria = (node.acceptance ?? []).map((criterion) => failed(criterion, tree, failures.map((failure) => ({ ...failure, message: redactCommandFailure(inherited, failure.message) })), inherited));
	return { outcome: "failed", nodeId: node.id, tree, criteria, checklist: verifyChecklist("checklist" in node ? node.checklist : undefined, checklistReports, tree), recordedAt: now() };
}

function collectVerificationFailures(result: { criteria: readonly { outcome: string; failures?: readonly VerificationFailure[] }[]; checklist: ChecklistResults }): VerificationFailure[] {
	const failures: VerificationFailure[] = [...result.checklist.failures];
	for (const criterion of result.criteria) if (criterion.outcome === "failed" && criterion.failures) failures.push(...criterion.failures);
	if (result.criteria.length === 0) failures.push({ code: "no-execution-evidence", message: "node has no acceptance criteria" });
	return failures;
}

function makeAuthorityVerifier(capabilities: VerifierCapabilities): AuthorityVerifier {
	const hostCapabilities: VerifierCapabilities = { hasUI: capabilities.hasUI, confirm: capabilities.confirm, sessionManager: capabilities.sessionManager };
	const passedCriterionObjects = new WeakSet<object>();
	const completeChecklistObjects = new WeakSet<object>();
	const passedNodeObjects = new WeakSet<object>();
	const cacheUpdateObjects = new WeakSet<object>();
	const passedCriterionBrand = Symbol("passed criterion");
	const completeChecklistBrand = Symbol("complete checklist");
	const passedNodeBrand = Symbol("passed node");
	const cacheUpdateBrand = Symbol("cache update");

	function brand<T extends object>(value: T, marker: symbol): T {
		Object.defineProperty(value, marker, { value: true, enumerable: false });
		return deepFreeze(value);
	}

	function isCriterionPassed(value: unknown): value is PassedCriterionResult {
		return typeof value === "object" && value !== null && passedCriterionObjects.has(value);
	}
	function isCompleteChecklist(value: unknown): value is CompleteChecklistResults {
		return typeof value === "object" && value !== null && completeChecklistObjects.has(value);
	}
	function isNodePassed(value: unknown): value is NodeVerificationRecord {
		return typeof value === "object" && value !== null && passedNodeObjects.has(value);
	}
	function isCacheUpdate(value: unknown): value is VerificationCacheUpdate {
		return typeof value === "object" && value !== null && cacheUpdateObjects.has(value);
	}
	function createPassedCriterion(criterion: PassedCriterionResult["criterion"], proof: CriterionProof): PassedCriterionResult {
		const result = brand({ outcome: "passed" as const, criterion, proof, startedAt: proof.startedAt, finishedAt: proof.finishedAt, durationMs: proof.durationMs }, passedCriterionBrand);
		if (!validCriterion(result)) throw new TypeError("invalid passed criterion");
		passedCriterionObjects.add(result);
		return result;
	}
	function createCompleteChecklist(items: ChecklistItemResult[], tree: TreeIdentity): CompleteChecklistResults {
		const result = brand({ outcome: "complete" as const, items, failures: [] as const, tree }, completeChecklistBrand);
		if (!validChecklist(result)) throw new TypeError("invalid complete checklist");
		completeChecklistObjects.add(result);
		return result;
	}
	function createPassedNode(nodeId: string, tree: TreeIdentity, criteria: [PassedCriterionResult, ...PassedCriterionResult[]], checklist: CompleteChecklistResults, recordedAt: string): NodeVerificationRecord {
		const result = brand({ outcome: "passed" as const, nodeId, tree, criteria, checklist, recordedAt }, passedNodeBrand);
		if (result.criteria.length === 0 || !validTree(tree) || !result.criteria.every((criterion) => isCriterionPassed(criterion) && validCriterion(criterion) && sameTree(criterion.proof.tree, tree)) || !isCompleteChecklist(checklist) || !validChecklist(checklist) || !sameTree(checklist.tree, tree) || !validResult(result)) throw new TypeError("invalid passed node");
		passedNodeObjects.add(result);
		return result;
	}
	function createCacheUpdate(specPath: string, result: VerificationResult): VerificationCacheUpdate {
		const update = brand({ kind: "verification-cache-update" as const, specPath, nodeId: result.nodeId, recordedAt: result.recordedAt, tree: result.tree, record: result }, cacheUpdateBrand);
		if (specPath.length === 0 || !validTree(update.tree) || !validResult(result)) throw new TypeError("invalid verification cache update");
		cacheUpdateObjects.add(update);
		return update;
	}

	async function verifyNode(request: VerifyNodeRequest): Promise<VerificationResult> {
		request = snapshotRequest(request);
		assertNodeMatchesSource(request);
		const inherited = request.inherited ?? nodeInheritedValues(request.node);
		const baseline = await inspectTree(request.target.worktreePath, request.target.expectedCommit);
		if (!baseline.ok) return failedRecord(request.node, fallbackTree(request.target), [baseline.failure], inherited, request.checklistReports);
		const tree = baseline.snapshot.identity;
		const monitor = await monitorTree(baseline.snapshot);
		if (!monitor.ok) return failedRecord(request.node, tree, [monitor.failure], inherited, request.checklistReports);
		const criteria: (PassedCriterionResult | FailedCriterionResult)[] = [];
		try {
			for (const criterion of request.node.acceptance ?? []) {
				if (request.signal?.aborted) {
					criteria.push(failed(criterion, tree, [{ code: "verification-aborted", message: "verification was aborted before this criterion started" }], inherited));
					continue;
				}
			const startedAt = now();
			let result: Awaited<ReturnType<typeof runCommand>> | Awaited<ReturnType<typeof runAgent>> | Awaited<ReturnType<typeof runUser>>;
			if (criterion.evidence.kind === "command") result = await runCommand({ evidence: criterion.evidence, tree, signal: request.signal, gitPath: baseline.snapshot.gitPath, untrackedPaths: monitor.untrackedPaths, inherited, drainObservation: monitor.drain, monitoring: monitor.monitoring }, { timeoutMs: criterion.evidence.timeout_ms });
			else if (criterion.evidence.kind === "agent") result = await runAgent({ evidence: criterion.evidence, tree, signal: request.signal });
			else result = await runUser({ evidence: criterion.evidence, specPath: request.specPath, nodeId: request.node.id, criterionId: criterion.id, tree }, { host: { hasUI: hostCapabilities.hasUI, confirm: hostCapabilities.confirm, session: hostCapabilities.sessionManager }, signal: request.signal });
			const unchanged = await verifyTreeUnchanged(baseline.snapshot);
			if (result.outcome === "failed") {
				const failures = unchanged.ok ? result.failures : [...result.failures, failureForTree(unchanged.failure.code, unchanged.failure.message, inherited)];
				const [first, ...rest] = failures;
				criteria.push({ outcome: "failed", criterion: criterionSummary(criterion), attempt: result.attempt, failures: first ? [first, ...rest] : [{ code: "no-execution-evidence", message: "criterion produced no failure detail" }] });
			} else if (!unchanged.ok) {
				criteria.push(failed(criterion, tree, [failureForTree(unchanged.failure.code, unchanged.failure.message, inherited)], inherited, startedAt, now()));
			} else {
				criteria.push(createPassedCriterion(criterionSummary(criterion), result.proof));
			}
		}
		await monitor.drain();
		const finalTree = await verifyTreeUnchanged(baseline.snapshot);
		if (monitor.changed() || !finalTree.ok) {
			const treeFailure = monitor.changed() ? { code: "tree-changed" as const, message: "target tree changed while evidence was running" } : finalTree.ok ? { code: "tree-changed" as const, message: "target tree changed while evidence was running" } : failureForTree(finalTree.failure.code, finalTree.failure.message, inherited);
			for (let index = 0; index < criteria.length; index += 1) {
				const criterion = (request.node.acceptance ?? [])[index];
				const current = criteria[index];
				if (criterion && current?.outcome === "passed") criteria[index] = failed(criterion, tree, [{ ...treeFailure, message: redactCommandFailure(inherited, treeFailure.message) }], inherited, current.startedAt, current.finishedAt);
			}
		}
		const reportedChecklist = verifyChecklist("checklist" in request.node ? request.node.checklist : undefined, request.checklistReports, tree);
		const checklist: ChecklistResults = reportedChecklist.outcome === "complete" ? createCompleteChecklist([...reportedChecklist.items], reportedChecklist.tree) : reportedChecklist;
		if (criteria.length === 0) return { outcome: "failed", nodeId: request.node.id, tree, criteria: [], checklist, recordedAt: now() };
		const allPassed = criteria.every((criterion): criterion is PassedCriterionResult => criterion.outcome === "passed" && isCriterionPassed(criterion));
		if (!allPassed || checklist.outcome !== "complete" || !isCompleteChecklist(checklist)) {
			return { outcome: "failed", nodeId: request.node.id, tree, criteria, checklist, recordedAt: now() };
		}
		const [first, ...rest] = criteria;
		if (!first) return { outcome: "failed", nodeId: request.node.id, tree, criteria: [], checklist, recordedAt: now() };
		return createPassedNode(request.node.id, tree, [first, ...rest], checklist, now());
		} finally {
			monitor.stop();
		}
	}

	async function verifyNodeAndCache(request: VerifyNodeRequest, persist?: PersistVerification): Promise<{ result: VerificationResult; cacheUpdate?: VerificationCacheUpdate; cacheWrite?: StatusCacheVerificationWriteResult }> {
		request = snapshotRequest(request);
		const result = await verifyNode(request);
		if (!validResult(result)) return { result };
		const cacheUpdate = createCacheUpdate(request.specPath, result);
		if (!persist) return { result, cacheUpdate };
		const cacheWrite = await persist(cacheUpdate);
		// In-process code that can import src/ modules is trusted: it can already
		// write files and mutate this process. Serialized caller-authored data and
		// model-supplied tool input must not grant authority. Only a completed cache
		// write for these source bytes may attest, never a returned callback.
		if (cacheWrite.status === "written" && request.source !== undefined && isCacheUpdate(cacheUpdate)) recordMintedVerification(cacheUpdate, request.source);
		return { result, cacheUpdate, cacheWrite };
	}

	return Object.freeze({ readFabricInputs: readFabricVerificationInputs, inspectTarget: (target: VerificationTarget) => inspectTree(target.worktreePath, target.expectedCommit), verifyNode, verifyNodeAndCache, isCriterionPassed, isCompleteChecklist, isNodePassed, isCacheUpdate, verificationFailures: collectVerificationFailures });
}

function makeObservationalVerifier(adapters: ObservationalVerifierAdapters): ObservationalVerifier {
	const commandAdapter = adapters.command;
	const judgeAdapter = adapters.judge;
	const sessionAdapter = adapters.session;
	const maxInputBytes = adapters.maxInputBytes;
	const observationalAdapters: ObservationalVerifierAdapters = { command: commandAdapter, judge: judgeAdapter, session: sessionAdapter, maxInputBytes };
	async function verifyNode(request: VerifyNodeRequest): Promise<ObservedVerificationResult> {
		request = snapshotRequest(request);
		const inherited = request.inherited ?? nodeInheritedValues(request.node);
		const baseline = await inspectTree(request.target.worktreePath, request.target.expectedCommit);
		if (!baseline.ok) return observeVerificationResult(failedRecord(request.node, fallbackTree(request.target), [baseline.failure], inherited, request.checklistReports));
		const result = await runObservedNode(request, baseline.snapshot, observationalAdapters);
		return observeVerificationResult(result);
	}
	async function verifyNodeAndCache(request: VerifyNodeRequest): Promise<{ result: ObservedVerificationResult; cacheUpdate?: ObservedVerificationCacheUpdate }> {
		request = snapshotRequest(request);
		const result = await verifyNode(request);
		const cacheUpdate = decodeVerificationCacheUpdate({ kind: "verification-cache-update", specPath: request.specPath, nodeId: result.nodeId, recordedAt: result.recordedAt, tree: result.tree, record: result });
		return cacheUpdate ? { result, cacheUpdate } : { result };
	}
	return Object.freeze({ inspectTarget: (target: VerificationTarget) => inspectTree(target.worktreePath, target.expectedCommit), verifyNode, verifyNodeAndCache, isCriterionPassed: (_value: unknown): _value is PassedCriterionResult => false, isCompleteChecklist: (_value: unknown): _value is CompleteChecklistResults => false, isNodePassed: (_value: unknown): _value is NodeVerificationRecord => false, isCacheUpdate: (_value: unknown): _value is VerificationCacheUpdate => false, verificationFailures: collectVerificationFailures });
}

async function runObservedNode(request: VerifyNodeRequest, baseline: TreeSnapshot, adapters: ObservationalVerifierAdapters): Promise<VerificationResult> {
	const inherited = request.inherited ?? nodeInheritedValues(request.node);
	const monitor = await monitorTree(baseline);
	if (!monitor.ok) return failedRecord(request.node, baseline.identity, [monitor.failure], inherited, request.checklistReports);
	const criteria: (PassedCriterionResult | FailedCriterionResult)[] = [];
	try {
		for (const criterion of request.node.acceptance ?? []) {
			if (request.signal?.aborted) {
				criteria.push(failed(criterion, baseline.identity, [{ code: "verification-aborted", message: "verification was aborted before this criterion started" }], inherited));
				continue;
			}
			const startedAt = now();
			let result: Awaited<ReturnType<typeof runCommand>> | Awaited<ReturnType<typeof runAgent>> | Awaited<ReturnType<typeof runUser>>;
			if (criterion.evidence.kind === "command") result = await runCommand({ evidence: criterion.evidence, tree: baseline.identity, signal: request.signal, gitPath: baseline.gitPath, untrackedPaths: monitor.untrackedPaths, inherited, drainObservation: monitor.drain, monitoring: monitor.monitoring }, { ...adapters.command, timeoutMs: criterion.evidence.timeout_ms ?? adapters.command?.timeoutMs });
			else if (criterion.evidence.kind === "agent") result = await runAgent({ evidence: criterion.evidence, tree: baseline.identity, signal: request.signal }, { judge: adapters.judge, maxInputBytes: adapters.maxInputBytes });
			else result = await runUser({ evidence: criterion.evidence, specPath: request.specPath, nodeId: request.node.id, criterionId: criterion.id, tree: baseline.identity }, adapters.session);
			const unchanged = await verifyTreeUnchanged(baseline);
			if (result.outcome === "failed") {
				const failures = unchanged.ok ? result.failures : [...result.failures, failureForTree(unchanged.failure.code, unchanged.failure.message, inherited)];
				const [first, ...rest] = failures;
				criteria.push({ outcome: "failed", criterion: criterionSummary(criterion), attempt: result.attempt, failures: first ? [first, ...rest] : [{ code: "no-execution-evidence", message: "criterion produced no failure detail" }] });
			} else if (!unchanged.ok) criteria.push(failed(criterion, baseline.identity, [failureForTree(unchanged.failure.code, unchanged.failure.message, inherited)], inherited, startedAt, now()));
			else criteria.push({ outcome: "passed", criterion: criterionSummary(criterion), proof: result.proof, startedAt: result.proof.startedAt, finishedAt: result.proof.finishedAt, durationMs: result.proof.durationMs });
		}
		await monitor.drain();
		const finalTree = await verifyTreeUnchanged(baseline);
		if (monitor.changed() || !finalTree.ok) {
			const treeFailure = monitor.changed() ? { code: "tree-changed" as const, message: "target tree changed while evidence was running" } : finalTree.ok ? { code: "tree-changed" as const, message: "target tree changed while evidence was running" } : failureForTree(finalTree.failure.code, finalTree.failure.message, inherited);
			for (let index = 0; index < criteria.length; index += 1) {
				const criterion = (request.node.acceptance ?? [])[index];
				const current = criteria[index];
				if (criterion && current?.outcome === "passed") criteria[index] = failed(criterion, baseline.identity, [treeFailure], inherited, current.startedAt, current.finishedAt);
			}
		}
		const reportedChecklist = verifyChecklist("checklist" in request.node ? request.node.checklist : undefined, request.checklistReports, baseline.identity);
		const checklist: ChecklistResults = reportedChecklist;
		if (criteria.length === 0) return { outcome: "failed", nodeId: request.node.id, tree: baseline.identity, criteria: [], checklist, recordedAt: now() };
		if (!criteria.every((criterion) => criterion.outcome === "passed") || checklist.outcome !== "complete") return { outcome: "failed", nodeId: request.node.id, tree: baseline.identity, criteria: criteria.filter((criterion): criterion is FailedCriterionResult => criterion.outcome === "failed"), checklist, recordedAt: now() };
		const [first, ...rest] = criteria;
		if (!first) return { outcome: "failed", nodeId: request.node.id, tree: baseline.identity, criteria: [], checklist, recordedAt: now() };
		return { outcome: "passed", nodeId: request.node.id, tree: baseline.identity, criteria: [first, ...rest], checklist: checklist as CompleteChecklistResults, recordedAt: now() };
	} finally {
		monitor.stop();
	}
}

export function createVerifier(capabilities: VerifierCapabilities): AuthorityVerifier {
	return makeAuthorityVerifier(capabilities);
}

export function createObservationalVerifier(adapters: ObservationalVerifierAdapters = {}): ObservationalVerifier {
	return makeObservationalVerifier(adapters);
}

export function verificationFailures(result: VerificationResult | ObservedVerificationResult): VerificationFailure[] {
	return collectVerificationFailures(result);
}
