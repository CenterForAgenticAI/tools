import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";

import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionActions,
	type ExtensionContextActions,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";

const CWD = path.resolve(import.meta.dirname, "..");
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_ADAPTIVE_THINKING_POLICY = process.env.PI_ADAPTIVE_THINKING_POLICY;
const ISOLATED_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-thinking-config-"));
process.env.HOME = ISOLATED_CONFIG_HOME;
const { default: adaptiveThinkingExtension } = await import("../index.js");
beforeEach(() => {
	delete process.env.PI_ADAPTIVE_THINKING_POLICY;
});
after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_ADAPTIVE_THINKING_POLICY === undefined) delete process.env.PI_ADAPTIVE_THINKING_POLICY;
	else process.env.PI_ADAPTIVE_THINKING_POLICY = ORIGINAL_ADAPTIVE_THINKING_POLICY;
	fs.rmSync(ISOLATED_CONFIG_HOME, { recursive: true, force: true });
});

function model(id: string, forceAdaptiveThinking = false): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "test",
		baseUrl: "http://unused.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
		compat: forceAdaptiveThinking ? { forceAdaptiveThinking: true } : {},
	};
}

interface RuntimeHarness {
	runner: ExtensionRunner;
	getLevel(): string;
	setLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void;
	setModel(model: Model<"anthropic-messages"> | undefined): void;
	shutdowns(): number;
	aborts(): number;
}

async function createRuntimeHarness(options: {
	entries?: Array<{ customType: string; data?: unknown }>;
	level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	model?: Model<"anthropic-messages">;
} = {}): Promise<RuntimeHarness> {
	const eventBus = createEventBus();
	const agentDir = path.join(process.env.HOME ?? CWD, ".pi", "agent");
	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir,
		eventBus,
		extensionFactories: [{ name: "adaptive-thinking-under-test", factory: adaptiveThinkingExtension }],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const loaded = resourceLoader.getExtensions();
	assert.deepEqual(loaded.errors, []);

	const sessionManager = SessionManager.inMemory(CWD);
	for (const entry of options.entries ?? []) {
		sessionManager.appendCustomEntry(entry.customType, entry.data);
	}

	let thinkingLevel = options.level ?? "medium";
	let currentModel = options.model;
	let shutdownCount = 0;
	let abortCount = 0;

	const actions: ExtensionActions = {
		sendMessage() {},
		sendUserMessage() {},
		appendEntry(customType, data) {
			sessionManager.appendCustomEntry(customType, data);
		},
		setSessionName() {},
		getSessionName() {
			return undefined;
		},
		setLabel() {},
		getActiveTools() {
			return [];
		},
		getAllTools() {
			return [];
		},
		setActiveTools() {},
		refreshTools() {},
		getCommands() {
			return [];
		},
		async setModel() {
			return true;
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
		},
	};
	const contextActions: ExtensionContextActions = {
		getModel: () => currentModel,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort() {
			abortCount++;
		},
		hasPendingMessages: () => false,
		shutdown() {
			shutdownCount++;
		},
		getContextUsage: () => undefined,
		compact() {},
		getSystemPrompt: () => "base",
	};

	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const modelRegistry = new ModelRegistry(modelRuntime);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, CWD, sessionManager, modelRegistry);
	runner.bindCore(actions, contextActions);

	return {
		runner,
		getLevel: () => thinkingLevel,
		setLevel(level) {
			thinkingLevel = level;
		},
		setModel(next) {
			currentModel = next;
		},
		shutdowns: () => shutdownCount,
		aborts: () => abortCount,
	};
}

function isolateHome(t: { after(callback: () => void): void }): void {
	const previousHome = process.env.HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-thinking-runtime-"));
	process.env.HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	});
}

function useOffOnlyConfig(t: { after(callback: () => void): void }): void {
	const configFile = path.join(ISOLATED_CONFIG_HOME, ".pi", "agent", "adaptive-thinking.json");
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, `${JSON.stringify({ baseline: "off", enabled: true, minLevel: "off", maxLevel: "off" })}\n`);
	t.after(() => fs.rmSync(configFile, { force: true }));
}

