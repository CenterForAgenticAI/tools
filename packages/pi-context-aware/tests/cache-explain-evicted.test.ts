import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { explainCacheOnBranch } from "../src/cache/cache-explain.js";
import { assistantEntry, geminiProfile, KEY, MIN, SEC, T0 } from "./cache-profile-fixtures.js";

// cache.explain() reads the measured profile (pi-context-aware#566, AC6). Explain options
// as these tests use them:
//   profile: the v1 profile (CacheProfileV1), or undefined for none;
//   hasPromptCache(model): whether the "provider/model" row carries promptCache.
// A miss inside the measured survival window, on a row without promptCache and with a
// known bucket at that gap, is the reset kind "evicted" with survivalPct, the bucket's
// full-hit rate in whole percent. Everything else stays today's answer.
//
// Timeline: the first request reports no cache, the second reads 100,000 of 102,000,
// and the third misses entirely 16 minutes (960,000 ms) after the second started.

const MISS_AT = T0 + 40 * SEC + 16 * MIN;
const BRANCH: SessionEntry[] = [
	assistantEntry(T0, T0 + 10 * SEC, { input: 100_000, read: 0 }),
	assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, { input: 2000, read: 100_000 }),
	assistantEntry(MISS_AT, MISS_AT + 10 * SEC, { input: 103_000, read: 0 }),
];
const TODAY = { kind: "expired", idleMs: 960_000, ttlMs: 300_000, lostTokens: 102_000 };
const noPromptCache = (model: string): boolean => (model === KEY ? false : true);

test("S5: a miss inside the measured survival window is evicted, and without a profile it stays expired", () => {
	// 36 of 40 requests survived a 15-20 minute gap: 90%.
	const withProfile = explainCacheOnBranch(BRANCH, { profile: geminiProfile(40, 36), hasPromptCache: noPromptCache });
	assert.deepEqual(withProfile.get(MISS_AT)?.reset, { ...TODAY, kind: "evicted", survivalPct: 90 });
	const withoutProfile = explainCacheOnBranch(BRANCH, { hasPromptCache: noPromptCache });
	assert.deepEqual(withoutProfile.get(MISS_AT)?.reset, TODAY);
});

test("too few samples at the gap leave the miss expired, and enough samples make it evicted", () => {
	const sparse = explainCacheOnBranch(BRANCH, { profile: geminiProfile(5, 5), hasPromptCache: noPromptCache });
	assert.deepEqual(sparse.get(MISS_AT)?.reset, TODAY);
	const dense = explainCacheOnBranch(BRANCH, { profile: geminiProfile(20, 19), hasPromptCache: noPromptCache });
	assert.deepEqual(dense.get(MISS_AT)?.reset, { ...TODAY, kind: "evicted", survivalPct: 95 });
});

test("a row that carries promptCache keeps today's answer with a profile, and one without it does not", () => {
	const profile = geminiProfile(40, 36);
	const fixed = explainCacheOnBranch(BRANCH, { profile, hasPromptCache: () => true });
	assert.deepEqual(fixed.get(MISS_AT)?.reset, TODAY);
	const measured = explainCacheOnBranch(BRANCH, { profile, hasPromptCache: () => false });
	assert.equal(measured.get(MISS_AT)?.reset?.kind, "evicted");
});
