import { isSafeRunId } from "./run-id.js";

/** Exact addressing identity. `forkName` is never normalized or trimmed. */
export interface ForkIdentity {
	readonly runId: string;
	readonly forkName: string;
}
export type RetryOf = ForkIdentity;
export type RetryLink = RetryOf;
export type RetriedBy = ForkIdentity;

/** Durable completed-run budget. */
export const MAX_PERSISTED_RUNS = 25;
/**
 * A retry component is admitted only when its complete run-level unit fits
 * below the ordinary completed-record budget, leaving one slot for unrelated
 * history. Retention never trims an admitted component to make it fit.
 */
export const MAX_RETRY_RETENTION_UNIT_RUNS = MAX_PERSISTED_RUNS - 1;
/** Fork-level attempts use the same explicit bound as the retry retention unit. */
export const MAX_LINEAGE_DEPTH = MAX_RETRY_RETENTION_UNIT_RUNS;
/** Fork-map keys use the same byte limit as durable persistence. */
export const MAX_PERSISTED_KEY_NAME_BYTES = 128;

export type RetryAdmissionErrorCode =
	| "malformed-reference" | "missing-predecessor" | "predecessor-not-terminal"
	| "already-replaced" | "already-linked" | "duplicate-predecessor" | "duplicate-successor"
	| "self-reference" | "cycle" | "traversal-exhausted" | "invalid-lineage" | "invalid-attempt";
export interface RetryAdmissionError { readonly code: RetryAdmissionErrorCode; readonly message: string; }
export interface RetryForkRecord {
	readonly status: string;
	readonly retryOf?: RetryOf;
	readonly retriedBy?: RetriedBy;
	readonly attempt?: number;
	/** Private durable marker set when relationship metadata was quarantined. */
	readonly retryQuarantined?: boolean;
}
export interface RetryClaim {
	readonly successorForkName: string;
	/** The actual newly-derived successor identity is mandatory at admission. */
	readonly successor: ForkIdentity;
	readonly retryOf: RetryOf;
}
export interface RetryMutation { readonly successor: ForkIdentity; readonly predecessor: ForkIdentity; readonly attempt: number; }
export interface RetryAdmissionPlan { readonly mutations: readonly RetryMutation[]; }

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
export function isValidForkIdentity(value: unknown): value is ForkIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return hasExactKeys(candidate, ["runId", "forkName"]) && isSafeRunId(candidate.runId) &&
		typeof candidate.forkName === "string" && candidate.forkName.trim().length > 0 &&
		Buffer.byteLength(candidate.forkName, "utf8") <= MAX_PERSISTED_KEY_NAME_BYTES;
}
export const isValidRetryOf = isValidForkIdentity;
export function validateForkIdentity(value: unknown): RetryAdmissionError | undefined {
	return isValidForkIdentity(value) ? undefined : { code: "malformed-reference", message: "retryOf must contain exactly a safe runId and non-blank forkName" };
}
export function effectiveAttempt(record: Pick<RetryForkRecord, "attempt"> | undefined): number { return record?.attempt === undefined ? 1 : record.attempt; }
export function identityKey(identity: ForkIdentity): string { return `${identity.runId}\u0000${identity.forkName}`; }
export function sameForkIdentity(a: ForkIdentity, b: ForkIdentity): boolean { return a.runId === b.runId && a.forkName === b.forkName; }

export interface RetryComponent {
	readonly records: readonly { identity: ForkIdentity; record: RetryForkRecord }[];
	readonly root: ForkIdentity;
	readonly frontier: ForkIdentity;
	readonly attempt: number;
}
const invalid = (code: RetryAdmissionErrorCode, message: string): { ok: false; error: RetryAdmissionError } => ({ ok: false, error: { code, message } });
/** Apply the durable ceiling while preserving intentionally lower test bounds. */
function boundedMaxDepth(maxDepth: number): number {
	return Number.isSafeInteger(maxDepth) && maxDepth >= 1 ? Math.min(maxDepth, MAX_LINEAGE_DEPTH) : MAX_LINEAGE_DEPTH;
}

/**
 * Validate the complete connected retry component containing `start`.
 * Every relationship is checked in both directions, every endpoint is present,
 * predecessor statuses are terminal failures, and attempts increase exactly by one.
 */
