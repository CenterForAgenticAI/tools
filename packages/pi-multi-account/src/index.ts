import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	MultiAccountCommandController,
	declarationNoticeForStatus,
	declarationNoticeMessage,
	type AccountGroupCommandStatus,
	type OperatorAccount,
} from "./commands.js";
import { CompactionRouter } from "./compaction.js";
import {
	createCodexAliasProviderConfig,
	getCodexModelsFromRegistry,
	type CapturedCodexProvider,
} from "./codex-adapter.js";
import {
	createOpenAiAliasProviderConfig,
	openaiPlatformModels,
} from "./openai-adapter.js";
import {
	ALLOWED_FAMILIES,
	DEFAULT_CONFIG,
	accountSlotIndexes,
	canonicalProviderIdForAccountSlot,
	isAccountSlotIndex,
	isAllowedFamily,
	readConfig,
	routingProjection,
	type AllowedFamily,
	type ManagedFamily,
	type MultiAccountConfig,
	type RoutingProjection,
} from "./config.js";
import {
	commitRoutingConfig,
	routingConfigLockPath,
} from "./routing-config-transaction.js";
import {
	ContinuationController,
	type ContinuationDestination,
} from "./continuation.js";
import { appendCostRecord } from "./cost-history.js";
import { OpenRouterBudgetStore } from "./openrouter-budget.js";
import {
	OPENROUTER_PROVIDER_ID,
	resolveOpenRouterEnvironmentPolicy,
	worstCaseOpenRouterTurnUsd,
} from "./openrouter-fallback.js";
import {
	createDefaultCostPeriodCloser,
	type CostPeriodCloser,
} from "./cost-period-closer.js";
import { parsePiCatalogSnapshot, type PiCatalogSnapshot } from "./api-pricing.js";
import type { CostReport } from "./cost-report.js";
import { createDefaultCostReportReader } from "./cost-report-reader.js";
import type { PeriodType } from "./period-boundaries.js";
import {
	mergeRefreshedCredentials,
	type CredentialUsability,
} from "./credential-lifecycle.js";
import {
	createHostForcedCredentialRefresher,
	type ForcedCredentialRefresher,
} from "./credential-refresh.js";
import { DiagnosticStore } from "./diagnostic-store.js";
import { DeclarationNoticeMarker } from "./declaration-notice-marker.js";
import { DiagnosticLog } from "./diagnostics.js";
import {
	classifyProviderId,
	createPublicAuthStorageAdapter,
	createReadStoredCredentialProbe,
	discoverAccounts,
	isProviderSlotWithinAccountLimit,
	type CredentialType,
	type DiscoveryResult,
	type ProviderSlot,
} from "./discovery.js";
import { cloneProviderModelCatalog } from "./catalog-rebinding.js";
import {
	classifyFailure,
	providerErrorCodeFromMessage,
	type FailureCategory,
	type ProviderFailureSignal,
} from "./error-classification.js";
import { Type } from "typebox";
import { MultiAccountLifecycle } from "./lifecycle.js";
import {
	buildLogicalModelInventory,
	executeLogicalModelSwitch,
	type LogicalModelInventory,
	type LogicalModelSwitchDependencies,
	type LogicalModelSwitchResult,
} from "./logical-model-switcher.js";
import { createLogicalModelSelector } from "./logical-model-selector.js";
import {
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type Component,
} from "@earendil-works/pi-tui";
import {
	completeLogicalModelArguments,
	completeMultiAccountArguments,
	projectCompletionAccounts,
	projectCompletionAddSlots,
	type CompletionAccountIdentity,
	type CompletionSlotChoices,
} from "./command-completions.js";
import { ModelSupportRegistry } from "./model-support.js";
import {
	createAntigravitySlotConfig,
	createLogicalApiRegistrarForFactoryGeneration,
	registerDiscoveredProviders,
	registerLogicalProviderForSession,
	type LogicalApiRegistrar,
} from "./provider-registration.js";
import {
	LOGICAL_PROVIDER_ID,
	buildModelDeclaration,
	inspectInstalledDeclaration,
	type InstalledDeclarationStatus,
} from "./models-declaration.js";
import { createLogicalDispatch } from "./logical-dispatch.js";
import type { ModelsCatalogs } from "./commands.js";
import {
	NOOP_LOGICAL_ATTRIBUTION_ATTEMPT,
	safeBeginAttributionAttempt,
	type LogicalAttributionAttempt,
	type LogicalAttributionLifecycle,
	type LogicalPhysicalAccount,
	type LogicalProviderDeps,
	type LogicalRouteFact,
	type LogicalTerminalFailureFact,
	type ManagedAssistantRecordOutcome,
} from "./logical-provider.js";
import {
	createAttributionStore,
	type AttributionStore,
} from "./logical-provider-attribution.js";
import { isCredentialUsable } from "./credential-lifecycle.js";
import {
	routeAfterFailure,
	selectAvailableManagedAccount,
	selectAvailableRecoveryAccount,
	selectAvailableRouteCandidates,
	selectHealthAwareAccount,
	selectManagedLastResortCandidate,
	type AvailableRouteCandidate,
	type ManagedAccount,
	type SharedUsageHint,
	type SubscriptionManagedAccount,
	snapshotIndicatesExhaustion,
} from "./routing.js";
import { selectPreflightAccount, type LivenessProbe } from "./preflight.js";
import {
	lookupRouteResolver,
	publishRouteResolver,
	publishRouteResolverForSession,
	resolveExactModelRoutes,
	type ExactModelRouteResolutionContext,
} from "./route-resolver.js";
export {
	ROUTE_RESOLVER_PURPOSE,
	ROUTE_RESOLVER_REGISTRY_KEY,
	ROUTE_RESOLVER_VERSION,
	lookupRouteResolver,
	publishRouteResolver,
	resolveExactModelRoutes,
	type ExactModelRoute,
	type ExactModelRouteResolutionContext,
	type RouteResolver,
	type RouteResolverInput,
	type RouteResolverLookup,
	type RouteResolverPublicationResult,
	type RouteResolverResult,
	type RouteResolverResolvedResult,
	type RetainedRouteResolverService,
	type RouteResolverService,
	type RouteResolverUnresolvedReason,
	type RouteResolverUnresolvedResult,
} from "./route-resolver.js";
import type { EffectiveAccountGroupResolution } from "./group-policy.js";
import {
	SessionAccountGroupStore,
	type SessionIdSource,
} from "./session-account-groups.js";
import { projectKeyForCwd } from "./project-identity.js";
import { RuntimeState, isCanonicalManagedProviderId } from "./runtime-state.js";
import { providerTypeFor } from "./vendor.js";
import { resolveTierModel } from "./tier-model-resolver.js";
import {
	normalizeHeaderUtilization,
	SharedUsageStore,
	type SharedUsageSnapshot,
} from "./shared-usage.js";
import { CredentialWarmer, type WarmCandidate } from "./warmer.js";
import { restoreManagedAliasModel } from "./session-restore.js";
import {
	accountFingerprint,
	resolveAccountLabelWithinLimit,
} from "./account-labels.js";
import {
	createAnthropicAliasProviderConfig,
	reassertAnthropicBaseRegistration,
	registerUpstreamAnthropicProvider,
} from "./upstream-anthropic.js";
import {
	GOOGLE_ANTIGRAVITY_API,
	createAntigravityProviderConfig,
	loadUpstreamAntigravityPrimitives,
	registerAntigravityAliasApi,
} from "./upstream-antigravity.js";
import {
	UsageLedger,
	type RateLimitObservation,
	type TokenUsageObservation,
	type UsageObservation,
} from "./usage.js";
import { ContinuationWatchdog } from "./watchdog.js";
import {
	UsageFetcher,
	type AntigravityUsageFetchImplementation,
	type UsageFetchImplementation,
} from "./usage-fetch.js";
import {
	createLogicalRouteIndicator,
	type LogicalRouteIndicator,
	type LogicalRouteIndicatorAttempt,
} from "./logical-route-indicator.js";

const CONFIG_FILE = "config.json";
const AUTH_FILE = "auth.json";
const CODEX_PROVIDER = "openai-codex";
const LOGICAL_ROUTE_WIDGET_KEY = "caair.pi-multi-account/unified";
const READ_ONLY_AGENT_TOOL_COMMANDS = new Set([
	"status",
	"log",
	"limits",
	"models",
	"cost",
]);
const FOLLOW_UP_DISPLAY =
	"Multi-account continuation watchdog recovered to advisory mode.";

type ProviderResponseObservation = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
};

const REMAINING_REQUEST_HEADERS = [
	"x-ratelimit-remaining-requests",
	"x-ratelimit-requests-remaining",
	"anthropic-ratelimit-requests-remaining",
] as const;
const REMAINING_TOKEN_HEADERS = [
	"x-ratelimit-remaining-tokens",
	"x-ratelimit-tokens-remaining",
	"anthropic-ratelimit-tokens-remaining",
] as const;
const DURATION_RESET_HEADERS = [
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
] as const;
const ABSOLUTE_RESET_HEADERS = [
	"x-ratelimit-reset",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-reset",
] as const;
/**
 * Codex reports its rate-limit state on ordinary completion responses, the same
 * way Anthropic does, but under its own names and in PERCENT rather than a 0-1
 * fraction.
 *
 * Without these we learned Codex saturation only from the five-minute usage
 * poll, so an account could be exhausted for up to five minutes before routing
 * noticed -- while the headers announcing it were discarded. Anthropic never
 * had that blind spot precisely because its equivalent headers were already
 * observed.
 *
 * TRANSPORT-CONDITIONAL. `pi-ai`'s `openai-codex-responses` calls `onResponse`
 * only on its SSE branch, so these headers reach us on SSE and never on
 * WebSocket. The `transport` setting defaults to `auto`, which prefers
 * WebSocket, so the poll remains the usual source and this parser is the
 * faster one when SSE is in use. Verified live on 2026-08-19 against a real
 * Codex account: `transport: "sse"` delivered `x-codex-primary-used-percent`
 * and its reset pair; `transport: "websocket"` delivered no response event at
 * all. Recorded in AGENTS.md under Host boundaries.
 *
 * `-reset-after-seconds` is a DURATION and `-reset-at` an ABSOLUTE instant, so
 * each joins the matching set and needs no special arithmetic here.
 */
const CODEX_USED_PERCENT_HEADERS = [
	"x-codex-primary-used-percent",
	"x-codex-secondary-used-percent",
] as const;
const CODEX_DURATION_RESET_HEADERS = [
	"x-codex-primary-reset-after-seconds",
	"x-codex-secondary-reset-after-seconds",
] as const;
const CODEX_ABSOLUTE_RESET_HEADERS = [
	"x-codex-primary-reset-at",
	"x-codex-secondary-reset-at",
] as const;

const OBSERVED_RATE_LIMIT_HEADERS = new Set<string>([
	...REMAINING_REQUEST_HEADERS,
	...REMAINING_TOKEN_HEADERS,
	...DURATION_RESET_HEADERS,
	...ABSOLUTE_RESET_HEADERS,
	...CODEX_USED_PERCENT_HEADERS,
	...CODEX_DURATION_RESET_HEADERS,
	...CODEX_ABSOLUTE_RESET_HEADERS,
	"retry-after",
	"retry-after-ms",
]);

function isUnifiedUtilizationHeader(name: string): boolean {
	return /^anthropic-ratelimit-unified-[a-z0-9-]+-utilization$/.test(name);
}

/**
 * Reads a Codex used-percent header as a 0-1 utilization.
 *
 * Anthropic sends a fraction and Codex a percent, so the two cannot share a
 * parser: reading `75` as a fraction would clamp to 1 and report a
 * three-quarters-used account as fully exhausted. Values outside 0-100 are
 * rejected rather than clamped -- an out-of-range figure means the header was
 * not what we assumed, and a fabricated reading is worse than none.
 */
function codexUtilizationFromHeaders(
	headers: ReadonlyMap<string, string>,
): number | undefined {
	const readings = CODEX_USED_PERCENT_HEADERS.map((name) => {
		const raw = headers.get(name)?.trim();
		if (raw === undefined || raw.length === 0) return undefined;
		const percent = Number(raw);
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
			return undefined;
		}
		return percent / 100;
	}).filter((value): value is number => value !== undefined);
	// The tightest window governs: an exhausted weekly allowance is not relieved
	// by a fresh five-hour one.
	return readings.length > 0 ? Math.max(...readings) : undefined;
}

function agentDirectory(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function rightAlignedWidget(text: string): Component {
	return {
		invalidate() {},
		render(width) {
			try {
				const availableWidth = Number.isFinite(width)
					? Math.max(0, Math.floor(width))
					: visibleWidth(text);
				const visibleText = truncateToWidth(text, availableWidth, "");
				return [
					`${" ".repeat(Math.max(0, availableWidth - visibleWidth(visibleText)))}${visibleText}`,
				];
			} catch {
				return [text];
			}
		},
	};
}

/**
 * Read the installed managed declaration for inspection.
 *
 * Distinguishes the two states {@link inspectInstalledDeclaration} treats
 * differently. An absent file is `{}`, which inspects as `absent` — the normal
 * case for an operator who never ran `models install`. Bytes that will not
 * parse return `undefined`, which inspects as `unreadable`, because a file this
 * extension cannot read is not a file it may assume is empty and route on.
 *
 * The read lives here rather than in `models-declaration.ts`, which is
 * deliberately pure so the installed file stays free of runtime state.
 */
function readInstalledDeclaration(targetPath: string): unknown {
	let bytes: string;
	try {
		bytes = readFileSync(targetPath, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
	}
	try {
		return JSON.parse(bytes) as unknown;
	} catch {
		return undefined;
	}
}

/** The complete declaration-gated startup seam, exported for causal registration contracts. */
export function registerLogicalProviderAtMatchedStartup(input: {
	pi: Parameters<typeof registerLogicalProviderForSession>[0];
	installed: unknown;
	liveCatalogs: ModelsCatalogs;
	deps: LogicalProviderDeps;
	attributionStoreFactory?: () => LogicalAttributionLifecycle;
	registerLogicalApi?: LogicalApiRegistrar;
}): {
	status: ReturnType<typeof inspectInstalledDeclaration>;
	expectedModels: ReturnType<typeof buildModelDeclaration>["models"];
} {
	const {
		pi,
		installed,
		liveCatalogs,
		deps,
		attributionStoreFactory,
		registerLogicalApi,
	} = input;
	const expected = buildModelDeclaration(liveCatalogs);
	const status = inspectInstalledDeclaration(installed, expected.models);
	if (status === "matched" || status === "mismatched") {
		for (const diagnostic of expected.diagnostics) deps.onDiagnostic?.(diagnostic);
		const attribution = attributionStoreFactory?.();
		const attributedDeps =
			attribution === undefined
				? deps
				: Object.defineProperty(Object.create(deps) as LogicalProviderDeps, "attribution", {
						value: attribution,
						enumerable: true,
					});
		registerLogicalProviderForSession(
			pi,
			expected.models,
			attributedDeps,
			registerLogicalApi,
		);
	}
	return { status, expectedModels: expected.models };
}

const NOOP_ROUTE_INDICATOR_ATTEMPT: LogicalRouteIndicatorAttempt = Object.freeze({
	completed() {},
	failed() {},
	cancelled() {},
});

/** Composes the retained attribution lifecycle with its fail-soft footer observer. */
export function decorateLogicalAttributionLifecycle(
	real: LogicalAttributionLifecycle,
	indicator: LogicalRouteIndicator,
): LogicalAttributionLifecycle {
	const isolated = (call: () => void): void => {
		try {
			call();
		} catch {
			// Neither the retained store nor the footer may break dispatch lifecycle.
		}
	};
	const composedAttempt = (
		realAttempt: LogicalAttributionAttempt,
		indicatorAttempt: LogicalRouteIndicatorAttempt,
	): LogicalAttributionAttempt => ({
		onResponse: (response) => isolated(() => realAttempt.onResponse(response)),
		onAuthentication: (success) =>
			isolated(() => realAttempt.onAuthentication(success)),
		onModelSupport: (supported) =>
			isolated(() => realAttempt.onModelSupport(supported)),
		onHealth: (health) => isolated(() => realAttempt.onHealth(health)),
		onPayload: (payload) => isolated(() => realAttempt.onPayload(payload)),
		finish: (message) => {
			isolated(() => realAttempt.finish(message));
			isolated(() => indicatorAttempt.completed());
		},
		fail: (message, failure) => {
			let accepted: boolean | void = false;
			try {
				accepted = realAttempt.fail(message, failure);
			} catch {
				accepted = false;
			}
			isolated(() => indicatorAttempt.failed());
			return accepted;
		},
		abort: (message) => {
			isolated(() => realAttempt.abort(message));
			isolated(() => indicatorAttempt.cancelled());
		},
		waitForTerminal: () => realAttempt.waitForTerminal(),
		bindPublicTerminal: (physical, publicMessage) =>
			isolated(() => realAttempt.bindPublicTerminal?.(physical, publicMessage)),
	});
	return {
		beginAttempt(route) {
			const realAttempt = safeBeginAttributionAttempt(real, route);
			if (realAttempt === NOOP_LOGICAL_ATTRIBUTION_ATTEMPT) {
				return NOOP_LOGICAL_ATTRIBUTION_ATTEMPT;
			}
			let indicatorAttempt = NOOP_ROUTE_INDICATOR_ATTEMPT;
			isolated(() => {
				indicatorAttempt = indicator.beginAttempt({
					providerId: route.providerId,
					family: route.family,
				});
			});
			return composedAttempt(realAttempt, indicatorAttempt);
		},
		settle() {
			isolated(() => real.settle());
			isolated(() => indicator.settle());
		},
		shutdown() {
			isolated(() => real.shutdown());
			isolated(() => indicator.shutdown());
		},
	};
}

/**
 * Projects shared usage into the routing hint.
 *
 * `holdUntilMs` is passed separately from the snapshot because a hold is not a
 * usage reading: it can be active when there is no snapshot at all, and a
 * healthy snapshot must not clear it. Returning a hint for a hold with no
 * snapshot is deliberate -- that is exactly the case where the five-minute TTL
 * has lapsed but the account is still spent.
 */
function sharedUsageHint(
	fleet: SharedUsageSnapshot | undefined,
	holdUntilMs?: number,
): SharedUsageHint | undefined {
	if (fleet === undefined) {
		return holdUntilMs === undefined ? undefined : { holdUntilMs };
	}
	return {
		...(fleet.remainingRequests === undefined
			? {}
			: { remainingRequests: fleet.remainingRequests }),
		...(fleet.remainingTokens === undefined
			? {}
			: { remainingTokens: fleet.remainingTokens }),
		...(fleet.recoveryAtMs === undefined
			? {}
			: { recoveryAtMs: fleet.recoveryAtMs }),
		...(fleet.utilization === undefined
			? {}
			: { utilization: fleet.utilization }),
		...(holdUntilMs === undefined ? {} : { holdUntilMs }),
		ageMs: fleet.ageMs,
	};
}

function numericHeader(
	headers: Readonly<Record<string, string>>,
	name: string,
): number | undefined {
	const entry = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name,
	);
	if (!entry || !/^\d+(?:\.\d+)?$/.test(entry[1].trim())) return undefined;
	const value = Number(entry[1]);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizedHeaders(
	headers: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
	const normalized = new Map<string, string>();
	for (const [name, value] of Object.entries(headers)) {
		if (name.length > 64 || value.length > 128) continue;
		const normalizedName = name.toLowerCase();
		if (
			OBSERVED_RATE_LIMIT_HEADERS.has(normalizedName) ||
			isUnifiedUtilizationHeader(normalizedName)
		) {
			normalized.set(normalizedName, value);
		}
	}
	return normalized;
}

function firstHeader(
	headers: ReadonlyMap<string, string>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = headers.get(name);
		if (value !== undefined) return value;
	}
	return undefined;
}

function headerCount(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 32 || !/^\d+$/.test(trimmed))
		return undefined;
	const count = Number(trimmed);
	return Number.isSafeInteger(count) ? count : undefined;
}

function checkedRecovery(
	observedAtMs: number,
	delayMs: number,
): number | undefined {
	if (!Number.isFinite(delayMs) || delayMs < 0) return undefined;
	const recoveryAtMs = observedAtMs + Math.ceil(delayMs);
	return Number.isSafeInteger(recoveryAtMs) ? recoveryAtMs : undefined;
}

function durationMultiplier(unit: string): number {
	switch (unit) {
		case "h":
			return 3_600_000;
		case "m":
			return 60_000;
		case "s":
			return 1_000;
		default:
			return 1;
	}
}

function durationMs(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 64) return undefined;
	const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
	if (
		matches.length === 0 ||
		matches.map((match) => match[0]).join("") !== trimmed
	) {
		return undefined;
	}
	let total = 0;
	for (const match of matches) {
		total += Number(match[1]) * durationMultiplier(match[2] ?? "");
		if (!Number.isFinite(total) || total < 0) return undefined;
	}
	return total;
}

function absoluteRecovery(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 128) return undefined;
	if (/^\d{10}(?:\.\d+)?$/.test(trimmed)) {
		const epochMs = Number(trimmed) * 1_000;
		return Number.isSafeInteger(epochMs) ? epochMs : undefined;
	}
	if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !/GMT$/i.test(trimmed))
		return undefined;
	const epochMs = Date.parse(trimmed);
	return Number.isFinite(epochMs) && epochMs >= 0 ? epochMs : undefined;
}

function retryAfterRecovery(
	headers: ReadonlyMap<string, string>,
	observedAtMs: number,
): number | undefined {
	const milliseconds = headerCount(headers.get("retry-after-ms"));
	if (milliseconds !== undefined)
		return checkedRecovery(observedAtMs, milliseconds);
	const value = headers.get("retry-after")?.trim();
	if (!value || value.length > 128) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		return checkedRecovery(observedAtMs, Number(value) * 1_000);
	}
	const absolute = absoluteRecovery(value);
	return absolute !== undefined && absolute >= observedAtMs
		? absolute
		: undefined;
}

