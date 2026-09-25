import type { FindingPath } from "../schema/findings.js";
import type { AcceptanceCriterion, Evidence, Ref, WorkNode, Workspec, Worker } from "../schema/workspec.js";
import type { TouchOverlap } from "../lint/touches-overlap.js";

export type NodeAddress = readonly string[];

export interface ParentContext {
	readonly address: NodeAddress;
	readonly path: FindingPath;
	readonly id: string;
	readonly task: string;
	readonly description?: string;
}

export interface NodeContractAssembly {
	readonly spec: Pick<Workspec, "title" | "description" | "intent">;
	readonly node: WorkNode;
	readonly address: NodeAddress;
	readonly path: FindingPath;
	readonly parents: readonly ParentContext[];
}

export interface ReportedEvidence {
	readonly criterionId: string;
	readonly verbatim: string;
}

export interface FileCitation {
	readonly path: string;
	readonly line: number;
	readonly endLine?: number;
}

export interface ReviewerConcern {
	readonly criterionId: string;
	readonly concern: string;
	readonly citations: readonly [FileCitation, ...FileCitation[]];
}

export interface RemediationData {
	readonly failedCriterionIds: readonly [string, ...string[]];
	readonly concerns: readonly ReviewerConcern[];
	readonly priorEvidenceResults: readonly ReportedEvidence[];
}

export type ProjectionInput =
	| { readonly kind: "worker" }
	| { readonly kind: "review"; readonly workerReportedEvidence: readonly ReportedEvidence[] }
	| { readonly kind: "remediation"; readonly remediation: RemediationData };

export type ProjectionKind = ProjectionInput["kind"];
export type NodeFieldRenderer = (assembly: NodeContractAssembly) => string;

export interface DelegateInvocation {
	readonly agent: string;
	readonly skills?: readonly string[];
	readonly model?: string;
	readonly cwd?: string;
	readonly reads: readonly [string];
	readonly task: string;
	readonly writableRoots?: readonly string[];
	readonly confineWrites: true;
	readonly escalation: "local";
	readonly worktree: boolean;
}

/**
 * Durable seeding that survives the worker's own compaction. This is not a
 * replacement for the prose path: spec intent and touches still reach the worker
 * as brief sections, which a first message cannot make survive a compaction.
 */
export interface DelegateFocus {
	/** Non-empty, <= 1000 characters, per pi-delegate's published contract. */
	readonly objective: string;
	/** <= 50 entries, each <= 512 characters. Omitted when the node declares none. */
	readonly boundaries?: readonly string[];
}

export interface DelegateHandoff {
	/**
	 * Omitted when the node declares no checklist. pi-delegate rejects an empty
	 * list rather than accepting one that would seed nothing.
	 */
	readonly tasks?: readonly string[];
	readonly focus?: DelegateFocus;
}

export interface CanonicalDelegateRun {
	readonly name: string;
	readonly agent: string;
	readonly task: string;
	readonly mode: "solo";
	readonly skills?: readonly string[];
	readonly model?: string;
	readonly cwd?: string;
	readonly reads: readonly [string];
	readonly writableRoots?: readonly string[];
	readonly confineWrites: true;
	readonly escalation: "local";
	readonly worktree: boolean;
	readonly handoff?: DelegateHandoff;
}

export interface CanonicalDelegateInvocation {
	readonly runs: readonly [CanonicalDelegateRun];
}

export interface PlanReceipt {
	readonly nodeId: string;
	readonly nodeAddress: NodeAddress;
	readonly schemaPath: FindingPath;
	readonly briefPath: string;
	readonly briefSha256: string;
	/** SHA-256 of JSON.stringify(handoff.tasks), when the node declares tasks. */
	readonly handoffSha256?: string;
	/**
	 * SHA-256 of JSON.stringify(handoff.focus), when the node declares focus.
	 * Digested per namespace over these exact bytes, never over the {tasks, focus}
	 * pair: the runtime hashes each namespace alone, and ADR-0019 requires the
	 * verifier to recompute this independently.
	 */
	readonly focusSha256?: string;
	/** The released pi-delegate invocation, retained without shape changes. */
	readonly delegate: DelegateInvocation;
	/** The pi-delegate#263 canonical invocation. */
	readonly canonicalDelegate: CanonicalDelegateInvocation;
}

export interface PlanAdvisory {
	readonly kind: "touch-overlap";
	readonly overlaps: readonly TouchOverlap[];
}

export type PlanFinding =
	| { readonly code: "invalid-spec"; readonly message: string }
	| { readonly code: "invalid-remediation"; readonly path: FindingPath; readonly message: string }
	| { readonly code: "node-address-required"; readonly path: FindingPath; readonly message: string }
	| { readonly code: "node-address-not-found"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "duplicate-node-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "worker-profile-unsupported"; readonly path: FindingPath; readonly profile: string; readonly message: string }
	| { readonly code: "brief-write-error"; readonly path: FindingPath; readonly message: string };

export interface PlanSuccess {
	readonly ok: true;
	readonly plans: readonly PlanReceipt[];
	readonly advisories: readonly PlanAdvisory[];
	readonly worktree: boolean;
}

export interface PlanFailure {
	readonly ok: false;
	readonly plans: readonly [];
	readonly advisories: readonly [];
	readonly worktree: false;
	readonly findings: readonly PlanFinding[];
}

export type PlanResult = PlanSuccess | PlanFailure;

export interface CompilePlanOptions {
	readonly cwd: string;
	readonly nodeAddresses: readonly NodeAddress[];
	readonly briefDirectory?: string;
}

export interface RenderProjectorOverrides {
	readonly [field: string]: Partial<Record<ProjectionKind, NodeFieldRenderer>>;
}

export type { AcceptanceCriterion, Evidence, Ref, Worker, WorkNode, Workspec };