export function validateRetryComponent(
	lookup: RetryLookup,
	start: ForkIdentity,
	maxDepth = MAX_LINEAGE_DEPTH,
): { ok: true; component: RetryComponent } | { ok: false; error: RetryAdmissionError } {
	const depthLimit = boundedMaxDepth(maxDepth);
	if (!isValidForkIdentity(start)) return invalid("malformed-reference", "retry identity is malformed");
	for (const direction of ["retryOf", "retriedBy"] as const) {
		const seen = new Set<string>();
		let cursor: ForkIdentity | undefined = start;
		for (let depth = 0; cursor && depth <= depthLimit; depth++) {
			const key = identityKey(cursor);
			if (seen.has(key)) return invalid("cycle", "retry lineage contains a cycle");
			seen.add(key);
			const record = lookup(cursor.runId, cursor.forkName);
			if (!record) return invalid("invalid-lineage", "retry lineage points to a missing fork");
			const relation = record[direction];
			if (relation !== undefined && !isValidForkIdentity(relation)) return invalid("invalid-lineage", "retry relationship identity is malformed");
			cursor = relation;
		}
		if (cursor) return invalid("traversal-exhausted", "retry lineage exceeds the traversal bound");
	}
	const records = new Map<string, { identity: ForkIdentity; record: RetryForkRecord }>();
	const queue: ForkIdentity[] = [start];
	let edges = 0;
	while (queue.length) {
		const identity = queue.pop()!;
		const key = identityKey(identity);
		if (records.has(key)) continue;
		if (++edges > depthLimit + 1) return invalid("traversal-exhausted", "retry lineage exceeds the traversal bound");
		const record = lookup(identity.runId, identity.forkName);
		if (!record) return invalid("invalid-lineage", "retry lineage points to a missing fork");
		if (record.retryQuarantined) return invalid("invalid-lineage", "retry lineage is quarantined");
		const attempt = effectiveAttempt(record);
		if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > depthLimit) return invalid("invalid-attempt", "retry attempt is outside the safe bound");
		records.set(key, { identity, record });
		for (const relation of [record.retryOf, record.retriedBy]) {
			if (relation !== undefined && !isValidForkIdentity(relation)) return invalid("invalid-lineage", "retry relationship identity is malformed");
			if (relation) queue.push(relation);
		}
	}
	for (const { identity, record } of records.values()) {
		const attempt = effectiveAttempt(record);
		if (record.retryOf) {
			const predecessor = lookup(record.retryOf.runId, record.retryOf.forkName);
			if (!predecessor || predecessor.retryQuarantined) return invalid("invalid-lineage", "retry predecessor is missing or quarantined");
			if (!predecessor.retriedBy || !sameForkIdentity(predecessor.retriedBy, identity)) return invalid("invalid-lineage", "retry relationship is not bilateral");
			if (predecessor.status !== "failed" && predecessor.status !== "aborted") return invalid("predecessor-not-terminal", "only failed or aborted forks may be retry predecessors");
			if (attempt !== effectiveAttempt(predecessor) + 1) return invalid("invalid-attempt", "retry attempt is inconsistent with lineage");
		} else if (attempt !== 1) return invalid("invalid-attempt", "retry root must have attempt 1");
		if (record.retriedBy) {
			const successor = lookup(record.retriedBy.runId, record.retriedBy.forkName);
			if (!successor || successor.retryQuarantined) return invalid("invalid-lineage", "retry successor is missing or quarantined");
			if (!successor.retryOf || !sameForkIdentity(successor.retryOf, identity)) return invalid("invalid-lineage", "retry relationship is not bilateral");
			if (record.status !== "failed" && record.status !== "aborted") return invalid("predecessor-not-terminal", "only failed or aborted forks may have retry successors");
			if (effectiveAttempt(successor) !== attempt + 1) return invalid("invalid-attempt", "retry attempt is inconsistent with lineage");
		}
	}
	let root = records.get(identityKey(start))!;
	const seen = new Set<string>();
	while (root.record.retryOf) {
		const key = identityKey(root.record.retryOf);
		if (seen.has(key)) return invalid("cycle", "retry lineage contains a cycle");
		seen.add(key);
		const next = records.get(key);
		if (!next) return invalid("invalid-lineage", "retry lineage points to a missing fork");
		root = next;
	}
	let frontier = records.get(identityKey(start))!;
	seen.clear();
	while (frontier.record.retriedBy) {
		const key = identityKey(frontier.record.retriedBy);
		if (seen.has(key)) return invalid("cycle", "retry lineage contains a cycle");
		seen.add(key);
		const next = records.get(key);
		if (!next) return invalid("invalid-lineage", "retry lineage points to a missing fork");
		frontier = next;
	}
	return { ok: true, component: { records: [...records.values()], root: root.identity, frontier: frontier.identity, attempt: effectiveAttempt(frontier.record) } };
}