function rateLimitObservation(
	rawHeaders: Readonly<Record<string, string>>,
	observedAtMs: number,
): RateLimitObservation | undefined {
	const headers = normalizedHeaders(rawHeaders);
	const remainingRequests = headerCount(
		firstHeader(headers, REMAINING_REQUEST_HEADERS),
	);
	const remainingTokens = headerCount(
		firstHeader(headers, REMAINING_TOKEN_HEADERS),
	);
	const utilizationEntry = [...headers.entries()].find(
		([name, value]) =>
			isUnifiedUtilizationHeader(name) &&
			/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value.trim()),
	);
	const utilization =
		utilizationEntry === undefined
			? codexUtilizationFromHeaders(headers)
			: normalizeHeaderUtilization(Number(utilizationEntry[1]));
	// `retry-after`/`retry-after-ms` is failure-backed: it only appears on a real
	// limit, so it is always a genuine recovery time.
	const retryAfter = retryAfterRecovery(headers, observedAtMs);
	// A routine `*-reset` header announces the window boundary whether or not the
	// window is spent, so on a healthy response it is NOT a recovery time.
	// `recoveryAtMs` means "this account is out and recovers at T", and
	// `snapshotIndicatesExhaustion` treats any future `recoveryAtMs` as
	// exhaustion, so carrying a plain future reset marked a healthy subscription
	// exhausted (e.g. an Anthropic weekly reset with thousands of requests still
	// remaining) and demoted it until that reset (#73). Let a reset header
	// contribute a recovery time only when an actual exhaustion signal is present.
	const exhausted =
		remainingRequests === 0 ||
		remainingTokens === 0 ||
		(utilization !== undefined && utilization >= 1) ||
		retryAfter !== undefined;
	const recoveryCandidates = [retryAfter];
	if (exhausted) {
		for (const name of DURATION_RESET_HEADERS) {
			const value = headers.get(name);
			recoveryCandidates.push(
				checkedRecovery(observedAtMs, durationMs(value) ?? Number.NaN),
				absoluteRecovery(value),
			);
		}
		for (const name of ABSOLUTE_RESET_HEADERS) {
			recoveryCandidates.push(absoluteRecovery(headers.get(name)));
		}
	}
	const validRecoveries = recoveryCandidates.filter(
		(candidate): candidate is number =>
			candidate !== undefined && candidate >= observedAtMs,
	);
	const recoveryAtMs =
		validRecoveries.length > 0 ? Math.max(...validRecoveries) : undefined;
	if (
		remainingRequests === undefined &&
		remainingTokens === undefined &&
		recoveryAtMs === undefined &&
		utilization === undefined
	) {
		return undefined;
	}
	return {
		...(remainingRequests === undefined ? {} : { remainingRequests }),
		...(remainingTokens === undefined ? {} : { remainingTokens }),
		...(recoveryAtMs === undefined ? {} : { recoveryAtMs }),
		...(utilization === undefined ? {} : { utilization }),
		utilizationSource: "rate-limit-header",
	};
}

function tokenUsage(message: AssistantMessage): TokenUsageObservation {
	return {
		inputTokens: message.usage.input,
		outputTokens: message.usage.output,
		cacheCreationInputTokens: message.usage.cacheWrite,
		cacheReadInputTokens: message.usage.cacheRead,
	};
}

/**
 * A failure observed and classified on `message_end`, held until the run
 * settles. It carries only what classification produced; the account set and
 * routing decision are recomputed at the settlement boundary so the switch acts
 * on the fleet as it stands then, not as it stood on the first failed attempt.
 */
interface ClassifiedFailure {
	readonly providerId: string;
	readonly family: ManagedFamily;
	readonly failure: ProviderFailureSignal;
	readonly alreadyCooled?: boolean;
	/**
	 * When the failure was classified, not when the turn settled.
	 *
	 * The debounce is keyed to this: a usage poll that ran after the failure but
	 * before settlement has already answered this failure's question, and must
	 * suppress the extra refresh. Keying to settlement time would miss that and
	 * poll again.
	 */
	readonly failedAtMs?: number;
}

type LogicalTerminalOutcome = "finish" | "fail" | "abort";

export function logicalTerminalRetiresPendingFailure(
	outcome: LogicalTerminalOutcome,
): boolean {
	return outcome === "finish" || outcome === "abort";
}

interface PhysicalRouteAssociation {
	readonly generation: number;
	readonly route: LogicalRouteFact;
	readonly outcome: LogicalTerminalOutcome;
	readonly alreadyCooled: boolean;
	readonly dispatchedModelId?: string;
	readonly failure?: ProviderFailureSignal;
	/** Bounded response status/reset fact bound to THIS exact terminal attempt. */
	readonly response?: ProviderFailureSignal;
	/** Transient only; removes a provisional cooldown if identity fails closed. */
	readonly rollbackCooldown?: () => void;
}

export function createLogicalTerminalAssociationStore() {
	let generation = 0;
	let associations = new WeakMap<AssistantMessage, PhysicalRouteAssociation>();
	let publicTerminals = new WeakMap<AssistantMessage, AssistantMessage>();
	let publishedPhysical = new WeakSet<AssistantMessage>();
	let activeRollbacks = new Set<() => void>();
	let ambiguous = new WeakSet<AssistantMessage>();
	let recentAmbiguous: WeakRef<AssistantMessage>[] = [];
	const rollback = (association: PhysicalRouteAssociation | undefined): void => {
		const receipt = association?.rollbackCooldown;
		if (receipt === undefined) return;
		activeRollbacks.delete(receipt);
		try {
			receipt();
		} catch {
			// Failing closed must not replace the provider terminal.
		}
	};
	const commit = (association: PhysicalRouteAssociation | undefined): void => {
		if (association?.rollbackCooldown !== undefined) {
			activeRollbacks.delete(association.rollbackCooldown);
		}
	};
	const rememberAmbiguous = (message: AssistantMessage): void => {
		if (ambiguous.has(message)) return;
		ambiguous.add(message);
		recentAmbiguous.push(new WeakRef(message));
		if (recentAmbiguous.length > 64) recentAmbiguous.shift();
	};
	const rollbackGeneration = (): void => {
		const receipts = [...activeRollbacks];
		activeRollbacks.clear();
		for (let index = receipts.length - 1; index >= 0; index -= 1) {
			try {
				receipts[index]!();
			} catch {
				// Every remaining receipt still gets one rollback attempt.
			}
		}
	};
	return {
		associate(
			route: LogicalRouteFact,
			message: AssistantMessage,
			outcome: LogicalTerminalOutcome,
			failure: LogicalTerminalFailureFact | undefined,
			response?: ProviderFailureSignal,
		): void {
			const existing = associations.get(message);
			if (existing !== undefined || ambiguous.has(message)) {
				// The current attempt wrote after the prior attempt. Undo in reverse
				// order so each receipt sees the cooldown state it created.
				try {
					failure?.rollbackCooldown?.();
				} catch {
					// The terminal remains ambiguous even if rollback itself fails soft.
				}
				rollback(existing);
				associations.delete(message);
				rememberAmbiguous(message);
				return;
			}
			const association = Object.freeze({
				generation,
				route,
				outcome,
				alreadyCooled: failure?.alreadyCooled === true,
				...(response === undefined ? {} : { response }),
				...(failure === undefined
					? {}
					: {
							dispatchedModelId: failure.dispatchedModelId,
							...(failure.failure === undefined
								? {}
								: { failure: failure.failure }),
							...(failure.rollbackCooldown === undefined
								? {}
								: { rollbackCooldown: failure.rollbackCooldown }),
						}),
			});
			associations.set(message, association);
			if (association.rollbackCooldown !== undefined) {
				activeRollbacks.add(association.rollbackCooldown);
			}
			if (activeRollbacks.size > 64) {
				// Receipt ordering can overlap across duplicate-account slots. Evicting
				// one would break that dependency, so fail closed for the generation.
				rollbackGeneration();
				generation += 1;
				associations = new WeakMap<AssistantMessage, PhysicalRouteAssociation>();
				ambiguous = new WeakSet<AssistantMessage>();
				recentAmbiguous = [];
				rememberAmbiguous(message);
			}
		},
		bindPublicTerminal(physical: AssistantMessage, publicMessage: AssistantMessage): void {
			if (associations.has(physical) && !ambiguous.has(physical) && !publicTerminals.has(publicMessage)) {
				publicTerminals.set(publicMessage, physical);
				publishedPhysical.add(physical);
			}
		},
		consume(message: AssistantMessage): PhysicalRouteAssociation | undefined {
			const physical = publicTerminals.get(message) ?? message;
			if (physical === message && publishedPhysical.has(message)) return undefined;
			const association = associations.get(physical);
			try {
				if (ambiguous.has(physical)) return undefined;
				if (association?.generation !== generation) {
					rollback(association);
					return undefined;
				}
				return association;
			} finally {
				associations.delete(physical);
				publicTerminals.delete(message);
			}
		},
		complete(
			association: PhysicalRouteAssociation | undefined,
			accepted: boolean,
		): void {
			if (accepted) commit(association);
			else rollback(association);
		},
		advanceGeneration(): void {
			rollbackGeneration();
			generation += 1;
			associations = new WeakMap<AssistantMessage, PhysicalRouteAssociation>();
			publicTerminals = new WeakMap<AssistantMessage, AssistantMessage>();
			publishedPhysical = new WeakSet<AssistantMessage>();
			activeRollbacks = new Set<() => void>();
			ambiguous = new WeakSet<AssistantMessage>();
			recentAmbiguous = [];
		},
	};
}

export interface TurnRouteOrigin {
	readonly providerId: string;
	readonly family: AllowedFamily;
	readonly requestedModelId?: string;
	readonly expectedAutomaticProviderId?: string;
	readonly logical: boolean;
}

export function preserveTurnRouteOrigin(
	existing: TurnRouteOrigin | undefined,
	firstSubscriptionOrigin: TurnRouteOrigin | undefined,
): TurnRouteOrigin | undefined {
	return existing ?? firstSubscriptionOrigin;
}

function failureSignal(
	event: ProviderResponseObservation,
): ProviderFailureSignal {
	const retryAfterSeconds = numericHeader(event.headers, "retry-after");
	const resetSeconds = numericHeader(event.headers, "x-ratelimit-reset");
	return {
		httpStatus: event.status,
		...(retryAfterSeconds === undefined
			? {}
			: { retryAfterSeconds: Math.floor(retryAfterSeconds) }),
		...(resetSeconds === undefined
			? {}
			: { resetAtMs: Math.floor(resetSeconds * 1_000) }),
	};
}

/**
 * Whether a quota refusal left us guessing when the account comes back.
 *
 * A bounded hold is only warranted when the provider said nothing about
 * recovery. `retry-after: 5` means five seconds, and imposing a 60-minute hold
 * over it would shrink the usable fleet on a refusal the provider already told
 * us was momentary. The measured defect is the silent case: 28 header-reported
 * exhaustions carrying no recovery time at all.
 */
function refusalWithoutRecoveryTime(failure: ProviderFailureSignal): boolean {
	return (
		failure.retryAfterSeconds === undefined && failure.resetAtMs === undefined
	);
}

function boundedPhysicalIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function physicalMessageIdentity(
	message: unknown,
	context: ExtensionContext,
): { readonly providerId: string; readonly modelId: string } | undefined {
	const providerId = context.model?.provider;
	const modelId = context.model?.id;
	if (!boundedPhysicalIdentity(providerId) || !boundedPhysicalIdentity(modelId)) {
		return undefined;
	}
	let terminalProviderId: string | undefined;
	let terminalModelId: string | undefined;
	if (typeof message === "object" && message !== null) {
		const terminal = message as Record<string, unknown>;
		if (Object.prototype.hasOwnProperty.call(terminal, "provider")) {
			const value = terminal["provider"];
			if (!boundedPhysicalIdentity(value)) return undefined;
			terminalProviderId = value;
		}
		if (Object.prototype.hasOwnProperty.call(terminal, "modelId")) {
			const value = terminal["modelId"];
			if (!boundedPhysicalIdentity(value)) return undefined;
			terminalModelId = value;
		}
	}
	if (
		(terminalProviderId !== undefined && terminalProviderId !== providerId) ||
		(terminalModelId !== undefined && terminalModelId !== modelId)
	) {
		return undefined;
	}
	return { providerId, modelId };
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as Record<string, unknown>)["role"] === "assistant"
	);
}

function isFailedAssistant(message: unknown): message is AssistantMessage {
	return (
		isAssistantMessage(message) &&
		(message as unknown as Record<string, unknown>)["stopReason"] === "error"
	);
}

function isSuccessfulAssistant(message: unknown): boolean {
	if (!isAssistantMessage(message)) return false;
	const stopReason = (message as unknown as Record<string, unknown>)[
		"stopReason"
	];
	return (
		stopReason === "stop" ||
		stopReason === "length" ||
		stopReason === "toolUse"
	);
}

function isAbortedAssistant(message: unknown): boolean {
	return (
		isAssistantMessage(message) &&
		(message as unknown as Record<string, unknown>)["stopReason"] === "aborted"
	);
}

/** Copy ordinary enumerable message fields without invoking accessor values. */
function cloneEnumerableMessageFields(message: object): Record<string, unknown> {
	const clone: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(message))) {
		if (descriptor.enumerable) Object.defineProperty(clone, key, descriptor);
	}
	return clone;
}

function providerModels(
	context: ExtensionContext,
	providerId: string,
): Model<Api>[] {
	return context.modelRegistry
		.getAll()
		.filter((model) => model.provider === providerId);
}

/**
 * Picks the model to run on a destination account, preferring the one the
 * failed turn was already using.
 *
 * Accounts carry `model: models[0]` -- the head of whatever order the registry
 * returned -- because a slot needs SOME representative model to exist. Routing
 * then used that head as the destination model, so a switch silently changed
 * which model answered. Observed live on 2026-08-05: a turn running opus was
 * rate-limited, failed over correctly, and resumed on fable, because fable
 * happened to sit first in the destination's catalog.
 *
 * Same-family accounts serve the same catalog, so the model the operator chose
 * is almost always available on the destination; falling back to the head is
 * only correct when it genuinely is not. Failing over is meant to change WHICH
 * ACCOUNT serves the turn, never WHICH MODEL answers it.
 */
export function destinationModel(
	account: OperatorAccount & SubscriptionManagedAccount,
	context: ExtensionContext | undefined,
	failedModelId: string | undefined,
	failedFamily?: AllowedFamily,
	preferredModels?: Readonly<Record<string, readonly string[]>>,
): Model<Api> {
	if (context === undefined) return account.model;
	const available = providerModels(context, account.providerId);

	// Crossing families DROPS the failed model id: `claude-opus-5` is meaningless
	// in the Codex catalog, so matching by id can only miss, and the fallback
	// would be the catalog HEAD -- whatever happens to sit first. That is the
	// defect fixed in 37c4317, where an opus turn silently resumed on fable.
	//
	// Ported from Sarrius (index.ts:3784-3790), which reached the same shape: a
	// per-family preference list rather than N-by-N model pairs. Same-family
	// failover keeps the exact model, which is what 37c4317 guarantees.
	const sameFamily =
		failedFamily === undefined || failedFamily === account.family;
	const candidateIds = [
		...(sameFamily && failedModelId !== undefined ? [failedModelId] : []),
		...(preferredModels?.[account.family] ?? []),
	];
	for (const id of candidateIds) {
		// A preferred model the destination does not actually serve is SKIPPED
		// rather than selected: shipping a model the account cannot serve would
		// fail at dispatch, after the switch has already been reported.
		const match = available.find((candidate) => candidate.id === id);
		if (match) return match;
	}
	return account.model;
}

function routeCandidateModel(
	candidate: AvailableRouteCandidate,
	account: (OperatorAccount & ManagedAccount) | undefined,
	context: ExtensionContext | undefined,
	originModelId: string | undefined,
	originFamily: AllowedFamily,
	preferredModels: Readonly<Record<string, readonly string[]>>,
): Model<Api> | undefined {
	if (
		account === undefined ||
		account.providerId !== candidate.destination.providerId
	) {
		return undefined;
	}
	if (candidate.routeKind === "owning-vendor-api") {
		return context === undefined
			? undefined
			: providerModels(context, candidate.destination.providerId).find(
					(model) => model.id === candidate.resolvedModelId,
				);
	}
	if (!isRoutingEligibleAccountFamily(account)) return undefined;
	return destinationModel(
		account,
		context,
		originModelId,
		originFamily,
		preferredModels,
	);
}

function managedFamily(providerId: string): AllowedFamily | undefined {
	return ALLOWED_FAMILIES.find((family) =>
		isCanonicalManagedProviderId(providerId, family),
	);
}

/**
 * The logical provider's view of the managed accounts, derived fresh.
 *
 * This must be recomputed for every request rather than snapshotted at startup.
 * `clear`, `disable` and credential expiry all change who may serve a turn, and
 * a snapshot taken when the session opened would keep routing to an account the
 * operator has since switched off — the exact "a transient condition became
 * permanent" failure the routing rules exist to prevent.
 *
 * A provably dead credential is carried as `authenticated: false` rather than
 * as a credential field. The logical account shape holds no credential, and it
 * should not: the only thing selection needs to know is whether the account can
 * still authenticate, and that answer is derivable without the secret.
 */
export function logicalAccountsFromManaged(
	accounts: readonly ManagedAccount[],
	nowMs: number,
): LogicalPhysicalAccount[] {
	return accounts.map((account) => ({
		providerId: account.providerId,
		family: account.family,
		providerType: providerTypeFor(
			account.family,
			account.credentialType ?? "unknown",
		),
		modelIds: [...(account.modelIds ?? [])],
		...(account.accountFingerprint === undefined
			? {}
			: { accountFingerprint: account.accountFingerprint }),
		exhausted: snapshotIndicatesExhaustion(
			account.fleetUsage,
			nowMs,
			"all-observed",
		),
		authenticated:
			account.credential === undefined
				? true
				: isCredentialUsable(account.credential, nowMs),
	}));
}

/**
 * Whether a persisted model selection for this provider is ours to restore.
 *
 * A physical alias qualifies, and so does the logical provider. Leaving the
 * logical provider out is not a cosmetic omission: Pi restores the session
 * model inside `createAgentSession`, strictly before extensions load, so a
 * selection this predicate rejects is simply never reinstated and the operator
 * silently resumes on a different model than the one they left on.
 */
export function isRestorableManagedProvider(
	providerId: string,
	accountLimit: number,
): boolean {
	if (providerId === LOGICAL_PROVIDER_ID) return true;
	const slot = classifyProviderId({ providerId, credentialType: "unknown" });
	return slot !== null &&
		isProviderSlotWithinAccountLimit(slot, accountLimit);
}

function continuationReason(
	category: FailureCategory,
	code?: ProviderFailureSignal["code"],
):
	| "rate-limit"
	| "terminal-auth-failure"
	| "permission"
	| "model-not-found"
	| undefined {
	if (code === "model_not_found") return "model-not-found";
	switch (category) {
		case "quota-rate-limit":
			return "rate-limit";
		case "terminal-auth":
			return "terminal-auth-failure";
		case "permission":
			return "permission";
		default:
			return undefined;
	}
}

async function loadMaintainedCodexStream(): Promise<
	NonNullable<ProviderConfig["streamSimple"]>
> {
	const publicRoot = await import("@earendil-works/pi-ai");
	const compatibilityStream = (
		publicRoot as unknown as Record<string, unknown>
	)["streamSimpleOpenAICodexResponses"];
	if (typeof compatibilityStream === "function") {
		return compatibilityStream as NonNullable<ProviderConfig["streamSimple"]>;
	}
	const maintainedApi = await import(
		"@earendil-works/pi-ai/api/openai-codex-responses"
	);
	return maintainedApi.streamSimple as unknown as NonNullable<
		ProviderConfig["streamSimple"]
	>;
}

/**
 * Fail-closed sentinel used only when the host codex OAuth surface is
 * unavailable at session_start (host shape drift). Its OAuth callbacks throw a
 * clear diagnostic if ever reached; when this sentinel is in effect the codex
 * slots are also filtered out of discovery so the callbacks are never invoked.
 * Anthropic multi-account is unaffected. The enabled path uses
 * {@link createCodexCaptureFromHost} instead.
 */
const CODEX_DISABLED_DIAGNOSTIC =
	"[openai-codex] Codex multi-account is unavailable: the host openai-codex " +
	"provider or its OAuth surface could not be resolved at startup. Anthropic " +
	"multi-account is unaffected.";

function createDisabledCodexCapture(
	maintainedCodexStream: NonNullable<ProviderConfig["streamSimple"]>,
): CapturedCodexProvider {
	const disabled = (): never => {
		throw new Error(CODEX_DISABLED_DIAGNOSTIC);
	};
	return {
		name: CODEX_PROVIDER,
		baseUrl: "https://chatgpt.com/backend-api",
		oauth: {
			name: "OpenAI Codex (unavailable)",
			login: disabled,
			refreshToken: disabled,
			getApiKey: disabled,
		} as unknown as CapturedCodexProvider["oauth"],
		streamSimple: maintainedCodexStream,
		models: [],
	};
}

/**
 * Minimal shape of the host's pi-ai OAuth surface exposed at
 * `ExtensionContext.modelRegistry.getProvider("openai-codex").auth.oauth`:
 * `{ name, loginLabel?, login, refresh, toAuth }` (all async). `refresh` keeps
 * an alias credential fresh across a long session; `login` lets an alias slot
 * be signed in directly, which is the only way to recover an expired alias
 * credential (base login writes only the base slot's key).
 */
interface HostCodexOAuth {
	readonly name?: string;
	readonly refresh: (
		credential: {
			readonly access: string;
			readonly refresh: string;
			readonly expires: number;
		},
		signal?: AbortSignal,
	) => Promise<{ access: string; refresh: string; expires: number }>;
	/**
	 * Native codex sign-in. Takes a host `AuthInteraction`
	 * (`{ prompt, notify, signal }`), which is NOT the shape Pi hands an
	 * extension's `login` (`{ onPrompt, onAuth, onDeviceCode, onSelect, ... }`).
	 * Both take one argument, so arity proves nothing here — forwarding the
	 * extension callbacks unchanged fails at runtime with "interaction.prompt is
	 * not a function". Callers must translate via {@link toHostAuthInteraction}.
	 * Optional because a Pi build without it must degrade rather than crash.
	 */
	readonly login?: (
		interaction: HostAuthInteraction,
	) => Promise<{ access: string; refresh: string; expires: number }>;
}

/** The host's login interaction surface: `{ prompt, notify, signal }`. */
interface HostAuthInteraction {
	readonly signal?: AbortSignal | undefined;
	prompt(prompt: HostAuthPrompt): Promise<string>;
	notify(event: HostAuthEvent): void;
}

type HostAuthPrompt = { readonly signal?: AbortSignal } & (
	| {
			readonly type: "text" | "secret" | "manual_code";
			readonly message: string;
			readonly placeholder?: string;
	  }
	| {
			readonly type: "select";
			readonly message: string;
			readonly options: readonly {
				readonly id: string;
				readonly label: string;
				readonly description?: string;
			}[];
	  }
);

type HostAuthEvent =
	| { readonly type: "info" | "progress"; readonly message: string }
	| {
			readonly type: "auth_url";
			readonly url: string;
			readonly instructions?: string;
	  }
	| {
			readonly type: "device_code";
			readonly userCode: string;
			readonly verificationUri: string;
			readonly intervalSeconds?: number;
			readonly expiresInSeconds?: number;
	  };