function fakeAssistantMessage(
	requestModel: Model<"anthropic-messages">,
	aborted: boolean,
): AssistantMessage {
	return {
		role: "assistant",
		content: aborted ? [] : [{ type: "text", text: "fake response" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "stop",
		...(aborted ? { errorMessage: "Request was aborted before fake transport" } : {}),
		timestamp: Date.now(),
	};
}

function fakeStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

interface AgentSessionRuntimeHarness {
	session: AgentSession;
	providerDispatches(): number;
	transportRequests(): number;
	abortedProviderDispatches(): number;
	lateMutations(): number;
	abortCalls(): number;
	shutdowns(): number;
}

async function createAgentSessionRuntimeHarness(options: {
	entries?: Array<{ customType: string; data?: unknown }>;
	level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	model: Model<"anthropic-messages">;
	lateModel?: Model<"anthropic-messages">;
	lateLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	driftBeforeAdaptive?: boolean;
}): Promise<AgentSessionRuntimeHarness> {
	const eventBus = createEventBus();
	const agentDir = path.join(process.env.HOME ?? CWD, ".pi", "agent");
	const sessionRef: { current?: AgentSession } = {};
	let providerDispatchCount = 0;
	let transportRequestCount = 0;
	let abortedProviderDispatchCount = 0;
	let lateMutationCount = 0;
	let abortCallCount = 0;
	let shutdownCount = 0;

	const extensionFactories: InlineExtension[] = [];
	if (options.lateModel) {
		const lateModel = options.lateModel;
		const lateLevel = options.lateLevel ?? "minimal";
		const driftExtension: InlineExtension = {
			name: "late-runtime-drift-under-test",
			factory(pi) {
				pi.on("before_agent_start", () => {
					assert.ok(sessionRef.current, "AgentSession must exist before before_agent_start");
					// Simulate a model/keybind transition after adaptive-thinking's
					// ordinary pre-run validation but before provider transport.
					sessionRef.current.agent.state.model = lateModel;
					sessionRef.current.agent.state.thinkingLevel = lateLevel;
					lateMutationCount++;
				});
			},
		};
		if (options.driftBeforeAdaptive) extensionFactories.push(driftExtension);
	}
	extensionFactories.push({ name: "adaptive-thinking-under-test", factory: adaptiveThinkingExtension });
	if (options.lateModel && !options.driftBeforeAdaptive) {
		const lateModel = options.lateModel;
		const lateLevel = options.lateLevel ?? "minimal";
		extensionFactories.push({
			name: "late-runtime-drift-under-test",
			factory(pi) {
				pi.on("before_agent_start", () => {
					assert.ok(sessionRef.current, "AgentSession must exist before before_agent_start");
					sessionRef.current.agent.state.model = lateModel;
					sessionRef.current.agent.state.thinkingLevel = lateLevel;
					lateMutationCount++;
				});
			},
		});
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd: CWD,
		agentDir,
		eventBus,
		extensionFactories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);

	const sessionManager = SessionManager.inMemory(CWD);
	for (const entry of options.entries ?? []) {
		sessionManager.appendCustomEntry(entry.customType, entry.data);
	}
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const providerModels = [options.model, ...(options.lateModel ? [options.lateModel] : [])];
	modelRuntime.registerProvider("test", {
		baseUrl: "http://fake-provider.invalid",
		apiKey: "sk-fake-test",
		api: "anthropic-messages",
		streamSimple: ((requestModel: Model<"anthropic-messages">, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
			providerDispatchCount++;
			const aborted = streamOptions?.signal?.aborted === true;
			if (aborted) abortedProviderDispatchCount++;
			else transportRequestCount++;
			return fakeStream(fakeAssistantMessage(requestModel, aborted));
		}) as never,
		models: providerModels.map((providerModel) => ({
			id: providerModel.id,
			name: providerModel.name,
			api: providerModel.api,
			reasoning: providerModel.reasoning,
			input: providerModel.input,
			cost: providerModel.cost,
			contextWindow: providerModel.contextWindow,
			maxTokens: providerModel.maxTokens,
			compat: providerModel.compat,
		})),
	});

	const created = await createAgentSession({
		cwd: CWD,
		agentDir,
		modelRuntime,
		model: options.model,
		thinkingLevel: options.level ?? "medium",
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
		noTools: "all",
	});
	sessionRef.current = created.session;
	const originalAbort = sessionRef.current.agent.abort.bind(sessionRef.current.agent);
	sessionRef.current.agent.abort = () => {
		abortCallCount++;
		originalAbort();
	};
	await sessionRef.current.bindExtensions({
		shutdownHandler() {
			shutdownCount++;
		},
	});

	return {
		session: sessionRef.current,
		providerDispatches: () => providerDispatchCount,
		transportRequests: () => transportRequestCount,
		abortedProviderDispatches: () => abortedProviderDispatchCount,
		lateMutations: () => lateMutationCount,
		abortCalls: () => abortCallCount,
		shutdowns: () => shutdownCount,
	};
}

test("real AgentSession prompt never invokes a provider after malformed bounded startup", async (t) => {
	isolateHome(t);
	const harness = await createAgentSessionRuntimeHarness({
		model: model("malformed-startup-model"),
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "malformed-agent-session",
					agentName: "worker",
					minLevel: "xhigh",
					maxLevel: "low",
				},
			},
		],
	});
	t.after(() => harness.session.dispose());

	await harness.session.prompt("must be handled before an agent run", { source: "rpc" });

	assert.equal(harness.providerDispatches(), 0);
	assert.equal(harness.transportRequests(), 0);
	assert.equal(harness.shutdowns(), 1);
});

