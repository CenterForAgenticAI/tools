import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { validateWorkspec, type Finding } from "../schema/index.js";
import { errorCount } from "../schema/findings.js";
import { inspectTree, resolveSpecPath, type VerificationFailure } from "../verify/index.js";
import { confinedPath } from "../tools/confined-path.js";
import { addressKey } from "../plan/index.js";
import { isCompositeNode } from "../schema/dependencies.js";
import type { AcceptanceCriterion, WorkNode, Workspec } from "../schema/workspec.js";
import { buildStatusGraph } from "./graph.js";
import { classifyStatusCache, decodeStatusCache, readStatusCache, statusCachePath } from "./cache.js";
import { renderBlockers } from "./derive.js";
import { refreshStatus } from "./refresh.js";
import type {
	DerivedStatusContext,
	DeriveStatusInput,
	LifecycleState,
	NodeStatusReport,
	ObservationReport,
	ReviewState,
	StatusBlocker,
	StatusFinding,
	StatusRequest,
	StatusGraph,
	VerificationState,
	WorkStatusDetails,
	WorkStatusResult,
} from "./types.js";
import { lifecycleText, refreshBlocked, reviewText, verificationText, type NodeAddress, type StatusCacheV1, type TreeIdentity } from "./types.js";

export * from "./types.js";
export { blockedRefresh, refreshStatus } from "./refresh.js";


function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function invalidDetails(input: Partial<StatusRequest>, cachePath: string, findings: readonly (Finding | StatusFinding | VerificationFailure)[]): WorkStatusResult {
	return {
		ok: false,
		details: {
			path: input.path ?? "",
			cachePath,
			valid: false,
			findings,
			nodes: [],
			specState: "not-done",
			unresolvedDecisions: [],
			dispatch: {},
			refresh: refreshBlocked(),
			refreshed: false,
			truncated: false,
		},
	};
}

function abortedDetails(input: Partial<StatusRequest>, cachePath: string): WorkStatusResult {
	return invalidDetails(input, cachePath, [{ code: "verification-aborted", message: "status operation was aborted" }]);
}

function aborted(input: Partial<StatusRequest>, cachePath: string): WorkStatusResult | undefined {
	return input.signal?.aborted ? abortedDetails(input, cachePath) : undefined;
}

function validNodeAddress(value: unknown): value is NodeAddress {
	return Array.isArray(value) && value.length > 0 && value.every((segment) => typeof segment === "string" && segment.length > 0);
}

function validateRefreshAddresses(graph: StatusGraph, request: StatusRequest): StatusFinding[] {
	const findings: StatusFinding[] = [];
	const refresh = request.refresh;
	if (!refresh) return findings;
	const addresses = refresh.nodeAddresses ?? graph.assemblies.filter((assembly) => (assembly.node.acceptance?.length ?? 0) > 0 || "checklist" in assembly.node).map((assembly) => assembly.address);
	const seen = new Set<string>();
	for (const address of addresses) {
		if (!validNodeAddress(address)) {
			findings.push({ code: "refresh-address-required", message: "refresh nodeAddresses must contain non-empty qualified NodeAddress arrays" });
			continue;
		}
		const key = addressKey(address);
		if (seen.has(key)) {
			findings.push({ code: "duplicate-node-address", address, message: `refresh selected ${key} more than once` });
			continue;
		}
		seen.add(key);
		if (!graph.byAddress.has(key)) findings.push({ code: "missing-node-address", address, message: `refresh selected unknown address ${key}` });
	}
	const checklistSeen = new Set<string>();
	for (const entry of refresh.checklists ?? []) {
		if (!validNodeAddress(entry.nodeAddress)) {
			findings.push({ code: "refresh-address-required", message: "checklist reports require a qualified NodeAddress" });
			continue;
		}
		const key = addressKey(entry.nodeAddress);
		if (checklistSeen.has(key)) findings.push({ code: "duplicate-checklist-address", address: entry.nodeAddress, message: `checklist reports select ${key} more than once` });
		checklistSeen.add(key);
		const assembly = graph.byAddress.get(key);
		if (!assembly) {
			findings.push({ code: "missing-node-address", address: entry.nodeAddress, message: `checklist reports select unknown address ${key}` });
			continue;
		}
		const indexes = new Set<number>();
		for (const report of entry.reports) {
			if (!Number.isInteger(report.index) || report.index < 0 || indexes.has(report.index) || typeof report.done !== "boolean") findings.push({ code: "invalid-checklist-report", address: entry.nodeAddress, message: `checklist report for ${key} is malformed or duplicated` });
			indexes.add(report.index);
		}
		if (!("checklist" in assembly.node)) findings.push({ code: "invalid-checklist-report", address: entry.nodeAddress, message: `checklist reports target ${key}, which has no authored checklist` });
	}
	return findings;
}

