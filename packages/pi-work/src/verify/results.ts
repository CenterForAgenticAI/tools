import { createHash } from "node:crypto";

import type { AcceptanceCriterion, CommandEvidence, CommandExpectation, Evidence, WorkNode } from "../schema/workspec.js";

import { validCommandContainment } from "./containment.js";

export type GitTreeIdentity = Readonly<{
	kind: "git";
	worktreePath: string;
	resolvedCommit: string;
}>;

export type TreeIdentity = GitTreeIdentity;

export interface ExecutionWindow {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
}

export type TreeMonitoringMethod = "fs.watch" | "none";
export type TreeMonitoringMode = "recursive" | "directory-fallback" | "none";
export type TreeMonitoringResidualRace = "events-after-final-drain-may-be-missed" | "not-monitored";

export interface TreeMonitoringProof {
	method: TreeMonitoringMethod;
	mode: TreeMonitoringMode;
	window: ExecutionWindow;
	residualRace: TreeMonitoringResidualRace;
}

export interface CommandExecutionProof extends ExecutionWindow {
	kind: "command-proof";
	/** Missing only in legacy Linux cache records; new executions always set this. */
	containment?: "systemd-scope" | "process-group";
	authoredCommand: string;
	/** Absent in legacy proofs and when the spec uses the default timeout. */
	timeout_ms?: number;
	gitPath: string;
	executorPath: string;
	shellPath: string;
	expectation: CommandExpectation;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	outputMatched: string;
	untrackedPaths?: readonly string[];
	monitoring: TreeMonitoringProof;
	tree: TreeIdentity;
}

export interface NamedInputDigest {
	path: string;
	digest: string;
	bytes: number;
}

export interface AgentJudgmentProof extends ExecutionWindow {
	kind: "agent-proof";
	agent: string;
	rubric: string;
	rubricDigest: string;
	inputs: [NamedInputDigest, ...NamedInputDigest[]];
	verdict: "approve";
	dispatchReceipt: string;
	tree: TreeIdentity;
}

export interface UserConfirmationProof extends ExecutionWindow {
	kind: "user-proof";
	prompt: string;
	challenge: string;
	sessionId: string;
	sessionFile: string;
	entryId: string;
	entryTimestamp: string;
	tree: TreeIdentity;
}

export type CriterionProof = CommandExecutionProof | AgentJudgmentProof | UserConfirmationProof;

export type VerificationFailure =
	| { code: "positive-floor-missing"; message: string }
	| { code: "spawn-error"; message: string; errorCode?: string }
	| { code: "cleanup-unavailable"; message: string }
	| { code: "cleanup-failed"; message: string }
	| { code: "timeout"; message: string; timedOut: true }
	| { code: "aborted"; message: string }
	| { code: "output-limit"; message: string }
	| { code: "shell-unavailable"; message: string; exitCode: 126 | 127 }
	| { code: "signaled"; message: string; signal: NodeJS.Signals }
	| { code: "exit-mismatch"; message: string; expected: number; actual: number | null }
	| { code: "output-mismatch"; message: string; expected: string }
	| { code: "tree-identity-unavailable"; message: string }
	| { code: "tree-mismatch"; message: string; expected: string; actual: string }
	| { code: "tree-dirty"; message: string }
	| { code: "tree-changed"; message: string }
	| { code: "input-missing"; message: string; path: string }
	| { code: "input-unreadable"; message: string; path: string }
	| { code: "input-not-file"; message: string; path: string }
	| { code: "input-too-large"; message: string; path: string }
	| { code: "input-path-escape"; message: string; path: string }
	| { code: "agent-inputs-empty"; message: string }
	| { code: "agent-unavailable"; message: string }
	| { code: "agent-rejected"; message: string }
	| { code: "agent-malformed"; message: string }
	| { code: "dispatch-failed"; message: string }
	| { code: "executable-unavailable"; message: string; executable: string }
	| { code: "user-confirmation-required"; message: string; challenge: string }
	| { code: "user-not-confirmed"; message: string }
	| { code: "session-unavailable"; message: string }
	| { code: "checklist-incomplete"; message: string; indexes: number[] }
	| { code: "checklist-accounting"; message: string }
	| { code: "no-execution-evidence"; message: string }
	| { code: "verification-aborted"; message: string };

