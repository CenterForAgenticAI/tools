/**
 * Pre-flight account selection.
 *
 * Reactive routing only learns an account is unusable by spending a turn on it:
 * dispatch, wait for the provider to refuse, classify, re-route, continue. Two
 * common cases are knowable *before* dispatch — a credential that cannot be
 * resolved at all, and one about to expire mid-turn — and this module turns
 * both into a selection decision instead of a failure to recover from.
 *
 * Every path degrades to today's reactive behaviour. A probe that throws, an
 * absent expiry, or no better alternative all yield "proceed as before"; none
 * is allowed to block a turn. Being unable to improve the route is not an
 * error, so a failed pre-flight is never fatal.
 *
 * No credential value is read here. The liveness probe returns only whether
 * resolution succeeded, and expiry arrives as bounded metadata.
 */

import type { AllowedFamily, MultiAccountConfig } from "./config.js";
import { isCredentialUsable } from "./credential-lifecycle.js";
import type { DiagnosticLog } from "./diagnostics.js";

/** A managed account considered for dispatch, with bounded liveness metadata. */
export interface PreflightCandidate {
	readonly providerId: string;
	readonly family: AllowedFamily;
	/** Epoch ms of credential expiry, when the credential store reports one. */
	readonly expiresAtMs?: number | undefined;
	/** Whether a refresh token exists, i.e. whether expiry is recoverable. */
	readonly hasRefreshToken: boolean;
	/** False when runtime state has this account cooling down or invalidated. */
	readonly available: boolean;
}

export type PreflightReason =
	/** The active account resolved and is not near expiry. */
	| "active-account-healthy"
	/** Credential resolution failed; the account cannot serve this turn. */
	| "active-account-unresolvable"
	/** The active credential expires within the pre-emption window. */
	| "active-account-near-expiry"
	/** The active credential is expired and cannot be refreshed. */
	| "active-account-unusable";

export interface PreflightDecision {
	/** Provider to dispatch to. Equals the active account when nothing changed. */
	readonly providerId: string;
	/** Whether selection moved away from the active account. */
	readonly switched: boolean;
	readonly reason: PreflightReason;
	/**
	 * True when the active account should be marked terminally unavailable —
	 * only for a proven resolution failure, never for a predicted expiry.
	 */
	readonly invalidateActive: boolean;
}

/** Resolves an account's credential, reporting success without exposing it. */
export type LivenessProbe = (providerId: string) => boolean | Promise<boolean>;

/**
 * Orders candidates by descending credential expiry, furthest-out first.
 *
 * With dozens of agents choosing independently from the same pool, any shared
 * deterministic preference concentrates them on one account. Preferring the
 * furthest-out expiry spreads load toward accounts with the most life left and
 * keeps agents from converging on a credential that is about to lapse. Accounts
 * with unknown expiry sort last: absent evidence of freshness, prefer an
 * account whose freshness is known.
 */
function byFurthestExpiry(
	a: PreflightCandidate,
	b: PreflightCandidate,
): number {
	// Deterministic ordering is retained intentionally; adding jitter here would
	// make routing less predictable and is deferred with the spread-selection
	// design issue rather than invented as part of preflight.
	const aExpiry = a.expiresAtMs;
	const bExpiry = b.expiresAtMs;
	if (aExpiry === undefined && bExpiry === undefined) return 0;
	if (aExpiry === undefined) return 1;
	if (bExpiry === undefined) return -1;
	return bExpiry - aExpiry;
}

/** Whether a candidate can serve a turn that starts now. */
function isEligible(
	candidate: PreflightCandidate,
	nowMs: number,
	windowMs: number,
): boolean {
	if (!candidate.available) return false;
	if (
		!isCredentialUsable(
			{
				expiresAtMs: candidate.expiresAtMs,
				hasRefreshToken: candidate.hasRefreshToken,
			},
			nowMs,
		)
	) {
		return false;
	}
	// A refreshable credential is never "too close to expiry": refresh renews it
	// transparently, so only an unrefreshable one can lapse mid-turn.
	if (candidate.hasRefreshToken) return true;
	if (candidate.expiresAtMs === undefined) return true;
	return candidate.expiresAtMs - nowMs > windowMs;
}

