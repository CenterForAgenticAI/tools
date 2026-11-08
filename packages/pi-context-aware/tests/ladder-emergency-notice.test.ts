import { removeFixtureDir } from "./fixture-cleanup.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";

import contextAware from "../src/index.js";
import { assistantToolCall } from "./provider-payloads.js";

// pi-context-aware#244, row 5: what the 95% step does is visible. The kernel truncates oversized
// messages in the request and, until now, said nothing. These tests run the real extension in a
// live-mode Pi session: the request the provider receives, the notice the user sees and the line
// in the debug log all come from one pass. The ladder is read from context-aware.json.

const WINDOW = 40_000;
const MARKER = "[truncated for context space]";

type Ladder = { foldNudgeStartFraction: number; foldNudgeEndFraction: number; seededCompactionFraction: number; recoverableHideFraction: number };
const LADDER: Ladder = { foldNudgeStartFraction: 0.45, foldNudgeEndFraction: 0.75, seededCompactionFraction: 0.9, recoverableHideFraction: 0.95 };

interface Run {
	readonly request: Context["messages"];
	readonly notices: readonly string[];
	readonly log: string;
}

const FLOOR_LADDER: Ladder = { foldNudgeStartFraction: 0.01, foldNudgeEndFraction: 0.01, seededCompactionFraction: 0.01, recoverableHideFraction: 0.01 };
const calibrations = new Map<string, Promise<{ perChar: number; base: number }>>();

/**
 * Tokens the request holds per character of bulk, and without any. A probe run under a ladder whose last
 * step is 1% logs the size the pass measured, twice, so the fixture is sized by the engine's own count.
 */
function calibrate(bulk: "old-tool-result" | "protected-tail"): Promise<{ perChar: number; base: number }> {
	const known = calibrations.get(bulk);
	if (known) return known;
	const probe = async (chars: number): Promise<number> => {
		const { log } = await run({ ladder: FLOOR_LADDER, bulk, chars });
		const match = /tokens=(\d+)\//u.exec(log);
		assert.ok(match, "the probe run logged the measured size: " + log);
		return Number(match[1]);
	};
	const made = (async () => {
		const small = 20_000, large = 60_000;
		const [a, b] = [await probe(small), await probe(large)];
		const perChar = (b - a) / (large - small);
		return { perChar, base: a - perChar * small };
	})();
	calibrations.set(bulk, made);
	return made;
}

/** A session whose request is about `fill` of the window, then one prompt. `bulk` puts the bulk where truncation can or cannot reach. */
async function runAt(options: { ladder: Ladder; bulk: "old-tool-result" | "protected-tail"; fill: number }): Promise<Run> {
	const { perChar, base } = await calibrate(options.bulk);
	return run({ ladder: options.ladder, bulk: options.bulk, chars: Math.round((options.fill * WINDOW - base) / perChar) });
}

