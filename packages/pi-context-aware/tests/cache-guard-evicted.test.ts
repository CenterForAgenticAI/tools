import test from "node:test";
import assert from "node:assert/strict";

import { cacheExpiredAfter } from "../src/cache/cache-guard.js";
import { geminiProfile, MIN, MODEL, PROVIDER } from "./cache-profile-fixtures.js";

// The cache guard reads the measured profile (pi-context-aware#566, AC6). Past the fixed
// 5-minute lifetime the guard treats the cache as expired and predicts no lost prefix. For a
// row without promptCache whose profile measured survival at that gap, the cache is not
// expired, so a prefix change there is still a costly break.

const GEMINI = { provider: PROVIDER, id: MODEL };
const SIXTEEN_MINUTES = 16 * MIN;

function withShortRetention(body: () => void): void {
	const previous = process.env.PI_CACHE_RETENTION;
	delete process.env.PI_CACHE_RETENTION;
	try {
		body();
	} finally {
		if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = previous;
	}
}

test("the guard keeps a measured best-effort cache alive past the fixed lifetime, and expires it without a profile", () => {
	withShortRetention(() => {
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, GEMINI, () => geminiProfile(40, 36)), false, "90% survival at 15-20 minutes");
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, GEMINI, () => undefined), true, "no profile keeps today's expiry");
	});
});

test("the guard expires the cache when the profile lacks evidence, survival is low, or the row carries promptCache", () => {
	withShortRetention(() => {
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, GEMINI, () => geminiProfile(5, 5)), true, "5 samples are below the minimum");
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, GEMINI, () => geminiProfile(40, 10)), true, "25% survival is outside the window");
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, { ...GEMINI, promptCache: { retention: "short" } }, () => geminiProfile(40, 36)), true);
		assert.equal(cacheExpiredAfter(SIXTEEN_MINUTES, undefined, () => geminiProfile(40, 36)), true);
	});
});

test("inside the fixed lifetime the cache is never expired and the profile is not read", () => {
	withShortRetention(() => {
		let reads = 0;
		const profile = () => {
			reads++;
			return undefined;
		};
		assert.equal(cacheExpiredAfter(4 * MIN, GEMINI, profile), false);
		assert.equal(reads, 0);
		assert.equal(cacheExpiredAfter(6 * MIN, GEMINI, profile), true);
		assert.equal(reads, 1);
	});
});