export interface CriterionAttempt {
	kind: Evidence["kind"];
	evidence: Evidence;
	startedAt: string;
	finishedAt: string;
	tree: TreeIdentity;
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
}

export interface FailedCriterionResult {
	outcome: "failed";
	criterion: Pick<AcceptanceCriterion, "id" | "statement">;
	attempt: CriterionAttempt;
	failures: [VerificationFailure, ...VerificationFailure[]];
}

/** A passed criterion is trusted only by the verifier instance that made it. */
export interface PassedCriterionResult extends ExecutionWindow {
	readonly outcome: "passed";
	readonly criterion: Readonly<Pick<AcceptanceCriterion, "id" | "statement">>;
	readonly proof: CriterionProof;
}
export type CriterionResult = PassedCriterionResult | FailedCriterionResult;

export interface ChecklistItemResult {
	index: number;
	item: string;
	done: boolean;
	tree: TreeIdentity;
}

export interface IncompleteChecklistResults {
	outcome: "incomplete";
	items: ChecklistItemResult[];
	failures: [VerificationFailure, ...VerificationFailure[]];
	tree: TreeIdentity;
}

/** A complete checklist is trusted only by the verifier instance that made it. */
export interface CompleteChecklistResults {
	readonly outcome: "complete";
	readonly items: readonly ChecklistItemResult[];
	readonly failures: readonly [];
	readonly tree: TreeIdentity;
}
export type ChecklistResults = CompleteChecklistResults | ObservedCompleteChecklistResults | IncompleteChecklistResults;

/** A passed node is trusted only by the verifier instance that made it. */
export interface NodeVerificationRecord {
	readonly outcome: "passed";
	readonly nodeId: string;
	readonly tree: TreeIdentity;
	readonly criteria: readonly [PassedCriterionResult, ...PassedCriterionResult[]];
	readonly checklist: CompleteChecklistResults;
	readonly recordedAt: string;
}
export interface FailedVerification {
	outcome: "failed";
	nodeId: string;
	tree: TreeIdentity;
	criteria: FailedCriterionResult[];
	checklist: ChecklistResults;
	recordedAt: string;
}

export type VerificationResult = NodeVerificationRecord | FailedVerification;

/** Cache updates are trusted only by the verifier instance that made them. */
export interface VerificationCacheUpdate {
	readonly kind: "verification-cache-update";
	readonly specPath: string;
	readonly nodeId: string;
	readonly recordedAt: string;
	readonly tree: TreeIdentity;
	readonly record: VerificationResult;
}

const observedRecordBrand = Symbol("observed verification record");
const observedRecordObjects = new WeakSet<object>();

function deepFreezeObserved<T>(value: T, seen = new Set<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) deepFreezeObserved(descriptor.value, seen);
	}
	return Object.freeze(value);
}

export interface ObservedPassedCriterionResult extends ExecutionWindow {
	readonly outcome: "passed";
	readonly criterion: Readonly<Pick<AcceptanceCriterion, "id" | "statement">>;
	readonly proof: CriterionProof;
}

export type ObservedCriterionResult = ObservedPassedCriterionResult | FailedCriterionResult;
export interface ObservedCompleteChecklistResults {
	readonly outcome: "complete";
	readonly items: readonly ChecklistItemResult[];
	readonly failures: readonly [];
	readonly tree: TreeIdentity;
}
export type ObservedChecklistResults = ObservedCompleteChecklistResults | IncompleteChecklistResults;

export interface ObservedNodeVerificationRecord {
	readonly [observedRecordBrand]?: true;
	readonly outcome: "passed";
	readonly nodeId: string;
	readonly tree: TreeIdentity;
	readonly criteria: readonly ObservedPassedCriterionResult[];
	readonly checklist: ObservedChecklistResults;
	readonly recordedAt: string;
}