function cacheContext(tree: TreeIdentity, graph: StatusGraph, cache: StatusCacheV1 | undefined, cacheFindings: readonly StatusFinding[], specPath: string): DerivedStatusContext {
	const classified = classifyStatusCache(cache, graph, tree, specPath, tree.kind === "git" ? tree.worktreePath : "");
	return {
		graph,
		observations: classified.observations,
		review: classified.review,
		dispatch: classified.dispatch,
		findings: [...cacheFindings, ...classified.findings],
	};
}

function hasChecklist(node: WorkNode): node is WorkNode & { checklist: string[] } {
	return "checklist" in node && Array.isArray(node.checklist);
}

function hasPositiveFloor(criterion: AcceptanceCriterion): boolean {
	return criterion.evidence.kind !== "command" || typeof criterion.evidence.expect.output_includes === "string" && criterion.evidence.expect.output_includes.length > 0;
}

function contractFindings(address: readonly string[], node: WorkNode): { findings: StatusFinding[]; blockers: StatusBlocker[] } {
	const findings: StatusFinding[] = [];
	const blockers: StatusBlocker[] = [];
	const criteria = node.acceptance ?? [];
	const composite = isCompositeNode(node);
	if (criteria.length === 0 && (!composite || node.work.length === 0)) blockers.push({ code: "completion-contract", reason: "no-execution-evidence" });
	for (const criterion of criteria) {
		if (!hasPositiveFloor(criterion)) {
			findings.push({ code: "positive-floor-missing", address, criterionId: criterion.id, message: `criterion ${criterion.id} has no positive output floor` });
			blockers.push({ code: "completion-contract", reason: "positive-floor-missing" });
		}
	}
	if (hasChecklist(node) && node.checklist.some((item) => item.length === 0)) blockers.push({ code: "completion-contract", reason: "checklist-incomplete" });
	return { findings, blockers };
}

function observationState(observation: ObservationReport | undefined, tree: TreeIdentity): { state: VerificationState; observation?: ObservationReport } {
	if (!observation) return { state: "unverified" };
	if (observation.state === "stale-observation") return { state: "stale-observation", observation };
	if (observation.state === "conflicting-observation") return { state: "conflicting-observation", observation };
	if (observation.state === "observed-green-not-verified-this-session") return { state: "observed-green-not-verified-this-session", observation };
	if (observation.state === "observed-failure-not-verified-this-session") return { state: "observed-failure-not-verified-this-session", observation };
	void tree;
	return { state: "unverified" };
}

function uniqueAddresses(addresses: readonly (readonly string[])[]): NodeAddress[] {
	const result: NodeAddress[] = [];
	const seen = new Set<string>();
	for (const address of addresses) {
		const key = addressKey(address);
		if (!seen.has(key)) {
			seen.add(key);
			result.push([...address]);
		}
	}
	return result;
}

interface DerivationOutput {
	readonly nodes: readonly NodeStatusReport[];
	readonly specState: "done" | "not-done";
	readonly findings: readonly StatusFinding[];
}

