import type { Finding, FindingPath } from "../schema/findings.js";
import type { WorkNode, Workspec } from "../schema/workspec.js";
import type { NodeAddress, NodeContractAssembly, PlanReceipt } from "../plan/index.js";
import type {
	ObservedNodeVerificationRecord,
	ObservedVerificationCacheUpdate,
	ObservedVerificationResult,
	TreeIdentity,
	VerificationFailure,
} from "../verify/index.js";

export type { NodeAddress } from "../plan/index.js";
export type { TreeIdentity } from "../verify/index.js";

export type LifecycleState = "done" | "ready" | "blocked" | "needs-decision";

export type VerificationState =
	| "verified-this-session"
	| "failed-this-session"
	| "observed-green-not-verified-this-session"
	| "observed-failure-not-verified-this-session"
	| "stale-observation"
	| "conflicting-observation"
	| "unverified";

export type ReviewState =
	| "not-configured"
	| "required-not-reviewed"
	| "approved-this-session"
	| "rejected-this-session"
	| "observed-approval-not-authoritative"
	| "observed-rejection-not-authoritative";

export type StatusBlocker =
	| { readonly code: "dependency"; readonly addresses: readonly NodeAddress[] }
	| { readonly code: "children"; readonly addresses: readonly NodeAddress[] }
	| { readonly code: "completion-contract"; readonly reason: "no-execution-evidence" | "positive-floor-missing" | "checklist-incomplete" }
	| { readonly code: "open-decision"; readonly ids: readonly string[] };

