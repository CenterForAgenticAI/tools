import type {
	AllowedFamily,
	ManagedFamily,
	MultiAccountConfig,
} from "./config.js";
import { isAllowedFamily, isManagedFamily } from "./config.js";
import { createCooldownRecord } from "./cooldowns.js";
import {
	isCredentialUsable,
	type CredentialUsability,
} from "./credential-lifecycle.js";
import type { CredentialType } from "./discovery.js";
import {
	classifyFailure,
	type FailureClassification,
	type ProviderFailureSignal,
} from "./error-classification.js";
import type { ModelSupportRegistry } from "./model-support.js";
import { resolveTierModel } from "./tier-model-resolver.js";
import { providerTypeFor, sameVendor } from "./vendor.js";
import {
	type RuntimeState,
	isCanonicalManagedProviderId,
	type CredentialRevision,
} from "./runtime-state.js";

export interface SharedUsageHint {
	readonly remainingRequests?: number;
	readonly remainingTokens?: number;
	readonly recoveryAtMs?: number;
	/**
	 * End of a bounded local hold installed after the provider reported
	 * exhaustion without a recovery time. Distinct from `recoveryAtMs`, which is
	 * the provider's own word: this is an admitted guess, and exclusion runs to
	 * whichever of the two is later.
	 */
	readonly holdUntilMs?: number;
	readonly utilization?: number;
	readonly ageMs?: number;
}

export interface ManagedAccount<F extends ManagedFamily = ManagedFamily> {
	readonly providerId: string;
	readonly family: F;
	readonly credentialType?: CredentialType;
	/**
	 * The observation routing acts on, supplied by the caller.
	 *
	 * Named for the peer-only reading it once carried. It now also carries this
	 * session's own observation, and a known future recovery time regardless of
	 * age, because excluding both is what let routing spend turns on an account
	 * it had already measured as exhausted (#97). Stale token data is still
	 * omitted before routing reaches here.
	 */
	readonly fleetUsage?: SharedUsageHint;
	/** Optional revision from maintained public, non-secret metadata only. */
	readonly credentialRevision?: CredentialRevision;
	/**
	 * Bounded, value-free credential usability metadata. When supplied, an
	 * account whose credential is provably dead (expired with no refresh token)
	 * is excluded from selection. Omitted means "unknown", which keeps the
	 * account eligible.
	 */
	readonly credential?: CredentialUsability;
	/**
	 * Stable account fingerprint derived from non-secret claims, when derivable.
	 * Lets routing state survive token rotation and clear only on a genuine
	 * account substitution.
	 */
	readonly accountFingerprint?: string;
	/** Model ids advertised by this account's provider catalog, when known. */
	readonly modelIds?: readonly string[];
}

export type SubscriptionManagedAccount = ManagedAccount<AllowedFamily>;

export type AvailableRouteCandidate =
	| {
			readonly destination: SubscriptionManagedAccount;
			readonly routeKind: "same-family" | "cross-family";
	  }
	| {
			readonly destination: ManagedAccount;
			readonly routeKind: "owning-vendor-api";
			readonly resolvedModelId: string;
	  };

export type SelectedRoute = AvailableRouteCandidate & {
	readonly status: "selected";
	readonly classification: FailureClassification;
};

export interface PausedRoute {
	readonly status: "paused";
	readonly classification: FailureClassification;
	/** Null means every known alternative is unavailable without a timed recovery. */
	readonly earliestRecoveryAtMs: number | null;
	readonly retryAfterMs: number | null;
}

export type ReactiveRouteDecision = SelectedRoute | PausedRoute;

export interface HealthSelectionDecision {
	readonly providerId: string;
	readonly switched: boolean;
	readonly reason:
		| "active-account-healthy"
		| "active-account-unsupported"
		| "active-account-not-live"
		| "active-account-exhausted";
}

function accountCanServeModel(
	account: ManagedAccount,
	modelId: string | undefined,
	modelSupport: ModelSupportRegistry | undefined,
): boolean {
	if (
		modelId !== undefined &&
		modelSupport !== undefined &&
		modelSupport.isUnsupported(account.providerId, modelId)
	) {
		return false;
	}
	if (
		modelId !== undefined &&
		account.modelIds !== undefined &&
		!account.modelIds.includes(modelId)
	) {
		return false;
	}
	return true;
}

function isSubscriptionManagedAccount(
	account: ManagedAccount,
): account is SubscriptionManagedAccount {
	return (
		isAllowedFamily(account.family) &&
		providerTypeFor(account.family, account.credentialType ?? "unknown") ===
			"subscription"
	);
}

type OwningVendorManagedAccount = ManagedAccount<"anthropic" | "openai">;

