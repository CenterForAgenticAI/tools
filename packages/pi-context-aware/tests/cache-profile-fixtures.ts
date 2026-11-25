import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CacheProfileBucketV1, CacheProfileModelV1, CacheProfileV1 } from "../src/cache/cache-profile.js";

// Shared fixtures for the cache-survival profile (pi-context-aware#566).
//
// The module under test is src/cache/cache-profile.ts. Its contract, as these tests use it:
//   buildCacheProfile({ agentDir, now, windowDays?, minSamples? }) scans
//     <agentDir>/sessions/**/*.jsonl, writes <agentDir>/cache-profile.json (v1) and
//     returns the profile it wrote (directly or as a promise).
//   readCacheProfile(agentDir) returns the v1 profile, or undefined for a missing,
//     corrupt or other-version file. It never throws.
// The v1 shape is the one in the issue's plan block.
//
// In Pi's session JSONL an assistant entry's ISO timestamp is when the response was
// appended (its end), and message.timestamp is when the request started. A cache_warm
// usage entry is { type: "usage", kind: "cache_warm", provider, model, usage }.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const T0 = 1_800_000_000_000;
export const PROVIDER = "unified";
export const MODEL = "gemini-4-neon";
export const KEY = PROVIDER + "/" + MODEL;
export const EDGES = [0, 60_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 3_600_000] as const;

type CacheProfileModule = typeof import("../src/cache/cache-profile.js");

/** The module, or an empty object while it does not exist, so each test fails on its own assertion. */
export async function loadCacheProfileModule(): Promise<Partial<CacheProfileModule>> {
	try {
		return await import("../src/cache/cache-profile.js");
	} catch (_error) {
		return {};
	}
}

export function tempAgentDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface UsageIn { readonly input: number; readonly read: number; readonly write?: number }

let counter = 0;
const nextId = (stem: string): string => stem + "-" + String(++counter);

function usageOf(usage: UsageIn): Record<string, unknown> {
	return {
		input: usage.input, output: 10, cacheRead: usage.read, cacheWrite: usage.write ?? 0,
		totalTokens: usage.input + usage.read + (usage.write ?? 0) + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** One provider request: it started at startMs and its response was appended at endMs. */
export function assistantEntry(startMs: number, endMs: number, usage: UsageIn, extra: { id?: string; text?: string; responseId?: string } = {}): SessionEntry {
	return {
		type: "message", id: extra.id ?? nextId("a"), parentId: null, timestamp: new Date(endMs).toISOString(),
		message: {
			role: "assistant", content: [{ type: "text", text: extra.text ?? "ok" }], api: "google-generative-ai",
			provider: PROVIDER, model: MODEL, stopReason: "stop", timestamp: startMs, usage: usageOf(usage),
			...(extra.responseId === undefined ? {} : { responseId: extra.responseId }),
		},
	} as unknown as SessionEntry;
}

export function userEntry(at: number, text = "next", id?: string): SessionEntry {
	return { type: "message", id: id ?? nextId("u"), parentId: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: text, timestamp: at } } as unknown as SessionEntry;
}

/** A fold landing, in the shape src/folds/fold-entries.ts reads. */
export function foldEntry(at: number, blockId = "b5"): SessionEntry {
	return {
		type: "custom", id: nextId("f"), parentId: null, timestamp: new Date(at).toISOString(), customType: "context-aware.fold.v1",
		data: {
			version: 1, blockId, runId: "r1", tier: 1, carrierId: "c1", hiddenIds: [], range: { startId: "c1", endId: "c1" },
			refs: { start: "", end: "" }, directBlockIds: [], compressedTokens: 4000, createdAt: at, origin: "fold",
		},
	} as unknown as SessionEntry;
}

/** A cache-warming request Pi recorded at the given time. */
export function warmEntry(at: number): SessionEntry {
	return {
		type: "usage", id: nextId("w"), parentId: null, timestamp: new Date(at).toISOString(), kind: "cache_warm",
		provider: PROVIDER, model: MODEL, usage: usageOf({ input: 50, read: 100_000 }),
	} as unknown as SessionEntry;
}

/** Write one session file under <agentDir>/sessions/<project dir>/<file>. */
export function writeSession(agentDir: string, file: string, entries: readonly SessionEntry[], header: { id?: string; cwd?: string; projectDir?: string } = {}): string {
	const dir = path.join(agentDir, "sessions", header.projectDir ?? "--tmp-project--");
	fs.mkdirSync(dir, { recursive: true });
	const head = { type: "session", version: 3, id: header.id ?? "session-1", timestamp: new Date(T0 - MIN).toISOString(), cwd: header.cwd ?? "/tmp/project" };
	const target = path.join(dir, file);
	fs.writeFileSync(target, [head, ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return target;
}

/** The one retention profile recorded for a model, or undefined when there is none or several. */
export function modelProfile(profile: CacheProfileV1 | undefined, key = KEY): CacheProfileModelV1 | undefined {
	const byRetention = profile?.models?.[key];
	const values = byRetention ? Object.values(byRetention).filter((value): value is CacheProfileModelV1 => value !== undefined) : [];
	return values.length === 1 ? values[0] : undefined;
}

/** The bucket covering a gap: fromMs <= gap < toMs, with a null toMs open-ended. */
export function bucketAt(buckets: readonly CacheProfileBucketV1[] | undefined, gapMs: number): CacheProfileBucketV1 | undefined {
	return buckets?.find((bucket) => bucket.fromMs <= gapMs && (bucket.toMs === null || gapMs < bucket.toMs));
}

/** Sum of samples over a series, or -1 when the series is missing. */
export function totalSamples(buckets: readonly CacheProfileBucketV1[] | undefined): number {
	return buckets ? buckets.reduce((sum, bucket) => sum + bucket.samples, 0) : -1;
}

function bucket(fromMs: number, toMs: number | null, samples: number, fullHits: number, known: boolean): CacheProfileBucketV1 {
	const hitRate = samples === 0 ? 0 : fullHits / samples;
	return { fromMs, toMs, samples, fullHits, partialHits: 0, zeroReads: samples - fullHits, hitRate, ciLow: hitRate, ciHigh: hitRate, known };
}

/**
 * A v1 profile for the Gemini-like model whose 15-20 minute bucket holds the given
 * samples and full hits, and every other bucket is empty. The same model profile sits
 * under every retention, so a reader may pick any of them.
 */
export function geminiProfile(samples: number, fullHits: number, minSamples = 20): CacheProfileV1 {
	const gaps = EDGES.map((fromMs, index) => {
		const toMs = index + 1 < EDGES.length ? EDGES[index + 1]! : null;
		return fromMs === 900_000 ? bucket(fromMs, toMs, samples, fullHits, samples >= minSamples) : bucket(fromMs, toMs, 0, 0, false);
	});
	const model: CacheProfileModelV1 = {
		gaps,
		postWarmGaps: EDGES.map((fromMs, index) => bucket(fromMs, index + 1 < EDGES.length ? EDGES[index + 1]! : null, 0, 0, false)),
		returnTime: { all: { samples: 0, cdf: [] } },
		dropped: { compaction: 0, fold: 0, modelSwitch: 0, systemPrompt: 0, other: 0 },
	};
	return {
		version: 1, generatedAt: new Date(T0).toISOString(), windowDays: 30, minSamples, bucketEdgesMs: [...EDGES],
		models: { [KEY]: { short: model, long: model, none: model } },
	};
}
