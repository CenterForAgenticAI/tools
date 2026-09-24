import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	type EventBus,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
	CONTEXT_AWARE_HANDOFF_STATE_EVENT,
	discoverContextAwareServiceV1,
	type ContextAwareHandoffLifecycleEventV1,
} from "../context-service.js";
import contextAware from "../index.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "context-aware-session-isolation-"));
}

function captureEventBus(): { factory: ExtensionFactory; get: () => EventBus } {
	let events: EventBus | undefined;
	return {
		factory: (pi) => { events = pi.events; },
		get: () => {
			assert.ok(events, "the real extension runtime must expose its event bus");
			return events;
		},
	};
}

test("a shutdown in one in-memory session does not suppress another session's queued handoff in the same cwd", async () => {
	const cwd = tmpDir();
	const agentDir = path.join(cwd, "agent-state");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({
		provider: "session-isolation",
		models: [{ id: "deterministic", contextWindow: 200_000, maxTokens: 4_096 }],
		tokensPerSecond: Number.POSITIVE_INFINITY,
	});
	let releaseOrdinaryTurn: (() => void) | undefined;
	const ordinaryTurnBlocked = new Promise<void>((resolve) => {
		releaseOrdinaryTurn = resolve;
	});
	let providerEntered!: () => void;
	const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
	const providerRequests: string[] = [];
	faux.setResponses([
		async (context) => {
			providerRequests.push(JSON.stringify(context));
			providerEntered();
			await ordinaryTurnBlocked;
			return fauxAssistantMessage("The unaffected session completed its ordinary turn.");
		},
	]);

	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("session-isolation", "test-only");
	const aCapture = captureEventBus();
	const bCapture = captureEventBus();
	const createRuntime = async (capture: ReturnType<typeof captureEventBus>, sessionManager: SessionManager) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [contextAware, capture.factory],
				noExtensions: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	let runtimeA: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
	let sessionB: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const managerA = SessionManager.inMemory(cwd);
		runtimeA = await createAgentSessionRuntime(
			async ({ sessionManager }) => createRuntime(aCapture, sessionManager),
			{ cwd, agentDir, sessionManager: managerA },
		);
		await runtimeA.session.bindExtensions({});
		assert.equal(runtimeA.session.sessionFile, undefined, "session A must be an in-memory session without a transcript file");

		const managerB = SessionManager.inMemory(cwd);
		const bServices = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [contextAware, bCapture.factory],
				noExtensions: true,
			},
		});
		const bCreated = await createAgentSessionFromServices({
			services: bServices,
			sessionManager: managerB,
			model: faux.getModel(),
			noTools: "all",
		});
		sessionB = bCreated.session;
		await sessionB.bindExtensions({});
		assert.equal(sessionB.sessionFile, undefined, "session B must also be in-memory without a transcript file");
		assert.ok(managerA.getSessionId());
		assert.ok(managerB.getSessionId());
		assert.notEqual(managerA.getSessionId(), managerB.getSessionId(), "same-cwd sessions must retain distinct runtime identities");

		const bEvents = bCapture.get();
		const service = discoverContextAwareServiceV1(bEvents, "session-isolation-test");
		assert.ok(service, "the extension must register its service on session B's real event bus");
		const handoffLifecycle: ContextAwareHandoffLifecycleEventV1[] = [];
		let resolveTerminal!: () => void;
		const terminalHandoff = new Promise<void>((resolve) => { resolveTerminal = resolve; });
		const stopObservingHandoff = bEvents.on(CONTEXT_AWARE_HANDOFF_STATE_EVENT, (event) => {
			const lifecycle = event as ContextAwareHandoffLifecycleEventV1;
			handoffLifecycle.push(lifecycle);
			if (["completed", "failed", "cancelled"].includes(lifecycle.state)) resolveTerminal();
		});
		const ordinaryTurn = sessionB.prompt("Finish the unrelated session B turn.");
		let rejectProviderStart!: (error: Error) => void;
		const providerDidNotStart = new Promise<never>((_, reject) => { rejectProviderStart = reject; });
		const providerTimeout = setTimeout(() => rejectProviderStart(new Error("faux provider did not start")), 1_000);
		try {
			await Promise.race([
				providerStarted,
				providerDidNotStart,
				ordinaryTurn.then(() => { throw new Error("ordinary session B turn settled before the faux provider started"); }),
			]);
		} finally {
			clearTimeout(providerTimeout);
		}
		const queued = await service.requestHandoff({
			requestId: "isolated-handoff",
			purpose: "Prove session-local cancellation state",
			nextPhaseSeed: "Continue only in session B.",
			rewriteSeed: false,
			interactionMode: "non-interactive",
		});
		assert.equal(queued.status, "queued");
		assert.deepEqual(service.getSnapshot().compaction, { state: "queued", runId: queued.runId });

		await runtimeA.dispose();
		const afterAShutdown = service.getSnapshot().compaction;
		releaseOrdinaryTurn?.();
		await ordinaryTurn;
		await sessionB.waitForIdle();
		await Promise.race([
			terminalHandoff,
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("queued handoff did not reach a terminal state")), 1_000);
			}),
		]);

		assert.deepEqual(
			afterAShutdown,
			{ state: "queued", runId: queued.runId },
			`session A shutdown must not cancel session B's queued handoff before B settles; observed ${handoffLifecycle.map((event) => event.state).join(",")}`,
		);
		assert.equal(providerRequests.length, 1, "session B must run a real provider-backed AgentSession turn");
		assert.match(providerRequests[0]!, /Finish the unrelated session B turn\./);
		const lifecycleStates = handoffLifecycle.map((event) => event.state);
		assert.deepEqual(
			lifecycleStates.slice(0, 2),
			["queued", "running"],
			"session B must start its own handoff after its ordinary turn settles",
		);
		assert.equal(lifecycleStates.includes("cancelled"), false, "session A must not cancel session B's handoff");
		assert.match(
			lifecycleStates.at(-1) ?? "",
			/^(completed|failed)$/,
			"the isolated handoff must reach a terminal state (an in-memory transcript may be too small to compact)",
		);
		assert.deepEqual(service.getSnapshot().compaction, { state: "idle" });
		assert.equal(faux.state.callCount, 1, "only session B's deterministic ordinary provider turn is required");
		stopObservingHandoff();
	} finally {
		sessionB?.dispose();
		await runtimeA?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
