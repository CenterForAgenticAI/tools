import type { ManagedFamily } from "./config.js";
import type { ProviderType } from "./vendor.js";
import { formatDuration } from "./duration.js";
import type { UnsupportedModelPair } from "./model-support.js";
import { GAP_WINDOW_ID, type UsageFetchStatus } from "./usage-fetch.js";
import type { UsageQuotaProjection, UsageSnapshot } from "./usage.js";
import type { WindowSample } from "./window-history.js";
import {
	computeCostAggregate,
	getLatestWindowSamples,
	projectUsageQuota,
} from "./usage.js";

/**
 * Human-facing renderer for `/multi-account status`.
 *
 * The previous renderer emitted raw JSON, which forced an operator to read
 * `coolingUntilMs` epochs and `"usage": undefined` holes. This module owns
 * presentation only: it never reads credentials, never performs I/O, and never
 * mutates routing state.
 */

/** Display labels for the managed families, in stable display order. */
const FAMILY_LABELS: Readonly<Record<ManagedFamily, string>> = Object.freeze({
	anthropic: "Anthropic (Claude)",
	"openai-codex": "OpenAI Codex (GPT)",
	"google-antigravity": "Google Antigravity",
	openai: "OpenAI (API)",
});

const FAMILY_ORDER: readonly ManagedFamily[] = Object.freeze([
	"anthropic",
	"openai-codex",
	"google-antigravity",
	"openai",
]);

/** Human-facing labels for the live provider type of a managed account. */
const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> =
	Object.freeze({
		subscription: "subscription",
		"owning-vendor-api": "API key",
		openrouter: "OpenRouter",
	});

/** Renders a bounded provider-type suffix, or an empty string when unknown. */
function providerTypeSuffix(providerType: ProviderType | undefined): string {
	return providerType === undefined
		? ""
		: ` — ${PROVIDER_TYPE_LABELS[providerType]}`;
}

/** Fraction of a limit at or below which an account is "approaching" it. */
const LOW_HEADROOM_FRACTION = 0.15;

/** A single account's presentation-ready state. */
export interface AccountStatusView {
	readonly providerId: string;
	readonly family: ManagedFamily;
	/**
	 * How this account reaches its models, derived live from the discovered
	 * credential type. Presentation-only; never a routing input in this child.
	 */
	readonly providerType?: ProviderType;
	readonly active: boolean;
	readonly disabled: boolean;
	readonly unavailable: boolean;
	readonly coolingUntilMs?: number;
	/** Recent repeated 429s prove the provider's usage reading is not actionable. */
	readonly usageUntrusted?: boolean;
	readonly usage?: UsageSnapshot;
	/** Bounded state of detached authoritative usage fetching for this account. */
	readonly usageFetch?: UsageFetchStatus;
	/** Model id in use, shown only for the active account. */
	readonly activeModelId?: string;
	/** True when every model advertised by this account was rejected this session. */
	readonly allModelsUnsupported?: boolean;
	/** Operator-facing account label, when one is configured or derived. */
	readonly label?: string;
	/**
	 * Bounded credential expiry. Reported even for accounts idle this session,
	 * because Pi's lazy refresh means an unused credential silently ages out.
	 */
	readonly expiresAtMs?: number;
	/**
	 * Derived, non-reversible identity of the underlying account. Two slots
	 * sharing one means the operator has the same account logged in twice.
	 *
	 * Never a credential value: derived at the auth boundary and only the derived
	 * string travels. Undefined for opaque-token families, which is why an
	 * Anthropic duplicate cannot be detected this way and a Codex one can.
	 */
	readonly accountFingerprint?: string;
}

export interface StatusViewInput {
	readonly accounts: readonly AccountStatusView[];
	readonly nowMs: number;
	readonly declarationNotice?: {
		readonly condition: "stale";
		readonly remedy: string;
		readonly status: "mismatched" | "unreadable";
	};
	/** True when the caller scoped output to a single account. */
	readonly scoped?: boolean;
	/** Session-local account/model pairs that the provider reported unavailable. */
	readonly unsupportedModels?: readonly UnsupportedModelPair[];
}

/**
 * Groups slots whose derived account identity matches.
 *
 * Works on the DERIVED fingerprint the status input already carries, never on a
 * credential value. A slot with no fingerprint is never grouped, so an
 * opaque-token family yields no false positives rather than guessing.
 */
