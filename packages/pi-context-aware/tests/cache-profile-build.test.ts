import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { CacheProfileBucketV1 } from "../src/cache/cache-profile.js";

import {
	assistantEntry, bucketAt, foldEntry, KEY, loadCacheProfileModule, MIN, modelProfile, SEC, T0, tempAgentDir,
	totalSamples, userEntry, warmEntry, writeSession, type UsageIn,
} from "./cache-profile-fixtures.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// The cache-survival profile builder (pi-context-aware#566). Every expected count below
// is worked by hand from the fixture timeline. A gap runs from the end of the previous
// response (or the latest cache_warm entry) to the start of the next request.

const HIT: UsageIn = { input: 2000, read: 100_000 };
const MISS: UsageIn = { input: 102_000, read: 0 };
const NOW = T0 + 60 * MIN;

async function build(agentDir: string) {
	const mod = await loadCacheProfileModule();
	return await mod.buildCacheProfile?.({ agentDir, now: NOW, minSamples: 20 });
}

test("S1: a fold between two requests drops the pair and counts it under fold", async () => {
	const agentDir = tempAgentDir("cache-profile-fold-");
	try {
		writeSession(agentDir, "fold.jsonl", [
			userEntry(T0 - SEC),
			assistantEntry(T0, T0 + 10 * SEC, { input: 102_000, read: 0 }),
			userEntry(T0 + 20 * SEC),
			// Gap 30 s (end 10 s to start 40 s): one full hit in the first bucket.
			assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, HIT),
			foldEntry(T0 + 60 * SEC),
			userEntry(T0 + 70 * SEC),
			// The fold rewrote the prefix: this miss must not count as a sample.
			assistantEntry(T0 + 80 * SEC, T0 + 90 * SEC, MISS),
		]);
		const model = modelProfile(await build(agentDir));
		assert.equal(totalSamples(model?.gaps), 1);
		assert.equal(bucketAt(model?.gaps, 30 * SEC)?.fullHits, 1);
		assert.equal(model?.gaps.reduce((sum: number, bucket: CacheProfileBucketV1) => sum + bucket.zeroReads, 0), 0);
		assert.deepEqual(model?.dropped, { compaction: 0, fold: 1, modelSwitch: 0, systemPrompt: 0, other: 0 });
	} finally {
		await removeFixtureDir(agentDir);
	}
});

test("S2: a cache_warm entry starts the gap and puts the pair in the post-warm series", async () => {
	const agentDir = tempAgentDir("cache-profile-warm-");
	try {
		const end = T0 + 50 * SEC;
		writeSession(agentDir, "warm.jsonl", [
			assistantEntry(T0, T0 + 10 * SEC, { input: 102_000, read: 0 }),
			// Gap 30 s: an ordinary pair.
			assistantEntry(T0 + 40 * SEC, end, HIT),
			// Warmed 4 minutes after the response ended.
			warmEntry(end + 4 * MIN),
			userEntry(end + 16 * MIN - SEC),
			// Starts 16 minutes after the response, 12 minutes after the warm.
			assistantEntry(end + 16 * MIN, end + 16 * MIN + 10 * SEC, HIT),
		]);
		const model = modelProfile(await build(agentDir));
		const warmed = bucketAt(model?.postWarmGaps, 12 * MIN);
		assert.equal(warmed?.fromMs, 600_000);
		assert.equal(warmed?.samples, 1);
		assert.equal(warmed?.fullHits, 1);
		assert.equal(totalSamples(model?.postWarmGaps), 1);
		// The post-warm pair is its own series: the ordinary series holds only the 30 s pair.
		assert.equal(totalSamples(model?.gaps), 1);
		assert.equal(bucketAt(model?.gaps, 30 * SEC)?.samples, 1);
	} finally {
		await removeFixtureDir(agentDir);
	}
});

test("S3: a session copied into two files counts each pair once", async () => {
	const agentDir = tempAgentDir("cache-profile-dedupe-");
	try {
		const entries: SessionEntry[] = [
			assistantEntry(T0, T0 + 10 * SEC, { input: 102_000, read: 0 }, { id: "req-1" }),
			assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, HIT, { id: "req-2" }),
			assistantEntry(T0 + 80 * SEC, T0 + 90 * SEC, HIT, { id: "req-3" }),
		];
		writeSession(agentDir, "original.jsonl", entries, { id: "session-original" });
		// A fork copies the entries, with their ids, under a new session header.
		writeSession(agentDir, "fork.jsonl", entries, { id: "session-fork" });
		const model = modelProfile(await build(agentDir));
		assert.equal(totalSamples(model?.gaps), 2);
		assert.equal(bucketAt(model?.gaps, 30 * SEC)?.fullHits, 2);
	} finally {
		await removeFixtureDir(agentDir);
	}
});

/** 21 requests 30 s apart (20 pairs: 18 full hits, 2 zero reads), then 3 requests 2 minutes apart. */
function minimumFixture(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let start = T0;
	for (let index = 0; index < 21; index++) {
		const usage = index === 0 || index === 7 || index === 14 ? MISS : HIT;
		entries.push(assistantEntry(start, start + 10 * SEC, usage));
		start += 40 * SEC;
	}
	start += 90 * SEC; // The last response ended 30 s before the old start; now 2 minutes.
	for (let index = 0; index < 3; index++) {
		entries.push(assistantEntry(start, start + 10 * SEC, HIT));
		start += 130 * SEC;
	}
	return entries;
}

test("S4: a bucket below the minimum sample count is reported unknown", async () => {
	const agentDir = tempAgentDir("cache-profile-minimum-");
	try {
		writeSession(agentDir, "minimum.jsonl", minimumFixture());
		const profile = await build(agentDir);
		assert.equal(profile?.minSamples, 20);
		const model = modelProfile(profile);
		const short = bucketAt(model?.gaps, 30 * SEC);
		assert.equal(short?.samples, 20);
		assert.equal(short?.known, true);
		const sparse = bucketAt(model?.gaps, 2 * MIN);
		assert.equal(sparse?.fromMs, 60_000);
		assert.equal(sparse?.samples, 3);
		assert.equal(sparse?.known, false);
	} finally {
		await removeFixtureDir(agentDir);
	}
});

test("a bucket's hit rate carries a 95% Wilson interval and the file is written", async () => {
	const agentDir = tempAgentDir("cache-profile-wilson-");
	try {
		writeSession(agentDir, "minimum.jsonl", minimumFixture());
		const model = modelProfile(await build(agentDir));
		const short = bucketAt(model?.gaps, 30 * SEC);
		assert.equal(short?.fullHits, 18);
		assert.equal(short?.zeroReads, 2);
		assert.equal(short?.partialHits, 0);
		assert.equal(short?.hitRate, 0.9);
		// Wilson score interval for 18 of 20 at z = 1.96: [0.6990, 0.9721].
		assert.ok(Math.abs((short?.ciLow ?? -1) - 0.699) < 0.001, "ciLow " + String(short?.ciLow));
		assert.ok(Math.abs((short?.ciHigh ?? -1) - 0.9721) < 0.001, "ciHigh " + String(short?.ciHigh));
		const written = JSON.parse(fs.readFileSync(agentDir + "/cache-profile.json", "utf8")) as { version?: unknown; models?: Record<string, unknown> };
		assert.equal(written.version, 1);
		assert.ok(written.models && KEY in written.models);
	} finally {
		await removeFixtureDir(agentDir);
	}
});
