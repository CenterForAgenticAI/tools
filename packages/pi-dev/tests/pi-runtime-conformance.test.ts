import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Container, type TUI, type Component } from "@earendil-works/pi-tui";
import { TuiMainScreen } from "@earendil-works/pi-tui/dist/tui-main-screen.js";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const runtimeIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const runtimeDist = dirname(runtimeIndex);
const runtimePackage = JSON.parse(readFileSync(join(runtimeDist, "../package.json"), "utf8")) as { version: string };
const runtimeModule = (relativePath: string) => import(pathToFileURL(join(runtimeDist, relativePath)).href);
const [{ ExtensionRunner }, { FooterDataProvider }, { runRpcMode }, outputGuard, { InteractiveMode }] = await Promise.all([
  runtimeModule("core/extensions/runner.js"),
  runtimeModule("core/footer-data-provider.js"),
  runtimeModule("modes/rpc/rpc-mode.js"),
  runtimeModule("core/output-guard.js"),
  runtimeModule("modes/interactive/interactive-mode.js"),
]);

function drift(fact: string): string {
  return `Pi runtime drift: ${fact}. Review the installed runtime change, then update the conformance fake.`;
}

test("pins the installed runtime version and extension context modes", () => {
  assert.equal(
    runtimePackage.version,
    "0.85.1",
    drift('the installed @earendil-works/pi-coding-agent version must remain "0.85.1"'),
  );

  const runner = new ExtensionRunner([], {}, "/tmp", {}, {});
  const printContext = runner.createContext();
  assert.equal(printContext.mode, "print", drift('a new runner context must default to mode "print"'));
  assert.equal(printContext.hasUI, false, drift("the print no-op UI context must report hasUI=false"));

});

test("preserves footer status values and clears only on undefined", () => {
  const footer = new FooterDataProvider("/tmp");
  try {
    footer.setExtensionStatus("status", "");
    assert.equal(
      footer.getExtensionStatuses().get("status"),
      "",
      drift("an empty extension status string must remain stored rather than clear the status"),
    );

    footer.setExtensionStatus("status", undefined);
    assert.equal(
      footer.getExtensionStatuses().has("status"),
      false,
      drift("an undefined extension status must clear only the keyed status"),
    );
  } finally {
    footer.dispose();
  }
});

interface RpcUiRequest {
  method: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
}

async function captureRpcUiContext(): Promise<{
  binding: { uiContext: ExtensionUIContext; mode: string };
  requests: RpcUiRequest[];
  factoryInvocations: number;
}> {
  const stop = new Error("stop after capturing RPC extension context");
  let binding: { uiContext: ExtensionUIContext; mode: string } | undefined;
  let factoryInvocations = 0;
  const session = {
    bindExtensions: async (options: { uiContext: ExtensionUIContext; mode: string }) => {
      binding = options;
      throw stop;
    },
  };
  const runtimeHost = {
    session,
    setRebindSession: (_callback: () => Promise<void>) => {},
  };
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  const captureWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = captureWrite;
  try {
    await assert.rejects(
      runRpcMode(runtimeHost),
      (error: unknown) => error === stop,
      drift("the RPC runtime must expose its extension context during direct in-process setup"),
    );
    assert.ok(binding, drift("RPC setup must bind an extension UI context before entering its command loop"));
    const rpcUi = binding.uiContext;
    rpcUi.setStatus("status", "");
    rpcUi.setStatus("status", undefined);
    rpcUi.setWidget("widget", []);
    rpcUi.setWidget("widget", undefined);
    rpcUi.setWidget(
      "factory",
      (() => {
        factoryInvocations += 1;
        return { render: () => [], invalidate: () => {} };
      }) as never,
    );
    await outputGuard.flushRawStdout();
  } finally {
    outputGuard.restoreStdout();
    process.stdout.write = originalWrite;
  }
  const requests = writes.filter((write) => write.length > 0).map((write) => JSON.parse(write) as RpcUiRequest);
  return { binding: binding!, requests, factoryInvocations };
}

test("emits RPC status and supported widget updates while ignoring factories", async () => {
  const { binding, requests, factoryInvocations } = await captureRpcUiContext();
  assert.equal(binding.mode, "rpc", drift('RPC extension binding must use mode "rpc"'));
  const runner = new ExtensionRunner([], {}, "/tmp", {}, {});
  runner.setUIContext(binding.uiContext, binding.mode);
  const context = runner.createContext();
  assert.equal(context.mode, "rpc", drift('an RPC extension context must use mode "rpc"'));
  assert.equal(context.hasUI, true, drift("a non-no-op RPC UI context must report hasUI=true"));

  const statusRequests = requests.filter((request) => request.method === "setStatus");
  assert.deepEqual(
    statusRequests.map((request) => request.statusText),
    ["", undefined],
    drift("RPC status updates must emit both empty text and undefined clearing requests"),
  );

  const widgetRequests = requests.filter((request) => request.method === "setWidget");
  assert.equal(
    widgetRequests.length,
    2,
    drift("RPC must emit widget events for an array and an undefined clearing request, but not a factory"),
  );
  assert.deepEqual(
    widgetRequests.map((request) => request.widgetLines),
    [[], undefined],
    drift("RPC widget events must preserve an empty array and an undefined clearing request"),
  );
  assert.equal(
    factoryInvocations,
    0,
    drift("RPC component factories must not invoke their callback"),
  );
  assert.equal(
    widgetRequests.some((request) => request.widgetKey === "factory"),
    false,
    drift("RPC component factories must emit no widget event"),
  );
});

