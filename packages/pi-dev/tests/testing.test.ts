import assert from "node:assert/strict";
import test from "node:test";
import { conformanceContext, getStatus } from "../src/testing.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function component(): { render(width: number): string[]; invalidate(): void } {
  return { render: (width) => [`width=${width}`], invalidate: () => {} };
}

test("provides the complete no-op UI contract", async () => {
  const harness = conformanceContext();
  const ui = harness.context.ui;
  assert.equal(await ui.select("title", ["choice"]), undefined);
  assert.equal(await ui.confirm("title", "message"), false);
  assert.equal(await ui.input("title"), undefined);
  ui.notify("message");
  const unsubscribe = ui.onTerminalInput(() => undefined);
  unsubscribe();
  ui.setStatus("status", "ignored");
  ui.setWorkingMessage("working");
  ui.setWorkingVisible(true);
  ui.setWorkingIndicator({ frames: ["-"] });
  ui.setHiddenThinkingLabel("thinking");
  ui.setWidget("widget", ["line"]);
  ui.setFooter(undefined);
  ui.setHeader(undefined);
  ui.setTitle("title");
  await assert.rejects(ui.custom(() => component()));
  ui.pasteToEditor("text");
  ui.setEditorText("text");
  assert.equal(ui.getEditorText(), "");
  assert.equal(await ui.editor("editor"), undefined);
  ui.addAutocompleteProvider((current) => current);
  ui.setEditorComponent(undefined);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.theme, harness.theme);
  assert.deepEqual(ui.getAllThemes(), []);
  assert.equal(ui.getTheme("missing"), undefined);
  assert.deepEqual(ui.setTheme("missing"), { success: false });
  assert.equal(ui.getToolsExpanded(), false);
  ui.setToolsExpanded(true);
  assert.equal(harness.getStatus("status"), undefined);
});

test("models print, rpc, tui, and UI identity independently", () => {
  const print = conformanceContext();
  assert.equal(print.context.mode, "print");
  assert.equal(print.context.hasUI, false);
  assert.equal(print.context.ui, print.noopUI);

  const rpc = conformanceContext({ mode: "rpc" });
  assert.equal(rpc.context.mode, "rpc");
  assert.equal(rpc.context.hasUI, true);
  rpc.setUIContext(null);
  assert.equal(rpc.context.mode, "rpc");
  assert.equal(rpc.context.hasUI, false);
  rpc.setUIContext(undefined, "tui");
  assert.equal(rpc.context.mode, "tui");
  assert.equal(rpc.context.ui, rpc.noopUI);

  const supplied = { ...rpc.noopUI, notify: () => {} };
  rpc.setUIContext(supplied, "rpc");
  assert.equal(rpc.context.ui, supplied);
  assert.equal(rpc.context.hasUI, true);
});

test("retains keyed status and widget values until undefined", () => {
  const harness = conformanceContext({ mode: "tui" });
  harness.context.ui.setStatus("status", "");
  harness.context.ui.setWidget("widget", []);
  assert.equal(getStatus(harness, "status"), "");
  assert.deepEqual(harness.getWidget("widget"), []);
  harness.context.ui.setStatus("status", "changed");
  harness.context.ui.setWidget("widget", [""]);
  assert.equal(getStatus(harness, "status"), "changed");
  assert.deepEqual(harness.getWidget("widget"), [""]);
  harness.context.ui.setStatus("status", undefined);
  harness.context.ui.setWidget("widget", undefined);
  assert.equal(getStatus(harness, "status"), undefined);
  assert.equal(harness.getWidget("widget"), undefined);
});

test("records RPC state, preserves arrays, and silently ignores factories", () => {
  const harness = conformanceContext({ mode: "rpc" });
  harness.context.ui.setStatus("status", "");
  harness.context.ui.setWidget("widget", [""]);
  harness.context.ui.setStatus("status", undefined);
  harness.context.ui.setWidget("widget", undefined);
  assert.deepEqual(harness.rpcStatus, [
    { key: "status", value: "" },
    { key: "status", value: undefined },
  ]);
  assert.deepEqual(harness.rpcWidgets, [
    { key: "widget", content: [""] },
    { key: "widget", content: undefined },
  ]);

  const sentinel = "rpc-hostile-sentinel-4e7c";
  let invoked = false;
  const factory = Object.assign(() => { invoked = true; return component(); }, { sentinel });
  const before = {
    snapshot: harness.snapshot(),
    widget: harness.getWidget("hostile"),
    rpcWidgets: [...harness.rpcWidgets],
    renderObservations: [...harness.renderObservations],
    renderOutput: harness.render([10, 80]),
  };
  assert.doesNotThrow(() => harness.context.ui.setWidget("hostile", factory));
  assert.equal(invoked, false);
  assert.equal(harness.getWidget("hostile"), before.widget);
  assert.deepEqual(harness.rpcWidgets, before.rpcWidgets);
  assert.deepEqual(harness.renderObservations, before.renderObservations);
  assert.deepEqual(harness.render([10, 80]), before.renderOutput);
  assert.deepEqual(harness.snapshot(), before.snapshot);
  assert.equal(JSON.stringify(harness.snapshot()), JSON.stringify(before.snapshot));
  assert.equal(harness.rpcWidgets.some((entry) => JSON.stringify(entry).includes(sentinel)), false);
  assert.equal(JSON.stringify(harness.snapshot()).includes(sentinel), false);
});