/** The extension-side callback surface Pi hands to a provider's `login`. */
export interface ExtensionLoginCallbacks {
	onAuth?(info: { url: string; instructions?: string }): void;
	onDeviceCode?(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	onPrompt?(prompt: { message: string; placeholder?: string }): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect?(prompt: {
		message: string;
		options: { id: string; label: string }[];
	}): Promise<string | undefined>;
	signal?: AbortSignal;
}

/**
 * Adapts Pi's extension login callbacks to the host's `AuthInteraction`.
 *
 * Codex alias login delegates to the host's native flow, but the host drives it
 * through `interaction.prompt(...)` / `interaction.notify(...)` while Pi hands
 * an extension a differently-shaped `onPrompt` / `onAuth` / `onDeviceCode`
 * object. Without this translation the host's first call throws
 * "interaction.prompt is not a function" and the operator cannot sign in.
 *
 * A `select` prompt maps to `onSelect`, falling back to the first option when
 * the surface cannot ask, so an unanswerable choice does not strand the flow.
 * Notifications degrade to `onProgress` rather than throwing: a missing
 * progress message must never fail an otherwise working login.
 */
export function toHostAuthInteraction(
	callbacks: ExtensionLoginCallbacks,
): HostAuthInteraction {
	return {
		...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
		async prompt(prompt: HostAuthPrompt): Promise<string> {
			if (prompt.type === "select") {
				const selected = await callbacks.onSelect?.({
					message: prompt.message,
					options: prompt.options.map((option) => ({
						id: option.id,
						label: option.label,
					})),
				});
				if (selected !== undefined) return selected;
				const fallback = prompt.options[0]?.id;
				if (fallback !== undefined) return fallback;
				throw new Error(
					"[openai-codex] Login needs a choice this surface cannot present.",
				);
			}
			if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
				return callbacks.onManualCodeInput();
			}
			if (callbacks.onPrompt) {
				return callbacks.onPrompt({
					message: prompt.message,
					...(prompt.placeholder === undefined
						? {}
						: { placeholder: prompt.placeholder }),
				});
			}
			throw new Error(
				"[openai-codex] Login needs input this surface cannot collect.",
			);
		},
		notify(event: HostAuthEvent): void {
			if (event.type === "auth_url") {
				callbacks.onAuth?.({
					url: event.url,
					...(event.instructions === undefined
						? {}
						: { instructions: event.instructions }),
				});
				return;
			}
			if (event.type === "device_code") {
				callbacks.onDeviceCode?.({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					...(event.intervalSeconds === undefined
						? {}
						: { intervalSeconds: event.intervalSeconds }),
					...(event.expiresInSeconds === undefined
						? {}
						: { expiresInSeconds: event.expiresInSeconds }),
				});
				return;
			}
			callbacks.onProgress?.(event.message);
		},
	};
}

/**
 * Reads the host's codex OAuth surface via the public model-registry facade
 * (`getProvider("openai-codex").auth.oauth`), returning it only when the shape
 * we depend on (`refresh`) is present. Any absence or shape drift yields
 * undefined so the caller can fail closed. No credential value is read here.
 */
function resolveHostCodexOAuth(
	context: ExtensionContext,
): HostCodexOAuth | undefined {
	const registry = context.modelRegistry as unknown as {
		getProvider?: (providerId: string) => unknown;
	};
	if (typeof registry.getProvider !== "function") return undefined;
	let provider: unknown;
	try {
		provider = registry.getProvider(CODEX_PROVIDER);
	} catch {
		return undefined;
	}
	const auth = (provider as { auth?: { oauth?: unknown } } | undefined)?.auth;
	const oauth = auth?.oauth as
		| { refresh?: unknown; login?: unknown; name?: unknown }
		| undefined;
	if (!oauth || typeof oauth.refresh !== "function") return undefined;
	return oauth as unknown as HostCodexOAuth;
}

/**
 * Builds a real codex capture on Pi 0.81.1 from the host's native codex OAuth
 * surface. The alias `ExtensionOAuthConfig` mirrors the working anthropic
 * pattern:
 *   - `getApiKey: (credentials) => credentials.access` — Pi resolves and
 *     refreshes the OAuth token itself and passes the resolved credentials in
 *     synchronously, so surfacing the access token is all that is required.
 *   - `refreshToken` wraps the host codex OAuth's async `refresh` (the pi-ai
 *     `OAuthCredential` and extension `OAuthCredentials` shapes are
 *     structurally compatible), so a codex alias credential stays fresh across
 *     a long session.
 *   - `login` bridges to the host's native codex sign-in, exactly as
 *     `refreshToken` bridges to its `refresh`. Pi stores the resulting
 *     credential under whichever slot the operator selected, so an alias slot
 *     can be authenticated directly. Without this an expired alias credential
 *     was unrecoverable, because base login only ever writes the base slot's
 *     key. When a host exposes no `login`, the alias says so plainly instead
 *     of advising a workaround that cannot work.
 * If the host codex OAuth surface is unavailable, returns `enabled: false` with
 * a disabled sentinel capture; the caller then filters codex slots out of
 * discovery so those throwing callbacks are never reached (REQ-CODEX-FAILCLOSED-1).
 */
function createCodexCaptureFromHost(
	context: ExtensionContext,
	maintainedCodexStream: NonNullable<ProviderConfig["streamSimple"]>,
): { capture: CapturedCodexProvider; enabled: boolean } {
	const hostOAuth = resolveHostCodexOAuth(context);
	if (!hostOAuth) {
		return {
			capture: createDisabledCodexCapture(maintainedCodexStream),
			enabled: false,
		};
	}
	const hostLogin = hostOAuth.login;
	const oauth = {
		name: "OpenAI Codex",
		// Translate rather than forward: the host drives login through
		// `interaction.prompt/notify` while Pi supplies `onPrompt`/`onAuth`/
		// `onDeviceCode`. Forwarding raw throws "interaction.prompt is not a
		// function" on the host's very first call.
		login: (callbacks: ExtensionLoginCallbacks) => {
			if (typeof hostLogin !== "function") {
				throw new Error(
					"[openai-codex] This Pi build exposes no codex OAuth login, so this " +
						"account cannot be signed in from here.",
				);
			}
			return hostLogin.call(hostOAuth, toHostAuthInteraction(callbacks));
		},
		refreshToken: async (credentials: {
			access: string;
			refresh: string;
			expires: number;
		}) =>
			// Merge rather than return the host's response raw: a refresh that
			// mints no new refresh token would otherwise drop the stored one and
			// make the credential unrecoverable (REQ-REFRESH-MERGE-1).
			mergeRefreshedCredentials(
				credentials,
				await hostOAuth.refresh(credentials),
			),
		getApiKey: (credentials: { access: string }): string => credentials.access,
	} as unknown as CapturedCodexProvider["oauth"];
	return {
		capture: {
			name: CODEX_PROVIDER,
			baseUrl: "https://chatgpt.com/backend-api",
			oauth,
			streamSimple: maintainedCodexStream,
			models: [],
		},
		enabled: true,
	};
}

/**
 * Strips only the `openai-codex` (Codex subscription) family from a discovery
 * result when Codex is disabled, so its disabled-sentinel throwing callbacks are
 * never reached. The `anthropic` subscription and the independent `openai`
 * platform family both survive: the `openai` platform API is a distinct vendor
 * unrelated to the Codex fail-closed, so an `openai` account must still be
 * discovered and adopted in a Codex-disabled host (#51 AC3/AC4).
 */
function codexDisabledDiscovery(result: DiscoveryResult): DiscoveryResult {
	const spareSlots = new Map(result.spareSlots);
	spareSlots.delete(CODEX_PROVIDER);
	return {
		...result,
		slots: result.slots.filter((slot) => slot.family !== "openai-codex"),
		spareSlots,
	};
}


/**
 * Reads one managed account's CURRENT stored credential and projects it into
 * bounded metadata.
 *
 * Deliberately re-reads on every call rather than reusing a discovery snapshot.
 * A snapshot records expiry as it stood when the session started; Pi refreshes
 * credentials lazily in the background, so within hours a long-lived session's
 * snapshot describes tokens that have since been replaced. Reporting from it
 * makes healthy accounts appear expired and tells the operator to sign in when
 * nothing is wrong.
 *
 * The raw access value is used transiently to derive a fingerprint and never
 * escapes this function; only presence, expiry, and the derived fingerprint are
 * returned. Any read or parse failure yields empty facts so callers degrade to
 * existing behaviour rather than throwing.
 */
function readLiveCredentialFacts(
	providerId: string,
	authPath: string,
): {
	credential: CredentialUsability | undefined;
	fingerprint: string | undefined;
} {
	try {
		const stored = readStoredCredential(providerId, authPath);
		if (stored === null || typeof stored !== "object") {
			return { credential: undefined, fingerprint: undefined };
		}
		const record = stored as Record<string, unknown>;
		const expiresAtMs =
			typeof record.expires === "number" && Number.isFinite(record.expires)
				? record.expires
				: undefined;
		return {
			credential: {
				hasRefreshToken:
					typeof record.refresh === "string" && record.refresh.length > 0,
				...(expiresAtMs === undefined ? {} : { expiresAtMs }),
			},
			fingerprint: accountFingerprint(record.access),
		};
	} catch {
		// Missing or unreadable metadata must preserve existing reactive routing.
		return { credential: undefined, fingerprint: undefined };
	}
}

/**
 * The managed superset one discovered slot projects to: every field of an
 * operator account and a routing managed account, but with the widened
 * `ManagedFamily` so an `openai` owning-vendor-api slot can be surfaced. The
 * `subscriptionOperatorAccounts` narrows this to the explicit subscription
 * subtype for proactive and v1-resolver boundaries; physical and unified-logical
 * routing keep the managed superset.
 */
type OperatorManagedAccount = Omit<OperatorAccount, "family"> &
	Omit<ManagedAccount, "family"> & { readonly family: ManagedFamily };

export type AccountGroupEnforcementReason =
	| "unknown-group"
	| "empty-group"
	| "no-current-members"
	| "no-eligible-members";

export interface AccountGroupEnforcementResult<T> {
	readonly accounts: T[];
	readonly groupId?: string;
	readonly reason?: AccountGroupEnforcementReason;
	readonly message?: string;
}

/**
 * Applies one already-resolved session policy to the physical account funnel.
 * An active policy never widens: an unknown, empty, or presently unavailable
 * group produces zero accounts and a bounded operator-facing reason.
 */
export function enforceAccountGroup<T extends { readonly providerId: string }>(
	accounts: readonly T[],
	resolution: EffectiveAccountGroupResolution,
	accountGroups: Readonly<Record<string, readonly string[]>> | undefined,
	isCurrentlyEligible?: (account: T) => boolean,
): AccountGroupEnforcementResult<T> {
	if (resolution.source === "unrestricted") return { accounts: [...accounts] };

	const groupId = resolution.groupId;
	if (accountGroups === undefined || !Object.hasOwn(accountGroups, groupId)) {
		return {
			accounts: [],
			groupId,
			reason: "unknown-group",
			message: `Account group "${groupId}" is not configured; update accountGroups or reset the session override.`,
		};
	}

	const members = accountGroups[groupId] ?? [];
	if (members.length === 0) {
		return {
			accounts: [],
			groupId,
			reason: "empty-group",
			message: `Account group "${groupId}" has no members; add canonical account IDs or choose another group.`,
		};
	}

	const memberIds = new Set(members);
	const filtered = accounts.filter((account) =>
		memberIds.has(account.providerId),
	);
	if (filtered.length === 0) {
		return {
			accounts: [],
			groupId,
			reason: "no-current-members",
			message: `Account group "${groupId}" has no members in current account discovery; restore a listed account or choose another group.`,
		};
	}
	if (
		isCurrentlyEligible !== undefined &&
		!filtered.some((account) => isCurrentlyEligible(account))
	) {
		return {
			accounts: [],
			groupId,
			reason: "no-eligible-members",
			message: `Account group "${groupId}" has no currently eligible members; wait for recovery, sign in, or choose another group.`,
		};
	}
	return { accounts: filtered, groupId };
}

function operatorAccounts(
	context: ExtensionContext | undefined,
	discovery: DiscoveryResult | undefined,
	authPath: string,
	accountLimit: number,
): Array<OperatorManagedAccount> {
	if (!context || !discovery) return [];
	return discovery.slots.flatMap((slot) => {
		// Reject an over-limit discovered slot before any model catalog lookup or
		// credential read at this operator/routing projection boundary.
		if (!isProviderSlotWithinAccountLimit(slot, accountLimit)) return [];
		const models = providerModels(context, slot.providerId);
		const model = models[0];
		if (!model) return [];

		// Project the stored credential at this boundary into bounded metadata only.
		// The raw access value is used transiently by accountFingerprint and never
		// enters OperatorAccount, ManagedAccount, routing state, or diagnostics.
		const { credential, fingerprint } = readLiveCredentialFacts(
			slot.providerId,
			authPath,
		);

		return [
			{
				providerId: slot.providerId,
				family: slot.family,
				// Bounded credential-presence category from discovery, carried so
				// the operator surface can derive the live providerType. Never a
				// credential value.
				credentialType: slot.credentialType,
				model,
				modelIds: models.map((candidate) => candidate.id),
				displayName: slot.providerId,
				...(credential === undefined ? {} : { credential }),
				...(fingerprint === undefined
					? {}
					: { accountFingerprint: fingerprint }),
			},
		];
	});
}

/**
 * Projects discovered slots into the bounded warm-candidate shape the credential
 * warmer and usage fetcher consume, excluding any slot outside the current
 * validated account limit.
 *
 * Each of the three automatic-work call sites (startup credential warming,
 * `before_agent_start` credential warming, and `before_agent_start` usage
 * fetching) calls this independently rather than sharing one projected array, so
 * removing one call-site defense cannot expose a sibling sink. Only named fields
 * are copied; a hostile above-limit slot reaches no automatic credential read or
 * usage request.
 */
/**
 * Asserted subscription-family narrowing for a discovered slot: true only for a
 * subscription family (`anthropic`, `openai-codex`), and it narrows the slot's
 * widened `ManagedFamily` to `AllowedFamily`. It is the single guard the
 * automatic-candidate mutation control weakens (its body changes to
 * `isManagedFamily`, admitting `openai`) while its asserted signature keeps the
 * downstream `AllowedFamily` assignment compiling.
 */
function isSubscriptionSlot(
	slot: ProviderSlot,
): slot is ProviderSlot & { family: AllowedFamily } {
	return isAllowedFamily(slot.family);
}

/**
 * The subscription family a discovered slot names, or `undefined` for the
 * owning-vendor-api `openai` family. Its fixed `AllowedFamily | undefined`
 * return type is what keeps the two `classifyProviderId`-derived lifecycle
 * producers (`message_end`, `after_provider_response`) subscription-guarded:
 * each takes `const family = subscriptionFamilyOf(slot); if (family === undefined)
 * return;` before writing the routing origin or a usage observation, so those
 * `AllowedFamily` sinks never receive `openai`. The guard's own mutation control
 * changes only this body (to `return slot.family as AllowedFamily`), which still
 * compiles because the signature is unchanged.
 */
function subscriptionFamilyOf(slot: ProviderSlot): AllowedFamily | undefined {
	return isAllowedFamily(slot.family) ? slot.family : undefined;
}

/**
 * Subscription-only narrowing for proactive, usage, warmer, and version-1
 * resolver projections. The unified logical provider deliberately consumes the
 * managed superset and applies its own vendor/tier ordering.
 */
export function isRoutingEligibleAccountFamily<
	T extends { readonly family: ManagedFamily; readonly credentialType?: CredentialType },
>(account: T): account is T & { readonly family: AllowedFamily } {
	return (
		isAllowedFamily(account.family) &&
		providerTypeFor(account.family, account.credentialType ?? "unknown") ===
			"subscription"
	);
}



function projectAutomaticAccountCandidates(
	discovery: DiscoveryResult | undefined,
	accountLimit: number,
): readonly WarmCandidate[] {
	if (!discovery) return [];
	const candidates: WarmCandidate[] = [];
	for (const slot of discovery.slots) {
		if (!isProviderSlotWithinAccountLimit(slot, accountLimit)) continue;
		// Credential warming and OAuth usage fetch are subscription-only work; an
		// owning-vendor-api `openai` slot must never reach them. The asserted
		// type-predicate narrows `slot.family` (ManagedFamily) to AllowedFamily
		// so the WarmCandidate assignment below type-checks, and it is the guard
		// the automatic-candidate mutation control weakens.
		if (!isSubscriptionSlot(slot)) continue;
		candidates.push({
			providerId: slot.providerId,
			family: slot.family,
			credentialType: slot.credentialType,
			...(slot.expiresAtMs === undefined ? {} : { expiresAtMs: slot.expiresAtMs }),
		});
	}
	return candidates;
}

/** Test-only seams are optional; production uses the default allowlisted fetch. */
/**
 * Strip tool calls from a FAILED assistant message so the conversation history
 * a resumed turn sends stays valid for whichever account it lands on.
 *
 * WHY THIS EXISTS. When the host's retry budget is exhausted it abandons the
 * turn before it strips the errored assistant message, so that message survives
 * in history. If the failure landed after tool calls were emitted, history ends
 * with a tool call that has no matching result. Anthropic rejects that shape
 * with a 400 on EVERY account, which turns a recoverable rate limit into a hard
 * fleet-wide failure — strictly worse than the outage this extension exists to
 * fix. The host strips such a message only in its compaction path, never
 * generically.
 *
 * WHY HERE. Replacing the message as it finalises is the ONLY history-shaping
 * power the public extension API grants: it exposes no history read and no
 * history write. Because every resume mode — immediate switch, and the parked,
 * same-account and delegate resumes added later — dispatches a turn whose
 * history was already sanitised at finalisation, they all inherit this guard by
 * construction and none can bypass it.
 *
 * HISTORY SHAPE FOR THE IMMEDIATE-SWITCH MODE, stated explicitly: the resumed
 * turn sends the conversation as the host holds it, minus any unanswered tool
 * call on the failed message, plus one fixed user continuation message. It does
 * not replay the failed request.
 *
 * Returns undefined when nothing needs repair, so the handler can leave the
 * message untouched rather than churning identical objects through the runtime.
 * The role is preserved deliberately: the runtime REJECTS a replacement whose
 * role differs and silently keeps the original, so changing it would defeat the
 * guard while appearing to work.
 */
export function withoutUnansweredToolCalls(
	message: AssistantMessage,
): AssistantMessage | undefined {
	if (!Array.isArray(message.content)) return undefined;
	const kept = message.content.filter((block) => block?.type !== "toolCall");
	if (kept.length === message.content.length) return undefined;
	const replacement = cloneEnumerableMessageFields(message);
	replacement.content = kept;
	return replacement as unknown as AssistantMessage;
}

export interface MultiAccountExtensionOptions {
	/** Test seam; production owns one fresh process-local routing state. */
	readonly state?: RuntimeState;
	readonly usageFetchImpl?: UsageFetchImplementation;
	/** Test seam; production uses the reviewed Antigravity usage primitive. */
	readonly fetchAntigravityUsage?: AntigravityUsageFetchImplementation;
	/** Test seam; production binds the host's locked credential store on startup. */
	readonly forcedCredentialRefresher?: Pick<
		ForcedCredentialRefresher,
		"attempt"
	>;
	/** Test seam; production appends through the bounded retained-cost store. */
	readonly costRecorder?: (
		message: AssistantMessage,
		canonicalAccountId: string,
	) => boolean | Promise<boolean>;
	/** Test seam; production uses the machine-global dual-triggered closer. */
	readonly costPeriodCloser?: Pick<
		CostPeriodCloser,
		"closeAfterObservation" | "closeBeforeRender"
	>;
	/** Test seam; production closes ended periods before reading retained state. */
	readonly costReport?: (periodType: PeriodType) => Promise<CostReport>;
	/** Test seam; production reads the per-project process environment. */
	readonly openRouterEnvironment?: Readonly<Record<string, string | undefined>>;
	/** Test seam; production uses the machine-global crash-conservative budget. */
	readonly openRouterBudget?: Pick<
		OpenRouterBudgetStore,
		"reserve" | "reservedToday"
	>;
	/** Test seam; production derives a bounded non-reversible project key. */
	readonly projectKey?: string;
	/**
	 * Test seam; production loads the reviewed Antigravity boundary through the
	 * real published barrels (`createAntigravityProviderConfig`). Overriding
	 * this never bypasses the debug-dump guard: production's default loader
	 * still calls it, and a caller-supplied loader is responsible for its own.
	 */
	readonly loadAntigravityProviderConfig?: () => Promise<ProviderConfig>;
}

/**
 * Production extension factory. Provider discovery is deferred to the public
 * session_start context so it reuses Pi's already-open AuthStorage and never
 * creates, copies, or mutates credentials itself.
 */
// pi-delegate runs direct workers, supervised workers, and supervisor clones as
// in-process sessions that share the parent's ModelRuntime and call
// bindExtensions() inside one process-global ownership scope. Current versions
// carry that scope through AsyncLocalStorage; earlier versions used a numeric
// bind depth. The shared API set persists ownership after the bind finishes.
// These are read-only reads of another package's intentional cross-instance
// contract. Their absence means no delegate is present: a normal foreground bind.
const DELEGATE_OWNED_BIND_STORAGE_KEY = Symbol.for(
	"pi-delegate.delegateOwnedExtensionBindPolicyStorage",
);
const DELEGATE_OWNED_BIND_DEPTH_KEY = Symbol.for(
	"pi-delegate.delegateOwnedExtensionBindDepth",
);
const DELEGATE_OWNED_API_SET_KEY = Symbol.for(
	"pi-delegate.delegateOwnedExtensionApis",
);
const DELEGATE_WORKER_ORIGIN_ENTRY_TYPE = "delegate.worker-origin";
const DELEGATE_DRIVER_CHILD_ENV = "PI_DELEGATE_CHILD";
const DELEGATE_DRIVER_OWNER_SESSION_ENV = "PI_DELEGATE_OWNER_SESSION_ID";

interface AccountGroupSessionManager extends SessionIdSource {
	getBranch(): readonly unknown[];
}

function delegateOwnedApiSet(): WeakSet<object> {
	const scope = globalThis as Record<symbol, unknown>;
	const existing = scope[DELEGATE_OWNED_API_SET_KEY];
	if (existing instanceof WeakSet) return existing as WeakSet<object>;
	const created = new WeakSet<object>();
	scope[DELEGATE_OWNED_API_SET_KEY] = created;
	return created;
}

/**
 * True when this extension API belongs to a delegate-owned in-process session
 * rather than the real foreground originator.
 *
 * This read must happen while the factory runs inside bindExtensions(). An active
 * current bind has a defined AsyncLocalStorage frame; a legacy bind has positive
 * depth. Either signal marks the API persistently, matching pi-delegate's own
 * shouldSkipForegroundLifecycleForDelegateOwnedApi contract.
 */
