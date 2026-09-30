import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parse as parseYaml } from "yaml";
import { createPiDevExtension } from "../index.ts";
import { devModeGuidance } from "../src/dev-mode.ts";
import { EventTraceBuffer } from "../src/event-trace.ts";
import {
  collectObservableSources,
  formatContextInspection,
  formatExtensionsInspection,
  formatPromptInspection,
  formatToolsInspection,
} from "../src/inspect.ts";
import { runDemoAction } from "../src/demo.ts";
import { UiDemoController } from "../src/ui-demo.ts";
import {
  createTextPresenter,
  defaultTextPresenter,
  PI_DEV_PRESENTATION_ENTRY,
  registerTextPresentationRenderer,
  terminalSafeText,
  wrapTerminalSafeText,
} from "../src/presenter.ts";
import { formatDoctor, runDoctor } from "../src/doctor.ts";

function event(value: object): ExtensionEvent {
  return value as ExtensionEvent;
}

test("event tracing is opt-in, bounded, and retains only explicitly allowed metadata", () => {
  let tick = 0;
  const trace = new EventTraceBuffer({ capacity: 2, now: () => new Date(`2026-01-01T00:00:0${tick++}.000Z`) });

  trace.record(event({ type: "input", text: "prompt SECRET_TOKEN", source: "interactive", images: [{ data: "BASE64_SECRET" }] }));
  assert.deepEqual(trace.records(), []);

  trace.setEnabled(true);
  trace.record(event({ type: "input", text: "prompt SECRET_TOKEN", source: "interactive", images: [{ data: "BASE64_SECRET" }] }));
  trace.record(event({ type: "before_provider_request", payload: { authorization: "Bearer SECRET", messages: ["private"] } }));
  trace.record(event({ type: "tool_execution_end", toolCallId: "secret-call-id", toolName: "read", result: { content: "SECRET_RESULT" }, isError: false }));

  const records = trace.records();
  assert.equal(trace.capacity, 2);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.event), ["before_provider_request", "tool_execution_end"]);
  assert.deepEqual(records[0]?.metadata, {});
  assert.deepEqual(records[1]?.metadata, { toolName: "read", isError: false });
  assert.doesNotMatch(JSON.stringify(records), /SECRET|Bearer|private|secret-call-id|authorization|messages|payload|result/i);
});

test("event tracing always normalizes capacity to a finite bounded integer", () => {
  const cases = [
    [Number.NaN, 200],
    [Number.POSITIVE_INFINITY, 200],
    [Number.NEGATIVE_INFINITY, 200],
    [0, 1],
    [-5, 1],
    [4.9, 4],
    [50_000, 1_000],
  ] as const;
  for (const [requested, expected] of cases) {
    const trace = new EventTraceBuffer({ capacity: requested });
    trace.setEnabled(true);
    for (let index = 0; index < 1_500; index += 1) trace.record(event({ type: "agent_start" }));
    assert.equal(trace.capacity, expected);
    assert.equal(trace.records().length, expected);
  }
});

test("event tracing allowlists lifecycle counts and state without copying event objects", () => {
  const trace = new EventTraceBuffer({ capacity: 10, now: () => new Date("2026-01-01T00:00:00.000Z") });
  trace.setEnabled(true);
  trace.record(event({
    type: "session_before_compact",
    reason: "threshold",
    willRetry: true,
    branchEntries: [{ message: { content: "PRIVATE" } }],
    preparation: { systemPrompt: "SECRET" },
    customInstructions: "SECRET",
  }));
  trace.record(event({
    type: "after_provider_response",
    status: 429,
    headers: { "set-cookie": "credential", authorization: "secret" },
  }));
  trace.record(event({
    type: "model_select",
    source: "set",
    model: { provider: "openai", id: "gpt-test", apiKey: "SECRET" },
    previousModel: undefined,
  }));

  assert.deepEqual(trace.records().map((record) => record.metadata), [
    { reason: "threshold", willRetry: true, branchEntryCount: 1 },
    { status: 429 },
    { provider: "openai", modelId: "gpt-test", source: "set" },
  ]);
  assert.doesNotMatch(JSON.stringify(trace.records()), /PRIVATE|SECRET|cookie|authorization|apiKey/);
});