export interface ObservedFailedVerification {
	readonly outcome: "failed";
	readonly nodeId: string;
	readonly tree: TreeIdentity;
	readonly criteria: FailedCriterionResult[];
	readonly checklist: ObservedChecklistResults;
	readonly recordedAt: string;
}

export type ObservedVerificationResult = ObservedNodeVerificationRecord | ObservedFailedVerification;

export interface ObservedVerificationCacheUpdate {
	readonly kind: "verification-cache-update";
	readonly specPath: string;
	readonly nodeId: string;
	readonly recordedAt: string;
	readonly tree: TreeIdentity;
	readonly record: ObservedVerificationResult;
}

export function isCriterionPassed(_result: unknown): _result is PassedCriterionResult {
	return false;
}

export function isNodePassed(_result: unknown): _result is NodeVerificationRecord {
	return false;
}

/** Reports a persisted record's observation without treating it as execution authority. */
export function isObservedNodePassed(result: ObservedVerificationResult): result is ObservedNodeVerificationRecord {
	return result.outcome === "passed" && observedRecordObjects.has(result);
}

export function evidenceKind(evidence: Evidence): Evidence["kind"] {
	return evidence.kind;
}

export type VerificationNodeInput = {
	node: WorkNode;
	tree: TreeIdentity;
	criteria: readonly AcceptanceCriterion[];
};

export type CommandAttempt = {
	evidence: CommandEvidence;
	startedAt: string;
	finishedAt: string;
	tree: TreeIdentity;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): value is string {
	return typeof value === "string";
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function timestamp(value: unknown): value is string {
	return stringValue(value) && Number.isFinite(Date.parse(value));
}

function treeValue(value: unknown): value is TreeIdentity {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case "git": return stringValue(value.worktreePath) && value.worktreePath.startsWith("/") && stringValue(value.resolvedCommit) && /^[0-9a-f]{40}$/.test(value.resolvedCommit);
		default: return false;
	}
}

function sameTree(left: TreeIdentity, right: TreeIdentity): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "git":
			if (right.kind !== "git") return false;
			return left.worktreePath === right.worktreePath && left.resolvedCommit === right.resolvedCommit;
	}
}

function windowValue(value: unknown): value is ExecutionWindow {
	if (!isRecord(value) || !timestamp(value.startedAt) || !timestamp(value.finishedAt) || !finiteNumber(value.durationMs) || value.durationMs < 0) return false;
	const started = Date.parse(value.startedAt);
	const finished = Date.parse(value.finishedAt);
	return finished >= started && value.durationMs === finished - started;
}

function criterionSummaryValue(value: unknown): value is Pick<AcceptanceCriterion, "id" | "statement"> {
	return isRecord(value) && stringValue(value.id) && value.id.length > 0 && stringValue(value.statement);
}

function expectationValue(value: unknown): value is CommandExpectation {
	return isRecord(value) && Number.isInteger(value.exit) && stringValue(value.output_includes) && value.output_includes.length > 0;
}

