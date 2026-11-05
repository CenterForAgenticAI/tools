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
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";

import contextAware from "../src/index.js";
import { FOLD_ENTRY_TYPE } from "../src/folds/fold-entries.js";

// pi-context-aware#254, through the shipped extension: Pi starts a resumed session that has a
// billion-context-pi side file, and the extension (live mode: billion-context-pi is not loaded)
// writes the folds. Removing the registerAcpStartupImport call from src/index.ts fails these tests.
// The agent directory and every session live under a temp root; the real profile is never read.

function sideFile(ids: string[]): string {
	return JSON.stringify({
		schemaVersion: 1, producer: "billion-context-pi@0.1.83",
		blocks: [{
			blockId: "b1", runId: "r1", tier: 1, topic: "opening", summary: "LEGACY-B1 alpha and beta settled",
			directMessageIds: ids.slice(0, 4), effectiveMessageIds: ids.slice(0, 4), directBlockIds: [],
			compressedTokens: 40, createdAt: 1, survivedCount: 0, generation: "young", active: true, startRef: "m00001", endRef: "m00004",
		}],
		messageRefs: { byRaw: {}, byRef: {} }, nextBlockId: 2, nextRunId: 2,
	});
}

async function resume(sideText: (ids: string[]) => string, reopen = 1) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-acp-wiring-")));
	const agentDir = path.join(root, "agent");
	const sessions = path.join(root, "sessions");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), JSON.stringify({ summarizer: { enabled: false }, proactiveCompaction: { enabled: false }, contextCache: { enabled: false }, restartNotice: { enabled: false } }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const created = SessionManager.create(root, sessions);
		const ids: string[] = [];
		for (const name of ["ALPHA", "BETA", "GAMMA"]) {
			ids.push(created.appendMessage({ role: "user", content: name + "-QUESTION about " + name, timestamp: Date.now() }));
			ids.push(created.appendMessage(fauxAssistantMessage(name + "-ANSWER with details")));
		}
		const file = created.getSessionFile()!;
		fs.writeFileSync(file + ".acp.json", sideText(ids));
		const faux = fauxProvider({ provider: "acp-wiring", models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }], tokensPerSecond: Number.POSITIVE_INFINITY });
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.setRuntimeApiKey("acp-wiring", "test-only");
		const managers: SessionManager[] = [];
		for (let start = 0; start < reopen; start++) {
			const manager = SessionManager.open(file, sessions);
			managers.push(manager);
			const services = await createAgentSessionServices({
				cwd: root, agentDir, modelRuntime,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
				resourceLoaderOptions: { extensionFactories: [contextAware as ExtensionFactory], noExtensions: true },
			});
			const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
			await session.bindExtensions({});
			session.dispose();
		}
		const folds = SessionManager.open(file, sessions).getEntries().filter((entry) => entry.type === "context_edit" || (entry.type === "custom" && entry.customType === FOLD_ENTRY_TYPE)).length;
		const text = JSON.stringify(SessionManager.open(file, sessions).buildSessionContext().messages);
		const debug = fs.existsSync(path.join(agentDir, "context-aware-debug.log")) ? fs.readFileSync(path.join(agentDir, "context-aware-debug.log"), "utf8") : "";
		return { folds, text, debug, entries: SessionManager.open(file, sessions).getEntries().length };
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("#254: the extension imports a resumed session's side file at session_start, once across restarts", async () => {
	const once = await resume(sideFile, 1);
	assert.ok(once.folds > 0, "the folds were written to the session file");
	assert.match(once.text, /LEGACY-B1 alpha and beta settled/u);
	assert.doesNotMatch(once.text, /ALPHA-QUESTION|BETA-ANSWER/u);
	assert.match(once.text, /GAMMA-QUESTION/u);
	const thrice = await resume(sideFile, 3);
	assert.equal(thrice.entries, once.entries, "three starts write exactly what one start writes");
});

test("#254: a corrupt side file through the extension leaves the session unchanged and logs one failure", async () => {
	const baseline = await resume(() => "", 1);
	const corrupt = await resume(() => "{ not json", 2);
	assert.equal(corrupt.folds, 0);
	assert.equal(corrupt.entries, baseline.entries, "no entry is added");
	assert.equal(corrupt.debug.split("acp side-file import failed").length - 1, 2, "one failure per start, none per turn: " + corrupt.debug);
});
