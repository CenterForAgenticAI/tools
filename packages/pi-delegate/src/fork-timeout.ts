/**
 * Workload-aware absolute timeout policy for supervised runs.
 *
 * This module owns validation and precedence. The runtime is responsible for
 * capturing the returned deadline at the first `running` transition and must
 * not recompute it on later activity updates.
 */

export const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_WIND_DOWN_GRACE_MS = 90_000;

export interface TimeoutLayer {
	maxDurationMs?: unknown;
	windDownGraceMs?: unknown;
	/** Global-only opt-in to hard-cancel caller/agent budgets after grace. */
	enforceWallClockBudget?: unknown;
	/** Global-only minimum duration; ignored on agent and invocation layers. */
	minDurationMs?: unknown;
}

export interface ResolvedRunTimeoutPolicy {
	/** Effective absolute budget. `0` means disabled when no positive ceiling applies. */
	readonly maxDurationMs: number;
	/** Grace after the one-shot wind-down steer. */
	readonly windDownGraceMs: number;
	/** Positive operator ceiling, or `0` when no global ceiling is configured. */
	readonly globalMaxDurationMs: number;
	/** Whether caller/agent budgets hard-cancel after grace. Absent on legacy policies. */
	readonly enforceWallClockBudget?: boolean;
}

/** Accept only values safe for Node's setTimeout and the public contract. */
export function normalizeTimeoutMs(value: unknown): number | undefined {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > MAX_TIMEOUT_MS
	) {
		return undefined;
	}
	return value;
}

/** Return the first timeout alias/layer that passes the canonical validator. */
export function firstValidTimeoutMs(...values: unknown[]): number | undefined {
	for (const value of values) {
		const normalized = normalizeTimeoutMs(value);
		if (normalized !== undefined) return normalized;
	}
	return undefined;
}

/**
 * Resolve one supervised run's immutable timeout policy.
 *
 * Invocation and agent values win field-wise over lower layers. The global
 * duration is additionally an absolute ceiling when positive, so a worker's
 * `0` cannot disable an operator-enforced cap. A positive global minimum raises
 * only a selected duration that was explicitly stated and is positive.
 */
export function resolveRunTimeoutPolicy(args: {
	global?: TimeoutLayer;
	agent?: TimeoutLayer;
	invocation?: TimeoutLayer;
}): ResolvedRunTimeoutPolicy {
	const globalMaxDurationMs = normalizeTimeoutMs(args.global?.maxDurationMs) ?? 0;
	const enforceWallClockBudget = args.global?.enforceWallClockBudget === true;
	const configuredGlobalMinDurationMs = normalizeTimeoutMs(args.global?.minDurationMs) ?? 0;
	// A contradictory raw layer is rejected defensively here as well as during
	// config loading. Keep the independently valid ceiling and restore the
	// compatibility default of no floor rather than silently choosing a bound.
	const globalMinDurationMs =
		globalMaxDurationMs > 0 && configuredGlobalMinDurationMs > globalMaxDurationMs
			? 0
			: configuredGlobalMinDurationMs;
	const selectedMaxDurationMs =
		firstValidTimeoutMs(
			args.invocation?.maxDurationMs,
			args.agent?.maxDurationMs,
			args.global?.maxDurationMs,
		) ?? 0;
	const ceilingAppliedDurationMs =
		globalMaxDurationMs > 0
			? selectedMaxDurationMs === 0
				? globalMaxDurationMs
				: Math.min(selectedMaxDurationMs, globalMaxDurationMs)
			: selectedMaxDurationMs;
	const maxDurationMs =
		globalMinDurationMs > 0 && selectedMaxDurationMs > 0
			? Math.max(ceilingAppliedDurationMs, globalMinDurationMs)
			: ceilingAppliedDurationMs;
	const windDownGraceMs =
		firstValidTimeoutMs(
			args.invocation?.windDownGraceMs,
			args.agent?.windDownGraceMs,
			args.global?.windDownGraceMs,
		) ?? DEFAULT_WIND_DOWN_GRACE_MS;
	return Object.freeze({ maxDurationMs, windDownGraceMs, globalMaxDurationMs, enforceWallClockBudget });
}

/** Whether wall-clock expiry hard-cancels after the wind-down grace period. */
export function isHardCancelEnabled(policy: ResolvedRunTimeoutPolicy): boolean {
	return policy.enforceWallClockBudget === true || policy.globalMaxDurationMs > 0;
}

/** Compute a deadline from a start timestamp; callers retain the first result. */
export function resolveRunTimeoutDeadline(
	policy: ResolvedRunTimeoutPolicy,
	startedAtMs: number,
): number | undefined {
	if (policy.maxDurationMs <= 0) return undefined;
	return startedAtMs + policy.maxDurationMs;
}

/**
 * Capture one run's deadline exactly once. Repeated running/activity updates
 * return the original deadline even if they carry a different start or policy.
 */
export function captureRunTimeoutDeadline(
	deadlines: Map<string, number>,
	/** Stable per-entry addressing key retained as `forkName`. */
	forkName: string,
	policy: ResolvedRunTimeoutPolicy,
	startedAtMs: number,
): number | undefined {
	const existing = deadlines.get(forkName);
	if (existing !== undefined) return existing;
	const deadline = resolveRunTimeoutDeadline(policy, startedAtMs);
	if (deadline !== undefined) deadlines.set(forkName, deadline);
	return deadline;
}


/** @deprecated Use {@link ResolvedRunTimeoutPolicy}; retained for compatibility. */
export type ResolvedForkTimeoutPolicy = ResolvedRunTimeoutPolicy;
/** @deprecated Use {@link resolveRunTimeoutPolicy}; retained for compatibility. */
export const resolveForkTimeoutPolicy = resolveRunTimeoutPolicy;
/** @deprecated Use {@link resolveRunTimeoutDeadline}; retained for compatibility. */
export const resolveForkTimeoutDeadline = resolveRunTimeoutDeadline;
/** @deprecated Use {@link captureRunTimeoutDeadline}; retained for compatibility. */
export const captureForkTimeoutDeadline = captureRunTimeoutDeadline;
