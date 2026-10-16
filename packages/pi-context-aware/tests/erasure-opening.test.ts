import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type EventBus } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { discoverContextAwareServiceV1 } from "../src/context-service.js";
import { eraseSession } from "../src/erasure/session-erasure.js";
import { paritySessionFile } from "../src/parity/records.js";

// Real SDK managers and extension dispatch; no model/network required. The second
// runtime has loaded its manager, but has not registered its opening lease yet.
test("erasure wins before second runtime activation: shutdown and input block prevent resurrection", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-opening-"));
	const savedAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		const directory = path.join(root, "sessions", "project");
		fs.mkdirSync(directory, { recursive: true });
		const file = path.join(directory, "gone.jsonl");
		fs.writeFileSync(file, [
			{ type: "session", version: 3, id: "gone", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
			{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", thinkingLevel: "off" },
			{ type: "message", id: "user", parentId: "thinking", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Opening evidence", timestamp: 1 } },
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const secondManager = SessionManager.open(file, directory);
		fs.writeFileSync(`${file}.acp.json`, "{}");
		const parity = paritySessionFile(root, "gone");
		fs.mkdirSync(path.dirname(parity), { recursive: true });
		fs.writeFileSync(parity, "PARITY");
		assert.equal((await eraseSession({ agentDir: root, sessionId: "gone", currentSessionId: "other", sessions: [{ id: "gone", path: file }], confirm: async () => true })).status, "complete");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, packages: [] });
		let bus: EventBus | undefined;
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [(pi) => { bus = pi.events; extension(pi); }] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: secondManager, settingsManager, resourceLoader: loader, tools: [] });
		let shutdowns = 0;
		const errors: string[] = [];
		try {
			await session.bindExtensions({ shutdownHandler: () => { shutdowns++; }, onError: (error) => errors.push(error.error) });
			assert.equal(shutdowns, 1);
			assert.ok(bus);
			assert.equal(discoverContextAwareServiceV1(bus, "refused-runtime"), undefined);
			// Even a host whose shutdown callback only records a request cannot run a turn.
			await session.prompt("Must not persist this turn");
			assert.deepEqual(errors, []);
			for (const candidate of [file, `${file}.acp.json`, parity]) assert.equal(fs.existsSync(candidate), false, candidate);
		} finally { session.dispose(); }
	} finally {
		if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgent;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