test("real AgentSession aborts late incompatibility before fake provider transport", async (t) => {
	isolateHome(t);
	useOffOnlyConfig(t);
	const harness = await createAgentSessionRuntimeHarness({
		level: "off",
		model: model("supports-off"),
		lateModel: model("late-force-adaptive", true),
		lateLevel: "minimal",
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "provider-adjacent-abort",
					agentName: "worker",
					baseline: "off",
					minLevel: "off",
					maxLevel: "off",
				},
			},
		],
	});
	t.after(() => harness.session.dispose());

	await harness.session.prompt("mutate only after ordinary pre-run validation", { source: "rpc" });

	assert.equal(harness.lateMutations(), 1, "the late drift seam must execute");
	assert.equal(harness.providerDispatches(), 1, "the fake provider observes the already-aborted signal");
	assert.equal(harness.abortedProviderDispatches(), 1);
	assert.equal(harness.transportRequests(), 0, "no outbound transport may start after the final gate aborts");
	assert.equal(harness.shutdowns(), 1);
});

test("real AgentSession aborts ordinary-session capability drift before fake provider transport", async (t) => {
	isolateHome(t);
	const lateModel = {
		...model("late-sparse-ordinary"),
		thinkingLevelMap: { medium: null, low: "low" },
	};
	const harness = await createAgentSessionRuntimeHarness({
		level: "medium",
		model: model("ordinary-start-model"),
		lateModel,
		lateLevel: "medium",
	});
	t.after(() => harness.session.dispose());

	await harness.session.prompt("detect ordinary-session capability drift at the provider gate", { source: "rpc" });

	assert.equal(harness.lateMutations(), 1);
	assert.equal(harness.providerDispatches(), 1, "the fake provider observes the already-aborted signal");
	assert.equal(harness.abortedProviderDispatches(), 1);
	assert.equal(harness.transportRequests(), 0, "unsupported ordinary-session levels must not reach transport");
	assert.equal(harness.shutdowns(), 1);
});