interface InteractiveHarness {
  mode: InstanceType<typeof InteractiveMode>;
  ui: ExtensionUIContext;
  tui: TUI;
  terminal: { columns: number; rows: number };
  footer: InstanceType<typeof FooterDataProvider>;
}

function interactiveHarness(): InteractiveHarness {
  const terminal = {
    columns: 24,
    rows: 8,
    write: (_text: string) => {},
    hideCursor: () => {},
    showCursor: () => {},
    start: (_onInput: (data: string) => void, _onResize: () => void) => {},
    stop: () => {},
  };
  const tui = new TuiMainScreen(terminal as never, false);
  tui.requestRender = () => {};
  const footer = new FooterDataProvider("/tmp");
  const mode = Object.create(InteractiveMode.prototype) as InstanceType<typeof InteractiveMode>;
  mode.ui = tui;
  mode.footerDataProvider = footer;
  mode.extensionWidgetsAbove = new Map();
  mode.extensionWidgetsBelow = new Map();
  mode.widgetContainerAbove = new Container();
  mode.widgetContainerBelow = new Container();
  tui.addChild(mode.widgetContainerAbove);
  return { mode, ui: mode.createExtensionUIContext(), tui, terminal, footer };
}

async function bindInteractiveContext(mode: InstanceType<typeof InteractiveMode>): Promise<{ uiContext: ExtensionUIContext; mode: string }> {
  let binding: { uiContext: ExtensionUIContext; mode: string } | undefined;
  mode.runtimeHost = {
    session: {
      bindExtensions: async (options: { uiContext: ExtensionUIContext; mode: string }) => {
        binding = options;
      },
      resourceLoader: { getThemes: () => ({ themes: [] }) },
      extensionRunner: {},
    },
  };
  mode.setupAutocompleteProvider = () => {};
  mode.setupExtensionShortcuts = () => {};
  mode.showLoadedResources = () => {};
  mode.showStartupNoticesIfNeeded = () => {};
  await mode.bindCurrentSessionExtensions();
  assert.ok(binding, drift("interactive setup must bind an extension UI context before returning"));
  return binding!;
}

test("retains interactive empty widgets, clears them with undefined, and passes factory arguments", async () => {
  const { mode, tui, footer } = interactiveHarness();
  const binding = await bindInteractiveContext(mode);
  const ui = binding.uiContext;
  try {
    assert.equal(binding.mode, "tui", drift('interactive extension binding must use mode "tui"'));
    const runner = new ExtensionRunner([], {}, "/tmp", {}, {});
    runner.setUIContext(ui, binding.mode);
    const context = runner.createContext();
    assert.equal(context.mode, "tui", drift('an interactive extension context must use mode "tui"'));
    assert.equal(context.hasUI, true, drift("a non-no-op interactive UI context must report hasUI=true"));
    ui.setStatus("status", "");
    assert.equal(
      footer.getExtensionStatuses().get("status"),
      "",
      drift("interactive status updates must retain an empty string"),
    );
    ui.setStatus("status", undefined);
    assert.equal(
      footer.getExtensionStatuses().has("status"),
      false,
      drift("interactive undefined status updates must clear the keyed status"),
    );

    ui.setWidget("array", []);
    assert.equal(
      mode.extensionWidgetsAbove.has("array"),
      true,
      drift("interactive widget updates must retain an empty array as a widget value"),
    );
    ui.setWidget("array", undefined);
    assert.equal(
      mode.extensionWidgetsAbove.has("array"),
      false,
      drift("interactive undefined widget updates must clear the keyed widget"),
    );

    let factoryTui: TUI | undefined;
    let factoryTheme: unknown;
    const component: Component = { render: () => ["factory"], invalidate: () => {} };
    ui.setWidget("factory", (receivedTui, receivedTheme) => {
      factoryTui = receivedTui;
      factoryTheme = receivedTheme;
      return component;
    });
    assert.equal(factoryTui, tui, drift("interactive widget factories must receive the active tui as their first argument"));
    assert.equal(factoryTheme, ui.theme, drift("interactive widget factories must receive the active theme as their second argument"));
  } finally {
    footer.dispose();
  }
});

test("passes the current terminal width to each interactive component render", async () => {
  const { mode, tui, terminal, footer } = interactiveHarness();
  const binding = await bindInteractiveContext(mode);
  const ui = binding.uiContext;
  try {
    const renderWidths: number[] = [];
    ui.setWidget("factory", () => ({
      render: (width: number) => {
        renderWidths.push(width);
        return ["width-aware"];
      },
      invalidate: () => {},
    }));

    const doRender = (tui as unknown as { doRender: () => void }).doRender.bind(tui);
    doRender();
    assert.deepEqual(renderWidths, [24], drift("the first interactive render must pass the terminal's current width to component.render(width)"));

    terminal.columns = 37;
    doRender();
    assert.deepEqual(renderWidths, [24, 37], drift("each later interactive render must pass the updated terminal width to component.render(width)"));
  } finally {
    footer.dispose();
  }
});
