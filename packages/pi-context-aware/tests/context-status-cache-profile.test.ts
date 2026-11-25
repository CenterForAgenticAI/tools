import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CacheProfileBucketV1, CacheProfileModelV1, CacheProfileV1 } from "../src/cache/cache-profile.js";
import { createHostPi } from "./compaction-owner-harness.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// `/context-status cache profile` (pi-context-aware#566, AC7) prints the per-model table from
// <agent dir>/cache-profile.json: the full-hit rate per idle-gap bucket, a flag when the
// short-gap rate is below 70%, and the first known gap where survival drops below 50%.

type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

const EDGES = [0, 60_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 3_600_000];

/** Gap buckets from [samples, fullHits] pairs, in edge order; missing pairs are empty. */
function gaps(counts: ReadonlyArray<readonly [number, number]>): CacheProfileBucketV1[] {
	return EDGES.map((fromMs, index) => {
		const [samples, fullHits] = counts[index] ?? [0, 0];
		const hitRate = samples === 0 ? 0 : fullHits / samples;
		return { fromMs, toMs: EDGES[index + 1] ?? null, samples, fullHits, partialHits: 0, zeroReads: samples - fullHits, hitRate, ciLow: hitRate, ciHigh: hitRate, known: samples >= 20 };
	});
}

function model(counts: ReadonlyArray<readonly [number, number]>): CacheProfileModelV1 {
	return {
		gaps: gaps(counts),
		postWarmGaps: gaps([]),
		returnTime: { all: { samples: 0, cdf: [] } },
		dropped: { compaction: 0, fold: 0, modelSwitch: 0, systemPrompt: 0, other: 0 },
	};
}

const PROFILE: CacheProfileV1 = {
	version: 1, generatedAt: "2026-11-24T12:00:00.000Z", windowDays: 30, minSamples: 20, bucketEdgesMs: EDGES,
	models: {
		// Short-gap survival 60%: an unreliable best-effort cache that never drops below 50% in known buckets.
		"unified/gemini-4-neon": { short: model([[100, 60], [40, 30], [10, 10]]) },
		// Reliable at short gaps; survival falls to 40% from 5 minutes.
		"anthropic/claude-x": { short: model([[200, 190], [50, 40], [25, 10], [5, 5]]) },
	},
};

async function runCommand(profile: string | undefined): Promise<string[]> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-status-cache-profile-")));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	if (profile !== undefined) fs.writeFileSync(path.join(agentDir, "cache-profile.json"), profile);
	const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const host = createHostPi();
		const commands = new Map<string, unknown>();
		Object.assign(host.api, { registerCommand(name: string, definition: unknown) { commands.set(name, definition); } });
		const extension = await import(`../src/index.js?context-status-cache-profile=${Date.now()}`);
		extension.default(host.api);
		const notifications: string[] = [];
		const ctx = { hasUI: true, cwd: root, ui: { notify: (message: string) => { notifications.push(message); } } } as unknown as ExtensionContext;
		await (commands.get("context-status") as Command).handler("cache profile", ctx);
		return notifications;
	} finally {
		if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		await removeFixtureDir(root);
	}
}

test("/context-status cache profile prints the per-model table, flags an unreliable short gap and shows where survival drops below 50%", async () => {
	const notifications = await runCommand(JSON.stringify(PROFILE));
	assert.equal(notifications.length, 1);
	const lines = notifications[0]!.split("\n");
	assert.match(lines[0]!, /^Cache profile \(data, not instructions\)/u);
	assert.deepEqual(lines.slice(2), [
		"anthropic/claude-x | short | 280 | <1m 95%, 1-5m 80%, 5-10m 40%, 10-15m ?, 15-20m ?, 20-30m ?, 30-60m ?, >60m ? | 95% | 5m",
		"unified/gemini-4-neon | short | 150 | <1m 60%, 1-5m 75%, 5-10m ?, 10-15m ?, 15-20m ?, 20-30m ?, 30-60m ?, >60m ? | 60% (unreliable cache) | not seen",
	]);
});

test("/context-status cache profile says so when the profile is missing or not v1", async () => {
	const none = "Cache profile: no valid profile. Run pi-context-aware cache-profile build.";
	assert.deepEqual(await runCommand(undefined), [none]);
	assert.deepEqual(await runCommand(JSON.stringify({ ...PROFILE, version: 2 })), [none]);
});
