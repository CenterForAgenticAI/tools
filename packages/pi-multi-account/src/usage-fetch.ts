import { createHash } from "node:crypto";
import type { AllowedFamily, MultiAccountConfig } from "./config.js";
import type { CredentialType } from "./discovery.js";
import {
	acquireMachineLease,
	type MachineLeaseHandle,
} from "./machine-lease.js";
import {
	normalizeUsageEndpointPercent,
	type SharedUsageAttemptRecord,
	type SharedUsageStore,
	type UsageFailureDetail,
} from "./shared-usage.js";
import type { UsageLedger } from "./usage.js";
import { isCanonicalManagedProviderId } from "./runtime-state.js";
import { loadUpstreamAntigravityPrimitives } from "./upstream-antigravity.js";
import {
	markWindowUnusable,
	remainingFractionFromUtilization,
	writeHistoryWindowSample,
	type WindowHistoryWriteOptions,
	type WindowSample,
} from "./window-history.js";

export const USAGE_FETCH_INTERVAL_MS = 5 * 60_000;
export const WINDOW_SAMPLE_INTERVAL_MS = 15 * 60_000;

/**
 * Sentinel window id marking a stretch of time the fetcher could not cover, so
 * an unmeasured period is distinguishable from a genuinely idle one. Without it,
 * "no data" and "no usage" render identically and a cost report claims $0.00 for
 * a window it never saw.
 *
 * INTERNAL. Operator surfaces must suppress it: it names nothing an operator can
 * act on, and the double underscores read as broken markup.
 */
export const GAP_WINDOW_ID = "__gap__";
export const USAGE_FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_ERROR_CHARS = 512;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const BACKOFF_LADDER_STEPS =
	Math.ceil(Math.log2(MAX_BACKOFF_MS / BASE_BACKOFF_MS)) + 1;
/** Disable only after the capped rung has failed once more. */
export const USAGE_FETCH_DISABLE_AFTER_FAILURES = BACKOFF_LADDER_STEPS + 1;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ALLOWED_USAGE_URLS = new Set([CODEX_USAGE_URL, ANTHROPIC_USAGE_URL]);

const MAX_ANTIGRAVITY_PROJECT_ID_BYTES = 4_096;
const MAX_ANTIGRAVITY_WINDOWS = 64;
/**
 * Hard bound on projection work for one quota path. Entries beyond the scan cap
 * are ignored; real fork responses contain only tens of models.
 */
const MAX_ANTIGRAVITY_SCANNED_ENTRIES = 4_096;
const MAX_ANTIGRAVITY_WINDOW_ID_CHARS = 128;
const ANTIGRAVITY_PROJECT_DIGEST_PREFIX = "antigravity-project-";
const ANTIGRAVITY_PROJECT_DIGEST_PATTERN = new RegExp(
	`^${ANTIGRAVITY_PROJECT_DIGEST_PREFIX}[0-9a-f]{24}$`,
);

/**
 * Projects a raw Google Cloud project id (from `pi-antigravity`'s decoded
 * `AccountUsage.projectId`) into the only representation that may reach a
 * status view, diagnostic, usage record, cost record, or history sample. The
 * digest mirrors `project-identity.ts#deriveProjectKey`'s established shape
 * (sha256, hex, truncated, tagged prefix) so this repository has one bounded,
 * non-identifying digest convention rather than two.
 */
export function deriveAntigravityProjectDigest(
	rawProjectId: unknown,
): string | undefined {
	if (typeof rawProjectId !== "string" || rawProjectId.length === 0) {
		return undefined;
	}
	if (Buffer.byteLength(rawProjectId, "utf8") > MAX_ANTIGRAVITY_PROJECT_ID_BYTES) {
		return undefined;
	}
	const digest = createHash("sha256").update(rawProjectId, "utf8").digest("hex");
	return `${ANTIGRAVITY_PROJECT_DIGEST_PREFIX}${digest.slice(0, 24)}`;
}

export function isAntigravityProjectDigest(value: string): boolean {
	return ANTIGRAVITY_PROJECT_DIGEST_PATTERN.test(value);
}

export interface UsageFetchAccount {
	readonly providerId: string;
	readonly family: AllowedFamily;
	/**
	 * Discovered credential type. An `api_key` account yields the unmeasured
	 * `not-supported` outcome before any OAuth usage call (#24). Optional so
	 * existing call sites and fixtures stay valid; absent is treated as the
	 * established OAuth path.
	 */
	readonly credentialType?: CredentialType;
}

export interface UsageFetchStatus {
	readonly enabled: boolean;
	readonly disabled: boolean;
	readonly failureCount: number;
	readonly nextAttemptAtMs?: number;
	readonly disabledReason?:
		| "rate-limit"
		| "server-error"
		| "credential-unavailable"
		| "malformed-response"
		| "network-error";
}

export type UsageFetchResultStatus =
	| "fetched"
	| "disabled"
	| "backoff"
	| "not-due"
	| "lease-unavailable"
	| "disabled-by-config"
	| "credential-unavailable"
	| "failed"
	/**
	 * The account's credential type has no supported usage endpoint (an
	 * `api_key` account, #24). Unmeasured, not a failure: no OAuth call is made,
	 * the failure ladder does not advance, and the account is not disabled.
	 */
	| "not-supported";

export interface UsageFetchResult {
	readonly providerId: string;
	readonly status: UsageFetchResultStatus;
	readonly utilization?: number;
	readonly capturedAtMs?: number;
}

interface UsageFetchResponse {
	readonly status: number;
	readonly headers: {
		get(name: string): string | null;
	};
	text(): Promise<string>;
}

export type UsageFetchImplementation = (
	input: string,
	init: RequestInit,
) => Promise<UsageFetchResponse>;

export interface UsageWindowReading {
	readonly windowId: string;
	readonly utilization?: number;
	readonly remainingFraction?: number;
	readonly resetAtMs?: number;
	readonly resetEpoch?: number;
	readonly usable: boolean;
}

type UsageReading = {
	readonly utilization: number;
	readonly recoveryAtMs?: number;
	readonly windows: readonly UsageWindowReading[];
	/** Present only for a family whose usage endpoint names a scoped project. */
	readonly projectDigest?: string;
};

function sanitizeFailureDetail(value: unknown): UsageFailureDetail | undefined {
	switch (value) {
		case "not-object":
		case "no-quota-groups":
		case "quota-summary-error":
			return value;
		default:
			return undefined;
	}
}

class UsageEndpointError extends Error {
	readonly status: number | undefined;
	readonly retryAfterMs: number | undefined;
	readonly kind: UsageFetchStatus["disabledReason"];
	readonly detail: UsageFailureDetail | undefined;

	constructor(
		message: string,
		kind: UsageFetchStatus["disabledReason"],
		status?: number,
		retryAfterMs?: number,
		detail?: string,
	) {
		super(message);
		this.name = "UsageEndpointError";
		this.kind = kind;
		this.status = status;
		this.retryAfterMs = retryAfterMs;
		this.detail = sanitizeFailureDetail(detail);
	}
}

function responseHeader(
	response: UsageFetchResponse,
	name: string,
): string | undefined {
	try {
		const value = response.headers.get(name);
		return value === null ? undefined : value;
	} catch {
		return undefined;
	}
}