test("event tracing records failed compaction state without retaining the error message", () => {
  const trace = new EventTraceBuffer({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  trace.setEnabled(true);
  trace.record(event({
    type: "session_compact_failed",
    reason: "overflow",
    errorMessage: "SECRET provider response",
    aborted: false,
    willRetry: true,
    fromExtension: true,
  }));

  assert.deepEqual(trace.records()[0]?.metadata, {
    reason: "overflow",
    aborted: false,
    willRetry: true,
    fromExtension: true,
  });
  assert.doesNotMatch(JSON.stringify(trace.records()), /SECRET|provider response|errorMessage/i);
});

test("tool inspection uses the runtime active set and emits exact public schemas", () => {
  const pi = {
    getActiveTools: () => ["read"],
    getAllTools: () => [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        promptGuidelines: ["Read before editing"],
        sourceInfo: { path: "/pkg/read.ts", source: "pi", scope: "user", origin: "package", baseDir: "/pkg" },
      },
      {
        name: "write",
        description: "Write a file",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
        sourceInfo: { path: "/pkg/write.ts", source: "pi", scope: "user", origin: "package", baseDir: "/pkg" },
      },
    ],
  };

  const active = formatToolsInspection(pi as never, "active");
  assert.match(active, /Active tools \(1\): read/);
  assert.match(active, /Parameters schema \(YAML rendering of exact public ToolInfo\.parameters\):/);
  assert.match(active, /additionalProperties: false/);
  assert.match(active, /required:\n\s+- path/);
  assert.doesNotMatch(active, /"additionalProperties"|Write a file/);
  const renderedSchema = active.split("Parameters schema (YAML rendering of exact public ToolInfo.parameters):\n")[1];
  assert.deepEqual(parseYaml(renderedSchema ?? ""), pi.getAllTools()[0]?.parameters);

  const all = formatToolsInspection(pi as never, "all");
  assert.match(all, /inactive/);
  assert.match(all, /Write a file/);
});

test("prompt and context inspection use the effective public runtime views", () => {
  const prompt = "system prompt\n<injected>exact</injected>";
  assert.equal(formatPromptInspection({ getSystemPrompt: () => prompt }), prompt);
  assert.equal(
    formatPromptInspection({ getSystemPrompt: () => prompt }, { getFlag: () => false }),
    prompt,
  );

  const active = formatPromptInspection({ getSystemPrompt: () => prompt }, { getFlag: () => true });
  assert.equal(active, `${prompt}\n\n${devModeGuidance()}`);
  assert.equal(
    formatPromptInspection({ getSystemPrompt: () => active }, { getFlag: () => true }),
    active,
    "inspection must not duplicate guidance already present on a live turn",
  );

  const report = formatContextInspection({
    getContextUsage: () => ({ tokens: 321, contextWindow: 10_000, percent: 3.21 }),
    sessionManager: {
      buildContextEntries: () => [{
        type: "message",
        id: "kept",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "effective after compaction", timestamp: 0 },
      }],
    },
    model: { provider: "openai", id: "gpt-test" },
  } as never);
  assert.match(report, /effective after compaction/);
  assert.match(report, /entryCount: 1/);
  assert.match(report, /tokens: 321/);
  assert.doesNotMatch(report, /"entryCount"|all session branches/i);
  const parsed = parseYaml(report) as { entryCount: number; usage: { tokens: number }; effectiveMessages: Array<{ content: string }> };
  assert.equal(parsed.entryCount, 1);
  assert.equal(parsed.usage.tokens, 321);
  assert.equal(parsed.effectiveMessages[0]?.content, "effective after compaction");
});

