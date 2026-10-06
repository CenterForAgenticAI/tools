import type { CostReport } from "./cost-report.js";
import {
	PUBLIC_ACCOUNT_STATUS_VERSION,
	type PublicAccountHealth,
	type PublicAccountStatusRecord,
	type PublicAccountStatusSnapshot,
	type PublicCostEstimate,
} from "./public-status.js";
import { accountHealth, type AccountStatusView } from "./status-view.js";
import type { UsageSnapshot } from "./usage.js";

/**
 * Owner-side projection for the `./public-status` contract.
 *
 * Only the extension loads this module. Consumers import the dependency-free
 * contract in `public-status.js` (typed by `public-status.d.ts`) instead.
 */

export interface PublicAccountStatusInput {
	readonly nowMs: number;
	/**
	 * Live account views. The caller must put only an operator-configured label
	 * in `label`; this projection publishes whatever it is given.
	 */
	readonly accounts: readonly AccountStatusView[];
	readonly costReport?: CostReport;
}

function publicText(value: string, maximumBytes: number): string {
	if (
		value.length === 0 ||
		Buffer.byteLength(value, "utf8") > maximumBytes ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
	) {
		throw new TypeError("Invalid public account status text.");
	}
	return value;
}

function publicTimestamp(value: number | undefined): number | null {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function publicCount(value: number | undefined): number | null {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function usageHeadroomPercent(usage: UsageSnapshot | undefined): number | null {
	if (usage === undefined) return null;
	const fractions: number[] = [];
	if (usage.utilization !== undefined && Number.isFinite(usage.utilization)) {
		fractions.push(1 - Math.min(1, Math.max(0, usage.utilization)));
	}
	if (
		usage.remainingRequests !== undefined &&
		usage.observedPeakRequests !== undefined &&
		usage.observedPeakRequests > 0
	) {
		fractions.push(usage.remainingRequests / usage.observedPeakRequests);
	}
	if (
		usage.remainingTokens !== undefined &&
		usage.observedPeakTokens !== undefined &&
		usage.observedPeakTokens > 0
	) {
		fractions.push(usage.remainingTokens / usage.observedPeakTokens);
	}
	if (fractions.length === 0) return null;
	const headroom = Math.min(...fractions);
	return Math.round(Math.min(1, Math.max(0, headroom)) * 100_000) / 1_000;
}

function recoveryAt(account: AccountStatusView): number | null {
	const candidates = [
		publicTimestamp(account.coolingUntilMs),
		publicTimestamp(account.usage?.recoveryAtMs),
		publicTimestamp(account.usageFetch?.nextAttemptAtMs),
	].filter((value): value is number => value !== null);
	return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * The month's API-equivalent estimate, or nothing. An unpriced report has no
 * estimate, and an invalid one (a non-finite or negative amount, or bad or
 * inverted period bounds) is dropped rather than thrown: a bad cost figure
 * must not turn the whole snapshot, and its account health, into a
 * `source-error`.
 */
function publicCostEstimate(
	report: CostReport | undefined,
): PublicCostEstimate | undefined {
	const current = report?.current;
	if (current?.apiEquivalent.status !== "priced") return undefined;
	const amount = current.apiEquivalent.estimatedUsd;
	const periodStart = publicTimestamp(current.periodStartMs);
	const periodEnd = publicTimestamp(current.periodEndMs);
	const observedAt = publicTimestamp(report?.generatedAtMs);
	if (
		!Number.isFinite(amount) ||
		amount < 0 ||
		periodStart === null ||
		periodEnd === null ||
		periodEnd < periodStart ||
		observedAt === null
	) {
		return undefined;
	}
	return {
		estimateId: `api-equivalent:${periodStart}:${periodEnd}`,
		accountId: null,
		classification: "estimate-not-billing",
		source: "pi-multi-account:api-equivalent-public-rates",
		currency: "USD",
		amount,
		periodStart,
		periodEnd,
		observedAt,
	};
}

/**
 * Copies the status command's live state into the narrow, renderer-independent
 * public read projection. Credential material, fingerprints, diagnostics, and
 * model-routing details have no fields in this result and cannot survive.
 *
 * The v1 consumer rejects a whole snapshot that names any family outside
 * anthropic and openai-codex, so accounts of every other family (for example
 * google-antigravity) are omitted rather than published or thrown on.
 */
export function projectPublicAccountStatus(
	input: PublicAccountStatusInput,
): PublicAccountStatusSnapshot {
	if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
		throw new TypeError(
			"Public account status observation time must be a timestamp.",
		);
	}
	const accounts: PublicAccountStatusRecord[] = [];
	for (const account of input.accounts) {
		const family = account.family;
		if (family !== "anthropic" && family !== "openai-codex") continue;
		const accountId = publicText(account.providerId, 256);
		const usage = account.usage;
		const usageFetch = account.usageFetch;
		const health: PublicAccountHealth = accountHealth(account, input.nowMs);
		accounts.push({
			accountId,
			label: publicText(account.label ?? accountId, 256),
			family,
			active: account.active,
			health,
			usageHeadroomPercent: usageHeadroomPercent(usage),
			remainingRequests: publicCount(usage?.remainingRequests),
			remainingTokens: publicCount(usage?.remainingTokens),
			recoveryAt: recoveryAt(account),
			credentialExpiresAt: publicTimestamp(account.expiresAtMs),
			fetchObservedAt: publicTimestamp(usage?.snapshotAtMs),
			fetchStale:
				usage === undefined ||
				usage.stale === true ||
				usageFetch?.disabled === true ||
				(usageFetch?.failureCount ?? 0) > 0,
			costEstimateIds: [],
		});
	}
	if (
		new Set(accounts.map((account) => account.accountId)).size !==
		accounts.length
	) {
		throw new TypeError("Duplicate public account id.");
	}

	const costEstimates: PublicCostEstimate[] = [];
	const costEstimate = publicCostEstimate(input.costReport);
	if (costEstimate !== undefined) costEstimates.push(costEstimate);

	return {
		sourceVersion: PUBLIC_ACCOUNT_STATUS_VERSION,
		observedAtMs: input.nowMs,
		accounts,
		costEstimates,
	};
}
