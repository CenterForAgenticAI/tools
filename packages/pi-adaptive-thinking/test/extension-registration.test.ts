import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";
import {
  ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
  ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL,
  ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL,
  ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL,
  type AdaptiveThinkingSnapshotResponseV1,
  type AdaptiveThinkingSnapshotV1,
} from "../integration-seam.js";

const originalHome = process.env.HOME;
const originalAdaptiveThinkingPolicy = process.env.PI_ADAPTIVE_THINKING_POLICY;
const testHome = mkdtempSync(join(tmpdir(), "adaptive-thinking-home-"));
process.env.HOME = testHome;

const configFile = join(testHome, ".pi", "agent", "adaptive-thinking.json");
const { default: registerAdaptiveThinking } = await import(
  `${pathToFileURL(resolve("index.ts")).href}?testHome=${encodeURIComponent(testHome)}`
);

type Handler = (event: Record<string, unknown>, ctx: TestContext) => unknown | Promise<unknown>;
type Tool = {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: TestContext,
  ) => Promise<Record<string, unknown>>;
};
type Command = {
  description: string;
  handler: (args: string, ctx: TestContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
};
type Shortcut = {
  description?: string;
  handler: (ctx: TestContext) => unknown | Promise<unknown>;
};

type EventBus = {
  on: (channel: string, handler: (value: unknown) => void) => () => void;
  emit: (channel: string, value: unknown) => void;
};

interface TestContext {
  hasUI: boolean;
  model?: {
    provider: string;
    id: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
    compat?: { forceAdaptiveThinking?: boolean };
  };
  shutdown: () => void;
  abort: () => void;
  ui: {
    statuses: Map<string, string>;
    notifications: Array<{ message: string; kind: string }>;
    setStatus: (slot: string, value: string | undefined) => void;
    notify: (message: string, kind: string) => void;
  };
  sessionManager: {
    getEntries: () => Array<Record<string, unknown>>;
  };
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(testHome, ".pi", "agent"), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "w" });
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
}

function createHarness(options: {
  thinkingLevel?: string;
  model?: TestContext["model"];
  entries?: Array<Record<string, unknown>>;
  register?: typeof registerAdaptiveThinking;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
  const tools = new Map<string, Tool>();
  let activeTools: string[] = ["read", "bash"];
  const commands = new Map<string, Command>();
  const shortcuts = new Map<string, Shortcut>();
  const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const setThinkingLevels: string[] = [];
  let thinkingLevel = options.thinkingLevel ?? "medium";
  let shutdowns = 0;
  const emittedEvents: Array<{ channel: string; value: unknown }> = [];
  const statusUpdates: Array<{ slot: string; value: string | undefined }> = [];
  const events: EventBus = {
    on(channel, handler) {
      const listeners = eventHandlers.get(channel) ?? [];
      listeners.push(handler);
      eventHandlers.set(channel, listeners);
      return () => {
        const current = eventHandlers.get(channel) ?? [];
        eventHandlers.set(channel, current.filter((listener) => listener !== handler));
      };
    },
    emit(channel, value) {
      emittedEvents.push({ channel, value });
      for (const handler of eventHandlers.get(channel) ?? []) handler(value);
    },
  };

  const ctx: TestContext = {
    hasUI: true,
    model: options.model,
    shutdown() {
      shutdowns++;
    },
    abort() {},
    ui: {
      statuses: new Map(),
      notifications: [],
      setStatus(slot: string, value: string | undefined) {
        statusUpdates.push({ slot, value });
        if (value === undefined) {
          this.statuses.delete(slot);
          return;
        }
        this.statuses.set(slot, value);
      },
      notify(message: string, kind: string) {
        this.notifications.push({ message, kind });
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
    },
  };

  (options.register ?? registerAdaptiveThinking)({
    events,
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerShortcut(name: string, shortcut: Shortcut) {
      shortcuts.set(name, shortcut);
    },
    setThinkingLevel(level: string) {
      setThinkingLevels.push(level);
      thinkingLevel = level;
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    appendEntry(customType: string, data: Record<string, unknown>) {
      appended.push({ customType, data });
    },
  } as never);

  return {
    ctx,
    tools,
    get activeTools() {
      return activeTools;
    },
    commands,
    shortcuts,
    appended,
    setThinkingLevels,
    events,
    emittedEvents,
    statusUpdates,
    get thinkingLevel() {
      return thinkingLevel;
    },
    get shutdowns() {
      return shutdowns;
    },
    setActiveToolsExternally(names: string[]) {
      activeTools = [...names];
    },
    setRawThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    async emit(name: string, event: Record<string, unknown> = {}) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
  };
}

async function executeSetThinkingEffort(
  harness: ReturnType<typeof createHarness>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = harness.tools.get("set_thinking_effort");
  assert.ok(tool, "set_thinking_effort tool should be registered");
  return tool.execute("tool-call-1", params, new AbortController().signal, () => {}, harness.ctx);
}

function advertisingOptions(): Record<string, unknown> {
  // The shape Pi passes to buildSystemPrompt for a generated prompt that lists
  // set_thinking_effort under "Available tools".
  return { selectedTools: ["read", "bash", "set_thinking_effort"], toolSnippets: { set_thinking_effort: "Adjust thinking effort dynamically" } };
}

function requestSnapshot(harness: ReturnType<typeof createHarness>): AdaptiveThinkingSnapshotV1 {
  const requestId = `test-request-${harness.emittedEvents.length}`;
  let response: AdaptiveThinkingSnapshotResponseV1 | undefined;
  const unsubscribe = harness.events.on(ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL, (value) => {
    const candidate = value as AdaptiveThinkingSnapshotResponseV1;
    if (candidate.protocolVersion === ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION && candidate.requestId === requestId) {
      response = candidate;
    }
  });
  harness.events.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
    protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
    requestId,
  });
  unsubscribe();
  assert.ok(response, "snapshot request should receive a matching response event");
  return response.snapshot;
}

function changedSnapshots(harness: ReturnType<typeof createHarness>): AdaptiveThinkingSnapshotV1[] {
  return harness.emittedEvents
    .filter((event) => event.channel === ADAPTIVE_THINKING_SNAPSHOT_CHANGED_CHANNEL)
    .map((event) => event.value as AdaptiveThinkingSnapshotV1);
}

type TestThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type TestThinkingLevelMap = Partial<Record<TestThinkingLevel, string | null>>;

function realModel(id: string, thinkingLevelMap: TestThinkingLevelMap): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "test",
    baseUrl: "http://fake-provider.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
    compat: {},
    thinkingLevelMap,
  };
}

function requestRealSnapshot(eventBus: ReturnType<typeof createEventBus>): AdaptiveThinkingSnapshotV1 {
  const requestId = "real-session-snapshot-request";
  let response: AdaptiveThinkingSnapshotResponseV1 | undefined;
  const unsubscribe = eventBus.on(ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL, (value) => {
    const candidate = value as AdaptiveThinkingSnapshotResponseV1;
    if (candidate.protocolVersion === ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION && candidate.requestId === requestId) {
      response = candidate;
    }
  });
  eventBus.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
    protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
    requestId,
  });
  unsubscribe();
  assert.ok(response, "real AgentSession snapshot request should receive a response");
  return response.snapshot;
}

before(() => {
  writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
});

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[
    Symbol.for("@caair/adaptive-thinking/process-environment-policy-registry/v1")
  ];
  delete process.env.PI_ADAPTIVE_THINKING_POLICY;
});

after(() => {
  process.env.HOME = originalHome;
  if (originalAdaptiveThinkingPolicy === undefined) {
    delete process.env.PI_ADAPTIVE_THINKING_POLICY;
  } else {
    process.env.PI_ADAPTIVE_THINKING_POLICY = originalAdaptiveThinkingPolicy;
  }
  rmSync(testHome, { recursive: true, force: true });
});