test("extension inspection groups only public source metadata and reports observable package versions", () => {
  const sourceInfo = { path: "/packages/sample/index.ts", source: "/packages/sample", scope: "user" as const, origin: "package" as const, baseDir: "/packages/sample" };
  const sources = collectObservableSources({
    getAllTools: () => [{ name: "sample_tool", description: "sample", parameters: { type: "object" } as never, sourceInfo }],
    getCommands: () => [{ name: "sample", description: "sample", source: "extension", sourceInfo }],
  }, (directory) => {
    assert.equal(directory, "/packages/sample");
    return JSON.stringify({ name: "sample-package", version: "1.2.3", private: true, token: "must-not-leak" });
  });

  assert.deepEqual(sources, [{
    path: "/packages/sample/index.ts",
    source: "/packages/sample",
    scope: "user",
    origin: "package",
    baseDir: "/packages/sample",
    version: "1.2.3",
    tools: ["sample_tool"],
    commands: ["sample"],
  }]);
  const report = formatExtensionsInspection(sources, { pi: "0.80.10", piDev: "0.1.0" });
  assert.match(report, /Pi 0\.80\.10/);
  assert.match(report, /pi-dev 0\.1\.0/);
  assert.match(report, /sample_tool/);
  assert.match(report, /1\.2\.3/);
  assert.doesNotMatch(report, /must-not-leak|token/);
  assert.match(report, /observable/i);
});

test("session-entry presentation renders tools in main chat without entering model context", async () => {
  const entries: Array<{ customType: string; data: unknown }> = [];
  let renderer: ((entry: { data?: unknown }, options: { expanded: boolean; outputPad: number }, theme: unknown) => { render(width: number): string[] }) | undefined;
  const pi = {
    appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); },
    registerEntryRenderer: (_customType: string, candidate: typeof renderer) => { renderer = candidate; },
  } as never;
  registerTextPresentationRenderer(pi);
  const present = createTextPresenter(pi);
  let customUiCalls = 0;
  const ctx = {
    mode: "tui",
    ui: { custom: async () => { customUiCalls += 1; } },
  } as never;

  await present(ctx, {
    title: "Agent-visible tools",
    body: "schema\u001b[31m\n{  two spaces  }",
    delivery: "session-entry",
  });

  assert.equal(customUiCalls, 0);
  assert.deepEqual(entries, [{
    customType: PI_DEV_PRESENTATION_ENTRY,
    data: {
      version: 1,
      title: "Agent-visible tools",
      body: "schema\u001b[31m\n{  two spaces  }",
      warning: false,
    },
  }]);
  assert.ok(renderer);
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const lines = renderer(entries[0] as never, { expanded: true, outputPad: 1 }, theme as never).render(12);
  const rendered = lines.join("\n");
  const rejoined = lines.join("");
  assert.match(rejoined, /Agent-visible tools/);
  assert.match(rejoined, /schema\\x1b\[31m/);
  assert.match(rejoined, /\{ {2}two spaces {2}\}/);
  assert.equal(rendered.includes("\u001b"), false);
});

test("text presentation makes terminal controls inert and wraps without losing wide or long content", () => {
  const source = "alpha\u001b[31m SECRET\t中文日本語-abcdefghijklmnopqrstuvwxyz";
  const safe = terminalSafeText(source);
  assert.equal(safe, "alpha\\x1b[31m SECRET\\t中文日本語-abcdefghijklmnopqrstuvwxyz");
  assert.equal(safe.includes("\u001b"), false);
  assert.equal(safe.includes("\t"), false);
  const lines = wrapTerminalSafeText(source, 8);
  assert.ok(lines.length > 2);
  assert.ok(lines.every((line) => line.length > 0));
  assert.equal(lines.join(""), safe);
});