export interface RetryLookup { (runId: string, forkName: string): RetryForkRecord | undefined; }
export function deriveAttempt(lookup: RetryLookup, predecessor: ForkIdentity, maxDepth = MAX_LINEAGE_DEPTH): { ok: true; attempt: number } | { ok: false; error: RetryAdmissionError } {
	const depthLimit = boundedMaxDepth(maxDepth);
	const result = validateRetryComponent(lookup, predecessor, depthLimit);
	if (result.ok === false) return result;
	if (result.component.frontier.runId !== predecessor.runId || result.component.frontier.forkName !== predecessor.forkName) {
		return invalid("already-replaced", "retry predecessor already has a successor");
	}
	return result.component.attempt >= depthLimit ? invalid("invalid-attempt", "retry attempt is outside the safe bound") : { ok: true, attempt: result.component.attempt + 1 };
}
export function resolveFrontier(lookup: RetryLookup, start: ForkIdentity, maxDepth = MAX_LINEAGE_DEPTH): { identity: ForkIdentity; complete: boolean } {
	const result = validateRetryComponent(lookup, start, maxDepth);
	return result.ok ? { identity: result.component.frontier, complete: true } : { identity: start, complete: false };
}

/** Validate all claims against the existing graph before returning mutations. */
export function validateRetryClaims(lookup: RetryLookup, claims: readonly RetryClaim[], maxDepth = MAX_LINEAGE_DEPTH): { ok: true; plan: RetryAdmissionPlan } | { ok: false; error: RetryAdmissionError } {
	const seenSuccessors = new Set<string>();
	const seenPredecessors = new Set<string>();
	const mutations: RetryMutation[] = [];
	for (const claim of claims) {
		if (typeof claim !== "object" || claim === null || !hasExactKeys(claim as unknown as Record<string, unknown>, ["successorForkName", "successor", "retryOf"]) ||
			typeof claim.successorForkName !== "string" || claim.successorForkName.trim().length === 0 || !isValidForkIdentity(claim.retryOf) ||
			!isValidForkIdentity(claim.successor) || claim.successor.forkName !== claim.successorForkName) {
			return invalid("malformed-reference", "retry declaration is malformed");
		}
		const predecessor = claim.retryOf;
		const successor = claim.successor;
		const pk = identityKey(predecessor), sk = identityKey(successor);
		if (sameForkIdentity(predecessor, successor)) return invalid("self-reference", "a fork cannot retry itself");
		if (seenPredecessors.has(pk)) return invalid("duplicate-predecessor", "a predecessor occurs more than once");
		if (seenSuccessors.has(sk)) return invalid("duplicate-successor", "a successor identity occurs more than once");
		if (seenSuccessors.has(pk)) return invalid("cycle", "retry declaration would create a cycle");
		seenPredecessors.add(pk); seenSuccessors.add(sk);
		const pred = lookup(predecessor.runId, predecessor.forkName);
		if (!pred) return invalid("missing-predecessor", "retry predecessor was not found");
		if (pred.retryQuarantined) return invalid("invalid-lineage", "retry predecessor is quarantined");
		if (pred.status !== "failed" && pred.status !== "aborted") return invalid("predecessor-not-terminal", "only failed or aborted forks may be retried");
		if (pred.retriedBy) return invalid("already-replaced", "retry predecessor already has a successor");
		const existingSuccessor = lookup(successor.runId, successor.forkName);
		if (existingSuccessor?.retryQuarantined) return invalid("invalid-lineage", "retry successor is quarantined");
		if (existingSuccessor) return invalid("already-linked", "successor identity already exists");
		const attempt = deriveAttempt(lookup, predecessor, maxDepth);
		if (attempt.ok === false) return attempt;
		mutations.push({ successor, predecessor, attempt: attempt.attempt });
	}
	return { ok: true, plan: { mutations } };
}
export function isValidBilateralRetry(lookup: RetryLookup, identity: ForkIdentity, maxDepth = MAX_LINEAGE_DEPTH): boolean {
	return validateRetryComponent(lookup, identity, maxDepth).ok;
}