function isOwningVendorApiAccount(
	account: ManagedAccount,
): account is OwningVendorManagedAccount {
	return (
		account.family !== "openai-codex" &&
		providerTypeFor(account.family, account.credentialType ?? "unknown") ===
			"owning-vendor-api"
	);
}

function prioritizeModelServingAccounts<T extends ManagedAccount>(
	accounts: readonly T[],
	modelId: string | undefined,
	modelSupport: ModelSupportRegistry | undefined,
): readonly T[] {
	if (modelId === undefined) return accounts;
	const serving: T[] = [];
	const fallback: T[] = [];
	for (const account of accounts) {
		(accountCanServeModel(account, modelId, modelSupport)
			? serving
			: fallback
		).push(account);
	}
	return [...serving, ...fallback];
}

/**
 * The exhaustion signals both selection paths must respect.
 *
 * Extracted because the two guards had drifted: the reactive path checked usage
 * distrust and fleet exhaustion, the proactive one did not, so preflight could
 * hand a turn to an account that `routeAfterFailure` would have refused -- an
 * account at utilization 1 with a known future recovery was ineligible AFTER a
 * failure and eligible BEFORE one. The turn was spent, failed, and only then
 * routed correctly, which is the wasted round-trip preflight exists to prevent.
 *
 * One predicate rather than two matching lists: two definitions that must agree
 * is exactly how they drifted, and is the same defect class already fixed twice
 * in the usage snapshot path (048a276, 75755c2).
 *
 * ORDER IS LOAD-BEARING. `isUsageSnapshotUntrusted` runs BEFORE the snapshot is
 * read, because the snapshot is the thing being disbelieved. Observed live on
 * 2026-08-05: base `anthropic` reported `utilization: 0` from the usage endpoint
 * while returning 429 on every request, because that endpoint tracks the QUOTA
 * window and cannot see a SESSION limit. Reversing these two lines restores that
 * bug.
 */
type ExhaustionSignalScope = "all-observed" | "provider-reported-only";

export function snapshotIndicatesExhaustion(
	fleet: SharedUsageHint | undefined,
	nowMs: number,
	scope: ExhaustionSignalScope,
): boolean {
	return (
		fleet?.remainingRequests === 0 ||
		fleet?.remainingTokens === 0 ||
		(scope === "all-observed" &&
			fleet?.utilization !== undefined &&
			fleet.utilization >= 1) ||
		// Exclusion runs to the later of the provider's own recovery time and a
		// local hold: max(holdUntilMs, recoveryAtMs). Each is checked against now
		// independently, which is that maximum without computing it. A healthy
		// reading clears neither, and an authoritative recovery *earlier* than
		// the hold does not shorten it -- the hold exists precisely for the case
		// where the endpoint's view disagrees with what requests actually do.
		(fleet?.recoveryAtMs !== undefined && fleet.recoveryAtMs > nowMs) ||
		(fleet?.holdUntilMs !== undefined && fleet.holdUntilMs > nowMs)
	);
}

function accountExhausted(
	account: ManagedAccount,
	state: RuntimeState,
	nowMs: number,
	scope: ExhaustionSignalScope = "all-observed",
): boolean {
	if (state.isUsageSnapshotUntrusted(account.providerId, nowMs)) return true;
	return snapshotIndicatesExhaustion(account.fleetUsage, nowMs, scope);
}

/**
 * Eligibility for PROACTIVE pre-dispatch selection.
 *
 * Tightening this cannot park a turn: when no alternative qualifies, the caller
 * falls through to `active-account-healthy` and stays put, which is the previous
 * behaviour. Only `routeAfterFailure` can park.
 */
function accountAvailableForSelection(
	account: ManagedAccount,
	state: RuntimeState,
	nowMs: number,
): boolean {
	return (
		isCredentialUsable(
			account.credential ?? { hasRefreshToken: false },
			nowMs,
		) &&
		!accountExhausted(account, state, nowMs) &&
		state.getInvalidation(account.providerId) === undefined &&
		state.getCooldown(account.providerId, nowMs) === undefined
	);
}

/**
 * Selects a same-family account only when a concrete health/catalog signal
 * justifies changing the deterministic active choice. Unknown signals leave
 * provider order untouched.
 */
