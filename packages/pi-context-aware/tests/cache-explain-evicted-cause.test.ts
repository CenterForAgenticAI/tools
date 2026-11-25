import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { explainCacheOnBranch } from "../src/cache/cache-explain.js";
import { assistantEntry, geminiProfile, KEY, MIN, SEC, T0 } from "./cache-profile-fixtures.js";

// An `evicted` answer (pi-context-aware#566) claims the provider dropped a cache the prompt
// still matched. A recorded prefix change before the miss contradicts that claim, so the
// answer stays today's. Timeline as in cache-explain-evicted.test.ts: the third request
// misses entirely 16 minutes after the second, where the profile measured 90% survival.

const MISS_AT = T0 + 40 * SEC + 16 * MIN;
const noPromptCache = (model: string): boolean => model !== KEY;

function branch(between: readonly SessionEntry[]): SessionEntry[] {
	return [
		assistantEntry(T0, T0 + 10 * SEC, { input: 100_000, read: 0 }),
		assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, { input: 2000, read: 100_000 }),
		...between,
		assistantEntry(MISS_AT, MISS_AT + 10 * SEC, { input: 103_000, read: 0 }),
	];
}

function guardEntry(data: Record<string, unknown>): SessionEntry {
	return { type: "custom", id: "g1", parentId: null, timestamp: new Date(MISS_AT).toISOString(), customType: "context-aware.cache-guard.v1", data } as unknown as SessionEntry;
}

test("a recorded system-prompt change before the miss keeps today's answer instead of evicted", () => {
	const options = { profile: geminiProfile(40, 36), hasPromptCache: noPromptCache };
	const changed = explainCacheOnBranch(branch([guardEntry({ kind: "system-section", sections: ["rules"] })]), options);
	assert.equal(changed.get(MISS_AT)?.reset?.kind, "expired");
	assert.equal(changed.get(MISS_AT)?.reset?.survivalPct, undefined);
	const unchanged = explainCacheOnBranch(branch([]), options);
	assert.deepEqual(unchanged.get(MISS_AT)?.reset, { kind: "evicted", idleMs: 960_000, ttlMs: 300_000, lostTokens: 102_000, survivalPct: 90 });
});