test("temporary text presentation paints an opaque full-width overlay background", async () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
    bold: (text: string) => text,
  };
  let rendered: string[] = [];
  let copied = "";
  const notifications: Array<{ message: string; type?: string }> = [];
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const ctx = {
    mode: "tui",
    ui: {
      notify: (message: string, type?: string) => { notifications.push({ message, ...(type ? { type } : {}) }); },
      custom: async (
        factory: (
          tui: { requestRender(): void },
          themeValue: typeof theme,
          keybindings: object,
          done: (value: undefined) => void,
        ) => { render(width: number): string[]; handleInput(data: string): void },
        options: { overlay?: boolean },
      ) => {
        assert.equal(options.overlay, true);
        component = factory({ requestRender() {} }, theme, {}, () => {});
        rendered = component.render(32);
      },
    },
  } as never;

  await defaultTextPresenter(ctx, {
    title: "Overlay title",
    body: "short body",
    onCopy: async (text) => { copied = text; },
  });

  assert.ok(rendered.length > 0);
  assert.ok(rendered.every((line) => line.includes("\u001b[48;5;236m")));
  assert.ok(rendered.every((line) => visibleWidth(line) === 32));
  assert.ok(component);
  component.handleInput("c");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(copied, "short body");
  assert.deepEqual(notifications, [{ message: "Copied viewer contents to clipboard.", type: "info" }]);
  assert.match(component.render(32).join("\n"), /c copy/);

  await defaultTextPresenter(ctx, {
    title: "Overlay title",
    body: "short body",
    onCopy: async () => { throw new Error("clipboard unavailable"); },
  });
  assert.ok(component);
  component.handleInput("c");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications.at(-1), { message: "clipboard unavailable", type: "error" });
});

test("custom overlay demonstration paints an opaque full-width background", async () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => `\u001b[48;5;236m${text}\u001b[49m`,
  };
  let rendered: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (
        factory: (
          tui: object,
          themeValue: typeof theme,
          keybindings: object,
          done: (value: undefined) => void,
        ) => { render(width: number): string[] },
        options: { overlay?: boolean },
      ) => {
        assert.equal(options.overlay, true);
        const component = factory({}, theme, {}, () => {});
        rendered = component.render(36);
      },
    },
  } as never;

  await runDemoAction("overlay", {} as never, ctx, async () => {});

  assert.ok(rendered.length > 0);
  assert.ok(rendered.every((line) => line.includes("\u001b[48;5;236m")));
  assert.ok(rendered.every((line) => visibleWidth(line) === 36));
});

test("all demo mode announces and completes every step in sequence", async () => {
  const events: string[] = [];
  const pi = {
    sendMessage: () => { events.push("message"); },
    appendEntry: () => { events.push("entry"); },
  } as never;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (message: string) => { events.push(`notice:${message}`); },
      setStatus: (key: string, value: string | undefined) => { events.push(`status:${key}:${value ?? "cleared"}`); },
      select: async () => { events.push("select"); return "alpha"; },
      input: async () => { events.push("input"); return "sample"; },
      confirm: async () => { events.push("confirm"); return true; },
      custom: async () => { events.push("overlay"); },
    },
  } as never;
  const present = async (_ctx: never, presentation: { title: string }): Promise<void> => {
    events.push(`present:${presentation.title}`);
  };

  await runDemoAction("all", pi, ctx, present as never);

  assert.deepEqual(events.filter((item) => !item.startsWith("notice:") && !item.startsWith("status:")), [
    "message",
    "entry",
    "present:pi_dev_demo result",
    "select",
    "input",
    "confirm",
    "present:pi-dev dialog results",
    "overlay",
  ]);
  for (let step = 1; step <= 5; step += 1) {
    assert.ok(events.some((item) => item.startsWith(`notice:pi-dev demo ${step}/5:`)));
    assert.ok(events.some((item) => item.startsWith(`status:caair.pi-dev/demo:${step}/5`)));
  }
  assert.ok(events.includes("status:caair.pi-dev/demo:cleared"));
  assert.equal(events.at(-1), "notice:pi-dev demo complete.");
});

