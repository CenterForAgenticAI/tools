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
	PROVIDER_ERROR_CODES,
	TRANSPORT_FAILURE_KINDS,
	classifyFailure,
	providerErrorCodeFromMessage,
} from "./error-classification.js";
import type {
	FailureCategory,
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
import { forceCodexSseOptions } from "./codex-adapter.js";
import {
	buildBoundedRecoveryFinalErrorMessage,
	createRecoveryEngine,
	isRecoveryStartEvent,
	type RecoveryClock,
	type RecoveryDispatchRequest,
	type RecoveryEngine,
	type RecoveryPhysicalAttempt,
	type RecoveryResult,
	type RecoveryRetrySafety,
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

/** Safe physical cause of a failed logical call; never contains provider prose. */
export interface LogicalFailureEvidence {
	readonly providerId?: string;
	readonly category: FailureCategory | "context-overflow" | "host-stale-install";
	/** Physical invocations, not the unknown inner send count of Antigravity. */
	readonly attemptCount: number;
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
	onShutdownAbort?: () => void;
	/**
	 * A failed physical terminal the call recovered past. It was never
	 * published, so no `message_end` will carry it; the session commits its
	 * account effects here instead.
	 */
	onSupersededTerminal?: (physical: AssistantMessage) => void;
	state?: RuntimeState;
	/**
	 * Per-invocation idle and absolute limits and the per-attempt stall limit;
	 * omitted fields use the defaults.
	 */
	recoveryTiming?: Partial<
		RecoveryTimingConfig & Pick<MultiAccountConfig, "recoveryStallTimeoutMs">
	>;
	/** Injected only by tests; production uses the system clock. */
	recoveryClock?: RecoveryClock;
	/** Injected only by tests; production uses `TRANSPORT_SILENCE_TIMEOUT_MS`. */
	transportSilenceTimeoutMs?: number;
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
});

/**
 * Public text for a local host fault: the running pi process tried to load a
 * bundle chunk that an in-place upgrade replaced. No provider was reached, and
 * no other account can load the missing file, so only a restart helps. Neither
 * host retry predicate matches this text.
 */
export const HOST_STALE_INSTALL_MESSAGE =
	"pi's installed files changed while this session was running; restart the pi session to load the current install.";

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
function hostStaleInstallCause(error: unknown): string {
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
	const file = /['"]?([^'"\s]*\.(?:m?js|cjs|json|node))['"]?/.exec(text)?.[1]?.split(/[\\/]/).at(-1);
	const kind = code === "ERR_MODULE_NOT_FOUND" || /ERR_MODULE_NOT_FOUND|Cannot find/.test(text) ? "ERR_MODULE_NOT_FOUND" : "dynamic-import-failed";
	return file === undefined || file.length === 0 ? kind : `${kind} ${file.slice(0, 120)}`;
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

	const selectAccount = (modelId: string): LogicalServingAccount => {
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
				eligible: logicalAccountEligible(account, coordinator.state, nowMs),
				...(account.authenticated === undefined ? {} : { authenticated: account.authenticated }),
				...(account.exhausted === undefined ? {} : { exhausted: account.exhausted }),
				coolingDown: coordinator.state.peekCooldown(account.providerId, nowMs) !== undefined,
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

		// Physical OpenAI subscription (`openai-codex`) and owning-vendor API
		// (`openai`) accounts are one routing family: vendor `openai`. Ownership is
		// fixed from the declared subscription catalog before API exact/map matches are
		// admitted, so another vendor's API catalog cannot make a row ambiguous.
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
				failureMessage(`every managed account serving ${modelId} is currently ineligible`),
			);
		}
		return chosen;
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
		box.hostStaleInstall = true;
		box.overflow = false;
		box.preStartRetryable = false;
		try {
			deps.onDiagnostic?.(
				`logical dispatch for ${account.providerId} failed loading host code (host_stale_install: ` +
					`${hostStaleInstallCause(cause)}); restart the pi session`,
			);
		} catch {
			// A diagnostic sink failure cannot replace a provider result.
		}
	};
	/** The account did nothing wrong; report it as handled so nothing cools it. */
	const hostFaultReceipt = (): HostRetryCooldownReceipt => ({ alreadyCooled: true, rollback: () => {} });

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
		if (box.sawOutput || (Array.isArray(message?.content) && message.content.length > 0)) {
			return { status: "unsafe", reason: "unknown" };
		}
		if (failure === undefined) return { status: "unsafe", reason: "unknown" };
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
		/**
		 * A non-terminal event other than `start` reached the engine; nothing
		 * after it is resent. The provider's `start` only reports that response
		 * headers arrived, so it is not output.
		 */
		sawOutput: boolean;
		/**
		 * The attempt's first `start`, held by the engine until the first content.
		 * A successful terminal with no content publishes this exact event.
		 */
		heldStart?: unknown;
		/** A setup-shaped first terminal whose raw text the host would retry. */
		preStartRetryable: boolean;
		/** Setup failed because this pi process could not load its own code. */
		hostStaleInstall?: boolean;
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
			// still the stream's first real event.
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
			const attributeFailure = (message: AssistantMessage, failure: ProviderFailureSignal): void => {
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
						box.sawOutput = true;
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
							attributeFailure(replacement, safeProjectFailureSignal(replacement, dispatchedModelId));
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
						box.overflow = disposition === "context-overflow";
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
						box.overflow = (message as { code?: unknown }).code === undefined;
					}
					attributeFailure(message, failure);
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
					box.overflow = disposition === "context-overflow";
					box.preStartRetryable = disposition === "retryable";
				}
				if (box.physicalTerminal === undefined) {
					attributeFailure(
						syntheticErrorMessage(requestedModelId, buildBoundedRecoveryFinalErrorMessage()),
						safeProjectFailureSignal(error, dispatchedModelId),
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
		// is another account serving the selected model.
		const accounts = deps.accounts
			.filter(
				(account) =>
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
		const open = async (): Promise<AsyncIterable<unknown>> => {
			try {
				return await deps.dispatch({
					providerId: account.providerId,
					modelId: dispatchedModelId,
					context: input.context,
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
				if (!hasStructuredFailureEvidence(box.failure) && isHostStaleInstallFailure(error)) {
					markHostStaleInstall(box, account, error);
					box.receipt = hostFaultReceipt();
				} else {
					const raw =
						typeof error === "object" && error !== null
							? (error as { message?: unknown }).message
							: undefined;
					const disposition = setupFailureDisposition(syntheticMessage, raw);
					box.overflow = disposition === "context-overflow";
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

	/** Named terminal facts only: a provider may attach arbitrary private fields. */
	const safeFailureMessage = (
		modelId: string,
		box: AttemptRecordBox | undefined,
		errorMessage: string,
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
		const category = stale ? "host-stale-install" : box?.overflow === true ? "context-overflow" :
			box?.preStartRetryable === true && classified === "unknown" ? "transport" : classified;
		const attemptCount = box?.ordinal ?? 0;
		const evidence = `[${providerId === undefined ? "" : `physical provider: ${providerId}; `}cause: ${VISIBLE_FAILURE_CAUSES[category]}; attempts: ${attemptCount}]`;
		return {
			...syntheticErrorMessage(
				modelId,
				`${stale ? HOST_STALE_INSTALL_MESSAGE : errorMessage} ${evidence}`,
				physical === undefined ? undefined : projectTerminalUsage(physical),
				physical === undefined ? undefined : finiteNonNegative(physical.timestamp),
			),
			...(keepContent && physical !== undefined ? { content: projectAssistantContent(physical.content) } : {}),
			...(box?.failure?.code === undefined ? {} : { code: box.failure.code }),
			logicalFailure: Object.freeze({
				...(providerId === undefined ? {} : { providerId }),
				category,
				attemptCount,
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
		const projected = safeFailureMessage(modelId, last, errorMessage);
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
					true,
				);
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
			const selected = selectAccount(modelId);
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
					if (account === undefined) return { status: "skip" };
					// Re-read live eligibility for every candidate: a second candidate is
					// checked after the first failure has already cooled its own account.
					return logicalAccountEligible(
						{
							providerId: account.providerId,
							exhausted: account.exhausted,
							authenticated: account.authenticated,
						},
						coordinator.state,
						Date.now(),
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
						overflow: false,
						sawOutput: false,
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
				// whose retention failed cannot buy a second send that could not be
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
					const replayProgress = last?.sawOutput === true || heldStart !== undefined;
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
				const failure = publicFailure(modelId, result, last);
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
				yield* await settled;
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
