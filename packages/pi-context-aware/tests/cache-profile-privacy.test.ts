import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { assistantEntry, KEY, loadCacheProfileModule, SEC, T0, tempAgentDir, userEntry, writeSession } from "./cache-profile-fixtures.js";
import { removeFixtureDir } from "./fixture-cleanup.js";

// The profile holds aggregates only (pi-context-aware#566, AC4). A projection that
// spreads entry or message fields into the profile copies these strings through.

const FORBIDDEN = [
	"ZEBRA", // prompt text
	"ORCHID", // tool output
	"IBEX", // assistant text
	"QUOKKA", // provider request id
	"NARWHAL", // session id
	"PANGOLIN", // project path and session directory
	"KESTREL", // session file name
	"/srv/someone",
];

function toolResult(at: number): SessionEntry {
	return {
		type: "message", id: "t" + String(at), parentId: null, timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ORCHID tool output 5521" }], isError: false, timestamp: at },
	} as unknown as SessionEntry;
}

test("the written profile holds no prompt text, tool output, request id, session id or project path", async () => {
	const agentDir = tempAgentDir("cache-profile-privacy-");
	try {
		writeSession(agentDir, "KESTREL-session-file.jsonl", [
			userEntry(T0 - SEC, "ZEBRA prompt 7731"),
			assistantEntry(T0, T0 + 10 * SEC, { input: 102_000, read: 0 }, { text: "IBEX answer 3318", responseId: "resp_QUOKKA_9912" }),
			toolResult(T0 + 20 * SEC),
			assistantEntry(T0 + 40 * SEC, T0 + 50 * SEC, { input: 2000, read: 100_000 }, { text: "IBEX answer 3319", responseId: "resp_QUOKKA_9913" }),
		], { id: "NARWHAL-session-4410", cwd: "/srv/someone/Code/PANGOLIN-secret-project", projectDir: "--srv-someone-Code-PANGOLIN-secret-project--" });
		const mod = await loadCacheProfileModule();
		const returned = await mod.buildCacheProfile?.({ agentDir, now: T0 + 3_600_000, minSamples: 20 });
		const file = path.join(agentDir, "cache-profile.json");
		// Controls: the builder ran and recorded this session's pair.
		assert.ok(fs.existsSync(file), "cache-profile.json was not written");
		const text = fs.readFileSync(file, "utf8");
		assert.ok(text.includes(KEY), "the profile does not name the model");
		assert.match(text, /"samples":\s*1\b/);
		for (const value of FORBIDDEN) {
			assert.ok(!text.includes(value), "the profile file leaks " + value);
			assert.ok(!JSON.stringify(returned).includes(value), "the returned profile leaks " + value);
		}
	} finally {
		await removeFixtureDir(agentDir);
	}
});