/** Reduce only the validated source graph assembled by the owning status boundary. */
function deriveValidatedStatus(spec: Workspec, tree: TreeIdentity, context: DerivedStatusContext): DerivationOutput {
	const trustedCurrent = new Map<string, "passed" | "failed">();
	const memo = new Map<string, NodeStatusReport>();
	const visiting = new Set<string>();
	const findings: StatusFinding[] = [...context.findings];

	function reportFor(address: readonly string[]): NodeStatusReport {
		const key = addressKey(address);
		const existing = memo.get(key);
		if (existing) return existing;
		const assembly = context.graph.byAddress.get(key);
		if (!assembly) {
			const missing: NodeStatusReport = {
				address: [...address],
				nodeId: address[address.length - 1] ?? "",
				task: "",
				lifecycle: "blocked",
				verification: "unverified",
				review: "not-configured",
				reviewText: reviewText("not-configured"),
				dispatches: [],
				blockers: [{ code: "completion-contract", reason: "no-execution-evidence" }],
				findings: [],
				lifecycleText: lifecycleText("blocked"),
				verificationText: verificationText("unverified"),
			};
			memo.set(key, missing);
			return missing;
		}
		if (visiting.has(key)) {
			const cycle: NodeStatusReport = {
				address: [...address],
				nodeId: assembly.node.id,
				task: assembly.node.task,
				lifecycle: "blocked",
				verification: "unverified",
				review: "not-configured",
				reviewText: reviewText("not-configured"),
				dispatches: [],
				blockers: [{ code: "dependency", addresses: [[...address]] }],
				findings: [],
				lifecycleText: lifecycleText("blocked"),
				verificationText: verificationText("unverified"),
			};
			memo.set(key, cycle);
			return cycle;
		}
		visiting.add(key);
		const nodeFindings: StatusFinding[] = [];
		const blockers: StatusBlocker[] = [];
		const dependencyReports = (context.graph.ancestorDependencies.get(key) ?? []).map((dependency) => ({ address: dependency, report: reportFor(dependency) }));
		const dependencyBlockers = dependencyReports.filter(({ report }) => report.lifecycle !== "done").map(({ address }) => address);
		if (dependencyBlockers.length > 0) blockers.push({ code: "dependency", addresses: uniqueAddresses(dependencyBlockers) });

		const childReports = (context.graph.children.get(key) ?? []).map((child) => ({ address: child, report: reportFor(child) }));
		const childBlockers = childReports.filter(({ report }) => report.lifecycle !== "done").map(({ address }) => address);
		if (childBlockers.length > 0) blockers.push({ code: "children", addresses: uniqueAddresses(childBlockers) });

		const contract = contractFindings(address, assembly.node);
		nodeFindings.push(...contract.findings);
		blockers.push(...contract.blockers);

		const trusted = trustedCurrent.get(key);
		const isComposite = isCompositeNode(assembly.node);
		const hasDirectRequirement = (assembly.node.acceptance ?? []).length > 0;
		const directRequirementSatisfied = !hasDirectRequirement || trusted === "passed";
		const checklistSatisfied = !hasChecklist(assembly.node) || trusted === "passed";
		const childrenSatisfied = !isComposite || childReports.every(({ report }) => report.lifecycle === "done");
		const canBeDone = dependencyBlockers.length === 0 && blockers.every((blocker) => blocker.code !== "completion-contract") && directRequirementSatisfied && checklistSatisfied && childrenSatisfied && (!hasDirectRequirement || trusted !== undefined);
		const hasBlockingPrerequisite = dependencyBlockers.length > 0 || childBlockers.length > 0 || blockers.some((blocker) => blocker.code === "completion-contract");
		let lifecycle: LifecycleState;
		if (hasBlockingPrerequisite) lifecycle = "blocked";
		else if (spec.open_decisions && spec.open_decisions.length > 0) {
			blockers.push({ code: "open-decision", ids: spec.open_decisions.map((decision) => decision.id) });
			lifecycle = "needs-decision";
		} else if (canBeDone && (!hasDirectRequirement || trusted === "passed")) lifecycle = "done";
		else if (blockers.length > 0) lifecycle = "blocked";
		else lifecycle = "ready";

		const observationValue = context.observations.get(key);
		const observedUpdate = observationValue && "update" in observationValue ? observationValue.update : undefined;
		const observation = observationState(observationValue, tree);
		let verification: VerificationState = observation.state;
		if (trusted === "passed") verification = "verified-this-session";
		else if (trusted === "failed") verification = "failed-this-session";
		const review: ReviewState = context.review.get(key) ?? "not-configured";
		const dispatches = Object.values(context.dispatch)
			.filter((entry) => addressKey(entry.address) === key)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		const renderedVerification = verification === "stale-observation" ? verificationText(verification, { old: observedUpdate?.tree.kind === "git" ? observedUpdate.tree.resolvedCommit : undefined, current: tree.kind === "git" ? tree.resolvedCommit : undefined }) : verification === "observed-green-not-verified-this-session" || verification === "observed-failure-not-verified-this-session" || verification === "verified-this-session" || verification === "failed-this-session" ? verificationText(verification, { sha: tree.kind === "git" ? tree.resolvedCommit : undefined }) : verificationText(verification);
		const result: NodeStatusReport = {
			address: [...address],
			nodeId: assembly.node.id,
			task: assembly.node.task,
			lifecycle,
			verification,
			...(observedUpdate === undefined ? {} : { verificationObservation: observedUpdate.record }),
			review,
			reviewText: reviewText(review),
			dispatches,
			blockers,
			findings: nodeFindings,
			lifecycleText: lifecycleText(lifecycle, {
				blockers: lifecycle === "blocked" ? renderBlockers(blockers) : undefined,
				decisions: lifecycle === "needs-decision" ? spec.open_decisions?.map((decision) => decision.id).join(", ") : undefined,
			}),
			verificationText: renderedVerification,
		};
		visiting.delete(key);
		memo.set(key, result);
		return result;
	}

	for (const assembly of context.graph.assemblies) {
		const report = reportFor(assembly.address);
		findings.push(...report.findings);
	}
	const nodes = context.graph.assemblies.map((assembly) => memo.get(addressKey(assembly.address))!).filter(Boolean);
	return { nodes, specState: nodes.length > 0 && nodes.every((node) => node.lifecycle === "done") ? "done" : "not-done", findings };
}