export function selectHealthAwareAccount(options: {
	readonly activeProviderId: string;
	readonly modelId?: string;
	readonly accounts: readonly SubscriptionManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly modelSupport?: ModelSupportRegistry;
	readonly liveProviders?: ReadonlyMap<string, boolean | undefined>;
}): HealthSelectionDecision {
	const {
		activeProviderId,
		modelId,
		accounts,
		state,
		nowMs,
		modelSupport,
		liveProviders,
	} = options;
	const active = accounts.find(
		(account) => account.providerId === activeProviderId,
	);
	if (active === undefined) {
		return {
			providerId: activeProviderId,
			switched: false,
			reason: "active-account-healthy",
		};
	}
	const activeSupports = accountCanServeModel(active, modelId, modelSupport);
	const activeLive = liveProviders?.get(activeProviderId);
	const hasCatalogSignal = modelSupport !== undefined && modelId !== undefined;
	const hasLiveSignal =
		liveProviders !== undefined &&
		[...liveProviders.values()].some((value) => value !== undefined);
	const activeExhausted = accountExhausted(
		active,
		state,
		nowMs,
		// Reversible decision: active pre-dispatch selection excludes utilization-only
		// exhaustion because a false positive can strand a working turn, which is worse
		// than the wasted turn this change prevents. Authoritative provenance or provider
		// evidence proving utilization cannot be a local optimistic estimate would
		// justify including it later.
		"provider-reported-only",
	);
	const alternative = accounts.find(
		(account) =>
			account.providerId !== activeProviderId &&
			account.family === active.family &&
			accountCanServeModel(account, modelId, modelSupport) &&
			accountAvailableForSelection(account, state, nowMs) &&
			(liveProviders?.get(account.providerId) === true || !hasLiveSignal),
	);
	if (activeSupports && activeLive !== false) {
		if (!hasLiveSignal && !activeExhausted) {
			return {
				providerId: activeProviderId,
				switched: false,
				reason: "active-account-healthy",
			};
		}
		if (
			alternative === undefined ||
			(!activeExhausted && activeLive !== undefined)
		) {
			return {
				providerId: activeProviderId,
				switched: false,
				reason: "active-account-healthy",
			};
		}
		return {
			providerId: alternative.providerId,
			switched: true,
			reason:
				activeExhausted && (activeLive !== undefined || !hasLiveSignal)
					? "active-account-exhausted"
					: "active-account-not-live",
		};
	}

	if (alternative === undefined || (!activeExhausted && !hasCatalogSignal && !hasLiveSignal)) {
		return {
			providerId: activeProviderId,
			switched: false,
			reason: "active-account-healthy",
		};
	}
	return {
		providerId: alternative.providerId,
		switched: true,
		reason: activeSupports
			? "active-account-not-live"
			: "active-account-unsupported",
	};
}

function isCanonicalProviderId(account: ManagedAccount): boolean {
	return (
		isManagedFamily(account.family) &&
		isCanonicalManagedProviderId(account.providerId, account.family)
	);
}

function firstCanonicalAccount(
	account: ManagedAccount,
	seen: Set<string>,
): ManagedAccount | undefined {
	if (!isCanonicalProviderId(account) || seen.has(account.providerId)) return undefined;
	seen.add(account.providerId);
	return account;
}

/**
 * Canonicalizes and dedupes accounts into the routing projection WITHOUT
 * touching RuntimeState. This is the pure half of {@link normalizedAccounts}:
 * it is the only projection safe to run inside a reversible cooldown mutation,
 * because {@link RuntimeState.runReversibleCooldownMutation} can restore only
 * cooldown records. Observing identity or credential revision here would mutate
 * `#accountIdentities`, `#credentialRevisions`, terminal invalidations, and even
 * unrelated cooldowns, none of which the rollback can undo.
 */
function projectCanonicalAccounts(
	accounts: readonly ManagedAccount[],
): readonly ManagedAccount[] {
	const seen = new Set<string>();
	const result: ManagedAccount[] = [];
	for (const account of accounts) {
		if (firstCanonicalAccount(account, seen) === undefined) continue;
		result.push({
			providerId: account.providerId,
			family: account.family,
			...(account.credentialType === undefined
				? {}
				: { credentialType: account.credentialType }),
			...(account.fleetUsage === undefined
				? {}
				: { fleetUsage: account.fleetUsage }),
			...(account.credentialRevision === undefined
				? {}
				: { credentialRevision: account.credentialRevision }),
			...(account.credential === undefined
				? {}
				: { credential: account.credential }),
			...(account.accountFingerprint === undefined
				? {}
				: { accountFingerprint: account.accountFingerprint }),
			...(account.modelIds === undefined ? {} : { modelIds: account.modelIds }),
		});
	}
	return result;
}

function normalizedAccounts(
	accounts: readonly ManagedAccount[],
	state: RuntimeState,
): readonly ManagedAccount[] {
	const projected = projectCanonicalAccounts(accounts);
	for (const account of projected) {
		if (account.credentialRevision !== undefined) {
			state.observeCredentialRevision(
				account.providerId,
				account.family,
				account.credentialRevision,
			);
		}
		// Observed unconditionally: an absent fingerprint is meaningful (identity
		// is not derivable) and must not be mistaken for an account change.
		state.observeAccountIdentity(
			account.providerId,
			account.family,
			account.accountFingerprint,
		);
	}
	return projected;
}

