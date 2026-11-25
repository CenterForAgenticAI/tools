import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { explainCacheOnBranch } from "../src/cache/cache-explain.js";
import { registerCacheGuard } from "../src/cache/cache-guard.js";
import { CACHE_PROFILE_FILE } from "../src/cache/cache-profile.js";
import { assistantEntry, geminiProfile, KEY, MIN, MODEL, PROVIDER, SEC, T0, tempAgentDir } from "./cache-profile-fixtures.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// The profile measures the idle gap from the end of the previous response to the start of the next
// request (cache-profile.ts). Its consumers must look it up on the same clock (CR-PROFILE-IDLE-CLOCK,
// pi-context-aware!447): after a 10-minute response and 16 idle minutes, the gap is 16 minutes, inside
// the 15-20 minute bucket where the profile measured 90% survival, not the 26 minutes between starts.

const noPromptCache = (model: string): boolean => model !== KEY;

test("explain looks the profile up from the end of the previous response", () => {
	const secondEnd = T0 + 40 * SEC + 10 * MIN;
	const missAt = secondEnd + 16 * MIN;
	const branch: SessionEntry[] = [
		assistantEntry(T0, T0 + 10 * SEC, { input: 100_000, read: 0 }),
		// A 10-minute response.
		assistantEntry(T0 + 40 * SEC, secondEnd, { input: 2000, read: 100_000 }),
		assistantEntry(missAt, missAt + 10 * SEC, { input: 103_000, read: 0 }),
	];
	const explained = explainCacheOnBranch(branch, { profile: geminiProfile(40, 36), hasPromptCache: noPromptCache });
	// idleMs keeps its meaning (start to start, the fixed lifetime's clock); only the lookup moves.
	assert.deepEqual(explained.get(missAt)?.reset, { kind: "evicted", idleMs: 26 * MIN, ttlMs: 300_000, lostTokens: 102_000, survivalPct: 90 });
});

function payload(rule: string) {
	return { system: [{ type: "text", text: `<rules>\n${rule}\n</rules>\n` + "stable ".repeat(2000), cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "question", cache_control: { type: "ephemeral" } }] }] };
}

test("the guard counts a lost prefix when the cache measured alive since the response ended", async (t) => {
	const agentDir = tempAgentDir("cache-idle-clock-");
	const saved = { dir: process.env.PI_CODING_AGENT_DIR, retention: process.env.PI_CACHE_RETENTION };
	t.mock.timers.enable({ apis: ["Date"], now: T0 });
	try {
		fs.writeFileSync(path.join(agentDir, CACHE_PROFILE_FILE), JSON.stringify(geminiProfile(40, 36)));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CACHE_RETENTION;
		const entries: Array<Record<string, unknown>> = [];
		const pi = {
			on() {},
			appendEntry(type: string, data: Record<string, unknown>) { if (type === "context-aware.cache-guard.v1") entries.push(data); },
		} as unknown as ExtensionAPI;
		const ctx = { model: { provider: PROVIDER, id: MODEL, api: "google-generative-ai" }, hasUI: false, ui: { setStatus() {} }, abort() {} } as unknown as ExtensionContext;
		const guard = registerCacheGuard(pi, () => ({ enabled: true, askAboveUsd: 1000, interactive: "never" }));
		await guard.providerRequest(payload("old"), ctx);
		// The response takes 10 minutes and reports usage.
		t.mock.timers.setTime(T0 + 10 * MIN);
		guard.messageEnd({ role: "assistant", timestamp: T0, provider: PROVIDER, model: MODEL, usage: { input: 2000, output: 10, cacheRead: 100_000, cacheWrite: 0 } });
		// 16 idle minutes later a rule section changes.
		t.mock.timers.setTime(T0 + 26 * MIN);
		await guard.providerRequest(payload("new"), ctx);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.kind, "system-section");
		assert.ok(Number(entries[0]!.lostTokens) > 2000, "the measured cache was alive, so the stable prefix after the rule is lost");
	} finally {
		if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.dir;
		if (saved.retention !== undefined) process.env.PI_CACHE_RETENTION = saved.retention;
		await removeFixtureDir(agentDir);
	}
});