function deriveStatusDetails(spec: Workspec, specPath: string, tree: TreeIdentity, context: DerivedStatusContext, cachePath: string, refresh: WorkStatusDetails["refresh"]): WorkStatusDetails {
	const derived = deriveValidatedStatus(spec, tree, context);
	return {
		path: specPath,
		cachePath,
		currentTree: tree,
		specState: derived.specState,
		valid: true,
		findings: derived.findings,
		nodes: derived.nodes,
		unresolvedDecisions: (spec.open_decisions ?? []).map((decision) => decision.id),
		dispatch: context.dispatch,
		refresh,
		refreshed: false,
		truncated: false,
	};
}

/** Safe pure boundary: validates source before decoding any supplied cache value. */
export function deriveStatus(input: DeriveStatusInput): WorkStatusResult {
	if (!input || typeof input.source !== "string" || !input.source.length || typeof input.specPath !== "string" || !input.specPath.length || !input.tree || input.tree.kind !== "git" || !input.tree.worktreePath.startsWith("/") || !/^[0-9a-f]{40}$/.test(input.tree.resolvedCommit)) return invalidDetails({ path: input?.specPath ?? "" }, "", [{ code: "invalid-status-input", message: "source, specPath, and a valid git TreeIdentity are required" }]);
	if (!path.isAbsolute(input.specPath) || !inside(input.tree.worktreePath, input.specPath)) return invalidDetails({ path: input.specPath }, "", [{ code: "spec-path-escape", path: ["path"], message: "spec path escapes the target worktree" }]);
	const validation = validateWorkspec(input.source, { specPath: input.specPath, cwd: input.tree.worktreePath });
	if (!validation.structuralValid || !validation.valid) return invalidDetails({ path: input.specPath }, "", validation.findings);
	const decoded = input.cache === undefined ? { findings: [] as readonly StatusFinding[] } : decodeStatusCache(input.cache);
	const cache = decoded.cache;
	const graphBuild = buildStatusGraph(validation.spec);
	const context = cacheContext(input.tree, graphBuild.graph, cache, decoded.findings, input.specPath);
	const details = deriveStatusDetails(validation.spec, input.specPath, input.tree, { ...context, findings: [...graphBuild.findings, ...context.findings] }, statusCachePath(input.tree.worktreePath, input.specPath), refreshBlocked());
	return { ok: errorCount(validation.findings) === 0, details };
}

