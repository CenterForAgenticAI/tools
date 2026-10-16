import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import extension from "../src/index.js";
import { eraseSession } from "../src/erasure/session-erasure.js";

async function refusedRuntime() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "erasure-refused-sdk-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const directory = path.join(root, "sessions", "project");
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(directory, "gone.jsonl");
	fs.writeFileSync(file, [
		{ type: "session", version: 3, id: "gone", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
		{ type: "thinking_level_change", id: "thinking", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", thinkingLevel: "off" },
		{ type: "message", id: "user", parentId: "thinking", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Old private text", timestamp: 1 } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const manager = SessionManager.open(file, directory);
	assert.equal((await eraseSession({ agentDir: root, sessionId: "gone", currentSessionId: "other", sessions: [{ id: "gone", path: file }], confirm: async () => true })).status, "complete");
	const faux = fauxProvider({ provider: "erasure-test", models: [{ id: "offline" }], tokensPerSecond: Number.POSITIVE_INFINITY });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("session_tasks", { action: "add", title: "Resurrected task" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Private assistant reply"),
	]);
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("erasure-test", "test-only");
	let intruder: ExtensionAPI | undefined;
	const services = await createAgentSessionServices({
		cwd: root, agentDir: root, modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, (pi) => {
			intruder = pi;
		}] },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	let shutdowns = 0;
	await session.bindExtensions({ shutdownHandler: () => { shutdowns++; } });
	assert.equal(shutdowns, 1);
	return { session, manager, file, intruder: intruder!,
		cleanup: () => { session.dispose(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); } };
}

test("real SDK refuses focus edit and tasks add dispatched before input", async () => {
	const r = await refusedRuntime();
	try {
		await r.session.prompt("/focus edit Resurrected focus");
		await r.session.prompt("/tasks add Resurrected task");
		assert.equal(fs.existsSync(r.file), false);
		assert.equal(r.manager.getEntries().filter((entry) => entry.type === "custom").length, 0);
	} finally { r.cleanup(); }
});

test("another extension's custom-message turn is aborted, but SDK still persists its abort-error assistant", async () => {
	const r = await refusedRuntime();
	try {
		// sendMessage is the extension API for AgentSession.sendCustomMessage.
		r.intruder.sendMessage({ customType: "intruder", content: "External trigger", display: false }, { triggerTurn: true });
		await r.session.waitForIdle();
		const entries = r.manager.getEntries();
		const assistants = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		assert.equal(assistants.length, 1);
		const reply = (assistants[0] as { message: { stopReason: string; errorMessage?: string } }).message;
		// The faux provider represents AbortError as an assistant error event.
		assert.equal(reply.stopReason, "error", JSON.stringify(assistants));
		assert.equal(reply.errorMessage, "This operation was aborted");
		assert.equal(entries.some((entry) => entry.type === "custom"), false, "no tasks, naming or fold state");
		assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"), false);
		const disk = fs.readFileSync(r.file, "utf8");
		assert.match(disk, /"errorMessage":"This operation was aborted"/u);
		assert.doesNotMatch(disk, /Resurrected task|Private assistant reply|context-aware.tasks|context-aware.naming/u);
	} finally { r.cleanup(); }
});