/**
 * Whether an account may receive a request now.
 *
 * Beyond the runtime signals (terminal invalidation, active cooldown), an
 * account whose credential is provably dead is excluded outright: dispatching
 * to it can only fail, wasting a turn and risking failure heuristics against an
 * account that merely needs a login. An account that is near expiry but still
 * refreshable stays eligible — refresh is the normal path.
 */
function isAvailable(
	account: ManagedAccount,
	state: RuntimeState,
	nowMs: number,
): boolean {
	// REQ-FAILOVER-USAGE-TRUST plus fleet exhaustion, shared with the proactive
	// path so the two cannot disagree about what "exhausted" means.
	return accountAvailableWithStateReaders(
		account,
		state,
		nowMs,
		state.getCooldown.bind(state),
		state.isUsageSnapshotUntrusted.bind(state),
	);
}

/**
 * Finds any managed OAuth account that can receive a request now.
 *
 * This deliberately ignores family-chain policy: callers use it only to prove
 * that a metered provider is NOT the last resort, or to leave that metered
 * bridge once any subscription account recovers. It never selects OpenRouter
 * because canonical managed-provider validation excludes it.
 */
export function selectAvailableManagedAccount(options: {
	readonly accounts: readonly ManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly preferredProviderId?: string;
}): ManagedAccount | undefined {
	const seen = new Set<string>();
	const available = options.accounts.filter((account) => {
		if (firstCanonicalAccount(account, seen) === undefined) return false;
		return isAvailable(account, options.state, options.nowMs);
	});
	return (
		available.find(
			(account) => account.providerId === options.preferredProviderId,
		) ?? available[0]
	);
}

/**
 * Finds a recovered account without mutating failure state and without widening
 * the route beyond the family policy that parked the turn. Same-family recovery
 * keeps its configured priority; cross-family recovery is considered only for
 * an explicitly declared directional chain.
 */
export function selectAvailableRecoveryAccount(options: {
	readonly accounts: readonly ManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly originFamily: AllowedFamily;
	readonly requestedModelId?: string;
	readonly config: MultiAccountConfig;
	readonly preferredProviderId?: string;
	readonly modelId?: string;
	readonly preferredModelId?: string;
	readonly modelSupport?: ModelSupportRegistry;
}): AvailableRouteCandidate | undefined {
	const candidates = selectAvailableRouteCandidates(options);
	return (
		candidates.find(
			(candidate) =>
				candidate.destination.providerId === options.preferredProviderId,
		) ?? candidates[0]
	);
}

/**
 * Returns every account that may receive a reactive continuation, in routing
 * priority order, without mutating failure state.
 *
 * Selection rejection uses this same policy after the first destination fails
 * host selection. Scanning the raw catalog there can retry the account that
 * just failed, choose an exhausted account, or cross families without an
 * explicit directional chain.
 */
export function selectAvailableRouteCandidates(options: {
	readonly accounts: readonly ManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly originFamily: AllowedFamily;
	readonly requestedModelId?: string;
	readonly config: MultiAccountConfig;
	readonly failedProviderId?: string;
	readonly excludedProviderIds?: ReadonlySet<string>;
	/** Hard same-family constraint after account-local model-not-found evidence. */
	readonly modelId?: string;
	/** Soft same-family preference for preserving the failed turn's model. */
	readonly preferredModelId?: string;
	readonly modelSupport?: ModelSupportRegistry;
}): readonly AvailableRouteCandidate[] {
	const seen = new Set<string>();
	const available = options.accounts.filter((account) => {
		if (firstCanonicalAccount(account, seen) === undefined) return false;
		return (
			account.providerId !== options.failedProviderId &&
			!options.excludedProviderIds?.has(account.providerId) &&
			isAvailable(account, options.state, options.nowMs)
		);
	});
	const subscriptions = available.filter(isSubscriptionManagedAccount);
	const sameFamily = options.config.sameFamilyFailover
		? subscriptions.filter((account) => account.family === options.originFamily)
		: [];
	const eligibleSameFamily =
		options.modelId === undefined
			? sameFamily
			: sameFamily.filter((account) =>
					accountCanServeModel(
						account,
						options.modelId,
						options.modelSupport,
					),
				);
	const tier1 = prioritizeModelServingAccounts(
		eligibleSameFamily,
		options.preferredModelId,
		options.modelSupport,
	).map(
		(destination): AvailableRouteCandidate => ({
			destination,
			routeKind: "same-family",
		}),
	);
	const tier2: AvailableRouteCandidate[] = [];
	if (options.requestedModelId !== undefined) {
		for (const destination of available) {
			if (!isOwningVendorApiAccount(destination)) continue;
			if (!sameVendor(destination.family, options.originFamily)) continue;
			const resolvedModelId = resolveTierModel(
				options.requestedModelId,
				destination.family,
				destination.modelIds ?? [],
				options.config.tierModelMap,
			);
			if (
				resolvedModelId === undefined ||
				!accountCanServeModel(
					destination,
					resolvedModelId,
					options.modelSupport,
				)
			) {
				continue;
			}
			tier2.push({
				destination,
				routeKind: "owning-vendor-api",
				resolvedModelId,
			});
		}
	}
	const crossVendorSubscriptions = subscriptions
		.filter((account) =>
			crossFamilyAllowed(
				options.originFamily,
				account.family,
				options.config,
			),
		)
		.map(
			(destination): AvailableRouteCandidate => ({
				destination,
				routeKind: "cross-family",
			}),
		);
	return [...tier1, ...tier2, ...crossVendorSubscriptions];
}

