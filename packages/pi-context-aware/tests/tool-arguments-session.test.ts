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
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";

// End to end through a real Pi agent session: the model sends session_tasks
// plan with tasks as a JSON string, as claude-sonnet-5-5 does. Pi runs the
// tool's prepareArguments hook, validates, and executes; the list must land.

test("a real Pi session executes a session_tasks plan whose tasks arrive as a JSON string", async () => {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-tool-arguments-")));
	const faux = fauxProvider({
		provider: "tool-arguments",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("session_tasks", { action: "plan", tasks: JSON.stringify([{ title: "alpha" }, { title: "beta", status: "active" }]) }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Planned."),
	]);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("tool-arguments", "test-only");
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?tool-arguments-session=${Date.now()}`);
		extension.default(pi);
	};
	const sessionManager = SessionManager.inMemory(cwd);
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: path.join(cwd, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: { extensionFactories: [contextAware], noExtensions: true },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() });
		session = created.session;
		await session.bindExtensions({});
		const results: Array<{ toolName: string; isError: boolean; text: string }> = [];
		session.subscribe((event) => {
			if (event.type !== "tool_execution_end") return;
			const content = (event.result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
			results.push({ toolName: event.toolName, isError: event.isError, text: content.map((part) => part.text ?? "").join("") });
		});
		await session.prompt("Plan alpha and beta.");
		await session.waitForIdle();

		assert.equal(results.length, 1, JSON.stringify(results));
		assert.equal(results[0]?.toolName, "session_tasks");
		assert.equal(results[0]?.isError, false, results[0]?.text);
		assert.match(results[0]!.text, /t1\s+alpha/u);
		assert.match(results[0]!.text, /t2\s+beta/u);
		const snapshots = sessionManager.getBranch().filter((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === "context-aware.tasks.v1");
		assert.equal(snapshots.length, 1, "the plan must be persisted to the transcript");
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