test("UI demo toggles every supported marker and clears modifications cleanly", () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const method = (name: string) => (...args: unknown[]) => { calls.push({ method: name, args }); };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setHeader: method("setHeader"),
      setFooter: method("setFooter"),
      setStatus: method("setStatus"),
      setWidget: method("setWidget"),
      setTitle: method("setTitle"),
      setWorkingMessage: method("setWorkingMessage"),
      setWorkingIndicator: method("setWorkingIndicator"),
      setHiddenThinkingLabel: method("setHiddenThinkingLabel"),
    },
  } as never;
  const controller = new UiDemoController();

  const enabled = controller.handle("on", ctx);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);
  assert.match(enabled.message, /cannot preserve global UI factories/);
  assert.equal(controller.isEnabled(), true);
  assert.ok(calls.some((call) => call.method === "setHeader" && typeof call.args[0] === "function"));
  assert.ok(calls.some((call) => call.method === "setFooter" && typeof call.args[0] === "function"));
  assert.deepEqual(
    calls.filter((call) => call.method === "setStatus" || call.method === "setWidget").map((call) => call.args),
    [
      ["caair.pi-dev/ui", "dev UI on"],
      ["caair.pi-dev/above", ["[pi-dev] above-editor widget"], { placement: "aboveEditor" }],
      ["caair.pi-dev/below", ["[pi-dev] below-editor widget"], { placement: "belowEditor" }],
    ],
  );
  assert.ok(calls.some((call) => call.method === "setTitle" && call.args[0] === "pi-dev UI demo"));
  assert.ok(calls.some((call) => call.method === "setWorkingMessage" && call.args[0] === "pi-dev working area"));

  calls.length = 0;
  const disabled = controller.handle("off", ctx);
  assert.deepEqual(disabled, { enabled: false, changed: true, message: "Pi development UI markers cleared." });
  assert.equal(controller.isEnabled(), false);
  assert.ok(calls.some((call) => call.method === "setHeader" && call.args[0] === undefined));
  assert.ok(calls.some((call) => call.method === "setFooter" && call.args[0] === undefined));
  assert.deepEqual(
    calls.filter((call) => call.method === "setStatus" || call.method === "setWidget").map((call) => call.args),
    [
      ["caair.pi-dev/ui", undefined],
      ["caair.pi-dev/above", undefined],
      ["caair.pi-dev/below", undefined],
    ],
  );
  assert.ok(calls.some((call) => call.method === "setTitle" && call.args[0] === "pi"));
  assert.ok(calls.some((call) => call.method === "setWorkingMessage" && call.args.length === 0));
  assert.ok(calls.some((call) => call.method === "setWorkingIndicator" && call.args.length === 0));
  assert.ok(calls.some((call) => call.method === "setHiddenThinkingLabel" && call.args.length === 0));
});

test("UI demo reports unsupported modes without mutating UI", () => {
  let mutated = false;
  const ctx = { mode: "print", hasUI: false, ui: new Proxy({}, { get: () => () => { mutated = true; } }) } as never;
  const controller = new UiDemoController();
  assert.deepEqual(controller.handle("on", ctx), {
    enabled: false,
    changed: false,
    message: "The UI demonstration requires TUI mode.",
  });
  assert.equal(mutated, false);
});

test("doctor reports supported API and session success without prompt content", async () => {
  const pi = {
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read" }],
    getCommands: () => [{ name: "dev" }],
  } as never;
  const ctx = {
    cwd: "/tmp/project",
    getSystemPrompt: () => "TOP SECRET PROMPT",
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    sessionManager: {
      getSessionFile: () => "/tmp/agent/sessions/project/current.jsonl",
      getSessionId: () => "session-1",
      getSessionDir: () => "/tmp/agent/sessions/project",
      buildContextEntries: () => [],
    },
  } as never;
  const checks = await runDoctor(pi, ctx, {
    pathExists: () => true,
    piVersion: "0.80.10",
  });
  assert.ok(checks.every((check) => check.status === "pass"));
  const report = formatDoctor(checks);
  assert.match(report, /Pi runtime APIs/);
  assert.match(report, /Current session/);
  assert.doesNotMatch(report, /TOP SECRET PROMPT/);
});

test("doctor reports a missing session without optional-integration checks", async () => {
  const checks = await runDoctor({ getActiveTools: () => [], getAllTools: () => [], getCommands: () => [] } as never, {
    cwd: "/tmp/project",
    getSystemPrompt: () => "secret",
    getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "memory", getSessionDir: () => "/tmp/sessions" },
  } as never, {
    pathExists: () => false,
    piVersion: "0.80.10",
  });
  assert.equal(checks.find((check) => check.name === "Current session")?.status, "fail");
  assert.equal(checks.some((check) => /artifact|lineage|transcript/i.test(`${check.name} ${check.detail}`)), false);
});