/**
 * Finds a managed account that keeps OpenRouter a true last resort.
 *
 * Amendment 1 intentionally preserves the legacy rule that any available
 * subscription blocks the metered rung. Owning-vendor accounts block only when
 * the origin model resolves to a live supported catalog entry.
 */
export function selectManagedLastResortCandidate(options: {
	readonly accounts: readonly ManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly originFamily: AllowedFamily;
	readonly requestedModelId?: string;
	readonly config: MultiAccountConfig;
	readonly preferredProviderId?: string;
	readonly excludedProviderIds?: ReadonlySet<string>;
	readonly modelSupport?: ModelSupportRegistry;
}): AvailableRouteCandidate | undefined {
	const seen = new Set<string>();
	const candidates: AvailableRouteCandidate[] = [];
	for (const destination of options.accounts) {
		if (firstCanonicalAccount(destination, seen) === undefined) continue;
		if (options.excludedProviderIds?.has(destination.providerId)) continue;
		if (!isAvailable(destination, options.state, options.nowMs)) continue;
		if (isSubscriptionManagedAccount(destination)) {
			candidates.push({
				destination,
				routeKind:
					destination.family === options.originFamily
						? "same-family"
						: "cross-family",
			});
			continue;
		}
		if (
			!isOwningVendorApiAccount(destination) ||
			!sameVendor(destination.family, options.originFamily) ||
			options.requestedModelId === undefined
		) {
			continue;
		}
		const resolvedModelId = resolveTierModel(
			options.requestedModelId,
			destination.family,
			destination.modelIds ?? [],
			options.config.tierModelMap,
		);
		if (
			resolvedModelId === undefined ||
			!accountCanServeModel(destination, resolvedModelId, options.modelSupport)
		) {
			continue;
		}
		candidates.push({
			destination,
			routeKind: "owning-vendor-api",
			resolvedModelId,
		});
	}
	return (
		candidates.find(
			(candidate) =>
				candidate.destination.providerId === options.preferredProviderId,
		) ?? candidates[0]
	);
}

function crossFamilyAllowed(
	from: AllowedFamily,
	to: AllowedFamily,
	config: MultiAccountConfig,
): boolean {
	return (
		config.crossFamilyChainEnabled &&
		config.crossFamilyChains.some(
			(chain) => chain.from === from && chain.to === to,
		)
	);
}

type CooldownReader = (
	providerId: string,
	nowMs: number,
) => ReturnType<RuntimeState["getCooldown"]>;
type UsageDistrustReader = (providerId: string, nowMs: number) => boolean;

/**
 * The one eligibility rule, shared by every caller that asks "can this account
 * receive a request now".
 *
 * Provider-reported exhaustion arrives as a parameter rather than being read
 * here, because callers learn it differently: a physical `ManagedAccount`
 * carries a fleet usage snapshot, while a logical account carries a boolean the
 * provider already reported. Everything after that point — dead credentials,
 * usage distrust, invalidation and cooldown — is identical for both, and must
 * stay that way. Adding a second copy of any of these checks elsewhere would
 * let two notions of "eligible" drift apart.
 */
function accountEligibleCore(options: {
	readonly providerId: string;
	readonly providerReportedExhausted: boolean;
	/**
	 * False only when the credential is known to be unusable. Callers that hold
	 * the credential itself pass it instead; this is for callers that were given
	 * the verdict rather than the secret.
	 */
	readonly authenticated?: boolean | undefined;
	readonly credential: ManagedAccount["credential"];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly readCooldown: CooldownReader;
	readonly isUsageSnapshotUntrusted: UsageDistrustReader;
}): boolean {
	if (options.authenticated === false) return false;
	if (
		options.credential !== undefined &&
		!isCredentialUsable(options.credential, options.nowMs)
	) {
		return false;
	}
	if (options.isUsageSnapshotUntrusted(options.providerId, options.nowMs)) {
		return false;
	}
	if (options.providerReportedExhausted) return false;
	return (
		options.state.getInvalidation(options.providerId) === undefined &&
		options.readCooldown(options.providerId, options.nowMs) === undefined
	);
}