function duplicateSlotGroups(
	accounts: readonly AccountStatusView[],
): ReadonlyArray<readonly string[]> {
	const byFingerprint = new Map<string, string[]>();
	for (const account of accounts) {
		const fingerprint = account.accountFingerprint;
		if (fingerprint === undefined || fingerprint.length === 0) continue;
		const group = byFingerprint.get(fingerprint);
		if (group) group.push(account.providerId);
		else byFingerprint.set(fingerprint, [account.providerId]);
	}
	return [...byFingerprint.values()].filter((group) => group.length > 1);
}

/** Coarse health, ordered most-severe first. */
export type AccountHealth =
	| "unavailable"
	| "disabled"
	| "cooling"
	| "rate-limited"
	| "exhausted"
	| "low-headroom"
	| "ready";

function formatCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) {
		const thousands = value / 1_000;
		return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
	}
	const millions = value / 1_000_000;
	return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}M`;
}

/**
 * True when a server-reported remaining budget has fallen into the bottom
 * {@link LOW_HEADROOM_FRACTION} of the largest value observed this session.
 *
 * Providers report REMAINING counts but not the ceiling, so "approaching the
 * limit" is inferred against the peak seen for that account. This is an
 * observation-derived hint, never an authoritative quota reading.
 */
function isLowHeadroom(
	usage: UsageSnapshot | undefined,
	quota: UsageQuotaProjection,
): boolean {
	if (!usage || quota.status !== "fresh") return false;
	const { remainingRequests, remainingTokens } = quota;
	const { observedPeakRequests, observedPeakTokens } = usage;
	const lowRequests =
		remainingRequests !== undefined &&
		observedPeakRequests !== undefined &&
		observedPeakRequests > 0 &&
		remainingRequests / observedPeakRequests <= LOW_HEADROOM_FRACTION;
	const lowTokens =
		remainingTokens !== undefined &&
		observedPeakTokens !== undefined &&
		observedPeakTokens > 0 &&
		remainingTokens / observedPeakTokens <= LOW_HEADROOM_FRACTION;
	return lowRequests || lowTokens;
}

export function accountHealth(
	account: AccountStatusView,
	nowMs: number,
): AccountHealth {
	if (account.unavailable) return "unavailable";
	if (account.disabled) return "disabled";
	if (account.coolingUntilMs !== undefined && account.coolingUntilMs > nowMs) {
		return "cooling";
	}
	if (account.usageUntrusted) return "rate-limited";
	const quota = projectUsageQuota(account.usage, nowMs);
	if (
		quota.status === "fresh" &&
		(quota.remainingRequests === 0 ||
			quota.remainingTokens === 0 ||
			(quota.utilization !== undefined && quota.utilization >= 1))
	) {
		return "exhausted";
	}
	if (isLowHeadroom(account.usage, quota)) return "low-headroom";
	return "ready";
}

function healthLabel(
	health: AccountHealth,
	account: AccountStatusView,
	nowMs: number,
): string {
	switch (health) {
		case "unavailable":
			return "unavailable (re-auth needed)";
		case "disabled":
			return "disabled by operator";
		case "cooling":
			return `cooling down, ~${formatDuration((account.coolingUntilMs ?? nowMs) - nowMs)} left`;
		case "rate-limited":
			return "rate limited; recent 429s override the usage reading";
		case "exhausted":
			return "exhausted";
		case "low-headroom":
			return "ready, but approaching its limit";
		case "ready":
			return "ready";
	}
}

/**
 * Describes credential freshness. Unlike limit data this is available for every
 * account, used or not, so an idle account still reports something actionable.
 */
function credentialLine(
	account: AccountStatusView,
	nowMs: number,
): string | undefined {
	if (account.expiresAtMs === undefined) return undefined;
	const remaining = account.expiresAtMs - nowMs;
	if (remaining <= 0) return "credential EXPIRED — sign in again";
	return `credential expires in ${formatDuration(remaining)}`;
}

/**
 * Renders what the provider actually told us about remaining budget. Returns
 * undefined when nothing is known about this account's budget.
 *
 * `utilization` leads because it is the only figure that answers "can I use
 * this account" directly. Providers report what is LEFT rather than a ceiling,
 * so remaining counts appear only when no percentage is available — a bare
 * "400k tokens left" means little without the budget it came from.
 */
function limitLine(
	account: AccountStatusView,
	nowMs: number,
): string | undefined {
	const usage = projectUsageQuota(account.usage, nowMs);
	if (usage.status !== "fresh") return undefined;
	const parts: string[] = [];
	if (usage.utilization !== undefined) {
		parts.push(`${Math.round(usage.utilization * 100)}% used`);
	} else {
		if (usage.remainingRequests !== undefined) {
			parts.push(`${formatCount(usage.remainingRequests)} requests left`);
		}
		if (usage.remainingTokens !== undefined) {
			parts.push(`${formatCount(usage.remainingTokens)} tokens left`);
		}
	}
	if (
		usage.recoveryAtMs !== undefined &&
		Number.isFinite(usage.recoveryAtMs) &&
		usage.recoveryAtMs > nowMs
	) {
		parts.push(`resets in ${formatDuration(usage.recoveryAtMs - nowMs)}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Age beyond which a reading is worth flagging as possibly out of date. */
