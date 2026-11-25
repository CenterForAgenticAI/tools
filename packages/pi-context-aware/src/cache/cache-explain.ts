/**
 * Per-request prompt-cache explanation for the context service (cache capability).
 *
 * Each assistant message on the branch is one provider request with provider-reported
 * usage. This module turns consecutive requests into a hit rate and, when the cache
 * lost much more than the new content explains, a likely cause: a compaction or branch
 * summary rewrote the history, the model changed, a fold rewrote part of it, the cache
 * expired while the session was idle, or the prefix changed for an unrecorded reason.
 *
 * The miss split comes from `decomposeSample` in the fold kernel, so the numbers here
 * and the kernel's cache report use one accounting. The cause is a best guess: the
 * provider does not say why it missed, and an eviction inside the TTL looks the same
 * as a client-side rewrite of the request.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	ContextAwareCacheExplanationV1,
	ContextAwareCacheCauseV1,
	ContextAwareCacheResetKindV1,
	ContextAwareCacheResetV1,
	ContextAwareCacheV1,
} from "../context-service.js";
import { decomposeSample, type CacheSample, type FoldEvent } from "../folds/kernel/cache-report.js";
import { FOLD_ENTRY_TYPE, readFoldRecord } from "../folds/fold-entries.js";
import { measuredSurvival, type CacheProfileV1 } from "./cache-profile.js";

/** Compact per-request evidence, paired with the next assistant message on the branch. */
export const CACHE_VERDICT_ENTRY = "context-aware.cache-verdict.v1";
const CACHE_GUARD_ENTRY = "context-aware.cache-guard.v1";
/** One small cache block of read-token drift. */
export const STALLED_READ_TOLERANCE = 128;

/** The default prompt-cache lifetime. */
export const SHORT_CACHE_TTL_MS = 5 * 60_000;
/** The extended lifetime: Anthropic `cache_control.ttl: "1h"`, chosen by `PI_CACHE_RETENTION=long`. */
export const LONG_CACHE_TTL_MS = 60 * 60_000;
/** A loss smaller than this many tokens is never reported as a reset. */
export const MIN_RESET_TOKENS = 1024;
/** A loss is a reset when it is at least this share of the previous request. */
export const RESET_SHARE = 0.2;
/** A hit below this share of the previous request counts as a miss from the start. */
export const START_SHARE = 0.05;
/** Longest model label a reset carries, before the ellipsis. */
export const MAX_MODEL_CHARS = 80;

export interface CacheExplainOptions {
	/** True when Pi asks providers for extended cache retention (`PI_CACHE_RETENTION=long`). */
	readonly longRetention?: boolean;
	/** The measured survival profile; absent means today's fixed-lifetime answer. */
	readonly profile?: CacheProfileV1;
	/** Whether a `provider/model` row carries `promptCache`. Only a row that does not can be `evicted`. */
	readonly hasPromptCache?: (model: string) => boolean;
}

interface ObservedRequest {
	readonly at: number;
	/**
	 * When the response ended: the session entry's timestamp, or `at` when it is missing or earlier.
	 * The measured profile's idle gap runs from here to the next request's start.
	 */
	readonly end: number;
	readonly sample: CacheSample;
	readonly cacheWrite: number;
	readonly model: string;
	readonly ttlMs: number;
}

interface PendingFold {
	readonly blockId: string;
	readonly event: FoldEvent;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One line of at most {@link MAX_MODEL_CHARS} characters, counted by code point. Control
 * and format characters (bidirectional overrides, zero-width marks) and line or paragraph
 * separators become spaces, so a label cannot break, reorder or hide part of a line.
 */
export function cleanModelLabel(value: string): string {
	const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
	const chars = Array.from(clean);
	return chars.length > MAX_MODEL_CHARS ? chars.slice(0, MAX_MODEL_CHARS - 1).join("") + "…" : clean;
}

function requestOf(message: unknown, options: CacheExplainOptions): ObservedRequest | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const candidate = message as Record<string, unknown>;
	if (candidate.role !== "assistant") return undefined;
	const at = candidate.timestamp;
	if (typeof at !== "number" || !Number.isInteger(at)) return undefined;
	const usage = candidate.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const fields = usage as Record<string, unknown>;
	const input = count(fields.input);
	const cacheRead = count(fields.cacheRead);
	const cacheWrite = count(fields.cacheWrite);
	if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
	// Pi reports `input` without the cached part; the kernel wants the whole prompt.
	const total = input + cacheRead + cacheWrite;
	if (total <= 0) return undefined;
	const longWrite = (count(fields.cacheWrite1h) ?? 0) > 0;
	return {
		at,
		end: at,
		sample: { at, input: total, cached: cacheRead },
		cacheWrite,
		model: cleanModelLabel(`${String(candidate.provider ?? "")}/${String(candidate.model ?? "")}`),
		ttlMs: longWrite || options.longRetention === true ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS,
	};
}