function accountAvailableWithStateReaders(
	account: ManagedAccount,
	state: RuntimeState,
	nowMs: number,
	readCooldown: CooldownReader,
	isUsageSnapshotUntrusted: UsageDistrustReader,
): boolean {
	return accountEligibleCore({
		providerId: account.providerId,
		providerReportedExhausted: snapshotIndicatesExhaustion(
			account.fleetUsage,
			nowMs,
			"all-observed",
		),
		credential: account.credential,
		state,
		nowMs,
		readCooldown,
		isUsageSnapshotUntrusted,
	});
}

/**
 * The account facts the logical provider knows about one physical account.
 *
 * Deliberately narrower than {@link ManagedAccount}: the logical view carries
 * no credential material, so dead-credential status arrives already reduced to
 * `authenticated: false` by the caller that legitimately holds the credential.
 */
export interface LogicalEligibilityAccount {
	readonly providerId: string;
	/** The provider itself reported this account exhausted from a usage snapshot. */
	readonly exhausted?: boolean | undefined;
	/** False when the credential is present but provably unusable. */
	readonly authenticated?: boolean | undefined;
}

/**
 * Whether the logical provider may dispatch to this physical account now.
 *
 * This is the same rule {@link selectAvailableManagedAccount} applies, minus
 * the canonical-provider-id gate, which exists to keep non-managed providers
 * out of physical routing and would reject the logical view's account ids.
 *
 * It binds the mutation-free `peek` readers, never the recording `get` ones: a
 * preflight question must not park an account as a side effect of being asked.
 *
 * With no `state`, cooldown, invalidation and usage distrust are treated as
 * absent rather than as blocking. A caller that has no runtime state has not
 * observed a reason to exclude anything, and failing closed on all of them
 * would make every account ineligible and no request possible.
 */
/** Stands in when a caller supplied no runtime state; it observes nothing. */
const NO_OBSERVED_STATE = {
	getInvalidation: () => undefined,
} as unknown as RuntimeState;

export function logicalAccountEligible(
	account: LogicalEligibilityAccount,
	state: RuntimeState | undefined,
	nowMs: number,
): boolean {
	// Both signals go through the one shared rule rather than being tested
	// beside it. A second exhaustion test here would be a second notion of
	// exhaustion, free to drift from the one the physical path enforces.
	//
	// With no runtime state, cooldown, invalidation and usage distrust are
	// absent rather than blocking, so the readers report nothing and the
	// invalidation lookup finds nothing. Nothing is fabricated to force a
	// verdict: the inputs say only what was actually observed.
	return accountEligibleCore({
		providerId: account.providerId,
		providerReportedExhausted: account.exhausted === true,
		authenticated: account.authenticated,
		credential: undefined,
		state: state ?? NO_OBSERVED_STATE,
		nowMs,
		readCooldown:
			state === undefined ? () => undefined : state.peekCooldown.bind(state),
		isUsageSnapshotUntrusted:
			state === undefined
				? () => false
				: state.peekUsageSnapshotUntrusted.bind(state),
	});
}


function exactAccountAvailable(
	account: ManagedAccount,
	state: RuntimeState,
	nowMs: number,
	modelId: string,
	modelSupport: ModelSupportRegistry | undefined,
): boolean {
	if (!isCanonicalProviderId(account)) return false;
	if (account.modelIds === undefined || !account.modelIds.includes(modelId)) {
		return false;
	}
	if (modelSupport?.isUnsupported(account.providerId, modelId)) return false;
	return accountAvailableWithStateReaders(
		account,
		state,
		nowMs,
		state.peekCooldown.bind(state),
		state.peekUsageSnapshotUntrusted.bind(state),
	);
}

/**
 * Exact-model routing for read-only logical consumers. Unlike the reactive
 * selector, this path requires positive catalog membership and never selects a
 * catalog head for an unknown model.
 */