function retryAfterMs(response: UsageFetchResponse): number | undefined {
	const value = responseHeader(response, "retry-after");
	if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
		return undefined;
	}
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(MAX_BACKOFF_MS, Math.max(0, Math.ceil(seconds * 1_000)));
}

/** Redacts bearer and access-token values before an error can escape this module. */
export function redactErrorBody(body: string): string {
	const redacted = body
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(/("?access_token"?\s*[:=]\s*["']?)[^,\s"'}]+/gi, "$1<redacted>")
		.trim();
	return redacted.length <= MAX_ERROR_CHARS
		? redacted
		: `${redacted.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asResetMs(value: unknown): number | undefined {
	const number = asNumber(value);
	if (number !== undefined && number >= 0) {
		return number < 100_000_000_000 ? number * 1_000 : number;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

function readingFromWindow(
	value: unknown,
	windowId: string,
): UsageWindowReading | undefined {
	const window = asObject(value);
	if (!window) return undefined;
	const percent =
		asNumber(window.used_percent) ??
		asNumber(window.used_percentage) ??
		asNumber(window.usedPercent) ??
		asNumber(window.utilization);
	const utilization =
		percent === undefined ? undefined : normalizeUsageEndpointPercent(percent);
	const resetAtMs =
		asResetMs(window.reset_at) ??
		asResetMs(window.resetAt) ??
		asResetMs(window.resets_at) ??
		asResetMs(window.resetsAt);
	const remainingFraction =
		utilization === undefined
			? undefined
			: remainingFractionFromUtilization(utilization);
	return {
		windowId,
		...(utilization === undefined ? {} : { utilization }),
		...(remainingFraction === undefined ? {} : { remainingFraction }),
		...(resetAtMs === undefined ? {} : { resetAtMs, resetEpoch: resetAtMs }),
		usable:
			utilization !== undefined &&
			remainingFraction !== undefined &&
			resetAtMs !== undefined,
	};
}

function windowEntries(
	container: Record<string, unknown> | undefined,
	knownIds: readonly string[],
): UsageWindowReading[] {
	if (!container) return [];
	const entries = new Map<string, UsageWindowReading>();
	for (const key of knownIds) {
		const reading = readingFromWindow(container[key], key);
		if (reading) entries.set(key, reading);
	}
	for (const [key, value] of Object.entries(container)) {
		if (entries.has(key)) continue;
		const object = asObject(value);
		if (
			!object ||
			![
				"used_percent",
				"used_percentage",
				"usedPercent",
				"utilization",
				"reset_at",
				"resetAt",
				"resets_at",
				"resetsAt",
			].some((field) => field in object)
		) {
			continue;
		}
		const reading = readingFromWindow(object, key);
		if (reading) entries.set(key, reading);
	}
	return [...entries.values()];
}

function primaryReading(
	windows: readonly UsageWindowReading[],
): UsageReading | undefined {
	const usable = windows.find((window) => window.utilization !== undefined);
	if (!usable || usable.utilization === undefined) return undefined;
	// `recoveryAtMs` means "this account is out and recovers at T", and
	// `snapshotIndicatesExhaustion` treats any future `recoveryAtMs` as
	// exhaustion. A window's `resetAtMs` is its ROUTINE reset time and is present
	// whether or not the window has capacity, so carrying it unconditionally
	// marked a healthy account (e.g. Codex primary_window at 17% used, weekly
	// reset ~6 days out) exhausted and demoted `unified` to the owning-vendor API
	// tier until that reset (#72). Only an actually-spent window contributes a
	// recovery time; a window with capacity to spare recovers nothing.
	const exhausted = usable.utilization >= 1 || usable.remainingFraction === 0;
	return {
		utilization: usable.utilization,
		...(exhausted && usable.resetAtMs !== undefined
			? { recoveryAtMs: usable.resetAtMs }
			: {}),
		windows,
	};
}

/**
 * One quota row from `pi-antigravity`'s decoded `AccountUsage`. The upstream
 * shape is intentionally treated as unknown here (the pinned package owns
 * usage decoding; this repository owns projection), so every field is
 * defensively narrowed the same way `readingFromWindow` narrows the
 * Codex/Anthropic raw JSON above -- never guessed, never passed through.
 */
function antigravityQuotaReading(
	value: unknown,
	idField: "bucketId" | "modelId",
): UsageWindowReading | undefined {
	const quota = asObject(value);
	if (!quota) return undefined;
	const rawId = quota[idField];
	const windowId =
		typeof rawId === "string" &&
		rawId.length > 0 &&
		rawId.length <= MAX_ANTIGRAVITY_WINDOW_ID_CHARS
			? rawId
			: undefined;
	if (windowId === undefined) return undefined;
	const rawRemaining = asNumber(quota.remainingFraction);
	const utilization =
		rawRemaining === undefined
			? undefined
			: Math.max(0, Math.min(1, 1 - rawRemaining));
	const remainingFraction =
		utilization === undefined ? undefined : remainingFractionFromUtilization(utilization);
	const resetAtMs = asResetMs(quota.resetTime);
	return {
		windowId,
		...(utilization === undefined ? {} : { utilization }),
		...(remainingFraction === undefined ? {} : { remainingFraction }),
		...(resetAtMs === undefined ? {} : { resetAtMs, resetEpoch: resetAtMs }),
		usable:
			utilization !== undefined &&
			remainingFraction !== undefined &&
			resetAtMs !== undefined,
	};
}

function boundedMostConstrainedAntigravityWindows(
	values: Iterable<unknown>,
	idField: "bucketId" | "modelId",
): UsageWindowReading[] {
	const candidates: UsageWindowReading[] = [];
	const seenWindowIds = new Set<string>();
	let scannedEntries = 0;
	for (const value of values) {
		if (scannedEntries >= MAX_ANTIGRAVITY_SCANNED_ENTRIES) break;
		scannedEntries += 1;
		const reading = antigravityQuotaReading(value, idField);
		if (reading === undefined || seenWindowIds.has(reading.windowId)) continue;
		seenWindowIds.add(reading.windowId);
		candidates.push(reading);
	}
	// Stable sort preserves the first-seen input order when utilization ties.
	return candidates
		.sort((left, right) => {
			const leftUtilization = left.utilization ?? Number.NEGATIVE_INFINITY;
			const rightUtilization = right.utilization ?? Number.NEGATIVE_INFINITY;
			return leftUtilization === rightUtilization
				? 0
				: rightUtilization - leftUtilization;
		})
		.slice(0, MAX_ANTIGRAVITY_WINDOWS);
}

/**
 * Group containers count toward the same scan budget as the buckets they hold,
 * so an oversized response of empty groups cannot bypass the entry cap.
 */
function* antigravityGroupBuckets(groups: readonly unknown[]): Iterable<unknown> {
	let visited = 0;
	for (const group of groups) {
		if (++visited > MAX_ANTIGRAVITY_SCANNED_ENTRIES) return;
		const groupRecord = asObject(group);
		const buckets =
			groupRecord && Array.isArray(groupRecord.buckets) ? groupRecord.buckets : [];
		for (const bucket of buckets) {
			if (++visited > MAX_ANTIGRAVITY_SCANNED_ENTRIES) return;
			yield bucket;
		}
	}
}

/**
 * Projects the decoded `AccountUsage` result into exactly the named, bounded
 * facts this repository retains: a small set of group- or model-quota windows
 * and a digest of the account-scoped project id. Every other upstream field
 * (plan labels, display names, tier names, raw endpoint, raw project id) is
 * dropped here, at the seam, before any status, diagnostic, usage, cost, or
 * history surface can see it.
 */
export function projectAntigravityUsage(
	raw: unknown,
): { windows: UsageWindowReading[]; projectDigest?: string } | undefined {
	const usage = asObject(raw);
	if (!usage) return undefined;
	const projectDigest = deriveAntigravityProjectDigest(usage.projectId);
	const groups = Array.isArray(usage.groups) ? usage.groups : [];
	const boundedWindows = boundedMostConstrainedAntigravityWindows(
		antigravityGroupBuckets(groups),
		"bucketId",
	);
	if (!boundedWindows.some((window) => window.usable)) {
		const models = Array.isArray(usage.models) ? usage.models : [];
		const boundedModelWindows = boundedMostConstrainedAntigravityWindows(
			models,
			"modelId",
		);
		if (boundedModelWindows.length > 0) {
			return {
				windows: boundedModelWindows,
				...(projectDigest === undefined ? {} : { projectDigest }),
			};
		}
	}
	return {
		windows: boundedWindows,
		...(projectDigest === undefined ? {} : { projectDigest }),
	};
}

/**
 * Injectable Antigravity usage transport; defaults to the reviewed upstream
 * primitive. The optional `signal` is forwarded to the fork's
 * `fetchAccountUsage`, which propagates it into every one of its three
 * internal legs (`loadCodeAssist`, quota summary, available-models catalog)
 * and drains every settlement via `Promise.allSettled` before rejecting on
 * abort -- see `pi-antigravity`'s `src/usage/usage.ts`. Aborting this signal
 * is therefore the only way this repository can actually cancel the real
 * upstream call rather than merely giving up on waiting for it.
 */
export type AntigravityUsageFetchImplementation = (
	apiKey: string,
	options?: { readonly signal?: AbortSignal },
) => Promise<unknown>;

async function defaultFetchAntigravityUsage(
	apiKey: string,
	options?: { readonly signal?: AbortSignal },
): Promise<unknown> {
	if (process.env.VITEST === "true") {
		throw new UsageEndpointError(
			"network access is disabled in tests",
			"network-error",
		);
	}
	const primitives = await loadUpstreamAntigravityPrimitives();
	return primitives.fetchUsage(
		apiKey,
		options?.signal === undefined ? {} : { signal: options.signal },
	);
}

function parsePayload(text: string): Record<string, unknown> {
	if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
		throw new UsageEndpointError(
			"usage endpoint response exceeded the bounded response size",
			"malformed-response",
		);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new UsageEndpointError(
			"usage endpoint response was not valid JSON",
			"malformed-response",
		);
	}
	const object = asObject(payload);
	if (!object) {
		throw new UsageEndpointError(
			"usage endpoint response was not an object",
			"malformed-response",
		);
	}
	return object;
}

export function normalizeCodexUsagePayload(
	payload: Record<string, unknown>,
): UsageReading {
	const rateLimit = asObject(payload.rate_limit);
	const windows = windowEntries(rateLimit, [
		"primary_window",
		"secondary_window",
	]);
	const topLevelWindows = windowEntries(payload, [
		"primary_window",
		"secondary_window",
	]);
	const byId = new Map(windows.map((window) => [window.windowId, window]));
	for (const window of topLevelWindows) {
		if (!byId.has(window.windowId)) byId.set(window.windowId, window);
	}
	const reading = primaryReading([...byId.values()]);
	if (reading) return reading;
	throw new UsageEndpointError(
		"Codex usage endpoint returned no bounded rate-limit window",
		"malformed-response",
	);
}

export function normalizeAnthropicUsagePayload(
	payload: Record<string, unknown>,
): UsageReading {
	const windows = windowEntries(payload, [
		"five_hour",
		"fiveHour",
		"primary",
		"weekly",
		"seven_day",
		"sevenDay",
		"seven_day_opus",
	]);
	const reading = primaryReading(windows);
	if (reading) return reading;
	throw new UsageEndpointError(
		"Anthropic usage endpoint returned no bounded rate-limit window",
		"malformed-response",
	);
}

async function fetchWithTimeout(
	fetchImpl: UsageFetchImplementation,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<UsageFetchResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new UsageEndpointError(
				`usage endpoint timed out after ${Math.round(timeoutMs / 1_000)}s`,
				"network-error",
			);
		}
		throw new UsageEndpointError(
			redactErrorBody(error instanceof Error ? error.message : String(error)),
			"network-error",
		);
	} finally {
		clearTimeout(timeout);
	}
}

async function queryEndpoint(
	account: UsageFetchAccount,
	access: string,
	fetchImpl: UsageFetchImplementation,
	timeoutMs: number,
): Promise<UsageReading> {
	const headers: Record<string, string> =
		account.family === "openai-codex"
			? { Authorization: `Bearer ${access}` }
			: {
					Authorization: `Bearer ${access}`,
					"anthropic-beta": "oauth-2025-04-20",
				};
	const url =
		account.family === "openai-codex" ? CODEX_USAGE_URL : ANTHROPIC_USAGE_URL;
	const response = await fetchWithTimeout(
		fetchImpl,
		url,
		{ headers },
		timeoutMs,
	);
	if (response.status < 200 || response.status >= 300) {
		const body = await response.text().catch(() => "");
		const retryMs = retryAfterMs(response);
		throw new UsageEndpointError(
			`usage endpoint returned ${response.status}: ${redactErrorBody(body)}`,
			response.status === 429
				? "rate-limit"
				: response.status >= 500
					? "server-error"
					: "network-error",
			response.status,
			retryMs,
		);
	}
	const payload = parsePayload(await response.text());
	return account.family === "openai-codex"
		? normalizeCodexUsagePayload(payload)
		: normalizeAnthropicUsagePayload(payload);
}

function statusFromAttempt(
	attempt: SharedUsageAttemptRecord | undefined,
	enabled: boolean,
): UsageFetchStatus {
	const nextAttemptAtMs =
		attempt?.failureCount === 0 ? undefined : attempt?.nextAttemptAtMs;
	const disabledReason =
		attempt?.failureReason as UsageFetchStatus["disabledReason"];
	return {
		enabled,
		disabled: attempt?.disabled ?? false,
		failureCount: attempt?.failureCount ?? 0,
		...(nextAttemptAtMs === undefined ? {} : { nextAttemptAtMs }),
		...(disabledReason === undefined ? {} : { disabledReason }),
	};
}

function failureReason(
	error: UsageEndpointError,
): NonNullable<UsageFetchStatus["disabledReason"]> {
	return error.kind ?? "network-error";
}

/**
 * Lets an Antigravity attempt's bounded per-attempt deadline hand the
 * already-acquired machine lease off to a background drain instead of the
 * caller releasing it immediately, when the real upstream call is still
 * outstanding at that deadline. `handedOff` starts `false`; the caller's own
 * `finally { if (!leaseGuard.handedOff) lease.release(); }` is a no-op once
 * it flips `true`, so ownership only ever moves one direction and is never
 * released twice.
 */
interface AntigravityLeaseGuard {
	readonly lease: MachineLeaseHandle;
	handedOff: boolean;
}

/** Detached, lease-coordinated authoritative usage fetcher. */
export class UsageFetcher {
	readonly #lockPath: string;
	readonly #usage: UsageLedger;
	readonly #sharedStore: SharedUsageStore;
	readonly #resolveCredential: (
		providerId: string,
	) => Promise<string | undefined>;
	readonly #fetchImpl: UsageFetchImplementation;
	readonly #fetchAntigravityUsage: AntigravityUsageFetchImplementation;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #onUsageRecorded: ((providerId: string) => void) | undefined;
	readonly #windowHistoryOptions: WindowHistoryWriteOptions | undefined;
	readonly #lastWindowFetchAtMs = new Map<string, number>();
	/**
	 * In-flight failure-triggered refreshes, keyed by account.
	 *
	 * Claimed synchronously before the first `await`, so two failures arriving in
	 * the same tick join one refresh instead of racing to the durable checks.
	 * The durable markers cover the cross-process case; this covers our own.
	 */
	readonly #inFlightFailureRefresh = new Map<
		string,
		Promise<UsageFetchResult>
	>();
	/**
	 * One real, in-flight `pi-antigravity` `fetchAccountUsage` call per
	 * canonical account, shared by every `UsageFetcher` instance in this
	 * process.
	 *
	 * `fetchAccountUsage` accepts an `AbortSignal` and propagates it into every
	 * one of its three internal legs, draining every settlement via
	 * `Promise.allSettled` before rejecting on abort. Each entry therefore owns
	 * a dedicated `AbortController`, created once when a genuinely new call
	 * starts, so `#fetchAntigravityUsageWithDeadline` can actually cancel the
	 * real upstream call at its bounded per-attempt deadline instead of merely
	 * giving up on waiting for it. Reusing the pending entry across joiners
	 * means at most one real call -- and one controller -- is outstanding per
	 * account in THIS process; a joiner never gets its own controller, so its
	 * own deadline aborts the SAME shared call other still-pending joiners are
	 * awaiting too. That is deliberate: the call is genuinely one shared
	 * operation, not one per caller.
	 *
	 * The entry is cleared only when the real promise actually settles
	 * (resolves or rejects), never when a caller's per-attempt deadline merely
	 * gives up on it -- a still-pending upstream call must stay reachable so a
	 * later poll can await its eventual result instead of duplicating the
	 * call. A late settlement after every waiting poll already timed out is
	 * simply observed by the cleanup handler and produces no write: nothing
	 * outside that handler still awaits the promise at that point.
	 *
	 * The entry holds only the promise and its controller, never the
	 * credential that started it. It cannot: telling "same account, refreshed
	 * token" apart from "a different account now occupies this slot" would
	 * need retaining the raw credential for comparison, or hashing it into a
	 * fingerprint -- both forbidden by this package's credential-retention
	 * discipline, and no legitimate boundary here yields an opaque, non-secret
	 * generation number to use instead. So a credential change while a call is
	 * pending does not start a second call under the new value; the poll joins
	 * the one already in flight, same as any other still-pending poll. This is
	 * a known, accepted limit, not a claimed guarantee: if an operator
	 * re-logs a slot into a different account while a call for the old one is
	 * still outstanding, that call's eventual result is still attributed to
	 * this slot. Closing it would need the credential-resolution boundary
	 * itself to hand back an opaque per-slot generation alongside the
	 * credential; adding one is outside this file's touches.
	 *
	 * This map is a class-static field: EVERY `UsageFetcher` instance in this
	 * process shares it, so two instances constructed in the same process
	 * cannot each start their own concurrent real call for the same account.
	 * It is still not by itself a machine-wide or fleet-wide guard -- a peer OS
	 * process has its own module state and its own map. The per-attempt
	 * machine lease (`acquireMachineLease`) is the cross-process
	 * serialization, and it now stays held -- renewed at its own
	 * `renewalIntervalMs` -- through this entry's ACTUAL settlement rather
	 * than releasing at the earlier bounded deadline, so a peer process can
	 * never acquire the lease and start a second real call while this
	 * process's real call is still genuinely outstanding. A same-process
	 * concurrent attempt for an account whose lease is still held this way
	 * gets the ordinary `lease-unavailable` busy/skip outcome, the same as any
	 * other lease contention; it never joins a call an earlier deadline already
	 * abandoned.
	 */
	static readonly #inFlightAntigravityRawFetch = new Map<
		string,
		{ readonly promise: Promise<unknown>; readonly controller: AbortController }
	>();
	readonly #lastWindowGapAtMs = new Map<string, number>();

	constructor(options: {
		readonly lockPath: string;
		readonly usage: UsageLedger;
		readonly sharedStore: SharedUsageStore;
		readonly resolveCredential: (
			providerId: string,
		) => Promise<string | undefined>;
		readonly fetchImpl?: UsageFetchImplementation;
		readonly fetchAntigravityUsage?: AntigravityUsageFetchImplementation;
		readonly now?: () => number;
		readonly timeoutMs?: number;
		readonly onUsageRecorded?: (providerId: string) => void;
		readonly windowHistoryOptions?: WindowHistoryWriteOptions;
	}) {
		this.#lockPath = options.lockPath;
		this.#usage = options.usage;
		this.#sharedStore = options.sharedStore;
		this.#resolveCredential = options.resolveCredential;
		this.#fetchImpl =
			options.fetchImpl ??
			((input, init) => {
				if (process.env.VITEST === "true") {
					return Promise.reject(
						new UsageEndpointError(
							"network access is disabled in tests",
							"network-error",
						),
					);
				}
				if (!ALLOWED_USAGE_URLS.has(input)) {
					return Promise.reject(
						new UsageEndpointError(
							"usage endpoint URL was not allowlisted",
							"network-error",
						),
					);
				}
				return globalThis.fetch(input, init);
			});
		this.#fetchAntigravityUsage =
			options.fetchAntigravityUsage ?? defaultFetchAntigravityUsage;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? USAGE_FETCH_TIMEOUT_MS;
		this.#onUsageRecorded = options.onUsageRecorded;
		this.#windowHistoryOptions = options.windowHistoryOptions;
	}

	#notifyUsageRecorded(providerId: string): void {
		try {
			this.#onUsageRecorded?.(providerId);
		} catch {
			// Observation is advisory; callback failure cannot reclassify a fetch.
		}
	}

	status(
		providerId: string,
		family: AllowedFamily,
		config: MultiAccountConfig,
	): UsageFetchStatus {
		const enabled = config.usageFetchEnabled?.[family] ?? true;
		return statusFromAttempt(
			this.#sharedStore.latestAttempt(providerId, family),
			enabled,
		);
	}

	#accountKey(account: UsageFetchAccount): string {
		return `${account.family}:${account.providerId}`;
	}

	async #persistWindowGap(
		account: UsageFetchAccount,
		recordedAtMs: number,
		reason: string,
	): Promise<void> {
		const key = this.#accountKey(account);
		const previous = this.#lastWindowGapAtMs.get(key);
		if (
			previous !== undefined &&
			recordedAtMs - previous < WINDOW_SAMPLE_INTERVAL_MS
		) {
			return;
		}
		const gap = markWindowUnusable({
			providerId: account.providerId,
			accountId: account.providerId,
			family: account.family,
			windowId: GAP_WINDOW_ID,
			recordedAtMs,
			schemaVersion: 1,
			buildProvenance: `node@${process.version}`,
			observerId: `process-${process.pid}`,
			unusableReason: reason,
		});
		if (await writeHistoryWindowSample(gap, this.#windowHistoryOptions)) {
			this.#lastWindowGapAtMs.set(key, recordedAtMs);
		}
	}

	async #persistWindowSamples(
		account: UsageFetchAccount,
		reading: UsageReading,
		recordedAtMs: number,
	): Promise<boolean> {
		let persisted = true;
		for (const window of reading.windows) {
			const baseSample = {
				providerId: account.providerId,
				accountId: account.providerId,
				family: account.family,
				windowId: window.windowId,
				recordedAtMs,
				...(window.resetAtMs === undefined
					? {}
					: { resetAtMs: window.resetAtMs }),
				...(window.resetEpoch === undefined
					? {}
					: { resetEpoch: window.resetEpoch }),
				...(window.remainingFraction === undefined
					? {}
					: { remainingFraction: window.remainingFraction }),
				...(reading.projectDigest === undefined
					? {}
					: { projectDigest: reading.projectDigest }),
			};
			const sample: WindowSample = window.usable
				? {
						...baseSample,
						schemaVersion: 1,
						buildProvenance: `node@${process.version}`,
						observerId: `process-${process.pid}`,
						usable: true,
					}
				: markWindowUnusable({
						...baseSample,
						schemaVersion: 1,
						buildProvenance: `node@${process.version}`,
						observerId: `process-${process.pid}`,
					});
			if (!(await writeHistoryWindowSample(sample, this.#windowHistoryOptions))) {
				persisted = false;
			}
		}
		if (persisted && reading.windows.length > 0) {
			this.#lastWindowFetchAtMs.set(this.#accountKey(account), recordedAtMs);
		}
		return persisted;
	}

	async fetchAccount(
		account: UsageFetchAccount,
		config: MultiAccountConfig,
	): Promise<UsageFetchResult> {
		return this.#fetchAccount(account, config, false);
	}

	/**
	 * Refreshes usage after the provider refused a request for quota reasons.
	 *
	 * Unlike the cadence poll this bypasses the fresh-header guard, because the
	 * header that looked fresh is exactly the reading the 429 just contradicted.
	 * It reuses the existing `bypassHeaderFreshness` parameter rather than
	 * inventing a mechanism: `fetchAccounts` already passes `true` for window
	 * sampling.
	 *
	 * At most one extra poll per failure, in this process or across the fleet.
	 * `failedAtMs` is the failure's own time, not now: a poll that ran after the
	 * failure but before settlement has already answered this failure's question
	 * and must suppress.
	 */
	async refreshAfterFailure(
		account: UsageFetchAccount,
		config: MultiAccountConfig,
		failedAtMs: number,
	): Promise<UsageFetchResult> {
		const key = this.#accountKey(account);
		// Step 2: claim synchronously, before any await, so a second failure in
		// the same tick joins this refresh rather than starting its own.
		const inFlight = this.#inFlightFailureRefresh.get(key);
		if (inFlight !== undefined) return inFlight;
		const pending = this.#refreshAfterFailure(account, config, failedAtMs);
		this.#inFlightFailureRefresh.set(key, pending);
		try {
			return await pending;
		} finally {
			// Release only our own token: a later refresh may already have
			// replaced it, and deleting that one would reopen the window.
			if (this.#inFlightFailureRefresh.get(key) === pending) {
				this.#inFlightFailureRefresh.delete(key);
			}
		}
	}

	/**
	 * Durable suppression checks for a failure-triggered refresh.
	 *
	 * Run twice: once before taking the lease, and again under it. The second
	 * run is not redundant -- a peer can write an attempt between our first read
	 * and our lease acquisition, and without the recheck both processes would
	 * poll the same account for the same failure.
	 *
	 * Each clause suppresses for a different reason, and they must stay
	 * distinguishable:
	 *
	 *  - endpoint backoff: an absolute deadline from a real failure ladder.
	 *    `failureCount > 0` matters because a zero-failure record with a future
	 *    `nextAttemptAtMs` is an ordinary cadence reservation, not a ladder.
	 *  - already answered: any attempt at or after our failure has already asked
	 *    the endpoint the question this failure raises.
	 *  - debounce: a previous failure-triggered refresh set a deadline we are
	 *    still inside.
	 */
	#failureRefreshSuppressedBy(
		attempt: SharedUsageAttemptRecord | undefined,
		failedAtMs: number,
		nowMs: number,
	): "backoff" | "already-answered" | "debounced" | undefined {
		if (attempt === undefined) return undefined;
		// An attempt anchored in the future cannot suppress anything.
		//
		// Round 2 found the first version of this bound was applied only inside
		// the debounce clause, so `already-answered` and `backoff` returned
		// before it ran: an attempt with `observedAtMs` centuries ahead is
		// trivially `>= failedAtMs`, and suppressed every failure refresh
		// forever. The bound belongs here, on the record, before any clause
		// reads it.
		//
		// `nextAttemptAtMs` is allowed one debounce interval of headroom because
		// Only the ORIGIN timestamps are bounded, not `nextAttemptAtMs`: a real
		// failure ladder legitimately schedules its next rung far ahead, up to
		// MAX_BACKOFF_MS, and bounding that would break genuine backoff
		// suppression. An honest record cannot have been OBSERVED in the future.
		if (
			attempt.observedAtMs > nowMs ||
			(attempt.failureTriggeredAtMs !== undefined &&
				attempt.failureTriggeredAtMs > nowMs)
		) {
			return undefined;
		}
		if (attempt.failureCount > 0 && attempt.nextAttemptAtMs > nowMs) {
			return "backoff";
		}
		if (attempt.observedAtMs >= failedAtMs) return "already-answered";
		if (
			attempt.refreshDebounceUntilMs !== undefined &&
			attempt.refreshDebounceUntilMs > nowMs &&
			// Same far-future bypass as the hold: the stored span can be a
			// legitimate five minutes while its origin sits centuries ahead, which
			// would suppress every failure refresh forever. A deadline further
			// than one debounce interval from now cannot be honest.
			attempt.refreshDebounceUntilMs <= nowMs + USAGE_FETCH_INTERVAL_MS
		) {
			return "debounced";
		}
		return undefined;
	}

	async #refreshAfterFailure(
		account: UsageFetchAccount,
		config: MultiAccountConfig,
		failedAtMs: number,
	): Promise<UsageFetchResult> {
		if (!isCanonicalManagedProviderId(account.providerId, account.family)) {
			return { providerId: account.providerId, status: "failed" };
		}
		// An api_key account has no OAuth usage endpoint; unmeasured, not failed.
		if (account.credentialType === "api_key") {
			return { providerId: account.providerId, status: "not-supported" };
		}
		if (!(config.usageFetchEnabled?.[account.family] ?? true)) {
			return { providerId: account.providerId, status: "disabled-by-config" };
		}

		// Step 4/5: durable checks before the lease.
		const beforeLease = this.#sharedStore.latestAttempt(
			account.providerId,
			account.family,
		);
		if (
			this.#failureRefreshSuppressedBy(
				beforeLease,
				failedAtMs,
				this.#now(),
			) !== undefined
		) {
			return { providerId: account.providerId, status: "not-due" };
		}

		// Step 6: the lease. Failure means another usage operation is running,
		// which is itself a reason to suppress rather than queue behind it.
		const lease = acquireMachineLease({
			lockPath: this.#lockPath,
			ttlMs: Math.max(2_000, this.#timeoutMs + 2_000),
			now: this.#now,
			reclaimMalformed: true,
		});
		if (!lease) {
			return { providerId: account.providerId, status: "lease-unavailable" };
		}
		const leaseGuard: AntigravityLeaseGuard = { lease, handedOff: false };
		try {
			// Step 7: the same checks again, now that nobody else can write.
			const underLease = this.#sharedStore.latestAttempt(
				account.providerId,
				account.family,
			);
			if (
				this.#failureRefreshSuppressedBy(
					underLease,
					failedAtMs,
					this.#now(),
				) !== undefined
			) {
				return { providerId: account.providerId, status: "not-due" };
			}

			// Step 8: persist the marked reservation BEFORE resolving the
			// credential. If the ledger cannot be written, make no endpoint call:
			// an unbounded call with no durable backoff state is how a stampede
			// starts.
			const attemptedAtMs = this.#now();
			const reserved = this.#sharedStore.append({
				recordType: "usage-attempt",
				tokens: null,
				providerId: account.providerId,
				family: account.family,
				observedAtMs: attemptedAtMs,
				observerId: this.#sharedStore.observerId,
				failureCount: underLease?.failureCount ?? 0,
				nextAttemptAtMs: attemptedAtMs + USAGE_FETCH_INTERVAL_MS,
				disabled: underLease?.disabled ?? false,
				...(underLease?.failureReason === undefined
					? {}
					: { failureReason: underLease.failureReason }),
				...(underLease?.failureDetail === undefined
					? {}
					: { failureDetail: underLease.failureDetail }),
				failureTriggeredAtMs: failedAtMs,
				refreshDebounceUntilMs: failedAtMs + USAGE_FETCH_INTERVAL_MS,
			});
			if (!reserved) {
				return { providerId: account.providerId, status: "failed" };
			}

			// Step 9: the ordinary ladder. A failed refresh is not a no-op -- it
			// advances failureCount and can disable the account, exactly as a
			// cadence poll would.
			// `underLease` must be passed: the catch computes the next rung as
			// `prior.failureCount + 1`, so omitting it restarts an existing ladder
			// at 1 and can clear a `disabled` flag. A dead endpoint would then be
			// retried harder after every failure and might never reach the disable
			// threshold.
			return await this.#completeAttempt(
				account,
				attemptedAtMs,
				leaseGuard,
				{
					failureTriggeredAtMs: failedAtMs,
					refreshDebounceUntilMs: failedAtMs + USAGE_FETCH_INTERVAL_MS,
				},
				underLease,
			);
		} finally {
			if (!leaseGuard.handedOff) lease.release();
		}
	}

	async #fetchAccount(
		account: UsageFetchAccount,
		config: MultiAccountConfig,
		bypassHeaderFreshness: boolean,
	): Promise<UsageFetchResult> {
		if (!isCanonicalManagedProviderId(account.providerId, account.family)) {
			return { providerId: account.providerId, status: "failed" };
		}
		// #24: an api_key account has no OAuth usage endpoint. Return an
		// unmeasured outcome BEFORE any config gate, header check, backoff, lease,
		// or network call, so it never accrues a failure, never advances the
		// ladder, and is never disabled. Missing usage stays a coverage gap.
		if (account.credentialType === "api_key") {
			return { providerId: account.providerId, status: "not-supported" };
		}
		if (!(config.usageFetchEnabled?.[account.family] ?? true)) {
			return { providerId: account.providerId, status: "disabled-by-config" };
		}
		const nowMs = this.#now();
		if (
			!bypassHeaderFreshness &&
			this.#usage.hasFreshHeaderObservation(
				account.providerId,
				account.family,
				nowMs,
			)
		) {
			return { providerId: account.providerId, status: "not-due" };
		}
		const prior = this.#sharedStore.latestAttempt(
			account.providerId,
			account.family,
		);
		// Backoff is checked BEFORE `disabled`, deliberately.
		//
		// Every failure writes a correctly-computed `nextAttemptAtMs`, but the
		// disabled gate used to come first and returned unconditionally, so that
		// timestamp was never read once an account had been disabled. `disabled`
		// therefore meant "forever": nothing anywhere sets it false or resets
		// `failureCount`.
		//
		// The consequences invert the intent. The reasons that disable a fetcher --
		// rate-limit above all -- are TRANSIENT, and the poller is the only
		// quota-free way to observe that the account recovered. So a briefly
		// throttled account was cut off permanently from the mechanism that would
		// have shown it was healthy again. Observed live: anthropic-account-2
		// exhausted its ladder on 27 July with `failureReason: "rate-limit"`, and
		// its `nextAttemptAtMs` came due seven days ago while the account sat
		// usable and invisible.
		//
		// Once the recorded backoff has elapsed, the account is retried whether or
		// not it was disabled. A retry that fails again simply re-arms the ladder at
		// its capped rung, so a genuinely dead endpoint is polled at most once per
		// MAX_BACKOFF_MS rather than hammered.
		if (prior !== undefined && prior.nextAttemptAtMs > nowMs) {
			await this.#persistWindowGap(
				account,
				nowMs,
				prior.disabled ? "auto-disabled" : "backoff",
			);
			return {
				providerId: account.providerId,
				status: prior.disabled ? "disabled" : "not-due",
			};
		}
		const lease = acquireMachineLease({
			lockPath: this.#lockPath,
			ttlMs: Math.max(2_000, this.#timeoutMs + 2_000),
			now: this.#now,
			// A wedged usage-fetch.lock would otherwise suppress every poll.
			reclaimMalformed: true,
		});
		if (!lease) {
			await this.#persistWindowGap(account, nowMs, "lease-unavailable");
			return { providerId: account.providerId, status: "lease-unavailable" };
		}
		const leaseGuard: AntigravityLeaseGuard = { lease, handedOff: false };
		try {
			const current = this.#sharedStore.latestAttempt(
				account.providerId,
				account.family,
			);
			// Same ordering as the pre-lease check above: an elapsed backoff wins
			// over a stale `disabled` flag, so a recovered account can be observed
			// again. Re-read under the lease because a peer may have attempted in
			// between.
			if (current !== undefined && current.nextAttemptAtMs > this.#now()) {
				await this.#persistWindowGap(
					account,
					this.#now(),
					current.disabled ? "auto-disabled" : "backoff",
				);
				return {
					providerId: account.providerId,
					status: current.disabled ? "disabled" : "not-due",
				};
			}
			const attemptedAtMs = this.#now();
			const reserved = this.#sharedStore.append({
				recordType: "usage-attempt",
				tokens: null,
				providerId: account.providerId,
				family: account.family,
				observedAtMs: attemptedAtMs,
				observerId: this.#sharedStore.observerId,
				failureCount: current?.failureCount ?? 0,
				nextAttemptAtMs: attemptedAtMs + USAGE_FETCH_INTERVAL_MS,
				disabled: current?.disabled ?? false,
				...(current?.failureReason === undefined
					? {}
					: { failureReason: current.failureReason }),
				...(current?.failureDetail === undefined
					? {}
					: { failureDetail: current.failureDetail }),
			});
			if (!reserved) {
				// The attempt ledger is the fleet-wide stampede barrier. If it
				// cannot be persisted, fail closed rather than making an
				// unbounded endpoint call with no durable backoff state.
				await this.#persistWindowGap(account, attemptedAtMs, "attempt-persistence");
				return { providerId: account.providerId, status: "failed" };
			}
			return await this.#completeAttempt(
				account,
				attemptedAtMs,
				leaseGuard,
				{},
				current,
			);
		} finally {
			if (!leaseGuard.handedOff) lease.release();
		}
	}

	/**
	 * Reuse (or start) the one real, in-flight raw fetch for this account,
	 * shared process-wide. See `#inFlightAntigravityRawFetch` for why this
	 * exists and its exact limits -- in particular, this deliberately never
	 * compares `apiKey` against a stored value: doing so would mean retaining
	 * or fingerprinting the raw credential, which this package's
	 * credential-retention discipline forbids. `apiKey` is used only to start
	 * a genuinely new call -- with a fresh `AbortController` -- when no pending
	 * one exists for this account.
	 */
	#antigravityRawFetch(
		account: UsageFetchAccount,
		apiKey: string,
	): { readonly promise: Promise<unknown>; readonly controller: AbortController } {
		const key = this.#accountKey(account);
		const existing = UsageFetcher.#inFlightAntigravityRawFetch.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const controller = new AbortController();
		const promise = this.#fetchAntigravityUsage(apiKey, {
			signal: controller.signal,
		});
		const entry = { promise, controller };
		UsageFetcher.#inFlightAntigravityRawFetch.set(key, entry);
		const clearOnSettle = () => {
			// Only clear our own entry: a settlement racing a fresh start (after
			// an earlier settlement already cleared and replaced this one) must
			// not delete the newer entry.
			if (UsageFetcher.#inFlightAntigravityRawFetch.get(key) === entry) {
				UsageFetcher.#inFlightAntigravityRawFetch.delete(key);
			}
		};
		promise.then(clearOnSettle, clearOnSettle);
		return entry;
	}

	/**
	 * Antigravity has no raw-HTTP usage endpoint of its own: the reviewed
	 * `pi-antigravity` primitive makes several internal calls and resolves one
	 * decoded `AccountUsage` object. This wraps that call with the same bounded
	 * per-attempt deadline every other family's usage fetch gets, then projects
	 * the result through `projectAntigravityUsage` before anything is recorded.
	 */
	async #queryAntigravityUsage(
		account: UsageFetchAccount,
		apiKey: string,
		leaseGuard: AntigravityLeaseGuard,
	): Promise<UsageReading> {
		let raw: unknown;
		try {
			raw = await this.#fetchAntigravityUsageWithDeadline(
				account,
				apiKey,
				leaseGuard,
			);
		} catch (error) {
			if (error instanceof UsageEndpointError) throw error;
			throw new UsageEndpointError(
				redactErrorBody(error instanceof Error ? error.message : String(error)),
				"network-error",
			);
		}
		const projection = projectAntigravityUsage(raw);
		if (projection === undefined) {
			throw new UsageEndpointError(
				"Antigravity usage endpoint response was not a bounded object",
				"malformed-response",
				undefined,
				undefined,
				"not-object",
			);
		}
		const reading = primaryReading(
			projection.windows.filter((window) => window.usable),
		);
		if (reading === undefined) {
			const usage = asObject(raw);
			throw new UsageEndpointError(
				"Antigravity usage endpoint returned no bounded quota bucket",
				"malformed-response",
				undefined,
				undefined,
				typeof usage?.quotaSummaryError === "string"
					? "quota-summary-error"
					: "no-quota-groups",
			);
		}
		return {
			...reading,
			...(projection.projectDigest === undefined
				? {}
				: { projectDigest: projection.projectDigest }),
		};
	}

	/**
	 * Races the shared in-flight raw fetch against this attempt's bounded
	 * deadline. Losing that race calls `entry.controller.abort()`, so the abort
	 * this repository issues is exactly the abort the fork's own three legs
	 * observe -- but this process still awaits that call's OWN settlement, not
	 * merely the deadline, before releasing the machine-shared lease: hitting
	 * the deadline hands lease ownership to `leaseGuard`, which
	 * `#drainAntigravityLease` renews at the lease's own `renewalIntervalMs`
	 * until the real promise actually settles, then releases. The caller's own
	 * `finally { if (!leaseGuard.handedOff) lease.release(); }` becomes a no-op
	 * once handed off, so the lease is never released early. A late settlement
	 * -- success or failure -- reaches only the drain continuation from that
	 * point on: this function has already rejected the deadline's caller, and
	 * nothing here writes usage, cost, or history from that late value.
	 */
	async #fetchAntigravityUsageWithDeadline(
		account: UsageFetchAccount,
		apiKey: string,
		leaseGuard: AntigravityLeaseGuard,
	): Promise<unknown> {
		const entry = this.#antigravityRawFetch(account, apiKey);
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				entry.controller.abort();
				reject(
					new UsageEndpointError(
						`Antigravity usage fetch timed out after ${Math.round(this.#timeoutMs / 1_000)}s`,
						"network-error",
					),
				);
			}, this.#timeoutMs);
		});
		// Attach a no-op rejection handler so a slow transport that rejects AFTER
		// the deadline has already won the race cannot surface as an unhandled
		// rejection; the caller only ever observes whichever settles first.
		// `#antigravityRawFetch` already attached its own settle handler too, so
		// this is belt-and-suspenders, not the only protection.
		entry.promise.catch(() => {});
		try {
			return await Promise.race([entry.promise, deadline]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (timedOut) {
				leaseGuard.handedOff = true;
				this.#drainAntigravityLease(leaseGuard.lease, entry.promise);
			}
		}
	}

	/**
	 * Holds the machine-shared usage lease open until `pending` -- the real,
	 * still-outstanding `fetchAccountUsage` call a bounded deadline already gave
	 * up on -- actually settles. This reuses the lease's existing renewal
	 * mechanism (`renew()` / `renewalIntervalMs`) rather than inventing a
	 * second one: one drain-scoped interval, cleared the moment the real call
	 * is done, not a standing per-agent timer.
	 *
	 * The first renewal happens synchronously, right here, before the interval
	 * is ever scheduled. `setInterval`'s own first tick fires only after a
	 * full `renewalIntervalMs`, and at the production defaults
	 * (`USAGE_FETCH_TIMEOUT_MS=10_000` -> `ttlMs=12_000` ->
	 * `renewalIntervalMs=4_000`) that first tick would land at
	 * deadline+4_000ms -- two full seconds after the lease already expired on
	 * disk at deadline+2_000ms. The lease's own ttl leaves exactly that
	 * `ttlMs - timeoutMs` buffer past the deadline for this handoff to land
	 * one immediate renewal inside, so calling `renew()` now (still inside
	 * that buffer) closes the gap before the interval ever needs to run.
	 *
	 * `renew()`'s boolean result is never discarded: a `false` here or on a
	 * later tick means the lease could not be kept -- already expired, or
	 * reclaimed by a peer -- and this drain has nothing left to renew, so
	 * renewal stops rather than continuing to poll a lease it no longer
	 * safely holds. `pending` is still awaited either way, so a late
	 * settlement never becomes an unhandled rejection, and `lease.release()`
	 * still runs at the end either way: `release()` itself refuses to touch a
	 * record whose token no longer matches the one this handle acquired, so
	 * it can never delete a peer's lease even if renewal was lost earlier.
	 */
	#drainAntigravityLease(
		lease: MachineLeaseHandle,
		pending: Promise<unknown>,
	): void {
		let interval: ReturnType<typeof setInterval> | undefined;
		const stopRenewing = (): void => {
			if (interval !== undefined) {
				clearInterval(interval);
				interval = undefined;
			}
		};
		if (lease.renew()) {
			interval = setInterval(() => {
				if (!lease.renew()) stopRenewing();
			}, lease.renewalIntervalMs);
		}
		void pending
			.catch(() => {
				// A late failure from the abandoned call is observed only to know
				// the lease can now be released -- never written to usage, cost,
				// or history.
			})
			.finally(() => {
				stopRenewing();
				lease.release();
			});
	}

	/**
	 * The shared post-reservation ladder: call the endpoint, record the reading,
	 * and on failure advance failureCount/backoff and possibly disable.
	 *
	 * Extracted so a failure-triggered refresh completes through exactly the same
	 * path as a cadence poll. A second copy would be free to drift, and the one
	 * that drifted would be the one nobody tests.
	 *
	 * `markers` is carried onto both outcome records, so the debounce deadline
	 * survives the attempt completing. Without that a later failure would see an
	 * unmarked record and poll again immediately.
	 */
	async #completeAttempt(
		account: UsageFetchAccount,
		attemptedAtMs: number,
		leaseGuard: AntigravityLeaseGuard,
		markers: {
			readonly failureTriggeredAtMs?: number;
			readonly refreshDebounceUntilMs?: number;
		} = {},
		prior?: SharedUsageAttemptRecord,
	): Promise<UsageFetchResult> {
		try {
			const credential = await this.#resolveCredential(account.providerId);
			if (typeof credential !== "string" || credential.length === 0) {
				throw new UsageEndpointError(
					"credential unavailable",
					"credential-unavailable",
				);
			}
			const reading =
				account.family === "google-antigravity"
					? await this.#queryAntigravityUsage(account, credential, leaseGuard)
					: await queryEndpoint(
							account,
							credential,
							this.#fetchImpl,
							this.#timeoutMs,
						);
			const capturedAtMs = this.#now();
			this.#usage.record({
				providerId: account.providerId,
				family: account.family,
				observedAtMs: capturedAtMs,
				rateLimit: {
					...(reading.recoveryAtMs === undefined
						? {}
						: { recoveryAtMs: reading.recoveryAtMs }),
					utilization: reading.utilization,
					utilizationSource: "usage-endpoint",
				},
			});
			this.#notifyUsageRecorded(account.providerId);
			await this.#persistWindowSamples(account, reading, capturedAtMs);
			this.#sharedStore.append({
				recordType: "usage-attempt",
				tokens: null,
				providerId: account.providerId,
				family: account.family,
				observedAtMs: capturedAtMs,
				observerId: this.#sharedStore.observerId,
				failureCount: 0,
				nextAttemptAtMs: capturedAtMs + USAGE_FETCH_INTERVAL_MS,
				disabled: false,
				...markers,
			});
			return {
				providerId: account.providerId,
				status: "fetched",
				utilization: reading.utilization,
				capturedAtMs,
			};
		} catch (error) {
			const failure =
				error instanceof UsageEndpointError
					? error
					: new UsageEndpointError("usage endpoint failed", "network-error");
			const failureCount = (prior?.failureCount ?? 0) + 1;
			const backoff = Math.min(
				MAX_BACKOFF_MS,
				BASE_BACKOFF_MS * 2 ** Math.max(0, failureCount - 1),
			);
			const disabled = failureCount >= USAGE_FETCH_DISABLE_AFTER_FAILURES;
			this.#sharedStore.append({
				recordType: "usage-attempt",
				tokens: null,
				providerId: account.providerId,
				family: account.family,
				observedAtMs: attemptedAtMs,
				observerId: this.#sharedStore.observerId,
				failureCount,
				nextAttemptAtMs: Math.max(
					attemptedAtMs + USAGE_FETCH_INTERVAL_MS,
					attemptedAtMs + backoff,
					attemptedAtMs + (failure.retryAfterMs ?? 0),
				),
				disabled,
				failureReason: failureReason(failure),
				...(failure.detail === undefined
					? {}
					: { failureDetail: failure.detail }),
				...markers,
			});
			await this.#persistWindowGap(
				account,
				attemptedAtMs,
				disabled ? "auto-disabled" : "backoff",
			);
			return {
				providerId: account.providerId,
				status:
					failure.kind === "credential-unavailable"
						? "credential-unavailable"
						: "failed",
			};
		}
	}

	async fetchAccounts(
		accounts: readonly UsageFetchAccount[],
		config: MultiAccountConfig,
	): Promise<readonly UsageFetchResult[]> {
		const results: UsageFetchResult[] = [];
		for (const account of accounts) {
			const result = await this.fetchAccount(account, config);
			results.push(result);

			// Window cadence is deliberately a call-driven comparison, not a timer.
			// A normal fetch above records its own window sample. When a fresh
			// header suppressed it, this second path bypasses ONLY that header
			// check; #fetchAccount still applies every durable/config/lease/network
			// guard in the same order.
			const last = this.#lastWindowFetchAtMs.get(this.#accountKey(account));
			if (
				last !== undefined &&
				this.#now() - last < WINDOW_SAMPLE_INTERVAL_MS
			) {
				continue;
			}
			// REQ-WINDOW-CADENCE: enforce cross-process 15-minute floor.
			// Check durable attempt record to prevent peer-process fetch within the window.
			const prior = this.#sharedStore.latestAttempt(
				account.providerId,
				account.family,
			);
			if (
				prior !== undefined &&
				this.#now() - prior.observedAtMs < WINDOW_SAMPLE_INTERVAL_MS
			) {
				continue;
			}
			await this.#fetchAccount(account, config, true);
		}
		return results;
	}
}