test("doctor returns structured failures when runtime path APIs themselves are unavailable", async () => {
  const checks = await runDoctor({} as never, {
    cwd: "/tmp/project",
    sessionManager: {},
  } as never, {
    pathExists: () => false,
    piVersion: "0.80.10",
  });
  assert.equal(checks.find((check) => check.name === "Pi runtime APIs")?.status, "fail");
  assert.equal(checks.find((check) => check.name === "Current session")?.status, "fail");
  assert.deepEqual(checks.map((check) => check.name), ["Package versions", "Extension-authoring mode", "Pi runtime APIs", "Current session"]);
});

test("extension registers one /dev hub, demo surfaces, completions, and privacy-safe event dispatch", async () => {
  const commands = new Map<string, Record<string, unknown>>();
  const shortcuts = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (event: ExtensionEvent, ctx: unknown) => unknown>();
  const tools: Array<Record<string, unknown>> = [];
  const messageRenderers: string[] = [];
  const entryRenderers: string[] = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const presentations: Array<{ title: string; body: string; warning?: boolean; delivery?: "viewer" | "session-entry"; onCopy?: (text: string) => Promise<void> }> = [];
  const copiedPrompts: string[] = [];
  const writtenPrompts: Array<{ file: string; data: string }> = [];
  const usageOpens: Array<{ optionsProvided: boolean }> = [];
  const toolInfo = [{
    name: "read",
    description: "Read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sourceInfo: { path: "/pi/read.ts", source: "pi", scope: "user", origin: "package", baseDir: "/pi" },
  }];
  const pi = {
    registerCommand: (name: string, options: Record<string, unknown>) => { commands.set(name, options); },
    registerShortcut: (name: string, options: Record<string, unknown>) => { shortcuts.set(name, options); },
    registerFlag: () => {},
    getFlag: () => false,
    registerTool: (definition: Record<string, unknown>) => { tools.push(definition); },
    registerMessageRenderer: (name: string) => { messageRenderers.push(name); },
    registerEntryRenderer: (name: string) => { entryRenderers.push(name); },
    on: (name: string, handler: (event: ExtensionEvent, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    getActiveTools: () => ["read"],
    getAllTools: () => toolInfo,
    getCommands: () => [],
    sendMessage: () => {},
    appendEntry: () => {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  createPiDevExtension({
    present: async (_ctx, presentation) => { presentations.push(presentation); },
    openContextUsage: async (_ctx, options) => { usageOpens.push({ optionsProvided: options !== undefined }); },
    doctor: {
      pathExists: () => false,
      piVersion: "0.80.10",
    },
    readPackageJson: () => JSON.stringify({ version: "1.0.0" }),
    copyToClipboard: async (text: string) => { copiedPrompts.push(text); },
    writeFile: async (file: string, data: string) => { writtenPrompts.push({ file, data }); },
  })(pi);

  assert.deepEqual([...commands.keys()], ["dev"]);
  assert.deepEqual([...shortcuts.keys()], ["ctrl+shift+u"]);
  const demoTool = tools.find((tool) => tool.name === "pi_dev_demo");
  assert.ok(demoTool);
  const executeDemoTool = demoTool.execute as (id: string, args: { text: string; uppercase?: boolean }) => Promise<{ content: Array<{ text: string }> }>;
  const demoToolResult = await executeDemoTool("call-1", { text: "agent tool", uppercase: true });
  assert.equal(demoToolResult.content[0]?.text, "pi-dev demo echo: AGENT TOOL");
  assert.deepEqual(messageRenderers, ["pi-dev-demo-message"]);
  assert.deepEqual(entryRenderers, ["pi-dev-demo-entry", PI_DEV_PRESENTATION_ENTRY]);
  assert.equal(handlers.has("project_trust"), false);
  assert.ok(handlers.has("input"));
  assert.ok(handlers.has("session_start"));

  const command = commands.get("dev") as {
    handler: (args: string, ctx: unknown) => Promise<void>;
    getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }>;
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/project",
    model: { provider: "openai", id: "gpt-test" },
    ui: { notify: (message: string, type?: string) => { notices.push({ message, ...(type ? { type } : {}) }); } },
    getSystemPrompt: () => "EFFECTIVE SYSTEM PROMPT",
    getSystemPromptOptions: () => ({ cwd: "/tmp/project", selectedTools: ["read"] }),
    getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    sessionManager: {
      buildContextEntries: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => "session",
      getSessionDir: () => "/tmp/sessions",
    },
  };

  await command.handler("", ctx);
  assert.match(presentations.at(-1)?.body ?? "", /\/dev tools/);
  await command.handler("--help", ctx);
  assert.match(presentations.at(-1)?.body ?? "", /\/dev doctor/);
  assert.doesNotMatch(presentations.at(-1)?.body ?? "", /\/dev transcript/);
  assert.match(presentations.at(-1)?.body ?? "", /\/dev usage/);
  await command.handler("usage", ctx);
  assert.deepEqual(usageOpens, [{ optionsProvided: true }]);
  const usageShortcut = shortcuts.get("ctrl+shift+u") as { handler: (ctx: unknown) => Promise<void> };
  await usageShortcut.handler(ctx);
  assert.deepEqual(usageOpens, [{ optionsProvided: true }, { optionsProvided: false }]);
  await command.handler("tools", ctx);
  assert.match(presentations.at(-1)?.body ?? "", /Parameters schema/);
  assert.equal(presentations.at(-1)?.delivery, "session-entry");
  await command.handler("prompt", ctx);
  assert.equal(presentations.at(-1)?.body, "EFFECTIVE SYSTEM PROMPT");
  const promptPresentation = presentations.at(-1);
  assert.ok(promptPresentation?.onCopy, "prompt viewer must expose a clipboard action");
  await promptPresentation?.onCopy?.(promptPresentation.body);
  assert.deepEqual(copiedPrompts, ["EFFECTIVE SYSTEM PROMPT"]);
  await command.handler("prompt --write /tmp/effective-system-prompt.txt", ctx);
  assert.deepEqual(writtenPrompts, [{ file: "/tmp/effective-system-prompt.txt", data: "EFFECTIVE SYSTEM PROMPT" }]);
  assert.match(notices.at(-1)?.message ?? "", /wrote effective system prompt to \/tmp\/effective-system-prompt\.txt/);

  await command.handler("events on", ctx);
  await handlers.get("input")?.(event({ type: "input", text: "SECRET PROMPT", source: "interactive" }), ctx);
  await command.handler("events show 10", ctx);
  const eventBody = presentations.at(-1)?.body ?? "";
  assert.match(eventBody, /event: input/);
  assert.doesNotMatch(eventBody, /"event"|SECRET PROMPT/);
  const eventDisplay = parseYaml(eventBody) as { records: Array<{ event: string; metadata: { source: string } }> };
  assert.equal(eventDisplay.records[0]?.event, "input");
  assert.equal(eventDisplay.records[0]?.metadata.source, "interactive");

  await command.handler("does-not-exist", ctx);
  assert.equal(notices.at(-1)?.type, "error");
  assert.match(notices.at(-1)?.message ?? "", /Unknown \/dev subcommand/);
  for (const [args, expected] of [
    ["tools 'unterminated", /Unterminated quoted argument/],
    ["prompt extra", /Unexpected arguments/],
    ["events show 0", /positive integer/],
    ["events show 1 extra", /Unexpected arguments/],
  ] as const) {
    await command.handler(args, ctx);
    assert.equal(notices.at(-1)?.type, "error");
    assert.match(notices.at(-1)?.message ?? "", expected);
  }

  assert.deepEqual(command.getArgumentCompletions("tr"), []);
  const rootCompletions = command.getArgumentCompletions("to");
  assert.ok(rootCompletions.some((item) => item.value === "tools"));
  const eventCompletions = command.getArgumentCompletions("events c");
  assert.ok(eventCompletions.some((item) => item.value === "events clear"));
});