export function selectExactModelRouteCandidates(options: {
	readonly accounts: readonly SubscriptionManagedAccount[];
	readonly state: RuntimeState;
	readonly nowMs: number;
	readonly family: AllowedFamily;
	readonly config: MultiAccountConfig;
	readonly modelId: string;
	readonly preferredProviderId?: string;
	readonly excludedProviderIds?: ReadonlySet<string>;
	readonly providerId?: string;
	readonly modelSupport?: ModelSupportRegistry;
}): readonly SubscriptionManagedAccount[] {
	const seen = new Set<string>();
	const available = options.accounts.filter((account) => {
		if (firstCanonicalAccount(account, seen) === undefined) return false;
		if (
			options.providerId !== undefined &&
			account.providerId !== options.providerId
		) {
			return false;
		}
		if (options.excludedProviderIds?.has(account.providerId)) return false;
		return exactAccountAvailable(
			account,
			options.state,
			options.nowMs,
			options.modelId,
			options.modelSupport,
		);
	});

	if (options.providerId !== undefined) return available;

	const sameFamily = options.config.sameFamilyFailover
		? available.filter((account) => account.family === options.family)
		: [];
	const crossFamily = available.filter((account) =>
		crossFamilyAllowed(options.family, account.family, options.config),
	);
	const ordered = [...sameFamily, ...crossFamily];
	const preferred = ordered.find(
		(account) => account.providerId === options.preferredProviderId,
	);
	return preferred === undefined
		? ordered
		: [preferred, ...ordered.filter((account) => account !== preferred)];
}

function chooseAlternative(options: {
	failed: ManagedAccount;
	accounts: readonly ManagedAccount[];
	state: RuntimeState;
	config: MultiAccountConfig;
	nowMs: number;
	classification: FailureClassification;
	originFamily: AllowedFamily;
	requestedModelId?: string;
	modelId?: string;
	preferredModelId?: string;
	modelSupport?: ModelSupportRegistry;
}): ReactiveRouteDecision {
	const {
		failed,
		accounts,
		state,
		config,
		nowMs,
		classification,
		originFamily,
		requestedModelId,
		modelId,
		preferredModelId,
		modelSupport,
	} = options;
	const candidates = selectAvailableRouteCandidates({
		accounts,
		state,
		nowMs,
		originFamily,
		...(requestedModelId === undefined ? {} : { requestedModelId }),
		config,
		failedProviderId: failed.providerId,
		...(modelId === undefined ? {} : { modelId }),
		...(preferredModelId === undefined ? {} : { preferredModelId }),
		...(modelSupport === undefined ? {} : { modelSupport }),
	});
	const candidate = candidates[0];
	if (candidate !== undefined) {
		return {
			status: "selected",
			...candidate,
			classification,
		};
	}

	const eligible = accounts.filter((account) => {
		if (account.providerId === failed.providerId) return false;
		if (isSubscriptionManagedAccount(account)) {
			if (account.family === originFamily) {
				return (
					config.sameFamilyFailover &&
					(modelId === undefined ||
						accountCanServeModel(account, modelId, modelSupport))
				);
			}
			return crossFamilyAllowed(originFamily, account.family, config);
		}
		if (
			!isOwningVendorApiAccount(account) ||
			!sameVendor(account.family, originFamily) ||
			requestedModelId === undefined
		) {
			return false;
		}
		const resolvedModelId = resolveTierModel(
			requestedModelId,
			account.family,
			account.modelIds ?? [],
			config.tierModelMap,
		);
		return (
			resolvedModelId !== undefined &&
			accountCanServeModel(account, resolvedModelId, modelSupport)
		);
	});
	const recoveryTimes = eligible
		.map((account) => state.getCooldown(account.providerId, nowMs)?.untilMs)
		.filter((until): until is number => until !== undefined && until > nowMs);
	const earliestRecoveryAtMs =
		recoveryTimes.length === 0 ? null : Math.min(...recoveryTimes);
	return {
		status: "paused",
		classification,
		earliestRecoveryAtMs,
		retryAfterMs:
			earliestRecoveryAtMs === null ? null : earliestRecoveryAtMs - nowMs,
	};
}

function applyFailureCooldown(options: {
	readonly failedAccount: ManagedAccount;
	readonly normalizedAccounts: readonly ManagedAccount[];
	readonly classification: FailureClassification;
	readonly state: RuntimeState;
	readonly config: MultiAccountConfig;
	readonly nowMs: number;
}): boolean {
	const cooldown = createCooldownRecord({
		providerId: options.failedAccount.providerId,
		family: options.failedAccount.family,
		classification: options.classification,
		nowMs: options.nowMs,
		configuredMaxMs: options.config.cooldownMaxMs,
	});
	if (cooldown === undefined) return false;
	options.state.setCooldown(cooldown);
	const failedFingerprint = options.normalizedAccounts.find(
		(account) => account.providerId === options.failedAccount.providerId,
	)?.accountFingerprint;
	if (failedFingerprint !== undefined && failedFingerprint.length > 0) {
		for (const sibling of options.normalizedAccounts) {
			if (sibling.providerId === options.failedAccount.providerId) continue;
			if (sibling.accountFingerprint !== failedFingerprint) continue;
			options.state.setCooldown({
				...cooldown,
				providerId: sibling.providerId,
				family: sibling.family,
			});
		}
	}
	return true;
}

