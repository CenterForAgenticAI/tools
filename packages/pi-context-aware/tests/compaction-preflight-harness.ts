import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createEventBus,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionFactory,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";

import { discoverContextAwareServiceV1, type ContextAwareServiceV1 } from "../src/context-service.js";
import { FakeFabric } from "./compaction-owner-harness.js";

// A real Pi agent session running context-aware, for the
// compaction preflight tests: each refusal the preflight gives
// must match what Pi's own AgentSession.compact() then does with the same
// session, and a session Pi compacts must still reach Pi's compaction.

const PROVIDER = "compaction-preflight-session";
export const SEED = "Continue with the migration checklist.";
/** Pi's own refusal, thrown by AgentSession.compact(). */
export const NOTHING_TO_COMPACT = /^Nothing to compact \(session too small\)$/u;

export interface Harness {
	readonly session: AgentSession;
	readonly faux: FauxProviderHandle;
	readonly events: AgentSessionEvent[];
	readonly notifications: string[];
	/** What Pi prepared for each compaction it would have run; a probe then cancels it. */
	readonly preparations: SessionBeforeCompactEvent["preparation"][];
	readonly service: ContextAwareServiceV1;
	/** Fabric's side of the compaction owner claim, when the session enables the claim. */
	readonly fabric: FakeFabric | undefined;
}

export interface SessionOptions {
	/** Enable the compaction owner claim and stand in Fabric on the session's event bus. */
	readonly ownerClaim?: boolean;
}

let loadCounter = 0;

export async function withSession(
	history: (manager: SessionManager) => void,
	responses: FauxResponseStep[],
	body: (harness: Harness) => Promise<void>,
	options: SessionOptions = {},
): Promise<void> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-preflight-session-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "context-aware.json"), `${JSON.stringify({
		seedRewrite: false,
		contextCache: { enabled: false },
		sessionNaming: { scope: "off" },
		workstream: { enabled: false },
		proactiveCompaction: { enabled: false },
		...(options.ownerClaim ? { compactionClaim: { enabled: true } } : {}),
	})}\n`);
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const faux = fauxProvider({
		provider: PROVIDER,
		models: [{ id: "deterministic", contextWindow: 200_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	faux.setResponses(responses);
	const preparations: SessionBeforeCompactEvent["preparation"][] = [];
	// Loaded before context-aware, so it sees Pi's preparation first and its
	// cancel ends the compaction before any summary request.
	const probe: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => {
			preparations.push(event.preparation);
			return { cancel: true };
		});
	};
	const contextAware: ExtensionFactory = async (pi) => {
		const extension = await import(`../src/index.js?compaction-preflight-session=${Date.now()}-${++loadCounter}`);
		extension.default(pi);
	};
	const eventBus = createEventBus();
	// Listening before session_start, where context-aware makes its claim.
	const fabric = options.ownerClaim ? new FakeFabric(eventBus) : undefined;
	let session: AgentSession | undefined;
	try {
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.setRuntimeApiKey(PROVIDER, "test-only");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			// Pi's own threshold compaction stays off; every compaction here is requested.
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: { eventBus, extensionFactories: [probe, contextAware], noExtensions: true },
		});
		const sessionManager = SessionManager.inMemory(cwd);
		history(sessionManager);
		session = (await createAgentSessionFromServices({ services, sessionManager, model: faux.getModel() })).session;
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => { events.push(event); });
		const notifications: string[] = [];
		await session.bindExtensions({
			uiContext: { ...session.extensionRunner.createContext().ui, notify: (message) => { notifications.push(message); } },
		});
		await fabric?.flush();
		const service = discoverContextAwareServiceV1(eventBus, "compaction-preflight-session");
		assert.ok(service, "context-aware publishes its service at session_start");
		await body({ session, faux, events, notifications, preparations, service, fabric });
	} finally {
		session?.dispose();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** One short exchange: far below Pi's default keepRecentTokens (20,000). */
export function smallHistory(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "Start the migration.", timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Started."));
}

/** Three turns of about 10,000 tokens: Pi compacts this under the default keepRecentTokens. */
export function largeHistory(manager: SessionManager): void {
	for (let turn = 0; turn < 3; turn++) {
		manager.appendMessage({ role: "user", content: "u".repeat(20_000), timestamp: turn });
		manager.appendMessage(fauxAssistantMessage("a".repeat(20_000)));
	}
}

export function compactionStarts(events: readonly AgentSessionEvent[]): number {
	return events.filter((event) => event.type === "compaction_start").length;
}

export async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Lets agent_settled handlers run, where a queued compaction would start. */
export async function settle(session: AgentSession): Promise<void> {
	await session.waitForIdle();
	await new Promise((resolve) => setTimeout(resolve, 50));
}