const STALE_READING_MS = 10 * 60 * 1000;

/**
 * A single caveat line, emitted ONLY when something is genuinely off.
 *
 * Routine provenance — which endpoint answered, how fresh a current reading is,
 * that fetching is working — is noise that crowds out the figure an operator
 * came to read. It earns a line only when the number should not be taken at
 * face value: stale, fetching stopped, or observed by a peer rather than here.
 */
function usageCaveatLine(
	account: AccountStatusView,
	nowMs: number,
): string | undefined {
	const fetch = account.usageFetch;
	if (fetch && !fetch.enabled) {
		return "usage fetching disabled by config — figures may be incomplete";
	}
	if (fetch?.disabled) {
		return `usage fetching stopped (${fetch.disabledReason ?? "repeated failures"}) — showing retained data`;
	}
	const usage = account.usage;
	if (!usage) return undefined;
	const quota = projectUsageQuota(usage, nowMs);
	if (quota.status === "stale") {
		return "usage observation is stale — retained quota is not used for health";
	}
	const ageMs =
		usage.observationScope === "fleet"
			? (usage.ageMs ?? 0)
			: Math.max(0, nowMs - usage.snapshotAtMs);
	if (ageMs > STALE_READING_MS) {
		return `reading is ${ageLabel(ageMs)} — may be out of date`;
	}
	if (usage.observationScope === "fleet") {
		return `observed by ${usage.observerId ?? "another agent"} (${ageLabel(ageMs)})`;
	}
	return undefined;
}

function ageLabel(ageMs: number): string {
	return `${formatDuration(ageMs)} ago`;
}

function usedLine(usage: UsageSnapshot | undefined): string | undefined {
	if (!usage) return undefined;
	const total = usage.inputTokens + usage.outputTokens;
	if (total === 0) return undefined;
	if (usage.observationScope === "fleet") {
		return `fleet-observed usage: ${formatCount(total)} tokens (${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out)`;
	}
	return `used this session: ${formatCount(total)} tokens (${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out)`;
}

/**
 * REQ-WINDOW-RENDER: Render one window as percentage remaining with reset time.
 * Shape: "5h 73% left / 2h14m"
 * REQ-NO-IDENTIFYING-DATA: windowId is included but must not be a human-identifying label.
 */
function renderWindow(sample: WindowSample, nowMs: number): string {
	const parts: string[] = [];

	// Window identifier (safe - this is a provider-supplied window ID, not user data)
	parts.push(`[${sample.windowId}]`);

	// Percentage remaining
	if (sample.remainingFraction !== undefined) {
		const percentRemaining = Math.round(sample.remainingFraction * 100);
		parts.push(`${percentRemaining}% left`);
	}

	// Reset time
	if (sample.resetAtMs !== undefined && sample.resetAtMs > nowMs) {
		parts.push(`resets in ${formatDuration(sample.resetAtMs - nowMs)}`);
	} else if (sample.resetAtMs !== undefined && sample.resetAtMs <= nowMs) {
		parts.push("reset overdue");
	}

	return parts.join(" · ");
}

