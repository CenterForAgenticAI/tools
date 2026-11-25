import test from "node:test";
import assert from "node:assert/strict";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { buildCacheProfile } from "../src/cache/cache-profile.js";
import { assistantEntry, MIN, modelProfile, T0, tempAgentDir, totalSamples, userEntry, writeSession, type UsageIn } from "./cache-profile-fixtures.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// The profile builder follows the session tree (CR-PROFILE-BRANCH-PAIRS, pi-context-aware!447). Pi appends
// every entry as a child of the current leaf, so an entry whose parent is not the previous entry marks a move
// to another branch. The request before the move and the first one after it do not share one prompt, so the
// pair is dropped and counted under "other", never sampled.

const HIT: UsageIn = { input: 2000, read: 100_000 };
const MISS: UsageIn = { input: 102_000, read: 0 };
const NOW = T0 + 120 * MIN;

/** An entry placed in the tree under `parentId`. */
const at = (entry: SessionEntry, id: string, parentId: string | null): SessionEntry => ({ ...entry, id, parentId }) as SessionEntry;

async function profileOf(prefix: string, entries: readonly SessionEntry[]) {
	const agentDir = tempAgentDir(prefix);
	try {
		writeSession(agentDir, "tree.jsonl", entries);
		return modelProfile(await buildCacheProfile({ agentDir, now: NOW, minSamples: 20 }));
	} finally {
		await removeFixtureDir(agentDir);
	}
}

test("a request on a sibling branch is not paired with the request before the move", async () => {
	const model = await profileOf("cache-profile-branch-", [
		at(userEntry(T0 - MIN), "u1", null),
		at(assistantEntry(T0, T0 + MIN, MISS), "a", "u1"),
		at(userEntry(T0 + 90_000), "u2", "a"),
		// A child of A: one ordinary pair, gap 1 minute (end 1m to start 2m).
		at(assistantEntry(T0 + 2 * MIN, T0 + 3 * MIN, HIT), "b", "u2"),
		// /tree back to A: this user message is A's child, not B's.
		at(userEntry(T0 + 16 * MIN), "u3", "a"),
		// C rewinds B's history. Paired with B it would be a 14-minute sample; it must be dropped.
		at(assistantEntry(T0 + 17 * MIN, T0 + 18 * MIN, MISS), "c", "u3"),
		at(userEntry(T0 + 19 * MIN), "u4", "c"),
		// Back on one line: C to D is an ordinary pair again, gap 2 minutes.
		at(assistantEntry(T0 + 20 * MIN, T0 + 21 * MIN, HIT), "d", "u4"),
	]);
	assert.equal(totalSamples(model?.gaps), 2, "A to B and C to D only");
	assert.equal(model?.gaps.find((bucket) => bucket.fromMs === 600_000)?.samples, 0, "no 10-15 minute sample from B to C");
	assert.deepEqual(model?.dropped, { compaction: 0, fold: 0, modelSwitch: 0, systemPrompt: 0, other: 1 });
});

test("a new root after tree entries is a move, and a branch summary still counts as compaction", async () => {
	const model = await profileOf("cache-profile-root-", [
		at(assistantEntry(T0, T0 + MIN, MISS), "a", null),
		at(userEntry(T0 + 90_000), "u2", "a"),
		at(assistantEntry(T0 + 2 * MIN, T0 + 3 * MIN, HIT), "b", "u2"),
		// Reset to the root: the next entry has no parent.
		at(userEntry(T0 + 4 * MIN), "u3", null),
		at(assistantEntry(T0 + 5 * MIN, T0 + 6 * MIN, MISS), "c", "u3"),
		// /tree back to B with a summary: the summary is a compaction of the abandoned branch.
		{ type: "branch_summary", id: "s", parentId: "b", timestamp: new Date(T0 + 7 * MIN).toISOString(), fromId: "c", summary: "x" } as unknown as SessionEntry,
		at(userEntry(T0 + 8 * MIN), "u4", "s"),
		at(assistantEntry(T0 + 9 * MIN, T0 + 10 * MIN, MISS), "d", "u4"),
	]);
	assert.equal(totalSamples(model?.gaps), 1, "A to B only");
	assert.deepEqual(model?.dropped, { compaction: 1, fold: 0, modelSwitch: 0, systemPrompt: 0, other: 1 });
});
