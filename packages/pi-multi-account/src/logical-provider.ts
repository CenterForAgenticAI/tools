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
import { formatAccountGroupFailure, type AccountGroupFailurePolicy, type AccountGroupFailureCandidate } from "./account-group-failure.js";
import type { ManagedAccount } from "./routing.js";
import {
	isContextOverflow,
	isRetryableAssistantError,
	type AssistantMessage,
	type ProviderResponse,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { RuntimeState, isCanonicalManagedProviderId } from "./runtime-state.js";
import { hostFinalStopMessage } from "./host-final-stop-message.js";
import {
	projectPublicAssistantMessage,
	projectPublicAssistantEvent,
	projectAssistantContent,
	projectTerminalUsage,
	finiteNonNegative,
} from "./public-assistant-projection.js";
import { DEFAULT_CONFIG, MAX_ACCOUNT_LIMIT, isAccountSlotIndex } from "./config.js";
import type {
	AllowedFamily,
	CrossFamilyChain,
	ManagedFamily,
	MultiAccountConfig,
} from "./config.js";
import {
	CODEX_ERROR_CODE_SET,
	CODEX_FAILURE_KIND_SET,
	CONTEXT_OVERFLOW_REASONS,
	PROVIDER_ERROR_CODES,
	TRANSPORT_FAILURE_KINDS,
	classifyFailure,
	codexErrorCodeFromMessage,
	codexFailureKindFromMessage,
	contextOverflowReason,
	providerErrorCodeFromMessage,
	providerErrorTypeFromMessage,
	upstreamFailureKindFromMessage,
} from "./error-classification.js";
import {
	isErrorName,
	isMessageForm,
	isMessageHash,
	isNodeErrorCode,
	isProviderIdentifier,
	isReportedMessageLength,
	messageIdentifiers,
	thrownIdentifiers,
	type MessageForm,
	type MessageIdentifiers,
	type ThrownIdentifiers,
} from "./failure-identifiers.js";
import type {
	AnthropicErrorType,
	CodexErrorCode,
	CodexFailureKind,
	ContextOverflowReason,
	FailureCategory,
	ProviderErrorCode,
	ProviderFailureSignal,
	TransportFailureKind,
	UpstreamFailureKind,
} from "./error-classification.js";
import { resolveTierModel } from "./tier-model-resolver.js";
import type { TierModelMap } from "./tier-model-resolver.js";
import { providerTypeFor, tierRank, vendorForFamily } from "./vendor.js";
import type { ProviderType, Vendor } from "./vendor.js";

export { LOGICAL_PROVIDER_ID } from "./models-declaration.js";
import { LOGICAL_PROVIDER_ID } from "./models-declaration.js";
import { forceCodexSseOptions } from "./codex-adapter.js";
import { createSessionAffinity, sessionAffinityKey } from "./session-affinity.js";
import { createCacheWarmReplayRecognizer } from "./cache-warm-replay.js";
import { readImageStripPolicy, stripOldImages, type ImageStripPolicy } from "./image-strip.js";
import {
	isImageCountBucket,
	isRequestBytesBucket,
	measureSentContext,
	type ImageCountBucket,
	type OverflowSizeBuckets,
	type RequestBytesBucket,
} from "./overflow-size.js";
import {
	buildBoundedRecoveryFinalErrorMessage,
	createRecoveryEngine,
	isRecoveryStartEvent,
	isRecoveryThinkingEvent,
	type RecoveryClock,
	type RecoveryDispatchRequest,
	type RecoveryEngine,
	type RecoveryPhysicalAttempt,
	type RecoveryResult,
	type RecoveryRetrySafety,
	type RecoveryTerminationReason,
	type RecoveryTimer,
	type RecoveryTimingConfig,
} from "./recovery-engine.js";
import {
	buildRecoveryCandidatePlan,
	type RecoveryCandidate,
	type RecoveryModelCapability,
	type RecoveryPlanAccount,
} from "./recovery-plan.js";

/** Production recovery timers: monotonic time and cancellable host timers. */
const SYSTEM_RECOVERY_CLOCK: RecoveryClock = Object.freeze({
	now: () => performance.now(),
	setTimer: (delayMs: number, callback: () => void) => {
		const handle = setTimeout(callback, delayMs);
		if (typeof handle === "object" && handle !== null && "unref" in handle) {
			(handle as { unref: () => void }).unref();
		}
		return { cancel: () => clearTimeout(handle) };
	},
});

/** Fixed diagnostic label for a caller-supplied transport; never echoes the raw value. */
function codexTransportLabel(
	transport: unknown,
): "websocket" | "websocket-cached" | "auto" | "other" {
	return transport === "websocket" || transport === "websocket-cached" || transport === "auto"
		? transport
		: "other";
}

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
	/**
	 * Set when the operator removed this account from automatic routing (#137).
	 * Unified dispatch and in-call recovery never choose it; cooldown
	 * propagation and exhaustion cross-checks still see it.
	 */
	automaticRoutingExcluded?: boolean;
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

/**
 * How far the last attempt got: no `start` yet, a `start` (response headers)
 * with no content, thinking with no text or tool call, or text or a tool call
 * already seen.
 */
export type LogicalFailurePhase = "opening" | "started" | "thinking" | "streaming";

/**
 * How the last attempt ended. `error-terminal` is a provider error event;
 * `stream-threw` a thrown iterator; `dispatch-rejected` a rejected open;
 * `stalled` the stall guard; `no-terminal` a stream that ended bare;
 * `aborted` the provider's aborted terminal; `unfinished` no terminal had
 * been observed when the call ended (the engine stopped waiting).
 */
export type LogicalFailureEnding =
	| "error-terminal"
	| "stream-threw"
	| "dispatch-rejected"
	| "stalled"
	| "no-terminal"
	| "aborted"
	| "unfinished";

/** Why the call made no further send, in a closed vocabulary. */
export type LogicalFailureStop =
	| "send-cap"
	| "no-candidate"
	| "output-seen"
	| "unclassified-failure"
	| RecoveryTerminationReason;

/**
 * Closed facts about the last attempt's failure. Every member is an enum value,
 * a bounded integer, an identifier that matched a strict pattern, or a
 * truncated hash, picked from provider data. An identifier may be a
 * provider-chosen word; no message text around it is copied.
 */
export interface LogicalFailureShape {
	readonly phase: LogicalFailurePhase;
	readonly ending: LogicalFailureEnding;
	/** Whole seconds from dispatch to failure, 0 through 86400. */
	readonly elapsedSeconds: number;
	readonly stop: LogicalFailureStop;
	/** The provider's own error-envelope type, when it is on the fixed list. */
	readonly errorType?: AnthropicErrorType;
	/** A fixed upstream message that carries no envelope. */
	readonly upstream?: UpstreamFailureKind;
	/** A fixed Codex failure message, by exact text or fixed prefix only. */
	readonly codexFailure?: CodexFailureKind;
	/** A Codex error code, only when it is on the fixed list. */
	readonly codexCode?: CodexErrorCode;
	/** An HTTP status from 100 through 599. */
	readonly httpStatus?: number;
	readonly transportKind?: TransportFailureKind;
	/** The thrown value's class name, such as `TypeError`. */
	readonly errorName?: string;
	/** A Node system error code, such as `ECONNRESET`, from the thrown value or its cause. */
	readonly errorCode?: string;
	/** The provider envelope's `error.type`, when identifier-shaped and not on the fixed list. */
	readonly envelopeType?: string;
	/** The provider envelope's or Codex event's error code, when identifier-shaped. */
	readonly envelopeCode?: string;
	/** Length of a message no fixed list matched, capped at 65536. */
	readonly messageLength?: number;
	/** How a message no fixed list matched starts. */
	readonly messageForm?: MessageForm;
	/** Twelve hex characters of a hash of the normalized unmatched message. */
	readonly messageHash?: string;
}

/** Safe physical cause of a failed logical call; never contains provider prose. */
export interface LogicalFailureEvidence {
	readonly providerId?: string;
	/**
	 * `login-required` and `credential-unavailable` are evidence-only, like
	 * `context-overflow`: a dispatch that could not resolve the account's
	 * credential, with or without a terminal-auth invalidation already recorded.
	 * Neither is a routing category.
	 */
	readonly category:
		| FailureCategory
		| "context-overflow"
		| "host-stale-install"
		| "login-required"
		| "credential-unavailable";
	/** Which limit a `context-overflow` hit, from structured provider facts only. */
	readonly overflowReason?: ContextOverflowReason;
	/**
	 * Closed buckets of the context a `context-overflow` attempt sent, present
	 * when it was measured. Never an exact size, count or content.
	 */
	readonly requestBytes?: RequestBytesBucket;
	readonly imageCount?: ImageCountBucket;
	/** Physical invocations, not the unknown inner send count of Antigravity. */
	readonly attemptCount: number;
	/** Present when a physical attempt opened. */
	readonly shape?: LogicalFailureShape;
}

/**
 * Flat, named diagnostic fields for one failure. Fields are copied by name;
 * the evidence object itself never reaches the diagnostic log.
 */
export function logicalFailureDiagnosticFields(
	evidence: LogicalFailureEvidence,
): Readonly<Record<string, string | number>> {
	const { providerId, category, overflowReason, requestBytes, imageCount, attemptCount, shape } = evidence;
	return {
		...(providerId === undefined ? {} : { providerId }),
		category,
		...(overflowReason !== undefined && OVERFLOW_REASON_SET.has(overflowReason) ? { overflowReason } : {}),
		...(isRequestBytesBucket(requestBytes) ? { requestBytes } : {}),
		...(isImageCountBucket(imageCount) ? { imageCount } : {}),
		attemptCount,
		...(shape === undefined
			? {}
			: {
					phase: shape.phase,
					ending: shape.ending,
					elapsedSeconds: shape.elapsedSeconds,
					stop: shape.stop,
					...(shape.errorType === undefined ? {} : { errorType: shape.errorType }),
					...(shape.upstream === undefined ? {} : { upstream: shape.upstream }),
					...(shape.codexFailure !== undefined && CODEX_FAILURE_KIND_SET.has(shape.codexFailure)
						? { codexFailure: shape.codexFailure }
						: {}),
					...(shape.codexCode !== undefined && CODEX_ERROR_CODE_SET.has(shape.codexCode)
						? { codexCode: shape.codexCode }
						: {}),
					...(shape.httpStatus === undefined ? {} : { httpStatus: shape.httpStatus }),
					...(shape.transportKind === undefined ? {} : { transportKind: shape.transportKind }),
					...(isErrorName(shape.errorName) ? { errorName: shape.errorName } : {}),
					...(isNodeErrorCode(shape.errorCode) ? { errorCode: shape.errorCode } : {}),
					...(isProviderIdentifier(shape.envelopeType) ? { envelopeType: shape.envelopeType } : {}),
					...(isProviderIdentifier(shape.envelopeCode) ? { envelopeCode: shape.envelopeCode } : {}),
					...(isReportedMessageLength(shape.messageLength) ? { messageLength: shape.messageLength } : {}),
					...(isMessageForm(shape.messageForm) ? { messageForm: shape.messageForm } : {}),
					...(isMessageHash(shape.messageHash) ? { messageHash: shape.messageHash } : {}),
				}),
	};
}

const OVERFLOW_REASON_SET: ReadonlySet<string> = new Set(CONTEXT_OVERFLOW_REASONS);

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

/** One authorized selection generation; outside rows explain failure, never authorize sends. */
export interface LogicalSelectionSnapshot {
	readonly accounts: LogicalPhysicalAccount[];
	readonly group?: {
		readonly policy: AccountGroupFailurePolicy;
		readonly accountLimit: number;
		readonly allAccounts: readonly LogicalPhysicalAccount[];
		readonly otherCandidates: readonly AccountGroupFailureCandidate[];
	};
}

export interface LogicalProviderDeps {
	accounts: LogicalPhysicalAccount[];
	/** Capture policy and account facts together, once per selection/preflight. */
	captureSelectionSnapshot?: (modelId: string) => LogicalSelectionSnapshot;
	dispatch: (
		call: LogicalDispatchCall,
	) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
	logicalModelId?: string;
	originFamily?: AllowedFamily;
	/** Subscription-catalog owner of a declared logical model. */
	modelVendor?: (modelId: string) => Vendor | undefined;
	tierModelMap?: TierModelMap;
	/**
	 * The live `sameFamilyFailover` setting. `false` makes every unified call
	 * one attempt: the in-call recovery never moves to another account.
	 * Omitted uses the default.
	 */
	sameFamilyFailover?: boolean;
	crossFamilyChains?: readonly CrossFamilyChain[];
	onObservation?: (observation: LogicalObservation) => void;
	attribution?: LogicalAttributionLifecycle;
	/** Private session correlation for the public terminal and physical route. */
	onPublicTerminal?: (physical: AssistantMessage, publicMessage: AssistantMessage) => void;
	onDiagnostic?: (message: string) => void;
	/**
	 * A session's logical model is now served by a different account than the
	 * one that last served it. Carries provider ids only, never the session key.
	 * A sink that throws cannot change the call's result.
	 */
	onSessionAccountChange?: (change: LogicalSessionAccountChange) => void;
	/**
	 * One closed evidence record for each failed (not aborted) call. A sink that
	 * throws cannot change the call's result.
	 */
	onFailure?: (evidence: LogicalFailureEvidence) => void;
	onShutdownAbort?: () => void;
	/**
	 * A failed physical terminal the call recovered past. It was never
	 * published, so no `message_end` will carry it; the session commits its
	 * account effects here instead.
	 */
	onSupersededTerminal?: (physical: AssistantMessage) => void;
	state?: RuntimeState;
	/**
	 * Per-invocation idle and absolute limits, the per-attempt stall limit, and
	 * the per-call send cap; omitted fields use the defaults.
	 */
	recoveryTiming?: Partial<
		RecoveryTimingConfig &
			Pick<MultiAccountConfig, "recoveryStallTimeoutMs" | "recoveryMaxAttempts">
	>;
	/** Injected only by tests; production uses the system clock. */
	recoveryClock?: RecoveryClock;
	/** Injected only by tests; production uses `TRANSPORT_SILENCE_TIMEOUT_MS`. */
	transportSilenceTimeoutMs?: number;
	/** Live opt-in old-image policy (src/image-strip.ts); omitted means off. */
	imageStripping?: ImageStripPolicy | undefined;
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
	/**
	 * The account that last served a successful call for this session key and
	 * logical model, while it is still preferred (internal issue #204).
	 */
	lastServingAccount?: (sessionKey: string, modelId: string) => string | undefined;
}

/**
 * Why a session moved off the account that last served it:
 * - `recovered`: the call failed on it before output and in-call recovery served it elsewhere;
 * - `failed`: an earlier call failed on it, so it was no longer preferred;
 * - `ineligible`: it was cooling, exhausted, cleared, disabled, or outside the account group;
 * - `tier`: it is a metered API account and a subscription account is eligible again.
 */
export type LogicalSessionAccountChangeReason = "recovered" | "failed" | "ineligible" | "tier";

export interface LogicalSessionAccountChange {
	readonly modelId: string;
	readonly fromProviderId: string;
	readonly toProviderId: string;
	readonly reason: LogicalSessionAccountChangeReason;
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

/** The `message` of a thrown value, or `undefined` when it has none or reading it throws. */
function rawMessageOf(error: unknown): unknown {
	try {
		return typeof error === "object" && error !== null
			? (error as { message?: unknown }).message
			: undefined;
	} catch {
		return undefined;
	}
}

/** Codex kinds chosen by a whole fixed message, not by a prefix. */
const FULLY_NAMED_CODEX_KINDS: ReadonlySet<CodexFailureKind> = new Set<CodexFailureKind>([
	"codex-response-failed",
	"codex-no-stop-reason",
	"codex-sse-header-timeout",
	"responses-no-terminal-event",
]);

/**
 * Message identifiers for the failure shape. An envelope type or code a fixed
 * list already named is not repeated; length, form and hash are present only
 * when no fixed list named the message.
 */
function identifierFacts(
	message: MessageIdentifiers | undefined,
	named: { readonly errorType?: unknown; readonly codexCode?: unknown } | undefined,
): MessageIdentifiers {
	if (message === undefined) return {};
	const { envelopeType, envelopeCode, ...unmatched } = message;
	return {
		...(envelopeType === undefined || named?.errorType !== undefined ? {} : { envelopeType }),
		...(envelopeCode === undefined || named?.codexCode !== undefined ? {} : { envelopeCode }),
		...unmatched,
	};
}

/** Only a real HTTP status survives as failure evidence. */
function boundedHttpStatus(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
		? value
		: undefined;
}

const FAILURE_ELAPSED_MAX_SECONDS = 86_400;

function boundedElapsedSeconds(elapsedMs: number): number {
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
	return Math.min(FAILURE_ELAPSED_MAX_SECONDS, Math.floor(elapsedMs / 1000));
}

/** What the attempt recorded about its own failure, once, when it happened. */
interface FailureShapeHints {
	readonly ending: LogicalFailureEnding;
	readonly failedAtMs: number;
	readonly errorType?: AnthropicErrorType;
	readonly upstream?: UpstreamFailureKind;
	readonly codexFailure?: CodexFailureKind;
	readonly codexCode?: CodexErrorCode;
	readonly thrown?: ThrownIdentifiers;
	readonly message?: MessageIdentifiers;
}

const EXHAUSTION_LENGTH_MAX_OUTPUT_TOKENS = 1;
const EXHAUSTION_LENGTH_MIN_ALLOWANCE_TOKENS = 1_024;
const EXHAUSTION_LENGTH_ALLOWANCE_MULTIPLIER = 8;
const EXHAUSTION_LENGTH_MAX_CONTEXT_FRACTION = 0.8;
const EXHAUSTION_LENGTH_ERROR_MESSAGE = "provider returned error (usage-limit)";

/**
 * Fixed public text for a setup-shaped context overflow. The pinned host's
 * `isContextOverflow` matches it (so the host compacts and retries once) and
 * `isRetryableAssistantError` does not (so the host does not fail over).
 */
export const SETUP_CONTEXT_OVERFLOW_MESSAGE = "context_length_exceeded (provider_error)";

/** Closed visible vocabulary: `quota-rate-limit` itself would trigger host retry. */
const VISIBLE_FAILURE_CAUSES: Readonly<Record<LogicalFailureEvidence["category"], string>> = Object.freeze({
	"quota-rate-limit": "quota",
	"terminal-auth": "terminal-auth",
	"transient-auth": "transient-auth",
	permission: "permission",
	config: "config",
	transport: "transport",
	unknown: "unknown",
	"context-overflow": "context-overflow",
	"host-stale-install": "host_stale_install",
	"login-required": "login-required",
	"credential-unavailable": "credential-unavailable",
});

/**
 * Fixed public text when a credential failure left the call with no other
 * account to try. It explains a footer `attempts: 1`. Neither host retry
 * predicate matches it.
 */
export const NO_OTHER_ACCOUNT_MESSAGE = "No other account was usable for this model.";

/**
 * Fixed next-step text for a dispatch that could not resolve an account's
 * credential. Only the canonical physical provider id is interpolated, which
 * is the same id the footer already shows; no provider or credential text is.
 */
function credentialAdvice(
	cause: "login-required" | "credential-unavailable",
	providerId: string | undefined,
	subscription: boolean,
): string {
	if (!subscription) {
		return providerId === undefined
			? "Check the account's configured credential."
			: `Check the credential configured for ${providerId}.`;
	}
	if (cause === "login-required") {
		return providerId === undefined
			? "Sign in again with /login."
			: `Run /login ${providerId} to sign in again.`;
	}
	return providerId === undefined
		? "Credentials could not be resolved. If this continues, run /login."
		: `Credentials for ${providerId} could not be resolved. If this continues, run /login ${providerId}.`;
}

/** Most provider ids named in the all-invalidated sign-in advice. */
const MAX_PREINVALIDATED_LOGIN_IDS = 4;

/**
 * Fixed sign-in text for a call refused before any attempt because every
 * account in the call's own pool is already invalidated for terminal auth.
 * Only canonical provider ids from that pool are interpolated; no credential,
 * provider or error text is. Undefined when no id is a subscription account,
 * since `/login` does not apply to an API key.
 */
function preInvalidatedAdvice(providerIds: readonly string[]): string | undefined {
	if (providerIds.length === 0) return undefined;
	if (providerIds.length === 1) return `Run /login ${providerIds[0]} to sign in again.`;
	const shown = providerIds.slice(0, MAX_PREINVALIDATED_LOGIN_IDS).join(", ");
	const more = providerIds.length - MAX_PREINVALIDATED_LOGIN_IDS;
	return `Run /login for each account to sign in again: ${shown}${more > 0 ? `, and ${more} more` : ""}.`;
}

/**
 * Public text for a local host fault: the running pi process tried to load a
 * bundle chunk that an in-place upgrade replaced. No provider was reached, and
 * no other account can load the missing file, so only a restart helps. Neither
 * host retry predicate matches this text.
 */
export const HOST_STALE_INSTALL_MESSAGE =
	"pi's installed files changed while this session was running; restart the pi session to load the current install.";

/**
 * Public text when the missing module is a bare package rather than one of
 * pi's own bundle files: the dependency is absent from the install, so a
 * restart loads the same broken tree and only a reinstall helps.
 */
export const HOST_MISSING_DEPENDENCY_MESSAGE =
	"pi could not load a package it depends on; reinstall pi (or the extension that needs the package), then restart the pi session.";

/**
 * Node's own phrasing, anchored at the start: pi-ai `lazyStream` keeps
 * `error.message` unprefixed. An unanchored match would misread a provider or
 * gateway error body that quotes a module error as a local fault.
 */
const STALE_INSTALL_TEXT =
	/^(?:Error(?: \[ERR_MODULE_NOT_FOUND\])?: )?(?:Cannot find (?:module|package) |Failed to (?:fetch|load) dynamically imported module|Error loading dynamically imported module)/;

/**
 * Whether a setup failure is the host failing to load its own code, rather
 * than a provider failing. Reads the Node error code first, then the message
 * text, because pi-ai `lazyStream` keeps only `error.message`.
 */
export function isHostStaleInstallFailure(error: unknown): boolean {
	try {
		if (typeof error === "string") return STALE_INSTALL_TEXT.test(error);
		if (typeof error !== "object" || error === null) return false;
		const { code, message, errorMessage } = error as { code?: unknown; message?: unknown; errorMessage?: unknown };
		if (code === "ERR_MODULE_NOT_FOUND") return true;
		return [message, errorMessage].some((text) => typeof text === "string" && STALE_INSTALL_TEXT.test(text));
	} catch {
		return false;
	}
}

/** A recognised provider code, HTTP status or transport kind outranks any text. */
function hasStructuredFailureEvidence(failure: ProviderFailureSignal | undefined): boolean {
	return failure !== undefined &&
		(failure.code !== undefined || failure.httpStatus !== undefined || failure.transportKind !== undefined);
}

/**
 * Bounded diagnostic cause for a stale install: the Node error code and the
 * missing file's base name. Directories are dropped so no local path is kept.
 */
export function hostLoadFault(error: unknown): { cause: string; missingDependency: boolean } {
	let text = "";
	let code: unknown;
	try {
		if (typeof error === "string") text = error;
		else if (typeof error === "object" && error !== null) {
			const fields = error as { code?: unknown; message?: unknown; errorMessage?: unknown };
			code = fields.code;
			text = typeof fields.message === "string" ? fields.message : typeof fields.errorMessage === "string" ? fields.errorMessage : "";
		}
	} catch {
		// Fall through with whatever was read.
	}
	const kind = code === "ERR_MODULE_NOT_FOUND" || /ERR_MODULE_NOT_FOUND|Cannot find/.test(text) ? "ERR_MODULE_NOT_FOUND" : "dynamic-import-failed";
	// Node names the missing specifier first ("Cannot find package 'x' imported
	// from /dir/importer.js"); the importer is not what is missing.
	// Node does not escape quotes, so a path may contain one: read up to the
	// quote that ends the specifier (before " imported from", a CJS
	// ". Please verify…"/"Require stack" line, or the end of the text).
	const specifier = /Cannot find (?:module|package) '(.+?)'(?=$| imported from |\.\s|\r?\n)/.exec(text)?.[1];
	if (specifier !== undefined && specifier.length > 0) {
		if (!/^(?:\.{1,2}[\\/]|[\\/]|file:|[A-Za-z]:[\\/])/.test(specifier)) {
			// A bare specifier names a package (keep "@scope/name" or "name").
			const parts = specifier.split("/");
			const name = (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
			return { cause: `${kind} package ${name.slice(0, 120)}`, missingDependency: true };
		}
		const base = specifier.split(/[\\/]/).at(-1) ?? "";
		return { cause: base.length === 0 ? kind : `${kind} ${base.slice(0, 120)}`, missingDependency: false };
	}
	const file = /['"]?([^'"\s]*\.(?:m?js|cjs|json|node))['"]?/.exec(text)?.[1]?.split(/[\\/]/).at(-1);
	return { cause: file === undefined || file.length === 0 ? kind : `${kind} ${file.slice(0, 120)}`, missingDependency: false };
}

type SetupFailureDisposition = "context-overflow" | "retryable" | "host-final";

/**
 * How the pinned host treats the raw setup text. The host checks the two
 * predicates separately: `_handlePostAgentRun` compacts and retries once on
 * `isContextOverflow`, while `_isRetryableError` excludes overflow and fails
 * over on `isRetryableAssistantError`. An unreadable predicate result counts
 * as host-final.
 */
function setupFailureDisposition(
	message: AssistantMessage,
	raw: unknown,
): SetupFailureDisposition {
	if (typeof raw !== "string" || raw.length === 0) return "host-final";
	try {
		const probe = { ...message, errorMessage: raw };
		if (isContextOverflow(probe, 0)) return "context-overflow";
		return isRetryableAssistantError(probe) ? "retryable" : "host-final";
	} catch {
		return "host-final";
	}
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

/**
 * Whether a physical terminal is the host's setup-error shape: the first event
 * of the stream is an `error` with no content, all-zero usage, no diagnostics,
 * no structured stop code, and no structured failure evidence.
 *
 * That is what pi-ai `lazyStream` (`createSetupErrorMessage`) publishes when a
 * provider stream throws or rejects before it starts, so its `errorMessage` is
 * raw exception text, not provider-authored failure prose. The production cause
 * of the observed setup `TypeError` is not known (see UPSTREAM.md). The same
 * shape also carries transient pre-start failures ("fetch failed", a 503 before
 * `start`), so the caller decides retryability from the text, never publishes
 * it. A real provider failure that carries a recognized code or status keeps
 * its own text and routing.
 */
function isUnclassifiedSetupFailure(
	message: AssistantMessage,
	failure: ProviderFailureSignal,
): boolean {
	try {
		if (message.stopReason !== "error") return false;
		if (!Array.isArray(message.content) || message.content.length !== 0) return false;
		const diagnostics = (message as { diagnostics?: unknown }).diagnostics;
		if (diagnostics !== undefined && !(Array.isArray(diagnostics) && diagnostics.length === 0)) {
			return false;
		}
		if ((message as { code?: unknown }).code !== undefined) return false;
		const usage = projectTerminalUsage(message);
		if (
			usage === undefined ||
			usage.input !== 0 ||
			usage.output !== 0 ||
			usage.cacheRead !== 0 ||
			usage.cacheWrite !== 0 ||
			usage.totalTokens !== 0 ||
			usage.cost.total !== 0
		) {
			return false;
		}
		return (
			failure.code === undefined &&
			failure.httpStatus === undefined &&
			failure.transportKind === undefined
		);
	} catch {
		return false;
	}
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

/** Raised inside one physical attempt when its provider stops producing events. */
class PhysicalAttemptStall extends Error {
	/** Read by `projectFailureSignal`: a stall cools and classifies as a timeout. */
	readonly transportKind = "connection-timeout";
	constructor() {
		super("the provider stream stalled");
		this.name = "PhysicalAttemptStall";
	}
}

/**
 * Longest silence on a live connection, keep-alive pings included, once the
 * provider has reported transport activity. Anthropic pings roughly every 30
 * seconds while a model thinks silently, so three missed pings mean the
 * connection is gone rather than the model being slow.
 */
export const TRANSPORT_SILENCE_TIMEOUT_MS = 90_000;

interface StallGuardTiming {
	/** Until the provider's `start` event, opening included. */
	readonly timeoutMs: number;
	/** After `start` while the provider reports no transport activity. */
	readonly startedTimeoutMs: number;
	/** Without a byte once the provider has reported transport activity. */
	readonly silenceTimeoutMs: number;
}

/**
 * One physical stream, ended by `PhysicalAttemptStall` when the provider leaves
 * a single wait unanswered for too long: `timeoutMs` until the provider's
 * `start` event (opening included), then `startedTimeoutMs`.
 *
 * After `start` the server has answered and keeps the connection alive with
 * pings the event stream never surfaces. A model that thinks silently (omitted
 * thinking display, interleaved thinking) can leave several minutes between
 * two events, so the short limit would abort a healthy request.
 *
 * A provider that reports transport activity (`activity`, called for every
 * response chunk including pings) proves liveness directly: each report
 * restarts the current wait, and after the first report a silence longer than
 * `silenceTimeoutMs` ends the attempt. A connection that died after `start`
 * is then caught in seconds instead of at the whole-call limit.
 *
 * The timer runs only while this wrapper waits on the provider, so a slow
 * consumer never counts as a stall. `onStall` aborts the physical request
 * before the stall is raised; the abandoned source is closed without waiting.
 */
function stallGuarded(
	open: () => Promise<AsyncIterable<unknown>>,
	timing: StallGuardTiming,
	clock: RecoveryClock,
	onStall: () => void,
): { readonly output: AsyncIterable<unknown>; readonly activity: () => void } {
	let started = false;
	let reportsActivity = false;
	let rearm: (() => void) | undefined;
	const limit = (): number => {
		const phaseLimit = started ? timing.startedTimeoutMs : timing.timeoutMs;
		return reportsActivity ? Math.min(timing.silenceTimeoutMs, phaseLimit) : phaseLimit;
	};
	const activity = (): void => {
		reportsActivity = true;
		rearm?.();
	};
	const output: AsyncIterable<unknown> = {
		async *[Symbol.asyncIterator]() {
			let iterator: AsyncIterator<unknown> | undefined;
			let finished = false;
			const guarded = async <T>(pending: Promise<T>): Promise<T> => {
				void pending.catch(() => {});
				let timer: RecoveryTimer | undefined;
				let fail!: (error: PhysicalAttemptStall) => void;
				const stalled = new Promise<never>((_resolve, reject) => {
					fail = reject;
				});
				void stalled.catch(() => {});
				const arm = (): void => {
					timer?.cancel();
					timer = clock.setTimer(limit(), () => {
						rearm = undefined;
						try {
							onStall();
						} finally {
							fail(new PhysicalAttemptStall());
						}
					});
				};
				arm();
				rearm = arm;
				try {
					return await Promise.race([pending, stalled]);
				} finally {
					if (rearm === arm) rearm = undefined;
					timer?.cancel();
				}
			};
			try {
				const source = await guarded(open());
				iterator = source[Symbol.asyncIterator]();
				for (;;) {
					const step = await guarded(iterator.next());
					if (step.done === true) {
						finished = true;
						return;
					}
					if (isRecoveryStartEvent(step.value)) started = true;
					yield step.value;
				}
			} finally {
				if (!finished && iterator !== undefined) {
					try {
						void Promise.resolve(iterator.return?.()).catch(() => {});
					} catch {
						// The abandoned source is already aborted.
					}
				}
			}
		},
	};
	return { output, activity };
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
	let codexTransportNoticeSent = false;
	let shutDown = false;
	/** Aborts every physical request, including attempts the engine handed over. */
	const shutdownController = new AbortController();

	const diagnose = (message: string): void => {
		deps.onDiagnostic?.(message);
	};

	const affinity = createSessionAffinity();
	const warmReplays = createCacheWarmReplayRecognizer();

	const selectAccount = (
		modelId: string,
		sessionKey?: string,
		/** Accounts a concurrent call already claimed the invalidation probe for. */
		skipProviderIds?: ReadonlySet<string>,
	): LogicalServingAccount & { readonly displaced?: "ineligible" | "tier" } => {
		const snapshot = deps.captureSelectionSnapshot?.(modelId);
		const accounts = snapshot?.accounts ?? deps.accounts;
		const tierModelMap = deps.tierModelMap ?? DEFAULT_CONFIG.tierModelMap;
		const nowMs = Date.now();
		const failureMessage = (fallback: string): string => {
			const group = snapshot?.group;
			if (group === undefined) return fallback;
			const candidates = group.allAccounts.map((account): AccountGroupFailureCandidate => ({
				providerId: account.providerId,
				servesModel: modelVendor !== undefined && vendorForFamily(account.family) === modelVendor && resolveLogicalServingAccount(account, modelId, tierModelMap) !== undefined,
				eligible: account.automaticRoutingExcluded !== true && logicalAccountEligible(account, coordinator.state, nowMs),
				...(account.authenticated === undefined ? {} : { authenticated: account.authenticated }),
				...(account.exhausted === undefined ? {} : { exhausted: account.exhausted }),
				coolingDown: coordinator.state.peekCooldown(account.providerId, nowMs) !== undefined,
				invalidated: coordinator.state.getInvalidation(account.providerId) !== undefined,
				usageDistrusted: coordinator.state.peekUsageSnapshotUntrusted(account.providerId, nowMs),
			}));
			return formatAccountGroupFailure({ policy: group.policy, modelId, accountLimit: group.accountLimit, candidates: [...candidates, ...group.otherCandidates] })?.message ?? fallback;
		};
		const subscriptionVendors = new Set(
			accounts
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
				failureMessage(`no managed account serves the exact model id ${modelId}`),
			);
		}

		const serving = accounts.flatMap((account) => {
			if (vendorForFamily(account.family) !== modelVendor) return [];
			const resolved = resolveLogicalServingAccount(account, modelId, tierModelMap);
			return resolved === undefined ? [] : [resolved];
		});
		if (serving.length === 0) {
			// Refusal, not substitution. This is also the load-bearing half of the
			// exact-identity contract: a virtual id that is neither exact nor explicitly
			// mapped to a catalog member must never reach a physical provider.
			throw new Error(
				failureMessage(`no managed account serves the exact model id ${modelId}`),
			);
		}
		// The operator's automatic-routing opt-out (#137) removes accounts from
		// the pool before eligibility, so an excluded account is never chosen even
		// when it is the only healthy one. Refuse with that reason, not a generic
		// ineligible one, when the opt-out leaves nothing.
		const automatic = serving.filter(
			({ account }) => account.automaticRoutingExcluded !== true,
		);
		if (automatic.length === 0) {
			throw new Error(
				failureMessage(
					`every managed account serving ${modelId} is excluded from automatic routing`,
				),
			);
		}

		// Physical OpenAI subscription (`openai-codex`) and owning-vendor API
		// (`openai`) accounts are one routing family: vendor `openai`. Ownership is
		// fixed from the declared subscription catalog before API exact/map matches are
		// admitted, so another vendor's API catalog cannot make a row ambiguous.
		const eligible = automatic.filter(
			({ account }) =>
				skipProviderIds?.has(account.providerId) !== true &&
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
					// A due terminal-auth invalidation is selectable so that one probe
					// can clear it (#227). Selection only reads; the claim is below.
					"probe-if-due",
				),
		);
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
			//
			// When a terminal-auth invalidation already explains every account in
			// the call's own pool (`automatic`, which is policy-scoped and already
			// drops opted-out accounts), say so and name the sign-in. A cooldown, an
			// exhaustion or a missing credential is never read as a login need, and
			// one account that may still recover by itself keeps the generic text.
			const allInvalidated = automatic.every(
				({ account }) => coordinator.state.getInvalidation(account.providerId) !== undefined,
			);
			const advice = allInvalidated
				? preInvalidatedAdvice(
						automatic
							.filter(({ account }) => logicalProviderType(account) === "subscription")
							.map(({ account }) => account.providerId),
					)
				: undefined;
			const base = failureMessage(`every managed account serving ${modelId} is currently ineligible`);
			throw new Error(advice === undefined ? base : `${base} ${advice}`);
		}
		// Session affinity (internal issue #204) only reorders the eligible accounts
		// of the best eligible tier: a session keeps the account that last served it
		// rather than rebuilding its prompt cache elsewhere, but never stays on a
		// metered API account once a subscription account is eligible.
		const remembered =
			sessionKey === undefined ? undefined : affinity.lastServingAccount(sessionKey, modelId);
		if (remembered === undefined) return chosen;
		const rememberedServing = eligible.find(({ account }) => account.providerId === remembered);
		if (rememberedServing === undefined) return { ...chosen, displaced: "ineligible" };
		return tierRank(logicalProviderType(rememberedServing.account)) ===
			tierRank(logicalProviderType(chosen.account))
			? rememberedServing
			: { ...chosen, displaced: "tier" };
	};

	/**
	 * Remember which account served this session's call, or that the call failed
	 * on the accounts it used. Only a published terminal counts, so an aborted
	 * call and a structured refusal or unknown stop change nothing.
	 */
	const noteSessionOutcome = (
		sessionKey: string,
		modelId: string,
		selected: { readonly displaced?: "ineligible" | "tier" },
		boxes: readonly { readonly account: LogicalPhysicalAccount; readonly physicalTerminal?: AssistantMessage }[],
		event: unknown,
	): void => {
		const last = boxes.at(-1);
		if (last === undefined || typeof event !== "object" || event === null) return;
		const { type, reason, message } = event as { type?: unknown; reason?: unknown; message?: unknown };
		if (type === "error" && reason === "error") {
			if (last.physicalTerminal !== undefined && hostFinalStopMessage(last.physicalTerminal) !== undefined) return;
			for (const box of boxes) affinity.recordFailed(sessionKey, modelId, box.account.providerId);
			return;
		}
		const stopReason = (message as { stopReason?: unknown } | undefined)?.stopReason;
		if (type !== "done" || stopReason === "error" || stopReason === "aborted") return;
		const servedBy = last.account.providerId;
		const previous = affinity.recordServed(sessionKey, modelId, servedBy);
		if (previous === undefined || previous.providerId === servedBy) return;
		const change: LogicalSessionAccountChange = Object.freeze({
			modelId,
			fromProviderId: previous.providerId,
			toProviderId: servedBy,
			reason:
				boxes.length > 1 && boxes[0]?.account.providerId === previous.providerId
					? "recovered"
					: previous.failed
						? "failed"
						: (selected.displaced ?? "ineligible"),
		});
		try {
			deps.onSessionAccountChange?.(change);
		} catch {
			// A change sink cannot replace a provider result.
		}
	};

	/**
	 * The terminal a physical event carries, if any.
	 *
	 * A provider can accept a request, return 200, and fail part-way through the
	 * stream (Anthropic emits `event: error` that way). That failure is exactly as
	 * real as a rejected dispatch, so it records exactly the same cooldown before
	 * the engine decides whether the call may move to another account.
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

	/**
	 * In-call retry safety for one failed physical terminal.
	 *
	 * Only an account-local quota, authentication or rate-limit failure may move
	 * the call to another account serving the same model. A structured refusal or
	 * unknown stop, an invalid request, a context overflow and every unclassified
	 * failure end the call. The classification reads structured fields only.
	 */
	/**
	 * Record a local host fault: no provider was reached, so the account is not
	 * cooled. The bounded cause goes to the diagnostic sink, never to the reply.
	 */
	const markHostStaleInstall = (
		box: AttemptRecordBox,
		account: LogicalPhysicalAccount,
		cause: unknown,
	): void => {
		const fault = hostLoadFault(cause);
		box.hostStaleInstall = true;
		box.hostMissingDependency = fault.missingDependency;
		box.overflow = false;
		box.overflowReason = undefined;
		box.overflowSize = undefined;
		box.preStartRetryable = false;
		try {
			deps.onDiagnostic?.(
				`logical dispatch for ${account.providerId} failed loading host code (host_stale_install: ` +
					`${fault.cause}); ${fault.missingDependency ? "reinstall the missing package" : "restart the pi session"}`,
			);
		} catch {
			// A diagnostic sink failure cannot replace a provider result.
		}
	};
	/** The account did nothing wrong; report it as handled so nothing cools it. */
	const hostFaultReceipt = (): HostRetryCooldownReceipt => ({ alreadyCooled: true, rollback: () => {} });

	/**
	 * Whether the attempt produced text or a tool call: nothing after it is ever
	 * sent again. Thinking alone is not output.
	 */
	const attemptHadOutput = (box: AttemptRecordBox): boolean => {
		const content = box.physicalTerminal?.content;
		return (
			box.sawOutput ||
			(Array.isArray(content) &&
				content.some((block) => (block as { type?: unknown } | null)?.type !== "thinking"))
		);
	};

	/**
	 * Keep the closed facts of how an attempt failed, once. The provider's own
	 * text is read here only to pick enum values, identifier-shaped tokens and,
	 * when no fixed list names it, a length, form and truncated hash. The text
	 * itself is never stored. `thrown` is the value the attempt threw, if any.
	 */
	const noteFailureShape = (
		box: AttemptRecordBox,
		ending: LogicalFailureEnding,
		raw?: unknown,
		thrown?: unknown,
	): void => {
		if (box.shapeHints !== undefined) return;
		const errorType = providerErrorTypeFromMessage(raw);
		const upstream = upstreamFailureKindFromMessage(raw);
		const codexFailure = codexFailureKindFromMessage(raw);
		const codexCode = codexErrorCodeFromMessage(raw);
		// A prefix-only Codex kind leaves its tail unnamed, so it still gets a hash.
		const matched =
			errorType !== undefined ||
			upstream !== undefined ||
			codexCode !== undefined ||
			(codexFailure !== undefined && FULLY_NAMED_CODEX_KINDS.has(codexFailure));
		box.shapeHints = {
			ending,
			failedAtMs: box.clock.now(),
			...(errorType === undefined ? {} : { errorType }),
			...(upstream === undefined ? {} : { upstream }),
			...(codexFailure === undefined ? {} : { codexFailure }),
			...(codexCode === undefined ? {} : { codexCode }),
			...(thrown === undefined ? {} : { thrown: thrownIdentifiers(thrown) }),
			message: messageIdentifiers(raw, !matched),
		};
	};

	/**
	 * Record whether an attempt overflowed and, from structured facts only,
	 * which limit it hit. Only the closed sub-reason is kept, never the source.
	 * An overflow also measures the context the attempt sent, into closed buckets.
	 */
	const noteOverflow = (box: AttemptRecordBox, overflow: boolean, source: unknown): void => {
		box.overflow = overflow;
		box.overflowReason = overflow ? contextOverflowReason(source) : undefined;
		box.overflowSize = overflow ? measureSentContext(box.sentContext) : undefined;
	};

	const retrySafetyFor = (box: AttemptRecordBox): RecoveryRetrySafety => {
		const { physicalTerminal: message, failure, overflow } = box;
		if (box.invalidated) return { status: "unsafe", reason: "unknown" };
		// Every same-family account loads the same missing host chunk: another send cannot help.
		if (box.hostStaleInstall === true) return { status: "unsafe", reason: "unknown" };
		const code = (message as { code?: unknown } | undefined)?.code;
		if (code === "refusal") return { status: "unsafe", reason: "refusal" };
		if (code === "unknown_stop") return { status: "unsafe", reason: "unknown" };
		if (overflow) return { status: "unsafe", reason: "invalid-request" };
		// Nothing after any output is ever sent again; the engine enforces the
		// same rule from the events it observed.
		if (attemptHadOutput(box)) return { status: "unsafe", reason: "unknown" };
		if (failure === undefined) return { status: "unsafe", reason: "unknown" };
		const afterThinking = box.sawThinking;
		const category = classifyFailure(failure).category;
		if (category === "quota-rate-limit") {
			return {
				status: "recoverable",
				action: "account",
				reason:
					failure.code === "quota_exhausted"
						? "account-local-quota"
						: "account-local-rate-limit",
			};
		}
		if (category === "terminal-auth" || category === "transient-auth") {
			return { status: "recoverable", action: "account", reason: "account-local-auth" };
		}
		if (category === "config") return { status: "unsafe", reason: "invalid-request" };
		// Thinking is held until the first text or tool call, so the consumer has
		// seen nothing and one other account may serve the same request.
		if (afterThinking) return { status: "recoverable", action: "account", reason: "thinking-only-failure" };
		if (category === "transport" || box.preStartRetryable) {
			// A network or server failure before any content: the provider never
			// produced output, so one other account may serve the same request.
			return { status: "recoverable", action: "account", reason: "pre-start-transient" };
		}
		return { status: "unsafe", reason: "unknown" };
	};

	const projectMessage = (message: AssistantMessage, modelId: string): AssistantMessage =>
		projectPublicAssistantMessage(message, { api: LOGICAL_PROVIDER_ID, provider: LOGICAL_PROVIDER_ID, model: modelId });

	const projectEvent = (event: unknown, modelId: string): unknown =>
		projectPublicAssistantEvent(event, { api: LOGICAL_PROVIDER_ID, provider: LOGICAL_PROVIDER_ID, model: modelId });

	/** Outcome of one private physical attempt, recorded for the logical call. */
	interface AttemptRecordBox {
		readonly ordinal: number;
		physicalTerminal?: AssistantMessage;
		failure?: ProviderFailureSignal;
		overflow: boolean;
		/** The closed overflow sub-reason, set with `overflow`. */
		overflowReason?: ContextOverflowReason | undefined;
		/**
		 * The context this attempt dispatched, held only until the attempt ends so
		 * an overflow can be measured. It is read, never changed.
		 */
		sentContext?: unknown;
		/** Closed size buckets of `sentContext`, set with `overflow`. */
		overflowSize?: OverflowSizeBuckets | undefined;
		/**
		 * A non-terminal event other than `start` reached the engine; nothing
		 * after it is resent. The provider's `start` only reports that response
		 * headers arrived, so it is not output.
		 */
		sawOutput: boolean;
		/**
		 * Thinking reached the engine. The engine holds it until the first text
		 * or tool call, so it is not output: a failure after thinking alone may
		 * still be sent once more.
		 */
		sawThinking: boolean;
		/**
		 * The attempt's first `start`, held by the engine until the first content.
		 * A successful terminal with no content publishes this exact event.
		 */
		heldStart?: unknown;
		/** A setup-shaped first terminal whose raw text the host would retry. */
		preStartRetryable: boolean;
		/**
		 * The dispatch itself could not resolve a credential for this account
		 * (its own `credential_unresolved` code), and whether runtime state had
		 * already invalidated the account for terminal auth when it failed. Set
		 * only from a rejected open, never from a provider terminal, so
		 * provider-authored fields cannot select the login advice.
		 */
		credentialUnresolved?: "login-required" | "credential-unavailable";
		/** Setup failed because this pi process could not load its own code. */
		hostStaleInstall?: boolean;
		/** The missing module is a bare package, so a reinstall, not a restart, helps. */
		hostMissingDependency?: boolean;
		/** Whether the caller or provider shutdown aborted this physical request. */
		cancelled?: () => boolean;
		/**
		 * The session invalidated this attempt before its terminal (fresh input or
		 * an operator stop, reset or enable): its cooldown was rolled back, so it
		 * must end the call rather than buy another send.
		 */
		invalidated: boolean;

		receipt?: HostRetryCooldownReceipt;
		attempt: LogicalAttributionAttempt;
		account: LogicalPhysicalAccount;
		/** The call's clock and this attempt's dispatch time, for the failure's elapsed seconds. */
		readonly clock: RecoveryClock;
		readonly dispatchedAtMs: number;
		/** How this attempt's failure ended; set once, when the failure is recorded. */
		shapeHints?: FailureShapeHints;
	}

	/**
	 * Observe one physical attempt privately.
	 *
	 * Every event is forwarded unchanged to the engine's accepted-output buffer,
	 * which publishes nothing until a successful terminal. A failure records the
	 * account cooldown before the engine decides whether to recover, so the second
	 * attempt never reselects the failing account. A stream that runs out without
	 * a terminal yields one synthetic error terminal instead of hanging.
	 */
	const observePhysicalAttempt = (
		stream: AsyncIterable<unknown>,
		model: unknown,
		options: SimpleStreamOptions | undefined,
		box: AttemptRecordBox,
		requestedModelId: string,
		dispatchedModelId: string,
	): AsyncIterable<unknown> => ({
		async *[Symbol.asyncIterator]() {
			const { account, attempt } = box;
			let sawTerminal = false;
			// Whether any event other than a leading `start` arrived. A `start`
			// only reports that response headers arrived, so a failure after it is
			// still the stream's first real event. Every other non-terminal event
			// is output (it also sets `box.sawOutput`), and a terminal ends the
			// loop, so on the thrown path `!sawEvent` means "no content yet": this
			// is the signal the setup-only classifications key on.
			let sawEvent = false;
			const recordFailureOnce = (error: unknown): HostRetryCooldownReceipt => {
				if (box.hostStaleInstall === true) box.receipt ??= hostFaultReceipt();
				box.receipt ??= coordinator.recordFailure({
					account,
					requestedModelId,
					dispatchedModelId,
					error,
				});
				return box.receipt;
			};
			const attributeFailure = (
				message: AssistantMessage,
				failure: ProviderFailureSignal,
				ending: LogicalFailureEnding,
				raw?: unknown,
				thrown?: unknown,
			): void => {
				noteFailureShape(box, ending, raw, thrown);
				const receipt = recordFailureOnce(message);
				box.failure = failure;
				box.physicalTerminal = message;
				try {
					const accepted = attempt.fail(message, {
						alreadyCooled: receipt.alreadyCooled,
						dispatchedModelId,
						failure,
						...(receipt.alreadyCooled ? { rollbackCooldown: receipt.rollback } : {}),
					});
					if (accepted === false && deps.attribution !== undefined) {
						receipt.rollback();
						box.invalidated = true;
					}
				} catch {
					if (deps.attribution !== undefined) {
						receipt.rollback();
						box.invalidated = true;
					}
				}
			};
			try {
				for await (const event of stream) {
					if (!sawEvent && isRecoveryStartEvent(event)) {
						box.heldStart ??= event;
						yield event;
						continue;
					}
					const firstEvent = !sawEvent;
					sawEvent = true;
					const terminal = terminalAttribution(event);
					if (terminal === undefined) {
						if (isRecoveryThinkingEvent(event)) box.sawThinking = true;
						else box.sawOutput = true;
						yield event;
						continue;
					}
					sawTerminal = true;
					const { message, outcome } = terminal;
					if (message === box.physicalTerminal) {
						// A rejected dispatch: its private terminal was already cooled,
						// attributed and classified from the thrown error itself.
						yield event;
						return;
					}
					if (outcome === "finish") {
						const match = exhaustionLengthMatch({
							message,
							model,
							options,
							account,
							currentAccounts: () => deps.accounts,
						});
						if (match !== undefined) {
							// A corroborated subscription-exhaustion length terminal is an
							// account-local quota failure, never an accepted answer.
							const replacement = exhaustionLengthError(requestedModelId, match);
							attributeFailure(replacement, safeProjectFailureSignal(replacement, dispatchedModelId), "error-terminal");
							await attempt.waitForTerminal();
							yield { type: "error", reason: "error", error: replacement };
							return;
						}
						box.physicalTerminal = message;
						safeAttributionCall(() => attempt.finish(message));
						await attempt.waitForTerminal();
						yield event;
						return;
					}
					if (outcome === "abort") {
						noteFailureShape(box, "aborted");
						box.physicalTerminal = message;
						safeAttributionCall(() => attempt.abort(message));
						await attempt.waitForTerminal();
						yield event;
						return;
					}
					const failure = safeProjectFailureSignal(message, dispatchedModelId);
					if (firstEvent && isUnclassifiedSetupFailure(message, failure) && isHostStaleInstallFailure(message)) {
						markHostStaleInstall(box, account, message.errorMessage);
					} else if (firstEvent && isUnclassifiedSetupFailure(message, failure)) {
						// The raw setup text never leaves this attempt. Only its overflow
						// form changes the outcome: the host must still compact.
						const disposition = setupFailureDisposition(message, message.errorMessage);
						noteOverflow(box, disposition === "context-overflow", message);
						// "fetch failed", a reset socket or a 503 before `start`: nothing
						// was produced, so one other account may serve the request.
						box.preStartRetryable = disposition === "retryable";
						try {
							deps.onDiagnostic?.(
								`logical dispatch for ${account.providerId} failed during stream setup; ` +
									"the raw setup error was not published",
							);
						} catch {
							// A diagnostic sink failure cannot replace a provider result.
						}
					} else if (setupFailureDisposition(message, message.errorMessage) === "context-overflow") {
						noteOverflow(box, (message as { code?: unknown }).code === undefined, message);
					}
					attributeFailure(message, failure, "error-terminal", message.errorMessage);
					await attempt.waitForTerminal();
					yield event;
					return;
				}
			} catch (error) {
				// A thrown stream failure becomes this attempt's own private terminal,
				// so it is attributed and accounted exactly like an error event.
				if (
					box.physicalTerminal === undefined &&
					!sawEvent &&
					!hasStructuredFailureEvidence(safeProjectFailureSignal(error, dispatchedModelId)) &&
					isHostStaleInstallFailure(error)
				) {
					markHostStaleInstall(box, account, error);
				}
				recordFailureOnce(error);
				if (box.hostStaleInstall === true) {
					// Already classified above; no provider disposition applies.
				} else if (box.physicalTerminal === undefined && !sawEvent) {
					// Thrown before any content (a reset socket after the response
					// headers, say): read like a failure while opening the stream.
					const raw =
						typeof error === "object" && error !== null
							? (error as { message?: unknown }).message
							: undefined;
					const disposition = setupFailureDisposition(
						syntheticErrorMessage(requestedModelId, buildBoundedRecoveryFinalErrorMessage()),
						raw,
					);
					noteOverflow(box, disposition === "context-overflow", error);
					box.preStartRetryable = disposition === "retryable";
				}
				if (box.physicalTerminal === undefined) {
					const stalled = error instanceof PhysicalAttemptStall;
					attributeFailure(
						syntheticErrorMessage(requestedModelId, buildBoundedRecoveryFinalErrorMessage()),
						safeProjectFailureSignal(error, dispatchedModelId),
						stalled ? "stalled" : "stream-threw",
						// A stall is this extension's own timeout, not provider evidence.
						stalled ? undefined : rawMessageOf(error),
						stalled ? undefined : error,
					);
				}
				throw error;
			}
			if (sawTerminal) return;
			try {
				deps.onDiagnostic?.(
					`logical dispatch stream for ${account.providerId} ended with no terminal event; ` +
						"reporting a synthetic failure so the turn cannot hang",
				);
			} catch {
				// A diagnostic sink failure cannot replace a provider result.
			}
			const syntheticMessage = syntheticErrorMessage(
				requestedModelId,
				"the dispatched stream ended without a terminal event",
			);
			noteFailureShape(box, "no-terminal");
			box.physicalTerminal = syntheticMessage;
			safeAttributionCall(() => attempt.fail(syntheticMessage));
			await attempt.waitForTerminal();
			yield { type: "error", reason: "error", error: syntheticMessage };
		},
	});

	/** Build the request-local engine candidates for one logical call. */
	const recoveryCandidates = (
		modelId: string,
		selected: LogicalServingAccount,
	): readonly RecoveryCandidate[] => {
		const nowMs = Date.now();
		const tierModelMap = deps.tierModelMap ?? DEFAULT_CONFIG.tierModelMap;
		const vendor = vendorForFamily(selected.account.family);
		const capability = (id: string): RecoveryModelCapability => ({
			modelId: id,
			input: [],
			supportsTools: true,
			contextWindow: 1,
		});
		const planAccount = (
			account: LogicalPhysicalAccount,
			modelIds: readonly string[],
		): RecoveryPlanAccount => ({
			providerId: account.providerId,
			family: account.family,
			providerType: logicalProviderType(account),
			eligible:
				account.providerId === selected.account.providerId ||
				logicalAccountEligible(
					{
						providerId: account.providerId,
						exhausted: account.exhausted,
						authenticated: account.authenticated,
					},
					coordinator.state,
					nowMs,
				),
			models: modelIds.map(capability),
		});
		const originFamily: AllowedFamily =
			selected.account.family === "openai" ? "openai-codex" : selected.account.family;
		if (selected.resolvedModelId !== modelId) {
			// An operator tier map routes this call to a different physical id. That
			// is one non-recoverable attempt: the plan admits only the selected pair.
			return buildRecoveryCandidatePlan({
				selectedModelId: selected.resolvedModelId,
				originFamily,
				accounts: [planAccount(selected.account, [selected.resolvedModelId])],
				config: {
					sameFamilyFailover: true,
					crossFamilyChainEnabled: false,
					crossFamilyChains: [],
					preferredModels: {},
					tierModelMap: {},
				},
				requiredInput: [],
				requiresTools: false,
			});
		}
		// Same vendor only, exact model only: the one recovery action in this slice
		// is another account serving the selected model. An account the operator
		// excluded from automatic routing (#137) is never a recovery target.
		const accounts = deps.accounts
			.filter(
				(account) =>
					(account.automaticRoutingExcluded !== true ||
						account.providerId === selected.account.providerId) &&
					vendorForFamily(account.family) === vendor &&
					resolveLogicalServingAccount(account, modelId, tierModelMap)?.resolvedModelId === modelId,
			)
			.map((account) => planAccount(account, [modelId]));
		const ordered = [
			...accounts.filter(({ providerId }) => providerId === selected.account.providerId),
			...accounts.filter(({ providerId }) => providerId !== selected.account.providerId),
		];
		// With same-family failover off, only the selected account is planned:
		// the call is one attempt.
		const sameFamilyFailover =
			deps.sameFamilyFailover ?? DEFAULT_CONFIG.sameFamilyFailover;
		const plan = buildRecoveryCandidatePlan({
			selectedModelId: modelId,
			originFamily,
			accounts: sameFamilyFailover
				? ordered
				: ordered.filter(({ providerId }) => providerId === selected.account.providerId),
			config: {
				sameFamilyFailover: true,
				crossFamilyChainEnabled: false,
				crossFamilyChains: [],
				preferredModels: {},
				tierModelMap: {},
			},
			requiredInput: [],
			requiresTools: false,
		});
		// The selected account leads: it is the initial send.
		return [
			...plan.filter(({ providerId }) => providerId === selected.account.providerId),
			...plan.filter(({ providerId }) => providerId !== selected.account.providerId),
		];
	};

	const activeEngines = new Set<RecoveryEngine>();

	/**
	 * Open one physical attempt for the engine.
	 *
	 * A rejected dispatch is converted into one private error terminal so its
	 * failure is classified exactly like a stream failure. The retry-safety
	 * promise settles once the private attempt ends, from structured facts only.
	 */
	const physicalAttempt = (input: {
		readonly request: RecoveryDispatchRequest;
		readonly account: LogicalPhysicalAccount;
		readonly model: unknown;
		readonly context: unknown;
		readonly callerOptions: SimpleStreamOptions | undefined;
		readonly requestedModelId: string;
		readonly box: AttemptRecordBox;
		readonly clock: RecoveryClock;
		readonly stallTimeoutMs: number;
		readonly startedStallTimeoutMs: number;
		readonly transportSilenceTimeoutMs: number;
	}): RecoveryPhysicalAttempt => {
		const { request, account, box, requestedModelId } = input;
		const dispatchedModelId = request.candidate.modelId;
		let settleSafety!: (safety: RecoveryRetrySafety) => void;
		const retrySafety = new Promise<RecoveryRetrySafety>((resolve) => {
			settleSafety = resolve;
		});
		const settle = (): void => settleSafety(retrySafetyFor(box));
		request.signal.addEventListener("abort", settle, { once: true });
		// The physical request outlives the engine once the attempt commits, so it
		// also listens to the caller and to provider shutdown directly.
		const physicalController = new AbortController();
		const abortPhysical = (): void => physicalController.abort();
		const abortSources = [request.signal, input.callerOptions?.signal, shutdownController.signal]
			.filter((signal): signal is AbortSignal => signal !== undefined);
		for (const signal of abortSources) {
			if (signal.aborted) abortPhysical();
			else signal.addEventListener("abort", abortPhysical, { once: true });
		}
		box.cancelled = () =>
			input.callerOptions?.signal?.aborted === true || shutdownController.signal.aborted;
		// Idempotent. Runs at the attempt's terminal as well as in the output's
		// finally: a consumer may abandon a committed stream after its terminal
		// without ever returning the iterator, and the session-lifetime shutdown
		// signal must not keep this attempt's listener.
		let released = false;
		const releaseAbortSources = (): void => {
			if (released) return;
			released = true;
			box.sentContext = undefined;
			request.signal.removeEventListener("abort", settle);
			for (const signal of abortSources) signal.removeEventListener("abort", abortPhysical);
		};
		const { attempt } = box;
		const originalOnPayload = input.callerOptions?.onPayload;
		const originalOnResponse = input.callerOptions?.onResponse;
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
		// The engine-bound options carry `maxRetries: 0` and, for Codex only, the
		// forced SSE transport; every other caller field passes through unchanged.
		const physicalOptions: SimpleStreamOptions = {
			...request.options,
			signal: physicalController.signal,
			onPayload: wrappedOnPayload,
			onResponse: wrappedOnResponse,
		};
		// Bound after the stall guard exists. Anthropic streams call it for every
		// response chunk, pings included; other providers ignore the field.
		let reportTransportActivity: () => void = () => {};
		const originalOnTransportActivity = (
			input.callerOptions as { onTransportActivity?: unknown } | undefined
		)?.onTransportActivity;
		(physicalOptions as { onTransportActivity?: () => void }).onTransportActivity = () => {
			reportTransportActivity();
			if (typeof originalOnTransportActivity === "function") {
				try {
					(originalOnTransportActivity as () => void)();
				} catch {
					// A caller's liveness hook cannot break the physical attempt.
				}
			}
		};
		// A base provider id equals its family token (`anthropic`,
		// `openai-codex`). Base-provider requests stay byte-identical whatever
		// the policy, so only numbered aliases get the stripped copy.
		const physicalContext =
			account.providerId === account.family
				? input.context
				: stripOldImages(input.context, readImageStripPolicy(() => deps.imageStripping));
		box.sentContext = physicalContext;
		const open = async (): Promise<AsyncIterable<unknown>> => {
			try {
				return await deps.dispatch({
					providerId: account.providerId,
					modelId: dispatchedModelId,
					context: physicalContext,
					options: physicalOptions,
				});
			} catch (error) {
				// Cool synchronously, then surface the rejection as a private terminal
				// so classification and attribution match a stream failure.
				const syntheticMessage = syntheticErrorMessage(
					requestedModelId,
					buildBoundedRecoveryFinalErrorMessage(),
				);
				box.failure = safeProjectFailureSignal(error, dispatchedModelId);
				// The dispatch's own code, read from the projected signal. An account
				// the warmer or settlement already invalidated needs a real login;
				// any other unresolved credential may clear by itself.
				if (box.failure.code === "credential_unresolved") {
					box.credentialUnresolved =
						coordinator.state.getInvalidation(account.providerId) === undefined
							? "credential-unavailable"
							: "login-required";
				}
				noteFailureShape(box, "dispatch-rejected", rawMessageOf(error), error);
				if (!hasStructuredFailureEvidence(box.failure) && isHostStaleInstallFailure(error)) {
					markHostStaleInstall(box, account, error);
					box.receipt = hostFaultReceipt();
				} else {
					const raw =
						typeof error === "object" && error !== null
							? (error as { message?: unknown }).message
							: undefined;
					const disposition = setupFailureDisposition(syntheticMessage, raw);
					noteOverflow(box, disposition === "context-overflow", error);
					box.preStartRetryable = disposition === "retryable";
					box.receipt = coordinator.recordFailure({
						account,
						requestedModelId,
						dispatchedModelId,
						error,
					});
				}
				box.physicalTerminal = syntheticMessage;
				const receipt = box.receipt;
				try {
					const accepted = attempt.fail(syntheticMessage, {
						alreadyCooled: receipt.alreadyCooled,
						dispatchedModelId,
						failure: box.failure,
						...(receipt.alreadyCooled ? { rollbackCooldown: receipt.rollback } : {}),
					});
					if (accepted === false && deps.attribution !== undefined) {
						receipt.rollback();
						box.invalidated = true;
					}
				} catch {
					if (deps.attribution !== undefined) {
						receipt.rollback();
						box.invalidated = true;
					}
				}
				return (async function* () {
					await attempt.waitForTerminal();
					yield { type: "error", reason: "error", error: syntheticMessage };
				})();
			}
		};
		// The short stall limit covers opening and the wait for `start`; every
		// later wait uses the longer started limit, or the transport silence limit
		// once the provider reports byte-level activity. Before any content a
		// stall classifies as a pre-start transient; after content it ends the call.
		const stallGuard = stallGuarded(
			open,
			{
				timeoutMs: input.stallTimeoutMs,
				startedTimeoutMs: input.startedStallTimeoutMs,
				silenceTimeoutMs: input.transportSilenceTimeoutMs,
			},
			input.clock,
			abortPhysical,
		);
		const guarded = stallGuard.output;
		reportTransportActivity = () => {
			if (physicalController.signal.aborted) return;
			stallGuard.activity();
			request.onTransportActivity();
		};
		const output: AsyncIterable<unknown> = {
			async *[Symbol.asyncIterator]() {
				try {
					for await (const event of observePhysicalAttempt(
						guarded,
						input.model,
						input.callerOptions,
						box,
						requestedModelId,
						dispatchedModelId,
					)) {
						// Classify before the terminal reaches the buffer, so the engine
						// never waits on a source it has already released. Nothing after
						// the terminal can need an abort, so its listeners go now.
						if (terminalAttribution(event) !== undefined) {
							settle();
							releaseAbortSources();
						}
						yield event;
					}
				} finally {
					settle();
					releaseAbortSources();
				}
			},
		};
		return { output, retrySafety };
	};

	/** One closed evidence record per failed call; a sink failure cannot replace the result. */
	const reportFailure = (evidence: LogicalFailureEvidence): void => {
		try {
			deps.onFailure?.(evidence);
		} catch {
			// A diagnostic sink failure cannot replace a provider result.
		}
	};

	/** The bounded shape of the last attempt's failure. Never reads provider text. */
	const failureShape = (box: AttemptRecordBox, stop: LogicalFailureStop): LogicalFailureShape => {
		const hints = box.shapeHints;
		const httpStatus = boundedHttpStatus(box.failure?.httpStatus);
		const transportKind =
			box.failure?.transportKind !== undefined &&
			TRANSPORT_FAILURE_KIND_SET.has(box.failure.transportKind)
				? box.failure.transportKind
				: undefined;
		return Object.freeze({
			phase: attemptHadOutput(box)
				? "streaming"
				: box.sawThinking
					? "thinking"
					: box.heldStart !== undefined
						? "started"
						: "opening",
			ending: hints?.ending ?? "unfinished",
			elapsedSeconds: boundedElapsedSeconds((hints?.failedAtMs ?? box.clock.now()) - box.dispatchedAtMs),
			stop,
			...(hints?.errorType === undefined ? {} : { errorType: hints.errorType }),
			...(hints?.upstream === undefined ? {} : { upstream: hints.upstream }),
			...(hints?.codexFailure === undefined ? {} : { codexFailure: hints.codexFailure }),
			...(hints?.codexCode === undefined ? {} : { codexCode: hints.codexCode }),
			...(httpStatus === undefined ? {} : { httpStatus }),
			...(transportKind === undefined ? {} : { transportKind }),
			...hints?.thrown,
			...identifierFacts(hints?.message, hints),
		});
	};

	/**
	 * Why the call made no further send. The engine's own reason stands unless it
	 * is `unknown`, where the attempt's own facts say more.
	 */
	const failureStop = (
		result: Extract<RecoveryResult, { status: "exhausted" | "terminated" }>,
		last: AttemptRecordBox | undefined,
		sendCap: number,
	): LogicalFailureStop => {
		if (result.status === "exhausted") {
			return result.attempts >= sendCap ? "send-cap" : "no-candidate";
		}
		if (result.reason !== "unknown") return result.reason;
		if (last === undefined) return "unknown";
		if (attemptHadOutput(last)) return "output-seen";
		const classifiedElsewhere =
			last.invalidated || last.hostStaleInstall === true || last.overflow || last.preStartRetryable;
		return !classifiedElsewhere && classifyFailure(last.failure ?? {}).category === "unknown"
			? "unclassified-failure"
			: "unknown";
	};

	/** Named terminal facts only: a provider may attach arbitrary private fields. */
	const safeFailureMessage = (
		modelId: string,
		box: AttemptRecordBox | undefined,
		errorMessage: string,
		stop: LogicalFailureStop,
		keepContent = false,
	): AssistantMessage & { readonly logicalFailure: LogicalFailureEvidence } => {
		const physical = box?.physicalTerminal;
		const account = box?.account;
		const providerId = account !== undefined &&
			isCanonicalManagedProviderId(account.providerId, account.family) &&
			// Only registered slot identities: larger suffixes can look like HTTP
			// retry statuses (429/500) in the host's prose-only predicates.
			isAccountSlotIndex(
				account.providerId === account.family ? 1 : Number(account.providerId.slice(`${account.family}-account-`.length)),
				MAX_ACCOUNT_LIMIT,
			)
			? account.providerId : undefined;
		const classified = classifyFailure(box?.failure ?? {}).category;
		const stale = box?.hostStaleInstall === true;
		// The cause was decided when the open failed. A failed or unavailable
		// credential read that is not already a terminal invalidation may clear
		// by itself, so it is named as such and cooled for a bounded time; no
		// failure here writes an invalidation.
		const credentialCause = stale || box?.overflow === true ? undefined : box?.credentialUnresolved;
		const category = stale ? "host-stale-install" : box?.overflow === true ? "context-overflow" :
			credentialCause ?? (box?.preStartRetryable === true && classified === "unknown" ? "transport" : classified);
		const attemptCount = box?.ordinal ?? 0;
		const shape = box === undefined ? undefined : failureShape(box, stop);
		const overflowReason = category === "context-overflow" ? box?.overflowReason ?? "unknown" : undefined;
		const size = category === "context-overflow" ? box?.overflowSize : undefined;
		// The footer names the size only for the two limits it explains; the
		// evidence and diagnostic keep it for every measured overflow.
		const sizeFooter = size !== undefined && (overflowReason === "request-bytes" || overflowReason === "media-limit")
			? `bytes: ${size.requestBytes}; images: ${size.imageCount}; `
			: "";
		const evidence = `[${providerId === undefined ? "" : `physical provider: ${providerId}; `}cause: ${VISIBLE_FAILURE_CAUSES[category]}; ${overflowReason === undefined ? "" : `overflow: ${overflowReason}; `}${sizeFooter}attempts: ${attemptCount}]`;
		const advice = credentialCause === undefined || box === undefined
			? ""
			: ` ${credentialAdvice(credentialCause, providerId, logicalProviderType(box.account) === "subscription")}${stop === "no-candidate" ? ` ${NO_OTHER_ACCOUNT_MESSAGE}` : ""}`;
		return {
			...syntheticErrorMessage(
				modelId,
				`${stale ? (box?.hostMissingDependency === true ? HOST_MISSING_DEPENDENCY_MESSAGE : HOST_STALE_INSTALL_MESSAGE) : errorMessage}${advice} ${evidence}`,
				physical === undefined ? undefined : projectTerminalUsage(physical),
				physical === undefined ? undefined : finiteNonNegative(physical.timestamp),
			),
			...(keepContent && physical !== undefined ? { content: projectAssistantContent(physical.content) } : {}),
			...(box?.failure?.code === undefined ? {} : { code: box.failure.code }),
			logicalFailure: Object.freeze({
				...(providerId === undefined ? {} : { providerId }),
				category,
				...(overflowReason === undefined ? {} : { overflowReason }),
				...(size === undefined ? {} : { requestBytes: size.requestBytes, imageCount: size.imageCount }),
				attemptCount,
				...(shape === undefined ? {} : { shape }),
			}),
		};
	};

	const withoutErrorMessage = (message: AssistantMessage): AssistantMessage => {
		const { errorMessage: _omitted, ...rest } = message;
		return rest as AssistantMessage;
	};

	/**
	 * The one public terminal for a call the engine neither accepted nor handed
	 * over.
	 *
	 * A structured refusal or unknown stop is the provider's answer, not a
	 * failure: it keeps response content and `code` with a fixed reason, which the host never
	 * re-dispatches. A context overflow keeps the fixed overflow text so the host
	 * still compacts. Every other failure publishes the bounded recovery text
	 * with closed cause evidence; neither host retry predicate matches it.
	 */
	const publicFailure = (
		modelId: string,
		result: Extract<RecoveryResult, { status: "exhausted" | "terminated" }>,
		last: AttemptRecordBox | undefined,
		sendCap: number,
	): { readonly event: unknown; readonly message: AssistantMessage } => {
		const physical = last?.physicalTerminal;
		// A provider's own aborted terminal stays aborted: the host never retries
		// it, and reporting it as an error would invite exactly that.
		const aborted =
			(result.status === "terminated" &&
				(result.reason === "caller-aborted" || result.reason === "shutdown" || result.reason === "reload")) ||
			physical?.stopReason === "aborted";
		if (!aborted && physical !== undefined && hostFinalStopMessage(physical) !== undefined) {
			const message = projectMessage(physical, modelId);
			return { event: { type: "error", reason: "error", error: message }, message };
		}
		const overflow =
			last?.overflow === true &&
			result.status === "terminated" &&
			result.reason === "invalid-request";
		const errorMessage = overflow ? SETUP_CONTEXT_OVERFLOW_MESSAGE : result.errorMessage;
		// Keep validated usage and named failure facts, never arbitrary physical
		// fields, content no consumer saw, or the provider's own error text. An
		// aborted terminal carries no error text at all.
		const projected = safeFailureMessage(modelId, last, errorMessage, failureStop(result, last, sendCap));
		if (!aborted) reportFailure(projected.logicalFailure);
		const message: AssistantMessage = aborted
			? { ...withoutErrorMessage(projected), stopReason: "aborted" }
			: { ...projected, stopReason: "error" };
		return {
			event: { type: "error", reason: aborted ? "aborted" : "error", error: message },
			message,
		};
	};

	/**
	 * Publish a handed-over attempt live. Its earlier events are shown as they
	 * arrive, so nothing after them is ever sent again: a later failure ends the
	 * call. Refusal and unknown-stop outcomes keep their existing projection.
	 * Other failures keep content already shown but project named facts only;
	 * overflow gets fixed overflow text and other failures get host-final text.
	 */
	const publishCommitted = (
		modelId: string,
		output: AsyncIterable<unknown>,
		box: AttemptRecordBox,
	): AsyncIterable<unknown> => ({
		async *[Symbol.asyncIterator]() {
			const bind = (physical: AssistantMessage, publicMessage: AssistantMessage): void => {
				safeAttributionCall(() => box.attempt.bindPublicTerminal?.(physical, publicMessage));
				safeAttributionCall(() => deps.onPublicTerminal?.(physical, publicMessage));
			};
			const failed = (physical: AssistantMessage, aborted: boolean): AssistantMessage => {
				if (hostFinalStopMessage(physical) !== undefined) return projectMessage(physical, modelId);
				const projected = safeFailureMessage(
					modelId, box,
					box.overflow ? SETUP_CONTEXT_OVERFLOW_MESSAGE : buildBoundedRecoveryFinalErrorMessage(),
					"output-seen",
					true,
				);
				if (!aborted) reportFailure(projected.logicalFailure);
				return aborted ? { ...withoutErrorMessage(projected), stopReason: "aborted" } : projected;
			};
			try {
				for await (const event of output) {
					const terminal = terminalAttribution(event);
					if (terminal === undefined) {
						yield projectEvent(event, modelId);
						continue;
					}
					if (terminal.outcome === "finish") {
						const publicMessage = projectMessage(terminal.message, modelId);
						bind(terminal.message, publicMessage);
						yield { type: "done", reason: publicMessage.stopReason, message: publicMessage };
						return;
					}
					const aborted = terminal.outcome === "abort";
					const publicMessage = failed(terminal.message, aborted);
					bind(terminal.message, publicMessage);
					yield { type: "error", reason: aborted ? "aborted" : "error", error: publicMessage };
					return;
				}
			} catch {
				// A stall or a thrown stream failure after content: the attempt
				// recorded its own synthetic terminal, and the call ends here.
				const physical =
					box.physicalTerminal ??
					syntheticErrorMessage(modelId, buildBoundedRecoveryFinalErrorMessage());
				const aborted = box.cancelled?.() === true;
				const publicMessage: AssistantMessage = {
					...failed(physical, aborted),
					...(aborted ? { stopReason: "aborted" as const } : {}),
				};
				bind(physical, publicMessage);
				yield { type: "error", reason: aborted ? "aborted" : "error", error: publicMessage };
			}
		},
	});

	/** Fixed warm-replay terminal texts; neither carries provider text. */
	const WARM_REPLAY_SKIPPED_MESSAGE =
		"Cache warm replay skipped: the account holding this session's cache cannot take it now.";
	const WARM_REPLAY_FAILED_MESSAGE = "Cache warm replay failed; no account state was changed.";

	/**
	 * The account a host cache-warm replay may use (internal issue #206): the
	 * account that served the session's last successful call for this logical
	 * model, and only while a real call would still choose it now. With no
	 * remembered account, or when that account is cooling, spent, cleared,
	 * disabled, outside the session's account group, or displaced by a
	 * subscription account, the replay is skipped: warming any other account
	 * writes a cache that no later call reads.
	 */
	const warmReplayTarget = (
		modelId: string,
		sessionKey: string | undefined,
	): LogicalServingAccount | undefined => {
		if (sessionKey === undefined) return undefined;
		const remembered = affinity.lastServingAccount(sessionKey, modelId);
		if (remembered === undefined) return undefined;
		try {
			const selected = selectAccount(modelId, sessionKey);
			// A replay is a send outside the probe claim, so it never goes to an
			// invalidated account even when that account's probe is due.
			return selected.displaced === undefined &&
				selected.account.providerId === remembered &&
				coordinator.state.getInvalidation(remembered) === undefined
				? selected
				: undefined;
		} catch {
			return undefined;
		}
	};

	/** A replay terminal the host warmer treats as not warmed. */
	const warmReplayTerminal = (modelId: string, errorMessage: string, aborted: boolean): unknown => {
		const message = syntheticErrorMessage(modelId, errorMessage);
		return aborted
			? { type: "error", reason: "aborted", error: { ...withoutErrorMessage(message), stopReason: "aborted" } }
			: { type: "error", reason: "error", error: message };
	};

	/**
	 * Whether a replay would be sent without the thinking block its real call
	 * had. Both Anthropic streams add a budget-thinking block only when
	 * `maxTokens` is above one, so a one-token replay of a budget-thinking
	 * request misses the message cache and writes a new one. Pi's `isReplayable`
	 * refuses that case only for the `anthropic-messages` API, which unified rows
	 * do not use. Adaptive thinking and thinking off keep the request the same.
	 */
	const replayDropsThinking = (
		model: unknown,
		account: LogicalPhysicalAccount,
		options: SimpleStreamOptions | undefined,
	): boolean => {
		if (account.family !== "anthropic" || !options?.reasoning) return false;
		if (typeof model !== "object" || model === null) return false;
		const row = model as { reasoning?: unknown; compat?: { forceAdaptiveThinking?: unknown } };
		return row.reasoning === true && row.compat?.forceAdaptiveThinking !== true;
	};

	/**
	 * One host cache-warm replay (internal issue #206): at most one physical
	 * send, to the account that holds the session's cache. It never enters the
	 * recovery engine, so it never fails over and never sends twice. It records
	 * no cooldown, failure evidence, attribution, or session affinity: a
	 * one-token refresh is not a turn, and a failed refresh must not cool a
	 * healthy account. The host itself records a successful replay's usage as
	 * `cache_warm`.
	 */
	const warmReplay = (
		model: unknown,
		modelId: string,
		context: unknown,
		options: SimpleStreamOptions | undefined,
		sessionKey: string | undefined,
	): AsyncIterable<unknown> => ({
		async *[Symbol.asyncIterator]() {
			const target = warmReplayTarget(modelId, sessionKey);
			if (target === undefined || replayDropsThinking(model, target.account, options)) {
				yield warmReplayTerminal(modelId, WARM_REPLAY_SKIPPED_MESSAGE, false);
				return;
			}
			const { account, resolvedModelId } = target;
			const controller = new AbortController();
			const abort = (): void => controller.abort();
			const abortSources = [options?.signal, shutdownController.signal].filter(
				(signal): signal is AbortSignal => signal !== undefined,
			);
			for (const signal of abortSources) {
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
			const cancelled = (): boolean =>
				options?.signal?.aborted === true || shutdownController.signal.aborted;
			// The same request transforms a real call gets, so the replay matches
			// the cached prefix.
			const callerOptions =
				account.family === "openai-codex" ? forceCodexSseOptions(options).options : options;
			const physicalContext =
				account.providerId === account.family
					? context
					: stripOldImages(context, readImageStripPolicy(() => deps.imageStripping));
			const stallTimeoutMs =
				deps.recoveryTiming?.recoveryStallTimeoutMs ?? DEFAULT_CONFIG.recoveryStallTimeoutMs;
			let reportActivity: () => void = () => {};
			const physicalOptions = {
				...callerOptions,
				signal: controller.signal,
				onTransportActivity: () => reportActivity(),
			} as SimpleStreamOptions;
			const guard = stallGuarded(
				async () =>
					await deps.dispatch({
						providerId: account.providerId,
						modelId: resolvedModelId,
						context: physicalContext,
						options: physicalOptions,
					}),
				{
					timeoutMs: stallTimeoutMs,
					startedTimeoutMs: Math.max(
						stallTimeoutMs,
						deps.recoveryTiming?.recoveryAbsoluteTimeoutMs ?? DEFAULT_CONFIG.recoveryAbsoluteTimeoutMs,
					),
					silenceTimeoutMs: deps.transportSilenceTimeoutMs ?? TRANSPORT_SILENCE_TIMEOUT_MS,
				},
				deps.recoveryClock ?? SYSTEM_RECOVERY_CLOCK,
				abort,
			);
			reportActivity = guard.activity;
			try {
				for await (const event of guard.output) {
					const terminal = terminalAttribution(event);
					if (terminal === undefined || terminal.outcome === "finish") {
						const projected = projectEvent(event, modelId);
						if (projected !== undefined) yield projected;
						if (terminal !== undefined) return;
						continue;
					}
					yield warmReplayTerminal(modelId, WARM_REPLAY_FAILED_MESSAGE, terminal.outcome === "abort");
					return;
				}
				yield warmReplayTerminal(modelId, WARM_REPLAY_FAILED_MESSAGE, false);
			} catch {
				yield warmReplayTerminal(modelId, WARM_REPLAY_FAILED_MESSAGE, cancelled());
			} finally {
				for (const signal of abortSources) signal.removeEventListener("abort", abort);
			}
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
			if (shutDown) {
				throw new Error("the logical provider session has shut down");
			}
			const sessionKey = sessionAffinityKey(options);
			// A host cache-warm replay (internal issue #206) goes only to the account
			// that holds the session's cache, as one send outside recovery,
			// attribution, cooldown, and session affinity.
			if (warmReplays.isReplay(context, options)) {
				return warmReplay(model, modelId, context, options, sessionKey);
			}
			warmReplays.noteRealRequest(context);
			// Selecting a due terminal-auth invalidation only reads (#227). The claim
			// is the one write, made in the same synchronous turn as the selection, so
			// of several concurrent calls exactly one dispatches the probe and the
			// rest are re-selected away from it.
			const lostProbes = new Set<string>();
			let selected = selectAccount(modelId, sessionKey);
			let probeProviderId: string | undefined;
			while (coordinator.state.getInvalidation(selected.account.providerId) !== undefined) {
				if (coordinator.state.claimInvalidationProbe(selected.account.providerId, Date.now())) {
					probeProviderId = selected.account.providerId;
					diagnose("a terminal-auth invalidation is being probed with one dispatch.");
					break;
				}
				lostProbes.add(selected.account.providerId);
				selected = selectAccount(modelId, sessionKey, lostProbes);
			}
			const candidates = recoveryCandidates(modelId, selected);
			// Codex routes are pinned to SSE before the engine sees the options, so
			// the engine reserves one bounded send for them instead of an unknown count.
			let engineOptions = options;
			if (selected.account.family === "openai-codex") {
				// Temporary Pi 0.99 WebSocket containment; see CODEX_FORCED_TRANSPORT.
				const forced = forceCodexSseOptions(options);
				engineOptions = forced.options;
				if (forced.overridden && options?.transport !== undefined && !codexTransportNoticeSent) {
					codexTransportNoticeSent = true;
					try {
						deps.onDiagnostic?.(
							`Codex transport "${codexTransportLabel(options.transport)}" overridden to "sse" on routed calls (Pi 0.99 WebSocket containment).`,
						);
					} catch {
						// A diagnostic sink failure cannot replace a provider result.
					}
				}
			}
			const boxes: AttemptRecordBox[] = [];
			const clock = deps.recoveryClock ?? SYSTEM_RECOVERY_CLOCK;
			const stallTimeoutMs =
				deps.recoveryTiming?.recoveryStallTimeoutMs ??
				DEFAULT_CONFIG.recoveryStallTimeoutMs;
			// Read once per call: a reload changes the next call's cap, never this one's.
			const maxAttempts =
				deps.recoveryTiming?.recoveryMaxAttempts ?? DEFAULT_CONFIG.recoveryMaxAttempts;
			// Once the provider has answered, only the whole-call limit bounds a
			// silent wait; the engine's absolute timer still ends the call.
			const startedStallTimeoutMs = Math.max(
				stallTimeoutMs,
				deps.recoveryTiming?.recoveryAbsoluteTimeoutMs ??
					DEFAULT_CONFIG.recoveryAbsoluteTimeoutMs,
			);
			const engine = createRecoveryEngine({
				clock,
				recheck: (candidate) => {
					const account = deps.accounts.find(
						({ providerId, family }) =>
							providerId === candidate.providerId && family === candidate.family,
					);
					// The live accounts getter re-reads the opt-out, so an exclusion
					// committed after planning still stops a later send.
					if (account === undefined || account.automaticRoutingExcluded === true) {
						return { status: "skip" };
					}
					// Re-read live eligibility for every candidate: a later candidate is
					// checked after earlier failures have already cooled their own accounts.
					// The claimed probe account is the one admitted exception: its claim
					// already pushed the next probe out, so the plain rule would refuse
					// the dispatch the claim bought. A recovery target never gets this.
					return logicalAccountEligible(
						{
							providerId: account.providerId,
							exhausted: account.exhausted,
							authenticated: account.authenticated,
						},
						coordinator.state,
						Date.now(),
						account.providerId === probeProviderId ? "claimed" : undefined,
					)
						? { status: "eligible" }
						: { status: "skip" };
				},
				reserve: () => "reserved",
				dispatch: (request) => {
					const account = deps.accounts.find(
						({ providerId, family }) =>
							providerId === request.candidate.providerId &&
							family === request.candidate.family,
					);
					if (account === undefined) throw new Error("the candidate account disappeared");
					const providerType = logicalProviderType(account);
					deps.onObservation?.({
						providerId: account.providerId,
						modelId: request.candidate.modelId,
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
					const box: AttemptRecordBox = {
						ordinal: boxes.length + 1,
						clock,
						dispatchedAtMs: clock.now(),
						overflow: false,
						sawOutput: false,
						sawThinking: false,
						preStartRetryable: false,
						invalidated: false,
						attempt,
						account,
					};
					boxes.push(box);
					return physicalAttempt({
						request,
						account,
						model,
						context,
						callerOptions: options,
						requestedModelId: modelId,
						box,
						clock,
						stallTimeoutMs,
						startedStallTimeoutMs,
						transportSilenceTimeoutMs:
							deps.transportSilenceTimeoutMs ?? TRANSPORT_SILENCE_TIMEOUT_MS,
					});
				},
				// The attribution store retains every physical attempt's usage and cost
				// at its own terminal, under its own physical account. A failed attempt
				// whose retention failed cannot buy a further send that could not be
				// accounted for either; an accepted answer is never discarded for it,
				// and its missing record stays a reported coverage gap.
				account: async (record) => {
					const box = boxes[record.ordinal - 1];
					// An accepted or handed-over attempt has not reached its terminal yet;
					// its own terminal retains its facts.
					if (
						box === undefined ||
						record.disposition === "accepted" ||
						record.disposition === "committed"
					) {
						return "recorded";
					}
					const outcome = await box.attempt.waitForTerminal();
					return outcome.status === "failed" ? "rejected" : "recorded";
				},
			});
			activeEngines.add(engine);
			// The engine starts now and the stream is returned at once: a consumer
			// sees nothing until the call has a publishable outcome.
			const settled = (async (): Promise<AsyncIterable<unknown>> => {
				let result: RecoveryResult;
				try {
					result = await engine.recover({
						candidates,
						context,
						...(engineOptions === undefined ? {} : { options: engineOptions }),
						// Only the provider's `start` is held: the first content event hands
						// the attempt over and streams live, so only a failure before any
						// content may move to another account.
						publication: "stream-after-first-content",
						timing: {
							recoveryIdleTimeoutMs:
								deps.recoveryTiming?.recoveryIdleTimeoutMs ??
								DEFAULT_CONFIG.recoveryIdleTimeoutMs,
							recoveryAbsoluteTimeoutMs:
								deps.recoveryTiming?.recoveryAbsoluteTimeoutMs ??
								DEFAULT_CONFIG.recoveryAbsoluteTimeoutMs,
						},
						maxAttempts,
						...(options?.signal === undefined ? {} : { signal: options.signal }),
					});
				} finally {
					activeEngines.delete(engine);
				}
				const last = boxes.at(-1);
				// Attempts the call moved past were never published. Their physical
				// failure is still real, so the session commits its account effects.
				for (const superseded of boxes.slice(0, -1)) {
					const physical = superseded.physicalTerminal;
					if (physical !== undefined) {
						safeAttributionCall(() => deps.onSupersededTerminal?.(physical));
					}
				}
				if (result.status === "accepted") {
					const physical = result.terminal;
					const publicMessage = projectMessage(physical, modelId);
					safeAttributionCall(() => last?.attempt.bindPublicTerminal?.(physical, publicMessage));
					safeAttributionCall(() => deps.onPublicTerminal?.(physical, publicMessage));
					const accepted = result.output;
					// Streaming publication accepts only an attempt that reached its
					// terminal before any content. One that sent a `start` is published
					// as its own held `start` and then its terminal, so the stream stays
					// well formed; one that sent nothing else is published as its bare
					// terminal.
					const heldStart = last?.heldStart;
					const replayProgress =
						last?.sawOutput === true || last?.sawThinking === true || heldStart !== undefined;
					return (async function* () {
						let startPublished = false;
						for await (const event of accepted) {
							if (event.type === "done") yield { type: "done", reason: publicMessage.stopReason, message: publicMessage };
							else if (!replayProgress) continue;
							else if (event.type === "start" && heldStart !== undefined) {
								if (startPublished) continue;
								startPublished = true;
								yield projectEvent(heldStart, modelId);
							} else yield projectEvent(event, modelId);
						}
					})();
				}
				if (result.status === "committed") {
					// The live attempt is the last box: the engine dispatched nothing after it.
					return publishCommitted(modelId, result.output, last!);
				}
				const failure = publicFailure(modelId, result, last, maxAttempts);
				const physical = last?.physicalTerminal;
				if (physical !== undefined) {
					safeAttributionCall(() => last?.attempt.bindPublicTerminal?.(physical, failure.message));
					safeAttributionCall(() => deps.onPublicTerminal?.(physical, failure.message));
				}
				return (async function* () {
					yield failure.event;
				})();
			})();
			void settled.catch(() => {});
			return (async function* () {
				for await (const event of await settled) {
					if (sessionKey !== undefined) {
						try {
							noteSessionOutcome(sessionKey, modelId, selected, boxes, event);
						} catch {
							// Session affinity cannot replace a provider result.
						}
					}
					yield event;
				}
			})();
		},

		preflight(model) {
			const modelId = requestedModelId(model);
			if (modelId === undefined) return undefined;
			try {
				const { account, resolvedModelId } = selectAccount(modelId);
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

		lastServingAccount(sessionKey, modelId) {
			return affinity.lastServingAccount(sessionKey, modelId);
		},

		shutdown() {
			// No late dispatch survives the session: every in-flight logical call
			// aborts its active attempt and publishes no further send.
			shutDown = true;
			for (const engine of activeEngines) engine.shutdown();
			shutdownController.abort();
			activeEngines.clear();
			safeAttributionCall(() => deps.attribution?.shutdown());
		},
	};
}