/**
 * REQ-WINDOW-RENDER: Render all windows for an account, one line per window.
 * Returns undefined if no window data is available.
 */
function windowsLine(
	providerId: string,
	nowMs: number,
	latestSamples: ReadonlyMap<string, readonly WindowSample[]>,
): string | undefined {
	const accountSamples = latestSamples.get(providerId) ?? [];
	if (accountSamples.length === 0) return undefined;

	const lines: string[] = [];
	for (const sample of accountSamples) {
		const { windowId } = sample;
		// `__gap__` is an internal sentinel (usage-fetch.ts:503) marking a stretch
		// of time the fetcher could not cover. It is bookkeeping, not a provider
		// window, and rendering it verbatim put a double-underscore token in front
		// of the operator that reads like broken markup and names nothing they can
		// act on. Suppressed here rather than at the source, because the record is
		// load-bearing for coverage accounting.
		if (windowId === GAP_WINDOW_ID) continue;
		if (sample.usable) {
			lines.push(renderWindow(sample, nowMs));
		} else {
			lines.push(`[${windowId}] ${sample.unusableReason ?? "unusable"}`);
		}
	}

	return lines.length > 0 ? `windows: ${lines.join(", ")}` : undefined;
}

/**
 * REQ-COVERAGE-STATE: Render cost aggregate with coverage label.
 * REQ-COST-INCOMPLETE: NO unqualified total when coverage is not complete.
 */
function costAggregateLine(
	periodStartMs: number,
	periodEndMs: number,
): string | undefined {
	const aggregate = computeCostAggregate(periodStartMs, periodEndMs);

	const parts: string[] = [];

	// Coverage state always leads
	parts.push(`coverage: ${aggregate.coverageState}`);

	// REQ-COVERAGE-STATE: NO unqualified total unless coverage is complete
	if (aggregate.coverageState === "complete") {
		parts.push(`total: $${aggregate.completeTotal.toFixed(4)}`);
	} else {
		// Partial/unknown: show what we have with explicit qualification
		parts.push(`complete records: $${aggregate.completeTotal.toFixed(4)}`);
	}

	// REQ-COST-INCOMPLETE: surface partial and unpriced counts separately
	if (aggregate.partialCount > 0) {
		parts.push(`partial: ${aggregate.partialCount}`);
	}
	if (aggregate.unpricedCount > 0) {
		parts.push(`unpriced: ${aggregate.unpricedCount}`);
	}

	return parts.join(" · ");
}

function renderAccount(
	account: AccountStatusView,
	nowMs: number,
	indent: string,
	latestWindowSamples: ReadonlyMap<string, readonly WindowSample[]>,
): string[] {
	const health = accountHealth(account, nowMs);
	const marker =
		health === "ready" ? "•" : health === "low-headroom" ? "!" : "×";
	const named = account.label
		? `${account.providerId}  (${account.label})`
		: account.providerId;
	const typeTag =
		account.providerType === undefined
			? ""
			: ` [${PROVIDER_TYPE_LABELS[account.providerType]}]`;
	const lines = [
		`${indent}${marker} ${named}${typeTag} — ${healthLabel(health, account, nowMs)}`,
	];
	const credential = credentialLine(account, nowMs);
	if (credential) lines.push(`${indent}    ${credential}`);
	const limits = limitLine(account, nowMs);
	if (limits) lines.push(`${indent}    ${limits}`);
	const windows = windowsLine(account.providerId, nowMs, latestWindowSamples);
	if (windows) lines.push(`${indent}    ${windows}`);
	const used = usedLine(account.usage);
	if (used) lines.push(`${indent}    ${used}`);
	const caveat = usageCaveatLine(account, nowMs);
	if (caveat) lines.push(`${indent}    ${caveat}`);
	if (account.allModelsUnsupported) {
		lines.push(
			`${indent}    no advertised models available — every model was rejected this session`,
		);
	}
	if (!account.usage) {
		lines.push(`${indent}    no usage data yet for this account`);
	}
	return lines;
}

/**
 * Renders the operator-facing status report: the active account first with its
 * limit posture, then every other account grouped by family.
 */