test("real AgentSession re-aborts an early incompatibility after the run controller exists", async (t) => {
	isolateHome(t);
	useOffOnlyConfig(t);
	const harness = await createAgentSessionRuntimeHarness({
		level: "off",
		model: model("supports-off-before-early-drift"),
		lateModel: model("early-force-adaptive", true),
		lateLevel: "minimal",
		driftBeforeAdaptive: true,
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "repeat-provider-adjacent-abort",
					agentName: "worker",
					baseline: "off",
					minLevel: "off",
					maxLevel: "off",
				},
			},
		],
	});
	t.after(() => harness.session.dispose());

	await harness.session.prompt("detect before run setup, then re-abort at the provider gate", { source: "rpc" });

	assert.equal(harness.lateMutations(), 1, "the earlier drift handler must precede adaptive validation");
	assert.equal(harness.abortCalls(), 2, "both the pre-run and provider-adjacent gates must call abort");
	assert.equal(harness.providerDispatches(), 1, "the fake provider may observe the already-aborted signal");
	assert.equal(harness.abortedProviderDispatches(), 1);
	assert.equal(harness.transportRequests(), 0, "re-aborting the active run must prevent outbound transport");
	assert.equal(harness.shutdowns(), 1, "shutdown is requested only for the first fatal detection");
});

test("real Pi runner blocks input after malformed persisted bounded policy", async (t) => {
	isolateHome(t);
	const harness = await createRuntimeHarness({
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "malformed",
					agentName: "worker",
					minLevel: "xhigh",
					maxLevel: "low",
				},
			},
		],
	});

	await harness.runner.emit({ type: "session_start", reason: "startup" });
	const input = await harness.runner.emitInput("must not reach a model", undefined, "rpc");

	assert.deepEqual(input, { action: "handled" });
	assert.equal(harness.aborts(), 1);
	assert.equal(harness.shutdowns(), 1);
});

test("real Pi runner blocks force-adaptive off-only startup before model input", async (t) => {
	isolateHome(t);
	const harness = await createRuntimeHarness({
		level: "off",
		model: model("claude-fable-5", true),
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "off-only-startup",
					agentName: "worker",
					baseline: "off",
					minLevel: "off",
					maxLevel: "off",
				},
			},
		],
	});

	await harness.runner.emit({ type: "session_start", reason: "startup" });
	const input = await harness.runner.emitInput("must not reach a model", undefined, "rpc");

	assert.deepEqual(input, { action: "handled" });
	assert.equal(harness.getLevel(), "off");
	assert.equal(harness.aborts(), 1);
	assert.equal(harness.shutdowns(), 1);
});

test("real Pi runner blocks a later force-adaptive model switch outside off-only bounds", async (t) => {
	isolateHome(t);
	const harness = await createRuntimeHarness({
		level: "off",
		model: model("supports-off"),
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "off-only-switch",
					agentName: "worker",
					baseline: "off",
					minLevel: "off",
					maxLevel: "off",
				},
			},
		],
	});
	await harness.runner.emit({ type: "session_start", reason: "startup" });

	harness.setModel(model("claude-fable-5", true));
	harness.setLevel("minimal");
	const input = await harness.runner.emitInput("must not reach a model", undefined, "rpc");

	assert.deepEqual(input, { action: "handled" });
	assert.equal(harness.getLevel(), "minimal", "the policy must not silently escape to a usable level");
	assert.equal(harness.aborts(), 1);
	assert.equal(harness.shutdowns(), 1);
});

test("real Pi runner blocks distinct max after an incompatible model switch", async (t) => {
	isolateHome(t);
	const harness = await createRuntimeHarness({
		level: "off",
		model: model("supports-off"),
		entries: [
			{
				customType: "pi-delegate-thinking-policy",
				data: {
					protocolVersion: 1,
					policyId: "off-only-max-switch",
					agentName: "worker",
					baseline: "off",
					minLevel: "off",
					maxLevel: "off",
				},
			},
		],
	});
	await harness.runner.emit({ type: "session_start", reason: "startup" });

	harness.setModel(model("claude-fable-5", true));
	harness.setLevel("max");
	const input = await harness.runner.emitInput("must not reach a model", undefined, "rpc");

	assert.deepEqual(input, { action: "handled" });
	assert.equal(harness.getLevel(), "max", "the policy must not silently map max to an unusable off level");
	assert.equal(harness.aborts(), 1);
	assert.equal(harness.shutdowns(), 1);
});
