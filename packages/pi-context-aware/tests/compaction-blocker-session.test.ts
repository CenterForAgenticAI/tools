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
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// End to end through a real Pi agent session. The stub stands in for
// billion-context-pi: it registers the same tool pair and cancels every
// compaction. Pi itself must then stop declaring compact_session to the model.

const billionContextStub: ExtensionFactory = (pi) => {
	for (const name of ["compress", "acp_status"]) {
		pi.registerTool({
			name,
			label: name,
			description: `Stub of billion-context-pi's ${name}.`,
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "stub" }], details: {} };
			},
		});
	}
	pi.on("session_before_compact", () => ({ cancel: true }));
};

async function startSession(withBlocker: boolean): Promise<{ activeTools: string[]; systemPrompt: string }> {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-compaction-blocker-")));
	const faux = fauxProvider({
		provider: "compaction-blocker",
		models: [{ id: "deterministic", contextWindow: 64_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("compaction-blocker", "test-only");
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?compaction-blocker-session=${Date.now()}`);
		extension.default(pi);
	};
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: path.join(cwd, "agent"),
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: {
				extensionFactories: withBlocker ? [contextAware, billionContextStub] : [contextAware],
				noExtensions: true,
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			model: faux.getModel(),
		});
		session = created.session;
		await session.bindExtensions({});
		return { activeTools: session.getActiveToolNames(), systemPrompt: session.systemPrompt };
	} finally {
		session?.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

test("a real Pi session stops declaring compact_session when an extension cancels every compaction", async () => {
	const blocked = await startSession(true);
	assert.ok(blocked.activeTools.includes("compress"), JSON.stringify(blocked.activeTools));
	assert.ok(!blocked.activeTools.includes("compact_session"), JSON.stringify(blocked.activeTools));
	assert.doesNotMatch(blocked.systemPrompt, /compact_session/u);

	const unblocked = await startSession(false);
	assert.ok(unblocked.activeTools.includes("compact_session"), JSON.stringify(unblocked.activeTools));
});