/** Findings are deliberately separate from schema findings: cache data is not authored input. */
export type StatusFinding =
	| { readonly code: "invalid-status-input"; readonly message: string }
	| { readonly code: "spec-read-error"; readonly message: string; readonly path: FindingPath }
	| { readonly code: "spec-path-escape"; readonly message: string; readonly path: FindingPath }
	| { readonly code: "tree-identity-error"; readonly message: string }
	| { readonly code: "duplicate-node-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "missing-node-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "ambiguous-node-id"; readonly nodeId: string; readonly addresses: readonly NodeAddress[]; readonly message: string }
	| { readonly code: "duplicate-checklist-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "invalid-checklist-report"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "positive-floor-missing"; readonly address: NodeAddress; readonly criterionId: string; readonly message: string }
	| { readonly code: "cache-read-error"; readonly path: string; readonly message: string }
	| { readonly code: "cache-parse-error"; readonly path: string; readonly message: string }
	| { readonly code: "unsupported-cache-version"; readonly path: string; readonly version: unknown; readonly message: string }
	| { readonly code: "malformed-cache"; readonly path: string; readonly message: string }
	| { readonly code: "malformed-cache-entry"; readonly address?: NodeAddress; readonly message: string }
	| { readonly code: "cache-source-mismatch"; readonly expected: string; readonly actual: string; readonly message: string }
	| { readonly code: "cache-address-mismatch"; readonly address: NodeAddress; readonly nodeId: string; readonly message: string }
	| { readonly code: "cache-unknown-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "cache-duplicate-address"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "cache-duplicate-run-id"; readonly runId: string; readonly message: string }
	| { readonly code: "cache-dispatch-node-mismatch"; readonly address: NodeAddress; readonly nodeId: string; readonly message: string }
	| { readonly code: "cache-dispatch-target-mismatch"; readonly runId: string; readonly expected: string; readonly actual: string; readonly message: string }
	| { readonly code: "stale-cache-observation"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "cache-source-conflict"; readonly address: NodeAddress; readonly message: string }
	| { readonly code: "cache-write-error"; readonly path: string; readonly message: string }
	| { readonly code: "refresh-authority-unavailable"; readonly message: string }
	| { readonly code: "refresh-address-required"; readonly message: string }
	| { readonly code: "refresh-address-ambiguous"; readonly nodeId: string; readonly addresses: readonly NodeAddress[]; readonly message: string };

export interface StatusCacheVerificationEntry {
	readonly address: NodeAddress;
	readonly update: ObservedVerificationCacheUpdate;
}

export interface ObservedReviewRecord {
	readonly address: NodeAddress;
	readonly verdict: "approved" | "rejected";
	readonly tree: TreeIdentity;
	readonly source: string;
	readonly recordedAt: string;
}

export interface StatusCacheDispatchInputDigest {
	readonly kind: "task" | "read" | "checklist" | "focus";
	readonly name: string;
	readonly algorithm: "sha256";
	readonly digest: string;
}

/** The runtime-reported slot fields are optional where pi-delegate cannot resolve them at receipt time. */
export interface StatusCacheDispatchSlot {
	readonly agent: string;
	readonly workerCwd?: string;
	readonly branch?: string;
	readonly maxRounds: number;
	readonly cloneMode?: string;
	readonly collapseMode?: string;
	readonly confineWrites?: boolean;
	readonly readOnly?: boolean;
	readonly requestedModel?: string;
	readonly resolvedModel?: string;
	readonly skills?: readonly string[];
	readonly inputDigests: readonly StatusCacheDispatchInputDigest[];
}

export interface StatusCacheDispatchEntry {
	readonly runId: string;
	readonly forkName: string;
	readonly nodeId: string;
	readonly address: NodeAddress;
	readonly createdAt: string;
	readonly worktreePath: string;
	readonly headCommit: string;
	readonly branch: string;
	readonly briefPath: string;
	readonly briefSha256: string;
	readonly slot: StatusCacheDispatchSlot;
	readonly receiptPath: string;
	readonly resultPath: string;
}

/** Run-id-keyed history. It is an untrusted reporting hint and never lifecycle authority. */
export type StatusCacheDispatchSection = Readonly<Record<string, StatusCacheDispatchEntry>>;

export interface StatusCacheV1 {
	readonly kind: "pi-work-status-cache";
	readonly version: 1;
	readonly specPath: string;
	readonly verification: Readonly<Record<string, StatusCacheVerificationEntry>>;
	readonly review: Readonly<Record<string, ObservedReviewRecord>>;
	readonly dispatch: StatusCacheDispatchSection;
}

export type StatusCacheDispatchWriteResult =
	| { readonly status: "written"; readonly path: string; readonly attempts: number; readonly residualRace: "readback-may-precede-later-overwrite" }
	| { readonly status: "contended"; readonly path: string; readonly attempts: number; readonly residualRace: "readback-may-precede-later-overwrite"; readonly message: string }
	| { readonly status: "failed"; readonly path: string; readonly attempts: number; readonly reason: "cache-read-error" | "malformed-cache" | "cache-source-mismatch" | "run-id-conflict" | "cache-write-error"; readonly message: string };

export interface StatusCacheDecode {
	readonly cache?: StatusCacheV1;
	readonly findings: readonly StatusFinding[];
}

export type ObservationReport =
	| { readonly state: "observed-green-not-verified-this-session"; readonly update: ObservedVerificationCacheUpdate }
	| { readonly state: "observed-failure-not-verified-this-session"; readonly update: ObservedVerificationCacheUpdate }
	| { readonly state: "stale-observation"; readonly update: ObservedVerificationCacheUpdate }
	| { readonly state: "conflicting-observation"; readonly update: ObservedVerificationCacheUpdate }
	| { readonly state: "unverified" };

export interface NodeStatusReport {
	readonly address: NodeAddress;
	readonly nodeId: string;
	readonly task: string;
	readonly lifecycle: LifecycleState;
	readonly verification: VerificationState;
	readonly verificationObservation?: ObservedVerificationResult;
	readonly review: ReviewState;
	readonly reviewText: string;
	readonly dispatches: readonly StatusCacheDispatchEntry[];
	readonly blockers: readonly StatusBlocker[];
	readonly findings: readonly StatusFinding[];
	readonly lifecycleText: string;
	readonly verificationText: string;
}

export interface WorkStatusDetails {
	readonly path: string;
	readonly cachePath: string;
	readonly currentTree?: TreeIdentity;
	readonly specState: "done" | "not-done";
	readonly valid: boolean;
	readonly findings: readonly (Finding | StatusFinding | VerificationFailure)[];
	readonly nodes: readonly NodeStatusReport[];
	readonly unresolvedDecisions: readonly string[];
	readonly dispatch: StatusCacheDispatchSection;
	readonly refresh: RefreshResult;
	readonly refreshed: boolean;
	readonly truncated: boolean;
}

export interface WorkStatusResult {
	readonly ok: boolean;
	readonly details: WorkStatusDetails;
}

export interface ChecklistReportInput {
	readonly index: number;
	readonly done: boolean;
}

export interface ChecklistReportsByAddress {
	readonly nodeAddress: NodeAddress;
	readonly reports: readonly ChecklistReportInput[];
}

export interface RefreshRequest {
	readonly nodeAddresses?: readonly NodeAddress[] | undefined;
	readonly checklists?: readonly ChecklistReportsByAddress[] | undefined;
}

export interface StatusRequest {
	readonly path: string;
	readonly worktreePath: string;
	readonly expectedCommit: string;
	readonly refresh?: RefreshRequest | undefined;
	readonly signal?: AbortSignal | undefined;
}

export interface DeriveStatusInput {
	readonly source: string;
	readonly specPath: string;
	readonly tree: TreeIdentity;
	readonly cache?: unknown;
}

export interface RefreshBlocked {
	readonly status: "blocked";
	readonly ran: false;
	readonly code: "refresh-authority-unavailable";
	readonly message: string;
	readonly requires: readonly [
		"a public production-authority verification entry point",
		"a trusted current-session result bound to the selected NodeAddress and TreeIdentity",
		"a serializable Observed* cache update produced after that run",
	];
}

export type RefreshResult = RefreshBlocked;

export interface StatusGraph {
	readonly assemblies: readonly NodeContractAssembly[];
	readonly byAddress: ReadonlyMap<string, NodeContractAssembly>;
	readonly children: ReadonlyMap<string, readonly NodeAddress[]>;
	readonly dependencies: ReadonlyMap<string, readonly NodeAddress[]>;
	readonly ancestorDependencies: ReadonlyMap<string, readonly NodeAddress[]>;
}

export interface StatusGraphBuild {
	readonly graph: StatusGraph;
	readonly findings: readonly StatusFinding[];
}

export interface ValidatedStatusInput {
	readonly spec: Workspec;
	readonly source: string;
	readonly specPath: string;
	readonly tree: TreeIdentity;
}

export interface DerivedStatusContext {
	readonly graph: StatusGraph;
	readonly observations: ReadonlyMap<string, ObservationReport>;
	readonly review: ReadonlyMap<string, ReviewState>;
	readonly dispatch: StatusCacheDispatchSection;
	readonly findings: readonly StatusFinding[];
}

export type StatusNodeInput = {
	readonly node: WorkNode;
	readonly address: NodeAddress;
};

export type { Finding, FindingPath, NodeContractAssembly, PlanReceipt, WorkNode, Workspec };

export const LIFECYCLE_TEXT: Readonly<Record<LifecycleState, string>> = {
	done: "DONE — completion is derived from trusted results produced by this refresh for the current tree.",
	ready: "READY — dependencies are done; this node may start or be remediated.",
	blocked: "BLOCKED — waiting for: <qualified addresses or typed blockers>.",
	"needs-decision": "NEEDS DECISION — unresolved: <decision ids>.",
};

export const VERIFICATION_TEXT: Readonly<Record<VerificationState, string>> = {
	"verified-this-session": "Verified this session at commit <sha>; this refresh ran verification.",
	"failed-this-session": "Verification ran this session and failed at commit <sha>.",
	"observed-green-not-verified-this-session": "Last observed green at commit <sha>; not verified this session. This does not satisfy done-ness or dependencies.",
	"observed-failure-not-verified-this-session": "Last observed verification failed at commit <sha>; not verified this session.",
	"stale-observation": "Stale observation from commit <old>; current target is <current>. Not verified this session.",
	"conflicting-observation": "Cached observation conflicts with the current workspec and was ignored; not verified this session.",
	unverified: "No verification observation is available; not verified this session.",
};

export const REVIEW_TEXT: Readonly<Record<ReviewState, string>> = {
	"not-configured": "Review is not configured in this workspec.",
	"required-not-reviewed": "Review is required but has not been reviewed.",
	"approved-this-session": "Review was approved this session.",
	"rejected-this-session": "Review was rejected this session.",
	"observed-approval-not-authoritative": "An approval was observed, but it is not authoritative for this session.",
	"observed-rejection-not-authoritative": "A rejection was observed, but it is not authoritative for this session.",
};

export const REFRESH_BLOCKED_MESSAGE = "refresh is blocked: the public verification barrel does not expose a production-authority entry point that can run authored evidence, return a trusted current-session result, and safely yield serializable observed cache data.";

export function lifecycleText(state: LifecycleState, values: { readonly blockers?: string | undefined; readonly decisions?: string | undefined } = {}): string {
	return LIFECYCLE_TEXT[state]
		.replace("<qualified addresses or typed blockers>", values.blockers ?? "qualified addresses or typed blockers")
		.replace("<decision ids>", values.decisions ?? "decision ids");
}

export function verificationText(state: VerificationState, values: { readonly sha?: string | undefined; readonly old?: string | undefined; readonly current?: string | undefined } = {}): string {
	const template = VERIFICATION_TEXT[state];
	return template.replace("<sha>", values.sha ?? "unknown").replace("<old>", values.old ?? "unknown").replace("<current>", values.current ?? "unknown");
}

export function reviewText(state: ReviewState): string {
	return REVIEW_TEXT[state];
}

export function refreshBlocked(): RefreshBlocked {
	return {
		status: "blocked",
		ran: false,
		code: "refresh-authority-unavailable",
		message: REFRESH_BLOCKED_MESSAGE,
		requires: [
			"a public production-authority verification entry point",
			"a trusted current-session result bound to the selected NodeAddress and TreeIdentity",
			"a serializable Observed* cache update produced after that run",
		],
	};
}

export function isObservedGreen(observation: ObservationReport | undefined): observation is Extract<ObservationReport, { state: "observed-green-not-verified-this-session" }> {
	return observation?.state === "observed-green-not-verified-this-session";
}

export function isObservedNodePassed(value: ObservedVerificationResult | undefined): value is ObservedNodeVerificationRecord {
	return value?.outcome === "passed";
}