function isDelegateOwnedApi(api: Parameters<ExtensionFactory>[0]): boolean {
	const scope = globalThis as Record<symbol, unknown>;
	const storage = scope[DELEGATE_OWNED_BIND_STORAGE_KEY];
	const currentBind =
		storage instanceof AsyncLocalStorage && storage.getStore() !== undefined;
	const depth = scope[DELEGATE_OWNED_BIND_DEPTH_KEY];
	const legacyBind =
		typeof depth === "number" && Number.isFinite(depth) && depth > 0;
	if (currentBind || legacyBind) {
		delegateOwnedApiSet().add(api);
		return true;
	}
	const existing = scope[DELEGATE_OWNED_API_SET_KEY];
	return existing instanceof WeakSet && existing.has(api);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read pi-delegate's producer-owned seed before the worker's first prompt. The
 * installed producer writes exactly one entry with this closed version-1 shape.
 * Missing, duplicate, or malformed seeds are indistinguishable from an
 * untrusted origin and therefore fail closed.
 */
function delegateWorkerOriginOwnerSessionId(
	sessionManager: AccountGroupSessionManager,
): string | undefined {
	let branch: readonly unknown[];
	try {
		branch = sessionManager.getBranch();
	} catch {
		return undefined;
	}
	const origins = branch.filter(
		(entry) =>
			isPlainRecord(entry) &&
			entry["type"] === "custom" &&
			entry["customType"] === DELEGATE_WORKER_ORIGIN_ENTRY_TYPE,
);
	if (origins.length !== 1) return undefined;
	const entry = origins[0];
	if (!isPlainRecord(entry)) return undefined;
	const data = entry["data"];
	if (!isPlainRecord(data)) return undefined;
	const keys = Object.keys(data).sort((left, right) => left.localeCompare(right));
	if (
		keys.join(",") !== "agent,forkName,ownerSessionId,runId,version" ||
		data["version"] !== 1 ||
		typeof data["ownerSessionId"] !== "string" ||
		data["ownerSessionId"].trim().length === 0 ||
		typeof data["runId"] !== "string" ||
		data["runId"].trim().length === 0 ||
		typeof data["forkName"] !== "string" ||
		typeof data["agent"] !== "string"
	) {
		return undefined;
	}
	return data["ownerSessionId"];
}

/**
 * Persist an inherited effective result under the child's own session id without
 * consulting the child's real cwd/default policy. This makes a durable child a
 * valid parent for the next durable or in-process hop while preserving the
 * inherited source exactly.
 */
function cacheInheritedAccountGroupResolution(
	store: SessionAccountGroupStore,
	sessionManager: SessionIdSource,
	cwd: string,
	resolution: EffectiveAccountGroupResolution,
): EffectiveAccountGroupResolution {
	if (resolution.source === "session-override") {
		store.setOverride(sessionManager, resolution.groupId);
		return store.resolveAndCache({ sessionManager, cwd, config: {} });
	}
	store.clearOverride(sessionManager);
	if (resolution.source === "cwd-default") {
		return store.resolveAndCache({
			sessionManager,
			cwd,
			config: { accountGroupCwdDefaults: { [cwd]: resolution.groupId } },
		});
	}
	if (resolution.source === "global-default") {
		return store.resolveAndCache({
			sessionManager,
			cwd,
			config: { defaultAccountGroup: resolution.groupId },
		});
	}
	return store.resolveAndCache({ sessionManager, cwd, config: {} });
}


/**
 * Resolves the actually-installed `@earendil-works/pi-ai` package version by
 * walking up from its resolved `providers/anthropic.models` module file to
 * the nearest `package.json` whose `name` matches. A local, bounded,
 * offline disk read -- never a network request -- so the report's recorded
 * pricing-method provenance names whichever pinned catalog this process
 * actually loaded instead of a hard-coded string that could drift from it.
 * Shares its shape with the standalone CLI's own offline resolver in
 * `standalone-cli.ts`; the two adapters read from different sources (a live
 * `ExtensionContext.modelRegistry` here, the pinned package directly there)
 * and so cannot share one function without coupling this extension entry
 * point to the separate standalone-CLI module.
 */
function resolveInstalledPiAiVersion(): string {
	try {
		const moduleUrl = import.meta.resolve(
			"@earendil-works/pi-ai/providers/anthropic.models",
		);
		let directory = dirname(fileURLToPath(moduleUrl));
		for (let depth = 0; depth < 6; depth += 1) {
			try {
				const candidate = JSON.parse(
					readFileSync(join(directory, "package.json"), "utf-8"),
				) as { readonly name?: unknown; readonly version?: unknown };
				if (
					candidate.name === "@earendil-works/pi-ai" &&
					typeof candidate.version === "string" &&
					candidate.version.length > 0
				) {
					return `pi-ai@${candidate.version}`;
				}
			} catch {
				// Keep walking toward the installed package root.
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	} catch {
		// Resolution failure falls through to the bounded fallback below.
	}
	return "pi-ai@unknown";
}

/**
 * Builds the extension surfaces' live Pi-catalog snapshot from the session's
 * real `ExtensionContext.modelRegistry.getAll()` -- the same public,
 * already-reviewed live-catalog surface `catalog-rebinding.ts` reads for
 * alias registration (see `LiveModelRegistrySurface`) -- filtered to the two
 * managed families this report prices: `anthropic` keeps its own vendor
 * prefix, and `openai-codex` is authored by, and therefore keyed under,
 * `openai` (mirroring `api-pricing.ts`'s `accountAuthor`). The separate
 * owning-vendor-api `openai` platform family never resolves through that
 * lookup and is excluded here too. A synchronous, local, in-memory read:
 * never a network call, and it writes nothing. Returns `undefined` (never
 * throws) so a registry shape this parser rejects degrades to the
 * pre-existing OpenRouter-snapshot-only pricing instead of failing the
 * report.
 */
function buildLivePiCatalogSnapshot(
	models: readonly Model<Api>[],
	nowMs: number,
): PiCatalogSnapshot | undefined {
	const costsBySourceModelId: Record<string, unknown> = {};
	for (const model of models) {
		const vendor =
			model.provider === "anthropic"
				? "anthropic"
				: model.provider === "openai-codex"
					? "openai"
					: undefined;
		if (vendor === undefined) continue;
		costsBySourceModelId[`${vendor}/${model.id}`] = {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
			...(model.cost.tiers === undefined ? {} : { tiers: model.cost.tiers }),
		};
	}
	if (Object.keys(costsBySourceModelId).length === 0) return undefined;
	try {
		return parsePiCatalogSnapshot({
			schemaVersion: 1,
			source: "pi-installed-catalog",
			catalogVersion: resolveInstalledPiAiVersion(),
			capturedAtMs: nowMs,
			costsBySourceModelId,
		});
	} catch {
		return undefined;
	}
}

export const createMultiAccountExtension =
	(options: MultiAccountExtensionOptions = {}): ExtensionFactory =>
	async (pi) => {
		// Read pi-delegate's bind scope while the factory body runs synchronously
		// inside bindExtensions(). A delegate-owned in-process worker/clone session
		// shares the foreground's TUI, so its route indicator would publish to the
		// same qualified widget key and overwrite the real foreground footer. The
		// footer is foreground-only; every other surface (provider registration,
		// routing, cost attribution) stays active for the worker.
		const delegateOwnedSession = isDelegateOwnedApi(pi);
		// Copy only pi-delegate's two named child-identity fields. Public request
		// objects and caller-provided env maps never cross this trust boundary.
		const delegateDriverChildMarker = process.env[DELEGATE_DRIVER_CHILD_ENV];
		const delegateDriverOwnerSessionId =
			process.env[DELEGATE_DRIVER_OWNER_SESSION_ENV];
		const baseDirectory = agentDirectory();
		// Package storage identity stays decoupled from the logical provider ID.
		const sessionAccountGroups = new SessionAccountGroupStore({
			storePath: join(
				baseDirectory,
				"pi-multi-account",
				"session-account-groups.json",
			),
		});
		const configPath = join(baseDirectory, "pi-multi-account", CONFIG_FILE);
		const authPath = join(baseDirectory, AUTH_FILE);
		const diagnostics = new DiagnosticLog({
			persistence: new DiagnosticStore(),
		});
		const state = options.state ?? new RuntimeState();
		const disabledProviders = new Set<string>();
		const modelSupport = new ModelSupportRegistry();
		const sharedUsageStore = new SharedUsageStore();
		const usage = new UsageLedger({ sharedStore: sharedUsageStore });
		const costRecorder = options.costRecorder ?? ((
			message: AssistantMessage,
			canonicalAccountId: string,
		) => appendCostRecord(message, canonicalAccountId, {
			onLockExhausted: ({ lockPath, elapsedMs }) => {
				diagnostics.record(
					"warning",
					"cost.history-lock",
					"Cost history lock acquisition exhausted; retained cost observation was skipped.",
					{ lockPath, elapsedMs },
				);
			},
		}));
		const costPeriodCloser =
			options.costPeriodCloser ?? createDefaultCostPeriodCloser();
		const openRouterEnvironment =
			options.openRouterEnvironment ?? process.env;
		const openRouterBudget = options.openRouterBudget ?? new OpenRouterBudgetStore();
		const projectKey = options.projectKey ?? projectKeyForCwd();
		let logicalRouteIndicator: LogicalRouteIndicator | undefined;
		const usageFetcher = new UsageFetcher({
			// Package storage identity stays decoupled from the logical provider ID.
			lockPath: join(baseDirectory, "pi-multi-account", "usage-fetch.lock"),
			usage,
			sharedStore: sharedUsageStore,
			...(options.usageFetchImpl === undefined
				? {}
				: { fetchImpl: options.usageFetchImpl }),
			...(options.fetchAntigravityUsage === undefined
				? {}
				: { fetchAntigravityUsage: options.fetchAntigravityUsage }),
			onUsageRecorded: (providerId) => {
				try {
					logicalRouteIndicator?.usageChanged(providerId);
				} catch {
					// Footer observation cannot alter successful fetch classification.
				}
			},
			resolveCredential: async (providerId) => {
				const registry = context?.modelRegistry;
				if (!registry) return undefined;
				try {
					const credential = await registry.getApiKeyForProvider(providerId);
					return typeof credential === "string" && credential.length > 0
						? credential
						: undefined;
				} catch {
					return undefined;
				}
			},
		});
		const maintainedCodexStream = await loadMaintainedCodexStream();
		const anthropicCaptured = await registerUpstreamAnthropicProvider(pi);
		// The reviewed Antigravity boundary loads the five reviewed published
		// barrels and registers the extension-owned compat alias API before any
		// account is discovered, exactly like the Anthropic base provider above.
		// A load failure (including the debug-dump guard firing) must not break
		// the rest of the extension: `antigravityConfig` stays undefined and
		// `registerDiscoveredProviders` publishes nothing for that family, the
		// same fallback it already uses while this boundary was unwired. The one
		// raw upstream stream feeds both the compat alias registrar and the
		// provider config so neither re-wraps the other's already-aliased stream.
		let antigravityConfig: ProviderConfig | undefined;
		try {
			const loaded = options.loadAntigravityProviderConfig
				? await options.loadAntigravityProviderConfig()
				: await (async () => {
						const primitives = await loadUpstreamAntigravityPrimitives();
						await registerAntigravityAliasApi(primitives.stream);
						return createAntigravityProviderConfig(undefined, primitives.stream);
					})();
			// The reviewed catalog's own model rows carry no per-model `baseUrl`
			// (it is a provider-level field there); the logical declaration
			// projector requires one on every declared row regardless of family
			// (`src/models-declaration.ts`'s `sourceRecord`). Stamping the
			// provider's own baseUrl onto a model that is missing one keeps that
			// already-completed, out-of-scope contract satisfied without
			// mutating the reviewed boundary or the declaration projector.
			const providerBaseUrl = loaded.baseUrl;
			const stampBaseUrl = (
				models: readonly ProviderModelConfig[],
			): ProviderModelConfig[] =>
				models.map((model) =>
					model.baseUrl === undefined && providerBaseUrl !== undefined
						? { ...model, baseUrl: providerBaseUrl }
						: model,
				);
			const loadedRefreshModels = loaded.refreshModels;
			antigravityConfig = {
				...loaded,
				models: stampBaseUrl(loaded.models ?? []),
				...(loadedRefreshModels === undefined
					? {}
					: {
							refreshModels: async (refreshContext: Parameters<typeof loadedRefreshModels>[0]) =>
								stampBaseUrl(await loadedRefreshModels(refreshContext)),
						}),
			};
		} catch (error) {
			antigravityConfig = undefined;
			diagnostics.recordError("antigravity.primitives-load", error);
		}
		// One registrar per extension factory generation. It lazily publishes only
		// after the declaration gate enables logical routing, then keeps the shared
		// compat entry independent of every session's shutdown lifetime.
		const registerLogicalApi = createLogicalApiRegistrarForFactoryGeneration();

		let context: ExtensionContext | undefined;
		let attributionStore: AttributionStore | undefined;
		let latestLogicalPhysicalProviderId: string | undefined;
		const logicalTerminalAssociations = createLogicalTerminalAssociationStore();
		let config: MultiAccountConfig = DEFAULT_CONFIG;
		const defaultCostReportReader = createDefaultCostReportReader({
			config: () => config,
			// `context` is undefined until `session_start` assigns it below; this
			// closure is only ever invoked later, from a real report render, by
			// which point a started session has always set it.
			piCatalog: () => {
				const registry = context?.modelRegistry;
				if (registry === undefined) return undefined;
				try {
					return buildLivePiCatalogSnapshot(registry.getAll(), Date.now());
				} catch {
					return undefined;
				}
			},
		});
		const costReport =
			options.costReport ??
			(async (periodType: PeriodType): Promise<CostReport> => {
				try {
					const closeResult = await costPeriodCloser.closeBeforeRender();
					if (closeResult.status === "failed") {
						diagnostics.record(
							"warning",
							"cost.period-close",
							"Completed cost periods could not be closed before rendering; the report may show an explicit gap until a later retry.",
						);
					}
				} catch {
					diagnostics.record(
						"warning",
						"cost.period-close",
						"Completed cost periods could not be closed before rendering; the report may show an explicit gap until a later retry.",
					);
				}
				return defaultCostReportReader(periodType);
			});
		let discovery: DiscoveryResult | undefined;
		// One bounded origin owns automatic route authority across subscription,
		// owning-vendor, cross-vendor, parking, and managed OpenRouter return.
		let turnRouteOrigin: TurnRouteOrigin | undefined;
		let preserveOriginAcrossNextInputClear = false;
		let codexCaptured: CapturedCodexProvider | undefined;
		// eslint-disable-next-line prefer-const -- reassigned in session_start
		let codexEnabled = false;
		let currentModel: Model<Api> | undefined;
		let openRouterSessionDisabled = false;
		let pendingOpenRouterFailure = false;
		let openRouterInputApproved = false;
		let openRouterBridge:
			| {
					readonly originProviderId: string;
					readonly originFamily: AllowedFamily;
					readonly originModelId: string;
					reservationArmed: boolean;
					retiredByAccountGroup: boolean;
			  }
			| undefined;
		const reportedOpenRouterConditions = new Set<string>();
		let forcedCredentialRefresher = options.forcedCredentialRefresher;
		const warmer = new CredentialWarmer({
			// Package storage identity stays decoupled from the logical provider ID.
			lockPath: join(baseDirectory, "pi-multi-account", "warming.lock"),
			compactUnderLease: (lease) => {
				sharedUsageStore.compactUnderLease(lease);
			},
			scheduleBackground: process.env.VITEST !== "true",
			diagnostics,
			resolveCredential: async (providerId) => {
				const registry = context?.modelRegistry;
				if (!registry) return false;
				try {
					const resolved = await registry.getApiKeyForProvider(providerId);
					return typeof resolved === "string" && resolved.length > 0;
				} catch {
					return false;
				}
			},
			onUnavailable: (candidate) => {
				state.invalidateAccount({
					providerId: candidate.providerId,
					family: candidate.family,
					reason: "terminal-auth-failure",
					invalidatedAtMs: Date.now(),
				});
				diagnostics.record(
					"warning",
					"credential.warmer.unavailable",
					"Credential refresh could not recover this account; real login is required.",
					{ providerId: candidate.providerId, action: "login-required" },
				);
			},
			onWarmed: (candidate) =>
				state.markCredentialResolutionSuccess(candidate.providerId),
		});

		const setModel = async (model: Model<Api>): Promise<boolean> => {
			const selected = (await pi.setModel(model)) === true;
			if (selected) currentModel = model;
			return selected;
		};
		const recordAutomaticDestination = (
			origin: TurnRouteOrigin,
			destinationProviderId: string,
		): void => {
			turnRouteOrigin = {
				providerId: origin.providerId,
				family: origin.family,
				...(origin.requestedModelId === undefined
					? {}
					: { requestedModelId: origin.requestedModelId }),
				expectedAutomaticProviderId: destinationProviderId,
				logical: origin.logical,
			};
		};
		const clearTurnRouteOrigin = (): void => {
			turnRouteOrigin = undefined;
		};
		const logicalModelSelector = createLogicalModelSelector();
		const switchModel = async (
			args: string,
			commandContext: ExtensionCommandContext,
			signal: AbortSignal,
		): Promise<LogicalModelSwitchResult> => {
			// The lifecycle passes the live command context so reloads and scoped
			// sessions cannot accidentally reuse the startup registry snapshot.
			const dependencies: LogicalModelSwitchDependencies = {
				mode: commandContext.mode,
				ui: commandContext.ui,
				modelRegistry: commandContext.modelRegistry,
				scopedModels: commandContext.scopedModels,
				currentModel: currentModel ?? commandContext.model,
				selector: logicalModelSelector,
				setModel,
				signal,
			};
			return executeLogicalModelSwitch(args, dependencies);
		};

		const openRouterPolicy = () =>
			resolveOpenRouterEnvironmentPolicy({
				environment: openRouterEnvironment,
				sessionDisabled: openRouterSessionDisabled,
			});
		const openRouterModel = (
			modelId: string,
			modelContext: ExtensionContext | undefined = context,
		): Model<Api> | undefined =>
			modelContext
				? providerModels(modelContext, OPENROUTER_PROVIDER_ID).find(
						(model) => model.id === modelId,
					)
				: undefined;
		const resolvedOpenRouterModel = (
			requestedModelId: string,
			environmentModelId: string,
			modelContext: ExtensionContext | undefined = context,
		): { readonly modelId: string; readonly model: Model<Api> } | undefined => {
			// Persisted and resolver maps reject `*`. Preserve the environment model's
			// catch-all policy by synthesizing only this request's explicit source key;
			// a persisted source-specific mapping is layered last and still wins.
			const openrouter = Object.assign(
				Object.create(null) as Record<string, string>,
				{ [requestedModelId]: environmentModelId },
				config.tierModelMap.openrouter,
			);
			const runtimeTierModelMap = Object.assign(
				Object.create(null) as MultiAccountConfig["tierModelMap"],
				config.tierModelMap,
				{ openrouter },
			);
			const modelId = resolveTierModel(
				requestedModelId,
				"openrouter",
				modelContext
					? providerModels(modelContext, OPENROUTER_PROVIDER_ID).map(
							(model) => model.id,
						)
					: [],
				runtimeTierModelMap,
			);
			if (modelId === undefined) return undefined;
			const model = openRouterModel(modelId, modelContext);
			return model === undefined ? undefined : { modelId, model };
		};
		const reportedAccountGroupBlocks = new Set<string>();
		const recordAccountGroupBlock = (
			key: string,
			message: string,
			groupId?: string,
		): void => {
			if (reportedAccountGroupBlocks.has(key)) return;
			reportedAccountGroupBlocks.add(key);
			diagnostics.record(
				"warning",
				`routing.account-group-${key}`,
				message,
				groupId === undefined ? undefined : { groupId },
			);
		};
		const hasConfiguredAccountGroupPolicy = (): boolean =>
			Object.keys(config.accountGroups ?? {}).length > 0 ||
			Object.keys(config.accountGroupCwdDefaults ?? {}).length > 0 ||
			config.defaultAccountGroup !== undefined;
		let effectiveAccountGroupResolution:
			| EffectiveAccountGroupResolution
			| undefined;
		let accountGroupResolutionInitialized = false;
		let accountGroupScopeBlocked = false;
		const blockAccountGroupScope = (key: string, message: string): void => {
			accountGroupResolutionInitialized = true;
			accountGroupScopeBlocked = true;
			effectiveAccountGroupResolution = undefined;
			recordAccountGroupBlock(key, message);
		};
		const rememberAccountGroupResolution = (
			resolution: EffectiveAccountGroupResolution,
		): EffectiveAccountGroupResolution => {
			accountGroupResolutionInitialized = true;
			accountGroupScopeBlocked = false;
			effectiveAccountGroupResolution = resolution;
			return resolution;
		};
		const accountGroupScopeRestrictsRouting = (): boolean =>
			accountGroupScopeBlocked ||
			effectiveAccountGroupResolution === undefined ||
			effectiveAccountGroupResolution.source !== "unrestricted";
		const resolveOwnSessionAccountGroup = (
			sessionManager: SessionIdSource,
			cwd: string,
		): EffectiveAccountGroupResolution =>
			rememberAccountGroupResolution(
				sessionAccountGroups.resolveAndCache({
					sessionManager,
					cwd,
					config,
				}),
			);
		const initializeSessionAccountGroupScope = (
			accountContext: ExtensionContext | undefined,
		): void => {
			const sessionManager = accountContext?.sessionManager as
				| AccountGroupSessionManager
				| undefined;
			const cwd = accountContext?.cwd;
			const delegateDriverIdentityPresent =
				delegateDriverChildMarker !== undefined ||
				delegateDriverOwnerSessionId !== undefined;
			if (
				typeof sessionManager?.getSessionId !== "function" ||
				typeof cwd !== "string"
			) {
				if (
					!delegateOwnedSession &&
					!delegateDriverIdentityPresent &&
					!hasConfiguredAccountGroupPolicy()
				) {
					rememberAccountGroupResolution({ source: "unrestricted" });
					return;
				}
				blockAccountGroupScope(
					"context-unavailable",
					"The active account group could not be resolved from this session; routing is blocked until the session context is available.",
				);
				return;
			}
			try {
				// An in-process worker can also live inside a durable child process. The
				// bind frame is the more specific identity and its own worker-origin seed
				// names the immediate parent, so it always takes precedence over env.
				if (delegateOwnedSession) {
					if (typeof sessionManager.getBranch !== "function") {
						blockAccountGroupScope(
							"delegate-origin-unresolved",
							"The delegate parent session could not be verified; managed routing is blocked for this worker.",
						);
						return;
					}
					const parentSessionId =
						delegateWorkerOriginOwnerSessionId(sessionManager);
					if (parentSessionId === undefined) {
						blockAccountGroupScope(
							"delegate-origin-unresolved",
							"The delegate parent session could not be verified; managed routing is blocked for this worker.",
						);
						return;
					}
					const parentOverride =
						sessionAccountGroups.readOverride(parentSessionId);
					if (parentOverride === undefined) {
						resolveOwnSessionAccountGroup(sessionManager, cwd);
						return;
					}
					sessionAccountGroups.setOverride(sessionManager, parentOverride);
					resolveOwnSessionAccountGroup(sessionManager, cwd);
					return;
				}
				if (delegateDriverIdentityPresent) {
					if (
						delegateDriverChildMarker !== "1" ||
						delegateDriverOwnerSessionId === undefined ||
						delegateDriverOwnerSessionId.trim().length === 0
					) {
						blockAccountGroupScope(
							"driver-origin-unresolved",
							"The durable delegate parent session could not be verified; managed routing is blocked for this child.",
						);
						return;
					}
					const inherited = sessionAccountGroups.readCachedResolution(
						delegateDriverOwnerSessionId,
					);
					if (inherited === undefined) {
						blockAccountGroupScope(
							"driver-resolution-unavailable",
							"The durable delegate parent's effective account group is unavailable; managed routing is blocked for this child.",
						);
						return;
					}
					rememberAccountGroupResolution(
						cacheInheritedAccountGroupResolution(
							sessionAccountGroups,
							sessionManager,
							cwd,
							inherited,
						),
					);
					return;
				}
				resolveOwnSessionAccountGroup(sessionManager, cwd);
			} catch {
				blockAccountGroupScope(
					"resolution-failed",
					"The active account group could not be read safely; routing is blocked until the session account-group store is repaired.",
				);
			}
		};
		const enforceSessionAccountGroup = (
			accounts: readonly OperatorManagedAccount[],
			accountContext: ExtensionContext | undefined,
		): OperatorManagedAccount[] => {
			if (!accountGroupResolutionInitialized) {
				initializeSessionAccountGroupScope(accountContext);
			}
			if (
				accountGroupScopeBlocked ||
				effectiveAccountGroupResolution === undefined
			) {
				return [];
			}
			const nowMs = Date.now();
			const enforced = enforceAccountGroup(
				accounts,
				effectiveAccountGroupResolution,
				config.accountGroups,
				(account) =>
					selectAvailableManagedAccount({
						accounts: [account],
						state,
						nowMs,
					}) !== undefined,
			);
			if (enforced.reason !== undefined && enforced.message !== undefined) {
				recordAccountGroupBlock(
					`${enforced.reason}:${enforced.groupId ?? "unknown"}`,
					enforced.message,
					enforced.groupId,
				);
			}
			return enforced.accounts;
		};
		const physicalOperatorAccounts = (
			accountContext: ExtensionContext | undefined = context,
		): OperatorManagedAccount[] => {
			const accounts = operatorAccounts(
				accountContext,
				discovery,
				authPath,
				config.accountLimit,
			).filter((account) => !disabledProviders.has(account.providerId));
			return enforceSessionAccountGroup(accounts, accountContext);
		};
		const subscriptionOperatorAccounts = (
			accountContext: ExtensionContext | undefined = context,
		): Array<OperatorAccount & SubscriptionManagedAccount> =>
			physicalOperatorAccounts(accountContext).filter(
				(account): account is OperatorAccount & SubscriptionManagedAccount =>
					isRoutingEligibleAccountFamily(account),
			);
		const physicalAccountsForRouting = (nowMs: number): ManagedAccount[] =>
			physicalOperatorAccounts().map((account) => {
				const {
					providerId,
					family,
					credentialType,
					credential,
					accountFingerprint,
					modelIds,
				} = account;
				// `routingUsage`, never `fleetUsage`: the latter is peer-only, so
				// this session could not avoid an account it had itself just
				// measured as exhausted (#97).
				const fleetUsage = isRoutingEligibleAccountFamily(account)
					? sharedUsageHint(
							usage.routingUsage(providerId, account.family, nowMs),
							usage.activeExhaustionHoldUntilMs(
								providerId,
								account.family,
								nowMs,
							),
						)
					: undefined;
				return {
					providerId,
					family,
					...(credentialType === undefined ? {} : { credentialType }),
					...(credential === undefined ? {} : { credential }),
					...(accountFingerprint === undefined
						? {}
						: { accountFingerprint }),
					...(modelIds === undefined ? {} : { modelIds }),
					...(fleetUsage === undefined ? {} : { fleetUsage }),
				};
			});
		const subscriptionAccountsForRouting = (
			nowMs: number,
		): SubscriptionManagedAccount[] =>
			physicalAccountsForRouting(nowMs).filter(isRoutingEligibleAccountFamily);
		const continuationDestinationFor = (
			origin: TurnRouteOrigin,
			decision: AvailableRouteCandidate,
			account: OperatorManagedAccount,
			model: Model<Api>,
			routingReason: ContinuationDestination["routingReason"],
		): ContinuationDestination => ({
			providerId: account.providerId,
			family: decision.destination.family,
			model,
			routingReason,
			...(origin.logical &&
			decision.routeKind === "same-family" &&
			origin.requestedModelId !== undefined &&
			model.id === origin.requestedModelId &&
			isRoutingEligibleAccountFamily(account)
				? { logicalRoutePin: { requestedModelId: origin.requestedModelId } }
				: {}),
		});
		const restoreOpenRouterOrigin = async (): Promise<boolean> => {
			if (!openRouterBridge || !context) return false;
			const origin = providerModels(
				context,
				openRouterBridge.originProviderId,
			).find((model) => model.id === openRouterBridge?.originModelId);
			if (origin === undefined) return false;
			try {
				return await setModel(origin);
			} catch {
				return false;
			}
		};
		const recordOpenRouterConditionOnce = (
			key: string,
			level: "info" | "warning",
			message: string,
			data?: Readonly<Record<string, unknown>>,
		): void => {
			if (reportedOpenRouterConditions.has(key)) return;
			reportedOpenRouterConditions.add(key);
			diagnostics.record(level, `routing.openrouter-${key}`, message, data);
		};

		let watchdog: ContinuationWatchdog;
		const continuation = new ContinuationController({
			state,
			diagnostics,
			setModel,
			// AWAIT the dispatch. sendUserMessage returns Promise<void>, and when the
			// session is not streaming it routes to prompt(), which re-checks auth and
			// THROWS. Firing and forgetting left that rejection in an unobserved
			// promise: the resumed turn silently did nothing, the operator saw a dead
			// session, and no diagnostic was recorded -- the same silent-dead-end this
			// extension exists to eliminate, sitting inside the recovery path itself.
			// The controller already awaits this callback, so rethrowing routes the
			// failure into its normal dispatch-failure handling.
			dispatchFollowUp: async (message, signal) => {
				if (signal.aborted) return;
				try {
					await Promise.resolve(
						pi.sendUserMessage(message, { deliverAs: "followUp" }),
					);
				} catch (error) {
					// A cancellation that landed mid-dispatch is not a failure.
					if (signal.aborted) return;
					diagnostics.record(
						"warning",
						"continuation.dispatch-failed",
						"The resumed turn could not be dispatched; the continuation did not complete.",
					);
					throw error;
				}
			},
			// The resume predicate for a parked turn. Re-derives availability from the
			// LIVE account set and LIVE usage on every poll, so a park resumes because
			// an account genuinely recovered rather than because a timer fired or a
			// recorded estimate expired.
			//
			// REQ-FAILOVER-SAME-ACCOUNT falls out of this rather than needing its own
			// path: the originally failed provider is preferred if it genuinely recovers
			// first. This is a read-only availability query. A previous implementation
			// fabricated a 429 against the first catalog slot on every poll, which
			// poisoned unrelated accounts and could widen a Codex park into Anthropic.
			resolveParkedDestination: (nowMs) => {
				const origin = turnRouteOrigin;
				const parkAccounts = physicalOperatorAccounts();
				if (parkAccounts.length === 0 || origin === undefined) {
					return undefined;
				}
				const chosenRoute = selectAvailableRecoveryAccount({
					accounts: physicalAccountsForRouting(nowMs),
					state,
					config,
					nowMs,
					originFamily: origin.family,
					...(origin.requestedModelId === undefined
						? {}
						: {
								requestedModelId: origin.requestedModelId,
								preferredModelId: origin.requestedModelId,
							}),
					modelSupport,
					preferredProviderId: origin.providerId,
				});
				if (chosenRoute === undefined) return undefined;
				const chosen = parkAccounts.find(
					(account) =>
						account.providerId === chosenRoute.destination.providerId,
				);
				if (chosen === undefined) return undefined;
				const model = routeCandidateModel(
					chosenRoute,
					chosen,
					context,
					origin.requestedModelId,
					origin.family,
					config.preferredModels,
				);
				if (model === undefined) return undefined;
				return continuationDestinationFor(
					origin,
					chosenRoute,
					chosen,
					model,
					"rate-limit",
				);
			},
			onAutomaticRoutingSelected: (destination) => {
				const origin = turnRouteOrigin;
				if (origin !== undefined) {
					recordAutomaticDestination(
						destination.logicalRoutePin === undefined
							? { ...origin, logical: false }
							: origin,
						destination.providerId,
					);
				}
			},
			onAutomaticRoutingCleared: () => {
				if (preserveOriginAcrossNextInputClear) {
					preserveOriginAcrossNextInputClear = false;
					return;
				}
				clearTurnRouteOrigin();
			},
			onDispatched: (record) => {
				watchdog.start({
					continuationTurnRef: record.continuationTurnRef,
					intervalMs: config.watchdogIntervalMs,
					cancelContinuation: () => {
						continuation.cancelFailedTurn(record.failedTurnRef);
					},
				});
			},
		});
		watchdog = new ContinuationWatchdog({
			state,
			diagnostics,
			notify: () => {
				pi.sendMessage({
					customType: "pi-multi-account-watchdog",
					content: FOLLOW_UP_DISPLAY,
					display: true,
				});
			},
		});

		/**
		 * Resolves a managed account's operator-facing label.
		 *
		 * Credential access is confined here rather than in the registration module:
		 * the stored credential is read through Pi's public `readStoredCredential`
		 * solely so a Codex JWT's identity claim can be projected into a bounded
		 * label. A configured label always wins, and any failure degrades to the
		 * canonical provider id so registration can never fail for want of a name.
		 */
		const resolveLabelFor = (providerId: string): string => {
			try {
				// The current-limit guard runs inside resolveAccountLabelWithinLimit,
				// before the configured map is indexed and before the lazy token
				// reader below touches a credential, so a hostile above-limit provider
				// id resolves to the canonical id with no configured-map or credential
				// access.
				return resolveAccountLabelWithinLimit({
					providerId,
					accountLimit: config.accountLimit,
					configured: config.accountLabels,
					readToken: (boundedProviderId) => {
						const credential = readStoredCredential(
							boundedProviderId,
							authPath,
						) as { access?: unknown } | undefined;
						return credential?.access;
					},
				});
			} catch (error) {
				diagnostics.recordError("account.label", error);
				return providerId;
			}
		};

		const rediscover = async (): Promise<void> => {
			if (!context || !codexCaptured) return;
			const discovered = await discoverAccounts({
				publicAdapter: createPublicAuthStorageAdapter(
					createReadStoredCredentialProbe(readStoredCredential, authPath),
					config.accountLimit,
				),
				authJsonPath: authPath,
				config,
			});
			// When codex is disabled (host OAuth surface unavailable), strip codex
			// slots so the disabled sentinel's throwing callbacks are never reached.
			discovery = codexEnabled
				? discovered
				: codexDisabledDiscovery(discovered);
			warmer.resetUnavailable();
			registerDiscoveredProviders({
				pi,
				extensionContext: context,
				anthropicCaptured,
				codexCaptured,
				...(antigravityConfig === undefined ? {} : { antigravityConfig }),
				slots: discovery.slots,
				spareSlots: discovery.spareSlots,
				config,
				resolveLabel: (providerId) => resolveLabelFor(providerId),
				modelSupport,
			});
			// Pi refreshes provider availability asynchronously after every
			// registerProvider call. Without one final awaited refresh, an immediate
			// metadata query can race those background refreshes and observe an empty
			// route surface even though every alias was registered. This reproduced in
			// real Pi 0.84.0 and 0.84.1 children only when pi-anthropic-oauth loaded
			// first. A local-only refresh is the startup publication barrier.
			await context.modelRegistry.refresh({ allowNetwork: false });
		};

		const addSlot = (
			family: ManagedFamily,
			slotNumber?: number,
		): Promise<string> => {
			if (!context || !codexCaptured)
				throw new Error("Extension initialization is not complete.");
			if (family === CODEX_PROVIDER && !codexEnabled)
				throw new Error(CODEX_DISABLED_DIAGNOSTIC);
			const existing = new Set([
				...(discovery?.slots.map((slot) => slot.providerId) ?? []),
				...(discovery?.spareSlots.values() ?? []),
			]);
			// Search a numbered slot through the sole iterator. Each yield is
			// revalidated against the current limit before the canonical formatter and
			// the occupied-id lookup, so a regressed iterator cannot format or probe a
			// slot above the limit. An explicit slot number selects that exact slot,
			// so a completion-displayed slot that is now occupied is rejected rather
			// than silently registering the next free slot; without one, the first
			// free slot from 2 upward is chosen.
			const requestedFloor = slotNumber ?? 2;
			let selectedIndex: number | undefined;
			let selectedProviderId: string | undefined;
			for (const index of accountSlotIndexes(config.accountLimit, 2)) {
				if (!isAccountSlotIndex(index, config.accountLimit)) continue;
				if (
					slotNumber === undefined
						? index < requestedFloor
						: index !== slotNumber
				)
					continue;
				const candidateProviderId = canonicalProviderIdForAccountSlot(
					family,
					index,
					config.accountLimit,
				);
				if (candidateProviderId === null) continue;
				if (existing.has(candidateProviderId)) continue;
				selectedIndex = index;
				selectedProviderId = candidateProviderId;
				break;
			}
			// Final independent guard immediately before either family's
			// registerProvider() call: the selected index must be in range, at least
			// 2, and its exact canonical id must match the value chosen above.
			if (
				selectedIndex === undefined ||
				selectedProviderId === undefined ||
				!isAccountSlotIndex(selectedIndex, config.accountLimit) ||
				selectedIndex < 2 ||
				canonicalProviderIdForAccountSlot(
					family,
					selectedIndex,
					config.accountLimit,
				) !== selectedProviderId
			)
				throw new RangeError("No configured account slot is available.");
			const providerId = selectedProviderId;
			const index = selectedIndex;
			if (family === "anthropic") {
				const anthropicModels = cloneProviderModelCatalog(
					context.modelRegistry,
					"anthropic",
				);
				pi.registerProvider(
					providerId,
					createAnthropicAliasProviderConfig(
						anthropicCaptured,
						anthropicModels,
					),
				);
			} else if (family === "openai") {
				pi.registerProvider(
					providerId,
					createOpenAiAliasProviderConfig(
						openaiPlatformModels(context.modelRegistry),
						`Account ${index}`,
					),
				);
			} else if (family === "google-antigravity") {
				// The composition root's preloaded boundary is the only source for an
				// added Antigravity slot; `registerDiscoveredProviders` applies the
				// same "publish nothing until it loads" rule for discovered slots. When
				// it has not loaded yet, this command fails closed with an actionable
				// error instead of falling through to a mismatched Codex-shaped config.
				if (antigravityConfig === undefined) {
					throw new Error(
						"The Antigravity provider boundary is unavailable; rerun after it loads (see diagnostics: antigravity.primitives-load).",
					);
				}
				// The per-slot OAuth-credential-projection wrapper is reviewed,
				// in-scope code owned by `provider-registration.ts`'s exported
				// `createAntigravitySlotConfig`. Reusing it here -- the same wrapper
				// `registerDiscoveredProviders` calls for discovery -- keeps discovery
				// and add on one source of truth instead of a second, divergence-prone
				// copy of the credential boundary. Every credential-shaped field stays
				// behind that wrapper's login/refreshToken/getApiKey callbacks, so
				// this command never sees, captures, or persists a raw token: the
				// callback continues to run inside Pi's host-owned OAuth surface.
				pi.registerProvider(
					providerId,
					createAntigravitySlotConfig(
						antigravityConfig,
						providerId,
						resolveLabelFor,
						(_providerId, models) => models,
					),
				);
			} else {
				const codexModels = getCodexModelsFromRegistry(context.modelRegistry);
				pi.registerProvider(
					providerId,
					createCodexAliasProviderConfig(
						codexCaptured,
						`Account ${index}`,
						codexModels,
					),
				);
			}
			return Promise.resolve(providerId);
		};

		/** Where the machine-global managed declaration lives. */
		const declarationPath = join(baseDirectory, "models.json");
		let logicalRoutingState:
			| Readonly<{
					status: InstalledDeclarationStatus;
					capturedAtMs: number;
			  }>
			| undefined;
		const declarationNoticeMarker = new DeclarationNoticeMarker();

		const isAnthropicDeclarationModel = (
			model: Model<Api>,
		): model is Model<"anthropic-messages"> =>
			model.api === "anthropic-messages";
		const isCodexDeclarationModel = (
			model: Model<Api>,
		): model is Model<"openai-codex-responses"> =>
			model.api === "openai-codex-responses";
		const isAntigravityDeclarationModel = (
			model: Model<Api>,
		): model is Model<typeof GOOGLE_ANTIGRAVITY_API> =>
			model.api === GOOGLE_ANTIGRAVITY_API;

		/**
		 * Read the complete live managed models fresh on every call. The canonical
		 * declaration projector owns every copied-or-excluded field decision; this
		 * caller must not make a preliminary partial copy that can silently lag Pi.
		 */
		const readDeclarationCatalogs = (): ModelsCatalogs => {
			if (context === undefined) {
				throw new Error(
					"The model registry is not ready; try again in a moment.",
				);
			}
			const allModels = context.modelRegistry.getAll();
			const anthropicModels = allModels.filter(
				(model) => model.provider === "anthropic",
			);
			const codexModels = allModels.filter(
				(model) => model.provider === "openai-codex",
			);
			// The base slot is the only source for the declaration: slot 1 registers
			// under the literal family id, exactly like `anthropic`/`openai-codex`
			// above. Numbered aliases keep their own account-scoped provider id and
			// are attributed at dispatch time, never copied into this projection.
			const antigravityModels = allModels.filter(
				(model) => model.provider === "google-antigravity",
			);
			if (!anthropicModels.every(isAnthropicDeclarationModel)) {
				throw new Error(
					"The live anthropic catalog uses an unexpected physical API; logical registration stays off.",
				);
			}
			if (!codexModels.every(isCodexDeclarationModel)) {
				throw new Error(
					"The live openai-codex catalog uses an unexpected physical API; logical registration stays off.",
				);
			}
			if (!antigravityModels.every(isAntigravityDeclarationModel)) {
				throw new Error(
					"The live google-antigravity catalog uses an unexpected physical API; logical registration stays off.",
				);
			}
			return {
				anthropic: anthropicModels,
				"openai-codex": codexModels,
				"google-antigravity": antigravityModels,
			};
		};

		const resolveCommandAccountGroup = (): AccountGroupCommandStatus => {
			const liveContext = context;
			if (
				liveContext === undefined ||
				typeof liveContext.sessionManager?.getSessionId !== "function"
			) {
				throw new Error("The live session identity is unavailable.");
			}
			const resolution = resolveOwnSessionAccountGroup(
				liveContext.sessionManager,
				liveContext.cwd,
			);
			if (resolution.source === "unrestricted") return { resolution };
			const members = config.accountGroups?.[resolution.groupId] ?? [];
			const nowMs = Date.now();
			const routingAccounts = physicalAccountsForRouting(nowMs);
			return {
				resolution,
				members: members.map((providerId) => {
					const eligible =
						selectAvailableManagedAccount({
							accounts: routingAccounts.filter(
								(account) => account.providerId === providerId,
							),
							state,
							nowMs,
						}) !== undefined;
					return {
						providerId,
						eligible,
						reason: eligible
							? "routing-eligible"
							: "not currently routing-eligible",
					};
				}),
			};
		};

		const commands = new MultiAccountCommandController({
			state,
			usage,
			diagnostics,
			continuation,
			watchdog,
			cancelPendingActivity: () => lifecycle.cancelPendingActivity("stop"),
			// Live inputs for `models install` and `models update`, sharing the
			// one catalog projection the startup gate also uses.
			modelsDeclaration: {
				targetPath: declarationPath,
				readCatalogs: readDeclarationCatalogs,
			},
			accounts: () =>
				operatorAccounts(context, discovery, authPath, config.accountLimit),
			accountGroups: {
				use: (groupId) => {
					if (!Object.hasOwn(config.accountGroups ?? {}, groupId)) {
						throw new Error(`Unknown account group ${groupId}.`);
					}
					const sessionManager = context?.sessionManager;
					if (typeof sessionManager?.getSessionId !== "function") {
						throw new Error("The live session identity is unavailable.");
					}
					sessionAccountGroups.setOverride(sessionManager, groupId);
					// A named group is a closed dispatch set. Retire an already armed
					// metered bridge synchronously so its reserved continuation cannot
					// consume approval after this policy action returns.
					if (openRouterBridge !== undefined) {
						openRouterBridge.reservationArmed = false;
						openRouterBridge.retiredByAccountGroup = true;
						openRouterInputApproved = false;
					}
					return resolveCommandAccountGroup();
				},
				reset: () => {
					const sessionManager = context?.sessionManager;
					if (typeof sessionManager?.getSessionId !== "function") {
						throw new Error("The live session identity is unavailable.");
					}
					sessionAccountGroups.clearOverride(sessionManager);
					return resolveCommandAccountGroup();
				},
				status: resolveCommandAccountGroup,
			},
			logicalRoutingState: () => logicalRoutingState,
			disabledProviders,
			isAccountEligible: (providerId, nowMs) =>
				selectAvailableManagedAccount({
					accounts: physicalAccountsForRouting(nowMs).filter(
						(account) => account.providerId === providerId,
					),
					state,
					nowMs,
				}) !== undefined,
			currentProviderId: () => currentModel?.provider,
			activeAccountProviderId: () =>
				currentModel?.provider === LOGICAL_PROVIDER_ID
					? latestLogicalPhysicalProviderId
					: undefined,
			activeModelId: () => currentModel?.id,
			accountLabel: (providerId) => {
				const label = resolveLabelFor(providerId);
				return label === providerId ? undefined : label;
			},
			// Re-read live rather than using the discovery snapshot: a long-lived
			// session's snapshot ages out and would report healthy accounts as
			// expired, prompting an unnecessary sign-in.
			credentialExpiry: (providerId) =>
				readLiveCredentialFacts(providerId, authPath).credential?.expiresAtMs,
			unsupportedModels: () => modelSupport.unsupported(),
			usageFetchStatus: (providerId) => {
				const family = managedFamily(providerId);
				return family === undefined
					? undefined
					: usageFetcher.status(providerId, family, config);
			},
			costReport,
			meteredFallbackStatus: () => {
				const policy = openRouterPolicy();
				const configuredPolicy = resolveOpenRouterEnvironmentPolicy({
					environment: openRouterEnvironment,
					sessionDisabled: false,
				});
				let reservedTodayUsd: number | undefined;
				if (configuredPolicy.enabled) {
					try {
						reservedTodayUsd = openRouterBudget.reservedToday(
							projectKey,
							Date.now(),
						);
					} catch {
						reservedTodayUsd = undefined;
					}
				}
				return {
					providerId: OPENROUTER_PROVIDER_ID,
					enabled: policy.enabled,
					reason: policy.reason,
					active: currentModel?.provider === OPENROUTER_PROVIDER_ID,
					sessionDisabled: openRouterSessionDisabled,
					conversationEgressConsented:
						policy.conversationEgressConsented,
					delegatesAllowed: false as const,
					...(configuredPolicy.enabled
						? {
								configuredModel: configuredPolicy.modelId,
								dailyLimitUsd: configuredPolicy.dailyLimitUsd,
								...(reservedTodayUsd === undefined
									? {}
									: {
											reservedTodayUsd,
											remainingTodayUsd:
												Math.round(
													Math.max(
														0,
														configuredPolicy.dailyLimitUsd -
															reservedTodayUsd,
													) * 1_000_000,
												) / 1_000_000,
										}),
							}
						: {}),
				};
			},
			setModel,
			rediscover,
			addSlot,
			reloadGlobalConfig: async () => readConfig(configPath),
			onConfigReload: async (nextConfig) => {
				config = nextConfig;
				await rediscover();
			},
			routingConfig: {
				readPersistedRouting: () => routingProjection(readConfig(configPath)),
				processEffectiveRouting: () => routingProjection(config),
				commit: (input) =>
					commitRoutingConfig({
						configPath,
						lockPath: routingConfigLockPath(configPath),
						promptSnapshot: input.promptSnapshot,
						candidate: input.candidate,
						processEffectiveConfig: () => config,
						// Contracted non-throwing routing-only assignment. Reload keeps
						// its complete-config plus rediscovery path; configure must not
						// move account, label, usage, or cost fields into this closure.
						publishRouting: (projection: RoutingProjection) => {
							config = { ...config, ...projection };
						},
						diagnostics,
						...(input.signal === undefined
							? {}
							: { signal: input.signal }),
					}),
			},
		});
		/**
		 * The latest failure classified during the current agent run.
		 *
		 * Pi emits `message_end` once per retry attempt — the 2026-08-05 trace shows
		 * four per turn, one initial request plus three backoff retries, each with a
		 * distinct upstream request id — so acting on the first one fights Pi's own
		 * retry layer. Failures are recorded here as they are observed and read
		 * exactly once, when `agent_settled` reports that no further automatic retry
		 * will run.
		 */
		let pendingFailure: ClassifiedFailure | undefined;
		let lifecycle: MultiAccountLifecycle;

		const tryOpenRouterLastResort = async (input: {
			readonly routingAccounts: readonly ManagedAccount[];
			readonly origin: TurnRouteOrigin;
			readonly nowMs: number;
			readonly unavailableProviderIds?: ReadonlySet<string>;
		}): Promise<boolean> => {
			// Group scope is stricter than the optional metered rung. For unrestricted
			// sessions, consent, delegate exclusion, session disablement, model syntax,
			// and the positive budget cap remain the authority for OpenRouter.
			// A named account group is a closed dispatch set. Metered OpenRouter is
			// intentionally outside every group and therefore cannot widen exhaustion.
			if (accountGroupScopeRestrictsRouting()) return false;
			const policy = openRouterPolicy();
			if (!policy.enabled) return false;
			const blocker = selectManagedLastResortCandidate({
				accounts: input.routingAccounts,
				state,
				nowMs: input.nowMs,
				originFamily: input.origin.family,
				...(input.origin.requestedModelId === undefined
					? {}
					: { requestedModelId: input.origin.requestedModelId }),
				config,
				preferredProviderId: input.origin.providerId,
				...(input.unavailableProviderIds === undefined
					? {}
					: { excludedProviderIds: input.unavailableProviderIds }),
				modelSupport,
			});
			if (blocker !== undefined || input.origin.requestedModelId === undefined) {
				return false;
			}

			const originModel = context
				? providerModels(context, input.origin.providerId).find(
						(model) => model.id === input.origin.requestedModelId,
					)
				: undefined;
			const resolvedOpenRouter = resolvedOpenRouterModel(
				input.origin.requestedModelId,
				policy.modelId,
			);
			const resolvedOpenRouterModelId = resolvedOpenRouter?.modelId;
			const fallbackModel = resolvedOpenRouter?.model;
			const reservationUsd =
				fallbackModel === undefined
					? undefined
					: worstCaseOpenRouterTurnUsd(fallbackModel);
			if (fallbackModel === undefined) {
				recordOpenRouterConditionOnce(
					"model-unavailable",
					"warning",
					"Explicit OpenRouter fallback is enabled, but the resolved model is absent from the live catalogue; the turn will park.",
					{ modelId: resolvedOpenRouterModelId ?? input.origin.requestedModelId },
				);
				return false;
			}
			if (reservationUsd === undefined) {
				recordOpenRouterConditionOnce(
					"pricing-unavailable",
					"warning",
					"Explicit OpenRouter fallback is enabled, but a conservative maximum charge cannot be derived; the turn will park.",
					{ modelId: resolvedOpenRouterModelId },
				);
				return false;
			}
			if (originModel === undefined) return false;

			let configured = false;
			try {
				// The host's non-throwing false return is the ONLY key-presence
				// check. The extension never reads or copies the key itself.
				configured = await setModel(fallbackModel);
			} catch {
				recordOpenRouterConditionOnce(
					"selection-error",
					"warning",
					"OpenRouter selection failed before dispatch; the turn will park without metered spend.",
				);
			}
			if (!configured) return false;

			const bridge = {
				originProviderId: input.origin.providerId,
				originFamily: input.origin.family,
				originModelId: input.origin.requestedModelId,
				reservationArmed: false,
				retiredByAccountGroup: false,
			};
			openRouterBridge = bridge;
			let reservation: ReturnType<OpenRouterBudgetStore["reserve"]>;
			try {
				reservation = openRouterBudget.reserve({
					projectKey,
					reservationUsd,
					dailyLimitUsd: policy.dailyLimitUsd,
					nowMs: input.nowMs,
				});
			} catch {
				reservation = { status: "unavailable" };
			}
			if (reservation.status !== "reserved") {
				if (await restoreOpenRouterOrigin()) openRouterBridge = undefined;
				recordOpenRouterConditionOnce(
					reservation.status,
					reservation.status === "exhausted" ? "info" : "warning",
					reservation.status === "exhausted"
						? "The explicit OpenRouter daily budget is exhausted; the turn will park."
						: "The OpenRouter budget lease or state is unavailable; the turn will park without metered spend.",
					reservation.status === "exhausted"
						? {
								reservedTodayUsd: reservation.reservedTodayUsd,
								remainingTodayUsd: reservation.remainingTodayUsd,
							}
						: undefined,
				);
				return false;
			}

			bridge.reservationArmed = true;
			const outcome = await lifecycle.handleClassifiedFailure(
				state.mintReference(),
				{
					providerId: OPENROUTER_PROVIDER_ID,
					family: "openrouter",
					model: fallbackModel,
					routingReason: "metered-last-resort",
				},
			);
			if (outcome?.status !== "scheduled") {
				if (await restoreOpenRouterOrigin()) openRouterBridge = undefined;
				return false;
			}
			diagnostics.record(
				"warning",
				"routing.openrouter-metered",
				"All managed OAuth accounts are unavailable; continuing once through explicitly enabled metered OpenRouter fallback.",
				{
					modelId: resolvedOpenRouterModelId,
					dailyLimitUsd: policy.dailyLimitUsd,
					reservationUsd,
					reservedTodayUsd: reservation.reservedTodayUsd,
					remainingTodayUsd: reservation.remainingTodayUsd,
				},
			);
			return true;
		};

		const providerAllowedByActiveGroup = (
			providerId: string,
			inputContext: ExtensionContext,
		): boolean => {
			if (!accountGroupScopeRestrictsRouting()) return true;
			if (providerId === LOGICAL_PROVIDER_ID) return true;
			try {
				return subscriptionOperatorAccounts(context ?? inputContext).some(
					(account) => account.providerId === providerId,
				);
			} catch {
				return false;
			}
		};
		const accountGroupOrigin = (
			providerId: string,
			requestedModelId: string | undefined,
		):
			| {
					readonly providerId: string;
					readonly family: AllowedFamily;
					readonly requestedModelId?: string;
			  }
			| undefined => {
			if (providerId === OPENROUTER_PROVIDER_ID && openRouterBridge !== undefined) {
				return {
					providerId: openRouterBridge.originProviderId,
					family: openRouterBridge.originFamily,
					requestedModelId: openRouterBridge.originModelId,
				};
			}
			const slot = classifyProviderId({
				providerId,
				credentialType: "unknown",
			});
			if (slot === null) return undefined;
			const family =
				slot.family === "openai"
					? "openai-codex"
					: isAllowedFamily(slot.family)
						? slot.family
						: undefined;
			if (family === undefined) return undefined;
			return {
				providerId,
				family,
				...(requestedModelId === undefined ? {} : { requestedModelId }),
			};
		};
		const guardAccountGroupInput = async (
			inputContext: ExtensionContext,
		): Promise<{ readonly action: "continue" | "handled" }> => {
			const activeProviderId =
				inputContext.model?.provider ?? currentModel?.provider;
			if (
				activeProviderId === undefined ||
				providerAllowedByActiveGroup(activeProviderId, inputContext)
			) {
				return { action: "continue" };
			}
			const origin = accountGroupOrigin(
				activeProviderId,
				inputContext.model?.id ?? currentModel?.id,
			);
			let replacement: Model<Api> | undefined;
			if (origin !== undefined) {
				try {
					const nowMs = Date.now();
					const allowedAccounts = subscriptionOperatorAccounts(
						context ?? inputContext,
					);
					const candidate = selectAvailableRecoveryAccount({
						accounts: physicalAccountsForRouting(nowMs),
						state,
						config,
						nowMs,
						originFamily: origin.family,
						...(origin.requestedModelId === undefined
							? {}
							: {
									requestedModelId: origin.requestedModelId,
									preferredModelId: origin.requestedModelId,
								}),
						modelSupport,
					});
					const destination = allowedAccounts.find(
						(account) => account.providerId === candidate?.destination.providerId,
					);
					if (candidate !== undefined && destination !== undefined) {
						replacement = routeCandidateModel(
							candidate,
							destination,
							context ?? inputContext,
							origin.requestedModelId,
							origin.family,
							config.preferredModels,
						);
					}
				} catch {
					replacement = undefined;
				}
			}
			if (replacement !== undefined) {
				try {
					if (await setModel(replacement)) {
						if (origin !== undefined) {
							recordAutomaticDestination(
								{
									providerId: origin.providerId,
									family: origin.family,
									...(origin.requestedModelId === undefined
										? {}
										: { requestedModelId: origin.requestedModelId }),
									logical: false,
								},
								replacement.provider,
							);
						}
						if (activeProviderId === OPENROUTER_PROVIDER_ID) {
							openRouterBridge = undefined;
							openRouterInputApproved = false;
						}
						diagnostics.record(
							"info",
							"routing.account-group-direct-switch",
							"The active provider was outside the session account group and was replaced before dispatch.",
							{ providerId: replacement.provider },
						);
						return { action: "continue" };
					}
				} catch {
					// Selection failure cannot authorize an excluded provider.
				}
			}
			diagnostics.record(
				"warning",
				"routing.account-group-direct-blocked",
				"The active provider was outside the session account group and no allowed replacement could be selected; the input was blocked before dispatch.",
				{ providerId: activeProviderId },
			);
			inputContext.ui.notify(
				"Multi-account blocked a provider outside the active account group.",
				"warning",
			);
			return { action: "handled" };
		};
		const guardOpenRouterInput = async (
			inputContext: ExtensionContext,
		): Promise<{ readonly action: "continue" | "handled" }> => {
			const activeProviderId =
				inputContext.model?.provider ?? currentModel?.provider;
			if (
				activeProviderId !== OPENROUTER_PROVIDER_ID ||
				openRouterBridge === undefined
			) {
				return { action: "continue" };
			}

			const bridge = openRouterBridge;
			if (bridge.retiredByAccountGroup) {
				if (await restoreOpenRouterOrigin()) {
					openRouterBridge = undefined;
					return { action: "continue" };
				}
				recordOpenRouterConditionOnce(
					"group-retired-input-blocked",
					"warning",
					"An account-group selection retired the metered OpenRouter bridge and its managed origin could not be restored; the input was blocked before provider dispatch.",
				);
				inputContext.ui.notify(
					"Multi-account blocked a retired OpenRouter turn. Run /multi-account status for recovery details.",
					"warning",
				);
				return { action: "handled" };
			}
			const nowMs = Date.now();
			const routingAccounts = physicalAccountsForRouting(nowMs);
			const operatorAccountList = physicalOperatorAccounts(
				context ?? inputContext,
			);
			const rejectedProviders = new Set<string>();
			while (rejectedProviders.size < routingAccounts.length) {
				const recovered = selectManagedLastResortCandidate({
					accounts: routingAccounts,
					state,
					nowMs,
					originFamily: bridge.originFamily,
					requestedModelId: bridge.originModelId,
					config,
					preferredProviderId: bridge.originProviderId,
					excludedProviderIds: rejectedProviders,
					modelSupport,
				});
				if (recovered === undefined) break;
				rejectedProviders.add(recovered.destination.providerId);
				const account = operatorAccountList.find(
					(candidate) =>
						candidate.providerId === recovered.destination.providerId,
				);
				const model = routeCandidateModel(
					recovered,
					account,
					context ?? inputContext,
					bridge.originModelId,
					bridge.originFamily,
					config.preferredModels,
				);
				if (model === undefined) continue;
				try {
					if (await setModel(model)) {
						recordAutomaticDestination(
							{
								providerId: bridge.originProviderId,
								family: bridge.originFamily,
								requestedModelId: bridge.originModelId,
								logical: false,
							},
							recovered.destination.providerId,
						);
						preserveOriginAcrossNextInputClear = true;
						openRouterBridge = undefined;
						diagnostics.record(
							"info",
							"routing.openrouter-returned",
							"A managed account recovered; leaving metered OpenRouter fallback before the next turn.",
							{ providerId: recovered.destination.providerId },
						);
						return { action: "continue" };
					}
				} catch {
					// A transient managed-account selection failure does not prove
					// recovery and must not bypass this turn's metered reservation.
				}
			}

			const policy = openRouterPolicy();
			if (!policy.enabled) {
				if (await restoreOpenRouterOrigin()) {
					openRouterBridge = undefined;
					return { action: "continue" };
				}
				recordOpenRouterConditionOnce(
					"preflight-blocked",
					"warning",
					"OpenRouter fallback is no longer enabled and no managed origin could be restored; the input was blocked before provider dispatch.",
				);
				inputContext.ui.notify(
					"Multi-account blocked an unreserved OpenRouter turn. Run /multi-account status for recovery details.",
					"warning",
				);
				return { action: "handled" };
			}
			if (bridge.reservationArmed) {
				bridge.reservationArmed = false;
				openRouterInputApproved = true;
				return { action: "continue" };
			}

			const resolvedOpenRouter = resolvedOpenRouterModel(
				bridge.originModelId,
				policy.modelId,
				context ?? inputContext,
			);
			const model = resolvedOpenRouter?.model;
			const reservationUsd =
				model === undefined ? undefined : worstCaseOpenRouterTurnUsd(model);
			let reserved = false;
			if (reservationUsd !== undefined) {
				try {
					reserved =
						openRouterBudget.reserve({
							projectKey,
							reservationUsd,
							dailyLimitUsd: policy.dailyLimitUsd,
							nowMs,
						}).status === "reserved";
				} catch {
					reserved = false;
				}
			}
			if (reserved) {
				openRouterInputApproved = true;
				return { action: "continue" };
			}
			if (await restoreOpenRouterOrigin()) {
				openRouterBridge = undefined;
				return { action: "continue" };
			}
			recordOpenRouterConditionOnce(
				"unreserved-input-blocked",
				"warning",
				"The OpenRouter input could not reserve its conservative budget and no managed origin could be restored; the input was blocked before provider dispatch.",
			);
			inputContext.ui.notify(
				"Multi-account blocked an unreserved OpenRouter turn. Run /multi-account status for recovery details.",
				"warning",
			);
			return { action: "handled" };
		};

		/**
		 * Routes the failure that survived the retry sequence, at most once per
		 * settled run.
		 *
		 * The record is taken and cleared before the first `await`, so a repeated
		 * `agent_settled` cannot dispatch a second continuation for the same turn.
		 */
		const settleTurn = async (): Promise<void> => {
			openRouterInputApproved = false;
			if (pendingOpenRouterFailure) {
				pendingOpenRouterFailure = false;
				const restored = await restoreOpenRouterOrigin();
				const parkRef = state.mintReference();
				const parked = continuation.park(parkRef);
				recordOpenRouterConditionOnce(
					"provider-failed",
					"warning",
					"OpenRouter failed; metered fallback is disabled for this session and the turn is parked for managed-account recovery.",
					{ parked, restored },
				);
				if (restored) openRouterBridge = undefined;
				return;
			}
			const classified = pendingFailure;
			pendingFailure = undefined;
			const origin = turnRouteOrigin;
			if (!classified || origin === undefined) return;
			const { providerId, family, failure } = classified;
			const accounts = physicalOperatorAccounts();
			const nowMs = Date.now();
			const routingAccounts = physicalAccountsForRouting(nowMs);
			const failedAccount = routingAccounts.find(
				(account) =>
					account.providerId === providerId && account.family === family,
			);
			if (failedAccount === undefined) return;

			// One opportunistic refresh per quota failure, at the settled boundary.
			//
			// The hold installed at classification is a guess with an expiry; this
			// is what can replace it with the provider's own recovery time. It is
			// detached and failure-tolerant: the refresh is an improvement to
			// routing state, never a step the turn's outcome waits on.
			//
			// `classified.failedAtMs` rather than now: a poll that ran after the
			// failure but before this settlement has already asked the endpoint
			// this failure's question, and must suppress.
			if (
				classified.failedAtMs !== undefined &&
				isRoutingEligibleAccountFamily(failedAccount)
			) {
				void usageFetcher
					.refreshAfterFailure(failedAccount, config, classified.failedAtMs)
					.catch(() => undefined);
			}

			// Pi refreshes OAuth only when the local expiry says it is due. An explicit
			// provider 401 can therefore strand a server-revoked token that still looks
			// locally valid. At the host's settlement boundary -- after its own retries
			// are finished -- force one locked refresh and give that SAME account one
			// non-replaying continuation. Any failure, identity change, unavailable host
			// capability, or later 401 keeps the existing invalidate-and-route behavior.
			if (
				failure.httpStatus === 401 &&
				forcedCredentialRefresher !== undefined &&
				isRoutingEligibleAccountFamily(failedAccount)
			) {
				const refreshOutcome = await forcedCredentialRefresher.attempt(
					providerId,
					failedAccount.family,
				);
				if (refreshOutcome === "refreshed") {
					const refreshedAccount = accounts.find(
						(account) => account.providerId === providerId,
					);
					if (
						refreshedAccount !== undefined &&
						isRoutingEligibleAccountFamily(refreshedAccount)
					) {
						const retry = await lifecycle.handleClassifiedFailure(
							state.mintReference(),
							{
								providerId,
								family,
								model: destinationModel(
									refreshedAccount,
									context,
									origin.requestedModelId ?? failure.modelId,
									origin.family,
									config.preferredModels,
								),
								routingReason: "terminal-auth-failure",
							},
						);
						if (retry?.status === "scheduled") return;
						diagnostics.record(
							"warning",
							"credential.force-refresh-selection",
							"The refreshed account rejected selection; normal invalidation and routing will continue.",
							{ providerId },
						);
					}
				}
			}

			const decision = routeAfterFailure({
				failedAccount,
				accounts: routingAccounts,
				failure,
				originFamily: origin.family,
				...(origin.requestedModelId === undefined
					? {}
					: { requestedModelId: origin.requestedModelId }),
				state,
				config,
				nowMs,
				modelSupport,
				alreadyCooled: classified.alreadyCooled === true,
			});
			if (decision.status === "paused") {
				// OpenRouter is an explicitly enabled, metered FINAL rung. The helper
				// re-checks every managed family so family-chain policy cannot bypass
				// healthy OAuth capacity.
				if (
					await tryOpenRouterLastResort({
						routingAccounts,
						origin,
						nowMs,
					})
				) {
					return;
				}

				// REQ-FAILOVER-PARK. This branch used to record a diagnostic and
				// return, so a turn that hit a fully-exhausted fleet was abandoned and
				// nothing ever re-checked. Park it instead and let the poll resume it
				// when an account genuinely recovers.
				const parkRef = state.mintReference();
				const parked = continuation.park(parkRef);
				diagnostics.record(
					"warning",
					"routing.paused",
					parked
						? // REQ-FAILOVER-CANCEL: a park with no stated escape is worse than
							// the failure it replaces, so the announcement carries the exit.
							"All eligible accounts are unavailable; the turn is parked and will " +
								"resume when one recovers. Run `/multi-account stop` to cancel it."
						: "All eligible accounts are unavailable.",
					{
						earliestRecoveryAtMs: decision.earliestRecoveryAtMs,
						parked,
					},
				);
				return;
			}
			const destination = accounts.find(
				(account) => account.providerId === decision.destination.providerId,
			);
			if (!destination) return;
			const routingReason = continuationReason(
				decision.classification.category,
				failure.code,
			);
			if (!routingReason) {
				diagnostics.record(
					"warning",
					"routing.advisory",
					"A transient or unknown failure changed process-local routing state without automatic follow-up.",
				);
				return;
			}
			const destinationRouteModel = routeCandidateModel(
				decision,
				destination,
				context,
				origin.requestedModelId ?? failure.modelId,
				origin.family,
				config.preferredModels,
			);
			const attemptedProviders = new Set<string>([destination.providerId]);
			const outcome =
				destinationRouteModel === undefined
					? {
							status: "selection-failed" as const,
							rejection: "unconfigured" as const,
							excludeDestination: true,
						}
					: await lifecycle.handleClassifiedFailure(
							state.mintReference(),
							continuationDestinationFor(
								origin,
								decision,
								destination,
								destinationRouteModel,
								routingReason,
							),
						);

			// A missing carried model and an explicit host rejection both advance only
			// through policy-filtered candidates; neither scans a raw catalog.
			if (outcome?.status !== "selection-failed") return;

			// Exclusions are bounded to THIS failure's candidate scan. They are
			// deliberately not persisted onto `state`, because
			// `configuredProviders` mutates mid-session (model-runtime.ts:341-363),
			// so a session-scoped exclusion would permanently shrink the fleet
			// after one transient auth blip.
			const excluded = new Set<string>();
			if (outcome.excludeDestination) excluded.add(destination.providerId);

			const retryCandidates = selectAvailableRouteCandidates({
				accounts: routingAccounts,
				state,
				nowMs,
				originFamily: origin.family,
				...(origin.requestedModelId === undefined
					? {}
					: { requestedModelId: origin.requestedModelId }),
				config,
				failedProviderId: providerId,
				excludedProviderIds: excluded,
				...(failure.code === "model_not_found" &&
				failure.modelId !== undefined &&
				isRoutingEligibleAccountFamily(failedAccount) &&
				failedAccount.family === origin.family
					? { modelId: failure.modelId }
					: {}),
				...(origin.requestedModelId === undefined
					? {}
					: { preferredModelId: origin.requestedModelId }),
				modelSupport,
			});
			for (const retryCandidate of retryCandidates) {
				const candidate = accounts.find(
					(account) =>
						account.providerId === retryCandidate.destination.providerId,
				);
				if (candidate === undefined) continue;
				const candidateModel = routeCandidateModel(
					retryCandidate,
					candidate,
					context,
					origin.requestedModelId ?? failure.modelId,
					origin.family,
					config.preferredModels,
				);
				if (candidateModel === undefined) continue;
				attemptedProviders.add(candidate.providerId);
				const retry = await lifecycle.handleClassifiedFailure(
					state.mintReference(),
					continuationDestinationFor(
						origin,
						retryCandidate,
						candidate,
						candidateModel,
						routingReason,
					),
				);
				if (retry?.status === "scheduled") return;
				if (retry?.status === "selection-failed" && retry.excludeDestination) {
					excluded.add(candidate.providerId);
				}
			}

			if (
				await tryOpenRouterLastResort({
					routingAccounts,
					origin,
					nowMs,
					unavailableProviderIds: attemptedProviders,
				})
			) {
				return;
			}
			const parked = continuation.park(state.mintReference());
			diagnostics.record(
				"warning",
				"routing.selection-exhausted",
				parked
					? "Every eligible managed account rejected selection; the turn is parked for recovery."
					: "Every eligible managed account rejected selection; no continuation was scheduled.",
				{ excluded: [...excluded], parked },
			);
		};

		// Live, fail-soft completion composition. Each closure re-reads current
		// context/config/discovery on every invocation, owns its own try/catch, and
		// returns null on an unexpected failure so one mutated source cannot stand
		// in for another. None reads a credential, human label, or raw error, and
		// none mutates process state.
		const readCompletionAccounts = ():
			| readonly CompletionAccountIdentity[]
			| null => {
			try {
				const liveContext = context;
				if (liveContext === undefined) return [];
				return projectCompletionAccounts({
					slots: discovery?.slots ?? [],
					accountLimit: config.accountLimit,
					hasLiveModel: (providerId) =>
						providerModels(liveContext, providerId).length > 0,
				});
			} catch {
				return null;
			}
		};
		const readCompletionAddSlots = (): CompletionSlotChoices | null => {
			try {
				return projectCompletionAddSlots({
					slots: discovery?.slots ?? [],
					spareProviderIds: [...(discovery?.spareSlots.values() ?? [])],
					accountLimit: config.accountLimit,
					codexEnabled,
				});
			} catch {
				return null;
			}
		};
		const readLogicalModelInventory = (): LogicalModelInventory | null => {
			try {
				const liveContext = context;
				if (liveContext === undefined) return null;
				return buildLogicalModelInventory(
					liveContext.modelRegistry,
					liveContext.scopedModels,
				);
			} catch {
				return null;
			}
		};
		const completeLogicalArgumentsSafely = (
			argumentPrefix: string,
		): AutocompleteItem[] | null => {
			const inventory = readLogicalModelInventory();
			return inventory === null
				? null
				: completeLogicalModelArguments(argumentPrefix, inventory);
		};
		const completeMultiAccount = (
			argumentPrefix: string,
		): AutocompleteItem[] | null => {
			const accounts = readCompletionAccounts();
			if (accounts === null) return null;
			const addSlots = readCompletionAddSlots();
			if (addSlots === null) return null;
			const logicalModels = readLogicalModelInventory();
			return completeMultiAccountArguments(argumentPrefix, {
				accounts,
				addSlots,
				groupIds: Object.keys(config.accountGroups ?? {}),
				logicalModels: logicalModels ?? { status: "absent" },
			});
		};

		lifecycle = new MultiAccountLifecycle({
			state,
			usage,
			diagnostics,
			commands,
			continuation,
			watchdog,
			compaction: new CompactionRouter(),
			settleTurn,
			clearStatus: () => warmer.stop(),
			invalidateLogicalTerminalAssociations: () => {
				attributionStore?.cancelActiveAttempts();
				logicalTerminalAssociations.advanceGeneration();
			},
			switchModel,
			completeMultiAccount,
			completeLogicalModel: completeLogicalArgumentsSafely,
		});

		const lastFailure = new Map<string, ProviderFailureSignal>();
		const handledFailures = new WeakSet<object>();
		const observedMessages = new WeakSet<object>();
		const recordUsage = (
			observation: () => UsageObservation | undefined,
		): void => {
			try {
				const projected = observation();
				if (projected) {
					usage.record(projected);
					try {
						logicalRouteIndicator?.usageChanged(projected.providerId);
					} catch {
						// Footer observation cannot alter a successful usage write.
					}
				}
			} catch (error) {
				diagnostics.recordError("usage.observation", error);
			}
		};
		const recordCost = async (
			message: AssistantMessage,
			providerId: string,
		): Promise<boolean> => {
			try {
				return await costRecorder(message, providerId);
			} catch {
				return false;
			}
		};
		const warnCostCloseFailed = (): void => {
			diagnostics.record(
				"warning",
				"cost.period-close",
				"Completed cost periods could not be closed; a later observation or render will retry.",
			);
		};
		const closeCostPeriodsAfterObservation = (observedAtMs: number): void => {
			try {
				void Promise.resolve(
					costPeriodCloser.closeAfterObservation(observedAtMs),
				)
					.then((result) => {
						if (result.status === "failed") warnCostCloseFailed();
					})
					.catch(warnCostCloseFailed);
			} catch {
				warnCostCloseFailed();
			}
		};
		const recordManagedAssistant = async (
			message: AssistantMessage,
			providerId: string,
			subscriptionFamily?: AllowedFamily,
		): Promise<ManagedAssistantRecordOutcome> => {
			try {
				if (subscriptionFamily !== undefined) {
					recordUsage(() => ({
						providerId,
						family: subscriptionFamily,
						observedAtMs: Date.now(),
						tokens: tokenUsage(message),
					}));
				}
				if (!(await recordCost(message, providerId))) {
					diagnostics.record(
						"warning",
						"cost.observation",
						"Retained response cost could not be recorded; the period digest will report incomplete coverage.",
						{ providerId },
					);
					return { status: "failed" };
				}
				closeCostPeriodsAfterObservation(message.timestamp);
				return { status: "retained" };
			} catch {
				return { status: "failed" };
			}
		};
		// One unhandled rejection from an extension handler kills the HOST process,
		// not just the extension -- and every Pi session on this machine loads this
		// build, so a single unguarded throw takes down the whole fleet at once.
		//
		// `lifecycle.ts` already funnels its own handlers through `#isolated`. The
		// handlers registered directly here had no such guard: `session_start` ran
		// readConfig, createCodexCaptureFromHost, and `await rediscover()` before
		// reaching any try/catch, so a malformed config file or an unexpected host
		// shape escaped into the host's event dispatch.
		//
		// The value is not the paths already reasoned about -- it is the faults not
		// predicted. Guarding at registration means a handler added later is covered
		// by construction rather than by remembering.
		//
		// `message_end` is deliberately NOT wrapped: it returns a replacement
		// message, which is the only history-shaping power the public API offers,
		// and a void-returning guard would silently discard it.
		const guarded =
			<TEvent, TContext>(
				category: string,
				handler: (event: TEvent, context: TContext) => void | Promise<void>,
			) =>
			async (event: TEvent, handlerContext: TContext): Promise<void> => {
				try {
					await handler(event, handlerContext);
				} catch (error) {
					diagnostics.recordError(category, error);
				}
			};
		// `before_agent_start` cannot cancel a prompt: Pi ignores handler errors,
		// and `ctx.abort()` is a no-op while the agent is still idle. The input
		// event's `handled` result is the public fail-closed boundary that stops
		// excluded group providers and unsafe metered requests before dispatch.
		pi.on("input", async (_event, inputContext) => {
			try {
				const groupResult = await guardAccountGroupInput(inputContext);
				if (groupResult.action === "handled") return groupResult;
			} catch (error) {
				diagnostics.recordError("routing.account-group-input", error);
				if (accountGroupScopeRestrictsRouting()) {
					inputContext.ui.notify(
						"Multi-account blocked a turn because account-group preflight failed.",
						"warning",
					);
					return { action: "handled" as const };
				}
			}
			try {
				return await guardOpenRouterInput(inputContext);
			} catch (error) {
				diagnostics.recordError("routing.openrouter-input", error);
				const ownsActiveOpenRouter =
					(inputContext.model?.provider === OPENROUTER_PROVIDER_ID ||
						currentModel?.provider === OPENROUTER_PROVIDER_ID) &&
					openRouterBridge !== undefined;
				if (ownsActiveOpenRouter) {
					inputContext.ui.notify(
						"Multi-account blocked an OpenRouter turn because its safety preflight failed. Run /multi-account status for recovery details.",
						"warning",
					);
					return { action: "handled" as const };
				}
				return { action: "continue" as const };
			}
		});
		// Custom extension messages can start an agent run without passing through
		// the input event. Agent start is already inside the run, so abort is live;
		// enforce group membership there and require an input-approved reservation
		// before any bridge-owned OpenRouter run.
		pi.on("agent_start", async (_event, runContext) => {
			const activeProviderId =
				runContext.model?.provider ?? currentModel?.provider;
			if (
				activeProviderId !== undefined &&
				!providerAllowedByActiveGroup(activeProviderId, runContext)
			) {
				openRouterInputApproved = false;
				diagnostics.record(
					"warning",
					"routing.account-group-run-aborted",
					"A custom-message run selected a provider outside the active account group and was aborted before provider dispatch.",
					{ providerId: activeProviderId },
				);
				runContext.ui.notify(
					"Multi-account aborted a provider run outside the active account group.",
					"warning",
				);
				runContext.abort();
				return;
			}
			const ownsActiveOpenRouter =
				(runContext.model?.provider === OPENROUTER_PROVIDER_ID ||
					currentModel?.provider === OPENROUTER_PROVIDER_ID) &&
				openRouterBridge !== undefined;
			if (!ownsActiveOpenRouter) {
				openRouterInputApproved = false;
				return;
			}
			if (openRouterInputApproved) {
				openRouterInputApproved = false;
				return;
			}
			diagnostics.record(
				"warning",
				"routing.openrouter-run-aborted",
				"An OpenRouter agent run had no input-approved budget reservation and was aborted before provider dispatch.",
			);
			runContext.ui.notify(
				"Multi-account aborted an unreserved OpenRouter run. Run /multi-account status for recovery details.",
				"warning",
			);
			runContext.abort();
		});
		pi.on(
			"session_start",
			guarded("lifecycle.session-start", async (_event, startupContext) => {
				context = startupContext;
				try {
					logicalRouteIndicator?.shutdown();
				} catch {
					// Reload disposal is observational and must remain fail-soft.
				}
				// A delegate-owned in-process worker/clone shares the foreground
				// TUI; giving it a footer indicator would overwrite the real
				// foreground `unified` widget. Leave it undefined so every
				// downstream `logicalRouteIndicator?.` call and the attribution
				// decoration below no-op for the worker.
				logicalRouteIndicator = delegateOwnedSession
					? undefined
					: createLogicalRouteIndicator({
					publish: (text) => {
						if (!startupContext.hasUI) return;
						if (text === undefined) {
							try {
								startupContext.ui.setWidget(
									LOGICAL_ROUTE_WIDGET_KEY,
									undefined,
									{ placement: "belowEditor" },
								);
							} catch {
								// UI widget is optional and cannot fail session startup.
							}
							return;
						}
						try {
							if (startupContext.mode === "tui") {
								startupContext.ui.setWidget(
									LOGICAL_ROUTE_WIDGET_KEY,
									() => rightAlignedWidget(text),
									{ placement: "belowEditor" },
								);
							} else {
								startupContext.ui.setWidget(
									LOGICAL_ROUTE_WIDGET_KEY,
									[text],
									{ placement: "belowEditor" },
								);
							}
						} catch {
							try {
								startupContext.ui.setWidget(
									LOGICAL_ROUTE_WIDGET_KEY,
									[text],
									{ placement: "belowEditor" },
								);
							} catch {
								// UI widget is optional and cannot fail session startup.
							}
						}
					},
					usage: (providerId, nowMs) => usage.quotaDisplay(providerId, nowMs),
					configuredLabel: (providerId) => config.accountLabels[providerId],
					now: Date.now,
				});
				currentModel = startupContext.model;
				config = readConfig(configPath);
				// Resolve and durably cache the session policy before rediscovery can
				// publish any request-capable provider surface.
				accountGroupResolutionInitialized = false;
				accountGroupScopeBlocked = false;
				effectiveAccountGroupResolution = undefined;
				initializeSessionAccountGroupScope(startupContext);
				const codex = createCodexCaptureFromHost(
					startupContext,
					maintainedCodexStream,
				);
				codexCaptured = codex.capture;
				codexEnabled = codex.enabled;
				if (forcedCredentialRefresher === undefined) {
					forcedCredentialRefresher = createHostForcedCredentialRefresher({
						modelRegistry: startupContext.modelRegistry,
						oauthByFamily: {
							anthropic: anthropicCaptured.config.oauth,
							...(codexEnabled
								? { "openai-codex": codexCaptured.oauth }
								: {}),
						},
						diagnostics,
					});
					if (forcedCredentialRefresher === undefined) {
						diagnostics.record(
							"warning",
							"credential.force-refresh-unavailable",
							"This Pi build exposes no locked credential modification capability; explicit 401s will use normal invalidation and routing.",
						);
					}
				}
				// A coexisting standalone pi-anthropic-oauth extension registers the
				// base provider from its own factory, and a later registration's
				// defined fields win. Re-assert the derived base configuration now that
				// every factory has run, so adaptive base requests survive both
				// coexistence load orders. rediscover() then awaits the single
				// local-only availability refresh that publishes the route surface.
				try {
					reassertAnthropicBaseRegistration(pi, anthropicCaptured);
				} catch (error) {
					// Alias discovery must still run: a failed re-assertion only means the
					// base provider may keep a coexisting legacy handler.
					diagnostics.recordError("anthropic.base-reassert", error);
				}
				await rediscover();

				// Switch the unified logical provider on for this session.
				//
				// Ordering is load-bearing at both ends. It must follow
				// `rediscover()`, which awaits the single local-only availability
				// refresh that publishes the route surface, and it must precede
				// `restoreManagedAliasModel` below, whose `findModel` can only
				// reinstate a logical selection that is already registered.
				//
				// The declaration is machine-global; the interface implementing it is
				// per session. A matched or mismatched declaration enables routing from
				// the freshly projected live catalogs. Mismatch is persisted-file drift,
				// not authority to reuse stale rows. Absent or unreadable declarations
				// keep the logical provider off without writing models.json at startup.
				try {
					const installed = readInstalledDeclaration(declarationPath);
					const liveCatalogs = readDeclarationCatalogs();
					// Every live catalog family the logical bridge can route to must be
					// checked here: an id present in exactly one family resolves to that
					// family's vendor, and this was never extended when google-antigravity
					// registration landed, so no antigravity model id could resolve a
					// vendor and every unified dispatch of one failed closed with "no
					// managed account serves the exact model id" (logical-provider.ts).
					const modelVendor = (
						modelId: string,
					): "anthropic" | "openai" | "google" | undefined => {
						const anthropic = liveCatalogs.anthropic.some((model) => model.id === modelId);
						const openai = liveCatalogs["openai-codex"].some(
							(model) => model.id === modelId,
						);
						const google = (liveCatalogs["google-antigravity"] ?? []).some(
							(model) => model.id === modelId,
						);
						const matches = [anthropic, openai, google].filter(Boolean).length;
						if (matches !== 1) return undefined;
						return anthropic ? "anthropic" : openai ? "openai" : "google";
					};
					const { status } = registerLogicalProviderAtMatchedStartup({
						pi,
						installed,
						liveCatalogs,
						registerLogicalApi,
						attributionStoreFactory: () => {
							const store = createAttributionStore({
								onResponse: (route, response) => {
									// Bind the bounded response fact to THIS exact attempt by
									// returning it; the attribution store delivers it through the
									// terminal association. Never key it by physical provider, or a
									// concurrent or stale attempt on the same provider would consume
									// it. The physical (non-logical) path keeps its own lastFailure.
									const responseFact = failureSignal({
										status: response.status,
										headers: response.headers,
									});
									if (
										route.providerType !== "subscription" ||
										!isAllowedFamily(route.family)
									) {
										return responseFact;
									}
									const family = route.family;
									const observedAtMs = Date.now();
									recordUsage(() => {
										const rateLimit = rateLimitObservation(response.headers, observedAtMs);
										return rateLimit
											? {
													providerId: route.providerId,
													family,
													observedAtMs,
													rateLimit,
												}
											: undefined;
									});
									return responseFact;
								},
								onAssociation: (route, message, outcome, failure, response) => {
									logicalTerminalAssociations.associate(
										route,
										message,
										outcome,
										failure,
										response,
									);
								},
								onTerminal: (route, message) => {
									const subscriptionFamily =
										route.providerType === "subscription" &&
										isAllowedFamily(route.family)
											? route.family
											: undefined;
									return recordManagedAssistant(
										message,
										route.providerId,
										subscriptionFamily,
									);
								},
								onDiagnostic: () => {
									diagnostics.record(
										"warning",
										"logical.attribution",
										"Logical attribution rejected invalid input or ignored a callback failure.",
									);
								},
								onSettle: logicalTerminalAssociations.advanceGeneration,
								onShutdownComplete: () => {
									logicalTerminalAssociations.advanceGeneration();
									const ownedStore = store;
									if (attributionStore === ownedStore) attributionStore = undefined;
								},
							});
							attributionStore = store;
							const indicator = logicalRouteIndicator;
							return indicator === undefined
								? store
								: decorateLogicalAttributionLifecycle(store, indicator);
						},
						deps: {
							// A getter, not an array. `clear`, `disable`, expiry and
							// provider-reported exhaustion must take effect on the next
							// request, not at the next restart.
							get accounts() {
								const nowMs = Date.now();
								return logicalAccountsFromManaged(
									physicalAccountsForRouting(nowMs),
									nowMs,
								);
							},
							dispatch: createLogicalDispatch(context.modelRegistry),
							onPublicTerminal: logicalTerminalAssociations.bindPublicTerminal,
							state,
							routePin: {
								get: () => state.getLogicalRoutePin(),
								consume: (generation, requestedModelId) =>
									state.consumeLogicalRoutePin(generation, requestedModelId),
								clear: () => state.clearLogicalRoutePin(),
							},
							modelVendor,
							get tierModelMap() {
								return config.tierModelMap;
							},
							...(config.crossFamilyChainEnabled
								? { crossFamilyChains: config.crossFamilyChains }
								: {}),
							onDiagnostic: (message: string) => {
								diagnostics.record("info", "logical.provider", message);
							},
						},
					});
					logicalRoutingState = Object.freeze({
						status,
						capturedAtMs: Date.now(),
					});
					const declarationNotice = declarationNoticeForStatus(
						logicalRoutingState.status,
					);
					if (logicalRoutingState.status === "matched") {
						declarationNoticeMarker.clear();
						diagnostics.record(
							"info",
							"logical.registered",
							"The managed declaration matched the live catalogs; logical routing is enabled for this session.",
						);
					} else if (logicalRoutingState.status === "mismatched") {
						if (
							declarationNotice !== undefined &&
							declarationNoticeMarker.shouldNotify(declarationNotice.condition)
						) {
							startupContext.ui.notify(
								declarationNoticeMessage(declarationNotice),
								"warning",
							);
						}
						diagnostics.record(
							"warning",
							"logical.declaration-stale",
							"The managed declaration is stale; logical routing is enabled using the live catalog. Run /multi-account models update to re-sync it.",
						);
					} else {
						if (
							declarationNotice !== undefined &&
							declarationNoticeMarker.shouldNotify(declarationNotice.condition)
						) {
							startupContext.ui.notify(
								declarationNoticeMessage(declarationNotice),
								"warning",
							);
						}
						if (status !== "absent") {
							// `absent` remains silent. Unreadable state is reported and left alone;
							// reconciliation is always an operator action.
							diagnostics.record(
								"warning",
								"logical.declaration-unusable",
								`The managed declaration is ${status}; logical routing stays off. Run /multi-account models update to reconcile it.`,
							);
						}
					}
				} catch (error) {
					// Fail soft. The physical aliases are already registered and serving;
					// a fault in the logical gate must not take them down with it.
					diagnostics.recordError("logical.registration", error);
				}
				void Promise.resolve()
					.then(() =>
						warmer.start(
							() =>
								projectAutomaticAccountCandidates(
									discovery,
									config.accountLimit,
								),
							config,
						),
					)
					.catch((error) => {
						diagnostics.recordError("credential.warmer.start", error);
					});
				// Pi restores the session model inside createAgentSession, strictly
				// BEFORE extensions load, so a managed alias does not exist yet and the
				// host falls back to a base provider. Now that the aliases are
				// registered, reinstate the operator's persisted alias selection.
				try {
					const outcome = await restoreManagedAliasModel({
						session: startupContext.sessionManager,
						currentProviderId: currentModel?.provider,
						// Bound to the live validated limit so a persisted above-limit
						// provider identity is excluded before host model lookup or
						// setModel(); the restore path and predicate cannot drift apart.
						isManagedProvider: (providerId) =>
							isRestorableManagedProvider(providerId, config.accountLimit),
						logicalProviderId: LOGICAL_PROVIDER_ID,
						isManagedPhysicalSelection: ({ provider, modelId }) => {
							const matchingSlots = (discovery?.slots ?? []).filter(
								(slot) =>
									slot.providerId === provider &&
									isProviderSlotWithinAccountLimit(slot, config.accountLimit),
							);
							return (
								matchingSlots.length === 1 &&
								providerModels(startupContext, provider).some(
									(candidate) => candidate.id === modelId,
								)
							);
						},
						findModels: ({ provider, modelId }) =>
							provider === LOGICAL_PROVIDER_ID &&
							logicalRoutingState?.status !== "matched" &&
							logicalRoutingState?.status !== "mismatched"
								? []
								: providerModels(startupContext, provider).filter(
										(candidate) => candidate.id === modelId,
									),
						findModel: ({ provider, modelId }) =>
							provider === LOGICAL_PROVIDER_ID &&
							logicalRoutingState?.status !== "matched" &&
							logicalRoutingState?.status !== "mismatched"
								? undefined
								: providerModels(startupContext, provider).find(
										(candidate) => candidate.id === modelId,
									),
						setModel,
					});
					diagnostics.record(
						"info",
						"session.restore",
						"Managed alias session restore evaluated.",
						{ outcome },
					);
				} catch (error) {
					diagnostics.recordError("session.restore", error);
				}
				try {
					logicalRouteIndicator?.modelSelected(currentModel?.provider);
				} catch {
					// The footer cannot fail session restore.
				}
			}),
		);
		pi.on(
			"before_agent_start",
			guarded(
				"lifecycle.before-agent-start",
				async (_event, upcomingContext) => {
					// The warmer and usage fetcher each project independently, so
					// removing one call-site guard cannot expose the sibling sink.
					void Promise.resolve()
						.then(() =>
							warmer.runCycle(
								projectAutomaticAccountCandidates(
									discovery,
									config.accountLimit,
								),
								config,
							),
						)
						.catch(() => undefined);
					void usageFetcher
						.fetchAccounts(
							projectAutomaticAccountCandidates(
								discovery,
								config.accountLimit,
							),
							config,
						)
						.catch((error) => {
							diagnostics.recordError("usage.fetch", error);
						});
					const activeProviderId =
						upcomingContext.model?.provider ?? currentModel?.provider;
					const activeFamily = activeProviderId
						? managedFamily(activeProviderId)
						: undefined;
					if (!activeProviderId || !activeFamily || !discovery) return;

					try {
						const accounts = subscriptionOperatorAccounts(
							context ?? upcomingContext,
						);
						const nowMs = Date.now();
						const managedAccounts: SubscriptionManagedAccount[] = accounts.map(
							({
								providerId,
								family,
								credential,
								accountFingerprint,
								modelIds,
							}) => {
								// Same peer-only defect as the routing projection, and
								// the same fix: preflight must see this session's own
								// observation too (#97).
								const fleetUsage = sharedUsageHint(
									usage.routingUsage(providerId, family, nowMs),
									usage.activeExhaustionHoldUntilMs(
										providerId,
										family,
										nowMs,
									),
								);
								return {
									providerId,
									family,
									...(credential === undefined ? {} : { credential }),
									...(accountFingerprint === undefined
										? {}
										: { accountFingerprint }),
									...(modelIds === undefined ? {} : { modelIds }),
									...(fleetUsage === undefined ? {} : { fleetUsage }),
								};
							},
						);
						const candidates = managedAccounts.map((account) => ({
							providerId: account.providerId,
							family: account.family,
							expiresAtMs: account.credential?.expiresAtMs,
							hasRefreshToken: account.credential?.hasRefreshToken ?? false,
							available:
								state.getInvalidation(account.providerId) === undefined &&
								state.getCooldown(account.providerId, nowMs) === undefined,
						}));
						const registry = (upcomingContext.modelRegistry ??
							context?.modelRegistry) as unknown as {
							getProviderAuth?: (providerId: string) => unknown;
						};
						const getProviderAuth = registry?.getProviderAuth;
						const probe: LivenessProbe | undefined =
							typeof getProviderAuth === "function"
								? async (providerId) => {
										const resolved = await getProviderAuth.call(
											registry,
											providerId,
										);
										return resolved !== undefined && resolved !== null;
									}
								: undefined;
						const liveProviders = new Map<string, boolean | undefined>();
						if (probe !== undefined) {
							await Promise.all(
								managedAccounts.map(async (account) => {
									try {
										liveProviders.set(
											account.providerId,
											(await probe(account.providerId)) === true,
										);
										return undefined;
									} catch {
										liveProviders.set(account.providerId, undefined);
										return undefined;
									}
								}),
							);
						}
						const modelId = upcomingContext.model?.id ?? currentModel?.id;
						const healthDecision = selectHealthAwareAccount({
							activeProviderId,
							...(modelId === undefined ? {} : { modelId }),
							accounts: managedAccounts,
							state,
							nowMs,
							modelSupport,
							...(probe === undefined ? {} : { liveProviders }),
						});
						const preflightProviderId = healthDecision.providerId;
						const decision = await selectPreflightAccount({
							activeProviderId: preflightProviderId,
							candidates,
							config,
							nowMs,
							probe,
							diagnostics,
						});

						let destinationProviderId = decision.providerId;
						let reactiveCandidate: AvailableRouteCandidate | undefined;
						if (decision.invalidateActive) {
							const activeAccount = managedAccounts.find(
								(account) => account.providerId === preflightProviderId,
							);
							if (!activeAccount) return;
							const reactive = routeAfterFailure({
								failedAccount: activeAccount,
								accounts: physicalAccountsForRouting(nowMs),
								failure: { code: "oauth_refresh_rejected" },
								originFamily: activeAccount.family,
								...(modelId === undefined ? {} : { requestedModelId: modelId }),
								state,
								config,
								nowMs,
							});
							if (reactive.status === "paused") return;
							reactiveCandidate = reactive;
							destinationProviderId = reactive.destination.providerId;
						}

						if (destinationProviderId === activeProviderId) return;
						const destination = (
							reactiveCandidate === undefined
								? accounts
								: physicalOperatorAccounts(context ?? upcomingContext)
						).find((account) => account.providerId === destinationProviderId);
						if (!destination) return;
						const model =
							reactiveCandidate === undefined
								? isRoutingEligibleAccountFamily(destination)
									? destinationModel(
											destination,
											context ?? upcomingContext,
											modelId,
											activeFamily,
											config.preferredModels,
										)
									: undefined
								: routeCandidateModel(
										reactiveCandidate,
										destination,
										context ?? upcomingContext,
										modelId,
										activeFamily,
										config.preferredModels,
									);
						const selected = model !== undefined && (await setModel(model));
						if (!selected) {
							diagnostics.record(
								"warning",
								"preflight.selection",
								"Pre-flight model selection was not applied; continuing reactively.",
								{ providerId: destinationProviderId },
							);
						} else if (reactiveCandidate !== undefined) {
							recordAutomaticDestination(
								{
									providerId: activeProviderId,
									family: activeFamily,
									...(modelId === undefined
										? {}
										: { requestedModelId: modelId }),
									logical: false,
								},
								reactiveCandidate.destination.providerId,
							);
						}
					} catch {
						diagnostics.record(
							"warning",
							"preflight.failure",
							"Pre-flight routing failed safely; continuing with the active account.",
							{ providerId: activeProviderId },
						);
					}
				},
			),
		);
		pi.on(
			"model_select",
			guarded("lifecycle.model-select", (event) => {
				currentModel = event.model;
				try {
					logicalRouteIndicator?.modelSelected(event.model.provider);
				} catch {
					// Model selection remains authoritative when the footer fails.
				}
				if (event.model.provider !== OPENROUTER_PROVIDER_ID) {
					openRouterBridge = undefined;
				}
			}),
		);
		pi.on(
			"after_provider_response",
			guarded("lifecycle.after-provider-response", (event, responseContext) => {
				const providerId = responseContext.model?.provider;
				if (!providerId) return;
				const responseSlot = discovery?.slots.find(
					(slot) => slot.providerId === providerId,
				);
				if (
					responseSlot === undefined ||
					!isProviderSlotWithinAccountLimit(responseSlot, config.accountLimit)
				) {
					return;
				}
				// Capture only bounded status/header facts before the subscription usage
				// boundary. They can influence routing only if message_end later accepts
				// this exact provider as the host-identified expected destination.
				lastFailure.set(providerId, failureSignal(event));
				if (!isRoutingEligibleAccountFamily(responseSlot)) return;
				const family = responseSlot.family;
				const observedAtMs = Date.now();
				recordUsage(() => {
					const rateLimit = rateLimitObservation(event.headers, observedAtMs);
					return rateLimit
						? { providerId, family, observedAtMs, rateLimit }
						: undefined;
				});
			}),
		);
		// Observation and classification only. Every switch, park, or resume waits
		// for `agent_settled`; see `settleTurn` above.
		pi.on("message_end", async (event, messageContext) => {
			const originalMessage = event.message;
			let assistant = false;
			try {
				assistant = isAssistantMessage(originalMessage);
			} catch {
				return;
			}
			let acceptedLogicalTerminal = false;
			if (assistant) {
				let logicalHistoryResult:
					| { readonly status: "accepted"; readonly cleaned: true }
					| { readonly status: "not-found"; readonly cleaned: false }
					| undefined;
				try {
					logicalHistoryResult = await attributionStore?.messageEnd(originalMessage as AssistantMessage);
				} catch {
					diagnostics.record(
						"warning",
						"logical.attribution",
						"Logical terminal attribution failed safely.",
					);
				}
				acceptedLogicalTerminal = logicalHistoryResult?.status === "accepted";
			}
			if (messageContext.model?.provider === LOGICAL_PROVIDER_ID) {
				// All identity-keyed reads and cleanup use the ORIGINAL terminal object.
				// Later handlers receive only the replacement, so none can finish this work.
				const logicalAssociation = assistant
					? logicalTerminalAssociations.consume(originalMessage as AssistantMessage)
					: undefined;
				const logicalModelId = messageContext.model.id;
				let failed = false;
				let validTerminal = false;
				try {
					const candidate = originalMessage as unknown as Record<string, unknown>;
					const usage = candidate["usage"] as Record<string, unknown> | undefined;
					const cost = usage?.["cost"] as Record<string, unknown> | undefined;
					validTerminal =
						assistant &&
						acceptedLogicalTerminal &&
						boundedPhysicalIdentity(logicalModelId) &&
						(isSuccessfulAssistant(originalMessage) ||
							isFailedAssistant(originalMessage) ||
							isAbortedAssistant(originalMessage)) &&
						Array.isArray(candidate["content"]) &&
						usage !== undefined &&
						cost !== undefined &&
						["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
							(field) => Number.isFinite(usage[field]),
						) &&
						["input", "output", "cacheRead", "cacheWrite", "total"].every(
							(field) => Number.isFinite(cost[field]),
						);
				} catch {
					logicalTerminalAssociations.complete(logicalAssociation, false);
					return;
				}
				if (!validTerminal) {
					logicalTerminalAssociations.complete(logicalAssociation, false);
					return;
				}

				// Physical classification uses only the exact original-object association.
				// Missing, stale, ambiguous, or mismatched identity keeps accounting and the
				// final unified stamp, but cannot mutate routing or schedule continuation.
				let acceptedLogicalAssociation = false;
				try {
					if (logicalAssociation !== undefined) {
						const route = logicalAssociation.route;
					const matchingSlots = (discovery?.slots ?? []).filter(
						(slot) =>
							slot.providerId === route.providerId &&
							slot.family === route.family &&
							isProviderSlotWithinAccountLimit(slot, config.accountLimit) &&
							providerTypeFor(
								slot.family,
								slot.credentialType ?? "unknown",
							) === route.providerType,
					);
					// Public stopReason validates shape, never the attempt-bound outcome.
					const expectedOutcome = logicalAssociation.outcome;
					const dispatchedModelId = logicalAssociation.dispatchedModelId;
					if (matchingSlots.length === 1) {
						failed = expectedOutcome === "fail";
						const providerId = route.providerId;
						if (logicalTerminalRetiresPendingFailure(expectedOutcome)) {
							if (expectedOutcome === "finish") {
								state.markAuthenticationSuccess(providerId);
							}
							pendingFailure = undefined;
							clearTurnRouteOrigin();
							acceptedLogicalAssociation = true;
						} else if (
							!handledFailures.has(originalMessage) &&
							boundedPhysicalIdentity(dispatchedModelId)
						) {
							handledFailures.add(originalMessage);
							const originFamily: AllowedFamily =
								route.family === "openai" ? "openai-codex" : route.family;
							turnRouteOrigin = preserveTurnRouteOrigin(turnRouteOrigin, {
								providerId,
								family: originFamily,
								requestedModelId: logicalModelId,
								logical: true,
							});
							// Bound to the EXACT terminal via its association, never fetched
							// by physical provider id from the shared lastFailure map.
							const responseFailure = logicalAssociation.response ?? {};
							const associatedFailure = logicalAssociation.failure ?? {};
							const failure: ProviderFailureSignal = {
								...associatedFailure,
								...responseFailure,
								modelId: dispatchedModelId,
							};
							let quotaFailedAtMs: number | undefined;
							if (classifyFailure(failure).category === "quota-rate-limit") {
								const failedAtMs = Date.now();
								quotaFailedAtMs = failedAtMs;
								state.recordLimitError(providerId, failedAtMs);
								// The provider refused this request for quota reasons. Hold
								// the account out of routing for a bounded period, so the
								// exhaustion outlives the five-minute usage TTL.
								// Only the subscription families have shared usage state.
								// An owning-vendor `openai` API-key account is billed per
								// request rather than pooled, so it has no fleet-wide
								// exhaustion to record.
								if (
									isAllowedFamily(route.family) &&
									refusalWithoutRecoveryTime(failure)
								) {
									usage.recordExhaustionHold(
										providerId,
										route.family,
										failedAtMs,
									);
								}
							}
							pendingFailure = {
								providerId,
								family: route.family,
								failure,
								alreadyCooled: logicalAssociation.alreadyCooled,
								...(quotaFailedAtMs === undefined
									? {}
									: { failedAtMs: quotaFailedAtMs }),
							};
							acceptedLogicalAssociation = true;
						}
					}
					}
				} finally {
					if (acceptedLogicalAssociation && logicalAssociation !== undefined) {
						latestLogicalPhysicalProviderId = logicalAssociation.route.providerId;
					}
					logicalTerminalAssociations.complete(
						logicalAssociation,
						acceptedLogicalAssociation,
					);
				}

				try {
					const validOriginalMessage = originalMessage as AssistantMessage;
					const repaired = failed
						? withoutUnansweredToolCalls(validOriginalMessage)
						: undefined;
					if (repaired !== undefined) {
						diagnostics.record(
							"info",
							"history.repaired",
							"Removed an unanswered tool call from a failed unified assistant message before retaining it.",
						);
					}
					const finalMessage = repaired ?? validOriginalMessage;
					const stampedMessage = cloneEnumerableMessageFields(finalMessage);
					Object.defineProperties(stampedMessage, {
						provider: {
							value: LOGICAL_PROVIDER_ID,
							writable: true,
							enumerable: true,
							configurable: true,
						},
						model: {
							value: logicalModelId,
							writable: true,
							enumerable: true,
							configurable: true,
						},
						api: {
							value: LOGICAL_PROVIDER_ID,
							writable: true,
							enumerable: true,
							configurable: true,
						},
					});
					return { message: stampedMessage as unknown as AssistantMessage };
				} catch {
					return;
				}
			}
			const identity = physicalMessageIdentity(event.message, messageContext);
			if (identity === undefined) return;
			const { providerId, modelId } = identity;
			if (providerId === OPENROUTER_PROVIDER_ID) {
				if (
					isAssistantMessage(event.message) &&
					!observedMessages.has(event.message)
				) {
					observedMessages.add(event.message);
					const assistantMessage = event.message as AssistantMessage;
					if (!(await recordCost(assistantMessage, "openrouter-metered"))) {
						diagnostics.record(
							"warning",
							"cost.observation",
							"Actual metered OpenRouter response cost could not be retained; the period digest will report incomplete coverage.",
							{ providerId: OPENROUTER_PROVIDER_ID },
						);
					} else {
						closeCostPeriodsAfterObservation(assistantMessage.timestamp);
					}
				}
				if (
					openRouterBridge !== undefined &&
					isFailedAssistant(event.message) &&
					!handledFailures.has(event.message)
				) {
					handledFailures.add(event.message);
					openRouterSessionDisabled = true;
					pendingOpenRouterFailure = true;
					const repaired = withoutUnansweredToolCalls(event.message);
					return repaired === undefined ? undefined : { message: repaired };
				}
				return;
			}

			// The host provider is authoritative. Resolve its live discovered slot so
			// Anthropic OAuth and api_key credentials are distinguished without reading
			// any caller-supplied terminal field.
			const messageSlot = discovery?.slots.find(
				(slot) => slot.providerId === providerId,
			);
			if (
				messageSlot === undefined ||
				!isProviderSlotWithinAccountLimit(messageSlot, config.accountLimit)
			) {
				return;
			}
			const subscriptionFamily = isRoutingEligibleAccountFamily(messageSlot)
				? messageSlot.family
				: undefined;
			if (
				isAssistantMessage(event.message) &&
				!observedMessages.has(event.message)
			) {
				observedMessages.add(event.message);
				await recordManagedAssistant(
					event.message as AssistantMessage,
					providerId,
					subscriptionFamily,
				);
			}

			const existingOrigin = turnRouteOrigin;
			const isExpectedAutomaticDestination =
				existingOrigin?.expectedAutomaticProviderId === providerId;
			// A manually selected owning-vendor account may retain cost, but it cannot
			// manufacture cooldown, invalidation, origin, fallback, continuation, or
			// history-repair effects.
			if (subscriptionFamily === undefined && !isExpectedAutomaticDestination) {
				lastFailure.delete(providerId);
				return;
			}
			if (isSuccessfulAssistant(event.message)) {
				state.markAuthenticationSuccess(providerId);
				lastFailure.delete(providerId);
				if (pendingFailure?.providerId === providerId) pendingFailure = undefined;
				if (
					existingOrigin !== undefined &&
					(providerId === existingOrigin.providerId ||
						isExpectedAutomaticDestination)
				) {
					clearTurnRouteOrigin();
				}
				return;
			}
			if (isAbortedAssistant(event.message)) {
				lastFailure.delete(providerId);
				if (pendingFailure?.providerId === providerId) pendingFailure = undefined;
				clearTurnRouteOrigin();
				return;
			}
			if (!isFailedAssistant(event.message)) return;
			if (handledFailures.has(event.message)) return;

			const firstSubscriptionOrigin =
				subscriptionFamily === undefined
					? undefined
					: {
							providerId,
							family: subscriptionFamily,
							requestedModelId: modelId,
							logical: false,
						};
			const origin = preserveTurnRouteOrigin(
				existingOrigin,
				firstSubscriptionOrigin,
			);
			if (
				origin === undefined ||
				(subscriptionFamily !== undefined &&
					providerId !== origin.providerId &&
					providerId !== origin.expectedAutomaticProviderId)
			) {
				return;
			}
			turnRouteOrigin = origin;
			handledFailures.add(event.message);
			const responseFailure = lastFailure.get(providerId) ?? {};
			const messageCode = providerErrorCodeFromMessage(
				event.message.errorMessage,
			);
			const failure: ProviderFailureSignal = {
				...responseFailure,
				...(messageCode === undefined ? {} : { code: messageCode }),
				modelId,
			};
			lastFailure.delete(providerId);
			let quotaFailedAtMs: number | undefined;
			if (classifyFailure(failure).category === "quota-rate-limit") {
				const failedAtMs = Date.now();
				quotaFailedAtMs = failedAtMs;
				state.recordLimitError(providerId, failedAtMs);
				// Same hold as the logical path above. Both classification sites
				// install it: a reader that knows about holds in one path and not
				// the other is the class of defect that produced #97.
				// Subscription families only; see the logical path above.
				if (
					isAllowedFamily(messageSlot.family) &&
					refusalWithoutRecoveryTime(failure)
				) {
					usage.recordExhaustionHold(
						providerId,
						messageSlot.family,
						failedAtMs,
					);
				}
			}
			pendingFailure = {
				providerId,
				family: messageSlot.family,
				failure,
				...(quotaFailedAtMs === undefined
					? {}
					: { failedAtMs: quotaFailedAtMs }),
			};

			// Sanitise the failed message BEFORE it is finalised into history, so a
			// resumed turn cannot ship an unanswered tool call to another account.
			const repaired = withoutUnansweredToolCalls(event.message);
			if (repaired) {
				diagnostics.record(
					"info",
					"history.repaired",
					"Removed an unanswered tool call from a failed assistant message so a resumed turn stays valid for any destination account.",
					{ providerId },
				);
				return { message: repaired };
			}
			return undefined;
		});
		// REQ-STATUS-TOOL. The operator has fifteen slash subcommands; an agent had
		// none, so diagnosing the 2026-08-05 outage meant hand-parsing usage.ndjson.
		// Registered via registerTool rather than as another subcommand, because the
		// gap being closed is precisely that agents cannot reach slash commands.
		try {
			pi.registerTool({
				name: "multi_account_status",
				label: "Multi-account status",
				description:
					"Report managed-account utilization, retained cost intelligence, " +
					"reading sources, recovery times, and model support.",
				promptSnippet:
					"multi_account_status - per-account utilization, cost intelligence, " +
					"recovery times, diagnostic log, window limits, and model support",
				// READ-ONLY subcommands only. `switch`, `stop`, `reset`, `enable`,
				// `disable`, `add`, `remove`, `clear`, `next`, `rediscover`, and
				// `reload`, and every `group` action stay operator-only slash commands:
				// policy decision, and an agent doing it silently is a policy action
				// wearing a diagnostic's clothes.
				parameters: Type.Object({
					command: Type.Optional(
						Type.Union(
							[
								Type.Literal("status"),
								Type.Literal("log"),
								Type.Literal("limits"),
								Type.Literal("models"),
								Type.Literal("cost"),
							],
							{
								description:
									"status (default) reports every account as JSON. log returns " +
									"recent routing decisions and provider failures -- read this " +
									"first when a failover did not happen. limits reports window " +
									"utilization and reset times. models reports per-account model " +
									"support. cost reports month-to-date project value and completed periods.",
							},
						),
					),
					lines: Type.Optional(
						Type.Number({
							description:
								"For command=log: how many recent entries to return. " +
								"Defaults to the same count as the slash command.",
						}),
					),
					period: Type.Optional(
						Type.Union(
							[
								Type.Literal("day"),
								Type.Literal("week"),
								Type.Literal("month"),
								Type.Literal("quarter"),
								Type.Literal("half-year"),
								Type.Literal("year"),
							],
							{ description: "For command=cost: calendar series to report." },
						),
					),
				}),
				execute: async (
					_toolCallId: string,
					params: {
						readonly command?: string;
						readonly lines?: number;
						readonly period?: string;
					},
				) => {
					const requested = params?.command ?? "status";
					if (!READ_ONLY_AGENT_TOOL_COMMANDS.has(requested)) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Unsupported read-only multi-account status command.",
								},
							],
							details: undefined,
						};
					}
					// `status` keeps returning the operator's `status --json` bytes; the
					// others route through the SAME controller entry point the slash
					// commands use. Assembling a second view here is how the agent and
					// operator surfaces drift apart -- the defect class already fixed
					// twice in the usage snapshot path.
					if (requested === "status") {
						return {
							content: [{ type: "text" as const, text: commands.statusJson() }],
							details: undefined,
						};
					}
					const lineCount =
						requested === "log" &&
						typeof params.lines === "number" &&
						Number.isFinite(params.lines)
							? ` ${Math.trunc(params.lines)}`
							: "";
					const period =
						requested === "cost" && typeof params.period === "string"
							? ` ${params.period}`
							: "";
					const output = await commands.execute(
						`${requested}${lineCount}${period}`,
					);
					return {
						content: [{ type: "text" as const, text: output }],
						details: undefined,
					};
				},
			});
		} catch (error) {
			// A host without registerTool must not break the extension: every other
			// capability here works without it.
			diagnostics.recordError("tool.register-status", error);
		}

		const resolverOwner = publishRouteResolverForSession({
			resolve: (input) => {
				const nowMs = Date.now();
				const resolutionContext: ExactModelRouteResolutionContext = {
					// The v1 resolver's catalog input is the FULL discovered catalog
					// (including disabled providers, so a disabled subscription still
					// resolves to no-eligible-routes rather than unknown-model),
					// subscription-narrowed by family so the owning-vendor-api `openai`
					// family never makes an overlapping id (e.g. gpt-5.6-sol)
					// ambiguous. This narrows by family only; it does NOT drop
					// disabled providers, unlike subscriptionOperatorAccounts.
					catalogAccounts: operatorAccounts(
						context,
						discovery,
						authPath,
						config.accountLimit,
					).filter(
						(account): account is OperatorAccount & SubscriptionManagedAccount =>
							isRoutingEligibleAccountFamily(account),
					),
					accounts: subscriptionAccountsForRouting(nowMs),
					state,
					config,
					modelSupport,
					nowMs,
				};
				return resolveExactModelRoutes(input, resolutionContext);
			},
		});
		// Revoke the resolver's live target on shutdown, before Pi invalidates the
		// extension context. Registered first so it runs ahead of the lifecycle's
		// longer asynchronous shutdown work; a composition failure after
		// publication rolls the owner back synchronously and rethrows the original
		// loading error, since Pi discards loading handlers without emitting
		// `session_shutdown`.
		try {
			pi.on("session_shutdown", () => {
				try {
					logicalRouteIndicator?.shutdown();
				} catch {
					// Footer cleanup cannot block session teardown.
				}
				resolverOwner.dispose();
			});
			lifecycle.register(pi);
		} catch (error) {
			try {
				resolverOwner.dispose();
			} catch {
				// dispose() is specified non-throwing; ignore so the original
				// composition error stays authoritative.
			}
			throw error;
		}

		return undefined;
	};

const extension = createMultiAccountExtension();
export default extension;