/** Read and derive a workspec using explicit target-tree identity. */
export async function getWorkStatus(request: StatusRequest): Promise<WorkStatusResult> {
	if (!request || typeof request.path !== "string" || request.path.length === 0 || typeof request.worktreePath !== "string" || request.worktreePath.length === 0 || typeof request.expectedCommit !== "string" || request.expectedCommit.length === 0) return invalidDetails(request ?? {}, "", [{ code: "invalid-status-input", message: "path, worktreePath, and expectedCommit are required and may not be empty" }]);
	const pathInput = confinedPath(request.path, "path");
	if (!pathInput.ok) return invalidDetails(request, "", [pathInput.finding]);
	const beforeRoot = aborted(request, "");
	if (beforeRoot) return beforeRoot;
	let root: string;
	try {
		root = await realpath(request.worktreePath);
	} catch (error) {
		return invalidDetails(request, "", [{ code: "tree-identity-error", message: error instanceof Error ? error.message : String(error) }]);
	}
	const afterRoot = aborted(request, "");
	if (afterRoot) return afterRoot;
	const authoredPath = resolveSpecPath(root, pathInput.relativePath);
	if (!inside(root, authoredPath)) return invalidDetails(request, "", [{ code: "spec-path-escape", path: ["path"], message: "spec path escapes the target worktree" }]);
	let specPath: string;
	let source: string;
	try {
		specPath = await realpath(authoredPath);
		const afterSpecPath = aborted(request, statusCachePath(root, specPath));
		if (afterSpecPath) return afterSpecPath;
		if (!inside(root, specPath)) return invalidDetails(request, "", [{ code: "spec-path-escape", path: ["path"], message: "spec path symlink escapes the target worktree" }]);
		source = await readFile(specPath, "utf8");
	} catch (error) {
		return invalidDetails(request, "", [{ code: "spec-read-error", path: ["path"], message: error instanceof Error ? error.message : String(error) }]);
	}
	const afterSource = aborted(request, statusCachePath(root, specPath));
	if (afterSource) return afterSource;
	const validation = validateWorkspec(source, { specPath, cwd: root });
	if (!validation.structuralValid || !validation.valid) return invalidDetails(request, statusCachePath(root, specPath), validation.findings);
	const treeCheck = await inspectTree(root, request.expectedCommit);
	const afterTree = aborted(request, statusCachePath(root, specPath));
	if (afterTree) return afterTree;
	if (!treeCheck.ok) return invalidDetails({ ...request, path: specPath }, statusCachePath(root, specPath), [{ code: "tree-identity-error", message: treeCheck.failure.message }]);
	const graphBuild = buildStatusGraph(validation.spec);
	const requestFindings = validateRefreshAddresses(graphBuild.graph, request);
	if (requestFindings.length > 0) {
		const details = invalidDetails({ ...request, path: specPath }, statusCachePath(root, specPath), [...graphBuild.findings, ...requestFindings]);
		return details;
	}
	const cachePath = statusCachePath(root, specPath);
	const cacheResult = await readStatusCache(cachePath);
	const afterCache = aborted(request, cachePath);
	if (afterCache) return afterCache;
	const refresh = request.refresh ? await refreshStatus({ source, specPath, request, refresh: request.refresh, cwd: root }) : refreshBlocked();
	const afterRefresh = aborted(request, cachePath);
	if (afterRefresh) return afterRefresh;
	const context = cacheContext(treeCheck.snapshot.identity, graphBuild.graph, cacheResult.cache, cacheResult.findings, specPath);
	const refreshFindings: StatusFinding[] = request.refresh && refresh.status === "blocked" ? [{ code: "refresh-authority-unavailable", message: refresh.message }] : [];
	const details = deriveStatusDetails(validation.spec, specPath, treeCheck.snapshot.identity, { ...context, findings: [...graphBuild.findings, ...context.findings, ...refreshFindings] }, cachePath, refresh.status === "blocked" ? refresh : refreshBlocked());
	return { ok: true, details: { ...details, refreshed: false } };
}

export const workStatus = getWorkStatus;