test("silently ignores factories on component UI retained after switching to RPC", () => {
  const harness = conformanceContext({ mode: "tui" });
  harness.setUIContext(harness.context.ui, "rpc");
  const sentinel = "rpc-rebound-hostile-sentinel-9b2f";
  let invoked = false;
  const factory = Object.assign(() => { invoked = true; return component(); }, { sentinel });
  const before = {
    snapshot: harness.snapshot(),
    widget: harness.getWidget("hostile"),
    rpcWidgets: [...harness.rpcWidgets],
    renderObservations: [...harness.renderObservations],
    renderOutput: harness.render([10, 80]),
  };
  assert.doesNotThrow(() => harness.context.ui.setWidget("hostile", factory));
  assert.equal(invoked, false);
  assert.equal(harness.getWidget("hostile"), before.widget);
  assert.deepEqual(harness.rpcWidgets, before.rpcWidgets);
  assert.deepEqual(harness.renderObservations, before.renderObservations);
  assert.deepEqual(harness.render([10, 80]), before.renderOutput);
  assert.deepEqual(harness.snapshot(), before.snapshot);
  assert.equal(JSON.stringify(harness.snapshot()), JSON.stringify(before.snapshot));
  assert.equal(harness.rpcWidgets.some((entry) => JSON.stringify(entry).includes(sentinel)), false);
  assert.equal(JSON.stringify(harness.snapshot()).includes(sentinel), false);
});

test("invokes TUI factories with stable arguments and renders every component at each width", () => {
  const harness = conformanceContext({ mode: "tui" });
  const seen: unknown[] = [];
  const factory = (tui: unknown, theme: unknown) => {
    seen.push(tui, theme);
    return component();
  };
  const first = [10, 80];
  harness.context.ui.setWidget("factory", factory);
  harness.context.ui.setWidget("array", ["line"]);
  assert.equal(seen[0], harness.tui);
  assert.equal(seen[1], harness.theme);
  const stored = harness.getWidget("factory");
  assert.ok(stored !== undefined && !Array.isArray(stored));
  assert.equal(stored.render(3)[0], "width=3");
  const observations = harness.render(first);
  assert.deepEqual(observations, [
    { key: "factory", width: 10, output: ["width=10"] },
    { key: "factory", width: 80, output: ["width=80"] },
  ]);
  assert.deepEqual(harness.renderObservations, observations);
  assert.notEqual(harness.render([80]), observations);
});

test("fires ordered handlers with the rebound context and exposes provider leaks", async () => {
  const harness = conformanceContext({ mode: "print", cwd: "/one" });
  const calls: string[] = [];
  let firstContext: ExtensionContext | undefined;
  harness.pi.on("session_start", (_event, ctx) => { firstContext = ctx; calls.push(`first:${ctx.cwd}`); });
  harness.pi.on("session_start", async (_event, ctx) => { await Promise.resolve(); calls.push(`second:${ctx.cwd}`); });
  harness.pi.on("session_shutdown", (_event, ctx) => { calls.push(`shutdown:${ctx.cwd}`); });
  const leaked = () => {};
  harness.pi.events.on("provider", leaked);
  const disposed = harness.pi.events.on("provider", () => {});
  disposed();
  harness.pi.events.on("provider", () => {});
  assert.equal(harness.getEventBusProviders("provider").filter((provider) => provider.active).length, 2);

  await harness.fire("session_start");
  assert.deepEqual(calls, ["first:/one", "second:/one"]);
  const rebound = harness.rebind({ cwd: "/two" });
  assert.equal(harness.context, rebound);
  assert.equal(firstContext, rebound);
  await harness.fire("session_shutdown");
  assert.deepEqual(calls, ["first:/one", "second:/one", "shutdown:/two"]);
  assert.equal(harness.getRegisteredHandlers("session_start").length, 2);
  assert.equal(harness.getEventBusProviders("provider").length, 3);
  assert.equal(harness.getEventBusProviders("provider").filter((provider) => provider.active).length, 2);
});