/**
 * Chooses which account should serve the next turn.
 *
 * The active account is kept unless it is provably unable to serve — the
 * conservative default, since switching costs continuity and every alternative
 * is only knowable through the same imperfect metadata. A switch happens only
 * when the active account fails its liveness probe, is already dead, or would
 * expire mid-turn AND a healthy same-family alternative exists.
 *
 * Cross-family substitution is never made here: families differ in models and
 * capabilities, so quietly moving a turn across them changes its meaning.
 * Reactive routing already handles that under explicit operator configuration.
 */
export async function selectPreflightAccount(options: {
	readonly activeProviderId: string;
	readonly candidates: readonly PreflightCandidate[];
	readonly config: MultiAccountConfig;
	readonly nowMs: number;
	readonly probe?: LivenessProbe | undefined;
	readonly diagnostics?: DiagnosticLog | undefined;
}): Promise<PreflightDecision> {
	const { activeProviderId, config, nowMs, probe, diagnostics } = options;
	const normalizedCandidates = options.candidates.map((candidate) => {
		if (
			candidate.expiresAtMs !== undefined &&
			!Number.isFinite(candidate.expiresAtMs)
		) {
			diagnostics?.record(
				"warning",
				"preflight.metadata",
				"Credential expiry metadata was malformed; treating freshness as unknown.",
				{ providerId: candidate.providerId, field: "expiresAtMs" },
			);
			return { ...candidate, expiresAtMs: undefined };
		}
		return candidate;
	});
	const active = normalizedCandidates.find(
		(candidate) => candidate.providerId === activeProviderId,
	);
	const unchanged = (reason: PreflightReason): PreflightDecision => ({
		providerId: activeProviderId,
		switched: false,
		reason,
		invalidateActive: false,
	});

	// An unknown active account is not ours to reason about; leave it alone.
	if (active === undefined) return unchanged("active-account-healthy");

	const resolved = await runProbe(probe, activeProviderId, diagnostics);
	const usable = isCredentialUsable(
		{
			expiresAtMs: active.expiresAtMs,
			hasRefreshToken: active.hasRefreshToken,
		},
		nowMs,
	);
	const nearExpiry =
		config.preemptiveExpiryWindowMs > 0 &&
		!isEligible(active, nowMs, config.preemptiveExpiryWindowMs);

	let reason: PreflightReason = "active-account-healthy";
	if (resolved === false) reason = "active-account-unresolvable";
	else if (!usable) reason = "active-account-unusable";
	else if (nearExpiry) reason = "active-account-near-expiry";
	if (reason === "active-account-healthy") return unchanged(reason);

	const alternative = normalizedCandidates
		.filter(
			(candidate) =>
				candidate.providerId !== activeProviderId &&
				candidate.family === active.family &&
				isEligible(candidate, nowMs, config.preemptiveExpiryWindowMs),
		)
		.sort(byFurthestExpiry)[0];

	// Only a proven resolution failure invalidates: a predicted expiry has not
	// actually failed yet, and the credential may still refresh.
	const invalidateActive = reason === "active-account-unresolvable";

	// No alternative means proceeding with the active account and letting
	// reactive routing handle any real failure — better than refusing the turn.
	if (alternative === undefined) {
		return {
			providerId: activeProviderId,
			switched: false,
			reason,
			invalidateActive,
		};
	}

	return {
		providerId: alternative.providerId,
		switched: true,
		reason,
		invalidateActive,
	};
}

/**
 * Runs the liveness probe, treating a throw as "no information".
 *
 * A probe that fails tells us nothing about the credential, only about the
 * probe. Reporting undefined keeps that distinct from a definite `false`, so a
 * broken probe cannot invalidate a healthy account (REQ-EXPIRY-FAILSAFE-1).
 */
async function runProbe(
	probe: LivenessProbe | undefined,
	providerId: string,
	diagnostics?: DiagnosticLog,
): Promise<boolean | undefined> {
	if (probe === undefined) {
		diagnostics?.record(
			"warning",
			"preflight.probe",
			"Credential liveness probe is unavailable; continuing reactively.",
			{ providerId },
		);
		return undefined;
	}
	try {
		const result = await probe(providerId);
		if (typeof result !== "boolean") {
			diagnostics?.record(
				"warning",
				"preflight.probe",
				"Credential liveness probe returned malformed metadata; continuing reactively.",
				{ providerId, field: "liveness" },
			);
			return undefined;
		}
		return result;
	} catch {
		diagnostics?.record(
			"warning",
			"preflight.probe",
			"Credential liveness probe failed; continuing reactively.",
			{ providerId },
		);
		return undefined;
	}
}
