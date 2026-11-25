import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { explainCacheOnBranch } from "../src/cache/cache-explain.js";
import type { CacheProfileV1 } from "../src/cache/cache-profile.js";
import { assistantEntry, geminiProfile, loadCacheProfileModule, MIN, SEC, T0, tempAgentDir } from "./cache-profile-fixtures.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// Readers ignore a corrupt or other-version profile (pi-context-aware#566, AC5).

const MISS_AT = T0 + 40 * SEC + 16 * MIN;
const BRANCH: SessionEntry[] = [
	assistantEntry(T0, T0 + 10 * SEC, { input: 100_000, read: 0 }),
	assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, { input: 2000, read: 100_000 }),
	assistantEntry(MISS_AT, MISS_AT + 10 * SEC, { input: 103_000, read: 0 }),
];

function kindWith(profile: CacheProfileV1 | undefined): string | undefined {
	return explainCacheOnBranch(BRANCH, { profile, hasPromptCache: () => false }).get(MISS_AT)?.reset?.kind;
}

test("S6: a corrupt or newer-version profile is ignored and the answer stays expired", async () => {
	const agentDir = tempAgentDir("cache-profile-read-");
	try {
		const mod = await loadCacheProfileModule();
		const read = (): CacheProfileV1 | undefined => mod.readCacheProfile?.(agentDir);
		const file = path.join(agentDir, "cache-profile.json");
		const valid = geminiProfile(40, 36);

		// Control: a valid v1 file is read and changes the answer.
		fs.writeFileSync(file, JSON.stringify(valid));
		const accepted = read();
		assert.equal(accepted?.version, 1);
		assert.equal(kindWith(accepted), "evicted");

		fs.writeFileSync(file, "{\"version\": 1, \"models\": {");
		assert.doesNotThrow(read);
		assert.equal(read(), undefined);
		assert.equal(kindWith(read()), "expired");

		fs.writeFileSync(file, JSON.stringify({ ...valid, version: 2 }));
		assert.doesNotThrow(read);
		assert.equal(read(), undefined);
		assert.equal(kindWith(read()), "expired");
	} finally {
		await removeFixtureDir(agentDir);
	}
});