/**
 * Synchronously records only the cooldown part of a provider failure.
 * Selection and terminal invalidation remain settlement-only decisions.
 */
export function recordFailureCooldown(options: {
	readonly failedAccount: ManagedAccount;
	readonly accounts: readonly ManagedAccount[];
	readonly failure: ProviderFailureSignal;
	readonly state: RuntimeState;
	readonly config: MultiAccountConfig;
	readonly nowMs: number;
}): boolean {
	if (!isCanonicalProviderId(options.failedAccount)) {
		throw new TypeError("failedAccount must be a canonical managed provider.");
	}
	const classification = classifyFailure(options.failure);
	if (classification.accountAction !== "cooldown-and-route") return false;
	return applyFailureCooldown({
		failedAccount: options.failedAccount,
		// Pure projection ONLY: this runs inside the reversible cooldown mutation,
		// which can restore cooldown records but not identity/invalidation state.
		// `normalizedAccounts` would observe identity here and permanently clear
		// invalidations and unrelated cooldowns that a rollback could not restore.
		normalizedAccounts: projectCanonicalAccounts(options.accounts),
		classification,
		state: options.state,
		config: options.config,
		nowMs: options.nowMs,
	});
}

/**
 * Applies a classified post-request failure and chooses a reactive route. This
 * function never calls Pi setModel and therefore cannot perform proactive
 * pre-request selection; lifecycle code must explicitly apply the returned
 * decision and preserve Pi's boolean/throw semantics.
 */
export function routeAfterFailure(options: {
	failedAccount: ManagedAccount;
	accounts: readonly ManagedAccount[];
	failure: ProviderFailureSignal;
	originFamily: AllowedFamily;
	requestedModelId?: string;
	state: RuntimeState;
	config: MultiAccountConfig;
	nowMs: number;
	modelSupport?: ModelSupportRegistry;
	/** The same attempt already wrote its synchronous cooldown before host retry. */
	alreadyCooled?: boolean;
}): ReactiveRouteDecision {
	const {
		failedAccount,
		failure,
		originFamily,
		requestedModelId,
		state,
		config,
		nowMs,
		modelSupport,
		alreadyCooled = false,
	} = options;
	if (!isCanonicalProviderId(failedAccount)) {
		throw new TypeError("failedAccount must be a canonical managed provider.");
	}
	const classification = classifyFailure(failure);
	if (
		classification.category === "config" &&
		failure.code === "model_not_found" &&
		modelSupport !== undefined &&
		failure.modelId !== undefined
	) {
		modelSupport.markUnsupported({
			providerId: failedAccount.providerId,
			family: failedAccount.family,
			modelId: failure.modelId,
			observedAtMs: nowMs,
		});
	}

	// Observe the slot's current identity first. A fresh login may clear state
	// from the previous account, but the failure being handled now must still
	// create its own cooldown or invalidation afterward.
	const normalized = normalizedAccounts(options.accounts, state);
	if (classification.accountAction === "invalidate-and-route") {
		state.invalidateAccount({
			providerId: failedAccount.providerId,
			family: failedAccount.family,
			reason: "terminal-auth-failure",
			invalidatedAtMs: nowMs,
		});
		state.clearCooldown(failedAccount.providerId);
	} else if (
		classification.accountAction === "cooldown-and-route" &&
		!alreadyCooled
	) {
		applyFailureCooldown({
			failedAccount,
			normalizedAccounts: normalized,
			classification,
			state,
			config,
			nowMs,
		});
	}
	const accounts = normalized.some(
		(account) => account.providerId === failedAccount.providerId,
	)
		? normalized
		: [failedAccount, ...normalized];
	const failedIsOriginSubscription =
		isSubscriptionManagedAccount(failedAccount) &&
		failedAccount.family === originFamily;
	return chooseAlternative({
		failed: failedAccount,
		accounts,
		state,
		config,
		nowMs,
		classification,
		originFamily,
		...(requestedModelId === undefined ? {} : { requestedModelId }),
		...(failure.code === "model_not_found" &&
		failure.modelId !== undefined &&
		failedIsOriginSubscription
			? { modelId: failure.modelId }
			: {}),
		...(requestedModelId === undefined
			? failure.modelId === undefined
				? {}
				: { preferredModelId: failure.modelId }
			: { preferredModelId: requestedModelId }),
		...(modelSupport === undefined ? {} : { modelSupport }),
	});
}