function monitoringValue(value: unknown): value is TreeMonitoringProof {
	if (!isRecord(value) || !windowValue(value.window) || value.residualRace !== "events-after-final-drain-may-be-missed") return false;
	return value.method === "fs.watch" && (value.mode === "recursive" || value.mode === "directory-fallback");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function namedInputValue(value: unknown): value is NamedInputDigest {
	return isRecord(value) && stringValue(value.path) && value.path.length > 0 && stringValue(value.digest) && /^[a-f0-9]{64}$/.test(value.digest) && typeof value.bytes === "number" && Number.isInteger(value.bytes) && value.bytes >= 0;
}

function sameWindow(left: ExecutionWindow, right: ExecutionWindow): boolean {
	return left.startedAt === right.startedAt && left.finishedAt === right.finishedAt && left.durationMs === right.durationMs;
}

function proofValue(value: unknown, tree: TreeIdentity): value is CriterionProof {
	if (!isRecord(value) || !windowValue(value) || !treeValue(value.tree) || !sameTree(value.tree, tree)) return false;
	if (value.kind === "command-proof") {
		// Pre-containment cache records omitted the field and were Linux/systemd-only.
		if (!validCommandContainment(value.containment, value.executorPath, value.shellPath)) return false;
		const untrackedPathsValid = value.untrackedPaths === undefined || (Array.isArray(value.untrackedPaths) && value.untrackedPaths.every((item: unknown) => stringValue(item) && item.length > 0));
		const timeoutValid = value.timeout_ms === undefined || (typeof value.timeout_ms === "number" && Number.isInteger(value.timeout_ms) && value.timeout_ms >= 1_000 && value.timeout_ms <= 3_600_000);
		if (!timeoutValid || !stringValue(value.authoredCommand) || value.authoredCommand.length === 0 || !stringValue(value.gitPath) || !value.gitPath.startsWith("/") || !stringValue(value.executorPath) || !value.executorPath.startsWith("/") || !stringValue(value.shellPath) || !value.shellPath.startsWith("/") || !expectationValue(value.expectation) || !stringValue(value.stdout) || !stringValue(value.stderr) || !Number.isInteger(value.exitCode) || value.exitCode !== value.expectation.exit || value.signal !== null || !stringValue(value.outputMatched) || value.outputMatched !== value.expectation.output_includes || !untrackedPathsValid || !monitoringValue(value.monitoring)) return false;
		return value.stdout.includes(value.outputMatched) || value.stderr.includes(value.outputMatched);
	}
	if (value.kind === "agent-proof") {
		if (!stringValue(value.agent) || value.agent.length === 0 || !stringValue(value.rubric) || !stringValue(value.rubricDigest) || value.rubricDigest !== sha256(value.rubric) || value.verdict !== "approve" || !stringValue(value.dispatchReceipt) || value.dispatchReceipt.trim().length === 0 || !Array.isArray(value.inputs) || value.inputs.length === 0) return false;
		return value.inputs.every(namedInputValue);
	}
	if (value.kind === "user-proof") {
		return stringValue(value.prompt) && stringValue(value.challenge) && value.challenge.length > 0 && stringValue(value.sessionId) && value.sessionId.length > 0 && stringValue(value.sessionFile) && value.sessionFile.length > 0 && stringValue(value.entryId) && value.entryId.length > 0 && timestamp(value.entryTimestamp);
	}
	return false;
}

function failureValue(value: unknown): value is VerificationFailure {
	return isRecord(value) && stringValue(value.code) && stringValue(value.message);
}

function attemptValue(value: unknown, tree: TreeIdentity): value is CriterionAttempt {
	const coherent = isRecord(value) && timestamp(value.startedAt) && timestamp(value.finishedAt) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
	return coherent && (value.kind === "command" || value.kind === "agent" || value.kind === "user") && isRecord(value.evidence) && treeValue(value.tree) && sameTree(value.tree, tree) && (value.stdout === undefined || stringValue(value.stdout)) && (value.stderr === undefined || stringValue(value.stderr)) && (value.exitCode === undefined || value.exitCode === null || Number.isInteger(value.exitCode));
}

function failedCriterionValue(value: unknown, tree: TreeIdentity): value is FailedCriterionResult {
	return isRecord(value) && value.outcome === "failed" && criterionSummaryValue(value.criterion) && attemptValue(value.attempt, tree) && Array.isArray(value.failures) && value.failures.length > 0 && value.failures.every(failureValue);
}

function itemValue(value: unknown, tree: TreeIdentity): value is ChecklistItemResult {
	return isRecord(value) && typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 && stringValue(value.item) && typeof value.done === "boolean" && treeValue(value.tree) && sameTree(value.tree, tree);
}

function observeRecord<T extends object>(value: T): T {
	Object.defineProperty(value, observedRecordBrand, { value: true, enumerable: false });
	observedRecordObjects.add(value);
	return deepFreezeObserved(value);
}

/** Convert a verifier result to an immutable observation without carrying its authority. */
export function observeVerificationResult(result: VerificationResult): ObservedVerificationResult {
	const observed = decodeVerificationCacheUpdate({
		kind: "verification-cache-update",
		specPath: "observed",
		nodeId: result.nodeId,
		recordedAt: result.recordedAt,
		tree: result.tree,
		record: result,
	});
	if (!observed) throw new TypeError("invalid verification observation");
	return observed.record;
}

function decodeChecklist(value: unknown, tree: TreeIdentity): ObservedChecklistResults | undefined {
	if (!isRecord(value) || !treeValue(value.tree) || !sameTree(value.tree, tree) || !Array.isArray(value.items) || !value.items.every((item: unknown) => itemValue(item, tree))) return undefined;
	if (value.outcome === "complete") {
		if (!(value.failures instanceof Array) || value.failures.length !== 0 || !value.items.every((item: ChecklistItemResult) => item.done)) return undefined;
		return { outcome: "complete", items: value.items, failures: [], tree };
	}
	if (value.outcome !== "incomplete" || !Array.isArray(value.failures) || value.failures.length === 0 || !value.failures.every(failureValue)) return undefined;
	const [firstFailure, ...restFailures] = value.failures;
	if (!firstFailure) return undefined;
	return { outcome: "incomplete", items: value.items, failures: [firstFailure, ...restFailures], tree };
}

function decodeCriterion(value: unknown, tree: TreeIdentity): ObservedCriterionResult | undefined {
	if (!isRecord(value) || !criterionSummaryValue(value.criterion)) return undefined;
	if (value.outcome === "failed") return failedCriterionValue(value, tree) ? value : undefined;
	if (value.outcome !== "passed" || !windowValue(value) || !proofValue(value.proof, tree) || !sameWindow(value, value.proof)) return undefined;
	return { outcome: "passed", criterion: value.criterion, startedAt: value.startedAt, finishedAt: value.finishedAt, durationMs: value.durationMs, proof: value.proof };
}

function decodeResult(value: unknown, tree: TreeIdentity): ObservedVerificationResult | undefined {
	if (!isRecord(value) || !stringValue(value.nodeId) || !stringValue(value.recordedAt) || !treeValue(value.tree) || !sameTree(value.tree, tree) || !Array.isArray(value.criteria)) return undefined;
	const checklist = decodeChecklist(value.checklist, tree);
	if (!checklist) return undefined;
	const criteria: ObservedCriterionResult[] = [];
	for (const criterion of value.criteria) {
		const decoded = decodeCriterion(criterion, tree);
		if (!decoded) return undefined;
		criteria.push(decoded);
	}
	if (value.outcome === "failed") {
		if (!criteria.every((criterion): criterion is FailedCriterionResult => criterion.outcome === "failed")) return undefined;
		return { outcome: "failed" as const, nodeId: value.nodeId, tree, criteria, checklist, recordedAt: value.recordedAt };
	}
	if (value.outcome !== "passed" || criteria.length === 0 || !criteria.every((criterion): criterion is ObservedPassedCriterionResult => criterion.outcome === "passed") || checklist.outcome !== "complete") return undefined;
	const [first, ...rest] = criteria;
	if (!first || first.outcome !== "passed") return undefined;
	return observeRecord({ outcome: "passed" as const, nodeId: value.nodeId, tree, criteria: [first, ...rest.filter((criterion): criterion is ObservedPassedCriterionResult => criterion.outcome === "passed")], checklist, recordedAt: value.recordedAt });
}

/** Decode untrusted serialized cache data for reporting; it never restores verifier authority. */
export function decodeVerificationCacheUpdate(value: unknown): ObservedVerificationCacheUpdate | undefined {
	if (!isRecord(value) || value.kind !== "verification-cache-update" || !stringValue(value.specPath) || !treeValue(value.tree) || !stringValue(value.nodeId) || !stringValue(value.recordedAt)) return undefined;
	const result = decodeResult(value.record, value.tree);
	if (!result || result.nodeId !== value.nodeId || result.recordedAt !== value.recordedAt || !sameTree(result.tree, value.tree)) return undefined;
	return deepFreezeObserved({ kind: "verification-cache-update" as const, specPath: value.specPath, nodeId: value.nodeId, recordedAt: value.recordedAt, tree: result.tree, record: result });
}

export function isCompleteChecklist(_value: unknown): _value is CompleteChecklistResults {
	return false;
}
