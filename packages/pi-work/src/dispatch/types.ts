import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PlanReceipt } from "../plan/index.js";
import type { StatusCacheDispatchWriteResult } from "../status/types.js";

export type DelegateRuntimeErrorCode =
	| "core-unavailable"
	| "invalid-request"
	| "unsupported-option"
	| "input-unreadable"
	| "unknown-agent"
	| "model-unavailable"
	| "invalid-confinement"
	| "not-found"
	| "control-unavailable"
	| "core-error"
	| "provenance-unavailable";

export interface DelegateRuntimeInputDigest {
	readonly kind: "task" | "read" | "checklist" | "focus";
	readonly name: string;
	readonly algorithm: "sha256";
	readonly digest: string;
}

export interface DelegateRuntimeForkReceipt {
	readonly name: string;
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
	readonly inputDigests: readonly DelegateRuntimeInputDigest[];
}

export interface DelegateRuntimeReceipt {
	readonly schema: "pi-delegate.runtime-receipt";
	readonly version: 1;
	readonly runId: string;
	readonly createdAt: string;
	readonly shape: string;
	readonly forks: readonly DelegateRuntimeForkReceipt[];
	readonly receiptPath: string;
	readonly resultPath: string;
}

/** The released direct-request subset, retained for pi-delegate without #263. */
export interface LegacyDelegateDispatchRequest {
	readonly agent: string;
	readonly task: string;
	readonly cwd: string;
	readonly reads: readonly [string];
	readonly skills?: readonly string[];
	readonly model?: string;
	readonly writableRoots?: readonly string[];
	readonly confineWrites: true;
	readonly escalation: "local";
}

/** The canonical request accepted when pi-delegate exports its normalizer. */
export interface CanonicalDelegateDispatchRequest {
	readonly runs: PlanReceipt["canonicalDelegate"]["runs"];
}

export type DelegateDispatchRequest = LegacyDelegateDispatchRequest | CanonicalDelegateDispatchRequest;
export type DelegateDispatchGrammar = "legacy" | "canonical";

export interface DelegateDispatchClient {
	dispatch(request: DelegateDispatchRequest): Promise<unknown>;
}

export type DelegateClientAvailability =
	| { readonly status: "available"; readonly grammar: DelegateDispatchGrammar; readonly client: DelegateDispatchClient }
	| { readonly status: "unavailable"; readonly message: string };

export type DelegateClientProvider = (context: ExtensionContext) => Promise<DelegateClientAvailability>;

export interface DispatchTarget {
	readonly worktreePath: string;
	readonly headCommit: string;
	readonly branch: string;
	readonly specPath: string;
	readonly cachePath: string;
}

export type DispatchFinding =
	| { readonly code: "dispatch-worktree-incompatible"; readonly message: string }
	| { readonly code: "dispatch-request-invalid"; readonly message: string }
	| { readonly code: "delegate-client-unavailable"; readonly message: string }
	| { readonly code: "delegate-runtime-error"; readonly runtimeCode?: DelegateRuntimeErrorCode; readonly message: string }
	| { readonly code: "delegate-receipt-invalid"; readonly message: string }
	| { readonly code: "delegate-receipt-mismatch"; readonly message: string }
	| { readonly code: "cache-write-contended"; readonly message: string }
	| { readonly code: "cache-write-failed"; readonly message: string };

export type DispatchCacheOutcome =
	| StatusCacheDispatchWriteResult
	| { readonly status: "skipped"; readonly reason: "receipt-not-recordable"; readonly message: string };

export interface DispatchRejected {
	readonly outcome: "rejected";
	readonly dispatchState: "not-dispatched";
	readonly plan: PlanReceipt;
	readonly findings: readonly [DispatchFinding, ...DispatchFinding[]];
}

export interface DispatchDegraded {
	readonly outcome: "degraded";
	readonly dispatchState: "not-dispatched";
	/** Paste-ready work_plan receipt. It is deliberately not a runtime receipt. */
	readonly plan: PlanReceipt;
	readonly findings: readonly [DispatchFinding, ...DispatchFinding[]];
}

export interface DispatchIndeterminate {
	readonly outcome: "indeterminate";
	readonly dispatchState: "unknown";
	readonly plan: PlanReceipt;
	readonly findings: readonly [DispatchFinding, ...DispatchFinding[]];
}

export interface DispatchSucceeded {
	readonly outcome: "dispatched";
	readonly dispatchState: "dispatched";
	readonly plan: PlanReceipt;
	readonly receipt: DelegateRuntimeReceipt;
	readonly cacheWrite: DispatchCacheOutcome;
	readonly findings: readonly DispatchFinding[];
}

export type DispatchResult = DispatchRejected | DispatchDegraded | DispatchIndeterminate | DispatchSucceeded;
