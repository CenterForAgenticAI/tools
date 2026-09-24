import type { ManagedFamily } from "./config.js";
import type { FailureClassification } from "./error-classification.js";
import type {
  CooldownReason,
  CooldownRecord,
  NumericServerHint,
} from "./runtime-state.js";

export const ABSOLUTE_COOLDOWN_MAX_MS = 3_600_000;

export const BASE_COOLDOWN_MS: Readonly<Record<CooldownReason, number>> = {
  quota: 60_000,
  "rate-limit": 60_000,
  "auth-transient": 30_000,
  permission: 120_000,
  transport: 30_000,
  unknown: 30_000,
};

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Returns a bounded numeric-only copy suitable for process-local state. */
export function boundServerHint(
  hint: NumericServerHint | undefined,
  nowMs: number,
): NumericServerHint | undefined {
  if (hint === undefined) return undefined;
  const retryAfter = finiteNonNegative(hint.retryAfterSeconds);
  const resetAt = finiteNonNegative(hint.resetAtMs);
  if (retryAfter === undefined && resetAt === undefined) return undefined;
  return {
    ...(retryAfter === undefined
      ? {}
      : { retryAfterSeconds: Math.min(Math.floor(retryAfter), 3_600) }),
    ...(resetAt === undefined
      ? {}
      : { resetAtMs: Math.min(resetAt, nowMs + ABSOLUTE_COOLDOWN_MAX_MS) }),
  };
}

/**
 * Computes the fixed-base MVP cooldown. Retry-After may shorten the base;
 * reset-at may lengthen it. Every path is capped by both config and one hour.
 */
export function calculateCooldownDurationMs(options: {
  reason: CooldownReason;
  nowMs: number;
  configuredMaxMs: number;
  serverHint?: NumericServerHint;
}): number {
  const { reason, nowMs, configuredMaxMs } = options;
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("nowMs must be finite and non-negative.");
  }
  if (!Number.isFinite(configuredMaxMs) || configuredMaxMs < 0) {
    throw new TypeError("configuredMaxMs must be finite and non-negative.");
  }

  const maximum = Math.min(configuredMaxMs, ABSOLUTE_COOLDOWN_MAX_MS);
  const hint = boundServerHint(options.serverHint, nowMs);
  let duration = BASE_COOLDOWN_MS[reason];
  if (hint?.retryAfterSeconds !== undefined) {
    duration = Math.min(duration, hint.retryAfterSeconds * 1_000);
  }
  if (hint?.resetAtMs !== undefined) {
    duration = Math.max(duration, hint.resetAtMs - nowMs);
  }
  return Math.max(0, Math.min(Math.ceil(duration), maximum));
}

export function createCooldownRecord(options: {
  providerId: string;
  family: ManagedFamily;
  classification: FailureClassification;
  nowMs: number;
  configuredMaxMs: number;
}): CooldownRecord | undefined {
  const { classification } = options;
  if (
    classification.accountAction !== "cooldown-and-route" ||
    classification.cooldownReason === undefined
  ) {
    return undefined;
  }
  const serverHint = boundServerHint(classification.serverHint, options.nowMs);
  const durationMs = calculateCooldownDurationMs({
    reason: classification.cooldownReason,
    nowMs: options.nowMs,
    configuredMaxMs: options.configuredMaxMs,
    ...(serverHint === undefined ? {} : { serverHint }),
  });
  return {
    providerId: options.providerId,
    family: options.family,
    reason: classification.cooldownReason,
    untilMs: options.nowMs + durationMs,
    ...(serverHint === undefined ? {} : { serverHint }),
  };
}

export function remainingCooldownMs(
  record: CooldownRecord,
  nowMs: number,
): number {
  return Math.max(0, record.untilMs - nowMs);
}