/** True when an assistant message reports the usage cache.explain measures; the guard's baseline follows it. */
export function isObservedRequest(message: unknown): boolean {
	return requestOf(message, {}) !== undefined;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type BlockCause = Extract<ContextAwareCacheCauseV1, { kind: "message-block" }>;

function readGuardCause(value: Record<string, unknown>): ContextAwareCacheCauseV1 | undefined {
	if (value.declined === true) return undefined;
	if (value.kind !== "system-section" && value.kind !== "tools" && value.kind !== "setting") return undefined;
	const names = value.kind === "system-section" ? value.sections : value.names;
	if (!Array.isArray(names)) return undefined;
	if (!names.every((name): name is string => typeof name === "string")) return undefined;
	return Object.freeze({ kind: value.kind, names: Object.freeze(names.slice(0, 32).map(cleanModelLabel)) });
}

function blockPosition(value: Record<string, unknown>): { index: number; count: number } | undefined {
	const index = count(value.index);
	const total = count(value.count);
	if (index === undefined || total === undefined) return undefined;
	if (!Number.isInteger(index) || !Number.isInteger(total)) return undefined;
	if (index > total) return undefined; // A removed last block can have index === count.
	return { index, count: total };
}

function readBlockCause(value: Record<string, unknown>): BlockCause | undefined {
	const position = blockPosition(value);
	if (!position || typeof value.role !== "string" || typeof value.type !== "string") return undefined;
	if (value.tool !== undefined && typeof value.tool !== "string") return undefined;
	return Object.freeze({ kind: "message-block", ...position, role: cleanModelLabel(value.role), type: cleanModelLabel(value.type), ...(value.tool === undefined ? {} : { tool: cleanModelLabel(value.tool) }) });
}

/** Copy only known fields: session data is not a trusted public cause object. */
function readCause(value: unknown, guard: boolean): ContextAwareCacheCauseV1 | undefined {
	if (!object(value)) return undefined;
	if (guard) return readGuardCause(value);
	if (value.kind === "unchanged") return Object.freeze({ kind: "unchanged" });
	return value.kind === "message-block" ? readBlockCause(value) : undefined;
}

function explainRequest(
	previous: ObservedRequest | undefined,
	current: ObservedRequest,
	folds: readonly PendingFold[],
	rewrite: "compaction" | "branch-summary" | undefined,
	cause: ContextAwareCacheCauseV1 | undefined,
	options: CacheExplainOptions,
): ContextAwareCacheExplanationV1 {
	const base = {
		hitPct: Math.round((current.sample.cached / current.sample.input) * 100),
		inputTokens: current.sample.input,
		cachedTokens: current.sample.cached,
	};
	if (!previous) return Object.freeze(base);
	const split = decomposeSample(previous.sample, current.sample, folds.map((fold) => fold.event));
	const lostTokens = split.compRepay + split.ttlRepay;
	if (lostTokens < Math.max(MIN_RESET_TOKENS, RESET_SHARE * previous.sample.input)) return Object.freeze(base);
	const idleMs = Math.max(0, current.at - previous.at);
	const ttlMs = previous.ttlMs;
	const missedFromStart = current.sample.cached < Math.max(MIN_RESET_TOKENS, START_SHARE * previous.sample.input);
	const expired = idleMs > ttlMs;
	// A best-effort cache (no promptCache) that missed from the start inside its measured survival
	// window, with no recorded prefix change, was evicted early rather than expired.
	const unexplained = folds.length === 0 && (!cause || cause.kind === "unchanged");
	// The profile measures the gap from the end of the previous response, not from its start (cache-profile.ts),
	// so a long response must not move the lookup into a later bucket.
	const survivalPct = missedFromStart && unexplained && options.hasPromptCache?.(current.model) === false
		? measuredSurvival(options.profile, current.model, Math.max(0, current.at - previous.end))
		: undefined;
	let kind: ContextAwareCacheResetKindV1;
	let extra: { blockId?: string; model?: string; survivalPct?: number } = {};
	if (rewrite) kind = rewrite;
	else if (previous.model !== current.model) {
		kind = "model-change";
		extra = { model: current.model };
	} else if (survivalPct !== undefined) {
		kind = "evicted";
		extra = { survivalPct };
	} else if (expired && missedFromStart) kind = "expired";
	else if (split.compRepay > 0 && split.foldIndex !== null) {
		kind = "fold";
		extra = { blockId: folds[split.foldIndex]!.blockId };
	} else if (expired) kind = "expired";
	else kind = missedFromStart ? "prefix-start" : "prefix-mid";
	const prefixCause = (kind === "prefix-start" || kind === "prefix-mid") && cause ? { cause } : {};
	const stalled = Math.abs(current.sample.cached - previous.sample.cached) <= STALLED_READ_TOLERANCE && previous.cacheWrite > STALLED_READ_TOLERANCE;
	const reset: ContextAwareCacheResetV1 = Object.freeze({ kind, idleMs, ttlMs, lostTokens, ...extra, ...prefixCause, ...(stalled ? { stalled: true as const } : {}) });
	return Object.freeze({ ...base, reset });
}

/**
 * Explain every assistant request on a branch, keyed by the message timestamp.
 * Requests come in branch order; the first request with a timestamp wins a key.
 * Until a request reports any cache use, nothing is explained: a provider that
 * reports no caching would otherwise read as a reset on every request.
 */
export function explainCacheOnBranch(
	branch: readonly SessionEntry[],
	options: CacheExplainOptions = {},
): Map<number, ContextAwareCacheExplanationV1> {
	const explained = new Map<number, ContextAwareCacheExplanationV1>();
	let previous: ObservedRequest | undefined;
	let folds: PendingFold[] = [];
	let rewrite: "compaction" | "branch-summary" | undefined;
	let cause: ContextAwareCacheCauseV1 | undefined;
	let sawCache = false;
	for (const entry of branch) {
		if (entry.type === "compaction") {
			rewrite = "compaction";
			continue;
		}
		if (entry.type === "branch_summary") {
			rewrite ??= "branch-summary";
			continue;
		}
		if (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE) {
			const record = readFoldRecord(entry.data);
			if (record) folds.push({ blockId: record.blockId, event: { at: record.createdAt, tokensCompressed: record.compressedTokens } });
			continue;
		}
		if (entry.type === "custom" && (entry.customType === CACHE_VERDICT_ENTRY || entry.customType === CACHE_GUARD_ENTRY)) {
			cause = readCause(entry.data, entry.customType === CACHE_GUARD_ENTRY);
			continue;
		}
		if (entry.type !== "message") continue;
		const observed = requestOf(entry.message, options);
		if (!observed) continue;
		const ended = Date.parse(entry.timestamp);
		const current = Number.isFinite(ended) && ended > observed.at ? { ...observed, end: ended } : observed;
		sawCache ||= current.sample.cached > 0 || current.cacheWrite > 0;
		if (sawCache && !explained.has(current.at)) explained.set(current.at, explainRequest(previous, current, folds, rewrite, cause, options));
		previous = current;
		folds = [];
		rewrite = undefined;
		cause = undefined;
	}
	return explained;
}

/** The part of the session manager the capability reads. */
export interface CacheExplainSource {
	getBranch(): SessionEntry[];
	getLeafId(): string | null;
}

/**
 * The service's cache capability. The TUI asks for every retained message on each
 * frame, so the branch is walked once per leaf and answers come from that result.
 * `source` returns undefined once the session that published the service has ended.
 */
export function createCacheExplainCapability(
	source: () => CacheExplainSource | undefined,
	options: () => CacheExplainOptions = () => ({}),
): ContextAwareCacheV1 {
	let memo: { readonly leafId: string | null; readonly explained: Map<number, ContextAwareCacheExplanationV1> } | undefined;
	return Object.freeze({
		v1: true as const,
		explain(messageTimestamp: number): ContextAwareCacheExplanationV1 | undefined {
			if (typeof messageTimestamp !== "number" || !Number.isInteger(messageTimestamp)) return undefined;
			const session = source();
			if (!session) {
				memo = undefined;
				return undefined;
			}
			const leafId = session.getLeafId();
			if (!memo || memo.leafId !== leafId) memo = { leafId, explained: explainCacheOnBranch(session.getBranch(), options()) };
			return memo.explained.get(messageTimestamp);
		},
	});
}
