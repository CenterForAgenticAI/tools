import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { planFold } from "../../../src/folds/fold-adapter.js";
import { applyFoldDrafts } from "../../../src/folds/fold-engine.js";
import type { Config } from "../../../src/folds/kernel/index.js";

export const SAFETY_CONFIG: Partial<Config> = {
	compress: { minCompressRange: 0, maxSummaryLength: 20_000, minSummaryLength: 10 },
	preserveRecentMessages: 2,
	preserveRecentTokens: 0,
};
export const OPENING_SUMMARY = "SAFETY-OPENING: alpha was accepted and beta remains read-only.";

export function safetyRoot(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-safety-")));
}

export function user(manager: SessionManager, content: string): string {
	return manager.appendMessage({ role: "user", content, timestamp: 1 });
}

export function assistant(manager: SessionManager, content: string): string {
	return manager.appendMessage(fauxAssistantMessage(content, { timestamp: 1 }));
}

/** Fixed replay: four foldable opening messages, followed by four recent ones. */
export function seedOpening(manager: SessionManager): string[] {
	return [
		user(manager, "SAFETY-ALPHA-QUESTION"), assistant(manager, "SAFETY-ALPHA-ANSWER"),
		user(manager, "SAFETY-BETA-QUESTION"), assistant(manager, "SAFETY-BETA-ANSWER"),
		user(manager, "SAFETY-TAIL-ONE"), assistant(manager, "SAFETY-TAIL-ONE-ANSWER"),
		user(manager, "SAFETY-TAIL-TWO"), assistant(manager, "SAFETY-TAIL-TWO-ANSWER"),
	];
}

export function fold(manager: SessionManager, startRef = "m00001", endRef = "m00004", summary = OPENING_SUMMARY): void {
	const plan = planFold({ branch: manager.getBranch(), contextEntries: manager.buildContextEntries(),
		startRef, endRef, summary, modelContextLimit: 64_000, config: SAFETY_CONFIG });
	assert.ok(plan.ok, JSON.stringify(plan));
	applyFoldDrafts(manager, plan.drafts);
}

/** Offline provider capture through a real Pi session, with no resource discovery. */
export async function safetySession(root: string, manager: SessionManager, extensions: ExtensionFactory[] = []) {
	const faux = fauxProvider({ provider: "safety", models: [{ id: "fixed", contextWindow: 64_000, maxTokens: 4096 }], tokensPerSecond: Infinity });
	const requests: Message[][] = [];
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("safety", "synthetic-only");
	const services = await createAgentSessionServices({ cwd: root, agentDir: path.join(root, "agent"), modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		resourceLoaderOptions: { extensionFactories: extensions, noExtensions: true } });
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: faux.getModel() });
	await session.bindExtensions({});
	return {
		session, requests,
		async prompt(text: string, replies = [fauxAssistantMessage("SAFETY-DONE", { timestamp: 1 })]) {
			faux.setResponses(replies.map((reply) => (context) => {
				requests.push(structuredClone(context.messages));
				return reply;
			}));
			await session.prompt(text);
			await session.waitForIdle();
			assert.equal(faux.getPendingResponseCount(), 0, "the fixed replay must consume every response");
		},
	};
}

export function requestText(messages: readonly Message[]): string {
	return JSON.stringify(messages);
}

/** SDK-generated message times are not part of the restart request contract. */
export function withoutTimestamps(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === "timestamp" ? undefined : item)) as unknown;
}