export function renderStatus(input: StatusViewInput): string {
	const { accounts, nowMs } = input;
	const declarationBanner =
		input.declarationNotice === undefined
			? undefined
			: input.declarationNotice.status === "mismatched"
				? `Managed model declaration is stale; logical routing is using the live catalog. Run ${input.declarationNotice.remedy} to re-sync it.`
				: `LOGICAL ROUTING OFF: The managed model declaration is unreadable. Run ${input.declarationNotice.remedy}.`;
	if (accounts.length === 0) {
		const message =
			"No managed accounts are available. Run /multi-account rediscover.";
		return declarationBanner === undefined
			? message
			: `${declarationBanner}\n${message}`;
	}

	const active = accounts.find((account) => account.active);
	const others = accounts.filter((account) => !account.active);
	const sections: string[] =
		declarationBanner === undefined ? [] : [declarationBanner];

	if (active) {
		const health = accountHealth(active, nowMs);
		const header = [
			"ACTIVE ACCOUNT",
			`  ${active.providerId}  [${FAMILY_LABELS[active.family]}${providerTypeSuffix(active.providerType)}]`,
			...(active.label ? [`  account: ${active.label}`] : []),
			...(active.activeModelId ? [`  model: ${active.activeModelId}`] : []),
			`  status: ${healthLabel(health, active, nowMs)}`,
		];
		const credential = credentialLine(active, nowMs);
		if (credential) header.push(`  ${credential}`);
		const limits = limitLine(active, nowMs);
		header.push(limits ? `  limits: ${limits}` : "  limits: no usage data yet");
		const used = usedLine(active.usage);
		if (used) header.push(`  ${used}`);
		const caveat = usageCaveatLine(active, nowMs);
		if (caveat) header.push(`  ${caveat}`);
		if (active.allModelsUnsupported) {
			header.push(
				"  no advertised models available — every model was rejected this session",
			);
		}
		sections.push(header.join("\n"));
	} else {
		sections.push(
			"ACTIVE ACCOUNT\n  none — the current model is not a managed account.",
		);
	}

	if (others.length > 0) {
		const latestWindowSamples = getLatestWindowSamples();
		const ready = others.filter(
			(account) => accountHealth(account, nowMs) === "ready",
		).length;
		const grouped: string[] = [
			`OTHER ACCOUNTS (${ready} of ${others.length} ready)`,
		];
		for (const family of FAMILY_ORDER) {
			const members = others.filter((account) => account.family === family);
			if (members.length === 0) continue;
			grouped.push(`  ${FAMILY_LABELS[family]}`);
			for (const member of members) {
				grouped.push(
					...renderAccount(member, nowMs, "    ", latestWindowSamples),
				);
			}
		}
		sections.push(grouped.join("\n"));
	}

	// REQ-COVERAGE-STATE: Add cost aggregate section
	// Use last 24 hours as the period
	const periodStartMs = nowMs - 24 * 60 * 60 * 1000;
	const costLine = costAggregateLine(periodStartMs, nowMs);
	if (costLine) {
		sections.push(`COST AGGREGATE (last 24 hours)\n  ${costLine}`);
	}
	sections.push(
		"Other agents on this machine share these accounts. Figures fetched from\n" +
			"the provider include their consumption; figures derived from this\n" +
			"session's own responses do not.",
	);

	const unsupported = input.unsupportedModels ?? [];
	if (unsupported.length > 0) {
		const lines = ["UNSUPPORTED ACCOUNT/MODEL PAIRS THIS SESSION"];
		for (const pair of unsupported) {
			lines.push(`  ${pair.providerId} cannot serve ${pair.modelId}`);
		}
		sections.push(lines.join("\n"));
	}

	// Two slots backed by one account halve the capacity the operator believes
	// they have: failover routes from a rate-limited slot to its twin, which is
	// the same exhausted account, and burns a turn discovering that. Nothing
	// reported this before, so it failed silently.
	const duplicates = duplicateSlotGroups(input.accounts);
	if (duplicates.length > 0) {
		const lines = ["DUPLICATE ACCOUNTS"];
		for (const group of duplicates) {
			lines.push(`  same account: ${group.join(", ")}`);
		}
		lines.push(
			"  These slots share one account, so they share its rate limit.",
			"  Failover between them cannot help; log one in to a different account.",
		);
		sections.push(lines.join("\n"));
	}

	return sections.join("\n\n");
}
