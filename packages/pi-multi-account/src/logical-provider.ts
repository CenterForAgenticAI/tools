/**
 * The `unified` logical provider.
 *
 * One virtual provider whose models are the exact wire model ids the managed
 * physical accounts serve. A request to a logical model is dispatched to a
 * physical account that actually serves that exact id, so the model the
 * operator picked is the model that runs.
 *
 * Construction is deliberately separate from registration. This module builds
 * the provider and knows nothing about the host; `registerLogicalProvider` in
 * `provider-registration.ts` puts it in front of one. That split is what lets a
 * request be driven with no host, and a registration be inspected with no
 * request.
 */

import { logicalAccountEligible, recordFailureCooldown } from "./routing.js";
import type { ManagedAccount } from "./routing.js";
import {
	isRetryableAssistantError,
	type AssistantMessage,
	type ProviderResponse,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { RuntimeState, type LogicalRoutePin } from "./runtime-state.js";
import { DEFAULT_CONFIG } from "./config.js";
import type {
	AllowedFamily,
	CrossFamilyChain,
	ManagedFamily,
	MultiAccountConfig,
} from "./config.js";
import {
	PROVIDER_ERROR_CODES,
	TRANSPORT_FAILURE_KINDS,
	classifyFailure,
	providerErrorCodeFromMessage,
} from "./error-classification.js";
import type {
	ProviderErrorCode,
	ProviderFailureSignal,
	TransportFailureKind,
} from "./error-classification.js";
import { resolveTierModel } from "./tier-model-resolver.js";
import type { TierModelMap } from "./tier-model-resolver.js";
import { providerTypeFor, tierRank, vendorForFamily } from "./vendor.js";
import type { ProviderType, Vendor } from "./vendor.js";

export { LOGICAL_PROVIDER_ID } from "./models-declaration.js";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";

/** One physical account the logical provider may dispatch to. */
export interface LogicalPhysicalAccount {
	/** Registered physical provider id, for example `anthropic-account-2`. */
	providerId: string;
	/** Physical provider-family token. OpenAI subscription and API tokens share one vendor. */
	family: ManagedFamily;
	/** Routing tier. Omitted legacy callers default from the physical family. */
	providerType?: Exclude<ProviderType, "openrouter">;
	/** Exact physical wire model ids this account serves. */
	modelIds: string[];
	/**
	 * Set when the PROVIDER reported this account exhausted from a usage
	 * snapshot. A request that merely failed and was retried elsewhere records a
	 * cooldown in {@link LogicalProviderDeps.state} instead; writing it here
	 * would make an ordinary cooldown look permanent.
	 */
	exhausted?: boolean;
	healthy?: boolean;
	/** False when the credential is present but provably unusable. */
	authenticated?: boolean;
	modelSupported?: boolean;
	/** Bounded, non-identifying. Never a human account name. */
	accountFingerprint?: string;
	/**
	 * Observed health of this account.
	 *
	 * Reported by preflight exactly as supplied, and omitted entirely when it
	 * was never observed. Defaulting a liveness window here would hand the
	 * operator an expiry nobody measured, presented as though it had been.
	 */
	health?: {
		healthy: boolean;
		live: boolean;
		/** Seconds until the observed credential window closes. */
		expiresAt: number;
	};
}

/** One physical attempt the logical provider makes. */
export interface LogicalDispatchCall {
	providerId: string;
	modelId: string;
	context: unknown;
	options?: unknown;
}

export interface LogicalObservation {
	providerId: string;
	modelId: string;
	family: ManagedFamily;
	providerType: Exclude<ProviderType, "openrouter">;
	/**
	 * The physical account this observation belongs to. Present so a reader can
	 * attribute it without re-deriving the route from the provider id, which is
	 * how an observation ends up filed against the logical name instead.
	 */
	route?: LogicalRouteFact;
	kind?: string;
}

/** The physical account an observation or preflight result belongs to. */
export interface LogicalRouteFact {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly providerType: Exclude<ProviderType, "openrouter">;
	readonly accountFingerprint: string;
	readonly [key: string]: unknown;
}

/** Response shape accepted at the fail-soft attempt boundary. */
export type LogicalAttributionResponse = Readonly<{
	status?: number;
	headers: Record<string, string>;
}>;

export type ManagedAssistantRecordOutcome =
	| { readonly status: "retained" }
	| { readonly status: "failed" };

export type LogicalTerminalOutcome =
	| ManagedAssistantRecordOutcome
	| { readonly status: "not-attempted" }
	| { readonly status: "not-attempted-capacity" };

/** One immutable, physical-route-bound attribution handle. */
export interface LogicalTerminalFailureFact {
	readonly alreadyCooled: boolean;
	readonly dispatchedModelId: string;
	readonly failure?: ProviderFailureSignal;
	/** Transient rollback for an association that later proves stale or ambiguous. */
	readonly rollbackCooldown?: () => void;
}

export interface LogicalAttributionAttempt {
	readonly onResponse: (response: LogicalAttributionResponse) => void;
	readonly onAuthentication: (success: boolean) => void;
	readonly onModelSupport: (supported: boolean) => void;
	readonly onHealth: (health: unknown) => void;
	readonly onPayload: (payload: unknown) => void;
	readonly finish: (message: AssistantMessage) => void;
	readonly fail: (
		message: AssistantMessage,
		failure?: LogicalTerminalFailureFact,
	) => boolean | void;
	readonly abort: (message: AssistantMessage) => void;
	readonly waitForTerminal: () => Promise<LogicalTerminalOutcome>;
	/** Link an emitted public terminal to this attempt’s private physical terminal. */
	readonly bindPublicTerminal?: (physical: AssistantMessage, publicMessage: AssistantMessage) => void;
}

/** Compatibility shape for callers that predate the terminal barrier. */
export type LogicalAttributionAttemptLike = Omit<LogicalAttributionAttempt, "waitForTerminal"> & {
	readonly waitForTerminal?: LogicalAttributionAttempt["waitForTerminal"];
};

const ignoreAttribution = (): void => {};
const noTerminalOutcome = (): Promise<LogicalTerminalOutcome> =>
	Promise.resolve({ status: "not-attempted" });
const acceptUnattributedFailure = (): true => true;

/** Shared inert handle for absent, failed, invalid, or released attribution. */
export const NOOP_LOGICAL_ATTRIBUTION_ATTEMPT: LogicalAttributionAttempt =
	Object.freeze({
		onResponse: ignoreAttribution,
		onAuthentication: ignoreAttribution,
		onModelSupport: ignoreAttribution,
		onHealth: ignoreAttribution,
		onPayload: ignoreAttribution,
		finish: ignoreAttribution,
		// An intentionally absent/released observer cannot reject host-retry
		// bookkeeping. Real association stores return false for stale attempts.
		fail: acceptUnattributedFailure,
		abort: ignoreAttribution,
		waitForTerminal: noTerminalOutcome,
	});

/** Synchronous attribution lifecycle owned by one logical-provider session. */
export interface LogicalAttributionLifecycle {
	beginAttempt(route: LogicalRouteFact): LogicalAttributionAttemptLike;
	settle(): void;
	shutdown(): void;
}

export interface LogicalRoutePinAccess {
	readonly get: () => LogicalRoutePin | undefined;
	readonly consume: (
		expectedGeneration: number,
		requestedModelId: string,
	) => LogicalRoutePin | undefined;
	readonly clear: () => void;
}

export interface LogicalProviderDeps {
	accounts: LogicalPhysicalAccount[];
	dispatch: (
		call: LogicalDispatchCall,
	) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
	logicalModelId?: string;
	originFamily?: AllowedFamily;
	/** Subscription-catalog owner of a declared logical model. */
	modelVendor?: (modelId: string) => Vendor | undefined;
	tierModelMap?: TierModelMap;
	crossFamilyChains?: readonly CrossFamilyChain[];
	onObservation?: (observation: LogicalObservation) => void;
	attribution?: LogicalAttributionLifecycle;
	/** Private session correlation for the public terminal and physical route. */
	onPublicTerminal?: (physical: AssistantMessage, publicMessage: AssistantMessage) => void;
	onDiagnostic?: (message: string) => void;
	onShutdownAbort?: () => void;
	scheduleContinuation?: (run: () => void) => void;
	state?: RuntimeState;
	routePin?: LogicalRoutePinAccess;
}

export interface LogicalProvider {
	api: string;
	streamSimple: (
		model: unknown,
		context: unknown,
		options?: unknown,
	) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
	preflight?: (model: unknown) => unknown;
	shutdown?: () => unknown;
}

export function safeAttributionCall(call: () => void): void {
	try {
		call();
	} catch {
		// Attribution must never replace a provider result.
	}
}

export function safeBeginAttributionAttempt(
	attribution: LogicalAttributionLifecycle | undefined,
	route: LogicalRouteFact,
): LogicalAttributionAttempt {
	if (attribution === undefined) return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
	try {
		const attempt = attribution.beginAttempt(route);
		if (typeof attempt.waitForTerminal === "function") {
			return attempt as LogicalAttributionAttempt;
		}
		return Object.freeze({
			onResponse: attempt.onResponse,
			onAuthentication: attempt.onAuthentication,
			onModelSupport: attempt.onModelSupport,
			onHealth: attempt.onHealth,
			onPayload: attempt.onPayload,
			finish: attempt.finish,
			fail: attempt.fail,
			abort: attempt.abort,
			waitForTerminal: noTerminalOutcome,
			...(attempt.bindPublicTerminal === undefined ? {} : { bindPublicTerminal: attempt.bindPublicTerminal }),
		});
	} catch {
		return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
	}
}

/**
 * The wire model id a request names.
 *
 * The host describes a selected model in more than one shape depending on where
 * the selection came from, so read `id` and ignore the rest. Only the exact id
 * matters: it is matched byte-for-byte against what an account serves.
 */
function requestedModelId(model: unknown): string | undefined {
	if (typeof model === "string") return model;
	if (typeof model !== "object" || model === null) return undefined;
	const id = (model as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function logicalProviderType(
	account: LogicalPhysicalAccount,
): Exclude<ProviderType, "openrouter"> {
	// The distinct OpenAI families determine their tier regardless of a caller's
	// optional hint. Anthropic alone needs the hint because both tiers share one
	// physical family token.
	return providerTypeFor(
		account.family,
		account.providerType === "owning-vendor-api" ? "api_key" : "unknown",
	);
}

interface LogicalServingAccount {
	readonly account: LogicalPhysicalAccount;
	readonly resolvedModelId: string;
}

function resolveLogicalServingAccount(
	account: LogicalPhysicalAccount,
	modelId: string,
	tierModelMap: TierModelMap,
): LogicalServingAccount | undefined {
	const providerType = logicalProviderType(account);
	if (providerType === "subscription") {
		return account.modelIds.includes(modelId)
			? { account, resolvedModelId: modelId }
			: undefined;
	}
	// Google has no supported metered destination. Reject it before consulting
	// tier mappings so a hostile or inconsistent account shape cannot select or
	// dispatch a guessed Google model through a paid tier.
	if (account.family === "google-antigravity") return undefined;
	const resolvedModelId = resolveTierModel(
		modelId,
		vendorForFamily(account.family),
		account.modelIds,
		tierModelMap,
	);
	return resolvedModelId === undefined ? undefined : { account, resolvedModelId };
}

const PROVIDER_ERROR_CODE_SET: ReadonlySet<string> = new Set(
	PROVIDER_ERROR_CODES,
);
const TRANSPORT_FAILURE_KIND_SET: ReadonlySet<string> = new Set(
	TRANSPORT_FAILURE_KINDS,
);

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

const EXHAUSTION_LENGTH_MAX_OUTPUT_TOKENS = 1;
const EXHAUSTION_LENGTH_MIN_ALLOWANCE_TOKENS = 1_024;
const EXHAUSTION_LENGTH_ALLOWANCE_MULTIPLIER = 8;
const EXHAUSTION_LENGTH_MAX_CONTEXT_FRACTION = 0.8;
const EXHAUSTION_LENGTH_ERROR_MESSAGE = "provider returned error (usage-limit)";

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function projectTerminalUsage(message: AssistantMessage): AssistantMessage["usage"] | undefined {
	const rawUsage = (message as unknown as { usage?: unknown }).usage;
	if (typeof rawUsage !== "object" || rawUsage === null) return undefined;
	const usage = rawUsage as Record<string, unknown>;
	const input = finiteNonNegative(usage.input);
	const output = finiteNonNegative(usage.output);
	const cacheRead = finiteNonNegative(usage.cacheRead);
	const cacheWrite = finiteNonNegative(usage.cacheWrite);
	const totalTokens = finiteNonNegative(usage.totalTokens);
	const rawCost = usage.cost;
	if (
		input === undefined ||
		output === undefined ||
		cacheRead === undefined ||
		cacheWrite === undefined ||
		totalTokens === undefined ||
		typeof rawCost !== "object" ||
		rawCost === null
	) {
		return undefined;
	}
	const cost = rawCost as Record<string, unknown>;
	const costInput = finiteNonNegative(cost.input);
	const costOutput = finiteNonNegative(cost.output);
	const costCacheRead = finiteNonNegative(cost.cacheRead);
	const costCacheWrite = finiteNonNegative(cost.cacheWrite);
	const costTotal = finiteNonNegative(cost.total);
	if (
		costInput === undefined ||
		costOutput === undefined ||
		costCacheRead === undefined ||
		costCacheWrite === undefined ||
		costTotal === undefined
	) {
		return undefined;
	}
	const cacheWrite1h = finiteNonNegative(usage.cacheWrite1h);
	if (usage.cacheWrite1h !== undefined && cacheWrite1h === undefined) return undefined;
	const reasoning = finiteNonNegative(usage.reasoning);
	if (usage.reasoning !== undefined && reasoning === undefined) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
	};
}

interface ExhaustionLengthMatch {
	readonly usage: AssistantMessage["usage"];
	readonly timestamp: number;
}

function exhaustionLengthMatch(input: {
	readonly message: AssistantMessage;
	readonly model: unknown;
	readonly options: SimpleStreamOptions | undefined;
	readonly account: LogicalPhysicalAccount;
	readonly currentAccounts: () => LogicalPhysicalAccount[];
}): ExhaustionLengthMatch | undefined {
	try {
		if (input.message.stopReason !== "length") return undefined;
		if (logicalProviderType(input.account) !== "subscription") return undefined;
		if (typeof input.model !== "object" || input.model === null) return undefined;
		const model = input.model as Record<string, unknown>;
		const contextWindow = finiteNonNegative(model.contextWindow);
		const modelMaxTokens = finiteNonNegative(model.maxTokens);
		if (
			contextWindow === undefined ||
			contextWindow === 0 ||
			modelMaxTokens === undefined
		) {
			return undefined;
		}
		const optionMaxTokens = input.options?.maxTokens;
		const allowance =
			optionMaxTokens === undefined
				? modelMaxTokens
				: finiteNonNegative(optionMaxTokens);
		if (allowance === undefined) return undefined;

		const usage = projectTerminalUsage(input.message);
		const timestamp = finiteNonNegative(input.message.timestamp);
		if (usage === undefined || timestamp === undefined) return undefined;
		if (usage.output > EXHAUSTION_LENGTH_MAX_OUTPUT_TOKENS) return undefined;
		if (allowance < EXHAUSTION_LENGTH_MIN_ALLOWANCE_TOKENS) return undefined;
		if (
			allowance <
			EXHAUSTION_LENGTH_ALLOWANCE_MULTIPLIER * Math.max(usage.output, 1)
		) {
			return undefined;
		}
		const inputFromTotal = usage.totalTokens - usage.output;
		const inputFromBreakdown = usage.input + usage.cacheRead + usage.cacheWrite;
		if (
			inputFromTotal < 0 ||
			!Number.isFinite(inputFromBreakdown) ||
			Math.max(inputFromTotal, inputFromBreakdown) >
				contextWindow * EXHAUSTION_LENGTH_MAX_CONTEXT_FRACTION
		) {
			return undefined;
		}

		const currentMatches = input.currentAccounts().filter(
			(currentAccount) =>
				currentAccount.providerId === input.account.providerId &&
				currentAccount.family === input.account.family &&
				logicalProviderType(currentAccount) === "subscription",
		);
		if (currentMatches.length !== 1) return undefined;
		const currentAccount = currentMatches[0]!;
		if (!(currentAccount.exhausted === true)) return undefined;
		const requestFingerprint = input.account.accountFingerprint;
		if (
			typeof requestFingerprint === "string" &&
			requestFingerprint.length > 0 &&
			currentAccount.accountFingerprint !== requestFingerprint
		) {
			return undefined;
		}
		return { usage, timestamp };
	} catch {
		return undefined;
	}
}

/**
 * Project a caller's thrown error into the narrow failure signal routing reads.
 *
 * Named fields only, each validated against the shipped vocabulary. A spread or
 * a cast here would carry whatever else the caller hung on its error — message
 * text, headers, a whole response body — into a structure that is classified,
 * retained, and reported through a diagnostic sink. The model id comes from the
 * selection this provider just made, never from the error.
 */
function projectFailureSignal(
	error: unknown,
	modelId: string,
): ProviderFailureSignal {
	const source =
		typeof error === "object" && error !== null
			? (error as Record<string, unknown>)
			: {};
	const httpStatus =
		finiteNumber(source.httpStatus) ?? finiteNumber(source.status);
	const rawCode = source.code;
	const parsedCode = providerErrorCodeFromMessage(
		typeof source.errorMessage === "string"
			? source.errorMessage
			: typeof source.message === "string"
				? source.message
				: undefined,
	);
	const code =
		typeof rawCode === "string" && PROVIDER_ERROR_CODE_SET.has(rawCode)
			? (rawCode as ProviderErrorCode)
			: parsedCode;
	const transportKind = source.transportKind;
	const retryAfterSeconds = finiteNumber(source.retryAfterSeconds);
	const resetAtMs = finiteNumber(source.resetAtMs);
	return {
		modelId,
		...(httpStatus === undefined ? {} : { httpStatus }),
		...(code === undefined ? {} : { code }),
		...(typeof transportKind === "string" &&
		TRANSPORT_FAILURE_KIND_SET.has(transportKind)
			? { transportKind: transportKind as TransportFailureKind }
			: {}),
		...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		...(resetAtMs === undefined ? {} : { resetAtMs }),
	};
}

function safeProjectFailureSignal(
	error: unknown,
	modelId: string,
): ProviderFailureSignal {
	try {
		return projectFailureSignal(error, modelId);
	} catch {
		return { modelId };
	}
}

/**
 * Project a logical account into the account shape routing understands.
 *
 * Provider-reported exhaustion becomes the usage shape routing actually reads.
 * Without that translation an exhausted account looks healthy on the retry
 * path while the first route excludes it, which is two notions of exhaustion
 * free to drift apart.
 */
function projectManagedAccount(
	account: LogicalPhysicalAccount,
): ManagedAccount {
	return {
		providerId: account.providerId,
		family: account.family,
		credentialType:
			logicalProviderType(account) === "owning-vendor-api" ? "api_key" : "oauth",
		modelIds: [...account.modelIds],
		...(account.exhausted === true
			? { fleetUsage: { remainingRequests: 0 } }
			: {}),
		...(account.accountFingerprint === undefined
			? {}
			: { accountFingerprint: account.accountFingerprint }),
	};
}

interface HostRetryCooldownReceipt {
	readonly alreadyCooled: boolean;
	readonly rollback: () => void;
}

/** Synchronous, cooldown-only bookkeeping shared with host retry selection. */
export interface HostRetryCoordinator {
	readonly state: RuntimeState;
	recordFailure(input: {
		account: LogicalPhysicalAccount;
		requestedModelId: string;
		dispatchedModelId: string;
		error: unknown;
	}): HostRetryCooldownReceipt;
}

export function createHostRetryCoordinator(
	deps: LogicalProviderDeps,
): HostRetryCoordinator {
	const state = deps.state ?? new RuntimeState();
	const config: MultiAccountConfig = {
		...DEFAULT_CONFIG,
		tierModelMap: deps.tierModelMap ?? DEFAULT_CONFIG.tierModelMap,
	};

	const reportSwallowed = (): void => {
		try {
			deps.onDiagnostic?.(
				"logical host retry bookkeeping failed and was ignored.",
			);
		} catch {
			// Deliberately empty: bookkeeping cannot replace a provider result.
		}
	};
	const noCooldownReceipt = (): HostRetryCooldownReceipt => ({
		alreadyCooled: false,
		rollback: () => {},
	});

	return {
		state,
		recordFailure(input) {
			try {
				const failure = projectFailureSignal(input.error, input.dispatchedModelId);
				const managed = deps.accounts
					.filter((account) => account.authenticated !== false)
					.map(projectManagedAccount);
				const failedAccount = managed.find(
					(account) => account.providerId === input.account.providerId,
				);
				if (failedAccount === undefined) return noCooldownReceipt();
				const failedFingerprint = failedAccount.accountFingerprint;
				const affectedProviderIds = managed
					.filter(
						(account) =>
							account.providerId === failedAccount.providerId ||
							(failedFingerprint !== undefined &&
								failedFingerprint.length > 0 &&
								account.accountFingerprint === failedFingerprint),
					)
					.map((account) => account.providerId);
				const transaction = state.runReversibleCooldownMutation(
					affectedProviderIds,
					() =>
						recordFailureCooldown({
							failedAccount,
							accounts: managed,
							failure,
							state,
							config,
							nowMs: Date.now(),
						}),
				);
				return {
					alreadyCooled: transaction.value,
					rollback: transaction.rollback,
				};
			} catch {
				reportSwallowed();
				return noCooldownReceipt();
			}
		},
	};
}

/**
 * Build the logical provider.
 *
 * Selection is exact and unforgiving by design. A model id no account serves is
 * refused rather than mapped onto something close to it: substituting a
 * catalog head, a same-family sibling or a vendor default would quietly run a
 * different model than the operator chose, and the resulting answer would look
 * entirely normal.
 */
export function createLogicalProvider(
	deps: LogicalProviderDeps,
): LogicalProvider {
	const coordinator = createHostRetryCoordinator(deps);

	const diagnose = (message: string): void => {
		deps.onDiagnostic?.(message);
	};

	const selectAccount = (
		modelId: string,
		consumeRoutePin: boolean,
	): LogicalServingAccount => {
		const subscriptionVendors = new Set(
			deps.accounts
				.filter(
					(account) =>
						logicalProviderType(account) === "subscription" &&
						account.modelIds.includes(modelId),
				)
				.map((account) => vendorForFamily(account.family)),
		);
		let modelVendor = deps.modelVendor?.(modelId);
		if (modelVendor === undefined && deps.modelVendor === undefined) {
			if (subscriptionVendors.size === 1) {
				modelVendor = subscriptionVendors.values().next().value as Vendor;
			} else if (subscriptionVendors.size > 1 && deps.originFamily !== undefined) {
				const originVendor = vendorForFamily(deps.originFamily);
				if (subscriptionVendors.has(originVendor)) modelVendor = originVendor;
			}
		}
		if (modelVendor === undefined) {
			if (subscriptionVendors.size > 1) {
				throw new Error(
					`the model id ${modelId} is served by more than one managed family, so no route can be chosen for it`,
				);
			}
			throw new Error(
				`no managed account serves the exact model id ${modelId}`,
			);
		}

		const tierModelMap = deps.tierModelMap ?? DEFAULT_CONFIG.tierModelMap;
		const serving = deps.accounts.flatMap((account) => {
			if (vendorForFamily(account.family) !== modelVendor) return [];
			const resolved = resolveLogicalServingAccount(account, modelId, tierModelMap);
			return resolved === undefined ? [] : [resolved];
		});
		if (serving.length === 0) {
			// Refusal, not substitution. This is also the load-bearing half of the
			// exact-identity contract: a virtual id that is neither exact nor explicitly
			// mapped to a catalog member must never reach a physical provider.
			throw new Error(
				`no managed account serves the exact model id ${modelId}`,
			);
		}

		// Physical OpenAI subscription (`openai-codex`) and owning-vendor API
		// (`openai`) accounts are one routing family: vendor `openai`. Ownership is
		// fixed from the declared subscription catalog before API exact/map matches are
		// admitted, so another vendor's API catalog cannot make a row ambiguous.
		const nowMs = Date.now();
		const eligible = serving.filter(({ account }) =>
			logicalAccountEligible(
				{
					providerId: account.providerId,
					exhausted: account.exhausted,
					authenticated: account.authenticated,
				},
				// The coordinator's carrier, not `deps.state` directly. A failure
				// this turn already recorded lives there, and reading anywhere else
				// would re-select the account that just failed.
				coordinator.state,
				nowMs,
			),
		);
		if (consumeRoutePin) {
			const pin = deps.routePin?.get();
			if (pin !== undefined) {
				const pinned = eligible.find(
					({ account, resolvedModelId }) =>
						account.providerId === pin.destinationProviderId &&
						account.family === pin.destinationFamily &&
						logicalProviderType(account) === "subscription" &&
						resolvedModelId === modelId &&
						pin.requestedModelId === modelId,
				);
				if (pinned === undefined) {
					deps.routePin?.clear();
				} else {
					const consumed = deps.routePin?.consume(pin.generation, modelId);
					if (
						consumed !== undefined &&
						consumed.destinationProviderId === pinned.account.providerId &&
						consumed.destinationFamily === pinned.account.family
					) {
						return pinned;
					}
				}
			}
		}
		eligible.sort(
			(left, right) =>
				tierRank(logicalProviderType(left.account)) -
				tierRank(logicalProviderType(right.account)),
		);
		const chosen = eligible[0];
		if (chosen === undefined) {
			// Every account across every tier that serves this model is currently
			// ineligible. The turn is refused before any physical request is issued;
			// it is not parked, and no account is mutated by having been asked.
			throw new Error(
				`every managed account serving ${modelId} is currently ineligible`,
			);
		}
		return chosen;
	};

	/**
	 * Watch a stream that opened successfully.
	 *
	 * A provider can accept a request, return 200, and fail part-way through the
	 * stream — Anthropic emits `event: error` that way. That failure is exactly
	 * as real as a rejected dispatch, so it records exactly the same cooldown;
	 * without this, a mid-stream rate limit would leave the account looking
	 * healthy and the host would retry straight back onto it.
	 *
	 * It also guarantees the host sees a terminal event.
	 *
	 * The host settles a turn only on a `done` or `error` event: `EventStream`
	 * resolves its final result from `isComplete(event)` on push, and the
	 * `forwardStream` adapter that wraps every provider stream ends with
	 * `end(undefined)` when the source exposes no `result()`, which the
	 * `result !== undefined` guard makes a no-op. A dispatched stream that simply
	 * runs out therefore leaves the caller's `prompt()` pending forever, with no
	 * timeout anywhere to break it.
	 *
	 * `deps.dispatch` is caller-supplied, so that is a careless caller wedging the
	 * host permanently. Real Pi streams always terminate, so this is defense in
	 * depth at an injectable boundary rather than a repair of a reachable hang.
	 *
	 * The synthesized event is `error`, never `done`. A stream that stopped
	 * without terminating did not answer, and reporting `done` would invent an
	 * answer that never arrived.
	 *
	 * It records no cooldown. Not terminating is a protocol fault in the dispatch
	 * implementation, not evidence the account is rate limited, and
	 * `classifyFailure` would read an unrecognizable failure as
	 * `cooldown("unknown", …)` — cooling a healthy account for someone else's bug.
	 * A genuinely failing account still throws, and the catch below cools it.
	 *
	 * `result()` is deliberately not forwarded. Exposing it would make
	 * `forwardStream` take its `await source.result()` branch, which for exactly
	 * this non-terminating source never settles.
	 */
	const terminalAttribution = (
		event: unknown,
	):
		| { readonly outcome: "finish" | "fail" | "abort"; readonly message: AssistantMessage }
		| undefined => {
		if (typeof event !== "object" || event === null) return undefined;
		const candidate = event as {
			type?: unknown;
			reason?: unknown;
			message?: unknown;
			error?: unknown;
		};
		const terminal = candidate.type === "done" ? candidate.message : candidate.error;
		if (
			(candidate.type !== "done" && candidate.type !== "error") ||
			typeof terminal !== "object" ||
			terminal === null ||
			(terminal as { role?: unknown }).role !== "assistant"
		) {
			return undefined;
		}
		return {
			outcome:
				candidate.type === "done"
					? "finish"
					: candidate.reason === "aborted"
						? "abort"
						: "fail",
			message: terminal as AssistantMessage,
		};
	};

	const syntheticErrorMessage = (
		modelId: string,
		errorMessage: string,
		usage: AssistantMessage["usage"] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		timestamp = Date.now(),
	): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: LOGICAL_PROVIDER_ID,
		provider: LOGICAL_PROVIDER_ID,
		model: modelId,
		usage,
		stopReason: "error",
		errorMessage,
		timestamp,
	});

	const exhaustionLengthError = (
		modelId: string,
		match: ExhaustionLengthMatch,
	): AssistantMessage & { readonly code: "quota_exhausted" } => ({
		...syntheticErrorMessage(
			modelId,
			EXHAUSTION_LENGTH_ERROR_MESSAGE,
			match.usage,
			match.timestamp,
		),
		code: "quota_exhausted",
	});

	const hostWouldRetry = (error: unknown): boolean => {
		try {
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: String(error);
			return isRetryableAssistantError({
				stopReason: "error",
				errorMessage,
			} as AssistantMessage);
		} catch {
			return false;
		}
	};

	const classifiedErrorMessage = (
		failure: ProviderFailureSignal,
		hostRetryable: boolean,
	): string => {
		const label = (() => {
			switch (classifyFailure(failure).category) {
				case "quota-rate-limit":
					return "usage-limit";
				case "terminal-auth":
				case "transient-auth":
					return "authentication";
				case "permission":
					return "permission";
				case "config":
					return "configuration";
				case "transport":
					return "network";
				case "unknown":
					return "unknown";
			}
		})();
		const prefix = hostRetryable ? "provider returned error" : "provider_error";
		return `${prefix} (${label})`;
	};

	const projectMessage = (message: AssistantMessage, modelId: string): AssistantMessage => ({
		...message, api: LOGICAL_PROVIDER_ID, provider: LOGICAL_PROVIDER_ID, model: modelId,
	});

	const projectEvent = (event: unknown, modelId: string): unknown => {
		if (typeof event !== "object" || event === null) return event;
		const candidate = event as Record<string, unknown>;
		const key = candidate.type === "done" ? "message" : candidate.type === "error" ? "error" :
			["start", "text_start", "text_delta", "text_end", "thinking_start",
				"thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta",
				"toolcall_end"].includes(String(candidate.type)) ? "partial" : undefined;
		if (key === undefined) return event;
		const value = candidate[key];
		if (typeof value !== "object" || value === null) return event;
		return { ...candidate, [key]: projectMessage(value as AssistantMessage, modelId) };
	};

	const watchStream = (
		stream: AsyncIterable<unknown>,
		model: unknown,
		options: SimpleStreamOptions | undefined,
		account: LogicalPhysicalAccount,
		requestedModelId: string,
		dispatchedModelId: string,
		attempt: LogicalAttributionAttempt,
	): AsyncIterable<unknown> => ({
		async *[Symbol.asyncIterator]() {
			let sawTerminal = false;
			let failureReceipt: HostRetryCooldownReceipt | undefined;
			const recordFailureOnce = (error: unknown): HostRetryCooldownReceipt => {
				failureReceipt ??= coordinator.recordFailure({
					account,
					requestedModelId,
					dispatchedModelId,
					error,
				});
				return failureReceipt;
			};
			const attributeFailure = (
				message: AssistantMessage,
				failure: ProviderFailureSignal,
				receipt: HostRetryCooldownReceipt,
			): void => {
				// Host retry needs the cooldown before the terminal reaches Pi, while
				// exact identity cannot be accepted until association/message_end. The
				// receipt makes the early write provisional and reverses it on uncertainty.
				try {
					const accepted = attempt.fail(message, {
						alreadyCooled: receipt.alreadyCooled,
						dispatchedModelId,
						failure,
						...(receipt.alreadyCooled
							? { rollbackCooldown: receipt.rollback }
							: {}),
					});
					if (accepted === false && deps.attribution !== undefined) receipt.rollback();
				} catch {
					if (deps.attribution !== undefined) receipt.rollback();
				}
			};
			try {
				// Keep physical events intact. A corroborated subscription-exhaustion
				// length terminal still becomes a bounded retryable public error.
				for await (const event of stream) {
					const eventType =
						typeof event === "object" && event !== null
							? (event as { type?: unknown }).type
							: undefined;
					if (eventType === "done" || eventType === "error") sawTerminal = true;
					const terminal = terminalAttribution(event);
					if (terminal !== undefined) {
						const { message, outcome } = terminal;
						if (outcome === "finish") {
							const match = exhaustionLengthMatch({
								message,
								model,
								options,
								account,
								currentAccounts: () => deps.accounts,
							});
							if (match !== undefined) {
								const replacement = exhaustionLengthError(requestedModelId, match);
								const failure = safeProjectFailureSignal(
									replacement,
									dispatchedModelId,
								);
								attributeFailure(
									replacement,
									failure,
									recordFailureOnce(replacement),
								);
								await attempt.waitForTerminal();
								yield { type: "error", reason: "error", error: replacement };
								continue;
							}
							safeAttributionCall(() => attempt.finish(message));
						} else if (outcome === "abort") {
							safeAttributionCall(() => attempt.abort(message));
						} else {
							const failure = safeProjectFailureSignal(message, dispatchedModelId);
							attributeFailure(message, failure, recordFailureOnce(message));
						}
						await attempt.waitForTerminal();
					}
					const publicEvent = projectEvent(event, requestedModelId);
					if (terminal !== undefined && publicEvent !== event) {
						const publicTerminal = terminalAttribution(publicEvent);
						if (publicTerminal !== undefined) {
							safeAttributionCall(() => attempt.bindPublicTerminal?.(terminal.message, publicTerminal.message));
							safeAttributionCall(() => deps.onPublicTerminal?.(terminal.message, publicTerminal.message));
						}
					}
					yield publicEvent;
				}
			} catch (error) {
				recordFailureOnce(error);
				throw error;
			}
			if (sawTerminal) return;
			deps.onDiagnostic?.(
				`logical dispatch stream for ${account.providerId} ended with no terminal event; ` +
					"reporting a synthetic failure so the turn cannot hang",
			);
			const syntheticMessage = syntheticErrorMessage(
				requestedModelId,
				"the dispatched stream ended without a terminal event",
			);
			safeAttributionCall(() => attempt.fail(syntheticMessage));
			await attempt.waitForTerminal();
			yield { type: "error", reason: "error", error: syntheticMessage };
		},
	});

	return {
		api: LOGICAL_PROVIDER_ID,

		// Deliberately `async`: a refusal must arrive as a rejected promise, not
		// as a synchronous throw. Callers invoke this and then await the result,
		// so a synchronous throw would escape past their error handling entirely.
		async streamSimple(model, context, rawOptions) {
			const options =
				typeof rawOptions === "object" && rawOptions !== null
					? (rawOptions as SimpleStreamOptions)
					: undefined;
			const modelId = requestedModelId(model);
			if (modelId === undefined) {
				throw new Error(
					"the logical provider was asked for a request with no model id",
				);
			}
			const { account, resolvedModelId } = selectAccount(modelId, true);
			const providerType = logicalProviderType(account);
			deps.onObservation?.({
				providerId: account.providerId,
				modelId: resolvedModelId,
				family: account.family,
				providerType,
			});
			const route: LogicalRouteFact = Object.freeze({
				providerId: account.providerId,
				family: account.family,
				providerType,
				accountFingerprint: account.providerId,
			});
			const attempt = safeBeginAttributionAttempt(deps.attribution, route);
			if (account.authenticated !== undefined) {
				safeAttributionCall(() => attempt.onAuthentication(account.authenticated!));
			}
			if (account.modelSupported !== undefined) {
				safeAttributionCall(() => attempt.onModelSupport(account.modelSupported!));
			}
			if (account.health !== undefined) {
				safeAttributionCall(() => attempt.onHealth(account.health));
			}
			const originalOnPayload = options?.onPayload;
			const originalOnResponse = options?.onResponse;
			const wrappedOnPayload: NonNullable<SimpleStreamOptions["onPayload"]> = async (
				payload,
				payloadModel,
			) => {
				safeAttributionCall(() => attempt.onPayload(payload));
				if (originalOnPayload === undefined) return undefined;
				return await originalOnPayload(payload, payloadModel);
			};
			const wrappedOnResponse: NonNullable<SimpleStreamOptions["onResponse"]> = async (
				response,
				responseModel,
			) => {
				safeAttributionCall(() => attempt.onResponse(response));
				if (originalOnResponse !== undefined) {
					await originalOnResponse(response, responseModel);
				}
			};
			const attributedOptions: SimpleStreamOptions = {
				...options,
				onPayload: wrappedOnPayload,
				onResponse: wrappedOnResponse,
			};
			// Dispatch only the exact requested id or the catalog-checked destination id
			// from the operator-authored tier map. A catalog head is never a fallback.
			let stream: AsyncIterable<unknown>;
			try {
				stream = await deps.dispatch({
					providerId: account.providerId,
					modelId: resolvedModelId,
					context,
					options: attributedOptions,
				});
			} catch (error) {
				// Cool synchronously so host retry cannot reselect this account, then
				// surface the rejection as a self-owned terminal that can be correlated
				// by exact object identity at message_end.
				const failure = safeProjectFailureSignal(error, resolvedModelId);
				const receipt = coordinator.recordFailure({
					account,
					requestedModelId: modelId,
					dispatchedModelId: resolvedModelId,
					error,
				});
				const syntheticMessage = syntheticErrorMessage(
					modelId,
					classifiedErrorMessage(failure, hostWouldRetry(error)),
				);
				try {
					const accepted = attempt.fail(syntheticMessage, {
						alreadyCooled: receipt.alreadyCooled,
						dispatchedModelId: resolvedModelId,
						failure,
						...(receipt.alreadyCooled
							? { rollbackCooldown: receipt.rollback }
							: {}),
					});
					if (accepted === false && deps.attribution !== undefined) receipt.rollback();
				} catch {
					if (deps.attribution !== undefined) receipt.rollback();
				}
				return (async function* () {
					await attempt.waitForTerminal();
					yield { type: "error", reason: "error", error: syntheticMessage };
				})();
			}
			return watchStream(
				stream,
				model,
				options,
				account,
				modelId,
				resolvedModelId,
				attempt,
			);
		},

		preflight(model) {
			const modelId = requestedModelId(model);
			if (modelId === undefined) return undefined;
			try {
				const { account, resolvedModelId } = selectAccount(modelId, false);
				const providerType = logicalProviderType(account);
				// Everything below is read off the account that was actually
				// chosen. The logical provider has no health, no credential and no
				// expiry of its own, so reporting anything not observed here would
				// be reporting an invention as a measurement.
				const route: LogicalRouteFact = {
					providerId: account.providerId,
					family: account.family,
					providerType,
					accountFingerprint: account.providerId,
				};
				deps.onObservation?.({
					providerId: account.providerId,
					modelId: resolvedModelId,
					family: account.family,
					providerType,
					kind: "preflight",
					route,
				});
				return {
					route,
					...(account.health === undefined ? {} : { health: account.health }),
					...(account.authenticated === undefined
						? {}
						: { authenticated: account.authenticated }),
					...(account.modelSupported === undefined
						? {}
						: { modelSupported: account.modelSupported }),
				};
			} catch (error) {
				diagnose(
					error instanceof Error
						? `logical preflight refused ${modelId}: ${error.message}`
						: `logical preflight refused ${modelId}`,
				);
				return undefined;
			}
		},

		shutdown() {
			safeAttributionCall(() => deps.attribution?.shutdown());
		},
	};
}