async function run(options: { ladder: Ladder; bulk: "old-tool-result" | "protected-tail"; chars: number }): Promise<Run> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-ladder-emergency-")));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({
		summarizer: { enabled: false }, proactiveCompaction: { enabled: false }, contextCache: { enabled: false }, restartNotice: { enabled: false },
		sessionNaming: { scope: "off" }, workstream: { enabled: false }, pressureLadder: options.ladder,
	}));
	const previous = { agent: process.env.PI_CODING_AGENT_DIR, lineage: process.env.PI_FABRIC_LINEAGE, depth: process.env.PI_FABRIC_DEPTH };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_FABRIC_LINEAGE;
	delete process.env.PI_FABRIC_DEPTH;
	const faux = fauxProvider({ provider: "ladder-emergency", models: [{ id: "deterministic", contextWindow: WINDOW, maxTokens: 1_024 }], tokensPerSecond: Number.POSITIVE_INFINITY });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("ladder-emergency", "test-only");
	const manager = SessionManager.inMemory(cwd);
	const chars = options.chars;
	if (options.bulk === "old-tool-result") {
		manager.appendMessage({ role: "user", content: "Inspect the log.", timestamp: 1 });
		manager.appendMessage(assistantToolCall(1));
		manager.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "browser_screenshot", content: [{ type: "text", text: "HEAD\n" + "x".repeat(chars) + "\nTAIL" }], isError: false, timestamp: 2 });
		for (let i = 1; i <= 6; i++) manager.appendMessage(i % 2 ? fauxAssistantMessage("Short note " + i + ".") : { role: "user", content: "Short question " + i + ".", timestamp: 1 });
	} else {
		manager.appendMessage({ role: "user", content: "Start.", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Ready."));
		manager.appendMessage({ role: "user", content: "Large paste. " + "y".repeat(chars), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Read it."));
	}
	const notices: string[] = [];
	const services = await createAgentSessionServices({
		cwd, agentDir, modelRuntime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: [contextAware as ExtensionFactory], noExtensions: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	await session.bindExtensions({ uiContext: { ...session.extensionRunner.createContext().ui, notify: (message: string) => { notices.push(message); } } });
	let request: Context["messages"] = [];
	faux.setResponses([(context) => { request = structuredClone(context.messages); return fauxAssistantMessage("Done."); }]);
	try {
		await session.prompt("Go on.");
		await session.waitForIdle();
		const logFile = path.join(agentDir, "context-aware-debug.log");
		return { request, notices, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "" };
	} finally {
		session.dispose();
		if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
		if (previous.lineage === undefined) delete process.env.PI_FABRIC_LINEAGE; else process.env.PI_FABRIC_LINEAGE = previous.lineage;
		if (previous.depth === undefined) delete process.env.PI_FABRIC_DEPTH; else process.env.PI_FABRIC_DEPTH = previous.depth;
		await removeFixtureDir(cwd);
	}
}

const sentMarker = (result: Run): boolean => JSON.stringify(result.request).includes(MARKER);
const emergencyNotices = (result: Run): string[] => result.notices.filter((notice) => notice.includes("[context-aware]") && /truncation|Emergency/u.test(notice));

test("past the ladder's last step the request is truncated, the user is told, and the log says so", async () => {
	const result = await runAt({ ladder: LADDER, bulk: "old-tool-result", fill: 0.97 });
	assert.equal(sentMarker(result), true, "the old tool output was shortened in the request");
	const notices = emergencyNotices(result);
	assert.equal(notices.length, 1, JSON.stringify(result.notices));
	assert.match(notices[0]!, /Emergency truncation shortened 1 large message\(s\)/u);
	assert.match(notices[0]!, /past the pressure ladder's last step \(95%\)/u);
	assert.match(notices[0]!, /session file keeps the originals/u);
	assert.match(result.log, /fold pass: emergency truncation usage=\d+% threshold=95% tokens=\d+\/40000 truncated=1/u);
});

test("the ladder in config moves the 95% step: raised to 100% the same request is neither truncated nor announced", async () => {
	const result = await runAt({ ladder: { ...LADDER, recoverableHideFraction: 1 }, bulk: "old-tool-result", fill: 0.97 });
	assert.equal(sentMarker(result), false, "97% is under a last step of 100%");
	assert.deepEqual(emergencyNotices(result), []);
	assert.doesNotMatch(result.log, /emergency truncation/u);
});

test("the ladder in config moves the 95% step: lowered to 80% a request at 85% is truncated and announced", async () => {
	const lowered: Ladder = { foldNudgeStartFraction: 0.3, foldNudgeEndFraction: 0.5, seededCompactionFraction: 0.6, recoverableHideFraction: 0.8 };
	const result = await runAt({ ladder: lowered, bulk: "old-tool-result", fill: 0.85 });
	assert.equal(sentMarker(result), true);
	assert.match(emergencyNotices(result)[0] ?? "", /\(80%\)/u);
	assert.equal(sentMarker(await runAt({ ladder: LADDER, bulk: "old-tool-result", fill: 0.85 })), false, "and the default ladder leaves 85% alone");
});

test("when truncation can reclaim nothing, the user is told that too, with the log line", async () => {
	const result = await runAt({ ladder: LADDER, bulk: "protected-tail", fill: 0.97 });
	assert.equal(sentMarker(result), false, "everything large sits in the protected tail");
	const notices = emergencyNotices(result);
	assert.equal(notices.length, 1, JSON.stringify(result.notices));
	assert.match(notices[0]!, /Emergency truncation ran and reclaimed nothing: emergency-truncate ran at \d+% usage but found no truncatable content/u);
	assert.match(result.log, /fold pass: emergency truncation usage=\d+% threshold=95% .*truncated=0 skipped="emergency-truncate ran/u);
});

test("below the last step nothing is announced", async () => {
	const result = await runAt({ ladder: LADDER, bulk: "old-tool-result", fill: 0.6 });
	assert.equal(sentMarker(result), false);
	assert.deepEqual(emergencyNotices(result), []);
});