describe("extension registration and lifecycle", () => {
  test("registers the adaptive-thinking tool and commands", () => {
    const harness = createHarness();

    assert.ok(harness.tools.has("set_thinking_effort"));
    for (const command of ["thinking-baseline", "thinking-status", "thinking-bounds", "thinking-reset", "thinking-toggle"]) {
      assert.ok(harness.commands.has(command), `${command} should be registered`);
    }
    assert.ok(harness.commands.has("thinking-higher"));
    assert.ok(harness.commands.has("thinking-lower"));
    assert.ok(harness.shortcuts.has("alt+."));
    assert.ok(harness.shortcuts.has("alt+,"));
    for (const swallowed of ["shift+tab", "alt+shift+tab", "ctrl+shift+tab"]) {
      assert.equal(harness.shortcuts.has(swallowed), false, `${swallowed} is unreachable in a terminal and must stay unregistered`);
    }
  });

  test("moves one fresh model-safe candidate in either direction and leaves endpoints unchanged", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "medium", maxLevel: "high" });
    const harness = createHarness({
      thinkingLevel: "low",
      model: {
        provider: "anthropic",
        id: "sparse-directional",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", max: "max" },
      },
    });
    await harness.emit("session_start");

    await harness.commands.get("thinking-higher")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "high");
    assert.equal(readConfig().baseline, "high", "ordinary directional movement must persist a non-max user baseline");
    assert.equal(readConfig().maxLevel, "high", "ordinary directional movement must not widen or rewrite configured bounds");
    await harness.shortcuts.get("alt+,")?.handler(harness.ctx);
    assert.equal(harness.thinkingLevel, "low");
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "max" });
    await executeSetThinkingEffort(harness, { level: "low", scope: "until_changed", reason: "endpoint preservation" });
    const endpointSetterCount = harness.setThinkingLevels.length;
    const endpointBefore = requestSnapshot(harness);
    await harness.shortcuts.get("alt+,")?.handler(harness.ctx);
    assert.equal(harness.thinkingLevel, "low", "lower endpoint must not wrap");
    assert.equal(harness.setThinkingLevels.length, endpointSetterCount, "lower endpoint must not call the setter");
    const endpointAfter = requestSnapshot(harness);
    assert.deepEqual(
      { baseline: endpointAfter.baseline, effective: endpointAfter.effective, source: endpointAfter.source, scope: endpointAfter.scope, turnsRemaining: endpointAfter.turnsRemaining },
      { baseline: endpointBefore.baseline, effective: endpointBefore.effective, source: endpointBefore.source, scope: endpointBefore.scope, turnsRemaining: endpointBefore.turnsRemaining },
    );
    await harness.shortcuts.get("alt+.")?.handler(harness.ctx);
    await harness.shortcuts.get("alt+.")?.handler(harness.ctx);
    assert.equal(harness.thinkingLevel, "max");
    await executeSetThinkingEffort(harness, { level: "max", scope: "until_changed", reason: "upper endpoint preservation" });
    const highestSetterCount = harness.setThinkingLevels.length;
    const highestBefore = requestSnapshot(harness);
    await harness.commands.get("thinking-higher")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "max", "higher endpoint must not wrap");
    assert.equal(harness.setThinkingLevels.length, highestSetterCount, "higher endpoint must not call the setter");
    const highestAfter = requestSnapshot(harness);
    assert.deepEqual(
      { baseline: highestAfter.baseline, effective: highestAfter.effective, source: highestAfter.source, scope: highestAfter.scope, turnsRemaining: highestAfter.turnsRemaining },
      { baseline: highestBefore.baseline, effective: highestBefore.effective, source: highestBefore.source, scope: highestBefore.scope, turnsRemaining: highestBefore.turnsRemaining },
    );
    assert.ok(harness.setThinkingLevels.every((level) => ["low", "high", "max"].includes(level)));
  });

  test("directional movement uses active delegate bounds without global writes and clears overrides", async () => {
    const original = { baseline: "low", enabled: true, minLevel: "low", maxLevel: "max" };
    writeConfig(original);
    const harness = createHarness({
      thinkingLevel: "high",
      model: { provider: "anthropic", id: "bounded-directional", reasoning: true },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "directional-bounds",
      agentName: "worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "high", reason: "temporary override" });
    await harness.commands.get("thinking-lower")?.handler("", harness.ctx);

    assert.equal(harness.thinkingLevel, "medium");
    assert.equal(requestSnapshot(harness).source, "user");
    assert.equal(requestSnapshot(harness).scope, null);
    assert.deepEqual(readConfig(), original, "delegated directional movement must stay session-local");
    await harness.commands.get("thinking-lower")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "medium", "bounded lower endpoint must not change state");
  });

  test("refreshes candidates after a model switch and excludes off for claude-opus-5", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "max" });
    const harness = createHarness({
      thinkingLevel: "high",
      model: { provider: "anthropic", id: "first-model", reasoning: true, thinkingLevelMap: { low: "low", medium: null, high: "high" } },
    });
    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "high", "startup must select a safe runtime fallback for the effective baseline");
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /high/);
    const startupPrompt = (await harness.emit("before_agent_start", { systemPrompt: "base" }))[0] as { systemPrompt: string };
    assert.match(startupPrompt.systemPrompt, /Current: high \(model-safe runtime fallback/);
    const nextModel = {
      provider: "anthropic",
      id: "claude-opus-5",
      reasoning: true,
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { off: null, minimal: "minimal", low: null, medium: null, high: null },
    };
    harness.ctx.model = nextModel;
    await harness.emit("model_select", { model: nextModel });
    assert.equal(harness.thinkingLevel, "minimal", "model refresh must select a safe runtime fallback");
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /minimal/);
    const prompt = (await harness.emit("before_agent_start", { systemPrompt: "base" }))[0] as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Current: minimal \(model-safe runtime fallback/);
    const recoveryModel = { ...nextModel, thinkingLevelMap: { off: null, minimal: "minimal", low: null, medium: "medium", high: null } };
    harness.ctx.model = recoveryModel;
    await harness.emit("model_select", { model: recoveryModel });
    assert.equal(harness.thinkingLevel, "medium", "model refresh must recover the effective baseline when it becomes supported");
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /medium/);
    await harness.commands.get("thinking-lower")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "minimal");
    assert.notEqual(harness.thinkingLevel, "off");
    assert.equal(harness.setThinkingLevels.includes("off"), false, "force-adaptive directional movement must never set off");
    assert.equal(requestSnapshot(harness).modelSupportedLevels.includes("off"), false);
  });

  test("treats Pi's pre-model-select capability clamp as runtime reconciliation", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const initialModel = {
      provider: "example",
      id: "same-identity-model",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: "high" },
    };
    const sparseModel = {
      provider: "example",
      id: "same-identity-model",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" },
    };
    const harness = createHarness({ thinkingLevel: "medium", model: initialModel });
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "medium", scope: "next_N", turns: 3, reason: "preserve across model switch" });

    harness.ctx.model = sparseModel;
    harness.setRawThinkingLevel("high");
    await harness.emit("thinking_level_select", { level: "high", previousLevel: "medium" });

    assert.equal(harness.thinkingLevel, "high");
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /high/);
    await harness.commands.get("thinking-status")?.handler("", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Effective level: high/);
    const restrictedPrompt = (await harness.emit("before_agent_start", { systemPrompt: "base" }))[0] as { systemPrompt: string };
    assert.match(restrictedPrompt.systemPrompt, /Current: high/);
    const restrictedSetters = harness.setThinkingLevels.length;
    await harness.commands.get("thinking-lower")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "high", "restricted endpoint movement must start from the visible safe fallback");
    assert.equal(harness.setThinkingLevels.length, restrictedSetters);
    assert.deepEqual(readConfig(), { baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestSnapshot(harness)),
      { baseline: "medium", effective: "high", source: "agent", scope: "next_N", turnsRemaining: 3 },
    );

    harness.ctx.model = initialModel;
    await harness.emit("before_agent_start", { systemPrompt: "base" });
    assert.equal(harness.thinkingLevel, "medium");
    const restorationSetters = harness.setThinkingLevels.length;
    await harness.commands.get("thinking-lower")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "medium", "restored endpoint movement must use fresh capabilities");
    assert.equal(harness.setThinkingLevels.length, restorationSetters);
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestSnapshot(harness)),
      { baseline: "medium", effective: "medium", source: "agent", scope: "next_N", turnsRemaining: 3 }
    );
  });

  test("real AgentSession.setModel preserves adaptive state across Pi's clamp event", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const initialModel = realModel("real-same-identity", { off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null });
    const sparseModel = realModel("real-same-identity", { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
    const eventBus = createEventBus();
    const cwd = resolve(".");
    const agentDir = join(testHome, ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      eventBus,
      extensionFactories: [{ name: "adaptive-thinking-real-session", factory: registerAdaptiveThinking }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry("adaptive-thinking-state", {
      baseline: "medium",
      override: "medium",
      scope: "next_N",
      turnsRemaining: 3,
      reason: "preserve this active override",
      inAgentRun: false,
    });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerProvider("test", {
      baseUrl: "http://fake-provider.invalid",
      apiKey: "sk-fake-test",
      api: "anthropic-messages",
      streamSimple: (() => {
        throw new Error("real model-switch regression must not call provider transport");
      }) as never,
      models: [initialModel, sparseModel].map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      })),
    });

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: initialModel,
      thinkingLevel: "medium",
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      noTools: "all",
    });
    const session = created.session;
    t.after(() => session.dispose());
    const dispatchedEvents: string[] = [];
    const sessionRunner = (session as unknown as {
      _extensionRunner: {
        emit: (event: { type: string }) => Promise<unknown>;
        emitBeforeAgentStart: (prompt: string, images: unknown[], systemPrompt: string, systemPromptOptions?: unknown) => Promise<{ systemPrompt?: string }>;
      };
    })._extensionRunner;
    const originalEmit = sessionRunner.emit.bind(sessionRunner);
    sessionRunner.emit = async (event) => {
      if (event.type === "thinking_level_select" || event.type === "model_select") dispatchedEvents.push(event.type);
      return originalEmit(event);
    };
    await session.bindExtensions({ shutdownHandler() {} });

    const initialEventCount = dispatchedEvents.length;
    await session.setModel(sparseModel);
    assert.deepEqual(dispatchedEvents.slice(initialEventCount), ["thinking_level_select"]);
    assert.equal(session.thinkingLevel, "high", "Pi must expose the sparse model's safe runtime fallback");
    assert.deepEqual(readConfig(), { baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestRealSnapshot(eventBus)),
      { baseline: "medium", effective: "high", source: "agent", scope: "next_N", turnsRemaining: 3 },
    );
    const restrictedPrompt = await sessionRunner.emitBeforeAgentStart("", [], "base");
    assert.match(restrictedPrompt.systemPrompt ?? "", /Current: high/);

    const restorationEventCount = dispatchedEvents.length;
    await session.setModel(initialModel);
    assert.deepEqual(dispatchedEvents.slice(restorationEventCount), [], "same-identity restoration must emit no model_select or thinking_level_select");
    assert.equal(session.thinkingLevel, "high", "Pi keeps the already-safe runtime level until the next extension hook");
    const restorationPrompt = await sessionRunner.emitBeforeAgentStart("", [], "base");
    assert.match(restorationPrompt.systemPrompt ?? "", /Current: medium/);
    assert.equal(session.thinkingLevel, "medium", "the next context-bearing hook must restore the intended runtime level");
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestRealSnapshot(eventBus)),
      { baseline: "medium", effective: "medium", source: "agent", scope: "next_N", turnsRemaining: 3 },
    );
    const persistedState = sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "adaptive-thinking-state") as { data?: unknown } | undefined;
    assert.equal((persistedState?.data as { reason?: string } | undefined)?.reason, "preserve this active override", "model reconciliation must not rewrite the persisted reason");

    await session.setThinkingLevel("high");
    assert.equal(session.thinkingLevel, "high", "a genuine same-model manual selection must remain effective");
    assert.deepEqual(readConfig(), { baseline: "high", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    await session.setThinkingLevel("medium");
    assert.equal(session.thinkingLevel, "medium", "a genuine identical manual selection must not be swallowed by restoration echo bookkeeping");
    assert.deepEqual(readConfig(), { baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestRealSnapshot(eventBus)),
      { baseline: "medium", effective: "medium", source: "user", scope: null, turnsRemaining: null },
    );
  });

  test("real AgentSession keeps prompt, schema, and active tools in agreement when capability narrows late", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "model-max" });
    // Same id, so Pi's setModel performs a silent replacement: before_agent_start
    // is the first hook that sees the narrower capability, and by then Pi has
    // already assembled the base prompt this handler is handed.
    const wideModel = realModel("late-narrow", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    const narrowModel = realModel("late-narrow", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
    const eventBus = createEventBus();
    const cwd = resolve(".");
    const agentDir = join(testHome, ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      eventBus,
      extensionFactories: [{ name: "adaptive-thinking-late-narrow", factory: registerAdaptiveThinking }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerProvider("test", {
      baseUrl: "http://fake-provider.invalid",
      apiKey: "sk-fake-test",
      api: "anthropic-messages",
      streamSimple: (() => {
        throw new Error("late-narrow regression must not call provider transport");
      }) as never,
      models: [wideModel, narrowModel].map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      })),
    });

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: wideModel,
      thinkingLevel: "medium",
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    });
    const session = created.session;
    t.after(() => session.dispose());
    const sessionRunner = (session as unknown as {
      _extensionRunner: {
        emitBeforeAgentStart: (prompt: string, images: unknown[], systemPrompt: string) => Promise<{ systemPrompt?: string }>;
      };
    })._extensionRunner;
    await session.bindExtensions({ shutdownHandler() {} });

    const toolNamed = () =>
      (session.getAllTools() as Array<{ name: string; description?: string; parameters?: unknown; promptSnippet?: string; promptGuidelines?: string[] }>)
        .find((tool) => tool.name === "set_thinking_effort");
    const enumOf = (tool: { parameters?: unknown }) =>
      (JSON.parse(JSON.stringify(tool.parameters)) as { properties: { level: { enum: string[] } } }).properties.level.enum;
    const listedIn = (prompt: string) => {
      const match = /Available levels: ([^.]+)\./.exec(prompt);
      return match?.[1]?.split(", ") ?? [];
    };

    assert.ok(toolNamed(), "the extension tool must be visible on a real session");
    assert.deepEqual(enumOf(toolNamed()!), ["low", "medium", "high", "xhigh", "max"]);

    // The base prompt Pi hands the handler is captured before it runs. Nothing
    // baked into it may name a level, or a late narrowing strands stale prose
    // next to a fresh schema.
    const bakedProse = `${toolNamed()!.promptSnippet ?? ""}\n${(toolNamed()!.promptGuidelines ?? []).join("\n")}`;
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      assert.doesNotMatch(
        bakedProse,
        new RegExp(`\\b${level}\\b`),
        `promptSnippet/promptGuidelines are baked into Pi's base prompt and must not name "${level}"`,
      );
    }

    await session.setModel(narrowModel);
    const prompt = (await sessionRunner.emitBeforeAgentStart("", [], "base")).systemPrompt ?? "";

    // Same request: prompt list, schema enum, and active-tool membership agree.
    const promptLevels = listedIn(prompt);
    assert.deepEqual(promptLevels, ["low", "medium", "high"]);
    assert.deepEqual(enumOf(toolNamed()!), promptLevels, "schema enum must match the list the prompt advertises");
    assert.equal((session.getActiveToolNames() as string[]).includes("set_thinking_effort"), true);
    assert.doesNotMatch(prompt, /\*\*xhigh\*\*/);
    assert.doesNotMatch(prompt, /\*\*max\*\*/);
  });

  test("real AgentSession with noTools does not advertise a tool Pi filtered out", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const model = realModel("no-tools-session", { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
    const eventBus = createEventBus();
    const cwd = resolve(".");
    const agentDir = join(testHome, ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      eventBus,
      extensionFactories: [{ name: "adaptive-thinking-no-tools", factory: registerAdaptiveThinking }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerProvider("test", {
      baseUrl: "http://fake-provider.invalid",
      apiKey: "sk-fake-test",
      api: "anthropic-messages",
      streamSimple: (() => {
        throw new Error("no-tools regression must not call provider transport");
      }) as never,
      models: [
        {
          id: model.id,
          name: model.name,
          api: model.api,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          compat: model.compat,
        },
      ],
    });

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "medium",
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      // Pi drops every tool from the registry, so activating ours is ignored.
      noTools: "all",
    });
    const session = created.session;
    t.after(() => session.dispose());
    const sessionRunner = (session as unknown as {
      _extensionRunner: {
        emitBeforeAgentStart: (prompt: string, images: unknown[], systemPrompt: string, systemPromptOptions?: unknown) => Promise<{ systemPrompt?: string }>;
      };
    })._extensionRunner;
    await session.bindExtensions({ shutdownHandler() {} });

    assert.equal(
      (session.getActiveToolNames() as string[]).includes("set_thinking_effort"),
      false,
      "Pi must keep the tool out of the active set under noTools",
    );

    const prompt = (await sessionRunner.emitBeforeAgentStart("", [], "base", (session as unknown as { _baseSystemPromptOptions: unknown })._baseSystemPromptOptions)).systemPrompt ?? "";

    assert.match(prompt, /`set_thinking_effort` is not available in this session/);
    assert.doesNotMatch(prompt, /Available levels:/, "the prompt must not offer a tool the request will not carry");
    assert.doesNotMatch(prompt, /\*\*high\*\*/);
  });

  test("real AgentSession adopts an immediate manual selection after a silent equivalent replacement", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const initialModel = realModel("real-equivalent-identity", {
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    const replacementModel = realModel("real-equivalent-identity", {
      off: null,
      minimal: null,
      low: null,
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    const eventBus = createEventBus();
    const cwd = resolve(".");
    const agentDir = join(testHome, ".pi", "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      eventBus,
      extensionFactories: [{ name: "adaptive-thinking-equivalent-session", factory: registerAdaptiveThinking }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendCustomEntry("adaptive-thinking-state", {
      baseline: "medium",
      override: "medium",
      scope: "next_N",
      turnsRemaining: 3,
      reason: "replace this with a manual baseline",
      inAgentRun: false,
    });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerProvider("test", {
      baseUrl: "http://fake-provider.invalid",
      apiKey: "sk-fake-test",
      api: "anthropic-messages",
      streamSimple: (() => {
        throw new Error("equivalent-model regression must not call provider transport");
      }) as never,
      models: [initialModel, replacementModel].map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      })),
    });

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: initialModel,
      thinkingLevel: "medium",
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      noTools: "all",
    });
    const session = created.session;
    t.after(() => session.dispose());
    const dispatchedEvents: string[] = [];
    const sessionRunner = (session as unknown as {
      _extensionRunner: {
        emit: (event: { type: string }) => Promise<unknown>;
      };
    })._extensionRunner;
    const originalEmit = sessionRunner.emit.bind(sessionRunner);
    sessionRunner.emit = async (event) => {
      if (event.type === "thinking_level_select" || event.type === "model_select") dispatchedEvents.push(event.type);
      return originalEmit(event);
    };
    await session.bindExtensions({ shutdownHandler() {} });

    const replacementEventCount = dispatchedEvents.length;
    await session.setModel(replacementModel);
    assert.deepEqual(dispatchedEvents.slice(replacementEventCount), [], "equivalent replacement must emit no model or thinking event");

    await session.setThinkingLevel("high");
    assert.deepEqual(dispatchedEvents.slice(replacementEventCount), ["thinking_level_select"]);
    assert.equal(session.thinkingLevel, "high");
    assert.deepEqual(readConfig(), { baseline: "high", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    assert.deepEqual(
      (({ baseline, effective, source, scope, turnsRemaining }) => ({ baseline, effective, source, scope, turnsRemaining }))(requestRealSnapshot(eventBus)),
      { baseline: "high", effective: "high", source: "user", scope: null, turnsRemaining: null },
    );
  });

  test("keeps max aligned across tool schema, prompts, help, and completions", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "max" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "max-capable", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    });
    await harness.emit("session_start");
    const tool = harness.tools.get("set_thinking_effort");
    const baseline = harness.commands.get("thinking-baseline");
    const bounds = harness.commands.get("thinking-bounds");
    assert.ok(tool);
    assert.ok(baseline);
    assert.ok(bounds);

    assert.match(JSON.stringify(tool.parameters), /"max"/);
    assert.match(`${tool.description}\n${tool.promptSnippet}\n${tool.promptGuidelines?.join("\n")}`, /max/);
    assert.match(baseline.description, /max/);
    assert.match(bounds.description, /max/);
    assert.ok(baseline.getArgumentCompletions?.("ma")?.some((item) => item.value === "max"));
    assert.ok(bounds.getArgumentCompletions?.("low m")?.some((item) => item.value === "low max"));
  });

  test("never advertises a level the configured range or the model withholds", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "capped-at-high", reasoning: true },
    });
    await harness.emit("session_start");
    const tool = harness.tools.get("set_thinking_effort");
    assert.ok(tool);

    // maxLevel is xhigh, so max is out of range; the model exposes no xhigh, so
    // the only level left is high. None of the tool surfaces may name the rest.
    const schema = JSON.stringify(tool.parameters);
    assert.deepEqual(
      (JSON.parse(schema) as { properties: { level: { enum: string[] } } }).properties.level.enum,
      ["high"],
    );
    const prose = `${tool.description}\n${tool.promptSnippet}\n${tool.promptGuidelines?.join("\n")}`;
    assert.doesNotMatch(prose, /\bmax\b/, "max is outside the configured ceiling and must not be suggested");
    assert.doesNotMatch(prose, /\bxhigh\b/, "xhigh is unsupported on this model and must not be suggested");

    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base" });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /Available levels: high\./);
    assert.match(systemPrompt, /xhigh is within your configured range but unsupported on capped-at-high/);
    assert.doesNotMatch(systemPrompt, /\*\*xhigh\*\*/);
    assert.doesNotMatch(systemPrompt, /\*\*max\*\*/);
  });

  test("offers a model's max as the top rung when it exposes no xhigh", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "model-max" });
    const harness = createHarness({
      // Shape of claude-opus-4-6 and claude-sonnet-4-6: max, but no xhigh.
      model: { provider: "anthropic", id: "max-no-xhigh", reasoning: true, thinkingLevelMap: { max: "max" } },
    });
    await harness.emit("session_start");
    const tool = harness.tools.get("set_thinking_effort");
    assert.ok(tool);
    assert.deepEqual(
      (JSON.parse(JSON.stringify(tool.parameters)) as { properties: { level: { enum: string[] } } }).properties.level.enum,
      ["low", "medium", "high", "max"],
    );

    const result = await executeSetThinkingEffort(harness, { level: "max", reason: "model-max ceiling" });
    assert.equal((result.details as { new_level?: unknown }).new_level, "max");
    assert.equal(harness.thinkingLevel, "max");
  });

  test("hides the tool when no configured level is supported by the model", async () => {
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    const harness = createHarness({
      // Shape of opencode/kimi-k3: a single level, outside the configured range.
      model: {
        provider: "opencode",
        id: "only-max",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: "max" },
      },
    });
    await harness.emit("session_start");

    assert.equal(harness.activeTools.includes("set_thinking_effort"), false);
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base" });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /No alternative thinking levels are available on only-max/);
    assert.doesNotMatch(systemPrompt, /\*\*high\*\*/);

    const denied = await executeSetThinkingEffort(harness, { level: "high", reason: "should be refused" });
    assert.equal(denied.isError, true);
    assert.equal((denied.details as { error?: unknown }).error, "unavailable");
  });

  test("a late level-set change is reconciled, not aborted", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "model-max" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "same-id", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    });
    await harness.emit("session_start");
    const levelEnum = () =>
      (JSON.parse(JSON.stringify(harness.tools.get("set_thinking_effort")?.parameters)) as {
        properties: { level: { enum: string[] } };
      }).properties.level.enum;
    assert.deepEqual(levelEnum(), ["low", "medium", "high", "xhigh", "max"]);

    // Same identity, so no model_select fires: before_agent_start is the first
    // hook to see it, after Pi captured the base prompt.
    harness.ctx.model = { provider: "anthropic", id: "same-id", reasoning: true };
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base" });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;

    assert.equal(harness.shutdowns, 0, "a narrowed level set is recoverable and must not latch the session");
    assert.match(systemPrompt, /Available levels: low, medium, high\./);
    assert.deepEqual(levelEnum(), ["low", "medium", "high"], "the schema must match the prompt in this same request");
    assert.equal(harness.activeTools.includes("set_thinking_effort"), true);
  });

  test("fails closed when the tool disappears after the prompt was assembled", async () => {
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "high",
      model: { provider: "anthropic", id: "vanishing", reasoning: true },
    });
    await harness.emit("session_start");
    assert.equal(harness.activeTools.includes("set_thinking_effort"), true);

    // Same identity again, narrowed to a single level outside the configured
    // window. Pi's captured base prompt still lists the tool under "Available
    // tools", and this handler cannot rewrite that line.
    harness.ctx.model = {
      provider: "anthropic",
      id: "vanishing",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: "max" },
    };
    // Pi's generated prompt lists the tool, and this handler cannot take that
    // line back out of the string it was handed.
    await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: advertisingOptions() });

    assert.equal(harness.shutdowns, 1, "an unreconcilable tool-presence flip must latch the session");
    assert.deepEqual(
      await harness.emit("input", { text: "must not run", source: "rpc" }),
      [{ action: "handled" }],
      "the latched session must refuse further input",
    );
  });

  test("a late disappearance under a custom system prompt is reconciled, not aborted", async () => {
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "high",
      model: { provider: "anthropic", id: "vanishing-custom", reasoning: true },
    });
    await harness.emit("session_start");

    harness.ctx.model = {
      provider: "anthropic",
      id: "vanishing-custom",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, max: "max" },
    };
    // Pi returns from buildSystemPrompt before the tool section on this path, so
    // the captured prompt names no tool and there is nothing stale to contradict.
    const [result] = await harness.emit("before_agent_start", {
      systemPrompt: "custom base",
      systemPromptOptions: { customPrompt: "custom base", selectedTools: ["set_thinking_effort"], toolSnippets: { set_thinking_effort: "snippet" } },
    });

    assert.equal(harness.shutdowns, 0, "a custom prompt carries no stale tool line, so this is recoverable");
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /set_thinking_effort` is not offered this session|not available in this session/);
    assert.equal(harness.activeTools.includes("set_thinking_effort"), false);
  });

  test("does not advertise the tool when Pi filtered it out of the session", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "capable", reasoning: true },
    });
    await harness.emit("session_start");
    assert.equal(harness.activeTools.includes("set_thinking_effort"), true);

    // Stand in for --no-tools / --exclude-tools: Pi drops the name, and a later
    // activation for a tool outside its registry is silently ignored.
    harness.setActiveToolsExternally([]);

    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { selectedTools: [], toolSnippets: {} } });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;

    assert.equal(harness.shutdowns, 0, "Pi filtering the tool out is a configuration, not drift");
    assert.match(systemPrompt, /`set_thinking_effort` is not available in this session/);
    assert.doesNotMatch(systemPrompt, /Available levels:/, "an absent tool must not be advertised as callable");
    assert.doesNotMatch(systemPrompt, /\*\*high\*\*/);
  });

  test("re-registers the tool when a model switch changes what is supported", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "model-max" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "narrow", reasoning: true },
    });
    await harness.emit("session_start");
    const levelEnum = () =>
      (JSON.parse(JSON.stringify(harness.tools.get("set_thinking_effort")?.parameters)) as {
        properties: { level: { enum: string[] } };
      }).properties.level.enum;
    assert.deepEqual(levelEnum(), ["low", "medium", "high"]);

    harness.ctx.model = {
      provider: "anthropic",
      id: "wide",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    await harness.emit("model_select", { model: harness.ctx.model });

    assert.deepEqual(levelEnum(), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(harness.activeTools.includes("set_thinking_effort"), true);
  });


  test("applies and persists an environment ceiling across tool and manual controls", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "high" });
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();

    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "environment ceiling regression",
    });
    assert.equal((result.details as { new_level: string }).new_level, "high");
    assert.equal(harness.thinkingLevel, "high");

    await harness.emit("thinking_level_select", { level: "xhigh" });
    assert.equal(harness.thinkingLevel, "high", "manual selection must remain inside the environment ceiling");
    assert.deepEqual(
      harness.appended.find((entry) => entry.customType === "adaptive-thinking-env-policy")?.data,
      { version: 1, thinkingMin: "low", thinkingMax: "high" },
    );
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /ceiling: env/);
    await harness.commands.get("thinking-status")?.handler("", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Ceiling source: env/);
  });

  test("fails closed with a visible warning when the environment policy is malformed", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = '{"version":1,"thinkingMax":"turbo"}';
    writeConfig({ baseline: "xhigh", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "xhigh" });

    await harness.emit("session_start");

    assert.equal(harness.shutdowns, 1);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /PI_ADAPTIVE_THINKING_POLICY.*invalid/i);
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "off",
      thinkingMax: "off",
    });
    assert.deepEqual(await harness.emit("input", { text: "must not run", source: "rpc" }), [{ action: "handled" }]);
  });

  test("keeps a malformed environment failure latched across a pre-start delegate event", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = "not-json";
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "must-not-ack",
      agentName: "bounded-worker",
      maxLevel: "high",
    });
    assert.equal(
      harness.emittedEvents.some((event) => event.channel === "adaptive-thinking:pi-delegate-policy-accepted"),
      false,
    );

    await harness.emit("session_start");

    assert.equal(harness.shutdowns, 1);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Invalid PI_ADAPTIVE_THINKING_POLICY/i);
  });

  test("does not let a stale prior session policy widen a stricter environment before the next start", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "high" });
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await harness.emit("session_shutdown");

    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "medium" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "next-session-policy",
      agentName: "bounded-worker",
      maxLevel: "xhigh",
    });
    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, {
      level: "high",
      reason: "cross-session stale policy regression",
    });

    assert.equal((result.details as { new_level: string }).new_level, "medium");
  });

  test("intersects environment, delegate, and configured bounds without widening", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMin: "low", thinkingMax: "high" });
    writeConfig({ baseline: "high", enabled: true, minLevel: "medium", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "high" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "env-delegate-intersection",
      agentName: "bounded-worker",
      minLevel: "low",
      maxLevel: "medium",
    });

    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "intersection regression",
    });

    assert.equal((result.details as { new_level: string }).new_level, "medium");
    assert.deepEqual((result.details as { allowed_range: string[] }).allowed_range, ["medium", "medium"]);
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "medium",
      thinkingMax: "medium",
    });
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /ceiling: delegate/);
  });

  test("allows a later delegate policy to narrow but never widen an active environment ceiling", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "high" });
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "late-narrowing",
      agentName: "bounded-worker",
      maxLevel: "medium",
    });
    const narrowed = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "late policy narrowing regression",
    });
    assert.equal((narrowed.details as { new_level: string }).new_level, "medium");
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "low",
      thinkingMax: "medium",
    });

    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "late-attempted-widening",
      agentName: "bounded-worker",
      maxLevel: "xhigh",
    });
    const stillNarrow = await executeSetThinkingEffort(harness, {
      level: "high",
      reason: "late policy widening regression",
    });
    assert.equal((stillNarrow.details as { new_level: string }).new_level, "medium");
  });

  test("exports a parent's effective delegated ceiling for inherited child environments", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "child-transport",
      agentName: "bounded-parent",
      maxLevel: "high",
    });

    await harness.emit("session_start");

    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "low",
      thinkingMax: "high",
    });
  });

  test("keeps the child environment bounded by every live session and releases closed ranges", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const broad = createHarness();
    const bounded = createHarness();
    t.after(async () => {
      await bounded.emit("session_shutdown");
      await broad.emit("session_shutdown");
    });

    await broad.emit("session_start");
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "xhigh");

    bounded.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "shared-process-bounded-session",
      agentName: "bounded-sibling",
      maxLevel: "medium",
    });
    await bounded.emit("session_start");
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "medium");

    await broad.emit("input", { text: "broad sibling refresh" });
    assert.equal(
      JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax,
      "medium",
      "a broad sibling must not overwrite a live bounded session's export",
    );

    await bounded.emit("session_shutdown");
    assert.equal(
      JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax,
      "xhigh",
      "closing the bounded sibling should release only its range",
    );
  });

  test("shares live ranges across duplicate extension module evaluations", async (t) => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const broad = createHarness();
    await broad.emit("session_start");

    const { default: duplicateRegistration } = await import(
      `${pathToFileURL(resolve("index.ts")).href}?duplicate-process-registry=${Date.now()}`
    );
    const bounded = createHarness({ register: duplicateRegistration });
    t.after(async () => {
      await bounded.emit("session_shutdown");
      await broad.emit("session_shutdown");
    });
    bounded.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "duplicate-module-bounded-session",
      agentName: "duplicate-bounded-sibling",
      maxLevel: "medium",
    });
    await bounded.emit("session_start");
    await broad.emit("input", { text: "refresh from the original module evaluation" });

    assert.equal(
      JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax,
      "medium",
      "Symbol.for registry must be shared by duplicate module evaluations",
    );
  });

  test("exports off-off when live session ranges have no intersection", async (t) => {
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    const highRange = createHarness();
    await highRange.emit("session_start");

    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "medium" });
    const lowRange = createHarness();
    t.after(async () => {
      await lowRange.emit("session_shutdown");
      await highRange.emit("session_shutdown");
    });
    await lowRange.emit("session_start");

    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "off",
      thinkingMax: "off",
    });

    await lowRange.emit("session_shutdown");
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "high",
      thinkingMax: "xhigh",
    });
  });

  test("intersects a live and pending delegate policy with a stricter persisted environment ceiling", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "xhigh" });
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      entries: [{
        type: "custom",
        customType: "adaptive-thinking-env-policy",
        data: { version: 1, thinkingMin: "low", thinkingMax: "high" },
      }],
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "pending-with-persisted-env",
      agentName: "bounded-worker",
      maxLevel: "xhigh",
    });

    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "persisted environment intersection regression",
    });

    assert.equal((result.details as { new_level: string }).new_level, "high");
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "low",
      thinkingMax: "high",
    });
  });

  test("restores a persisted environment policy when the process environment is absent", async () => {
    process.env.PI_ADAPTIVE_THINKING_POLICY = JSON.stringify({ version: 1, thinkingMax: "high" });
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const first = createHarness();
    await first.emit("session_start");
    const persisted = first.appended.find((entry) => entry.customType === "adaptive-thinking-env-policy");
    assert.ok(persisted);

    delete process.env.PI_ADAPTIVE_THINKING_POLICY;
    const resumed = createHarness({
      entries: [{ type: "custom", customType: persisted.customType, data: persisted.data }],
    });
    await resumed.emit("session_start");
    const result = await executeSetThinkingEffort(resumed, {
      level: "xhigh",
      reason: "persisted environment ceiling regression",
    });
    assert.equal((result.details as { new_level: string }).new_level, "high");
  });

  test("keeps ordinary behavior unchanged while exporting configured bounds when no inherited policy exists", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();

    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "ordinary behavior regression",
    });

    assert.equal((result.details as { new_level: string }).new_level, "xhigh");
    assert.deepEqual(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null"), {
      version: 1,
      thinkingMin: "low",
      thinkingMax: "xhigh",
    });
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /ceiling: config/);
  });

  test("refreshes the child-visible environment when model-max narrows after a model switch", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "model-max" });
    const harness = createHarness({
      model: {
        provider: "anthropic",
        id: "wide-parent",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    });
    await harness.emit("session_start");
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "max");

    harness.ctx.model = { provider: "anthropic", id: "narrow-parent", reasoning: true };
    await harness.emit("model_select", { model: harness.ctx.model });

    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "high");
  });

  test("refreshes child policy for automatic model clamps and out-of-band config narrowing", async () => {
    writeConfig({ baseline: "max", enabled: true, minLevel: "low", maxLevel: "model-max" });
    const wideModel = {
      provider: "example",
      id: "same-identity-parent",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    };
    const narrowModel = {
      provider: "example",
      id: "same-identity-parent",
      reasoning: true,
      thinkingLevelMap: { medium: "medium", high: "high" },
    };
    const harness = createHarness({ thinkingLevel: "max", model: wideModel });
    await harness.emit("session_start");
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "max");

    harness.ctx.model = narrowModel;
    harness.setRawThinkingLevel("high");
    await harness.emit("thinking_level_select", { level: "high", previousLevel: "max" });
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "high");

    writeConfig({ baseline: "high", enabled: true, minLevel: "low", maxLevel: "medium" });
    await harness.emit("input", { text: "refresh config" });
    assert.equal(JSON.parse(process.env.PI_ADAPTIVE_THINKING_POLICY ?? "null").thinkingMax, "medium");
  });

  test("accepts a valid delegate policy with a canonical provider-bound ACK", async () => {
    const original = { baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" };
    writeConfig(original);
    const harness = createHarness({ thinkingLevel: "low" });

    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "policy-1",
      agentName: "bounded-worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });

    assert.deepEqual(
      harness.emittedEvents.find((event) => event.channel === "adaptive-thinking:pi-delegate-policy-accepted")?.value,
      { protocolVersion: 1, policyId: "policy-1", extension: "adaptive-thinking" },
    );
    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "high");

    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "worker bounds",
    });
    const details = result.details as { new_level?: unknown; was_clamped?: unknown };
    assert.equal(details.new_level, "high");
    assert.equal(details.was_clamped, true);
    await harness.emit("thinking_level_select", { level: "low" });
		assert.equal(harness.thinkingLevel, "medium", "manual level selection must remain inside worker bounds");
    await harness.commands.get("thinking-baseline")?.handler("xhigh", harness.ctx);
		assert.equal(harness.thinkingLevel, "high", "baseline commands must remain inside worker bounds");
    await harness.commands.get("thinking-bounds")?.handler("medium high", harness.ctx);
    await harness.commands.get("thinking-toggle")?.handler("", harness.ctx);
    assert.deepEqual(readConfig(), original, "session policy must not mutate global config");
  });

  test("keeps policy-scoped tool duration semantics while clamping levels", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "low" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "scoped-policy",
      agentName: "scoped-worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");

    const nextN = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      scope: "next_N",
      turns: 2,
      reason: "bounded multi-turn work",
    });
    assert.equal((nextN.details as { new_level: string }).new_level, "high");
    assert.equal((nextN.details as { turns_remaining: number }).turns_remaining, 2);
    await harness.emit("agent_end");
    assert.equal((harness.appended.at(-1)?.data as { override?: string }).override, "high");
    assert.equal((harness.appended.at(-1)?.data as { turnsRemaining?: number }).turnsRemaining, 1);
    await harness.emit("agent_end");
    assert.equal((harness.appended.at(-1)?.data as { override?: string | null }).override, null);

    const persistent = await executeSetThinkingEffort(harness, {
      level: "low",
      scope: "until_changed",
      reason: "bounded persistent work",
    });
    assert.equal((persistent.details as { new_level: string }).new_level, "medium");
    await harness.emit("agent_end");
    assert.equal((harness.appended.at(-1)?.data as { override?: string }).override, "medium");
  });

  test("rejects invalid policy payloads without acknowledging or changing global behavior", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "invalid-range",
      agentName: "bad-worker",
      baseline: "xhigh",
      maxLevel: "high",
    });

    assert.equal(
      harness.emittedEvents.some((event) => event.channel === "adaptive-thinking:pi-delegate-policy-accepted"),
      false,
    );
    await harness.emit("session_start");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 medium · ceiling: config");
  });

	test("does not ACK a one-sided policy that conflicts with read-only global fallbacks", async () => {
		writeConfig({ baseline: "xhigh", enabled: true, minLevel: "xhigh", maxLevel: "xhigh" });
		const harness = createHarness();
		harness.events.emit("pi-delegate:adaptive-thinking-policy", {
			protocolVersion: 1,
			policyId: "conflicting-fallback",
			agentName: "bad-worker",
			maxLevel: "high",
		});
		assert.equal(
			harness.emittedEvents.some((event) => event.channel === "adaptive-thinking:pi-delegate-policy-accepted"),
			false,
		);
		await harness.emit("session_start");
		assert.equal(harness.thinkingLevel, "xhigh");
	});

  test("freezes completed one-sided policy fallbacks at ACK time", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "low" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "frozen-fallback",
      agentName: "worker",
      maxLevel: "high",
    });
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });

    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "low");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 low · ceiling: delegate");
    assert.deepEqual(harness.appended.find((entry) => entry.customType === "pi-delegate-thinking-policy")?.data, {
      protocolVersion: 1,
      policyId: "frozen-fallback",
      agentName: "worker",
      baseline: "low",
      minLevel: "low",
      maxLevel: "high",
    });
  });

  test("reuses an ACK-completed one-sided snapshot across matching session restarts", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const policyEntry = {
      type: "custom",
      customType: "pi-delegate-thinking-policy",
      data: {
        protocolVersion: 1,
        policyId: "restart-frozen-fallback",
        agentName: "worker",
        maxLevel: "high",
      },
    };
    const harness = createHarness({ thinkingLevel: "low", entries: [policyEntry] });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", policyEntry.data);

    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "low");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 low · ceiling: delegate");

    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    harness.setRawThinkingLevel("high");
    await harness.emit("session_start");

    assert.equal(harness.thinkingLevel, "low", "matching restart must reuse ACK-time fallbacks");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 low · ceiling: delegate");
  });

  test("does not reuse an ACK snapshot for a different persisted policy identity", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const entries = [{
      type: "custom",
      customType: "pi-delegate-thinking-policy",
      data: {
        protocolVersion: 1,
        policyId: "identity-bound-fallback",
        agentName: "first-worker",
        maxLevel: "high",
      },
    }];
    const harness = createHarness({ thinkingLevel: "low", entries });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", entries[0]!.data);
    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "low");

    entries[0] = {
      type: "custom",
      customType: "pi-delegate-thinking-policy",
      data: {
        protocolVersion: 1,
        policyId: "identity-bound-fallback",
        agentName: "different-worker",
        maxLevel: "high",
      },
    };
    writeConfig({ baseline: "high", enabled: true, minLevel: "high", maxLevel: "xhigh" });
    harness.setRawThinkingLevel("low");
    await harness.emit("session_start");

    assert.equal(harness.thinkingLevel, "high", "different agent identity must not inherit the old snapshot");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high · ceiling: delegate");
  });

  test("restored delegate policy baseline wins over stale adaptive state", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "low",
      entries: [
        {
          type: "custom",
          customType: "pi-delegate-thinking-policy",
          data: {
            protocolVersion: 1,
            policyId: "restored-policy",
            agentName: "restarted-worker",
            baseline: "high",
            minLevel: "medium",
            maxLevel: "high",
          },
        },
        {
          type: "custom",
          customType: "adaptive-thinking-state",
          data: { baseline: "low", override: null, scope: null, turnsRemaining: null, reason: null },
        },
      ],
    });

    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high · ceiling: delegate");
  });

  test("clamps fallback baselines and stale overrides when policy omits an explicit baseline", async () => {
    writeConfig({ baseline: "xhigh", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "xhigh",
      entries: [
        {
          type: "custom",
          customType: "pi-delegate-thinking-policy",
          data: {
            protocolVersion: 1,
            policyId: "fallback-policy",
            agentName: "restarted-worker",
            maxLevel: "high",
          },
        },
        {
          type: "custom",
          customType: "adaptive-thinking-state",
          data: { baseline: "xhigh", override: "xhigh", scope: "until_changed", turnsRemaining: null, reason: "stale" },
        },
      ],
    });

    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high (persistent) · ceiling: delegate");
  });

	test("fails closed on malformed persisted policy or bounded restart state", async () => {
		writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
		async function assertSessionFailsClosed(
			harness: ReturnType<typeof createHarness>,
			label?: string,
		): Promise<void> {
			await harness.emit("session_start");
			assert.equal(harness.shutdowns, 1, label);
			assert.deepEqual(
				await harness.emit("input", { text: "must not run", source: "rpc" }),
				[{ action: "handled" }],
				label,
			);
		}

		const malformedPolicy = createHarness({
			entries: [{
				type: "custom",
				customType: "pi-delegate-thinking-policy",
				data: { protocolVersion: 1, policyId: "bad", agentName: "worker", minLevel: "xhigh", maxLevel: "low" },
			}],
		});
		await assertSessionFailsClosed(malformedPolicy, "malformed policy");

		const malformedState = createHarness({
			entries: [
				{
					type: "custom",
					customType: "pi-delegate-thinking-policy",
					data: { protocolVersion: 1, policyId: "bounded", agentName: "worker", minLevel: "medium", maxLevel: "high" },
				},
				{
					type: "custom",
					customType: "adaptive-thinking-state",
					data: { baseline: "medium", override: "high", scope: "next_N", turnsRemaining: 0 },
				},
			],
		});
		await assertSessionFailsClosed(malformedState, "invalid next_N state");

		const malformedBaseline = createHarness({
			entries: [
				{
					type: "custom",
					customType: "pi-delegate-thinking-policy",
					data: { protocolVersion: 1, policyId: "bounded-baseline", agentName: "worker", baseline: "high", minLevel: "medium", maxLevel: "high" },
				},
				{
					type: "custom",
					customType: "adaptive-thinking-state",
					data: { baseline: "turbo", override: null, scope: null, turnsRemaining: null },
				},
			],
		});
		await assertSessionFailsClosed(malformedBaseline, "invalid persisted baseline");

		for (const [label, stateEntry] of [
			["missing", { type: "custom", customType: "adaptive-thinking-state" }],
			["null", { type: "custom", customType: "adaptive-thinking-state", data: null }],
			["false", { type: "custom", customType: "adaptive-thinking-state", data: false }],
			["zero", { type: "custom", customType: "adaptive-thinking-state", data: 0 }],
			["empty string", { type: "custom", customType: "adaptive-thinking-state", data: "" }],
			["array", { type: "custom", customType: "adaptive-thinking-state", data: [] }],
		] as const) {
			const malformedPayload = createHarness({
				entries: [
					{
						type: "custom",
						customType: "pi-delegate-thinking-policy",
						data: { protocolVersion: 1, policyId: `bounded-${label}`, agentName: "worker", minLevel: "medium", maxLevel: "high" },
					},
					stateEntry,
				],
			});
			await assertSessionFailsClosed(malformedPayload, label);
		}
	});

  test("does not carry a prior delegated policy into a later ordinary session", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "low" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "transient-policy",
      agentName: "first-worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "high");

    await harness.emit("session_start");
    assert.equal(harness.thinkingLevel, "low");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 low · ceiling: config");
  });

  test("rejects every invalid policy shape without emitting an ACK", () => {
    const invalidPolicies = [
      { protocolVersion: 2, policyId: "bad-version", agentName: "worker" },
      { protocolVersion: 1, policyId: "reversed", agentName: "worker", minLevel: "high", maxLevel: "medium" },
      { protocolVersion: 1, policyId: "unknown-level", agentName: "worker", maxLevel: "ultra" },
      { protocolVersion: 1, policyId: "null-level", agentName: "worker", minLevel: null },
      { protocolVersion: 1, policyId: "empty-level", agentName: "worker", maxLevel: "" },
      { protocolVersion: 1, policyId: "impossible-baseline", agentName: "worker", baseline: "xhigh", maxLevel: "high" },
    ];
    for (const policy of invalidPolicies) {
      const harness = createHarness();
      harness.events.emit("pi-delegate:adaptive-thinking-policy", policy);
      assert.equal(
        harness.emittedEvents.some((event) => event.channel === "adaptive-thinking:pi-delegate-policy-accepted"),
        false,
        `invalid policy should not receive an ACK: ${JSON.stringify(policy)}`,
      );
    }
  });

  test("session_start reconstructs persisted state, applies it, and refreshes status", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      entries: [
        {
          type: "custom",
          customType: "adaptive-thinking-state",
          data: {
            baseline: "medium",
            override: "high",
            scope: "next_N",
            turnsRemaining: 2,
            reason: "persisted work",
            inAgentRun: false,
          },
        },
      ],
    });

    await harness.emit("session_start");

    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high ↑ (2 responses left) · ceiling: config");
  });

  test("agent overrides never widen ordinary configured authority during model fallback", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      model: {
        provider: "anthropic",
        id: "sparse-agent-fallback",
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null, max: "max" },
      },
    });
    await harness.emit("session_start");
    const result = await executeSetThinkingEffort(harness, { level: "xhigh", reason: "authority regression" });
    assert.equal(harness.thinkingLevel, "high");
    assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /medium.*high/);
    assert.equal(harness.setThinkingLevels.includes("max"), false);
  });

  test("before_agent_start injects bounded thinking prompt and GPT-specific guidance", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "medium", maxLevel: "high" });
    const harness = createHarness({ model: { provider: "openai", id: "gpt-5.5", reasoning: true } });
    await harness.emit("session_start");

    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /base prompt/);
    assert.match(systemPrompt, /<thinking-effort>/);
    assert.match(systemPrompt, /Allowed range: medium–high/);
    assert.match(systemPrompt, /Available levels: medium, high\./);
    assert.match(systemPrompt, /<thinking-effort-model-guidance model="openai\/gpt-5\.5" family="gpt">/);
    // The GPT profile leads with the family's published start level (medium) and carries dated provenance.
    assert.match(systemPrompt, /published start for coding and agentic work: medium/);
    assert.match(systemPrompt, /Guidance source:.*as of \d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(systemPrompt, /\*\*xhigh\*\*/);
  });

  test("system prompts expose max only after configured authority is widened", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "max" });
    const harness = createHarness({
      model: { provider: "openai", id: "gpt-5-max", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    });
    await harness.emit("session_start");

    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    assert.match(systemPrompt, /Allowed range: low–max/);
    assert.match(systemPrompt, /Available levels: low, medium, high, xhigh, max\./);
    assert.match(systemPrompt, /\*\*max\*\*/);
    // The per-model profile block reserves the top rung (max) once max is selectable.
    assert.match(systemPrompt, /Reserve the highest level \(max\)/);
  });

  test("clamps Pi's manual max level inside delegated bounds", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "medium" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "manual-max",
      agentName: "worker",
      baseline: "medium",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");
    await harness.emit("thinking_level_select", { level: "max" });
    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high · ceiling: delegate");
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /outside this session policy's bounds/);
  });

  test("corrects max when the delegated ceiling is below xhigh", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      model: {
        provider: "anthropic",
        id: "max-only-model",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "lower-max-echo",
      agentName: "worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");
    harness.setRawThinkingLevel("max");

    await harness.emit("thinking_level_select", { level: "max" });

    assert.equal(harness.thinkingLevel, "high");
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /outside this session policy's bounds/);
  });

  test("clamps distinct max at input and prompt gates to the xhigh policy ceiling", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "max",
      model: {
        provider: "anthropic",
        id: "max-only-model",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "max-early-gates",
      agentName: "worker",
      baseline: "xhigh",
      minLevel: "medium",
      maxLevel: "xhigh",
    });
    await harness.emit("session_start");
    harness.setRawThinkingLevel("max");

    assert.deepEqual(await harness.emit("input", { text: "continue" }), [{ action: "continue" }]);
    assert.equal(harness.thinkingLevel, "xhigh");
    harness.setRawThinkingLevel("max");
    await harness.emit("before_agent_start", { systemPrompt: "base" });

    assert.equal(harness.thinkingLevel, "xhigh");
    assert.equal(harness.shutdowns, 0);
  });

  test("corrects max at input and prompt gates below the xhigh ceiling", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "max",
      model: {
        provider: "anthropic",
        id: "max-only-model",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "max-lower-early-gates",
      agentName: "worker",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");
    harness.setRawThinkingLevel("max");

    assert.deepEqual(await harness.emit("input", { text: "continue" }), [{ action: "continue" }]);
    assert.equal(harness.thinkingLevel, "high");
    harness.setRawThinkingLevel("max");
    await harness.emit("before_agent_start", { systemPrompt: "base" });

    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.shutdowns, 0);
  });

  test("provider-adjacent gate accepts exact bounded state and fails closed on late range drift", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "medium" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "provider-adjacent-range",
      agentName: "worker",
      baseline: "medium",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");

    await harness.emit("before_provider_headers", { headers: {} });
    assert.equal(harness.shutdowns, 0, "an exact bounded level remains provider-safe");

    harness.setRawThinkingLevel("low");
    await harness.emit("before_provider_headers", { headers: {} });
    assert.equal(harness.shutdowns, 1, "late drift must fail closed instead of rewriting a built payload");
    assert.deepEqual(
      await harness.emit("input", { text: "must remain blocked", source: "rpc" }),
      [{ action: "handled" }],
    );
  });

  test("accepts max at session, input, prompt, and provider gates when configured and delegated bounds allow it", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "max" });
    const harness = createHarness({
      thinkingLevel: "max",
      model: {
        provider: "anthropic",
        id: "max-only-model",
        reasoning: true,
        thinkingLevelMap: { max: "max" },
      },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "max-baseline",
      agentName: "worker",
      baseline: "max",
      minLevel: "medium",
      maxLevel: "max",
    });

    await harness.emit("session_start");
    assert.deepEqual(await harness.emit("input", { text: "continue" }), [{ action: "continue" }]);
    await harness.emit("before_agent_start", { systemPrompt: "base" });
    await harness.emit("before_provider_headers", { headers: {} });
    assert.equal(harness.thinkingLevel, "max");
    assert.equal(harness.shutdowns, 0);
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 max · ceiling: config+delegate");
  });

  test("fails closed on late max drift when the delegated ceiling is xhigh", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "xhigh" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "late-distinct-max",
      agentName: "worker",
      baseline: "xhigh",
      minLevel: "medium",
      maxLevel: "xhigh",
    });
    await harness.emit("session_start");
    harness.setRawThinkingLevel("max");

    await harness.emit("before_provider_headers", { headers: {} });

    assert.equal(harness.shutdowns, 1);
  });

  test("before_agent_start guards force-adaptive models away from disabled thinking", async () => {
    writeConfig({ baseline: "off", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      thinkingLevel: "off",
      model: { provider: "anthropic", id: "claude-fable-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
    });

    await harness.emit("session_start");
    await harness.emit("before_agent_start", { systemPrompt: "base" });

    assert.equal(harness.thinkingLevel, "minimal");
  });

  test("rejects a later force-adaptive model switch that conflicts with off-only bounds", async () => {
    writeConfig({ baseline: "off", enabled: true, minLevel: "off", maxLevel: "off" });
    const harness = createHarness({ thinkingLevel: "off" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "off-only-model-switch",
      agentName: "worker",
      baseline: "off",
      minLevel: "off",
      maxLevel: "off",
    });
    await harness.emit("session_start");
    harness.ctx.model = { provider: "anthropic", id: "claude-fable-5", compat: { forceAdaptiveThinking: true } };
    const inputResults = await harness.emit("input", { text: "must not run", source: "rpc" });
    assert.deepEqual(inputResults, [{ action: "handled" }]);
    assert.equal(harness.shutdowns, 1);
    assert.equal(harness.thinkingLevel, "off", "model guard must not escape the worker range");
  });

  test("rejects bounded off-only policy for a model that requires adaptive thinking", async () => {
    writeConfig({ baseline: "off", enabled: true, minLevel: "off", maxLevel: "off" });
    const harness = createHarness({
      thinkingLevel: "off",
      model: { provider: "anthropic", id: "claude-fable-5", reasoning: true, compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { off: null, minimal: "minimal", low: null, medium: "medium", high: null, xhigh: null } },
    });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "off-only",
      agentName: "worker",
      baseline: "off",
      minLevel: "off",
      maxLevel: "off",
    });

    await harness.emit("session_start");
    assert.equal(harness.shutdowns, 1);
    assert.deepEqual(
      await harness.emit("input", { text: "must not run", source: "rpc" }),
      [{ action: "handled" }],
    );
  });
});

describe("foreground snapshot integration seam", () => {
  test("serves a versioned detached snapshot without config or prompt parsing", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      model: {
        provider: "anthropic",
        id: "adaptive-model",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      },
    });
    harness.events.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
      protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
      requestId: "before-session-start",
    });
    assert.equal(
      harness.emittedEvents.some((event) => event.channel === ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL),
      false,
      "the seam must not answer before session_start establishes coherent state",
    );
    await harness.emit("session_start");

    const snapshot = requestSnapshot(harness);
    assert.deepEqual(snapshot, {
      protocolVersion: 1,
      controlScope: "current-session",
      enabled: true,
      baseline: "medium",
      min: "low",
      max: "xhigh",
      effective: "medium",
      source: "baseline",
      scope: null,
      turnsRemaining: null,
      model: { provider: "anthropic", id: "adaptive-model" },
      modelSupportedLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      modelAgentSelectableLevels: ["low", "medium", "high", "xhigh"],
    });

    const responseCount = harness.emittedEvents.filter(
      (event) => event.channel === ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL,
    ).length;
    harness.events.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
      protocolVersion: 2,
      requestId: "unsupported-version",
    });
    assert.equal(
      harness.emittedEvents.filter((event) => event.channel === ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL).length,
      responseCount,
      "unknown protocol versions must be ignored",
    );

    await harness.emit("session_shutdown", { reason: "quit" });
    harness.events.emit(ADAPTIVE_THINKING_SNAPSHOT_REQUEST_CHANNEL, {
      protocolVersion: ADAPTIVE_THINKING_INTEGRATION_PROTOCOL_VERSION,
      requestId: "after-session-shutdown",
    });
    assert.equal(
      harness.emittedEvents.filter((event) => event.channel === ADAPTIVE_THINKING_SNAPSHOT_RESPONSE_CHANNEL).length,
      responseCount,
      "the seam must stop answering after session shutdown",
    );
  });

  test("keeps delegate-worker policy identity out of the generic session snapshot", async () => {
    writeConfig({ baseline: "low", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({ thinkingLevel: "low" });
    harness.events.emit("pi-delegate:adaptive-thinking-policy", {
      protocolVersion: 1,
      policyId: "private-worker-policy-id",
      agentName: "private-worker-name",
      baseline: "high",
      minLevel: "medium",
      maxLevel: "high",
    });
    await harness.emit("session_start");

    const snapshot = requestSnapshot(harness);
    assert.deepEqual(
      (({ baseline, min, max, effective, controlScope }) => ({ baseline, min, max, effective, controlScope }))(snapshot),
      { baseline: "high", min: "medium", max: "high", effective: "high", controlScope: "current-session" },
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /private-worker-policy-id|private-worker-name/);
  });

  test("notifies baseline, bounds, effective value, source, and override lifecycle changes", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    assert.deepEqual(
      changedSnapshots(harness).map(({ effective, source, scope, turnsRemaining }) => ({ effective, source, scope, turnsRemaining })),
      [{ effective: "medium", source: "baseline", scope: null, turnsRemaining: null }],
    );

    await executeSetThinkingEffort(harness, {
      level: "high",
      scope: "next_N",
      turns: 2,
      reason: "integration lifecycle",
    });
    await harness.emit("agent_end");
    await harness.emit("agent_end");
    harness.setRawThinkingLevel("low");
    await harness.emit("thinking_level_select", { level: "low" });
    await harness.commands.get("thinking-bounds")?.handler("low high", harness.ctx);
    await harness.commands.get("thinking-toggle")?.handler("", harness.ctx);

    const snapshots = changedSnapshots(harness);
    assert.deepEqual(
      snapshots.map(({ enabled, min, max, effective, source, scope, turnsRemaining }) => ({
        enabled,
        min,
        max,
        effective,
        source,
        scope,
        turnsRemaining,
      })),
      [
        { enabled: true, min: "low", max: "xhigh", effective: "medium", source: "baseline", scope: null, turnsRemaining: null },
        { enabled: true, min: "low", max: "xhigh", effective: "high", source: "agent", scope: "next_N", turnsRemaining: 2 },
        { enabled: true, min: "low", max: "xhigh", effective: "high", source: "agent", scope: "next_N", turnsRemaining: 1 },
        { enabled: true, min: "low", max: "xhigh", effective: "medium", source: "baseline", scope: null, turnsRemaining: null },
        { enabled: true, min: "low", max: "xhigh", effective: "low", source: "user", scope: null, turnsRemaining: null },
        { enabled: true, min: "low", max: "high", effective: "low", source: "user", scope: null, turnsRemaining: null },
        { enabled: false, min: "low", max: "high", effective: "low", source: "user", scope: null, turnsRemaining: null },
      ],
    );
  });

  test("manual user selection takes precedence over an agent override", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "high", reason: "temporary agent choice" });

    harness.setRawThinkingLevel("low");
    await harness.emit("thinking_level_select", { level: "low" });

    assert.deepEqual(requestSnapshot(harness), {
      protocolVersion: 1,
      controlScope: "current-session",
      enabled: true,
      baseline: "low",
      min: "low",
      max: "xhigh",
      effective: "low",
      source: "user",
      scope: null,
      turnsRemaining: null,
      model: null,
      modelSupportedLevels: [],
      modelAgentSelectableLevels: [],
    });
  });

  test("reports clamping and model incompatibility through the public snapshot", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "medium", maxLevel: "high" });
    const clamped = createHarness();
    await clamped.emit("session_start");
    await executeSetThinkingEffort(clamped, { level: "xhigh", reason: "bounded recommendation" });
    assert.deepEqual(
      (({ effective, source, min, max }) => ({ effective, source, min, max }))(requestSnapshot(clamped)),
      { effective: "high", source: "agent", min: "medium", max: "high" },
    );

    delete process.env.PI_ADAPTIVE_THINKING_POLICY;
    writeConfig({ baseline: "off", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const incompatible = createHarness({
      thinkingLevel: "off",
      model: {
        provider: "anthropic",
        id: "force-adaptive",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
        compat: { forceAdaptiveThinking: true },
      },
    });
    await incompatible.emit("session_start");
    const snapshot = requestSnapshot(incompatible);
    assert.equal(snapshot.effective, "minimal");
    assert.equal(snapshot.modelSupportedLevels.includes("off"), false);
  });

  test("emits model change notifications with the new capability set", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    const model = {
      provider: "example",
      id: "plain-model",
      reasoning: false,
    };
    harness.ctx.model = model;
    await harness.emit("model_select", { model, previousModel: undefined, source: "set" });

    const last = changedSnapshots(harness).at(-1);
    assert.ok(last);
    assert.deepEqual(last.model, { provider: "example", id: "plain-model" });
    assert.deepEqual(last.modelSupportedLevels, ["off"]);
  });
});

describe("set_thinking_effort tool behavior", () => {
  test("clamps above configured max, applies the clamped level, persists state, and reports details", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "medium", maxLevel: "high" });
    const harness = createHarness();
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "xhigh",
      reason: "testing clamped production behavior",
    });

    assert.equal(harness.thinkingLevel, "high");
    assert.deepEqual(result.details, {
      previous_level: "medium",
      new_level: "high",
      requested_level: "xhigh",
      was_clamped: true,
      scope: "this_response",
      turns_remaining: null,
      baseline: "medium",
      allowed_range: ["medium", "high"],
      reason: "testing clamped production behavior",
    });
    assert.match(JSON.stringify(result.content), /requested \\"xhigh\\" was clamped to \\"high\\"/);
    assert.equal(harness.appended.at(-1)?.customType, "adaptive-thinking-state");
    assert.equal(harness.appended.at(-1)?.data.override, "high");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 high ↑ (this response) · ceiling: config");
  });

  test("clamps max tool requests to the default xhigh ceiling", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "max",
      reason: "exercise default authority",
    });

    assert.deepEqual(
      (({ requested_level, new_level, was_clamped }) => ({ requested_level, new_level, was_clamped }))(
        result.details as { requested_level: string; new_level: string; was_clamped: boolean },
      ),
      { requested_level: "max", new_level: "xhigh", was_clamped: true },
    );
    assert.equal(harness.thinkingLevel, "xhigh");
    assert.equal(harness.appended.at(-1)?.data.override, "xhigh");
  });

  test("applies max tool requests when configured bounds explicitly allow max", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "max" });
    const harness = createHarness();
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "max",
      reason: "the user explicitly widened authority",
    });

    assert.deepEqual(
      (({ requested_level, new_level, was_clamped }) => ({ requested_level, new_level, was_clamped }))(
        result.details as { requested_level: string; new_level: string; was_clamped: boolean },
      ),
      { requested_level: "max", new_level: "max", was_clamped: false },
    );
    assert.equal(harness.thinkingLevel, "max");
    assert.equal(harness.appended.at(-1)?.data.override, "max");
  });

  test("rejects next_N without a positive turns count before mutating state", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "high",
      scope: "next_N",
      reason: "missing turns regression",
    });

    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { error: "missing turns" });
    assert.equal(harness.thinkingLevel, "medium");
    assert.equal(harness.appended.length, 0);
  });

  test("reports disabled mode without applying or persisting an override", async () => {
    writeConfig({ baseline: "medium", enabled: false, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "high",
      reason: "disabled regression",
    });

    assert.deepEqual(result.details, { error: "disabled" });
    assert.match(JSON.stringify(result.content), /currently disabled/);
    assert.equal(harness.thinkingLevel, "medium");
    assert.equal(harness.appended.length, 0);
  });

  test("rejects bounds that clamp to a non-agent-selectable level", async () => {
    writeConfig({ baseline: "off", enabled: true, minLevel: "off", maxLevel: "minimal" });
    const harness = createHarness({ thinkingLevel: "off" });
    await harness.emit("session_start");

    const result = await executeSetThinkingEffort(harness, {
      level: "low",
      reason: "non-agent bounds regression",
    });

    assert.equal(result.isError, true);
    assert.deepEqual(result.details, {
      error: "unavailable",
      model: null,
      allowed: ["off", "minimal"],
    });
    assert.match((result.content as Array<{ text?: string }>)[0]?.text ?? "", /thinking effort cannot be adjusted/);
    assert.equal(harness.thinkingLevel, "off");
  });

  test("agent_end decays this_response overrides back to baseline", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "high", reason: "one response" });

    await harness.emit("agent_end");

    assert.equal(harness.thinkingLevel, "medium");
    assert.equal(harness.appended.at(-1)?.data.override, null);
    assert.equal(harness.appended.at(-1)?.data.scope, null);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Thinking reverted: high → medium/);
  });

  test("agent_end counts down next_N overrides and reverts only when exhausted", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, {
      level: "high",
      scope: "next_N",
      turns: 2,
      reason: "two turn regression",
    });

    await harness.emit("agent_end");
    assert.equal(harness.thinkingLevel, "high");
    assert.equal(harness.appended.at(-1)?.data.override, "high");
    assert.equal(harness.appended.at(-1)?.data.turnsRemaining, 1);

    await harness.emit("agent_end");
    assert.equal(harness.thinkingLevel, "medium");
    assert.equal(harness.appended.at(-1)?.data.override, null);
    assert.equal(harness.appended.at(-1)?.data.turnsRemaining, null);
  });
});

describe("manual selection and command behavior", () => {
  test("keeps an ordinary-session manual max stable and observable without mutating global config", async () => {
    const original = { baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" };
    writeConfig(original);
    const harness = createHarness();
    await harness.emit("session_start");
    harness.setRawThinkingLevel("max");

    await harness.emit("thinking_level_select", { level: "max" });

    assert.equal(harness.thinkingLevel, "max");
    assert.deepEqual(readConfig(), original);
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 max · ceiling: config");
    assert.deepEqual(
      (({ baseline, effective, source }) => ({ baseline, effective, source }))(requestSnapshot(harness)),
      { baseline: "max", effective: "max", source: "user" },
    );
  });

  test("manual thinking selection becomes the baseline and writes config", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "high", reason: "clear me" });

    await harness.emit("thinking_level_select", { level: "low" });

    assert.equal(readConfig().baseline, "low");
    assert.equal(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level"), "🧠 low · ceiling: config");
  });

  test("manual off selection is redirected for force-adaptive models without adopting off as baseline", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness({
      model: { provider: "anthropic", id: "claude-fable-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
    });
    await harness.emit("session_start");

    await harness.emit("thinking_level_select", { level: "off" });

    assert.equal(harness.thinkingLevel, "minimal");
    assert.equal(readConfig().baseline, "medium");
    assert.equal(
      harness.ctx.ui.notifications.some((entry) => /not supported/.test(entry.message)),
      false,
      "the redirect is expected on force-adaptive models and must not warn on every thinking cycle",
    );
    assert.match(harness.ctx.ui.statuses.get("caair.adaptive-thinking/level") ?? "", /minimal/);
    await harness.commands.get("thinking-status")?.handler("", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Effective level: minimal/);
  });

  test("thinking-baseline status, invalid input, and set paths are observable", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    const command = harness.commands.get("thinking-baseline");
    assert.ok(command);

    assert.ok(command.getArgumentCompletions?.("sta")?.some((item) => item.value === "status"));
    await command.handler("status", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Baseline: medium/);

    await command.handler("turbo", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Usage: \/thinking-baseline/);

    await command.handler("max", harness.ctx);
    assert.equal(readConfig().baseline, "max");
    assert.equal(readConfig().maxLevel, "xhigh", "manual baseline selection must not widen agent authority");
    assert.equal(harness.thinkingLevel, "max");

    await command.handler("high", harness.ctx);
    assert.equal(readConfig().baseline, "high");
    assert.equal(harness.thinkingLevel, "high");
  });

  test("thinking-bounds validates input and clamps an active override when bounds shrink", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "xhigh", scope: "until_changed", reason: "clamp active override" });
    const command = harness.commands.get("thinking-bounds");
    assert.ok(command);

    assert.ok(command.getArgumentCompletions?.("medium")?.some((item) => item.value === "medium high"));
    await command.handler("status", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Allowed levels: low, medium, high, xhigh/);

    await command.handler("medium", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Usage: \/thinking-bounds/);

    await command.handler("turbo high", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Invalid level/);

    await command.handler("max high", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /must be ≤/);

    await command.handler("xhigh low", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /must be ≤/);

    await command.handler("low max", harness.ctx);
    assert.equal(readConfig().maxLevel, "max");
    await executeSetThinkingEffort(harness, {
      level: "max",
      scope: "until_changed",
      reason: "exercise bounds command max authority",
    });
    assert.equal(harness.thinkingLevel, "max");

    await command.handler("medium high", harness.ctx);
    assert.equal(readConfig().minLevel, "medium");
    assert.equal(readConfig().maxLevel, "high");
    assert.equal(harness.thinkingLevel, "high");
    assert.match(harness.ctx.ui.notifications.at(-2)?.message ?? "", /Active override max clamped to high/);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Bounds set: medium–high/);
  });

  test("thinking-status, reset, and toggle report state and mutate safely", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "medium", maxLevel: "high" });
    const harness = createHarness();
    await harness.emit("session_start");
    await executeSetThinkingEffort(harness, { level: "high", scope: "next_N", turns: 2, reason: "status regression" });

    await harness.commands.get("thinking-status")?.handler("", harness.ctx);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Override: high/);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Scope: next_N/);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Turns remaining: 2/);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /Bounds: medium–high/);

    await harness.commands.get("thinking-reset")?.handler("", harness.ctx);
    assert.equal(harness.thinkingLevel, "medium");
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /override cleared/);

    await harness.commands.get("thinking-toggle")?.handler("", harness.ctx);
    assert.equal(readConfig().enabled, false);
    assert.match(harness.ctx.ui.notifications.at(-1)?.message ?? "", /disabled/);
  });

  test("uses the qualified status key for a formatted footer value", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();

    await harness.emit("session_start");

    assert.deepEqual(harness.statusUpdates.at(-1), {
      slot: "caair.adaptive-thinking/level",
      value: "🧠 medium · ceiling: config",
    });
    assert.equal(harness.ctx.ui.statuses.has("adaptive-thinking"), false);
  });

  test("clears the status with undefined when the session shuts down", async () => {
    writeConfig({ baseline: "medium", enabled: true, minLevel: "low", maxLevel: "xhigh" });
    const harness = createHarness();
    await harness.emit("session_start");

    await harness.emit("session_shutdown");

    assert.deepEqual(harness.statusUpdates.at(-1), { slot: "caair.adaptive-thinking/level", value: undefined });
  });
});
